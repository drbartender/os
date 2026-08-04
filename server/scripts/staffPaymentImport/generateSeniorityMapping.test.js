const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeMappingRow, toYmd } = require('./generateSeniorityMapping');

test('active matched contact defaults include=yes with no flags', () => {
  const row = shapeMappingRow({ name: 'Kaitlyn Freyer', created: '2025-05-22', events: 32,
    matchedUserId: 7, onboardingStatus: 'approved',
    current: { preferred_name: 'Kaitlyn', hire_date: '2025-06-10', live_events: 3 }, dupCount: 1 });
  assert.equal(row.include, 'yes');
  assert.equal(row.proposed_hire_date, '2025-05-22');
  assert.equal(row.proposed_historical, 32);
  assert.equal(row.flags, '');   // 2025-05-22 is earlier than the current 2025-06-10
});

test('unmatched contact is excluded and flagged', () => {
  const row = shapeMappingRow({ name: 'Ghost', created: '2025-05-01', events: 5,
    matchedUserId: null, onboardingStatus: '', current: {}, dupCount: 0 });
  assert.equal(row.include, 'no');
  assert.equal(row.flags, 'unmatched');
});

test('inactive status excluded; zero-events and date-moves-later flags fire', () => {
  const row = shapeMappingRow({ name: 'Old Vet', created: '2025-08-01', events: 0,
    matchedUserId: 9, onboardingStatus: 'deactivated',
    current: { hire_date: '2025-04-01', live_events: 0 }, dupCount: 1 });
  assert.equal(row.include, 'no');
  assert.ok(row.flags.includes('zero-events'));
  assert.ok(row.flags.includes('date-moves-later'));   // 2025-08-01 later than 2025-04-01
});

test('two contacts resolving to one user get duplicate-match', () => {
  const row = shapeMappingRow({ name: 'Dup', created: '2025-05-01', events: 2,
    matchedUserId: 5, onboardingStatus: 'approved', current: { hire_date: '', live_events: 0 }, dupCount: 2 });
  assert.ok(row.flags.includes('duplicate-match'));
});

// Fixtures are built in the LOCAL (Chicago) frame with new Date(y, mIdx, d) —
// exactly how `pg` hands back a DATE column — never by parsing a 'YYYY-MM-DD'
// string, which JS reads as UTC midnight and would be a different instant.
test('toYmd renders a pg Date as YYYY-MM-DD, not a day name', () => {
  assert.equal(toYmd(new Date(2025, 5, 10)), '2025-06-10');   // month index 5 = June
  assert.equal(toYmd('2025-06-10'), '2025-06-10');            // string passes through
  assert.equal(toYmd(null), '');
});

test('date-moves-later fires when current hire_date arrives as a pg Date', () => {
  const row = shapeMappingRow({ name: 'Vet', created: '2025-08-01', events: 4,
    matchedUserId: 11, onboardingStatus: 'approved',
    current: { hire_date: new Date(2025, 3, 1), live_events: 2 }, dupCount: 1 });
  assert.equal(row.current_hire_date, '2025-04-01');
  assert.ok(row.flags.includes('date-moves-later'),
    'a Date-shaped current_hire_date must still lose the comparison to a later CC date');
});

test('date-moves-later does NOT fire when the CC date is earlier', () => {
  const row = shapeMappingRow({ name: 'Vet2', created: '2025-02-01', events: 4,
    matchedUserId: 12, onboardingStatus: 'approved',
    current: { hire_date: new Date(2025, 3, 1), live_events: 2 }, dupCount: 1 });
  assert.equal(row.flags, '');
});

// ccDateToIso returns '' for anything that is not an MM-DD-YYYY prefix, and
// some CheckCherry exports omit the Created At column entirely (the committed
// __fixtures__/cc-contacts.csv has no such column). Such a row used to default
// to include=yes with an EMPTY proposed hire date and no flag at all, pushing
// the whole decision onto the apply script's skip guard where the human
// reviewing the CSV never saw it. It now fails safe, exactly like unmatched.
test('a contact with no parseable Created At is flagged and defaulted out', () => {
  const row = shapeMappingRow({ name: 'No Date', created: '', events: 21,
    matchedUserId: 14, onboardingStatus: 'approved',
    current: { preferred_name: 'NoDate', hire_date: new Date(2025, 3, 1), live_events: 1 }, dupCount: 1 });
  assert.equal(row.proposed_hire_date, '');
  assert.ok(row.flags.includes('no-proposed-date'));
  assert.equal(row.include, 'no', 'an empty proposed hire date must never default to include=yes');
  assert.ok(!row.flags.includes('date-moves-later'), 'an absent CC date cannot move a hire date later');
});

test('no-proposed-date does not fire for a normal dated contact', () => {
  const row = shapeMappingRow({ name: 'Dated', created: '2025-05-22', events: 5,
    matchedUserId: 15, onboardingStatus: 'approved', current: { live_events: 0 }, dupCount: 1 });
  assert.equal(row.flags, '');
  assert.equal(row.include, 'yes');
});
