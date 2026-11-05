// The staff agreement sign validates its signer fields (audit ESIG-13): a
// name or email over the column width used to reach Postgres and 500 (22001),
// an email with no shape was stored and the only copy of the contract mailed
// to it, the phone skipped the shared phone helper, and the acknowledgments
// were `!!`-coerced so the string "false" recorded as acknowledged.
//
// Harness of agreement.signatureIp.test.js: no database, the pool's
// query/connect answered by a recorder, R2 and email stubbed at the module
// boundary, the real router over real HTTP.
//
// Run: node --test server/routes/agreement.signerFields.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'agreement-test-secret';
delete process.env.SENTRY_DSN_SERVER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [] };
}
const emails = [];
stubModule('../utils/storage', {
  uploadFile: async () => {},
  getSignedUrl: async (key) => `https://r2.invalid/${key}`,
  readFile: async () => { throw new Error('agreement.signerFields.test: nothing reads R2'); },
});
stubModule('../utils/email', { sendEmail: async (args) => { emails.push(args); return { id: 'stub' }; } });
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const USER = { id: 4243, email: 'signer@example.com', role: 'staff', onboarding_status: 'in_progress', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const calls = [];

function rowFromStatement(sql, params) {
  const row = {};
  const ins = sql.match(/INSERT INTO agreements\s*\(([^)]*)\)/i);
  if (ins) {
    ins[1].split(',').map((c) => c.trim()).forEach((col, i) => { row[col] = params[i]; });
  } else {
    for (const m of sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) row[m[1]] = params[Number(m[2]) - 1];
  }
  row.id = 78;
  row.signed_at = new Date();
  return row;
}
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [USER], rowCount: 1 };
  if (/FROM agreements WHERE user_id = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/INSERT INTO agreements\b/.test(sql) || (/UPDATE agreements SET/.test(sql) && /RETURNING \*/.test(sql))) {
    return { rows: [rowFromStatement(sql, params)], rowCount: 1 };
  }
  if (/INSERT INTO agreement_signatures/.test(sql)) return { rows: [{ id: 9002 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const router = require('./agreement');
const { CURRENT_VERSION } = require('../data/contractorAgreement');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signBody = (extra = {}) => ({
  full_name: 'Test Signer',
  email: 'signer@example.com',
  phone: '(555) 000-1234',
  sms_consent: true,
  ack_ic_status: true, ack_commitment: true, ack_non_solicit: true,
  ack_damage_recoupment: true, ack_legal_protections: true, ack_field_guide: true,
  signature_data: `data:image/png;base64,${PNG_1X1}`,
  signature_method: 'draw',
  version: CURRENT_VERSION,
  ...extra,
});

let server; let baseUrl; let token;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
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
    req.write(payload);
    req.end();
  });
}

const wroteRow = () => calls.some((c) => /INSERT INTO agreements\b|UPDATE agreements SET/.test(c.sql));
const writtenRow = () => calls.filter((c) => /INSERT INTO agreements\b|UPDATE agreements SET/.test(c.sql) && /RETURNING \*/.test(c.sql)).map((c) => rowFromStatement(c.sql, c.params)).pop();

before(async () => {
  token = jwt.sign({ userId: USER.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
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

async function expect400(body, field) {
  calls.length = 0;
  const res = await post('/api/agreement', body);
  assert.equal(res.status, 400, `${field}: ${res.raw}`);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors[field], `${field}: a field error names it (${res.raw})`);
  assert.ok(!wroteRow(), `${field}: nothing was written`);
}

test('a 300-character name is a 400 naming full_name, never a write', async () => {
  await expect400(signBody({ full_name: 'A'.repeat(300) }), 'full_name');
});

test('a one-character name is a 400 naming full_name', async () => {
  await expect400(signBody({ full_name: 'A' }), 'full_name');
});

test('an email with no shape or over the column width is a 400 naming email', async () => {
  await expect400(signBody({ email: 'not-an-address' }), 'email');
  await expect400(signBody({ email: `${'a'.repeat(250)}@example.com` }), 'email');
});

test('a phone that is not a 10-digit number is a 400 naming phone', async () => {
  await expect400(signBody({ phone: '12345' }), 'phone');
});

test('the string "false" and a non-boolean truthy value do not count as an acknowledgment', async () => {
  await expect400(signBody({ ack_non_solicit: 'false' }), 'ack_non_solicit');
  await expect400(signBody({ ack_legal_protections: 'yes' }), 'ack_legal_protections');
  await expect400(signBody({ ack_field_guide: 1 }), 'ack_field_guide');
});

test('a well-formed sign stores the trimmed name and email, the 10-digit phone, and only a true sms_consent', async () => {
  calls.length = 0;
  const res = await post('/api/agreement', signBody({ full_name: '  Test Signer  ', email: ' Signer@Example.com ', sms_consent: 'false' }));
  assert.equal(res.status, 200, res.raw);
  const row = writtenRow();
  assert.equal(row.full_name, 'Test Signer');
  assert.equal(row.email, 'Signer@Example.com');
  assert.equal(row.phone, '5550001234');
  assert.equal(row.sms_consent, false, 'the string "false" is not consent');
  for (const ack of ['ack_ic_status', 'ack_commitment', 'ack_non_solicit', 'ack_damage_recoupment', 'ack_legal_protections', 'ack_field_guide']) {
    assert.equal(row[ack], true);
  }
});

test('an empty phone stays optional', async () => {
  calls.length = 0;
  const res = await post('/api/agreement', signBody({ phone: '' }));
  assert.equal(res.status, 200, res.raw);
  assert.equal(writtenRow().phone, null);
});
