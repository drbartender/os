import { chicagoDay } from './chicagoDay';

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
