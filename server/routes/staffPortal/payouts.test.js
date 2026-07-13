require('dotenv').config();

// Match staffPortal.test.js — set NODE_ENV before requiring the router so any
// rate-limiter / dev-only branches see a stable env value.
process.env.NODE_ENV = 'test';

// Route-level tests for server/routes/staffPortal/payouts.js — the two
// staffer-facing READ endpoints exposed under /api/me/payouts.
//
// HARNESS
// -------
// HTTP harness mirrors server/routes/staffPortal.test.js (no supertest in the
// repo; we stand up a minimal express app, mount the real router, and drive
// it via node:http). Fixture pattern mirrors server/utils/payrollClawback.test.js:
// every row this suite touches has the 'payq-' prefix on its email so a
// crashed earlier run self-heals on the next setup. The dev DB has a
// transient gap right now (no `open` pay period), so this suite seeds its
// OWN pay_periods row with status='paid' on a fixed past date range and
// cleans it up — no dependency on any ambient open period.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const staffPortalRouter = require('../staffPortal');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Fixed past period — deliberately NOT an open period. Status 'paid' so the
// suite never touches whatever ambient open period the dev DB may or may not
// have. ON CONFLICT on the unique start_date in case a prior run left it.
const PERIOD_START = '2025-12-01';
const PERIOD_END   = '2025-12-14';
const PERIOD_PAYDAY = '2025-12-16';

