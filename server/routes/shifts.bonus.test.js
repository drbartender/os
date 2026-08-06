require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * Out-of-Area Bonus: the knob, the lock lifecycle, the distances, and the
 * duty-line derivation (spec 2026-08-06-contractor-duty-pay-design.md §6).
 *
 * Harness mirrors server/routes/admin/payrollDuty.test.js and
 * server/routes/staffShiftActions.test.js: express over real HTTP, hand-signed
 * JWTs, no supertest. Both shift routers mount at /api/shifts in the same order
 * as server/index.js (routes/shifts first, staffShiftActions after) so the
 * drop endpoints resolve exactly the way they do in production.
 *
 * SHARED DEV DB DISCIPLINE: this suite owns the far-past pay-period week
 * Tue 2018-10-02 .. Mon 2018-10-08 and every fixture email matches
 * 'ooa-%@example.com', so it cannot collide with another suite's rows.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { accruePayoutsForProposal } = require('../utils/payrollAccrual');
const { suggestOutOfAreaCents } = require('../utils/serviceArea');
const shiftsRouter = require('./shifts');
const staffShiftActionsRouter = require('./staffShiftActions');
const adminCoverSwapsRouter = require('./adminCoverSwaps');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.bonus.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = "email LIKE 'ooa-%@example.com'";

// Rockford, IL: ~73 miles from the Pilsen home base, so the $20 band.
const VENUE_LAT = 42.2711;
const VENUE_LNG = -89.0940;
// Downtown Chicago home address for the geocoded staffer.
const HOME_LAT = 41.8781;
const HOME_LNG = -87.6298;

let server, baseUrl;
let adminId, adminToken;
let mgrId, mgrToken;          // can_staff manager
let plainMgrId, plainMgrToken; // manager WITHOUT can_staff
let aId, aToken, bId, bToken, cId;
let clientId, futureProposalId, pastProposalId, periodId;
// Set by the derivation test, reused by the roster-change test that follows it.
let pastShiftId;

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
  const props = `(SELECT id FROM proposals WHERE event_type = 'ooa-fixture')`;
  const shiftIds = `(SELECT id FROM shifts WHERE proposal_id IN ${props})`;
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN ${uids}`);
  await pool.query(`DELETE FROM duty_attributions WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id IN ${shiftIds}`);
  await pool.query(`DELETE FROM shift_requests WHERE shift_id IN ${shiftIds}`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${uids})`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${uids}`);
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id IN ${props}`);
  await pool.query(`UPDATE shifts SET out_of_area_attached_by = NULL, out_of_area_locked_user_id = NULL WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'ooa-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'ooa-%@example.com'`);
  await pool.query(
    `DELETE FROM pay_periods WHERE start_date = '2018-10-02'
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`
  );
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN ${uids}`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE ${EMAIL_LIKE}`);
}

async function mkUser(tag, role, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, can_staff)
     VALUES ($1, 'x', $2, 'approved', 0, $3) RETURNING id`,
    [`ooa-${tag}-${NONCE}@example.com`, role, extra.canStaff === true]
  );
  return rows[0].id;
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/** Future shift (28 days out) so clean-drop's >=14d window is satisfied. */
async function mkFutureShift({ lat = null, lng = null, bonusCents = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location,
                         client_name, positions_needed, lat, lng, out_of_area_bonus_cents)
     VALUES (CURRENT_DATE + 28, '18:00', '22:00', 'open', $1, 'Far Venue',
             $2, '["Bartender","Barback"]'::jsonb, $3, $4, $5)
     RETURNING id`,
    [futureProposalId, `OOA ${NONCE}`, lat, lng, bonusCents]
  );
  return rows[0].id;
}

