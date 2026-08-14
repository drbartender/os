// THE shift end-instant predicate, proven exhaustively and deterministically.
//
// This is the suite that makes the rest possible. The database clock cannot be
// mocked, so any test that seeds rows and compares them to NOW() can only prove
// the predicate at whatever o'clock the suite happens to run. Here the
// comparison instant is a BOUND PARAMETER instead of NOW(), so every hour of the
// day, both sides of both DST transitions, and every shape of dirty data are
// checked in one pass with zero clock dependence.
//
// It is also the fails-before/passes-after proof for the whole family: each
// case states what `event_date >= CURRENT_DATE` (the predicate every site used
// before, resolved in this session's GMT zone) answered, and the assertions
// show the end instant answering differently. The single-TZ blindness that hid
// this bug for months is covered by running the file at both:
//
//   TZ=UTC              node --test server/utils/shiftEndInstant.test.js
//   TZ=America/Chicago  node --test server/utils/shiftEndInstant.test.js
//
// Nothing here reads the process timezone — that is the point. A result that
// moves between those two runs is itself the bug.

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  shiftEndInstantSql,
  shiftNotFinishedSql,
  shiftFinishedSql,
} = require('./shiftEndInstant');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shiftEndInstant.test.js refuses to run against production');
}

const CHI = 'America/Chicago';

/**
 * Evaluate the end instant for one synthetic shift with no DB rows involved:
 * the shift and its proposal are VALUES lists, so this touches no fixture and
 * cannot collide with a parallel suite.
 *
 * The synthetic `p` carries BOTH columns the expression reads — event_timezone
 * and event_duration_hours — so the harness models the real join rather than a
 * subset of it. A missing column here reads as "the expression is broken" when
 * the truth is "the fixture is thinner than production".
 *
 * @param {{event_date:string, start_time:string|null, end_time:string|null, tz:string|null, duration_hours:number|null}} shift
 * @returns {Promise<string>} the end instant as an ISO-8601 UTC string
 */
async function endInstantOf({ event_date, start_time = null, end_time = null, tz = null, duration_hours = null }) {
  const { rows } = await pool.query(
    `SELECT ${shiftEndInstantSql('s', 'p')} AS ts
       FROM (VALUES ($1::date, $2::varchar, $3::varchar)) AS s(event_date, start_time, end_time),
            (VALUES ($4::text, $5::numeric)) AS p(event_timezone, event_duration_hours)`,
    [event_date, start_time, end_time, tz, duration_hours]
  );
  return new Date(rows[0].ts).toISOString();
}

/** The same shift measured against an explicit instant instead of NOW(). */
async function classifyAt({ event_date, start_time = null, end_time = null, tz = null, duration_hours = null }, atIso) {
  const { rows } = await pool.query(
    `SELECT (${shiftEndInstantSql('s', 'p')}) > $6::timestamptz AS not_finished,
            (${shiftEndInstantSql('s', 'p')}) <= $6::timestamptz AS finished
       FROM (VALUES ($1::date, $2::varchar, $3::varchar)) AS s(event_date, start_time, end_time),
            (VALUES ($4::text, $5::numeric)) AS p(event_timezone, event_duration_hours)`,
    [event_date, start_time, end_time, tz, duration_hours, atIso]
  );
  return rows[0];
}

before(async () => {
  // Premise, asserted loudly: this whole family of bugs exists because the
  // Postgres SESSION runs at GMT while the business runs in Chicago. If that
  // ever stops being true, several assertions below become vacuous rather than
  // wrong, so fail here instead of passing quietly.
  const { rows } = await pool.query(`SELECT current_setting('TimeZone') AS tz`);
  assert.equal(
    rows[0].tz, 'GMT',
    `test premise: the DB session must run at GMT for the CURRENT_DATE contrasts below to mean anything (got ${rows[0].tz})`
  );
});

after(async () => { await pool.end(); });

// ─── Rule 1: a parseable end_time ──────────────────────────────────────────

test('rule 1: end_time is interpreted in the event timezone, not the session zone', async () => {
  // 2026-08-14 23:00 Chicago (CDT, UTC-5) is 2026-08-15T04:00Z. Read naively in
  // the GMT session it would have been 2026-08-14T23:00Z — five hours early,
  // which is exactly how an evening shift auto-vanished.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time: '11:00 PM', tz: CHI }),
    '2026-08-15T04:00:00.000Z'
  );
});

