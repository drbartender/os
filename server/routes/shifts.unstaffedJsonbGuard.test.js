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

// The same endpoint also carries approved_by_role (the per-role fill aggregate
// AssignToEventModal preselects its position from). It must agree row-for-row
// with approved_count: same status/dropped_at/position filters as the admin
// GET / feed, so a dropped or pending request never inflates a role.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, badShiftId, goodShiftId, mixedShiftId;
let staffIds = [];

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

  // Mixed roster: 2 Bartender + 1 Barback, with one approved Bartender, one
  // DROPPED Barback, and one pending Barback. Only the approved-and-not-dropped
  // row may show up in approved_by_role.
  const mixed = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, '["Bartender","Bartender","Barback"]') RETURNING id`,
    [`Mixed ${NONCE}`]
  );
  mixedShiftId = mixed.rows[0].id;

  for (const n of [1, 2, 3]) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
      [`unstaffed-staff${n}-${NONCE}@example.com`]
    );
    staffIds.push(u.rows[0].id);
  }
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at) VALUES
       ($1, $2, 'Bartender', 'approved', NULL),
       ($1, $3, 'Barback',   'approved', NOW()),
       ($1, $4, 'Barback',   'pending',  NULL)`,
    [mixedShiftId, staffIds[0], staffIds[1], staffIds[2]]
  );

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
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [[badShiftId, goodShiftId, mixedShiftId].filter(Boolean)]);
  if (staffIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [staffIds]);
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

test('GET /unstaffed-upcoming carries approved_by_role, excluding dropped and pending requests', async () => {
  const r = await get('/api/shifts/unstaffed-upcoming', adminToken);
  assert.equal(r.status, 200);

  const mixed = r.body.find((s) => s.id === mixedShiftId);
  assert.ok(mixed, 'the mixed-roster shift is listed (1 approved of 3 slots)');
  assert.deepEqual(
    mixed.approved_by_role,
    { Bartender: 1 },
    'only the approved, non-dropped Bartender counts'
  );
  assert.equal(
    Number(mixed.approved_count),
    Object.values(mixed.approved_by_role).reduce((a, b) => a + b, 0),
    'approved_by_role sums to approved_count'
  );

  const good = r.body.find((s) => s.id === goodShiftId);
  assert.deepEqual(good.approved_by_role, {}, 'a shift with no approved requests gets {}');
});
