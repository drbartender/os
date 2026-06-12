const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatEventDateForSms } = require('./smsEventDate');

test('formats a YYYY-MM-DD string', () => {
  assert.strictEqual(formatEventDateForSms('2026-08-15'), 'August 15');
});

test('formats a long ISO timestamp string', () => {
  assert.strictEqual(formatEventDateForSms('2026-08-15T00:00:00.000Z'), 'August 15');
});

test('formats a pg Date object by its local calendar date', () => {
  // pg parses DATE columns to local midnight; the formatter must not shift the day.
  assert.strictEqual(formatEventDateForSms(new Date(2026, 7, 15)), 'August 15');
});

test('null, undefined, and empty string return null', () => {
  assert.strictEqual(formatEventDateForSms(null), null);
  assert.strictEqual(formatEventDateForSms(undefined), null);
  assert.strictEqual(formatEventDateForSms(''), null);
});

test('a garbage string returns null', () => {
  assert.strictEqual(formatEventDateForSms('not a date'), null);
});

test('an invalid Date object returns null', () => {
  assert.strictEqual(formatEventDateForSms(new Date('nope')), null);
});
