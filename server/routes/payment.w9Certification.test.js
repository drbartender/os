// The electronic W-9's certification event is recorded server-side (audit
// ESIG-07): when a new W-9 file arrives, POST /api/payment writes
// w9_submitted_at, the proxy-validated address, the user agent, the form
// revision the fill-mode page drew and the signature method ('draw' or
// 'type' in fill mode, 'upload' for a scanned form) beside the file, in the
// same transaction as the profile; a reuse of the stored file records
// nothing new; the TIN never reaches a column or a log.
//
// No database: the pool's query/connect are answered by a recorder (every
// statement kept with the client it ran on), R2 is stubbed at the module
// boundary, getStripe is nulled (the payment.noNameWrite.test.js guard), the
// real router runs behind the real express-fileupload with a hand-built
// multipart body over real HTTP, with `trust proxy` set as in server/index.js.
//
// Run: node --test server/routes/payment.w9Certification.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'payment-test-secret';
delete process.env.SENTRY_DSN_SERVER;

// LIVE-STRIPE GUARD (payment.noNameWrite.test.js): the route's tail creates a
// Payment Link through getStripe(); null means no client is ever built.
require('../utils/stripeClient').getStripe = () => null;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');

function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [] };
}
const uploads = [];
stubModule('../utils/storage', {
  uploadFile: async (buf, key) => { uploads.push({ key, bytes: buf.length }); },
  getSignedUrl: async (key) => `https://r2.invalid/${key}`,
  readFile: async () => { throw new Error('payment.w9Certification.test: nothing reads R2'); },
});
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const USER = { id: 4250, email: 'recruit@example.com', role: 'staff', onboarding_status: 'in_progress', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
// A "W-9" PDF whose bytes carry a marker that must never reach a query.
const TIN_MARKER = 'TIN-MARKER-NEVER-IN-A-QUERY';
const PDF_BYTES = Buffer.from(`%PDF-1.4\n% ${TIN_MARKER}\n%%EOF`);

let existingProfile = null;
let profileRow = null;
const calls = [];
function zip(sql, params) {
  const row = {};
  const ins = sql.match(/INSERT INTO payment_profiles\s*\(([^)]*)\)/i);
  if (ins) {
    // Greedy to the statement's closing paren: a CASE ... NOW() END value holds parens of its own.
    const values = sql.match(/VALUES\s*\(([\s\S]*)\)/i)[1].split(',').map((s) => s.trim());
    ins[1].split(',').map((c) => c.trim()).forEach((col, i) => {
      const m = /^\$(\d+)/.exec(values[i] || '');
      row[col] = m ? params[Number(m[1]) - 1] : values[i];
    });
  }
  return row;
}
function answer(via, sql, params) {
  calls.push({ via, sql, params });
  if (/FROM users WHERE id\s*=\s*\$1/.test(sql) && /SELECT id, email, role/.test(sql)) return { rows: [USER], rowCount: 1 };
  if (/FROM payment_profiles WHERE user_id = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) {
    if (/SELECT \* FROM payment_profiles/.test(sql)) return profileRow ? { rows: [profileRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    return existingProfile ? { rows: [existingProfile], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO payment_profiles/.test(sql)) { profileRow = { id: 1, ...zip(sql, params) }; return { rows: [], rowCount: 1 }; }
  if (/^\s*UPDATE payment_profiles\s+SET preferred_payment_method/.test(sql)) { profileRow = { id: 1, user_id: USER.id, ...(existingProfile || {}) }; return { rows: [], rowCount: 1 }; }
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer('pool', sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer('client', sql, params), release() {} });

const router = require('./payment');

let server; let baseUrl; let token;

/** multipart/form-data with text fields and an optional file part. */
function multipart(fields, file) {
  const boundary = `----w9cert${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="w9"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`));
    parts.push(file.bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}
function post(fields, file, headers = {}) {
  return new Promise((resolve, reject) => {
    const { body, boundary } = multipart(fields, file);
    const u = new URL(`${baseUrl}/api/payment`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length,
        Authorization: `Bearer ${token}`, 'User-Agent': 'w9-cert-test-agent', ...headers,
      },
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
    req.write(body);
    req.end();
  });
}
const profileWrite = () => calls.find((c) => /INSERT INTO payment_profiles/.test(c.sql) || /^\s*UPDATE payment_profiles\s+SET preferred_payment_method/.test(c.sql));

before(async () => {
  token = jwt.sign({ userId: USER.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(fileUpload({ useTempFiles: false }));
  app.use('/api/payment', router);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => { calls.length = 0; uploads.length = 0; existingProfile = null; profileRow = null; });

test('a fill-mode W-9 records the certification event in the profile write: proxy ip, user agent, form revision, method, submitted now', async () => {
  const res = await post(
    { preferred_payment_method: 'check', payment_username: '', w9_signature_method: 'draw', w9_form_revision: 'Rev. March 2024' },
    { name: 'W9_Test.pdf', bytes: PDF_BYTES },
    { 'X-Forwarded-For': '1.2.3.4, 10.0.0.9' }
  );
  assert.equal(res.status, 200, res.raw);
  const w = profileWrite();
  assert.ok(w, 'the profile was written');
  assert.equal(w.via, 'client', 'inside the transaction');
  assert.ok(calls.findIndex((c) => c.sql === 'BEGIN') < calls.indexOf(w) && calls.indexOf(w) < calls.findIndex((c) => c.sql === 'COMMIT'));
  const row = profileRow;
  assert.equal(row.w9_submit_ip, '10.0.0.9', 'the proxy-validated address, not the forgeable first hop');
  assert.equal(row.w9_submit_ua, 'w9-cert-test-agent');
  assert.equal(row.w9_form_revision, 'Rev. March 2024');
  assert.equal(row.w9_signature_method, 'draw');
  assert.match(String(row.w9_submitted_at), /NOW\(\)/, 'submitted_at is the server clock');
  assert.equal(uploads.length, 1, 'the file went to storage');
  for (const c of calls) {
    for (const p of c.params || []) assert.ok(!String(p).includes(TIN_MARKER), 'nothing from inside the PDF reaches a query');
  }
});

test('a scanned upload records method upload with no revision; an unknown method is recorded as nothing', async () => {
  let res = await post({ preferred_payment_method: 'check', w9_signature_method: 'upload', w9_form_revision: '' }, { name: 'scan.pdf', bytes: PDF_BYTES });
  assert.equal(res.status, 200, res.raw);
  assert.equal(profileRow.w9_signature_method, 'upload');
  assert.equal(profileRow.w9_form_revision, null);

  calls.length = 0; profileRow = null;
  res = await post({ preferred_payment_method: 'check', w9_signature_method: 'javascript', w9_form_revision: 'x'.repeat(60) }, { name: 'scan.pdf', bytes: PDF_BYTES });
  assert.equal(res.status, 200, res.raw);
  assert.equal(profileRow.w9_signature_method, null, 'a value outside draw/type/upload is not recorded');
  assert.ok(String(profileRow.w9_form_revision).length <= 20, 'the revision is bounded to its column');
});

test('a submit that reuses the stored W-9 keeps the recorded certification untouched', async () => {
  existingProfile = { id: 1, user_id: USER.id, w9_file_url: '/files/4250_w9_old.pdf', w9_filename: 'old.pdf', has_routing: false, has_account: false, w9_submitted_at: new Date('2026-03-01T15:00:00Z'), w9_submit_ip: '10.0.0.1', w9_submit_ua: 'old-agent', w9_form_revision: 'Rev. March 2024', w9_signature_method: 'type' };
  const res = await post({ preferred_payment_method: 'check', w9_signature_method: 'draw', w9_form_revision: 'Rev. March 2024' }, null);
  assert.equal(res.status, 200, res.raw);
  const w = profileWrite();
  assert.ok(w && /^\s*UPDATE payment_profiles/.test(w.sql), 'the existing profile was updated');
  assert.equal(uploads.length, 0, 'no new file');
  // The UPDATE carries the "new file" flag false, so every certification column keeps its stored value.
  const flagIndex = w.params.findIndex((p) => p === false || p === true);
  assert.ok(flagIndex >= 0, 'the UPDATE carries a boolean flag for a new W-9');
  assert.match(w.sql, /w9_submitted_at\s*=\s*CASE WHEN \$\d+::boolean THEN NOW\(\) ELSE w9_submitted_at END/);
  assert.ok(!w.params.includes('draw'), 'the body\'s method is not written on a reuse');
});
