/**
 * The payroll accrual failure record (payrollAccrualFailures.js) as the accrual
 * helper's wrapper drives it, against the dev database: a throw is recorded and
 * cleared by the next good accrual, a completed event whose period is closed and
 * that holds no line is recorded as period_closed, and the list feeding the
 * payroll page and the Process gate finds an unaccrued event in an open period.
 *
 * Run: node --test server/utils/payrollAccrualFailures.test.js
 */
require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { accruePayoutsForProposal, __setAccrueImplForTest } = require('./payrollAccrual');
const { listAccrualProblems, accrualFailureReason, dismissAccrualFailure } = require('./payrollAccrualFailures');
const { __setLegalHoldIdsForTest } = require('./legalHold');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrualFailures.test.js refuses to run against production');
}

// Owns two far-past periods no other suite uses: P1 Tue 2016-03-08 .. Mon
// 2016-03-14 (open) and P2 Tue 2016-03-22 .. Mon 2016-03-28 (paid once seeded).
const TAG = 'accrual-failures-fixture';
const EMAIL = 'acc-fail-worker@example.com';
const EMAIL2 = 'acc-fail-worker2@example.com';
let workerId, worker2Id, p1Id, p2Id;

async function preClean() {
  const users = '(SELECT id FROM users WHERE email = ANY($1))';
  const emails = [EMAIL, EMAIL2];
  await pool.query(`DELETE FROM payroll_accrual_failures WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN ${users}`, [emails]);
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN ${users}`, [emails]);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${users})`, [emails]);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${users}`, [emails]);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM proposals WHERE event_type = $1`, [TAG]);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2016-03-08', '2016-03-22') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${users}`, [emails]);
  await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [emails]);
}

async function approve(shiftId, userId) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, userId]
  );
}

async function shiftOf(proposalId) {
  return (await pool.query('SELECT id FROM shifts WHERE proposal_id = $1', [proposalId])).rows[0].id;
}

async function makeEvent(date, { staffed = true } = {}) {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES (NULL, $1, 'completed', $2, '6:00 PM', 4, 500, 500, 1, '{"addons":[]}')
     RETURNING id`,
    [date, TAG]
  );
  const proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ($1, '6:00 PM', 'open', $2) RETURNING id`,
    [date, proposalId]
  );
  if (staffed) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
      [s.rows[0].id, workerId]
    );
  }
  return proposalId;
}

