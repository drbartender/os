import { fmtTime24, fmtTimeRange24, ctDay, dayDiff, relDay, relDayTs } from './format';

describe('fmtTime24', () => {
  test('converts server-written 12h strings', () => {
    expect(fmtTime24('7:00 PM')).toBe('19:00');
    expect(fmtTime24('6:00 PM')).toBe('18:00');
    expect(fmtTime24('9:30 AM')).toBe('09:30');
  });

  test('handles legacy no-space form', () => {
    expect(fmtTime24('6:00PM')).toBe('18:00');
    expect(fmtTime24('11:15am')).toBe('11:15');
  });

  test('passes canonical 24h through (padded)', () => {
    expect(fmtTime24('18:00')).toBe('18:00');
    expect(fmtTime24('8:30')).toBe('08:30');
    expect(fmtTime24('00:00')).toBe('00:00');
  });

  test('midnight and noon edge cases', () => {
    expect(fmtTime24('12:00 AM')).toBe('00:00');
    expect(fmtTime24('12:00 PM')).toBe('12:00');
    expect(fmtTime24('12:30 AM')).toBe('00:30');
  });

  test('empty input returns empty string', () => {
    expect(fmtTime24('')).toBe('');
    expect(fmtTime24(null)).toBe('');
    expect(fmtTime24(undefined)).toBe('');
  });

  test('unparseable non-empty input is returned as-is, never blanked', () => {
    expect(fmtTime24('garbage')).toBe('garbage');
    expect(fmtTime24('25:00')).toBe('25:00');
    expect(fmtTime24('7:75 PM')).toBe('7:75 PM');
  });
});

describe('fmtTimeRange24', () => {
  test('stored end + duration', () => {
    expect(fmtTimeRange24('7:00 PM', '11:00 PM', 5)).toBe('19:00–23:00 · 5h');
    expect(fmtTimeRange24('18:00', '23:00', 5)).toBe('18:00–23:00 · 5h');
  });

  test('derives end from start + duration when end is missing', () => {
    expect(fmtTimeRange24('18:00', null, 5)).toBe('18:00–23:00 · 5h');
    expect(fmtTimeRange24('6:00 PM', '', 4)).toBe('18:00–22:00 · 4h');
  });

  test('fractional duration strips trailing zero', () => {
    expect(fmtTimeRange24('18:00', null, 4.5)).toBe('18:00–22:30 · 4.5h');
    expect(fmtTimeRange24('18:00', null, 5.0)).toBe('18:00–23:00 · 5h');
  });

  test('past-midnight wrap', () => {
    expect(fmtTimeRange24('10:00 PM', null, 4)).toBe('22:00–02:00 · 4h');
  });

  test('end present, no duration → derive hours from span', () => {
    expect(fmtTimeRange24('18:00', '23:00', null)).toBe('18:00–23:00 · 5h');
    expect(fmtTimeRange24('18:00', '22:30', null)).toBe('18:00–22:30 · 4.5h');
  });

  test('start only', () => {
    expect(fmtTimeRange24('18:00', null, null)).toBe('18:00');
    expect(fmtTimeRange24('7:00 PM', '', undefined)).toBe('19:00');
  });

  test('missing / unparseable start', () => {
    expect(fmtTimeRange24('', null, 5)).toBe('');
    expect(fmtTimeRange24(null, null, 5)).toBe('');
    expect(fmtTimeRange24('garbage', null, 5)).toBe('garbage');
  });

  test('paren style for EventDetailPage parity', () => {
    expect(fmtTimeRange24('18:00', null, 5, { durStyle: 'paren' })).toBe('18:00–23:00 (5 hrs)');
    expect(fmtTimeRange24('18:00', null, 1, { durStyle: 'paren' })).toBe('18:00–19:00 (1 hr)');
  });
});

// ── Chicago-keyed day math for TIMESTAMPTZ moments ──────────────────
// Regression: the proposals dashboard derived a calendar day from sent_at /
// last_viewed_at by slicing the first 10 chars of the JSON ISO string, which is
// the UTC day. Anything at/after 19:00 Chicago (18:00 CST) lands on the NEXT UTC
// day, so relDay printed "Tomorrow" for a proposal sent that evening. Timestamps
// below are real production rows.
describe('ctDay', () => {
  test('maps a moment to its America/Chicago calendar day, not the UTC one', () => {
    // prod proposal 769: sent 2026-08-23 19:57 Chicago
    expect(ctDay('2026-08-24T00:57:43.004Z')).toBe('2026-08-23');
    // one minute before the CDT roll
    expect(ctDay('2026-08-23T23:59:00.000Z')).toBe('2026-08-23');
    // exactly at the CDT roll
    expect(ctDay('2026-08-24T00:00:00.000Z')).toBe('2026-08-23');
  });

  test('winter is CST (UTC-6), so the roll moves to 18:00 Chicago', () => {
    expect(ctDay('2026-01-15T05:59:00.000Z')).toBe('2026-01-14');
    expect(ctDay('2026-01-15T06:00:00.000Z')).toBe('2026-01-15');
  });

  test('empty / unparseable input returns null', () => {
    expect(ctDay(null)).toBe(null);
    expect(ctDay('')).toBe(null);
    expect(ctDay('garbage')).toBe(null);
  });
});

describe('dayDiff with an explicit anchor', () => {
  test('both sides anchor the same way, so the browser zone cancels out', () => {
    expect(dayDiff('2026-03-10', '2026-03-12')).toBe(-2);
    expect(dayDiff('2026-03-12', '2026-03-12')).toBe(0);
    expect(dayDiff('2026-03-13', '2026-03-12')).toBe(1);
    // spans the CST→CDT change; the anchor pair cancels, so no 23-hour drift
    expect(dayDiff('2026-03-06', '2026-03-10')).toBe(-4);
  });

  test('no anchor keeps the existing browser-local behaviour', () => {
    const t = new Date();
    const ymd = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    expect(dayDiff(ymd)).toBe(0);
    expect(relDay(ymd)).toBe('Today');
  });
});

describe('relDayTs', () => {
  test('an evening send never reads "Tomorrow" (the reported bug)', () => {
    // sent 2026-08-23 19:57 Chicago, read at 21:00 Chicago the same night
    expect(relDayTs('2026-08-24T00:57:43.004Z', new Date('2026-08-24T02:00:00Z'))).toBe('Today');
  });

  test('and reads "Yesterday" the next Chicago morning', () => {
    expect(relDayTs('2026-08-24T00:57:43.004Z', new Date('2026-08-24T14:00:00Z'))).toBe('Yesterday');
  });

  test('the day shift was permanent, not just overnight', () => {
    // prod proposal 761: sent 2026-08-19 22:36 Chicago; read 2026-08-24 12:00 Chicago
    expect(relDayTs('2026-08-20T03:36:37.192Z', new Date('2026-08-24T17:00:00Z'))).toBe('5d ago');
  });

  test('midday moments were already correct and stay correct', () => {
    expect(relDayTs('2026-08-24T17:00:00Z', new Date('2026-08-24T17:30:00Z'))).toBe('Today');
    expect(relDayTs('2026-08-24T17:00:00Z', new Date('2026-08-25T17:30:00Z'))).toBe('Yesterday');
  });

  test('empty / unparseable input renders the empty placeholder', () => {
    expect(relDayTs(null)).toBe('—');
    expect(relDayTs('')).toBe('—');
    expect(relDayTs('garbage')).toBe('—');
  });
});
