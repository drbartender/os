// An unsigned 'accepted' row can be signed (audit ESIG-14): an admin marking
// a sent proposal 'accepted' by hand (a phone acceptance) produced a row the
// sign UPDATE refused (409 ALREADY_ACCEPTED) and the page showed no card
// for, so the client could never sign the terms the business meant to
// enforce. Paid and lifecycle statuses stay refused, and a signed row stays
// refused. No database: the pool's query answers the lookup from a fixture
// and EVALUATES the sign UPDATE's own WHERE (its NOT IN status list and the
// unsigned predicate) against that fixture, so the route's SQL is what is
// tested; publicToken.acceptedUnsigned.db.test.js is the DB-backed sibling.
//
// Run: node --test server/routes/proposals/publicToken.acceptedUnsigned.test.js

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

let row;
const base = () => ({
  id: 505, venue_name: 'Test Hall', venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: '61101',
  pricing_snapshot: { package: { name: 'Test', base_cost: 500 }, total: 500 }, total_price: '500.00', package_name: 'Test Package',
  status: 'accepted', client_signed_at: null,
});
const calls = [];
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM proposals\b[\s\S]*WHERE p?\.?token = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) return { rows: [row], rowCount: 1 };
  if (/UPDATE proposals SET/.test(sql) && /client_signed_name = \$1/.test(sql)) {
    // The WHERE as written: unsigned, and a status outside the NOT IN list.
    const m = sql.match(/status NOT IN \(([^)]*)\)/);
    assert.ok(m, 'the sign UPDATE guards on a status list');
    const excluded = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    if (row.client_signed_at || excluded.includes(row.status)) return { rows: [], rowCount: 0 };
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/SELECT client_signed_at, status FROM proposals WHERE id = \$1/.test(sql)) return { rows: [{ client_signed_at: row.client_signed_at, status: row.status }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const publicTokenRouter = require('./publicToken');

const TOKEN = crypto.randomUUID();
const signBody = {
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  client_signature_method: 'draw',
  document_version: CURRENT_AGREEMENT_VERSION,
  acknowledged_total: 500,
};

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

test("an unsigned 'accepted' row signs", async () => {
  row = base();
  calls.length = 0;
  const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody);
  assert.equal(res.status, 200, res.raw);
  assert.ok(calls.some((c) => /UPDATE proposals SET/.test(c.sql) && /client_signed_name = \$1/.test(c.sql)), 'the sign UPDATE ran');
});

test("a signed 'accepted' row, and unsigned paid or lifecycle rows, are still refused as already accepted", async () => {
  for (const fixture of [
    { ...base(), client_signed_at: new Date('2026-10-01T15:00:00.000Z') },
    { ...base(), status: 'deposit_paid' }, { ...base(), status: 'balance_paid' },
    { ...base(), status: 'confirmed' }, { ...base(), status: 'completed' }, { ...base(), status: 'archived' },
  ]) {
    row = fixture;
    calls.length = 0;
    const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody);
    assert.equal(res.status, 409, `${fixture.status}/${fixture.client_signed_at ? 'signed' : 'unsigned'}: ${res.raw}`);
    assert.equal(res.body.code, 'ALREADY_ACCEPTED', `${fixture.status}: a refusal is never read as a moved total`);
  }
});
