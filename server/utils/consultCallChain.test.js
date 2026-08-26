require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const chain = require('./consultCallChain');
const { clockTimeWithMinutes } = require('./consultCallBriefing');
const { API_URL } = require('./urls');

// ─── consult call chain: the OPEN side ───────────────────────────
// Shared dev DB (this suite runs ALONE). Twilio, email and SMS are stubbed via
// __setDeps; the DB is real, so the (consult_id, scheduled_at) UNIQUE, the
// atomic cap statement and the min-id email dedupe are exercised for real.
//
// EVERY fixture slot carries microseconds (.123456), deliberately. node-pg
// hands a TIMESTAMPTZ back as a millisecond-precision JS Date, so a value that
// round-trips through JS comes back truncated (verified against this database:
// '10:11:12.123456+00' becomes '10:11:12.123+00'). A chain row written from
// such a value matches neither the sweep's anti-join nor the UNIQUE, and the
// sweep then re-opens the consult on every 60 second tick. Ruling R12 forbids
// the round-trip; microsecond fixtures make a regression fail loudly.
//
// Cap counting and the min-id email bound are GLOBAL over this database, so
// every cap assertion is taken relative to a freshly measured baseline and
// every fixture cleans up after itself.

const RUN = `ccc-test-${Date.now()}`;
const VALID_PHONE = '+12563281203';
const consultIds = [];

let emails = [];
let texts = [];
let placed = [];

const ENV_KEYS = [
  'CONSULT_CALL_ENABLED', 'CONSULT_CALL_DAILY_CAP',
  'ADMIN_PHONE', 'VA_CELL', 'VM_TEXT_DESTINATION', 'TWILIO_PHONE_NUMBER',
  'VA_CALL_TIME_LIMIT_SEC',
];
const savedEnv = {};

// The fire side dials env values VERBATIM (dial-target law), so the suite pins
// its own rather than reading whatever this box happens to carry. Twilio, SMS
// and email are stubbed through __setDeps regardless, and NODE_ENV is not
// production, so nothing here can reach a real phone.
const ADMIN_PHONE = '+13125550142';
const VA_CELL = '+639171234567';
const TEXT_DEST = '+13125550199';
const TWILIO_FROM = '+12245550100';

/**
 * One consults fixture. Explicit column list (column ORDER differs between a
 * fresh database and dev/prod, per the C1 carry-forward). The slot is built in
 * SQL so it always carries sub-millisecond precision.
 */
async function makeConsult(tag, opts = {}) {
  const {
    phone = VALID_PHONE,
    offsetSec = 7200,
    status = 'scheduled',
    email = `${RUN}-${tag}@example.test`,
    name = 'Test Booker',
  } = opts;
  const r = await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email, booker_phone)
     VALUES ($1,
             date_trunc('second', NOW()) + make_interval(secs => $2) + INTERVAL '123456 microseconds',
             $3, $4, $5, $6)
     RETURNING id`,
    [`${RUN}-${tag}`, offsetSec, status, name, email, phone]
  );
  consultIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function slotOf(consultId) {
  const r = await pool.query('SELECT scheduled_at FROM consults WHERE id = $1', [consultId]);
  return r.rows[0].scheduled_at;
}

async function attemptsFor(consultId) {
  const r = await pool.query(
    'SELECT * FROM consult_call_attempts WHERE consult_id = $1 ORDER BY id', [consultId]
  );
  return r.rows;
}

/** Cap headroom: non-skipped chain rows inside the rolling 24h window. */
async function nonSkippedCount() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM consult_call_attempts
     WHERE created_at > NOW() - INTERVAL '24 hours' AND status NOT LIKE 'skipped%'`
  );
  return r.rows[0].n;
}

/**
 * Drop only OUR cap markers: a live one suppresses a later test's cap email.
 * BOTH markers, because each caps a different thing and each gates its own
 * email on being the MIN id in the window, so a surviving dial marker silences
 * a later dial-cap test exactly as a surviving chain marker would.
 */
async function clearCapMarkers() {
  await pool.query(
    `DELETE FROM consult_call_attempts
      WHERE detail IN ('cap_tripped', 'dial_cap_tripped') AND consult_id = ANY($1)`,
    [consultIds]
  );
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.CONSULT_CALL_ENABLED;
  delete process.env.CONSULT_CALL_DAILY_CAP;
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  process.env.ADMIN_PHONE = ADMIN_PHONE;
  process.env.VA_CELL = VA_CELL;
  process.env.VM_TEXT_DESTINATION = TEXT_DEST;
  process.env.TWILIO_PHONE_NUMBER = TWILIO_FROM;
});

