---
lanes:
  - id: ext-core
    footprint:
      - server/db/schema.sql
      - server/utils/proposalMoneyShared.js
      - server/utils/eventEndInstant.js
      - server/utils/eventEndInstant.test.js
      - server/data/extensionTermsCopy.js
      - server/utils/serviceExtensionPricing.js
      - server/utils/serviceExtensionPricing.test.js
      - server/utils/serviceExtensionSettle.js
      - server/utils/serviceExtensionSettle.test.js
      - server/utils/serviceExtensionPayroll.js
      - server/utils/serviceExtensionPayroll.test.js
      - scripts/money-smoke-list.txt
    deps: []
    review: full-fleet
  - id: ext-routes
    footprint:
      - server/routes/serviceExtensions/index.js
      - server/routes/serviceExtensions/create.js
      - server/routes/serviceExtensions/create.test.js
      - server/routes/serviceExtensions/publicAccept.js
      - server/routes/serviceExtensions/publicAccept.test.js
      - server/routes/serviceExtensions/admin.js
      - server/routes/serviceExtensions/admin.test.js
      - server/utils/serviceExtensionNotify.js
      - server/middleware/rateLimiters.js
      - server/routes/stripe.js
      - server/routes/invoices.js
      - server/routes/invoices.extension.test.js
      - server/index.js
    deps: [ext-core]
    review: full-fleet
  - id: ext-webhook-payroll
    footprint:
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.extension.test.js
      - server/utils/serviceExtensionSweep.js
      - server/utils/serviceExtensionSweep.test.js
      - server/utils/refundHelpers.js
      - server/utils/refundHelpers.extensionScope.test.js
      - server/utils/balanceInvoiceMonitor.js
      - server/utils/balanceInvoiceMonitor.test.js
      - server/utils/invoiceExtras.js
      - server/utils/lineItemCancel.test.js
      - server/utils/invoiceLifecycle.js
      - docs/ops-runbook.md
      - scripts/money-smoke-list.txt
      - server/index.js
    deps: [ext-core, ext-routes]
    review: full-fleet
  - id: ext-ui
    footprint:
      - client/src/pages/staff/RequestMoreTime.js
      - client/src/pages/staff/ShiftDetail.js
      - client/src/components/staff/EventActionArea.js
      - client/src/pages/invoice/InvoicePage.js
      - client/src/index.css
      - client/src/components/adminos/ServiceExtensionPanel.js
      - client/src/pages/admin/EventDetailPage.js
    deps: [ext-routes]
    review: full-fleet
  - id: ext-docs
    footprint:
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
      - .env.example
      - docs/fix-list-remaining-2026-07-02.md
    deps: [ext-routes, ext-webhook-payroll, ext-ui]
    review: light
---

# On-site Service Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staffer on site can request more bar time from the staff portal; the client accepts brief coverage terms and pays on the regular invoice page; the event's duration and the staffer's payroll hours move, and every outcome leaves an audit record.

**Architecture:** Extension money is SIDE MONEY. A new `Service Extension` invoice label joins the dormant `OFF_LEDGER_INVOICE_LABELS` constant, which makes the existing webhook skip the `amount_paid` roll-up, keeps `refreshUnlockedInvoices` from re-billing, and makes refund reconciliation leave the contract alone. `proposals.total_price`, `pricing_snapshot`, `amount_paid`, and payment status NEVER move. The only contract mutation is `event_duration_hours` (plus the linked shift's `end_time`). Payroll picks up the extra hours via its existing first-accrual seeding, and the extension's gratuity joins the pool as an event-scoped addend, exactly as card tips already do. No existing money path is modified: `foldExtrasIntoProposal`, `reconcileProposalPaymentStatus`, and the auto-complete gates are untouched. Spec: `docs/superpowers/specs/2026-07-25-service-extension-design.md` (rev 3, approved).

**Tech Stack:** Node 26 / Express 4, raw SQL via `pg`, node:test co-located suites against the shared dev DB, Stripe via the `getStripe()` DI seam, React 18 admin + staff client (axios through `client/src/utils/api.js`), vanilla CSS.

## Global Constraints

- **Proposals money is NUMERIC DOLLARS** (`total_price`, `amount_paid`, `event_duration_hours`); invoices, `proposal_payments`, Stripe, and every `*_cents` column are **INTEGER CENTS**. Convert with `toCents()` (`server/utils/invoiceShared.js`) or `cents / 100`. `service_extensions.amount_cents` and `gratuity_cents` are cents.
- **Never touch `total_price`, `pricing_snapshot`, `amount_paid`, or `proposals.status`** anywhere in this feature. If a task seems to need it, the task is wrong. See spec §2 "landmine" and §3 D12.
- **One pooled connection per request:** inside a `pool.connect()` transaction every query goes through the held `client`; `release()` BEFORE any post-commit tail that calls helpers taking their own connection (`serviceExtensionNotify.js` does).
- All Stripe calls via `server/utils/stripeClient.js` `getStripe()`. Tests stub the seam by assigning `require('../../utils/stripeClient').getStripe = () => fakeStripe` BEFORE requiring the router.
- Throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PermissionError`) from `server/utils/errors.js`; never `res.status(...).json({error})`. `asyncHandler` is at `server/middleware/asyncHandler` (NOT utils).
- Schema changes go in `server/db/schema.sql`, idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- **No em dashes** in any client-visible or staff-visible copy. Commas, periods, colons, parentheses only.
- **Staff never see the price.** No response from any staff-facing endpoint may contain `amount_cents`, `gratuity_cents`, or any dollar figure. Explicit column allowlists on every staff SELECT.
- File-size soft cap 700 lines, hard cap 1000. `server/routes/staffShiftActions.js` (929) and `client/src/pages/staff/ShiftDetail.js` (795 as of 2026-08-03) are both near/over caps: add NOTHING substantial to either. New surfaces get new files.
- Tests: co-located `*.test.js`, node:test, run **one suite at a time** against the shared dev DB. From a lane worktree (no `.env` there): `node --env-file=/home/drbartender/projects/os/.env --test <file>`. Nonce-suffixed seed rows, FK-ordered teardown, `await pool.end()` in `after()`. Pay-period fixtures use the chicago-keyed track-and-restore pattern (standing test law).
- Hosted-package bartender rule is load-bearing: included 1:100 bartenders are $0; over-ratio bartenders bill `extra_bartender_hourly` PLUS the sub-100-guest surcharge ($50/$25/$15 per hour for <50/<75/<100 guests). The pricing delta inherits this from the engine; Task 4 pins it with a test.

## Test harness constraints (READ BEFORE WRITING ANY FIXTURE)

The plan-review fleet found that a first draft of this plan got all of these wrong, in every suite at once. They are stated here so no task repeats them.

- **`users` has NO `name` column, and the password column is `password_hash` (NOT NULL, no default).** The real columns are `id, email, password_hash, role, onboarding_status, token_version, created_at, updated_at` plus later `ALTER`s. Human names live on `contractor_profiles.preferred_name`. Every fixture insert is:
  ```javascript
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [`${NONCE}-a@example.test`]
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1, '3125550111', $2, 40)`,
    [u.rows[0].id, `${NONCE} A`]
  );
  ```
  Never select `u.name` in application code either. Use `COALESCE(cp.preferred_name, u.email)`.
- **JWTs must be signed `{ userId, tokenVersion }`, not `{ id, role }`.** `server/middleware/auth.js` reads `decoded.userId` for the user lookup and compares `decoded.tokenVersion` against `users.token_version`; a mismatch is a 401. Role comes from the DB row, never from the token. Copy the precedent at `server/routes/beo.test.js:130`:
  ```javascript
  const token = jwt.sign(
    { userId: u.rows[0].id, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  ```
- **There is NO `server/middleware/errorHandler` module.** The global handler is inline in `server/index.js`, so route suites hand-roll it. Copy `server/routes/invoices.extrasVoid.test.js:107-111`:
  ```javascript
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  ```
  Note the field-error key is `fieldErrors`, so client-side reads use `data.fieldErrors`, not `data.fields`.
- **Pin package fixtures by slug, never `LIMIT 1` on a rate.** `schema.sql` seeds both `the-core-reaction` and `the-doctors-orders` at `extra_hour_rate = 100`, so `WHERE extra_hour_rate = 100 LIMIT 1` is non-deterministic. These suites join the money-smoke list and run against a fresh Neon branch where both rows exist. Always `WHERE slug = 'the-core-reaction'` / `'the-base-compound'`.
- **`publicLimiter` has no test-environment skip** (20 requests / 15 min, keyed by IP). A suite that drives the accept route and the intent route through it will trip. Keep each suite under ~15 public requests, or add a `NODE_ENV === 'test'` skip to `publicLimiter` and say so in the task that does it.

## Deploy ordering (push equals deploy)

`ext-routes` is independently buildable and mergeable, but it must NOT be **pushed** without `ext-webhook-payroll`. Merging is not deploying, and this plan relies on that distinction.

If the request endpoint ships alone, a client can be charged with no settle path (Task 12) and no expiry sweep (Task 13): the event is never extended, no staffer is greenlit, and the pending row permanently occupies `idx_service_extensions_one_pending` for that proposal, blocking every future request on that event. So:

- Hold `ext-routes` on `main` until `ext-webhook-payroll` merges, then push both in one batch.
- `ext-ui` may push later; without it the flow still works via the emailed link, minus the terms UI, which is why the server-side acceptance gate (Task 9) exists.

## Every settle path ends with `finalizeExtension`

Three places settle an extension, and all three must call `finalizeExtension(id)`
as their LAST step, after `applyExtensionHours` and `notifyStaffOfOutcome` have
both returned:

- Task 8, the zero-delta accept
- Task 10, the admin override
- Task 11, the webhook tail

A settled row with `finalized_at IS NULL` is the crash-recovery signal the Task 13
heal looks for. Stamping it early, or forgetting it, means either the heal never
fires (bartender never told, payroll never updated, invisible forever) or it fires
forever on a row that is actually fine. Task 13's heal stamps it itself.

## Build order (task numbers are stable labels, not the sequence)

Task 12 is split across two lanes because `ext-routes` consumes half of it. The real order is:

1. **ext-core:** Tasks 1, 2, 3, 4, 5, then **12a** (the `serviceExtensionPayroll.js` hours module, Steps 1 to 3 of Task 12).
2. **ext-routes:** Tasks 6, 7, 8, 9, 10. Tasks 8 and 10 import `applyExtensionHours` and `maybeAlertPayroll` from 12a, which is why 12a cannot live in a later lane.
3. **ext-webhook-payroll:** **12b** (the `payrollAccrual.js` gratuity addend, Steps 4 onward of Task 12), then 11, then 20 and 21 (the off-ledger carve-outs, added 2026-08-03), then 13. Task 11's suite imports the payroll module, so 12a must already exist; it does, from step 1.
4. **ext-ui:** Tasks 14, 15, 16. **ext-docs:** Tasks 17, 18.

If a worker builds Task 11 before 12a exists, the test file's top-level `require` throws `MODULE_NOT_FOUND`. The lazy `require` inside the handler does not save the suite.

## In-lane review cadence

