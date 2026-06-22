// Auth tests for the Thumbtack email-harvester agent router. Proves the agent-secret
// gate is timing-safe and FAILS CLOSED in every environment (unlike the webhook's
// warn-and-allow-in-dev), and that the email-harvested writeback also accepts a valid
// admin/manager JWT (the manual-paste UI path). Exercises the exported middlewares on a
// throwaway express app (no rate limiter), against the dev DB for the JWT user lookups.
// Run ALONE (shared dev DB).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const agentRouter = require('./thumbtackAgent');
const { agentSecretOnly, agentOrAdmin } = agentRouter;

if (process.env.NODE_ENV === 'production') {
  throw new Error('thumbtackAgent.test.js refuses to run against production');
}

const PREFIX = 'tta-auth-test-';
const SECRET = `agent-secret-${Date.now()}-abcdefghijklmnop`;
const ORIG_SECRET = process.env.THUMBTACK_AGENT_SECRET;
let server, baseUrl, adminId, adminToken, staffId, staffToken;

function reqWith(path, { token, agentSecret } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (agentSecret) headers['x-thumbtack-agent-secret'] = agentSecret;
    const r = http.request(
      { method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  process.env.THUMBTACK_AGENT_SECRET = SECRET;
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','admin','approved') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
    [`${PREFIX}staff@example.com`]
  );
  staffId = s.rows[0].id;
  staffToken = jwt.sign({ userId: staffId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.get('/agent-only', agentSecretOnly, (req, res) => res.json({ ok: true, isAgent: req.isAgent === true }));
  app.get('/agent-or-admin', agentOrAdmin, (req, res) => res.json({ ok: true, isAgent: req.isAgent === true, role: req.user?.role || null }));
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (ORIG_SECRET === undefined) delete process.env.THUMBTACK_AGENT_SECRET;
  else process.env.THUMBTACK_AGENT_SECRET = ORIG_SECRET;
  if (server) await new Promise((r) => server.close(r));
  const ids = [adminId, staffId].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
});

test('agentSecretOnly: correct secret → 200 and flags req.isAgent', async () => {
  const r = await reqWith('/agent-only', { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.isAgent, true);
});

test('agentSecretOnly: wrong secret → 401 NO_AGENT_SECRET', async () => {
  const r = await reqWith('/agent-only', { agentSecret: 'not-the-secret' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_AGENT_SECRET');
});

test('agentSecretOnly: missing header → 401', async () => {
  const r = await reqWith('/agent-only', {});
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_AGENT_SECRET');
});

test('agentSecretOnly: FAILS CLOSED when THUMBTACK_AGENT_SECRET is unset — even in non-production', async () => {
  assert.notEqual(process.env.NODE_ENV, 'production'); // this is the dev case the webhook would ALLOW
  delete process.env.THUMBTACK_AGENT_SECRET;
  try {
    const r = await reqWith('/agent-only', { agentSecret: SECRET });
    assert.equal(r.status, 401, 'agent routes must reject when the secret is unset, in every env');
    assert.equal(r.body.code, 'NO_AGENT_SECRET');
  } finally {
    process.env.THUMBTACK_AGENT_SECRET = SECRET;
  }
});

test('agentOrAdmin: correct agent secret → 200 (agent path)', async () => {
  const r = await reqWith('/agent-or-admin', { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.isAgent, true);
});

test('agentOrAdmin: valid admin JWT → 200 (manual-paste path), not flagged as agent', async () => {
  const r = await reqWith('/agent-or-admin', { token: adminToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.equal(r.body.role, 'admin');
  assert.equal(r.body.isAgent, false);
});

test('agentOrAdmin: staff JWT → 403 (not admin/manager)', async () => {
  const r = await reqWith('/agent-or-admin', { token: staffToken });
  assert.equal(r.status, 403);
});

test('agentOrAdmin: no secret and no token → 401 (falls through to auth)', async () => {
  const r = await reqWith('/agent-or-admin', {});
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_TOKEN');
});
