require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const { rollForwardLateTip } = require('../../utils/payrollLateTip');
const { clawbackTip } = require('../../utils/payrollClawback');
const { payPeriodForDate, computePayday } = require('../../utils/payrollPeriods');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const payrollRouter = require('./payroll');
const contractorTipPageRouter = require('./contractorTipPage');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.redesign.test.js refuses to run against production');
}

// Payroll-redesign suite: reopened lifecycle, drift guard, zelle, reference,
// rollups, early-process force guard. Fixtures live in a far-past period
// (2018-06-05, unique to this suite) and a far-future one (2099-06-01), so
// today's REAL Chicago period on the shared dev DB is never touched.
let adminId, adminToken, server, baseUrl;
let aId, bId, cId;           // contractors: A venmo, B zelle, C $0 payout
let periodId, futurePeriodId, proposalId, shiftId;
let payoutA, payoutB, payoutC, lineB;

const EMAILS = "email IN ('pr-redesign-admin@example.com','pr-redesign-a@example.com','pr-redesign-b@example.com','pr-redesign-c@example.com')";

async function preClean() {
  await pool.query(`DELETE FROM tips WHERE stripe_payment_intent_id LIKE 'pi_pr_redesign_%'`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shifts WHERE event_date = '2018-06-06' AND proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '2018-06-06' AND event_type = 'birthday-party')`);
  await pool.query(`DELETE FROM proposals WHERE client_id IS NULL AND event_date = '2018-06-06' AND event_type = 'birthday-party'`);
  await pool.query(`DELETE FROM pay_periods WHERE start_date IN ('2018-06-05','2099-06-01') AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pay_periods.id)`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM users WHERE ${EMAILS}`);
}

before(async () => {
  await preClean();

  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('pr-redesign-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const mk = async (email) => (await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id`, [email]
  )).rows[0].id;
  aId = await mk('pr-redesign-a@example.com');
  bId = await mk('pr-redesign-b@example.com');
  cId = await mk('pr-redesign-c@example.com');

  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method, venmo_handle)
     VALUES ($1, 'venmo', 'pr-redesign-a')
     ON CONFLICT (user_id) DO UPDATE SET preferred_payment_method='venmo', venmo_handle='pr-redesign-a'`,
    [aId]
  );
  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method, zelle_handle)
     VALUES ($1, 'zelle', '(214) 555-0138')
     ON CONFLICT (user_id) DO UPDATE SET preferred_payment_method='zelle', zelle_handle='(214) 555-0138'`,
    [bId]
  );

  // Far-past period owned by this suite (Tue 2018-06-05 .. Mon 2018-06-11).
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2018-06-05','2018-06-11','2018-06-12','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`
  );
  periodId = p.rows[0].id;

  // Proposal + shift inside the period: the accrual-fence test fires
  // accruePayoutsForProposal at this proposal while the period is reopened.
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, '2018-06-06', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2018-06-06','6:00 PM','open',$1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;

  // Payout A: venmo, one 21000 line. Payout B: zelle, one 15000 line
  // (hours 5.0 x $20 wage 10000 + gratuity 5000). Payout C: $0, no lines
  // (the H1-clamp designed state; exercises expected_total_cents: 0).
  const mkPayout = async (uid, cents) => (await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'pending', $3) RETURNING id`, [periodId, uid, cents]
  )).rows[0].id;
  payoutA = await mkPayout(aId, 21000);
  payoutB = await mkPayout(bId, 15000);
  payoutC = await mkPayout(cId, 0);
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, gratuity_share_cents, line_total_cents)
     VALUES ($1, $2, 5.5, 5.5, 2000, 11000, 10000, 21000)`,
    [payoutA, shiftId]
  );
  lineB = (await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, gratuity_share_cents, line_total_cents)
     VALUES ($1, $2, 5.0, 5.0, 2000, 10000, 5000, 15000) RETURNING id`,
    [payoutB, shiftId]
  )).rows[0].id;

  // Far-future period (2099): end_date >= Chicago-today for the force guard.
  const f = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2099-06-01','2099-06-07','2099-06-08','open')
     ON CONFLICT (start_date) DO UPDATE SET status='open' RETURNING id`
  );
  futurePeriodId = f.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use('/api/admin', contractorTipPageRouter);
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
  await pool.query(`DELETE FROM tips WHERE stripe_payment_intent_id LIKE 'pi_pr_redesign_%'`);
  await pool.query('DELETE FROM shift_requests WHERE user_id IN ($1,$2,$3)', [aId, bId, cId]);
  await pool.query('DELETE FROM payout_events WHERE payout_id IN ($1,$2,$3)', [payoutA, payoutB, payoutC]);
  await pool.query('DELETE FROM payouts WHERE id IN ($1,$2,$3)', [payoutA, payoutB, payoutC]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM pay_periods WHERE id IN ($1,$2)', [periodId, futurePeriodId]);
  await pool.query('DELETE FROM admin_audit_log WHERE actor_user_id = $1', [adminId]);
  await pool.query('DELETE FROM payment_profiles WHERE user_id IN ($1,$2,$3)', [aId, bId, cId]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1,$2,$3)', [aId, bId, cId]);
  await pool.query('DELETE FROM users WHERE id IN ($1,$2,$3,$4)', [adminId, aId, bId, cId]);
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

async function payoutSnapshot(ids) {
  const totals = await pool.query(
    'SELECT id, status, total_cents FROM payouts WHERE id = ANY($1::int[]) ORDER BY id', [ids]
  );
  const lines = await pool.query(
    `SELECT id, payout_id, hours, rate_cents, wage_cents, gratuity_share_cents,
            card_tip_net_cents, adjustment_cents, line_total_cents
       FROM payout_events WHERE payout_id = ANY($1::int[]) ORDER BY id`, [ids]
  );
  return JSON.stringify({ totals: totals.rows, lines: lines.rows });
}

// ---- ordered lifecycle walk (node:test runs tests serially in-file) ----

test('rollups: periods list carries additive paid_cents/owed_cents next to the legacy fields', async () => {
  const r = await req('GET', '/api/admin/payroll/periods', adminToken);
  assert.equal(r.status, 200);
  const ours = JSON.parse(r.body).periods.find(p => p.id === periodId);
  assert.ok(ours);
  assert.equal(Number(ours.total_cents), 36000);
  assert.equal(Number(ours.pending_count), 3);
  assert.equal(Number(ours.paid_count), 0);
  assert.equal(Number(ours.owed_cents), 36000);
  assert.equal(Number(ours.paid_cents), 0);
});

test('period payload carries zelle_handle and a null payment_reference', async () => {
  const r = await req('GET', `/api/admin/payroll/periods/${periodId}`, adminToken);
  assert.equal(r.status, 200);
  const { payouts } = JSON.parse(r.body);
  const b = payouts.find(p => p.id === payoutB);
  assert.equal(b.zelle_handle, '(214) 555-0138');
  assert.equal(b.preferred_payment_method, 'zelle');
  assert.equal(b.payment_reference, null);
});

test('reopen an open period > 409', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/reopen`, adminToken);
  assert.equal(r.status, 409);
});

