/* ==========================================================================
   WILDCARD — POST /api/stripe-webhook
   Cloudflare Pages Function.

   Listens for Stripe webhook events. On `checkout.session.completed`, looks
   up the full session (with line items) from Stripe and saves a structured
   order record to KV so it can be used for inventory management, fulfillment,
   etc. down the line.

   SECURITY
   --------
   - Every request is verified against STRIPE_WEBHOOK_SIGNING_SECRET using
     Stripe's documented signature scheme (HMAC-SHA256 over
     "<timestamp>.<raw body>"), implemented here with Web Crypto since this
     project doesn't use the `stripe` npm package. Requests that fail
     verification are rejected with 400 and never touch storage.
   - The raw request body is read as text *before* any JSON parsing — Stripe
     signs the exact bytes it sent, so parsing first (which can normalize
     whitespace) would break verification.
   - Line items, prices, and product metadata are re-fetched from Stripe by
     session id rather than trusted from the webhook payload's `object`
     alone, since `checkout.session.completed` doesn't include line items
     unless you expand for them.
   - Writes are idempotent: Stripe can and will redeliver the same event, so
     each order is stored under a key derived from the immutable Stripe
     session id. A redelivery overwrites the same record rather than
     duplicating it.
   - Only POST is accepted. Any other method gets an explicit 405.
   - Stripe's raw error responses and the signing secret itself are never
     echoed back in any response.

   SETUP
   -----
   1. Create a KV namespace and bind it as `ORDERS` (see wrangler.toml).
   2. In the Stripe Dashboard, add an endpoint pointing at
      https://<your-domain>/api/stripe-webhook, subscribed to at least
      `checkout.session.completed`.
   3. Copy the endpoint's signing secret (starts with `whsec_`) into the
      `STRIPE_WEBHOOK_SIGNING_SECRET` environment variable / secret (same
      way STRIPE_SECRET_KEY is configured — see functions/README.md).
   ========================================================================== */

import { decrementStock } from '../_inventory.js';

const KV_KEY_PREFIX = 'order:';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    return jsonError('Webhook is not configured yet.', 500);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return jsonError('Webhook is not configured yet.', 500);
  }
  if (!env.ORDERS) {
    return jsonError('Order storage is not configured yet.', 500);
  }

  const signatureHeader = request.headers.get('Stripe-Signature');
  if (!signatureHeader) {
    return jsonError('Missing signature.', 400);
  }

  // Must read as raw text BEFORE parsing — signature covers the exact bytes.
  const rawBody = await request.text();

  const verified = await verifyStripeSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SIGNING_SECRET
  );
  if (!verified) {
    return jsonError('Invalid signature.', 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return jsonError('Invalid JSON body.', 400);
  }

  if (event && event.type === 'checkout.session.completed') {
    try {
      await handleCheckoutCompleted(event, env);
    } catch (e) {
      console.error('Failed to process checkout.session.completed:', e);
      // 500 tells Stripe to retry the delivery rather than silently
      // dropping an order.
      return jsonError('Failed to process event.', 500);
    }
  }
  // Other event types are acknowledged but otherwise ignored — the endpoint
  // is only subscribed to what it needs, but Stripe will retry anything
  // that doesn't get a 2xx, so unhandled types still need a clean 200.

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet() {
  return jsonError('Method not allowed. Use POST.', 405);
}
export async function onRequestPut() {
  return jsonError('Method not allowed. Use POST.', 405);
}
export async function onRequestDelete() {
  return jsonError('Method not allowed. Use POST.', 405);
}

/* ---------------- event handling ---------------- */

async function handleCheckoutCompleted(event, env) {
  const session = event.data && event.data.object;
  if (!session || !session.id) return;

  // Only orders that actually collected payment become inventory-relevant.
  if (session.payment_status !== 'paid') return;

  const kvKey = KV_KEY_PREFIX + session.id;

  // Idempotency: a redelivered event just overwrites the same key, but skip
  // the extra Stripe API round-trip if we've already recorded this order.
  const existing = await env.ORDERS.get(kvKey);
  if (existing) return;

  const full = await fetchCheckoutSession(session.id, env.STRIPE_SECRET_KEY);
  const order = buildOrderRecord(full);

  await env.ORDERS.put(kvKey, JSON.stringify(order));

  // Best-effort: a paid order is the thing that matters most and is
  // already safely recorded above, so a failure decrementing stock is
  // logged rather than thrown. Throwing here would make this handler
  // return 500, Stripe would retry the whole delivery, and the retry
  // would short-circuit at the `existing` check above (the order is
  // already saved) — meaning the retry would never come back to decrement
  // stock either. Best-effort logging is the more honest tradeoff than a
  // retry that can't actually fix the problem.
  try {
    await decrementInventoryForOrder(order, env);
  } catch (e) {
    console.error('Failed to decrement inventory for order ' + order.orderId + ':', e);
  }
}

// Reduces stock for each item on a just-recorded order. Order items store
// `productId` (the cart line id, e.g. "RED-M") and `size` (e.g. "M")
// separately — derive the color label by stripping the "-<size>" suffix
// when present, so this keeps working if productId is ever simplified to
// just the label to match the shape documented in functions/README.md.
async function decrementInventoryForOrder(order, env) {
  if (!env.INVENTORY) return; // no durable inventory store configured yet
  if (!order || !Array.isArray(order.items)) return;

  for (const item of order.items) {
    if (!item.productId || !item.size || !item.quantity) continue;
    var label = item.productId.endsWith('-' + item.size)
      ? item.productId.slice(0, -(item.size.length + 1))
      : item.productId;
    await decrementStock(env, label, item.size, item.quantity);
  }
}

// Re-fetches the session from Stripe with line items + product data
// expanded, rather than trusting whatever shape the webhook payload had.
async function fetchCheckoutSession(sessionId, secretKey) {
  var url =
    'https://api.stripe.com/v1/checkout/sessions/' +
    sessionId +
    '?expand[]=line_items&expand[]=line_items.data.price.product';

  var res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + secretKey }
  });

  var data = await res.json();
  if (!res.ok) {
    console.error('Stripe error fetching session:', data);
    throw new Error('Could not fetch checkout session from Stripe.');
  }
  return data;
}

