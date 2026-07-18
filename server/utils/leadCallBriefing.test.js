const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLeadBriefing } = require('./leadCallBriefing');

// ─── buildLeadBriefing ───────────────────────────────────────────
// Pure: DB-shaped lead row -> spoken sentence. TTS-friendly dates in
// Chicago wall-clock; absent fields skipped, never "unknown"; NO escaping
// here (the TwiML layer xmlEscapes).

const FULL_ROW = {
  customer_name: 'Sarah M.',
  category: 'Wedding',
  // 6:00 PM CDT on Sat 2026-10-10 = 23:00Z
  event_date: '2026-10-10T23:00:00.000Z',
  guest_count: 120,
  location_city: 'Naperville',
};

test('full row renders every field in order, Chicago wall-clock, ordinal day', () => {
  assert.equal(
    buildLeadBriefing(FULL_ROW),
    'New Thumbtack lead: Sarah M. Wedding, Saturday October 10th, 6 PM, 120 guests, Naperville. Press 1 to call them now. Press 9 to hear this again.'
  );
});

test('non-zero minutes render as h:mm', () => {
  const s = buildLeadBriefing({ ...FULL_ROW, event_date: '2026-10-10T23:30:00.000Z' });
  assert.ok(s.includes('6:30 PM'), s);
});

test('UTC instant that crosses the Chicago date line renders the Chicago day', () => {
  // 01:00Z Sun Oct 11 = 8 PM CDT Sat Oct 10.
  const s = buildLeadBriefing({ ...FULL_ROW, event_date: '2026-10-11T01:00:00.000Z' });
  assert.ok(s.includes('Saturday October 10th, 8 PM'), s);
});

test('winter date uses the CST offset', () => {
  // 01:00Z Jan 16 = 7 PM CST Thu Jan 15.
  const s = buildLeadBriefing({ ...FULL_ROW, event_date: '2026-01-16T01:00:00.000Z' });
  assert.ok(s.includes('Thursday January 15th, 7 PM'), s);
});

test('each field absent is skipped, never spoken as unknown', () => {
  const noName = buildLeadBriefing({ ...FULL_ROW, customer_name: null });
  assert.ok(noName.startsWith('New Thumbtack lead. Wedding,'), noName);

  const noCategory = buildLeadBriefing({ ...FULL_ROW, category: null });
  assert.ok(noCategory.includes('Sarah M. Saturday'), noCategory);

  const noDate = buildLeadBriefing({ ...FULL_ROW, event_date: null });
  assert.ok(!noDate.includes('October'), noDate);

  const noGuests = buildLeadBriefing({ ...FULL_ROW, guest_count: null });
  assert.ok(!noGuests.includes('guests'), noGuests);

  const noCity = buildLeadBriefing({ ...FULL_ROW, location_city: null });
  assert.ok(!noCity.includes('Naperville'), noCity);

  for (const s of [noName, noCategory, noDate, noGuests, noCity]) {
    assert.ok(!/unknown/i.test(s), s);
    assert.ok(s.endsWith('Press 1 to call them now. Press 9 to hear this again.'), s);
  }
});

test('null and empty rows fall back to the generic line', () => {
  const expected = 'New Thumbtack lead. Press 1 to call them now. Press 9 to hear this again.';
  assert.equal(buildLeadBriefing(null), expected);
  assert.equal(buildLeadBriefing(undefined), expected);
  assert.equal(buildLeadBriefing({}), expected);
});

test('unparseable event_date is skipped, not NaN-rendered', () => {
  const s = buildLeadBriefing({ ...FULL_ROW, event_date: 'not-a-date' });
  assert.ok(!/NaN|Invalid/.test(s), s);
  assert.ok(s.includes('Wedding, 120 guests, Naperville'), s);
});

test('midnight and noon render as 12 AM / 12 PM', () => {
  // 05:00Z in July = midnight CDT; 17:00Z = noon CDT.
  const mid = buildLeadBriefing({ ...FULL_ROW, event_date: '2026-07-11T05:00:00.000Z' });
  assert.ok(mid.includes('12 AM'), mid);
  const noon = buildLeadBriefing({ ...FULL_ROW, event_date: '2026-07-11T17:00:00.000Z' });
  assert.ok(noon.includes('12 PM'), noon);
});

test('output is plain text: no escaping applied here', () => {
  const s = buildLeadBriefing({ ...FULL_ROW, customer_name: 'A & B <Duo>' });
  assert.ok(s.includes('A & B <Duo>'), s);
});
