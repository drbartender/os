'use strict';

/**
 * One-off, idempotent backfill — proposal 54 (Ketan Patel).
 *
 * No Deposit invoice was ever created for this proposal (createInvoiceOnSend
 * never ran — Check Cherry cutover artifact). The $100 deposit (proposal_payments
 * #24, succeeded) is correctly reflected in proposals.amount_paid but has no
 * invoice row, so the admin invoice list shows only the Balance invoice.
 *
 * This synthesizes the Deposit invoice exactly as createInvoiceOnSend +
 * linkPaymentToInvoice would have, then backdates created_at/locked_at so it
 * sorts before INV-0009 in the admin list (ordered by created_at ASC).
 *
 * Re-run-safe: aborts if a Deposit invoice already exists for proposal 54.
 *
 *   node server/scripts/backfillProposal54DepositInvoice.js
 */

require('dotenv').config();
const { pool } = require('../db');
const {
  createInvoice,
  writeLineItems,
  generateLineItemsFromProposal,
  linkPaymentToInvoice,
} = require('../utils/invoiceHelpers');

const PROPOSAL_ID = 54;
const DEPOSIT_PAYMENT_ID = 24;          // proposal_payments.id for the $100 deposit
const EXPECTED_DEPOSIT_CENTS = 10000;   // $100.00
// 1s before INV-0009.created_at (2026-05-15T22:54:24.634Z) so Deposit sorts first.
const BACKDATE_CREATED_AT = '2026-05-15T22:54:23.000Z';
const BACKDATE_LOCKED_AT = '2026-05-15T22:54:24.634Z'; // deposit payment #24 time

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guard 1 — idempotency: a Deposit invoice must not already exist.
    const existing = await client.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Deposit' LIMIT 1",
      [PROPOSAL_ID]
    );
    if (existing.rows[0]) {
      console.log(`Deposit invoice already exists (id ${existing.rows[0].id}) — nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }

    // Guard 2 — verify the deposit payment is the shape we expect.
    const pay = await client.query(
      "SELECT id, amount, payment_type, status FROM proposal_payments WHERE id = $1 AND proposal_id = $2",
      [DEPOSIT_PAYMENT_ID, PROPOSAL_ID]
    );
    const p = pay.rows[0];
    if (!p || p.payment_type !== 'deposit' || p.status !== 'succeeded' || Number(p.amount) !== EXPECTED_DEPOSIT_CENTS) {
      throw new Error(`Deposit payment #${DEPOSIT_PAYMENT_ID} not in expected state: ${JSON.stringify(p)}`);
    }

    // Create the Deposit invoice (status 'sent'; linkPaymentToInvoice flips it
    // to 'paid' and locks it once the $100 payment is applied).
    const invoice = await createInvoice(
      { proposalId: PROPOSAL_ID, label: 'Deposit', amountDueCents: EXPECTED_DEPOSIT_CENTS, status: 'sent', dueDate: null },
      client
    );

    const lineItems = await generateLineItemsFromProposal(PROPOSAL_ID, client);
    await writeLineItems(invoice.id, lineItems, client);

    // Link the already-succeeded deposit payment → amount_paid 10000,
    // status 'paid', invoice locked (10000 >= 10000).
    await linkPaymentToInvoice(invoice.id, DEPOSIT_PAYMENT_ID, EXPECTED_DEPOSIT_CENTS, client);

    // Backdate so it orders before INV-0009 in the admin list.
    await client.query(
      'UPDATE invoices SET created_at = $1, locked_at = $2 WHERE id = $3',
      [BACKDATE_CREATED_AT, BACKDATE_LOCKED_AT, invoice.id]
    );

    const check = await client.query(
      "SELECT id, invoice_number, label, amount_due, amount_paid, status, locked, created_at FROM invoices WHERE id = $1",
      [invoice.id]
    );
    await client.query('COMMIT');
    console.log('Deposit invoice backfilled:', check.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); }
    console.error('Backfill failed (no changes committed):', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
