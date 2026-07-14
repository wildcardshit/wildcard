/* ==========================================================================
   WILDCARD — /api/admin/inventory
   Cloudflare Pages Function. Guarded by functions/api/admin/_middleware.js
   — never reachable without a valid admin session.

   GET /api/admin/inventory
     Same shape as the public GET /api/inventory ({ stock: { "RED-M": 10,
     ... } }) — kept as a separate authenticated copy so the admin
     dashboard doesn't depend on a public, unauthenticated endpoint, and so
     write access below can live right next to it.

   PUT /api/admin/inventory
     Body: { "label": "RED", "size": "M", "stock": 25 }
     Sets a SKU's stock to an explicit non-negative integer via setStock()
     in functions/_inventory.js — this is the "restocking" tool the
     original functions/README.md flagged as not existing yet.
   ========================================================================== */

import { getAllStock, setStock } from '../../_inventory.js';
import { PRODUCTS, SIZES } from '../../_catalog.js';

export async function onRequestGet(context) {
  const stock = await getAllStock(context.env);
  return new Response(JSON.stringify({ stock: stock }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid request body.', 400);
  }

  const label = typeof body.label === 'string' ? body.label.toUpperCase() : '';
  const size = typeof body.size === 'string' ? body.size.toUpperCase() : '';
  const stock = Number(body.stock);

  if (!PRODUCTS[label]) return jsonError('Unknown product label.', 400);
  if (SIZES.indexOf(size) === -1) return jsonError('Unknown size.', 400);
  if (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock)) {
    return jsonError('stock must be a non-negative integer.', 400);
  }
  if (!env.INVENTORY) return jsonError('Inventory storage is not configured.', 500);

  await setStock(env, label, size, stock);

  return new Response(JSON.stringify({ ok: true, label: label, size: size, stock: stock }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost(context) {
  return onRequestPut(context);
}
export async function onRequestDelete() {
  return jsonError('Method not allowed. Use GET or PUT.', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
