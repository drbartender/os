import { contextModel, kindLine, LEGAL_HOLD_TEXT, NO_QUOTE_TEXT, NO_CLIENT_TEXT } from './inboxContext';

// Invented people only (the repo is public).
const booked = {
  kind: 'client', status_chip: 'Booked', event_type_label: 'Wedding', guests: 160,
  when_text: 'Sat Oct 24 · 6–11 PM', where_text: 'Example Hall, Chicago',
  proposal: { id: 41, status_label: 'Signed Sep 12', chip: 'Signed' },
  // A DATE as the wire carries it from a UTC server: midnight UTC.
  money: { total: 4200, paid: 1000, balance: 3200, due_date: '2026-10-10T00:00:00.000Z' },
  links: { client_id: 7, proposal_id: 41, event_id: 41 },
};

test('kind line for each kind (spec 4.2 header)', () => {
  expect(kindLine(booked)).toBe('Booked · Wedding');
  expect(kindLine({ kind: 'lead', status_chip: 'Lead', event_type_label: null })).toBe('Lead');
  expect(kindLine({ kind: 'staff', role: 'Bartender' })).toBe('Staff · Bartender');
  expect(kindLine({ kind: 'tt_lead' })).toBe('Thumbtack lead');
  expect(kindLine({ kind: 'zola_lead', couple_label: 'Alex B & Sam C' })).toBe('Zola lead');
  expect(kindLine({ kind: 'unknown' })).toBe('Not a client yet');
  expect(kindLine(null)).toBe('');
});

test('a booked client: chip, rows, money with the due date, and three links', () => {
  const m = contextModel(booked);
  expect(m.chip).toEqual({ kind: 'ok', label: 'Booked' });
  expect(m.type).toBe('Wedding');
  expect(m.guests).toBe(160);
  expect(m.rows.map((r) => [r.label, r.value])).toEqual([
    ['When', 'Sat Oct 24 · 6–11 PM'], ['Where', 'Example Hall, Chicago'], ['Proposal', 'Signed Sep 12'],
  ]);
  expect(m.rows[2].chip).toEqual({ kind: 'ok', label: 'Signed' });
  expect(m.money).toEqual({ total: '$4,200', paid: '$1,000', balance: '$3,200', sub: 'due Oct 10', settled: false });
  expect(m.showNoQuote).toBe(false);
  expect(m.links.map((l) => [l.label, l.to])).toEqual([
    ['Client', '/clients/7'], ['Proposal', '/proposals/41'], ['Event', '/events/41'],
  ]);
  expect(m.hold).toBeNull();
});

test('money sub-line: paid in full, no deposit yet', () => {
  expect(contextModel({ ...booked, money: { total: 2600, paid: 2600, balance: 0, due_date: null } }).money)
    .toMatchObject({ balance: '$0', sub: 'paid in full', settled: true });
  expect(contextModel({ ...booked, money: { total: 3850, paid: 0, balance: 3850, due_date: null } }).money)
    .toMatchObject({ sub: 'no deposit yet', settled: false });
});

test('a lead with no proposal: None chip, the no-quote line, and New proposal for the client', () => {
  const m = contextModel({
    kind: 'lead', status_chip: 'Lead', event_type_label: 'Birthday', guests: null,
    when_text: 'Sat Oct 31', where_text: null, proposal: { id: null, status_label: 'Not sent yet', chip: 'None' }, money: null,
    links: { client_id: 9, proposal_id: null, event_id: null },
  });
  expect(m.chip).toEqual({ kind: 'info', label: 'Lead' });
  expect(m.rows.find((r) => r.key === 'proposal')).toMatchObject({ value: 'Not sent yet', chip: { kind: 'neutral', label: 'None' } });
  expect(m.showNoQuote).toBe(true);
  expect(m.links.map((l) => [l.label, l.to])).toEqual([['Client', '/clients/9'], ['New proposal', '/proposals/new?client_id=9']]);
  expect(NO_QUOTE_TEXT).toBe('No quote yet. Totals show here once a proposal goes out.');
});

test('staff: role, the next shift, roster fill with an open-seat chip, and two links', () => {
  const m = contextModel({
    kind: 'staff', role: 'Bartender',
    shift: { id: 88, when_text: 'Sat Oct 10 · 4–11 PM', event_text: 'Sample wedding, Example Hall', roster: { filled: 3, total: 4 } },
    links: { user_id: 31, shift_id: 88 },
  });
  expect(m.chip).toEqual({ kind: 'neutral', label: 'Staff' });
  expect(m.rows.map((r) => r.label)).toEqual(['Shift', 'Event', 'Roster']);
  expect(m.rows[2]).toMatchObject({ value: '3 of 4', chip: { kind: 'warn', label: '1 open' } });
  expect(m.money).toBeNull();
  expect(m.showNoQuote).toBe(false);
  expect(m.links.map((l) => l.to)).toEqual(['/staffing/users/31', '/events/shift/88']);
});

