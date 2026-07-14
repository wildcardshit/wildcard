/* ==========================================================================
   WILDCARD — Server-side order store helpers
   Thin wrapper around the ORDERS KV namespace that functions/api/stripe-webhook.js
   writes to (see its top-of-file comment for the record shape), shared by
   the admin endpoints that read/update it:
     - api/admin/orders.js     (list orders, mark shipped)
     - api/admin/customers.js  (aggregate orders by customer)

   Mirrors the _catalog.js / _inventory.js convention already used in this
   codebase: one small module per concern, imported wherever it's needed.
   ========================================================================== */

export const ORDER_KEY_PREFIX = 'order:';

// Sanity cap on how many order keys a single admin request will walk. This
// store only ever grows from paid Stripe orders, so for a shop this size a
// full in-memory scan+sort is simpler and fine; if the store ever grows
// past this, the oldest orders past the cap just won't appear in the admin
// list until pagination is added.
const MAX_SCAN = 2000;

// Loads every order in the store, newest first. Returns [] (rather than
// throwing) if ORDERS isn't bound, so callers can fail soft with an empty
// dashboard instead of a hard error.
export async function loadAllOrders(env) {
  if (!env.ORDERS) return [];

  const keys = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix: ORDER_KEY_PREFIX, cursor: cursor, limit: 1000 });
    keys.push.apply(keys, page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < MAX_SCAN);

  const records = await Promise.all(
    keys.slice(0, MAX_SCAN).map(async (k) => {
      const raw = await env.ORDERS.get(k.name);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    })
  );

  return records
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getOrder(env, orderId) {
  if (!env.ORDERS || !orderId) return null;
  const raw = await env.ORDERS.get(ORDER_KEY_PREFIX + orderId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function saveOrder(env, orderId, order) {
  await env.ORDERS.put(ORDER_KEY_PREFIX + orderId, JSON.stringify(order));
}
