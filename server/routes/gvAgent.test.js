'use strict';

// Auth for the GV agent API (spec 2026-10-17 section 6 "Agent endpoints", plan
// Task 7): the x-gv-agent-secret header against GV_AGENT_SECRET, timing-safe
// and failing closed in every environment, with a Sentry warning that names the
// path and never the secret. The real router on express() with a node:http
// helper (the thumbtackAgent.replies.test.js harness). Run ALONE:
//   node --test server/routes/gvAgent.test.js
// The kill switch stays off, so an authenticated /pending answers [] before
// any read; nothing here writes.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('gvAgent.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const gvAgentRouter = require('./gvAgent');

const SECRET = `gv-agent-auth-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;
const ORIG = { secret: process.env.GV_AGENT_SECRET, flag: process.env.GV_PROPOSAL_POST_ENABLED };
let server, baseUrl;
let warnings = [];

// secret undefined sends no header at all.
function request(method, path, { secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(secret === undefined ? {} : { 'x-gv-agent-secret': secret }),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  delete process.env.GV_PROPOSAL_POST_ENABLED;
  gvAgentRouter.__setDeps({
    Sentry: {
      captureMessage: (message, ctx) => { warnings.push({ message, ctx }); },
      captureException: (err, ctx) => { warnings.push({ message: err.message, ctx }); },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/gv-agent', gvAgentRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

// The router's own limiter (30 a minute, keyed on 127.0.0.1) and its
// auth-warning throttle (one per path per 10 minutes) are cleared per test in
// this process only; their configuration is never touched.
beforeEach(() => {
  gvAgentRouter.gvAgentLimiter.resetKey('127.0.0.1');
  if (typeof gvAgentRouter.__resetAuthWarnThrottle === 'function') gvAgentRouter.__resetAuthWarnThrottle();
  warnings = [];
});

after(async () => {
  if (ORIG.secret === undefined) delete process.env.GV_AGENT_SECRET;
  else process.env.GV_AGENT_SECRET = ORIG.secret;
  if (ORIG.flag === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG.flag;
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
  } finally {
    if (typeof gvAgentRouter.__setDeps === 'function') gvAgentRouter.__setDeps({ Sentry });
    await pool.end();
  }
});

test('no secret configured is 401', async () => {
  delete process.env.GV_AGENT_SECRET;
  for (const secret of [undefined, '', 'anything']) {
    const res = await request('GET', '/api/gv-agent/pending', { secret });
    assert.equal(res.status, 401, `header ${JSON.stringify(secret)}`);
    assert.equal(res.body.code, 'NO_AGENT_SECRET');
  }
  // A blank configured secret is no secret: it never matches a blank header.
  process.env.GV_AGENT_SECRET = '';
  try {
    assert.equal((await request('GET', '/api/gv-agent/pending', { secret: '' })).status, 401);
  } finally {
    delete process.env.GV_AGENT_SECRET;
  }
});

test('wrong secret is 401', async () => {
  process.env.GV_AGENT_SECRET = SECRET;
  assert.equal((await request('GET', '/api/gv-agent/pending', { secret: `${SECRET}x` })).status, 401);
  assert.equal((await request('GET', '/api/gv-agent/pending', { secret: SECRET.slice(0, -1) })).status, 401);
  // Every route sits behind the gate, not only the lease.
  for (const [path, body] of [
    ['/api/gv-agent/precheck', { id: 1 }],
    ['/api/gv-agent/report', { id: 1, outcome: 'sent' }],
    ['/api/gv-agent/status', { state: 'session_expired' }],
  ]) {
    assert.equal((await request('POST', path, { secret: 'wrong', body })).status, 401, path);
  }
  // One Sentry warning per refused path: the throttle holds the second /pending.
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((w) => w.ctx.level === 'warning'));
  assert.deepEqual(warnings.map((w) => w.ctx.extra.path), [
    '/api/gv-agent/pending', '/api/gv-agent/precheck', '/api/gv-agent/report', '/api/gv-agent/status',
  ]);
  // Both near-miss headers sent above contain SECRET minus its last character.
  assert.ok(!JSON.stringify(warnings).includes(SECRET.slice(0, -1)), 'the secret never reaches Sentry');
});

test('a same-length non-ASCII header is 401, not 500', async () => {
  process.env.GV_AGENT_SECRET = SECRET;
  // The last character swapped for a Latin-1 one (Node reads header bytes as
  // Latin-1): the same length in characters, one byte longer in UTF-8, which a
  // length-checked Buffer compare throws on.
  const header = SECRET.slice(0, -1) + String.fromCharCode(0xe9);
  assert.equal(header.length, SECRET.length);
  const res = await request('GET', '/api/gv-agent/pending', { secret: header });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'NO_AGENT_SECRET');
  assert.equal(warnings.length, 1, 'refused like any wrong secret');
});

test('repeated bad-secret calls warn Sentry once per window', async () => {
  // A box polling every 10 s with a stale secret is one signal, not a page a
  // poll. The router's clock is injected so the window's edge is exact.
  process.env.GV_AGENT_SECRET = SECRET;
  const WINDOW_MS = 10 * 60 * 1000;
  let clock = Date.now();
  gvAgentRouter.__setDeps({ now: () => clock });
  const refuse = async (method, path, body) => {
    assert.equal((await request(method, path, { secret: 'wrong', body })).status, 401, path);
  };
  try {
    for (let i = 0; i < 3; i += 1) await refuse('GET', '/api/gv-agent/pending');
    await refuse('POST', '/api/gv-agent/status', { state: 'challenge' });
    assert.deepEqual(warnings.map((w) => w.ctx.extra.path), ['/api/gv-agent/pending', '/api/gv-agent/status'],
      'one warning per path');

    clock += WINDOW_MS - 1;
    await refuse('GET', '/api/gv-agent/pending');
    assert.equal(warnings.length, 2, 'still inside the window');
    clock += 1;
    await refuse('GET', '/api/gv-agent/pending');
    assert.equal(warnings.length, 3, 'a new window warns again');
    assert.equal(warnings[2].ctx.extra.path, '/api/gv-agent/pending');

    // Paths no route serves share one bucket, so made-up paths can neither
    // flood Sentry nor grow the throttle's memory.
    await refuse('GET', '/api/gv-agent/nope-1');
    await refuse('GET', '/api/gv-agent/nope-2');
    assert.equal(warnings.length, 4);
    assert.equal(warnings[3].ctx.extra.path, '/api/gv-agent/nope-1');
  } finally {
    gvAgentRouter.__setDeps({ now: Date.now });
  }
});

test('right secret with flag off returns []', async () => {
  process.env.GV_AGENT_SECRET = SECRET;
  const res = await request('GET', '/api/gv-agent/pending', { secret: SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
  assert.equal(warnings.length, 0);
});
