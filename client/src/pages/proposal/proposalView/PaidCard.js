import React from 'react';
import { fmt, formatDateShort } from './helpers';

// The card that replaces sign-and-pay once money is involved. Three phases:
//   settling  : a checkout redirect just landed and the row is not yet in a
//               paid state. NO dollar figure, no pay link, no claim.
//   fallback  : the poll budget ran out or was blocked. Still no numbers and
//               still no claim: a webhook that rolled back produces exactly
//               this state, so "your payment went through" would be a lie.
//   paid      : the row is settled; every figure below comes from `state`,
//               which paidState() derived from the row.
export default function PaidCard({
  phase, state, autopayEnrolled, balanceDueDate, openInvoiceToken, drinkPlanToken, onRefresh,
}) {
  if (phase === 'settling') {
    return (
      <div className="proposal-paid-card" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <h3 className="proposal-paid-title">Confirming your payment</h3>
        <p className="proposal-paid-sub">This usually takes a few seconds.</p>
      </div>
    );
  }

  if (phase === 'fallback') {
    return (
      <div className="proposal-paid-card" role="status" aria-live="polite">
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
      ) : autopayEnrolled ? (
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          <p className="proposal-paid-sub">
            Your remaining balance of {fmt(state.remaining)} will be automatically charged on {formatDateShort(balanceDueDate)}.
          </p>
        </>
      ) : (
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          <p className="proposal-paid-sub">
            Your remaining balance of {fmt(state.remaining)} is due by {formatDateShort(balanceDueDate)}.
          </p>
        </>
      )}
      {!isFullyPaid && openInvoiceToken && (
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
