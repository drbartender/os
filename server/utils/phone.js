// Save-time phone validation. Distinct from `sms.js#normalizePhone`, which
// converts to E.164 for Twilio at send-time. This helper enforces that the
// stored value is a 10-digit US number — empty strings are coerced to null
// (so optional fields stay nullable). Strips a leading country code 1 to
// stay compatible with formatPhone.js (client) which assumes 10-digit storage.

function validatePhone(raw, { required = false } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null, error: required ? 'Phone number is required' : null };
  }
  const digits = String(raw).replace(/\D/g, '');
  const stripped = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (stripped.length !== 10) {
    return { value: null, error: 'Phone must be a valid 10-digit number' };
  }
  return { value: stripped, error: null };
}

// The one last-10-digit matcher, moved here verbatim from smsInbound.js on
// 2026-10-06 so modules smsInbound.js itself requires can share it without a cycle.
/**
 * Extract the last 10 digits of a phone number for matching. Inbound numbers
 * arrive E.164 (+1XXXXXXXXXX); stored numbers are free-text. Returns null when
 * fewer than 10 digits are present.
 *
 * @param {string} phone
 * @returns {string|null}
 */
function last10(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

module.exports = { validatePhone, last10 };
