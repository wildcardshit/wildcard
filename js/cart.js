/* ==========================================================================
   WILDCARD — Cart Drawer
   Self-contained, drop-in cart module. Injects its own markup + styles,
   persists to localStorage, and wires up the existing #cartBtn header icon
   plus any ".btn--hand" add-to-cart buttons already on the page.
   No existing markup, styles, or animations are modified — this file only
   adds new DOM (the drawer + its overlay) and new listeners.
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'wildcard_cart_v1';
  var SHIPPING_THRESHOLD = 75; // fallback free-shipping threshold (USD) used only until
                                // /api/shipping-rates responds — functions/_shipping.js is
                                // the real source of truth and this is kept in sync with it.
  var LOW_STOCK_THRESHOLD = 5; // "Only N left" starts showing at/under this

  /* ---------------- shipping estimate ----------------
     Lets the cart drawer show a real, live "estimated shipping" figure
     before the shopper ever reaches Stripe, without hardcoding rate
     numbers here that could drift from what checkout actually charges.
     GET /api/shipping-rates (backed by functions/_shipping.js) is fetched
     once per selected country — always with subtotal=0, so the numbers it
     returns are the *undiscounted* rate for that country; the $75 free-
     shipping discount for US orders is then re-applied locally against the
     cart's live subtotal so it updates instantly as items are added or
     removed, with no extra round trip. The selected country itself is
     just a display convenience: create-checkout-session.js re-validates
     it (or defaults to US) and Stripe's own address collection is the
     actual authority on where an order can ship. */

  var SHIP_COUNTRIES = [
    { code: 'US', label: 'United States' },
    { code: 'CA', label: 'Canada' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'AU', label: 'Australia' }
  ];
  var SHIP_COUNTRY_KEY = 'wildcard_ship_country_v1';
  var shipCountry = loadShipCountry();
  var shipRatesCache = {};   // country code -> { options, freeShippingThreshold }
  var shipRatesLoading = {}; // country code -> true while a fetch is in flight

  function loadShipCountry() {
    try {
      var v = localStorage.getItem(SHIP_COUNTRY_KEY);
      return SHIP_COUNTRIES.some(function (c) { return c.code === v; }) ? v : 'US';
    } catch (e) {
      return 'US';
    }
  }

  function saveShipCountry(code) {
    try {
      localStorage.setItem(SHIP_COUNTRY_KEY, code);
    } catch (e) {
      /* storage unavailable — the selection just won't persist across visits */
    }
  }

  function ensureShippingRates(country) {
    if (shipRatesCache[country] || shipRatesLoading[country]) return;
    shipRatesLoading[country] = true;
    fetch('/api/shipping-rates?country=' + encodeURIComponent(country) + '&subtotal=0')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        shipRatesLoading[country] = false;
        if (!data) return;
        shipRatesCache[country] = data;
        updateSummary(); // refine the estimate now that real numbers are in
      })
      .catch(function () {
        shipRatesLoading[country] = false;
        // Rates API unreachable — the drawer keeps showing its conservative
        // local fallback estimate rather than blocking checkout on it.
      });
  }

  // Builds the shipping lines to display for the current country + live
  // subtotal. Falls back to a conservative local estimate (mirroring
  // functions/_shipping.js) until the real rates have loaded.
  function getShippingDisplay(subtotal) {
    var cached = shipRatesCache[shipCountry];
    var thresholdDollars = cached ? cached.freeShippingThreshold / 100 : SHIPPING_THRESHOLD;
    var isDomestic = shipCountry === 'US';
    var qualifiesFree = isDomestic && subtotal >= thresholdDollars;

    if (!cached) {
      var fallback = isDomestic ? (qualifiesFree ? 0 : 6.95) : 24.95;
      return {
        loaded: false,
        thresholdDollars: thresholdDollars,
        lines: [{ name: isDomestic ? 'Standard Shipping' : 'International Standard', amount: fallback }]
      };
    }

    var lines = cached.options.map(function (opt) {
      var amount = opt.amount / 100;
      if (isDomestic && opt.id === 'us_standard' && qualifiesFree) amount = 0;
      return { name: opt.name.replace(' (Free)', ''), amount: amount };
    });

    return { loaded: true, thresholdDollars: thresholdDollars, lines: lines };
  }

  /* ---------------- inventory ----------------
     Stock comes from GET /api/inventory as { "LABEL-SIZE": count }. This
     module fetches it once on init and keeps it around for the lifetime
     of the page — good enough to drive "Out of Stock" / "Only N left" UI
     and to stop obviously-oversized adds/increments client-side. It is
     NOT the authoritative check: api/create-checkout-session.js re-verifies
     stock against the same server-side store when Checkout is actually
     created, so a stale or unreachable copy here can't let anyone buy
     more than actually exists — it can only ever be overly cautious,
     never under-cautious. */

  var SIZES = ['S', 'M', 'L', 'XL'];
  var stockBySku = {};
  var stockLoaded = false;

  function stockForSku(label, size) {
    if (!stockLoaded) return Infinity; // unknown yet — don't block while waiting on the API
    var key = label + '-' + size;
    return Object.prototype.hasOwnProperty.call(stockBySku, key) ? stockBySku[key] : Infinity;
  }

  // Total remaining stock across every size of a colorway — used for
  // quick-add buttons (shop.html / home.html) that don't collect a size.
  function stockForLabel(label) {
    if (!stockLoaded) return Infinity;
    var total = 0;
    var any = false;
    SIZES.forEach(function (size) {
      var key = label + '-' + size;
      if (Object.prototype.hasOwnProperty.call(stockBySku, key)) {
        total += stockBySku[key];
        any = true;
      }
    });
    return any ? total : Infinity;
  }

  function stockForLine(line) {
    var label = colorLabelFromId(line.id);
    return line.size ? stockForSku(label, line.size) : stockForLabel(label);
  }

  function loadStock() {
    fetch('/api/inventory')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.stock) return;
        stockBySku = data.stock;
        stockLoaded = true;
        // Stock just arrived — refresh everything that depends on it
        // without touching localStorage (the cart itself hasn't changed).
        renderLines();
        updateSummary();
        syncHandButtons();
      })
      .catch(function () {
        // Inventory API unreachable — the UI simply fails open (nothing
        // gets disabled based on stock). The server remains the real gate.
      });
  }

  /* ---------------- storage ---------------- */

  function loadCart() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch (e) {
      /* storage unavailable (private mode, quota, etc.) — fail silently */
    }
  }

  var cart = loadCart();

  /* ---------------- cart mutations ---------------- */

  function findLine(id) {
    for (var i = 0; i < cart.length; i++) {
      if (cart[i].id === id) return cart[i];
    }
    return null;
  }

  function addItem(product, qty) {
    qty = qty || 1;
    var line = findLine(product.id);
    var existingQty = line ? line.qty : 0;
    var label = colorLabelFromId(product.id);
    var cap = product.size ? stockForSku(label, product.size) : stockForLabel(label);

    if (Number.isFinite(cap)) {
      qty = Math.max(0, Math.min(qty, cap - existingQty));
      if (qty <= 0) {
        // Already holding the max available (or it's sold out) — nothing
        // to add, but still refresh the UI so it reflects that state.
        afterChange();
        return;
      }
    }

    if (line) {
      line.qty += qty;
    } else {
      cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        color: product.color || null,
        size: product.size || null,
        qty: qty
      });
    }
    afterChange();
  }

  function getQty(id) {
    var line = findLine(id);
    return line ? line.qty : 0;
  }

  function removeItem(id) {
    cart = cart.filter(function (l) { return l.id !== id; });
    afterChange();
  }

  function setQty(id, qty) {
    var line = findLine(id);
    if (!line) return;
    if (qty <= 0) {
      removeItem(id);
      return;
    }
    line.qty = qty;
    afterChange();
  }

  function clearCart() {
    cart = [];
    afterChange();
  }

  function getCount() {
    return cart.reduce(function (s, l) { return s + l.qty; }, 0);
  }

  function getSubtotal() {
    return cart.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
  }

  function afterChange() {
    saveCart();
    renderLines();
    updateSummary();
    updateAllBadges();
    syncHandButtons();
  }

  /* ---------------- money formatting ---------------- */

  function money(n) {
    return '$' + n.toFixed(2).replace(/\.00$/, '');
  }

  /* ---------------- checkout payload ----------------
     `buildCheckoutPayload()` below reshapes the cart into a Stripe
     Checkout Session shape purely for local inspection/debugging (see
     WildcardCart.getCheckoutPayload() in the console). It is NOT what
     actually gets sent to the server.

     The real request sent to /api/create-checkout-session only includes
     each line's product id and quantity — never price, name, or image.
     The Cloudflare Pages Function re-derives all of that server-side from
     its own product catalog, so nothing the client sends can change what
     Stripe actually charges (see functions/_catalog.js). */

  function buildCheckoutRequestItems() {
    return cart.map(function (line) {
      return { id: line.id, qty: line.qty };
    });
  }

  function toAbsoluteUrl(path) {
    if (!path) return null;
    try {
      return new URL(path, window.location.href).href;
    } catch (e) {
      return path;
    }
  }

  // One cart line -> one Stripe `line_items[]` entry using inline
  // `price_data` (no pre-created Stripe Price objects needed). Size and
  // color ride along as metadata so they survive onto the Payment Intent /
  // order confirmation once a backend is in place.
  function toStripeLineItem(line) {
    return {
      quantity: line.qty,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(line.price * 100), // Stripe wants integer cents
        product_data: {
          name: line.name,
          images: line.image ? [toAbsoluteUrl(line.image)] : [],
          metadata: {
            id: line.id,
            size: line.size || '',
            color: line.color || ''
          }
        }
      }
    };
  }

  // Full payload shaped like the body a `/v1/checkout/sessions` create call
  // (or a backend wrapping it) would want. Swap the placeholder success/
  // cancel URLs for real pages once they exist.
  function buildCheckoutPayload() {
    return {
      mode: 'payment',
      currency: 'usd',
      line_items: cart.map(toStripeLineItem),
      success_url: toAbsoluteUrl('checkout-success.html') + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: window.location.href,
      metadata: {
        cart_item_count: String(getCount()),
        subtotal_usd: getSubtotal().toFixed(2)
      }
    };
  }

  /* ---------------- drawer markup + styles (injected once) ---------------- */

  var els = {};

  function injectStyles() {
    if (document.getElementById('wc-cart-styles')) return;
    var style = document.createElement('style');
    style.id = 'wc-cart-styles';
    style.textContent = [
      '.wc-cart-overlay{position:fixed;inset:0;background:rgba(22,20,15,0.55);opacity:0;pointer-events:none;transition:opacity .35s cubic-bezier(.16,1,.3,1);z-index:9998;}',
      '.wc-cart-overlay.is-open{opacity:1;pointer-events:auto;}',
      '.wc-cart-drawer{position:fixed;top:0;right:0;height:100%;width:min(420px,100vw);background:var(--paper,#fff);color:var(--ink,#16140F);z-index:9999;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,0.25);transform:translateX(100%);transition:transform .45s cubic-bezier(.16,1,.3,1);font-family:var(--font-body,Inter,sans-serif);}',
      '.wc-cart-drawer.is-open{transform:translateX(0);}',
      '.wc-cart-head{display:flex;align-items:center;justify-content:space-between;padding:22px 22px 18px;border-bottom:2px solid var(--ink,#16140F);flex:0 0 auto;}',
      '.wc-cart-title{font-family:var(--font-display,Anton,sans-serif);font-size:1.4rem;letter-spacing:0.04em;margin:0;text-transform:uppercase;}',
      '.wc-cart-count-pill{font-family:var(--font-mono,monospace);font-size:0.7rem;font-weight:700;background:var(--ink,#16140F);color:var(--paper,#fff);border-radius:999px;padding:2px 8px;margin-left:8px;vertical-align:middle;}',
      '.wc-cart-close{background:none;border:none;cursor:pointer;padding:6px;line-height:0;color:var(--ink,#16140F);border-radius:50%;transition:background .15s ease,transform .15s ease;}',
      '.wc-cart-close:hover{background:var(--paper-dim,#F0F0F0);transform:rotate(90deg);}',
      '.wc-cart-body{flex:1 1 auto;overflow-y:auto;padding:8px 22px;}',
      '.wc-cart-line{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--paper-dim,#F0F0F0);animation:wc-line-in .3s cubic-bezier(.34,1.56,.64,1);}',
      '@keyframes wc-line-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}',
      '.wc-cart-thumb{width:72px;height:86px;flex:0 0 auto;border-radius:10px;overflow:hidden;background:var(--paper-dim,#F0F0F0);}',
      '.wc-cart-thumb img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.wc-cart-info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '.wc-cart-name{font-family:var(--font-display,Anton,sans-serif);font-size:0.92rem;text-transform:uppercase;letter-spacing:0.02em;margin:0;line-height:1.2;}',
      '.wc-cart-color{font-family:var(--font-mono,monospace);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:#8a8a8a;display:flex;align-items:center;gap:6px;}',
      '.wc-cart-swatch{width:9px;height:9px;border-radius:50%;display:inline-block;}',
      '.wc-cart-size{font-family:var(--font-mono,monospace);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:#8a8a8a;}',
      '.wc-cart-row{display:flex;align-items:center;justify-content:space-between;margin-top:auto;}',
      '.wc-cart-qty{display:inline-flex;align-items:center;border:2px solid var(--ink,#16140F);border-radius:999px;overflow:hidden;}',
      '.wc-cart-qty button{width:26px;height:26px;border:none;background:none;cursor:pointer;font-family:var(--font-mono,monospace);font-size:0.85rem;font-weight:700;color:var(--ink,#16140F);transition:background .15s ease;}',
      '.wc-cart-qty button:hover{background:var(--wild-red,#EB181D);color:var(--paper,#fff);}',
      '.wc-cart-qty span{min-width:22px;text-align:center;font-family:var(--font-mono,monospace);font-size:0.8rem;font-weight:700;}',
      '.wc-cart-price{font-family:var(--font-mono,monospace);font-weight:700;font-size:0.85rem;}',
      '.wc-cart-remove{background:none;border:none;cursor:pointer;color:#8a8a8a;font-family:var(--font-mono,monospace);font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;text-decoration:underline;padding:0;margin-top:2px;align-self:flex-start;}',
      '.wc-cart-remove:hover{color:var(--wild-red,#EB181D);}',
      '.wc-cart-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:60px 10px;color:#8a8a8a;}',
      '.wc-cart-empty svg{opacity:0.35;}',
      '.wc-cart-empty p{margin:0;font-family:var(--font-mono,monospace);font-size:0.8rem;letter-spacing:0.04em;}',
      '.wc-cart-empty a{font-family:var(--font-mono,monospace);font-weight:700;font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--wild-red,#EB181D);text-decoration:none;border-bottom:2px solid var(--wild-red,#EB181D);padding-bottom:2px;}',
      '.wc-cart-foot{flex:0 0 auto;padding:18px 22px 24px;border-top:2px solid var(--ink,#16140F);}',
      '.wc-cart-subtotal-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}',
      '.wc-cart-subtotal-label{font-family:var(--font-mono,monospace);font-size:0.78rem;letter-spacing:0.06em;text-transform:uppercase;}',
      '.wc-cart-subtotal-value{font-family:var(--font-mono,monospace);font-weight:700;font-size:1.05rem;}',
      '.wc-cart-shipping{margin:10px 0 12px;padding:12px 14px;background:var(--paper-dim,#F0F0F0);border-radius:10px;}',
      '.wc-cart-shipping-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;}',
      '.wc-cart-shipping-row--extra{opacity:0.75;}',
      '.wc-cart-shipping-label{font-family:var(--font-mono,monospace);font-size:0.72rem;letter-spacing:0.04em;text-transform:uppercase;color:#3a372e;}',
      '.wc-cart-shipping-value{font-family:var(--font-mono,monospace);font-weight:700;font-size:0.8rem;}',
      '.wc-cart-shipping-select{font-family:var(--font-mono,monospace);font-size:0.76rem;font-weight:700;border:2px solid var(--ink,#16140F);border-radius:6px;background:var(--paper,#fff);color:var(--ink,#16140F);padding:5px 8px;cursor:pointer;}',
      '.wc-cart-estimate-row{margin-bottom:10px;}',
      '.wc-cart-note{font-family:var(--font-mono,monospace);font-size:0.68rem;color:#8a8a8a;margin:0 0 16px;}',
      '.wc-cart-checkout{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;text-align:center;border:none;cursor:pointer;padding:16px 26px;font-family:var(--font-mono,monospace);font-weight:700;font-size:0.85rem;letter-spacing:0.06em;text-transform:uppercase;border-radius:4px;background:var(--wild-red,#EB181D);color:var(--paper,#fff);transition:transform .15s ease,background .15s ease;}',
      '.wc-cart-checkout:hover{background:var(--wild-red-dark,#A91F1F);transform:translateY(-2px);}',
      '.wc-cart-checkout:disabled{background:var(--paper-dim,#F0F0F0);color:#b3b3b3;cursor:not-allowed;transform:none;}',
      '.wc-cart-checkout__icon{flex:0 0 auto;transition:transform .2s ease;}',
      '.wc-cart-checkout.is-loading .wc-cart-checkout__icon{animation:wc-checkout-spin .9s linear infinite;}',
      '@keyframes wc-checkout-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}',
      '.wc-cart-checkout-status{font-family:var(--font-mono,monospace);font-size:0.7rem;line-height:1.5;color:#8a8a8a;margin:12px 0 0;opacity:0;transform:translateY(4px);transition:opacity .3s ease,transform .3s ease;}',
      '.wc-cart-checkout-status.is-visible{opacity:1;transform:translateY(0);}',
      '@media (prefers-reduced-motion: reduce){.wc-cart-drawer,.wc-cart-overlay,.wc-cart-close,.wc-cart-checkout,.wc-cart-checkout__icon,.wc-cart-checkout-status,.wc-cart-line{transition:none !important;animation:none !important;}}',

      /* ---- stock-aware states (drawer) ---- */
      '.wc-cart-stock-note{font-family:var(--font-mono,monospace);font-size:0.68rem;letter-spacing:0.03em;color:#b3822a;margin:6px 0 0;}',
      '.wc-cart-stock-note--out{color:var(--wild-red,#EB181D);font-weight:700;}',
      '.wc-cart-stock-note--blocking{margin:0 0 12px;text-align:center;}',
      '.wc-cart-line--soldout .wc-cart-thumb img{filter:grayscale(1);opacity:0.55;}',
      '.wc-cart-qty button:disabled{opacity:0.3;cursor:not-allowed;}',
      '.wc-cart-qty button:disabled:hover{background:none;color:var(--ink,#16140F);}',

      /* ---- stock-aware states (quick-add "Add to Hand" buttons + their card) ---- */
      '.btn--hand:disabled,.btn--hand.is-soldout{opacity:0.45;cursor:not-allowed;text-decoration:line-through;}',
      '.btn--hand:disabled:hover,.btn--hand.is-soldout:hover{background:var(--ink,#16140F);}',
      '.deck__tile.is-soldout .deck__art img,.pick__card.is-soldout .pick__photo img{filter:grayscale(1) brightness(0.85);}',
      '.deck__tile.is-soldout::after,.pick__card.is-soldout::after{content:"SOLD OUT";position:absolute;top:14px;left:14px;background:var(--ink,#16140F);color:var(--paper,#fff);font-family:var(--font-mono,monospace);font-size:0.62rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 10px;border-radius:4px;z-index:5;pointer-events:none;}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectDrawer() {
    if (document.getElementById('wcCartDrawer')) return;

    var overlay = document.createElement('div');
    overlay.className = 'wc-cart-overlay';
    overlay.id = 'wcCartOverlay';

    var drawer = document.createElement('aside');
    drawer.className = 'wc-cart-drawer';
    drawer.id = 'wcCartDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Shopping cart');

    drawer.innerHTML =
      '<div class="wc-cart-head">' +
        '<h2 class="wc-cart-title">Your Hand<span class="wc-cart-count-pill" id="wcCartCountPill">0</span></h2>' +
        '<button type="button" class="wc-cart-close" id="wcCartClose" aria-label="Close cart">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="wc-cart-body" id="wcCartBody"></div>' +
      '<div class="wc-cart-foot" id="wcCartFoot"></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    els.overlay = overlay;
    els.drawer = drawer;
    els.body = document.getElementById('wcCartBody');
    els.foot = document.getElementById('wcCartFoot');
    els.countPill = document.getElementById('wcCartCountPill');
    els.closeBtn = document.getElementById('wcCartClose');

    els.closeBtn.addEventListener('click', closeCart);
    overlay.addEventListener('click', closeCart);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.drawer.classList.contains('is-open')) closeCart();
    });

    // Shipping country selector lives in the footer (re-rendered on every
    // updateSummary()), so this listener is delegated at the footer
    // container rather than bound to the <select> itself.
    els.foot.addEventListener('change', function (e) {
      var select = e.target.closest('#wcShipCountry');
      if (!select) return;
      shipCountry = select.value;
      saveShipCountry(shipCountry);
      ensureShippingRates(shipCountry);
      updateSummary();
    });

    // event delegation for line item controls
    els.body.addEventListener('click', function (e) {
      var incBtn = e.target.closest('[data-wc-inc]');
      var decBtn = e.target.closest('[data-wc-dec]');
      var rmBtn = e.target.closest('[data-wc-remove]');
      if (incBtn) {
        var id1 = incBtn.getAttribute('data-wc-inc');
        var line1 = findLine(id1);
        if (line1) {
          var cap1 = stockForLine(line1);
          if (!Number.isFinite(cap1) || line1.qty < cap1) {
            setQty(id1, line1.qty + 1);
          }
        }
      } else if (decBtn) {
        var id2 = decBtn.getAttribute('data-wc-dec');
        var line2 = findLine(id2);
        if (line2) setQty(id2, line2.qty - 1);
      } else if (rmBtn) {
        removeItem(rmBtn.getAttribute('data-wc-remove'));
      }
    });
  }

  /* ---------------- rendering ---------------- */

  function renderLines() {
    if (!els.body) return;

    if (cart.length === 0) {
      els.body.innerHTML =
        '<div class="wc-cart-empty">' +
          '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/></svg>' +
          '<p>Your hand is empty.<br>Time to pick a card.</p>' +
          '<a href="' + shopLinkHref() + '">Shop the Deck</a>' +
        '</div>';
      return;
    }

    var html = cart.map(function (line) {
      var swatch = line.color ? '<span class="wc-cart-swatch" style="background:' + line.color + '"></span>' : '';
      var sizeRow = line.size ? '<span class="wc-cart-size">Size: ' + escapeHtml(line.size) + '</span>' : '';

      var cap = stockForLine(line);
      var soldOut = stockLoaded && cap <= 0;
      var atCap = stockLoaded && Number.isFinite(cap) && line.qty >= cap;
      var lowStock = stockLoaded && Number.isFinite(cap) && cap > 0 && cap <= LOW_STOCK_THRESHOLD;

      var stockNote = '';
      if (soldOut) {
        stockNote = '<p class="wc-cart-stock-note wc-cart-stock-note--out">Out of stock — remove to check out.</p>';
      } else if (lowStock) {
        stockNote = '<p class="wc-cart-stock-note">Only ' + cap + ' left.</p>';
      }

      return (
        '<div class="wc-cart-line' + (soldOut ? ' wc-cart-line--soldout' : '') + '" data-id="' + escapeHtml(line.id) + '">' +
          '<div class="wc-cart-thumb"><img src="' + escapeHtml(line.image || '') + '" alt="' + escapeHtml(line.name) + '" loading="lazy"></div>' +
          '<div class="wc-cart-info">' +
            '<h3 class="wc-cart-name">' + escapeHtml(line.name) + '</h3>' +
            '<span class="wc-cart-color">' + swatch + (line.color ? escapeHtml(colorLabelFromId(line.id)) : '') + '</span>' +
            sizeRow +
            '<div class="wc-cart-row">' +
              '<div class="wc-cart-qty">' +
                '<button type="button" data-wc-dec="' + escapeHtml(line.id) + '" aria-label="Decrease quantity">−</button>' +
                '<span>' + line.qty + '</span>' +
                '<button type="button" data-wc-inc="' + escapeHtml(line.id) + '" aria-label="Increase quantity"' + (atCap ? ' disabled' : '') + '>+</button>' +
              '</div>' +
              '<span class="wc-cart-price">' + money(line.price * line.qty) + '</span>' +
            '</div>' +
            stockNote +
            '<button type="button" class="wc-cart-remove" data-wc-remove="' + escapeHtml(line.id) + '">Remove</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    els.body.innerHTML = html;
  }

  function updateSummary() {
    if (!els.foot || !els.countPill) return;
    var count = getCount();
    var subtotal = getSubtotal();
    els.countPill.textContent = String(count);

    if (count === 0) {
      els.foot.innerHTML = '';
      return;
    }

    var shipDisplay = getShippingDisplay(subtotal);
    var defaultShipping = shipDisplay.lines[0].amount;
    var estimatedTotal = subtotal + defaultShipping;

    var remaining = shipDisplay.thresholdDollars - subtotal;
    var note = shipCountry === 'US'
      ? (remaining > 0 ? ('Add ' + money(remaining) + ' more for free shipping.') : 'Free shipping unlocked.')
      : 'Rates shown are estimates \u2014 confirm at checkout.';

    var hasSoldOutLine = stockLoaded && cart.some(function (line) { return stockForLine(line) <= 0; });
    var blockedNote = hasSoldOutLine
      ? '<p class="wc-cart-stock-note wc-cart-stock-note--out wc-cart-stock-note--blocking">Remove out-of-stock items to check out.</p>'
      : '';

    var countryOptions = SHIP_COUNTRIES.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === shipCountry ? ' selected' : '') + '>' + c.label + '</option>';
    }).join('');

    var extraShippingLines = shipDisplay.lines.slice(1).map(function (line) {
      return '<div class="wc-cart-shipping-row wc-cart-shipping-row--extra">' +
        '<span class="wc-cart-shipping-label">' + escapeHtml(line.name) + '</span>' +
        '<span class="wc-cart-shipping-value">' + money(line.amount) + '</span>' +
      '</div>';
    }).join('');

    els.foot.innerHTML =
      '<div class="wc-cart-subtotal-row">' +
        '<span class="wc-cart-subtotal-label">Subtotal</span>' +
        '<span class="wc-cart-subtotal-value">' + money(subtotal) + '</span>' +
      '</div>' +
      '<div class="wc-cart-shipping">' +
        '<div class="wc-cart-shipping-row">' +
          '<label class="wc-cart-shipping-label" for="wcShipCountry">Ship to</label>' +
          '<select class="wc-cart-shipping-select" id="wcShipCountry">' + countryOptions + '</select>' +
        '</div>' +
        '<div class="wc-cart-shipping-row">' +
          '<span class="wc-cart-shipping-label">' + escapeHtml(shipDisplay.lines[0].name) + '</span>' +
          '<span class="wc-cart-shipping-value">' + (defaultShipping === 0 ? 'Free' : money(defaultShipping)) + '</span>' +
        '</div>' +
        extraShippingLines +
      '</div>' +
      '<div class="wc-cart-subtotal-row wc-cart-estimate-row">' +
        '<span class="wc-cart-subtotal-label">Estimated total</span>' +
        '<span class="wc-cart-subtotal-value">' + money(estimatedTotal) + '</span>' +
      '</div>' +
      '<p class="wc-cart-note">' + note + ' Final shipping &amp; taxes calculated at checkout.</p>' +
      blockedNote +
      '<button type="button" class="wc-cart-checkout" id="wcCartCheckout"' + (hasSoldOutLine ? ' disabled' : '') + '>' +
        '<svg class="wc-cart-checkout__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
        '<span class="wc-cart-checkout__label">Checkout</span>' +
      '</button>' +
      '<p class="wc-cart-checkout-status" id="wcCartCheckoutStatus" role="status" aria-live="polite"></p>';

    var checkoutBtn = document.getElementById('wcCartCheckout');
    var statusEl = document.getElementById('wcCartCheckoutStatus');
    var labelEl = checkoutBtn ? checkoutBtn.querySelector('.wc-cart-checkout__label') : null;

    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', function () {
        if (cart.length === 0 || hasSoldOutLine) return;

        checkoutBtn.classList.add('is-loading');
        checkoutBtn.disabled = true;
        if (labelEl) labelEl.textContent = 'Preparing checkout…';
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.classList.remove('is-visible');
        }

        fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: buildCheckoutRequestItems(), shippingCountry: shipCountry })
        })
          .then(function (res) {
            return res.json()
              .catch(function () { return {}; })
              .then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (result) {
            if (result.ok && result.data && result.data.url) {
              if (labelEl) labelEl.textContent = 'Redirecting…';
              window.location.href = result.data.url;
              return;
            }
            throw new Error((result.data && result.data.error) || 'Checkout failed.');
          })
          .catch(function (err) {
            checkoutBtn.classList.remove('is-loading');
            checkoutBtn.disabled = false;
            if (labelEl) labelEl.textContent = 'Checkout';
            if (statusEl) {
              statusEl.textContent = 'Checkout failed: ' + err.message + ' Please try again.';
              requestAnimationFrame(function () {
                requestAnimationFrame(function () { statusEl.classList.add('is-visible'); });
              });
            }
          });
      });
    }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function colorLabelFromId(id) {
    return id.replace(/-.*$/, '');
  }

  function shopLinkHref() {
    // Works whether this page lives at the site root or not — all pages
    // are flat siblings in this project.
    return 'shop.html';
  }

  /* ---------------- open / close ---------------- */

  function openCart() {
    injectDrawer();
    renderLines();
    updateSummary();
    els.overlay.classList.add('is-open');
    els.drawer.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    els.closeBtn.focus();
  }

  function closeCart() {
    if (!els.drawer) return;
    els.overlay.classList.remove('is-open');
    els.drawer.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  /* ---------------- header badge(s) ---------------- */

  function updateAllBadges() {
    var count = getCount();
    var badges = document.querySelectorAll('#cartCount, [data-cart-count]');
    badges.forEach(function (badge) {
      var changed = badge.textContent !== String(count);
      badge.textContent = String(count);
      badge.style.display = count > 0 ? 'flex' : 'none';
      if (changed && count > 0) restartAnimation(badge, 'is-popping');
    });
  }

  /* ---------------- syncing the existing "Add to Hand" buttons ---------------- */

  function readProductFromButton(btn) {
    var id = btn.getAttribute('data-id');
    if (!id) return null;
    var price = parseFloat(btn.getAttribute('data-price'));
    return {
      id: id,
      name: btn.getAttribute('data-name') || id,
      price: isNaN(price) ? 0 : price,
      image: btn.getAttribute('data-image') || '',
      color: btn.getAttribute('data-color') || null,
      size: btn.getAttribute('data-size') || null
    };
  }

  function syncHandButtons() {
    var buttons = document.querySelectorAll('.btn--hand[data-id]');
    buttons.forEach(function (btn) {
      // Capture the page's own default label exactly once, before this
      // module ever rewrites it, so the original copy is preserved.
      if (!btn.hasAttribute('data-label-default')) {
        btn.setAttribute('data-label-default', btn.textContent.trim());
      }
      var id = btn.getAttribute('data-id');
      var line = findLine(id);
      var defaultLabel = btn.getAttribute('data-label-default');
      var soldOut = stockForLabel(id) <= 0;

      btn.classList.toggle('is-added', !!line && !soldOut);
      btn.classList.toggle('is-soldout', soldOut);
      btn.disabled = soldOut;

      // Buttons never remove the line — they only add/increment. The label
      // reflects how many are already in the hand so repeat clicks read as
      // "increasing quantity" rather than a duplicate, unrelated line item.
      btn.textContent = soldOut
        ? 'Sold Out'
        : (line ? 'In Hand ✓' + (line.qty > 1 ? ' ×' + line.qty : '') : defaultLabel);

      // Mirror the sold-out state onto the enclosing card/tile so its own
      // CSS (a grayscale image + "SOLD OUT" ribbon) can key off it.
      var card = btn.closest('.deck__tile, .pick__card');
      if (card) card.classList.toggle('is-soldout', soldOut);
    });
  }

  function bindHandButtons() {
    // Delegated at the document level so it also picks up buttons rendered
    // dynamically after this script runs, and always fires after any
    // page-local click handler on the same button (document is reached
    // last during bubbling).
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn--hand[data-id]');
      if (!btn || btn.disabled) return;
      var product = readProductFromButton(btn);
      if (!product) return;

      // Always add — an existing line just gets its quantity increased
      // (see addItem) instead of a duplicate entry being created. Removal
      // only happens explicitly, from the cart drawer.
      addItem(product, 1);
      restartAnimation(btn, 'is-popping');
    });
  }

  // Restarts a CSS animation on `el` by toggling `cls` off and back on,
  // using a double rAF so the re-add lands after the next style/layout
  // pass instead of forcing a synchronous layout via offsetWidth.
  function restartAnimation(el, cls) {
    el.classList.remove(cls);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add(cls);
      });
    });
  }

  /* ---------------- cart icon wiring ---------------- */

  function bindCartIcon() {
    var icon = document.getElementById('cartBtn');
    if (icon) {
      icon.addEventListener('click', function (e) {
        e.preventDefault();
        openCart();
      });
    }
    // Support any other elements that opt in explicitly.
    document.querySelectorAll('[data-cart-open]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        openCart();
      });
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    injectStyles();
    bindCartIcon();
    bindHandButtons();
    updateAllBadges();
    syncHandButtons();
    loadStock();
    ensureShippingRates(shipCountry);

    // Keep every open tab/page in sync: if the cart changes in another tab
    // (or another page of this site) localStorage fires a 'storage' event
    // here, so we reload from disk and re-render immediately.
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      cart = loadCart();
      renderLines();
      updateSummary();
      updateAllBadges();
      syncHandButtons();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Small public API in case other inline scripts on the page want it.
  window.WildcardCart = {
    add: addItem,
    remove: removeItem,
    setQty: setQty,
    clear: clearCart,
    open: openCart,
    close: closeCart,
    getCount: getCount,
    getQty: getQty,
    getSubtotal: getSubtotal,
    getCheckoutPayload: buildCheckoutPayload,
    getStockForSku: stockForSku,
    getStockForLabel: stockForLabel
  };
})();
