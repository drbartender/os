// The signed staff agreement is retrievable from the app (audit ESIG-04):
// the signer through GET /api/agreement/download (own key only, 404 without
// one), an admin or manager through GET /api/agreement/admin/:userId/pdf
// (the stored key must sit under agreements/<userId>/), and an admin can
// resend the signer's copy through POST /api/agreement/admin/:userId/resend-copy
// when the sign-time email never went out (pdf_email_sent_at stays NULL).
//
// Harness of agreement.signatureIp.test.js: no database, the pool's query
// answered by a recorder (users by id, agreements by user_id), R2 and email
// stubbed at the module boundary (readFile hands back a PDF buffer).
//
// Run: node --test server/routes/agreement.download.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'agreement-test-secret';
delete process.env.SENTRY_DSN_SERVER;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [] };
}
const PDF_BYTES = Buffer.from('%PDF-1.4 test agreement');
const reads = [];
const signed = [];
stubModule('../utils/storage', {
  uploadFile: async () => {},
  getSignedUrl: async (key) => { signed.push(key); return `https://r2.invalid/${key}?sig=1`; },
  readFile: async (key) => { reads.push(key); return { buffer: PDF_BYTES, contentType: 'application/pdf' }; },
});
const emails = [];
let emailFails = false;
stubModule('../utils/email', {
  sendEmail: async (args) => { if (emailFails) throw new Error('provider down'); emails.push(args); return { id: 'stub' }; },
});
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const STAFF = { id: 4248, email: 'signer@example.com', role: 'staff', onboarding_status: 'approved', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const ADMIN = { id: 7, email: 'admin@example.com', role: 'admin', onboarding_status: 'approved', can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null };
const OTHER_STAFF_ID = 4249;
const KEY = `agreements/${STAFF.id}/contractor-agreement-v3-1700000000000.pdf`;

// agreements rows by user_id, set per test.
let rows = {};
const calls = [];
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) {
    const u = [STAFF, ADMIN].find((x) => x.id === Number(params[0]));
    return u ? { rows: [u], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/FROM agreements WHERE user_id = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) {
    const r = rows[params[0]];
    return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const router = require('./agreement');

let server; let baseUrl;
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
function request(method, path, user) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}), 'Content-Length': 0 },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/agreement', router);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => {
  calls.length = 0; reads.length = 0; signed.length = 0; emails.length = 0; emailFails = false;
  rows = {
    [STAFF.id]: { id: 1, user_id: STAFF.id, email: STAFF.email, full_name: 'Test Signer', pdf_storage_key: KEY, pdf_generated_at: new Date('2026-03-01T15:00:00Z'), pdf_email_sent_at: null },
  };
});

test('the signer downloads their own PDF: the lookup is by their own id and the presigned key is theirs', async () => {
  const res = await request('GET', '/api/agreement/download', STAFF);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.url, `https://r2.invalid/${KEY}?sig=1`);
  const lookup = calls.find((c) => /FROM agreements WHERE user_id = \$1/.test(c.sql));
  assert.deepEqual(lookup.params, [STAFF.id]);
  assert.deepEqual(signed, [KEY]);
});

test('a signer with no stored PDF gets a 404, and a request with no token a 401', async () => {
  rows = {};
  assert.equal((await request('GET', '/api/agreement/download', STAFF)).status, 404);
  assert.equal((await request('GET', '/api/agreement/download', null)).status, 401);
});

test('an admin opens a contractor\'s PDF; a staff account cannot', async () => {
  const res = await request('GET', `/api/agreement/admin/${STAFF.id}/pdf`, ADMIN);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.url, `https://r2.invalid/${KEY}?sig=1`);
  const lookup = calls.find((c) => /FROM agreements WHERE user_id = \$1/.test(c.sql) && c.params[0] === STAFF.id);
  assert.ok(lookup, 'the admin route looks the row up by the path id');

  const denied = await request('GET', `/api/agreement/admin/${STAFF.id}/pdf`, STAFF);
  assert.equal(denied.status, 403, denied.raw);
});

test('the admin route refuses a key outside agreements/<userId>/, a missing row and a malformed id', async () => {
  rows[STAFF.id].pdf_storage_key = `agreements/${OTHER_STAFF_ID}/contractor-agreement-v3-1.pdf`;
  assert.equal((await request('GET', `/api/agreement/admin/${STAFF.id}/pdf`, ADMIN)).status, 404, 'another contractor\'s key');
  rows[STAFF.id].pdf_storage_key = `agreements/${STAFF.id}/../${OTHER_STAFF_ID}/x.pdf`;
  assert.equal((await request('GET', `/api/agreement/admin/${STAFF.id}/pdf`, ADMIN)).status, 404, 'a traversal key');
  assert.equal(signed.length, 0, 'nothing was presigned');
  rows = {};
  assert.equal((await request('GET', `/api/agreement/admin/${STAFF.id}/pdf`, ADMIN)).status, 404, 'no row');
  assert.equal((await request('GET', '/api/agreement/admin/1_23/pdf', ADMIN)).status, 400, 'a malformed id');
});

test('an admin resends the signer\'s copy: the stored PDF is read under the prefix, attached, and the sent stamp written', async () => {
  const res = await request('POST', `/api/agreement/admin/${STAFF.id}/resend-copy`, ADMIN);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.sent, true);
  assert.deepEqual(reads, [KEY]);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, STAFF.email);
  assert.ok(emails[0].attachments && emails[0].attachments[0].content.equals(PDF_BYTES), 'the stored PDF is attached');
  const stamp = calls.find((c) => /UPDATE agreements SET pdf_email_sent_at\s*=\s*NOW\(\)/.test(c.sql));
  assert.ok(stamp, 'pdf_email_sent_at is stamped');
  assert.deepEqual(stamp.params, [STAFF.id]);
});

test('a resend with no stored PDF is a 404, a provider failure a 502 with no stamp, and a staff account cannot resend', async () => {
  assert.equal((await request('POST', `/api/agreement/admin/${STAFF.id}/resend-copy`, STAFF)).status, 403);
  emailFails = true;
  const failed = await request('POST', `/api/agreement/admin/${STAFF.id}/resend-copy`, ADMIN);
  assert.equal(failed.status, 502, failed.raw);
  assert.ok(!calls.some((c) => /pdf_email_sent_at\s*=\s*NOW\(\)/.test(c.sql)), 'no stamp on a failed send');
  rows = {};
  assert.equal((await request('POST', `/api/agreement/admin/${STAFF.id}/resend-copy`, ADMIN)).status, 404);
});
