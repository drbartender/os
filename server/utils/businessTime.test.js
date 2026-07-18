const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { eventLocalToUtc, chicagoTodayYmd, chicagoHourNow } = require('./businessTime');

// ─── eventLocalToUtc ─────────────────────────────────────────────
// Pure: a calendar date + Chicago wall-clock time -> the correct UTC instant,
// with the DST offset that applies ON that date (not the process/DB tz).

test('eventLocalToUtc > winter CST (UTC-6): 6:00 PM Chicago -> next-day 00:00Z', () => {
  const utc = eventLocalToUtc('2026-01-15', 18, 0, 'America/Chicago');
  assert.equal(utc.toISOString(), '2026-01-16T00:00:00.000Z');
});

test('eventLocalToUtc > summer CDT (UTC-5): 6:00 PM Chicago -> same-day 23:00Z', () => {
  const utc = eventLocalToUtc('2026-07-15', 18, 0, 'America/Chicago');
  assert.equal(utc.toISOString(), '2026-07-15T23:00:00.000Z');
});

test('eventLocalToUtc > spring-forward day 2026-03-08 resolves to CDT (UTC-5): 9:00am -> 14:00Z', () => {
  // The gap transition is at 2:00am local (08:00Z); noon-UTC probe lands after
  // it, so 9:00am on 2026-03-08 is CDT.
  const utc = eventLocalToUtc('2026-03-08', 9, 0, 'America/Chicago');
  assert.equal(utc.toISOString(), '2026-03-08T14:00:00.000Z');
});

test('eventLocalToUtc > fall-back day 2026-11-01 resolves to CST (UTC-6): 9:00am -> 15:00Z', () => {
  // The overlap transition is at 2:00am local (07:00Z); noon-UTC probe lands
  // after it, so 9:00am on 2026-11-01 is CST.
  const utc = eventLocalToUtc('2026-11-01', 9, 0, 'America/Chicago');
  assert.equal(utc.toISOString(), '2026-11-01T15:00:00.000Z');
});

// ─── chicagoTodayYmd ─────────────────────────────────────────────
// Reads the Chicago wall-clock day regardless of process/DB tz. Discriminated
// with a mocked clock at instants that straddle the UTC day boundary near both
// DST transitions.

test('chicagoTodayYmd > evening-before-UTC-midnight returns the Chicago day, not the UTC day (winter CST)', () => {
  // 04:30Z on 2026-03-08 is 22:30 CST on 2026-03-07 (before the 08:00Z gap).
  // UTC day is the 8th; the business day is the 7th.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-08T04:30:00Z') });
  try {
    assert.equal(chicagoTodayYmd(), '2026-03-07');
  } finally {
    mock.timers.reset();
  }
});

test('chicagoTodayYmd > daytime after spring-forward returns the same UTC day (CDT)', () => {
  // 18:00Z on 2026-03-08 is 13:00 CDT on 2026-03-08.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-08T18:00:00Z') });
  try {
    assert.equal(chicagoTodayYmd(), '2026-03-08');
  } finally {
    mock.timers.reset();
  }
});

test('chicagoTodayYmd > evening-before-UTC-midnight returns the Chicago day, not the UTC day (fall-back day, CDT)', () => {
  // 04:30Z on 2026-11-01 is 23:30 CDT on 2026-10-31 (before the 07:00Z overlap).
  // UTC day is Nov 1; the business day is Oct 31.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T04:30:00Z') });
  try {
    assert.equal(chicagoTodayYmd(), '2026-10-31');
  } finally {
    mock.timers.reset();
  }
});

test('chicagoTodayYmd > daytime after fall-back returns the same UTC day (CST)', () => {
  // 12:00Z on 2026-11-01 is 06:00 CST on 2026-11-01.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T12:00:00Z') });
  try {
    assert.equal(chicagoTodayYmd(), '2026-11-01');
  } finally {
    mock.timers.reset();
  }
});

// ─── chicagoHourNow ──────────────────────────────────────────────
// The lead-call window gate reads this; DST correctness is load-bearing
// (a fixed UTC offset would shift the window an hour twice a year).

test('chicagoHourNow > standard time (CST, UTC-6): 03:30Z is 21:30 Chicago', () => {
  assert.equal(chicagoHourNow(new Date('2026-01-15T03:30:00Z')), 21);
});

test('chicagoHourNow > daylight time (CDT, UTC-5): 13:30Z is 08:30 Chicago', () => {
  assert.equal(chicagoHourNow(new Date('2026-06-15T13:30:00Z')), 8);
});

test('chicagoHourNow > midnight hour renders as 0 (h23, never 24)', () => {
  // 06:10Z in July is 01:10 CDT; 05:10Z is 00:10 CDT.
  assert.equal(chicagoHourNow(new Date('2026-06-15T05:10:00Z')), 0);
});

test('chicagoHourNow > no-arg form returns an integer hour in range', () => {
  const h = chicagoHourNow();
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 23);
});
