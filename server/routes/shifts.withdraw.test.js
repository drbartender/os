require('dotenv').config();
process.env.NODE_ENV = 'test';

// Tests for DELETE /api/shifts/requests/:requestId (Task 27 withdraw flow).
// The route lives in server/routes/shifts.js (extended; not in
// staffShiftActions.js) because the existing handler was already mounted
// and role-aware — we tightened the staff path to require status='pending'
// while leaving admin/manager unrestricted. Harness mirrors
// staffShiftActions.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const shiftsRouter = require('./shifts');

let server;
let baseUrl;
let staffToken;
let staffUserId;
let otherStaffToken;
let otherStaffUserId;
let adminToken;
let adminUserId;
let clientId;
let proposalId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null || body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedRequest({ status = 'pending', userId }) {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 10, '18:00', '22:00', 'open', $1, '123 Main', 'Withdraw Test ${NONCE}', '["bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, $3, 'bartender')
     RETURNING id`,
    [sh.rows[0].id, userId, status]
  );
  return { shiftId: sh.rows[0].id, requestId: sr.rows[0].id };
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'withdraw-test-%'");
  const ph = await bcrypt.hash('x', 4);

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`withdraw-test-staff-${NONCE}@example.com`, ph]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign({ userId: staffUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550301', 'Withdraw Staff', 'bartender', 25.00)`,
    [staffUserId]
  );

  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`withdraw-test-other-${NONCE}@example.com`, ph]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign({ userId: otherStaffUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550302', 'Other Withdraw', 'bartender', 25.00)`,
    [otherStaffUserId]
  );

  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`withdraw-test-admin-${NONCE}@example.com`, ph]
  );
  adminUserId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555553333') RETURNING id`,
    [`Withdraw Test ${NONCE}`, `withdraw-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    console.error('[withdraw harness] unhandled error:', err);
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
  await pool.query(
    `DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query(`DELETE FROM shifts WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)`, [staffUserId, otherStaffUserId]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [staffUserId, otherStaffUserId, adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('DELETE /requests/:id > 401 without JWT', async () => {
  const res = await request('DELETE', '/api/shifts/requests/1');
  assert.strictEqual(res.status, 401);
});

test('DELETE /requests/:id > staff withdraws pending request successfully', async () => {
  const { requestId } = await seedRequest({ status: 'pending', userId: staffUserId });
  const res = await request('DELETE', `/api/shifts/requests/${requestId}`, { token: staffToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);

  const sr = await pool.query(`SELECT id FROM shift_requests WHERE id = $1`, [requestId]);
  assert.strictEqual(sr.rows.length, 0, 'row deleted');
});

test('DELETE /requests/:id > staff cannot withdraw approved request (409 already_approved)', async () => {
  const { requestId } = await seedRequest({ status: 'approved', userId: staffUserId });
  const res = await request('DELETE', `/api/shifts/requests/${requestId}`, { token: staffToken });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'already_approved');
  const sr = await pool.query(`SELECT id FROM shift_requests WHERE id = $1`, [requestId]);
  assert.strictEqual(sr.rows.length, 1, 'row NOT deleted');
});

test('DELETE /requests/:id > staff cannot withdraw denied request (409 already_denied)', async () => {
  const { requestId } = await seedRequest({ status: 'denied', userId: staffUserId });
  const res = await request('DELETE', `/api/shifts/requests/${requestId}`, { token: staffToken });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'already_denied');
});

test('DELETE /requests/:id > IDOR: not your request returns 403', async () => {
  const { requestId } = await seedRequest({ status: 'pending', userId: staffUserId });
  const res = await request('DELETE', `/api/shifts/requests/${requestId}`, { token: otherStaffToken });
  assert.strictEqual(res.status, 403);
});

test('DELETE /requests/:id > admin can delete approved request (unrestricted)', async () => {
  const { requestId } = await seedRequest({ status: 'approved', userId: staffUserId });
  const res = await request('DELETE', `/api/shifts/requests/${requestId}`, { token: adminToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
});

test('DELETE /requests/:id > unknown request returns 404', async () => {
  const res = await request('DELETE', `/api/shifts/requests/99999999`, { token: staffToken });
  assert.strictEqual(res.status, 404);
});

// ─── Task 28: GET /api/shifts projection ────────────────────────────────────

test('GET /api/shifts > staff path projects cover_requested_at + cover_for_first_initial', async () => {
  // Seed: a cover-requesting approved row by otherStaffUser on an OPEN shift
  // visible to the staffUser (any open future shift qualifies). Both rows must
  // be on the SAME shift, since the LATERAL subquery filters by shift_id.
  const shRow = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', $1, '123 Main', 'Projection Test ${NONCE}', '["bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  const projectionShiftId = shRow.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, cover_requested_at, cover_reason)
     VALUES ($1, $2, 'approved', 'bartender', NOW(), 'test')`,
    [projectionShiftId, otherStaffUserId]
  );

  const res = await request('GET', '/api/shifts', { token: staffToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const projected = res.body.find((row) => row.id === projectionShiftId);
  assert.ok(projected, 'shift visible in staff /api/shifts response');
  assert.ok(projected.cover_requested_at, 'cover_requested_at projected');
  // otherStaffUser's preferred_name is 'Other Withdraw' — first initial is 'O'.
  assert.strictEqual(projected.cover_for_first_initial, 'O');
  // drink_plan_finalized_at projection (already shipped) still works alongside.
  assert.ok('drink_plan_finalized_at' in projected);
  assert.ok('my_beo_acknowledged_at' in projected);
});

test('GET /api/shifts/user/:userId/events > IDOR: another user returns 403', async () => {
  // staff can only see their own user history.
  const res = await request('GET', `/api/shifts/user/${otherStaffUserId}/events`, { token: staffToken });
  assert.strictEqual(res.status, 403);
});

test('GET /api/shifts/user/:userId/events > admin can view anyone\'s history', async () => {
  const res = await request('GET', `/api/shifts/user/${staffUserId}/events`, { token: adminToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  // Shape check — payload has upcoming + past arrays per the existing handler.
  assert.ok(Array.isArray(res.body.upcoming));
  assert.ok(Array.isArray(res.body.past));
});

test('GET /api/shifts/user/:userId/events > projects payout_id when payout_events exist', async () => {
  // Seed an approved shift_request in the past for staffUser, with payout +
  // payout_event linking it. The handler partitions by today's date so a
  // past event lands in res.body.past.
  const shRow = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location, client_name, positions_needed)
     VALUES (CURRENT_DATE - 7, '18:00', '22:00', 'staffed', $1, '123 Main', 'Past Test ${NONCE}', '["bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  const pastShiftId = shRow.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'approved', 'bartender')`,
    [pastShiftId, staffUserId]
  );
  // Pay period + payout + payout_event so payout_id is projected.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES (CURRENT_DATE - 14, CURRENT_DATE - 1, CURRENT_DATE + 1, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`
  );
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, total_cents) VALUES ($1, $2, 10000)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [pp.rows[0].id, staffUserId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents)
     VALUES ($1, $2, 4, 4, 2500)
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [po.rows[0].id, pastShiftId]
  );

  try {
    const res = await request('GET', `/api/shifts/user/${staffUserId}/events`, { token: staffToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const past = res.body.past.find((r) => r.id === pastShiftId);
    assert.ok(past, 'past row visible');
    assert.strictEqual(past.payout_id, po.rows[0].id, 'payout_id projected');
  } finally {
    await pool.query(`DELETE FROM payout_events WHERE shift_id = $1`, [pastShiftId]);
    await pool.query(`DELETE FROM payouts WHERE id = $1`, [po.rows[0].id]);
    await pool.query(`DELETE FROM pay_periods WHERE id = $1`, [pp.rows[0].id]);
  }
});
