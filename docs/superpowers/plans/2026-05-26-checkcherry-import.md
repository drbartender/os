# Check Cherry → DRB OS Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-time importer that migrates all Check Cherry historical data (1,428 proposals / 209 Confirmed events / 337 payments / 116 payouts / 81 leads + Wix staff forms) into DRB OS, plus the admin UI and behavior changes needed for operator-facing wrap-up, review, and re-trigger workflows. Cancellation of CC + Wix subscriptions becomes possible once the sunset gate (Section 14 of the spec) clears.

**Architecture:** A Node script (`scripts/cc-import.js`) runs six phases (0–6) idempotently against the DRB OS database, populating new `legacy_cc_*` archive tables and promoting Bucket-A/B events into native `proposals` + `shifts` + `proposal_payments` + `proposal_refunds`. Two new admin pages (`/admin/cc-import/wrap-up` + `/review`) drive operator workflows. Several existing helpers gain CC-aware guards (`scheduleDrinkPlanNudge`, `accruePayoutsForProposal`, `rollForwardLateTip`, `clawbackTip`). A new `post_event_wrap_up_email` dispatcher handler powers operator-initiated wrap-up emails. The financial dashboard gains an `?include_cc=` filter chip.

**Tech Stack:** Node 18 / Express 4 / React 18 / PostgreSQL via raw `pg`, `csv-parse` (new dependency), `bcryptjs`, existing AES-256-GCM encryption helper, Cloudflare R2, existing `scheduledMessageDispatcher`.

**Spec reference:** `docs/superpowers/specs/2026-05-25-checkcherry-import-design.md` (revision 11, cleared by /review-spec fleet).

**Plan status:** Revision 3. Folds in two rounds of /review-plan fleet findings (fidelity + decomposition + feasibility).

---

## Global Conventions

Every task in this plan follows these conventions — implementer should apply them silently without re-flagging:

1. **Test framework is `node:test` + `node:assert/strict`** (per `package.json:14` and existing tests like `server/utils/drinkPlanNudge.test.js`). The plan's code samples occasionally show Jest-style `expect(...).toBe(...)` for brevity — convert each to `assert.strictEqual(actual, expected)`, `assert.deepStrictEqual(actual, expected)`, `assert.match(string, regex)`, etc. Standard test file scaffolding:
   ```js
   const { test, before, after } = require('node:test');
   const assert = require('node:assert/strict');
   const { pool } = require('../db');
   after(async () => { await pool.end(); });
   ```

2. **`asyncHandler` is a default export** (`module.exports = asyncHandler` in `server/middleware/asyncHandler.js`). All new route files use `const asyncHandler = require('../../middleware/asyncHandler');` — never the destructured form.

3. **`ValidationError` constructor signature is `(fieldErrors, message)`** (per `server/utils/errors.js:11`). Never `new ValidationError('string')` — use `new ValidationError(undefined, 'human message')` for bare messages, or `new ValidationError({ field: 'msg' })` for field-keyed errors.

4. **Sentry must be imported in every new route file** that calls `Sentry.captureException`: `const Sentry = require('@sentry/node');` at the top.

5. **React route guard is `<ProtectedRoute adminOnly>`** (per `client/src/App.js:170`, which already accepts manager role per its internal check). Never `<RequireAdminOrManager>` (not a real component).

6. **Errors imports**: when a route throws `ValidationError`, `NotFoundError`, or `ConflictError`, import all three even if not all are used today — adding one later is a frequent feasibility gap (`const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');`).

7. **Per-phase Sentry summary** (spec §11): each import phase emits ONE summary at end-of-phase, NOT per-row exceptions for data-quality misses:
   ```js
   Sentry.captureMessage(`cc-import phase ${phase} summary`, {
     level: erroredCount > 0 ? 'warning' : 'info',
     extra: { phase, rowsProcessed, errored_count: erroredCount, samples: erroredSamples.slice(0, 5) },
   });
   ```
   Genuine infra failures (DB connection lost, R2 5xx, encryption-key missing) still use per-incident `captureException`.

8. **`CC_DIR` env var** documents where the canonical CC CSVs live. Default `process.env.CC_DIR || 'C:\\Users\\dalla\\Downloads'`. The CLI reads this at start; phases use `path.join(CC_DIR, 'report (N).csv')`. README updated in Task 24.

---

## File Structure

### New files

**Importer (single Node script + lib):**
- `scripts/cc-import.js` — entry, CLI arg parsing, phase routing
- `scripts/cc-import/lib/csv.js` — `csv-parse` wrapper with embedded-newline handling
- `scripts/cc-import/lib/buckets.js` — `SKIP_PACKAGES`, `SKIP_PATTERNS`, `classify(row, today)` → A/B/C/D
- `scripts/cc-import/lib/timeFormat.js` — parse/add/format `H:MM AM/PM` (15-line helper, spec §8.3)
- `scripts/cc-import/lib/db.js` — pg pool factory keyed off `DATABASE_URL`
- `scripts/cc-import/lib/runLog.js` — `cc_import_runs` writer (start, finish, error_summary, notes)
- `scripts/cc-import/lib/money.js` — `parseMoneyCents(str)` for `$X,XXX.XX[-]`
- `scripts/cc-import/lib/dateFmt.js` — `parseCcDate(str)` for `MM-DD-YYYY`
- `scripts/cc-import/lib/encryption.js` — re-export of `server/utils/encryption.js` + sentinel preflight
- `scripts/cc-import/phases/phase0.js` … `phase6.js` — one file per phase
- `scripts/cc-import/lib/fuzzyName.js` — Pass 1→2→3 cascade against `contractor_profiles.preferred_name`

**Server-side new modules:**
- `server/utils/payrollGuards.js` — `isLegacyCcParticipant(proposalId, client)` + `isLegacyCcStubUser(userId, client)`
- `server/utils/ccWrapUpHandler.js` — `registerCcWrapUpHandler()` + `wrapUpHandler`
- `server/utils/ccWrapUpEmailTemplate.js` — `renderCcWrapUpEmail({ client, proposal })` → `{ subject, html, text }`
- `server/routes/admin/ccImport/index.js` — composition router under `/api/admin/cc-import`
- `server/routes/admin/ccImport/wrapUp.js` — `GET /wrap-up`, `POST /wrap-up/enqueue`
- `server/routes/admin/ccImport/review.js` — `GET /review` + 12 action endpoints (Section 9.2 §1–§7)
- `server/routes/admin/ccImport/search.js` — `GET /search/proposals`, `GET /search/users`, `GET /review/unmatched-payee/:id/link-preview`
- `server/routes/admin/ccImport/proposalActions.js` — `POST /api/admin/proposals/:id/reenroll-drink-plan-nudge`, `POST /api/admin/proposals/:id/reaccrue-payout`

**Client-side new components:**
- `client/src/pages/admin/CcImportWrapUpPage.js`
- `client/src/pages/admin/CcImportReviewPage.js`
- `client/src/components/admin/LegacyCcPaymentsPanel.js`

**Tests (new, paired with their modules):**
- `server/utils/payrollGuards.test.js`
- `server/utils/ccWrapUpHandler.test.js`
- `server/utils/ccWrapUpEmailTemplate.test.js`
- `server/routes/admin/ccImport/wrapUp.test.js`
- `server/routes/admin/ccImport/review.test.js`
- `server/routes/admin/ccImport/search.test.js`
- `scripts/cc-import/lib/csv.test.js`
- `scripts/cc-import/lib/buckets.test.js`
- `scripts/cc-import/lib/timeFormat.test.js`
- `scripts/cc-import/lib/fuzzyName.test.js`
- `scripts/cc-import/lib/money.test.js`
- `scripts/cc-import/phases/phase3.test.js` (integration — promotion path)
- `scripts/cc-import/phases/phase4.test.js` (integration — payment + refund path)

### Modifications

- `server/db/schema.sql` — add 6 new tables + new columns on existing (Task 1)
- `server/utils/scheduledMessageDispatcher.js` — export `checkSuppression` (Task 7)
- `server/utils/drinkPlanNudge.js` — early-return when no drink_plans row (Task 2)
- `server/utils/payrollAccrual.js` — legacy-stub guard + structured return shape (Task 3)
- `server/utils/payrollLateTip.js` — widen tip SELECT to include `target_user_id`; legacy-stub guard (Task 4)
- `server/utils/payrollClawback.js` — widen tip SELECT; legacy-stub guard (Task 5)
- `server/utils/eventCreation.js` — `createDrinkPlan` post-insert calls `scheduleDrinkPlanNudge` when a new plan was created (Task 6)
- `server/utils/rescheduleProposal.js` — `SKIP_REANCHOR_TYPES` set (Task 8)
- `server/utils/metricsQueries.js` — 8 helpers accept `f.includeCc`, JOIN to `proposals` on paid lens (Task 20)
- `server/routes/proposals/metadata.js` — thread `?include_cc=` to helpers (Task 20)
- `server/routes/admin/index.js` — mount `/cc-import` router (Task 18)
- `server/index.js` — call `registerCcWrapUpHandler()` at boot (Task 9)
- `client/src/App.js` — add `/admin/cc-import/wrap-up` + `/review` routes (Task 18/19)
- `client/src/components/adminos/MetricsFilterBar.js` — add `includeCc` segmented control (Task 20)
- `client/src/hooks/useMetricsFilter.js` — add `includeCc` to filter state (Task 20)
- `client/src/pages/admin/EventDetailPage.js` — "Schedule drink-plan nudges" button (Task 21)
- `client/src/pages/admin/ProposalDetail.js` — embed `LegacyCcPaymentsPanel` (Task 18 helper)
- `client/src/pages/admin/ClientsDashboard.js`, `ClientDetail.js`, `ProposalsDashboard.js`, `FinancialsDashboard.js`, etc. — `cc_id` badge per spec §6.7 (Task 24)
- `server/utils/drinkPlanNudge.test.js` — seed drink_plans row in setup blocks (Task 23)
- `server/utils/preEventScheduling.test.js` — seed drink_plans row in setup blocks (Task 23)
- `README.md` — folder tree, npm scripts, tech stack `csv-parse` (Task 24)
- `ARCHITECTURE.md` — schema additions, route table additions, dispatcher handler, behavior changes (Task 24)
- `package.json` — `csv-parse` dependency, `cc-import:*` npm script wrappers (Task 10)

---

## Task Decomposition

Tasks are grouped into **phases** (A–E) for orientation, but the granularity is per-task. Each task is a self-contained commit. Commit cue from the user is "looks good" / "commit" / "next task" per `.claude/CLAUDE.md` rules.

### Phase A: Foundations (Tasks 1–9)

Schema migrations, behavior changes to existing helpers, dispatcher export. Lands before the importer runs so the import doesn't blow up against unchanged code paths.

### Phase B: Importer infrastructure (Task 10)

CSV parser, bucket classifier, time format helper, money/date parsing, runLog, CLI scaffolding. The plumbing every phase depends on.

### Phase C: Import phases (Tasks 11–17)

Phases 0–6 of the importer, in dependency order.

### Phase D: Admin surfaces (Tasks 18–22)

Wrap-up page, Review page, financial dashboard filter, two follow-on operator buttons.

### Phase E: Cleanup (Tasks 23–24)

Test fixture updates and documentation.

---

## Task 1: Schema migrations (new tables + columns)

**Files:**
- Modify: `server/db/schema.sql` (append idempotent statements at end)

- [ ] **Step 1: Add `legacy_cc_raw_imports` table to `server/db/schema.sql`**

Copy spec §6.1 verbatim. CREATE TABLE IF NOT EXISTS + CHECK constraint on `import_status` + 3 indexes. `import_notes` is `JSONB`.

- [ ] **Step 2: Add `legacy_cc_proposals` table**

Copy spec §6.2 verbatim. PK on `cc_id TEXT`; FK `client_id → clients(id) ON DELETE SET NULL`; FK `raw_import_id → legacy_cc_raw_imports(id) ON DELETE RESTRICT`; 3 indexes.

- [ ] **Step 3: Add `legacy_cc_payments` table**

Copy spec §6.3 verbatim. Includes `notes TEXT`, `dismissed_at TIMESTAMPTZ`, `promoted_payment_id`, `promoted_refund_id` (with `CHECK (NOT (promoted_payment_id IS NOT NULL AND promoted_refund_id IS NOT NULL))`), `UNIQUE (raw_import_id)`, partial index on active rows (`WHERE dismissed_at IS NULL`).

- [ ] **Step 4: Add `legacy_cc_payouts` table**

Copy spec §6.4 verbatim. `payee_name_normalized TEXT NOT NULL`, FK `payee_user_id → users(id)`, FK `raw_import_id → legacy_cc_raw_imports(id) ON DELETE RESTRICT`, 3 indexes.

- [ ] **Step 5: Add `cc_import_phase0_failures` table**

Copy spec §6.5 verbatim. `attempt_count`, `last_error`, `resolved_at`, `resolved_r2_key`, `given_up_at`, `given_up_reason`, `UNIQUE (source_url, source_entity)`. Active partial index on `(attempt_count)` `WHERE resolved_at IS NULL AND given_up_at IS NULL`.

- [ ] **Step 6: Add `cc_import_runs` table**

Copy spec §10 verbatim. Includes `phase INTEGER`, `status` CHECK in `('running','succeeded','failed','partial')`, counters, `error_summary TEXT`, `notes JSONB DEFAULT '[]'`.

- [ ] **Step 7: Add `cc_id` columns + partial-unique indexes**

Copy spec §6.6 verbatim:

```sql
ALTER TABLE clients   ADD COLUMN IF NOT EXISTS cc_id TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cc_id TEXT;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS cc_id TEXT;

ALTER TABLE proposal_payments ADD COLUMN IF NOT EXISTS legacy_charge_id TEXT;
COMMENT ON COLUMN proposal_payments.legacy_charge_id IS
  'Stripe charge id (ch_...) imported from Check Cherry. NEVER use for Stripe API calls — pass to stripe.refunds.create as `charge:` not `payment_intent:`. New native rows leave this NULL.';

ALTER TABLE proposal_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
COMMENT ON COLUMN proposal_payments.payment_method IS
  'Free-form method label: card | card_external | cash | check | paypal | other | unknown. Populated by CC import; nullable on native rows.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_cc_id   ON clients(cc_id)   WHERE cc_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_cc_id ON proposals(cc_id) WHERE cc_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cc_id     ON users(cc_id)     WHERE cc_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_payments_legacy_charge_unique
  ON proposal_payments(proposal_id, legacy_charge_id)
  WHERE legacy_charge_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_payments_legacy_charge_global
  ON proposal_payments(legacy_charge_id)
  WHERE legacy_charge_id IS NOT NULL;
```

- [ ] **Step 8: Run dev server to verify migrations apply cleanly**

`server/index.js` re-applies `schema.sql` on boot. Restart dev server. Expected: no errors in startup log. Verify tables exist:

```bash
psql "$DATABASE_URL" -c "\d legacy_cc_raw_imports"
psql "$DATABASE_URL" -c "\d cc_import_phase0_failures"
psql "$DATABASE_URL" -c "\d cc_import_runs"
```

- [ ] **Step 9: Commit**

```bash
git add server/db/schema.sql
git commit -m "schema: add cc-import tables and cc_id columns"
```

---

**Task ordering note:** Task 23 (existing-tests update for `scheduleDrinkPlanNudge` behavior change) must land in the SAME commit as Task 2 (or immediately after). Splitting Task 23 to Phase E creates a window where main has failing CI. The implementer can either (a) fold Task 23's edits into Task 2's commit, or (b) commit Task 2 → immediately commit Task 23 → continue.

## Task 2: `scheduleDrinkPlanNudge` early-return when no `drink_plans` row

**Files:**
- Modify: `server/utils/drinkPlanNudge.js` (~line 201)

- [ ] **Step 1: Write the failing test**

Update `server/utils/drinkPlanNudge.test.js`. Add a new block that creates a proposal WITHOUT a drink_plans row, calls `scheduleDrinkPlanNudge(proposalId, pool)`, and asserts no `scheduled_messages` rows are inserted (`node:test` style per Global Conventions §1):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');
const { pool } = require('../db');

