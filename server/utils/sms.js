const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { notificationsEnabled } = require('./notificationsEnabled');
const { buildSmsLogEntry, logClientMessage } = require('./messageLog');
const { LINE_KEYS, lineE164 } = require('./smsLines');
const { recordOptOut, isTwilioOptOutError } = require('./smsOptOut');
const { API_URL } = require('./urls');

const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (!client) console.warn('⚠️  Twilio credentials not set — SMS will be logged but not sent');
else if (!notificationsEnabled()) console.log('[sms] Twilio initialized, but notifications are gated OFF (set SEND_NOTIFICATIONS=true to send) — SMS will be logged only');

/**
 * Send an SMS via Twilio
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (E.164 format, e.g. +13125551234)
 * @param {string} options.body - Message text
 * @param {Object} [options.meta] - message_log context (clientId, proposalId, messageType, sentBy, skipLog)
 * @param {string} [options.from] - a line key from smsLines.js ('888', '1922', '0082').
 *   Omitted, it sends from TWILIO_PHONE_NUMBER exactly as before. An unknown key is
 *   refused before anything is sent. A 224 send always names its line: nothing
 *   relies on the Messaging Service number pool (spec 2026-10-06, section 9).
 * @param {string} [options.statusCallback] - Twilio status callback URL (smsStatusCallbackUrl())
 * @returns {Promise<Object>} the Twilio message (its `from` is the number Twilio
 *   reports), or the dev stub { sid, from } when Twilio is absent or gated off
 */
