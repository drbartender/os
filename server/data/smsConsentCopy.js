// Canonical client SMS consent text, server side, keyed by version.
//
// An audit row must never store text the browser supplied, so recordSmsConsent
// resolves copy_text from this map using the version the client submitted.
// Entries are append-only: an old version stays forever so historical
// sms_consent_log rows keep resolving to what those users actually agreed to.
//
// Mirrors client/src/constants/smsConsent.js. server/utils/smsConsent.test.js
// fails if the two diverge.
//
// CLIENTS ONLY. Staff SMS consent lives on the contractor agreement
// (agreements.sms_consent) and is already approved with Twilio.

const SMS_CONSENT_VERSION = 'v1';

const SMS_CONSENT_COPY = {
  v1:
    'Text me about my event. I agree to receive text messages from Dr. Bartender ' +
    'about my quote, booking, payments, and event details at the mobile number ' +
    'provided. Message frequency varies. Msg & data rates may apply. Reply STOP ' +
    'to opt out, HELP for help. Consent is not a condition of purchase. See our ' +
    'Privacy Policy and Terms.',
};

/**
 * Resolve the canonical consent text for a version.
 *
 * `version` arrives from an unauthenticated request body, so the lookup is an
 * own-property check rather than a bare index. A plain `MAP[version]` walks the
 * prototype chain: 'constructor', 'toString', '__proto__' and friends all
 * return something truthy, which would sail past the caller's `if (!copyText)`
 * guard and write a function's source text into the compliance log as the
 * sentence the client agreed to.
 *
 * @param {string} version
 * @returns {string|null} null for an unknown version
 */
function getConsentCopy(version) {
  if (typeof version !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SMS_CONSENT_COPY, version)) return null;
  // Guarded above by an own-property check and type-checked below; the linter
  // cannot see either, so the sink warning here is a false positive.
  // eslint-disable-next-line security/detect-object-injection
  const copy = SMS_CONSENT_COPY[version];
  return typeof copy === 'string' ? copy : null;
}

module.exports = { SMS_CONSENT_VERSION, SMS_CONSENT_COPY, getConsentCopy };
