/**
 * POST /api/create-checkout-session
 *
 * Cloudflare Pages Function. Accepts the cart from the frontend, re-prices
 * every line item against the shared product catalog (the client's price
 * is never trusted), creates a Stripe Checkout Session, and returns only
 * the Session URL as JSON.
 *
 * Scope, on purpose:
 *   - No redirect happens here — the frontend is responsible for sending
 *     the customer to the returned URL.
 *   - No webhooks, no order persistence, no admin UI.
 *   - No existing frontend files are touched by this function.
 *
 * Required Cloudflare Pages environment variable:
 *   STRIPE_SECRET_KEY  — your Stripe secret key (sk_live_... / sk_test_...)
 */

import { PRODUCTS, isSizeInStock, isLaunched, toPriceCents } from '../../js/products.js';

// ---------- Server-side catalog (built from the shared PRODUCTS array) ----------
// This is the ONLY place price/product info comes from — it's the exact
// same data the frontend renders, imported directly rather than copied, so
// this catalog can never drift out of sync with what the customer sees.
// Hidden products and products whose drop hasn't launched yet are
// intentionally left out here: neither can be bought, no matter what a
// request from the browser claims.
const CATALOG = PRODUCTS.filter((p) => !p.hidden && isLaunched(p)).reduce((map, p) => {
  map[p.id] = {
    label: p.label,
    motto: p.motto,
    priceCents: toPriceCents(p),
    img: p.img,
    product: p, // kept for per-size stock checks in validateCart()
  };
  return map;
}, {});

const VALID_SIZES = new Set(['S', 'M', 'L', 'XL']);
const MAX_QTY_PER_LINE = 20;
const MAX_LINE_ITEMS = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Validates the raw cart payload against the server catalog and returns a
 * clean list of { id, size, qty, catalogEntry } lines, using only
 * server-known prices and names. Throws with a user-safe message on any
 * invalid input.
 */
function validateCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty.');
  }
  if (items.length > MAX_LINE_ITEMS) {
    throw new Error('Too many line items in cart.');
  }

  return items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid item at position ${i}.`);
    }

    const id = String(raw.id || '').toLowerCase().trim();
    const catalogEntry = CATALOG[id];
    if (!catalogEntry) {
      throw new Error(`Unknown product "${raw.id}".`);
    }

    const size = raw.size != null ? String(raw.size).toUpperCase().trim() : null;
    if (!size || !VALID_SIZES.has(size)) {
      throw new Error(`Invalid size for "${id}".`);
    }
    if (!isSizeInStock(catalogEntry.product, size)) {
      throw new Error(`"${id}" is out of stock in size ${size}.`);
    }

    const qty = Number.parseInt(raw.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new Error(`Invalid quantity for "${id}".`);
    }

    return { id, size, qty, catalogEntry };
  });
}

/**
 * Builds the x-www-form-urlencoded body Stripe's REST API expects for
 * checkout session creation, using bracket notation for nested/array
 * fields (line_items[0][price_data][...], etc).
 */
function buildStripeBody(lines, origin) {
  const params = new URLSearchParams();

  params.set('mode', 'payment');
  params.set('success_url', `${origin}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/checkout-cancel.html`);

  lines.forEach((line, i) => {
    const prefix = `line_items[${i}]`;
    params.set(`${prefix}[quantity]`, String(line.qty));
    params.set(`${prefix}[price_data][currency]`, 'usd');
    params.set(`${prefix}[price_data][unit_amount]`, String(line.catalogEntry.priceCents));
    params.set(
      `${prefix}[price_data][product_data][name]`,
      `${line.catalogEntry.motto} — ${line.catalogEntry.label} / ${line.size}`
    );
    params.set(`${prefix}[price_data][product_data][images][0]`, `${origin}/${line.catalogEntry.img}`);
  });

  return params;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // TEMP DEBUG: catch-all so unexpected exceptions also return diagnostic
  // info in development instead of just failing silently / generically.
  // Remove this outer try/catch (restore the un-wrapped body below) once
  // the issue is diagnosed.
  try {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'Server is not configured for checkout yet.' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400);
    }

    let lines;
    try {
      lines = validateCart(body && body.items);
    } catch (err) {
      return json({ error: err.message }, 400);
    }

    const origin = new URL(request.url).origin;
    const stripeBody = buildStripeBody(lines, origin);

    let stripeResponse;
    try {
      stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: stripeBody
      });
    } catch {
      return json({ error: 'Could not reach Stripe. Please try again.' }, 502);
    }

    const stripeData = await stripeResponse.json();

    if (!stripeResponse.ok) {
      // TEMP DEBUG: surfacing raw Stripe error internals to the client.
      // Remove this block (and revert to the generic message) once the
      // issue is diagnosed.
      const stripeErr = stripeData && stripeData.error ? stripeData.error : {};
      return json({
        error: 'Stripe could not create the checkout session.',
        debug: {
          message: stripeErr.message || null,
          type: stripeErr.type || null,
          code: stripeErr.code || null,
          param: stripeErr.param || null,
          requestId: stripeResponse.headers.get('request-id') || null
        }
      }, 502);
    }

    return json({ url: stripeData.url });
  } catch (err) {
    // TEMP DEBUG: unexpected exception, not a Stripe API error.
    return json({
      error: 'Unexpected server error.',
      debug: {
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null
      }
    }, 500);
  }
}

// Any method other than POST is not supported by this endpoint.
export async function onRequestGet() {
  return json({ error: 'Method not allowed.' }, 405);
}
