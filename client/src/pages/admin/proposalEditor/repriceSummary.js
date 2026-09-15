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
// offContractPaidCents (proposals payload) is money inside amount_paid that is
// NOT inside total_price: a paid Drink Plan Extras or manual invoice. It has to
// come out before any claim that the client is overpaid, or a proposal that
// simply bought syrups reads as owed a refund (prod 599). Same netting the
// payment panel chip and the refund route use (spec 2026-09-15).
export function buildRepriceSummary({ status, totalPrice, amountPaid, newTotal, offContractPaidCents = 0 }) {
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
  // Contract money only: what is left of amount_paid once off-contract invoice
  // money is netted out. Every overpaid claim below is derived from THIS.
  const contractPaid = paid - (Number(offContractPaidCents) || 0) / 100;
  // Already overpaid BEFORE this edit: contract payments exceeded the old
  // total. Same netted derivation the payment panel's Overpaid chip uses. It
  // changes what an increase actually does, so it gets its own copy.
  const wasOverpaid = contractPaid - oldTotal > 0.005;
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
      // RAW paid here on purpose: this predicts the BALANCE DUE, which the
      // server derives from raw amount_paid whatever the money was for. Only
      // the "overpaid" claims below are netted.
      const newlyDue = next - paid;
      if (newlyDue > 0.005) {
        // The proposal-level figure and the INVOICE figure can diverge here, so
        // naming only the balance misleads: with balance-bearing invoices locked,
        // createAdditionalInvoiceIfNeeded mints the RAW delta
        // (invoiceLifecycle.js:339, newTotalCents - oldTotalCents, no netting
        // against amount_paid), and the client sees a demand larger than the
        // balance this modal reports.
        //
        // "recorded payments" is deliberate and load-bearing: this function gets
        // only {status, totalPrice, amountPaid, newTotal}, so it cannot see
        // external_paid or invoice-lock state and cannot tell the flavors apart.
        // Saying "not reduced by the overpayment" would be FALSE on a
        // CheckCherry-transferred proposal whose Balance invoice is still
        // unlocked, because refreshUnlockedInvoices:150 DOES net external_paid
        // and the invoice comes out equal to the balance. `amount_paid` enters
        // neither server function, so the narrower claim is true in every
        // flavor, and the "may" carries the rest.
        lines.push(`The ${usd(delta)} increase outruns the ${usd(contractPaid - oldTotal)} the client had overpaid, so ${usd(newlyDue)} becomes the new balance due. Note the invoice written for the increase is the full ${usd(delta)}: it is not reduced by recorded payments, so the client may see a larger figure than the balance.`);
      } else {
        const stillOver = contractPaid - next;
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
  } else if (next < contractPaid) {
    lines.push(`Client is now overpaid by ${usd(contractPaid - next)}. A refund is likely owed.`);
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