async function mkPending(shiftId, userId, roles = ['Bartender']) {
  const { rows } = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, 'pending', NULL, $3) RETURNING id`,
    [shiftId, userId, JSON.stringify(roles)]
  );
  return rows[0].id;
}

async function shiftRow(id) {
  const { rows } = await pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
  return rows[0];
}

before(async () => {
  await cleanup();

  adminId = await mkUser('admin', 'admin');
  adminToken = tokenFor(adminId);
  mgrId = await mkUser('mgr', 'manager', { canStaff: true });
  mgrToken = tokenFor(mgrId);
  plainMgrId = await mkUser('mgr2', 'manager');
  plainMgrToken = tokenFor(plainMgrId);
  aId = await mkUser('a', 'staff');
  aToken = tokenFor(aId);
  bId = await mkUser('b', 'staff');
  bToken = tokenFor(bId);
  cId = await mkUser('c', 'staff');

  // A has a geocoded home; B deliberately has none (NULL-coord distance case).
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate, lat, lng)
     VALUES ($1, 'Ada', 'bartender', 20.00, $2, $3)`,
    [aId, HOME_LAT, HOME_LNG]
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Bo', 'bartender', 20.00)`,
    [bId]
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate, lat, lng)
     VALUES ($1, 'Cy', 'barback', 20.00, $2, $3)`,
    [cId, HOME_LAT, HOME_LNG]
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`OOA ${NONCE}`, `ooa-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const fp = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 28, '18:00', 4, 'America/Chicago', 'confirmed', 'ooa-fixture', 0, 0, '{"addons":[]}')
     RETURNING id`,
    [clientId]
  );
  futureProposalId = fp.rows[0].id;

  // Far-past COMPLETED + funded proposal for the derivation assertion.
  const pp = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES ($1, '2018-10-03', '6:00 PM', 4, 'America/Chicago', 'completed', 'ooa-fixture', 500, 500, 0, '{"addons":[]}')
     RETURNING id`,
    [clientId]
  );
  pastProposalId = pp.rows[0].id;

  const per = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2018-10-02','2018-10-08','2018-10-09','open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  );
  periodId = per.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/shifts', staffShiftActionsRouter);
  app.use('/api/admin', adminCoverSwapsRouter);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error('[ooa harness] unhandled:', err);
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

// ─── Bands ────────────────────────────────────────────────────────

test('bands: the suggestion table is server-side and half-open', () => {
  assert.equal(suggestOutOfAreaCents(39.9), null, 'under 40 is not out of area');
  assert.equal(suggestOutOfAreaCents(40), 1000);
  assert.equal(suggestOutOfAreaCents(60), 2000);
  assert.equal(suggestOutOfAreaCents(90), 3500);
  assert.equal(suggestOutOfAreaCents(120), null, 'beyond 120 is a custom call');
  assert.equal(suggestOutOfAreaCents(null), null);
});

// ─── Access ───────────────────────────────────────────────────────

test('access: staff and a manager without can_staff are refused; can_staff manager is allowed', async () => {
  const shiftId = await mkFutureShift();
  let r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: aToken, body: { amount_cents: 1000 } });
  assert.equal(r.status, 403, 'plain staff cannot attach money');
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: plainMgrToken, body: { amount_cents: 1000 } });
  assert.equal(r.status, 403, 'a manager without can_staff is not a staffing surface');
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: mgrToken, body: { amount_cents: 1000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number((await shiftRow(shiftId)).out_of_area_bonus_cents), 1000);
});

// ─── Set / edit / validation ──────────────────────────────────────

test('set and edit under the cap; attached_by/at stamped; clear returns to NULL', async () => {
  const shiftId = await mkFutureShift();
  let r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 2000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let row = await shiftRow(shiftId);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000);
  assert.equal(row.out_of_area_attached_by, adminId);
  assert.ok(row.out_of_area_attached_at, 'attached_at stamped');
  assert.equal(row.out_of_area_locked_at, null, 'attaching does not lock');

  // Edit freely before any approval, in both directions.
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 3500 } });
  assert.equal(r.status, 200);
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 500 } });
  assert.equal(r.status, 200, 'unlocked reduce is fine');

  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: null } });
  assert.equal(r.status, 200);
  row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_bonus_cents, null);
  assert.equal(row.out_of_area_attached_by, null);
  assert.equal(row.out_of_area_attached_at, null);
});

