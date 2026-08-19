require('dotenv').config();

// Route-level tests for the two Staff-hub read extensions on
// server/routes/admin/contractorTipPage.js: the /tips Status projection
// (the hub's Tips ledger derives a status from those columns) and the
// per-bartender /tip-feedback filter (the profile's Feedback card). Both
// routes are adminOnly, and that gate is asserted here too.
//
// Hand-rolled harness mirrors settings.badgeCounts.test.js: a minimal
// express() app with the real router and the real auth middleware, driven
// over node:http.
//
// Shared dev DB: fixtures are 'ctp-test-%' users plus their tip_page_feedback
// rows, both removed in after(). Nothing here writes a tips row: tip money
// never gets seeded into the dev ledger by a test.
//
// Run ALONE: node -r dotenv/config --test server/routes/admin/contractorTipPage.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const contractorTipPageRouter = require('./contractorTipPage');

if (process.env.NODE_ENV === 'production') {
  throw new Error('contractorTipPage.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'ctp-test-';

let server;
let baseUrl;
let adminToken;
let managerToken;
let bartenderId;
let otherId;

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

async function makeUser(role, tag) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, 'approved', 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${tag}-${NONCE}@example.com`, passwordHash, role]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function cleanFixtures() {
  const userSel = `SELECT id FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`;
  // tip_page_feedback FKs users with ON DELETE RESTRICT, so it goes first.
  await pool.query(`DELETE FROM tip_page_feedback WHERE target_user_id IN (${userSel})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
}

before(async () => {
  await cleanFixtures();

  adminToken = tokenFor(await makeUser('admin', 'admin'));
  managerToken = tokenFor(await makeUser('manager', 'manager'));
  bartenderId = (await makeUser('staff', 'bartender')).id;
  otherId = (await makeUser('staff', 'other')).id;

  // tip_page_feedback.rating is CHECK (rating BETWEEN 1 AND 3) in schema.sql;
  // the dev DB can be missing that CHECK, so seed inside 1..3 regardless or
  // dev and prod diverge. Two bartenders, so the filter has something to exclude.
  await pool.query(
    `INSERT INTO tip_page_feedback (target_user_id, rating, comment, submitter_email)
     VALUES ($1, 3, $2, 'guest@example.com'), ($3, 1, $4, 'guest2@example.com')`,
    [bartenderId, `ctp fixture feedback for bartender ${NONCE}`,
      otherId, `ctp fixture feedback for other ${NONCE}`]
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', contractorTipPageRouter);
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
  await cleanFixtures();
  await pool.end();
});

test('tips and tip-feedback stay adminOnly (a manager is denied)', async () => {
  assert.equal((await get('/api/admin/tips', managerToken)).status, 403);
  assert.equal((await get('/api/admin/tip-feedback', managerToken)).status, 403);
});

test('tips rows carry the Status projection columns', async () => {
  const { status, body } = await get('/api/admin/tips?limit=1', adminToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.tips), 'tips is an array');
  // Conditional by design: no tip row is ever seeded into the shared dev
  // ledger, so this asserts against whatever real dev tips exist.
  if (body.tips.length) {
    for (const k of ['id', 'amount_cents', 'tipped_at', 'customer_email', 'bartender_name',
      'target_user_id', 'shift_id', 'deferred_at', 'rolled_forward_at',
      'refunded_amount_cents', 'dispute_won_at']) {
      assert.ok(k in body.tips[0], `${k} projected`);
    }
    assert.equal(typeof body.tips[0].refunded_amount_cents, 'number', 'refunded_amount_cents is never null');
  }
});

test('tip-feedback filters by target_user_id and rejects a garbage value', async () => {
  const mine = await get(`/api/admin/tip-feedback?status=all&target_user_id=${bartenderId}`, adminToken);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.feedback.length >= 1, 'the seeded row comes back');
  assert.ok(mine.body.feedback.every((f) => f.target_user_id === bartenderId),
    'no other bartender feedback leaks into a filtered read');
  assert.ok(!mine.body.feedback.some((f) => f.target_user_id === otherId));

  const bad = await get('/api/admin/tip-feedback?target_user_id=abc', adminToken);
  assert.equal(bad.status, 400);
  const negative = await get('/api/admin/tip-feedback?target_user_id=-1', adminToken);
  assert.equal(negative.status, 400);
});

test('an unfiltered tip-feedback read still sees both bartenders', async () => {
  const all = await get('/api/admin/tip-feedback?status=all', adminToken);
  assert.equal(all.status, 200);
  const ids = all.body.feedback.map((f) => f.target_user_id);
  assert.ok(ids.includes(bartenderId), 'the filter is opt-in, not always-on');
  assert.ok(ids.includes(otherId));
});
