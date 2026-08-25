require('dotenv').config();

// Route-level tests for the shift-keyed staff event-details surface:
//   GET /api/shifts/:shiftId/event-details
//   GET /api/shifts/:shiftId/menu-print
//
// HARNESS NOTES
// -------------
// Mirrors server/routes/beo.test.js: no supertest/jest in this repo, so we
// stand up a minimal express() app, mount the real router (auth middleware
// lives inside it), and drive it over real HTTP. The error handler mirrors
// server/index.js so a thrown AppError becomes the right status + JSON.
//
// Runs against the dev database. Every row inserted here is removed in after();
// user emails are nonce-suffixed so a crashed prior run cannot collide with the
// unique index on users.email.
//
// The menu-print 200 path is deliberately NOT asserted: it proxies live R2
// through getSignedUrl + fetch. Auth and the not-found paths are covered here;
// a real download is covered by the manual check in the plan.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const eventDetailsRouter = require('./eventDetails');

let server;
let baseUrl;
let adminToken;
let assignedToken;
let browsingToken;
let unonboardedToken;
let managerStaffedToken;
let adminUserId;
let assignedUserId;
let browsingUserId;
let unonboardedUserId;
let managerStaffedUserId;
let clientId;
let proposalId;
let shiftId;
let cancelledShiftId;
let manualShiftId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'evdet-route-%'");
  const passwordHash = await bcrypt.hash('x', 4);

  async function mkUser(role, suffix, onboardingStatus = 'approved') {
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, $2, $3, $4, 0) RETURNING id, token_version`,
      [`evdet-route-${suffix}-${NONCE}@example.com`, passwordHash, role, onboardingStatus]
    );
    const id = r.rows[0].id;
    const token = jwt.sign(
      { userId: id, tokenVersion: r.rows[0].token_version },
      process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    return { id, token };
  }

  const admin = await mkUser('admin', 'admin');
  adminUserId = admin.id; adminToken = admin.token;
  const assigned = await mkUser('staff', 'assigned');
  assignedUserId = assigned.id; assignedToken = assigned.token;
  const browsing = await mkUser('staff', 'browsing');
  browsingUserId = browsing.id; browsingToken = browsing.token;
  // Mirrors what POST /api/auth/register actually creates: a staff row that
  // has NOT completed onboarding. Passes auth(), must fail requireOnboarded.
  const unonboarded = await mkUser('staff', 'unonboarded', 'in_progress');
  unonboardedUserId = unonboarded.id; unonboardedToken = unonboarded.token;
  const mgr = await mkUser('manager', 'mgr');
  managerStaffedUserId = mgr.id; managerStaffedToken = mgr.token;

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555552222') RETURNING id",
    [`EvDet Route Test ${NONCE}`, `evdet-route-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 21, '17:00', 4, 'America/Chicago', 'deposit_paid', 'wedding')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, status, proposal_id, equipment_required, supply_run_required,
                         positions_needed)
     VALUES (CURRENT_DATE + 21, 'open', $1, '["Bar kit","Cooler"]', true, '["Bartender","Bartender"]')
     RETURNING id`,
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')",
    [shiftId, assignedUserId]
  );

  // A cancelled shift on the same proposal: must read as not-found.
  const cs = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 21, 'cancelled', $1) RETURNING id",
    [proposalId]
  );
  cancelledShiftId = cs.rows[0].id;

  // A legacy manual shift with NO proposal_id.
  const ms = await pool.query(
    `INSERT INTO shifts (event_date, status, client_name, location, equipment_required)
     VALUES (CURRENT_DATE + 14, 'open', $1, 'Somewhere', '["Bar kit"]') RETURNING id`,
    [`Manual Client ${NONCE}`]
  );
  manualShiftId = ms.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/shifts', eventDetailsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [[shiftId, manualShiftId].filter(Boolean)]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [[shiftId, cancelledShiftId, manualShiftId].filter(Boolean)]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])',
    [[adminUserId, assignedUserId, browsingUserId, unonboardedUserId, managerStaffedUserId].filter((v) => v !== null && v !== undefined)]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── GET /:shiftId/event-details ───────────────────────────────────────────

test('event-details: a browsing staffer (no request) gets the full brief, contact redacted', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: browsingToken });
  assert.strictEqual(res.status, 200, 'browsing staff are no longer gated out');
  assert.strictEqual(res.body.shift_id, shiftId);
  assert.strictEqual(res.body.client.phone, null);
  assert.strictEqual(res.body.viewer.is_assigned, false);
  // The brief data the staffer needs to decide whether to request.
  const s = res.body.shifts.find((x) => x.id === shiftId);
  assert.ok(s, 'the addressed shift is in shifts[]');
  assert.strictEqual(s.supply_run_required, true);
  assert.ok(String(s.equipment_required).includes('Cooler'));
  assert.strictEqual(s.my_request_id, null, 'browsing staffer holds no request');
});

test('event-details: an assigned staffer sees contact + is_assigned + their own request', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: assignedToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.client.phone, 'string');
  assert.strictEqual(res.body.viewer.is_assigned, true);
  const s = res.body.shifts.find((x) => x.id === shiftId);
  assert.ok(Number.isInteger(s.my_request_id));
  assert.strictEqual(s.my_request_status, 'approved');
});

test('event-details: teammate phones stay hidden from a browsing staffer', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: browsingToken });
  assert.ok((res.body.team_roster || []).length > 0, 'roster is visible');
  assert.ok(res.body.team_roster.every((r) => r.phone === null), 'phones are not harvestable');
});

test('event-details: cancelled shift reads as not found', async () => {
  const res = await request('GET', `/api/shifts/${cancelledShiftId}/event-details`, { token: assignedToken });
  assert.strictEqual(res.status, 404);
});

test('event-details: unknown and non-numeric shift ids 404 (never a 22P02 500)', async () => {
  const missing = await request('GET', '/api/shifts/99999999/event-details', { token: assignedToken });
  assert.strictEqual(missing.status, 404);
  const bogus = await request('GET', '/api/shifts/abc/event-details', { token: assignedToken });
  assert.strictEqual(bogus.status, 404);
});

test('event-details: legacy shift with no proposal returns a shift-only brief', async () => {
  const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: browsingToken });
  assert.strictEqual(res.status, 200, 'a requestable manual shift must still render');
  assert.strictEqual(res.body.proposal, null);
  // menu_print keeps the SAME shape as the proposal path so a consumer never
  // has to branch on null for this key.
  assert.deepStrictEqual(res.body.menu_print, { status: 'not_required' });
  assert.strictEqual(res.body.shifts.length, 1);
  assert.strictEqual(res.body.shifts[0].id, manualShiftId);
  assert.strictEqual(res.body.viewer.is_assigned, false);
});

// The legacy branch builds `viewer` by hand instead of going through the shared
// builder, so it can drift from it. A manager STAFFED on the event is a worker,
// not an admin viewer (audit 3c W1): is_admin and is_assigned must never both
// be true, or the client renders the admin view to someone working the shift.
test('event-details: a staffed manager on a manual shift is a worker, not an admin viewer', async () => {
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')",
    [manualShiftId, managerStaffedUserId]
  );
  try {
    const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: managerStaffedToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.viewer.is_assigned, true);
    assert.strictEqual(res.body.viewer.is_admin, false, 'a staffed manager is a worker on the legacy path too');
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
      [manualShiftId, managerStaffedUserId]);
  }
});

test('event-details: a manager who is only viewing stays an admin viewer', async () => {
  const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: managerStaffedToken });
  assert.strictEqual(res.body.viewer.is_admin, true);
  assert.strictEqual(res.body.viewer.is_assigned, false);
});

// REGRESSION (fix list 2026-08-25). The legacy branch used to hardcode
// approved_by_role:{} and cover_requested_at:null. The staff page derives
// `remaining` and `fullyStaffed` from approved_by_role (ShiftDetail.js), so an
// empty object made every role read unfilled: a full manual shift kept offering
// "Request this shift" instead of the waitlist path, and coverNeeded — read
// straight off cover_requested_at — could never be true.
test('event-details: a manual shift reports its real per-role fill', async () => {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, dropped_at)
     VALUES ($1, $2, 'approved', 'Bartender', NULL),
            ($1, $3, 'approved', 'Barback', NULL),
            ($1, $4, 'approved', 'Bartender', NOW())`,
    [manualShiftId, assignedUserId, adminUserId, browsingUserId]
  );
  try {
    const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: assignedToken });
    assert.strictEqual(res.status, 200);
    const s = res.body.shifts[0];
    // The dropped approved row is NOT a filled slot: the names on the roster and
    // the counts beside them have to agree, so both filter the same way.
    assert.deepStrictEqual(s.approved_by_role, { Bartender: 1, Barback: 1 });
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = ANY($2::int[])',
      [manualShiftId, [assignedUserId, adminUserId, browsingUserId]]);
  }
});