Per the execution-review cadence rule, agents fire at checkpoints, not only at merge:
- `ext-core` after Task 4 Step 7: `code-review` on the pricing math.
- `ext-routes` after Task 7: `security-review` (the assignment predicate and the auth/mount ordering are both authored there).
- `ext-routes` after Task 10: `security-review` + `database-review` (public token surface; the off-ledger branches go LIVE here, when the first `Service Extension` invoice is minted).
- `ext-webhook-payroll` after Tasks 12 and 11: `security-review` + `code-review` (the two money seams).
- `ext-ui` after Task 15: `code-review` + `ui-ux-review` (`InvoicePage.js` is every client's payment surface).
- Merge gate per lane: the fleet declared in front-matter.

Deliberately NOT a checkpoint: Task 2. The constant flip is inert until an invoice actually carries the label, because empty-set and one-element `.includes()` / `= ANY()` behave identically while no row matches. The database review that matters happens at Task 10, when the label goes live.

---

## Lane ext-core

Pure server-side foundations: the constant flip, the schema, the timezone helper, the terms registry, the pricing delta, and the settle core. No routes, no webhook, no UI. Everything here is unit-testable without HTTP.

### Task 1: Timezone-correct event end instant

The request window and `expires_at` are instants, not wall-clock strings. `server/utils/shiftTime.js` hardcodes Chicago and `addHoursToTime` is naive string math with a `% 24` wrap, so neither can be used for this. The one correct precedent is the SQL expression in `balanceScheduler.js` that composes `event_date + event_start_time + event_duration_hours` in `event_timezone`. Extract it into a reusable helper.

**Files:**
- Create: `server/utils/eventEndInstant.js`
- Test: `server/utils/eventEndInstant.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `eventEndInstant(client, proposalId)` → `Promise<{ startInstant: Date, endInstant: Date, endDisplay: string } | null>`. Returns `null` when the proposal is missing or its `event_start_time` cannot be parsed by Postgres.
  - `eventEndInstantForDuration(client, proposalId, durationHours)` → same shape, computed at an arbitrary duration instead of the stored one.

- [ ] **Step 1: Read the precedent so the SQL matches it**

Run: `grep -n "event_timezone" -B4 -A8 server/utils/balanceScheduler.js`

Read the `AT TIME ZONE` composition it uses for the completion gate. The helper below is that expression, parameterized on duration.

- [ ] **Step 2: Write the failing test**

Create `server/utils/eventEndInstant.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { eventEndInstant, eventEndInstantForDuration } = require('./eventEndInstant');

const NONCE = `eei-${Date.now()}`;
let clientId, pkgId, proposalId, tzProposalId, badProposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  // Pinned by slug, never LIMIT 1 on a rate: these suites also run against a
  // fresh Neon branch via the money-smoke gate.
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;

  // 8:00 PM Chicago on 2026-09-12, 4 hours -> midnight Chicago = 05:00 UTC on 9/13 (CDT, UTC-5).
  const ins = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalId = ins.rows[0].id;

  // Same wall clock, New York (UTC-4 in September) -> midnight NY = 04:00 UTC.
  const tz = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/New_York','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  tzProposalId = tz.rows[0].id;

  const bad = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','whenever','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  badProposalId = bad.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('composes the end instant in the event timezone, crossing midnight', async () => {
  const r = await eventEndInstant(pool, proposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:00:00.000Z');
});

test('a different event_timezone yields a different instant for the same wall clock', async () => {
  const r = await eventEndInstant(pool, tzProposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T04:00:00.000Z');
});

test('eventEndInstantForDuration prices an arbitrary duration without persisting it', async () => {
  const r = await eventEndInstantForDuration(pool, proposalId, 4.5);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:30:00.000Z');
  const unchanged = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(unchanged.rows[0].event_duration_hours), 4);
});

test('returns null when the start time is unparseable', async () => {
  assert.equal(await eventEndInstant(pool, badProposalId), null);
});

test('returns null for a missing proposal', async () => {
  assert.equal(await eventEndInstant(pool, 999999999), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/eventEndInstant.test.js`
Expected: FAIL, `Cannot find module './eventEndInstant'`.

- [ ] **Step 4: Write the implementation**

Create `server/utils/eventEndInstant.js`:

```javascript
'use strict';

/**
 * Timezone-correct event start/end instants.
 *
 * The only correct precedent in the codebase is the completion gate in
 * balanceScheduler.js, which composes event_date + event_start_time +
 * event_duration_hours inside event_timezone. This module is that expression,
 * parameterized on duration, so the service-extension request window and
 * expires_at are real instants.
 *
 * Deliberately NOT shiftTime.js (hardcodes Chicago, literal -05:00/-06:00
 * offsets) and NOT addHoursToTime (naive string math with a % 24 midnight
 * wrap). addHoursToTime remains correct for the shift's DISPLAY string only.
 *
 * Postgres does the parsing so free-text event_start_time behaves identically
 * to every other consumer. An unparseable time returns null rather than
 * throwing, so callers can surface an explicit conflict.
 */

const SQL = `
  SELECT
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp)
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS start_instant,
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour'))
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS end_instant,
    to_char(((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS end_display
  FROM proposals p
  WHERE p.id = $1
`;

async function eventEndInstantForDuration(client, proposalId, durationHours) {
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  let rows;
  try {
    ({ rows } = await client.query(SQL, [proposalId, hours]));
  } catch (err) {
    // 22007 invalid_datetime_format / 22008 datetime_field_overflow: the stored
    // event_start_time is free text and this one is not a time. Not our bug to
    // throw on; the caller turns it into an explicit conflict.
    if (err.code === '22007' || err.code === '22008') return null;
    throw err;
  }
  if (!rows[0] || !rows[0].end_instant) return null;
  return {
    startInstant: rows[0].start_instant,
    endInstant: rows[0].end_instant,
    endDisplay: rows[0].end_display,
  };
}

async function eventEndInstant(client, proposalId) {
  const { rows } = await client.query(
    'SELECT event_duration_hours FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!rows[0] || rows[0].event_duration_hours === null) return null;
  return eventEndInstantForDuration(client, proposalId, rows[0].event_duration_hours);
}

module.exports = { eventEndInstant, eventEndInstantForDuration };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/eventEndInstant.test.js`
Expected: PASS, 5 tests.

If the `to_char` format yields `8:00 AM` style with a leading space or a different case than the existing `addHoursToTime` output, adjust the format string so `endDisplay` matches what `shifts.end_time` already stores. Check with: `grep -n "addHoursToTime" -A12 server/utils/eventCreation.js | head -20`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/eventEndInstant.js server/utils/eventEndInstant.test.js
git commit -m "feat(ext): timezone-correct event end instant helper"
```

### Task 2: Schema + the off-ledger label constant

**Files:**
- Modify: `server/db/schema.sql` (append to the end)
- Modify: `server/utils/proposalMoneyShared.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Table `service_extensions` (columns per spec §8).
  - `SERVICE_EXTENSION_INVOICE_LABEL` = `'Service Extension'`, exported from `proposalMoneyShared.js`.
  - `OFF_LEDGER_INVOICE_LABELS` now contains that label.

- [ ] **Step 1: Read the constant module before editing it, and do not trust this plan's copy of it**

Run: `cat server/utils/proposalMoneyShared.js`

**This file changed under a previous draft of this plan.** `TOTAL_TRACKING_INVOICE_LABELS` landed on `main` on 2026-07-26 (`05c38bb0`) and is destructured by `server/utils/refundHelpers.js:18` and called at `:347`. A draft of this task pasted an exports block that omitted it, which would have made refund reconciliation throw `TypeError: Cannot read properties of undefined (reading 'includes')` on the next refund, silently until a refund happened.

So: **add to the exports, never retype them.** Read the real export list first and confirm what is there. As of 2026-07-26 it is `MAX_ADDON_QTY`, `safeAddonQty`, `CONTRACT_LABELS`, `OFF_LEDGER_INVOICE_LABELS`, `TOTAL_TRACKING_INVOICE_LABELS`. If the list has grown again, keep whatever you find.

`CONTRACT_LABELS` and `TOTAL_TRACKING_INVOICE_LABELS` must NOT change. Adding the extension label to `CONTRACT_LABELS` would put extension money inside the contract-refund scope, the exact defect spec §3 D12 exists to avoid. Adding it to `TOTAL_TRACKING_INVOICE_LABELS` would NOT touch `refreshUnlockedInvoices` (verified 2026-08-03: `invoiceLifecycle.js:140-153` hardcodes 'Deposit'/'Full Payment'/'Balance' and never reads that constant); the constant is consumed only by refund reconciliation (`refundHelpers.js:347`), where wrong membership would misclassify the extension invoice's demand as refresh-managed and drop its `amount_due`. The protective conclusion stands either way: keep the label out.

- [ ] **Step 2: Add the constant, additively**

Edit `server/utils/proposalMoneyShared.js`. Add the new constant near the other label constants:

```javascript
// The service-extension invoice label. Off-ledger by design (spec
// 2026-07-25 D12): its money is never in total_price, so the webhook must
// skip the amount_paid roll-up, refreshUnlockedInvoices must not count it,
// and refund reconciliation must leave the contract alone. All three read
// OFF_LEDGER_INVOICE_LABELS, so joining that set is the whole wiring.
// Deliberately NOT in CONTRACT_LABELS and NOT in TOTAL_TRACKING_INVOICE_LABELS.
const SERVICE_EXTENSION_INVOICE_LABEL = 'Service Extension';
```

Change the `OFF_LEDGER_INVOICE_LABELS` line (the only code-behavior change in this task):

```javascript
const OFF_LEDGER_INVOICE_LABELS = Object.freeze([SERVICE_EXTENSION_INVOICE_LABEL]);
```

The same commit must also update the constant's own now-false docblock (`proposalMoneyShared.js:30-37`, which asserts the set is empty and explains the no-op) to describe the one-element reality. THIS FILE ONLY: the matching "currently empty" comment blocks in the three consumer files (`paymentIntentSucceeded.js:213-216`, `refundHelpers.js:376-379`, `invoiceLifecycle.js:109-114`) are swept by Task 20 Step 4 in lane ext-webhook-payroll, whose footprint owns those files; sweeping them from this lane would edit outside its declared footprint and abort the lane.

Then add exactly TWO new lines to the existing `module.exports` object, leaving every other entry byte-identical:

```javascript
  OFF_LEDGER_INVOICE_LABELS,          // already present, leave it
  SERVICE_EXTENSION_INVOICE_LABEL,    // <- the one new entry
```

- [ ] **Step 3: Prove nothing was dropped from the export surface**

This check exists specifically to catch the defect described in Step 1. Run:

```bash
node -e "
const m=require('/home/drbartender/projects/os/server/utils/proposalMoneyShared');
const need=['MAX_ADDON_QTY','safeAddonQty','CONTRACT_LABELS','OFF_LEDGER_INVOICE_LABELS','TOTAL_TRACKING_INVOICE_LABELS','SERVICE_EXTENSION_INVOICE_LABEL'];
const missing=need.filter(k=>m[k]===undefined);
if(missing.length) throw new Error('DROPPED EXPORTS: '+missing.join(','));
console.log('OFF_LEDGER:',m.OFF_LEDGER_INVOICE_LABELS);
console.log('CONTRACT:',m.CONTRACT_LABELS);
console.log('TOTAL_TRACKING:',m.TOTAL_TRACKING_INVOICE_LABELS);
console.log('all exports intact');
"
```
Expected: `OFF_LEDGER: [ 'Service Extension' ]`, `CONTRACT: [ 'Deposit', 'Balance', 'Full Payment' ]`, `TOTAL_TRACKING: [ 'Balance', 'Full Payment' ]`, `all exports intact`.

Then confirm every consumer still resolves its import:
```bash
node -e "require('/home/drbartender/projects/os/server/utils/refundHelpers');require('/home/drbartender/projects/os/server/utils/invoiceLifecycle');require('/home/drbartender/projects/os/server/routes/stripeWebhookHandlers/paymentIntentSucceeded');console.log('consumers load OK')"
```

- [ ] **Step 4: Run the named suites that guard the three off-ledger branches**

Do NOT grep for the constant names: no test file mentions them, so a grep returns zero hits and the step would pass vacuously. That is exactly how the dropped-export defect survived review in the first draft. Run these seven by name, one at a time (the label-classification flip also reaches `refundHelpers.scope.test.js`, `lineItemCancel.test.js`, and `balanceInvoiceMonitor.test.js`, so they are in the run set):

```bash
for f in \
  server/utils/refundHelpers.test.js \
  server/utils/refundHelpers.scope.test.js \
  server/utils/lineItemCancel.test.js \
  server/utils/balanceInvoiceMonitor.test.js \
  server/routes/invoices.refunds.test.js \
  server/utils/invoiceLifecycle.additionalInvoice.test.js \
  server/routes/stripeWebhook.guards.test.js ; do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```

Expected: all PASS. If a filename does not exist, find the real one with `ls server/utils/refundHelpers*.test.js server/routes/invoices*.test.js server/routes/stripeWebhook*.test.js` and run those instead; all of them are already in `scripts/money-smoke-list.txt`, which is the authoritative list of money suites. That list has grown to 20 suites and the pre-push gate is now HARD (verified 2026-08-03): `NEON_API_KEY` is configured, so the suites run against the prod-shaped `ci-smoke` Neon branch, which carries prod CHECK constraints the dev DB lacks; a suite green on dev can still fail there.

A failure here is a real regression and blocks the task. Note that a PASS does not prove much on its own: the flip is inert until an invoice actually carries the label (empty-set and one-element matching behave identically while no row matches), which is why the real database review happens at Task 10.

- [ ] **Step 5: Add the table to the schema**

Append to `server/db/schema.sql`:

```sql
-- ─── Service extensions (on-site added bar time) ──────────────────────────
-- One row per staff request for more bar time. Spec:
-- docs/superpowers/specs/2026-07-25-service-extension-design.md
-- Money is SIDE MONEY: the paid extension lives as its own invoice + payment,
-- and proposals.total_price / amount_paid / pricing_snapshot never move. The
-- only contract mutation is proposals.event_duration_hours.
CREATE TABLE IF NOT EXISTS service_extensions (
  id                        SERIAL PRIMARY KEY,
  proposal_id               INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  shift_id                  INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  requested_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invoice_id                INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  contracted_end_time       VARCHAR(20),
  requested_end_time        VARCHAR(20),
  contracted_duration_hours NUMERIC(4,1) NOT NULL,
  requested_duration_hours  NUMERIC(4,1) NOT NULL,
  amount_cents              INTEGER NOT NULL,
  gratuity_cents            INTEGER NOT NULL DEFAULT 0,
  hosted_product_confirmed  BOOLEAN,
  terms_version             TEXT,
  client_accepted_at        TIMESTAMPTZ,
  client_accept_ip          VARCHAR(64),
  client_accept_ua          TEXT,
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','expired','cancelled','overridden')),
  -- Stamped only after the post-settle side effects (payroll hours + staff
  -- greenlight) have run. A 'paid'/'overridden' row with finalized_at NULL is a
  -- crash casualty: the settle committed but its side effects did not, so
  -- payroll still holds the old hours and no bartender was told. Stripe will not
  -- replay (isFirstDelivery already consumed the event) and the expiry sweep
  -- only looks at 'pending', so without this column that state is invisible
  -- forever. The sweep heals it.
  finalized_at              TIMESTAMPTZ,
  override_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  override_reason           TEXT,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live request per event at a time. The partial index is what makes a
-- second staffer's concurrent request a clean no-op instead of a double charge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_extensions_one_pending
  ON service_extensions (proposal_id) WHERE status = 'pending';

-- Sweep driver: claim pending rows past expiry.
CREATE INDEX IF NOT EXISTS idx_service_extensions_pending_expiry
  ON service_extensions (expires_at) WHERE status = 'pending';

-- Webhook discriminator: settle looks the row up by the paid invoice.
CREATE INDEX IF NOT EXISTS idx_service_extensions_invoice
  ON service_extensions (invoice_id);

-- Payroll gratuity addend sums paid rows per proposal.
CREATE INDEX IF NOT EXISTS idx_service_extensions_proposal_status
  ON service_extensions (proposal_id, status);

-- Crash-recovery driver: settled rows whose post-settle side effects never ran.
CREATE INDEX IF NOT EXISTS idx_service_extensions_unfinalized
  ON service_extensions (updated_at)
  WHERE finalized_at IS NULL AND status IN ('paid', 'overridden');
```

- [ ] **Step 6: Apply the schema to the dev DB and verify**

Run:
```bash
node --env-file=/home/drbartender/projects/os/.env -e "
const {pool}=require('/home/drbartender/projects/os/server/db');
const fs=require('fs');
(async()=>{
  const sql=fs.readFileSync('/home/drbartender/projects/os/server/db/schema.sql','utf8');
  const start=sql.indexOf('CREATE TABLE IF NOT EXISTS service_extensions');
  await pool.query(sql.slice(start));
  const r=await pool.query(\"SELECT column_name,data_type FROM information_schema.columns WHERE table_name='service_extensions' ORDER BY ordinal_position\");
  console.log(r.rows.map(x=>x.column_name+':'+x.data_type).join('\n'));
  await pool.end();
})();
"
```
Expected: all 22 columns listed, `amount_cents:integer`, `contracted_duration_hours:numeric`.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql server/utils/proposalMoneyShared.js
git commit -m "feat(ext): service_extensions table + Service Extension off-ledger label

Flips OFF_LEDGER_INVOICE_LABELS from its frozen-empty placeholder to the
label the webhook, invoice refresh, and refund reconciliation branches were
already written to expect. Additive to the export surface: CONTRACT_LABELS and
TOTAL_TRACKING_INVOICE_LABELS are untouched."
```

No checkpoint review on this task. The flip is inert until an invoice carries the label, so there is nothing behavioral for a reviewer to judge yet; the `database-review` fires at Task 10, where the label goes live.

### Task 3: Terms copy registry

Modeled on `server/data/smsConsentCopy.js`, whose `getConsentCopy(version)` (smsConsentCopy.js:38-46, own-property-guarded) refuses an unknown version with `null` rather than recording a lie; it never throws. `getExtensionTerms` throws on a miss instead, a deliberate strengthening of that pattern, not a copy of it. Without this registry, a stored `terms_version` maps to no text and the audit artifact is empty.

**Files:**
- Create: `server/data/extensionTermsCopy.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CURRENT_EXTENSION_TERMS_VERSION` (string, `'2026-07-26.1'`)
  - `getExtensionTerms(version)` → `{ version, headline, body }`, THROWS on an unknown version.
  - `renderExtensionTerms({ version, newEndDisplay })` → `{ version, headline, paragraphs: string[] }` with the end time interpolated.

- [ ] **Step 1: Read the precedent**

Run: `sed -n 1,60p server/data/smsConsentCopy.js`

Match its shape: a frozen version map, a guarded lookup that refuses unknown versions (with `null` in the precedent; this registry throws instead), and copy stored as data rather than inline in a route.

- [ ] **Step 2: Write the registry**

Create `server/data/extensionTermsCopy.js`:

```javascript
'use strict';

/**
 * Versioned client-facing terms for an on-site service extension.
 *
 * Stored as data, and looked up by the version recorded on the
 * service_extensions row, so the audit trail can always reproduce exactly
 * what the client agreed to. getExtensionTerms THROWS on an unknown version
 * rather than returning a default: recording "they accepted v3" while showing
 * v1's text would make the artifact a lie. smsConsentCopy refuses with null;
 * throwing here is a deliberate strengthening of that precedent.
 *
 * Copy rule: no em dashes.
 */

const CURRENT_EXTENSION_TERMS_VERSION = '2026-07-26.1';

const VERSIONS = Object.freeze({
  '2026-07-26.1': Object.freeze({
    headline: 'Extend bar service to {{END}}',
    body: Object.freeze([
      'Additional bar service under your existing agreement. Same team, same terms, same $2 million liquor liability coverage.',
      'That coverage applies to service booked through Dr. Bartender. Our bartenders cannot accept payment directly for additional service time, and any arrangement made privately with a bartender is not insured.',
    ]),
  }),
});

function getExtensionTerms(version) {
  const entry = VERSIONS[version];
  if (!entry) {
    throw new Error(`getExtensionTerms: unknown terms version '${version}'`);
  }
  return { version, headline: entry.headline, body: entry.body };
}

function renderExtensionTerms({ version, newEndDisplay }) {
  const terms = getExtensionTerms(version);
  return {
    version: terms.version,
    headline: terms.headline.replace('{{END}}', newEndDisplay || 'the new end time'),
    paragraphs: [...terms.body],
  };
}

module.exports = {
  CURRENT_EXTENSION_TERMS_VERSION,
  getExtensionTerms,
  renderExtensionTerms,
  VERSIONS,
};
```

- [ ] **Step 3: Verify the lookup and the copy rule**

Run:
```bash
node -e "
const m=require('/home/drbartender/projects/os/server/data/extensionTermsCopy');
const r=m.renderExtensionTerms({version:m.CURRENT_EXTENSION_TERMS_VERSION,newEndDisplay:'11:00 PM'});
console.log(r.headline);
console.log(r.paragraphs.join('\n'));
const all=r.headline+r.paragraphs.join('');
if(all.includes('—')) throw new Error('em dash in client copy');
try{m.getExtensionTerms('nope');throw new Error('should have thrown')}catch(e){console.log('unknown version rejected:',e.message)}
console.log('OK');
"
```
Expected: headline `Extend bar service to 11:00 PM`, both paragraphs, `unknown version rejected: ...`, `OK`.

- [ ] **Step 4: Commit**

```bash
git add server/data/extensionTermsCopy.js
git commit -m "feat(ext): versioned extension terms copy registry"
```

### Task 4: The pricing delta

The whole money question, in one pure-ish function. It mirrors `foldExtrasIntoProposal`'s delta discipline exactly: price both legs at CATALOG (`totalPriceOverride: null`) and difference the SERVICE portion, because the override is a service-level contract that the engine substitutes for the calculated total. Differencing `.total` with an override present would collapse the service delta to zero.

Two legs differ ONLY in `durationHours`. Everything else is identical, so anything without a duration term cancels exactly. `calculateSyrupCost(syrupSelections, guestCount)` takes no duration, so syrups cancel and both legs pass `[]`. Add-ons do NOT cancel (`per_guest_timed` and `per_hour` carry duration terms), so the real add-on rows must be loaded.

**Files:**
- Create: `server/utils/serviceExtensionPricing.js`
- Test: `server/utils/serviceExtensionPricing.test.js`

**Interfaces:**
- Consumes: `eventEndInstantForDuration` (Task 1).
- Produces:
  - `MAX_EXTENSION_HOURS` = `3`
  - `computeExtensionDelta({ client, proposalId, requestedDurationHours })` → `Promise<Result>` where `Result` is either
    `{ ok: true, contractedDurationHours, requestedDurationHours, contractedEndDisplay, requestedEndDisplay, contractedEndInstant, serviceDeltaCents, gratuityDeltaCents, amountCents, isHosted }`
    or `{ ok: false, reason }` with `reason` in `'missing_proposal' | 'missing_package' | 'unparseable_time' | 'not_an_extension' | 'over_cap' | 'bad_increment'`.
    `contractedEndInstant` is a Date; Task 7 derives `expires_at` from it.

- [ ] **Step 1: Write the failing test**

Create `server/utils/serviceExtensionPricing.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { computeExtensionDelta, MAX_EXTENSION_HOURS } = require('./serviceExtensionPricing');

const NONCE = `sxp-${Date.now()}`;
let clientId, flatPkgId, hostedPkgId, classPkgId;
const made = [];

async function mkProposal(fields) {
  const {
    packageId, guests = 100, hours = 4, gratuityRate = 0, numBartenders = null,
    override = null, totalPrice = 350,
  } = fields;
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        num_bartenders, gratuity_rate, tip_jar, total_price, total_price_override,
        amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'deposit_paid',$3,$4,1,$5,$6,true,$7,$8,$7,'2026-09-12','6:00 PM','America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, packageId, guests, hours, numBartenders, gratuityRate, totalPrice, override]
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  // Pinned by slug. The Core Reaction: flat, base_rate_4hr 350, extra_hour_rate 100.
  const f = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  flatPkgId = f.rows[0].id;
  // The Base Compound: per_guest, base 18, extra_hour_rate 5.
  const h = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-base-compound'");
  hostedPkgId = h.rows[0].id;
  // A per-guest CLASS package: extra_hour_rate 0, so extending is always $0.
  const cl = await pool.query(
    "SELECT id FROM service_packages WHERE bar_type = 'class' AND pricing_type = 'per_guest' AND is_active = true ORDER BY sort_order LIMIT 1"
  );
  classPkgId = cl.rows[0].id;
});

after(async () => {
  if (made.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [made]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('flat package, +30 min above the 4h base, zero gratuity: $50', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 5000);
  assert.equal(r.gratuityDeltaCents, 0);
  assert.equal(r.serviceDeltaCents, 5000);
});

test('gratuity rides along: +30 min at $50/staff/hr adds $25', async () => {
  const id = await mkProposal({ packageId: flatPkgId, gratuityRate: 50 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.gratuityDeltaCents, 2500);
  assert.equal(r.amountCents, 7500);
});

test('flat package below the 4h tier: 3h -> 4h is $0, the zero-delta path', async () => {
  const id = await mkProposal({ packageId: flatPkgId, hours: 3 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 0);
});

test('over-ratio bartender at 50 guests carries the sub-100 surcharge: +60 min is $165', async () => {
  // 50 guests -> staffing.required = 1; num_bartenders override 2 -> 1 extra.
  // extra x hours x (extra_bartender_hourly 40 + gratuityPerHour 25 for <75)
  // = 1 x 1 x 65 = $65, plus the $100 base extra hour.
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 16500);
});

test('at 100 guests the same two-bartender shape has no surcharge: $140', async () => {
  const id = await mkProposal({ packageId: flatPkgId, guests: 100, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 14000);
});

test('the sub-100 surcharge is classified as STAFF gratuity, not service revenue', async () => {
  // The load-bearing case, and the one the cross-model review caught. The
  // $25/hr over-ratio surcharge carries the 'Shared Gratuity' breakdown label,
  // which payroll pools into the staff gratuity. Reading snapshot.gratuity.total
  // instead of extractGratuityCents would put it in serviceDeltaCents and DRB
  // would keep money that belongs to the bartenders. gratuity_rate is 0 here, so
  // the ONLY gratuity in play is the surcharge: it must be $25, not $0.
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2, gratuityRate: 0 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.gratuityDeltaCents, 2500, 'the Shared Gratuity surcharge must land in the staff pool');
  assert.equal(r.serviceDeltaCents, 14000, '$100 base hour + $40 extra-bartender hour');
  assert.equal(r.serviceDeltaCents + r.gratuityDeltaCents, r.amountCents, 'the three figures must reconcile');
});

test('with a client gratuity rate AND a surcharge, both labels reach the staff pool', async () => {
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2, gratuityRate: 50 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.gratuityDeltaCents > 2500, 'both gratuity labels must be pooled, not just one');
  assert.equal(r.serviceDeltaCents + r.gratuityDeltaCents, r.amountCents);
});

test('hosted per-guest: 100 guests x $5 x 1h = $500', async () => {
  const id = await mkProposal({ packageId: hostedPkgId, guests: 100, totalPrice: 1800 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50000);
  assert.equal(r.isHosted, true);
});

test('a negotiated override does not swallow the delta', async () => {
  // Sold at $400 against a $350 catalog. The delta must still be the catalog
  // $100/hr, not $0 (which is what differencing .total with the override on
  // would produce).
  const id = await mkProposal({ packageId: flatPkgId, override: 400, totalPrice: 400 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 10000);
});

test('refuses a requested end at or before the contracted end', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 })).reason, 'not_an_extension');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 3.5 })).reason, 'not_an_extension');
});

test('refuses beyond the 3 hour cap and refuses non-30-minute increments', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 + MAX_EXTENSION_HOURS + 0.5 })).reason, 'over_cap');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.25 })).reason, 'bad_increment');
});

test('a per-guest class package extends for $0 (extra_hour_rate 0)', async () => {
  const id = await mkProposal({ packageId: classPkgId, guests: 20, totalPrice: 700 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 0);
});

test('a tiny hosted event still owes the billed-guest extra hour, NOT $0', async () => {
  // VERIFIED against the live engine 2026-07-26. The Base Compound carries
  // min_billed_guests = 25 and min_total = $550, so a 1-guest event bills as 25
  // heads. The extra-hour term is 25 x $5 = $125, and it is ADDITIVE on top of
  // the billed-guest base rather than absorbed by the dollar floor.
  //
  // An earlier draft asserted $0 here on the theory that min_total swallows the
  // delta. It does not: the floor binds the 4-hour base, and the extra hour
  // clears it. That wrong expectation would have sent the implementer hunting a
  // non-bug in correct pricing code, so the number below is measured, not
  // reasoned. If a package's floor is ever high enough to bind at BOTH
  // durations the delta really is $0, which is why Task 13 keeps the
  // zero-delta settle path; it is just not this package.
  const id = await mkProposal({ packageId: hostedPkgId, guests: 1, totalPrice: 550 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 12500, '25 billed heads x $5 x 1 hour');
  assert.equal(r.gratuityDeltaCents, 0);
});

test('returns the contracted end instant that Task 7 uses for expires_at', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.ok(r.contractedEndInstant instanceof Date || typeof r.contractedEndInstant === 'string');
});

test('never mutates the proposal', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  const r = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id]
  );
  assert.equal(Number(r.rows[0].event_duration_hours), 4);
  assert.equal(Number(r.rows[0].total_price), 350);
  assert.equal(r.rows[0].status, 'deposit_paid');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPricing.test.js`
Expected: FAIL, `Cannot find module './serviceExtensionPricing'`.

- [ ] **Step 3: Write the implementation**

Create `server/utils/serviceExtensionPricing.js`:

```javascript
'use strict';

/**
 * Price an on-site service extension as the pricing engine's delta.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 6.
 *
 * Discipline copied from foldExtrasIntoProposal: both legs price at CATALOG
 * (totalPriceOverride: null) and we difference the SERVICE portion, never
 * `.total`. A total_price_override is a service-level contract that the engine
 * substitutes for the calculated total, so differencing `.total` with an
 * override present collapses the service delta to zero (many Core Reaction
 * bookings are sold at $400 against a $350 catalog).
 *
 * The two legs differ ONLY in durationHours, so every component with no
 * duration term cancels exactly. calculateSyrupCost(selections, guestCount)
 * has no duration term, so syrups cancel and both legs pass []. Add-ons do NOT
 * cancel (per_guest_timed and per_hour carry duration terms), so the real
 * proposal_addons rows are loaded.
 *
 * READ-ONLY. This function never writes. The caller persists.
 */

const { calculateProposal, isHostedPackage } = require('./pricingEngine');
const { loadRepriceAddons } = require('./proposalExtrasFold');
const { eventEndInstantForDuration } = require('./eventEndInstant');
// THE definition of "gratuity" for payroll purposes. It pools BOTH canonical
// breakdown labels, 'Shared Gratuity' (the forced sub-100-guest over-ratio
// surcharge) and 'Gratuity' (client-elected), per GRATUITY_PAYROLL_LABELS.
const { extractGratuityCents } = require('./payrollMath');

// Cap on how far a single request may extend, in hours. A mis-scroll must not
// be able to invoice a client for a second event.
const MAX_EXTENSION_HOURS = 3;

// Requests move in 30-minute steps (spec section 3 decision 5).
const INCREMENT_HOURS = 0.5;

/** Dollars-to-cents, matching invoiceShared.toCents rounding. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/**
 * Total for an engine result, in cents. Includes both gratuity flavours:
 * the client-elected line is layered on top of serviceTotal, and the forced
 * sub-100-guest surcharge is inside staffing.cost -> subtotal -> serviceTotal.
 */
function totalCentsOf(snapshot) {
  return toCents(snapshot.total);
}

/**
 * The STAFF gratuity in an engine result, in cents.
 *
 * Deliberately NOT `snapshot.gratuity.total`, which holds only the
 * client-elected line. Payroll pools BOTH canonical breakdown labels
 * ('Shared Gratuity' + 'Gratuity') via extractGratuityCents, and the forced
 * sub-100-guest over-ratio surcharge carries the 'Shared Gratuity' label while
 * living inside staffing.cost. Reading `.gratuity.total` would classify that
 * surcharge as DRB service revenue, so on a 50-guest two-bartender event the
 * $25/hr surcharge the rule exists to pay bartenders with would never reach the
 * staff pool. This is the load-bearing hosted/staffing gratuity rule CLAUDE.md
 * flags as re-lost multiple times; extractGratuityCents is the single source.
 */
function staffGratuityCentsOf(snapshot) {
  return extractGratuityCents(snapshot);
}

async function computeExtensionDelta({ client, proposalId, requestedDurationHours }) {
  const propRes = await client.query(
    `SELECT id, package_id, guest_count, event_duration_hours, num_bars, num_bartenders,
            gratuity_rate, tip_jar, adjustments, total_price_override
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal) return { ok: false, reason: 'missing_proposal' };
  if (!proposal.package_id || !proposal.event_duration_hours || !proposal.guest_count) {
    return { ok: false, reason: 'missing_package' };
  }

  const pkgRes = await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]);
  const pkg = pkgRes.rows[0];
  if (!pkg) return { ok: false, reason: 'missing_package' };

  const contracted = Number(proposal.event_duration_hours);
  const requested = Number(requestedDurationHours);
  if (!Number.isFinite(requested) || requested <= contracted) {
    return { ok: false, reason: 'not_an_extension' };
  }
  const added = Math.round((requested - contracted) * 100) / 100;
  if (added > MAX_EXTENSION_HOURS) return { ok: false, reason: 'over_cap' };
  // Integer number of 30-minute steps, tolerant of float noise.
  const steps = added / INCREMENT_HOURS;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return { ok: false, reason: 'bad_increment' };

  const contractedEnd = await eventEndInstantForDuration(client, proposalId, contracted);
  const requestedEnd = await eventEndInstantForDuration(client, proposalId, requested);
  if (!contractedEnd || !requestedEnd) return { ok: false, reason: 'unparseable_time' };

  const addons = await loadRepriceAddons(client, proposalId);

  // Identical on both legs. Only durationHours moves.
  const common = {
    pkg,
    guestCount: proposal.guest_count,
    numBars: proposal.num_bars,
    numBartenders: proposal.num_bartenders,
    addons,
    syrupSelections: [], // no duration term, cancels across the legs
    adjustments: proposal.adjustments || [],
    totalPriceOverride: null, // price the delta at CATALOG
    gratuityRate: proposal.gratuity_rate,
    tipJar: proposal.tip_jar,
  };

  const before = calculateProposal({ ...common, durationHours: contracted });
  const after = calculateProposal({ ...common, durationHours: requested });

  // The whole delta is the total delta. The gratuity share of it comes from the
  // pooled payroll labels, and service is whatever is left. Deriving service as
  // the remainder (rather than differencing a separate service figure) means the
  // three numbers can never fail to reconcile.
  const amountCents = totalCentsOf(after) - totalCentsOf(before);
  const gratuityDeltaCents = staffGratuityCentsOf(after) - staffGratuityCentsOf(before);
  const serviceDeltaCents = amountCents - gratuityDeltaCents;

  return {
    ok: true,
    contractedDurationHours: contracted,
    requestedDurationHours: requested,
    contractedEndDisplay: contractedEnd.endDisplay,
    requestedEndDisplay: requestedEnd.endDisplay,
    contractedEndInstant: contractedEnd.endInstant,
    serviceDeltaCents,
    gratuityDeltaCents,
    amountCents,
    isHosted: isHostedPackage(pkg),
  };
}

module.exports = { computeExtensionDelta, MAX_EXTENSION_HOURS, INCREMENT_HOURS };
```

- [ ] **Step 4: Confirm `isHostedPackage` and `loadRepriceAddons` are actually exported**

Run:
```bash
node -e "
const e=require('/home/drbartender/projects/os/server/utils/pricingEngine');
const f=require('/home/drbartender/projects/os/server/utils/proposalExtrasFold');
console.log('isHostedPackage:',typeof e.isHostedPackage,'calculateProposal:',typeof e.calculateProposal,'loadRepriceAddons:',typeof f.loadRepriceAddons);
"
```
Expected: all three `function`. If `isHostedPackage` is not exported, add it to `pricingEngine.js`'s `module.exports` (it is an existing internal helper; exporting it is additive and safe) and note the export in the commit.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPricing.test.js`
Expected: PASS, 10 tests.

If the 50-guest surcharge case returns $140 instead of $165, the `num_bartenders` override is not reaching `calculateStaffing`. Re-read `calculateStaffing(pkg, guestCount, durationHours, numBartendersOverride)` and confirm the column is `proposals.num_bartenders`; a NULL there means `actual = required` and there is no extra bartender at all, which would make the test's premise wrong rather than the code.

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionPricing.js server/utils/serviceExtensionPricing.test.js
git commit -m "feat(ext): engine-delta pricing for a service extension

Both legs at catalog, difference the service portion (the fold's discipline so
a negotiated override cannot swallow the delta), gratuity delta tracked
separately because payroll consumes it."
```

- [ ] **Step 7: Checkpoint review**

Dispatch `code-review` on this task's diff. Focus: the cents rounding, the override handling, and whether any duration-bearing component was missed.

### Task 5: The settle core

One function, three callers (paid webhook, zero-delta acceptance, admin override). It claims the pending row, moves the duration, syncs the linked shift, and logs. It does NOT send messages and does NOT touch payroll: those are sequenced by the caller so a Twilio or payroll hiccup can never roll back a settled payment.

The claim is the race gate. Settle, expiry, override, and cancel all claim with `WHERE status = 'pending'` and act only when `rowCount === 1`, so exactly one of them wins. That is also a second idempotency wall behind the webhook's `isFirstDelivery`.

`addHoursToTime` is deliberately not used: it is not exported and it needs 24-hour input, while `proposals.event_start_time` is free text like `8:00 PM`. The new `end_time` display string is derived in SQL instead. Verified 2026-07-26 that `to_char(..., 'FMHH12:MI AM')` reproduces `addHoursToTime`'s exact format (`11:00 PM`, `12:30 AM`, `9:30 AM`, `12:00 AM`), so nothing downstream sees a format change.

**Files:**
- Create: `server/utils/serviceExtensionSettle.js`
- Test: `server/utils/serviceExtensionSettle.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (it reads the `service_extensions` row Task 2 created).
- Produces:
  - `settleExtension({ extensionId, outcome, actorUserId, overrideReason })` → `Promise<Result>`
    - `outcome` is `'paid'` or `'overridden'`.
    - `Result` on success: `{ ok: true, proposalId, shiftId, invoiceId, staffUserIds: number[], newDurationHours, previousDurationHours, newEndDisplay, multiShift: boolean, gratuityCents, amountCents, outcome }`
    - `Result` on a lost claim: `{ ok: false, reason: 'not_pending' }`
  - `closeExtension({ extensionId, outcome, actorUserId, overrideReason })` → same claim discipline for the non-settling outcomes `'expired'` and `'cancelled'`; returns `{ ok: true, proposalId, shiftId, invoiceId, staffUserIds, outcome }` or `{ ok: false, reason: 'not_pending' }`. No duration change.

**No `client` parameter, deliberately.** Both functions open and own their own transaction. Every caller (the webhook's post-commit tail, the public accept route, the admin routes, the expiry sweep) invokes them from outside any transaction, and the claim plus the duration bump plus the shift sync MUST be atomic: a first draft ran them as four separate statements on the pool, so a failure between the claim and the duration UPDATE left a row marked `paid` on an event that was never extended.

- [ ] **Step 1: Write the failing test**

Create `server/utils/serviceExtensionSettle.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { settleExtension, closeExtension } = require('./serviceExtensionSettle');

const NONCE = `sxs-${Date.now()}`;
let clientId, pkgId, staffAId, staffBId;
const proposals = [];
const shifts = [];
const extensions = [];

async function mkEvent({ hours = 4, shiftCount = 1 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'balance_paid',100,$3,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId, hours]
  );
  const proposalId = p.rows[0].id;
  proposals.push(proposalId);

  const madeShifts = [];
  for (let i = 0; i < shiftCount; i++) {
    const s = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                           event_duration_hours, positions_needed, client_name)
       VALUES ('2026-09-12','8:00 PM','12:00 AM','open',$1,$2,'["Bartender"]',$3)
       RETURNING id`,
      [proposalId, hours, `${NONCE} client`]
    );
    madeShifts.push(s.rows[0].id);
    shifts.push(s.rows[0].id);
  }
  return { proposalId, shiftId: madeShifts[0], allShiftIds: madeShifts };
}

async function assign(shiftId, userId) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1,$2,'approved','Bartender')`,
    [shiftId, userId]
  );
}

async function mkExtension({ proposalId, shiftId, requested = 4.5, contracted = 4, status = 'pending', gratuityCents = 0 }) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, shift_id, requested_by_user_id, contracted_duration_hours,
        requested_duration_hours, contracted_end_time, requested_end_time,
        amount_cents, gratuity_cents, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'12:00 AM','12:30 AM',5000,$6,$7, NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [proposalId, shiftId, staffAId, contracted, requested, gratuityCents, status]
  );
  extensions.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;
  // users has NO `name` column and the password column is `password_hash`.
  // See "Test harness constraints" at the top of this plan.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,'x','staff','approved',0) RETURNING id`,
    [`${NONCE}-a@example.test`]
  );
  staffAId = a.rows[0].id;
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,'x','staff','approved',0) RETURNING id`,
    [`${NONCE}-b@example.test`]
  );
  staffBId = b.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40), ($3,'3125550112',$4,40)`,
    [staffAId, `${NONCE} A`, staffBId, `${NONCE} B`]
  );
});

after(async () => {
  if (extensions.length) await pool.query('DELETE FROM service_extensions WHERE id = ANY($1)', [extensions]);
  if (shifts.length) await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [shifts]);
  if (shifts.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [shifts]);
  if (proposals.length) await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [proposals]);
  if (proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [[staffAId, staffBId]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[staffAId, staffBId]]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('paid settle bumps duration, syncs the shift, returns every assigned staffer', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await assign(ev.shiftId, staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, gratuityCents: 2500 });

  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.newDurationHours, 4.5);
  assert.equal(r.previousDurationHours, 4);
  assert.equal(r.newEndDisplay, '12:30 AM');
  assert.equal(r.gratuityCents, 2500);
  assert.deepEqual(r.staffUserIds.slice().sort((x, y) => x - y), [staffAId, staffBId].sort((x, y) => x - y));

  const prop = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [ev.proposalId]
  );
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Side money: nothing else about the contract moved.
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');

  const sh = await pool.query('SELECT event_duration_hours, end_time FROM shifts WHERE id = $1', [ev.shiftId]);
  assert.equal(Number(sh.rows[0].event_duration_hours), 4.5);
  assert.equal(sh.rows[0].end_time, '12:30 AM');

  const ext = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(ext.rows[0].status, 'paid');

  const log = await pool.query(
    "SELECT action FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'extension_paid'",
    [ev.proposalId]
  );
  assert.equal(log.rowCount, 1);
});

test('a second settle on the same row loses the claim and changes nothing', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await settleExtension({ extensionId: extId, outcome: 'paid' })).ok, true);
  const second = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5, 'must not double-bump');
});

test('override settles the same way and records who and why', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await settleExtension({
    extensionId: extId, outcome: 'overridden',
    actorUserId: staffBId, overrideReason: 'link never arrived',
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'overridden');

  const ext = await pool.query(
    'SELECT status, override_by_user_id, override_reason FROM service_extensions WHERE id = $1',
    [extId]
  );
  assert.equal(ext.rows[0].status, 'overridden');
  assert.equal(ext.rows[0].override_by_user_id, staffBId);
  assert.equal(ext.rows[0].override_reason, 'link never arrived');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
});

test('a multi-shift event bumps the proposal but flags rather than guessing which shift', async () => {
  const ev = await mkEvent({ shiftCount: 2 });
  await assign(ev.allShiftIds[0], staffAId);
  await assign(ev.allShiftIds[1], staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.allShiftIds[0] });

  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.multiShift, true);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Neither shift was rewritten: the admin resolves a multi-shift event by hand.
  const sh = await pool.query('SELECT end_time FROM shifts WHERE proposal_id = $1', [ev.proposalId]);
  for (const row of sh.rows) assert.equal(row.end_time, '12:00 AM');
});

test('closeExtension expires without touching duration, and only once', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await closeExtension({ extensionId: extId, outcome: 'expired' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.staffUserIds, [staffAId]);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4, 'expiry must not extend');

  assert.equal((await closeExtension({ extensionId: extId, outcome: 'expired' })).ok, false);
});

test('a settle cannot win after an expiry claimed the row', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await closeExtension({ extensionId: extId, outcome: 'expired' })).ok, true);
  const late = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
});

