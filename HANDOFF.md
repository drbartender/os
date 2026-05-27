# Check Cherry → DRB OS Import — Mid-Execution Handoff

**Created:** 2026-05-27
**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\cc-import` on branch `cc-import`
**Resume:** Open a fresh Claude Code session in this worktree, then say: *"Resume the cc-import work per HANDOFF.md."*

---

## What this is

Mid-execution handoff for the Check Cherry → DRB OS one-time data import. Plan is being executed via `superpowers:subagent-driven-development`, with the user's batch cadence (17 review checkpoints across 28 tasks). 12 of 17 checkpoints complete, 5 to go.

## Source-of-truth files

- **Spec:** `docs/superpowers/specs/2026-05-25-checkcherry-import-design.md` (revision 11; cleared by 10 /review-spec cycles)
- **Plan:** `docs/superpowers/plans/2026-05-26-checkcherry-import.md` (revision 3; cleared by 2 /review-plan cycles)
- Both files are committed-untracked artifacts (visible in `git status` as `??`) but the work is anchored to them.

## Repo state at handoff

- Branch: `cc-import`
- 18 commits ahead of where the session started (top of stack: `f69fd6f feat(admin): CC Import wrap-up page (worklist + preview + enqueue endpoints)`)
- Working tree: clean except the two untracked spec/plan markdown files
- `node_modules` in this worktree is a real directory (was originally a junction; `npm install csv-parse` during Batch 2 regenerated it as real). Doesn't affect runtime; restore via `worktree:new` rebuild post-merge if you want junction isolation back.

## Batches completed (12)

| Batch | Tasks | Commit(s) | Notes |
|---|---|---|---|
| 1a | 1 | `58dbcc8` | Schema: 6 new tables + cc_id columns + 5 columns on existing |
| 1b | 2, 6, 7, 8 | `86add11`, `af73b0a`, `30cb523`, `c6608f9`, `e20e434` | Comms behavior changes + null-guard fix-up |
| 1c | 3, 4, 5 | `21d0b29`, `6205afe`, `f9af78a` | Payroll guards (money-path) |
| 1d | 9 | `effaa2e` | Wrap-up handler + boot reg |
| 2 | 10 | `ce970c6` | Importer foundation libs |
| 3 | 11 | `3e27913` | Phase 0 file downloads + SSRF safety |
| 4 | 12 | `3e55152` | Phase 1 staff users + encryption + stubs |
| 5a | 13 | `7c08e04` | Phase 2 clients dedup |
| 5b | 14 + Phase 2 backport | `91d1889`, `b918191`, `6da2f7d` | Phase 3 promotion + re-run-enroll fix-up |
| 6 | 15 | `de42084`, `b398e45` | Phase 4 payments/refunds (Approach A) + paid_on edge fix |
| 7 | 16, 17 | `df77b54`, `4a7d1e3` | Phases 5 + 6 (payouts + archives) |
| 8 | 18 | `f69fd6f` | Wrap-up admin page |

Every batch has full review coverage (implementer + spec-compliance + code-quality, or combined-review equivalent). The three fix-up commits (`e20e434`, `6da2f7d`, `b398e45`) were retroactively re-reviewed at end-of-session — all verified ✅ Ready.

## Batches remaining (5)

| Batch | Tasks | Scope |
|---|---|---|
| **9 (next)** | 19 | Review admin page — 7 collapsible sections + 11 action endpoints + 3 picker endpoints + React page. LARGEST UI batch. |
| 10 | 20 | Financial dashboard `?include_cc=` filter chip |
| 11 | 21, 22 | Re-trigger endpoints (`/reenroll-drink-plan-nudge`, `/reaccrue-payout`) + EventDetailPage button + UserDetail "Re-accrue payouts" button |
| 12 | 23a | `cc_id` SELECT additions across 8 server files (cross-cutting consistency) |
| 13a | 23b, 23c | Admin staff "Legacy CC stub" badge + LegacyCcPaymentsPanel (+ `/legacy-cc-payments` endpoint) |
| 13b | 23d, 24 | Review-cadence doc + README/ARCHITECTURE + `cc_id` badges across admin pages |

## Global Conventions (apply to every implementer dispatch — paste into prompts)

1. **Test framework: `node:test` + `node:assert/strict`** (NOT Jest). Scaffolding:
   ```js
   const { test, before, after } = require('node:test');
   const assert = require('node:assert/strict');
   const { pool } = require('../db');
   after(async () => { await pool.end(); });
   ```
2. **`asyncHandler` is a default export** (`server/middleware/asyncHandler.js`): `const asyncHandler = require('../../middleware/asyncHandler');` — NEVER destructured.
3. **`ValidationError` constructor is `(fieldErrors, message)`** (per `server/utils/errors.js:11`): `new ValidationError(undefined, 'human msg')`. NEVER `new ValidationError('string')`.
4. **`Sentry` import required** in every new route file that calls `Sentry.captureException`: `const Sentry = require('@sentry/node');` at top.
5. **React route guard is `<ProtectedRoute adminOnly>`** (per `client/src/App.js:170,174` — accepts both admin and manager). NEVER `<RequireAdminOrManager>` (not a component).
6. **Errors imports**: import all three even if not all used: `const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');`
7. **Per-phase Sentry summary** (spec §11): each importer phase emits ONE summary `Sentry.captureMessage` at end (NOT per-row exceptions for data-quality misses):
   ```js
   Sentry.captureMessage(`cc-import phase ${phase} summary`, {
     level: erroredCount > 0 ? 'warning' : 'info',
     extra: { phase, rowsProcessed, errored_count, samples: samples.slice(0, 5) },
   });
   ```
   Genuine infra failures (DB lost, R2 5xx) still get per-incident `captureException`.