test('rule 1: 24-hour and lowercase meridiem forms both parse', async () => {
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '18:00', end_time: '22:00', tz: CHI }),
    '2026-08-15T03:00:00.000Z'
  );
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 pm', end_time: '11:00 pm', tz: CHI }),
    '2026-08-15T04:00:00.000Z'
  );
});

test('rule 1: the proposal timezone is honored, not assumed to be Chicago', async () => {
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time: '11:00 PM', tz: 'America/New_York' }),
    '2026-08-15T03:00:00.000Z'
  );
});

test('rule 1 + DST: the offset that applies ON THE EVENT DATE is used, both directions', async () => {
  // 2026-11-01 is the fall-back day: 23:00 is already CST (UTC-6).
  assert.equal(
    await endInstantOf({ event_date: '2026-11-01', start_time: '6:00 PM', end_time: '11:00 PM', tz: CHI }),
    '2026-11-02T05:00:00.000Z'
  );
  // 2026-03-08 is the spring-forward day: 23:00 is already CDT (UTC-5).
  assert.equal(
    await endInstantOf({ event_date: '2026-03-08', start_time: '6:00 PM', end_time: '11:00 PM', tz: CHI }),
    '2026-03-09T04:00:00.000Z'
  );
});

// ─── Rule 2: no usable end_time — ASSUME it, do not defer to midnight ──────

test('rule 2: an unknown end is assumed from the start plus the booked length', async () => {
  // 14 of 78 prod shifts have no end_time. 6pm CDT is 23:00Z; the assumed end is
  // start + booked length + overrun grace.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time: null, tz: CHI, duration_hours: null }),
    '2026-08-15T07:00:00.000Z', // 18:00 + ASSUMED_HOURS(4) + GRACE(4) = 02:00 next day CDT
  );
  // The PROPOSAL's booked length is used when it has one.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time: null, tz: CHI, duration_hours: 6 }),
    '2026-08-15T09:00:00.000Z', // 18:00 + 6 + 4 = 04:00 next day CDT
  );
});

test('rule 2 REGRESSION: a finished morning shift is NOT still upcoming at 19:30', async () => {
  // The P1 this rule exists for. Under the first cut (unknown end -> midnight) a
  // 10am brunch with a NULL end_time was still "not finished" at 19:30, sorted
  // AHEAD of tomorrow's shift in findNearestApprovedShift, and a CANT text meant
  // for tomorrow denied and re-opened the shift the staffer had already worked —
  // pulling them off the roster payroll pays from. That was a REGRESSION against
  // `event_date >= CURRENT_DATE`, which excluded it by accident of GMT rollover.
  const brunch = { event_date: '2026-08-14', start_time: '10:00 AM', end_time: null, tz: CHI, duration_hours: 4 };
  // 10:00 + 4 + 4 = 18:00 CDT = 23:00Z. At 19:30 Chicago (00:30Z the 15th) it is over.
  assert.equal((await classifyAt(brunch, '2026-08-15T00:30:00Z')).not_finished, false);
  // ...and it is still visible while it is plausibly running: 15:00 Chicago.
  assert.equal((await classifyAt(brunch, '2026-08-14T20:00:00Z')).not_finished, true);

  // The grace is what keeps a shift that runs long from vanishing mid-service:
  // an evening shift is still visible well after its booked end.
  const evening = { event_date: '2026-08-14', start_time: '6:00 PM', end_time: null, tz: CHI, duration_hours: 4 };
  assert.equal((await classifyAt(evening, '2026-08-15T04:59:00Z')).not_finished, true); // 23:59 Chicago
});

test('rule 2: garbage and out-of-range end_times fall back, they never raise', async () => {
  // '25:00' and '13:70' match the spec's loose regex and would throw 22007 on
  // ::time — a 500 on the staff Available tab. They take the assumed end instead.
  for (const end_time of ['evening', '25:00', '13:70', '13:00 PM', '9:5', '']) {
    assert.equal(
      await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time, tz: CHI, duration_hours: null }),
      '2026-08-15T07:00:00.000Z',
      `end_time ${JSON.stringify(end_time)} must take the assumed-end fallback`
    );
  }
});