test('a dropped staffer is not notified', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position, dropped_at) VALUES ($1,$2,'approved','Bartender',NOW())",
    [ev.shiftId, staffBId]
  );
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });
  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.deepEqual(r.staffUserIds, [staffAId]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSettle.test.js`
Expected: FAIL, `Cannot find module './serviceExtensionSettle'`.

- [ ] **Step 3: Write the implementation**

Create `server/utils/serviceExtensionSettle.js`:

```javascript
'use strict';

/**
 * Settle or close a service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 7.
 *
 * settleExtension is the ONE place the contract changes, and the only column it
 * moves is proposals.event_duration_hours (plus the linked shift's denormalized
 * duration and end_time). total_price, pricing_snapshot, amount_paid, and
 * status are NEVER touched: extension money is side money and rides the
 * off-ledger invoice label instead (D12).
 *
 * The claim UPDATE (... WHERE status = 'pending') is the race gate shared by
 * settle, expiry, override, and cancel: exactly one wins, and a replayed
 * webhook cannot double-bump the duration.
 *
 * Deliberately does NOT send messages or touch payroll. The caller sequences
 * those AFTER this returns, so a Twilio or payroll failure can never roll back
 * a settled payment. Deliberately does NOT call syncShiftsFromProposal: that
 * full sync also rewrites location, setup minutes, and the staffing roster,
 * none of which should move mid-event, and it no-ops on multi-shift events.
 *
 * addHoursToTime is not used (not exported, and it needs 24-hour input while
 * event_start_time is free text like "8:00 PM"). The display string is derived
 * in SQL; to_char(..., 'FMHH12:MI AM') reproduces addHoursToTime's exact format
 * (verified 2026-07-26: 11:00 PM, 12:30 AM, 9:30 AM, 12:00 AM).
 */

const { pool } = require('../db');

const SETTLE_OUTCOMES = new Set(['paid', 'overridden']);
const CLOSE_OUTCOMES = new Set(['expired', 'cancelled']);

const ACTION_BY_OUTCOME = Object.freeze({
  paid: 'extension_paid',
  overridden: 'extension_overridden',
  expired: 'extension_expired',
  cancelled: 'extension_cancelled',
});

/** Every staffer still on the event's roster, so a two-bartender job tells both. */
async function assignedStaffUserIds(client, proposalId) {
  const { rows } = await client.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL`,
    [proposalId]
  );
  return rows.map((r) => r.user_id);
}

/** Claim the row for one outcome. Returns the row, or null when someone else won. */
async function claim(client, extensionId, outcome, actorUserId, overrideReason) {
  const { rows } = await client.query(
    `UPDATE service_extensions
        SET status = $2,
            override_by_user_id = COALESCE($3, override_by_user_id),
            override_reason = COALESCE($4, override_reason),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, proposal_id, shift_id, invoice_id, gratuity_cents, amount_cents,
                contracted_duration_hours, requested_duration_hours`,
    [
      extensionId,
      outcome,
      Number.isInteger(actorUserId) ? actorUserId : null,
      overrideReason || null,
    ]
  );
  return rows[0] || null;
}

async function logAction(client, proposalId, outcome, details) {
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, $2, 'system', $3::jsonb)`,
    [proposalId, ACTION_BY_OUTCOME[outcome], JSON.stringify(details || {})]
  );
}

async function settleExtension({ extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!SETTLE_OUTCOMES.has(outcome)) {
    throw new Error(`settleExtension: invalid outcome '${outcome}'`);
  }
  // Own transaction: claim + duration bump + shift sync + log are ONE atomic
  // unit, and every query goes through the held client (CLAUDE.md one-pooled-
  // connection rule). A first draft ran these as four separate pool statements,
  // so a failure after the claim left a row marked paid on an event that was
  // never extended.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await settleInTx(client, { extensionId, outcome, actorUserId, overrideReason });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

async function settleInTx(client, { extensionId, outcome, actorUserId, overrideReason }) {
  // LOCK ORDER, load-bearing: proposals FIRST, then service_extensions.
  //
  // The create route (Task 7) locks `proposals` FOR UPDATE and then inserts into
  // service_extensions. If this function claimed the extension row first and then
  // updated proposals, the two paths would take the same two locks in opposite
  // orders, which is an ABBA deadlock: create holds the proposal lock and waits
  // on the pending-row unique index, while settle holds the extension row and
  // waits on the proposal. Postgres would abort one with 40P01. Reading
  // proposal_id unlocked first is safe because an extension row's proposal_id
  // never changes.
  const idRes = await client.query(
    'SELECT proposal_id FROM service_extensions WHERE id = $1',
    [extensionId]
  );
  if (!idRes.rows[0]) return { ok: false, reason: 'not_pending' };
  await client.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [idRes.rows[0].proposal_id]);

  const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
  if (!row) return { ok: false, reason: 'not_pending' };

  const proposalId = row.proposal_id;
  const newDuration = Number(row.requested_duration_hours);
  const previousDuration = Number(row.contracted_duration_hours);

  // The ONE contract mutation. The RETURNING expression parses the free-text
  // event_start_time, so an unparseable value raises 22007 and the whole
  // transaction rolls back, releasing the claim. That is the outcome we want:
  // better an unsettled request the sweep can expire than a row marked paid on
  // an event whose duration never moved. Task 7 refuses to CREATE a request on
  // an unparseable event, so reaching this is a data-drift case.
  const { rows: durRows } = await client.query(
    `UPDATE proposals
        SET event_duration_hours = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING (((event_date::text || ' ' || event_start_time)::timestamp
                   + ($2::numeric * INTERVAL '1 hour'))) AS new_end_ts,
                to_char(((event_date::text || ' ' || event_start_time)::timestamp
                   + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS new_end_display`,
    [proposalId, newDuration]
  );
  const newEndDisplay = durRows[0] ? durRows[0].new_end_display : null;

  // Targeted shift sync, only when the event has exactly one shift row (the
  // same guard syncShiftsFromProposal uses). A multi-shift event is flagged for
  // the admin instead of guessing which shift the extra time belongs to.
  const { rows: countRows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  const shiftCount = countRows[0] ? countRows[0].n : 0;
  const multiShift = shiftCount !== 1;

  if (!multiShift) {
    await client.query(
      `UPDATE shifts
          SET event_duration_hours = $2,
              end_time = COALESCE($3, end_time)
        WHERE proposal_id = $1`,
      [proposalId, newDuration, newEndDisplay]
    );
  }

  const staffUserIds = await assignedStaffUserIds(client, proposalId);

  await logAction(client, proposalId, outcome, {
    extension_id: row.id,
    previous_duration_hours: previousDuration,
    new_duration_hours: newDuration,
    new_end: newEndDisplay,
    amount_cents: row.amount_cents,
    gratuity_cents: row.gratuity_cents,
    multi_shift: multiShift,
    override_by_user_id: outcome === 'overridden' ? actorUserId : undefined,
  });

  return {
    ok: true,
    outcome,
    proposalId,
    shiftId: row.shift_id,
    invoiceId: row.invoice_id,
    staffUserIds,
    previousDurationHours: previousDuration,
    newDurationHours: newDuration,
    newEndDisplay,
    multiShift,
    gratuityCents: Number(row.gratuity_cents) || 0,
    amountCents: Number(row.amount_cents) || 0,
  };
}

async function closeExtension({ extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!CLOSE_OUTCOMES.has(outcome)) {
    throw new Error(`closeExtension: invalid outcome '${outcome}'`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
    if (!row) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_pending' };
    }
    const staffUserIds = await assignedStaffUserIds(client, row.proposal_id);
    await logAction(client, row.proposal_id, outcome, {
      extension_id: row.id,
      requested_duration_hours: Number(row.requested_duration_hours),
      amount_cents: row.amount_cents,
    });
    await client.query('COMMIT');
    return {
      ok: true,
      outcome,
      proposalId: row.proposal_id,
      shiftId: row.shift_id,
      invoiceId: row.invoice_id,
      staffUserIds,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { settleExtension, closeExtension, ACTION_BY_OUTCOME };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSettle.test.js`
Expected: PASS, 7 tests.

If the `users` insert in the fixture fails on a NOT NULL column, run `grep -n "CREATE TABLE IF NOT EXISTS users" -A20 server/db/schema.sql` and add the required columns to the fixture. Do not change the module to accommodate a fixture problem.

- [ ] **Step 5: Register the money-path smoke suites**

The pre-push money gate reads a list file. Add the three new money suites so they run against the isolated Neon branch.

Run: `cat scripts/money-smoke-list.txt`

Append these lines (match the file's existing path style exactly):
```
server/utils/serviceExtensionPricing.test.js
server/utils/serviceExtensionSettle.test.js
server/utils/eventEndInstant.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionSettle.js server/utils/serviceExtensionSettle.test.js scripts/money-smoke-list.txt
git commit -m "feat(ext): settle/close core with a single-winner claim gate

Duration is the only contract column that moves. Claim-on-pending is the race
gate shared by settle, expiry, override and cancel, and a second idempotency
wall behind the webhook's isFirstDelivery."
```

- [ ] **Step 7: NOT the lane gate. Build Task 12a next.**

`ext-core` is NOT finished here. **Go to Task 12 and execute Steps 1 through 6 (12a, the `serviceExtensionPayroll.js` hours module), which belong to this lane** even though Task 12 is physically printed inside the `ext-webhook-payroll` section. `ext-routes` Tasks 8 and 10 import that module, so if `ext-core` merges without it, the next lane hits `MODULE_NOT_FOUND` and cannot create it without leaving its own footprint.

Before that, confirm the three suites written so far pass:

```bash
for f in server/utils/eventEndInstant.test.js server/utils/serviceExtensionPricing.test.js server/utils/serviceExtensionSettle.test.js; do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```
Expected: all PASS. Plus every suite named in Task 2 Step 4 still passing.

The real `ext-core` lane gate is at the end of Task 12 Step 6: four suites total, the 12a `code-review`, then the front-matter fleet.

---

## Lane ext-routes

The three HTTP surfaces (staff request, public accept, admin override/cancel), the notification module they share, the acceptance gate on the existing intent route, and the invoice GET additions.

### Task 6: Notification module

All outbound messaging for the feature, in one place. Three audiences: the client (payment link), the assigned staffers (greenlight or decline), and the admins (request went out, plus the failure shapes).

**Why direct sends and not `enqueueCategorizedMessage`:** the categorized-message path is the house pattern for staff notifications, but its dispatcher runs on a 5-minute interval (`server/index.js`, `RUN_MESSAGE_DISPATCHER_SCHEDULER`). A bartender standing at a bar deciding whether to keep pouring cannot wait 5 minutes for a greenlight, and the decline is the message carrying the insurance warning. So this module sends immediately and owns its own channel gate. That gate must still honor everything the queued path honors: `agreements.sms_consent` for staff (the `messages.js` rule), `users.communication_preferences` opt-outs, and for clients the house gate `shouldSendImmediate` (`messageSuppression.js:22-43`), which checks archived status, prefs `sms_enabled`/`email_enabled`, and `phone_status`/`email_status` bad-contact only. The phone-scoped STOP guard is a consent-WRITE-time rule in `smsConsent.js` (~:126-137), not a send-time check; an inbound STOP is still honored at send time because `applyOptOut` (`smsInbound.js:288-312`) has already flipped `sms_enabled = false` on the matched client row. The code below calls the house gate correctly; this sentence only states precisely what that gate does.

**Files:**
- Create: `server/utils/serviceExtensionNotify.js`

**Interfaces:**
- Consumes: `renderExtensionTerms` (Task 3).
- Produces:
  - `notifyClientOfRequest({ proposalId, invoiceToken, amountCents, newEndDisplay, termsVersion })` → `Promise<{ sms: 'sent'|'skipped', email: 'sent'|'skipped', reachable: boolean }>`
  - `notifyStaffOfOutcome({ staffUserIds, outcome, newEndDisplay, contractedEndDisplay, proposalId })` → `Promise<{ notified: number[], unreachable: number[] }>`; `outcome` is `'approved' | 'declined'`. Channel fallback per staffer is SMS (if `agreements.sms_consent`), then web push, then email, matching spec §10.
  - `alertAdminsRequestSent({ proposalId, newEndDisplay, amountCents, requesterUserId, clientReachable })` → `Promise<void>`
  - `alertAdminsProblem({ proposalId, kind, detail })` → `Promise<void>`; `kind` in `'client_unreachable' | 'multi_shift' | 'paid_after_expiry' | 'paid_extension_stranded' | 'settle_on_closed_event' | 'staff_unreachable' | 'payroll_hours_locked'`. `paid_after_expiry` and `paid_extension_stranded` also fire an SMS: both mean DRB is holding money for time that was not authorized or not delivered.

- [ ] **Step 1: Confirm the copy constants and the consent columns exist**

Run:
```bash
grep -n "sms_consent" server/db/schema.sql | head -3
grep -n "PUBLIC_SITE_URL\|ADMIN_URL" server/utils/urls.js
```
Expected: `agreements.sms_consent` exists; `urls.js` exports both. The client invoice link is built from `PUBLIC_SITE_URL` (client-facing token URLs), matching how invoice links are already sent.

Run: `grep -rn "invoice/\${" server/utils/*.js | head -5` to copy the exact existing invoice-link shape rather than inventing a path.

- [ ] **Step 2: Write the module**

Create `server/utils/serviceExtensionNotify.js`:

```javascript
'use strict';

/**
 * Every outbound message for an on-site service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 10.
 *
 * Sends are IMMEDIATE and direct, not queued through
 * enqueueCategorizedMessage, because that path's dispatcher runs every 5
 * minutes and a bartender waiting to know whether to keep pouring cannot wait
 * that long. The trade is that this module owns its own channel gate, which
 * must honor exactly what the queued path honors:
 *   - staff: agreements.sms_consent (the messages.js rule) + users.communication_preferences
 *   - client: shouldSendImmediate (comm prefs + bad-contact + archived)
 *
 * NEVER call this inside a transaction. Every send helper takes its own pooled
 * connection, so holding one here would deadlock the pool under load
 * (CLAUDE.md one-pooled-connection rule). Callers release first, then notify.
 *
 * Copy rule: no em dashes anywhere in this file's message strings.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const { shouldSendImmediate } = require('./messageSuppression');
const { notifyAdminCategory } = require('./adminNotifications');
const { sendPush } = require('./pushSender');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');
const { PUBLIC_SITE_URL, ADMIN_URL, STAFF_URL } = require('./urls');

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/** Never let a notification failure escape into a money path. */
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'service-extension', notify: label } });
    }
    console.error(`[serviceExtensionNotify] ${label} failed (non-blocking):`, err.message);
    return null;
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

async function notifyClientOfRequest({ proposalId, invoiceToken, amountCents, newEndDisplay, termsVersion }) {
  const { rows } = await pool.query(
    `SELECT p.status,
            c.id AS client_id, c.name, c.email, c.phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) return { sms: 'skipped', email: 'skipped', reachable: false };
  const row = rows[0];
  const proposal = { status: row.status };
  const client = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  const link = `${PUBLIC_SITE_URL}/invoice/${invoiceToken}`;
  // renderExtensionTerms THROWS on an unknown version by design. This runs in
  // an unwrapped post-commit tail, so an uncaught throw here would 500 a request
  // whose invoice and extension row are already committed. Degrade to the SMS
  // leg (which does not need the terms text) and let the invoice page render the
  // terms; the page has its own fallback for the same case.
  let terms = null;
  try {
    terms = renderExtensionTerms({ version: termsVersion, newEndDisplay });
  } catch (copyErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(copyErr, { tags: { feature: 'service-extension', step: 'terms_render_notify' } });
    }
    console.error('[serviceExtensionNotify] unknown terms version:', termsVersion, copyErr.message);
  }
  const priced = Number(amountCents) > 0 ? ` (${money(amountCents)})` : ' (included in your package)';

  let smsResult = 'skipped';
  const smsGate = await shouldSendImmediate({ proposal, client, channel: 'sms' });
  if (smsGate.ok && row.phone) {
    const sent = await safe('client_sms', () => sendAndLogSms({
      to: row.phone,
      body: `Dr. Bartender: your bartender asked to extend bar service to ${newEndDisplay}${priced}. Review and confirm here: ${link}`,
      clientId: row.client_id,
      proposalId,
      messageType: 'service_extension_request',
      recipientName: row.name || null,
    }));
    if (sent && sent.status !== 'skipped') smsResult = 'sent';
  }

  let emailResult = 'skipped';
  const emailGate = await shouldSendImmediate({ proposal, client, channel: 'email' });
  if (emailGate.ok && row.email && terms) {
    const paragraphs = terms.paragraphs.map((t) => `<p>${t}</p>`).join('');
    const sent = await safe('client_email', () => sendEmail({
      to: row.email,
      subject: `Extend bar service to ${newEndDisplay}?`,
      html: `<h2>${terms.headline}</h2>${paragraphs}
             <p><strong>${Number(amountCents) > 0 ? money(amountCents) : 'No additional charge'}</strong></p>
             <p><a href="${link}">Review and confirm</a></p>`,
      text: [terms.headline, ...terms.paragraphs,
        Number(amountCents) > 0 ? money(amountCents) : 'No additional charge',
        `Review and confirm: ${link}`].join('\n\n'),
      meta: { proposalId, messageType: 'service_extension_request' },
    }));
    if (sent) emailResult = 'sent';
  }

  return {
    sms: smsResult,
    email: emailResult,
    reachable: smsResult === 'sent' || emailResult === 'sent',
  };
}

// ─── Staff ─────────────────────────────────────────────────────────────────

const STAFF_COPY = Object.freeze({
  approved: ({ newEndDisplay }) =>
    `Dr. Bartender: approved. Bar service now runs to ${newEndDisplay}. Your hours are updated, nothing else to do.`,
  declined: ({ contractedEndDisplay }) =>
    `Dr. Bartender: additional time was not approved. Bar service ends at ${contractedEndDisplay} as contracted. Serving past that is not DRB work and is not covered by DRB insurance. Do not accept payment from the client directly.`,
});

async function notifyStaffOfOutcome({ staffUserIds, outcome, newEndDisplay, contractedEndDisplay, proposalId }) {
  const ids = (staffUserIds || []).filter(Number.isInteger);
  if (ids.length === 0) return { notified: [], unreachable: [] };
  if (!STAFF_COPY[outcome]) throw new Error(`notifyStaffOfOutcome: invalid outcome '${outcome}'`);

  const body = STAFF_COPY[outcome]({ newEndDisplay, contractedEndDisplay });
  const subject = outcome === 'approved'
    ? `Bar service extended to ${newEndDisplay}`
    : 'Additional time was not approved';

  // sms_consent is the staff SMS gate (messages.js). LEFT JOIN so a staffer
  // with no agreements row is push/email-only rather than silently dropped.
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences AS prefs,
            u.staff_notification_preferences AS staff_prefs,
            cp.phone, COALESCE(ag.sms_consent, false) AS sms_consent
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN agreements ag ON ag.user_id = u.id
      WHERE u.id = ANY($1)`,
    [ids]
  );

  const notified = [];
  const unreachable = [];

  for (const r of rows) {
    const prefs = r.prefs || {};
    let delivered = false;

    if (r.sms_consent && prefs.sms_enabled !== false && r.phone) {
      const sent = await safe(`staff_sms_${r.id}`, () => sendAndLogSms({
        to: r.phone,
        body,
        clientId: null,
        proposalId,
        messageType: `service_extension_${outcome}`,
      }));
      if (sent && sent.status !== 'skipped') delivered = true;
    }

    // Web push, the middle rung of the spec's SMS -> push -> email fallback.
    // sendPush takes a subscription directly, so no scheduled_messages row is
    // needed and there is no dispatcher latency. Attempted whenever SMS did not
    // land, which is exactly when a staffer without consent needs another rung.
    if (!delivered) {
      const subs = Array.isArray(r.staff_prefs?.push_subscriptions) ? r.staff_prefs.push_subscriptions : [];
      for (const sub of subs) {
        const pushed = await safe(`staff_push_${r.id}`, () => sendPush({
          subscription: { endpoint: sub.endpoint, keys: sub.keys },
          title: subject,
          body,
          url: `${STAFF_URL}/shifts`,
        }));
        // sendPush NEVER throws: it RESOLVES with { ok: false, gone } or
        // { ok: false, error: 'vapid_unset' } on failure (pushSender.js:46-66).
        // So a truthiness check would count every failure as a delivery, which
        // would suppress the staff_unreachable alert on exactly the decline
        // message that carries the insurance warning. Test ok === true.
        if (pushed?.ok === true) { delivered = true; break; }
      }
    }

    if (prefs.email_enabled !== false && r.email) {
      const sent = await safe(`staff_email_${r.id}`, () => sendEmail({
        to: r.email,
        subject,
        html: `<p>${body}</p>`,
        text: body,
        meta: { proposalId, messageType: `service_extension_${outcome}` },
      }));
      if (sent) delivered = true;
    }

    if (delivered) notified.push(r.id);
    else unreachable.push(r.id);
  }

  // A staffer who got neither message is a real problem for the DECLINE case:
  // that message carries the insurance warning and must not vanish silently.
  if (unreachable.length > 0) {
    await alertAdminsProblem({
      proposalId,
      kind: 'staff_unreachable',
      detail: `No channel reached staff user id(s) ${unreachable.join(', ')} for the "${outcome}" message. Contact them directly.`,
    });
  }

  return { notified, unreachable };
}

// ─── Admin ─────────────────────────────────────────────────────────────────

async function alertAdminsRequestSent({ proposalId, newEndDisplay, amountCents, requesterUserId, clientReachable }) {
  await safe('admin_request_sent', async () => {
    const reach = clientReachable ? '' : ' The client could not be reached on any channel, so you may need to relay the link.';
    const line = `A bartender asked to extend event #${proposalId} to ${newEndDisplay} for ${money(amountCents)}. The client has been sent the confirmation link.${reach}`;
    await notifyAdminCategory({
      category: 'routine_admin',
      subject: `Extension requested: event #${proposalId} to ${newEndDisplay}`,
      emailHtml: `<p>${line}</p><p>Requested by staff user id ${requesterUserId}.</p>
                  <p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} Requested by staff user id ${requesterUserId}. ${ADMIN_URL}/events/${proposalId}`,
    });
  });
}

const PROBLEM_SUBJECTS = Object.freeze({
  client_unreachable: 'Extension link could not be delivered',
  paid_extension_stranded: 'A PAID extension was never applied: settle or refund it',
  multi_shift: 'Extension on a multi-shift event needs a manual shift edit',
  paid_after_expiry: 'An extension was paid after it expired: refund needed',
  settle_on_closed_event: 'An extension settled on a completed or archived event',
  staff_unreachable: 'Could not reach a staffer with an extension outcome',
  payroll_hours_locked: 'Extension hours could not be added to payroll automatically',
});

async function alertAdminsProblem({ proposalId, kind, detail }) {
  await safe(`admin_problem_${kind}`, async () => {
    const subject = PROBLEM_SUBJECTS[kind] || 'Service extension needs attention';
    const line = `Event #${proposalId}: ${detail}`;
    await notifyAdminCategory({
      // These two mean DRB is holding money for time that was not authorized or
      // not delivered, so they are urgent rather than routine.
      category: (kind === 'paid_after_expiry' || kind === 'paid_extension_stranded')
        ? 'urgent_client_reply' : 'routine_admin',
      subject: `${subject} (event #${proposalId})`,
      emailHtml: `<p>${line}</p><p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} ${ADMIN_URL}/events/${proposalId}`,
      ...((kind === 'paid_after_expiry' || kind === 'paid_extension_stranded') ? { smsBody: line } : {}),
    });
  });
}

module.exports = {
  notifyClientOfRequest,
  notifyStaffOfOutcome,
  alertAdminsRequestSent,
  alertAdminsProblem,
  STAFF_COPY,
};
```

- [ ] **Step 3: Verify the imports resolve and the copy rule holds**

Run:
```bash
node -e "
const m=require('/home/drbartender/projects/os/server/utils/serviceExtensionNotify');
console.log(Object.keys(m).join(','));
const a=m.STAFF_COPY.approved({newEndDisplay:'11:00 PM'});
const d=m.STAFF_COPY.declined({contractedEndDisplay:'10:00 PM'});
console.log(a); console.log(d);
if((a+d).includes('—')) throw new Error('em dash in staff copy');
console.log('OK');
"
```
Expected: the five exports, both messages, `OK`. If `PUBLIC_SITE_URL` or `ADMIN_URL` is not exported from `urls.js`, run `grep -n "module.exports" -A8 server/utils/urls.js` and use the names that are actually exported.

- [ ] **Step 4: Verify `notifyAdminCategory` accepts the categories used**

Run: `node -e "console.log([...require('/home/drbartender/projects/os/server/utils/adminNotifications').VALID_CATEGORIES])"`

Expected: the list includes `routine_admin` and `urgent_client_reply`. If `urgent_client_reply` reads wrong for a money problem, pick the closest urgent category from the printed list and update `alertAdminsProblem`. Do not add a new category in this task.

- [ ] **Step 5: Commit**

```bash
git add server/utils/serviceExtensionNotify.js
git commit -m "feat(ext): service-extension notifications (client link, staff outcome, admin alerts)

Immediate direct sends rather than the categorized-message queue: the queued
dispatcher runs every 5 minutes and a bartender waiting on a greenlight cannot.
Owns its own channel gate honoring sms_consent and both prefs sets."
```

### Task 7: Staff request endpoint

The security-critical surface. `auth` alone is NOT sufficient: the known onboarding self-promotion hole means an authenticated account is not necessarily real staff on this job. Without the assignment predicate, any account could POST an arbitrary `shift_id` and fire a real SMS and a payable invoice at a real client.

**Files:**
- Create: `server/routes/serviceExtensions/create.js`
- Create: `server/routes/serviceExtensions/index.js`
- Create: `server/routes/serviceExtensions/publicAccept.js` (stub here, real in Task 8)
- Create: `server/routes/serviceExtensions/admin.js` (stub here, real in Task 10)
- Modify: `server/middleware/rateLimiters.js` (one new limiter)
- Modify: `server/index.js` (mount)
- Test: `server/routes/serviceExtensions/create.test.js`

**Interfaces:**
- Consumes: `computeExtensionDelta`, `MAX_EXTENSION_HOURS` (Task 4); `CURRENT_EXTENSION_TERMS_VERSION` (Task 3); `SERVICE_EXTENSION_INVOICE_LABEL` (Task 2); `notifyClientOfRequest`, `alertAdminsRequestSent`, `alertAdminsProblem` (Task 6); `eventEndInstantForDuration` (Task 1).
- Produces:
  - `GET /api/service-extensions/eligibility/:shiftId` → `{ eligible, reason, contractedEndDisplay, contractedDurationHours, maxEndDisplay, maxAdditionalHours, stepLabels, isHosted, isClass, pending }`. NO price. `contractedDurationHours` and `stepLabels` exist because Task 14's picker needs a base value and human labels; both are times and durations, never money.
  - `POST /api/service-extensions` body `{ shiftId, requestedEndHours, hostedProductConfirmed }` → `201 { id, status: 'pending', requestedEndTime, clientNotified }`. NO price.
  - `server/routes/serviceExtensions/index.js` composition router.
  - `serviceExtensionLimiter` exported from `server/middleware/rateLimiters.js`.

**AUTH ORDERING, load-bearing.** Do NOT put `router.use(auth)` at the top of `create.js`. A pathless `router.use` runs for every request entering the sub-router, and because the composition router mounts each sibling at `'/'`, that would apply `auth` to the PUBLIC accept route in Task 8 and 401 every client trying to pay. That defect is authored here and only fails in Task 8's suite, so it is easy to miss. Attach `auth` per route instead.

- [ ] **Step 1: Write the failing test**

Create `server/routes/serviceExtensions/create.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');

// Silence real sends: stub the notify module BEFORE the router requires it.
const notify = require('../../utils/serviceExtensionNotify');
notify.notifyClientOfRequest = async () => ({ sms: 'sent', email: 'sent', reachable: true });
notify.alertAdminsRequestSent = async () => {};
notify.alertAdminsProblem = async () => {};

