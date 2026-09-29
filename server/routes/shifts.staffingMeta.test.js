// Staffing meta on the three reads the phone staffing surfaces use (lane
// ma-e2, spec 2026-08-13-mobile-admin sections 3 and 4).
//
// Three kinds of claim, kept apart on purpose:
//   1. ADDITIVE. The two shifts reads gain events_worked, finished and (on
//      by-proposal) requested_positions. Nothing they returned before moves.
//   2. FROZEN. GET /admin/active-staff without shift_id returns exactly the
//      20 keys it returned before this lane. The desktop drawer, the roster and
//      the reviews page all read that shape.
//   3. ONE DEFINITION. events_worked here equals GET /admin/users/:id/seniority
//      for the same person, across every filter the definition has, so this
//      third reader cannot drift from the two that feed auto-assign.
// And two privacy laws: no response carries a person's raw home coordinates,
// and the picker's distances are whole miles.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { chicagoTodayYmd } = require('../utils/businessTime');
const { wholeMiles } = require('../utils/staffingMeta');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.staffingMeta.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = (label) => `staffing-meta-${NONCE}-${label}@example.com`;
// Sorts to the top of the alphabetical active-staff feed, so the fixtures are
// inside the first 100 rows however many staff the dev database holds.
const NAME = (label) => `AAA ${NONCE} ${label}`;

// Chicago Loop venue, Rockford home: about 80 straight-line miles.
const VENUE = { lat: 41.8781, lng: -87.6298 };
const HOME = { lat: 42.2711, lng: -89.0940 };

const LEGACY_STAFF_KEYS = ['cc_id', 'city', 'created_at', 'display_name', 'email', 'equipment_cooler',
  'equipment_portable_bar', 'equipment_table_with_spandex', 'id', 'import_source', 'onboarding_completed',
  'onboarding_status', 'phone', 'positions_interested', 'preferred_name', 'reliable_transportation', 'role',
  'signed_at', 'state', 'travel_distance'];

let server, baseUrl;
const ids = { users: [], shifts: [], proposals: [], clients: [] };
let adminToken, plainManagerToken;
let near, far, bench, bare, twice;   // staff fixtures
let futureShift, pastShift, todayShift, manualShift, proposalId, pastProposalId;
let claimer, coveredRequestId;

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

