require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// GET /api/invoices/t/:token carries contract_step (spec 2026-10-16 section 7):
// the step from the contract to a Deposit, Balance or Full Payment invoice's
// total, shown only when the stored lines sum to proposals.total_price to the
// cent. The route reads total_price to decide, and that column must never
// leave this public, token-gated route: the row is spread into the response,
// so the key set is pinned here.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.contractStep.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const clientIds = [];
const proposalIds = [];
let server, baseUrl;
const tokens = {};

// Everything the route sent before this lane, plus contract_step. A new key
// here is a new fact on a public page: add it only on purpose.
const PUBLIC_INVOICE_KEYS = [
  'id', 'token', 'proposal_id', 'invoice_number', 'label',
  'amount_due', 'amount_paid', 'status', 'due_date',
  'locked', 'locked_at', 'created_at', 'updated_at',
  'event_date', 'event_start_time', 'event_location',
  'event_type', 'event_type_custom', 'guest_count',
  'client_name', 'client_email',
  'line_items', 'payments', 'refunds', 'extension',
  'pending_payment', 'pending_payment_for_this_invoice',
  'contract_step',
];

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

async function seedProposal(totalPrice, status = 'sent') {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Contract Step Test', $1) RETURNING id`,
    [`cstep-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, $2, $3, 0) RETURNING id`,
    [c.rows[0].id, status, totalPrice]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

// Lines are synthetic [description, cents, source_type] triples, CENTS.
async function seedInvoice(proposalId, { label, amountDue, amountPaid = 0, status = 'sent', locked = false, lines }) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, locked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::boolean, CASE WHEN $7::boolean THEN NOW() ELSE NULL END) RETURNING id, token`,
    [proposalId, `INV-${crypto.randomBytes(6).toString('hex')}`, label, amountDue, amountPaid, status, locked]
  );
  for (const [description, cents, sourceType] of lines) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
       VALUES ($1, $2, 1, $3, $3, $4)`,
      [inv.rows[0].id, description, cents, sourceType]
    );
  }
  return inv.rows[0];
}

const CONTRACT_LINES = [['Test Package', 80000, 'package'], ['Test Add-on', 20000, 'addon']];

before(async () => {
  // A $1,000.00 contract whose invoice lines sum to it.
  const live = await seedProposal('1000.00');
  tokens.deposit = (await seedInvoice(live, { label: 'Deposit', amountDue: 10000, lines: CONTRACT_LINES })).token;
  tokens.balance = (await seedInvoice(live, { label: 'Balance', amountDue: 90000, lines: CONTRACT_LINES })).token;
  tokens.additional = (await seedInvoice(live, { label: 'Additional Services', amountDue: 10000, lines: CONTRACT_LINES })).token;

  // A locked, paid Deposit after a $50.00 contract refund: the refund lowered
  // total_price and the invoice's amounts, never its lines.
  const refunded = await seedProposal('950.00', 'deposit_paid');
  tokens.refundedDeposit = (await seedInvoice(refunded, {
    label: 'Deposit', amountDue: 5000, amountPaid: 5000, status: 'paid', locked: true, lines: CONTRACT_LINES,
  })).token;

  // No contract total at all.
  const noTotal = await seedProposal(null);
  tokens.noTotal = (await seedInvoice(noTotal, { label: 'Deposit', amountDue: 10000, lines: CONTRACT_LINES })).token;

  // Prod invoice 211's shape, synthetic values: a Check Cherry Balance whose
  // lines carry a -$100.00 less-deposit line, locked and paid with $200.00,
  // then a $100.00 contract refund on that payment. The refund took
  // total_price 300.00 -> 200.00 and amount_due and amount_paid 20000 ->
  // 10000 (with the stamped reversal row reconciliation writes); the lines
  // never moved. Their sum (20000) now meets the new contract by coincidence,
  // so only the refund the page lists keeps the deposit from printing twice.
  const ccBooking = await seedProposal('200.00', 'completed');
  const ccBalance = await seedInvoice(ccBooking, {
    label: 'Balance', amountDue: 10000, amountPaid: 10000, status: 'paid', locked: true,
    lines: [['Test Package', 30000, 'package'], ['Test less deposit', -10000, 'manual']],
  });
  tokens.refundedCcBalance = ccBalance.token;
  const ccPayment = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
     VALUES ($1, 'balance', 20000, 'succeeded') RETURNING id`,
    [ccBooking]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 20000)`,
    [ccBalance.id, ccPayment.rows[0].id]
  );
  const ccRefund = await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 10000, 'Test contract refund', 300.00, 200.00, 'succeeded') RETURNING id`,
    [ccBooking, ccPayment.rows[0].id]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount, refund_id) VALUES ($1, $2, -10000, $3)`,
    [ccBalance.id, ccPayment.rows[0].id, ccRefund.rows[0].id]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    // proposal_refunds RESTRICT proposal_payments and proposals, so they go
    // first; invoice_payments and invoice_line_items cascade with their
    // invoice; invoices RESTRICT proposals.
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [proposalIds]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a Deposit invoice whose lines sum to the contract returns the Deposit step', async () => {
  const r = await get(`/api/invoices/t/${tokens.deposit}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.deepEqual(r.body.invoice.contract_step,
    { contract_total_cents: 100000, step_cents: 90000, step_label: 'Balance, billed later' });
  assert.equal(r.body.invoice.amount_due, 10000, 'display only: amount_due is the stored figure');
});

test('a Balance invoice whose lines sum to the contract returns the Balance step', async () => {
  const r = await get(`/api/invoices/t/${tokens.balance}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.deepEqual(r.body.invoice.contract_step,
    { contract_total_cents: 100000, step_cents: 10000, step_label: 'Less deposit and earlier payments' });
});

test('the response never carries the proposal total, and adds only contract_step', async () => {
  for (const token of Object.values(tokens)) {
    const r = await get(`/api/invoices/t/${token}`);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
    assert.equal(r.raw.includes('proposal_total_price'), false, 'the proposal total never leaves the server');
    assert.equal(r.raw.includes('total_price'), false, 'no total_price key of any name');
    assert.deepEqual(Object.keys(r.body.invoice).sort(), [...PUBLIC_INVOICE_KEYS].sort());
  }
});

test('a refunded locked Deposit (lines unchanged, total_price lowered) returns contract_step null', async () => {
  const r = await get(`/api/invoices/t/${tokens.refundedDeposit}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.ok('contract_step' in r.body.invoice, 'the key is present');
  assert.equal(r.body.invoice.contract_step, null);
});

test('a non-contract label returns contract_step null even when its lines sum to the contract', async () => {
  const r = await get(`/api/invoices/t/${tokens.additional}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.equal(r.body.invoice.contract_step, null);
});

test('a refunded invoice whose old lines meet the new total by coincidence returns contract_step null', async () => {
  const r = await get(`/api/invoices/t/${tokens.refundedCcBalance}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.equal(r.body.invoice.refunds.length, 1, 'the page lists the refund');
  assert.equal(Number(r.body.invoice.refunds[0].amount), 10000);
  assert.equal(r.body.invoice.contract_step, null);
});

test('a NULL total_price returns contract_step null', async () => {
  const r = await get(`/api/invoices/t/${tokens.noTotal}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.raw}`);
  assert.equal(r.body.invoice.contract_step, null);
});
