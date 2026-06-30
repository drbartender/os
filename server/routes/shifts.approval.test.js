require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

// Tests for the request -> approval money seam (shifts.approval.js):
//   - POST /shifts/:id/request  : ranked requested_positions + transport ack,
//                                 actionable vs waitlisted, waitlist-join email
//                                 fires once on the transition into waitlisted.
//   - POST /shifts/:id/assign   : explicit canonical position required (no
//                                 || 'Bartender' default).
//   - PUT  /shifts/requests/:id : position resolved from requested_positions or
//                                 an admin override; unresolvable -> 400; an
//                                 admin over-fill is allowed but logged.
//
// The waitlist-join email is spied by patching the cached module BEFORE the
// router is required, so shifts.approval's `const { sendWaitlistJoinEmail }`
// destructure picks up the spy (require returns the same cached object).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const staffingEmail = require('../utils/staffingEmailTemplates');
let waitlistEmailCount = 0;
let lastWaitlistArgs = null;
staffingEmail.sendWaitlistJoinEmail = async (args) => { waitlistEmailCount += 1; lastWaitlistArgs = args; };

const shiftsRouter = require('./shifts'); // requires shifts.approval AFTER the spy is installed

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.approval.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
let adminId, adminToken, s1Id, s1Token, s2Id, s2Token, fillerId;
let clientId, proposalId;

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => {
        let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j });
      }); }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function mkUser(role, tag) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id`,
    [`approval-${tag}-${NONCE}@example.com`, role]
  );
  return r.rows[0].id;
}

async function mkShift({ positions, equipment = '[]', supplyRun = false }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location, client_name,
                         positions_needed, equipment_required, supply_run_required)
     VALUES (CURRENT_DATE + 12, '18:00', '22:00', 'open', $1, '123 Main', $2, $3::jsonb, $4, $5) RETURNING id`,
    [proposalId, `Approval Test ${NONCE}`, JSON.stringify(positions), equipment, supplyRun]
  );
  return r.rows[0].id;
}

async function seedPending(shiftId, userId, requestedPositions) {
  const r = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, 'pending', NULL, $3) RETURNING id`,
    [shiftId, userId, JSON.stringify(requestedPositions)]
  );
  return r.rows[0].id;
}

async function seedApproved(shiftId, userId, position) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', $3)`,
    [shiftId, userId, position]
  );
}

