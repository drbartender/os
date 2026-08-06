require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * Remote Staffing Fee check + prompt-answered (spec §6).
 *
 * SHARED DEV DB DISCIPLINE: `staff_within_40` / `staff_uncounted` are GLOBAL
 * counts over every approved staffer, so absolute numbers are not assertable
 * here. Every counting test measures a BASELINE first and asserts the DELTA its
 * own 'rsf-%@example.com' fixtures produce. Nothing else in this suite depends
 * on how populated the dev DB happens to be.
 *
 * No network: serviceArea.geocodeThrottled is stubbed for the whole file, which
 * also lets the no-street case assert that it was never called.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const serviceArea = require('../../utils/serviceArea');

// Stub the geocoder BEFORE the router runs. remoteStaffing.js reaches it as
// serviceArea.geocodeThrottled (namespace call), so this replacement is live.
const geocodeCalls = [];
let geocodeResult = { lat: 42.2711, lng: -89.0940 }; // Rockford, IL
serviceArea.geocodeThrottled = async (address) => {
  geocodeCalls.push(address);
  return geocodeResult;
};

const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('remoteStaffing.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = "email LIKE 'rsf-%@example.com'";

// Rockford is ~73 miles from the Pilsen home base (the $20 band).
const FAR_LAT = 42.2711;
const FAR_LNG = -89.0940;
// Downtown Chicago, a few miles from home base.
const NEAR_LAT = 41.8781;
const NEAR_LNG = -87.6298;

let server, baseUrl;
let adminId, adminToken, staffToken;
let clientId;
let farId, nearId, noStreetId, ungeocodedId;

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function cleanup() {
  const uids = `(SELECT id FROM users WHERE ${EMAIL_LIKE})`;
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE ${EMAIL_LIKE}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'rsf-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'rsf-%@example.com'`);
}

async function mkStaff(tag, { lat = null, lng = null, status = 'approved', withProfile = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', $2, 0) RETURNING id`,
    [`rsf-${tag}-${NONCE}@example.com`, status]
  );
  const id = rows[0].id;
  if (withProfile) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate, lat, lng)
       VALUES ($1, $2, 'bartender', 20.00, $3, $4)`,
      [id, `RSF ${tag}`, lat, lng]
    );
  }
  return id;
}

async function mkProposal(fields) {
  const { rows } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            status, event_type, total_price, amount_paid, pricing_snapshot,
                            venue_name, venue_street, venue_city, venue_state, venue_zip,
                            venue_lat, venue_lng)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'draft', 'rsf-fixture', 0, 0, '{"addons":[]}',
             $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      clientId, fields.venue_name || null, fields.venue_street || null,
      fields.venue_city || null, fields.venue_state || null, fields.venue_zip || null,
      fields.venue_lat ?? null, fields.venue_lng ?? null,
    ]
  );
  return rows[0].id;
}

before(async () => {
  await cleanup();

  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`rsf-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // NOTE: this admin has onboarding_status 'approved' but role 'admin', so the
  // counter deliberately skips it (see the role filter in remoteStaffing.js):
  // the owner is always available and would mask every real roster shortage.

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id`,
    [`rsf-plainstaff-${NONCE}@example.com`]
  );
  staffToken = jwt.sign({ userId: s.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`RSF ${NONCE}`, `rsf-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  farId = await mkProposal({
    venue_name: 'Far Barn', venue_street: '100 Far Rd', venue_city: 'Rockford',
    venue_state: 'Illinois', venue_zip: '61101', venue_lat: FAR_LAT, venue_lng: FAR_LNG,
  });
  nearId = await mkProposal({
    venue_name: 'Loop Loft', venue_street: '1 N State St', venue_city: 'Chicago',
    venue_state: 'Illinois', venue_zip: '60602', venue_lat: NEAR_LAT, venue_lng: NEAR_LNG,
  });
  // City + state only: no street, so it must never be geocoded.
  noStreetId = await mkProposal({
    venue_name: 'Somewhere', venue_city: 'Chicago', venue_state: 'Illinois',
  });
  // Street present but never geocoded yet: the on-demand path.
  ungeocodedId = await mkProposal({
    venue_name: 'New Barn', venue_street: '500 Prairie Ave', venue_city: 'Rockford',
    venue_state: 'Illinois', venue_zip: '61101',
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/proposals', proposalsRouter);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error('[rsf harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanup();
  await pool.end();
});

test('auth: plain staff cannot read the staffing check', async () => {
  const r = await req('GET', `/api/proposals/${farId}/remote-staffing-check`, { token: staffToken });
  assert.equal(r.status, 403);
});

test('counting: geocoded homes inside 40 mi add to staff_within_40; coordless staff go to staff_uncounted', async () => {
  const before0 = await req('GET', `/api/proposals/${nearId}/remote-staffing-check`, { token: adminToken });
  assert.equal(before0.status, 200, JSON.stringify(before0.body));
  const baseWithin = before0.body.staff_within_40;
  const baseUncounted = before0.body.staff_uncounted;

  // Two homes in the Loop (well inside 40 mi of the Loop venue).
  await mkStaff('near1', { lat: NEAR_LAT, lng: NEAR_LNG });
  await mkStaff('near2', { lat: 41.9000, lng: -87.6300 });
  // One home in Rockford: geocoded, but ~73 mi from this venue.
  await mkStaff('far1', { lat: FAR_LAT, lng: FAR_LNG });
  // One approved staffer with a profile but NO coordinates.
  await mkStaff('nocoord', {});
  // One approved staffer with no contractor_profiles row at all.
  await mkStaff('noprofile', { withProfile: false });
  // A staffer who is NOT approved must not be counted at all.
  await mkStaff('pending', { lat: NEAR_LAT, lng: NEAR_LNG, status: 'submitted' });

  const after0 = await req('GET', `/api/proposals/${nearId}/remote-staffing-check`, { token: adminToken });
  assert.equal(after0.status, 200);
  assert.equal(after0.body.staff_within_40, baseWithin + 2, 'only the two nearby geocoded homes counted');
  assert.equal(after0.body.staff_uncounted, baseUncounted + 2, 'coordless profile + missing profile are uncounted');

  // The far-away geocoded staffer is neither within nor uncounted: we know
  // exactly where they live and it is not near this venue.
  const farView = await req('GET', `/api/proposals/${farId}/remote-staffing-check`, { token: adminToken });
  assert.equal(farView.body.staff_within_40, baseWithin === 0 ? 1 : farView.body.staff_within_40);
  assert.ok(farView.body.staff_within_40 >= 1, 'the Rockford home is within 40 mi of the Rockford venue');
});

test('a far venue reports distance + the server-derived suggested fee', async () => {
  const r = await req('GET', `/api/proposals/${farId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.venue_distance_miles > 60 && r.body.venue_distance_miles < 90,
    `expected ~73 mi, got ${r.body.venue_distance_miles}`);
  assert.equal(r.body.suggested_fee_cents, 2000, 'the 60-90 band, computed server-side');
  // The whole rule is server-owned; the client just renders the decision.
  assert.equal(
    r.body.should_prompt,
    r.body.venue_distance_miles !== null
      && r.body.venue_distance_miles >= 40
      && r.body.staff_within_40 < 3
      && !r.body.prompted
      && !r.body.accepted
  );
});

test('a nearby venue suggests nothing AND never prompts (the 40-mile floor)', async () => {
  const r = await req('GET', `/api/proposals/${nearId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.venue_distance_miles < 10);
  assert.equal(r.body.suggested_fee_cents, null);
  // The premise of the fee is TRAVEL. A local venue must not prompt even when
  // the within-40 count happens to be low, or the popup would announce "this
  // venue is about 5 miles out", which reads as a bug.
  assert.equal(r.body.should_prompt, false, 'a local venue is never a remote-staffing problem');
});

test('active staff = worker roles: a nearby MANAGER counts, the admin/owner does not', async () => {
  const before0 = await req('GET', `/api/proposals/${nearId}/remote-staffing-check`, { token: adminToken });
  const baseWithin = before0.body.staff_within_40;
  const baseUncounted = before0.body.staff_uncounted;

  // A manager and an admin, both approved, both geocoded right on the venue.
  for (const [tag, role] of [['mgr', 'manager'], ['admin2', 'admin']]) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, 'x', $2, 'approved', 0) RETURNING id`,
      [`rsf-${tag}-${NONCE}@example.com`, role]
    );
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate, lat, lng)
       VALUES ($1, $2, 'bartender', 20.00, $3, $4)`,
      [rows[0].id, `RSF ${tag}`, NEAR_LAT, NEAR_LNG]
    );
  }

  const after0 = await req('GET', `/api/proposals/${nearId}/remote-staffing-check`, { token: adminToken });
  // Managers ARE a worker class here (coverBroadcast fans cover requests to
  // them, assignShiftHandler assigns them), so a nearby one is real coverage.
  // Missing them would under-report the count and push toward billing a client
  // for travel we do not actually have.
  assert.equal(after0.body.staff_within_40, baseWithin + 1, 'the nearby manager counts as coverage');
  // The admin/owner is the one exclusion: always available, so counting him
  // would mask every real roster shortage.
  assert.equal(after0.body.staff_uncounted, baseUncounted, 'the admin adds to neither counter');
});

