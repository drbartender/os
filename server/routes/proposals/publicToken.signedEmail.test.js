// The sign-only confirmation email carries the terms as signed (audit
// ESIG-05): the sign handler reads the record back off the row it wrote and
// the email the client receives prints the version, the signer, the rows and
// the acknowledged total. No database: the pool's query is a recorder whose
// post-sign read answers the row as the sign left it; the email module is
// stubbed at the module boundary so the body can be read.
//
// Run: node --test server/routes/proposals/publicToken.signedEmail.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
delete process.env.SENTRY_DSN_SERVER;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [] };
}
const emails = [];
stubModule('../../utils/email', { sendEmail: async (args) => { emails.push(args); return { id: 'stub' }; } });
const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { CURRENT_AGREEMENT_VERSION } = require('../../utils/agreementVersions');

const SNAPSHOT = {
  _version: 3, calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 50, durationHours: 4, numBars: 1, numBartenders: 1 },
  package: { id: 1, slug: 'test-flat', name: 'Test Flat', category: 'byob', pricing_type: 'flat', base_cost: 600 },
  bar_rental: { num_bars: 1, first_bar_fee: 50, additional_bar_fee: 100, total: 50 },
  staffing: { included: 1, required: 1, actual: 1, extra: 0, hourly_rate: 40, total: 0 },
  addons: [], syrups: { selections: [], count: 0, bottles_per_flavor: 1, total_bottles: 0, packs: 0, singles: 0, total: 0 },
  breakdown: [{ label: 'Test Flat (4hrs, 50 guests)', amount: 600 }, { label: 'Bar Rental (1 bar)', amount: 50 }],
  display_labels: { 'Shared Gratuity': 'Staffing Gratuity', Gratuity: 'Gratuity' },
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 0, floor_rate: null },
  adjustments: [], total_price_override: null, subtotal: 650, total: 650,
};
const ROW = {
  id: 504, venue_name: 'Test Hall', venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: '61101',
  pricing_snapshot: SNAPSHOT, total_price: '650.00', package_name: 'Test Flat',
};
// What the sign UPDATE leaves on the row, kept by the recorder for the read-back.
let written = null;
const calls = [];
function answer(sql, params) {
  calls.push({ sql, params });
  if (/FROM proposals\b[\s\S]*WHERE p?\.?token = \$1/.test(sql) && /^\s*SELECT/i.test(sql)) return { rows: [ROW], rowCount: 1 };
  if (/UPDATE proposals SET/.test(sql) && /client_signed_name = \$1/.test(sql)) {
    const m = sql.match(/client_signed_snapshot\s*=\s*\$(\d+)/);
    written = {
      client_signed_name: params[0], client_signed_at: new Date('2026-10-01T15:00:00.000Z'),
      client_signature_document_version: params[5],
      client_signed_snapshot: m ? JSON.parse(params[Number(m[1]) - 1]) : null,
    };
    return { rows: [{ id: ROW.id }], rowCount: 1 };
  }
  if (/FROM proposals p LEFT JOIN clients c/.test(sql)) {
    return { rows: [{ id: ROW.id, event_type: 'Wedding', event_type_custom: null, event_date: '2027-06-12', event_timezone: 'America/Chicago', client_name: 'Test Signer', client_email: 'client@example.com', ...(written || {}) }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

const publicTokenRouter = require('./publicToken');

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

test('the client\'s sign confirmation carries the version, the signer, each row and the acknowledged total', async () => {
  calls.length = 0;
  emails.length = 0;
  const res = await post(`/api/proposals/t/${crypto.randomUUID()}/sign`, {
    client_signed_name: 'Test Signer',
    client_signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    client_signature_method: 'draw',
    document_version: CURRENT_AGREEMENT_VERSION,
    acknowledged_total: 650,
  });
  assert.equal(res.status, 200, res.raw);
  const mail = emails.find((e) => e.to === 'client@example.com');
  assert.ok(mail, `the client was emailed: ${JSON.stringify(emails.map((e) => e.to))}`);
  for (const body of [mail.html, mail.text]) {
    assert.match(body, /What you signed/);
    assert.match(body, new RegExp(CURRENT_AGREEMENT_VERSION));
    assert.match(body, /signed by Test Signer/);
    assert.match(body, /October 1, 2026/);
    assert.match(body, /Test Flat/);
    assert.match(body, /\$600\.00/);
    assert.match(body, /Bar Rental/);
    assert.match(body, /\$50\.00/);
    assert.match(body, /\$650\.00/);
    assert.ok(!body.includes('undefined'));
  }
});
