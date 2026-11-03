require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

// LIVE-STRIPE GUARD, as payment.noNameWrite.test.js: POST /api/payment's tail
// creates a tip Payment Link through getStripe(), and a dev .env can carry the
// live key. Null it before the router is required; the route absorbs the throw.
require('../utils/stripeClient').getStripe = () => null;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { encrypt, decrypt } = require('../utils/encryption');

// Published routing numbers and made-up account numbers; no person's data.
const ROUTING = '011000015';
const ACCOUNT = '000123456';
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, token, userId, emptyUserId, emptyToken;

function req(path, body, bearer = token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

async function makeStaffer(email) {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [email]
  );
  const id = u.rows[0].id;
  return { id, token: jwt.sign({ userId: id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

async function stored(id) {
  const { rows } = await pool.query('SELECT routing_number, account_number FROM payment_profiles WHERE user_id = $1', [id]);
  const r = rows[0] || {};
  return {
    routing: r.routing_number ? decrypt(r.routing_number) : null,
    account: r.account_number ? decrypt(r.account_number) : null,
  };
}

async function resetBank(id) {
  await pool.query(
    'UPDATE payment_profiles SET preferred_payment_method = $2, routing_number = $3, account_number = $4 WHERE user_id = $1',
    [id, 'direct_deposit', encrypt(ROUTING), encrypt(ACCOUNT)]
  );
}

before(async () => {
  const a = await makeStaffer(`pay-bank-${NONCE}@example.com`);
  userId = a.id; token = a.token;
  // A W-9 on file, so every POST passes the W-9 gate and reaches the bank fields.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method, routing_number, account_number, w9_file_url, w9_filename)
     VALUES ($1, 'direct_deposit', $2, $3, '/files/test-w9.pdf', 'w9.pdf')`,
    [userId, encrypt(ROUTING), encrypt(ACCOUNT)]
  );
  // A second staffer with a W-9 and no bank numbers.
  const b = await makeStaffer(`pay-bank-empty-${NONCE}@example.com`);
  emptyUserId = b.id; emptyToken = b.token;
  await pool.query(
    `INSERT INTO payment_profiles (user_id, w9_file_url, w9_filename) VALUES ($1, '/files/test-w9.pdf', 'w9.pdf')`,
    [emptyUserId]
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
  for (const id of [userId, emptyUserId].filter(Boolean)) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]); // payment_profiles cascades
  }
  await pool.end();
});

test('the masked values posted back keep the real bank numbers', async () => {
  await resetBank(userId);
  const res = await req('/api/payment', {
    preferred_payment_method: 'direct_deposit', routing_number: '****0015', account_number: '****3456',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(userId), { routing: ROUTING, account: ACCOUNT });
});

test('an invalid routing number is refused and nothing changes', async () => {
  await resetBank(userId);
  const res = await req('/api/payment', {
    preferred_payment_method: 'direct_deposit', routing_number: '123456789', account_number: '987650001',
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.routing_number, JSON.stringify(res.body));
  assert.deepEqual(await stored(userId), { routing: ROUTING, account: ACCOUNT });
});

test('new valid numbers replace the old', async () => {
  await resetBank(userId);
  const res = await req('/api/payment', {
    preferred_payment_method: 'direct_deposit', routing_number: '021000021', account_number: '987650001',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await stored(userId), { routing: '021000021', account: '987650001' });
});

test('direct deposit with blank bank numbers is refused', async () => {
  await resetBank(userId);
  const res = await req('/api/payment', { preferred_payment_method: 'direct_deposit', routing_number: '', account_number: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.routing_number && res.body.fieldErrors.account_number, JSON.stringify(res.body));
  assert.deepEqual(await stored(userId), { routing: ROUTING, account: ACCOUNT });
});

test('a masked value with nothing stored behind it is refused', async () => {
  const res = await req('/api/payment', {
    preferred_payment_method: 'direct_deposit', routing_number: '****0015', account_number: '****3456',
  }, emptyToken);
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.routing_number && res.body.fieldErrors.account_number, JSON.stringify(res.body));
  assert.deepEqual(await stored(emptyUserId), { routing: null, account: null });
});
