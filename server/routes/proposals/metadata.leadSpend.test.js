require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Thumbtack lead spend in /financials + per-proposal /:id/lead-cost.
// Contract: only clean "$X.YZ" prices on charge_state='Charged' (or the legacy
// NULL-state rows, which predate chargeState parsing and carry real prices)
// count as spend; Pending/Created and junk prices are excluded; attribution
// rides thumbtack_leads.proposal_id. The financials call is date-scoped to an
// isolated window (leads seeded at 2020-01-15) so shared-dev-DB rows outside
// the window can never skew the assertions.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const metadataRouter = require('./metadata');

if (process.env.NODE_ENV === 'production') {
  throw new Error('metadata.leadSpend.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const LEAD_AT = '2020-01-15T12:00:00Z'; // isolated window: from=2020-01-01 to=2020-01-31
let server, baseUrl, adminUserId, adminToken, clientId, proposalA, proposalB;

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

async function seedLead(suffix, { price, chargeState, proposalId = null }) {
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, lead_price, charge_state, proposal_id, raw_payload, created_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [`leadspend-${NONCE}-${suffix}`, price, chargeState, proposalId, LEAD_AT]
  );
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`leadspend-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('LeadSpend Test', $1) RETURNING id`,
    [`leadspend-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pa = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'deposit_paid', 500, 100) RETURNING id`,
    [clientId]
  );
  proposalA = pa.rows[0].id;
  const pb = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'sent', 500, 0) RETURNING id`,
    [clientId]
  );
  proposalB = pb.rows[0].id;

  // Counted: L1 (Charged, linked), L2 (Charged, unlinked), L5 (legacy NULL state, priced).
  // Excluded: L3 (Pending, no price), L4 (Created), L6 (junk price string).
  await seedLead('L1', { price: '$18.60', chargeState: 'Charged', proposalId: proposalA });
  await seedLead('L2', { price: '$9.24', chargeState: 'Charged' });
  await seedLead('L3', { price: null, chargeState: 'Pending' });
  await seedLead('L4', { price: '$5.00', chargeState: 'Created' });
  await seedLead('L5', { price: '$11.55', chargeState: null });
  await seedLead('L6', { price: 'N/A', chargeState: 'Charged' });

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', metadataRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1', [`leadspend-${NONCE}-%`]);
  if (proposalA || proposalB) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [[proposalA, proposalB].filter(Boolean)]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [[proposalA, proposalB].filter(Boolean)]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('financials leadSpend counts Charged + legacy-NULL priced leads only, split by attribution', async () => {
  const r = await get('/api/proposals/financials?from=2020-01-01&to=2020-01-31');
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const ls = r.body.summary.leadSpend;
  assert.ok(ls, 'summary.leadSpend present');
  // 1860 (L1) + 924 (L2) + 1155 (L5) = 3939; Pending/Created/junk excluded.
  assert.equal(ls.totalCents, 3939);
  assert.equal(ls.attributedCents, 1860, 'only the linked lead attributes');
  assert.equal(ls.unattributedCents, 2079);
  assert.equal(ls.chargedLeads, 3);
  assert.equal(ls.attributedLeads, 1);
});

test('GET /:id/lead-cost returns cents for a linked charged lead, null otherwise', async () => {
  const a = await get(`/api/proposals/${proposalA}/lead-cost`);
  assert.equal(a.status, 200);
  assert.equal(Number(a.body.leadCost.lead_price_cents), 1860);
  assert.equal(a.body.leadCost.charge_state, 'Charged');

  const b = await get(`/api/proposals/${proposalB}/lead-cost`);
  assert.equal(b.status, 200);
  assert.equal(b.body.leadCost, null, 'no linked lead -> null');

  const junk = await get('/api/proposals/not-a-number/lead-cost');
  assert.equal(junk.status, 200, 'non-numeric id never 500s');
  assert.equal(junk.body.leadCost, null);
});
