// Server twin of client/src/utils/proposalRules.js. CJS. The constants below
// MUST stay in sync with client/src/pages/website/quoteWizard/bundleConfig.js
// (same manual-twin discipline as eventTypes.js). This twin now mirrors the
// FULL bundle config — BYOB_BUNDLE_SLUGS, MIXER_SLUGS, BUNDLE_INCLUDED,
// BUNDLE_UNAVAILABLE (and the derived BUNDLE_COVERED) — not just the two slug
// arrays, so the server can strip bundle-covered add-ons before pricing.
// validateProposalRules is the AUTHORITATIVE gate — a stale tab or scripted
// POST bypasses the client, so every rule the wizard UI enforces is re-checked
// here.
const { ValidationError } = require('./errors');

const BYOB_BUNDLE_SLUGS = ['the-foundation', 'the-formula', 'the-full-compound'];
const MIXER_SLUGS = ['signature-mixers-only', 'full-mixers-only'];

// Mirror of bundleConfig.js — keep in sync with that file.
const BUNDLE_INCLUDED = {
  'the-foundation': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only'],
  'the-formula': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'signature-mixers-only'],
  'the-full-compound': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'full-mixers-only', 'garnish-package-only'],
};
const BUNDLE_UNAVAILABLE = {
  'the-formula': ['full-mixers-only'],
  'the-full-compound': ['signature-mixers-only'],
};
const BUNDLE_COVERED = Object.fromEntries(
  BYOB_BUNDLE_SLUGS.map(b => [b, [...(BUNDLE_INCLUDED[b] || []), ...(BUNDLE_UNAVAILABLE[b] || [])]])
);

// Pure — mirrors client/src/utils/proposalRules.js. Returns the active BYOB
// bundle slug in the selection (or null).
function getSelectedBundleSlug(addonIds, addons) {
  for (const id of addonIds) {
    const a = addons.find(x => x.id === id);
    if (a && BYOB_BUNDLE_SLUGS.includes(a.slug)) return a.slug;
  }
  return null;
}

// Pure — mirrors the client. Drops addon ids that the active bundle covers,
// keeping the bundle id itself. Used server-side before pricing so a scripted
// POST can't double-pay for bundle-included add-ons.
function stripIncludedAddons(addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  if (!bundle) return addonIds;
  const covered = new Set(BUNDLE_COVERED[bundle]);
  return addonIds.filter(id => {
    const a = addons.find(x => x.id === id);
    return !a || !covered.has(a.slug) || BYOB_BUNDLE_SLUGS.includes(a.slug);
  });
}

