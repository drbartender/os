const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// NOTE: rateLimiters.js exports no `loginLimiter` (the T2 spec named one that
// does not exist in this module). We exercise the same behaviour against real
// exports: signLimiter for the generic "over-max → 429 + configured envelope"
// path, and adminWriteLimiter for the per-user bucket-keying guarantee. Both
// have small maxes so the test hits max+1 with no timer waits.
const { signLimiter, adminWriteLimiter } = require('./rateLimiters');

let server, baseUrl;

function hit(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })); }
    );
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  const app = express();
  // signLimiter has no custom keyGenerator → keyed by req.ip, so every request
  // from 127.0.0.1 shares one bucket and accumulates toward the max.
  app.get('/sign', signLimiter, (req, res) => res.json({ ok: true }));
  // Shim: set req.user from a header so adminWriteLimiter's user-id keyGenerator
  // can be exercised without minting real JWTs / touching the DB.
  app.use((req, res, next) => { const uid = req.headers['x-test-user']; if (uid) req.user = { id: uid }; next(); });
  app.get('/admin', adminWriteLimiter, (req, res) => res.json({ ok: true }));
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('signLimiter allows up to max, then returns 429 with the configured JSON envelope', async () => {
  // signLimiter: max 10 / 1h window, single shared IP bucket.
  for (let i = 0; i < 10; i++) {
    const r = await hit('/sign');
    assert.equal(r.status, 200, `request ${i + 1} of 10 should pass, got ${r.status}`);
  }
  const over = await hit('/sign');
  assert.equal(over.status, 429, 'the 11th request trips the limiter');
  assert.deepEqual(JSON.parse(over.body), { error: 'Too many signing attempts. Please try again later.' });
  // standardHeaders:true → draft RateLimit-* headers present; legacyHeaders:false → no X-RateLimit-*.
  assert.ok(Object.keys(over.headers).some((k) => k.startsWith('ratelimit')), 'standard RateLimit headers present');
  assert.equal(over.headers['x-ratelimit-limit'], undefined, 'legacy X-RateLimit-* headers are disabled');
});

test('adminWriteLimiter keys per user id — one user hitting max does not consume another user\'s budget', async () => {
  // adminWriteLimiter: max 10 / 60s, keyed by `admin-${req.user.id}`.
  for (let i = 0; i < 10; i++) {
    const r = await hit('/admin', { 'x-test-user': 'A' });
    assert.equal(r.status, 200, `user A request ${i + 1} of 10 should pass, got ${r.status}`);
  }
  const overA = await hit('/admin', { 'x-test-user': 'A' });
  assert.equal(overA.status, 429, 'user A is limited after exceeding max');
  assert.deepEqual(JSON.parse(overA.body), { error: 'Too many requests. Please slow down.' });

  // A different user id resolves to a separate bucket and is unaffected.
  const b1 = await hit('/admin', { 'x-test-user': 'B' });
  assert.equal(b1.status, 200, 'user B has its own bucket and is not blocked by user A');
});
