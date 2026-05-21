import {
  getSelectedBundleSlug,
  stripIncludedAddons,
  isIncludedByBundle,
  isUnavailableByBundle,
  toggleAddonWithRules,
  filterAddons,
  enforceHostedMinimum,
  reconcileFlavorBlaster,
  isQuantityCapable,
} from './proposalRules';

// Minimal addon fixtures keyed the same way the API returns them.
const A = {
  foundation:  { id: 1,  slug: 'the-foundation' },
  formula:     { id: 2,  slug: 'the-formula' },
  compound:    { id: 3,  slug: 'the-full-compound' },
  ice:         { id: 4,  slug: 'ice-delivery-only' },
  sigMix:      { id: 5,  slug: 'signature-mixers-only' },
  fullMix:     { id: 6,  slug: 'full-mixers-only' },
  garnish:     { id: 7,  slug: 'garnish-package-only' },
  fb:          { id: 8,  slug: 'flavor-blaster-rental' },
  realGlass:   { id: 9,  slug: 'real-glassware' },
  coupe:       { id: 10, slug: 'champagne-coupe-upgrade', requires_addon_slug: 'champagne-toast' },
  champagne:   { id: 11, slug: 'champagne-toast' },
  syrups:      { id: 12, slug: 'handcrafted-syrups' },
  mocktailBar: { id: 13, slug: 'mocktail-bar', applies_to: 'all' },
  parking:     { id: 14, slug: 'parking-fee', applies_to: 'all' },
  syrups3:     { id: 15, slug: 'handcrafted-syrups-3pack', applies_to: 'all' },
};
const ALL = Object.values(A);

test('getSelectedBundleSlug returns the active BYOB bundle', () => {
  expect(getSelectedBundleSlug([4, 2], ALL)).toBe('the-formula');
  expect(getSelectedBundleSlug([4], ALL)).toBe(null);
});

test('stripIncludedAddons drops bundle-covered addons but keeps the bundle itself', () => {
  // Formula covers ice + signature mixers; the bundle id (2) stays.
  expect(stripIncludedAddons([2, 4, 5], ALL).sort()).toEqual([2]);
});

test('isIncludedByBundle / isUnavailableByBundle reflect bundleConfig', () => {
  expect(isIncludedByBundle('ice-delivery-only', [2], ALL)).toBe(true);
  expect(isUnavailableByBundle('full-mixers-only', [2], ALL)).toBe(true);
  expect(isIncludedByBundle('ice-delivery-only', [], ALL)).toBe(false);
});

test('toggleAddonWithRules enforces BYOB bundle mutex', () => {
  const r = toggleAddonWithRules({ addonIds: [1], syrupSelections: [] }, 2, ALL);
  expect(r.addon_ids).toEqual([2]); // adding Formula removes Foundation
});

test('toggleAddonWithRules enforces mixer mutex', () => {
  const r = toggleAddonWithRules({ addonIds: [5], syrupSelections: [] }, 6, ALL);
  expect(r.addon_ids).toEqual([6]); // full mixers replaces signature mixers
});

test('toggleAddonWithRules clears syrup_selections when syrups removed', () => {
  const r = toggleAddonWithRules({ addonIds: [12], syrupSelections: ['vanilla'] }, 12, ALL);
  expect(r.addon_ids).toEqual([]);
  expect(r.syrup_selections).toEqual([]);
});

test('toggleAddonWithRules removes dependents when parent removed', () => {
  const r = toggleAddonWithRules({ addonIds: [11, 10], syrupSelections: [] }, 11, ALL);
  expect(r.addon_ids).toEqual([]); // removing champagne-toast drops coupe upgrade
});

test('toggleAddonWithRules is a no-op on a bundle-locked addon', () => {
  // Formula active; ice is bundle-covered → toggling ice does nothing.
  const r = toggleAddonWithRules({ addonIds: [2], syrupSelections: [] }, 4, ALL);
  expect(r.addon_ids).toEqual([2]);
});

test('filterAddons hides parking-fee and 3-pack syrup variant', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: false, packageCategory: 'byob',
    addonIds: [], guestCount: 50,
  });
  const slugs = visibleAddons.map(a => a.slug);
  expect(slugs).not.toContain('parking-fee');
  expect(slugs).not.toContain('handcrafted-syrups-3pack');
});

test('filterAddons hides real-glassware and coupe above 100 guests', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: false, packageCategory: 'byob',
    addonIds: [11], guestCount: 150,
  });
  const slugs = visibleAddons.map(a => a.slug);
  expect(slugs).not.toContain('real-glassware');
  expect(slugs).not.toContain('champagne-coupe-upgrade');
});

test('filterAddons hides garnish-package for hosted', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: true, packageCategory: 'hosted',
    addonIds: [], guestCount: 50,
  });
  expect(visibleAddons.map(a => a.slug)).not.toContain('garnish-package-only');
});

test('enforceHostedMinimum bumps below-25 only for hosted', () => {
  expect(enforceHostedMinimum(10, true)).toBe(25);
  expect(enforceHostedMinimum(10, false)).toBe(10);
  expect(enforceHostedMinimum(40, true)).toBe(40);
});

test('reconcileFlavorBlaster removes FB when no glassware', () => {
  expect(reconcileFlavorBlaster([8], ALL, false)).toEqual([]);
  expect(reconcileFlavorBlaster([8], ALL, true)).toEqual([8]);
  expect(reconcileFlavorBlaster([8, 9], ALL, false)).toEqual([8, 9]); // real-glassware present
});

test('isQuantityCapable matches the 4 staffing-ish slugs, not syrups', () => {
  expect(isQuantityCapable({ slug: 'additional-bartender' })).toBe(true);
  expect(isQuantityCapable({ slug: 'barback' })).toBe(true);
  expect(isQuantityCapable({ slug: 'banquet-server' })).toBe(true);
  expect(isQuantityCapable({ slug: 'pre-batched-mocktail' })).toBe(true);
  expect(isQuantityCapable({ slug: 'handcrafted-syrups' })).toBe(false); // syrup picker handles count
  expect(isQuantityCapable({ slug: 'the-formula' })).toBe(false);
  expect(isQuantityCapable(null)).toBe(false);
});