// Shapes a Stripe checkout session into a flat, storage/inventory-friendly
// order record. Field names are stable and deliberately independent of
// Stripe's own object shape so downstream inventory code isn't coupled to
// the Stripe API.
function buildOrderRecord(session) {
  var lineItemsData =
    (session.line_items && session.line_items.data) || [];

  var items = lineItemsData.map(function (li) {
    var product = li.price && li.price.product;
    var metadata = (product && product.metadata) || {};
    return {
      productId: metadata.id || null,
      size: metadata.size || null,
      color: metadata.color || null,
      name: (product && product.name) || li.description || null,
      quantity: li.quantity,
      unitAmount: li.price ? li.price.unit_amount : null,
      amountSubtotal: li.amount_subtotal,
      amountTotal: li.amount_total,
      currency: li.currency
    };
  });

  return {
    orderId: session.id,
    status: 'paid',
    createdAt: new Date(session.created * 1000).toISOString(),
    recordedAt: new Date().toISOString(),
    currency: session.currency,
    amountSubtotal: session.amount_subtotal,
    amountTotal: session.amount_total,
    customer: {
      email: session.customer_details ? session.customer_details.email : null,
      name: session.customer_details ? session.customer_details.name : null,
      phone: session.customer_details ? session.customer_details.phone : null
    },
    shippingAddress:
      (session.shipping_details && session.shipping_details.address) ||
      (session.customer_details && session.customer_details.address) ||
      null,
    shippingCost:
      (session.total_details && typeof session.total_details.amount_shipping === 'number')
        ? session.total_details.amount_shipping
        : null,
    items: items,
    fulfillment: {
      // Downstream inventory/fulfillment tooling can flip this once an
      // order has been picked, packed, and shipped.
      fulfilled: false,
      fulfilledAt: null
    }
  };
}

/* ---------------- signature verification ---------------- */

// Implements Stripe's webhook signature scheme without the `stripe` SDK:
// https://docs.stripe.com/webhooks#verify-manually
// Header looks like: "t=1614556800,v1=<hex hmac>,v1=<hex hmac>..."
// (Stripe includes multiple v1 signatures during secret rotation — any
// match is considered valid.)
async function verifyStripeSignature(rawBody, header, secret) {
  var parts = header.split(',').reduce(function (acc, part) {
    var kv = part.split('=');
    var key = kv[0];
    var value = kv.slice(1).join('=');
    if (key === 't') acc.timestamp = value;
    if (key === 'v1') acc.signatures.push(value);
    return acc;
  }, { timestamp: null, signatures: [] });

  if (!parts.timestamp || parts.signatures.length === 0) return false;

  // Reject events older than 5 minutes to guard against replay attacks.
  var ageSeconds = Math.abs(Date.now() / 1000 - Number(parts.timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  var signedPayload = parts.timestamp + '.' + rawBody;
  var expected = await hmacSha256Hex(secret, signedPayload);

  return parts.signatures.some(function (sig) {
    return timingSafeEqual(sig, expected);
  });
}

async function hmacSha256Hex(secret, payload) {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  var sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  var bytes = new Uint8Array(sigBuf);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var mismatch = 0;
  for (var i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/* ---------------- helpers ---------------- */

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
