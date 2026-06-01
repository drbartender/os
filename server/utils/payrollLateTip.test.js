require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollLateTip.test.js refuses to run against production');
}

let bartenderA, bartenderB, frozenPeriodId, frozenProposalId, frozenShiftId, tipId;

before(async () => {
  // Pre-clean any stranded fixtures from prior failed runs (FK chain).
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com' OR email LIKE 'all-stub-%@example.com')`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com' OR email LIKE 'all-stub-%@example.com')`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-stub@example.com' OR email LIKE 'mixed-real@example.com' OR email LIKE 'all-stub-%@example.com'`);

  const a = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('late-tip-a@example.com','x','staff') RETURNING id"
  );
  bartenderA = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('late-tip-b@example.com','x','staff') RETURNING id"
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
  // A frozen period (paid) two weeks back, with an event whose shift had both bartenders.
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-12','2026-05-18','2026-05-19','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`
  );
  frozenPeriodId = p.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2026-05-15', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  frozenProposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','6:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  frozenShiftId = s.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [frozenShiftId, id]
    );
  }
  // A tip matched to that shift (post-event, fee already captured).
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_late_tip_test', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [bartenderA, frozenShiftId]
  );
  tipId = t.rows[0].id;
});

afterEach(async () => {
  // The roll-forward may have created a new pay period and payouts for today.
  // Pull a fresh list by joining tips.shift_id and clean it all out.
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id = $1 OR payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($2,$3))`,
    [frozenShiftId, bartenderA, bartenderB]
  );
  await pool.query(
    'DELETE FROM payouts WHERE contractor_id IN ($1,$2)',
    [bartenderA, bartenderB]
  );
  // Delete any open pay_period the roll-forward might have created today,
  // but ONLY if no payouts reference it. The dev DB has a pre-existing open
  // pay_period (2026-05-26 to 2026-06-01) used as the shared prereq; do not
  // touch it. The frozen test period (2026-05-12) is preserved separately.
  await pool.query(
    `DELETE FROM pay_periods pp WHERE pp.status = 'open'
       AND pp.start_date <> '2026-05-12'
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`
  );
  // Defense in depth: any tip targeting either fixture bartender, even if
  // created by a sub-test that didn't reach its finally. Pre-existing tests
  // only cleaned by tipId so a failed sub-test could leak.
  await pool.query('DELETE FROM tips WHERE target_user_id IN ($1, $2)', [bartenderA, bartenderB]);
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [frozenShiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [frozenShiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [frozenProposalId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [frozenPeriodId]);
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.end();
});

test('rollForwardLateTip > splits the tip net across both bartenders into the open period', async () => {
  const result = await rollForwardLateTip(tipId);
  assert.equal(result.bartenders, 2);

  // Each bartender now has a payout in the open period with a single line
  // item keyed to the ORIGINAL shift, carrying their share of the late tip.
  const { rows } = await pool.query(
    `SELECT po.contractor_id, pe.card_tip_gross_cents, pe.card_tip_fee_cents,
            pe.card_tip_net_cents, pe.line_total_cents
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1 AND po.pay_period_id = $2
      ORDER BY po.contractor_id`,
    [frozenShiftId, result.period_id]
  );
  assert.equal(rows.length, 2);
  // 4000c gross split 2 ways = [2000, 2000]; 128c fee split = [64, 64].
  assert.equal(Number(rows[0].card_tip_gross_cents) + Number(rows[1].card_tip_gross_cents), 4000);
  assert.equal(Number(rows[0].card_tip_fee_cents) + Number(rows[1].card_tip_fee_cents), 128);
  // Net = gross - fee per bartender; line_total = net (no wage/gratuity).
  assert.equal(Number(rows[0].card_tip_net_cents), 1936);
  assert.equal(Number(rows[0].line_total_cents), 1936);

  // And the tip is flagged so a second call is a no-op.
  const tip = await pool.query('SELECT rolled_forward_at FROM tips WHERE id = $1', [tipId]);
  assert.ok(tip.rows[0].rolled_forward_at);
});

