/* ==========================================================================
   WILDCARD — POST /api/admin/logout
   Cloudflare Pages Function. Public (see functions/api/admin/_middleware.js
   allowlist) so clearing a cookie always works, even if the session it
   points at already expired.

   Clears the wc_admin_session cookie AND records the session id on the
   revocation denylist (see revokeSession() in functions/_auth.js), so a
   copy of the cookie made before logout (e.g. from a shared/compromised
   device) stops working immediately rather than staying valid until it
   naturally expires.
   ========================================================================== */

import {
  parseCookies,
  verifySessionToken,
  revokeSession,
  buildExpiredSessionCookie,
  SESSION_COOKIE_NAME
} from '../../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];

  if (token) {
    let payload = null;
    try {
      payload = await verifySessionToken(env, token);
    } catch (e) {
      payload = null;
    }
    if (payload) {
      await revokeSession(env, payload);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': buildExpiredSessionCookie()
    }
  });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}
