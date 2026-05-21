// Shared proposal business rules — bundle logic, addon filtering, guardrails.
// Pure functions: no React, no state. Consumed by the public Quote Wizard and
// the admin cockpit (ProposalCreate.js). A CJS twin at server/utils/proposalRules.js
// re-validates these rules authoritatively; keep the two in sync manually
// (same discipline as eventTypes.js).
import {
  BYOB_BUNDLE_SLUGS,
  MIXER_SLUGS,
  BUNDLE_INCLUDED,
  BUNDLE_UNAVAILABLE,
  BUNDLE_COVERED,
} from '../pages/website/quoteWizard/bundleConfig';

export { BYOB_BUNDLE_SLUGS, MIXER_SLUGS, BUNDLE_INCLUDED, BUNDLE_UNAVAILABLE, BUNDLE_COVERED };

export function getSelectedBundleSlug(addonIds, addons) {
  for (const id of addonIds) {
    const a = addons.find(x => x.id === id);
    if (a && BYOB_BUNDLE_SLUGS.includes(a.slug)) return a.slug;
  }
  return null;
}

export function stripIncludedAddons(addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  if (!bundle) return addonIds;
  const covered = new Set(BUNDLE_COVERED[bundle]);
  return addonIds.filter(id => {
    const a = addons.find(x => x.id === id);
    return !a || !covered.has(a.slug) || BYOB_BUNDLE_SLUGS.includes(a.slug);
  });
}

export function isIncludedByBundle(slug, addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  return !!bundle
    && (BUNDLE_INCLUDED[bundle] || []).includes(slug)
    && !BYOB_BUNDLE_SLUGS.includes(slug);
}

export function isUnavailableByBundle(slug, addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  return !!bundle && (BUNDLE_UNAVAILABLE[bundle] || []).includes(slug);
}

// Returns the next-state slice { addon_ids, syrup_selections } after toggling
// `id`. Enforces BYOB bundle mutex, mixer mutex, dependent-addon cleanup, and
// clears syrup_selections when handcrafted-syrups is removed. No-ops if `id` is
// a bundle-locked addon.
export function toggleAddonWithRules({ addonIds, syrupSelections = [] }, id, addons) {
  const clicked = addons.find(a => a.id === id);
  const bundle = getSelectedBundleSlug(addonIds, addons);
  if (clicked && bundle && !BYOB_BUNDLE_SLUGS.includes(clicked.slug)
      && (BUNDLE_COVERED[bundle] || []).includes(clicked.slug)) {
    return { addon_ids: addonIds, syrup_selections: syrupSelections };
  }
  const isRemoving = addonIds.includes(id);
  let newIds;
  let newSyrups = syrupSelections;
  if (isRemoving) {
    const removed = addons.find(a => a.id === id);
    const dependentIds = addons
      .filter(a => a.requires_addon_slug === removed?.slug)
      .map(a => a.id);
    newIds = addonIds.filter(a => a !== id && !dependentIds.includes(a));
    if (removed?.slug === 'handcrafted-syrups') newSyrups = [];
  } else {
    const added = addons.find(a => a.id === id);
    newIds = [...addonIds, id];
    if (added && BYOB_BUNDLE_SLUGS.includes(added.slug)) {
      const others = addons
        .filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug) && a.id !== id)
        .map(a => a.id);
      newIds = newIds.filter(a => !others.includes(a));
    }
    if (added && MIXER_SLUGS.includes(added.slug)) {
      const others = addons
        .filter(a => MIXER_SLUGS.includes(a.slug) && a.id !== id)
        .map(a => a.id);
      newIds = newIds.filter(a => !others.includes(a));
    }
  }
  return { addon_ids: newIds, syrup_selections: newSyrups };
}

// Returns { visibleAddons, isIncludedMap, isUnavailableMap }.
// `packageCategory` is the pkg.category string ('byob' | 'hosted' | 'mocktail')
// used for applies_to matching. Class packages carry category='hosted' — class
// detection is NOT done here (see ProposalCreate PackageSection / QuoteWizard).
// Takes only the args the filter rules actually consume — the Flavor Blaster
// glassware gate lives in reconcileFlavorBlaster, not here.
export function filterAddons({
  addons,
  isHosted,
  packageCategory,
  addonIds,
  guestCount,
}) {
  const hasSlug = (slug) => addonIds.some(id => {
    const a = addons.find(x => x.id === id);
    return a && a.slug === slug;
  });
  const gc = Number(guestCount) || 0;

  const visibleAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && a.applies_to !== packageCategory) return false;
    if (a.slug === 'garnish-package-only' && isHosted) return false;
    if (a.slug === 'mocktail-bar' && packageCategory === 'byob'
        && !hasSlug('the-formula') && !hasSlug('the-full-compound')) return false;
    if ((a.slug === 'real-glassware' || a.slug === 'champagne-coupe-upgrade') && gc > 100) return false;
    if (a.requires_addon_slug) {
      const parent = addons.find(x => x.slug === a.requires_addon_slug);
      if (!parent || !addonIds.includes(parent.id)) return false;
    }
    if (a.slug === 'handcrafted-syrups-3pack') return false;
    if (a.slug === 'parking-fee') return false;
    return true;
  });

  const isIncludedMap = {};
  const isUnavailableMap = {};
  for (const a of addons) {
    isIncludedMap[a.slug] = isIncludedByBundle(a.slug, addonIds, addons);
    isUnavailableMap[a.slug] = isUnavailableByBundle(a.slug, addonIds, addons);
  }
  return { visibleAddons, isIncludedMap, isUnavailableMap };
}

// Hosted packages have a 25-guest floor. `isHosted` = pkg.pricing_type === 'per_guest'.
export function enforceHostedMinimum(guestCount, isHosted) {
  const g = Number(guestCount) || 0;
  return isHosted && g < 25 ? 25 : guestCount;
}

// Drops Flavor Blaster from the selection if its glassware requirement
// (real-glassware addon OR client_provides_glassware) is not met.
export function reconcileFlavorBlaster(addonIds, addons, clientProvidesGlassware) {
  const fb = addons.find(a => a.slug === 'flavor-blaster-rental');
  if (!fb || !addonIds.includes(fb.id)) return addonIds;
  const realGlass = addons.find(a => a.slug === 'real-glassware');
  const hasGlass = (realGlass && addonIds.includes(realGlass.id)) || !!clientProvidesGlassware;
  return hasGlass ? addonIds : addonIds.filter(x => x !== fb.id);
}

// Add-ons billed by a 1-10 count (a quantity stepper). This is the CANONICAL
// source — the wizard's ExtrasStep.js currently hardcodes this same slug list
// inline; Task 3 repoints ExtrasStep at this predicate so the two never drift.
// Handcrafted syrups are NOT here — their bottle count is driven by the syrup
// picker (syrup_selections), a separate control in both flows.
const QUANTITY_CAPABLE_SLUGS = [
  'banquet-server', 'barback', 'pre-batched-mocktail', 'additional-bartender',
];
export function isQuantityCapable(addon) {
  return !!addon && QUANTITY_CAPABLE_SLUGS.includes(addon.slug);
}
