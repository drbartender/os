/**
 * Setup Time — pure functions, zero DB dependencies.
 * Derives the crew arrival/setup clock time from a proposal's service start.
 * Back-of-house only — never expose on public token/proposal/invoice surfaces.
 * Client twin: client/src/utils/setupTime.js (kept in sync manually).
 */

const { isHostedPackage } = require('./pricingEngine');
const { readSnapshot } = require('./pricingSnapshot');

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
 * Mirrors addHoursToTime() in eventCreation.js (inverse direction).
 * Returns null on unparseable input.
 *
 * Defaults to 12-hour "h:MM AM/PM" because every staff-facing caller
 * (staffShiftHandlers, autoAssign, shifts.approval) drops this string into an
 * SMS/email beside a raw 12h shift.start_time — flipping the default would
 * make those reads mixed-format. `hour24: true` opts into "HH:MM" and is used
 * only by setupTimeDisplay (admin event detail, which is 24h throughout).
 * Mirrors the client twin's hour24 option.
 */
function subtractMinutesFromTime(timeStr, minutes, { hour24 = false } = {}) {
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
 * Effective setup minutes for a proposal: explicit override if set, else
 * 90 for hosted (per-guest) packages, 60 otherwise.
 * Safe when proposal/pkg/pricing_snapshot are missing or {}.
 */
function effectiveSetupMinutes(proposal, pkg) {
  return proposal?.setup_minutes_before ??
    (isHostedPackage(pkg ?? readSnapshot(proposal?.pricing_snapshot, { context: 'setupTime' })?.package) ? 90 : 60);
}

/**
 * Derived setup clock time for display: service start − effective minutes.
 * 24-hour: the sole consumer is the admin event detail page (GET
 * /api/proposals/:id, admin-auth'd), which renders every other time in 24h.
 * Never reaches a client surface — the public token route omits
 * setup_minutes_before and this derived field by design.
 * Returns null if there is no parseable start time.
 */
function setupTimeDisplay(proposal, pkg) {
  return subtractMinutesFromTime(
    proposal?.event_start_time,
    effectiveSetupMinutes(proposal, pkg),
    { hour24: true }
  );
}

module.exports = {
  subtractMinutesFromTime,
  effectiveSetupMinutes,
  setupTimeDisplay,
};
