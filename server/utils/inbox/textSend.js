'use strict';

// The Inbox text (spec 8; spec amendments 2, 3 and 8), behind
// POST /api/admin/inbox/:personKey/text. The order is the safety:
//   1. check the request itself (400; nothing is reserved);
//   2. reserve the send_id in inbox_sends before anything else: a repeat gets
//      the stored answer and sends nothing, and a repeat while the first is
//      still running gets 409;
//   3. from a fresh read, resolve who and which line (422), the opt-out (409)
//      and a bad number (422), then add the first-text prefix;
//   4. send once, record the row, store the answer under the send_id.
// Every answer after step 2 is stored, because the page spends a send_id
// once the server has answered (amendment 3): a repeat can only be a retry of
// a request whose answer never arrived. The reservation is deleted only when
// an unexpected error lands before Twilio is called, so that id may retry; one
// left with no answer past SEND_STALE_SECONDS answers INBOX_SEND_UNRECORDED,
// so a crashed request never blocks a draft for good.

const crypto = require('node:crypto');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { AppError, ValidationError, ConflictError, ExternalServiceError } = require('../errors');
const { UUID_RE } = require('../tokens');
const { sendSMS, smsStatusCallbackUrl, twilioErrorText } = require('../sms');
const { LINE_KEYS, enabledLines, lineKeyForNumber } = require('../smsLines');
const { activeOptOut, isTwilioOptOutError, optedOutMessage, BAD_NUMBER_MESSAGE } = require('../smsOptOut');
const { sendToStaffRecipient } = require('../staffText');
const { TEXT_BODY_MAX, INBOX_TEXT_MESSAGE_TYPE, SEND_STALE_SECONDS } = require('./constants');
const cache = require('./cache');
const engine = require('./engine');
const { resolveTextTarget, textabilityFor } = require('./reply');
const { withFirstTextPrefix } = require('./firstText');
const { outboundThreadRow } = require('./thread');
const { failureReasonFor } = require('./readSms');

const RESERVE_SQL = `
  INSERT INTO inbox_sends (send_id, person_key, user_id) VALUES ($1, $2, $3)
  ON CONFLICT (send_id) DO NOTHING
  RETURNING send_id`;
const RESERVED_SQL = `
  SELECT person_key, user_id, result, created_at < NOW() - make_interval(secs => $2) AS stale
    FROM inbox_sends WHERE send_id = $1`;
const STORE_SQL = 'UPDATE inbox_sends SET result = $2::jsonb WHERE send_id = $1';
const RELEASE_SQL = 'DELETE FROM inbox_sends WHERE send_id = $1 AND result IS NULL';
// A client, a p- number or a t- lead: the row the Messages reply writes, plus
// the line and the send id. It returns the columns outboundThreadRow and this
// route read.
const INSERT_SQL = `
  INSERT INTO sms_messages
    (direction, client_id, recipient_phone, recipient_name, body, message_type, status, twilio_sid, error_message, sender_id, metadata)
  VALUES ('outbound', $1, $2, $3, $4, 'general', $5, $6, $7, $8, $9::jsonb)
  RETURNING id, body, status, error_message, metadata, created_at`;
// A failure the status callback stored before the INSERT sits in
// sms_status_orphans (lane sms-lines, amendment 19): the Messages reply's
// fold, so the row reads failed on the Messages page too, and the answer
// shows it. The orphan stays; the Inbox reader joins it either way.
const FOLD_SQL = `
  UPDATE sms_messages m SET status = 'failed', error_message = o.error_message
    FROM sms_status_orphans o
   WHERE m.id = $1 AND o.twilio_sid = m.twilio_sid
   RETURNING m.id, m.body, m.status, m.error_message, m.metadata, m.created_at`;

const UNRECORDED = 'The text may have gone out, but it could not be recorded. Check with them before sending it again.';

