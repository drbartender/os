// The proposal page's checkout gating, pure. Extracted from ProposalView.js
// (bank debit in flight, spec 2026-09-14 section 8.3) so the pending state is
// one more input, tested on its own, and the page is wiring.
//
// Inputs:
//   proposal      the loaded row (status, client_signed_at)
//   paid          a Stripe redirect landed and did not report failure (URL)
//   settlePhase   useSettle's phase: idle | settling | paid | fallback | pending
//   isPaid        paidState(row).kind !== 'none' (ROW truth)
//   pendingPayment  the row's pending_payment, or the poll's, or null
//
// A paid ROW wins over everything. A pending payment on an unpaid row is a
// settling state with a better card: no intents get minted, no pay controls
// show, and the pending card says what is happening.
const LIFECYCLE_PAID = ['deposit_paid', 'balance_paid', 'confirmed'];
const PAYABLE = ['sent', 'viewed', 'accepted'];

export function checkoutVisibility({ proposal, paid, settlePhase, isPaid, pendingPayment, payBlocked = false }) {
  const isAlreadySigned = !!(proposal && proposal.client_signed_at);
  const status = proposal ? proposal.status : null;
  // payBlocked: the rail answered 409 PAYMENT_IN_FLIGHT from its Stripe-side
  // read before the row carried a pending payment. Same gate, until reload.
  const pending = !isPaid && (!!pendingPayment || !!payBlocked);
  const settling = !isPaid && (pending || settlePhase === 'fallback' || (paid && isAlreadySigned));
  const isPayableStatus = !!proposal && !paid && !pending
    && !LIFECYCLE_PAID.includes(status) && PAYABLE.includes(status);
  const showSignAndPay = !isPaid && !settling && !isAlreadySigned && ['sent', 'viewed'].includes(status);
  const showPayOnly = !isPaid && !settling && isAlreadySigned && status === 'accepted';
  const showPaidCard = settling || isPaid;
  const paidCardPhase = isPaid ? 'paid'
    : pending ? 'pending'
      : settlePhase === 'fallback' ? 'fallback'
        : 'settling';
  return { settling, isPayableStatus, showSignAndPay, showPayOnly, showPaidCard, paidCardPhase };
}
