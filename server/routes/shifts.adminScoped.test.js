// The scoped, event-paged admin feed on GET /api/shifts.
//
// Two things are proved here, and they are different kinds of claim:
//
//   1. THE LEGACY CALL IS FROZEN. `GET /api/shifts` with no scope still answers
//      a bare array whose column set is pinned name for name (LEGACY_KEYS,
//      captured from the code BEFORE the projection moved). That pin is what
//      makes "the projection moved verbatim" a verified fact rather than a
//      trusted one: the desktop Events dashboard, the Overview page and the
//      staff pages all read that array.
//   2. THE SCOPED MODE IS CORRECT. `?scope=upcoming|past` pages by EVENT (a
//      two-shift wedding never splits across pages), buckets every shift into
//      exactly one of the two scopes, and flags needs_staff on the SAME
//      predicate the unstaffed_events badge uses, which this file re-derives
//      from the database rather than restating, so the chip and the badge
//      cannot drift apart with both comments claiming they mirror each other.
//
// Run BOTH timezones: the bucket law rides on the shift END INSTANT, and a
// single-TZ test is how the last date bug hid for months.
//   TZ=UTC              node --test server/routes/shifts.adminScoped.test.js
//   TZ=America/Chicago  node --test server/routes/shifts.adminScoped.test.js

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

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.adminScoped.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = `admin-scoped-${NONCE}-`;
const CLIENT_TAG = `AdminScoped ${NONCE}`;

let server, baseUrl;

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

// Captured from the CURRENT code, before the projection moved: the exact sorted
// column list the legacy admin array returns. Pinning it is what makes the
// "verbatim" move a verified claim instead of a trusted one.
const LEGACY_KEYS = ["approved_by_role","approved_count","approved_staff","auto_assign_days_before","auto_assigned_at","bar_required","client_email","client_name","client_phone","consult_at","created_at","created_by","created_by_email","end_time","equipment_required","event_date","event_duration_hours","event_type","event_type_custom","guest_count","id","lat","lng","location","menu_done","notes","out_of_area_attached_at","out_of_area_attached_by","out_of_area_bonus_cents","out_of_area_locked_at","out_of_area_locked_user_id","package_bar_type","package_category","package_name","pending_count","pending_staff","plan_input_landed","positions_needed","proposal_amount_paid","proposal_guest_count","proposal_id","proposal_status","proposal_token","proposal_total","request_count","setup_minutes_before","shopping_list_status","start_time","status","supply_run_overridden","supply_run_required","updated_at"];
let adminToken, staffToken, staffId, clientId, propA, propB, propC, propD;
const S = {}; // fixture key -> shift id

// proposals.token is UUID NOT NULL DEFAULT gen_random_uuid(): leave it to the default.
async function seedProposal(label, extra = {}) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, $2, $3::date, $4, 'wedding-reception', 1000, 100) RETURNING id`,
    [clientId, extra.status || 'deposit_paid', extra.date, extra.guests || 100]
  );
  return r.rows[0].id;
}
async function seedShift(key, { date, start = '18:00', end = '23:00', positions = '["Bartender"]', proposalId = null, status = 'open' }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id)
     VALUES ($1::date, $2, $3, $4, '1 Test St', $5, $6, $7) RETURNING id`,
    [date, start, end, status, `${CLIENT_TAG} ${key}`, positions, proposalId]
  );
  S[key] = r.rows[0].id;
  return S[key];
}
async function approve(shiftId, userId) {
  await pool.query(`INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`, [shiftId, userId]);
}
const ymdOffset = (days) => {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

before(async () => {
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

  adminToken = tokenFor(await makeUser('admin', 'admin'));
  const staff = await makeUser('staff'); staffId = staff.id; staffToken = tokenFor(staff);
  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [CLIENT_TAG, `${EMAIL_PREFIX}client@example.com`]);
  clientId = c.rows[0].id;
  propA = await seedProposal('A', { date: ymdOffset(2) });   // two shifts, both unstaffed
  propB = await seedProposal('B', { date: ymdOffset(9) });   // one shift, fully staffed
  propC = await seedProposal('C', { date: ymdOffset(6) });   // MIXED: one staffed, one open
  propD = await seedProposal('D', { date: ymdOffset(11) });  // MULTI-DATE: two shifts, two dates
  await seedShift('a1', { date: ymdOffset(2), positions: '["Bartender","Bartender","Bartender"]', proposalId: propA });
  await seedShift('a2', { date: ymdOffset(2), start: '17:00', end: '22:00', positions: '["Banquet Server"]', proposalId: propA });
  await seedShift('manual', { date: ymdOffset(4) });         // proposal_id NULL
  await seedShift('b1', { date: ymdOffset(9), proposalId: propB });
  await approve(S.b1, staffId);
  await seedShift('c1', { date: ymdOffset(6), proposalId: propC });
  await approve(S.c1, staffId);
  await seedShift('c2', { date: ymdOffset(6), start: '17:00', end: '22:00', proposalId: propC });
  await seedShift('cancelled', { date: ymdOffset(3), status: 'cancelled' });   // future-dated, cancelled
  await seedShift('past', { date: ymdOffset(-3) });
  // ONE event, TWO dates. The schema permits it (event_date is per shift and
  // PUT /shifts/:id edits one at a time), and ranking on the row's date would
  // split it across two pages. Both unstaffed, so it also rides the chip.
  await seedShift('d1', { date: ymdOffset(11), proposalId: propD });
  await seedShift('d2', { date: ymdOffset(12), proposalId: propD });
});

