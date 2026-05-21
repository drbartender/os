const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateProposalRules,
  getSelectedBundleSlug,
  stripIncludedAddons,
} = require('./proposalRules');

// Addon rows as the DB returns them.
const A = {
  formula:     { id: 2,  slug: 'the-formula' },
  foundation:  { id: 1,  slug: 'the-foundation' },
  sigMix:      { id: 5,  slug: 'signature-mixers-only' },
  fullMix:     { id: 6,  slug: 'full-mixers-only' },
  garnish:     { id: 7,  slug: 'garnish-package-only' },
  fb:          { id: 8,  slug: 'flavor-blaster-rental' },
  realGlass:   { id: 9,  slug: 'real-glassware' },
  coupe:       { id: 10, slug: 'champagne-coupe-upgrade', requires_addon_slug: 'champagne-toast' },
  champagne:   { id: 11, slug: 'champagne-toast' },
  mocktailBar: { id: 12, slug: 'mocktail-bar' },
};
const ALL = Object.values(A);

const HOSTED = { pricing_type: 'per_guest', bar_type: 'full', category: 'hosted' };
const BYOB   = { pricing_type: 'flat', bar_type: 'byob', category: 'byob' };

test('rejects hosted package below 25 guests', () => {
  assert.throws(() => validateProposalRules({
    pkg: HOSTED, guestCount: 10, addonIds: [], addons: ALL, clientProvidesGlassware: false,
  }), /guest/i);
});

test('rejects Flavor Blaster with no glassware', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [8], addons: ALL, clientProvidesGlassware: false,
  }), /glassware/i);
});

test('allows Flavor Blaster when client provides glassware', () => {
  assert.doesNotThrow(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [8], addons: ALL, clientProvidesGlassware: true,
  }));
});

test('rejects real-glassware above 100 guests', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 150, addonIds: [9], addons: ALL, clientProvidesGlassware: false,
  }), /100/);
});

test('rejects two BYOB bundles at once (bundle mutex)', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [1, 2], addons: ALL, clientProvidesGlassware: false,
  }), /bundle/i);
});

test('rejects two mixer packages at once (mixer mutex)', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [5, 6], addons: ALL, clientProvidesGlassware: false,
  }), /mixer/i);
});

test('rejects requires_addon_slug addon without its parent', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [10], addons: ALL, clientProvidesGlassware: false,
  }), /champagne-toast|requires/i);
});

test('passes a valid selection', () => {
  assert.doesNotThrow(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [11, 10], addons: ALL, clientProvidesGlassware: false,
  }));
});

// --- Fix C: dedicated negative tests for the 3 previously-untested rules ---

test('rejects garnish-package-only on a hosted package', () => {
  assert.throws(() => validateProposalRules({
    pkg: HOSTED, guestCount: 50, addonIds: [7], addons: ALL, clientProvidesGlassware: false,
  }), /garnish/i);
});

test('rejects mocktail-bar on BYOB without Formula or Full Compound', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [12], addons: ALL, clientProvidesGlassware: false,
  }), /mocktail/i);
});

test('allows mocktail-bar on BYOB when Formula is selected', () => {
  assert.doesNotThrow(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [12, 2], addons: ALL, clientProvidesGlassware: false,
  }));
});

test('rejects champagne-coupe-upgrade above 100 guests', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 150, addonIds: [10, 11], addons: ALL, clientProvidesGlassware: false,
  }), /100/);
});

// --- Fix D: pure-function coverage for the newly-ported bundle helpers ---

test('getSelectedBundleSlug returns the bundle slug when a bundle is selected', () => {
  assert.equal(getSelectedBundleSlug([2, 11], ALL), 'the-formula');
});

test('getSelectedBundleSlug returns null when no bundle is selected', () => {
  assert.equal(getSelectedBundleSlug([8, 11], ALL), null);
});

test('stripIncludedAddons drops a bundle-covered addon, keeps the bundle', () => {
  // the-formula covers signature-mixers-only — only the bundle id should remain.
  assert.deepEqual(stripIncludedAddons([2, 5], ALL), [2]);
});

test('stripIncludedAddons is a no-op when no bundle is selected', () => {
  assert.deepEqual(stripIncludedAddons([5, 11], ALL), [5, 11]);
});
