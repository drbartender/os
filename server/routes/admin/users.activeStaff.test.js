require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.activeStaff.test.js refuses to run against production');
}

// Covers Batch 13a Task 23b — the `?include_stubs=true` opt-in plus the
// defense-in-depth email redaction for non-admin callers. Fixtures: admin,
// manager (with can_staff so they pass the route's role check), one real
// approved staff user, and one legacy CC stub. Each gets a completed
// onboarding_progress row so the route's JOIN keeps them in the result.

const PREFIX = 'cc-activestaff-test-';

let server, baseUrl;
let adminId, adminToken;
let managerId, managerToken;
let realStaffId;
let stubUserId;
let stubCcId;

before(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const a = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status)
       VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
      [`${PREFIX}admin@example.com`]
    );
    adminId = a.rows[0].id;
    adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const m = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, can_staff)
       VALUES ($1, 'x', 'manager', 'approved', TRUE) RETURNING id`,
      [`${PREFIX}manager@example.com`]
    );
    managerId = m.rows[0].id;
    managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

    // Real approved staff member — should always appear.
    const real = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status)
       VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
      [`${PREFIX}realstaff@example.com`]
    );
    realStaffId = real.rows[0].id;

    // Legacy CC stub — onboarding_status='deactivated' so default filter
    // excludes them; cc_id LIKE 'legacy_cc:%' so the redaction triggers.
    stubCcId = `legacy_cc:activestaff-fixture:${Date.now()}`;
    const stub = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, cc_id)
       VALUES ($1, 'x', 'staff', 'deactivated', $2) RETURNING id`,
      [`${PREFIX}legacy-stub-${Date.now()}@drbartender.local`, stubCcId]
    );
    stubUserId = stub.rows[0].id;

    // /active-staff joins onboarding_progress (onboarding_completed = true).
    // Seed a completed row for every fixture user so the JOIN keeps them.
    for (const uid of [adminId, managerId, realStaffId, stubUserId]) {
      await c.query(
        `INSERT INTO onboarding_progress (user_id, onboarding_completed) VALUES ($1, TRUE)`,
        [uid]
      );
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));

  const userIds = [adminId, managerId, realStaffId, stubUserId].filter(Boolean);
  if (userIds.length) {
    await pool.query(`DELETE FROM onboarding_progress WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  }

  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      {
        method, hostname: url.hostname, port: url.port,
        path: url.pathname + (url.search || ''), headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

// ── /active-staff include_stubs behavior ────────────────────────────

test('GET /active-staff without include_stubs excludes the legacy CC stub', async () => {
  const r = await req('GET', '/api/admin/active-staff', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const ids = body.staff.map(s => s.id);
  assert.ok(ids.includes(realStaffId), 'real approved staff must appear');
  assert.ok(!ids.includes(stubUserId), 'stub must NOT appear in default response');
});

test('GET /active-staff?include_stubs=true includes the legacy CC stub', async () => {
  const r = await req('GET', '/api/admin/active-staff?include_stubs=true', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const ids = body.staff.map(s => s.id);
  assert.ok(ids.includes(realStaffId), 'real approved staff must still appear');
  assert.ok(ids.includes(stubUserId), 'stub must appear when include_stubs=true');
});

test('GET /active-staff?include_stubs=true as manager redacts stub email', async () => {
  const r = await req('GET', '/api/admin/active-staff?include_stubs=true', managerToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const stub = body.staff.find(s => s.id === stubUserId);
  assert.ok(stub, 'stub row must be present for manager');
  assert.equal(stub.email, '(redacted)', 'manager must see redacted stub email');
  // Non-stub rows still expose email.
  const real = body.staff.find(s => s.id === realStaffId);
  assert.ok(real && real.email && real.email.includes(PREFIX), 'real staff email must NOT be redacted');
});

test('GET /active-staff?include_stubs=true as admin does NOT redact stub email', async () => {
  const r = await req('GET', '/api/admin/active-staff?include_stubs=true', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const stub = body.staff.find(s => s.id === stubUserId);
  assert.ok(stub, 'stub row must be present for admin');
  assert.ok(stub.email && stub.email.includes('@drbartender.local'),
    'admin must see the real stub email, not the redaction placeholder');
  assert.notEqual(stub.email, '(redacted)');
});
