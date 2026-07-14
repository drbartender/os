'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PRICING_SNAPSHOT_VERSION, readSnapshot } = require('./pricingSnapshot');

test('readSnapshot > version stamp round-trips a current-version object', () => {
  const snap = { _version: PRICING_SNAPSHOT_VERSION, total: 800, breakdown: [] };
  const out = readSnapshot(snap, { context: 'test-current' });
  assert.equal(out, snap); // same object reference, untouched
  assert.equal(out._version, PRICING_SNAPSHOT_VERSION);
});

test('readSnapshot > legacy snapshot (no _version) is tolerated and returned', () => {
  const legacy = { total: 800, breakdown: [{ label: 'Package', amount: 800 }] };
  const out = readSnapshot(legacy, { context: 'test-legacy' });
  assert.deepEqual(out, legacy);
});

test('readSnapshot > future _version throws an Error naming the context', () => {
  const future = { _version: PRICING_SNAPSHOT_VERSION + 1, total: 800 };
  assert.throws(
    () => readSnapshot(future, { context: 'payrollAccrual' }),
    (err) => err instanceof Error && /payrollAccrual/.test(err.message)
  );
});

test('readSnapshot > accepts a JSON string identically to an object', () => {
  const obj = { _version: PRICING_SNAPSHOT_VERSION, total: 800, syrups: { count: 2 } };
  const fromString = readSnapshot(JSON.stringify(obj), { context: 'test-string' });
  assert.deepEqual(fromString, obj);
});

test('readSnapshot > null / undefined / empty return null', () => {
  assert.equal(readSnapshot(null, { context: 'test-null' }), null);
  assert.equal(readSnapshot(undefined, { context: 'test-undef' }), null);
  assert.equal(readSnapshot('', { context: 'test-empty' }), null);
});
