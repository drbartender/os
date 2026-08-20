---
lanes:
  - id: sh-a-server
    footprint:
      - server/routes/admin/staffHub.js
      - server/routes/admin/staffHub.test.js
      - server/utils/staffHubSummary.js
      - server/utils/staffHubSummary.test.js
      - server/routes/admin/index.js
      - server/routes/admin/settings.js
      - server/routes/admin/settings.badgeCounts.test.js
      - server/routes/admin/users.js
      - server/routes/admin/users.activeStaff.test.js
      - server/routes/admin/contractorTipPage.js
      - server/routes/admin/contractorTipPage.test.js
      - server/routes/admin/staffReviews.js
      - server/routes/admin/staffReviews.test.js
      - server/utils/payrollDisputeNotify.js
      - server/utils/payrollDisputeNotify.test.js
      - server/routes/publicTip.js
      - server/routes/publicTip.test.js
      - scripts/sensitive-paths.txt
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: full   # payroll.js-adjacent reads, dutyLines money writer joins the sensitive list, tips money reads
  - id: sh-b-shell
    footprint:
      - client/src/pages/admin/staffHub/StaffHubLayout.js
      - client/src/pages/admin/staffHub/hubSubtitle.js
      - client/src/pages/admin/staffHub/hubSubtitle.test.js
      - client/src/pages/admin/staffHub/StaffHubLayout.test.js
      - client/src/components/adminos/nav.js
      - client/src/components/adminos/nav.test.js
      - client/src/components/adminos/Sidebar.js
      - client/src/components/adminos/CommandPalette.js
      - client/src/components/mobile/MobileTabBar.js
      - client/src/components/AdminLayout.js
      - client/src/pages/mobile/MorePage.js
      - client/src/App.js
      - client/src/utils/screenKey.js
      - client/src/utils/screenKey.test.js
      - client/src/pages/admin/StaffDashboard.js
      - client/src/pages/admin/overview/PayrollStatus.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js
      - client/src/pages/admin/applicationDetail/AdminApplicationDetail.js
      - client/src/index.css
      - README.md
    depends_on: []   # builds against the §5 contract; integration verified at merge with sh-a on main
    review_fleet: [security-review, code-review, consistency-check, ui-ux-review]   # adminStrict guards + designed surface
  - id: sh-c-hiring
    footprint:
      - client/src/pages/admin/HiringDashboard.js
      - client/src/pages/admin/HiringDashboard.fold.test.js
    depends_on: [sh-b-shell]
    review_fleet: [code-review, consistency-check, ui-ux-review]
  - id: sh-d-payroll
    footprint:
      - client/src/pages/admin/payroll/PayrollPage.js
      - client/src/pages/admin/payroll/PayRunView.js
      - client/src/pages/admin/payroll/CurrentWeekCard.js
      - client/src/pages/admin/payroll/CurrentWeekCard.test.js
      - client/src/pages/admin/payroll/TipsLedger.js
      - client/src/pages/admin/payroll/tipStatus.js
      - client/src/pages/admin/payroll/tipStatus.test.js
      - client/src/pages/admin/payroll/UnassignedTipsPanel.js
      - client/src/pages/admin/payroll/DeferredTipsPanel.js
    depends_on: [sh-b-shell, sh-a-server]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]   # money display; no money writes
  - id: sh-e-reviews
    footprint:
      - client/src/pages/admin/staffHub/reviews/ReviewsPage.js
      - client/src/pages/admin/staffHub/reviews/PendingReviewCard.js
      - client/src/pages/admin/staffHub/reviews/LogReviewForm.js
      - client/src/pages/admin/staffHub/reviews/ResolvedTable.js
      - client/src/pages/admin/staffHub/reviews/ContestRail.js
      - client/src/pages/admin/staffHub/reviews/AwardDialog.js
      - client/src/pages/admin/staffHub/reviews/suggestNames.js
      - client/src/pages/admin/staffHub/reviews/suggestNames.test.js
      - client/src/pages/admin/StaffReviews.js
      - client/src/App.js
      - client/src/index.css
    depends_on: [sh-b-shell, sh-a-server]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]   # confirm/dismiss/award drive payout_duty_lines writes
  - id: sh-f-feedback
    footprint:
      - client/src/pages/admin/userDetail/tabs/TipPageTab.js
      - client/src/pages/admin/userDetail/tabs/FeedbackCard.js
      - client/src/pages/admin/TipsAdmin.js
      - client/src/App.js                # added 2026-08-19: F1 deletes TipsAdmin.js and App.js is its only remaining caller
      - server/routes/publicTip.js       # added 2026-08-19: Task A8 (the alert-email re-point) moved into this lane
      - server/routes/publicTip.test.js  # b114e9f0 aimed this test at the OLD url; F1 inverts it in the same commit
      - README.md
    # depends_on gained sh-b-shell on 2026-08-19. F1 deletes TipsAdmin.js, whose only remaining
    # caller is the App.js lazy import and /tips route that B4 (a sh-b task) removed and commit
    # b114e9f0 restored, so this lane owns client/src/App.js. That coupling was never declared,
    # so nothing forced a re-check of App.js before scheduling sh-f, and that undeclared coupling
    # is what produced the b114e9f0 revert.
    depends_on: [sh-a-server, sh-b-shell, sh-d-payroll, sh-e-reviews]   # ledger (sh-d) and reviews (sh-e) must land first: F1 deletes TipsAdmin.js and its done-gate greps for StaffReviews, which sh-e removes
    review_fleet: [code-review, consistency-check, security-review]
  - id: sh-g-fidelity
    footprint:
      - client/src/index.css
      - docs/design-artifacts/2026-08-19-staff-hub.dc.html
      - client/src/pages/admin/StaffDashboard.js
      - client/src/pages/admin/HiringDashboard.js
      - client/src/pages/admin/payroll/**
      - client/src/pages/admin/staffHub/**
      - client/src/pages/admin/userDetail/tabs/FeedbackCard.js
    depends_on: [sh-c-hiring, sh-d-payroll, sh-e-reviews, sh-f-feedback]
    review_fleet: [code-review, ui-ux-review]   # ui-ux-review points at the benchmark artifact; off-design is a finding
---

# Admin Staff Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Footprint convention (recorded 2026-08-19, after both merged phases drifted):** a lane's declared footprint must list the TEST files its tasks create, not only the source files they change. Phase 1 landed `StaffDashboard.grouping.test.js` (sh-b) and phase 2 landed `PayRunView.currentWeek.test.js`, `TipsLedger.test.js`, `PayrollPage.tips.test.js` (sh-d), `ReviewsPage.test.js` and `PendingReviewCard.test.js` (sh-e). None of the six was declared, so both merges raised footprint-drift warnings for files this plan's own task bodies mandate.

**Goal:** Collapse Staff, Hiring, Tips & Feedback, Reviews and the unlisted Payroll into one sidebar entry, Staff, that opens a hub where Roster lands and Hiring, Payroll, Reviews are header-fused tabs; tips fold into Payroll, feedback moves to the staffer profile.

**Architecture:** A `StaffHubLayout` route component (the `MarketingLayout` pattern) owns one summary fetch and shares `{summary, refresh, setActions}` through Outlet context to four children. Children are the existing page components stripped of their own headers, plus a restructured Reviews page. Server work is read-only: one new summary endpoint with a date-derived pay-run window, one roster-feed join fix, three projection/param extensions. No schema change, no writes.

**Tech Stack:** Node 26 / Express 4 / `pg` raw SQL / `node:test` on the server; React 18 (CRA) / React Router 6 / jest + RTL on the client; vanilla CSS in `client/src/index.css`.

**Spec:** `docs/superpowers/specs/2026-08-19-admin-staff-hub-design.md` (approved 2026-08-19; `/review-spec` fleet folded in the same day). The design benchmark is `docs/design-artifacts/2026-08-19-staff-hub.dc.html` (design project `96291c7a-3510-4910-9c67-c41d81504920`); its `<style>` block carries the hub CSS marked "ships verbatim to client/src/index.css".

**Verified-harmless notes (from the plan fleet, so nobody re-litigates):** `overview/queueItems.js:67` carries only `target: 'hiring'`; the URL it feeds is `NeedsYouStrip.js:31`, which B5 retargets, so `queueItems.js` needs no edit. The Reviews page lives at `staffHub/reviews/ReviewsPage.js` (one directory deeper than the spec's `staffHub/ReviewsPage.js`) to hold the six-file split; deliberate.

**Lane graph (run order):** `sh-a-server` and `sh-b-shell` in parallel. Then `sh-c-hiring`, `sh-d-payroll`, `sh-e-reviews` in parallel (all need the hub's Outlet context from sh-b; d and e also read sh-a's new fields). `sh-f-feedback` after sh-b, sh-d and sh-e (it deletes `TipsAdmin.js`, whose ledger sh-d moved, whose only caller is the `App.js` route sh-b owns, and whose done-gate greps for the `StaffReviews.js` sh-e deleted). `sh-g-fidelity` last, across all screens.

**Proven context (verified against the repo 2026-08-19, not from memory):**
- Server route tests are hand-rolled: a minimal `express()` app with the real router and real `auth` middleware, driven via `node:http` + `node:test`; see `server/routes/admin/settings.badgeCounts.test.js` for the harness every new server test in this plan copies (makeUser / tokenFor / get helpers, `AppError` error middleware, `pool.end()` in `after`). Run one file at a time from the repo root: `node -r dotenv/config --test server/routes/admin/<file>.test.js`.
- `req.user` carries `role` and `can_staff` (`users.js:464`). `adminOnly` rejects non-admins; `requireAdminOrManager` admits both (`server/middleware/auth.js:79-95`).
- `payPeriodForDate(ymd)` → `{ startDate, endDate }` and `computePayday(endDate)` are pure (`server/utils/payrollPeriods.js`); `chicagoTodayYmd()` is in `server/utils/businessTime.js:55`. `ensurePayPeriod` (`payrollAccrual.js:117`) is the lazy `pay_periods` writer; `payrollLateTip.js:92-100` and `payrollClawback.js` wrap `findOpenPeriodForDate` in an `INSERT` fallback that the summary endpoint must NOT copy.
- `GET /admin/active-staff` (`users.js:462-530`): `JOIN onboarding_progress op` + `op.onboarding_completed = true`, `?include_stubs=true` widens the status list to include `deactivated`, default `limit` 50 max 100, managers need `can_staff`, legacy-CC stub emails are redacted for non-admins.
- `GET /admin/tips` (`contractorTipPage.js:263-304`): cursor-paginated, `limit` default 50; projects `id, amount_cents, tipped_at, customer_email, bartender_name, target_user_id`. `tips` also has `shift_id, deferred_at, rolled_forward_at, refunded_amount_cents, dispute_won_at` (schema ALTERs).
- `GET /admin/tip-feedback` (`:305-326`) filters `status` only. `POST /tip-feedback/:id/review` (`:327`). Both `adminOnly`.
- `GET /admin/staff-reviews` (`staffReviews.js:135-152`) returns `{ reviews }` only; `REVIEW_BOUNTY_CENTS` is exported from `server/utils/dutyLines.js` and in no payload. `POST /:id/confirm` returns `{ review, materialized, restored, catch_up_materialized }`. The leaderboard (`staffReviewsContest.js:147-161`) returns `rows, shares, pot_cents, min_events_worked (4), min_named_five_stars (2), in_progress, start_date, end_date`; award 409s with code `QUARTER_IN_PROGRESS` unless `force: true`, and 409s "no open pay period" when none is open.
- `GET /admin/badge-counts` (`settings.js:128-175`) zeroes `new_applications` for managers at `:167`.
- `GET /admin/applications?page=1&limit=200` projects `u.id` (the USER id), `u.created_at`, `a.created_at AS applied_at`, and computes `onboarding_progress` (0..1 over `ONBOARDING_STEPS`) and `onboarding_blocker`; the kanban's `stageOf` maps `hired` → `in_progress`.
- Client: `AdminLayout.js` polls badges every 60s in a `useEffect` (`:110-130`); the phone `<Outlet context={{ badges }} />` (`:242`) and the desktop `<Outlet />` (`:261`) differ. `Sidebar.js:69` reads the singular `badgeKey`; `MorePage.js:64` the same; `MobileTabBar.js:14` sums `MORE_KEYS = ['unread_sms','new_applications','pending_shopping_lists']`. `CommandPalette.js:148` has its own `go('/hiring')`.
- `App.js`: `ProtectedRoute({ adminOnly, adminStrict })` at `:301`; the admin shell wrapper at `:594`; `/staffing*` routes at `:597-601`; `/financials`, `/financials/payroll`, `/tips`, `/reviews` at `:617-620`; `/marketing` uses `<ProtectedRoute adminStrict>` at `:644`. `FinancialsRedirect` at `:274` uses `useSearchParams`.
- `useUrlListState(defaults)` → `[state, setState]` (URL-backed); `Toolbar({ tabs, tab, setTab, filters, right })` renders `.seg` with optional `count` per tab.
- `index.css` is 20,727 lines; admin-os rules are prefixed `html[data-app="admin-os"]` (932 such rules, zero bare `[data-app]` rules). `.seg` lives at `:12758`; the tokens the artifact CSS uses (`--row-hover`, `--font-numeric`, `--cell-pad-x`, `--line-1/2`, `--ink-1..4`, `--bg-0..3`, `--gap`, `--accent`) all exist.
- There is no `client/src/setupTests.js`: every client test imports `'@testing-library/jest-dom'` itself, first line. Client tests run with `cd client && CI=true npx react-scripts test --watchAll=false <path>`.
- `StaffReviews.js` (601 lines) holds: `ReviewLogTab` (load + retry, `duplicate_warning`), `LogReviewForm`, `ReviewCard` (credits PATCH with `frozen_credit_removals` copy, confirm, dismiss, per-action `busy`), `LeaderboardTab` (quarter text input + `QUARTER_RE`, `award()` with the `QUARTER_IN_PROGRESS` → `window.confirm` → `force:true` retry), `AwardDialog`. Every one of those behaviors survives the move (§7 of the spec enumerates them).

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string. Commas, colons, parentheses only.
- **Frontend API calls** go through `client/src/utils/api.js`; never raw fetch/axios. `api.js` rejects a FLATTENED error envelope: read `err.status`, `err.code`, `err.message` (there is no `err.response`).
- **CSS:** vanilla CSS appended to `client/src/index.css`, every new rule prefixed `html[data-app="admin-os"]`. The hub rules are the artifact's `<style>` rules with that prefix. No new CSS files.
- **Server:** raw parameterized SQL; throw `AppError` subclasses; `asyncHandler` on every route; JSON keys snake_case. The summary endpoint and every other read in this plan NEVER write; in particular never INSERT a `pay_periods` row.
- **Money:** integer cents everywhere; the client renders `fmt$fromCents`. The bounty figure comes from the server envelope (`bounty_cents`), never a literal.
- **Explicit staging only:** `git add <specific paths>`, never `-A`/`.`. Inside a lane, checkpoint commits are free; the squash merge is the unit.
- **Client gate before any client commit:** `cd client && CI=true npx react-scripts build` (CI-fatal warnings fail it).
- **Server tests share the dev DB:** run ONE file at a time from the repo root, `node -r dotenv/config --test <file>`. Fixtures use a unique email prefix and are deleted in `after`.
- **File size:** new files aim under 300 lines; `StaffDashboard.js` (203) and `HiringDashboard.js` (442) may grow modestly; anything heading past 600 splits.
- **Design fidelity:** the build benchmark is `docs/design-artifacts/2026-08-19-staff-hub.dc.html`; the spec's §3 override list is the only permitted deviation set. `ui-ux-review` is pointed at the artifact.
- **Sensitive paths:** `server/routes/admin/payroll.js` is listed today; sh-a adds `server/utils/dutyLines.js` and `server/routes/admin/contractorTipPage.js`. The sh-a lane runs the full fleet regardless.

---

# Lane sh-a-server

### Task A1: `summarizeOpenPeriod` (pure) in `server/utils/staffHubSummary.js`

**Files:**
- Create: `server/utils/staffHubSummary.js`
- Test: `server/utils/staffHubSummary.test.js`

**Interfaces:**
- Consumes: `payPeriodForDate`, `computePayday` from `server/utils/payrollPeriods.js`.
- Produces: `summarizeOpenPeriod({ todayYmd, row }) -> { start_date, end_date, payday, exists, status, payouts_accrued }`. `row` is the `pay_periods` row for the derived `start_date` joined with a payout count, or `null`. Used by Task A2.

- [ ] **Step 1: Write the failing tests**

```js
// server/utils/staffHubSummary.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeOpenPeriod } = require('./staffHubSummary');

test('a Wednesday with no row derives the Tue..Mon window and exists:false', () => {
  // 2026-08-19 is a Wednesday; the period is Tue 08-18 .. Mon 08-24, payday Tue 08-25.
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-19', row: null });
  assert.deepEqual(out, {
    start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25',
    exists: false, status: null, payouts_accrued: 0,
  });
});

test('a Tuesday is the first day of its own period, not the last of the prior one', () => {
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-18', row: null });
  assert.equal(out.start_date, '2026-08-18');
  assert.equal(out.end_date, '2026-08-24');
});

test('a Monday is the last day of the period that began the prior Tuesday', () => {
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-24', row: null });
  assert.equal(out.start_date, '2026-08-18');
});

test('an existing row fills exists, status and the accrued count', () => {
  const out = summarizeOpenPeriod({
    todayYmd: '2026-08-19',
    row: { status: 'open', payouts_accrued: '3' },
  });
  assert.equal(out.exists, true);
  assert.equal(out.status, 'open');
  assert.equal(out.payouts_accrued, 3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/staffHubSummary.test.js`
Expected: FAIL, `Cannot find module './staffHubSummary'`.

- [ ] **Step 3: Implement**

```js
// server/utils/staffHubSummary.js
// The Staff hub's "open pay run" line is DERIVED from the date, never read
// from a pay_periods row: rows are created lazily by ensurePayPeriod when the
// first shift of the week accrues (usually Saturday), so on a Wednesday the
// row does not exist yet and a row-based subtitle would go blank or fall back
// to last week. This helper is pure; the caller does the one LEFT JOIN.
const { payPeriodForDate, computePayday } = require('./payrollPeriods');

function summarizeOpenPeriod({ todayYmd, row }) {
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  const payday = computePayday(endDate);
  return {
    start_date: startDate,
    end_date: endDate,
    payday,
    exists: !!row,
    status: row ? row.status : null,
    payouts_accrued: row ? Number(row.payouts_accrued || 0) : 0,
  };
}

module.exports = { summarizeOpenPeriod };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/utils/staffHubSummary.test.js`
Expected: 4 passing. If `payday` comes back as something other than `2026-08-25`, read `computePayday` before touching the helper: it observes federal holidays, and the test date must not sit on one.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staffHubSummary.js server/utils/staffHubSummary.test.js
git commit -m "feat(staff-hub): pure open-period summary derived from the date"
```

### Task A2: `GET /api/admin/staff-hub/summary`

**Files:**
- Create: `server/routes/admin/staffHub.js`
- Modify: `server/routes/admin/index.js` (add one `router.use` line after the `staffReviews` line)
- Test: `server/routes/admin/staffHub.test.js`

**Interfaces:**
- Consumes: `summarizeOpenPeriod` (Task A1); `chicagoTodayYmd` from `server/utils/businessTime.js`; `auth`, `requireAdminOrManager` from `server/middleware/auth.js`.
- Produces, for the client (sh-b `StaffHubLayout`):
  ```
  { active_count, deactivated_count, former_staff_count, imported_count,
    new_applications, pending_reviews,
    open_period: { start_date, end_date, payday, exists, status, payouts_accrued } | null }
  ```
  Managers: `new_applications`, `pending_reviews`, `open_period` are `null`. A manager without `can_staff`: the four counts are `null` too.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/admin/staffHub.test.js
require('dotenv').config();
// Harness mirrors settings.badgeCounts.test.js: real router + real auth middleware
// on a minimal express app, driven over node:http.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const staffHubRouter = require('./staffHub');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PREFIX = 'staff-hub-test-';
let server, baseUrl, adminToken, managerToken, weakManagerToken, staffToken;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(role, { status = 'approved', canStaff = false } = {}) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, can_staff)
     VALUES ($1, $2, $3, $4, 0, $5) RETURNING id, token_version`,
    [`${PREFIX}${role}-${canStaff ? 'cs' : 'nocs'}-${NONCE}@example.com`, hash, role, status, canStaff]
  );
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager', { canStaff: true }));
  weakManagerToken = tokenFor(await makeUser('manager', { canStaff: false }));
  staffToken = tokenFor(await makeUser('staff'));
  const app = express();
  app.use(express.json());
  app.use('/api/admin', staffHubRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  await pool.end();
});

test('anon 401, staff 403', async () => {
  assert.equal((await get('/api/admin/staff-hub/summary')).status, 401);
  assert.equal((await get('/api/admin/staff-hub/summary', staffToken)).status, 403);
});

test('admin gets the full shape with integer counts and a derived open_period', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', adminToken);
  assert.equal(status, 200);
  for (const k of ['active_count', 'deactivated_count', 'former_staff_count', 'imported_count', 'new_applications', 'pending_reviews']) {
    assert.equal(typeof body[k], 'number', `${k} is a number`);
  }
  assert.equal(body.former_staff_count + body.imported_count, body.deactivated_count, 'deactivated splits exactly into former + imported');
  assert.match(body.open_period.start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.open_period.payday, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof body.open_period.exists, 'boolean');
});

test('the read never creates a pay_periods row', async () => {
  const before_ = (await pool.query('SELECT COUNT(*)::int AS n FROM pay_periods')).rows[0].n;
  await get('/api/admin/staff-hub/summary', adminToken);
  const after_ = (await pool.query('SELECT COUNT(*)::int AS n FROM pay_periods')).rows[0].n;
  assert.equal(after_, before_);
});

test('a manager with can_staff gets counts but null admin-only fields', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', managerToken);
  assert.equal(status, 200);
  assert.equal(typeof body.active_count, 'number');
  assert.equal(body.new_applications, null);
  assert.equal(body.pending_reviews, null);
  assert.equal(body.open_period, null);
});

test('a manager without can_staff gets every field null', async () => {
  const { status, body } = await get('/api/admin/staff-hub/summary', weakManagerToken);
  assert.equal(status, 200);
  for (const k of ['active_count', 'deactivated_count', 'former_staff_count', 'imported_count', 'new_applications', 'pending_reviews', 'open_period']) {
    assert.equal(body[k], null, `${k} is null`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/admin/staffHub.test.js`
Expected: FAIL, `Cannot find module './staffHub'`.

- [ ] **Step 3: Implement the route**

```js
// server/routes/admin/staffHub.js
// GET /api/admin/staff-hub/summary: the ONE read behind the Staff hub's chrome
// (tab counts, badges, live subtitle). Read-only by construction: the open pay
// run is derived from the Chicago date and LEFT JOINed to pay_periods on its
// UNIQUE start_date; this route must never adopt the INSERT-fallback pattern
// payrollLateTip.js / payrollClawback.js wrap around findOpenPeriodForDate.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { payPeriodForDate } = require('../../utils/payrollPeriods');
const { summarizeOpenPeriod } = require('../../utils/staffHubSummary');

const router = express.Router();

router.get('/staff-hub/summary', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  // Same gate as GET /admin/active-staff: a manager without can_staff cannot
  // read the roster, so the hub must not hand them a headcount for it either.
  const canSeeRoster = isAdmin || (req.user.role === 'manager' && !!req.user.can_staff);

  let counts = { active_count: null, deactivated_count: null, former_staff_count: null, imported_count: null };
  if (canSeeRoster) {
    // One predicate family, shared with the roster feed: the active set is the
    // roster's Active tab (approved + onboarding completed); the deactivated
    // set is status alone (imported placeholders have no progress row).
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE u.onboarding_status = 'approved' AND op.onboarding_completed = true)::int AS active_count,
        COUNT(*) FILTER (WHERE u.onboarding_status = 'deactivated')::int AS deactivated_count,
        COUNT(*) FILTER (WHERE u.onboarding_status = 'deactivated'
                           AND (u.cc_id LIKE 'legacy_cc:%' OR u.import_source = 'payment_history_import'))::int AS imported_count
      FROM users u
      LEFT JOIN onboarding_progress op ON op.user_id = u.id
      WHERE u.role IN ('staff', 'manager')
    `);
    const r = rows[0];
    counts = {
      active_count: r.active_count,
      deactivated_count: r.deactivated_count,
      imported_count: r.imported_count,
      former_staff_count: r.deactivated_count - r.imported_count,
    };
  }

  let adminFields = { new_applications: null, pending_reviews: null, open_period: null };
  if (isAdmin) {
    const todayYmd = chicagoTodayYmd();
    const { startDate } = payPeriodForDate(todayYmd);
    const [decisions, period] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM applications a JOIN users u ON u.id = a.user_id
            WHERE u.onboarding_status = 'applied')::int AS new_applications,
          (SELECT COUNT(*) FROM staff_reviews WHERE status = 'pending')::int AS pending_reviews
      `),
      pool.query(`
        SELECT pp.status, COUNT(p.id)::int AS payouts_accrued
          FROM pay_periods pp
          LEFT JOIN payouts p ON p.pay_period_id = pp.id
         WHERE pp.start_date = $1
         GROUP BY pp.id, pp.status
      `, [startDate]),
    ]);
    adminFields = {
      new_applications: decisions.rows[0].new_applications,
      pending_reviews: decisions.rows[0].pending_reviews,
      open_period: summarizeOpenPeriod({ todayYmd, row: period.rows[0] || null }),
    };
  }

  res.json({ ...counts, ...adminFields });
}));

module.exports = router;
```

Then in `server/routes/admin/index.js`, directly after `router.use('/', require('./staffReviews'));` add:

```js
router.use('/', require('./staffHub'));
```

Before running, confirm the payouts FK name: `grep -n "pay_period_id" server/db/schema.sql | head -3`. If the column is named differently, use that name in the LEFT JOIN; do not guess.

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/admin/staffHub.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/staffHub.js server/routes/admin/staffHub.test.js server/routes/admin/index.js
git commit -m "feat(staff-hub): summary endpoint, read-only, pay run derived from the date"
```

### Task A3: `badge-counts` gains `pending_reviews`

**Files:**
- Modify: `server/routes/admin/settings.js:128-175`
- Test: `server/routes/admin/settings.badgeCounts.test.js`

**Interfaces:**
- Produces: `pending_reviews` integer on the badge-counts payload, 0 for managers. Consumed by sh-b `nav.js` (`badgeKeys`).

- [ ] **Step 1: Write the failing test**

Append to `server/routes/admin/settings.badgeCounts.test.js`, after the existing `COUNT_KEYS` tests:

```js
test('pending_reviews rides the payload and is zeroed for managers', async () => {
  const admin = await get('/api/admin/badge-counts', adminToken);
  assert.equal(admin.status, 200);
  assert.equal(typeof admin.body.pending_reviews, 'number');
  const mgr = await get('/api/admin/badge-counts', managerToken);
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.pending_reviews, 0);
});
```

Also add `'pending_reviews'` to the `COUNT_KEYS` array so the existing shape assertions cover it.

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/admin/settings.badgeCounts.test.js`
Expected: the new test fails on `typeof undefined !== 'number'`.

- [ ] **Step 3: Implement**

In the SELECT in `settings.js`, after the `unread_sms` subselect (the last one, `:162`), add a comma and:

```sql
      (SELECT COUNT(*) FROM staff_reviews WHERE status = 'pending')::int AS pending_reviews
```

And directly under the existing manager zeroing (`if (req.user.role !== 'admin') counts.new_applications = 0;`) add:

```js
  // Reviews is admin-only too; a manager must not see a decision they cannot open.
  if (req.user.role !== 'admin') counts.pending_reviews = 0;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/admin/settings.badgeCounts.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/settings.js server/routes/admin/settings.badgeCounts.test.js
git commit -m "feat(badge-counts): pending_reviews, zeroed for managers"
```

### Task A4: roster feed LEFT JOIN for deactivated rows

**Files:**
- Modify: `server/routes/admin/users.js:481-508`
- Test: `server/routes/admin/users.activeStaff.test.js`

**Interfaces:**
- Produces: `GET /admin/active-staff?include_stubs=true` now returns EVERY deactivated staff/manager row regardless of onboarding progress: no progress row at all (the payment-history placeholders) or an incomplete one. This is deliberately the same predicate as the summary's `deactivated_count` (A2), so the count and the list agree. The active set is byte-identical. Consumed by sh-b Roster.

- [ ] **Step 1: Write the failing test**

In `users.activeStaff.test.js`, the `before` block seeds users each with a completed `onboarding_progress` row. Add one more fixture there: a deactivated payment-history placeholder with NO progress row.

HARNESS REALITY (read the file first; do not paste blind): its helper is `req(...)` returning a RAW STRING body that every test `JSON.parse`s; there is no `passwordHash` variable (inserts use the literal `'x'`); and `after()` deletes users by an EXPLICIT ID ARRAY, not an email LIKE. A fixture not added to that array leaks into the shared dev DB forever and permanently inflates the summary's deactivated/imported counts. Two fixtures:

```js
// after the existing fixtures in before(), matching the file's own insert style:
const ph = await pool.query(
  `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, import_source)
   VALUES ($1, 'x', 'staff', 'deactivated', 0, 'payment_history_import') RETURNING id`,
  [`${PREFIX}placeholder-${Date.now()}@imported.invalid`]
);
placeholderId = ph.rows[0].id;   // declare `let placeholderId;` beside the other ids
const inc = await pool.query(
  `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
   VALUES ($1, 'x', 'staff', 'deactivated', 0) RETURNING id`,
  [`${PREFIX}incomplete-${Date.now()}@example.com`]
);
incompleteId = inc.rows[0].id;   // has a progress row, but incomplete:
await pool.query('INSERT INTO onboarding_progress (user_id) VALUES ($1)', [incompleteId]);
// ADD placeholderId AND incompleteId to the after() cleanup id array.
```

And the tests (parse the raw body like the file's existing tests do):

```js
test('include_stubs surfaces deactivated rows with no progress row AND with an incomplete one', async () => {
  const r = await req('GET', '/api/admin/active-staff?include_stubs=true&limit=100', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.staff.some(s => s.id === placeholderId), 'no-progress placeholder present');
  assert.ok(body.staff.some(s => s.id === incompleteId), 'incomplete-progress deactivated row present');
});

test('the default (active) set still requires a completed onboarding row', async () => {
  const r = await req('GET', '/api/admin/active-staff?limit=100', adminToken);
  const body = JSON.parse(r.body);
  assert.ok(!body.staff.some(s => s.id === placeholderId), 'placeholder absent from the active set');
  assert.ok(!body.staff.some(s => s.id === incompleteId), 'incomplete row absent from the active set');
});
```

Adapt the exact helper signature to the file's own (`req(method, path, token)` or similar).

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js`
Expected: the first new test fails (placeholder absent).

- [ ] **Step 3: Implement**

In both queries of the route (the SELECT and the COUNT), change

```sql
      JOIN onboarding_progress op ON op.user_id = u.id
      ...
        AND op.onboarding_completed = true
```

to

```sql
      LEFT JOIN onboarding_progress op ON op.user_id = u.id
      ...
        AND (u.onboarding_status = 'deactivated' OR op.onboarding_completed = true)
```

Update the comment above `statusList` to say why: deactivated imported placeholders were deliberately left without a progress row, and the Roster's Deactivated view must be able to show them.

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js`
Expected: all passing, including every pre-existing test (the active set is unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/users.js server/routes/admin/users.activeStaff.test.js
git commit -m "fix(active-staff): deactivated rows no longer require an onboarding_progress row"
```

### Task A5: tips projection columns + tip-feedback `target_user_id`

**Files:**
- Modify: `server/routes/admin/contractorTipPage.js:263-326`
- Create: `server/routes/admin/contractorTipPage.test.js`

**Interfaces:**
- Produces: `GET /admin/tips` rows also carry `shift_id, deferred_at, rolled_forward_at, refunded_amount_cents, dispute_won_at` (consumed by sh-d `tipStatus.js`). `GET /admin/tip-feedback?target_user_id=<int>` filters to one bartender (consumed by sh-f `FeedbackCard`); a non-integer value is a 400.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/admin/contractorTipPage.test.js
require('dotenv').config();
// Harness mirrors settings.badgeCounts.test.js. Covers the two read extensions
// the Staff hub added: the tips Status projection and the per-bartender
// feedback filter. Both routes are adminOnly; that is asserted too.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const router = require('./contractorTipPage');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PREFIX = 'ctp-test-';
let server, baseUrl, adminToken, managerToken, bartenderId, otherId;

function get(path, token) { /* identical to staffHub.test.js get() */ 
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject); req.end();
  });
}
async function makeUser(role, tag) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1,$2,$3,'approved',0) RETURNING id, token_version`,
    [`${PREFIX}${tag}-${NONCE}@example.com`, hash, role]);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  adminToken = tokenFor(await makeUser('admin', 'admin'));
  managerToken = tokenFor(await makeUser('manager', 'manager'));
  const b = await makeUser('staff', 'bartender'); bartenderId = b.id;
  const o = await makeUser('staff', 'other'); otherId = o.id;
  await pool.query(
    -- tip_page_feedback.rating is CHECK (rating BETWEEN 1 AND 3) in prod schema.sql:2659;
    -- the dev DB may lack the CHECK, so seed inside 1..3 anyway or prod and dev diverge.
    `INSERT INTO tip_page_feedback (target_user_id, rating, comment, submitter_email) VALUES ($1, 3, $2, 'guest@example.com'), ($3, 1, $4, 'guest2@example.com')`,
    [bartenderId, `feedback for bartender ${NONCE}`, otherId, `feedback for other ${NONCE}`]);
  const app = express(); app.use(express.json()); app.use('/api/admin', router);
  app.use((err, req, res, next) => { if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' }); });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query(`DELETE FROM tip_page_feedback WHERE target_user_id IN (SELECT id FROM users WHERE email LIKE '${PREFIX}%')`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
  await pool.end();
});

test('tips and tip-feedback are adminOnly', async () => {
  assert.equal((await get('/api/admin/tips', managerToken)).status, 403);
  assert.equal((await get('/api/admin/tip-feedback', managerToken)).status, 403);
});

test('tips rows carry the Status projection columns', async () => {
  const { status, body } = await get('/api/admin/tips?limit=1', adminToken);
  assert.equal(status, 200);
  if (body.tips.length) {
    for (const k of ['shift_id', 'deferred_at', 'rolled_forward_at', 'refunded_amount_cents', 'dispute_won_at']) {
      assert.ok(k in body.tips[0], `${k} projected`);
    }
  }
});

test('tip-feedback filters by target_user_id and rejects garbage', async () => {
  const mine = await get(`/api/admin/tip-feedback?status=all&target_user_id=${bartenderId}`, adminToken);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.feedback.length >= 1);
  assert.ok(mine.body.feedback.every(f => f.target_user_id === bartenderId));
  const bad = await get('/api/admin/tip-feedback?target_user_id=abc', adminToken);
  assert.equal(bad.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/admin/contractorTipPage.test.js`
