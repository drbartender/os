const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMoneyCents } = require('./money');

test('parseMoneyCents: standard $X,XXX.XX', () => {
  assert.strictEqual(parseMoneyCents('$2,650'), 265000);
  assert.strictEqual(parseMoneyCents('$2,650.50'), 265050);
});
test('parseMoneyCents: $X.XX without commas', () => {
  assert.strictEqual(parseMoneyCents('$2.50'), 250);
});
test('parseMoneyCents: negative leading dash', () => {
  assert.strictEqual(parseMoneyCents('$-300'), -30000);
});
test('parseMoneyCents: parenthesized negative', () => {
  assert.strictEqual(parseMoneyCents('(50.00)'), -5000);
  assert.strictEqual(parseMoneyCents('$(50.00)'), -5000);
});
test('parseMoneyCents: null/empty/whitespace -> null', () => {
  assert.strictEqual(parseMoneyCents(''), null);
  assert.strictEqual(parseMoneyCents(null), null);
  assert.strictEqual(parseMoneyCents('   '), null);
});
test('parseMoneyCents: unparseable -> null', () => {
  assert.strictEqual(parseMoneyCents('garbage'), null);
});
test('parseMoneyCents: zero', () => {
  assert.strictEqual(parseMoneyCents('$0'), 0);
  assert.strictEqual(parseMoneyCents('$0.00'), 0);
});
