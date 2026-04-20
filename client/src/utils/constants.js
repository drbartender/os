/** Shared constants — single source of truth for hardcoded business values */

export const WHATSAPP_GROUP_URL = 'https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A';
export const COMPANY_PHONE = '(312) 588-9401';
export const COMPANY_PHONE_TEL = 'tel:+13125889401';

/**
 * Public site origin used when an admin builds a shareable link for a client
 * (proposal, drink plan, invoice, shopping list). Using this instead of
 * window.location.origin keeps copy-link URLs on drbartender.com even when
 * the admin is on admin.drbartender.com. Falls back to the current origin in
 * local dev so links stay clickable. Preview/staging builds can override via
 * REACT_APP_PUBLIC_SITE_URL at build time.
 */
const isLocalHost = typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
export const PUBLIC_SITE_URL = process.env.REACT_APP_PUBLIC_SITE_URL
  || (isLocalHost ? window.location.origin : 'https://drbartender.com');
