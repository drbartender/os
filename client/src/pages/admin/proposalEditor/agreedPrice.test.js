import { parseAgreedCents, applyAgreedPrice, previewServiceCentsOf } from './agreedPrice';

// Plan 2026-10-16 Task E3; spec section 5. The agreed price is the SERVICE
// total (before the client gratuity). Fixtures are synthetic.
const AP = (amount, type = 'discount', visible = false) =>
  ({ type, label: 'Agreed price adjustment', amount, visible, source: 'agreed_price' });

test('input rules', () => {
  for (const t of ['', ' ', 'abc', '-1', '1000000']) expect(parseAgreedCents(t).error).toBe('Enter a price of $0 or more');
  expect(parseAgreedCents('1,493.00')).toEqual({ cents: 149300, error: null });
  expect(parseAgreedCents('0')).toEqual({ cents: 0, error: null });
});
test('appends a hidden discount for a lower price', () => {
  const r = applyAgreedPrice({ adjustments: [], previewServiceCents: 165500, agreedCents: 149300 });
  expect(r.adjustments).toEqual([AP(162)]);
});
test('replaces its own line in place, keeping the admin visibility choice', () => {
  const start = [{ type: 'discount', label: 'Test other', amount: 10, visible: true }, AP(162, 'discount', true)];
  // preview already includes both lines: 165500 - 1000 - 16200 = 148300
  const r = applyAgreedPrice({ adjustments: start, previewServiceCents: 148300, agreedCents: 150000 });
  expect(r.adjustments).toEqual([start[0], AP(145, 'discount', true)]);
});
test('a higher price writes a surcharge; an equal price removes the line', () => {
  expect(applyAgreedPrice({ adjustments: [], previewServiceCents: 100000, agreedCents: 112500 }).adjustments)
    .toEqual([AP(125, 'surcharge')]);
  expect(applyAgreedPrice({ adjustments: [AP(50)], previewServiceCents: 95000, agreedCents: 100000 }).adjustments)
    .toEqual([]);
});
test('the replaced line takes the standard label back', () => {
  const renamed = { ...AP(162), label: 'Test renamed' };
  const r = applyAgreedPrice({ adjustments: [renamed], previewServiceCents: 149300, agreedCents: 140000 });
  expect(r.adjustments[0].label).toBe('Agreed price adjustment');
});
test('refuses to guess across the zero clamp', () => {
  for (const line of [AP(500), AP(5, 'surcharge')]) {
    const r = applyAgreedPrice({ adjustments: [line], previewServiceCents: 0, agreedCents: 10000 });
    expect(r.error).toMatch(/Remove the agreed price line/);
  }
});

// ─── beyond the plan's list ─────────────────────────────────────────────────
test('input: $, commas and spaces are stripped; cents are exact; more than two decimals is no price', () => {
  expect(parseAgreedCents('$1,493')).toEqual({ cents: 149300, error: null });
  expect(parseAgreedCents(' 1 493.5 ')).toEqual({ cents: 149350, error: null });
  expect(parseAgreedCents('0.29')).toEqual({ cents: 29, error: null }); // 0.29 * 100 is 28.999... in floats
  expect(parseAgreedCents('999999.99')).toEqual({ cents: 99999999, error: null });
  for (const t of ['12.345', '1e3', '0x10', '.', '1.2.3', null, undefined]) {
    expect(parseAgreedCents(t)).toEqual({ cents: null, error: 'Enter a price of $0 or more' });
  }
});

test('a refusal leaves the lines exactly as they were', () => {
  const lines = [AP(500)];
  const r = applyAgreedPrice({ adjustments: lines, previewServiceCents: 0, agreedCents: 10000 });
  expect(r.adjustments).toBe(lines);
  expect(applyAgreedPrice({ adjustments: [], previewServiceCents: 100000, agreedCents: 100000 }))
    .toEqual({ adjustments: [], error: null });
});

test('a $0 preview with an ordinary discount and no agreed line refuses too: the clamp hides how far below $0 it is', () => {
  const lines = [{ type: 'discount', label: 'Test big discount', amount: 2000, visible: true }];
  const r = applyAgreedPrice({ adjustments: lines, previewServiceCents: 0, agreedCents: 50000 });
  expect(r.error).toMatch(/discounts already take this booking to \$0/i);
  expect(r.adjustments).toBe(lines);
  // With nothing that could push it below $0, a $0 preview is exact.
  expect(applyAgreedPrice({ adjustments: [], previewServiceCents: 0, agreedCents: 50000 }).adjustments)
    .toEqual([AP(500, 'surcharge')]);
});

test('an agreed surcharge above an under-$0 base still lands exactly (no clamp at a positive preview)', () => {
  // Others net -100 below the subtotal; a 150 surcharge brings the preview to 50.
  const r = applyAgreedPrice({ adjustments: [AP(150, 'surcharge')], previewServiceCents: 5000, agreedCents: 20000 });
  expect(r.adjustments).toEqual([AP(300, 'surcharge')]);
});

test('previewServiceCentsOf is the preview total less the client gratuity, in cents', () => {
  expect(previewServiceCentsOf({ total: 1655.5, gratuity: { total: 120 } })).toBe(153550);
  expect(previewServiceCentsOf({ total: 1493 })).toBe(149300);
  expect(previewServiceCentsOf({ total: '1493.00', gratuity: { total: '0' } })).toBe(149300);
  expect(previewServiceCentsOf(null)).toBeNull();
  expect(previewServiceCentsOf({})).toBeNull();
  expect(previewServiceCentsOf({ total: 'x' })).toBeNull();
});