test('validation: over-cap, zero, negative, and non-integer are 400s', async () => {
  const shiftId = await mkFutureShift();
  for (const bad of [25001, 100000, 0, -100, 12.5, 'lots']) {
    const r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: bad } });
    assert.equal(r.status, 400, `amount_cents=${bad} must 400`);
  }
  // The cap boundary itself is allowed.
  const ok = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 25000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const missing = await req('PATCH', `/api/shifts/999999999/out-of-area`, { token: adminToken, body: { amount_cents: 1000 } });
  assert.equal(missing.status, 404);
});

test('every mutation writes an audit row', async () => {
  const { rows } = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'shift_out_of_area_set' ORDER BY id`,
    [adminId]
  );
  assert.ok(rows.length >= 3, `expected audit rows, got ${rows.length}`);
  assert.ok(rows.some((r) => r.metadata && r.metadata.to_cents === 25000));
});

// ─── Lock lifecycle ───────────────────────────────────────────────

test('approval stamps the lock; a locked bonus refuses reduce AND clear but accepts a raise', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 2000 });
  const reqId = await mkPending(shiftId, aId, ['Bartender']);

  let r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  let row = await shiftRow(shiftId);
  assert.ok(row.out_of_area_locked_at, 'approval locked the bonus');
  assert.equal(row.out_of_area_locked_user_id, aId, 'locked to the approved staffer');

  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 1000 } });
  assert.equal(r.status, 409, 'a locked bonus can never be reduced');
  // The message is surfaced verbatim in the knob's inline error, so it reads as
  // a sentence; `code` is the stable machine-readable contract.
  assert.equal(r.body.code, 'bonus_locked');
  assert.match(r.body.error, /locked to an approved staffer/);
  assert.ok(!r.body.error.includes('—'), 'no em dashes in client-facing copy');

  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: null } });
  assert.equal(r.status, 409, 'a locked bonus can never be cleared');

  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 3500 } });
  assert.equal(r.status, 200, 'a raise is always allowed');
  row = await shiftRow(shiftId);
  assert.equal(Number(row.out_of_area_bonus_cents), 3500);
  assert.equal(row.out_of_area_locked_user_id, aId, 'a raise does not re-home the lock');

  // Same amount is a no-op write, not a reduce.
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 3500 } });
  assert.equal(r.status, 200);
});

test('a second approval on the same shift does not steal an existing lock', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 1000 });
  const r1 = await mkPending(shiftId, aId, ['Bartender']);
  const r2 = await mkPending(shiftId, cId, ['Barback']);
  await req('PUT', `/api/shifts/requests/${r1}`, { token: adminToken, body: { status: 'approved' } });
  await req('PUT', `/api/shifts/requests/${r2}`, { token: adminToken, body: { status: 'approved' } });
  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, aId, 'first approval owns the bonus');
});

test('assign path locks too (POST /shifts/:id/assign)', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 1500 });
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, {
    token: adminToken, body: { user_id: bId, position: 'Bartender' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, bId);
});

test('clean drop releases the lock and KEEPS the amount; re-approval re-locks to the new staffer', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 2000 });
  const aReq = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${aReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  const drop = await req('POST', `/api/shifts/requests/${aReq}/drop`, { token: aToken, body: {} });
  assert.equal(drop.status, 200, JSON.stringify(drop.body));

  let row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null, 'drop released the lock');
  assert.equal(row.out_of_area_locked_user_id, null);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000, 'the amount re-arms, it is not cleared');

  // Now the bonus is editable again.
  const lower = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 1000 } });
  assert.equal(lower.status, 200, 'an unlocked bonus is editable again');

  const bReq = await mkPending(shiftId, bId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${bReq}`, { token: adminToken, body: { status: 'approved' } });
  row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, bId, 're-approval re-locks to the NEW staffer');
  assert.equal(Number(row.out_of_area_bonus_cents), 1000);
});

