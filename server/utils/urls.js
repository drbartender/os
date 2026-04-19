/**
 * URL helpers — keep client-facing links on the public domain and admin links
 * on the admin domain so a single CLIENT_URL misconfiguration can't route
 * customers into /admin/* or admins into /proposal/:token.
 */

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';
const ADMIN_URL = process.env.CLIENT_URL || 'https://admin.drbartender.com';

module.exports = { PUBLIC_SITE_URL, ADMIN_URL };
