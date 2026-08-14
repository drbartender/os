/**
 * The ONE qualified label for a `per_guest_timed` add-on rate.
 *
 * WHY THIS FILE EXISTS. A `per_guest_timed` add-on's `rate` column is NOT the
 * whole per-guest price: it is the FOUR-HOUR price. Every hour past four adds
 * `extra_hour_rate` per guest on top of it (server/utils/pricingEngine.js,
 * calculateAddonCost, case 'per_guest_timed'). So a surface that prints the
 * bare rate is quoting a number the client will be billed MORE than, and a
 * client who read "$8/guest" on a five-hour event has every right to hold us
 * to it. As of 2026-08-14 the four rows with this billing type are
 * the-foundation, the-formula, the-full-compound and mocktail-bar, but NOTHING
 * here keys on a slug: the trap is the billing type, and the fifth row will
 * inherit the fix for free.
 *
 * The copy is the admin proposal-editor's long-standing form, which is the
 * phrasing already accepted:
 *
 *     $8/guest (4hr) + $2/guest/hr after
 *
 * FLOOR RULE: a surface too cramped for the full form drops to `compact`,
 * which still carries the `(4hr)` qualifier. A bare rate is never acceptable.
 *
 * If you are about to hand-roll a `(4hr)` string somewhere: don't. Call this.
 */

export const TIMED_PER_GUEST = 'per_guest_timed';

/** True when this add-on's listed rate is a four-hour rate. */
export function isTimedPerGuestAddon(addon) {
  return !!addon && addon.billing_type === TIMED_PER_GUEST;
}

// Dollars with cents only when the value actually has them, so the catalog's
// $8.00 reads "$8" (matching the accepted admin copy) while $0.75 and $5.50
// keep the cents that a whole-dollar formatter would silently round away.
const defaultMoney = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0';
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: v % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

/**
 * Build the qualified rate string for a `per_guest_timed` add-on.
 *
 * @param {object} addon             row carrying `rate` and `extra_hour_rate`
 * @param {object} [options]
 * @param {function} [options.money] money formatter, e.g. `fmt` / `fmt$2dp`.
 *                                   Defaults to cents-when-present dollars.
 * @param {string} [options.unit]    noun after the rate. '/guest' by default;
 *                                   '/g' where the column is too narrow.
 * @param {boolean} [options.compact] emit only the floor form, "<rate> (4hr)".
 * @returns {string} e.g. "$8/guest (4hr) + $2/guest/hr after"
 */
export function timedPerGuestRateLabel(addon, options = {}) {
  if (!addon) return '';
  const { money = defaultMoney, unit = '/guest', compact = false } = options;

  const base = `${money(addon.rate)}${unit} (4hr)`;
  if (compact) return base;

  // No extra-hour rate on the row means extra hours cost nothing, so the
  // four-hour qualifier alone is the whole truth. This branch also swallows a
  // NULL column, which a hand-rolled template rendered as "$NaN/guest/hr".
  const extra = Number(addon.extra_hour_rate);
  if (!Number.isFinite(extra) || extra <= 0) return base;

  return `${base} + ${money(extra)}${unit}/hr after`;
}
