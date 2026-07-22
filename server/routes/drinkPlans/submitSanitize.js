'use strict';

// Selections sanitizer for the public drink-plan PUT (extracted verbatim from
// submit.js in the 2026-07-22 per-concern split; behavior-inert).

const { API_URL } = require('../../utils/urls');

// Token-gated selections PUT accepts arbitrary JSON. To stop attackers from
// (a) seeding internal-only keys like `_logoFilename` to pivot the logo proxy
// into reading any R2 object, or (b) writing a `javascript:` URL into
// `companyLogo` that the admin "Download original" link would then execute,
// every PUT goes through this sanitizer first.
const ALLOWED_SELECTIONS_KEYS = new Set([
  'signatureDrinks', 'signatureDrinkSpirits', 'customCocktails',
  'mixersForSignatureDrinks', 'mocktails', 'mocktailNotes',
  'spirits', 'spiritsOther', 'mixersForSpirits',
  'beerFromFullBar', 'wineFromFullBar', 'wineOtherFullBar', 'beerWineBalanceFullBar',
  'beerFromBeerWine', 'wineFromBeerWine', 'wineOtherBeerWine', 'beerWineBalanceBeerWine',
  'syrupSelections', 'syrupSelfProvided',
  'addOns', 'logistics',
  'customMenuDesign', 'menuStyle', 'menuTheme', 'drinkNaming', 'menuDesignNotes',
  'additionalNotes', 'companyLogo',
  'activeModules', 'exploration',
  // planner v2 (spec 2026-07-18 §3.1): crowd answers + day-of bar placement/power
  'crowd', 'barPlacement', 'powerAtBar',
  // Data-loss bugfix (found 2026-07-18): the legacy hosted wizard has always
  // written guestPreferences ({balance, naInterest}) but the key was never on
  // this allow-list, so hosted guest-prefs answers were silently dropped at
  // save. v2's display-only taste answers reuse the same key.
  'guestPreferences',
  // legacy fields preserved for back-compat with already-saved plans
  'signatureCocktails', 'barFocus', 'wineStyles', 'beerStyles', 'beerWineBalance',
  'beerWineNotes', 'fullBarNotes', 'logisticsNotes',
]);

function sanitizeSelections(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SELECTIONS_KEYS.has(key)) continue; // drop unknown keys, including _logoFilename
    out[key] = raw[key];
  }
  // companyLogo must be either empty or a path served by THIS API. Reject
  // `javascript:`, `data:`, or any cross-origin URL — the admin event-detail
  // page renders `<a href={companyLogo}>Download original</a>`, which would
  // otherwise execute attacker-controlled script in an admin session.
  if (out.companyLogo !== undefined) {
    const cl = typeof out.companyLogo === 'string' ? out.companyLogo : '';
    if (cl && !cl.startsWith('/api/drink-plans/t/') && !cl.startsWith(`${API_URL}/api/drink-plans/t/`)) {
      out.companyLogo = '';
    }
  }
  // Planner v2 crowd answers: normalize to the pinned contract shape so
  // garbage from the public token route never reaches the quantity engine.
  if (out.crowd !== undefined) {
    const c = (out.crowd && typeof out.crowd === 'object' && !Array.isArray(out.crowd)) ? out.crowd : {};
    const rawDrinkers = c.drinkers === null || c.drinkers === undefined || c.drinkers === '' ? null : Number(c.drinkers);
    const drinkers = Number.isFinite(rawDrinkers) ? Math.max(0, Math.round(rawDrinkers)) : null;
    const profiles = ['cocktail_forward', 'wine', 'beer', 'even', 'help'];
    out.crowd = {
      drinkers,
      unsure: c.unsure === true || drinkers === null,
      profile: profiles.includes(c.profile) ? c.profile : 'help',
    };
  }
  if (out.barPlacement !== undefined) {
    out.barPlacement = ['indoors', 'outdoors', 'unsure'].includes(out.barPlacement) ? out.barPlacement : 'unsure';
  }
  if (out.powerAtBar !== undefined) {
    out.powerAtBar = ['yes', 'no', 'unsure'].includes(out.powerAtBar) ? out.powerAtBar : 'unsure';
  }
  return out;
}

module.exports = { ALLOWED_SELECTIONS_KEYS, sanitizeSelections };