beforeEach(() => {
  emails = [];
  texts = [];
  placed = [];
  chain.__setDeps({
    pool,
    placeBridgedCall: async (opts) => { placed.push(opts); return { sid: `CA_stub_${placed.length}` }; },
    cancelBridgedCall: async () => ({}),
    notifyAdminCategory: async (opts) => { emails.push(opts); return { emailed: 1 }; },
    sendSMS: async (opts) => { texts.push(opts); return { ok: true }; },
  });
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Attempt rows cascade with the consults.
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${RUN}-%`]);
  await pool.end();
});

// ─── constants and gates ─────────────────────────────────────────

test('ring plan constants and the two gates read exactly as specified', () => {
  assert.deepEqual(chain.RING_OFFSETS_SEC, { 1: -90, 2: 60, 3: 180 });
  assert.equal(chain.MAX_ADMIN_RINGS, 3);
  assert.equal(chain.ADMIN_RING_SECONDS, 20);
  assert.equal(chain.VA_RING_SECONDS, 25);
  assert.equal(chain.OPEN_AHEAD_MINUTES, 5);
  assert.equal(chain.OPEN_BEHIND_MINUTES, 3);
  assert.equal(chain.MISSED_WINDOW_MINUTES, 30);
  assert.equal(chain.TOO_LATE_ADMIN_SEC, 600);
  assert.equal(chain.TOO_LATE_VA_SEC, 720);
  assert.equal(chain.STALE_MINUTES, 30);

  delete process.env.CONSULT_CALL_DAILY_CAP;
  assert.equal(chain.dailyCap(), 10, 'unset falls back to 10, never NaN');
  process.env.CONSULT_CALL_DAILY_CAP = '0';
  assert.equal(chain.dailyCap(), 10, '0 is treated as unset, never count < 0');
  process.env.CONSULT_CALL_DAILY_CAP = 'banana';
  assert.equal(chain.dailyCap(), 10, 'garbage never becomes count < NaN');
  process.env.CONSULT_CALL_DAILY_CAP = '7';
  assert.equal(chain.dailyCap(), 7);
  delete process.env.CONSULT_CALL_DAILY_CAP;

  assert.equal(chain.isEnabled(), true, 'default on');
  process.env.CONSULT_CALL_ENABLED = 'true';
  assert.equal(chain.isEnabled(), true);
  process.env.CONSULT_CALL_ENABLED = 'false';
  assert.equal(chain.isEnabled(), false, 'only the literal false disables');
  delete process.env.CONSULT_CALL_ENABLED;
});

// ─── consultCallTail ─────────────────────────────────────────────

test('tail: CONSULT_CALL_ENABLED=false inserts nothing and emails nothing', async () => {
  const id = await makeConsult('kill', { phone: '+442071234567' });
  process.env.CONSULT_CALL_ENABLED = 'false';
  try {
    await chain.consultCallTail({
      consultId: id, scheduledAt: await slotOf(id), bookerPhone: '+442071234567',
      triggerEvent: 'BOOKING_CREATED',
    });
  } finally {
    delete process.env.CONSULT_CALL_ENABLED;
  }
  assert.deepEqual(await attemptsFor(id), []);
  assert.equal(emails.length, 0);
});

test('tail: a slot already in the past inserts nothing', async () => {
  const id = await makeConsult('past', { phone: '+442071234567', offsetSec: -60 });
  await chain.consultCallTail({
    consultId: id, scheduledAt: await slotOf(id), bookerPhone: '+442071234567',
    triggerEvent: 'BOOKING_CREATED',
  });
  assert.deepEqual(await attemptsFor(id), []);
  assert.equal(emails.length, 0);
});

test('tail: a missing consultId or slot is a silent no-op', async () => {
  await assert.doesNotReject(chain.consultCallTail({ consultId: null, scheduledAt: new Date(Date.now() + 7200000) }));
  await assert.doesNotReject(chain.consultCallTail({ consultId: 1, scheduledAt: null }));
  assert.equal(emails.length, 0);
});

test('tail: an undialable number files once across two calls and emails exactly once', async () => {
  const pre = await pool.query(
    `SELECT COUNT(*)::int AS n FROM consult_call_attempts
     WHERE status = 'skipped_invalid_phone' AND created_at > NOW() - INTERVAL '24 hours'`
  );
  assert.equal(pre.rows[0].n, 0,
    'precondition: no skipped_invalid_phone rows in the rolling window (a crashed earlier run leaves some behind; delete its consults first)');

  const id = await makeConsult('bad-uk', { phone: '+442071234567' });
  const slot = await slotOf(id);
  await chain.consultCallTail({ consultId: id, scheduledAt: slot, bookerPhone: '+442071234567', triggerEvent: 'BOOKING_CREATED' });
  await chain.consultCallTail({ consultId: id, scheduledAt: slot, bookerPhone: '+442071234567', triggerEvent: 'BOOKING_CREATED' });

  const rows = await attemptsFor(id);
  assert.equal(rows.length, 1, 'the duplicate webhook files no second row');
  assert.equal(rows[0].status, 'skipped_invalid_phone');
  assert.equal(rows[0].detail, 'invalid_phone');
  assert.equal(emails.length, 1, 'the duplicate webhook sends no second email');
  assert.equal(emails[0].category, 'lead_call');
  assert.ok(emails[0].subject.includes('undialable number'), emails[0].subject);
  assert.ok(emails[0].emailText.includes('+442071234567'),
    'the raw typed number rides on the email: nobody else surfaces it');
  assert.equal(placed.length, 0);
  assert.equal(texts.length, 0);
});

test('tail: a second undialable consult in the same 24h files a row but does not email', async () => {
  const id = await makeConsult('bad-premium', { phone: '+19005551234' });
  await chain.consultCallTail({ consultId: id, scheduledAt: await slotOf(id), bookerPhone: '+19005551234', triggerEvent: 'BOOKING_CREATED' });
  const rows = await attemptsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_invalid_phone');
  assert.equal(rows[0].detail, 'invalid_phone');
  assert.equal(emails.length, 0, 'the min-id bound holds the alert to one per rolling 24h');
});

test('tail: an empty number files no_phone', async () => {
  const id = await makeConsult('no-phone', { phone: null });
  await chain.consultCallTail({ consultId: id, scheduledAt: await slotOf(id), bookerPhone: null, triggerEvent: 'BOOKING_CREATED' });
  const rows = await attemptsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_invalid_phone');
  assert.equal(rows[0].detail, 'no_phone');
});

test('tail: a valid future booking inserts nothing (the sweep opens the chain, not the tail)', async () => {
  const id = await makeConsult('valid-create');
  await chain.consultCallTail({ consultId: id, scheduledAt: await slotOf(id), bookerPhone: VALID_PHONE, triggerEvent: 'BOOKING_CREATED' });
  assert.deepEqual(await attemptsFor(id), []);
  assert.equal(emails.length, 0);
  assert.equal(placed.length, 0);
});

test('tail: BOOKING_RESCHEDULED clears every skip row at the NEW slot and keeps the old slot (R16)', async () => {
  // Slot-scoped and status-wide. The UNIQUE allows one row per (consult, slot),
  // so "status-wide" is proven with two consults carrying different skip states.
  const a = await makeConsult('resched-a');
  const b = await makeConsult('resched-b');
  for (const [id, status] of [[a, 'skipped_invalid_phone'], [b, 'skipped_cancelled']]) {
    await pool.query(
      `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
       SELECT c.id, c.scheduled_at, $2, 'at_new_slot' FROM consults c WHERE c.id = $1`,
      [id, status]
    );
    // The pre-reschedule chain row, still carrying the OLD slot.
    await pool.query(
      `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
       VALUES ($1, date_trunc('second', NOW()) - INTERVAL '3 hours', 'skipped_cancelled', 'at_old_slot')`,
      [id]
    );
    await chain.consultCallTail({
      consultId: id, scheduledAt: await slotOf(id), bookerPhone: VALID_PHONE,
      triggerEvent: 'BOOKING_RESCHEDULED',
    });
    const rows = await attemptsFor(id);
    assert.equal(rows.length, 1, `${status}: only the old-slot row survives`);
    assert.equal(rows[0].detail, 'at_old_slot', `${status}: the old slot is never touched`);
  }
  assert.equal(emails.length, 0);
});

test('tail: a non-reschedule trigger never clears a skip row', async () => {
  const id = await makeConsult('resched-guard');
  await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
     SELECT c.id, c.scheduled_at, 'skipped_cancelled', 'at_new_slot' FROM consults c WHERE c.id = $1`,
    [id]
  );
  await chain.consultCallTail({
    consultId: id, scheduledAt: await slotOf(id), bookerPhone: VALID_PHONE,
    triggerEvent: 'BOOKING_CREATED',
  });
  const rows = await attemptsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, 'at_new_slot');
});

test('tail: an unresolved reschedule marks only future scheduled siblings on the RAW booker email (R2)', async () => {
  const shared = `${RUN}-sib@example.test`;
  const target = await makeConsult('sib-new', { email: shared });
  const futureSibling = await makeConsult('sib-future', { email: shared, offsetSec: 10800 });
  const pastSibling = await makeConsult('sib-past', { email: shared, offsetSec: -3600 });
  const cancelledSibling = await makeConsult('sib-cancelled', { email: shared, offsetSec: 14400, status: 'cancelled' });
  const otherEmail = await makeConsult('sib-other', { offsetSec: 10800 });

  await chain.consultCallTail({
    consultId: target, scheduledAt: await slotOf(target), bookerPhone: VALID_PHONE,
    triggerEvent: 'BOOKING_RESCHEDULED', unresolvedOldUid: 'cal-uid-that-never-resolved',
    bookerEmail: shared,
  });

  const marked = await attemptsFor(futureSibling);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].status, 'skipped_cancelled');
  assert.equal(marked[0].detail, 'rescheduled_unresolved');

  assert.deepEqual(await attemptsFor(target), [], 'the new booking is never its own sibling');
  assert.deepEqual(await attemptsFor(pastSibling), [], 'a past slot is left alone');
  assert.deepEqual(await attemptsFor(cancelledSibling), [], 'a non-scheduled consult is left alone');
  assert.deepEqual(await attemptsFor(otherEmail), [], 'a different booker email is left alone');
  assert.equal(emails.length, 0, 'sibling marking is silent');
});

test('tail: the sibling marking runs even when the NEW booking number is undialable (R3)', async () => {
  const shared = `${RUN}-r3@example.test`;
  const target = await makeConsult('r3-new', { email: shared, phone: '+442071234567' });
  const sibling = await makeConsult('r3-sib', { email: shared, offsetSec: 10800 });

  await chain.consultCallTail({
    consultId: target, scheduledAt: await slotOf(target), bookerPhone: '+442071234567',
    triggerEvent: 'BOOKING_RESCHEDULED', unresolvedOldUid: 'cal-uid-unresolved', bookerEmail: shared,
  });

  const marked = await attemptsFor(sibling);
  assert.equal(marked.length, 1, 'a moved slot is stopped even when the new number is bad');
  assert.equal(marked[0].detail, 'rescheduled_unresolved');
  const filed = await attemptsFor(target);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].status, 'skipped_invalid_phone');
});

