require('dotenv').config();
process.env.NODE_ENV = 'test';

// The auth-route suite the mobile-admin spec (section 11) says this lane
// owes: login, register, forgot/reset password, /me. Same hand-rolled
// node:http harness as auth.preferredName.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const authRouter = require('./auth');

let server;
let baseUrl;
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const email = (tag) => `auth-core-test-${tag}-${NONCE}@example.com`;
const PASSWORD = 'GoodPass1';

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-core-test-%'");
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
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
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-core-test-%'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('register validates email format and password strength as field errors', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'not-an-email', password: 'weak' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.email);
  assert.ok(res.body.fieldErrors.password);
});

test('register happy path mints a working 7d token and an onboarding row', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: email('reg'), password: PASSWORD },
  });
  assert.equal(res.status, 201);
  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.userId, res.body.user.id);
  const lifetime = decoded.exp - decoded.iat;
  assert.ok(lifetime > 6.9 * 86400, 'password mints stay 7d');
  const prog = await pool.query('SELECT account_created FROM onboarding_progress WHERE user_id = $1', [res.body.user.id]);
  assert.equal(prog.rows[0].account_created, true);
});

test('register rejects a duplicate email', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('dup'), password: PASSWORD } });
  const res = await request('POST', '/api/auth/register', { body: { email: email('dup'), password: PASSWORD } });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.email);
});

test('login: success returns user + token; wrong password is a generic 409', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('login'), password: PASSWORD } });
  const ok = await request('POST', '/api/auth/login', { body: { email: email('login'), password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.user.has_application, 'boolean');

  const bad = await request('POST', '/api/auth/login', { body: { email: email('login'), password: 'WrongPass1' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'INVALID_CREDENTIALS');
});

test('login: 10 failed attempts trip the per-account lockout', async () => {
  await request('POST', '/api/auth/register', { body: { email: email('lock'), password: PASSWORD } });
  for (let i = 0; i < 10; i += 1) {
    await request('POST', '/api/auth/login', { body: { email: email('lock'), password: 'WrongPass1' } });
  }
  const res = await request('POST', '/api/auth/login', { body: { email: email('lock'), password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'RATE_LIMITED');
});

test('login: deactivated account is refused', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('deact'), password: PASSWORD } });
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [reg.body.user.id]);
  const res = await request('POST', '/api/auth/login', { body: { email: email('deact'), password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ACCOUNT_DEACTIVATED');
});

test('/me returns the authenticated user', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('me'), password: PASSWORD } });
  const res = await request('GET', '/api/auth/me', { token: reg.body.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, reg.body.user.id);
});

test('forgot-password answers identically for unknown and known emails', async () => {
  const unknown = await request('POST', '/api/auth/forgot-password', { body: { email: email('ghost') } });
  await request('POST', '/api/auth/register', { body: { email: email('fp'), password: PASSWORD } });
  const known = await request('POST', '/api/auth/forgot-password', { body: { email: email('fp') } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body);
});

test('reset-password: hashed token flow works and the version bump kills old sessions', async () => {
  const reg = await request('POST', '/api/auth/register', { body: { email: email('reset'), password: PASSWORD } });
  const userId = reg.body.user.id;
  const oldToken = reg.body.token;

  // Seed the reset row exactly as forgot-password does: store the sha256 hash.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
    [userId, tokenHash]
  );

  const weak = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'weak' } });
  assert.equal(weak.status, 400);

  const ok = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'NewGoodPass1' } });
  assert.equal(ok.status, 200);

  const oldMe = await request('GET', '/api/auth/me', { token: oldToken });
  assert.equal(oldMe.status, 401);
  assert.equal(oldMe.body.code, 'TOKEN_VERSION_MISMATCH');

  const relogin = await request('POST', '/api/auth/login', { body: { email: email('reset'), password: 'NewGoodPass1' } });
  assert.equal(relogin.status, 200);

  const reuse = await request('POST', '/api/auth/reset-password', { body: { token: rawToken, password: 'NewGoodPass1' } });
  assert.equal(reuse.status, 400);
});
