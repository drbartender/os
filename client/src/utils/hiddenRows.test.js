import { hiddenRowFlags } from './hiddenRows';

// Fixtures are shaped like pricingEngine.calculateProposal output: the
// package and service rows first ('Shared Gratuity' inside staffing and the
// additional-bartender add-on), then one row per adjustment in order, then the
// client 'Gratuity' row last, only while snapshot.gratuity.total is above 0.
// Labels and amounts are synthetic.
const SERVICE_ROWS = [
  { label: 'BYOB Bar (4hrs, 60 guests)', amount: 1000 },
  { label: 'Bar Rental (1 bar)', amount: 50 },
  { label: 'Additional Bartender (1)', amount: 160 },
  { label: 'Shared Gratuity', amount: 100 },
];

describe('hiddenRowFlags', () => {
  test('(a) a new snapshot: each adjustment row uses its own visible', () => {
    const snapshot = {
      gratuity: { total: 200 },
      adjustments: [
        { type: 'discount', label: 'Test discount A', amount: 100, visible: true },
        { type: 'surcharge', label: '', amount: 40, visible: false },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Test discount A', amount: -100, visible: true },
        { label: 'Surcharge', amount: 40, visible: false },
        { label: 'Gratuity', amount: 200 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, false, true, false]);
  });

  test('(a) a row that carries visible wins over its line', () => {
    const snapshot = {
      adjustments: [{ type: 'discount', label: 'Test discount A', amount: 100, visible: false }],
      breakdown: [...SERVICE_ROWS, { label: 'Test discount A', amount: -100, visible: true }],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, false]);
  });

  test('(a) rows that carry visible are read even with no adjustments on the snapshot', () => {
    const snapshot = { breakdown: [...SERVICE_ROWS, { label: 'Test discount A', amount: -100, visible: false }] };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true]);
  });

  test('(b) an old snapshot: rows matched to the lines by label and signed cents; a missing visible reads hidden', () => {
    const snapshot = {
      gratuity: { total: 200 },
      adjustments: [
        { type: 'discount', label: 'Test discount A', amount: '100.00', visible: true },
        { type: 'surcharge', label: '', amount: 40, visible: false },
        { type: 'discount', label: 'Test discount B', amount: '12.5' },
        { type: 'weird', label: '', amount: '7' },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Test discount A', amount: -100 },
        { label: 'Surcharge', amount: 40 },
        { label: 'Test discount B', amount: -12.5 },
        { label: 'Surcharge', amount: 7 },
        { label: 'Gratuity', amount: 200 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, false, true, true, true, false]);
  });

  test('(b) an old line finer than a cent still finds its row (the engine row holds its raw dollars)', () => {
    const snapshot = {
      adjustments: [
        { type: 'discount', label: 'Test discount C', amount: 0.125, visible: false },
        { type: 'surcharge', label: 'Test surcharge D', amount: '3.335', visible: false },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Test discount C', amount: -0.125 },
        { label: 'Test surcharge D', amount: 3.335 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true, true]);
  });

  test('(c) a mixed snapshot: server-written rows use their own visible and the older hidden lines stay tagged', () => {
    // An old snapshot that later gained a Refund row and a converted line, each
    // written where the engine would put it (before the client Gratuity row).
    const snapshot = {
      gratuity: { total: 200 },
      adjustments: [
        { type: 'discount', label: 'Test hidden discount', amount: 40, visible: false },
        { type: 'surcharge', label: 'Test shown surcharge', amount: 25, visible: true },
        { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 7 },
        { type: 'discount', label: 'Agreed price adjustment', amount: 75, visible: false, source: 'agreed_price' },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Test hidden discount', amount: -40 },
        { label: 'Test shown surcharge', amount: 25 },
        { label: 'Refund', amount: -20, visible: true },
        { label: 'Agreed price adjustment', amount: -75, visible: false },
        { label: 'Gratuity', amount: 200 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true, false, false, true, false]);
  });

  test('(d) service rows are never flagged, Shared Gratuity rows included', () => {
    const snapshot = {
      gratuity: { total: 0 },
      adjustments: [
        { type: 'discount', label: 'Test hidden discount', amount: 40 },
        { type: 'surcharge', label: '', amount: 15 },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Additional Bartender (1)', amount: 160 },
        { label: 'Shared Gratuity', amount: 100 },
        { label: 'Test hidden discount', amount: -40 },
        { label: 'Surcharge', amount: 15 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, false, false, true, true]);
  });

  test('(d) a line that copies a service row\'s label and amount tags its own row, never the service row', () => {
    const snapshot = {
      adjustments: [
        { type: 'surcharge', label: 'Shared Gratuity', amount: 100, visible: false },
        { type: 'surcharge', label: 'Bar Rental (1 bar)', amount: 50 },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Shared Gratuity', amount: 100 },
        { label: 'Bar Rental (1 bar)', amount: 50 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true, true]);
  });

  test('(d) the client Gratuity row is never flagged, even beside a hidden line with its label and amount', () => {
    const snapshot = {
      gratuity: { total: 200 },
      adjustments: [{ type: 'surcharge', label: 'Gratuity', amount: 200, visible: false }],
      breakdown: [...SERVICE_ROWS, { label: 'Gratuity', amount: 200 }, { label: 'Gratuity', amount: 200 }],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true, false]);
  });

  test('(d) a last row labeled Gratuity with no client gratuity is the admin\'s own line', () => {
    const snapshot = {
      gratuity: { total: 0 },
      adjustments: [{ type: 'surcharge', label: 'Gratuity', amount: 80, visible: false }],
      breakdown: [...SERVICE_ROWS, { label: 'Gratuity', amount: 80 }],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true]);
  });

  test('a line whose row is gone (a gratuity re-quote drops every Gratuity row) leaves the others matched', () => {
    const snapshot = {
      gratuity: { total: 200 },
      adjustments: [
        { type: 'discount', label: 'Test hidden discount', amount: 40, visible: false },
        { type: 'surcharge', label: 'Gratuity', amount: 30, visible: true },
        { type: 'surcharge', label: 'Test hidden surcharge', amount: 10 },
      ],
      breakdown: [
        ...SERVICE_ROWS,
        { label: 'Test hidden discount', amount: -40 },
        { label: 'Test hidden surcharge', amount: 10 },
        { label: 'Gratuity', amount: 200 },
      ],
    };
    expect(hiddenRowFlags(snapshot)).toEqual([false, false, false, false, true, true, false]);
  });

  test('missing or malformed snapshots never throw', () => {
    for (const snapshot of [null, undefined, {}, 'not json', { breakdown: 'x' }, { breakdown: null, adjustments: [] }]) {
      expect(hiddenRowFlags(snapshot)).toEqual([]);
    }
    expect(hiddenRowFlags({
      breakdown: [null, { label: 'Test line', amount: 'n/a' }, { label: 'Discount', amount: -5, visible: false }],
      adjustments: [null, 'x', { type: 'discount', amount: 5 }],
    })).toEqual([false, false, true]);
    expect(hiddenRowFlags({ breakdown: [{ label: 'Test line', amount: 10 }], adjustments: 'x' })).toEqual([false]);
  });
});