test('tail: stopping MORE than one sibling emails once, because that is the ambiguous case', async () => {
  // The only path in this feature that turns a consult that would have rung
  // into one that silently will not. One sibling is the ordinary case (the
  // booker moved their single upcoming slot) and stays a log line, asserted by
  // the R2 test above. Two means at least one separate, legitimate booking was
  // stopped as well, and nothing else in the system watches that.
  const shared = `${RUN}-sibmulti@example.test`;
  const target = await makeConsult('sibmulti-new', { email: shared });
  const first = await makeConsult('sibmulti-a', { email: shared, offsetSec: 10800 });
  const second = await makeConsult('sibmulti-b', { email: shared, offsetSec: 14400 });

  await chain.consultCallTail({
    consultId: target, scheduledAt: await slotOf(target), bookerPhone: VALID_PHONE,
    triggerEvent: 'BOOKING_RESCHEDULED', unresolvedOldUid: 'cal-uid-unresolved',
    bookerEmail: shared,
  });

  for (const sibling of [first, second]) {
    const marked = await attemptsFor(sibling);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].status, 'skipped_cancelled');
    assert.equal(marked[0].detail, 'rescheduled_unresolved', 'behavior is unchanged, only visibility');
  }
  assert.deepEqual(await attemptsFor(target), [], 'the new booking is never its own sibling');

  // ONE email, not one per row: these rows are inserted outside the daily cap
  // and the Cal.com booking page is public, so a per-row loop would be a Resend
  // quota amplifier reachable from the open internet.
  assert.equal(emails.length, 1, 'one email however many siblings were stopped');
  assert.ok(emails[0].subject.includes('unresolved reschedule'), emails[0].subject);
  assert.ok(/Call them/.test(emails[0].emailText), emails[0].emailText);
});

test('tail: never rejects, even on a dead pool', async () => {
  // No argument and an explicit null both reach the tail from a mis-wired
  // caller, and the tail law admits no throw whatsoever.
  await assert.doesNotReject(chain.consultCallTail());
  await assert.doesNotReject(chain.consultCallTail(null));
  await assert.doesNotReject(chain.sendChainEmail(null));

  chain.__setDeps({ pool: { query: async () => { throw new Error('db down'); } } });
  try {
    await assert.doesNotReject(chain.consultCallTail({
      consultId: 999999999, scheduledAt: new Date(Date.now() + 7200000),
      bookerPhone: VALID_PHONE, triggerEvent: 'BOOKING_RESCHEDULED',
      unresolvedOldUid: 'x', bookerEmail: 'x@example.test',
    }));
    await assert.doesNotReject(chain.consultCallTail({
      consultId: 999999999, scheduledAt: new Date(Date.now() + 7200000),
      bookerPhone: 'garbage', triggerEvent: 'BOOKING_CREATED',
    }));
  } finally {
    chain.__setDeps({ pool });
  }
});

test('tail: a rejection carrying no message still never escapes', async () => {
  // captureError is the last thing standing between a driver-level failure and
  // the webhook. It must survive a rejection value that is not an Error.
  for (const thrown of [null, undefined, 'a bare string']) {
    chain.__setDeps({ pool: { query: async () => { throw thrown; } } });
    await assert.doesNotReject(chain.consultCallTail({
      consultId: 999999999, scheduledAt: new Date(Date.now() + 7200000), bookerPhone: 'garbage',
    }), `thrown: ${String(thrown)}`);
    await assert.doesNotReject(chain.sendChainEmail({ attemptId: 999999999, reason: 'missed window' }));
  }
  chain.__setDeps({ pool });
  assert.equal(emails.length, 0);
});

// ─── openChain ───────────────────────────────────────────────────

test('openChain: opens pending with next_ring_at exactly 90 seconds before the slot', async () => {
  const id = await makeConsult('open-1');
  assert.equal(await chain.openChain({ consultId: id }), 'opened');
  const r = await pool.query(
    `SELECT a.status, a.admin_ring, a.detail,
            a.next_ring_at = c.scheduled_at - INTERVAL '90 seconds' AS ring_exact
       FROM consult_call_attempts a JOIN consults c ON c.id = a.consult_id
      WHERE a.consult_id = $1`,
    [id]
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].status, 'pending');
  assert.equal(r.rows[0].admin_ring, 0);
  assert.equal(r.rows[0].detail, null);
  assert.equal(r.rows[0].ring_exact, true, 'next_ring_at is derived in SQL from RING_OFFSETS_SEC[1]');
  assert.equal(emails.length, 0);
  assert.equal(placed.length, 0);
});

test('openChain: a microsecond slot is stored byte-identically and a second call returns exists (R12)', async () => {
  const id = await makeConsult('open-micro');

  const fixture = await pool.query('SELECT scheduled_at::text AS t FROM consults WHERE id = $1', [id]);
  assert.match(fixture.rows[0].t, /\.\d{4,6}/,
    'precondition: the fixture slot really carries sub-millisecond precision');

  assert.equal(await chain.openChain({ consultId: id }), 'opened');

  // THE R12 assertion. A JS round-trip stores a millisecond-truncated slot,
  // which is a different value: the equality below goes false, the sweep's
  // anti-join stops matching, and the sweep re-opens this consult every tick.
  const r = await pool.query(
    `SELECT a.scheduled_at = c.scheduled_at AS slot_exact,
            a.scheduled_at::text AS stored, c.scheduled_at::text AS consult_slot
       FROM consult_call_attempts a JOIN consults c ON c.id = a.consult_id
      WHERE a.consult_id = $1`,
    [id]
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].slot_exact, true,
    `stored ${r.rows[0].stored} must equal the consult slot ${r.rows[0].consult_slot} exactly`);

  const orphan = await pool.query(
    `SELECT 1 FROM consults c
      WHERE c.id = $1
        AND NOT EXISTS (SELECT 1 FROM consult_call_attempts a
                         WHERE a.consult_id = c.id AND a.scheduled_at = c.scheduled_at)`,
    [id]
  );
  assert.equal(orphan.rowCount, 0, "the sweep's anti-join must no longer select this consult");

  assert.equal(await chain.openChain({ consultId: id }), 'exists', 'a second open is a no-op');
  assert.equal((await attemptsFor(id)).length, 1, 'exactly one chain row for the slot');
  assert.equal(emails.length, 0, 'a duplicate open never emails');
});

test('openChain: the cap trips to skipped_cap/cap_tripped and only the first trip emails (R15)', async () => {
  const baseline = await nonSkippedCount();
  process.env.CONSULT_CALL_DAILY_CAP = String(baseline); // zero headroom
  try {
    const first = await makeConsult('cap-1');
    assert.equal(await chain.openChain({ consultId: first }), 'cap_tripped');
    const rows = await attemptsFor(first);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'skipped_cap', 'the marker carries the skipped% prefix (R15)');
    assert.equal(rows[0].detail, 'cap_tripped');
    assert.equal(emails.length, 1, 'the first trip emails');
    assert.ok(emails[0].subject.includes('daily cap tripped'), emails[0].subject);

    const second = await makeConsult('cap-2');
    assert.equal(await chain.openChain({ consultId: second }), 'cap_tripped');
    assert.equal((await attemptsFor(second))[0].status, 'skipped_cap');
    assert.equal(emails.length, 1, 'a second trip inside the same 24h must not email');

    assert.equal(await nonSkippedCount(), baseline,
      'cap markers must NOT feed the cap count, or junk bookings hold the feature down for 24h');
  } finally {
    delete process.env.CONSULT_CALL_DAILY_CAP;
    await clearCapMarkers();
  }
  assert.equal(placed.length, 0);
});

test('openChain: skip rows never consume the cap (R15)', async () => {
  const baseline = await nonSkippedCount();
  const bad = await makeConsult('capskip-bad', { phone: '+442071234567' });
  await chain.fileUndialable({ consultId: bad, bookerPhone: '+442071234567' });
  const missed = await makeConsult('capskip-missed', { offsetSec: -600 });
  await chain.fileMissedWindow({ consultId: missed });
  assert.equal(await nonSkippedCount(), baseline, 'skip rows are invisible to the cap');

  process.env.CONSULT_CALL_DAILY_CAP = String(baseline + 1);
  try {
    const ok = await makeConsult('capskip-open');
    assert.equal(await chain.openChain({ consultId: ok }), 'opened', 'headroom of one still opens');
    assert.equal(await nonSkippedCount(), baseline + 1);
  } finally {
    delete process.env.CONSULT_CALL_DAILY_CAP;
  }
});

test('openChain: an unset CONSULT_CALL_DAILY_CAP falls back to 10, never NaN', async () => {
  delete process.env.CONSULT_CALL_DAILY_CAP;
  assert.ok(await nonSkippedCount() < 10, 'precondition: this suite stays under the default cap');
  const id = await makeConsult('capdefault');
  assert.equal(await chain.openChain({ consultId: id }), 'opened');
});

