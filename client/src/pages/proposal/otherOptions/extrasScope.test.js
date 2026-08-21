// Task 4's own checkpoint: the strip's scoping rules and the bundle-twin
// parity they run on. Kept separate from the RTL behaviour suite so a
// bundle-config drift fails THIS lane rather than surfacing at push time.

import {
  BUNDLE_INCLUDED, BUNDLE_UNAVAILABLE, BYOB_BUNDLE_SLUGS,
} from '../../../utils/proposalRules';
import { POPULAR_EXTRA_SLUGS } from './popularExtras';

// The resolver the strip uses, mirrored here so the three copy cases are
// pinned independently of React.
const blockedReason = (slug, bundleSlug, names) => {
  if (!bundleSlug) return '';
  const name = names[bundleSlug] || 'your bundle';
  if ((BUNDLE_INCLUDED[bundleSlug] || []).includes(slug)) return `included in ${name}`;
  if (!(BUNDLE_UNAVAILABLE[bundleSlug] || []).includes(slug)) return '';
  const at = BYOB_BUNDLE_SLUGS.indexOf(bundleSlug);
  const higher = BYOB_BUNDLE_SLUGS.slice(at + 1)
    .find((b) => (BUNDLE_INCLUDED[b] || []).includes(slug));
  return higher ? `comes with ${names[higher] || higher}` : `covered by ${name}`;
};

const NAMES = {
  'the-foundation': 'The Foundation',
  'the-formula': 'The Formula',
  'the-full-compound': 'The Full Compound',
};

// --- TWIN PARITY ------------------------------------------------------------
// The blocked rows run entirely on the CLIENT twin. If it drifts from the
// server's proposalRules.js the strip lies about what is included, so the
// literals are asserted here rather than trusted. Source of truth:
// server/utils/proposalRules.js.

test('the client bundle config matches the server, literal for literal', () => {
  expect(BYOB_BUNDLE_SLUGS).toEqual(['the-foundation', 'the-formula', 'the-full-compound']);
  expect(BUNDLE_INCLUDED).toEqual({
    'the-foundation': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only'],
    'the-formula': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'signature-mixers-only'],
    'the-full-compound': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'full-mixers-only', 'garnish-package-only'],
  });
  expect(BUNDLE_UNAVAILABLE).toEqual({
    'the-formula': ['full-mixers-only'],
    'the-full-compound': ['signature-mixers-only'],
  });
});

// --- the three copy cases ---------------------------------------------------

test('already yours: a bundle-covered item says which bundle covers it', () => {
  expect(blockedReason('ice-delivery-only', 'the-foundation', NAMES))
    .toBe('included in The Foundation');
  expect(blockedReason('signature-mixers-only', 'the-formula', NAMES))
    .toBe('included in The Formula');
});

test('nudge UP: full mixers on The Formula points at the bundle that has them', () => {
  // BUNDLE_UNAVAILABLE, and the item rides a HIGHER bundle's included list, so
  // this is a rung nudge rather than a dead end.
  expect(blockedReason('full-mixers-only', 'the-formula', NAMES))
    .toBe('comes with The Full Compound');
});

test('never point DOWN: signature mixers on The Full Compound are subsumed, not upsold', () => {
  // The mirror case. Full mixers already cover signature mixers, so pointing at
  // The Formula would be telling a client to downgrade to buy something they
  // already have.
  expect(blockedReason('signature-mixers-only', 'the-full-compound', NAMES))
    .toBe('covered by The Full Compound');
});

test('nothing is blocked when the client is on no bundle at all', () => {
  for (const slug of ['ice-delivery-only', 'full-mixers-only', 'garnish-package-only']) {
    expect(blockedReason(slug, null, NAMES)).toBe('');
  }
});

test('an unrelated extra is never blocked by a bundle', () => {
  expect(blockedReason('champagne-toast', 'the-full-compound', NAMES)).toBe('');
  expect(blockedReason('real-glassware', 'the-foundation', NAMES)).toBe('');
});

// --- chip membership --------------------------------------------------------

test('every curated chip slug is a real add-on slug, not a typo', () => {
  // A typo here fails silently: the chip simply never renders, and nobody
  // notices a missing upsell.
  const known = new Set([
    ...Object.values(BUNDLE_INCLUDED).flat(),
    'champagne-toast', 'house-made-ginger-beer', 'real-glassware', 'garnish-package-only',
    'soft-drink-addon', 'pre-batched-mocktail', 'mocktail-bar', 'non-alcoholic-beer',
    'zero-proof-spirits', 'carbonated-cocktails', 'smoked-cocktail-kit',
    'handcrafted-syrups', 'flavor-blaster-rental', 'barback', 'banquet-server',
    'additional-bartender', 'champagne-coupe-upgrade',
  ]);
  for (const slug of POPULAR_EXTRA_SLUGS) expect(known.has(slug)).toBe(true);
});
