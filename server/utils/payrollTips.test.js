require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { matchTipToEvent } = require('./payrollTips');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');

let userId, proposalId, shiftId;

before(async () => {
  // Pre-clean any stranded fixtures from prior failed runs. matchTipToEvent now
  // re-accrues on the open path, so a crashed run can strand payouts and
  // payout_events (FK chain) alongside the user.
  const f = "email = 'tipmatch@example.com'";
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM users WHERE ${f}`);

  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('tipmatch@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours)
     VALUES (NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4) RETURNING id`
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, event_duration_hours)
     VALUES (CURRENT_DATE, '6:00 PM', 'open', $1, 4) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userId]
  );
});

afterEach(async () => {
  // matchTipToEvent now re-accrues on the open path, creating payouts +
  // payout_events (FK RESTRICT on shift_id) and possibly today's pay period.
  // Tear those down in FK order before the shift/proposal.
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id = $1 OR payout_id IN
       (SELECT id FROM payouts WHERE contractor_id = $2)`,
    [shiftId, userId]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [userId]);
  await pool.query('DELETE FROM tips WHERE target_user_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  // Remove today's open pay period if the accrual created it and nothing else
  // references it (preserve the dev DB's shared open period).
  await pool.query(
    `DELETE FROM pay_periods pp
      WHERE pp.status = 'open'
        AND CURRENT_DATE BETWEEN pp.start_date AND pp.end_date
        AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`
  );
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('matchTipToEvent > sets shift_id when the tip falls in the event window', async () => {
  // A tip during the event (event starts 6:00 PM Chicago = 23:00 UTC).
  // Use 23:30 UTC so the tip lands in-window regardless of session TZ
  // (Neon's default is GMT; Render's app server may differ). fee_cents is set so
  // the open-path re-accrual does not reach for a live Stripe fee.
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 128, 'pi_match_1', CURRENT_DATE + TIME '23:30') RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);
  const { rows } = await pool.query('SELECT shift_id FROM tips WHERE id = $1', [tip.rows[0].id]);
  assert.equal(rows[0].shift_id, shiftId);
});

test('matchTipToEvent > open period: the matched tip is accrued into a payout_event', async () => {
  // Force today's pay period open so the open-path re-accrual fires (a shared
  // dev DB may leave today's period non-open from a concurrent suite).
  const todayYmd = new Date().toISOString().slice(0, 10);
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'`,
    [startDate, endDate, computePayday(endDate)]
  );

  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 128, 'pi_match_accrue', CURRENT_DATE + TIME '23:30')
     RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);

  // The tip is now folded into the bartender's payout_event for the ORIGINAL
  // shift in the open period. Before this fix the webhook open path set shift_id
  // but never re-accrued, so the tip silently never reached a payout.
  const { rows } = await pool.query(
    `SELECT pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
    [shiftId, userId]
  );
  assert.equal(rows.length, 1, 'the matched tip produced exactly one payout_event line');
  assert.equal(Number(rows[0].card_tip_gross_cents), 5000);
  assert.equal(Number(rows[0].card_tip_fee_cents), 128);
  assert.equal(Number(rows[0].card_tip_net_cents), 4872);
});

test('matchTipToEvent > leaves shift_id null when the tip is far outside any window', async () => {
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 'pi_match_2', CURRENT_DATE - INTERVAL '10 days') RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);
  const { rows } = await pool.query('SELECT shift_id FROM tips WHERE id = $1', [tip.rows[0].id]);
  assert.equal(rows[0].shift_id, null);
});
