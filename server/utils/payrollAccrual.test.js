require('dotenv').config();
const { test, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.test.js refuses to run against production');
}

// This suite owns a UNIQUE far-past OPEN pay period (Tue 2019-02-05..Mon
// 2019-02-11). Every proposal's event_date sits INSIDE it, so accrual (which
// resolves the period from event_date via ensurePayPeriod) lands here and never
// reads, forces, or mutates the shared CURRENT_DATE period the dev app sees.
let userId, proposalId, shiftId, ownPeriodId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [userId]
  );
  const per = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-02-05','2019-02-11','2019-02-12','open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  );
  ownPeriodId = per.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, '2019-02-05', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = p.rows[0].id;
  // The shift deliberately omits event_duration_hours: it is NULL on real
  // production shifts, so accrual must read the duration from the proposal.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-02-05', '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN
       (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  // Only this suite's own period id is deleted; afterEach already cleared every
  // payout referencing it, so no foreign row is touched.
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [ownPeriodId]);
  await pool.end();
});

test('accruePayoutsForProposal > creates a payout and a payout_event for the bartender', async () => {
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.wage_cents, pe.gratuity_share_cents, pe.line_total_cents, po.total_cents
     FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows.length, 1);
  // Duration 4h read from the proposal -> 5.5 contracted hours @ $20.00 = $110.00.
  // Gratuity $100 to the one bartender; no card payments, so no fee netted.
  assert.equal(rows[0].wage_cents, 11000);
  assert.equal(rows[0].gratuity_share_cents, 10000);
  assert.equal(rows[0].line_total_cents, 21000);
  assert.equal(rows[0].total_cents, 21000);
});

test('accruePayoutsForProposal > is idempotent: a second call does not duplicate', async () => {
  await accruePayoutsForProposal(proposalId);
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(Number(rows[0].count), 1);
});

test('accruePayoutsForProposal > re-accrual preserves an admin edit to hours', async () => {
  await accruePayoutsForProposal(proposalId);
  // Simulate an admin adjusting hours in the portal.
  await pool.query(
    `UPDATE payout_events SET hours = 9
     WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.hours, pe.wage_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // The edited hours survive; wage is recomputed from them (9 * $20.00).
  assert.equal(Number(rows[0].hours), 9);
  assert.equal(rows[0].wage_cents, 18000);
});

test('accruePayoutsForProposal > nets the card fee out of the gratuity share', async () => {
  // A card payment carrying a $32.00 (3200c) Stripe fee. The proposal's
  // total_price is $1000, so the $100 gratuity bears 10% of that fee.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 100000, 'succeeded', 3200, 'pi_grat_fee')`,
    [proposalId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // Gratuity 10000c; fee share = 3200 * (10000 / 100000) = 320c; net = 9680c.
  assert.equal(rows[0].gratuity_share_cents, 9680);
});

test('accruePayoutsForProposal > splits gratuity evenly across two bartenders', async () => {
  const u2 = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue2@example.com','x','staff') RETURNING id"
  );
  const user2 = u2.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [user2]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, user2]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       WHERE po.contractor_id IN ($1,$2) ORDER BY po.contractor_id`,
      [userId, user2]
    );
    // $100 gratuity split two ways: 5000c each, summing to the full 10000c.
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gratuity_share_cents + rows[1].gratuity_share_cents, 10000);
    assert.equal(rows[0].gratuity_share_cents, 5000);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [user2]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [user2]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [user2]);
    await pool.query('DELETE FROM users WHERE id = $1', [user2]);
  }
});

test('accruePayoutsForProposal > skips and returns structured shape when proposal has a legacy CC stub participant', async () => {
  // cc-import: events whose participants include a legacy_cc:* stub bartender
  // must NOT enter modern payouts (we cannot pay a stub through Stripe Connect).
  // The guard fires per-proposal — one stub on any shift skips the WHOLE accrual.
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('accrue-stub@example.com','x','staff','legacy_cc:test:accrue-stub')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, stubId]
  );
  try {
    const result = await accruePayoutsForProposal(proposalId);
    assert.deepStrictEqual(result, { skipped: true, reason: 'legacy_cc_stub_participant' });
    // Guard MUST fire BEFORE any DB writes: no payouts/payout_events for ANY
    // participant on this proposal, including the non-stub bartender (userId).
    const noEvents = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id IN ($1, $2)`,
      [userId, stubId]
    );
    assert.strictEqual(noEvents.rows[0].c, 0);
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, stubId]);
    await pool.query('DELETE FROM users WHERE id = $1', [stubId]);
  }
});

