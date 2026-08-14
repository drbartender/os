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

// ── Which sha is being pushed (git feeds this on the hook's stdin) ──
// The safety property: "I could not tell" must NEVER read as "nothing to do".
// Getting these two confused silently disables the entire gate.

const { parsePushedSha } = require('./push-gate');
const ZERO = '0'.repeat(40);
const SHA = 'e612a8d430c8ace52cbfde6d12bd92c814018223';

test('reads the local sha from a normal push line', () => {
  const r = parsePushedSha(`refs/heads/main ${SHA} refs/heads/main ${ZERO}`);
  assert.deepEqual(r, { kind: 'sha', sha: SHA });
});

test('reads the pushed sha from the literal-sha refspec form the push model uses', () => {
  // git push origin <sha>:main — the local ref is the sha itself.
  const r = parsePushedSha(`${SHA} ${SHA} refs/heads/main 9acd6694bad2e9a31b9e361d4dc8ef1070c0a84d`);
  assert.deepEqual(r, { kind: 'sha', sha: SHA });
});

test('a deletion-only push is nothing to gate', () => {
  const r = parsePushedSha(`(delete) ${ZERO} refs/heads/stale ${SHA}`);
  assert.equal(r.kind, 'deletes');
});

test('picks the real sha when a delete and a real push arrive together', () => {
  const r = parsePushedSha(`(delete) ${ZERO} refs/heads/stale ${SHA}\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}`);
  assert.deepEqual(r, { kind: 'sha', sha: SHA });
});

test('EMPTY stdin is unknown, not a free pass', () => {
  // The caller must fall back to gating HEAD. If this ever returned 'deletes'
  // the hook would skip every gate on every push and nobody would notice.
  assert.equal(parsePushedSha('').kind, 'unknown');
  assert.equal(parsePushedSha('\n  \n').kind, 'unknown');
  assert.equal(parsePushedSha(null).kind, 'unknown');
  assert.equal(parsePushedSha(undefined).kind, 'unknown');
});
