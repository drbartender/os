# Lab Rat Tune-Up — Design Spec

**Date:** 2026-05-14
**Status:** Approved design. Implementation plan to follow.
**Replaces:** Nothing — this is a maintenance pass on the existing Lab Rat program from `docs/superpowers/specs/2026-04-27-tester-program-v2-design.md`.

## Problem

The Lab Rat tester program has been running since 2026-04-27 and has accumulated drift:

- **Mission-completion stats are still on Render's ephemeral disk.** `server/utils/missionStats.js` appends to `server/data/mission-completions.jsonl`. Every deploy wipes the file, so the shortlist algorithm forgets its coverage history. The bug log already moved to Postgres (`b276d2e`, 2026-05-10); completion stats didn't get the same treatment.
- **The API defends fields the UI never sends.** `BugDialog.js` collects only `happened` and `expected`, but `testFeedback.js` validates and stores `testerEmail` (with CRLF rejection) and `screenshotUrl` (with http(s) check + optional `LABRAT_SCREENSHOT_ALLOWED_HOSTS` allowlist). The admin viewer also renders them. Triage happens via the admin UI + Claude session — the email path is audit-only and unread, so the security hardening defends an attack surface that doesn't exist.
- **No mission covers the new pre-hire onboarding flow.** `/onboarding` and `POST /api/auth/claim-pre-hire` shipped 2026-05-13 (see `docs/superpowers/specs/2026-05-13-pre-hire-onboarding-design.md`). Zero coverage. The downstream Welcome → Field Guide → … → Complete paperwork flow has never had a Lab Rat mission either.
- **Catalog drift is plausible.** The catalog was written 2026-04-27. Step copy that references step numbers, admin credentials, or URLs may have rotted as the product evolved.
- **`@labrat.test` test data has been accumulating** since launch and has never been cleaned up.
- **Test coverage on `shortlist.js` has gaps** — the existing `shortlist.test.js` covers tier graduation, bug saturation, device filter, admin-comfort filter, and within-tier sorting, but misses time-budget relaxation, the hard-filter rejection on time-budget overrun, wrong-area filter, and completed-mission filter.

## Goals

1. Mission completions persist across deploys, so the shortlist algorithm has stable coverage history.
2. The API contract matches the UI: no unused fields, no dead security plumbing.
3. The pre-hire onboarding flow has at least one Lab Rat mission.
4. Existing missions reflect current product state.
5. Test data accumulated since launch is purged.
6. `shortlist.js` has unit tests so future edits don't silently break tier selection.

## Non-goals

- Phase 2 tooling from the original Lab Rat plan: `bugs:fix`, `missions:check`, `missions:verify`, `affectedFiles` metadata, `is_test_data` schema column, automated cleanup scheduler. Still deferred; separate plan if ever needed.
- New coverage missions for blog admin, hiring dashboard, client portal, staff tip-page, email marketing. Out of scope to keep this plan focused.
- BugDialog redesign or visual changes.
- Any change to rate limiters, CSP, or other security middleware.

## Architecture

Four logical commits on `main`, one push, one agent-review pass. The work splits cleanly along these axes:

1. **Persistence migration** — mirror the `tester_bugs` → Postgres playbook for `mission_completions`.
2. **API cleanup** — delete `testerEmail` + `screenshotUrl` end-to-end.
3. **Catalog refresh** — pre-hire onboarding missions + sweep existing missions for drift.
4. **Test backfill** — `shortlist.test.js` + Postgres-backed `missionStats.test.js` + `bugLog.test.js`.

