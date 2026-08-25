require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const chain = require('./consultCallChain');
const sweep = require('./consultCallSweep');

// ─── consult call sweep: the 60 second clock ─────────────────────
//
// READ THIS BEFORE DEBUGGING A FAILURE HERE. All three of the sweep's queries
// are GLOBAL over this database: the open and missed-window steps scan EVERY
// consults row inside their window, and the fire step scans EVERY pending
// consult_call_attempts row whose ring is due, not just this suite's fixtures.
// Today the dev database holds no future consults and no attempt rows, so a
// tick sees only what a test just created. The day a real Cal.com booking
// lands inside a window while this suite runs, a count assertion here would
// fail through no fault of the sweep. Every assertion is therefore taken
// against THIS RUN's fixture ids, and the returned counters are only asserted
// where the suite owns every row the tick could have touched.
//
// Shared dev DB (this suite runs ALONE). The chain is the REAL module: only
// Twilio, SMS and email are stubbed, through the chain's __setDeps, so the
// (consult_id, scheduled_at) UNIQUE, the anti-join, the claim guards and the
// ring arithmetic are all exercised for real.
//
// EVERY fixture slot carries microseconds (.123456), deliberately, the same as
// consultCallChain.test.js: ruling R12 forbids a slot round-tripping through
// JavaScript, and a sub-millisecond slot is what makes a regression fail loudly
// instead of silently re-opening a chain every 60 seconds until the cap trips.

const RUN = `ccs-test-${Date.now()}`;
const VALID_PHONE = '+12563281203';

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
 * SQL so it always carries sub-millisecond precision and never comes from JS.
 *
 * date_trunc('second', NOW()) means a fixture lands up to one second EARLIER
 * than its nominal offset, which is why no fixture sits closer than a second
 * to a window boundary in the direction that would cross it.
 */
