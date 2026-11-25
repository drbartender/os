// server/utils/packageSwaps.test.js
// A proposal's own drink swaps: the checker, the signed record that freezes them and the
// sign-time email that prints them. Pure: no DB. Synthetic package and bottle names.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { swapsForPackage } = require('./packageSwaps');
const { signedPriceRecord } = require('./publicSnapshot');
const { signedRecordFromRow, signedRecordBlock } = require('./signedRecordEmail');

const RAW = {
  package_slug: 'test-package',
  swaps: [
    { from: 'Test Bourbon', to: 'Other Bourbon – Soft and spicy.' },
    { from: ' Test Beer ', to: ' Test IPA ' },
  ],
};

test('swaps answer for their own package, trimmed', () => {
  assert.deepEqual(swapsForPackage(RAW, 'test-package'), [
    { from: 'Test Bourbon', to: 'Other Bourbon – Soft and spicy.' },
    { from: 'Test Beer', to: 'Test IPA' },
  ]);
});

test('another package, no package or no row reads as no swaps', () => {
  assert.deepEqual(swapsForPackage(RAW, 'other-package'), []);
  assert.deepEqual(swapsForPackage(RAW, null), []);
  assert.deepEqual(swapsForPackage(null, 'test-package'), []);
  assert.deepEqual(swapsForPackage(undefined, 'test-package'), []);
});

test('anything malformed reads as no swaps, never a partial list', () => {
  const bad = [
    [],
    'test-package',
    { package_slug: 'test-package' },
    { package_slug: 'test-package', swaps: [] },
    { package_slug: 'test-package', swaps: 'Test Bourbon' },
    { package_slug: 'test-package', swaps: [{ from: 'Test Bourbon', to: 'Other' }, { from: 'Test Beer' }] },
    { package_slug: 'test-package', swaps: [{ from: '   ', to: 'Other' }] },
    { package_slug: 'test-package', swaps: [{ from: 5, to: 'Other' }] },
    { package_slug: 'test-package', swaps: [null] },
    { package_slug: 'test-package', swaps: [{ from: 'x'.repeat(201), to: 'Other' }] },
    { package_slug: 'test-package', swaps: [{ from: 'Test', to: 'y'.repeat(401) }] },
    { package_slug: 'test-package', swaps: Array.from({ length: 31 }, (_, i) => ({ from: `A${i}`, to: `B${i}` })) },
  ];
  for (const raw of bad) assert.deepEqual(swapsForPackage(raw, 'test-package'), [], JSON.stringify(raw).slice(0, 80));
});

const SNAP = {
  total: 100, package: { name: 'Test Package', base_cost: 100 },
  breakdown: [{ label: 'Test Package', amount: 100 }], gratuity: { total: 0 },
};

test('the signed record carries the swaps it was given', () => {
  const swaps = swapsForPackage(RAW, 'test-package');
  const rec = signedPriceRecord(SNAP, { packageName: 'Test Package', documentVersion: 'v1', total: 100, packageSwaps: swaps });
  assert.deepEqual(rec.package_swaps, swaps);
});

test('a record with no swaps keeps its old shape', () => {
  const rec = signedPriceRecord(SNAP, { packageName: 'Test Package', documentVersion: 'v1', total: 100, packageSwaps: [] });
  assert.ok(!('package_swaps' in rec));
  const rec2 = signedPriceRecord(SNAP, { packageName: 'Test Package', documentVersion: 'v1', total: 100 });
  assert.ok(!('package_swaps' in rec2));
});

test('the sign-time email prints each swap by name, in html and text', () => {
  const swaps = swapsForPackage(RAW, 'test-package');
  const snap = signedPriceRecord(SNAP, { packageName: 'Test Package', documentVersion: 'v1', total: 100, packageSwaps: swaps });
  const record = signedRecordFromRow({
    client_signed_at: '2026-11-25T18:00:00Z', client_signed_name: 'Test Signer',
    client_signature_document_version: 'v1', client_signed_snapshot: snap,
  });
  const { html, text } = signedRecordBlock(record);
  assert.match(text, /Bar changes in your package:/);
  assert.match(text, /- Other Bourbon in place of Test Bourbon/);
  assert.match(text, /- Test IPA in place of Test Beer/);
  assert.ok(!text.includes('Soft and spicy'));
  assert.match(html, /<li>Other Bourbon in place of Test Bourbon<\/li>/);
});

test('an email for a record with no swaps prints no swap block', () => {
  const record = signedRecordFromRow({
    client_signed_at: '2026-11-25T18:00:00Z', client_signed_name: 'Test Signer',
    client_signature_document_version: 'v1', client_signed_snapshot: signedPriceRecord(SNAP, { total: 100 }),
  });
  const { html, text } = signedRecordBlock(record);
  assert.ok(!text.includes('Bar changes'));
  assert.ok(!html.includes('Bar changes'));
});
