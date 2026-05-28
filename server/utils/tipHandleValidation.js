// Validates and normalizes contractor tip-page handles before they're persisted
// or rendered into the public tip page. paypal_url in particular flows into an
// <a href> on TipPage.jsx — accepting any URL would let a manager-or-admin set
// a phishing target dressed up as a paypal.me link.

const { ValidationError } = require('./errors');

const VENMO_RE = /^[A-Za-z0-9._-]{1,30}$/;
const CASHAPP_RE = /^[A-Za-z0-9_]{1,20}$/;
const PAYPAL_USER_RE = /^[A-Za-z0-9-]{1,30}$/;

// Zelle accepts a phone number (E.164) OR an email address (RFC 5322 light).
// Spec §6.11 + Task 6.
const ZELLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164 allows +<1-15 digits>, but local US users often paste with dashes/parens
// which we strip before matching.
const ZELLE_PHONE_RE = /^\+?[1-9]\d{6,14}$/;

function trimToNullableString(v, field) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError({ [field]: 'must be a string' });
  const t = v.trim();
  return t === '' ? null : t;
}

function normalizeVenmoHandle(input) {
  const t = trimToNullableString(input, 'venmo_handle');
  if (t === null) return null;
  const stripped = t.replace(/^@+/, '');
  if (!VENMO_RE.test(stripped)) {
    throw new ValidationError({ venmo_handle: 'must be 1-30 chars of letters, digits, dot, underscore, or hyphen' });
  }
  return stripped;
}

function normalizeCashappHandle(input) {
  const t = trimToNullableString(input, 'cashapp_handle');
  if (t === null) return null;
  const stripped = t.replace(/^\$+/, '');
  if (!CASHAPP_RE.test(stripped)) {
    throw new ValidationError({ cashapp_handle: 'must be 1-20 chars of letters, digits, or underscore' });
  }
  return stripped;
}

// Accepts a paypal.me URL, a bare paypal.me username, or "@username". Rejects
// anything pointing off paypal.me (paypal.com profile URLs, arbitrary domains,
// javascript: URIs). Returns canonical "https://paypal.me/<username>".
function normalizePaypalUrl(input) {
  const t = trimToNullableString(input, 'paypal_url');
  if (t === null) return null;

  let username;
  if (/^https?:\/\//i.test(t)) {
    let parsed;
    try { parsed = new URL(t); }
    catch { throw new ValidationError({ paypal_url: 'is not a valid URL' }); }
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'paypal.me') {
      throw new ValidationError({ paypal_url: 'must be a paypal.me link (e.g. https://paypal.me/your-handle)' });
    }
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (segs.length === 0) throw new ValidationError({ paypal_url: 'is missing a username' });
    try { username = decodeURIComponent(segs[0]); }
    catch { throw new ValidationError({ paypal_url: 'has an invalid username' }); }
  } else {
    // No-scheme input: accept "@username", "username", "paypal.me/username",
    // and "www.paypal.me/username" forms. Many users paste the URL bar form
    // without the scheme — rejecting those creates a confusing "invalid"
    // error when the value is unambiguously a paypal.me link.
    username = t
      .replace(/^@+/, '')
      .replace(/^(?:www\.)?paypal\.me\/+/i, '');
  }

  if (!PAYPAL_USER_RE.test(username)) {
    throw new ValidationError({ paypal_url: 'paypal.me username must be 1-30 chars of letters, digits, or hyphen' });
  }
  return `https://paypal.me/${username}`;
}

// Zelle handle: a phone number OR an email address. Phone is normalized by
// stripping formatting characters; email is lowercased. Spec §6.11 / Task 6.
function normalizeZelleHandle(input) {
  const t = trimToNullableString(input, 'zelle_handle');
  if (t === null) return null;
  if (ZELLE_EMAIL_RE.test(t)) {
    return t.toLowerCase();
  }
  const stripped = t.replace(/[\s\-().]/g, '');
  if (ZELLE_PHONE_RE.test(stripped)) {
    return stripped.startsWith('+') ? stripped : `+1${stripped}`;
  }
  throw new ValidationError({
    zelle_handle: 'Zelle requires a phone number or email address.',
  });
}

// Convenience: normalize an `updates` object in place. Mutates only the keys
// that are present and skip-on-undefined; an explicitly-null/empty value is
// treated as a clear (returns null).
function normalizeTipHandlesInPlace(updates) {
  if ('venmo_handle' in updates) updates.venmo_handle = normalizeVenmoHandle(updates.venmo_handle);
  if ('cashapp_handle' in updates) updates.cashapp_handle = normalizeCashappHandle(updates.cashapp_handle);
  if ('paypal_url' in updates) updates.paypal_url = normalizePaypalUrl(updates.paypal_url);
  if ('zelle_handle' in updates) updates.zelle_handle = normalizeZelleHandle(updates.zelle_handle);
}

module.exports = {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalUrl,
  normalizeZelleHandle,
  normalizeTipHandlesInPlace,
};
