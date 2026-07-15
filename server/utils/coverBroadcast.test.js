require('dotenv').config();
process.env.NODE_ENV = 'test';

// DB-driven tests for broadcastCoverRequest (spec §6.5). Mirrors the
// dev-database harness used elsewhere (messageScheduling.test.js et al).
//
// All test rows are namespaced under fixture email prefixes so a defensive
// cleanup before each suite can drop residue from a prior crashed run without
// risking real data.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { broadcastCoverRequest, parsePositionsNeeded, formatShortDate } = require('./coverBroadcast');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let requesterId;
let teammateId;
let barbackId;
let mutedId;
let busyId;
let managerTeammateId;
let paddedTeammateId;
let clientId;
let proposalId;
let shiftId;

// future date well outside any other test fixture
const EVENT_DATE_OFFSET_DAYS = 90;

async function eventDateValue() {
  const { rows } = await pool.query(`SELECT (CURRENT_DATE + INTERVAL '${EVENT_DATE_OFFSET_DAYS} days')::date AS d`);
  return rows[0].d;
}

before(async () => {
  // Defensive cleanup.
  await pool.query("DELETE FROM users WHERE email LIKE 'cover-broadcast-%'");

  const ph = await bcrypt.hash('x', 4);

  // Requester (excluded from broadcast set).
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`cover-broadcast-requester-${NONCE}@example.com`, ph]
  );
  requesterId = r.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000001', 'Alex Johnson', 'bartender', 25.00)`,
    [requesterId]
  );

  // Qualified teammate (should receive broadcast).
  const tm = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`cover-broadcast-teammate-${NONCE}@example.com`, ph]
  );
  teammateId = tm.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000002', 'Jane Roe', 'bartender', 25.00)`,
    [teammateId]
  );

  // Barback (different position; should NOT be in broadcast for a bartender slot).
  const bb = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`cover-broadcast-barback-${NONCE}@example.com`, ph]
  );
  barbackId = bb.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000003', 'Bob Barback', 'barback', 20.00)`,
    [barbackId]
  );

  // Muted teammate (cover_needed channels empty).
  const mu = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version,
                        staff_notification_preferences)
     VALUES ($1, $2, 'staff', 'approved', 0,
       jsonb_set('{"channels":{"shift_offered":["push","sms","email"],"shift_decided":["push","sms"],"cover_needed":["push"],"beo_finalized":["push","sms","email"],"beo_reminder_t3":["push","sms"],"schedule_change":["push","sms","email"],"payday":["sms","email"],"tip_received":["push"]}}'::jsonb,
                '{channels,cover_needed}',
                '[]'::jsonb))
     RETURNING id`,
    [`cover-broadcast-muted-${NONCE}@example.com`, ph]
  );
  mutedId = mu.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000004', 'Mary Muted', 'bartender', 25.00)`,
    [mutedId]
  );

  // Busy teammate (already approved on a same-date shift; should be excluded).
  const bs = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`cover-broadcast-busy-${NONCE}@example.com`, ph]
  );
  busyId = bs.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000005', 'Bill Busy', 'bartender', 25.00)`,
    [busyId]
  );

  // Manager-bartender teammate (audit 3c W1: managers are a worker class and must
  // receive cover broadcasts like any qualified staffer). Approved, not muted, free.
  const mgr = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'manager', 'approved', 0) RETURNING id`,
    [`cover-broadcast-manager-${NONCE}@example.com`, ph]
  );
  managerTeammateId = mgr.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000006', 'Morgan Manager', 'bartender', 30.00)`,
    [managerTeammateId]
  );

  // B14 (kb-g-trim-align): padded-position teammate. contractor_profiles.position
  // = ' Bartender ' with leading + trailing whitespace — the legacy / imported /
  // direct-edit vector the canonicalizing routes never mint. Seeded via raw SQL.
  // A padded bartender must still bucket to 'bartender' and receive the cover
  // broadcast. Approved, not muted, free — every filter but the position CASE
  // passes, isolating the trim behavior.
  const pt = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`cover-broadcast-padded-${NONCE}@example.com`, ph]
  );
  paddedTeammateId = pt.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5550000007', 'Pat Padded', ' Bartender ', 25.00)`,
    [paddedTeammateId]
  );

  // Client + proposal + shift (the one being covered).
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550001') RETURNING id`,
    [`Cover Broadcast Test ${NONCE}`, `cover-broadcast-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                             event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + ${EVENT_DATE_OFFSET_DAYS}, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location,
                         client_name, positions_needed)
     VALUES (CURRENT_DATE + ${EVENT_DATE_OFFSET_DAYS}, '18:00', '22:00', 'open', $1, '123 Main St',
             'Cover Broadcast Test', '["bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  shiftId = sh.rows[0].id;

  // Approve requester + busy teammate on shifts on the SAME date (different shifts
  // not required: the busy-teammate exclusion checks for any approved+not-dropped
  // shift_request on a shift whose event_date matches).
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, cover_requested_at)
     VALUES ($1, $2, 'approved', 'bartender', NOW())`,
    [shiftId, requesterId]
  );

  // A second shift on the same date that the busy teammate is approved on.
  const sh2 = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location,
                         client_name, positions_needed)
     VALUES (CURRENT_DATE + ${EVENT_DATE_OFFSET_DAYS}, '19:00', '23:00', 'open', $1, '456 Other St',
             'Cover Broadcast Test 2', '["bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'approved', 'bartender')`,
    [sh2.rows[0].id, busyId]
  );
});

