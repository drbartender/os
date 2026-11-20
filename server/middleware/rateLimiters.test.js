const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// NOTE: rateLimiters.js exports no `loginLimiter` (the T2 spec named one that
// does not exist in this module). We exercise the same behaviour against real
// exports: signLimiter for the generic "over-max → 429 + configured envelope"
// path, and adminWriteLimiter for the per-user bucket-keying guarantee. Both
// have small maxes so the test hits max+1 with no timer waits.
const {
  signLimiter, adminWriteLimiter, webauthnLimiter, inboxTextLimiter,
  connectorGrantLimiter, connectorAddressCeilingLimiter, connectorMcpAddressLimiter, connectorAuthorizeLimiter, connectorTokenLimiter,
} = require('./rateLimiters');

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
  app.get('/webauthn', webauthnLimiter, (req, res) => res.json({ ok: true }));
  app.get('/inbox-text', inboxTextLimiter, (req, res) => res.json({ ok: true }));
  // The connector's per-grant limiter keys on req.connector, which its token
  // check sets; the shim sets it from a header.
  app.get('/connector-grant', (req, res, next) => {
    const g = req.headers['x-test-grant'];
    if (g) req.connector = { grantId: Number(g) };
    next();
  }, connectorGrantLimiter, (req, res) => res.json({ ok: true }));
  // The ceiling counts failed calls only: this route fails (401, as an
  // unauthenticated /mcp call does) unless the shim header asks it to serve.
  app.get('/connector-ceiling', connectorAddressCeilingLimiter, (req, res) => (
    req.headers['x-test-ok'] ? res.json({ ok: true }) : res.status(401).json({ error: 'unauthorized' })));
  app.get('/connector-mcp', connectorMcpAddressLimiter, (req, res) => res.json({ ok: true }));
  app.get('/connector-authorize', connectorAuthorizeLimiter, (req, res) => res.json({ ok: true }));
  app.get('/connector-token', connectorTokenLimiter, (req, res) => res.json({ ok: true }));
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

test('webauthnLimiter: 30 per IP with the unlock envelope, and NODE_ENV=test skips at request time', async () => {
  // The skip callback reads NODE_ENV per request, so one process can prove
  // both behaviours by flipping the env var between hits.
  const prev = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    for (let i = 0; i < 30; i++) {
      const r = await hit('/webauthn');
      assert.equal(r.status, 200, `request ${i + 1} of 30 should pass, got ${r.status}`);
    }
    const over = await hit('/webauthn');
    assert.equal(over.status, 429, 'the 31st request trips the limiter');
    assert.deepEqual(JSON.parse(over.body), { error: 'Too many unlock attempts. Please try again later.' });
    process.env.NODE_ENV = 'test';
    const skipped = await hit('/webauthn');
    assert.equal(skipped.status, 200, 'NODE_ENV=test skips the limiter at request time');
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test('inboxTextLimiter: 20 texts a minute per user, in its own bucket, with its own envelope', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await hit('/inbox-text', { 'x-test-user': 'C' });
    assert.equal(r.status, 200, `user C text ${i + 1} of 20 should pass, got ${r.status}`);
  }
  const over = await hit('/inbox-text', { 'x-test-user': 'C' });
  assert.equal(over.status, 429, 'the 21st text in a minute trips it');
  assert.deepEqual(JSON.parse(over.body), { error: 'Too many texts in a minute. Please wait a moment.' });
  assert.equal((await hit('/inbox-text', { 'x-test-user': 'D' })).status, 200, 'another user is unaffected');
  assert.equal((await hit('/admin', { 'x-test-user': 'C' })).status, 200, 'a bucket of its own, apart from adminWriteLimiter');
});

// The four Claude connector limiters (spec 2026-11-19 section 7.1). Each is
// skipped under NODE_ENV=test, so each case clears it and proves the limit.
async function withLimitersLive(fn) {
  const prev = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

test('connectorGrantLimiter: 120 a minute per grant, one grant never spends another\'s budget', async () => {
  await withLimitersLive(async () => {
    for (let i = 0; i < 120; i++) {
      const r = await hit('/connector-grant', { 'x-test-grant': '901' });
      assert.equal(r.status, 200, `grant 901 call ${i + 1} of 120 should pass, got ${r.status}`);
    }
    const over = await hit('/connector-grant', { 'x-test-grant': '901' });
    assert.equal(over.status, 429, 'the 121st call in a minute trips it');
    assert.deepEqual(JSON.parse(over.body), { error: 'Too many requests. Please slow down.' });
    assert.equal((await hit('/connector-grant', { 'x-test-grant': '902' })).status, 200, 'another grant has its own bucket');
  });
});

// Served calls never fill the ceiling: a busy session (the per-grant limiter
// allows 120 a minute) must not block its own refresh. Runs before the
// ceiling's failure count below, on the same address bucket.
test('connectorAddressCeilingLimiter: served calls are not counted, so 400 in a row all pass', async () => {
  await withLimitersLive(async () => {
    for (let i = 0; i < 400; i++) {
      const r = await hit('/connector-ceiling', { 'x-test-ok': '1' });
      assert.equal(r.status, 200, `served call ${i + 1} of 400 should pass, got ${r.status}`);
    }
  });
});

for (const [route, max, envelope, passStatus] of [
  ['/connector-ceiling', 300, { error: 'Too many requests. Please try again later.' }, 401],
  ['/connector-mcp', 60, { error: 'Too many requests. Please try again later.' }, 200],
  ['/connector-authorize', 30, { error: 'Too many sign-in attempts. Please try again later.' }, 200],
  ['/connector-token', 60, { error: 'Too many token requests. Please try again later.' }, 200],
]) {
  test(`${route} limiter: ${max} per address in 15 minutes, then 429; skipped under NODE_ENV=test`, async () => {
    await withLimitersLive(async () => {
      for (let i = 0; i < max; i++) {
        const r = await hit(route);
        assert.equal(r.status, passStatus, `request ${i + 1} of ${max} should pass the limiter, got ${r.status}`);
      }
      const over = await hit(route);
      assert.equal(over.status, 429, `request ${max + 1} trips it`);
      assert.deepEqual(JSON.parse(over.body), envelope);
      process.env.NODE_ENV = 'test';
      assert.equal((await hit(route)).status, passStatus, 'NODE_ENV=test skips it at request time');
    });
  });
}
