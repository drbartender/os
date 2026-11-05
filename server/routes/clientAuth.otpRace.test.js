'use strict';
// The OTP attempt ceiling is claimed before the compare (audit 2026-11-05
// AUTH-04).
//
// POST /api/client-auth/verify read auth_token_attempts, ran a ~250 ms
// bcrypt compare, and only then incremented, so N concurrent wrong guesses
// for one address all read 0, all passed the 5-attempt ceiling and all got a
// compare: with k source addresses the IP limiter (10 per address) never saw
// the burst. The increment is now the claim: a conditional UPDATE (attempts
// < 5, token present) that returns the hash, before the compare; zero rows is
// the existing invalidate-and-neutral-400 branch.
//
// Pure: the real router over real HTTP against a stubbed pool that emulates
// the four statements on one in-memory client row (the `pool.query = ...` seam
// of sms.status.test.js), with bcrypt.compare stubbed to count calls and take
// 30 ms so every request of a burst is inside the compare window. The burst
// comes from 20 addresses through X-Forwarded-For under trust proxy 1, the
// shape of the attack the IP limiter cannot see. The DB-backed siblings are
// clientAuth.otpNeutral.test.js and clientAuth.revocation.test.js.

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'otp-race-test-secret-0123456789abcdef0123456789';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const EMAIL = 'otp-race@example.com';
const row = {};
function resetRow() {
  Object.assign(row, {
    id: 1, name: 'OTP Race', email: EMAIL, phone: null,
    auth_token: 'hash-of-654321', auth_token_expires_at: new Date(Date.now() + 10 * 60 * 1000),
    auth_token_attempts: 0, token_version: 0,
  });
}

let statements = [];
const realQuery = pool.query;
const realCompare = bcrypt.compare;
let compares = 0;

// A faithful reading of the statements verify runs: the SELECT by email, the
// attempt increment (conditional on whatever predicates the SQL carries), and
// the clear. Anything else is a bug in this suite, not a silent no-op.
function answer(raw, params) {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  statements.push(text);
  if (text.startsWith('SELECT') && text.includes('FROM clients WHERE LOWER(email) = LOWER($1)')) {
    return String(params[0]).toLowerCase() === row.email ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.startsWith('UPDATE clients SET auth_token_attempts = COALESCE(auth_token_attempts, 0) + 1')) {
    if (params[0] !== row.id) return { rows: [], rowCount: 0 };
    if (text.includes('auth_token IS NOT NULL') && row.auth_token === null) return { rows: [], rowCount: 0 };
    if (text.includes('< 5') && (row.auth_token_attempts ?? 0) >= 5) return { rows: [], rowCount: 0 };
    row.auth_token_attempts = (row.auth_token_attempts ?? 0) + 1;
    const returned = text.includes('RETURNING') ? [{ auth_token: row.auth_token, auth_token_expires_at: row.auth_token_expires_at }] : [];
    return { rows: returned, rowCount: 1 };
  }
  if (text.startsWith('UPDATE clients SET auth_token = NULL')) {
    if (params[0] === row.id) {
      row.auth_token = null;
      row.auth_token_expires_at = null;
      if (text.includes('auth_token_attempts = 0')) row.auth_token_attempts = 0;
    }
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`otpRace stub: unexpected statement ${text}`);
}

let server;
let baseUrl;

function verify(body, ip) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(new URL('/api/client-auth/verify', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Forwarded-For': ip },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params || []));
  bcrypt.compare = (otp, hash) => new Promise((resolve) => {
    compares += 1;
    setTimeout(() => resolve(hash === 'hash-of-654321' && otp === '654321'), 30);
  });
  const app = express();
  app.set('trust proxy', 1); // server/index.js; req.ip is the forwarded address
  app.use(express.json());
  app.use('/api/client-auth', require('./clientAuth'));
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery;
  bcrypt.compare = realCompare;
  if (server) await new Promise((r) => server.close(r));
});

const NEUTRAL = { error: 'Validation failed', code: 'VALIDATION_ERROR', fieldErrors: { otp: 'This code is invalid or has expired' } };

test('20 concurrent wrong guesses from 20 addresses get at most 5 compares, and the OTP is invalidated', async () => {
  resetRow();
  compares = 0;
  statements = [];
  const burst = Array.from({ length: 20 }, (_, i) => verify({ email: EMAIL, otp: '000000' }, `203.0.113.${i + 1}`));
  const results = await Promise.all(burst);
  for (const r of results) {
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.code, 'VALIDATION_ERROR');
    assert.deepEqual(r.body.fieldErrors, NEUTRAL.fieldErrors);
  }
  assert.ok(compares <= 5, `the ceiling allows 5 compares, ${compares} ran`);
  assert.equal(row.auth_token, null, 'the OTP is invalidated once the ceiling is hit');
  assert.equal(row.auth_token_attempts, 0, 'the counter is reset with the invalidation');
  assert.ok(
    !statements.some((s) => s.startsWith('UPDATE clients SET auth_token_attempts') && !s.includes('RETURNING')),
    'no unconditional post-compare increment remains'
  );
});

test('the ceiling and the unknown-email answer are byte-identical (the oracle stays closed)', async () => {
  resetRow();
  row.auth_token_attempts = 5;
  const ceiling = await verify({ email: EMAIL, otp: '000000' }, '203.0.113.50');
  const unknown = await verify({ email: 'nobody-here@example.com', otp: '000000' }, '203.0.113.51');
  assert.equal(ceiling.status, 400);
  assert.deepEqual(ceiling.body, unknown.body);
  assert.equal(row.auth_token, null, 'the ceiling branch still invalidates');
});

test('the right code within the ceiling still logs in and clears the token', async () => {
  resetRow();
  row.auth_token_attempts = 4;
  const r = await verify({ email: EMAIL, otp: '654321' }, '203.0.113.60');
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.body.token, 'a JWT is issued');
  assert.deepEqual(r.body.client, { id: 1, name: 'OTP Race', email: EMAIL, phone: null });
  assert.equal(row.auth_token, null);
  assert.equal(row.auth_token_attempts, 0);
});

test('a wrong code counts once and leaves the token live for the next try', async () => {
  resetRow();
  const r = await verify({ email: EMAIL, otp: '111111' }, '203.0.113.70');
  assert.equal(r.status, 400);
  assert.equal(row.auth_token_attempts, 1);
  assert.equal(row.auth_token, 'hash-of-654321');
});
