/* ==========================================================================
   WILDCARD — POST /api/admin/login
   Cloudflare Pages Function. Public (see functions/api/admin/_middleware.js
   allowlist) — this is the only admin endpoint that has to be reachable
   without a session, since it's what creates one.

   Body: { "username": "...", "password": "..." }
   On success: sets the wc_admin_session cookie (HttpOnly, Secure,
   SameSite=Strict) and returns { ok: true }.
   On failure: 401 with a generic error, and the attempt counts against a
   per-IP rate limit (see functions/_auth.js) to slow down brute forcing.

   SECURITY
   --------
   - The admin password is never stored in plaintext, in this file, or
     anywhere in the repo — only as a PBKDF2 hash in the ADMIN_PASSWORD_HASH
     secret (see scripts/hash-admin-password.mjs and functions/README.md).
   - verifyPassword() always runs, even on a username mismatch, so response
     timing doesn't leak whether a given username exists.
   - Failed attempts are rate-limited per IP; once locked out this returns
     429 with Retry-After instead of continuing to check the password.
   - Only POST is accepted.
   ========================================================================== */

import {
  verifyPassword,
  createSessionToken,
  buildSessionCookie,
  SESSION_TTL_SECONDS,
  checkRateLimit,
  recordFailedAttempt,
  clearFailedAttempts,
  clientIp
} from '../../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.ADMIN_SESSION_SECRET) {
    return jsonError('Admin login is not configured yet.', 500);
  }

  const ip = clientIp(request);
  const rl = await checkRateLimit(env, ip);
  if (!rl.allowed) {
    return jsonError('Too many failed attempts. Try again later.', 429, {
      'Retry-After': String(rl.retryAfterSeconds)
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid request body.', 400);
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    return jsonError('Username and password are required.', 400);
  }

  const usernameMatches = username === env.ADMIN_USERNAME;
  const passwordOk = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);

  if (!usernameMatches || !passwordOk) {
    await recordFailedAttempt(env, ip);
    return jsonError('Invalid username or password.', 401);
  }

  await clearFailedAttempts(env, ip);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    u: username,
    sid: crypto.randomUUID(),
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  };
  const token = await createSessionToken(env, payload);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': buildSessionCookie(token, SESSION_TTL_SECONDS)
    }
  });
}

export async function onRequestGet() {
  return jsonError('Method not allowed. Use POST.', 405);
}

function jsonError(message, status, extraHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    )
  });
}
