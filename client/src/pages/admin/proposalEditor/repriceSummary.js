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
  const lines = [];
  if (delta > 0) {
    if (status === 'balance_paid') {
      lines.push('This event will drop back to deposit paid and autopay will be unenrolled.');
    }
    // Truthful to both server mechanisms (invoiceLifecycle): an unlocked
    // Balance/Full Payment invoice absorbs the increase on rebuild; the
    // Additional Services invoice is only minted when invoices are locked.
    lines.push(`The ${usd(delta)} increase will be billed to the client (added to the open balance invoice, or as a new Additional Services invoice).`);
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
