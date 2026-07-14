/* ==========================================================================
   WILDCARD — Shared admin auth helpers
   Used by:
     - functions/admin/_middleware.js       (gates the /admin/* dashboard pages)
     - functions/api/admin/_middleware.js   (gates the /api/admin/* endpoints)
     - functions/api/admin/login.js         (verifies credentials, issues a session)
     - functions/api/admin/logout.js        (revokes a session)

   No third-party auth library — everything here runs on the Web Crypto API
   that's already available in the Workers runtime, the same way the rest of
   this codebase avoids extra dependencies (see stripe-webhook.js's manual
   signature verification for the same pattern).

   THE MODEL
   ---------
   - The admin account is a single username + password pair configured as
     Cloudflare Pages secrets (ADMIN_USERNAME, ADMIN_PASSWORD_HASH) — never
     committed to the repo. The password is stored only as a PBKDF2 hash;
     see hashPassword()/verifyPassword() below and
     scripts/hash-admin-password.mjs for generating one locally.
   - A successful login issues a signed, opaque session token (HMAC-SHA256
     over a JSON payload, keyed by the ADMIN_SESSION_SECRET Pages secret) as
     an HttpOnly, Secure, SameSite=Strict cookie. Nothing about the session
     is trusted unless the signature verifies AND it hasn't expired.
   - Logging out (or a session hitting MAX age) doesn't just rely on the
     client dropping the cookie: revokeSession()/isSessionRevoked() record a
     denylist entry in the ADMIN_AUTH KV store so a copied/leaked cookie
     stops working the moment someone logs out, without needing a database
     of live sessions.
   - Failed logins are rate-limited per IP via the same ADMIN_AUTH store.

   If ADMIN_AUTH isn't bound yet, session revocation and rate limiting both
   degrade to "not enforced" (logged nowhere — there's nothing to log to)
   rather than failing closed, so a fresh clone isn't locked out before
   setup. Login itself still requires the correct password either way.
   ========================================================================== */

export const SESSION_COOKIE_NAME = 'wc_admin_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

const PBKDF2_ITERATIONS_DEFAULT = 210000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256
const MAX_FAILED_ATTEMPTS = 8;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ---------------- base64url / hex ---------------- */

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Constant-time string compare (equal-length case matters most; unequal
// lengths just fail after a same-shape loop so this never short-circuits
// on the very first byte).
function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let result = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

/* ---------------- password hashing (PBKDF2-HMAC-SHA256) ---------------- */
// Stored format: "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>"

export async function hashPassword(password, iterations) {
  iterations = iterations || PBKDF2_ITERATIONS_DEFAULT;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return 'pbkdf2-sha256$' + iterations + '$' + bytesToHex(salt) + '$' + bytesToHex(hash);
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt, expectedHex;
  try {
    salt = hexToBytes(parts[2]);
    expectedHex = parts[3];
  } catch (e) {
    return false;
  }
  const computed = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(bytesToHex(computed), expectedHex);
}

async function pbkdf2(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

/* ---------------- signed session tokens (HMAC-SHA256) ---------------- */
// Token shape: base64url(JSON payload) + "." + base64url(HMAC signature).
// Payload: { u: username, sid: <random session id>, iat, exp } (unix seconds).

export async function createSessionToken(env, payload) {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacSign(env, body);
  return body + '.' + sig;
}

// Returns the payload if the token is well-formed, correctly signed, and
// unexpired — otherwise null. Never throws for a malformed token; only
// throws if ADMIN_SESSION_SECRET itself isn't configured, since that's a
// setup error the caller should surface as a 500, not a routine auth
// failure.
export async function verifySessionToken(env, token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i === -1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expectedSig = await hmacSign(env, body);
  if (!timingSafeEqual(sig, expectedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(body)));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (Date.now() / 1000 > payload.exp) return null;
  return payload;
}

async function hmacSign(env, message) {
  if (!env.ADMIN_SESSION_SECRET) {
    throw new Error('ADMIN_SESSION_SECRET is not configured.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.ADMIN_SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

/* ---------------- cookies ---------------- */

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (e) {
        out[k] = v;
      }
    }
  });
  return out;
}

export function buildSessionCookie(token, maxAgeSeconds) {
  return [
    SESSION_COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=' + maxAgeSeconds
  ].join('; ');
}

export function buildExpiredSessionCookie() {
  return SESSION_COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

/* ---------------- login rate limiting (per IP) ---------------- */

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function checkRateLimit(env, ip) {
  if (!env.ADMIN_AUTH) return { allowed: true };
  const raw = await env.ADMIN_AUTH.get('loginfail:' + ip);
  if (!raw) return { allowed: true };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { allowed: true };
  }
  if (!data || typeof data.count !== 'number') return { allowed: true };
  if (data.count >= MAX_FAILED_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((data.resetAt - Date.now()) / 1000));
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  return { allowed: true };
}

export async function recordFailedAttempt(env, ip) {
  if (!env.ADMIN_AUTH) return;
  const key = 'loginfail:' + ip;
  const raw = await env.ADMIN_AUTH.get(key);
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    data = null;
  }
  const now = Date.now();
  if (!data || typeof data.resetAt !== 'number' || data.resetAt < now) {
    data = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_SECONDS * 1000 };
  }
  data.count += 1;
  const ttl = Math.max(60, Math.ceil((data.resetAt - now) / 1000));
  await env.ADMIN_AUTH.put(key, JSON.stringify(data), { expirationTtl: ttl });
}

export async function clearFailedAttempts(env, ip) {
  if (!env.ADMIN_AUTH) return;
  await env.ADMIN_AUTH.delete('loginfail:' + ip);
}

/* ---------------- session revocation (logout) ---------------- */

export async function revokeSession(env, payload) {
  if (!env.ADMIN_AUTH || !payload || !payload.sid || typeof payload.exp !== 'number') return;
  const ttl = Math.max(1, Math.ceil(payload.exp - Date.now() / 1000));
  await env.ADMIN_AUTH.put('revoked:' + payload.sid, '1', { expirationTtl: ttl });
}

export async function isSessionRevoked(env, payload) {
  if (!env.ADMIN_AUTH || !payload || !payload.sid) return false;
  const val = await env.ADMIN_AUTH.get('revoked:' + payload.sid);
  return val !== null;
}
