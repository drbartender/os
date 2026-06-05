const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./gratuityLabels');

test('canonical labels are the load-bearing strings payroll keys on', () => {
  assert.strictEqual(L.SHARED_GRATUITY_LABEL, 'Shared Gratuity');
  assert.strictEqual(L.GRATUITY_LABEL, 'Gratuity');
  assert.deepStrictEqual(L.GRATUITY_PAYROLL_LABELS, ['Shared Gratuity', 'Gratuity']);
});

test('resolver prefers the snapshot frozen map, then the current display map, then raw', () => {
  assert.strictEqual(L.resolveGratuityDisplayLabel('Shared Gratuity', null), 'Staffing Gratuity');
  assert.strictEqual(L.resolveGratuityDisplayLabel('Gratuity', null), 'Gratuity');
  assert.strictEqual(L.resolveGratuityDisplayLabel('Bar Rental', null), 'Bar Rental');
  const snap = { display_labels: { 'Shared Gratuity': 'OLD WORDING' } };
  assert.strictEqual(L.resolveGratuityDisplayLabel('Shared Gratuity', snap), 'OLD WORDING');
});

test('client mirror keeps identical VALUES and the same resolver branches', () => {
  const clientSrc = fs.readFileSync(
    path.join(__dirname, '../../client/src/utils/gratuityLabels.js'), 'utf8'
  );
  // value parity
  for (const v of [L.SHARED_GRATUITY_LABEL, L.GRATUITY_LABEL, L.SHARED_GRATUITY_DISPLAY, L.GRATUITY_DISPLAY]) {
    assert.ok(clientSrc.includes(`'${v}'`), `client mirror must contain value '${v}'`);
  }
  // resolver-logic parity (not just values): the same two branch returns + frozen-map lookup
  assert.ok(clientSrc.includes('export function resolveGratuityDisplayLabel'));
  assert.ok(clientSrc.includes('snapshot.display_labels'));
  assert.ok(clientSrc.includes('=== SHARED_GRATUITY_LABEL'));
  assert.ok(clientSrc.includes('=== GRATUITY_LABEL'));
});
