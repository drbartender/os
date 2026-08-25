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
