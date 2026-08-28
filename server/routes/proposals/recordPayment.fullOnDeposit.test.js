// The admin door to the same hole (spec 2026-08-28 §4d, seam sweep L2).
// Gated on the route's DERIVED isFullyPaid, not the request's paid_in_full
// flag: an admin who types the full remaining amount without ticking the box
// is just as fully paid. Also stamps payment_type, so the row agrees with the
// invoice.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.fullOnDeposit.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
// actions.js destructures notifyLinkOverflow from invoiceHelpers at require
// time, so the capturing stub must be in place BEFORE the router is required.
const overflowCalls = [];
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const actionsRouter = require('./actions');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let server, baseUrl, adminId, adminToken, clientId;
const proposalIds = [];

async function seed({ totalPrice = 550, invoiceDue = 10000 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours,
                            total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot, payment_type, balance_due_date)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'accepted', 'Cocktail Party', '6:00 PM', 4,
             $2, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb, 'deposit',
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [clientId, totalPrice]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', $3, 0, 'sent', false) RETURNING id`,
    [p.rows[0].id, `RFD${NONCE}${proposalIds.length}`, invoiceDue]
  );
  return { proposalId: p.rows[0].id, invoiceId: i.rows[0].id };
}

before(async () => {
  const a = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`, [`recpay-fod-${NONCE}-admin@example.test`]);
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const c = await pool.query(`INSERT INTO clients (name, email, email_status) VALUES ('Record Full On Deposit', $1, 'ok') RETURNING id`, [`recpay-fod-${NONCE}@example.test`]);
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function postJson(path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` };
    const r = http.request({ method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers }, (res) => {
      let buf = '';
      res.on('data', (ch) => { buf += ch; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

async function expectOneFullInvoice({ proposalId, invoiceId }) {
  const invs = (await pool.query(`SELECT id, label, amount_due, amount_paid, status, locked FROM invoices WHERE proposal_id = $1 AND status <> 'void' ORDER BY id`, [proposalId])).rows;
  assert.equal(invs.length, 1, JSON.stringify(invs));
  assert.equal(invs[0].id, invoiceId, 'the same row, re-derived, not a new one');
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);
  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1', [invoiceId])).rows;
  assert.equal(link.length, 1);
  assert.equal(Number(link[0].amount), 55000);
  const prop = (await pool.query('SELECT status, amount_paid, payment_type FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(prop.payment_type, 'full', 'the row agrees with the invoice');
}

test('paid_in_full on deposit terms ends with one Full Payment invoice at the total, paid, locked, payment_type stamped', async () => {
  const s = await seed();
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await expectOneFullInvoice(s);
});

test('a typed amount that clears the balance, WITHOUT the paid_in_full box, takes the same path', async () => {
  const s = await seed();
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { amount: 550, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await expectOneFullInvoice(s);
});

test('a partial record that overfills the open invoice emails the overflow lane once, after the response', async () => {
  // Not fully paid, so no upgrade; the open invoice is smaller than the
  // applied amount, so the cap credits $100 and $100 overflows. The route's
  // own cap (applied = min(amount, total - paid)) does not bite here because
  // the total is $3000. This is the shape the existing invoiceCap test
  // cannot produce: there the applied amount equals the invoice's due exactly.
  overflowCalls.length = 0;
  const s = await seed({ totalPrice: 3000, invoiceDue: 10000 });
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { amount: 200, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(overflowCalls.length, 1, 'one overflow email, post-commit');
  assert.equal(overflowCalls[0].proposalId, s.proposalId);
  assert.equal(overflowCalls[0].invoiceId, s.invoiceId);
  assert.equal(overflowCalls[0].creditCents, 10000);
  assert.equal(overflowCalls[0].overflowCents, 10000);
  const inv = (await pool.query('SELECT label, amount_paid, status FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'no upgrade on a partial record');
  assert.equal(Number(inv.amount_paid), 10000);
  assert.equal(inv.status, 'paid');
});

// A balance record on deposit terms: fully paid, but NOT the first money on the
// row, so the terms really were deposit-then-balance. payment_type must stay
// 'deposit' (webhook parity: the balance branch never touches it), the paid and
// locked Deposit invoice must not be re-derived, and the Balance invoice takes
// the credit.
async function seedDepositPaid() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours,
                            total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot, payment_type, balance_due_date)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'Cocktail Party', '6:00 PM', 4,
             550, 100, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb, 'deposit',
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [clientId]
  );
  proposalIds.push(p.rows[0].id);
  const n = proposalIds.length;
  const dep = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid', true) RETURNING id`,
    [p.rows[0].id, `RFD${NONCE}D${n}`]
  );
  const bal = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', 45000, 0, 'sent', false) RETURNING id`,
    [p.rows[0].id, `RFD${NONCE}B${n}`]
  );
  return { proposalId: p.rows[0].id, depositInvoiceId: dep.rows[0].id, balanceInvoiceId: bal.rows[0].id };
}

test('a balance record that clears the balance on deposit terms leaves payment_type deposit and never re-derives the paid Deposit', async () => {
  const overflowBefore = overflowCalls.length;
  const s = await seedDepositPaid();
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { amount: 450, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);

  const prop = (await pool.query('SELECT status, amount_paid, payment_type FROM proposals WHERE id = $1', [s.proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(prop.payment_type, 'deposit', 'not the first money on the row, so the terms stay deposit');

  const dep = (await pool.query('SELECT label, amount_due, amount_paid, status, locked FROM invoices WHERE id = $1', [s.depositInvoiceId])).rows[0];
  assert.equal(dep.label, 'Deposit', 'the paid, locked Deposit is never re-derived');
  assert.equal(Number(dep.amount_due), 10000);
  assert.equal(Number(dep.amount_paid), 10000);
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);

  const bal = (await pool.query('SELECT label, amount_due, amount_paid, status, locked FROM invoices WHERE id = $1', [s.balanceInvoiceId])).rows[0];
  assert.equal(bal.label, 'Balance');
  assert.equal(Number(bal.amount_due), 45000);
  assert.equal(Number(bal.amount_paid), 45000, 'the Balance invoice took the credit');
  assert.equal(bal.status, 'paid');
  assert.equal(bal.locked, true);

  const breadcrumb = await pool.query(
    "SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'",
    [s.proposalId]
  );
  assert.equal(breadcrumb.rows.length, 0, 'no upgrade breadcrumb on a balance record');
  assert.equal(overflowCalls.length, overflowBefore, 'a clean balance record overflows nothing');
});