Expected: the projection test fails only if a tip exists; the filter test fails (`every` false, and `abc` returns 200 not 400).

- [ ] **Step 3: Implement**

In the `/tips` SELECT, replace the projection line with:

```sql
    SELECT t.id, t.amount_cents, t.tipped_at, t.customer_email,
           t.shift_id, t.deferred_at, t.rolled_forward_at,
           COALESCE(t.refunded_amount_cents, 0) AS refunded_amount_cents, t.dispute_won_at,
           COALESCE(cp.display_name, cp.preferred_name) AS bartender_name, t.target_user_id
```

In `/tip-feedback`, replace the `where` block with parameterized filters:

```js
  const filters = [];
  const params = [];
  if (status === 'unreviewed') filters.push('f.reviewed_at IS NULL');
  if (status === 'reviewed') filters.push('f.reviewed_at IS NOT NULL');
  if (req.query.target_user_id !== undefined) {
    const uid = Number(req.query.target_user_id);
    // ValidationError's FIRST param is fieldErrors; the message goes second
    // (the staffReviewsContest.js:149 form), else the client sees the generic copy.
    if (!Number.isInteger(uid) || uid <= 0) throw new ValidationError(null, 'target_user_id must be a positive integer');
    filters.push(`f.target_user_id = $${params.length + 1}`);
    params.push(uid);
  }
  const where = filters.length ? filters.join(' AND ') : '1=1';
```

and pass `params` to `pool.query(..., params)`. `ValidationError` is already imported in this file (the `/tip-feedback/:id/review` route uses it); confirm with `grep -n "ValidationError" server/routes/admin/contractorTipPage.js | head -2`.

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/admin/contractorTipPage.test.js`
Expected: 3 passing. Then the existing neighbor: `node -r dotenv/config --test server/routes/admin/users.tipsGate.test.js` still passes.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/contractorTipPage.js server/routes/admin/contractorTipPage.test.js
git commit -m "feat(tips): Status projection columns; tip-feedback filters by target_user_id"
```

### Task A6: staff-reviews envelope: `bounty_cents`, `bounties_paid_cents`, `total_logged`

**Files:**
- Modify: `server/routes/admin/staffReviews.js:135-152`
- Test: `server/routes/admin/staffReviews.test.js` (append one test; read its harness first, it already has admin auth helpers)

**Interfaces:**
- Produces: `GET /admin/staff-reviews` → `{ reviews, bounty_cents, bounties_paid_cents, total_logged }`. Consumed by sh-e and sh-d (the pay-run pointer).

- [ ] **Step 1: Write the failing test**

Append to `server/routes/admin/staffReviews.test.js`. HARNESS REALITY: its helper is `req(method, path, token, body)` returning parsed JSON, and there is no `get()`; read the file's existing tests and match them. Shape:

```js
test('the list envelope carries the bounty figure and all-time totals', async () => {
  const r = await req('GET', '/api/admin/staff-reviews', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.bounty_cents, 1000);
  assert.equal(typeof r.body.bounties_paid_cents, 'number');
  assert.equal(typeof r.body.total_logged, 'number');
  assert.ok(r.body.total_logged >= r.body.reviews.length);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/admin/staffReviews.test.js`
Expected: the new test fails on `bounty_cents` undefined.

- [ ] **Step 3: Implement**

Change the import on `:20` to also pull the constant:

```js
const { materializeReviewLine, materializePendingReviewLines, REVIEW_BOUNTY_CENTS } = require('../../utils/dutyLines');
```

Replace the route body's `res.json({ reviews: rows });` with:

