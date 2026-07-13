// Pure-function tests for the boundary no-double-count assert (fix 2). NO DB.
// A boundary_exception row only clashes with a payout when it falls INSIDE that
// payout's collection window [start_date, payday+14d] — an unrelated same-amount
// payout months away must not false-fail.
// Run: node --test server/scripts/staffPaymentImport/verifyImport.test.js
const test = require('node:test');
const assert = require('node:assert');
const { checkBoundaryNoDoubleCount, findLedgerResidue } = require('./verifyImport');

// Payout: period 2026-06-01, payday 2026-06-09 → window [2026-06-01, 2026-06-23].
const PAYOUT = { id: 5, contractor_id: 99, total_cents: 20000, start_date: '2026-06-01', payday: '2026-06-09' };
const exc = (paidOn, over = {}) => ({ row_fingerprint: 'fp-exc', contractor_id: 99, amount_cents: 20000, paid_on: paidOn, ...over });

test('an exception row clashing with a payout IN its window fails', () => {
  const f = checkBoundaryNoDoubleCount([exc('2026-06-09')], [PAYOUT]);
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /would double-count/);
  assert.match(f[0], /payout 5/);
});

test('a same-amount payout OUT of the window does not false-fail', () => {
  assert.strictEqual(checkBoundaryNoDoubleCount([exc('2026-09-15')], [PAYOUT]).length, 0); // months later
});

test('payday+14d edge is still in-window (clashes); payday+15d is out', () => {
  assert.strictEqual(checkBoundaryNoDoubleCount([exc('2026-06-23')], [PAYOUT]).length, 1);
  assert.strictEqual(checkBoundaryNoDoubleCount([exc('2026-06-24')], [PAYOUT]).length, 0);
});

test('a same-amount payout for a different contractor does not fail', () => {
  assert.strictEqual(checkBoundaryNoDoubleCount([exc('2026-06-09', { contractor_id: 7 })], [PAYOUT]).length, 0);
});

test('an amount off by more than 1¢ (in window) does not fail', () => {
  assert.strictEqual(checkBoundaryNoDoubleCount([exc('2026-06-09', { amount_cents: 25000 })], [PAYOUT]).length, 0);
});

test('no exception rows ⇒ no failures', () => {
  assert.deepStrictEqual(checkBoundaryNoDoubleCount([], [PAYOUT]), []);
});

// ==== E2 (b): DB-side ledger-residue scan (independent of run logs) ==========
// Rows in the ledger for THIS import's contractors whose fingerprint is NOT in
// (toImport ∪ retractions) are orphaned residue — a run log lost/deleted can no
// longer hide them. Pure set logic here; the SELECT that feeds it lives in run().
const dbRow = (fp) => ({ row_fingerprint: fp, contractor_id: 42 });

test('findLedgerResidue: a ledger fp not in toImport nor retractions is residue', () => {
  const rows = [dbRow('fp-a'), dbRow('fp-b'), dbRow('fp-stale')];
  assert.deepStrictEqual(findLedgerResidue(rows, [{ fingerprint: 'fp-a' }, { fingerprint: 'fp-b' }], []), ['fp-stale']);
});

test('findLedgerResidue: a retracted fp is NOT residue', () => {
  const rows = [dbRow('fp-a'), dbRow('fp-stale')];
  assert.deepStrictEqual(findLedgerResidue(rows, [{ fingerprint: 'fp-a' }], ['fp-stale']), []);
});

test('findLedgerResidue: every ledger row accounted for ⇒ empty', () => {
  const rows = [dbRow('fp-a'), dbRow('fp-b')];
  assert.deepStrictEqual(findLedgerResidue(rows, [{ fingerprint: 'fp-a' }, { fingerprint: 'fp-b' }], []), []);
});
