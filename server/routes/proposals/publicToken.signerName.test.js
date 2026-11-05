// The proposal sign validates client_signed_name (audit ESIG-13): presence was
// the whole check, so a name over the VARCHAR(255) column reached the sign
// UPDATE and 500'd (pg 22001) instead of a 400 field error. The checks run
// before the first query, so this needs no database: the pool's query is a
// recorder that must stay empty on a refusal, and answers a signable row on
// the happy path to show the trimmed name is what gets bound.
//
// Run: node --test server/routes/proposals/publicToken.signerName.test.js

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
  id: 501, venue_name: 'Test Hall', venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: '61101',
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

const TOKEN = crypto.randomUUID();
const signBody = (extra = {}) => ({
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
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

test('a 300-character signer name is a 400 naming client_signed_name, before any query', async () => {
  calls.length = 0;
  const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody({ client_signed_name: 'A'.repeat(300) }));
  assert.equal(res.status, 400, res.raw);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.client_signed_name, res.raw);
  assert.equal(calls.length, 0, 'nothing reached the database');
});

test('a one-character or non-string name is refused the same way', async () => {
  for (const bad of ['A', '   ', 42, { name: 'x' }]) {
    calls.length = 0;
    const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody({ client_signed_name: bad }));
    assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${res.raw}`);
    assert.ok(res.body.fieldErrors && res.body.fieldErrors.client_signed_name, res.raw);
    assert.equal(calls.length, 0, 'nothing reached the database');
  }
});

test('a well-formed sign binds the trimmed name into the sign UPDATE', async () => {
  calls.length = 0;
  const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody({ client_signed_name: '  Test Signer  ' }));
  assert.equal(res.status, 200, res.raw);
  const upd = calls.find((c) => /UPDATE proposals SET/.test(c.sql) && /client_signed_name = \$1/.test(c.sql));
  assert.ok(upd, 'the sign UPDATE ran');
  assert.equal(upd.params[0], 'Test Signer');
});