const { AppError } = require('../../utils/errors');
const router = require('./index');

const NONCE = `sxc-${Date.now()}`;
let app, server, baseUrl;
let clientId, pkgId, onStaffId, otherStaffId, proposalId, shiftId;
const tokens = {};
const cleanup = { proposals: [], shifts: [], users: [] };

// auth reads decoded.userId and compares decoded.tokenVersion to
// users.token_version. Signing { id, role } 401s every request.
function tokenFor(userId) {
  return tokens[userId];
}

async function post(body, userId) {
  return fetch(`${baseUrl}/api/service-extensions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/service-extensions', router);
  // No server/middleware/errorHandler module exists; the global handler is
  // inline in server/index.js, so route suites hand-roll it. Precedent:
  // server/routes/invoices.extrasVoid.test.js:107-111.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  const c = await pool.query('INSERT INTO clients (name, email, phone) VALUES ($1,$2,$3) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`, '3125550100']);
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;

  for (const key of ['on', 'other']) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1,'x','staff','approved',0) RETURNING id, token_version`,
      [`${NONCE}-${key}@example.test`]
    );
    const id = u.rows[0].id;
    cleanup.users.push(id);
    tokens[id] = jwt.sign(
      { userId: id, tokenVersion: u.rows[0].token_version },
      process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    if (key === 'on') onStaffId = id; else otherStaffId = id;
  }
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40)`,
    [onStaffId, `${NONCE} on`]
  );

  // Event happening RIGHT NOW so the request window is open: start 1 hour ago,
  // 4 hour duration. event_start_time is free text, as in production.
  const now = new Date();
  const startLocal = new Date(now.getTime() - 60 * 60 * 1000);
  const hh = startLocal.getHours();
  const startDisplay = `${hh % 12 === 0 ? 12 : hh % 12}:00 ${hh >= 12 ? 'PM' : 'AM'}`;
  const dateStr = startLocal.toISOString().slice(0, 10);

  const pr = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'balance_paid',100,4,1,350,350,$3,$4,'America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, pkgId, dateStr, startDisplay]
  );
  proposalId = pr.rows[0].id;
  cleanup.proposals.push(proposalId);

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                         event_duration_hours, positions_needed, client_name)
     VALUES ($1,$2,'11:00 PM','open',$3,4,'["Bartender"]',$4) RETURNING id`,
    [dateStr, startDisplay, proposalId, `${NONCE} client`]
  );
  shiftId = sh.rows[0].id;
  cleanup.shifts.push(shiftId);

  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1,$2,'approved','Bartender')",
    [shiftId, onStaffId]
  );
});

after(async () => {
  await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [cleanup.proposals]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  server.close();
  await pool.end();
});

test('rejects an unauthenticated request', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, null);
  assert.equal(res.status, 401);
});

test('rejects an authenticated staffer who is NOT assigned to this shift', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, otherStaffId);
  assert.equal(res.status, 403);
  const rows = await pool.query('SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1', [proposalId]);
  assert.equal(rows.rows[0].n, 0, 'no row may be created for a non-assigned caller');
});

test('an assigned staffer creates a pending request, and the response carries NO price', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, onStaffId);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'pending');
  const serialized = JSON.stringify(body);
  for (const leak of ['amount', 'cents', 'price', 'gratuity', 'total']) {
    assert.ok(!serialized.toLowerCase().includes(leak), `response leaked "${leak}": ${serialized}`);
  }

  const ext = await pool.query(
    'SELECT status, amount_cents, gratuity_cents, invoice_id, terms_version, expires_at FROM service_extensions WHERE proposal_id = $1',
    [proposalId]
  );
  assert.equal(ext.rowCount, 1);
  assert.equal(ext.rows[0].status, 'pending');
  assert.equal(ext.rows[0].amount_cents, 5000);
  assert.ok(ext.rows[0].invoice_id, 'an invoice must be minted');
  assert.ok(ext.rows[0].terms_version, 'terms version must be stamped');

  const inv = await pool.query('SELECT label, status, amount_due, token FROM invoices WHERE id = $1', [ext.rows[0].invoice_id]);
  assert.equal(inv.rows[0].label, 'Service Extension');
  assert.equal(inv.rows[0].status, 'sent', 'a draft invoice is not payable');
  assert.equal(inv.rows[0].amount_due, 5000);
  assert.ok(inv.rows[0].token);

  const li = await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1', [ext.rows[0].invoice_id]);
  assert.equal(li.rowCount, 1);
  assert.match(li.rows[0].description, /Additional bar service/);
  assert.equal(li.rows[0].line_total, 5000);

  // Side money: the contract did not move.
  const prop = await pool.query('SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');
});

test('a second concurrent request collides instead of double-charging', async () => {
  const res = await post({ shiftId, requestedEndHours: 5 }, onStaffId);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(JSON.stringify(body), /already/i);
  const rows = await pool.query("SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1 AND status = 'pending'", [proposalId]);
  assert.equal(rows.rows[0].n, 1);
});

test('rejects over the cap and non-30-minute increments', async () => {
  await pool.query("UPDATE service_extensions SET status = 'expired' WHERE proposal_id = $1", [proposalId]);
  assert.equal((await post({ shiftId, requestedEndHours: 8 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 4.25 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 3.5 }, onStaffId)).status, 400);
});

test('eligibility read carries the end times and no price', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(onStaffId)}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.contractedEndDisplay);
  assert.ok(body.maxEndDisplay);
  const serialized = JSON.stringify(body).toLowerCase();
  for (const leak of ['amount', 'cents', 'price']) {
    assert.ok(!serialized.includes(leak), `eligibility leaked "${leak}"`);
  }
});

test('eligibility is refused for a non-assigned staffer', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(otherStaffId)}` },
  });
  assert.equal(res.status, 403);
});

test('the router does NOT apply auth to sibling public paths', async () => {
  // Regression guard for the auth-ordering defect authored in this task: a
  // pathless router.use(auth) in create.js would 401 the public accept route
  // that Task 8 mounts on the same router, breaking client payment entirely.
  // The stub returns 404 today; the ONLY unacceptable answer is 401.
  const res = await fetch(
    `${baseUrl}/api/service-extensions/t/11111111-1111-1111-1111-111111111111/accept`,
    { method: 'POST' }
  );
  assert.notEqual(res.status, 401, 'auth leaked onto the public accept path');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/create.test.js`
Expected: FAIL, cannot find `./index`.

Expected test count once passing: 8.

- [ ] **Step 3: Write the composition router**

Create `server/routes/serviceExtensions/index.js`:

```javascript
'use strict';

/**
 * Service-extension routes (spec 2026-07-25).
 *
 * Per-concern split behind a composition router, matching server/routes/proposals/.
 * Mounted at /api/service-extensions in server/index.js.
 *
 * Auth differs per file, so `auth` is applied inside each one rather than at
 * this router level:
 *   create.js       - staff, auth + assigned-to-this-shift predicate
 *   publicAccept.js - PUBLIC, invoice-token gated (no auth)
 *   admin.js        - auth + admin/manager
 */

const express = require('express');
const router = express.Router();

// publicAccept FIRST as belt-and-braces: even if a sibling ever regains a
// pathless `router.use(auth)`, the public client payment path is already
// matched. create.js applies `auth` per route, never at router level, which is
// the actual guarantee.
router.use('/', require('./publicAccept'));
router.use('/', require('./create'));
router.use('/', require('./admin'));

module.exports = router;
```

Note: `publicAccept.js` and `admin.js` arrive in Tasks 8 and 10. To keep this task's test runnable now, create both as one-line stubs that will be replaced:

```javascript
// server/routes/serviceExtensions/publicAccept.js  (stub, replaced in Task 8)
'use strict';
module.exports = require('express').Router();
```

```javascript
// server/routes/serviceExtensions/admin.js  (stub, replaced in Task 10)
'use strict';
module.exports = require('express').Router();
```

- [ ] **Step 4: Write the create route**

Create `server/routes/serviceExtensions/create.js`:

```javascript
'use strict';

/**
 * Staff-initiated service-extension request (spec 2026-07-25 section 5.1).
 *
 * SECURITY: `auth` alone is NOT sufficient. The onboarding self-promotion hole
 * means an authenticated account is not necessarily real staff, so every
 * endpoint here requires the same predicate the staff home uses:
 *   sr.user_id = req.user.id AND sr.shift_id = $ AND sr.status = 'approved'
 *   AND sr.dropped_at IS NULL
 * Without it, any account could POST an arbitrary shift_id and fire a real SMS
 * plus a payable invoice at a real client.
 *
 * STAFF NEVER SEE THE PRICE (spec decision 2). No response in this file may
 * contain amount_cents, gratuity_cents, or any dollar figure. Every response
 * body is built from an explicit field list, never by spreading a DB row.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { serviceExtensionLimiter } = require('../../middleware/rateLimiters');
const { ValidationError, ConflictError, PermissionError, NotFoundError } = require('../../utils/errors');
const { createInvoice, writeLineItems } = require('../../utils/invoiceHelpers');
const { SERVICE_EXTENSION_INVOICE_LABEL } = require('../../utils/proposalMoneyShared');
const { computeExtensionDelta, MAX_EXTENSION_HOURS } = require('../../utils/serviceExtensionPricing');
const { eventEndInstantForDuration } = require('../../utils/eventEndInstant');
const { CURRENT_EXTENSION_TERMS_VERSION } = require('../../data/extensionTermsCopy');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

// NO router-level `auth`. This router is mounted at '/' alongside the PUBLIC
// accept router, so a pathless router.use(auth) would 401 the client payment
// path. `auth` is attached per route below.

// Grace after the contracted end during which a request may still be OPENED.
const REQUEST_GRACE_MINUTES = 15;
// How long a pending request stays payable after the contracted end. Longer than
// the open-grace on purpose: a request created at end+14min must not expire 60
// seconds later, before the client can even read the text.
const EXPIRY_GRACE_MINUTES = 30;

/**
 * Resolve the caller's assignment to this shift, or throw. Returns the shift +
 * proposal context every handler needs.
 */
async function requireAssignment(req, shiftId) {
  // s.status != 'cancelled' matches the canonical assignment predicates
  // (eventDetailsPayload.js:113, 149-150; eventDetails.js:130). Without it a
  // staffer on a cancelled shift of a live proposal could still open an
  // extension request.
  const { rows } = await pool.query(
    `SELECT s.id AS shift_id, s.proposal_id, s.event_date, s.start_time,
            p.event_duration_hours, p.status AS proposal_status, p.package_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id AND s.status != 'cancelled'
       JOIN proposals p ON p.id = s.proposal_id
      WHERE sr.user_id = $1
        AND sr.shift_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
      LIMIT 1`,
    [req.user.id, shiftId]
  );
  if (!rows[0]) {
    // Deliberately not distinguishing "no such shift" from "not your shift":
    // a caller who is not on the job learns nothing either way.
    throw new PermissionError('You are not assigned to this event.');
  }
  return rows[0];
}

/** Window check: event start through contracted end + grace, as instants. */
async function checkWindow(ctx) {
  const end = await eventEndInstantForDuration(pool, ctx.proposal_id, Number(ctx.event_duration_hours));
  if (!end) return { ok: false, code: 'unparseable_shift_time', message: 'Could not determine this event’s start time. Contact management.' };
  const now = Date.now();
  if (now < new Date(end.startInstant).getTime()) {
    return { ok: false, code: 'too_early', message: 'You can request more time once the event has started.' };
  }
  const deadline = new Date(end.endInstant).getTime() + REQUEST_GRACE_MINUTES * 60 * 1000;
  if (now > deadline) {
    return { ok: false, code: 'too_late', message: 'The window to request more time for this event has closed.' };
  }
  return { ok: true, end };
}

/** GET /api/service-extensions/eligibility/:shiftId */
router.get('/eligibility/:shiftId', auth, asyncHandler(async (req, res) => {
  const shiftId = Number(req.params.shiftId);
  if (!Number.isInteger(shiftId)) throw new ValidationError({ shiftId: 'Invalid shift.' });
  const ctx = await requireAssignment(req, shiftId);

  const contracted = Number(ctx.event_duration_hours);
  const [end, maxEnd, pendingRes, pkgRes] = await Promise.all([
    eventEndInstantForDuration(pool, ctx.proposal_id, contracted),
    eventEndInstantForDuration(pool, ctx.proposal_id, contracted + MAX_EXTENSION_HOURS),
    pool.query(
      `SELECT requested_end_time, status FROM service_extensions
        WHERE proposal_id = $1 AND status = 'pending' LIMIT 1`,
      [ctx.proposal_id]
    ),
    pool.query('SELECT pricing_type, bar_type FROM service_packages WHERE id = $1', [ctx.package_id]),
  ]);

  const window = await checkWindow(ctx);
  const pkg = pkgRes.rows[0] || {};

  // Human labels for the picker, one per 30-minute step. Times and durations
  // only: no money, so spec decision 2 still holds.
  const stepLabels = {};
  for (let i = 1; i <= Math.round(MAX_EXTENSION_HOURS / 0.5); i++) {
    const added = i * 0.5;
    const e = await eventEndInstantForDuration(pool, ctx.proposal_id, contracted + added);
    if (e) stepLabels[String(added)] = `${e.endDisplay} (+${added === 0.5 ? '30 min' : added + ' hr'})`;
  }

  res.json({
    eligible: window.ok && pendingRes.rowCount === 0,
    reason: !window.ok ? window.code : (pendingRes.rowCount > 0 ? 'already_pending' : null),
    contractedEndDisplay: end ? end.endDisplay : null,
    contractedDurationHours: contracted,
    stepLabels,
    maxEndDisplay: maxEnd ? maxEnd.endDisplay : null,
    maxAdditionalHours: MAX_EXTENSION_HOURS,
    // Hosted packages need the product confirmation tick before sending.
    isHosted: pkg.pricing_type === 'per_guest',
    isClass: pkg.bar_type === 'class',
    pending: pendingRes.rows[0]
      ? { requestedEndTime: pendingRes.rows[0].requested_end_time, status: pendingRes.rows[0].status }
      : null,
  });
}));

/** POST /api/service-extensions */
router.post('/', auth, serviceExtensionLimiter, asyncHandler(async (req, res) => {
  const shiftId = Number(req.body?.shiftId);
  const requestedEndHours = Number(req.body?.requestedEndHours);
  const hostedProductConfirmed = req.body?.hostedProductConfirmed === true;

  if (!Number.isInteger(shiftId)) throw new ValidationError({ shiftId: 'Invalid shift.' });
  if (!Number.isFinite(requestedEndHours)) {
    throw new ValidationError({ requestedEndHours: 'Choose a new end time.' });
  }

  const ctx = await requireAssignment(req, shiftId);
  if (['archived', 'completed'].includes(ctx.proposal_status)) {
    throw new ConflictError('This event is closed.', 'EVENT_CLOSED');
  }

  const window = await checkWindow(ctx);
  if (!window.ok) throw new ConflictError(window.message, window.code);

  // PRE-FLIGHT price, for validation and the hosted-confirmation gate only. The
  // authoritative price is recomputed inside the transaction below with the
  // proposal row locked; see the note there.
  const delta = await computeExtensionDelta({
    client: pool, proposalId: ctx.proposal_id, requestedDurationHours: requestedEndHours,
  });
  if (!delta.ok) {
    const messages = {
      not_an_extension: 'Pick an end time later than the contracted one.',
      over_cap: `You can add at most ${MAX_EXTENSION_HOURS} hours. Contact management for more.`,
      bad_increment: 'Pick a time on a 30 minute mark.',
      unparseable_time: 'Could not determine this event’s times. Contact management.',
      missing_package: 'This event cannot be priced online. Contact management.',
      missing_proposal: 'This event cannot be priced online. Contact management.',
    };
    throw new ValidationError({ requestedEndHours: messages[delta.reason] || 'That end time is not available.' });
  }
  if (delta.isHosted && !hostedProductConfirmed) {
    throw new ValidationError({
      hostedProductConfirmed: 'Confirm you have the product to serve the extra time.',
    });
  }

  const dbClient = await pool.connect();
  let created;
  let invoiceToken;
  let sent; // { amountCents, requestedEndDisplay } from the LOCKED reprice
  try {
    await dbClient.query('BEGIN');

    // Lock the proposal and RE-PRICE inside the transaction. The pre-flight
    // delta above was computed against an unlocked read, and the partial unique
    // index only blocks a second PENDING row: once a first extension SETTLES,
    // the index frees up while this request still holds a stale baseline. Two
    // staffers both computing from 4h could then have the first settle to 4.5h
    // and the second insert a 4h-to-5h delta, overcharging the client for a half
    // hour they already paid for and recording a contracted baseline that never
    // existed. FOR UPDATE serialises against settleExtension's own transaction.
    //
    // LOCK ORDER: proposals FIRST, then service_extensions (the INSERT below).
    // settleInTx takes the same two locks in the same order for exactly this
    // reason; reversing either side is an ABBA deadlock (40P01).
    await dbClient.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [ctx.proposal_id]);
    const priced = await computeExtensionDelta({
      client: dbClient, proposalId: ctx.proposal_id, requestedDurationHours: requestedEndHours,
    });
    if (!priced.ok) {
      // The duration moved under us and the requested end is no longer a valid
      // extension (e.g. another request already reached or passed it).
      await dbClient.query('ROLLBACK');
      throw new ConflictError(
        'This event was just extended by another request. Reload and pick a new end time.',
        'EXTENSION_BASELINE_MOVED'
      );
    }
    if (Number(priced.contractedDurationHours) !== Number(delta.contractedDurationHours)) {
      await dbClient.query('ROLLBACK');
      throw new ConflictError(
        'This event was just extended by another request. Reload and pick a new end time.',
        'EXTENSION_BASELINE_MOVED'
      );
    }

    // `priced` is authoritative from here on: it was computed under the row
    // lock. Destructured so nothing below can accidentally reach for the
    // pre-flight `delta` and persist a stale baseline or a stale amount.
    const {
      amountCents, gratuityDeltaCents, contractedEndDisplay, requestedEndDisplay,
      contractedDurationHours, requestedDurationHours, contractedEndInstant, isHosted,
    } = priced;

    const invoice = await createInvoice({
      proposalId: ctx.proposal_id,
      label: SERVICE_EXTENSION_INVOICE_LABEL,
      amountDueCents: amountCents,
      // 'sent', never 'draft': create-intent-for-invoice only accepts
      // sent/partially_paid, so a draft extension invoice would be unpayable.
      status: 'sent',
    }, dbClient);

    await writeLineItems(invoice.id, [{
      description: `Additional bar service, ${contractedEndDisplay} to ${requestedEndDisplay}`,
      quantity: 1,
      unit_price: amountCents,
      line_total: amountCents,
      // 'fee', NOT a new value. invoice_line_items.source_type carries
      // CHECK (source_type IN ('package','addon','fee','manual')) at
      // schema.sql:2004, so 'service_extension' would raise 23514 on
      // every single request, and the catch below only special-cases 23505.
      // The extension is identified by the invoice's LABEL, not by this column.
      source_type: 'fee',
      source_id: null,
    }], dbClient);

    // Payable until the contracted end + EXPIRY_GRACE_MINUTES, floored at
    // 15 minutes from NOW so a request opened late in the open-grace window
    // still gets a usable life instead of expiring on the next sweep tick.
    const contractedEndMs = new Date(contractedEndInstant).getTime();
    const expiresAt = new Date(Math.max(
      contractedEndMs + EXPIRY_GRACE_MINUTES * 60 * 1000,
      Date.now() + 15 * 60 * 1000
    ));

    // The partial unique index on (proposal_id) WHERE status='pending' is what
    // makes a concurrent second request a clean 409 instead of a double charge.
    const ins = await dbClient.query(
      `INSERT INTO service_extensions
         (proposal_id, shift_id, requested_by_user_id, invoice_id,
          contracted_end_time, requested_end_time,
          contracted_duration_hours, requested_duration_hours,
          amount_cents, gratuity_cents, hosted_product_confirmed,
          terms_version, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
       RETURNING id, requested_end_time, status`,
      [
        ctx.proposal_id, shiftId, req.user.id, invoice.id,
        contractedEndDisplay, requestedEndDisplay,
        contractedDurationHours, requestedDurationHours,
        amountCents, gratuityDeltaCents,
        isHosted ? hostedProductConfirmed : null,
        CURRENT_EXTENSION_TERMS_VERSION, expiresAt,
      ]
    );
    created = ins.rows[0];
    invoiceToken = invoice.token;
    // Carry the authoritative figures out to the post-commit tail.
    sent = { amountCents, requestedEndDisplay };

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'extension_requested', 'staff', $2, $3::jsonb)`,
      [ctx.proposal_id, req.user.id, JSON.stringify({
        extension_id: created.id,
        requested_end: requestedEndDisplay,
        amount_cents: amountCents,
      })]
    );

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    // 23505 on the partial unique index = another staffer got there first.
    if (err.code === '23505') {
      throw new ConflictError(
        'Another request for this event is already with the client.',
        'EXTENSION_ALREADY_PENDING'
      );
    }
    // 40P01 deadlock / 40001 serialization: the lock order above is designed so
    // this should not happen, but a future caller could reintroduce it. Surface a
    // retryable conflict rather than a 500 so the staffer just taps again.
    if (err.code === '40P01' || err.code === '40001') {
      throw new ConflictError(
        'Someone else was updating this event just now. Tap again.',
        'EXTENSION_CONFLICT_RETRY'
      );
    }
    throw err;
  } finally {
    // Release BEFORE notifying: the notify helpers take their own pooled
    // connections (CLAUDE.md one-pooled-connection rule).
    dbClient.release();
  }

  // Post-commit tail. A send failure must not undo a created request. Uses the
  // LOCKED figures (`sent`), never the pre-flight `delta`: the client must be
  // quoted exactly what the invoice says.
  const reach = await notify.notifyClientOfRequest({
    proposalId: ctx.proposal_id,
    invoiceToken,
    amountCents: sent.amountCents,
    newEndDisplay: sent.requestedEndDisplay,
    termsVersion: CURRENT_EXTENSION_TERMS_VERSION,
  });
  await notify.alertAdminsRequestSent({
    proposalId: ctx.proposal_id,
    newEndDisplay: sent.requestedEndDisplay,
    amountCents: sent.amountCents,
    requesterUserId: req.user.id,
    clientReachable: reach.reachable,
  });
  if (!reach.reachable) {
    await notify.alertAdminsProblem({
      proposalId: ctx.proposal_id,
      kind: 'client_unreachable',
      detail: `The extension link could not be delivered by SMS or email. Relay it manually: /invoice/${invoiceToken}`,
    });
  }

  // Explicit field list. No price, ever (spec decision 2).
  res.status(201).json({
    id: created.id,
    status: created.status,
    requestedEndTime: created.requested_end_time,
    clientNotified: reach.reachable,
  });
}));

module.exports = router;
```

- [ ] **Step 5: Mount the router**

Edit `server/index.js`. Add next to the other feature mounts (order does not matter here since the path prefix is unique):

```javascript
app.use('/api/service-extensions', require('./routes/serviceExtensions'));
```

- [ ] **Step 6: Add the rate limiter BEFORE running the suite**

`create.js` imports `serviceExtensionLimiter`, so the suite cannot load until it exists. Re-read `server/middleware/rateLimiters.js` and copy the construction shape of an existing limiter exactly. Requirements:
- name `serviceExtensionLimiter`, exported from the module's `module.exports`
- 5 requests per hour
- keyed on the authenticated user id, not IP, because several staffers at one venue share an IP. Use `keyGenerator: (req) => String(req.user?.id || req.ip)`; this is why the limiter is attached AFTER `auth` on the route.
- a test-environment skip, because this suite makes several POSTs: `skip: () => process.env.NODE_ENV === 'test'`. Check whether the file already has a house pattern for this (`grep -n "skip:" server/middleware/rateLimiters.js`) and match it; if none exists, add the `skip` option to this limiter only and do not touch the others.

Confirm it loads: `node -e "console.log(typeof require('/home/drbartender/projects/os/server/middleware/rateLimiters').serviceExtensionLimiter)"` → `function`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `NODE_ENV=test node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/create.test.js`
Expected: PASS, 7 tests.

If the 403 tests return 500, the `PermissionError` import name is wrong: check `grep -n "class.*Error" server/utils/errors.js`. If they return 401 instead of 403, the JWT is wrong: re-read "Test harness constraints" at the top of this plan.

- [ ] **Step 8: Commit**

```bash
git add server/routes/serviceExtensions/index.js server/routes/serviceExtensions/create.js \
        server/routes/serviceExtensions/create.test.js server/routes/serviceExtensions/publicAccept.js \
        server/routes/serviceExtensions/admin.js server/index.js server/middleware/rateLimiters.js
git commit -m "feat(ext): staff request endpoint, assignment-gated and price-free

Requires the staff-home assignment predicate rather than trusting auth alone
(the onboarding self-promotion hole), enforces the request window as real
instants, mints a 'sent' Service Extension invoice, and returns an explicit
field list so no dollar figure can reach a staffer."
```

### Task 8: Public terms acceptance, invoice GET additions, and the zero-delta settle

The client-facing surface. Acceptance is recorded server-side, which is the whole point: a client-side-only gate would let the exact client who routes around the system produce an artifact-free payment.

The zero-delta case settles here, because Stripe cannot charge $0 and the coverage artifact matters regardless of price.

**Files:**
- Replace: `server/routes/serviceExtensions/publicAccept.js` (the Task 7 stub)
- Modify: `server/routes/invoices.js` (add extension fields to `GET /t/:token`)
- Test: `server/routes/serviceExtensions/publicAccept.test.js`
- Test: `server/routes/invoices.extension.test.js`

**Interfaces:**
- Consumes: `renderExtensionTerms`, `getExtensionTerms` (Task 3); `settleExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6).
- Produces:
  - `POST /api/service-extensions/t/:token/accept` → `{ accepted: true, requiresPayment: boolean, acceptedAt }`. Idempotent.
  - `GET /api/invoices/t/:token` gains `extension` **nested INSIDE the `invoice` object**, so clients read `data.invoice.extension`. Shape: `{ is_extension: true, status, terms: {headline, paragraphs, version} | null, accepted_at, expires_at, contracted_end_time, requested_end_time, requires_payment, requires_acceptance } | null`.

**RESPONSE SHAPE, load-bearing.** That route returns `res.json({ invoice: { ...invoice, line_items, payments, refunds } })` and `InvoicePage` does `setInvoice(data.invoice)`. A first draft of this plan put `extension` inside `invoice` on the server but had the client read `res.data.extension`, so the terms block never rendered and the payment gate was permanently open, while every server test passed. Server and client must agree: it lives inside `invoice`.

- [ ] **Step 1: Write the accept route**

Create `server/routes/serviceExtensions/publicAccept.js`:

```javascript
'use strict';

/**
 * Public terms acceptance for a service extension (spec section 5.3).
 *
 * PUBLIC, gated by the invoice's UUID token. No auth, so requireUuidToken is
 * mandatory: a non-UUID :token would otherwise reach Postgres as a uuid
 * comparison and raise 22P02 -> 500 (the standing UUID token-guard rule).
 *
 * Acceptance is recorded HERE, server-side, and create-intent-for-invoice
 * refuses an extension invoice until it is stamped (Task 9). A client-side-only
 * gate would let a client who routes around the page pay with no artifact,
 * which is the one thing this feature exists to prevent.
 *
 * Idempotent: re-accepting is a no-op that returns the original timestamp, so a
 * double-tap on a phone cannot rewrite the audit record.
 */

const express = require('express');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { publicLimiter } = require('../../middleware/rateLimiters');
const { requireUuidToken } = require('../../utils/tokens');
const { NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension } = require('../../utils/serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll } = require('../../utils/serviceExtensionPayroll');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** POST /api/service-extensions/t/:token/accept */
router.post(
  '/t/:token/accept',
  requireUuidToken('token', 'This request is no longer available'),
  publicLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT se.id, se.status, se.amount_cents, se.client_accepted_at,
              se.contracted_end_time, se.requested_end_time, se.expires_at,
              se.proposal_id, p.status AS proposal_status
         FROM service_extensions se
         JOIN invoices i ON i.id = se.invoice_id
         JOIN proposals p ON p.id = se.proposal_id
        WHERE i.token = $1 AND i.status <> 'void'`,
      [req.params.token]
    );
    const ext = rows[0];
    if (!ext) throw new NotFoundError('This request is no longer available');

    if (ext.status !== 'pending') {
      // Already settled/expired: report the terminal state rather than
      // pretending acceptance is still meaningful.
      if (ext.client_accepted_at) {
        return res.json({
          accepted: true,
          requiresPayment: false,
          acceptedAt: ext.client_accepted_at,
          settled: true,
        });
      }
      throw new ConflictError('This request has expired.', 'EXTENSION_NOT_PENDING');
    }
    if (new Date(ext.expires_at).getTime() < Date.now()) {
      throw new ConflictError('This request has expired.', 'EXTENSION_EXPIRED');
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    const ua = (req.headers['user-agent'] || '').slice(0, 500) || null;

    // Stamp only once. COALESCE keeps the FIRST acceptance as the record.
    const upd = await pool.query(
      `UPDATE service_extensions
          SET client_accepted_at = COALESCE(client_accepted_at, NOW()),
              client_accept_ip   = COALESCE(client_accept_ip, $2),
              client_accept_ua   = COALESCE(client_accept_ua, $3),
              updated_at = NOW()
        WHERE id = $1
        RETURNING client_accepted_at`,
      [ext.id, ip, ua]
    );
    const acceptedAt = upd.rows[0].client_accepted_at;

    const amountCents = Number(ext.amount_cents) || 0;
    if (amountCents > 0) {
      // Payment is the settle trigger; the webhook takes it from here.
      return res.json({ accepted: true, requiresPayment: true, acceptedAt });
    }

    // Zero-delta: acceptance itself settles (spec decision 13). Stripe cannot
    // charge $0, and the coverage artifact matters regardless of price.
    const settled = await settleExtension({ extensionId: ext.id, outcome: 'paid' });
    if (settled.ok) {
      // Payroll runs on EVERY settle path, not just the webhook: a zero-delta
      // extension is still time the staffer worked (spec section 9).
      const payroll = await applyExtensionHours({
        proposalId: settled.proposalId,
        newDurationHours: settled.newDurationHours,
      });
      await maybeAlertPayroll(notify, settled.proposalId, payroll);
      await notify.notifyStaffOfOutcome({
        staffUserIds: settled.staffUserIds,
        outcome: 'approved',
        newEndDisplay: settled.newEndDisplay,
        contractedEndDisplay: ext.contracted_end_time,
        proposalId: settled.proposalId,
      });
      if (settled.multiShift) {
        await notify.alertAdminsProblem({
          proposalId: settled.proposalId,
          kind: 'multi_shift',
          detail: `Duration moved to ${settled.newDurationHours}h but the event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
        });
      }
    }
    return res.json({ accepted: true, requiresPayment: false, acceptedAt, settled: settled.ok });
  })
);

