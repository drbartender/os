import {
  MIN_TERM, MAX_TERM, GROUP_LIMIT, termState, initialsOf, rowTarget, moreTarget,
  searchRow, searchGroups, searchNote, errorKind, flightLabel, liveSummary,
} from './searchView';
import { routeScreenKey } from './screenKey';

const client = (over = {}) => ({ type: 'client', id: 3, name: 'Marcus Keller', detail: 'mkeller@example.test', cc_id: null, ...over });
const proposal = (over = {}) => ({
  type: 'proposal', id: 40, name: 'Alexis Henderson', detail: 'Wedding Reception · Oct 24, 2026',
  status: 'sent', event_date: '2026-10-24', kind: 'Wedding Reception', ...over,
});
const event = (over = {}) => ({
  type: 'event', id: 41, name: 'Nautilus Group', detail: 'Corporate Event · Oct 3, 2026',
  status: 'confirmed', event_date: '2026-10-03', kind: 'Corporate Event', ...over,
});
const staff = (over = {}) => ({ type: 'staff', id: 12, name: 'Jordan Lee', detail: 'Active bartender', cc_id: null, ...over });
const many = (make, n) => Array.from({ length: n }, (_, i) => make({ id: 100 + i, name: `Name ${i}` }));

test('the endpoint bounds', () => {
  expect([MIN_TERM, MAX_TERM, GROUP_LIMIT]).toEqual([2, 100, 6]);
});

test.each([
  ['', 'empty'], ['   ', 'empty'], [null, 'empty'], ['k', 'short'], [' k ', 'short'],
  ['ma', 'ok'], ['x'.repeat(100), 'ok'], [`  ${'x'.repeat(100)}  `, 'ok'], ['x'.repeat(101), 'long'],
])('termState(%p) is %s', (raw, state) => {
  expect(termState(raw)).toBe(state);
});

test.each([
  ['Marcus Keller', 'MK'], ['jordan', 'J'], ['Mary Ann Lee', 'MA'], ['  a  b ', 'AB'], ['', ''], [null, ''],
])('initialsOf(%p) is %p', (name, out) => {
  expect(initialsOf(name)).toBe(out);
});

test('every desktop visit a row or a More row opens is keyed by the screen key of the page it opens', () => {
  const targets = [
    rowTarget('clients', 3), rowTarget('staff', 12),
    moreTarget('clients', 'ma'), moreTarget('proposals', 'ma'), moreTarget('events', 'ma'), moreTarget('staff', 'ma'),
  ];
  targets.forEach((t) => expect(routeScreenKey(t.path.split('?')[0])).toBe(t.screenKey));
  expect(rowTarget('proposals', 40)).toEqual({ path: '/proposals/40', screenKey: null });
  expect(rowTarget('events', 41)).toEqual({ path: '/events/41', screenKey: null });
  expect(rowTarget('clients', 3)).toEqual({ path: '/clients/3', screenKey: 'clients' });
  expect(rowTarget('staff', 12)).toEqual({ path: '/staffing/users/12', screenKey: 'staffing' });
});

test('More targets: the group desktop lists; only Proposals carries the term', () => {
  expect(moreTarget('clients', 'ma')).toEqual({ path: '/clients', screenKey: 'clients' });
  expect(moreTarget('proposals', ' smith & co ')).toEqual({ path: '/proposals?q=smith%20%26%20co', screenKey: 'proposals-list' });
  expect(moreTarget('events', 'ma')).toEqual({ path: '/events?tab=all', screenKey: 'events-list' });
  expect(moreTarget('staff', 'ma')).toEqual({ path: '/staffing?tab=all', screenKey: 'staffing' });
  expect(moreTarget('nope', 'ma')).toBeNull();
});

test('a client row: icon tile, name, email or phone as meta, Desktop', () => {
  expect(searchRow('clients', client())).toEqual({
    key: 'clients-3', title: 'Marcus Keller', kind: '', meta: 'mkeller@example.test',
    lead: { kind: 'icon', icon: 'users' }, chip: null, desktop: true,
    target: { path: '/clients/3', screenKey: 'clients' },
  });
  expect(searchRow('clients', client({ detail: '' })).meta).toBe('');
});

