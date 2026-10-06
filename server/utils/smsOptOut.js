// The per-phone SMS opt-out record and the one textability rule (spec
// 2026-10-06, Inbox, decision 10 and section 5.8).
//
// sms_optouts holds one row per phone, keyed by last10 (server/utils/phone.js),
// the key the inbound matcher uses. A STOP-set word to any DRB line from any
// sender writes it, and so does Twilio error 21610 (an unsubscribed recipient)
// at send time or in the status callback. START or UNSTOP clears it by
// stamping cleared_at (a YES never does, spec amendment 32); the row stays as
// history. Twilio keeps opt-outs per sending number (the 888 and the 224
// Messaging Service are separate domains there); this record is what makes
// one STOP cover every line here.
//
// textability() answers "may a human text this person" for the Messages reply
// and Inbox, which both ask it. The admin group send (POST /api/messages/send)
// is a human send that does not: it checks agreement consent only. Automated
// sends do not ask it yet (fix list).

const { pool } = require('../db');
const { last10 } = require('./phone');
const { LINE_KEYS } = require('./smsLines');
const { shouldSendImmediate } = require('./messageSuppression');

const SOURCES = new Set(['keyword', 'twilio_21610', 'backfill']);
const KINDS = new Set(['client', 'staff', 'unknown']);
const TWILIO_OPTED_OUT = 21610;
const BAD_NUMBER_MESSAGE = "This number can't receive texts.";

/** True when a Twilio error says the recipient has opted out of this sender. */
function isTwilioOptOutError(err) {
  return Boolean(err) && Number(err.code) === TWILIO_OPTED_OUT;
}

/**
 * Record, or re-activate, the opt-out for a phone. Upsert by last 10 digits.
 * A repeat while the row is active keeps its date, source and line: it is the
 * same opt-out. A row a START cleared starts a fresh opt-out from now. A
 * number with fewer than 10 digits is a no-op; an unknown line is stored NULL.
 *
 * @param {{phone:string, source:'keyword'|'twilio_21610'|'backfill', line?:string|null}} args
 * @param {Object} [db] pg pool or client
 */
