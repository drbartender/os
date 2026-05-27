const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseLengthHours } = require('./duration');

test('parseLengthHours: hours-only forms (singular + plural)', () => {
  assert.strictEqual(parseLengthHours('1 hour'), 1);
  assert.strictEqual(parseLengthHours('4 hours'), 4);
  assert.strictEqual(parseLengthHours('55 hours'), 55);
});

test('parseLengthHours: hours + minutes composite', () => {
  assert.strictEqual(parseLengthHours('4 hours, 30 minutes'), 4.5);
  assert.strictEqual(parseLengthHours('1 hour, 30 minutes'), 1.5);
  assert.strictEqual(parseLengthHours('2 hours, 15 minutes'), 2.25);
});

test('parseLengthHours: minutes-only', () => {
  assert.strictEqual(parseLengthHours('30 minutes'), 0.5);
  assert.strictEqual(parseLengthHours('0 minutes'), 0);
});

test('parseLengthHours: null / empty / unparseable → null', () => {
  assert.strictEqual(parseLengthHours(null), null);
  assert.strictEqual(parseLengthHours(undefined), null);
  assert.strictEqual(parseLengthHours(''), null);
  assert.strictEqual(parseLengthHours('   '), null);
  assert.strictEqual(parseLengthHours('long event'), null);
});

test('parseLengthHours: tolerant of "hr" / "min" abbreviations', () => {
  assert.strictEqual(parseLengthHours('2 hr'), 2);
  assert.strictEqual(parseLengthHours('45 min'), 0.75);
});
