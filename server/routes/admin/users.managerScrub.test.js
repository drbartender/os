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
  throw new Error('users.managerScrub.test.js refuses to run against production');
}

// GET /users/:id is open to admin AND manager (requireAdminOrManager). A manager
// manages/evaluates staff but the payroll/financial tier stays admin-only. This
// test pins the least-privilege scrub: a manager must NOT receive the contractor
// pay rate (contractor_profiles.hourly_rate) or the payment_profiles row, while
// still seeing operational data (preferred_name). Admin sees everything.

const PREFIX = 'cc-mgrscrub-test-';
const RATE = '42.50'; // pg returns NUMERIC as a string

let server, baseUrl;
let adminId, adminToken;
let managerId, managerToken;
let subjectId;

before(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const a = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
      [`${PREFIX}admin@example.com`]
    );
    adminId = a.rows[0].id;
    adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const m = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status)
       VALUES ($1, 'x', 'manager', 'hired') RETURNING id`,
      [`${PREFIX}manager@example.com`]
    );
    managerId = m.rows[0].id;
    managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const s = await c.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status)
       VALUES ($1, 'x', 'staff', 'hired') RETURNING id`,
      [`${PREFIX}subject@example.com`]
    );
    subjectId = s.rows[0].id;

    // Subject's profile carries an operational field (preferred_name) AND the
    // comp field (hourly_rate) that must be withheld from managers.
    await c.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, hourly_rate)
       VALUES ($1, 'Subject Sam', $2)`,
      [subjectId, RATE]
    );

    // A payment_profiles row with a non-bank field set, so the whole object is
    // non-empty for admin and provably {} for manager. No routing/account so the
    // route's decrypt branch is skipped.
    await c.query(
      `INSERT INTO payment_profiles (user_id, preferred_payment_method, venmo_handle)
       VALUES ($1, 'venmo', '@subject-sam')`,
      [subjectId]
    );

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

  const userIds = [adminId, managerId, subjectId].filter(Boolean);
  if (subjectId) {
    await pool.query(`DELETE FROM contractor_profiles WHERE user_id = $1`, [subjectId]);
    await pool.query(`DELETE FROM payment_profiles WHERE user_id = $1`, [subjectId]);
  }
  for (const id of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
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

test('admin GET /users/:id sees hourly_rate and the payment row', async () => {
  const r = await req('GET', `/api/admin/users/${subjectId}`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.profile.hourly_rate, RATE, 'admin sees the contractor pay rate');
  assert.equal(body.payment.preferred_payment_method, 'venmo', 'admin sees the payment row');
});

test('manager GET /users/:id is denied hourly_rate and the payment row', async () => {
  const r = await req('GET', `/api/admin/users/${subjectId}`, managerToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.profile.hourly_rate, undefined, 'manager must NOT receive the contractor pay rate');
  assert.deepEqual(body.payment, {}, 'manager must NOT receive the payment_profiles row');
  // Operational data still flows — we scrubbed the comp field, not the whole profile.
  assert.equal(body.profile.preferred_name, 'Subject Sam', 'manager still sees operational profile data');
});
