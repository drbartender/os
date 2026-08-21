// Ladder assembly: pure functions, no React, no network.
//
// The drawer renders ONE ladder of how much DrB handles, from bare bar service
// up to a fully stocked bar. Everything here turns the quote payload into that
// shape. It is deliberately separate from the component so the lane placement,
// the anchor resolution, and the three price sublines can be tested without
// mounting anything.

import { buildLadder, sublineFor, openState } from './ladder';

// --- fixtures ---------------------------------------------------------------
// Shaped exactly like the mini-lane's payload (bar_type, description,
// priced_by, per_guest_rate, min_billed_guests, min_total, visible_extra_ids).

const opt = (over = {}) => ({
  package_id: 1,
  slug: 'x',
  name: 'X',
  category: 'hosted',
  pricing_type: 'per_guest',
  bar_type: 'full_bar',
  description: 'desc',
  is_current: false,
  total: 1000,
  available: true,
  reason: null,
  dropped: [],
  priced_by: 'rate',
  per_guest_rate: 20,
  min_billed_guests: 25,
  min_total: 550,
  visible_extra_ids: [],
  ...over,
});

const CORE = opt({
  package_id: 10, slug: 'the-core-reaction', name: 'The Core Reaction',
  category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  total: 700, priced_by: null, per_guest_rate: null,
  min_billed_guests: null, min_total: null,
});
const PRIMARY = opt({ package_id: 20, slug: 'the-primary-culture', name: 'The Primary Culture', bar_type: 'beer_and_wine', total: 1440, per_guest_rate: 12 });
const REFINED = opt({ package_id: 21, slug: 'the-refined-reaction', name: 'The Refined Reaction', bar_type: 'beer_and_wine', total: 1680, per_guest_rate: 14 });
const BASE = opt({ package_id: 30, slug: 'the-base-compound', name: 'The Base Compound', bar_type: 'full_bar', total: 2160, per_guest_rate: 18 });
const GRAND = opt({ package_id: 31, slug: 'the-grand-experiment', name: 'The Grand Experiment', bar_type: 'full_bar', total: 4800, per_guest_rate: 40 });
const CLEAR = opt({ package_id: 40, slug: 'the-clear-reaction', name: 'The Clear Reaction', bar_type: 'mocktail', total: 1680, per_guest_rate: 14 });

const TIERS = [
  { addon_id: null, slug: null, name: 'Bar service only', total: 700, covers: [], selected: true, description: null, per_guest_rate: null },
  { addon_id: 1, slug: 'the-foundation', name: 'The Foundation', total: 1060, covers: ['Ice Delivery'], selected: false, description: 'Ice, water, cups.', per_guest_rate: 3 },
  { addon_id: 2, slug: 'the-formula', name: 'The Formula', total: 1360, covers: ['Ice Delivery', 'Signature Mixers'], selected: false, description: 'Plus mixers.', per_guest_rate: 5.5 },
  { addon_id: 3, slug: 'the-full-compound', name: 'The Full Compound', total: 1660, covers: ['Ice Delivery', 'Full Mixers'], selected: false, description: 'Plus everything.', per_guest_rate: 8 },
];

const payload = (over = {}) => ({
  comparable: true,
  options: [CORE, PRIMARY, REFINED, BASE, GRAND, CLEAR],
  tiers: TIERS,
  current_package_id: 10,
  ...over,
});

const byobCurrent = () => payload({
  options: [{ ...CORE, is_current: true }, PRIMARY, REFINED, BASE, GRAND, CLEAR],
});
const hostedCurrent = (pkg = BASE) => payload({
  current_package_id: pkg.package_id,
  options: payload().options.map((o) => (o.package_id === pkg.package_id ? { ...o, is_current: true } : o)),
  tiers: TIERS.map((t) => ({ ...t, selected: t.addon_id === null })),
});

// --- lane placement ---------------------------------------------------------

test('hosted options split into lanes by bar_type, never by slug', () => {
  const { hostedLanes } = buildLadder(byobCurrent());
  const full = hostedLanes.find((l) => l.key === 'full_bar');
  const bw = hostedLanes.find((l) => l.key === 'beer_wine');
  expect(full.label).toBe('Full bar');
  expect(bw.label).toBe('Beer & wine');
  expect(full.rungs.map((r) => r.slug)).toEqual(['the-base-compound', 'the-grand-experiment']);
  expect(bw.rungs.map((r) => r.slug)).toEqual(['the-primary-culture', 'the-refined-reaction']);
});

test('an unrecognized bar_type lands in unmapped, not silently dropped', () => {
  const weird = opt({ package_id: 99, slug: 'mystery', bar_type: 'speakeasy' });
  const { unmapped, hostedLanes } = buildLadder(payload({ options: [...payload().options, weird] }));
  expect(unmapped.map((o) => o.slug)).toEqual(['mystery']);
  for (const lane of hostedLanes) {
    expect(lane.rungs.map((r) => r.slug)).not.toContain('mystery');
  }
});

test('a class-booked or retired current package reaches the wire and is not lost', () => {
  // bar_type 'class' can reach the client via the options query's `OR id = $1`
  // branch for the proposal's OWN package. It must not vanish.
  const klass = opt({ package_id: 77, slug: 'mixology-101', bar_type: 'class', is_current: true });
  const { anchor, unmapped } = buildLadder(payload({ current_package_id: 77, options: [klass, PRIMARY, BASE] }));
  expect(anchor.package_id).toBe(77);
  expect(unmapped.map((o) => o.slug)).not.toContain('mixology-101');
});

// --- the sideways card ------------------------------------------------------

