require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { isLegacyCcParticipant, isLegacyCcStubUser } = require('./payrollGuards');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollGuards.test.js refuses to run against production');
}

// Pinned negative IDs so fixture rows are unmistakeable and survive partial
// test runs without colliding with real data (mirrors rescheduleProposal.test.js).
const STUB_USER_ID = -901;
const REAL_USER_ID = -902;
const STUB_PROPOSAL_ID = -9001;
const REAL_PROPOSAL_ID = -9002;
const STUB_SHIFT_ID = -9101;
const REAL_SHIFT_ID = -9102;

before(async () => {
  // Hard-reset any leftover rows from a prior aborted run.
  await pool.query('DELETE FROM shift_requests WHERE shift_id IN ($1,$2)', [STUB_SHIFT_ID, REAL_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id IN ($1,$2)', [STUB_SHIFT_ID, REAL_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id IN ($1,$2)', [STUB_PROPOSAL_ID, REAL_PROPOSAL_ID]);
  await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [STUB_USER_ID, REAL_USER_ID]);

  // Stub user — cc_id matches the legacy_cc:<scope>:<id> shape.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, cc_id)
     VALUES ($1, 'guards-stub@example.com', 'x', 'staff', 'legacy_cc:test:abc123')`,
    [STUB_USER_ID]
  );
  // Real user — no cc_id.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'guards-real@example.com', 'x', 'staff')`,
    [REAL_USER_ID]
  );

  // Stub-participant proposal + shift + approved request from the stub user.
  await pool.query(
    `INSERT INTO proposals (id, client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price)
     VALUES ($1, NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4, 1000)`,
    [STUB_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shifts (id, event_date, start_time, status, proposal_id)
     VALUES ($1, CURRENT_DATE, '6:00 PM', 'open', $2)`,
    [STUB_SHIFT_ID, STUB_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [STUB_SHIFT_ID, STUB_USER_ID]
  );

  // Real-only proposal + shift + approved request from the real user.
  await pool.query(
    `INSERT INTO proposals (id, client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price)
     VALUES ($1, NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4, 1000)`,
    [REAL_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shifts (id, event_date, start_time, status, proposal_id)
     VALUES ($1, CURRENT_DATE, '6:00 PM', 'open', $2)`,
    [REAL_SHIFT_ID, REAL_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [REAL_SHIFT_ID, REAL_USER_ID]
  );
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id IN ($1,$2)', [STUB_SHIFT_ID, REAL_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id IN ($1,$2)', [STUB_SHIFT_ID, REAL_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id IN ($1,$2)', [STUB_PROPOSAL_ID, REAL_PROPOSAL_ID]);
  await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [STUB_USER_ID, REAL_USER_ID]);
  await pool.end();
});

test('isLegacyCcStubUser > returns true when cc_id matches legacy_cc:', async () => {
  assert.strictEqual(await isLegacyCcStubUser(STUB_USER_ID), true);
});

test('isLegacyCcStubUser > returns false for a real user with no cc_id', async () => {
  assert.strictEqual(await isLegacyCcStubUser(REAL_USER_ID), false);
});

test('isLegacyCcStubUser > returns false for a non-existent user id', async () => {
  assert.strictEqual(await isLegacyCcStubUser(-999999), false);
});

test('isLegacyCcStubUser > returns false for non-integer userId', async () => {
  assert.strictEqual(await isLegacyCcStubUser(null), false);
  assert.strictEqual(await isLegacyCcStubUser(undefined), false);
  assert.strictEqual(await isLegacyCcStubUser('abc'), false);
  assert.strictEqual(await isLegacyCcStubUser(1.5), false);
});

test('isLegacyCcParticipant > true when an approved shift_request points at a stub user', async () => {
  assert.strictEqual(await isLegacyCcParticipant(STUB_PROPOSAL_ID), true);
});

test('isLegacyCcParticipant > false when all approved requests are real users', async () => {
  assert.strictEqual(await isLegacyCcParticipant(REAL_PROPOSAL_ID), false);
});

test('isLegacyCcParticipant > false for non-integer or missing proposalId', async () => {
  assert.strictEqual(await isLegacyCcParticipant(null), false);
  assert.strictEqual(await isLegacyCcParticipant(undefined), false);
  assert.strictEqual(await isLegacyCcParticipant('abc'), false);
});