8. **`CC_DIR` env var** points at the canonical CC CSVs (default `'C:\\Users\\dalla\\Downloads'`). The CLI reads this; phases use `path.join(CC_DIR, 'report (N).csv')`.
9. **`admin_audit_log.target_user_id` FK is to `users(id)`**, NOT `clients(id)`. For client-targeted actions, pass `targetUserId: null` and put `client_id` inside `metadata`.

## Tests + dev-env notes

- **Tests run with `--env-file`:** `node --test --env-file=C:/Users/dalla/DRB_OS/os/.env <file>`. The cc-import worktree has no `.env`; we point at the `os/` copy. Bare `node --test <file>` errors with SASL/pg-password issues.
- **Dev server** is a Claude-managed background process per project memory. After server-code edits, restart via killing port 5000 and `npm run dev`. If you can't restart it yourself, ask the user.
- **Pre-commit hook** runs `node scripts/check-file-size.js --staged` on `server/**/*.js` and `client/src/**/*.{js,jsx}` only. `scripts/cc-import/**` is exempt — `phase4.js` is currently 1039 lines (over the 1000 hard cap) but the hook doesn't fire.
- **Commits:** plain `git commit -m "single line"` — no heredoc, no co-author footer (per CLAUDE.md commit-cue rule). Per-task commits within a batch are fine; one commit per "logical feature" is the discipline.
- **No pushes** without explicit user direction. The user batches push timing across multiple terminals.

## Batch dispatch pattern (the cadence that's been working)

**Per batch:**
1. Mark batch in_progress via TaskUpdate
2. Dispatch ONE implementer (general-purpose subagent) with full inline plan/spec content + Global Conventions reminders + acceptance criteria + self-review checklist
3. Implementer makes 1-N commits within the batch (one per logical task)
4. Verify state via `git log --oneline -N` + `git diff --stat HEAD~N HEAD`
5. Dispatch ONE combined spec+code reviewer (or separate two-stage for sensitive batches) with: requirements summary + implementer's claims + "DO NOT TRUST THE REPORT — verify by reading the actual commits" instruction
6. If reviewer flags Important findings worth fixing now, dispatch a small fix-up implementer; if not, fold into a future batch or close as scope debt
7. Mark batch completed; mark next batch in_progress; repeat

**Combined-review template hits these lenses:** spec compliance, code quality, plus security/PII/money-path/auth as relevant to the batch's surface area.

**Tightness on the reviewer prompt matters:** spell out every spec checkpoint as a numbered question. Reviewers verify by reading commits + running tests, NOT by trusting the implementer's report.

## Carry-over items (fold somewhere appropriate)

1. **Spec §8.4 step 2 ratification (Phase 4 matching).** Spec says match payments by `(client.email, event_date, total_price)`. Actual CC `report (11).csv` has no email column. Implementer matches by `(event_date, total_price)` with deterministic tiebreak. Orphans surface on Review page via `/orphan-payment/.../link`. **Fold:** update spec §8.4 step 2 in Batch 13b's docs sweep to reflect actual matching + add a sunset-gate note that operators should manually verify same-date+same-total events. Code is fine; only the spec text needs to match reality.

2. **`legacy_cc_raw_imports.payload` stores raw bank PII as plaintext JSON.** Wix payment_info rows land verbatim. The cleartext bank numbers in that audit table are accessible to anyone with admin DB read. Mitigations possible: redact `Routing Number` / `Account Number` from payload before insert (keep hash for re-runnability), OR add retention/access policy. Not in plan scope; **flag for separate scope decision** before sunset.

3. **Pre-existing test failure `disp_test_shift_archived`** in `server/utils/scheduledMessageDispatcher.test.js`: `lookupEntity` SELECTs `shifts.archived_at` but the column doesn't exist in `schema.sql`. Unrelated to cc-import; predates this branch. **Flag:** triage separately when convenient; don't bundle into cc-import.

4. **`phase4.js` at 1039 lines** (over 1000 hard cap) — exempt from file-size hook because `scripts/cc-import/**` isn't in the hook's scope. Natural extraction seams: `mapPaymentMethod`, `parseLegacyPaymentRow`, `computePaymentType` could move to `scripts/cc-import/lib/payments.js`. **Defer** unless the hook scope changes.

