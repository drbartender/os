const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeExport, parseMoney, normalizeEmail, eventEmails,
  latestIsoDate, buildImportPlan, buildDigest, collapseWhitespace,
} = require('./cc-clients-import');

const contact = (over = {}) => ({
  ID: '248811', Name: 'Ada Lovelace', 'Full Name': 'Ada Lovelace',
  Email: 'ada@example.com', Phone: '312-555-0100', Roles: 'Customer',
  'Customer Events: Total Amount Paid': '$600', ...over,
});
const event = (over = {}) => ({
  Status: 'Confirmed', 'Event Date': '10-11-2025',
  'Contact Email(s)': 'ada@example.com', 'User Email(s)': '',
  'Venue Name': 'The Rookery', ...over,
});

test('parseMoney handles $, commas, and negatives', () => {
  assert.equal(parseMoney('$1,850'), 1850);
  assert.equal(parseMoney('$-385'), -385);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(undefined), 0);
});

test('normalizeEmail lowers, trims, and rejects junk', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('N/A'), null);
  assert.equal(normalizeEmail('noemail@x.com'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail('TBD'), null); // no @ -> never importable as an email
  assert.equal(normalizeEmail('see notes'), null);
});

test('eventEmails merges both email columns and splits lists', () => {
  const set = eventEmails({ 'Contact Email(s)': 'A@x.com; b@y.com', 'User Email(s)': 'c@z.com, A@x.com' });
  assert.deepEqual([...set].sort(), ['a@x.com', 'b@y.com', 'c@z.com']);
});

test('latestIsoDate picks the last day of a multi-day event', () => {
  assert.equal(latestIsoDate('06-13-2026, 06-14-2026'), '2026-06-14');
  assert.equal(latestIsoDate('garbage'), null);
});

test('decodeExport falls back to windows-1252 on invalid utf-8', () => {
  const latin1 = Buffer.from([0x41, 0xe9, 0x42]); // "AéB" in windows-1252, invalid utf-8
  assert.equal(decodeExport(latin1), 'AéB');
  assert.equal(decodeExport(Buffer.from('plain utf-8 ✓')), 'plain utf-8 ✓');
});

test('collapseWhitespace fixes CC double-space names', () => {
  assert.equal(collapseWhitespace('Kevin  Duffy '), 'Kevin Duffy');
});

test('import rule: paid OR confirmed, Customer role only', () => {
  const contacts = [
    contact(), // paid + confirmed -> in
    contact({ ID: '2', Email: 'quoted@x.com', 'Customer Events: Total Amount Paid': '$0' }), // never paid, no event -> out
    contact({ ID: '3', Email: 'confirmed-unpaid@x.com', 'Customer Events: Total Amount Paid': '$0' }), // in via event
    contact({ ID: '4', Email: 'staff@x.com', Roles: 'Staff' }), // staff -> out
    contact({ ID: '5', Email: 'paid-cancelled@x.com', 'Customer Events: Total Amount Paid': '$150' }), // paid, no confirmed event -> in
  ];
  const events = [
    event(),
    event({ 'Contact Email(s)': 'confirmed-unpaid@x.com' }),
    event({ 'Contact Email(s)': 'orphan@x.com' }), // no contact row -> reported, not imported
    event({ Status: 'Proposal (Date Open)', 'Contact Email(s)': 'quoted@x.com' }), // not confirmed
  ];
  const { imports, orphanConfirmedEmails } = buildImportPlan(contacts, events);
  assert.deepEqual(imports.map((r) => r.email), ['ada@example.com', 'confirmed-unpaid@x.com', 'paid-cancelled@x.com']);
  assert.deepEqual(orphanConfirmedEmails, ['orphan@x.com']);
});

test('import rows carry cc_id, cleaned name/phone, and a digest', () => {
  const { imports } = buildImportPlan([contact({ Name: 'Ada  Lovelace', Phone: '' })], [event()]);
  assert.equal(imports.length, 1);
  const row = imports[0];
  assert.equal(row.ccId, '248811');
  assert.equal(row.name, 'Ada Lovelace');
  assert.equal(row.phone, null);
  assert.equal(row.notes, 'Past events: 1 (last 10-2025). Venues: The Rookery. Lifetime paid: $600.');
});

test('digest counts events, dedupes venues, and caps at 3', () => {
  const evs = [
    event({ 'Event Date': '01-05-2025', 'Venue Name': 'A' }),
    event({ 'Event Date': '03-09-2025', 'Venue Name': 'A' }),
    event({ 'Event Date': '11-22-2025', 'Venue Name': 'B' }),
    event({ 'Event Date': '02-14-2025', 'Venue Name': 'C' }),
    event({ 'Event Date': '04-01-2025', 'Venue Name': 'D' }),
  ];
  const d = buildDigest(1850, evs);
  assert.equal(d, 'Past events: 5 (last 11-2025). Venues: A; B; C. Lifetime paid: $1,850.');
});

test('digest for paid-but-no-confirmed-event and venueless clients', () => {
  assert.equal(buildDigest(150, []), 'Past client. Lifetime paid: $150.');
  assert.equal(buildDigest(0, [event({ 'Venue Name': '' })]), 'Past events: 1 (last 10-2025).');
});

test('junk contact email is dropped, not imported as a client', () => {
  const { imports } = buildImportPlan([contact({ Email: 'TBD' })], [event()]);
  assert.deepEqual(imports, []);
});

test('blank contact name falls back to the email', () => {
  const { imports } = buildImportPlan([contact({ Name: '', 'Full Name': '  ' })], [event()]);
  assert.equal(imports[0].name, 'ada@example.com');
});

test('duplicate CC contact IDs fail loudly before any DB work', () => {
  const contacts = [contact(), contact({ Email: 'other@x.com' })]; // same ID '248811'
  assert.throws(() => buildImportPlan(contacts, [event(), event({ 'Contact Email(s)': 'other@x.com' })]),
    /duplicate CC contact IDs.*248811/);
});
