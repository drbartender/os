// Sign-time total assertion (spec 2026-08-14, proposal options drawer).
//
// The switch endpoint made pre-signature rewrites routine, and the sign
// endpoint binds no configuration: these tests pin the one change that closes
// that seam. A sign carrying acknowledged_total commits ONLY when it matches
// the row's total to the cent; an absent field is refused (400) since
// 2026-08-28, matching the switch route. Harness mirrors publicToken.test.js; own file = own process = a fresh
// signLimiter bucket (4 sign POSTs here, cap is 10/hour/IP).

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
  throw new Error('publicToken.signTotal.test.js refuses to run against production');
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

async function insertSignableProposal() {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Sign Total Test', `signtotal+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
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

const signBody = (extra = {}) => ({
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgo=',
  client_signature_method: 'draw',
  document_version: CURRENT_AGREEMENT_VERSION,
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

test('a sign acknowledging the row total commits', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: signBody({ acknowledged_total: 500 }),
  });
  assert.equal(res.status, 200, res.raw);
  const row = await pool.query('SELECT status, client_signed_at FROM proposals WHERE id = $1', [p.id]);
  assert.equal(row.rows[0].status, 'accepted');
  assert.ok(row.rows[0].client_signed_at);
});

test('a sign acknowledging a MOVED total is 409 TOTAL_CHANGED and records nothing', async () => {
  const p = await insertSignableProposal();
  // The row moved (a switch landed) after the page rendered 500.
  await pool.query('UPDATE proposals SET total_price = 750 WHERE id = $1', [p.id]);
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: signBody({ acknowledged_total: 500 }),
  });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'TOTAL_CHANGED', 'a still-signable row is a total conflict, not ALREADY_ACCEPTED');
  const row = await pool.query(
    'SELECT status, client_signed_at, client_signed_name FROM proposals WHERE id = $1', [p.id]);
  assert.equal(row.rows[0].client_signed_at, null, 'no signature recorded');
  assert.equal(row.rows[0].client_signed_name, null);
  assert.equal(row.rows[0].status, 'viewed', 'status untouched');
});

test('a sign with NO acknowledged_total is refused and writes nothing (required since 2026-08-28)', async () => {
  const p = await insertSignableProposal();
  // The guard defends the signer against a switch landing mid-flight; a caller
  // that omits the field would sign at whatever the total is now.
  await pool.query('UPDATE proposals SET total_price = 750 WHERE id = $1', [p.id]);
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: signBody(),
  });
  assert.equal(res.status, 400, res.raw);
  assert.ok(/refresh/i.test(res.raw), 'the message tells a stale bundle what to do');
  const row = await pool.query('SELECT status, client_signed_at FROM proposals WHERE id = $1', [p.id]);
  assert.notEqual(row.rows[0].status, 'accepted');
  assert.equal(row.rows[0].client_signed_at, null);
  const bc = await pool.query("SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action IN ('signed', 'sign_failed')", [p.id]);
  assert.equal(bc.rowCount, 0, 'a 400 is not a 409: no breadcrumb either way');
});

test('sub-cent noise is not a conflict; a garbage value is a 400', async () => {
  const p = await insertSignableProposal();
  const garbage = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: signBody({ acknowledged_total: 'five hundred' }),
  });
  assert.equal(garbage.status, 400, garbage.raw);
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: signBody({ acknowledged_total: 500.004999 }),
  });
  assert.equal(res.status, 200, `sub-cent float noise must not block a signature: ${res.raw}`);
});

test('a TOTAL_CHANGED 409 writes a sign_failed activity row carrying the code and the acknowledged total', async () => {
  const p = await insertSignableProposal();
  const r = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody({ acknowledged_total: 999 }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'TOTAL_CHANGED');
  const rows = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'sign_failed'", [p.id]
  )).rows;
  assert.equal(rows.length, 1, 'exactly one sign_failed row');
  assert.equal(rows[0].details.code, 'TOTAL_CHANGED');
  assert.equal(Number(rows[0].details.acknowledged_total), 999);
  const views = (await pool.query(
    "SELECT count(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'viewed'", [p.id]
  )).rows[0].n;
  assert.equal(views, 0, 'a failed sign is not a view');
});

test('a successful sign records the acknowledged total in the signed row', async () => {
  const p = await insertSignableProposal();
  const r = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody({ acknowledged_total: 500 }) });
  assert.equal(r.status, 200);
  const row = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'signed'", [p.id]
  )).rows[0];
  assert.equal(Number(row.details.acknowledged_total), 500);
});
