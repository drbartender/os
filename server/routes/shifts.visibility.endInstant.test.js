// The shift-visibility FAMILY, wired end to end.
//
// server/utils/shiftEndInstant.test.js proves the predicate itself at every
// hour and both DST edges with a bound comparison instant. This suite proves
// the other half: that each surface in the family actually consumes it, and
// that every COUNT still agrees with the LIST it counts. A count and its list
// drifting apart — with comments in both claiming they mirrored each other — is
// what broke the round this replaces, so the pairing is asserted, not assumed.
//
// Sites covered here:
//   - STAFF_OPEN_SHIFTS_SQL           staff Available tab
//   - GET /api/shifts/unstaffed-upcoming   admin assign modal (the LIST)
//   - GET /api/admin/badge-counts          unstaffed_events (the COUNT for it)
//   - GET /api/messages/shifts             invitation picker
//   - outstandingDocuments.listUncertifiedStaffable()
//
// HOW THIS DISCRIMINATES. The database clock cannot be mocked, so nothing here
// mocks a clock: fixtures are built from the DB's OWN Chicago wall clock, and
// their premises (this one has ended, that one has not) are re-derived from the
// database and asserted in before(), so a broken premise fails loudly instead of
// passing silently. On top of that, before() computes what the OLD predicate
// (`event_date >= CURRENT_DATE`, resolved in this session's GMT zone) would have
// said about each fixture and asserts that it gets at least one of them WRONG —
// so this file is a genuine fails-before/passes-after proof at whatever o'clock
// it runs, not only during the 19:00-to-midnight window where the bug was first
// noticed.
//
// Run BOTH — a single-TZ test is how this bug hid for months:
//   TZ=UTC              node --test server/routes/shifts.visibility.endInstant.test.js
//   TZ=America/Chicago  node --test server/routes/shifts.visibility.endInstant.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { STAFF_OPEN_SHIFTS_SQL } = require('./shifts.queries');
const { listUncertifiedStaffable } = require('../utils/outstandingDocuments');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.visibility.endInstant.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = `vis-endinstant-${NONCE}-`;

let server, baseUrl;
let adminToken, staffId, staffToken;
let clientId, proposalId;
const F = {};            // fixture key -> shift id
const EXPECTED = {};     // fixture key -> should be visible?
let clock;               // the DB's Chicago wall clock at seed time

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(label, role = 'staff', status = 'approved') {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, $4, 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${label}@example.com`, passwordHash, role, status]
  );
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function seedShift(key, { date, endTime, startTime = null, withProposal = true, visible }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name,
                         positions_needed, proposal_id)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, '["Bartender"]', $5) RETURNING id`,
    [date, startTime, endTime, `EndInstant ${key} ${NONCE}`, withProposal ? proposalId : null]
  );
  F[key] = r.rows[0].id;
  EXPECTED[key] = visible;
  return F[key];
}

