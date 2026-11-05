// The proposal sign refuses a signature payload that is not a signature
// (audit ESIG-06): the route checked truthiness and the method only, so a
// non-image under 'draw', an SVG, a 900 KB blob (then shipped on every
// public page load) or a one-character typed name all signed. Every refusal
// is a 400 naming `signature` and reaches no query. No database: the pool's
// query is a recorder that answers a signable row on the happy path.
//
// Run: node --test server/routes/proposals/publicToken.signaturePayload.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
delete process.env.SENTRY_DSN_SERVER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { CURRENT_AGREEMENT_VERSION } = require('../../utils/agreementVersions');

const calls = [];
const ROW = {
  id: 502, venue_name: 'Test Hall', venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: '61101',
  pricing_snapshot: { package: { name: 'Test', base_cost: 500 }, total: 500 }, total_price: '500.00', package_name: 'Test Package',
};
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM proposals\b[\s\S]*WHERE p?\.?token = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) return { rows: [ROW], rowCount: 1 };
  if (/UPDATE proposals SET/.test(sql) && /client_signed_name = \$1/.test(sql)) return { rows: [{ id: ROW.id }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const publicTokenRouter = require('./publicToken');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OVERSIZE_PNG = `data:image/png;base64,${Buffer.concat([PNG_MAGIC, crypto.randomBytes(200 * 1024 + 1)]).toString('base64')}`;
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

const TOKEN = crypto.randomUUID();
const signBody = (extra = {}) => ({
  client_signed_name: 'Test Signer',
  client_signature_data: `data:image/png;base64,${PNG_1X1}`,
  client_signature_method: 'draw',
  document_version: CURRENT_AGREEMENT_VERSION,
  acknowledged_total: 500,
  ...extra,
});

let server; let baseUrl;
function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/proposals', publicTokenRouter);
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

async function refused(extra, label) {
  calls.length = 0;
  const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody(extra));
  assert.equal(res.status, 400, `${label}: ${res.raw.slice(0, 200)}`);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.signature, `${label}: the field error names signature`);
  assert.equal(calls.length, 0, `${label}: nothing reached the database`);
}

test("a plain or javascript: string under method 'draw' is refused before any query", async () => {
  await refused({ client_signature_method: 'draw', client_signature_data: 'signed' }, 'plain string');
  await refused({ client_signature_method: 'draw', client_signature_data: 'javascript:alert(1)' }, 'javascript: string');
});

test('an SVG data URL and an image over 200 KB are refused', async () => {
  await refused({ client_signature_method: 'draw', client_signature_data: SVG }, 'svg');
  await refused({ client_signature_method: 'draw', client_signature_data: OVERSIZE_PNG }, 'oversize');
});

test('a one-character typed signature is refused', async () => {
  await refused({ client_signature_method: 'type', client_signature_data: 'x' }, 'typed x');
});

test('a PNG drawn signature and a typed full name both reach the sign UPDATE', async () => {
  calls.length = 0;
  let res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody());
  assert.equal(res.status, 200, res.raw);
  let upd = calls.find((c) => /UPDATE proposals SET/.test(c.sql) && /client_signed_name = \$1/.test(c.sql));
  assert.ok(upd, 'the sign UPDATE ran');
  assert.equal(upd.params[1], `data:image/png;base64,${PNG_1X1}`);

  calls.length = 0;
  res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody({ client_signature_method: 'type', client_signature_data: ' Test Signer ' }));
  assert.equal(res.status, 200, res.raw);
  upd = calls.find((c) => /UPDATE proposals SET/.test(c.sql) && /client_signed_name = \$1/.test(c.sql));
  assert.equal(upd.params[1], 'Test Signer', 'a typed signature is bound trimmed');
});
