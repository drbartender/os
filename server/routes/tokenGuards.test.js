require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('tokenGuards.test.js refuses to run against production');
}

// Audit follow-up (uuid-token-guards sweep): public/auth :token routes passed a raw param
// into UUID-column WHERE clauses, so a non-UUID cast-threw Postgres 22P02 -> 500.
// requireUuidToken now short-circuits to a clean 404. One representative route per auth class
// proves the middleware is actually wired into the route chain (not just unit-correct).

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const BAD = 'not-a-uuid';
let server, baseUrl, clientId, clientToken, adminId, adminToken;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, token_version) VALUES ('UuidGuard', $1, 0) RETURNING id`,
    [`uuidguard-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  clientToken = jwt.sign({ id: clientId, email: 'x@x', role: 'client', tokenVersion: 0 }, process.env.JWT_SECRET);

  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`uuidguard-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/calendar', require('./calendar'));
  app.use('/api/drink-plans', require('./drinkPlans'));
  app.use('/api/stripe', require('./stripe'));
  app.use('/api/client-portal', require('./clientPortal'));
  app.use('/api/messages', require('./messages'));
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

test('public: GET /api/calendar/feed/:token non-UUID -> 404 (not 500)', async () => {
  const r = await req('GET', `/api/calendar/feed/${BAD}`);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('public: GET /api/drink-plans/t/:token non-UUID -> 404', async () => {
  const r = await req('GET', `/api/drink-plans/t/${BAD}`);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('public payment: POST /api/stripe/create-intent-for-invoice/:token non-UUID -> 404', async () => {
  const r = await req('POST', `/api/stripe/create-intent-for-invoice/${BAD}`);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('public payment: POST /api/stripe/create-intent/:token non-UUID -> 404', async () => {
  const r = await req('POST', `/api/stripe/create-intent/${BAD}`);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('clientAuth: GET /api/client-portal/proposals/:token non-UUID -> 404 (auth passes, guard fires)', async () => {
  const r = await req('GET', `/api/client-portal/proposals/${BAD}`, clientToken);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('admin: GET /api/messages/history/:groupId non-UUID -> 404', async () => {
  const r = await req('GET', `/api/messages/history/${BAD}`, adminToken);
  assert.equal(r.status, 404, `got ${r.status} ${JSON.stringify(r.body)}`);
});
