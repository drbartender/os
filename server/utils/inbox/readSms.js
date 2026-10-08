'use strict';

// Reader: sms_messages (spec 5.1 and 5.2). Pass 1 reads light headers for every
// row since the history floor and ships no body longer than 12 characters,
// which is enough to classify a bare keyword or a CONFIRM / CANT. Pass 2
// (loadSmsDetails) loads bodies, media and failure reasons for the people the
// rules keep (5.7).

const { last10 } = require('../phone');
const { lineKeyForNumber, LINE_KEYS } = require('../smsLines');
const { UNAMBIGUOUS_STOP_WORDS, UNAMBIGUOUS_START_WORDS } = require('./constants');

// The relay-notice test is constants.RELAY_NOTICE_WORDS spelled in SQL
// (readers.test.js pins the two equal). has_media is a CASE, not an AND: SQL
// does not promise to evaluate the type test before jsonb_array_length.
// btrim() only guards old rows: processInboundSms stores every inbound body
// already trimmed, so JS and SQL agree on every stored row.
// A failure Twilio reported before the sending request wrote its row lands in
// lane sms-lines' sms_status_orphans (amendment 19): a row whose SID is there
// reads as failed. The engine and the acceptance check (Task 18) both run the
// default SQL, with this join: prod has had the table since lane sms-lines
// shipped (2026-10-07). withOrphans: false remains for a database without it.
//
// relay_quoted (Task 18 F1): on prod a relay notice quotes the customer's
// words, below Thumbtack's boilerplate and a line of three or more dashes
// (spaces or tabs around them allowed). True only for a Thumbtack relay row
// with the notice words and such a line followed later by non-blank text. The
// header and the details SQL share it, so pass 2 cuts exactly the rows pass 1
// called quoted, and a text that is not a relay notice is never cut.
const RELAY_QUOTED_SQL = `(COALESCE(m.metadata->>'thumbtack_relay', '') = 'true'
            AND m.body ~* 'replied to you on thumbtack'
            AND m.body ~ '(^|\\n)[[:blank:]]*-{3,}[[:blank:]]*\\r?\\n.*\\S')`;

function smsHeadersSql({ withOrphans = true } = {}) {
  const status = withOrphans ? "CASE WHEN o.twilio_sid IS NOT NULL THEN 'failed' ELSE m.status END" : 'm.status';
  const join = withOrphans ? "\n    LEFT JOIN sms_status_orphans o ON o.twilio_sid = m.twilio_sid AND m.direction = 'outbound'" : '';
  return `
  SELECT m.id, m.direction, m.client_id, m.sender_id, m.recipient_id, m.recipient_phone,
         m.metadata->>'from' AS from_phone,
         m.metadata->>'to' AS to_phone,
         m.metadata->>'line' AS line,
         m.metadata->>'outcome' AS outcome,
         m.metadata->>'opt_keyword' AS opt_keyword,
         COALESCE(m.metadata->>'thumbtack_relay', '') = 'true' AS relay,
         (m.body ~* 'replied to you on thumbtack') AS relay_notice,
         ${RELAY_QUOTED_SQL} AS relay_quoted,
         ${status} AS status, m.twilio_sid, m.message_type, m.created_at, m.processed,
         (btrim(m.body) = '') AS empty_body,
         CASE WHEN jsonb_typeof(m.metadata->'media') = 'array'
              THEN jsonb_array_length(m.metadata->'media') > 0 ELSE false END AS has_media,
         CASE WHEN length(btrim(m.body)) <= 12 THEN lower(btrim(m.body)) END AS short_word,
         COUNT(*) OVER (PARTITION BY m.group_id)::int AS group_size
    FROM sms_messages m${join}
   WHERE m.created_at >= $1`;
}
const SMS_HEADERS_SQL = smsHeadersSql();

const SMS_DETAILS_SQL = `
  SELECT m.id, m.body, m.metadata->'media' AS media, COALESCE(m.error_message, o.error_message) AS error_message,
         ${RELAY_QUOTED_SQL} AS relay_quoted
    FROM sms_messages m
    LEFT JOIN sms_status_orphans o ON o.twilio_sid = m.twilio_sid AND m.direction = 'outbound'
   WHERE m.id = ANY($1::int[])`;

// Lane sms-lines: of every outcome it records, only these two changed a shift,
// so only these are skipped as inbound (spec 5.3).
const SHIFT_COMMAND_OUTCOMES = new Set(['staff_confirm', 'staff_cant']);

