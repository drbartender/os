import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StaffingCell, { deriveStaffing, approvedStaffList, pendingStaffList } from './StaffingCell';

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

  test('rendered copy: a full roster with applicants shows the ratio alone', () => {
    // The waitlist is informational, and this list is where staffing gets
    // worked, so a full roster says one thing and does not advertise overflow.
    const { container } = render(<StaffingCell event={ev({ needed: 1, confirmed: 1, pending: 1 })} />);
    expect(container.textContent).toBe('1/1');
    expect(container.textContent).not.toContain('waitlist');
  });

  test('a live shortfall marks the ratio itself, not just the open count', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, days: 19 })} />);
    expect(container.querySelector('.staffing-ratio.staffing-short')).not.toBeNull();
  });

  test('an inactive shortfall stays muted: no alarm on history', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, days: -5 })} />);
    expect(container.querySelector('.staffing-ratio')).not.toBeNull();
    expect(container.querySelector('.staffing-short')).toBeNull();
  });

  test('a full roster never gets the shortfall alarm', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 2 })} />);
    expect(container.querySelector('.staffing-short')).toBeNull();
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

describe('approvedStaffList', () => {
  const people = [{ user_id: 1, name: 'A', position: 'Bartender' }];
  test('returns the feed array as-is (pg parses the json column, axios decodes the body)', () => {
    expect(approvedStaffList({ approved_staff: people })).toBe(people);
  });
  test('a row without the field reads as nobody', () => {
    expect(approvedStaffList({})).toEqual([]);
    expect(approvedStaffList(null)).toEqual([]);
  });
  test('a non-array value is nobody, not a parse attempt', () => {
    expect(approvedStaffList({ approved_staff: JSON.stringify(people) })).toEqual([]);
    expect(approvedStaffList({ approved_staff: { user_id: 1 } })).toEqual([]);
  });
});

describe('hover card wiring', () => {
  test('hovering a staffed cell lists the confirmed people', () => {
    const event = { ...ev({ needed: 2, confirmed: 2 }), approved_staff: [
      { user_id: 1, name: 'Reqi One', position: 'Bartender' },
      { user_id: 2, name: 'Sam Two', position: 'Bartender' },
    ] };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toBe('2/2');
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Reqi One');
    expect(card.textContent).toContain('Sam Two');
  });

  test('an unstaffed cell has no hover anchor and shows the same copy as before', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, days: 19 })} />);
    expect(container.querySelector('.staff-hover-anchor')).toBeNull();
    expect(container.textContent).toContain('0/2 · 2 open');
  });

  test('a "No roster" row with nobody confirmed has no hover anchor', () => {
    const { container } = render(
      <StaffingCell event={{ positions_needed: null, approved_count: 0, event_date: ymd(10), approved_staff: [] }} />
    );
    expect(container.textContent).toBe('No roster');
    expect(container.querySelector('.staff-hover-anchor')).toBeNull();
  });

  test('the RATIO card never carries applicants, only confirmed people', () => {
    // 1/2 with one applicant: the chip says "1 request", the ratio card says one
    // name. Titled for the ratio anchor specifically: since the requests chip
    // got its own card, "never in the card" would be false of the cell as a
    // whole, and this only reads the first anchor.
    const event = { ...ev({ needed: 2, confirmed: 1, pending: 1, days: 19 }), approved_staff: [
      { user_id: 1, name: 'Reqi One', position: 'Bartender' },
    ] };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toContain('1 request');
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    const card = screen.getByRole('tooltip');
    expect(card.querySelectorAll('.staff-hover-row')).toHaveLength(1);
    expect(card.textContent).not.toContain('request');
  });
});

describe('pendingStaffList', () => {
  const people = [{ user_id: 1, name: 'A', position: 'Bartender' }];
  test('returns the feed array as-is', () => {
    expect(pendingStaffList({ pending_staff: people })).toBe(people);
  });
  test('a row without the field, or a non-array, reads as nobody', () => {
    expect(pendingStaffList({})).toEqual([]);
    expect(pendingStaffList(null)).toEqual([]);
    expect(pendingStaffList({ pending_staff: '[]' })).toEqual([]);
  });
});