test('rollForwardLateTip > a second call is idempotent', async () => {
  await rollForwardLateTip(tipId);
  const second = await rollForwardLateTip(tipId);
  assert.equal(second, null);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1`,
    [frozenShiftId]
  );
  assert.equal(rows[0].c, 2);  // exactly two rows, not four.
});

test('rollForwardLateTip > mixed-stub shift: real bartender gets the whole tip, stubs filtered out', async () => {
  // FRESH shift (NOT frozenShiftId) because beforeEach already populated
  // frozenShiftId with bartenderA + bartenderB.
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('mixed-stub@example.com','x','staff','legacy_cc:test:mixed-stub')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const real = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('mixed-real@example.com','x','staff') RETURNING id`
  );
  const realId = real.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [realId]
  );
  const mixedShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','7:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const mixedShiftId = mixedShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [mixedShiftId, stubId, realId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_mixed_late_tip', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubId, mixedShiftId]
  );
  const mixedTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(mixedTipId);
    assert.notEqual(result?.skipped, true);
    assert.equal(result.bartenders, 1, 'only the real bartender takes the split');

    const realEvent = await pool.query(
      `SELECT pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, mixedShiftId]
    );
    assert.equal(realEvent.rowCount, 1);
    assert.equal(Number(realEvent.rows[0].card_tip_gross_cents), 4000);
    assert.equal(Number(realEvent.rows[0].card_tip_fee_cents), 128);
    assert.equal(Number(realEvent.rows[0].card_tip_net_cents), 3872);

    const stubEvent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1`,
      [stubId]
    );
    assert.equal(stubEvent.rows[0].c, 0);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubId, realId]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [mixedTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});

test('rollForwardLateTip > emergency-dropped bartender is excluded from the split', async () => {
  // An emergency-dropped bartender keeps status='approved' but has dropped_at
  // set (they bailed <72h out and never worked). They must NOT take a share of
  // the late tip — the bartender who actually worked absorbs the whole thing.
  // Mirrors the `dropped_at IS NULL` filter in payrollAccrual.
  const worked = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('late-tip-worked@example.com','x','staff') RETURNING id`
  );
  const workedId = worked.rows[0].id;
  const dropped = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('late-tip-dropped@example.com','x','staff') RETURNING id`
  );
  const droppedId = dropped.rows[0].id;
  for (const id of [workedId, droppedId]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [id]
    );
  }
  const dropShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','8:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
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
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_late_tip_dropped', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [workedId, dropShiftId]
  );
  const dropTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(dropTipId);
    assert.equal(result.bartenders, 1, 'only the bartender who actually worked takes the split');

    const workedEvent = await pool.query(
      `SELECT pe.card_tip_gross_cents FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [workedId, dropShiftId]
    );
    assert.equal(workedEvent.rowCount, 1);
    assert.equal(Number(workedEvent.rows[0].card_tip_gross_cents), 4000, 'working bartender gets the whole tip');

    const droppedEvent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1`,
      [droppedId]
    );
    assert.equal(droppedEvent.rows[0].c, 0, 'the emergency-dropped bartender gets nothing');
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [workedId, droppedId]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [workedId, droppedId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [dropTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [dropShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [dropShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)', [workedId, droppedId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [workedId, droppedId]);
  }
});

test('rollForwardLateTip > skips with all_bartenders_are_legacy_cc_stubs when every shift bartender is a stub', async () => {
  const stubA = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-a@example.com','x','staff','legacy_cc:test:all-a') RETURNING id`
  );
  const stubB = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-b@example.com','x','staff','legacy_cc:test:all-b') RETURNING id`
  );
  const stubAId = stubA.rows[0].id;
  const stubBId = stubB.rows[0].id;
  const allStubShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','8:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const allStubShiftId = allStubShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [allStubShiftId, stubAId, stubBId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 3000, 96, 'pi_all_stub_late', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubAId, allStubShiftId]
  );
  const allStubTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(allStubTipId);
    assert.deepEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
    const noPayout = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubAId, stubBId]
    );
    assert.equal(noPayout.rows[0].c, 0);
    const tip = await pool.query('SELECT rolled_forward_at FROM tips WHERE id = $1', [allStubTipId]);
    assert.equal(tip.rows[0].rolled_forward_at, null, 'recoverable: stays NULL so a future de-stub can replay');
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [allStubTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubAId, stubBId]);
  }
});

test('rollForwardLateTip > a second LATE tip for the same shift aggregates into the same rows', async () => {
  await rollForwardLateTip(tipId);
  // A second tip — same shift, fresh.
  const t2 = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 2000, 64, 'pi_late_tip_two', '2026-05-15 23:45:00+00', $2)
     RETURNING id`,
    [bartenderA, frozenShiftId]
  );
  try {
    await rollForwardLateTip(t2.rows[0].id);
    const { rows } = await pool.query(
      `SELECT po.contractor_id, pe.card_tip_gross_cents
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1
        ORDER BY po.contractor_id`,
      [frozenShiftId]
    );
    // Same two rows, gross now 2000+1000=3000 per bartender (4000+2000 split 2 ways).
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].card_tip_gross_cents), 3000);
    assert.equal(Number(rows[1].card_tip_gross_cents), 3000);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [t2.rows[0].id]);
  }
});
