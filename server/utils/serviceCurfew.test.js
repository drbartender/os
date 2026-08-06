'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const {
  checkContractCurfew, checkCurfewForStart, curfewMessage, isParseableTime, normalizeDay,
} = require('./serviceCurfew');

// The contracted-duration half of the 2:00 AM insurance warranty. The extension
// flow is covered by eventCurfew.test.js; this covers the bigger door — a
// duration typed into the contract.

const NONCE = `svc-curfew-${Date.now()}`;
const made = [];
let clientId;

async function seed(startDisplay, durationHours, { date = '2026-09-12', tz = 'America/Chicago' } = {}) {
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone,
        pricing_snapshot, adjustments)
     VALUES ($1,'sent',100,$2,1,350,0,$3,$4,$5,'{}','[]')
     RETURNING id`,
    [clientId, durationHours, date, startDisplay, tz]
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
});

after(async () => {
  if (made.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('checkContractCurfew flags a contracted duration that runs past 2:00 AM', async () => {
  const id = await seed('10:00 PM', 6);              // ends 4:00 AM
  const r = await checkContractCurfew(pool, id, 6);
  assert.equal(r.past, true);
  assert.equal(r.maxHours, 4, '10pm -> 2am');
  assert.equal(r.curfewDisplay, '2:00 AM');
});

test('a duration ending EXACTLY at the curfew is legal', async () => {
  const id = await seed('10:00 PM', 4);              // ends 2:00 AM
  const r = await checkContractCurfew(pool, id, 4);
  assert.equal(r.past, false, 'ending AT the curfew is inside the warranty');
});

test('fractional durations do not trip on float noise', async () => {
  // 9:45 PM + 4.25h = exactly 2:00 AM. Naive float compare can make this
  // 4.250000000000001 and manufacture a breach out of a legal booking.
  const id = await seed('9:45 PM', 4.25);
  const r = await checkContractCurfew(pool, id, 4.25);
  assert.equal(r.past, false);
});

test('checkCurfewForStart works with no proposal row yet (create paths)', async () => {
  const bad = await checkCurfewForStart(pool, {
    eventDate: '2026-09-12', startTime: '9:00 PM', timezone: 'America/Chicago', durationHours: 6,
  });
  assert.equal(bad.past, true, '9pm + 6h = 3am');
  const ok = await checkCurfewForStart(pool, {
    eventDate: '2026-09-12', startTime: '9:00 PM', timezone: 'America/Chicago', durationHours: 5,
  });
  assert.equal(ok.past, false, '9pm + 5h = 2am exactly');
  assert.equal(ok.maxHours, 5);
});

test('the two entry points agree on the same event', async () => {
  // They use different SQL (one reads the row, one takes the parts), so a
  // divergence would mean the create path and the edit path disagree about
  // the same booking.
  const id = await seed('11:30 PM', 3);
  const viaRow = await checkContractCurfew(pool, id, 3);
  const viaParts = await checkCurfewForStart(pool, {
    eventDate: '2026-09-12', startTime: '11:30 PM', timezone: 'America/Chicago', durationHours: 3,
  });
  assert.equal(viaRow.past, viaParts.past);
  assert.equal(viaRow.maxHours, viaParts.maxHours);
  assert.equal(viaRow.curfewDisplay, viaParts.curfewDisplay);
});

test('unparseable or absent inputs return null, so callers decide', async () => {
  const id = await seed('TBD', 4);
  assert.equal(await checkContractCurfew(pool, id, 4), null);
  assert.equal(await checkCurfewForStart(pool, {
    eventDate: '2026-09-12', startTime: 'TBD', timezone: 'America/Chicago', durationHours: 4,
  }), null);
  assert.equal(await checkCurfewForStart(pool, {
    eventDate: null, startTime: '9:00 PM', timezone: null, durationHours: 4,
  }), null, 'a missing date is "cannot tell", not a breach');
  assert.equal(await checkContractCurfew(pool, id, 0), null, 'a zero duration is not a booking');
});

test('an unparseable time INSIDE a transaction does not poison it', async () => {
  // REGRESSION, and the case the first version of this suite missed by testing
  // on the autocommit pool: catching 22007 in JS does NOT un-abort a Postgres
  // transaction, so a swallowed cast error left every later statement dying
  // 25P02. Both route call sites run inside BEGIN, which turned "cannot tell,
  // skip the guard" into a permanent 500 on any proposal holding a free-text
  // time — reachable from the UNAUTHENTICATED public quote builder.
  // Shape-invalid AND range-invalid AND unicode-whitespace, because a
  // shape-only screen passed the middle class straight through to a raise:
  // "9:60" and "13:00 PM" look like times and are rejected by Postgres (22008).
  const cases = ['TBD', '9:60', '25:00', '13:00 PM', '9:00:99', '99:00', '9:00 PM', ' 9:00 PM'];
  for (const bad of cases) {
    const id = await seed(bad, 4);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const viaParts = await checkCurfewForStart(client, {
        eventDate: '2026-09-12', startTime: bad, timezone: null, durationHours: 4,
      });
      assert.equal(viaParts, null, `${JSON.stringify(bad)} must report "cannot tell"`);
      const viaRow = await checkContractCurfew(client, id, 4);
      assert.equal(viaRow, null, `${JSON.stringify(bad)} via the row path too`);
      // THE ASSERTION THAT MATTERS: the transaction is still usable. Without
      // it, every later statement in the caller's BEGIN dies 25P02 and the
      // admin PATCH of that proposal 500s forever.
      const { rows } = await client.query('SELECT 1 AS ok');
      assert.equal(rows[0].ok, 1, `transaction died after screening ${JSON.stringify(bad)}`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
});

test('the screen is strictly narrower than the Postgres parser', async () => {
  // The property the whole fix rests on: anything isParseableTime admits,
  // Postgres must accept. A single divergence re-opens the blocker, so assert
  // it directly against the database rather than trusting the regex by eye.
  const candidates = [
    '9:00 PM', '9:00 pm', '9:00pm', '21:00', '09:00', '9:00:00 PM', '0:00', '23:59',
    '12:00 AM', '12:59 PM', '1:05 am',
    '9:60', '25:00', '13:00 PM', '0:00 PM', '9:00:99', '99:00', '24:00', '24:01',
    'TBD', '9 PM', '9PM', '9:00 p.m.', 'noon', '', '   ', '9:0',
    '9:00 PM', ' 9:00 PM', ' 9:00 PM', '9:00 PM ', '9:00\tPM',
  ];
  for (const s of candidates) {
    const screened = isParseableTime(s);
    let pgAccepts = true;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT ('2026-09-12 ' || $1::text)::timestamp", [s]);
      await c.query('ROLLBACK');
    } catch {
      pgAccepts = false;
      try { await c.query('ROLLBACK'); } catch { /* already aborted */ }
    } finally {
      c.release();
    }
    if (screened) {
      assert.ok(pgAccepts, `screen admitted ${JSON.stringify(s)} but Postgres rejects it`);
    }
  }
});

test('odd free-text times are skipped, not refused and not fatal', async () => {
  // Every one of these is a real shape a free-text column can hold. None may
  // throw, and none may be treated as a breach (fail open, same as before).
  // The last three are the dangerous ones: they LOOK parseable but Postgres
  // raises on them (22023 / 22007), so a looser pre-screen would let them
  // through and poison the caller's transaction.
  for (const t of ['TBD', '7pm', 'noon', 'midnight', 'whenever', '', '   ', 'null',
    '9:00 p.m.', '9 PM', '9PM']) {
    const r = await checkCurfewForStart(pool, {
      eventDate: '2026-09-12', startTime: t, timezone: null, durationHours: 12,
    });
    assert.equal(r, null, `${JSON.stringify(t)} must skip the guard, not refuse or throw`);
  }
  // But every form the app actually writes still works.
  for (const t of ['9:00 PM', '21:00', '9:00pm', '9:00:00 PM']) {
    const r = await checkCurfewForStart(pool, {
      eventDate: '2026-09-12', startTime: t, timezone: null, durationHours: 6,
    });
    assert.ok(r, `${JSON.stringify(t)} must still be read`);
    assert.equal(r.past, true, '9pm + 6h = 3am');
  }
});

test('the client-facing message never prints a raw float', () => {
  // An 8:10 PM start yields 5.833333333333333 hours of room; clients see this.
  const m = curfewMessage('2:00 AM', 5.833333333333333);
  assert.ok(!/\d\.\d{3,}/.test(m), `no long decimal in: ${m}`);
  // A zero-room booking gets no dead-end "0 hours" clause.
  assert.ok(!/0 hours/.test(curfewMessage('2:00 AM', 0)));
});

test('a pg Date event_date is accepted, not concatenated into garbage', async () => {
  // REGRESSION: a DATE column arrives from pg as a JS Date, which serializes to
  // "2026-09-12T05:00:00.000Z". Concatenating that with a time string raises
  // 22007 mid-transaction and poisons the caller's whole PATCH. Every route
  // caller passes the row value straight through, so the helper normalizes.
  const asDate = await checkCurfewForStart(pool, {
    eventDate: new Date(2026, 8, 12),      // month index 8 = September, local
    startTime: '9:00 PM', timezone: 'America/Chicago', durationHours: 6,
  });
  assert.ok(asDate, 'a Date must not fall through to the null "cannot tell" path');
  assert.equal(asDate.past, true);
  const asString = await checkCurfewForStart(pool, {
    eventDate: '2026-09-12', startTime: '9:00 PM', timezone: 'America/Chicago', durationHours: 6,
  });
  assert.deepEqual(asDate, asString, 'Date and string forms must agree exactly');
});

test('the message names the stop and the cap in one sentence', () => {
  const m = curfewMessage('2:00 AM', 5);
  assert.ok(m.includes('2:00 AM'));
  assert.ok(m.includes('5 hours'));
  assert.ok(/liquor liability/i.test(m), 'says WHY, so it does not read as an arbitrary rule');
});

test('a malformed event_DATE does not poison the transaction either', async () => {
  // BOTH operands of the cast must be screened. Round 2 fixed the time and left
  // the day unscreened, so `{"event_date":"banana"}` from a request body still
  // raised 22007 inside the caller's BEGIN — including on the client-reachable
  // change-request route. Same bug, other half.
  const hostile = ['banana', 'TBD', '2026-13-45', '2026-02-30', '', '9/12/2026', '2026-9-12', null];
  for (const bad of hostile) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await checkCurfewForStart(client, {
        eventDate: bad, startTime: '9:00 PM', timezone: null, durationHours: 12,
      });
      assert.equal(r, null, `${JSON.stringify(bad)} must report "cannot tell"`);
      const { rows } = await client.query('SELECT 1 AS ok');
      assert.equal(rows[0].ok, 1, `transaction died on event_date ${JSON.stringify(bad)}`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
});

test('normalizeDay accepts only real calendar dates', () => {
  assert.equal(normalizeDay('2026-09-12'), '2026-09-12');
  assert.equal(normalizeDay(new Date(2026, 8, 12)), '2026-09-12', 'pg Date form');
  assert.equal(normalizeDay('2026-09-12T05:00:00.000Z'), '2026-09-12', 'ISO instant truncates');
  assert.equal(normalizeDay('2028-02-29'), '2028-02-29', 'a real leap day (2028 IS a leap year)');
  for (const bad of ['2026-02-30', '2026-02-29', '2027-02-29', '2026-13-01', '2026-00-10', '2026-09-00',
    'banana', '9/12/2026', '2026-9-12', '', null, undefined, new Date('nope')]) {
    assert.equal(normalizeDay(bad), null, `${JSON.stringify(String(bad))} must be refused`);
  }
});

test('a Date with a low or unpadded year is refused, not rendered into garbage', () => {
  // REGRESSION: the Date branch padded month and day but NOT the year, so a
  // year-26 row rendered "26-06-15" — which Postgres rejects (22008), poisoning
  // the caller's transaction through the very branch added to prevent that.
  // Worse, years 1-12 do not raise; they silently misparse ("1-06-15" reads as
  // 2015-06-01), evaluating the curfew against a different day.
  for (const y of [0, 1, 12, 26, 99, 999, -1]) {
    const d = new Date(2026, 5, 15);
    d.setFullYear(y);
    assert.equal(normalizeDay(d), null, `year ${y} must be refused, not rendered`);
  }
  // A normal year still works and is zero-padded consistently.
  assert.equal(normalizeDay(new Date(2026, 5, 15)), '2026-06-15');
  assert.equal(normalizeDay(new Date(9999, 11, 31)), '9999-12-31');
});

test('values that cannot be coerced to a string are refused, never thrown', () => {
  // A JSON body can carry {"toString":"x"}: a non-callable toString makes
  // String() throw a TypeError, which surfaced as a 500 where a 400 belongs.
  const hostile = [{ toString: 'x' }, { toString: 1 }, Object.create(null)];
  for (const h of hostile) {
    assert.doesNotThrow(() => normalizeDay(h), 'normalizeDay must not throw');
    assert.equal(normalizeDay(h), null);
    assert.doesNotThrow(() => isParseableTime(h), 'isParseableTime must not throw');
    assert.equal(isParseableTime(h), false);
  }
  // Non-strings never reach the cast as an unscreened shape.
  assert.equal(isParseableTime(['9:00 PM']), false, 'an array is not a screened string');
  assert.equal(isParseableTime(2100), false);
});
