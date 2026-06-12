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
  throw new Error('routeHardening3c.test.js refuses to run against production');
}

// Audit 3c-route hardening: input that previously cast-and-threw a Postgres 22P02 -> 500
// now returns a clean response. calendar /event/:shiftId.ics with a non-numeric id; clients
// list with a non-numeric / oversized limit.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`route3c-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/calendar', require('./calendar'));
  app.use('/api/clients', require('./clients'));
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
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

test('calendar GET /event/:shiftId.ics with a non-numeric id -> 404 (not 500)', async () => {
  const r = await get('/api/calendar/event/not-a-number.ics', adminToken);
  assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('clients GET / with a non-numeric limit -> 200 (not a 22P02 500)', async () => {
  const r = await get('/api/clients?limit=abc', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body), 'returns the clients array');
});

test('clients GET / with an oversized limit is bounded, still 200', async () => {
  const r = await get('/api/clients?limit=99999&page=0', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body));
});
