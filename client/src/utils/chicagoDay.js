// The calendar day, in the business timezone, of a TIMESTAMPTZ moment.
//
// `String(ts).slice(0, 10)` looks like it does this and does not: res.json
// serialises a pg TIMESTAMPTZ as ISO-UTC, so every moment at or after 19:00
// Chicago (18:00 CST) already carries the NEXT day's date. That is what made the
// staff Pay screen print a payout marked paid at 8:30pm as the following day,
// while the paystub PDF (server chicagoYmdOf) printed the right one.
//
// Mirrors server/utils/businessTime.js chicagoYmdOf, which the browser cannot
// import. `ctDay` in components/adminos/format.js is the same idea for the admin
// skin; pages/staff imports nothing from components/adminos, so this lives in
// utils/ where both skins already draw from. Worth collapsing to one later.
const CT_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function chicagoDay(value) {
  if (!value) return '';
  const s = String(value);
  // A bare calendar date is ALREADY a day, not a moment: pg DATE columns
  // (payday, period bounds) arrive in this shape. Reducing one would move it
  // backwards, because new Date('2026-05-16') parses as UTC midnight and that
  // instant is the 15th in Chicago.
  if (BARE_DATE.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return CT_YMD.format(d);
}

// ---- Chicago clock helpers (Inbox, spec 2026-10-06 decision 28) ----------
// Every Inbox time is Chicago time, on any device. Each helper takes an ISO
// string, a Date or epoch milliseconds and returns '' (or null) for nothing
// usable. Browsers print U+202F before AM/PM; it is normalized to a plain
// space so a time reads (and compares) the same everywhere.
const CT_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
});
const CT_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' });
const CT_MON_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
const CT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2:12 PM" on the Chicago clock. */
export function chicagoTime(value) {
  const d = toDate(value);
  return d ? CT_TIME.format(d).replace(/[\u202f\u00a0]/g, ' ') : '';
}

/** "Wed" in Chicago. */
export function chicagoWeekday(value) {
  const d = toDate(value);
  return d ? CT_WEEKDAY.format(d) : '';
}

/** "Sat Oct 3" in Chicago. */
export function chicagoWeekdayDate(value) {
  const d = toDate(value);
  return d ? `${CT_WEEKDAY.format(d)} ${CT_MON_DAY.format(d)}` : '';
}

/** The Chicago hour, 0 to 23, or null. */
export function chicagoHour(value) {
  const d = toDate(value);
  if (!d) return null;
  const part = CT_PARTS.formatToParts(d).find((p) => p.type === 'hour');
  return part ? Number(part.value) % 24 : null;
}

/** 'YYYY-MM-DD' moved n calendar days. Pure date math: no clock, no zone. */
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Chicago's UTC offset at an instant, in ms (negative: Chicago is behind).
function offsetMs(date) {
  const p = {};
  CT_PARTS.formatToParts(date).forEach((x) => { p[x.type] = Number(x.value); });
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant whose Chicago wall clock reads `ymd` at hour:minute. */
export function chicagoInstant(ymd, hour = 0, minute = 0) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  // The offset at a first guess, then again at the corrected instant, so a
  // time beside a daylight-saving change lands on the right side of it.
  const guess = wall - offsetMs(new Date(wall));
  return new Date(wall - offsetMs(new Date(guess)));
}

/** "Today", "Yesterday" or "Sat Oct 3", by the Chicago calendar. */
export function chicagoDayLabel(value, now = new Date()) {
  const s = String(value === null || value === undefined ? '' : value);
  const d = toDate(value);
  if (!d && !BARE_DATE.test(s)) return '';
  const day = BARE_DATE.test(s) ? s : CT_YMD.format(d);
  const today = CT_YMD.format(toDate(now) || new Date());
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return chicagoWeekdayDate(chicagoInstant(day, 12, 0));
}