test('event-details: a manual shift surfaces an open cover request', async () => {
  const r = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, cover_requested_at)
     VALUES ($1, $2, 'approved', 'Bartender', NOW()) RETURNING id`,
    [manualShiftId, assignedUserId]
  );
  try {
    const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: browsingToken });
    assert.strictEqual(res.status, 200);
    const s = res.body.shifts[0];
    assert.ok(s.cover_requested_at, 'coverNeeded on the staff page is read straight off this field');
    // No contractor_profiles row for this fixture user, so the initial chain
    // (display_name -> preferred_name -> '?') lands on the fallback.
    assert.strictEqual(s.cover_for_first_initial, '?');
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE id = $1', [r.rows[0].id]);
  }
});

test('event-details: unauthenticated request is rejected', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`);
  assert.ok(res.status === 401 || res.status === 403, `expected auth rejection, got ${res.status}`);
});

// REGRESSION (lane-1 review fleet, 2026-07-22). POST /api/auth/register is
// public and mints a live JWT for an `onboarding_status='in_progress'` staff
// row, and auth() only rejects deactivated/rejected/suspended. Ungating the
// read to "any authenticated user" therefore exposed every event on the books
// to anyone who signed up. requireOnboarded is the gate that makes
// "authenticated" mean "actually one of our staff" — it must never come off.
test('event-details: a self-registered, not-yet-onboarded account is refused', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: unonboardedToken });
  assert.strictEqual(res.status, 403, 'in_progress onboarding cannot read event details');
  assert.strictEqual(res.body.proposal, undefined, 'no payload leaked alongside the rejection');
});

