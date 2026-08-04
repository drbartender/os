require('dotenv').config();
const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { applyExtensionHours, maybeAlertPayroll } = require('./serviceExtensionPayroll');
const { contractedHours, wageCents } = require('./payrollMath');

if (process.env.NODE_ENV === 'production') {
  throw new Error('serviceExtensionPayroll.test.js refuses to run against production');
}

// Pay-period fixtures follow the standing track-and-restore law
// (payrollLateTip.test.js / payrollClawback.test.js): a period row this suite
// did not create is never deleted, only status-restored. These periods are
// keyed by EXPLICIT past dates (Tue-Mon weeks in Jan 2025, before the payroll
// system existed), not by "today", so the Chicago-vs-UTC drift that bit the
// late-tip suite (2026-07-13) cannot bite here; the module under test reads
// whatever period a payout line already sits in and never resolves a date.
const PERIODS = {
  open: { start: '2025-01-07', end: '2025-01-13', payday: '2025-01-14', status: 'open' },
  processing: { start: '2025-01-14', end: '2025-01-20', payday: '2025-01-21', status: 'processing' },
  reopened: { start: '2025-01-21', end: '2025-01-27', payday: '2025-01-28', status: 'reopened' },
};

const NONCE = `sep-${Date.now()}-${process.pid}`;
const RATE_CENTS = 4000; // $40/hr

let bartenderA, bartenderB;
let openPeriodId, processingPeriodId, reopenedPeriodId;
const trackedPeriods = []; // { id, preExisted, origStatus }
let createdProposalIds = [];
let createdShiftIds = [];

async function ensurePeriodTracked({ start, end, payday, status }) {
  const existing = await pool.query(
    'SELECT id, status FROM pay_periods WHERE start_date = $1 LIMIT 1', [start]
  );
  if (existing.rows[0]) {
    trackedPeriods.push({
      id: existing.rows[0].id, preExisted: true, origStatus: existing.rows[0].status,
    });
    if (existing.rows[0].status !== status) {
      await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2',
        [status, existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  const r = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [start, end, payday, status]
  );
  trackedPeriods.push({ id: r.rows[0].id, preExisted: false, origStatus: null });
  return r.rows[0].id;
}

/** One proposal + one shift (the single-shift shape the guard requires). */
async function seedEvent() {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2025-01-08', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  const proposalId = pr.rows[0].id;
  createdProposalIds.push(proposalId);
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2025-01-08', '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  createdShiftIds.push(s.rows[0].id);
  return { proposalId, shiftId: s.rows[0].id };
}

async function addShift(proposalId) {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2025-01-08', '7:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  createdShiftIds.push(s.rows[0].id);
  return s.rows[0].id;
}

async function seedLine({
  periodId, contractorId, shiftId,
  hours = 5.5, contracted = 5.5, rate = RATE_CENTS,
  gratuity = 0, cardTip = 0, adjustment = 0, heldState = null,
}) {
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET pay_period_id = EXCLUDED.pay_period_id
     RETURNING id`,
    [periodId, contractorId]
  );
  const payoutId = po.rows[0].id;
  const wage = heldState ? 0 : wageCents(hours, rate);
  const lineTotal = heldState ? 0 : wage + gratuity + cardTip + adjustment;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, card_tip_net_cents, adjustment_cents, line_total_cents, held_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [payoutId, shiftId, contracted, hours, rate, wage, gratuity, cardTip, adjustment, lineTotal, heldState]
  );
  await pool.query(
    `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
       SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
     ), 0)) WHERE po.id = $1`,
    [payoutId]
  );
  return payoutId;
}

async function readLine(payoutId, shiftId) {
  const { rows } = await pool.query(
    `SELECT contracted_hours, hours, rate_cents, wage_cents, gratuity_share_cents,
            card_tip_net_cents, adjustment_cents, line_total_cents, held_state
       FROM payout_events WHERE payout_id = $1 AND shift_id = $2`,
    [payoutId, shiftId]
  );
  return rows[0];
}

async function payoutTotal(payoutId) {
  const { rows } = await pool.query(
    'SELECT total_cents FROM payouts WHERE id = $1', [payoutId]
  );
  return Number(rows[0].total_cents);
}

before(async () => {
  // Pre-clean stranded fixtures from prior failed runs (FK chain, nonce prefix).
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN
    (SELECT id FROM payouts WHERE contractor_id IN
      (SELECT id FROM users WHERE email LIKE 'sep-%@example.test'))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN
    (SELECT id FROM users WHERE email LIKE 'sep-%@example.test')`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN
    (SELECT id FROM users WHERE email LIKE 'sep-%@example.test')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'sep-%@example.test'`);

  openPeriodId = await ensurePeriodTracked(PERIODS.open);
  processingPeriodId = await ensurePeriodTracked(PERIODS.processing);
  reopenedPeriodId = await ensurePeriodTracked(PERIODS.reopened);

  const mk = async (suffix) => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id`,
      [`${NONCE}-${suffix}@example.test`]
    );
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
       VALUES ($1, '3125550111', $2, 40)`,
      [u.rows[0].id, `${NONCE} ${suffix}`]
    );
    return u.rows[0].id;
  };
  bartenderA = await mk('a');
  bartenderB = await mk('b');
});

afterEach(async () => {
  // FK order: lines, payouts, shifts, proposals. Users and periods live for
  // the whole suite and are torn down in after().
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
    [bartenderA, bartenderB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)',
    [bartenderA, bartenderB]);
  if (createdShiftIds.length) {
    await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [createdShiftIds]);
  }
  if (createdProposalIds.length) {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [createdProposalIds]);
  }
  createdShiftIds = [];
  createdProposalIds = [];
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  // Restore reality for every period this suite touched: put back the original
  // status on a pre-existing row; delete the row only if THIS suite created it,
  // and only when nothing references it.
  for (const p of trackedPeriods) {
    if (p.preExisted) {
      await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2',
        [p.origStatus, p.id]);
    } else {
      await pool.query(
        `DELETE FROM pay_periods pp WHERE pp.id = $1
           AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
        [p.id]
      );
    }
  }
  await pool.end();
});

