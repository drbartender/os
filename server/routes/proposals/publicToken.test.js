// Route-level tests for the version-recording rules in POST /api/proposals/t/:token/sign
// (spec section 4.4). Mirrors the harness in crud.test.js: a fresh express() app mounts
// the real publicToken router + the AppError-aware error handler, driven over
// real HTTP. Runs against the dev DB (DATABASE_URL from .env); creates real rows
// and purges them in after().
//
// signLimiter budget: 10 sign POSTs / hour / IP (all tests share 127.0.0.1).
// This file makes 4 sign POSTs total — well under the cap.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const {
  CURRENT_AGREEMENT_VERSION,
  LEGACY_AGREEMENT_VERSION,
} = require('../../utils/agreementVersions');
const publicTokenRouter = require('./publicToken');

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
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
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

// Insert a signable proposal (status 'viewed', not yet signed) with a COMPLETE
// venue so the sign handler does not require venue fields. Returns { id, token }.
async function insertSignableProposal() {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Sign Version Test', `signver+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const token = crypto.randomUUID();
  const snapshot = JSON.stringify({ package: { name: 'Test', base_cost: 500 }, total: 500 });
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, 120, 4, 1, $3, 500, 'full', 'viewed', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id, token`,
    [client.rows[0].id, token, snapshot]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0];
}

const validSignBody = (extra = {}) => ({
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgo=',
  client_signature_method: 'draw',
  ...extra,
});

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
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
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

// Case A — version present and in allowlist → recorded verbatim
test('Case A: a normal sign with the current version records exactly that version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: CURRENT_AGREEMENT_VERSION }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signature_document_version, status FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signature_document_version, CURRENT_AGREEMENT_VERSION);
  assert.equal(row.rows[0].status, 'accepted');
});

// Case B — version missing → recorded as legacy v2
test('Case B: a sign with no document_version records the legacy v2 version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody(),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signature_document_version, LEGACY_AGREEMENT_VERSION);
});

// Case C — version present but unknown → rejected, nothing recorded
test('Case C: a sign with an unknown version is rejected and records no signature', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: 'event-services-agreement-v999' }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const row = await pool.query(
    'SELECT client_signed_at, status, client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signed_at, null, 'rejected sign must not record a signature');
  assert.equal(row.rows[0].status, 'viewed', 'status must be untouched');
  assert.equal(row.rows[0].client_signature_document_version, null);
});

// Case D — baseline sign still works (no regression to the sign path); the
// version is written in the SAME atomic UPDATE as name/method/timestamp.
test('Case D: the sign path still records name/method/ip alongside the version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: CURRENT_AGREEMENT_VERSION, client_signature_method: 'type' }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signed_name, client_signature_method, client_signed_at, client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signed_name, 'Test Signer');
  assert.equal(row.rows[0].client_signature_method, 'type');
  assert.ok(row.rows[0].client_signed_at, 'client_signed_at must be set');
  assert.equal(row.rows[0].client_signature_document_version, CURRENT_AGREEMENT_VERSION,
    'the version must be written in the same UPDATE as the rest of the signature');
});

// Case E — legacy version sent EXPLICITLY → accepted via the allowlist (not via
// the missing-field fallback). Proves the allowlist entry is what makes v2 valid.
test('Case E: an explicit legacy v2 version is accepted and recorded', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: LEGACY_AGREEMENT_VERSION }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signature_document_version, status FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signature_document_version, LEGACY_AGREEMENT_VERSION);
  assert.equal(row.rows[0].status, 'accepted');
});

// Case F — an empty-string version is anomalous (not a legitimate omission) and
// is rejected, NOT silently recorded as v2.
test('Case F: an empty-string document_version is rejected and records no signature', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: '' }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const row = await pool.query(
    'SELECT client_signed_at, client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signed_at, null, 'a rejected empty-string sign must not record a signature');
  assert.equal(row.rows[0].client_signature_document_version, null);
});
