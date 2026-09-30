'use strict';
// The proposal page shows a client what added time costs on their booking, and
// agreement v4 Section 8.1 points them at that number. It has to be the figure
// the on-site extension bills, so every priced case here is also checked
// against extraHourCharge, the function the extension bills with.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { additionalTimeRate } = require('./additionalTimeRate');
const { extraHourCharge } = require('./pricingEngine');

// Rows shaped as pg returns them: NUMERIC columns arrive as strings. Values are
// the prod catalog as read 2026-09-29.
const core = {
  pricing_type: 'flat', bar_type: 'service_only',
  extra_hour_rate: '100.00', extra_hour_rate_small: null,
  min_guests: null, min_billed_guests: null,
};
const carbon = {
  pricing_type: 'per_guest', bar_type: 'beer_and_wine',
  extra_hour_rate: '5.75', extra_hour_rate_small: '5.75',
  min_guests: 50, min_billed_guests: 25,
};
const primary = {
  pricing_type: 'per_guest', bar_type: 'beer_and_wine',
  extra_hour_rate: '4.00', extra_hour_rate_small: '4.00',
  min_guests: 50, min_billed_guests: 25,
};
const mixology = {
  pricing_type: 'per_guest', bar_type: 'class',
  extra_hour_rate: '0.00', extra_hour_rate_small: '0.00',
  min_guests: 8, min_billed_guests: null,
};

test('a flat package shows its hourly rate and no per-guest figures', () => {
  assert.deepEqual(additionalTimeRate(core, 160), {
    hourly: 100, per_guest_rate: null, billed_guests: null,
  });
});

test('a flat package does not need a guest count', () => {
  assert.deepEqual(additionalTimeRate(core, null), {
    hourly: 100, per_guest_rate: null, billed_guests: null,
  });
});

test('a hosted package shows the per-guest rate times the billed guests', () => {
  assert.deepEqual(additionalTimeRate(carbon, 100), {
    hourly: 575, per_guest_rate: 5.75, billed_guests: 100,
  });
});

test('a small hosted booking is billed at the guest minimum, and says so', () => {
  assert.deepEqual(additionalTimeRate(primary, 20), {
    hourly: 100, per_guest_rate: 4, billed_guests: 25,
  });
});

test('the small-event tier uses its own extra-hour rate when it has one', () => {
  const tiered = { ...carbon, extra_hour_rate: '6.00', extra_hour_rate_small: '7.00' };
  assert.deepEqual(additionalTimeRate(tiered, 40), {
    hourly: 280, per_guest_rate: 7, billed_guests: 40,
  });
  assert.deepEqual(additionalTimeRate(tiered, 60), {
    hourly: 360, per_guest_rate: 6, billed_guests: 60,
  });
});

test('nothing to show: a class, a zero rate, no package, or no guests on a hosted package', () => {
  assert.equal(additionalTimeRate(mixology, 12), null);
  assert.equal(additionalTimeRate({ ...core, extra_hour_rate: '0.00' }, 100), null);
  assert.equal(additionalTimeRate({ ...core, extra_hour_rate: null }, 100), null);
  assert.equal(additionalTimeRate({ ...carbon, extra_hour_rate: '0.00', extra_hour_rate_small: '0.00' }, 100), null);
  assert.equal(additionalTimeRate(null, 100), null);
  assert.equal(additionalTimeRate(undefined, 100), null);
  // The payload LEFT JOINs the package, so a proposal without one yields a row
  // of nulls rather than no row.
  assert.equal(additionalTimeRate({ pricing_type: null, bar_type: null, extra_hour_rate: null }, 100), null);
  assert.equal(additionalTimeRate(carbon, 0), null);
  assert.equal(additionalTimeRate(carbon, null), null);
});

test('the figure shown is the figure the on-site extension bills for one hour', () => {
  const cases = [
    [core, 160], [core, 40],
    [carbon, 100], [carbon, 33], [carbon, 20],
    [primary, 20], [primary, 25], [primary, 49], [primary, 50], [primary, 250],
  ];
  for (const [pkg, guests] of cases) {
    const shown = additionalTimeRate(pkg, guests);
    const billed = Math.round(extraHourCharge(pkg, guests, 1) * 100) / 100;
    assert.equal(shown.hourly, billed, `${pkg.bar_type} at ${guests} guests`);
    if (shown.per_guest_rate !== null) {
      assert.equal(
        Math.round(shown.per_guest_rate * shown.billed_guests * 100) / 100, billed,
        `${pkg.bar_type} at ${guests} guests: the parts multiply to the hourly`
      );
    }
  }
});

