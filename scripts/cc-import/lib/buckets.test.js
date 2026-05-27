const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSkippedPackage, classify } = require('./buckets');

const TODAY = new Date(Date.UTC(2026, 4, 27)); // 2026-05-27

test('isSkippedPackage: exact match in SKIP_PACKAGES', () => {
  assert.strictEqual(isSkippedPackage('Inventory'), true);
  assert.strictEqual(isSkippedPackage('Bartending Services'), true);
  assert.strictEqual(isSkippedPackage('MGM Events'), true);
});
test('isSkippedPackage: SKIP_PATTERNS /MGM/i match', () => {
  assert.strictEqual(isSkippedPackage('MGM Holiday Party'), true);
  assert.strictEqual(isSkippedPackage('mgm corporate'), true);
});
test('isSkippedPackage: real package name is NOT skipped', () => {
  assert.strictEqual(isSkippedPackage('The Core Reaction'), false);
  assert.strictEqual(isSkippedPackage('Standard Wedding'), false);
});
test('isSkippedPackage: empty/null', () => {
  assert.strictEqual(isSkippedPackage(''), false);
  assert.strictEqual(isSkippedPackage(null), false);
  assert.strictEqual(isSkippedPackage(undefined), false);
});

test('classify: Bucket A (Confirmed + future, non-skip)', () => {
  const result = classify({
    status: 'Confirmed',
    eventDate: new Date(Date.UTC(2026, 5, 15)),
    packageName: 'The Core Reaction',
  }, TODAY);
  assert.strictEqual(result, 'A');
});
test('classify: Bucket B (Confirmed + past, non-skip)', () => {
  const result = classify({
    status: 'Confirmed',
    eventDate: new Date(Date.UTC(2026, 3, 10)),
    packageName: 'The Core Reaction',
  }, TODAY);
  assert.strictEqual(result, 'B');
});
test('classify: Bucket C (non-Confirmed)', () => {
  for (const status of ['Proposal', 'Sent', 'Lost', 'Cancelled']) {
    const result = classify({
      status,
      eventDate: new Date(Date.UTC(2026, 5, 15)),
      packageName: 'The Core Reaction',
    }, TODAY);
    assert.strictEqual(result, 'C', `expected C for status=${status}`);
  }
});
test('classify: Bucket C when no eventDate even if Confirmed', () => {
  const result = classify({
    status: 'Confirmed',
    eventDate: null,
    packageName: 'The Core Reaction',
  }, TODAY);
  assert.strictEqual(result, 'C');
});
test('classify: Bucket D (Confirmed + skip-package - beats date check)', () => {
  // Future date + Confirmed + skip package -> D, not A
  const result = classify({
    status: 'Confirmed',
    eventDate: new Date(Date.UTC(2026, 5, 15)),
    packageName: 'Inventory',
  }, TODAY);
  assert.strictEqual(result, 'D');
});
