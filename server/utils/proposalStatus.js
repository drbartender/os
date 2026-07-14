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

// THE definition of "counts as booked". A proposal in one of these statuses has
// been signed-and-paid (deposit or beyond) and is treated as a real, revenue-
// bearing booking. This single set gates: drink-plan access (drinkPlanAccess.js),
// change-request eligibility + edit window (changeRequests.js), the reschedule-
// email guard (rescheduleProposal.js), option-group commit's "already converted,
// don't archive" check (proposalGroupCommit.js), and the client-portal focus
// summary's `booked` flag (routes/clientPortal/summary.js).
//
// SQL LITERALS ELSEWHERE INTENTIONALLY STAY LOCAL: several queries embed a status
// list inline and are NOT this bare set, so they must not be rewritten to
// bookedStatusSqlList() blindly. Known sites: metricsQueries, globalSearch,
// proposals/list, proposals/metadata, clients, and stripe's
// paymentIntentSucceeded — some are negations, and some add 'archived', so their
// literal differs from this set on purpose. bookedStatusSqlList() is exported for
// FUTURE consolidation of the sites that ARE exactly this set only.
//
// Shapes: consumers vary between a Set (.has) and an Array (.includes / passed as
// a pg param via = ANY / <> ALL). Provide both so no site has to reshape.
const BOOKED_STATUSES = Object.freeze([
  'deposit_paid', 'balance_paid', 'confirmed', 'completed',
]);

const BOOKED_SET = new Set(BOOKED_STATUSES);

function isBooked(status) {
  return BOOKED_SET.has(status);
}

// Quoted SQL fragment: 'deposit_paid','balance_paid','confirmed','completed'.
// Exported for future use; NOT wired into any SQL site in this lane.
function bookedStatusSqlList() {
  return BOOKED_STATUSES.map((s) => `'${s}'`).join(',');
}

module.exports = {
  reconcileProposalPaymentStatus,
  BOOKED_STATUSES, BOOKED_SET, isBooked, bookedStatusSqlList,
};