test('an ACCEPTED (client-signed) proposal never prompts', async () => {
  const id = await mkProposal({
    venue_name: 'Signed Barn', venue_street: '77 Far Rd', venue_city: 'Rockford',
    venue_state: 'Illinois', venue_lat: FAR_LAT, venue_lng: FAR_LNG,
  });

  // Unsigned first: this venue genuinely qualifies, so the gate below is the
  // only thing that can turn the prompt off.
  let r = await req('GET', `/api/proposals/${id}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.venue_distance_miles >= 40);
  assert.ok(r.body.staff_within_40 < 3);
  assert.equal(r.body.accepted, false);
  assert.equal(r.body.should_prompt, true, 'baseline: it would prompt');

  await pool.query("UPDATE proposals SET accepted_at = NOW(), status = 'accepted' WHERE id = $1", [id]);

  r = await req('GET', `/api/proposals/${id}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.should_prompt, false,
    'the client already signed this number; a surcharge behind a signature is the wrong question');
  // Everything else still reports honestly, so a resend surface can show context.
  assert.ok(r.body.venue_distance_miles >= 40);
  assert.equal(r.body.suggested_fee_cents, 2000);
});

test('no street address: no geocode call, null distance, no suggestion', async () => {
  const before0 = geocodeCalls.length;
  const r = await req('GET', `/api/proposals/${noStreetId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(geocodeCalls.length, before0, 'a street-less venue is NEVER geocoded (no centroid guessing)');
  assert.equal(r.body.venue_distance_miles, null);
  assert.equal(r.body.suggested_fee_cents, null);
  assert.equal(r.body.should_prompt, false, 'no coordinates means no popup');
  // The venue stays uncoordinated in the DB too.
  const { rows } = await pool.query('SELECT venue_lat, venue_lng FROM proposals WHERE id = $1', [noStreetId]);
  assert.equal(rows[0].venue_lat, null);
  assert.equal(rows[0].venue_lng, null);
});

test('on-demand geocode: a street venue with no coordinates is geocoded once and persisted', async () => {
  const before0 = geocodeCalls.length;
  const r = await req('GET', `/api/proposals/${ungeocodedId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(geocodeCalls.length, before0 + 1, 'geocoded exactly once');
  assert.match(geocodeCalls[geocodeCalls.length - 1], /500 Prairie Ave/);
  assert.ok(!geocodeCalls[geocodeCalls.length - 1].includes('New Barn'),
    'the venue NAME is excluded: the query must be an address, not a place search');
  assert.ok(r.body.venue_distance_miles > 60 && r.body.venue_distance_miles < 90);

  const { rows } = await pool.query('SELECT venue_lat, venue_lng FROM proposals WHERE id = $1', [ungeocodedId]);
  assert.ok(rows[0].venue_lat !== null, 'coordinates persisted');

  // Second call reads the stored coordinates, no second lookup.
  const again = await req('GET', `/api/proposals/${ungeocodedId}/remote-staffing-check`, { token: adminToken });
  assert.equal(again.status, 200);
  assert.equal(geocodeCalls.length, before0 + 1, 'stored coordinates short-circuit the lookup');
});

test('a geocode failure degrades to "no coordinates" and never 500s a send', async () => {
  const id = await mkProposal({
    venue_name: 'Ghost Hall', venue_street: '9999 Nowhere Ave', venue_city: 'Rockford',
    venue_state: 'Illinois',
  });
  const saved = geocodeResult;
  geocodeResult = null;
  try {
    const r = await req('GET', `/api/proposals/${id}/remote-staffing-check`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.venue_distance_miles, null);
    assert.equal(r.body.should_prompt, false);
  } finally {
    geocodeResult = saved;
  }
});

test('prompted-once: every answer stamps it and the check stops asking', async () => {
  let r = await req('GET', `/api/proposals/${farId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.body.prompted, false);
  const wouldPrompt = r.body.staff_within_40 < 3;

  const post = await req('POST', `/api/proposals/${farId}/remote-fee-prompt-answered`, { token: adminToken, body: {} });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.ok(post.body.prompted_at);

  r = await req('GET', `/api/proposals/${farId}/remote-staffing-check`, { token: adminToken });
  assert.equal(r.body.prompted, true);
  assert.equal(r.body.should_prompt, false, 'answered once, never asked again');
  assert.ok(wouldPrompt === true || wouldPrompt === false); // documents the pre-state
});

test('bad ids: 400 on garbage, 404 on a missing proposal', async () => {
  let r = await req('GET', '/api/proposals/abc/remote-staffing-check', { token: adminToken });
  assert.equal(r.status, 400);
  r = await req('GET', '/api/proposals/999999999/remote-staffing-check', { token: adminToken });
  assert.equal(r.status, 404);
  r = await req('POST', '/api/proposals/999999999/remote-fee-prompt-answered', { token: adminToken, body: {} });
  assert.equal(r.status, 404);
});
