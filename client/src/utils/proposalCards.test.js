import { ymdOf, agoLabel, whenLabel, proposalMeta, proposalCard } from './proposalCards';

const NOW = new Date('2026-10-14T18:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

const row = (over = {}) => ({
  id: 7, status: 'sent', client_name: 'Ferreira', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-10-03T05:00:00.000Z', guest_count: 150, total_price: '5240.00', amount_paid: '0',
  sent_at: hoursAgo(48), last_viewed_at: null, view_count: 0, accepted_at: null,
  created_at: hoursAgo(50), updated_at: hoursAgo(48), ...over,
});

describe('ymdOf', () => {
  test('takes the date part of a timestamp or a plain date, null otherwise', () => {
    expect(ymdOf('2026-10-03T05:00:00.000Z')).toBe('2026-10-03');
    expect(ymdOf('2026-10-03')).toBe('2026-10-03');
    expect(ymdOf(null)).toBeNull();
    expect(ymdOf('')).toBeNull();
    expect(ymdOf('nonsense')).toBeNull();
  });
});

describe('agoLabel', () => {
  test('hours-grained as the benchmark writes it', () => {
    expect(agoLabel(hoursAgo(0.005), NOW)).toBe('just now');
    expect(agoLabel(hoursAgo(0.2), NOW)).toBe('12m ago');
    expect(agoLabel(hoursAgo(5), NOW)).toBe('5h ago');
    expect(agoLabel(hoursAgo(18), NOW)).toBe('18h ago');
    expect(agoLabel(hoursAgo(36), NOW)).toBe('1d ago');
    expect(agoLabel(hoursAgo(72), NOW)).toBe('3d ago');
  });
  test('empty for nothing and for garbage; a future stamp reads just now', () => {
    expect(agoLabel(null, NOW)).toBe('');
    expect(agoLabel('not a date', NOW)).toBe('');
    expect(agoLabel(new Date(NOW.getTime() + 60000).toISOString(), NOW)).toBe('just now');
  });
});

describe('whenLabel', () => {
  test('an age within the last 7 days', () => {
    expect(whenLabel(hoursAgo(5), NOW)).toBe('5h ago');
    expect(whenLabel(hoursAgo(6 * 24 + 23), NOW)).toBe('6d ago');
  });
  test("the rail's date in Chicago beyond 7 days, the year only when it is not this one", () => {
    expect(whenLabel(hoursAgo(7 * 24), NOW)).toBe('OCT 7');
    expect(whenLabel('2026-08-10T15:00:00Z', NOW)).toBe('AUG 10');
    // 03:00 UTC on Aug 11 is still Aug 10 in Chicago.
    expect(whenLabel('2026-08-11T03:00:00Z', NOW)).toBe('AUG 10');
    expect(whenLabel('2025-12-30T18:00:00Z', NOW)).toBe('DEC 30 2025');
  });
  test('empty for nothing and for garbage', () => {
    expect(whenLabel(null, NOW)).toBe('');
    expect(whenLabel('not a date', NOW)).toBe('');
  });
});

describe('proposalMeta', () => {
  test('draft: created ago', () => {
    expect(proposalMeta(row({ status: 'draft', created_at: hoursAgo(72), sent_at: null }), NOW)).toBe('draft · created 3d ago');
  });
  test('sent and never opened', () => {
    expect(proposalMeta(row(), NOW)).toBe('sent 2d ago · not opened');
    expect(proposalMeta(row({ sent_at: null }), NOW)).toBe('sent · not opened');
  });
  test('sent again after the client opened it: the view count, never "not opened"', () => {
    expect(proposalMeta(row({ status: 'sent', sent_at: hoursAgo(48), last_viewed_at: hoursAgo(30), view_count: 2 }), NOW)).toBe('sent 2d ago · 2 views');
    expect(proposalMeta(row({ status: 'sent', sent_at: hoursAgo(48), last_viewed_at: hoursAgo(30), view_count: 0 }), NOW)).toBe('sent 2d ago');
  });
  test('viewed: last view and the count, singular at one', () => {
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: hoursAgo(5), view_count: 3 }), NOW)).toBe('viewed 5h ago · 3 views');
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: hoursAgo(1), view_count: 1 }), NOW)).toBe('viewed 1h ago · 1 view');
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: null, view_count: 0 }), NOW)).toBe('viewed');
  });
  test('modified: the sent time, never "by client" and never updated_at', () => {
    const meta = proposalMeta(row({ status: 'modified', sent_at: hoursAgo(48), updated_at: hoursAgo(1) }), NOW);
    expect(meta).toBe('modified · sent 2d ago');
    expect(meta).not.toMatch(/client/);
    expect(proposalMeta(row({ status: 'modified', sent_at: null }), NOW)).toBe('modified');
  });
  test('accepted: awaiting deposit, or the amount paid', () => {
    expect(proposalMeta(row({ status: 'accepted', amount_paid: '0' }), NOW)).toBe('accepted · awaiting deposit');
    expect(proposalMeta(row({ status: 'accepted', amount_paid: '500' }), NOW)).toBe('accepted · $500 paid');
  });
  test('any other status reads its label and the last change', () => {
    expect(proposalMeta(row({ status: 'declined', updated_at: hoursAgo(6) }), NOW)).toBe('declined · 6h ago');
  });
});

describe('proposalCard', () => {
  test('the benchmark facts', () => {
    const card = proposalCard(row(), NOW);
    expect(card).toEqual(expect.objectContaining({
      key: 'p7', id: 7, ymd: '2026-10-03', noDate: false,
      rail: { dow: 'SAT', day: '03', mon: 'OCT' },
      clientName: 'Ferreira', kind: 'Wedding Reception', guests: 150,
      meta: 'sent 2d ago · not opened', total: '$5,240',
      chipLabel: 'Sent', chipKind: 'info',
    }));
  });
  test('chips come from the shared status map', () => {
    expect(proposalCard(row({ status: 'draft' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Draft', chipKind: 'neutral' }));
    expect(proposalCard(row({ status: 'viewed' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Viewed', chipKind: 'accent' }));
    expect(proposalCard(row({ status: 'modified' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Modified', chipKind: 'violet' }));
    expect(proposalCard(row({ status: 'accepted' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Accepted', chipKind: 'ok' }));
  });
  test('no event date: a dash rail and the flag; a custom type wins; blanks hide', () => {
    const card = proposalCard(row({ event_date: null, event_type_custom: 'Retirement roast', guest_count: null, total_price: null, client_name: null }), NOW);
    expect(card.rail).toEqual({ dow: '', day: '–', mon: '' });
    expect(card.noDate).toBe(true);
    expect(card.kind).toBe('Retirement roast');
    expect(card.guests).toBeNull();
    expect(card.total).toBe('');
    expect(card.clientName).toBe('Unnamed client');
  });
});
