// Payment→invoice linking (guarded credit + anomaly warn). Extracted verbatim from invoiceHelpers.js.

'use strict';

const Sentry = require('@sentry/node');
const { lockInvoice } = require('./invoiceLifecycle');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');

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
 * Email the money-anomaly lane about an invoice-link overflow (spec
 * 2026-08-28 §4e). Callers invoke this from their POST-COMMIT tail with the
 * figures linkPaymentToInvoice returned in the transaction: notifyAdminCategory
 * runs pool.query, and calling it while holding a transaction client is the
 * one-pooled-connection deadlock (SERVER-17; 2026-07-13). Email only, own
 * catch, never throws. After the deposit-to-full upgrade an overflow on the
 * contract path should be impossible, so this email means something new.
 *
 * Two shape rules here are load-bearing, not tidiness.
 *
 * The destructure lives INSIDE the try, not in the parameter list. Parameter
 * destructuring runs during binding, OUTSIDE the try, so a bare
 * notifyLinkOverflow() or a notifyLinkOverflow(null) would reject past the catch
 * and take a webhook post-commit tail down with it; `args || {}` inside the try
 * makes the stated never-rejects invariant true for a null argument too, which a
 * `= {}` default alone does not cover.
 *
 * The credited figure is read as `creditCents ?? creditedCents` because
 * linkPaymentToInvoice returns `creditedCents` while this notifier's copy speaks
 * of creditCents. All three call sites hand-bridge that rename today; accepting
 * both names means a future caller that spreads the link result straight through
 * still emails the real number instead of "$0.00 was credited" on a live overflow.
 */
async function notifyLinkOverflow(args) {
  try {
    const {
      proposalId, invoiceId, paymentId, amountCents, creditCents, creditedCents, overflowCents, linked, reason,
    } = args || {};
    const credited = creditCents ?? creditedCents;
    // Lazy: adminNotifications pulls in email + SMS; keep this module's
    // import graph flat (invoiceHelpers is required nearly everywhere).
    const { notifyAdminCategory } = require('./adminNotifications');
    const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
    const refused = linked === false;
    const text =
      `A payment of ${dollars(amountCents)} landed on invoice ${invoiceId} (proposal #${proposalId}). `
      + (refused
        ? `The invoice refused the credit (${reason || 'refused'}), so the whole ${dollars(overflowCents)} has no invoice `
        : `${dollars(credited)} was credited to the invoice and ${dollars(overflowCents)} has no invoice `)
      + `behind it. Payment row ${paymentId}. The proposal ledger is correct; the invoice sub-ledger is `
      + `short by that amount.`;
    await notifyAdminCategory({
      category: 'payment_failure',
      subject: `Invoice link overflow on proposal #${proposalId}`,
      emailText: text,
      emailHtml: `<p>${text}</p>`,
    });
  } catch (err) {
    console.error('notifyLinkOverflow failed (non-blocking):', err && err.message);
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
 * @returns {Promise<{linked: boolean, reason?: string, creditedCents: number, overflowCents: number, proposalId: number|null, invoiceId: number}>}
 *   A refusal carries the same money fields as a capped link, with the whole
 *   payment as overflow: to the ledger a refused credit IS a total overflow,
 *   and the post-commit email must fire for it (spec 2026-08-28 section 4e).
 */
async function linkPaymentToInvoice(invoiceId, paymentId, amountCents, dbClient) {
  const invRes = await dbClient.query(
    'SELECT proposal_id, status, amount_due, amount_paid FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
  const inv = invRes.rows[0];
  if (!inv) {
    warnLinkAnomaly('missing_invoice', { invoiceId, paymentId, amountCents });
    return { linked: false, reason: 'not_found', creditedCents: 0, overflowCents: amountCents, proposalId: null, invoiceId };
  }
  if (inv.status !== 'sent' && inv.status !== 'partially_paid') {
    warnLinkAnomaly('not_payable', { invoiceId, status: inv.status, paymentId, amountCents });
    return { linked: false, reason: 'not_payable', status: inv.status, creditedCents: 0, overflowCents: amountCents, proposalId: inv.proposal_id, invoiceId };
  }
  const remainingCents = Math.max(0, inv.amount_due - inv.amount_paid);
  const creditCents = Math.min(amountCents, remainingCents);
  const overflowCents = amountCents - creditCents;
  if (creditCents <= 0) {
    warnLinkAnomaly('no_remaining_due', { invoiceId, paymentId, amountCents, remainingCents });
    return { linked: false, reason: 'no_remaining_due', creditedCents: 0, overflowCents: amountCents, proposalId: inv.proposal_id, invoiceId };
  }
  if (overflowCents > 0) {
    warnLinkAnomaly('overflow_capped', {
      invoiceId, proposalId: inv.proposal_id, paymentId, amountCents, remainingCents, creditCents, overflowCents,
    });
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
  return { linked: true, creditedCents: creditCents, overflowCents, proposalId: inv.proposal_id, invoiceId };
}

/**
 * The contract-payment link all three entrances share (admin record-payment,
 * payment_intent.succeeded, checkout.session.completed): the oldest open
 * invoice, off-ledger labels excluded (an open Service Extension invoice must
 * never absorb a contract payment; this lookup is label-blind), then
 * linkPaymentToInvoice. Returns the post-commit overflow payload when any of
 * the payment did not reach the invoice (a capped overflow, or a refusal,
 * which is the whole payment), else null. One function because the three
 * copies drifted once: the off-ledger exclusion reached one rail 2026-08-03
 * and the other two 2026-08-28. No open invoice at all returns null with no
 * payload; that shape is the checkout rail's documented residue.
 */
async function linkOpenContractInvoice(proposalId, paymentId, amountCents, dbClient) {
  const openInvoice = await dbClient.query(
    `SELECT id FROM invoices
      WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid')
        AND NOT (label = ANY($2::text[]))
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [proposalId, OFF_LEDGER_INVOICE_LABELS]
  );
  if (!openInvoice.rows[0]) return null;
  const linkResult = await linkPaymentToInvoice(openInvoice.rows[0].id, paymentId, amountCents, dbClient);
  if (!linkResult || !(linkResult.overflowCents > 0)) return null;
  return {
    ...linkResult,
    proposalId: linkResult.proposalId ?? proposalId,
    paymentId, amountCents, creditCents: linkResult.creditedCents,
  };
}

module.exports = {
  linkPaymentToInvoice,
  linkOpenContractInvoice,
  notifyLinkOverflow,
};
