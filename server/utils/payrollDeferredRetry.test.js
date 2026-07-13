require('dotenv').config();
const { test, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

// Full isolation from the shared CURRENT_DATE pay period. This suite must
// exercise place-vs-defer, which means toggling "today's" period between open
// and frozen — a destructive mutation if done against the real dev-app row.
// Instead it pins the JS clock (mock.timers, Date only) to a far-past "today":
// rollForwardLateTip / clawbackTip / retryDeferredTips resolve their destination
// period from chicagoTodayYmd() (which reads new Date()), and findOpenPeriodForDate
// keys on that JS-derived ymd — NOT SQL CURRENT_DATE — so they land in a PRIVATE
// period this suite owns and toggles by start_date. The real "today" row is never
// touched. Two UNIQUE far-past weeks, used by no other payroll suite:
//   CURRENT — Tue 2019-05-07..Mon 2019-05-13 (the mocked "today" period)
//   FROZEN  — Tue 2019-04-09..Mon 2019-04-15 (paid; the tip's original event)
const TODAY_INSTANT = '2019-05-07T12:00:00Z'; // noon UTC = same Chicago calendar day
const CUR_START = '2019-05-07';
const FROZEN_START = '2019-04-09', FROZEN_END = '2019-04-15';
let userId, shiftId, tipId, curPeriodId, frozenPeriodId;

before(async () => {
  const u = await pool.query("INSERT INTO users (email,password_hash,role) VALUES ('deftip@example.com','x','staff') RETURNING id");
  userId = u.rows[0].id;
  await pool.query("INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1,20.00) ON CONFLICT (user_id) DO UPDATE SET hourly_rate=20.00", [userId]);
  // Frozen (paid) period the tip's original event lives in.
  const fp = await pool.query(
    `INSERT INTO pay_periods (start_date,end_date,payday,status) VALUES ($1,$2,'2019-04-16','paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid' RETURNING id`, [FROZEN_START, FROZEN_END]);
  frozenPeriodId = fp.rows[0].id;
  // The private "today" period the mocked clock resolves to. Seeded open;
  // individual tests toggle its status via setCurrentPeriod().
  const cp = await pool.query(
    `INSERT INTO pay_periods (start_date,end_date,payday,status) VALUES ('2019-05-07','2019-05-13','2019-05-14','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`);
  curPeriodId = cp.rows[0].id;
});

beforeEach(async () => {
  // Pin "today" to the far-past CURRENT week for every rollForward/clawback/retry.
  mock.timers.enable({ apis: ['Date'], now: Date.parse(TODAY_INSTANT) });
  const p = await pool.query(
    `INSERT INTO proposals (client_id,event_date,status,event_type,event_start_time,event_duration_hours,total_price,amount_paid,pricing_snapshot)
     VALUES (NULL,$1,'completed','birthday-party','6:00 PM',4,1000,1000,'{"breakdown":[]}') RETURNING id`, [FROZEN_START]);
  const proposalId = p.rows[0].id;
  const s = await pool.query("INSERT INTO shifts (event_date,start_time,status,proposal_id) VALUES ($1,'6:00 PM','open',$2) RETURNING id", [FROZEN_START, proposalId]);
  shiftId = s.rows[0].id;
  await pool.query("INSERT INTO shift_requests (shift_id,user_id,position,status) VALUES ($1,$2,'Bartender','approved')", [shiftId, userId]);
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 5000, 150, 'pi_deftip_' || extract(epoch from now())::bigint || '_' || floor(random()*1000000)::bigint, NOW(), $2)
     RETURNING id`,
    [userId, shiftId]);
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query("DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id=$1)", [userId]);
  await pool.query("DELETE FROM payouts WHERE contractor_id=$1", [userId]);
  await pool.query("DELETE FROM tips WHERE id=$1", [tipId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [shiftId]);
  // Reset this suite's own CURRENT period to open for the next test (each test
  // sets the status it needs at its start; this just keeps state predictable).
  await pool.query("UPDATE pay_periods SET status='open' WHERE start_date=$1", [CUR_START]);
  mock.timers.reset();
});

after(async () => {
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  // Delete ONLY this suite's own periods, by captured id. afterEach already
  // cleared every payout referencing the CURRENT period.
  await pool.query("DELETE FROM pay_periods WHERE id = ANY($1)", [[curPeriodId, frozenPeriodId]]);
  await pool.end();
});

// Force this suite's private "today" period (the one the mocked clock resolves
// to) into a given status. Keyed on the suite's own start_date, never CURRENT_DATE.
async function setCurrentPeriod(status) {
  await pool.query("UPDATE pay_periods SET status=$1 WHERE start_date=$2", [status, CUR_START]);
}

test('rollForwardLateTip > frozen today defers and marks the tip', async () => {
  await setCurrentPeriod('processing'); // freeze today so roll-forward defers
  const r = await rollForwardLateTip(tipId);
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'deferred_at set');
  assert.equal(rows[0].defer_kind, 'roll_forward');
  assert.equal(rows[0].defer_attempts, 1);
  assert.equal(rows[0].rolled_forward_at, null);
});

test('rollForwardLateTip > open today places and clears the marker (idempotent)', async () => {
  await setCurrentPeriod('processing');
  await rollForwardLateTip(tipId);            // defers, marks
  await setCurrentPeriod('open');               // open today
  const r = await rollForwardLateTip(tipId);  // retry
  assert.ok(r && r.bartenders === 1);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'marker cleared');
  assert.equal(rows[0].defer_kind, null);
  assert.equal(rows[0].defer_attempts, 0);
  assert.ok(rows[0].rolled_forward_at, 'placed');
  // idempotent
  await rollForwardLateTip(tipId);
  const c = await pool.query("SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id=pe.payout_id WHERE po.contractor_id=$1", [userId]);
  assert.equal(c.rows[0].c, 1);
});

test('rollForwardLateTip > defer marker does NOT resurrect an already-placed tip (race guard)', async () => {
  await setCurrentPeriod('open');
  await rollForwardLateTip(tipId);                 // places, rolled_forward_at set, marker NULL
  // Simulate the racy late marker write hitting an already-placed tip:
  await pool.query("UPDATE tips SET deferred_at=COALESCE(deferred_at,NOW()), defer_kind='roll_forward', defer_attempts=defer_attempts+1 WHERE id=$1 AND rolled_forward_at IS NULL", [tipId]);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'guarded UPDATE did not re-mark a placed tip');
});

const { clawbackTip } = require('./payrollClawback');

test('clawbackTip > frozen today defers and marks with target', async () => {
  await setCurrentPeriod('open');
  await rollForwardLateTip(tipId);     // place the tip so there's a line to claw
  await setCurrentPeriod('processing');  // freeze today
  const r = await clawbackTip(tipId, 2000); // refund $20 of the $50 tip
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at);
  assert.equal(rows[0].defer_kind, 'clawback');
  assert.equal(rows[0].defer_target_cents, 2000);
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative not advanced while deferred');
});

test('clawbackTip > refund on a roll_forward-deferred (never placed) tip records refund, no negative line', async () => {
  await setCurrentPeriod('processing');
  await rollForwardLateTip(tipId);     // roll_forward-deferred (never placed)
  const r = await clawbackTip(tipId, 5000); // full refund arrives while still deferred
  assert.ok(r && r.unplaced === true);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, rolled_forward_at, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'roll_forward marker cancelled');
  assert.equal(rows[0].defer_kind, null);
  assert.ok(rows[0].rolled_forward_at, 'roll-forward cancelled so it is never paid');
  assert.equal(rows[0].refunded_amount_cents, 5000);
  const c = await pool.query("SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id=pe.payout_id WHERE po.contractor_id=$1", [userId]);
  assert.equal(c.rows[0].c, 0, 'no negative line created');
});

test('clawbackTip > escalating refund while deferred raises defer_target_cents', async () => {
  await setCurrentPeriod('open');
  await rollForwardLateTip(tipId);     // place so there is a line
  await setCurrentPeriod('processing');  // freeze today
  await clawbackTip(tipId, 2000);      // defer $20
  await clawbackTip(tipId, 3500);      // a larger refund lands, still frozen
  const { rows } = await pool.query("SELECT defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].defer_target_cents, 3500, 'target raised to the latest cumulative');
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative still not advanced while deferred');
});

const { retryDeferredTips } = require('./payrollDeferredRetry');

test('retryDeferredTips > places a deferred late tip and clears its marker', async () => {
  await setCurrentPeriod('processing');
  await rollForwardLateTip(tipId);   // deferred
  await setCurrentPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.resolved, 1);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null);
});

test('retryDeferredTips > skips tips past the attempt cap (stays deferred)', async () => {
  await setCurrentPeriod('processing');
  await rollForwardLateTip(tipId);                 // deferred, attempts=1
  await pool.query("UPDATE tips SET defer_attempts = 25 WHERE id=$1", [tipId]); // simulate stuck
  await setCurrentPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.scanned, 0, 'capped tip not scanned');
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'still deferred (kept on admin list)');
});

const { accruePayoutsForProposal } = require('./payrollAccrual');

test('accrual hook > a successful accrual sweeps a deferred tip', async () => {
  await setCurrentPeriod('processing');
  await rollForwardLateTip(tipId);  // deferred
  await setCurrentPeriod('open');
  // A fresh, unrelated funded proposal whose event_date sits in the CURRENT
  // (mocked-today) period, so accrual resolves there and its post-commit sweep
  // fires under the same mocked clock.
  const p2 = await pool.query(
    `INSERT INTO proposals (client_id,event_date,status,event_type,event_start_time,event_duration_hours,total_price,amount_paid,pricing_snapshot)
     VALUES (NULL,'2019-05-07','completed','birthday-party','6:00 PM',4,1000,1000,'{"breakdown":[]}') RETURNING id`);
  const s2 = await pool.query("INSERT INTO shifts (event_date,start_time,status,proposal_id) VALUES ('2019-05-07','6:00 PM','open',$1) RETURNING id", [p2.rows[0].id]);
  await pool.query("INSERT INTO shift_requests (shift_id,user_id,position,status) VALUES ($1,$2,'Bartender','approved')", [s2.rows[0].id, userId]);
  await accruePayoutsForProposal(p2.rows[0].id);
  // Wait for the off-response-path sweep to run. Polls instead of a fixed sleep
  // so a slow CI / Windows scheduler tick can't flake — the sweep itself is
  // typically sub-second locally, but setImmediate + a pool checkout vary.
  for (let i = 0; i < 40; i += 1) {
    const probe = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
    if (probe.rows[0].deferred_at === null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const { rows } = await pool.query("SELECT deferred_at, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'deferred tip swept by the accrual hook');
  assert.ok(rows[0].rolled_forward_at);
  // cleanup the extra fixtures
  await pool.query("DELETE FROM payout_events WHERE shift_id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [p2.rows[0].id]);
});
