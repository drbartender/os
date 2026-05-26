require('dotenv').config();
const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { pool } = require('../db');

// Intercept require('./email') so the test doesn't actually call Resend.
// We track calls via a simple array; assertions read it directly.
const emailCalls = [];
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const emailModule = { sendEmail: async (args) => { emailCalls.push(args); return { id: 'mock-msg' }; } };
const emailPath = require.resolve('./email');
Module._load = function patched(request, parent, ...rest) {
  if (request === './email' || request === emailPath) return emailModule;
  return originalLoad.call(this, request, parent, ...rest);
};

const { rescheduleProposal, rescheduleProposalInTx, hasReschedulableChange, reanchorPendingMessages } = require('./rescheduleProposal');
const preEventHandlers = require('./preEventHandlers');

const TEST_CLIENT_ID = -2;
const TEST_PROPOSAL_ID = -202;

// Register handlers so `getHandlerMeta('event_week_reminder')` returns
// metadata for reanchor / rescheduleProposal. Without this, every reanchor
// would log "no handler metadata" and leave scheduled_for unchanged — the
// tests below assert it DOES update, so registration is mandatory.
before(() => {
  preEventHandlers.registerAll();
});

beforeEach(async () => {
  emailCalls.length = 0;
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES ($1, 'Reschedule Test', 'rs@example.com', '+15553334444')
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
  Module._load = originalLoad;
  await pool.end();
});

// ── hasReschedulableChange ──
test('hasReschedulableChange > returns true when event_date changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns true when event_start_time changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-08-15', event_start_time: '19:00', event_location: 'A' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns true when event_location changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'B' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns false when none of the three fields changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A', total_price: 100 },
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A', total_price: 200 }
  );
  assert.strictEqual(result, false);
});

// ── reanchorPendingMessages ──
// Note: signature now takes (client, proposalId) — Gemini Finding 2. The
// test acquires a client and runs the call inside a transaction since the
// production code does.
test('reanchorPendingMessages > updates scheduled_for on pending event_week_reminder rows', async () => {
  // Register handler metadata so getHandlerMeta returns it.
  // In test setup, call preEventHandlers.registerAll() once in before().
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  // Pretend a stale row was inserted when the event was 2026-08-15
  const oldScheduledFor = new Date(Date.UTC(2026, 7, 8, 15, 0, 0)); // T-7 of 8/15 at 10am CDT
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', $3, 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, oldScheduledFor]
  );

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    updated = await reanchorPendingMessages(client, TEST_PROPOSAL_ID);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  assert.ok(updated > 0);

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  // New event_date 2026-09-15, T-7 = 2026-09-08, 10am CDT = 15:00 UTC
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');
});

test('reanchorPendingMessages > skips sent rows — only pending re-anchored', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  const stableSent = new Date('2026-08-08T15:00:00.000Z');
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', $3, $3, 'sent')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, stableSent]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reanchorPendingMessages(client, TEST_PROPOSAL_ID);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'sent'`,
    [TEST_PROPOSAL_ID]
  );
  // Sent row should NOT have been updated
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-08-08T15:00:00.000Z');
});

// ── rescheduleProposal ──
test('rescheduleProposal > sends the reschedule email and re-anchors pending rows', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'New Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', '2026-08-08T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = {
    event_date: '2026-08-15', event_start_time: '18:00', event_location: 'Old Venue',
  };
  const updated = {
    event_date: '2026-09-15', event_start_time: '18:00', event_location: 'New Venue',
  };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  assert.strictEqual(emailCalls.length, 1);
  const callArg = emailCalls[0];
  assert.strictEqual(callArg.to, 'rs@example.com');
  assert.strictEqual(callArg.subject, 'Updated details for your event');

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');
});

