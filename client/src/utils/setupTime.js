/**
 * Setup Time (client twin).
 * Mirrors server/utils/setupTime.js — keep the two in sync manually
 * (mirrored-util pattern, like eventTypes.js). The server util is canonical;
 * this client copy only derives the display clock time for back-facing
 * staff/admin pages. Setup time is back-of-house only — never render it on
 * public proposal/invoice/website surfaces.
 *
 * Parsing approach mirrors parseTimeInput() in client/src/utils/timeOptions.js.
 */

/**
 * Parse a time string into total minutes since midnight.
 * Tolerant of 24-hour ("17:00") and 12-hour ("5:00 PM") forms.
 * Returns null if the input can't be parsed.
 */
function parseToMinutes(timeStr) {
  if (timeStr === null || timeStr === undefined) return null;
  const cleaned = String(timeStr).trim().toUpperCase();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const ampm = match[3];
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (m < 0 || m > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else if (h < 0 || h > 23) {
    return null;
  }
  return h * 60 + m;
}

/**
 * Subtract `minutes` from a time string and return the result as a clock time
 * (time only, no date). Tolerant of "17:00" and "5:00 PM" input.
 * Wraps mod 1440 so e.g. 90 min before 12:30 AM → "11:00 PM".
 * Same semantics/output as the server twin's subtractMinutesFromTime().
 * Returns null on unparseable input.
 *
 * Defaults to 12-hour "h:MM AM/PM"; `hour24: true` opts into "HH:MM".
 * Admin pages pass hour24; staff pages keep the 12h default. The server twin
 * mirrors this option (its setupTimeDisplay passes hour24 for admin event
 * detail, while its staff SMS/email callers keep the 12h default).
 */
export function subtractMinutesFromTime(timeStr, minutes, { hour24 = false } = {}) {
  const total = parseToMinutes(timeStr);
  if (total === null || !Number.isFinite(Number(minutes))) return null;
  const wrapped = (((total - Number(minutes)) % 1440) + 1440) % 1440;
  const newH = Math.floor(wrapped / 60);
  const newM = wrapped % 60;
  if (hour24) return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
  const hour12 = newH > 12 ? newH - 12 : (newH === 0 ? 12 : newH);
  const ampm = newH >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(newM).padStart(2, '0')} ${ampm}`;
}

/**
 * Format the setup clock time for a shift/event: start − minutes.
 * Falls back to the 60-minute default when minutes is null/undefined.
 * Returns null when startTime is missing or unparseable.
 */
export function formatSetupTime(startTime, minutes, opts = {}) {
  return subtractMinutesFromTime(startTime, minutes ?? 60, opts);
}
