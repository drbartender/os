// Row truth for the post-payment surfaces. Every dollar figure the paid card
// and the Payment Terms box render comes through here, from the proposal ROW,
// never from the URL. The ?paid=true flag proves a checkout redirect happened;
// it proves nothing about the row, which the webhook may not have written yet
// (measured 2026-08-28: the redirect lands ~1s after the webhook transaction
// starts and before it commits, on every full-payment conversion checked).

// The same set balanceAmount's inPaidState already used. `completed` is paid.
export const PAID_STATES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

export function isPaidState(status) {
  return PAID_STATES.includes(status);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// `renderedTotal` is the snapshot total the page renders (what balanceAmount
// reads today); `total` is the row's total_price (what isFullyPaid reads
// today). Keeping the two sources keeps the card and the breakdown above it
// printing the same remainder on an override'd proposal.
export function paidState(proposal, renderedTotal) {
  if (!proposal) return { kind: 'none', amountPaid: 0, total: 0, remaining: 0, completed: false };
  const amountPaid = num(proposal.amount_paid);
  const total = num(proposal.total_price);
  const n = Number(renderedTotal);
  const basis = renderedTotal == null || !Number.isFinite(n) ? total : n;
  const remaining = Math.max(0, basis - amountPaid);
  const completed = proposal.status === 'completed';
  // kind is gated on STATUS first: a non-paid status with full arithmetic is
  // still none. Today's isFullyPaid ignored status, and no surface depended on it.
  if (!isPaidState(proposal.status)) {
    return { kind: 'none', amountPaid, total, remaining, completed };
  }
  // `completed` is a lifecycle state, not a payment fact: the sweep only
  // completes fully paid events, but an admin can set it by hand with a
  // balance still owed, and that row must say so (and keep its pay link).
  const full = proposal.status === 'balance_paid' || amountPaid >= total - 0.01;
  return { kind: full ? 'full' : 'deposit', amountPaid, total, remaining, completed };
}

// Stripe appends redirect_status to return_url (our return_url already carries
// paid=true). Only `failed` is a failure. `pending` and `processing` are real
// values for bank debits and wallets, and mean "not yet", which the settling
// state handles. Never assert "nothing was charged" on anything but `failed`.
export function readRedirect(search) {
  const params = new URLSearchParams(search || '');
  const redirected = params.get('paid') === 'true';
  const failed = redirected && params.get('redirect_status') === 'failed';
  return { redirected, failed };
}