// The test above proves the figure matches extraHourCharge, which the module
// itself calls, so it cannot catch a divergence from what the extension
// actually bills. This one reproduces the extension's package-line arithmetic
// from serviceExtensionPricing.js (the LARGER of the catalog's own difference
// between the two durations and extraHourCharge for the added hours) with
// calculateProposal legs, and sweeps every package shape in the prod catalog.
// If a package ever gets a 3-hour rate, this is the test that goes red.
const { calculateProposal } = require('./pricingEngine');

const base = { guests_per_bartender: 100, bartenders_included: 1, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100 };
const leg = (pkg, guestCount, durationHours) => calculateProposal({
  pkg, guestCount, durationHours, numBars: 0, numBartenders: null,
  addons: [], syrupSelections: [], adjustments: [], totalPriceOverride: null,
});
const toCents = (d) => Math.round(Number(d) * 100);

test('hourly x added hours is the package line the extension bills, for every catalog shape', () => {
  const shapes = [
    { ...base, ...core, id: 1, slug: 'core', name: 'Core', category: 'byob', base_rate_3hr: null, base_rate_4hr: '350.00' },
    { ...base, ...carbon, id: 2, slug: 'carbon', name: 'Carbon', category: 'hosted', base_rate_3hr: null, base_rate_4hr: '15.00', base_rate_4hr_small: '20.00', min_total: '550.00' },
    { ...base, ...primary, id: 3, slug: 'primary', name: 'Primary', category: 'hosted', base_rate_3hr: null, base_rate_4hr: '12.00', base_rate_4hr_small: '17.00', min_total: '550.00' },
    { ...base, ...carbon, id: 4, slug: 'grand', name: 'Grand', category: 'hosted', bar_type: 'full_bar', base_rate_3hr: null, base_rate_4hr: '40.00', base_rate_4hr_small: '46.00', extra_hour_rate: '11.25', extra_hour_rate_small: '11.25', min_total: '550.00' },
  ];
  let cases = 0;
  for (const pkg of shapes) {
    for (const guests of [20, 25, 30, 49, 50, 75, 100, 160, 250]) {
      const shown = additionalTimeRate(pkg, guests);
      assert.ok(shown, `${pkg.slug} at ${guests} guests shows a line`);
      for (const booked of [2, 3, 4, 5, 6]) {
        for (const added of [0.5, 1, 1.5, 2, 3]) {
          const before = leg(pkg, guests, booked);
          const after = leg(pkg, guests, booked + added);
          const catalogDeltaCents = toCents(after.package.base_cost) - toCents(before.package.base_cost);
          const extraHourCents = toCents(extraHourCharge(pkg, guests, added));
          const billedCents = catalogDeltaCents + Math.max(0, extraHourCents - catalogDeltaCents);
          assert.equal(
            toCents(shown.hourly * added), billedCents,
            `${pkg.slug}, ${guests} guests, ${booked}h + ${added}h: page implies ${shown.hourly * added}, extension bills ${billedCents / 100}`
          );
          cases += 1;
        }
      }
    }
  }
  assert.ok(cases >= 900, `swept ${cases} cases`);
});

test('a class never bills a package line, and never shows one', () => {
  const klass = { ...base, ...mixology, id: 5, slug: 'mixology', name: 'Mixology', category: 'hosted', base_rate_3hr: null, base_rate_4hr: '35.00', base_rate_4hr_small: '35.00', min_total: null, first_bar_fee: 0, additional_bar_fee: 0 };
  for (const guests of [8, 12, 20]) {
    assert.equal(additionalTimeRate(klass, guests), null);
    const before = leg(klass, guests, 2);
    const after = leg(klass, guests, 3);
    assert.equal(toCents(after.package.base_cost) - toCents(before.package.base_cost), 0);
    assert.equal(toCents(extraHourCharge(klass, guests, 1)), 0);
  }
});
