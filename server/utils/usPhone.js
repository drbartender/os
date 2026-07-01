const { normalizePhone } = require('./sms');

// Strict NANP shape: +1, then a 3-digit area code whose first digit is 2-9,
// then a 7-digit subscriber number. Matches the spec's toll-fraud control
// (design doc §Security 3: normalizePhone THEN a hard +1/NANP-only check).
const US_E164_RE = /^\+1[2-9]\d{9}$/;

// Premium/pay-per-call area codes blocked as a toll-fraud guard.
const BLOCKED_AREA_CODES = new Set(['900', '976']);

// Foreign sovereign NANP nations (Caribbean etc.). They share the +1 country
// code and pass the NANP shape check, but are classic IRSF / toll-fraud
// destinations at premium international rates. This feature only ever dials US
// numbers, so every one of these area codes is rejected. US states, Canada, and
// US territories (PR 787/939, Guam, USVI, etc.) are intentionally NOT listed.
const NON_US_NANP_AREA_CODES = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658',
  '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);

/**
 * True iff `s` is already a strict US NANP number in +1 E.164 form, with
 * premium 900/976 area codes AND foreign NANP nations rejected. Does NOT
 * normalize — see toUsE164.
 * @param {*} s
 * @returns {boolean}
 */
function isUsE164(s) {
  if (typeof s !== 'string' || !US_E164_RE.test(s)) return false;
  const areaCode = s.slice(2, 5); // digits after the "+1"
  if (BLOCKED_AREA_CODES.has(areaCode)) return false;
  if (NON_US_NANP_AREA_CODES.has(areaCode)) return false;
  return true;
}

/**
 * Normalize an arbitrary raw phone string, then require it be a valid US NANP
 * number (+1, area/exchange leading digit 2-9) and reject 900/976 premium codes
 * AND foreign NANP nations (via isUsE164). Returns the +1 E.164 string, or null
 * if it is not a dialable US number. This is the primary toll-fraud control for
 * the VA calling feature: only US numbers are ever handed to the bridge.
 *
 * NOTE: never pass VA_CELL (a +63 PH number) through here — it would return
 * null. VA_CELL stays strict E.164 from its env var, unnormalized.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function toUsE164(raw) {
  const e164 = normalizePhone(raw);
  if (!e164) return null;
  return isUsE164(e164) ? e164 : null;
}

module.exports = { toUsE164, isUsE164 };
