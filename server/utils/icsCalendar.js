/**
 * Pure iCalendar VEVENT renderer for booking confirmation emails.
 *
 * Per RFC 5545:
 * - Line endings are CRLF.
 * - TEXT properties escape: backslash to \\, comma to \,, semicolon to \;,
 *   newline to \n (literal two chars).
 * - DATE-TIME in UTC uses the form YYYYMMDDTHHMMSSZ.
 * - Content lines longer than 75 octets are folded onto a continuation line
 *   that starts with a single space (HTAB also legal; we use space).
 *
 * The output is intended to be sent as a Resend attachment with
 * { filename: 'event.ics', content: Buffer.from(out, 'utf8') }.
 *
 * No I/O, no DB, no time-zone library. Caller supplies UTC Date instances and
 * we format them as Z-suffixed strings. Time-zone-aware rendering (for the
 * email body, not the .ics) lives in eventTimezone.js from Plan 1.
 */

function pad2(n) { return String(n).padStart(2, '0'); }

function toIcsUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('toIcsUtc: invalid Date');
  }
  return (
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  );
}

function escapeIcsText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a single content line per RFC 5545 section 3.1: the unfolded line is
 * counted in octets (UTF-8 byte length), split at <= 75-octet boundaries,
 * continuation lines start with a single space.
 */
function foldIcsLine(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const chunks = [];
  let offset = 0;
  let take = 75;
  while (offset < buf.length) {
    const end = Math.min(offset + take, buf.length);
    chunks.push(buf.slice(offset, end).toString('utf8'));
    offset = end;
    take = 74;
  }
  return chunks.join('\r\n ');
}

/**
 * Render a single-event VCALENDAR for an event booking.
 *
 * @param {object} args
 * @param {string} args.uid - unique event UID (use `proposal-<id>@drbartender.com`)
 * @param {Date} args.startUtc - event start, as a UTC Date
 * @param {Date} args.endUtc - event end, as a UTC Date
 * @param {string} args.summary - calendar event title
 * @param {string|null} args.location - free-form location string
 * @param {string|null} args.description - free-form description
 * @param {Date} args.stampUtc - DTSTAMP (when this .ics was generated); use new Date()
 * @returns {string} CRLF-terminated VCALENDAR text
 */
function renderEventIcs({ uid, startUtc, endUtc, summary, location, description, stampUtc }) {
  if (!uid) throw new TypeError('renderEventIcs: uid required');
  if (!(stampUtc instanceof Date)) throw new TypeError('renderEventIcs: stampUtc required');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dr. Bartender//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    foldIcsLine(`UID:${uid}`),
    `DTSTAMP:${toIcsUtc(stampUtc)}`,
    `DTSTART:${toIcsUtc(startUtc)}`,
    `DTEND:${toIcsUtc(endUtc)}`,
    foldIcsLine(`SUMMARY:${escapeIcsText(summary)}`),
    foldIcsLine(`LOCATION:${escapeIcsText(location)}`),
    foldIcsLine(`DESCRIPTION:${escapeIcsText(description)}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];
  return lines.join('\r\n');
}

module.exports = {
  renderEventIcs,
  foldIcsLine,
  escapeIcsText,
  toIcsUtc,
};