after(async () => {
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])`, [Object.values(S)]);
  await pool.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [Object.values(S)]);
  await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [[propA, propB, propC, propD]]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
  server.close();
});

const ALL = () => Object.values(S);
const mine = (rows) => rows.filter(r => ALL().includes(r.id));
const ids = (rows) => mine(rows).map(r => r.id).sort((a, b) => a - b);
const sorted = (xs) => [...xs].sort((a, b) => a - b);

// The badge predicate, restated over the fixtures only. This is the truth the
// chip must match (routes/admin/settings.js unstaffed_events).
async function badgeShiftIds() {
  const { shiftNotFinishedSql } = require('../utils/shiftEndInstant');
  const r = await pool.query(`
    SELECT s.id FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id
     WHERE ${shiftNotFinishedSql('s', 'p')} AND s.status = 'open'
       AND s.positions_needed IS JSON ARRAY
       AND jsonb_array_length(s.positions_needed::jsonb) > 0
       AND (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL)
           < jsonb_array_length(s.positions_needed::jsonb)
       AND s.id = ANY($1::int[])`, [ALL()]);
  return sorted(r.rows.map(x => x.id));
}

test('legacy call: bare array, every fixture present, the column set unchanged, no scoped columns', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.deepEqual(ids(r.body), sorted(ALL()));
  const keys = Object.keys(r.body[0]).sort();
  assert.deepEqual(keys, LEGACY_KEYS);
  assert.equal('event_key' in r.body[0], false);
});

// The dev DB holds other upcoming events; walk one-event pages until ours shows.
async function findPage(match) {
  let page = (await get('/api/shifts?scope=upcoming&limit=1', adminToken)).body;
  let guard = 0;
  while (page && guard++ < 400) {
    if (match(page)) return page;
    if (!page.has_more) return null;
    page = (await get(`/api/shifts?scope=upcoming&limit=1&offset=${page.next_offset}`, adminToken)).body;
  }
  return null;
}
const holds = (...wanted) => (page) => mine(page.rows).some(r => wanted.includes(r.id));

test('scope=upcoming pages by EVENT: both shifts of proposal A arrive together on page one', async () => {
  const r = await get('/api/shifts?scope=upcoming&limit=1', adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows));
  const found = await findPage(holds(S.a1, S.a2));
  assert.ok(found, 'proposal A never paged in');
  assert.deepEqual(ids(found.rows), sorted([S.a1, S.a2]));
  assert.equal(found.rows.every(x => x.event_key === `p${propA}`), true);
  assert.equal(found.limit, 1);
  // A scoped row is the WHOLE legacy shape plus the two scoped columns. The
  // phone list and the desktop dump read one projection; this is what says so.
  assert.ok(LEGACY_KEYS.every(k => k in found.rows[0]),
    `scoped row is missing legacy columns: ${LEGACY_KEYS.filter(k => !(k in found.rows[0])).join(', ')}`);
  assert.ok('event_key' in found.rows[0] && 'needs_staff' in found.rows[0]);
});

test('a MULTI-DATE event still occupies exactly one page: ranking is by the event first date, not the row', async () => {
  const found = await findPage(holds(S.d1, S.d2));
  assert.ok(found, 'proposal D never paged in');
  // Both dates arrive together, on ONE page of ONE event, under one key.
  assert.deepEqual(ids(found.rows), sorted([S.d1, S.d2]));
  assert.equal(found.rows.every(x => x.event_key === `p${propD}`), true);
  // ...and the two really are on different dates, or this proves nothing.
  const dates = new Set(mine(found.rows).map(x => String(x.event_date).slice(0, 10)));
  assert.equal(dates.size, 2, 'fixture premise: proposal D spans two event_dates');
  // The window keys are internal: they never reach the client.
  assert.equal('event_first_date' in found.rows[0], false);
  assert.equal('event_last_date' in found.rows[0], false);
  assert.equal('event_rank' in found.rows[0], false);
});

test('one bucket per shift: upcoming = live and unfinished; past = finished OR cancelled OR archived, newest first', async () => {
  const up = (await get('/api/shifts?scope=upcoming&limit=200', adminToken)).body;
  assert.deepEqual(ids(up.rows), sorted([S.a1, S.a2, S.manual, S.b1, S.c1, S.c2, S.d1, S.d2]));
  const past = (await get('/api/shifts?scope=past&limit=200', adminToken)).body;
  assert.deepEqual(ids(past.rows), sorted([S.past, S.cancelled]), 'a future-dated cancelled shift lives on Past');
  assert.equal(past.needs_staff_events, 0);
  // EVERY past row, not just our fixtures: the flag carries its own end-instant
  // term, so nothing finished, cancelled or archived can read as needing staff.
  // Measured before the fix: 24 of 81 real past rows came back true here.
  assert.equal(past.rows.every(r => r.needs_staff === false), true,
    'a past row must never be flagged needs_staff');
  const dates = past.rows.map(r => String(r.event_date).slice(0, 10));
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i], 'past not descending');
});

test('needs_staff: the per-shift flag is the badge predicate; the chip keeps whole events', async () => {
  const badge = await badgeShiftIds();
  assert.deepEqual(badge, sorted([S.a1, S.a2, S.manual, S.c2, S.d1, S.d2]), 'fixture premise: c1 is staffed, c2 is open');
  const all = (await get('/api/shifts?scope=upcoming&limit=200', adminToken)).body;
  // Always a real boolean, never NULL: positions_needed is nullable and
  // NULL IS JSON ARRAY is NULL, so the predicate is COALESCEd at the source.
  assert.ok(all.rows.every(r => typeof r.needs_staff === 'boolean'),
    'needs_staff must be a boolean on every row');
  // Flag truth, row by row.
  assert.deepEqual(sorted(mine(all.rows).filter(x => x.needs_staff).map(x => x.id)), badge);
  // Chip rows: every shift of any event that has a flagged shift. Proposal C stays whole.
  const chip = (await get('/api/shifts?scope=upcoming&needs_staff=1&limit=200', adminToken)).body;
  assert.deepEqual(ids(chip.rows), sorted([S.a1, S.a2, S.manual, S.c1, S.c2, S.d1, S.d2]));
  assert.equal(mine(chip.rows).find(x => x.id === S.c1).needs_staff, false, 'the staffed shift rides along with its event, unflagged');
  // Event sets agree between chip and badge.
  const keyOf = (id) => all.rows.find(x => x.id === id).event_key;
  assert.deepEqual([...new Set(mine(chip.rows).map(x => x.event_key))].sort(), [...new Set(badge.map(keyOf))].sort());
  // Counts: needs_staff_events counts EVENTS over the whole scope; scope_events ignores the chip.
  const distinctNeedy = new Set(all.rows.filter(x => x.needs_staff).map(x => x.event_key)).size;
  assert.equal(all.needs_staff_events, distinctNeedy);
  assert.equal(chip.needs_staff_events, distinctNeedy);
  assert.equal(chip.scope_events, all.total_events);
  assert.ok(chip.total_events <= chip.scope_events);
  // One rank per EVENT, not per row: the event count can never come in under
  // the number of distinct events actually on the page. A multi-date event
  // ranked by its row date would break this by inflating total_events.
  assert.ok(all.total_events >= new Set(mine(all.rows).map(r => r.event_key)).size);
});

test('an empty page keeps the totals', async () => {
  const full = (await get('/api/shifts?scope=upcoming&limit=200', adminToken)).body;
  const empty = (await get('/api/shifts?scope=upcoming&offset=100000&limit=1', adminToken)).body;
  // No rows, but the scope still reports its size. Reachable at offset 0 too,
  // via the chip matching nothing, which is the state Task 4 renders as
  // "Fully staffed" rather than as an empty calendar.
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.scope_events, full.total_events);
  assert.ok(empty.scope_events > 0, 'premise: the dev DB holds upcoming events');
  assert.equal(empty.has_more, false);
});

test('limit and offset clamp; totals and has_more are consistent', async () => {
  const r = (await get('/api/shifts?scope=upcoming&limit=999&offset=-5', adminToken)).body;
  assert.equal(r.limit, 200);
  assert.equal(r.offset, 0);
  assert.equal(r.has_more, r.offset + r.limit < r.total_events);
  assert.equal(r.next_offset, r.offset + r.limit);
  assert.ok(new Set(r.rows.map(x => x.event_key)).size <= r.limit);
});

test('a staff token ignores scope and gets the staff array', async () => {
  const r = await get('/api/shifts?scope=upcoming', staffToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});