test('accruePayoutsForProposal > underpaid event accrues wages but $0 gratuity (funded gate)', async () => {
  // Drop the seeded funded amount below total so the gratuity gate trips.
  await pool.query('UPDATE proposals SET amount_paid = 100 WHERE id = $1', [proposalId]);
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents, pe.wage_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows[0].gratuity_share_cents, 0, 'gratuity gated off when underpaid');
  assert.ok(rows[0].wage_cents > 0, 'wages still accrue when underpaid');
});

test('accruePayoutsForProposal > fully-paid event accrues the pooled gratuity (funded gate)', async () => {
  // beforeEach seeds amount_paid = total_price (funded), so gratuity accrues.
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows[0].gratuity_share_cents, 10000, 'pooled gratuity accrues when funded');
});

// Second bartender B on the suite's shift. Returns B's user id; removeB()
// takes every row B owns back out.
async function addBartenderB() {
  const u2 = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue-orphan-b@example.com','x','staff') RETURNING id"
  );
  const userB = u2.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [userB]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userB]
  );
  return userB;
}

async function removeB(userB) {
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [userB]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, userB]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userB]);
  await pool.query('DELETE FROM users WHERE id = $1', [userB]);
}

async function linesOf(contractorId, periodId) {
  const { rows } = await pool.query(
    `SELECT pe.id, pe.hours, pe.wage_cents, pe.gratuity_share_cents, pe.adjustment_cents,
            pe.line_total_cents, po.total_cents
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE po.contractor_id = $1 AND po.pay_period_id = $2`,
    [contractorId, periodId]
  );
  return rows;
}

test('accruePayoutsForProposal > removes an off-roster worker line and re-pools the gratuity to A', async () => {
  const userB = await addBartenderB();
  try {
    // First accrual: both A and B get an open-period line, the pool split two ways.
    await accruePayoutsForProposal(proposalId);
    assert.equal((await linesOf(userB, ownPeriodId)).length, 1, 'B has a line before removal');

    // Deny B exactly as the unassign route does (status -> denied).
    await pool.query(
      "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2",
      [shiftId, userB]
    );
    await accruePayoutsForProposal(proposalId);

    // B's line is gone; the emptied pending payout is gone too.
    assert.equal((await linesOf(userB, ownPeriodId)).length, 0, 'B payout_event removed');
    const bPayouts = await pool.query(
      'SELECT COUNT(*)::int AS c FROM payouts WHERE contractor_id = $1', [userB]
    );
    assert.equal(bPayouts.rows[0].c, 0, 'B emptied payout removed');

    // A's line survives; gratuity re-pools to A alone and the total recomputes.
    const a = await linesOf(userId, ownPeriodId);
    assert.equal(a.length, 1, 'A line remains');
    assert.equal(Number(a[0].gratuity_share_cents), 10000, 'gratuity re-pooled to A alone');
    assert.equal(Number(a[0].total_cents), 21000, 'A payout total recomputed');
  } finally {
    await removeB(userB);
  }
});

