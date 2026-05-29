require('dotenv').config();

// Route-level tests for server/routes/adminCoverSwaps.js (spec section 6.5).
//
// Same hand-rolled harness as staffPortal.test.js / emailChange.test.js:
// stand up a minimal express() app, mount the real router with the real
// auth + role-guard middleware, drive via node's http module + node:test.
//
// JWT helpers craft swap-tokens for the GET / POST URL segment so the
// happy + expired + tampered paths can all exercise the verifier.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const adminCoverSwapsRouter = require('./adminCoverSwaps');

// Shared harness state.
let server;
let baseUrl;
let adminToken;
let adminUserId;
let managerToken;
let managerUserId;
let staffToken;
let staffUserId;
let originalStafferUserId;
let coverStafferUserId;
let clientId;
let proposalId;
let shiftId;
let originalRequestId;
let newRequestId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined)
      ? null
      : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

// Craft a swap-token JWT pointing at two shift_request ids. Mirrors the spec
// section 6.5 payload shape; the route only reads
// `original_request_id` + `new_request_id` from the payload.
function craftSwapToken({ originalId, newId, expiresIn = '7d' }) {
  return jwt.sign(
    {
      original_request_id: originalId,
      new_request_id: newId,
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

before(async () => {
  // Defensive cleanup — strip rows from a prior crashed run. The fixtures use
  // unique nonced emails per run, so cleanup by email pattern is safe.
  await pool.query("DELETE FROM users WHERE email LIKE 'admin-cover-swap-test-%'");
  await pool.query("DELETE FROM clients WHERE email LIKE 'admin-cover-swap-test-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Admin actor.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`admin-cover-swap-test-admin-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = a.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: a.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Manager actor — admin-or-manager guard accepts both.
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'manager', 'approved', 0) RETURNING id, token_version`,
    [`admin-cover-swap-test-manager-${NONCE}@example.com`, passwordHash]
  );
  managerUserId = m.rows[0].id;
  managerToken = jwt.sign(
    { userId: managerUserId, tokenVersion: m.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Regular staff — the non-admin probe identity for the 403 test.
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`admin-cover-swap-test-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Two staff users — the original on the shift, and the cover claimer.
  const origStaff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`admin-cover-swap-test-orig-${NONCE}@example.com`, passwordHash]
  );
  originalStafferUserId = origStaff.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550201', 'Original Bart', 'bartender', 25.00)`,
    [originalStafferUserId]
  );

  const coverStaff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`admin-cover-swap-test-cover-${NONCE}@example.com`, passwordHash]
  );
  coverStafferUserId = coverStaff.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550202', 'Cover Bart', 'bartender', 25.00)`,
    [coverStafferUserId]
  );

  // Client / proposal / shift fixture for the swap rows to reference.
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555552222') RETURNING id",
    [`Admin Cover Swap Test ${NONCE}`, `admin-cover-swap-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES (CURRENT_DATE + 10, '18:00', '22:00', 'open', $1, '999 Lakeshore Dr')
     RETURNING id`,
    [proposalId]
  );
  shiftId = sh.rows[0].id;

  // The original request — has cover_requested_at SET so the "pending"
  // status path is exercised.
  const origReq = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, cover_requested_at, cover_reason)
     VALUES ($1, $2, 'bartender', 'approved', NOW(), 'family emergency')
     RETURNING id`,
    [shiftId, originalStafferUserId]
  );
  originalRequestId = origReq.rows[0].id;

  // The new (claimer) request — status='pending' awaiting admin approval.
  const newReq = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'bartender', 'pending')
     RETURNING id`,
    [shiftId, coverStafferUserId]
  );
  newRequestId = newReq.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', adminCoverSwapsRouter);
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

after(async () => {
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.query(
    "DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)",
    [originalStafferUserId, coverStafferUserId]
  );
  await pool.query(
    "DELETE FROM users WHERE id IN ($1, $2, $3, $4, $5)",
    [adminUserId, managerUserId, staffUserId, originalStafferUserId, coverStafferUserId]
  );
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function resetOriginalCoverFlag() {
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NOW(), cover_reason = 'family emergency' WHERE id = $1",
    [originalRequestId]
  );
}

// ─── Auth-gate tests ─────────────────────────────────────────────────────

test('GET /api/admin/cover-swaps/:swapToken > 401 without JWT', async () => {
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`);
  assert.strictEqual(res.status, 401);
});

test('POST /api/admin/cover-swaps/:swapToken > 401 without JWT', async () => {
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('POST', `/api/admin/cover-swaps/${swap}`);
  assert.strictEqual(res.status, 401);
});

test('GET /api/admin/cover-swaps/:swapToken > 403 for non-admin staff', async () => {
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`, { token: staffToken });
  assert.strictEqual(res.status, 403);
});

