// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const { pool } = require('../db');

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

/**
 * Classify a message body as an opt-out / opt-in keyword.
 * Matches only when the ENTIRE trimmed body is a single keyword (Twilio's
 * own STOP handling works the same way — "stop by later" is not an opt-out).
 *
 * @param {string} body
 * @returns {'stop'|'start'|null}
 */
function detectOptKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Classify a message body as a staff shift response code (spec section 3).
 * Whole-body match only — a code buried in a sentence is treated as
 * free-form text and routed to the admin instead.
 *
 * @param {string} body
 * @returns {'confirm'|'cant'|null}
 */
function detectResponseCode(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase().replace(/['’]/g, '');
  if (word === 'confirm') return 'confirm';
  if (word === 'cant') return 'cant';
  return null;
}

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

/**
 * Resolve an inbound phone number to its sender. Clients are checked first.
 *
 * @param {string} fromPhone - the inbound E.164 number (Twilio `From`)
 * @returns {Promise<
 *   {type:'client', client:{id:number,name:string,phone:string,communication_preferences:object,phone_status:string}} |
 *   {type:'staff', staffUserId:number, staff:{id:number,communication_preferences:object}} |
 *   {type:'unknown'}
 * >}
 */
async function lookupSender(fromPhone) {
  const key = last10(fromPhone);
  if (!key) return { type: 'unknown' };

  const c = await pool.query(
    `SELECT id, name, phone, communication_preferences, phone_status
     FROM clients
     WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [key]
  );
  if (c.rows[0]) return { type: 'client', client: c.rows[0] };

  const s = await pool.query(
    `SELECT u.id, u.communication_preferences
     FROM contractor_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = $1
     ORDER BY cp.updated_at DESC
     LIMIT 1`,
    [key]
  );
  if (s.rows[0]) return { type: 'staff', staffUserId: s.rows[0].id, staff: s.rows[0] };

  return { type: 'unknown' };
}

/**
 * Insert an inbound message into sms_messages. For an inbound row,
 * recipient_phone holds the SENDER's number (the external party) so the
 * column reads as "the other party's phone" for both directions; client_id
 * is the canonical link for the thread UI. The body is truncated and the
 * sender phone is defaulted so a malformed Twilio payload cannot violate the
 * NOT NULL / length constraints.
 *
 * @param {Object} args
 * @param {string} args.fromPhone - inbound E.164 sender number
 * @param {string} args.body - message text (may be empty)
 * @param {number|null} args.clientId - matched clients.id, or null
 * @param {string} [args.twilioSid] - Twilio MessageSid
 * @param {Object} [args.metadata] - extra metadata to merge
 * @returns {Promise<Object>} the inserted row
 */
async function recordInboundMessage({ fromPhone, body, clientId, twilioSid, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  const meta = { from: fromPhone || null, to: process.env.TWILIO_PHONE_NUMBER || null, ...(metadata || {}) };
  const result = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata)
     VALUES ('inbound', $1, $2, $3, 'general', 'received', $4, $5)
     RETURNING *`,
    [clientId || null, phone, text, twilioSid || null, JSON.stringify(meta)]
  );
  return result.rows[0];
}

/**
 * Set communication_preferences.sms_enabled = <value> for the matched sender
 * and append a STOP/START audit timestamp. No-op for an unknown sender (a
 * number with no client/staff row). The audit path is a static literal
 * (auditPath is a controlled internal constant, not user input) because
 * jsonb_set requires a text[] path.
 *
 * @param {Object} sender - a lookupSender(...) result
 * @param {boolean} enabled
 */
async function setSmsEnabled(sender, enabled) {
  // Static-literal jsonb path — '{sms_opt_in_at}' or '{sms_opt_out_at}'.
  const auditPath = enabled ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";
  // COALESCE guards a NULL communication_preferences column.
  if (sender.type === 'client') {
    await pool.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.client.id, JSON.stringify(enabled)]
    );
  } else if (sender.type === 'staff') {
    await pool.query(
      `UPDATE users
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.staffUserId, JSON.stringify(enabled)]
    );
  }
  // sender.type === 'unknown' → nothing to update
}

/** Opt the sender OUT of SMS (STOP keyword). */
async function applyOptOut(sender) {
  await setSmsEnabled(sender, false);
}

/** Opt the sender back IN to SMS (START keyword). */
async function applyOptIn(sender) {
  await setSmsEnabled(sender, true);
}

module.exports = {
  detectOptKeyword,
  detectResponseCode,
  lookupSender,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
};
