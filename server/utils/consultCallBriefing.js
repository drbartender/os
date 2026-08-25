/**
 * Spoken copy for the consult call bridge (spec 2026-08-25 section 4.4).
 *
 * Pure text builders: consult/proposal facts in, plain sentences out. The
 * TwiML layer owns xmlEscape (this module must NOT escape, or the escaping
 * would double up), exactly as `leadCallBriefing.js` does. Absent fields are
 * skipped, never spoken as "unknown".
 *
 * Why this file carries its own date helper instead of reusing the lead
 * bridge's `spokenEventDate`: the two inputs are different KINDS of value.
 * `consults.scheduled_at` is a TIMESTAMPTZ, a real instant, and is spoken in
 * Chicago wall-clock time. `proposals.event_date` is a Postgres DATE, which
 * node-pg hands back as a JS Date at PROCESS-LOCAL midnight. Formatting that
 * Date as an instant in America/Chicago prints the day BEFORE on Render (which
 * runs UTC) while looking correct on a Chicago dev box. `spokenDateOnly`
 * therefore reads the calendar fields and re-anchors them at UTC noon, so the
 * spoken day is the stored day in every process timezone.
 */

const CHICAGO = 'America/Chicago';

/**
 * Chicago wall-clock hour/minute/dayPeriod for an instant, or null when the
 * value is not a parseable instant.
 */
function clockParts(instant) {
  if (instant === null || instant === undefined) return null;
  const when = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(when.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(when);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return { hour: get('hour'), minute: get('minute'), dayPeriod: get('dayPeriod') };
}

/**
 * "10 AM" on the hour, "10:15 AM" otherwise. A spoken "ten oh oh AM" reads
 * badly, so the zero minutes are dropped.
 *
 * @param {Date|string} instant TIMESTAMPTZ value
 * @returns {string|null}
 */
function spokenClockTime(instant) {
  const p = clockParts(instant);
  if (!p) return null;
  return p.minute === '00' ? `${p.hour} ${p.dayPeriod}` : `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * "10:00 AM" always. Texted copy keeps the minutes: written down, "10 AM"
 * reads as an approximation and "10:00 AM" reads as an appointment.
 *
 * @param {Date|string} instant TIMESTAMPTZ value
 * @returns {string|null}
 */
function clockTimeWithMinutes(instant) {
  const p = clockParts(instant);
  if (!p) return null;
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * "Saturday October 10th" for a calendar DATE, independent of the process
 * timezone. Accepts a Date (read by its LOCAL calendar fields, which is how
 * node-pg materializes a DATE) or a 'YYYY-MM-DD...' string (first 10 chars).
 *
 * @param {Date|string} value proposals.event_date
 * @returns {string|null} null on anything unparseable
 */
function spokenDateOnly(value) {
  let y;
  let m;
  let d;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    y = value.getFullYear();
    m = value.getMonth();
    d = value.getDate();
  } else if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!match) return null;
    y = Number(match[1]);
    m = Number(match[2]) - 1;
    d = Number(match[3]);
  } else {
    return null;
  }

  // Noon UTC, so no timezone offset can push the formatted day off by one.
  const anchored = new Date(Date.UTC(y, m, d, 12));
  if (Number.isNaN(anchored.getTime())) return null;
  // Rejects a rolled-over date ('2026-13-45' would silently become 2027-02-14).
  if (
    anchored.getUTCFullYear() !== y
    || anchored.getUTCMonth() !== m
    || anchored.getUTCDate() !== d
  ) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).formatToParts(anchored);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const day = Number(get('day'));
  const suffix =
    day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
    : day % 10 === 3 && day !== 13 ? 'rd'
    : 'th';
  return `${get('weekday')} ${get('month')} ${day}${suffix}`;
}

/**
 * "+12563281203" -> "256-328-1203" for texted and spoken copy. Anything that
 * is not a US E.164 number comes back exactly as given.
 */
function formatUsPhoneForText(e164) {
  const s = String(e164 === null || e164 === undefined ? '' : e164);
  if (!/^\+1\d{10}$/.test(s)) return e164;
  return `${s.slice(2, 5)}-${s.slice(5, 8)}-${s.slice(8)}`;
}

/**
 * Build the spoken briefing for one consult call leg.
 *
 * @param {Object} args
 * @param {string} args.bookerName consults.booker_name
 * @param {Date|string} args.scheduledAt consults.scheduled_at (TIMESTAMPTZ)
 * @param {number} args.ring admin ring 1-3 (ignored on the Zul leg)
 * @param {boolean} args.forVa true when this leg is dialing Zul
 * @param {boolean} args.adminWasRung true when Dallas was rung and missed
 * @param {Date|string} args.eventDate proposals.event_date (DATE)
 * @param {number} args.guestCount proposals.guest_count
 * @param {number} args.proposalId proposals.id
 * @returns {string} plain text for a TwiML <Say> (escape at the TwiML layer)
 */
function buildConsultBriefing({
  bookerName,
  scheduledAt,
  ring,
  forVa,
  adminWasRung,
  eventDate,
  guestCount,
  proposalId,
} = {}) {
  // Strip one trailing period so an initialed name ("Sarah M.") does not
  // render a stuttering "Sarah M.," through <Say>.
  const trimmed = bookerName ? String(bookerName).trim().replace(/\.$/, '') : '';
  const name = trimmed || 'the client';
  const time = spokenClockTime(scheduledAt);

  const details = [];
  const when = eventDate ? spokenDateOnly(eventDate) : null;
  if (when) details.push(`Event ${when}`);
  if (guestCount !== null && guestCount !== undefined && Number(guestCount) > 0) {
    details.push(`${guestCount} guests`);
  }
  const pid = Number(proposalId);
  if (Number.isInteger(pid) && pid > 0) details.push(`proposal ${proposalId}`);
  const detailSentence = details.length ? ` ${details.join(', ')}.` : '';

  if (forVa) {
    return adminWasRung
      ? `Dallas missed his potion planning call with ${name}, booked for ${time}.${detailSentence} Press 1 to call them for him. Press 9 to hear this again.`
      : `Potion planning call with ${name}, booked for ${time}, for Dallas.${detailSentence} Press 1 to call them for him. Press 9 to hear this again.`;
  }

  const prefix = ring === 2 ? 'Second try. ' : ring === 3 ? 'Last try. ' : '';
  return `${prefix}Potion planning call with ${name}, booked for ${time}.${detailSentence} Press 1 to call them now. Press 9 to hear this again.`;
}

module.exports = {
  spokenClockTime,
  clockTimeWithMinutes,
  spokenDateOnly,
  formatUsPhoneForText,
  buildConsultBriefing,
};
