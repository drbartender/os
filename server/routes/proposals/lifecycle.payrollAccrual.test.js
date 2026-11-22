/**
 * PATCH /api/proposals/:id/status to 'completed' says how payroll took the
 * completion (payroll_accrual 'ok', 'error' or 'period_closed') instead of a
 * plain success, against the dev database. The status change commits either way.
 * Fixtures carry no client, so the completion's marketing hooks do nothing.
 *
 * Run: node --test server/routes/proposals/lifecycle.payrollAccrual.test.js
 */
require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { __setAccrueImplForTest } = require('../../utils/payrollAccrual');
const lifecycleRouter = require('./lifecycle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('lifecycle.payrollAccrual.test.js refuses to run against production');
}

// Owns two far-past periods no other suite uses: Tue 2016-06-07 .. Mon
// 2016-06-13 (open) and Tue 2016-06-21 .. Mon 2016-06-27 (paid).
const TAG = 'lifecycle-accrual-fixture';
const EMAILS = ['lc-acc-admin@example.com', 'lc-acc-worker@example.com'];
let adminToken, workerId, server, baseUrl;

async function preClean() {
  const users = `(SELECT id FROM users WHERE email = ANY($1))`;
  await pool.query(`DELETE FROM payroll_accrual_failures WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${users})`, [EMAILS]);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM proposals WHERE event_type = $1`, [TAG]);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2016-06-07', '2016-06-21') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);
}

async function makeBooking(date) {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES (NULL, $1, 'balance_paid', $2, '6:00 PM', 4, 500, 500, 1, '{"addons":[]}')
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

function patchStatus(id, status) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ status });
    const r = http.request(`${baseUrl}/api/proposals/${id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

before(async () => {
  await preClean();
  const adminId = (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id`, [EMAILS[0]]
  )).rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  workerId = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [EMAILS[1]]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [workerId]
  );
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-06-07', '2016-06-13', '2016-06-14', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'`
  );
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-06-21', '2016-06-27', '2016-06-28', 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid'`
  );

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', lifecycleRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => __setAccrueImplForTest(null));

after(async () => {
  __setAccrueImplForTest(null);
  if (server) await new Promise((r) => server.close(r));
  await preClean();
  await pool.end();
});

test('a completion whose accrual writes the lines answers payroll_accrual ok', async () => {
  const id = await makeBooking('2016-06-08');
  const r = await patchStatus(id, 'completed');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.payroll_accrual, 'ok');
});

test('a completion whose accrual throws still completes and answers payroll_accrual error, with the failure recorded', async () => {
  const id = await makeBooking('2016-06-09');
  __setAccrueImplForTest(() => Promise.reject(new Error('simulated accrual failure')));
  const r = await patchStatus(id, 'completed');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.payroll_accrual, 'error');
  const row = await pool.query('SELECT reason FROM payroll_accrual_failures WHERE proposal_id = $1', [id]);
  assert.equal(row.rows[0].reason, 'error');
});

test('a completion into a pay period that is already paid answers payroll_accrual period_closed', async () => {
  const id = await makeBooking('2016-06-22');
  const r = await patchStatus(id, 'completed');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payroll_accrual, 'period_closed');
});

test('a status change other than completed carries no payroll_accrual', async () => {
  const id = await makeBooking('2016-06-10');
  await pool.query(`UPDATE proposals SET status = 'confirmed' WHERE id = $1`, [id]);
  const r = await patchStatus(id, 'balance_paid');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payroll_accrual, undefined);
});
