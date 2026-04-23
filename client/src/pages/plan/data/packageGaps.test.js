import {
  computeCocktailGap,
  packageSuppressedAddons,
  isCocktailFullyCovered,
  computeGapCost,
} from './packageGaps';

describe('computeCocktailGap', () => {
  test('returns empty when package covers everything', () => {
    const cocktail = { upgrade_addon_slugs: ['house-made-ginger-beer'] };
    const pkg = { package_covered_addon_slugs: ['soft-drink-addon', 'house-made-ginger-beer'] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual([]);
  });

  test('returns missing slugs when package covers none', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-bitter-aperitifs', 'specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: [] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual(['specialty-bitter-aperitifs', 'specialty-vermouths']);
  });

  test('returns partial when package covers some', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-bitter-aperitifs', 'specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual(['specialty-bitter-aperitifs']);
  });

  test('no-gap cocktail returns empty regardless of package', () => {
    const cocktail = { upgrade_addon_slugs: [] };
    const pkg = { package_covered_addon_slugs: [] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual([]);
  });

  test('handles nulls as empty', () => {
    expect(computeCocktailGap(null, null)).toEqual([]);
    expect(computeCocktailGap({}, {})).toEqual([]);
  });
});

describe('packageSuppressedAddons', () => {
  test('returns covered slugs', () => {
    expect(packageSuppressedAddons({ package_covered_addon_slugs: ['soft-drink-addon'] })).toEqual(['soft-drink-addon']);
  });
  test('returns empty when unset', () => {
    expect(packageSuppressedAddons(null)).toEqual([]);
    expect(packageSuppressedAddons({})).toEqual([]);
  });
});

describe('isCocktailFullyCovered', () => {
  test('true when no gap', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(isCocktailFullyCovered(cocktail, pkg)).toBe(true);
  });
  test('false when partial gap', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-vermouths', 'specialty-bitter-aperitifs'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(isCocktailFullyCovered(cocktail, pkg)).toBe(false);
  });
});

describe('computeGapCost', () => {
  const addonPricing = [
    { slug: 'specialty-bitter-aperitifs', rate: '3.00', billing_type: 'per_guest' },
    { slug: 'specialty-vermouths', rate: '1.50', billing_type: 'per_guest' },
    { slug: 'house-made-ginger-beer', rate: '2.50', billing_type: 'per_guest' },
  ];

  test('sums per-guest rates for all gap addons', () => {
    const result = computeGapCost(['specialty-bitter-aperitifs', 'specialty-vermouths'], addonPricing, 100);
    expect(result.perGuest).toBe(4.5);
    expect(result.total).toBe(450);
  });

  test('returns zero for empty gap', () => {
    const result = computeGapCost([], addonPricing, 100);
    expect(result.perGuest).toBe(0);
    expect(result.total).toBe(0);
  });

  test('missing guestCount returns per-guest only', () => {
    const result = computeGapCost(['house-made-ginger-beer'], addonPricing, null);
    expect(result.perGuest).toBe(2.5);
    expect(result.total).toBe(null);
  });

  test('ignores unknown slugs', () => {
    const result = computeGapCost(['unknown-slug', 'house-made-ginger-beer'], addonPricing, 50);
    expect(result.perGuest).toBe(2.5);
    expect(result.total).toBe(125);
  });
});
