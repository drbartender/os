// The change-request consent record stores the proxy-validated address (audit
// ESIG-01, AUTH-08): request_ip used to be the FIRST X-Forwarded-For entry,
// which the client types, and a value over 45 characters was a 22001 500.
//
// Runs against the dev database (DATABASE_URL from .env) with the real portal
// router on express() + app.listen(0), the harness of
// clientPortal.changeRequests.test.js, plus `app.set('trust proxy', 1)` so
// req.ip is read the way server/index.js reads it. Every row is synthetic and
// purged in after().
//
// Run: node --test server/routes/clientPortal.changeRequests.requestIp.test.js

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

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientPortal.changeRequests.requestIp.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-crip-%-${NONCE}@example.com`;
let server; let baseUrl; let token; let pkgId; let clientId;

function rq(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: d }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function seedProposal() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, event_date, pricing_snapshot)
     VALUES ($1,'deposit_paid',$2,100,4,1,4800,1000,'2099-09-09','{"staffing":{"actual":1}}') RETURNING id, token`,
    [clientId, pkgId]);
  return p.rows[0];
}

async function createWithHeader(proposalToken, xff) {
  const preview = (await rq('POST', `/api/client-portal/proposals/${proposalToken}/calculate`, { guest_count: 300 })).body.price_preview;
  assert.ok(preview, 'the preview priced');
  return rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`,
    { guest_count: 300, acknowledged_total: preview.estimated_total, note: 'more guests' },
    xff ? { 'X-Forwarded-For': xff } : {});
}

before(async () => {
  pkgId = (await pool.query('SELECT id FROM service_packages WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].id;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id, email', ['CP CR IP', `cp-crip-a-${NONCE}@example.com`]);
  clientId = c.rows[0].id;
  token = jwt.sign({ id: clientId, email: c.rows[0].email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.set('trust proxy', 1); // server/index.js:187
  app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, rq2, rs, nx) => {
    if (rs.headersSent) return nx(err);
    if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    console.error(err);
    return rs.status(500).json({ error: 'x' });
  });
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('request_ip is the proxy-validated address, not the forgeable first X-Forwarded-For hop', async () => {
  const p = await seedProposal();
  const res = await createWithHeader(p.token, '1.2.3.4, 10.0.0.1');
  assert.equal(res.status, 201, res.raw);
  const { rows } = await pool.query('SELECT request_ip FROM proposal_change_requests WHERE proposal_id = $1', [p.id]);
  assert.equal(rows[0].request_ip, '10.0.0.1');
});

test('a 300-character header still creates the request with a value that fits VARCHAR(45)', async () => {
  const p = await seedProposal();
  const res = await createWithHeader(p.token, 'a'.repeat(300));
  assert.equal(res.status, 201, res.raw);
  const { rows } = await pool.query('SELECT request_ip FROM proposal_change_requests WHERE proposal_id = $1', [p.id]);
  assert.ok(typeof rows[0].request_ip === 'string' && rows[0].request_ip.length <= 45);
});
