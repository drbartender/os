require('dotenv').config();

// DB-hitting unit tests for server/utils/pendingCall.js — the VA-calling data
// layer. RUN ONE AT A TIME (server suites share the dev DB):
//   node -r dotenv/config --test server/utils/pendingCall.test.js
//
// Uses synthetic, feature-owned rows only. pending_call.user_id / call_audit
// carry no FK (contract), so an arbitrary large BIGINT user_id is safe and
// cannot collide with a real users row. Every row we create is namespaced by a
// per-run NONCE and cleaned up in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const {
  upsertPending,
  claimForDial,
  attachCallSid,
  lookupTargetByCallSid,
  countPlacedSince,
  recordAudit,
  pruneVaCallingRows,
} = require('./pendingCall');

// Unique-ish synthetic user id (BIGINT, no FK). Timestamp keeps it clear of any
// real users.id and of a concurrent run.
const TEST_USER_ID = 900000000000 + (Date.now() % 1000000000);
const NONCE = crypto.randomBytes(4).toString('hex');
const TARGET_A = '+13125550101';
const TARGET_B = '+13125550202';
const SID = `CAtest-${NONCE}`;

async function cleanup() {
  // The prune test uses TEST_USER_ID + {1,2,3}; sweep a small owned range.
  await pool.query('DELETE FROM pending_call WHERE user_id BETWEEN $1 AND $2', [TEST_USER_ID, TEST_USER_ID + 10]);
  await pool.query(
    "DELETE FROM call_audit WHERE call_sid LIKE $1 OR target_e164 IN ($2, $3)",
    [`CAtest-${NONCE}%`, TARGET_A, TARGET_B]
  );
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('upsertPending inserts, then REPLACES the row on conflict (new target wins)', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });

  let { rows } = await pool.query(
    'SELECT target_e164, status, call_sid FROM pending_call WHERE user_id = $1',
    [TEST_USER_ID]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_e164, TARGET_A);
  assert.equal(rows[0].status, 'awaiting_confirm');
  assert.equal(rows[0].call_sid, null);

  // Send a new target before confirming — must replace, not duplicate, and must
  // reset status/call_sid.
  await pool.query('UPDATE pending_call SET status=$2, call_sid=$3 WHERE user_id=$1', [
    TEST_USER_ID, 'dialing', 'CAstale',
  ]);
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_B, ttlSeconds: 120 });

  ({ rows } = await pool.query(
    'SELECT target_e164, status, call_sid FROM pending_call WHERE user_id = $1',
    [TEST_USER_ID]
  ));
  assert.equal(rows.length, 1, 'exactly one pending row per user (unique constraint)');
  assert.equal(rows[0].target_e164, TARGET_B);
  assert.equal(rows[0].status, 'awaiting_confirm', 'status reset by upsert');
  assert.equal(rows[0].call_sid, null, 'call_sid cleared by upsert');
});

test('claimForDial returns the row ONCE, then null (single-dial guarantee)', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });

  const first = await claimForDial(TEST_USER_ID);
  assert.ok(first, 'first claim wins');
  assert.equal(first.targetE164, TARGET_A);
  assert.equal(typeof first.id, 'number');

  const second = await claimForDial(TEST_USER_ID);
  assert.equal(second, null, 'second claim finds no awaiting_confirm row — no double dial');
});

test('claimForDial returns null for an expired pending row', async () => {
  // Negative TTL => already expired.
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: -30 });
  const claim = await claimForDial(TEST_USER_ID);
  assert.equal(claim, null, 'expired row is not claimable');
});

test('attachCallSid + lookupTargetByCallSid round-trip; unknown sid => null', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });
  const claim = await claimForDial(TEST_USER_ID);
  assert.ok(claim);

  await attachCallSid(claim.id, SID);
  assert.equal(await lookupTargetByCallSid(SID), TARGET_A);
  assert.equal(await lookupTargetByCallSid(`CAtest-${NONCE}-nope`), null);
});

