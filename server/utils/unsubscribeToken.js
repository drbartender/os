// Unsubscribe link tokens: signs with UNSUBSCRIBE_SECRET when set (else JWT_SECRET) and verifies under either key.
//
// Every link sent before UNSUBSCRIBE_SECRET existed was signed with
// JWT_SECRET and lives 365 days, so verification tries both keys: setting the
// dedicated secret moves new links onto it without breaking the old ones. The
// typ check (a conflicting typ is refused) stays in the reader,
// routes/emailMarketing/unsubscribe.js. Keys are read per call so a test or a
// rotated env takes effect without a restart of this module.

const jwt = require('jsonwebtoken');

function signingSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
}

/** A 365-day unsubscribe token for { leadId } or { clientId, marketing: true }. */
function signUnsubscribeToken(payload) {
  return jwt.sign({ ...payload, typ: 'unsub' }, signingSecret(), { expiresIn: '365d' });
}

/** The decoded payload when the token is valid under either key, else null. */
function verifyUnsubscribeToken(token) {
  if (!token) return null;
  const keys = [...new Set([process.env.UNSUBSCRIBE_SECRET, process.env.JWT_SECRET].filter(Boolean))];
  for (const key of keys) {
    try {
      return jwt.verify(token, key);
    } catch (_err) { // static-checks: allow swallowed-catch
      // Not valid under this key; try the next. The caller gets null when no key verifies.
    }
  }
  return null;
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken };
