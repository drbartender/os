// Pure-unit tests for the staff-side BEO-confirm calendar feed extension.
// Route-level coverage (30-day backward cutoff, debounced last_ics_fetch_at)
// deferred — see note in test "deferred coverage" below.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBeoConfirmVEvents,
  detectCalendarApp,
  reminderYyyymmdd,
  addDayIcs,
  escapeIcsText,
} = require('./staffCalendarFeedExt');

const PORTAL = 'https://staff.drbartender.com';

// ───────────────────────────────────────────────────────────────────────────
// buildBeoConfirmVEvents — core behavior
// ───────────────────────────────────────────────────────────────────────────

test('emits all-day VEVENT for unconfirmed-finalized BEO shift', () => {
  const rows = [{
    shift_id: 42,
    event_date: '2026-08-15',
    client_name: 'Smith Wedding',
    finalized_at: new Date('2026-08-01T12:00:00Z'),
    beo_acknowledged_at: null,
  }];
  const events = buildBeoConfirmVEvents(rows, PORTAL);
  assert.equal(events.length, 1);
  const v = events[0];
  assert.match(v, /^BEGIN:VEVENT\r\n/);
  assert.match(v, /\r\nEND:VEVENT$/);
  assert.match(v, /UID:beo-confirm-42@drbartender\.com/);
  assert.match(v, /DTSTART;VALUE=DATE:20260812/);   // 3 days before 2026-08-15
  assert.match(v, /DTEND;VALUE=DATE:20260813/);     // DTEND = DTSTART + 1 day (all-day convention)
  assert.match(v, /SUMMARY:Confirm BEO: Smith Wedding/);
  assert.match(v, /DESCRIPTION:Open the staff portal to confirm: https:\/\/staff\.drbartender\.com\/shifts\/42/);
  assert.match(v, /TRANSP:TRANSPARENT/);
});

test('skips already-acked BEOs', () => {
  const rows = [{
    shift_id: 99,
    event_date: '2026-09-10',
    client_name: 'X',
    finalized_at: new Date('2026-09-01T00:00:00Z'),
    beo_acknowledged_at: new Date('2026-09-02T00:00:00Z'),
  }];
  const events = buildBeoConfirmVEvents(rows, PORTAL);
  assert.equal(events.length, 0);
});

test('skips un-finalized drink plans', () => {
  const rows = [{
    shift_id: 7,
    event_date: '2026-09-10',
    client_name: 'X',
    finalized_at: null,
    beo_acknowledged_at: null,
  }];
  const events = buildBeoConfirmVEvents(rows, PORTAL);
  assert.equal(events.length, 0);
});

test('skips rows missing event_date', () => {
  const rows = [{
    shift_id: 7,
    event_date: null,
    client_name: 'X',
    finalized_at: new Date(),
    beo_acknowledged_at: null,
  }];
  assert.equal(buildBeoConfirmVEvents(rows, PORTAL).length, 0);
});

test('skips rows missing shift_id', () => {
  const rows = [{
    shift_id: null,
    event_date: '2026-09-10',
    client_name: 'X',
    finalized_at: new Date(),
    beo_acknowledged_at: null,
  }];
  assert.equal(buildBeoConfirmVEvents(rows, PORTAL).length, 0);
});

test('uses "client" as fallback summary when client_name is missing', () => {
  const rows = [{
    shift_id: 5,
    event_date: '2026-09-10',
    client_name: null,
    finalized_at: new Date(),
    beo_acknowledged_at: null,
  }];
  const events = buildBeoConfirmVEvents(rows, PORTAL);
  assert.equal(events.length, 1);
  assert.match(events[0], /SUMMARY:Confirm BEO: client/);
});

test('handles non-array input safely', () => {
  assert.deepEqual(buildBeoConfirmVEvents(null, PORTAL), []);
  assert.deepEqual(buildBeoConfirmVEvents(undefined, PORTAL), []);
  assert.deepEqual(buildBeoConfirmVEvents('not-an-array', PORTAL), []);
});

test('escapes special chars in client_name (commas, semicolons, backslashes)', () => {
  const rows = [{
    shift_id: 1,
    event_date: '2026-10-01',
    client_name: 'Smith, Jones; & Co.\\Bar',
    finalized_at: new Date(),
    beo_acknowledged_at: null,
  }];
  const v = buildBeoConfirmVEvents(rows, PORTAL)[0];
  assert.match(v, /SUMMARY:Confirm BEO: Smith\\, Jones\\; & Co\.\\\\Bar/);
});