async function makeConsult(tag, opts = {}) {
  const {
    phone = VALID_PHONE,
    offsetSec = 120,
    status = 'scheduled',
    name = 'Test Booker',
  } = opts;
  const r = await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email, booker_phone)
     VALUES ($1,
             date_trunc('second', NOW()) + make_interval(secs => $2) + INTERVAL '123456 microseconds',
             $3, $4, $5, $6)
     RETURNING id`,
    [`${RUN}-${tag}`, offsetSec, status, name, `${RUN}-${tag}@example.test`, phone]
  );
  return r.rows[0].id;
}

/**
 * Every attempt row for one consult, with the two facts that must be judged in
 * SQL rather than JavaScript: whether the row's slot still equals the
 * consult's (R12: two JS Date objects compared with === answer by identity),
 * and whether its ring is still ahead of now.
 */
async function attemptsFor(consultId) {
  const r = await pool.query(
    `SELECT a.id, a.status, a.admin_ring, a.detail,
            (a.next_ring_at IS NOT NULL AND a.next_ring_at > NOW()) AS ring_ahead,
            (a.next_ring_at IS NULL) AS ring_cleared,
            (a.scheduled_at = c.scheduled_at) AS slot_matches_consult
       FROM consult_call_attempts a
       JOIN consults c ON c.id = a.consult_id
      WHERE a.consult_id = $1
      ORDER BY a.id`,
    [consultId]
  );
  return r.rows;
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.CONSULT_CALL_ENABLED;
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  // The daily cap is C4a's behavior and is tested there. Raised here so a
  // rolling-24h count left by an earlier suite can never cap-trip a window
  // assertion that is not about the cap at all.
  process.env.CONSULT_CALL_DAILY_CAP = '500';
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
  sweep.__setDeps({ pool, chain });
});

// Per test, not just at the end: the sweep's queries are global, so a fixture
// one test left behind would be swept up by the next test's tick and thrown
// into its counters. Only rows this run created are ever deleted, and attempt
// rows cascade with their consult.
afterEach(async () => {
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${RUN}-%`]);
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${RUN}-%`]);
  await pool.end();
});

// ─── step 1 and step 2: the window boundaries ────────────────────

test('one tick: the window boundaries decide exactly which consults open, which are filed missed, and which are left alone', async () => {
  const plus2 = await makeConsult('w-plus2', { offsetSec: 120 });
  const plus459 = await makeConsult('w-plus459', { offsetSec: 299 });
  const plus6 = await makeConsult('w-plus6', { offsetSec: 360 });
  const minus2 = await makeConsult('w-minus2', { offsetSec: -120 });
  const minus4 = await makeConsult('w-minus4', { offsetSec: -240 });
  const minus20 = await makeConsult('w-minus20', { offsetSec: -1200 });
  const minus40 = await makeConsult('w-minus40', { offsetSec: -2400 });
  const cancelled = await makeConsult('w-cancelled', { offsetSec: 120, status: 'cancelled' });

  const r = await sweep.runConsultCallSweep();

  // The suite owns every consult and every attempt row this tick could reach
  // (see the global-query note in the header), so the counters are exact.
  assert.deepEqual(r, {
    opened: 3, capTripped: 0, skippedInvalid: 0, missedWindow: 2, ringsProcessed: 1,
  });

  // Opened, ring still ahead: +2m and +4m59s are inside (NOW - 3m, NOW + 5m].
  for (const [label, id] of [['+2m', plus2], ['+4m59s', plus459]]) {
    const rows = await attemptsFor(id);
    assert.equal(rows.length, 1, `${label} should have exactly one attempt row`);
    assert.equal(rows[0].status, 'pending', label);
    assert.equal(rows[0].ring_ahead, true, `${label} rings 90s before its slot, which is still ahead`);
    assert.equal(rows[0].slot_matches_consult, true, `${label} chain must sit on the consult's own slot`);
  }

  // The catch-up case: a slot two minutes gone is still inside the behind
  // bound, so it opens AND its ring is already due, so the same tick fires it.
  const lateRows = await attemptsFor(minus2);
  assert.equal(lateRows.length, 1);
  assert.equal(lateRows[0].status, 'calling_admin', '-2m opens late and rings in the same tick');
  assert.equal(lateRows[0].admin_ring, 1);
  assert.equal(lateRows[0].ring_cleared, true, 'a placed ring clears next_ring_at');

  // Filed missed: inside (NOW - 30m, NOW - 3m].
  for (const [label, id] of [['-4m', minus4], ['-20m', minus20]]) {
    const rows = await attemptsFor(id);
    assert.equal(rows.length, 1, `${label} should have exactly one attempt row`);
    assert.equal(rows[0].status, 'skipped_missed_window', label);
    assert.equal(rows[0].slot_matches_consult, true, label);
  }

  // Untouched: past the ahead bound, past the missed bound, or not scheduled.
  for (const [label, id] of [['+6m', plus6], ['-40m', minus40], ['cancelled +2m', cancelled]]) {
    assert.deepEqual(await attemptsFor(id), [], `${label} must not be touched`);
  }

  // One email per missed-window row (ruling R7), and nothing else emails.
  assert.equal(emails.length, 2, 'each missed window is a person who waited for a call');
  for (const e of emails) {
    assert.match(e.subject, /^Consult call missed window:/, e.subject);
  }

  // Exactly one billed leg, and it is the admin number dialed verbatim.
  assert.equal(placed.length, 1);
  assert.equal(placed[0].to, ADMIN_PHONE);
  assert.equal(texts.length, 0);
});

// ─── step 3: the fire step ───────────────────────────────────────

test('fire step: a ring still ahead waits while one already due fires immediately, and a due row fires exactly once across two ticks', async () => {
  const ahead = await makeConsult('f-ahead', { offsetSec: 120 });
  const due = await makeConsult('f-due', { offsetSec: -120 });

  const first = await sweep.runConsultCallSweep();
  assert.equal(first.opened, 2);
  assert.equal(first.ringsProcessed, 1, 'only the row whose ring is already past fires');
  assert.equal(placed.length, 1);
  assert.match(String(placed[0].url), /leg=admin&ring=1/);

  const aheadRows = await attemptsFor(ahead);
  assert.equal(aheadRows[0].status, 'pending', 'a ring 30 seconds out is not this tick');
  assert.equal(aheadRows[0].ring_ahead, true);
  const dueRows = await attemptsFor(due);
  assert.equal(dueRows[0].status, 'calling_admin');
  assert.equal(dueRows[0].admin_ring, 1);

  const second = await sweep.runConsultCallSweep();
  assert.equal(second.opened, 0, 'both consults already carry a chain at their slot');
  assert.equal(second.ringsProcessed, 0, 'the rung row left pending and cleared its ring');
  assert.equal(placed.length, 1, 'a due row fires exactly once, never once per tick');
  const dueAfter = await attemptsFor(due);
  assert.equal(dueAfter[0].status, 'calling_admin');
  assert.equal(dueAfter[0].admin_ring, 1, 'a second tick must not advance the ring');
});

