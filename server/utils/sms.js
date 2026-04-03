const twilio = require('twilio');

const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (!client) console.warn('⚠️  Twilio credentials not set — SMS will be logged but not sent');

/**
 * Send an SMS via Twilio
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (E.164 format, e.g. +13125551234)
 * @param {string} options.body - Message text
 * @returns {Promise}
 */
async function sendSMS({ to, body }) {
  if (!to) throw new Error('SMS recipient phone number is required');
  if (!client) {
    console.log(`[DEV] SMS skipped → ${to} | Body: ${body}`);
    return { sid: 'dev-skipped' };
  }
  const message = await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
  console.log(`SMS sent: ${message.sid} → ${to}`);
  return message;
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX)
 * Accepts formats like (312)555-1234, 312-555-1234, 3125551234, +13125551234
 * @param {string} phone
 * @returns {string|null} E.164 formatted number or null if invalid
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 11) return `+${digits}`;
  return null;
}

module.exports = { sendSMS, normalizePhone };