test('event-details: the legacy proposal-less branch is gated too', async () => {
  // This branch returns BEFORE authorizeEventRead, so it needs the route-level
  // gate. Without it, manual shifts were a second, independent disclosure path.
  const res = await request('GET', `/api/shifts/${manualShiftId}/event-details`, { token: unonboardedToken });
  assert.strictEqual(res.status, 403);
});

test('menu-print: a not-yet-onboarded account is refused', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/menu-print`, { token: unonboardedToken });
  assert.strictEqual(res.status, 403);
});

test('event-details: no client-money fields ride along in the staff payload', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: assignedToken });
  const raw = JSON.stringify(res.body);
  for (const banned of ['total_price', 'amount_paid', 'deposit_amount', 'pricing_snapshot',
                        'line_total', 'extra_bartender_hourly', '"rate"']) {
    assert.ok(!raw.includes(banned), `staff payload must not carry ${banned}`);
  }
  // Addons still tell the crew WHAT was bought.
  assert.ok(Array.isArray(res.body.addons));
});

// ─── GET /:shiftId/menu-print ──────────────────────────────────────────────

test('menu-print: 404 when no file is posted', async () => {
  const res = await request('GET', `/api/shifts/${shiftId}/menu-print`, { token: assignedToken });
  assert.strictEqual(res.status, 404);
});

test('menu-print: a browsing staffer is refused even when a file exists', async () => {
  await pool.query("UPDATE proposals SET menu_print_key = $2 WHERE id = $1",
    [proposalId, `menu-print/${proposalId}/fixture.pdf`]);
  try {
    const res = await request('GET', `/api/shifts/${shiftId}/menu-print`, { token: browsingToken });
    assert.strictEqual(res.status, 403, 'download is an assigned-staff action');
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
});

test('menu-print: a tampered key outside the menu-print prefix is refused', async () => {
  await pool.query("UPDATE proposals SET menu_print_key = 'drink-plan-logos/secret.png' WHERE id = $1", [proposalId]);
  try {
    const res = await request('GET', `/api/shifts/${shiftId}/menu-print`, { token: assignedToken });
    assert.strictEqual(res.status, 404, 'path-traversal guard holds');
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
});

test('menu-print: legacy proposal-less shift has no menu file', async () => {
  const res = await request('GET', `/api/shifts/${manualShiftId}/menu-print`, { token: assignedToken });
  assert.strictEqual(res.status, 404);
});