test('rule 3 REGRESSION: an end_time with NO parseable start never resolves to that morning', async () => {
  // An overnight wrap cannot be detected without a start. The first cut compared
  // against midnight, so a New Year's Eve shift with end_time '1:00 AM' and no
  // start resolved to 01:00 on the MORNING of its own event date and was hidden
  // for its entire service day — the exact P0 this whole spec exists to kill.
  // With no usable start the wrap is decided by the clock instead: an end before
  // WRAP_CUTOFF_HOUR belongs to the next day.
  assert.equal(
    await endInstantOf({ event_date: '2026-12-31', start_time: null, end_time: '1:00 AM', tz: CHI }),
    '2027-01-01T07:00:00.000Z', // 01:00 Chicago on Jan 1 (CST, UTC-6)
  );
  // ...and an ordinary daytime end with no start is still taken literally, not
  // pushed to midnight — precision is only given up when a wrap is plausible.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: null, end_time: '2:00 PM', tz: CHI }),
    '2026-08-14T19:00:00.000Z',
  );
  // Visible at 09:00 Chicago on its own day, which is where it used to vanish.
  assert.equal(
    (await classifyAt({ event_date: '2026-12-31', start_time: null, end_time: '1:00 AM', tz: CHI },
      '2026-12-31T15:00:00Z')).not_finished,
    true
  );
});

// ─── Rule 3: the timezone fallback ─────────────────────────────────────────

test('rule 3: a shift with NO PROPOSAL falls back to America/Chicago', async () => {
  // 5 of 78 prod shifts have no proposal_id, and the LEFT JOIN hands the
  // fragment a NULL zone. Same instant as an explicit Chicago proposal.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '6:00 PM', end_time: '11:00 PM', tz: null }),
    '2026-08-15T04:00:00.000Z'
  );
  // ...and with no end_time either, which is the real prod shape: those five
  // shifts are five of the fourteen with no end time.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: null, end_time: null, tz: null }),
    '2026-08-15T05:00:00.000Z'
  );
  // An empty-string zone is treated as absent rather than raising.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: null, end_time: null, tz: '' }),
    '2026-08-15T05:00:00.000Z'
  );
});

// ─── Overnight wrap ────────────────────────────────────────────────────────

test('an 8pm-to-1am shift ends at 1am the NEXT morning, not nineteen hours before it starts', async () => {
  // Six shifts in the dev database carry a '12:00 AM' or '1:00 AM' end against
  // an evening start. Read literally, their end instant lands on the morning OF
  // the event and the shift is invisible for its entire day — the exact P0 this
  // predicate exists to prevent.
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '8:00 PM', end_time: '1:00 AM', tz: CHI }),
    '2026-08-15T06:00:00.000Z'
  );
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: '8:00 PM', end_time: '12:00 AM', tz: CHI }),
    '2026-08-15T05:00:00.000Z'
  );
  // At 22:00 Chicago on the event day, that shift is still running.
  const nye = { event_date: '2026-08-14', start_time: '8:00 PM', end_time: '1:00 AM', tz: CHI };
  assert.equal((await classifyAt(nye, '2026-08-15T03:00:00Z')).not_finished, true);
});

test('a bare 12:00 AM end with no start still resolves to the END of the event day', async () => {
  assert.equal(
    await endInstantOf({ event_date: '2026-08-14', start_time: null, end_time: '12:00 AM', tz: CHI }),
    '2026-08-15T05:00:00.000Z'
  );
});

// ─── The two buckets, and the contrast with what was there before ──────────

