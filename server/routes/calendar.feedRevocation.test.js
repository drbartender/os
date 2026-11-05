// The calendar feed is revoked by account status, and deactivation rotates the
// feed token (audit 2026-11-05 AUTH-03).
//
// HARNESS NOTES
// -------------
// Mirrors calendar.description.test.js: the real calendar router and the real
// admin users router on a fresh express() app with the AppError-aware error
// handler of server/index.js, driven over real HTTP against the dev DB
// (DATABASE_URL from .env). It creates an admin and a manager (`.invalid`
// addresses, so the status-change email short-circuits in utils/email.js) and
// purges both, with the audit rows the status route writes, in after(). The
// pure companion is calendar.feedStatus.test.js.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

let server;
let baseUrl;
let adminToken;
let managerId;
let firstFeedToken;
const created = { userIds: [] };

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
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
        res.on('end', () => resolve({ status: res.statusCode, raw: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const tokenOf = async (id) => (await pool.query('SELECT calendar_token FROM users WHERE id = $1', [id])).rows[0].calendar_token;

before(async () => {
  const uniq = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const adminRes = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version`,
    [`calrevoke-admin+${uniq}@example.invalid`]
  );
  created.userIds.push(adminRes.rows[0].id);
  adminToken = jwt.sign(
    { userId: adminRes.rows[0].id, tokenVersion: adminRes.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  // The manager whose calendar app holds the feed URL (calendar_token defaults
  // to gen_random_uuid()).
  const mgr = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'manager', 'approved', 0) RETURNING id, calendar_token`,
    [`calrevoke-manager+${uniq}@example.invalid`]
  );
  managerId = mgr.rows[0].id;
  firstFeedToken = mgr.rows[0].calendar_token;
  created.userIds.push(managerId);

  const app = express();
  app.use(express.json());
  app.use('/api/calendar', require('./calendar'));
  app.use('/api/admin', require('./admin/users'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (created.userIds.length) {
    await pool.query('DELETE FROM interview_notes WHERE user_id = ANY($1) OR admin_id = ANY($1)', [created.userIds]);
    await pool.query('DELETE FROM application_activity WHERE user_id = ANY($1) OR actor_id = ANY($1)', [created.userIds]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [created.userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.userIds]);
  }
  await pool.end();
});

test('an active manager\'s feed answers 200', async () => {
  const res = await request('GET', `/api/calendar/feed/${firstFeedToken}`);
  assert.equal(res.status, 200, res.raw);
});

test('deactivation rotates calendar_token and the feed refuses both the old URL and the fresh token', async () => {
  const res = await request('PUT', `/api/admin/users/${managerId}/status`, { token: adminToken, body: { status: 'deactivated' } });
  assert.equal(res.status, 200, res.raw);
  const fresh = await tokenOf(managerId);
  assert.notEqual(fresh, firstFeedToken, 'calendar_token rotated in the status UPDATE');
  assert.equal((await request('GET', `/api/calendar/feed/${firstFeedToken}`)).status, 404, 'the subscribed URL is dead');
  assert.equal((await request('GET', `/api/calendar/feed/${fresh}`)).status, 404, 'a deactivated account has no feed at all');
});

test('re-activation serves the feed only under the fresh token; the old URL stays dead', async () => {
  const res = await request('PUT', `/api/admin/users/${managerId}/status`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(res.status, 200, res.raw);
  const fresh = await tokenOf(managerId);
  assert.notEqual(fresh, firstFeedToken, 'an ordinary status change does not hand the old token back');
  assert.equal((await request('GET', `/api/calendar/feed/${firstFeedToken}`)).status, 404);
  assert.equal((await request('GET', `/api/calendar/feed/${fresh}`)).status, 200);
});