module.exports = router;
```

- [ ] **Step 2: Add the extension block to the invoice GET**

Edit `server/routes/invoices.js`. In the `GET /t/:token` handler, after the existing parallel line-items/payments/refunds fetch, add a fourth query and include it in the response. The block is `null` for every ordinary invoice, so Deposit and Balance links already in client inboxes are byte-unaffected.

```javascript
// Service-extension block. Non-null ONLY when a service_extensions row
// references this invoice, so ordinary Deposit/Balance invoices (including
// links already sitting in client inboxes) see no change at all. Drives the
// terms gate on InvoicePage: pay stays disabled until accepted_at is set.
const extRes = await pool.query(
  `SELECT id, status, amount_cents, terms_version, client_accepted_at,
          contracted_end_time, requested_end_time, expires_at
     FROM service_extensions
    WHERE invoice_id = $1
    ORDER BY id DESC LIMIT 1`,
  [invoice.id]
);
let extension = null;
if (extRes.rows[0]) {
  const e = extRes.rows[0];
  // renderExtensionTerms throws on an unknown version rather than showing copy
  // the client never agreed to. Fall back to no terms block (which leaves pay
  // disabled) instead of 500-ing a client's payment page.
  let terms = null;
  try {
    terms = renderExtensionTerms({ version: e.terms_version, newEndDisplay: e.requested_end_time });
  } catch (copyErr) {
    console.error('[invoices] unknown extension terms version', e.terms_version, copyErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(copyErr, { tags: { feature: 'service-extension', step: 'terms_render' } });
    }
  }
  extension = {
    is_extension: true,
    status: e.status,
    terms,
    accepted_at: e.client_accepted_at,
    expires_at: e.expires_at,
    contracted_end_time: e.contracted_end_time,
    requested_end_time: e.requested_end_time,
    requires_payment: Number(e.amount_cents) > 0,
    requires_acceptance: !e.client_accepted_at,
  };
}
```

Add to the top of `server/routes/invoices.js`:
```javascript
const Sentry = require('@sentry/node');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');
```

Then add `extension` INSIDE the `invoice` object, alongside the existing arrays, so the final statement reads:

```javascript
  res.json({
    invoice: {
      ...invoice,
      line_items: lineItemsRes.rows,
      payments: paymentsRes.rows,
      refunds: refundsRes.rows,
      extension,
    },
  });
```

Task 15 reads it as `data.invoice.extension`. Do not put it at the top level: the client only ever stores `data.invoice`.

- [ ] **Step 2b: Refuse minting or renaming an invoice INTO an off-ledger label**

Still in `server/routes/invoices.js`. The admin create route (`POST /api/invoices/proposal/:proposalId`, invoices.js:185-274) validates the label only as a non-empty string, and the PATCH rename (invoices.js:297-303) validates the same way. Reject BOTH when the label is in `OFF_LEDGER_INVOICE_LABELS` (throw `ValidationError`): otherwise an admin can mint or rename an invoice INTO the 'Service Extension' label and silently make its money off-ledger, because the webhook keys the `amount_paid` roll-up skip on the label alone (paymentIntentSucceeded.js:217-222). Extension invoices are only ever minted by the extension request route, which is exactly why nothing else may wear the label. Covered by the `invoices.extension.test.js` cases in Step 3.

- [ ] **Step 3: Write the tests**

Create `server/routes/serviceExtensions/publicAccept.test.js` covering, with the same fixture shape as Task 7's suite (copy its `before`/`after`, adding a `service_extensions` row plus its invoice):

1. A non-UUID token returns 404, not 500. `fetch('/api/service-extensions/t/not-a-uuid/accept', {method:'POST'})` → 404.
2. An unknown UUID returns 404.
3. A priced pending request: accept returns `{accepted:true, requiresPayment:true}`, stamps `client_accepted_at`, `client_accept_ip`, `client_accept_ua`, and does NOT settle (`status` still `pending`, `event_duration_hours` unchanged).
4. Accepting twice keeps the FIRST timestamp: capture `acceptedAt` from the first call, assert the second call returns the identical value.
5. A zero-delta request (`amount_cents = 0`) settles on accept: response `{requiresPayment:false, settled:true}`, row `status = 'paid'`, `proposals.event_duration_hours` bumped, and `total_price`/`amount_paid`/`status` all unchanged.
6. An expired-by-timestamp pending row returns 409 `EXTENSION_EXPIRED` and does not stamp acceptance.
7. A voided invoice returns 404.

Create `server/routes/invoices.extension.test.js` covering. Every assertion reads `body.invoice.extension`, never `body.extension`, which is the contract Task 15 depends on:

1. An ordinary Balance invoice's `GET /t/:token` returns `invoice.extension === null` and is otherwise unchanged (assert `invoice.amount_due` and the `line_items` array still present).
2. An extension invoice returns `invoice.extension.is_extension === true`, `terms.headline` containing the requested end time, `requires_acceptance === true`, and `requires_payment === true`.
3. After acceptance, the same GET returns `requires_acceptance === false` and a non-null `accepted_at`.
4. An extension row carrying an unknown `terms_version` (insert one with `terms_version = 'bogus'`) returns `terms: null` and a 200, never a 500.
5. Shape guard: assert `body.extension === undefined` AND `body.invoice.extension !== undefined` on an extension invoice. This is the explicit regression test for the server/client shape mismatch described above.
6. Label guard (Step 2b): `POST /api/invoices/proposal/:proposalId` with `label: 'Service Extension'` returns 400, and a PATCH renaming an existing invoice to `'Service Extension'` returns 400. An ordinary label still creates and renames fine.

Stub the notify module at the top of both files exactly as Task 7's suite does.

- [ ] **Step 4: Run both suites, one at a time**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/publicAccept.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.extension.test.js
```
Expected: both PASS.

- [ ] **Step 5: Confirm no existing invoice suite regressed**

Run each of these one at a time:
```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.clientTokenValidation.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.extrasVoid.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.refunds.test.js
```
Expected: all PASS. The GET addition is additive, so a failure here means the response shape changed for ordinary invoices, which is a blocker.

- [ ] **Step 6: Commit**

```bash
git add server/routes/serviceExtensions/publicAccept.js server/routes/serviceExtensions/publicAccept.test.js server/routes/invoices.js server/routes/invoices.extension.test.js
git commit -m "feat(ext): server-recorded terms acceptance + invoice-page extension block

Acceptance is stamped server-side and is idempotent; the zero-delta case
settles on acceptance since Stripe cannot charge \$0. The invoice GET block is
null for every ordinary invoice, so links already in client inboxes are
unaffected."
```

### Task 9: Gate intent creation on acceptance

Without this, Task 8's acceptance is decorative: a client could POST straight to the intent route and pay with no recorded agreement.

**Files:**
- Modify: `server/routes/stripe.js` (the `POST /create-intent-for-invoice/:token` handler)
- Test: extend `server/routes/serviceExtensions/publicAccept.test.js`

**Interfaces:**
- Consumes: the `service_extensions` row.
- Produces: a 409 `EXTENSION_TERMS_NOT_ACCEPTED` on an unaccepted extension invoice; existing behavior for every other invoice.

- [ ] **Step 1: Add the gate**

Edit `server/routes/stripe.js`. The existing handler already fetches the invoice into `inv` and then runs the archived-event guard. Immediately AFTER the archived guard and BEFORE the `balanceCents` computation, add:

```javascript
  // Extension invoices require a recorded terms acceptance before they can be
  // paid (spec decision 8). The acceptance is what makes the payment an
  // artifact, so the gate has to live server-side: a client who skips the page
  // and posts straight here would otherwise pay with no record of agreeing.
  // Ordinary invoices have no service_extensions row and skip this entirely.
  const extGate = await pool.query(
    `SELECT id, status, client_accepted_at, expires_at
       FROM service_extensions
      WHERE invoice_id = $1
      ORDER BY id DESC LIMIT 1`,
    [inv.invoice_id]
  );
  if (extGate.rows[0]) {
    const ext = extGate.rows[0];
    if (ext.status !== 'pending') {
      throw new ConflictError(
        'This request is no longer open. Contact us if you still need more time.',
        'EXTENSION_NOT_PENDING'
      );
    }
    if (new Date(ext.expires_at).getTime() < Date.now()) {
      throw new ConflictError('This request has expired.', 'EXTENSION_EXPIRED');
    }
    if (!ext.client_accepted_at) {
      throw new ConflictError(
        'Please review and accept the terms before paying.',
        'EXTENSION_TERMS_NOT_ACCEPTED'
      );
    }
  }
```

`ConflictError` is already imported in this file (the archived guard uses it). Verify with `grep -n "ConflictError" server/routes/stripe.js | head -2`.

- [ ] **Step 2: Add the tests to the accept suite**

Append to `server/routes/serviceExtensions/publicAccept.test.js`. Mount the stripe router alongside the extensions router in that suite's `before` (`app.use('/api/stripe', require('../stripe'))`), and stub the Stripe seam BEFORE requiring it:

```javascript
require('../../utils/stripeClient').getStripe = () => ({
  paymentIntents: {
    create: async (params) => ({ id: `pi_test_${Date.now()}`, client_secret: 'cs_test', amount: params.amount }),
  },
  customers: { create: async () => ({ id: 'cus_test' }), retrieve: async () => ({ id: 'cus_test', deleted: false }) },
});
```

Tests to add:
1. Intent creation on an unaccepted extension invoice returns 409 with code `EXTENSION_TERMS_NOT_ACCEPTED`.
2. After accepting, intent creation on the same token returns 200 with a `clientSecret`.
3. Intent creation on an EXPIRED pending extension returns 409 `EXTENSION_EXPIRED`.
4. Intent creation on an ORDINARY Balance invoice still returns 200 (proves the gate is scoped to extension invoices only). This one is the regression guard that matters most: the gate sits in the busiest client payment route.

- [ ] **Step 3: Run the suite plus the stripe suites**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/publicAccept.test.js
```
Then find and run the existing stripe route suites one at a time:
```bash
ls server/routes/stripe*.test.js
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripe.js server/routes/serviceExtensions/publicAccept.test.js
git commit -m "feat(ext): refuse intent creation until extension terms are accepted

Server-side gate, scoped to invoices carrying a service_extensions row, so the
acceptance artifact cannot be skipped by posting straight to the intent route.
Ordinary invoices are untouched."
```

### Task 10: Admin override, cancel, and read

The override grants time and **voids the invoice** (spec decision 14). It never leaves a receivable, because an unpaid extension is not something DRB carries. Rev 2 of the spec had it leaving the invoice open; that was corrected, so do not reintroduce it.

**Generic-Void interplay (verified 2026-08-03).** The generic admin invoice Void control (invoices.js:407-447, guarded by `amount_paid = 0`) can void a pending extension invoice WITHOUT touching the `service_extensions` row; the row stays `'pending'` until the sweep expires it. This is benign for money and safety (the public accept joins `i.status <> 'void'` so it 404s, and create-intent refuses a non-sent/partially_paid invoice), but the staffer hears nothing until expiry. The extension's own Cancel action here is the right tool: it closes the row AND sends the decline immediately. Task 16's panel copy steers admins to it.

**Files:**
- Replace: `server/routes/serviceExtensions/admin.js` (the Task 7 stub)
- Test: `server/routes/serviceExtensions/admin.test.js`

**Interfaces:**
- Consumes: `settleExtension`, `closeExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `cancelOpenInvoiceIntents` (existing).
- Produces:
  - `GET /api/service-extensions/proposal/:proposalId` → `{ extensions: [...] }` WITH money (admin surface).
  - `POST /api/service-extensions/:id/override` body `{ reason }` → `{ status: 'overridden', newEndTime, payrollWarning }`.
  - `POST /api/service-extensions/:id/cancel` → `{ status: 'cancelled' }`.

- [ ] **Step 1: Write the route**

Create `server/routes/serviceExtensions/admin.js`:

```javascript
'use strict';

/**
 * Admin surfaces for service extensions (spec sections 5.6, 8).
 *
 * Override grants the time and VOIDS the invoice (decision 14). It does NOT
 * leave an open invoice to collect: per decision 12 an unpaid extension is not
 * a receivable DRB carries, so there is deliberately no aging view, no
 * reminder, and no collect action anywhere in this feature.
 *
 * Because extension money is side money, an unpaid override cannot demote
 * payment status, block auto-completion, or disturb the funded-gratuity gate.
 * That is the entire reason the override is safe now.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension, closeExtension } = require('../../utils/serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll } = require('../../utils/serviceExtensionPayroll');
const { cancelOpenInvoiceIntents } = require('../../utils/invoiceVoid');
const { logAdminAction } = require('../../utils/adminAuditLog');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** Void the extension's invoice and cancel any open intent against it. */
async function voidExtensionInvoice(proposalId, invoiceId) {
  if (!invoiceId) return;
  // Best-effort intent cancel first, so a client mid-checkout cannot complete
  // against an invoice we are about to void.
  await cancelOpenInvoiceIntents(proposalId, invoiceId);
  await pool.query(
    "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
    [invoiceId]
  );
}

/**
 * Payroll warning text when the event's hours are already accrued and
 * admin-edited, so the automatic re-seed will refuse to touch them.
 * Mirrors the rule in serviceExtensionPayroll (Task 13).
 */
async function payrollWarningFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS locked
       FROM payout_events pe
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1
        AND pe.hours IS DISTINCT FROM pe.contracted_hours`,
    [proposalId]
  );
  return rows[0] && rows[0].locked > 0
    ? 'Payroll hours for this event were edited by hand, so the extra time was NOT added automatically. Update the payout line yourself.'
    : null;
}

/** GET /api/service-extensions/proposal/:proposalId */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = Number(req.params.proposalId);
  if (!Number.isInteger(proposalId)) throw new ValidationError({ proposalId: 'Invalid event.' });
  const { rows } = await pool.query(
    `SELECT se.id, se.status, se.amount_cents, se.gratuity_cents,
            se.contracted_end_time, se.requested_end_time,
            se.contracted_duration_hours, se.requested_duration_hours,
            se.client_accepted_at, se.expires_at, se.created_at,
            se.override_reason, se.hosted_product_confirmed,
            se.requested_by_user_id, se.invoice_id,
            i.status AS invoice_status, i.token AS invoice_token,
            -- users has NO `name` column; human names live on
            -- contractor_profiles.preferred_name. Fall back to the email.
            COALESCE(cp.preferred_name, u.email) AS requested_by_name,
            COALESCE(ovcp.preferred_name, ov.email) AS override_by_name
       FROM service_extensions se
       LEFT JOIN invoices i ON i.id = se.invoice_id
       LEFT JOIN users u ON u.id = se.requested_by_user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = se.requested_by_user_id
       LEFT JOIN users ov ON ov.id = se.override_by_user_id
       LEFT JOIN contractor_profiles ovcp ON ovcp.user_id = se.override_by_user_id
      WHERE se.proposal_id = $1
      ORDER BY se.id DESC`,
    [proposalId]
  );
  res.json({ extensions: rows, payrollWarning: await payrollWarningFor(proposalId) });
}));

/** POST /api/service-extensions/:id/override */
router.post('/:id/override', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError({ id: 'Invalid request.' });
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) throw new ValidationError({ reason: 'Give a short reason for the override.' });
  if (reason.length > 500) throw new ValidationError({ reason: 'Keep the reason under 500 characters.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const settled = await settleExtension({
    extensionId: id, outcome: 'overridden',
    actorUserId: req.user.id, overrideReason: reason,
  });
  if (!settled.ok) {
    throw new ConflictError(
      `This request is already ${probe.rows[0].status}.`,
      'EXTENSION_NOT_PENDING'
    );
  }

  // Decision 14: no receivable survives an override.
  await voidExtensionInvoice(settled.proposalId, settled.invoiceId);

  // The staffer worked the time regardless of who paid for it, so payroll runs
  // on this path too (spec section 9: "wage hours still accrue" for an override).
  const payroll = await applyExtensionHours({
    proposalId: settled.proposalId,
    newDurationHours: settled.newDurationHours,
  });
  await maybeAlertPayroll(notify, settled.proposalId, payroll);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_override',
    metadata: {
      extension_id: id,
      proposal_id: settled.proposalId,
      reason,
      new_duration_hours: settled.newDurationHours,
      amount_cents_waived: settled.amountCents,
    },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: settled.staffUserIds,
    outcome: 'approved',
    newEndDisplay: settled.newEndDisplay,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: settled.proposalId,
  });
  if (settled.multiShift) {
    await notify.alertAdminsProblem({
      proposalId: settled.proposalId,
      kind: 'multi_shift',
      detail: `Duration moved to ${settled.newDurationHours}h but this event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
    });
  }

  res.json({
    status: 'overridden',
    newEndTime: settled.newEndDisplay,
    newDurationHours: settled.newDurationHours,
    payrollWarning: await payrollWarningFor(settled.proposalId),
  });
}));

/** POST /api/service-extensions/:id/cancel */
router.post('/:id/cancel', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError({ id: 'Invalid request.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const closed = await closeExtension({
    extensionId: id, outcome: 'cancelled', actorUserId: req.user.id,
  });
  if (!closed.ok) {
    throw new ConflictError(`This request is already ${probe.rows[0].status}.`, 'EXTENSION_NOT_PENDING');
  }

  await voidExtensionInvoice(closed.proposalId, closed.invoiceId);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_cancel',
    metadata: { extension_id: id, proposal_id: closed.proposalId },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: closed.staffUserIds,
    outcome: 'declined',
    newEndDisplay: null,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: closed.proposalId,
  });

  res.json({ status: 'cancelled' });
}));

module.exports = router;
```

- [ ] **Step 2: Write the test**

Create `server/routes/serviceExtensions/admin.test.js` using Task 7's fixture shape plus an admin user (`role: 'admin'`). Stub `getStripe` (so `cancelOpenInvoiceIntents` is inert) and the notify module. Cover:

1. A staff-role token gets 403 on override, cancel, and the GET.
2. Override with a reason under 3 characters returns 400.
3. Override on a pending request: 200, row `status = 'overridden'` with the reason and actor recorded, `proposals.event_duration_hours` bumped, the shift `end_time` updated, and **the invoice `status = 'void'`** (this is decision 14: assert explicitly that no open invoice survives).
4. After the override, `total_price`, `amount_paid`, and `proposals.status` are all unchanged (side money).
5. An `admin_audit_log` row exists with action `service_extension_override`.
6. A second override on the same row returns 409.
7. Cancel on a pending request: 200, `status = 'cancelled'`, invoice `void`, and `event_duration_hours` UNCHANGED.
8. The GET returns money fields (this is the admin surface, so `amount_cents` is expected here, unlike the staff endpoints).

- [ ] **Step 3: Run it**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/admin.test.js`
Expected: PASS.

If `requireAdminOrManager` is not exported under that name, check `grep -n "module.exports" -A8 server/middleware/auth.js` and use the real guard.

- [ ] **Step 4: Commit**

```bash
git add server/routes/serviceExtensions/admin.js server/routes/serviceExtensions/admin.test.js
git commit -m "feat(ext): admin override and cancel, both voiding the invoice

Override grants the time and leaves no receivable (spec decision 14). Side
money is what makes an unpaid override safe: it cannot demote payment status,
block auto-completion, or disturb the funded-gratuity gate."
```

- [ ] **Step 5: Lane checkpoint review**

Dispatch `security-review` on the whole `ext-routes` diff. Focus: the assignment predicate, the public token surface, the acceptance gate's scoping to extension invoices only, and whether any staff-facing response can leak a price.

- [ ] **Step 6: Lane gate**

Run every suite in this lane one at a time, then the full fleet declared in front-matter.

```bash
for f in \
  server/routes/serviceExtensions/create.test.js \
  server/routes/serviceExtensions/publicAccept.test.js \
  server/routes/serviceExtensions/admin.test.js \
  server/routes/invoices.extension.test.js ; do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```

---

## Lane ext-webhook-payroll

The two money seams: settling a paid extension inside the Stripe webhook, and getting the extra time into payroll. Plus the expiry sweep that makes the hard stop real.

### Task 11: Settle on payment inside the webhook

The extension settles by looking itself up from the paid invoice. That lookup IS the discriminator: `create-intent-for-invoice` stamps `payment_type: 'invoice'` unconditionally, so nothing else in the intent distinguishes an extension from a Balance payment, and no new metadata is needed.

Three facts about the existing handler this task depends on, all verified 2026-07-26:
1. The whole block runs inside `if (isFirstDelivery)`, gated by the `proposal_payments` ON CONFLICT insert, so a Stripe retry never re-enters it.
2. The invoice branch already links the payment via `intent.metadata.invoice_id` with a proposal-ownership cross-check. **Do not add a second `linkPaymentToInvoice` call**; it would return not-payable and Sentry-warn on every extension payment.
3. Because `Service Extension` is now in `OFF_LEDGER_INVOICE_LABELS`, the branch's `amount_paid` roll-up is already skipped for it. That is the side-money guarantee and it needs no new code.

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`
- Test: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`

**Interfaces:**
- Consumes: `settleExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `applyExtensionHours` (Task 12, imported lazily so the two tasks can be built in either order within this lane).
- Produces: no new exports. Behavior: a paid extension invoice bumps duration and greenlights staff.

- [ ] **Step 1: Read the handler around the insertion point**

Run: `grep -n "if (invOwner.rows\[0\])" -A6 server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`

The settle hook goes immediately AFTER the existing `linkPaymentToInvoice(...)` call, still inside `if (invOwner.rows[0])`, so it only runs for an invoice that genuinely belongs to this proposal.

- [ ] **Step 2: Add the settle hook**

Insert after the `await linkPaymentToInvoice(Number(invoiceId), paymentRowId, intent.amount, dbClient);` line:

```javascript
                // ─── Service extension settle (spec 2026-07-25 section 7) ───
                // The service_extensions lookup by invoice_id IS the
                // discriminator: create-intent-for-invoice stamps
                // payment_type:'invoice' unconditionally, so nothing else in
                // the intent tells an extension from a Balance payment.
                //
                // The claim UPDATE (WHERE status='pending') is the race gate
                // against the expiry sweep and a second idempotency wall behind
                // isFirstDelivery. Deliberately NO fold, NO reconcile, NO
                // invoice refresh: extension money is off-ledger side money and
                // the ONLY contract column that moves is event_duration_hours.
                const extRow = await dbClient.query(
                  `SELECT id, status, contracted_end_time
                     FROM service_extensions
                    WHERE invoice_id = $1
                    ORDER BY id DESC LIMIT 1`,
                  [Number(invoiceId)]
                );
                if (extRow.rows[0]) {
                  extensionSettleContext = {
                    extensionId: extRow.rows[0].id,
                    priorStatus: extRow.rows[0].status,
                    contractedEndDisplay: extRow.rows[0].contracted_end_time,
                  };
                }
```

Declare `let extensionSettleContext = null;` alongside the handler's other pre-transaction locals (find them with `grep -n "^        let \|^      let " server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js | head`), so the post-commit tail can see it.

- [ ] **Step 3: Do the settle in the post-commit tail, AFTER the connection is released**

**Get this location exactly right.** The `COMMIT` (line ~456) is still inside the `try`, and `dbClient.release()` is in the `finally` at ~473. Inserting "after the COMMIT" would call `settleExtension`, `applyExtensionHours` and the notify helpers while `dbClient` is still held, and every one of those takes its own pooled connection: that is the pool deadlock the Global Constraints forbid and the one that has already bitten this codebase twice.

The correct anchor is the existing best-effort block that starts AFTER the `finally`:

```bash
grep -n "Non-blocking post-commit work" server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
```

That comment sits at ~line 476, immediately followed by `if (isFirstDelivery) {`. Put the new block inside that existing `if (isFirstDelivery)`, alongside the B3 settle-on-archived alert. Being inside it also means a Stripe retry cannot re-run the settle, on top of the claim gate.

Add there:

```javascript
  // ─── Service extension: settle AFTER the commit AND after release ───────
  // Goes inside the existing `if (isFirstDelivery)` best-effort block, which
  // runs after dbClient.release(). Every helper below takes its own pooled
  // connection, so running this while dbClient is still held would deadlock the
  // pool. Outside the transaction is also deliberate: the payment is already
  // durably recorded, and a settle, payroll or Twilio failure must never roll
  // that back and make Stripe retry a charge the client already made.
  if (extensionSettleContext) {
    const { settleExtension } = require('../../utils/serviceExtensionSettle');
    const notify = require('../../utils/serviceExtensionNotify');
    try {
      if (extensionSettleContext.priorStatus !== 'pending') {
        // The expiry sweep (or an admin) claimed the row before this payment
        // landed. DRB is holding money for time nobody authorized: contain it
        // to "refund one payment" and tell a human. Modeled on the existing
        // payment_on_archived alert. Never throw: a throw here would make
        // Stripe retry forever against an already-charged client.
        await notify.alertAdminsProblem({
          proposalId,
          kind: 'paid_after_expiry',
          detail: `An extension payment of ${intent.amount} cents landed after the request was already ${extensionSettleContext.priorStatus}. The event was NOT extended. Refund this payment.`,
        });
      } else {
        const settled = await settleExtension({
          extensionId: extensionSettleContext.extensionId,
          outcome: 'paid',
        });
        if (settled.ok) {
          // BOTH names. Destructuring only applyExtensionHours leaves
          // maybeAlertPayroll unresolved; the ReferenceError lands in the outer
          // catch AFTER the settle already committed, so the duration moves and
          // notifyStaffOfOutcome on the next line never runs: the bartender is
          // never greenlit and the admin gets a misleading alert. The happy-path
          // test would still pass, because it only asserts DB state written
          // before this line.
          const { applyExtensionHours, maybeAlertPayroll } = require('../../utils/serviceExtensionPayroll');
          const payroll = await applyExtensionHours({
            proposalId: settled.proposalId,
            newDurationHours: settled.newDurationHours,
          });
          await maybeAlertPayroll(notify, settled.proposalId, payroll);
          await notify.notifyStaffOfOutcome({
            staffUserIds: settled.staffUserIds,
            outcome: 'approved',
            newEndDisplay: settled.newEndDisplay,
            contractedEndDisplay: extensionSettleContext.contractedEndDisplay,
            proposalId: settled.proposalId,
          });
          if (settled.multiShift) {
            await notify.alertAdminsProblem({
              proposalId: settled.proposalId,
              kind: 'multi_shift',
              detail: `Duration moved to ${settled.newDurationHours}h but this event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
            });
          }
        } else {
          // Lost the claim between the read and here: same containment.
          await notify.alertAdminsProblem({
            proposalId,
            kind: 'paid_after_expiry',
            detail: `An extension payment landed but the request was claimed by another process first. The event was NOT extended. Verify and refund if needed.`,
          });
        }
      }
    } catch (extErr) {
      // Contain: the payment stands, the extension did not settle, a human is told.
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(extErr, { tags: { feature: 'service-extension', step: 'webhook_settle' } });
      }
      console.error('[webhook] service-extension settle failed:', extErr.message);
      await notify.alertAdminsProblem({
        proposalId,
        kind: 'settle_on_closed_event',
        detail: `A paid extension could not be settled automatically (${extErr.message}). Extend the event by hand and check the bartender was told.`,
      }).catch(() => {});
    }
  }
