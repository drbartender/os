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

function extractRescheduleOldUid(payload) {
  return payload?.rescheduleUid
      || payload?.rescheduleId
      || payload?.originalRescheduleEvent?.uid
      || payload?.metadata?.rescheduleUid
      || null;
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
  extractPhone,
  normalizeBooker,
};