// POUT-03 (audit 2026-11-05). This test used to seed the PAID frozen line and
// then assert "B has an open-period line before removal": the double accrual
// of one shift into two periods, enshrined as setup state. A paid line in
// another period is now a hard stop for that worker, with a Sentry warning
// naming the period, and the frozen row is left exactly as it was.
test('accruePayoutsForProposal > a PAID line for the same shift in a frozen period is a hard stop for B, never a seed, and stays untouched', async () => {
  const userB = await addBartenderB();
  const frozen = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-01-07','2019-01-13','2019-01-14','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`
  );
  const frozenPeriodId = frozen.rows[0].id;
  const frozenPayout = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1,$2,'paid',16000) RETURNING id`,
    [frozenPeriodId, userB]
  );
  const frozenPayoutId = frozenPayout.rows[0].id;
  const frozenEvent = await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, line_total_cents)
     VALUES ($1,$2,5.5,5.5,2000,11000,5000,16000) RETURNING id`,
    [frozenPayoutId, shiftId]
  );
  const frozenEventId = frozenEvent.rows[0].id;
  const sentry = mock.method(Sentry, 'captureMessage');

  try {
    // First accrual: A gets an open-period line; B does NOT, because B's pay
    // for this shift is already booked (and paid) in the frozen period.
    await accruePayoutsForProposal(proposalId);
    assert.equal((await linesOf(userB, ownPeriodId)).length, 0, 'no second line for B in the open period');
    const bOpenPayouts = await pool.query(
      'SELECT COUNT(*)::int AS c FROM payouts WHERE contractor_id = $1 AND pay_period_id = $2',
      [userB, ownPeriodId]
    );
    assert.equal(bOpenPayouts.rows[0].c, 0, 'and no phantom payout stub for B either');
    const warnings = sentry.mock.calls.filter((c) => /another period/i.test(String(c.arguments[0])));
    assert.equal(warnings.length, 1, 'one Sentry warning for B');
    assert.deepEqual(warnings[0].arguments[1].extra.other_period_ids, [frozenPeriodId],
      'the warning names the frozen period that holds the line');
    assert.equal(warnings[0].arguments[1].extra.contractorId, userB);
    // The split still counts B (B's half sits on the frozen line), so A is
    // not handed B's share here.
    const aFirst = await linesOf(userId, ownPeriodId);
    assert.equal(aFirst.length, 1);
    assert.equal(Number(aFirst[0].gratuity_share_cents), 5000, 'A gets half; B half is on the frozen line');

    // Deny B and re-accrue: A re-pools, B still has nothing in the open period.
    await pool.query(
      "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2",
      [shiftId, userB]
    );
    await accruePayoutsForProposal(proposalId);
    assert.equal((await linesOf(userB, ownPeriodId)).length, 0);
    const a = await linesOf(userId, ownPeriodId);
    assert.equal(a.length, 1, 'A line remains');
    assert.equal(Number(a[0].gratuity_share_cents), 10000, 'gratuity re-pooled to A alone');
    assert.equal(Number(a[0].total_cents), 21000, 'A payout total recomputed');

    // The frozen prior-period line for B is untouched.
    const frozenStill = await pool.query(
      'SELECT hours, line_total_cents FROM payout_events WHERE id = $1', [frozenEventId]
    );
    assert.equal(frozenStill.rows.length, 1, 'frozen-period line preserved');
    assert.equal(Number(frozenStill.rows[0].hours), 5.5);
    assert.equal(Number(frozenStill.rows[0].line_total_cents), 16000);
  } finally {
    sentry.mock.restore();
    await pool.query('DELETE FROM payout_events WHERE id = $1', [frozenEventId]);
    await pool.query('DELETE FROM payouts WHERE id = $1', [frozenPayoutId]);
    await pool.query('DELETE FROM pay_periods WHERE id = $1', [frozenPeriodId]);
    await removeB(userB);
  }
});

// POUT-03 scenario B. A card tip from this event refunded while a later
// period was already open left a clawback stub (hours 0, wage 0, a negative
// adjustment) keyed by this shift in that later period. The prior-line lookup,
// keyed without the period, could pick that stub as A's "prior" line and
// rewrite the event period's wage to 0 hours / 0 wage / the debt, booking the
// claw twice and losing the wage; which row won depended on SELECT order.
test('accruePayoutsForProposal > a clawback stub in a later open period never rewrites the event period wage line', async () => {
  await accruePayoutsForProposal(proposalId);
  const later = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-02-12','2019-02-18','2019-02-19','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`
  );
  const laterPeriodId = later.rows[0].id;
  const laterPayout = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1,$2,'pending',0) RETURNING id`,
    [laterPeriodId, userId]
  );
  const laterPayoutId = laterPayout.rows[0].id;
  const stub = await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        adjustment_cents, adjustment_note, line_total_cents)
     VALUES ($1,$2,0,0,0,0,-1936,'Chargeback on tip 1: +$40.00 (cumulative $40.00)',-1936) RETURNING id`,
    [laterPayoutId, shiftId]
  );
  const stubId = stub.rows[0].id;
  const sentry = mock.method(Sentry, 'captureMessage');

  try {
    await accruePayoutsForProposal(proposalId);
    const a = await linesOf(userId, ownPeriodId);
    assert.equal(a.length, 1, 'one line in the event period');
    assert.equal(Number(a[0].hours), 5.5, 'hours come from the event period own line');
    assert.equal(Number(a[0].wage_cents), 11000);
    assert.equal(Number(a[0].adjustment_cents), 0, 'the debt is not booked a second time here');
    assert.equal(Number(a[0].line_total_cents), 21000);

    const stubStill = await pool.query(
      'SELECT hours, wage_cents, adjustment_cents, line_total_cents FROM payout_events WHERE id = $1', [stubId]
    );
    assert.equal(stubStill.rows.length, 1, 'the later-period stub survives');
    assert.equal(Number(stubStill.rows[0].adjustment_cents), -1936);
    assert.equal(Number(stubStill.rows[0].hours), 0);
    assert.equal(sentry.mock.calls.filter((c) => /another period/i.test(String(c.arguments[0]))).length, 0,
      'a pure debt stub elsewhere is not a cross-period wage line');
  } finally {
    sentry.mock.restore();
    await pool.query('DELETE FROM payout_events WHERE id = $1', [stubId]);
    await pool.query('DELETE FROM payouts WHERE id = $1', [laterPayoutId]);
    await pool.query('DELETE FROM pay_periods WHERE id = $1', [laterPeriodId]);
  }
});

