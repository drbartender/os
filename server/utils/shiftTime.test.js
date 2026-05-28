const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseShiftDateTime, hoursToEvent, parseTime } = require('./shiftTime');

test('parseTime > 12-hour format with PM', () => {
  assert.deepEqual(parseTime('7:00 PM'), { hour: 19, minute: 0 });
  assert.deepEqual(parseTime('7:30 PM'), { hour: 19, minute: 30 });
  assert.deepEqual(parseTime('12:00 PM'), { hour: 12, minute: 0 });
  assert.deepEqual(parseTime('12:00 AM'), { hour: 0, minute: 0 });
});

test('parseTime > 24-hour format', () => {
  assert.deepEqual(parseTime('19:00'), { hour: 19, minute: 0 });
  assert.deepEqual(parseTime('07:30'), { hour: 7, minute: 30 });
  assert.deepEqual(parseTime('23:59'), { hour: 23, minute: 59 });
});

test('parseTime > rejects garbage', () => {
  assert.strictEqual(parseTime(''), null);
  assert.strictEqual(parseTime(null), null);
  assert.strictEqual(parseTime('25:00'), null);
  assert.strictEqual(parseTime('garbage'), null);
});

test('parseShiftDateTime > January (CST, UTC-6)', () => {
  // 2026-01-15 7:00 PM Chicago = 2026-01-16 01:00 UTC
  const d = parseShiftDateTime({ event_date: '2026-01-15', start_time: '7:00 PM' });
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-01-16T01:00:00.000Z');
});

test('parseShiftDateTime > July (CDT, UTC-5)', () => {
  // 2026-07-15 7:00 PM Chicago = 2026-07-16 00:00 UTC
  const d = parseShiftDateTime({ event_date: '2026-07-15', start_time: '7:00 PM' });
  assert.strictEqual(d.toISOString(), '2026-07-16T00:00:00.000Z');
});

test('parseShiftDateTime > spring forward boundary (DST starts second Sunday of March)', () => {
  // 2026: second Sunday of March is March 8. DST starts that day at 2am.
  // A shift at 7am Chicago on March 9 = 12:00 UTC (CDT, UTC-5).
  const after = parseShiftDateTime({ event_date: '2026-03-09', start_time: '7:00 AM' });
  assert.strictEqual(after.toISOString(), '2026-03-09T12:00:00.000Z');
  // A shift at 7am Chicago on March 7 (before transition) = 13:00 UTC (CST, UTC-6).
  const before = parseShiftDateTime({ event_date: '2026-03-07', start_time: '7:00 AM' });
  assert.strictEqual(before.toISOString(), '2026-03-07T13:00:00.000Z');
});

test('parseShiftDateTime > fall back boundary (DST ends first Sunday of November)', () => {
  // 2026: first Sunday of November is November 1. DST ends that day at 2am.
  // A shift at 7am Chicago on Nov 2 = 13:00 UTC (CST, UTC-6).
  const after = parseShiftDateTime({ event_date: '2026-11-02', start_time: '7:00 AM' });
  assert.strictEqual(after.toISOString(), '2026-11-02T13:00:00.000Z');
  // A shift at 7am Chicago on Oct 31 = 12:00 UTC (still CDT, UTC-5).
  const before = parseShiftDateTime({ event_date: '2026-10-31', start_time: '7:00 AM' });
  assert.strictEqual(before.toISOString(), '2026-10-31T12:00:00.000Z');
});

test('parseShiftDateTime > Date input via pg', () => {
  // pg returns DATE columns as JS Date; ensure we handle that too.
  const eventDate = new Date('2026-07-15T00:00:00.000Z');
  const d = parseShiftDateTime({ event_date: eventDate, start_time: '7:00 PM' });
  assert.strictEqual(d.toISOString(), '2026-07-16T00:00:00.000Z');
});

test('parseShiftDateTime > null for garbage inputs', () => {
  assert.strictEqual(parseShiftDateTime(null), null);
  assert.strictEqual(parseShiftDateTime({}), null);
  assert.strictEqual(parseShiftDateTime({ event_date: 'bad', start_time: '7:00 PM' }), null);
  assert.strictEqual(parseShiftDateTime({ event_date: '2026-07-15', start_time: 'garbage' }), null);
});

test('hoursToEvent > exact 336 hours (14 days) clean-drop boundary', () => {
  const shift = { event_date: '2026-07-15', start_time: '7:00 PM' };
  const eventTime = parseShiftDateTime(shift);
  // 14 days = 336 hours earlier
  const now = new Date(eventTime.getTime() - 336 * 3_600_000);
  const h = hoursToEvent(shift, now);
  assert.strictEqual(h, 336);
});

test('hoursToEvent > exact 72 hours cover/emergency boundary', () => {
  const shift = { event_date: '2026-07-15', start_time: '7:00 PM' };
  const eventTime = parseShiftDateTime(shift);
  const now = new Date(eventTime.getTime() - 72 * 3_600_000);
  const h = hoursToEvent(shift, now);
  assert.strictEqual(h, 72);
});

test('hoursToEvent > past events return negative hours', () => {
  const shift = { event_date: '2020-01-01', start_time: '7:00 PM' };
  const h = hoursToEvent(shift);
  assert.ok(h < 0);
});

test('hoursToEvent > null for unparseable shift', () => {
  assert.strictEqual(hoursToEvent({ event_date: 'bad', start_time: '7:00 PM' }), null);
});