test('process a past period (no force needed) > processing, not finalized', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.period_status, 'processing');
  assert.ok(body.fee_recapture);
});

test('line edit while processing > 409 (freeze holds)', async () => {
  const r = await req('PATCH', `/api/admin/payroll/payout-events/${lineB}`, adminToken, { hours: 6.0 });
  assert.equal(r.status, 409);
});

test('mark A paid without expected_total_cents (legacy path) > 200', async () => {
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutA}/mark-paid`, adminToken,
    { payment_method: 'venmo', payment_handle: '@pr-redesign-a' });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.payout.status, 'paid');
  assert.equal(body.payout.payment_reference, null);
  assert.equal(body.period_status, 'processing');
});

test('reopen a processing period with a paid payout inside > 200 reopened + audit row', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/reopen`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).period.status, 'reopened');
  const audit = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE actor_user_id = $1 AND action = 'payroll_period_reopen'
      ORDER BY id DESC LIMIT 1`, [adminId]
  );
  assert.ok(audit.rows[0], 'reopen audit-logged');
  assert.equal(Number(audit.rows[0].metadata.paid_count), 1);
  assert.equal(Number(audit.rows[0].metadata.pending_count), 2);
});

test('reopened: paid payout line still frozen, pending line editable', async () => {
  const paidLine = await pool.query(
    'SELECT id FROM payout_events WHERE payout_id = $1 LIMIT 1', [payoutA]
  );
  const rPaid = await req('PATCH', `/api/admin/payroll/payout-events/${paidLine.rows[0].id}`, adminToken, { hours: 1 });
  assert.equal(rPaid.status, 409);

  const rPending = await req('PATCH', `/api/admin/payroll/payout-events/${lineB}`, adminToken, { hours: 6.0 });
  assert.equal(rPending.status, 200);
  assert.equal(Number(JSON.parse(rPending.body).payout_total_cents), 17000);
});

test('writers vs reopened: accrual refuses the period and every payout is byte-identical', async () => {
  const beforeSnap = await payoutSnapshot([payoutA, payoutB, payoutC]);
  const result = await accruePayoutsForProposal(proposalId);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'pay_period_not_open');
  assert.equal(result.pay_period_status, 'reopened');
  const afterSnap = await payoutSnapshot([payoutA, payoutB, payoutC]);
  assert.equal(afterSnap, beforeSnap);
});

test('writers vs reopened: late-tip roll-forward and clawback defer instead of writing in', async () => {
  // Destination for both writers is TODAY's Chicago period. Flip it to
  // 'reopened' (track-and-restore, the sanctioned shared-dev-DB pattern) and
  // assert both persist deferral markers and write nothing into it.
  const { startDate, endDate } = payPeriodForDate(chicagoTodayYmd());
  const existing = await pool.query('SELECT id, status FROM pay_periods WHERE start_date = $1 LIMIT 1', [startDate]);
  let todayId, preExisted = false, origStatus = null;
  if (existing.rows[0]) {
    todayId = existing.rows[0].id;
    preExisted = true;
    origStatus = existing.rows[0].status;
  } else {
    const r = await pool.query(
      `INSERT INTO pay_periods (start_date, end_date, payday, status)
       VALUES ($1, $2, $3, 'open') ON CONFLICT (start_date) DO UPDATE SET status = pay_periods.status RETURNING id`,
      [startDate, endDate, computePayday(endDate)]
    );
    todayId = r.rows[0].id;
  }
  // The writers need a real (non-stub) approved bartender on the tip's shift
  // to reach the period check at all.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'bartender', 'approved')`,
    [shiftId, aId]
  );
  const tips = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents, stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_pr_redesign_rf', NOW(), $2),
            (gen_random_uuid(), $1, 5000, 150, 'pi_pr_redesign_cb', NOW(), $2)
     RETURNING id, stripe_payment_intent_id`,
    [aId, shiftId]
  );
  const rfTip = tips.rows.find(t => t.stripe_payment_intent_id === 'pi_pr_redesign_rf').id;
  const cbTip = tips.rows.find(t => t.stripe_payment_intent_id === 'pi_pr_redesign_cb').id;

  try {
    await pool.query("UPDATE pay_periods SET status = 'reopened' WHERE id = $1", [todayId]);
    const beforePayouts = await pool.query(
      'SELECT COUNT(*) AS n FROM payouts WHERE pay_period_id = $1', [todayId]
    );
    const beforeSnap = await payoutSnapshot([payoutA, payoutB, payoutC]);

    await rollForwardLateTip(rfTip);
    const rf = await pool.query(
      'SELECT deferred_at, defer_kind, rolled_forward_at FROM tips WHERE id = $1', [rfTip]
    );
    assert.ok(rf.rows[0].deferred_at, 'roll-forward deferred');
    assert.equal(rf.rows[0].defer_kind, 'roll_forward');
    assert.equal(rf.rows[0].rolled_forward_at, null);

    await clawbackTip(cbTip, 2500);
    const cb = await pool.query(
      'SELECT deferred_at, defer_kind, defer_target_cents, refunded_amount_cents FROM tips WHERE id = $1', [cbTip]
    );
    assert.ok(cb.rows[0].deferred_at, 'clawback deferred');
    assert.equal(cb.rows[0].defer_kind, 'clawback');
    assert.equal(Number(cb.rows[0].defer_target_cents), 2500);
    assert.equal(Number(cb.rows[0].refunded_amount_cents), 0, 'cumulative not advanced');

    const afterPayouts = await pool.query(
      'SELECT COUNT(*) AS n FROM payouts WHERE pay_period_id = $1', [todayId]
    );
    assert.equal(Number(afterPayouts.rows[0].n), Number(beforePayouts.rows[0].n), 'nothing written into the reopened period');
    assert.equal(await payoutSnapshot([payoutA, payoutB, payoutC]), beforeSnap);
  } finally {
    if (preExisted) {
      await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2', [origStatus, todayId]);
    } else {
      await pool.query(
        `DELETE FROM pay_periods pp WHERE pp.id = $1
           AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
        [todayId]
      );
    }
    await pool.query('DELETE FROM tips WHERE id IN ($1,$2)', [rfTip, cbTip]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, aId]);
  }
});