// ─── fileMissedWindow / fileUndialable / sendChainEmail ──────────

test('fileMissedWindow: files once, emails once, and a second call is exists', async () => {
  const id = await makeConsult('missed-1', { offsetSec: -900 });
  assert.equal(await chain.fileMissedWindow({ consultId: id }), 'filed');
  assert.equal(await chain.fileMissedWindow({ consultId: id }), 'exists');
  const rows = await attemptsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_missed_window');
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('missed window'), emails[0].subject);
  const r = await pool.query(
    `SELECT a.scheduled_at = c.scheduled_at AS slot_exact
       FROM consult_call_attempts a JOIN consults c ON c.id = a.consult_id
      WHERE a.consult_id = $1`,
    [id]
  );
  assert.equal(r.rows[0].slot_exact, true, 'the stored slot matches the consult exactly (R12)');
});

test('fileMissedWindow: emails PER ROW, with no rolling 24h bound (R7)', async () => {
  const a = await makeConsult('missed-r7a', { offsetSec: -900 });
  const b = await makeConsult('missed-r7b', { offsetSec: -1200 });
  await chain.fileMissedWindow({ consultId: a });
  await chain.fileMissedWindow({ consultId: b });
  assert.equal(emails.length, 2, 'each missed row is a distinct consult a human has to call by hand');
});

test('fileUndialable: the stored slot matches the consult exactly (R12)', async () => {
  const id = await makeConsult('undial-slot', { phone: 'not a phone' });
  assert.equal(await chain.fileUndialable({ consultId: id, bookerPhone: 'not a phone' }), 'filed');
  assert.equal(await chain.fileUndialable({ consultId: id, bookerPhone: 'not a phone' }), 'exists');
  const r = await pool.query(
    `SELECT a.scheduled_at = c.scheduled_at AS slot_exact
       FROM consult_call_attempts a JOIN consults c ON c.id = a.consult_id
      WHERE a.consult_id = $1`,
    [id]
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].slot_exact, true);
});

test('sendChainEmail: formats a dialable number, passes a bad one through, and says none', async () => {
  const good = await makeConsult('mail-good', { phone: VALID_PHONE, offsetSec: -900 });
  await chain.fileMissedWindow({ consultId: good });
  assert.equal(emails.length, 1);
  assert.ok(emails[0].emailText.includes('256-328-1203'), emails[0].emailText);
  assert.ok(emails[0].emailText.includes('Test Booker'), emails[0].emailText);

  emails = [];
  const bad = await makeConsult('mail-bad', { phone: '+442071234567', offsetSec: -900 });
  await chain.fileMissedWindow({ consultId: bad });
  assert.equal(emails.length, 1);
  assert.ok(emails[0].emailText.includes('+442071234567'), emails[0].emailText);

  emails = [];
  const none = await makeConsult('mail-none', { phone: null, offsetSec: -900 });
  await chain.fileMissedWindow({ consultId: none });
  assert.equal(emails.length, 1);
  assert.ok(emails[0].emailText.includes('Number: none'),
    'the word matches the template literal, so the two never drift');
});