test('accruePayoutsForProposal > a refund dropping amount_paid below total re-gates gratuity off', async () => {
  // Funded → accrue (gratuity lands). A refund then drops amount_paid below
  // total; a re-accrual must NOT keep paying gratuity the client no longer funded.
  await accruePayoutsForProposal(proposalId);
  await pool.query('UPDATE proposals SET amount_paid = 100 WHERE id = $1', [proposalId]); // post-refund state
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents, pe.wage_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows[0].gratuity_share_cents, 0, 'gratuity re-gated off after refund drops below total');
  assert.ok(rows[0].wage_cents > 0, 'wages remain regardless');
});

test('accruePayoutsForProposal > M4: extra-charge card fees do not net against gratuity', async () => {
  // Contract 'full' payment: $1000, fee 3200c -> gratuity bears 10% = 320c.
  // PLUS an Additional Services invoice paid by card (fee 2900c): its dollars
  // sit OUTSIDE total_price, so its fee must not increase the netting.
  // Old behavior: (3200+2900) * 10% = 610c netted -> share 9390. Fixed: 9680.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 100000, 'succeeded', 3200, 'pi_m4_contract')`,
    [proposalId]
  );
  const { rows: [pay2] } = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'invoice', 100000, 'succeeded', 2900, 'pi_m4_extra') RETURNING id`,
    [proposalId]
  );
  const { rows: [inv] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-M4-1', 'Additional Services', 100000, 100000, 'paid') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 100000)',
    [inv.id, pay2.id]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
      [userId]
    );
    assert.equal(rows[0].gratuity_share_cents, 9680, 'extra-charge fee excluded from netting');
  } finally {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [inv.id]);
    await pool.query('DELETE FROM invoices WHERE id = $1', [inv.id]);
  }
});

test('accruePayoutsForProposal > M4: combined payment fee pro-rates by contract-linked share', async () => {
  // One combined charge: $800, fee 400c, linked $600 to the Balance invoice
  // (contract) and $200 to Drink Plan Extras. Contract fee share =
  // 400 * 60000/80000 = 300c. Gratuity bears 10% of that = 30c -> share 9970.
  const { rows: [pay] } = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'drink_plan_with_balance', 80000, 'succeeded', 400, 'pi_m4_combined') RETURNING id`,
    [proposalId]
  );
  const { rows: [invBal] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-M4-2', 'Balance', 60000, 60000, 'paid') RETURNING id`,
    [proposalId]
  );
  const { rows: [invExt] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-M4-3', 'Drink Plan Extras', 20000, 20000, 'paid') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 60000), ($3, $2, 20000)',
    [invBal.id, pay.id, invExt.id]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
      [userId]
    );
    assert.equal(rows[0].gratuity_share_cents, 9970, 'only the contract-linked share of the combined fee nets');
  } finally {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN ($1, $2)', [invBal.id, invExt.id]);
    await pool.query('DELETE FROM invoices WHERE id IN ($1, $2)', [invBal.id, invExt.id]);
  }
});

