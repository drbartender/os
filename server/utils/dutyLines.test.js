require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  HOSTED_SUPPLIES_CENTS, computeDesiredDutyLines, isFundedProposal,
  reconcileDutyLines, sumPayableDutyCents, materializeReviewLine,
  materializePendingReviewLines,
} = require('./dutyLines');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { chicagoTodayYmd } = require('./businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('dutyLines.test.js refuses to run against production');
}

// ---------------------------------------------------------------------------
// Pure trigger tests (no DB)
// ---------------------------------------------------------------------------

const fundedProposal = (over = {}) => ({
  total_price: 1000, amount_paid: 1000, num_bars: 0,
  menu_print_key: null, menu_not_required: false,
  pricing_snapshot: { version: 1, addons: [] },
  ...over,
});
const W = (id, position, rate = 25, shiftId = 77) =>
  ({ user_id: id, position, hourly_rate: rate, shift_id: shiftId });
const byobPkg = { pricing_type: 'flat' };
const hostedPkg = { pricing_type: 'per_guest' };

test('funded gate: unpaid proposal derives nothing', () => {
  const proposal = fundedProposal({ amount_paid: 999.99, num_bars: 1, pricing_snapshot: { bar_rental: { total: 50 }, addons: [] } });
  assert.equal(isFundedProposal(proposal), false);
  const desired = computeDesiredDutyLines({
    proposal, pkg: byobPkg, addons: [], workers: [W(1, 'Bartender')],
    shift: null, attributions: [{ kind: 'bar_rental', user_id: 1 }],
  });
  assert.deepEqual(desired, []);
});

test('bar_rental: $20 to the attributed bartender, only with attribution', () => {
  const proposal = fundedProposal({ num_bars: 1, pricing_snapshot: { bar_rental: { total: 50 }, addons: [] } });
  const workers = [W(1, 'Bartender'), W(2, 'Barback')];
  const none = computeDesiredDutyLines({ proposal, pkg: byobPkg, addons: [], workers, shift: null, attributions: [] });
  assert.deepEqual(none, []);
  const withAttr = computeDesiredDutyLines({
    proposal, pkg: byobPkg, addons: [], workers, shift: null,
    attributions: [{ kind: 'bar_rental', user_id: 1 }],
  });
  assert.deepEqual(withAttr, [{ contractor_id: 1, shift_id: 77, kind: 'bar_rental', amount_cents: 2000 }]);
  // A barback cannot be attributed the bar.
  const barback = computeDesiredDutyLines({
    proposal, pkg: byobPkg, addons: [], workers, shift: null,
    attributions: [{ kind: 'bar_rental', user_id: 2 }],
  });
  assert.deepEqual(barback, []);
});

test('equipment_supplies: fires at exactly $50.00 of flagged add-ons, not $49.99; bar money excluded', () => {
  const workers = [W(1, 'Bartender')];
  const attributions = [{ kind: 'equipment_supplies', user_id: 1 }];
  const at50 = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg,
    addons: [{ slug: 'real-glassware', line_total: 50.00, requires_provisioning: true }],
    workers, shift: null, attributions,
  });
  assert.deepEqual(at50, [{ contractor_id: 1, shift_id: 77, kind: 'equipment_supplies', amount_cents: 2000 }]);
  const under = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg,
    addons: [{ slug: 'real-glassware', line_total: 49.99, requires_provisioning: true }],
    workers, shift: null, attributions,
  });
  assert.deepEqual(under, []);
  // num_bars money does not count toward the threshold (bar pays its own $20).
  const barOnly = computeDesiredDutyLines({
    proposal: fundedProposal({ num_bars: 1, pricing_snapshot: { bar_rental: { total: 50 }, addons: [] } }),
    pkg: byobPkg, addons: [], workers, shift: null,
    attributions: [{ kind: 'equipment_supplies', user_id: 1 }, { kind: 'bar_rental', user_id: 1 }],
  });
  assert.deepEqual(barOnly.map((l) => l.kind), ['bar_rental']);
});