test('a Thumbtack lead without a client: date, place and the Thumbtack link', () => {
  const m = contextModel({ kind: 'tt_lead', name: 'Jo Test', event_date: '2026-11-14T23:00:00.000Z', location: 'Evanston, IL', negotiation_id: '987654321' });
  expect(m.rows.map((r) => [r.label, r.value])).toEqual([['When', 'Sat Nov 14'], ['Where', 'Evanston, IL']]);
  expect(m.links).toEqual([{ key: 'tt', label: 'Thumbtack', href: 'https://www.thumbtack.com/pro-inbox/messages/987654321' }]);
});

test('an unknown number: the number, Not a client yet, and New proposal', () => {
  const m = contextModel({ kind: 'unknown', phone_display: '(312) 555-0100' });
  expect(m.chip).toEqual({ kind: 'neutral', label: 'Not a client yet' });
  expect(m.type).toBe('(312) 555-0100');
  expect(m.links.map((l) => l.to)).toEqual(['/proposals/new']);
});

// Spec 2026-10-14 section 4.3. wedding_date is a calendar date: it reads as
// that day on any clock (never as a UTC midnight that slips back a day).
test('a Zola lead without a client: Zola, the couple, When as the artifact writes it, No client record yet', () => {
  const m = contextModel({ kind: 'zola_lead', couple_label: 'Alex B & Sam C', wedding_date: '2027-05-22', client_id: null });
  expect(m.chip).toEqual({ kind: 'info', label: 'Lead' });
  expect(m.type).toBe('Zola');
  expect(m.rows.map((r) => [r.label, r.value])).toEqual([['Couple', 'Alex B & Sam C'], ['When', 'Sat May 22, 2027']]);
  expect(m.note).toBe(NO_CLIENT_TEXT);
  expect(NO_CLIENT_TEXT).toBe('No client record yet');
  expect(m.money).toBeNull();
  expect(m.showNoQuote).toBe(false);
  expect(m.links.map((l) => l.to)).toEqual(['/proposals/new']);
  // No date known: no date row. A lead that gained a client links to it.
  const linked = contextModel({ kind: 'zola_lead', couple_label: 'Alex B & Sam C', wedding_date: null, client_id: 12 });
  expect(linked.rows.map((r) => r.label)).toEqual(['Couple']);
  expect(linked.note).toBeNull();
  expect(linked.links).toEqual([{ key: 'client', label: 'Client', to: '/clients/12' }]);
});

test('a Zola wedding date reads as that calendar day, never shifted by a zone', () => {
  const when = (wedding_date) => contextModel({ kind: 'zola_lead', couple_label: 'Alex B & Sam C', wedding_date, client_id: null })
    .rows.filter((r) => r.key === 'when').map((r) => r.value);
  expect(when('2027-01-01')).toEqual(['Fri Jan 1, 2027']);
  expect(when('2026-12-31')).toEqual(['Thu Dec 31, 2026']);
  // A DATE serialised as an instant still reads its first ten characters.
  expect(when('2027-05-22T00:00:00.000Z')).toEqual(['Sat May 22, 2027']);
  expect(when('not a date')).toEqual([]);
  expect(when('2027-02-30')).toEqual([]);
  // Re-review 2026-10-15: Date.UTC rolls a month 0 or 13 into the next year
  // over, and reads a two-digit year as 19xx. None of these is a real day.
  expect(when('2027-00-15')).toEqual([]);
  expect(when('2027-13-01')).toEqual([]);
  expect(when('0027-05-22')).toEqual([]);
  expect(when('1899-12-31')).toEqual([]);
  expect(when('3000-01-01')).toEqual([]);
  expect(when('1900-01-01')).toEqual(['Mon Jan 1, 1900']);
  expect(when('2999-12-31')).toEqual(['Tue Dec 31, 2999']);
});

test('an unknown sender: the address where a number would be', () => {
  const m = contextModel({ kind: 'unknown', phone_display: null, address: 'pat@example.com' });
  expect(m.chip).toEqual({ kind: 'neutral', label: 'Not a client yet' });
  expect(m.type).toBe('pat@example.com');
  expect(contextModel({ kind: 'unknown', phone_display: null, address: null }).type).toBe('');
});

test('the legal-hold banner rides on any kind, and an unknown kind is no card', () => {
  expect(contextModel(booked, { legalHold: true }).hold).toBe(LEGAL_HOLD_TEXT);
  expect(LEGAL_HOLD_TEXT).toBe('Legal hold: check with Dallas before contacting');
  expect(contextModel({ kind: 'mystery' })).toBeNull();
  expect(contextModel(null)).toBeNull();
});
