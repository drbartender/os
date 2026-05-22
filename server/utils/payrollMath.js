/**
 * Pure payout math for the staff payment system. No DB, no side effects.
 * All money is integer cents. Mirrors the pricingEngine.js style.
 */

const SETUP_HOURS = 1;
const BREAKDOWN_HOURS = 0.5;

/** Contracted time = event duration + 1h setup + 30m breakdown. */
function contractedHours(eventDurationHours) {
  return Number(eventDurationHours) + SETUP_HOURS + BREAKDOWN_HOURS;
}

/** Wage in cents = hours * per-hour rate, rounded to whole cents. */
function wageCents(hours, rateCents) {
  return Math.round(Number(hours) * Number(rateCents));
}

/**
 * Split `totalCents` into `n` integer shares. The first `remainder` shares
 * each get one extra cent, so the shares sum to exactly `totalCents` and the
 * result is deterministic. The caller assigns shares to recipients ordered
 * by users.id, per the spec's remainder rule.
 */
function splitEvenly(totalCents, n) {
  if (n <= 0) return [];
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const shares = [];
  for (let i = 0; i < n; i += 1) {
    shares.push(base + (i < remainder ? 1 : 0));
  }
  return shares;
}

/**
 * Total gratuity in cents from a proposal pricing snapshot. `breakdown` is an
 * array of { label, amount } with amount in dollars; there can be zero, one,
 * or several 'Shared Gratuity' lines, so sum them all.
 */
function extractGratuityCents(pricingSnapshot) {
  const breakdown = (pricingSnapshot && pricingSnapshot.breakdown) || [];
  let dollars = 0;
  for (const line of breakdown) {
    if (line && line.label === 'Shared Gratuity') {
      dollars += Number(line.amount) || 0;
    }
  }
  return Math.round(dollars * 100);
}

/**
 * The card-fee share attributable to a `grossCents` slice of a card payment
 * of `paymentTotalCents` that incurred `paymentFeeCents` in fees. Returns 0
 * when nothing was charged on a card.
 */
function proRataFeeCents(grossCents, paymentTotalCents, paymentFeeCents) {
  if (!paymentTotalCents || paymentTotalCents <= 0) return 0;
  // Clamp the ratio at 1: a slice can never carry more than the whole fee.
  // The gratuity slice should always be <= the payment total, but data drift
  // between pricing_snapshot and total_price must never over-net the fee.
  const ratio = Math.min(1, grossCents / paymentTotalCents);
  return Math.round(Number(paymentFeeCents) * ratio);
}

module.exports = {
  contractedHours, wageCents, splitEvenly,
  extractGratuityCents, proRataFeeCents,
  SETUP_HOURS, BREAKDOWN_HOURS,
};
