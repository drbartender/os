require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientAuthRouter = require('./clientAuth');

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientAuth.otpNeutral.test.js refuses to run against production');
}

// F6: the /verify per-account attempt ceiling used to throw 409 RATE_LIMITED —
// a distinct status/code from the neutral 400 VALIDATION_ERROR returned for
// wrong/unknown/expired codes. That difference is a membership oracle (reveals
// the email exists AND had a live OTP). The fix returns the SAME neutral 400
// while STILL invalidating the OTP server-side.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const emailFor = (tag) => `otpneutral-${tag}-${NONCE}@example.com`;

const seedAtCeiling = async (email) => {
  const hash = await bcrypt.hash('654321', 12);
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const c = await pool.query(
    `INSERT INTO clients (name, email, auth_token, auth_token_expires_at, auth_token_attempts)
     VALUES ($1, $2, $3, $4, 5) RETURNING id`,
    ['OTP Ceiling', email, hash, expires]
  );
  return c.rows[0].id;
};

let server, baseUrl, ceilingEmail;

before(async () => {
  ceilingEmail = emailFor('ceiling');
  await seedAtCeiling(ceilingEmail);

  const app = express();
  app.use(express.json());
  app.use('/api/client-auth', clientAuthRouter);
  // Mirror the real global error middleware (server/index.js).
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [`otpneutral-%-${NONCE}@example.com`]);
  await pool.end();
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); });
      }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('F6: attempt-ceiling /verify returns the neutral 400 (not 409 RATE_LIMITED)', async () => {
  const r = await post('/api/client-auth/verify', { email: ceilingEmail, otp: '000000' });
  assert.equal(r.status, 400, `expected neutral 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.deepEqual(r.body.fieldErrors, { otp: 'This code is invalid or has expired' });
});

test('F6: the ceiling branch STILL invalidates the OTP server-side', async () => {
  const email = emailFor('invalidate');
  const id = await seedAtCeiling(email);
  await post('/api/client-auth/verify', { email, otp: '000000' });
  const row = await pool.query(
    'SELECT auth_token, auth_token_expires_at, auth_token_attempts FROM clients WHERE id = $1',
    [id]
  );
  assert.equal(row.rows[0].auth_token, null, 'OTP hash must be cleared');
  assert.equal(row.rows[0].auth_token_expires_at, null, 'OTP expiry must be cleared');
  assert.equal(row.rows[0].auth_token_attempts, 0, 'attempt counter must be reset');
});

test('F6: ceiling response is byte-identical to the unknown-email response (oracle closed)', async () => {
  const email = emailFor('parity');
  await seedAtCeiling(email);
  const ceiling = await post('/api/client-auth/verify', { email, otp: '000000' });
  const unknown = await post('/api/client-auth/verify', { email: emailFor('does-not-exist'), otp: '000000' });
  assert.equal(ceiling.status, unknown.status, `status mismatch: ceiling ${ceiling.status} vs unknown ${unknown.status}`);
  assert.deepEqual(ceiling.body, unknown.body, 'response bodies must be identical');
});
