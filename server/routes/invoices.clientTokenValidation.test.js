require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.clientTokenValidation.test.js refuses to run against production');
}

// Audit (invoices.js:318): GET /client/:proposalToken passed the raw param straight into
// `WHERE p.token = $1`. proposals.token is UUID, so a non-UUID string casts-and-throws
// (Postgres 22P02) -> 500, instead of the graceful empty list the public /t/:token route
// returns via its UUID_RE guard. This proves a non-UUID token now yields 200 { invoices: [] }
// without a DB error, and a valid UUID still flows through to the query.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, clientId, clientToken;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, token_version) VALUES ('InvTok Test', $1, 0) RETURNING id`,
    [`invtok-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  clientToken = jwt.sign({ id: clientId, email: 'x@x', role: 'client', tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

test('GET /client/:proposalToken with a non-UUID token returns 200 { invoices: [] } (no DB error)', async () => {
  const r = await get('/api/invoices/client/not-a-uuid', clientToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { invoices: [] });
});

test('GET /client/:proposalToken with a valid UUID (no match) still returns 200 { invoices: [] }', async () => {
  const r = await get(`/api/invoices/client/${crypto.randomUUID()}`, clientToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { invoices: [] });
});