test('reopen and process on an unknown period id > 404', async () => {
  const r1 = await req('POST', '/api/admin/payroll/periods/999999999/reopen', adminToken);
  assert.equal(r1.status, 404);
  const r2 = await req('POST', '/api/admin/payroll/periods/999999999/process', adminToken);
  assert.equal(r2.status, 404);
});

test('mark-paid while reopened > 409', async () => {
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutB}/mark-paid`, adminToken,
    { payment_method: 'zelle' });
  assert.equal(r.status, 409);
});

test('re-process from reopened > processing again', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).period_status, 'processing');
});

test('drift guard: stale expected_total_cents > 409 and payout stays pending', async () => {
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutB}/mark-paid`, adminToken,
    { payment_method: 'zelle', expected_total_cents: 15000 });
  assert.equal(r.status, 409);
  const row = await pool.query('SELECT status FROM payouts WHERE id = $1', [payoutB]);
  assert.equal(row.rows[0].status, 'pending');
});

test('drift guard validation: non-integer, negative, over-long reference > 400', async () => {
  for (const expected_total_cents of [1.5, -1, 'x']) {
    const r = await req('POST', `/api/admin/payroll/payouts/${payoutB}/mark-paid`, adminToken,
      { payment_method: 'zelle', expected_total_cents });
    assert.equal(r.status, 400, `expected_total_cents=${expected_total_cents}`);
  }
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutB}/mark-paid`, adminToken,
    { payment_method: 'zelle', payment_reference: 'x'.repeat(201) });
  assert.equal(r.status, 400);
});

test('mark B paid: zelle + matching expected total + trimmed reference', async () => {
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutB}/mark-paid`, adminToken, {
    payment_method: 'zelle',
    payment_handle: '(214) 555-0138',
    payment_reference: '  Zelle conf #9481  ',
    expected_total_cents: 17000,
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.payout.payment_method, 'zelle');
  assert.equal(body.payout.payment_reference, 'Zelle conf #9481');
  assert.equal(body.period_status, 'processing');
});