async function lineCount(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_events pe JOIN shifts s ON s.id = pe.shift_id WHERE s.proposal_id = $1`,
    [proposalId]
  );
  return rows[0].n;
}

async function failureRow(proposalId) {
  const { rows } = await pool.query('SELECT reason, attempts FROM payroll_accrual_failures WHERE proposal_id = $1', [proposalId]);
  return rows[0] || null;
}

const boom = () => Promise.reject(new Error('simulated accrual failure'));

before(async () => {
  await preClean();
  workerId = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [EMAIL]
  )).rows[0].id;
  worker2Id = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [EMAIL2]
  )).rows[0].id;
  for (const uid of [workerId, worker2Id]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [uid]
    );
  }
  p1Id = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-03-08', '2016-03-14', '2016-03-15', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  )).rows[0].id;
  p2Id = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-03-22', '2016-03-28', '2016-03-29', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  )).rows[0].id;
});

afterEach(() => { __setAccrueImplForTest(null); __setLegalHoldIdsForTest(null); });

after(async () => {
  __setAccrueImplForTest(null);
  __setLegalHoldIdsForTest(null);
  await preClean();
  await pool.end();
});

test('a throw is recorded as error and still reaches the caller; a later good accrual writes the lines and drops the record', async () => {
  const id = await makeEvent('2016-03-09');
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id), /simulated accrual failure/);
  assert.deepEqual(await failureRow(id), { reason: 'error', attempts: 1 });
  await assert.rejects(accruePayoutsForProposal(id), /simulated accrual failure/);
  assert.deepEqual(await failureRow(id), { reason: 'error', attempts: 2 }, 'a repeat failure counts, one row');
  const listed = await listAccrualProblems(pool, { periodId: p1Id });
  assert.ok(listed.some((r) => r.proposal_id === id && r.reason === 'error'), 'the period lists the recorded failure');

  __setAccrueImplForTest(null);
  const result = await accruePayoutsForProposal(id);
  assert.ok(!result.skipped, `accrual ran: ${JSON.stringify(result)}`);
  assert.ok((await lineCount(id)) > 0, 'the worker has a line');
  assert.equal(await failureRow(id), null, 'the record is gone');
  assert.equal(await accrualFailureReason(id), null);
  const after = await listAccrualProblems(pool, { periodId: p1Id });
  assert.ok(!after.some((r) => r.proposal_id === id), 'the period no longer lists it');
});

test('a completed, staffed event with no line whose period is not open is recorded as period_closed; one holding lines, and an unstaffed one, are not', async () => {
  // B is accrued while P2 is open, then P2 is paid: B holds a line.
  const withLines = await makeEvent('2016-03-23');
  await accruePayoutsForProposal(withLines);
  assert.ok((await lineCount(withLines)) > 0);
  await pool.query(`UPDATE pay_periods SET status = 'paid' WHERE id = $1`, [p2Id]);

  const lost = await makeEvent('2016-03-24');
  const r1 = await accruePayoutsForProposal(lost);
  assert.equal(r1.reason, 'pay_period_not_open', 'the result reaches the caller unchanged');
  assert.deepEqual(await failureRow(lost), { reason: 'period_closed', attempts: 1 });

  const r2 = await accruePayoutsForProposal(withLines);
  assert.equal(r2.reason, 'pay_period_not_open');
  assert.equal(await failureRow(withLines), null, 'a frozen period over lines it holds is the designed outcome');

  const unstaffed = await makeEvent('2016-03-25', { staffed: false });
  await accruePayoutsForProposal(unstaffed);
  assert.equal(await failureRow(unstaffed), null, 'no roster, no wages lost');

  const all = await listAccrualProblems(pool);
  assert.ok(all.some((r) => r.proposal_id === lost && r.reason === 'period_closed'), 'the payroll page lists the lost event');
  assert.ok(!all.some((r) => r.proposal_id === withLines || r.proposal_id === unstaffed));
});

test('an event error row whose frozen period holds its lines clears on a retry', async () => {
  const id = await makeEvent('2016-03-12');
  await accruePayoutsForProposal(id);
  await pool.query(`UPDATE pay_periods SET status = 'processing' WHERE id = $1`, [p1Id]);
  try {
    __setAccrueImplForTest(boom);
    await assert.rejects(accruePayoutsForProposal(id));
    assert.equal((await failureRow(id)).reason, 'error');
    __setAccrueImplForTest(null);
    const r = await accruePayoutsForProposal(id);
    assert.equal(r.reason, 'pay_period_not_open');
    assert.equal(await failureRow(id), null);
  } finally {
    await pool.query(`UPDATE pay_periods SET status = 'open' WHERE id = $1`, [p1Id]);
  }
});

test('a proposal that is no longer completed drops its record', async () => {
  const id = await makeEvent('2016-03-10');
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal((await failureRow(id)).reason, 'error');
  __setAccrueImplForTest(null);
  await pool.query(`UPDATE proposals SET status = 'balance_paid' WHERE id = $1`, [id]);
  const r = await accruePayoutsForProposal(id);
  assert.equal(r.reason, 'not_completed');
  assert.equal(await failureRow(id), null);
});

test('the list finds a completed, staffed event in an open period with no line and no record, and leaves out an unstaffed one', async () => {
  const gap = await makeEvent('2016-03-11');
  const unstaffed = await makeEvent('2016-03-13', { staffed: false });
  const inPeriod = await listAccrualProblems(pool, { periodId: p1Id });
  const row = inPeriod.find((r) => r.proposal_id === gap);
  assert.ok(row, 'the unaccrued event is listed');
  assert.equal(row.reason, 'no_lines');
  assert.equal(row.event_type, TAG);
  assert.ok(!inPeriod.some((r) => r.proposal_id === unstaffed));
  const all = await listAccrualProblems(pool);
  assert.ok(all.some((r) => r.proposal_id === gap && r.reason === 'no_lines'), 'the page-wide list has it too');
  const otherPeriod = await listAccrualProblems(pool, { periodId: p2Id });
  assert.ok(!otherPeriod.some((r) => r.proposal_id === gap), 'narrowed to the period it is dated in');
});

// Review round 1 (money, verify, seams, lifecycle, concurrency): "holds a line"
// is a wage line per approved worker, never a tip or claw stub or a teammate's.
test('a tip-only stub line on the shift does not count as wages: the closed-period event is still recorded', async () => {
  // P2 is paid by the second test; the event is dated in it.
  const id = await makeEvent('2016-03-26');
  const shiftId = await shiftOf(id);
  const payout = (await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET contractor_id = EXCLUDED.contractor_id RETURNING id`,
    [p1Id, workerId]
  )).rows[0].id;
  // The roll-forward's shape: no contracted hours, no hours, no rate, only tip cents.
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
     VALUES ($1, $2, 0, 0, 0, 0, 1000, 59, 941, 941)`,
    [payout, shiftId]
  );
  const r = await accruePayoutsForProposal(id);
  assert.equal(r.reason, 'pay_period_not_open');
  assert.equal((await failureRow(id)).reason, 'period_closed', 'the stub is not the worker\'s pay');
});

test('a teammate added after the period closed is recorded though another worker already has a wage line', async () => {
  await pool.query(`UPDATE pay_periods SET status = 'open' WHERE id = $1`, [p2Id]);
  const id = await makeEvent('2016-03-27');
  await accruePayoutsForProposal(id);
  assert.equal(await failureRow(id), null);
  await pool.query(`UPDATE pay_periods SET status = 'paid' WHERE id = $1`, [p2Id]);
  await approve(await shiftOf(id), worker2Id);
  const r = await accruePayoutsForProposal(id);
  assert.equal(r.reason, 'pay_period_not_open');
  assert.equal((await failureRow(id)).reason, 'period_closed', 'the late teammate has no line');
});

test('an error row clears once the roster is emptied (no_approved_workers)', async () => {
  const id = await makeEvent('2016-03-09');
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal((await failureRow(id)).reason, 'error');
  __setAccrueImplForTest(null);
  await pool.query(`UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1`, [await shiftOf(id)]);
  const r = await accruePayoutsForProposal(id);
  assert.equal(r.reason, 'no_approved_workers');
  assert.equal(await failureRow(id), null);
  const list = await listAccrualProblems(pool, { periodId: p1Id });
  assert.ok(!list.some((x) => x.proposal_id === id), 'nothing blocks the period');
});

test('a dismissed row stays dismissed while its reason repeats, and a new reason reopens it', async () => {
  const id = await makeEvent('2016-03-28');
  await accruePayoutsForProposal(id); // P2 is paid: period_closed
  assert.equal((await failureRow(id)).reason, 'period_closed');
  assert.equal(await dismissAccrualFailure(id, workerId), 'period_closed');
  assert.equal(await accrualFailureReason(id), null);
  await accruePayoutsForProposal(id); // a refund or roster hook re-runs it
  assert.equal(await accrualFailureReason(id), null, 'still dismissed');
  assert.ok(!(await listAccrualProblems(pool)).some((x) => x.proposal_id === id));
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal(await accrualFailureReason(id), 'error', 'a new reason is a new problem');
});

test('a dismissed error row in an open period still lists the event while a worker has no wage line', async () => {
  const id = await makeEvent('2016-03-14');
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  __setAccrueImplForTest(null);
  assert.equal(await dismissAccrualFailure(id, workerId), 'error');
  const row = (await listAccrualProblems(pool, { periodId: p1Id })).find((x) => x.proposal_id === id);
  assert.ok(row, 'the unpaid worker keeps it listed');
  assert.equal(row.reason, 'no_lines');
});

test('the legal-hold booking is never recorded or listed', async () => {
  const id = await makeEvent('2016-03-13');
  __setLegalHoldIdsForTest([id]);
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal(await failureRow(id), null, 'no record');
  __setAccrueImplForTest(null);
  assert.ok(!(await listAccrualProblems(pool, { periodId: p1Id })).some((x) => x.proposal_id === id), 'not a gap either');
});

// Review round 2 (money, verify, client): a held line is not pay, and a
// dismissal never hides a worker or a throw that came after it.
test('a held line does not count as wages: the closed-period event is recorded', async () => {
  const id = await makeEvent('2016-03-22');
  const payout = (await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET contractor_id = EXCLUDED.contractor_id RETURNING id`,
    [p2Id, workerId]
  )).rows[0].id;
  // The off-roster hold's shape: pay zeroed, contracted hours and rate kept.
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                adjustment_cents, line_total_cents, held_state)
     VALUES ($1, $2, 5.5, 0, 2000, 0, 1500, 0, 'held')`,
    [payout, await shiftOf(id)]
  );
  const r = await accruePayoutsForProposal(id);
  assert.equal(r.reason, 'pay_period_not_open');
  assert.equal((await failureRow(id)).reason, 'period_closed');
});

test('a dismissed closed-period row reopens when a worker becomes unpaid after the dismissal', async () => {
  const id = await makeEvent('2016-03-23');
  await accruePayoutsForProposal(id);
  assert.equal(await dismissAccrualFailure(id, workerId), 'period_closed');
  await accruePayoutsForProposal(id);
  assert.equal(await accrualFailureReason(id), null, 'the same unpaid worker keeps it dismissed');
  await approve(await shiftOf(id), worker2Id);
  await accruePayoutsForProposal(id);
  assert.equal(await accrualFailureReason(id), 'period_closed', 'the new worker reopens it');
});

test('a dismissed error row reopens on the next throw', async () => {
  const id = await makeEvent('2016-03-12');
  __setAccrueImplForTest(boom);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal(await dismissAccrualFailure(id, workerId), 'error');
  assert.equal(await accrualFailureReason(id), null);
  await assert.rejects(accruePayoutsForProposal(id));
  assert.equal(await accrualFailureReason(id), 'error', 'a throw can carry new money');
});