test('countPlacedSince counts only status=placed inside the window', async () => {
  const before24 = await countPlacedSince('24 hours');

  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_A, callSid: `CAtest-${NONCE}-1`, status: 'placed' });
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_A, callSid: `CAtest-${NONCE}-2`, status: 'placed' });
  // Non-placed rows must NOT be counted.
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_B, callSid: `CAtest-${NONCE}-3`, status: 'rejected_cap' });
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_B, callSid: `CAtest-${NONCE}-4`, status: 'failed' });

  const after24 = await countPlacedSince('24 hours');
  assert.equal(after24 - before24, 2, 'only the two placed rows are counted');

  // Deterministic window-boundary check (no wall-clock race): pin an explicitly
  // 48h-old placed row via created_at, anchored to a fixed marker rather than
  // sub-millisecond scheduling latency. It must fall OUTSIDE a 24h window but
  // INSIDE a 72h window.
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, call_sid, status, created_at)
     VALUES ($1, $2, $3, 'placed', NOW() - INTERVAL '48 hours')`,
    [TEST_USER_ID, TARGET_A, `CAtest-${NONCE}-old`]
  );
  const win24 = await countPlacedSince('24 hours');
  const win72 = await countPlacedSince('72 hours');
  assert.equal(win24, after24, 'a 48h-old row is outside the 24h window');
  assert.equal(win72 - win24 >= 1, true, 'a 48h-old row is inside the 72h window');

  const n = Number(await countPlacedSince('24 hours'));
  assert.equal(Number.isInteger(n), true, 'returns a JS number, not a string');
});

test('pruneVaCallingRows removes expired pending_call rows and returns a count', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: -30 });
  const deleted = await pruneVaCallingRows();
  assert.equal(typeof deleted, 'number');

  const { rows } = await pool.query('SELECT 1 FROM pending_call WHERE user_id = $1', [TEST_USER_ID]);
  assert.equal(rows.length, 0, 'expired pending row pruned');
});

test('pruneVaCallingRows keeps an in-flight dialing row but prunes expired-confirm and stale-dialing rows', async () => {
  const U_SURVIVE = TEST_USER_ID + 1; // dialing, TTL already lapsed but created recently — still bridging
  const U_EXPIRED = TEST_USER_ID + 2; // awaiting_confirm past expiry — unclaimable
  const U_STALE = TEST_USER_ID + 3;   // dialing but created 3h ago — call long over

  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, $2, 'dialing', NOW() - INTERVAL '30 seconds', NOW())`,
    [U_SURVIVE, TARGET_A]
  );
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, $2, 'awaiting_confirm', NOW() - INTERVAL '30 seconds', NOW())`,
    [U_EXPIRED, TARGET_B]
  );
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, $2, 'dialing', NOW() + INTERVAL '30 minutes', NOW() - INTERVAL '3 hours')`,
    [U_STALE, TARGET_A]
  );

  await pruneVaCallingRows();

  const surv = await pool.query('SELECT 1 FROM pending_call WHERE user_id = $1', [U_SURVIVE]);
  const exp = await pool.query('SELECT 1 FROM pending_call WHERE user_id = $1', [U_EXPIRED]);
  const stale = await pool.query('SELECT 1 FROM pending_call WHERE user_id = $1', [U_STALE]);
  assert.equal(surv.rows.length, 1, 'in-flight dialing row (recent created_at) survives prune — /bridge still needs it');
  assert.equal(exp.rows.length, 0, 'expired awaiting_confirm row is pruned');
  assert.equal(stale.rows.length, 0, '3-hour-old dialing row is pruned by the 2h backstop');
});

test('pruneVaCallingRows removes terminal voicemail rows and keeps undelivered ones', async () => {
  // RETENTION_DAYS is 30; 400 days is comfortably past it either way.
  const delivered = `CAvmprune-${NONCE}-delivered`;
  const stuck = `CAvmprune-${NONCE}-failed`;
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, status, created_at)
     VALUES ($1, 'delivered', NOW() - INTERVAL '400 days'),
            ($2, 'failed',    NOW() - INTERVAL '400 days')`,
    [delivered, stuck]
  );
  try {
    await pruneVaCallingRows();
    const { rows } = await pool.query(
      'SELECT call_sid FROM voicemail_delivery WHERE call_sid IN ($1, $2)',
      [delivered, stuck]
    );
    assert.deepEqual(
      rows.map((r) => r.call_sid),
      [stuck],
      'a failed row survives retention: it is the only pointer to audio still in Twilio'
    );
  } finally {
    await pool.query('DELETE FROM voicemail_delivery WHERE call_sid IN ($1, $2)', [delivered, stuck]);
  }
});

test('pruneVaCallingRows prunes aged missed rows but never a skipped one', async () => {
  // 'missed' is the most common outcome (caller hangs up during the greeting,
  // so recordingStatusCallback never fires and recording_sid stays NULL). Not
  // pruning it grew the table without bound and held caller PII past retention.
  // 'skipped' is the opposite: the recording was deliberately RETAINED in
  // Twilio, so the row is the only pointer to it.
  const missed = `CAvmprune-${NONCE}-missed`;
  const skipped = `CAvmprune-${NONCE}-skipped`;
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, status, recording_sid, created_at)
     VALUES ($1, 'missed',  NULL,             NOW() - INTERVAL '400 days'),
            ($2, 'skipped', 'RE' || repeat('a', 32), NOW() - INTERVAL '400 days')`,
    [missed, skipped]
  );
  try {
    await pruneVaCallingRows();
    const { rows } = await pool.query(
      'SELECT call_sid FROM voicemail_delivery WHERE call_sid IN ($1, $2)',
      [missed, skipped]
    );
    assert.deepEqual(
      rows.map((r) => r.call_sid),
      [skipped],
      'skipped means the audio is still in the console; pruning it erases the only pointer'
    );
  } finally {
    await pool.query('DELETE FROM voicemail_delivery WHERE call_sid IN ($1, $2)', [missed, skipped]);
  }
});