test('sendChainEmail: names the ATTEMPT slot, never the consult current one', async () => {
  // The email is about ONE chain. When the consult later moves, an alert about
  // the chain that ran against the OLD slot must still name the old slot.
  const OLD_SLOT = '2026-02-14T15:00:00.000Z';
  const label = (instant) => new Date(instant).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago',
  });

  const id = await makeConsult('mail-moved');
  const ins = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
     VALUES ($1, $2::timestamptz, 'skipped_missed_window', 'ran_at_old_slot')
     RETURNING id`,
    [id, OLD_SLOT]
  );
  const consultSlot = await slotOf(id);
  assert.notEqual(label(OLD_SLOT), label(consultSlot), 'precondition: the two slots render differently');

  await chain.sendChainEmail({ attemptId: ins.rows[0].id, reason: 'missed window' });
  assert.equal(emails.length, 1);
  assert.ok(emails[0].emailText.includes(label(OLD_SLOT)), emails[0].emailText);
  assert.ok(!emails[0].emailText.includes(label(consultSlot)),
    'the consult has since moved; the email must not name the slot it moved TO');
});

test('sendChainEmail: swallows a dead pool rather than throwing at its caller', async () => {
  chain.__setDeps({ pool: { query: async () => { throw new Error('db down'); } } });
  try {
    await assert.doesNotReject(chain.sendChainEmail({ attemptId: 999999999, reason: 'missed window' }));
    assert.equal(emails.length, 0);
  } finally {
    chain.__setDeps({ pool });
  }
});

// ─── the FIRE side: advanceChain / onLegTerminal / sendMissedText ─
//
// Chain rows below are inserted DIRECTLY rather than through openChain. The
// fire side is what is under test here, and openChain spends the rolling daily
// cap, which counts GLOBALLY over this database: opening twenty chains here
// would trip the cap for every suite that follows. The attempt's scheduled_at
// is still taken from the consults row IN SQL, so every fire fixture keeps its
// microseconds and stays an R12 tripwire.

/**
 * A consults row plus its chain row in a chosen state.
 *
 * @param {string} tag fixture tag
 * @param {Object} [opts] attemptStatus / adminRing / nextRingOffsetSec (null =
 *   no next ring, i.e. a leg is live), plus every makeConsult option.
 */
async function makeChainRow(tag, opts = {}) {
  const {
    attemptStatus = 'pending', adminRing = 0, nextRingOffsetSec = -90, ...consultOpts
  } = opts;
  const consultId = await makeConsult(tag, consultOpts);
  const r = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, admin_ring, next_ring_at)
     SELECT c.id, c.scheduled_at, $2, $3,
            CASE WHEN $4::int IS NULL THEN NULL
                 ELSE c.scheduled_at + make_interval(secs => $4::int) END
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, attemptStatus, adminRing, nextRingOffsetSec]
  );
  return { consultId, attemptId: Number(r.rows[0].id) };
}

/**
 * The chain row as text. updated_at comes back as ::text on purpose: it is the
 * whole-row write detector for R5 (the BEFORE UPDATE trigger stamps it on ANY
 * write, telemetry included) and a JS Date would lose the microseconds that
 * make two consecutive statements distinguishable.
 */
async function rowOf(attemptId) {
  const r = await pool.query(
    `SELECT status, admin_ring, detail, admin_call_status, va_call_status,
            admin_call_sid, va_call_sid, answered_by,
            next_ring_at::text AS next_ring_at, updated_at::text AS updated_at
       FROM consult_call_attempts WHERE id = $1`,
    [attemptId]
  );
  return r.rows[0];
}

/** True when next_ring_at is EXACTLY the consult slot plus `secs` (R12). */
async function ringOffsetExact(attemptId, secs) {
  const r = await pool.query(
    `SELECT a.next_ring_at = c.scheduled_at + make_interval(secs => $2::int) AS exact
       FROM consult_call_attempts a JOIN consults c ON c.id = a.consult_id
      WHERE a.id = $1`,
    [attemptId, secs]
  );
  return r.rows[0].exact;
}

/** Set env vars for one step and always put them back. null/undefined deletes. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    const v = vars[k];
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ─── guardStillScheduled ─────────────────────────────────────────

test('guardStillScheduled: ok, the consult ACTUAL status, or rescheduled (R12 + R17)', async () => {
  const ok = await makeChainRow('guard-ok');
  assert.deepEqual(await chain.guardStillScheduled(ok.attemptId), { ok: true },
    'an unmoved microsecond slot passes: the two slots are compared IN SQL, never as JS Date objects');

  const moved = await makeChainRow('guard-moved');
  await pool.query(`UPDATE consults SET scheduled_at = scheduled_at + INTERVAL '1 hour' WHERE id = $1`, [moved.consultId]);
  assert.deepEqual(await chain.guardStillScheduled(moved.attemptId), { ok: false, detail: 'rescheduled' });

  // R17: a consult flips to completed when Dallas saves the drink plan, which is
  // the NORMAL end of a successful call. Reporting that as cancelled would send
  // a future reader chasing a cancellation that never happened.
  for (const consultStatus of ['cancelled', 'completed', 'no_show']) {
    const row = await makeChainRow(`guard-${consultStatus}`);
    await pool.query('UPDATE consults SET status = $2 WHERE id = $1', [row.consultId, consultStatus]);
    assert.deepEqual(await chain.guardStillScheduled(row.attemptId), { ok: false, detail: consultStatus });
  }

  const gone = await chain.guardStillScheduled(999999999);
  assert.equal(gone.ok, false, 'a vanished row is never treated as still scheduled');
});

// ─── advanceChain: the fire step's re-check order ────────────────

test('advanceChain: the kill switch lands skipped_disabled and places nothing', async () => {
  const { attemptId } = await makeChainRow('fire-kill');
  await withEnv({ CONSULT_CALL_ENABLED: 'false' }, () => chain.advanceChain({ attemptId }));
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_disabled');
  assert.equal(row.admin_ring, 0);
  assert.equal(row.next_ring_at, null, 'a terminal row is never left holding a due time');
  assert.equal(placed.length, 0);
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('advanceChain: a consult no longer scheduled lands skipped_cancelled carrying its ACTUAL status (R17)', async () => {
  for (const consultStatus of ['cancelled', 'completed']) {
    const { consultId, attemptId } = await makeChainRow(`fire-r17-${consultStatus}`);
    await pool.query('UPDATE consults SET status = $2 WHERE id = $1', [consultId, consultStatus]);
    await chain.advanceChain({ attemptId });
    const row = await rowOf(attemptId);
    assert.equal(row.status, 'skipped_cancelled', consultStatus);
    assert.equal(row.detail, consultStatus);
    assert.equal(row.next_ring_at, null);
  }
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 0);
});

test('advanceChain: a moved slot lands skipped_cancelled/rescheduled', async () => {
  const { consultId, attemptId } = await makeChainRow('fire-moved');
  await pool.query(`UPDATE consults SET scheduled_at = scheduled_at + INTERVAL '30 minutes' WHERE id = $1`, [consultId]);
  await chain.advanceChain({ attemptId });
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_cancelled');
  assert.equal(row.detail, 'rescheduled');
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 0);
});

test('advanceChain: past the admin too-late bound lands failed/too_late and emails exactly once', async () => {
  const { attemptId } = await makeChainRow('fire-toolate', { offsetSec: -660 });
  await chain.advanceChain({ attemptId });
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(row.detail, 'too_late');
  assert.equal(row.next_ring_at, null);
  assert.equal(placed.length, 0, 'ringing this late is worse than not ringing');
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('too late'), emails[0].subject);

  await chain.advanceChain({ attemptId });
  assert.equal(emails.length, 1, 'a second sweep tick on the same row never emails again');
});

test('advanceChain: neither phone configured lands skipped_unconfigured', async () => {
  const { attemptId } = await makeChainRow('fire-unconf');
  await withEnv({ ADMIN_PHONE: null, VA_CELL: null }, () => chain.advanceChain({ attemptId }));
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_unconfigured');
  assert.equal(row.next_ring_at, null);
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 0);
});

// ─── advanceChain: placement shape ───────────────────────────────

test('advanceChain: ring 1 dials ADMIN_PHONE for 20 seconds and carries ring=1 in both URLs', async () => {
  const { attemptId } = await makeChainRow('fire-ring1');
  await chain.advanceChain({ attemptId });

  assert.equal(placed.length, 1);
  const call = placed[0];
  assert.equal(call.to, ADMIN_PHONE, 'agent legs dial the env value verbatim');
  assert.equal(call.callerId, TWILIO_FROM);
  assert.equal(call.timeLimit, 1800, 'VA_CALL_TIME_LIMIT_SEC unset falls back to 1800');
  assert.equal(call.timeout, 20,
    'ADMIN_PHONE is a Google Voice number whose voicemail answers near 25 seconds; a longer ring loses that race and bills a leg that speaks the booker details into a transcript');
  assert.ok(call.url.startsWith(`${API_URL}/api/voice/consult/answer?`), call.url);
  assert.ok(call.url.includes(`attempt=${attemptId}&leg=admin&ring=1&play=1`), call.url);
  assert.ok(call.statusCallback.startsWith(`${API_URL}/api/voice/consult/status?`), call.statusCallback);
  assert.ok(call.statusCallback.includes(`attempt=${attemptId}&leg=admin&ring=1`), call.statusCallback);

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.admin_ring, 1);
  assert.equal(row.next_ring_at, null, 'the row is not due again while a leg is live');
  assert.equal(row.admin_call_sid, 'CA_stub_1');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('advanceChain: two overlapping sweep ticks on one row place exactly one call', async () => {
  // The cap and the claim are both single statements for this reason: under
  // READ COMMITTED the loser's UPDATE re-evaluates its WHERE against the
  // winner's committed row, sees calling_admin, and matches nothing.
  const { attemptId } = await makeChainRow('fire-race');
  await Promise.all([chain.advanceChain({ attemptId }), chain.advanceChain({ attemptId })]);
  assert.equal(placed.length, 1, 'Dallas is rung once, not twice');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.admin_ring, 1, 'the ring counter advanced once');
  assert.equal(emails.length, 0);
});

test('advanceChain: a pending row already at ring 3 never places a fourth ring', async () => {
  const { attemptId } = await makeChainRow('fire-ring4', { adminRing: 3 });
  await chain.advanceChain({ attemptId });
  assert.equal(placed.length, 0);
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'pending', 'the claim loses; the reaper owns the row from here');
  assert.equal(row.admin_ring, 3);
});

test('advanceChain: ADMIN_PHONE unset dials Zul for 25 seconds at ring 0', async () => {
  const { attemptId } = await makeChainRow('fire-vaonly');
  await withEnv({ ADMIN_PHONE: null }, () => chain.advanceChain({ attemptId }));
  assert.equal(placed.length, 1);
  assert.equal(placed[0].to, VA_CELL);
  assert.equal(placed[0].timeout, 25, "Zul's cell has no voicemail hop to race");
  assert.ok(placed[0].url.includes('leg=va&ring=0'), placed[0].url);
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_va');
  assert.equal(row.admin_ring, 0);
  assert.equal(row.next_ring_at, null);
  assert.equal(row.va_call_sid, 'CA_stub_1');
});

test('advanceChain: a ring 1 create throw records create_failed and re-arms with ring 2 timing', async () => {
  const { attemptId } = await makeChainRow('fire-create-throw');
  chain.__setDeps({
    placeBridgedCall: async () => { const e = new Error('twilio down'); e.code = 21211; throw e; },
  });
  await chain.advanceChain({ attemptId });
  const row = await rowOf(attemptId);
  assert.equal(row.admin_call_status, 'create_failed');
  assert.equal(row.detail, '21211');
  assert.equal(row.status, 'pending', 'the chain moves to the NEXT ring; it never retries the same one');
  assert.equal(row.admin_ring, 1);
  assert.equal(await ringOffsetExact(attemptId, 60), true);
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0, 'a ring that can fall through to another ring is not a chain failure');
});

// ─── onLegTerminal: the admin ladder ─────────────────────────────

test('onLegTerminal: ring 1 re-arms at slot + 60s, ring 2 at slot + 180s, ring 3 hands off', async () => {
  const { attemptId } = await makeChainRow('fire-ladder');

  await chain.advanceChain({ attemptId });
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus: 'no-answer' });
  let row = await rowOf(attemptId);
  assert.equal(row.status, 'pending');
  assert.equal(row.admin_ring, 1);
  assert.equal(row.admin_call_status, 'no-answer');
  assert.equal(await ringOffsetExact(attemptId, 60), true, 'RING_OFFSETS_SEC[2], to the microsecond');

  await chain.advanceChain({ attemptId });
  assert.equal(placed.length, 2);
  assert.ok(placed[1].url.includes('ring=2'), placed[1].url);
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 2, callStatus: 'busy' });
  row = await rowOf(attemptId);
  assert.equal(row.status, 'pending');
  assert.equal(row.admin_ring, 2);
  assert.equal(row.admin_call_status, 'busy');
  assert.equal(await ringOffsetExact(attemptId, 180), true, 'RING_OFFSETS_SEC[3]');

  await chain.advanceChain({ attemptId });
  assert.equal(placed.length, 3);
  assert.ok(placed[2].url.includes('ring=3'), placed[2].url);
  row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.admin_ring, 3);
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: a replayed ring 1 callback during a live ring 2 writes NOTHING (R5)', async () => {
  // The disaster an entire design review existed to catch. Ring 1 goes
  // no-answer, the row returns to pending, the sweep places ring 2, and THEN
  // Twilio redelivers the ring 1 callback while ring 2 is ringing Dallas's
  // phone. With only a status guard it matches, flips the row to pending with
  // ring 3 timing, and Dallas answers a live ring 2 and hears the apology.
  const { attemptId } = await makeChainRow('fire-replay');
  await chain.advanceChain({ attemptId });
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus: 'no-answer' });
  await chain.advanceChain({ attemptId });

  const before = await rowOf(attemptId);
  assert.equal(before.status, 'calling_admin', 'precondition: ring 2 is live');
  assert.equal(before.admin_ring, 2);
  const placedBefore = placed.length;

  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus: 'no-answer' });

  const after = await rowOf(attemptId);
  assert.equal(after.status, 'calling_admin', 'ring 2 is still live on his phone');
  assert.equal(after.admin_ring, 2);
  assert.equal(after.next_ring_at, null);
  assert.equal(after.admin_call_status, before.admin_call_status);
  assert.equal(after.updated_at, before.updated_at,
    'R5: a superseded ring writes NO column at all, telemetry included. The BEFORE UPDATE trigger stamps updated_at on any write, so an unchanged value is proof nothing was written.');
  assert.equal(placed.length, placedBefore, 'and no second call');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: ring 3 hands off to Zul exactly once, and a duplicate callback places nothing further', async () => {
  const { attemptId } = await makeChainRow('fire-ring3-va', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });

  assert.equal(placed.length, 1);
  assert.equal(placed[0].to, VA_CELL);
  assert.equal(placed[0].timeout, 25);
  assert.ok(placed[0].url.includes('leg=va&ring=0'), placed[0].url);
  let row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_va');
  assert.equal(row.admin_call_status, 'no-answer');
  assert.equal(row.va_call_sid, 'CA_stub_1');

  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
  row = await rowOf(attemptId);
  assert.equal(placed.length, 1, 'Zul is never rung twice for one chain');
  assert.equal(row.status, 'calling_va');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: ring 3 with VA_CELL unset lands missed and texts Dallas exactly once', async () => {
  const { consultId, attemptId } = await makeChainRow('fire-missed', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null, name: 'Tyler Anderson',
  });
  await withEnv({ VA_CELL: null }, async () => {
    await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
    await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
  });

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'missed');
  assert.equal(row.next_ring_at, null);
  assert.equal(placed.length, 0);
  assert.equal(texts.length, 1, 'the claim winner texts; the duplicate callback loses the claim');
  assert.equal(texts[0].to, TEXT_DEST);
  assert.equal(
    texts[0].body,
    `Missed consult call with Tyler Anderson at ${clockTimeWithMinutes(await slotOf(consultId))}. Their number is 256-328-1203.`
  );
  assert.ok(!texts[0].body.includes('—'), 'no em dashes in texted copy');
  assert.equal(texts[0].meta.skipLog, true, 'an internal ops alert never files into the client ledger');
  assert.equal(texts[0].meta.messageType, 'consult_call_alert');
  assert.equal(emails.length, 0, 'a missed chain that texted never also emails');
});

test('onLegTerminal: a ring 3 that cannot be placed, with VA_CELL unset, lands failed with an email and NO text', async () => {
  // Driven end to end through the real create-failure path, exactly like its VA
  // sibling below: a synthetic callStatus would never put a Twilio code in
  // detail, which is the whole thing this row has to preserve.
  const { attemptId } = await makeChainRow('fire-ring3-createfail', { adminRing: 2 });
  chain.__setDeps({
    placeBridgedCall: async () => { const e = new Error('twilio down'); e.code = 21212; throw e; },
  });
  await withEnv({ VA_CELL: null }, () => chain.advanceChain({ attemptId }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(row.admin_ring, 3);
  assert.equal(row.admin_call_status, 'create_failed');
  assert.equal(row.detail, '21212',
    'the specific Twilio code survives: admin_call_status already carries the word create_failed');
  assert.equal(row.admin_call_sid, null);
  assert.equal(texts.length, 0, "his phone never rang, so there is nothing to call missed");
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('call failed'), emails[0].subject);
});

test('onLegTerminal: the kill switch flipped between ring 3 and its callback lands skipped_disabled', async () => {
  const { attemptId } = await makeChainRow('fire-ring3-kill', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await withEnv({ CONSULT_CALL_ENABLED: 'false' }, () =>
    chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_disabled');
  assert.equal(placed.length, 0, 'no Manila leg');
  assert.equal(texts.length, 0, 'a deliberate stop is not a missed consult');
  assert.equal(emails.length, 0);
});

test('onLegTerminal: a consult cancelled mid-chain stops the Zul hop', async () => {
  const { consultId, attemptId } = await makeChainRow('fire-cancel-mid', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await pool.query(`UPDATE consults SET status = 'cancelled' WHERE id = $1`, [consultId]);
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_cancelled');
  assert.equal(row.detail, 'cancelled');
  assert.equal(placed.length, 0, 'a billed international leg is never placed for a cancelled consult');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: the VA too-late bound is its own, 120 seconds past the admin one', async () => {
  // 780s past the slot: past BOTH bounds.
  const late = await makeChainRow('fire-va-toolate', {
    offsetSec: -780, attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await chain.onLegTerminal({ attemptId: late.attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
  let row = await rowOf(late.attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(row.detail, 'too_late');
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('too late'), emails[0].subject);

  // 660s past the slot: past the ADMIN bound (600) but inside the VA bound (720).
  emails = [];
  const inside = await makeChainRow('fire-va-inside', {
    offsetSec: -660, attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await chain.onLegTerminal({ attemptId: inside.attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
  row = await rowOf(inside.attemptId);
  assert.equal(row.status, 'calling_va', 'the Zul hop has its own, later bound');
  assert.equal(placed.length, 1);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: no valid text destination emails the reason instead of dropping the miss', async () => {
  const { attemptId } = await makeChainRow('fire-notext', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  await withEnv({ VA_CELL: null, VM_TEXT_DESTINATION: 'not a phone', ADMIN_PHONE: null }, () =>
    chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'missed', 'the row is still missed; only the alert channel changed');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('missed, no text destination'), emails[0].subject);
});

test('onLegTerminal: a Twilio text failure reports a FAILED text, never a missing destination', async () => {
  // sendSMS throws when Twilio is down. Reporting that as "no text destination
  // is configured" sent Dallas to his Render environment variables for an
  // outage he could not fix from there.
  const { attemptId } = await makeChainRow('fire-textfail', {
    attemptStatus: 'calling_admin', adminRing: 3, nextRingOffsetSec: null,
  });
  chain.__setDeps({ sendSMS: async () => { throw new Error('twilio 21610'); } });
  await withEnv({ VA_CELL: null }, () =>
    chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'missed', 'the row is still missed; only the alert channel changed');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('missed, text failed'), emails[0].subject);
  assert.ok(!emails[0].subject.includes('no text destination'),
    'a Twilio outage must not be reported as an unset VM_TEXT_DESTINATION');
});

// ─── onLegTerminal: the Zul leg ──────────────────────────────────

test('onLegTerminal: the VA leg no-answer lands missed and texts once, a duplicate texts nothing', async () => {
  const { attemptId } = await makeChainRow('fire-va-missed', {
    attemptStatus: 'calling_va', adminRing: 3, nextRingOffsetSec: null,
  });
  await chain.onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'no-answer' });
  await chain.onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'no-answer' });

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'missed');
  assert.equal(row.va_call_status, 'no-answer');
  assert.equal(texts.length, 1);
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: a VA leg that cannot be placed lands failed, keeps the Twilio code, and emails once', async () => {
  // Driven end to end through the real create-failure recursion rather than a
  // synthetic callStatus, because that is the only way this branch is reached.
  const { attemptId } = await makeChainRow('fire-va-createfail');
  chain.__setDeps({
    placeBridgedCall: async () => { const e = new Error('twilio down'); e.code = 21215; throw e; },
  });
  await withEnv({ ADMIN_PHONE: null }, () => chain.advanceChain({ attemptId }));

  let row = await rowOf(attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(row.va_call_status, 'create_failed');
  assert.equal(row.detail, '21215',
    'the specific Twilio code survives: va_call_status already carries the word create_failed');
  assert.equal(row.va_call_sid, null);
  assert.equal(texts.length, 0, 'nobody was rung, so no missed text');
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('call failed'), emails[0].subject);

  await chain.onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'create_failed' });
  row = await rowOf(attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(emails.length, 1, 'the claim winner emailed; a duplicate callback loses');
});

test('onLegTerminal: a VA leg that could not be placed still lands failed with the kill switch OFF', async () => {
  // The combination the create-failed-before-kill-switch ordering exists for. A
  // chain that could not dial is a system fault whether or not somebody turned
  // the bridge off afterwards, so it must NOT be filed as a deliberate stop.
  const { attemptId } = await makeChainRow('fire-va-createfail-kill', {
    attemptStatus: 'calling_va', adminRing: 3, nextRingOffsetSec: null,
  });
  await pool.query('UPDATE consult_call_attempts SET detail = $2 WHERE id = $1', [attemptId, '21215']);

  await withEnv({ CONSULT_CALL_ENABLED: 'false' }, () =>
    chain.onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'create_failed' }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'failed', 'never skipped_disabled: nobody chose this outcome');
  assert.equal(row.detail, '21215', 'and the Twilio code is still there to look up');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('call failed'), emails[0].subject);
});

test('onLegTerminal: the kill switch on the VA callback lands skipped_disabled with no text', async () => {
  const { attemptId } = await makeChainRow('fire-va-kill', {
    attemptStatus: 'calling_va', adminRing: 3, nextRingOffsetSec: null,
  });
  await withEnv({ CONSULT_CALL_ENABLED: 'false' }, () =>
    chain.onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'no-answer' }));

  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_disabled');
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 0);
});

test('onLegTerminal: an empty call status never erases the one already recorded', async () => {
  const { attemptId } = await makeChainRow('fire-empty-status', {
    attemptStatus: 'calling_admin', adminRing: 1, nextRingOffsetSec: null,
  });
  await pool.query(
    `UPDATE consult_call_attempts SET admin_call_status = 'no-answer' WHERE id = $1`, [attemptId]
  );
  for (const callStatus of ['', '   ', null, undefined]) {
    await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus });
    await pool.query(
      `UPDATE consult_call_attempts SET status = 'calling_admin' WHERE id = $1`, [attemptId]
    );
    const row = await rowOf(attemptId);
    assert.equal(row.admin_call_status, 'no-answer', `callStatus ${JSON.stringify(callStatus)}`);
  }
});

// ─── onLegTerminal: a connected row is terminal ──────────────────

test('onLegTerminal: a connected row is untouched by any callback', async () => {
  const { attemptId } = await makeChainRow('fire-connected', {
    attemptStatus: 'connected', adminRing: 2, nextRingOffsetSec: null,
  });
  await pool.query(
    `UPDATE consult_call_attempts SET answered_by = 'admin', bridge_started_at = NOW() WHERE id = $1`,
    [attemptId]
  );

  // The matching-ring terminal for the leg Dallas actually answered.
  const before = await rowOf(attemptId);
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 2, callStatus: 'completed' });
  let row = await rowOf(attemptId);
  assert.equal(row.status, 'connected', 'the bridge happened; nothing re-opens the chain');
  assert.equal(row.admin_ring, 2);
  assert.equal(row.answered_by, 'admin');
  assert.equal(row.detail, before.detail);
  assert.equal(row.next_ring_at, null);

  // And a stale ring 1 callback on the same connected row.
  const mid = await rowOf(attemptId);
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus: 'no-answer' });
  row = await rowOf(attemptId);
  assert.equal(row.updated_at, mid.updated_at, 'R5 again: a superseded ring writes nothing');
  assert.equal(row.status, 'connected');

  assert.equal(placed.length, 0, 'a connected row never places another leg');
  assert.equal(texts.length, 0, 'and never texts');
  assert.equal(emails.length, 0);
});

// ─── sendMissedText ──────────────────────────────────────────────

test('sendMissedText: the client-no-answer wording is its own sentence', async () => {
  const { consultId, attemptId } = await makeChainRow('fire-noanswer-text', {
    attemptStatus: 'connected', nextRingOffsetSec: null, name: 'Tyler Anderson',
  });
  assert.equal(await chain.sendMissedText({ attemptId, kind: 'client_no_answer' }), 'sent');
  assert.equal(texts.length, 1);
  assert.equal(
    texts[0].body,
    `Consult client did not answer: Tyler Anderson at ${clockTimeWithMinutes(await slotOf(consultId))}. Their number is 256-328-1203.`
  );
  assert.equal(texts[0].to, TEXT_DEST);
});

test('sendMissedText: falls back to ADMIN_PHONE when VM_TEXT_DESTINATION is unset', async () => {
  const { attemptId } = await makeChainRow('fire-text-fallback');
  await withEnv({ VM_TEXT_DESTINATION: null }, () => chain.sendMissedText({ attemptId, kind: 'missed' }));
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, ADMIN_PHONE);
});

test('sendMissedText: reports no_destination and sends nothing when no destination is strict E.164', async () => {
  const { attemptId } = await makeChainRow('fire-text-nodest');
  for (const dest of [null, '', '3125551234', 'not a phone', '+0123456789', '+1312555123456789']) {
    const sent = await withEnv({ VM_TEXT_DESTINATION: dest, ADMIN_PHONE: null }, () =>
      chain.sendMissedText({ attemptId, kind: 'missed' }));
    assert.equal(sent, 'no_destination', `destination ${String(dest)}`);
  }
  assert.equal(texts.length, 0);
});

test('sendMissedText: never throws, and each failure reports its OWN reason', async () => {
  // Every return here is a truthy string, so a caller that tested this for
  // truthiness would read every failure as a success. The values are what
  // finishMissed keys the email banner on, so they are asserted exactly.
  const { attemptId } = await makeChainRow('fire-text-throw');
  await assert.doesNotReject(chain.sendMissedText());
  await assert.doesNotReject(chain.sendMissedText(null));
  assert.equal(await chain.sendMissedText({ attemptId: 999999999, kind: 'missed' }), 'no_attempt');

  chain.__setDeps({ sendSMS: async () => { throw new Error('twilio 21610'); } });
  assert.equal(await chain.sendMissedText({ attemptId, kind: 'missed' }), 'send_failed',
    'a Twilio throw is a send failure, NOT a missing destination');

  chain.__setDeps({ pool: { query: async () => { throw new Error('db down'); } } });
  try {
    assert.equal(await chain.sendMissedText({ attemptId, kind: 'missed' }), 'send_failed');
  } finally {
    chain.__setDeps({ pool });
  }
});

// ─── the DIAL caps: what bounds the billed legs ───────────────────
//
// Two ceilings, counted from call_audit rather than from the attempt rows.
// The first version of this cap summed consult_call_attempts.admin_ring, and
// the R16 reschedule clear DELETEs any row LIKE 'skipped%' standing at a
// re-taken slot -- so ring, reschedule away, reschedule back, and the billed
// rings were erased from the window and the ceiling never engaged. That is the
// regression the first test below pins, and it is a DELETE, so no assertion
// about the attempt row can catch it. Only a ledger the delete cannot reach can.

const AUDIT = { admin: chain.AUDIT_ADMIN_LEG, va: chain.AUDIT_VA_LEG };

async function auditCount(status) {
  const r = await pool.query(
    `SELECT COUNT(*)::int n FROM call_audit WHERE status = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [status]
  );
  return r.rows[0].n;
}

