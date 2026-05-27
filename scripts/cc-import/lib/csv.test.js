const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadCsv } = require('./csv');

test('loadCsv parses headers as object keys', () => {
  const rows = loadCsv(path.join(__dirname, '__fixtures__', 'tiny.csv'));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].ID, '1');
  assert.strictEqual(rows[0].Name, 'Alpha');
  assert.strictEqual(rows[0].Amount, '$1,000');
  assert.strictEqual(rows[2].Amount, '');
});
