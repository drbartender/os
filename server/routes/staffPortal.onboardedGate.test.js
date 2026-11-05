'use strict';
// The onboarding gate on the /api/me routers and the cover claim (audit
// 2026-11-05 AUTH-01 and AUTH-11).
//
// POST /api/auth/register is PUBLIC and mints a live JWT for a
// `role='staff', onboarding_status='in_progress'` row, and `auth()` lets that
// row through. Every /api/me route is a staff-data surface (the home payload
// carries other staffers' email addresses and client names; the rest is the
// caller's own staff record), and no onboarding page calls any of them, so the
// two routers gate router-wide with requireOnboarded and the cover claim gates
// at the route. This suite drives the REAL routers over real HTTP against a
// stubbed pool (the `pool.query = ...` seam sms.status.test.js and
// clientPortal.test.js use), so it runs without a database: the stub answers
// the auth lookup from a fixture map and every other query with no rows.
//
// What fails on the old code: the applicant's GET /staff-home came back 200
// with the handler's queries on the wire.

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'onboarded-gate-test-secret-0123456789abcdef';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

// The rows auth() reads. Status is what the gate keys on; the rest is the
// column list auth() selects, so req.user has the shape the handlers expect.
const base = { can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const USERS = {
  1: { id: 1, email: 'gate-applicant@example.com', role: 'staff', onboarding_status: 'in_progress', ...base },
  2: { id: 2, email: 'gate-approved@example.com', role: 'staff', onboarding_status: 'approved', ...base },
  3: { id: 3, email: 'gate-admin@example.com', role: 'admin', onboarding_status: 'in_progress', ...base },
};

// Every query text the stub saw since the last reset, so a test can tell a
// request that stopped at the gate (auth lookup only) from one that reached
// its handler.
let seen = [];
const realQuery = pool.query;
const realConnect = pool.connect;

function answer(text, params) {
  seen.push(text);
  if (text.includes('FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (text.includes('COUNT(*)::int AS n')) return { rows: [{ n: 0 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

let server;
let baseUrl;
const mint = (id) => jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(new URL(path, baseUrl), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(String(text), params || []));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(String(text), params || [])),
    release() {},
  });

  const app = express();
  app.use(express.json());
  // The mount order of server/index.js: me.js, mePush.js, then staffPortal.js.
  app.use('/api/me', require('./me'));
  app.use('/api/me', require('./mePush'));
  app.use('/api/me', require('./staffPortal'));
  app.use('/api/shifts', require('./staffShiftActions'));
  // The repo's global handler is inline in server/index.js; a route harness
  // writes its own (mePush.test.js verbatim).
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

// Every route the two /api/me routers own, plus the cover claim. A new route on
// either router is gated by construction (router.use), so this list is the
// inventory the gate is checked against, not the mechanism.
const GATED = [
  ['GET', '/api/me/staff-home'],
  ['GET', '/api/me/payment-methods'],
  ['PATCH', '/api/me/payment-methods', { venmo_handle: 'x' }],
  ['PUT', '/api/me/preferred-payment-method', { method: 'check' }],
  ['GET', '/api/me/payouts'],
  ['GET', '/api/me/payment-history'],
  ['GET', '/api/me/payouts/1'],
  ['GET', '/api/me/payouts/1/paystub'],
  ['GET', '/api/me/profile'],
  ['PATCH', '/api/me/profile', { phone: '5555550100' }],
  ['GET', '/api/me/calendar-settings'],
  ['GET', '/api/me/documents'],
  ['POST', '/api/me/documents/headshot/replace'],
  ['PUT', '/api/me/tip-card-order', { order: ['card'] }],
  ['GET', '/api/me/ui-preferences'],
  ['PATCH', '/api/me/ui-preferences', { theme: 'dark' }],
  ['GET', '/api/me/staff-notifications'],
  ['PATCH', '/api/me/staff-notifications', { email: {} }],
  ['POST', '/api/me/push-subscriptions', {}],
  ['DELETE', '/api/me/push-subscriptions', { endpoint: 'https://push.example.test/x' }],
  ['POST', '/api/me/request-email-change', { new_email: 'someone-else@example.com' }],
  ['POST', '/api/me/cancel-pending-email-change'],
  ['GET', '/api/me/tip-page'],
  ['PATCH', '/api/me/tip-page', { venmo_handle: 'x' }],
  ['GET', '/api/me/tips'],
  ['GET', '/api/me/notification-preferences'],
  ['PATCH', '/api/me/notification-preferences', { feedback: false }],
  ['POST', '/api/shifts/requests/1/claim-cover'],
];

test('a self-registered (in_progress) account is refused on every /api/me route and the cover claim, before any handler query', async () => {
  for (const [method, path, body] of GATED) {
    seen = [];
    const res = await request(method, path, { token: mint(1), body });
    assert.equal(res.status, 403, `${method} ${path}: expected 403, got ${res.status} ${res.raw}`);
    assert.equal(res.body.code, 'PERMISSION_DENIED', `${method} ${path}: code`);
    // The auth lookup is the only query a gated request may make.
    assert.deepEqual(
      seen.filter((t) => !t.includes('FROM users WHERE id = $1')), [],
      `${method} ${path}: a handler query ran for a non-onboarded account`
    );
  }
});

test('GET /staff-home still reaches its handler for an approved staffer', async () => {
  seen = [];
  const res = await request('GET', '/api/me/staff-home', { token: mint(2) });
  assert.equal(res.status, 200, res.raw);
  assert.ok(seen.some((t) => t.includes('cover_requested_at')), 'the cover-broadcast query ran');
  assert.deepEqual(res.body.cover_broadcasts, []);
  assert.equal(res.body.open_shifts_count, 0);
});

test('the cover claim still reaches its handler for an approved staffer (409 on no cover request, not 403)', async () => {
  seen = [];
  const res = await request('POST', '/api/shifts/requests/1/claim-cover', { token: mint(2) });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'no_active_cover_request');
  assert.ok(seen.some((t) => t.includes('cover_requested_at IS NOT NULL')), 'the cover lookup ran');
});

test('an admin passes the gate whatever its onboarding_status (the mobile admin reads /api/me)', async () => {
  seen = [];
  let res = await request('GET', '/api/me/notification-preferences', { token: mint(3) });
  assert.equal(res.status, 200, res.raw);
  res = await request('GET', '/api/me/staff-home', { token: mint(3) });
  assert.equal(res.status, 200, res.raw);
});

test('an unknown or missing token is still 401, not 403', async () => {
  let res = await request('GET', '/api/me/staff-home');
  assert.equal(res.status, 401);
  res = await request('GET', '/api/me/staff-home', { token: mint(99) });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'USER_NOT_FOUND');
});