function checkRequest(input) {
  const errors = {};
  const text = typeof input.body === 'string' ? input.body.trim() : '';
  if (!text) errors.body = 'Write a message first.';
  else if (text.length > TEXT_BODY_MAX) errors.body = `A text can be at most ${TEXT_BODY_MAX} characters.`;
  if (!LINE_KEYS.includes(input.line)) errors.line = 'Pick the line to send from.';
  const sendId = typeof input.send_id === 'string' ? input.send_id.toLowerCase() : '';
  if (!UUID_RE.test(sendId)) errors.send_id = 'A send id is required.';
  // The first problem is the toast's copy, never the generic default.
  if (Object.keys(errors).length) throw new ValidationError(errors, Object.values(errors)[0]);
  return { text, line: input.line, sendId };
}

// A refusal exactly as the global error handler writes it (server/index.js).
function answerOf(err) {
  const body = { error: err.message, code: err.code };
  if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
  return { status: err.statusCode, body };
}

async function replay({ sendId, personKey, userId }, db) {
  const { rows } = await db.query(RESERVED_SQL, [sendId, SEND_STALE_SECONDS]);
  const r = rows[0];
  if (r && (r.person_key !== personKey || Number(r.user_id) !== Number(userId))) {
    throw new ConflictError('That send id belongs to another text.', 'INBOX_SEND_ID_REUSED');
  }
  if (r && !r.result && r.stale) throw new ConflictError(UNRECORDED, 'INBOX_SEND_UNRECORDED');
  if (!r || !r.result) throw new ConflictError('This text is still sending.', 'INBOX_SEND_IN_PROGRESS');
  return { status: r.result.status, body: r.result.body };
}

// Best effort: on an error the row stands as inserted (Inbox still reads the
// orphan), and the log names the row and the SQLSTATE, never a number or a
// body.
async function foldEarlyFailure(row, db) {
  try {
    const { rows } = await db.query(FOLD_SQL, [row.id]);
    return rows[0] || row;
  } catch (err) {
    console.error(`[inbox] could not fold an early failure callback into sms row ${row.id} (sqlstate ${(err && err.code) || 'none'})`);
    return row;
  }
}

async function sendToNumber({ target, body, line, sendId, userId }, db) {
  let sent = null;
  let failure = null;
  try {
    sent = await sendSMS({
      to: target.recipient, body, from: line, statusCallback: smsStatusCallbackUrl(),
      meta: { clientId: target.clientId, sentBy: userId, messageType: INBOX_TEXT_MESSAGE_TYPE },
    });
  } catch (err) {
    failure = err;
  }
  const { rows } = await db.query(INSERT_SQL, [
    target.clientId, target.recipient, target.client ? target.client.name || null : null, body,
    failure ? 'failed' : 'sent', sent && sent.sid ? sent.sid : null, failure ? twilioErrorText(failure) : null, userId,
    JSON.stringify({ line: lineKeyForNumber(sent && sent.from) || line, send_id: sendId }),
  ]);
  const row = sent && sent.sid ? await foldEarlyFailure(rows[0], db) : rows[0];
  return { row, failure };
}

// Staff go through the single-recipient core lane sms-lines extracted from the
// group send; it writes its own row (group_id, recipient_id, metadata).
async function sendToStaffer({ target, body, sendId, userId }, db) {
  const { status, row } = await sendToStaffRecipient({
    recipient: { ...target.staffRecipient, phone: target.recipient },
    body, senderId: userId, groupId: crypto.randomUUID(), messageType: 'general', shiftId: null,
    line: '888', sendId, statusCallback: smsStatusCallbackUrl(),
  }, db);
  return { row, failure: status === 'failed' ? new Error(row.error_message || 'Not sent') : null };
}