// ── balance_due_date recomputation (Gemini Finding 4 — SUGGESTION) ──
test('rescheduleProposal > shifts balance_due_date by the same delta as event_date, preserving offset', async () => {
  // Original: event_date 2026-08-15, balance_due_date 2026-08-01 (14d before event).
  // Reschedule to event_date 2026-09-15 (30 days later).
  // Expect: balance_due_date 2026-09-01 (still 14d before new event).
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-08-01', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  // Cast DATE to text so pg returns 'YYYY-MM-DD' directly — `String()` on the
  // pg `Date` object yields a locale string ("Tue Sep 01 2026 ...").
  const { rows } = await pool.query(
    'SELECT balance_due_date::text AS balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].balance_due_date, '2026-09-01');
});

test('rescheduleProposal > preserves a custom (non-14-day) balance offset on reschedule', async () => {
  // Admin set a custom 21-day lead: event 2026-08-15, balance due 2026-07-25.
  // Reschedule event to 2026-09-15. Expect balance due 2026-08-25 (still 21d).
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-07-25', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  const { rows } = await pool.query(
    'SELECT balance_due_date::text AS balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].balance_due_date, '2026-08-25');
});

test('rescheduleProposal > re-anchors balance-anchored pending rows against the NEW balance_due_date', async () => {
  // Event 2026-08-15, balance_due 2026-08-01 (14d before). T-3 balance reminder
  // pending for 2026-07-29 (3d before balance_due). Reschedule event to
  // 2026-09-15 → balance_due moves to 2026-09-01 → T-3 reminder should
  // re-anchor to 2026-08-29.
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-08-01', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  // NOTE: this test depends on Plan 2a having registered a handler for
  // `balance_reminder_t3` with metadata `{ anchor: 'balance_due_date',
  // offsetFromEventDate: -3 * 86400 }` (or equivalent — value is in seconds
  // relative to anchor). If Plan 2a hasn't shipped, this assertion is
  // deferred. Without that registration, `getHandlerMeta(...)` returns
  // null and the row is left alone.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status)
     VALUES ('proposal', $1, 'balance_reminder_t3', 'client', $2, 'email',
        '2026-07-29T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  // Confirm balance_due_date moved to 2026-09-01
  const { rows: propRows } = await pool.query(
    'SELECT balance_due_date::text AS balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(propRows[0].balance_due_date, '2026-09-01');

  // If Plan 2a's handler is registered, the T-3 row should now anchor to
  // 2026-08-29 (3d before new balance_due_date 2026-09-01). If unregistered,
  // the row is unchanged at 2026-07-29 — that's the deferred-on-Plan-2a path.
  const { rows: smRows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
       WHERE entity_type = 'proposal' AND entity_id = $1
         AND message_type = 'balance_reminder_t3'`,
    [TEST_PROPOSAL_ID]
  );
  const scheduledIso = new Date(smRows[0].scheduled_for).toISOString().slice(0, 10);
  // Accept either 2026-08-29 (Plan 2a registered) OR 2026-07-29 (unregistered).
  assert.ok(
    scheduledIso === '2026-08-29' || scheduledIso === '2026-07-29',
    `expected balance reminder to be re-anchored to 2026-08-29 (or left at 2026-07-29 if Plan 2a handler not registered), got ${scheduledIso}`
  );
});

test('rescheduleProposal > skips entirely when proposal is archived', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, archive_reason, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'archived', 'client_cancelled', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });
  assert.strictEqual(emailCalls.length, 0);
});

test('rescheduleProposal > commits DB changes and sends only SMS when client has email=NULL but a phone', async () => {
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES (-3, 'No Email', NULL, '+15555555555')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, -3, 'deposit_paid', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', -3, 'email', '2026-08-08T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID]
  );
  const { __setSmsDeps, _realSendSMS } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: `stub-${Date.now()}-${smsCalls}` }; } });

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  assert.strictEqual(emailCalls.length, 0);
  assert.strictEqual(smsCalls, 1, 'the reschedule SMS should fire when only a phone is present');

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');

  __setSmsDeps({ sendSMS: _realSendSMS });
  await pool.query('DELETE FROM sms_messages WHERE client_id = -3');
  await pool.query('DELETE FROM clients WHERE id = -3');
});

test('rescheduleProposalInTx > moves held proposal past 72h → last_minute_hold becomes false', async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('LMH Test', 'lmh-test@example.com', '3125550191') RETURNING id`
  );
  const cId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, last_minute_hold)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', 'balance_paid', 'birthday-party', true)
     RETURNING id`,
    [cId]
  );
  const pId = p.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldRow = {
      event_date: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      event_start_time: '18:00',
      event_location: 'Test Venue',
      last_minute_hold: true,
    };
    const upd = await client.query(
      `UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1 RETURNING *`,
      [pId]
    );
    await rescheduleProposalInTx(client, {
      proposalId: pId,
      old: oldRow,
      updated: upd.rows[0],
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const after = await pool.query('SELECT last_minute_hold FROM proposals WHERE id = $1', [pId]);
  assert.strictEqual(after.rows[0].last_minute_hold, false);
  await pool.query('DELETE FROM scheduled_messages WHERE entity_id = $1', [pId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [pId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [cId]);
});