test('POST /api/admin/cover-swaps/:swapToken > 403 for non-admin staff', async () => {
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('POST', `/api/admin/cover-swaps/${swap}`, { token: staffToken });
  assert.strictEqual(res.status, 403);
});

// ─── JWT-verification tests ──────────────────────────────────────────────

test('GET /api/admin/cover-swaps/:swapToken > 410 on garbage token', async () => {
  const res = await request('GET', `/api/admin/cover-swaps/not-a-real-jwt`, { token: adminToken });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'expired_or_invalid');
});

test('GET /api/admin/cover-swaps/:swapToken > 410 on JWT signed with wrong key', async () => {
  const wrongKey = `${process.env.JWT_SECRET}-WRONG`;
  const bad = jwt.sign(
    { original_request_id: originalRequestId, new_request_id: newRequestId },
    wrongKey, { expiresIn: '1h' }
  );
  const res = await request('GET', `/api/admin/cover-swaps/${bad}`, { token: adminToken });
  assert.strictEqual(res.status, 410);
});

test('GET /api/admin/cover-swaps/:swapToken > 410 on expired JWT', async () => {
  // expiresIn: -1 makes the token already-expired when jwt.verify runs;
  // jwt.verify throws TokenExpiredError → the verifier returns null → 410.
  const expired = craftSwapToken({
    originalId: originalRequestId, newId: newRequestId, expiresIn: -1,
  });
  const res = await request('GET', `/api/admin/cover-swaps/${expired}`, { token: adminToken });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'expired_or_invalid');
});

// ─── GET happy + idempotency ─────────────────────────────────────────────

test('GET /api/admin/cover-swaps/:swapToken > 200 pending payload for admin', async () => {
  await resetOriginalCoverFlag();
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'pending');
  assert.strictEqual(res.body.original_request?.id, originalRequestId);
  assert.strictEqual(res.body.new_request?.id, newRequestId);
  assert.strictEqual(res.body.shift?.shift_id, shiftId);
  assert.strictEqual(res.body.original_user?.id, originalStafferUserId);
  assert.strictEqual(res.body.new_user?.id, coverStafferUserId);
});

test('GET /api/admin/cover-swaps/:swapToken > 200 pending payload for manager', async () => {
  await resetOriginalCoverFlag();
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`, { token: managerToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'pending');
});

test('GET /api/admin/cover-swaps/:swapToken > 200 already_resolved when cascade has run', async () => {
  // Simulate the cascade clearing cover_requested_at.
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NULL WHERE id = $1",
    [originalRequestId]
  );
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'already_resolved');
});

test('GET /api/admin/cover-swaps/:swapToken > 410 when one of the request ids is gone', async () => {
  await resetOriginalCoverFlag();
  // Reference an id that does not exist alongside a real one.
  const swap = craftSwapToken({ originalId: originalRequestId, newId: 999999999 });
  const res = await request('GET', `/api/admin/cover-swaps/${swap}`, { token: adminToken });
  assert.strictEqual(res.status, 410);
});

// ─── POST: 501 stub (will flip to 200 in Task 25 — note in this test) ───

test('POST /api/admin/cover-swaps/:swapToken > 501 stub until Task 25 cascade lands', async () => {
  // NOTE: This test asserts the 501 stub shape. Task 25 (Phase 5 step 2)
  // wires in the cover-approval cascade; at that point this assertion flips
  // to 200 + the cascade-result payload, and a new test takes over for
  // already_resolved replay.
  await resetOriginalCoverFlag();
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('POST', `/api/admin/cover-swaps/${swap}`, { token: adminToken });
  assert.strictEqual(res.status, 501);
  assert.strictEqual(res.body.status, 'pending_cascade_implementation');
});

test('POST /api/admin/cover-swaps/:swapToken > 410 on expired JWT (same guard as GET)', async () => {
  const expired = craftSwapToken({
    originalId: originalRequestId, newId: newRequestId, expiresIn: -1,
  });
  const res = await request('POST', `/api/admin/cover-swaps/${expired}`, { token: adminToken });
  assert.strictEqual(res.status, 410);
});

test('POST /api/admin/cover-swaps/:swapToken > 200 already_resolved when cascade has run', async () => {
  // Idempotency: a second admin click after a teammate / fellow admin has
  // already triggered the cascade returns already_resolved instead of
  // re-running.
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NULL WHERE id = $1",
    [originalRequestId]
  );
  const swap = craftSwapToken({ originalId: originalRequestId, newId: newRequestId });
  const res = await request('POST', `/api/admin/cover-swaps/${swap}`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'already_resolved');
});
