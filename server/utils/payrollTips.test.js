require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { matchTipToEvent } = require('./payrollTips');

let userId, proposalId, shiftId;

before(async () => {
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
  await pool.query('DELETE FROM tips WHERE target_user_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('matchTipToEvent > sets shift_id when the tip falls in the event window', async () => {
  // A tip during the event (event starts 6:00 PM Chicago = 23:00 UTC).
  // Use 23:30 UTC so the tip lands in-window regardless of session TZ
  // (Neon's default is GMT; Render's app server may differ).
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 'pi_match_1', CURRENT_DATE + TIME '23:30') RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);
  const { rows } = await pool.query('SELECT shift_id FROM tips WHERE id = $1', [tip.rows[0].id]);
  assert.equal(rows[0].shift_id, shiftId);
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