test('hosted: one FLAT $50 hosted_supplies fee replaces bar + equipment', () => {
  const proposal = fundedProposal({ num_bars: 1, pricing_snapshot: { bar_rental: { total: 50 }, addons: [] } });
  const workers = [W(1, 'Bartender', 30)];
  const desired = computeDesiredDutyLines({
    proposal, pkg: hostedPkg,
    addons: [{ slug: 'real-glassware', line_total: 120, requires_provisioning: true }],
    workers, shift: null,
    attributions: [
      { kind: 'hosted_supplies', user_id: 1 },
      { kind: 'bar_rental', user_id: 1 },
      { kind: 'equipment_supplies', user_id: 1 },
    ],
  });
  assert.equal(HOSTED_SUPPLIES_CENTS, 5000, 'flat $50 per Dallas 2026-08-07');
  assert.deepEqual(desired, [{
    contractor_id: 1, shift_id: 77, kind: 'hosted_supplies', amount_cents: 5000,
  }]);
});

test('hosted_supplies is RATE-INVARIANT: an outlier hourly_rate never moves the flat $50', () => {
  // The deprecated formula was 2.5h x hourly_rate, which a fat-fingered $500/hr
  // rate would have pushed past the payout_duty_lines_amount_cap_check ($1,000)
  // and rolled back the whole proposal accrual. Flat means the rate column
  // cannot reach duty money at all; this pins that.
  const proposal = fundedProposal({ num_bars: 1, pricing_snapshot: { bar_rental: { total: 50 }, addons: [] } });
  for (const rate of [0, 18, 500, null]) {
    const desired = computeDesiredDutyLines({
      proposal, pkg: hostedPkg, addons: [], workers: [W(1, 'Bartender', rate)],
      shift: null, attributions: [{ kind: 'hosted_supplies', user_id: 1 }],
    });
    assert.deepEqual(desired, [{
      contractor_id: 1, shift_id: 77, kind: 'hosted_supplies', amount_cents: 5000,
    }], `hourly_rate=${rate} must not change the flat fee`);
  }
});

test('parking: every approved staffer including barbacks, no attribution needed', () => {
  const desired = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg,
    addons: [{ slug: 'parking-fee', line_total: 60, requires_provisioning: false }],
    workers: [W(1, 'Bartender'), W(2, 'Barback'), W(3, 'Banquet Server')],
    shift: null, attributions: [],
  });
  assert.deepEqual(desired.map((l) => [l.contractor_id, l.kind, l.amount_cents]),
    [[1, 'parking', 2000], [2, 'parking', 2000], [3, 'parking', 2000]]);
});

test('menu_print: $5 on uploaded print, suppressed by menu_not_required', () => {
  const workers = [W(1, 'Bartender')];
  const attributions = [{ kind: 'menu_print', user_id: 1 }];
  const withKey = computeDesiredDutyLines({
    proposal: fundedProposal({ menu_print_key: 'menu-print/9/x.pdf' }),
    pkg: byobPkg, addons: [], workers, shift: null, attributions,
  });
  assert.deepEqual(withKey, [{ contractor_id: 1, shift_id: 77, kind: 'menu_print', amount_cents: 500 }]);
  const suppressed = computeDesiredDutyLines({
    proposal: fundedProposal({ menu_print_key: 'menu-print/9/x.pdf', menu_not_required: true }),
    pkg: byobPkg, addons: [], workers, shift: null, attributions,
  });
  assert.deepEqual(suppressed, []);
});

test('out_of_area: pays only the locked user, at the shift amount', () => {
  const workers = [W(1, 'Bartender', 25, 88), W(2, 'Bartender', 25, 88)];
  const shift = { id: 88, out_of_area_bonus_cents: 3500, out_of_area_locked_user_id: 2 };
  const desired = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg, addons: [], workers, shift, attributions: [],
  });
  assert.deepEqual(desired, [{ contractor_id: 2, shift_id: 88, kind: 'out_of_area', amount_cents: 3500 }]);
});

// ---------------------------------------------------------------------------
// DB tests: reconcile + materializers (shared dev DB, chicago-keyed fixtures)
// ---------------------------------------------------------------------------

const FIXTURE_FILTER = `email LIKE 'duty-%@example.com'`;
let userA, userB, proposalId, shiftId, periodId, payoutA, payoutB;
let todayPeriodId = null, todayPeriodPreExisted = false, todayPeriodOrigStatus = null;

