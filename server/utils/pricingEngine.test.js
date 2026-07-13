const { test } = require('node:test');
const assert = require('node:assert');
const {
  calculateProposal, getStaffNoun, gratuityLineAmount, deriveGratuityRate,
  computeGratuityBasis, gratuityBasisFromSnapshot, recomputeSnapshotGratuity,
  GRATUITY_FLOOR_RATE,
} = require('./pricingEngine');

const BYOB = {
  id: 1, slug: 'byob', name: 'BYOB Bar', category: 'byob', pricing_type: 'flat',
  bar_type: 'byob', base_rate_4hr: 1000, base_rate_3hr: 900, extra_hour_rate: 150,
  bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40,
  first_bar_fee: 50, additional_bar_fee: 100,
};
const CLASS = { ...BYOB, slug: 'class', name: 'Cocktail Class', category: 'hosted',
  pricing_type: 'per_guest', bar_type: 'class', base_rate_4hr: 100, min_guests: 8 };

function base(extra = {}) {
  return { pkg: BYOB, guestCount: 100, durationHours: 4, numBars: 1,
    numBartenders: null, addons: [], syrupSelections: [], adjustments: [], ...extra };
}

test('no gratuity line when rate is 0 (default = today behavior)', () => {
  const snap = calculateProposal(base());
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'));
  assert.strictEqual(snap.gratuity.total, 0);
  assert.strictEqual(snap.gratuity.rate, 0);
  assert.strictEqual(snap.gratuity.tip_jar, true);
});

test('gratuity = rate x staffCount x hours, folded into total on top of services', () => {
  const noGrat = calculateProposal(base());
  const snap = calculateProposal(base({ gratuityRate: 25, tipJar: true }));
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.strictEqual(line.amount, 100); // 25 x 1 bartender x 4
  assert.strictEqual(snap.gratuity.staff_count, 1);
  assert.strictEqual(snap.gratuity.hours, 4);
  assert.strictEqual(snap.total, Math.round((noGrat.total + 100) * 100) / 100);
});

test('staffCount excludes barbacks/servers but includes additional-bartender addon', () => {
  const addons = [
    { id: 9, slug: 'additional-bartender', name: 'Additional Bartender',
      billing_type: 'per_hour', rate: 40, quantity: 1 },
    { id: 8, slug: 'barback', name: 'Barback', billing_type: 'per_staff', rate: 30, quantity: 1 },
  ];
  const snap = calculateProposal(base({ gratuityRate: 25, addons }));
  assert.strictEqual(snap.gratuity.staff_count, 2); // 1 auto + 1 addon, barback NOT counted
  assert.strictEqual(snap.breakdown.find(l => l.label === 'Gratuity').amount, 200);
});

test('numBartenders override is not double-counted', () => {
  const snap = calculateProposal(base({ guestCount: 250, numBartenders: 3, gratuityRate: 10 }));
  assert.strictEqual(snap.gratuity.staff_count, 3);
});

test('class package uses the instructor noun; forced surcharge still class-exempt', () => {
  const snap = calculateProposal({ pkg: CLASS, guestCount: 12, durationHours: 2,
    numBars: 0, addons: [], syrupSelections: [], gratuityRate: 30 });
  assert.strictEqual(snap.staff_noun, 'instructor');
  assert.strictEqual(snap.gratuity.staff_noun, 'instructor');
  assert.ok(!snap.breakdown.some(l => l.label === 'Shared Gratuity'));
});

test('coexists with the forced Shared Gratuity line', () => {
  const addons = [{ id: 9, slug: 'additional-bartender', name: 'Additional Bartender',
    billing_type: 'per_hour', rate: 40, quantity: 1 }];
  const snap = calculateProposal(base({ guestCount: 40, gratuityRate: 25, addons }));
  assert.ok(snap.breakdown.some(l => l.label === 'Shared Gratuity'));
  assert.ok(snap.breakdown.some(l => l.label === 'Gratuity'));
});

test('snapshot freezes staff_noun + display_labels', () => {
  const snap = calculateProposal(base({ gratuityRate: 25 }));
  assert.strictEqual(snap.staff_noun, 'bartender');
  assert.strictEqual(snap.display_labels['Shared Gratuity'], 'Staffing Gratuity');
  assert.strictEqual(snap.display_labels['Gratuity'], 'Gratuity');
});

test('gratuity is added on top of a total_price_override (DD #2)', () => {
  const snap = calculateProposal(base({ gratuityRate: 25, totalPriceOverride: 500 }));
  assert.strictEqual(snap.total, 600); // 500 override + 100 gratuity
});