test('a proposal row: the kind on its own line, the date under it, the stage chip, no Desktop', () => {
  const row = searchRow('proposals', proposal());
  expect(row.lead).toEqual({ kind: 'icon', icon: 'clipboard' });
  expect(row.title).toBe('Alexis Henderson');
  expect(row.kind).toBe('Wedding Reception');
  expect(row.meta).toBe('Oct 24, 2026');
  expect(row.chip).toEqual({ label: 'Sent', kind: 'info' });
  expect(row.desktop).toBe(false);
  // No date: no date line; a date that does not parse is no date either.
  expect(searchRow('proposals', proposal({ event_date: null })).meta).toBe('');
  expect(searchRow('proposals', proposal({ event_date: 'garbage' })).meta).toBe('');
  // A server that has not deployed the new fields yet: no chip, the detail
  // as the one meta line, no crash.
  const old = searchRow('proposals', proposal({ status: undefined, kind: undefined, event_date: undefined }));
  expect(old.chip).toBeNull();
  expect(old.kind).toBe('');
  expect(old.meta).toBe('Wedding Reception · Oct 24, 2026');
});

test('an event row: the date rail, the kind on its own line, no meta, no chip', () => {
  const row = searchRow('events', event());
  expect(row.lead).toEqual({ kind: 'rail', rail: { dow: 'SAT', day: '03', mon: 'OCT' }, noDate: false });
  expect(row.title).toBe('Nautilus Group');
  expect(row.kind).toBe('Corporate Event');
  expect(row.meta).toBe('');
  expect(row.chip).toBeNull();
  expect(row.desktop).toBe(false);
  expect(searchRow('events', event({ event_date: null })).lead).toEqual({ kind: 'rail', rail: { dow: '', day: '–', mon: '' }, noDate: true });
  expect(searchRow('events', event({ event_date: 'garbage' })).lead.noDate).toBe(true);
  // Before the server ships kind, the palette's detail stands in as the meta.
  const old = searchRow('events', event({ kind: undefined }));
  expect(old.kind).toBe('');
  expect(old.meta).toBe('Corporate Event · Oct 3, 2026');
});

test('a staff row: initials, the status as meta, Desktop', () => {
  const row = searchRow('staff', staff());
  expect(row.lead).toEqual({ kind: 'initials', initials: 'JL' });
  expect(row.kind).toBe('');
  expect(row.meta).toBe('Active bartender');
  expect(row.desktop).toBe(true);
  expect(row.target).toEqual({ path: '/staffing/users/12', screenKey: 'staffing' });
  expect(searchRow('nope', staff())).toBeNull();
});

test('groups: the palette order whatever the object order, empty ones left out, counts', () => {
  const groups = searchGroups({ staff: [staff()], events: [], clients: [client(), client({ id: 4, name: 'Marrow Gallery' })], proposals: [proposal()] }, 'ma');
  expect(groups.map((g) => [g.label, g.count])).toEqual([['Clients', '2'], ['Proposals', '1'], ['Staff', '1']]);
  expect(groups.every((g) => !g.full && g.more === null)).toBe(true);
  expect(searchGroups(null, 'ma')).toEqual([]);
  expect(searchGroups({ clients: [client()] }, 'ma').map((g) => g.key)).toEqual(['clients']);
});

test('a full group says 6+ and ends in its More row; five rows do not', () => {
  const [full] = searchGroups({ clients: many(client, 6) }, 'ma');
  expect(full.count).toBe('6+');
  expect(full.full).toBe(true);
  expect(full.moreLabel).toBe('More clients on desktop');
  expect(full.more).toEqual(moreTarget('clients', 'ma'));
  const [five] = searchGroups({ proposals: many(proposal, 5) }, 'ma');
  expect(five.count).toBe('5');
  expect(five.more).toBeNull();
  expect(searchGroups({ staff: many(staff, 6) }, 'ma')[0].moreLabel).toBe('More staff on desktop');
});

