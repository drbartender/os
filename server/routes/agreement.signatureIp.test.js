// The staff agreement sign records the proxy-validated address (audit ESIG-01,
// AUTH-08): behind `trust proxy` req.ip is the address the proxy saw, while
// the FIRST X-Forwarded-For entry is whatever the signer typed, so the row and
// the archived PDF used to carry a forgeable IP, and a header longer than the
// VARCHAR(45) column was a 22001 500 instead of a bounded value.
//
// No database: the shared pool's query/connect are replaced by a recorder that
// answers the route's statements from memory (the agreements upsert RETURNs the
// row it was handed), the auth lookup answers a staff user, and R2 and the
// signer's email are stubbed at the module boundary BEFORE the router loads.
// The real router runs on express() over real HTTP with the same
// `app.set('trust proxy', 1)` as server/index.js, so req.ip is what prod sees.
//
// Run: node --test server/routes/agreement.signatureIp.test.js

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

// ── Module-boundary stubs, installed before anything requires them ──────────
function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [] };
}
const emails = [];
stubModule('../utils/storage', {
  uploadFile: async () => {},
  getSignedUrl: async (key) => `https://r2.invalid/${key}`,
  readFile: async () => { throw new Error('agreement.signatureIp.test: nothing reads R2'); },
});
stubModule('../utils/email', { sendEmail: async (args) => { emails.push(args); return { id: 'stub' }; } });
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

// ── The recorder in place of Postgres ───────────────────────────────────────
const USER = { id: 4242, email: 'signer@example.com', role: 'staff', onboarding_status: 'in_progress', can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const calls = [];
const existingRow = null; // no prior agreements row: every sign here is a first sign

// A row from an INSERT's column list, or an UPDATE's SET pairs, zipped with the params.
function rowFromStatement(sql, params) {
  const row = {};
  const ins = sql.match(/INSERT INTO agreements\s*\(([^)]*)\)/i);
  if (ins) {
    ins[1].split(',').map((c) => c.trim()).forEach((col, i) => { row[col] = params[i]; });
  } else {
    for (const m of sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) row[m[1]] = params[Number(m[2]) - 1];
  }
  row.id = existingRow ? existingRow.id : 77;
  row.signed_at = new Date();
  return row;
}
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [USER], rowCount: 1 };
  if (/FROM agreements WHERE user_id = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) {
    return existingRow ? { rows: [existingRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO agreements\b/.test(sql) || (/UPDATE agreements SET/.test(sql) && /RETURNING \*/.test(sql))) {
    const row = rowFromStatement(sql, params);
    return { rows: [row], rowCount: 1 };
  }
  if (/INSERT INTO agreement_signatures/.test(sql)) return { rows: [{ id: 9001 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const router = require('./agreement');
const { CURRENT_VERSION } = require('../data/contractorAgreement');

// A real 1x1 PNG, so the PDF renderer draws it instead of printing a fallback.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signBody = (extra = {}) => ({
  full_name: 'Test Signer',
  email: 'signer@example.com',
  phone: '5550001234',
  sms_consent: true,
  ack_ic_status: true, ack_commitment: true, ack_non_solicit: true,
  ack_damage_recoupment: true, ack_legal_protections: true, ack_field_guide: true,
  signature_data: `data:image/png;base64,${PNG_1X1}`,
  signature_method: 'draw',
  version: CURRENT_VERSION,
  ...extra,
});

let server; let baseUrl; let token;

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`, ...headers,
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
    req.write(payload);
    req.end();
  });
}

const writtenRow = () => calls.filter((c) => /INSERT INTO agreements\b|UPDATE agreements SET/.test(c.sql) && /RETURNING \*/.test(c.sql)).map((c) => rowFromStatement(c.sql, c.params)).pop();

before(async () => {
  token = jwt.sign({ userId: USER.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.set('trust proxy', 1); // server/index.js:187, the setting req.ip is read under in prod
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

test('the recorded signature_ip is the proxy-validated address, never the forgeable first hop', async () => {
  calls.length = 0;
  const res = await post('/api/agreement', signBody(), { 'X-Forwarded-For': '1.2.3.4, 10.0.0.1' });
  assert.equal(res.status, 200, res.raw);
  const row = writtenRow();
  assert.ok(row, 'the sign wrote the agreements row');
  // With one trusted hop, express reads the LAST entry as the client the proxy
  // saw; 1.2.3.4 is what the signer typed into the header.
  assert.equal(row.signature_ip, '10.0.0.1');
  assert.equal(res.body.agreement.signature_ip, '10.0.0.1');
});

test('a 300-character header still signs with a value that fits the VARCHAR(45) column', async () => {
  calls.length = 0;
  const huge = 'a'.repeat(300);
  const res = await post('/api/agreement', signBody(), { 'X-Forwarded-For': huge });
  assert.equal(res.status, 200, res.raw);
  const row = writtenRow();
  assert.ok(row, 'the sign wrote the agreements row');
  assert.ok(typeof row.signature_ip === 'string' && row.signature_ip.length <= 45,
    `signature_ip must fit VARCHAR(45), got ${row.signature_ip && row.signature_ip.length} chars`);
});

test('no header at all records the socket address, with the IPv4-mapped prefix stripped', async () => {
  calls.length = 0;
  const res = await post('/api/agreement', signBody());
  assert.equal(res.status, 200, res.raw);
  const row = writtenRow();
  assert.equal(row.signature_ip, '127.0.0.1');
  assert.ok(!String(row.signature_ip).startsWith('::ffff:'));
});
