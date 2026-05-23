# Staff Payment System — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin payroll portal — the Financials > Payroll worklist where the admin processes each weekly run, edits a row, marks each contractor paid, assigns stray tips, and reads past periods.

**Architecture:** A new admin-only `/api/admin/payroll/*` route file backed by Phase 1's tables and the `accruePayoutsForProposal` orchestrator, plus a new React surface at `/financials/payroll` (and a wiring of the existing placeholder `PayoutsTab` on the user-detail page). The lifecycle state machine — `open → processing → paid` on `pay_periods`, `pending → paid` on `payouts` — lives on the backend; Phase 1's accrual already silently no-ops on non-`open` periods, which is the freeze. Inline edits to a `payout_events` row UPDATE the row directly and recompute the parent payout total in a single transaction (no full re-accrual); tip assignment re-runs `accruePayoutsForProposal` for the affected proposal so card-tip pools refresh. QR codes use the existing `qrcode.react` (`QRCodeSVG`) dep already vetted by the tip-card flow.

**Tech Stack:** Node.js / Express, raw SQL via `pg`, Node's built-in test runner. React 18 (CRA), `qrcode.react` for QR rendering. No new server deps.

**Scope:** Phase 2 of 4 (design spec, Section 16). Covers Section 7 (admin portal), the lifecycle state machine in Section 6, the floor-at-zero / no-payment-method / disputed-tip edge cases in Section 11, the admin-only access in Section 13, and the Section 10 `PAYMENT_METHODS` consistency fix that the portal would otherwise inherit broken. **Out of scope:** the staff My Pay page, paystub PDF generation, the two scheduled email notifications (Phase 3/4), 1099 generation (deferred), the contractor agreement v3 (separate track).

**Spec:** `docs/superpowers/specs/2026-05-22-staff-payment-system-design.md`
**Phase 1 plan (data layer this builds on):** `docs/superpowers/plans/2026-05-22-staff-payment-system-phase-1.md`

---

## Known gaps (deferred to Phase 2.5 or later)

**Late-tip roll-forward** (spec Section 6.5): when a tip is matched to a shift whose period is already `processing` or `paid`, the spec says the tip rolls forward as a synthetic `payout_events` row on that contractor's next payout. **Phase 2 does NOT implement that.** Phase 2 sets `tips.shift_id` correctly (the matching IS done) and surfaces a flag in the unassigned-tips panel telling the admin which assignments landed against a frozen period, so the admin can compensate manually via an adjustment line on the next period's payout. Automatic roll-forward is a separate task, called out at the end of this plan.

**Refunded or disputed card tip after a payout has paid** (spec Section 11, third bullet): the spec says this surfaces as an admin alert with two options (absorb or net against the next payout via an adjustment line). Phase 2 has no admin-alert system; if a card tip is refunded post-payment, the admin notices it on the Stripe dashboard and manually adds a negative adjustment on the contractor's next payout. The alert UI is a Phase 4-ish concern alongside the scheduled-message work.

**Card-tip settling indicator on a line item.** The `EventLineItem` shows `card_tip_gross_cents`, `card_tip_fee_cents`, and `card_tip_net_cents`. When `card_tip_fee_cents` is 0 the line could mean "no fee, fully cleared" or "fee not yet captured from Stripe" — Phase 2 does not distinguish them. In practice the accrual captures fees before producing the line, so the ambiguous case is narrow. A future small task can show a "settling" badge when `tips.fee_cents IS NULL` for any tip in the bartender's share for that event.

---

## File Structure

**Created:**
- `server/utils/payrollProcessing.js` — pure-ish helpers shared by the routes: find the open pay period for a date, recompute one payout's `total_cents` from its line items, flip a period to `paid` when its last pending payout is paid. No HTTP awareness.
- `server/utils/payrollProcessing.test.js` — integration tests.
- `server/routes/admin/payroll.js` — `/api/admin/payroll/*` admin-only route surface: list/get periods, edit `payout_events`, process the period, mark paid, manage unassigned tips, contractor history.
- `server/routes/admin/payroll.test.js` — integration tests covering each endpoint's happy path + one or two refusal cases.
- `client/src/pages/admin/payroll/PayrollPage.js` — page shell mounted at `/financials/payroll`. Tab strip: Current | History | Unassigned tips. Holds the period being viewed and the open-row state.
- `client/src/pages/admin/payroll/PayrollHeader.js` — the period header band (dates, payday, total, paid/pending counters, Process Payroll button).
- `client/src/pages/admin/payroll/PayoutRow.js` — one collapsed/expanded row per contractor. Holds the per-row state (the inline-edit draft, Mark Paid trigger).
- `client/src/pages/admin/payroll/EventLineItem.js` — one editable line per `payout_events` row inside an expanded payout. Handles the inline draft + save.
- `client/src/pages/admin/payroll/MarkPaidAction.js` — the Mark Paid button + method-aware action: opens `PayQRModal` for Venmo/CashApp, opens paypal.me in a new tab for PayPal, opens a plain confirm for check/direct_deposit/other. Triggers the POST.
- `client/src/pages/admin/payroll/PayQRModal.js` — modal showing the prefilled `QRCodeSVG` plus the URL as a plain link (fallback for desktop / when the phone can't scan). Shows Venmo's amount-prefill caveat inline.
- `client/src/pages/admin/payroll/UnassignedTipsPanel.js` — list of tips with `shift_id IS NULL`, per-tip shift dropdown, assign action.
- `client/src/pages/admin/payroll/HistoryView.js` — list of past periods, click a row to view it in read-only mode (the same `PayrollHeader` + `PayoutRow` components, with edit affordances hidden).

**Modified:**
- `server/routes/admin/index.js` — add `router.use('/', require('./payroll'))`.
- `client/src/App.js` — add the lazy import + route for `/financials/payroll`.
- `client/src/pages/admin/userDetail/helpers.js` — fix `PAYMENT_METHODS`: drop `Zelle`, switch to the canonical lowercase enum (`venmo`, `cashapp`, `paypal`, `check`, `direct_deposit`, `other`). Add a `paymentMethodLabel(method)` helper for the display label so the UI never shows `direct_deposit` raw.
- `client/src/pages/admin/userDetail/tabs/PayoutsTab.js` — replace the "Pay periods" placeholder card with a real list fetched from the new `/api/admin/payroll/contractors/:id/payouts` endpoint. Read-only.
- `client/src/pages/admin/FinancialsDashboard.js` — add a "Payroll" link in the page header that navigates to `/financials/payroll`.

Pure helpers live in `server/utils/`. The route file is one focused file with all `/payroll/*` endpoints behind the same auth guard. The frontend is broken into small components so each is easy to hold in head — `PayoutRow.js` does not exceed ~300 lines, `EventLineItem.js` stays under ~200, and `MarkPaidAction.js` plus `PayQRModal.js` together stay under ~250.

---

## Task 1: payrollProcessing.js — find-current-period and total recompute

**Files:**
- Create: `server/utils/payrollProcessing.js`
- Create: `server/utils/payrollProcessing.test.js`

Three short helpers, all transaction-friendly (each takes an optional client/executor), tested in isolation so the route file stays a thin orchestrator.

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollProcessing.test.js`:

```js
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  findOpenPeriodForDate, recomputePayoutTotal, maybeFinalizePeriod,
} = require('./payrollProcessing');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollProcessing.test.js refuses to run against production');
}

let userId, periodId, payoutId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('proc@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2026-05-26','2026-06-01','2026-06-02','open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open' RETURNING id`
  );
  periodId = p.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1,$2,'pending',0) RETURNING id`,
    [periodId, userId]
  );
  payoutId = po.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM payout_events WHERE payout_id = $1', [payoutId]);
  await pool.query('DELETE FROM payouts WHERE id = $1', [payoutId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('findOpenPeriodForDate > returns the open period containing the date', async () => {
  const row = await findOpenPeriodForDate(pool, '2026-05-29');
  assert.equal(row.id, periodId);
  assert.equal(row.status, 'open');
});

test('findOpenPeriodForDate > returns null when no open period contains the date', async () => {
  const row = await findOpenPeriodForDate(pool, '2030-01-01');
  assert.equal(row, null);
});

test('recomputePayoutTotal > sums line_total_cents and writes to payouts.total_cents', async () => {
  // Need a shift to attach the payout_events line items to.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents, line_total_cents)
       VALUES ($1, $2, 5.5, 5.5, 2000, 11000, 11000)`,
      [payoutId, shiftId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 11000);
    const { rows } = await pool.query('SELECT total_cents FROM payouts WHERE id = $1', [payoutId]);
    assert.equal(rows[0].total_cents, 11000);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('recomputePayoutTotal > floors at 0 when line items sum negative', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status)
     VALUES ('2026-05-29','6:00 PM','open') RETURNING id`
  );
  const shiftId = s.rows[0].id;
  try {
    // line_total_cents already floors at 0 per the column write path, but the
    // safety net at the SUM is the second belt: an adjustment-driven negative
    // SUM never escapes as a negative total_cents.
    await pool.query(
      `INSERT INTO payout_events
         (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
          adjustment_cents, line_total_cents)
       VALUES ($1, $2, 0, 0, 0, 0, -5000, 0)`,
      [payoutId, shiftId]
    );
    const total = await recomputePayoutTotal(pool, payoutId);
    assert.equal(total, 0);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
});

test('maybeFinalizePeriod > flips to paid when no pending payouts remain', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  await pool.query("UPDATE payouts SET status = 'paid' WHERE id = $1", [payoutId]);
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, true);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'paid');
});