before(async () => {
  adminId = await mkUser('admin', 'admin');
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  s1Id = await mkUser('staff', 's1');
  s1Token = jwt.sign({ userId: s1Id, tokenVersion: 0 }, process.env.JWT_SECRET);
  s2Id = await mkUser('staff', 's2');
  s2Token = jwt.sign({ userId: s2Id, tokenVersion: 0 }, process.env.JWT_SECRET);
  fillerId = await mkUser('staff', 'filler');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position) VALUES ($1, 'Reqi One', 'bartender')`,
    [s1Id]
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`Approval Test ${NONCE}`, `approval-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 12, '18:00', 4, 'America/Chicago', 'confirmed', 'birthday-party') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use((err, reqq, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error('[approval harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query(
    `DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM shifts WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [[s1Id, s2Id, fillerId, adminId].filter(Boolean)]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[adminId, s1Id, s2Id, fillerId].filter(Boolean)]);
  await pool.end();
});

// ─── POST /:id/request ────────────────────────────────────────────

test('request: empty requested_positions -> 400', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: [] } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('request: role not in the roster -> 400', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Barback'] } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('request: actionable open slot -> 201, pending, position NULL, no waitlist email', async () => {
  const before = waitlistEmailCount;
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.position, null, 'position resolved at approval, not request');
  assert.equal(waitlistEmailCount, before, 'no waitlist email for an actionable request');
  const row = await pool.query('SELECT requested_positions FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, s1Id]);
  assert.deepEqual(JSON.parse(row.rows[0].requested_positions), ['Bartender']);
});

test('request: transport-required shift rejects without ack, accepts with ack', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'], equipment: '["portable_bar"]' });
  const noAck = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(noAck.status, 400, 'transport-required event needs an ack');

  const withAck = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Bartender'], transport_acknowledged: true } });
  assert.equal(withAck.status, 201, JSON.stringify(withAck.body));
  const row = await pool.query('SELECT transport_acknowledged_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, s1Id]);
  assert.ok(row.rows[0].transport_acknowledged_at, 'ack stamped when required + given');
});

test('request: waitlist-join email fires once across two re-ranks', async () => {
  // Fully staff the only Bartender slot so the request is waitlisted.
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await seedApproved(shiftId, fillerId, 'Bartender');
  const before = waitlistEmailCount;

  const first = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(waitlistEmailCount, before + 1, 'waitlist email fires on transition into waitlisted');
  assert.equal(lastWaitlistArgs?.staffName, 'Reqi One', 'email carries the requester preferred name');

  // Re-rank: still waitlisted (same full Bartender slot) -> no second email.
  const second = await req('POST', `/api/shifts/${shiftId}/request`, { token: s1Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(waitlistEmailCount, before + 1, 're-rank that stays waitlisted sends nothing');
});

// ─── PUT /requests/:requestId (approval money seam) ───────────────

test('approve: ranked Banquet Server into an open server slot writes position=Banquet Server', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const reqId = await seedPending(shiftId, s2Id, ['Banquet Server']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.position, 'Banquet Server');
});

test('approve: a bartender request resolves to exactly Bartender', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const reqId = await seedPending(shiftId, s2Id, ['Bartender']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.position, 'Bartender');
});

test('approve: empty requested_positions (legacy "any role") resolves to an open role', async () => {
  const shiftId = await mkShift({ positions: ['Banquet Server'] });
  const reqId = await seedPending(shiftId, s2Id, []);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.position, 'Banquet Server');
});

test('approve: no resolvable role and no override -> 400, position untouched', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await seedApproved(shiftId, fillerId, 'Bartender'); // the only slot is full
  const reqId = await seedPending(shiftId, s2Id, ['Bartender']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const row = await pool.query('SELECT status, position FROM shift_requests WHERE id = $1', [reqId]);
  assert.equal(row.rows[0].status, 'pending', 'left pending');
  assert.equal(row.rows[0].position, null, 'position untouched');
});

test('approve: admin override onto a full role is allowed and logged (overfill)', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await seedApproved(shiftId, fillerId, 'Bartender'); // full
  const reqId = await seedPending(shiftId, s2Id, ['Bartender']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'approved', position: 'Bartender' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.position, 'Bartender');
  const log = await pool.query(
    `SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'staffing_overfill'`,
    [proposalId]
  );
  assert.ok(log.rows.length >= 1, 'overfill is recorded in proposal_activity_log');
});

test('deny: still works (no position resolution) and returns denied', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const reqId = await seedPending(shiftId, s2Id, ['Bartender']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'denied' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'denied');
});

// ─── POST /:id/assign (explicit position required) ────────────────

test('assign: missing position -> 400 (no Bartender default)', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, { token: adminToken, body: { user_id: s1Id } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('assign: unknown role -> 400', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, { token: adminToken, body: { user_id: s1Id, position: 'Sous Chef' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('assign: legacy "Server" canonicalizes to Banquet Server', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, { token: adminToken, body: { user_id: s1Id, position: 'Server' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.position, 'Banquet Server');
});

// ─── auth guards (requireStaffing) ────────────────────────────────

test('auth: a plain staff token cannot assign (403)', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, { token: s1Token, body: { user_id: s2Id, position: 'Bartender' } });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test('auth: a plain staff token cannot approve/deny a request (403)', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const reqId = await seedPending(shiftId, s2Id, ['Bartender']);
  const r = await req('PUT', `/api/shifts/requests/${reqId}`, { token: s1Token, body: { status: 'approved' } });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

// ─── approve: 'pending' passthrough ───────────────────────────────

test('approve: status=pending passthrough returns pending and leaves position intact', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender') RETURNING id`,
    [shiftId, s2Id]
  );
  const reqId = r.rows[0].id;
  const res = await req('PUT', `/api/shifts/requests/${reqId}`, { token: adminToken, body: { status: 'pending' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.position, 'Bartender', 'position is not cleared on a pending demote');
});

// ─── waitlist dedup: transition out of waitlisted ─────────────────

test('request: waitlisted -> actionable (slot opens) sends no waitlist email', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await seedApproved(shiftId, fillerId, 'Bartender'); // full -> first request waitlists
  const base = waitlistEmailCount;

  const first = await req('POST', `/api/shifts/${shiftId}/request`, { token: s2Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(waitlistEmailCount, base + 1, 'waitlisted on first request');

  // Open the slot (remove the filler), then re-rank -> now actionable.
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2`, [shiftId, fillerId]);
  const second = await req('POST', `/api/shifts/${shiftId}/request`, { token: s2Token, body: { requested_positions: ['Bartender'] } });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(waitlistEmailCount, base + 1, 'no waitlist email once the request becomes actionable');
});

// ─── PUT /:id logistics: equipment validation + supply_run override ─

test('PUT /:id: invalid equipment token -> 400', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('PUT', `/api/shifts/${shiftId}`, { token: adminToken, body: { equipment_required: ['portable_bar', 'rocket_launcher'] } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('PUT /:id: non-boolean supply_run -> 400', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('PUT', `/api/shifts/${shiftId}`, { token: adminToken, body: { supply_run: 'yes' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('PUT /:id: supply_run=true sets required AND overridden', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('PUT', `/api/shifts/${shiftId}`, { token: adminToken, body: { supply_run: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await pool.query('SELECT supply_run_required, supply_run_overridden FROM shifts WHERE id = $1', [shiftId]);
  assert.equal(row.rows[0].supply_run_required, true);
  assert.equal(row.rows[0].supply_run_overridden, true, 'admin decision is flagged so sync stops recomputing');
});

test('PUT /:id: supply_run=false also sets overridden (explicit off is still a decision)', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'], supplyRun: true });
  const r = await req('PUT', `/api/shifts/${shiftId}`, { token: adminToken, body: { supply_run: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await pool.query('SELECT supply_run_required, supply_run_overridden FROM shifts WHERE id = $1', [shiftId]);
  assert.equal(row.rows[0].supply_run_required, false);
  assert.equal(row.rows[0].supply_run_overridden, true);
});

test('PUT /:id: editing equipment without supply_run leaves supply fields untouched', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] }); // supply defaults: required=false, overridden=false
  const r = await req('PUT', `/api/shifts/${shiftId}`, { token: adminToken, body: { equipment_required: ['cooler'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await pool.query('SELECT equipment_required, supply_run_required, supply_run_overridden FROM shifts WHERE id = $1', [shiftId]);
  assert.deepEqual(JSON.parse(row.rows[0].equipment_required), ['cooler']);
  assert.equal(row.rows[0].supply_run_required, false);
  assert.equal(row.rows[0].supply_run_overridden, false, 'equipment edit never touches the supply override flag');
});
