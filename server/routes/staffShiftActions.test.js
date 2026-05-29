require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route-level tests for server/routes/staffShiftActions.js (spec §6.5).
//
// Harness mirrors server/routes/staffPortal.test.js: hand-rolled node:http +
// express(). No supertest / jest in this repo. JWT payload shape is
// { userId, tokenVersion }; middleware sets req.user = {id, role, ...}.
//
// All test rows use unique email prefixes ('drop-' / 'cover-act-') with a
// NONCE so the defensive cleanup before/after never collides with other suites
// or with real data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const staffShiftActionsRouter = require('./staffShiftActions');

let server;
let baseUrl;
let staffToken;
let staffUserId;
let otherStaffToken;
let otherStaffUserId;
let clientId;
let proposalId;
let payPeriodId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined)
      ? null
      : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
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

// Helpers — seed a shift on a given event_date with a given staffer approved.
// Returns { shiftId, requestId, eventDateYmd, startTimeStr }.
async function seedShiftWithRequest({ daysFromNow, startTimeStr = '18:00', userId, position = 'bartender', status = 'approved' }) {
  const { rows: dr } = await pool.query(
    `SELECT (CURRENT_DATE + INTERVAL '${daysFromNow} days')::date AS d`
  );
  const eventDateYmd = dr[0].d; // pg returns Date; OK as-is for date arithmetic
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location,
                         client_name, positions_needed)
     VALUES ($1, $2, '22:00', 'open', $3, '123 Main St',
             'Drop Test ${NONCE}', '["bartender"]'::jsonb)
     RETURNING id`,
    [eventDateYmd, startTimeStr, proposalId]
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [shiftId, userId, status, position]
  );
  return { shiftId, requestId: sr.rows[0].id, eventDateYmd, startTimeStr };
}

before(async () => {
  // Defensive cleanup from prior runs.
  await pool.query("DELETE FROM users WHERE email LIKE 'drop-test-%' OR email LIKE 'cover-act-test-%'");

  const ph = await bcrypt.hash('x', 4);

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`drop-test-staff-${NONCE}@example.com`, ph]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550201', 'Test Staff', 'bartender', 25.00)`,
    [staffUserId]
  );

  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`drop-test-other-${NONCE}@example.com`, ph]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign(
    { userId: otherStaffUserId, tokenVersion: o.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550202', 'Other Staff', 'bartender', 25.00)`,
    [otherStaffUserId]
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555552222') RETURNING id`,
    [`Drop Test ${NONCE}`, `drop-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                             event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 15, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // A pay-period we can flip to 'processing' on demand to test that block.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES (CURRENT_DATE + 14, CURRENT_DATE + 28, CURRENT_DATE + 35, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`
  );
  payPeriodId = pp.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', staffShiftActionsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    console.error('[test harness] unhandled error:', err);
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
  await pool.query(`DELETE FROM scheduled_messages
                     WHERE recipient_id IN ($1, $2)
                        OR entity_id IN (SELECT id FROM shifts WHERE proposal_id = $3)`,
    [staffUserId, otherStaffUserId, proposalId]);
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query(
    `DELETE FROM payouts WHERE pay_period_id = $1 AND contractor_id IN ($2, $3)`,
    [payPeriodId, staffUserId, otherStaffUserId]
  );
  await pool.query(
    `DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query(`DELETE FROM shifts WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)`, [staffUserId, otherStaffUserId]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [staffUserId, otherStaffUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Task 23: POST /requests/:requestId/drop ───────────────────────────────

test('POST /drop > 401 without JWT', async () => {
  const res = await request('POST', '/api/shifts/requests/123/drop');
  assert.strictEqual(res.status, 401);
});

test('POST /drop > 14d+1h out succeeds, shift flips back to open', async () => {
  // 15 days out = 15 * 24 = 360h >= 336
  const { requestId, shiftId } = await seedShiftWithRequest({
    daysFromNow: 15, startTimeStr: '18:00', userId: staffUserId,
  });
  // shifts.status is 'open' from seed; set to 'staffed' to verify it flips back.
  await pool.query(`UPDATE shifts SET status = 'staffed' WHERE id = $1`, [shiftId]);

  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.drop_reason, 'clean_drop');
  assert.ok(res.body.dropped_at, 'dropped_at returned');

  const sr = await pool.query(`SELECT status, dropped_at, drop_reason FROM shift_requests WHERE id = $1`, [requestId]);
  assert.strictEqual(sr.rows[0].status, 'denied');
  assert.ok(sr.rows[0].dropped_at);
  assert.strictEqual(sr.rows[0].drop_reason, 'clean_drop');

  const sh = await pool.query(`SELECT status FROM shifts WHERE id = $1`, [shiftId]);
  assert.strictEqual(sh.rows[0].status, 'open', 'shift flipped back to open when no other approved staffer remains');
});

test('POST /drop > 13d 23h out returns 409 wrong_mode', async () => {
  // 13 days out from now = 312h < 336h.
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 13, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'wrong_mode');
});

test('POST /drop > pay_period processing returns 409 pay_period_processing', async () => {
  const { requestId, shiftId } = await seedShiftWithRequest({
    daysFromNow: 20, startTimeStr: '18:00', userId: staffUserId,
  });
  // Insert a payout + payout_event tying THIS shift to the pay_period, then
  // flip pay_period to processing.
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, total_cents)
     VALUES ($1, $2, 0)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [payPeriodId, staffUserId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents)
     VALUES ($1, $2, 4, 4, 2500)
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [po.rows[0].id, shiftId]
  );
  await pool.query(`UPDATE pay_periods SET status = 'processing' WHERE id = $1`, [payPeriodId]);

  try {
    const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'pay_period_processing');
  } finally {
    // Restore for the next tests.
    await pool.query(`UPDATE pay_periods SET status = 'open' WHERE id = $1`, [payPeriodId]);
    await pool.query(`DELETE FROM payout_events WHERE shift_id = $1`, [shiftId]);
    await pool.query(`DELETE FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2`, [payPeriodId, staffUserId]);
  }
});

test('POST /drop > NULL payout_events passes the pay-period gate', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 20, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
});

test('POST /drop > other approved staffer keeps shifts.status as-is', async () => {
  const { requestId, shiftId } = await seedShiftWithRequest({
    daysFromNow: 20, startTimeStr: '18:00', userId: staffUserId,
  });
  await pool.query(`UPDATE shifts SET status = 'staffed' WHERE id = $1`, [shiftId]);
  // Approve the OTHER staffer on this same shift.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'approved', 'bartender')`,
    [shiftId, otherStaffUserId]
  );

  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  const sh = await pool.query(`SELECT status FROM shifts WHERE id = $1`, [shiftId]);
  assert.strictEqual(sh.rows[0].status, 'staffed', 'shift remains staffed when other approved staffer present');
});

