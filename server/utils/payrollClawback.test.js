require('dotenv').config();
const { test, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { clawbackTip, clawbackTipByPaymentIntent } = require('./payrollClawback');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollClawback.test.js refuses to run against production');
}

// Two sub-tests pre-seed payouts in today's open period via a `SELECT id FROM
// pay_periods WHERE status='open' AND CURRENT_DATE BETWEEN ...` subquery. On a
// shared dev DB with no open period covering today (e.g. all periods are
// `paid` or the open one ends before today), that subquery returns NULL and
// the payouts.pay_period_id NOT NULL constraint fires. Force-open the period
// for today's date the same way production payroll code would create it.
async function ensureTodayPeriodOpen() {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  const payday = computePayday(endDate);
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'`,
    [startDate, endDate, payday]
  );
}

let bartenderA, bartenderB, paidPeriodId, paidProposalId, paidShiftId, tipId;

before(async () => {
  // Pre-clean any stranded fixtures from prior failed runs (full FK chain:
  // payout_events -> payouts -> tips/shift_requests/contractor_profiles -> users).
  // The user-delete is broadened to every 'cb-%' fixture so a sub-test that
  // leaks (e.g. an interrupted run) self-heals on the next run.
  const fixtureFilter = `email LIKE 'claw-%@example.com' OR email LIKE 'cb-%@example.com'`;
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${fixtureFilter}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

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
  // This suite's own paid ("already settled") period, on a UNIQUE far-past week
  // (Tue 2019-03-05..Mon 2019-03-11) that no other payroll suite uses — the tip's
  // original event lives here. The clawback itself lands in TODAY's open period
  // (chicagoTodayYmd), so this seeded period is only ever referenced by its id.
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-03-05','2019-03-11','2019-03-12','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`
  );
  paidPeriodId = p.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2019-03-05', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  paidProposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-03-05','6:00 PM','open',$1) RETURNING id`,
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
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_claw_test', '2019-03-05 23:30:00+00', $2, 0)
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
  // Only delete the open period if it has no payouts referencing it (the dev
  // DB's shared open period must be preserved). This suite's own paid period
  // (2019-03-05) is preserved separately and torn down by id below.
  await pool.query(
    `DELETE FROM pay_periods pp WHERE pp.status='open' AND pp.start_date <> '2019-03-05'
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`
  );
  // Defense in depth: any tip targeting either fixture bartender, even if
  // created by a sub-test that didn't reach its finally.
  await pool.query('DELETE FROM tips WHERE target_user_id IN ($1, $2)', [bartenderA, bartenderB]);
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

test('clawbackTip > Chicago evening (Mon 18:30 CST) claws into the CURRENT Tue-Mon period, not next week (T4)', async () => {
  // Mon 2026-01-19 18:30 CST = Tue 2026-01-20 00:30 UTC. chicagoTodayYmd() reads
  // the Chicago Monday (19th); its Tue-Mon period is 2026-01-13..2026-01-19. The
  // old UTC pick saw the 20th (Tuesday) and would have opened NEXT week's period
  // (start 2026-01-20), landing the clawback a week late.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-20T00:30:00Z') });
  try {
    const result = await clawbackTip(tipId, 4000);
    assert.equal(result.bartenders, 2);
    const { rows } = await pool.query(
      "SELECT to_char(start_date, 'YYYY-MM-DD') AS start_ymd FROM pay_periods WHERE id = $1",
      [result.period_id]
    );
    assert.equal(rows[0].start_ymd, '2026-01-13',
      'claws into the current Tue-Mon period (Chicago Monday), not next week (2026-01-20)');
  } finally {
    mock.timers.reset();
  }
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
  // H1: the synthetic line carries its NEGATIVE total (the old GREATEST(0,...)
  // floor zeroed it, silently un-collecting every cross-period clawback).
  assert.equal(Number(rows[0].line_total_cents), -1936);

  // With no other earnings this period, the payout-level clamp holds the
  // payable amount at 0 (money out is never negative); the residual is
  // Sentry-warned for manual recovery.
  const { rows: po } = await pool.query(
    `SELECT total_cents FROM payouts WHERE contractor_id = $1 AND pay_period_id = $2`,
    [bartenderA, result.period_id]
  );
  assert.equal(Number(po[0].total_cents), 0);

  const tip = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(tip.rows[0].refunded_amount_cents), 4000);
});

test('clawbackTip > H1: cross-period clawback nets against current-period earnings', async () => {
  // Bartender A earned a $50.00 wage line this period on another shift. The
  // $40 tip from the PAID prior period is fully refunded: A's share is -1936,
  // which must actually reduce this period's payable total (5000 - 1936 = 3064).
  await ensureTodayPeriodOpen();
  const { rows: [period] } = await pool.query(
    `SELECT id FROM pay_periods WHERE status = 'open'
      AND CURRENT_DATE BETWEEN start_date AND end_date`
  );
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO NOTHING`,
    [period.id, bartenderA]
  );
  const { rows: [s2] } = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES (CURRENT_DATE, '6:00 PM', 'open', $1) RETURNING id`,
    [paidProposalId]
  );
  try {
    await pool.query(
      `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
       SELECT po.id, $1, 4, 4, 1250, 5000, 5000 FROM payouts po
        WHERE po.contractor_id = $2 AND po.pay_period_id = $3`,
      [s2.id, bartenderA, period.id]
    );
    await clawbackTip(tipId, 4000);
    const { rows: [po] } = await pool.query(
      `SELECT total_cents FROM payouts WHERE contractor_id = $1 AND pay_period_id = $2`,
      [bartenderA, period.id]
    );
    // A's clawback share of the 3872c net split is 1936c. The 5000c wage
    // absorbs it: payable = 3064, not 5000 (old behavior) and not 0.
    assert.equal(Number(po.total_cents), 3064);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [s2.id]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [s2.id]);
  }
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

test('clawbackTip > cumulative fee: 100c tip / 33c fee refunded in two 50c slices claws exactly 67c net', async () => {
  // Boundary case for the fee split. Per-delta rounding claws 34c of fee
  // (round(33*50/100) twice = 17+17) leaving 66c net; the cumulative
  // computation claws the correct 33c of fee (17 then 16), leaving 67c net.
  await pool.query('UPDATE tips SET amount_cents = 100, fee_cents = 33 WHERE id = $1', [tipId]);
  await clawbackTip(tipId, 50);   // first 50c refund
  await clawbackTip(tipId, 100);  // cumulative to 100c (full refund)
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(pe.adjustment_cents), 0) AS total
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1`,
    [paidShiftId]
  );
  assert.equal(Number(rows[0].total), -67, 'net clawed across both bartenders is exactly 67c, not 66c');
});

test('clawbackTip > mixed-stub shift: claws back from real bartender only, stubs filtered out', async () => {
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-mixed-stub@example.com','x','staff','legacy_cc:test:cb-mixed') RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const real = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('cb-mixed-real@example.com','x','staff') RETURNING id`
  );
  const realId = real.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [realId]
  );
  const mixedShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-03-05','7:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  const mixedShiftId = mixedShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [mixedShiftId, stubId, realId]
  );

  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, rolled_forward_at, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_cb_mixed', NOW() - INTERVAL '1 day', $2, NOW(), 0)
     RETURNING id`,
    [stubId, mixedShiftId]
  );
  const cbTipId = tipRes.rows[0].id;
  // Seed the real bartender's payout_event (what rollForwardLateTip on a mixed
  // shift would have created via the new code path).
  await ensureTodayPeriodOpen();
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id)
     VALUES ((SELECT id FROM pay_periods WHERE status='open' AND CURRENT_DATE BETWEEN start_date AND end_date), $1)
     ON CONFLICT (pay_period_id, contractor_id) DO NOTHING`,
    [realId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
     SELECT id, $2, 0, 0, 0, 0, 4000, 128, 3872, 3872
       FROM payouts WHERE contractor_id = $1
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [realId, mixedShiftId]
  );

  try {
    const result = await clawbackTip(cbTipId, 4000);
    assert.notEqual(result?.skipped, true);
    assert.equal(result.bartenders, 1);

    const adj = await pool.query(
      `SELECT adjustment_cents FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, mixedShiftId]
    );
    assert.equal(Number(adj.rows[0].adjustment_cents), -3872);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))',
      [stubId, realId]);
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [cbTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});

test('clawbackTip > emergency-dropped bartender is excluded from the clawback split', async () => {
  // An emergency-dropped bartender keeps status='approved' + dropped_at set.
  // They never got paid (accrual/late-tip already excluded them), so the
  // clawback must not assign them a negative adjustment either — the whole
  // clawback lands on the bartender who actually worked + was paid.
  const worked = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('cb-worked@example.com','x','staff') RETURNING id`
  );
  const workedId = worked.rows[0].id;
  const dropped = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('cb-dropped@example.com','x','staff') RETURNING id`
  );
  const droppedId = dropped.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [workedId]
  );
  const dropShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-03-05','9:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  const dropShiftId = dropShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [dropShiftId, workedId]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at, drop_emergency, drop_reason)
     VALUES ($1, $2, 'Bartender', 'approved', NOW(), true, 'sick')`,
    [dropShiftId, droppedId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, rolled_forward_at, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_cb_dropped', NOW() - INTERVAL '1 day', $2, NOW(), 0)
     RETURNING id`,
    [workedId, dropShiftId]
  );
  const cbTipId = tipRes.rows[0].id;
  // Seed the working bartender's paid-out event (full tip, since they worked solo).
  await ensureTodayPeriodOpen();
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id)
     VALUES ((SELECT id FROM pay_periods WHERE status='open' AND CURRENT_DATE BETWEEN start_date AND end_date), $1)
     ON CONFLICT (pay_period_id, contractor_id) DO NOTHING`,
    [workedId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
     SELECT id, $2, 0, 0, 0, 0, 4000, 128, 3872, 3872
       FROM payouts WHERE contractor_id = $1
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [workedId, dropShiftId]
  );

  try {
    const result = await clawbackTip(cbTipId, 4000);
    assert.notEqual(result?.skipped, true);
    assert.equal(result.bartenders, 1, 'only the bartender who actually worked is clawed back');

    const adj = await pool.query(
      `SELECT adjustment_cents FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [workedId, dropShiftId]
    );
    assert.equal(Number(adj.rows[0].adjustment_cents), -3872, 'working bartender absorbs the full clawback');

    const droppedEvent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1`,
      [droppedId]
    );
    assert.equal(droppedEvent.rows[0].c, 0, 'the emergency-dropped bartender gets no clawback row');
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))',
      [workedId, droppedId]);
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [workedId, droppedId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [cbTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [dropShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [dropShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [workedId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [workedId, droppedId]);
  }
});

test('clawbackTip > skips with all_bartenders_are_legacy_cc_stubs when every shift bartender is a stub', async () => {
  const stubA = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-all-stub-a@example.com','x','staff','legacy_cc:test:cb-all-a') RETURNING id`
  );
  const stubB = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-all-stub-b@example.com','x','staff','legacy_cc:test:cb-all-b') RETURNING id`
  );
  const stubAId = stubA.rows[0].id;
  const stubBId = stubB.rows[0].id;
  const allStubShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-03-05','8:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  const allStubShiftId = allStubShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [allStubShiftId, stubAId, stubBId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_all_stub_cb', NOW() - INTERVAL '1 day', $2, 0)
     RETURNING id`,
    [stubAId, allStubShiftId]
  );
  const allStubTipId = tipRes.rows[0].id;

  try {
    const result = await clawbackTip(allStubTipId, 2500);
    assert.deepEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
    // Recoverable: refunded_amount_cents stays at 0.
    const tipAfter = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [allStubTipId]);
    assert.equal(Number(tipAfter.rows[0].refunded_amount_cents), 0);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [allStubTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubAId, stubBId]);
  }
});