beforeEach(async () => {
  // Wipe scheduled_messages tied to our test shift between cases so each test
  // observes a clean enqueue surface.
  await pool.query(
    `DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1`,
    [shiftId]
  );
});

after(async () => {
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1`, [shiftId]);
  await pool.query(
    `DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query(`DELETE FROM shifts WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  const allUserIds = [requesterId, teammateId, barbackId, mutedId, busyId, managerTeammateId, paddedTeammateId].filter(Boolean);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [allUserIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [allUserIds]);
  await pool.end();
});

// ─── Pure-function unit tests ───────────────────────────────────────────────

test('parsePositionsNeeded > parses string-array JSON', () => {
  assert.deepStrictEqual(parsePositionsNeeded('["bartender","barback"]'), ['bartender', 'barback']);
});

test('parsePositionsNeeded > parses object-array JSON', () => {
  assert.deepStrictEqual(
    parsePositionsNeeded('[{"position":"bartender"},{"position":"barback"}]'),
    ['bartender', 'barback']
  );
});

test('parsePositionsNeeded > parses already-parsed array', () => {
  assert.deepStrictEqual(parsePositionsNeeded(['bartender', 'barback']), ['bartender', 'barback']);
});

test('parsePositionsNeeded > parses already-parsed object array', () => {
  assert.deepStrictEqual(
    parsePositionsNeeded([{ position: 'bartender' }, { position: 'barback' }]),
    ['bartender', 'barback']
  );
});

test('parsePositionsNeeded > bare string fallback', () => {
  assert.deepStrictEqual(parsePositionsNeeded('bartender'), ['bartender']);
});

test('parsePositionsNeeded > null/empty default to bartender', () => {
  assert.deepStrictEqual(parsePositionsNeeded(null), ['bartender']);
  assert.deepStrictEqual(parsePositionsNeeded(''), ['bartender']);
});

test('formatShortDate > formats ISO YYYY-MM-DD string', () => {
  // 2026-08-15 is a Saturday
  assert.strictEqual(formatShortDate('2026-08-15'), 'Sat, Aug 15');
});

test('formatShortDate > formats a Date object without off-by-one', () => {
  // Construct a local-midnight Date for 2026-08-15 (the way pg returns DATE columns)
  const d = new Date(2026, 7, 15);
  assert.strictEqual(formatShortDate(d), 'Sat, Aug 15');
});

test('formatShortDate > soon on invalid input', () => {
  assert.strictEqual(formatShortDate(null), 'soon');
  assert.strictEqual(formatShortDate('garbage'), 'soon');
});

// ─── Integration tests against the dev DB ──────────────────────────────────

test('broadcastCoverRequest > broadcasts to qualified bartender, excludes ineligible users', async () => {
  const result = await broadcastCoverRequest(shiftId, requesterId);
  // Shared dev DB may have other qualified bartenders. Assert inclusion of
  // our teammate + exclusion of the requester/barback/muted/busy fixtures.
  assert.strictEqual(result.broadcast_truncated, false);
  assert.ok(result.broadcast_count >= 1, `expected at least 1 broadcast, got ${result.broadcast_count}`);
  const { rows } = await pool.query(
    `SELECT recipient_id, channel, message_type FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY recipient_id`,
    [shiftId]
  );
  const recipientIds = new Set(rows.map((r) => r.recipient_id));
  assert.ok(recipientIds.has(teammateId), 'teammate should be enqueued');
  assert.ok(!recipientIds.has(requesterId), 'requester must be excluded');
  assert.ok(!recipientIds.has(barbackId), 'barback (wrong position) must be excluded');
  assert.ok(!recipientIds.has(mutedId), 'muted user must be excluded');
  assert.ok(!recipientIds.has(busyId), 'busy user (approved on same-date shift) must be excluded');
  for (const row of rows) {
    assert.strictEqual(row.message_type, 'cover_broadcast');
  }
});

test('broadcastCoverRequest > includes a qualified manager-bartender teammate (managers are a worker class)', async () => {
  const result = await broadcastCoverRequest(shiftId, requesterId);
  const { rows } = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2`,
    [shiftId, managerTeammateId]
  );
  assert.ok(rows.length >= 1, 'a qualified manager-bartender must receive the cover broadcast');
  assert.ok(result.broadcast_count >= 1);
});

