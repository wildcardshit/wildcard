/* ==========================================================================
   WILDCARD — GET /api/admin/whoami
   Cloudflare Pages Function. Guarded by functions/api/admin/_middleware.js
   like everything else under /api/admin/ — reaching this handler at all
   already proves the session is valid. Just echoes back who's signed in so
   the dashboard header can display it.
   ========================================================================== */

export async function onRequestGet(context) {
  const admin = context.data && context.data.admin;
  return new Response(JSON.stringify({ username: admin ? admin.username : null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost() {
  return new Response(JSON.stringify({ error: 'Method not allowed. Use GET.' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' }
  });
}
