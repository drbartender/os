// server/routes/proposals/crud.pricingInputs.test.js
'use strict';
// Route tests for the pricing-input gate (audit PRC-05, round 2 M2) through
// the REAL create, PATCH and /calculate handlers over HTTP (the
// crud.guards.test.js harness) with one difference: no database. On the create
// and the preview the gate runs before any connection is checked out, so a
// bad body never reaches the pool. On the PATCH it runs after the FOR UPDATE
// read (it judges a value against the stored row), so this suite stubs
// pool.connect with a scripted client that answers BEGIN, the locking read
// and ROLLBACK and refuses every other statement: a 400 proves the gate
// stopped the save at the row, and the refusal's 500 proves a value the gate
// let through went on toward the pricing reads. The auth middleware is
// stubbed through the require-cache seam (the stripeClient precedent in
// publicSwitch.test.js) before the routers load, because the real one reads
// the user row, and it mints a fresh admin id per request because
// adminWriteLimiter keys its 10-a-minute budget on the user id (the
// cancelLineItem.protected.test.js precedent). The accepted-value side lives in
// pricingInputs.test.js (pure) and, for the PATCH's 200 path, in
// crud.guards.test.js (DB-backed).
//
//   node --test server/routes/proposals/crud.pricingInputs.test.js
const authModule = require('../../middleware/auth');
let adminSeq = 0;
authModule.auth = (req, res, next) => { adminSeq += 1; req.user = { id: adminSeq, role: 'admin' }; next(); };
authModule.requireAdminOrManager = (req, res, next) => next();

// The locked row the PATCH reads: a booking saved before the bounds (1500
// guests) with the columns the guards before the gate read.
const STORED = {
  id: 123, status: 'sent', guest_count: 1500, num_bars: 1, num_bartenders: null, event_duration_hours: '4.0',
  adjustments: [], adjustments_token: 'tok-stored', total_price_override: null, total_price: '350.00', amount_paid: 0,
};
const SENTINEL = 'crud.pricingInputs.test: past the gate';
const { pool } = require('../../db');
const realConnect = pool.connect;
pool.connect = () => Promise.resolve({
  query: (sql) => {
    if (/^BEGIN$/.test(sql) || /^ROLLBACK$/.test(sql)) return Promise.resolve({ rowCount: 0 });
    if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [STORED] });
    return Promise.reject(new Error(SENTINEL));
  },
  release: () => {},
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');
const metadataRouter = require('./metadata');

let server; let baseUrl;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
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
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', metadataRouter);
  app.use('/api/proposals', crudRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  pool.connect = realConnect;
  await new Promise((resolve) => server.close(resolve));
});

// A body the create and the PATCH would otherwise accept up to the database;
// the PATCH base re-sends the stored row's own values, as the editor does.
const CREATE_BASE = { client_name: 'Test Client', package_id: 1, event_duration_hours: 4, guest_count: 50, num_bars: 1 };
const PATCH_BASE = { event_duration_hours: 4, guest_count: 1500, num_bars: 1 };

const BAD = [
  ['guest_count', -1], ['guest_count', 0], ['guest_count', 1.5], ['guest_count', 'abc'], ['guest_count', 5000],
  ['num_bars', -1], ['num_bars', 0.5],
  ['num_bartenders', 1.5], ['num_bartenders', -2],
  ['event_duration_hours', 0], ['event_duration_hours', 4.25], ['event_duration_hours', -4],
];

test('POST /api/proposals refuses each out-of-shape pricing input with a 400 naming the field, before any database work', async () => {
  for (const [field, value] of BAD) {
    const res = await request('POST', '/api/proposals', { ...CREATE_BASE, [field]: value });
    assert.equal(res.status, 400, `${field}=${value}: ${res.raw}`);
    assert.deepEqual(Object.keys(res.body.fieldErrors), [field], `${field}=${value}`);
  }
});

test('PATCH /api/proposals/:id refuses a CHANGED out-of-shape input the same way (the editor sends Number("") as 0), at the locked row and before any write', async () => {
  for (const [field, value] of BAD) {
    const res = await request('PATCH', '/api/proposals/123', { ...PATCH_BASE, [field]: value });
    assert.equal(res.status, 400, `${field}=${value}: ${res.raw}`);
    assert.deepEqual(Object.keys(res.body.fieldErrors), [field], `${field}=${value}`);
  }
  // A blank guest field on the editor: 0 is refused instead of storing a 0-guest contract.
  const blank = await request('PATCH', '/api/proposals/123', { ...PATCH_BASE, guest_count: 0 });
  assert.equal(blank.status, 400);
  assert.match(blank.body.fieldErrors.guest_count, /whole number from 1 to 1000/);
});

test('PATCH: a booking saved before the bounds (1500 guests) re-sent unchanged passes the gate; a change to 1600 is refused (round 2, M2)', async () => {
  // Re-sent as stored, with a new date: the gate lets it through to the
  // pricing reads, which this suite's client refuses with its sentinel (a
  // 500 here is the proof; crud.guards.test.js drives the 200 against the DB).
  const kept = await request('PATCH', '/api/proposals/123', { ...PATCH_BASE, guest_count: 1500, event_date: '2027-06-13' });
  assert.equal(kept.status, 500, kept.raw);
  assert.equal(kept.body.code, 'INTERNAL_ERROR', 'past the gate: the next statement is the sentinel');
  assert.equal(kept.body.fieldErrors, undefined, 'no field was refused');
  // A changed value past the bound is judged.
  const changed = await request('PATCH', '/api/proposals/123', { ...PATCH_BASE, guest_count: 1600 });
  assert.equal(changed.status, 400, changed.raw);
  assert.deepEqual(Object.keys(changed.body.fieldErrors), ['guest_count']);
});

test('POST /api/proposals/calculate refuses the same inputs, naming duration_hours for the duration', async () => {
  const res = await request('POST', '/api/proposals/calculate', { package_id: 1, guest_count: -100, duration_hours: 4 });
  assert.equal(res.status, 400, res.raw);
  assert.deepEqual(Object.keys(res.body.fieldErrors), ['guest_count']);
  const dur = await request('POST', '/api/proposals/calculate', { package_id: 1, guest_count: 50, duration_hours: 4.25 });
  assert.equal(dur.status, 400, dur.raw);
  assert.deepEqual(Object.keys(dur.body.fieldErrors), ['duration_hours']);
  const nb = await request('POST', '/api/proposals/calculate', { package_id: 1, guest_count: 50, duration_hours: 4, num_bartenders: 1.5 });
  assert.equal(nb.status, 400, nb.raw);
  assert.deepEqual(Object.keys(nb.body.fieldErrors), ['num_bartenders']);
});

test('every bad field is named together in one 400', async () => {
  const res = await request('PATCH', '/api/proposals/123', { guest_count: -50, num_bars: -1, num_bartenders: 1.5, event_duration_hours: 4.25 });
  assert.equal(res.status, 400, res.raw);
  assert.deepEqual(Object.keys(res.body.fieldErrors).sort(), ['event_duration_hours', 'guest_count', 'num_bars', 'num_bartenders']);
});
