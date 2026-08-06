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
const payrollDutyRouter = require('./payrollDuty');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollDuty.test.js refuses to run against production');
}

// Owns a UNIQUE far-past period (Tue 2018-09-04 .. Mon 2018-09-10). Two
// approved bartenders make bar_rental multi-eligible, so accrual leaves it
// pending attribution and the Process gate has something to block on.
let adminId, adminToken, server, baseUrl;
let aId, bId, cId; // A + B bartenders, C barback
let periodId, proposalId, shiftId;

const EMAILS = "email IN ('duty-api-admin@example.com','duty-api-a@example.com','duty-api-b@example.com','duty-api-c@example.com')";

async function preClean() {
  await pool.query(`DELETE FROM payout_duty_lines WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM duty_attributions WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shifts WHERE event_date = '2018-09-05' AND proposal_id IN (SELECT id FROM proposals WHERE event_type = 'duty-api-fixture')`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'duty-api-fixture'`);
  await pool.query(`DELETE FROM pay_periods WHERE start_date = '2018-09-04' AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM users WHERE ${EMAILS}`);
}

before(async () => {
  await preClean();
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('duty-api-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const mk = async (email) => (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id`, [email]
  )).rows[0].id;
  aId = await mk('duty-api-a@example.com');
  bId = await mk('duty-api-b@example.com');
  cId = await mk('duty-api-c@example.com');
  for (const uid of [aId, bId, cId]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [uid]
    );
  }

  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2018-09-04','2018-09-10','2018-09-11','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`
  );
  periodId = p.rows[0].id;

  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, num_bars, pricing_snapshot)
     VALUES (NULL, '2018-09-05', 'completed', 'duty-api-fixture', '6:00 PM', 4, 500, 500, 1,
             '{"bar_rental":{"total":50},"addons":[]}')
     RETURNING id`
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2018-09-05','6:00 PM','open',$1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  for (const [uid, position] of [[aId, 'Bartender'], [bId, 'Bartender'], [cId, 'Barback']]) {
    await pool.query(
      "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,$3,'approved')",
      [shiftId, uid, position]
    );
  }
  await accruePayoutsForProposal(proposalId);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use('/api/admin', payrollDutyRouter);
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
  await preClean();
  await pool.end();
});

function req(method, path, token, body) {
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

async function payoutOf(uid) {
  const { rows } = await pool.query(
    'SELECT id, total_cents FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [periodId, uid]
  );
  return rows[0];
}

test('accrual left bar_rental pending; GET unattributed-duties reports it with both bartenders eligible', async () => {
  const lines = await pool.query(
    `SELECT 1 FROM payout_duty_lines WHERE kind = 'bar_rental' AND shift_id = $1`, [shiftId]
  );
  assert.equal(lines.rowCount, 0, 'no line materializes before attribution');
  const r = await req('GET', `/api/admin/payroll/periods/${periodId}/unattributed-duties`, adminToken);
  assert.equal(r.status, 200);
  const item = r.body.items.find(i => i.proposal_id === proposalId && i.kind === 'bar_rental');
  assert.ok(item, 'bar_rental listed as unattributed');
  assert.equal(item.stale, false);
  assert.deepEqual([...item.eligible_user_ids].sort(), [aId, bId].sort());
  assert.ok(r.body.users[aId] && r.body.users[bId], 'display names ride the payload');
});

test('Process 409s while a duty is unattributed (plain message, list comes from the GET)', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /unattributed duties/);
});

test('PUT attribution materializes the line; moving it re-homes the money transactionally', async () => {
  let r = await req('PUT', '/api/admin/payroll/duty-attributions', adminToken, {
    proposal_id: proposalId, kind: 'bar_rental', user_id: aId,
  });
  assert.equal(r.status, 200);
  const a1 = await payoutOf(aId);
  const linesA = await pool.query(
    `SELECT removed_at FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'bar_rental'`, [a1.id]
  );
  assert.equal(linesA.rowCount, 1, 'first-time attribution materialized the line');
  assert.equal(linesA.rows[0].removed_at, null);
  // Wage 5.5h @ $20 = 11000, + bar 2000.
  assert.equal(Number(a1.total_cents), 13000);

  // Move it to B: A's line system-removes, B's materializes, both totals move.
  r = await req('PUT', '/api/admin/payroll/duty-attributions', adminToken, {
    proposal_id: proposalId, kind: 'bar_rental', user_id: bId,
  });
  assert.equal(r.status, 200);
  const a2 = await payoutOf(aId);
  const b2 = await payoutOf(bId);
  assert.equal(Number(a2.total_cents), 11000, 'A back to wage only');
  assert.equal(Number(b2.total_cents), 13000, 'B carries the bar line');

  // Barback is not eligible for a bar duty.
  r = await req('PUT', '/api/admin/payroll/duty-attributions', adminToken, {
    proposal_id: proposalId, kind: 'bar_rental', user_id: cId,
  });
  assert.equal(r.status, 409);
});

