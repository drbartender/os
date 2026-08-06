import { isCancelledEvent, selectUpcoming, eventStatusChip } from './shifts';

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
