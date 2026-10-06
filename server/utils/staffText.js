// The single-recipient staff text, extracted from POST /api/messages/send
// (spec 2026-10-06, Inbox, section 9) so the Inbox staff composer sends the
// way the group send always has: eligibility, consent, one Twilio send, one
// sms_messages row carrying group_id, sender_id and recipient_id.
//
// POST /api/messages/send keeps its exact behavior on top of these: it passes
// no line, no status callback and no send id, so sendSMS sends from
// TWILIO_PHONE_NUMBER as before and the row's metadata stays {}. The core does
// NOT check users.communication_preferences.sms_enabled (the group send never
// has); the Inbox caller runs textability() before calling it.

const { pool } = require('../db');
const { sendSMS, normalizePhone, twilioErrorText } = require('./sms');
const { lineKeyForNumber } = require('./smsLines');

/**
 * The send-eligible staff among `userIds`: role staff or manager, onboarding
 * submitted, reviewed or approved, with a contractor profile and an agreement
 * row (the inner joins the group send has always used). Consent and phone are
 * NOT filtered: an eligible staffer without consent or a usable phone still
 * gets a failed row. `name` is the display name, else the preferred name (the
 * label sms_messages.recipient_name has always carried).
 *
 * @param {number[]} userIds
 * @param {Object} [db] pg pool or client
 * @returns {Promise<Array<{id:number, name:string|null, phone:string|null, sms_consent:boolean|null,
 *   sms_enabled:boolean, communication_preferences:Object}>>}
 */
async function loadEligibleStaffRecipients(userIds, db = pool) {
  const r = await db.query(`
    SELECT u.id, cp.preferred_name, cp.display_name, cp.phone, ag.sms_consent, u.communication_preferences
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    JOIN agreements ag ON ag.user_id = u.id
    WHERE u.id = ANY($1)
      AND u.role IN ('staff', 'manager')
      AND u.onboarding_status IN ('submitted', 'reviewed', 'approved')
  `, [userIds]);
  return r.rows.map((row) => ({
    id: row.id,
    name: row.display_name || row.preferred_name,
    phone: row.phone,
    sms_consent: row.sms_consent,
    sms_enabled: !(row.communication_preferences && row.communication_preferences.sms_enabled === false),
    communication_preferences: row.communication_preferences || {},
  }));
}

/**
 * A staff text whose sms_messages row did not save (spec 2026-10-06,
 * amendment 29). sendToStaffRecipient throws it after the send, so a
 * single-recipient caller surfaces the lost record: it is NOT an AppError, so
 * the Inbox text route answers 500 INBOX_SEND_UNRECORDED. The group send
 * catches it, logs it and carries on. Its message names neither the number nor
 * the text. sendStatus says whether Twilio took the text; errorMessage is the
 * failure text the row would have stored (null when sent; for a group send it
 * is Twilio's raw message, which can quote the number, so it is for the
 * response and never for a log); sqlState is the database error's code.
 * The database error itself is deliberately NOT carried (no `cause`): a pg
 * error's detail can read "Failing row contains (...)" with the phone and the
 * text, and anything that ever logged this error object would print it.
 */
class StaffTextUnrecordedError extends Error {
  constructor({ sendStatus, errorMessage = null, recipientId, sqlState = null }) {
    super(`A staff text was ${sendStatus === 'sent' ? 'sent' : 'not sent'} but its record did not save`);
    this.name = 'StaffTextUnrecordedError';
    this.sendStatus = sendStatus;
    this.errorMessage = errorMessage;
    this.recipientId = recipientId;
    this.sqlState = sqlState;
  }
}

/**
 * Text one staffer and record the attempt: no consent and an unusable phone
 * are failed rows with no Twilio call, and a Twilio throw is a failed row
 * carrying its message (an Inbox send, one with a sendId, stores
 * twilioErrorText instead). One INSERT, made right after this recipient's send.
 *
 * @param {Object} args
 * @param {Object} args.recipient - a loadEligibleStaffRecipients row
 * @param {string} args.body - already trimmed
 * @param {number} args.senderId - users.id of the human sending
 * @param {string} args.groupId - UUID shared by one send's rows
 * @param {string} [args.messageType='general']
 * @param {number|null} [args.shiftId=null]
 * @param {string} [args.line] - smsLines key; omitted sends from the 888 as the group send always has
 * @param {string} [args.sendId] - the Inbox send's client-generated id, stored as metadata.send_id
 * @param {string} [args.statusCallback] - Twilio status callback URL
 * @param {Object} [db] pg pool or client
 *   Never pass a transaction client: the Twilio call would hold it open.
 * @returns {Promise<{status:'sent'|'failed', row:Object}>}
 * @throws {StaffTextUnrecordedError} when the row does not save
 */
async function sendToStaffRecipient({
  recipient, body, senderId, groupId, messageType = 'general', shiftId = null, line, sendId, statusCallback,
}, db = pool) {
  const normalized = normalizePhone(recipient.phone);
  let recipientPhone = recipient.phone || 'none';
  let status = 'failed';
  let twilioSid = null;
  let errorMessage = null;
  let fromNumber = null;

  if (!recipient.sms_consent) {
    errorMessage = 'No SMS consent';
  } else if (!normalized) {
    errorMessage = 'Invalid phone number';
  } else {
    recipientPhone = normalized;
    const args = { to: normalized, body };
    if (line) args.from = line;
    if (statusCallback) args.statusCallback = statusCallback;
    try {
      const message = await sendSMS(args);
      twilioSid = message.sid;
      fromNumber = message.from || null;
      // Set only after the result is read: if reading it throws, the row stays failed.
      status = 'sent';
    } catch (smsErr) {
      // An Inbox send (it carries a sendId) stores the one failure text; the
      // group send keeps the raw message it has always stored.
      errorMessage = sendId ? twilioErrorText(smsErr) : smsErr.message;
    }
  }

  const metadata = {};
  if (line) metadata.line = lineKeyForNumber(fromNumber) || line;
  if (sendId) metadata.send_id = sendId;

  let r;
  try {
    r = await db.query(
      `INSERT INTO sms_messages (direction, group_id, sender_id, recipient_id, recipient_phone, recipient_name,
                                 body, message_type, shift_id, twilio_sid, status, error_message, metadata)
       VALUES ('outbound', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [groupId, senderId, recipient.id, recipientPhone, recipient.name, body, messageType, shiftId,
        twilioSid, status, errorMessage, JSON.stringify(metadata)]
    );
  } catch (dbErr) {
    throw new StaffTextUnrecordedError({
      sendStatus: status, errorMessage, recipientId: recipient.id, sqlState: (dbErr && dbErr.code) || null,
    });
  }
  return { status, row: r.rows[0] };
}

module.exports = { loadEligibleStaffRecipients, sendToStaffRecipient, StaffTextUnrecordedError };