// Throws ValidationError on any violation. Args:
//   pkg                     — service_packages row (uses pricing_type, bar_type)
//   guestCount              — number
//   addonIds                — number[]
//   addons                  — service_addons rows for the selected ids (+ any
//                             needed for requires_addon_slug parent lookup)
//   clientProvidesGlassware — boolean
function validateProposalRules({ pkg, guestCount, addonIds, addons, clientProvidesGlassware }) {
  const errors = {};
  const ids = addonIds || [];
  const rows = addons || [];
  const selected = rows.filter(a => ids.includes(a.id));
  const hasSlug = (slug) => selected.some(a => a.slug === slug);
  const gc = Number(guestCount) || 0;
  const isHosted = pkg && pkg.pricing_type === 'per_guest';
  // Addon-rule messages accumulate here, then join into errors.addon_ids once
  // at the end — a request violating two addon rules reports both, not just
  // whichever rule ran last.
  const addonErrors = [];

  // Hosted 25-guest floor
  if (isHosted && gc < 25) {
    errors.guest_count = 'Hosted packages require at least 25 guests';
  }

  // Flavor Blaster needs real glassware OR client-provided glassware
  if (hasSlug('flavor-blaster-rental')
      && !hasSlug('real-glassware') && !clientProvidesGlassware) {
    addonErrors.push('Flavor Blaster requires real glassware or client-provided glassware');
  }

  // Real glassware / coupe upgrade cap at 100 guests
  if ((hasSlug('real-glassware') || hasSlug('champagne-coupe-upgrade')) && gc > 100) {
    addonErrors.push('Real glassware is only available for events of 100 guests or fewer');
  }

  // Mocktail bar on BYOB needs Formula or Full Compound
  if (hasSlug('mocktail-bar') && pkg && pkg.category === 'byob'
      && !hasSlug('the-formula') && !hasSlug('the-full-compound')) {
    addonErrors.push('Mocktail Bar requires The Formula or The Full Compound on BYOB packages');
  }

  // Garnish package not valid on hosted
  if (hasSlug('garnish-package-only') && isHosted) {
    addonErrors.push('Garnish Package is already included with hosted packages');
  }

  // Bundle mutex — at most one BYOB bundle
  const bundleCount = selected.filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug)).length;
  if (bundleCount > 1) {
    addonErrors.push('Only one BYOB bundle may be selected at a time');
  }

  // Mixer mutex — at most one mixer package
  const mixerCount = selected.filter(a => MIXER_SLUGS.includes(a.slug)).length;
  if (mixerCount > 1) {
    addonErrors.push('Only one mixer package may be selected at a time');
  }

  // requires_addon_slug — every dependent addon's parent must be selected
  for (const a of selected) {
    if (a.requires_addon_slug && !hasSlug(a.requires_addon_slug)) {
      addonErrors.push(`"${a.name || a.slug}" requires "${a.requires_addon_slug}" to also be selected`);
    }
  }

  if (addonErrors.length > 0) {
    errors.addon_ids = addonErrors.join(' ');
  }

  // Surface the rule text in the error message too (not just fieldErrors) so
  // callers logging err.message and assert.throws(fn, /regex/) both see why.
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors, Object.values(errors).join(' '));
  }
}

// Server twin of filterAddons() in client/src/utils/proposalRules.js — KEEP IN
// SYNC with it, same discipline as the bundle constants above.
//
// Why this exists: filterAddons decides which add-ons a client is allowed to
// see, and until now it lived ONLY in browser code. validateProposalRules
// enforces the interaction rules (mutexes, prerequisites, floors) but none of
// the VISIBILITY rules, so nothing server-side stopped a crafted request from
// putting a hosted-only add-on on a BYOB booking or billing a parking fee the
// UI deliberately hides. Any server path that prices or persists a
// client-chosen add-on set must gate on this first; the client copy is a
// convenience, never the boundary.
//
// Selection-dependent by design: a dependent add-on is invisible until its
// parent is chosen, which is how the client surfaces requires_addon_slug
// without an error state.
function visibleAddonsFor({ addons, pkg, guestCount, addonIds = [] }) {
  const rows = Array.isArray(addons) ? addons : [];
  const ids = Array.isArray(addonIds) ? addonIds : [];
  const packageCategory = pkg ? pkg.category : null;
  const isHosted = !!pkg && pkg.pricing_type === 'per_guest';
  const gc = Number(guestCount) || 0;
  const hasSlug = (slug) => ids.some((id) => {
    const a = rows.find((x) => x.id === id);
    return !!a && a.slug === slug;
  });

  return rows.filter((a) => {
    if (a.applies_to !== 'all' && a.applies_to !== packageCategory) return false;
    if (a.slug === 'garnish-package-only' && isHosted) return false;
    if (a.slug === 'mocktail-bar' && packageCategory === 'byob'
        && !hasSlug('the-formula') && !hasSlug('the-full-compound')) return false;
    if ((a.slug === 'real-glassware' || a.slug === 'champagne-coupe-upgrade') && gc > 100) return false;
    if (a.requires_addon_slug) {
      const parent = rows.find((x) => x.slug === a.requires_addon_slug);
      if (!parent || !ids.includes(parent.id)) return false;
    }
    if (a.slug === 'handcrafted-syrups-3pack') return false;
    if (a.slug === 'parking-fee') return false;
    return true;
  });
}

module.exports = {
  BYOB_BUNDLE_SLUGS,
  BUNDLE_INCLUDED,
  MIXER_SLUGS,
  getSelectedBundleSlug,
  stripIncludedAddons,
  validateProposalRules,
  visibleAddonsFor,
};
