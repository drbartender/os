require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cr-demote-%-${NONCE}@example.com`;
let server, baseUrl, adminToken, pkgId;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  const u = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  assert.ok(u.rows[0], 'need an admin/manager user seeded');
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // Pick a per_guest, non-class package so a guest_count bump actually moves
  // the calculated total; flat-priced (BYOB) packages would no-op on this PATCH.
  const p = await pool.query("SELECT id FROM service_packages WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class' ORDER BY id LIMIT 1");
  assert.ok(p.rows[0], 'need an active per_guest, non-class package');
  pkgId = p.rows[0].id;
  const app = express(); app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use((err, rq, rs, nx) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_addons WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('confirmed proposal STAYS confirmed when a guest bump outruns amount_paid (merge decision A: lifecycle untouched; delta billed via the Additional Services invoice)', async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['CR Demote', `cr-demote-a-${NONCE}@example.com`]);
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1,'confirmed',$2,100,4,1,4800,1000,'{}') RETURNING id`, [c.rows[0].id, pkgId]);
  const res = await req('PATCH', `/api/proposals/${pr.rows[0].id}`, adminToken, { guest_count: 300 });
  assert.equal(res.status, 200);
  // Decision A (reconcileProposalPaymentStatus): 'confirmed' is a lifecycle state,
  // not demoted by a price move; the price delta is collected via the post-commit
  // Additional Services invoice rather than by reverting the status.
  assert.equal(res.body.status, 'confirmed');
});
