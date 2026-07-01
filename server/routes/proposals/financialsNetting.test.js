require('dotenv').config();

// Lane A polish: GET /api/proposals/financials — verifies the read-side refund
// netting edges the Lane A review flagged:
//   #1 unlinkedRefundsCents: a payment_id-NULL refund is netted in Collected but
//      attaches to no ledger row, so its total is surfaced separately.
//   #2 net_amount is GREATEST(amount - refunded, 0) — a single payment's row can
//      never render negative.
// The route is global (all proposals), so we assert DELTAS around a seeded set
// plus row-scoped values. Hand-rolled harness in the drinkPlans.beo.test.js style.

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

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminUserId, adminToken;
let clientId, proposalId, p1Id, p2Id;

function authGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedPayment(amount) {
  return (await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'invoice', $3, 'succeeded') RETURNING id`,
    [proposalId, `pi_${NONCE}_${crypto.randomBytes(3).toString('hex')}`, amount])).rows[0].id;
}

async function seedRefund({ paymentId, amount }) {
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, stripe_refund_id, amount, status, reason, total_price_before, total_price_after)
     VALUES ($1, $2, $3, $4, 'succeeded', 'test', 0, 0)`,
    [proposalId, paymentId, `re_${NONCE}_${crypto.randomBytes(3).toString('hex')}`, amount]
  );
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`fin-netting-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query("INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`Fin Netting ${NONCE}`, `fin-netting-c-${NONCE}@example.com`]);
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'deposit_paid', 500, 150) RETURNING id`,
    [clientId]);
  proposalId = p.rows[0].id;

  const app = express();
  app.use('/api/proposals', metadataRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('financials: unlinkedRefundsCents surfaces a payment_id-NULL refund; Collected nets all refunds; rows net linked + clamp', async () => {
  // Capture base BEFORE seeding, so the delta reflects payments minus refunds.
  const base = (await authGet('/api/proposals/financials?basis=paid')).body.summary;

  p1Id = await seedPayment(10000); // linked refund 3000 -> net 7000
  p2Id = await seedPayment(5000);  // over-refund 6000 -> net clamps to 0
  await seedRefund({ paymentId: p1Id, amount: 3000 }); // linked to P1
  await seedRefund({ paymentId: p2Id, amount: 6000 }); // over-refund of P2 (5000)
  await seedRefund({ paymentId: null, amount: 2000 }); // UNLINKED (#1)

  const res = await authGet('/api/proposals/financials?basis=paid');
  assert.equal(res.status, 200, res.raw);
  const sum = res.body.summary;

  // #1: unlinkedRefundsCents rose by exactly the unlinked 2000.
  assert.equal(Number(sum.unlinkedRefundsCents) - Number(base.unlinkedRefundsCents || 0), 2000);

  // Collected nets ALL refunds (linked + over + unlinked): +150 payments - 110 refunds = +40.
  assert.equal(Math.round((sum.collected - base.collected) * 100), 4000);

  const rows = res.body.recentPayments;
  const r1 = rows.find((r) => r.id === p1Id);
  const r2 = rows.find((r) => r.id === p2Id);
  assert.ok(r1 && r2, 'both seeded payments appear in the ledger');
  // Per-row netting of the linked refund.
  assert.equal(Number(r1.refunded_cents), 3000);
  assert.equal(Number(r1.net_amount), 7000);
  // #2: over-refunded row clamps to 0 (never negative).
  assert.equal(Number(r2.net_amount), 0);
});