test('scheduleDrinkPlanNudge: no-op when no drink_plans row exists', async () => {
  const { proposalId } = await insertProposalAndClient(pool); // local helper
  await scheduleDrinkPlanNudge(proposalId, pool);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1 AND message_type LIKE 'drink_plan_nudge%'`,
    [proposalId]
  );
  assert.strictEqual(rows[0].n, 0);
});
```

- [ ] **Step 2: Run test, verify it fails**

`npm test -- drinkPlanNudge.test.js`. Expected: FAIL (nudge rows are still inserted under current behavior).

- [ ] **Step 3: Add the early-return**

In `server/utils/drinkPlanNudge.js` `scheduleDrinkPlanNudge`, after the existing `if (proposal.status === 'archived') return;` block (~line 207) and before the existing `computeScheduledFor` call:

```js
const planRes = await exec.query(
  'SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
  [proposalId]
);
if (planRes.rowCount === 0) {
  return; // No drink plan exists; nothing to nudge about.
}
```

Code comment above the block: `// CC-import: events without a drink plan never get nudged. See specs/2026-05-25-checkcherry-import-design.md §9.3.D.`

- [ ] **Step 4: Run test, verify it passes (and fix the existing failures from the behavior change)**

`npm test -- drinkPlanNudge.test.js`. Expected: PASS for the new test. **Other tests in the file WILL fail — fix them right here, in the same commit as Task 2** (per the task-ordering note above). For each failing test in `drinkPlanNudge.test.js` and `preEventScheduling.test.js`, either:
- Add `INSERT INTO drink_plans (proposal_id, token, ...) VALUES ($1, gen_random_uuid()::text, ...)` to the test's setup before the helper call, OR
- If the test ASSERTS the old behavior (nudge fires without a drink plan), rewrite the assertion to match the new behavior (nudge skips).

Run again: `npm test -- drinkPlanNudge.test.js preEventScheduling.test.js`. Expected: all PASS.

Task 23 (originally Phase E) is dissolved into Task 2 — no separate commit needed.

- [ ] **Step 5: Commit (includes the test-fixture updates from Step 4)**

```bash
git add server/utils/drinkPlanNudge.js server/utils/drinkPlanNudge.test.js server/utils/preEventScheduling.test.js
git commit -m "feat(comms): scheduleDrinkPlanNudge skips when no drink_plans row exists (+ test fixture updates)"
```

---

## Task 3: `payrollGuards` module + `accruePayoutsForProposal` guard + structured return

**Files:**
- Create: `server/utils/payrollGuards.js`
- Create: `server/utils/payrollGuards.test.js`
- Modify: `server/utils/payrollAccrual.js`

- [ ] **Step 1: Create `payrollGuards.js`**

```js
const { pool } = require('../db');

/**
 * Per-proposal: returns true when ANY participating user is a legacy CC stub.
 * Used by accruePayoutsForProposal to skip accrual on imports.
 */
async function isLegacyCcParticipant(proposalId, client = pool) {
  if (!Number.isInteger(proposalId)) return false;
  const r = await client.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN users u  ON u.id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND u.cc_id LIKE 'legacy_cc:%'
      LIMIT 1`,
    [proposalId]
  );
  return r.rowCount > 0;
}

/**
 * Per-user: returns true when this user is a legacy CC stub.
 * Used by rollForwardLateTip and clawbackTip via tips.target_user_id.
 */
async function isLegacyCcStubUser(userId, client = pool) {
  if (!Number.isInteger(userId)) return false;
  const r = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND cc_id LIKE 'legacy_cc:%' LIMIT 1`,
    [userId]
  );
  return r.rowCount > 0;
}

module.exports = { isLegacyCcParticipant, isLegacyCcStubUser };
```

- [ ] **Step 2: Write tests for both helpers**

`server/utils/payrollGuards.test.js`:

```js
const { isLegacyCcParticipant, isLegacyCcStubUser } = require('./payrollGuards');
const { pool } = require('../db');

test('isLegacyCcStubUser: true when cc_id matches legacy_cc:', async () => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('test-stub@drbartender.local', 'x', 'staff', 'legacy_cc:test:abc123')
     RETURNING id`
  );
  expect(await isLegacyCcStubUser(rows[0].id)).toBe(true);
});

test('isLegacyCcStubUser: false on real user', async () => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ('real@x.com', 'x', 'staff') RETURNING id`
  );
  expect(await isLegacyCcStubUser(rows[0].id)).toBe(false);
});

test('isLegacyCcParticipant: true when any approved shift_request points at a stub', async () => {
  // setup: create proposal + shift + stub user + approved shift_request
  // ... assert isLegacyCcParticipant returns true
});

test('isLegacyCcParticipant: false when all approved requests are real users', async () => {
  // ... assert false
});
```

Run: `npm test -- payrollGuards.test.js`. Expected: PASS (helpers are new + cleanly defined).

- [ ] **Step 3: Add guard + structured return to `accruePayoutsForProposal`**

In `server/utils/payrollAccrual.js`, find `async function accruePayoutsForProposal(proposalId)` (~line 55). After the proposal lookup at line 62:

```js
const { isLegacyCcParticipant } = require('./payrollGuards');

// At the top, after the proposal-not-found early-return:
if (await isLegacyCcParticipant(proposalId)) {
  console.log(`[payrollAccrual] proposal #${proposalId} has legacy CC stub participants; skipping accrual.`);
  return { skipped: true, reason: 'legacy_cc_stub_participant' };
}

// Replace EVERY existing bare `return;` in the function body with structured shapes:
// - ~line 62 (proposal not found / missing event_date):
if (!proposal || !proposal.event_date) {
  return { skipped: true, reason: 'proposal_missing_or_no_event_date' };
}
// - ~line 65 (status !== 'completed'):
if (proposal.status !== 'completed') {
  return { skipped: true, reason: 'not_completed', status: proposal.status };
}
// - ~line 87 (pay period not open):
if (payPeriod.status !== 'open') {
  return { skipped: true, reason: 'pay_period_not_open', pay_period_status: payPeriod.status };
}

// Counter wiring: alongside each existing `INSERT INTO payouts ...` in the body, increment
// `payoutsCreatedCount++` (declare `let payoutsCreatedCount = 0;` at function start).
// At the end of the function (after the existing body, replace the implicit undefined return):
return { skipped: false, accrued: payoutsCreatedCount };
```

All five shapes (`stub`, `proposal_missing_or_no_event_date`, `not_completed`, `pay_period_not_open`, success) become consumable by the `/reaccrue-payout` endpoint (Task 21). The auto-completion caller at `balanceScheduler.js:228` doesn't inspect the return, so widening is backwards-compatible.

- [ ] **Step 4: Verify the auto-completion path still works**

The auto-completion path at `balanceScheduler.js:228` calls `accruePayoutsForProposal(proposalId)` and doesn't inspect the return. Adding the return value is backwards-compatible. Run existing payroll tests:

```bash
npm test -- payrollAccrual.test.js
```

(`balanceScheduler.test.js` doesn't exist; only `payrollAccrual.test.js` covers this path. If you find other payroll-adjacent tests via `ls server/utils/payroll*.test.js`, run those too.) Expected: all existing tests PASS (return-value addition is additive).

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollGuards.js server/utils/payrollGuards.test.js server/utils/payrollAccrual.js
git commit -m "feat(payroll): legacy-CC-stub guard for accruePayoutsForProposal + structured return"
```

---

## Task 4: `rollForwardLateTip` legacy-stub guard

**Files:**
- Modify: `server/utils/payrollLateTip.js` (~line 19–30)

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollLateTip.test.js` (or create if missing):

```js
test('rollForwardLateTip: skips when target_user_id is a legacy CC stub', async () => {
  const stubId = await insertStubUser(pool); // helper: INSERT cc_id='legacy_cc:...'
  const tipId = await insertTip(pool, { target_user_id: stubId, shift_id: someShiftId });
  const result = await rollForwardLateTip(tipId);
  expect(result).toEqual({ skipped: true, reason: 'legacy_cc_stub_target' });
});
```

- [ ] **Step 2: Run test, verify it fails**

`npm test -- payrollLateTip.test.js`. Expected: FAIL.

- [ ] **Step 3: Widen tip SELECT to include `target_user_id` + add guard**

In `server/utils/payrollLateTip.js`, find the tip SELECT (~line 25-29). Add `target_user_id` to the column list. At the top of the function body, after the tip row is loaded:

```js
const { isLegacyCcStubUser } = require('./payrollGuards');
const Sentry = require('@sentry/node');

// After the tip lookup, before any payroll work:
if (await isLegacyCcStubUser(tipRow.target_user_id)) {
  Sentry.captureMessage('rollForwardLateTip: target is legacy_cc stub; skipping', {
    level: 'info',
    extra: { tipId, targetUserId: tipRow.target_user_id },
  });
  return { skipped: true, reason: 'legacy_cc_stub_target' };
}
```

- [ ] **Step 4: Run test, verify it passes**

`npm test -- payrollLateTip.test.js`. Expected: PASS for the new test + all existing tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollLateTip.js server/utils/payrollLateTip.test.js
git commit -m "feat(payroll): rollForwardLateTip skips when tip target is a legacy CC stub"
```

---

## Task 5: `clawbackTip` legacy-stub guard

**Files:**
- Modify: `server/utils/payrollClawback.js` (~line 18–30)

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollClawback.test.js`:

```js
test('clawbackTip: skips when target_user_id is a legacy CC stub', async () => {
  const stubId = await insertStubUser(pool);
  const tipId = await insertTip(pool, { target_user_id: stubId, shift_id: someShiftId, amount_cents: 5000 });
  const result = await clawbackTip(tipId, 2500);
  expect(result).toEqual({ skipped: true, reason: 'legacy_cc_stub_target' });
});

test('clawbackTipByPaymentIntent: inherits the skip via clawbackTip', async () => {
  const stubId = await insertStubUser(pool);
  const tipId = await insertTipWithPaymentIntent(pool, { target_user_id: stubId, payment_intent_id: 'pi_test123' });
  const result = await clawbackTipByPaymentIntent('pi_test123', 2500);
  expect(result?.skipped).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails**

`npm test -- payrollClawback.test.js`. Expected: FAIL on both.

- [ ] **Step 3: Widen tip SELECT + add guard**

In `server/utils/payrollClawback.js`, find `clawbackTip(tipId, newCumulativeRefundedCents)` (~line 18). Widen the tip SELECT at ~line 23-27 to include `target_user_id`. At the top of the function body:

```js
const { isLegacyCcStubUser } = require('./payrollGuards');
const Sentry = require('@sentry/node');

// After the tip lookup, before any clawback work:
if (await isLegacyCcStubUser(tipRow.target_user_id)) {
  Sentry.captureMessage('clawbackTip: target is legacy_cc stub; skipping', {
    level: 'info',
    extra: { tipId, targetUserId: tipRow.target_user_id },
  });
  return { skipped: true, reason: 'legacy_cc_stub_target' };
}
```

`clawbackTipByPaymentIntent` (~line 157) calls `clawbackTip` internally — inheritance is automatic.

- [ ] **Step 4: Run test, verify it passes**

`npm test -- payrollClawback.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollClawback.js server/utils/payrollClawback.test.js
git commit -m "feat(payroll): clawbackTip skips when tip target is a legacy CC stub"
```

---

## Task 6: `createDrinkPlan` post-insert nudge hook

**Files:**
- Modify: `server/utils/eventCreation.js` (`createDrinkPlan` ~line 40-72)

- [ ] **Step 1: Write the failing test**

`server/utils/eventCreation.test.js` does NOT exist — create it with the standard `node:test` scaffolding (see Global Conventions §1). Then add:

```js
test('createDrinkPlan: scheduleDrinkPlanNudge fires after a new plan is inserted', async () => {
  const { proposalId } = await insertProposalAndClient(pool, { event_date: futureDate, event_start_time: '5:00 PM' });
  await createDrinkPlan(proposalId, proposalRow);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1 AND message_type='drink_plan_nudge'`,
    [proposalId]
  );
  expect(rows[0].n).toBe(1);
});

test('createDrinkPlan: hook does NOT fire on idempotent skip (plan already exists)', async () => {
  // Insert a drink_plans row first, then call createDrinkPlan and assert no new scheduled_messages
});
```

- [ ] **Step 2: Run test, verify it fails**

`npm test -- eventCreation.test.js`. Expected: FAIL (no nudge scheduled today).

- [ ] **Step 3: Add the hook**

In `server/utils/eventCreation.js` `createDrinkPlan`, after the INSERT commits and BEFORE the function returns the new row:

```js
const Sentry = require('@sentry/node');
const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');

// At end of createDrinkPlan, BEFORE `return newPlan;`:
// Hook fires only when this call actually inserted a row (the idempotent skip path
// returns null at the top of the function — that branch doesn't reach here).
// Non-blocking: a scheduling failure must not roll back the plan.
try {
  await scheduleDrinkPlanNudge(proposalId, pool);
} catch (err) {
  Sentry.captureException(err, {
    tags: { hook: 'createDrinkPlan_reenroll', proposalId },
  });
}
```

- [ ] **Step 4: Run test, verify it passes**

`npm test -- eventCreation.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/eventCreation.js server/utils/eventCreation.test.js
git commit -m "feat(comms): createDrinkPlan auto-enrolls drink-plan nudge post-insert"
```

---

## Task 7: Export `checkSuppression` from `scheduledMessageDispatcher`

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js` (module.exports ~line 670)

- [ ] **Step 1: Write the failing test**

Append to `server/utils/scheduledMessageDispatcher.test.js`:

```js
test('checkSuppression is exported', () => {
  const dispatcher = require('./scheduledMessageDispatcher');
  expect(typeof dispatcher.checkSuppression).toBe('function');
});
```

- [ ] **Step 2: Run test, verify it fails**

Expected: FAIL (currently undefined).

- [ ] **Step 3: Widen the export**

In `server/utils/scheduledMessageDispatcher.js`, find `module.exports = { ... }` (~line 670). Add `checkSuppression`:

```js
module.exports = {
  registerHandler,
  getHandlerMeta,
  dispatchPending,
  checkSuppression,  // NEW: exposed for cc-import wrap-up preview (see specs §9.1)
  _clearHandlersForTest,
  _handlersForTest,
};
```

Do NOT export `resolveDelivery` — it's side-effectful (writes `'suppressed'` status, suspends client automation, sends admin emails). Section 9.1 preview uses `resolveChannelFallback` from `channelFallback.js` instead.

- [ ] **Step 4: Verify**

`npm test -- scheduledMessageDispatcher.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): export checkSuppression for cc-import wrap-up preview"
```

---

## Task 8: `SKIP_REANCHOR_TYPES` in `rescheduleProposal`

**Files:**
- Modify: `server/utils/rescheduleProposal.js` (top of file + `reanchorPendingMessages` ~line 111-150)

- [ ] **Step 1: Add the constant + skip-check (no test needed; this is defense-in-depth)**

At the top of `server/utils/rescheduleProposal.js`, after imports:

```js
// Defense-in-depth: even though post_event_wrap_up_email registers with
// offsetFromEventDate: null (which already short-circuits via the
// `if (!newScheduledFor) continue;` branch at line 143-146), keep an explicit
// skip set so a future handler-meta change can't silently re-anchor wrap-up rows.
const SKIP_REANCHOR_TYPES = new Set(['post_event_wrap_up_email']);
```

Inside `reanchorPendingMessages`, at the top of the per-row loop (around line 130):

```js
if (SKIP_REANCHOR_TYPES.has(row.message_type)) continue;
```

- [ ] **Step 2: Verify no test regressions**

`npm test -- rescheduleProposal.test.js`. Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add server/utils/rescheduleProposal.js
git commit -m "feat(comms): SKIP_REANCHOR_TYPES guards cc wrap-up rows"
```

---

## Task 9: Wrap-up handler + email template + boot registration

**Files:**
- Create: `server/utils/ccWrapUpEmailTemplate.js`
- Create: `server/utils/ccWrapUpHandler.js`
- Create: `server/utils/ccWrapUpHandler.test.js`
- Modify: `server/index.js` (add `require('./utils/ccWrapUpHandler').registerCcWrapUpHandler()` alongside existing handlers)

- [ ] **Step 1: Create the email template module**

`server/utils/ccWrapUpEmailTemplate.js`:

```js
const { wrapEmail } = require('./emailTemplates');

