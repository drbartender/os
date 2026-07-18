// Quantity engine: expected demand for a drink plan. Pure functions, no DB.
// The shopping-list generator translates demand into purchasable units and
// applies the per-role buffer multipliers (settings keys shopping_buffer_*);
// this module only models WHO drinks HOW MUCH of WHAT.
//
// Spec: docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md §4.4.
// Owner-decided behavior (2026-07-18 brainstorm):
//   - The guest-profile answer is a LIGHT thumb on the scale ("the host is
//     often clueless"): at most ±10 points per category, applied to the
//     settings DEFAULT split (45/30/25), never to even thirds.
//   - Within a category the split across drinks is explicitly agnostic
//     ("we can never know if the mojito will out-pour the vodka lemonade"):
//     always an even split.
//   - Unknown drinker count is a real answer: fall back to 75% of guests.

const DRINKER_FALLBACK_RATIO = 0.75;
const NUDGE_CAP = 10;

const CATEGORIES = ['cocktails', 'beer', 'wine'];

// profile -> per-category nudge in percentage points (pre-cap; cap is a
// safety net for future profiles, current values sit within it).
const PROFILE_NUDGES = {
  cocktail_forward: { cocktails: +10, beer: -5, wine: -5 },
  beer: { cocktails: -5, beer: +10, wine: -5 },
  wine: { cocktails: -5, beer: -5, wine: +10 },
  // 'even' pulls every category toward a flat third, capped below.
  // 'help' (help me decide) and unknown profiles leave the defaults alone.
};

function clampNudge(value) {
  return Math.max(-NUDGE_CAP, Math.min(NUDGE_CAP, value));
}

// Resolve the percentage split for a profile against the defaults.
// Defaults are normalized to sum 100 first (defensive: settings are strings
// typed by an admin). Result is renormalized after nudging + zero-floor.
function resolveSplit(profile, splitDefaults) {
  const defaults = {};
  let defTotal = 0;
  for (const cat of CATEGORIES) {
    defaults[cat] = Math.max(0, Number(splitDefaults && splitDefaults[cat]) || 0);
    defTotal += defaults[cat];
  }
  if (defTotal <= 0) { defaults.cocktails = 45; defaults.beer = 30; defaults.wine = 25; defTotal = 100; }
  for (const cat of CATEGORIES) defaults[cat] = (defaults[cat] / defTotal) * 100;

  // Per-category deltas, clamped to the cap, then BALANCED to zero-sum by
  // scaling down the heavier side. Without balancing, renormalizing back to
  // 100 can push a category past the cap (the 'even' profile hit 10.57).
  const deltas = { cocktails: 0, beer: 0, wine: 0 };
  if (profile === 'even') {
    for (const cat of CATEGORIES) deltas[cat] = clampNudge(100 / 3 - defaults[cat]);
  } else if (PROFILE_NUDGES[profile]) {
    for (const cat of CATEGORIES) deltas[cat] = clampNudge(PROFILE_NUDGES[profile][cat] || 0);
  }
  const pos = CATEGORIES.reduce((s, c) => s + Math.max(0, deltas[c]), 0);
  const neg = CATEGORIES.reduce((s, c) => s + Math.min(0, deltas[c]), 0);
  if (pos > -neg && pos > 0) {
    const scale = -neg / pos;
    for (const cat of CATEGORIES) if (deltas[cat] > 0) deltas[cat] *= scale;
  } else if (-neg > pos && neg < 0) {
    const scale = pos / -neg;
    for (const cat of CATEGORIES) if (deltas[cat] < 0) deltas[cat] *= scale;
  }

  const nudged = {};
  for (const cat of CATEGORIES) nudged[cat] = Math.max(0, defaults[cat] + deltas[cat]);
  const total = CATEGORIES.reduce((sum, cat) => sum + nudged[cat], 0);
  for (const cat of CATEGORIES) nudged[cat] = (nudged[cat] / total) * 100;
  return nudged;
}

// Split an integer pour count by percentages, summing exactly to `pours`
// (largest-remainder rounding so no pour is created or lost).
function apportion(pours, splitPct) {
  const raw = CATEGORIES.map((cat) => ({ cat, exact: (pours * splitPct[cat]) / 100 }));
  const result = {};
  let used = 0;
  for (const r of raw) { result[r.cat] = Math.floor(r.exact); used += result[r.cat]; }
  const byRemainder = raw
    .map((r) => ({ cat: r.cat, rem: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rem - a.rem);
  for (let i = 0; used < pours && i < byRemainder.length; i += 1, used += 1) {
    result[byRemainder[i].cat] += 1;
  }
  return result;
}

/**
 * Compute expected demand.
 * @param {object} opts {
 *   guestCount: number
 *   drinkers:   number|null   null/undefined = "not sure" -> 75% of guests
 *   profile:    'cocktail_forward'|'wine'|'beer'|'even'|'help'|undefined
 *   hours:      number         event service hours
 *   pace:       number         pours per drinker per hour (settings)
 *   splitDefaults: { cocktails, beer, wine }  percentage points (settings)
 *   counts:     { cocktails?, beer?, wine? }  selected drink/style counts,
 *               for the even per-drink split (optional)
 * }
 * @returns { drinkers, pours, splitPct, split, perDrinkPours }
 */
function computeDemand(opts) {
  const guestCount = Math.max(0, Number(opts.guestCount) || 0);
  let drinkers = opts.drinkers === null || opts.drinkers === undefined
    ? Math.round(guestCount * DRINKER_FALLBACK_RATIO)
    : Number(opts.drinkers) || 0;
  drinkers = Math.max(0, Math.min(guestCount, drinkers));

  const hours = Math.max(0, Number(opts.hours) || 0);
  const pace = Math.max(0, Number(opts.pace) || 1.0);
  const pours = Math.round(drinkers * hours * pace);

  const splitPct = resolveSplit(opts.profile, opts.splitDefaults);
  const split = apportion(pours, splitPct);

  const perDrinkPours = {};
  const counts = opts.counts || {};
  for (const cat of CATEGORIES) {
    const n = Math.max(0, Number(counts[cat]) || 0);
    perDrinkPours[cat] = n > 0 ? split[cat] / n : null;
  }

  return { drinkers, pours, splitPct, split, perDrinkPours };
}

module.exports = { computeDemand, resolveSplit, apportion, DRINKER_FALLBACK_RATIO, NUDGE_CAP };
