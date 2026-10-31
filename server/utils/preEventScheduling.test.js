require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  computeScheduledFor,
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
} = require('./preEventScheduling');
const preEventHandlers = require('./preEventHandlers');
const { registerDrinkPlanNudgeHandlers } = require('./drinkPlanNudge');

const TEST_CLIENT_ID = -1;
const TEST_PROPOSAL_ID = -101;

// Register dispatcher handlers (and their offset metadata) ONCE so
// getHandlerMeta('event_week_reminder') / 'long_lead_t30_recap' / the
// drink-plan-nudge types return the canonical offset values that
// computeScheduledFor reads. Mirrors server/index.js boot — schedulePreEventReminders
// now also schedules the drink-plan nudge (email + SMS) via scheduleDrinkPlanNudge,
// which calls computeScheduledFor('drink_plan_nudge') and so needs that metadata.
before(() => {
  preEventHandlers.registerAll();
  registerDrinkPlanNudgeHandlers();
});

beforeEach(async () => {
  // Scope deletes to THIS file's own fixture IDs only. `node --test` runs test
  // files in parallel against the shared dev DB, so a blanket `id < 0` delete
  // would wipe sibling files' negative-ID fixtures (e.g. rescheduleProposal.test.js
  // uses proposal id -202) and cause non-deterministic cross-file failures.
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES ($1, 'Test Client', 't@example.com', '+15551112222')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_CLIENT_ID]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
});

after(async () => {
  // Scoped to this file's own fixture IDs — see beforeEach note above.
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
  await pool.end();
});

// ── computeScheduledFor ──
// Signature: computeScheduledFor(messageType, proposal). Reads offset/anchor
// from dispatcher metadata, not a local map — single source of truth.
test('computeScheduledFor > returns a UTC instant for T-7 at 10am event-local', () => {
  const proposal = {
    event_date: '2026-06-20',         // Saturday
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  // T-7 of 2026-06-20 = 2026-06-13. At 10:00 Chicago = 15:00 UTC (CDT).
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > honors event_timezone when computing the local hour', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'America/New_York',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  // 10:00 EDT = 14:00 UTC
  assert.strictEqual(result.toISOString(), '2026-06-13T14:00:00.000Z');
});

test('computeScheduledFor > falls back to America/Chicago for invalid event_timezone', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'Bogus/Zone',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > throws on unknown messageType', () => {
  const proposal = { event_date: '2026-06-20', event_timezone: 'America/Chicago' };
  assert.throws(() => computeScheduledFor('not_a_real_type', proposal), /Unknown messageType/);
});

test('computeScheduledFor > T-30 long-lead lands at 10am event-local', () => {
  const proposal = {
    event_date: '2026-12-01',
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  };
  const result = computeScheduledFor('long_lead_t30_recap', proposal);
  // T-30 of 2026-12-01 = 2026-11-01. At 10:00 Chicago in November = 16:00 UTC (CST).
  assert.strictEqual(result.toISOString(), '2026-11-01T16:00:00.000Z');
});

// ── shouldScheduleLongLeadRecap ──
test('shouldScheduleLongLeadRecap > returns true when booking lead time is >= 90 days', () => {
  const proposal = { event_date: '2026-10-01', created_at: '2026-05-01T12:00:00Z' };
  // 2026-10-01 - 2026-05-01 = 153 days
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), true);
});

