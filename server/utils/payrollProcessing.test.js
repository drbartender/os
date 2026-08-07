require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  findOpenPeriodForDate, recomputePayoutTotal, recomputePayoutTotals,
  maybeFinalizePeriod, ensurePayout,
} = require('./payrollProcessing');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollProcessing.test.js refuses to run against production');
}

let userId, periodId, payoutId;
let flaggedId, cpDefaultId, profilelessId;

// ensurePayout fixture emails (pre-cleaned here, deleted in after()).
const EXTRA_EMAILS = "('proc-flagged@example.com','proc-cpdefault@example.com','proc-noprofile@example.com')";

before(async () => {
  // Pre-clean stranded ensurePayout fixtures from a crashed prior run.
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE email IN ${EXTRA_EMAILS})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE email IN ${EXTRA_EMAILS})`);
  await pool.query(`DELETE FROM users WHERE email IN ${EXTRA_EMAILS}`);

  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('proc@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;

  const mkUser = (e) => pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id", [e]
  );
  flaggedId = (await mkUser('proc-flagged@example.com')).rows[0].id;
  cpDefaultId = (await mkUser('proc-cpdefault@example.com')).rows[0].id;
  profilelessId = (await mkUser('proc-noprofile@example.com')).rows[0].id;
  // flagged = owner shape; cpDefault = profile row with the default flag;
  // profilelessId deliberately gets NO contractor_profiles row.
  await pool.query('INSERT INTO contractor_profiles (user_id, takes_draw) VALUES ($1, false)', [flaggedId]);
  await pool.query('INSERT INTO contractor_profiles (user_id) VALUES ($1)', [cpDefaultId]);
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
  // Period-scoped: ensurePayout tests create extra payouts on the shared
  // period, and the period delete would FK-violate past them otherwise.
  await pool.query(
    'DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE pay_period_id = $1)',
    [periodId]
  );
  await pool.query('DELETE FROM payouts WHERE pay_period_id = $1', [periodId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
});

after(async () => {
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE email IN ${EXTRA_EMAILS})`);
  await pool.query(`DELETE FROM users WHERE email IN ${EXTRA_EMAILS}`);
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

test('recomputePayoutTotal > includes payable duty lines; removed and held excluded', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
       VALUES ($1, $2, 2, 2, 2500, 5000, 5000)`,
      [payoutId, shiftId]
    );
    await pool.query(
      `INSERT INTO payout_duty_lines (payout_id, contractor_id, shift_id, kind, amount_cents, origin)
       VALUES ($1, $2, $3, 'bar_rental', 2000, 'auto')`,
      [payoutId, userId, shiftId]
    );
    await pool.query(
      `INSERT INTO payout_duty_lines (payout_id, contractor_id, kind, amount_cents, origin, removed_at)
       VALUES ($1, $2, 'review_bounty', 999, 'auto', NOW())`,
      [payoutId, userId]
    );
    await pool.query(
      `INSERT INTO payout_duty_lines (payout_id, contractor_id, kind, amount_cents, origin, held_state)
       VALUES ($1, $2, 'review_bounty', 500, 'admin', 'held')`,
      [payoutId, userId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 7000, 'events 5000 + payable duty 2000; removed/held ignored');
    // Bulk variant agrees with the single-payout writer.
    const bulk = await recomputePayoutTotals(pool, [payoutId]);
    assert.equal(Number(bulk[0].total_cents), 7000);
  } finally {
    await pool.query('DELETE FROM payout_duty_lines WHERE payout_id = $1', [payoutId]);
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('recomputePayoutTotal > clamp wraps the WHOLE sum: debt nets against duty pay', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    // Clawback-style debt stub: events sum -5000.
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
          adjustment_cents, line_total_cents)
       VALUES ($1, $2, 0, 0, 0, 0, -5000, -5000)`,
      [payoutId, shiftId]
    );
    await pool.query(
      `INSERT INTO payout_duty_lines (payout_id, contractor_id, shift_id, kind, amount_cents, origin)
       VALUES ($1, $2, $3, 'parking', 2000, 'auto')`,
      [payoutId, userId, shiftId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 0, 'GREATEST(0, -5000 + 2000) = 0, never GREATEST(0,-5000) + 2000 = 2000');
  } finally {
    await pool.query('DELETE FROM payout_duty_lines WHERE payout_id = $1', [payoutId]);
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

test('maybeFinalizePeriod > no_draw payouts do not block the flip', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  await pool.query("UPDATE payouts SET status = 'paid', paid_at = NOW() WHERE id = $1", [payoutId]);
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'no_draw', 5000)`,
    [periodId, flaggedId]
  );
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, true);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'paid');
});

test('ensurePayout > births pending for a contractor with the default flag', async () => {
  const id = await ensurePayout(pool, periodId, cpDefaultId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});

test('ensurePayout > births no_draw when takes_draw = false', async () => {
  const id = await ensurePayout(pool, periodId, flaggedId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'no_draw');
});

test('ensurePayout > upsert never rewrites an existing status', async () => {
  const first = await ensurePayout(pool, periodId, cpDefaultId); // born pending
  await pool.query('UPDATE contractor_profiles SET takes_draw = false WHERE user_id = $1', [cpDefaultId]);
  try {
    const second = await ensurePayout(pool, periodId, cpDefaultId);
    assert.equal(second, first);
    const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [first]);
    assert.equal(rows[0].status, 'pending');
  } finally {
    await pool.query('UPDATE contractor_profiles SET takes_draw = true WHERE user_id = $1', [cpDefaultId]);
  }
});

test('ensurePayout > no contractor_profiles row defaults to pending', async () => {
  const id = await ensurePayout(pool, periodId, profilelessId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});