// An outcome decides by itself, whatever person the phone resolves to (a
// staffer whose phone is also a client's is keyed c-). With no outcome: a row
// whose handling has not finished (processed false) counts as inbound
// (amendment 27); a settled row from before lane sms-lines follows the old
// rule, under which every whole-body CONFIRM or CANT from a staff phone ran as
// a shift command on every line (smsInbound.detectResponseCode: trimmed,
// lower-cased, apostrophes stripped).
function isShiftCommand(row, { staff = false } = {}) {
  if (row.outcome) return SHIFT_COMMAND_OUTCOMES.has(row.outcome);
  if (row.processed === false || !staff) return false;
  const word = String(row.short_word || '').replace(/['’]/g, '');
  return word === 'confirm' || word === 'cant';
}

// Plain words for the Twilio codes a send or the status callback reports. The
// callback stores "Twilio <code> (<status>)" (lane sms-lines).
const TWILIO_REASONS = new Map([
  ['21211', 'Not a valid phone number'],
  ['21610', 'The person has opted out of texts'],
  ['21614', 'Not a mobile number'],
  ['30003', 'The phone is unreachable'],
  ['30004', 'The message was blocked'],
  ['30005', 'Unknown or inactive number'],
  ['30006', 'A landline or an unreachable carrier'],
  ['30007', 'Filtered by the carrier'],
  ['30008', 'Unknown delivery error'],
]);

function failureReasonFor(errorMessage) {
  if (!errorMessage) return null;
  if (/^Twilio (error \(|send failed)/.test(String(errorMessage))) return null;
  const m = /^Twilio (\d+)/.exec(String(errorMessage));
  if (!m) return String(errorMessage);
  const words = TWILIO_REASONS.get(m[1]);
  return words ? `${words} (Twilio ${m[1]})` : `Twilio error ${m[1]}`;
}

// The customer's words in a quoted relay notice: everything after the first
// rule line (the SQL's line: start or a newline, the dashes, then a newline),
// trimmed. Never the boilerplate, the link, or the name before "replied to you
// on Thumbtack". '' when nothing follows it.
const RELAY_RULE_LINE = /(^|\n)[ \t]*-{3,}[ \t]*\r?\n/;

function relayQuotedWords(body) {
  const text = String(body || '');
  const m = RELAY_RULE_LINE.exec(text);
  return m ? text.slice(m.index + m[0].length).trim() : '';
}

// Only https media links reach the page.
function cleanMedia(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter((m) => m && typeof m.url === 'string' && /^https:\/\//i.test(m.url))
    .map((m) => ({ url: m.url, content_type: typeof m.content_type === 'string' ? m.content_type : null }));
}

function mapSmsHeader(row, index) {
  const inbound = row.direction === 'inbound';
  const phone = inbound ? (row.from_phone || row.recipient_phone) : row.recipient_phone;
  const k = last10(phone);
  if (k && index.own.has(k)) return null; // our own numbers never form an item (5.2)
  let key = null;
  let relayLead = null;
  if (inbound && row.relay) {
    relayLead = k ? index.leadForProxy(k, row.created_at) : null;
    if (relayLead) key = index.leadKey(relayLead);
  }
  if (!key && row.client_id) key = `c-${row.client_id}`;
  if (!key && !inbound && row.recipient_id && index.staffEligible.has(Number(row.recipient_id))) key = `s-${row.recipient_id}`;
  if (!key) key = index.resolvePhone(k, row.created_at);
  if (!key) return null;
  const staff = key.startsWith('s-');
  const word = row.short_word || null;
  const meta = {
    source: 'sms', id: Number(row.id), inbound, phone: phone || null, word, optWord: false,
    twilioSid: row.twilio_sid || null, messageType: row.message_type || null,
    optKeyword: row.opt_keyword || null, outcome: row.outcome || null,
    empty: Boolean(row.empty_body) && !row.has_media, groupSize: Number(row.group_size) || 1,
  };
  const base = { ref: `sms:${row.id}`, personKey: key, channel: staff ? 'staff_text' : 'text', at: new Date(row.created_at), text: undefined, meta };
  if (!inbound) {
    meta.smsSenderId = row.sender_id ? Number(row.sender_id) : null;
    meta.failed = row.status === 'failed';
    return { ...base, line: LINE_KEYS.includes(row.line) ? row.line : '888', direction: 'out', author: meta.smsSenderId || 'auto', kind: 'message' };
  }
  const line = lineKeyForNumber(row.to_phone) || '888'; // an unknown or missing To is the 888 (spec 9)
  if (row.relay) {
    meta.relay = true;
    meta.relayNotice = Boolean(row.relay_notice);
    meta.relayQuoted = Boolean(row.relay_quoted);
    meta.relayLeadName = relayLead ? (relayLead.customer_name || null) : null;
    meta.relayNegotiationId = relayLead ? String(relayLead.negotiation_id) : null;
  }
  if (word && (UNAMBIGUOUS_STOP_WORDS.has(word) || UNAMBIGUOUS_START_WORDS.has(word))) {
    meta.optWord = true;
    return { ...base, line, direction: 'system', author: null, kind: UNAMBIGUOUS_STOP_WORDS.has(word) ? 'opt_out' : 'opt_in' };
  }
  if (isShiftCommand(row, { staff })) meta.skip = 'shift_command';
  return { ...base, line, direction: 'in', author: null, kind: row.has_media ? 'media' : 'message' };
}

async function loadSmsDetails(ids, db) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(SMS_DETAILS_SQL, [ids]);
  return new Map(rows.map((r) => [`sms:${r.id}`, {
    text: r.relay_quoted ? relayQuotedWords(r.body) : r.body,
    media: cleanMedia(r.media), failureReason: failureReasonFor(r.error_message),
  }]));
}

module.exports = {
  SMS_HEADERS_SQL, SMS_DETAILS_SQL, smsHeadersSql, mapSmsHeader, loadSmsDetails, failureReasonFor, isShiftCommand,
  relayQuotedWords,
};
