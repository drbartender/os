// server/routes/proposals/publicToken.paymentState.test.js
// The poll target for the post-checkout settle state (spec §3c). Its contract
// is "tell me the row's payment state and touch NOTHING": the full GET bumps
// view_count and logs a view on every call, and thirteen polls recording
// thirteen views would fake engagement. And it must live on a token-keyed
// limiter: publicLimiter is 20 per 15 minutes per IP, and a settle spends 13.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicToken.paymentState.test.js refuses to run against production');
}

let server;
let baseUrl;
const createdProposalIds = new Set();
const createdClientIds = new Set();

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function insertProposal({ status = 'viewed', amountPaid = 0, totalPrice = 350, paymentType = 'deposit' } = {}) {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Payment State Test', `paystate+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const token = crypto.randomUUID();
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars, pricing_snapshot,
        total_price, amount_paid, payment_type, status, event_type)
     VALUES ($1, $2, 50, 4, 0, '{"total": 350}'::jsonb, $3, $4, $5, $6, 'Cocktail Party')
     RETURNING id, token`,
    [client.rows[0].id, token, totalPrice, amountPaid, paymentType, status]
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
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
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

test('returns the four fields as numbers, in dollars', async () => {
  const p = await insertProposal({ status: 'balance_paid', amountPaid: 550, totalPrice: 550, paymentType: 'full' });
  const r = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'balance_paid', amount_paid: 550, total_price: 550, payment_type: 'full' });
});

test('twenty-one calls on one token from one IP all succeed and bump nothing', async () => {
  const p = await insertProposal({ status: 'sent' });
  for (let i = 0; i < 21; i += 1) {
    const r = await get(`/api/proposals/t/${p.token}/payment-state`);
    assert.equal(r.status, 200, `call ${i + 1} returned ${r.status}: publicLimiter would have 429d at 21`);
  }
  const row = (await pool.query('SELECT status, view_count, last_viewed_at FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.status, 'sent', 'the sent->viewed flip belongs to the full GET, not this one');
  assert.equal(Number(row.view_count || 0), 0);
  assert.equal(row.last_viewed_at, null);
  const views = (await pool.query(
    "SELECT count(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'viewed'", [p.id]
  )).rows[0].n;
  assert.equal(views, 0);
});

test('404 on an archived proposal and on an unknown token, from OUR handler, not Express', async () => {
  // Assert the body too: with no route at all Express also 404s, with no
  // JSON body, and this test would pass by accident.
  const p = await insertProposal({ status: 'archived' });
  const a = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(a.status, 404);
  assert.equal(a.body && a.body.error, 'This proposal is no longer available');
  const u = await get(`/api/proposals/t/${crypto.randomUUID()}/payment-state`);
  assert.equal(u.status, 404);
  assert.equal(u.body && u.body.error, 'This proposal is no longer available');
});

test('a malformed token is rejected, not looked up', async () => {
  const r = await get('/api/proposals/t/not-a-uuid/payment-state');
  assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
});