async function makeUser(label, { role = 'staff', canStaff = false, home = null, historical = 0, profile = true } = {}) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, can_staff, token_version)
     VALUES ($1, 'x', $2, 'approved', $3, 0) RETURNING id, token_version`,
    [EMAIL(label), role, canStaff]
  );
  const user = r.rows[0];
  ids.users.push(user.id);
  await pool.query('INSERT INTO onboarding_progress (user_id, onboarding_completed) VALUES ($1, TRUE)', [user.id]);
  if (profile) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, display_name, lat, lng, historical_events_worked)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [user.id, NAME(label), home ? home.lat : null, home ? home.lng : null, historical]
    );
  }
  return user;
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function seedProposal(date) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', $2::date, 100, 'wedding-reception', 1000, 100) RETURNING id`,
    [ids.clients[0], date]
  );
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedShift({ date, proposal = null, venue = null, positions = '["Bartender","Bartender"]', start = '18:00', end = '23:00' }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id, lat, lng)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, $5, $6, $7, $8) RETURNING id`,
    [date, start, end, `StaffingMeta ${NONCE}`, positions, proposal, venue ? venue.lat : null, venue ? venue.lng : null]
  );
  ids.shifts.push(r.rows[0].id);
  return r.rows[0].id;
}
// covers: the request id of the teammate a cover claim stands in for.
async function request(shiftId, userId, { status = 'pending', position = null, ranked = '[]', dropped = false, covers = null } = {}) {
  const r = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions, dropped_at, replaced_by_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [shiftId, userId, status, position, ranked, dropped ? new Date() : null, covers]
  );
  return r.rows[0].id;
}
const ymdOffset = (days) => {
  const d = new Date(`${chicagoTodayYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', require('./shifts'));
  app.use('/api/admin', require('./admin/users'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  adminToken = tokenFor(await makeUser('admin', { role: 'admin' }));
  plainManagerToken = tokenFor(await makeUser('manager', { role: 'manager', canStaff: false }));
  near = await makeUser('near', { home: HOME, historical: 12 });   // 12 imported + 1 live = 13
  far = await makeUser('far');                                     // no home coordinates, nothing worked
  bench = await makeUser('bench', { home: HOME, historical: 3 });  // never requested: a picker candidate
  bare = await makeUser('bare', { profile: false });               // no contractor profile at all
  twice = await makeUser('twice');                                 // two shifts of ONE past event
  claimer = await makeUser('claimer');                             // a cover claim on a past shift

  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`StaffingMeta ${NONCE}`, EMAIL('client')]);
  ids.clients.push(c.rows[0].id);
  proposalId = await seedProposal(ymdOffset(5));
  const pastProposal = await seedProposal(ymdOffset(-20));
  pastProposalId = pastProposal;

  futureShift = await seedShift({ date: ymdOffset(5), proposal: proposalId, venue: VENUE });
  pastShift = await seedShift({ date: ymdOffset(-10) });
  todayShift = await seedShift({ date: ymdOffset(0), start: '23:00', end: '23:30' });
  manualShift = await seedShift({ date: ymdOffset(7) });           // no proposal, no venue coordinates
  const pastDropped = await seedShift({ date: ymdOffset(-11) });
  const pastPending = await seedShift({ date: ymdOffset(-12) });
  const pastDenied = await seedShift({ date: ymdOffset(-13) });
  const pastA = await seedShift({ date: ymdOffset(-20), proposal: pastProposal, start: '16:00', end: '20:00' });
  const pastB = await seedShift({ date: ymdOffset(-20), proposal: pastProposal, start: '20:00', end: '23:00' });

  // near: exactly ONE row counts. Each of the others trips one filter.
  await request(pastShift, near.id, { status: 'approved', position: 'Bartender' });                     // counts
  await request(todayShift, near.id, { status: 'approved', position: 'Bartender' });                    // tonight: not yet
  await request(pastDropped, near.id, { status: 'approved', position: 'Bartender', dropped: true });    // emergency drop
  await request(pastPending, near.id, { status: 'pending', ranked: '["Bartender"]' });                  // never approved
  await request(pastDenied, near.id, { status: 'denied' });                                             // denied
  await request(futureShift, near.id, { status: 'pending', ranked: '["Bartender","Barback"]' });
  await request(futureShift, far.id, { status: 'pending', ranked: '[]' });
  await request(futureShift, bare.id, { status: 'pending', ranked: '["Bartender"]' });
  await request(manualShift, near.id, { status: 'pending', ranked: '["Bartender"]' });
  await request(pastA, twice.id, { status: 'approved', position: 'Bartender' });
  coveredRequestId = await request(pastB, twice.id, { status: 'approved', position: 'Bartender' });
  await request(pastB, claimer.id, { status: 'pending', position: 'Bartender', ranked: '["Barback"]', covers: coveredRequestId });
  await request(futureShift, twice.id, { status: 'pending', ranked: '["Bartender"]' });
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids.clients]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM onboarding_progress WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids.users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const noCoords = (row, where) => {
  for (const k of ['lat', 'lng', 'staff_lat', 'staff_lng']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, k), false, `${where} must not carry ${k}`);
  }
};

test('detail: requests carry events_worked and the derived distance, never raw coordinates', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  const b = r.body.requests.find((x) => x.user_id === far.id);
  assert.equal(a.events_worked, 13, 'twelve imported plus one live event; tonight, a drop, a pending and a denied do not count');
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100, `got ${a.home_distance_miles}`);
  assert.ok(!Number.isInteger(a.home_distance_miles), 'requester distance keeps a tenth of a mile');
  assert.equal(b.home_distance_miles, null, 'no home coordinates means no distance');
  r.body.requests.forEach((x) => noCoords(x, 'a detail request'));
  // What the desktop drawer reads must still be there.
  for (const k of ['id', 'user_id', 'status', 'position', 'dropped_at', 'requested_positions', 'staff_name', 'staff_email', 'staff_city', 'staff_reliable_transportation']) {
    assert.ok(Object.prototype.hasOwnProperty.call(a, k), `detail request lost ${k}`);
  }
  for (const k of ['client_name', 'client_phone', 'client_email', 'proposal_total', 'request_count', 'approved_count', 'venue_distance_miles', 'positions_needed']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.body.shift, k), `detail shift lost ${k}`);
  }
});

