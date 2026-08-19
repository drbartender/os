// GET /api/me/staff-home — WHICH PAY PERIOD is "now" on the staffer's pay card.
//
// THE DEFECT. The lookup selected the period with `CURRENT_DATE`. The Postgres
// session runs at GMT, so that is the UTC day and it rolls over at 19:00 Chicago
// (18:00 in winter). On the LAST EVENING of a pay period the query therefore
// asked for TOMORROW — and `pay_periods` rows are minted lazily by accrual, 0 to
// 4 days INTO their own week (verified against prod), so tomorrow's row does not
// exist yet. The predicate matched ZERO rows, `current_period` came back null,
// and `client/src/pages/staff/HomePage.js:279-286` rendered the new-hire empty
// state: "No payouts yet. Your first payout will appear here after your first
// shift." A months-tenured contractor, on the evening their week closed, was told
// they had never been paid. (An earlier version of this header said they saw
// "$0"; that was wrong, and the real symptom is worse.)
//
// WHY THIS DRIVES THE ROUTE. A first cut of this suite ran a COPY of the SQL and
// tied it to the app with a source regex. Two independent reviewers broke it: the
// regex `chicagoTodayYmd\(\)` was satisfied by the SQL COMMENT the same commit
// wrote, so reintroducing the exact bug — binding a UTC day again — left the
// suite green. Four other regressions walked past it too (dropping the bind so
// every request 500s, adding a status filter, flipping the ORDER BY, letting a
// query param choose the period). A copy of a predicate proves things about
// Postgres, not about the route. So this suite mounts the real router and calls
// the real endpoint.
//
// WHY THE DATE IS INJECTED rather than mocked. The UTC and Chicago days AGREE for
// about 19 hours out of 24, so a clock-derived fixture proves nothing for most of
// the day while staying green. Pinning global `Date` instead would expire this
// suite's own JWT. So the route takes its day from `_deps.today`, the same
// injection seam the file already uses for uploadFile and sendEmail.
//
// Run BOTH:
//   TZ=UTC              node --test server/routes/staffPortal.payPeriod.boundary.test.js
//   TZ=America/Chicago  node --test server/routes/staffPortal.payPeriod.boundary.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const staffPortal = require('./staffPortal');

if (process.env.NODE_ENV === 'production') {
  throw new Error('staffPortal.payPeriod.boundary.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `payperiod-boundary-${NONCE}@example.com`;

// Far-future so these can never collide with, or be mistaken for, a real
// boundary on this SHARED dev database (pay_periods carries UNIQUE start_date).
const WORKED = { start: '2099-03-02', end: '2099-03-08', status: 'paid' };
const NEXT   = { start: '2099-03-09', end: '2099-03-15', status: 'open' };

let server; let baseUrl; let token; let userId;
let workedId; let nextId;
const extraPeriodIds = [];

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }); }
        catch (e) { reject(new Error(`bad JSON (${res.statusCode}): ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function seedPeriod({ start, end, status }) {
  const r = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1::date, $2::date, $2::date + 5, $3) RETURNING id`,
    [start, end, status]
  );
  return r.rows[0].id;
}

/** Run one request with the route's day pinned, then always restore the real clock. */
async function withToday(ymd, fn) {
  staffPortal.__setDeps({ today: () => ymd });
  try { return await fn(); }
  finally { staffPortal.__setDeps({ today: require('../utils/businessTime').chicagoTodayYmd }); }
}

before(async () => {
  const tz = (await pool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  const passwordHash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [EMAIL, passwordHash]
  );
  userId = u.rows[0].id;
  token = jwt.sign({ userId, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  workedId = await seedPeriod(WORKED);
  nextId = await seedPeriod(NEXT);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', staffPortal);
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
  const ids = [workedId, nextId, ...extraPeriodIds].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM pay_periods WHERE id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  await pool.end();
});

test('THE BUG: the last evening of a period keeps the staffer on the week they worked', async () => {
  // 19:30 Chicago on 2099-03-08: the Chicago day is still the 8th, CURRENT_DATE
  // (UTC) is already the 9th. These two calls are those two worlds.
  const chicago = await withToday('2099-03-08', () => get('/api/me/staff-home'));
  assert.equal(chicago.status, 200, JSON.stringify(chicago.body));
  assert.ok(chicago.body.current_period, 'the pay card must not be empty on the last evening');
  assert.equal(chicago.body.current_period.pay_period_id, workedId,
    'the Chicago day keeps the staffer on the period they just worked');

  const utc = await withToday('2099-03-09', () => get('/api/me/staff-home'));
  assert.equal(utc.body.current_period.pay_period_id, nextId,
    'the UTC day rolls them into next week — the defect');
  assert.notEqual(chicago.body.current_period.pay_period_id, utc.body.current_period.pay_period_id,
    'if these ever agree the suite has stopped discriminating');
});

test('the real symptom: a day inside NO period empties the card entirely', async () => {
  // This is what actually shipped. Not "$0" — no row at all, because next week's
  // pay_periods row is not minted until accrual runs days into that week.
  const res = await withToday('2099-02-01', () => get('/api/me/staff-home'));
  assert.equal(res.status, 200);
  assert.equal(res.body.current_period, null,
    'no period covers that day, so the card falls back to the never-been-paid empty state');
});

test('a FROZEN period is still shown — this route deliberately does not filter on status', async () => {
  // payrollProcessing.findOpenPeriodForDate filters status='open'; this surface
  // must NOT, or the card blanks during the exact window payroll is processing
  // and the staffer is most likely to look. WORKED is seeded 'paid'.
  const res = await withToday('2099-03-08', () => get('/api/me/staff-home'));
  assert.equal(res.body.current_period.pay_period_id, workedId);
  assert.equal(res.body.current_period.status, 'paid',
    'a paid period is surfaced as paid, not hidden');
});

test('overlapping periods resolve by the LATEST start (ORDER BY start_date DESC)', async () => {
  // Not hypothetical: admin/staffReviews.test.js documents this dev DB routinely
  // ending up with a second, overlapping open period.
  const overlapId = await seedPeriod({ start: '2099-03-04', end: '2099-03-10', status: 'open' });
  extraPeriodIds.push(overlapId);
  const res = await withToday('2099-03-08', () => get('/api/me/staff-home'));
  assert.equal(res.body.current_period.pay_period_id, overlapId,
    'the later-starting period wins the tie; flipping the ORDER BY would return the earlier one');
});

test('the shipped route takes its day from the injected clock, not a UTC expression', async () => {
  // Anchored at the CALL SITE, not the file: the previous version of this
  // assertion searched the whole source and was satisfied by a code comment,
  // which let the original bug be reintroduced with the suite still green.
  const src = fs.readFileSync(path.join(__dirname, 'staffPortal.js'), 'utf8');
  const from = src.indexOf('FROM pay_periods pp');
  assert.ok(from > -1, 'the pay-period query must still exist');
  const limitIdx = src.indexOf('LIMIT 1', from);
  const callSite = src.slice(limitIdx, limitIdx + 160);

  assert.match(callSite, /\[\s*userId\s*,\s*_deps\.today\(\)\s*\]/,
    'the second bind must be the injected day, not any other date expression');
  assert.doesNotMatch(src.slice(from, limitIdx), /CURRENT_DATE\s+BETWEEN/,
    'CURRENT_DATE is the UTC day here and must not select the pay period');
  assert.match(src, /today:\s*chicagoTodayYmd/,
    'and in production that injected day must default to the Chicago business day');
});
