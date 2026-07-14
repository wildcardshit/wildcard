/* ==========================================================================
   WILDCARD — GET /api/inventory
   Cloudflare Pages Function.

   Returns current stock counts for every product/size so the storefront
   can disable out-of-stock sizes and show "Out of Stock" messaging without
   every page needing its own copy of the numbers.

   { "stock": { "RED-M": 10, "RED-L": 0, ... } }

   Public and read-only — stock counts aren't sensitive, and nothing here
   accepts input from the request, so there's no validation to do. This is
   informational only: the real gate against overselling is the stock
   check inside api/create-checkout-session.js, which re-verifies against
   the same INVENTORY store at the moment a Checkout Session is created
   (the numbers returned here can be a few seconds stale by the time a
   shopper clicks "Checkout", same as any storefront).
   ========================================================================== */

import { getAllStock } from '../_inventory.js';

export async function onRequestGet(context) {
  const stock = await getAllStock(context.env);
  return new Response(JSON.stringify({ stock: stock }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Stock changes on every sale — never let a CDN/browser cache this.
      'Cache-Control': 'no-store'
    }
  });
}

// Explicit rejection for any other method instead of an unhelpful default
// 404/405 with no body.
export async function onRequestPost() {
  return jsonError('Method not allowed. Use GET.', 405);
}
export async function onRequestPut() {
  return jsonError('Method not allowed. Use GET.', 405);
}
export async function onRequestDelete() {
  return jsonError('Method not allowed. Use GET.', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
