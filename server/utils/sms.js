const twilio = require('twilio');
const { pool } = require('../db');

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
    return { sid: `dev-skipped-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
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

// Dependency seam for tests. `_realSendSMS` lets a test restore the real
// sender after injecting a stub.
const _realSendSMS = sendSMS;
let _deps = { sendSMS };
function __setSmsDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Send an automated SMS and log it to sms_messages. The single send+log
 * primitive for ALL automated SMS in Phases 3/4a/4b — scheduled handlers and
 * immediate hooks alike. Existing manual SMS paths (routes/messages.js,
 * routes/sms.js reply) are NOT refactored onto it.
 *
 * Behavior:
 *  - normalize `to`; if it is unparseable, log NOTHING and return
 *    { sid: null, status: 'skipped' } (a missing/garbage phone is not a
 *    Twilio failure — there is nothing to record).
 *  - send via sendSMS; on success INSERT an outbound row with status 'sent'.
 *  - on Twilio failure INSERT an outbound row with status 'failed' +
 *    error_message, then THROW. A scheduled handler's row then goes 'failed';
 *    an immediate caller catches it in its own try/catch.
 *
 * @param {Object} args
 * @param {string} args.to - raw phone (any format normalizePhone accepts)
 * @param {string} args.body - the SMS text
 * @param {number|null} [args.clientId=null] - clients.id for thread grouping
 * @param {string} args.messageType - touch identifier, e.g. 'initial_proposal'
 * @param {string|null} [args.recipientName=null] - display name
 * @returns {Promise<{sid: string|null, status: 'sent'|'skipped'}>}
 */
async function sendAndLogSms({ to, body, clientId = null, messageType, recipientName = null }) {
  if (!messageType || typeof messageType !== 'string') {
    throw new Error('sendAndLogSms: messageType is required');
  }
  const normalized = normalizePhone(to);
  if (!normalized) {
    console.warn(`[sendAndLogSms] unparseable phone for messageType=${messageType} — skipped, nothing logged`);
    return { sid: null, status: 'skipped' };
  }

  let sid = null;
  try {
    const msg = await _deps.sendSMS({ to: normalized, body });
    sid = msg && msg.sid ? msg.sid : null;
  } catch (sendErr) {
    await pool.query(
      `INSERT INTO sms_messages
         (direction, client_id, recipient_phone, recipient_name, body, message_type, twilio_sid, status, error_message)
       VALUES ('outbound', $1, $2, $3, $4, $5, NULL, 'failed', $6)`,
      [clientId, normalized, recipientName, body, messageType, String(sendErr.message || sendErr).slice(0, 500)]
    ).catch((logErr) => {
      console.error('[sendAndLogSms] failed to log the failed-send row:', logErr.message);
    });
    throw sendErr;
  }

  await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, recipient_name, body, message_type, twilio_sid, status)
     VALUES ('outbound', $1, $2, $3, $4, $5, $6, 'sent')`,
    [clientId, normalized, recipientName, body, messageType, sid]
  );
  return { sid, status: 'sent' };
}

module.exports = { sendSMS, normalizePhone, sendAndLogSms, __setSmsDeps, _realSendSMS };
