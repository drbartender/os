require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEditWindow, filterToAllowlist, cancelPendingChangeRequestsForProposal } = require('./changeRequests');
const { pool } = require('../db');
const crypto = require('node:crypto');

test('computeEditWindow: not booked is pre_booking', () => {
  assert.equal(computeEditWindow({ status: 'sent', event_date: '2099-01-01' }), 'pre_booking');
});
test('computeEditWindow: booked, far out is before_t14', () => {
  assert.equal(computeEditWindow({ status: 'deposit_paid', event_date: '2099-01-01' }), 'before_t14');
});
test('computeEditWindow: booked, past date is inside_t14', () => {
  assert.equal(computeEditWindow({ status: 'confirmed', event_date: '2000-01-01' }), 'inside_t14');
});
test('filterToAllowlist drops note/acknowledged_total and rejects unknown keys', () => {
  const out = filterToAllowlist({ guest_count: 120, note: 'hi', acknowledged_total: 5000 });
  assert.deepEqual(out, { guest_count: 120 });
  assert.throws(() => filterToAllowlist({ total_price_override: 1 }), /not be changed/i);
  assert.throws(() => filterToAllowlist({ adjustments: [] }), /not be changed/i);
});

const RNONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
test('cancelPendingChangeRequestsForProposal cancels pending rows', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Reap', `reap-${RNONCE}@example.com`]);
  const p = await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1,'completed') RETURNING id", [c.rows[0].id]);
  await pool.query(`INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window) VALUES ($1,$2,'pending','before_t14')`, [p.rows[0].id, c.rows[0].id]);
  const n = await cancelPendingChangeRequestsForProposal(p.rows[0].id);
  assert.equal(n, 1);
  const after = await pool.query('SELECT status, cancelled_by FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  assert.equal(after.rows[0].status, 'cancelled');
  assert.equal(after.rows[0].cancelled_by, 'system');
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});
