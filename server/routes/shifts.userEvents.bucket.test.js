// GET /shifts/user/:userId/events buckets by the CHICAGO business day.
//
// The handler used `new Date().toISOString().slice(0, 10)` for "today" — the
// UTC day. Render runs UTC, so from 7pm Chicago onward the server's "today"
// was already tomorrow and a shift starting in 30 minutes was bucketed PAST
// on the staffer's Shifts page (client/src/pages/staff/ShiftsPage.js:141).
//
// The clock is mocked at fixed instants so the cases discriminate identically
// under any process timezone. Run BOTH:
//   TZ=UTC              node --test server/routes/shifts.userEvents.bucket.test.js
//   TZ=America/Chicago  node --test server/routes/shifts.userEvents.bucket.test.js
//
// Note on the sibling trap: getDateStr() in the same handler calls
// toISOString() on r.event_date, a bare SQL DATE that pg builds at LOCAL
// midnight. That recovers the right calendar day on any machine at or west of
// UTC (Render is UTC, the dev box is Chicago) and is deliberately left alone;
// it would only shift a day early on a process timezone EAST of UTC.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.userEvents.bucket.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Chicago evening: 01:30Z on the 14th is 20:30 CDT on the 13th. The UTC day
// (the 14th) and the business day (the 13th) disagree — this is the bug window.
const CHI_EVENING = Date.parse('2031-08-14T01:30:00Z');
// UTC morning: 14:00Z on the 14th is 09:00 CDT on the 14th. Both agree here,
// so this case pins that the fix did not move the well-behaved daytime path.
const UTC_MORNING = Date.parse('2031-08-14T14:00:00Z');

const DATES = { yesterday: '2031-08-12', chicagoToday: '2031-08-13', utcToday: '2031-08-14' };

let server, baseUrl, staffId, staffToken;
const shiftIds = {};

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  staffId = (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`shift-bucket-${NONCE}@example.com`]
  )).rows[0].id;
  staffToken = jwt.sign({ userId: staffId, tokenVersion: 0 }, process.env.JWT_SECRET);

  for (const [key, d] of Object.entries(DATES)) {
    const sh = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
       VALUES ($1::date, '20:00', '23:00', 'open', '1 Test St', $2, '["bartender"]') RETURNING id`,
      [d, `Bucket ${key} ${NONCE}`]
    );
    shiftIds[key] = sh.rows[0].id;
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1, $2, 'bartender', 'approved')`,
      [shiftIds[key], staffId]
    );
  }

  const app = express();
  app.use(express.json());
  app.use('/api/shifts', shiftsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  mock.timers.reset();
  if (server) await new Promise((r) => server.close(r));
  const ids = Object.values(shiftIds);
  if (ids.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids]);
  }
  if (staffId) await pool.query('DELETE FROM users WHERE id = $1', [staffId]);
  await pool.end();
});

// Fetch with the process clock pinned to `now`. Only the Date API is faked, so
// sockets/timers behave normally for the duration of the request.
async function fetchAt(now) {
  mock.timers.enable({ apis: ['Date'], now });
  try {
    return await get(`/api/shifts/user/${staffId}/events`, staffToken);
  } finally {
    mock.timers.reset();
  }
}

const idsIn = (rows) => rows.map((r) => r.id);

test('Chicago evening: a shift dated TODAY in Chicago is UPCOMING, not past', async () => {
  const res = await fetchAt(CHI_EVENING);
  assert.equal(res.status, 200);
  assert.ok(
    idsIn(res.body.upcoming).includes(shiftIds.chicagoToday),
    'today-in-Chicago shift was not in upcoming — server bucketed on the UTC day'
  );
  assert.ok(!idsIn(res.body.past).includes(shiftIds.chicagoToday));
});

test('Chicago evening: yesterday stays PAST and tomorrow stays UPCOMING (no over-correction)', async () => {
  const res = await fetchAt(CHI_EVENING);
  assert.ok(idsIn(res.body.past).includes(shiftIds.yesterday));
  assert.ok(!idsIn(res.body.upcoming).includes(shiftIds.yesterday));
  assert.ok(idsIn(res.body.upcoming).includes(shiftIds.utcToday));
});

test('UTC morning: the daytime path is unchanged — today upcoming, prior days past', async () => {
  const res = await fetchAt(UTC_MORNING);
  assert.equal(res.status, 200);
  assert.ok(idsIn(res.body.upcoming).includes(shiftIds.utcToday));
  assert.ok(idsIn(res.body.past).includes(shiftIds.chicagoToday));
  assert.ok(idsIn(res.body.past).includes(shiftIds.yesterday));
});
