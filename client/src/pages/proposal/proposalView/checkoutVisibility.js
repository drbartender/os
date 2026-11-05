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
//   payBlocked    the rail answered 409 PAYMENT_IN_FLIGHT (latched until reload)
//
// A paid ROW wins over everything. A pending payment on an unpaid row is a
// settling state with a better card: no intents get minted, no pay controls
// show, and the pending card says what is happening.
//
// A 409 with no pending payment on the reloaded row is the blocked state. The
// rail refuses for three different reasons (a debit Stripe already sees before
// the webhook wrote the row, a bank account waiting on verification, a card
// that already settled and is being recorded), and only the first matches the
// processing card's copy, so the blocked phase shows the rail's own message.
const LIFECYCLE_PAID = ['deposit_paid', 'balance_paid', 'confirmed'];
const PAYABLE = ['sent', 'viewed', 'accepted'];

export function checkoutVisibility({ proposal, paid, settlePhase, isPaid, pendingPayment, payBlocked = false }) {
  const isAlreadySigned = !!(proposal && proposal.client_signed_at);
  const status = proposal ? proposal.status : null;
  const pending = !isPaid && !!pendingPayment;
  const blocked = !isPaid && !pending && !!payBlocked;
  const settling = !isPaid && (pending || blocked || settlePhase === 'fallback' || (paid && isAlreadySigned));
  const isPayableStatus = !!proposal && !paid && !pending && !blocked
    && !LIFECYCLE_PAID.includes(status) && PAYABLE.includes(status);
  const showSignAndPay = !isPaid && !settling && !isAlreadySigned && ['sent', 'viewed'].includes(status);
  const showPayOnly = !isPaid && !settling && isAlreadySigned && status === 'accepted';
  const showPaidCard = settling || isPaid;
  // Paid but never signed (audit 2026-11-05, M4): the deposit can settle before
  // the signature posts, and a Payment Link never asks for one. The server
  // accepts a late signature on a paid row (POST /t/:token/sign), so the page
  // offers the signature block beside the paid card.
  const showLateSign = isPaid && !isAlreadySigned && LIFECYCLE_PAID.includes(status);
  const paidCardPhase = isPaid ? 'paid'
    : pending ? 'pending'
      : blocked ? 'blocked'
        : settlePhase === 'fallback' ? 'fallback'
          : 'settling';
  return { settling, isPayableStatus, showSignAndPay, showPayOnly, showPaidCard, showLateSign, paidCardPhase };
}
