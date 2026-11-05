// The settle-time breadcrumbs of payment_intent.succeeded: the admin alert for money landing on a
// cancelled proposal, the gratuity-apply skip warning, and the unsigned-settle alert (audit
// PAY-02 / ESIG-03). Extracted verbatim from paymentIntentSucceeded.js, which sits at the file-size cap.
//
// Every function here is fire-and-forget from the handler's post-commit tail
// (or a plain console/Sentry breadcrumb): none takes a database client, none
// throws into the handler, and notifyAdminCategory self-guards. Copy carries no
// em dashes (client/admin copy convention).
const Sentry = require('@sentry/node');
const { notifyAdminCategory } = require('../../utils/adminNotifications');

// B3: email-first admin alert when a payment settles onto a cancelled (archived)
// proposal. Fire-and-forget from the post-commit tail; notifyAdminCategory self-
// guards, the extra catch keeps this from masking sibling post-commit work.
function notifyPaymentOnArchived(proposalId, amountCents, paymentType, archiveReason) {
  const dollars = `$${(amountCents / 100).toFixed(2)}`;
  const reasonSuffix = archiveReason ? ` (archive reason: ${archiveReason})` : '';
  const line = `A ${paymentType} payment of ${dollars} just settled on proposal #${proposalId}, which was already cancelled${reasonSuffix}. The money is in the ledger, but the cancellation refund already ran before it arrived. Open the proposal and refund this payment straight from the payment panel (the Refund button), which returns it without re-running the cancellation math. Do NOT expect the Cancel then Refund flow to catch it: the booking is already archived, so that path may report nothing is owed.`;
  return notifyAdminCategory({
    category: 'payment_failure',
    subject: `Payment received on a cancelled event (proposal #${proposalId})`,
    emailText: line,
    emailHtml: `<p>${line}</p>`,
  }).catch((err) => {
    console.error('payment_on_archived admin notify failed (non-blocking):', err && err.message);
  });
}

// Election-at-payment (spec 2026-08-03 §4.5): the gratuity apply must NEVER take
// the payment record down with it. Both the pre-write validation refusal and the
// SAVEPOINT rollback land here — loud breadcrumb, credit proceeds untouched.
// The admin reconciles from the alert; the money is always in the ledger.
function warnGratuityApplySkipped(reason, proposalId, intentId, metadata, err) {
  const line = `gratuity_apply_skipped (${reason}): proposal ${proposalId}, intent ${intentId}, `
    + `tip_jar=${metadata?.tip_jar}, gratuity_rate=${metadata?.gratuity_rate}`
    + (err ? ` — ${err.message}` : '');
  console.warn(line);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(line, 'warning');
  }
}

// Audit PAY-02 / ESIG-03: contract money (a deposit, a full payment, or a
// contract invoice that books the row) settled on a proposal the client never
// signed. The intent is minted at page load, before the signature, and the
// sign happens only in the browser before confirmPayment, so a client holding
// the secret can confirm without signing. The booking is converted and the
// money is in the ledger (refusing it would strand captured money outside the
// ledger); the fact is recorded in-tx (an unsigned_payment activity row) and
// surfaced here, post-commit: a Sentry warning and the admin's money-anomaly
// lane. Whether an unsigned deposit should be refused outright is a product
// decision for the e-signature lane (a client-side ordering change).
function notifyUnsignedSettle(proposalId, amountCents, paymentType) {
  const dollars = `$${(amountCents / 100).toFixed(2)}`;
  const line = `A ${paymentType} payment of ${dollars} just settled on proposal #${proposalId}, which the client has not signed. The booking is converted and the money is in the ledger, but no signed Event Services Agreement stands behind it. Open the proposal and send the client the proposal link to sign.`;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`unsigned_payment: proposal ${proposalId}, ${paymentType}, ${amountCents} cents`, {
      level: 'warning',
      tags: { webhook: 'stripe', route: '/webhook', issue: 'unsigned_payment' },
      extra: { proposalId, paymentType, amountCents },
    });
  }
  return notifyAdminCategory({
    category: 'payment_failure',
    subject: `Payment received on an unsigned proposal (proposal #${proposalId})`,
    emailText: line,
    emailHtml: `<p>${line}</p>`,
  }).catch((err) => {
    console.error('unsigned_payment admin notify failed (non-blocking):', err && err.message);
  });
}

module.exports = { notifyPaymentOnArchived, warnGratuityApplySkipped, notifyUnsignedSettle };
