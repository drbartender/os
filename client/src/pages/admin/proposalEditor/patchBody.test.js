import { buildProposalPatchBody } from './patchBody';

// A representative filled form, shaped like initialFormFromProposal output.
const form = {
  event_date: '2026-08-08',
  event_start_time: '17:00',
  event_duration_hours: '5',
  venue_name: 'BrighterDaze Farm',
  venue_street: '1 Farm Rd',
  venue_city: 'Newark',
  venue_state: 'IL',
  venue_zip: '60541',
  guest_count: '75',
  package_id: '3',
  num_bars: '1',
  addon_ids: [7, '9'],
  addon_variants: { 7: 'non-alcoholic-bubbles' },
  addon_quantities: { 9: 3 },
  syrup_selections: [{ id: 1 }],
  adjustments: [{ type: 'discount', amount: 50 }],
  total_price_override: null,
  client_provides_glassware: false,
  class_options: { spirit_category: 'whiskey_bourbon', top_shelf_requested: true },
  setup_minutes_before: '',
};

describe('buildProposalPatchBody', () => {
  it('always includes addon_quantities (the EventEditForm latent-reset regression)', () => {
    const body = buildProposalPatchBody(form, {});
    expect(body.addon_quantities).toEqual({ 9: 3 });
  });

  it('coerces numerics and maps addon_ids to numbers', () => {
    const body = buildProposalPatchBody(form, {});
    expect(body.guest_count).toBe(75);
    expect(body.package_id).toBe(3);
    expect(body.num_bars).toBe(1);
    expect(body.event_duration_hours).toBe(5);
    expect(body.addon_ids).toEqual([7, 9]);
  });

  it('never includes gratuity keys (election-at-payment)', () => {
    const body = buildProposalPatchBody({ ...form, tip_jar: false, gratuity_total: 400 });
    expect('tip_jar' in body).toBe(false);
    expect('gratuity_total' in body).toBe(false);
  });

  it('sends class_options only for class packages, null otherwise', () => {
    expect(buildProposalPatchBody(form, {}).class_options).toBeNull();
    expect(buildProposalPatchBody(form, { isClassPackage: true }).class_options)
      .toEqual(form.class_options);
  });

  it('maps setup_minutes_before blank to null, value to number', () => {
    expect(buildProposalPatchBody(form, {}).setup_minutes_before).toBeNull();
    expect(buildProposalPatchBody({ ...form, setup_minutes_before: '45' }, {}).setup_minutes_before).toBe(45);
  });

  it('omits notify keys without staffNotify, gates sub-flags with it', () => {
    const without = buildProposalPatchBody(form, {});
    expect('notify_assigned_staff' in without).toBe(false);
    const withNotify = buildProposalPatchBody(form, { staffNotify: { enabled: true, sms: false, email: true } });
    expect(withNotify.notify_assigned_staff).toBe(true);
    expect(withNotify.notify_staff_sms).toBe(false);
    expect(withNotify.notify_staff_email).toBe(true);
    const off = buildProposalPatchBody(form, { staffNotify: { enabled: false, sms: true, email: true } });
    expect(off.notify_assigned_staff).toBe(false);
    expect(off.notify_staff_sms).toBe(false);
    expect(off.notify_staff_email).toBe(false);
  });

  it('includes change_request_id only when provided', () => {
    expect('change_request_id' in buildProposalPatchBody(form, {})).toBe(false);
    expect(buildProposalPatchBody(form, { changeRequestId: 12 }).change_request_id).toBe(12);
  });

  it('passes glassware as a real boolean', () => {
    expect(buildProposalPatchBody(form, {}).client_provides_glassware).toBe(false);
    expect(buildProposalPatchBody({ ...form, client_provides_glassware: 1 }, {}).client_provides_glassware).toBe(true);
  });
});

describe('gratuity mandate key (spec 2026-08-10)', () => {
  it('emits gratuity_mandate_total only when includeGratuityMandate is true', () => {
    const body = buildProposalPatchBody({ ...form, gratuity_mandate_total: 100 }, { includeGratuityMandate: true });
    expect(body.gratuity_mandate_total).toBe(100);
  });

  it('emits an explicit null clear when included', () => {
    const body = buildProposalPatchBody({ ...form, gratuity_mandate_total: null }, { includeGratuityMandate: true });
    expect(Object.prototype.hasOwnProperty.call(body, 'gratuity_mandate_total')).toBe(true);
    expect(body.gratuity_mandate_total).toBe(null);
  });

  it('omits the key entirely when includeGratuityMandate is false (carry-forward path)', () => {
    const body = buildProposalPatchBody({ ...form, gratuity_mandate_total: 100 }, { includeGratuityMandate: false });
    expect(Object.prototype.hasOwnProperty.call(body, 'gratuity_mandate_total')).toBe(false);
  });

  it('omits the key by default (untouched forms rescale server-side at the canonical rate)', () => {
    const body = buildProposalPatchBody({ ...form, gratuity_mandate_total: 100 }, {});
    expect(Object.prototype.hasOwnProperty.call(body, 'gratuity_mandate_total')).toBe(false);
  });

  it('still never contains tip_jar or gratuity_total keys', () => {
    const body = buildProposalPatchBody({ ...form, gratuity_mandate_total: 100 }, { includeGratuityMandate: true });
    expect(Object.prototype.hasOwnProperty.call(body, 'tip_jar')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'gratuity_total')).toBe(false);
  });
});
