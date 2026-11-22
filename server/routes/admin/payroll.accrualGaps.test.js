require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.accrualGaps.test.js refuses to run against production');
}

// Accrual gaps at period process. Every accrual caller treats a failure as
// best-effort, so before this check a completed event could reach processing
// with a staffer who had no pay line, and payroll froze without them. The
// route now retries the gap's accrual and refuses when it still fails.
//
// The second describe-block needs accrual to fail, so the accrual export is
// swapped for a throwing stub BEFORE ./payroll is required (the route binds
// it at require time) and the real function is called through the original.
const accrualMod = require('../../utils/payrollAccrual');
const realAccrue = accrualMod.accruePayoutsForProposal;
let failAccrual = false;
accrualMod.accruePayoutsForProposal = async (id) => {
  if (failAccrual) throw new Error('simulated accrual failure');
  return realAccrue(id);
};
const payrollRouter = require('./payroll');
const { findAccrualGaps, healAccrualGaps } = require('../../utils/payrollAccrualGaps');

// Far-past weeks owned by this suite: Tue 2017-03-07 .. Mon 2017-03-13 (heal)
// and Tue 2017-03-14 .. Mon 2017-03-20 (refuse).
const EMAILS = "email LIKE 'pr-gaps-%@example.com'";
const DATES = "('2017-03-08','2017-03-15')";
let adminToken, server, baseUrl, workerId;
const fx = {};

async function clean() {
  await pool.query(`DELETE FROM payout_duty_lines WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS}))`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shifts WHERE event_date IN ${DATES} AND proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date IN ${DATES} AND event_type = 'birthday-party')`);
  await pool.query(`DELETE FROM proposals WHERE client_id IS NULL AND event_date IN ${DATES} AND event_type = 'birthday-party'`);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2017-03-07','2017-03-14') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM users WHERE ${EMAILS}`);
}

async function seedWeek(start, end, payday, eventDate) {
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`,
    [start, end, payday]
  );
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, $1, 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000, '{"breakdown":[]}') RETURNING id`,
    [eventDate]
  );
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id) VALUES ($1, '6:00 PM', 'filled', $2) RETURNING id`,
    [eventDate, pr.rows[0].id]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
    [s.rows[0].id, workerId]
  );
  return { periodId: p.rows[0].id, proposalId: pr.rows[0].id, shiftId: s.rows[0].id };
}

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const linesFor = async (shiftId) => (await pool.query(
  `SELECT pe.id FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
    WHERE pe.shift_id = $1 AND po.contractor_id = $2`, [shiftId, workerId]
)).rows.length;

before(async () => {
  await clean();
  const a = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('pr-gaps-admin@example.com','x','admin') RETURNING id`);
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);
  workerId = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('pr-gaps-worker@example.com','x','staff') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO contractor_profiles (user_id, preferred_name, hourly_rate) VALUES ($1, 'Gap Test Bartender', 20)`, [workerId]);
  fx.heal = await seedWeek('2017-03-07', '2017-03-13', '2017-03-14', '2017-03-08');
  fx.refuse = await seedWeek('2017-03-14', '2017-03-20', '2017-03-21', '2017-03-15');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  accrualMod.accruePayoutsForProposal = realAccrue;
  if (server) server.close();
  await clean();
  await pool.end();
});

test('a completed event whose staffer has no pay line is found as a gap', async () => {
  const gaps = await findAccrualGaps(fx.heal.periodId);
  assert.deepEqual(gaps.map((g) => [g.proposal_id, g.shift_id, g.user_id]), [[fx.heal.proposalId, fx.heal.shiftId, workerId]]);
});

test('the legal-hold proposal is never a gap, so it is never retried and never blocks', async () => {
  const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
  __setLegalHoldIdsForTest([fx.refuse.proposalId]);
  try {
    assert.deepEqual(await findAccrualGaps(fx.refuse.periodId), []);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  assert.equal((await findAccrualGaps(fx.refuse.periodId)).length, 1, 'off the list, the gap is back');
});

test('a retry that fails leaves the gap in place', async () => {
  const r = await healAccrualGaps(fx.refuse.periodId, { accrue: async () => { throw new Error('down'); } });
  assert.deepEqual(r.retried, [fx.refuse.proposalId]);
  assert.equal(r.remaining.length, 1);
});

test('process heals a gap by retrying accrual, then processes', async () => {
  assert.equal(await linesFor(fx.heal.shiftId), 0);
  const r = await req('POST', `/api/admin/payroll/periods/${fx.heal.periodId}/process`, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accrual_gaps_healed, 1);
  assert.equal(await linesFor(fx.heal.shiftId), 1, 'the staffer now has a pay line');
});

test('process refuses while a gap survives the retry, and the period stays open', async () => {
  failAccrual = true;
  try {
    const r = await req('POST', `/api/admin/payroll/periods/${fx.refuse.periodId}/process`, adminToken);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(`no pay line and a retry did not fix it \\(proposal ${fx.refuse.proposalId}\\)`));
    const st = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [fx.refuse.periodId]);
    assert.equal(st.rows[0].status, 'open');
  } finally {
    failAccrual = false;
  }
});
