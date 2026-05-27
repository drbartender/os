const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmPmToMinutes, minutesToAmPm, addHours } = require('./timeFormat');

test('parseAmPmToMinutes: 5:00 PM -> 17*60', () => {
  assert.strictEqual(parseAmPmToMinutes('5:00 PM'), 17 * 60);
});
test('parseAmPmToMinutes: 12:00 AM -> 0', () => {
  assert.strictEqual(parseAmPmToMinutes('12:00 AM'), 0);
});
test('parseAmPmToMinutes: 12:30 PM -> 12*60+30', () => {
  assert.strictEqual(parseAmPmToMinutes('12:30 PM'), 12 * 60 + 30);
});
test('parseAmPmToMinutes: returns null on bad input', () => {
  assert.strictEqual(parseAmPmToMinutes('garbage'), null);
  assert.strictEqual(parseAmPmToMinutes(''), null);
  assert.strictEqual(parseAmPmToMinutes(null), null);
});
test('addHours: 5:00 PM + 4 = 9:00 PM', () => {
  assert.strictEqual(addHours('5:00 PM', 4), '9:00 PM');
});
test('addHours: 11:00 PM + 2 = 1:00 AM (wraps midnight)', () => {
  assert.strictEqual(addHours('11:00 PM', 2), '1:00 AM');
});
test('addHours: 5:00 PM + 4.5 = 9:30 PM (fractional)', () => {
  assert.strictEqual(addHours('5:00 PM', 4.5), '9:30 PM');
});
test('addHours: returns null on unparseable', () => {
  assert.strictEqual(addHours('garbage', 1), null);
});
test('minutesToAmPm: 0 -> 12:00 AM', () => {
  assert.strictEqual(minutesToAmPm(0), '12:00 AM');
});
test('minutesToAmPm: 720 -> 12:00 PM', () => {
  assert.strictEqual(minutesToAmPm(720), '12:00 PM');
});