test('The Clear Reaction is sideways, never a hosted rung', () => {
  const { sideways, hostedLanes } = buildLadder(byobCurrent());
  expect(sideways.slug).toBe('the-clear-reaction');
  for (const lane of hostedLanes) {
    expect(lane.rungs.map((r) => r.slug)).not.toContain('the-clear-reaction');
  }
});

test('when the client IS on Clear Reaction it anchors and the sideways card is suppressed', () => {
  const { anchor, sideways } = buildLadder(hostedCurrent(CLEAR));
  expect(anchor.slug).toBe('the-clear-reaction');
  expect(sideways).toBeNull();
});

// --- anchor resolution ------------------------------------------------------

test('a BYOB client on a TIER anchors to that tier row, and it leaves the rungs', () => {
  const p = byobCurrent();
  p.tiers = TIERS.map((t) => ({ ...t, selected: t.slug === 'the-formula' }));
  const { anchor, byobRungs } = buildLadder(p);
  expect(anchor.kind).toBe('tier');
  expect(anchor.slug).toBe('the-formula');
  expect(anchor.total).toBe(1360);
  expect(byobRungs.map((r) => r.slug)).not.toContain('the-formula');
  // the other three BYOB steps remain, bar-service-only included
  expect(byobRungs).toHaveLength(3);
});

test('a BYOB client with no tier anchors to bar-service-only', () => {
  const { anchor, byobRungs } = buildLadder(byobCurrent());
  expect(anchor.kind).toBe('tier');
  expect(anchor.name).toBe('Bar service only');
  expect(byobRungs.map((r) => r.name)).not.toContain('Bar service only');
  expect(byobRungs).toHaveLength(3);
});

test('a hosted client anchors to the option row and keeps ALL four tier rungs', () => {
  const { anchor, byobRungs } = buildLadder(hostedCurrent(BASE));
  expect(anchor.kind).toBe('option');
  expect(anchor.slug).toBe('the-base-compound');
  expect(byobRungs).toHaveLength(4);
  expect(byobRungs.map((r) => r.name)).toContain('Bar service only');
});

test('the anchor never appears again as a hosted rung', () => {
  const { anchor, hostedLanes } = buildLadder(hostedCurrent(GRAND));
  expect(anchor.slug).toBe('the-grand-experiment');
  const all = hostedLanes.flatMap((l) => l.rungs.map((r) => r.slug));
  expect(all).not.toContain('the-grand-experiment');
});

// --- open state -------------------------------------------------------------

test('a BYOB client opens collapsed: four rows and the expand line', () => {
  expect(openState(buildLadder(byobCurrent())).expanded).toBe(false);
});

test('a hosted client opens expanded, with THEIR OWN lane open', () => {
  const bw = openState(buildLadder(hostedCurrent(REFINED)));
  expect(bw.expanded).toBe(true);
  expect(bw.openLane).toBe('beer_wine');

  const fb = openState(buildLadder(hostedCurrent(GRAND)));
  expect(fb.expanded).toBe(true);
  expect(fb.openLane).toBe('full_bar');
});

test('a Clear Reaction client opens expanded, defaulting to full bar', () => {
  const s = openState(buildLadder(hostedCurrent(CLEAR)));
  expect(s.expanded).toBe(true);
  expect(s.openLane).toBe('full_bar');
});

test('the expand line is suppressed when no hosted option is available', () => {
  const noneAvail = payload({
    options: [{ ...CORE, is_current: true },
      { ...PRIMARY, available: false, total: null },
      { ...BASE, available: false, total: null },
      { ...CLEAR, available: false, total: null }],
  });
  expect(buildLadder(noneAvail).hasHostedOptions).toBe(false);
  expect(buildLadder(byobCurrent()).hasHostedOptions).toBe(true);
});

// --- price sublines ---------------------------------------------------------

test('sublineFor: hosted priced by rate names the rate actually charged', () => {
  expect(sublineFor(opt({ priced_by: 'rate', per_guest_rate: 17 })))
    .toBe('$17.00 per guest, everything included');
});

test('sublineFor: a headcount minimum says so instead of doing per-head math', () => {
  expect(sublineFor(opt({ priced_by: 'guest_min', min_billed_guests: 25 })))
    .toBe('priced at our 25-guest minimum');
});

test('sublineFor: a dollar floor names the floor from the payload, never a hardcoded 550', () => {
  expect(sublineFor(opt({ priced_by: 'dollar_min', min_total: 550 })))
    .toBe('$550 minimum for smaller events');
  expect(sublineFor(opt({ priced_by: 'dollar_min', min_total: 400 })))
    .toBe('$400 minimum for smaller events');
});

test('sublineFor: tier rungs price on top of bar service; the base row is flat', () => {
  expect(sublineFor(TIERS[2], 'tier')).toBe('$5.50 per guest, on top of bar service');
  expect(sublineFor(TIERS[0], 'tier')).toBe('flat service rate, you supply the alcohol');
});

test('sublineFor: nothing to say when the option was never priced', () => {
  expect(sublineFor(opt({ available: false, total: null, priced_by: null }))).toBe('');
  expect(sublineFor(CORE)).toBe('');
});

// --- the catalog entries the contents panel reads ---------------------------

test('both newly-added packages resolve to real contents, not an empty panel', () => {
  // eslint-disable-next-line global-require
  const { bucketsForSlug } = require('../catalogBuckets');
  for (const slug of ['the-refined-reaction', 'the-clear-reaction']) {
    const b = bucketsForSlug(slug);
    expect(b).not.toBeNull();
    expect(Object.values(b).some((items) => items.length > 0)).toBe(true);
  }
});
