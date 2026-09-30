require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const reaper = require('./consultCallReaper');

// ─── consult call reaper (spec 2026-08-25 section 4.2; moved and given a
// second arm by spec 2026-09-30 sections 4.3 and 4.4) ────────────────────
// Both arms are TABLE-WIDE by design, so every assertion is scoped to this
// run's ids. Shared dev DB: run this suite ALONE.

// A STABLE prefix, so cleanup can scope itself with one LIKE and still mop up
// after a run that crashed before its after() hook.
const PREFIX = 'ccr-consult-reap-';
const SAVED = {
  CONSULT_CALL_ENABLED: process.env.CONSULT_CALL_ENABLED,
  VA_CALL_TIME_LIMIT_SEC: process.env.VA_CALL_TIME_LIMIT_SEC,
};

async function cleanup() {
  await pool.query(
    `DELETE FROM consult_call_attempts WHERE consult_id IN
       (SELECT id FROM consults WHERE calcom_event_id LIKE $1)`,
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${PREFIX}%`]);
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  reaper.__setDeps({ pool, sendChainEmail: (...a) => require('./consultCallChain').sendChainEmail(...a) });
});

// Explicit column list: dev and prod disagree on consults column ORDER.
async function mkConsult(tag, minutesPastSlot) {
  const { rows } = await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email, booker_phone)
     VALUES ($1, NOW() - make_interval(mins => $2::int), 'scheduled',
             'Reaper Test', 'ccr-reap@example.test', '+17735550188')
     RETURNING id`,
    [`${PREFIX}${Date.now()}-${tag}-${Math.floor(Math.random() * 1e6)}`, minutesPastSlot]
  );
  return rows[0].id;
}

// scheduled_at copied IN SQL (ruling R12). next_ring_at non-null so the stale
// arm's next_ring_at = NULL is observable.
async function mkConsultAttempt(consultId, status) {
  const { rows } = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, next_ring_at)
     SELECT c.id, c.scheduled_at, $2, NOW() + INTERVAL '1 minute'
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, status]
  );
  return Number(rows[0].id);
}

