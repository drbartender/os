import { recoverAddonQuantities } from './ProposalDetailEditForm';

// recoverAddonQuantities inverts pricingEngine's count→quantity transforms to
// recover the raw 1–10 stepper count for a loaded proposal's add-ons. These
// tests pin the round-trip and guard the rate-drift regression: the inversion
// must use the PERSISTED proposal_addons.rate / .quantity, never the live
// catalog row (catalog rates change over a proposal's lifetime).
//
// Forward transforms (server/utils/pricingEngine.js):
//   additional-bartender : quantity = durationHours × count
//   per_hour             : quantity = max(durationHours, minimum_hours) × count
//   per_guest            : quantity = guestCount; line_total = guestCount × rate × count
//
// pg returns numeric columns as strings, so persisted fields are written as
// strings here to mirror the real /proposals GET response.

// --- catalog (the /proposals/addons response) -----------------------------
// Quantity-capable slugs: banquet-server, barback, pre-batched-mocktail,
// additional-bartender (see client/src/utils/proposalRules.js).
const catalog = [
  { id: 100, slug: 'additional-bartender', billing_type: 'per_hour', rate: 40, minimum_hours: 0 },
  { id: 101, slug: 'barback',              billing_type: 'per_hour', rate: 35, minimum_hours: 4 },
  { id: 102, slug: 'banquet-server',       billing_type: 'per_hour', rate: 38, minimum_hours: 4 },
  // pre-batched-mocktail: catalog rate has DRIFTED to $2.00 (seeded at $1.50).
  { id: 103, slug: 'pre-batched-mocktail', billing_type: 'per_guest', rate: 2.0, minimum_hours: 0 },
  // a non-quantity-capable addon — must be ignored entirely
  { id: 104, slug: 'real-glassware',       billing_type: 'flat', rate: 150, minimum_hours: 0 },
];

// Forward transforms — hand-mirroring pricingEngine so the test is independent
// of importing the server module into a CRA Jest run.
const fwdAdditionalBartender = (count, durationHours) => durationHours * count;
const fwdPerHour = (count, durationHours, minHours) =>
  Math.max(durationHours, minHours) * count;
const fwdPerGuestLineTotal = (count, guestCount, rate) => guestCount * rate * count;

describe('recoverAddonQuantities — round-trip', () => {
  test('additional-bartender: recovers count from durationHours × count', () => {
    const durationHours = 5;
    const count = 3;
    const rows = [{
      addon_id: 100,
      billing_type: 'per_hour',
      rate: '40.00',
      quantity: String(fwdAdditionalBartender(count, durationHours)), // '15'
      line_total: String(count * durationHours * 40),
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours, guestCount: 120 });
    expect(out[100]).toBe(3);
  });

  test('per_hour barback: recovers count using effectiveHours = max(dh, minimum_hours)', () => {
    // durationHours 3 < minimum_hours 4 → effectiveHours = 4
    const durationHours = 3;
    const count = 2;
    const rows = [{
      addon_id: 101,
      billing_type: 'per_hour',
      rate: '35.00',
      quantity: String(fwdPerHour(count, durationHours, 4)), // 4 × 2 = '8'
      line_total: String(fwdPerHour(count, durationHours, 4) * 35),
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours, guestCount: 80 });
    expect(out[101]).toBe(2);
  });

  test('per_hour banquet-server: recovers count when durationHours > minimum_hours', () => {
    const durationHours = 6; // > minimum_hours 4 → effectiveHours = 6
    const count = 4;
    const rows = [{
      addon_id: 102,
      billing_type: 'per_hour',
      rate: '38.00',
      quantity: String(fwdPerHour(count, durationHours, 4)), // 6 × 4 = '24'
      line_total: String(fwdPerHour(count, durationHours, 4) * 38),
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours, guestCount: 200 });
    expect(out[102]).toBe(4);
  });

  test('per_guest with NO rate drift: recovers count from line_total / (quantity × rate)', () => {
    const guestCount = 150;
    const count = 2;
    const rows = [{
      addon_id: 103,
      billing_type: 'per_guest',
      rate: '2.00', // persisted rate equals current catalog rate here
      quantity: String(guestCount), // per_guest persists guestCount as quantity
      line_total: String(fwdPerGuestLineTotal(count, guestCount, 2.0)),
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount });
    expect(out[103]).toBe(2);
  });
});

