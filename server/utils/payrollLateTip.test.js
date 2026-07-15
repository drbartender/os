require('dotenv').config();
const { test, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { chicagoTodayYmd } = require('./businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollLateTip.test.js refuses to run against production');
}

// The held-line sub-test pre-seeds a payout in today's open period so the
// roll-forward's ON CONFLICT lands on a seeded held row. "Today" must be the
// BUSINESS day (America/Chicago), matching how rollForwardLateTip itself
// resolves its destination period — keying on UTC makes the suite seed NEXT
// week's period every Chicago evening (green by day, red by night; bitten
// 2026-07-13). Same track-and-restore law as payrollClawback.test.js: today's
// REAL period on the shared dev DB is never deleted, only status-restored.
function todayPeriodStart() {
  return payPeriodForDate(chicagoTodayYmd()).startDate;
}

async function ensureTodayPeriodOpen() {
  const { startDate, endDate } = payPeriodForDate(chicagoTodayYmd());
  const payday = computePayday(endDate);
  const r = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'
     RETURNING id`,
    [startDate, endDate, payday]
  );
  return r.rows[0].id;
}

let bartenderA, bartenderB, frozenPeriodId, frozenProposalId, frozenShiftId, tipId;
let todayPeriodId = null, todayPeriodPreExisted = false, todayPeriodOrigStatus = null;

before(async () => {
  // Pre-clean any stranded fixtures from prior failed runs (FK chain).
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com' OR email LIKE 'all-stub-%@example.com')`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com' OR email LIKE 'all-stub-%@example.com')`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-%@example.com')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'late-tip-%@example.com' OR email LIKE 'mixed-stub@example.com' OR email LIKE 'mixed-real@example.com' OR email LIKE 'all-stub-%@example.com'`);

  // Capture today's period state BEFORE the suite touches anything, so after()
  // can restore reality instead of guessing: reuse a pre-existing row (forcing
  // it open for the run), or create one and own its deletion.
  const existing = await pool.query(
    'SELECT id, status FROM pay_periods WHERE start_date = $1 LIMIT 1',
    [todayPeriodStart()]
  );
  if (existing.rows[0]) {
    todayPeriodId = existing.rows[0].id;
    todayPeriodPreExisted = true;
    todayPeriodOrigStatus = existing.rows[0].status;
    if (todayPeriodOrigStatus !== 'open') {
      await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [todayPeriodId]);
    }
  } else {
    todayPeriodId = await ensureTodayPeriodOpen();
    todayPeriodPreExisted = false;
  }

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
  // Today's REAL period is likewise excluded: its row lifecycle lives in
  // before()/after() via track-and-restore (never blanket-delete a row the
  // suite didn't create — that destroyed the dev DB's live current period
  // once already, 2026-07-13).
  await pool.query(
    `DELETE FROM pay_periods pp WHERE pp.status = 'open'
       AND pp.start_date <> '2026-05-12'
       AND pp.start_date <> $1
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
    [todayPeriodStart()]
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
  // Restore reality for today's period: put back the original status on a
  // pre-existing row; delete the row only if THIS suite created it (and only
  // when nothing else references it).
  if (todayPeriodId) {
    if (todayPeriodPreExisted) {
      if (todayPeriodOrigStatus !== 'open') {
        await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2', [todayPeriodOrigStatus, todayPeriodId]);
      }
    } else {
      await pool.query(
        `DELETE FROM pay_periods pp WHERE pp.id = $1
           AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
        [todayPeriodId]
      );
    }
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

test('rollForwardLateTip > all-stub shift defers the tip and a repeat retry preserves the marker', async () => {
  const stubA = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-defer-a@example.com','x','staff','legacy_cc:test:defer-a') RETURNING id`
  );
  const stubB = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-defer-b@example.com','x','staff','legacy_cc:test:defer-b') RETURNING id`
  );
  const stubAId = stubA.rows[0].id;
  const stubBId = stubB.rows[0].id;
  const shift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','8:30 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const stubShiftId = shift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [stubShiftId, stubAId, stubBId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 3000, 96, 'pi_all_stub_defer', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubAId, stubShiftId]
  );
  const stubTipId = tipRes.rows[0].id;

  try {
    // First attempt: every bartender is a stub, so it skips but now COMMITs a
    // deferral marker so the retry sweep (deferred_at IS NOT NULL) can recover it
    // after a de-stub. Before this fix both deferred_at and rolled_forward_at
    // stayed NULL, stranding the tip forever.
    const first = await rollForwardLateTip(stubTipId);
    assert.deepEqual(first, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
    const afterFirst = await pool.query(
      'SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id = $1',
      [stubTipId]
    );
    assert.ok(afterFirst.rows[0].deferred_at, 'deferred_at marker set so the retry sweep can find it');
    assert.equal(afterFirst.rows[0].defer_kind, 'roll_forward');
    assert.equal(afterFirst.rows[0].defer_attempts, 1);
    assert.equal(afterFirst.rows[0].rolled_forward_at, null, 'never placed; recoverable');
    const markedAt = afterFirst.rows[0].deferred_at;

    // A repeat retry on a still-all-stub tip must re-skip WITHOUT clearing or
    // resetting the marker (no hot-loop, no marker loss).
    const second = await rollForwardLateTip(stubTipId);
    assert.deepEqual(second, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
    const afterSecond = await pool.query(
      'SELECT deferred_at, defer_attempts FROM tips WHERE id = $1',
      [stubTipId]
    );
    assert.equal(afterSecond.rows[0].deferred_at.getTime(), markedAt.getTime(),
      'original deferred_at preserved (COALESCE), not reset');
    assert.equal(afterSecond.rows[0].defer_attempts, 2,
      'attempts advance so the tip eventually drops from auto-retry');

    // No synthetic payout line was ever created for the stubs.
    const noPayout = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubAId, stubBId]
    );
    assert.equal(noPayout.rows[0].c, 0);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [stubTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [stubShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [stubShiftId]);
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

test('rollForwardLateTip > Chicago evening (Mon 18:30 CST) rolls into the CURRENT Tue-Mon period, not next week (T3)', async () => {
  // Mon 2026-01-19 18:30 CST = Tue 2026-01-20 00:30 UTC. chicagoTodayYmd() reads
  // the Chicago Monday (19th); its Tue-Mon period is 2026-01-13..2026-01-19. The
  // old UTC pick saw the 20th (Tuesday) and would have opened NEXT week's period
  // (start 2026-01-20), stranding the rolled-forward tip a week late.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-20T00:30:00Z') });
  try {
    const result = await rollForwardLateTip(tipId);
    assert.equal(result.bartenders, 2);
    const { rows } = await pool.query(
      "SELECT to_char(start_date, 'YYYY-MM-DD') AS start_ymd FROM pay_periods WHERE id = $1",
      [result.period_id]
    );
    assert.equal(rows[0].start_ymd, '2026-01-13',
      'rolls into the current Tue-Mon period (Chicago Monday), not next week (2026-01-20)');
  } finally {
    mock.timers.reset();
  }
});

test('rollForwardLateTip > preserves a negative cross-period clawback residual on the same row (H1)', async () => {
  // Seam-sweep H1 regression. A cross-period tip clawback lands as a negative
  // adjustment_cents on a synthetic row keyed by the ORIGINAL shift, floorless
  // (payrollClawback.js). If a LATE tip then rolls forward onto that SAME
  // (payout_id, shift_id) row, the ON CONFLICT recompute must keep the line
  // NEGATIVE — the old GREATEST(0, ...) line floor zeroed it, silently
  // erasing the debt (the exact H1 leak, invisible because the line was
  // floored before the payout-level clamp ever summed it).
  const r1 = await rollForwardLateTip(tipId);
  const periodId = r1.period_id;

  // Bartender A's rolled-forward line for the frozen shift (net 1936).
  const aPayout = (await pool.query(
    'SELECT id FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [periodId, bartenderA]
  )).rows[0].id;

  // Simulate a cross-period clawback landing on A's line exactly as
  // payrollClawback.js writes it: set a negative adjustment and recompute the
  // line floorless (payout total is separately clamped elsewhere).
  await pool.query(
    `UPDATE payout_events
        SET adjustment_cents = -5000,
            line_total_cents = wage_cents + gratuity_share_cents
              + card_tip_net_cents + (-5000)
      WHERE payout_id = $1 AND shift_id = $2`,
    [aPayout, frozenShiftId]
  );

  // A second late tip for the same shift rolls forward → ON CONFLICT on A's row.
  const t2 = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 1000, 0, 'pi_late_tip_clawback', '2026-05-15 23:55:00+00', $2)
     RETURNING id`,
    [bartenderA, frozenShiftId]
  );
  try {
    await rollForwardLateTip(t2.rows[0].id);

    const aLine = (await pool.query(
      `SELECT card_tip_net_cents, adjustment_cents, line_total_cents
         FROM payout_events WHERE payout_id = $1 AND shift_id = $2`,
      [aPayout, frozenShiftId]
    )).rows[0];
    // 1000 gross split 2 ways = 500 net added onto A's 1936.
    assert.equal(Number(aLine.card_tip_net_cents), 2436);
    assert.equal(Number(aLine.adjustment_cents), -5000);
    // 1936 + 500 - 5000 = -2564. Old floored code returned 0 here.
    assert.equal(Number(aLine.line_total_cents), -2564,
      'negative clawback residual survives the roll-forward (not floored to 0)');

    // Money out is still non-negative: the payout total is clamped at 0, and
    // the negative line nets against A's future positive lines first.
    const aTotal = (await pool.query(
      'SELECT total_cents FROM payouts WHERE id = $1', [aPayout]
    )).rows[0];
    assert.equal(Number(aTotal.total_cents), 0, 'payout total clamped at 0, debt carried on the line');
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [t2.rows[0].id]);
  }
});

test('rollForwardLateTip > late tip onto a HELD line pays the tip but keeps the held reimbursement non-payable', async () => {
  // B4 held-row invariant (2026-07-14 known-bugs batch, design-review amended,
  // shared with kb-d/B13): held => line_total = payable components +
  // LEAST(net adjustment_cents, 0). The NEW tip money stays payable (the
  // recipient is legitimately on the roster); only the held +5000
  // reimbursement stays excluded until the admin confirm PATCH re-arms it.
  // line_total = 3600 + LEAST(5000, 0) = 3600. At HEAD the held-blind
  // recompute resurrects the reimbursement (line_total 8600) — RED.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('late-tip-held@example.com','x','staff') RETURNING id`
  );
  const heldUserId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [heldUserId]
  );
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','9:30 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const heldShiftId = s.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [heldShiftId, heldUserId]
  );
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 400, 'pi_late_tip_held', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [heldUserId, heldShiftId]
  );
  const heldTipId = tipRes.rows[0].id;
  // Seed the post-hold state directly in TODAY's open period, where the
  // roll-forward will land (hold CREATION is payrollAccrual's job, covered by
  // payrollAccrual.sweepPreserve.test.js): components zeroed, +5000 tracked,
  // line_total 0, held.
  const periodId = await ensureTodayPeriodOpen();
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET pay_period_id = EXCLUDED.pay_period_id
     RETURNING id`,
    [periodId, heldUserId]
  );
  const payoutId = po.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        adjustment_cents, adjustment_note, line_total_cents, held_state)
     VALUES ($1, $2, 0, 0, 0, 0, 5000, 'held: worker off roster', 0, 'held')`,
    [payoutId, heldShiftId]
  );

  try {
    const result = await rollForwardLateTip(heldTipId);
    assert.equal(result.bartenders, 1);
    assert.equal(result.period_id, periodId, 'roll-forward lands in the seeded open period');

    const line = (await pool.query(
      `SELECT card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents,
              adjustment_cents, line_total_cents, held_state
         FROM payout_events WHERE payout_id = $1 AND shift_id = $2`,
      [payoutId, heldShiftId]
    )).rows[0];
    assert.equal(Number(line.card_tip_gross_cents), 4000);
    assert.equal(Number(line.card_tip_fee_cents), 400);
    assert.equal(Number(line.card_tip_net_cents), 3600);
    assert.equal(Number(line.adjustment_cents), 5000, 'tracked reimbursement untouched');
    assert.equal(line.held_state, 'held', 'hold survives the roll-forward');
    assert.equal(Number(line.line_total_cents), 3600,
      'tip is payable, held reimbursement is not: 3600 + LEAST(5000, 0) = 3600');

    const total = (await pool.query(
      'SELECT total_cents FROM payouts WHERE id = $1', [payoutId]
    )).rows[0];
    assert.equal(Number(total.total_cents), 3600, 'payout total pays the tip only');
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id = $1', [payoutId]);
    await pool.query('DELETE FROM payouts WHERE id = $1', [payoutId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [heldTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [heldShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [heldShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [heldUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [heldUserId]);
  }
});