// A press-1 row: connected, answered by Dallas, bridge started this many
// seconds ago, with or without either report of the client leg.
async function mkBridge(tag, { startedSecAgo, duration = null, noAnswer = false }) {
  const consultId = await mkConsult(tag, Math.ceil(startedSecAgo / 60) + 1);
  const { rows } = await pool.query(
    `INSERT INTO consult_call_attempts
       (consult_id, scheduled_at, status, answered_by, bridge_started_at, bridge_duration_sec, client_no_answer_at)
     SELECT c.id, c.scheduled_at, 'connected', 'admin',
            NOW() - make_interval(secs => $2::int), $3::int,
            CASE WHEN $4::boolean THEN NOW() ELSE NULL END
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, startedSecAgo, duration, noAnswer]
  );
  return Number(rows[0].id);
}

async function rowsById(ids) {
  const { rows } = await pool.query(
    'SELECT id, status, detail, next_ring_at FROM consult_call_attempts WHERE id = ANY($1)', [ids]
  );
  return Object.fromEntries(rows.map((r) => [Number(r.id), r]));
}

function recorder() {
  const emails = [];
  reaper.__setDeps({ pool, sendChainEmail: async (args) => { emails.push(args); } });
  return emails;
}

// ── the stale arm (moved from vaCallingScheduler.test.js, behavior unchanged) ─

test('stale arm (enabled): stale pending and calling_va rows fail as stale_reaped, emailed once each', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  const emails = recorder();
  const stalePending = await mkConsultAttempt(await mkConsult('p', 45), 'pending');
  const staleVa = await mkConsultAttempt(await mkConsult('v', 45), 'calling_va');
  const mine = [stalePending, staleVa];

  await reaper.reapStaleConsultCallAttempts();

  const byId = await rowsById(mine);
  for (const id of mine) {
    assert.equal(byId[id].status, 'failed', `stale row ${id} reaped`);
    assert.equal(byId[id].detail, 'stale_reaped');
    assert.equal(byId[id].next_ring_at, null, 'a reaped chain must never ring again');
  }
  const mineEmailed = emails.filter((e) => mine.includes(e.attemptId));
  assert.equal(mineEmailed.length, 2, 'exactly one email per reaped row');
  assert.deepEqual([...new Set(mineEmailed.map((e) => e.attemptId))].sort(), [...mine].sort());
  assert.ok(mineEmailed.every((e) => e.reason === 'call failed'));
});

test('stale arm (enabled): a connected bridge and a five-minute-old slot are untouched', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  const emails = recorder();
  const connected = await mkConsultAttempt(await mkConsult('c', 45), 'connected');
  const fresh = await mkConsultAttempt(await mkConsult('f', 5), 'pending');
  const mine = [connected, fresh];

  await reaper.reapStaleConsultCallAttempts();

  const byId = await rowsById(mine);
  assert.equal(byId[connected].status, 'connected', 'the stale arm never touches a bridge');
  assert.equal(byId[connected].detail, null);
  assert.equal(byId[fresh].status, 'pending', 'five minutes past the slot, the chain may still be mid-ring');
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

test('stale arm (switch off): stale rows are parked skipped_disabled, ZERO emails, and stay quiet when it comes back on', async () => {
  process.env.CONSULT_CALL_ENABLED = 'false';
  const emails = recorder();
  const stalePending = await mkConsultAttempt(await mkConsult('dp', 45), 'pending');
  const staleVa = await mkConsultAttempt(await mkConsult('dv', 45), 'calling_va');
  const mine = [stalePending, staleVa];

  await reaper.reapStaleConsultCallAttempts();

  let byId = await rowsById(mine);
  for (const id of mine) {
    assert.equal(byId[id].status, 'skipped_disabled', `row ${id} is parked, not failed`);
    assert.equal(byId[id].detail, 'stale_reaped');
    assert.equal(byId[id].next_ring_at, null);
  }
  assert.equal(emails.length, 0, 'the kill switch silences the alert too');

  process.env.CONSULT_CALL_ENABLED = 'true';
  await reaper.reapStaleConsultCallAttempts();
  await reaper.reapUnconfirmedBridges();
  byId = await rowsById(mine);
  for (const id of mine) assert.equal(byId[id].status, 'skipped_disabled', 'a parked row is never reaped later');
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

// ── the bridge arm (spec 2026-09-30 section 4.3) ────────────────────────────

test('bridge arm: a press-1 with no report of the client leg past the limit flips to failed and emails once', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  const emails = recorder();
  const silent = await mkBridge('silent', { startedSecAgo: 1800 + reaper.BRIDGE_GRACE_SEC + 60 });

  await reaper.reapUnconfirmedBridges();
  await reaper.reapUnconfirmedBridges();

  const byId = await rowsById([silent]);
  assert.equal(byId[silent].status, 'failed');
  assert.equal(byId[silent].detail, 'bridge_unconfirmed');
  const mine = emails.filter((e) => e.attemptId === silent);
  assert.equal(mine.length, 1, 'flipped once, emailed once, however many passes run');
  assert.equal(mine[0].reason, 'bridge unconfirmed');
});

test('bridge arm: a duration, a no-answer latch, or time still inside the limit leaves the row connected', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  const emails = recorder();
  const withDuration = await mkBridge('dur', { startedSecAgo: 3000, duration: 0 });
  const withLatch = await mkBridge('latch', { startedSecAgo: 3000, noAnswer: true });
  const young = await mkBridge('young', { startedSecAgo: 1800 + reaper.BRIDGE_GRACE_SEC - 60 });
  const mine = [withDuration, withLatch, young];

  await reaper.reapUnconfirmedBridges();

  const byId = await rowsById(mine);
  for (const id of mine) assert.equal(byId[id].status, 'connected', `row ${id} untouched`);
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

test('bridge arm: the limit follows VA_CALL_TIME_LIMIT_SEC', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  process.env.VA_CALL_TIME_LIMIT_SEC = '600';
  const emails = recorder();
  const past = await mkBridge('short-limit', { startedSecAgo: 600 + reaper.BRIDGE_GRACE_SEC + 60 });

  await reaper.reapUnconfirmedBridges();

  assert.equal((await rowsById([past]))[past].status, 'failed');
  assert.equal(emails.filter((e) => e.attemptId === past).length, 1);
});

test('bridge arm: with the switch off it writes nothing and emails nothing', async () => {
  process.env.CONSULT_CALL_ENABLED = 'false';
  const emails = recorder();
  const silent = await mkBridge('off', { startedSecAgo: 1800 + reaper.BRIDGE_GRACE_SEC + 60 });

  assert.equal(await reaper.reapUnconfirmedBridges(), 0);
  assert.equal((await rowsById([silent]))[silent].status, 'connected');
  assert.equal(emails.length, 0);
});
