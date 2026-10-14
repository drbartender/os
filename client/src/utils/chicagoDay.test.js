import {
  chicagoDay, chicagoTime, chicagoWeekday, chicagoWeekdayDate, chicagoHour, addDays, chicagoInstant, chicagoDayLabel,
} from './chicagoDay';

// paid_at is a TIMESTAMPTZ written by NOW(). res.json serialises it as ISO-UTC,
// so `String(ts).slice(0, 10)` yields the UTC day and anything after ~18:00
// Chicago already carries TOMORROW's date. The staff Pay screen printed that day
// while the paystub PDF (chicagoYmdOf) printed the right one.

test('an evening Chicago moment keeps its own day, not the UTC one', () => {
  // THE WIRE FORMAT MATTERS: res.json serialises a pg TIMESTAMPTZ as ISO-UTC,
  // which is how the bug reaches the browser. 2026-12-31 18:01 CST ships as
  // 2027-01-01T00:01:00.000Z, and slicing that yields 2027-01-01. A fixture
  // written with an explicit -06:00 offset slices to the RIGHT day and proves
  // nothing (it passed against the unfixed code).
  expect(chicagoDay('2027-01-01T00:01:00.000Z')).toBe('2026-12-31');
  expect(chicagoDay('2026-12-31T18:01:00-06:00')).toBe('2026-12-31');
});

test('a bare calendar date passes through untouched', () => {
  // The trap: new Date('2026-05-16') parses as UTC midnight, which in Chicago is
  // the 15th. A pg DATE column (and the existing PayoutDetail fixture) arrives
  // in this shape, so reducing it would move it BACKWARDS a day.
  expect(chicagoDay('2026-05-16')).toBe('2026-05-16');
});

test('a morning moment is unaffected', () => {
  expect(chicagoDay('2026-07-04T14:30:00.000Z')).toBe('2026-07-04');
});

test('spring-forward day', () => {
  // 2026-03-08, the 23-hour Chicago day.
  expect(chicagoDay('2026-03-09T04:30:00.000Z')).toBe('2026-03-08');
});

test('fall-back day', () => {
  // 2026-11-01, the 25-hour Chicago day.
  expect(chicagoDay('2026-11-02T05:30:00.000Z')).toBe('2026-11-01');
});

test('empty and unparseable inputs render nothing rather than throwing', () => {
  expect(chicagoDay(null)).toBe('');
  expect(chicagoDay('')).toBe('');
  expect(chicagoDay('not-a-date')).toBe('');
});

// ---- Chicago clock helpers (Inbox, spec 2026-10-06 decision 28) -----------
// Fixtures are ISO-UTC, the wire format, so an evening Chicago moment really
// does carry the next UTC day.
test('chicagoTime is the Chicago clock with a plain space before AM/PM', () => {
  expect(chicagoTime('2026-10-06T19:12:00.000Z')).toBe('2:12 PM');
  expect(chicagoTime('2026-10-07T03:40:00.000Z')).toBe('10:40 PM');
  expect(chicagoTime(Date.parse('2026-10-06T13:00:00.000Z'))).toBe('8:00 AM');
  expect(chicagoTime(null)).toBe('');
  expect(chicagoTime('not-a-date')).toBe('');
});

test('weekday and date follow the Chicago day, not the UTC one', () => {
  // 9 PM Saturday in Chicago is already Sunday in UTC.
  expect(chicagoWeekdayDate('2026-10-04T02:00:00.000Z')).toBe('Sat Oct 3');
  expect(chicagoWeekday('2026-10-04T02:00:00.000Z')).toBe('Sat');
  expect(chicagoHour('2026-10-04T02:00:00.000Z')).toBe(21);
  expect(chicagoHour('2026-10-04T05:30:00.000Z')).toBe(0);
});

test('addDays rolls months and years and ignores the clock', () => {
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});

test('chicagoInstant finds 8:00 AM Chicago on both sides of a DST change', () => {
  expect(chicagoInstant('2026-10-07', 8, 0).toISOString()).toBe('2026-10-07T13:00:00.000Z'); // CDT
  expect(chicagoInstant('2026-11-01', 8, 0).toISOString()).toBe('2026-11-01T14:00:00.000Z'); // fall back
  expect(chicagoInstant('2026-03-08', 8, 0).toISOString()).toBe('2026-03-08T13:00:00.000Z'); // spring forward
  expect(chicagoInstant('2026-12-15', 0, 0).toISOString()).toBe('2026-12-15T06:00:00.000Z'); // CST midnight
});

test('chicagoDayLabel: Today, Yesterday, else the weekday and date', () => {
  const now = new Date('2026-10-06T19:40:00.000Z'); // Tue Oct 6, 2:40 PM
  expect(chicagoDayLabel('2026-10-06T14:00:00.000Z', now)).toBe('Today');
  // Monday 8 PM Chicago, Tuesday in UTC: still Yesterday.
  expect(chicagoDayLabel('2026-10-06T01:00:00.000Z', now)).toBe('Yesterday');
  expect(chicagoDayLabel('2026-10-03T23:00:00.000Z', now)).toBe('Sat Oct 3');
  expect(chicagoDayLabel('2026-10-03', now)).toBe('Sat Oct 3');
  expect(chicagoDayLabel('', now)).toBe('');
});
