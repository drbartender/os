require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.planQueue.test.js refuses to run against production');
}

// The admin GET /shifts feed carries the Plan-column facts (2026-08-25):
// shopping_list_status, consult_at, menu_done, package_category, package_name.
//
// The load-bearing assertion here is the FAN-OUT one. drink_plans.proposal_id
// has an index but no unique constraint, so the obvious `LEFT JOIN drink_plans`
// would duplicate the EVENT ROW once a proposal grew a second plan, silently
// double-listing an event on the admin list. planQueueSql uses a LATERAL with
// ORDER BY id DESC LIMIT 1 instead; this suite proves it.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken;
let clientId, twoPlanPid, twoPlanShift, consultPid, consultShift, menuPid, menuShift;

async function mkProposal(status, extraCols = '', extraVals = '') {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid,
                            pricing_snapshot${extraCols})
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', $2, 'planqueue-fixture',
             1000, 400, '{"addons":[]}'${extraVals})
     RETURNING id`,
    [clientId, status]
  );
  return r.rows[0].id;
}

async function mkShift(proposalId, label) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name,
                         positions_needed, proposal_id)
     VALUES (CURRENT_DATE + 30, '18:00', '22:00', 'open', 'X', $1, '["Bartender"]', $2)
     RETURNING id`,
    [`${label} ${NONCE}`, proposalId]
  );
  return r.rows[0].id;
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`planqueue-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`PlanQueue Client ${NONCE}`, `planqueue-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // (1) TWO drink plans on one proposal: the shape the schema permits and the
  // LATERAL exists to survive. Newest (highest id) must win.
  twoPlanPid = await mkProposal('confirmed');
  twoPlanShift = await mkShift(twoPlanPid, 'TwoPlan');
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, client_name, status, shopping_list_status)
     VALUES ($1, $2, 'submitted', 'pending_review'), ($1, $2, 'reviewed', 'approved')`,
    [twoPlanPid, `TwoPlan ${NONCE}`]
  );

  // (2) Consults: one CANCELLED later slot and one live earlier slot. The
  // cancelled one must not win despite being scheduled later.
  consultPid = await mkProposal('deposit_paid');
  consultShift = await mkShift(consultPid, 'Consult');
  await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, status) VALUES
       ($1, $2, NOW() + INTERVAL '3 days', 'scheduled'),
       ($1, $2, NOW() + INTERVAL '9 days', 'cancelled')`,
    [clientId, consultPid]
  );

  // (3) menu_not_required alone must settle menu_done, with no uploaded key.
  menuPid = await mkProposal('confirmed', ', menu_not_required', ", true");
  menuShift = await mkShift(menuPid, 'Menu');

  const app = express();
  app.use(express.json());
  app.use('/api/shifts', shiftsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const pids = [twoPlanPid, consultPid, menuPid].filter(Boolean);
  const sids = [twoPlanShift, consultShift, menuShift].filter(Boolean);
  if (sids.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [sids]);
  if (pids.length) {
    await pool.query('DELETE FROM consults WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

const rowsFor = (body, id) => body.filter((r) => r.id === id);

test('the admin feed carries every Plan-column field', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const row = rowsFor(r.body, twoPlanShift)[0];
  assert.ok(row, 'the fixture event is listed');
  for (const k of ['shopping_list_status', 'consult_at', 'menu_done', 'package_category', 'package_name']) {
    assert.ok(k in row, `feed carries ${k}`);
  }
});

test('a proposal with TWO drink plans lists its event ONCE, newest plan winning', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200);
  const rows = rowsFor(r.body, twoPlanShift);
  assert.equal(rows.length, 1, `event must appear once, saw ${rows.length} (LATERAL fan-out guard)`);
  assert.equal(rows[0].shopping_list_status, 'approved', 'the higher-id plan wins');
});

test('consult_at takes the live consult and ignores a cancelled later one', async () => {
  const r = await get('/api/shifts', adminToken);
  const rows = rowsFor(r.body, consultShift);
  assert.equal(rows.length, 1, 'two consults must not duplicate the event row');
  const at = new Date(rows[0].consult_at);
  const days = Math.round((at - Date.now()) / 86400000);
  assert.equal(days, 3, `expected the live 3-day-out consult, got ${rows[0].consult_at}`);
});

test('menu_not_required alone settles menu_done', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = rowsFor(r.body, menuShift)[0];
  assert.equal(row.menu_done, true, 'an explicit not-required flag counts as settled');
});

test('an event with no drink plan and no consult reports nulls, not a missing row', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = rowsFor(r.body, menuShift)[0];
  assert.equal(row.shopping_list_status, null);
  assert.equal(row.consult_at, null);
});
