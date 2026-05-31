require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route test for the review-fix: GET /api/auth/me + POST /api/auth/login must
// surface contractor_profiles.preferred_name so the staff portal shell (menu
// name-line) and HomePage greeting can show the real name instead of the email
// local-part. Mirrors the hand-rolled node:http harness in staffPortal.test.js
// (no supertest in this repo).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const authRouter = require('./auth');

let server;
let baseUrl;
let staffToken;
let staffUserId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `auth-prefname-test-${NONCE}@example.com`;
const PASSWORD = 'testpass123';

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
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-prefname-test-%'");
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [EMAIL, passwordHash]
  );
  staffUserId = u.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name)
     VALUES ($1, '5555550199', 'Sam Review')`,
    [staffUserId]
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
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
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [staffUserId]);
  await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/auth/me includes preferred_name for a staffer', async () => {
  const res = await request('GET', '/api/auth/me', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.user.preferred_name, 'Sam Review');
});

test('POST /api/auth/login returns preferred_name in the user payload', async () => {
  const res = await request('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.user.preferred_name, 'Sam Review');
});
