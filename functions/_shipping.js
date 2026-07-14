/* ==========================================================================
   WILDCARD — Server-side shipping configuration
   Single source of truth for shipping rates, the free-shipping threshold,
   and which countries WILDCARD currently ships to. Both
   api/shipping-rates.js (the estimate the storefront shows before
   checkout) and api/create-checkout-session.js (the real shipping_options
   attached to the Stripe Checkout Session) import from here, so the
   estimate a shopper sees in the cart drawer can never drift from what
   Stripe actually charges them a moment later.

   Mirrors the copy in shipping.html — if a rate or country changes here,
   update that page too.
   ========================================================================== */

export const CURRENCY = 'usd';

// Domestic (US) free-shipping threshold, in cents, matching shipping.html.
export const FREE_SHIPPING_THRESHOLD_CENTS = 7500; // $75.00

export const DOMESTIC_STANDARD_CENTS = 695;   // $6.95, waived over the threshold
export const DOMESTIC_EXPEDITED_CENTS = 1495; // $14.95, always charged

// WILDCARD is a young brand still building out its shipping network — for
// now this is the "small handful of countries" shipping.html refers to.
// Extend this list (and shipping.html) together as international shipping
// expands.
export const INTERNATIONAL_STANDARD_CENTS = 2495; // $24.95 flat rate
export const INTERNATIONAL_COUNTRIES = ['CA', 'GB', 'AU'];

export const ALLOWED_COUNTRIES = ['US'].concat(INTERNATIONAL_COUNTRIES);

export function isSupportedCountry(code) {
  return typeof code === 'string' && ALLOWED_COUNTRIES.indexOf(code.toUpperCase()) !== -1;
}

// Returns a plain, display-ready summary of every shipping option available
// for a given country + cart subtotal (in cents). Shared by the estimate
// endpoint (which just needs numbers to show) and checkout session
// creation (which needs the same numbers shaped as Stripe shipping_options).
export function getShippingOptions(countryCode, subtotalCents) {
  const country = (countryCode || 'US').toUpperCase();

  if (INTERNATIONAL_COUNTRIES.indexOf(country) !== -1) {
    return [
      {
        id: 'intl_standard',
        name: 'International Standard',
        description: '7\u201314 business days',
        amount: INTERNATIONAL_STANDARD_CENTS
      }
    ];
  }

  // Default / fallback: treat as domestic US.
  const qualifiesForFree = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS;
  return [
    {
      id: 'us_standard',
      name: qualifiesForFree ? 'Standard Shipping (Free)' : 'Standard Shipping',
      description: '3\u20137 business days',
      amount: qualifiesForFree ? 0 : DOMESTIC_STANDARD_CENTS
    },
    {
      id: 'us_expedited',
      name: 'Expedited Shipping',
      description: '2\u20133 business days',
      amount: DOMESTIC_EXPEDITED_CENTS
    }
  ];
}

// Shapes getShippingOptions() output into Stripe Checkout Session
// `shipping_options[]` params (as flat form-encoded keys, matching the
// x-www-form-urlencoded style the rest of create-checkout-session.js uses).
export function applyShippingOptionsToParams(params, countryCode, subtotalCents) {
  const options = getShippingOptions(countryCode, subtotalCents);
  options.forEach(function (opt, idx) {
    const prefix = 'shipping_options[' + idx + '][shipping_rate_data]';
    params.set(prefix + '[type]', 'fixed_amount');
    params.set(prefix + '[fixed_amount][amount]', String(opt.amount));
    params.set(prefix + '[fixed_amount][currency]', CURRENCY);
    params.set(prefix + '[display_name]', opt.name);
    params.set(prefix + '[delivery_estimate][minimum][unit]', 'business_day');
    params.set(prefix + '[delivery_estimate][maximum][unit]', 'business_day');
    // Rough day ranges parsed from the description above — good enough for
    // Stripe's delivery-estimate display, not used for anything else.
    var range = opt.id === 'us_expedited' ? [2, 3] : opt.id === 'intl_standard' ? [7, 14] : [3, 7];
    params.set(prefix + '[delivery_estimate][minimum][value]', String(range[0]));
    params.set(prefix + '[delivery_estimate][maximum][value]', String(range[1]));
  });
  return options;
}