test('maybeFinalizePeriod > does not flip when a pending payout remains', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  // payout is still pending.
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, false);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'processing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollProcessing.test.js`
Expected: FAIL, cannot find module `./payrollProcessing`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/payrollProcessing.js`:

```js
/**
 * DB helpers shared by the payroll portal routes. Each helper accepts an
 * executor (pool OR a pg client mid-transaction) so callers can either run
 * standalone or join a transaction the route already opened.
 */

/**
 * Find the OPEN pay period that contains the given calendar date (YYYY-MM-DD).
 * Returns the row { id, start_date, end_date, payday, status } or null.
 * Used to resolve "current period" on the worklist.
 */
async function findOpenPeriodForDate(executor, ymd) {
  const { rows } = await executor.query(
    `SELECT id, start_date, end_date, payday, status
       FROM pay_periods
      WHERE status = 'open'
        AND $1::date BETWEEN start_date AND end_date
      ORDER BY start_date DESC
      LIMIT 1`,
    [ymd]
  );
  return rows[0] || null;
}

/**
 * Sum a payout's line items and write the result to payouts.total_cents.
 * Returns the new total. Floors at 0 as a defensive belt — line_total_cents
 * already floors at the write path, so this only matters if a future bug
 * lets a negative line through.
 */
async function recomputePayoutTotal(executor, payoutId) {
  const { rows } = await executor.query(
    `UPDATE payouts po
        SET total_cents = GREATEST(0, COALESCE((
              SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
            ), 0))
      WHERE po.id = $1
      RETURNING total_cents`,
    [payoutId]
  );
  return rows[0] ? Number(rows[0].total_cents) : 0;
}

/**
 * If every payout in the period is `paid`, flip the period to `paid`.
 * Returns true if the flip happened, false if there is still a pending payout
 * (or if the period was not in `processing` to begin with).
 */