```

Confirm `pool` and `Sentry` are already in scope in that file (`grep -n "require('@sentry/node')\|{ pool }" server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js | head`). If `pool` is not imported, add it.

- [ ] **Step 4: Write the test**

Create `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`. Call the handler function directly with a synthetic intent rather than going through signature verification. Read the existing sibling suites first to copy their invocation shape: `ls server/routes/stripeWebhookHandlers/*.test.js` and read one.

Cover:
1. **Happy path.** A `Service Extension` invoice, a pending row, an intent with `metadata.invoice_id` and `payment_type: 'invoice'`. After the handler: extension `status = 'paid'`, `proposals.event_duration_hours` bumped, shift `end_time` updated.
2. **Side money, the critical assertion.** After the same run: `proposals.amount_paid` is UNCHANGED, `total_price` unchanged, `status` unchanged. This is the off-ledger guarantee and the single most important test in the feature.
3. **Deposit-only regression guard (spec §13).** Set up a proposal with `total_price = 1000`, `amount_paid = 100`, status `deposit_paid`, then settle a paid extension. Assert `amount_paid` is still 100 and status is still `deposit_paid`, so the funded-gratuity gate stays false and auto-completion is not tripped.
4. **Replay.** Invoke the handler twice with the same intent. Assert `event_duration_hours` moved exactly once and exactly one `proposal_payments` row exists.
5. **Paid after expiry.** Pre-set the row to `expired`, then run the handler. Assert the duration did NOT move, and that the admin alert path was hit (stub `alertAdminsProblem` to record calls and assert `kind === 'paid_after_expiry'`).
6. **Ordinary Balance invoice.** No `service_extensions` row: assert `amount_paid` DOES increase as it always did, proving the change is inert for normal payments.
7. **No dunning (spec decision 12).** After a pending extension exists and after one settles, assert zero `scheduled_messages` rows reference the extension invoice or carry an extension `message_type`. An unpaid extension is not a receivable, so nothing may ever chase it. This is the regression guard for the invariant, not just documentation.

Stub `serviceExtensionNotify` and `serviceExtensionPayroll` at the top so no real sends or payroll writes occur.

- [ ] **Step 5: Run it, plus every existing webhook suite**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
ls server/routes/stripeWebhookHandlers/*.test.js
```
Then run each existing webhook suite one at a time. Expected: all PASS. This handler is the busiest money path in the app; a regression here is a blocker, not a warning.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
git commit -m "feat(ext): settle a paid extension in the webhook, off-ledger

Looks the extension up by paid invoice (the only available discriminator),
claims it, and settles AFTER the commit so a settle/payroll/Twilio failure
cannot roll back a recorded payment. amount_paid stays put via the off-ledger
label, so a deposit-stage event cannot be falsely marked funded."
```

### Task 12: Payroll, in two halves that live in DIFFERENT LANES

> **12a, the hours module → lane `ext-core`.** Steps 1 to 3 below. It is a pure util with no route dependencies, and `ext-routes` (Tasks 8 and 10) imports it, so it MUST land in `ext-core` or the lane graph is circular. Build it at the end of `ext-core`, after Task 5.
>
> **12b, the accrual addend → lane `ext-webhook-payroll`.** Steps 4 onward. It edits `payrollAccrual.js`, which belongs with the other money-seam review.
>
> The front-matter footprints already reflect this split: `serviceExtensionPayroll.js` is declared in `ext-core`, `payrollAccrual.js` in `ext-webhook-payroll`. The two halves get separate commits regardless, so a bad addend never forces reverting the hours fix.

**12a, wage hours.** Accrual seeds `contracted_hours` from `proposals.event_duration_hours` on FIRST accrual only, then treats `hours` as admin-owned. First accrual mid-event is the NORM, not the exception: a card tip matched to the shift triggers accrual while the period is open, and auto-completion fires at the contracted end, inside the request window. So: re-seed when `hours = contracted_hours` (the admin demonstrably has not touched the line), refuse and warn when they differ.

**12b, gratuity share.** The pool is snapshot-derived and the snapshot never moves (side money), so the extension's gratuity joins as an event-scoped addend, mirroring how card tips already join.

**Fee-netting order.** `proRataFeeCents(gross, proposalTotalCents, fee)` pro-rates the card fee by the gratuity's share of `total_price`. Extension gratuity is not inside `total_price`, so feeding it in would over-net the fee (bounded by the helper's existing `Math.min(1, ...)` clamp, but wrong regardless). The addend therefore lands AFTER netting, which also implements the spec's decision that DRB absorbs the extension's Stripe fee rather than charging it to the staff pool.

**Commit separately.** These are two independent features and they get two commits inside this task: the hours module first, then the accrual addend. A bad addend must be revertable without also reverting the hours fix.

**Files (12a, lane ext-core):**
- Create: `server/utils/serviceExtensionPayroll.js`
- Test: `server/utils/serviceExtensionPayroll.test.js`

**Files (12b, lane ext-webhook-payroll):**
- Modify: `server/utils/payrollAccrual.js`
- Test: `server/utils/payrollAccrual.extension.test.js`

**Interfaces:**
- Consumes: `contractedHours` and `wageCents` from `server/utils/payrollMath.js` (existing).
- Produces:
  - `finalizeExtension(extensionId)` → `Promise<void>`. Stamps `finalized_at = NOW()`. EVERY settle path calls it as the LAST step, after payroll and the staff greenlight have both returned. A settled row left unstamped is what the Task 13 heal looks for, so calling it too early defeats the crash recovery:
    ```javascript
    async function finalizeExtension(extensionId) {
      await pool.query(
        'UPDATE service_extensions SET finalized_at = NOW(), updated_at = NOW() WHERE id = $1',
        [extensionId]
      );
    }
    ```
  - `applyExtensionHours({ proposalId, newDurationHours })` → `Promise<{ updatedLines, lockedLines, frozenLines, multiShiftSkipped, payoutIds }>`. Called by ALL THREE settle paths: the webhook (Task 11), the zero-delta accept (Task 8), and the admin override (Task 10). A first draft wired it only into the webhook, so an overridden or zero-delta extension moved the duration and never paid for it.
  - `maybeAlertPayroll(notify, proposalId, payrollResult)` → `Promise<void>`. The shared post-settle alert, so all three call sites report `lockedLines` AND `frozenLines` identically. Its body is in Step 2's file, and BOTH names are in that file's `module.exports`. All three consumers destructure `{ applyExtensionHours, maybeAlertPayroll }`; Task 11's lazy require must include both.
  - `payrollAccrual`'s gratuity pool includes `SUM(gratuity_cents)` over that proposal's `paid` extensions, added after fee-netting.

- [ ] **Step 1: Read the accrual code this task modifies, and the contracted-hours helper**

Run: `sed -n 283,300p server/utils/payrollAccrual.js` and `sed -n 330,340p server/utils/payrollAccrual.js`

Confirm the current shape: `gratuityFunded`, `grossGratuity`, `gratuityFee = proRataFeeCents(grossGratuity, proposalTotalCents, fee)`, `netGratuity = Math.max(0, grossGratuity - gratuityFee)`.

**Then read the contracted-hours helper, which is NOT in this file:**

```bash
sed -n 1,20p server/utils/payrollMath.js
```

**This is the single most dangerous thing in the plan.** `contractedHours(d)` is `d + SETUP_HOURS(1) + BREAKDOWN_HOURS(0.5)`, so a 4-hour event seeds `contracted_hours = 5.5`, not 4. A first draft of this task wrote its own helper returning the bare duration, which would have *rewritten 5.5 down to 4.5* on a 30-minute extension: cutting an hour of pay from every bartender instead of adding half an hour, silently, on the exact code path meant to pay them more.

Do not write a local hours helper. Import the real one.

- [ ] **Step 2: Write the hours module**

Create `server/utils/serviceExtensionPayroll.js`:

```javascript
'use strict';

/**
 * Get a settled extension's extra time into payroll (spec section 9).
 *
 * payrollAccrual seeds contracted_hours from proposals.event_duration_hours on
 * FIRST accrual and then treats hours as admin-owned. First accrual mid-event
 * is the NORM, not the exception: matchTipToEvent accrues on any card tip while
 * the period is open, and auto-completion fires at the contracted end, which is
 * inside the request window itself. So an extension frequently lands AFTER a
 * line already exists, and re-accrual would preserve the old hours and silently
 * underpay.
 *
 * Rule: re-seed only when hours = contracted_hours, meaning the admin has
 * demonstrably not touched the line. When they differ the admin owns it, so we
 * refuse and report a locked line for the caller to surface. Frozen pay periods
 * are never written (the late-tip deferral precedent); they are reported too.
 *
 * Wages are recomputed from the new hours because wage_cents is a stored,
 * JS-computed column in this schema.
 */

const { pool } = require('../db');
// THE seeding helper, not a local reimplementation. contractedHours(d) =
// d + 1h setup + 0.5h breakdown, so a 4h event's contracted_hours is 5.5. A
// local helper returning the bare duration would REWRITE 5.5 down to 4.5 on a
// 30-minute extension and cut an hour of pay per line.
const { contractedHours, wageCents } = require('./payrollMath');

async function applyExtensionHours({ proposalId, newDurationHours, shiftId = null }) {
  const target = contractedHours(Number(newDurationHours) || 0);
  if (!Number.isFinite(target) || target <= 0) {
    return { updatedLines: 0, lockedLines: 0, frozenLines: 0, multiShiftSkipped: false, payoutIds: [] };
  }

  // Multi-shift guard. contracted_hours derives from the PROPOSAL's duration, so
  // on an event with several shift rows a proposal-wide UPDATE would bump hours
  // for staff on shifts that were never extended (a Day 2 crew paid for Day 1's
  // extra hour). settleExtension already refuses to sync shift end_times in that
  // shape and alerts instead; payroll takes the same line. When the event has
  // exactly one shift we proceed; otherwise nothing is written and the caller
  // reports it so an admin fixes the right lines by hand.
  const shiftCountRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  if ((shiftCountRes.rows[0]?.n || 0) !== 1) {
    return { updatedLines: 0, lockedLines: 0, frozenLines: 0, multiShiftSkipped: true, payoutIds: [] };
  }

  // ONE transaction for the whole rewrite. The per-line UPDATEs and the payout
  // header recompute must land together: a failure between them leaves
  // payout_events disagreeing with payouts.total_cents, i.e. a paystub whose
  // lines do not add up to its total, on the code path that changes staff pay.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyInTx(client, { proposalId, target });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

async function applyInTx(client, { proposalId, target }) {
  const { rows } = await client.query(
    // held_state IS NULL is REQUIRED, mirroring payrollAccrual.js:228. A held
    // line belongs to an off-roster worker and carries hours = contracted_hours
    // = 0 with line_total_cents = 0 deliberately. Both guards below would pass
    // on it (0 === 0, and 0 !== target), so without this filter a settle would
    // resurrect a deliberately non-payable line into a payable one and pay
    // someone who was taken off the job.
    `SELECT pe.payout_id, pe.shift_id, pe.hours, pe.contracted_hours, pe.rate_cents,
            pe.gratuity_share_cents, pe.card_tip_net_cents, pe.adjustment_cents,
            pp.status AS period_status
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1
        AND pe.held_state IS NULL`,
    [proposalId]
  );

  let updatedLines = 0;
  let lockedLines = 0;
  let frozenLines = 0;
  const touchedPayoutIds = new Set();

  for (const line of rows) {
    // Only an 'open' period is writable, matching payrollAccrual.js:186 (the
    // "if (payPeriod.status !== 'open')" line) exactly.
    // 'processing', 'reopened' and 'paid' all count as frozen here; the caller
    // MUST surface frozenLines, because a reopened-period extension that is
    // silently skipped is an underpay nobody is told about.
    if (line.period_status !== 'open') {
      frozenLines += 1;
      continue;
    }
    // Admin-edited hours are admin-owned.
    if (Number(line.hours) !== Number(line.contracted_hours)) {
      lockedLines += 1;
      continue;
    }
    // Already at the new duration (a replay, or accrual ran after the bump).
    if (Number(line.contracted_hours) === target) continue;

    const wage = wageCents(target, Number(line.rate_cents));
    const lineTotal = wage
      + Number(line.gratuity_share_cents || 0)
      + Number(line.card_tip_net_cents || 0)
      + Number(line.adjustment_cents || 0);

    await client.query(
      `UPDATE payout_events
          SET contracted_hours = $3, hours = $3, wage_cents = $4, line_total_cents = $5
        WHERE payout_id = $1 AND shift_id = $2`,
      [line.payout_id, line.shift_id, target, wage, lineTotal]
    );
    updatedLines += 1;
    touchedPayoutIds.add(line.payout_id);
  }

  // Recompute the payout HEADER total, exactly as every sibling writer does
  // (payrollAccrual.js:261). Without this the line is right but the payout and
  // the paystub still show the pre-extension total, so the bartender is paid the
  // old amount and the line-level fix is invisible.
  const payoutIds = [...touchedPayoutIds];
  if (payoutIds.length > 0) {
    await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)`,
      [payoutIds]
    );
  }

  return { updatedLines, lockedLines, frozenLines, multiShiftSkipped: false, payoutIds };
}

/**
 * The shared post-settle payroll alert. All three settle paths (webhook,
 * zero-delta accept, admin override) call this with applyExtensionHours' result
 * so they report identically.
 *
 * frozenLines MUST be reported, not just lockedLines: a 'processing' or
 * 'reopened' pay period is skipped silently otherwise, which is an underpay
 * nobody is told about (spec section 9, the late-tip deferral precedent). This
 * is alert-only by design; no deferral marker is written, because wages have no
 * deferral mechanism the way tips do, so a human has to move the line.
 *
 * `notify` is injected rather than required at module load so this module stays
 * free of the notification dependency and is trivially stubbable in tests.
 */
async function maybeAlertPayroll(notify, proposalId, payroll) {
  if (!payroll) return;
  const parts = [];
  if (payroll.lockedLines > 0) {
    parts.push(`${payroll.lockedLines} payout line(s) were edited by hand`);
  }
  if (payroll.frozenLines > 0) {
    parts.push(`${payroll.frozenLines} payout line(s) sit in a pay period that is not open`);
  }
  if (payroll.multiShiftSkipped) {
    parts.push('this event has multiple shift rows, so payroll hours were not touched at all (bumping them proposal-wide would overpay staff on the shifts that were not extended)');
  }
  if (parts.length === 0) return;
  await notify.alertAdminsProblem({
    proposalId,
    kind: 'payroll_hours_locked',
    detail: `${parts.join(' and ')}, so the extra time was NOT added to payroll automatically. Update the payout line(s) yourself.`,
  });
}

/**
 * Stamp a settled extension as fully finalized. Call this LAST on every settle
 * path, after payroll and the staff greenlight have both returned. An unstamped
 * settled row is exactly what the Task 13 heal hunts for, so stamping early
 * silently disables the crash recovery.
 */
async function finalizeExtension(extensionId) {
  await pool.query(
    'UPDATE service_extensions SET finalized_at = NOW(), updated_at = NOW() WHERE id = $1',
    [extensionId]
  );
}

module.exports = { applyExtensionHours, maybeAlertPayroll, finalizeExtension };
```

- [ ] **Step 3: Verify the column and table names before trusting the query**

Run:
```bash
grep -n "CREATE TABLE IF NOT EXISTS pay_periods" -A12 server/db/schema.sql
grep -n "CREATE TABLE IF NOT EXISTS payout_events" -A22 server/db/schema.sql
```
Confirm `pay_periods.status` exists and its open value is literally `'open'`, and that `payout_events` has `line_total_cents`, `wage_cents`, `rate_cents`, `card_tip_net_cents`, `adjustment_cents`. Fix the query to the real names if any differ. If the period-open concept is a boolean or a different column (e.g. `frozen_at`), use that instead and keep the semantics: never write a non-open period.

- [ ] **Step 4: Add the gratuity addend to accrual**

Edit `server/utils/payrollAccrual.js`. There are TWO separate spans to replace, and `gratuityFunded` / `gratuityFee` / `netGratuity` are existing `const` declarations: re-declaring any of them in the same scope is a `SyntaxError`, so replace the existing lines rather than adding new ones.

Locate them first:
```bash
grep -n "gratuityFunded\|grossGratuity\|gratuityFee\|netGratuity" server/utils/payrollAccrual.js
```
As of 2026-07-26 the first span is roughly lines 296-300 (the `gratuityFunded` + `grossGratuity` pair) and the second roughly 335-338 (`gratuityFee` + `netGratuity`). Work from the grep output, not these numbers.

**Span 1** replaces the `gratuityFunded` and `grossGratuity` declarations with:

```javascript
    const gratuityFunded = proposalPaidCents >= proposalTotalCents;
    // CONTRACT gratuity only. This is the value the fee pro-ration is allowed
    // to see, because proRataFeeCents relies on the gratuity being a part of
    // the total_price denominator so the ratio cannot exceed 1.
    const contractGrossGratuity = gratuityFunded
      ? extractGratuityCents(readSnapshot(proposal.pricing_snapshot, { context: 'payrollAccrual' }))
      : 0;

    // Service-extension gratuity (spec 2026-07-25 section 9). Side money: it is
    // NOT in pricing_snapshot and NOT in total_price, so it joins the pool as an
    // event-scoped addend, mirroring how card tips already join. Gated
    // per-extension on status='paid' (its own money arrived), independent of the
    // proposal-level funded gate above, so a deposit-stage event still pays out
    // the gratuity a client actually paid for extra time. An 'overridden'
    // extension contributes nothing: its invoice is voided, so that money never
    // arrives (spec decision 14).
    const extGratRes = await client.query(
      `SELECT COALESCE(SUM(gratuity_cents), 0)::int AS cents
         FROM service_extensions
        WHERE proposal_id = $1 AND status = 'paid'`,
      [proposalId]
    );
    const extensionGratuity = Number(extGratRes.rows[0].cents) || 0;
```

Leave the `feeRes` query exactly as it is. **Span 2** replaces the existing `gratuityFee` and `netGratuity` declarations with:

```javascript
    const gratuityFee = proRataFeeCents(
      contractGrossGratuity, proposalTotalCents, Number(feeRes.rows[0].fee)
    );
    // The addend is applied AFTER fee-netting on purpose, for two reasons.
    // (1) Correctness: extension dollars are outside the total_price
    // denominator, so feeding them into proRataFeeCents would break its
    // ratio-cannot-exceed-1 invariant. (2) Policy: the extension payment's
    // Stripe fee sits outside CONTRACT_LABELS and is therefore not in the fee
    // numerator either, so DRB absorbs it rather than the staff pool. Decided,
    // not accidental; it errs toward staff, consistent with this file's bias.
    const netGratuity = Math.max(0, contractGrossGratuity - gratuityFee) + extensionGratuity;
```

Then confirm there are no stale references: `grep -n "grossGratuity" server/utils/payrollAccrual.js` must return ZERO lines (the identifier is renamed to `contractGrossGratuity`). Also confirm the file still parses: `node --check server/utils/payrollAccrual.js`.

**On the fee-netting rationale, corrected.** `proRataFeeCents` already clamps its ratio with `Math.min(1, ...)` (`payrollMath.js:66`), so feeding extension dollars in would over-net within that clamp rather than produce a ratio above 1. The conclusion is unchanged and still right: the addend goes after netting, both because the denominator genuinely excludes extension money and because the spec decided DRB absorbs that fee. But do not write a comment claiming the clamp does not exist.

- [ ] **Step 5 (12a, lane ext-core): Write the hours-module suite**

Create `server/utils/serviceExtensionPayroll.test.js`. Use the chicago-keyed track-and-restore pay-period fixture pattern (standing test law: read an existing payroll suite first, `grep -ln "pay_period" server/utils/*.test.js server/routes/admin/payroll*.test.js | head -3`, and copy its period setup and restore). Cover:
1. **The setup/breakdown guard.** Seed an untouched line for a 4-hour event the way accrual does, `hours = contracted_hours = 5.5` (that is `contractedHours(4)`). Call `applyExtensionHours({ proposalId, newDurationHours: 4.5 })`. Assert `contracted_hours` and `hours` are now **6.0**, not 4.5. This test exists specifically to catch the underpay defect described in Step 1; if it ever asserts 4.5, the module is wrong.
2. `wage_cents` recomputes as `wageCents(6.0, rate_cents)`.
3. `line_total_cents` recomputes as wage + gratuity + card tip + adjustment.
4. **The payout header.** `payouts.total_cents` for the touched payout equals the new `SUM(line_total_cents)`. Without this the line is right and the paystub still shows the old number.
5. An admin-edited line (`hours = 5`, `contracted_hours = 5.5`) is NOT touched and is counted in `lockedLines`.
6. A line in a `processing` period is NOT touched and is counted in `frozenLines`. Add a second case for `reopened`, which is also not writable.
7. Re-running with the same target is a no-op (`updatedLines === 0`) and does not re-write the payout header.
8. A proposal with no payout lines returns all zeros and an empty `payoutIds` without error.
9. **A held line is never resurrected.** Seed a line with `held_state = 'held'`, `hours = contracted_hours = 0`, `line_total_cents = 0`. Assert `applyExtensionHours` leaves every column untouched and does not count it in `updatedLines`. Without the `held_state IS NULL` filter both guards pass on such a line and an off-roster worker becomes payable.
10. `maybeAlertPayroll` fires on `lockedLines > 0`, on `frozenLines > 0`, and on `multiShiftSkipped`, and does NOT fire when all three are clear. Pass a stub `notify` object and assert on the calls.
11. **Multi-shift events are not touched at all.** Seed a proposal with TWO shift rows, each with its own payout line at `hours = contracted_hours = 5.5`. Call `applyExtensionHours`. Assert `multiShiftSkipped === true`, `updatedLines === 0`, and that BOTH lines still read 5.5. A proposal-wide bump would pay the second shift's crew for an hour they did not work.

- [ ] **Step 6 (12a, lane ext-core): Run the hours suite, then commit 12a**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPayroll.test.js
```
Expected: PASS, 10 tests.

Append ONLY this line to `scripts/money-smoke-list.txt` (the accrual suite's line is added in 12b's own lane; that file's header makes a listed-but-missing file a HARD FAIL, so registering 12b's suite here would break every `server/` push made between the two lanes):
```
server/utils/serviceExtensionPayroll.test.js
```

```bash
git add server/utils/serviceExtensionPayroll.js server/utils/serviceExtensionPayroll.test.js scripts/money-smoke-list.txt
git commit -m "feat(ext): re-seed payout hours when an extension settles

Uses payrollMath.contractedHours (duration + 1h setup + 0.5h breakdown), so a
30-minute extension moves 5.5 to 6.0. Re-seeds only when the admin has not
edited the line, skips held lines and non-open periods, reports both skip
reasons, and recomputes the payout header total the way every sibling writer
does."
```

That is the end of 12a and the end of lane `ext-core`. Dispatch `code-review` on this task's diff before the lane's merge fleet: Task 12 Step 1 calls this the most dangerous code in the plan, and it is the only place the underpay defect could return.

**Everything below is 12b, lane `ext-webhook-payroll`.** It touches only `payrollAccrual.js` and its own suite.

- [ ] **Step 7 (12b): Write the accrual suite**

Create `server/utils/payrollAccrual.extension.test.js`. Cover:
1. A fully-paid proposal with one paid extension carrying `gratuity_cents = 2500`: each bartender's `gratuity_share_cents` is higher than the same setup with no extension, by the extension amount split evenly.
2. A DEPOSIT-stage proposal (`amount_paid < total_price`) with a paid extension: the contract gratuity stays $0 (funded gate false) but the extension gratuity still reaches the bartenders. This proves the two gates are independent.
3. A `pending` extension and an `overridden` extension both contribute $0.
4. The extension gratuity is NOT reduced by any Stripe fee (assert the share equals the split of the raw `gratuity_cents`, so the fee-netting change is provably scoped to contract gratuity).
5. **Two paid extensions on one event both contribute, exactly once each.** Seed two `paid` rows with `gratuity_cents` 2500 and 1000; assert the pool grew by 3500. Then re-run accrual and assert it is still 3500, not 7000: the addend is recomputed from the table each time, never accumulated.
6. **A REFUNDED extension still contributes, and that is deliberate.** Seed a paid extension, then a succeeded `proposal_refunds` row against its payment. Assert the gratuity is still pooled. This test documents the approved spec §14 default rather than a mechanism; if Dallas ever flips the decision, this test is what changes.

**Refunded-extension gratuity: DEFAULT per spec §14, approved 2026-08-03.** A refunded extension still pays the bartender its gratuity share: the staffer worked the time, and the accrual bias errs toward staff. Mechanically, the gratuity addend keys on `status = 'paid'` and nothing marks a `service_extensions` row when its payment is later refunded, so the pool keeps the share by design. Dallas may later flip to pull-from-pool-on-refund with ONE clause (`WHERE NOT EXISTS` a succeeded refund against the extension's invoice, on the addend query) and ONE test; nothing else changes.

- [ ] **Step 8 (12b): Run the accrual suite and every existing payroll suite**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/utils/payrollAccrual.extension.test.js
```
Then every existing payroll suite:
```bash
ls server/utils/payroll*.test.js server/routes/admin/payroll*.test.js
```
Run each alone. Expected: all PASS. The `grossGratuity` rename touches the busiest payroll math in the app, so any failure is a blocker.

- [ ] **Step 9 (12b): Register the suite and commit**

Append ONLY this line to `scripts/money-smoke-list.txt` (12a already added its own):
```
server/utils/payrollAccrual.extension.test.js
```

```bash
git add server/utils/payrollAccrual.js server/utils/payrollAccrual.extension.test.js scripts/money-smoke-list.txt
git commit -m "feat(ext): extension gratuity joins the payroll pool as an addend

Applied after fee-netting: extension dollars are outside the total_price
denominator the fee pro-ration divides by, and DRB absorbs the extension's
Stripe fee rather than the staff pool (spec section 9)."
```

- [ ] **Step 10 (12b): Checkpoint review**

Dispatch `security-review` AND `code-review` on Tasks 11 and 12b together. These are the two money seams; the reviewers should specifically check that `amount_paid` cannot move, that the fee pro-ration is computed on contract gratuity only, and that the extension addend cannot be double-counted across re-accruals.

Note that 12a's diff is NOT in this lane's diff (it landed in `ext-core`), which is why 12a has its own `code-review` at the end of Step 6.

### Task 20: Balance-invoice monitor: off-ledger carve-out

Added 2026-08-03 after a verified freshness audit against main. `balanceInvoiceMonitor.js` postdates this plan's rev 4 and counts every payable invoice toward its billing invariant, so the label flip would make the monitor both cry wolf and mask real gaps once an extension invoice exists.

**Files:**
- Modify: `server/utils/balanceInvoiceMonitor.js`
- Test: `server/utils/balanceInvoiceMonitor.test.js` (existing suite, already in the money-smoke list)

**Interfaces:**
- Consumes: `OFF_LEDGER_INVOICE_LABELS` (Task 2).
- Produces: no new exports. Behavior: off-ledger invoices are invisible to both monitor alert directions.

- [ ] **Step 1: Exclude off-ledger labels from the shared PAYABLE_SUM fragment**

Modify the shared PAYABLE_SUM fragment (balanceInvoiceMonitor.js:39-46) so it excludes invoices whose label is in `OFF_LEDGER_INVOICE_LABELS`. One carve-out fixes BOTH alert directions, because OVER_SQL (lines 76-87) and UNDER_SQL (lines 95-104) share the fragment.

Keep every other bespoke label counted, and preserve the intent of the Eve-Thornton comment (lines 70-75): non-off-ledger bespoke money rolls into `amount_paid` and self-clears, while off-ledger labels are structurally incapable of satisfying the invariant, because their money never enters `amount_paid`. Without the carve-out:
1. a pending extension invoice on a paid-up event would alert daily as over-billed, permanently in the stranded-paid shape Task 13 deliberately leaves `pending`;
2. an open extension invoice would inflate payable in the under-coverage check enough to MASK a genuinely missing Balance invoice.

- [ ] **Step 2: Add the matching test case**

Add to the money-smoke cases in `server/utils/balanceInvoiceMonitor.test.js`: a pending 'Service Extension' invoice on a fully-paid proposal triggers NEITHER alert.

- [ ] **Step 3: Run it and commit**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/utils/balanceInvoiceMonitor.test.js
```
Expected: PASS.

- [ ] **Step 4: Sweep the three consumer "currently empty" comment blocks**

Comment-only edits deferred here from Task 2 (these files are in THIS lane's
footprint, not ext-core's): `paymentIntentSucceeded.js:213-216`,
`refundHelpers.js:376-379`, and `invoiceLifecycle.js:109-114` each assert
`OFF_LEDGER_INVOICE_LABELS` is empty and that the branch "stays wired for a
future genuinely-additive label". Update each to say Service Extension is that
label. No behavior change; the suites from Step 3 stay green.

```bash
git add server/utils/balanceInvoiceMonitor.js server/utils/balanceInvoiceMonitor.test.js \
  server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js \
  server/utils/refundHelpers.js server/utils/invoiceLifecycle.js
git commit -m "fix(ext): balance-invoice monitor carves out off-ledger invoices

One carve-out in the shared PAYABLE_SUM fragment fixes both alert directions:
a pending extension invoice can neither raise a permanent over-billed alert on
a paid-up event nor mask a genuinely missing Balance invoice. Also sweeps the
three consumer comment blocks that still called the off-ledger set empty."
```

### Task 21: Cancel-line overpayment math: off-ledger carve-out

Same audit, same lane. `sumOffContractPaidCents` also postdates rev 4 and would silently misprice cancel-line refunds once a paid extension exists.

**Files:**
- Modify: `server/utils/invoiceExtras.js` (`sumOffContractPaidCents`)
- Test: `server/utils/lineItemCancel.test.js` (existing suite, already in the money-smoke list)

**Interfaces:**
- Consumes: `OFF_LEDGER_INVOICE_LABELS` (Task 2).
- Produces: no new exports. Behavior: extension payments never become a netting term in cancel-line overpayment math.

- [ ] **Step 1: Skip off-ledger labels in `sumOffContractPaidCents`**

Modify `sumOffContractPaidCents` (`server/utils/invoiceExtras.js:332-353`) to also skip labels in `OFF_LEDGER_INVOICE_LABELS`. Today it counts every non-void invoice with `amount_paid > 0` whose label is NOT in `IN_TOTAL_PRICE_LABELS` (invoiceExtras.js:311-313), and `lineItemCancel.js:695-709` computes `overpaymentCents = max(0, amount_paid - total - offContract)`. A paid extension invoice would default into that sum while its money never entered `proposals.amount_paid` (the webhook's off-ledger skip), deflating a genuine overpayment and under-refunding the client on a cancel-line. Off-ledger money is off BOTH sides of the `amount_paid` equation and can never be a netting term.

`IN_TOTAL_PRICE_LABELS` must NOT (and today does not) contain 'Service Extension'; that half of the classification is correct by default and stays untouched.

- [ ] **Step 2: Add the test case**

Add to `server/utils/lineItemCancel.test.js`: a paid extension on the proposal does not change `overpaymentCents`.

- [ ] **Step 3: Run it and commit**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/utils/lineItemCancel.test.js
```
Expected: PASS.

```bash
git add server/utils/invoiceExtras.js server/utils/lineItemCancel.test.js
git commit -m "fix(ext): cancel-line overpayment math skips off-ledger payments

Extension money never enters amount_paid, so counting its paid invoice in
sumOffContractPaidCents would deflate a genuine overpayment and under-refund
the client on a cancel-line."
```

### Task 13: Expiry sweep and scheduler registration

The hard stop is the entire coverage argument in the spec, and nothing enforces it without this. The sweep also sends the decline message, which is the one carrying the insurance warning.

**Files:**
- Create: `server/utils/serviceExtensionSweep.js`
- Modify: `server/index.js` (scheduler registration)
- Test: `server/utils/serviceExtensionSweep.test.js`

**Interfaces:**
- Consumes: `closeExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `cancelOpenInvoiceIntents` (existing); `applyExtensionHours`, `maybeAlertPayroll` (Task 12a).
- Produces:
  - `sweepExpiredExtensions()` → `Promise<{ expired, notified, stranded }>`
  - `healUnfinalizedExtensions()` → `Promise<{ healed: number }>`. The crash-recovery half; the scheduler runs both on the same tick.

**Why the heal exists.** `settleExtension` commits the `paid` status and the duration bump, and THEN the caller runs payroll and the staff greenlight. If the process dies in between, that row is `paid` with `finalized_at IS NULL`: payroll still holds the old hours, no bartender was told, Stripe will not replay because the webhook's `isFirstDelivery` gate already consumed the event, and the expiry sweep ignores it because it is not `pending`. Nothing else in the system would ever notice. The heal re-runs the side effects, which are all idempotent: `applyExtensionHours` no-ops when `contracted_hours` already equals the target, and the staff message is worth re-sending because the alternative is a bartender who was never told at all.

- [ ] **Step 1: Write the sweep**

Create `server/utils/serviceExtensionSweep.js`:

```javascript
'use strict';

/**
 * Expire pending service-extension requests (spec section 5.5).
 *
 * The hard stop is the whole coverage argument: no greenlight means bar service
 * ends at the contracted time. Nothing enforces that without this sweep, so it
 * is load-bearing rather than housekeeping.
 *
 * closeExtension's claim (WHERE status='pending') is the race gate against a
 * payment settling at the same moment: exactly one of the two wins, and the
 * webhook's post-commit path contains the losing case by alerting for a refund
 * rather than extending an event nobody paid for.
 *
 * Runs every 60 seconds because a bartender is standing at a bar waiting, and
 * the decline message carries the insurance warning.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { closeExtension } = require('./serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll } = require('./serviceExtensionPayroll');
const { cancelOpenInvoiceIntents } = require('./invoiceVoid');
const notify = require('./serviceExtensionNotify');

// Cap per tick so a backlog cannot make one run unbounded. At real volume
// (a handful of events a night) this is never reached.
const SWEEP_LIMIT = 50;

async function sweepExpiredExtensions() {
  const { rows } = await pool.query(
    `SELECT id FROM service_extensions
      WHERE status = 'pending' AND expires_at < NOW()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [SWEEP_LIMIT]
  );
  if (rows.length === 0) return { expired: 0, notified: 0 };

  let expired = 0;
  let notified = 0;
  let stranded = 0;

  for (const { id } of rows) {
    try {
      // Read the copy inputs AND the invoice status BEFORE claiming.
      const pre = await pool.query(
        `SELECT se.contracted_end_time, se.proposal_id, i.status AS invoice_status
           FROM service_extensions se
           LEFT JOIN invoices i ON i.id = se.invoice_id
          WHERE se.id = $1`,
        [id]
      );
      const contractedEndDisplay = pre.rows[0] ? pre.rows[0].contracted_end_time : null;

      // STRANDED-PAID GUARD. A pending row whose invoice is already PAID means
      // the client paid but the settle never ran: the webhook committed the
      // payment and then the process died before its post-commit tail, or the
      // tail threw. Expiring it here would be the worst outcome in the feature:
      // DRB keeps the money, the event is never extended, and the bartender gets
      // told service is over. The invoice void would also silently no-op against
      // its own `status <> 'paid'` guard, so nothing would even look wrong.
      // Leave the row pending, alert, and let a human settle or refund it.
      if (pre.rows[0] && pre.rows[0].invoice_status === 'paid') {
        await notify.alertAdminsProblem({
          proposalId: pre.rows[0].proposal_id,
          kind: 'paid_extension_stranded',
          detail: `Extension ${id} is still pending but its invoice is PAID. The client paid and the event was NOT extended. Settle it by hand (bump the duration and the shift end time, and check payroll hours) or refund the payment. The bartender has NOT been told anything.`,
        });
        stranded += 1;
        continue;
      }

      const closed = await closeExtension({ extensionId: id, outcome: 'expired' });
      if (!closed.ok) continue; // a settle or an admin won the claim
      expired += 1;

      // Make the invoice unpayable. Best-effort intent cancel first so a client
      // mid-checkout cannot complete against an invoice about to be voided.
      if (closed.invoiceId) {
        await cancelOpenInvoiceIntents(closed.proposalId, closed.invoiceId);
        await pool.query(
          "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
          [closed.invoiceId]
        );
      }

      const result = await notify.notifyStaffOfOutcome({
        staffUserIds: closed.staffUserIds,
        outcome: 'declined',
        newEndDisplay: null,
        contractedEndDisplay,
        proposalId: closed.proposalId,
      });
      notified += result.notified.length;
    } catch (err) {
      // One bad row must not stop the sweep: the next tick retries it, and the
      // claim makes that safe.
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, { tags: { feature: 'service-extension', step: 'sweep' }, extra: { extensionId: id } });
      }
      console.error(`[serviceExtensionSweep] extension ${id} failed:`, err.message);
    }
  }

  if (expired > 0 || stranded > 0) {
    console.log(`[serviceExtensionSweep] expired ${expired}, notified ${notified} staffer(s), stranded-paid ${stranded}`);
  }
  return { expired, notified, stranded };
}

/**
 * Crash recovery: re-run the post-settle side effects for rows that settled but
 * never finalized. See the note in the task body for why nothing else catches
 * this state. A short age gate keeps the heal from racing a settle that is still
 * legitimately mid-tail.
 */
async function healUnfinalizedExtensions() {
  const { rows } = await pool.query(
    `SELECT id, proposal_id, requested_duration_hours, contracted_end_time,
            requested_end_time, status
       FROM service_extensions
      WHERE finalized_at IS NULL
        AND status IN ('paid', 'overridden')
        AND updated_at < NOW() - INTERVAL '2 minutes'
      ORDER BY updated_at ASC
      LIMIT $1`,
    [SWEEP_LIMIT]
  );
  if (rows.length === 0) return { healed: 0 };

  let healed = 0;
  for (const row of rows) {
    try {
      // Both side effects are idempotent: applyExtensionHours no-ops when
      // contracted_hours already equals the target, and re-sending the greenlight
      // beats a bartender who was never told.
      const payroll = await applyExtensionHours({
        proposalId: row.proposal_id,
        newDurationHours: Number(row.requested_duration_hours),
      });
      await maybeAlertPayroll(notify, row.proposal_id, payroll);

      const staffUserIds = await assignedStaffUserIdsFor(row.proposal_id);
      await notify.notifyStaffOfOutcome({
        staffUserIds,
        outcome: 'approved',
        newEndDisplay: row.requested_end_time,
        contractedEndDisplay: row.contracted_end_time,
        proposalId: row.proposal_id,
      });

      await pool.query(
        'UPDATE service_extensions SET finalized_at = NOW(), updated_at = NOW() WHERE id = $1',
        [row.id]
      );
      healed += 1;
      await notify.alertAdminsProblem({
        proposalId: row.proposal_id,
        kind: 'settle_on_closed_event',
        detail: `Extension ${row.id} settled but its follow-up work never ran (likely a restart mid-request). It has now been healed: payroll hours re-applied and the crew re-notified. Spot-check the payout line and that the bartender knows.`,
      });
    } catch (err) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, { tags: { feature: 'service-extension', step: 'heal' }, extra: { extensionId: row.id } });
      }
      console.error(`[serviceExtensionSweep] heal of ${row.id} failed:`, err.message);
    }
  }
  if (healed > 0) console.log(`[serviceExtensionSweep] healed ${healed} unfinalized extension(s)`);
  return { healed };
}