/** Spend a leg's ceiling by writing ledger rows directly. */
async function spendLedger(status, n) {
  for (let i = 0; i < n; i += 1) {
    await pool.query(
      `INSERT INTO call_audit (triggered_by, target_e164, call_sid, status) VALUES (NULL, $1, $2, $3)`,
      [ADMIN_PHONE, `${RUN}-pad-${status}-${i}`, status]
    );
  }
}
async function clearLedger() {
  await pool.query(`DELETE FROM call_audit WHERE call_sid LIKE $1 OR target_e164 = $2 OR target_e164 = $3`,
    [`${RUN}-%`, ADMIN_PHONE, VA_CELL]);
}
/** A cap whose ceiling is already spent for `status`, derived from the live count. */
async function capThatRefuses(status, perChain) {
  const now = await auditCount(status);
  if (now < perChain) await spendLedger(status, perChain - now);
  return String(Math.max(1, Math.floor((await auditCount(status)) / perChain)));
}

test('dialCap: a leg placed through placeLeg lands in the call_audit ledger', async () => {
  await clearLedger();
  const before = await auditCount(AUDIT.admin);
  const { attemptId } = await makeChainRow('ledger-write');
  await chain.advanceChain({ attemptId });
  assert.equal(placed.length, 1, 'the ring went out');
  assert.equal(await auditCount(AUDIT.admin), before + 1, 'and it is on the ledger the cap counts');
  await clearLedger();
});

