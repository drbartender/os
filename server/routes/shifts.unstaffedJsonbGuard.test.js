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
  throw new Error('shifts.unstaffedJsonbGuard.test.js refuses to run against production');
}

// Audit 3c: GET /shifts/unstaffed-upcoming cast positions_needed::jsonb in the WHERE, which
// 22P02s -> 500 if any open upcoming shift holds a malformed (non-array) positions_needed
// (legacy/manual data inserted between boot normalizations). The query now uses IS JSON ARRAY
// + a CASE-guarded cast so a bad row is skipped instead of crashing the whole list.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, badShiftId, goodShiftId;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`unstaffed-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const bad = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, 'not-json') RETURNING id`,
    [`Bad ${NONCE}`]
  );
  badShiftId = bad.rows[0].id;
  const good = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, '["bartender"]') RETURNING id`,
    [`Good ${NONCE}`]
  );
  goodShiftId = good.rows[0].id;

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
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [[badShiftId, goodShiftId].filter(Boolean)]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

test('GET /unstaffed-upcoming with a malformed positions_needed row -> 200 (not 22P02 500); good shift still listed, bad one skipped', async () => {
  const r = await get('/api/shifts/unstaffed-upcoming', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body), 'returns the shift array');
  assert.ok(r.body.some((s) => s.id === goodShiftId), 'the valid open shift is listed');
  assert.ok(!r.body.some((s) => s.id === badShiftId), 'the malformed shift is safely skipped');
});