let server;
let baseUrl;
// User A — primary staffer whose payouts we read.
let userA, tokenA;
// User B — second staffer whose payout User A must NOT be able to read.
let userB, tokenB;
// User C — staffer with no payouts (new-hire empty case).
let userC, tokenC;
// Fixtures we have to tear down at the end.
let clientId;
let proposalId;
let shiftIdA1, shiftIdA2, shiftIdB;
let payPeriodId;
let payoutAId, payoutBId;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Setup: seed our own users + period + payouts ───────────────────────────
before(async () => {
  // Defensive pre-clean: anything from a prior crashed run that matches our
  // email prefix. Order matters — children before parents.
  const fixtureFilter = `email LIKE 'payq-%@example.com'`;
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${fixtureFilter}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

  const pwHash = await bcrypt.hash('x', 4);

  // User A — primary fixture (the staffer we mostly drive the endpoint as).
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`payq-a-${NONCE}@example.com`, pwHash]
  );
  userA = a.rows[0].id;
  tokenA = jwt.sign(
    { userId: userA, tokenVersion: a.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // User B — IDOR target (different staffer with their own payout).
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`payq-b-${NONCE}@example.com`, pwHash]
  );
  userB = b.rows[0].id;
  tokenB = jwt.sign(
    { userId: userB, tokenVersion: b.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // User C — new hire with no payouts (empty-case verification).
  const c = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`payq-c-${NONCE}@example.com`, pwHash]
  );
  userC = c.rows[0].id;
  tokenC = jwt.sign(
    { userId: userC, tokenVersion: c.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  for (const id of [userA, userB, userC]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate, preferred_name, position)
       VALUES ($1, 25.00, 'Test', 'bartender')
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 25.00`,
      [id]
    );
  }

  // Client + proposal so the event-row JOIN to clients.name has data.
  const cl = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id",
    [`Payouts Test Client ${NONCE}`, `payq-client-${NONCE}@example.com`]
  );
  clientId = cl.rows[0].id;
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                             status, event_type)
     VALUES ($1, '2025-12-08', '18:00', 4, 'completed', 'wedding')
     RETURNING id`,
    [clientId]
  );
  proposalId = pr.rows[0].id;

  // Three shifts: two on userA's payout, one on userB's. Two on userA so we
  // can verify event_count is right (=2) on the list endpoint.
  const sA1 = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES ('2025-12-08', '18:00', '22:00', 'completed', $1, '111 First St') RETURNING id`,
    [proposalId]
  );
  shiftIdA1 = sA1.rows[0].id;
  const sA2 = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES ('2025-12-10', '19:00', '23:00', 'completed', $1, '222 Second St') RETURNING id`,
    [proposalId]
  );
  shiftIdA2 = sA2.rows[0].id;
  const sB = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES ('2025-12-12', '20:00', '00:00', 'completed', $1, '333 Third St') RETURNING id`,
    [proposalId]
  );
  shiftIdB = sB.rows[0].id;

  // Fixed past pay period, status 'paid'. ON CONFLICT (start_date) covers any
  // leftover row from a crashed earlier run.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid', end_date = EXCLUDED.end_date, payday = EXCLUDED.payday
     RETURNING id`,
    [PERIOD_START, PERIOD_END, PERIOD_PAYDAY]
  );
  payPeriodId = pp.rows[0].id;

  // Two payouts — one per user A and one for user B (IDOR target).
  const poA = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents, paid_at)
     VALUES ($1, $2, 'paid', 30000, NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
       SET status = 'paid', total_cents = 30000, paid_at = NOW()
     RETURNING id`,
    [payPeriodId, userA]
  );
  payoutAId = poA.rows[0].id;
  const poB = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents, paid_at)
     VALUES ($1, $2, 'paid', 15000, NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
       SET status = 'paid', total_cents = 15000, paid_at = NOW()
     RETURNING id`,
    [payPeriodId, userB]
  );
  payoutBId = poB.rows[0].id;

  // Two events on payout A — used by detail-test summary verification.
  // wage_cents 10000 + 12000 = 22000
  // gratuity_share_cents 1000 + 1500 = 2500
  // card_tip_gross_cents 2000 + 3000 = 5000
  // card_tip_fee_cents 60 + 90 = 150
  // adjustment_cents 0 + 500 = 500
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                 late, gratuity_share_cents,
                                 card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents,
                                 adjustment_cents, adjustment_note, line_total_cents)
     VALUES ($1, $2, 4, 4, 2500, 10000, false, 1000, 2000, 60, 1940, 0, NULL, 12940),
            ($1, $3, 4, 4, 3000, 12000, false, 1500, 3000, 90, 2910, 500, 'tip top-up', 16910)
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [payoutAId, shiftIdA1, shiftIdA2]
  );

  // One event on payout B — just so the IDOR test has a non-empty period for
  // user B; user A asking for the same periodId must still NotFound because
  // their own payout-row JOIN condition is the gate, not the existence of B's
  // event.
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                 late, gratuity_share_cents,
                                 card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents,
                                 adjustment_cents, adjustment_note, line_total_cents)
     VALUES ($1, $2, 4, 4, 2500, 10000, false, 500, 1000, 30, 970, 0, NULL, 11470)
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [payoutBId, shiftIdB]
  );

  // Minimal app — real router + AppError-aware error middleware that mirrors
  // server/index.js.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', staffPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  // Children → parents. payout_events FK-cascades on payout delete, but we
  // delete explicitly so a failure midway doesn't leave orphans.
  await pool.query('DELETE FROM payout_events WHERE payout_id IN ($1, $2)', [payoutAId, payoutBId]);
  await pool.query('DELETE FROM payouts WHERE id IN ($1, $2)', [payoutAId, payoutBId]);
  // Period: only delete if nothing else references it. Belt-and-suspenders.
  await pool.query(
    `DELETE FROM pay_periods WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)`,
    [payPeriodId]
  );
  await pool.query('DELETE FROM shifts WHERE id IN ($1, $2, $3)', [shiftIdA1, shiftIdA2, shiftIdB]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [userA, userB, userC]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test('GET /api/me/payouts > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/payouts');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/payouts > returns the staffer-scoped list with event_count', async () => {
  const res = await request('GET', '/api/me/payouts', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.payouts), 'payouts is an array');
  // Find our seeded row (other rows may exist for the same user in the dev DB).
  const row = res.body.payouts.find((p) => p.id === payoutAId);
  assert.ok(row, 'seeded payout is in the list');
  assert.strictEqual(row.status, 'paid');
  assert.strictEqual(row.total_cents, 30000);
  assert.strictEqual(row.event_count, 2);
  assert.strictEqual(row.period.id, payPeriodId);
  assert.strictEqual(row.period.start_date, PERIOD_START);
  assert.strictEqual(row.period.end_date, PERIOD_END);
  assert.strictEqual(row.period.payday, PERIOD_PAYDAY);
  assert.strictEqual(row.period.status, 'paid');
  // PII: payment_method + payment_handle MUST NOT be present.
  assert.ok(!('payment_method' in row), 'payment_method is not projected');
  assert.ok(!('payment_handle' in row), 'payment_handle is not projected');
});