async function cleanFixtures() {
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM staff_review_credits WHERE user_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM staff_reviews WHERE created_by IN (SELECT id FROM users WHERE ${FIXTURE_FILTER}) OR excerpt LIKE 'duty-fixture%'`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM duty_attributions WHERE user_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = 'duty-fixture')`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'duty-fixture'`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${FIXTURE_FILTER})`);
  await pool.query(`DELETE FROM users WHERE ${FIXTURE_FILTER}`);
}

before(async () => {
  await cleanFixtures();

  // Track-and-restore today's real period on the shared dev DB (clawback-suite
  // pattern: never delete a pre-existing row, restore its status after).
  const { startDate, endDate } = payPeriodForDate(chicagoTodayYmd());
  const payday = computePayday(endDate);
  const existing = await pool.query(
    'SELECT id, status FROM pay_periods WHERE start_date = $1 LIMIT 1', [startDate]
  );
  if (existing.rows[0]) {
    todayPeriodId = existing.rows[0].id;
    todayPeriodPreExisted = true;
    todayPeriodOrigStatus = existing.rows[0].status;
    if (todayPeriodOrigStatus !== 'open') {
      await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [todayPeriodId]);
    }
  } else {
    const r = await pool.query(
      `INSERT INTO pay_periods (start_date, end_date, payday, status)
       VALUES ($1, $2, $3, 'open') RETURNING id`,
      [startDate, endDate, payday]
    );
    todayPeriodId = r.rows[0].id;
  }
  periodId = todayPeriodId;

  const a = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('duty-a@example.com','x','staff') RETURNING id"
  );
  userA = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('duty-b@example.com','x','staff') RETURNING id"
  );
  userB = b.rows[0].id;

  const today = chicagoTodayYmd();
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, amount_paid)
     VALUES (NULL, $1, 'completed', 'duty-fixture', '6:00 PM', 4, 500, 500) RETURNING id`,
    [today]
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ($1, '6:00 PM', 'open', $2) RETURNING id`,
    [today, proposalId]
  );
  shiftId = s.rows[0].id;

  const pa = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2) RETURNING id`,
    [periodId, userA]
  );
  payoutA = pa.rows[0].id;
  const pb = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2) RETURNING id`,
    [periodId, userB]
  );
  payoutB = pb.rows[0].id;
});

after(async () => {
  await cleanFixtures();
  if (todayPeriodPreExisted && todayPeriodOrigStatus !== 'open') {
    await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2', [todayPeriodOrigStatus, todayPeriodId]);
  } else if (!todayPeriodPreExisted) {
    await pool.query('DELETE FROM pay_periods WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)', [todayPeriodId]);
  }
  await pool.end();
});

const desiredBar = () => [
  { contractor_id: userA, payout_id: payoutA, shift_id: shiftId, kind: 'bar_rental', amount_cents: 2000 },
];

