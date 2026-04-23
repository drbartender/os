/**
 * Pure helpers for hosted-package-aware menu-planner behavior.
 * Mirrors server/utils/pricingEngine.js (computeCocktailGap etc.).
 * No network, no DB — operates on plan data already in React state.
 */

export function computeCocktailGap(cocktail, plan) {
  const required = cocktail?.upgrade_addon_slugs || [];
  const covered = plan?.package_covered_addon_slugs || [];
  return required.filter((slug) => !covered.includes(slug));
}

export function packageSuppressedAddons(plan) {
  return plan?.package_covered_addon_slugs || [];
}

export function isCocktailFullyCovered(cocktail, plan) {
  return computeCocktailGap(cocktail, plan).length === 0;
}

/**
 * Sum per-guest rates for a list of gap slugs against addonPricing.
 * Returns { perGuest, total } — total is null when guestCount is unknown.
 * Unknown slugs are silently skipped.
 */
export function computeGapCost(gapSlugs, addonPricing, guestCount) {
  if (!gapSlugs || gapSlugs.length === 0) {
    return { perGuest: 0, total: guestCount == null ? null : 0 };
  }
  let perGuest = 0;
  for (const slug of gapSlugs) {
    const addon = (addonPricing || []).find((a) => a.slug === slug);
    if (!addon) continue;
    if (addon.billing_type === 'per_guest') {
      perGuest += Number(addon.rate) || 0;
    }
  }
  const total = guestCount == null ? null : perGuest * Number(guestCount);
  return { perGuest, total };
}