async function recordOptOut({ phone, source, line = null }, db = pool) {
  if (!SOURCES.has(source)) throw new Error(`recordOptOut: unknown source "${source}"`);
  const key = last10(phone);
  if (!key) return;
  const lineKey = LINE_KEYS.includes(line) ? line : null;
  await db.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line, cleared_at)
     VALUES ($1, NOW(), $2, $3, NULL)
     ON CONFLICT (phone_last10) DO UPDATE SET
       opted_out_at = CASE WHEN sms_optouts.cleared_at IS NULL THEN sms_optouts.opted_out_at ELSE EXCLUDED.opted_out_at END,
       source       = CASE WHEN sms_optouts.cleared_at IS NULL THEN sms_optouts.source       ELSE EXCLUDED.source END,
       line         = CASE WHEN sms_optouts.cleared_at IS NULL THEN sms_optouts.line         ELSE EXCLUDED.line END,
       cleared_at   = NULL`,
    [key, source, lineKey]
  );
}

/** Clear a phone's opt-out (START or UNSTOP). No row, or a cleared one, is a no-op. */
async function clearOptOut({ phone }, db = pool) {
  const key = last10(phone);
  if (!key) return;
  await db.query(
    'UPDATE sms_optouts SET cleared_at = NOW() WHERE phone_last10 = $1 AND cleared_at IS NULL',
    [key]
  );
}

/** The phone's active opt-out ({ opted_out_at, source, line }), or null. */
async function activeOptOut(phone, db = pool) {
  const key = last10(phone);
  if (!key) return null;
  const r = await db.query(
    'SELECT opted_out_at, source, line FROM sms_optouts WHERE phone_last10 = $1 AND cleared_at IS NULL',
    [key]
  );
  return r.rows[0] || null;
}

// True when the row carries the column at all (a SELECT that left it out).
function hasColumn(row, column) {
  return Object.prototype.hasOwnProperty.call(row, column);
}

// communication_preferences.sms_opt_out_at is the NOW()::text stamp
// setSmsEnabled writes on STOP. Missing or unparseable is "date unknown".
function stampDate(prefs) {
  const raw = prefs && prefs.sms_opt_out_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * May a human text this person (spec 5.8)? One rule for the Messages reply,
 * the Inbox text route and the Inbox reply box:
 *   - no usable phone                        -> no_phone
 *   - an active sms_optouts row (any kind)   -> opted_out, since = its date
 *   - client: no clients row given           -> no_phone
 *   - client: sms_enabled false              -> opted_out, since = the STOP stamp
 *   - client: phone_status 'bad'             -> bad_number (not an opt-out)
 *   - staff: sms_enabled false               -> opted_out, since = the STOP stamp
 *   - staff: agreement sms_consent not true  -> opted_out, date unknown
 * The client checks are messageSuppression.shouldSendImmediate's, so this can
 * never disagree with what an immediate automated send would allow.
 * A caller mistake throws instead of reading as ok: an unknown kind, a staff
 * check without the users row, or a clients row selected without
 * communication_preferences or phone_status.
 *
 * @param {Object} args
 * @param {'client'|'staff'|'unknown'} args.kind
 * @param {Object} [args.client] - clients row with communication_preferences, phone_status
 * @param {Object} [args.user] - users row with communication_preferences
 * @param {Object} [args.agreement] - agreements row with sms_consent
 * @param {string} args.phone - the number that would be texted
 * @param {Object} [db]
 * @returns {Promise<{ok:true} | {ok:false, reason:'opted_out'|'bad_number'|'no_phone', since:Date|null}>}
 * @throws {TypeError} on a caller mistake (above), before anything is read
 */
async function textability({ kind, client = null, user = null, agreement = null, phone } = {}, db = pool) {
  if (!KINDS.has(kind)) throw new TypeError('textability: kind must be client, staff or unknown');
  if (kind === 'staff' && (!user || !hasColumn(user, 'communication_preferences'))) {
    throw new TypeError('textability: a staff check needs the users row with communication_preferences');
  }
  if (kind === 'client' && client
    && (!hasColumn(client, 'communication_preferences') || !hasColumn(client, 'phone_status'))) {
    throw new TypeError('textability: a clients row needs communication_preferences and phone_status');
  }
  if (!last10(phone)) return { ok: false, reason: 'no_phone', since: null };
  const record = await activeOptOut(phone, db);
  if (record) return { ok: false, reason: 'opted_out', since: record.opted_out_at };
  if (kind === 'client') {
    if (!client) return { ok: false, reason: 'no_phone', since: null };
    const verdict = await shouldSendImmediate({ proposal: null, client, channel: 'sms' });
    if (!verdict.ok && verdict.reason === 'channel_disabled') {
      return { ok: false, reason: 'opted_out', since: stampDate(client.communication_preferences) };
    }
    if (!verdict.ok) return { ok: false, reason: 'bad_number', since: null };
  }
  if (kind === 'staff') {
    const prefs = (user && user.communication_preferences) || {};
    if (prefs.sms_enabled === false) return { ok: false, reason: 'opted_out', since: stampDate(prefs) };
    if (!agreement || agreement.sms_consent !== true) return { ok: false, reason: 'opted_out', since: null };
  }
  return { ok: true };
}

/** The refusal copy for an opted-out person, with the Chicago date when known (decision 28). */
function optedOutMessage(since) {
  const d = since instanceof Date && !Number.isNaN(since.getTime()) ? since : null;
  const when = d
    ? ` since ${d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  return `Texts are off for this person${when}. Texts from 888, 1922 or 0082 will not deliver.`;
}

module.exports = {
  recordOptOut, clearOptOut, activeOptOut, textability,
  isTwilioOptOutError, optedOutMessage, BAD_NUMBER_MESSAGE,
};