describe('two separate hover anchors', () => {
  const staffedWithRequests = () => ({
    ...ev({ needed: 2, confirmed: 1, pending: 2, days: 19 }),
    approved_staff: [{ user_id: 1, name: 'Confirmed Person', position: 'Bartender' }],
    pending_staff: [
      { user_id: 2, name: 'Applicant One', position: 'Bartender' },
      { user_id: 3, name: 'Applicant Two', position: null },
    ],
  });

  test('the cell zeroes its flex gap, which is what keeps the two anchors flush', () => {
    // Load-bearing and it does not look it. `vstack` supplies gap: 0.5rem, so
    // deleting this inline style as a redundant default reopens 8.5px of dead
    // space between the two hover targets and the card blinks off mid-drag.
    // jsdom loads no CSS, so this pins the JS half; the CSS half is measured in
    // the browser (computed rowGap must be 0px).
    const { container } = render(<StaffingCell event={staffedWithRequests()} />);
    const gap = container.querySelector('.staffing-cell').style.gap;
    // Truthy first: deleting the style leaves '' and that is the regression.
    // Then zero by value, because jsdom reports '0' where a browser computes
    // '0px' and this should not fail on the unit.
    expect(gap).toBeTruthy();
    expect(parseFloat(gap)).toBe(0);
  });

  test('the ratio anchor shows the confirmed card only', () => {
    const { container } = render(<StaffingCell event={staffedWithRequests()} />);
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(2);
    fireEvent.mouseEnter(anchors[0]);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Confirmed Person');
    expect(card.textContent).not.toContain('Applicant One');
  });

  test('the chip anchor shows the applicants, oldest first, and never the confirmed', () => {
    const { container } = render(<StaffingCell event={staffedWithRequests()} />);
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    fireEvent.mouseEnter(anchors[1]);
    const card = screen.getByRole('tooltip');
    const rows = card.querySelectorAll('.staff-hover-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.staff-hover-name').textContent).toBe('Applicant One');
    expect(rows[0].querySelector('.staff-hover-pos').textContent).toBe('Bartender');
    // Ranked nothing: name only, no role line.
    expect(rows[1].querySelector('.staff-hover-name').textContent).toBe('Applicant Two');
    expect(rows[1].querySelector('.staff-hover-pos')).toBeNull();
    expect(card.textContent).not.toContain('Confirmed Person');
  });

  test('a full roster with applicants stays silent: no chip, so no requests card', () => {
    // THE decision this lane must not break. 1/1 with an applicant waiting is a
    // waitlist, it is informational rather than actionable, and this list is
    // where staffing gets worked.
    const event = {
      ...ev({ needed: 1, confirmed: 1, pending: 3 }),
      approved_staff: [{ user_id: 1, name: 'Confirmed Person', position: 'Bartender' }],
      pending_staff: [{ user_id: 2, name: 'Waitlisted Person', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toBe('1/1');
    expect(container.querySelectorAll('.staff-hover-anchor')).toHaveLength(1);
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    expect(screen.getByRole('tooltip').textContent).not.toContain('Waitlisted Person');
  });

  test('an inactive row shows no chip and therefore no requests card', () => {
    const event = {
      ...ev({ needed: 2, confirmed: 0, pending: 3, days: -5 }),
      pending_staff: [{ user_id: 2, name: 'Past Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.querySelectorAll('.staff-hover-anchor')).toHaveLength(0);
  });

  test('a "No roster" row with applicants DOES get a requests card', () => {
    // needed === 0 makes actionable true, so the chip renders and the applicants
    // are reachable. That is deliberate and consistent with the cell's existing
    // comment: with no declared roster we cannot tell a waitlist from someone
    // filling a real gap, so we surface them rather than hide them. It is the
    // one path where applicants appear without a known open slot, so pin it.
    const event = {
      ...ev({ needed: 0, confirmed: 0, pending: 2 }),
      positions_needed: null,
      approved_staff: [],
      pending_staff: [{ user_id: 9, name: 'Roster-less Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toContain('No roster');
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(1);
    fireEvent.mouseEnter(anchors[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Roster-less Applicant');
  });

  test('applicants with an empty confirmed roster still get their own anchor', () => {
    const event = {
      ...ev({ needed: 2, confirmed: 0, pending: 1, days: 19 }),
      approved_staff: [],
      pending_staff: [{ user_id: 2, name: 'Only Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    // Nobody confirmed means the ratio gets no anchor; the chip still does.
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(1);
    fireEvent.mouseEnter(anchors[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Only Applicant');
  });
});
