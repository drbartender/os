const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeStripSet } = require('./shoppingListAddonCoverage');

test('returns empty Set when activeAddonSlugs is missing', () => {
  const r = computeStripSet({});
  assert.equal(r.size, 0);
});

test('returns empty Set when activeAddonSlugs is empty array', () => {
  const r = computeStripSet({ activeAddonSlugs: [] });
  assert.equal(r.size, 0);
});

test('returns empty Set when activeAddonSlugs is null', () => {
  const r = computeStripSet({ activeAddonSlugs: null });
  assert.equal(r.size, 0);
});

test('ice-delivery-only strips Ice', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only'] });
  assert.deepEqual([...r].sort(), ['Ice']);
});

test('cups-disposables-only strips Cups, Straws, Napkins', () => {
  const r = computeStripSet({ activeAddonSlugs: ['cups-disposables-only'] });
  assert.deepEqual([...r].sort(), ['Cups (9oz)', 'Napkins', 'Straws']);
});

test('bottled-water-only strips Water', () => {
  const r = computeStripSet({ activeAddonSlugs: ['bottled-water-only'] });
  assert.deepEqual([...r].sort(), ['Water']);
});

test('full-mixers-only strips all BASIC_MIXERS including Bitters and Simple Syrup', () => {
  const r = computeStripSet({ activeAddonSlugs: ['full-mixers-only'] });
  // BASIC_MIXERS contains 12 items (Ginger Ale + Ginger Beer dropped to recipe-only).
  assert.equal(r.size, 12);
  assert.ok(r.has('Coca Cola'));
  assert.ok(r.has('Simple Syrup'));
  assert.ok(r.has('Angostura Bitters'));
  assert.ok(!r.has('Lemons'));      // Lemons stay in GARNISHES, not stripped here
  assert.ok(!r.has('Ice'));         // Ice is ALWAYS_INCLUDE, not BASIC_MIXERS
});

test('garnish-package-only strips all 4 GARNISHES items (no Bitters)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['garnish-package-only'] });
  assert.deepEqual([...r].sort(), ['Lemons', 'Limes', 'Oranges', 'Premium Cherries']);
});

test('the-foundation strips Foundation items (Water, Cups, Straws, Napkins, Ice)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-foundation'] });
  assert.deepEqual([...r].sort(), ['Cups (9oz)', 'Ice', 'Napkins', 'Straws', 'Water']);
});

test('the-full-compound strips Foundation + all BASIC_MIXERS + all GARNISHES', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-full-compound'] });
  // 5 Foundation + 12 BASIC_MIXERS + 4 GARNISHES = 21
  assert.equal(r.size, 21);
  assert.ok(r.has('Ice'));
  assert.ok(r.has('Angostura Bitters'));
  assert.ok(r.has('Premium Cherries'));
  assert.ok(r.has('Lemons'));
  assert.ok(r.has('Coca Cola'));
});

test('unknown slug is silently ignored (no error, empty contribution)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['some-future-addon-slug'] });
  assert.equal(r.size, 0);
});

test('signature-mixers-only is silently skipped in v1 (deferred to follow-up spec)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['signature-mixers-only'] });
  assert.equal(r.size, 0);
});

test('the-formula is silently skipped in v1 (deferred to follow-up spec)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-formula'] });
  assert.equal(r.size, 0);
});

test('multiple add-ons union their coverage', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only', 'bottled-water-only'] });
  assert.deepEqual([...r].sort(), ['Ice', 'Water']);
});

test('Foundation + Full Mixers stripped together: union covers 5 + 12 items', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-foundation', 'full-mixers-only'] });
  // 5 Foundation + 12 BASIC_MIXERS, no overlap.
  assert.equal(r.size, 17);
  assert.ok(r.has('Ice'));
  assert.ok(r.has('Angostura Bitters'));
});

test('duplicate slugs in input do not cause duplicate Set entries', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only', 'ice-delivery-only'] });
  assert.equal(r.size, 1);
  assert.ok(r.has('Ice'));
});