test('getStaffNoun', () => {
  assert.strictEqual(getStaffNoun(BYOB), 'bartender');
  assert.strictEqual(getStaffNoun(CLASS), 'instructor');
  assert.strictEqual(getStaffNoun(null), 'bartender');
});

test('gratuityLineAmount rounds to cents; 0 on degenerate inputs', () => {
  assert.strictEqual(gratuityLineAmount(25, 2, 4), 200);
  assert.strictEqual(gratuityLineAmount(0, 2, 4), 0);
  assert.strictEqual(gratuityLineAmount(25, 0, 4), 0);
  assert.strictEqual(gratuityLineAmount(25, 1, 0), 0);
});

test('deriveGratuityRate: jar kept allows >= 0; derives rate from the entered total', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 0, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 0 });
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 200, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 50 });
});

test('deriveGratuityRate: no-jar enforces the >= $50/staff/hr floor', () => {
  const floorTotal = GRATUITY_FLOOR_RATE * 1 * 4; // 200
  const below = deriveGratuityRate({ enteredTotal: floorTotal - 1, staffCount: 1, hours: 4, tipJar: false });
  assert.strictEqual(below.ok, false);
  assert.strictEqual(below.code, 'GRATUITY_BELOW_FLOOR');
  const ok = deriveGratuityRate({ enteredTotal: floorTotal, staffCount: 1, hours: 4, tipJar: false });
  assert.deepStrictEqual(ok, { ok: true, rate: 50 });
});

test('deriveGratuityRate: rejects NaN/negative/Infinity/absurd', () => {
  assert.strictEqual(deriveGratuityRate({ enteredTotal: -5, staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 'abc', staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: Infinity, staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 9_999_999, staffCount: 1, hours: 4, tipJar: true }).ok, false);
});

test('deriveGratuityRate: degenerate crew/hours coerces rate to 0', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 500, staffCount: 0, hours: 4, tipJar: false }),
    { ok: true, rate: 0 });
});

test('recomputeSnapshotGratuity surgically replaces only the Gratuity line', () => {
  const snap0 = calculateProposal(base({ gratuityRate: 25 }));
  const before = JSON.parse(JSON.stringify(snap0));
  const snap1 = recomputeSnapshotGratuity(snap0, { gratuityRate: 50, tipJar: true, staffNoun: 'bartender', durationHours: 4 });
  assert.strictEqual(snap1.breakdown.filter(l => l.label === 'Gratuity').length, 1);
  assert.strictEqual(snap1.breakdown.find(l => l.label === 'Gratuity').amount, 200);
  assert.strictEqual(snap1.total, Math.round((before.total - 100 + 200) * 100) / 100);
  assert.strictEqual(snap0.breakdown.find(l => l.label === 'Gratuity').amount, 100); // input not mutated
});

test('gratuityBasisFromSnapshot prefers frozen staff_count, falls back to staffing+addons', () => {
  const snap = calculateProposal(base({ gratuityRate: 25 }));
  assert.deepStrictEqual(gratuityBasisFromSnapshot(snap, 4), { staffCount: 1, hours: 4 });
  const legacy = { staffing: { actual: 2 }, addons: [{ slug: 'additional-bartender', quantity: 8 }] };
  assert.deepStrictEqual(gratuityBasisFromSnapshot(legacy, 4), { staffCount: 4, hours: 4 });
});

test('computeGratuityBasis matches the engine count', () => {
  assert.deepStrictEqual(
    computeGratuityBasis({ pkg: BYOB, guestCount: 100, durationHours: 4, numBartenders: null, addons: [] }),
    { staffCount: 1, hours: 4 }
  );
});

