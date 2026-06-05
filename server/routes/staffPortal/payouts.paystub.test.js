require('dotenv').config();

// Set NODE_ENV=test BEFORE requiring the staff portal router (matches the
// staffPortal.test.js / payrollProcessing.test.js pattern). Some middleware
// short-circuits on NODE_ENV=test (e.g. rate-limiters) — not strictly needed
// for the paystub route, but keeps this suite consistent with siblings.
process.env.NODE_ENV = 'test';

// Route-level test for the paystub assembly + lazy-generate endpoint
// (server/routes/staffPortal/payouts.js + server/utils/paystubData.js).
//
// HARNESS NOTES
// -------------
// Mirrors server/routes/staffPortal.test.js: stand up a minimal express() app,
// mount the real router with the real auth middleware (already inside the
// router), and the AppError-aware error handler from server/index.js. Driven
// via node's built-in http module.
//
// R2 is stubbed via node:test's mock.method on the storage module export. The
// route resolves storage.uploadFile / storage.getSignedUrl at call time via
// the storage module object (not destructured), so the mock is honored.
//
// Run ALONE (shared dev DB):
//   node --test server/routes/staffPortal/payouts.paystub.test.js

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const storage = require('../../utils/storage');
// Replace R2 calls before the staffPortal router is required. The route
// dispatches via storage.uploadFile / storage.getSignedUrl (module-level
// lookup), so these mocks intercept every call. Auto-restored on process exit
// (node:test mock teardown).
mock.method(storage, 'uploadFile', async () => {});
mock.method(storage, 'getSignedUrl', async (key) => `https://signed.example/${key}`);

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { assemblePaystubData } = require('../../utils/paystubData');
const staffPortalRouter = require('../staffPortal');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let contractorAToken;
let contractorAId;
let contractorBId;

let aprilPeriodId;
let aprilPayoutId;
let mayPeriodId;
let mayPayoutId;
let unpaidPeriodId;
let unpaidPayoutId;
let bPeriodId;
let bPayoutId;

let clientId;
let proposalAprilId;
let proposalMayId;
let proposalUnpaidId;
let proposalBId;
let shiftAprilId;
let shiftMayId;
let shiftUnpaidId;
let shiftBId;

// Per-period totals (seed-side; the test asserts these match what assembly
// returns and what the endpoint persists).
const APRIL_TOTAL = 32240;       // $322.40
const MAY_TOTAL = 54740;         // $547.40
const APRIL_WAGE = 24000;        // $240.00
const MAY_WAGE = 44000;          // $440.00 (one wage event)