test('applyExtensionHours > re-seeds an untouched 5.5h line to contractedHours(4.5) = 6.0, never the bare 4.5', async () => {
  // The underpay guard (Task 12 Step 1). contractedHours(4) = 5.5 seeds the
  // line; a 30-minute extension to 4.5h must land at 6.0. If this ever reads
  // 4.5 the module grew a local hours helper and is CUTTING an hour of pay.
  assert.equal(contractedHours(4), 5.5);
  assert.equal(contractedHours(4.5), 6);

  const { proposalId, shiftId } = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
    gratuity: 1500, cardTip: 500, adjustment: 250,
  });

  const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(result.updatedLines, 1);
  assert.equal(result.lockedLines, 0);
  assert.equal(result.frozenLines, 0);
  assert.equal(result.multiShiftSkipped, false);
  assert.deepEqual(result.payoutIds, [payoutId]);

  const line = await readLine(payoutId, shiftId);
  assert.equal(Number(line.contracted_hours), 6);
  assert.equal(Number(line.hours), 6);
  assert.notEqual(Number(line.contracted_hours), 4.5);
});

test('applyExtensionHours > recomputes wage_cents and line_total_cents from the new hours', async () => {
  const { proposalId, shiftId } = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
    gratuity: 1500, cardTip: 500, adjustment: 250,
  });

  await applyExtensionHours({ proposalId, newDurationHours: 4.5 });

  const line = await readLine(payoutId, shiftId);
  const expectedWage = wageCents(6, RATE_CENTS); // 24000
  assert.equal(Number(line.wage_cents), expectedWage);
  assert.equal(Number(line.line_total_cents), expectedWage + 1500 + 500 + 250);
});

