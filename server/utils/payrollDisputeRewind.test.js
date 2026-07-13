require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  clawbackTipByPaymentIntent,
  rewindDisputeClawbackByPaymentIntent,
} = require('./payrollClawback');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { chicagoTodayYmd } = require('./businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollDisputeRewind.test.js refuses to run against production');
}

const PI = 'pi_rewind_test';

// clawbackTip lands its synthetic negative line in TODAY's OPEN period. Force
// today's Tue-Mon period open the same way production payroll would create it,
// so the clawback places (not defers) on a shared dev DB whose period may be paid.
async function ensureTodayPeriodOpen() {
  // Align with clawbackTip, which lands its line in the America/Chicago business
  // day (not the UTC day) — else near the date boundary the two pick different
  // Tue-Mon periods and the clawback-dependent assertions flake.
  const todayYmd = chicagoTodayYmd();
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  const payday = computePayday(endDate);
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'`,
    [startDate, endDate, payday]
  );
}

let bartenderA, bartenderB, proposalId, shiftId, tipId;

before(async () => {
  // Pre-clean stranded fixtures from prior failed runs (FK chain:
  // payout_events -> payouts -> tips/shift_requests/contractor_profiles -> users).
  const f = `email LIKE 'rw-%@example.com'`;
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM users WHERE ${f}`);

  const a = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ('rw-a@example.com','x','staff') RETURNING id");
  bartenderA = a.rows[0].id;
  const b = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ('rw-b@example.com','x','staff') RETURNING id");
  bartenderB = b.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [id]
    );
  }
});

beforeEach(async () => {
  await ensureTodayPeriodOpen();
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
  // Paid-out card tip, $40.00 / $1.28 fee, keyed by PI. refunded_amount_cents=0,
  // dispute_reinstated_at NULL (default) so the rewind is eligible to fire.
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, $2, '2026-05-15 23:30:00+00', $3, 0)
     RETURNING id`,
    [bartenderA, PI, shiftId]
  );
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id = $1 OR payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($2,$3))`,
    [shiftId, bartenderA, bartenderB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1,$2)', [bartenderA, bartenderB]);
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.end();
});

test('rewind > rolls the counter back by the reinstated amount and stamps dispute_reinstated_at', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  const r = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(r.rewound, 1);
  const { rows } = await pool.query(
    'SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0);
  assert.notEqual(rows[0].dispute_reinstated_at, null);
});

test('rewind > partial reinstate rolls back only that slice', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  const r = await rewindDisputeClawbackByPaymentIntent(PI, 2500);
  assert.equal(r.rewound, 1);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  // GREATEST(4000 - LEAST(2500,4000), 0) = 1500
  assert.equal(Number(rows[0].refunded_amount_cents), 1500);
});

test('rewind > reinstated greater than clawed floors at 0, never negative', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 1000 WHERE id = $1', [tipId]);
  await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  // GREATEST(1000 - LEAST(4000,1000), 0) = 0
  assert.equal(Number(rows[0].refunded_amount_cents), 0);
});

test('rewind > redelivery is a no-op (dispute_reinstated_at guard)', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  const replay = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(replay.rewound, 0);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0, 'counter not double-rewound on redelivery');
});

test('F5 sequence: withdraw -> reinstate -> redeliver reinstate (no-op) -> genuine refund re-claws', async () => {
  // 1. charge.dispute.funds_withdrawn: auto-clawback pulls the tip back.
  //    net = 4000 - round(128*4000/4000) = 3872; split 2 ways = [-1936, -1936].
  await clawbackTipByPaymentIntent(PI, 4000);
  let tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 4000);
  let adj = await pool.query(
    `SELECT COALESCE(SUM(pe.adjustment_cents),0) AS total FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE pe.shift_id = $1`, [shiftId]);
  assert.equal(Number(adj.rows[0].total), -3872);

  // 2. charge.dispute.funds_reinstated (we WON): rewind the counter. Manual
  //    re-pay of the bartenders is Phase-2 and intentionally NOT asserted here.
  const rw = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(rw.rewound, 1);
  tip = (await pool.query('SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 0);
  assert.notEqual(tip.dispute_reinstated_at, null);

  // 3. Redelivered reinstate: idempotent no-op, counter stays 0.
  const rwReplay = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(rwReplay.rewound, 0);
  tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 0);

  // 4. A later GENUINE refund now computes delta = 4000 - 0 and re-claws,
  //    instead of the F5 bug (refunded still 4000 -> delta=0 -> under-claw).
  await clawbackTipByPaymentIntent(PI, 4000);
  tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 4000);
  adj = await pool.query(
    `SELECT COALESCE(SUM(pe.adjustment_cents),0) AS total FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE pe.shift_id = $1`, [shiftId]);
  // The genuine refund adds a SECOND -3872 slice onto the same aggregated lines:
  // total auto-clawback is now -7744, proving the refund was collected, not lost.
  assert.equal(Number(adj.rows[0].total), -7744, 'genuine refund re-claws after reinstate rewind (F5 fix)');
});

test('handleDisputeFundsReinstated > rewinds the clawback counter (decoupled from the email path)', async () => {
  // Simulate the post-withdrawal state: counter already at the tip total.
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);

  const { handleDisputeFundsReinstated } = require('../routes/stripeWebhookHandlers/disputes');
  const event = { data: { object: { payment_intent: PI, amount: 4000, created: 1700000000 } } };
  let acked = null;
  const res = { json: (body) => { acked = body; return body; } };

  // notifyDisputeWon runs but log-and-skips its email (SEND_NOTIFICATIONS off in
  // dev); it never touches refunded_amount_cents / dispute_reinstated_at.
  await handleDisputeFundsReinstated(event, res);

  assert.deepEqual(acked, { received: true });
  const { rows } = await pool.query(
    'SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0, 'handler rewound the counter');
  assert.notEqual(rows[0].dispute_reinstated_at, null);
});

test('rewind > disarms a still-DEFERRED clawback so retryDeferredTips cannot auto-claw a won dispute', async () => {
  // Withdrawal hit a FROZEN period: clawback deferred, counter never advanced (0),
  // but defer_kind='clawback' is armed. On a WON dispute the rewind must clear it,
  // else retryDeferredTips later replays clawbackTip(defer_target_cents) and claws
  // the bartender for a charge that stands.
  await pool.query(
    `UPDATE tips SET refunded_amount_cents = 0, deferred_at = NOW(),
        defer_kind = 'clawback', defer_target_cents = 4000, defer_attempts = 1
      WHERE id = $1`, [tipId]);
  const r = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(r.rewound, 1);
  const { rows } = await pool.query(
    `SELECT deferred_at, defer_kind, defer_target_cents, defer_attempts, dispute_reinstated_at
       FROM tips WHERE id = $1`, [tipId]);
  assert.equal(rows[0].defer_kind, null, 'armed clawback defer marker cleared');
  assert.equal(rows[0].deferred_at, null);
  assert.equal(rows[0].defer_target_cents, null);
  assert.equal(Number(rows[0].defer_attempts), 0);
  assert.notEqual(rows[0].dispute_reinstated_at, null);
});

test('rewind > leaves a roll_forward defer marker untouched (late-tip placement, not a dispute)', async () => {
  await pool.query(
    `UPDATE tips SET refunded_amount_cents = 0, deferred_at = NOW(),
        defer_kind = 'roll_forward', defer_target_cents = 4000, defer_attempts = 1
      WHERE id = $1`, [tipId]);
  await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  const { rows } = await pool.query(
    'SELECT defer_kind, defer_target_cents FROM tips WHERE id = $1', [tipId]);
  assert.equal(rows[0].defer_kind, 'roll_forward', 'roll_forward placement must NOT be cleared by a dispute rewind');
  assert.equal(Number(rows[0].defer_target_cents), 4000);
});
