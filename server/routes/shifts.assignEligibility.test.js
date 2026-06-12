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
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.assignEligibility.test.js refuses to run against production');
}

// Audit 3c: POST /shifts/:id/assign must verify the target is a real onboarded worker
// (staff OR manager — managers are a worker class too, matching the messages.js recipient
// allow-list and the self-request path) before inserting a shift_request. An existing-but-
// ineligible user (admin / not onboarded) otherwise gets an orphan request whose downstream
// SMS/email silently no-op.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, eligibleId, ineligibleId, managerId, shiftId;

before(async () => {
  const mk = async (role, status, tag) => (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', $2, $3) RETURNING id`,
    [`assign-${tag}-${NONCE}@example.com`, role, status]
  )).rows[0].id;
  adminId = await mk('admin', 'approved', 'admin');
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  eligibleId = await mk('staff', 'approved', 'elig');
  ineligibleId = await mk('staff', 'rejected', 'inelig'); // exists, but not onboarded -> ineligible
  managerId = await mk('manager', 'approved', 'mgr'); // a manager is a worker class -> assignable

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 10, '18:00', '22:00', 'open', '123 Main', $1, '["bartender"]') RETURNING id`,
    [`Assign Test ${NONCE}`]
  );
  shiftId = sh.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/shifts', shiftsRouter);
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
  if (shiftId) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[adminId, eligibleId, ineligibleId, managerId].filter(Boolean)]);
  await pool.end();
});

function post(path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('assign to an existing-but-ineligible user (not onboarded) -> 404, no orphan shift_request', async () => {
  const r = await post(`/api/shifts/${shiftId}/assign`, adminToken, { user_id: ineligibleId, position: 'Bartender' });
  assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
  const sr = await pool.query('SELECT COUNT(*)::int AS n FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, ineligibleId]);
  assert.equal(sr.rows[0].n, 0, 'no orphan shift_request should be created');
});

test('assign to an eligible onboarded staff user -> succeeds (2xx, not 404)', async () => {
  const r = await post(`/api/shifts/${shiftId}/assign`, adminToken, { user_id: eligibleId, position: 'Bartender' });
  assert.ok(r.status >= 200 && r.status < 300, `eligible staff should assign; got ${r.status} ${JSON.stringify(r.body)}`);
});

test('assign to an onboarded manager -> succeeds (manager is a worker class, not 404)', async () => {
  const r = await post(`/api/shifts/${shiftId}/assign`, adminToken, { user_id: managerId, position: 'Bartender' });
  assert.ok(r.status >= 200 && r.status < 300, `manager should assign; got ${r.status} ${JSON.stringify(r.body)}`);
});

test('assign to an admin (not a worker class) -> 404, no orphan shift_request', async () => {
  const r = await post(`/api/shifts/${shiftId}/assign`, adminToken, { user_id: adminId, position: 'Bartender' });
  assert.equal(r.status, 404, `admin is not assignable; got ${r.status} ${JSON.stringify(r.body)}`);
  const sr = await pool.query('SELECT COUNT(*)::int AS n FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, adminId]);
  assert.equal(sr.rows[0].n, 0, 'no orphan shift_request for the admin');
});