test('mixed batch: emits VEVENTs only for unconfirmed-finalized rows', () => {
  const rows = [
    { shift_id: 1, event_date: '2026-08-15', client_name: 'A', finalized_at: new Date(), beo_acknowledged_at: null },
    { shift_id: 2, event_date: '2026-08-16', client_name: 'B', finalized_at: null, beo_acknowledged_at: null },
    { shift_id: 3, event_date: '2026-08-17', client_name: 'C', finalized_at: new Date(), beo_acknowledged_at: new Date() },
    { shift_id: 4, event_date: '2026-08-18', client_name: 'D', finalized_at: new Date(), beo_acknowledged_at: null },
  ];
  const events = buildBeoConfirmVEvents(rows, PORTAL);
  assert.equal(events.length, 2);
  assert.match(events[0], /UID:beo-confirm-1@/);
  assert.match(events[1], /UID:beo-confirm-4@/);
});

// ───────────────────────────────────────────────────────────────────────────
// DST safety — 2026-03-08 is the US spring-forward; DTSTART must be 03-05
// regardless of local timezone math.
// ───────────────────────────────────────────────────────────────────────────

test('DTSTART is exactly 3 days before event_date across DST transition (2026-03-08)', () => {
  const rows = [{
    shift_id: 1,
    event_date: '2026-03-08',
    client_name: 'DST Event',
    finalized_at: new Date(),
    beo_acknowledged_at: null,
  }];
  const v = buildBeoConfirmVEvents(rows, PORTAL)[0];
  assert.match(v, /DTSTART;VALUE=DATE:20260305/);
  assert.match(v, /DTEND;VALUE=DATE:20260306/);
});

test('reminderYyyymmdd handles Date object input (as pg returns DATE columns)', () => {
  // pg returns DATE columns as JS Date objects at midnight UTC.
  const dt = new Date('2026-08-15T00:00:00.000Z');
  assert.equal(reminderYyyymmdd(dt), '20260812');
});

test('reminderYyyymmdd returns null on garbage input', () => {
  assert.equal(reminderYyyymmdd(null), null);
  assert.equal(reminderYyyymmdd(''), null);
  assert.equal(reminderYyyymmdd('not-a-date'), null);
  assert.equal(reminderYyyymmdd(new Date('invalid')), null);
});

test('addDayIcs rolls month boundaries correctly', () => {
  assert.equal(addDayIcs('20260131'), '20260201');
  assert.equal(addDayIcs('20261231'), '20270101');
  // Leap-year Feb 28 -> Feb 29 (2024 was leap; 2026 is not, so Feb 28 -> Mar 01)
  assert.equal(addDayIcs('20260228'), '20260301');
  assert.equal(addDayIcs('20240228'), '20240229');
});

// ───────────────────────────────────────────────────────────────────────────
// detectCalendarApp — User-Agent string detection
// ───────────────────────────────────────────────────────────────────────────

test('detectCalendarApp identifies Google Calendar', () => {
  assert.equal(detectCalendarApp('Google-Calendar-Importer'), 'google');
  assert.equal(detectCalendarApp('Mozilla/5.0 (compatible; Calendar.google.com)'), 'google');
});

test('detectCalendarApp identifies Apple Calendar / iOS', () => {
  assert.equal(detectCalendarApp('iOS/17.4 (21E236) accountsd/1.0'), 'apple');
  assert.equal(detectCalendarApp('iCal/4.0.4 (Macintosh; OS X 10.15)'), 'apple');
});

test('detectCalendarApp identifies Outlook / Microsoft Office', () => {
  assert.equal(detectCalendarApp('Microsoft Office/16.0 (Microsoft Outlook 16.0.14026; Pro)'), 'outlook');
  assert.equal(detectCalendarApp('Outlook-iOS/2.0'), 'outlook');
});

test('detectCalendarApp returns "other" for unknown/empty UA', () => {
  assert.equal(detectCalendarApp(''), 'other');
  assert.equal(detectCalendarApp(undefined), 'other');
  assert.equal(detectCalendarApp(null), 'other');
  assert.equal(detectCalendarApp('curl/7.84.0'), 'other');
  assert.equal(detectCalendarApp('Mozilla/5.0 (Windows NT 10.0)'), 'other');
});

// ───────────────────────────────────────────────────────────────────────────
// escapeIcsText regression
// ───────────────────────────────────────────────────────────────────────────

test('escapeIcsText handles null/undefined safely', () => {
  assert.equal(escapeIcsText(null), '');
  assert.equal(escapeIcsText(undefined), '');
});

// ───────────────────────────────────────────────────────────────────────────
// Deferred coverage — see Step 5 of the plan
// ───────────────────────────────────────────────────────────────────────────
// The plan's optional route-level tests (30-day backward cutoff, debounced
// last_ics_fetch_at) would require standing up the hand-rolled HTTP harness
// from server/routes/proposals/crud.test.js: an express() app, a real JWT,
// the calendar router, plus seed shifts/proposals/drink_plans/shift_requests
// across the cutoff and two timed fetches. Those are pure SQL-level concerns
// (the cutoff is a constant in the WHERE clause; the debounce is a constant
// in the UPDATE WHERE clause). Kept out of this util test file per the
// plan's explicit deferral note. Manual verification via curl per Step 6.
