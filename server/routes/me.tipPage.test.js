require('dotenv').config();

process.env.NODE_ENV = 'test';

// Route-level tests for GET /api/me/tip-page — specifically the `methods`
// array added 2026-08-11.
//
// WHY THIS FILE EXISTS
// --------------------
// Before this, NO server test touched /me/tip-page at all. The whole point of
// server/utils/tipMethods.js is that the staff endpoint and the public tip
// endpoint derive the SAME method set: the staff side feeds a downloadable
// sign that gets printed at a photo counter, and the public side feeds the
// chooser page a guest lands on after scanning it. A sign advertising a method
// the chooser page won't render is a defect that costs a bartender money and
// cannot be recalled once printed.
//
// So these tests mount BOTH routers and assert the two arrays are equal,
// including for a profile whose stored paypal_url fails read-side validation —
// the exact case where deriving availability from raw columns diverges.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const meRouter = require('./me');
const publicTipRouter = require('./publicTip');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// User A — full kit, saved order. User B — stored paypal_url that fails
// read-side validation (points off paypal.me), everything else valid.
let userIdA, userIdB;
let tokenA, tokenB;
let tipTokenA, tipTokenB;
let server;
let baseUrl;

function request(method, path, authToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
    req.end();
  });
}

async function seedStaff(slug, uiPreferences) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, ui_preferences)
     VALUES ($1, 'x', 'staff', 'approved', 0, $2::jsonb)
     RETURNING id, token_version`,
    [`metip-${slug}-${NONCE}@example.com`, JSON.stringify(uiPreferences || {})]
  );
  const id = r.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, $2, 'bartender', 25.00)`,
    [id, `Staff ${slug.toUpperCase()}`]
  );
  const authToken = jwt.sign(
    { userId: id, tokenVersion: r.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { id, authToken };
}

before(async () => {
  const fixtureFilter = `email LIKE 'metip-%@example.com'`;
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

  const a = await seedStaff('a', { tip_card_order: ['venmo', 'card'] });
  userIdA = a.id;
  tokenA = a.authToken;
  tipTokenA = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles
       (user_id, venmo_handle, cashapp_handle, paypal_url, zelle_handle,
        stripe_payment_link_url, tip_page_token, tip_page_active)
     VALUES ($1, 'a-vm', 'a_ca', 'https://paypal.me/anna', 'anna@example.com',
             'https://buy.stripe.com/test_a', $2::uuid, TRUE)`,
    [userIdA, tipTokenA]
  );

  // B's stored paypal_url points off paypal.me, so read-side validation drops
  // it. This is the row shape that predates the write-time validator.
  const b = await seedStaff('b', {});
  userIdB = b.id;
  tokenB = b.authToken;
  tipTokenB = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles
       (user_id, venmo_handle, paypal_url, tip_page_token, tip_page_active)
     VALUES ($1, 'b-vm', 'https://evil.example.com/pay', $2::uuid, TRUE)`,
    [userIdB, tipTokenB]
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', meRouter);
  app.use('/api/public/tip', publicTipRouter);
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
  const fixtureFilter = `email LIKE 'metip-%@example.com'`;
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('GET /api/me/tip-page > requires auth', async () => {
  const res = await request('GET', '/api/me/tip-page');
  assert.equal(res.status, 401);
});

test('GET /api/me/tip-page > returns methods honoring the saved tip_card_order', async () => {
  const res = await request('GET', '/api/me/tip-page', tokenA);
  assert.equal(res.status, 200);
  // Saved order is ['venmo','card']; cashapp, paypal, zelle are on the profile
  // but unsaved, so they trail in the natural order.
  assert.deepEqual(res.body.methods, ['venmo', 'card', 'cashapp', 'paypal', 'zelle']);
});

test('GET /api/me/tip-page > methods match the public endpoint EXACTLY', async () => {
  const staff = await request('GET', '/api/me/tip-page', tokenA);
  const pub = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.equal(staff.status, 200);
  assert.equal(pub.status, 200);
  assert.deepEqual(staff.body.methods, pub.body.methods);
});

test('a paypal_url that fails read-side validation is absent from methods on BOTH endpoints', async () => {
  const staff = await request('GET', '/api/me/tip-page', tokenB);
  const pub = await request('GET', `/api/public/tip/${tipTokenB}`);
  assert.equal(staff.status, 200);
  assert.equal(pub.status, 200);

  // This is the regression guard for the whole extraction. Deriving
  // availability from the raw column would put 'paypal' on the staff side
  // only, and the printed sign would advertise a button the chooser page
  // refuses to render.
  assert.ok(!staff.body.methods.includes('paypal'), 'staff methods must drop the bad paypal_url');
  assert.ok(!pub.body.methods.includes('paypal'), 'public methods must drop the bad paypal_url');
  assert.deepEqual(staff.body.methods, pub.body.methods);
  assert.deepEqual(staff.body.methods, ['venmo']);
});

test('GET /api/me/tip-page > still returns the raw stored paypal_url for the edit form', async () => {
  // The staff EDIT form must show what is actually stored so a bartender can
  // fix a bad value. Only `methods` is normalized.
  const res = await request('GET', '/api/me/tip-page', tokenB);
  assert.equal(res.status, 200);
  assert.equal(res.body.paypal_url, 'https://evil.example.com/pay');
});

test('GET /api/me/tip-page > a profile with no payment rails returns an empty methods array', async () => {
  const c = await seedStaff('c', {});
  const res = await request('GET', '/api/me/tip-page', c.authToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.methods, []);
  assert.equal(res.body.url, null);
  assert.equal(res.body.active, false);
});
