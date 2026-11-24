// The sign writes the signed configuration to the row (audit ESIG-02): read
// back from the database after a real sign, client_signed_total equals the
// row total the signature acknowledged and client_signed_snapshot carries the
// rendered rows, the version and the total. Harness of
// publicToken.signTotal.test.js (dev database, own process for a fresh
// signLimiter bucket); publicToken.signedRecord.test.js is the no-database
// sibling that pins the UPDATE itself.
//
// Run: node --test server/routes/proposals/publicToken.signedRecord.db.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { CURRENT_AGREEMENT_VERSION } = require('../../utils/agreementVersions');
const { publicPriceView } = require('../../utils/publicSnapshot');
const publicTokenRouter = require('./publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicToken.signedRecord.db.test.js refuses to run against production');
}

let server;
let baseUrl;
const createdProposalIds = new Set();
const createdClientIds = new Set();

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const SNAPSHOT = {
  _version: 3, calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 50, durationHours: 4, numBars: 0, numBartenders: 1 },
  package: { id: null, slug: 'test', name: 'Test', category: 'byob', pricing_type: 'flat', base_cost: 500 },
  bar_rental: { num_bars: 0, first_bar_fee: 50, additional_bar_fee: 100, total: 0 },
  staffing: { included: 1, required: 1, actual: 1, extra: 0, hourly_rate: 40, total: 0 },
  addons: [], syrups: { selections: [], count: 0, bottles_per_flavor: 1, total_bottles: 0, packs: 0, singles: 0, total: 0 },
  breakdown: [{ label: 'Test (4hrs, 50 guests)', amount: 500 }],
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 0, floor_rate: null },
  adjustments: [], total_price_override: null, subtotal: 500, total: 500,
};

async function insertSignableProposal() {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Signed Record Test', `signedrecord+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, 50, 4, 0, $3, 500, 'full', 'viewed', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id, token`,
    [client.rows[0].id, crypto.randomUUID(), JSON.stringify(SNAPSHOT)]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
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
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('a sign stores the acknowledged row total and the rendered price view', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: {
      client_signed_name: 'Test Signer',
      client_signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      client_signature_method: 'draw',
      document_version: CURRENT_AGREEMENT_VERSION,
      acknowledged_total: 500,
    },
  });
  assert.equal(res.status, 200, res.raw);
  const row = (await pool.query('SELECT status, client_signed_at, client_signed_total, client_signed_snapshot FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.status, 'accepted');
  assert.ok(row.client_signed_at);
  assert.equal(Number(row.client_signed_total), 500);
  const view = publicPriceView(SNAPSHOT, { packageName: null });
  assert.equal(row.client_signed_snapshot.document_version, CURRENT_AGREEMENT_VERSION);
  assert.equal(row.client_signed_snapshot.total, 500);
  assert.deepEqual(row.client_signed_snapshot.rows, view.rows);
  assert.equal(row.client_signed_snapshot.snapshot.total, 500);
  assert.ok(!('breakdown' in row.client_signed_snapshot.snapshot), 'the stored snapshot is the sanitized public copy');
});
