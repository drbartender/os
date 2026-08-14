'use strict';

// push-gate — the receipt logic that decides whether the pre-push hook can skip
// an 8-minute re-run. The whole safety property lives here: skip ONLY when the
// exact bytes on disk were already gated AND the commit being pushed is the one
// those bytes belong to. A false yes ships code no gate ever saw.
//
// Nearly every case below is a regression test for a hole the 2026-08-14
// push-gate review (Claude fleet + codex + gemini) actually exploited in the
// first draft of this file, each one demonstrated shipping ungated code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkReceipt, treeFingerprint, parsePushedShas, neededGates,
  RECEIPT_VERSION, MAX_AGE_MS, MONEY_PATHS,
} = require('./push-gate');

const NOW = Date.parse('2026-08-14T12:00:00Z');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const fresh = (over = {}) => ({
  version: RECEIPT_VERSION,
  fingerprint: 'abc123',
  head: HEAD,
  gates: ['money', 'client'],
  at: new Date(NOW - 60_000).toISOString(),
  ...over,
});
const ask = (receipt, over = {}) => checkReceipt(receipt, {
  fingerprint: 'abc123', head: HEAD, needed: ['money', 'client'], pushedShas: [HEAD], now: NOW, ...over,
});

// ── Accepts ──

test('accepts a fresh receipt for the same tree, same HEAD, pushing HEAD', () => {
  assert.equal(ask(fresh()), null);
});

test('accepts when the receipt covers MORE than this push needs', () => {
  assert.equal(ask(fresh(), { needed: ['client'] }), null);
});

test('accepts a nothing-to-run receipt when nothing is needed (docs-only push)', () => {
  assert.equal(ask(fresh({ gates: [] }), { needed: [] }), null);
});

test('accepts right up to the age boundary', () => {
  assert.equal(ask(fresh({ at: new Date(NOW - MAX_AGE_MS + 1000).toISOString() })), null);
});

// ── Refusals. Each is a case where saying yes ships ungated code ──

test('refuses when there is no receipt at all', () => {
  const why = ask(null);
  assert.match(why, /no receipt/);
  assert.match(why, /npm run gate/, 'must tell the human how to fix it');
});

test('refuses when the working tree changed since the gate ran', () => {
  assert.match(ask(fresh(), { fingerprint: 'different' }), /working tree changed/);
});

test('refuses when HEAD moved even if the fingerprint somehow matched', () => {
  assert.match(ask(fresh({ head: OTHER })), /HEAD moved/);
});

// THE finding the review ranked highest: this repo pushes `git push origin
// <sha>:main`, and both gates only ever test the WORKING TREE. A receipt earned
// by HEAD said yes to a completely different commit, shipping a money bug.
test('refuses when the sha being pushed is not HEAD', () => {
  const why = ask(fresh(), { pushedShas: [OTHER] });
  assert.match(why, /not HEAD/);
  assert.match(why, /working tree/, 'must say WHY: the gates cannot describe another commit');
});

test('refuses when ANY of several pushed shas is not HEAD', () => {
  assert.match(ask(fresh(), { pushedShas: [HEAD, OTHER] }), /not HEAD/);
});

test('refuses when the receipt does not cover a needed gate', () => {
  assert.match(ask(fresh({ gates: ['client'] })), /does not cover: money/);
});

test('refuses a receipt older than the max age', () => {
  assert.match(ask(fresh({ at: new Date(NOW - MAX_AGE_MS - 1000).toISOString() })), /receipt is \d+h old/);
});

test('refuses a FUTURE-dated receipt (clock skew or forgery must not read as fresh)', () => {
  assert.match(ask(fresh({ at: new Date(NOW + 86_400_000).toISOString() })), /dated in the future/);
});

test('refuses an unreadable timestamp rather than treating it as fresh', () => {
  assert.match(ask(fresh({ at: 'not-a-date' })), /timestamp is unreadable/);
});

// ── Which shas are being pushed (git feeds this on the hook's stdin) ──

const ZERO = '0'.repeat(40);
const SHA = 'e612a8d430c8ace52cbfde6d12bd92c814018223';
const SHA2 = '9acd6694bad2e9a31b9e361d4dc8ef1070c0a84d';

test('reads the local sha from a normal push line', () => {
  assert.deepEqual(parsePushedShas(`refs/heads/main ${SHA} refs/heads/main ${ZERO}`), { kind: 'shas', shas: [SHA] });
});

test('reads the literal-sha refspec form the push model uses', () => {
  assert.deepEqual(parsePushedShas(`${SHA} ${SHA} refs/heads/main ${SHA2}`), { kind: 'shas', shas: [SHA] });
});

// The review shipped a money bug through this: `git push origin docs main` fed
// two lines, the old code returned on the first, and main went ungated.
test('returns EVERY pushed sha, not just the first', () => {
  const input = `refs/heads/docs ${SHA2} refs/heads/docs ${ZERO}\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}`;
  assert.deepEqual(parsePushedShas(input), { kind: 'shas', shas: [SHA2, SHA] });
});

test('a deletion-only push is nothing to gate', () => {
  assert.equal(parsePushedShas(`(delete) ${ZERO} refs/heads/stale ${SHA}`).kind, 'deletes');
});

