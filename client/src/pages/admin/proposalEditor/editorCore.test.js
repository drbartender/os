import '@testing-library/jest-dom';
import {
  detectNumBartendersOverride, storedGratuityOf, mandateLockedFor, isClassPackageFor, buildCalculateBody,
} from './editorCore';

const pkg = { id: 1, guests_per_bartender: 100, bar_type: 'service_only' };

describe('detectNumBartendersOverride', () => {
  test('no stored count is no override', () => {
    expect(detectNumBartendersOverride({ num_bartenders: null, package_id: 1, guest_count: 100 }, [pkg])).toBeNull();
  });
  test('a retired package cannot be judged, so nothing travels', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 3, package_id: 9, guest_count: 100 }, [pkg])).toBeNull();
  });
  test('the ratio count is not an override', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 2, package_id: 1, guest_count: 150 }, [pkg])).toBeNull();
  });
  test('a count off the ratio is the override, and travels', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 3, package_id: '1', guest_count: 150 }, [pkg])).toBe(3);
  });
  test('a package with no ratio counts 100 guests per bartender', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 1, package_id: 1, guest_count: 80 }, [{ id: 1 }])).toBeNull();
    expect(detectNumBartendersOverride({ num_bartenders: 2, package_id: 1, guest_count: 80 }, [{ id: 1 }])).toBe(2);
  });
});

test('storedGratuityOf reads the stored rate and jar, defaulting to no rate and the jar on', () => {
  expect(storedGratuityOf({ pricing_snapshot: { gratuity: { rate: '12.5', tip_jar: false } } })).toEqual({ rate: 12.5, tipJar: false });
  expect(storedGratuityOf({})).toEqual({ rate: 0, tipJar: true });
});

test('mandateLockedFor: paid, signed or accepted locks the mandate', () => {
  expect(mandateLockedFor({ amount_paid: '100' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', client_signed_at: '2026-01-01' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', status: 'accepted' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', client_signed_at: null, status: 'sent' })).toBe(false);
});

test('isClassPackageFor: the selected package decides, a retired one keeps the stored class options', () => {
  expect(isClassPackageFor({ bar_type: 'class' }, {})).toBe(true);
  expect(isClassPackageFor({ bar_type: 'service_only' }, { class_options: {} })).toBe(false);
  expect(isClassPackageFor(undefined, { class_options: { spirit_category: 'gin' } })).toBe(true);
  expect(isClassPackageFor(undefined, { class_options: null })).toBe(false);
});

describe('buildCalculateBody', () => {
  const form = {
    package_id: '3', guest_count: '75', event_duration_hours: '5', num_bars: '1',
    addon_ids: [7, '9'], addon_variants: { 7: 'x' }, addon_quantities: { 9: 3 },
    syrup_selections: [{ id: 1 }], adjustments: [{ type: 'discount', amount: 50 }],
    total_price_override: null, gratuity_mandate_total: 300,
  };
  test('the desktop body, field for field', () => {
    expect(buildCalculateBody(form, { proposalId: 42, tipJar: false, gratuityRate: 10 })).toEqual({
      proposal_id: 42, package_id: 3, guest_count: 75, duration_hours: 5, num_bars: 1,
      addon_ids: [7, 9], addon_variants: { 7: 'x' }, addon_quantities: { 9: 3 },
      syrup_selections: [{ id: 1 }], adjustments: [{ type: 'discount', amount: 50 }],
      total_price_override: null, tip_jar: false, gratuity_rate: 10,
    });
  });
  test('no proposal id, blank guests and duration fall back as the desktop preview does', () => {
    const body = buildCalculateBody({ ...form, guest_count: '', event_duration_hours: 0 }, {});
    expect(body).not.toHaveProperty('proposal_id');
    expect(body.guest_count).toBe(50);
    expect(body.duration_hours).toBe(4);
  });
  test('the override travels only when detected', () => {
    expect(buildCalculateBody(form, { numBartendersOverride: 3 }).num_bartenders).toBe(3);
    expect(buildCalculateBody(form, { numBartendersOverride: null })).not.toHaveProperty('num_bartenders');
  });
  test('the mandate rides only when included, and never as a transient 0 or blank', () => {
    expect(buildCalculateBody(form, { includeMandate: true }).gratuity_mandate_total).toBe(300);
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: null }, { includeMandate: true }).gratuity_mandate_total).toBeNull();
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: 0 }, { includeMandate: true })).not.toHaveProperty('gratuity_mandate_total');
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: '' }, { includeMandate: true })).not.toHaveProperty('gratuity_mandate_total');
    expect(buildCalculateBody(form, { includeMandate: false })).not.toHaveProperty('gratuity_mandate_total');
  });
});
