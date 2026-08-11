require('dotenv').config();
process.env.NODE_ENV = 'test';

// Route tests for GET /api/clients.
//
// WHY THIS FILE EXISTS
// --------------------
// Before this, NO test anywhere touched server/routes/clients.js, which serves
// the live ClientsDashboard. The marketing work adds a column to its explicit
// SELECT allowlist, and a typo in that SQL string would ship green: requiring
// the module only proves it parses, and querying the column directly only
// proves the schema, not the route.
//
// Response shape verified against the source, not assumed: this route returns a
// BARE ARRAY (res.json(result.rows)), not { clients: [...] }, and its search
// predicate is ILIKE over name/email/phone.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const router = require('./clients');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, managerToken, clientId;

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`cl-admin-${NONCE}@mkt-test.example`]
  );
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`cl-mgr-${NONCE}@mkt-test.example`]
  );
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`CL ${NONCE}`, `cl-${NONCE}@mkt-test.example`]
  );
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/clients', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`cl-%-${NONCE}@mkt-test.example`]);
  server.close();
  await pool.end();
});

const findMine = (body) => body.find(c => c.id === clientId);

test('the list returns marketing_excluded', async () => {
  const r = await req('GET', `/api/clients?search=${NONCE}`, adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), 'this route returns a bare array');
  const row = findMine(r.body);
  assert.ok(row, 'fixture client missing from the list');
  assert.equal(row.marketing_excluded, false);
});

test('it reflects an exclusion', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'list test'
      WHERE id = $1`, [clientId]);
  const r = await req('GET', `/api/clients?search=${NONCE}`, adminToken);
  assert.equal(findMine(r.body).marketing_excluded, true);
});

test('the list omits the exclusion reason (payload slimness, not a boundary)', async () => {
  // Deliberately NOT framed as a privacy guarantee: GET /clients/:id is
  // SELECT * and PUT /clients/:id returns *, both behind this same
  // requireAdminOrManager guard. Asserting a boundary the system does not
  // enforce is worse than asserting nothing.
  const r = await req('GET', `/api/clients?search=${NONCE}`, adminToken);
  assert.equal(findMine(r.body).marketing_excluded_reason, undefined);
  // Restore, so this file leaves the shared dev DB as it found it.
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL
      WHERE id = $1`, [clientId]);
});

test('the pre-existing aggregates still come back', async () => {
  // The allowlist edit sits between the column list and the events/lifetime
  // LATERAL; a botched comma would take these out with it.
  const r = await req('GET', `/api/clients?search=${NONCE}`, adminToken);
  const row = findMine(r.body);
  assert.equal(typeof row.events_count, 'number');
  assert.equal(typeof row.lifetime_value, 'number');
  assert.equal(row.name, `CL ${NONCE}`);
});

test('a manager can still read the clients list', async () => {
  const r = await req('GET', `/api/clients?search=${NONCE}`, managerToken);
  assert.equal(r.status, 200);
  assert.ok(findMine(r.body));
});

test('an unauthenticated caller cannot', async () => {
  assert.equal((await req('GET', '/api/clients', null)).status, 401);
});