```js
  const totals = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM staff_reviews)::int AS total_logged,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payout_duty_lines WHERE kind = 'review_bounty')::int AS bounties_paid_cents
  `);
  res.json({
    reviews: rows,
    bounty_cents: REVIEW_BOUNTY_CENTS,
    bounties_paid_cents: totals.rows[0].bounties_paid_cents,
    total_logged: totals.rows[0].total_logged,
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/admin/staffReviews.test.js`
Expected: all passing (the file is long; every pre-existing test still green).

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin/staffReviews.js server/routes/admin/staffReviews.test.js
git commit -m "feat(staff-reviews): envelope carries bounty_cents and all-time totals"
```

### Task A7: dispute email link, sensitive-paths, docs

Note on lane independence: this task points two server-sent emails at `/staffing/...` routes that only exist after sh-b's B4 merges. That is fine: push to prod is a separate gated step after ALL lanes merge, and even a stray click before then lands on the SPA's catch-all. Stated so nobody "fixes" it into a dependency.

**Files:**
- Modify: `server/utils/payrollDisputeNotify.js:126`, `server/utils/payrollDisputeNotify.test.js:421`
- Modify: `scripts/sensitive-paths.txt`
- Modify: `ARCHITECTURE.md` (API route table)

- [ ] **Step 1: Update the test first**

At `payrollDisputeNotify.test.js:421` change the regex to the new path:

```js
      assert.match(blob, /https:\/\/admin\.drbartender\.com\/staffing\/payroll/, 'absolute admin URL, not a relative path');
```

and update the comment two lines above it (`:401-402`) to name `/staffing/payroll`.

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/payrollDisputeNotify.test.js`
Expected: that assertion fails.

- [ ] **Step 3: Implement**

`payrollDisputeNotify.js:126`: `payrollUrl: \`${ADMIN_URL}/staffing/payroll\`,`

Append to `scripts/sensitive-paths.txt` (after the `server/routes/admin/payrollDuty.js` line):

```
# The review-bounty and contest money writer (2026-08-19, staff-hub spec
# review). Comments above say dutyLines.js "is covered" by the payroll glob;
# it is not (utils globs do not match dutyLines). It writes payout_duty_lines
# and recomputes payout totals. Listed by name.
server/utils/dutyLines.js
# Tip money reads (the cross-staff ledger) and the contractor tip-page
# mutations (token rotation, Stripe link regeneration). Same 2026-08-19 finding.
server/routes/admin/contractorTipPage.js
```

Verify: `node scripts/sensitive-match.js server/utils/dutyLines.js server/routes/admin/contractorTipPage.js` prints both paths.

`README.md`: add `server/routes/admin/staffHub.js` and `server/utils/staffHubSummary.js` to the folder tree (one line each), per CLAUDE.md's mandatory-docs table.

`ARCHITECTURE.md`: in the admin API route table add a row for `GET /api/admin/staff-hub/summary` (`staffHub.js`, auth + requireAdminOrManager, read-only hub chrome: counts, decisions, derived open pay run); note on the `/admin/tips` row the five new projection columns; on `/admin/tip-feedback` the `target_user_id` param; on `/admin/staff-reviews` the envelope fields; on `/admin/active-staff` the LEFT JOIN rule for deactivated rows. Also add `server/utils/staffHubSummary.js` to the utils list.

- [ ] **Step 4: Run to verify**

Run: `node -r dotenv/config --test server/utils/payrollDisputeNotify.test.js`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollDisputeNotify.js server/utils/payrollDisputeNotify.test.js scripts/sensitive-paths.txt ARCHITECTURE.md README.md
git commit -m "chore(staff-hub): dispute email points at /staffing/payroll; dutyLines + contractorTipPage join sensitive paths; ARCHITECTURE"
```

### Task A8: the feedback notification email points at the staffer profile (SHIPPED, THEN REVERTED, NOW OWNED BY sh-f)

> **Status 2026-08-19:** A8 shipped with the sh-a-server merge (`c4bb2d1f`) and was reverted on main by commit `b114e9f0`, which put `adminUrl: ${ADMIN_URL}/tips#feedback` back and re-aimed `publicTip.test.js` to PIN the old url and to assert the profile url is ABSENT. The revert was correct: the profile's Tip Page tab renders no feedback until sh-f builds `FeedbackCard`, so the alert email was landing an operator paged by a one-star complaint on token and Stripe settings. sh-a is merged and closed, so this task no longer has an owner here. It is now **sh-f-feedback Task F1 Step 4**, and it lands in the same commit as `FeedbackCard.js`, never ahead of it. The body below is kept as the record of what was tried and why it came back; do not execute it from this lane.

**Files:**
- Modify: `server/routes/publicTip.js:227`
- Test: `server/routes/publicTip.test.js` (extend the existing feedback-submission test)

The tip-page feedback email currently links `${ADMIN_URL}/tips#feedback`. `/tips` is retired (B4 redirects it to the Payroll tips ledger) and the `#feedback` view is deleted with `TipsAdmin.js` (F1), so the live notification would land the operator on a tips table instead of the feedback that triggered it. Spec §9 moves feedback to the staffer profile; the email follows.

- [ ] **Step 1: Update the test first**

VERIFIED 2026-08-19: `publicTip.test.js` (356 lines) covers the tip GET/checkout paths only; it has NO feedback-route test and never touches `sendEmail`, and the route calls the real `sendEmail` (which log-and-skips outside prod via the SEND_NOTIFICATIONS gate). So there is nothing to update; the honest test here is on the TEMPLATE, not the route: assert `emailTemplates.tipFeedbackAdminNotification({ ..., adminUrl }).html` contains the adminUrl it was given (it already takes the URL as an argument, so the route-side change is the only behavior). Add to the test file, matching its harness style:

```js
test('feedback admin email links the adminUrl it is given', () => {
  const tpl = require('../utils/emailTemplates').tipFeedbackAdminNotification({
    displayName: 'Shea Corrigan', rating: 3, comment: 'great', submitterEmail: 'g@example.com',
    adminUrl: 'https://admin.example.test/staffing/users/12?tab=tip-page',
  });
  assert.ok(tpl.html.includes('https://admin.example.test/staffing/users/12?tab=tip-page'));
});
```

plus a plain-code assertion that the route file no longer contains the retired path: after Step 3, `grep -n "tips#feedback" server/routes/publicTip.js` returns nothing (state this in the commit body rather than as a brittle source-grep test).

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/publicTip.test.js`
Expected: the URL assertion fails against the old `/tips#feedback`.

- [ ] **Step 3: Implement**

`publicTip.js:227`:

```js
      adminUrl: `${ADMIN_URL}/staffing/users/${row.user_id}?tab=tip-page`,
```

(`row.user_id` is the bartender the feedback targets; it is already in scope, the INSERT above uses it. `tip-page` is a real profile tab id, `AdminUserDetail.js:36-39`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/routes/publicTip.test.js`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add server/routes/publicTip.js server/routes/publicTip.test.js
git commit -m "fix(tip-feedback): notification email deep-links the staffer profile, not the retired /tips view"
```

**Lane sh-a done when:** all eight tasks committed; the full fleet has run on the lane (sensitive paths); every touched suite passes one at a time.

# Lane sh-b-shell

### Task B1: `nav.js`: Staff absorbs Hiring/Tips/Reviews; `navBadgeCount` helper

**Files:**
- Modify: `client/src/components/adminos/nav.js`
- Create: `client/src/components/adminos/nav.test.js`
- Modify: `client/src/components/adminos/Sidebar.js:69`
- Modify: `client/src/pages/mobile/MorePage.js:64`
- Modify: `client/src/components/mobile/MobileTabBar.js:14`
- Modify: `client/src/components/adminos/CommandPalette.js:148`

**Interfaces:**
- Produces: `navBadgeCount(item, badges) -> number` (named export from `nav.js`); the Staff item carries `badgeKeys: ['new_applications', 'pending_reviews']`.

- [ ] **Step 1: Write the failing test**

```js
// client/src/components/adminos/nav.test.js
import NAV, { navBadgeCount } from './nav';

const find = (id) => NAV.flatMap(s => s.items).find(i => i.id === id);

test('Staff is the one people entry; Hiring, Tips and Reviews are gone from the sidebar', () => {
  expect(find('staff')).toBeTruthy();
  expect(find('hiring')).toBeUndefined();
  expect(find('tips')).toBeUndefined();
  expect(find('reviews')).toBeUndefined();
});

test('navBadgeCount sums badgeKeys, falls back to badgeKey, and tolerates missing keys', () => {
  expect(navBadgeCount({ badgeKeys: ['a', 'b'] }, { a: 2, b: 3 })).toBe(5);
  expect(navBadgeCount({ badgeKeys: ['a', 'b'] }, { a: 2 })).toBe(2);
  expect(navBadgeCount({ badgeKey: 'a' }, { a: 4 })).toBe(4);
  expect(navBadgeCount({ label: 'x' }, { a: 4 })).toBe(0);
  expect(navBadgeCount({ badgeKey: 'a' }, undefined)).toBe(0);
});

test('the Staff entry sums new applications and pending reviews', () => {
  expect(navBadgeCount(find('staff'), { new_applications: 1, pending_reviews: 1 })).toBe(2);
});
```

And a Sidebar render test (spec §11) in the same file or a sibling `Sidebar.test.js`, mocking the contexts the component needs (read `Sidebar.js` imports: `useAuth`, `useUserPrefs`, router):

```js
test('Sidebar renders no Hiring/Tips/Reviews items and badges Staff with the summed count', () => {
  // mock useAuth -> { user: { role: 'admin' } }, useUserPrefs -> { prefs: {}, setPref: jest.fn() }
  // render <Sidebar badges={{ new_applications: 1, pending_reviews: 1 }} /> in a MemoryRouter
  // expect: no 'Hiring' / 'Tips & Feedback' / 'Reviews' nav items; the Staff item shows '2'
});
```

(Write the real mocks; the comment block is the shape, not the deliverable.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/nav.test.js`
Expected: FAIL (`navBadgeCount` is not a function; `hiring` found).

- [ ] **Step 3: Implement**

Replace `client/src/components/adminos/nav.js` with:

```js
// Nav groups for the Admin OS sidebar.
// `badgeKey` / `badgeKeys` map to the /api/admin/badge-counts response shape;
// read them ONLY through navBadgeCount so every consumer (Sidebar, the phone
// More list, the phone tab bar) sums the same way.
// `adminOnly` hides the item from managers. Set it whenever the destination's
// API is the server's adminOnly (which rejects managers), so the sidebar never
// offers a manager a link that bounces them straight back out.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Overview',  icon: 'home',      path: '/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/clients' },
    { id: 'messages',    label: 'Messages',  icon: 'chat',      path: '/messages',  badgeKey: 'unread_sms' },
    // The Staff hub: Roster lands; Hiring, Payroll and Reviews are its tabs.
    // The badge is the sum of decisions waiting across the admin-only children
    // (both keys are zeroed server-side for managers).
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/staffing',  badgeKeys: ['new_applications', 'pending_reviews'] },
  ]},
  { section: 'Revenue', items: [
    { id: 'marketing',   label: 'Marketing',       icon: 'mail',     path: '/marketing', adminOnly: true },
    // The legacy email surface. Still the only way into Leads, which the
    // marketing phase 2 extraction reads, so it keeps its own entry rather
    // than being swallowed by the redesign above.
    { id: 'emailleads',  label: 'Email leads',     icon: 'mail',     path: '/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'potions',     label: 'Potions',       icon: 'flask',     path: '/potions', badgeKey: 'pending_shopping_lists' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',       path: '/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',      path: '/settings' },
  ]},
];

/** One badge number per nav item. Sums `badgeKeys`, else reads `badgeKey`. */
export function navBadgeCount(item, badges) {
  const b = badges || {};
  if (Array.isArray(item?.badgeKeys)) return item.badgeKeys.reduce((n, k) => n + (Number(b[k]) || 0), 0);
  if (item?.badgeKey) return Number(b[item.badgeKey]) || 0;
  return 0;
}

export default NAV;
```

Then the three consumers:

`Sidebar.js:69`: `const count = item.badgeKey ? badges[item.badgeKey] || 0 : 0;` → `const count = navBadgeCount(item, badges);` and change the import on `:6` to `import NAV, { navBadgeCount } from './nav';`.

`MorePage.js:64`: same substitution, and import `navBadgeCount` beside `NAV` there.

`MobileTabBar.js`: the spec's rule is that all three nav consumers read through `navBadgeCount`, so the literal `MORE_KEYS` array is retired rather than extended. Replace it with a derivation from NAV (the More tab aggregates every non-tab nav item's badge):

```js
import NAV, { navBadgeCount } from '../adminos/nav';
// ...
const MORE_ITEMS = NAV.flatMap(s => s.items).filter(i => !TAB_IDS.has(i.id));
```

and in the count expression: `const count = t.neutral ? MORE_ITEMS.reduce((a, i) => a + navBadgeCount(i, badges), 0) : badges[t.badgeKey] || 0;` where `TAB_IDS = new Set(['events', 'proposals'])` (declare it above TABS if the file does not already have one). `MobileTabBar.test.js` passes badges summing to 4 today; with Staff's `badgeKeys` the same fixture still sums 4 unless it carries `pending_reviews`, so update the fixture and expected sum deliberately, not incidentally.

`CommandPalette.js:148`: delete the `{ label: 'Hiring', icon: 'pen', onClick: go('/hiring') },` line. The `Staff` entry above it already reaches the hub; Hiring is a tab inside it and `CommandPalette.test.js` asserts nothing about Hiring (verified).

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/nav.test.js src/components/adminos/CommandPalette.test.js src/components/mobile/MobileTabBar.test.js`
Expected: passing (MobileTabBar's fixture updated per Step 3).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/adminos/nav.js client/src/components/adminos/nav.test.js client/src/components/adminos/Sidebar.js client/src/pages/mobile/MorePage.js client/src/components/mobile/MobileTabBar.js client/src/components/adminos/CommandPalette.js
git commit -m "feat(nav): Staff absorbs Hiring/Tips/Reviews; navBadgeCount sums badgeKeys for every consumer"
```

### Task B2: `AdminLayout` exposes `refreshBadges` through Outlet context

**Files:**
- Modify: `client/src/components/AdminLayout.js:110-130, 242, 261`

**Interfaces:**
- Produces: `useOutletContext()` inside any admin page returns `{ badges, refreshBadges }` on BOTH the phone and desktop branches. `MorePage` already reads `outlet.badges` and keeps working.

- [ ] **Step 1: Lift `fetchBadges` out of the effect**

Replace the `useEffect` at `:110-130` with a `useCallback` plus an effect that uses it:

```js
  const fetchBadges = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    const startedAt = Date.now();
    api.get('/admin/badge-counts').then(r => {
      const { presence: p, ...counts } = r.data || {};
      setBadges(counts);
      if (p && startedAt > lastPresenceMutationRef.current) setPresence(p);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    // Refresh immediately when the tab becomes visible again after being hidden,
    // so the admin doesn't see stale counts the moment they return.
    const onVisibility = () => { if (document.visibilityState === 'visible') fetchBadges(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchBadges]);

  const outletCtx = useMemo(() => ({ badges, refreshBadges: fetchBadges }), [badges, fetchBadges]);
```

`useCallback` and `useMemo` are already imported on `:1`.

- [ ] **Step 2: Pass the context on both Outlets**

`:242`: `<Outlet context={{ badges }} />` → `<Outlet context={outletCtx} />`.
`:261`: `<Outlet />` → `<Outlet context={outletCtx} />`.

- [ ] **Step 3: Verify**

Run: `cd client && CI=true npx react-scripts build` (no test covers the layout's poll; the build is the gate). Then in the dev app, load `/dashboard` and watch the Network tab: one badge-counts call on load, another each 60s. Unchanged behavior.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/AdminLayout.js
git commit -m "feat(admin-layout): refreshBadges on the Outlet context for both branches"
```

### Task B3: `hubSubtitle` (pure) + `StaffHubLayout` + hub CSS

**Files:**
- Create: `client/src/pages/admin/staffHub/hubSubtitle.js`
- Create: `client/src/pages/admin/staffHub/hubSubtitle.test.js`
- Create: `client/src/pages/admin/staffHub/StaffHubLayout.js`
- Create: `client/src/pages/admin/staffHub/StaffHubLayout.test.js`
- Modify: `client/src/index.css` (append the hub block)

**Interfaces:**
- Consumes: `GET /api/admin/staff-hub/summary` (Task A2 shape); `useOutletContext().refreshBadges` (Task B2); `useAuth().user.role`.
- Produces: Outlet context `{ summary, summaryError, refresh, setActions }` for children. `summary` is the A2 payload or `null` while loading; `refresh()` refetches the summary and calls `refreshBadges()`; `setActions(node|null)` registers header actions. `hubSubtitle(summary, { isAdmin }) -> string`.

- [ ] **Step 1: Write the failing subtitle tests**

```js
// client/src/pages/admin/staffHub/hubSubtitle.test.js
import { hubSubtitle, ymdLabel } from './hubSubtitle';

const S = {
  active_count: 16,
  pending_reviews: 1,
  open_period: { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 },
};

test('ymdLabel formats a YMD (or a pg ISO date) in UTC, no off-by-one', () => {
  expect(ymdLabel('2026-08-18')).toBe('Aug 18');
  expect(ymdLabel('2026-08-25T00:00:00.000Z', { weekday: true })).toBe('Tue Aug 25');
});

test('admin, quiet week: names the derived window, says open, counts the review', () => {
  expect(hubSubtitle(S, { isAdmin: true }))
    .toBe('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · 1 review to confirm');
});

test('cross-month window repeats the month; processing status replaces "open"; plural reviews', () => {
  const s = { ...S, pending_reviews: 2,
    open_period: { ...S.open_period, start_date: '2026-09-29', end_date: '2026-10-05', payday: '2026-10-06', exists: true, status: 'processing' } };
  expect(hubSubtitle(s, { isAdmin: true }))
    .toBe('16 active · pay run Sep 29 to Oct 5 processing, payday Tue Oct 6 · 2 reviews to confirm');
});

test('zero reviews says nothing to confirm; zero active says no active staff yet', () => {
  expect(hubSubtitle({ ...S, pending_reviews: 0 }, { isAdmin: true }))
    .toBe('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · nothing to confirm');
  expect(hubSubtitle({ ...S, active_count: 0, pending_reviews: 0 }, { isAdmin: true }))
    .toMatch(/^No active staff yet · /);
});

test('manager: the roster count only; null counts render nothing', () => {
  expect(hubSubtitle({ active_count: 16, pending_reviews: null, open_period: null }, { isAdmin: false })).toBe('16 active');
  expect(hubSubtitle({ active_count: null, pending_reviews: null, open_period: null }, { isAdmin: false })).toBe('');
  expect(hubSubtitle(null, { isAdmin: true })).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/staffHub/hubSubtitle.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `hubSubtitle.js`**

```js
// client/src/pages/admin/staffHub/hubSubtitle.js
// The hub's one live subtitle line. Pure: given the summary payload, return
// the string. pg DATE values arrive as ISO midnight-UTC strings, so every
// date is formatted in UTC to avoid the off-by-one a local-zone format would
// introduce for US evenings.

const ymd = (v) => String(v || '').slice(0, 10);
const asUtcDate = (v) => new Date(`${ymd(v)}T00:00:00Z`);

export function ymdLabel(v, { weekday = false } = {}) {
  const d = asUtcDate(v);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (weekday) opts.weekday = 'short';
  // en-US yields "Tue, Aug 25"; the design drops the comma.
  return d.toLocaleDateString('en-US', opts).replace(',', '');
}

export function windowLabel(start, end) {
  const s = asUtcDate(start);
  const e = asUtcDate(end);
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  return sameMonth ? `${ymdLabel(start)} to ${e.getUTCDate()}` : `${ymdLabel(start)} to ${ymdLabel(end)}`;
}

export function hubSubtitle(summary, { isAdmin }) {
  if (!summary) return '';
  const parts = [];
  if (summary.active_count !== null && summary.active_count !== undefined) {
    parts.push(summary.active_count === 0 ? 'No active staff yet' : `${summary.active_count} active`);
  }
  if (!isAdmin) return parts.join(' · ');

  const p = summary.open_period;
  if (p) {
    // "open" when there is no row yet or the row is open; otherwise the row's
    // own status, so the line never calls a mid-process week open.
    const word = !p.exists || p.status === 'open' ? 'open' : p.status;
    parts.push(`pay run ${windowLabel(p.start_date, p.end_date)} ${word}, payday ${ymdLabel(p.payday, { weekday: true })}`);
  }
  const n = summary.pending_reviews;
  if (n !== null && n !== undefined) {
    parts.push(n === 0 ? 'nothing to confirm' : `${n} ${n === 1 ? 'review' : 'reviews'} to confirm`);
  }
  return parts.join(' · ');
}
```

Run the subtitle test: passing.

- [ ] **Step 4: Write the failing layout test**

```js
// client/src/pages/admin/staffHub/StaffHubLayout.test.js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useOutletContext } from 'react-router-dom';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }));
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import StaffHubLayout from './StaffHubLayout';

const SUMMARY = {
  active_count: 16, deactivated_count: 14, former_staff_count: 5, imported_count: 9,
  new_applications: 1, pending_reviews: 1,
  open_period: { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 },
};

function Child() {
  const { summary, setActions } = useOutletContext();
  React.useEffect(() => { setActions(<button type="button">Child action</button>); return () => setActions(null); }, [setActions]);
  return <div data-testid="child">{summary ? `active=${summary.active_count}` : 'no summary'}</div>;
}

function mount(path, role = 'admin') {
  useAuth.mockReturnValue({ user: { role } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/staffing" element={<StaffHubLayout />}>
          <Route index element={<Child />} />
          <Route path="hiring" element={<Child />} />
          <Route path="payroll" element={<Child />} />
          <Route path="reviews" element={<Child />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { api.get.mockReset(); });

test('admin: four tabs, count on Roster, badges on Hiring and Reviews, live subtitle, child action in the header', async () => {
  api.get.mockResolvedValue({ data: SUMMARY });
  mount('/staffing');
  expect(screen.getByRole('link', { name: /Roster/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · 1 review to confirm')).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Roster/ })).toHaveTextContent('16');
  expect(screen.getByRole('link', { name: /Hiring/ })).toHaveTextContent('1');
  expect(screen.getByRole('link', { name: /Reviews/ })).toHaveTextContent('1');
  expect(screen.getByRole('link', { name: /Payroll/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Child action' })).toBeInTheDocument();
  expect(screen.getByTestId('child')).toHaveTextContent('active=16');
});

test('manager: no tab strip, roster-only subtitle', async () => {
  api.get.mockResolvedValue({ data: { ...SUMMARY, new_applications: null, pending_reviews: null, open_period: null } });
  mount('/staffing', 'manager');
  await waitFor(() => expect(screen.getByText('16 active')).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: /Hiring/ })).toBeNull();
  expect(screen.queryByRole('navigation', { name: /Staff sections/ })).toBeNull();
});

test('summary failure: tabs still render, a retry is offered, the child is unaffected', async () => {
  api.get.mockRejectedValue(new Error('boom'));
  mount('/staffing/hiring');
  await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Hiring/ })).toBeInTheDocument();
  expect(screen.getByTestId('child')).toHaveTextContent('no summary');
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/staffHub/StaffHubLayout.test.js`
Expected: FAIL, module not found.

- [ ] **Step 6: Implement `StaffHubLayout.js`**

```js
// client/src/pages/admin/staffHub/StaffHubLayout.js
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import { hubSubtitle } from './hubSubtitle';

/**
 * The Staff hub (spec 2026-08-19-admin-staff-hub-design.md §4). One sidebar
 * entry, four children, Roster lands. Follows MarketingLayout: the layout owns
 * ONE fetch (GET /admin/staff-hub/summary) and shares it through Outlet
 * context. Rendering is never gated on the fetch: children mount at once and
 * the chrome fills in when the data arrives.
 *
 * Two-vocabulary rule (§3): hub sections are header-fused underline tabs
 * (.hub-tabs, routes not state); views inside a child stay .seg pills in the
 * toolbar. Never two .segs stacked; never a third level.
 */
const TABS = [
  { id: 'roster',  label: 'Roster',  path: '/staffing',         end: true,  countKey: 'active_count' },
  { id: 'hiring',  label: 'Hiring',  path: '/staffing/hiring',  adminOnly: true, badgeKey: 'new_applications' },
  { id: 'payroll', label: 'Payroll', path: '/staffing/payroll', adminOnly: true },
  { id: 'reviews', label: 'Reviews', path: '/staffing/reviews', adminOnly: true, badgeKey: 'pending_reviews' },
];

export default function StaffHubLayout() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const shell = useOutletContext() || {};
  const refreshBadges = shell.refreshBadges;

  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [actions, setActions] = useState(null);

  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      const res = await api.get('/admin/staff-hub/summary');
      setSummary(res.data || null);
    } catch (err) {
      setSummaryError(err);
    }
  }, []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  /** Children call this after a mutation that moves a count or a badge. */
  const refresh = useCallback(() => {
    loadSummary();
    if (typeof refreshBadges === 'function') refreshBadges();
  }, [loadSummary, refreshBadges]);

  const ctx = useMemo(
    () => ({ summary, summaryError, refresh, setActions }),
    [summary, summaryError, refresh]
  );

  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);
  const subtitle = hubSubtitle(summary, { isAdmin });

  return (
    <div className="page">{/* data-app lives on <html>, set by AdminLayout; repeating it here is inert */}
      <div className="hub-head">
        <div className="page-header">
          <div>
            <div className="page-title">Staff</div>
            {subtitle && <div className="page-subtitle">{subtitle}</div>}
            {summaryError && (
              <div className="page-subtitle">
                <span className="muted">Counts unavailable.</span>{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={loadSummary}>Retry</button>
              </div>
            )}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {visibleTabs.length > 1 && (
          <nav className="hub-tabs" aria-label="Staff sections">
            {visibleTabs.map(t => {
              const count = t.countKey && summary ? summary[t.countKey] : null;
              const badge = t.badgeKey && summary ? summary[t.badgeKey] : null;
              return (
                <NavLink
                  key={t.id}
                  to={t.path}
                  end={!!t.end}
                  className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
                >
                  {t.label}
                  {count !== null && count !== undefined && <span className="hub-tab-count">{count}</span>}
                  {badge > 0 && <span className="hub-tab-badge">{badge}</span>}
                </NavLink>
              );
            })}
          </nav>
        )}
      </div>
      <Outlet context={ctx} />
    </div>
  );
}
```

- [ ] **Step 7: Append the hub CSS to `client/src/index.css`**

Append at the end of the file (these are the benchmark artifact's rules marked "ships verbatim", with the repo's `html` prefix):

```css
/* ==========================================================================
   Staff hub chrome (spec 2026-08-19-admin-staff-hub-design.md §3).
   Benchmark: docs/design-artifacts/2026-08-19-staff-hub.dc.html. Two
   vocabularies: .hub-tabs = header-fused underline sections (routes);
   .seg in the toolbar = views inside a child. One .hub-tabs per page.
   ========================================================================== */
html[data-app="admin-os"] .hub-head { border-bottom: 1px solid var(--line-1); margin-bottom: var(--gap); }
html[data-app="admin-os"] .hub-head .page-header { border-bottom: 0; margin-bottom: 0; padding-bottom: 0.6rem; }
html[data-app="admin-os"] .hub-tabs { display: flex; gap: 2px; overflow-x: auto; }
html[data-app="admin-os"] .hub-tab {
  display: inline-flex; align-items: center; gap: 7px; padding: 0 11px; height: 34px;
  font-size: 12.5px; font-weight: 500; color: var(--ink-3);
  border-bottom: 2px solid transparent; border-radius: 5px 5px 0 0;
  cursor: pointer; white-space: nowrap; user-select: none; text-decoration: none;
  transition: color 0.08s, background 0.08s;
}
html[data-app="admin-os"] .hub-tab:hover { color: var(--ink-1); background: var(--row-hover); }
html[data-app="admin-os"] .hub-tab.active { color: var(--ink-1); font-weight: 600; border-bottom-color: var(--accent); background: none; }
html[data-app="admin-os"] .hub-tab-count { font-family: var(--font-numeric); font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 500; color: var(--ink-4); }
html[data-app="admin-os"] .hub-tab.active .hub-tab-count { color: var(--ink-3); }
html[data-app="admin-os"] .hub-tab-badge { background: var(--accent); color: #fff; font-family: var(--font-numeric); font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 99px; min-width: 17px; text-align: center; line-height: 1.3; }
html[data-app="admin-os"][data-skin="light"] .hub-tab { border-radius: 0; }
html[data-app="admin-os"][data-skin="light"] .hub-tab-badge { color: var(--bg-0); }
html[data-app="admin-os"] .hub-empty { padding: 44px 24px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
html[data-app="admin-os"] .hub-empty h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .hub-empty p { margin: 0 0 8px; font-size: 12px; color: var(--ink-3); max-width: 420px; line-height: 1.55; }
/* Hiring: the stale-record fold */
html[data-app="admin-os"] .hire-fold { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border: 1px dashed var(--line-2); border-radius: 4px; color: var(--ink-3); font-size: 11.5px; cursor: pointer; user-select: none; transition: background 0.08s; background: none; width: 100%; text-align: left; font: inherit; }
html[data-app="admin-os"] .hire-fold:hover { background: var(--row-hover); color: var(--ink-2); }
html[data-app="admin-os"] .hire-stub { display: flex; align-items: center; gap: 8px; padding: 5px 11px; border: 1px solid var(--line-1); border-radius: 4px; font-size: 11.5px; color: var(--ink-3); opacity: 0.72; text-decoration: none; }
/* Roster: in-table group header rows */
html[data-app="admin-os"] .roster-sect td { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-4); background: var(--bg-2); padding: 5px var(--cell-pad-x); height: auto; }
@media (max-width: 720px) {
  html[data-app="admin-os"] .hub-tabs { overflow-x: auto; flex-wrap: nowrap; }
}
```

(The artifact's `.hire-fold` is a `<div>`; the build renders it as a `<button>` for keyboard access, which is why `background:none; width:100%; text-align:left; font:inherit` are added. Everything else is verbatim.)

- [ ] **Step 8: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/staffHub`
Expected: both files passing.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/admin/staffHub/hubSubtitle.js client/src/pages/admin/staffHub/hubSubtitle.test.js client/src/pages/admin/staffHub/StaffHubLayout.js client/src/pages/admin/staffHub/StaffHubLayout.test.js client/src/index.css
git commit -m "feat(staff-hub): layout with header-fused tabs, live subtitle, actions slot; hub CSS from the benchmark"
```

### Task B4: routes, `adminStrict` guards, param-preserving redirects, `screenKey`

**Files:**
- Modify: `client/src/App.js` (lazy imports `:143-177`, routes `:597-620`, add `LegacyRedirect` beside `FinancialsRedirect` at `:274`)
- Modify: `client/src/utils/screenKey.js:24-32`, `client/src/utils/screenKey.test.js`

**Interfaces:**
- Produces: `/staffing` (layout) with index Roster, `hiring`, `payroll`, `reviews` children; `/hiring`, `/tips`, `/reviews`, `/financials/payroll` redirect with params.

- [ ] **Step 1: Update the screenKey test first**

In `screenKey.test.js` delete the `['/financials/payroll', 'financials'],` row and the `expect(screenTitle('financials')).toBe('Payroll');` line, and add:

```js
  ['/staffing/payroll', 'staffing'],
```

to the `test.each` table (every hub child shares the `staffing` key; the per-child key is the mobile phase's call, spec §8).

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/screenKey.test.js`
Expected: passes already for the new row; the point is the file compiles without `financials`. Proceed.

- [ ] **Step 3: Implement `screenKey.js`**

Replace the `SEGMENT_LABELS` block's first line `const map = { financials: 'Payroll' };` with `const map = {};` and the comment above it with:

```js
// First-URL-segment -> nav label ("staffing" -> "Staff"). Every Staff hub child
// shares the "staffing" key (one Desktop-view override for the hub).
```

- [ ] **Step 4: Implement the routes in `App.js`**

Add a lazy import beside the others (`:143`):

```js
const StaffHubLayout = lazy(() => import('./pages/admin/staffHub/StaffHubLayout'));
```

Add next to `FinancialsRedirect` (`:274`):

```js
/** Param-preserving redirect for retired admin URLs. Builds the target with
 *  URLSearchParams over `defaults` so a path that already carries ?tab= never
 *  gets a second '?' concatenated onto it. Targets are hardcoded internal paths. */
function LegacyRedirect({ to, defaults }) {
  const [params] = useSearchParams();
  const merged = new URLSearchParams(defaults || {});
  params.forEach((v, k) => merged.set(k, v));
  const qs = merged.toString();
  return <Navigate replace to={qs ? `${to}?${qs}` : to} />;
}
```

Replace the routes at `:597-601` (`/staffing`, `/staffing/legacy`, `/staffing/users/:id`, `/staffing/applications/:id`, `/hiring`) with:

```jsx
        {/* The Staff hub (spec 2026-08-19). Roster lands; Hiring, Payroll and
            Reviews are admin-only children guarded with adminStrict at the
            route, because their APIs are the server's adminOnly and hiding a
            tab is not a guard (a manager can still type the URL). The three
            detail routes stay siblings so the hub chrome never wraps a
            profile page. */}
        <Route path="/staffing" element={<StaffHubLayout />}>
          <Route index element={<AdminStaffDashboard />} />
          <Route path="hiring" element={<ProtectedRoute adminStrict><HiringDashboard /></ProtectedRoute>} />
          <Route path="payroll" element={<ProtectedRoute adminStrict><PayrollPage /></ProtectedRoute>} />
          <Route path="reviews" element={<ProtectedRoute adminStrict><StaffReviews /></ProtectedRoute>} />
        </Route>
        <Route path="/staffing/legacy" element={<AdminDashboard />} />
        <Route path="/staffing/users/:id" element={<AdminUserDetail />} />
        <Route path="/staffing/applications/:id" element={<AdminApplicationDetail />} />
        <Route path="/hiring" element={<LegacyRedirect to="/staffing/hiring" />} />
```

(Intermediate state after sh-b alone, stated so the dev check is not misread as a regression: all three children still render their OWN `.page-header` inside the hub until their lanes land, so Hiring, Payroll and Reviews show a doubled title. sh-c/sh-d/sh-e each remove their child's header; sh-e also swaps `StaffReviews` for `ReviewsPage` in this block and deletes the old import.)

Replace `:618-620` (`/financials/payroll`, `/tips`, `/reviews`) with:

```jsx
        <Route path="/financials/payroll" element={<LegacyRedirect to="/staffing/payroll" />} />
        <Route path="/tips" element={<LegacyRedirect to="/staffing/payroll" defaults={{ tab: 'tips' }} />} />
        <Route path="/reviews" element={<LegacyRedirect to="/staffing/reviews" />} />
```

Delete the `TipsAdmin` lazy import line in THIS task: B4 removes its only route, so leaving it is an unused-var warning and `CI=true` fails the build on warnings. (The file itself is deleted later, in sh-f.)

> **Status 2026-08-19:** this half of B4 was REVERTED on main by commit `b114e9f0`, which restored the `TipsAdmin` lazy import at `App.js:151-155` (behind a four-line rationale comment) and the `<Route path="/tips" element={<TipsAdmin />} />` at `App.js:646`. The revert was correct: the hub retired `/tips` before its replacements existed, and `TipsAdmin.js` is the only client caller of `GET /admin/tip-feedback` and `POST /admin/tip-feedback/:id/review`, so the complaint queue had no reader. The other B4 redirects (`/hiring`, `/reviews`, `/financials/payroll`) are untouched and live. sh-f Task F1 Step 3 re-applies this one, after the FeedbackCard exists.

- [ ] **Step 5: Verify**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/screenKey.test.js` then `cd client && CI=true npx react-scripts build`.
Expected: both green. Then in the dev app as admin: `/hiring?schedule=5` lands on `/staffing/hiring?schedule=5`; `/tips` lands on `/staffing/payroll?tab=tips`; `/financials/payroll?tab=payrun&period=109` lands on `/staffing/payroll?tab=payrun&period=109`; `/reviews` lands on `/staffing/reviews`. As a manager (dev JWT for a manager user): `/staffing/payroll` bounces to the manager home; `/staffing` renders the roster with no tab strip.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.js client/src/utils/screenKey.js client/src/utils/screenKey.test.js
git commit -m "feat(staff-hub): routes with adminStrict children, param-preserving redirects for the retired URLs"
```

### Task B5: retarget in-app links

**Files:**
- Modify: `client/src/pages/admin/overview/PayrollStatus.js:16, 89`
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js:31`
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js:82, 149`
- Modify: `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js:108, 177`
- Modify: `client/src/pages/mobile/MorePage.js:76-91`

- [ ] **Step 1: Make the edits**

- `PayrollStatus.js:16`: `const PAYROLL_HREF = '/staffing/payroll';` and `:89`: `` href: `/staffing/payroll?tab=payrun&period=${due.id}`, ``
- `NeedsYouStrip.js:31`: `navigate('/hiring')` → `navigate('/staffing/hiring')`
- `PayoutsTab.js:82`: `` `/staffing/payroll?tab=${...}&period=${po.period.id}` `` ; `:149`: `to="/staffing/payroll?tab=tax"`
- `AdminApplicationDetail.js:108`: `<BackButton fallback="/staffing/hiring" />`; `:177`: `` navigate(`/staffing/hiring?schedule=${id}`) ``
- `MorePage.js:76-91`: change the Link `to="/staffing/payroll"` and rewrite the comment: "Deliberate phone-only row: Payroll is a tab inside the Staff hub and has no nav.js item of its own, so the phone offers it explicitly. Admin-gated: the payroll API is admin-only server-side."

- [ ] **Step 2: Verify nothing else points at the old URLs**

Run: `grep -rn "financials/payroll\|'/hiring'\|\"/hiring\|/hiring?\|'/tips'\|\"/tips\"\|'/reviews'\|\"/reviews\"" client/src --include=*.js | grep -v "App.js\|test.js"`
Expected: no output. (Server API routes named `/tips`, `/reviews`, `/hiring/*` are endpoints, not admin links, and are untouched.)

- [ ] **Step 3: Build gate and commit**

Run: `cd client && CI=true npx react-scripts build`

```bash
git add client/src/pages/admin/overview/PayrollStatus.js client/src/pages/admin/overview/NeedsYouStrip.js client/src/pages/admin/userDetail/tabs/PayoutsTab.js client/src/pages/admin/applicationDetail/AdminApplicationDetail.js client/src/pages/mobile/MorePage.js
git commit -m "chore(staff-hub): retarget every in-app link at the hub routes"
```

### Task B6: Roster inside the hub

**Files:**
- Modify: `client/src/pages/admin/StaffDashboard.js`

**Interfaces:**
- Consumes: `useOutletContext()` → `{ summary, setActions }` (Task B3). `GET /admin/active-staff?include_stubs=true&limit=100&page=N` (Task A4 shape: `{ staff, total, page, pages }`).

- [ ] **Step 1: Rewrite the component body**

Keep the imports, `isLegacyCcStub`, `initialsOf`, and the kebab menu exactly as they are. Make these changes:

(a) Replace the URL-state constants:

```js
// URL-backed view state (admin cross-nav). Module scope = stable identity.
const STAFF_DEFAULTS = { tab: 'active', page: '1' };
const STAFF_TABS = ['active', 'deactivated', 'all'];
const PAGE_SIZE = 100; // the endpoint's max; groups and footer count from the same universe as the hub counts

// Imported placeholder identities: legacy CC stubs and the payment-history
// import's @imported.invalid accounts. Status-scoped to match the server's
// imported_count predicate (spec §5).
function isImportedRecord(s) {
  return isLegacyCcStub(s)
    || (s?.onboarding_status === 'deactivated' && s?.import_source === 'payment_history_import');
}
```

(b) In the component, pull the hub context and register the header action:

```js
  const { summary, setActions } = useOutletContext() || {};
  useEffect(() => {
    if (!setActions) return undefined;
    setActions(
      <button type="button" className="btn btn-primary" onClick={() => navigate('/staffing/legacy')}>
        <Icon name="send" />Send SMS
      </button>
    );
    return () => setActions(null);
  }, [setActions, navigate]);
```

Add `useOutletContext` to the `react-router-dom` import.

(c) Fetch with paging:

```js
  const page = Math.max(1, parseInt(listState.page, 10) || 1);
  const [meta, setMeta] = useState({ total: 0, pages: 1 });
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    setLoading(true); setLoadError(false);
    api.get(`/admin/active-staff?include_stubs=true&limit=${PAGE_SIZE}&page=${page}`)
      .then(r => {
        setStaff(r.data?.staff || []);
        setMeta({ total: Number(r.data?.total || 0), pages: Number(r.data?.pages || 1) });
      })
      .catch(() => { setLoadError(true); toast.error('Failed to load staff. Try refreshing.'); })
      .finally(() => setLoading(false));
  }, [toast, page, reloadKey]);
```

(d) Filtering and groups:

```js
  const active = useMemo(() => staff.filter(s => s.onboarding_status === 'approved'), [staff]);
  const deactivated = useMemo(() => staff.filter(s => s.onboarding_status === 'deactivated'), [staff]);
  const former = useMemo(() => deactivated.filter(s => !isImportedRecord(s)), [deactivated]);
  const imported = useMemo(() => deactivated.filter(isImportedRecord), [deactivated]);

  // Rows in render order, with group header markers where the view has groups.
  const rows = useMemo(() => {
    if (tab === 'active') return active.map(s => ({ kind: 'row', s }));
    const groups = [
      { label: 'Former staff', items: former },
      { label: 'Imported records', items: imported },
    ];
    if (tab === 'all') groups.unshift({ label: 'Active', items: active });
    return groups.flatMap(g => ([{ kind: 'sect', label: g.label, count: g.items.length }, ...g.items.map(s => ({ kind: 'row', s }))]));
  }, [tab, active, former, imported]);

  const tabs = useMemo(() => ([
    { id: 'active', label: 'Active', count: summary?.active_count ?? active.length },
    { id: 'deactivated', label: 'Deactivated', count: summary?.deactivated_count ?? deactivated.length },
    { id: 'all', label: 'All', count: (summary?.active_count ?? active.length) + (summary?.deactivated_count ?? deactivated.length) },
  ]), [summary, active.length, deactivated.length]);
```

Tab counts prefer the server's whole-table numbers and fall back to the loaded slice.

(e) Replace the JSX: delete the `.page` wrapper and `.page-header` (the hub owns both; return a fragment). Keep `<Toolbar tabs={tabs} tab={tab} setTab={(t) => setListState({ tab: t, page: '1' })} />`. Keep the existing `Loading…` row and add an inline retry row directly under it:

```jsx
              {!loading && loadError && (
                <tr><td colSpan={7}><span className="muted">Could not load staff.</span>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReloadKey(k => k + 1)}>Retry</button></td></tr>
              )}
```

The table body then maps `rows`:

```jsx
              {!loading && rows.map((r, i) => r.kind === 'sect' ? (
                <tr key={`sect-${r.label}`} className="roster-sect">
                  <td colSpan={7}>{r.label} · {r.count}</td>
                </tr>
              ) : (
                /* The existing <ClickableRow key={s.id} …> block (StaffDashboard.js:113-179 as of today),
                   with `const s = r.s;` hoisted above it and only the email sub line changed as shown below. */
              ))}
```

In the existing row, the email sub line becomes:

```jsx
                          {isImportedRecord(s)
                            ? <div className="sub">{isStub && !isAdmin ? 'email redacted for managers' : 'no email on file'}</div>
                            : ((s.display_name || s.preferred_name) && s.email && <div className="sub">{displayEmail}</div>)}
```

(f) Empty state (Active tab, nothing loaded, not loading) replaces the table entirely:

```jsx
      {!loading && tab === 'active' && active.length === 0 ? (
        <div className="card">
          <div className="hub-empty">
            <h4>No active staff yet</h4>
            <p>Approved hires land here on their own once onboarding completes.{summary?.new_applications > 0 ? ` ${summary.new_applications === 1 ? 'One application is' : `${summary.new_applications} applications are`} waiting for a first look right now.` : ''}</p>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/staffing/hiring')}>Open Hiring</button>
          </div>
        </div>
      ) : ( /* the card + table */ )}
```

(g) Footer line under the table:

```jsx
      {!loading && (
        <div className="tiny muted hstack" style={{ padding: '8px 2px', gap: 12 }}>
          <span>
            {tab === 'active' && `${active.length} active`}
            {tab === 'deactivated' && `${deactivated.length} deactivated · ${former.length} former staff, ${imported.length} imported records`}
            {tab === 'all' && `${staff.length} ${staff.length === 1 ? 'team member' : 'team members'}`}
          </span>
          {meta.pages > 1 && (
            <>
              <span>Showing page {page} of {meta.pages} ({meta.total} total)</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setListState({ page: String(page - 1) })}>Prev</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={page >= meta.pages} onClick={() => setListState({ page: String(page + 1) })}>Next</button>
            </>
          )}
        </div>
      )}
```

The "Open hiring" header button is gone. The `Toolbar` colSpan stays 7.

- [ ] **Step 2: Unit-test the pure pieces**

Export `isImportedRecord` from `StaffDashboard.js` and add `client/src/pages/admin/StaffDashboard.grouping.test.js`:

```js
import { isImportedRecord } from './StaffDashboard';

test('legacy CC stubs and deactivated payment-history imports are imported records; active imports are not', () => {
  expect(isImportedRecord({ cc_id: 'legacy_cc:9', onboarding_status: 'deactivated' })).toBe(true);
  expect(isImportedRecord({ import_source: 'payment_history_import', onboarding_status: 'deactivated' })).toBe(true);
  expect(isImportedRecord({ import_source: 'payment_history_import', onboarding_status: 'approved' })).toBe(false);
  expect(isImportedRecord({ onboarding_status: 'deactivated' })).toBe(false);
});
```

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/StaffDashboard.grouping.test.js`.

- [ ] **Step 3: Verify in the dev app**

`/staffing`: Active shows 16 with no group rows; Deactivated shows "Former staff · 5" then "Imported records · 9" (the nine now render, Task A4); All shows "Active · 16" first. Imported rows read "no email on file". Send SMS sits in the hub header. `/staffing?tab=all` (old links) still works.

- [ ] **Step 4: Build gate, docs, commit**

Run: `cd client && CI=true npx react-scripts build`. Update `README.md`'s folder tree: add `client/src/pages/admin/staffHub/` (StaffHubLayout.js, hubSubtitle.js) with one line each.

```bash
git add client/src/pages/admin/StaffDashboard.js client/src/pages/admin/StaffDashboard.grouping.test.js README.md
git commit -m "feat(roster): Active/Deactivated/All with group rows, paging, hub header actions, empty state"
```

**Lane sh-b done when:** B1–B6 committed; `cd client && CI=true npx react-scripts test --watchAll=false` green for the touched tests; the build gate green; `ui-ux-review` run against artboards 1a/1b/1c.

# Lane sh-c-hiring

### Task C1: Hiring inside the hub: header gone, search in a toolbar row, the stale-record fold

> **Correction 2026-08-19 (verified against production, after this lane merged at `4c279764`):** the "40-card problem" this task was written to solve does not exist as described. What was believed: the Onboarding column renders 40 zero-progress cards (29 accounts bulk-registered on the 2026-05-27 CheckCherry cutover plus 11 unfinished signups), and the fold collapses them. What is true: `GET /admin/applications` INNER JOINs the `applications` table (`server/routes/admin/applications.js:85`), and all 40 of those accounts have no `applications` row, so none of them ever reaches the kanban. The Onboarding column renders ZERO cards, `splitOnboarding` receives an empty array, and `.hire-fold` can never render today. How it was verified: queried prod Neon (`round-tooth-34649976` / `br-noisy-frog-ad99sa6l`, and the default branch, same result) for the 29 `hired` and 11 `in_progress` accounts and for their `applications` rows; the feed returns 2 board rows, both in pre-Onboarding stages, and `/admin/hiring/summary`'s `in_pipeline` INNER JOINs the same way and agrees at 2. What shipped is therefore harmless defensive code, correct for the day a zero-progress account does carry an application row. The real finding is separate and belongs to Dallas, not to this plan: those 40 accounts are invisible in Hiring AND in the Roster (the active-staff feed returns only `approved`, `reviewed`, `submitted` and `deactivated`), so they are visible nowhere in the admin UI except search and `/staffing/users/:id`. The shipped code comment on main still carries the old "29 accounts plus 3 stale signups" reading; it is left as-is so the plan and the code do not disagree about text, and this note is the correction of record.

**Files:**
- Modify: `client/src/pages/admin/HiringDashboard.js`
- Create: `client/src/pages/admin/HiringDashboard.fold.test.js`

**Interfaces:**
- Consumes: the kanban's `apps` rows (`id` = user id, `created_at`, `onboarding_progress` 0..1, `onboarding_status`).
- Produces: `splitOnboarding(rows, nowMs) -> { live, folded }` (named export, pure) and `FOLD_DAYS = 60`.

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/admin/HiringDashboard.fold.test.js
import { splitOnboarding, FOLD_DAYS } from './HiringDashboard';

const DAY = 86400000;
const now = Date.parse('2026-08-19T12:00:00Z');
const row = (over) => ({ id: 1, onboarding_status: 'in_progress', onboarding_progress: 0, created_at: new Date(now - 10 * DAY).toISOString(), ...over });

test('a fresh 0% signup is live; an old 0% account folds; an old account with progress stays live', () => {
  const fresh = row({ id: 1 });
  const oldZero = row({ id: 2, created_at: new Date(now - (FOLD_DAYS + 1) * DAY).toISOString() });
  const oldStarted = row({ id: 3, created_at: new Date(now - 200 * DAY).toISOString(), onboarding_progress: 1 / 6 });
  const { live, folded } = splitOnboarding([fresh, oldZero, oldStarted], now);
  expect(live.map(r => r.id)).toEqual([1, 3]);
  expect(folded.map(r => r.id)).toEqual([2]);
});

test('the fold never keys on status: a day-one pre-hired recruit (hired, 0%) is live', () => {
  const { live, folded } = splitOnboarding([row({ id: 9, onboarding_status: 'hired', created_at: new Date(now - 1 * DAY).toISOString() })], now);
  expect(live).toHaveLength(1);
  expect(folded).toHaveLength(0);
});

test('exactly FOLD_DAYS old is still live; one day more folds', () => {
  const edge = row({ id: 4, created_at: new Date(now - FOLD_DAYS * DAY).toISOString() });
  const past = row({ id: 5, created_at: new Date(now - (FOLD_DAYS + 1) * DAY).toISOString() });
  const { live, folded } = splitOnboarding([edge, past], now);
  expect(live.map(r => r.id)).toEqual([4]);
  expect(folded.map(r => r.id)).toEqual([5]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/HiringDashboard.fold.test.js`
Expected: FAIL, `splitOnboarding` is not exported.

- [ ] **Step 3: Implement**

(a) Module-level, after `stageOf`:

```js
// The stale-record fold (spec §6). Predicate is generic, never a status or a
// cutover date: an Onboarding card whose account is older than FOLD_DAYS and
// has completed no onboarding step. Today that is the 29 accounts bulk-
// registered on the 2026-05-27 cutover plus 3 stale signups; a day-one
// pre-hired recruit is also `hired` at 0% and must render live.
export const FOLD_DAYS = 60;
export function splitOnboarding(rows, nowMs = Date.now()) {
  const live = [];
  const folded = [];
  for (const a of rows) {
    const ageDays = a.created_at ? (nowMs - new Date(a.created_at).getTime()) / 86400000 : 0;
    const zero = !(Number(a.onboarding_progress) > 0);
    if (zero && ageDays > FOLD_DAYS) folded.push(a); else live.push(a);
  }
  folded.sort((x, y) => new Date(x.created_at) - new Date(y.created_at)); // oldest first
  return { live, folded };
}
const STATUS_WORD = { hired: 'pre-hired', in_progress: 'signed up' };
const ymdLabel = (v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
```

(b) In the `cols` memo, after the loop: `const split = splitOnboarding(out.in_progress); out.in_progress = split.live; out.in_progress_folded = split.folded;`. Add `const [foldOpen, setFoldOpen] = useState(false);` beside the other state.

(c) Replace the `.page` / `.page-header` JSX: the component returns a fragment; the old header's search `<div className="page-actions" ...>` block becomes the right side of a toolbar row placed where the header was:

```jsx
    <>
      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <div className="muted tiny">{summary.in_pipeline} in pipeline · {summary.new_apps_7d} new this week</div>
        <div className="spacer" />
        <div style={{ position: 'relative', minWidth: 280 }}>
          {/* Move the search <input className="input" …> and the {searchOpen && (<div className="card" …>…</div>)} dropdown
              from the old page-actions block (HiringDashboard.js:156-207 as of today; take the WHOLE
              searchOpen block through its closing tags) here, byte for byte. */}
        </div>
      </div>
      {/* existing stat row, kanban, modal follow */}
    </>
```

(d) In the Onboarding column body (the `else` branch at `:273-283`), after the live cards and before `EmptyTile`:

```jsx
                    {col.key === 'in_progress' && cols.in_progress_folded.length > 0 && (
                      <>
                        <button type="button" className="hire-fold" aria-expanded={foldOpen} onClick={() => setFoldOpen(o => !o)}>
                          <span aria-hidden="true">{foldOpen ? '▾' : '▸'}</span>
                          <span>
                            Not started · {cols.in_progress_folded.length} · oldest {ymdLabel(cols.in_progress_folded[0].created_at)} · not pipeline
                          </span>
                        </button>
                        {foldOpen && (
                          <>
                            <div className="tiny muted" style={{ padding: '0 2px' }}>
                              Accounts older than {FOLD_DAYS} days that never began onboarding. Open one to deactivate it from the staffer page; nothing here counts toward the board.
                            </div>
                            {cols.in_progress_folded.map(a => (
                              <EntityLink key={a.id} to={`/staffing/users/${a.id}`} className="hire-stub">
                                <span className="avatar" style={{ width: 18, height: 18, fontSize: 9 }}>{initialsOf(a.full_name || a.email)}</span>
                                <span style={{ flex: 1 }}>{a.full_name || a.email}</span>
                                <span className="muted">{ymdLabel(a.created_at)}</span>
                                <span className="tag">{STATUS_WORD[a.onboarding_status] || a.onboarding_status}</span>
                              </EntityLink>
                            ))}
                          </>
                        )}
                      </>
                    )}
```

`EntityLink` is already imported. The column's count badge already reads `cols[col.key].length`, which is now the live count. The `EmptyTile` condition becomes `cols[col.key].length === 0 && !(col.key === 'in_progress' && cols.in_progress_folded.length > 0)`.

The list projects `a.full_name` (`applications.js:76`) and `u.created_at` unaliased as `created_at`, so `a.full_name` and `a.created_at` are the right fields.

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/HiringDashboard.fold.test.js`
Expected: 3 passing. Dev app: `/staffing/hiring` shows Onboarding 8 with a "Not started · 32 · oldest May 27, 2026 · not pipeline" fold; expanding lists dimmed rows linking to staffer pages; the `?schedule=` deep link and search still work.

- [ ] **Step 5: Build gate and commit**

Run: `cd client && CI=true npx react-scripts build`

```bash
git add client/src/pages/admin/HiringDashboard.js client/src/pages/admin/HiringDashboard.fold.test.js
git commit -m "feat(hiring): header into the hub; stale-record fold keyed on zero progress + 60 days"
```

**Lane sh-c done when:** C1 committed, build green, `ui-ux-review` against artboard 1d (with the §3 overrides: generic fold label, no matcher copy, rows link to the staffer page).

# Lane sh-d-payroll

**Execution order in this lane: D3 (tipStatus + TipsLedger) → D2 (CurrentWeekCard) → D1 (PayrollPage rewrite).** D1's rewritten page imports `./TipsLedger` and `./CurrentWeekCard`-wired `PayRunView` props; building it last means every checkpoint compiles and the per-commit `CI=true` build gate holds. The tasks are written D1-first because the page is the integration point that explains the other two; execute bottom-up.

### Task D1: `PayrollPage`: header gone, tabs become a real `.seg`, "Tips" (EXECUTE LAST in sh-d)

**Files:**
- Modify: `client/src/pages/admin/payroll/PayrollPage.js`

**Interfaces:**
- Consumes: `Toolbar` (`client/src/components/adminos/Toolbar.js`), `useOutletContext()` → `{ summary, refresh }`.
- Produces: tab ids unchanged (`payrun`, `history`, `tips`, `tax`); `PayRunView` receives `openPeriod={summary?.open_period}` and `pendingReviews={summary?.pending_reviews}` (Task D2); `TipsLedger` renders in the tips tab (Task D3).

- [ ] **Step 1: Rewrite `PayrollPage.js`**

```js
import React from 'react';
import { useOutletContext } from 'react-router-dom';
import useUrlListState from '../../../hooks/useUrlListState';
import Toolbar from '../../../components/adminos/Toolbar';
import StatusChip from '../../../components/adminos/StatusChip';
import PayRunView from './PayRunView';
import HistoryView from './HistoryView';
import UnassignedTipsPanel from './UnassignedTipsPanel';
import DeferredTipsPanel from './DeferredTipsPanel';
import TipsLedger from './TipsLedger';
import TaxTotalsTab from './TaxTotalsTab';

// Payroll is a child of the Staff hub (spec 2026-08-19 §7). The hub owns the
// page header; this page owns its views as .seg pills in the toolbar (two
// vocabularies: underline above, pills below, never the same strip twice).
const TABS = [
  { id: 'payrun', label: 'Pay run' },
  { id: 'history', label: 'History' },
  { id: 'tips', label: 'Tips' },
  { id: 'tax', label: '1099 / tax' },
];
const TAB_IDS = TABS.map(t => t.id);
// Pre-redesign tab ids remap on read so old bookmarks and deep links keep
// working (the payroll redesign renamed the tabs); writes use the new ids.
const LEGACY_TAB_REMAP = { current: 'payrun', unassigned: 'tips' };
const PAYROLL_DEFAULTS = { tab: 'payrun', period: '' };

export default function PayrollPage() {
  const [listState, setListState] = useUrlListState(PAYROLL_DEFAULTS);
  const mappedTab = LEGACY_TAB_REMAP[listState.tab] || listState.tab;
  const tab = TAB_IDS.includes(mappedTab) ? mappedTab : 'payrun';
  const { summary, refresh } = useOutletContext() || {};

  return (
    <>
      <Toolbar
        tabs={TABS}
        tab={tab}
        // Clear the period param on tab clicks: both Pay run and History
        // consume it, and a stale non-paid id would bounce History right
        // back to Pay run. Deep links set the param directly in the URL.
        setTab={(t) => setListState({ tab: t, period: '' })}
      />

      {tab === 'payrun' && (
        <PayRunView
          periodParam={listState.period}
          openPeriod={summary?.open_period || null}
          pendingReviews={summary?.pending_reviews ?? 0}
          onChanged={refresh}
        />
      )}
      {tab === 'history' && <HistoryView periodParam={listState.period} />}
      {tab === 'tips' && <TipsTab />}
      {tab === 'tax' && <TaxTotalsTab />}
    </>
  );
}

// Repair, then ledger, then context. Both repair panels report their count so
// an empty pair collapses to one clear line and the ledger is the page.
function TipsTab() {
  const [counts, setCounts] = React.useState({ unassigned: null, deferred: null });
  const bothClear = counts.unassigned === 0 && counts.deferred === 0;
  return (
    <div className="vstack" style={{ gap: 16 }}>
      {bothClear && (
        <div className="card">
          <div className="card-body hstack" style={{ gap: 10 }}>
            <StatusChip kind="ok">clear</StatusChip>
            <span>Repair queues are clear: no unassigned tips, nothing deferred.</span>
            <span className="muted tiny">Unassigned appear when a tip can't find its event · deferred wait for an open period</span>
          </div>
        </div>
      )}
      <UnassignedTipsPanel hideWhenEmpty onCount={(n) => setCounts(c => (c.unassigned === n ? c : { ...c, unassigned: n }))} />
      <DeferredTipsPanel hideWhenEmpty onCount={(n) => setCounts(c => (c.deferred === n ? c : { ...c, deferred: n }))} />
      <TipsLedger />
      <p className="tiny muted" style={{ margin: 0 }}>
        Tips are collected on each bartender's own sign and paid through the event's payout, pooled across the bartenders who worked it; this ledger is the cross-staff view. A staffer's Payouts tab shows where each one landed.
      </p>
    </div>
  );
}
```

(The `"← Overview"` button is gone with the header.)

- [ ] **Step 2: Add `onCount` / `hideWhenEmpty` to the two repair panels**

In `UnassignedTipsPanel.js`: signature `export default function UnassignedTipsPanel({ onCount, hideWhenEmpty = false })`; after the fetch resolves (where `setTips(...)` is called) add `if (onCount) onCount((r.data?.tips || []).length);` using whatever variable the file already holds the list in; and change the empty return (`if (tips.length === 0) { return (<div className="card">…No unassigned tips…</div>); }`) to `if (tips.length === 0) return hideWhenEmpty ? null : (<existing empty card>);`. Also call `onCount` after a successful assign re-fetch so the clear line can appear once the last one is fixed.

In `DeferredTipsPanel.js`: the same two edits around its fetch (`:30`) and its empty return (`:65-66`).

- [ ] **Step 3: Verify and commit**

Run: `cd client && CI=true npx react-scripts build` (green: D3 and D2 already landed their files). Dev app: `/staffing/payroll` shows the `.seg` under the hub tabs; `?tab=unassigned` still lands on Tips; the clear line appears when both queues are empty.

```bash
git add client/src/pages/admin/payroll/PayrollPage.js client/src/pages/admin/payroll/UnassignedTipsPanel.js client/src/pages/admin/payroll/DeferredTipsPanel.js
git commit -m "feat(payroll): hub child; tabs become a .seg; repair queues collapse to one clear line when empty"
```

### Task D2: the current-week card in `PayRunView` (EXECUTE SECOND in sh-d)

**Files:**
- Create: `client/src/pages/admin/payroll/CurrentWeekCard.js`
- Create: `client/src/pages/admin/payroll/CurrentWeekCard.test.js`
- Modify: `client/src/pages/admin/payroll/PayRunView.js` (props, render above the queue)

**Interfaces:**
- Consumes: `openPeriod` (A2 `open_period` shape), `pendingReviews` (int), `bountyCents` (int, from `GET /admin/staff-reviews` envelope, Task A6).
- Produces: `CurrentWeekCard({ openPeriod, pendingReviews, bountyCents })` renders ONLY when the derived window has no row yet, or has a row that is `open` with zero payouts accrued; otherwise returns null (the queue already shows that period).

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/admin/payroll/CurrentWeekCard.test.js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CurrentWeekCard from './CurrentWeekCard';

const P = { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 };
const r = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

test('no row yet: names the derived window, $0.00 owed, nothing accrued yet', () => {
  r(<CurrentWeekCard openPeriod={P} pendingReviews={0} bountyCents={1000} />);
  expect(screen.getByText(/Aug 18 to 24/)).toBeInTheDocument();
  expect(screen.getByText(/payday Tue Aug 25/)).toBeInTheDocument();
  expect(screen.getByText(/\$0\.00 owed/)).toBeInTheDocument();
  expect(screen.getByText(/Nothing accrued yet/)).toBeInTheDocument();
  expect(screen.queryByText(/pending review/)).toBeNull();
});

test('a pending review adds the pointer with the bounty from the envelope', () => {
  r(<CurrentWeekCard openPeriod={P} pendingReviews={1} bountyCents={1000} />);
  expect(screen.getByText(/1 pending review\. A confirmed five-star review with a name adds \$10\.00 to the next open run\./)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Confirm under Reviews/ })).toHaveAttribute('href', '/staffing/reviews');
});

test('renders nothing when the week already has payouts, or is not open, or there is no window', () => {
  const { container: a } = r(<CurrentWeekCard openPeriod={{ ...P, exists: true, status: 'open', payouts_accrued: 3 }} pendingReviews={0} bountyCents={1000} />);
  expect(a).toBeEmptyDOMElement();
  const { container: b } = r(<CurrentWeekCard openPeriod={{ ...P, exists: true, status: 'processing', payouts_accrued: 0 }} pendingReviews={0} bountyCents={1000} />);
  expect(b).toBeEmptyDOMElement();
  const { container: c } = r(<CurrentWeekCard openPeriod={null} pendingReviews={0} bountyCents={1000} />);
  expect(c).toBeEmptyDOMElement();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/payroll/CurrentWeekCard.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// client/src/pages/admin/payroll/CurrentWeekCard.js
import React from 'react';
import { Link } from 'react-router-dom';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { ymdLabel, windowLabel } from '../staffHub/hubSubtitle';

/**
 * The open week with nothing accrued is the honest common case Tue..Fri
 * (pay_periods rows are created lazily on the first accrual, usually
 * Saturday). PayRunView renders only rows, so this card is keyed on the
 * DERIVED window from the hub summary and sits above the queue. It hides as
 * soon as the period has payouts (the queue shows it) or is no longer open.
 */
export default function CurrentWeekCard({ openPeriod, pendingReviews = 0, bountyCents = 0 }) {
  const p = openPeriod;
  if (!p) return null;
  const showable = !p.exists || (p.status === 'open' && Number(p.payouts_accrued) === 0);
  if (!showable) return null;
  const n = Number(pendingReviews) || 0;
  return (
    <div className="card" style={{ marginBottom: 'var(--gap)' }}>
      <div className="card-head">
        <h3 className="hstack" style={{ gap: 8 }}>
          <span>{windowLabel(p.start_date, p.end_date)}</span>
          <StatusChip kind="info">open</StatusChip>
          <span className="muted tiny">payday {ymdLabel(p.payday, { weekday: true })}</span>
        </h3>
        <span className="mono">{fmt$fromCents(0)} owed</span>
      </div>
      <div className="card-body vstack" style={{ gap: 8 }}>
        <div className="muted">Nothing accrued yet. Shift pay, tips and review bounties land here on their own as events close out.</div>
        {n > 0 && (
          <div className="hstack" style={{ gap: 8 }}>
            <span className="hub-tab-badge">{n}</span>
            <span>
              {n} pending {n === 1 ? 'review' : 'reviews'}. A confirmed five-star review with a name adds {fmt$fromCents(bountyCents)} to the next open run.{' '}
              <Link to="/staffing/reviews">Confirm under Reviews</Link>.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `PayRunView`**

Signature: `export default function PayRunView({ periodParam, openPeriod = null, pendingReviews = 0, onChanged })`. Add state `const [bountyCents, setBountyCents] = useState(0);` and, in the existing `load()` (or a sibling effect), fetch the bounty once: `api.get('/admin/staff-reviews').then(r => setBountyCents(Number(r.data?.bounty_cents) || 0)).catch(() => {});` (admin-only page; a failure just hides the dollar figure). Render `<CurrentWeekCard openPeriod={openPeriod} pendingReviews={pendingReviews} bountyCents={bountyCents} />` directly above `{derived.queue.length === 0 && (...)}`. Where the view already calls `load()` after a successful process / mark-paid, also call `onChanged?.()` so the hub subtitle's accrued count and status follow.

- [ ] **Step 5: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/payroll/CurrentWeekCard.test.js`
Expected: 3 passing. Dev app on a weekday before any accrual: the card shows the current week above the queue; after a shift accrues (or on a week whose row exists with payouts) it disappears and the queue carries the period.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/payroll/CurrentWeekCard.js client/src/pages/admin/payroll/CurrentWeekCard.test.js client/src/pages/admin/payroll/PayRunView.js
git commit -m "feat(payroll): current-week card keyed on the derived window, with the pending-review pointer"
```

### Task D3: `tipStatus` (pure) + `TipsLedger` (EXECUTE FIRST in sh-d)

**Files:**
- Create: `client/src/pages/admin/payroll/tipStatus.js`
- Create: `client/src/pages/admin/payroll/tipStatus.test.js`
- Create: `client/src/pages/admin/payroll/TipsLedger.js`

**Interfaces:**
- Consumes: `GET /admin/tips?from&to&cursor&limit` rows with the A5 columns.
- Produces: `tipStatus(tip) -> { label, kind, hint? }` (pure); `TipsLedger` (default export), URL-backed `from`/`to` via `useUrlListState`.

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/admin/payroll/tipStatus.test.js
import { tipStatus, netCents } from './tipStatus';

const base = { amount_cents: 600, refunded_amount_cents: 0, shift_id: 377, deferred_at: null, rolled_forward_at: null, dispute_won_at: null, tipped_at: '2026-08-16T20:41:00Z' };

test('first match wins, in the spec order', () => {
  expect(tipStatus({ ...base, dispute_won_at: '2026-08-20T00:00:00Z' }).label).toBe('dispute won');
  expect(tipStatus({ ...base, refunded_amount_cents: 600 }).label).toBe('refunded $6.00');
  expect(tipStatus({ ...base, deferred_at: '2026-08-17T00:00:00Z' }).label).toBe('deferred, waiting for an open period');
  expect(tipStatus({ ...base, shift_id: null }).label).toBe('unassigned');
  expect(tipStatus({ ...base, rolled_forward_at: '2026-08-19T12:00:00Z' }).label).toBe('rolled forward Aug 19');
  expect(tipStatus(base).label).toBe('on the Aug 16 event');
});

test('net strips refunds and never goes negative', () => {
  expect(netCents({ amount_cents: 600, refunded_amount_cents: 250 })).toBe(350);
  expect(netCents({ amount_cents: 600, refunded_amount_cents: 900 })).toBe(0);
  expect(netCents({ amount_cents: 600 })).toBe(600);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/payroll/tipStatus.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `tipStatus.js`**

```js
// client/src/pages/admin/payroll/tipStatus.js
// A tip's Status on the cross-staff ledger, derived from the row ALONE. There
// is no tip -> payout key: a shift's tips pool across the event's bartenders,
// and a late tip lands in today's period while keeping the original shift, so
// a per-tip "lands in" period cannot be made truthful from event_date (spec
// §3 override). First match wins, in this order.
import { fmt$fromCents } from '../../../components/adminos/format';

const mmmd = (v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });

export function netCents(t) {
  return Math.max(0, Number(t.amount_cents || 0) - Number(t.refunded_amount_cents || 0));
}

export function tipStatus(t) {
  if (t.dispute_won_at) return { label: 'dispute won', kind: 'warn' };
  if (Number(t.refunded_amount_cents) > 0) return { label: `refunded ${fmt$fromCents(Number(t.refunded_amount_cents))}`, kind: 'warn' };
  if (t.deferred_at) return { label: 'deferred, waiting for an open period', kind: 'violet' };
  if (!t.shift_id) return { label: 'unassigned', kind: 'danger', hint: 'see the repair queue above' };
  if (t.rolled_forward_at) return { label: `rolled forward ${mmmd(t.rolled_forward_at)}`, kind: 'info' };
  return { label: `on the ${mmmd(t.tipped_at)} event`, kind: 'ok' };
}
```

- [ ] **Step 4: Implement `TipsLedger.js`** (the donor is `TipsTab` in `TipsAdmin.js:69-177`; this is that code with URL-backed filters, net amounts, the Status column, and Load more)

```js
// client/src/pages/admin/payroll/TipsLedger.js
import React, { useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import useUrlListState from '../../../hooks/useUrlListState';
import EntityLink from '../../../components/EntityLink';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { tipStatus, netCents } from './tipStatus';

const LEDGER_DEFAULTS = { from: '', to: '' };
const PAGE = 50;

// The cross-staff tip ledger, moved from the retired /tips page into Payroll
// (spec §7). Money columns are NET of refunds; the stat is labelled "in view"
// because it sums what is loaded (the read is cursor-paginated).
export default function TipsLedger() {
  const toast = useToast();
  const [filters, setFilters] = useUrlListState(LEDGER_DEFAULTS);
  const [tips, setTips] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Retry cannot go through setFilters: useUrlListState DELETES keys equal to
  // their defaults, so re-setting empty filters changes nothing and the effect
  // never refires. A plain counter is the refetch signal.
  const [reloadKey, setReloadKey] = useState(0);

  const fetchPage = (after) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (after) params.set('cursor', String(after));
    return api.get(`/admin/tips?${params.toString()}`);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(false);
    fetchPage(null)
      .then(r => { if (cancelled) return; setTips(r.data?.tips || []); setCursor(r.data?.next_cursor || null); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, reloadKey]);

  const loadMore = () => {
    if (!cursor) return;
    fetchPage(cursor)
      .then(r => { setTips(t => [...t, ...(r.data?.tips || [])]); setCursor(r.data?.next_cursor || null); })
      .catch(() => toast.error('Could not load more tips.'));
  };

  const total = useMemo(() => tips.reduce((s, t) => s + netCents(t), 0), [tips]);

  return (
    <>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Net in view</div>
          <div className="stat-value">{fmt$fromCents(total)}</div>
          <div className="stat-sub"><span>{tips.length} {tips.length === 1 ? 'tip' : 'tips'}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">From</span>
            <input type="date" value={filters.from} onChange={e => setFilters({ from: e.target.value })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">To</span>
            <input type="date" value={filters.to} onChange={e => setFilters({ to: e.target.value })} />
          </label>
          {(filters.from || filters.to) && (
            <button type="button" className="btn btn-ghost" onClick={() => setFilters({ from: '', to: '' })}>Clear</button>
          )}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Activity</h3><span className="k">{tips.length}</span></div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Bartender</th><th className="num">Amount</th><th>Date</th><th>Customer</th><th>Status</th></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
              {!loading && error && (
                <tr><td colSpan={5}><span className="muted">Could not load tips.</span>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReloadKey(k => k + 1)}>Retry</button></td></tr>
              )}
              {!loading && !error && tips.length === 0 && <tr><td colSpan={5} className="muted">No tips in view.</td></tr>}
              {!loading && tips.map(t => {
                const st = tipStatus(t);
                const refunded = Number(t.refunded_amount_cents) > 0;
                return (
                  <tr key={t.id}>
                    <td>
                      <EntityLink to={t.target_user_id ? `/staffing/users/${t.target_user_id}?tab=payouts` : null}>
                        <strong>{t.bartender_name || `user ${t.target_user_id}`}</strong>
                      </EntityLink>
                    </td>
                    <td className="num">
                      {fmt$fromCents(netCents(t))}
                      {refunded && <span className="muted tiny" style={{ marginLeft: 6, textDecoration: 'line-through' }}>{fmt$fromCents(t.amount_cents)}</span>}
                    </td>
                    <td>{t.tipped_at ? new Date(t.tipped_at).toLocaleString('en-US', { hour12: false }) : '—'}</td>
                    <td className="muted">{t.customer_email || '—'}</td>
                    <td><StatusChip kind={st.kind}>{st.label}</StatusChip>{st.hint && <span className="muted tiny" style={{ marginLeft: 6 }}>{st.hint}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {cursor && (
          <div className="card-body" style={{ paddingTop: 0 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadMore}>Load more</button>
          </div>
        )}
      </div>
    </>
  );
}
```

The profile's tabs are URL-driven (`AdminUserDetail.js:49` uses `useUrlListState`), so `?tab=payouts` lands on the Payouts tab.

- [ ] **Step 5: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/payroll/tipStatus.test.js`, then the build gate. Dev app: `/staffing/payroll?tab=tips` shows the clear line, then the $6.00 ledger with Status "on the Aug 16 event"; `/tips?from=2026-08-01` redirects and the From filter is applied.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/payroll/tipStatus.js client/src/pages/admin/payroll/tipStatus.test.js client/src/pages/admin/payroll/TipsLedger.js
git commit -m "feat(payroll): cross-staff tips ledger in the Tips tab with a row-derived Status column"
```

**Lane sh-d done when:** D1–D3 committed; build green; `ui-ux-review` against artboards 1e/1f/1g/1g2 (override: no "Lands in" column, one stat, the true footer sentence).

# Lane sh-e-reviews

The method here is **move, then restructure**: every function in `StaffReviews.js` moves into a file under `staffHub/reviews/` first (byte-for-byte logic), the page is re-composed as pending cards + resolved table + contest rail, and only then is the old file deleted. The behaviors §7 enumerates (quarter selector + `QUARTER_RE`, the `QUARTER_IN_PROGRESS` → confirm → `force:true` retry, the "no open pay period" 409, dismiss refused while a bounty is paid or frozen, `duplicate_warning`, frozen-credit copy, list error + retry, per-action `busy`) survive by construction because the code moves.

### Task E1: `suggestNames` (pure)

**Files:**
- Create: `client/src/pages/admin/staffHub/reviews/suggestNames.js`
- Create: `client/src/pages/admin/staffHub/reviews/suggestNames.test.js`

**Interfaces:**
- Produces: `suggestNames(excerpt, staff) -> string[]` of user ids (as strings, matching the credit select's value type) whose preferred/display FIRST name appears as a whole word in the excerpt, case-insensitive. Names are regex-escaped.

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/admin/staffHub/reviews/suggestNames.test.js
import { suggestNames } from './suggestNames';

const staff = [
  { id: 7, display_name: 'Shea Corrigan' },
  { id: 8, preferred_name: 'Marcus Webb' },
  { id: 9, display_name: 'Al (Bar) Smith' },      // regex metacharacters in a user-editable name
  { id: 10, email: 'nobody@example.com' },         // no name at all
];

test('whole-word, case-insensitive first-name match', () => {
  expect(suggestNames('It was wonderful! shea was so prompt.', staff)).toEqual(['7']);
  expect(suggestNames('Marcus kept the line moving and Shea built the menu', staff)).toEqual(['7', '8']);
});

test('no partial-word matches; empty excerpt suggests nobody; names with metacharacters never throw', () => {
  expect(suggestNames('Sheamus was great', staff)).toEqual([]);
  expect(suggestNames('', staff)).toEqual([]);
  expect(() => suggestNames('Al was here', staff)).not.toThrow();
  expect(suggestNames('Al was here', staff)).toEqual(['9']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/staffHub/reviews/suggestNames.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// client/src/pages/admin/staffHub/reviews/suggestNames.js
// Client-side only. A suggestion is a pre-filled, removable chip; it is never
// PATCHed on render and becomes a credit only when the admin confirms (spec
// §7). The server keeps validating credit user ids against active staff.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function suggestNames(excerpt, staff) {
  const text = String(excerpt || '');
  if (!text) return [];
  const out = [];
  for (const s of staff || []) {
    const full = (s.display_name || s.preferred_name || '').trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    if (!first) continue;
    const re = new RegExp(`(^|[^A-Za-z])${escapeRe(first)}(?=$|[^A-Za-z])`, 'i');
    if (re.test(text)) out.push(String(s.id));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: the same command. Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/staffHub/reviews/suggestNames.js client/src/pages/admin/staffHub/reviews/suggestNames.test.js
git commit -m "feat(reviews): client-side name suggestions from the excerpt, regex-escaped"
```

### Task E2: move the pieces out of `StaffReviews.js`

**Files:**
- Create: `client/src/pages/admin/staffHub/reviews/LogReviewForm.js` (from `LogReviewForm`, `StaffReviews.js:164`)
- Create: `client/src/pages/admin/staffHub/reviews/PendingReviewCard.js` (from `ReviewCard`, `:229`)
- Create: `client/src/pages/admin/staffHub/reviews/AwardDialog.js` (from `AwardDialog`, `:534`)
- Create: `client/src/pages/admin/staffHub/reviews/ContestRail.js` (from `LeaderboardTab`, `:351`, with `QUARTER_RE` at `:349`)
- Create: `client/src/pages/admin/staffHub/reviews/ResolvedTable.js` (new)

**Interfaces:**
- `LogReviewForm({ open, onClose, onCreated(dupWarning), onError })`: the existing form, rendered inside a modal shell identical to `AwardDialog`'s (fixed scrim, Escape closes) so the hub header's "Log a Google review" action can open it.
- `PendingReviewCard({ review, staff, bountyCents, openPeriod, onChanged, onError })`: the existing `ReviewCard` with (a) the `<select multiple>` replaced by a chip row + "+ Add a name" `<select>` that appends, (b) initial `selected` = saved credits if any, else `suggestNames(review.excerpt, staff)` with the caption "Suggested from the excerpt" shown while any selected id is a suggestion and not yet saved, (c) the conditional Confirm label below. Credits still save through PATCH exactly as today (the "Save names" button stays, enabled when dirty); Confirm is disabled while dirty, with the hint "Save names first", so a suggested chip can never be confirmed without an explicit save.
- `ContestRail({ onAwarded, openPeriod, pendingNames })`: `LeaderboardTab` unchanged in logic, restyled as a rail. `openPeriod` is the hub summary's `open_period`; when it is not `exists && status === 'open'`, the "Award the quarter" button is disabled with the inline reason "No open pay period. Open one before awarding." (the server's own 409 for that case stays as the backstop and still surfaces through the existing toast). The rail shows: the quarter input, floor sentence, standings as a compact list (name, "{named} of {events}", eligible chip), the "if it ended today" sentence built from `shares` (server truth), "Award the quarter" + `AwardDialog`, and a three-step "How review money works" explainer at the bottom. Calls `onAwarded()` after a successful award.
- `ResolvedTable({ reviews, bountyCents })`: table of `status !== 'pending'` rows, columns Date / Review / Credited / Status / Bounty, where Bounty is `fmt$fromCents(bountyCents * credits.length)` for confirmed five-star rows with credits, "no bounty" for confirmed rows without, and "—" for dismissed; plus a `waiting` marker (see E3) rendered as "{amount} · waiting for an open period".

- [ ] **Step 1: Move `LogReviewForm`**

Create the file with the `LogReviewForm` function copied verbatim from `StaffReviews.js`, then wrap its `<form>` in the modal shell. The modal shell (copy the outer two `<div>`s from `AwardDialog` including the Escape-key effect) takes `open` and `onClose`; when `!open` return `null`. Keep the submit logic identical (date required, stars 1..5, excerpt ≤ 2000, POST `/admin/staff-reviews`, `onCreated(!!res.data?.duplicate_warning)`). Imports: `React, { useEffect, useState }`, `api`.

- [ ] **Step 2: Move `AwardDialog`**

Copy verbatim into `AwardDialog.js` with `export default`. Imports: `React, { useEffect }`, `fmt$fromCents`.

- [ ] **Step 3: Move `LeaderboardTab` → `ContestRail`**

Copy `QUARTER_RE`, `currentQuarter`, and the `LeaderboardTab` body verbatim into `ContestRail.js` as `export default function ContestRail({ onAwarded, openPeriod, pendingNames = [] })`. Add `const openNow = !!(openPeriod && openPeriod.exists && openPeriod.status === 'open');` and change the Award button to `disabled={!validQuarter || loading || shares.length === 0 || !openNow}`, rendering `{!openNow && <span className="muted tiny">No open pay period. Open one before awarding.</span>}` beside it. Keep `award()` exactly (the 409 → `window.confirm` → `force:true` retry; `awarded_already` toast). After `load(quarter)` in the success path add `if (onAwarded) onAwarded();`. Restyle the render only: the outer `.card` with the quarter input and floor sentence stays; the standings table becomes:

```jsx
      {validQuarter && !loading && !error && rows.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>{quarter} contest</h3><span className="k">{fmt$fromCents(data.pot_cents)} pot</span></div>
          <div className="card-body vstack" style={{ gap: 6 }}>
            {rows.map(r => (
              <div key={r.user_id} className="hstack" style={{ gap: 8, fontWeight: r.eligible ? 500 : 400 }}>
                <EntityLink to={`/staffing/users/${r.user_id}`}>{r.name}</EntityLink>
                <span className="muted tiny">{r.named_five_stars} of {r.events_worked}</span>
                <span className="spacer" />
                {r.eligible ? <StatusChip kind="ok">qualifies</StatusChip> : <span className="muted tiny">below the floor</span>}
              </div>
            ))}
            {shares.length > 0 && (
              <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                {data.in_progress ? 'Quarter still running. If it ended today, ' : 'Quarter closed: '}
                {shares.map(s => s.name).join(shares.length === 2 ? ' and ' : ', ')} {shares.length === 1 ? 'takes' : 'split'} the pot.
              </p>
            )}
          </div>
        </div>
      )}
```

Keep the "Award the quarter" button and `AwardDialog` wiring; keep the error + Retry card. The empty copy (`rows.length === 0`) is "No qualifiers yet." plus the spec's floor pointer when a pending review already names someone. The k-of-min numbers live in the rail's own leaderboard payload, so the rail derives the sentence itself from a `pendingNames` prop (string array: the first pending review's SAVED credit names, `[]` when none):

```jsx
      {validQuarter && !loading && !error && rows.length === 0 && (
        <div className="card"><div className="card-body muted">
          No qualifiers yet.
          {pendingNames.length > 0 && data && (() => {
            const row = (data.rows || []).find(r => r.name === pendingNames[0]);
            const k = (row ? Number(row.named_five_stars) : 0) + 1;
            return <> Confirming the pending review puts {pendingNames[0]} {k} of {data.min_named_five_stars} toward the floor.</>;
          })()}
        </div></div>
      )}
```

(The leaderboard endpoint returns every staffer with activity, eligible or not, so the name lookup works even at zero qualifiers; a name with no row starts at 1.) Append the explainer card:

```jsx
      <div className="card">
        <div className="card-head"><h3>How review money works</h3></div>
        <div className="card-body">
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>Thumbtack reviews land here on their own. Log Google reviews by hand.</li>
            <li>Name who earned it. Five stars with a name carries the bounty.</li>
            <li>Confirm writes the bounty line to the open pay run. Each quarter, the most reviewed split the pot.</li>
          </ol>
        </div>
      </div>
```

Imports: `React, { useCallback, useEffect, useMemo, useState }`, `api`, `useToast`, `EntityLink`, `StatusChip`, `fmt$fromCents`, `AwardDialog`.

- [ ] **Step 4: Move `ReviewCard` → `PendingReviewCard`**

Copy `ReviewCard` and `statusKind` verbatim, then apply the three changes named in Interfaces:

(a) Initial selection:

```js
  const saved = useMemo(() => (review.credits || []).map(c => String(c.user_id)), [review.credits]);
  const suggested = useMemo(() => (saved.length ? [] : suggestNames(review.excerpt, staff)), [saved, review.excerpt, staff]);
  const initial = saved.length ? saved : suggested;
  const [selected, setSelected] = useState(initial);
  useEffect(() => { setSelected(initial); }, [initial]);
  const dirty = useMemo(() => selected.length !== saved.length || selected.some(id => !saved.includes(id)), [selected, saved]);
  const showSuggestionCaption = !saved.length && suggested.length > 0 && selected.some(id => suggested.includes(id));
```

(b) Chip row replacing the `<select multiple>`:

```jsx
          <div style={{ flex: '1 1 280px' }}>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Named staff</div>
            <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
              {selected.map(id => {
                const s = staff.find(x => String(x.id) === id);
                return (
                  <span key={id} className="chip">
                    {s ? (s.display_name || s.preferred_name || s.email) : `user ${id}`}
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${s ? (s.display_name || s.preferred_name) : id}`}
                      onClick={() => setSelected(sel => sel.filter(x => x !== id))}>×</button>
                  </span>
                );
              })}
              <select value="" onChange={e => { const v = e.target.value; if (v && !selected.includes(v)) setSelected(sel => [...sel, v]); }}>
                <option value="">{staff.length >= 100 ? '+ Add a name (first 100 staff shown)' : '+ Add a name'}</option>
                {staff.filter(s => !selected.includes(String(s.id))).map(s => (
                  <option key={s.id} value={String(s.id)}>{s.display_name || s.preferred_name || s.email}</option>
                ))}
              </select>
            </div>
            {showSuggestionCaption && <div className="tiny muted" style={{ marginTop: 4 }}>Suggested from the excerpt. Save names to keep them.</div>}
          </div>
```

(c) Conditional Confirm copy and the dirty guard:

```js
  const stars5 = Number(review.stars) === 5;
  const bountyTotal = stars5 ? bountyCents * saved.length : 0;
  const openNow = !!(openPeriod && openPeriod.exists && openPeriod.status === 'open');
  const confirmLabel = busy === 'confirm' ? 'Confirming…'
    : !stars5 || saved.length === 0 ? 'Confirm, no bounty'
    : openNow ? `Confirm and pay ${fmt$fromCents(bountyTotal)}`
    : `Confirm, ${fmt$fromCents(bountyTotal)} waits for the next open run`;
```

Confirm button: `disabled={busy !== null || dirty}` with `title={dirty ? 'Save names first' : undefined}` and label `{confirmLabel}`. Keep Dismiss as is. Replace the two footer hint `<p>`s with one: `stars5 ? 'Confirming pays each named staffer the bounty into the open pay run, or the next one to open.' : 'Only five-star reviews carry a bounty.'`

Imports add `suggestNames` and `fmt$fromCents`; the `select` attribute `multiple` and `size` are gone. Export default.

- [ ] **Step 5: Write `ResolvedTable.js`**

```js
// client/src/pages/admin/staffHub/reviews/ResolvedTable.js
import React from 'react';
import EntityLink from '../../../../components/EntityLink';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../../components/adminos/format';

const statusKind = (s) => (s === 'confirmed' ? 'ok' : s === 'dismissed' ? 'warn' : 'accent');

export default function ResolvedTable({ reviews, bountyCents, waitingIds }) {
  const rows = (reviews || []).filter(r => r.status !== 'pending');
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head"><h3>Resolved</h3><span className="k">{rows.length}</span></div>
      {rows.length === 0 ? (
        <div className="card-body muted">Nothing resolved yet. Confirmed and dismissed reviews collect here as rows.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Review</th><th>Credited</th><th>Status</th><th className="num">Bounty</th></tr></thead>
            <tbody>
              {rows.map(r => {
                const credits = r.credits || [];
                const paysBounty = r.status === 'confirmed' && Number(r.stars) === 5 && credits.length > 0;
                const waiting = waitingIds && waitingIds.has(r.id);
                return (
                  <tr key={r.id}>
                    <td className="muted">{fmtDate(String(r.review_date || '').slice(0, 10))}</td>
                    <td>
                      <span>{'★'.repeat(Number(r.stars) || 0)}</span>{' '}
                      <span className="muted tiny">{r.source}</span>{' '}
                      <span title={r.excerpt || ''}>{r.excerpt ? `"${r.excerpt.length > 60 ? `${r.excerpt.slice(0, 60)}…` : r.excerpt}"` : <span className="muted">no excerpt</span>}</span>
                    </td>
                    <td>{credits.length ? credits.map((c, i) => (
                      <React.Fragment key={c.user_id}>{i > 0 && ', '}<EntityLink to={`/staffing/users/${c.user_id}`}>{c.name}</EntityLink></React.Fragment>
                    )) : <span className="muted">no staffer named</span>}</td>
                    <td><StatusChip kind={statusKind(r.status)}>{r.status}</StatusChip></td>
                    <td className="num">
                      {r.status === 'dismissed' ? '—' : paysBounty
                        ? <>{fmt$fromCents(bountyCents * credits.length)}{waiting && <span className="muted tiny"> · waiting for an open period</span>}</>
                        : <span className="muted">no bounty</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: RTL tests for the two changed money-path behaviors**

The move preserves logic by construction, but E2 CHANGES two things on the confirm path (the writer of `payout_duty_lines`), so each gets a test in `client/src/pages/admin/staffHub/reviews/PendingReviewCard.test.js` (mock `api` as in `StaffHubLayout.test.js`):

```js
test('Confirm is disabled while names are dirty, with the save-first hint', async () => {
  // render with review {status:'pending', stars:5, credits:[]} and staff [{id:7, display_name:'Shea Corrigan'}]
  // excerpt naming Shea -> suggestion pre-fills, dirty=true
  // expect the Confirm button disabled with title 'Save names first'
  // click Save names (mock PATCH resolves), then expect Confirm enabled
});

test('confirm resolving materialized:0 reports it through onChanged', async () => {
  // saved credit present (credits:[{user_id:7,name:'Shea'}]), api.post resolves { data: { materialized: 0 } }
  // click Confirm; expect onChanged called with { reviewId, materialized: 0, bountyEligible: true }
});
```

(Write the real renders and mocks; the comments are the shape.) Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/staffHub/reviews/PendingReviewCard.test.js`.

- [ ] **Step 7: Build gate and checkpoint**

Run: `cd client && CI=true npx react-scripts build` (the new files are not imported yet; CRA does not fail on unimported files, but each must compile). Commit:

```bash
git add client/src/pages/admin/staffHub/reviews/
git commit -m "refactor(reviews): move the review log and leaderboard pieces into staffHub/reviews; confirm-path tests"
```

### Task E3: `ReviewsPage` composes them; swap the route; delete `StaffReviews.js`

**Files:**
- Create: `client/src/pages/admin/staffHub/reviews/ReviewsPage.js`
- Modify: `client/src/App.js` (lazy import + the `/staffing/reviews` route element)
- Delete: `client/src/pages/admin/StaffReviews.js`

**Interfaces:**
- Consumes: `useOutletContext()` → `{ summary, refresh, setActions }`; `GET /admin/staff-reviews` envelope (A6); `GET /admin/active-staff?limit=100`.

- [ ] **Step 1: Write `ReviewsPage.js`**

```js
// client/src/pages/admin/staffHub/reviews/ReviewsPage.js
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { fmt$fromCents } from '../../../../components/adminos/format';
import LogReviewForm from './LogReviewForm';
import PendingReviewCard from './PendingReviewCard';
import ResolvedTable from './ResolvedTable';
import ContestRail from './ContestRail';

/**
 * Reviews, a Staff hub child (spec §7): no internal tabs. Pending reviews are
 * workbench cards, resolved ones are table rows, the contest is a rail. The
 * bounty figure and the all-time totals come from the list envelope; the page
 * embeds no dollar literal.
 */
export default function ReviewsPage() {
  const toast = useToast();
  const { summary, refresh, setActions } = useOutletContext() || {};
  const [reviews, setReviews] = useState([]);
  const [staff, setStaff] = useState([]);
  const [meta, setMeta] = useState({ bounty_cents: 0, bounties_paid_cents: 0, total_logged: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Review ids whose confirm returned materialized:0 this session (bounty
  // waiting for an open period). The server has no such flag on the row; the
  // resolved table shows the marker until the next reload proves otherwise.
  const [waitingIds, setWaitingIds] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, roster] = await Promise.all([
        api.get('/admin/staff-reviews'),
        api.get('/admin/active-staff?limit=100'),
      ]);
      setReviews(list.data?.reviews || []);
      setMeta({
        bounty_cents: Number(list.data?.bounty_cents) || 0,
        bounties_paid_cents: Number(list.data?.bounties_paid_cents) || 0,
        total_logged: Number(list.data?.total_logged) || 0,
      });
      setStaff(roster.data?.staff || []);
    } catch (err) {
      setError(err?.message || 'Failed to load reviews.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!setActions) return undefined;
    setActions(<button type="button" className="btn btn-primary" onClick={() => setLogOpen(true)}>Log a Google review</button>);
    return () => setActions(null);
  }, [setActions]);

  const changed = useCallback((result) => {
    if (result && result.reviewId && result.materialized === 0 && result.bountyEligible) {
      setWaitingIds(s => new Set([...s, result.reviewId]));
      toast.success('Confirmed. The bounty waits for the next open pay run.');
    }
    load();
    if (refresh) refresh();
  }, [load, refresh, toast]);

  const pending = useMemo(() => reviews.filter(r => r.status === 'pending'), [reviews]);

  if (loading && reviews.length === 0) return <div className="muted">Loading…</div>;
  if (error) {
    return (
      <div className="card"><div className="card-body">
        <p style={{ marginTop: 0 }}>{error}</p>
        <button type="button" className="btn" onClick={load}>Retry</button>
      </div></div>
    );
  }

  return (
    <>
      <LogReviewForm open={logOpen} onClose={() => setLogOpen(false)}
        onCreated={(dup) => { setDuplicateWarning(dup); setLogOpen(false); changed(); }}
        onError={(msg) => toast.error(msg)} />

      <div className="muted tiny" style={{ marginBottom: 12 }}>Thumbtack reviews arrive on their own · log Google reviews by hand</div>

      {duplicateWarning && (
        <div className="card" style={{ marginBottom: 'var(--gap)', borderColor: 'hsl(var(--warn-h) var(--warn-s) 50%)' }}>
          <div className="card-body"><strong>Possible duplicate.</strong>{' '}A Thumbtack review is already logged for that date. Check the list below before confirming both.</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)', alignItems: 'start' }}>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {pending.map(r => (
            <PendingReviewCard key={r.id} review={r} staff={staff}
              bountyCents={meta.bounty_cents} openPeriod={summary?.open_period || null}
              onChanged={changed} onError={(msg) => toast.error(msg)} />
          ))}
          <ResolvedTable reviews={reviews} bountyCents={meta.bounty_cents} waitingIds={waitingIds} />
          <p className="tiny muted" style={{ margin: 0 }}>
            All time: {meta.total_logged} logged · {fmt$fromCents(meta.bounties_paid_cents)} in bounties paid · bounty is {fmt$fromCents(meta.bounty_cents)} flat, five stars with a name required.
          </p>
        </div>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ContestRail openPeriod={summary?.open_period || null}
            pendingNames={pending.length ? (pending[0].credits || []).map(c => c.name) : []}
            onAwarded={() => { if (refresh) refresh(); }} />
        </div>
      </div>
    </>
  );
}
```

`PendingReviewCard.onChanged` must pass `{ reviewId, materialized, bountyEligible }` after a confirm: in its `run('confirm', ...)`, capture the POST response and call `onChanged({ reviewId: review.id, materialized: Number(res.data?.materialized), bountyEligible: stars5 && saved.length > 0 })`; the other actions call `onChanged()` with no argument. Update the `run` helper so the wrapped fn's return value is forwarded.

Add the narrow-screen stack: append to `index.css` (sh-g may restyle, but the rule is needed now):

```css
@media (max-width: 900px) {
  html[data-app="admin-os"] .reviews-grid { grid-template-columns: minmax(0, 1fr); }
}
```

and give the grid `div` above `className="reviews-grid"`.

- [ ] **Step 2: Swap the route and delete the old page**

`App.js`: replace `const StaffReviews = lazy(() => import('./pages/admin/StaffReviews'));` with `const ReviewsPage = lazy(() => import('./pages/admin/staffHub/reviews/ReviewsPage'));` and the route element `<StaffReviews />` → `<ReviewsPage />`. Then `git rm client/src/pages/admin/StaffReviews.js`. Grep: `grep -rn "StaffReviews" client/src` returns nothing.

- [ ] **Step 3: Verify**

Run: `cd client && CI=true npx react-scripts build`. Dev app `/staffing/reviews`, walking the moved behaviors BY NAME (they moved, so each gets one look): (1) the one pending Thumbtack review renders as a card with "Shea Corrigan" pre-filled and the suggestion caption; Save names enables Confirm; (2) on a weekday with no open period the Confirm label reads "Confirm, $10.00 waits for the next open run" and the rail's Award button is disabled with the no-open-period reason; (3) log a manual review dated the same day as the Thumbtack one and see the duplicate warning card; (4) the quarter input rejects a half-typed value (type `2026-Q` and see the hint, no fetch); (5) with a dev-DB review whose bounty is paid, Dismiss is refused with the server's message; (6) every button disables while its action is in flight (throttle the network to see it); (7) "Log a Google review" opens from the hub header; the hub badge and sidebar badge drop after a confirm without waiting for the poll. The `QUARTER_IN_PROGRESS` force-retry is covered by reading `ContestRail`'s `award()` diff against the old `StaffReviews.js:403-408` (byte-identical logic) rather than by firing a real award on dev. Do NOT confirm the real prod review; dev rows only (dev shares the dev DB, not prod).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/staffHub/reviews/ReviewsPage.js client/src/pages/admin/staffHub/reviews/PendingReviewCard.js client/src/App.js client/src/index.css
git rm -q client/src/pages/admin/StaffReviews.js
git commit -m "feat(reviews): hub child with pending cards, resolved table, contest rail; StaffReviews.js retired"
```

**Lane sh-e done when:** E1–E3 committed; build green; `ui-ux-review` against artboards 1h/1i (override: the third "waiting" state, and the floor reads from the payload, 4 events not 5).

# Lane sh-f-feedback

**Before cutting this lane (read this first, 2026-08-19):**
- Cut the sh-f worktree from **main**, and only after `sh-e-reviews` has merged, which it now has (`157becf2`). sh-e edits `client/src/App.js` too (it swapped the `StaffReviews` lazy import for `ReviewsPage` and the `reviews` child route), and this lane now owns two other hunks of the same file. Do not branch sh-f from `a5db2548`.
- Main deliberately ships a live `/tips` route to `TipsAdmin.js` right now. Commit `b114e9f0` restored the lazy import at `App.js:151-155` and the route at `App.js:646`, and reverted Task A8's alert-email re-point in `server/routes/publicTip.js`, because the hub retired those surfaces before their replacements existed. This lane is what finishes them. The plan text below was corrected on 2026-08-19 to match main; the older "B4 already did it" claims were false and are gone.
- This lane is no longer client-only: it owns `server/routes/publicTip.js` and `server/routes/publicTip.test.js` (front-matter). `publicTip.js` is not on `scripts/sensitive-paths.txt`, so the declared `review_fleet` stands.

### Task F1: `FeedbackCard` on the profile's Tip Page tab; retire `TipsAdmin.js`

**Files:**
- Create: `client/src/pages/admin/userDetail/tabs/FeedbackCard.js` (donor: `FeedbackTab` + `ratingKind` in `TipsAdmin.js:179-288`)
- Modify: `client/src/pages/admin/userDetail/tabs/TipPageTab.js` (render the card at the bottom of the main column, admins only)
- Delete: `client/src/pages/admin/TipsAdmin.js`
- Modify: `client/src/App.js` (`:151-155` the b114e9f0 comment block plus the `TipsAdmin` lazy import, and `:646` the `/tips` route). CORRECTED 2026-08-19: this file was previously described as already clean because of B4. It is not; `b114e9f0` restored both, so this lane owns them.
- Modify: `server/routes/publicTip.js` and `server/routes/publicTip.test.js` (Task A8, moved into this lane because its result was reverted on main and sh-a-server is closed)
- Modify: `README.md` (folder tree + prose mentions)

**Interfaces:**
- Consumes: `GET /admin/tip-feedback?target_user_id=<id>&status=all` (A5), `POST /admin/tip-feedback/:id/review`.
- Produces: `FeedbackCard({ userId })`, rendered only when `useAuth().user.role === 'admin'`.

- [ ] **Step 1: Write `FeedbackCard.js`**

The snippet's 1-3 rating scale is a deliberate CORRECTION of the donor, not a copy: `TipsAdmin.js:245` renders `{f.rating}/5` and `:282-288` branches on a four-step 1-5 ladder, but `schema.sql:2659` is `rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 3)` and `publicTip.js:193` rejects anything outside 1-3, so on the live page a best-possible 3 renders as "3/5" with an `accent` chip. Do not restore fidelity to the donor here, and reviewers should not flag the divergence.

```js
// client/src/pages/admin/userDetail/tabs/FeedbackCard.js
import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import StatusChip from '../../../../components/adminos/StatusChip';

// Guest feedback left on this bartender's tip thank-you page (spec §9). Per-
// person, so it lives on the profile; the server also emails the inbox on
// every submission. Endpoints are adminOnly: the parent renders this card for
// admins only, so a manager never sees a 403 card.
// tip_page_feedback.rating is 1..3 by DB CHECK (schema.sql:2659): 3 = good.
function ratingKind(rating) {
  const r = Number(rating);
  if (r >= 3) return 'ok';
  if (r >= 2) return 'warn';
  return 'danger';
}

export default function FeedbackCard({ userId }) {
  const toast = useToast();
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(false);
    api.get(`/admin/tip-feedback?status=all&target_user_id=${encodeURIComponent(userId)}`)
      .then(r => setFeedback(r.data?.feedback || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  async function markReviewed(id) {
    setBusyId(id);
    try { await api.post(`/admin/tip-feedback/${id}/review`); load(); }
    catch (err) { toast.error(err?.message || 'Failed to mark reviewed.'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Feedback</h3><span className="k">{feedback.length}</span></div>
      <div className="card-body vstack" style={{ gap: 12 }}>
        {loading && <div className="muted">Loading…</div>}
        {!loading && error && (
          <div className="hstack" style={{ gap: 8 }}><span className="muted">Could not load feedback.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div>
        )}
        {!loading && !error && feedback.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>No feedback yet. Guests can leave a rating and a note from this bartender's thank-you page; each one also emails the inbox.</p>
        )}
        {!loading && feedback.map(f => (
          <article key={f.id} style={{ borderTop: '1px solid var(--line-1)', paddingTop: 10 }}>
            <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
              <StatusChip kind={ratingKind(f.rating)}>{f.rating}/3</StatusChip>
              {f.reviewed_at && <span className="muted tiny">reviewed</span>}
              <span className="spacer" />
              <span className="muted tiny">{f.created_at ? new Date(f.created_at).toLocaleString('en-US', { hour12: false }) : '—'}</span>
            </div>
            {f.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>"{f.comment}"</p> : <p className="muted" style={{ margin: '6px 0 0' }}>No comment.</p>}
            {f.submitter_email && <p className="muted tiny" style={{ margin: '6px 0 0' }}>Customer: {f.submitter_email}</p>}
            {!f.reviewed_at && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busyId === f.id} onClick={() => markReviewed(f.id)}>
                  {busyId === f.id ? 'Marking…' : 'Mark reviewed'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it in `TipPageTab.js`**

Import `FeedbackCard` and `useAuth` (`../../../../context/AuthContext`). Inside the component: `const { user: viewer } = useAuth();`. In the main column `vstack` (the first child of the grid, `TipPageTab.js:92`), after the last existing card in that column, add `{viewer?.role === 'admin' && <FeedbackCard userId={userId} />}`.

- [ ] **Step 3: Retire `TipsAdmin.js` (App.js first, then the delete)**

CORRECTED 2026-08-19: this step used to say "`grep -rn \"TipsAdmin\" client/src` → nothing (B4 already removed the lazy import and route)". That was true only between the `sh-b-shell` merge (`2d925e15`, 19:06 on 2026-08-19) and commit `b114e9f0` (20:27 the same evening). Commit `b114e9f0` restored both, so today `git grep -n -e TipsAdmin -e StaffReviews -- client/src README.md` returns `App.js:155`, `App.js:646`, `TipsAdmin.js:18`, `README.md:599`, `:825`, `:828`. The App.js edits come FIRST: deleting the file with the import still standing is a module-resolution failure under `CI=true react-scripts build`, which is this task's own gate.

(a) `client/src/App.js:151-155`: delete the four-line `b114e9f0` rationale comment ("Kept reachable until the staff-hub lanes that replace it land...") together with `const TipsAdmin = lazy(() => import('./pages/admin/TipsAdmin'));`. Leaving the import with no route is an unused-var warning, which `CI=true` also fails.

(b) `client/src/App.js:646`: replace `<Route path="/tips" element={<TipsAdmin />} />` with the param-preserving redirect B4 specified. `LegacyRedirect` is still defined at `App.js:288` and still merges `URLSearchParams` over `defaults`, and sh-d's `PayrollPage` TABS carries `{ id: 'tips' }`, so the target tab is real:

```jsx
        <Route path="/tips" element={<LegacyRedirect to="/staffing/payroll" defaults={{ tab: 'tips' }} />} />
```

(c) Only now `git rm client/src/pages/admin/TipsAdmin.js`.

(d) `README.md` (line numbers verified on main 2026-08-19; the old `:597`/`:821`/`:824` citations had drifted, and the file moves, so re-check with `git grep`): the client folder tree is ONE long line at `:599`, so strike the phrases `TipsAdmin tip overview` and `StaffReviews review log + quarterly contest at /reviews` from it and append `payroll/TipsLedger.js`, `payroll/tipStatus.js`, `payroll/CurrentWeekCard.js` to that line's payroll cluster plus `userDetail/tabs/FeedbackCard.js`. Extend the `staffHub/` tree entry at `:602-603` with the `reviews/` children (`ReviewsPage`, `PendingReviewCard`, `LogReviewForm`, `ResolvedTable`, `ContestRail`, `AwardDialog`, `suggestNames`): sh-c, sh-d and sh-e touched no doc files, so this lane documents theirs. Rewrite the prose at `:825` (guest feedback is reviewed on the staffer profile's Tip Page tab) and at `:828` (name the Tip Page tab with its Feedback card, and the Payroll › Tips ledger). Leave `README.md:194` alone: that is the SERVER route line for `contractorTipPage.js`'s `/tip-feedback` and it stays true.

- [ ] **Step 4: Re-point the feedback alert email (this is Task A8, moved here)**

A8 shipped with sh-a-server (`c4bb2d1f`) and `b114e9f0` reverted it. sh-a is merged and closed, so no open lane owned it; it is this lane's now. It lands in the SAME commit as `FeedbackCard.js`, never before it: moving the email ahead of the surface that shows the feedback is precisely the mistake `b114e9f0` was written to undo. Do this after Steps 1 and 2, not first.

(a) `server/routes/publicTip.js:227-233`: replace the six-line "move it when the card exists, not before" comment and the `adminUrl: ${ADMIN_URL}/tips#feedback` line with

```js
      // The FeedbackCard on the staffer profile's Tip Page tab renders this feedback (F1).
      adminUrl: `${ADMIN_URL}/staffing/users/${row.user_id}?tab=tip-page`,
```

(`row.user_id` is the bartender the feedback targets and is already in scope at `:211`/`:218`; `tip-page` is a real profile tab id, `AdminUserDetail.js:36-39`, read from the query string by `useUrlListState.js:20-28`.)

(b) `server/routes/publicTip.test.js:382-410` must be INVERTED, not merely extended. The test `POST /api/public/tip/:token/feedback > the admin email links a page that shows the feedback` currently asserts the email blob CONTAINS `${ADMIN_URL}/tips#feedback` (`:400-406`) and asserts it does NOT contain `/staffing/users/${userIdA}?tab=tip-page` (`:407-410`): the negative assertion forbids exactly the destination this step wants. Drop the `b114e9f0` comment block at `:382-388`, set `expected` to the profile url, and turn the negative assertion around so `/tips#feedback` is the forbidden string.

Run: `node -r dotenv/config --test server/routes/publicTip.test.js` from the repo root, alone (server tests share the dev DB, one at a time). Expected: 17 tests green.

- [ ] **Step 5: Verify and commit**

Run: `cd client && CI=true npx react-scripts build`. Run the publicTip suite from Step 4 again if anything moved. Dev app as admin: a staffer profile › Tip Page shows the Feedback card with the empty copy; as a manager the card is absent; `/tips` lands on `/staffing/payroll?tab=tips`.

```bash
git add client/src/pages/admin/userDetail/tabs/FeedbackCard.js client/src/pages/admin/userDetail/tabs/TipPageTab.js client/src/App.js server/routes/publicTip.js server/routes/publicTip.test.js README.md
git rm -q client/src/pages/admin/TipsAdmin.js
git commit -m "feat(profile): guest feedback card on the Tip Page tab (admins); TipsAdmin.js retired and the alert email follows it"
```

**Lane sh-f done when:** F1 committed; client build green; the publicTip suite green; `git grep -n -e TipsAdmin -e StaffReviews -- client/src README.md` is empty (plain `grep` and `find` exit with "claude native binary not installed" in this shell, `git grep` works).

# Lane sh-g-fidelity

**Before cutting this lane (2026-08-19):** the spec §3 override lines this lane is judged against are added to `docs/superpowers/specs/2026-08-19-admin-staff-hub-design.md` ON MAIN, in os, as one commit, BEFORE the sh-g worktree is cut. Never from inside the lane: `scripts/guard-os-main.sh:12-14` blocks any commit that stages a path under `docs/superpowers/(specs|plans)/` from a non-main branch, and `docs/superpowers/**` is deliberately absent from sh-g's footprint because the guard would reject it anyway. Cut sh-g against that HEAD, so the override list the reviewer uses as its exception list is the current one. The same guard means this plan file cannot be edited from the lane either.

### Task G1: pull the live artifact, fold CSS, review every screen against it

**Files:**
- Modify: `client/src/index.css` (only the hub/roster/hiring/payroll/reviews rules this project added)
- Modify: `docs/design-artifacts/2026-08-19-staff-hub.dc.html` (refresh the snapshot if the design session moved)
- Modify: the component files this lane fixes in place, which the footprint already covers and this block used to omit: `StaffDashboard.js`, `HiringDashboard.js`, `payroll/PayrollPage.js`, `payroll/TipsLedger.js`, `payroll/UnassignedTipsPanel.js`, `payroll/DeferredTipsPanel.js`, `payroll/HistoryView.js`, `staffHub/reviews/ContestRail.js`, `staffHub/reviews/PendingReviewCard.js` (full paths in the Step 4 pathspec)

- [ ] **Step 1: Refresh the benchmark**

`DesignSync list_files` on project `96291c7a-3510-4910-9c67-c41d81504920`, `get_file` `Staff Hub.dc.html`; if its content differs from the vendored snapshot, overwrite the snapshot and commit it (`docs: refresh staff-hub artifact`). The `<style>` block's rules marked "ships verbatim" are the CSS truth.

- [ ] **Step 2: Diff the shipped CSS against the artifact**

For every rule in the artifact's hub/hire/roster-sect block, confirm the same declarations exist under the `html[data-app="admin-os"]` prefix in `index.css` (B3 appended them; sh-c/d/e may have added local inline styles that should be promoted to classes where the artifact names one). Promote, do not duplicate.

- [ ] **Step 3: Run `ui-ux-review` against the artifact, per screen**

Two verdict kinds, and every screen below carries the one it gets:
- **Artboard fidelity:** an artboard draws this screen, so structure, class vocabulary and token names are compared against it directly.
- **Design-system vocabulary:** no artboard draws this screen, so it is judged against the design system's card / table / chip / toolbar vocabulary and the hub chrome around it, never against an artboard invented for the occasion.

Artboard-fidelity screens: Roster 1a (After Hours) / 1b (House Lights, `?tab=deactivated`) / 1c (empty: point the review at a dev account with zero approved staff, or at the JSX if none exists); Hiring 1d; Payroll pay run 1e/1f (both skins); Payroll tips 1g/1g2; Reviews 1h/1i; the sidebar in 1a.

Design-system-vocabulary screens (items 1 to 5 were added 2026-08-19; with the `/tips` precondition below, they are the six live surfaces the old list omitted, all of them rendering inside hub chrome with no artboard):
1. `/staffing/payroll?tab=history`, `payroll/HistoryView.js` (169 lines), which now renders under `.hub-head` and has never been reviewed inside the hub. Fix while you are in there: `HistoryView.js:100` writes the period window with an en dash where the hub's vocabulary is "{Mon D} to {D}" (`hubSubtitle.js:17-22`).
2. `/staffing/payroll?tab=tax`, `payroll/TaxTotalsTab.js` (208 lines), never drawn and never reviewed.
3. The manager hub: `StaffHubLayout.js:79` hides the entire `.hub-tabs` strip when only one child is visible, and `hubSubtitle.js:30` collapses the subtitle to "{n} active". No artboard shows a hub with no tab strip.
4. The summary-failure state: `StaffHubLayout.js:70-75` renders a SECOND `.page-subtitle` carrying "Counts unavailable." plus a ghost Retry, which spec §10 requires and no artboard draws.
5. The four modals that children now open over hub chrome: `staffHub/reviews/LogReviewForm.js`, `staffHub/reviews/AwardDialog.js`, `components/adminos/InterviewScheduleModal.js` (opened by Hiring) and `userDetail/components/AssignToEventModal.js` (opened by the Roster). The last two are OUTSIDE this lane's footprint: they get a verdict, and any fix is a follow-up, never a silent edit.
6. The profile Tip Page tab's `FeedbackCard` (built in sh-f), same treatment.

Precondition, not a finding: `/tips` renders `TipsAdmin.js` with the hand-rolled inline-styled TabButtons that spec §3 declares retired. sh-f deletes that file, and this lane `depends_on: sh-f-feedback`, so by the time sh-g runs `/tips` is a redirect. If sh-f has somehow not landed, do NOT flag `/tips`: it is a deliberate interim state (commit `b114e9f0`), not off-design work.

Reading the benchmark: the vendored `.dc.html` does not render standalone. It loads `./support.js` and `_ds/.../_ds_bundle.js`, neither of which is vendored under `docs/design-artifacts/`, so the custom elements are inert and the artboards come up as unstyled markup (every vendored artifact in the repo has this shape). Read the artboard MARKUP and compare structure, class vocabulary and token names, per §3. For a rendered view, open the canvas in design project `96291c7a-3510-4910-9c67-c41d81504920`.

Token law rider for the reviewer: per spec §3, fidelity compares structure and token usage, never resolved hue values; the vendored system is `docs/design-artifacts/_ds/` (project 72035042). The §3 override list is the reviewer's exception list: a deviation on that list is not a finding; any other deviation is.

- [ ] **Step 4: Fix findings, build gate, commit**

Run: `cd client && CI=true npx react-scripts build` (every other client lane in this plan carries this gate; this step used to omit it).

```bash
git add client/src/index.css \
  client/src/pages/admin/StaffDashboard.js \
  client/src/pages/admin/HiringDashboard.js \
  client/src/pages/admin/payroll/PayrollPage.js \
  client/src/pages/admin/payroll/TipsLedger.js \
  client/src/pages/admin/payroll/UnassignedTipsPanel.js \
  client/src/pages/admin/payroll/DeferredTipsPanel.js \
  client/src/pages/admin/payroll/HistoryView.js \
  client/src/pages/admin/staffHub/reviews/ContestRail.js \
  client/src/pages/admin/staffHub/reviews/PendingReviewCard.js \
  docs/design-artifacts/2026-08-19-staff-hub.dc.html
git commit -m "style(staff-hub): fidelity pass against the 2026-08-19 artifact"
```

CORRECTED 2026-08-19: the old pathspec staged only `index.css` and the `.dc.html`, which contradicted this task's own "the lane's footprint now includes the component files" sentence. Every presentation fix a fidelity pass produces (a date format, a missing chip, a spacer, a promote-to-class) lands in a component file the old pathspec would never have staged, and CLAUDE.md forbids a `git add .` recovery, so the lane would have committed half its work. Stage from this list, and only the files you actually changed.

**Lane sh-g done when:** every screen has a `ui-ux-review` verdict on file, both skins on Roster and Payroll, `.hub-tabs` scrolls at 720px with no page-level horizontal scroll. The lane's footprint now includes the component files, so promote-to-class and small structural fixes land here directly; a finding that requires changing BEHAVIOR (not presentation) goes back to the owning lane's scope as a follow-up, never fixed silently inside the fidelity pass.

---

## Merge order and the integration check

1. **DONE.** `sh-a-server` merged at `c4bb2d1f`, `sh-b-shell` at `2d925e15`, and both are already on `origin/main`, so the server endpoint, the hub shell, the sidebar and the redirects are in production. Integration check that belonged to this step: load `/staffing` as admin on dev and confirm the subtitle fills from the real endpoint (`16 active · pay run … · 1 review to confirm` or the day's equivalent).
2. **DONE 2026-08-19.** `sh-c-hiring` merged at `4c279764`, `sh-d-payroll` at `f963b81a`, `sh-e-reviews` at `157becf2`. Each merge is complete, not partial: `git diff main..<branch>` lists none of the lane's own footprint files, only the other lanes' work that branch never had. All three are UNPUSHED as of this edit. The three worktrees under `../worktrees/` are now redundant: retire them with `npm run worktree:rm` (clear each lane's real `node_modules` tree first, per the npm-install-clobbers-symlink rule) and then delete the branches.
3. Merge `sh-f-feedback`. Read its lane preamble first: it now also owns `client/src/App.js`, `server/routes/publicTip.js` and `server/routes/publicTip.test.js`, and its worktree is cut from main after step 2 (done), never from `a5db2548`.
4. Merge `sh-g-fidelity`. The spec §3 override lines go onto main BEFORE that worktree is cut; see the sh-g preamble.
5. Push is a separate, cued step per CLAUDE.md; the push-time sweep re-runs the fleet on the sensitive commits (sh-a).

**Interim state on main until sh-f lands (expected, not a defect):** commit `b114e9f0` deliberately kept `/tips` pointing at `TipsAdmin.js` and kept the tip-feedback alert email on `${ADMIN_URL}/tips#feedback`, because the hub retired both surfaces before their replacements existed. Spec §8 says `/tips` should be a param-preserving redirect; until sh-f lands, that deviation is expected and is NOT a sh-g fidelity finding. One consequence to weigh before the next push: now that sh-d has merged, two cross-staff tip surfaces are live at once and they show different money for the same tips (`TipsAdmin.js:166` renders gross `amount_cents`; `payroll/TipsLedger.js` renders net of refunds and strikes the gross beside it). Landing sh-f before the next push retires the old surface in the same deploy. Pushing sh-c/sh-d/sh-e without it ships that divergence, in which case it has to be named out loud in the push inventory rather than riding along quietly.

## Manual walk before the push cue

- Both skins, desktop, and a 720px-wide window (tabs scroll, page does not).
- Manager login: `/staffing` shows Roster with no tab strip; `/staffing/payroll`, `/staffing/hiring`, `/staffing/reviews` bounce; a manager without `can_staff` sees an empty subtitle and the roster's 403 state.
- Overview payroll card → `/staffing/payroll?tab=payrun&period=<id>` lands on that period. A staffer's Payouts tab links → payroll history with the period. Application detail "Schedule interview" → `/staffing/hiring?schedule=<id>` opens the modal.
- On a weekday before any accrual: the pay-run card names the current week; the subtitle says "open"; no `pay_periods` row appears in the DB after the visits.
- Confirm flow (dev only, a dev review row): label reads "waits for the next open run" when no period is open; after confirm the resolved row shows the waiting marker and the hub + sidebar badges drop without waiting 60s.
