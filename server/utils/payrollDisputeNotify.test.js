require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { notifyDisputeWon } = require('./payrollDisputeNotify');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollDisputeNotify.test.js refuses to run against production');
}

let bartenderA, bartenderB, periodId, proposalId, shiftId, tipId;

before(async () => {
  const a = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('disp-won-a@example.com','x','staff') RETURNING id"
  );
  bartenderA = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('disp-won-b@example.com','x','staff') RETURNING id"
  );
  bartenderB = b.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, hourly_rate)
       VALUES ($1, $2, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET preferred_name = EXCLUDED.preferred_name`,
      [id, id === bartenderA ? 'Alex' : 'Beth']
    );
  }
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-12','2026-05-18','2026-05-19','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`
  );
  periodId = p.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2026-05-15', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','6:00 PM','open',$1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [shiftId, id]
    );
  }
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id,
                       refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_disp_won_test', '2026-05-15 23:30:00+00', $2, 4000)
     RETURNING id`,
    [bartenderA, shiftId]
  );
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.end();
});

test('notifyDisputeWon > flips dispute_won_at and resolves bartender names', async () => {
  const result = await notifyDisputeWon(tipId, {
    reinstatedAmountCents: 4000,
    disputeOpenedAt: new Date('2026-05-16T10:00:00Z'),
    disputeWonAt: new Date('2026-05-24T10:00:00Z'),
  });
  assert.equal(result.bartenders.length, 2);
  assert.deepEqual(
    result.bartenders.map(b => b.name).sort(),
    ['Alex', 'Beth']
  );
  // Net per bartender = round((4000 - 128) / 2) = 1936, sums to net.
  assert.equal(
    result.bartenders.reduce((a, b) => a + b.shareCents, 0),
    4000 - 128
  );
  const { rows } = await pool.query('SELECT dispute_won_at FROM tips WHERE id = $1', [tipId]);
  assert.ok(rows[0].dispute_won_at);
});

test('notifyDisputeWon > a second call is idempotent (no-op when flag is set)', async () => {
  await notifyDisputeWon(tipId, {
    reinstatedAmountCents: 4000,
    disputeOpenedAt: new Date(),
    disputeWonAt: new Date(),
  });
  const second = await notifyDisputeWon(tipId, {
    reinstatedAmountCents: 4000,
    disputeOpenedAt: new Date(),
    disputeWonAt: new Date(),
  });
  assert.equal(second, null);
});

test('notifyDisputeWon > returns null when the tip is unknown', async () => {
  const res = await notifyDisputeWon(999999999, {
    reinstatedAmountCents: 1000,
    disputeOpenedAt: new Date(),
    disputeWonAt: new Date(),
  });
  assert.equal(res, null);
});