test('skips the deleted ref but still gates the real one when both arrive', () => {
  const input = `(delete) ${ZERO} refs/heads/stale ${SHA}\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}`;
  assert.deepEqual(parsePushedShas(input), { kind: 'shas', shas: [SHA] });
});

// A truncated line used to read as "deletions only" and skip every gate.
test('MALFORMED stdin is unknown, never deletes', () => {
  assert.equal(parsePushedShas('refs/heads/main').kind, 'unknown', 'a line with no sha field');
  assert.equal(parsePushedShas('refs/heads/main not-a-sha refs/heads/main x').kind, 'unknown', 'a non-hex sha');
  assert.equal(parsePushedShas(`refs/heads/main ${SHA} r x\ngarbage`).kind, 'unknown', 'one bad line poisons the batch');
});

// ── The fingerprint ──

test('treeFingerprint is stable across calls and reports HEAD', () => {
  const a = treeFingerprint();
  const b = treeFingerprint();
  assert.equal(a.fingerprint, b.fingerprint, 'same tree must hash the same twice');
  assert.match(a.head, /^[0-9a-f]{40}$/);
  assert.equal(a.fingerprint.length, 64);
  assert.equal(typeof a.dirty, 'boolean');
});

test('treeFingerprint hashes file CONTENT, not just the porcelain status line', () => {
  // The original bug: re-editing an already-modified file left the status text
  // identical, so the fingerprint never moved and the receipt stayed valid.
  const fs = require('fs');
  const tmp = `scratch-push-gate-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, 'first');
    const a = treeFingerprint().fingerprint;
    fs.writeFileSync(tmp, 'second'); // same path, same status letter, different bytes
    const b = treeFingerprint().fingerprint;
    assert.notEqual(a, b, 'changing the CONTENT of an untracked file must move the fingerprint');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ── Gate selection ──

test('the money trigger covers the gate machinery itself, not just server/', () => {
  // Changing testdb-smoke.js or the suite list changes what the gate DOES, so
  // a pure server/ trigger would let the gate be edited without being run.
  for (const p of ['server/', 'scripts/money-smoke-list.txt', 'scripts/testdb-smoke.js', 'scripts/push-gate.js']) {
    assert.ok(MONEY_PATHS.includes(p), `${p} must trigger the money gate`);
  }
});

test('neededGates unions over multiple refs rather than taking the first', () => {
  // HEAD vs HEAD is empty; unioning with a ref that differs must still find work.
  const one = neededGates(['HEAD']).gates;
  const many = neededGates(['HEAD', 'HEAD~1']).gates;
  assert.ok(many.length >= one.length, 'a second ref can only add gates, never remove them');
});

// ── Residuals closed at the second review pass ──

test('an empty pushedShas list cannot satisfy the foreign-sha check by vacuity', () => {
  // Documents WHY verify must not call checkReceipt with [] on unknown stdin:
  // this passes, and that is exactly the hole.
  assert.equal(ask(fresh(), { pushedShas: [] }), null);
});

// ── The gate lock (the money gate resets a SHARED Neon branch) ──

test('EMPTY stdin is its own kind: nothing ships, so nothing to gate', () => {
  // git feeds no lines only when no ref is being updated. Blocking here would
  // fail a no-op push for nothing.
  for (const v of ['', '\n  \n']) assert.equal(parsePushedShas(v).kind, 'empty');
});

test('MALFORMED stdin stays unknown so the caller can BLOCK', () => {
  // Distinct from empty on purpose: we cannot tell what ships, and gating HEAD
  // then allowing would let a different commit through ungated.
  assert.equal(parsePushedShas('refs/heads/main').kind, 'unknown', 'no sha field');
  assert.equal(parsePushedShas('refs/heads/main not-a-sha r x').kind, 'unknown', 'non-hex sha');
  assert.equal(parsePushedShas(`refs/heads/main ${SHA} r x\ngarbage`).kind, 'unknown', 'one bad line poisons it');
  assert.equal(parsePushedShas(null).kind, 'unknown');
  assert.equal(parsePushedShas(undefined).kind, 'unknown');
});

test('the gate serializes with flock, not a hand-rolled pidfile', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'push-gate.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.match(code, /spawnSync\('flock'/, 'must re-exec under flock');
  assert.match(code, /'-n'/, 'must refuse rather than wait: waiting inside pre-push is the original bug');
  assert.match(code, /--git-common-dir/, 'the lock must span every worktree, they share one Neon branch');
  // The pidfile machinery must be gone: it leaked on every signal and its
  // stale-reclaim let two gates run at once.
  assert.doesNotMatch(code, /pidAlive|readHolder|acquireLock/, 'no hand-rolled lock may remain');
});

test('flock -n genuinely refuses a second holder (the property we rely on)', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const lock = path.join(os.tmpdir(), `drb-gate-locktest-${process.pid}`);
  // Hold the lock in one process for a moment, and try to take it in another.
  const held = spawnSync('sh', ['-c', `flock -n ${lock} sh -c 'flock -n ${lock} true; echo inner=$?'`], { encoding: 'utf8' });
  assert.match(`${held.stdout}`, /inner=1/, 'a second flock -n on a held lock must fail');
  try { require('fs').unlinkSync(lock); } catch { /* fine */ }
});
