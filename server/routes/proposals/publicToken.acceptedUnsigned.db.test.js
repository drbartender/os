// An unsigned 'accepted' row can be signed (audit ESIG-14), read back from the
// database after a real sign: the row goes to signed with its signature
// record, and the acceptance stamp an admin set earlier stays. Harness of
// publicToken.signTotal.test.js (dev database, own process for a fresh
// signLimiter bucket); publicToken.acceptedUnsigned.test.js is the
// no-database sibling.
//
// Run: node --test server/routes/proposals/publicToken.acceptedUnsigned.db.test.js

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
const publicTokenRouter = require('./publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicToken.acceptedUnsigned.db.test.js refuses to run against production');
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

const ADMIN_ACCEPTED_AT = '2026-09-20T15:00:00.000Z';

async function insertAcceptedUnsigned() {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Accepted Unsigned Test', `acceptedunsigned+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const snapshot = JSON.stringify({ package: { name: 'Test', base_cost: 500 }, total: 500 });
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, accepted_at, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, 120, 4, 1, $3, 500, 'full', 'accepted', $4, 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id, token`,
    [client.rows[0].id, crypto.randomUUID(), snapshot, ADMIN_ACCEPTED_AT]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0];
}

const signBody = {
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  client_signature_method: 'draw',
  document_version: CURRENT_AGREEMENT_VERSION,
  acknowledged_total: 500,
};

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

test("an unsigned 'accepted' row signs, keeps the admin's acceptance stamp and gains the signed record", async () => {
  const p = await insertAcceptedUnsigned();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody });
  assert.equal(res.status, 200, res.raw);
  const row = (await pool.query('SELECT status, client_signed_at, accepted_at, client_signed_total FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.status, 'accepted');
  assert.ok(row.client_signed_at);
  assert.equal(new Date(row.accepted_at).toISOString(), ADMIN_ACCEPTED_AT, 'COALESCE keeps the earlier acceptance stamp');
  assert.equal(Number(row.client_signed_total), 500);
});

test('a second sign of the now-signed row is 409 ALREADY_ACCEPTED', async () => {
  const p = await insertAcceptedUnsigned();
  assert.equal((await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody })).status, 200);
  const again = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody });
  assert.equal(again.status, 409, again.raw);
  assert.equal(again.body.code, 'ALREADY_ACCEPTED');
});
