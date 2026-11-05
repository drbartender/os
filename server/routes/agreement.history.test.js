// Every staff sign appends to agreement_signatures and never erases the
// prior one (audit ESIG-08): the agreements row stays the current view, a
// history row holds each signature's version, hash, method, IP, UA, time,
// name, email, phone, SMS consent and image, the pdf key it supersedes, and
// its own pdf key once the PDF is uploaded; first_signed_at COALESCEs so a
// re-sign never moves the first signing date.
//
// Harness of agreement.signatureIp.test.js: no database, the pool's
// query/connect answered by a recorder (every statement kept with the client
// it ran on), R2 and email stubbed at the module boundary.
//
// Run: node --test server/routes/agreement.history.test.js

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
const uploads = [];
stubModule('../utils/storage', {
  uploadFile: async (buf, key) => { uploads.push(key); },
  getSignedUrl: async (key) => `https://r2.invalid/${key}`,
  readFile: async () => { throw new Error('agreement.history.test: nothing reads R2'); },
});
stubModule('../utils/email', { sendEmail: async () => ({ id: 'stub' }) });
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const USER = { id: 4247, email: 'signer@example.com', role: 'staff', onboarding_status: 'in_progress', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const OLD_KEY = `agreements/${USER.id}/contractor-agreement-v3-1700000000000.pdf`;
const FIRST_SIGNED_AT = new Date('2026-03-01T15:00:00.000Z');
let existingRow = null;
const calls = [];
const HISTORY_ID = 9006;

function rowFromStatement(sql, params) {
  const row = { ...(existingRow || {}) };
  const ins = sql.match(/INSERT INTO agreements\s*\(([^)]*)\)/i);
  if (ins) {
    ins[1].split(',').map((c) => c.trim()).forEach((col, i) => { row[col] = params[i]; });
  } else {
    for (const m of sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) row[m[1]] = params[Number(m[2]) - 1];
  }
  row.id = existingRow ? existingRow.id : 82;
  row.signed_at = new Date();
  if (!existingRow || !existingRow.first_signed_at) row.first_signed_at = row.signed_at;
  return row;
}
function answer(via, sql, params) {
  calls.push({ via, sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [USER], rowCount: 1 };
  if (/FROM agreements WHERE user_id = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) {
    return existingRow ? { rows: [existingRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO agreements\b/.test(sql) || (/UPDATE agreements SET/.test(sql) && /RETURNING \*/.test(sql))) {
    return { rows: [rowFromStatement(sql, params)], rowCount: 1 };
  }
  if (/INSERT INTO agreement_signatures/.test(sql)) return { rows: [{ id: HISTORY_ID }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer('pool', sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer('client', sql, params), release() {} });

const router = require('./agreement');
const { CURRENT_VERSION, getCurrentAgreement, agreementVersionSha256 } = require('../data/contractorAgreement');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signBody = (extra = {}) => ({
  full_name: 'Test Signer', email: 'signer@example.com', phone: '5550001234', sms_consent: true,
  ack_ic_status: true, ack_commitment: true, ack_non_solicit: true,
  ack_damage_recoupment: true, ack_legal_protections: true, ack_field_guide: true,
  signature_data: `data:image/png;base64,${PNG_1X1}`, signature_method: 'draw', version: CURRENT_VERSION,
  ...extra,
});

let server; let baseUrl; let token;
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}`, 'User-Agent': 'history-test-agent', ...headers },
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

// The history INSERT's columns against its VALUES: a $n placeholder reads the
// param, anything else (NOW()) the literal.
function historyRow() {
  const c = calls.find((x) => /INSERT INTO agreement_signatures/.test(x.sql));
  if (!c) return null;
  const cols = c.sql.match(/INSERT INTO agreement_signatures\s*\(([^)]*)\)/i)[1].split(',').map((s) => s.trim());
  const values = c.sql.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/i)[1].split(',').map((s) => s.trim());
  const row = { __via: c.via, __index: calls.indexOf(c) };
  cols.forEach((col, i) => {
    const m = /^\$(\d+)$/.exec(values[i] || '');
    row[col] = m ? c.params[Number(m[1]) - 1] : values[i];
  });
  return row;
}
const idx = (re, via) => calls.findIndex((c) => re.test(c.sql) && (!via || c.via === via));

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

// The post-commit tail (PDF upload, the key writes) runs after the response;
// wait for it the way the route does, by its own statements.
async function settled(re) {
  for (let i = 0; i < 50 && idx(re) === -1; i += 1) await new Promise((r) => setTimeout(r, 20));
}

test('a first sign appends a history row inside the transaction and stamps first_signed_at', async () => {
  existingRow = null;
  calls.length = 0;
  uploads.length = 0;
  const res = await post('/api/agreement', signBody(), { 'X-Forwarded-For': '10.0.0.7' });
  assert.equal(res.status, 200, res.raw);
  const h = historyRow();
  assert.ok(h, 'a history row was inserted');
  assert.equal(h.__via, 'client', 'on the transaction client');
  assert.ok(idx(/^BEGIN$/) < h.__index && h.__index < idx(/^COMMIT$/), 'between BEGIN and COMMIT');
  assert.equal(h.user_id, USER.id);
  assert.equal(h.signature_document_version, CURRENT_VERSION);
  assert.equal(h.signature_document_sha256, agreementVersionSha256(getCurrentAgreement()));
  assert.equal(h.signature_method, 'draw');
  assert.equal(h.signature_ip, '10.0.0.7');
  assert.equal(h.signature_user_agent, 'history-test-agent');
  assert.equal(h.full_name, 'Test Signer');
  assert.equal(h.email, 'signer@example.com');
  assert.equal(h.phone, '5550001234');
  assert.equal(h.sms_consent, true);
  assert.equal(h.signature_data, `data:image/png;base64,${PNG_1X1}`);
  assert.equal(h.superseded_pdf_storage_key, null, 'a first sign supersedes no PDF');
  const ins = calls.find((c) => /INSERT INTO agreements\b/.test(c.sql));
  assert.match(ins.sql, /first_signed_at/, 'the first sign stamps first_signed_at');

  await settled(/UPDATE agreement_signatures SET pdf_storage_key/);
  const keyWrite = calls.find((c) => /UPDATE agreement_signatures SET pdf_storage_key/.test(c.sql));
  assert.ok(keyWrite, 'the uploaded PDF key is written onto the history row');
  assert.equal(keyWrite.params[0], uploads[0]);
  assert.equal(keyWrite.params[1], HISTORY_ID);
});

test('a re-sign appends a second history row that keeps the superseded PDF key, and the row keeps its first signing date', async () => {
  existingRow = {
    id: 77, user_id: USER.id, full_name: 'Test Signer', email: 'signer@example.com', phone: '5550001234', sms_consent: true,
    signature_data: 'data:image/png;base64,old', signature_method: 'type', signature_document_version: CURRENT_VERSION,
    signed_at: FIRST_SIGNED_AT, first_signed_at: FIRST_SIGNED_AT, pdf_storage_key: OLD_KEY, pdf_generated_at: FIRST_SIGNED_AT, pdf_email_sent_at: FIRST_SIGNED_AT,
  };
  calls.length = 0;
  uploads.length = 0;
  const res = await post('/api/agreement', signBody({ sms_consent: false, full_name: 'Test Signer Two' }));
  assert.equal(res.status, 200, res.raw);
  const h = historyRow();
  assert.ok(h, 'a history row was inserted on the re-sign');
  assert.equal(h.__via, 'client');
  assert.equal(h.superseded_pdf_storage_key, OLD_KEY, 'the prior PDF key survives on the history row');
  assert.equal(h.full_name, 'Test Signer Two');
  assert.equal(h.sms_consent, false);
  const upd = calls.find((c) => /UPDATE agreements SET/.test(c.sql) && /RETURNING \*/.test(c.sql));
  assert.ok(upd, 'the agreements row was rewritten as the current view');
  assert.match(upd.sql, /first_signed_at\s*=\s*COALESCE\(first_signed_at,\s*NOW\(\)\)/, 'a re-sign never moves first_signed_at');
  assert.equal(new Date(res.body.agreement.first_signed_at).getTime(), FIRST_SIGNED_AT.getTime());
});

// Round 2 (L6): the prior row, and with it the PDF key the new history row
// records as superseded, is read FOR UPDATE inside the sign transaction, so
// two overlapping signs serialize and cannot both record the same key.
test('the prior row is read FOR UPDATE inside the sign transaction before the history row is written', async () => {
  existingRow = {
    id: 77, user_id: USER.id, full_name: 'Test Signer', email: 'signer@example.com', phone: '5550001234', sms_consent: true,
    signature_data: 'data:image/png;base64,old', signature_method: 'type', signature_document_version: CURRENT_VERSION,
    signed_at: FIRST_SIGNED_AT, first_signed_at: FIRST_SIGNED_AT, pdf_storage_key: OLD_KEY, pdf_generated_at: FIRST_SIGNED_AT, pdf_email_sent_at: FIRST_SIGNED_AT,
  };
  calls.length = 0;
  uploads.length = 0;
  const res = await post('/api/agreement', signBody());
  assert.equal(res.status, 200, res.raw);
  const read = calls.find((c) => /^\s*SELECT/i.test(c.sql) && /FROM agreements WHERE user_id = \$1/.test(c.sql) && /pdf_storage_key/.test(c.sql));
  assert.ok(read, 'the prior row is read for its PDF key');
  assert.match(read.sql, /FOR UPDATE/, 'under the row lock');
  assert.equal(read.via, 'client', 'on the transaction client');
  const h = historyRow();
  const i = calls.indexOf(read);
  assert.ok(idx(/^BEGIN$/) < i && i < h.__index && h.__index < idx(/^COMMIT$/), 'between BEGIN and the history INSERT, before COMMIT');
  assert.equal(h.superseded_pdf_storage_key, OLD_KEY);
});
