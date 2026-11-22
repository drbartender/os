/**
 * The payroll accrual problem routes (payrollAccrualProblems.js) and the
 * recorded-failure arm of the Process gate, against the dev database: the list,
 * a retry that writes the lines and clears the row, a retry that fails again
 * (500, the row kept, Process refused even over lines the event already holds),
 * Dismiss on a closed-period row only, and admin-only access.
 *
 * Run: node --test server/routes/admin/payrollAccrualProblems.test.js
 */
require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { accruePayoutsForProposal, __setAccrueImplForTest } = require('../../utils/payrollAccrual');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const payrollRouter = require('./payroll');
const problemsRouter = require('./payrollAccrualProblems');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrualProblems.test.js refuses to run against production');
}

// Owns two far-past periods no other suite uses: Tue 2016-05-03 .. Mon
// 2016-05-09 (open) and Tue 2016-05-17 .. Mon 2016-05-23 (paid).
const TAG = 'accrual-problems-fixture';
const EMAILS = ['acc-prob-admin@example.com', 'acc-prob-staff@example.com', 'acc-prob-worker@example.com'];
let adminToken, staffToken, workerId, openId, paidId, server, baseUrl;

async function preClean() {
  const users = `(SELECT id FROM users WHERE email = ANY($1))`;
  await pool.query(`DELETE FROM payroll_accrual_failures WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${users})`, [EMAILS]);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM proposals WHERE event_type = $1`, [TAG]);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2016-05-03', '2016-05-17') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);
}

async function makeEvent(date) {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES (NULL, $1, 'completed', $2, '6:00 PM', 4, 500, 500, 1, '{"addons":[]}')
     RETURNING id`,
    [date, TAG]
  );
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id) VALUES ($1, '6:00 PM', 'open', $2) RETURNING id`,
    [date, pr.rows[0].id]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
    [s.rows[0].id, workerId]
  );
  return pr.rows[0].id;
}

async function failureRow(proposalId) {
  return (await pool.query('SELECT reason FROM payroll_accrual_failures WHERE proposal_id = $1', [proposalId])).rows[0] || null;
}

async function lineCount(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_events pe JOIN shifts s ON s.id = pe.shift_id WHERE s.proposal_id = $1`,
    [proposalId]
  );
  return rows[0].n;
}

function req(method, path, { token = adminToken, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const boom = () => Promise.reject(new Error('simulated accrual failure'));

before(async () => {
  await preClean();
  const mk = async (email, role) => (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', $2, 'approved') RETURNING id`, [email, role]
  )).rows[0].id;
  adminToken = jwt.sign({ userId: await mk(EMAILS[0], 'admin'), tokenVersion: 0 }, process.env.JWT_SECRET);
  staffToken = jwt.sign({ userId: await mk(EMAILS[1], 'staff'), tokenVersion: 0 }, process.env.JWT_SECRET);
  workerId = await mk(EMAILS[2], 'staff');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [workerId]
  );
  openId = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-05-03', '2016-05-09', '2016-05-10', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  )).rows[0].id;
  paidId = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-05-17', '2016-05-23', '2016-05-24', 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`
  )).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use('/api/admin', problemsRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { __setAccrueImplForTest(null); __setLegalHoldIdsForTest(null); });

after(async () => {
  __setAccrueImplForTest(null);
  __setLegalHoldIdsForTest(null);
  if (server) await new Promise((r) => server.close(r));
  await preClean();
  await pool.end();
});