// ─── the kill switch ─────────────────────────────────────────────

test('kill switch: the tick returns the skipped shape and touches nothing, not even a ring already due', async () => {
  const upcoming = await makeConsult('k-upcoming', { offsetSec: 120 });
  const missed = await makeConsult('k-missed', { offsetSec: -240 });
  const openAlready = await makeConsult('k-open', { offsetSec: -120 });
  // Opened while the feature is ON, so the row is pending with a ring already
  // past: exactly the state the switch has to leave alone.
  assert.equal(await chain.openChain({ consultId: openAlready }), 'opened');
  emails = [];

  process.env.CONSULT_CALL_ENABLED = 'false';
  let r;
  try {
    r = await sweep.runConsultCallSweep();
  } finally {
    delete process.env.CONSULT_CALL_ENABLED;
  }

  assert.deepEqual(r, { skipped: true });
  assert.deepEqual(await attemptsFor(upcoming), []);
  assert.deepEqual(await attemptsFor(missed), []);
  const openRows = await attemptsFor(openAlready);
  assert.equal(openRows.length, 1);
  assert.equal(openRows[0].status, 'pending', 'the switch is off, so the due row is not even advanced');
  assert.equal(placed.length, 0);
  assert.equal(emails.length, 0);
  assert.equal(texts.length, 0);
});

// ─── undialable numbers ──────────────────────────────────────────

test('an undialable consult inside the open window files once across two ticks and never opens a chain', async () => {
  // A real UK number: normalizePhone resolves it, toUsE164 rejects it, which is
  // the case a length check alone would wave through.
  const foreign = await makeConsult('u-foreign', { offsetSec: 120, phone: '+442071234567' });

  const first = await sweep.runConsultCallSweep();
  assert.equal(first.skippedInvalid, 1);
  assert.equal(first.opened, 0, 'an unusable number must never reach openChain');
  const rows = await attemptsFor(foreign);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_invalid_phone');
  assert.equal(rows[0].detail, 'invalid_phone');
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /^Consult call undialable number:/);

  const second = await sweep.runConsultCallSweep();
  assert.equal(second.skippedInvalid, 0, 'the filed row is the anti-join that stops the second file');
  assert.equal(second.opened, 0);
  assert.deepEqual(await attemptsFor(foreign), rows, 'the row is untouched by the second tick');
  assert.equal(emails.length, 1, 'one row, one email, no matter how many ticks run');
  assert.equal(placed.length, 0);
});

test('a consult with no number at all files the no_phone skip rather than opening a chain', async () => {
  const blank = await makeConsult('u-blank', { offsetSec: 120, phone: null });
  const r = await sweep.runConsultCallSweep();
  assert.equal(r.skippedInvalid, 1);
  assert.equal(r.opened, 0);
  const rows = await attemptsFor(blank);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_invalid_phone');
  assert.equal(rows[0].detail, 'no_phone');
  assert.equal(placed.length, 0);
});

// ─── a slot that moved between the open and the ring ─────────────

