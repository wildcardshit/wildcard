# WILDCARD — Cloudflare Pages Functions

## `POST /api/create-checkout-session`

Creates a Stripe Checkout Session from the visitor's cart and returns
`{ url }` for the client to redirect to. See the top-of-file comment in
`api/create-checkout-session.js` for the full security rationale — in short:
the client only ever sends a product id + size + quantity; price, name, and
image always come from the server-side catalog in `_catalog.js`, so a
tampered cart can't change what Stripe charges.

The client can also send `shippingCountry` (one of `US`, `CA`, `GB`, `AU`)
to shape which Stripe `shipping_options` are attached to the session — this
only picks a display default. Stripe's own `shipping_address_collection`
(restricted to the same country list, see `functions/_shipping.js`) is what
actually collects and validates the shopper's address at checkout, and the
shopper can pick any allowed country there regardless of what was sent.

## `GET /api/shipping-rates?country=US&subtotal=5500`

Lets the cart drawer show an estimated shipping cost before the shopper
ever reaches Stripe. Returns the same rate numbers
`create-checkout-session.js` uses to build `shipping_options`, sourced from
`functions/_shipping.js` — so the estimate and the real charge can't drift
apart. Not authoritative or security-sensitive: `country` and `subtotal`
are just hints for shaping the response.

```json
{
  "country": "US",
  "countries": ["US", "CA", "GB", "AU"],
  "freeShippingThreshold": 7500,
  "options": [
    { "id": "us_standard", "name": "Standard Shipping", "description": "3–7 business days", "amount": 695 },
    { "id": "us_expedited", "name": "Expedited Shipping", "description": "2–3 business days", "amount": 1495 }
  ]
}
```

## Configuring the Stripe secret key

The function reads `env.STRIPE_SECRET_KEY`. This must be set as an
**encrypted** environment variable / secret on the Cloudflare Pages
project — it is never committed to the repo and never shipped to the
browser.

**Dashboard:** Pages project → Settings → Environment variables → add
`STRIPE_SECRET_KEY` for the Production (and Preview, if you want Stripe
test mode there) environment, marked as *Encrypted*.

**CLI:**
```
wrangler pages secret put STRIPE_SECRET_KEY --project-name=<your-project-name>
```

**Local dev** (`wrangler pages dev`): copy `.dev.vars.example` to
`.dev.vars` in the project root and fill in a Stripe **test** secret key.
`.dev.vars` should stay out of git (add it to `.gitignore` if it isn't
already).

## `POST /api/stripe-webhook`

Listens for Stripe webhook events. On `checkout.session.completed` (a
successful payment), it re-fetches the full session from Stripe — with line
items and product metadata expanded — and writes a structured order record
to a Cloudflare KV namespace bound as `ORDERS`, keyed as
`order:<checkout_session_id>`. See the top-of-file comment in
`api/stripe-webhook.js` for the full security/idempotency rationale.

Each stored record looks like:

```json
{
  "orderId": "cs_test_...",
  "status": "paid",
  "createdAt": "2026-07-13T18:04:11.000Z",
  "recordedAt": "2026-07-13T18:04:12.310Z",
  "currency": "usd",
  "amountSubtotal": 5500,
  "amountTotal": 6195,
  "customer": { "email": "shopper@example.com", "name": "Jane Shopper", "phone": "+15551234567" },
  "shippingAddress": { "line1": "...", "city": "...", "postal_code": "...", "country": "US" },
  "shippingCost": 695,
  "items": [
    {
      "productId": "RED",
      "size": "M",
      "color": "#D62828",
      "name": "FACE YOUR FEARS",
      "quantity": 1,
      "unitAmount": 5500,
      "amountSubtotal": 5500,
      "amountTotal": 5500,
      "currency": "usd"
    }
  ],
  "fulfillment": { "fulfilled": false, "fulfilledAt": null }
}
```

`productId`/`size`/`color` come from the same catalog metadata that
`create-checkout-session.js` attaches to each Stripe line item, so this
record maps directly back to `_catalog.js` for inventory decrementing.
`fulfillment` is a placeholder a future fulfillment tool can update once an
order ships.

### Setup

