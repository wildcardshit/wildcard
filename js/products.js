/**
 * WILDCARD — Product Catalog (single source of truth)
 * ============================================================================
 * Every product sold on the site is defined ONCE, here, as an entry in the
 * PRODUCTS array below. Every other part of the site reads from this file:
 *
 *   - home.html               → "Pick a Card" section (image, motto, price)
 *   - product.html             → product detail page (all copy, price, sizes)
 *   - js/cart.js                → receives whatever product.html hands it
 *                                 (no product data lives in cart.js itself)
 *   - functions/api/create-checkout-session.js
 *                               → server-side price + line item source of
 *                                 truth for Stripe Checkout (never trusts
 *                                 the browser for prices)
 *   - JSON-LD structured data on product.html
 *
 * Nothing else should ever hardcode a product name, price, image, or
 * colorway again. To change what the store sells, edit this file only.
 *
 * ----------------------------------------------------------------------
 * HOW THIS FILE IS LOADED
 * ----------------------------------------------------------------------
 * This is a plain ES module, so it works, unmodified, in both places that
 * need it:
 *
 *   1. In the browser (home.html / product.html):
 *        <script type="module">
 *          import { PRODUCTS } from './js/products.js';
 *        </script>
 *
 *   2. On the server, inside the Cloudflare Pages Function that creates
 *      Stripe Checkout Sessions:
 *        import { PRODUCTS } from '../../js/products.js';
 *      Cloudflare Pages Functions are bundled with esbuild, which resolves
 *      this relative import at deploy time automatically — no extra config,
 *      no build step to set up.
 *
 * Because the frontend AND the checkout backend import this exact same
 * array, the price a customer sees on the page is always the price
 * Stripe actually charges — there is no second copy of the catalog that
 * can quietly drift out of sync.
 *
 * ----------------------------------------------------------------------
 * FIELD REFERENCE
 * ----------------------------------------------------------------------
 *   id      (string, required, unique)
 *           URL-safe id used everywhere a product needs to be referenced:
 *           product.html?id=<id>, cart line items, and the server-side
 *           catalog lookup during checkout. Once a product has shipped,
 *           been linked, or been indexed by Google, treat its id as
 *           permanent — don't rename it.
 *
 *   label   (string) Short display name for the colorway, e.g. "BLACK".
 *   suit    (string) Playing-card suit glyph shown next to the name.
 *   hex     (string) Accent color (hex) used for swatches/glows/etc.
 *   motto   (string) The big headline / product title, shown everywhere.
 *   sub     (string|null) Optional secondary line under the motto on the
 *           homepage card. Use null if the product doesn't have one.
 *   blurb   (string) Short one-sentence homepage card copy.
 *   desc    (string) Longer paragraph shown on the product detail page.
 *   img     (string) Path to the product photo, relative to site root.
 *
 *   price   (number) Price in whole + fractional DOLLARS, e.g. 44 or
 *           44.99. This is the ONLY place a price is ever set. It drives
 *           the homepage price tag, the product page price, the
 *           structured data, AND the amount Stripe actually charges.
 *           To change a price, change this one number.
 *
 *   sizes   (object) Per-size stock flags in the shape
 *           { S: true, M: true, L: true, XL: true }. Set a size to
 *           `false` to mark it out of stock — it will render disabled
 *           and struck-through on the product page, and the checkout
 *           API will reject any attempt to buy it. Sizes always display
 *           in the fixed order defined by SIZE_ORDER below.
 *
 *   hidden  (boolean, optional, default false)
 *           Set to `true` to fully hide the product: it disappears from
 *           the homepage "Pick a Card" section, its product page
 *           redirects to the homepage, and the checkout API refuses to
 *           sell it. Leave this off for normal, visible products. Handy
 *           for retiring a past drop or staging a product before launch.
 *
 *   launched (boolean, required)
 *           Whether this product can actually be purchased yet.
 *             - true  → normal behavior: real "Add to Cart" button,
 *                       real checkout, structured-data availability
 *                       driven by size stock as usual.
 *             - false → the product stays fully visible everywhere
 *                       (homepage, product page, structured data) but
 *                       purchasing is switched off: the product page
 *                       shows a disabled "Coming Soon" button instead
 *                       of "Add to Cart", and the checkout API rejects
 *                       any attempt to buy it server-side even if
 *                       someone bypasses the UI. Structured-data
 *                       availability reports OutOfStock while false.
 *           This is the single flag to flip when a drop goes live —
 *           set a product's `launched` to `true` and it becomes
 *           purchasable everywhere with no other changes needed.
 *
 *   sku     (string, optional) If you track SKUs, set it here — it will
 *           be included automatically in the product's structured data.
 * ============================================================================
 */

