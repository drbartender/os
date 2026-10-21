'use strict';

// Tests for scripts/lib/receiptBase.js (instruction rewrite step 2, lane
// receipt-lib): finalize's judgment of the commits and the bases, as pure
// functions over the facts the CLI gathered. validate() runs them; its tests
// (receiptFinalize.test.js) cover them end to end. Nothing here touches git,
// the disk or the dev database.

const { test } = require('node:test');
const assert = require('node:assert');

const RB = require('./receiptBase');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const T = 'c'.repeat(40);

test('checkCommits: reviewed_against is the base, --stale-base too (rebase first), both on main, and a lane base is merge-base(main, tip)', () => {
  const M = 'e'.repeat(40);
  const facts = (o) => ({ base: A, reviewed: A, main: M, tip: T, mergeBase: A, baseOnTip: true, baseOnMain: true, reviewedOnMain: true, ...o });
  const lane = (o, flags = {}) => RB.checkCommits('lane', facts(o), flags);
  assert.deepStrictEqual(lane({}), []);
  assert.deepStrictEqual(lane({}, { staleBase: true }), [], 'a lane rebased onto the main it was reviewed against');
  assert.ok(lane({ reviewed: B }).some((p) => /^reviewed-against: bbbbbbb is not the base aaaaaaa; .*--stale-base/.test(p)));
  // --stale-base never stands in for the rebase (review 4, M1): the base must be --reviewed-against.
  const notRebased = 'stale-base: --reviewed-against bbbbbbb is not the base aaaaaaa; --stale-base is for a review moved onto a newer main: rebase onto bbbbbbb first (spec 3.7), re-pass what it changed and run the overlap pass, then finalize with --base bbbbbbb --reviewed-against bbbbbbb --stale-base';
  assert.deepStrictEqual(lane({ reviewed: B }, { staleBase: true }), [notRebased]);
  assert.ok(lane({ baseOnMain: false }).some((p) => /^base: aaaaaaa is not on main/.test(p)));
  assert.ok(lane({ reviewed: B, reviewedOnMain: false }, { staleBase: true }).some((p) => /^reviewed-against: bbbbbbb is not on main/.test(p)));
  assert.ok(lane({ mergeBase: B }).some((p) => /^base: a lane's base is merge-base\(main, tip\) bbbbbbb, not aaaaaaa/.test(p)));
  const qf = RB.checkCommits('quick-fix', facts({ head: A, files: ['x'] }), {});
  assert.deepStrictEqual(qf, []);
  assert.deepStrictEqual(RB.checkCommits('quick-fix', facts({ head: A, files: ['x'], reviewed: B }), { staleBase: true }).filter((p) => /^stale-base:/.test(p)), [notRebased]);
  // An ancestry git could not answer (null) is a refusal, never a pass.
  assert.deepStrictEqual(lane({ baseOnMain: null }), ['base: git could not say whether aaaaaaa is on main (refs/heads/main eeeeeee)']);
  assert.deepStrictEqual(lane({ reviewed: B, reviewedOnMain: null }, { staleBase: true }), [notRebased, 'reviewed-against: git could not say whether bbbbbbb is on main (refs/heads/main eeeeeee)']);
  assert.deepStrictEqual(lane({ baseOnTip: null }), ['base: git could not say whether aaaaaaa is an ancestor of the tip ccccccc']);
  assert.deepStrictEqual(lane({ baseOnTip: undefined }), ['base: git could not say whether aaaaaaa is an ancestor of the tip ccccccc'], 'a fact never gathered is no pass either');
  assert.ok(RB.checkCommits('commit', facts({ parent: A, reviewed: B }), {}).some((p) => /is not the base/.test(p)));
});
