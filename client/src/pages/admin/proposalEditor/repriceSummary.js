// Pure decision + copy assembly for the booked-event reprice confirmation.
// Client-side PREDICTION of what PATCH /proposals/:id will do (crud.js:
// payment-status reconcile, additional-invoice creation, invoice refresh).
// It never becomes a second decision-maker: the server transaction is
// byte-identical whether or not the modal was shown.

// completed included (push-review finding): the server still reprices and
// bills deltas on completed events (Additional Services invoice), so they
// get the same confirmation gate.
export const BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

const usd = (n) => '$' + Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

// Returns null when no confirmation is needed (unbooked, or total unmoved).
// Returns { unknown: true, lines } when booked but the live preview failed.
// Otherwise { oldTotal, newTotal, delta, paid, newBalance, lines }.
export function buildRepriceSummary({ status, totalPrice, amountPaid, newTotal }) {
  if (!BOOKED_STATUSES.includes(status)) return null;

  if (newTotal == null) {
    return {
      unknown: true,
      lines: ['Live pricing is not current. Saving will reprice on the server and the total may change.'],
    };
  }

  const oldTotal = Number(totalPrice) || 0;
  const next = Number(newTotal);
  const delta = next - oldTotal;
  if (Math.abs(delta) < 0.005) return null;

  const paid = Number(amountPaid) || 0;
  // Already overpaid BEFORE this edit: recorded payments exceeded the old
  // total. Same paid-vs-total derivation the payment panel's Overpaid chip
  // uses. It changes what an increase actually does, so it gets its own copy.
  const wasOverpaid = paid - oldTotal > 0.005;
  const lines = [];
  if (delta > 0) {
    // Demotion is NOT unconditional. proposalStatus.reconcileProposalPaymentStatus
    // leaves the status alone whenever paid >= the new total, so an increase an
    // existing overpayment still covers keeps the event balance_paid and keeps
    // autopay armed. Promising a demotion there would name a consequence the
    // server does not perform.
    if (status === 'balance_paid' && next - paid > 0.005) {
      lines.push('This event will drop back to deposit paid and autopay will be unenrolled.');
    }
    if (wasOverpaid) {
      // The invoice side runs either way (invoiceLifecycle: refreshUnlockedInvoices
      // raises an open Balance/Full Payment invoice to the new total, and
      // createAdditionalInvoiceIfNeeded mints the raw delta when every
      // balance-bearing invoice is locked). What the old copy got wrong is the
      // money consequence: against an existing overpayment the increase is
      // absorbed first, so "billed to the client" overstates it.
      const newlyDue = next - paid;
      if (newlyDue > 0.005) {
        // The proposal-level figure and the INVOICE figure diverge here, and
        // saying only the first one misleads: on a fully-paid proposal every
        // balance-bearing invoice is locked, so createAdditionalInvoiceIfNeeded
        // mints the RAW delta (invoiceLifecycle.js:339 computes
        // newTotalCents - oldTotalCents with no netting against amount_paid).
        // The client can therefore receive a demand larger than the balance
        // this modal reports. Disclose both numbers.
        lines.push(`The ${usd(delta)} increase outruns the ${usd(paid - oldTotal)} the client had overpaid, so ${usd(newlyDue)} becomes the new balance due. Note the invoice written for the increase is the full ${usd(delta)}: it is not reduced by the overpayment, so the client may see a larger figure than the balance.`);
      } else {
        const stillOver = paid - next;
        lines.push(
          `An invoice for the ${usd(delta)} increase is still written, but recorded payments of ${usd(paid)} already cover the new total: `
          + (stillOver > 0.005
            ? `the proposal stays overpaid by ${usd(stillOver)} instead of showing a balance due.`
            : 'the proposal lands exactly paid in full, with nothing new due.')
        );
      }
    } else {
      // Truthful to both server mechanisms (invoiceLifecycle): an unlocked
      // Balance/Full Payment invoice absorbs the increase on rebuild; the
      // Additional Services invoice is only minted when invoices are locked.
      lines.push(`The ${usd(delta)} increase will be billed to the client (added to the open balance invoice, or as a new Additional Services invoice).`);
    }
  } else if (next < paid) {
    lines.push(`Client is now overpaid by ${usd(paid - next)}. A refund is likely owed.`);
  }
  lines.push('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');

  return {
    unknown: false,
    oldTotal,
    newTotal: next,
    delta,
    paid,
    newBalance: next - paid,
    lines,
  };
}
