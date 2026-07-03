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
  // Pre-clean any stranded fixtures from a prior interrupted run (this suite
  // seeds its own admin + contractor + proposal/shift/payout chain and had no
  // pre-clean, so a crash mid-run left the unique emails behind).
  const emails = "email IN ('payroll-admin@example.com','payroll-contractor@example.com')";
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${emails}))`);
  await pool.query(`DELETE FROM payout_events WHERE shift_id IN (SELECT id FROM shifts WHERE event_date = '2026-05-29' AND proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '2026-05-29' AND event_type = 'birthday-party'))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${emails})`);
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${emails})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${emails})`);
  await pool.query(`DELETE FROM users WHERE ${emails}`);
  await pool.query(`DELETE FROM shifts WHERE event_date = '2026-05-29' AND proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '2026-05-29' AND event_type = 'birthday-party')`);
  await pool.query(`DELETE FROM proposals WHERE client_id IS NULL AND event_date = '2026-05-29' AND event_type = 'birthday-party'`);

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
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, '2026-05-29', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000,
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

test('PATCH /payout-events/:id > 409 when the period is processing', async () => {
  // mark-paid requires processing and copies the stored total_cents, so edits
  // during processing must be frozen or the recorded payout diverges from what
  // was sent.
  const eventRow = await pool.query(
    'SELECT id FROM payout_events WHERE payout_id = $1', [payoutId]
  );
  const eventId = eventRow.rows[0].id;
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  try {
    const r = await req(
      'PATCH', `/api/admin/payroll/payout-events/${eventId}`, adminToken, { hours: 6 }
    );
    assert.equal(r.status, 409);
  } finally {
    await pool.query("UPDATE pay_periods SET status = 'open' WHERE id = $1", [periodId]);
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

test('POST /periods/:id/process > flips an open period to processing', async () => {
  const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.period.status, 'processing');
  // Reset for the rest of the suite.
  await pool.query("UPDATE pay_periods SET status = 'open' WHERE id = $1", [periodId]);
});

test('POST /periods/:id/process > 409 when not open', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  try {
    const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
    assert.equal(r.status, 409);
  } finally {
    await pool.query("UPDATE pay_periods SET status = 'open' WHERE id = $1", [periodId]);
  }
});

test('POST /payouts/:id/mark-paid > marks paid, records method, and finalizes the period', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  try {
    const r = await req(
      'POST', `/api/admin/payroll/payouts/${payoutId}/mark-paid`, adminToken,
      { payment_method: 'venmo', payment_handle: 'payroll-test' }
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.payout.status, 'paid');
    assert.equal(body.payout.payment_method, 'venmo');
    assert.equal(body.payout.payment_handle, 'payroll-test');
    assert.ok(body.payout.paid_at);
    // The fixture is the only payout in this period, so the period flipped to paid.
    assert.equal(body.period_status, 'paid');
  } finally {
    await pool.query(
      `UPDATE payouts SET status='pending', payment_method=NULL, payment_handle=NULL,
                          paid_at=NULL, paid_by=NULL WHERE id = $1`,
      [payoutId]
    );
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});

test('POST /payouts/:id/mark-paid > 409 when the period is still open', async () => {
  // periodId is currently 'open' (the prior test reset it).
  const r = await req(
    'POST', `/api/admin/payroll/payouts/${payoutId}/mark-paid`, adminToken,
    { payment_method: 'venmo' }
  );
  assert.equal(r.status, 409);
});

test('POST /payouts/:id/mark-paid > 400 on an invalid method', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  try {
    const r = await req(
      'POST', `/api/admin/payroll/payouts/${payoutId}/mark-paid`, adminToken,
      { payment_method: 'bitcoin' }
    );
    assert.equal(r.status, 400);
  } finally {
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});

test('GET /unassigned-tips > lists tips with NULL shift_id and candidate shifts', async () => {
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 'pi_unassigned_test', '2026-05-29 23:30:00+00')
     RETURNING id`,
    [contractorId]
  );
  const tipId = tip.rows[0].id;
  try {
    // Make the contractor an approved bartender on the fixture shift so it
    // shows up in candidate_shifts.
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [shiftId, contractorId]
    );
    const r = await req('GET', '/api/admin/payroll/unassigned-tips', adminToken);
    assert.equal(r.status, 200);
    const { tips } = JSON.parse(r.body);
    const ours = tips.find(t => t.id === tipId);
    assert.ok(ours, 'fixture tip listed');
    assert.equal(ours.amount_cents, 5000);
    assert.ok(Array.isArray(ours.candidate_shifts));
    assert.ok(ours.candidate_shifts.find(c => c.shift_id === shiftId), 'fixture shift in candidates');
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
      [shiftId, contractorId]
    );
  }
});

test('PATCH /tips/:id/assign > sets shift_id and re-accrues for open period', async () => {
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_assign_test', '2026-05-29 23:30:00+00')
     RETURNING id`,
    [contractorId]
  );
  const tipId = tip.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [shiftId, contractorId]
    );
    const r = await req(
      'PATCH', `/api/admin/payroll/tips/${tipId}/assign`, adminToken,
      { shift_id: shiftId }
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.tip.shift_id, shiftId);
    assert.equal(body.frozen_period, false);
    // The re-accrual should have folded the tip into the contractor's payout_event.
    const { rows } = await pool.query(
      `SELECT card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents
         FROM payout_events WHERE shift_id = $1 AND payout_id = $2`,
      [shiftId, payoutId]
    );
    assert.equal(rows[0].card_tip_gross_cents, 4000);
    assert.equal(rows[0].card_tip_fee_cents, 128);
    assert.equal(rows[0].card_tip_net_cents, 3872);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
      [shiftId, contractorId]
    );
    // Reset the line-item back to baseline (no tip) for downstream tests.
    await pool.query(
      `UPDATE payout_events
          SET card_tip_gross_cents=0, card_tip_fee_cents=0, card_tip_net_cents=0,
              line_total_cents=21000
         WHERE payout_id = $1`,
      [payoutId]
    );
    await pool.query('UPDATE payouts SET total_cents=21000 WHERE id = $1', [payoutId]);
  }
});

