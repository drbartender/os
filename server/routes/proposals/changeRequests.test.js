require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const adminRouter = require('./changeRequests');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `adm-cr-%-${NONCE}@example.com`;
let server, baseUrl, adminToken, crId, proposalId;

function rq(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  const u = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  assert.ok(u.rows[0], 'need an admin/manager user seeded');
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Adm CR', `adm-cr-a-${NONCE}@example.com`]);
  const p = await pool.query("INSERT INTO proposals (client_id, status, event_date) VALUES ($1,'deposit_paid','2099-09-09') RETURNING id", [c.rows[0].id]);
  proposalId = p.rows[0].id;
  const cr = await pool.query("INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window, price_preview) VALUES ($1,$2,'pending','before_t14','{\"estimated_total\":5000}') RETURNING id", [proposalId, c.rows[0].id]);
  crId = cr.rows[0].id;
  const app = express(); app.use(express.json());
  app.use('/api/proposals', adminRouter);
  app.use((err, a, rs, n) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('queue lists the pending request', async () => {
  const res = await rq('GET', '/api/proposals/change-requests?status=pending', adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.requests.some(r => r.id === crId));
});
test('decline flips to declined with a reason', async () => {
  const res = await rq('POST', `/api/proposals/change-requests/${crId}/decline`, adminToken, { decision_note: 'No availability that date.' });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT status, decision_note FROM proposal_change_requests WHERE id = $1', [crId]);
  assert.equal(row.rows[0].status, 'declined');
  assert.equal(row.rows[0].decision_note, 'No availability that date.');
});