test('GET /api/me/payouts > does not include another user\'s payouts', async () => {
  const res = await request('GET', '/api/me/payouts', { token: tokenA });
  assert.strictEqual(res.status, 200);
  // userA's list MUST NOT contain userB's payout id.
  const stolen = res.body.payouts.find((p) => p.id === payoutBId);
  assert.strictEqual(stolen, undefined, 'userA cannot see userB\'s payout in the list');
});

test('GET /api/me/payouts > new-hire empty case returns { payouts: [] }', async () => {
  const res = await request('GET', '/api/me/payouts', { token: tokenC });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { payouts: [] });
});

test('GET /api/me/payouts/:periodId > returns period + payout + events + summary', async () => {
  const res = await request('GET', `/api/me/payouts/${payPeriodId}`, { token: tokenA });
  assert.strictEqual(res.status, 200);
  // period
  assert.strictEqual(res.body.period.id, payPeriodId);
  assert.strictEqual(res.body.period.start_date, PERIOD_START);
  assert.strictEqual(res.body.period.end_date, PERIOD_END);
  assert.strictEqual(res.body.period.payday, PERIOD_PAYDAY);
  assert.strictEqual(res.body.period.status, 'paid');
  // payout
  assert.strictEqual(res.body.payout.id, payoutAId);
  assert.strictEqual(res.body.payout.status, 'paid');
  assert.strictEqual(res.body.payout.total_cents, 30000);
  // events
  assert.ok(Array.isArray(res.body.events));
  assert.strictEqual(res.body.events.length, 2);
  // Ordered by event_date ASC: shiftA1 (2025-12-08) before shiftA2 (2025-12-10).
  assert.strictEqual(res.body.events[0].shift_id, shiftIdA1);
  assert.strictEqual(res.body.events[1].shift_id, shiftIdA2);
  assert.strictEqual(res.body.events[0].event_date, '2025-12-08');
  assert.strictEqual(res.body.events[0].event_type, 'wedding');
  assert.ok(res.body.events[0].client_name);
  // summary sums (wages 22000, gratuity 2500, card gross 5000, card fee 150,
  // adjustments 500). total_cents comes from the payout row = 30000.
  assert.strictEqual(res.body.summary.wages_cents, 22000);
  assert.strictEqual(res.body.summary.gratuity_cents, 2500);
  assert.strictEqual(res.body.summary.card_tips_gross_cents, 5000);
  assert.strictEqual(res.body.summary.card_processing_fee_cents, 150);
  assert.strictEqual(res.body.summary.adjustments_cents, 500);
  assert.strictEqual(res.body.summary.total_cents, 30000);
});

test('GET /api/me/payouts/:periodId > 400 ValidationError on non-numeric id', async () => {
  const res = await request('GET', '/api/me/payouts/not-a-number', { token: tokenA });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VALIDATION_ERROR');
});

