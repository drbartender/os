require('dotenv').config();

// Route-level tests for GET /api/admin/badge-counts (server/routes/admin/settings.js).
// Verifies the role guard (admin + manager allowed, staff/anon denied) and that the
// manager response zeroes new_applications, since the Hiring surface is adminOnly.
// Closes Sentry DRBARTENDER-SERVER-R, where a manager's 60s dashboard poll 403'd
// and emitted a role_denial warning every minute.
//
// Hand-rolled harness mirrors adminCoverSwaps.test.js: a minimal express() app with
// the real router + real auth/role middleware, driven via node:http + node:test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const settingsRouter = require('./settings');

let server;
let baseUrl;
let adminToken;
let managerToken;
let staffToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'badge-counts-test-';

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

async function makeUser(role, status = 'approved') {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, $4, 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${role}-${status}-${NONCE}@example.com`, passwordHash, role, status]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);

  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager'));
  staffToken = tokenFor(await makeUser('staff'));

  // Seed one applicant so new_applications is >= 1 for an admin. This proves the
  // manager-side zeroing is a real branch, not just an empty table coincidentally
  // reading 0. applications.user_id is ON DELETE CASCADE, so the after-cleanup of
  // the applicant user removes this row too.
  const applicant = await makeUser('staff', 'applied');
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, why_dr_bartender)
     VALUES ($1, $2, '+15555551234', 'Chicago', 'IL', '25',
             'yes', 'Bartender', 'Test')`,
    [applicant.id, `Badge Counts Applicant ${NONCE}`]
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', settingsRouter);
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
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

const COUNT_KEYS = ['pending_proposals', 'unstaffed_events', 'new_applications',
  'pending_shopping_lists', 'unread_sms'];

test('admin reads badge-counts: all five integer counts, seeded applicant visible', async () => {
  const res = await get('/api/admin/badge-counts', adminToken);
  assert.equal(res.status, 200);
  for (const k of COUNT_KEYS) assert.equal(typeof res.body[k], 'number', `${k} should be a number`);
  assert.ok(res.body.new_applications >= 1, 'admin sees the seeded applicant in new_applications');
});

test('manager reads badge-counts but new_applications is zeroed', async () => {
  const res = await get('/api/admin/badge-counts', managerToken);
  assert.equal(res.status, 200);
  for (const k of COUNT_KEYS) assert.equal(typeof res.body[k], 'number', `${k} should be a number`);
  assert.equal(res.body.new_applications, 0, 'manager must not see the admin-only hiring count');
});

test('staff is denied badge-counts (403)', async () => {
  const res = await get('/api/admin/badge-counts', staffToken);
  assert.equal(res.status, 403);
});

test('unauthenticated is denied badge-counts (401)', async () => {
  const res = await get('/api/admin/badge-counts', null);
  assert.equal(res.status, 401);
});
