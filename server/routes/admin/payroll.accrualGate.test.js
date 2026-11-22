/**
 * The accrual gate on POST /payroll/periods/:id/process, against the dev
 * database: an open period with a completed, staffed event that holds no payout
 * line refuses to process (processing freezes the period and accrual never
 * writes a frozen one, so those wages would be lost), passes once the lines are
 * written, and a reopened period is not gated, since accrual refuses it anyway.
 * Imports only what main already has, so the refusal case fails on main.
 *
 * Run: node --test server/routes/admin/payroll.accrualGate.test.js
 */
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const payrollRouter = require('./payroll');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.accrualGate.test.js refuses to run against production');
}

// Owns three far-past periods no other suite uses: Tue 2016-04-05 .. Mon
// 2016-04-11 (open), Tue 2016-04-19 .. Mon 2016-04-25 (reopened) and Tue
// 2016-05-24 .. Mon 2016-05-30 (open, the per-worker case).
const TAG = 'accrual-gate-fixture';
const EMAILS = ['acc-gate-admin@example.com', 'acc-gate-worker@example.com', 'acc-gate-worker2@example.com'];
let adminToken, workerId, worker2Id, openId, reopenedId, open2Id, server, baseUrl;

async function preClean() {
  const users = `(SELECT id FROM users WHERE email = ANY($1))`;
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ${users})`, [EMAILS]);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN ${users}`, [EMAILS]);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE event_type = $1)`, [TAG]);
  await pool.query(`DELETE FROM proposals WHERE event_type = $1`, [TAG]);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2016-04-05', '2016-04-19', '2016-05-24') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
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

async function periodStatus(id) {
  return (await pool.query('SELECT status FROM pay_periods WHERE id = $1', [id])).rows[0].status;
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
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

before(async () => {
  await preClean();
  const adminId = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`, [EMAILS[0]]
  )).rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  workerId = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [EMAILS[1]]
  )).rows[0].id;
  worker2Id = (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [EMAILS[2]]
  )).rows[0].id;
  for (const uid of [workerId, worker2Id]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [uid]
    );
  }
  open2Id = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-05-24', '2016-05-30', '2016-05-31', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  )).rows[0].id;
  openId = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-04-05', '2016-04-11', '2016-04-12', 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  )).rows[0].id;
  reopenedId = (await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ('2016-04-19', '2016-04-25', '2016-04-26', 'reopened')
     ON CONFLICT (start_date) DO UPDATE SET status = 'reopened' RETURNING id`
  )).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await preClean();
  await pool.end();
});

test('Process refuses an open period holding a completed, staffed event with no payout line, and leaves it open', async () => {
  const id = await makeEvent('2016-04-06');
  const r = await req('POST', `/api/admin/payroll/periods/${openId}/process`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /payroll did not take/);
  assert.equal(await periodStatus(openId), 'open', 'the period is not frozen');

  // Once the event's lines are written the gate clears and the period processes.
  await accruePayoutsForProposal(id);
  const ok = await req('POST', `/api/admin/payroll/periods/${openId}/process`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(['processing', 'paid'].includes(await periodStatus(openId)));
});

test('a reopened period is not gated, since accrual refuses it and the gate could never clear', async () => {
  await makeEvent('2016-04-20');
  const r = await req('POST', `/api/admin/payroll/periods/${reopenedId}/process`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('a worker approved after the accrual, beside a teammate who has a line, still blocks Process', async () => {
  const id = await makeEvent('2016-05-25');
  await accruePayoutsForProposal(id);
  const shiftId = (await pool.query('SELECT id FROM shifts WHERE proposal_id = $1', [id])).rows[0].id;
  // An approval path that does not re-accrue: the late worker has no line.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Barback', 'approved')`,
    [shiftId, worker2Id]
  );
  const r = await req('POST', `/api/admin/payroll/periods/${open2Id}/process`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  await accruePayoutsForProposal(id);
  const ok = await req('POST', `/api/admin/payroll/periods/${open2Id}/process`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
