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
