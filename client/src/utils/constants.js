/** Shared constants — single source of truth for hardcoded business values */

export const WHATSAPP_GROUP_URL = 'https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A';
// VOICE: the primary business line (+12242221922). This is the number to CALL.
export const COMPANY_PHONE = '(224) 222-1922';
export const COMPANY_PHONE_TEL = 'tel:+12242221922';
// SMS: still the toll-free 888 until the 224 numbers clear A2P 10DLC registration
// (spec Phase 2). Texting a number with no approved campaign does not deliver, so
// these MUST stay separate from the voice pair until that cutover.
export const COMPANY_TEXT_PHONE = '(888) 231-4320';
export const COMPANY_TEXT_PHONE_TEL = 'sms:+18882314320';

// Business postal address, shown on the legal pages. Mirrors POSTAL_ADDRESS in
// server/utils/emailTemplates.js, which renders it in the CAN-SPAM marketing
// email footer. Client and server bundles are separate, so the two are kept in
// sync by hand — same arrangement as eventTypes.js. Change both together.
export const COMPANY_POSTAL_ADDRESS = '1625 W Farwell Ave, Chicago, IL 60626';

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

/**
 * Staff portal origin used for staff-facing links generated from the admin app
 * (e.g., the BEO view link on the EventDetailPage). Mirrors PUBLIC_SITE_URL's
 * shape: prod uses staff.drbartender.com; local dev falls back to the current
 * origin so links work in the in-place dev server; previews override via
 * REACT_APP_STAFF_URL at build time.
 */
export const STAFF_URL = process.env.REACT_APP_STAFF_URL
  || (isLocalHost ? window.location.origin : 'https://staff.drbartender.com');
