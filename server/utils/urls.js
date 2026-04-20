/**
 * URL helpers — keep client-facing links on the public domain, admin links on
 * the admin domain, and backend-hosted links (unsubscribe, webhooks) on the API
 * origin so a single misconfiguration can't route customers into /admin/* or
 * pin an unsubscribe link to a static SPA that can't handle the request.
 */

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';
const ADMIN_URL = process.env.CLIENT_URL || 'https://admin.drbartender.com';
// Render auto-sets RENDER_EXTERNAL_URL in prod; in dev the local Express server
// is on PORT. API_URL lets ops override if the backend ever moves behind a CDN.
const API_URL = process.env.API_URL
  || process.env.RENDER_EXTERNAL_URL
  || `http://localhost:${process.env.PORT || 5000}`;

if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_SITE_URL) {
  console.warn('[urls] PUBLIC_SITE_URL is not set — falling back to https://drbartender.com. Set it explicitly to avoid surprises in preview/staging.');
}

module.exports = { PUBLIC_SITE_URL, ADMIN_URL, API_URL };