test('GET /api/me/payouts/:periodId > IDOR: userA asking for a periodId where only userB has a payout returns 404', async () => {
  // userB DOES have a payout for payPeriodId, but userA also has one in the
  // same period — so to exercise IDOR cleanly we need a period where ONLY
  // userB has a payout. Seed a second period with ONLY userB's payout, then
  // verify userA gets 404 on it.
  const pp2 = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2025-11-17', '2025-11-30', '2025-12-02', 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid'
     RETURNING id`
  );
  const periodOnlyB = pp2.rows[0].id;
  const poBOnly = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents, paid_at)
     VALUES ($1, $2, 'paid', 8000, NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET total_cents = 8000
     RETURNING id`,
    [periodOnlyB, userB]
  );
  const payoutBOnlyId = poBOnly.rows[0].id;

  try {
    // userA must get 404 — userA has no payout in periodOnlyB.
    const res = await request('GET', `/api/me/payouts/${periodOnlyB}`, { token: tokenA });
    assert.strictEqual(res.status, 404, 'userA gets 404 for userB\'s period');
    assert.strictEqual(res.body.code, 'NOT_FOUND');

    // Sanity: userB can read it.
    const resB = await request('GET', `/api/me/payouts/${periodOnlyB}`, { token: tokenB });
    assert.strictEqual(resB.status, 200);
    assert.strictEqual(resB.body.payout.id, payoutBOnlyId);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id = $1', [payoutBOnlyId]);
    await pool.query('DELETE FROM payouts WHERE id = $1', [payoutBOnlyId]);
    await pool.query(
      `DELETE FROM pay_periods WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)`,
      [periodOnlyB]
    );
  }
});

test('GET /api/me/payouts/:periodId > 404 on a period the user was never paid in', async () => {
  // userC (new hire, no payouts) asks for the real seeded period. Period
  // exists, but no payouts row for userC → 404.
  const res = await request('GET', `/api/me/payouts/${payPeriodId}`, { token: tokenC });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'NOT_FOUND');
});

test('GET /api/me/payouts/:periodId > summary excludes held reimbursements from adjustments (foots against total)', async () => {
  // A held reimbursement (payout_events.held_state = 'held', fix #4) is tracked
  // but NON-payable: line_total 0, so the canonical payout total excludes it by
  // construction. The summary's adjustments sum must exclude it too — otherwise
  // Adjustments vs total_cents disagree by exactly the held amount on the staff
  // Pay tab. Seed a held line onto payout A, verify the summary still foots,
  // clean up in finally (mirrors the IDOR test's seed-inside-test pattern).
  const sHeld = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES ('2025-12-13', '18:00', '22:00', 'completed', $1, '444 Fourth St') RETURNING id`,
    [proposalId]
  );
  const heldShiftId = sHeld.rows[0].id;
  const heldPe = await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                 late, gratuity_share_cents,
                                 card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents,
                                 adjustment_cents, adjustment_note, line_total_cents, held_state)
     VALUES ($1, $2, 0, 0, 2500, 0, false, 0, 0, 0, 0, 700, 'held reimbursement', 0, 'held')
     RETURNING id`,
    [payoutAId, heldShiftId]
  );
  const heldPeId = heldPe.rows[0].id;

  try {
    const res = await request('GET', `/api/me/payouts/${payPeriodId}`, { token: tokenA });
    assert.strictEqual(res.status, 200);
    // The held line IS visible in the events list (line_total 0)...
    assert.strictEqual(res.body.events.length, 3);
    const heldRow = res.body.events.find((e) => e.shift_id === heldShiftId);
    assert.ok(heldRow, 'held line rendered in events');
    assert.strictEqual(heldRow.adjustment_cents, 700);
    assert.strictEqual(heldRow.line_total_cents, 0);
    // ...but the adjustments aggregate excludes it: still only the payable 500
    // from the seeded 'tip top-up' line, and the summary foots against the
    // canonical payout total.
    assert.strictEqual(res.body.summary.adjustments_cents, 500, 'held 700 excluded from adjustments');
    assert.strictEqual(res.body.summary.total_cents, 30000);
    // Component sums untouched (held lines zero these by construction).
    assert.strictEqual(res.body.summary.wages_cents, 22000);
    assert.strictEqual(res.body.summary.gratuity_cents, 2500);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE id = $1', [heldPeId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [heldShiftId]);
  }
});
