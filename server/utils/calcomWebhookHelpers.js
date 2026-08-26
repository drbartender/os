const crypto = require('crypto');

const MAX_NAME_LEN = 255;
const MAX_EMAIL_LEN = 255;
const MAX_PHONE_LEN = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function verifyCalcomSignature(rawBody, providedHeader, secret) {
  if (!providedHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== providedHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedHeader));
  } catch {
    return false;
  }
}

function computeBodyHash(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function parseCalcomBody(rawBody) {
  return JSON.parse(rawBody.toString('utf8'));
}

function extractBookingFields(payload) {
  return {
    uid: payload?.uid,
    startTime: payload?.startTime,
  };
}

/**
 * Every key a Cal.com BOOKING_RESCHEDULED payload might carry the OLD booking
 * reference in, in priority order, de-duplicated, as strings.
 *
 * WHY A LIST AND NOT A PICK. The single-value version returned the first
 * TRUTHY key, which forces a guess about a payload shape nothing here has ever
 * observed: prod has processed zero reschedules, `webhook_events` stores only
 * (provider, event_id) so no payload was ever archived, and Cal.com's
 * `rescheduleId` is a NUMERIC booking id rather than the uid string that
 * `consults.calcom_event_id` holds. A payload carrying only that key would hand
 * back a number, match no row, and send every reschedule down the
 * unresolved-old-uid path -- which is what decides whether the silent-cancel
 * entry beside this one is rare or routine.
 *
 * Returning candidates lets the DATABASE decide which one is real instead of
 * this function guessing. A numeric id simply matches nothing and costs
 * nothing, so the question stops needing an answer.
 */
function extractRescheduleOldUids(payload) {
  const seen = new Set();
  for (const raw of [
    payload?.rescheduleUid,
    payload?.rescheduleId,
    payload?.originalRescheduleEvent?.uid,
    payload?.metadata?.rescheduleUid,
  ]) {
    if (raw === null || raw === undefined) continue;
    const v = String(raw).trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** First candidate only. Kept because the priority ORDER is a contract other
 *  callers and tests rely on; prefer extractRescheduleOldUids for resolution. */
function extractRescheduleOldUid(payload) {
  return extractRescheduleOldUids(payload)[0] || null;
}

function extractPhone(payload) {
  const candidates = [
    payload?.attendees?.[0]?.phoneNumber,
    payload?.attendees?.[0]?.phone,
    payload?.responses?.phone,
    payload?.customInputs?.phone,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
    // Cal.com sometimes wraps form-field values as { value: '...', label: '...' }
    if (c && typeof c === 'object' && typeof c.value === 'string' && c.value.trim()) {
      return c.value;
    }
  }
  return null;
}

function normalizeBooker(payload) {
  const attendee = payload?.attendees?.[0] || {};

  const nameRaw = String(attendee.name || '').trim();
  const name = nameRaw.slice(0, MAX_NAME_LEN) || 'Unknown booker';

  const emailRaw = String(attendee.email || '').trim().toLowerCase();
  const email = emailRaw && emailRaw.length <= MAX_EMAIL_LEN && EMAIL_RE.test(emailRaw)
    ? emailRaw
    : null;

  const phoneRaw = String(extractPhone(payload) || '').trim();
  const phone = phoneRaw.slice(0, MAX_PHONE_LEN) || null;

  // bookerNameRaw / bookerEmailRaw preserve what Cal.com sent for the audit
  // row on consults. They follow the same trim + lowercase as the validation
  // inputs but bypass the format check (so consults still records the actual
  // bytes Cal.com sent, even when the email is malformed and the client-side
  // normalized email is null).
  return {
    name,
    email,
    phone,
    bookerNameRaw: nameRaw.slice(0, MAX_NAME_LEN) || null,
    bookerEmailRaw: emailRaw.slice(0, MAX_EMAIL_LEN) || null,
  };
}

module.exports = {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  extractRescheduleOldUids,
  extractPhone,
  normalizeBooker,
};
