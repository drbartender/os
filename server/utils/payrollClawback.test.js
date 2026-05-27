require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { clawbackTip, clawbackTipByPaymentIntent } = require('./payrollClawback');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollClawback.test.js refuses to run against production');
}

let bartenderA, bartenderB, paidPeriodId, paidProposalId, paidShiftId, tipId;

before(async () => {
  const a = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('claw-a@example.com','x','staff') RETURNING id"
  );
  bartenderA = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('claw-b@example.com','x','staff') RETURNING id"
  );
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
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-12','2026-05-18','2026-05-19','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`
  );
  paidPeriodId = p.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2026-05-15', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  paidProposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','6:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  paidShiftId = s.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [paidShiftId, id]
    );
  }
  // The tip is already attached and paid out (refunded_amount_cents = 0).
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_claw_test', '2026-05-15 23:30:00+00', $2, 0)
     RETURNING id`,
    [bartenderA, paidShiftId]
  );
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id = $1 OR payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($2,$3))`,
    [paidShiftId, bartenderA, bartenderB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1,$2)', [bartenderA, bartenderB]);
  await pool.query(
    `DELETE FROM pay_periods WHERE status='open' AND start_date <> '2026-05-12'`
  );
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [paidShiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [paidShiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [paidProposalId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [paidPeriodId]);
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.end();
});

test('clawbackTip > full refund creates a negative adjustment split across bartenders', async () => {
  // The full $40 tip is refunded. fee was $1.28 → net $38.72. Split 2 ways:
  // [1936, 1936]. Both bartenders see -1936c on their next payout's line for
  // the original shift.
  const result = await clawbackTip(tipId, 4000);
  assert.equal(result.delta, 4000);
  assert.equal(result.bartenders, 2);

  const { rows } = await pool.query(
    `SELECT po.contractor_id, pe.adjustment_cents, pe.line_total_cents
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1 AND po.pay_period_id = $2
      ORDER BY po.contractor_id`,
    [paidShiftId, result.period_id]
  );
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].adjustment_cents), -1936);
  assert.equal(Number(rows[1].adjustment_cents), -1936);
  // line_total floors at 0 — no other income on the line.
  assert.equal(Number(rows[0].line_total_cents), 0);

  const tip = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(tip.rows[0].refunded_amount_cents), 4000);
});

test('clawbackTip > partial then full refund aggregates the delta correctly', async () => {
  // First refund $20 of 40, then a follow-up refund brings the cumulative to $40.
  await clawbackTip(tipId, 2000);
  await clawbackTip(tipId, 4000);
  const { rows } = await pool.query(
    `SELECT pe.adjustment_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1
      ORDER BY po.contractor_id`,
    [paidShiftId]
  );
  // Both clawbacks aggregate on the same line — total adjustment per bartender = -1936.
  assert.equal(Number(rows[0].adjustment_cents), -1936);
  assert.equal(Number(rows[1].adjustment_cents), -1936);
});

test('clawbackTip > a webhook replay with the same cumulative amount is a no-op', async () => {
  await clawbackTip(tipId, 4000);
  const replay = await clawbackTip(tipId, 4000);
  assert.equal(replay.delta, 0);
});

test('clawbackTip > skips and returns structured shape when target is a legacy CC stub', async () => {
  // cc-import: clawbacks on tips paid TO a stub bartender must NOT mutate
  // modern payouts. Setup a fresh stub user + tip pointed at the stub.
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('claw-stub@example.com','x','staff','legacy_cc:test:clawback')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const stubTip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_claw_stub', '2026-05-15 23:30:00+00', $2, 0)
     RETURNING id`,
    [stubId, paidShiftId]
  );
  const stubTipId = stubTip.rows[0].id;
  try {
    const result = await clawbackTip(stubTipId, 2500);
    assert.deepStrictEqual(result, { skipped: true, reason: 'legacy_cc_stub_target' });
    // Guard MUST fire before any DB writes: tips.refunded_amount_cents stays
    // at 0 (so a retry after de-stubbing is still possible), and no payout_events
    // were created for the stub user.
    const tipAfter = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [stubTipId]);
    assert.strictEqual(Number(tipAfter.rows[0].refunded_amount_cents), 0);
    const noPayout = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [stubId]
    );
    assert.strictEqual(noPayout.rows[0].c, 0);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [stubTipId]);
    await pool.query('DELETE FROM users WHERE id = $1', [stubId]);
  }
});

test('clawbackTipByPaymentIntent > inherits the legacy-stub skip from clawbackTip', async () => {
  // The webhook entry point looks up the tip by stripe_payment_intent_id and
  // calls clawbackTip; the same guard fires there. We don't assert the return
  // value (the webhook helper swallows the inner return), but we DO assert no
  // payout_events were written and refunded_amount_cents stayed at 0.
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('claw-stub-pi@example.com','x','staff','legacy_cc:test:claw-pi')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const piId = 'pi_claw_stub_pi_test';
  const stubTip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, $2, '2026-05-15 23:30:00+00', $3, 0)
     RETURNING id`,
    [stubId, piId, paidShiftId]
  );
  const stubTipId = stubTip.rows[0].id;
  try {
    await clawbackTipByPaymentIntent(piId, 2500);
    const tipAfter = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [stubTipId]);
    assert.strictEqual(Number(tipAfter.rows[0].refunded_amount_cents), 0);
    const noPayout = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [stubId]
    );
    assert.strictEqual(noPayout.rows[0].c, 0);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [stubTipId]);
    await pool.query('DELETE FROM users WHERE id = $1', [stubId]);
  }
});
