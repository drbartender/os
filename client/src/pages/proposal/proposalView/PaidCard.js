import React from 'react';
import { fmt, formatDateShort } from './helpers';
import PendingPaymentCard from '../../../components/PendingPaymentCard';

// The card that replaces sign-and-pay once money is involved. Five phases:
//   settling  : a checkout redirect just landed and the row is not yet in a
//               paid state. NO dollar figure, no pay link, no claim.
//   fallback  : the poll budget ran out or was blocked. Still no numbers and
//               still no claim: a webhook that rolled back produces exactly
//               this state, so "your payment went through" would be a lie.
//   pending   : a bank debit is processing (spec 2026-09-14). The shared card, no pay link, no paid claim.
//   blocked   : the rail refused a new payment (409) and the reloaded row has
//               no processing payment yet. The rail's own message is the copy
//               (`blockedMessage`): it names which of three states applies,
//               and only one of them is a processing bank debit.
//   paid      : the row is settled; every figure below comes from `state`,
//               which paidState() derived from the row. With a pendingPayment
//               (a balance settling by bank debit) BOTH deposit branches, the
//               due-by line and the autopay line, give way to the processing
//               copy, and Pay balance is hidden: autopay will not charge while
//               money is in flight, so "will be automatically charged" would
//               be false for the whole window.
const BLOCKED_FALLBACK = 'We could not start another payment for this event. Refresh the page in a moment, '
  + 'and if it still shows as unpaid, email contact@drbartender.com.';

export default function PaidCard({
  phase, state, autopayEnrolled, balanceDueDate, openInvoiceToken, drinkPlanToken, onRefresh,
  pendingPayment = null, blockedMessage = '',
}) {
  if (phase === 'settling') {
    return (
      <div className="proposal-paid-card is-pending" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <h3 className="proposal-paid-title">Confirming your payment</h3>
        <p className="proposal-paid-sub">This usually takes a few seconds.</p>
      </div>
    );
  }

  if (phase === 'fallback') {
    return (
      <div className="proposal-paid-card is-pending" role="status" aria-live="polite">
        <h3 className="proposal-paid-title">We are still confirming your payment.</h3>
        <p className="proposal-paid-sub">
          You will get a confirmation email as soon as it clears. If nothing arrives within the hour,
          reply to any of our emails and we will sort it out.
        </p>
        <button type="button" className="btn" onClick={onRefresh} style={{ marginTop: '4px' }}>
          Refresh
        </button>
      </div>
    );
  }

  if (phase === 'pending') {
    return <PendingPaymentCard amountCents={pendingPayment?.amount_cents} startedAt={pendingPayment?.started_at} />;
  }

  if (phase === 'blocked') {
    return (
      <div className="proposal-paid-card is-pending" role="status" aria-live="polite">
        <h3 className="proposal-paid-title">A payment for this event is already underway.</h3>
        <p className="proposal-paid-sub">{blockedMessage || BLOCKED_FALLBACK}</p>
        <button type="button" className="btn" onClick={onRefresh} style={{ marginTop: '4px' }}>
          Refresh
        </button>
      </div>
    );
  }

  const isFullyPaid = state.kind === 'full';
  return (
    <div className="proposal-paid-card">
      <div className="proposal-paid-check" aria-hidden="true">✓</div>
      {isFullyPaid ? (
        <>
          <h3 className="proposal-paid-title">Fully paid.</h3>
          <p className="proposal-paid-sub">
            {state.completed
              ? 'This event has wrapped. Thanks for having us.'
              : "Your booking is confirmed. We'll be in touch with event details closer to the date."}
          </p>
        </>
      ) : (
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          {pendingPayment ? (
            <PendingPaymentCard bare amountCents={pendingPayment.amount_cents} startedAt={pendingPayment.started_at} />
          ) : autopayEnrolled ? (
            <p className="proposal-paid-sub">
              Your remaining balance of {fmt(state.remaining)} will be automatically charged on {formatDateShort(balanceDueDate)}.
            </p>
          ) : (
            <p className="proposal-paid-sub">
              Your remaining balance of {fmt(state.remaining)} is due by {formatDateShort(balanceDueDate)}.
            </p>
          )}
        </>
      )}
      {!isFullyPaid && !pendingPayment && openInvoiceToken && (
        <a href={`/invoice/${openInvoiceToken}`} className="btn btn-primary" style={{ marginTop: '4px' }}>
          Pay balance
        </a>
      )}
      {drinkPlanToken && !state.completed && (
        <a href={`/plan/${drinkPlanToken}`} className="proposal-paid-link">
          Open the Potion Planner →
        </a>
      )}
    </div>
  );
}