test('manual line: create validates kind and cap, edit stamps admin_owned, remove/restore round-trips', async () => {
  const b = await payoutOf(bId);
  let r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'nonsense', amount_cents: 2000,
  });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'equipment_supplies', amount_cents: 2000000,
  });
  assert.equal(r.status, 400, 'cap rejected');
  r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'equipment_supplies', amount_cents: 2000, shift_id: shiftId, note: 'manual pickup',
  });
  assert.equal(r.status, 200);
  const lineId = r.body.duty_line.id;
  assert.equal(r.body.duty_line.label, 'Equipment & supplies');
  assert.equal(r.body.payout_total_cents, 15000, '13000 + manual 2000');

  r = await req('PATCH', `/api/admin/payroll/duty-lines/${lineId}`, adminToken, { amount_cents: 2500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.duty_line.admin_owned, true);
  assert.equal(r.body.payout_total_cents, 15500);

  r = await req('POST', `/api/admin/payroll/duty-lines/${lineId}/remove`, adminToken, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.payout_total_cents, 13000);
  r = await req('POST', `/api/admin/payroll/duty-lines/${lineId}/remove`, adminToken, {});
  assert.equal(r.status, 409, 'double remove refused');
  r = await req('POST', `/api/admin/payroll/duty-lines/${lineId}/restore`, adminToken, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.payout_total_cents, 15500, 'restore returns the stored amount');

  const audit = await pool.query(
    `SELECT action FROM admin_audit_log WHERE actor_user_id = $1 AND action LIKE 'duty_%' ORDER BY id`,
    [adminId]
  );
  const actions = audit.rows.map(x => x.action);
  for (const expected of ['duty_attribution_set', 'duty_line_create', 'duty_line_edit', 'duty_line_remove', 'duty_line_restore']) {
    assert.ok(actions.includes(expected), `audit log carries ${expected}`);
  }
  // leave the manual line removed so the Process test below sees clean money
  await req('POST', `/api/admin/payroll/duty-lines/${lineId}/remove`, adminToken, {});
});

test('manual create: review kinds rejected; NULL-shift duplicates 409; bad shift 400s', async () => {
  const b = await payoutOf(bId);
  let r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'review_bounty', amount_cents: 1000,
  });
  assert.equal(r.status, 400, 'review money only flows from the reviews surface');
  r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'out_of_area', amount_cents: 1500, shift_id: 'abc',
  });
  assert.equal(r.status, 400, 'non-integer shift_id is a 400, not a 500');
  // NULL-shift line dedup is an explicit check (partial index can't fire on NULL).
  r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'out_of_area', amount_cents: 1500,
  });
  assert.equal(r.status, 200);
  const lineId = r.body.duty_line.id;
  r = await req('POST', '/api/admin/payroll/duty-lines', adminToken, {
    payout_id: b.id, kind: 'out_of_area', amount_cents: 1500,
  });
  assert.equal(r.status, 409, 'double-submit cannot double-pay');
  // Edit to $0 is allowed (distinct from removal).
  r = await req('PATCH', `/api/admin/payroll/duty-lines/${lineId}`, adminToken, { amount_cents: 0 });
  assert.equal(r.status, 200);
  await req('POST', `/api/admin/payroll/duty-lines/${lineId}/remove`, adminToken, {});
});

test('frozen payout refuses duty edits', async () => {
  const b = await payoutOf(bId);
  const line = await pool.query(
    `SELECT id FROM payout_duty_lines WHERE payout_id = $1 AND kind = 'bar_rental' AND removed_at IS NULL`,
    [b.id]
  );
  await pool.query(`UPDATE payouts SET status = 'paid' WHERE id = $1`, [b.id]);
  const r = await req('PATCH', `/api/admin/payroll/duty-lines/${line.rows[0].id}`, adminToken, { amount_cents: 100 });
  assert.equal(r.status, 409);
  await pool.query(`UPDATE payouts SET status = 'pending' WHERE id = $1`, [b.id]);
});

test('Process succeeds once every duty is attributed', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(p.rows[0].status, 'processing');
});