test('reconcile: inserts once, idempotent on re-run', async () => {
  const client = await pool.connect();
  try {
    const r1 = await reconcileDutyLines(client, {
      proposalId, desired: desiredBar(), shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(r1.inserted, 1);
    const r2 = await reconcileDutyLines(client, {
      proposalId, desired: desiredBar(), shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(r2.inserted, 0);
    assert.equal(r2.systemRemoved, 0);
    assert.equal(await sumPayableDutyCents(client, payoutA), 2000);
  } finally {
    client.release();
  }
});

test('reconcile: amount update propagates on auto lines', async () => {
  const client = await pool.connect();
  try {
    const bumped = [{ ...desiredBar()[0], amount_cents: 2500 }];
    const r = await reconcileDutyLines(client, {
      proposalId, desired: bumped, shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(r.updated, 1);
    assert.equal(await sumPayableDutyCents(client, payoutA), 2500);
    // put it back
    await reconcileDutyLines(client, {
      proposalId, desired: desiredBar(), shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
  } finally {
    client.release();
  }
});

test('reconcile: trigger-false system-removes, trigger-true restores, admin removal is final', async () => {
  const client = await pool.connect();
  try {
    // Trigger gone: system-remove (worker still ON the roster; auto lines
    // remove on trigger-false regardless of roster state).
    let r = await reconcileDutyLines(client, {
      proposalId, desired: [], shiftIds: [shiftId], periodOpen: true,
      rosterContractorIds: [userA, userB],
    });
    assert.equal(r.systemRemoved, 1);
    assert.equal(await sumPayableDutyCents(client, payoutA), 0);
    // Trigger back: restore the system removal.
    r = await reconcileDutyLines(client, {
      proposalId, desired: desiredBar(), shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(r.restored, 1);
    assert.equal(await sumPayableDutyCents(client, payoutA), 2000);
    // Admin removes: reconcile must never resurrect.
    await client.query(
      `UPDATE payout_duty_lines SET removed_at = NOW(), removed_by = $2
        WHERE payout_id = $1 AND kind = 'bar_rental'`,
      [payoutA, userA]
    );
    r = await reconcileDutyLines(client, {
      proposalId, desired: desiredBar(), shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(r.restored, 0);
    assert.equal(r.inserted, 0);
    assert.equal(await sumPayableDutyCents(client, payoutA), 0);
    // reset for later tests
    await client.query(
      `DELETE FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'bar_rental'`, [payoutA]
    );
  } finally {
    client.release();
  }
});

test('reconcile: admin-owned line of an off-roster worker is HELD, not removed; rejoin unholds', async () => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO payout_duty_lines
         (payout_id, contractor_id, shift_id, kind, amount_cents, origin, admin_owned)
       VALUES ($1, $2, $3, 'equipment_supplies', 2000, 'auto', TRUE)`,
      [payoutB, userB, shiftId]
    );
    let r = await reconcileDutyLines(client, {
      proposalId, desired: [], shiftIds: [shiftId], periodOpen: true,
      rosterContractorIds: [],
    });
    assert.equal(r.held, 1);
    assert.equal(await sumPayableDutyCents(client, payoutB), 0);
    // Worker back in the desired set: unhold, payable again.
    r = await reconcileDutyLines(client, {
      proposalId,
      desired: [{ contractor_id: userB, payout_id: payoutB, shift_id: shiftId, kind: 'equipment_supplies', amount_cents: 2000 }],
      shiftIds: [shiftId], periodOpen: true, rosterContractorIds: [userA, userB],
    });
    assert.equal(await sumPayableDutyCents(client, payoutB), 2000);
    await client.query(
      `DELETE FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'equipment_supplies'`, [payoutB]
    );
  } finally {
    client.release();
  }
});

test('reconcile: frozen payout is skipped and reported, never written', async () => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO payout_duty_lines
         (payout_id, contractor_id, shift_id, kind, amount_cents, origin)
       VALUES ($1, $2, $3, 'parking', 2000, 'auto')`,
      [payoutA, userA, shiftId]
    );
    await client.query(`UPDATE payouts SET status = 'paid' WHERE id = $1`, [payoutA]);
    const r = await reconcileDutyLines(client, {
      proposalId, desired: [], shiftIds: [shiftId], periodOpen: true,
      rosterContractorIds: [userA, userB],
    });
    assert.equal(r.systemRemoved, 0);
    assert.equal(r.frozenSkips.length, 1);
    assert.equal(r.frozenSkips[0].action, 'remove');
    assert.equal(await sumPayableDutyCents(client, payoutA), 2000);
    await client.query(`UPDATE payouts SET status = 'pending' WHERE id = $1`, [payoutA]);
    await client.query(
      `DELETE FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'parking'`, [payoutA]
    );
  } finally {
    client.release();
  }
});

test('reconcile: admin manual line for an ON-roster worker is never touched (review B1)', async () => {
  const client = await pool.connect();
  try {
    // Manual admin line the deriver can never see (origin admin, admin_owned).
    await client.query(
      `INSERT INTO payout_duty_lines
         (payout_id, contractor_id, shift_id, kind, amount_cents, origin, admin_owned, note)
       VALUES ($1, $2, $3, 'out_of_area', 5000, 'admin', TRUE, 'manual bonus')`,
      [payoutA, userA, shiftId]
    );
    // Worker A is ON the roster; desired is empty (no triggers). Line must survive payable.
    const r = await reconcileDutyLines(client, {
      proposalId, desired: [], shiftIds: [shiftId], periodOpen: true,
      rosterContractorIds: [userA],
    });
    assert.equal(r.held, 0, 'on-roster manual money belongs to the admin alone');
    assert.equal(r.systemRemoved, 0);
    assert.equal(await sumPayableDutyCents(client, payoutA), 5000);
    // Same line once the worker leaves the roster: held, not removed.
    const r2 = await reconcileDutyLines(client, {
      proposalId, desired: [], shiftIds: [shiftId], periodOpen: true,
      rosterContractorIds: [],
    });
    assert.equal(r2.held, 1, 'off-roster admin money holds for the admin decision');
    assert.equal(await sumPayableDutyCents(client, payoutA), 0);
    await client.query(
      `DELETE FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'out_of_area'`, [payoutA]
    );
  } finally {
    client.release();
  }
});

test('out_of_area derives from EVERY shift, not only the first (review W5)', () => {
  const workers = [
    { user_id: 1, position: 'Bartender', hourly_rate: 25, shift_id: 90 },
    { user_id: 2, position: 'Bartender', hourly_rate: 25, shift_id: 91 },
  ];
  const shifts = [
    { id: 90, out_of_area_bonus_cents: null, out_of_area_locked_user_id: null },
    { id: 91, out_of_area_bonus_cents: 3500, out_of_area_locked_user_id: 2 },
  ];
  const desired = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg, addons: [], workers, shifts, attributions: [],
  });
  assert.deepEqual(desired, [{ contractor_id: 2, shift_id: 91, kind: 'out_of_area', amount_cents: 3500 }]);
});

test('parking pays once per staffer even across two shift-request rows (review W6)', () => {
  const workers = [
    { user_id: 1, position: 'Bartender', hourly_rate: 25, shift_id: 90 },
    { user_id: 1, position: 'Bartender', hourly_rate: 25, shift_id: 91 },
  ];
  const desired = computeDesiredDutyLines({
    proposal: fundedProposal(), pkg: byobPkg,
    addons: [{ slug: 'parking-fee', line_total: 20, requires_provisioning: false }],
    workers, shifts: [], attributions: [],
  });
  assert.equal(desired.filter((l) => l.kind === 'parking').length, 1);
});

test('materializeReviewLine: pays once per (review, contractor), recomputes the total', async () => {
  const client = await pool.connect();
  try {
    const rv = await client.query(
      `INSERT INTO staff_reviews (review_date, stars, source, excerpt, status, created_by)
       VALUES (CURRENT_DATE, 5, 'google', 'duty-fixture great job', 'confirmed', $1)
       RETURNING id`,
      [userA]
    );
    const reviewId = rv.rows[0].id;
    const first = await materializeReviewLine(client, { staffReviewId: reviewId, contractorId: userA });
    assert.ok(first, 'first materialize inserts');
    assert.equal(Number(first.amount_cents), 1000);
    const dup = await materializeReviewLine(client, { staffReviewId: reviewId, contractorId: userA });
    assert.equal(dup, null, 'double materialize is a no-op');
    const tot = await client.query('SELECT total_cents FROM payouts WHERE id = $1', [first.payout_id]);
    assert.equal(Number(tot.rows[0].total_cents) >= 1000, true, 'payout total includes the bounty');
  } finally {
    client.release();
  }
});

test('materializePendingReviewLines: catch-up pays a confirmed credit with no line', async () => {
  const client = await pool.connect();
  try {
    const rv = await client.query(
      `INSERT INTO staff_reviews (review_date, stars, source, excerpt, status, created_by)
       VALUES (CURRENT_DATE, 5, 'thumbtack', 'duty-fixture named both', 'confirmed', $1)
       RETURNING id`,
      [userA]
    );
    const reviewId = rv.rows[0].id;
    await client.query(
      `INSERT INTO staff_review_credits (staff_review_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [reviewId, userA, userB]
    );
    const r = await materializePendingReviewLines(client);
    assert.equal(r.materialized >= 2, true, 'both credited staffers paid');
    const again = await materializePendingReviewLines(client);
    assert.equal(again.materialized, 0, 'catch-up is idempotent');
  } finally {
    client.release();
  }
});
