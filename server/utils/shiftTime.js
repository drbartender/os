/**
 * Shift time helpers for the staff portal drop/cover endpoints (spec §6.5).
 *
 * Times in `shifts` are stored as `VARCHAR(50)` in America/Chicago wall-clock
 * (per CLAUDE.md, no global timezone normalization). The existing
 * `buildEventTimes` in `server/routes/calendar.js:70` returns ICS-formatted
 * strings, not a JS Date suitable for arithmetic like
 * `(event_datetime - NOW()) / 3_600_000`. This module is the small dedicated
 * parser the four drop/cover endpoints share.
 *
 * DST in the US: spring forward second Sunday of March at 2am local; fall back
 * first Sunday of November at 2am local. Chicago is UTC-6 (CST) in standard
 * time, UTC-5 (CDT) in daylight time.
 */

// Both patterns are bounded (no unbounded repetition of alternations); the
// security/detect-unsafe-regex plugin is over-cautious here.
// eslint-disable-next-line security/detect-unsafe-regex
const TWELVE_HOUR_RE = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)\s*$/;
// eslint-disable-next-line security/detect-unsafe-regex
const TWENTY_FOUR_HOUR_RE = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/;

/**
 * Parse a shift time string into {hour, minute} (24-hour internal).
 * Accepts "7:00 PM", "19:00", "7PM", "7:30am", "07:30".
 * Returns null on failure.
 */
function parseTime(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim();
  if (!s) return null;
  const m12 = s.match(TWELVE_HOUR_RE);
  if (m12) {
    let h = Number(m12[1]);
    const mm = Number(m12[2] || '0');
    const period = m12[3].toUpperCase();
    if (h < 1 || h > 12 || mm < 0 || mm > 59) return null;
    if (period === 'AM') {
      if (h === 12) h = 0;
    } else {
      if (h !== 12) h += 12;
    }
    return { hour: h, minute: mm };
  }
  const m24 = s.match(TWENTY_FOUR_HOUR_RE);
  if (m24) {
    const h = Number(m24[1]);
    const mm = Number(m24[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return { hour: h, minute: mm };
  }
  return null;
}

/**
 * Returns 'CDT' (daylight) or 'CST' (standard) for a wall-clock instant in Chicago.
 * Boundaries: DST starts second Sunday of March, ends first Sunday of November.
 * The 2am ambiguity is resolved by always returning the post-transition zone for
 * the hour-long gap; "fall back" rolls 1am-2am twice but for our purposes
 * (shift start times) this picks the second instance (standard time) consistently.
 */
function chicagoTzForWallClock(year, monthZeroBased, day, hour) {
  const dstStart = nthSundayOf(year, 2, 2);    // second Sunday of March (month=2)
  const dstEnd   = nthSundayOf(year, 10, 1);   // first Sunday of November (month=10)
  // Local instant in days-from-epoch, hours added.
  const localDay = Date.UTC(year, monthZeroBased, day);
  const startUtc = Date.UTC(year, 2, dstStart, 2);   // 2am local on DST start day
  const endUtc   = Date.UTC(year, 10, dstEnd, 2);    // 2am local on DST end day
  const instantApprox = localDay + hour * 3_600_000;
  return (instantApprox >= startUtc && instantApprox < endUtc) ? 'CDT' : 'CST';
}

function nthSundayOf(year, monthZeroBased, n) {
  const first = new Date(Date.UTC(year, monthZeroBased, 1));
  const dow = first.getUTCDay(); // 0=Sun
  const firstSunday = 1 + ((7 - dow) % 7);
  return firstSunday + (n - 1) * 7;
}

/**
 * Parse a shift's event_date + start_time into a Date representing the actual
 * UTC instant of the Chicago wall-clock time.
 *
 * @param {{event_date: string|Date, start_time: string}} shift
 * @returns {Date|null}
 */
function parseShiftDateTime(shift) {
  if (!shift) return null;
  let dateStr;
  if (shift.event_date instanceof Date) {
    if (isNaN(shift.event_date.getTime())) return null;
    dateStr = shift.event_date.toISOString().slice(0, 10);
  } else if (typeof shift.event_date === 'string') {
    dateStr = shift.event_date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  } else {
    return null;
  }
  const time = parseTime(shift.start_time);
  if (!time) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const tz = chicagoTzForWallClock(y, m - 1, d, time.hour);
  const offset = tz === 'CDT' ? '-05:00' : '-06:00';
  const hh = String(time.hour).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00${offset}`);
}

/**
 * @param {{event_date: string|Date, start_time: string}} shift
 * @param {Date} [now] testing override
 * @returns {number|null} fractional hours from now to the shift start; null if shift unparseable
 */
function hoursToEvent(shift, now = new Date()) {
  const eventDate = parseShiftDateTime(shift);
  if (!eventDate) return null;
  return (eventDate.getTime() - now.getTime()) / 3_600_000;
}

module.exports = { parseShiftDateTime, hoursToEvent, parseTime };
