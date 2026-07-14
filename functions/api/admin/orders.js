/* ==========================================================================
   WILDCARD — /api/admin/orders
   Cloudflare Pages Function. Guarded by functions/api/admin/_middleware.js
   — never reachable without a valid admin session.

   GET /api/admin/orders?status=unfulfilled&q=jane&limit=25&offset=0
     Lists paid orders from the ORDERS KV store (the same records
     functions/api/stripe-webhook.js writes), newest first.
       status: "all" (default) | "fulfilled" | "unfulfilled"
       q:      free-text match against order id, customer email, or name
       limit:  page size, default 25, max 100
       offset: for paging through the filtered result set

   PATCH /api/admin/orders
     Body: { "orderId": "cs_test_...", "fulfilled": true,
             "trackingNumber": "1Z999...", "carrier": "UPS" }
     Flips an order's fulfillment.fulfilled flag — this is "mark as
     shipped" (or unmark, if fulfilled is false) — and records who did it
     and when. trackingNumber/carrier are optional and only kept when
     fulfilled is true.
   ========================================================================== */

import { loadAllOrders, getOrder, saveOrder } from '../../_orders.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.ORDERS) return jsonError('Order storage is not configured.', 500);

  const url = new URL(request.url);
  const status = (url.searchParams.get('status') || 'all').toLowerCase();
  const search = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

  const allOrders = await loadAllOrders(env);

  let filtered = allOrders;
  if (status === 'fulfilled') {
    filtered = filtered.filter((o) => o.fulfillment && o.fulfillment.fulfilled);
  } else if (status === 'unfulfilled') {
    filtered = filtered.filter((o) => !o.fulfillment || !o.fulfillment.fulfilled);
  }

  if (search) {
    filtered = filtered.filter((o) => {
      const email = ((o.customer && o.customer.email) || '').toLowerCase();
      const name = ((o.customer && o.customer.name) || '').toLowerCase();
      const id = (o.orderId || '').toLowerCase();
      return id.includes(search) || email.includes(search) || name.includes(search);
    });
  }

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  return new Response(
    JSON.stringify({ orders: page, total: total, limit: limit, offset: offset }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

export async function onRequestPatch(context) {
  const { request, env, data } = context;
  if (!env.ORDERS) return jsonError('Order storage is not configured.', 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid request body.', 400);
  }

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return jsonError('orderId is required.', 400);
  if (typeof body.fulfilled !== 'boolean') return jsonError('fulfilled must be true or false.', 400);

  const order = await getOrder(env, orderId);
  if (!order) return jsonError('Order not found.', 404);

  const trackingNumber =
    typeof body.trackingNumber === 'string' && body.trackingNumber.trim()
      ? body.trackingNumber.trim().slice(0, 100)
      : null;
  const carrier =
    typeof body.carrier === 'string' && body.carrier.trim() ? body.carrier.trim().slice(0, 50) : null;

  order.fulfillment = {
    fulfilled: body.fulfilled,
    fulfilledAt: body.fulfilled ? new Date().toISOString() : null,
    trackingNumber: body.fulfilled ? trackingNumber : null,
    carrier: body.fulfilled ? carrier : null,
    fulfilledBy: body.fulfilled ? (data && data.admin && data.admin.username) || 'admin' : null
  };

  await saveOrder(env, orderId, order);

  return new Response(JSON.stringify({ order: order }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost() {
  return jsonError('Method not allowed. Use GET or PATCH.', 405);
}
export async function onRequestDelete() {
  return jsonError('Method not allowed. Use GET or PATCH.', 405);
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
