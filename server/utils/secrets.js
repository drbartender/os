const crypto = require('crypto');

/**
 * Timing-safe string comparison. Returns false for non-strings or a length
 * mismatch (length is not secret), otherwise defers to crypto.timingSafeEqual.
 * Shared by the Thumbtack webhook auth (`routes/thumbtack.js`) and the Thumbtack
 * email-harvester agent auth (`routes/thumbtackAgent.js`).
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { safeEqual };
