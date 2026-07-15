/*!
 * WILDCARD — shared cart drawer
 * Handles cart state (persisted to localStorage + synced across tabs),
 * injects the slide-out drawer UI, and wires up any #cartBtn / #cartCount
 * elements already present on the page. Include on any page with:
 *   <script src="js/cart.js"></script>
 * Other inline page scripts can push real items into the cart via:
 *   window.WildcardCart.add({ id, name, color, hex, size, price, img, qty })
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'wildcard_cart_v1';
  var listeners = [];

  // ---------- state ----------
  function readCart() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function writeCart(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (err) { /* storage unavailable — cart just won't persist */ }
    notify(items);
  }

  function notify(items) {
    listeners.forEach(function (fn) {
      try { fn(items); } catch (err) {}
    });
  }

  function lineKey(item) {
    return [item.id, item.size || ''].join('::');
  }

  function add(item) {
    var items = readCart();
    var key = lineKey(item);
    var qty = item.qty || 1;
    var existing = items.find(function (i) { return lineKey(i) === key; });
    if (existing) {
      existing.qty += qty;
    } else {
      items.push({
        id: item.id,
        name: item.name || item.id,
        color: item.color || null,
        hex: item.hex || null,
        size: item.size || null,
        price: Number(item.price) || 0,
        img: item.img || '',
        qty: qty
      });
    }
    writeCart(items);
    return key;
  }

  function remove(key) {
    var items = readCart().filter(function (i) { return lineKey(i) !== key; });
    writeCart(items);
  }

  function setQty(key, qty) {
    var items = readCart();
    var line = items.find(function (i) { return lineKey(i) === key; });
    if (!line) return;
    if (qty <= 0) {
      items = items.filter(function (i) { return lineKey(i) !== key; });
    } else {
      line.qty = qty;
    }
    writeCart(items);
  }

  function has(id, size) {
    return readCart().some(function (i) { return i.id === id && (i.size || null) === (size || null); });
  }

  function clear() {
    writeCart([]);
  }

  function count(items) {
    return (items || readCart()).reduce(function (sum, i) { return sum + i.qty; }, 0);
  }

  function subtotal(items) {
    return (items || readCart()).reduce(function (sum, i) { return sum + i.qty * i.price; }, 0);
  }

  // Cross-tab sync
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) notify(readCart());
  });

  // ---------- UI ----------
  var CSS = '\
#wcCartOverlay{position:fixed;inset:0;background:rgba(22,20,15,0.45);\
  opacity:0;pointer-events:none;transition:opacity .45s cubic-bezier(.16,1,.3,1);z-index:100000;}\
#wcCartOverlay.is-open{opacity:1;pointer-events:auto;}\
#wcCartDrawer{position:fixed;top:0;right:0;height:100%;width:min(420px,92vw);\
  background:var(--paper,#fff);color:var(--ink,#16140F);z-index:100001;\
  display:flex;flex-direction:column;box-shadow:-24px 0 60px rgba(0,0,0,0.25);\
  transform:translateX(100%);transition:transform .5s cubic-bezier(.16,1,.3,1);\
  font-family:var(--font-body,sans-serif);}\
#wcCartDrawer.is-open{transform:translateX(0);}\
.wc-cart__head{display:flex;align-items:center;justify-content:space-between;\
  padding:22px 22px 18px;border-bottom:1px solid rgba(22,20,15,0.1);flex:0 0 auto;}\
.wc-cart__title{font-family:var(--font-display,sans-serif);font-size:1.3rem;\
  letter-spacing:0.02em;margin:0;display:flex;align-items:center;gap:8px;}\
.wc-cart__title .wc-suit{color:var(--wild-red,#EB181D);}\
.wc-cart__close{background:none;border:none;cursor:pointer;color:var(--ink,#16140F);\
  width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;\
  transition:background .2s ease,color .2s ease,transform .2s ease;flex:0 0 auto;}\
.wc-cart__close:hover{background:rgba(22,20,15,0.06);color:var(--wild-red,#EB181D);}\
.wc-cart__close:active{transform:scale(0.9);}\
.wc-cart__body{flex:1 1 auto;overflow-y:auto;padding:10px 22px;}\
.wc-cart__empty{display:flex;flex-direction:column;align-items:center;justify-content:center;\
  text-align:center;gap:14px;height:100%;padding:40px 10px;color:#6b6657;}\
.wc-cart__empty-suit{font-size:2.4rem;color:rgba(22,20,15,0.15);}\
.wc-cart__empty p{margin:0;font-size:0.92rem;}\
.wc-cart__empty a{font-family:var(--font-mono,monospace);font-size:0.78rem;font-weight:700;\
  text-decoration:none;color:var(--ink,#16140F);border:1.5px solid var(--ink,#16140F);\
  padding:10px 18px;border-radius:999px;letter-spacing:0.04em;text-transform:uppercase;\
  transition:background .2s ease,color .2s ease;}\
.wc-cart__empty a:hover{background:var(--ink,#16140F);color:var(--paper,#fff);}\
.wc-cart__line{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid rgba(22,20,15,0.08);}\
.wc-cart__thumb{width:72px;height:72px;border-radius:14px;background:var(--paper-dim,#F0F0F0);\
  flex:0 0 auto;overflow:hidden;display:flex;align-items:center;justify-content:center;}\
.wc-cart__thumb img{width:100%;height:100%;object-fit:cover;}\
.wc-cart__info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}\
.wc-cart__name{font-weight:700;font-size:0.88rem;margin:0;line-height:1.25;}\
.wc-cart__meta{font-family:var(--font-mono,monospace);font-size:0.72rem;color:#6b6657;\
  display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:0.03em;}\
.wc-cart__meta .wc-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto;}\
.wc-cart__row{display:flex;align-items:center;justify-content:space-between;margin-top:4px;gap:8px;}\
.wc-cart__qty{display:flex;align-items:center;border:1.5px solid rgba(22,20,15,0.15);\
  border-radius:999px;overflow:hidden;}\
.wc-cart__qty button{width:26px;height:26px;border:none;background:none;cursor:pointer;\
  font-family:var(--font-mono,monospace);font-size:0.85rem;color:var(--ink,#16140F);\
  display:flex;align-items:center;justify-content:center;transition:background .2s ease;}\
.wc-cart__qty button:hover{background:rgba(22,20,15,0.06);}\
.wc-cart__qty span{min-width:22px;text-align:center;font-family:var(--font-mono,monospace);font-size:0.8rem;}\
.wc-cart__price{font-family:var(--font-mono,monospace);font-weight:700;font-size:0.85rem;flex:0 0 auto;}\
.wc-cart__remove{background:none;border:none;cursor:pointer;color:#948f7d;font-size:0.7rem;\
  font-family:var(--font-mono,monospace);text-decoration:underline;padding:0;letter-spacing:0.03em;\
  text-transform:uppercase;}\
.wc-cart__remove:hover{color:var(--wild-red,#EB181D);}\
.wc-cart__foot{flex:0 0 auto;padding:18px 22px 24px;border-top:1px solid rgba(22,20,15,0.1);}\
.wc-cart__subtotal{display:flex;align-items:center;justify-content:space-between;\
  font-family:var(--font-mono,monospace);font-size:0.9rem;font-weight:700;margin-bottom:14px;}\
.wc-cart__checkout{display:block;width:100%;text-align:center;background:var(--ink,#16140F);\
  color:var(--paper,#fff);border:none;border-radius:999px;padding:15px 20px;font-weight:700;\
  font-size:0.85rem;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;\
  transition:background .2s ease,transform .2s ease;font-family:var(--font-body,sans-serif);}\
.wc-cart__checkout:hover{background:var(--wild-red,#EB181D);}\
.wc-cart__checkout:active{transform:scale(0.98);}\
.wc-cart__checkout:disabled{opacity:0.6;cursor:default;pointer-events:none;}\
.wc-cart__note{margin:10px 0 0;font-size:0.7rem;color:#948f7d;text-align:center;}\
.wc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);\
  background:var(--ink,#16140F);color:var(--paper,#fff);padding:12px 20px;border-radius:999px;\
  font-family:var(--font-mono,monospace);font-size:0.78rem;letter-spacing:0.02em;\
  opacity:0;pointer-events:none;transition:opacity .3s ease,transform .3s ease;z-index:100002;\
  white-space:nowrap;}\
.wc-toast.is-visible{opacity:1;transform:translateX(-50%) translateY(0);}\
@media (max-width:480px){\
  .wc-cart__head{padding:18px 16px 14px;}\
  .wc-cart__body{padding:8px 16px;}\
  .wc-cart__foot{padding:14px 16px 20px;}\
}\
@media (prefers-reduced-motion: reduce){\
  #wcCartOverlay,#wcCartDrawer,.wc-toast{transition:none;}\
}';

  function injectStyles() {
    if (document.getElementById('wcCartStyles')) return;
    var style = document.createElement('style');
    style.id = 'wcCartStyles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function injectDrawer() {
    if (document.getElementById('wcCartDrawer')) return;

    var overlay = document.createElement('div');
    overlay.id = 'wcCartOverlay';

    var drawer = document.createElement('aside');
    drawer.id = 'wcCartDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Shopping cart');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML =
      '<div class="wc-cart__head">' +
        '<h2 class="wc-cart__title"><span class="wc-suit">&#9827;</span> Your Hand</h2>' +
        '<button type="button" class="wc-cart__close" id="wcCartClose" aria-label="Close cart">' +
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M1 1L15 15M15 1L1 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      '<div class="wc-cart__body" id="wcCartBody"></div>' +
      '<div class="wc-cart__foot" id="wcCartFoot"></div>';

    var toast = document.createElement('div');
    toast.className = 'wc-toast';
    toast.id = 'wcCartToast';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    document.body.appendChild(toast);

    overlay.addEventListener('click', close);
    document.getElementById('wcCartClose').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
    });
  }

  var toastTimer = null;
  function showToast(msg) {
    var toast = document.getElementById('wcCartToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, 2200);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    var items = readCart();
    var body = document.getElementById('wcCartBody');
    var foot = document.getElementById('wcCartFoot');
    if (!body || !foot) return;

    if (!items.length) {
      body.innerHTML =
        '<div class="wc-cart__empty">' +
          '<span class="wc-cart__empty-suit">&#9824;</span>' +
          '<p>Your hand is empty.<br>Time to pick a card.</p>' +
          '<a href="home.html#shop">Browse Colorways</a>' +
        '</div>';
      foot.innerHTML = '';
      updateBadges(items);
      return;
    }

    body.innerHTML = items.map(function (item) {
      var key = lineKey(item);
      var metaBits = [];
      if (item.color) metaBits.push(escapeHtml(item.color));
      if (item.size) metaBits.push('SIZE ' + escapeHtml(item.size));
      return (
        '<div class="wc-cart__line" data-key="' + escapeHtml(key) + '">' +
          '<div class="wc-cart__thumb">' + (item.img ? '<img src="' + escapeHtml(item.img) + '" alt="' + escapeHtml(item.name) + '">' : '') + '</div>' +
          '<div class="wc-cart__info">' +
            '<p class="wc-cart__name">' + escapeHtml(item.name) + '</p>' +
            '<span class="wc-cart__meta">' +
              (item.hex ? '<span class="wc-dot" style="background:' + escapeHtml(item.hex) + '"></span>' : '') +
              metaBits.join(' · ') +
            '</span>' +
            '<div class="wc-cart__row">' +
              '<div class="wc-cart__qty">' +
                '<button type="button" class="wc-qty-minus" aria-label="Decrease quantity">&minus;</button>' +
                '<span>' + item.qty + '</span>' +
                '<button type="button" class="wc-qty-plus" aria-label="Increase quantity">+</button>' +
              '</div>' +
              '<span class="wc-cart__price">$' + (item.price * item.qty).toFixed(0) + '</span>' +
            '</div>' +
            '<button type="button" class="wc-cart__remove">Remove</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    foot.innerHTML =
      '<div class="wc-cart__subtotal"><span>Subtotal</span><span>$' + subtotal(items).toFixed(0) + '</span></div>' +
      '<button type="button" class="wc-cart__checkout" id="wcCheckoutBtn"' + (checkoutInFlight ? ' disabled' : '') + '>' +
        (checkoutInFlight ? 'Redirecting…' : 'Checkout') +
      '</button>' +
      '<p class="wc-cart__note">Shipping &amp; taxes calculated at checkout.</p>';

    body.querySelectorAll('.wc-cart__line').forEach(function (line) {
      var key = line.getAttribute('data-key');
      line.querySelector('.wc-qty-minus').addEventListener('click', function () {
        var it = readCart().find(function (i) { return lineKey(i) === key; });
        if (it) setQty(key, it.qty - 1);
      });
      line.querySelector('.wc-qty-plus').addEventListener('click', function () {
        var it = readCart().find(function (i) { return lineKey(i) === key; });
        if (it) setQty(key, it.qty + 1);
      });
      line.querySelector('.wc-cart__remove').addEventListener('click', function () {
        remove(key);
        showToast('Removed from your hand');
      });
    });

    var checkoutBtn = document.getElementById('wcCheckoutBtn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', function () {
        startCheckout(checkoutBtn);
      });
    }

    updateBadges(items);
  }

  var CHECKOUT_ENDPOINT = '/api/create-checkout-session';
  // Tracks an in-flight checkout across re-renders (e.g. cross-tab cart
  // sync, or a qty change while the request is pending) so the button
  // can't come back enabled and let someone fire a duplicate request.
  var checkoutInFlight = false;

  function startCheckout(btn) {
    if (checkoutInFlight) return;

    var cartItems = readCart();
    if (!cartItems.length) return;

    checkoutInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Redirecting…';

    var payload = {
      items: cartItems.map(function (item) {
        return { id: item.id, size: item.size, qty: item.qty };
      })
    };

    fetch(CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data || !data.url) {
            throw new Error((data && data.error) || 'Could not start checkout.');
          }
          return data;
        });
      })
      .then(function (data) {
        window.location.href = data.url;
      })
      .catch(function (err) {
        checkoutInFlight = false;
        // The button may have been replaced by a re-render while the
        // request was in flight — re-query it rather than trust the
        // stale reference, and only touch it if it still exists.
        var currentBtn = document.getElementById('wcCheckoutBtn');
        if (currentBtn) {
          currentBtn.disabled = false;
          currentBtn.textContent = 'Checkout';
        }
        showToast(err.message || "Checkout failed — please try again.");
      });
  }

  function updateBadges(items) {
    var n = count(items);
    document.querySelectorAll('#cartCount, .cart-count').forEach(function (el) {
      el.textContent = String(n);
      el.style.display = n > 0 ? 'flex' : 'none';
      if (n > 0) {
        el.classList.remove('is-popping');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { el.classList.add('is-popping'); });
        });
      } else {
        el.classList.remove('is-popping');
      }
    });
  }

  function open() {
    var overlay = document.getElementById('wcCartOverlay');
    var drawer = document.getElementById('wcCartDrawer');
    if (!overlay || !drawer) return;
    render();
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    var overlay = document.getElementById('wcCartOverlay');
    var drawer = document.getElementById('wcCartDrawer');
    if (!overlay || !drawer) return;
    overlay.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function toggle() {
    var drawer = document.getElementById('wcCartDrawer');
    if (drawer && drawer.classList.contains('is-open')) close();
    else open();
  }

  function wireCartButtons() {
    document.querySelectorAll('#cartBtn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        toggle();
      });
    });
  }

  function init() {
    injectStyles();
    injectDrawer();
    wireCartButtons();
    listeners.push(function () { render(); });
    updateBadges(readCart());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.WildcardCart = {
    add: add,
    remove: remove,
    setQty: setQty,
    has: has,
    clear: clear,
    getItems: readCart,
    getCount: function () { return count(); },
    getSubtotal: function () { return subtotal(); },
    open: open,
    close: close,
    toggle: toggle,
    toast: showToast,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