test('a consult rescheduled between open and fire ends up cancelled rather than rung', async () => {
  const moved = await makeConsult('r-moved', { offsetSec: 120 });

  const first = await sweep.runConsultCallSweep();
  assert.equal(first.opened, 1);
  assert.equal(first.ringsProcessed, 0, 'the ring is still 30 seconds out');

  // The reschedule: Cal.com moves the slot three hours out. The attempt row
  // keeps the OLD slot by design (one chain per (consult, slot)). The slot is
  // moved in SQL, never through JS, exactly as the webhook does it.
  await pool.query(
    `UPDATE consults SET scheduled_at = NOW() + INTERVAL '3 hours' + INTERVAL '123456 microseconds'
      WHERE id = $1`,
    [moved]
  );
  // Stand in for the 30 seconds of wall clock between the open and the ring.
  // next_ring_at only; scheduled_at is left exactly as the open wrote it.
  await pool.query(
    `UPDATE consult_call_attempts SET next_ring_at = NOW() - INTERVAL '5 seconds' WHERE consult_id = $1`,
    [moved]
  );

  const second = await sweep.runConsultCallSweep();
  // ringsProcessed, not "fired": this ring is processed and terminated without
  // anyone's phone ringing, which is exactly why the counter is not called fired.
  assert.equal(second.ringsProcessed, 1, 'the stale chain is picked up');
  assert.equal(second.opened, 0, 'the new slot is three hours out, far outside the open window');
  assert.equal(placed.length, 0, 'a moved slot must never place a call');

  const rows = await attemptsFor(moved);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_cancelled');
  assert.equal(rows[0].detail, 'rescheduled');
  assert.equal(rows[0].ring_cleared, true);
  assert.equal(rows[0].slot_matches_consult, false, 'the chain still names the slot it opened against');
  assert.equal(emails.length, 0);
});

// ─── one bad row must not stop the tick ──────────────────────────

test('a row that throws is logged and skipped, the rest of the tick still runs, and the tick still fails', async () => {
  // The bad row sorts first (ORDER BY scheduled_at, id), so if a throw could
  // stop the loop, the good row would never be opened.
  const bad = await makeConsult('e-bad', { offsetSec: 120 });
  const good = await makeConsult('e-good', { offsetSec: 121 });
  const due = await makeConsult('e-due', { offsetSec: -120 });

  sweep.__setDeps({
    chain: {
      ...chain,
      openChain: async (args) => {
        if (Number(args.consultId) === Number(bad)) throw new Error('boom_open');
        return chain.openChain(args);
      },
    },
  });
  try {
    await assert.rejects(
      sweep.runConsultCallSweep(),
      /boom_open/,
      'a swallowed row error would report a green tick over a consult nobody called'
    );
  } finally {
    sweep.__setDeps({ chain });
  }

  assert.deepEqual(await attemptsFor(bad), [], 'the throwing row opened nothing');
  const goodRows = await attemptsFor(good);
  assert.equal(goodRows.length, 1, 'a later row in the same step still ran');
  assert.equal(goodRows[0].status, 'pending');
  const dueRows = await attemptsFor(due);
  assert.equal(dueRows.length, 1, 'the fire step still ran after the open step raised');
  assert.equal(dueRows[0].status, 'calling_admin');
  assert.equal(placed.length, 1);
});

test('a step whose own query fails costs the later steps nothing, and the tick still fails', async () => {
  // The per-row handlers above catch inside the step, so the step function
  // returns normally and the guard AROUND it never runs. This breaks the step's
  // own query instead, which is the only way to reach that guard, and the only
  // proof that a dead open query still lets the fire step place the ring a
  // booker is waiting for.
  const due = await makeConsult('s-due', { offsetSec: -120 });
  const missed = await makeConsult('s-missed', { offsetSec: -240 });
  // Opened before the pool is broken, so the fire step has real work on the
  // broken tick. The chain keeps the REAL pool; only the sweep's is stubbed.
  assert.equal(await chain.openChain({ consultId: due }), 'opened');

  sweep.__setDeps({
    pool: {
      // Only the open query carries a NOW() + interval bound; the other two
      // pass straight through to the real database.
      query: (text, params) => (String(text).includes('NOW() + make_interval')
        ? Promise.reject(new Error('open_step_down'))
        : pool.query(text, params)),
    },
  });
  try {
    await assert.rejects(sweep.runConsultCallSweep(), /open_step_down/);
  } finally {
    sweep.__setDeps({ pool });
  }

  const missedRows = await attemptsFor(missed);
  assert.equal(missedRows.length, 1, 'step 2 ran even though step 1 was dead');
  assert.equal(missedRows[0].status, 'skipped_missed_window');
  assert.equal(emails.length, 1, 'and it sent its email');
  const dueRows = await attemptsFor(due);
  assert.equal(dueRows[0].status, 'calling_admin', 'step 3 ran too');
  assert.equal(placed.length, 1, 'a dead open query must not cost a booker their call');
});

