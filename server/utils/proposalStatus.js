'use strict';
/**
 * Shared payment-status reconciliation (spec §6). PURE — no DB, no Stripe.
 *
 * The DEMOTE-only ladder was historically inline in refundHelpers.js; it is now
 * shared so every price/payment move (refund, admin edit, checkout recompute)
 * keeps proposals.status honest in BOTH directions. A move never PROMOTES
 * (promotion happens only on a money-IN event); it demotes a now-underpaid
 * proposal so no surface shows "Paid in full" when it isn't, and flags an
 * overpayment for an admin-issued refund when amount_paid > total_price.
 *
 * Only the pure payment statuses (deposit_paid / balance_paid) demote.
 * 'confirmed'/'completed' are lifecycle states and are left untouched.
 *
 * @returns {{status:string, changed:boolean, autopayDisarmed:boolean,
 *            overpaid:boolean, overpaidCents:number}}
 */
function reconcileProposalPaymentStatus({ status, amountPaid, totalPrice }) {
  const paidCents = Math.round(Number(amountPaid || 0) * 100);
  const totalCents = Math.round(Number(totalPrice || 0) * 100);
  const overpaid = paidCents > totalCents;
  const overpaidCents = overpaid ? paidCents - totalCents : 0;

  let next = status;
  if (status === 'balance_paid' || status === 'deposit_paid') {
    if (paidCents <= 0) next = 'accepted';
    else if (paidCents < totalCents) next = 'deposit_paid';
    // paidCents >= totalCents → unchanged (still fully paid at the corrected total)
  }
  const changed = next !== status;
  // CRITICAL (mirrors refundHelpers): only the was-fully-paid transition disarms
  // autopay, so a normal deposit-stage move leaves legitimate future autopay armed.
  const autopayDisarmed = status === 'balance_paid' && next === 'deposit_paid';
  return { status: next, changed, autopayDisarmed, overpaid, overpaidCents };
}

module.exports = { reconcileProposalPaymentStatus };
