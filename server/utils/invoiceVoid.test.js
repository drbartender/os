'use strict';

// Run: DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test server/utils/invoiceVoid.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { voidUnpaidProposalInvoice } = require('./invoiceVoid');

const proposalIds = new Set();
const invoiceIds = new Set();
let invSeq = 0;

async function seed({ propAmountPaid = 0, invStatus = 'sent', invAmountPaid = 0 } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, amount_paid, pricing_snapshot, total_price)
     VALUES ('sent', $1, '{}'::jsonb, 1000) RETURNING id`, [propAmountPaid]);
  proposalIds.add(p.id);
  invSeq += 1;
  const { rows: [i] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
     VALUES ($1, $2, 10000, $3, $4) RETURNING id`,
    [p.id, `TEST-IV-${invSeq}`, invAmountPaid, invStatus]);
  invoiceIds.add(i.id);
  return { proposalId: p.id, invoiceId: i.id };
}

async function statusOf(invoiceId) {
  const { rows: [r] } = await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
  return r.status;
}

after(async () => {
  if (invoiceIds.size) await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [[...invoiceIds]]);
  if (proposalIds.size) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [[...proposalIds]]);
  await pool.end();
});

test('voids an unpaid invoice on an unpaid proposal', async () => {
  const { proposalId, invoiceId } = await seed({ propAmountPaid: 0, invStatus: 'sent', invAmountPaid: 0 });
  const res = await voidUnpaidProposalInvoice(proposalId, pool);
  assert.strictEqual(res.voided, 1);
  assert.strictEqual(await statusOf(invoiceId), 'void');
});

test('leaves invoices untouched when the proposal has been paid', async () => {
  const { proposalId, invoiceId } = await seed({ propAmountPaid: 100, invStatus: 'sent', invAmountPaid: 0 });
  const res = await voidUnpaidProposalInvoice(proposalId, pool);
  assert.strictEqual(res.voided, 0);
  assert.strictEqual(await statusOf(invoiceId), 'sent');
});

test('is idempotent (second call voids nothing)', async () => {
  const { proposalId } = await seed({ propAmountPaid: 0, invStatus: 'sent', invAmountPaid: 0 });
  await voidUnpaidProposalInvoice(proposalId, pool);
  const res = await voidUnpaidProposalInvoice(proposalId, pool);
  assert.strictEqual(res.voided, 0);
});

test('createInvoiceOnSend mints a FRESH invoice after a void (recovered proposal re-send)', async () => {
  const { createInvoiceOnSend } = require('./invoiceHelpers');
  const { proposalId } = await seed({ propAmountPaid: 0, invStatus: 'sent', invAmountPaid: 0 });
  await voidUnpaidProposalInvoice(proposalId, pool);

  // The proposal's ONLY invoice is now void; a re-send must create a new open
  // invoice (previously the any-invoice idempotency check returned null here,
  // leaving a recovered proposal with nothing for its payment to link to).
  const fresh = await createInvoiceOnSend(proposalId, pool);
  assert.ok(fresh && fresh.id, 'a fresh invoice is created despite the void one');
  invoiceIds.add(fresh.id);
  assert.strictEqual(fresh.status, 'sent');

  // And the check still prevents duplicates while an OPEN invoice exists.
  const dup = await createInvoiceOnSend(proposalId, pool);
  assert.strictEqual(dup, null, 'idempotent while a non-void invoice exists');
});
