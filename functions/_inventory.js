/* ==========================================================================
   WILDCARD — Server-side inventory
   Per product + size stock counts, shared by:
     - api/inventory.js                (GET, public stock levels for the UI)
     - api/create-checkout-session.js  (authoritative stock check before charging)
     - api/stripe-webhook.js           (decrements stock once an order is paid)

   Backed by a Cloudflare KV namespace bound as INVENTORY, keyed as
   "inventory:<LABEL>-<SIZE>" (e.g. "inventory:RED-M") holding a plain
   non-negative integer string — the same "order:<id>" style convention the
   ORDERS store already uses. Create it with:
     wrangler kv namespace create INVENTORY
   then bind it in wrangler.toml (see the [[kv_namespaces]] block there).

   If INVENTORY isn't bound yet (e.g. a fresh clone before that setup step),
   every read falls back to DEFAULT_STOCK below and every write silently
   no-ops, so the storefront still works out of the box — it just won't
   remember stock changes across requests/deploys until the KV namespace is
   configured for real.
   ========================================================================== */

import { PRODUCTS, SIZES, parseCartItemId } from './_catalog.js';

const KEY_PREFIX = 'inventory:';

// Starting stock per product/size. Seed data only — once INVENTORY is
// bound, whatever's been written to KV always wins over these numbers.
// A couple of sizes are deliberately at 0 so the "out of stock" UI has
// something real to show; adjust freely.
export const DEFAULT_STOCK = {
  BLACK: { S: 8, M: 12, L: 12, XL: 0 },
  RED: { S: 10, M: 10, L: 8, XL: 4 },
  BLUE: { S: 6, M: 10, L: 10, XL: 6 },
  GREEN: { S: 0, M: 6, L: 8, XL: 5 },
  YELLOW: { S: 9, M: 9, L: 9, XL: 9 }
};

function defaultStockFor(label, size) {
  const row = DEFAULT_STOCK[label];
  if (!row) return 0;
  const n = row[size];
  return Number.isFinite(n) ? n : 0;
}

function keyFor(label, size) {
  return KEY_PREFIX + label + '-' + size;
}

// Every "LABEL-SIZE" pair the catalog can possibly have, in a stable order.
function allSkus() {
  const skus = [];
  Object.keys(PRODUCTS).forEach((label) => {
    SIZES.forEach((size) => skus.push({ label, size }));
  });
  return skus;
}

// Reads one SKU's stock. Never throws — a missing binding, missing key, or
// corrupt value all fall back to the seed default rather than silently
// reading as "infinite stock".
export async function getStock(env, label, size) {
  if (!env.INVENTORY) return defaultStockFor(label, size);
  const raw = await env.INVENTORY.get(keyFor(label, size));
  if (raw === null) return defaultStockFor(label, size);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Reads every SKU's stock in one shot -> { "RED-M": 10, "RED-L": 8, ... }.
export async function getAllStock(env) {
  const skus = allSkus();
  const out = {};
  await Promise.all(
    skus.map(async ({ label, size }) => {
      out[label + '-' + size] = await getStock(env, label, size);
    })
  );
  return out;
}

// Sets one SKU's stock to an explicit non-negative integer. No-ops if
// INVENTORY isn't bound (see module comment above).
export async function setStock(env, label, size, qty) {
  if (!env.INVENTORY) return;
  const clamped = Math.max(0, Math.floor(Number(qty)) || 0);
  await env.INVENTORY.put(keyFor(label, size), String(clamped));
}

// Decrements one SKU's stock by `qty`, floored at 0.
//
// This is a read-then-write against KV, which isn't atomic — two requests
// racing to buy the last unit of the exact same SKU at the exact same
// instant could both succeed. That's an acceptable risk for a storefront
// this size (a Durable Object would be the fix if it ever isn't); it's
// also why create-checkout-session.js re-checks stock at session-creation
// time even though the client UI already disables out-of-stock sizes —
// the client check is for UX, this module is the authoritative gate.
export async function decrementStock(env, label, size, qty) {
  if (!env.INVENTORY || !(qty > 0)) return;
  const current = await getStock(env, label, size);
  const next = Math.max(0, current - qty);
  await env.INVENTORY.put(keyFor(label, size), String(next));
}

// Checks a list of { id, qty } cart lines (the same shape the client sends
// to create-checkout-session.js) against current stock. Returns an array
// of problems — empty means everything requested is available.
export async function checkAvailability(env, items) {
  const problems = [];
  for (const item of items) {
    const parsed = parseCartItemId(item.id);
    if (!parsed) continue; // caller already rejects ids that don't resolve
    const available = await getStock(env, parsed.label, parsed.size);
    if (item.qty > available) {
      problems.push({
        id: item.id,
        label: parsed.label,
        size: parsed.size,
        requested: item.qty,
        available: available
      });
    }
  }
  return problems;
}
