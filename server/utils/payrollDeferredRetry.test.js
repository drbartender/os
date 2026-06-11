require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

// Dates no other payroll suite uses. FROZEN period contains the event; OPEN period contains "today"
// is forced below. We instead force the WHOLE accrual surface to use these dates by pinning the tip's
// shift to the frozen period and toggling the period that contains today.
const FROZEN_START = '2026-04-07', FROZEN_END = '2026-04-13'; // a Tue-Mon, status 'paid'
let userId, shiftId, tipId;

before(async () => {
  const u = await pool.query("INSERT INTO users (email,password_hash,role) VALUES ('deftip@example.com','x','staff') RETURNING id");
  userId = u.rows[0].id;
  await pool.query("INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1,20.00) ON CONFLICT (user_id) DO UPDATE SET hourly_rate=20.00", [userId]);
  // Frozen period the tip's event lives in.
  await pool.query(
    `INSERT INTO pay_periods (start_date,end_date,payday,status) VALUES ($1,$2,$3,'paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid'`, [FROZEN_START, FROZEN_END, '2026-04-14']);
});

beforeEach(async () => {
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
});

after(async () => {
  // Restore today's SHARED pay period (the suite flips it via setTodayPeriod). 'open' is
  // the benign default; leaving it processing/paid would bleed into other payroll suites.
  await pool.query("UPDATE pay_periods SET status='open' WHERE CURRENT_DATE BETWEEN start_date AND end_date");
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
});

// Force the period containing today into a given status.
async function setTodayPeriod(status) {
  await pool.query("UPDATE pay_periods SET status=$1 WHERE CURRENT_DATE BETWEEN start_date AND end_date", [status]);
}

test('rollForwardLateTip > frozen today defers and marks the tip', async () => {
  await setTodayPeriod('processing'); // freeze today so roll-forward defers
  const r = await rollForwardLateTip(tipId);
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'deferred_at set');
  assert.equal(rows[0].defer_kind, 'roll_forward');
  assert.equal(rows[0].defer_attempts, 1);
  assert.equal(rows[0].rolled_forward_at, null);
});

test('rollForwardLateTip > open today places and clears the marker (idempotent)', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);            // defers, marks
  await setTodayPeriod('open');               // open today
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
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);                 // places, rolled_forward_at set, marker NULL
  // Simulate the racy late marker write hitting an already-placed tip:
  await pool.query("UPDATE tips SET deferred_at=COALESCE(deferred_at,NOW()), defer_kind='roll_forward', defer_attempts=defer_attempts+1 WHERE id=$1 AND rolled_forward_at IS NULL", [tipId]);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'guarded UPDATE did not re-mark a placed tip');
});

const { clawbackTip } = require('./payrollClawback');

test('clawbackTip > frozen today defers and marks with target', async () => {
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);     // place the tip so there's a line to claw
  await setTodayPeriod('processing');  // freeze today
  const r = await clawbackTip(tipId, 2000); // refund $20 of the $50 tip
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at);
  assert.equal(rows[0].defer_kind, 'clawback');
  assert.equal(rows[0].defer_target_cents, 2000);
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative not advanced while deferred');
});

test('clawbackTip > refund on a roll_forward-deferred (never placed) tip records refund, no negative line', async () => {
  await setTodayPeriod('processing');
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
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);     // place so there is a line
  await setTodayPeriod('processing');  // freeze today
  await clawbackTip(tipId, 2000);      // defer $20
  await clawbackTip(tipId, 3500);      // a larger refund lands, still frozen
  const { rows } = await pool.query("SELECT defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].defer_target_cents, 3500, 'target raised to the latest cumulative');
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative still not advanced while deferred');
});

const { retryDeferredTips } = require('./payrollDeferredRetry');

test('retryDeferredTips > places a deferred late tip and clears its marker', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);   // deferred
  await setTodayPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.resolved, 1);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null);
});

test('retryDeferredTips > skips tips past the attempt cap (stays deferred)', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);                 // deferred, attempts=1
  await pool.query("UPDATE tips SET defer_attempts = 25 WHERE id=$1", [tipId]); // simulate stuck
  await setTodayPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.scanned, 0, 'capped tip not scanned');
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'still deferred (kept on admin list)');
});
