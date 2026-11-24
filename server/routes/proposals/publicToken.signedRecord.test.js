// The proposal sign stores the configuration the client signed (audit
// ESIG-02, ESIG-05): client_signed_total (the row total the signature
// acknowledged, law 2) and client_signed_snapshot (the public price view the
// page rendered: the document version, the folded service rows, the gratuity
// amount, the total and the sanitized snapshot), in the same UPDATE as the
// signature, so an admin edit after the signature can never rewrite the only
// record of what was signed. No database: the pool's query is a recorder
// that answers a signable row; publicToken.signedRecord.db.test.js is the
// DB-backed sibling that reads the columns back.
//
// Run: node --test server/routes/proposals/publicToken.signedRecord.test.js

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
const { publicPriceView } = require('../../utils/publicSnapshot');

const SECRET_LABEL = 'Test hidden line';
// An engine-shaped snapshot with one HIDDEN discount: 600 - 123.45 = 476.55,
// plus a mandated gratuity of 80 on top: total 556.55.
const SNAPSHOT = {
  _version: 3, calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 50, durationHours: 4, numBars: 0, numBartenders: 1 },
  package: { id: 1, slug: 'test-flat', name: 'Test Flat', category: 'byob', pricing_type: 'flat', base_cost: 600 },
  bar_rental: { num_bars: 0, first_bar_fee: 50, additional_bar_fee: 100, total: 0 },
  staffing: { included: 1, required: 1, actual: 1, extra: 0, hourly_rate: 40, total: 0 },
  addons: [], syrups: { selections: [], count: 0, bottles_per_flavor: 1, total_bottles: 0, packs: 0, singles: 0, total: 0 },
  breakdown: [{ label: 'Test Flat (4hrs, 50 guests)', amount: 600 }, { label: SECRET_LABEL, amount: -123.45 }, { label: 'Gratuity', amount: 80 }],
  display_labels: { 'Shared Gratuity': 'Staffing Gratuity', Gratuity: 'Gratuity' },
  gratuity: { rate: 20, tip_jar: false, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 80, floor_rate: 20 },
  adjustments: [{ type: 'discount', label: SECRET_LABEL, amount: 123.45, visible: false }],
  total_price_override: null, subtotal: 680, total: 556.55,
};
const ROW = {
  id: 503, venue_name: 'Test Hall', venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: '61101',
  pricing_snapshot: SNAPSHOT, total_price: '556.55', package_name: 'Test Flat',
};

// Round 2 (L5): the record must come from the row read FOR UPDATE inside the
// sign's own transaction. A lookup that is not locked gets a STALE copy of the
// snapshot (the terms before a concurrent PATCH committed), so a record built
// from it carries the wrong rows and fails below.
const STALE_SNAPSHOT = { ...SNAPSHOT, package: { ...SNAPSHOT.package, base_cost: 300 }, breakdown: [], total: 256.55 };
const calls = [];
function answer(via, sql, params) {
  calls.push({ via, sql, params });
  if (/FROM proposals\b[\s\S]*WHERE p?\.?token = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) {
    const locked = /FOR UPDATE/.test(sql);
    return { rows: [{ ...ROW, status: 'viewed', client_signed_at: null, pricing_snapshot: locked ? SNAPSHOT : STALE_SNAPSHOT }], rowCount: 1 };
  }
  if (/UPDATE proposals SET/.test(sql) && /client_signed_name = \$1/.test(sql)) return { rows: [{ id: ROW.id }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer('pool', sql, params);
pool.connect = async () => ({
  query: async (sql, params) => answer('client', sql, params),
  release() { calls.push({ via: 'release', sql: '<release>', params: [] }); },
});

const publicTokenRouter = require('./publicToken');

const TOKEN = crypto.randomUUID();
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signBody = {
  client_signed_name: 'Test Signer',
  client_signature_data: `data:image/png;base64,${PNG_1X1}`,
  client_signature_method: 'draw',
  document_version: CURRENT_AGREEMENT_VERSION,
  acknowledged_total: 556.55,
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

function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
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

test('the sign UPDATE stores the row total and the rendered price view beside the signature, sanitized', async () => {
  calls.length = 0;
  const res = await post(`/api/proposals/t/${TOKEN}/sign`, signBody);
  assert.equal(res.status, 200, res.raw);
  const upd = calls.find((c) => /UPDATE proposals SET/.test(c.sql) && /client_signed_name = \$1/.test(c.sql));
  assert.ok(upd, 'the sign UPDATE ran');
  assert.match(upd.sql, /client_signed_total\s*=\s*total_price/, 'the signed total is the row total, never the posted figure');
  const m = upd.sql.match(/client_signed_snapshot\s*=\s*\$(\d+)/);
  assert.ok(m, 'the signed snapshot is written in the same statement');
  const record = JSON.parse(upd.params[Number(m[1]) - 1]);

  const view = publicPriceView(SNAPSHOT, { packageName: 'Test Flat' });
  assert.equal(record.document_version, CURRENT_AGREEMENT_VERSION);
  assert.deepEqual(record.rows, view.rows, 'the rows are the ones the page drew (hidden line folded)');
  assert.equal(record.gratuity_amount, 80);
  assert.equal(record.gratuity_label, 'Gratuity');
  assert.equal(record.total, 556.55);
  assert.deepEqual(record.snapshot, view.snapshot, 'the stored snapshot is the public copy');

  const raw = JSON.stringify(record);
  assert.ok(!raw.includes(SECRET_LABEL), 'no hidden label in the signed record');
  assert.ok(!raw.includes('123.45'), 'no hidden amount in the signed record');
  const keys = keysDeep(record);
  for (const k of ['breakdown', 'subtotal', 'total_price_override']) assert.ok(!keys.has(k), `no "${k}" key`);

  // Round 2 (L5): the record is built from the row read FOR UPDATE in one
  // transaction with the sign UPDATE, on one pooled client, released before
  // the post-commit tail reads through the pool.
  const lookup = calls.find((c) => /FROM proposals\b[\s\S]*WHERE p?\.?token = \$1/.test(c.sql) && /^\s*SELECT/i.test(c.sql));
  assert.match(lookup.sql, /FOR UPDATE/, 'the lookup locks the row');
  const at = (pred) => calls.findIndex(pred);
  const begin = at((c) => c.via === 'client' && c.sql === 'BEGIN');
  const commit = at((c) => c.via === 'client' && c.sql === 'COMMIT');
  const release = at((c) => c.via === 'release');
  assert.ok(begin >= 0 && commit > begin, 'a transaction wraps the sign');
  assert.equal(lookup.via, 'client', 'the lookup runs on the transaction client');
  assert.equal(upd.via, 'client', 'so does the UPDATE');
  assert.ok(begin < calls.indexOf(lookup) && calls.indexOf(lookup) < calls.indexOf(upd) && calls.indexOf(upd) < commit, 'lookup, then UPDATE, inside BEGIN/COMMIT');
  assert.ok(release > commit, 'the client is released after COMMIT');
  const readBack = at((c) => /FROM proposals p LEFT JOIN clients c/.test(c.sql));
  assert.ok(readBack > release && calls[readBack].via === 'pool', 'the post-commit tail reads through the pool after the release');
  assert.ok(!calls.some((c, i) => c.via === 'client' && i > release), 'nothing runs on the released client');
});
