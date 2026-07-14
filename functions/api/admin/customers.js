/* ==========================================================================
   WILDCARD — GET /api/admin/customers
   Cloudflare Pages Function. Guarded by functions/api/admin/_middleware.js
   — never reachable without a valid admin session.

   The storefront has no customer accounts, so there's no separate
   customers database — an order's `customer` + `shippingAddress` fields
   (written by functions/api/stripe-webhook.js) ARE the customer record.
   This endpoint aggregates every paid order in the ORDERS KV store by
   customer email so the dashboard can show one row per customer: contact
   info, most recent shipping address, order count, and lifetime spend.

   GET /api/admin/customers?q=jane
     q: free-text match against email or name
   ========================================================================== */

import { loadAllOrders } from '../../_orders.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.ORDERS) return jsonError('Order storage is not configured.', 500);

  const url = new URL(request.url);
  const search = (url.searchParams.get('q') || '').trim().toLowerCase();

  const orders = await loadAllOrders(env); // already newest-first

  const byEmail = new Map();
  for (const order of orders) {
    const email = (order.customer && order.customer.email) || 'unknown';
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email: email,
        name: (order.customer && order.customer.name) || null,
        phone: (order.customer && order.customer.phone) || null,
        shippingAddress: order.shippingAddress || null,
        orderCount: 0,
        totalSpent: 0,
        currency: order.currency || 'usd',
        firstOrderAt: order.createdAt,
        lastOrderAt: order.createdAt
      });
    }
    const c = byEmail.get(email);
    c.orderCount += 1;
    c.totalSpent += order.amountTotal || 0;
    // orders is newest-first, so the FIRST time we see an email here is
    // already its most recent order — only firstOrderAt needs updating as
    // we walk further back.
    if (new Date(order.createdAt).getTime() < new Date(c.firstOrderAt).getTime()) {
      c.firstOrderAt = order.createdAt;
    }
  }

  let customers = Array.from(byEmail.values()).sort(
    (a, b) => new Date(b.lastOrderAt).getTime() - new Date(a.lastOrderAt).getTime()
  );

  if (search) {
    customers = customers.filter(
      (c) => c.email.toLowerCase().includes(search) || (c.name || '').toLowerCase().includes(search)
    );
  }

  return new Response(JSON.stringify({ customers: customers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost() {
  return jsonError('Method not allowed. Use GET.', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