test('applyExtensionHours > recomputes the payout header total across touched and untouched lines', async () => {
  // Two single-shift proposals whose lines share ONE payout (same contractor,
  // same period). Only proposal 1 is extended; the header must equal the new
  // line 1 total plus the untouched line 2 total, or the paystub keeps showing
  // the pre-extension number.
  const ev1 = await seedEvent();
  const ev2 = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId: ev1.shiftId,
    gratuity: 1500, cardTip: 500, adjustment: 250,
  });
  const payoutId2 = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId: ev2.shiftId,
  });
  assert.equal(payoutId, payoutId2, 'both lines sit on the same payout');

  const result = await applyExtensionHours({ proposalId: ev1.proposalId, newDurationHours: 4.5 });
  assert.deepEqual(result.payoutIds, [payoutId]);

  const line1 = await readLine(payoutId, ev1.shiftId);
  const line2 = await readLine(payoutId, ev2.shiftId);
  assert.equal(Number(line1.line_total_cents), wageCents(6, RATE_CENTS) + 1500 + 500 + 250);
  assert.equal(Number(line2.line_total_cents), wageCents(5.5, RATE_CENTS), 'untouched sibling line unchanged');
  assert.equal(
    await payoutTotal(payoutId),
    Number(line1.line_total_cents) + Number(line2.line_total_cents)
  );
});

test('applyExtensionHours > an admin-edited line is left alone and counted in lockedLines', async () => {
  const { proposalId, shiftId } = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
    hours: 5, contracted: 5.5, gratuity: 1500,
  });
  const totalBefore = await payoutTotal(payoutId);

  const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(result.updatedLines, 0);
  assert.equal(result.lockedLines, 1);
  assert.equal(result.frozenLines, 0);
  assert.deepEqual(result.payoutIds, []);

  const line = await readLine(payoutId, shiftId);
  assert.equal(Number(line.hours), 5, 'admin-owned hours untouched');
  assert.equal(Number(line.contracted_hours), 5.5);
  assert.equal(Number(line.wage_cents), wageCents(5, RATE_CENTS));
  assert.equal(await payoutTotal(payoutId), totalBefore);
});

test('applyExtensionHours > processing and reopened periods are frozen: never written, counted in frozenLines', async () => {
  for (const periodId of [processingPeriodId, reopenedPeriodId]) {
    const { proposalId, shiftId } = await seedEvent();
    const payoutId = await seedLine({
      periodId, contractorId: bartenderA, shiftId,
    });

    const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
    assert.equal(result.updatedLines, 0);
    assert.equal(result.frozenLines, 1);
    assert.equal(result.lockedLines, 0);
    assert.deepEqual(result.payoutIds, []);

    const line = await readLine(payoutId, shiftId);
    assert.equal(Number(line.hours), 5.5, 'frozen-period line untouched');
    assert.equal(Number(line.contracted_hours), 5.5);
  }
});

test('applyExtensionHours > a replay with the same target is a no-op and does not rewrite the header', async () => {
  const { proposalId, shiftId } = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
    gratuity: 1500,
  });

  const first = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(first.updatedLines, 1);
  const totalAfterFirst = await payoutTotal(payoutId);

  const second = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(second.updatedLines, 0);
  assert.equal(second.lockedLines, 0);
  assert.equal(second.frozenLines, 0);
  assert.deepEqual(second.payoutIds, [], 'no touched payouts, so no header rewrite');

  const line = await readLine(payoutId, shiftId);
  assert.equal(Number(line.hours), 6);
  assert.equal(await payoutTotal(payoutId), totalAfterFirst);
});

test('applyExtensionHours > a proposal with no payout lines returns all zeros without error', async () => {
  const { proposalId } = await seedEvent(); // one shift, no payout lines

  const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.deepEqual(result, {
    updatedLines: 0, lockedLines: 0, frozenLines: 0,
    multiShiftSkipped: false, payoutIds: [],
  });
});

