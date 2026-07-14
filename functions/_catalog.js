/* ==========================================================================
   WILDCARD — Server-side product catalog
   This is the ONLY place price/name/image data comes from when creating a
   Stripe Checkout Session. The Pages Function in api/create-checkout-session.js
   takes a product id + size + quantity from the client and looks everything
   else up from here — it never trusts a price, name, or image sent in the
   request body. That's what stops someone from opening devtools, editing
   their cart in localStorage, and checking out for $0.01.

   Mirrors the DECK catalog in product.html. If you add a colorway or change
   a price there, update it here too.
   ========================================================================== */

export const CURRENCY = 'usd';
export const SIZES = ['S', 'M', 'L', 'XL'];
export const PRICE_CENTS = 4400; // $44.00 — every colorway is the same price today

export const PRODUCTS = {
  BLACK:  { motto: 'PLAY YOUR CARDS RIGHT',            hex: '#16140F', image: 'images/black-shirt.png' },
  RED:    { motto: 'FACE YOUR FEARS',                  hex: '#D62828', image: 'images/red-shirt.png' },
  BLUE:   { motto: 'IGNORE THE NOISE',                 hex: '#2456C7', image: 'images/blue-shirt.png' },
  GREEN:  { motto: 'GROW THROUGH WHAT YOU GO THROUGH', hex: '#2F6F4E', image: 'images/green-shirt.png' },
  YELLOW: { motto: 'TRUST THE PROCESS',                hex: '#E8B92F', image: 'images/yellow-shirt.png' }
};

// Cart line ids follow the "LABEL-SIZE" convention set in product.html,
// e.g. "RED-M". Split on the *last* hyphen so this still works if a label
// ever contains one.
export function parseCartItemId(id) {
  if (typeof id !== 'string') return null;
  const i = id.lastIndexOf('-');
  if (i < 0) return null;
  return {
    label: id.slice(0, i).toUpperCase(),
    size: id.slice(i + 1).toUpperCase()
  };
}

// Resolves a cart line id to its authoritative product + price, or returns
// null if the id doesn't correspond to a real product/size. Callers should
// treat null as "reject this request" rather than falling back to defaults.
export function resolveCartItem(id) {
  const parsed = parseCartItemId(id);
  if (!parsed) return null;

  const product = PRODUCTS[parsed.label];
  if (!product) return null;
  if (SIZES.indexOf(parsed.size) === -1) return null;

  return {
    id: id,
    label: parsed.label,
    size: parsed.size,
    name: product.motto,
    image: product.image,
    color: product.hex,
    unitAmount: PRICE_CENTS
  };
}
