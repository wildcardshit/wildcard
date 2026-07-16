/**
 * Desktop mail links.
 *
 * mailto: only works if the browser has a mail client registered with the
 * OS, which most desktop users don't have - so clicking mailto: silently
 * does nothing there. Waiting around to detect that failure is unreliable
 * (timing varies a lot by browser), so instead: on desktop, clicking a
 * mail link/button opens a Gmail compose window addressed to
 * support@wildcardshit.com directly, in the same click (so it isn't
 * blocked as a popup). On mobile, the native mailto: handoff is used as
 * normal since a Mail app is always registered there.
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

  function isTouchDevice() {
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  function attach(link) {
    link.addEventListener('click', function (e) {
      // Phones always have a Mail app registered - let mailto: handle it.
      if (isTouchDevice()) return;

      var address = parseMailto(link.getAttribute('href')).address;
      if (!address) return;

      e.preventDefault();
      var gmailUrl =
        'https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=' +
        encodeURIComponent(address);
      window.open(gmailUrl, '_blank', 'noopener');
    });
  }

  onReady(function () {
    var links = document.querySelectorAll('a[href^="mailto:"]');
    links.forEach(attach);
  });
})();
