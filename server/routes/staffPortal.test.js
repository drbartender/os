require('dotenv').config();

// Route-level tests for server/routes/staffPortal.js.
//
// HARNESS NOTES
// -------------
// Mirrors the pattern in server/routes/beo.test.js and crud.test.js: there is
// no supertest/jest/mocha in this repo. Each suite stands up a minimal
// express() app, mounts the real router with the real auth middleware (already
// inside the router), and an AppError-aware error handler that mirrors
// server/index.js. Driven via node's built-in http module.
//
// The same harness is reused across tasks 12 to 17 — every test calls the same
// `request()` helper. Tests run against the dev database (DATABASE_URL pulled
// from ../../os/.env via the bash test prefix).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const staffPortalRouter = require('./staffPortal');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let staffToken;
let staffUserId;
let otherStaffToken;
let otherStaffUserId;
let proposalId;
let clientId;
let shiftId;
let payPeriodId;
let payoutId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// ─── HTTP helper ────────────────────────────────────────────────────────────
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

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Defensive cleanup — purge any rows left behind by a prior crashed run.
  await pool.query("DELETE FROM users WHERE email LIKE 'staff-portal-test-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Primary staff user — the one whose payloads we mostly inspect.
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`staff-portal-test-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550101', 'Test Staff', 'bartender', 25.00)`,
    [staffUserId]
  );

  // Second staff user — for IDOR + cover-broadcast tests.
  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`staff-portal-test-other-${NONCE}@example.com`, passwordHash]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign(
    { userId: otherStaffUserId, tokenVersion: o.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550102', 'Other Staff', 'bartender', 25.00)`,
    [otherStaffUserId]
  );

  // Client, proposal, drink_plan, shift, shift_request.
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551111') RETURNING id",
    [`Staff Portal Test ${NONCE}`, `staff-portal-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                             event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 14, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, finalized_at)
     VALUES ($1, 'reviewed', '{}'::jsonb, NOW())`,
    [proposalId]
  );
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES (CURRENT_DATE + 14, '18:00', '22:00', 'open', $1, '123 Main St')
     RETURNING id`,
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'approved', 'bartender')`,
    [shiftId, staffUserId]
  );

  // Pay period spanning today, plus an empty payout row so /staff-home returns
  // a meaningful current_period block.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES (CURRENT_DATE - 3, CURRENT_DATE + 10, CURRENT_DATE + 14, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`
  );
  payPeriodId = pp.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, total_cents)
     VALUES ($1, $2, 12345)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [payPeriodId, staffUserId]
  );
  payoutId = po.rows[0].id;

  // Minimal app: real router + AppError-aware error handler matching server/index.js.
  // express-fileupload mounted so multipart tests (Task 16) get a parsed
  // req.files; mirrors the dev server's middleware order.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }));
  app.use('/api/me', staffPortalRouter);
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
  await pool.query("DELETE FROM staff_audit_log WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM staff_document_history WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM pending_email_changes WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM payment_profiles WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM payout_events WHERE payout_id = $1", [payoutId]);
  await pool.query("DELETE FROM payouts WHERE id = $1", [payoutId]);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Task 12: GET /api/me/staff-home ────────────────────────────────────────

test('GET /api/me/staff-home > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/staff-home');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/staff-home > composite payload shape', async () => {
  const res = await request('GET', '/api/me/staff-home', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body, 'has body');
  assert.ok('next_shift' in res.body);
  assert.ok('pending_requests' in res.body);
  assert.ok('cover_broadcasts' in res.body);
  assert.ok('current_period' in res.body);
  assert.ok('open_shifts_teaser' in res.body);
  // Next shift should resolve to the row we seeded.
  assert.strictEqual(res.body.next_shift?.shift_id, shiftId);
  assert.strictEqual(res.body.next_shift?.proposal_id, proposalId);
  // BEO finalized_at projected, ack still null
  assert.ok(res.body.next_shift?.drink_plan_finalized_at);
  assert.strictEqual(res.body.next_shift?.beo_acknowledged_at, null);
  // Current pay-period projection includes the seeded payout total.
  assert.strictEqual(res.body.current_period?.total_cents, 12345);
  assert.ok(Array.isArray(res.body.open_shifts_teaser));
  assert.strictEqual(res.body.open_shifts_teaser.length, 0);
});

test('GET /api/me/staff-home > IDOR: other user sees empty next_shift', async () => {
  // otherStaff has no approved request on the seeded shift, so the next_shift
  // query should return no row for them.
  const res = await request('GET', '/api/me/staff-home', { token: otherStaffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.next_shift, null);
  // And no current-period payout row for them either.
  assert.ok(res.body.current_period === null || res.body.current_period.payout_id === null);
});

test('GET /api/me/staff-home > cover broadcasts surface for teammates only', async () => {
  // Set staff's request to cover_requested. otherStaff should see it; staff
  // (the requester) should NOT (cover_broadcasts filters requester != viewer).
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NOW(), cover_reason = 'sick' WHERE shift_id = $1 AND user_id = $2",
    [shiftId, staffUserId]
  );

  const resOther = await request('GET', '/api/me/staff-home', { token: otherStaffToken });
  assert.strictEqual(resOther.status, 200);
  const broadcast = resOther.body.cover_broadcasts.find((b) => b.shift_id === shiftId);
  assert.ok(broadcast, 'other staff sees the cover broadcast');
  assert.strictEqual(broadcast.requester_id, staffUserId);
  assert.strictEqual(broadcast.you_are_on_team, false);

  const resSelf = await request('GET', '/api/me/staff-home', { token: staffToken });
  const selfBroadcast = resSelf.body.cover_broadcasts.find((b) => b.shift_id === shiftId);
  assert.ok(!selfBroadcast, 'requester does not see their own broadcast');

  // Reset.
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NULL, cover_reason = NULL WHERE shift_id = $1 AND user_id = $2",
    [shiftId, staffUserId]
  );
});
