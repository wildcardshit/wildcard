/* ==========================================================================
   WILDCARD — Admin dashboard client logic
   Talks to /api/admin/* (see functions/api/admin/*.js). Every request
   below relies on the wc_admin_session cookie already being present and
   valid — if it isn't, functions/api/admin/_middleware.js returns a 401
   and this file sends the browser back to the login page.
   ========================================================================== */

(function () {
  'use strict';

  // Mirrors functions/_catalog.js's PRODUCTS + SIZES for display purposes
  // only (label, swatch color, motto). Nothing security-sensitive here —
  // if a colorway is ever added, update it here and in _catalog.js.
  var PRODUCTS = {
    BLACK: { motto: 'PLAY YOUR CARDS RIGHT', hex: '#16140F' },
    RED: { motto: 'FACE YOUR FEARS', hex: '#D62828' },
    BLUE: { motto: 'IGNORE THE NOISE', hex: '#2456C7' },
    GREEN: { motto: 'GROW THROUGH WHAT YOU GO THROUGH', hex: '#2F6F4E' },
    YELLOW: { motto: 'TRUST THE PROCESS', hex: '#E8B92F' }
  };
  var SIZES = ['S', 'M', 'L', 'XL'];
  var LOW_STOCK_THRESHOLD = 5;

  var state = {
    orders: { search: '', status: 'all' },
    customers: { search: '' }
  };

  /* ---------------- helpers ---------------- */

  function el(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatMoney(cents, currency) {
    if (typeof cents !== 'number') return '—';
    var amount = (cents / 100).toFixed(2);
    var symbol = (currency || 'usd').toUpperCase() === 'USD' ? '$' : (currency || '').toUpperCase() + ' ';
    return symbol + amount;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  var toastTimer;
  function showToast(message, isError) {
    var t = el('toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function api(path, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = Object.assign({}, options.headers);
    if (options.body && !options.headers['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, options).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin-login.html';
        return Promise.reject(new Error('Not authenticated'));
      }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || 'Request failed.');
        return data;
      });
    });
  }

  /* ---------------- tabs ---------------- */

  function initTabs() {
    var tabs = document.querySelectorAll('.tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        el('panel-' + tab.dataset.tab).classList.add('active');
      });
    });
  }

  /* ---------------- who am I / logout ---------------- */

  function loadWhoAmI() {
    api('/api/admin/whoami').then(function (data) {
      el('whoUser').textContent = data.username || 'admin';
    }).catch(function () { /* redirect already handled in api() on 401 */ });
  }

  function initLogout() {
    el('logoutBtn').addEventListener('click', function () {
      api('/api/admin/logout', { method: 'POST' }).then(function () {
        window.location.href = '/admin-login.html';
      }).catch(function () {
        window.location.href = '/admin-login.html';
      });
    });
  }

  /* ---------------- orders ---------------- */

  function loadOrders() {
    var tbody = el('ordersBody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading orders…</td></tr>';

    var params = new URLSearchParams();
    if (state.orders.status !== 'all') params.set('status', state.orders.status);
    if (state.orders.search) params.set('q', state.orders.search);
    params.set('limit', '100');

    api('/api/admin/orders?' + params.toString()).then(function (data) {
      renderOrders(data.orders || []);
      el('orderCount').textContent = data.total + (data.total === 1 ? ' order' : ' orders');
    }).catch(function (err) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Could not load orders: ' + escapeHtml(err.message) + '</td></tr>';
    });
  }

  function renderOrders(orders) {
    var tbody = el('ordersBody');
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No orders match.</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map(function (o) {
      var fulfilled = o.fulfillment && o.fulfillment.fulfilled;
      var itemsHtml = (o.items || []).map(function (it) {
        return '<div>' + (it.quantity || 1) + '× ' + escapeHtml(it.name || it.productId || 'Item') +
          (it.size ? ' (' + escapeHtml(it.size) + ')' : '') + '</div>';
      }).join('');

      var custName = escapeHtml((o.customer && o.customer.name) || '—');
      var custEmail = escapeHtml((o.customer && o.customer.email) || '');

      var statusBadge = fulfilled
        ? '<span class="badge badge--shipped">Shipped</span>'
        : '<span class="badge badge--pending">Pending</span>';

      var trackingNote = fulfilled && o.fulfillment.trackingNumber
        ? '<div class="items-list">' + escapeHtml(o.fulfillment.carrier || 'Tracking') + ': ' + escapeHtml(o.fulfillment.trackingNumber) + '</div>'
        : '';

      var actionHtml = fulfilled
        ? '<button class="btn" data-action="unship" data-order="' + escapeHtml(o.orderId) + '">Mark Unshipped</button>'
        : '<button class="btn btn--primary" data-action="ship-toggle" data-order="' + escapeHtml(o.orderId) + '">Mark Shipped</button>' +
          '<div class="fulfill-row" id="fulfill-' + escapeHtml(o.orderId) + '" hidden>' +
            '<input type="text" placeholder="Carrier" data-field="carrier" data-order="' + escapeHtml(o.orderId) + '">' +
            '<input type="text" placeholder="Tracking #" data-field="tracking" data-order="' + escapeHtml(o.orderId) + '">' +
            '<button class="btn btn--primary" data-action="ship-confirm" data-order="' + escapeHtml(o.orderId) + '">Confirm</button>' +
          '</div>';

      return (
        '<tr class="order-row">' +
        '<td><mono>' + escapeHtml(o.orderId ? o.orderId.slice(-10) : '—') + '</mono></td>' +
        '<td>' + formatDate(o.createdAt) + '</td>' +
        '<td>' + custName + '<br><span class="items-list">' + custEmail + '</span></td>' +
        '<td><div class="items-list">' + itemsHtml + '</div></td>' +
        '<td><mono>' + formatMoney(o.amountTotal, o.currency) + '</mono></td>' +
        '<td>' + statusBadge + trackingNote + '</td>' +
        '<td>' + actionHtml + '</td>' +
        '</tr>'
      );
    }).join('');

    tbody.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', handleOrderAction);
    });
  }

  function handleOrderAction(e) {
    var btn = e.currentTarget;
    var action = btn.dataset.action;
    var orderId = btn.dataset.order;

    if (action === 'ship-toggle') {
      var row = el('fulfill-' + orderId);
      if (row) row.hidden = !row.hidden;
      return;
    }

    if (action === 'ship-confirm') {
      var carrierInput = document.querySelector('[data-field="carrier"][data-order="' + cssEscape(orderId) + '"]');
      var trackingInput = document.querySelector('[data-field="tracking"][data-order="' + cssEscape(orderId) + '"]');
      setOrderFulfillment(orderId, true, carrierInput ? carrierInput.value : '', trackingInput ? trackingInput.value : '');
      return;
    }

    if (action === 'unship') {
      setOrderFulfillment(orderId, false, '', '');
    }
  }

  // Minimal CSS.escape polyfill for the attribute selectors above — order
  // ids are Stripe session ids (alphanumeric + underscores) so this is a
  // narrow, safe substitute rather than a general implementation.
  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function setOrderFulfillment(orderId, fulfilled, carrier, trackingNumber) {
    api('/api/admin/orders', {
      method: 'PATCH',
      body: JSON.stringify({
        orderId: orderId,
        fulfilled: fulfilled,
        carrier: carrier || undefined,
        trackingNumber: trackingNumber || undefined
      })
    }).then(function () {
      showToast(fulfilled ? 'Order marked as shipped.' : 'Order marked as unshipped.');
      loadOrders();
    }).catch(function (err) {
      showToast('Could not update order: ' + err.message, true);
    });
  }

  function initOrdersToolbar() {
    el('orderSearch').addEventListener('input', debounce(function (e) {
      state.orders.search = e.target.value.trim();
      loadOrders();
    }, 300));
    el('orderStatus').addEventListener('change', function (e) {
      state.orders.status = e.target.value;
      loadOrders();
    });
  }

  /* ---------------- inventory ---------------- */

  function loadInventory() {
    var grid = el('stockGrid');
    grid.innerHTML = '<div class="loading">Loading inventory…</div>';

    api('/api/admin/inventory').then(function (data) {
      renderInventory(data.stock || {});
    }).catch(function (err) {
      grid.innerHTML = '<div class="empty">Could not load inventory: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderInventory(stock) {
    var grid = el('stockGrid');
    var labels = Object.keys(PRODUCTS);

    grid.innerHTML = labels.map(function (label) {
      var product = PRODUCTS[label];
      var rows = SIZES.map(function (size) {
        var key = label + '-' + size;
        var qty = typeof stock[key] === 'number' ? stock[key] : 0;
        var badge = qty === 0
          ? '<span class="badge badge--low">Out</span>'
          : (qty <= LOW_STOCK_THRESHOLD ? '<span class="badge badge--low">Low</span>' : '<span class="badge badge--ok">' + qty + '</span>');

        return (
          '<div class="stock-row">' +
          '<label>' + size + '</label>' +
          '<div class="edit">' +
          badge +
          '<input type="number" min="0" step="1" value="' + qty + '" data-label="' + label + '" data-size="' + size + '">' +
          '<button class="btn save" data-action="save-stock" data-label="' + label + '" data-size="' + size + '">Save</button>' +
          '</div>' +
          '</div>'
        );
      }).join('');

      return (
        '<div class="stock-card">' +
        '<h3><span class="swatch" style="background:' + product.hex + '"></span>' + escapeHtml(label) + '</h3>' +
        rows +
        '</div>'
      );
    }).join('');

    grid.querySelectorAll('[data-action="save-stock"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = btn.dataset.label;
        var size = btn.dataset.size;
        var input = grid.querySelector('input[data-label="' + label + '"][data-size="' + size + '"]');
        var stock = parseInt(input.value, 10);
        if (!Number.isFinite(stock) || stock < 0) {
          showToast('Stock must be a non-negative whole number.', true);
          return;
        }
        btn.disabled = true;
        api('/api/admin/inventory', {
          method: 'PUT',
          body: JSON.stringify({ label: label, size: size, stock: stock })
        }).then(function () {
          showToast(label + ' ' + size + ' stock updated to ' + stock + '.');
          loadInventory();
        }).catch(function (err) {
          showToast('Could not update stock: ' + err.message, true);
          btn.disabled = false;
        });
      });
    });
  }

  /* ---------------- customers ---------------- */

  function loadCustomers() {
    var tbody = el('customersBody');
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading customers…</td></tr>';

    var params = new URLSearchParams();
    if (state.customers.search) params.set('q', state.customers.search);

    api('/api/admin/customers?' + params.toString()).then(function (data) {
      renderCustomers(data.customers || []);
      el('customerCount').textContent = data.customers.length + (data.customers.length === 1 ? ' customer' : ' customers');
    }).catch(function (err) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Could not load customers: ' + escapeHtml(err.message) + '</td></tr>';
    });
  }

  function renderCustomers(customers) {
    var tbody = el('customersBody');
    if (!customers.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No customers match.</td></tr>';
      return;
    }

    tbody.innerHTML = customers.map(function (c) {
      var addr = c.shippingAddress;
      var addrHtml = addr
        ? '<address>' + [addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(', '), addr.country]
            .filter(Boolean).map(escapeHtml).join('<br>') + '</address>'
        : '<span class="items-list">—</span>';

      return (
        '<tr>' +
        '<td>' + escapeHtml(c.name || '—') + '<br><span class="items-list">' + escapeHtml(c.email) + (c.phone ? ' · ' + escapeHtml(c.phone) : '') + '</span></td>' +
        '<td>' + addrHtml + '</td>' +
        '<td>' + c.orderCount + '</td>' +
        '<td><mono>' + formatMoney(c.totalSpent, c.currency) + '</mono></td>' +
        '<td>' + formatDate(c.lastOrderAt) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function initCustomersToolbar() {
    el('customerSearch').addEventListener('input', debounce(function (e) {
      state.customers.search = e.target.value.trim();
      loadCustomers();
    }, 300));
  }

  /* ---------------- boot ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    initTabs();
    initLogout();
    initOrdersToolbar();
    initCustomersToolbar();
    loadWhoAmI();
    loadOrders();
    loadInventory();
    loadCustomers();
  });
})();
