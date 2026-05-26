require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  renderBartenderList,
  _resolveDisplayName,
  notifyClientOfStaffingConfirmation,
} = require('./lastMinuteStaffingConfirmation');

// ─── Pure renderer tests ─────────────────────────────────────────

test('_resolveDisplayName > preferred_name wins', () => {
  assert.strictEqual(_resolveDisplayName({ preferred_name: 'Alex' }), 'Alex');
});

test('_resolveDisplayName > falls through to generic when preferred_name is null', () => {
  assert.strictEqual(_resolveDisplayName({ preferred_name: null }), 'Your bartender');
});

test('_resolveDisplayName > falls through to generic on missing contractor_profiles row', () => {
  // LEFT JOIN with no contractor_profiles row → both columns are null.
  assert.strictEqual(_resolveDisplayName({ preferred_name: null, phone: null }), 'Your bartender');
});

test('renderBartenderList > 1 bartender with phone', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: 'Alex', phone: '3125551234' }]),
    'Alex ((312) 555-1234)'
  );
});

test('renderBartenderList > 1 bartender no phone', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: 'Alex', phone: null }]),
    'Alex'
  );
});

test('renderBartenderList > 2 bartenders both with phones', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: '3125555678' },
    ]),
    'Alex ((312) 555-1234) and Jordan ((312) 555-5678)'
  );
});

test('renderBartenderList > 3 bartenders Oxford-comma', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: '3125555678' },
      { preferred_name: 'Sam', phone: '3125559012' },
    ]),
    'Alex ((312) 555-1234), Jordan ((312) 555-5678), and Sam ((312) 555-9012)'
  );
});

test('renderBartenderList > 2 bartenders mixed phone presence', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: null },
    ]),
    'Alex ((312) 555-1234) and Jordan'
  );
});

test('renderBartenderList > 1 bartender with phone but null preferred_name', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: null, phone: '3125551234' }]),
    'Your bartender ((312) 555-1234)'
  );
});

// ─── Integration tests for notifyClientOfStaffingConfirmation ────

let clientId;
let proposalId;
let shiftId;
let userId;
let savedRealSendSMS;  // captured once at the start so per-test stubs cannot
                       // be re-captured as "real" by a downstream test.

before(async () => {
  const sms = require('./sms');
  savedRealSendSMS = sms._realSendSMS;
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('LMSC Test', 'lmsc-test@example.com', '3125550190') RETURNING id`
  );
  clientId = c.rows[0].id;
  // No UPDATE needed: clients.communication_preferences defaults to
  // {"sms_enabled":true,"email_enabled":true,"marketing_enabled":true},
  // and clients.email_status / phone_status both default to 'ok' (the
  // CHECK constraint only allows 'ok' or 'bad', so an 'unknown' value
  // would violate the constraint).
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, onboarding_status) VALUES ('lmsc-bartender@example.com', 'x', 'approved') RETURNING id`
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, 'Alex', '3125551234')`,
    [userId]
  );
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, last_minute_hold)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', 'balance_paid', 'birthday-party', true)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, start_time, end_time, location, positions_needed, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', '22:00', 'Test Venue', '["lead"]', 'open')
     RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

function stubSms() {
  const { __setSmsDeps } = require('./sms');
  const calls = [];
  __setSmsDeps({
    sendSMS: async ({ to, body }) => {
      calls.push({ to, body });
      return { sid: `stub-${calls.length}-${Date.now()}` };
    },
  });
  return {
    calls,
    restore: () => __setSmsDeps({ sendSMS: savedRealSendSMS }),
  };
}

test('notifyClientOfStaffingConfirmation > happy path: sends SMS with rendered name + phone', async () => {
  const sms = stubSms();
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 1, 'exactly one SMS send');
    assert.match(sms.calls[0].body, /Your bartender for/);
    assert.match(sms.calls[0].body, /Alex \(\(312\) 555-1234\)/);
    // Defense-in-depth against future template edits.
    assert.ok(!sms.calls[0].body.includes('—'), 'rendered SMS body must not contain an em dash');
    const { rows } = await pool.query(
      "SELECT message_type, status FROM sms_messages WHERE client_id = $1",
      [clientId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].message_type, 'last_minute_staffing_confirmation');
    assert.strictEqual(rows[0].status, 'sent');
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > proposal_missing returns silently', async () => {
  const sms = stubSms();
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(999999999, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > orphan_proposal returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('UPDATE proposals SET client_id = NULL WHERE id = $1', [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > archived status returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > event_date_null returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('UPDATE proposals SET event_date = NULL WHERE id = $1', [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > no_bartenders returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > sms-disabled client gets no SMS (email path still attempts)', async () => {
  const sms = stubSms();
  try {
    // Preserve marketing_enabled so we only flip the sms toggle (matches the
    // schema default of all-three-enabled, just with sms_enabled flipped).
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": false, "email_enabled": true, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0, 'SMS must be suppressed');
  } finally {
    sms.restore();
    // Restore the schema default exactly.
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": true, "email_enabled": true, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
  }
});

test('notifyClientOfStaffingConfirmation > email-disabled client still gets SMS', async () => {
  const sms = stubSms();
  try {
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": true, "email_enabled": false, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 1, 'SMS still fires when only email is disabled');
  } finally {
    sms.restore();
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": true, "email_enabled": true, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
  }
});

test('notifyClientOfStaffingConfirmation > both channels disabled sends nothing', async () => {
  const sms = stubSms();
  try {
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": false, "email_enabled": false, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0, 'SMS must be suppressed');
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM sms_messages WHERE client_id = $1",
      [clientId]
    );
    assert.strictEqual(rows[0].n, 0, 'no sms_messages row should be written');
  } finally {
    sms.restore();
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled": true, "email_enabled": true, "marketing_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
  }
});

test('notifyClientOfStaffingConfirmation > Twilio throw is swallowed (function does not reject)', async () => {
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({ sendSMS: async () => { throw new Error('twilio simulated 500'); } });
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    // sendAndLogSms wrote the failed row before re-throwing; the outer
    // try/catch in notifyClientOfStaffingConfirmation swallowed the throw.
    const { rows } = await pool.query(
      "SELECT status FROM sms_messages WHERE client_id = $1 ORDER BY id DESC LIMIT 1",
      [clientId]
    );
    assert.strictEqual(rows[0].status, 'failed');
  } finally {
    __setSmsDeps({ sendSMS: savedRealSendSMS });
  }
});
