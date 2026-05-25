require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  findOpenPeriodForDate, recomputePayoutTotal, maybeFinalizePeriod,
} = require('./payrollProcessing');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollProcessing.test.js refuses to run against production');
}

let userId, periodId, payoutId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('proc@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-26','2026-06-01','2026-06-02','open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  );
  periodId = p.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1,$2,'pending',0) RETURNING id`,
    [periodId, userId]
  );
  payoutId = po.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM payout_events WHERE payout_id = $1', [payoutId]);
  await pool.query('DELETE FROM payouts WHERE id = $1', [payoutId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('findOpenPeriodForDate > returns the open period containing the date', async () => {
  const row = await findOpenPeriodForDate(pool, '2026-05-29');
  assert.equal(row.id, periodId);
  assert.equal(row.status, 'open');
});

test('findOpenPeriodForDate > returns null when no open period contains the date', async () => {
  const row = await findOpenPeriodForDate(pool, '2030-01-01');
  assert.equal(row, null);
});

test('recomputePayoutTotal > sums line_total_cents and writes to payouts.total_cents', async () => {
  // Need a shift to attach the payout_events line items to.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
       VALUES ($1, $2, 5.5, 5.5, 2000, 11000, 11000)`,
      [payoutId, shiftId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 11000);
    const { rows } = await pool.query('SELECT total_cents FROM payouts WHERE id = $1', [payoutId]);
    assert.equal(rows[0].total_cents, 11000);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('recomputePayoutTotal > floors at 0 when line items sum negative', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    // line_total_cents already floors at 0 per the column write path, but the
    // safety net at the SUM is the second belt: an adjustment-driven negative
    // SUM never escapes as a negative total_cents.
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
          adjustment_cents, line_total_cents)
       VALUES ($1, $2, 0, 0, 0, 0, -5000, 0)`,
      [payoutId, shiftId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 0);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('maybeFinalizePeriod > flips to paid when no pending payouts remain', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  await pool.query("UPDATE payouts SET status = 'paid' WHERE id = $1", [payoutId]);
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, true);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'paid');
});

test('maybeFinalizePeriod > does not flip when a pending payout remains', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  // payout is still pending.
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, false);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'processing');
});
