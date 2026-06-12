require('dotenv').config();

// Route-level tests for GET /api/beo/:proposalId and /:proposalId/logo.
//
// HARNESS NOTES
// -------------
// Mirrors the hand-rolled pattern in server/routes/proposals/crud.test.js: the
// repo has no supertest/jest/mocha — every existing route test stands up a
// minimal express() app, mounts the real router, attaches the real auth
// middleware (already inside the router via beo.js's auth call), and drives the
// surface over real HTTP via node's built-in `http` module. The error handler
// mirrors server/index.js so a thrown AppError becomes the right status + JSON.
//
// Tests run against the dev database (DATABASE_URL pulled from ../../os/.env
// via the npm-test-runner's bash prefix). Every row this file inserts is
// cleaned up in after(). User emails are nonce-suffixed so stale rows from a
// crashed prior run can't collide with the unique-index on users.email.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const beoRouter = require('./beo');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let adminToken;
let staffToken;
let otherStaffToken;
let proposalId;
let drinkPlanId;
let shiftId;
let staffUserId;
let otherStaffUserId;
let adminUserId;
let clientId;
let managerStaffedId;    // manager WITH an approved shift on the proposal (assignable worker)
let managerStaffedToken;
let managerViewerId;     // manager with NO shift — pure BEO viewer
let managerViewerToken;

// Roster fixtures (§6.18 team_roster tests). Each teammate exercises a
// different branch of the display_name fallback chain in computeName().
let rosterPreferredId;   // preferred_name + applications.full_name → "Rosa M."
let rosterAppsOnlyId;    // applications only → "Diego R."
let rosterAgreementsId;  // agreements only → "Noor E."
let rosterEmailOnlyId;   // no name rows → email-local-part
let rosterDroppedId;     // dropped_at set → excluded from roster
let rosterPhoneFromCpId; // contractor_profiles.phone present → phone gating test

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ROSTER_PHONE = '+15555550199';