test('not-finished and finished are exact complements at every instant', async () => {
  const cases = [
    { event_date: '2026-08-14', start_time: '6:00 PM', end_time: '11:00 PM', tz: CHI },
    { event_date: '2026-08-14', start_time: null, end_time: null, tz: null },
    { event_date: '2026-08-14', start_time: '8:00 PM', end_time: '1:00 AM', tz: CHI },
    { event_date: '2026-08-14', start_time: '6:00 PM', end_time: 'evening', tz: CHI },
  ];
  const instants = [
    '2026-08-14T12:00:00Z', '2026-08-15T00:00:00Z', '2026-08-15T04:30:00Z',
    '2026-08-15T05:30:00Z', '2026-08-15T07:00:00Z',
  ];
  for (const c of cases) {
    for (const at of instants) {
      const r = await classifyAt(c, at);
      assert.notEqual(
        r.not_finished, r.finished,
        `${JSON.stringify(c)} at ${at}: a shift must be in exactly one bucket`
      );
    }
  }
});

test('19:30 Chicago: tonight is visible and this morning is not — the two failures of the previous rounds, together', async () => {
  // 19:30 Chicago on 2026-08-14 is 2026-08-15T00:30Z, so CURRENT_DATE (GMT) is
  // already 2026-08-15 and the Chicago calendar day is still 2026-08-14.
  const at = '2026-08-15T00:30:00Z';
  const { rows } = await pool.query(`SELECT ($1::timestamptz)::date AS gmt_day`, [at]);
  assert.equal(rows[0].gmt_day.toISOString().slice(0, 10), '2026-08-15',
    'test premise: 19:30 Chicago must already be the next GMT day');

  const tonight = { event_date: '2026-08-14', start_time: '8:00 PM', end_time: '11:00 PM', tz: CHI };
  const thisMorning = { event_date: '2026-08-14', start_time: '10:00 AM', end_time: '2:00 PM', tz: CHI };

  // Round 1's failure: `event_date >= CURRENT_DATE` is 2026-08-14 >= 2026-08-15
  // = FALSE, so tonight's shift disappeared five hours before it started.
  assert.equal((await classifyAt(tonight, at)).not_finished, true, 'tonight must still be visible at 19:30');

  // Round 2's failure: widening to the Chicago calendar day made THIS MORNING's
  // finished brunch equally "upcoming" until midnight, so a CANT at 20:00 about
  // tomorrow denied and re-opened a shift somebody had already worked.
  assert.equal((await classifyAt(thisMorning, at)).not_finished, false, 'this morning must be finished at 19:30');
  assert.equal((await classifyAt(thisMorning, at)).finished, true);

  // And the ordering that follows from it: tonight outranks this morning,
  // because this morning is not a candidate at all.
  const tonightEnd = await endInstantOf(tonight);
  const morningEnd = await endInstantOf(thisMorning);
  assert.ok(morningEnd < tonightEnd, 'this morning must end before tonight');
});

test('every hour of a Chicago day classifies a 6pm-11pm shift the same way at both TZs', async () => {
  // Walks the full 24h so no single-o'clock coincidence can carry a green run.
  const shift = { event_date: '2026-08-14', start_time: '6:00 PM', end_time: '11:00 PM', tz: CHI };
  for (let h = 0; h < 24; h++) {
    const at = `2026-08-14T${String(h).padStart(2, '0')}:00:00Z`;
    const expected = at < '2026-08-15T04:00:00Z';
    assert.equal(
      (await classifyAt(shift, at)).not_finished, expected,
      `at ${at} the 2026-08-14 18:00-23:00 Chicago shift should be ${expected ? 'visible' : 'finished'}`
    );
  }
  for (let h = 0; h < 8; h++) {
    const at = `2026-08-15T${String(h).padStart(2, '0')}:00:00Z`;
    const expected = at < '2026-08-15T04:00:00Z';
    assert.equal((await classifyAt(shift, at)).not_finished, expected, `at ${at}`);
  }
});

// ─── One definition, structurally ──────────────────────────────────────────

test('the two predicates are literally built from the one end-instant expression', async () => {
  const expr = shiftEndInstantSql('s', 'p');
  assert.equal(shiftNotFinishedSql('s', 'p'), `${expr} > NOW()`);
  assert.equal(shiftFinishedSql('s', 'p'), `${expr} <= NOW()`);
  // Aliases are honored, so a query that joins its proposal as anything other
  // than `p` still gets the same expression rather than a second copy.
  assert.ok(shiftEndInstantSql('sh', 'pp').includes('pp.event_timezone'));
  assert.ok(shiftEndInstantSql('sh', 'pp').includes('sh.end_time'));
});