async function maybeFinalizePeriod(executor, periodId) {
  const { rows: countRows } = await executor.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM payouts WHERE pay_period_id = $1`,
    [periodId]
  );
  if (Number(countRows[0].pending) > 0) return false;
  const { rowCount } = await executor.query(
    `UPDATE pay_periods SET status = 'paid'
      WHERE id = $1 AND status = 'processing'`,
    [periodId]
  );
  return rowCount > 0;
}

module.exports = { findOpenPeriodForDate, recomputePayoutTotal, maybeFinalizePeriod };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollProcessing.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollProcessing.js server/utils/payrollProcessing.test.js
git commit -m "feat(payroll): processing helpers for portal routes"
```

---

## Task 2: Admin payroll route scaffold + mount

**Files:**
- Create: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/index.js` (add mount line)

A focused scaffold so subsequent tasks just add route handlers to a file that already loads and mounts. The scaffold lands one trivial healthcheck endpoint so the test infrastructure is wired before the real endpoints arrive.

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/payroll.test.js`:

```js
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

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('payroll-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { id: adminId, email: 'payroll-admin@example.com', role: 'admin' },
    process.env.JWT_SECRET
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
  await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const r = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL, cannot find module `./payroll`.

- [ ] **Step 3: Create the route scaffold**

Create `server/routes/admin/payroll.js`:

```js
/**
 * Admin-only payroll portal routes mounted at /api/admin/payroll/*.
 *
 * Auth: every route below is gated by `auth` + `adminOnly` (Section 13:
 * Payroll is admin-only in this version; managers do not have access).
 * Money-touching endpoints wrap multi-statement work in a transaction.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

// Cheap liveness probe. Real endpoints follow in subsequent tasks.
router.get('/payroll/healthcheck', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

module.exports = router;
```

Modify `server/routes/admin/index.js` to add the mount. Find the existing `router.use('/', require('./search'));` line and add immediately after it:

```js
router.use('/', require('./payroll'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify the admin router still loads**

Run: `node -e "require('dotenv').config(); require('./server/routes/admin'); console.log('loads ok')"`
Expected: prints `loads ok`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js server/routes/admin/index.js
git commit -m "feat(payroll): admin payroll route scaffold + mount"
```

---

## Task 3: GET endpoints — periods list, current, by id

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

Three reads:
- `GET /api/admin/payroll/periods` — list, newest first. Each row: `{ id, start_date, end_date, payday, status, total_cents, paid_count, pending_count }`.
- `GET /api/admin/payroll/periods/current` — the open period containing today (or the most recent open period if today falls outside any), plus its full payout payload.
- `GET /api/admin/payroll/periods/:id` — same payload shape as current, for an arbitrary period.

The "full payout payload" is shared. Each payout row carries its `payout_events` array nested under it so the UI can render the expanded view without a follow-up fetch.

**API contract** for the period-detail payload (returned by both `/current` and `/:id`):

```json
{
  "period": {
    "id": 12, "start_date": "2026-05-26", "end_date": "2026-06-01",
    "payday": "2026-06-02", "status": "open",
    "total_cents": 84000, "paid_count": 0, "pending_count": 3
  },
  "payouts": [
    {
      "id": 41, "contractor_id": 9, "contractor_name": "Alex Stone",
      "preferred_payment_method": "venmo", "venmo_handle": "alex-stone",
      "cashapp_handle": null, "paypal_url": null,
      "status": "pending", "total_cents": 28000,
      "payment_method": null, "payment_handle": null,
      "paid_at": null, "paystub_storage_key": null,
      "events": [
        {
          "id": 88, "payout_id": 41, "shift_id": 503,
          "event_date": "2026-05-27", "event_type": "wedding",
          "event_type_custom": null,
          "contracted_hours": "5.50", "hours": "5.50", "rate_cents": 2000,
          "wage_cents": 11000, "late": false,
          "gratuity_share_cents": 10000,
          "card_tip_gross_cents": 7000, "card_tip_fee_cents": 224, "card_tip_net_cents": 6776,
          "adjustment_cents": 0, "adjustment_note": null,
          "line_total_cents": 27776
        }
      ]
    }
  ]
}
```

The list endpoint returns just the per-period summary (no nested payouts) for the history index.

- [ ] **Step 1: Add the failing tests**

Append to `server/routes/admin/payroll.test.js` (the `before` block already sets up the admin user and harness; just add the test data + tests). First, add a contractor and a period to `before`:

Replace the existing `before` block with this expanded version:

```js
let contractorId, periodId, payoutId, shiftId, proposalId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('payroll-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { id: adminId, email: 'payroll-admin@example.com', role: 'admin' },
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
```

Replace the `after` block too, so it cleans up the new fixtures in the right order:

```js
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
```

Now add three tests at the bottom of the file:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — the new routes don't exist (404 for `/periods`, `/periods/current`, `/periods/:id`).

- [ ] **Step 3: Add the GET endpoints**

In `server/routes/admin/payroll.js`, add these imports near the top after the existing ones:

```js
const { NotFoundError } = require('../../utils/errors');
const { findOpenPeriodForDate } = require('../../utils/payrollProcessing');
```

Then add three handlers below the healthcheck route. First, a private helper for the shared payload:

```js
// Reusable: hydrate a period with its payouts and each payout's events.
async function loadPeriodWithPayouts(periodRow) {
  const payoutsRes = await pool.query(
    `SELECT po.id, po.contractor_id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.paid_at, po.paystub_storage_key,
            COALESCE(cp.preferred_name, u.email) AS contractor_name,
            pp.preferred_payment_method, pp.venmo_handle, pp.cashapp_handle, pp.paypal_url
       FROM payouts po
       JOIN users u ON u.id = po.contractor_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = po.contractor_id
  LEFT JOIN payment_profiles pp ON pp.user_id = po.contractor_id
      WHERE po.pay_period_id = $1
      ORDER BY COALESCE(cp.preferred_name, u.email) ASC`,
    [periodRow.id]
  );
  const payoutIds = payoutsRes.rows.map(p => p.id);
  let eventsByPayout = {};
  if (payoutIds.length > 0) {
    const eventsRes = await pool.query(
      `SELECT pe.id, pe.payout_id, pe.shift_id,
              pe.contracted_hours, pe.hours, pe.rate_cents, pe.wage_cents, pe.late,
              pe.gratuity_share_cents,
              pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents,
              pe.adjustment_cents, pe.adjustment_note, pe.line_total_cents,
              p.event_date, p.event_type, p.event_type_custom
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE pe.payout_id = ANY($1::int[])
        ORDER BY p.event_date ASC, pe.id ASC`,
      [payoutIds]
    );
    for (const ev of eventsRes.rows) {
      (eventsByPayout[ev.payout_id] ||= []).push(ev);
    }
  }
  const payouts = payoutsRes.rows.map(p => ({ ...p, events: eventsByPayout[p.id] || [] }));
  return { period: periodRow, payouts };
}

router.get('/payroll/periods', auth, adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.id, pp.start_date, pp.end_date, pp.payday, pp.status,
            COALESCE(SUM(po.total_cents), 0) AS total_cents,
            COUNT(po.id) FILTER (WHERE po.status = 'paid') AS paid_count,
            COUNT(po.id) FILTER (WHERE po.status = 'pending') AS pending_count
       FROM pay_periods pp
  LEFT JOIN payouts po ON po.pay_period_id = pp.id
   GROUP BY pp.id
   ORDER BY pp.start_date DESC`
  );
  res.json({ periods: rows });
}));

router.get('/payroll/periods/current', auth, adminOnly, asyncHandler(async (req, res) => {
  // Today in the server's local tz, then fall back to the most recent open
  // period if today is not inside any open one (e.g., between the freeze of
  // one period and the accrual of the first event in the next).
  const todayYmd = new Date().toISOString().slice(0, 10);
  let period = await findOpenPeriodForDate(pool, todayYmd);
  if (!period) {
    const { rows } = await pool.query(
      `SELECT id, start_date, end_date, payday, status
         FROM pay_periods WHERE status = 'open'
        ORDER BY start_date DESC LIMIT 1`
    );
    period = rows[0] || null;
  }
  if (!period) return res.json({ period: null, payouts: [] });
  res.json(await loadPeriodWithPayouts(period));
}));

router.get('/payroll/periods/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
  const { rows } = await pool.query(
    `SELECT id, start_date, end_date, payday, status FROM pay_periods WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Period not found');
  res.json(await loadPeriodWithPayouts(rows[0]));
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 6 tests (2 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): GET endpoints for period list, current, and detail"
```

---

## Task 4: PATCH /payout-events/:id — inline edit

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

**API:** `PATCH /api/admin/payroll/payout-events/:id` — body may carry any subset of `{ hours, rate_cents, late, adjustment_cents, adjustment_note }`. Server:
- Validates types and ranges (hours ≥ 0 and ≤ 24, rate_cents an integer ≥ 0, adjustment_cents an integer (may be negative), adjustment_note ≤ 500 chars).
- **Refuses** with `409 Conflict` if the parent payout is `paid` OR the period is `paid` (the row is frozen). Allowed when the period is `processing` and the payout is `pending` (per spec Section 6.3: admin manual adjustments still apply during processing).
- Re-derives `wage_cents = round(hours * rate_cents)` and `line_total_cents = max(0, wage + gratuity_share + card_tip_net + adjustment)`. All math in JS (consistent with Phase 1 accrual).
- Recomputes the parent payout's `total_cents`.
- All four updates (the line, the line totals, the payout total) inside a single transaction.

Returns the refreshed `payout_event` row + the updated parent `payout.total_cents`.

- [ ] **Step 1: Add the failing tests**

Append to `server/routes/admin/payroll.test.js`. Add a `payoutEventId` to the global lets at the top (or just SELECT it in each test). First, expand the request helper to support POST/PATCH with a JSON body — replace the existing `req` function with this generalized version:

```js
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
```

Then the tests:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Add the handler**

In `server/routes/admin/payroll.js`, add to the top imports:

```js
const { ValidationError, ConflictError } = require('../../utils/errors');
const { recomputePayoutTotal } = require('../../utils/payrollProcessing');
```

Then add the handler below the GET endpoints:

```js
const EDITABLE_FIELDS = ['hours', 'rate_cents', 'late', 'adjustment_cents', 'adjustment_note'];

router.patch('/payroll/payout-events/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) throw new ValidationError('invalid event id');

  // Pick only the editable keys actually present in the body.
  const patch = {};
  for (const k of EDITABLE_FIELDS) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) throw new ValidationError('no editable fields supplied');

  // Validate field-by-field.
  if ('hours' in patch) {
    const n = Number(patch.hours);
    if (!Number.isFinite(n) || n < 0 || n > 24) {
      throw new ValidationError('hours must be between 0 and 24');
    }
    patch.hours = n;
  }
  if ('rate_cents' in patch) {
    const n = Number(patch.rate_cents);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      throw new ValidationError('rate_cents must be an integer between 0 and 100000');
    }
    patch.rate_cents = n;
  }
  if ('late' in patch) {
    if (typeof patch.late !== 'boolean') throw new ValidationError('late must be a boolean');
  }
  if ('adjustment_cents' in patch) {
    const n = Number(patch.adjustment_cents);
    if (!Number.isInteger(n) || Math.abs(n) > 100000) {
      throw new ValidationError('adjustment_cents must be an integer within +/-100000');
    }
    patch.adjustment_cents = n;
  }
  if ('adjustment_note' in patch) {
    const s = patch.adjustment_note == null ? null : String(patch.adjustment_note);
    if (s != null && s.length > 500) {
      throw new ValidationError('adjustment_note exceeds 500 chars');
    }
    patch.adjustment_note = s;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pin the row + its parent payout + its period for the update.
    const { rows } = await client.query(
      `SELECT pe.*, po.id AS payout_id, po.status AS payout_status,
              pp.id AS pay_period_id, pp.status AS period_status
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE pe.id = $1
        FOR UPDATE OF pe, po`,
      [eventId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout_event not found');
    }
    const row = rows[0];
    if (row.payout_status === 'paid' || row.period_status === 'paid') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout or period is paid; edits are frozen');
    }

    // Apply the patch on top of the current row.
    const next = {
      hours: 'hours' in patch ? patch.hours : Number(row.hours),
      rate_cents: 'rate_cents' in patch ? patch.rate_cents : Number(row.rate_cents),
      late: 'late' in patch ? patch.late : row.late,
      adjustment_cents: 'adjustment_cents' in patch ? patch.adjustment_cents : Number(row.adjustment_cents),
      adjustment_note: 'adjustment_note' in patch ? patch.adjustment_note : row.adjustment_note,
    };
    const wage = Math.round(next.hours * next.rate_cents);
    const lineTotal = Math.max(
      0,
      wage + Number(row.gratuity_share_cents) + Number(row.card_tip_net_cents) + next.adjustment_cents
    );

    await client.query(
      `UPDATE payout_events
          SET hours = $1, rate_cents = $2, late = $3,
              adjustment_cents = $4, adjustment_note = $5,
              wage_cents = $6, line_total_cents = $7
        WHERE id = $8`,
      [next.hours, next.rate_cents, next.late,
       next.adjustment_cents, next.adjustment_note,
       wage, lineTotal, eventId]
    );
    const payoutTotal = await recomputePayoutTotal(client, row.payout_id);
    await client.query('COMMIT');

    const refreshed = await pool.query(
      `SELECT * FROM payout_events WHERE id = $1`, [eventId]
    );
    res.json({ event: refreshed.rows[0], payout_total_cents: payoutTotal });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignored on already-rolled-back */ }
    throw err;
  } finally {
    client.release();
  }
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): inline edit of payout_events"
```

---

## Task 5: POST /periods/:id/process — freeze open → processing

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

**API:** `POST /api/admin/payroll/periods/:id/process` — no body. Flips the period to `processing` if currently `open`. Returns the updated period row. Refuses with `409` if not `open`.

The freeze takes effect immediately: Phase 1's `accruePayoutsForProposal` already guards on `payPeriod.status !== 'open'` and silently no-ops, so no further auto-recomputes will land. Admin inline edits remain allowed (Task 4 only refuses on `paid`).

- [ ] **Step 1: Add the failing tests**

Append to `server/routes/admin/payroll.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — `404` for `/periods/:id/process`.

- [ ] **Step 3: Add the handler**

In `server/routes/admin/payroll.js`, add after the PATCH handler:

```js
router.post('/payroll/periods/:id/process', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
  const { rows } = await pool.query(
    `UPDATE pay_periods SET status = 'processing'
      WHERE id = $1 AND status = 'open'
      RETURNING id, start_date, end_date, payday, status`,
    [id]
  );
  if (!rows[0]) {
    // Either the period doesn't exist or it's not open.
    const existing = await pool.query(
      'SELECT status FROM pay_periods WHERE id = $1', [id]
    );
    if (!existing.rows[0]) throw new NotFoundError('Period not found');
    throw new ConflictError(`Period is ${existing.rows[0].status}, not open`);
  }
  res.json({ period: rows[0] });
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): process-period action freezes open to processing"
```

---

## Task 6: POST /payouts/:id/mark-paid — record payment + maybe-finalize

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

**API:** `POST /api/admin/payroll/payouts/:id/mark-paid` — body `{ payment_method, payment_handle }`.
- `payment_method` must be one of `'venmo' | 'cashapp' | 'paypal' | 'check' | 'direct_deposit' | 'other'`.
- `payment_handle` is the snapshot of the handle/note used (a string, ≤ 200 chars, optional).
- Refuses with `409` if the payout isn't `pending`, OR if the period isn't `processing` (you can only mark paid after Process Payroll).
- Sets `status='paid'`, `payment_method`, `payment_handle`, `paid_at=NOW()`, `paid_by=req.user.id`.
- Calls `maybeFinalizePeriod` — if this was the last `pending` payout in the period, the period flips to `paid`.
- Phase 3 will add paystub-PDF generation here; in Phase 2 the column stays NULL.

