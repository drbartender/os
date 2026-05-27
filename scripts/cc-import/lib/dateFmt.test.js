const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCcDate } = require('./dateFmt');

test('parseCcDate: 05-24-2026 -> Date(UTC 2026-05-24)', () => {
  const d = parseCcDate('05-24-2026');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-05-24T00:00:00.000Z');
});
test('parseCcDate: invalid -> null', () => {
  assert.strictEqual(parseCcDate('garbage'), null);
  assert.strictEqual(parseCcDate(''), null);
  assert.strictEqual(parseCcDate(null), null);
});
test('parseCcDate: 01-01-2025 -> Date', () => {
  const d = parseCcDate('01-01-2025');
  assert.strictEqual(d.toISOString(), '2025-01-01T00:00:00.000Z');
});
