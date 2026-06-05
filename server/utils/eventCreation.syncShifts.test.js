require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { syncShiftsFromProposal } = require('./eventCreation');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `sync-%-${NONCE}@example.com`;
let clientId, pkgId;

before(async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['Sync', `sync-a-${NONCE}@example.com`]);
  clientId = c.rows[0].id;
  pkgId = (await pool.query('SELECT id FROM service_packages ORDER BY id LIMIT 1')).rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id = $1))', [clientId]);
  await pool.query('DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)', [clientId]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [EMAIL_LIKE]);
});

test('growth: positions_needed grows to match num_bartenders', async () => {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, num_bartenders, event_date, event_start_time, event_duration_hours)
     VALUES ($1,'deposit_paid',$2,300,3,'2099-09-09','5:00 PM',4) RETURNING id`, [clientId, pkgId]);
  const proposalId = pr.rows[0].id;
  await pool.query(`INSERT INTO shifts (event_date, positions_needed, status, proposal_id) VALUES ('2099-09-09','["Bartender"]','open',$1)`, [proposalId]);
  await syncShiftsFromProposal(proposalId, pool);
  const s = await pool.query('SELECT positions_needed FROM shifts WHERE proposal_id = $1', [proposalId]);
  assert.deepEqual(JSON.parse(s.rows[0].positions_needed), ['Bartender', 'Bartender', 'Bartender']);
});

test('shrink is capped at approved assignments and logs staffing_shrink_capped', async () => {
  // num_bartenders shrinks to 1, but 2 approved (non-dropped) assignments exist,
  // so slots must floor at 2 and a staffing_shrink_capped row must be logged.
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, num_bartenders, event_date, event_start_time, event_duration_hours)
     VALUES ($1,'deposit_paid',$2,80,1,'2099-09-09','5:00 PM',4) RETURNING id`, [clientId, pkgId]);
  const proposalId = pr.rows[0].id;
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, positions_needed, status, proposal_id) VALUES ('2099-09-09','["Bartender","Bartender","Bartender"]','open',$1) RETURNING id`,
    [proposalId]);
  const shiftId = sh.rows[0].id;
  const u1 = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id', [`sync-s1-${NONCE}@example.com`, 'x', 'staff']);
  const u2 = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id', [`sync-s2-${NONCE}@example.com`, 'x', 'staff']);
  await pool.query(`INSERT INTO shift_requests (shift_id, user_id, status, dropped_at) VALUES ($1,$2,'approved',NULL)`, [shiftId, u1.rows[0].id]);
  await pool.query(`INSERT INTO shift_requests (shift_id, user_id, status, dropped_at) VALUES ($1,$2,'approved',NULL)`, [shiftId, u2.rows[0].id]);
  await syncShiftsFromProposal(proposalId, pool);
  const s = await pool.query('SELECT positions_needed FROM shifts WHERE proposal_id = $1', [proposalId]);
  assert.deepEqual(JSON.parse(s.rows[0].positions_needed), ['Bartender', 'Bartender']);
  const log = await pool.query("SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'staffing_shrink_capped'", [proposalId]);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].details.desired, 1);
  assert.equal(log.rows[0].details.approved, 2);
  assert.equal(log.rows[0].details.kept, 2);
});