test('broadcastCoverRequest > includes a bartender teammate whose position is whitespace-padded (" Bartender ")', async () => {
  const result = await broadcastCoverRequest(shiftId, requesterId);
  const { rows } = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2`,
    [shiftId, paddedTeammateId]
  );
  // At HEAD the un-trimmed CASE buckets ' bartender ', which never equals the
  // canonical 'bartender' matchRole, so the padded teammate is dropped (RED).
  // With LOWER(TRIM(cp.position)) it buckets to 'bartender' and is probed (GREEN).
  assert.ok(rows.length >= 1, 'a padded-position bartender teammate must receive the cover broadcast');
  assert.ok(result.broadcast_count >= 1);
});

test('broadcastCoverRequest > returns 0 when shift not found', async () => {
  const result = await broadcastCoverRequest(99999999, requesterId);
  assert.deepStrictEqual(result, { broadcast_count: 0, broadcast_truncated: false });
});

test('broadcastCoverRequest > positions_needed object-array shape is parsed', async () => {
  // Mutate the shift's positions_needed to an object-array; broadcast must still
  // pick up the same qualified teammate (count may be higher in shared dev DB).
  await pool.query(
    `UPDATE shifts SET positions_needed = $1::jsonb WHERE id = $2`,
    ['[{"position":"bartender"}]', shiftId]
  );
  try {
    const result = await broadcastCoverRequest(shiftId, requesterId);
    assert.ok(result.broadcast_count >= 1, `expected at least 1, got ${result.broadcast_count}`);
    const { rows } = await pool.query(
      `SELECT recipient_id FROM scheduled_messages
        WHERE entity_type = 'shift' AND entity_id = $1`,
      [shiftId]
    );
    const recipientIds = new Set(rows.map((r) => r.recipient_id));
    assert.ok(recipientIds.has(teammateId), 'object-array shape still resolves teammate');
  } finally {
    await pool.query(
      `UPDATE shifts SET positions_needed = $1::jsonb WHERE id = $2`,
      ['["bartender"]', shiftId]
    );
  }
});

test('broadcastCoverRequest > excludes teammates muted for cover_needed', async () => {
  // Verified in the main happy-path test (mutedId is NOT in recipients) — also
  // checked here explicitly: re-run, mutedId still absent.
  const result = await broadcastCoverRequest(shiftId, requesterId);
  const { rows } = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2`,
    [shiftId, mutedId]
  );
  assert.strictEqual(rows.length, 0, 'muted user must not receive any row');
  assert.ok(result.broadcast_count >= 1);
});

test('broadcastCoverRequest > excludes teammates already on a same-date approved shift', async () => {
  const result = await broadcastCoverRequest(shiftId, requesterId);
  const { rows } = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2`,
    [shiftId, busyId]
  );
  assert.strictEqual(rows.length, 0, 'busy user must not receive any row');
  assert.ok(result.broadcast_count >= 1);
});
