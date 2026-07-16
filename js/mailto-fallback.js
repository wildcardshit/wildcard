/**
 * Mailto fallback for desktop.
 *
 * mailto: links work fine on mobile (there's always a Mail app registered),
 * but a lot of desktop users don't have a desktop mail client configured,
 * so clicking a mailto: link silently does nothing.
 *
 * This script leaves the normal mailto: behavior in place (so it still
 * works for anyone who *does* have a mail client), but also detects when
 * the click didn't actually hand off to another app, and in that case
 * shows a small menu with "copy address", "Gmail" and "Outlook" options.
 */
(function () {
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function parseMailto(href) {
    var raw = href.replace(/^mailto:/i, '');
    var q = raw.split('?');
    return { address: decodeURIComponent(q[0] || '') };
  }

  function closeMenu() {
    var existing = document.querySelector('.mailto-fallback-menu');
    if (existing) existing.remove();
    document.removeEventListener('click', outsideClickHandler, true);
  }

  function outsideClickHandler(e) {
    var menu = document.querySelector('.mailto-fallback-menu');
    if (menu && !menu.contains(e.target)) closeMenu();
  }

  function ensureStyles() {
    if (document.getElementById('mailto-fallback-styles')) return;
    var style = document.createElement('style');
    style.id = 'mailto-fallback-styles';
    style.textContent =
      '.mailto-fallback-menu{position:fixed;z-index:9999;min-width:220px;' +
      'background:var(--ink,#16140F);color:var(--paper,#FFF);border-radius:12px;' +
      'box-shadow:0 12px 32px rgba(0,0,0,0.35);padding:8px;font-family:var(--font-body,Arial,sans-serif);' +
      'font-size:14px;border:1px solid rgba(255,255,255,0.12);}' +
      '.mailto-fallback-menu__label{padding:8px 10px 4px;font-size:12px;opacity:0.65;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.mailto-fallback-menu button,.mailto-fallback-menu a{display:block;width:100%;text-align:left;' +
      'background:none;border:none;color:inherit;padding:9px 10px;border-radius:8px;cursor:pointer;' +
      'font:inherit;text-decoration:none;box-sizing:border-box;}' +
      '.mailto-fallback-menu button:hover,.mailto-fallback-menu a:hover{background:rgba(255,255,255,0.1);color:var(--wild-red,#EB181D);}' +
      '.mailto-fallback-menu__copied{color:var(--wild-red,#EB181D);}';
    document.head.appendChild(style);
  }

  function showFallbackMenu(link, address) {
    closeMenu();
    ensureStyles();

    var rect = link.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.className = 'mailto-fallback-menu';
    menu.setAttribute('role', 'menu');

    var label = document.createElement('div');
    label.className = 'mailto-fallback-menu__label';
    label.textContent = 'No mail app opened \u2014 try:';
    menu.appendChild(label);

    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy ' + address;
    copyBtn.addEventListener('click', function () {
      var done = function () {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('mailto-fallback-menu__copied');
        setTimeout(closeMenu, 900);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(done, done);
      } else {
        var tmp = document.createElement('textarea');
        tmp.value = address;
        tmp.style.position = 'fixed';
        tmp.style.opacity = '0';
        document.body.appendChild(tmp);
        tmp.select();
        try { document.execCommand('copy'); } catch (err) {}
        document.body.removeChild(tmp);
        done();
      }
    });
    menu.appendChild(copyBtn);

    var gmail = document.createElement('a');
    gmail.href = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(address);
    gmail.target = '_blank';
    gmail.rel = 'noopener';
    gmail.textContent = 'Open in Gmail';
    gmail.addEventListener('click', closeMenu);
    menu.appendChild(gmail);

    var outlook = document.createElement('a');
    outlook.href = 'https://outlook.office.com/mail/deeplink/compose?to=' + encodeURIComponent(address);
    outlook.target = '_blank';
    outlook.rel = 'noopener';
    outlook.textContent = 'Open in Outlook';
    outlook.addEventListener('click', closeMenu);
    menu.appendChild(outlook);

    document.body.appendChild(menu);

    var menuRect = menu.getBoundingClientRect();
    var top = rect.bottom + 8;
    var left = rect.left;
    if (left + menuRect.width > window.innerWidth - 12) {
      left = window.innerWidth - menuRect.width - 12;
    }
    if (top + menuRect.height > window.innerHeight - 12) {
      top = rect.top - menuRect.height - 8;
    }
    menu.style.top = Math.max(12, top) + 'px';
    menu.style.left = Math.max(12, left) + 'px';

    setTimeout(function () {
      document.addEventListener('click', outsideClickHandler, true);
    }, 0);
  }

  function isTouchDevice() {
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  function attach(link) {
    link.addEventListener('click', function () {
      // Mobile devices always have a Mail app registered, so the native
      // mailto: handoff is reliable there - don't second-guess it.
      if (isTouchDevice()) return;

      var address = parseMailto(link.getAttribute('href')).address;
      if (!address) return;

      var handedOff = false;
      var onBlur = function () { handedOff = true; };
      window.addEventListener('blur', onBlur);

      setTimeout(function () {
        window.removeEventListener('blur', onBlur);
        // If the tab is still focused/visible, the OS almost certainly
        // didn't have a mail client to hand off to.
        if (!handedOff && document.hasFocus() && document.visibilityState === 'visible') {
          showFallbackMenu(link, address);
        }
      }, 600);
    });
  }

  onReady(function () {
    var links = document.querySelectorAll('a[href^="mailto:"]');
    links.forEach(attach);
  });
})();
