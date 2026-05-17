const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getBookingWindow } = require('./bookingWindow');

// Fixed reference "now": 2026-05-15T12:00:00Z
const NOW = new Date('2026-05-15T12:00:00Z');
const H = 3600000;

test('event 30 days out → no constraints', () => {
  const w = getBookingWindow({ eventDate: '2026-06-14', eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, false);
  assert.equal(w.lastMinuteHold, false);
});

test('event exactly 14 days out (336h) → full required, no hold', () => {
  // 2026-05-29T12:00:00Z is exactly 336h after NOW
  const w = getBookingWindow({ eventDate: '2026-05-29', eventStartTime: '12:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, false);
});

test('event 10 days out → full required, no hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-25', eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, false);
});

test('event exactly 72h out → full required AND hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-18', eventStartTime: '12:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, true);
});

test('event 24h out → full required AND hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-16', eventStartTime: '12:00', now: NOW });
  assert.equal(w.lastMinuteHold, true);
});

test('event in the past → full required AND hold (negative hours)', () => {
  const w = getBookingWindow({ eventDate: '2026-05-14', eventStartTime: '12:00', now: NOW });
  assert.ok(w.hoursUntilEvent < 0);
  assert.equal(w.lastMinuteHold, true);
});

test('null start time → treated as 00:00 UTC of event date', () => {
  // 2026-05-18T00:00:00Z is 60h after NOW → inside 72h
  const w = getBookingWindow({ eventDate: '2026-05-18', eventStartTime: null, now: NOW });
  assert.equal(w.lastMinuteHold, true);
});

test('accepts a Date object for eventDate', () => {
  const w = getBookingWindow({ eventDate: new Date('2026-06-14'), eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, false);
});

test('hoursUntilEvent is a finite number', () => {
  const w = getBookingWindow({ eventDate: '2026-05-25', eventStartTime: '17:00', now: NOW });
  assert.equal(typeof w.hoursUntilEvent, 'number');
  assert.ok(Number.isFinite(w.hoursUntilEvent));
});