test('accruePayoutsForProposal > empty-roster re-accrual sweeps the last worker\'s lines', async () => {
  // Single-bartender event accrues, then the only worker is denied. The
  // no_approved_workers early return must still sweep the stale payable line
  // (old behavior left it payable forever).
  await accruePayoutsForProposal(proposalId);
  const { rows: beforeRows } = await pool.query(
    `SELECT pe.id FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE po.contractor_id = $1`, [userId]);
  assert.ok(beforeRows.length >= 1, 'line exists after first accrual');
  await pool.query(
    `UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2`,
    [shiftId, userId]);
  const res = await accruePayoutsForProposal(proposalId);
  assert.equal(res.reason, 'no_approved_workers');
  assert.ok(res.swept >= 1, 'stale line was swept');
  const { rows: afterRows } = await pool.query(
    `SELECT pe.id FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE po.contractor_id = $1`, [userId]);
  assert.equal(afterRows.length, 0, 'no payable line remains');
  await pool.query(
    `UPDATE shift_requests SET status = 'approved' WHERE shift_id = $1 AND user_id = $2`,
    [shiftId, userId]);
});

test('accruePayoutsForProposal > M4: capped/partial links on a contract payment still net the full fee', async () => {
  // M1 caps invoice links at remaining due, so a $3,000 'full' payment can carry
  // only a $100 Deposit link. The unlinked remainder of a contract-typed payment
  // is still contract exposure: the fee must net fully (not by the 100/3000 link
  // share, which would drop netting to ~$1 and over-pay gratuity).
  const { rows: [pay] } = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 300000, 'succeeded', 3200, 'pi_m4_capped') RETURNING id`,
    [proposalId]
  );
  const { rows: [inv] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-M4-4', 'Deposit', 10000, 10000, 'paid') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)',
    [inv.id, pay.id]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
      [userId]
    );
    assert.equal(rows[0].gratuity_share_cents, 9680, 'full contract fee nets despite the capped link');
  } finally {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [inv.id]);
    await pool.query('DELETE FROM invoices WHERE id = $1', [inv.id]);
  }
});

test('accruePayoutsForProposal > births no_draw for a takes_draw=false contractor', async () => {
  // Owner-shape pin (spec 2026-08-07): the ensurePayout swap must never
  // regress to an inline INSERT that ignores the flag.
  await pool.query('UPDATE contractor_profiles SET takes_draw = false WHERE user_id = $1', [userId]);
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      'SELECT status FROM payouts WHERE contractor_id = $1 AND pay_period_id = $2',
      [userId, ownPeriodId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'no_draw');
  } finally {
    await pool.query('UPDATE contractor_profiles SET takes_draw = true WHERE user_id = $1', [userId]);
  }
});
