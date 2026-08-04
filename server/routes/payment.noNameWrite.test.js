require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

// LIVE-STRIPE GUARD. This suite drives the REAL POST /api/payment, whose tail
// calls createTipPaymentLink -> getStripe(). getStripe() has no NODE_ENV gate
// (only STRIPE_TEST_MODE_UNTIL), and a dev box's .env can carry the LIVE secret
// key, so an unstubbed run creates real Stripe Products, Prices and Payment
// Links on the production account. It did, once, before this stub existed.
//
// Neutralize the seam BEFORE the router is required, exactly as
// stripeCreateIntent.test.js does: utils/tipPaymentLinks.js destructures
// getStripe at ITS module load, and payment.js requires tipPaymentLinks lazily
// inside the handler, so this assignment is what that destructure will see.
// getStripe() returning null means no Stripe client object is ever constructed;
// createTipPaymentLink then throws on its own `if (!stripe)` guard BEFORE the
// first API call, and the route's existing catch absorbs it. The name
// assertions below are unaffected because they read the DB, not Stripe.
require('../utils/stripeClient').getStripe = () => null;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `pay-nn-${NONCE}@example.com`;
let server, baseUrl, token, userId;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  // token_version is RETURNed and signed into the JWT: middleware/auth.js:46
  // compares decoded.tokenVersion against users.token_version, and :41 looks the
  // user up by decoded.userId. A token signed { id, ... } 401s USER_NOT_FOUND.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  token = jwt.sign(
    { userId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Fareed']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Mohammad F Shafiuddin', EMAIL]);
  await require('../utils/refreshDisplayName').refreshDisplayName(userId, pool);
  // Without a stored W-9 every POST 400s at the server-side gate
  // (payment.js: "A signed W-9 is required.") before the name logic runs.
  // payment_profiles.user_id cascades on user delete, so teardown needs nothing extra.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, w9_file_url, w9_filename)
     VALUES ($1, '/files/test-w9.pdf', 'w9.pdf')`,
    [userId]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/payment', require('./payment'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('POST', '/api/payment', { preferred_payment_method: 'check' });
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
});

test('POST /api/payment ignores a preferred_name in the body', async () => {
  const res = await req('POST', '/api/payment', {
    preferred_name: 'LumpyIceCream',
    preferred_payment_method: 'venmo',
    venmo_handle: '@test-handle',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows } = await pool.query(
    'SELECT preferred_name, display_name FROM contractor_profiles WHERE user_id = $1',
    [userId]
  );
  // The step-4 answer survives. This is the regression that produced TwistidTreets.
  assert.equal(rows[0].preferred_name, 'Fareed');
  assert.equal(rows[0].display_name, 'Fareed S.');
});