test('shouldScheduleLongLeadRecap > returns false when booking lead time is < 90 days', () => {
  const proposal = { event_date: '2026-07-15', created_at: '2026-05-01T12:00:00Z' };
  // 2026-07-15 - 2026-05-01 = 75 days
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

test('shouldScheduleLongLeadRecap > returns false when event_date is missing', () => {
  const proposal = { event_date: null, created_at: '2026-05-01T12:00:00Z' };
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

test('shouldScheduleLongLeadRecap > returns false when created_at is missing', () => {
  const proposal = { event_date: '2026-10-01', created_at: null };
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

// ── schedulePreEventReminders ──
// The fixture dates in this section are relative to the run, never literals.
// scheduleEventEve (eventEveSms.js) skips, and deletes, an event-eve pair whose
// send time (24 hours before the event start) is already past, so a literal
// event date rots: once the calendar passed the old literal 2026-08-15, the
// 5-row expectation came out as 3. No test here reads the weekday or the
// event-local hour (the start time stays 18:00 Chicago), so only the distances
// below matter.
const DAY_MS = 24 * 3600 * 1000;
// The UTC calendar date `days` from now, as 'YYYY-MM-DD'.
function ymdFromNow(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}
// The instant `days` from now (negative is in the past), as an ISO string.
function isoFromNow(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}
// Every fixture event is 45 days out, so the event-week reminder (T-7), the
// drink-plan nudge (T-21) and the event-eve pair (T-24h) all lie ahead.
const EVENT_DATE = ymdFromNow(45);
// Booked now: a lead time just under 45 days, under the 90-day long-lead line.
const SHORT_LEAD_CREATED_AT = isoFromNow(0);
// Booked 75 days ago: a lead time just under 120 days, over the 90-day line.
const LONG_LEAD_CREATED_AT = isoFromNow(-75);

test('schedulePreEventReminders > schedules event_week_reminder (T-7) when proposal moves to deposit_paid', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', $3, '18:00', 'America/Chicago', $4, 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, EVENT_DATE, SHORT_LEAD_CREATED_AT]
  );
  // cc-import (Task 2): scheduleDrinkPlanNudge early-returns when no
  // drink_plans row exists. Seed the row so the nudge schedules below.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [TEST_PROPOSAL_ID]);
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT message_type, channel, recipient_type, recipient_id, status, scheduled_for
     FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
    [TEST_PROPOSAL_ID]
  );
  // Lead time just under 45 days (event 45 days out, booked now). < 90, so no
  // long_lead_t30_recap.
  // schedulePreEventReminders now also schedules the drink-plan nudge (email +
  // SMS) and the event-eve PAIR (sms + its email twin).
  assert.strictEqual(rows.length, 5);
  const ewr = rows.find((r) => r.message_type === 'event_week_reminder');
  assert.ok(ewr, 'event_week_reminder row should exist');
  assert.strictEqual(ewr.channel, 'email');
  assert.strictEqual(ewr.status, 'pending');
  assert.strictEqual(ewr.recipient_type, 'client');
  assert.strictEqual(ewr.recipient_id, TEST_CLIENT_ID);
  assert.deepStrictEqual(
    rows.map((r) => r.message_type).sort(),
    ['drink_plan_nudge', 'drink_plan_nudge_sms', 'event_eve', 'event_eve_email', 'event_week_reminder']
  );
});

test('schedulePreEventReminders > also schedules long_lead_t30_recap when booking lead time >= 90 days', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', $3, '18:00', 'America/Chicago', $4, 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, EVENT_DATE, LONG_LEAD_CREATED_AT]
  );
  // Lead time just under 120 days (event 45 days out, booked 75 days ago), so
  // >= 90 and the T-30 recap joins the five; the event is still ahead, so the
  // event-eve pair is still among them.
  // cc-import (Task 2): seed drink_plans row so the nudge schedules.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [TEST_PROPOSAL_ID]);
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT message_type FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
    [TEST_PROPOSAL_ID]
  );
  assert.deepStrictEqual(rows.map((r) => r.message_type).sort(), [
    'drink_plan_nudge', 'drink_plan_nudge_sms', 'event_eve', 'event_eve_email',
    'event_week_reminder', 'long_lead_t30_recap',
  ]);
});

test('schedulePreEventReminders > is idempotent — calling twice does not duplicate rows', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', $3, '18:00', 'America/Chicago', $4, 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, EVENT_DATE, SHORT_LEAD_CREATED_AT]
  );
  // cc-import (Task 2): seed drink_plans row so the nudge schedules.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [TEST_PROPOSAL_ID]);
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
    [TEST_PROPOSAL_ID]
  );
  // 5 rows: event_week_reminder + drink_plan_nudge + drink_plan_nudge_sms +
  // the event_eve pair (sms + email twin). Short-lead proposal, so no
  // long_lead_t30_recap. Idempotent across two calls.
  assert.strictEqual(rows[0].n, 5);
});

test('schedulePreEventReminders > skips entirely when proposal is archived', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, archive_reason, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'archived', 'client_cancelled', $3, '18:00', 'America/Chicago', $4, 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, EVENT_DATE, SHORT_LEAD_CREATED_AT]
  );
  // Relative like the rest, though this count holds on any date: without the
  // archived guard the event-week reminder (which has no past-date skip) would
  // still be scheduled, so 0 is the guard's doing.
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].n, 0);
});