function renderCcWrapUpEmail({ client, proposal }) {
  const firstName = String(client.name || '').split(' ')[0] || client.name || 'there';
  const subject = `Thanks for celebrating with Dr. Bartender, ${firstName}`;

  const eventDate = new Date(proposal.event_date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const reviewLink = process.env.PUBLIC_GOOGLE_REVIEW_URL;
  const feedbackUrl = `${process.env.PUBLIC_SITE_URL}/feedback/${proposal.token}`;

  const reviewBlock = reviewLink
    ? `<p><a href="${reviewLink}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;text-decoration:none;border-radius:4px;">Leave a Google review</a></p>`
    : '';

  const html = wrapEmail(`
    <p>Hi ${firstName},</p>
    <p>Thank you for celebrating with us on ${eventDate}. We hope you had a great time!</p>
    ${reviewBlock}
    <p>We'd love your feedback — <a href="${feedbackUrl}">tell us how we did</a>.</p>
    <p>— Dr. Bartender</p>
  `);

  const text = [
    `Hi ${firstName},`,
    ``,
    `Thank you for celebrating with us on ${eventDate}.`,
    reviewLink ? `\nLeave a Google review: ${reviewLink}` : '',
    `\nWe'd love your feedback: ${feedbackUrl}`,
    `\n— Dr. Bartender`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

module.exports = { renderCcWrapUpEmail };
```

- [ ] **Step 2: Create handler module + registration function**

`server/utils/ccWrapUpHandler.js`:

```js
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendEmail } = require('./email');
const { renderCcWrapUpEmail } = require('./ccWrapUpEmailTemplate');

async function wrapUpHandler({ entity: proposal, recipient: client }) {
  const { subject, html, text } = renderCcWrapUpEmail({ client, proposal });
  await sendEmail({
    to: client.email,
    subject,
    html,
    text,
    from: 'Dr. Bartender <no-reply@drbartender.com>',
    replyTo: process.env.ADMIN_EMAIL,
  });
}

function registerCcWrapUpHandler() {
  registerHandler('post_event_wrap_up_email', wrapUpHandler, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
    cooldownExempt: true,
    multiChannel: false,
  });
}

module.exports = { registerCcWrapUpHandler, wrapUpHandler };
```

- [ ] **Step 3: Write a unit test for the template**

`server/utils/ccWrapUpHandler.test.js`:

```js
const { renderCcWrapUpEmail } = require('./ccWrapUpEmailTemplate');

test('renderCcWrapUpEmail: builds subject with first name', () => {
  const out = renderCcWrapUpEmail({
    client: { name: 'Meg Henke', email: 'meg@x.com' },
    proposal: { event_date: '2026-05-15', token: 'abc' },
  });
  expect(out.subject).toBe('Thanks for celebrating with Dr. Bartender, Meg');
});

test('renderCcWrapUpEmail: feedback URL is path-segment shape', () => {
  process.env.PUBLIC_SITE_URL = 'https://drbartender.com';
  const out = renderCcWrapUpEmail({
    client: { name: 'X' },
    proposal: { event_date: '2026-05-15', token: 'tok123' },
  });
  expect(out.html).toContain('https://drbartender.com/feedback/tok123');
  expect(out.text).toContain('https://drbartender.com/feedback/tok123');
});

test('renderCcWrapUpEmail: omits Google review button when PUBLIC_GOOGLE_REVIEW_URL unset', () => {
  delete process.env.PUBLIC_GOOGLE_REVIEW_URL;
  const out = renderCcWrapUpEmail({
    client: { name: 'X' },
    proposal: { event_date: '2026-05-15', token: 'tok' },
  });
  expect(out.html).not.toContain('Leave a Google review');
});
```

- [ ] **Step 4: Register at boot**

In `server/index.js`, find the existing handler registrations (~line 327-338):

```js
require('./utils/preEventHandlers').registerAll();
require('./utils/marketingHandlers').registerMarketingHandlers();
require('./utils/dripSmsHandlers').registerDripSmsHandlers();
require('./utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers();
require('./utils/balanceSmsHandlers').registerBalanceSmsHandlers();
require('./utils/eventEveSms').registerEventEveHandler();
require('./utils/staffShiftHandlers').registerStaffShiftHandlers();
```

Add:

```js
require('./utils/ccWrapUpHandler').registerCcWrapUpHandler();
```

- [ ] **Step 5: Verify boot + tests**

Restart dev server, check log for no errors. Run `npm test -- ccWrapUpHandler.test.js`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/utils/ccWrapUpHandler.js server/utils/ccWrapUpEmailTemplate.js server/utils/ccWrapUpHandler.test.js server/index.js
git commit -m "feat(comms): post_event_wrap_up_email handler + email template + boot registration"
```

---

## Task 10: Importer foundation — `csv-parse` dependency, lib helpers, CLI scaffolding

**Files:**
- Modify: `package.json` (add `csv-parse` dependency + `cc-import:*` scripts)
- Create: `scripts/cc-import.js` (entry)
- Create: `scripts/cc-import/lib/csv.js`
- Create: `scripts/cc-import/lib/buckets.js`
- Create: `scripts/cc-import/lib/timeFormat.js`
- Create: `scripts/cc-import/lib/money.js`
- Create: `scripts/cc-import/lib/dateFmt.js`
- Create: `scripts/cc-import/lib/db.js`
- Create: `scripts/cc-import/lib/runLog.js`
- Create: `scripts/cc-import/lib/cli.js`
- Create: tests for each `lib/*.js` file

- [ ] **Step 1: Add `csv-parse` dependency**

```bash
npm install csv-parse
```

Verify `package.json` includes the dep. Add npm script wrappers:

```json
"scripts": {
  ...,
  "cc-import": "node scripts/cc-import.js",
  "cc-import:phase0": "node scripts/cc-import.js --phase=0",
  "cc-import:phase1": "node scripts/cc-import.js --phase=1",
  "cc-import:phase2": "node scripts/cc-import.js --phase=2",
  "cc-import:phase3": "node scripts/cc-import.js --phase=3",
  "cc-import:phase4": "node scripts/cc-import.js --phase=4",
  "cc-import:phase5": "node scripts/cc-import.js --phase=5",
  "cc-import:phase6": "node scripts/cc-import.js --phase=6",
  "cc-import:all": "node scripts/cc-import.js --all"
}
```

- [ ] **Step 2: Create `scripts/cc-import/lib/csv.js` + test**

```js
// scripts/cc-import/lib/csv.js
const fs = require('fs');
const { parse } = require('csv-parse/sync');

function loadCsv(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return parse(text, { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
}

module.exports = { loadCsv };
```

Test (`scripts/cc-import/lib/csv.test.js`):

```js
const { loadCsv } = require('./csv');
test('loadCsv parses headers as object keys', () => {
  // Use a fixture CSV in scripts/cc-import/lib/__fixtures__/tiny.csv
});
```

- [ ] **Step 3: Create `scripts/cc-import/lib/timeFormat.js` + test**

Spec §8.3 calls for ~15-line helper. Parse `H:MM AM/PM` → minutes since midnight, add hours, format back:

```js
function parseAmPmToMinutes(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s).trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]); const period = m[3].toUpperCase();
  if (h === 12) h = 0;
  if (period === 'PM') h += 12;
  return h * 60 + min;
}

function minutesToAmPm(totalMinutes) {
  const t = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60); const min = t % 60;
  const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(min).padStart(2, '0')} ${ampm}`;
}

function addHours(timeAmPm, hours) {
  const start = parseAmPmToMinutes(timeAmPm);
  if (start == null) return null;
  return minutesToAmPm(start + Math.round(hours * 60));
}

module.exports = { parseAmPmToMinutes, minutesToAmPm, addHours };
```

Test (`scripts/cc-import/lib/timeFormat.test.js`):

```js
const { parseAmPmToMinutes, minutesToAmPm, addHours } = require('./timeFormat');

test('parseAmPmToMinutes: 5:00 PM → 17*60', () => expect(parseAmPmToMinutes('5:00 PM')).toBe(1020));
test('parseAmPmToMinutes: 12:00 AM → 0', () => expect(parseAmPmToMinutes('12:00 AM')).toBe(0));
test('parseAmPmToMinutes: 12:30 PM → 750', () => expect(parseAmPmToMinutes('12:30 PM')).toBe(750));
test('addHours: 5:00 PM + 4 = 9:00 PM', () => expect(addHours('5:00 PM', 4)).toBe('9:00 PM'));
test('addHours: 11:00 PM + 2 = 1:00 AM', () => expect(addHours('11:00 PM', 2)).toBe('1:00 AM'));
test('addHours: handles fractional hours (4.5)', () => expect(addHours('5:00 PM', 4.5)).toBe('9:30 PM'));
test('addHours: returns null on unparseable input', () => expect(addHours('garbage', 1)).toBe(null));
```

- [ ] **Step 4: Create `scripts/cc-import/lib/buckets.js` + test**

```js
const SKIP_PACKAGES = new Set([
  'Inventory',
  'MGM Events',
  'Bartending Services',
  'Victory Gardens Theater Final Reconciliation',
  'Theatrical Show Run',
]);

const SKIP_PATTERNS = [/MGM/i];

function isSkippedPackage(name) {
  if (!name) return false;
  if (SKIP_PACKAGES.has(name)) return true;
  return SKIP_PATTERNS.some(re => re.test(name));
}

function classify({ status, eventDate, packageName }, today) {
  if (status === 'Confirmed' && isSkippedPackage(packageName)) return 'D';
  if (status !== 'Confirmed') return 'C';
  if (!eventDate) return 'C';
  return eventDate >= today ? 'A' : 'B';
}

module.exports = { SKIP_PACKAGES, SKIP_PATTERNS, isSkippedPackage, classify };
```

Test asserts each branch (A future-confirmed, B past-confirmed, C non-confirmed, D skipped). Run `npm test -- buckets.test.js`.

- [ ] **Step 5: Create `scripts/cc-import/lib/money.js` + test**

```js
function parseMoneyCents(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/\$/g, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const isNeg = cleaned.startsWith('-') || (cleaned.startsWith('(') && cleaned.endsWith(')'));
  const num = Number(cleaned.replace(/[()\-]/g, ''));
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) * (isNeg ? -1 : 1);
}
module.exports = { parseMoneyCents };
```

Test: `'$2,650'` → 265000, `'$-300'` → -30000, `''` → null, `'(50.00)'` → -5000.

- [ ] **Step 6: Create `scripts/cc-import/lib/dateFmt.js` + test**

```js
function parseCcDate(s) {
  if (!s) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
}
module.exports = { parseCcDate };
```

Test: `'05-24-2026'` → Date(2026, 4, 24); `'invalid'` → null.

- [ ] **Step 7: Create `scripts/cc-import/lib/db.js`**

```js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
module.exports = { pool };
```

- [ ] **Step 8: Create `scripts/cc-import/lib/runLog.js`**

```js
const { pool } = require('./db');

async function startRun(phase) {
  const { rows } = await pool.query(
    `INSERT INTO cc_import_runs (phase, status) VALUES ($1, 'running') RETURNING id`,
    [phase]
  );
  return rows[0].id;
}

async function finishRun(runId, { status, rowsProcessed, rowsInserted, rowsSkipped, rowsErrored, errorSummary, notes }) {
  await pool.query(
    `UPDATE cc_import_runs
        SET finished_at = NOW(), status = $1,
            rows_processed = $2, rows_inserted = $3, rows_skipped = $4, rows_errored = $5,
            error_summary = $6, notes = $7
      WHERE id = $8`,
    [status, rowsProcessed, rowsInserted, rowsSkipped, rowsErrored, errorSummary || null, JSON.stringify(notes || []), runId]
  );
}

module.exports = { startRun, finishRun };
```

- [ ] **Step 9: Create `scripts/cc-import/lib/cli.js` + entry script**

`cli.js`:

```js
const path = require('path');

function parseArgs(argv) {
  const out = { phase: null, all: false, retryFromDb: false };
  for (const a of argv) {
    if (a.startsWith('--phase=')) out.phase = Number(a.slice('--phase='.length));
    if (a === '--all') out.all = true;
    if (a === '--retry-from-db') out.retryFromDb = true;
  }
  return out;
}

// CC_DIR env var documents the directory holding the canonical CC CSVs. Default to
// the operator's known download location; override via env for CI / other machines.
const CC_DIR = process.env.CC_DIR || 'C:\\Users\\dalla\\Downloads';

