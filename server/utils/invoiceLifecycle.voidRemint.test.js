require('dotenv').config();

// Regression for createBalanceInvoice's idempotency check (push review,
// 2026-07-30). This is the ONLY code path in the repo that ever inserts a
// label='Balance' row, and its check used to ignore status. Once the new Void
// control on the admin payment panel voided a Balance invoice, nothing could
// ever mint a replacement: refreshUnlockedInvoices skips voided rows,
// createInvoiceOnSend finds the non-void Deposit and returns null, and
// findOpenInvoiceForBalance has nothing for a later payment to link to. The
// remaining balance became uncollectable through every automated surface, with
// no un-void endpoint to recover it. The batch's own design post-mortem named
// this as a precondition for shipping the Void UI.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { createBalanceInvoice } = require('./invoiceLifecycle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLifecycle.voidRemint.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
const propIds = [];

async function seedProposal({ totalPrice, amountPaid }) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount)
     VALUES ($1, 'deposit_paid', $2, $3, $4, 100) RETURNING id`,
    [clientId, `vrm-${NONCE}`, totalPrice, amountPaid]
  );
  propIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function addInvoice(proposalId, { label, amountDue, status, locked = false }) {
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, 0, $5, $6) RETURNING id`,
    [proposalId, `INV-${crypto.randomBytes(4).toString('hex')}`, label, amountDue, status, locked]
  );
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`VRM ${NONCE}`, `vrm-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
});

after(async () => {
  for (const id of propIds) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)', [id]);
    await pool.query('DELETE FROM invoices WHERE proposal_id=$1', [id]);
    await pool.query('DELETE FROM proposals WHERE id=$1', [id]);
  }
  await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
  await pool.end();
});

test('a VOIDED Balance invoice does not block a fresh one', async () => {
  const proposalId = await seedProposal({ totalPrice: 2000, amountPaid: 100 });
  const voidedId = await addInvoice(proposalId, { label: 'Balance', amountDue: 190000, status: 'void' });

  const minted = await createBalanceInvoice(proposalId);

  assert.ok(minted, 'a voided Balance must be re-mintable or the receivable is stranded');
  assert.notEqual(minted.id, voidedId);
  assert.equal(minted.label, 'Balance');
  assert.equal(minted.amount_due, 190000, 'rebuilt from total_price - amount_paid');

  const live = await pool.query(
    "SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'",
    [proposalId]
  );
  assert.equal(live.rows[0].n, 1, 'exactly one live Balance, the voided row stays voided');
});

test('a LIVE Balance invoice still blocks a second one', async () => {
  const proposalId = await seedProposal({ totalPrice: 2000, amountPaid: 100 });
  await addInvoice(proposalId, { label: 'Balance', amountDue: 190000, status: 'sent' });

  const second = await createBalanceInvoice(proposalId);

  assert.equal(second, null, 'idempotency must survive the void carve-out');
  const all = await pool.query(
    "SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1 AND label = 'Balance'",
    [proposalId]
  );
  assert.equal(all.rows[0].n, 1, 'no duplicate Balance row');
});

test('a voided Balance alongside a live one is still a no-op', async () => {
  const proposalId = await seedProposal({ totalPrice: 2000, amountPaid: 100 });
  await addInvoice(proposalId, { label: 'Balance', amountDue: 190000, status: 'void' });
  await addInvoice(proposalId, { label: 'Balance', amountDue: 190000, status: 'sent' });

  assert.equal(await createBalanceInvoice(proposalId), null);
});
