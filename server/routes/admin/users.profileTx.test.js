require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-profile-tx-test';

/**
 * PUT /api/admin/users/:id/profile writes contractor_profiles and
 * payment_profiles in ONE transaction on one held connection (audit
 * 2026-11-05, POUT-09).
 *
 * The two upserts ran as two autocommits. A transient failure on the second
 * left the new hourly rate saved while the bank and method change was lost,
 * behind a 500 the admin reads as "nothing saved". The route now opens one
 * transaction on a held client, writes both rows, commits, and only then
 * refreshes the display name and reads the rows back on the same client
 * (one connection per request, released before the response), with the
 * geocode started after the release.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query and pool.connect replaced by in-memory stubs keyed on the SQL
 * text (the stripePayoutSync.unconfigured.test.js pattern), recording every
 * statement the transaction client sees. No database.
 *
 * Run: node --test server/routes/admin/users.profileTx.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.profileTx.test.js refuses to run against production');
}

const ADMIN_ID = 701;
const SUBJECT_ID = 702;

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
let clientLog;        // every statement the transaction client ran, in order
let poolWrites;       // every INSERT/UPDATE issued on the bare pool
let connects;         // pool.connect() calls
let releases;         // client.release() calls
let failPaymentUpsert; // when true the payment_profiles upsert throws

function head(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 40);
}

function answerPool(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    return {
      rows: [{
        id: ADMIN_ID, email: 'admin-tx@example.com', role: 'admin', onboarding_status: 'approved',
        can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT preferred_payment_method, venmo_handle')) {
    return { rows: [{ preferred_payment_method: null, zelle_handle: 'subject@example.com' }], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE) /.test(sql)) poolWrites.push({ sql, params });
  return { rows: [], rowCount: 0 };
}

function answerClient(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  clientLog.push(head(sql));
  if (sql.startsWith('INSERT INTO payment_profiles') && failPaymentUpsert) {
    return Promise.reject(new Error('induced: connection reset on the second write'));
  }
  if (sql.startsWith('SELECT * FROM contractor_profiles')) {
    return Promise.resolve({ rows: [{ user_id: SUBJECT_ID, hourly_rate: '25.00' }], rowCount: 1 });
  }
  if (sql.startsWith('SELECT * FROM payment_profiles')) {
    return Promise.resolve({ rows: [{ user_id: SUBJECT_ID, preferred_payment_method: 'zelle' }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 1 });
}

function put(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${jwt.sign({ userId: ADMIN_ID, tokenVersion: 0 }, process.env.JWT_SECRET)}`,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answerPool(text, params));
  pool.connect = () => {
    connects += 1;
    return Promise.resolve({ query: answerClient, release: () => { releases += 1; } });
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  clientLog = []; poolWrites = []; connects = 0; releases = 0; failPaymentUpsert = false;
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

const PATH = `/api/admin/users/${SUBJECT_ID}/profile`;
const BODY = { hourly_rate: 25, preferred_payment_method: 'zelle', payment_username: 'subject' };

test('both upserts run inside one transaction on one held client, released before the response', async () => {
  const r = await put(PATH, BODY);
  assert.equal(r.status, 200, r.raw);
  assert.equal(connects, 1, 'one connection for the request');
  assert.equal(releases, 1, 'released exactly once');
  assert.deepEqual(poolWrites, [], 'no write goes through the bare pool');
  const begin = clientLog.indexOf('BEGIN');
  const contractor = clientLog.findIndex((s) => s.startsWith('INSERT INTO contractor_profiles'));
  const payment = clientLog.findIndex((s) => s.startsWith('INSERT INTO payment_profiles'));
  const commit = clientLog.indexOf('COMMIT');
  assert.ok(begin >= 0 && contractor > begin && payment > contractor && commit > payment,
    `BEGIN, contractor upsert, payment upsert, COMMIT in that order: ${JSON.stringify(clientLog)}`);
  assert.equal(r.body.profile.hourly_rate, '25.00');
  assert.equal(r.body.payment.preferred_payment_method, 'zelle');
});

test('a failing second write rolls the first back: no COMMIT, a ROLLBACK, the client released, a 500', async () => {
  failPaymentUpsert = true;
  const r = await put(PATH, BODY);
  assert.equal(r.status, 500, r.raw);
  assert.ok(clientLog.some((s) => s.startsWith('INSERT INTO contractor_profiles')), 'the first write ran');
  assert.ok(!clientLog.includes('COMMIT'), 'nothing committed');
  assert.ok(clientLog.includes('ROLLBACK'), 'the transaction rolled back, so the hourly rate is not saved alone');
  assert.equal(releases, 1, 'the client is released on the failure path too');
  assert.deepEqual(poolWrites, []);
});

test('a method outside the shared set is a 400 before any transaction is opened', async () => {
  const r = await put(PATH, { ...BODY, preferred_payment_method: 'vemno' });
  assert.equal(r.status, 400, r.raw);
  assert.ok(r.body.fieldErrors.preferred_payment_method);
  assert.equal(connects, 0, 'no connection taken');
  assert.deepEqual(poolWrites, []);
});
