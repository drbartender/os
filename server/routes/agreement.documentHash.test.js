// The staff sign stores the sha256 of the agreement text it was signed under
// (audit ESIG-10): the row carries its own evidence of what the version
// string pointed to on the day, beside the version pin in
// server/data/contractorAgreement.test.js.
//
// Harness of agreement.signatureIp.test.js: no database, the pool's
// query/connect answered by a recorder, R2 and email stubbed at the module
// boundary, the real router over real HTTP.
//
// Run: node --test server/routes/agreement.documentHash.test.js

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
stubModule('../utils/storage', {
  uploadFile: async () => {},
  getSignedUrl: async (key) => `https://r2.invalid/${key}`,
  readFile: async () => { throw new Error('agreement.documentHash.test: nothing reads R2'); },
});
stubModule('../utils/email', { sendEmail: async () => ({ id: 'stub' }) });
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const USER = { id: 4245, email: 'signer@example.com', role: 'staff', onboarding_status: 'in_progress', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const calls = [];

function rowFromStatement(sql, params) {
  const row = {};
  const ins = sql.match(/INSERT INTO agreements\s*\(([^)]*)\)/i);
  if (ins) {
    ins[1].split(',').map((c) => c.trim()).forEach((col, i) => { row[col] = params[i]; });
  } else {
    for (const m of sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) row[m[1]] = params[Number(m[2]) - 1];
  }
  row.id = 80;
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
  if (/INSERT INTO agreement_signatures/.test(sql)) return { rows: [{ id: 9004 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const router = require('./agreement');
const contractorAgreement = require('../data/contractorAgreement');
const { CURRENT_VERSION, getCurrentAgreement } = contractorAgreement;

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signBody = {
  full_name: 'Test Signer', email: 'signer@example.com', phone: '5550001234', sms_consent: true,
  ack_ic_status: true, ack_commitment: true, ack_non_solicit: true,
  ack_damage_recoupment: true, ack_legal_protections: true, ack_field_guide: true,
  signature_data: `data:image/png;base64,${PNG_1X1}`, signature_method: 'draw', version: CURRENT_VERSION,
};

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

test('the sign stores the sha256 of the current agreement text on the row', async () => {
  calls.length = 0;
  const res = await post('/api/agreement', signBody);
  assert.equal(res.status, 200, res.raw);
  const row = writtenRow();
  // The pin's own reading of the text (contractorAgreement.test.js): sha256
  // of the frozen version object as JSON.
  const expected = require('node:crypto').createHash('sha256').update(JSON.stringify(getCurrentAgreement())).digest('hex');
  assert.equal(row.signature_document_version, CURRENT_VERSION);
  assert.equal(row.signature_document_sha256, expected, 'the row carries the hash of the text it was signed under');
  assert.equal(res.body.agreement.signature_document_sha256, expected);
  assert.equal(typeof contractorAgreement.agreementVersionSha256, 'function', 'the route and the pin share one hash');
  assert.equal(contractorAgreement.agreementVersionSha256(getCurrentAgreement()), expected);
});
