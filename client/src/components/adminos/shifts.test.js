import { isCancelledEvent, selectUpcoming, eventStatusChip, parsePositionsCount, neededCount } from './shifts';
import { parsePositionsNeeded } from '../../utils/staffingRoles';

// Dates relative to "today" so the suite never goes stale. dayDiff anchors both
// sides at local noon, so these are timezone-stable.
const ymd = (offsetDays) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Row shapes mirror the admin GET /shifts feed: `s.*` (so `status` is the SHIFT
// status) plus `p.status AS proposal_status`.
const shiftRow = (over = {}) => ({
  id: 1,
  event_date: ymd(30),
  status: 'open',
  proposal_status: 'confirmed',
  proposal_id: 100,
  positions_needed: '["Bartender"]',
  approved_count: 0,
  ...over,
});

describe('isCancelledEvent', () => {
  test('cancelled shift on an archived proposal (the P6 cancel / archive reap shape)', () => {
    // prod shift 349 — Jayme Corcoran, cancelled + archived
    expect(isCancelledEvent(shiftRow({ status: 'cancelled', proposal_status: 'archived' }))).toBe(true);
  });

  test('live event is not cancelled', () => {
    expect(isCancelledEvent(shiftRow())).toBe(false);
  });

  test('completed event is not cancelled', () => {
    expect(isCancelledEvent(shiftRow({ status: 'open', proposal_status: 'completed' }))).toBe(false);
  });

  test('manual shift with no proposal, soft-cancelled via cancel-or-unassign', () => {
    expect(isCancelledEvent(shiftRow({ status: 'cancelled', proposal_status: null, proposal_id: null }))).toBe(true);
  });

  test('archived proposal whose shift row was never reaped still counts (defense in depth)', () => {
    expect(isCancelledEvent(shiftRow({ status: 'open', proposal_status: 'archived' }))).toBe(true);
  });

  test('tolerates the drawer/detail row shape that names the field shift_status', () => {
    expect(isCancelledEvent({ shift_status: 'cancelled' })).toBe(true);
  });

  test('null and undefined are not cancelled', () => {
    expect(isCancelledEvent(null)).toBe(false);
    expect(isCancelledEvent(undefined)).toBe(false);
  });
});

describe('selectUpcoming', () => {
  test('excludes a cancelled event that is still in the future', () => {
    // The reported bug: a cancelled event 3 days out led the Needs-attention
    // Staffing tab because only the date was checked.
    const rows = [
      shiftRow({ id: 349, event_date: ymd(3), status: 'cancelled', proposal_status: 'archived' }),
      shiftRow({ id: 367, event_date: ymd(3) }),
    ];
    expect(selectUpcoming(rows).map(e => e.id)).toEqual([367]);
  });

  test('keeps live future events and drops past ones', () => {
    const rows = [
      shiftRow({ id: 1, event_date: ymd(-5) }),
      shiftRow({ id: 2, event_date: ymd(0) }),
      shiftRow({ id: 3, event_date: ymd(10) }),
    ];
    expect(selectUpcoming(rows).map(e => e.id)).toEqual([2, 3]);
  });

  test('sorts ascending by event_date', () => {
    const rows = [
      shiftRow({ id: 3, event_date: ymd(30) }),
      shiftRow({ id: 1, event_date: ymd(1) }),
      shiftRow({ id: 2, event_date: ymd(15) }),
    ];
    expect(selectUpcoming(rows).map(e => e.id)).toEqual([1, 2, 3]);
  });

  test('drops rows with no event_date and tolerates a missing list', () => {
    expect(selectUpcoming([shiftRow({ id: 9, event_date: null })])).toEqual([]);
    expect(selectUpcoming(null)).toEqual([]);
    expect(selectUpcoming(undefined)).toEqual([]);
  });
});

describe('eventStatusChip', () => {
  // eventStatusChip returns a React element; read the label off it directly
  // rather than rendering, so these stay pure assertions.
  const label = (e) => eventStatusChip(e)?.props?.children;

  const paidRow = (over = {}) => shiftRow({
    proposal_total: 500, proposal_amount_paid: 500, ...over,
  });

  test('a shift cancelled on its own still chips Cancelled, not its payment state', () => {
    // cancel-or-unassign mode='cancel' cancels the SHIFT and leaves the proposal
    // live. The old inline check read e.shift_status, which this feed never
    // sends, so this row used to read "Paid in full".
    expect(label(paidRow({ status: 'cancelled', proposal_status: 'confirmed' }))).toBe('Cancelled');
  });

  test('archived proposal still chips Cancelled (unchanged behavior)', () => {
    expect(label(paidRow({ status: 'open', proposal_status: 'archived' }))).toBe('Cancelled');
  });

  test('the P6 cancel shape (both flags) chips Cancelled', () => {
    expect(label(paidRow({ status: 'cancelled', proposal_status: 'archived' }))).toBe('Cancelled');
  });

  test('live events keep their payment chips', () => {
    expect(label(paidRow())).toBe('Paid in full');
    expect(label(paidRow({ proposal_amount_paid: 100 }))).toBe('Deposit paid');
    expect(label(paidRow({ proposal_amount_paid: 0 }))).toBe('No payment');
    expect(label(paidRow({ proposal_status: 'sent' }))).toBe('Contract out');
  });

  test('a completed shift is not mistaken for a cancelled one', () => {
    expect(label(paidRow({ status: 'completed', proposal_status: 'completed' }))).toBe('Paid in full');
  });

  test('null row returns no chip', () => {
    expect(eventStatusChip(null)).toBeNull();
  });
});

// ─── positions_needed: ONE reader (2026-08-20) ──────────────────────────────
//
// server/utils/positionsNeeded.js states the law: "Production holds two
// historical shapes: a flat string array ["Bartender","Bartender"] and a legacy
// object array [{position:'bartender',count:2}]. Every reader of
// positions_needed must go through this, never a bare JSON.parse."
//
// parsePositionsCount was a bare JSON.parse taking the raw array's LENGTH, while
// remainingByRole in this same file and ShiftDrawer's per-role math both used
// parsePositionsNeeded. So the same column produced two different answers on two
// surfaces one click apart, and on the legacy shape the DASHBOARD's answer was
// the wrong one.

const shift = (positions_needed) => ({ positions_needed });

test('the legacy object shape counts every slot it declares, not the array length', () => {
  // The staffing hole: two bartenders declared, counted as one position. The
  // shift leaves the unstaffed queue as soon as ONE person is approved and the
  // second bartender is never hired.
  expect(parsePositionsCount(shift('[{"position":"bartender","count":2}]'))).toBe(2);
  expect(parsePositionsCount(shift([{ position: 'Bartender', count: 3 }]))).toBe(3);
});

test('the flat shape is unchanged, which is every row in production today', () => {
  expect(parsePositionsCount(shift('["Bartender"]'))).toBe(1);
  expect(parsePositionsCount(shift('["Bartender","Bartender"]'))).toBe(2);
  expect(parsePositionsCount(shift('["Bartender","Bartender","Bartender"]'))).toBe(3);
  expect(parsePositionsCount(shift(['Bartender', 'Banquet Server']))).toBe(2);
});

test('an empty or missing roster counts as 1, because it is a data gap', () => {
  // NOT cosmetic: this number drives the Events unstaffed filter, the Events
  // unstaffed counter, the Overview queue open count and the Overview unstaffed
  // filter. A literal 0 would read as "fully staffed" and hide the shift in all
  // four at once.
  expect(parsePositionsCount(shift('[]'))).toBe(1);
  expect(parsePositionsCount(shift(null))).toBe(1);
  expect(parsePositionsCount(shift('not json'))).toBe(1);
  expect(parsePositionsCount(undefined)).toBe(1);
});

test('the card and the drawer cannot disagree, because they share one rule', () => {
  // The drawer computes neededCount(parsePositionsNeeded(...)) against the
  // roster it already parsed for its per-role math; the card computes
  // parsePositionsCount(row). Same input, same answer, for every shape that
  // exists or has existed.
  for (const raw of [
    '["Bartender"]',
    '["Bartender","Bartender"]',
    '[{"position":"bartender","count":2}]',
    '[]',
    null,
    'not json',
  ]) {
    const card = parsePositionsCount(shift(raw));
    const drawer = neededCount(parsePositionsNeeded(raw));
    expect(drawer).toBe(card);
  }
});

test('neededCount is total on junk, since it runs inside a render', () => {
  expect(neededCount([])).toBe(1);
  expect(neededCount(null)).toBe(1);
  expect(neededCount(undefined)).toBe(1);
  expect(neededCount(['Bartender', 'Bartender'])).toBe(2);
});
