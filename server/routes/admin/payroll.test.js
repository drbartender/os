require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const payrollRouter = require('./payroll');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.test.js refuses to run against production');
}

let adminId, adminToken, server, baseUrl;
let contractorId, periodId, payoutId, shiftId, proposalId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('payroll-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: 0 },  // matches server/middleware/auth.js contract
    process.env.JWT_SECRET
  );

  const c = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('payroll-contractor@example.com','x','staff') RETURNING id"
  );
  contractorId = c.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [contractorId]
  );
  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method, venmo_handle)
     VALUES ($1, 'venmo', 'payroll-test')
     ON CONFLICT (user_id) DO UPDATE SET preferred_payment_method='venmo', venmo_handle='payroll-test'`,
    [contractorId]
  );

  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-26','2026-06-01','2026-06-02','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`
  );
  periodId = p.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, pricing_snapshot)
     VALUES (NULL, '2026-05-29', 'completed', 'birthday-party', '6:00 PM', 4, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-29','6:00 PM','open',$1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'pending', 21000) RETURNING id`,
    [periodId, contractorId]
  );
  payoutId = po.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, line_total_cents)
     VALUES ($1, $2, 5.5, 5.5, 2000, 11000, 10000, 21000)`,
    [payoutId, shiftId]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  await pool.query('DELETE FROM payout_events WHERE payout_id = $1', [payoutId]);
  await pool.query('DELETE FROM payouts WHERE id = $1', [payoutId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
  await pool.query('DELETE FROM payment_profiles WHERE user_id = $1', [contractorId]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [contractorId]);
  await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [adminId, contractorId]);
  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname, headers,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('GET /payroll/healthcheck > 200 for an admin', async () => {
  const r = await req('GET', '/api/admin/payroll/healthcheck', adminToken);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('GET /payroll/healthcheck > 401 without a token', async () => {
  const r = await req('GET', '/api/admin/payroll/healthcheck', null);
  assert.equal(r.status, 401);
});

test('GET /payroll/periods > lists periods with summary counts', async () => {
  const r = await req('GET', '/api/admin/payroll/periods', adminToken);
  assert.equal(r.status, 200);
  const { periods } = JSON.parse(r.body);
  assert.ok(Array.isArray(periods));
  const ours = periods.find(p => p.id === periodId);
  assert.ok(ours, 'fixture period in the list');
  assert.equal(ours.status, 'open');
  assert.equal(Number(ours.pending_count), 1);
  assert.equal(Number(ours.paid_count), 0);
});

test('GET /payroll/periods/current > returns the open period with payouts and events', async () => {
  const r = await req('GET', '/api/admin/payroll/periods/current', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.period.id, periodId);
  const payout = body.payouts.find(p => p.id === payoutId);
  assert.ok(payout);
  assert.equal(payout.contractor_id, contractorId);
  assert.equal(payout.preferred_payment_method, 'venmo');
  assert.equal(payout.venmo_handle, 'payroll-test');
  assert.equal(payout.events.length, 1);
  assert.equal(payout.events[0].wage_cents, 11000);
});

test('GET /payroll/periods/:id > returns the same shape for a specific period', async () => {
  const r = await req('GET', `/api/admin/payroll/periods/${periodId}`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.period.id, periodId);
  assert.equal(body.payouts.length, 1);
});

test('GET /payroll/periods/:id > 404 for a nonexistent id', async () => {
  const r = await req('GET', '/api/admin/payroll/periods/999999999', adminToken);
  assert.equal(r.status, 404);
});

test('PATCH /payout-events/:id > updates hours, recomputes wage and totals', async () => {
  // The fixture row has hours=5.5, rate_cents=2000, wage=11000, gratuity=10000,
  // adjustment=0 -> line_total=21000 and payout.total=21000.
  const eventRow = await pool.query(
    'SELECT id FROM payout_events WHERE payout_id = $1', [payoutId]
  );
  const eventId = eventRow.rows[0].id;
  try {
    const r = await req(
      'PATCH', `/api/admin/payroll/payout-events/${eventId}`, adminToken, { hours: 9 }
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    // wage = round(9 * 2000) = 18000; line_total = 18000 + 10000 + 0 + 0 = 28000.
    assert.equal(body.event.wage_cents, 18000);
    assert.equal(body.event.line_total_cents, 28000);
    assert.equal(body.payout_total_cents, 28000);
    const { rows } = await pool.query(
      'SELECT total_cents FROM payouts WHERE id = $1', [payoutId]
    );
    assert.equal(rows[0].total_cents, 28000);
  } finally {
    // Reset the fixture so other tests see the baseline.
    await pool.query(
      `UPDATE payout_events SET hours = 5.5, wage_cents = 11000, adjustment_cents = 0,
                                line_total_cents = 21000
         WHERE id = $1`, [eventId]
    );
    await pool.query('UPDATE payouts SET total_cents = 21000 WHERE id = $1', [payoutId]);
  }
});

test('PATCH /payout-events/:id > 409 when the payout is already paid', async () => {
  const eventRow = await pool.query(
    'SELECT id FROM payout_events WHERE payout_id = $1', [payoutId]
  );
  const eventId = eventRow.rows[0].id;
  await pool.query("UPDATE payouts SET status = 'paid' WHERE id = $1", [payoutId]);
  try {
    const r = await req(
      'PATCH', `/api/admin/payroll/payout-events/${eventId}`, adminToken, { hours: 6 }
    );
    assert.equal(r.status, 409);
  } finally {
    await pool.query("UPDATE payouts SET status = 'pending' WHERE id = $1", [payoutId]);
  }
});

test('PATCH /payout-events/:id > 400 on out-of-range hours', async () => {
  const eventRow = await pool.query(
    'SELECT id FROM payout_events WHERE payout_id = $1', [payoutId]
  );
  const r = await req(
    'PATCH', `/api/admin/payroll/payout-events/${eventRow.rows[0].id}`,
    adminToken, { hours: 99 }
  );
  assert.equal(r.status, 400);
});
