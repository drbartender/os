/**
 * Pure cancellation-refund math (P6, fix #7). No DB, no Stripe — fully unit
 * tested in cancellationMath.test.js.
 *
 * MONEY SEAM: every input and output is INTEGER CENTS. The cancel route
 * assembles the three cents values from invoice/payment rows
 * (amountPaidCents = sum of succeeded proposal_payments; retainerCents = the
 * Deposit invoice's amount_paid; gratuityPaidCents = extractGratuityCents(snapshot)
 * gated on the payroll funded determination) and calls this function.
 * proposals.total_price / amount_paid (DOLLARS) must NEVER enter here — mixing
 * units is a 100x error.
 *
 * Agreement outcomes (design 2026-07-13, §6):
 *   - Client cancel, >14 days: retainer forfeited; refund =
 *       max(0, amountPaid - retainer - gratuityPaid) * 0.95  +  gratuityPaid.
 *     The 5% processing fee applies ONLY to the non-gratuity excess; gratuity
 *     (the portion actually paid) always refunds in full. Every component
 *     clamps >= 0 (a deposit-only payer gets $0, never a negative).
 *   - Client cancel, <=14 days: no refund EXCEPT gratuity, which refunds in
 *     full (staff did not work; the "every dollar to staff" line stays true).
 *   - DRB cancels: full refund of everything paid, including the retainer.
 *
 * @param {object} a
 * @param {'client'|'drb'} a.mode
 * @param {number} a.daysOut          whole days, notice date -> event date
 * @param {number} a.amountPaidCents  sum of succeeded proposal_payments (cents)
 * @param {number} a.retainerCents    Deposit invoice amount_paid (cents)
 * @param {number} a.gratuityPaidCents gratuity actually paid (cents; 0 if unfunded)
 * @returns {{refundCents:number, gratuityCents:number, excessCents:number, feeCents:number}}
 */
function computeCancellationRefund({ mode, daysOut, amountPaidCents, retainerCents, gratuityPaidCents }) {
  const paid = Math.max(0, Number(amountPaidCents) || 0);
  const retainer = Math.max(0, Number(retainerCents) || 0);
  // Gratuity actually recoverable can never exceed what was paid overall.
  const gr = Math.max(0, Math.min(Number(gratuityPaidCents) || 0, paid));

  if (mode === 'drb') {
    // Full refund of everything paid; gratuity is a labeled sub-portion of it.
    return {
      refundCents: paid,
      gratuityCents: gr,
      excessCents: Math.max(0, paid - gr),
      feeCents: 0,
    };
  }

  if (daysOut > 14) {
    const excessBeforeFee = Math.max(0, paid - retainer - gr);
    const fee = Math.round(excessBeforeFee * 0.05);
    const excess = excessBeforeFee - fee;
    return {
      refundCents: excess + gr,
      gratuityCents: gr,
      excessCents: excess,
      feeCents: fee,
    };
  }

  // Client cancel, <=14 days: gratuity only.
  return {
    refundCents: gr,
    gratuityCents: gr,
    excessCents: 0,
    feeCents: 0,
  };
}

module.exports = { computeCancellationRefund };
