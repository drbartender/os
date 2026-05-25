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

// Observed date for a fixed-date holiday: Saturday shifts to Friday,
// Sunday shifts to Monday.
function observed(ymd) {
  const dow = dayOfWeek(ymd);
  if (dow === 6) return addDays(ymd, -1);
  if (dow === 0) return addDays(ymd, 1);
  return ymd;
}

// The nth `weekday` (0=Sun..6=Sat) of `month` (1-12) in `year`.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toYmd(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

// The last `weekday` of `month` in `year`.
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toYmd(new Date(Date.UTC(year, month, 0 - offset)));
}

/** Observed US federal holidays for a year, as a Set of 'YYYY-MM-DD'. */
function usFederalHolidays(year) {
  return new Set([
    observed(`${year}-01-01`),    // New Year's Day
    nthWeekday(year, 1, 1, 3),    // MLK Day
    nthWeekday(year, 2, 1, 3),    // Washington's Birthday
    lastWeekday(year, 5, 1),      // Memorial Day
    observed(`${year}-06-19`),    // Juneteenth
    observed(`${year}-07-04`),    // Independence Day
    nthWeekday(year, 9, 1, 1),    // Labor Day
    nthWeekday(year, 10, 1, 2),   // Columbus Day
    observed(`${year}-11-11`),    // Veterans Day
    nthWeekday(year, 11, 4, 4),   // Thanksgiving
    observed(`${year}-12-25`),    // Christmas
  ]);
}

/** True when `ymd` is Mon-Fri and not an observed federal holiday. */
function isWorkingDay(ymd) {
  const dow = dayOfWeek(ymd);
  if (dow === 0 || dow === 6) return false;
  const year = Number(ymd.slice(0, 4));
  // Check adjacent years too: a New Year observed on Dec 31 lands in the
  // prior year, and one observed on Jan 2 is built for the next year.
  for (const y of [year - 1, year, year + 1]) {
    if (usFederalHolidays(y).has(ymd)) return false;
  }
  return true;
}

/**
 * Payday for a period: the second working day on or after `endDate`
 * (the period's Monday), counting that Monday when it is a working day.
 */
function computePayday(endDate) {
  let d = endDate;
  let working = 0;
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d)) {
      working += 1;
      if (working === 2) return d;
    }
    d = addDays(d, 1);
  }
  throw new Error(`computePayday: no payday found near ${endDate}`);
}

module.exports = {
  payPeriodForDate, computePayday, isWorkingDay, usFederalHolidays,
  addDays, parseYmd, toYmd, dayOfWeek,
};
