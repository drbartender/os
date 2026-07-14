/**
 * Canonical business-time primitives. The event-bartending business runs on
 * America/Chicago wall-clock time while the Postgres session (dev and prod)
 * runs at GMT, so "today" and event-local instants must be derived explicitly
 * instead of leaning on the process or DB timezone.
 *
 *   - eventLocalToUtc(ymd, hour, minute, tz): a calendar date + wall-clock time
 *     in an event-local zone -> the corresponding UTC instant (DST-honoring).
 *     Moved here verbatim from staffShiftHandlers.js, which now re-imports it.
 *   - chicagoTodayYmd(): today's calendar date in the business timezone.
 *   - chicagoYmdOf(value): the Chicago calendar date of any instant. Use for
 *     TIMESTAMPTZ columns (e.g. cancelled_at) — reading local Date components
 *     off an instant gives the GMT day on prod, one day late for any evening
 *     Chicago timestamp.
 */

/**
 * Convert a calendar date + wall-clock time in an event-local timezone to
 * the corresponding UTC instant. Uses Intl.DateTimeFormat with
 * timeZoneName: 'shortOffset' to read the offset that applies on the given
 * date in the given zone (so summer / winter DST are both honored).
 *
 * @param {string} ymd YYYY-MM-DD calendar date
 * @param {number} hour 0-23 event-local hour
 * @param {number} minute 0-59 event-local minute
 * @param {string} tz IANA timezone identifier (e.g. "America/Chicago")
 * @returns {Date} UTC instant
 */
function eventLocalToUtc(ymd, hour, minute, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;
  return new Date(Date.UTC(y, mo - 1, d, hour - tzHours, minute - tzMinutes, 0));
}

/**
 * Today's calendar date (YYYY-MM-DD) in America/Chicago, the business
 * timezone. DST-safe and server-tz-independent: it reads the wall-clock day
 * in Chicago no matter what timezone the process (or the Postgres session)
 * runs in. Use this for any "today" pick that must land on the business day
 * rather than the server's UTC/GMT day.
 *
 * @returns {string} YYYY-MM-DD
 */
function chicagoTodayYmd() {
  return chicagoYmdOf(new Date());
}

/**
 * The calendar date (YYYY-MM-DD) in America/Chicago of a given instant
 * (Date or anything new Date() accepts, e.g. a pg TIMESTAMPTZ value).
 * DST-safe and server-tz-independent, same as chicagoTodayYmd.
 *
 * @param {Date|string|number} value an instant
 * @returns {string} YYYY-MM-DD
 */
function chicagoYmdOf(value) {
  const instant = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

module.exports = { eventLocalToUtc, chicagoTodayYmd, chicagoYmdOf };
