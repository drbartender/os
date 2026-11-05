require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'shifts-roster-reaccrue-test';

/**
 * Every admin roster removal hands the proposal to payroll re-accrual, lock or
 * no lock (audit 2026-11-05, POUT-02).
 *
 * Remove (DELETE /shifts/requests/:id) learned this on prod 2026-08-24: a
 * no-show Removed after completion kept a quarter of the card tip because her
 * shift carried no out-of-area bonus, so the lock-release branch, the only
 * payroll hook on that path, never fired. Three sibling paths still gated the
 * same hook on `releaseOutOfAreaLock` returning true: the roster's unassign
 * (POST /shifts/:id/cancel-or-unassign mode=unassign), the cancel mode of the
 * same handler, and an approved request set to denied (PUT /shifts/requests/
 * :id). The cover-swap cascade gated it on a lock moving. On a completed event
 * the no-show's wage and tip line stays payable and the teammate's gratuity is
 * never re-split, exactly the Remove defect in a different button.
 *
 * The hook is reaccrueDutyForProposal (serviceArea.js): a full accrual on a
 * recently-completed proposal and one SELECT otherwise, fire-and-forget. As in
 * shifts.removeReaccrue.test.js the spy proves each handler CALLS it; the
 * sibling shifts.unassignReaccrue.test.js runs the accrual that call performs
 * against a real database.
 *
 * Harness: the real routers and the real auth middleware over node:http, with
 * pool.query and pool.connect replaced by an in-memory stub keyed on the SQL
 * text (the stripePayoutSync.unconfigured.test.js pattern), so no database is
 * needed and the premise, NO lock on the shift, is exact: every lock UPDATE
 * answers rowCount 0.
 *
 * Run: node --test server/routes/shifts.rosterReaccrue.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

// The spy must be installed BEFORE the routers load: shifts.handlers.js,
// shifts.approval.js and coverApprovalCascade.js all destructure
// reaccrueDutyForProposal out of serviceArea at require time.
const serviceArea = require('../utils/serviceArea');
const reaccrueCalls = [];
serviceArea.reaccrueDutyForProposal = (proposalId) => { reaccrueCalls.push(proposalId); };
const shiftsRouter = require('./shifts');
const { approveAndCascade } = require('../utils/coverApprovalCascade');

const ADMIN_ID = 201;
const STAFF_ID = 203;
const CLAIMER_ID = 204;
const PROPOSAL_ID = 9001;
const SHIFT_ID = 9101;
const REQUEST_ID = 9201;      // STAFF_ID's approved request
const CLAIM_REQUEST_ID = 9202; // CLAIMER_ID's cover claim

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
let lockUpdates = 0;

// One answer table for pool.query and the fake transaction client.
function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    return {
      rows: [{
        id: ADMIN_ID, email: 'admin-roster@example.com', role: 'admin', onboarding_status: 'approved',
        can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql === 'SELECT id, proposal_id FROM shifts WHERE id = $1') {
    return { rows: [{ id: SHIFT_ID, proposal_id: PROPOSAL_ID }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = \'approved\'')) {
    return { rows: [{ user_id: STAFF_ID }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE shift_requests SET status = \'denied\' WHERE shift_id = $1 AND user_id = $2')) {
    return { rows: [{ id: REQUEST_ID }], rowCount: 1 };
  }
  // PUT /requests/:id pre-read: an approved staffer, no cover swap.
  if (sql.startsWith('SELECT sr.status AS prior_status')) {
    return {
      rows: [{
        prior_status: 'approved', user_id: STAFF_ID, replaced_by_request_id: null,
        requested_positions: '["Bartender"]', proposal_id: PROPOSAL_ID, shift_id: SHIFT_ID,
        positions_needed: '["Bartender"]', approved_by_role: { Bartender: 1 },
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('UPDATE shift_requests SET status = \'denied\', beo_acknowledged_at = NULL WHERE id = $1 RETURNING *')) {
    return { rows: [{ id: params[0], shift_id: SHIFT_ID, user_id: STAFF_ID, status: 'denied' }], rowCount: 1 };
  }
  // Cover cascade: both requests on the same shift of the same proposal, no
  // finalized drink plan (so no BEO nudge arithmetic).
  if (sql.startsWith('SELECT sr.id AS request_id')) {
    const row = (requestId, userId) => ({
      request_id: requestId, user_id: userId, shift_id: SHIFT_ID, status: 'approved',
      replaced_by_request_id: null, cover_requested_at: null, proposal_id: PROPOSAL_ID,
      event_date: new Date('2026-10-10T00:00:00Z'), event_start_time: null, event_duration_hours: 4,
      event_timezone: 'America/Chicago', drink_plan_finalized_at: null,
    });
    return { rows: [row(REQUEST_ID, STAFF_ID), row(CLAIM_REQUEST_ID, CLAIMER_ID)], rowCount: 2 };
  }
  // THE PREMISE: the shift carries no out-of-area lock, so neither the release
  // nor the stamp moves anything.
  if (sql.startsWith('UPDATE shifts SET out_of_area_locked_at')) {
    lockUpdates += 1;
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}

function fakeClient() {
  return { query: (text, params) => Promise.resolve(answer(text, params)), release: () => {} };
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenFor(ADMIN_ID)}`,
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

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params));
  pool.connect = () => Promise.resolve(fakeClient());
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[roster-reaccrue harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { reaccrueCalls.length = 0; lockUpdates = 0; });

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

test('unassign with NO out-of-area lock still hands the proposal to re-accrual', async () => {
  const r = await req('POST', `/api/shifts/${SHIFT_ID}/cancel-or-unassign`, { mode: 'unassign', user_id: STAFF_ID });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(lockUpdates >= 1, 'premise: the lock release ran and released nothing');
  assert.deepEqual(reaccrueCalls, [PROPOSAL_ID],
    'unassign must re-accrue regardless of the lock, exactly as Remove does');
});

test('cancel with NO out-of-area lock still hands the proposal to re-accrual', async () => {
  const r = await req('POST', `/api/shifts/${SHIFT_ID}/cancel-or-unassign`, { mode: 'cancel' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(lockUpdates >= 1, 'premise: the lock release ran and released nothing');
  assert.deepEqual(reaccrueCalls, [PROPOSAL_ID]);
});

test('denying an approved request with NO out-of-area lock still hands the proposal to re-accrual', async () => {
  const r = await req('PUT', `/api/shifts/requests/${REQUEST_ID}`, { status: 'denied' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(lockUpdates >= 1, 'premise: the lock release ran and released nothing');
  assert.deepEqual(reaccrueCalls, [PROPOSAL_ID]);
});

test('a cover swap that moves NO lock still hands the proposal to re-accrual', async () => {
  const result = await approveAndCascade(pool, REQUEST_ID, CLAIM_REQUEST_ID);
  assert.equal(result.outOfAreaLockMoved, false, 'premise: nothing was released or stamped');
  assert.equal(result.proposalId, PROPOSAL_ID);
  assert.deepEqual(reaccrueCalls, [PROPOSAL_ID],
    'the original is off the roster and the claimer on it: payroll must re-derive both lines');
});
