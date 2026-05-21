require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  RETENTION_ELIGIBLE_EVENT_TYPES,
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  clientHasUpcomingEvent,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
} = require('./retentionEligibility');

// ── isRetentionEligibleEventType ──
test('isRetentionEligibleEventType > returns true for whitelisted event types', () => {
  assert.strictEqual(isRetentionEligibleEventType('holiday-party'), true);
  assert.strictEqual(isRetentionEligibleEventType('birthday-party'), true);
  assert.strictEqual(isRetentionEligibleEventType('milestone-birthday'), true);
  assert.strictEqual(isRetentionEligibleEventType('corporate-event'), true);
  assert.strictEqual(isRetentionEligibleEventType('corporate-happy-hour'), true);
  assert.strictEqual(isRetentionEligibleEventType('anniversary'), true);
});

test('isRetentionEligibleEventType > returns false for excluded event types', () => {
  assert.strictEqual(isRetentionEligibleEventType('wedding-reception'), false);
  assert.strictEqual(isRetentionEligibleEventType('engagement-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('baby-shower'), false);
  assert.strictEqual(isRetentionEligibleEventType('graduation-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('retirement-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('bachelor-bachelorette'), false);
});

test('isRetentionEligibleEventType > returns false for null/undefined/unknown', () => {
  assert.strictEqual(isRetentionEligibleEventType(null), false);
  assert.strictEqual(isRetentionEligibleEventType(undefined), false);
  assert.strictEqual(isRetentionEligibleEventType('not-a-real-type'), false);
});

test('isRetentionEligibleEventType > exposes the whitelist constant for admin UI later', () => {
  assert.ok(RETENTION_ELIGIBLE_EVENT_TYPES.includes('holiday-party'));
  assert.ok(RETENTION_ELIGIBLE_EVENT_TYPES.includes('birthday-party'));
});

// ── shouldScheduleNewYearTouch ──
test('shouldScheduleNewYearTouch > returns true when event is in next calendar year and >= 60 days into new year', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2027-04-01'); // 90 days into 2027
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), true);
});

test('shouldScheduleNewYearTouch > returns false when event is in same calendar year as sign', () => {
  const signedAt = new Date('2026-03-01T12:00:00Z');
  const eventDate = new Date('2026-12-31');
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

test('shouldScheduleNewYearTouch > returns false when event is <60 days into the new year', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2027-01-15'); // 14 days into new year
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

test('shouldScheduleNewYearTouch > returns false when event is in a year beyond next', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2028-04-01');
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

// ── shouldScheduleSixMonthsTouch ──
test('shouldScheduleSixMonthsTouch > returns true when booking lead time > 6 months', () => {
  const signedAt = new Date('2026-01-15T12:00:00Z');
  const eventDate = new Date('2026-08-15'); // 7 months later
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), true);
});

test('shouldScheduleSixMonthsTouch > returns false when booking lead time exactly 6 months', () => {
  const signedAt = new Date('2026-02-15T12:00:00Z');
  const eventDate = new Date('2026-08-15');
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), false);
});

test('shouldScheduleSixMonthsTouch > returns false when booking lead time < 6 months', () => {
  const signedAt = new Date('2026-05-15T12:00:00Z');
  const eventDate = new Date('2026-08-15');
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), false);
});

// ── computeNewYearSendAt ──
test('computeNewYearSendAt > defaults to America/Chicago when no tz passed', () => {
  const eventDate = new Date('2027-04-01');
  const result = computeNewYearSendAt(eventDate);
  // Jan 2 2027 10:00 Chicago = Jan 2 2027 16:00 UTC (CST is UTC-6)
  assert.strictEqual(result.toISOString(), '2027-01-02T16:00:00.000Z');
});

test('computeNewYearSendAt > honors a passed event TZ (Gemini Finding 4)', () => {
  const eventDate = new Date('2027-04-01');
  const result = computeNewYearSendAt(eventDate, 'America/New_York');
  // Jan 2 2027 10:00 NY = Jan 2 2027 15:00 UTC (EST is UTC-5)
  assert.strictEqual(result.toISOString(), '2027-01-02T15:00:00.000Z');
});

// ── computeSixMonthsOutSendAt ──
test('computeSixMonthsOutSendAt > returns event_date minus 6 months at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-12-15');
  const result = computeSixMonthsOutSendAt(eventDate);
  // 6 months before 2026-12-15 = 2026-06-15
  // 10:00 Chicago in June = 15:00 UTC (CDT is UTC-5)
  assert.strictEqual(result.toISOString(), '2026-06-15T15:00:00.000Z');
});

test('computeSixMonthsOutSendAt > honors a passed event TZ', () => {
  const eventDate = new Date('2026-12-15');
  const result = computeSixMonthsOutSendAt(eventDate, 'America/Los_Angeles');
  // 6 months before = 2026-06-15; 10:00 LA in June = 17:00 UTC (PDT is UTC-7)
  assert.strictEqual(result.toISOString(), '2026-06-15T17:00:00.000Z');
});

// ── computeReviewRequestSendAt ──
test('computeReviewRequestSendAt > returns event_date + 2 days at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-06-15');
  const result = computeReviewRequestSendAt(eventDate);
  assert.strictEqual(result.toISOString(), '2026-06-17T15:00:00.000Z');
});

// ── computeRetentionNudgeSendAt ──
test('computeRetentionNudgeSendAt > returns event_date + 11 months at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-01-15');
  const result = computeRetentionNudgeSendAt(eventDate);
  // 11 months later = 2026-12-15
  // 10:00 Chicago in December = 16:00 UTC (CST)
  assert.strictEqual(result.toISOString(), '2026-12-15T16:00:00.000Z');
});

// ── clientHasUpcomingEvent ──
let retentionClientId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Retention Test', 'retention-test@example.com') RETURNING id"
  );
  retentionClientId = c.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [retentionClientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [retentionClientId]);
});

afterEach(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [retentionClientId]);
});

// Schema note: proposals.token is UUID NOT NULL DEFAULT gen_random_uuid().
// These fixtures omit `token` and let the default fire — downstream tests in
// this block don't read the token. If a future test needs it, use
// `RETURNING id, token` instead of a string literal.

test('clientHasUpcomingEvent > returns true when client has another non-archived future event', async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed') RETURNING id`,
    [retentionClientId]
  );
  const otherProposalId = p.rows[0].id;
  const result = await clientHasUpcomingEvent(retentionClientId, otherProposalId + 1);
  assert.strictEqual(result, true);
});

test('clientHasUpcomingEvent > returns false when only the excluded proposal exists', async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed') RETURNING id`,
    [retentionClientId]
  );
  const result = await clientHasUpcomingEvent(retentionClientId, p.rows[0].id);
  assert.strictEqual(result, false);
});

test('clientHasUpcomingEvent > returns false when other future events are archived', async () => {
  await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, archive_reason)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'archived', 'client_cancelled')`,
    [retentionClientId]
  );
  const result = await clientHasUpcomingEvent(retentionClientId, -1);
  assert.strictEqual(result, false);
});