5. **Phase 1 `legacy_cc_raw_imports.import_status`** isn't marked 'promoted' for successful Phase 5 rows (the archive itself IS the presence of `legacy_cc_payouts` row). Review-page Section 9.2 §3 queries `legacy_cc_payouts.payee_user_id IS NULL` directly, which works correctly. **No action needed** — flagged for awareness only.

## Task list state (TaskCreate IDs in current session)

The TaskList from the prior session won't persist into the new window. Re-create with TaskCreate at the start:

```
1. [completed] Batch 1a — Schema migrations
2. [completed] Batch 1b — Comms behavior changes (Tasks 2, 6, 7, 8)
3. [completed] Batch 1c — Payroll guards (Tasks 3, 4, 5)
4. [completed] Batch 1d — Wrap-up handler + boot reg (Task 9)
5. [completed] Batch 2 — Importer foundation libs (Task 10)
6. [completed] Batch 3 — Phase 0 (Task 11)
7. [completed] Batch 4 — Phase 1 (Task 12)
8. [completed] Batch 5a — Phase 2 (Task 13)
9. [completed] Batch 5b — Phase 3 (Task 14)
10. [completed] Batch 6 — Phase 4 (Task 15)
11. [completed] Batch 7 — Phases 5+6 (Tasks 16, 17)
12. [completed] Batch 8 — Wrap-up admin page (Task 18)
13. [in_progress] Batch 9 — Review admin page (Task 19)
14. [pending] Batch 10 — Dashboard filter chip (Task 20)
15. [pending] Batch 11 — Re-trigger endpoints + UI (Tasks 21, 22)
16. [pending] Batch 12 — cc_id consumer additions (Task 23a)
17. [pending] Batch 13a — UI affordances (Tasks 23b, 23c)
18. [pending] Batch 13b — Docs (Tasks 23d, 24)
```

## Batch 9 quickstart (NEXT)

**Plan reference:** `docs/superpowers/plans/2026-05-26-checkcherry-import.md` Task 19.

**Surface:**
- `server/routes/admin/ccImport/search.js` — 3 picker endpoints: `GET /search/proposals`, `GET /search/users` (with `include_stubs` requiring admin role + stub email redaction for managers), `GET /review/unmatched-payee/:id/link-preview`
- `server/routes/admin/ccImport/review.js` — `GET /review` (returns 7 sections in one shot) + 11 action endpoints: confirm-duplicate, promote-duplicate, orphan-link, orphan-dismiss, unmatched-payee-link (BIG — does shift_requests dedup + audit + post-COMMIT auto-reaccrue per spec §9.3.E), unmatched-payee-create-stub, errored-retry (with `payload_override`), skipped-promote, phase0-accept-loss, phase0-revert-give-up
- `server/routes/admin/ccImport/review.test.js` + `search.test.js`
- `client/src/pages/admin/CcImportReviewPage.js` — React page with 7 collapsible sections, 300ms-debounced pickers
- Modify `server/routes/admin/ccImport/index.js` to mount the new sub-routers
- Modify `client/src/App.js` to add `/admin/cc-import/review` route (inside the existing `<ProtectedRoute adminOnly><AdminLayout />` shell — DON'T re-wrap, see Batch 8's adaptation note)

**Big trap to avoid:** the `/unmatched-payee/:legacy_payout_id/link` endpoint must do the spec §9.3.E DELETE 1a + 1b ordering correctly:
- **1a:** DELETE now-real user's `'pending'`/`'denied'` rows where stub has `'approved'` on the same shift (preserves money path — stub's approved record wins)
- **1b:** DELETE stub's rows where now-real user is ALREADY `'approved'` on the same shift (true duplicate)
- **2:** UPDATE shift_requests SET user_id = $now_real WHERE user_id = $stub (reassigns remaining)
- Audit each affected proposal: `INSERT INTO proposal_activity_log ... 'cc_link_shift_request_dedup' ...`
- **POST-COMMIT** auto-reaccrue: for each inherited proposal_id, call `accruePayoutsForProposal` on a separate connection (best-effort, Sentry per failure)

**Available helpers exported from prior batches:**
- `scripts/cc-import/phases/phase3.js` → `promoteBucketA`, `promoteBucketB` (callable externally for `/duplicate/.../promote`)
- `scripts/cc-import/phases/phase4.js` → `promoteSingleLegacyPayment`, `promoteSingleLegacyRefund` (callable externally for `/orphan-payment/.../link`)
- `scripts/cc-import/lib/fuzzyName.js` → `buildStubCcId` (for `/unmatched-payee/.../create-stub`)
- `server/utils/payrollAccrual.js` → `accruePayoutsForProposal` (returns structured `{ skipped, reason?, accrued? }`)
- `server/utils/adminAuditLog.js` → `logAdminAction({ actorUserId, targetUserId, action, metadata })`

**Expected size:** ~700-1000 lines of new server code + ~400-600 lines React + ~300-500 lines tests. Likely will need a single LARGE implementer dispatch followed by careful review.

---

**End of handoff.** Resume in fresh window with: *"Resume the cc-import work per HANDOFF.md. Launch Batch 9 (Review admin page)."*
