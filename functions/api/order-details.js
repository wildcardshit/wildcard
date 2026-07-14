/* ==========================================================================
   WILDCARD — GET /api/order-details?session_id=...
   Cloudflare Pages Function.

   Powers the order confirmation page (checkout-success.html). Given the
   Stripe Checkout Session id from the success redirect, fetches the session
   directly from Stripe (with line items + product metadata expanded) and
   returns a small, display-ready JSON shape: order number, line items
   (name/size/color/qty/price/image), shipping address, and totals.

   Why fetch from Stripe directly instead of reading the order the webhook
   already saved to KV: the webhook delivery is asynchronous and can lag a
   few seconds behind the browser redirect, so the KV record may not exist
   yet the instant the shopper lands on this page. Querying Stripe directly
   is immediate and authoritative. (functions/api/stripe-webhook.js is still
   what persists the order for inventory purposes.)

   SECURITY
   --------
   - Only returns data for sessions with payment_status "paid" — an unpaid
     or abandoned session id doesn't leak order contents.
   - STRIPE_SECRET_KEY never leaves the server; only the derived JSON is
     returned to the client.
   - session_id is passed straight through to Stripe's API as a path
     segment — Stripe validates the id itself, and a malformed value just
     produces a 404 from Stripe, which this function turns into a generic
     404 response.
   - Only GET is accepted.
   ========================================================================== */

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) {
    return jsonError('Checkout is not configured yet.', 500);
  }

  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (!sessionId || typeof sessionId !== 'string') {
    return jsonError('Missing session_id.', 400);
  }
  // Stripe checkout session ids always start with "cs_" — reject anything
  // else before it ever reaches the Stripe API.
  if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) {
    return jsonError('Invalid session_id.', 400);
  }

  var url =
    'https://api.stripe.com/v1/checkout/sessions/' +
    encodeURIComponent(sessionId) +
    '?expand[]=line_items&expand[]=line_items.data.price.product';

  var stripeRes;
  try {
    stripeRes = await fetch(url, {
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY }
    });
  } catch (e) {
    return jsonError('Could not reach Stripe.', 502);
  }

  var session = await stripeRes.json();

  if (!stripeRes.ok) {
    if (stripeRes.status === 404) {
      return jsonError('Order not found.', 404);
    }
    console.error('Stripe error fetching session:', session);
    return jsonError('Could not load order.', 502);
  }

  if (session.payment_status !== 'paid') {
    return jsonError('Order not found.', 404);
  }

  return new Response(JSON.stringify(buildOrderResponse(session)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost() {
  return jsonError('Method not allowed. Use GET.', 405);
}

function buildOrderResponse(session) {
  var lineItemsData = (session.line_items && session.line_items.data) || [];

  var items = lineItemsData.map(function (li) {
    var product = li.price && li.price.product;
    var metadata = (product && product.metadata) || {};
    return {
      name: (product && product.name) || li.description || 'Item',
      size: metadata.size || null,
      color: metadata.color || null,
      quantity: li.quantity,
      unitAmount: li.price ? li.price.unit_amount : null,
      amountTotal: li.amount_total,
      currency: li.currency,
      image: (product && product.images && product.images[0]) || null
    };
  });

  var shippingAddress =
    (session.shipping_details && session.shipping_details.address) ||
    (session.customer_details && session.customer_details.address) ||
    null;
  var shippingName =
    (session.shipping_details && session.shipping_details.name) ||
    (session.customer_details && session.customer_details.name) ||
    null;
  var shippingCost =
    (session.total_details && typeof session.total_details.amount_shipping === 'number')
      ? session.total_details.amount_shipping
      : null;

  return {
    orderNumber: formatOrderNumber(session.id),
    sessionId: session.id,
    currency: session.currency,
    amountSubtotal: session.amount_subtotal,
    amountShipping: shippingCost,
    amountTotal: session.amount_total,
    customerEmail: session.customer_details
      ? session.customer_details.email
      : null,
    shipping: { name: shippingName, address: shippingAddress, phone: session.customer_details ? session.customer_details.phone : null },
    items: items
  };
}

// Stripe session ids (cs_live_..., cs_test_...) aren't meant for customers
// to read aloud. Derive a short, friendly order number from the tail of
// the id instead — still unique enough for a shopper to reference in a
// support email, without dumping the full opaque id in their face.
function formatOrderNumber(sessionId) {
  var tail = sessionId.replace(/^cs_(live|test)_/, '');
  var short = tail.slice(-8).toUpperCase();
  return 'WC-' + short;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
