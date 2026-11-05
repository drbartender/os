require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-agreement-scrub-test';

/**
 * GET /api/admin/users/:id keeps the signature's forensic columns on the
 * server and the signature itself admin-only (audit 2026-11-05, AUTH-10).
 *
 * The route returned the whole agreements row as `agreement`, so a manager
 * received every staffer's signature image (or typed signature), the IP the
 * agreement was signed from and the signing browser's user agent, while the
 * same least-privilege block withheld the payment row. No client surface
 * reads signature_ip or signature_user_agent, so they are stripped for
 * everyone; the admin Documents tab renders signature_data, so it is stripped
 * for a manager only.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query replaced by an in-memory stub keyed on the SQL text (the
 * stripePayoutSync.unconfigured.test.js pattern). No database. The DB-backed
 * sibling users.managerScrub.test.js asserts the same against Postgres.
 *
 * Run: node --test server/routes/admin/users.agreementScrub.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.agreementScrub.test.js refuses to run against production');
}

const ADMIN_ID = 901;
const MANAGER_ID = 902;
const SUBJECT_ID = 903;
const ROLES = { [ADMIN_ID]: 'admin', [MANAGER_ID]: 'manager' };

// A drawn signature stub, a documentation-range IP and a plain UA: fixture
// shapes only, no person's data.
const AGREEMENT = {
  id: 1, user_id: SUBJECT_ID, full_name: 'Subject Sam', sms_consent: true,
  signature_data: 'data:image/png;base64,AAAA', signature_method: 'draw',
  signature_ip: '203.0.113.7', signature_user_agent: 'Mozilla/5.0 (fixture)',
  signed_at: '2026-10-01T15:00:00.000Z',
};

let server, baseUrl;
const realQuery = pool.query;

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  // The record's own user read comes first: it shares the auth read's prefix.
  if (sql.startsWith('SELECT id, email, role, onboarding_status, can_hire, can_staff, created_at')) {
    return { rows: [{ id: SUBJECT_ID, email: 'subject-scrub@example.com', role: 'staff', onboarding_status: 'approved' }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    const role = ROLES[params[0]];
    if (!role) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: params[0], email: `user${params[0]}@example.com`, role, onboarding_status: 'approved',
        can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT * FROM agreements')) return { rows: [{ ...AGREEMENT }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

function get(path, id) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET)}` },
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

test('a manager gets the agreement without the signature, the IP or the user agent', async () => {
  const r = await get(`/api/admin/users/${SUBJECT_ID}`, MANAGER_ID);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.agreement.signed_at, AGREEMENT.signed_at, 'the signed state still flows');
  assert.equal(r.body.agreement.sms_consent, true);
  for (const k of ['signature_data', 'signature_ip', 'signature_user_agent']) {
    assert.ok(!(k in r.body.agreement), `${k} must not reach a manager`);
  }
  assert.ok(!JSON.stringify(r.body).includes('203.0.113.7'), 'the IP appears nowhere in the response');
});

test('an admin keeps the signature the Documents tab renders, and still never the IP or the user agent', async () => {
  const r = await get(`/api/admin/users/${SUBJECT_ID}`, ADMIN_ID);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.agreement.signature_data, AGREEMENT.signature_data);
  assert.equal(r.body.agreement.signature_method, 'draw');
  for (const k of ['signature_ip', 'signature_user_agent']) {
    assert.ok(!(k in r.body.agreement), `${k} is read by no client surface and stays on the server`);
  }
});
