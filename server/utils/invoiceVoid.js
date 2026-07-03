// Void a proposal's unpaid invoice(s). Lives in its own file (not invoiceHelpers.js,
// which is near the 1000-line cap). Used by the option-group choice-commit to
// clean up a losing option's dangling Deposit invoice (the retroactive case where
// a solo proposal was sent-and-invoiced before being pulled into a comparison).
//
// Guarded exactly like the admin void route (invoices.js): never void when money
// has landed. The proposal-level amount_paid=0 guard plus the per-invoice
// amount_paid=0 filter make this a no-op on any paid proposal/invoice, and
// idempotent (already-void rows fall outside the status filter).

'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { getStripe } = require('./stripeClient');

async function voidUnpaidProposalInvoice(proposalId, dbClient) {
  const { rows: [p] } = await dbClient.query(
    'SELECT amount_paid FROM proposals WHERE id = $1', [proposalId]);
  if (!p || Number(p.amount_paid || 0) > 0) return { voided: 0, invoiceIds: [] };

  const res = await dbClient.query(
    `UPDATE invoices SET status = 'void', updated_at = NOW()
      WHERE proposal_id = $1 AND amount_paid = 0 AND status IN ('draft', 'sent', 'partially_paid')
      RETURNING id`,
    [proposalId]);
  // invoiceIds lets callers cancel open checkout PaymentIntents post-commit
  // (cancelOpenInvoiceIntents); the helper itself runs inside the caller's tx
  // and must never make Stripe calls.
  return { voided: res.rowCount, invoiceIds: res.rows.map(r => r.id) };
}

// PI states that Stripe allows canceling. 'processing' and terminal states are
// excluded; a processing intent either settles (the linker's status guard then
// refuses the credit and alerts) or fails on its own.
const CANCELABLE_PI_STATES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

// Test hook, mirroring stripePayoutSync's _setStripeClientForTests pattern.
let testStripe = null;
function _setStripeForTests(stripe) { testStripe = stripe; }

/**
 * Best-effort cancellation of open PaymentIntents for a just-voided invoice
 * (seam-sweep M2). create-intent-for-invoice mints a fresh PI per checkout
 * open and records it in stripe_sessions ('pending') under the proposal, with
 * the invoice id only in the PI's Stripe metadata. Without this, a client who
 * already has the pay page open can complete a charge for an invoice the admin
 * just voided (the linker's status guard blocks the ledger corruption, but the
 * client is still charged and must be refunded).
 *
 * Runs AFTER the void commits, outside any transaction. Never throws: Stripe
 * being down must not block or unwind a void. Each failure is logged and
 * Sentry-warned.
 */
async function cancelOpenInvoiceIntents(proposalId, invoiceId) {
  const stripe = testStripe || getStripe();
  if (!stripe) return { canceled: 0, checked: 0 };
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `SELECT stripe_payment_intent_id FROM stripe_sessions
        WHERE proposal_id = $1 AND status = 'pending'
          AND stripe_payment_intent_id IS NOT NULL`,
      [proposalId]
    ));
  } catch (err) {
    console.warn('cancelOpenInvoiceIntents: session lookup failed:', err.message);
    return { canceled: 0, checked: 0 };
  }
  let canceled = 0;
  for (const row of rows) {
    const piId = row.stripe_payment_intent_id;
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      const piInvoiceId = pi.metadata && pi.metadata.invoice_id;
      if (String(piInvoiceId) === String(invoiceId) && CANCELABLE_PI_STATES.has(pi.status)) {
        await stripe.paymentIntents.cancel(pi.id);
        canceled += 1;
      }
    } catch (err) {
      console.warn(`cancelOpenInvoiceIntents: best-effort failure for ${piId}:`, err.message);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('invoice_void_pi_cancel_failed', {
          level: 'warning',
          tags: { util: 'invoiceVoid', step: 'cancelOpenInvoiceIntents' },
          extra: { proposalId, invoiceId, piId, error: err.message },
        });
      }
    }
  }
  return { canceled, checked: rows.length };
}

module.exports = { voidUnpaidProposalInvoice, cancelOpenInvoiceIntents, _setStripeForTests };
