import React from 'react';
import { render } from '@testing-library/react';
import StaffingCell, { deriveStaffing } from './StaffingCell';

// Local YYYY-MM-DD offset from today. dayDiff parses at noon local, so this
// stays stable regardless of the runner's timezone.
const ymd = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ev = ({ needed = 1, confirmed = 0, pending = 0, days = 30, status = 'open' }) => ({
  positions_needed: JSON.stringify(Array(needed).fill('Bartender')),
  approved_count: confirmed,
  pending_count: pending,
  event_date: ymd(days),
  status,
});

describe('deriveStaffing', () => {
  test('pending never reduces the shortfall (the regression this exists to prevent)', () => {
    // Live production shape: unstaffed, three weeks out, two applicants. The
    // old pill model rendered this as a calm 0/1 with no warning at all.
    const s = deriveStaffing(ev({ needed: 1, confirmed: 0, pending: 2, days: 19 }));
    expect(s.open).toBe(1);
    expect(s.pending).toBe(2);
    expect(s.inactive).toBe(false);
  });

  test('two open slots with two applicants still reads as two open', () => {
    const s = deriveStaffing(ev({ needed: 2, confirmed: 0, pending: 2, days: 82 }));
    expect(s.open).toBe(2);
    expect(s.pending).toBe(2);
  });

  test('half staffed with no applicants', () => {
    const s = deriveStaffing(ev({ needed: 2, confirmed: 1, pending: 0, days: 5 }));
    expect(s.open).toBe(1);
    expect(s.pending).toBe(0);
  });

  test('full roster with surplus applicants is a waitlist, not a shortfall', () => {
    const s = deriveStaffing(ev({ needed: 1, confirmed: 1, pending: 3, days: 3 }));
    expect(s.open).toBe(0);
    expect(s.pending).toBe(3);
  });

  test('fully staffed', () => {
    const s = deriveStaffing(ev({ needed: 2, confirmed: 2, pending: 0 }));
    expect(s.open).toBe(0);
    expect(s.needed).toBe(2);
  });

  test('over-staffed never yields a negative shortfall', () => {
    const s = deriveStaffing(ev({ needed: 1, confirmed: 2 }));
    expect(s.open).toBe(0);
  });

  test('no roster yields needed 0', () => {
    const s = deriveStaffing({ positions_needed: null, approved_count: 0, event_date: ymd(10) });
    expect(s.needed).toBe(0);
    expect(s.open).toBe(0);
  });

  test('missing pending_count degrades to zero rather than NaN', () => {
    const s = deriveStaffing({ positions_needed: '["Bartender"]', approved_count: 0, event_date: ymd(10) });
    expect(s.pending).toBe(0);
  });

  describe('inactive events', () => {
    test('a past event is inactive', () => {
      expect(deriveStaffing(ev({ needed: 2, confirmed: 1, days: -1 })).inactive).toBe(true);
    });

    test('today is still active', () => {
      expect(deriveStaffing(ev({ needed: 2, confirmed: 1, days: 0 })).inactive).toBe(false);
    });

    test('a cancelled upcoming event is inactive', () => {
      expect(deriveStaffing(ev({ needed: 2, confirmed: 0, days: 10, status: 'cancelled' })).inactive).toBe(true);
    });

    test('a completed event is inactive', () => {
      expect(deriveStaffing(ev({ needed: 1, confirmed: 1, days: 10, status: 'completed' })).inactive).toBe(true);
    });
  });

  test('rendered copy: "open" is an adjective and never takes a plural s', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 9, confirmed: 0, pending: 0 })} />);
    expect(container.textContent).toContain('0/9 · 9 open');
    expect(container.textContent).not.toContain('opens');
  });

  test('rendered copy: open slots with applicants say requests, not waitlist', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 1, confirmed: 0, pending: 2, days: 19 })} />);
    expect(container.textContent).toContain('2 requests');
    expect(container.textContent).not.toContain('waitlist');
  });

  test('rendered copy: a full roster with applicants says waitlist', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 1, confirmed: 1, pending: 1 })} />);
    expect(container.textContent).toContain('1 on waitlist');
  });

  test('rendered copy: a single applicant is singular', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, pending: 1 })} />);
    expect(container.textContent).toContain('1 request');
    expect(container.textContent).not.toContain('1 requests');
  });

  test('rendered copy: a past event shows no chip', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, pending: 3, days: -5 })} />);
    expect(container.textContent).toContain('0/2');
    expect(container.textContent).not.toContain('request');
  });

  test('tolerates a full ISO timestamp in event_date', () => {
    const s = deriveStaffing({
      positions_needed: '["Bartender"]',
      approved_count: 0,
      pending_count: 1,
      event_date: `${ymd(20)}T00:00:00.000Z`,
    });
    expect(s.inactive).toBe(false);
    expect(s.open).toBe(1);
  });
});
