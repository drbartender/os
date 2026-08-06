require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.duty.test.js refuses to run against production');
}

// Owns a UNIQUE far-past OPEN period (Tue 2019-04-02..Mon 2019-04-08), the
// payrollAccrual.test.js pattern: accrual resolves the period from event_date,
// so this suite never touches the shared dev DB's live current period.
let bartenderId, barbackId, proposalId, shiftId, ownPeriodId;

async function dutyRows(contractorId) {
  const { rows } = await pool.query(
    `SELECT d.kind, d.amount_cents, d.removed_at, d.held_state, d.origin, po.total_cents
       FROM payout_duty_lines d JOIN payouts po ON po.id = d.payout_id
      WHERE d.contractor_id = $1 ORDER BY d.id`,
    [contractorId]
  );
  return rows;
}

before(async () => {
  const a = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('duty-acc-a@example.com','x','staff') RETURNING id"
  );
  bartenderId = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('duty-acc-b@example.com','x','staff') RETURNING id"
  );
  barbackId = b.rows[0].id;
  for (const [uid, rate] of [[bartenderId, 20.00], [barbackId, 18.00]]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = $2`,
      [uid, rate]
    );
  }
  const per = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-04-02','2019-04-08','2019-04-09','open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  );
  ownPeriodId = per.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES (NULL, '2019-04-02', 'completed', 'duty-acc-fixture', '6:00 PM', 4, 500, 500, 1,
             '{"bar_rental":{"total":50},"addons":[]}')
     RETURNING id`
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-04-02', '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, bartenderId]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Barback','approved')",
    [shiftId, barbackId]
  );
});

afterEach(async () => {
  for (const uid of [bartenderId, barbackId]) {
    await pool.query('DELETE FROM payout_duty_lines WHERE contractor_id = $1', [uid]);
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [uid]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [uid]);
  }
  await pool.query(`DELETE FROM staff_reviews WHERE excerpt LIKE 'duty-acc-fixture%'`);
  await pool.query('DELETE FROM duty_attributions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  for (const uid of [bartenderId, barbackId]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [uid]);
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  }
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [ownPeriodId]);
  await pool.end();
});

test('accrual derives the bar line to the auto-attributed lone bartender; idempotent; total includes it', async () => {
  await accruePayoutsForProposal(proposalId);
  let rows = await dutyRows(bartenderId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'bar_rental');
  assert.equal(Number(rows[0].amount_cents), 2000);
  assert.equal(rows[0].removed_at, null);
  // Wage 5.5h @ $20 = 11000; bar 2000. Barback gets no bar line.
  assert.equal(Number(rows[0].total_cents), 13000);
  assert.equal((await dutyRows(barbackId)).length, 0);
  // Auto-attribution went to the only bartender, not the barback.
  const attr = await pool.query(
    'SELECT user_id FROM duty_attributions WHERE proposal_id = $1 AND kind = $2',
    [proposalId, 'bar_rental']
  );
  assert.equal(Number(attr.rows[0].user_id), bartenderId);

  await accruePayoutsForProposal(proposalId);
  rows = await dutyRows(bartenderId);
  assert.equal(rows.length, 1, 're-accrual never duplicates');
  assert.equal(Number(rows[0].total_cents), 13000, 're-accrual never re-adds');
});

test('trigger gone (num_bars -> 0): re-accrual system-removes the line and the total drops', async () => {
  await accruePayoutsForProposal(proposalId);
  await pool.query('UPDATE proposals SET num_bars = 0 WHERE id = $1', [proposalId]);
  await accruePayoutsForProposal(proposalId);
  const rows = await dutyRows(bartenderId);
  assert.equal(rows.length, 1, 'removed row is kept, never deleted');
  assert.ok(rows[0].removed_at, 'system-removed');
  assert.equal(Number(rows[0].total_cents), 11000, 'total excludes the removed line');
});

test('bartender drops: their duty line system-removes while the barback keeps working', async () => {
  await accruePayoutsForProposal(proposalId);
  await pool.query(
    'UPDATE shift_requests SET dropped_at = NOW() WHERE shift_id = $1 AND user_id = $2',
    [shiftId, bartenderId]
  );
  await accruePayoutsForProposal(proposalId);
  const rows = await dutyRows(bartenderId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].removed_at, 'off-roster auto line system-removed (M5 analog)');
});

test('an admin manual duty line survives re-accrual untouched (review B1)', async () => {
  await accruePayoutsForProposal(proposalId);
  const po = await pool.query(
    'SELECT id FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [ownPeriodId, barbackId]
  );
  await pool.query(
    `INSERT INTO payout_duty_lines
       (payout_id, contractor_id, shift_id, kind, amount_cents, origin, admin_owned, note)
     VALUES ($1, $2, $3, 'equipment_supplies', 3000, 'admin', TRUE, 'sub-threshold pickup')`,
    [po.rows[0].id, barbackId, shiftId]
  );
  await accruePayoutsForProposal(proposalId);
  const rows = await dutyRows(barbackId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].removed_at, null, 'not system-removed');
  assert.equal(rows[0].held_state, null, 'not held: the barback is on the roster');
  const tot = await pool.query('SELECT total_cents FROM payouts WHERE id = $1', [po.rows[0].id]);
  // Barback wage 5.5h @ $18 = 9900, + manual 3000.
  assert.equal(Number(tot.rows[0].total_cents), 12900);
});

test('LAST worker drops (no_approved_workers path): duty reconciles away; duty rows keep the payout alive', async () => {
  await accruePayoutsForProposal(proposalId);
  // Seed a shift-less review bounty on the bartender's payout: it must survive
  // the empty-roster sweep (the CASCADE-guard) and stay payable.
  const po = await pool.query(
    'SELECT id FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [ownPeriodId, bartenderId]
  );
  const payoutId = po.rows[0].id;
  const rv = await pool.query(
    `INSERT INTO staff_reviews (review_date, stars, source, excerpt, status)
     VALUES ('2019-04-03', 5, 'google', 'duty-acc-fixture praise', 'confirmed') RETURNING id`
  );
  await pool.query(
    `INSERT INTO payout_duty_lines (payout_id, contractor_id, kind, amount_cents, origin, staff_review_id)
     VALUES ($1, $2, 'review_bounty', 1000, 'auto', $3)`,
    [payoutId, bartenderId, rv.rows[0].id]
  );
  await pool.query('UPDATE shift_requests SET dropped_at = NOW() WHERE shift_id = $1', [shiftId]);
  const res = await accruePayoutsForProposal(proposalId);
  assert.equal(res.reason, 'no_approved_workers');
  const stillThere = await pool.query('SELECT status, total_cents FROM payouts WHERE id = $1', [payoutId]);
  assert.equal(stillThere.rows.length, 1, 'payout with duty rows survives the phantom-stub delete');
  const rows = await dutyRows(bartenderId);
  const bar = rows.find(r => r.kind === 'bar_rental');
  const bounty = rows.find(r => r.kind === 'review_bounty');
  assert.ok(bar.removed_at, 'event-kind line reconciled away with the roster');
  assert.equal(bounty.removed_at, null, 'review kind untouched by event reconcile');
  assert.equal(Number(stillThere.rows[0].total_cents), 1000, 'total = surviving bounty only');
});