1. **Create the KV namespace** and bind it (see `wrangler.toml`):
   ```
   wrangler kv namespace create ORDERS
   ```
   then paste the printed id into `wrangler.toml`'s `[[kv_namespaces]]`
   block (and add it as a binding named `ORDERS` in the Pages dashboard
   under Settings → Functions → KV namespace bindings, if you're not
   deploying via `wrangler.toml`).
2. **Add the webhook endpoint** in the Stripe Dashboard → Developers →
   Webhooks, pointing at `https://<your-domain>/api/stripe-webhook`,
   subscribed to at least `checkout.session.completed`.
3. **Set `STRIPE_WEBHOOK_SIGNING_SECRET`** to that endpoint's signing
   secret (`whsec_...`), the same way `STRIPE_SECRET_KEY` is configured
   above — as an encrypted Pages environment variable in production, and
   in `.dev.vars` for local dev (see `.dev.vars.example`).
4. **Local testing**: use the Stripe CLI —
   `stripe listen --forward-to localhost:8788/api/stripe-webhook` — which
   prints a `whsec_...` secret for local use and lets you trigger test
   events with `stripe trigger checkout.session.completed`.

## `GET /api/order-details?session_id=...`

Powers the order confirmation UI in `checkout-success.html`: order number,
purchased items (name, size, color, quantity, price, thumbnail), shipping
address, shipping cost, and totals (subtotal/shipping/total, each broken
out separately). Reads directly from Stripe (not the `ORDERS` KV store)
so the confirmation page doesn't have to wait on webhook delivery, which is
asynchronous and can lag a few seconds behind the redirect. Only returns
data once `payment_status` is `"paid"`. See the top-of-file comment in
`api/order-details.js` for details.

## `GET /api/inventory`

Returns current stock counts for every product/size:

```json
{ "stock": { "BLACK-S": 8, "BLACK-M": 12, "BLACK-L": 12, "BLACK-XL": 0, "RED-M": 10, ... } }
```

Public and read-only — stock numbers aren't sensitive. `product.html`,
`shop.html`, `home.html`, and `js/cart.js` all call this to disable
out-of-stock sizes, grey out sold-out products, and show "Out of Stock" /
"Only N left" messaging. See the top-of-file comment in
`api/inventory.js` for details.

Backed by `functions/_inventory.js`, keyed in KV as
`inventory:<LABEL>-<SIZE>` (e.g. `inventory:RED-M`), mirroring the
`order:<id>` convention `ORDERS` already uses. `_inventory.js` ships with
seed stock numbers (`DEFAULT_STOCK`) so the storefront works before the KV
namespace is set up — those numbers just won't persist across
requests/deploys until you configure it:

```
wrangler kv namespace create INVENTORY
```

then paste the printed id into `wrangler.toml`'s second `[[kv_namespaces]]`
block (and add it as a binding named `INVENTORY` in the Pages dashboard
under Settings → Functions → KV namespace bindings, if you're not
deploying via `wrangler.toml`).

`api/create-checkout-session.js` re-checks stock against this same store
right before creating a Stripe Checkout Session (see its own top-of-file
comment) — that's the actual gate against overselling. `api/stripe-webhook.js`
decrements stock for each item on a paid order right after recording it.
Both client-side disabling and this server-side check exist together
deliberately: the client check is for UX (instant feedback, no wasted
trip to Stripe), the server check is what a shopper can't route around.

## Admin dashboard (`/admin/`)

A password-protected dashboard for running the shop day to day: view paid
orders, mark them shipped, adjust inventory, and look up customers. Lives
at `/admin/index.html`; the sign-in form is at `/admin-login.html`.

### How it's protected

Two layers, both fail closed:

1. **`functions/admin/_middleware.js`** runs for every request under
   `/admin/*` — including the static `index.html` and `js/dashboard.js`
   files themselves — *before* Cloudflare Pages serves them. Without a
   valid session cookie, the request never gets the file; it's redirected
   to `/admin-login.html` instead. There is no way to fetch the dashboard's
   HTML or JS without already being authenticated.
2. **`functions/api/admin/_middleware.js`** does the same for every
   `/api/admin/*` JSON endpoint (except `login` and `logout`, which have to
   stay reachable to establish/clear a session), returning `401` instead of
   a redirect.

