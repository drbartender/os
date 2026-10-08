require('dotenv').config();

// badge-counts gains inbox_waiting (spec 2026-10-06 section 8): a number when
// the engine answers, null when it fails or runs past 2 seconds, and the other
// counts arrive either way. Harness mirrors settings.badgeCounts.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const engine = require('../../utils/inbox/engine');
const k = require('../../utils/inbox/rules.testkit');
const settingsRouter = require('./settings');

// Fixed, so before() also clears a user a crashed earlier run left behind.
const EMAIL = 'inbox-badge-test@example.com';
let server;
let baseUrl;
let token;

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version",
    [EMAIL]
  );
  token = jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', settingsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  engine.__resetEngine();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.end();
});

test('inbox_waiting is the engine count', async () => {
  const now = new Date();
  const events = [
    k.smsIn('c-901', new Date(now.getTime() - 3600e3), 'One question'),
    k.smsIn('c-902', new Date(now.getTime() - 7200e3), 'Another question'),
  ];
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(engine.__fakeSnapshot({ now, events })) });
  const res = await get('/api/admin/badge-counts');
  assert.equal(res.status, 200);
  assert.equal(res.body.inbox_waiting, 2);
  assert.equal(typeof res.body.pending_proposals, 'number');
});

test('a slow engine gives null inside the 2 second budget, and the other counts still arrive', async () => {
  engine.__setEngineDeps({
    computeSnapshot: () => new Promise((resolve) => { setTimeout(() => resolve(engine.__fakeSnapshot()), 6000).unref(); }),
  });
  const started = Date.now();
  const res = await get('/api/admin/badge-counts');
  assert.equal(res.status, 200);
  assert.equal(res.body.inbox_waiting, null);
  assert.ok(Date.now() - started < 4500, `answered in ${Date.now() - started} ms`);
  assert.equal(typeof res.body.unread_sms, 'number');
});

test('a failing engine gives null and never fails the request', async () => {
  engine.__setEngineDeps({ computeSnapshot: () => Promise.reject(new Error('db down')) });
  const res = await get('/api/admin/badge-counts');
  assert.equal(res.status, 200);
  assert.equal(res.body.inbox_waiting, null);
  assert.equal(typeof res.body.pending_reviews, 'number');
});