test('a requester with no contractor profile still gets a row: zero events, no distance, a name', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  const x = r.body.requests.find((q) => q.user_id === bare.id);
  assert.ok(x, 'the profile-less requester is in the list');
  assert.equal(x.events_worked, 0);
  assert.equal(x.home_distance_miles, null);
  assert.equal(x.staff_name, EMAIL('bare'), 'the name falls back to the email');
  const p = await get(`/api/shifts/by-proposal/${proposalId}`, adminToken);
  const y = p.body[0].requesters.find((q) => q.user_id === bare.id);
  assert.equal(y.events_worked, 0);
  assert.equal(y.home_distance_miles, null);
});

test('events worked counts SHIFTS: two shifts of one event count two', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(r.body.requests.find((q) => q.user_id === twice.id).events_worked, 2);
  const s = await get(`/api/admin/users/${twice.id}/seniority`, adminToken);
  assert.equal(s.body.events_worked, 2, 'the seniority route counts the same way');
});

test('detail: no coordinates on either side yields null, and events_worked still arrives', async () => {
  const r = await get(`/api/shifts/detail/${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  assert.equal(a.home_distance_miles, null, 'the venue has no coordinates');
  assert.equal(a.events_worked, 13);
});

test('detail: finished follows the shift end instant, and the proposal status rides along', async () => {
  const future = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(future.body.shift.finished, false);
  assert.equal(future.body.shift.proposal_status, 'deposit_paid');
  const past = await get(`/api/shifts/detail/${pastShift}`, adminToken);
  assert.equal(past.body.shift.finished, true);
  assert.equal(past.body.shift.proposal_status, null, 'a manual shift has no proposal');
});

test('by-proposal: requesters carry the ranked roles, events_worked and distance; shifts carry finished', async () => {
  const r = await get(`/api/shifts/by-proposal/${proposalId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const shift = r.body[0];
  assert.equal(shift.finished, false);
  const a = shift.requesters.find((x) => x.user_id === near.id);
  const b = shift.requesters.find((x) => x.user_id === far.id);
  const ranked = typeof a.requested_positions === 'string' ? JSON.parse(a.requested_positions) : a.requested_positions;
  assert.deepEqual(ranked, ['Bartender', 'Barback']);
  assert.equal(a.events_worked, 13);
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100);
  assert.ok(!Number.isInteger(a.home_distance_miles), 'requester distance keeps a tenth of a mile');
  shift.requesters.forEach((x) => noCoords(x, 'a by-proposal requester'));
  // An ordinary request covers nobody, and says so with a null, not a missing key.
  shift.requesters.forEach((x) => assert.equal(x.replaced_by_request_id, null));
  // What the desktop card reads must still be there.
  for (const k of ['approved_staff', 'approved_by_role', 'request_count', 'approved_count', 'venue_distance_miles']) {
    assert.ok(Object.prototype.hasOwnProperty.call(shift, k), `by-proposal lost ${k}`);
  }
});

test('by-proposal: a finished shift says so, and a cover claim names the request it covers', async () => {
  const r = await get(`/api/shifts/by-proposal/${pastProposalId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  r.body.forEach((s) => assert.equal(s.finished, true, `shift ${s.id} ended twenty days ago`));
  const claim = r.body.flatMap((s) => s.requesters).find((x) => x.user_id === claimer.id);
  assert.equal(claim.replaced_by_request_id, coveredRequestId);
  assert.equal(claim.position, 'Bartender');
  // The same claim, read through the sheet's endpoint, carries the same link.
  const shiftId = r.body.find((s) => s.requesters.some((x) => x.user_id === claimer.id)).id;
  const d = await get(`/api/shifts/detail/${shiftId}`, adminToken);
  assert.equal(d.body.requests.find((x) => x.user_id === claimer.id).replaced_by_request_id, coveredRequestId);
});

test('a malformed path id answers 400 on both shifts reads, never 500', async () => {
  for (const bad of ['abc', '0', '-4', '1.5', '99999999999']) {
    assert.equal((await get(`/api/shifts/detail/${bad}`, adminToken)).status, 400, `detail/${bad}`);
    assert.equal((await get(`/api/shifts/by-proposal/${bad}`, adminToken)).status, 400, `by-proposal/${bad}`);
  }
  assert.equal((await get('/api/shifts/detail/2147483000', adminToken)).status, 404, 'a well-formed id that matches nothing');
  assert.deepEqual((await get('/api/shifts/by-proposal/2147483000', adminToken)).body, [], 'a proposal with no shifts');
});

test('active-staff without shift_id is frozen at its 20 legacy keys', async () => {
  const r = await get('/api/admin/active-staff?limit=100', adminToken);
  assert.equal(r.status, 200);
  const row = r.body.staff.find((s) => s.id === bench.id);
  assert.ok(row, 'the bench fixture is in the first page');
  assert.deepEqual(Object.keys(row).sort(), LEGACY_STAFF_KEYS);
});

test('active-staff with shift_id adds events_worked and a WHOLE-mile distance to that venue, never coordinates', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const b = r.body.staff.find((s) => s.id === bench.id);
  const f = r.body.staff.find((s) => s.id === far.id);
  assert.equal(b.events_worked, 3);
  assert.ok(b.home_distance_miles > 60 && b.home_distance_miles < 100, `got ${b.home_distance_miles}`);
  assert.equal(f.events_worked, 0);
  assert.equal(f.home_distance_miles, null);
  assert.deepEqual(Object.keys(b).sort(), [...LEGACY_STAFF_KEYS, 'events_worked', 'home_distance_miles'].sort());
  for (const s of r.body.staff) {
    noCoords(s, 'an active-staff row');
    assert.ok(s.home_distance_miles === null || Number.isInteger(s.home_distance_miles),
      `picker distances are whole miles, got ${s.home_distance_miles}`);
  }
});

test('wholeMiles rounds to the mile and keeps null as null', () => {
  assert.equal(wholeMiles(6.8), 7);
  assert.equal(wholeMiles(6.44), 6);
  assert.equal(wholeMiles(0.3), 0);
  assert.equal(wholeMiles(null), null);
  assert.equal(wholeMiles(undefined), null);
  assert.equal(wholeMiles(Number.NaN), null);
});

test('active-staff with a venue that has no coordinates returns null distances', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.staff.find((s) => s.id === bench.id).home_distance_miles, null);
});

test('active-staff refuses a malformed shift_id and 404s an unknown one', async () => {
  // The last one passes a digits-only check and overflows int4 in the query.
  for (const bad of ['abc', '0', '-4', '1.5', '', '99999999999']) {
    const r = await get(`/api/admin/active-staff?limit=100&shift_id=${encodeURIComponent(bad)}`, adminToken);
    assert.equal(r.status, 400, `shift_id=${JSON.stringify(bad)} should be a 400`);
  }
  const gone = await get('/api/admin/active-staff?limit=100&shift_id=2147483000', adminToken);
  assert.equal(gone.status, 404);
});

test('a manager without can_staff reaches none of the three reads', async () => {
  assert.equal((await get(`/api/shifts/detail/${futureShift}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/shifts/by-proposal/${proposalId}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, plainManagerToken)).status, 403);
});

test('events_worked is the same number the seniority route reports, filter by filter', async () => {
  const d = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  for (const who of [near, far, bare, twice]) {
    const s = await get(`/api/admin/users/${who.id}/seniority`, adminToken);
    assert.equal(s.status, 200);
    assert.equal(d.body.requests.find((x) => x.user_id === who.id).events_worked, s.body.events_worked);
  }
});
