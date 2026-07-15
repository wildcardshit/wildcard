/**
 * POST /api/create-checkout-session
 *
 * Cloudflare Pages Function. Accepts a cart from the frontend, re-prices
 * every line item against the server-side catalog below (client-sent
 * prices are never trusted), creates a Stripe Checkout Session via
 * Stripe's REST API (no SDK), and returns only the Session URL as JSON.
 *
 * Scope, on purpose:
 *   - No redirect happens here — the frontend sends the customer to the
 *     returned URL.
 *   - No webhooks, no inventory, no admin, no orders, no shipping, no
 *     customer records.
 *   - Every failure path returns JSON. The Worker never throws an
 *     uncaught exception, so Cloudflare never substitutes its own HTML
 *     502 page.
 *
 * Required Cloudflare Pages environment variable:
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... / sk_test_...)
 *
 * Optional Cloudflare Pages environment variable:
 *   ENVIRONMENT — set to "development" to include raw Stripe error
 *   detail (message/type/code/param/request id) in error responses.
 *   Leave unset (or anything other than "development") in production so
 *   internal Stripe error detail is never exposed to customers.
 */

// ---------- Server-side catalog (source of truth for price + product info) ----------
// Mirrors the PRODUCTS array in product.html. Keep in sync manually if
// that file changes — this catalog is what actually determines what the
// customer is charged, never anything sent from the browser.
const CATALOG = {
  black:  { label: 'BLACK',  motto: 'PLAY YOUR CARDS RIGHT',            priceCents: 4400, img: 'images/black-shirt.png' },
  red:    { label: 'RED',    motto: 'FACE YOUR FEARS',                  priceCents: 4400, img: 'images/red-shirt.png' },
  blue:   { label: 'BLUE',   motto: 'IGNORE THE NOISE',                 priceCents: 4400, img: 'images/blue-shirt.png' },
  green:  { label: 'GREEN',  motto: 'GROW THROUGH WHAT YOU GO THROUGH', priceCents: 4400, img: 'images/green-shirt.png' },
  yellow: { label: 'YELLOW', motto: 'TRUST THE PROCESS',                priceCents: 4400, img: 'images/yellow-shirt.png' }
};

const VALID_SIZES = new Set(['S', 'M', 'L', 'XL']);
const MAX_QTY_PER_LINE = 20;
const MAX_LINE_ITEMS = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function isDev(env) {
  return env && env.ENVIRONMENT === 'development';
}

/**
 * Validates the raw cart payload against the server catalog and returns a
 * clean list of { id, size, qty, catalogEntry } lines, using only
 * server-known prices and names. Throws a user-safe message on any
 * invalid input — callers must catch this.
 */
function validateCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty.');
  }
  if (items.length > MAX_LINE_ITEMS) {
    throw new Error('Too many line items in cart.');
  }

  return items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid item at position ${i}.`);
    }

    const id = String(raw.id || '').toLowerCase().trim();
    const catalogEntry = CATALOG[id];
    if (!catalogEntry) {
      throw new Error(`Unknown product "${raw.id}".`);
    }

    const size = raw.size != null ? String(raw.size).toUpperCase().trim() : null;
    if (!size || !VALID_SIZES.has(size)) {
      throw new Error(`Invalid size for "${id}".`);
    }

    const qty = Number.parseInt(raw.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new Error(`Invalid quantity for "${id}".`);
    }

    return { id, size, qty, catalogEntry };
  });
}

/**
 * Builds the x-www-form-urlencoded body Stripe's REST API expects for
 * Checkout Session creation, using bracket notation for nested/array
 * fields (line_items[0][price_data][...], etc).
 */
function buildStripeBody(lines, origin) {
  const params = new URLSearchParams();

  params.set('mode', 'payment');
  params.set('success_url', `${origin}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/checkout-cancel.html`);

  lines.forEach((line, i) => {
    const prefix = `line_items[${i}]`;
    params.set(`${prefix}[quantity]`, String(line.qty));
    params.set(`${prefix}[price_data][currency]`, 'usd');
    params.set(`${prefix}[price_data][unit_amount]`, String(line.catalogEntry.priceCents));
    params.set(
      `${prefix}[price_data][product_data][name]`,
      `${line.catalogEntry.motto} — ${line.catalogEntry.label} / ${line.size}`
    );
    params.set(`${prefix}[price_data][product_data][images][0]`, `${origin}/${line.catalogEntry.img}`);
  });

  return params;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Top-level guard: no matter what throws below, we always return a
  // JSON Response. Letting an exception escape this handler is what
  // causes Cloudflare to substitute its own HTML 502 page.
  try {
    if (!env || !env.STRIPE_SECRET_KEY) {
      return json({ error: 'Server is not configured for checkout yet.' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400);
    }

    let lines;
    try {
      lines = validateCart(body && body.items);
    } catch (err) {
      return json({ error: err.message }, 400);
    }

    let origin;
    try {
      origin = new URL(request.url).origin;
    } catch {
      return json({ error: 'Could not determine request origin.' }, 400);
    }

    const stripeBody = buildStripeBody(lines, origin);

    let stripeResponse;
    try {
      stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: stripeBody
      });
    } catch {
      return json({ error: 'Could not reach Stripe. Please try again.' }, 502);
    }

    // Stripe's response body must be parsed defensively too — a
    // truncated or non-JSON response here would otherwise throw
    // uncaught.
    let stripeData;
    try {
      stripeData = await stripeResponse.json();
    } catch {
      return json({ error: 'Stripe returned an unreadable response.' }, 502);
    }

    if (!stripeResponse.ok) {
      const stripeErr = (stripeData && stripeData.error) || {};
      const payload = { error: 'Stripe could not create the checkout session.' };
      if (isDev(env)) {
        // Development only: surface the exact Stripe error detail.
        payload.stripe = {
          message: stripeErr.message || null,
          type: stripeErr.type || null,
          code: stripeErr.code || null,
          param: stripeErr.param || null,
          requestId: stripeResponse.headers.get('request-id') || null
        };
      }
      return json(payload, 502);
    }

    if (!stripeData || typeof stripeData.url !== 'string') {
      return json({ error: 'Stripe session created without a checkout URL.' }, 502);
    }

    return json({ url: stripeData.url });
  } catch (err) {
    // Final safety net for anything unanticipated above.
    const payload = { error: 'Unexpected server error.' };
    if (isDev(env)) {
      payload.debug = {
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null
      };
    }
    return json(payload, 500);
  }
}

// Any method other than POST is not supported by this endpoint.
export async function onRequestGet() {
  return json({ error: 'Method not allowed.' }, 405);
}