async function deliver({ personKey, text, line, sendId, userId, started }, db) {
  const { events, index } = await engine.getPersonEvents(personKey, { fresh: true });
  const target = await resolveTextTarget(personKey, { events, index }, db);
  if (!target.textable) throw new AppError(target.why, 422, 'INBOX_NOT_TEXTABLE');
  if (!enabledLines().includes(line)) {
    throw new AppError(`Texting from the ${line} is not turned on yet.`, 422, 'INBOX_LINE_NOT_ENABLED');
  }
  if (!target.lines.includes(line)) {
    const who = target.isStaff ? 'Staff are' : 'A Thumbtack number is';
    throw new AppError(`${who} texted from the 888 only.`, 422, 'INBOX_LINE_NOT_ALLOWED');
  }
  const check = await textabilityFor(target, db);
  if (!check.ok && check.reason === 'opted_out') throw new ConflictError(optedOutMessage(check.since), 'INBOX_OPTED_OUT');
  if (!check.ok && check.reason === 'bad_number') throw new AppError(BAD_NUMBER_MESSAGE, 422, 'INBOX_BAD_NUMBER');
  if (!check.ok) throw new AppError('There is no number to text.', 422, 'INBOX_NOT_TEXTABLE');
  const body = await withFirstTextPrefix({ body: text, line, to: target.recipient }, db);

  started(); // from here a second try could text twice, so the reservation stays
  const { row, failure } = target.isStaff
    ? await sendToStaffer({ target, body, sendId, userId }, db)
    : await sendToNumber({ target, body, line, sendId, userId }, db);
  if (failure) {
    // A 21610 has already written sms_optouts inside sendSMS (lane sms-lines).
    // The staff core reports only a failed row, so the record is its signal.
    // A lookup that errors falls back to no record: the text did not go out,
    // so the 502 below is the honest answer, never "may have gone out".
    const record = await activeOptOut(target.recipient, db).catch(() => null);
    if (isTwilioOptOutError(failure) || record) {
      throw new ConflictError(optedOutMessage(record ? record.opted_out_at : new Date()), 'INBOX_OPTED_OUT');
    }
    const code = /^Twilio (\d+)/.exec(String(row.error_message || ''));
    const reason = failureReasonFor(row.error_message);
    throw new ExternalServiceError(
      'twilio',
      new Error(`Inbox text failed: Twilio ${code ? code[1] : 'error'}`), // no number, no body
      `The text did not go out${reason ? `: ${reason}` : ''}. It is saved in the thread as failed.`
    );
  }
  return { status: 201, body: { message: outboundThreadRow(row, { channel: target.isStaff ? 'staff_text' : 'text' }) } };
}

async function sendInboxText({ personKey, body, user }, db = pool) {
  const { text, line, sendId } = checkRequest(body || {});
  const reserved = await db.query(RESERVE_SQL, [sendId, personKey, user.id]);
  if (!reserved.rowCount) return replay({ sendId, personKey, userId: user.id }, db);
  let sending = false;
  try {
    const result = await deliver({ personKey, text, line, sendId, userId: user.id, started: () => { sending = true; } }, db);
    await db.query(STORE_SQL, [sendId, JSON.stringify(result)]);
    return result;
  } catch (err) {
    if (err instanceof AppError) {
      const saving = db.query(STORE_SQL, [sendId, JSON.stringify(answerOf(err))]);
      // After a Twilio call the refusal (opted out, or the failed send) is the
      // truth; a save that fails must not turn it into a generic 500.
      await (sending ? saving.catch(() => {}) : saving);
      throw err;
    }
    if (!sending) {
      await db.query(RELEASE_SQL, [sendId]).catch(() => {});
      throw err;
    }
    // Twilio was called and something after it failed: never release the id.
    // Sentry gets a code-only error made here, never the raw one: a pg error's
    // detail can quote the failing row (the phone and the text). The staff
    // core's StaffTextUnrecordedError carries its SQLSTATE as sqlState.
    if (process.env.SENTRY_DSN_SERVER) {
      const sqlState = String(err.code || err.sqlState || 'none');
      Sentry.captureException(new Error(`Inbox text sent but not recorded: ${err.name || 'Error'} (${sqlState})`), {
        tags: { area: 'inbox_text', sqlstate: sqlState },
      });
    }
    console.error('[inbox] a text was sent but not recorded:', err.message);
    const unrecorded = new AppError(UNRECORDED, 500, 'INBOX_SEND_UNRECORDED');
    await db.query(STORE_SQL, [sendId, JSON.stringify(answerOf(unrecorded))]).catch(() => {});
    throw unrecorded;
  } finally {
    // Only a call to Twilio writes a row the engine reads; a refusal before it
    // keeps the snapshot its fresh read just loaded.
    if (sending) cache.invalidate();
  }
}

module.exports = { sendInboxText };