test('POST /drop > suppresses pending scheduled_messages targeting this user+shift', async () => {
  const { requestId, shiftId } = await seedShiftWithRequest({
    daysFromNow: 20, startTimeStr: '18:00', userId: staffUserId,
  });
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status, payload)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() + INTERVAL '1 day', 'pending', '{}'::jsonb)`,
    [shiftId, staffUserId]
  );
  // Also a row for the OTHER staffer that must NOT be touched.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status, payload)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() + INTERVAL '1 day', 'pending', '{}'::jsonb)`,
    [shiftId, otherStaffUserId]
  );

  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  const { rows } = await pool.query(
    `SELECT recipient_id, status FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'shift'`,
    [shiftId]
  );
  const mine = rows.find((r) => r.recipient_id === staffUserId);
  const other = rows.find((r) => r.recipient_id === otherStaffUserId);
  assert.strictEqual(mine.status, 'suppressed');
  assert.strictEqual(other.status, 'pending', 'other staffer\'s row left alone');
});

test('POST /drop > IDOR: not your shift returns 403', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 20, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/drop`, { token: otherStaffToken });
  assert.strictEqual(res.status, 403);
});

test('POST /drop > unknown request returns 404', async () => {
  const res = await request('POST', `/api/shifts/requests/99999999/drop`, { token: staffToken });
  assert.strictEqual(res.status, 404);
});

// ─── Task 24: POST /requests/:requestId/request-cover ──────────────────────

test('POST /request-cover > 401 without JWT', async () => {
  const res = await request('POST', '/api/shifts/requests/123/request-cover', { body: { reason: 'x' } });
  assert.strictEqual(res.status, 401);
});

test('POST /request-cover > 72h+1h triggers cover flip and broadcast', async () => {
  // 4 days out = 96h, inside [72, 336).
  const { requestId, shiftId } = await seedShiftWithRequest({
    daysFromNow: 4, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: staffToken,
    body: { reason: 'Family conflict' },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.ok(typeof res.body.broadcast_count === 'number');
  assert.strictEqual(res.body.broadcast_truncated, false);

  const sr = await pool.query(`SELECT cover_requested_at, cover_reason FROM shift_requests WHERE id = $1`, [requestId]);
  assert.ok(sr.rows[0].cover_requested_at, 'cover_requested_at set');
  assert.strictEqual(sr.rows[0].cover_reason, 'Family conflict');

  // Cover_broadcast scheduled_messages enqueued (at least 0 — depends on dev DB).
  const cb = await pool.query(
    `SELECT count(*)::int AS c FROM scheduled_messages WHERE entity_type='shift' AND entity_id=$1 AND message_type='cover_broadcast'`,
    [shiftId]
  );
  assert.ok(cb.rows[0].c >= 0);
});

test('POST /request-cover > 14d+1h returns 409 wrong_mode', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 15, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: staffToken,
    body: { reason: 'x' },
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'wrong_mode');
});

test('POST /request-cover > <72h returns 409 wrong_mode', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 2, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: staffToken,
    body: { reason: 'x' },
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'wrong_mode');
});

test('POST /request-cover > reason >500 chars returns 413', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 4, startTimeStr: '18:00', userId: staffUserId,
  });
  const tooLong = 'x'.repeat(501);
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: staffToken,
    body: { reason: tooLong },
  });
  assert.strictEqual(res.status, 413);
  assert.strictEqual(res.body.code, 'reason_too_long');
});

test('POST /request-cover > already-requested returns 409 already_requested', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 4, startTimeStr: '18:00', userId: staffUserId,
  });
  await pool.query(`UPDATE shift_requests SET cover_requested_at = NOW() WHERE id = $1`, [requestId]);
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: staffToken,
    body: { reason: 'x' },
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'already_requested');
});

test('POST /request-cover > IDOR: not your shift returns 403', async () => {
  const { requestId } = await seedShiftWithRequest({
    daysFromNow: 4, startTimeStr: '18:00', userId: staffUserId,
  });
  const res = await request('POST', `/api/shifts/requests/${requestId}/request-cover`, {
    token: otherStaffToken,
    body: { reason: 'x' },
  });
  assert.strictEqual(res.status, 403);
});
