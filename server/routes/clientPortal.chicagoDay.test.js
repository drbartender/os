// GET /api/client/home — WHICH SIDE of "today" a client's event falls on.
//
// THE DEFECT. Three date compares built this payload with SQL CURRENT_DATE: the
// focus card (`event_date >= CURRENT_DATE`), the upcoming count (same), and the
// archive list (`event_date < CURRENT_DATE`). The Postgres session runs at GMT
// (asserted in `before`, not assumed), so CURRENT_DATE rolls over at 19:00
// Chicago. A client opening their portal on the EVENING of their own event saw
// it gone from the focus card and sitting in the archive, about five hours
// before the bar opened.
//
// WHY A CALENDAR DAY IS RIGHT HERE, when shiftEndInstant.js deliberately replaced
// the calendar day everywhere on the STAFF roster: the stakes are opposite. On
// the roster, keeping a finished morning shift "upcoming" all day lets a CANT
// text deny a shift somebody already worked, off the roster payroll pays from.
// On a client's own portal there is no such write path — the client's event
// should simply stay upcoming until the business day it falls on is over.
//
// WHY THE DAY IS INJECTED. The UTC and Chicago days agree for about 19 hours out
// of 24, so a clock-derived fixture is green for most of the day against the very
// bug it exists to catch. The router takes its day from `_deps.today`, the same
// seam staffPortal.js uses. Pinning it to a far-future date also makes the
// assertions mutation-proof: with CURRENT_DATE back, BOTH fixture proposals sit
// in the future, so the archive comes back empty and the count reads 2.
//
//   TZ=UTC              node --test server/routes/clientPortal.chicagoDay.test.js
//   TZ=America/Chicago  node --test server/routes/clientPortal.chicagoDay.test.js

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientPortal = require('./clientPortal');
const { chicagoTodayYmd } = require('../utils/businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientPortal.chicagoDay.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `portal-chicago-${NONCE}@example.com`;

// Far-future, so no real CURRENT_DATE can coincide with either date and the
// two proposals straddle the pinned day by exactly one calendar day.
const PINNED = '2099-03-02';
const DAY_BEFORE = '2099-03-01';

let server; let baseUrl; let token; let clientId;
const proposalIds = [];

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

/** Run one request with the router's day pinned, then always restore the real clock. */
async function withToday(ymd, fn) {
  clientPortal.__setDeps({ today: () => ymd });
  try { return await fn(); }
  finally { clientPortal.__setDeps({ today: chicagoTodayYmd }); }
}

async function seedProposal(eventDate) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price, guest_count, event_type)
     VALUES ($1, $2::date, 'confirmed', 1000, 50, 'wedding') RETURNING id`,
    [clientId, eventDate]
  );
  proposalIds.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const tz = (await pool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz;
  assert.equal(tz, 'GMT', `test premise: the DB session must run at GMT (got ${tz})`);

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ('Chicago Day Fixture', $1, '555-0101', 'direct')
     RETURNING id, token_version`,
    [EMAIL]
  );
  clientId = c.rows[0].id;
  token = jwt.sign(
    { id: clientId, role: 'client', tokenVersion: c.rows[0].token_version ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  await seedProposal(PINNED);      // the event happening ON the pinned day
  await seedProposal(DAY_BEFORE);  // the event that finished yesterday

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/client', clientPortal);
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
  clientPortal.__setDeps({ today: chicagoTodayYmd });
  if (server) await new Promise((resolve) => server.close(resolve));
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test("the client's event TODAY is still upcoming, not archived", async () => {
  const res = await withToday(PINNED, () => get('/api/client/home'));
  assert.equal(res.status, 200);
  assert.ok(res.body.focus, 'an event dated today must still be the focus card');
  // The EXACT date, not just the year. BOOKED_FIRST orders event_date ASC, so
  // with CURRENT_DATE back both fixtures are upcoming and the focus card becomes
  // the DAY-BEFORE event — a client shown yesterday's job as their next one.
  // Asserting only the year let that mutation through.
  assert.equal(String(res.body.focus.event_date).slice(0, 10), PINNED);
  const archived = res.body.archive.map(r => String(r.event_date).slice(0, 10));
  assert.ok(!archived.some(d => d.startsWith('2099-03-02')),
    "today's event must NOT appear in the archive");
});

test('the upcoming count counts only the event that has not passed', async () => {
  // With CURRENT_DATE back this reads 2: both fixture proposals are far-future,
  // so yesterday's event never crosses into the archive.
  const res = await withToday(PINNED, () => get('/api/client/home'));
  assert.equal(res.body.upcoming_count, 1);
});

test("yesterday's event is in the archive", async () => {
  const res = await withToday(PINNED, () => get('/api/client/home'));
  const archived = res.body.archive.map(r => String(r.event_date).slice(0, 10));
  assert.ok(archived.some(d => d.startsWith('2099-03-01')),
    "the day-before event must have crossed into the archive");
});

test('the focus and archive buckets are complements — each event in exactly one', async () => {
  // The three compares share ONE bound value precisely so this holds. Evaluated
  // independently they could disagree mid-request and drop or duplicate a row.
  //
  // Asserted by MEMBERSHIP, not by count. A first cut checked only that
  // upcoming_count + archive.length == 2, which the CURRENT_DATE bug satisfies
  // as 2 + 0 and walked straight past — a vacuous test that looked like a
  // safety net.
  const res = await withToday(PINNED, () => get('/api/client/home'));
  const archived = new Set(res.body.archive.map(r => String(r.event_date).slice(0, 10)));
  assert.ok(archived.has(DAY_BEFORE), 'the passed event belongs to the archive');
  assert.ok(!archived.has(PINNED), "today's event must not also be archived");
  assert.equal(res.body.upcoming_count, 1, 'exactly one event is still upcoming');
  assert.equal(res.body.upcoming_count + archived.size, proposalIds.length,
    'every seeded event is accounted for in exactly one bucket');
});