test('a staff token is refused on every route', async () => {
  for (const [method, path] of [
    ['GET', '/api/admin/payroll/accrual-problems'],
    ['POST', '/api/admin/payroll/accrual-problems/1/retry'],
    ['POST', '/api/admin/payroll/accrual-problems/1/dismiss'],
  ]) {
    const r = await req(method, path, { token: staffToken });
    assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.body)}`);
  }
});

test('an unaccrued event is listed, a retry writes its lines and drops it from the list', async () => {
  const id = await makeEvent('2016-05-04');
  const list = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.equal(list.status, 200);
  const row = list.body.items.find((i) => i.proposal_id === id);
  assert.ok(row, 'listed');
  assert.equal(row.reason, 'no_lines');

  const r = await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reason, null);
  assert.equal(r.body.accrual.skipped, false);
  assert.ok((await lineCount(id)) > 0);
  const again = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.ok(!again.body.items.some((i) => i.proposal_id === id));
  const audit = await pool.query(
    `SELECT 1 FROM admin_audit_log WHERE action = 'payroll_accrual_retry' AND (metadata->>'proposal_id')::int = $1`, [id]
  );
  assert.equal(audit.rowCount, 1, 'the retry is audit-logged');
});

test('a retry that fails again answers 500 without the error text, keeps the row, and Process refuses the period over the lines it already holds', async () => {
  const id = await makeEvent('2016-05-05');
  await accruePayoutsForProposal(id);
  assert.ok((await lineCount(id)) > 0);
  __setAccrueImplForTest(boom);
  const r = await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ACCRUAL_FAILED');
  assert.doesNotMatch(r.body.error, /simulated/, 'the raw error never reaches the response');
  assert.equal((await failureRow(id)).reason, 'error');

  const blocked = await req('POST', `/api/admin/payroll/periods/${openId}/process`, { body: {} });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /payroll did not take/);

  __setAccrueImplForTest(null);
  const ok = await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.reason, null);
  assert.equal(await failureRow(id), null);
});

test('Dismiss settles an error row that keeps failing (audited), but never a worker with no wage line', async () => {
  const paid = await makeEvent('2016-05-06');
  await accruePayoutsForProposal(paid);
  __setAccrueImplForTest(boom);
  await req('POST', `/api/admin/payroll/accrual-problems/${paid}/retry`);
  __setAccrueImplForTest(null);
  assert.equal((await failureRow(paid)).reason, 'error');
  const d = await req('POST', `/api/admin/payroll/accrual-problems/${paid}/dismiss`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.reason, 'error');
  const audit = await pool.query(
    `SELECT 1 FROM admin_audit_log WHERE action = 'payroll_accrual_dismiss' AND (metadata->>'proposal_id')::int = $1`, [paid]
  );
  assert.equal(audit.rowCount, 1);
  const list = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.ok(!list.body.items.some((i) => i.proposal_id === paid), 'its worker is paid, so nothing lists it');

  const unpaid = await makeEvent('2016-05-07');
  const refused = await req('POST', `/api/admin/payroll/accrual-problems/${unpaid}/dismiss`);
  assert.equal(refused.status, 409, 'a no-lines event has nothing recorded to dismiss');
  await accruePayoutsForProposal(unpaid);
});

test('Retry refuses the legal-hold booking and writes nothing', async () => {
  const id = await makeEvent('2016-05-08');
  __setLegalHoldIdsForTest([id]);
  const r = await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LEGAL_HOLD');
  assert.equal(await lineCount(id), 0);
});

test('a malformed proposal id is 404, never a database error', async () => {
  for (const bad of ['1e3', '0x10', '99999999999']) {
    const r = await req('POST', `/api/admin/payroll/accrual-problems/${bad}/retry`);
    assert.equal(r.status, 404, `${bad}: ${JSON.stringify(r.body)}`);
  }
});

test('a completed event lost to a closed period is listed as period_closed, and Dismiss settles it', async () => {
  const id = await makeEvent('2016-05-18');
  const r = await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accrual.reason, 'pay_period_not_open');
  assert.equal(r.body.reason, 'period_closed');
  const list = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.equal(list.body.items.find((i) => i.proposal_id === id).reason, 'period_closed');

  const d = await req('POST', `/api/admin/payroll/accrual-problems/${id}/dismiss`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const after = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.ok(!after.body.items.some((i) => i.proposal_id === id), 'gone, and not re-listed: its period is not open');
  await req('POST', `/api/admin/payroll/accrual-problems/${id}/retry`);
  const again = await req('GET', '/api/admin/payroll/accrual-problems');
  assert.ok(!again.body.items.some((i) => i.proposal_id === id), 'a later accrual does not bring it back');
});

test('an unknown proposal is 404 on retry', async () => {
  const r = await req('POST', '/api/admin/payroll/accrual-problems/999999999/retry');
  assert.equal(r.status, 404);
});