test('PATCH /tips/:id/assign > frozen_period=true when the shift sits in a paid period', async () => {
  await pool.query("UPDATE pay_periods SET status='paid' WHERE id = $1", [periodId]);
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_frozen_test', '2026-05-29 23:30:00+00')
     RETURNING id`,
    [contractorId]
  );
  const tipId = tip.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [shiftId, contractorId]
    );
    const r = await req(
      'PATCH', `/api/admin/payroll/tips/${tipId}/assign`, adminToken,
      { shift_id: shiftId }
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.tip.shift_id, shiftId);
    assert.equal(body.frozen_period, true);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
      [shiftId, contractorId]
    );
    // rollForwardLateTip placed the tip into TODAY's open period as a synthetic
    // payout + payout_event on the ORIGINAL shift, under a NEW payout the shared
    // `after` hook does not know about. Remove those (and the now-empty today
    // period) so the shift delete (FK RESTRICT) is not blocked and no stray open
    // period lingers for the next run's periods/current check.
    await pool.query(
      `DELETE FROM payout_events WHERE shift_id = $1
         AND payout_id IN (SELECT id FROM payouts WHERE contractor_id = $2 AND id <> $3)`,
      [shiftId, contractorId, payoutId]
    );
    await pool.query(
      'DELETE FROM payouts WHERE contractor_id = $1 AND id <> $2',
      [contractorId, payoutId]
    );
    await pool.query(
      `DELETE FROM pay_periods pp
        WHERE pp.status = 'open'
          AND CURRENT_DATE BETWEEN pp.start_date AND pp.end_date
          AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`
    );
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});

test('GET /contractors/:userId/payouts > returns the contractor history with periods and totals', async () => {
  const r = await req('GET', `/api/admin/payroll/contractors/${contractorId}/payouts`, adminToken);
  assert.equal(r.status, 200);
  const { payouts } = JSON.parse(r.body);
  assert.ok(Array.isArray(payouts));
  const ours = payouts.find(p => p.id === payoutId);
  assert.ok(ours);
  assert.equal(ours.total_cents, 21000);
  assert.equal(ours.period.id, periodId);
  assert.equal(Number(ours.event_count), 1);
});

test('POST /periods/:id/process > recaptures a null-fee tip and folds the captured fee into the payout line', async () => {
  // L5: a tip whose Stripe fee was unavailable at accrual keeps fee_cents NULL and
  // pays GROSS. Processing must re-capture the fee and re-accrue first. Make the
  // contractor an approved bartender so re-accrual actually recomputes the line.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1,$2,'Bartender','approved')
     ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved', position='Bartender'`,
    [shiftId, contractorId]
  );
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents, shift_id,
                       stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 4000, NULL, $2, 'pi_l5_capture', '2026-05-29 23:30:00+00')
     RETURNING id`,
    [contractorId, shiftId]
  );
  const tipId = tip.rows[0].id;

  // Fake the Stripe fee source the accrual capture path reads (getStripe() returns
  // a cached client; stub the method it calls and restore after).
  const stripe = require('../../utils/stripeClient').getStripe();
  assert.ok(stripe, 'a Stripe client is available in this environment');
  const origRetrieve = stripe.paymentIntents.retrieve;
  stripe.paymentIntents.retrieve = async () => ({
    latest_charge: { balance_transaction: { fee: 90 } },
  });

  try {
    const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.period.status, 'processing');
    assert.ok(body.fee_recapture, 'summary returned');
    assert.ok(body.fee_recapture.tips_null_before >= 1, 'at least one null-fee tip found');
    assert.equal(body.fee_recapture.tips_null_after, 0, 'no null-fee tips remain after capture');

    // The captured fee ($0.90) flowed into the payout line: gross 4000, fee 90, net 3910.
    const { rows } = await pool.query(
      `SELECT card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents
         FROM payout_events WHERE shift_id = $1 AND payout_id = $2`,
      [shiftId, payoutId]
    );
    assert.equal(Number(rows[0].card_tip_gross_cents), 4000);
    assert.equal(Number(rows[0].card_tip_fee_cents), 90, 'captured fee stored on the line');
    assert.equal(Number(rows[0].card_tip_net_cents), 3910);

    // The tip's fee_cents was persisted by the capture.
    const t = await pool.query('SELECT fee_cents FROM tips WHERE id = $1', [tipId]);
    assert.equal(Number(t.rows[0].fee_cents), 90);
  } finally {
    stripe.paymentIntents.retrieve = origRetrieve;
    await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, contractorId]
    );
    await pool.query(
      `UPDATE payout_events
          SET card_tip_gross_cents=0, card_tip_fee_cents=0, card_tip_net_cents=0,
              wage_cents=11000, gratuity_share_cents=10000, line_total_cents=21000
         WHERE payout_id = $1`,
      [payoutId]
    );
    await pool.query('UPDATE payouts SET total_cents=21000 WHERE id = $1', [payoutId]);
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});

test('POST /periods/:id/process > proceeds and warns when a tip fee stays null after retry', async () => {
  // L5: a Stripe outage must never blockade payroll. When re-capture still cannot
  // resolve the fee, processing proceeds and the residual is warned to Sentry.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1,$2,'Bartender','approved')
     ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved', position='Bartender'`,
    [shiftId, contractorId]
  );
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents, shift_id,
                       stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 4000, NULL, $2, 'pi_l5_stillnull', '2026-05-29 23:30:00+00')
     RETURNING id`,
    [contractorId, shiftId]
  );
  const tipId = tip.rows[0].id;

  // Stripe returns a charge with no settled fee -> stripeFeeFor stays null.
  const stripe = require('../../utils/stripeClient').getStripe();
  assert.ok(stripe, 'a Stripe client is available in this environment');
  const origRetrieve = stripe.paymentIntents.retrieve;
  stripe.paymentIntents.retrieve = async () => ({
    latest_charge: { balance_transaction: { fee: null } },
  });

  // Capture the residual Sentry warning (payroll.js calls Sentry.captureMessage
  // by property on the shared module object).
  const Sentry = require('@sentry/node');
  const origCaptureMessage = Sentry.captureMessage;
  const warnings = [];
  Sentry.captureMessage = (msg, ctx) => { warnings.push({ msg, ctx }); };

  try {
    const r = await req('POST', `/api/admin/payroll/periods/${periodId}/process`, adminToken);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.period.status, 'processing', 'processing proceeds despite null fee');
    assert.ok(body.fee_recapture.tips_null_after >= 1, 'residual null-fee tip reported');

    const residual = warnings.find(
      w => w.ctx && w.ctx.tags && w.ctx.tags.step === 'fee_recapture_residual'
    );
    assert.ok(residual, 'residual null-fee warning fired');
    assert.ok(residual.ctx.extra.tip_ids.includes(tipId), 'warning names the tip');

    // The line paid gross (fee 0) since the fee could not be captured.
    const { rows } = await pool.query(
      `SELECT card_tip_fee_cents, card_tip_net_cents
         FROM payout_events WHERE shift_id = $1 AND payout_id = $2`,
      [shiftId, payoutId]
    );
    assert.equal(Number(rows[0].card_tip_fee_cents), 0);
    assert.equal(Number(rows[0].card_tip_net_cents), 4000);
  } finally {
    Sentry.captureMessage = origCaptureMessage;
    stripe.paymentIntents.retrieve = origRetrieve;
    await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, contractorId]
    );
    await pool.query(
      `UPDATE payout_events
          SET card_tip_gross_cents=0, card_tip_fee_cents=0, card_tip_net_cents=0,
              wage_cents=11000, gratuity_share_cents=10000, line_total_cents=21000
         WHERE payout_id = $1`,
      [payoutId]
    );
    await pool.query('UPDATE payouts SET total_cents=21000 WHERE id = $1', [payoutId]);
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});
