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

module.exports = { contractedHours, wageCents, splitEvenly, SETUP_HOURS, BREAKDOWN_HOURS };
