// Server twin of client/src/utils/proposalRules.js. CJS. The constants below
// MUST stay in sync with client/src/pages/website/quoteWizard/bundleConfig.js
// (same manual-twin discipline as eventTypes.js). validateProposalRules is the
// AUTHORITATIVE gate — a stale tab or scripted POST bypasses the client, so
// every rule the wizard UI enforces is re-checked here.
const { ValidationError } = require('./errors');

const BYOB_BUNDLE_SLUGS = ['the-foundation', 'the-formula', 'the-full-compound'];
const MIXER_SLUGS = ['signature-mixers-only', 'full-mixers-only'];

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

  // Hosted 25-guest floor
  if (isHosted && gc < 25) {
    errors.guest_count = 'Hosted packages require at least 25 guests';
  }

  // Flavor Blaster needs real glassware OR client-provided glassware
  if (hasSlug('flavor-blaster-rental')
      && !hasSlug('real-glassware') && !clientProvidesGlassware) {
    errors.addon_ids = 'Flavor Blaster requires real glassware or client-provided glassware';
  }

  // Real glassware / coupe upgrade cap at 100 guests
  if ((hasSlug('real-glassware') || hasSlug('champagne-coupe-upgrade')) && gc > 100) {
    errors.addon_ids = 'Real glassware is only available for events of 100 guests or fewer';
  }

  // Mocktail bar on BYOB needs Formula or Full Compound
  if (hasSlug('mocktail-bar') && pkg && pkg.category === 'byob'
      && !hasSlug('the-formula') && !hasSlug('the-full-compound')) {
    errors.addon_ids = 'Mocktail Bar requires The Formula or The Full Compound on BYOB packages';
  }

  // Garnish package not valid on hosted
  if (hasSlug('garnish-package-only') && isHosted) {
    errors.addon_ids = 'Garnish Package is already included with hosted packages';
  }

  // Bundle mutex — at most one BYOB bundle
  const bundleCount = selected.filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug)).length;
  if (bundleCount > 1) {
    errors.addon_ids = 'Only one BYOB bundle may be selected at a time';
  }

  // Mixer mutex — at most one mixer package
  const mixerCount = selected.filter(a => MIXER_SLUGS.includes(a.slug)).length;
  if (mixerCount > 1) {
    errors.addon_ids = 'Only one mixer package may be selected at a time';
  }

  // requires_addon_slug — every dependent addon's parent must be selected
  for (const a of selected) {
    if (a.requires_addon_slug && !hasSlug(a.requires_addon_slug)) {
      errors.addon_ids = `"${a.name || a.slug}" requires "${a.requires_addon_slug}" to also be selected`;
    }
  }

  // Surface the rule text in the error message too (not just fieldErrors) so
  // callers logging err.message and assert.throws(fn, /regex/) both see why.
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors, Object.values(errors).join(' '));
  }
}

module.exports = { BYOB_BUNDLE_SLUGS, MIXER_SLUGS, validateProposalRules };
