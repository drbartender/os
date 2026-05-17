/**
 * Refund helpers — partial refunds (Approach A: refund corrects the total).
 *
 * planRefund() is PURE (no DB, no Stripe) → fully unit-tested.
 * applyRefundReconciliation() is DB-bound (added in Task 3).
 *
 * MONEY SEAM: proposals.total_price / amount_paid are DOLLARS (NUMERIC);
 * everything else is INTEGER CENTS. planRefund takes dollars in, returns
 * cents for all downstream Stripe/ledger use, and a dollars figure only
 * for the proposals columns.
 */

function fmtUSD(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/**
 * Decide which single charge to refund against and validate the amount.
 * No DB. No spanning multiple charges.
 *
 * @param {object} args
 * @param {{id:number, stripe_payment_intent_id:string, remainingCents:number}[]} args.paymentsWithRemaining
 *        Succeeded, intent-bearing proposal_payments rows with cents still
 *        refundable (caller computes remainingCents = amount − Σ succeeded refunds).
 * @param {number|string} args.requestedDollars  raw admin input
 * @param {number} args.amountPaidDollars         proposals.amount_paid
 * @param {number} args.totalPriceDollars         proposals.total_price
 * @returns {{ok:true, amountCents:number, targetPaymentId:number,
 *            targetIntentId:string, totalPriceAfterDollars:number}
 *          | {ok:false, code:string, message:string, maxRefundableCents?:number}}
 */
function planRefund({ paymentsWithRemaining, requestedDollars, amountPaidDollars, totalPriceDollars }) {
  const n = Number(requestedDollars);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Enter a refund amount greater than $0.00.' };
  }
  const amountCents = Math.round(n * 100);

  const candidates = (paymentsWithRemaining || []).filter(p => p.remainingCents > 0);
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_REFUNDABLE_PAYMENT', message: 'No Stripe payment on this proposal is available to refund.' };
  }

  const target = candidates.reduce((a, b) => (b.remainingCents > a.remainingCents ? b : a));

  if (amountCents > target.remainingCents) {
    return {
      ok: false,
      code: 'EXCEEDS_SINGLE_CHARGE',
      maxRefundableCents: target.remainingCents,
      message: `Largest refundable payment is ${fmtUSD(target.remainingCents)}. Issue this as separate refunds of ${fmtUSD(target.remainingCents)} or less.`,
    };
  }

  const amountPaidCents = Math.round(Number(amountPaidDollars) * 100);
  if (amountCents > amountPaidCents) {
    return { ok: false, code: 'EXCEEDS_AMOUNT_PAID', message: 'Refund exceeds the amount currently paid on this proposal.' };
  }

  // Conservative full-Approach-A bound: assumes the whole refund is contract
  // money (worst case for total_price). The AUTHORITATIVE total_price_after
  // is computed in applyRefundReconciliation from the linked invoice labels
  // — an extra-scope refund reduces total_price LESS (or not at all), so
  // this guard never wrongly rejects a valid refund. totalPriceAfterDollars
  // below is therefore a preview the reconciliation finalizes.
  const totalAfterCents = Math.round(Number(totalPriceDollars) * 100) - amountCents;
  if (totalAfterCents < 0) {
    return { ok: false, code: 'EXCEEDS_TOTAL', message: 'Refund would drop the proposal total below $0.00.' };
  }

  return {
    ok: true,
    amountCents,
    targetPaymentId: target.id,
    targetIntentId: target.stripe_payment_intent_id,
    totalPriceAfterDollars: totalAfterCents / 100,
  };
}

module.exports = { planRefund, fmtUSD };
