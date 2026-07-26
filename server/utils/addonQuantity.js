'use strict';

/**
 * proposal_addons.quantity holds the pricing engine's OUTPUT display quantity
 * (`calculateAddonCost(...).quantity`), NOT the admin-facing input count. That
 * is the column's established meaning and two consumers already depend on it:
 * eventCreation.addonHeadcount divides it by duration to recover headcount, and
 * invoiceLineItems renders it as `quantity x rate` on the invoice.
 *
 * The two differ for every billing type except `flat`. For `per_hour` the
 * output is `effectiveHours * count`, so feeding the stored value back to the
 * engine as an input multiplies by hours a SECOND time: a $450 banquet-server
 * line repriced to $2,700 on a no-op fold (push review, 2026-07-26).
 *
 * These are the only sanctioned SERVER conversions. Anything that needs a unit
 * count out of the column, or needs to write the column from a count, goes
 * through here so the two definitions cannot drift apart again.
 *
 * SERVER TWIN of client/src/pages/admin/proposalEditor/formState.js:70-116
 * (`recoverAddonQuantities`), which has inverted this column correctly since the
 * editor was built. Two deliberate divergences:
 *   - per_guest: the client always holds the row's line_total and rate, so it
 *     always recovers the count. Here those two arrive in an OPTIONAL fourth
 *     argument, because some callers select neither; without them this returns
 *     null and the engine recomputes at count 1, the pre-existing behavior.
 *   - no upper clamp: the client clamps to the stepper's max of 10; clamping
 *     here would silently re-bill a corrupt row at 10 units instead of leaving
 *     it visible.
 */

// Billing types whose stored OUTPUT is NOT the input count: they store guests,
// staff, or 100-guest blocks instead. Stated as an exclusion list on purpose.
// billing_type is a bare VARCHAR(20) with no CHECK, and the engine's `default:`
// branch prices `rate x qty` exactly like `flat`, so an unrecognized or NULL
// type stores the count and must keep being read as one.
const STORED_IS_NOT_A_COUNT = new Set(['per_guest', 'per_guest_timed', 'per_staff', 'per_100_guests']);

/** Does the column hold the engine's INPUT count verbatim for this type? */
function storedIsInputCount(billingType) {
  return billingType !== 'per_hour' && !STORED_IS_NOT_A_COUNT.has(billingType);
}

/**
 * The hours the engine actually billed for this add-on.
 * `additional-bartender` is bespoke: calculateProposal gives it its own branch
 * (pricingEngine.js:387-405) that multiplies by RAW durationHours and never
 * consults minimum_hours. Every other per_hour add-on goes through
 * calculateAddonCost's max(durationHours, minimum_hours). eventCreation.js:52-54
 * and formState.js:80-91 both encode the same split; keep all three in step.
 */
function effectiveHoursFor(addon, durationHours) {
  const hours = Number(durationHours) || 0;
  if (addon?.slug === 'additional-bartender') return hours;
  return Math.max(hours, Number(addon?.minimum_hours || 0));
}

/**
 * Recover the engine INPUT count from the stored OUTPUT quantity.
 *
 * Rounds to the nearest whole unit with a floor of 1, matching the client
 * inverter. Counts are integers everywhere (the stepper is 1-10, and half a
 * banquet server does not exist), and the rounding is load-bearing: a legacy
 * lab-written raw `1` on a 4-hour event would otherwise recover as 0.25 and
 * turn this fix into a 4x under-bill on the very paths it is meant to protect.
 *
 * @param {object} [options] the row's OWN persisted `lineTotal` and `rate`,
 *   which per_guest needs and no other type reads. Omitting them keeps every
 *   pre-existing caller's behavior exactly as it was.
 * @returns {number|null} the count, or null when the stored figure cannot
 *   express one (per_guest_timed stores guestCount and carries an extra-hours
 *   term; per_staff stores the staff count and the engine ignores its input;
 *   per_100_guests stores blocks; per_guest without the options above). null
 *   means "let the engine recompute", which is today's behavior for those types
 *   and is deliberately unchanged here.
 */
function storedToInputCount(addon, storedQuantity, durationHours, { lineTotal, rate } = {}) {
  const stored = Number(storedQuantity);
  if (!Number.isFinite(stored) || stored <= 0) return null;
  const type = addon?.billing_type;
  let raw;
  // Dispatch on the SLUG first, the way the engine (pricingEngine.js:387) and
  // the client inverter (formState.js:80) both do. additional-bartender's
  // engine branch is keyed on slug ALONE and stores durationHours x qty
  // whatever billing_type says, and REPRICE_ADDON_SQL selects sa.* from the
  // LIVE catalog row. So if that row is ever edited off per_hour, a
  // billing_type-first test here would fall through to storedIsInputCount and
  // hand the stored hours-times-count product back as a COUNT, re-billing by
  // hours a second time. Identical for every row today; this only keeps the
  // three sites from disagreeing after a catalog edit.
  if (addon?.slug === 'additional-bartender' || type === 'per_hour') {
    const hours = effectiveHoursFor(addon, durationHours);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    raw = stored / hours;
  } else if (type === 'per_guest') {
    // The count is NOT in this column: per_guest stores guestCount. It survives
    // only in line_total (= guestCount x rate x count), so it is recoverable
    // ONLY when the caller passes the row's OWN persisted line_total and rate.
    // Never the catalog rate: rates drift (pre-batched-mocktail went $1.50 to
    // $2.00 in prod) and dividing by the current one recovers a wrong count.
    // Callers that cannot supply them (the cancel-line picker, which selects
    // neither) get null and fall back to whole-line removal, unchanged.
    //
    // per_guest_timed is deliberately NOT here. Its line_total carries an
    // extra-hours term on top of the per-guest base, so this division does not
    // hold: prod proposal 464 reads 1.250 for a genuine count of 1.
    const total = Number(lineTotal);
    const unitRate = Number(rate);
    if (!Number.isFinite(total) || total <= 0) return null;
    if (!Number.isFinite(unitRate) || unitRate <= 0) return null;
    raw = total / (stored * unitRate);
  } else if (storedIsInputCount(type)) {
    raw = stored;
  } else {
    return null;
  }
  if (!Number.isFinite(raw)) return null;
  return Math.max(1, Math.round(raw));
}

/**
 * What one STORED unit means, for rendering the persisted quantity beside the
 * rate. NOT the unit of the recovered count itself: a per_hour add-on stores
 * HOURS but is counted in staff, so this returns 'hour' for the same row whose
 * storedToInputCount returns a number of servers. Label a quantity stepper off
 * storedToInputCount, never off this.
 */
function countLabelFor(addon) {
  const type = addon?.billing_type;
  if (type === 'per_hour') return 'hour';
  if (storedIsInputCount(type)) return 'unit';
  return null;
}

module.exports = {
  STORED_IS_NOT_A_COUNT,
  storedIsInputCount,
  effectiveHoursFor,
  storedToInputCount,
  countLabelFor,
};
