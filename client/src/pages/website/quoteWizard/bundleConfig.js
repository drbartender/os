// BYOB bundle definitions
export const BYOB_BUNDLE_SLUGS = ['the-foundation', 'the-formula', 'the-full-compound'];
export const MIXER_SLUGS = ['signature-mixers-only', 'full-mixers-only'];

// Items the bundle covers — shown auto-checked with "INCLUDED" pill
export const BUNDLE_INCLUDED = {
  'the-foundation': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only'],
  'the-formula': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'signature-mixers-only'],
  'the-full-compound': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'full-mixers-only', 'garnish-package-only'],
};

// Items disabled (but not "included") — the bundle supersedes or excludes them
export const BUNDLE_UNAVAILABLE = {
  'the-formula': ['full-mixers-only'],            // Formula already has Signature Mixers
  'the-full-compound': ['signature-mixers-only'], // Full Compound's Full Mixers encompasses Signature
};

// Union of both lists — used to strip covered items from pricing/submit
export const BUNDLE_COVERED = Object.fromEntries(
  BYOB_BUNDLE_SLUGS.map(b => [b, [...(BUNDLE_INCLUDED[b] || []), ...(BUNDLE_UNAVAILABLE[b] || [])]])
);
