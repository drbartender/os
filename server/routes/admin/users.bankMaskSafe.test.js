require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, and decrypt() only throws under a real key, so both fall back to
// fixed test values when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-bank-mask-safe-test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

/**
 * GET /api/admin/users/:id survives a bank number that cannot be decrypted
 * (audit 2026-11-05, POUT-08).
 *
 * The admin user record decrypted routing_number and account_number bare,
 * while GET /api/payment and the staff portal already degraded to a fixed
 * mask: after an ENCRYPTION_KEY rotation (there is no key id and no
 * re-encrypt path) or one corrupted row, every direct-deposit contractor's
 * record page returned 500 and the admin could open nothing on it. The two
 * sites now use the shared maskBankNumber (utils/bankNumbers.js): a bad
 * ciphertext reads '****', which round-trips as "unchanged" on save.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query replaced by an in-memory stub keyed on the SQL text (the
 * stripePayoutSync.unconfigured.test.js pattern). No database. The DB-backed
 * sibling users.bankMask.test.js covers the round trip of a good value.
 *
 * Run: node --test server/routes/admin/users.bankMaskSafe.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { encrypt, decrypt } = require('../../utils/encryption');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.bankMaskSafe.test.js refuses to run against production');
}

const ADMIN_ID = 501;
const SUBJECT_ID = 502;
// Well-formed ciphertext under some other key: decrypt() throws on the auth tag.
const UNDECRYPTABLE = `enc:${'0'.repeat(32)}:${'0'.repeat(32)}:${'0'.repeat(32)}`;
// A published Federal Reserve routing number, not anyone's account.
const GOOD_ROUTING = encrypt('011000015');

let server, baseUrl;
const realQuery = pool.query;

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  // The record's own user read comes first: it shares the auth read's prefix.
  if (sql.startsWith('SELECT id, email, role, onboarding_status, can_hire, can_staff, created_at')) {
    return { rows: [{ id: SUBJECT_ID, email: 'subject-mask@example.com', role: 'staff', onboarding_status: 'approved' }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    return {
      rows: [{
        id: ADMIN_ID, email: 'admin-mask@example.com', role: 'admin', onboarding_status: 'approved',
        can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT * FROM payment_profiles')) {
    return {
      rows: [{ user_id: SUBJECT_ID, preferred_payment_method: 'direct_deposit', routing_number: GOOD_ROUTING, account_number: UNDECRYPTABLE }],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
}

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: ADMIN_ID, tokenVersion: 0 }, process.env.JWT_SECRET)}` },
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
    r.end();
  });
}

before(async () => {
  // Fixture sanity: the stored values behave as the test claims.
  assert.throws(() => decrypt(UNDECRYPTABLE), 'premise: the bad value cannot be decrypted');
  assert.equal(decrypt(GOOD_ROUTING), '011000015', 'premise: the good value can');

  pool.query = (text, params) => Promise.resolve(answer(text, params));
  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery;
  if (server) await new Promise((r) => server.close(r));
});

test('one undecryptable bank number masks to **** and the record still loads', async () => {
  const r = await get(`/api/admin/users/${SUBJECT_ID}`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.payment.routing_number, '****0015', 'the good value masks to its last four');
  assert.equal(r.body.payment.account_number, '****', 'the bad value degrades to the bare mask, never a 500');
  assert.equal(r.body.payment.preferred_payment_method, 'direct_deposit', 'the rest of the row is intact');
  assert.equal(r.body.user.id, SUBJECT_ID);
});
