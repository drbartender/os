require('dotenv').config();

// Root-cause regression for createAdditionalInvoiceIfNeeded (F2 review finding).
// Both callers — the admin re-price (crud.js) and the drink-plan submit (F2) —
// run refreshUnlockedInvoices() first, which rebuilds any unlocked Balance/Full
// Payment invoice from the NEW total (absorbing the price increase). So the
// Additional Services invoice must be minted ONLY when no unlocked balance-bearing
// invoice can absorb the delta (the fully-paid case); otherwise the delta is
// double-billed. These cases pin that guard for BOTH call sites.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { createAdditionalInvoiceIfNeeded } = require('./invoiceHelpers');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLifecycle.additionalInvoice.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
const propIds = [];

async function seedProposal(totalPrice) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount)
     VALUES ($1, 'deposit_paid', $2, $3, 100, 100) RETURNING id`,
    [clientId, `adi-${NONCE}`, totalPrice]
  );
  propIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function addInvoice(proposalId, { label, amountDue, amountPaid, status, locked }) {
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [proposalId, `INV-${crypto.randomBytes(4).toString('hex')}`, label, amountDue, amountPaid, status, locked]
  );
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`ADI ${NONCE}`, `adi-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
});

after(async () => {
  for (const id of propIds) {
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [id]);
    await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [id]);
    await pool.query("DELETE FROM proposals WHERE id=$1", [id]);
  }
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await pool.end();
});

test('deposit_paid shape (locked Deposit + unlocked Balance): returns null — refreshed Balance absorbs the delta, no double-bill', async () => {
  const id = await seedProposal(600); // new total 600, old 500 → delta 100
  await addInvoice(id, { label: 'Deposit', amountDue: 10000, amountPaid: 10000, status: 'paid', locked: true });
  await addInvoice(id, { label: 'Balance', amountDue: 50000, amountPaid: 0, status: 'sent', locked: false });
  const result = await createAdditionalInvoiceIfNeeded(id, 50000 /* oldTotalCents */);
  assert.strictEqual(result, null, 'must not mint Additional Services when an unlocked Balance will absorb the delta');
  const addl = await pool.query("SELECT id FROM invoices WHERE proposal_id=$1 AND label='Additional Services'", [id]);
  assert.strictEqual(addl.rows.length, 0, 'no Additional Services invoice created');
});

test('fully-paid shape (all balance-bearing invoices locked): mints Additional Services for the delta — the only surface', async () => {
  const id = await seedProposal(600);
  await addInvoice(id, { label: 'Deposit', amountDue: 10000, amountPaid: 10000, status: 'paid', locked: true });
  await addInvoice(id, { label: 'Balance', amountDue: 40000, amountPaid: 40000, status: 'paid', locked: true });
  const result = await createAdditionalInvoiceIfNeeded(id, 50000);
  assert.ok(result && result.id, 'must mint Additional Services when no unlocked balance invoice can absorb the delta');
  assert.strictEqual(result.label, 'Additional Services');
  assert.strictEqual(result.amount_due, 10000, 'delta = 60000 - 50000');
});

test('no locked invoices: returns null (refreshUnlockedInvoices handles everything)', async () => {
  const id = await seedProposal(600);
  await addInvoice(id, { label: 'Balance', amountDue: 50000, amountPaid: 0, status: 'sent', locked: false });
  const result = await createAdditionalInvoiceIfNeeded(id, 50000);
  assert.strictEqual(result, null);
});

test('delta <= 0: returns null even in the all-locked shape', async () => {
  const id = await seedProposal(500); // new total 500 == old 500
  await addInvoice(id, { label: 'Balance', amountDue: 50000, amountPaid: 50000, status: 'paid', locked: true });
  const result = await createAdditionalInvoiceIfNeeded(id, 50000);
  assert.strictEqual(result, null);
});
