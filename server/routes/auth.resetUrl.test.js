// Forgot-password reset link host tests: with CLIENT_URL unset the emailed
// link must land on the admin domain, never a localhost fallback.
require('dotenv').config();
process.env.NODE_ENV = 'test';
// The fallback under test: CLIENT_URL missing, as on a misconfigured deploy.
// Deleted before any module that reads it at load time is required.
delete process.env.CLIENT_URL;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

// Capture the email instead of sending it.
const sent = [];
const emailPath = path.join(__dirname, '../utils/email.js');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: { sendEmail: async (msg) => { sent.push(msg); return { id: 'stub' }; } },
};

const { pool } = require('../db');
const authRouter = require('./auth');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `auth-reseturl-test-${NONCE}@example.com`;
let server;
let baseUrl;

function post(p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-reseturl-test-%'");
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'auth-reseturl-test-%'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('with CLIENT_URL unset the reset link is on the admin domain, not localhost', async () => {
  assert.equal(await post('/api/auth/register', { email: EMAIL, password: 'GoodPass1' }), 201);
  sent.length = 0;
  assert.equal(await post('/api/auth/forgot-password', { email: EMAIL }), 200);
  const reset = sent.find((m) => m.to === EMAIL);
  assert.ok(reset, 'a reset email was sent');
  const link = reset.html.match(/href="([^"]+)"/)[1];
  assert.doesNotMatch(link, /localhost/);
  assert.match(link, /^https:\/\/admin\.drbartender\.com\/reset-password\/[0-9a-f]{64}$/);
});
