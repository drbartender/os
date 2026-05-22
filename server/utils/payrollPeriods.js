/**
 * Pure pay-period and payday math for the staff payment system.
 * No DB, no side effects. Mirrors the bookingWindow.js / pricingEngine.js style.
 *
 * A pay period is a Tuesday-to-Monday window. Payday is the second working day
 * on or after the period's Monday end date, counting that Monday when it is a
 * working day. A working day is Monday-Friday excluding US federal holidays.
 *
 * All functions take and return 'YYYY-MM-DD' strings and compute in UTC, so
 * they are free of local-timezone drift.
 */

const MS_PER_DAY = 86400000;

function parseYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  return toYmd(new Date(parseYmd(ymd).getTime() + n * MS_PER_DAY));
}

// UTC day index: Sun=0, Mon=1, Tue=2, ... Sat=6.
function dayOfWeek(ymd) {
  return parseYmd(ymd).getUTCDay();
}

/**
 * The Tuesday-to-Monday pay period containing `ymd`.
 * Returns { startDate, endDate } as 'YYYY-MM-DD' strings.
 */
function payPeriodForDate(ymd) {
  const daysSinceTuesday = (dayOfWeek(ymd) - 2 + 7) % 7;
  const startDate = addDays(ymd, -daysSinceTuesday);
  const endDate = addDays(startDate, 6);
  return { startDate, endDate };
}

module.exports = { payPeriodForDate, addDays, parseYmd, toYmd, dayOfWeek };