// ─── P4 (fix #8): hosted 25-guest billing minimum + $550 backstop ────────────
// Non-class per_guest packages bill at max(actualGuests, min_billed_guests=25)
// heads, then clamp to the $550 floor. The rate TIER stays keyed on ACTUAL
// guests; staffing / gratuity surcharges stay on ACTUAL guests (HOSTED PACKAGE
// RULE). Snapshot exposes billed_guests + floor_reason ('guest_min'|'dollar_min'|null).
const HOSTED_FULLBAR = { // Base Compound-like: standard $18/g, small $23/g, extra $5/g
  id: 20, slug: 'the-base-compound', name: 'Base Compound', category: 'hosted',
  pricing_type: 'per_guest', bar_type: 'full_bar',
  base_rate_4hr: 18, base_rate_4hr_small: 23, extra_hour_rate: 5, extra_hour_rate_small: 5,
  min_guests: 50, min_billed_guests: 25, min_total: 550,
  bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40,
  first_bar_fee: 50, additional_bar_fee: 100,
};
const HOSTED_MOCKTAIL = { // Clear Reaction-like: standard $14/g, small $18/g
  ...HOSTED_FULLBAR, id: 21, slug: 'the-clear-reaction', name: 'Clear Reaction', bar_type: 'mocktail',
  base_rate_4hr: 14, base_rate_4hr_small: 18, extra_hour_rate: 4, extra_hour_rate_small: 4,
};
const HOSTED_CLASS = { // class: floors are NULL, math unchanged
  ...HOSTED_FULLBAR, id: 22, slug: 'mixology-101', name: 'Cocktail Class', bar_type: 'class',
  base_rate_4hr: 100, base_rate_4hr_small: 100, min_guests: 8,
  min_billed_guests: null, min_total: null,
};

const P4_CASES = [
  { name: '10 guests full-bar 4hr -> billed 25 heads, guest_min, $575',
    pkg: HOSTED_FULLBAR, guestCount: 10, durationHours: 4,
    expectBase: 575, expectBilled: 25, expectReason: 'guest_min' },
  { name: '20 guests full-bar 6hr -> billed 25 + extra-hour on 25, guest_min, $825',
    pkg: HOSTED_FULLBAR, guestCount: 20, durationHours: 6,
    expectBase: 825, expectBilled: 25, expectReason: 'guest_min' },
  { name: '27 guests mocktail 4hr -> $486 clamped to $550, dollar_min',
    pkg: HOSTED_MOCKTAIL, guestCount: 27, durationHours: 4,
    expectBase: 550, expectBilled: 27, expectReason: 'dollar_min' },
  { name: '40 guests mocktail 4hr -> $720, above both floors, null',
    pkg: HOSTED_MOCKTAIL, guestCount: 40, durationHours: 4,
    expectBase: 720, expectBilled: 40, expectReason: null },
  { name: '60 guests full-bar 4hr -> standard rate on 60, no floor, null',
    pkg: HOSTED_FULLBAR, guestCount: 60, durationHours: 4,
    expectBase: 1080, expectBilled: 60, expectReason: null },
  { name: 'class 8 guests 2hr -> unchanged math, no floor, null',
    pkg: HOSTED_CLASS, guestCount: 8, durationHours: 2,
    expectBase: 800, expectBilled: 8, expectReason: null },
];

for (const c of P4_CASES) {
  test(`P4 base+floor: ${c.name}`, () => {
    const snap = calculateProposal({
      pkg: c.pkg, guestCount: c.guestCount, durationHours: c.durationHours,
      numBars: 0, addons: [], syrupSelections: [], gratuityRate: 0, tipJar: true,
    });
    assert.strictEqual(snap.package.base_cost, c.expectBase, 'base_cost');
    assert.strictEqual(snap.billed_guests, c.expectBilled, 'billed_guests');
    assert.strictEqual(snap.floor_reason, c.expectReason, 'floor_reason');
    assert.strictEqual(snap.floor_applied, c.expectReason !== null, 'floor_applied');
  });
}

test('P4 staffing + gratuity surcharge stay keyed on ACTUAL guests, not billed guests', () => {
  const addons = [{ id: 9, slug: 'additional-bartender', name: 'Additional Bartender',
    billing_type: 'per_hour', rate: 40, quantity: 1 }];
  const snap = calculateProposal({
    pkg: HOSTED_FULLBAR, guestCount: 10, durationHours: 4,
    numBars: 0, addons, syrupSelections: [], gratuityRate: 0, tipJar: true,
  });
  // Base bills 25 heads while the snapshot preserves the ACTUAL 10 in inputs.
  assert.strictEqual(snap.billed_guests, 25);
  assert.strictEqual(snap.inputs.guestCount, 10);
  assert.strictEqual(snap.package.base_cost, 575);
  // Staffing required is computed from ACTUAL 10 guests -> 1 bartender (NOT ceil(25/100)).
  assert.strictEqual(snap.staffing.required, 1);
  assert.strictEqual(snap.staffing.actual, 1);
  // The additional-bartender over-ratio gratuity surcharge tier is keyed on ACTUAL
  // guests (<50 -> $50/hr), proving the 1:100 rule reads actual, not billed, guests.
  const addonRow = snap.addons.find(a => a.slug === 'additional-bartender');
  assert.strictEqual(addonRow.gratuity_per_hour, 50);
});