async function sendSMS({ to, body, meta, from, statusCallback }) {
  if (!to) throw new Error('SMS recipient phone number is required');
  const hasLine = from !== undefined && from !== null;
  if (hasLine && !LINE_KEYS.includes(from)) {
    throw new Error(`sendSMS: unknown line "${from}"`);
  }
  const fromNumber = hasLine ? lineE164(from) : process.env.TWILIO_PHONE_NUMBER;
  // The Twilio client and the gate come through the test seam (_deps, below),
  // the way placeBridgedCall reads them. Unset, they are the module client and
  // notificationsEnabled, so production behavior is unchanged.
  const { client: activeClient, notificationsEnabled: notifEnabled } = _deps;
  if (!activeClient || !notifEnabled()) {
    const why = !activeClient ? 'Twilio creds not set' : 'notifications gated off';
    // Redact recipient to last-4 and drop the body (keep only its length): the
    // body can carry client PII. Matches placeBridgedCall's slice(-4) idiom below.
    console.log(`[DEV] SMS skipped (${why}) → ...${String(to).slice(-4)} | Body length: ${String(body || '').length}`);
    return { sid: `dev-skipped-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, from: fromNumber || null };
  }
  if (hasLine && !fromNumber) throw new Error(`sendSMS: line ${from} has no number configured`);
  const params = { from: fromNumber, to, body };
  if (statusCallback) params.statusCallback = statusCallback;
  let message;
  try {
    message = await activeClient.messages.create(params);
  } catch (err) {
    logClientMessage(buildSmsLogEntry({ to, body, meta, error: err })); // fire-and-forget
    // Twilio 21610: this number opted out of this sender. Record it so every
    // line refuses it (decision 10). Best effort: a failed write is logged and
    // must never replace the send error the caller is about to handle.
    if (isTwilioOptOutError(err)) {
      try {
        await recordOptOut({ phone: to, source: 'twilio_21610', line: hasLine ? from : '888' });
      } catch (optErr) {
        // Visible, never thrown: no phone number in the log or the event.
        console.error('[sms] could not record the 21610 opt-out:', optErr && optErr.message);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(optErr, { tags: { area: 'sms_21610_record' } });
        }
      }
    }
    throw err;
  }
  console.log(`SMS sent: ${message.sid} → ...${String(to).slice(-4)}`);
  logClientMessage(buildSmsLogEntry({ to, body, meta, result: message })); // fire-and-forget
  return message;
}

/**
 * The status callback Messages-page and Inbox sends register: the API origin
 * plus /api/sms/status (the same API_URL every Twilio voice callback uses).
 */
function smsStatusCallbackUrl() {
  return `${API_URL}/api/sms/status`;
}

/**
 * The error text stored on a failed human send's row: "Twilio <code> (failed)"
 * when Twilio gave a numeric error code, else "Twilio send failed". It matches
 * the status callback's "Twilio <code> (<status>)" whenever there is a code;
 * without one, the callback stores "Twilio error (<status>)" and a send stores
 * "Twilio send failed". Twilio's prose (which can quote the phone number) stays
 * off the row. The admin group send keeps its raw message (POST /api/messages/send).
 */
function twilioErrorText(err) {
  const code = err && err.code;
  return code !== undefined && code !== null && /^\d+$/.test(String(code))
    ? `Twilio ${code} (failed)`
    : 'Twilio send failed';
}

/**
 * Place a Twilio callback-bridge call: Twilio dials `to` (Zul's cell, VA_CELL,
 * strict E.164 — already validated by the caller, NEVER normalized here) and,
 * when she answers, fetches `url` (the /api/voice/bridge TwiML) to dial the
 * target with `callerId` (the 224) shown to the far end.
 *
 * Gated IDENTICALLY to sendSMS (sms.js:22-26): a dev server or gated env never
 * dials the live, auto-refill account. This is a billed-international-voice,
 * toll-fraud-adjacent primitive — the gate is load-bearing.
 *
 * @param {Object} opts
 * @param {string} opts.to             - VA_CELL, strict E.164 (+63…)
 * @param {string} opts.callerId       - VOICE_CALLER_ID (the 224); Twilio `from`
 * @param {string} opts.url            - bridge TwiML URL (/api/voice/bridge)
 * @param {string} opts.statusCallback - status webhook URL (/api/voice/status)
 * @param {number} opts.timeLimit      - per-call cap in seconds
 * @param {number} [opts.timeout]      - ring seconds before no-answer (Twilio
 *   default 60). Generic agent-leg use (lead-call bridge dials ADMIN_PHONE /
 *   VA_CELL with a short ring so failover stays fast); omitted for legacy callers.
 * @returns {Promise<{sid: string}>}   - Twilio call resource, or a dev-skipped stub
 */
async function placeBridgedCall({ to, callerId, url, statusCallback, timeLimit, timeout }) {
  if (!to) throw new Error('placeBridgedCall recipient (VA_CELL) is required');
  const { client: activeClient, notificationsEnabled: notifEnabled } = _deps;
  if (!activeClient || !notifEnabled()) {
    const why = !activeClient ? 'Twilio creds not set' : 'notifications gated off';
    // Redact VA_CELL to last-4 (match smsInbound.js's slice(-4) PII style).
    console.log(`[DEV] Bridged call skipped (${why}) → ...${String(to).slice(-4)} | url: ${url}`);
    return { sid: `dev-skipped-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
  const call = await activeClient.calls.create({
    from: callerId, to, url, statusCallback, timeLimit,
    ...(timeout ? { timeout } : {}),
  });
  console.log(`Bridged call placed: ${call.sid} → ...${String(to).slice(-4)}`);
  return call;
}

/**
 * Best-effort cancel of a bridged call by CallSid. Used when the CallSid could
 * not be persisted to pending_call (an attachCallSid failure): the /api/voice/
 * bridge webhook resolves the dial target BY CallSid, so without the row Zul
 * would answer into a dead apology-and-hangup. Cancelling the billed leg keeps
 * her phone from ringing into that dead bridge. Gated IDENTICALLY to
 * placeBridgedCall (sms.js:60-65) so a dev/gated env never touches the live
 * account. Twilio only cancels a queued/ringing call; an already-answered call
 * is a no-op on their side. Rethrows a real Twilio error to the caller, which
 * wraps this in try/catch (never on the critical path).
 *
 * @param {Object} opts
 * @param {string} opts.callSid - the Twilio Call SID to cancel
 * @returns {Promise<{sid: string|null, status?: string}>}
 */
async function cancelBridgedCall({ callSid }) {
  if (!callSid) return { sid: null, status: 'skipped' };
  const { client: activeClient, notificationsEnabled: notifEnabled } = _deps;
  if (!activeClient || !notifEnabled()) {
    const why = !activeClient ? 'Twilio creds not set' : 'notifications gated off';
    console.log(`[DEV] Bridged call cancel skipped (${why}) sid=...${String(callSid).slice(-4)}`);
    return { sid: callSid, status: 'skipped' };
  }
  const call = await activeClient.calls(callSid).update({ status: 'canceled' });
  console.log(`Bridged call canceled: sid=...${String(callSid).slice(-4)}`);
  return call;
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
let _deps = { sendSMS, client, notificationsEnabled };
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
async function sendAndLogSms({ to, body, clientId = null, proposalId = null, messageType, recipientName = null }) {
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
    const msg = await _deps.sendSMS({ to: normalized, body, meta: { proposalId, clientId, messageType } });
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

module.exports = { sendSMS, smsStatusCallbackUrl, twilioErrorText, normalizePhone, sendAndLogSms, placeBridgedCall, cancelBridgedCall, __setSmsDeps, _realSendSMS };
