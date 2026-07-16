const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  subtractMinutesFromTime,
  effectiveSetupMinutes,
  setupTimeDisplay,
} = require('./setupTime');

// subtractMinutesFromTime is the load-bearing pure clock math (back-of-house
// crew arrival = service start − setup minutes). Its mod-1440 wrap and the
// 12h/24h tolerance must hold; it has a manually-kept client twin.

test('24h input: 60 min before 17:00 → 4:00 PM', () => {
  assert.equal(subtractMinutesFromTime('17:00', 60), '4:00 PM');
});

test('12h input: 90 min before 5:00 PM → 3:30 PM', () => {
  assert.equal(subtractMinutesFromTime('5:00 PM', 90), '3:30 PM');
});

test('wraps backward across midnight: 90 min before 12:30 AM → 11:00 PM', () => {
  assert.equal(subtractMinutesFromTime('12:30 AM', 90), '11:00 PM');
});

test('wraps backward across midnight from 00:00: 30 min before 00:00 → 11:30 PM', () => {
  assert.equal(subtractMinutesFromTime('00:00', 30), '11:30 PM');
});

test('noon stays PM, midnight stays AM (12-hour edge)', () => {
  assert.equal(subtractMinutesFromTime('12:00 PM', 0), '12:00 PM');
  assert.equal(subtractMinutesFromTime('12:00 AM', 0), '12:00 AM');
});

test('zero subtraction is identity (modulo formatting)', () => {
  assert.equal(subtractMinutesFromTime('1:05 AM', 0), '1:05 AM');
});

for (const bad of [null, undefined, '', 'abc', '25:00', '13:00 PM', '5:99', '5']) {
  test(`unparseable start → null: ${JSON.stringify(bad)}`, () => {
    assert.equal(subtractMinutesFromTime(bad, 60), null);
  });
}

test('non-finite minutes → null (not NaN time)', () => {
  assert.equal(subtractMinutesFromTime('5:00 PM', NaN), null);
  assert.equal(subtractMinutesFromTime('5:00 PM', 'x'), null);
});

// effectiveSetupMinutes: explicit override wins; else 90 hosted / 60 default.

test('explicit override is returned verbatim, including 0', () => {
  assert.equal(effectiveSetupMinutes({ setup_minutes_before: 45 }, null), 45);
  assert.equal(effectiveSetupMinutes({ setup_minutes_before: 0 }, { pricing_type: 'per_guest' }), 0);
});

test('hosted (per_guest) package defaults to 90', () => {
  assert.equal(effectiveSetupMinutes({}, { pricing_type: 'per_guest' }), 90);
});

test('non-hosted package defaults to 60', () => {
  assert.equal(effectiveSetupMinutes({}, { pricing_type: 'flat' }), 60);
});

test('falls back to pricing_snapshot.package when no pkg arg', () => {
  assert.equal(
    effectiveSetupMinutes({ pricing_snapshot: { package: { pricing_type: 'per_guest' } } }),
    90
  );
});

test('safe when proposal/pkg are missing → 60', () => {
  assert.equal(effectiveSetupMinutes(undefined), 60);
  assert.equal(effectiveSetupMinutes({}), 60);
  assert.equal(effectiveSetupMinutes(null, null), 60);
});

// The 12h default is load-bearing for staff comms: staffShiftHandlers,
// autoAssign, and shifts.approval interpolate this string into an SMS/email
// next to a raw 12h shift.start_time. Callers passing no opts must never shift.

test('default output stays 12h for staff-facing callers', () => {
  assert.equal(subtractMinutesFromTime('7:00 PM', 60), '6:00 PM');
  assert.equal(subtractMinutesFromTime('17:00', 60), '4:00 PM');
});

test('hour24 option renders HH:MM', () => {
  assert.equal(subtractMinutesFromTime('7:00 PM', 60, { hour24: true }), '18:00');
  assert.equal(subtractMinutesFromTime('9:15 AM', 30, { hour24: true }), '08:45');
});

test('hour24 wraps backward across midnight', () => {
  assert.equal(subtractMinutesFromTime('12:30 AM', 90, { hour24: true }), '23:00');
  assert.equal(subtractMinutesFromTime('00:30', 30, { hour24: true }), '00:00');
});

test('hour24 noon/midnight edges', () => {
  assert.equal(subtractMinutesFromTime('12:00 PM', 0, { hour24: true }), '12:00');
  assert.equal(subtractMinutesFromTime('12:00 AM', 0, { hour24: true }), '00:00');
});

test('hour24 still returns null on unparseable input', () => {
  assert.equal(subtractMinutesFromTime('garbage', 60, { hour24: true }), null);
});

// setupTimeDisplay composes the two: start − effective minutes.
// It is 24h — admin event detail only, never a client surface.

test('setupTimeDisplay applies the override against the start time (24h)', () => {
  assert.equal(
    setupTimeDisplay({ event_start_time: '5:00 PM', setup_minutes_before: 60 }),
    '16:00'
  );
});

test('setupTimeDisplay uses the hosted 90-min default (24h)', () => {
  assert.equal(
    setupTimeDisplay({ event_start_time: '6:00 PM' }, { pricing_type: 'per_guest' }),
    '16:30'
  );
});

test('setupTimeDisplay → null when start time is missing/unparseable', () => {
  assert.equal(setupTimeDisplay({ event_start_time: null }), null);
  assert.equal(setupTimeDisplay({}), null);
});