Sessions are a signed, HttpOnly + Secure + SameSite=Strict cookie (see
`functions/_auth.js`) — never a value JavaScript on the page can read, and
never sent on a cross-site request. Logging out also revokes the session
server-side (via the `ADMIN_AUTH` KV store), not just by clearing the
cookie client-side, so a copied cookie stops working immediately.

The admin password itself is never stored in plaintext anywhere — only as
a PBKDF2-HMAC-SHA256 hash in the `ADMIN_PASSWORD_HASH` secret. Failed
logins are rate-limited per IP.

**This app-level auth is enforced regardless of Cloudflare plan and works
out of the box.** If you're on Cloudflare's Zero Trust / Access product,
layering [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of `/admin/*` and `/api/admin/*` as an *additional* edge-level
gate is a reasonable extra layer of defense (it can enforce SSO, device
posture, etc. before a request even reaches this code) — but it's optional
on top of what's already here, not a substitute for it.

### Setup

1. **Create the `ADMIN_AUTH` KV namespace** (see `wrangler.toml`):
   ```
   wrangler kv namespace create ADMIN_AUTH
   ```
   Backs per-IP login rate limiting and session revocation. Without it,
   login still requires the correct password — it just isn't rate-limited,
   and logout only clears the cookie client-side.
2. **Generate credentials**:
   ```
   node scripts/hash-admin-password.mjs
   ```
   Prompts for a password and prints `ADMIN_PASSWORD_HASH` and a random
   `ADMIN_SESSION_SECRET` to use as-is.
3. **Set the three secrets** (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`,
   `ADMIN_SESSION_SECRET`) the same way as `STRIPE_SECRET_KEY` above — as
   *encrypted* Pages environment variables in production:
   ```
   wrangler pages secret put ADMIN_USERNAME --project-name=<your-project-name>
   wrangler pages secret put ADMIN_PASSWORD_HASH --project-name=<your-project-name>
   wrangler pages secret put ADMIN_SESSION_SECRET --project-name=<your-project-name>
   ```
   and in `.dev.vars` for local dev (see `.dev.vars.example`).
4. Visit `/admin-login.html` and sign in.

### `GET /api/admin/whoami`
Returns `{ "username": "..." }` for the signed-in admin.

### `GET /api/admin/orders` / `PATCH /api/admin/orders`
`GET` lists paid orders from the `ORDERS` KV store (`?status=unfulfilled|fulfilled`,
`?q=<search>`, `?limit=`, `?offset=`), newest first. `PATCH` marks an order
shipped or unshipped:
```json
{ "orderId": "cs_test_...", "fulfilled": true, "carrier": "UPS", "trackingNumber": "1Z999..." }
```
This is what flips the `fulfillment.fulfilled` flag `stripe-webhook.js`
initializes to `false` on every new order, and records who did it
(`fulfilledBy`, from the session) and when (`fulfilledAt`).

### `GET /api/admin/inventory` / `PUT /api/admin/inventory`
`GET` returns the same stock data as the public `/api/inventory`. `PUT`
sets a SKU's stock to an explicit count via `setStock()`:
```json
{ "label": "RED", "size": "M", "stock": 25 }
```
This is the restocking tool the "Notes / next steps" section below used to
flag as missing.

### `GET /api/admin/customers`
Aggregates every paid order by customer email (name, phone, most recent
shipping address, order count, lifetime spend) — there's no separate
customer database, so an order's own `customer`/`shippingAddress` fields
are the source of truth. Supports `?q=<search>` against name/email.

## Notes / next steps

- Uses Stripe's REST API directly via `fetch` (no `stripe` npm package), so
  there's nothing extra to bundle and it runs natively on the Workers
  runtime Cloudflare Pages Functions use.
- `checkout-success.html` and `checkout-cancel.html` at the project root
  are the `success_url` / `cancel_url` Stripe redirects to. Both match the
  site's design (same header, footer, fonts, and watermark). The success
  page clears the local cart; the cancel page leaves it untouched so the
  shopper can pick up where they left off.
- Inventory decrements happen in `stripe-webhook.js` on a best-effort basis
  right after the order write (see the comment there for why that failure
  mode is logged rather than retried). If a decrement is ever missed, fix
  it from the admin dashboard's Inventory tab (`PUT /api/admin/inventory`
  above), which replaced the one-off script this note used to suggest.
