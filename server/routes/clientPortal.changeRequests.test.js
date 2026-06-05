require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientPortalRouter = require('./clientPortal');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-cr-%-${NONCE}@example.com`;
let server, baseUrl, token, proposalToken, pkgId;

function rq(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  pkgId = (await pool.query('SELECT id FROM service_packages WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].id;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id, email', ['CP CR', `cp-cr-a-${NONCE}@example.com`]);
  token = jwt.sign({ id: c.rows[0].id, email: c.rows[0].email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, event_date, pricing_snapshot)
     VALUES ($1,'deposit_paid',$2,100,4,1,4800,1000,'2099-09-09','{"staffing":{"actual":1}}') RETURNING token`,
    [c.rows[0].id, pkgId]);
  proposalToken = p.rows[0].token;
  const app = express(); app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, rq2, rs, nx) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('calculate returns a preview with current/estimated/delta', async () => {
  const res = await rq('POST', `/api/client-portal/proposals/${proposalToken}/calculate`, token, { guest_count: 300 });
  assert.equal(res.status, 200);
  assert.ok(res.body.price_preview);
  assert.equal(typeof res.body.price_preview.estimated_total, 'number');
});
test('create stores a pending request, second create is 409', async () => {
  const preview = (await rq('POST', `/api/client-portal/proposals/${proposalToken}/calculate`, token, { guest_count: 300 })).body.price_preview;
  // wrong acknowledged_total -> consent mismatch -> 409 PRICE_CHANGED
  const r1 = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: 99999, note: 'more guests' });
  assert.equal(r1.status, 409);
  // correct acknowledged_total -> 201 created
  const ok = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: preview.estimated_total, note: 'more guests' });
  assert.equal(ok.status, 201);
  // same proposed state + matching ack passes consent, hits the partial-unique -> 409 ALREADY_OPEN
  const dup = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: preview.estimated_total });
  assert.equal(dup.status, 409);
});
test('list returns the open request; cancel flips it', async () => {
  const list = await rq('GET', `/api/client-portal/proposals/${proposalToken}/change-requests`, token);
  assert.equal(list.status, 200);
  const open = list.body.requests.find(r => r.status === 'pending');
  assert.ok(open);
  const cancel = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests/${open.id}/cancel`, token);
  assert.equal(cancel.status, 200);
});