test('contractor payouts endpoint returns payment_reference through its explicit map', async () => {
  const r = await req('GET', `/api/admin/payroll/contractors/${bId}/payouts`, adminToken);
  assert.equal(r.status, 200);
  const { payouts } = JSON.parse(r.body);
  assert.equal(payouts[0].payment_reference, 'Zelle conf #9481');
  assert.equal(payouts[0].period.status, 'processing');
});

test('expected_total_cents: 0 against a $0 payout passes; last mark-paid finalizes', async () => {
  const r = await req('POST', `/api/admin/payroll/payouts/${payoutC}/mark-paid`, adminToken,
    { payment_method: 'other', expected_total_cents: 0 });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.payout.status, 'paid');
  assert.equal(body.period_status, 'paid');
});

test('finalized period can never reopen > 409', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/reopen`, adminToken);
  assert.equal(r.status, 409);
});

test('rollups after the run: paid_cents full, owed_cents zero', async () => {
  const r = await req('GET', '/api/admin/payroll/periods', adminToken);
  const ours = JSON.parse(r.body).periods.find(p => p.id === periodId);
  assert.equal(Number(ours.paid_cents), 38000);
  assert.equal(Number(ours.owed_cents), 0);
  assert.equal(Number(ours.paid_count), 3);
  assert.equal(Number(ours.pending_count), 0);
});

test('early-process guard: in-progress period 409s without force, force finalizes zero-payout period', async () => {
  const noForce = await req('POST', `/api/admin/payroll/periods/${futurePeriodId}/process`, adminToken);
  assert.equal(noForce.status, 409);
  assert.match(JSON.parse(noForce.body).error, /still in progress/);

  const forced = await req('POST', `/api/admin/payroll/periods/${futurePeriodId}/process`, adminToken, { force: true });
  assert.equal(forced.status, 200);
  assert.equal(JSON.parse(forced.body).period_status, 'paid'); // zero pending payouts finalize immediately

  const reopen = await req('POST', `/api/admin/payroll/periods/${futurePeriodId}/reopen`, adminToken);
  assert.equal(reopen.status, 409);
});

test('contractorTipPage accepts zelle as a preferred method', async () => {
  const r = await req('PATCH', `/api/admin/contractors/${bId}/tip-page`, adminToken,
    { preferred_payment_method: 'zelle' });
  assert.equal(r.status, 200);
});