// Use the current calendar year so date_trunc('year', payday) lands the right
// window — both periods MUST share a year for YTD to roll them up together.
const YEAR = new Date().getUTCFullYear();
// Far-future payday in the same year (NEVER inside another open period) — the
// pay_periods table has UNIQUE(start_date) so we pick distinct dates well
// before our seeds.
const APRIL_START = `${YEAR}-04-01`;
const APRIL_END = `${YEAR}-04-15`;
const APRIL_PAYDAY = `${YEAR}-04-16`;
const MAY_START = `${YEAR}-05-01`;
const MAY_END = `${YEAR}-05-15`;
const MAY_PAYDAY = `${YEAR}-05-16`;
const UNPAID_START = `${YEAR}-07-01`;
const UNPAID_END = `${YEAR}-07-15`;
const UNPAID_PAYDAY = `${YEAR}-07-16`;
const B_START = `${YEAR}-08-01`;
const B_END = `${YEAR}-08-15`;
const B_PAYDAY = `${YEAR}-08-16`;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined)
      ? null
      : JSON.stringify(body);
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
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Defensive: purge any rows left by a prior crashed run keyed by our nonce
  // prefix. Pay periods have UNIQUE(start_date) so we don't risk colliding
  // with non-test rows here (the start_date set above is test-local).
  await pool.query("DELETE FROM users WHERE email LIKE 'paystub-test-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Contractor A — the subject of every assertion. agreements row exists so
  // contractor_name resolves to the legal full_name (paystubData precedence).
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`paystub-test-a-${NONCE}@example.com`, passwordHash]
  );
  contractorAId = a.rows[0].id;
  contractorAToken = jwt.sign(
    { userId: contractorAId, tokenVersion: a.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, hourly_rate)
     VALUES ($1, 'A Preferred', 25.00)`,
    [contractorAId]
  );
  await pool.query(
    `INSERT INTO agreements (user_id, full_name)
     VALUES ($1, 'Alice A. Apple')`,
    [contractorAId]
  );

  // Contractor B — for the IDOR assertion (A asking for B's period returns 404).
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`paystub-test-b-${NONCE}@example.com`, passwordHash]
  );
  contractorBId = b.rows[0].id;

  // Client + proposals (one per period so the events JOIN through shifts ->
  // proposals -> clients lands a row).
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id",
    [`Paystub Test Client ${NONCE}`, `paystub-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  async function mkProposal(eventDate) {
    const p = await pool.query(
      `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                              event_timezone, status, event_type)
       VALUES ($1, $2, '18:00', 4, 'America/Chicago', 'completed', 'birthday-party')
       RETURNING id`,
      [clientId, eventDate]
    );
    return p.rows[0].id;
  }
  proposalAprilId = await mkProposal(APRIL_END);
  proposalMayId = await mkProposal(MAY_END);
  proposalUnpaidId = await mkProposal(UNPAID_END);
  proposalBId = await mkProposal(B_END);

  async function mkShift(eventDate, proposalId) {
    const sh = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
       VALUES ($1, '18:00', '22:00', 'open', $2, '123 Main St')
       RETURNING id`,
      [eventDate, proposalId]
    );
    return sh.rows[0].id;
  }
  shiftAprilId = await mkShift(APRIL_END, proposalAprilId);
  shiftMayId = await mkShift(MAY_END, proposalMayId);
  shiftUnpaidId = await mkShift(UNPAID_END, proposalUnpaidId);
  shiftBId = await mkShift(B_END, proposalBId);

  // April paid period + payout for A.
  const ppA = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`,
    [APRIL_START, APRIL_END, APRIL_PAYDAY]
  );
  aprilPeriodId = ppA.rows[0].id;
  const poA = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents,
                          payment_method, payment_handle, paid_at)
     VALUES ($1, $2, 'paid', $3, 'venmo', '@alice', NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'paid', total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [aprilPeriodId, contractorAId, APRIL_TOTAL]
  );
  aprilPayoutId = poA.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, card_tip_net_cents, adjustment_cents, line_total_cents)
     VALUES ($1, $2, 6.0, 6.0, 4000, $3, 5000, 3240, 0, $4)`,
    [aprilPayoutId, shiftAprilId, APRIL_WAGE, APRIL_TOTAL]
  );

  // May paid period + payout for A (with key starting NULL — the endpoint
  // backfills it on first hit, which is the whole point of the test).
  const ppM = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`,
    [MAY_START, MAY_END, MAY_PAYDAY]
  );
  mayPeriodId = ppM.rows[0].id;
  const poM = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents,
                          payment_method, payment_handle, paid_at)
     VALUES ($1, $2, 'paid', $3, 'check', NULL, NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'paid', total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [mayPeriodId, contractorAId, MAY_TOTAL]
  );
  mayPayoutId = poM.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, card_tip_net_cents, adjustment_cents, line_total_cents)
     VALUES ($1, $2, 11.0, 11.0, 4000, $3, 6500, 3240, 1000, $4)`,
    [mayPayoutId, shiftMayId, MAY_WAGE, MAY_TOTAL]
  );

  // Unpaid (pending) period for A — endpoint should 409.
  const ppU = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`,
    [UNPAID_START, UNPAID_END, UNPAID_PAYDAY]
  );
  unpaidPeriodId = ppU.rows[0].id;
  const poU = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'pending', 10000)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'pending'
     RETURNING id`,
    [unpaidPeriodId, contractorAId]
  );
  unpaidPayoutId = poU.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
     VALUES ($1, $2, 2.5, 2.5, 4000, 10000, 10000)`,
    [unpaidPayoutId, shiftUnpaidId]
  );

  // Contractor B's paid period — endpoint asked as A returns 404 (IDOR).
  const ppB = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`,
    [B_START, B_END, B_PAYDAY]
  );
  bPeriodId = ppB.rows[0].id;
  const poB = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents, paid_at)
     VALUES ($1, $2, 'paid', 15000, NOW())
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'paid'
     RETURNING id`,
    [bPeriodId, contractorBId]
  );
  bPayoutId = poB.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
     VALUES ($1, $2, 3.75, 3.75, 4000, 15000, 15000)`,
    [bPayoutId, shiftBId]
  );

  // Minimal app: real router + AppError-aware error handler matching
  // server/index.js. express-fileupload not needed (paystub endpoint is GET).
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
    // eslint-disable-next-line no-console
    console.error('test handler error:', err);
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
  // Delete in FK order: payout_events -> shifts -> payouts -> pay_periods ->
  // proposals -> clients -> agreements/contractor_profiles -> users.
  // shifts.proposal_id is ON DELETE SET NULL so shifts can outlive proposals,
  // but we tear down strictly children-first to keep the order safe.
  const periodIds = [aprilPeriodId, mayPeriodId, unpaidPeriodId, bPeriodId].filter(Boolean);
  const payoutIds = [aprilPayoutId, mayPayoutId, unpaidPayoutId, bPayoutId].filter(Boolean);
  const shiftIds = [shiftAprilId, shiftMayId, shiftUnpaidId, shiftBId].filter(Boolean);
  const proposalIds = [proposalAprilId, proposalMayId, proposalUnpaidId, proposalBId].filter(Boolean);

  if (payoutIds.length) {
    await pool.query('DELETE FROM payout_events WHERE payout_id = ANY($1::int[])', [payoutIds]);
  }
  if (shiftIds.length) {
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [shiftIds]);
  }
  if (payoutIds.length) {
    await pool.query('DELETE FROM payouts WHERE id = ANY($1::int[])', [payoutIds]);
  }
  if (periodIds.length) {
    await pool.query('DELETE FROM pay_periods WHERE id = ANY($1::int[])', [periodIds]);
  }
  if (proposalIds.length) {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientId) {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  if (contractorAId || contractorBId) {
    await pool.query('DELETE FROM agreements WHERE user_id IN ($1, $2)', [contractorAId, contractorBId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)', [contractorAId, contractorBId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [contractorAId, contractorBId]);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
});

// ─── Assertion 1: assemblePaystubData YTD math ─────────────────────────────
test('assemblePaystubData > thisPeriod.net mirrors total_cents; YTD sums both paid periods', async () => {
  const data = await assemblePaystubData(contractorAId, mayPeriodId);
  assert.ok(data, 'data is not null');

  // Static shape checks.
  assert.equal(data.status, 'paid');
  assert.equal(data.storageKey, `paystubs/${contractorAId}/${mayPeriodId}.pdf`);
  // Legal full_name (agreements.full_name) wins precedence.
  assert.equal(data.contractorName, 'Alice A. Apple');
  assert.equal(data.period.payday, MAY_PAYDAY);
  // The one event for May surfaces.
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].client_name, `Paystub Test Client ${NONCE}`);

  // thisPeriod.net is the canonical payout total, NOT a JS re-sum.
  assert.equal(data.thisPeriod.net_cents, MAY_TOTAL);
  // thisPeriod categories sum from May's single event.
  assert.equal(data.thisPeriod.wages_cents, MAY_WAGE);

  // paid metadata flows through; payment_handle is intentionally NOT present (PII).
  assert.equal(data.paid.method, 'check');
  assert.equal(data.paid.handle, undefined);

  // YTD net = April + May (both paid, both inside [Jan 1, May payday]).
  assert.equal(data.ytd.net_cents, APRIL_TOTAL + MAY_TOTAL);
  // YTD wage_cents = April wage + May wage. This is the load-bearing breakdown
  // assertion — proves the YTD category aggregate JOIN is correct.
  assert.equal(data.ytd.wages_cents, APRIL_WAGE + MAY_WAGE);
});

// ─── Assertion 2: lazy generate + persist key ──────────────────────────────
test('GET /api/me/payouts/:mayPeriodId/paystub > generates + persists key on first call', async () => {
  // Reset mock call counters so we can assert "exactly 1 upload".
  storage.uploadFile.mock.resetCalls();
  storage.getSignedUrl.mock.resetCalls();

  // Ensure the key is null going in (the test runs against a shared dev DB and
  // we want the lazy path, not the cache-hit path).
  await pool.query(
    'UPDATE payouts SET paystub_storage_key = NULL WHERE id = $1',
    [mayPayoutId]
  );

  const res = await request('GET', `/api/me/payouts/${mayPeriodId}/paystub`, {
    token: contractorAToken,
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.url, 'response carries a url');
  assert.equal(res.body.url, `https://signed.example/paystubs/${contractorAId}/${mayPeriodId}.pdf`);

  // Exactly one upload.
  assert.equal(storage.uploadFile.mock.callCount(), 1);
  // The upload received a buffer + the deterministic key.
  const call = storage.uploadFile.mock.calls[0];
  assert.ok(Buffer.isBuffer(call.arguments[0]));
  assert.ok(call.arguments[0].subarray(0, 5).toString('latin1') === '%PDF-', 'uploaded buffer is a PDF');
  assert.equal(call.arguments[1], `paystubs/${contractorAId}/${mayPeriodId}.pdf`);

  // Key is now persisted on the payouts row.
  const { rows } = await pool.query(
    'SELECT paystub_storage_key FROM payouts WHERE id = $1',
    [mayPayoutId]
  );
  assert.equal(rows[0].paystub_storage_key, `paystubs/${contractorAId}/${mayPeriodId}.pdf`);
});

