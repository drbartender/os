/**
 * Setup Time — pure functions, zero DB dependencies.
 * Derives the crew arrival/setup clock time from a proposal's service start.
 * Back-of-house only — never expose on public token/proposal/invoice surfaces.
 * Client twin: client/src/utils/setupTime.js (kept in sync manually).
 */

const { isHostedPackage } = require('./pricingEngine');

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
 * Subtract `minutes` from a time string and return the result as a 12-hour
 * "h:MM AM/PM" string (time only, no date). Tolerant of "17:00" and "5:00 PM".
 * Wraps mod 1440 so e.g. 90 min before 12:30 AM → "11:00 PM".
 * Mirrors addHoursToTime() in eventCreation.js (inverse direction).
 * Returns null on unparseable input.
 */
function subtractMinutesFromTime(timeStr, minutes) {
  const total = parseToMinutes(timeStr);
  if (total === null || !Number.isFinite(Number(minutes))) return null;
  const wrapped = (((total - Number(minutes)) % 1440) + 1440) % 1440;
  const newH = Math.floor(wrapped / 60);
  const newM = wrapped % 60;
  const hour12 = newH > 12 ? newH - 12 : (newH === 0 ? 12 : newH);
  const ampm = newH >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(newM).padStart(2, '0')} ${ampm}`;
}

/**
 * Effective setup minutes for a proposal: explicit override if set, else
 * 90 for hosted (per-guest) packages, 60 otherwise.
 * Safe when proposal/pkg/pricing_snapshot are missing or {}.
 */
function effectiveSetupMinutes(proposal, pkg) {
  return proposal?.setup_minutes_before ??
    (isHostedPackage(pkg ?? proposal?.pricing_snapshot?.package) ? 90 : 60);
}

/**
 * Derived setup clock time for display: service start − effective minutes.
 * Returns null if there is no parseable start time.
 */
function setupTimeDisplay(proposal, pkg) {
  return subtractMinutesFromTime(
    proposal?.event_start_time,
    effectiveSetupMinutes(proposal, pkg)
  );
}

module.exports = {
  subtractMinutesFromTime,
  effectiveSetupMinutes,
  setupTimeDisplay,
};
