// GET /api/me/staff-home — every shift boundary in the payload, plus the
// teaser-versus-count pairing.
//
// Five of the six queries in this handler carried the same calendar-day
// predicate, so they went wrong together for the last five hours of every day:
// the next-shift card said "no upcoming shift" to a staffer opening the portal
// 30 minutes before call time; tonight's pending request and cover broadcast
// vanished; and the open-shifts teaser and its "All (N)" count disagreed with
// the Available tab they link to. Widening them to the Chicago calendar day
// fixed the disappearance and made THIS MORNING's finished shift the next-shift
// card until midnight. All five now ask the one question — has the shift
// finished — through the shared fragment.
//
// Same discrimination technique as shifts.visibility.endInstant.test.js:
// fixtures are built from the DB's own Chicago wall clock (the DB clock cannot
// be mocked), every premise is re-derived from the database and asserted in
// before(), and before() also proves that the OLD predicate misclassifies at
// least one fixture, so this is a real fails-before proof at any hour.
//
// Run BOTH:
//   TZ=UTC              node --test server/routes/staffPortal.staffHome.endInstant.test.js
//   TZ=America/Chicago  node --test server/routes/staffPortal.staffHome.endInstant.test.js

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
const { shiftNotFinishedSql } = require('../utils/shiftEndInstant');

if (process.env.NODE_ENV === 'production') {
  throw new Error('staffPortal.staffHome.endInstant.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = `staffhome-endinstant-${NONCE}-`;

let server, baseUrl;
let meId, meToken, mateId;
let clientId, proposalId;
const F = {};
const EXPECTED = {};
let clock;

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

async function makeUser(label) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${label}@example.com`, passwordHash]
  );
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function seedShift(key, { date, endTime, startTime = null, visible }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name,
                         positions_needed, proposal_id)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, '["Bartender"]', $5) RETURNING id`,
    [date, startTime, endTime, `StaffHome ${key} ${NONCE}`, proposalId]
  );
  F[key] = r.rows[0].id;
  EXPECTED[key] = visible;
  return F[key];
}

