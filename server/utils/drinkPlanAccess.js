// A drink plan is "post-booking" only once the linked proposal has reached a
// deposit-paid (or later) state. Anything else — pre-deposit, missing, or an
// unknown/typo status — is treated as pre-booking and LOCKED. Fail-safe
// allowlist: we never expose the wizard (which can run a Stripe charge in
// ConfirmationStep) without a confirmed booking.
const POST_BOOKING_PROPOSAL_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

function isDrinkPlanPreBooking(proposalStatus) {
  return !POST_BOOKING_PROPOSAL_STATUSES.includes(proposalStatus);
}

module.exports = { isDrinkPlanPreBooking, POST_BOOKING_PROPOSAL_STATUSES };
