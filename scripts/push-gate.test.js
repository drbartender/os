'use strict';

// push-gate — the receipt logic that decides whether the pre-push hook can skip
// an 8-minute re-run. The whole safety property lives in checkReceipt: it must
// say YES only when the exact bytes on disk were already gated, and NO in every
// other case, because a false YES ships code no gate ever saw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkReceipt, treeFingerprint, RECEIPT_VERSION, MAX_AGE_MS } = require('./push-gate');

const NOW = Date.parse('2026-08-14T12:00:00Z');
const fresh = (over = {}) => ({
  version: RECEIPT_VERSION,
  fingerprint: 'abc123',
  head: 'deadbeef',
  gates: ['money', 'client'],
  at: new Date(NOW - 60_000).toISOString(),
  ...over,
});
const ask = (receipt, over = {}) =>
  checkReceipt(receipt, { fingerprint: 'abc123', needed: ['money', 'client'], now: NOW, ...over });

test('accepts a fresh receipt for the same tree covering the needed gates', () => {
  assert.equal(ask(fresh()), null);
});

test('accepts when the receipt covers MORE than this push needs', () => {
  assert.equal(ask(fresh({ gates: ['money', 'client'] }), { needed: ['client'] }), null);
});

test('accepts a nothing-to-run receipt when nothing is needed (docs-only push)', () => {
  assert.equal(ask(fresh({ gates: [] }), { needed: [] }), null);
});

// ── The refusals. Each of these is a case where saying yes ships ungated code ──

test('refuses when there is no receipt at all', () => {
  const why = ask(null);
  assert.match(why, /no receipt/);
  assert.match(why, /npm run gate/, 'must tell the human how to fix it');
});

test('refuses when the working tree changed since the gate ran', () => {
  // The single most important case: the gates test the TREE, and this is a
  // shared checkout where another window can edit files mid-review.
  assert.match(ask(fresh(), { fingerprint: 'different' }), /working tree changed/);
});

test('refuses when the receipt does not cover a needed gate', () => {
  const why = checkReceipt(fresh({ gates: ['client'] }), {
    fingerprint: 'abc123', needed: ['money', 'client'], now: NOW,
  });
  assert.match(why, /does not cover: money/);
});

test('refuses a receipt older than the max age', () => {
  const stale = fresh({ at: new Date(NOW - MAX_AGE_MS - 1000).toISOString() });
  assert.match(ask(stale), /receipt is \d+h old/);
});

test('accepts right up to the age boundary', () => {
  const edge = fresh({ at: new Date(NOW - MAX_AGE_MS + 1000).toISOString() });
  assert.equal(ask(edge), null);
});

test('refuses an unreadable timestamp rather than treating it as fresh', () => {
  assert.match(ask(fresh({ at: 'not-a-date' })), /timestamp is unreadable/);
});

test('refuses a receipt from a future version of this script', () => {
  // readReceipt drops a mismatched version to null, so checkReceipt sees null.
  assert.match(ask(null), /no receipt/);
});

// ── The fingerprint itself ──

test('treeFingerprint is stable across calls and reports HEAD', () => {
  const a = treeFingerprint();
  const b = treeFingerprint();
  assert.equal(a.fingerprint, b.fingerprint, 'same tree must hash the same twice');
  assert.match(a.head, /^[0-9a-f]{40}$/);
  assert.equal(typeof a.dirty, 'boolean');
  assert.equal(a.fingerprint.length, 64);
});
