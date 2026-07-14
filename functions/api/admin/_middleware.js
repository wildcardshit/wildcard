/* ==========================================================================
   WILDCARD — Middleware for /api/admin/*
   Requires a valid, unrevoked admin session cookie for every endpoint under
   this path except /api/admin/login (credentials go in, not out — has to
   stay reachable to establish a session) and /api/admin/logout (clearing a
   cookie should always succeed, even against an already-expired session).

   On success, the verified session payload is attached to context.data so
   downstream handlers (e.g. api/admin/orders.js recording who marked an
   order shipped) can read the admin's username without re-verifying the
   cookie themselves.

   CSRF: the session cookie is SameSite=Strict, which already stops it
   riding along on a cross-site request. As defense in depth, any mutating
   request (non-GET/HEAD) is also rejected if it carries an Origin header
   that doesn't match this site's own origin.
   ========================================================================== */

import { parseCookies, verifySessionToken, isSessionRevoked, SESSION_COOKIE_NAME } from '../../_auth.js';

const PUBLIC_PATHS = new Set(['/api/admin/login', '/api/admin/logout']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
      return jsonError('Invalid origin.', 403);
    }
  }

  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return jsonError('Not authenticated.', 401);

  let payload;
  try {
    payload = await verifySessionToken(env, token);
  } catch (e) {
    return jsonError('Admin auth is not configured.', 500);
  }
  if (!payload) return jsonError('Session expired or invalid.', 401);
  if (await isSessionRevoked(env, payload)) return jsonError('Session expired or invalid.', 401);

  context.data = context.data || {};
  context.data.admin = { username: payload.u, sid: payload.sid };

  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers: headers });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