Each commit carries its own doc updates (per CLAUDE.md's "Mandatory Documentation Updates" rule) — schema changes update ARCHITECTURE.md in the same commit; env-var removal updates CLAUDE.md in the same commit.

Out-of-band: one-off SQL cleanup of `@labrat.test` test data, run by Dallas after the push deploys.

## Section 1 — `mission_completions` Postgres migration

### Schema (`server/db/schema.sql`)

Appended at the bottom, parallel to the `tester_bugs` block:

```sql
-- ─── Lab Rat mission completion log (Postgres-persistent, 2026-05-14) ──
-- Replaces the prior filesystem JSONL store at
-- server/data/mission-completions.jsonl which was wiped on every Render
-- deploy. Same fix as tester_bugs (2026-05-10). The shortlist algorithm
-- in server/utils/shortlist.js reads from here to detect p0 saturation
-- and to favor least-completed missions when sorting within a tier.
CREATE TABLE IF NOT EXISTS mission_completions (
  id BIGSERIAL PRIMARY KEY,
  mission_id TEXT NOT NULL,
  tester_name TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mission_completions_mission_id
  ON mission_completions(mission_id);
```

Per-completion rows (not an aggregate counter) for parity with `tester_bugs` and to keep "who tested what when" available for later analytics. Storage cost is negligible — at projected tester volume the table tops out in the low thousands of rows per year.

### `server/utils/missionStats.js`

Both public functions keep their signatures (callers in `server/routes/labrat.js` don't change):

```js
const { pool } = require('../db');

async function logCompletion(missionId, testerName) {
  await pool.query(
    'INSERT INTO mission_completions (mission_id, tester_name) VALUES ($1, $2)',
    [missionId, testerName || null],
  );
}

async function getCompletionCounts() {
  const { rows } = await pool.query(
    'SELECT mission_id, COUNT(*)::int AS count FROM mission_completions GROUP BY mission_id',
  );
  const counts = {};
  for (const r of rows) counts[r.mission_id] = r.count;
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };
```

The `LABRAT_COMPLETIONS_FILE` env-var indirection goes away. Existing `missionStats.test.js` is rewritten in the same commit (TDD pairing) using a `test-` prefix on mission ids plus a `beforeEach` cleanup of those rows — no transactional isolation needed since no other tests touch `mission_completions`.

Updated `missionStats.test.js` covers:
- Counts completions per mission id after multiple logs.
- Returns empty object (modulo `test-` rows) when no rows.
- `tester_name` null and non-null both stored correctly.

### `.gitignore`

Remove the two lines that gitignore the runtime JSONL:

```
# Lab Rat runtime data — mission completions are still filesystem-based
# (tester bugs moved to the `tester_bugs` Postgres table 2026-05-10).
server/data/mission-completions.jsonl
```

The local file at `server/data/mission-completions.jsonl` is deleted after the migration (not migrated — the data is dev-only and amounts to one row).

### `ARCHITECTURE.md`

Add a new `mission_completions` table section parallel in style to the existing `tester_bugs` block:

```markdown
**mission_completions** — Lab Rat mission completion log (replaces the prior filesystem JSONL store, which was wiped on every Render deploy)
- `id` BIGSERIAL PK
- `mission_id` TEXT NOT NULL
- `tester_name` TEXT — optional
- `completed_at` TIMESTAMPTZ DEFAULT NOW()
- Index `idx_mission_completions_mission_id` supports the shortlist's `GROUP BY mission_id COUNT(*)` aggregation
- Insert path: `POST /api/qa/complete` → `missionStats.logCompletion` → INSERT
- Read path: `POST /api/qa/shortlist` → `missionStats.getCompletionCounts`
```

## Section 2 — Drop unused fields

### Schema

Two idempotent ALTERs appended to `server/db/schema.sql` after the `tester_bugs` block:

```sql
-- ─── Lab Rat tester_bugs: drop unused contact fields (2026-05-14) ──
-- The BugDialog UI never collected tester_email or screenshot_url; the
-- backend validation and admin-viewer rendering were defending an unused
-- attack surface. Confirmed empty before drop. Triage workflow is admin
-- UI + Claude session, not email reply.
ALTER TABLE tester_bugs DROP COLUMN IF EXISTS tester_email;
ALTER TABLE tester_bugs DROP COLUMN IF EXISTS screenshot_url;
```

The drops are safe: no code path ever populated those columns in production (`BugDialog.js` never sends them; the legacy `/testing-guide.html` shim doesn't either). Implementation verifies emptiness via `SELECT COUNT(*) FROM tester_bugs WHERE tester_email IS NOT NULL OR screenshot_url IS NOT NULL` before issuing the DROPs.

### Backend deletions

**`server/routes/testFeedback.js`** — remove:
- `screenshotUrl` and `testerEmail` from the body destructure.
- `EMAIL_RE`, the `safeReplyTo` block, the email-format validation branch.
- The entire screenshot URL validation (scheme check + `getScreenshotHostAllowlist`).
- The `replyTo: safeReplyTo` arg on the `sendEmail` call.
- The `screenshotUrl: safeScreenshotUrl` field passed to `appendBug` and the email template.

Net deletion ≈ 50 lines. The function shrinks to: validate `kind` + `happened`, call `appendBug`, fire-and-forget email.

**`server/utils/bugLog.js`** — remove `tester_email` and `screenshot_url` from the INSERT column list, value array, `rowToBug` projection, and `appendBug` input handling. `clip(input.testerEmail, 200)` and `clip(input.screenshotUrl, 1000)` lines deleted.

**`server/utils/emailTemplates.js`** — `labratBugReportAdmin` drops both fields from its parameter list, HTML body, and text body.

### Frontend deletions

**`client/src/pages/admin/LabRatBugsPage.js`** — remove the screenshot URL render block (around lines 182–187) and the tester-email mailto block (around lines 188–192).

**`client/src/pages/labrat/BugDialog.js`** — no changes (these fields were never present in the UI).

### Docs

**`CLAUDE.md`** — remove the `LABRAT_SCREENSHOT_ALLOWED_HOSTS` row from the Environment Variables table.

**`ARCHITECTURE.md`** — in the `tester_bugs` section, drop the `tester_email` and `screenshot_url` bullets and update the "captured form fields" line.

## Section 3 — Mission catalog refresh

### New seed recipe: `pre-hire-invitation`

Added to `server/utils/qaSeed.js`:

```js
const bcrypt = require('bcryptjs');

async function recipePreHireInvitation(client) {
  const email = fakeEmail();
  const plaintext = 'LabRat-' + crypto.randomBytes(4).toString('hex');
  const passwordHash = await bcrypt.hash(plaintext, 10);
  const u = await client.query(
    `INSERT INTO users (email, password, name, role, onboarding_status)
     VALUES ($1, $2, $3, 'staff', 'applied')
     RETURNING id`,
    [email, passwordHash, fakeName()],
  );
  return {
    userId: u.rows[0].id,
    testerEmail: email,
    testerPassword: plaintext,
    onboardingUrl: '/onboarding',
  };
}

const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
  'pre-hire-invitation': recipePreHireInvitation,
};
```

The `'applied'` value for `onboarding_status` is the assumption to verify at implementation time — `POST /api/auth/claim-pre-hire` promotes `'applied'` → `'hired'`. If the project uses a different pending-state value (e.g., `'pre_hired'`), the recipe and missions adjust to match.

**`server/data/missions/_shape.js`** — add `'pre-hire-invitation'` to `VALID_SEED_RECIPES`.

**Seed cleanup pattern.** The seeded user follows the existing `@labrat.test` email convention so the one-off cleanup in Section 5 sweeps it. No new cleanup pattern introduced.

**Mission UI gap.** Today's `LabRatMission.js` setup block only renders `seedResult.proposalUrl`. The new recipe returns `testerEmail` + `testerPassword` + `onboardingUrl`. The setup section grows a small generic renderer: if `proposalUrl` present → render today's "Open the test proposal →" link; if `testerEmail` + `testerPassword` present → render a credentials block with copy buttons for each. Two conditional blocks, no schema for recipe results.

### New missions (in `server/data/missions/applicant.js`)

**Mission 1 — `claim-pre-hire-invitation` (priority p1, ~6 min, applicant area)**

Steps:
1. Setup: tester sees seeded email + password.
2. Open hiring.drbartender.com in a private/incognito window.
3. Log in with the seeded credentials.
4. Visit `/onboarding`.
5. Confirm the page shows a "welcome / invitation accepted" state (exact copy verified during catalog drift sweep against current `PreHireOnboarding.js`).
6. Verify redirect to `/welcome` or wherever the onboarding flow begins.

**Mission 2 — `complete-onboarding-paperwork` (priority p1, ~15 min, applicant area)**

Uses the same `pre-hire-invitation` seed; can be done in sequence on one account.

Steps:
1. Setup: seeded credentials (same recipe).
2. Log in.
3. Walk Welcome → Field Guide → Agreement (digital signature) → Contractor Profile (bank/tax info — note: bank fields can be fake) → Payday Protocols → Complete.
4. Verify the "Onboarding Complete" final state.
5. Spot-check that each step's "Continue" / "Back" navigation works.

First-ever Lab Rat coverage of the onboarding paperwork flow.

### Catalog drift sweep

For each of the 20 existing missions, verify:
- All URLs match current routing (no `/admin/*` prefixes since URL cleanup `f13ef5c`).
- Step numbering references match current wizard step counts (specifically `submit-byob-quote` step 6's "Step 4 / Step 3 hosted-only" claim against current `QuotePage`).
- Hardcoded credentials in `staff-portal-tour` are valid (`admin@drbartender.com / DrBartender2024!` — verify or rewrite to "use any admin you know").
- Expected-state copy matches current UI strings where mission text quotes specific UI ("Application Received", "Paid in Full", etc.).
- Any references to features that have shifted (`event_type` vs the older `event_name` legacy, hosted-package gating, addon categories).

Fix in-place; this is mission-file edits only.

## Section 4 — Tests

### Extended: `server/utils/shortlist.test.js`

The file already exists with 8 tests covering p0/p1 graduation, bug saturation, device + admin-comfort filters, and within-tier completion-count sort. Add the missing cases:

- Hard filter — wrong area excluded.
- Hard filter — mission exceeding `timeBudget` excluded.
- Hard filter — completed mission excluded (by id).
- Time-budget relaxation fires only when widening yields new in-tier candidates (e.g., tester budget 10, p0 missions take 12 — relaxation to 15 surfaces them; result.relaxed === true).
- Time-budget relaxation does NOT abandon the chosen tier when widening adds only out-of-tier missions.

Pure-function tests, no Postgres needed.

### New: `server/utils/bugLog.test.js`

Round-trip coverage:
- `appendBug` inserts; `readAllBugs({ status: 'open' })` returns it.
- `setBugStatus` flips `open` → `fixed`, bumps `status_updated_at`.
- `readAllBugs` respects `missionId` filter.
- `openBugCountByMission` returns `{ missionId: count }` map.
- Invalid kind / invalid status throws.

Catches regressions on the column drop and any future schema changes.

## Section 5 — One-off SQL cleanup (out of band)

Run by Dallas after the push deploys cleanly. Inspection first to size the cleanup, then transactional cascade:

```sql
BEGIN;

-- Inspect
SELECT COUNT(*) FROM clients WHERE email LIKE '%@labrat.test';
SELECT COUNT(*) FROM users   WHERE email LIKE '%@labrat.test';

-- Cascade through proposals and any dependents before clients/users.
-- The implementation plan will enumerate any other tables with FKs to
-- clients(id) or users(id) by reading schema.sql at write time, so the
-- DELETE list is exhaustive.
DELETE FROM proposals WHERE client_id IN
  (SELECT id FROM clients WHERE email LIKE '%@labrat.test');
DELETE FROM clients WHERE email LIKE '%@labrat.test';
DELETE FROM users   WHERE email LIKE '%@labrat.test';

COMMIT;
```

Not part of any commit — operational task. The implementation plan will produce the exact DELETE list keyed to current schema FKs.

## Commit order

| # | Type | Scope | Files |
|---|------|-------|-------|
| 1 | feat | `mission_completions` Postgres migration | `schema.sql`, `missionStats.js`, `.gitignore`, `ARCHITECTURE.md` |
| 2 | refactor | Drop unused `testerEmail` + `screenshotUrl` | `schema.sql`, `testFeedback.js`, `bugLog.js`, `emailTemplates.js`, `LabRatBugsPage.js`, `CLAUDE.md`, `ARCHITECTURE.md` |
| 3 | feat | Pre-hire missions + catalog drift sweep | `qaSeed.js`, `_shape.js`, `applicant.js` (+ any drifted catalog files), `LabRatMission.js` (setup renderer) |
| 4 | test | Shortlist gap-filling + bugLog tests | `shortlist.test.js` (extended), `bugLog.test.js` (new) |

One push at the end. All five agents (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`) run once over the batch per Pre-Push Procedure step 5.

## Testing plan

Before push:
- `npm test` passes (catalog validation, extended shortlist tests, new bugLog tests, updated missionStats tests).
- Local smoke: hit `POST /api/qa/seed` with `recipe: 'pre-hire-invitation'` and confirm the response shape.
- Local smoke: complete a mission, restart the server, verify `getCompletionCounts()` still returns the count (proves Postgres persistence).
- Local smoke: post a bug via `BugDialog`, view it in `/labrat-bugs`, mark fixed.

After push (manual on prod):
- One real tester run-through of either new pre-hire mission, to confirm the seed + credentials + claim flow works end-to-end.
- `npm run bugs:list` against prod confirms the bug-list still renders without the dropped columns.
- Run the Section 5 cleanup SQL.

## Open implementation details

- **Exact `onboarding_status` value** the seed inserts — likely `'applied'`, confirmed by inspecting `POST /api/auth/claim-pre-hire`'s promotion logic at implementation time.
- **Postgres test isolation pattern** for `bugLog.test.js` — `missionStats.test.js` uses a `test-` prefix on mission_id with cleanup in `beforeEach`. For `bugLog.test.js`, do the same: prefix `id` with `test-` and clean up.
- **Exhaustive FK list** for the @labrat.test cleanup — produced at plan-writing time by grepping `REFERENCES clients` and `REFERENCES users` in `schema.sql`.
- **Drift sweep findings** — the catalog spot-check happens during implementation; specific edits land in commit 3 alongside the new missions.
