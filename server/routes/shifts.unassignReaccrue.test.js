require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * The roster's unassign action (POST /shifts/:id/cancel-or-unassign,
 * mode=unassign) and an approved request set to denied (PUT /shifts/requests/
 * :id) on a COMPLETED event must re-run payroll accrual, not only when they
 * release an out-of-area lock (audit 2026-11-05, POUT-02). Both paths still
 * carried the gate that Remove lost on prod 2026-08-24 (proposal 652): the
 * no-show's wage and tip line stayed payable and the teammate's gratuity was
 * never re-split, because the shift carried no bonus and the lock-release
 * branch was the only payroll hook.
 *
 * Mirrors shifts.removeReaccrue.test.js: the hook (reaccrueDutyForProposal) is
 * fire-and-forget and gated to events inside the last 21 days, so this
 * far-past fixture can never observe it end-to-end; the spy proves each
 * handler CALLS it, and the explicit accrual below is exactly what that call
 * runs on a recent event. The pure sibling shifts.rosterReaccrue.test.js
 * covers the same calls with no database.
 *
 * Harness: express over real HTTP, hand-signed JWTs. SHARED DEV DB DISCIPLINE:
 * this suite owns the far-past pay-period week Tue 2018-09-04 .. Mon
 * 2018-09-10 and every fixture email matches 'rmru-%@example.com'.
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

// The spy must be installed BEFORE the router loads: shifts.handlers.js and
// shifts.approval.js destructure reaccrueDutyForProposal at require time.
const serviceArea = require('../utils/serviceArea');
const reaccrueCalls = [];
serviceArea.reaccrueDutyForProposal = (proposalId) => { reaccrueCalls.push(proposalId); };
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.unassignReaccrue.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = "email LIKE 'rmru-%@example.com'";
const PERIOD_START = '2018-09-04';
const EVENT_DATE = '2018-09-05';

let server, baseUrl;
let adminId, adminToken, staffA, staffB, clientId, periodId;

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
  const props = `(SELECT id FROM proposals WHERE event_type = 'rmru-fixture')`;
  const shifts = `(SELECT id FROM shifts WHERE proposal_id IN ${props})`;
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${uids})`
  );
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${uids}`);
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id IN ${shifts}`);
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id IN ${props}`);
  await pool.query(`DELETE FROM shift_requests WHERE shift_id IN ${shifts}`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'rmru-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'rmru-%@example.com'`);
  await pool.query(
    `DELETE FROM pay_periods WHERE start_date = $1
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`,
    [PERIOD_START]
  );
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN ${uids} OR target_user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE ${EMAIL_LIKE}`);
}

async function mkUser(tag, role) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id`,
    [`rmru-${tag}-${NONCE}@example.com`, role]
  );
  if (role === 'staff') {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
       VALUES ($1, $2, 'bartender', 20.00)`,
      [rows[0].id, `Rmru ${tag}`]
    );
  }
  return rows[0].id;
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// A far-past COMPLETED, funded, two-bartender event with a $100 gratuity pool
// (10,000 cents) and no out-of-area bonus. Returns the ids the test needs.
async function mkCompletedEvent() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES ($1, $2, '6:00 PM', 4, 'America/Chicago', 'completed', 'rmru-fixture', 1000, 1000, 0,
             '{"addons":[],"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`,
    [clientId, EVENT_DATE]
  );
  const proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed)
     VALUES ($1, '6:00 PM', 'completed', $2, '["Bartender","Bartender"]'::jsonb) RETURNING id`,
    [EVENT_DATE, proposalId]
  );
  const shiftId = s.rows[0].id;
  const requestIds = {};
  for (const [tag, uid] of [['a', staffA], ['b', staffB]]) {
    const r = await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1, $2, 'Bartender', 'approved') RETURNING id`,
      [shiftId, uid]
    );
    requestIds[tag] = r.rows[0].id;
  }
  return { proposalId, shiftId, requestIds };
}

async function linesFor(shiftId) {
  const { rows } = await pool.query(
    `SELECT pe.id, pe.hours, pe.gratuity_share_cents, po.contractor_id, po.status, po.total_cents
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1 ORDER BY po.contractor_id`,
    [shiftId]
  );
  return rows;
}

async function assertNoShowSwept({ proposalId, shiftId }, noShowId, keptId) {
  // What the hook runs on a recent event: the no-show is off the roster, so
  // the orphan sweep deletes the zero-adjustment line, the emptied pending
  // payout goes with it, and the gratuity re-pools to the teammate alone.
  await accruePayoutsForProposal(proposalId);
  const lines = await linesFor(shiftId);
  assert.equal(lines.length, 1, 'only the teammate keeps a line');
  assert.equal(lines[0].contractor_id, keptId);
  assert.equal(Number(lines[0].gratuity_share_cents), 10000, 'the whole pool re-splits to the one bartender left');
  assert.equal(Number(lines[0].total_cents), 21000, '5.5h x 2000 wage + the full pool');
  const gone = await pool.query(
    'SELECT 1 FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2', [periodId, noShowId]
  );
  assert.equal(gone.rowCount, 0, 'the no-show emptied pending payout is gone too');
}

before(async () => {
  await cleanup();
  adminId = await mkUser('admin', 'admin');
  adminToken = tokenFor(adminId);
  staffA = await mkUser('a', 'staff');
  staffB = await mkUser('b', 'staff');
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`RMRU ${NONCE}`, `rmru-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const per = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, '2018-09-10', '2018-09-11', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`,
    [PERIOD_START]
  );
  periodId = per.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[rmru harness] unhandled:', err);
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

test('unassign on a completed event re-accrues with NO out-of-area lock, and that re-accrual sweeps the no-show line', async () => {
  const ev = await mkCompletedEvent();
  await accruePayoutsForProposal(ev.proposalId);
  const lines = await linesFor(ev.shiftId);
  assert.equal(lines.length, 2, 'auto-completion accrued both bartenders');
  assert.ok(lines.every((l) => Number(l.gratuity_share_cents) === 5000), 'the pool split two ways');

  reaccrueCalls.length = 0;
  const r = await req('POST', `/api/shifts/${ev.shiftId}/cancel-or-unassign`, {
    token: adminToken, body: { mode: 'unassign', user_id: staffB },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const shift = await pool.query(
    'SELECT out_of_area_locked_at, out_of_area_bonus_cents FROM shifts WHERE id = $1', [ev.shiftId]
  );
  assert.equal(shift.rows[0].out_of_area_locked_at, null, 'fixture sanity: there was never a lock to release');
  assert.equal(shift.rows[0].out_of_area_bonus_cents, null);
  assert.deepEqual(reaccrueCalls, [ev.proposalId],
    'unassign must hand the proposal to payroll re-accrual regardless of the out-of-area lock');

  await assertNoShowSwept(ev, staffB, staffA);
});

test('denying an approved request on a completed event re-accrues with NO out-of-area lock, and that re-accrual sweeps the no-show line', async () => {
  const ev = await mkCompletedEvent();
  await accruePayoutsForProposal(ev.proposalId);
  assert.equal((await linesFor(ev.shiftId)).length, 2, 'auto-completion accrued both bartenders');

  reaccrueCalls.length = 0;
  const r = await req('PUT', `/api/shifts/requests/${ev.requestIds.b}`, {
    token: adminToken, body: { status: 'denied' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'denied');
  assert.deepEqual(reaccrueCalls, [ev.proposalId],
    'deny must hand the proposal to payroll re-accrual regardless of the out-of-area lock');

  await assertNoShowSwept(ev, staffB, staffA);
});
