require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * The ShiftDrawer Remove button (DELETE /shifts/requests/:id) on a COMPLETED
 * event must re-run payroll accrual, not only when it releases an out-of-area
 * lock. Prod 2026-08-24 (proposal 652): auto-completion accrued while a no-show
 * was still approved; the admin then zeroed her hours and Removed her, and her
 * line survived with a quarter of the card tip because nothing re-ran the
 * orphan sweep. The lock-release branch was the only payroll hook on Remove and
 * the shift carried no bonus.
 *
 * The hook is reaccrueDutyForProposal (serviceArea.js), which despite its name
 * is a full accruePayoutsForProposal on a recently-completed proposal and a
 * single SELECT otherwise. It is fire-and-forget via setImmediate and gated to
 * events inside the last 21 days, so this far-past fixture can never observe it
 * end-to-end; the spy proves the handler CALLS it, and the explicit accrual
 * below is exactly what that call runs on a recent event.
 *
 * Harness mirrors shifts.bonus.test.js: express over real HTTP, hand-signed
 * JWTs. SHARED DEV DB DISCIPLINE: this suite owns the far-past pay-period week
 * Tue 2018-08-07 .. Mon 2018-08-13 and every fixture email matches
 * 'rmra-%@example.com'.
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

// The spy must be installed BEFORE the router loads: shifts.js destructures
// reaccrueDutyForProposal out of serviceArea at require time.
const serviceArea = require('../utils/serviceArea');
const reaccrueCalls = [];
serviceArea.reaccrueDutyForProposal = (proposalId) => { reaccrueCalls.push(proposalId); };
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.removeReaccrue.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = "email LIKE 'rmra-%@example.com'";
const PERIOD_START = '2018-08-07';

let server, baseUrl;
let adminId, adminToken, staffId, clientId, proposalId, periodId;

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
  const props = `(SELECT id FROM proposals WHERE event_type = 'rmra-fixture')`;
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${uids})`
  );
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${uids}`);
  await pool.query(
    `DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id IN ${props})`
  );
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'rmra-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'rmra-%@example.com'`);
  await pool.query(
    `DELETE FROM pay_periods WHERE start_date = $1
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`,
    [PERIOD_START]
  );
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE ${EMAIL_LIKE}`);
}

async function mkUser(tag, role) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id`,
    [`rmra-${tag}-${NONCE}@example.com`, role]
  );
  return rows[0].id;
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
  await cleanup();

  adminId = await mkUser('admin', 'admin');
  adminToken = tokenFor(adminId);
  staffId = await mkUser('staff', 'staff');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Nosh', 'bartender', 20.00)`,
    [staffId]
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`RMRA ${NONCE}`, `rmra-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // Far-past COMPLETED + funded proposal: accrual is completion-only.
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES ($1, '2018-08-08', '6:00 PM', 4, 'America/Chicago', 'completed', 'rmra-fixture', 500, 500, 0, '{"addons":[]}')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const per = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, '2018-08-13', '2018-08-14', 'open')
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
    console.error('[rmra harness] unhandled:', err);
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

async function linesFor(shiftId) {
  const { rows } = await pool.query(
    `SELECT pe.id, pe.hours, po.contractor_id, po.status
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE pe.shift_id = $1`,
    [shiftId]
  );
  return rows;
}

test('Remove on a completed event re-accrues even with NO out-of-area lock, and that re-accrual sweeps the no-show line', async () => {
  // No bonus, no lock: the pre-fix handler had nothing to release and so never
  // touched payroll.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed)
     VALUES ('2018-08-08', '6:00 PM', 'completed', $1, '["Bartender"]'::jsonb) RETURNING id`,
    [proposalId]
  );
  const shiftId = s.rows[0].id;
  const r = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved') RETURNING id`,
    [shiftId, staffId]
  );
  const requestId = r.rows[0].id;

  // Auto-completion accrued while the no-show was still approved.
  await accruePayoutsForProposal(proposalId);
  let lines = await linesFor(shiftId);
  assert.equal(lines.length, 1, 'accrual minted the line');
  assert.equal(lines[0].contractor_id, staffId);
  assert.ok(Number(lines[0].hours) > 0, 'first accrual seeds hours from the contract');

  reaccrueCalls.length = 0;
  const del = await req('DELETE', `/api/shifts/requests/${requestId}`, { token: adminToken });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const gone = await pool.query('SELECT 1 FROM shift_requests WHERE id = $1', [requestId]);
  assert.equal(gone.rowCount, 0, 'the request row is deleted outright');

  const shift = await pool.query(
    'SELECT out_of_area_locked_at, out_of_area_bonus_cents FROM shifts WHERE id = $1', [shiftId]
  );
  assert.equal(shift.rows[0].out_of_area_locked_at, null, 'fixture sanity: there was never a lock to release');
  assert.equal(shift.rows[0].out_of_area_bonus_cents, null);

  assert.deepEqual(reaccrueCalls, [proposalId],
    'Remove must hand the proposal to payroll re-accrual regardless of the out-of-area lock');

  // What the hook runs on a recent event: the roster is empty, so the orphan
  // sweep deletes the zero-adjustment line and the emptied pending payout.
  await accruePayoutsForProposal(proposalId);
  lines = await linesFor(shiftId);
  assert.equal(lines.length, 0, 'the no-show line is swept');
  const payout = await pool.query(
    'SELECT 1 FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2', [periodId, staffId]
  );
  assert.equal(payout.rowCount, 0, 'the emptied pending payout is gone too');
});