/** Roster lookup for the heal path (settleExtension returns this on the live path). */
async function assignedStaffUserIdsFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL`,
    [proposalId]
  );
  return rows.map((r) => r.user_id);
}

module.exports = { sweepExpiredExtensions, healUnfinalizedExtensions, SWEEP_LIMIT };
```

- [ ] **Step 2: Register the scheduler**

Edit `server/index.js`. Copy the `RUN_REFUND_PENDING_SWEEP_SCHEDULER` block's exact shape (read it first: `grep -n "RUN_REFUND_PENDING_SWEEP_SCHEDULER" -A8 server/index.js`) and add alongside it:

```javascript
      // Service-extension expiry (spec 2026-07-25 section 5.5): a 60s sweep that
      // makes the hard stop real. A pending request past its grace window is
      // expired, its invoice voided, and every assigned staffer told service
      // ends at the contracted time. Load-bearing, not housekeeping.
      if (enabled('RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER')) {
        const { sweepExpiredExtensions, healUnfinalizedExtensions } = require('./utils/serviceExtensionSweep');
        // One wrapped job, both halves: expire what timed out, then heal any
        // settled-but-unfinalized row a crash left behind.
        const wrapped = wrapScheduler('service_extension_sweep', 60, async () => {
          const a = await sweepExpiredExtensions();
          const b = await healUnfinalizedExtensions();
          return { ...a, ...b };
        });
        setTimeout(wrapped, 60000); // stagger from the other schedulers
        setInterval(wrapped, 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('service_extension_sweep');
      }
```

Match the `wrapScheduler(name, expectedIntervalSeconds, fn)` argument order to the sibling blocks exactly; verify by reading two of them.

- [ ] **Step 3: Write the test**

Create `server/utils/serviceExtensionSweep.test.js`. Stub `serviceExtensionNotify` and `getStripe`. Cover:
1. A pending row with `expires_at` in the past becomes `expired`, its invoice becomes `void`, and the decline notify was called with `outcome: 'declined'` and the correct `contractedEndDisplay`.
2. `proposals.event_duration_hours` is UNCHANGED by expiry.
3. A pending row with `expires_at` in the FUTURE is untouched.
4. An already-`paid` row is untouched and its invoice is not voided.
5. A row whose invoice is already `paid` does not get voided (the `status <> 'paid'` guard), while the extension still expires.
6. Two consecutive sweeps expire the row exactly once (`expired: 1` then `expired: 0`).
7. A row that throws mid-processing does not prevent a second eligible row from expiring: seed two expired rows on different proposals, force a failure on the first (e.g. stub `notifyStaffOfOutcome` to throw once), and assert the second still reached `expired`.
8. **The stranded-paid guard.** Seed a `pending` row past `expires_at` whose invoice is `status = 'paid'` (the crash-between-commit-and-settle shape). Assert: the row is STILL `pending`, `stranded === 1`, `expired === 0`, `alertAdminsProblem` was called with `kind: 'paid_extension_stranded'`, and `notifyStaffOfOutcome` was NOT called. Expiring this row would keep the client's money, leave the event unextended, and tell the bartender to stop serving, all silently.

- [ ] **Step 4: Run it**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSweep.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the scheduler wiring parses**

Do NOT `require('server/index.js')`: it opens a real listener and will `EADDRINUSE` against the Claude-managed dev server, which reads as a wiring failure when nothing is wrong.

Syntax-check instead, then prove the new module loads standalone:
```bash
node --check server/index.js && echo "index.js parses"
node --env-file=/home/drbartender/projects/os/.env -e "
const m=require('/home/drbartender/projects/os/server/utils/serviceExtensionSweep');
console.log('sweep export:', typeof m.sweepExpiredExtensions);
process.exit(0);
"
```
Expected: `index.js parses` and `sweep export: function`.

To exercise the registration block itself, restart the dev server (it is a Claude-managed background process with no auto-reload) and confirm the boot log lists the schedulers without an error.

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionSweep.js server/utils/serviceExtensionSweep.test.js server/index.js
git commit -m "feat(ext): 60s expiry sweep behind RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER

Expires the request, voids the invoice, and sends the decline carrying the
insurance warning. The claim-on-pending gate is what makes the settle/expire
race single-winner."
```

- [ ] **Step 7: Lane gate**

Run every suite in this lane one at a time, plus every pre-existing webhook and payroll suite. Then the full fleet declared in front-matter.

---

## Lane ext-ui

Three surfaces. `ShiftDetail.js` (795 lines as of 2026-08-03) and `InvoicePage.js` (373 lines) are both existing files: add the minimum to each and put real content in new components.

**Verification for every task in this lane:** the only thing that catches CI-fatal ESLint warnings locally is the exact Vercel build. After each task run:

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0. A warning here fails the real deploy, so treat it as a failure.

### Task 14: Staff request screen

> **Rebuilt surface (2026-08-03):** the staff event-details redesign shipped and rebuilt ShiftDetail. Everything in this task was re-verified against the new code; the old action-button-row instructions are gone.

**Files:**
- Create: `client/src/pages/staff/RequestMoreTime.js`
- Modify: `client/src/pages/staff/ShiftDetail.js` (state flag + mount only)
- Modify: `client/src/components/staff/EventActionArea.js` (the entry button, in the `'assigned'` branch)

**Interfaces:**
- Consumes: `GET /api/service-extensions/eligibility/:shiftId`, `POST /api/service-extensions` (Task 7); display-context props from ShiftDetail's already-fetched event-details payload (Step 2).
- Produces: `<RequestMoreTime shiftId={...} onClose={...} />`, a bottom-sheet component.

**Flow model (updated 2026-08-03):** model RequestMoreTime on `client/src/components/staff/RequestSheet.js` (349 lines, shipped 8/03): a bottom-sheet on the sp-modal chassis with scrim, Esc-close, and a submit-lock (RequestSheet.js:288-316), plus the parent-refetch-on-submitted contract (ShiftDetail.js:351-362). Its required-ack checkbox for hosted events, keyed on `package_pricing_type === 'per_guest'` (RequestSheet.js:74, 127, 178-201), is exactly the D4 "I have the product" tick pattern. The old drop/cover states this plan previously pointed at now live across DropCoverModal + EventActionArea.

- [ ] **Step 1: Build the component**

Create `client/src/pages/staff/RequestMoreTime.js`:

```javascript
import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

/**
 * Staff-facing "request more time" panel (spec 2026-07-25 section 5.1).
 *
 * The staffer picks a NEW END TIME from a picker that opens on the contracted
 * end and steps in 30 minutes. NO PRICE is shown, and the API deliberately does
 * not return one (spec decision 2), so there is nothing here to leak.
 */
