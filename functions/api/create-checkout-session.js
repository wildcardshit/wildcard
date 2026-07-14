/* ==========================================================================
   WILDCARD — POST /api/create-checkout-session
   Cloudflare Pages Function.

   Takes { items: [{ id, qty }] } describing what's in the visitor's cart
   and creates a Stripe Checkout Session for it, returning { url } for the
   client to redirect to.

   SECURITY
   --------
   - STRIPE_SECRET_KEY is read from `env`, which Cloudflare populates from
     the Pages project's environment variables / secrets. It is set via the
     Cloudflare dashboard (Settings -> Environment variables -> add
     STRIPE_SECRET_KEY as "Encrypted") or `wrangler pages secret put
     STRIPE_SECRET_KEY`. It is never bundled into any frontend JS, never
     echoed back in a response, and never logged.
   - Price, product name, color, and image are NEVER taken from the request
     body. Only a product id + size (encoded together, e.g. "RED-M") and a
     quantity are accepted, and everything else is re-derived server-side
     from _catalog.js. A tampered client (e.g. someone editing their cart
     in localStorage/devtools to claim a $44 shirt costs $0.01) cannot
     change what Stripe actually charges.
   - Quantity per line and total line-item count are clamped to sane
     bounds to avoid abuse (absurdly large orders, resource exhaustion).
   - Stock is re-checked here against the INVENTORY store (see
     _inventory.js) regardless of what the client's own UI already
     disabled. A shopper who bypasses the disabled "Add to Cart" button by
     scripting a request directly still can't buy more units of a size
     than actually exist.
   - Only POST with a JSON body is accepted; other methods get an explicit
     405 rather than falling through.
   - Stripe's raw error response is never forwarded to the client — only a
     generic message, with details going to the server-side log instead.
   - Shipping address collection and shipping cost are both handled by
     Stripe itself (shipping_address_collection + shipping_options below),
     restricted to the countries in functions/_shipping.js. The client's
     `shippingCountry` only picks which rate set to offer; it never sets a
     price directly, and Stripe re-validates the country the shopper
     actually picks against the same allowed list.
   ========================================================================== */

import { resolveCartItem, CURRENCY } from '../_catalog.js';
import { checkAvailability } from '../_inventory.js';
import { ALLOWED_COUNTRIES, isSupportedCountry, applyShippingOptionsToParams } from '../_shipping.js';

const MAX_QTY_PER_ITEM = 10;   // matches QTY_MAX in product.html
const MAX_LINE_ITEMS = 20;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) {
    // Fails closed: if the secret isn't configured, checkout is refused
    // rather than silently doing something insecure.
    return jsonError('Checkout is not configured yet.', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid JSON body.', 400);
  }

  const rawItems = Array.isArray(body && body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) {
    return jsonError('Cart is empty.', 400);
  }
  if (rawItems.length > MAX_LINE_ITEMS) {
    return jsonError('Too many line items.', 400);
  }

  // Which country to build shipping_options for. This only shapes what
  // Stripe offers to charge for shipping — it is NOT trusted as the actual
  // delivery address; Stripe's own shipping_address_collection (set below)
  // is what collects and validates the real address at checkout, and a
  // shopper can still pick a different allowed country there than the one
  // used to shape this estimate.
  var requestedCountry = typeof body.shippingCountry === 'string' ? body.shippingCountry.toUpperCase() : 'US';
  if (!isSupportedCountry(requestedCountry)) {
    requestedCountry = 'US';
  }

  var lines = [];
  for (var i = 0; i < rawItems.length; i++) {
    var raw = rawItems[i];
    if (!raw || typeof raw.id !== 'string') {
      return jsonError('Invalid cart item.', 400);
    }

    var qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      return jsonError('Invalid quantity for ' + raw.id + '.', 400);
    }

    // Authoritative lookup — ignores any price/name/image the client sent.
    var product = resolveCartItem(raw.id);
    if (!product) {
      return jsonError('Unknown product or size: ' + raw.id, 400);
    }

    lines.push({ product: product, qty: qty });
  }

  // Authoritative stock check — runs even though the client UI already
  // disables out-of-stock sizes, since that UI can't be trusted any more
  // than the price/name/image it might try to send.
  var problems = await checkAvailability(
    env,
    lines.map(function (line) {
      return { id: line.product.id, qty: line.qty };
    })
  );
  if (problems.length > 0) {
    var first = problems[0];
    var message =
      first.available > 0
        ? first.label + ' ' + first.size + ' — only ' + first.available + ' left in stock.'
        : first.label + ' ' + first.size + ' is out of stock.';
    return jsonError(message, 409);
  }

  var origin = new URL(request.url).origin;

  var subtotalCents = lines.reduce(function (sum, line) {
    return sum + line.product.unitAmount * line.qty;
  }, 0);

  var params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', origin + '/checkout-success.html?session_id={CHECKOUT_SESSION_ID}');
  params.set('cancel_url', origin + '/checkout-cancel.html');

  // Collects and validates a real shipping address on Stripe's own hosted
  // page — safer and simpler than building custom address collection on
  // the storefront, since Stripe handles PCI-relevant data, autofill, and
  // per-country formatting/validation itself. Restricted to the same
  // countries WILDCARD actually ships to (see shipping.html).
  ALLOWED_COUNTRIES.forEach(function (code, idx) {
    params.set('shipping_address_collection[allowed_countries][' + idx + ']', code);
  });

  // A phone number gives carriers something to use for delivery issues —
  // optional for the shopper, but worth asking for on real orders.
  params.set('phone_number_collection[enabled]', 'true');

  // Real, chargeable shipping options — shaped from the same rates the
  // cart drawer's estimate (api/shipping-rates.js) already showed the
  // shopper, keyed off the country they selected there. Stripe still lets
  // the shopper pick a different one of these options, or a different
  // allowed country entirely, once they're on the checkout page.
  applyShippingOptionsToParams(params, requestedCountry, subtotalCents);

  lines.forEach(function (line, idx) {
    var p = line.product;
    var prefix = 'line_items[' + idx + ']';
    params.set(prefix + '[quantity]', String(line.qty));
    params.set(prefix + '[price_data][currency]', CURRENCY);
    params.set(prefix + '[price_data][unit_amount]', String(p.unitAmount));
    params.set(prefix + '[price_data][product_data][name]', p.name + ' \u2014 ' + p.size);
    params.set(prefix + '[price_data][product_data][images][0]', origin + '/' + p.image);
    params.set(prefix + '[price_data][product_data][metadata][id]', p.id);
    params.set(prefix + '[price_data][product_data][metadata][size]', p.size);
    params.set(prefix + '[price_data][product_data][metadata][color]', p.color);
  });

  var stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        // Bearer auth with the secret key — this request happens entirely
        // server-side, so the key never reaches the browser.
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  } catch (e) {
    return jsonError('Could not reach Stripe.', 502);
  }

  var data = await stripeRes.json();

  if (!stripeRes.ok) {
    // Log the detailed Stripe error server-side only; the client gets a
    // generic message so internal details never leak.
    console.error('Stripe error creating checkout session:', data);
    return jsonError('Could not start checkout.', 502);
  }

  return new Response(JSON.stringify({ url: data.url }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Explicit rejection for any other method (GET, PUT, DELETE, ...) instead
// of an unhelpful default 404/405 with no body.
export async function onRequestGet() {
  return jsonError('Method not allowed. Use POST.', 405);
}
export async function onRequestPut() {
  return jsonError('Method not allowed. Use POST.', 405);
}
export async function onRequestDelete() {
  return jsonError('Method not allowed. Use POST.', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
