require('dotenv').config();

// Route-level tests for GET /api/beo/:proposalId and /:proposalId/logo.
//
// HARNESS NOTES
// -------------
// Mirrors the hand-rolled pattern in server/routes/proposals/crud.test.js: the
// repo has no supertest/jest/mocha — every existing route test stands up a
// minimal express() app, mounts the real router, attaches the real auth
// middleware (already inside the router via beo.js's auth call), and drives the
// surface over real HTTP via node's built-in `http` module. The error handler
// mirrors server/index.js so a thrown AppError becomes the right status + JSON.
//
// Tests run against the dev database (DATABASE_URL pulled from ../../os/.env
// via the npm-test-runner's bash prefix). Every row this file inserts is
// cleaned up in after(). User emails are nonce-suffixed so stale rows from a
// crashed prior run can't collide with the unique-index on users.email.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const beoRouter = require('./beo');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let adminToken;
let staffToken;
let otherStaffToken;
let proposalId;
let drinkPlanId;
let shiftId;
let staffUserId;
let otherStaffUserId;
let adminUserId;
let clientId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Belt-and-suspenders: purge any stale rows from a previous crashed run.
  // The unique-key on users.email will reject the inserts below if these still
  // exist with the same address.
  await pool.query("DELETE FROM users WHERE email LIKE 'beo-route-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Admin user
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-admin-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Staff user with approved shift on the test proposal
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name)
     VALUES ($1, '+15555550102', 'Test Staff')`,
    [staffUserId]
  );

  // Other staff user with NO shift — for the 403 case
  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-other-${NONCE}@example.com`, passwordHash]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign(
    { userId: otherStaffUserId, tokenVersion: o.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Client + proposal + drink_plan + shift + approved request
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551111') RETURNING id",
    [`BEO Route Test ${NONCE}`, `beo-route-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // No UNIQUE on drink_plans.proposal_id — check-then-insert to guard against
  // any future auto-create trigger or a leaked row from a prior test run.
  const existingDp = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1', [proposalId]
  );
  if (existingDp.rowCount) {
    drinkPlanId = existingDp.rows[0].id;
    await pool.query(
      "UPDATE drink_plans SET status = 'reviewed', selections = '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb WHERE id = $1",
      [drinkPlanId]
    );
  } else {
    const dp = await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, selections)
       VALUES ($1, 'reviewed', '{"signatureDrinks":["sd_1"]}'::jsonb) RETURNING id`,
      [proposalId]
    );
    drinkPlanId = dp.rows[0].id;
  }

  const sh = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, staffUserId]
  );

  // Minimal app: real router + AppError-aware error handler matching server/index.js.
  const app = express();
  app.use(express.json());
  app.use('/api/beo', beoRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id = $1", [staffUserId]);
  await pool.query(
    "DELETE FROM users WHERE id IN ($1, $2, $3)",
    [adminUserId, staffUserId, otherStaffUserId]
  );
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

test('GET /api/beo/:proposalId > 404 for missing proposal', async () => {
  const res = await request('GET', '/api/beo/99999999', { token: staffToken });
  assert.strictEqual(res.status, 404);
});

test('GET /api/beo/:proposalId > admin always allowed', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.proposal.id, proposalId);
  assert.strictEqual(res.body.drink_plan.id, drinkPlanId);
  assert.strictEqual(res.body.viewer.is_admin, true);
  // Token MUST NOT leak — leaking it would hand a bartender client-portal access.
  assert.ok(!('token' in (res.body.drink_plan || {})), 'drink_plan.token must not appear in response');
});

test('GET /api/beo/:proposalId > staff with approved shift allowed', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.viewer.is_admin, false);
});

test('GET /api/beo/:proposalId > staff without shift 403', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: otherStaffToken });
  assert.strictEqual(res.status, 403);
});

test('GET /api/beo/:proposalId > staff on cancelled shift 403', async () => {
  await pool.query("UPDATE shifts SET status='cancelled' WHERE id=$1", [shiftId]);
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  assert.strictEqual(res.status, 403);
  await pool.query("UPDATE shifts SET status='open' WHERE id=$1", [shiftId]);
});

// ─── POST /api/beo/:proposalId/acknowledge ─────────────────────────────────
//
// Test order is load-bearing: the 200 case sets finalized_at, the admin-noop
// case can run with finalized_at either way, and the 409 case explicitly
// re-NULLs finalized_at. Each test resets state it mutated so a re-run in a
// different order would still pass.

test('POST /api/beo/:proposalId/acknowledge > staff stamps beo_acknowledged_at when finalized', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NOW() WHERE id = $1', [drinkPlanId]);
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, true);
  assert.ok(res.body.beo_acknowledged_at);
  const { rows } = await pool.query(
    'SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
    [shiftId, staffUserId]
  );
  assert.ok(rows[0].beo_acknowledged_at);
  // Reset for the next test so the admin no-op case starts clean.
  await pool.query(
    'UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2',
    [shiftId, staffUserId]
  );
});

test('POST /api/beo/:proposalId/acknowledge > admin returns 200 with acknowledged:false', async () => {
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, false);
});

test('POST /api/beo/:proposalId/acknowledge > 409 when not finalized', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NULL WHERE id = $1', [drinkPlanId]);
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: staffToken });
  assert.strictEqual(res.status, 409);
});
