// findNearestApprovedShift — the CANT/CONFIRM write path.
//
// THE HIGHEST-STAKES SITE IN THE FAMILY, and the one that killed the previous
// round. Whatever this function returns is what CANT denies and re-opens.
//
//   - Too narrow (`event_date >= CURRENT_DATE`, resolved in this session's GMT
//     zone): a staffer texting CANT at 19:30 about TONIGHT matched nothing, so
//     handleConfirm, handleCant and the multi-account resolveShiftResponder
//     tiebreak all took the "no upcoming shift" branch. The staffer was told
//     there was nothing to release, the shift was never re-opened, and nobody
//     was alerted — on the day of the event.
//   - Too wide (the Chicago calendar day): THIS MORNING's finished brunch
//     outranks tonight's event until midnight, so a bartender texting CANT at
//     20:00 about tomorrow has the shift they ALREADY WORKED denied and
//     re-opened, removing them from the roster payroll pays from.
//
// The second failure is the P0 this suite exists to pin. It is asserted
// directly: a shift that ended this morning must not outrank one starting
// tonight.
//
// Fixtures are built from the DB's own Chicago wall clock (the DB clock cannot
// be mocked) and every premise is re-derived from the database in before().
//
// Run BOTH:
//   TZ=UTC              node --test server/utils/smsInbound.nearestShift.endInstant.test.js
//   TZ=America/Chicago  node --test server/utils/smsInbound.nearestShift.endInstant.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { shiftNotFinishedSql } = require('./shiftEndInstant');
const {
  findNearestApprovedShift, handleCant, alertStaffCant, __setDeps,
} = require('./smsInbound');

if (process.env.NODE_ENV === 'production') {
  throw new Error('smsInbound.nearestShift.endInstant.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = `cant-endinstant-${NONCE}-`;

const F = {};
let clock;
let brunchStaffId, tiebreakStaffId, cantStaffId, noneStaffId, overnightStaffId;

async function makeStaff(label) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${EMAIL_PREFIX}${label}@example.com`]
  );
  return r.rows[0].id;
}

async function seedShift(key, { date, startTime, endTime }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, '["Bartender"]') RETURNING id`,
    [date, startTime, endTime, `Cant ${key} ${NONCE}`]
  );
  F[key] = r.rows[0].id;
  return F[key];
}

async function approve(shiftId, userId) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, userId]
  );
}

async function notFinished(shiftId) {
  const { rows } = await pool.query(
    `SELECT (${shiftNotFinishedSql('s', 'p')}) AS v
       FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id WHERE s.id = $1`,
    [shiftId]
  );
  return rows[0].v;
}

