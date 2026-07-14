/* ==========================================================================
   WILDCARD — Middleware for /admin/*
   Cloudflare Pages Functions middleware runs for every request under this
   directory BEFORE the static asset (admin/index.html, admin/js/*.js, any
   future admin page) is served — so an unauthenticated request never
   reaches the dashboard HTML/JS at all, not even to download it. This is
   what makes the dashboard "not publicly accessible": there's no static
   file to fetch until a valid session cookie is presented.

   The login form itself lives OUTSIDE /admin/ (at /admin-login.html) so it
   stays reachable without a session, without needing an allowlist here.

   See functions/_auth.js for the session token format and
   functions/api/admin/_middleware.js for the matching guard on the JSON
   API this dashboard calls.
   ========================================================================== */

import { parseCookies, verifySessionToken, isSessionRevoked, SESSION_COOKIE_NAME } from '../_auth.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  function redirectToLogin() {
    const dest = new URL('/admin-login.html', url.origin);
    dest.searchParams.set('next', url.pathname);
    return Response.redirect(dest.toString(), 302);
  }

  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return redirectToLogin();

  let payload;
  try {
    payload = await verifySessionToken(env, token);
  } catch (e) {
    // ADMIN_SESSION_SECRET isn't configured — fail closed, but surface it
    // as a plain error instead of a confusing redirect loop through login.
    return new Response('Admin dashboard is not configured yet.', { status: 500 });
  }
  if (!payload) return redirectToLogin();
  if (await isSessionRevoked(env, payload)) return redirectToLogin();

  const response = await next();

  // Belt-and-suspenders: never let a browser, proxy, or CDN cache anything
  // under /admin/, authenticated or not.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers: headers });
}