test('dialCap: BLOCKER REGRESSION — a reschedule-back cannot erase spent budget', async () => {
  // The exact defeat sequence: ring, reschedule away (row parks skipped_cancelled
  // carrying the rings), reschedule back onto the SAME slot so the R16 clear
  // fires and DELETEs that row. Under the old admin_ring counter the budget went
  // back to zero here and the ceiling never engaged again.
  await clearLedger();
  const { attemptId, consultId } = await makeChainRow('resched-erase');
  await chain.advanceChain({ attemptId });
  assert.equal(placed.length, 1);
  const spentAfterRing = await auditCount(AUDIT.admin);
  assert.equal(spentAfterRing, 1, 'one billed ring on the ledger');

  // Park it exactly as a reschedule-away would, rings intact.
  await pool.query(
    "UPDATE consult_call_attempts SET status = 'skipped_cancelled', admin_ring = $2 WHERE id = $1",
    [attemptId, chain.MAX_ADMIN_RINGS]
  );
  // The booker re-takes the same slot. This is the DELETE.
  const slot = await slotOf(consultId);
  await chain.consultCallTail({
    consultId, scheduledAt: slot, triggerEvent: 'BOOKING_RESCHEDULED',
    bookerPhone: VALID_PHONE, bookerEmail: `${RUN}-resched-erase@example.test`,
  });
  const rows = await attemptsFor(consultId);
  assert.equal(rows.length, 0, 'the R16 clear really did delete the ring-bearing row');
  assert.equal(await auditCount(AUDIT.admin), spentAfterRing,
    'but the spend survives the delete — this is the whole fix');
  await clearLedger();
});