test('a rejection carrying a falsy value still fails the tick, as a real Error', async () => {
  const bad = await makeConsult('z-falsy', { offsetSec: 120 });
  const good = await makeConsult('z-falsy-good', { offsetSec: 121 });

  sweep.__setDeps({
    chain: {
      ...chain,
      // Nothing rejects this way today. It is the one shape that would slip a
      // failed tick past a handler that decided by testing the error VALUE, and
      // a green heartbeat over a consult nobody called is this feature's worst
      // outcome, so the hole is closed rather than argued about.
      openChain: (args) => (Number(args.consultId) === Number(bad)
        ? Promise.reject(undefined)
        : chain.openChain(args)),
    },
  });
  try {
    await assert.rejects(sweep.runConsultCallSweep(), (err) => {
      assert.ok(err instanceof Error, 'wrapScheduler reads err.message off what it catches');
      assert.match(err.message, /undefined/);
      return true;
    });
  } finally {
    sweep.__setDeps({ chain });
  }

  assert.deepEqual(await attemptsFor(bad), []);
  assert.equal((await attemptsFor(good)).length, 1, 'the rest of the tick still ran');
});

test('the window constants the sweep binds are sound, which is what index.js checks before wiring it', async () => {
  // THIS ASSERTION IS THE FEATURE'S CHEAPEST GUARD. The sweep binds these three
  // straight into both window predicates. If one ever arrives undefined the bind
  // sends NULL, every predicate evaluates to NULL, both queries return zero rows,
  // and the scheduler writes a healthy heartbeat every sixty seconds forever over
  // a bridge that is completely dead. index.js asks the same question at boot and
  // leaves the sweep unwired if the answer is bad, but that is the expensive path,
  // reached only after a deploy. This one fails here, before anything ships, when
  // nobody is waiting on a phone call.
  assert.equal(sweep.windowConstantsFault(), null);
  for (const name of ['OPEN_AHEAD_MINUTES', 'OPEN_BEHIND_MINUTES', 'MISSED_WINDOW_MINUTES']) {
    const value = chain[name];
    assert.ok(Number.isInteger(value) && value > 0, `${name} is ${String(value)}`);
  }
  assert.ok(chain.OPEN_BEHIND_MINUTES < chain.MISSED_WINDOW_MINUTES,
    'the missed window has to reach further back than the open window, or step 2 is empty');
});

test('windowConstantsFault names the bad constant rather than passing it through', async () => {
  // The detector's own negative path, tested. A detector that silently returned
  // null for a broken constant would reintroduce the exact silence it exists to
  // prevent, and nothing else in the suite would notice.
  const sound = {
    OPEN_AHEAD_MINUTES: 5, OPEN_BEHIND_MINUTES: 3, MISSED_WINDOW_MINUTES: 30,
  };
  assert.equal(sweep.windowConstantsFault(sound), null);
  assert.equal(sweep.windowConstantsFault(null), null, 'a null source falls back to the real chain');

  for (const name of ['OPEN_AHEAD_MINUTES', 'OPEN_BEHIND_MINUTES', 'MISSED_WINDOW_MINUTES']) {
    for (const bad of [undefined, null, NaN, 0, -1, '5', 4.5]) {
      const fault = sweep.windowConstantsFault({ ...sound, [name]: bad });
      assert.match(String(fault), new RegExp(name), `${name} = ${String(bad)} must be caught`);
    }
  }

  // Same silent-dark class: a missed window that does not reach past the open
  // window leaves step 2's range empty and every passed slot unfiled.
  assert.match(
    String(sweep.windowConstantsFault({ ...sound, MISSED_WINDOW_MINUTES: 3 })),
    /must be less than/
  );
});