before(async () => {
  const tz = (await pool.query(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  // The DB's own Chicago wall clock. Everything below is derived from it, so
  // the fixtures are correct no matter what hour or process timezone this runs
  // at. The ENDED clamp keeps the row on TODAY's Chicago date even just after
  // midnight (a fixture that slipped to yesterday's date would stop
  // discriminating against the old CURRENT_DATE predicate); the SOON clamp does
  // the same at the other end of the day.
  clock = (await pool.query(`
    WITH chi AS (SELECT NOW() AT TIME ZONE 'America/Chicago' AS n)
    SELECT to_char(n, 'YYYY-MM-DD')                                   AS chi_today,
           to_char(n, 'HH24:MI')                                      AS chi_now,
           to_char(n - INTERVAL '1 day', 'YYYY-MM-DD')                AS chi_yesterday,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'YYYY-MM-DD') AS ended_d,
           to_char(GREATEST(n - INTERVAL '30 minutes',
                            date_trunc('day', n) + INTERVAL '1 minute'), 'HH24:MI')    AS ended_t,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'YYYY-MM-DD') AS soon_d,
           to_char(LEAST(n + INTERVAL '30 minutes',
                         date_trunc('day', n) + INTERVAL '23 hours 59 minutes'), 'HH24:MI')    AS soon_t,
           CURRENT_DATE::text                                         AS db_today
      FROM chi
  `)).rows[0];

  const u = await makeUser('staff');
  staffId = u.id; staffToken = tokenFor(u);
  adminToken = tokenFor(await makeUser('admin', 'admin'));

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`EndInstant Client ${NONCE}`, `${EMAIL_PREFIX}client@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE, '18:00', 4, 'America/Chicago', 'confirmed', 'birthday-party') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // ENDED: finished about half an hour ago. The row every previous round got
  // wrong in one direction or the other.
  await seedShift('ended', { date: clock.ended_d, endTime: clock.ended_t, visible: false });
  // SOON: ends about half an hour from now.
  await seedShift('soon', { date: clock.soon_d, endTime: clock.soon_t, visible: true });
  // TONIGHT_NULL: no end_time at all (14 of 78 prod shifts). Visible until
  // Chicago midnight — it must NOT vanish when the GMT day rolls at 19:00.
  await seedShift('tonightNull', { date: clock.chi_today, endTime: null, startTime: '6:00 PM', visible: true });
  // YESTERDAY_NULL: the same shape one day back. Must NOT linger a second day.
  await seedShift('yesterdayNull', { date: clock.chi_yesterday, endTime: null, startTime: '6:00 PM', visible: false });
  // NO PROPOSAL: 5 of 78 prod shifts have none, and those five are five of the
  // fourteen with no end time. The zone must fall back to Chicago, not raise.
  await seedShift('noProposal', { date: clock.chi_today, endTime: null, withProposal: false, visible: true });
  // OVERNIGHT: an 8pm-1am booking dated TODAY. Read literally its end instant
  // would be 1am THIS MORNING and it would be invisible all day.
  await seedShift('overnight', { date: clock.chi_today, startTime: '8:00 PM', endTime: '1:00 AM', visible: true });

  // PREMISE 1 — re-derive every fixture's classification from the database
  // itself and check it matches what the test claims. A fixture built at
  // 00:00:30 Chicago, or on a machine whose clock moved mid-run, fails HERE
  // with a readable message instead of silently making the assertions vacuous.
  const derived = await pool.query(
    `SELECT s.id,
            (${require('../utils/shiftEndInstant').shiftNotFinishedSql('s', 'p')}) AS not_finished,
            (s.event_date >= CURRENT_DATE) AS old_predicate
       FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE s.id = ANY($1::int[])`,
    [Object.values(F)]
  );
  const byId = new Map(derived.rows.map((r) => [r.id, r]));
  for (const [key, id] of Object.entries(F)) {
    assert.equal(
      byId.get(id).not_finished, EXPECTED[key],
      `test premise: fixture "${key}" (shift ${id}) should be ${EXPECTED[key] ? 'unfinished' : 'finished'} ` +
      `right now (Chicago ${clock.chi_now}). If this fires within a minute of Chicago midnight, re-run.`
    );
  }

  // PREMISE 2 — the fails-before proof. At least one fixture must be
  // MISCLASSIFIED by `event_date >= CURRENT_DATE`, the predicate every site in
  // this family used before. Before 19:00 Chicago that is the ENDED fixture
  // (dated today, so the old predicate still showed a finished shift); from
  // 19:00 it is TONIGHT_NULL (the GMT day has rolled, so the old predicate hid
  // a shift that has not started). Either way this file cannot pass on the old
  // code at any hour of the day.
  const wrongUnderOld = Object.entries(F)
    .filter(([key, id]) => byId.get(id).old_predicate !== EXPECTED[key])
    .map(([key]) => key);
  assert.ok(
    wrongUnderOld.length > 0,
    `test premise: the old event_date >= CURRENT_DATE predicate must get at least one fixture wrong, ` +
    `otherwise this file is not a fails-before proof (Chicago ${clock.chi_now}, CURRENT_DATE ${clock.db_today})`
  );
  console.log(`[premise] old CURRENT_DATE predicate misclassifies: ${wrongUnderOld.join(', ')} (Chicago now ${clock.chi_now})`);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', require('./shifts'));
  app.use('/api/admin', require('./admin/settings'));
  app.use('/api/messages', require('./messages'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const ids = Object.values(F);
  if (ids.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids]);
  }
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

/** Which of our fixtures a surface returned, by fixture key. */
function seen(ids) {
  const set = new Set(ids);
  return Object.fromEntries(Object.entries(F).map(([k, id]) => [k, set.has(id)]));
}
function assertMatchesExpectation(actual, label) {
  for (const key of Object.keys(F)) {
    assert.equal(actual[key], EXPECTED[key],
      `${label}: fixture "${key}" should be ${EXPECTED[key] ? 'listed' : 'absent'}`);
  }
}

test('staff Available tab (STAFF_OPEN_SHIFTS_SQL) lists exactly the unfinished shifts', async () => {
  const r = await pool.query(STAFF_OPEN_SHIFTS_SQL, [staffId]);
  assertMatchesExpectation(seen(r.rows.map((x) => x.id)), 'Available tab');
});

test('admin assign modal (GET /shifts/unstaffed-upcoming) lists exactly the unfinished shifts', async () => {
  const res = await get('/api/shifts/unstaffed-upcoming', adminToken);
  assert.equal(res.status, 200);
  assertMatchesExpectation(seen(res.body.map((x) => x.id)), 'unstaffed-upcoming');
});

test('messages invitation picker lists exactly the unfinished shifts', async () => {
  const res = await get('/api/messages/shifts', adminToken);
  assert.equal(res.status, 200);
  assertMatchesExpectation(seen(res.body.shifts.map((x) => x.id)), 'invitation picker');
});

test('badge-counts unstaffed_events agrees with the list it counts', async () => {
  // THE PAIRING. Not "both are plausible numbers" — the count moved by exactly
  // the number of OUR fixtures that entered the list. Both sides import the same
  // fragment; this asserts they really do agree on live rows.
  const [countRes, listRes] = await Promise.all([
    get('/api/admin/badge-counts', adminToken),
    get('/api/shifts/unstaffed-upcoming', adminToken),
  ]);
  assert.equal(countRes.status, 200);
  assert.equal(listRes.status, 200);

  const mine = new Set(Object.values(F));
  const minedListed = listRes.body.filter((x) => mine.has(x.id)).length;

  // Baseline: the same count with our fixtures removed from consideration.
  const baseline = (await pool.query(`
    SELECT COUNT(*)::int AS n FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
     WHERE ${require('../utils/shiftEndInstant').shiftNotFinishedSql('s', 'p')}
       AND s.status = 'open'
       AND jsonb_typeof(s.positions_needed::jsonb) = 'array'
       AND jsonb_array_length(s.positions_needed::jsonb) > 0
       AND (SELECT COUNT(*) FROM shift_requests sr
             WHERE sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL)
           < jsonb_array_length(s.positions_needed::jsonb)
       AND NOT (s.id = ANY($1::int[]))
  `, [[...mine]])).rows[0].n;

  assert.equal(
    countRes.body.unstaffed_events - baseline, minedListed,
    'the sidebar badge and the assign modal must count the same shifts'
  );
  assert.equal(minedListed, Object.values(EXPECTED).filter(Boolean).length,
    'and that number is exactly our unfinished fixtures');
});

test('outstandingDocuments points at a shift only while it is still ahead', async () => {
  // The uncertified staffer is "about to pour drinks uncertified" only until
  // the shift ends; after that they are back to "eligible but idle".
  // 'submitted' is a STAFFABLE status (outstandingDocuments.STAFFABLE_STATUSES):
  // someone who can be put in front of a client but has no certification on file.
  const uncertified = await makeUser('uncertified', 'staff', 'submitted');
  try {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1, $2, 'Bartender', 'approved')`,
      [F.ended, uncertified.id]
    );
    let rows = await listUncertifiedStaffable();
    let row = rows.find((r) => r.user_id === uncertified.id);
    assert.ok(row, 'the uncertified staffer must be listed either way');
    assert.equal(row.next_shift_id, null, 'a FINISHED shift must not read as an upcoming risk');

    await pool.query('UPDATE shift_requests SET shift_id = $1 WHERE user_id = $2', [F.soon, uncertified.id]);
    rows = await listUncertifiedStaffable();
    row = rows.find((r) => r.user_id === uncertified.id);
    assert.equal(row.next_shift_id, F.soon, 'an unfinished shift must surface as the urgent case');
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE user_id = $1', [uncertified.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [uncertified.id]);
  }
});

test('no site in the family still hard-codes the calendar-day predicate', async () => {
  // Cheap structural guard against the exact regression: a future edit that
  // re-introduces event_date >= CURRENT_DATE on one side of a documented mirror.
  const fs = require('node:fs');
  const path = require('node:path');
  const files = [
    'routes/shifts.queries.js', 'routes/shifts.js', 'routes/messages.js',
    'routes/admin/settings.js', 'routes/staffPortal.js',
    'utils/outstandingDocuments.js', 'utils/smsInbound.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // Strip SQL/JS comments' worth of history-telling before matching, so the
    // explanatory comments naming the old predicate do not trip this.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join('\n');
    assert.ok(
      !/event_date\s*>=\s*CURRENT_DATE/.test(code),
      `${f} still contains a live event_date >= CURRENT_DATE shift predicate`
    );
    assert.ok(
      /shiftNotFinishedSql/.test(code),
      `${f} should consume the shared predicate`
    );
  }
});