Returns the refreshed payout and a `period_status` flag so the UI can refresh the header if the period closed.

- [ ] **Step 1: Add the failing tests**

Append to `server/routes/admin/payroll.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — `404` for the mark-paid route.

- [ ] **Step 3: Add the handler**

In `server/routes/admin/payroll.js`, add to the imports near the top:

```js
const { maybeFinalizePeriod } = require('../../utils/payrollProcessing');
```

And add to the constants block near `EDITABLE_FIELDS`:

```js
const ALLOWED_PAY_METHODS = new Set(['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other']);
```

Then add the handler after the process-period route:

```js
router.post('/payroll/payouts/:id/mark-paid', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError('invalid payout id');

  const method = req.body && req.body.payment_method;
  if (!method || !ALLOWED_PAY_METHODS.has(method)) {
    throw new ValidationError(`payment_method must be one of ${[...ALLOWED_PAY_METHODS].join(', ')}`);
  }
  const handle = req.body && req.body.payment_handle != null ? String(req.body.payment_handle) : null;
  if (handle != null && handle.length > 200) {
    throw new ValidationError('payment_handle exceeds 200 chars');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT po.id, po.status AS payout_status, po.pay_period_id,
              pp.status AS period_status
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.id = $1
        FOR UPDATE OF po`,
      [id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout not found');
    }
    if (rows[0].payout_status !== 'pending') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout is already paid');
    }
    if (rows[0].period_status !== 'processing') {
      await client.query('ROLLBACK');
      throw new ConflictError(`period is ${rows[0].period_status}; mark-paid requires processing`);
    }

    await client.query(
      `UPDATE payouts
          SET status = 'paid', payment_method = $1, payment_handle = $2,
              paid_at = NOW(), paid_by = $3
        WHERE id = $4`,
      [method, handle, req.user.id, id]
    );

    const finalized = await maybeFinalizePeriod(client, rows[0].pay_period_id);
    await client.query('COMMIT');

    const refreshed = await pool.query(
      `SELECT id, contractor_id, status, total_cents,
              payment_method, payment_handle, paid_at, paystub_storage_key
         FROM payouts WHERE id = $1`,
      [id]
    );
    res.json({
      payout: refreshed.rows[0],
      period_status: finalized ? 'paid' : 'processing',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): mark-paid endpoint with period finalization"
```

---

## Task 7: Unassigned tips — list, assign, frozen-period flag

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

Two endpoints plus a small data shape that includes a `frozen_period` flag so the panel can tell the admin when an assignment landed against a `processing` or `paid` period (the late-tip case where Phase 2 records the match but cannot reflect it in any payout — see Known Gap at the top).

**APIs:**
- `GET /api/admin/payroll/unassigned-tips` — recent tips with `shift_id IS NULL`. Each row carries `{ id, target_user_id, contractor_name, amount_cents, tipped_at, candidate_shifts: [{ shift_id, event_date, event_type, event_label }] }`. `candidate_shifts` are the bartender's approved shifts whose event_date is within ±14 days of `tipped_at` — narrows the dropdown to plausible options.
- `PATCH /api/admin/payroll/tips/:id/assign` — body `{ shift_id }`. Sets `tips.shift_id`, then re-runs `accruePayoutsForProposal(shift's proposal_id)` so the card-tip pool refreshes. Response: `{ tip, frozen_period: boolean }` (`true` when the matched shift's period is `processing` or `paid`, signalling the late-tip case).

- [ ] **Step 1: Add the failing tests**

Append to `server/routes/admin/payroll.test.js`. First, add tip cleanup to the existing `after` (or create per-test tip rows that clean themselves). To keep the suite simple, do per-test setup:

```js
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
    await pool.query("UPDATE pay_periods SET status='open' WHERE id = $1", [periodId]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — `404` for the unassigned-tips routes.

- [ ] **Step 3: Add the handlers**

In `server/routes/admin/payroll.js`, add to the top imports:

```js
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
```

Then add the two handlers after the mark-paid route:

```js
router.get('/payroll/unassigned-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  // List recent unassigned tips. The dispatcher already retries matching, so
  // these are the genuine failures (no service window matched).
  const tipsRes = await pool.query(
    `SELECT t.id, t.target_user_id, t.amount_cents, t.tipped_at,
            COALESCE(cp.preferred_name, u.email) AS contractor_name
       FROM tips t
       JOIN users u ON u.id = t.target_user_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id
      WHERE t.shift_id IS NULL
        AND t.tipped_at > NOW() - INTERVAL '90 days'
      ORDER BY t.tipped_at DESC
      LIMIT 200`
  );
  if (tipsRes.rows.length === 0) return res.json({ tips: [] });

  // For each tip, the bartender's approved shifts within ±14 days are candidates.
  const userIds = [...new Set(tipsRes.rows.map(t => t.target_user_id))];
  const candidatesRes = await pool.query(
    `SELECT sr.user_id, s.id AS shift_id, s.event_date,
            p.event_type, p.event_type_custom
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE sr.user_id = ANY($1::int[])
        AND sr.status = 'approved'
        AND s.event_date > NOW() - INTERVAL '120 days'
      ORDER BY s.event_date DESC`,
    [userIds]
  );
  const byUser = {};
  for (const c of candidatesRes.rows) (byUser[c.user_id] ||= []).push(c);

  const tips = tipsRes.rows.map(t => {
    const all = byUser[t.target_user_id] || [];
    const tipDate = new Date(t.tipped_at);
    const within = all.filter(c => {
      const ed = new Date(`${String(c.event_date).slice(0, 10)}T12:00:00Z`);
      return Math.abs(ed - tipDate) <= 14 * 24 * 3600 * 1000;
    });
    return { ...t, candidate_shifts: within };
  });
  res.json({ tips });
}));

router.patch('/payroll/tips/:id/assign', auth, adminOnly, asyncHandler(async (req, res) => {
  const tipId = Number(req.params.id);
  const shiftId = Number(req.body && req.body.shift_id);
  if (!Number.isInteger(tipId) || !Number.isInteger(shiftId)) {
    throw new ValidationError('tipId and shift_id must be integers');
  }

  // Resolve the shift's proposal and the period that proposal accrued into.
  const shiftRes = await pool.query(
    `SELECT s.id, s.proposal_id, p.event_date FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id WHERE s.id = $1`,
    [shiftId]
  );
  if (!shiftRes.rows[0]) throw new NotFoundError('shift not found');
  const { proposal_id: proposalId, event_date: eventDate } = shiftRes.rows[0];

  // Look up the period this event falls in (it may not exist yet if no event
  // has accrued; in that case there's nothing frozen).
  let frozen = false;
  if (eventDate) {
    const ymd = String(eventDate).slice(0, 10);
    const periodRes = await pool.query(
      `SELECT status FROM pay_periods WHERE $1::date BETWEEN start_date AND end_date`,
      [ymd]
    );
    frozen = !!periodRes.rows[0] && periodRes.rows[0].status !== 'open';
  }

  // Assign the tip.
  const updated = await pool.query(
    `UPDATE tips SET shift_id = $1 WHERE id = $2 RETURNING id, shift_id, amount_cents, tipped_at`,
    [shiftId, tipId]
  );
  if (!updated.rows[0]) throw new NotFoundError('tip not found');

  // Re-accrue for the affected proposal. Phase 1's accrual no-ops on a frozen
  // period, so this is safe to call regardless — it only updates the payout
  // line items when the period is still open.
  if (proposalId) {
    try {
      await accruePayoutsForProposal(proposalId);
    } catch (err) {
      // Mirror the lifecycle hook's best-effort pattern. Do not fail the
      // admin's assignment because of an accrual hiccup.
      require('@sentry/node').captureException(err, {
        tags: { route: 'tip_assign', step: 'reaccrue' },
      });
    }
  }

  res.json({ tip: updated.rows[0], frozen_period: frozen });
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): unassigned-tips list and assign endpoints"
```

---

## Task 8: GET /contractors/:userId/payouts — the user-detail history feed

**Files:**
- Modify: `server/routes/admin/payroll.js`
- Modify: `server/routes/admin/payroll.test.js`

**API:** `GET /api/admin/payroll/contractors/:userId/payouts` — list a single contractor's payouts (newest first), each carrying its period dates, status, total, and a count of its line items. Used by the wired-up `PayoutsTab` on the user-detail page (Task 15). Admin-only, like the rest.

- [ ] **Step 1: Add the failing test**

Append to `server/routes/admin/payroll.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: FAIL — `404` for the contractor-history route.

- [ ] **Step 3: Add the handler**

In `server/routes/admin/payroll.js`, add after the assign-tip route:

```js
router.get('/payroll/contractors/:userId/payouts', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  const { rows } = await pool.query(
    `SELECT po.id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.paid_at, po.paystub_storage_key,
            pp.id AS period_id, pp.start_date, pp.end_date, pp.payday, pp.status AS period_status,
            (SELECT COUNT(*) FROM payout_events WHERE payout_id = po.id) AS event_count
       FROM payouts po
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE po.contractor_id = $1
      ORDER BY pp.start_date DESC`,
    [userId]
  );
  res.json({
    payouts: rows.map(r => ({
      id: r.id, status: r.status, total_cents: r.total_cents,
      payment_method: r.payment_method, payment_handle: r.payment_handle,
      paid_at: r.paid_at, paystub_storage_key: r.paystub_storage_key,
      event_count: r.event_count,
      period: {
        id: r.period_id, start_date: r.start_date, end_date: r.end_date,
        payday: r.payday, status: r.period_status,
      },
    })),
  });
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/routes/admin/payroll.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Verify the full suite still passes**

Run: `npm test`
Expected: the existing baseline (348 pass / 9 pre-existing failures) plus the new 18 payroll-route tests passing.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): contractor payout history endpoint"
```

---

## Task 9: PAYMENT_METHODS cleanup (spec Section 10)

**Files:**
- Modify: `client/src/pages/admin/userDetail/helpers.js`

The existing `PAYMENT_METHODS` list (`['Zelle', 'Venmo', 'CashApp', 'PayPal', 'Direct Deposit']`) drifted from the canonical server enum (`['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other']`). Section 10 calls this out explicitly. Sync now — the new Payroll portal would otherwise inherit the broken set, and the user-detail page would still try to send `'Zelle'` (rejected by the server validator at `server/routes/admin/users.js:520`).

This task is intentionally small and standalone — no behavior change beyond the dropdown options and labels.

- [ ] **Step 1: Replace the list and add a display-label helper**

In `client/src/pages/admin/userDetail/helpers.js`, replace the existing `PAYMENT_METHODS` constant and add a label helper:

```js
// Canonical lowercase enum, matching server/routes/admin/users.js:520.
// Zelle was retired; if a contractor still has 'Zelle' on file from before the
// switch, the dropdown will not list it and the next save normalizes it.
export const PAYMENT_METHODS = ['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other'];

const PAYMENT_METHOD_LABELS = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  paypal: 'PayPal',
  check: 'Check',
  direct_deposit: 'Direct Deposit',
  other: 'Other',
};

export function paymentMethodLabel(method) {
  if (!method) return '';
  return PAYMENT_METHOD_LABELS[method] || method;
}
```

- [ ] **Step 2: Find every existing consumer and update display callsites**

Grep the client for `PAYMENT_METHODS` and `preferred_payment_method` usage:

```bash
grep -rn "PAYMENT_METHODS\|preferred_payment_method" client/src --include="*.js" --include="*.jsx" | head -20
```

For each place that renders the method value as text (not just as a `<select>` option), wrap it in `paymentMethodLabel(m)`. The `<select>` already uses the value as the option label — replace the existing option render with `<option value={m}>{paymentMethodLabel(m)}</option>` so the dropdown reads as before.

In `client/src/pages/admin/userDetail/tabs/PayoutsTab.js` line ~149, the existing render is:

```jsx
{PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
```

Replace with:

```jsx
{PAYMENT_METHODS.map(m => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}
```

And add `paymentMethodLabel` to the named import from `helpers`. Do the same swap anywhere else the bare method string is shown to a user.

- [ ] **Step 3: Verify the client still builds**

Run: `cd client && CI=true npm run build`
Expected: build succeeds, no new lint warnings introduced (existing baseline preserved). The build is Vercel's gate, so this must be clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/userDetail/helpers.js client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "fix(payroll): sync client PAYMENT_METHODS with the canonical server enum"
```

(Include any other client files touched by Step 2 in the same `git add`.)

---

## Task 10: PayrollPage scaffold + route + nav

**Files:**
- Create: `client/src/pages/admin/payroll/PayrollPage.js`
- Modify: `client/src/App.js`
- Modify: `client/src/pages/admin/FinancialsDashboard.js`

A page shell with a tab strip (Current / History / Unassigned tips), routed at `/financials/payroll`, with a link from the existing Financials page. Each tab section starts as a stub; subsequent tasks fill them in.

- [ ] **Step 1: Create the page shell**

Create `client/src/pages/admin/payroll/PayrollPage.js`:

```jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const TABS = [
  { id: 'current', label: 'Current period' },
  { id: 'history', label: 'History' },
  { id: 'unassigned', label: 'Unassigned tips' },
];

export default function PayrollPage() {
  const [tab, setTab] = useState('current');
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Payroll</div>
          <div className="page-subtitle">Weekly payroll worklist, history, and stray tips.</div>
        </div>
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/financials')}>
            ← Financials
          </button>
        </div>
      </div>

      <div className="hstack" style={{ gap: 4, marginBottom: 'var(--gap)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'current' && <CurrentTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'unassigned' && <UnassignedTab />}
    </div>
  );
}

// Stubs filled in by later tasks.
function CurrentTab() { return <div className="muted">Current-period worklist coming online.</div>; }
function HistoryTab() { return <div className="muted">Past periods coming online.</div>; }
function UnassignedTab() { return <div className="muted">Unassigned-tips panel coming online.</div>; }
```

- [ ] **Step 2: Add the route in `client/src/App.js`**

Near the existing lazy imports for admin pages (`const FinancialsDashboard = lazy(() => import('./pages/admin/FinancialsDashboard'));`), add:

```js
const PayrollPage = lazy(() => import('./pages/admin/payroll/PayrollPage'));
```

In the same `<Routes>` block where `<Route path="/financials" element={<FinancialsDashboard />} />` sits, add the line immediately after it:

```jsx
<Route path="/financials/payroll" element={<PayrollPage />} />
```

- [ ] **Step 3: Add the nav link on FinancialsDashboard**

In `client/src/pages/admin/FinancialsDashboard.js`, locate the page header `<div>` that holds the page-title and subtitle (around lines 45-50) and add a Payroll link button as a sibling of that title block:

```jsx
import { Link } from 'react-router-dom';
// ...
<div className="page-header">
  <div>
    <div className="page-title">Financials</div>
    <div className="page-subtitle">Revenue, outstanding balances, and recent payments.</div>
  </div>
  <div>
    <Link to="/financials/payroll" className="btn btn-secondary btn-sm">
      Payroll →
    </Link>
  </div>
</div>
```

If `Link` isn't already imported, add the import.

- [ ] **Step 4: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/payroll/PayrollPage.js client/src/App.js client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(payroll): payroll page scaffold, route, and Financials nav link"
```

---

## Task 11: Current-period worklist — header + payout rows (collapsed)

**Files:**
- Create: `client/src/pages/admin/payroll/PayrollHeader.js`
- Create: `client/src/pages/admin/payroll/PayoutRow.js`
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (wire `CurrentTab` to fetch and render)

`CurrentTab` fetches `/api/admin/payroll/periods/current`, renders `PayrollHeader` and one `PayoutRow` per payout. Rows are collapsed for now — the expanded view and inline edits come in Task 12.

- [ ] **Step 1: Create `PayrollHeader.js`**

```jsx
import React from 'react';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';

export default function PayrollHeader({ period, payouts, onProcess, processing }) {
  if (!period) {
    return (
      <div className="card">
        <div className="card-body muted">
          No open pay period yet. Once an event completes and accrues a payout, the period appears here.
        </div>
      </div>
    );
  }
  const total = (payouts || []).reduce((acc, p) => acc + Number(p.total_cents || 0), 0);
  const paid = (payouts || []).filter(p => p.status === 'paid').length;
  const pending = (payouts || []).filter(p => p.status === 'pending').length;

  return (
    <div className="card" style={{ marginBottom: 'var(--gap)' }}>
      <div className="card-head">
        <h3>
          {fmtDate(period.start_date)} – {fmtDate(period.end_date)}
        </h3>
        <span className={`chip ${period.status === 'open' ? 'info' : period.status === 'processing' ? 'warn' : 'ok'}`}>
          {period.status}
        </span>
      </div>
      <div className="card-body">
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Payday</div>
            <div className="stat-value">{fmtDate(period.payday)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Total payroll</div>
            <div className="stat-value">{fmt$fromCents(total)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Paid</div>
            <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{paid}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Pending</div>
            <div className="stat-value">{pending}</div>
          </div>
        </div>
        {period.status === 'open' && (
          <div className="hstack" style={{ marginTop: 12, gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onProcess}
              disabled={processing || pending === 0}
              title={pending === 0 ? 'Nothing to process yet' : 'Freeze the period to begin paying'}
            >
              {processing ? 'Processing…' : 'Process Payroll'}
            </button>
            <span className="tiny muted">
              This freezes the period; auto-recompute stops, your edits and mark-paid actions still apply.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `PayoutRow.js` (collapsed version)**

```jsx
import React from 'react';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';

export default function PayoutRow({ payout, expanded, onToggle, onMarkPaid }) {
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div
        className="card-head"
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{payout.contractor_name}</span>
          <span className="tiny muted">{paymentMethodLabel(payout.preferred_payment_method) || 'No method'}</span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
          {payout.status === 'paid'
            ? <StatusChip kind="ok">Paid</StatusChip>
            : <StatusChip kind="info">Pending</StatusChip>}
          <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="card-body">
          {/* Task 12 fills in the expanded view (per-event lines + mark-paid action). */}
          <div className="muted tiny">Expanded line items render here (Task 12).</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire `CurrentTab` to fetch and render**

Replace the stub `CurrentTab` in `PayrollPage.js` with the real one (and add the imports at the top):

```js
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { useEffect } from 'react';
import PayrollHeader from './PayrollHeader';
import PayoutRow from './PayoutRow';
```

```jsx
function CurrentTab() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set());
  const [processing, setProcessing] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.get('/admin/payroll/periods/current')
      .then(r => setData(r.data))
      .catch(err => toast.error(err.message || 'Failed to load current period'))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const processPeriod = async () => {
    if (!data?.period?.id) return;
    setProcessing(true);
    try {
      await api.post(`/admin/payroll/periods/${data.period.id}/process`);
      toast.success('Period frozen — ready to pay.');
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setProcessing(false);
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="chip danger">Couldn't load the current period.</div>;

  return (
    <>
      <PayrollHeader
        period={data.period}
        payouts={data.payouts}
        onProcess={processPeriod}
        processing={processing}
      />
      {(data.payouts || []).map(po => (
        <PayoutRow
          key={po.id}
          payout={po}
          expanded={expanded.has(po.id)}
          onToggle={() => toggle(po.id)}
        />
      ))}
      {(!data.payouts || data.payouts.length === 0) && (
        <div className="card"><div className="card-body muted">No payouts in this period yet.</div></div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/payroll/PayrollHeader.js client/src/pages/admin/payroll/PayoutRow.js client/src/pages/admin/payroll/PayrollPage.js
git commit -m "feat(payroll): current-period worklist with header and collapsed rows"
```

---

## Task 12: Expanded payout row + inline edit on payout_events

**Files:**
- Create: `client/src/pages/admin/payroll/EventLineItem.js`
- Modify: `client/src/pages/admin/payroll/PayoutRow.js` (render the expanded view, plumb edits)
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (lift the edit handler so changes refresh the row)

`EventLineItem` shows one `payout_events` row with inline-editable `hours`, `rate_cents`, `late`, and the adjustment fields. PATCH on blur; the server is the source of truth for the recomputed wage / line total / payout total.

- [ ] **Step 1: Create `EventLineItem.js`**

```jsx
import React, { useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

export default function EventLineItem({ event, editable, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState({
    hours: event.hours,
    rate_dollars: (Number(event.rate_cents) / 100).toFixed(2),
    late: !!event.late,
    adjustment_dollars: (Number(event.adjustment_cents) / 100).toFixed(2),
    adjustment_note: event.adjustment_note || '',
  });
  const [saving, setSaving] = useState(false);

  const eventLabel = getEventTypeLabel({
    event_type: event.event_type, event_type_custom: event.event_type_custom,
  });

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/admin/payroll/payout-events/${event.id}`, patch);
      onSaved?.(data); // { event, payout_total_cents }
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const commitHours = () => {
    const n = Number(draft.hours);
    if (!Number.isFinite(n) || n === Number(event.hours)) return;
    save({ hours: n });
  };
  const commitRate = () => {
    const cents = Math.round(Number(draft.rate_dollars) * 100);
    if (!Number.isInteger(cents) || cents === Number(event.rate_cents)) return;
    save({ rate_cents: cents });
  };
  const commitAdjustment = () => {
    const cents = Math.round(Number(draft.adjustment_dollars) * 100);
    if (!Number.isInteger(cents)) return;
    if (cents === Number(event.adjustment_cents) && draft.adjustment_note === (event.adjustment_note || '')) return;
    save({ adjustment_cents: cents, adjustment_note: draft.adjustment_note || null });
  };
  const toggleLate = () => {
    const next = !draft.late;
    setDraft(d => ({ ...d, late: next }));
    save({ late: next });
  };

  return (
    <div className="vstack" style={{ gap: 6, padding: '10px 0', borderTop: '1px solid var(--line-1)' }}>
      <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 160 }}>
          <div className="tiny muted">{fmtDate(event.event_date)}</div>
          <div style={{ fontWeight: 600 }}>{eventLabel}</div>
        </div>
        <div className="hstack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Hours</span>
          <input
            className="input num" type="number" step="0.25" min="0" max="24"
            style={{ width: 70 }}
            value={draft.hours}
            onChange={(e) => setDraft(d => ({ ...d, hours: e.target.value }))}
            onBlur={editable ? commitHours : undefined}
            disabled={!editable || saving}
          />
        </div>
        <div className="hstack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Rate</span>
          <span className="tiny">$</span>
          <input
            className="input num" type="number" step="0.50" min="0"
            style={{ width: 70 }}
            value={draft.rate_dollars}
            onChange={(e) => setDraft(d => ({ ...d, rate_dollars: e.target.value }))}
            onBlur={editable ? commitRate : undefined}
            disabled={!editable || saving}
          />
          <span className="tiny muted">/hr</span>
        </div>
        <label className="hstack" style={{ gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={draft.late} onChange={editable ? toggleLate : undefined} disabled={!editable || saving} />
          <span className="tiny">Late</span>
        </label>
      </div>

      <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="tiny muted">Wage <strong>{fmt$fromCents(event.wage_cents)}</strong></div>
        <div className="tiny muted">Gratuity <strong>{fmt$fromCents(event.gratuity_share_cents)}</strong></div>
        <div className="tiny muted">
          Card tip <strong>{fmt$fromCents(event.card_tip_net_cents)}</strong>
          {Number(event.card_tip_fee_cents) > 0 && (
            <span> (gross {fmt$fromCents(event.card_tip_gross_cents)}, fee {fmt$fromCents(event.card_tip_fee_cents)})</span>
          )}
        </div>
        <div className="tiny muted">
          Adjustment
          <span className="tiny"> $</span>
          <input
            className="input num" type="number" step="0.01"
            style={{ width: 80, marginLeft: 2 }}
            value={draft.adjustment_dollars}
            onChange={(e) => setDraft(d => ({ ...d, adjustment_dollars: e.target.value }))}
            onBlur={editable ? commitAdjustment : undefined}
            disabled={!editable || saving}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            className="input" type="text" placeholder="Adjustment note (optional)"
            value={draft.adjustment_note}
            onChange={(e) => setDraft(d => ({ ...d, adjustment_note: e.target.value }))}
            onBlur={editable ? commitAdjustment : undefined}
            disabled={!editable || saving}
            maxLength={500}
          />
        </div>
        <div className="num"><strong>{fmt$fromCents(event.line_total_cents)}</strong></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the expanded view in `PayoutRow.js`**

Replace the stub `expanded && (...)` block in `PayoutRow.js` with the real one. Add an import:

```js
import EventLineItem from './EventLineItem';
```

Replace the body of the expanded section:

```jsx
{expanded && (
  <div className="card-body">
    {(payout.events || []).length === 0 && (
      <div className="muted tiny">No event lines on this payout.</div>
    )}
    {(payout.events || []).map(ev => (
      <EventLineItem
        key={ev.id}
        event={ev}
        editable={editable && payout.status === 'pending'}
        onSaved={({ event, payout_total_cents }) => onLineSaved?.(event, payout_total_cents)}
      />
    ))}
    {payout.status === 'pending' && (
      <div className="hstack" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onMarkPaid}>
          Mark paid
        </button>
        <span className="tiny muted" style={{ marginLeft: 8 }}>
          Records the method and timestamp. {editable
            ? 'Period must be processing first (use Process Payroll above).'
            : ''}
        </span>
      </div>
    )}
  </div>
)}
```

Update the `PayoutRow` props destructure to include `editable` and the two callbacks:

```jsx
export default function PayoutRow({ payout, expanded, onToggle, onMarkPaid, onLineSaved, editable }) {
```

- [ ] **Step 3: Lift the line-save handler in `CurrentTab`**

In `PayrollPage.js`, replace the existing `<PayoutRow ... />` render with one that wires `onLineSaved` to patch local state and `editable` from the period status:

```jsx
const onLineSaved = (updatedEvent, payoutTotal) => {
  setData(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      payouts: prev.payouts.map(po =>
        po.id !== updatedEvent.payout_id ? po : {
          ...po,
          total_cents: payoutTotal,
          events: po.events.map(e => e.id === updatedEvent.id ? updatedEvent : e),
        }),
    };
  });
};

// ...inside the JSX render of CurrentTab:
{(data.payouts || []).map(po => (
  <PayoutRow
    key={po.id}
    payout={po}
    expanded={expanded.has(po.id)}
    onToggle={() => toggle(po.id)}
    onLineSaved={onLineSaved}
    onMarkPaid={() => {/* Task 13 wires this */}}
    editable={data.period && data.period.status !== 'paid'}
  />
))}
```

- [ ] **Step 4: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/payroll/EventLineItem.js client/src/pages/admin/payroll/PayoutRow.js client/src/pages/admin/payroll/PayrollPage.js
git commit -m "feat(payroll): expandable rows with inline line-item edits"
```

---

## Task 13: Mark Paid action + QR / deep-link modal

**Files:**
- Create: `client/src/pages/admin/payroll/MarkPaidAction.js`
- Create: `client/src/pages/admin/payroll/PayQRModal.js`
- Modify: `client/src/pages/admin/payroll/PayoutRow.js` (replace the stub Mark Paid button with `<MarkPaidAction />`)
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (refresh on payment, advance to next pending)

The Mark Paid flow has three branches:
- **Venmo / Cash App:** open `PayQRModal` with a `QRCodeSVG` of the prefilled deep link. Admin scans, completes payment in the phone app, then clicks "Mark paid" inside the modal which posts to the server.
- **PayPal:** open `paypal.me/<handle>/<amount>` in a new tab on the desktop. Same modal so the admin still confirms paid before posting.
- **Check / Direct Deposit / Other:** no deep link; the modal just confirms the amount and posts on Mark paid.

Deep-link formats:
- Venmo: `https://venmo.com/?txn=pay&recipients=<handle>&amount=<amt>&note=Dr.+Bartender+payroll`
- Cash App: `https://cash.app/$<cashtag>/<amt>`
- PayPal: `https://paypal.me/<handle>/<amt>` (where `<handle>` is the slug after `paypal.me/` if the saved `paypal_url` is a full URL)

Section 7 caveat: Venmo's amount-prefill is historically unreliable. Always show the amount as plain text in the modal alongside the QR so the admin can type it if the app drops the prefill.

- [ ] **Step 1: Create `PayQRModal.js`**

```jsx
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';

export default function PayQRModal({
  payout, paymentMethod, payUrl, handle, onConfirm, onCancel, confirming,
}) {
  const amount = fmt$fromCents(payout.total_cents);
  const isQR = paymentMethod === 'venmo' || paymentMethod === 'cashapp';
  return (
    <div
      role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'grid', placeItems: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="card" style={{ maxWidth: 420, width: '100%' }}>
        <div className="card-head">
          <h3>Pay {payout.contractor_name}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>
        <div className="card-body vstack" style={{ gap: 12, alignItems: 'center' }}>
          <div className="stat" style={{ textAlign: 'center' }}>
            <div className="stat-label">Amount</div>
            <div className="stat-value">{amount}</div>
            <div className="tiny muted">via {paymentMethodLabel(paymentMethod)} → {handle || '—'}</div>
          </div>

          {isQR && payUrl && (
            <>
              <QRCodeSVG value={payUrl} size={220} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin />
              <div className="tiny muted" style={{ textAlign: 'center' }}>
                Scan with your phone. {paymentMethod === 'venmo'
                  ? 'Venmo sometimes drops the amount — confirm it reads $' + amount.replace('$','') + '.'
                  : 'Cash App fills the amount reliably.'}
              </div>
            </>
          )}
          {paymentMethod === 'paypal' && payUrl && (
            <a className="btn btn-primary" href={payUrl} target="_blank" rel="noopener noreferrer">
              Open PayPal →
            </a>
          )}
          {!isQR && paymentMethod !== 'paypal' && (
            <div className="muted tiny" style={{ textAlign: 'center' }}>
              No deep link for {paymentMethodLabel(paymentMethod)}. Handle the payment in your usual flow, then confirm below.
            </div>
          )}

          <div className="hstack" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={confirming}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={confirming}>
              {confirming ? 'Recording…' : 'Mark paid'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `MarkPaidAction.js`**

```jsx
import React, { useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import PayQRModal from './PayQRModal';

// Build the prefilled deep link for the given method + handle + amount.
// Returns null when there's no deep link to offer.
function buildPayUrl(method, payout) {
  const amt = (Number(payout.total_cents) / 100).toFixed(2);
  switch (method) {
    case 'venmo': {
      const handle = (payout.venmo_handle || '').replace(/^@/, '').trim();
      if (!handle) return null;
      const note = encodeURIComponent('Dr. Bartender payroll');
      return `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
    }
    case 'cashapp': {
      const tag = (payout.cashapp_handle || '').replace(/^\$/, '').trim();
      if (!tag) return null;
      return `https://cash.app/$${encodeURIComponent(tag)}/${amt}`;
    }
    case 'paypal': {
      const url = (payout.paypal_url || '').trim();
      if (!url) return null;
      // Accept either a full paypal.me URL or a bare handle.
      const handle = url.replace(/^https?:\/\/(?:www\.)?paypal\.me\//, '').replace(/^@/, '');
      return `https://paypal.me/${encodeURIComponent(handle)}/${amt}`;
    }
    default:
      return null;
  }
}

function preferredMethod(payout) {
  return payout.preferred_payment_method || 'other';
}

function methodHandleSnapshot(method, payout) {
  switch (method) {
    case 'venmo': return payout.venmo_handle || null;
    case 'cashapp': return payout.cashapp_handle || null;
    case 'paypal': return payout.paypal_url || null;
    default: return null;
  }
}

export default function MarkPaidAction({ payout, onPaid }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const method = preferredMethod(payout);
  const payUrl = buildPayUrl(method, payout);
  const handle = methodHandleSnapshot(method, payout);

  const confirm = async () => {
    setConfirming(true);
    try {
      const { data } = await api.post(`/admin/payroll/payouts/${payout.id}/mark-paid`, {
        payment_method: method,
        payment_handle: handle,
      });
      toast.success(`Paid ${payout.contractor_name}.`);
      setOpen(false);
      onPaid?.(data); // { payout, period_status }
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Mark paid
      </button>
      {open && (
        <PayQRModal
          payout={payout}
          paymentMethod={method}
          payUrl={payUrl}
          handle={handle}
          confirming={confirming}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Wire `MarkPaidAction` into `PayoutRow.js`**

Replace the stub Mark Paid button inside the expanded view with the real component. Add the import:

```js
import MarkPaidAction from './MarkPaidAction';
```

Replace the `payout.status === 'pending' && (...)` block with:

```jsx
{payout.status === 'pending' && (
  <div className="hstack" style={{ marginTop: 12 }}>
    <MarkPaidAction payout={payout} onPaid={onPaid} />
    <span className="tiny muted" style={{ marginLeft: 8 }}>
      Records the method and timestamp; the period closes automatically when the last payout is paid.
    </span>
  </div>
)}
```

Add `onPaid` to the `PayoutRow` props destructure.

- [ ] **Step 4: Wire `onPaid` in `CurrentTab` to refresh + auto-advance**

In `PayrollPage.js`, replace the `<PayoutRow>` render in `CurrentTab` to include `onPaid`:

```jsx
const onPaid = ({ payout, period_status }) => {
  setData(prev => {
    if (!prev) return prev;
    const payouts = prev.payouts.map(po => po.id === payout.id ? { ...po, ...payout } : po);
    return { ...prev, period: { ...prev.period, status: period_status }, payouts };
  });
  // Advance focus to the next pending row.
  setExpanded(prev => {
    const remaining = (data?.payouts || []).filter(p => p.status === 'pending' && p.id !== payout.id);
    const next = new Set();
    if (remaining[0]) next.add(remaining[0].id);
    return next;
  });
};

// ...inside the .map():
<PayoutRow
  key={po.id}
  payout={po}
  expanded={expanded.has(po.id)}
  onToggle={() => toggle(po.id)}
  onLineSaved={onLineSaved}
  onPaid={onPaid}
  editable={data.period && data.period.status !== 'paid'}
/>
```

- [ ] **Step 5: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/payroll/MarkPaidAction.js client/src/pages/admin/payroll/PayQRModal.js client/src/pages/admin/payroll/PayoutRow.js client/src/pages/admin/payroll/PayrollPage.js
git commit -m "feat(payroll): mark-paid action with method-aware QR and deep link"
```

---

## Task 14: Unassigned tips panel

**Files:**
- Create: `client/src/pages/admin/payroll/UnassignedTipsPanel.js`
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (replace the `UnassignedTab` stub)

`UnassignedTipsPanel` lists `tips.shift_id IS NULL` rows; each carries the contractor's candidate shifts in a dropdown. Pick a shift, click Assign, the tip leaves the list. If the response's `frozen_period` is true, show a brief warning that the assignment landed against a closed period (the Known Gap).

- [ ] **Step 1: Create `UnassignedTipsPanel.js`**

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

export default function UnassignedTipsPanel() {
  const toast = useToast();
  const [tips, setTips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({}); // tipId -> shiftId
  const [busy, setBusy] = useState({});

  const refresh = () => {
    setLoading(true);
    api.get('/admin/payroll/unassigned-tips')
      .then(r => setTips(r.data.tips || []))
      .catch(err => toast.error(err.message || 'Failed to load unassigned tips'))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const assign = async (tipId) => {
    const shiftId = Number(drafts[tipId]);
    if (!Number.isInteger(shiftId)) return;
    setBusy(b => ({ ...b, [tipId]: true }));
    try {
      const { data } = await api.patch(`/admin/payroll/tips/${tipId}/assign`, { shift_id: shiftId });
      if (data.frozen_period) {
        toast.warn?.('Assigned, but the matching period is already frozen. The tip is recorded; manual adjustment to the next payout may be needed.');
      } else {
        toast.success('Tip assigned.');
      }
      setTips(prev => prev.filter(t => t.id !== tipId));
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setBusy(b => ({ ...b, [tipId]: false }));
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (tips.length === 0) {
    return (
      <div className="card"><div className="card-body muted">
        No unassigned tips. The matching ran on every tip; anything that didn't land an event shows up here.
      </div></div>
    );
  }

  return (
    <div className="vstack" style={{ gap: 8 }}>
      {tips.map(tip => (
        <div key={tip.id} className="card">
          <div className="card-body hstack" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 160 }}>
              <div style={{ fontWeight: 600 }}>{tip.contractor_name}</div>
              <div className="tiny muted">{fmt$fromCents(tip.amount_cents)} on {fmtDate(tip.tipped_at)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <select
                className="select"
                value={drafts[tip.id] || ''}
                onChange={(e) => setDrafts(d => ({ ...d, [tip.id]: e.target.value }))}
              >
                <option value="">— pick an event —</option>
                {(tip.candidate_shifts || []).map(c => {
                  const lbl = getEventTypeLabel({ event_type: c.event_type, event_type_custom: c.event_type_custom });
                  return (
                    <option key={c.shift_id} value={c.shift_id}>
                      {fmtDate(c.event_date)} · {lbl}
                    </option>
                  );
                })}
              </select>
              {(!tip.candidate_shifts || tip.candidate_shifts.length === 0) && (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  No approved shifts in the ±14-day window. Either the bartender didn't work near this tip date, or shift assignment is missing.
                </div>
              )}
            </div>
            <button
              type="button" className="btn btn-primary btn-sm"
              disabled={!drafts[tip.id] || busy[tip.id]}
              onClick={() => assign(tip.id)}
            >
              {busy[tip.id] ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab**

In `PayrollPage.js`, replace the `UnassignedTab` stub with:

```js
import UnassignedTipsPanel from './UnassignedTipsPanel';
// ...
function UnassignedTab() {
  return <UnassignedTipsPanel />;
}
```

- [ ] **Step 3: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/payroll/UnassignedTipsPanel.js client/src/pages/admin/payroll/PayrollPage.js
git commit -m "feat(payroll): unassigned-tips panel with candidate-shift assignment"
```

---

## Task 15: History view — past periods, read-only

**Files:**
- Create: `client/src/pages/admin/payroll/HistoryView.js`
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (replace `HistoryTab`)

`HistoryView` lists every period (newest first). Click a row to load `/periods/:id` and render it through the same `PayrollHeader` + `PayoutRow` components, with `editable={false}` so nothing is mutable. Back link returns to the list.

- [ ] **Step 1: Create `HistoryView.js`**

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import PayrollHeader from './PayrollHeader';
import PayoutRow from './PayoutRow';

export default function HistoryView() {
  const toast = useToast();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);  // { period, payouts }
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    api.get('/admin/payroll/periods')
      .then(r => setPeriods(r.data.periods || []))
      .catch(err => toast.error(err.message || 'Failed to load periods'))
      .finally(() => setLoading(false));
  }, [toast]);

  const open = (id) => {
    setSelectedLoading(true);
    api.get(`/admin/payroll/periods/${id}`)
      .then(r => setSelected(r.data))
      .catch(err => toast.error(err.message || 'Failed to load period'))
      .finally(() => setSelectedLoading(false));
  };

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) return <div className="muted">Loading…</div>;

  if (selected) {
    return (
      <>
        <div className="hstack" style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSelected(null); setExpanded(new Set()); }}>
            ← Back to history
          </button>
        </div>
        <PayrollHeader period={selected.period} payouts={selected.payouts} onProcess={() => {}} processing={false} />
        {(selected.payouts || []).map(po => (
          <PayoutRow
            key={po.id}
            payout={po}
            expanded={expanded.has(po.id)}
            onToggle={() => toggle(po.id)}
            editable={false}
          />
        ))}
      </>
    );
  }

  return (
    <div className="card">
      <div className="card-head"><h3>All pay periods</h3></div>
      <div className="card-body">
        {selectedLoading && <div className="muted tiny">Loading period…</div>}
        {periods.length === 0 && <div className="muted tiny">No periods yet.</div>}
        {periods.map(p => (
          <div
            key={p.id}
            className="hstack"
            style={{
              padding: '10px 0', borderTop: '1px solid var(--line-1)', gap: 12,
              alignItems: 'center', cursor: 'pointer',
            }}
            onClick={() => open(p.id)}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') open(p.id); }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{fmtDate(p.start_date)} – {fmtDate(p.end_date)}</div>
              <div className="tiny muted">Payday {fmtDate(p.payday)}</div>
            </div>
            <div className="num"><strong>{fmt$fromCents(p.total_cents)}</strong></div>
            <StatusChip kind={p.status === 'paid' ? 'ok' : p.status === 'processing' ? 'warn' : 'info'}>
              {p.status}
            </StatusChip>
            <span className="tiny muted">{Number(p.paid_count)}/{Number(p.paid_count) + Number(p.pending_count)} paid</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab**

In `PayrollPage.js`, replace the `HistoryTab` stub:

```js
import HistoryView from './HistoryView';
// ...
function HistoryTab() {
  return <HistoryView />;
}
```

- [ ] **Step 3: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/payroll/HistoryView.js client/src/pages/admin/payroll/PayrollPage.js
git commit -m "feat(payroll): history view of past periods (read-only)"
```

---

## Task 16: Wire the user-detail PayoutsTab

**Files:**
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js`

Replace the placeholder "Pay periods" card with a real list fetched from `/api/admin/payroll/contractors/:id/payouts`. Read-only — clicking a row navigates to the corresponding period in the Payroll portal.

- [ ] **Step 1: Add the fetch and list**

In `client/src/pages/admin/userDetail/tabs/PayoutsTab.js`, add at the top:

```js
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../../../utils/api';
import { fmt$fromCents, fmtDate } from '../../../../components/adminos/format';
```

Inside the component, before the return, add:

```js
const { id: userIdParam } = useParams();
const navigate = useNavigate();
const [payouts, setPayouts] = useState(null);

useEffect(() => {
  if (!userIdParam) return;
  api.get(`/admin/payroll/contractors/${userIdParam}/payouts`)
    .then(r => setPayouts(r.data.payouts || []))
    .catch(() => setPayouts([]));
}, [userIdParam]);
```

Replace the existing "Pay periods placeholder" card (lines ~23-34 in the current file) with:

```jsx
<div className="card">
  <div className="card-head"><h3>Pay periods</h3></div>
  <div className="card-body">
    {payouts === null && <div className="muted tiny">Loading…</div>}
    {payouts !== null && payouts.length === 0 && (
      <div className="muted tiny">No payouts yet. Once this contractor works a completed event, the period rows land here.</div>
    )}
    {payouts !== null && payouts.length > 0 && payouts.map(po => (
      <div
        key={po.id}
        className="hstack"
        style={{ padding: '8px 0', borderTop: '1px solid var(--line-1)', gap: 8, cursor: 'pointer' }}
        onClick={() => navigate(`/financials/payroll`)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/financials/payroll`); }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{fmtDate(po.period.start_date)} – {fmtDate(po.period.end_date)}</div>
          <div className="tiny muted">{Number(po.event_count)} event{Number(po.event_count) === 1 ? '' : 's'} · Payday {fmtDate(po.period.payday)}</div>
        </div>
        <div className="num"><strong>{fmt$fromCents(po.total_cents)}</strong></div>
        <span className={`chip ${po.status === 'paid' ? 'ok' : 'info'}`}>{po.status}</span>
      </div>
    ))}
  </div>
</div>
```

- [ ] **Step 2: Verify the build**

Run: `cd client && CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "feat(payroll): wire user-detail PayoutsTab to the real payout history"
```

---

## Phase 2 done

At the end of Phase 2 the admin has a functioning payroll surface:
- A worklist at `/financials/payroll` that opens on the current open pay period, shows total payroll and paid/pending counts, and lets the admin freeze the period with one button.
- One row per contractor, expandable to its event line items, with inline-editable hours, rate, late flag, and adjustment.
- Mark Paid per row with a method-aware action (Venmo/Cash App QR, PayPal deep link, plain confirm for check/ACH/other), advancing focus to the next pending row.
- An unassigned-tips panel for tips matching couldn't place, with the bartender's candidate shifts narrowed to ±14 days.
- A read-only history view for past periods.
- The placeholder PayoutsTab on user-detail is wired to the real ledger.
- The client `PAYMENT_METHODS` constant is synced with the canonical server enum, dropping the retired `Zelle` (Section 10 fix).

The lifecycle state machine is fully enforced on the backend: `pay_periods.status` transitions `open → processing → paid`, `payouts.status` transitions `pending → paid`, and `accruePayoutsForProposal` from Phase 1 silently no-ops on non-`open` periods so a late tip cannot mutate frozen money.

**Still nothing user-facing for staff.** Phase 3 adds the staff My Pay page, the dashboard tile, and the paystub PDF generation (which is what fills `paystub_storage_key` — Phase 2 leaves it NULL). Phase 4 adds the two scheduled emails (payroll-due reminder to admin, paystub-ready to contractor) and rewrites the contractor-facing pay-policy copy.

**The Known Gap** (late-tip roll-forward, spec Section 6.5) is intentionally still open. Phase 2 records the matching correctly and warns the admin when an assignment lands against a frozen period. Automatic roll-forward — synthesizing a `payout_events` row on the contractor's next open payout labeled to the original event — is its own focused task to plan separately, because picking the right "next" payout (which period? what if the bartender hasn't worked yet?) is a small design problem in its own right.