test('dialCap: a spent admin ceiling refuses the ring, terminally', async () => {
  await clearLedger();
  const { attemptId } = await makeChainRow('admin-refuse');
  await withEnv({ CONSULT_CALL_DAILY_CAP: await capThatRefuses(AUDIT.admin, chain.MAX_ADMIN_RINGS) }, async () => {
    await chain.advanceChain({ attemptId });
  });
  assert.equal(placed.length, 0, 'no billed ring');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_cap', 'terminal, or the sweep retries every 60s forever');
  assert.equal(row.detail, 'dial_cap_tripped');
  assert.equal(row.next_ring_at, null);
  await clearLedger();
});

test('dialCap: with headroom the ring still goes out', async () => {
  // Non-vacuity: a cap wired to refuse everything passes every test above and
  // takes the whole bridge down on the launch call.
  await clearLedger();
  const { attemptId } = await makeChainRow('admin-headroom');
  await withEnv({ CONSULT_CALL_DAILY_CAP: '10' }, () => chain.advanceChain({ attemptId }));
  assert.equal(placed.length, 1);
  assert.equal(placed[0].to, ADMIN_PHONE);
  assert.equal((await rowOf(attemptId)).status, 'calling_admin');
  await clearLedger();
});

test('dialCap: the INTERNATIONAL leg is capped too, on the ADMIN_PHONE-unset path', async () => {
  // This branch had no ceiling at all in the first version, because the check
  // sat inside `if (adminPhone)`. It is the expensive one.
  await clearLedger();
  const { attemptId } = await makeChainRow('va-refuse');
  await withEnv({ ADMIN_PHONE: null, CONSULT_CALL_DAILY_CAP: await capThatRefuses(AUDIT.va, 1) }, async () => {
    await chain.advanceChain({ attemptId });
  });
  assert.equal(placed.length, 0, 'no international leg');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'skipped_cap');
  assert.equal(row.detail, 'va_leg_cap_tripped', 'named apart from the admin trip');
  await clearLedger();
});

test('dialCap: a spent international ceiling degrades ring 3 to MISSED, never to silence', async () => {
  // Dallas's phone already rang three times, so this consult is a genuine miss.
  // Filing a cap marker here would replace the missed-text with nothing.
  await clearLedger();
  const { attemptId } = await makeChainRow('va-hop-cap', { attemptStatus: 'calling_admin', adminRing: 3 });
  await withEnv({ CONSULT_CALL_DAILY_CAP: await capThatRefuses(AUDIT.va, 1) }, async () => {
    await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 3, callStatus: 'no-answer' });
  });
  assert.equal(placed.length, 0, 'no international leg was bought');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'missed', 'the chain ends as a miss, which still texts Dallas');
  assert.equal(texts.length, 1, 'and the missed text actually went');
  await clearLedger();
});

test('dialCap: the trip email fires even when two refusals race', async () => {
  // The gate counts OTHER trips, not "am I the only one". Asking "is the count
  // exactly 1" loses the alert entirely when two trips land together (both read
  // 2, neither mails) and stays silent for the whole of a sustained attack.
  await clearLedger();
  await clearCapMarkers();
  const a = await makeChainRow('email-race-a');
  const b = await makeChainRow('email-race-b');
  await withEnv({ CONSULT_CALL_DAILY_CAP: await capThatRefuses(AUDIT.admin, chain.MAX_ADMIN_RINGS) }, async () => {
    await Promise.all([
      chain.advanceChain({ attemptId: a.attemptId }),
      chain.advanceChain({ attemptId: b.attemptId }),
    ]);
  });
  assert.ok(emails.length >= 1, 'a concurrent pair must not produce ZERO alerts');
  assert.ok(emails.length <= 2, 'and must not fan out per refusal either');
  for (const id of [a.attemptId, b.attemptId]) {
    assert.equal((await rowOf(id)).status, 'skipped_cap', 'both are still refused');
  }
  await clearLedger();
  await clearCapMarkers();
});

test('dialCap: a sustained burst keeps refusing without re-mailing every time', async () => {
  await clearLedger();
  await clearCapMarkers();
  await withEnv({ CONSULT_CALL_DAILY_CAP: await capThatRefuses(AUDIT.admin, chain.MAX_ADMIN_RINGS) }, async () => {
    const first = await makeChainRow('burst-1');
    await chain.advanceChain({ attemptId: first.attemptId });
    const afterFirst = emails.length;
    assert.equal(afterFirst, 1);
    for (const tag of ['burst-2', 'burst-3', 'burst-4']) {
      const r = await makeChainRow(tag);
      await chain.advanceChain({ attemptId: r.attemptId });
      assert.equal((await rowOf(r.attemptId)).status, 'skipped_cap');
    }
    assert.equal(emails.length, afterFirst, 'the Resend quota is not emptied by a burst');
  });
  await clearLedger();
  await clearCapMarkers();
});

test('dialCap: ceilings derive from the chain cap and no value can brick the bridge', async () => {
  await withEnv({ CONSULT_CALL_DAILY_CAP: null }, () => {
    assert.equal(chain.dialCap(), 10 * chain.MAX_ADMIN_RINGS);
    assert.equal(chain.vaLegCap(), 10, 'the documented 10 international legs');
  });
  await withEnv({ CONSULT_CALL_DAILY_CAP: '7' }, () => {
    assert.equal(chain.dialCap(), 7 * chain.MAX_ADMIN_RINGS);
  });
  for (const bad of ['banana', '0', '-10', '-1']) {
    await withEnv({ CONSULT_CALL_DAILY_CAP: bad }, () => {
      assert.ok(chain.dialCap() > 0 && chain.vaLegCap() > 0,
        `"${bad}" must not produce a ceiling that refuses everything and darkens the bridge`);
    });
  }
});