test('emergency drop releases the lock too (status stays approved, dropped_at is set)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location,
                         client_name, positions_needed, out_of_area_bonus_cents)
     VALUES (CURRENT_DATE + 1, '18:00', '22:00', 'open', $1, 'Far Venue',
             $2, '["Bartender"]'::jsonb, 2000)
     RETURNING id`,
    [futureProposalId, `OOA ${NONCE}`]
  );
  const shiftId = rows[0].id;
  const reqId = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  const r = await req('POST', `/api/shifts/requests/${reqId}/emergency-drop`, {
    token: aToken, body: { reason: 'car broke down on the way' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000);
});

/**
 * Cover swap: the lock move lives inside applyCoverCascade, so BOTH approval
 * surfaces get it. Seeds a shift whose bonus is locked to A, has A requesting
 * cover, and has B's claim row pointing at A via replaced_by_request_id.
 */
async function seedCoverSwap() {
  const shiftId = await mkFutureShift({ bonusCents: 2000 });
  const aReq = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${aReq}`, { token: adminToken, body: { status: 'approved' } });
  await pool.query('UPDATE shift_requests SET cover_requested_at = NOW() WHERE id = $1', [aReq]);
  const { rows } = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, replaced_by_request_id)
     VALUES ($1, $2, 'pending', 'Bartender', $3) RETURNING id`,
    [shiftId, bId, aReq]
  );
  return { shiftId, aReq, bReq: rows[0].id };
}

test('cover swap via the staffing dashboard moves the lock from the covered staffer to the claimer', async () => {
  const { shiftId, bReq } = await seedCoverSwap();
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  const r = await req('PUT', `/api/shifts/requests/${bReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, bId, 'the claimer now holds the bonus');
  assert.ok(row.out_of_area_locked_at, 'still locked');
  assert.equal(Number(row.out_of_area_bonus_cents), 2000, 'amount untouched by the swap');
});

