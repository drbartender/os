require('dotenv').config();

// Route-level tests for GET /api/admin/staff-hub/summary (server/routes/admin/staffHub.js).
// Harness mirrors settings.badgeCounts.test.js: real router + real auth middleware
// on a minimal express app, driven over node:http.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const staffHubRouter = require('./staffHub');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PREFIX = 'staff-hub-test-';

let server;
let baseUrl;
let adminToken;
let managerToken;
let weakManagerToken;
let staffToken;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(role, { status = 'approved', canStaff = false } = {}) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, can_staff)
     VALUES ($1, $2, $3, $4, 0, $5) RETURNING id, token_version`,
    [`${PREFIX}${role}-${canStaff ? 'cs' : 'nocs'}-${NONCE}@example.com`, passwordHash, role, status, canStaff]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);

  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager', { canStaff: true }));
  weakManagerToken = tokenFor(await makeUser('manager', { canStaff: false }));
  staffToken = tokenFor(await makeUser('staff'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', staffHubRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  await pool.end();
});

test('anon 401, staff 403', async () => {
  assert.equal((await get('/api/admin/staff-hub/summary')).status, 401);
  assert.equal((await get('/api/admin/staff-hub/summary', staffToken)).status, 403);
});

test('admin gets the full shape with integer counts and a derived open_period', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', adminToken);
  assert.equal(status, 200);
  for (const k of ['active_count', 'deactivated_count', 'former_staff_count', 'imported_count', 'new_applications', 'pending_reviews']) {
    assert.equal(typeof body[k], 'number', `${k} is a number`);
  }
  assert.equal(body.former_staff_count + body.imported_count, body.deactivated_count, 'deactivated splits exactly into former + imported');
  assert.match(body.open_period.start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.open_period.payday, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof body.open_period.exists, 'boolean');
});

test('the read never creates a pay_periods row', async () => {
  const before_ = (await pool.query('SELECT COUNT(*)::int AS n FROM pay_periods')).rows[0].n;
  await get('/api/admin/staff-hub/summary', adminToken);
  const after_ = (await pool.query('SELECT COUNT(*)::int AS n FROM pay_periods')).rows[0].n;
  assert.equal(after_, before_);
});

test('a manager with can_staff gets counts but null admin-only fields', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', managerToken);
  assert.equal(status, 200);
  assert.equal(typeof body.active_count, 'number');
  assert.equal(body.new_applications, null);
  assert.equal(body.pending_reviews, null);
  assert.equal(body.open_period, null);
});

test('a manager without can_staff gets every field null', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', weakManagerToken);
  assert.equal(status, 200);
  for (const k of ['active_count', 'deactivated_count', 'former_staff_count', 'imported_count', 'new_applications', 'pending_reviews', 'open_period']) {
    assert.equal(body[k], null, `${k} is null`);
  }
});