// applications has several NOT NULL columns — keep this minimal row reusable.
async function seedApplication(userId, fullName) {
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, why_dr_bartender)
     VALUES ($1, $2, '+15555551234', 'Chicago', 'IL', '25',
             'yes', 'Bartender', 'Test')`,
    [userId, fullName]
  );
}

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Belt-and-suspenders: purge any stale rows from a previous crashed run.
  // The unique-key on users.email will reject the inserts below if these still
  // exist with the same address.
  await pool.query("DELETE FROM users WHERE email LIKE 'beo-route-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Admin user
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-admin-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Staff user with approved shift on the test proposal
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name)
     VALUES ($1, '+15555550102', 'Test Staff')`,
    [staffUserId]
  );

  // Other staff user with NO shift — for the 403 case
  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`beo-route-other-${NONCE}@example.com`, passwordHash]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign(
    { userId: otherStaffUserId, tokenVersion: o.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Manager WITH an approved shift on the proposal (audit 3c W1: managers are a
  // worker class and can be assigned to shifts, so they must be able to ack the BEO).
  const mStaffed = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'manager', 'approved', 0) RETURNING id`,
    [`beo-route-mgr-staffed-${NONCE}@example.com`, passwordHash]
  );
  managerStaffedId = mStaffed.rows[0].id;
  managerStaffedToken = jwt.sign({ userId: managerStaffedId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // Manager with NO shift — a pure BEO viewer; must still get the clean no-op.
  const mViewer = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'manager', 'approved', 0) RETURNING id`,
    [`beo-route-mgr-viewer-${NONCE}@example.com`, passwordHash]
  );
  managerViewerId = mViewer.rows[0].id;
  managerViewerToken = jwt.sign({ userId: managerViewerId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // Client + proposal + drink_plan + shift + approved request
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551111') RETURNING id",
    [`BEO Route Test ${NONCE}`, `beo-route-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // No UNIQUE on drink_plans.proposal_id — check-then-insert to guard against
  // any future auto-create trigger or a leaked row from a prior test run.
  const existingDp = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1', [proposalId]
  );
  if (existingDp.rowCount) {
    drinkPlanId = existingDp.rows[0].id;
    await pool.query(
      "UPDATE drink_plans SET status = 'reviewed', selections = '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb WHERE id = $1",
      [drinkPlanId]
    );
  } else {
    const dp = await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, selections)
       VALUES ($1, 'reviewed', '{"signatureDrinks":["sd_1"]}'::jsonb) RETURNING id`,
      [proposalId]
    );
    drinkPlanId = dp.rows[0].id;
  }

  const sh = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, staffUserId]
  );
  // The staffed manager holds an approved request on the same shift.
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, managerStaffedId]
  );

  // ── Roster fixtures (§6.18). One user per fallback branch.
  //
  // rosterPreferred → has both contractor_profiles.preferred_name AND an
  //   applications row, exercises the "preferred + last-initial" path.
  // rosterAppsOnly  → no preferred_name, applications row only → first+last-init
  //   from applications.full_name.
  // rosterAgreements → no preferred_name, NO applications row, agreements row
  //   present → falls all the way through to agreements.full_name.
  // rosterEmailOnly → none of the above → email-local-part fallback.
  // rosterDropped   → status='approved' BUT dropped_at IS NOT NULL → must be
  //   excluded by the hybrid-state filter.
  // rosterPhoneFromCp → contractor_profiles.phone set, used to assert the
  //   §6.18 phone-gating rule (viewer must themselves be approved+active).
  async function seedTeammate({ preferredName, phone, appsName, agreementsName, emailSuffix, dropped }) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
      [`beo-route-${emailSuffix}-${NONCE}@example.com`, passwordHash]
    );
    const uid = u.rows[0].id;
    if (preferredName || phone) {
      await pool.query(
        `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
         VALUES ($1, $2, $3)`,
        [uid, preferredName || null, phone || null]
      );
    }
    if (appsName) await seedApplication(uid, appsName);
    if (agreementsName) {
      await pool.query(
        `INSERT INTO agreements (user_id, full_name) VALUES ($1, $2)`,
        [uid, agreementsName]
      );
    }
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, dropped_at)
       VALUES ($1, $2, 'approved', $3)`,
      [shiftId, uid, dropped ? new Date() : null]
    );
    return uid;
  }

  rosterPreferredId = await seedTeammate({
    preferredName: 'Rosa', phone: ROSTER_PHONE,
    appsName: 'Rosa Montoya', emailSuffix: 'roster-pref',
  });
  rosterAppsOnlyId = await seedTeammate({
    appsName: 'Diego Ruiz', emailSuffix: 'roster-apps',
  });
  rosterAgreementsId = await seedTeammate({
    agreementsName: 'Noor El-Amin', emailSuffix: 'roster-agree',
  });
  rosterEmailOnlyId = await seedTeammate({
    emailSuffix: 'roster-email',
  });
  rosterDroppedId = await seedTeammate({
    appsName: 'Dropped Person', emailSuffix: 'roster-dropped', dropped: true,
  });
  // Re-use the rosterPreferred row for phone-gating assertions — keeping a
  // dedicated id around makes the test diffs read clearly.
  rosterPhoneFromCpId = rosterPreferredId;

  // Seed an application for the existing staff user too, so the harness's
  // pre-existing "viewer is approved" path also exercises the preferred +
  // applications resolution.
  await seedApplication(staffUserId, 'Tina Staffer');

  // Minimal app: real router + AppError-aware error handler matching server/index.js.
  const app = express();
  app.use(express.json());
  app.use('/api/beo', beoRouter);
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

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  // contractor_profiles / applications / agreements all FK ON DELETE CASCADE
  // to users — cleaning the user rows below sweeps the rest.
  const userIds = [
    adminUserId, staffUserId, otherStaffUserId,
    managerStaffedId, managerViewerId,
    rosterPreferredId, rosterAppsOnlyId, rosterAgreementsId,
    rosterEmailOnlyId, rosterDroppedId,
  ].filter((id) => id !== null && id !== undefined);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

test('GET /api/beo/:proposalId > 404 for missing proposal', async () => {
  const res = await request('GET', '/api/beo/99999999', { token: staffToken });
  assert.strictEqual(res.status, 404);
});

test('GET /api/beo/:proposalId > admin always allowed', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.proposal.id, proposalId);
  assert.strictEqual(res.body.drink_plan.id, drinkPlanId);
  assert.strictEqual(res.body.viewer.is_admin, true);
  // Token MUST NOT leak — leaking it would hand a bartender client-portal access.
  assert.ok(!('token' in (res.body.drink_plan || {})), 'drink_plan.token must not appear in response');
});

test('GET /api/beo/:proposalId > staff with approved shift allowed', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.viewer.is_admin, false);
  // The viewer's shift_request must carry request_id so the staff ShiftDetail
  // page can resolve it for the drop / request-cover / emergency-drop actions
  // on a deep-link (where no nav-state shiftRow is available).
  const mine = (res.body.shift_requests || []).find((r) => r.user_id === staffUserId);
  assert.ok(mine && Number.isInteger(mine.request_id), 'shift_requests row exposes request_id');
});

test('GET /api/beo/:proposalId > staff without shift 403', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: otherStaffToken });
  assert.strictEqual(res.status, 403);
});

test('GET /api/beo/:proposalId > staff on cancelled shift 403', async () => {
  await pool.query("UPDATE shifts SET status='cancelled' WHERE id=$1", [shiftId]);
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  assert.strictEqual(res.status, 403);
  await pool.query("UPDATE shifts SET status='open' WHERE id=$1", [shiftId]);
});

// ─── POST /api/beo/:proposalId/acknowledge ─────────────────────────────────
//
// Test order is load-bearing: the 200 case sets finalized_at, the admin-noop
// case can run with finalized_at either way, and the 409 case explicitly
// re-NULLs finalized_at. Each test resets state it mutated so a re-run in a
// different order would still pass.

test('POST /api/beo/:proposalId/acknowledge > staff stamps beo_acknowledged_at when finalized', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NOW() WHERE id = $1', [drinkPlanId]);
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, true);
  assert.ok(res.body.beo_acknowledged_at);
  const { rows } = await pool.query(
    'SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
    [shiftId, staffUserId]
  );
  assert.ok(rows[0].beo_acknowledged_at);
  // Reset for the next test so the admin no-op case starts clean.
  await pool.query(
    'UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2',
    [shiftId, staffUserId]
  );
});

test('POST /api/beo/:proposalId/acknowledge > admin returns 200 with acknowledged:false', async () => {
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, false);
});

test('POST /api/beo/:proposalId/acknowledge > manager WITH an approved shift stamps beo_acknowledged_at (managers are assignable workers)', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NOW() WHERE id = $1', [drinkPlanId]);
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: managerStaffedToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, true);
  assert.ok(res.body.beo_acknowledged_at);
  const { rows } = await pool.query(
    'SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
    [shiftId, managerStaffedId]
  );
  assert.ok(rows[0].beo_acknowledged_at, 'the manager-as-staffer ack is persisted (so the nudge clears)');
  await pool.query(
    'UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2',
    [shiftId, managerStaffedId]
  );
});

test('POST /api/beo/:proposalId/acknowledge > manager with NO shift returns the clean no-op (acknowledged:false)', async () => {
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: managerViewerToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, false);
});

test('POST /api/beo/:proposalId/acknowledge > 409 when not finalized', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NULL WHERE id = $1', [drinkPlanId]);
  const res = await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: staffToken });
  assert.strictEqual(res.status, 409);
});

// ─── GET viewer classification for managers (audit 3c W1 tail) ──────────────
// A manager who is STAFFED on the event is a worker (is_admin:false) so the
// staff-portal confirm/drop/cover UI shows; their ack must round-trip. A manager
// who is only VIEWING stays an admin-style viewer (is_admin:true).

test('GET /api/beo/:proposalId > staffed manager is a worker (is_admin false) and their ack round-trips', async () => {
  await pool.query('UPDATE drink_plans SET finalized_at = NOW() WHERE id = $1', [drinkPlanId]);
  let res = await request('GET', `/api/beo/${proposalId}`, { token: managerStaffedToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.viewer.is_admin, false, 'a staffed manager is a worker, not an admin viewer');
  assert.strictEqual(res.body.viewer.is_acknowledged, false);
  await request('POST', `/api/beo/${proposalId}/acknowledge`, { token: managerStaffedToken });
  res = await request('GET', `/api/beo/${proposalId}`, { token: managerStaffedToken });
  assert.strictEqual(res.body.viewer.is_admin, false);
  assert.strictEqual(res.body.viewer.is_acknowledged, true, 'the manager ack round-trips to the GET payload');
  await pool.query('UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2', [shiftId, managerStaffedId]);
});

test('GET /api/beo/:proposalId > viewing manager (no shift) stays an admin-style viewer (is_admin true)', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: managerViewerToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.viewer.is_admin, true, 'a manager with NO shift is a viewer, not a worker');
});

// ─── team_roster (spec §6.18) ──────────────────────────────────────────────

test('GET /api/beo/:proposalId > team_roster: display_name uses preferred + last initial', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.team_roster), 'team_roster must be an array');
  const row = res.body.team_roster.find((m) => m.user_id === rosterPreferredId);
  assert.ok(row, 'expected rosterPreferred user on the team');
  // preferred="Rosa", applications.full_name="Rosa Montoya" → "Rosa M."
  assert.strictEqual(row.display_name, 'Rosa M.');
  assert.strictEqual(row.initials, 'RM');
  assert.strictEqual(row.role, 'Bartender');  // default when sr.position NULL
  assert.strictEqual(row.is_me, false);
  assert.strictEqual(row.needs_cover, false);
});

test('GET /api/beo/:proposalId > team_roster: fallback to applications.full_name when preferred missing', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterAppsOnlyId);
  assert.ok(row);
  // No preferred_name; applications.full_name="Diego Ruiz" → "Diego R."
  assert.strictEqual(row.display_name, 'Diego R.');
  assert.strictEqual(row.initials, 'DR');
});

test('GET /api/beo/:proposalId > team_roster: fallback to agreements.full_name when applications missing', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterAgreementsId);
  assert.ok(row);
  // No preferred, no applications; agreements.full_name="Noor El-Amin" → "Noor E."
  assert.strictEqual(row.display_name, 'Noor E.');
  assert.strictEqual(row.initials, 'NE');
});

test('GET /api/beo/:proposalId > team_roster: fallback to email-local-part when name rows missing', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterEmailOnlyId);
  assert.ok(row);
  // Email like beo-route-roster-email-<NONCE>@example.com → local-part as-is.
  assert.ok(row.display_name.startsWith('beo-route-roster-email'), 'display_name should be email local-part');
});

test('GET /api/beo/:proposalId > team_roster: is_me flips on own row', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const self = res.body.team_roster.find((m) => m.user_id === staffUserId);
  const other = res.body.team_roster.find((m) => m.user_id === rosterPreferredId);
  assert.ok(self, 'viewer must appear on own roster');
  assert.ok(other);
  assert.strictEqual(self.is_me, true);
  assert.strictEqual(other.is_me, false);
});

test('GET /api/beo/:proposalId > team_roster: dropped_at IS NOT NULL is excluded', async () => {
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const droppedRow = res.body.team_roster.find((m) => m.user_id === rosterDroppedId);
  assert.strictEqual(droppedRow, undefined, 'emergency-dropped staffer must not appear on roster');
});

test('GET /api/beo/:proposalId > team_roster: phone surfaces when viewer is approved', async () => {
  // staffToken is for staffUserId, who is approved+active on the proposal.
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterPhoneFromCpId);
  assert.ok(row);
  assert.strictEqual(row.phone, ROSTER_PHONE, 'phone must surface to an approved viewer');
});

test('GET /api/beo/:proposalId > team_roster: phone is null when viewer is admin (not approved as staff)', async () => {
  // Admin/manager hits the BEO via the role bypass in authorize(), but does
  // NOT satisfy the §6.18 "viewer is approved on this proposal" predicate.
  // Phones must be null to keep the gate strict — admin contact paths use
  // the existing admin UI, not the team-roster card.
  const res = await request('GET', `/api/beo/${proposalId}`, { token: adminToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterPhoneFromCpId);
  assert.ok(row);
  assert.strictEqual(row.phone, null);
});

test('GET /api/beo/:proposalId > team_roster: needs_cover flips when cover_requested_at is set', async () => {
  await pool.query(
    'UPDATE shift_requests SET cover_requested_at = NOW() WHERE shift_id = $1 AND user_id = $2',
    [shiftId, rosterPreferredId]
  );
  const res = await request('GET', `/api/beo/${proposalId}`, { token: staffToken });
  const row = res.body.team_roster.find((m) => m.user_id === rosterPreferredId);
  assert.ok(row);
  assert.strictEqual(row.needs_cover, true);
  // Reset so other tests on this row stay deterministic.
  await pool.query(
    'UPDATE shift_requests SET cover_requested_at = NULL WHERE shift_id = $1 AND user_id = $2',
    [shiftId, rosterPreferredId]
  );
});