before(async () => {
  const tz = (await pool.query(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  clock = (await pool.query(`
    WITH chi AS (SELECT NOW() AT TIME ZONE 'America/Chicago' AS n)
    SELECT to_char(n, 'YYYY-MM-DD') AS chi_today,
           to_char(n, 'HH24:MI')    AS chi_now,
           to_char(n + INTERVAL '1 day', 'YYYY-MM-DD') AS chi_tomorrow,
           to_char(n + INTERVAL '2 days', 'YYYY-MM-DD') AS chi_dayafter,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'YYYY-MM-DD') AS ended_d,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'HH24:MI')    AS ended_t,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'YYYY-MM-DD') AS soon_d,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'HH24:MI')    AS soon_t,
           CURRENT_DATE::text AS db_today
      FROM chi
  `)).rows[0];

  brunchStaffId = await makeStaff('brunch');
  overnightStaffId = await makeStaff('overnight');
  tiebreakStaffId = await makeStaff('tiebreak');
  cantStaffId = await makeStaff('cant');
  noneStaffId = await makeStaff('none');

  // THE P0 PAIR, both dated TODAY in Chicago: a shift that has already ended,
  // and one that has not. Under a calendar-day predicate both are "upcoming"
  // and the finished one sorts first.
  await seedShift('brunch', { date: clock.ended_d, startTime: '10:00', endTime: clock.ended_t });
  await seedShift('tonight', { date: clock.soon_d, startTime: '18:00', endTime: clock.soon_t });
  await approve(F.brunch, brunchStaffId);
  await approve(F.tonight, brunchStaffId);

  // Free-text start_time ordering trap: on the SAME day, '8:00 AM' sorts AFTER
  // '7:00 PM' as a string, so the old ORDER BY s.start_time picked the evening
  // shift as "nearest". Both are still ahead, dated tomorrow so neither has
  // finished, and only end-instant ordering gets them in the right order.
  await seedShift('tomorrowEvening', { date: clock.chi_tomorrow, startTime: '7:00 PM', endTime: '11:00 PM' });
  await seedShift('tomorrowMorning', { date: clock.chi_tomorrow, startTime: '8:00 AM', endTime: '11:00 AM' });
  await approve(F.tomorrowEvening, tiebreakStaffId);
  await approve(F.tomorrowMorning, tiebreakStaffId);

  // A staffer whose ONLY approved shift already ended: nothing to release.
  await seedShift('onlyFinished', { date: clock.ended_d, startTime: '09:00', endTime: clock.ended_t });
  await approve(F.onlyFinished, noneStaffId);

  // A staffer with a live shift, for the CANT write path.
  await seedShift('cantTarget', { date: clock.soon_d, startTime: '18:00', endTime: clock.soon_t });
  await approve(F.cantTarget, cantStaffId);

  // THE OVERNIGHT PAIR (2026-08-20). A late start with a NULL end_time takes
  // rule 2, so its end instant is start + booked + grace = about 05:00 the NEXT
  // morning. Both of these are genuinely in the future by the real clock, which
  // is what makes them candidates; what the test moves is the DATE the ordering
  // measures "before today" against, since the DB clock cannot be moved.
  await seedShift('overnightTail', { date: clock.chi_tomorrow, startTime: '9:00 PM', endTime: null });
  await seedShift('dayAfter', { date: clock.chi_dayafter, startTime: '6:00 PM', endTime: '11:00 PM' });
  await approve(F.overnightTail, overnightStaffId);
  await approve(F.dayAfter, overnightStaffId);

  // Premises, re-derived from the database.
  assert.equal(await notFinished(F.brunch), false,
    `test premise: the brunch fixture must already be finished at Chicago ${clock.chi_now}`);
  assert.equal(await notFinished(F.tonight), true,
    `test premise: tonight's fixture must not be finished at Chicago ${clock.chi_now}`);
  assert.equal(await notFinished(F.onlyFinished), false, 'test premise: onlyFinished must be finished');
  assert.equal(await notFinished(F.cantTarget), true, 'test premise: the CANT target must still be live');
  assert.equal(await notFinished(F.overnightTail), true,
    'test premise: the overnight fixture must still be a candidate, or the ordering is never reached');
  assert.equal(await notFinished(F.dayAfter), true, 'test premise: the day-after fixture must be live');

  // Fails-before proof: the old predicate keeps the finished brunch, and
  // because it is dated today it sorts ahead of tonight's shift.
  const old = await pool.query(
    `SELECT id, (event_date >= CURRENT_DATE) AS keeps FROM shifts WHERE id = ANY($1::int[])`,
    [[F.brunch, F.tonight]]
  );
  const keeps = Object.fromEntries(old.rows.map((r) => [r.id, r.keeps]));
  assert.ok(
    keeps[F.brunch] === true || keeps[F.tonight] === false,
    `test premise: the old CURRENT_DATE predicate must get the brunch/tonight pair wrong (Chicago ${clock.chi_now}, CURRENT_DATE ${clock.db_today})`
  );
});

after(async () => {
  __setDeps({ notifyAdminCategory: require('./adminNotifications').notifyAdminCategory });
  const ids = Object.values(F);
  if (ids.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

test('a shift that ended this morning does NOT outrank one that starts tonight', async () => {
  // The P0. Under the Chicago-calendar-day round, this returned the brunch
  // shift, so a CANT about tomorrow denied and re-opened a shift the staffer
  // had already worked — pulling them off the roster payroll pays from.
  const shift = await findNearestApprovedShift(brunchStaffId);
  assert.ok(shift, 'the staffer has a live shift, so something must be found');
  assert.equal(shift.shift_id, F.tonight,
    'the finished brunch must not be a candidate at all');
});

test('a staffer whose only approved shift has finished has nothing to release', async () => {
  assert.equal(await findNearestApprovedShift(noneStaffId), null);
});

test('same-day ordering follows the end instant, not the free-text start_time string', async () => {
  const shift = await findNearestApprovedShift(tiebreakStaffId);
  assert.equal(shift.shift_id, F.tomorrowMorning,
    "'8:00 AM' sorts after '7:00 PM' as a string; the morning shift is the nearer one");
});

test('CANT stamps the audit note with the CHICAGO business day, not the GMT day', async () => {
  const sent = [];
  __setDeps({ notifyAdminCategory: async (m) => { sent.push(m); } });

  const res = await handleCant(cantStaffId, null);
  assert.equal(res.ok, true);
  assert.equal(res.shiftId, F.cantTarget);

  const { rows } = await pool.query(
    'SELECT status, notes FROM shift_requests WHERE id = $1', [res.requestId]
  );
  assert.equal(rows[0].status, 'denied');
  assert.match(rows[0].notes, /\[Staff texted CANT (\d{4}-\d{2}-\d{2})\]/);
  const stamped = rows[0].notes.match(/\[Staff texted CANT (\d{4}-\d{2}-\d{2})\]/)[1];
  // HONEST LIMIT: this one assertion only DISCRIMINATES between 19:00 Chicago
  // and midnight, because that is the only window in which NOW()::date (the GMT
  // day) and the Chicago business day differ at all. It is asserted anyway
  // because the note is a calendar-day stamp about when a human acted, not a
  // shift boundary, so there is no end instant to key it on — and because an
  // evening-of CANT is precisely the case this spec makes reachable, so the
  // window it fails in is the window the feature now lives in.
  assert.equal(stamped, clock.chi_today,
    `NOW()::date is already tomorrow from 19:00 Chicago, so the note used to be dated AFTER the event it dropped (Chicago ${clock.chi_now}, CURRENT_DATE ${clock.db_today})`);

  const reopened = await pool.query('SELECT status FROM shifts WHERE id = $1', [res.shiftId]);
  assert.equal(reopened.rows[0].status, 'open', 'the shift must be re-opened for restaffing');

  // And the alert calls a same-day drop what it is. It used to subtract
  // Date.now() from a pg DATE materialized at LOCAL midnight, so an evening-of
  // drop came out at -0.81 days, floored to -1, and the single most urgent
  // drop there is was labelled "past due" — reading as an event that already
  // happened and nothing to scramble for.
  await alertStaffCant(res);
  assert.equal(sent.length, 1, 'exactly one admin alert');
  assert.match(sent[0].emailText, /\(TODAY\)/,
    'a drop on the day of the event must read TODAY, never "past due"');
  assert.ok(sent[0].smsBody, 'an event today is inside the 7-day window, so it also texts');
});

test('a shift dated BEFORE today never outranks one dated today or later', async () => {
  // The residual the 2026-08-16 fleet found and the header used to deny. The
  // brunch P0 above is the same damage one calendar day earlier: a NULL
  // end_time takes rule 2, so a 9:00 PM start is "not finished" until about
  // 05:00 the next morning, and it sorted FIRST. A bartender who finished at
  // 01:00 and texted CANT at 02:00 meaning a later date had LAST NIGHT's shift
  // denied and re-opened, off the roster payroll pays from.
  //
  // Asserted by moving the DATE rather than the clock, because the DB clock
  // cannot be moved and the window is only reachable between midnight and about
  // 08:00 Chicago. Both fixtures are genuinely unfinished by the real clock
  // (pinned in before()), and the injected day is the one input the new
  // ordering term reads.
  const asIfDayAfter = await findNearestApprovedShift(overnightStaffId, clock.chi_dayafter);
  assert.ok(asIfDayAfter, 'both fixtures are live, so something must be found');
  assert.equal(asIfDayAfter.shift_id, F.dayAfter,
    'the shift dated yesterday-relative-to-the-injected-day must not win, however its assumed end sorts');

  // And the ordinary case is UNDISTURBED: with the real Chicago today, neither
  // is dated before today, so the end instant decides and the nearer shift wins.
  // This is the half that makes the new term a tiebreak rather than a filter.
  const today = await findNearestApprovedShift(overnightStaffId);
  assert.equal(today.shift_id, F.overnightTail,
    'the genuinely nearer shift must still win when neither is in the past');
});

test('an overnight shift is still returned when it is the ONLY candidate', async () => {
  // The tiebreak must never hide a shift. A staffer whose single approved shift
  // is the overnight one still gets it back, even measured from a later day.
  const soloStaffId = await makeStaff('overnight-solo');
  const shiftId = await seedShift('overnightSolo', {
    date: clock.chi_tomorrow, startTime: '9:00 PM', endTime: null,
  });
  await approve(shiftId, soloStaffId);
  const found = await findNearestApprovedShift(soloStaffId, clock.chi_dayafter);
  assert.ok(found, 'ordering is a tiebreak; with one candidate there is nothing to break');
  assert.equal(found.shift_id, shiftId);
});

test('a malformed business day falls back instead of 22007-ing on a live webhook', async () => {
  // The shape guard on the todayYmd seam. This parameter is on an EXPORTED
  // function, and $2::date accepts far more than YYYY-MM-DD: 'not-a-date'
  // raises 22007 at Bind, which on this path is a 500 out of an inbound SMS
  // webhook; 'today' and 'yesterday' resolve in the GMT SESSION zone, which is
  // the exact rollover this whole family exists to kill.
  //
  // The throw is what this pins, because it is the one case that fails loudly
  // enough to assert on: without the guard the first call rejects.
  const good = await findNearestApprovedShift(overnightStaffId);
  const junk = await findNearestApprovedShift(overnightStaffId, 'not-a-date');
  assert.ok(good, 'premise: the fixtures are live');
  assert.equal(junk.shift_id, good.shift_id, 'junk must resolve to the same shift as the default');

  // These two document the rest of the contract rather than pinning it: both
  // are values Postgres would ACCEPT and silently misread, and with fixtures
  // dated in the future they happen to land on the same answer either way.
  assert.equal((await findNearestApprovedShift(overnightStaffId, 'today')).shift_id, good.shift_id);
  assert.equal((await findNearestApprovedShift(overnightStaffId, new Date())).shift_id, good.shift_id);
});
