// The three DRB text lines and the rules for which one a human reply leaves
// from (spec 2026-10-06, Inbox, decisions 9, 19 and 20, section 5.8). Pure:
// it reads only process.env, at call time, so a test can set it.
//
// The 888 is TWILIO_PHONE_NUMBER. The two 224 numbers are fixed constants:
// they are public company numbers, and the voice env vars that also hold
// them (CONSULT_CALLER_ID, VOICE_CALLER_ID) fall back to each other, so
// reusing those for sending could text from the wrong line.

const { last10 } = require('./phone');

const LINE_KEYS = Object.freeze(['888', '1922', '0082']);

const FIXED_LINES = new Map([
  ['1922', '+12242221922'],
  ['0082', '+12242220082'],
]);

// Each sender's own line: the default when a person has no human-involved
// text yet. Dallas is users 1 (admin) and 12 (his staff account); Zul is 2.
const OWN_LINES = new Map([[1, '1922'], [12, '1922'], [2, '0082']]);

/** The E.164 for a line key, or null (an unknown key, or an unset 888). */
function lineE164(key) {
  if (key === '888') return process.env.TWILIO_PHONE_NUMBER || null;
  return FIXED_LINES.get(key) || null;
}

/** Which of our lines a number is (last-10 match), or null for any other number. */
function lineKeyForNumber(phone) {
  const key = last10(phone);
  if (!key) return null;
  for (const line of LINE_KEYS) {
    const number = lineE164(line);
    if (number && last10(number) === key) return line;
  }
  return null;
}

/**
 * The lines a human reply may leave from: INBOX_TEXT_LINES, a comma or space
 * separated list, default '888'. Unknown keys are dropped and the 888 is
 * always on. A 224 line is added only after its round trip (decision 19).
 */
function enabledLines() {
  const wanted = new Set(String(process.env.INBOX_TEXT_LINES || '888').split(/[\s,]+/).filter(Boolean));
  wanted.add('888');
  return LINE_KEYS.filter((k) => wanted.has(k));
}

/** The sender's own line: the 1922 for Dallas, the 0082 for Zul, else the 888. */
function ownLineForUser(userId) {
  return OWN_LINES.get(Number(userId)) || '888';
}

/**
 * The lines a person may be texted from. Staff get the 888 only (decision 20:
 * the 224 campaign is customer care, and staff know the 888 from shift texts);
 * a Thumbtack proxy number gets the 888 only (the line registered with
 * Thumbtack). Anyone else gets the enabled lines.
 */
function allowedLines({ isStaff = false, isProxy = false } = {}) {
  return isStaff || isProxy ? ['888'] : enabledLines();
}

/**
 * Decision 9: keep each person on one number. The line of the most recent
 * human-involved text with them (their texts, our human replies; the caller
 * reads it, an older row with no line reads as '888'), else the sender's own
 * line. A default that is not allowed for this person falls back to the 888.
 * A lastHumanLine that is not a line key reads as the 888, as an unknown To does.
 */
function defaultLine({ lastHumanLine = null, senderUserId = null, isStaff = false, isProxy = false } = {}) {
  const allowed = allowedLines({ isStaff, isProxy });
  let preferred;
  if (lastHumanLine === null || lastHumanLine === undefined) preferred = ownLineForUser(senderUserId);
  else preferred = LINE_KEYS.includes(lastHumanLine) ? lastHumanLine : '888';
  return allowed.includes(preferred) ? preferred : '888';
}

// When a row happened, for "most recent": created_at, oldest when missing or unreadable.
function rowTime(row) {
  const t = row.created_at ? new Date(row.created_at).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * The DRB line of the most recent human-involved text in `rows` (sms_messages
 * rows carrying direction, sender_id, status, metadata, created_at and id).
 * One rule for the Messages reply and Inbox, decision 9:
 *   - their inbound texts count, Thumbtack relay rows included: a proxy number
 *     only ever texts the 888, so a relay row is their 888 text;
 *   - our outbound rows count only with a sender (a human) and a status that
 *     is not 'failed' (a failed reply never reached them); automated sends
 *     never move the line.
 * An inbound row's line is its metadata.to and an outbound row's is
 * metadata.line; an older row carrying neither, or a To that is not ours,
 * reads as the 888. Order does not matter: the newest qualifying row wins
 * (created_at, then id).
 *
 * @param {Array<Object>} rows
 * @returns {'888'|'1922'|'0082'|null} null when no row qualifies
 */
function lastHumanLineFromRows(rows) {
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const theirs = row.direction === 'inbound';
    const ourHuman = row.direction === 'outbound'
      && row.sender_id !== null && row.sender_id !== undefined
      && row.status !== 'failed';
    if (!theirs && !ourHuman) continue;
    if (!best || rowTime(row) > rowTime(best)
      || (rowTime(row) === rowTime(best) && Number(row.id || 0) > Number(best.id || 0))) {
      best = row;
    }
  }
  if (!best) return null;
  const meta = best.metadata || {};
  if (best.direction === 'inbound') {
    if (meta.thumbtack_relay === true || meta.thumbtack_relay === 'true') return '888';
    return lineKeyForNumber(meta.to) || '888';
  }
  return LINE_KEYS.includes(meta.line) ? meta.line : '888';
}

module.exports = {
  LINE_KEYS, lineE164, lineKeyForNumber, enabledLines, ownLineForUser, allowedLines, defaultLine,
  lastHumanLineFromRows,
};
