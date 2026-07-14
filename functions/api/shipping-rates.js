/* ==========================================================================
   WILDCARD — GET /api/shipping-rates?country=US&subtotal=5500
   Cloudflare Pages Function.

   Lets the cart drawer show an accurate "estimated shipping" line BEFORE
   redirecting to Stripe, without duplicating rate numbers in client-side
   JS (which would eventually drift from what checkout actually charges).
   Both this endpoint and api/create-checkout-session.js import their rates
   from functions/_shipping.js, so the estimate shown here is always the
   same one Stripe will apply a moment later.

   `country` and `subtotal` are just hints to shape the estimate — nothing
   here is authoritative or security-sensitive; the real charge is always
   computed server-side again inside create-checkout-session.js from the
   actual cart contents.
   ========================================================================== */

import { ALLOWED_COUNTRIES, getShippingOptions, FREE_SHIPPING_THRESHOLD_CENTS } from '../_shipping.js';

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  const rawCountry = (url.searchParams.get('country') || 'US').toUpperCase();
  const country = ALLOWED_COUNTRIES.indexOf(rawCountry) !== -1 ? rawCountry : 'US';

  const rawSubtotal = Number(url.searchParams.get('subtotal'));
  const subtotalCents = Number.isFinite(rawSubtotal) && rawSubtotal >= 0 ? Math.round(rawSubtotal) : 0;

  const options = getShippingOptions(country, subtotalCents);

  return new Response(JSON.stringify({
    country: country,
    countries: ALLOWED_COUNTRIES,
    freeShippingThreshold: FREE_SHIPPING_THRESHOLD_CENTS,
    options: options
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost() {
  return jsonError('Method not allowed. Use GET.', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