// ─── Assertion 3: cache hit on second call ─────────────────────────────────
test('GET /api/me/payouts/:mayPeriodId/paystub > second call hits cache, no re-upload', async () => {
  storage.uploadFile.mock.resetCalls();

  const res = await request('GET', `/api/me/payouts/${mayPeriodId}/paystub`, {
    token: contractorAToken,
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.url, 'response carries a url');

  // The key is already on the row, so the lazy path is skipped entirely.
  assert.equal(storage.uploadFile.mock.callCount(), 0, 'no re-upload on cache hit');
});

// ─── Assertion 4: 409 on unpaid period ─────────────────────────────────────
test('GET /api/me/payouts/:unpaidPeriodId/paystub > 409 because period is unpaid', async () => {
  storage.uploadFile.mock.resetCalls();

  const res = await request('GET', `/api/me/payouts/${unpaidPeriodId}/paystub`, {
    token: contractorAToken,
  });
  assert.equal(res.status, 409);
  assert.equal(storage.uploadFile.mock.callCount(), 0, 'no upload on a 409');
});

// ─── Assertion 5: 404 on another contractor's period (IDOR guard) ──────────
test('GET /api/me/payouts/:bPeriodId/paystub as A > 404 (IDOR guard)', async () => {
  storage.uploadFile.mock.resetCalls();

  // Sanity: B's period exists and is PAID — so A's 404 is the IDOR guard
  // (contractor_id mismatch), not merely "no payout in that period".
  const bSanity = await pool.query(
    'SELECT status FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
    [bPeriodId, contractorBId]
  );
  assert.equal(bSanity.rows[0] && bSanity.rows[0].status, 'paid', 'B has a paid payout here');

  const res = await request('GET', `/api/me/payouts/${bPeriodId}/paystub`, {
    token: contractorAToken,
  });
  assert.equal(res.status, 404);
  assert.equal(storage.uploadFile.mock.callCount(), 0, 'no upload on a 404');
});

// ─── Assertion 6: a generation failure leaves the payout row clean ─────────
test('GET /api/me/payouts/:mayPeriodId/paystub > upload failure keeps the key NULL (retry-safe)', async () => {
  // Force the lazy path, then make the R2 upload throw on this one call.
  await pool.query('UPDATE payouts SET paystub_storage_key = NULL WHERE id = $1', [mayPayoutId]);
  storage.uploadFile.mock.resetCalls();
  storage.uploadFile.mock.mockImplementationOnce(async () => { throw new Error('r2 unavailable'); });

  const res = await request('GET', `/api/me/payouts/${mayPeriodId}/paystub`, {
    token: contractorAToken,
  });
  assert.ok(res.status >= 500, `expected 5xx on upload failure, got ${res.status}`);

  // The point of lazy generation: a failed render/upload never dirties the
  // money row, so the next click retries cleanly.
  const { rows } = await pool.query(
    'SELECT paystub_storage_key FROM payouts WHERE id = $1',
    [mayPayoutId]
  );
  assert.equal(rows[0].paystub_storage_key, null, 'key stays NULL after a failed generation');
});
