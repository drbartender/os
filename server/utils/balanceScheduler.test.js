require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceScheduler.test.js refuses to run against production');
}

// Stub the completion side-effects (marketing enroll, payroll accrual,
// change-request reap) BEFORE requiring balanceScheduler: accruePayoutsForProposal
// is destructured at module load, so the stub must be in place first. These are
// best-effort in the SUT anyway; stubbing keeps the test from writing payout /
// marketing rows for whatever it completes on the shared dev DB.
require('./payrollAccrual').accruePayoutsForProposal = async () => {};
require('./marketingHandlers').scheduleReviewRequest = async () => {};
require('./marketingHandlers').scheduleRetentionNudge = async () => {};
require('./changeRequests').cancelPendingChangeRequestsForProposal = async () => {};

const { processEventCompletions } = require('./balanceScheduler');

const MARK = `baltz-${Date.now()}`;
let notEndedId, endedId;

before(async () => {
  // The auto-complete bug only reproduces when the session tz differs from the
  // event tz. Prod (and the dev pool) run at GMT; assert it so a non-GMT session
  // can't silently make this test vacuous.
  const tz = (await pool.query('SHOW timezone')).rows[0].TimeZone;
  assert.equal(tz, 'GMT', `this discriminating test requires a GMT session (prod parity); got ${tz}`);

  // Scenario A: an evening Chicago event that has NOT ended yet. Its end
  // wall-clock lands ~2h in the FUTURE in America/Chicago, but interpreted in
  // GMT (the old predicate) it reads as already past -> the old code completed
  // it early. Fully paid so eligibility is purely time-driven.
  const a = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid)
     SELECT NULL, 'confirmed', $1, 'America/Chicago',
            sn::date, to_char(sn, 'HH24:MI'), 4.5, 1000, 1000
       FROM (SELECT ((NOW() + interval '2 hours') AT TIME ZONE 'America/Chicago')
                    - interval '4 hours 30 minutes' AS sn) q
     RETURNING id`,
    [`${MARK}-notended`]
  );
  notEndedId = a.rows[0].id;

  // Scenario B: an event that genuinely ended ~1 day ago in Chicago. Both the
  // old and new predicates agree it is over, so it still auto-completes.
  const b = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid)
     SELECT NULL, 'confirmed', $1, 'America/Chicago',
            sn::date, to_char(sn, 'HH24:MI'), 4.5, 1000, 1000
       FROM (SELECT ((NOW() - interval '1 day') AT TIME ZONE 'America/Chicago')
                    - interval '4 hours 30 minutes' AS sn) q
     RETURNING id`,
    [`${MARK}-ended`]
  );
  endedId = b.rows[0].id;
});

after(async () => {
  for (const id of [notEndedId, endedId]) {
    if (!id) continue;
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  await pool.end();
});

test('processEventCompletions > does NOT complete an evening Chicago event that has not ended (tz-correct predicate)', async () => {
  await processEventCompletions();
  const { rows } = await pool.query('SELECT status FROM proposals WHERE id = $1', [notEndedId]);
  assert.equal(rows[0].status, 'confirmed',
    'a not-yet-ended Chicago evening event must stay confirmed; the old GMT-naive predicate wrongly completed it');
});

test('processEventCompletions > still completes a genuinely-ended, fully-paid event', async () => {
  await processEventCompletions();
  const { rows } = await pool.query('SELECT status FROM proposals WHERE id = $1', [endedId]);
  assert.equal(rows[0].status, 'completed', 'an event that ended ~1 day ago must auto-complete');
});
