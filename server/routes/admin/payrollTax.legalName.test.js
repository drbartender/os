require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `ptax-ln-${NONCE}@example.com`;
const YEAR = 2025;
let server, baseUrl, token, userId;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  // token_version is RETURNed and signed into the JWT: middleware/auth.js:46
  // compares decoded.tokenVersion against users.token_version, and :41 looks the
  // user up by decoded.userId. A token signed { id, ... } 401s USER_NOT_FOUND.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  token = jwt.sign(
    { userId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'TwistidTreets']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Nevver Sayles', EMAIL]);

  // One ledger row so the contractor appears in the totals. staff_payment_history
  // requires source_account, source_file and a UNIQUE row_fingerprint, platform is
  // CHECK-constrained to a fixed list, and CONSTRAINT sph_before_boundary requires
  // paid_on < 2026-06-02 unless boundary_exception is true. A 2025 date satisfies
  // that naturally.
  await pool.query(
    `INSERT INTO staff_payment_history
       (contractor_id, paid_on, amount_cents, platform, source_account, row_fingerprint, source_file)
     VALUES ($1, DATE '2025-03-15', 25000, 'venmo', 'test-account', $2, 'plan-test')`,
    [userId, `ptax-ln-${NONCE}`]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./payrollTax'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// staff_payment_history.contractor_id is INTEGER NOT NULL REFERENCES users(id)
// with NO ON DELETE CASCADE, so a bare DELETE FROM users raises a foreign-key
// violation, fails teardown, and strands an orphan row plus a permanently
// consumed UNIQUE row_fingerprint in the shared dev database.
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) {
    await pool.query('DELETE FROM staff_payment_history WHERE contractor_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await pool.end();
});

test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('GET', `/api/admin/payroll/tax-totals?year=${YEAR}`);
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
  assert.notEqual(res.status, 404, 'route path is wrong');
});

test('the 1099 list labels rows with the LEGAL name, never the nickname', async () => {
  const res = await req('GET', `/api/admin/payroll/tax-totals?year=${YEAR}`);
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'seeded contractor missing from the 1099 list');
  assert.equal(row.name, 'Nevver Sayles');
  assert.ok(!row.name.includes('Twistid'));
});

test('payment-history blended total ignores no_draw payouts (1099 exclusion pin)', async () => {
  // Spec 2026-08-07: tax surfaces count REAL money only. This exercises the
  // actual paidPayoutCents path via the route, not an equivalent SQL sum.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-09-03','2019-09-09','2019-09-10','paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`
  );
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'no_draw', 12345)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'no_draw', total_cents = 12345
     RETURNING id`,
    [pp.rows[0].id, userId]
  );
  try {
    const res = await req('GET', `/api/admin/payroll/contractors/${userId}/payment-history`);
    assert.equal(res.status, 200);
    // Fixture ledger is 25000 and this user has NO paid payouts, so the
    // blended total must equal the ledger alone: the no_draw 12345 is absent.
    assert.equal(res.body.total_cents, 25000);
    assert.equal(res.body.blended_total_cents, 25000);
  } finally {
    await pool.query('DELETE FROM payouts WHERE id = $1', [po.rows[0].id]);
    await pool.query(
      `DELETE FROM pay_periods p WHERE p.id = $1
         AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = p.id)`,
      [pp.rows[0].id]
    );
  }
});
