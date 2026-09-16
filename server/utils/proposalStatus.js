'use strict';
/**
 * Shared payment-status reconciliation (spec §6). PURE — no DB, no Stripe.
 *
 * The ladder was historically inline in refundHelpers.js (demote-only); it is
 * now shared so every price/payment move (refund, admin edit, lab/extras fold,
 * checkout recompute) keeps proposals.status honest in BOTH directions. It
 * demotes a now-underpaid proposal so no surface shows "Paid in full" when it
 * isn't, and it RESTORES balance_paid when the corrected total is back at or
 * below what was paid, flagging any excess for an admin-issued refund.
 *
 * Why promotion lives here (2026-09-16, prod proposal 823): the ladder used to
 * demote only, on the theory that promotion belongs to a money-IN event. A
 * client added an Enhancement Lab syrup to a fully-paid proposal (demoted,
 * correctly) and removed it a minute later; nothing ever put balance_paid
 * back. Auto-complete keys on that label, so the event never completed,
 * payroll never accrued, and the bartender missed the pay run. A fully-paid
 * row is fully paid whichever direction the last move came from.
 *
 * Only the pure payment statuses (deposit_paid / balance_paid) move. Pre-
 * payment statuses never promote (money-in is still the only door INTO the
 * ladder), and 'confirmed'/'completed' are lifecycle states left untouched.
 *
 * @returns {{status:string, changed:boolean, autopayDisarmed:boolean,
 *            overpaid:boolean, overpaidCents:number}}
 */
function reconcileProposalPaymentStatus({ status, amountPaid, totalPrice }) {
  const paidCents = Math.round(Number(amountPaid || 0) * 100);
  const totalCents = Math.round(Number(totalPrice || 0) * 100);
  const overpaid = paidCents > totalCents;
  const overpaidCents = overpaid ? paidCents - totalCents : 0;

  // A total we cannot read (nullable column; undefined/''/NaN from a caller)
  // never promotes: the webhook's SQL reads "paid >= NULL" as not paid, and
  // promoting here would make the two disagree in the fail-open direction. A
  // genuine $0 total (a fully comped event: pricingEngine clamps an
  // over-discount at 0) DOES promote, exactly as the webhook's "paid >= 0"
  // does; refusing it would strand the comped event at deposit_paid, the same
  // failure class as prod 823.
  const totalKnown = totalPrice !== null && totalPrice !== undefined && totalPrice !== ''
    && Number.isFinite(Number(totalPrice));

  let next = status;
  if (status === 'balance_paid' || status === 'deposit_paid') {
    if (paidCents <= 0) next = 'accepted';
    else if (paidCents < totalCents) next = 'deposit_paid';
    else if (totalKnown) next = 'balance_paid'; // fully paid at the corrected total, either direction
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
