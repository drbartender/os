// Payment→invoice linking (guarded credit + anomaly warn). Extracted verbatim from invoiceHelpers.js.

'use strict';

const Sentry = require('@sentry/node');
const { lockInvoice } = require('./invoiceLifecycle');

// ─── 10. linkPaymentToInvoice ────────────────────────────────────────────────

/**
 * Report an invoice-link anomaly loudly (console + Sentry) without throwing.
 * The proposal-side payment row is always recorded by callers, so money is
 * never lost when a link is refused; the alert is how the admin finds out.
 */
function warnLinkAnomaly(kind, details) {
  console.warn(`linkPaymentToInvoice ${kind}:`, JSON.stringify(details));
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`invoice_link_${kind}`, {
      level: 'warning',
      tags: { util: 'invoiceHelpers', step: 'linkPaymentToInvoice' },
      extra: details,
    });
  }
}

/**
 * Link a proposal payment to an invoice, update the invoice's amount_paid
 * and status, and lock it if fully paid.
 *
 * Guarded (seam-sweep M1/M2/L2): only 'sent'/'partially_paid' invoices accept
 * credit (a voided invoice must never be reanimated to paid by a stale
 * PaymentIntent; a paid one must never overfill), and the credit is capped at
 * the remaining due. The invoice_payments link row records the CAPPED amount
 * so the reconciliation invariant sum(invoice_payments.amount) ==
 * invoices.amount_paid holds. Refused/overflow cases warn via Sentry and
 * return { linked: false } instead of throwing; callers keep recording the
 * proposal-side payment, which stays the authoritative money record.
 *
 * @param {number} invoiceId
 * @param {number} paymentId    — proposal_payments.id
 * @param {number} amountCents
 * @param {object} dbClient     — must be a transaction client
 * @returns {Promise<{linked: boolean, reason?: string, creditedCents?: number, overflowCents?: number}>}
 */
async function linkPaymentToInvoice(invoiceId, paymentId, amountCents, dbClient) {
  const invRes = await dbClient.query(
    'SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
  const inv = invRes.rows[0];
  if (!inv) {
    warnLinkAnomaly('missing_invoice', { invoiceId, paymentId, amountCents });
    return { linked: false, reason: 'not_found' };
  }
  if (inv.status !== 'sent' && inv.status !== 'partially_paid') {
    warnLinkAnomaly('not_payable', { invoiceId, status: inv.status, paymentId, amountCents });
    return { linked: false, reason: 'not_payable', status: inv.status };
  }
  const remainingCents = Math.max(0, inv.amount_due - inv.amount_paid);
  const creditCents = Math.min(amountCents, remainingCents);
  const overflowCents = amountCents - creditCents;
  if (creditCents <= 0) {
    warnLinkAnomaly('no_remaining_due', { invoiceId, paymentId, amountCents, remainingCents });
    return { linked: false, reason: 'no_remaining_due' };
  }
  if (overflowCents > 0) {
    warnLinkAnomaly('overflow_capped', { invoiceId, paymentId, amountCents, creditCents, overflowCents });
  }
  await dbClient.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [invoiceId, paymentId, creditCents]
  );
  const invUpdate = await dbClient.query(
    'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
    [creditCents, invoiceId]
  );
  if (invUpdate.rows[0]) {
    const updated = invUpdate.rows[0];
    const newStatus = updated.amount_paid >= updated.amount_due ? 'paid' : 'partially_paid';
    await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, invoiceId]);
    // Only lock when fully paid. Locking partially_paid invoices would freeze
    // them before later proposal changes (addons, balance refresh) can flow
    // through, leaving stale balances no admin can adjust.
    if (newStatus === 'paid') {
      await lockInvoice(invoiceId, dbClient);
    }
  }
  return { linked: true, creditedCents: creditCents, overflowCents };
}

module.exports = {
  linkPaymentToInvoice,
};