test('applyExtensionHours > a held line is never resurrected into a payable one', async () => {
  // A held line carries hours = contracted_hours = 0 with line_total_cents = 0
  // deliberately (off-roster worker, reimbursement tracked but not payable).
  // Both in-loop guards would pass on it (0 === 0, and 0 !== target), so only
  // the held_state IS NULL filter keeps it out.
  const { proposalId, shiftId } = await seedEvent();
  const payoutId = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
    hours: 0, contracted: 0, adjustment: 5000, heldState: 'held',
  });

  const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(result.updatedLines, 0);
  assert.equal(result.lockedLines, 0);
  assert.equal(result.frozenLines, 0);
  assert.deepEqual(result.payoutIds, []);

  const line = await readLine(payoutId, shiftId);
  assert.equal(Number(line.hours), 0);
  assert.equal(Number(line.contracted_hours), 0);
  assert.equal(Number(line.wage_cents), 0);
  assert.equal(Number(line.line_total_cents), 0);
  assert.equal(Number(line.adjustment_cents), 5000, 'tracked reimbursement untouched');
  assert.equal(line.held_state, 'held');
});

test('maybeAlertPayroll > fires on lockedLines, frozenLines, and multiShiftSkipped; silent when all clear', async () => {
  const calls = [];
  const notify = { alertAdminsProblem: async (args) => { calls.push(args); } };

  await maybeAlertPayroll(notify, 101, { lockedLines: 2, frozenLines: 0, multiShiftSkipped: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].proposalId, 101);
  assert.equal(calls[0].kind, 'payroll_hours_locked');
  assert.match(calls[0].detail, /2 payout line\(s\) were edited by hand/);
  assert.match(calls[0].detail, /NOT added to payroll automatically/);

  await maybeAlertPayroll(notify, 102, { lockedLines: 0, frozenLines: 1, multiShiftSkipped: false });
  assert.equal(calls.length, 2);
  assert.match(calls[1].detail, /1 payout line\(s\) sit in a pay period that is not open/);

  await maybeAlertPayroll(notify, 103, { lockedLines: 0, frozenLines: 0, multiShiftSkipped: true });
  assert.equal(calls.length, 3);
  assert.match(calls[2].detail, /multiple shift rows/);

  await maybeAlertPayroll(notify, 104, { lockedLines: 0, frozenLines: 0, multiShiftSkipped: false, updatedLines: 3 });
  assert.equal(calls.length, 3, 'clean result: no alert');
  await maybeAlertPayroll(notify, 105, null);
  assert.equal(calls.length, 3, 'missing result: no alert');
});

test('applyExtensionHours > a multi-shift event is not touched at all and reports multiShiftSkipped', async () => {
  // Two shift rows on one proposal; a proposal-wide bump would pay the second
  // crew for an hour they did not work, so nothing may be written.
  const { proposalId, shiftId } = await seedEvent();
  const shiftId2 = await addShift(proposalId);
  const payoutA = await seedLine({
    periodId: openPeriodId, contractorId: bartenderA, shiftId,
  });
  const payoutB = await seedLine({
    periodId: openPeriodId, contractorId: bartenderB, shiftId: shiftId2,
  });

  const result = await applyExtensionHours({ proposalId, newDurationHours: 4.5 });
  assert.equal(result.multiShiftSkipped, true);
  assert.equal(result.updatedLines, 0);
  assert.equal(result.lockedLines, 0);
  assert.equal(result.frozenLines, 0);
  assert.deepEqual(result.payoutIds, []);

  const lineA = await readLine(payoutA, shiftId);
  const lineB = await readLine(payoutB, shiftId2);
  assert.equal(Number(lineA.hours), 5.5, 'shift 1 line untouched');
  assert.equal(Number(lineA.contracted_hours), 5.5);
  assert.equal(Number(lineB.hours), 5.5, 'shift 2 line untouched');
  assert.equal(Number(lineB.contracted_hours), 5.5);
});