async function request(shiftId, userId, status, extra = {}) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, cover_requested_at, cover_reason)
     VALUES ($1, $2, 'Bartender', $3, $4, $5)`,
    [shiftId, userId, status, extra.cover ? new Date() : null, extra.cover ? 'test cover' : null]
  );
}

before(async () => {
  const tz = (await pool.query(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  clock = (await pool.query(`
    WITH chi AS (SELECT NOW() AT TIME ZONE 'America/Chicago' AS n)
    SELECT to_char(n, 'YYYY-MM-DD') AS chi_today,
           to_char(n, 'HH24:MI')    AS chi_now,
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

  const me = await makeUser('me');
  meId = me.id; meToken = tokenFor(me);
  mateId = (await makeUser('mate')).id;

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`StaffHome Client ${NONCE}`, `${EMAIL_PREFIX}client@example.com`]
  );
  clientId = c.rows[0].id;
  proposalId = (await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE, '18:00', 4, 'America/Chicago', 'confirmed', 'birthday-party') RETURNING id`,
    [clientId]
  )).rows[0].id;

  await seedShift('ended', { date: clock.ended_d, endTime: clock.ended_t, visible: false });
  await seedShift('soon', { date: clock.soon_d, endTime: clock.soon_t, visible: true });
  await seedShift('tonightNull', { date: clock.chi_today, endTime: null, startTime: '6:00 PM', visible: true });
  await seedShift('endedPending', { date: clock.ended_d, endTime: clock.ended_t, visible: false });

  // My own roster: approved on the finished shift and on the one still ahead.
  await request(F.ended, meId, 'approved');
  await request(F.soon, meId, 'approved');
  // Pending on tonight (should show) and on a shift that already ended (should
  // not). The pair is what discriminates at any hour: the ended fixture is
  // dated TODAY, so the old calendar-day predicate kept it listed.
  await request(F.tonightNull, meId, 'pending');
  await request(F.endedPending, meId, 'pending');
  // A teammate broadcasting for cover on each.
  await request(F.ended, mateId, 'approved', { cover: true });
  await request(F.soon, mateId, 'approved', { cover: true });

  const derived = await pool.query(
    `SELECT s.id, (${shiftNotFinishedSql('s', 'p')}) AS not_finished,
            (s.event_date >= CURRENT_DATE) AS old_predicate
       FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE s.id = ANY($1::int[])`,
    [Object.values(F)]
  );
  const byId = new Map(derived.rows.map((r) => [r.id, r]));
  for (const [key, id] of Object.entries(F)) {
    assert.equal(byId.get(id).not_finished, EXPECTED[key],
      `test premise: fixture "${key}" should be ${EXPECTED[key] ? 'unfinished' : 'finished'} at Chicago ${clock.chi_now}`);
  }
  const wrongUnderOld = Object.entries(F)
    .filter(([key, id]) => byId.get(id).old_predicate !== EXPECTED[key]).map(([k]) => k);
  assert.ok(wrongUnderOld.length > 0,
    `test premise: the old event_date >= CURRENT_DATE predicate must misclassify at least one fixture (Chicago ${clock.chi_now}, CURRENT_DATE ${clock.db_today})`);
  console.log(`[premise] old CURRENT_DATE predicate misclassifies: ${wrongUnderOld.join(', ')} (Chicago now ${clock.chi_now})`);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', require('./staffPortal'));
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

test('next-shift card skips the shift that already ended and shows the one still ahead', async () => {
  const res = await get('/api/me/staff-home', meToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.next_shift, 'a next shift must be present');
  assert.equal(res.body.next_shift.shift_id, F.soon,
    'the finished shift must not be the "next" shift — that is the card that used to say "no upcoming shift" at 19:30, and then, after the naive fix, showed this morning until midnight');
});

test('pending requests drop out only once the shift itself has finished', async () => {
  const res = await get('/api/me/staff-home', meToken);
  const ids = res.body.pending_requests.map((r) => r.shift_id);
  assert.ok(ids.includes(F.tonightNull), 'tonight (no end_time) must still be pending-visible');
  assert.ok(!ids.includes(F.endedPending), 'a pending request on a shift that already ended is not something to act on');
});

test('cover broadcasts follow the same boundary', async () => {
  const res = await get('/api/me/staff-home', meToken);
  const ids = res.body.cover_broadcasts.map((r) => r.shift_id);
  assert.ok(ids.includes(F.soon), 'a broadcast on an unfinished shift is still actionable');
  assert.ok(!ids.includes(F.ended), 'a broadcast on a finished shift is not');
});

test('open-shifts teaser and its "All (N)" count agree with the Available tab', async () => {
  // THE PAIRING. The teaser, the count, and the tab all import one fragment;
  // this proves they agree on live rows rather than on a comment claiming so.
  const res = await get('/api/me/staff-home', meToken);
  const available = await pool.query(STAFF_OPEN_SHIFTS_SQL, [meId]);
  const availableIds = new Set(available.rows.map((r) => r.id));

  const mine = Object.values(F);
  const mineOnTab = mine.filter((id) => availableIds.has(id));
  assert.deepEqual(
    mineOnTab.sort(),
    [F.soon, F.tonightNull].sort(),
    'the Available tab must list exactly the unfinished fixtures'
  );

  // Count: total unfinished open shifts, minus everything that is not ours.
  const baseline = (await pool.query(`
    SELECT COUNT(*)::int AS n FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
     WHERE s.status = 'open' AND ${shiftNotFinishedSql('s', 'p')}
       AND NOT (s.id = ANY($1::int[]))
  `, [mine])).rows[0].n;
  assert.equal(res.body.open_shifts_count - baseline, mineOnTab.length,
    'the "All (N)" count must move by exactly the fixtures the tab lists');

  // Teaser is LIMIT 2, so it can only be a subset — but never a shift the tab
  // itself would not show, which is the drift that actually hurt.
  for (const row of res.body.open_shifts_teaser) {
    if (mine.includes(row.shift_id)) {
      assert.ok(availableIds.has(row.shift_id),
        `teaser offered shift ${row.shift_id} that the Available tab does not list`);
    }
  }
});