describe('recoverAddonQuantities — rate-drift regression (the Important bug)', () => {
  // The proposal was created when pre-batched-mocktail cost $1.50; the catalog
  // row now reads $2.00. The persisted line_total was computed at $1.50. The
  // inversion MUST divide by the persisted row.rate (1.50), not the catalog's
  // current 2.00. Buggy code (catalog rate) → recovered count is wrong and the
  // proposal silently re-prices on save.
  test('uses persisted row.rate (1.50), not the drifted catalog rate (2.00)', () => {
    const guestCount = 150;
    const count = 3;
    const persistedRate = 1.5; // creation-time rate
    const rows = [{
      addon_id: 103, // catalog rate for this id is 2.00 — drifted
      billing_type: 'per_guest',
      rate: '1.50',
      quantity: String(guestCount),
      line_total: String(fwdPerGuestLineTotal(count, guestCount, persistedRate)), // 150×1.5×3 = '675'
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount });
    // Correct: 675 / (150 × 1.50) = 3. Buggy: 675 / (150 × 2.00) = 2.25 → round 2.
    expect(out[103]).toBe(3);
  });

  test('inversion is independent of the form\'s current guest_count', () => {
    // persisted quantity (creation-time guest count) is 100, but the form's
    // current guest_count has since been edited to 250. Recovery must use the
    // persisted quantity, so the count comes out unchanged.
    const creationGuestCount = 100;
    const count = 5;
    const rows = [{
      addon_id: 103,
      billing_type: 'per_guest',
      rate: '1.50',
      quantity: String(creationGuestCount),
      line_total: String(fwdPerGuestLineTotal(count, creationGuestCount, 1.5)),
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount: 250 });
    expect(out[103]).toBe(5);
  });
});

describe('recoverAddonQuantities — defensive / edge cases', () => {
  test('per_guest with zero persisted rate recovers to default (omitted, no throw)', () => {
    const rows = [{
      addon_id: 103,
      billing_type: 'per_guest',
      rate: '0',
      quantity: '150',
      line_total: '450',
    }];
    let out;
    expect(() => {
      out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount: 150 });
    }).not.toThrow();
    expect(out[103]).toBeUndefined(); // omitted → stepper defaults to 1
  });

  test('per_guest with zero persisted quantity recovers to default (no divide-by-zero)', () => {
    const rows = [{
      addon_id: 103,
      billing_type: 'per_guest',
      rate: '2.00',
      quantity: '0',
      line_total: '0',
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount: 150 });
    expect(out[103]).toBeUndefined();
  });

  test('additional-bartender with zero durationHours recovers to default', () => {
    const rows = [{
      addon_id: 100,
      billing_type: 'per_hour',
      rate: '40.00',
      quantity: '15',
      line_total: '0',
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 0, guestCount: 120 });
    expect(out[100]).toBeUndefined();
  });

  test('non-quantity-capable addon rows are ignored', () => {
    const rows = [{
      addon_id: 104, // real-glassware — flat, not quantity-capable
      billing_type: 'flat',
      rate: '150.00',
      quantity: '1',
      line_total: '150',
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount: 100 });
    expect(out).toEqual({});
  });

  test('unknown addon_id (not in catalog) is skipped without throwing', () => {
    const rows = [{
      addon_id: 999,
      billing_type: 'per_guest',
      rate: '2.00',
      quantity: '100',
      line_total: '400',
    }];
    let out;
    expect(() => {
      out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount: 100 });
    }).not.toThrow();
    expect(out).toEqual({});
  });

  test('recovered count is clamped to the 1–10 stepper range', () => {
    // A pathological line_total that inverts to > 10 must clamp to 10.
    const guestCount = 100;
    const rows = [{
      addon_id: 103,
      billing_type: 'per_guest',
      rate: '2.00',
      quantity: String(guestCount),
      line_total: String(fwdPerGuestLineTotal(25, guestCount, 2.0)), // count 25
    }];
    const out = recoverAddonQuantities(rows, catalog, { durationHours: 4, guestCount });
    expect(out[103]).toBe(10);
  });

  test('empty / null inputs return an empty map without throwing', () => {
    expect(recoverAddonQuantities([], catalog, { durationHours: 4, guestCount: 100 })).toEqual({});
    expect(recoverAddonQuantities(null, catalog, { durationHours: 4, guestCount: 100 })).toEqual({});
    expect(recoverAddonQuantities(null, null, { durationHours: 4, guestCount: 100 })).toEqual({});
  });
});