const none = { offline: false, error: null, pending: false, resultsFor: null, groups: [] };

test('notes, in the benchmark order: offline beats everything', () => {
  expect(searchNote({ ...none, raw: 'x'.repeat(101), offline: true })).toEqual({
    icon: 'search', title: 'Search needs the server',
    body: 'Global search runs a live query. Nothing is cached on the phone. Reconnect to search.',
    micro: 'offline · field kept, results off', retry: false,
  });
  expect(searchNote({ ...none, raw: 'x'.repeat(101) })).toEqual({
    icon: 'x', title: 'Too long to search', body: 'The server stops at 100 characters. Trim the term down.',
    micro: '101 characters', retry: false,
  });
  expect(searchNote({ ...none, raw: '  ' })).toEqual({
    icon: 'search', title: 'Search every record',
    body: 'Clients, proposals, events and staff, by name, email, or phone number.',
    micro: 'phone match needs 3+ digits', retry: false,
  });
  expect(searchNote({ ...none, raw: 'k' })).toEqual({
    icon: 'search', title: 'Keep typing', body: 'Nothing is searched until two characters.', micro: '', retry: false,
  });
});

test('a failed search for the term on screen offers Retry; one for an older term says nothing', () => {
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'rate' } })).toEqual({
    icon: 'clock', title: 'Too many searches', body: 'Wait a minute, then try again.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'network' } })).toEqual({
    icon: 'alert', title: 'Search didn’t answer', body: 'Check the signal, then try again.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'server' } })).toEqual({
    icon: 'alert', title: 'Search failed', body: 'The server couldn’t run this search. Try again in a moment.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'mar', pending: true, error: { term: 'ma', kind: 'network' } })).toBeNull();
});

test('errorKind reads the normalized status: none at all, the limiter, the server', () => {
  expect(errorKind({ status: 0, code: 'NETWORK_ERROR' })).toBe('network');
  expect(errorKind({})).toBe('network');
  expect(errorKind(undefined)).toBe('network');
  expect(errorKind({ status: 429 })).toBe('rate');
  expect(errorKind({ status: 500 })).toBe('server');
  expect(errorKind({ status: 403 })).toBe('server');
});

test('nothing matched quotes the term verbatim; pending or results say nothing', () => {
  expect(searchNote({ ...none, raw: "50% o'brien", resultsFor: "50% o'brien" })).toEqual({
    icon: 'search', title: 'No matches for “50% o\'brien”',
    body: 'Try a last name, an email address, or the last four digits of a phone.', micro: '', retry: false,
  });
  expect(searchNote({ ...none, raw: 'zephyr', resultsFor: 'zephyr', pending: true })).toBeNull();
  expect(searchNote({ ...none, raw: 'ma', resultsFor: 'ma', groups: searchGroups({ clients: [client()] }, 'ma') })).toBeNull();
  expect(searchNote({ ...none, raw: 'mar', resultsFor: 'ma', pending: true })).toBeNull();
});

test('the in-flight line names the term whose rows are on screen', () => {
  expect(flightLabel(null)).toBe('searching…');
  expect(flightLabel('ma')).toBe('searching · showing “ma”');
});

test('the status line: searching, the note, or how many rows', () => {
  expect(liveSummary({ pending: true, note: null, groups: [] })).toBe('Searching');
  expect(liveSummary({ pending: false, note: { title: 'Keep typing' }, groups: [] })).toBe('Keep typing');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: [client()] }, 'ma') })).toBe('1 result');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: [client(), client({ id: 4 })], staff: [staff()] }, 'ma') })).toBe('3 results');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: many(client, 6), staff: [staff()] }, 'ma') })).toBe('7+ results');
  expect(liveSummary({ pending: false, note: null, groups: [] })).toBe('');
});