test('cover swap via the ADMIN EMAIL one-click link moves the lock identically', async () => {
  const { shiftId, aReq, bReq } = await seedCoverSwap();
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  // Same payload shape adminCoverSwaps.js reads off the signed URL segment.
  const swapToken = jwt.sign(
    { original_request_id: aReq, new_request_id: bReq, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const r = await req('POST', `/api/admin/cover-swaps/${swapToken}`, { token: adminToken, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved');

  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, bId,
    'the email approver must move the bonus too, or it pays someone who did not work');
  assert.ok(row.out_of_area_locked_at);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000);
  // The covered staffer is off the shift and holds nothing.
  const aRow = await pool.query('SELECT status, dropped_at FROM shift_requests WHERE id = $1', [aReq]);
  assert.equal(aRow.rows[0].status, 'denied');
  assert.ok(aRow.rows[0].dropped_at);
});

test('DELETE /shifts/requests/:id (the ShiftDrawer Remove button) releases the lock', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 2000 });
  const aReq = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${aReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  // The request row is DELETED here, so a leaked lock would point at nothing.
  const del = await req('DELETE', `/api/shifts/requests/${aReq}`, { token: adminToken });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  let row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null, 'remove released the lock');
  assert.equal(row.out_of_area_locked_user_id, null);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000, 'amount re-arms, never cleared');

  // Re-arming is real: the next approval takes the bonus.
  const bReq = await mkPending(shiftId, bId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${bReq}`, { token: adminToken, body: { status: 'approved' } });
  row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_user_id, bId, 're-stamped to the replacement');
});

test('cancel-or-unassign (unassign mode) releases only THAT staffer, cancel mode releases outright', async () => {
  // Unassign: A holds the bonus, C is a teammate. Unassigning C must not touch it.
  const shiftId = await mkFutureShift({ bonusCents: 2000 });
  const aReq = await mkPending(shiftId, aId, ['Bartender']);
  const cReq = await mkPending(shiftId, cId, ['Barback']);
  await req('PUT', `/api/shifts/requests/${aReq}`, { token: adminToken, body: { status: 'approved' } });
  await req('PUT', `/api/shifts/requests/${cReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  let r = await req('POST', `/api/shifts/${shiftId}/cancel-or-unassign`, {
    token: adminToken, body: { mode: 'unassign', user_id: cId },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId,
    "a teammate's unassign must not release someone else's bonus");

  // Now unassign the actual holder.
  r = await req('POST', `/api/shifts/${shiftId}/cancel-or-unassign`, {
    token: adminToken, body: { mode: 'unassign', user_id: aId },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null, 'the holder leaving releases the lock');
  assert.equal(Number(row.out_of_area_bonus_cents), 2000);

  const bReq = await mkPending(shiftId, bId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${bReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, bId, 're-approval re-stamps');

  // Cancel mode denies everyone, so the release is unscoped.
  r = await req('POST', `/api/shifts/${shiftId}/cancel-or-unassign`, {
    token: adminToken, body: { mode: 'cancel' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null, 'cancelling the shift releases the bonus');
  assert.equal(row.out_of_area_locked_user_id, null);
  assert.equal(Number(row.out_of_area_bonus_cents), 2000);
});

test('an approved holder RE-REQUESTING flips to pending and releases the lock', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 1500 });
  const aReq = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${aReq}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);

  // Same staffer re-submits with different ranked roles; the upsert forces
  // status back to 'pending', so they are off the roster.
  const r = await req('POST', `/api/shifts/${shiftId}/request`, {
    token: aToken, body: { requested_positions: ['Bartender', 'Barback'] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null, 'a pending request cannot hold the bonus');
  assert.equal(Number(row.out_of_area_bonus_cents), 1500);
});

test('attaching a bonus to an ALREADY-staffed shift: one worker auto-locks, two warn', async () => {
  // Exactly one approved worker: unambiguous, so the knob locks it on the spot.
  const soloShift = await mkFutureShift();
  const soloReq = await mkPending(soloShift, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${soloReq}`, { token: adminToken, body: { status: 'approved' } });
  let r = await req('PATCH', `/api/shifts/${soloShift}/out-of-area`, { token: adminToken, body: { amount_cents: 2000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shift.out_of_area_locked_user_id, aId, 'auto-locked to the only approved staffer');
  assert.ok(r.body.shift.out_of_area_locked_at);
  assert.equal(r.body.shift.unlocked_warning, false);
  assert.equal((await shiftRow(soloShift)).out_of_area_locked_user_id, aId);
  // And it is a REAL lock: reducing it now is refused.
  r = await req('PATCH', `/api/shifts/${soloShift}/out-of-area`, { token: adminToken, body: { amount_cents: 1000 } });
  assert.equal(r.status, 409);

  // Two approved workers: ambiguous, so no auto-lock and an explicit warning.
  const duoShift = await mkFutureShift();
  const r1 = await mkPending(duoShift, aId, ['Bartender']);
  const r2 = await mkPending(duoShift, cId, ['Barback']);
  await req('PUT', `/api/shifts/requests/${r1}`, { token: adminToken, body: { status: 'approved' } });
  await req('PUT', `/api/shifts/requests/${r2}`, { token: adminToken, body: { status: 'approved' } });
  r = await req('PATCH', `/api/shifts/${duoShift}/out-of-area`, { token: adminToken, body: { amount_cents: 2000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shift.out_of_area_locked_at, null, 'two candidates is a judgment call, not a guess');
  assert.equal(r.body.shift.unlocked_warning, true, 'money attached with nobody holding it must be visible');

  // The warning survives a page reload, not just the PATCH response.
  const list = await req('GET', `/api/shifts/by-proposal/${futureProposalId}`, { token: adminToken });
  const listed = list.body.find((x) => x.id === duoShift);
  assert.equal(listed.unlocked_warning, true);
  const detail = await req('GET', `/api/shifts/detail/${duoShift}`, { token: adminToken });
  assert.equal(detail.body.shift.unlocked_warning, true);

  // An unstaffed shift with a bonus is the NORMAL pre-event case: no warning.
  const emptyShift = await mkFutureShift();
  r = await req('PATCH', `/api/shifts/${emptyShift}/out-of-area`, { token: adminToken, body: { amount_cents: 2000 } });
  assert.equal(r.body.shift.unlocked_warning, false, 'nobody approved yet is not a problem');
});

test('admin denying an approved staffer releases the lock', async () => {
  const shiftId = await mkFutureShift({ bonusCents: 1000 });
  const reqId = await mkPending(shiftId, aId, ['Bartender']);
  await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal((await shiftRow(shiftId)).out_of_area_locked_user_id, aId);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'denied' } });
  assert.equal(r.status, 200);
  const row = await shiftRow(shiftId);
  assert.equal(row.out_of_area_locked_at, null);
  assert.equal(Number(row.out_of_area_bonus_cents), 1000, 'amount survives the deny');
});

// ─── Distances + suggestion on the read surfaces ──────────────────

test('GET /shifts/detail/:id: server-derived suggestion + per-requester home distance', async () => {
  const shiftId = await mkFutureShift({ lat: VENUE_LAT, lng: VENUE_LNG });
  await mkPending(shiftId, aId, ['Bartender']); // geocoded home
  await mkPending(shiftId, bId, ['Bartender']); // NO home coordinates

  const r = await req('GET', `/api/shifts/detail/${shiftId}`, { token: mgrToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.shift.venue_distance_miles > 60 && r.body.shift.venue_distance_miles < 90);
  assert.equal(r.body.shift.suggested_bonus_cents, 2000, 'the band comes off the payload, never the client');

  const byUser = new Map(r.body.requests.map((x) => [x.user_id, x]));
  const withHome = byUser.get(aId);
  const noHome = byUser.get(bId);
  assert.ok(withHome.home_distance_miles > 60 && withHome.home_distance_miles < 90);
  assert.equal(noHome.home_distance_miles, null, 'a staffer with no geocoded home has no distance');
  // Derived distance only: a home address never rides the payload.
  for (const row of r.body.requests) {
    assert.equal(row.staff_lat, undefined);
    assert.equal(row.staff_lng, undefined);
  }
});

test('GET /shifts/detail/:id: a venue with no coordinates suggests nothing (never a guess)', async () => {
  const shiftId = await mkFutureShift();
  await mkPending(shiftId, aId, ['Bartender']);
  const r = await req('GET', `/api/shifts/detail/${shiftId}`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.shift.venue_distance_miles, null);
  assert.equal(r.body.shift.suggested_bonus_cents, null);
  assert.equal(r.body.requests[0].home_distance_miles, null, 'no venue coords means no distance either');
});

test('GET /shifts/by-proposal/:id: requesters carry distances and the shift carries the suggestion', async () => {
  const shiftId = await mkFutureShift({ lat: VENUE_LAT, lng: VENUE_LNG, bonusCents: 2000 });
  await mkPending(shiftId, aId, ['Bartender']);
  await mkPending(shiftId, bId, ['Bartender']);

  const r = await req('GET', `/api/shifts/by-proposal/${futureProposalId}`, { token: mgrToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.find((x) => x.id === shiftId);
  assert.ok(s, 'shift present');
  assert.equal(s.suggested_bonus_cents, 2000);
  assert.equal(Number(s.out_of_area_bonus_cents), 2000);
  const reqA = s.requesters.find((x) => x.user_id === aId);
  const reqB = s.requesters.find((x) => x.user_id === bId);
  assert.ok(reqA.home_distance_miles > 60 && reqA.home_distance_miles < 90);
  assert.equal(reqB.home_distance_miles, null);
  assert.equal(reqA.staff_lat, undefined, 'raw home coordinates are stripped');
  assert.equal(reqA.name, 'Ada');
});

// ─── Derivation ───────────────────────────────────────────────────

test('derivation: on a completed funded event the LOCKED user gets the out_of_area duty line', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed,
                         out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id)
     VALUES ('2018-10-03', '6:00 PM', 'open', $1, '["Bartender","Bartender"]'::jsonb, 3500, NOW(), $2)
     RETURNING id`,
    [pastProposalId, aId]
  );
  const shiftId = s.rows[0].id;
  pastShiftId = shiftId;
  // Both work the event; only the locked one is owed the bonus.
  for (const uid of [aId, bId]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
      [shiftId, uid]
    );
  }

  await accruePayoutsForProposal(pastProposalId);

  const lines = await pool.query(
    `SELECT d.contractor_id, d.amount_cents, d.origin, d.removed_at
       FROM payout_duty_lines d
      WHERE d.shift_id = $1 AND d.kind = 'out_of_area'`,
    [shiftId]
  );
  assert.equal(lines.rowCount, 1, 'exactly one out_of_area line');
  assert.equal(lines.rows[0].contractor_id, aId, 'paid to the locked staffer, not the teammate');
  assert.equal(Number(lines.rows[0].amount_cents), 3500);
  assert.equal(lines.rows[0].origin, 'auto');
  assert.equal(lines.rows[0].removed_at, null);

  // Re-running accrual is idempotent (derive, never increment).
  await accruePayoutsForProposal(pastProposalId);
  const again = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_duty_lines WHERE shift_id = $1 AND kind = 'out_of_area'`,
    [shiftId]
  );
  assert.equal(again.rows[0].n, 1);

  // A RAISE on the locked bonus propagates through reconcile's amount update.
  const raise = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 5000 } });
  assert.equal(raise.status, 200, JSON.stringify(raise.body));
  await accruePayoutsForProposal(pastProposalId);
  const raised = await pool.query(
    `SELECT amount_cents FROM payout_duty_lines WHERE shift_id = $1 AND kind = 'out_of_area'`,
    [shiftId]
  );
  assert.equal(Number(raised.rows[0].amount_cents), 5000);
});

test('the duty line FOLLOWS the lock when the roster changes on a completed event', async () => {
  // Continues the derivation fixture: bonus $50 locked to A, A and B both
  // approved, A already carrying the out_of_area line.
  const before = await pool.query(
    `SELECT contractor_id, amount_cents FROM payout_duty_lines
      WHERE shift_id = $1 AND kind = 'out_of_area' AND removed_at IS NULL`,
    [pastShiftId]
  );
  assert.equal(before.rowCount, 1);
  assert.equal(before.rows[0].contractor_id, aId);

  // Admin takes A off the event. The lock releases; B is now the only worker.
  const un = await req('POST', `/api/shifts/${pastShiftId}/cancel-or-unassign`, {
    token: adminToken, body: { mode: 'unassign', user_id: aId },
  });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal((await shiftRow(pastShiftId)).out_of_area_locked_at, null);

  // Re-attaching (here, a raise) now auto-locks to the single remaining worker.
  const patch = await req('PATCH', `/api/shifts/${pastShiftId}/out-of-area`, {
    token: adminToken, body: { amount_cents: 6000 },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal(patch.body.shift.out_of_area_locked_user_id, bId);

  await accruePayoutsForProposal(pastProposalId);

  const after = await pool.query(
    `SELECT contractor_id, amount_cents FROM payout_duty_lines
      WHERE shift_id = $1 AND kind = 'out_of_area' AND removed_at IS NULL`,
    [pastShiftId]
  );
  assert.equal(after.rowCount, 1, 'exactly one payable out_of_area line, not two');
  assert.equal(after.rows[0].contractor_id, bId, 'the money moved to whoever actually holds the bonus');
  assert.equal(Number(after.rows[0].amount_cents), 6000);

  // A's line is system-removed (kept, never resurrected), not deleted.
  const aLine = await pool.query(
    `SELECT removed_at, removed_by FROM payout_duty_lines
      WHERE shift_id = $1 AND kind = 'out_of_area' AND contractor_id = $2`,
    [pastShiftId, aId]
  );
  assert.equal(aLine.rowCount, 1, 'the row survives as audit memory');
  assert.ok(aLine.rows[0].removed_at, 'system-removed');
  assert.equal(aLine.rows[0].removed_by, null, 'system removal, not an admin removal');
});

test('the unlocked warning is not a dead end: a SAME-VALUE re-save locks it and queues the re-derivation', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed)
     VALUES ('2018-10-03', '6:00 PM', 'open', $1, '["Bartender","Bartender"]'::jsonb)
     RETURNING id`,
    [pastProposalId]
  );
  const shiftId = s.rows[0].id;
  const reqIds = {};
  for (const uid of [aId, bId]) {
    const rr = await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1, $2, 'Bartender', 'approved') RETURNING id`,
      [shiftId, uid]
    );
    reqIds[uid] = rr.rows[0].id;
  }

  // Two approved: ambiguous, so the attach leaves it unlocked and warns.
  let r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 2500 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shift.out_of_area_locked_at, null);
  assert.equal(r.body.shift.approved_count, 2);
  assert.equal(r.body.shift.unlocked_warning, true);

  // Unlocked money genuinely pays nobody. This is the failure the warning names.
  await accruePayoutsForProposal(pastProposalId);
  let lines = await pool.query(
    `SELECT 1 FROM payout_duty_lines WHERE shift_id = $1 AND kind = 'out_of_area' AND removed_at IS NULL`,
    [shiftId]
  );
  assert.equal(lines.rowCount, 0, 'no lock means no duty line');

  // One staffer comes off, leaving a single unambiguous candidate.
  const del = await req('DELETE', `/api/shifts/requests/${reqIds[bId]}`, { token: adminToken });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const detail = await req('GET', `/api/shifts/detail/${shiftId}`, { token: adminToken });
  assert.equal(detail.body.shift.approved_count, 1);
  assert.equal(detail.body.shift.unlocked_warning, true, 'still unlocked, now a one-click fix');

  // SAME VALUE as stored. The amount does not move; the lock is the whole point,
  // which is why the knob keeps Save enabled while unlocked_warning is set.
  r = await req('PATCH', `/api/shifts/${shiftId}/out-of-area`, { token: adminToken, body: { amount_cents: 2500 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shift.out_of_area_locked_user_id, aId, 'the same-value save stamped the lock');
  assert.equal(r.body.shift.unlocked_warning, false, 'and the warning clears');

  // The re-derivation gate fired on newly_locked, not on an amount change.
  // (The background call itself no-ops on this 2018 fixture: maybeReaccrueForDuty
  // only acts on events inside the last 21 days. The audit row is the
  // deterministic proof the gate condition was met; the explicit accrual below
  // is what that gate would have run on a recent event.)
  const audit = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'shift_out_of_area_set'
        AND metadata->>'shift_id' = $2
      ORDER BY id DESC LIMIT 1`,
    [adminId, String(shiftId)]
  );
  assert.equal(audit.rows[0].metadata.newly_locked, true, 'the save recorded a NEW lock');
  assert.equal(audit.rows[0].metadata.from_cents, 2500, 'and the amount was unchanged');
  assert.equal(audit.rows[0].metadata.to_cents, 2500);

  await accruePayoutsForProposal(pastProposalId);
  lines = await pool.query(
    `SELECT contractor_id, amount_cents FROM payout_duty_lines
      WHERE shift_id = $1 AND kind = 'out_of_area' AND removed_at IS NULL`,
    [shiftId]
  );
  assert.equal(lines.rowCount, 1, 'the line materializes once the bonus has a holder');
  assert.equal(lines.rows[0].contractor_id, aId);
  assert.equal(Number(lines.rows[0].amount_cents), 2500);
});
