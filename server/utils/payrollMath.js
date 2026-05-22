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

module.exports = { contractedHours, wageCents, SETUP_HOURS, BREAKDOWN_HOURS };
