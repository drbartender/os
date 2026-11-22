// The decision for a leased job before any browser opens (spec laws 4, 7 and
// 9), the job budget, the Chicago day for the box's cap, and the rule that
// settles every report (plan decision 10). Pure. Run: `node --test src/decide.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideJob, underBudget, chicagoDayKey, finalResult, outageCheckDelay, budgetLeft,
} = require('./decide');

const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const BODY = `Your proposal: https://drbartender.com/proposal/${TOKEN}.`;
const JOB = { id: 41, phone: '+13125550123', body: BODY, negotiation_id: '500000000000000123' };
const CLICKED = { action: 'report', outcome: 'clicked_unverified' };

test('a journaled job id is reported clicked_unverified and never re-sent', () => {
  assert.deepEqual(decideJob({ job: JOB, journal: new Set(['41']), sentToday: 0, cap: 25 }), CLICKED);
  // Not the cap, not a broken body: a journaled id is only ever clicked_unverified.
  assert.deepEqual(decideJob({ job: { ...JOB, body: 'no link' }, journal: new Set(['41']), sentToday: 25, cap: 25 }), CLICKED);
  // The runner's journal wrapper answers the same as a Set.
  assert.deepEqual(decideJob({ job: JOB, journal: { has: (id) => id === '41' }, sentToday: 0, cap: 25 }), CLICKED);
});

test('cap reached reports failed_preclick cap', () => {
  assert.deepEqual(decideJob({ job: JOB, journal: new Set(), sentToday: 25, cap: 25 }),
    { action: 'report', outcome: 'failed_preclick', reason: 'cap' });
  assert.deepEqual(decideJob({ job: JOB, journal: new Set(), sentToday: 24, cap: 25 }), { action: 'run' });
  // A cap that is not a number fails closed.
  assert.deepEqual(decideJob({ job: JOB, journal: new Set(), sentToday: 0, cap: NaN }),
    { action: 'report', outcome: 'failed_preclick', reason: 'cap' });
});

test('invalid body reports failed_preclick invalid_body', () => {
  assert.deepEqual(decideJob({ job: { ...JOB, body: `${BODY} ${BODY}` }, journal: new Set(), sentToday: 0, cap: 25 }),
    { action: 'report', outcome: 'failed_preclick', reason: 'invalid_body' });
  assert.deepEqual(decideJob({ job: { ...JOB, phone: '3125550123' }, journal: new Set(), sentToday: 0, cap: 25 }),
    { action: 'report', outcome: 'failed_preclick', reason: 'invalid_number' });
});

test('a fresh valid job runs', () => {
  assert.deepEqual(decideJob({ job: JOB, journal: new Set(['40']), sentToday: 3, cap: 25 }), { action: 'run' });
});

test('chicagoDayKey rolls at Chicago midnight, not UTC', () => {
  // October is CDT (UTC-5): UTC midnight is still 7 pm the day before.
  assert.equal(chicagoDayKey(new Date('2026-10-20T00:00:00Z')), '2026-10-19');
  assert.equal(chicagoDayKey(new Date('2026-10-20T04:59:59Z')), '2026-10-19');
  assert.equal(chicagoDayKey(new Date('2026-10-20T05:00:00Z')), '2026-10-20');
  // January is CST (UTC-6).
  assert.equal(chicagoDayKey(new Date('2027-01-15T05:59:59Z')), '2027-01-14');
  assert.equal(chicagoDayKey(new Date('2027-01-15T06:00:00Z')), '2027-01-15');
});

test('underBudget is false at the budget and on a broken clock', () => {
  assert.equal(underBudget(1000, 1000 + 89999, 90000), true);
  assert.equal(underBudget(1000, 1000 + 90000, 90000), false);
  assert.equal(underBudget(1000, NaN, 90000), false);
  assert.equal(underBudget(1000, 2000, undefined), false);
});

test('finalResult never lets a journaled job fall back and keeps pre-click reasons whitelisted', () => {
  // Journaled: only sent or clicked_unverified, whatever the result says.
  assert.deepEqual(finalResult({ outcome: 'sent' }, true), { outcome: 'sent' });
  assert.deepEqual(finalResult({ outcome: 'failed_preclick', reason: 'cap' }, true), { outcome: 'clicked_unverified' });
  assert.deepEqual(finalResult(null, true), { outcome: 'clicked_unverified' });
  // Not journaled, no result: decision 10.
  assert.deepEqual(finalResult(null, false), { outcome: 'failed_preclick', reason: 'ui_error_before_send' });
  assert.deepEqual(finalResult({ outcome: 'skipped_already_posted' }, false), { outcome: 'skipped_already_posted' });
  assert.deepEqual(finalResult({ outcome: 'failed_preclick', reason: 'wrong_thread' }, false),
    { outcome: 'failed_preclick', reason: 'wrong_thread' });
  // A reason the server does not know would be a 400 there.
  assert.deepEqual(finalResult({ outcome: 'failed_preclick', reason: 'something_new' }, false),
    { outcome: 'failed_preclick', reason: 'ui_error_before_send' });
  // A click claimed without a journal entry is never a fallback.
  assert.deepEqual(finalResult({ outcome: 'sent' }, false), { outcome: 'clicked_unverified' });
  assert.deepEqual(finalResult({ outcome: 'sent', reason: 'x' }, true), { outcome: 'sent' });
});

test('the outage check backs off from a minute to five minutes after the first hour', () => {
  const schedule = { fastMs: 60000, slowMs: 300000, slowAfterMs: 3600000 };
  const since = Date.parse('2026-10-19T17:00:00Z');
  assert.equal(outageCheckDelay(since, since, schedule), 60000);
  assert.equal(outageCheckDelay(since, since + 59 * 60000, schedule), 60000);
  assert.equal(outageCheckDelay(since, since + 3600000 - 1, schedule), 60000);
  assert.equal(outageCheckDelay(since, since + 3600000, schedule), 300000);
  assert.equal(outageCheckDelay(since, since + 26 * 3600000, schedule), 300000);
  // A broken clock takes the slow check: fewer launches on the profile, never more.
  assert.equal(outageCheckDelay(undefined, since, schedule), 300000);
  assert.equal(outageCheckDelay(since, NaN, schedule), 300000);
});

test('budgetLeft is strictly under and fails closed', () => {
  assert.equal(budgetLeft(0, 60), true);
  assert.equal(budgetLeft(59, 60), true);
  assert.equal(budgetLeft(60, 60), false);
  assert.equal(budgetLeft(61, 60), false);
  assert.equal(budgetLeft(0, undefined), false);
  assert.equal(budgetLeft(NaN, 60), false);
});
