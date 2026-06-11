require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { clientAuth } = require('../middleware/auth');
const clientAuthRouter = require('./clientAuth');

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientAuth.revocation.test.js refuses to run against production');
}

// Audit sec-portals-auth (A07): clientAuth had no server-side session-revocation lever — an
// OTP-issued client JWT lived its full 7-day expiry with no kill switch. This proves the
// token_version gate: the JWT now embeds the client's token_version, clientAuth rejects a
// JWT whose version is behind the row's, and legacy (pre-feature) JWTs still pass so the
// deploy doesn't force every active client to re-authenticate.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const emailFor = (tag) => `clientrev-${tag}-${NONCE}@example.com`;

let server, baseUrl, clientId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, token_version) VALUES ($1, $2, 0) RETURNING id`,
    ['ClientRev Gate', emailFor('gate')]
  );
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.get('/client-protected', clientAuth, (req, res) => res.json({ ok: true, id: req.user.id }));
  app.use('/api/client-auth', clientAuthRouter);
  // Mirror the real global error middleware (server/index.js): AppError → { error, code }.
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [`clientrev-%-${NONCE}@example.com`]);
  await pool.end();
});

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === undefined || body === null) ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Craft a client JWT directly so the gate can be exercised in isolation. payloadExtra lets a
// test omit tokenVersion (legacy) or set it stale.
function clientToken(id, payloadExtra) {
  return jwt.sign({ id, email: 'x@x', role: 'client', ...payloadExtra }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

test('clientAuth: token_version matching the row passes (200)', async () => {
  const r = await request('GET', '/client-protected', { token: clientToken(clientId, { tokenVersion: 0 }) });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.id, clientId);
});

test('clientAuth: stale token_version (behind the row) → 401 TOKEN_VERSION_MISMATCH', async () => {
  await pool.query('UPDATE clients SET token_version = 3 WHERE id = $1', [clientId]);
  const r = await request('GET', '/client-protected', { token: clientToken(clientId, { tokenVersion: 0 }) });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'TOKEN_VERSION_MISMATCH');
  await pool.query('UPDATE clients SET token_version = 0 WHERE id = $1', [clientId]);
});

test('clientAuth: legacy JWT with no tokenVersion claim still passes when the row is 0 (backward-compat)', async () => {
  const r = await request('GET', '/client-protected', { token: clientToken(clientId, {}) });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('/verify embeds the client current token_version into the issued JWT', async () => {
  const otp = '123456';
  const hash = await bcrypt.hash(otp, 12);
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const e = emailFor('embed');
  await pool.query(
    `INSERT INTO clients (name, email, token_version, auth_token, auth_token_expires_at, auth_token_attempts)
     VALUES ($1, $2, 7, $3, $4, 0)`,
    ['ClientRev Embed', e, hash, expires]
  );
  const r = await request('POST', '/api/client-auth/verify', { body: { email: e, otp } });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.tokenVersion, 7, `expected embedded tokenVersion 7, got ${decoded.tokenVersion}`);
});