export const PRODUCTS = [
  {
    id: 'black',
    label: 'BLACK',
    suit: '♠',
    hex: '#16140F',
    motto: 'PLAY YOUR CARDS RIGHT',
    sub: null,
    blurb: "Two hands, five cards, zero bluffing. Just play it right.",
    desc: "The OG colorway. A blacked-out raglan built for the player who never shows their hand. Heavyweight cotton, boxy unisex fit, and a graphic that only reveals itself up close.",
    img: 'images/black-shirt.webp',
    price: 44,
    sizes: { S: true, M: true, L: true, XL: true },
    launched: false, // drop hasn't gone live yet — product page shows "Coming Soon"
  },
  {
    id: 'red',
    label: 'RED',
    suit: '♥',
    hex: '#D62828',
    motto: 'FACE YOUR FEARS',
    sub: "WE'RE ALL FIGHTING DEMONS",
    blurb: "We're all fighting something. Might as well wear it loud.",
    desc: "For the fighters. A deep crimson raglan that wears its intensity right on the sleeve — built for the days you go to war with yourself and win.",
    img: 'images/red-shirt.webp',
    price: 44,
    sizes: { S: true, M: true, L: true, XL: true },
    launched: false, // drop hasn't gone live yet — product page shows "Coming Soon"
  },
  {
    id: 'blue',
    label: 'BLUE',
    suit: '♦',
    hex: '#2456C7',
    motto: 'IGNORE THE NOISE',
    sub: null,
    blurb: "Block out everyone who was never worth the volume.",
    desc: "Cool, composed, unbothered. The blue colorway is for anyone who's learned that the loudest voice in the room usually isn't worth listening to.",
    img: 'images/blue-shirt.webp',
    price: 44,
    sizes: { S: true, M: true, L: true, XL: true },
    launched: false, // drop hasn't gone live yet — product page shows "Coming Soon"
  },
  {
    id: 'green',
    label: 'GREEN',
    suit: '♣',
    hex: '#2F6F4E',
    motto: 'GROW THROUGH WHAT YOU GO THROUGH',
    sub: null,
    blurb: "Luck doesn't grow on trees. It grows through everything else.",
    desc: "Growth isn't pretty. This raglan is for the ones putting in the quiet work nobody claps for yet.",
    img: 'images/green-shirt.webp',
    price: 44,
    sizes: { S: true, M: true, L: true, XL: true },
    launched: false, // drop hasn't gone live yet — product page shows "Coming Soon"
  },
  {
    id: 'yellow',
    label: 'YELLOW',
    suit: '★',
    hex: '#E8B92F',
    motto: 'TRUST THE PROCESS',
    sub: "CHANGE IS HAPPENING EVEN WHEN YOU CAN'T SEE IT",
    blurb: "Every monarch was a mess first. Trust it.",
    desc: "Trust takes time. Wear the yellow while you're becoming who you're becoming.",
    img: 'images/yellow-shirt.webp',
    price: 44,
    sizes: { S: true, M: true, L: true, XL: true },
    launched: false, // drop hasn't gone live yet — product page shows "Coming Soon"
  },

  // ---------------------------------------------------------------------
  // To add a new product or colorway: copy one of the objects above,
  // paste it here, give it a unique `id`, and fill in its fields
  // (including `launched` — true if it should be buyable immediately,
  // false if it should show "Coming Soon" until you flip it on). That's
  // the entire change — the homepage, product page, cart, structured
  // data, and Stripe Checkout will all pick it up automatically.
  // ---------------------------------------------------------------------
];

// ============================================================================
// Small shared helpers — used by the frontend pages AND the checkout
// function, so "what counts as purchasable" is defined once, right here,
// instead of being reimplemented (and potentially inconsistently) in
// multiple files.
// ============================================================================

/** Fixed display order for sizes wherever they're rendered. */
export const SIZE_ORDER = ['S', 'M', 'L', 'XL'];

/** Every product meant to appear in listings (homepage "Pick a Card", etc). */
export function getVisibleProducts() {
  return PRODUCTS.filter((p) => !p.hidden);
}

/** Look up a single product by id. Returns undefined if no match. */
export function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

/** True if a specific size of a product is currently in stock. */
export function isSizeInStock(product, size) {
  return !!(product && product.sizes && product.sizes[size]);
}

/** True if the product's drop has gone live (purchasing switched on). */
export function isLaunched(product) {
  return !!(product && product.launched);
}

/**
 * True if the product can actually be bought right now: visible (not
 * hidden), its drop has launched, AND at least one size is in stock.
 * This is the single check both the product page (to decide whether to
 * show "Add to Cart" vs "Coming Soon" vs "Sold Out") and the checkout
 * API (to decide whether to accept the order) rely on.
 */
export function isPurchasable(product) {
  if (!product || product.hidden || !isLaunched(product)) return false;
  return SIZE_ORDER.some((size) => isSizeInStock(product, size));
}

/** Converts a product's dollar price into integer cents (for Stripe). */
export function toPriceCents(product) {
  return Math.round(Number(product.price) * 100);
}