module.exports = { parseArgs, CC_DIR };
```

`scripts/cc-import.js` (entry):

```js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { parseArgs, CC_DIR } = require('./cc-import/lib/cli');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Using CC_DIR = ${CC_DIR}`);
  if (!fs.existsSync(CC_DIR)) {
    console.error(`CC_DIR does not exist: ${CC_DIR}. Set process.env.CC_DIR before running.`);
    process.exit(2);
  }
  const phases = args.all ? [0,1,2,3,4,5,6] : (args.phase != null ? [args.phase] : []);
  if (phases.length === 0) {
    console.error('Usage: node scripts/cc-import.js --phase=N | --all');
    process.exit(2);
  }
  for (const p of phases) {
    // Phase modules are created in Tasks 11-17; until then, this entry crashes with
    // 'Cannot find module' — intentionally non-functional until the phases ship.
    const phaseMod = require(`./cc-import/phases/phase${p}`);
    console.log(`\n=== Phase ${p} starting ===`);
    await phaseMod.run({ ...args, ccDir: CC_DIR });
    console.log(`=== Phase ${p} complete ===`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 10: Commit**

```bash
git add package.json scripts/cc-import.js scripts/cc-import/lib/ scripts/cc-import/lib/*.test.js
git commit -m "feat(cc-import): foundation libs (csv, time, money, dates, buckets, runlog, cli)"
```

---

## Task 11: Phase 0 — file downloads + persistence

**Files:**
- Create: `scripts/cc-import/phases/phase0.js`
- Create: `scripts/cc-import/phases/phase0.test.js`
- Create: `scripts/cc-import/lib/r2.js` (R2 upload wrapper around existing `server/utils/r2.js`)
- Create: `scripts/cc-import/lib/httpFetch.js` (size cap + SSRF block + content-type check)

- [ ] **Step 1: Create `lib/httpFetch.js` with safety rails**

Implement a `fetchToBuffer(url)` that:
1. DNS-resolves the hostname; refuse if in `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, IPv6 link-local.
2. HEAD-check Content-Length; refuse > 50 MB.
3. Validate Content-Type in `image/*`, `application/pdf`, `video/*`.
4. Stream-abort past 50 MB if Content-Length was missing.
5. Return `{ buffer, contentType, originalUrl }`.

(~80 lines; uses `node:dns`, `node:net`, `node:https`.)

- [ ] **Step 2: Create `lib/r2.js` (thin wrapper)**

Re-export R2 upload from existing `server/utils/r2.js`. Single function: `uploadToR2(key, buffer, contentType) → r2Key`.

- [ ] **Step 3: Implement `phase0.js`**

Walks the three Wix CSVs + `report (14).csv`. For each URL:
1. Check `cc_import_phase0_failures WHERE source_url = $1 AND (resolved_at IS NOT NULL OR given_up_at IS NOT NULL)`. If hit, skip.
2. Attempt fetch via `fetchToBuffer`. On 3 failures with exponential backoff (1s, 4s, 16s), UPSERT into `cc_import_phase0_failures` with incremented `attempt_count`.
3. On success: upload to R2, set `resolved_at`, `resolved_r2_key`. Rewrite URL inside `legacy_cc_raw_imports.payload`.

Exports `run({ retryFromDb })` for the CLI.

- [ ] **Step 4: Integration test (mocked httpFetch)**

`phase0.test.js`: mock `fetchToBuffer` and `uploadToR2`; assert failure persistence + retry behavior. Run: `npm test -- phase0.test.js`.

- [ ] **Step 5: Manual dev verification**

Local: `node scripts/cc-import.js --phase=0` against a small test fixture CSV. Verify `cc_import_phase0_failures` populates correctly on simulated failure.

- [ ] **Step 6: Commit**

```bash
git add scripts/cc-import/lib/httpFetch.js scripts/cc-import/lib/r2.js scripts/cc-import/phases/phase0.js scripts/cc-import/phases/phase0.test.js
git commit -m "feat(cc-import): Phase 0 file downloads with safety rails + persistent retry queue"
```

---

## Task 12: Phase 1 — staff users (Wix + payouts cascade)

**Files:**
- Create: `scripts/cc-import/phases/phase1.js`
- Create: `scripts/cc-import/lib/fuzzyName.js` + test

- [ ] **Step 1: Create `lib/fuzzyName.js` — Pass 1→2→3 cascade**

```js
function normalize(name) {
  return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function commaFlip(name) {
  const m = /^(.+?),\s*(.+)$/.exec(String(name || ''));
  if (!m) return null;
  return `${m[2].trim()} ${m[1].trim()}`;
}

async function findByName(pool, payeeName) {
  const norm = normalize(payeeName);
  if (!norm) return [];
  // Pass 1: exact normalized preferred_name
  let r = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE LOWER(TRIM(regexp_replace(cp.preferred_name, '[[:space:]]+', ' ', 'g'))) = $1`,
    [norm]
  );
  if (r.rowCount > 0) return r.rows.map(x => x.id);

  // Pass 2: comma-flipped retry
  const flipped = commaFlip(payeeName);
  if (flipped) {
    r = await pool.query(
      `SELECT u.id FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE LOWER(TRIM(regexp_replace(cp.preferred_name, '[[:space:]]+', ' ', 'g'))) = $1`,
      [normalize(flipped)]
    );
    if (r.rowCount > 0) return r.rows.map(x => x.id);
  }

  // Pass 3: last-name + first-initial
  const parts = norm.split(' ');
  if (parts.length >= 2) {
    const first = parts[0]; const last = parts[parts.length - 1];
    r = await pool.query(
      `SELECT u.id FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE LOWER(TRIM(cp.preferred_name)) LIKE $1`,
      [`${first[0]}% ${last}%`]
    );
    if (r.rowCount > 0) return r.rows.map(x => x.id);
  }

  return [];
}

function buildStubCcId(payeeName, earliestPaidOnIso) {
  const crypto = require('crypto');
  const slug = String(payeeName).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash6 = crypto.createHash('sha256').update(`${payeeName}|${earliestPaidOnIso}`).digest('hex').slice(0, 6);
  return { slug, hash6, ccId: `legacy_cc:${slug}:${hash6}`, email: `legacy-cc-${slug}-${hash6}@drbartender.local` };
}

module.exports = { normalize, commaFlip, findByName, buildStubCcId };
```

Test asserts Pass 1, Pass 2 (`"Smith, Mike"` → match `"Mike Smith"`), Pass 3 (`"Mike Smith"` → match `"Michael S."`).

- [ ] **Step 2: Implement `phase1.js`**

Algorithm (mirrors spec §8.1):

1. **Encryption preflight:** `const probe = encrypt('cc-import-preflight'); if (!probe.startsWith('enc:')) throw new Error('ENCRYPTION_KEY missing — refuse to write bank PII as plaintext');`
2. **Functional-index preflight:** `await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))');`
3. Load 3 Wix CSVs into `legacy_cc_raw_imports`.
4. For each unique email across the Wix CSVs, open a per-user transaction:
   - Pre-check `SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER($1)`; if > 1, ROLLBACK + `import_status = 'errored'` with `user_email_case_collision`.
   - UPSERT (spec §8.1 step 4 SQL, with the role/status WHERE; the stub-promotion carve-out in the WHERE is defense-in-depth — it cannot actually fire from the Wix UPSERT path because the Wix CSV email never matches a stub's `.local` email; do NOT add any follow-up `UPDATE users SET cc_id = NULL` — the stub stays in place per spec §8.1, and stub-to-real promotion runs through the Section 9.3.E manual link flow instead).
   - If RETURNING is empty (UPSERT blocked by WHERE: existing user is `'rejected'`/`'deactivated'` non-stub OR `role != 'staff'`), ROLLBACK + `import_status = 'errored'` with `user_email_conflict_with_protected_state`.
   - Upsert `contractor_profiles` with **Payment-Info-wins precedence on overlapping fields** (`preferred_method`, `W9 URL`): apply Contractor Profile fields first, then overwrite with Payment Info fields where present. Skip the entire upsert when the existing `contractor_profiles` row predates the import AND `inserted === false` (preserve operator edits to `preferred_name`).
   - Upsert `agreements` (Field Guide Ack only).
   - Upsert `payment_profiles` with `routing_number = encrypt(raw_routing)`, `account_number = encrypt(raw_account)`. Bank fields encrypted only after the Phase 1 encryption preflight passes (see Step 2 below).
   - COMMIT.
5. Scan payouts CSV. For each distinct normalized payee with no Wix match, `findByName`; on all-miss, `INSERT INTO users` with stub fields per §7.3 — including `password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)` (a real bcrypt hash; not a placeholder string) — plus `INSERT INTO contractor_profiles` with `preferred_name = <payeeName>`.
6. Auto-derive `can_staff` per spec §7.3 (UPDATE users SET can_staff = true WHERE EXISTS ... `Reference IN ('Bartender','Server','Barback')` AND NOT all-reimbursement-rows).

- [ ] **Step 3: Manual dev verification (against a small Wix CSV fixture)**

Run `node scripts/cc-import.js --phase=1` against a fixture with 2-3 Wix rows + 5 payouts (some matching, some not). Verify:
- Users created.
- `legacy_cc_payouts` rows have `payee_user_id` set where match found.
- Unmatched payees create stubs with proper `legacy_cc:` prefix.

- [ ] **Step 4: Commit**

```bash
git add scripts/cc-import/lib/fuzzyName.js scripts/cc-import/lib/fuzzyName.test.js scripts/cc-import/phases/phase1.js
git commit -m "feat(cc-import): Phase 1 staff users (Wix UPSERT + payouts fuzzy cascade + stubs)"
```

---

## Task 13: Phase 2 — clients dedup

**Files:**
- Create: `scripts/cc-import/phases/phase2.js`

- [ ] **Step 1: Implement `phase2.js`**

Algorithm (mirrors spec §7.1):

1. Load `report (9).csv` rows into `legacy_cc_raw_imports` (one INSERT batch).
2. For each row, per-row SAVEPOINT:
   - Normalize email per §7.1 step 1 (empty/`n/a`/`none`/`noemail@`-pattern → placeholder `cc-import-noemail-<cc_id>@drbartender.local` + `email_status = 'bad'`).
   - Case-collision pre-check: `SELECT id, email FROM clients WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`. If > 1 row, ROLLBACK SAVEPOINT + `import_status = 'errored'` with `client_email_case_collision`.
   - On clean hit: `UPDATE clients SET cc_id = $1 WHERE id = $2 AND cc_id IS NULL` + canonicalizing `UPDATE clients SET email = LOWER(TRIM(email)) WHERE id = $2 AND email <> LOWER(TRIM(email))`. On canonicalizing UPDATE error (race), ROLLBACK SAVEPOINT + errored.
   - No hit: INSERT new `clients` row with `name` (CC `First Name + ' ' + Last Name`), lowercased email, phone, `source = 'direct'`, `cc_id`.
3. After loop, log to `cc_import_runs.notes` the count of inserted vs deduped vs errored.

- [ ] **Step 2: Manual dev verification**

Run `node scripts/cc-import.js --phase=2` against the full `report (9).csv`. Expected: 1,215 raw_imports rows; <= 1,215 `clients` rows (some will be dedups). Spot-check a few `cc_id` values:

```bash
psql "$DATABASE_URL" -c "SELECT cc_id, name, email FROM clients WHERE cc_id IS NOT NULL LIMIT 5;"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/cc-import/phases/phase2.js
git commit -m "feat(cc-import): Phase 2 clients dedup + cc_id annotation"
```

---

## Task 14: Phase 3 — proposals + native promotion (Buckets A/B + archive C + skip D)

**Files:**
- Create: `scripts/cc-import/phases/phase3.js`
- Create: `scripts/cc-import/phases/phase3.test.js`

Largest task. Direct INSERTs for `proposals` and `shifts` (no `createEventShifts` reuse per spec §8.3).

- [ ] **Step 1: Load + classify rows**

In `phase3.js`:

```js
async function run(args) {
  const runId = await startRun(3);
  const rows = loadCsv(path.join(CC_DIR, 'report (10).csv'));
  const today = new Date(); today.setUTCHours(0,0,0,0);

  // Build client_cc_id_to_local_id map at phase start
  const cidMap = new Map(
    (await pool.query(`SELECT cc_id, id FROM clients WHERE cc_id IS NOT NULL`)).rows.map(r => [r.cc_id, r.id])
  );
  // ... process each row
}
```

- [ ] **Step 2: Bucket D handling**

For each row where `classify(...) === 'D'`:
- INSERT into `legacy_cc_raw_imports` with `import_status = 'skipped'` and `import_notes = {"reason":"package_in_skip_list","package_name":<name>}`.

- [ ] **Step 3: Bucket C handling**

For each row where `classify(...) === 'C'`:
- INSERT into `legacy_cc_raw_imports` (`import_status = 'pending'`).
- INSERT into `legacy_cc_proposals` with the parsed fields (spec §6.2 columns).
- UPDATE raw_imports row with `import_status = 'archived'`.

- [ ] **Step 4: Bucket A/B dedup check (Bucket A only)**

For Bucket A rows, after client-dedup, query for candidate native proposals:

```sql
SELECT id, updated_at FROM proposals
 WHERE client_id = $1
   AND cc_id IS NULL
   AND event_date BETWEEN $2::date - INTERVAL '14 days' AND $2::date + INTERVAL '14 days'
```

If hit, set `import_status = 'duplicate_review'` with `import_notes = {"candidate_proposal_id":<id>, "match_reason":"client_id+date_within_14d"}`. Skip promotion.

- [ ] **Step 5: Bucket A/B native promotion (proposals INSERT)**

Direct INSERT into `proposals`, full column list per spec §8.3:

```js
const { rows: [proposal] } = await client.query(
  `INSERT INTO proposals
     (client_id, cc_id, event_date, event_start_time, event_duration_hours, guest_count,
      event_type, event_type_custom, event_type_category,
      total_price, amount_paid, payment_type, status, autopay_enrolled, balance_due_date, last_minute_hold,
      venue_name, venue_street, venue_city, venue_state, venue_zip,
      admin_notes, pricing_snapshot,
      created_by, created_at, sent_at, accepted_at)
   VALUES ($1, $2, $3, $4, $5, $6,
           NULL, NULL, NULL,
           $7, 0.00, 'deposit', $8, false, $9, false,
           $10, $11, $12, $13, $14,
           $15, $16,
           $17, $18, $19, $19)
   ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO NOTHING
   RETURNING id`,
  [
    clientLocalId, ccId, eventDate, eventStartTime, durationHours, guestCount,
    totalPriceDollars, bucketStatus, balanceDueDate,
    venueName, venueStreet, venueCity, venueState, venueZip,
    adminNotes, JSON.stringify(pricingSnapshot),
    createdByUserId, bookedAt, bookedAt
  ]
);
```

Where:
- `bucketStatus = 'confirmed'` for Bucket A, `'completed'` for Bucket B.
- `balanceDueDate` = `GREATEST(event_date - INTERVAL '14 days', CURRENT_DATE)` for A, `NULL` for B.
- `pricingSnapshot` = `{ package: { name, amount_cents }, gratuity_cents: 0, line_items: [...], breakdown: [], _cc_imported: true, _cc_id: ccId }`.
- `createdByUserId` = `(SELECT id FROM users WHERE email = $ADMIN_EMAIL LIMIT 1)` or null.

- [ ] **Step 6: `proposal_activity_log` entries**

```js
await client.query(
  `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
   VALUES ($1, 'cc_import_promoted', 'system', $2)`,
  [proposal.id, JSON.stringify({ bucket: bucketLetter, cc_id: ccId })]
);
if (publicNotes) {
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'cc_import_public_note', 'system', $2)`,
    [proposal.id, JSON.stringify({ public_notes: publicNotes })]
  );
}
```

- [ ] **Step 7: Shifts INSERT (direct, per spec §8.3 table)**

```js
const { parseAmPmToMinutes, addHours } = require('../lib/timeFormat');
const startTime = eventStartTime; // already H:MM AM/PM
const endTime = addHours(startTime, durationHours);
const numBartenders = bucketLetter === 'A'
  ? Math.max(1, (String(assignedStaff).split(',').filter(Boolean).length))
  : 1;
const positionsNeeded = JSON.stringify(Array(numBartenders).fill('Bartender'));

const { rows: [shift] } = await client.query(
  `INSERT INTO shifts
     (proposal_id, event_type, event_type_custom, client_name, event_date,
      start_time, end_time, location, setup_minutes_before, positions_needed, notes, status, created_by)
   VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, 60, $7, $8, $9, $10)
   RETURNING id`,
  [
    proposal.id, clientFullName, eventDate, startTime, endTime,
    composeVenueLocation({ venue_name: venueName, venue_street: venueStreet, ... }),
    positionsNeeded, `Imported from Check Cherry (cc_id=${ccId})`,
    bucketLetter === 'A' ? 'open' : 'completed', createdByUserId
  ]
);
```

- [ ] **Step 8: `shift_requests` per assigned staff**

For each name in CC `Assigned Staff` (comma-split):
- `findByName(pool, name)` via `fuzzyName.js`.
- On match (single id): `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender') ON CONFLICT (shift_id, user_id) DO NOTHING`. **`position = 'Bartender'` is load-bearing** — `payrollAccrual.js:113` filters `(w.position || '').toLowerCase() === 'bartender'`; omitting it makes accrual see zero bartenders and silently skip all gratuity allocation for the event.
- On miss: append name to `cc_import_runs.notes` array as `{ proposal_id, shift_id, unmatched_name }`.

- [ ] **Step 9: Auto-comms enrollment for Bucket A (collected during loop, fired AFTER outer COMMIT)**

Spec §8.3 mandates auto-comms enrollment runs AFTER the proposal+shift inserts COMMIT — because `scheduleDepositPaidReminders` writes to `scheduled_messages` on its own pool connection. Calling it inside the outer BEGIN/COMMIT loop would write reminder rows whose ON CONFLICT logic references proposals not yet visible to other connections.

Structure: the `promoteBucketA(payload, opts)` helper (Step 12) does ONLY the proposal+shift+activity-log+shift_request inserts inside the per-row SAVEPOINT. It collects the new `proposal.id` and returns it. The outer `run()` loop appends each successful Bucket A proposal id to a `bucketAPromotedIds = []` array DURING the loop, then AFTER the outer COMMIT runs the enrollment loop on its own connection:

```js
// After the outer COMMIT of the SAVEPOINT loop completes:
for (const proposalId of bucketAPromotedIds) {
  try {
    const { scheduleDepositPaidReminders } = require('../../../server/utils/depositPaidSchedulers');
    const { onProposalSignedAndPaid } = require('../../../server/utils/marketingHandlers');
    await scheduleDepositPaidReminders(proposalId, { source: 'cc_import' });
    await onProposalSignedAndPaid(proposalId);
  } catch (err) {
    Sentry.captureException(err, { tags: { phase: 'cc_import_phase3', step: 'auto_comms_enroll', proposalId }});
    // Continue with the next proposal; the inserts already landed.
  }
}
```

`promoteBucketA` (Step 12 export) does NOT call these schedulers internally — the caller (run() or the Task 19 promote-anyway endpoint) is responsible for enrollment after its own commit.

- [ ] **Step 10: Integration test (small fixture)**

`phase3.test.js`: build a 4-row CSV fixture (one each of A, B, C, D). Run phase 3 against a test DB. Assert:
- 1 row in `proposals` with `status='confirmed'` and `cc_id` set (Bucket A).
- 1 row in `proposals` with `status='completed'` (Bucket B).
- 1 row in `legacy_cc_proposals` (Bucket C).
- 1 raw_imports row with `import_status='skipped'` (Bucket D).
- `shift_requests` rows created via `findByName` lookup.

- [ ] **Step 11: Manual dev verification (full CSV)**

Run `node scripts/cc-import.js --phase=3` against `report (10).csv`. Expected outcome (per spec §5 counts):
- Bucket A: 27 promoted.
- Bucket B: 168 promoted.
- Bucket C: 1,219 archived.
- Bucket D: 14 skipped.

```bash
psql "$DATABASE_URL" -c "SELECT status, COUNT(*) FROM proposals WHERE cc_id IS NOT NULL GROUP BY status;"
```

- [ ] **Step 12: Export `promoteBucketA(payload, options)` and `promoteBucketB(payload, options)` as named exports**

Task 19's `/duplicate/:row_id/promote` endpoint re-invokes the Bucket A promotion path for a single row with `{ skipDedup: true }`. Refactor Phase 3's body so the per-row Bucket A insert logic (proposal + shift + shift_requests + auto-comms enrollment) lives in `promoteBucketA(payload, { skipDedup, sourceRunId })` and Bucket B in `promoteBucketB(payload, { sourceRunId })`. Both exported from `phase3.js`. The `run()` function iterates rows and calls these helpers per-row inside a per-row SAVEPOINT (per spec §11). Without these exports, Task 19 has nothing to call.

- [ ] **Step 13: Add per-row SAVEPOINT wrapping inside `run()`**

Spec §11 mandates per-row SAVEPOINTs. Concretely:

```js
const runClient = await pool.connect();
await runClient.query('BEGIN');
for (const row of csvRows) {
  await runClient.query('SAVEPOINT row_sp');
  try {
    // classify + dispatch to promoteBucketA / promoteBucketB / archive / skip
    await runClient.query('RELEASE SAVEPOINT row_sp');
    rowsInserted++;
  } catch (err) {
    await runClient.query('ROLLBACK TO SAVEPOINT row_sp');
    erroredSamples.push({ source_row_number: row.__rowNum, error: err.message });
    await markErrored(runClient, row.__rawImportId, err);
    rowsErrored++;
  }
}
await runClient.query('COMMIT');
runClient.release();
// Per-phase Sentry summary (Global Conventions §7):
Sentry.captureMessage(`cc-import phase 3 summary`, { level: rowsErrored > 0 ? 'warning' : 'info', extra: { phase: 3, rowsProcessed, rowsInserted, rowsErrored, samples: erroredSamples.slice(0, 5) }});
```

- [ ] **Step 14: Commit**

```bash
git add scripts/cc-import/phases/phase3.js scripts/cc-import/phases/phase3.test.js
git commit -m "feat(cc-import): Phase 3 proposals + shifts native promotion (Buckets A/B) + archive C + skip D + per-row SAVEPOINTs + promoteBucketA export"
```

---

## Task 15: Phase 4 — payments + refunds (with row lock + status demote + manual-recon skip)

**Files:**
- Create: `scripts/cc-import/phases/phase4.js`
- Create: `scripts/cc-import/phases/phase4.test.js`

Most complex per-row logic. Full spec §8.4 reference.

- [ ] **Step 1: Load + insert raw + legacy_cc_payments**

Load `report (11).csv`. For each row: INSERT into `legacy_cc_raw_imports`, then `legacy_cc_payments` with `cc_type = Payment|Refund`, `payment_applied_cents = parseMoneyCents(...)`, etc.

- [ ] **Step 2: Resolve `cc_event_id` per row**

For each `legacy_cc_payments` row WHERE `cc_event_id IS NULL AND dismissed_at IS NULL`, run the matcher query (spec §8.4 step 2 SQL with the explicit JOIN to clients). On unambiguous match (single row or deterministic tiebreak), set `cc_event_id = (SELECT cc_id FROM proposals WHERE id = $matched)`. On still-ambiguous, leave NULL.

- [ ] **Step 3: Process `Payment` rows**

For each `Payment` row that resolved a `cc_event_id`:
- SELECT-then-skip: `SELECT 1 FROM legacy_cc_payments WHERE id = $1 AND promoted_payment_id IS NOT NULL`. If hit, skip.
- Compute `payment_type` via per-event chronological sequence (load all payments for this proposal ordered by `paid_on ASC`, classify each).
- Map `payment_method` per the table in spec §8.4.
- INSERT into `proposal_payments` with the full column list (spec §8.4 step 4):
  - `legacy_charge_id = reference_code` when starts with `ch_`.
  - `created_at = '<paid_on>T12:00:00Z'`.
  - `ON CONFLICT (proposal_id, legacy_charge_id) WHERE legacy_charge_id IS NOT NULL DO NOTHING`.
- UPDATE `legacy_cc_payments.promoted_payment_id`.

- [ ] **Step 4: Process `Refund` rows (full Approach A mirror)**

For each `Refund` row that resolved a `cc_event_id`, use `pool.connect()` pattern:

```js
const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Idempotency: already promoted?
  const already = await client.query(
    `SELECT 1 FROM legacy_cc_payments WHERE id = $1 AND promoted_refund_id IS NOT NULL`,
    [legacyPaymentId]
  );
  if (already.rowCount > 0) { await client.query('ROLLBACK'); continue; }

  // Manual-reconciliation skip
  const manual = await client.query(
    `SELECT id FROM proposal_refunds
      WHERE proposal_id = $1 AND reason LIKE 'Manual Stripe reconciliation%'
        AND amount = $2
        AND created_at >= $3::timestamptz - INTERVAL '1 day'
        AND created_at <= $3::timestamptz + INTERVAL '1 day'
      LIMIT 1`,
    [proposalId, refundAmountCents, paidOnNoonUtc]
  );
  if (manual.rowCount > 0) {
    await client.query(
      `UPDATE legacy_cc_payments SET promoted_refund_id = $1 WHERE id = $2`,
      [manual.rows[0].id, legacyPaymentId]
    );
    await client.query('COMMIT'); continue;
  }

  // FOR UPDATE lock
  const lockRes = await client.query(
    `SELECT total_price, amount_paid, status FROM proposals WHERE id = $1 FOR UPDATE`,
    [proposalId]
  );
  const before = lockRes.rows[0];

  // Refund-without-payment assertion
  const netRes = await client.query(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM proposal_payments WHERE proposal_id = $1 AND status='succeeded'), 0)
     - COALESCE((SELECT SUM(amount) FROM proposal_refunds  WHERE proposal_id = $1 AND status='succeeded'), 0)
       AS net_paid_cents`,
    [proposalId]
  );
  if (Number(netRes.rows[0].net_paid_cents) < refundAmountCents) {
    // Errored — too large a refund
    await client.query('ROLLBACK');
    // Write errored row to raw_imports + Sentry
    continue;
  }

  const totalPriceBefore = Number(before.total_price);
  const totalPriceAfter = Math.max(0, totalPriceBefore - refundAmountCents / 100);

  // INSERT proposal_refunds
  const ref = await client.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
        amount, reason, total_price_before, total_price_after, status, created_at)
     VALUES ($1, NULL, NULL, NULL, $2, $3, $4, $5, 'succeeded', $6)
     RETURNING id`,
    [proposalId, refundAmountCents, 'Legacy Check Cherry import — refund reason not exported',
     totalPriceBefore, totalPriceAfter, paidOnNoonUtc]
  );

  // UPDATE #1 — money
  await client.query(
    `UPDATE proposals
        SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
            amount_paid = GREATEST(amount_paid - ($1 / 100.0), 0)
      WHERE id = $2`,
    [refundAmountCents, proposalId]
  );

  // UPDATE #2 — status demote + autopay clear
  await client.query(
    `UPDATE proposals
        SET status = CASE
              WHEN status NOT IN ('balance_paid','deposit_paid') THEN status
              WHEN amount_paid <= 0 THEN 'accepted'
              WHEN amount_paid < total_price THEN 'deposit_paid'
              ELSE status
            END,
            autopay_enrolled = CASE
              WHEN status = 'balance_paid' AND amount_paid < total_price THEN false
              ELSE autopay_enrolled
            END
      WHERE id = $1`,
    [proposalId]
  );

  // Link the legacy row
  await client.query(
    `UPDATE legacy_cc_payments SET promoted_refund_id = $1 WHERE id = $2`,
    [ref.rows[0].id, legacyPaymentId]
  );

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

- [ ] **Step 5: Recompute `amount_paid` from scratch (spec §8.4 step 6)**

After all payment + refund rows processed, run:

```sql
UPDATE proposals
   SET amount_paid = ((COALESCE((SELECT SUM(amount) FROM proposal_payments p WHERE p.proposal_id = proposals.id AND p.status='succeeded'), 0)
                    - COALESCE((SELECT SUM(amount) FROM proposal_refunds  r WHERE r.proposal_id = proposals.id AND r.status='succeeded'), 0)
                    )::numeric / 100.0)::numeric(10,2)
 WHERE cc_id IS NOT NULL;
```

- [ ] **Step 6: Re-derive `payment_type` AND `status` (spec §8.4 step 7)**

```sql
UPDATE proposals
   SET payment_type = CASE WHEN amount_paid >= total_price THEN 'full' ELSE 'deposit' END,
       status       = CASE
         WHEN cc_id IS NOT NULL
           AND status = 'confirmed'
           AND amount_paid >= total_price
           AND event_date >= CURRENT_DATE
         THEN 'balance_paid'
         ELSE status
       END
 WHERE cc_id IS NOT NULL;
```

- [ ] **Step 7: Suppress now-stale balance-reminder rows (spec §8.4 step 8)**

```sql
UPDATE scheduled_messages sm
   SET status = 'suppressed',
       error_message = 'cc-import: balance settled at import'
 WHERE sm.entity_type = 'proposal'
   AND sm.status = 'pending'
   AND sm.message_type IN (
     'balance_reminder_autopay_t3', 'balance_reminder_non_autopay_t3',
     'balance_due_today', 'balance_late_t1', 'balance_late_t3',
     'balance_due_today_sms', 'balance_late_t1_sms', 'balance_late_t3_sms'
   )
   AND sm.entity_id IN (
     SELECT id FROM proposals WHERE cc_id IS NOT NULL AND amount_paid >= total_price
   );
```

- [ ] **Step 8: Integration test (mock CSV, fixture proposals)**

`phase4.test.js`: small fixture covering (a) Stripe payment with `ch_*`, (b) cash payment, (c) refund row reducing total_price + amount_paid + demoting status. Assert all expected DB state after run.

- [ ] **Step 9: Export `promoteSingleLegacyPayment(legacyId, options)` as a named export**

Task 19's `/orphan-payment/:legacy_id/link` re-runs Phase 4 single-row promotion after the operator sets `cc_event_id`. Refactor so the per-row payment-promotion logic (idempotency check + INSERT into `proposal_payments` + linking) lives in `promoteSingleLegacyPayment(legacyId, options)` and refund logic similarly extracted as `promoteSingleLegacyRefund(legacyId, options)` (the row-lock + Approach A pair). Both exported from `phase4.js`.

- [ ] **Step 10: Per-phase Sentry summary (Global Conventions §7)**

At end of `run()`, emit one summary `Sentry.captureMessage` with phase=4 + samples.

- [ ] **Step 11: Commit**

```bash
git add scripts/cc-import/phases/phase4.js scripts/cc-import/phases/phase4.test.js
git commit -m "feat(cc-import): Phase 4 payments + refunds (Approach A: row lock + status demote + autopay clear) + named exports for single-row promotion"
```

---

## Task 16: Phase 5 — payouts (with re-run guard)

**Files:**
- Create: `scripts/cc-import/phases/phase5.js`

- [ ] **Step 1: Implement Phase 5**

```js
async function run(args) {
  const runId = await startRun(5);
  const rows = loadCsv(path.join(CC_DIR, 'report (5).csv'));

  for (const [i, row] of rows.entries()) {
    // INSERT into legacy_cc_raw_imports + legacy_cc_payouts
    const rawId = await insertRawImport(pool, { source_file: 'report (5).csv', source_row_number: i + 1, source_entity: 'payouts', payload: row });
    const norm = normalize(row.Payee);

    // Re-run guard: skip cascade if already linked
    const existingRes = await pool.query(
      `SELECT payee_user_id FROM legacy_cc_payouts WHERE raw_import_id = $1`,
      [rawId]
    );
    let payeeUserId = existingRes.rows[0]?.payee_user_id ?? null;

    if (payeeUserId === null) {
      const candidates = await findByName(pool, row.Payee);
      if (candidates.length === 1) payeeUserId = candidates[0];
      // multi-candidate = leave NULL, surface on Review page
    }

    await pool.query(
      `INSERT INTO legacy_cc_payouts
         (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, reference_role, category, raw_import_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (raw_import_id) DO NOTHING`,
      [row.Payee, norm, payeeUserId, parseCcDate(row.Date), parseMoneyCents(row.Amount), row.Reference, row.Category, rawId]
    );
  }

  await finishRun(runId, { status: 'succeeded', rowsProcessed: rows.length, ... });
}
```

- [ ] **Step 2: Manual dev verification**

Run `node scripts/cc-import.js --phase=5` against `report (5).csv`. Expected: 116 `legacy_cc_payouts` rows. Spot-check linkage:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS linked, COUNT(*) FILTER (WHERE payee_user_id IS NULL) AS unmatched FROM legacy_cc_payouts;"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/cc-import/phases/phase5.js
git commit -m "feat(cc-import): Phase 5 payouts archive with re-run-safe cascade"
```

---

## Task 17: Phase 6 — leads + invoices archive

**Files:**
- Create: `scripts/cc-import/phases/phase6.js`

- [ ] **Step 1: Implement Phase 6**

Trivial: load `report (12).csv` (leads, 81 rows) + `report (14).csv` (invoices, 27 rows) into `legacy_cc_raw_imports`. No promotion, no separate normalized table. Set `import_status = 'archived'` for all.

- [ ] **Step 2: Commit**

```bash
git add scripts/cc-import/phases/phase6.js
git commit -m "feat(cc-import): Phase 6 leads + invoices archive"
```

---

## Task 18: Wrap-up admin page (route + UI + endpoint)

**Files:**
- Create: `server/routes/admin/ccImport/index.js`
- Create: `server/routes/admin/ccImport/wrapUp.js`
- Create: `server/routes/admin/ccImport/wrapUp.test.js`
- Create: `client/src/pages/admin/CcImportWrapUpPage.js`
- Modify: `server/routes/admin/index.js` (mount router)
- Modify: `client/src/App.js` (add route)

- [ ] **Step 1: Create composition router**

`server/routes/admin/ccImport/index.js`:

```js
const express = require('express');
const router = express.Router();

router.use('/', require('./wrapUp'));
router.use('/', require('./review'));
router.use('/', require('./search'));

module.exports = router;
```

In `server/routes/admin/index.js`, add: `router.use('/cc-import', require('./ccImport'));`

- [ ] **Step 2: Create `wrapUp.js` — GET worklist endpoint**

```js
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');  // default export per Global Conventions §2
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');

const router = express.Router();

router.get('/wrap-up', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = req.query.filter === 'all' ? 'all' : 'needs-wrapup';
  const range = req.query.range === 'last-30' ? 'last-30' : 'since-import';
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const filterSql = filter === 'needs-wrapup'
    ? `AND NOT EXISTS (
         SELECT 1 FROM scheduled_messages sm
          WHERE sm.entity_type = 'proposal' AND sm.entity_id = p.id
            AND sm.message_type = 'post_event_wrap_up_email'
            AND sm.status IN ('pending','sent')
       )` : '';
  const rangeSql = range === 'last-30'
    ? `AND p.event_date >= CURRENT_DATE - INTERVAL '30 days'` : '';

  const sql = `
    SELECT p.id, p.cc_id, p.event_date, c.id AS client_id, c.name AS client_name, c.email, c.email_status,
           p.event_type, p.total_price, p.amount_paid,
           EXISTS (
             SELECT 1 FROM scheduled_messages sm
              WHERE sm.entity_type = 'proposal' AND sm.entity_id = p.id
                AND sm.message_type = 'post_event_wrap_up_email'
                AND sm.status IN ('pending','sent')
           ) AS wrap_up_done
      FROM proposals p
      JOIN clients c ON c.id = p.client_id
     WHERE p.cc_id IS NOT NULL
       AND p.status = 'completed'
       AND p.event_date < CURRENT_DATE
       ${filterSql}
       ${rangeSql}
     ORDER BY p.event_date DESC
     LIMIT ${pageSize} OFFSET ${offset}
  `;

  const [items, counts] = await Promise.all([
    pool.query(sql),
    pool.query(`
      SELECT
        COUNT(*) AS total_bucket_b,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM scheduled_messages sm
           WHERE sm.entity_type='proposal' AND sm.entity_id=p.id
             AND sm.message_type='post_event_wrap_up_email' AND sm.status IN ('pending','sent')
        )) AS needs_wrapup,
        COUNT(*) FILTER (WHERE p.event_date >= CURRENT_DATE - INTERVAL '30 days') AS last_30
      FROM proposals p
      WHERE p.cc_id IS NOT NULL AND p.status='completed' AND p.event_date < CURRENT_DATE
    `)
  ]);

  res.json({ items: items.rows, counts: counts.rows[0] });
}));

module.exports = router;
```

- [ ] **Step 3: Create POST `/wrap-up/enqueue` endpoint**

In same `wrapUp.js`:

```js
const { scheduleMessage } = require('../../../utils/messageScheduling');
const { logAdminAction } = require('../../../utils/adminAuditLog');

router.post('/wrap-up/enqueue', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const ids = req.body?.proposal_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) {
    throw new ValidationError(undefined, 'proposal_ids must be a non-empty array (≤ 50)');
  }
  if (!ids.every(Number.isInteger)) {
    throw new ValidationError(undefined, 'proposal_ids must be integers');
  }

  const results = [];
  for (const proposalId of ids) {
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.client_id, p.cc_id, c.email, c.email_status, c.id AS client_id_check
           FROM proposals p JOIN clients c ON c.id = p.client_id
          WHERE p.id = $1 AND p.cc_id IS NOT NULL AND p.status = 'completed' AND p.event_date < CURRENT_DATE`,
        [proposalId]
      );
      if (rows.length === 0) {
        results.push({ proposal_id: proposalId, outcome: 'invalid_target' });
        continue;
      }
      const { client_id, email, email_status, cc_id } = rows[0];

      // Bad-email pre-filter
      if (email_status === 'bad' || /^cc-import-noemail-.*@drbartender\.local$/.test(email)) {
        results.push({ proposal_id: proposalId, outcome: 'no_email' });
        continue;
      }

      // Dedup against pending/sent
      const dup = await pool.query(
        `SELECT 1 FROM scheduled_messages
          WHERE entity_type='proposal' AND entity_id=$1
            AND message_type='post_event_wrap_up_email' AND status IN ('pending','sent') LIMIT 1`,
        [proposalId]
      );
      if (dup.rowCount > 0) {
        results.push({ proposal_id: proposalId, outcome: 'already_enqueued' });
        continue;
      }

      await scheduleMessage({
        entityType: 'proposal', entityId: proposalId,
        messageType: 'post_event_wrap_up_email',
        recipientType: 'client', recipientId: client_id,
        channel: 'email', scheduledFor: new Date(),
      });

      await pool.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'cc_wrap_up_enqueued', 'admin', $2, $3)`,
        [proposalId, req.user.id, JSON.stringify({ cc_id })]
      );
      await logAdminAction({
        actorUserId: req.user.id, targetUserId: client_id,
        action: 'cc_wrap_up_enqueued',
        metadata: { proposal_id: proposalId, cc_id },
      });

      results.push({ proposal_id: proposalId, outcome: 'enqueued' });
    } catch (err) {
      Sentry.captureException(err, { tags: { route: req.path, user_id: req.user.id }});
      results.push({ proposal_id: proposalId, outcome: 'error', message: err.message });
    }
  }

  res.json({ results });
}));
```

- [ ] **Step 4: Endpoint test**

`wrapUp.test.js` covers: 50-cap validation, integer validation, bad-email skip, dedup skip, successful enqueue, multiple ids with mixed outcomes.

- [ ] **Step 4.5: Add pre-flight preview endpoint (spec §9.1)**

In `wrapUp.js`:

```js
const { resolveChannelFallback } = require('../../../utils/channelFallback');
const { checkSuppression } = require('../../../utils/scheduledMessageDispatcher');  // Task 7 export

router.post('/wrap-up/preview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const ids = req.body?.proposal_ids;
  if (!Array.isArray(ids) || ids.length > 50) {
    throw new ValidationError(undefined, 'proposal_ids must be an array of integers (≤ 50)');
  }
  const breakdown = { proceed: 0, no_email: 0, suppressed: 0 };
  for (const proposalId of ids) {
    const { rows } = await pool.query(
      `SELECT p.id, p.status, c.email, c.email_status, c.id AS client_id, c.communication_preferences
         FROM proposals p JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
      [proposalId]
    );
    if (rows.length === 0) continue;
    const { email, email_status } = rows[0];
    if (email_status === 'bad' || /^cc-import-noemail-.*@drbartender\.local$/.test(email)) {
      breakdown.no_email++; continue;
    }
    // Pure preview shim using resolveChannelFallback (no DB writes)
    const fallback = await resolveChannelFallback({ client: rows[0], channel: 'email' });
    if (fallback?.action !== 'proceed') { breakdown.suppressed++; continue; }
    breakdown.proceed++;
  }
  res.json({ total: ids.length, breakdown });
}));
```

The page's confirm modal POSTs to `/wrap-up/preview` first and renders `X of N will be skipped (Y bad email)`.

- [ ] **Step 5: Create the React page**

`client/src/pages/admin/CcImportWrapUpPage.js`:

```jsx
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../utils/api';

export default function CcImportWrapUpPage() {
  const [params, setParams] = useSearchParams();
  const page = parseInt(params.get('page') || '1', 10);
  const filter = params.get('filter') || 'needs-wrapup';
  const range = params.get('range') || 'since-import';

  const [data, setData] = useState({ items: [], counts: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setLoading(true); setError(null);
    api.get(`/admin/cc-import/wrap-up?page=${page}&filter=${filter}&range=${range}`)
      .then(r => setData(r.data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, filter, range]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < 50) next.add(id);
    setSelected(next);
  };

  const enqueue = async () => {
    if (!window.confirm(`Send wrap-up email to ${selected.size} client${selected.size === 1 ? '' : 's'}?`)) return;
    setPending(true);
    try {
      const r = await api.post('/admin/cc-import/wrap-up/enqueue', { proposal_ids: [...selected] });
      // Re-fetch worklist after enqueue
      const refreshed = await api.get(`/admin/cc-import/wrap-up?page=${page}&filter=${filter}&range=${range}`);
      setData(refreshed.data);
      setSelected(new Set());
      alert(JSON.stringify(r.data.results, null, 2));  // simple toast placeholder
    } catch (e) { setError(e.message); }
    finally { setPending(false); }
  };

  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error} <button onClick={() => window.location.reload()}>Retry</button></div>;
  if (data.items.length === 0) {
    const empty = filter === 'needs-wrapup'
      ? 'All Bucket B wrap-ups have been sent. Toggle off to see the full list.'
      : 'No Check Cherry events match the current filter.';
    return <div className="empty-state">{empty}</div>;
  }

  return (
    <div className="cc-wrapup">
      <h1>CC Import — Wrap-up</h1>
      <div className="counts">
        Total Bucket B: {data.counts.total_bucket_b} |
        Needs wrap-up: {data.counts.needs_wrapup} |
        Last 30 days: {data.counts.last_30}
      </div>
      <div className="controls">
        <label><input type="checkbox" checked={filter === 'needs-wrapup'}
          onChange={(e) => setParams({ page: '1', filter: e.target.checked ? 'needs-wrapup' : 'all', range })}/> Needs wrap-up only</label>
        <button onClick={() => setParams({ page: '1', filter, range: range === 'last-30' ? 'since-import' : 'last-30' })}>
          {range === 'last-30' ? 'Show all dates' : 'Last 30 days'}
        </button>
      </div>
      <table>
        <thead>
          <tr><th></th><th>Event date</th><th>Client</th><th>Event type</th><th>Total</th><th>Wrap-up sent?</th></tr>
        </thead>
        <tbody>
          {data.items.map(item => (
            <tr key={item.id}>
              <td><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)}
                  disabled={!selected.has(item.id) && selected.size >= 50}/></td>
              <td>{new Date(item.event_date).toLocaleDateString()}</td>
              <td>{item.client_name} ({item.email})</td>
              <td>{item.event_type || 'event'}</td>
              <td>${Number(item.total_price).toFixed(2)}</td>
              <td>{item.wrap_up_done ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button disabled={selected.size === 0 || pending} onClick={enqueue}>
        {pending ? 'Sending…' : `Send wrap-up email to selected (${selected.size})`}
      </button>
      <div className="pagination">
        <button disabled={page <= 1} onClick={() => setParams({ page: String(page - 1), filter, range })}>Prev</button>
        <span>Page {page}</span>
        <button disabled={data.items.length < 50} onClick={() => setParams({ page: String(page + 1), filter, range })}>Next</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add the route in `client/src/App.js`**

```jsx
<Route path="/admin/cc-import/wrap-up" element={<ProtectedRoute adminOnly><CcImportWrapUpPage /></ProtectedRoute>} />
```

Per Global Conventions §5: the existing `<ProtectedRoute adminOnly>` accepts both admin and manager (its internal check at `App.js:174`).

- [ ] **Step 7: Manual UI verification**

Open `/admin/cc-import/wrap-up`. Verify loading, empty, error, selection cap, refresh-preserves-state-via-URL. Send 1 test wrap-up email to a test client.

- [ ] **Step 8: Commit**

```bash
git add server/routes/admin/ccImport/ server/routes/admin/index.js client/src/pages/admin/CcImportWrapUpPage.js client/src/App.js
git commit -m "feat(admin): CC Import wrap-up page (worklist + bulk-action endpoint)"
```

---

## Task 19: Review admin page (route + UI + 12+ endpoints)

**Files:**
- Create: `server/routes/admin/ccImport/review.js`
- Create: `server/routes/admin/ccImport/search.js`
- Create: `server/routes/admin/ccImport/review.test.js`
- Create: `server/routes/admin/ccImport/search.test.js`
- Create: `client/src/pages/admin/CcImportReviewPage.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Create `search.js` (3 picker endpoints)**

```js
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager, adminOnly } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');  // default export per Global Conventions §2
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');

const router = express.Router();

function parseQ(req) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 100) {
    throw new ValidationError(undefined, 'q must be 2-100 chars');
  }
  return q;
}
function parsePagination(req) {
  return {
    limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25)),
    offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
  };
}

router.get('/search/proposals', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const q = parseQ(req);
  const { limit, offset } = parsePagination(req);
  const sql = `
    SELECT p.id, p.cc_id, c.name AS client_name, p.event_date, p.total_price
      FROM proposals p
      JOIN clients   c ON c.id = p.client_id
     WHERE c.name ILIKE $1 OR p.cc_id = $2
     ORDER BY p.event_date DESC
     LIMIT $3 OFFSET $4
  `;
  const { rows } = await pool.query(sql, [`%${q}%`, q, limit, offset]);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM proposals p JOIN clients c ON c.id = p.client_id
      WHERE c.name ILIKE $1 OR p.cc_id = $2`,
    [`%${q}%`, q]
  );
  res.json({ items: rows, total: count.rows[0].total });
}));

router.get('/search/users', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const q = parseQ(req);
  const { limit, offset } = parsePagination(req);
  const includeStubs = req.query.include_stubs === 'true';
  if (includeStubs && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'include_stubs requires admin role' });
  }
  const stubFilter = includeStubs ? '' : `AND (u.cc_id IS NULL OR u.cc_id NOT LIKE 'legacy_cc:%')`;
  const sql = `
    SELECT u.id, COALESCE(cp.preferred_name, u.email) AS name, u.email, u.cc_id, u.onboarding_status
      FROM users u
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
     WHERE (cp.preferred_name ILIKE $1 OR u.email ILIKE $1) ${stubFilter}
     ORDER BY u.id ASC
     LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(sql, [`%${q}%`, limit, offset]);
  // Redact stub email when caller is not admin (defense-in-depth; UI hides stubs already)
  if (req.user.role !== 'admin') {
    for (const r of rows) {
      if (/^legacy_cc:/.test(String(r.cc_id || ''))) r.email = '(redacted)';
    }
  }
  res.json({ items: rows });
}));

router.get('/review/unmatched-payee/:legacy_payout_id/link-preview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const legacyPayoutId = parseInt(req.params.legacy_payout_id, 10);
  const userId = parseInt(req.query.user_id, 10);
  if (!Number.isInteger(legacyPayoutId) || !Number.isInteger(userId)) {
    throw new ValidationError(undefined, 'legacy_payout_id and user_id must be integers');
  }
  const lookupStub = await pool.query(`SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`, [legacyPayoutId]);
  const stubUserId = lookupStub.rows[0]?.payee_user_id;
  if (!stubUserId) return res.json({ shifts_reassigned: 0, shifts_merged: 0, shifts_real_user_status_cleared: 0, proposals: 0 });

  const { rows: [counts] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM shift_requests sr2
           WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1
        )
      ) AS shifts_reassigned,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM shift_requests sr2
           WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1 AND sr2.status = 'approved'
        )
      ) AS shifts_merged,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM shift_requests sr2
           WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1 AND sr2.status IN ('pending', 'denied')
        )
      ) AS shifts_real_user_status_cleared,
      COUNT(DISTINCT s.proposal_id) AS proposals
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    WHERE sr.user_id = $2
  `, [userId, stubUserId]);

  res.json(counts);
}));

module.exports = router;
```

- [ ] **Step 2: Create `review.js` (GET + 12 action endpoints)**

Skeleton with helper for shared validation + audit (cite spec §9.2 §1–§7):

```js
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');  // default export per Global Conventions §2
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');
const { accruePayoutsForProposal } = require('../../../utils/payrollAccrual');
// Phase helpers exported by Tasks 14 and 15:
const { promoteBucketA, promoteBucketB } = require('../../../../scripts/cc-import/phases/phase3');
const { promoteSingleLegacyPayment, promoteSingleLegacyRefund } = require('../../../../scripts/cc-import/phases/phase4');

const router = express.Router();

function intParam(name, value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) throw new ValidationError(undefined, `${name} must be an integer`);
  return n;
}
function trimText(name, value, { required = false, max = 2000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new ValidationError(undefined, `${name} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new ValidationError(undefined, `${name} exceeds ${max} chars`);
  return s;
}

// GET /review — returns all 7 sections for the page
router.get('/review', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const [duplicates, orphans, payees, unmatchedStaff, errored, skipped, phase0Eligible, phase0Done] = await Promise.all([
    pool.query(`SELECT * FROM legacy_cc_raw_imports WHERE import_status='duplicate_review' AND source_entity='events' ORDER BY id LIMIT 50`),
    pool.query(`SELECT * FROM legacy_cc_payments WHERE promoted_payment_id IS NULL AND promoted_refund_id IS NULL AND cc_event_id IS NULL AND dismissed_at IS NULL ORDER BY id LIMIT 50`),
    pool.query(`SELECT * FROM legacy_cc_payouts WHERE payee_user_id IS NULL ORDER BY id LIMIT 50`),
    pool.query(`SELECT notes FROM cc_import_runs WHERE phase = 3 ORDER BY id DESC LIMIT 1`),
    pool.query(`SELECT * FROM legacy_cc_raw_imports WHERE import_status='errored' ORDER BY id LIMIT 50`),
    pool.query(`SELECT * FROM legacy_cc_raw_imports WHERE import_status='skipped' AND source_entity='events' ORDER BY id LIMIT 50`),
    pool.query(`SELECT * FROM cc_import_phase0_failures WHERE attempt_count >= 10 AND given_up_at IS NULL ORDER BY id LIMIT 50`),
    pool.query(`SELECT * FROM cc_import_phase0_failures WHERE given_up_at IS NOT NULL ORDER BY given_up_at DESC LIMIT 50`),
  ]);
  res.json({
    duplicates: duplicates.rows,
    orphans: orphans.rows,
    unmatchedPayees: payees.rows,
    unmatchedStaff: unmatchedStaff.rows[0]?.notes || [],
    errored: errored.rows,
    skipped: skipped.rows,
    phase0Eligible: phase0Eligible.rows,
    phase0Done: phase0Done.rows,
  });
}));

// POST /review/duplicate/:row_id/confirm
router.post('/review/duplicate/:row_id/confirm', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const rowId = intParam('row_id', req.params.row_id);
  const r = await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = 'duplicate_confirmed',
            import_notes = jsonb_set(coalesce(import_notes, '{}'::jsonb),
              '{decision}', '"duplicate"'::jsonb)
                || jsonb_build_object('resolved_by_user_id', $1::int, 'resolved_at', NOW())
      WHERE id = $2 AND import_status = 'duplicate_review'
      RETURNING id`,
    [req.user.id, rowId]
  );
  if (r.rowCount === 0) throw new ConflictError('duplicate already resolved or not found');
  await logAdminAction({ actorUserId: req.user.id, action: 'cc_duplicate_confirmed', metadata: { raw_import_id: rowId }});
  res.json({ ok: true });
}));

// POST /review/duplicate/:row_id/promote
// (Re-runs the Bucket A insert flow for this one row with dedup check bypassed.
//  Implementation: load the row's payload, invoke phase3's promoteBucketA(payload, { skipDedup: true }) helper.
//  Returns 409 with { candidate_edited: true } if candidate proposal's updated_at > imported_at and not confirmed.)
router.post('/review/duplicate/:row_id/promote', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const rowId = intParam('row_id', req.params.row_id);
  const confirmEdited = req.body?.confirm_candidate_edited === true;
  // ... full implementation per spec §9.2 §1 (load payload, check candidate edit, call promoteBucketA)
}));

// POST /review/orphan-payment/:legacy_id/link  (body: { proposal_id })
router.post('/review/orphan-payment/:legacy_id/link', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const legacyId = intParam('legacy_id', req.params.legacy_id);
  const proposalId = intParam('proposal_id', req.body?.proposal_id);
  // ... update legacy_cc_payments.cc_event_id, re-run Phase 4 single-row promotion + proposal-wide recomputes
}));

// POST /review/orphan-payment/:legacy_id/dismiss  (body: { reason?: string })
router.post('/review/orphan-payment/:legacy_id/dismiss', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const legacyId = intParam('legacy_id', req.params.legacy_id);
  const reason = trimText('reason', req.body?.reason, { max: 2000 });
  await pool.query(`UPDATE legacy_cc_payments SET dismissed_at = NOW(), notes = $1 WHERE id = $2`, [reason, legacyId]);
  await logAdminAction({ actorUserId: req.user.id, action: 'cc_orphan_payment_dismissed', metadata: { legacy_id: legacyId, reason }});
  res.json({ ok: true });
}));

// POST /review/unmatched-payee/:legacy_payout_id/link  (body: { user_id })
//   — Full implementation per spec §9.3.E: DELETE 1a + 1b, UPDATE shift_requests,
//     capture inherited proposal_ids, COMMIT, then post-COMMIT auto-reaccrue loop
router.post('/review/unmatched-payee/:legacy_payout_id/link', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const legacyPayoutId = intParam('legacy_payout_id', req.params.legacy_payout_id);
  const userId = intParam('user_id', req.body?.user_id);

  const client = await pool.connect();
  let inheritedProposalIds = [];
  try {
    await client.query('BEGIN');
    const stubRow = await client.query(`SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1 FOR UPDATE`, [legacyPayoutId]);
    const stubUserId = stubRow.rows[0]?.payee_user_id;
    if (!stubUserId) throw new NotFoundError('legacy_cc_payouts row has no stub user');

    // Update legacy_cc_payouts pointer
    await client.query(`UPDATE legacy_cc_payouts SET payee_user_id = $1 WHERE id = $2`, [userId, legacyPayoutId]);

    // Step 1a: drop now-real's non-approved rows where stub is approved (preserve money path)
    await client.query(
      `DELETE FROM shift_requests sr
        WHERE sr.user_id = $1 AND sr.status IN ('pending','denied')
          AND EXISTS (
            SELECT 1 FROM shift_requests sr2
             WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $2 AND sr2.status = 'approved'
          )`,
      [userId, stubUserId]
    );

    // Step 1b: drop stub rows where now-real is already approved (true dup)
    await client.query(
      `DELETE FROM shift_requests sr
        WHERE sr.user_id = $1
          AND EXISTS (
            SELECT 1 FROM shift_requests sr2
             WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $2 AND sr2.status = 'approved'
          )`,
      [stubUserId, userId]
    );

    // Step 2: reassign remaining
    await client.query(
      `UPDATE shift_requests SET user_id = $1 WHERE user_id = $2`,
      [userId, stubUserId]
    );

    // Step 3: capture inherited proposal ids for post-COMMIT auto-reaccrue
    const inherited = await client.query(
      `SELECT DISTINCT s.proposal_id
         FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
        WHERE sr.user_id = $1 AND sr.status = 'approved'`,
      [userId]
    );
    inheritedProposalIds = inherited.rows.map(r => r.proposal_id);

    // Audit trail: one proposal_activity_log entry per affected proposal (spec §9.3.E)
    for (const pid of inheritedProposalIds) {
      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'cc_link_shift_request_dedup', 'admin', $2, $3)`,
        [pid, req.user.id, JSON.stringify({ stub_user_id: stubUserId, now_real_user_id: userId, legacy_payout_id: legacyPayoutId })]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }

  await logAdminAction({ actorUserId: req.user.id, action: 'cc_unmatched_payee_linked', metadata: { legacy_payout_id: legacyPayoutId, user_id: userId }});

  // Step 4: post-COMMIT auto-reaccrue (best-effort, separate connection)
  for (const pid of inheritedProposalIds) {
    try {
      await accruePayoutsForProposal(pid);
    } catch (err) {
      Sentry.captureException(err, { tags: { route: req.path, step: 'auto_reaccrue', proposalId: pid }});
    }
  }

  res.json({ ok: true, inherited_proposal_count: inheritedProposalIds.length });
}));

// POST /review/unmatched-payee/:legacy_payout_id/create-stub
router.post('/review/unmatched-payee/:legacy_payout_id/create-stub', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Build stub via buildStubCcId + INSERT into users / contractor_profiles transactionally
  // Then link the payout row
}));

// POST /review/errored-row/:row_id/retry  (body: { payload_override?: <JSON> })
router.post('/review/errored-row/:row_id/retry', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // If payload_override, UPDATE legacy_cc_raw_imports.payload first
  // Then dispatch to the appropriate phase's promote function based on source_entity
}));

// POST /review/skipped-event/:row_id/promote
router.post('/review/skipped-event/:row_id/promote', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Load the skipped row, re-run Phase 3 promotion bypassing the skip rule
}));

// POST /review/phase0-failure/:row_id/accept-loss  (body: { reason: required })
router.post('/review/phase0-failure/:row_id/accept-loss', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const rowId = intParam('row_id', req.params.row_id);
  const reason = trimText('reason', req.body?.reason, { required: true, max: 500 });
  const r = await pool.query(
    `UPDATE cc_import_phase0_failures SET given_up_at = NOW(), given_up_reason = $1
      WHERE id = $2 AND given_up_at IS NULL AND attempt_count >= 10 RETURNING id`,
    [reason, rowId]
  );
  if (r.rowCount === 0) throw new ConflictError('row already given up or not eligible');
  await logAdminAction({ actorUserId: req.user.id, action: 'cc_phase0_give_up', metadata: { row_id: rowId, reason }});
  res.json({ ok: true });
}));

// POST /review/phase0-failure/:row_id/revert-give-up
router.post('/review/phase0-failure/:row_id/revert-give-up', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const rowId = intParam('row_id', req.params.row_id);
  const r = await pool.query(
    `UPDATE cc_import_phase0_failures SET given_up_at = NULL, given_up_reason = NULL, attempt_count = 0
      WHERE id = $1 AND given_up_at IS NOT NULL RETURNING id`,
    [rowId]
  );
  if (r.rowCount === 0) throw new ConflictError('row not in given-up state');
  await logAdminAction({ actorUserId: req.user.id, action: 'cc_phase0_revert_give_up', metadata: { row_id: rowId }});
  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 3: Endpoint tests**

`review.test.js` covers: validation failures (non-integer params, missing required reason), state-guard failures (409 on already-actioned), success paths for each action. `search.test.js` covers: q-length validation, 403 when manager requests `include_stubs=true`, redaction of stub emails for managers.

- [ ] **Step 4: Create the React page**

`client/src/pages/admin/CcImportReviewPage.js`: 7 collapsible sections matching `GET /review` shape. Each section has its own loading/empty/error state. Pickers for orphan-payment-link + unmatched-payee-link use the `/search/*` endpoints with 300ms debouncing. Modal copy for unmatched-payee link uses the pluralization rules from spec §9.3.E.

- [ ] **Step 5: Add route in `client/src/App.js`**

```jsx
<Route path="/admin/cc-import/review" element={<ProtectedRoute adminOnly><CcImportReviewPage /></ProtectedRoute>} />
```

- [ ] **Step 6: Manual UI verification**

Walk through each Review section: dismiss an orphan, link a payee (verify modal counts), accept loss on a Phase 0 row, revert a give-up.

- [ ] **Step 7: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/search.js server/routes/admin/ccImport/*.test.js client/src/pages/admin/CcImportReviewPage.js client/src/App.js
git commit -m "feat(admin): CC Import Review page (7 sections + 12 action endpoints)"
```

---

## Task 20: Financial dashboard `?include_cc=` filter chip

**Files:**
- Modify: `server/utils/metricsQueries.js` (8 helpers: `qSent`, `qAccepted`, `qWinRate`, `qTimeToAccept`, `qLostValue`, `qMoney`, `qOutstanding`, `qRevenue`)
- Modify: `server/routes/proposals/metadata.js` (read `?include_cc=`, thread to helpers)
- Modify: `client/src/hooks/useMetricsFilter.js` (add `includeCc` to state)
- Modify: `client/src/components/adminos/MetricsFilterBar.js` (add tri-state segmented control)
- Add tests for the new SQL behavior

- [ ] **Step 1: Add `includeCc` to each `qX(f)` helper**

For helpers that already JOIN to `proposals` (most do), add a conditional:
```js
const ccFilter = f.includeCc === 'only' ? `AND p.cc_id IS NOT NULL`
              : f.includeCc === 'exclude' ? `AND p.cc_id IS NULL` : '';
```
Append `${ccFilter}` to the existing WHERE.

For `qMoney(basis='paid')` and `qRevenue(basis='paid')` which query `proposal_payments` without a JOIN, add `JOIN proposals p ON p.id = pp.proposal_id` to the paid-lens branch when `f.includeCc !== 'all'`. Add `pp.proposal_id IS NOT NULL` guard.

- [ ] **Step 2: Unit-test each modified `qX` helper**

For each helper, add a 3-mode test: assert SQL contains the filter clause for `'only'`, `'exclude'`, and is absent for `'all'`.

- [ ] **Step 3: Integration test asserting math identity**

```js
test('include_cc filter modes: all = exclude + only', async () => {
  const all     = await runDashboardEndpoint({ basis: 'paid', month: '2026-05', include_cc: 'all' });
  const exclude = await runDashboardEndpoint({ basis: 'paid', month: '2026-05', include_cc: 'exclude' });
  const only    = await runDashboardEndpoint({ basis: 'paid', month: '2026-05', include_cc: 'only' });
  expect(all.total).toBeCloseTo(exclude.total + only.total, 2);
});
```

- [ ] **Step 4: Thread the param through `metadata.js`**

```js
const includeCc = ['all','exclude','only'].includes(req.query.include_cc) ? req.query.include_cc : 'all';
// Pass into every metricsQueries.qX call via `f.includeCc = includeCc`
```

- [ ] **Step 5: Add client-side state + UI**

`useMetricsFilter.js` currently uses `useSearchParams` (no internal state object); follow the existing pattern. Add an `includeCc` getter from `params.get('include_cc') || 'all'` and a `setIncludeCc(v)` mutator that writes to `setParams`. Export both alongside the existing `setBasis`, `setPreset`.

`MetricsFilterBar.js`: add a third segmented control reusing the existing `metrics-seg` CSS class for visual consistency with the lens control:
```jsx
<div className="metrics-seg">
  {['all','exclude','only'].map(v => (
    <button key={v} className={filter.includeCc === v ? 'active' : ''}
      onClick={() => filter.setIncludeCc(v)}>
      {v === 'all' ? 'All' : v === 'exclude' ? 'Native only' : 'CC only'}
    </button>
  ))}
</div>
```

- [ ] **Step 6: Manual UI verification**

Open the financial dashboard. Toggle through the three modes. Verify totals change as expected and `all == exclude + only` for a representative month.

- [ ] **Step 7: Commit**

```bash
git add server/utils/metricsQueries.js server/routes/proposals/metadata.js client/src/hooks/useMetricsFilter.js client/src/components/adminos/MetricsFilterBar.js
git commit -m "feat(dashboard): include_cc filter chip + threaded query parameter"
```

---

## Task 21: `/reenroll-drink-plan-nudge` endpoint + UI button

**Files:**
- Create: `server/routes/admin/ccImport/proposalActions.js`
- Modify: `client/src/pages/admin/EventDetailPage.js` (add button)
- Modify: `server/routes/admin/ccImport/index.js` (mount proposalActions router)

- [ ] **Step 1: Create the endpoint**

```js
// server/routes/admin/ccImport/proposalActions.js
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');  // default export per Global Conventions §2
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');
const { scheduleDrinkPlanNudge } = require('../../../utils/drinkPlanNudge');
const { accruePayoutsForProposal } = require('../../../utils/payrollAccrual');

const router = express.Router({ mergeParams: true });

router.post('/proposals/:id/reenroll-drink-plan-nudge', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');

  const propRes = await pool.query(`SELECT id, client_id FROM proposals WHERE id = $1`, [id]);
  if (propRes.rowCount === 0) throw new NotFoundError('proposal not found');

  const planRes = await pool.query(`SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1`, [id]);
  if (planRes.rowCount === 0) throw new ConflictError('no drink plan exists for this proposal');

  await scheduleDrinkPlanNudge(id, pool);
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: propRes.rows[0].client_id,
    action: 'cc_drink_plan_nudge_reenrolled',
    metadata: { proposal_id: id }
  });
  res.json({ ok: true, message: 'Drink-plan nudges scheduled (or already pending)' });
}));

router.post('/proposals/:id/reaccrue-payout', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');
  const propRes = await pool.query(`SELECT id, client_id FROM proposals WHERE id = $1`, [id]);
  if (propRes.rowCount === 0) throw new NotFoundError('proposal not found');
  const result = await accruePayoutsForProposal(id);
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: propRes.rows[0].client_id,
    action: 'cc_payout_reaccrued',
    metadata: { proposal_id: id, result }
  });
  res.json({ result });
}));

module.exports = router;
```

Note: these endpoints mount at `/api/admin/proposals/...` not `/api/admin/cc-import/...`. Update `server/routes/admin/index.js`:

```js
router.use('/', require('./ccImport/proposalActions'));
```

This mounts at `/api/admin/` so the routes resolve to `/api/admin/proposals/:id/...`.

- [ ] **Step 2: Add the UI button on EventDetailPage**

In `client/src/pages/admin/EventDetailPage.js`, after the existing header section (only render when `proposal.cc_id` is non-null AND the event has a drink plan):

```jsx
{proposal.cc_id && hasDrinkPlan && (
  <button onClick={async () => {
    try {
      await api.post(`/admin/proposals/${proposal.id}/reenroll-drink-plan-nudge`);
      alert('Drink-plan nudges scheduled');
    } catch (e) { alert(`Error: ${e.message}`); }
  }}>Schedule drink-plan nudges</button>
)}
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin/ccImport/proposalActions.js server/routes/admin/index.js client/src/pages/admin/EventDetailPage.js
git commit -m "feat(admin): /reenroll-drink-plan-nudge + /reaccrue-payout endpoints + EventDetailPage button"
```

---

## Task 22: Re-accrue payouts UI button on user-detail page

**Depends on Task 21** (uses `/admin/proposals/:id/reaccrue-payout` endpoint).

**Files:**
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js` (~556 lines — yellow zone; flag if adding pushes past 700)
- Modify: `server/routes/admin/users.js` (add helper endpoint `GET /users/:id/stub-co-participated-proposals`)

- [ ] **Step 1: Backend helper endpoint**

```js
router.get('/users/:id/stub-co-participated-proposals', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(`
    SELECT DISTINCT s.proposal_id
      FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
     WHERE sr.user_id = $1 AND sr.status = 'approved'
       AND EXISTS (
         SELECT 1 FROM shift_requests sr2
           JOIN users u ON u.id = sr2.user_id
          WHERE sr2.shift_id IN (SELECT id FROM shifts WHERE proposal_id = s.proposal_id)
            AND u.cc_id LIKE 'legacy_cc:%'
       )
  `, [id]);
  res.json({ proposal_ids: rows.map(r => r.proposal_id) });
}));
```

- [ ] **Step 2: UserDetail UI**

```jsx
{stubCoProposals.length > 0 && (
  <div>
    <h3>Re-accrue payouts</h3>
    <p>This user participated on {stubCoProposals.length} proposal(s) with legacy CC stub co-participants.</p>
    <button onClick={async () => {
      const results = [];
      for (const pid of stubCoProposals) {
        try {
          const r = await api.post(`/admin/proposals/${pid}/reaccrue-payout`);
          results.push({ pid, ok: true, result: r.data.result });
        } catch (e) {
          results.push({ pid, ok: false, error: e.message });
        }
      }
      const succeeded = results.filter(r => r.ok).length;
      const failed = results.length - succeeded;
      alert(`Re-accrued ${succeeded} proposals${failed > 0 ? ` (${failed} failed — see console)` : ''}`);
      if (failed > 0) console.warn('reaccrue failures:', results.filter(r => !r.ok));
    }}>Re-accrue all</button>
  </div>
)}
```

Partial-failure UX: gather per-proposal outcomes, report `X succeeded, Y failed`. Failures logged to console for operator inspection.

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin/users.js client/src/pages/admin/userDetail/AdminUserDetail.js
git commit -m "feat(admin): Re-accrue payouts affordance on user detail page"
```

---

## Task 23: (dissolved — folded into Task 2)

Per Plan Revision 2: the test fixture updates that were originally Task 23 now ship inside Task 2's commit (see Task 2 step 4). This prevents a window where main has failing CI. Task 23 is intentionally empty.

---

## Task 23a: `cc_id` consumer enumeration — server-side SELECTs (spec §6.7)

**Files:**
- Modify: `server/routes/proposals/crud.js` (proposal GETs)
- Modify: `server/routes/proposals/metadata.js` (financial dashboard list endpoint — adds `cc_id` to the SELECT, separate from Task 20's `?include_cc=` filter)
- Modify: `server/routes/admin/search.js` (global search)
- Modify: `server/routes/admin/users.js` (admin user list + detail)
- Modify: `server/routes/clients.js` (admin client list + detail)
- Modify: `server/routes/clientPortal.js` (client-portal `GET /proposals`)
- Modify: `server/utils/globalSearch.js` (search-helper queries — note: returns shaped result objects, not raw rows; add `cc_id` to the shaped object for proposal / client / staff result kinds)
- Modify: `server/utils/metricsQueries.js` (8 `qX` helpers — `qSent`, `qAccepted`, `qWinRate`, `qTimeToAccept`, `qLostValue`, `qMoney`, `qOutstanding`, `qRevenue` — add `cc_id` to their SELECT lists, separate from Task 20's WHERE-clause filter)

- [ ] **Step 1: For each file above, add `cc_id` to the SELECT column list**

Audit each existing SELECT that returns `clients`, `proposals`, or `users` rows. Add `cc_id` (aliased as needed: `c.cc_id AS client_cc_id`, `p.cc_id AS proposal_cc_id`, `u.cc_id AS user_cc_id` when joined). The Wix-side public `ClientDashboard.js` (`client/src/pages/public/ClientDashboard.js`) ALSO needs the client portal endpoint's SELECT to return `cc_id` — even though the public dashboard doesn't render a badge, the field must flow through the API for parity per spec §6.7.

For `globalSearch.js`: `runGlobalSearch` returns shaped result objects (with `kind` / `label` / `subtitle`); add `cc_id` as a top-level field on each result object so consumers can render the badge alongside the label.

- [ ] **Step 2: For each modified endpoint, run a smoke-check curl/HTTPie**

`curl http://localhost:5000/api/admin/clients/<known-cc-id-client>` — verify `cc_id` appears in the JSON.

- [ ] **Step 3: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/metadata.js server/routes/admin/search.js server/routes/admin/users.js server/routes/clients.js server/routes/clientPortal.js server/utils/globalSearch.js server/utils/metricsQueries.js
git commit -m "feat(api): cc_id added to SELECT lists per spec §6.7"
```

---

## Task 23b: Admin staff list "Legacy CC stub" badge (spec §7.3 + §15)

**Files:**
- Modify: `client/src/pages/admin/StaffDashboard.js` (renders rows from `/admin/active-staff`; existing component, NOT `StaffList.js`)
- Modify: `server/routes/admin/users.js` — both (a) `GET /active-staff` (~line 409) to include deactivated stubs, OR (b) add a NEW endpoint `GET /admin/staff-with-stubs` that includes them; AND (c) ensure response includes `cc_id` + `onboarding_status`.

**Discovery:** the existing `/admin/active-staff` endpoint filters `WHERE u.onboarding_status IN ('approved', 'reviewed', 'submitted')` — stubs (created with `'deactivated'` per spec §7.3) are excluded by design. Showing the badge in this list requires either widening the endpoint OR adding a new one. Recommended: add a separate `GET /admin/active-staff?include_stubs=true` query parameter (default false; preserves existing behavior), gated to `admin + manager` since both need to see stubs.

- [ ] **Step 1: Add `?include_stubs=true` to `/admin/active-staff`**

In `server/routes/admin/users.js`, the `/active-staff` handler:

```js
const includeStubs = req.query.include_stubs === 'true';
const statusFilter = includeStubs
  ? `u.onboarding_status IN ('approved', 'reviewed', 'submitted', 'deactivated')`
  : `u.onboarding_status IN ('approved', 'reviewed', 'submitted')`;
// existing SELECT, with cc_id + onboarding_status returned
```

- [ ] **Step 2: StaffDashboard fetches with `include_stubs=true` when current user is admin or manager**

In `client/src/pages/admin/StaffDashboard.js`, change the fetch call to `api.get('/admin/active-staff?include_stubs=true')` (always include stubs for staff management — the badge surfaces them visually).

- [ ] **Step 3: Add badge JSX**

Where each user row renders the user's name:

```jsx
{user.cc_id?.startsWith('legacy_cc:') && user.onboarding_status === 'deactivated' && (
  <span className="badge badge-legacy-cc-stub">Legacy CC stub (deactivated)</span>
)}
```

The raw stub email is rendered only when `currentUser.role === 'admin'` — gate the email cell:

```jsx
{user.cc_id?.startsWith('legacy_cc:') && currentUser.role !== 'admin'
  ? <span className="muted">(redacted)</span>
  : user.email}
```

- [ ] **Step 4: Add CSS for the badge**

In `client/src/index.css`:
```css
.badge-legacy-cc-stub { background: #888; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.75em; margin-left: 0.5em; }
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/StaffDashboard.js server/routes/admin/users.js client/src/index.css
git commit -m "feat(admin): Legacy CC stub badge in StaffDashboard per spec §7.3 (with include_stubs flag)"
```

---

## Task 23c: `LegacyCcPaymentsPanel` component (spec §11 + §15)

**Files:**
- Create: `client/src/components/admin/LegacyCcPaymentsPanel.js`
- Create: `server/routes/proposals/payments.js` OR extend `server/routes/proposals/crud.js` — add a `GET /api/proposals/:id/legacy-cc-payments` endpoint that returns `proposal_payments WHERE proposal_id = $1 AND legacy_charge_id IS NOT NULL`. (The existing `GET /api/proposals/:id` does NOT include a `payments` array — embedding directly is not viable.)
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js` (NOT ProposalDetail.js — the actual payment-panel component is `ProposalDetailPaymentPanel`, rendered at `ProposalDetail.js:505` and `EventDetailPage.js:390`). Embed the panel above the existing `InvoiceDropdown` (~line 239).

- [ ] **Step 1: Create the endpoint**

In `server/routes/proposals/crud.js` (or a new `payments.js`), add:

```js
router.get('/:id/legacy-cc-payments', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');
  const { rows } = await pool.query(
    `SELECT id, amount, payment_method, legacy_charge_id, created_at
       FROM proposal_payments
      WHERE proposal_id = $1 AND legacy_charge_id IS NOT NULL
      ORDER BY created_at ASC`,
    [id]
  );
  res.json({ payments: rows });
}));
```

`adminOnly` gating per spec §11 happens at the route level, not in the component.

- [ ] **Step 2: Implement the panel component (fetches own data)**

```jsx
// client/src/components/admin/LegacyCcPaymentsPanel.js
import React, { useState, useEffect } from 'react';
import api from '../../utils/api';

export default function LegacyCcPaymentsPanel({ proposalId, currentUserRole }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (currentUserRole !== 'admin' || !proposalId) return;
    setLoading(true);
    api.get(`/proposals/${proposalId}/legacy-cc-payments`)
      .then(r => setPayments(r.data.payments || []))
      .catch(() => setPayments([]))  // 403 for non-admin → empty; OK
      .finally(() => setLoading(false));
  }, [proposalId, currentUserRole]);

  if (currentUserRole !== 'admin') return null;
  if (loading) return null;
  if (payments.length === 0) return null;

  return (
    <section className="legacy-cc-payments-panel">
      <h3>Legacy CC payments (manual Stripe refund required)</h3>
      <p className="muted">
        These payments were imported from Check Cherry. The DRB OS Refund button is disabled for them
        because Stripe charge IDs (<code>ch_...</code>) don't pass to the PaymentIntent-based refund flow.
        To refund, use the Stripe dashboard directly and record a manual <code>proposal_refunds</code> row
        with <code>reason</code> starting with "Manual Stripe reconciliation".
      </p>
      <table>
        <thead><tr><th>Paid on</th><th>Amount</th><th>Method</th><th>Stripe charge ID</th></tr></thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id}>
              <td>{new Date(p.created_at).toLocaleDateString()}</td>
              <td>${(p.amount / 100).toFixed(2)}</td>
              <td>{p.payment_method || '—'}</td>
              <td><code>{p.legacy_charge_id}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 3: Embed in `ProposalDetailPaymentPanel.js` (NOT ProposalDetail.js)**

In `client/src/pages/admin/ProposalDetailPaymentPanel.js`, add the import + render the panel ABOVE the `InvoiceDropdown` (~line 239):

```jsx
import LegacyCcPaymentsPanel from '../../components/admin/LegacyCcPaymentsPanel';
// ...
<LegacyCcPaymentsPanel proposalId={proposal.id} currentUserRole={currentUser.role} />
<InvoiceDropdown ... />
```

EventDetailPage.js also renders `<ProposalDetailPaymentPanel>` so a single edit to the panel covers both pages — no separate edit to EventDetailPage.js needed.

- [ ] **Step 4: Verify file-size impact**

```bash
wc -l client/src/pages/admin/ProposalDetailPaymentPanel.js
```

If the file is near the 700-line soft cap, the LegacyCcPaymentsPanel embed (5 lines + import) is fine. Flag if over.

- [ ] **Step 5: Manual verification**

Log in as admin → open a Bucket B proposal with imported payments → verify panel renders above the InvoiceDropdown. Log in as manager → same proposal → verify panel HIDDEN (component returns null AND endpoint returns 403). Verify EventDetailPage path too.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/admin/LegacyCcPaymentsPanel.js client/src/pages/admin/ProposalDetailPaymentPanel.js server/routes/proposals/crud.js
git commit -m "feat(admin): LegacyCcPaymentsPanel + /legacy-cc-payments endpoint, admin-only"
```

---

## Task 23d: Execution-review-agent cadence

This task does not modify code; it documents the review-cadence checkpoints the implementer should hit during plan execution. Per project memory: "specialized review agents at batch checkpoints matched to what each batch changed."

**Checkpoints (run the named review agents after the listed task lands):**

| After task | Agents to run | Reason |
|---|---|---|
| Task 1 (schema) | `database-review` | new tables, partial-unique indexes, CHECK constraints, FK cascades |
| Tasks 3-5 (payroll guards) | `code-review` + `consistency-check` | money paths; guard must fire on every relevant call site |
| Task 9 (wrap-up handler boot) | `consistency-check` | dispatcher handler enum |
| Task 10 (importer foundation) | `code-review` | load-bearing for all phases; csv/money/date parsing correctness |
| Task 14 (Phase 3 promotion) | `database-review` + `consistency-check` | writes to proposals/shifts/shift_requests — canonical event-data shape |
| Task 15 (Phase 4 payments/refunds) | `database-review` + `security-review` + `consistency-check` | money state, FOR UPDATE locking, status demote correctness |
| Tasks 18-19 (admin pages) | `security-review` + `code-review` | admin auth, IDOR on review actions, stub-email redaction, 12 new endpoints |
| Task 20 (dashboard filter) | `database-review` | 8 metric SQL helpers; math-identity check |
| Tasks 22, 23a-c (UI affordances + cc_id consumers) | `consistency-check` + `code-review` | cross-cutting consistency: cc_id flows through SELECTs to badges |

These checkpoints are **in addition** to the pre-push fleet (which runs all 5 non-UI agents on every code-touching push per CLAUDE.md). The per-task checkpoints catch issues at the earliest revertable point; the pre-push fleet is the safety net.

---

## Task 24: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Update README.md folder tree**

Add under the appropriate sections:
- `scripts/cc-import.js`
- `scripts/cc-import/` (with lib/ + phases/ subtrees enumerated)
- `server/routes/admin/ccImport/` (index.js, wrapUp.js, review.js, search.js, proposalActions.js)
- `server/utils/ccWrapUpHandler.js`, `ccWrapUpEmailTemplate.js`, `payrollGuards.js`
- `client/src/pages/admin/CcImportWrapUpPage.js`, `CcImportReviewPage.js`
- `client/src/components/admin/LegacyCcPaymentsPanel.js`

- [ ] **Step 2: Update README.md NPM scripts table**

Add `cc-import`, `cc-import:phase0` … `cc-import:phase6`, `cc-import:all`.

- [ ] **Step 3: Update README.md Tech Stack list**

Add `csv-parse` to dependencies list.

- [ ] **Step 4: Update ARCHITECTURE.md Database Schema**

Add 6 new tables + 4 new columns (`cc_id` on `clients`/`proposals`/`users`, `legacy_charge_id` + `payment_method` on `proposal_payments`, `notes` + `dismissed_at` on `legacy_cc_payments`, `given_up_at` + `given_up_reason` on `cc_import_phase0_failures`).

- [ ] **Step 5: Update ARCHITECTURE.md API route table**

Add the full route list from spec §15:
- `GET /api/admin/cc-import/wrap-up`
- `POST /api/admin/cc-import/wrap-up/enqueue`
- `GET /api/admin/cc-import/review`
- 12 `POST /api/admin/cc-import/review/...` action endpoints
- `GET /api/admin/cc-import/search/proposals`, `/users`
- `GET /api/admin/cc-import/review/unmatched-payee/:id/link-preview`
- `POST /api/admin/proposals/:id/reenroll-drink-plan-nudge`
- `POST /api/admin/proposals/:id/reaccrue-payout`
- `GET /api/admin/users/:id/stub-co-participated-proposals`

- [ ] **Step 6: Update ARCHITECTURE.md Dispatcher handler list**

Add `post_event_wrap_up_email` to the handler enum + description.

- [ ] **Step 7: Update ARCHITECTURE.md Behavior changes section**

Document:
- `scheduleDrinkPlanNudge` early-returns when no `drink_plans` row exists.
- `createDrinkPlan` post-insert calls `scheduleDrinkPlanNudge` (best-effort, outside transaction).
- `accruePayoutsForProposal` skips when any participating user has `cc_id LIKE 'legacy_cc:%'`.
- `rollForwardLateTip` + `clawbackTip` skip when tip target has `cc_id LIKE 'legacy_cc:%'`.
- All three return `{ skipped: true, reason }` for UI surfacing.

- [ ] **Step 8: Add `cc_id` "Imported from CC" badges across admin pages (spec §6.7) — SEPARATE COMMIT**

Each admin page listed in spec §6.7 client section needs an "Imported from CC" badge next to the title when `proposal.cc_id` or `client.cc_id` is non-null. Create a shared component `client/src/components/admin/CcImportBadge.js`:

```jsx
export default function CcImportBadge({ ccId }) {
  if (!ccId) return null;
  return <span className="badge badge-cc-import" title={`CC id: ${ccId}`}>Imported from CC</span>;
}
```

Render it next to the title on: `ProposalsDashboard.js`, `ProposalDetail.js`, `ProposalDetailEditForm.js` (per spec §6.7 — read-only on `cc_id`, badge only), `EventDetailPage.js`, `ClientsDashboard.js`, `ClientDetail.js`, `FinancialsDashboard.js`. The public `ClientDashboard.js` does NOT render the badge (spec §6.7) but its SELECT change is already covered in Task 23a.

Commit this work SEPARATELY from the docs commit (different commit type):

```bash
git add client/src/components/admin/CcImportBadge.js client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ProposalDetail.js client/src/pages/admin/ProposalDetailEditForm.js client/src/pages/admin/EventDetailPage.js client/src/pages/admin/ClientsDashboard.js client/src/pages/admin/ClientDetail.js client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(admin): cc_id badges across admin lists/details per spec §6.7"
```

- [ ] **Step 9: Commit docs**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: cc-import schema + routes + dispatcher handler + behavior changes"
```

---

## Self-Review

Spec coverage check (rev 11 of `docs/superpowers/specs/2026-05-25-checkcherry-import-design.md`):

| Spec section | Plan task(s) |
|---|---|
| §1 Overview / §2 Goals | Plan header |
| §3 Scope | File Structure section + Tasks 1-24 |
| §4 Data inventory | Task 10 (CSV parser fixture) + manual verification in Tasks 11-17 |
| §5 Buckets + §5.1 Skip rule | Task 10 (`lib/buckets.js`), Task 14 (Bucket A/B/C/D handling), Task 19 (skipped section #6) |
| §6.1–§6.5 New tables | Task 1 |
| §6.6 cc_id + legacy_charge_id + payment_method columns | Task 1 |
| §6.7 cc_id consumer enumeration — server SELECTs | Task 23a |
| §6.7 cc_id consumer enumeration — client badges | Task 24 step 8 |
| §7.1 Client dedup | Task 13 |
| §7.2 Bucket A duplicate-review | Task 14 step 4 |
| §7.3 Staff dedup + stub creation | Task 12 |
| §7.3 + §15 admin-staff-list "Legacy CC stub" badge | Task 23b |
| §11 + §15 "Legacy CC payments" panel + admin-only gating | Task 23c |
| §8 Import phases | Tasks 11–17 |
| §8.3 Bucket A/B promotion shape | Task 14 (proposals + shifts INSERTs + auto-comms) |
| §8.4 Payments + refunds with row lock + status demote | Task 15 |
| §8.5 Phase 5 with re-run guard | Task 16 |
| §8.6 Phase 6 leads + invoices | Task 17 |
| §9.1 Wrap-up page + enqueue endpoint | Task 18 |
| §9.2 Review page + 7 sections + action endpoints | Task 19 |
| §9.3.A Bucket B no-suppression-needed | Documented inline in Task 14 |
| §9.3.B Wrap-up handler registration | Task 9 |
| §9.3.C Wrap-up email template | Task 9 |
| §9.3.D scheduleDrinkPlanNudge early-return + re-enroll path | Tasks 2, 6, 21 |
| §9.3.E Payroll legacy-stub guards + re-trigger | Tasks 3, 4, 5, 19 (link action), 22 |
| §9.3.F SKIP_REANCHOR_TYPES | Task 8 |
| §10 Idempotency | Distributed across each phase task; assertions in tests |
| §11 Error handling | Phase tasks + Task 19 (Phase 0 give-up UI) |
| §12 Accepted losses | Documented in spec; Task 24 step 7 captures in ARCHITECTURE |
| §13 Financial dashboard filter | Task 20 |
| §14 Sunset criteria | Operator-side post-implementation; spec is the runbook |
| §15 Mandatory documentation updates | Task 24 |
| Execution-review-agent cadence (project memory) | Task 23d |

**No spec section is unmapped.**

Placeholder scan: spec-side decisions are explicit. Task 19's 12 action endpoints are sketched-with-load-bearing-bodies; the remaining 5 (`/duplicate/.../promote`, `/orphan-payment/.../link`, `/unmatched-payee/.../create-stub`, `/errored-row/.../retry`, `/skipped-event/.../promote`) call the named phase helpers `promoteBucketA` / `promoteBucketB` / `promoteSingleLegacyPayment` / `promoteSingleLegacyRefund` exported by Tasks 14 step 12 and 15 step 9 — implementer threads them.

Type consistency: function names match across tasks — `isLegacyCcParticipant`, `isLegacyCcStubUser`, `scheduleDrinkPlanNudge`, `accruePayoutsForProposal`, `rollForwardLateTip`, `clawbackTip`, `registerCcWrapUpHandler`, `renderCcWrapUpEmail`, `promoteBucketA`, `promoteBucketB`, `promoteSingleLegacyPayment`, `promoteSingleLegacyRefund`. Endpoint paths match across review.js (Task 19), proposalActions.js (Task 21), search.js (Task 19), and the ARCHITECTURE route table (Task 24 step 5).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-26-checkcherry-import.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