export default function RequestMoreTime({ shiftId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState(null);
  const [error, setError] = useState('');
  const [choiceHours, setChoiceHours] = useState(null);
  const [productConfirmed, setProductConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/service-extensions/eligibility/${shiftId}`);
      setEligibility(res.data);
    } catch (err) {
      // api.js rejects with the normalized { message, code, fieldErrors, status }
      // shape (client/src/utils/api.js:45-50). err.response NEVER exists on the
      // rejected value, and a no-restricted-syntax lint rule bans err.response
      // reads in client code, so this task's own CI=true build gate would fail
      // on one. Models: RequestSheet.js:141-147, ShiftDetail.js:319-327.
      setError(err.message || 'Could not load this event. Try again.');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (choiceHours === null) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/service-extensions', {
        shiftId,
        requestedEndHours: choiceHours,
        hostedProductConfirmed: productConfirmed,
      });
      setSent(true);
    } catch (err) {
      // Normalized error shape again: field errors arrive as err.fieldErrors,
      // the message as err.message. Never err.response (see the note in load()).
      setError(
        (err.fieldErrors && Object.values(err.fieldErrors)[0])
        || err.message
        || 'Could not send the request. Try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="sp-card"><div className="sp-skeleton" style={{ height: '4rem' }} /></div>;
  }

  if (sent) {
    return (
      <div className="sp-card">
        <div className="sp-detail-title">Request sent</div>
        <p className="sp-detail-sub">
          The client has been texted to confirm. You will get a message either way.
          Until then, bar service ends at the contracted time.
        </p>
        <button type="button" className="sp-btn sp-btn-sm" onClick={onClose}>Close</button>
      </div>
    );
  }

  const blocked = eligibility && !eligibility.eligible;
  const blockedCopy = {
    already_pending: 'A request for this event is already with the client.',
    too_early: 'You can request more time once the event has started.',
    too_late: 'The window to request more time for this event has closed.',
    unparseable_shift_time: 'We could not read this event’s times. Contact management.',
  };

  // Step the picker in 30-minute increments from the contracted end.
  const steps = [];
  if (eligibility) {
    const maxSteps = Math.round((eligibility.maxAdditionalHours || 3) / 0.5);
    for (let i = 1; i <= maxSteps; i++) steps.push(i * 0.5);
  }
  const baseHours = eligibility?.contractedDurationHours;

  return (
    <div className="sp-card">
      <div className="sp-detail-title">Request more time</div>
      <div className="sp-detail-sub">
        Bar service is contracted to end at {eligibility?.contractedEndDisplay || 'the scheduled time'}.
      </div>

      {blocked && (
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            {blockedCopy[eligibility.reason] || 'More time cannot be requested for this event right now.'}
          </div>
        </div>
      )}

      {!blocked && (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: '0.8rem 0' }}>
            <legend className="sp-detail-sub">New end time</legend>
            {steps.map((added) => (
              <label key={added} className="sp-row" style={{ gap: '0.5rem', padding: '0.35rem 0' }}>
                <input
                  type="radio"
                  name="ext-end"
                  checked={choiceHours === (baseHours + added)}
                  onChange={() => setChoiceHours(baseHours + added)}
                />
                <span>{eligibility.stepLabels?.[String(added)] || `plus ${added * 60} minutes`}</span>
              </label>
            ))}
          </fieldset>

          {eligibility?.isHosted && (
            <label className="sp-row" style={{ gap: '0.5rem', margin: '0.6rem 0' }}>
              <input
                type="checkbox"
                checked={productConfirmed}
                onChange={(e) => setProductConfirmed(e.target.checked)}
              />
              <span>I have the product to serve this extra time.</span>
            </label>
          )}

          {error && (
            <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
              <div className="sp-error-card-msg">{error}</div>
            </div>
          )}

          <div className="sp-row" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              disabled={choiceHours === null || submitting || (eligibility?.isHosted && !productConfirmed)}
              onClick={submit}
            >
              {submitting ? 'Sending...' : 'Ask the client'}
            </button>
            <button type="button" className="sp-btn sp-btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Confirm the API already returns what the picker needs, and plumb display context as props**

`contractedDurationHours` and `stepLabels` come from Task 7's eligibility response; this lane does NOT edit any server file. Verify before building the UI:

```bash
grep -n "contractedDurationHours\|stepLabels" server/routes/serviceExtensions/create.js
```
Expected: both present. If either is missing, stop: it belongs in `ext-routes`, and adding it here would put this lane outside its declared footprint and abort it.

**Display-context plumbing (verified 2026-08-03).** The shift-keyed endpoint `GET /api/shifts/:shiftId/event-details` (server/routes/eventDetails.js:48-114, payload built by server/utils/eventDetailsPayload.js) already carries what RequestMoreTime needs for DISPLAY: `proposal.event_date` / `event_start_time` / `event_duration_hours` / `event_timezone` (eventDetailsPayload.js:288-291) and hosted-ness as `package.pricing_type` (:314; ShiftDetail derives `requestSheetShift.package_pricing_type` at :261-272). Pass `isHosted` and the contracted-time context down as props from ShiftDetail's already-fetched details instead of a second round trip. The NEW eligibility endpoint remains authoritative for the window check, the pending-request check, and the DST-correct `stepLabels` via `eventEndInstantForDuration`. D2 cuts both ways here: the event-details payload is price-free by construction (eventDetailsPayload.js:58-60, 92-99), and the eligibility response must stay equally price-free.

- [ ] **Step 3: Add the entry point via EventActionArea**

`ShiftDetail.js` is 795 lines, past the soft cap, so add NOTHING substantial: only a lazy import, one state flag, and the mount. Do not add logic.

The 2026-08-03 redesign removed the old action-button row, and `shiftRow` no longer exists: it was replaced by `myShift` (ShiftDetail.js:167-170), and the shift id is `shiftId`, parsed from the URL at :73-74. The "Request more time" button renders inside `client/src/components/staff/EventActionArea.js`'s `'assigned'` branch (EventActionArea.js:132-170), passed as an `onExtend` prop from ShiftDetail.

In ShiftDetail, keep only:

```javascript
const RequestMoreTime = React.lazy(() => import('./RequestMoreTime'));
```

State: `const [showExtend, setShowExtend] = useState(false);`

Pass `onExtend={() => setShowExtend(true)}` into the existing `<EventActionArea ...>`, render the button in its `'assigned'` branch, and mount the sheet from ShiftDetail:

```javascript
      {showExtend && (
        <React.Suspense fallback={<div className="sp-skeleton" style={{ height: '4rem' }} />}>
          <RequestMoreTime shiftId={shiftId} onClose={() => setShowExtend(false)} />
        </React.Suspense>
      )}
```

Two structural bonuses of the rebuilt surface, both load-bearing:

1. `viewerState === 'assigned'` keys on `myShift.my_request_status === 'approved'` (ShiftDetail.js:203), PER SHIFT, exactly mirroring create.js's per-shift assignment predicate. The button can never show to a worker assigned to a different shift of the same event (the 2026-08-03 codex lesson, encoded as `isEventStaffer` vs `isAssignedHere` at ShiftDetail.js:474-475).
2. During the request window (the event has started), `dropDefaultMode` is null (ShiftDetail.js:224-230, the past-event guard), so the extend button is the sole action in the assigned branch.

- [ ] **Step 4: Confirm the file did not grow past its cap**

Run: `node scripts/check-file-size.js --staged` after staging, and `wc -l client/src/pages/staff/ShiftDetail.js`.
Expected: still under 1000 and grown by roughly 10 lines. If the ratchet blocks, extract the action-button row into its own component rather than using `--no-verify`.

- [ ] **Step 5: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/pages/staff/RequestMoreTime.js client/src/pages/staff/ShiftDetail.js client/src/components/staff/EventActionArea.js
git commit -m "feat(ext): staff request-more-time screen, price-free by construction"
```

### Task 15: Invoice page terms gate

**Files:**
- Modify: `client/src/pages/invoice/InvoicePage.js`

**Interfaces:**
- Consumes: the `extension` block on `GET /api/invoices/t/:token` (Task 8); `POST /api/service-extensions/t/:token/accept` (Task 8).
- Produces: no exports. Behavior: pay disabled until accepted; zero-delta shows Accept only.

- [ ] **Step 1: Add the terms block and gate**

Edit `client/src/pages/invoice/InvoicePage.js`. Add state:

```javascript
  // Service-extension terms gate (spec 2026-07-25 decision 8). Non-null only
  // for an extension invoice, so every ordinary invoice renders exactly as before.
  const [extension, setExtension] = useState(null);
  const [accepting, setAccepting] = useState(false);
```

The server nests `extension` INSIDE `invoice` (Task 8), and this page stores `data.invoice`. So at BOTH fetch sites in this file (the initial `useEffect` load and the post-payment refetch), add:

```javascript
        setExtension(data.invoice?.extension || null);
```

Reading `data.extension` would silently yield `null` forever, leaving the payment gate permanently open while every server test passes.

Add the accept handler:

```javascript
  const acceptTerms = async () => {
    setAccepting(true);
    setFormError('');
    try {
      const res = await api.post(`/service-extensions/t/${token}/accept`);
      setExtension((prev) => ({ ...prev, accepted_at: res.data.acceptedAt, requires_acceptance: false }));
      // A zero-delta request settles on acceptance: nothing left to pay.
      if (!res.data.requiresPayment) setPaymentSuccess(true);
    } catch (err) {
      // api.js rejects with the normalized { message, code, fieldErrors, status }
      // shape (client/src/utils/api.js:45-50); err.response never exists on it,
      // and the no-restricted-syntax lint rule that bans err.response reads
      // would fail this task's CI=true build gate.
      setFormError(err.message || 'Could not record your acceptance. Please try again.');
    } finally {
      setAccepting(false);
    }
  };
```

Render the terms above the payment section, and gate the pay control:

```javascript
      {extension?.is_extension && extension.terms && !paymentSuccess && (
        <section className="invoice-extension-terms">
          <h2>{extension.terms.headline}</h2>
          {extension.terms.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          {extension.requires_acceptance ? (
            <button type="button" className="btn" onClick={acceptTerms} disabled={accepting}>
              {accepting
                ? 'Confirming...'
                : (extension.requires_payment ? 'Accept and continue to payment' : 'Accept')}
            </button>
          ) : (
            <p className="invoice-extension-accepted">Accepted. Thank you.</p>
          )}
        </section>
      )}
```

Then gate the existing payment reveal so an extension invoice cannot show the payment element before acceptance. Find where `showPayment` is set true and add the guard:

```javascript
  const paymentBlockedByTerms = Boolean(extension?.is_extension && extension.requires_acceptance);
```
and use `{showPayment && !paymentBlockedByTerms && ( ... )}` on the payment section, plus `disabled={paymentBlockedByTerms}` on whatever button reveals it.

- [ ] **Step 2: Add the CSS**

`client/src/index.css` is already in this lane's declared footprint, so no front-matter change is needed (and editing this plan doc from a lane would be blocked by the off-main guard anyway). Add to it (vanilla CSS, no modules), near the other `invoice-` rules:

```css
.invoice-extension-terms {
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin: 1.25rem 0;
}
.invoice-extension-terms h2 { margin-top: 0; font-size: 1.15rem; }
.invoice-extension-terms p { font-size: 0.92rem; line-height: 1.5; }
.invoice-extension-accepted { font-weight: 600; }
```

- [ ] **Step 3: Verify against a real extension invoice**

The dev server is a Claude-managed background process with no auto-reload for server edits: restart it after the server-side tasks. Then create a pending extension against a dev proposal (reuse the `create.test.js` fixture pattern via a scratch script in the scratchpad directory), open `/invoice/<token>`, and confirm:
1. The terms block renders and the pay control is unavailable.
2. Clicking Accept enables payment.
3. An ORDINARY Balance invoice's page is visually unchanged and pays as before. This is the regression that matters most: this page is every client's payment surface.

Take screenshots with the mobile-check harness (`playwright-core`, screenshots into the scratchpad directory) at 390px width as well, since clients open these on phones.

- [ ] **Step 4: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/pages/invoice/InvoicePage.js client/src/index.css
git commit -m "feat(ext): terms gate on the invoice page, inert for ordinary invoices"
```

### Task 16: Admin extensions panel

**Files:**
- Create: `client/src/components/adminos/ServiceExtensionPanel.js`
- Modify: `client/src/pages/admin/EventDetailPage.js`

**Interfaces:**
- Consumes: `GET /api/service-extensions/proposal/:proposalId`, `POST /:id/override`, `POST /:id/cancel` (Task 10).
- Produces: `<ServiceExtensionPanel proposalId={...} />`. Renders nothing when there are no extensions.

- [ ] **Step 1: Build the panel**

Create `client/src/components/adminos/ServiceExtensionPanel.js` with:
- A load on mount via `api.get(\`/service-extensions/proposal/${proposalId}\`)`, with loading skeleton and an error state that offers Retry.
- **Renders `null` when `extensions.length === 0`** (spec: empty state is a hidden panel, no new top-level page).
- One row per extension: status chip, requester name, `contracted_end_time` to `requested_end_time`, the amount formatted from `amount_cents`, accepted-at, and the invoice status.
- On a `pending` row: a Cancel button, and an Override button that opens a required-reason textarea (min 3 chars, max 500, matching the server rule) and warns inline that overriding grants the time with no charge and voids the invoice.
- After either action, re-load and surface `payrollWarning` from the response as a visible banner when present, since a silently underpaid bartender is the failure mode this warning exists to prevent.
- Money is shown here on purpose: this is the admin surface, unlike every staff surface.
- Panel copy on a pending row steers admins to the extension's own Cancel action for extension invoices (e.g. "Cancel here, not from the invoice list: this also tells the bartender"). The generic admin invoice Void control (invoices.js:407-447, `amount_paid = 0` guard) can void a pending extension invoice WITHOUT touching the `service_extensions` row, which then sits `'pending'` until the sweep expires it. Benign (the public accept joins `i.status <> 'void'` so it 404s, and create-intent refuses a non-sent/partially_paid invoice), but staff hear nothing until expiry; the extension's Cancel sends the decline immediately.
- No em dashes in any string.

- [ ] **Step 2: Mount it on the event detail page**

Edit `client/src/pages/admin/EventDetailPage.js`. Import the panel and render it in the existing detail column, passing the proposal id the page already has. Verified 2026-08-03: the right-rail vstack integration point is `EventDetailPage.js:534`, the page is 621 lines, so the over-cap contingency is moot. Neighboring precedent: `AdminMenuPrintBlock` lives at `client/src/components/AdminMenuPrintBlock.js` (NOT `components/staff/`).

- [ ] **Step 3: Verify in the app**

With a pending extension seeded on a dev event, open the admin event page and confirm: the panel lists the request, Cancel voids it and flips the row to cancelled, Override requires a reason, and after an override the invoice shows `void` and the duration reflects the new end. Confirm the panel is absent entirely on an event with no extensions.

- [ ] **Step 4: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/components/adminos/ServiceExtensionPanel.js client/src/pages/admin/EventDetailPage.js
git commit -m "feat(ext): admin extensions panel with override, cancel, and the payroll warning"
```

- [ ] **Step 5: Lane gate**

Full fleet per front-matter, including `ui-ux-review` on the three surfaces at 390px.

---

## Lane ext-docs

### Task 17: Mandatory documentation updates

Per the mandatory-updates table, every one of these is required, not optional.

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `.claude/CLAUDE.md`, `.env.example`

- [ ] **Step 1: README.md**

Add to the folder-structure tree: `server/routes/serviceExtensions/` (create, publicAccept, admin), `server/utils/serviceExtension{Pricing,Settle,Notify,Sweep,Payroll}.js`, `server/utils/eventEndInstant.js`, `server/data/extensionTermsCopy.js`, `client/src/pages/staff/RequestMoreTime.js`, `client/src/components/adminos/ServiceExtensionPanel.js`.

Add to Key Features: on-site service extension (staff-initiated added bar time, client accepts coverage terms and pays on the invoice page, duration and payroll hours move, side money).

- [ ] **Step 2: ARCHITECTURE.md**

Add to the API route table: the five new endpoints plus the two modified ones (`GET /api/invoices/t/:token` gains the extension block; `POST /api/stripe/create-intent-for-invoice/:token` gains the acceptance gate).

Add `service_extensions` to the Database Schema section with its columns and the partial unique index.

Add a short note in the money/invoicing section recording that `OFF_LEDGER_INVOICE_LABELS` is now non-empty and what that flips (webhook `amount_paid` skip, invoice-refresh exclusion, refund-reconciliation skip), plus the reason extension money is deliberately outside `CONTRACT_LABELS`.

- [ ] **Step 3: CLAUDE.md env table**

Add one row:

| `RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER` | Optional. Set to `false` to disable the 60-second service-extension expiry sweep (expires a pending request past its grace window, voids its invoice, sends the staff decline). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |

- [ ] **Step 4: .env.example**

Add the same variable with a brief comment, matching the file's existing style.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md .claude/CLAUDE.md .env.example
git commit -m "docs(ext): README tree, ARCHITECTURE routes + schema, env var for the sweep"
```

### Task 19: The admin refund button cannot target an extension (lane ext-webhook-payroll)

**This is a real gap the spec got wrong, not a nicety.** Spec §7 says "refunding a paid extension is a plain refund of that payment." Verified 2026-07-26: it is not, because there is no way to aim the existing refund at that payment.

`POST /api/stripe/refund/:id` takes an AMOUNT, not a target. It feeds `planRefund` from `loadPaymentsWithRemaining` (`server/routes/stripe.js:463`), and `planRefund` caps the request at `amountPaidDollars` and then walks the payment list picking charges. Two consequences, both bad:

1. **It can refund the wrong charge.** Extension payments are in `loadPaymentsWithRemaining`'s list (they are `payment_type = 'invoice'` rows), so a $100 refund intended for an extension can land on the contract charge instead, dropping `amount_paid` by $100 and corrupting the contract ledger with side money.
2. **It can refuse outright.** Extension dollars never enter `amount_paid`, so on an event whose contract is barely paid, refunding the extension can trip `EXCEEDS_AMOUNT_PAID` (`refundHelpers.js:147`) even though the money is sitting right there at Stripe.

**Re-verified 2026-08-03:** `loadPaymentsWithRemaining` (refundHelpers.js:55-75) is now rails-parameterized (`opts.rails`; `PANEL_REFUND_RAILS` at :26 includes `'invoice'`, `CANCEL_LINE_REFUND_RAILS` at :34) and has TWO money callers: the admin refund panel (`server/routes/stripe.js:463`) and the cancel-line overpayment splitter (`server/routes/proposals/cancelLineItem.js:62` → `planOverpaymentSplits`). The admin refund route itself now flows through `refundExecute` with total_scope-stamped pending rows (stripe.js:479-482), not the old inline orchestration.

**Files:**
- Modify: `server/utils/refundHelpers.js` (`loadPaymentsWithRemaining` candidate filter)
- Test: `server/utils/refundHelpers.extensionScope.test.js`
- Modify: `docs/ops-runbook.md` (the manual procedure)

Add both files plus `docs/ops-runbook.md` to the `ext-webhook-payroll` footprint before starting.

- [ ] **Step 1: Read the refund seam before touching it**

```bash
sed -n 1,60p server/utils/refundHelpers.js
grep -n "loadPaymentsWithRemaining" -A25 server/utils/refundHelpers.js | head -40
cat .claude/seam-sweep-2026-07-02.md 2>/dev/null | head -40
```

This is a battle-tested money path shared with the cancel-line flow. The change below is deliberately the smallest one that closes the hole: EXCLUDE extension payments from the contract refund's candidate set. It does not add a new refund surface.

- [ ] **Step 2: Exclude off-ledger payments from the contract refund candidates**

The exclusion goes INSIDE `loadPaymentsWithRemaining` itself: a payment linked to an OFF_LEDGER-labeled invoice is filtered out regardless of `rails`, and the rails signature is preserved. That single carve-out protects BOTH flows, the admin refund panel and the cancel-line overpayment splitter. Rationale to put in the comment: those dollars are not in `amount_paid`, so letting a contract refund draw against them lets the admin refund money the contract never recorded, and mis-attributes the reversal. A payment split across a contract invoice AND an extension invoice cannot happen (extension invoices are minted alone and paid alone), so a whole-payment exclusion is exact rather than approximate.

- [ ] **Step 3: Write the test**

Create `server/utils/refundHelpers.extensionScope.test.js`:
1. A proposal with a paid Balance payment AND a paid Service Extension payment: `loadPaymentsWithRemaining` returns ONLY the Balance payment.
2. `planRefund` for the full contract amount picks the Balance charge and never the extension charge.
3. A proposal whose ONLY payment is an extension: `loadPaymentsWithRemaining` returns an empty list, so `planRefund` refuses with a clear code rather than silently refunding nothing.
4. Regression: a proposal with only ordinary payments behaves byte-identically to before (run the existing `refundHelpers` suites, which is the real guard).
5. **Cancel-line flow.** A cancel-line total_scope refund must not draw on an extension payment: seed a proposal with a paid contract payment plus a paid extension payment, run the cancel-line overpayment split, and assert no split targets the extension payment.

- [ ] **Step 4: Document the manual procedure**

Extension refunds are done in the Stripe dashboard against that payment, and the existing refund webhook plus the stale-pending sweeper adopt it. That path is already correct for off-ledger money: `applyRefundReconciliation` declares `offLedgerCents` at `refundHelpers.js:293`, accumulates it at `:319`, and deliberately does NOT drop `amount_paid` for it (the no-drop math, `paidDropCents = amountCents - offLedgerCents`, at `:403`).

Add a short runbook entry: how to find the extension's payment (the event's extensions panel shows the invoice), refund it at Stripe, and what to expect afterwards (the contract totals do not move; the duration is NOT auto-reverted, because whether the time was served is a fact only a human knows; and per spec §14's default, approved 2026-08-03, the bartender keeps the gratuity share, unless Dallas later flips to pull-from-pool-on-refund). Also describe the ADMIN panel path as it now works: the refund route flows through `refundExecute` with total_scope-stamped pending rows (stripe.js:479-482); do not describe the old inline orchestration.

- [ ] **Step 5: Run the refund suites, one at a time, and commit**

```bash
for f in $(ls server/utils/refundHelpers*.test.js server/routes/invoices.refunds.test.js); do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```
Expected: all PASS. A failure here is a blocker: this is the refund path.

```bash
git add server/utils/refundHelpers.js server/utils/refundHelpers.extensionScope.test.js docs/ops-runbook.md
git commit -m "fix(refunds): keep contract refunds from drawing against extension payments

Extension dollars are off-ledger and never enter amount_paid, so including their
payments in the contract refund candidate set let an admin refund the wrong
charge (corrupting the contract ledger with side money) or get refused by the
amount_paid cap. Extension refunds go through Stripe directly, where the
existing off-ledger reconciliation already handles them correctly."
```

### Task 18: Revenue-reporting enumeration (spec §12)

The spec names this as the one real cost of going off-ledger and explicitly defers the per-surface decision to the plan, so it needs a task rather than an assumption. Extension revenue lives in `proposal_payments` and `invoices` but NOT in `proposals.amount_paid`. Any surface that totals revenue from `amount_paid` will under-report it; any surface that sums payments will include it. Neither is wrong, but the split has to be known rather than discovered later from a number that looks off.

It also closes spec §12's other deferred item: the four surfaces that read `event_duration_hours` and must be *verified*, not assumed, now that the column moves mid-event.

This task produces a decision record, not a refactor. Any code change it identifies gets raised as its own item.

**Files:**
- Modify: `docs/fix-list-remaining-2026-07-02.md` (record findings + any follow-ups)

- [ ] **Step 0: Verify the `event_duration_hours` consumers (spec §12)**

The column now changes during an event, which it never did before. Spec §12 names four surfaces that read it and says each gets verified; as of the 2026-08-03 staff event-details redesign, two of them (BEO and the staff shift page) are one surface, so three entries cover all four. With a settled extension on a dev event, open each and confirm it shows the NEW end time and duration, not the booked one:

1. **BEO / staff event details, now one surface.** The staff shift page IS the event-details surface, fed by `server/utils/eventDetailsPayload.js` (selects `event_duration_hours` at :63); staff-facing copy dropped the term "BEO" entirely. `server/routes/beo.js` survives as the proposal-keyed admin/legacy route. The verification hits `eventDetailsPayload.js` once plus `beo.js`.
2. **Calendar feed** (`server/routes/calendar.js`, the iCal description and end time).
3. **Client portal** event display (`server/routes/clientPortal.js` and the portal event card).

Record the result per surface. A surface showing the stale duration is a real bug: note it with its file and add it to the fix list in Step 3. Also confirm the Money Board and the events list still render the event without error, since both read the shift and proposal rows this feature touches.

- [ ] **Step 1: Enumerate the revenue surfaces**

```bash
cd /home/drbartender/projects/os
grep -rn "amount_paid" server/routes/admin/ server/routes/proposals/ --include=*.js | grep -v test | grep -iE "sum|total|revenue|collected"
grep -rln "dashboard-stats\|financials\|metrics" server/routes --include=*.js | grep -v test
```

For each hit, write down: the surface name, whether it totals from `amount_paid` or from `proposal_payments` / `invoices`, and therefore whether extension revenue appears in it.

- [ ] **Step 2: Check the Money Board specifically**

The Money Board is the surface most likely to matter. Read its endpoint and record which basis it uses. Also check the Stripe payout matching path, since an extension payment is a real Stripe charge that will appear in a payout and must reconcile.

```bash
grep -rn "amount_paid\|proposal_payments" server/routes/admin/*.js | grep -v test | head -20
```

- [ ] **Step 3: Decide per surface and record it**

For each surface, pick one and write the reason:
- **Leave as is** (it sums payments, so extensions are already included), or
- **Leave as is with a known gap** (it sums `amount_paid`; extensions are excluded and that is acceptable because the surface is about contract performance), or
- **Needs a fix** (the surface claims to show total collected revenue and would be materially wrong).

Append the findings to the fix list under a new heading, "Service-extension revenue reporting (added when the feature shipped)", including the explicit warning: do NOT resolve any discrepancy by rolling the extension payment into `amount_paid`, because that reintroduces the landmine in spec §2 (it would falsely satisfy the funded-gratuity gate and the auto-complete gate).

- [ ] **Step 4: Commit**

```bash
git add docs/fix-list-remaining-2026-07-02.md
git commit -m "docs(ext): enumerate which revenue surfaces include extension money"
```

---

## Spec coverage map

Every spec section, and the task that implements it. Written so a reviewer can check coverage without re-reading the spec.

| Spec | Task |
|---|---|
| D1 staff portal initiates | 7, 14 |
| D2 staff never see the price | 7 (explicit field list + leak tests), 14 |
| D3 no permission gate, assignment predicate instead | 7 |
| D4 hosted product confirmation | 7, 14 |
| D5 new end time, 30-min steps, +3h cap | 4, 14 |
| D6 engine delta, gratuity rides along | 4 |
| D7 regular invoice page | 15 |
| D8 terms accepted before paying, server-enforced | 8, 9 |
| D9 unpaid is a hard stop | 13 |
| D10 contract does not move until settle | 7, 11 |
| D11 SERVICE ends at the contracted time | 6 (copy) |
| D12 side money, off-ledger, no dunning ever | 2, 11 (no-dunning test), 10, 18 |
| D13 zero-delta settles on acceptance | 4, 8 |
| D14 override grants time, no receivable | 10 |
| §5.2 client sends through suppression, admins notified | 6, 7 |
| §5.5 expiry sweep with kill switch | 13 |
| §7 targeted shift sync, multi-shift flagged | 5 |
| §7 paid-after-expiry containment | 11 |
| §7 completed/archived settle does not throw | 11 |
| §8 `service_extensions` table + indexes | 2 |
| §8 versioned terms registry | 3 |
| §8 routes | 7, 8, 9, 10 |
| §8 admin surfaces | 10 (API), 16 (UI) |
| §8 activity log + admin audit log | 5, 7, 10 |
| §8 mandatory docs | 17 |
| §9 payroll hours re-seed (all three settle paths) | 12a, wired in 8, 10, 11 |
| §9 gratuity addend after fee-netting | 12b |
| §9 frozen-period alert | 12a (`maybeAlertPayroll` reports `frozenLines`) |
| §10 copy, channel gates, SMS to push to email fallback | 6 |
| §11 timezone-correct instants | 1 |
| §11 authoritative contracted end (proposal-derived) | 4, 7, 11 (edge case) |
| §11 second extension baseline | 4 |
| §12 cross-cutting consistency | 5, 11, 12, 18 |
| §12 the four `event_duration_hours` consumers verified | 18 Step 0 |
| §12 revenue reporting split | 18 |
| §13 test matrix | distributed; every task carries its slice |

**Deliberately not built:**

- **A test for the flat class-package shape.** Spec §13 asks for "both class shapes." `the-doctors-orders` is the flat-priced class package, but `schema.sql` sets `is_active = FALSE` on it, so it cannot be booked and cannot reach this feature. The per-guest class shape (`extra_hour_rate` 0) IS tested in Task 4. If that package is ever reactivated, add the second case.

Everything else the spec asks for has a task. The spec's own open items (the broker question and the signed-document copy) are tracked on the fix list and are not code.

## Revision history

- **rev 1, 2026-07-26.** First draft. Passed its own inline self-review.
- **rev 2, 2026-07-26.** After the three-agent plan fleet found 14 blockers. The four that would have survived a fully green test run, and are now each guarded by a named test:
  1. Task 2 pasted a `module.exports` block that dropped `TOTAL_TRACKING_INVOICE_LABELS` (landed on main the same day), breaking refund reconciliation. Now additive, with an export-completeness assertion.
  2. Task 12's hours helper returned the bare duration instead of `payrollMath.contractedHours`, which would have cut an hour of pay per line on every extension. Now imports the real helper, and the first test asserts 5.5 becomes 6.0.
  3. Task 7's `router.use(auth)` would have 401'd the public accept route, making client payment impossible. Now per-route `auth`, with a regression test asserting the public path never 401s.
  4. Tasks 8 and 15 disagreed on the response shape, so the terms gate would have silently never rendered. Now nested inside `invoice` on both sides, with a shape-guard test.

  Also fixed: the payroll hours module was wired only into the webhook (missing the override and zero-delta paths); `frozenLines` was computed and never reported; the payout header total was never recomputed; the web-push fallback was dropped; `users.name` and `password` do not exist and every fixture used them; JWTs were signed with the wrong claims; `server/middleware/errorHandler` does not exist; the settle core ran un-transacted; `expires_at` could expire 60 seconds after creation; four footprint omissions would have aborted three lanes; and Task 12a had to move to `ext-core` to break a lane cycle.

- **rev 3, 2026-07-26.** After re-running the fleet on rev 2 plus a cross-model (Gemini) reviewer. Rev 2's four headline fixes verified correct, but rev 2 had introduced seven new defects of its own, and the cross-model pass found two more that all three Claude agents missed. Fixed:
  1. **The staff gratuity was mis-classified (found only by the cross-model review).** `gratuityOf` read `snapshot.gratuity.total`, which holds only the client-elected line. Payroll pools BOTH canonical breakdown labels, and the forced sub-100-guest over-ratio surcharge carries `'Shared Gratuity'` while living inside `staffing.cost`. So on a 50-guest two-bartender event the $25/hr surcharge, which exists specifically to pay bartenders at small events where tips are light, would have been booked as DRB service revenue and never reached the staff pool. Now uses `extractGratuityCents` and derives service as the remainder, with two tests pinning it. This is the rule CLAUDE.md flags as re-lost multiple times.
  2. **A stranded paid extension would have been declined (also cross-model).** If the process died between the webhook's COMMIT and its post-commit settle, the row stayed `pending` with a `paid` invoice; the sweep would then expire it, no-op the invoice void against its own `status <> 'paid'` guard, and text the bartender that service was over. Client charged, event not extended, nobody alerted. The sweep now refuses to expire a row whose invoice is paid and raises an urgent alert instead.
  3. `source_type: 'service_extension'` violates `CHECK (source_type IN ('package','addon','fee','manual'))`, so every request would have 500'd on its first line item. Now `'fee'`.
  4. `serviceExtensionSettle.js` called `pool.connect()` with no `require` for `pool`.
  5. `maybeAlertPayroll` was specified in prose but never defined or exported, and Task 11 imported only half the module.
  6. `applyExtensionHours` did not filter `held_state IS NULL`, so it would have resurrected a deliberately non-payable held line for an off-roster worker.
  7. `sendPush` resolves `{ok:false}` rather than throwing, so a truthiness check counted every push failure as delivered and suppressed the `staff_unreachable` alert on the decline message.
  8. Multi-shift events would have had payroll hours bumped proposal-wide, paying a second shift's crew for an hour they did not work. Now skipped and reported.
  9. The 12a/12b split was declared by step RANGE while the file ownership followed a different line, which would have left 12a untested in one lane and aborted the other on footprint drift. Now split per step, with the `ext-core` gate moved and an explicit forward pointer from Task 5.
  10. The webhook insertion anchor pointed at code still holding a pooled connection, which is the pool deadlock the project has hit twice.

- **rev 4, 2026-07-26.** Codex (gpt-5.5) pass plus my own empirical verification of the pricing math against the live engine. Codex independently re-found two things I had already caught (the `$125` `min_total` correction and the refunded-extension gratuity gap), which is corroboration rather than new work, and added three genuinely new ones:
  1. **The admin refund button cannot target an extension.** `POST /api/stripe/refund/:id` takes an amount, resolves the target through `planRefund` over every payment on the proposal, and caps at `amount_paid`. Extension dollars are deliberately not in `amount_paid`, so that button could refund the wrong (contract) charge or refuse outright. The spec's "plain refund of that payment" claim was false. Now Task 19: exclude off-ledger payments from the contract refund candidates, plus a documented Stripe procedure.
  2. **Pricing was computed outside the transaction.** Two staffers could both price from 4h, the first settle to 4.5h, and the second insert a 4h-to-5h delta, overcharging for a half hour already paid for. Now re-priced under `SELECT ... FOR UPDATE` with a baseline-moved 409.
  3. **Post-settle side effects had no recovery path.** A crash between the settle commit and payroll/greenlight left a `paid` row that Stripe will not replay and the sweep ignored, so payroll kept the old hours and no bartender was told, permanently and invisibly. Now a `finalized_at` column, a `healUnfinalizedExtensions` sweep half, and `finalizeExtension` as the mandatory last step on all three settle paths.
  4. **Payroll line rewrites were not atomic with the payout header recompute**, so a crash between them left a paystub whose lines did not add to its total. Now one transaction.

  Codex also caught a defect in the fix for (2): locking `proposals` in the create route while `settleInTx` claimed the extension row first is an ABBA deadlock (40P01). Both paths now take proposals first, and the create route maps 40P01/40001 to a retryable conflict.

  Verified empirically, not argued: all seven of Task 4's dollar figures were run against the live pricing engine. Six matched exactly, including the $25 Shared Gratuity split. The seventh (`min_total`) was wrong in the plan and is now corrected to the measured $125, with the full reference table moved into the spec.

- **rev 5, 2026-08-03.** Freshness audit against main (3 agents), applied as targeted amendments. New code that postdates rev 4 gained three protections: the balance-invoice monitor's PAYABLE_SUM off-ledger carve-out (Task 20), the `sumOffContractPaidCents` off-ledger skip protecting cancel-line overpayment math (Task 21), and a label guard refusing to mint or rename an invoice INTO an off-ledger label (Task 8 Step 2b). Task 14 was rewritten for the shipped staff event-details redesign (EventActionArea entry point, RequestSheet flow model, normalized `err` shape, display-context props). Task 19 was updated for the rails-parameterized `loadPaymentsWithRemaining` (the carve-out now protects both the admin panel and the cancel-line splitter). Spec §14's refunded-extension gratuity default was approved as-is. Stale line cites and the smsConsentCopy/STOP-guard/`TOTAL_TRACKING` prose claims were corrected; the money-smoke gate is now HARD against the prod-shaped ci-smoke branch.
