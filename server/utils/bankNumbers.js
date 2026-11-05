// Bank-number rules shared by every writer of payment_profiles.routing_number and account_number: the format checks, the masked display value, and what an incoming value means.
//
// Every screen shows a stored bank number masked, as four stars plus its last four
// digits ('****' alone when the decrypt failed): GET /api/payment's safeMask and
// GET /api/admin/users/:id. A form seeded from that display value and saved back
// used to have the mask encrypted over the real number (the admin profile save did
// it on every edit). Here a masked value means "unchanged", so the caller keeps the
// stored column inside its own UPDATE; a real value must pass the ABA routing
// checksum or the 4 to 17 digit account rule before it is encrypted. Writers:
// POST /api/payment, PUT /api/admin/users/:id/profile, and the staff portal's
// PATCH (server/routes/staffPortal/paymentMethods.js, the validators only).

const Sentry = require('@sentry/node');
const { encrypt, decrypt } = require('./encryption');
const { ValidationError } = require('./errors');

/**
 * The masked display value for a stored bank number: four stars plus the last
 * four of the decrypted number, or four stars alone when the ciphertext cannot
 * be decrypted (a rotated ENCRYPTION_KEY, a corrupted row), with a Sentry
 * breadcrumb so the row can be repaired. One bad row must never 500 a whole
 * profile read: GET /api/payment degraded this way from the start, while GET
 * and PUT /api/admin/users/:id decrypted bare and took every direct-deposit
 * contractor's record page down with one row (audit 2026-11-05, POUT-08).
 * The bare '****' round-trips as "unchanged" through isMaskedBankValue.
 */
function maskBankNumber(cipher, { userId = null, column = null } = {}) {
  if (!cipher) return cipher;
  try {
    return '****' + String(decrypt(cipher)).slice(-4);
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { util: 'bankNumbers', op: 'mask', column },
          extra: { user_id: userId },
        });
      }
    } catch (_) { /* never let logging break a response */ }
    return '****';
  }
}

/** True for a 9-digit ABA routing number whose 3-7-1 weighted digit sum ends in 0. */
function isValidRoutingNumber(s) {
  if (typeof s !== 'string' || !/^\d{9}$/.test(s)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(s[i]) * w[i];
  return sum % 10 === 0;
}

/** True for an account number of 4 to 17 digits. */
function isValidAccountNumber(s) {
  return typeof s === 'string' && /^\d{4,17}$/.test(s);
}

/**
 * True for the masked display value: exactly four stars, then at most four
 * characters of any kind. That is what both GETs build ('****' plus the stored
 * value's last four characters, or '****' alone after a failed decrypt), and a
 * number stored before any format check can end in a dash, a space or a star, so
 * the tail is not limited to digits. No real bank number starts with a star.
 */
function isMaskedBankValue(v) {
  return typeof v === 'string' && /^\*{4}[\s\S]{0,4}$/.test(v.trim());
}

const FIELD_RULES = {
  routing_number: {
    valid: isValidRoutingNumber,
    invalid: 'Routing number must be a valid 9-digit ABA routing number.',
    required: 'Routing number is required for direct deposit.',
  },
  account_number: {
    valid: isValidAccountNumber,
    invalid: 'Account number must be 4 to 17 digits.',
    required: 'Account number is required for direct deposit.',
  },
};

/**
 * Decide what each incoming bank field means, refusing every bad field at once.
 *
 * @param {object} body       holds routing_number and account_number as posted
 * @param {object} opts
 * @param {'clear'|'require'} opts.blank  what a blank means: 'clear' stores null
 *                            (the admin form, where clearing the field removes the
 *                            number), 'require' refuses (direct deposit on Payday)
 * @returns {{ routing_number: {keep: boolean, value: string|null},
 *             account_number: {keep: boolean, value: string|null} }}
 *   keep true: leave the stored column as it is (the field was left out of the
 *   request, or its masked value came back); keep false: store value, which is
 *   the encrypted number or null. Left out is never cleared: a form that did not
 *   touch a bank field must not wipe a number saved after the form was opened.
 * @throws {ValidationError} keyed by field, for an invalid or a required-but-blank value
 */
function resolveBankFields(body, { blank }) {
  const out = {};
  const fieldErrors = {};
  for (const field of Object.keys(FIELD_RULES)) {
    const rule = FIELD_RULES[field];
    const raw = body ? body[field] : undefined;
    if (raw === undefined || isMaskedBankValue(raw)) {
      out[field] = { keep: true, value: null };
      continue;
    }
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    if (s === '') {
      if (blank === 'require') fieldErrors[field] = rule.required;
      out[field] = { keep: false, value: null };
      continue;
    }
    if (!rule.valid(s)) {
      fieldErrors[field] = rule.invalid;
      continue;
    }
    out[field] = { keep: false, value: encrypt(s) };
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);
  return out;
}

// The message for a bank field that direct deposit needs and did not get.
const BANK_REQUIRED_MESSAGES = Object.freeze({
  routing_number: FIELD_RULES.routing_number.required,
  account_number: FIELD_RULES.account_number.required,
});

module.exports = {
  isValidRoutingNumber,
  isValidAccountNumber,
  isMaskedBankValue,
  maskBankNumber,
  resolveBankFields,
  BANK_REQUIRED_MESSAGES,
};
