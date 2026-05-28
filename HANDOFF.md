# Staff Portal + BEO — Mid-Execution Handoff

**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\beo`
**Branch:** `beo`
**Last commit:** `c23a294 feat(beo): register beo_unack_nudge_sms handler at boot`
**Date:** 2026-05-28

> The cc-import HANDOFF.md that was here is now merged history (commit `783f3b8` and surrounding). This file replaces it with the current in-flight context.

## What's done

Two plans are being executed in this branch.

### Staff portal redesign plan (`docs/superpowers/plans/2026-05-27-staff-portal-redesign-implementation.md`)

- **Phase 1 (Tasks 1-6)** — schema additions, notification channel resolver, push sender stub, enqueueCategorizedMessage helper, shiftTime helper, tipHandleValidation Zelle branch. All landed, all tests pass.
- **Phase 2 Task 7** — dispatcher kill-switch + push channel + sibling cascade + critical-path re-resolve + dead-letter Sentry + ADMIN_PHONE alert. Landed.
- **Phase 2 Task 8 onward** — NOT started. Task 8 (calendar feed extension) was the original blocker that triggered the BEO plan; Tasks 9-11 (auth + payroll companions) can run in any order once BEO is further along.

### BEO plan (`docs/superpowers/plans/2026-05-26-beo-implementation.md`)

- **Phase 1 (Tasks 1-4)** — schema (`drink_plans.finalized_at`, `.finalized_by`, `shift_requests.beo_acknowledged_at`), SuppressMessageError class, dispatcher discriminator, beoReadLimiter. Landed.
- **Phase 2 (Tasks 5-12)** — staffBeoNudgeSms template, formatEventDateLong export, beoHandlers.js (insertBeoNudgeIfMissing, scheduleBeoNudgesForProposal, suppressBeoNudgesForProposal, suppressBeoNudgesForStaffers, reanchorBeoForProposal, loadBeoContext, handleBeoUnackNudge), boot wiring. Landed. 21 tests in `beoHandlers.test.js`, all pass.
- **Phase 3 onward** — NOT started.

## Pick up here

The cleanest next task is **BEO Phase 3 Task 13: `server/routes/beo.js` GET routes + tests** (plan line 1213). That creates `server/routes/beo.js` with three GET routes (proposal-scoped BEO read, logo fetch, ack-state) and tests. Then Task 14 adds `POST /api/beo/:proposalId/acknowledge`.

After Phase 3, Phase 4 is Finalize/Unfinalize + lock guards on every drinkPlans.js / drinkPlanConsult.js mutation route. Phase 5 is the 8 shift-integration touches (suppression hooks on cancel-or-unassign, deny/approve, generic PUT cancel, DELETE, autoAssign ack-clear, scheduleStaffShiftMessages BEO branch, rescheduleProposalInTx reanchor cascade, GET shifts projection updates). Phase 6 is the admin frontend (Tasks 28 + 30 only — 29 and 31 are dropped per the staff portal plan's inheritance). Phase 7 is docs + final verification.

## Plan-vs-schema adaptations (load-bearing for the next agent)

The BEO plan was written against a slightly older schema. These deltas applied during Phase 1-2 execution and need to carry forward:

1. **`onboarding_status='active'` is invalid.** The CHECK constraint allows `in_progress | applied | interviewing | hired | rejected | submitted | reviewed | approved | suspended | deactivated`. Every plan reference to `'active'` was rewritten to `'approved'` — that's the staffer-in-pool status. Look for this in Phase 5 staffer-filter queries.
2. **`users.password` is `users.password_hash`.** Test fixtures use `password_hash` with `bcrypt.hash('x', 4)`.
3. **`drink_plans.proposal_id` has no UNIQUE constraint.** `INSERT ... ON CONFLICT (proposal_id) DO UPDATE` won't work. Use `DELETE` then `INSERT`, or check-then-insert.
4. **`handleBeoUnackNudge` gate order is asserted by tests.** Order shipped: `user_deleted` → `beo_not_finalized` → `already_acknowledged` → `staffer_unassigned` → `user_inactive` → `no_phone` → `no_start_time` → `event_in_past`. Don't reorder.
5. **`scheduled_messages.suppression_key` + `payload` columns are NEW** (added in staff-portal Phase 1 Task 1). The BEO plan never uses them, but the dispatcher now SELECTs them in `dispatchPending` — schema and dispatcher are coupled.
6. **Staff-portal Phase 1 Task 4 widened `messageScheduling.js` `VALID_CHANNELS` to include `'push'`.** Any new BEO scheduling call still goes through `scheduleMessage` (which won't fan out) or the new `enqueueCategorizedMessage` (which fans out per channel).
7. **`scheduledMessageDispatcher.js` is 986 lines** — over the 700 soft cap, under the 1000 hard cap. Each future commit that grows this file will warn but not block until 1000. Plan a split eventually (push branch and sibling cascade are natural extracts).

## Operational notes

### Database (CRITICAL)

- Local dev DB is Neon. The connection string lives in `../../os/.env`, NOT in this worktree.
- `DATABASE_URL` is NOT in the bash shell by default. Every command that needs it must prefix with:
  ```bash
  export $(grep -E "^DATABASE_URL=" ../../os/.env | head -1);
  ```
- The Neon dev branch was reset between sessions earlier this run (a routine action). After any reset, re-apply schema:
  ```bash
  export $(grep -E "^DATABASE_URL=" ../../os/.env | head -1); psql "$DATABASE_URL" -f server/db/schema.sql
  ```
  It's idempotent. The `position` backfill UPDATE runs `UPDATE 73` (or however many contractor_profiles rows exist) on first re-apply.

### Tests

Run a single file:
```bash
export $(grep -E "^DATABASE_URL=" ../../os/.env | head -1); node --test server/utils/beoHandlers.test.js
```

Full suite (`npm test`) currently shows ~150 failures — those are **pre-existing concurrency issues** (every failing test passes in isolation; they share dev-DB state across parallel runs). NOT a regression from this session's work. Don't chase those; only worry if a file that passed in isolation starts failing in isolation.

Stale test-user rows accumulate when test runs are interrupted. If you see `users_email_key` violations:
```bash
export $(grep -E "^DATABASE_URL=" ../../os/.env | head -1); psql "$DATABASE_URL" -c "DELETE FROM users WHERE email LIKE 'disp-%' OR email LIKE 'push-dispatcher-test-%' OR email LIKE 'beo-handlers-%' OR email LIKE 'channel-resolver-test-%' OR email LIKE 'enqueue-test-%'"
```

### Dev server

Per CLAUDE.md, the dev server is "Claude-managed bg process" — no auto-reload. Restart it (kill :5000 PID, relaunch) after server edits. PowerShell tool is denied for Claude, so the user runs the restart themselves.

### Commits

Pre-commit lint runs eslint via lint-staged. Two patterns to watch:
- `==` vs `===` is a hard error.
- `security/detect-unsafe-regex` flags bounded regexes too aggressively; use `// eslint-disable-next-line security/detect-unsafe-regex` when the regex is provably bounded.

Docs-drift warning fires on every schema/structural change. It's a warning only; the plan's Phase 7 / Task 32 batches docs updates at the end.

## Files modified this session

### New files (server)
- `server/utils/notificationChannelResolver.js` + `.test.js`
- `server/utils/pushSender.js` + `.test.js`
- `server/utils/shiftTime.js` + `.test.js`
- `server/utils/tipHandleValidation.test.js` (test file is new; the impl was extended in place)
- `server/utils/beoHandlers.js` + `.test.js`

### Modified files (server)
- `server/db/schema.sql` (staff-portal + BEO additions, all idempotent)
- `server/utils/messageScheduling.js` (VALID_CHANNELS widened to push; enqueueCategorizedMessage added; category in payload)
- `server/utils/scheduledMessageDispatcher.js` (push branch + sibling cascade + re-resolve + SuppressMessageError discriminator + `sms` module-level require for monkey-patching)
- `server/utils/errors.js` (SuppressMessageError class)
- `server/utils/staffShiftHandlers.js` (formatEventDateLong export)
- `server/utils/smsTemplates.js` + `.test.js` (staffBeoNudgeSms)
- `server/utils/tipHandleValidation.js` (Zelle branch)
- `server/middleware/rateLimiters.js` (beoReadLimiter)
- `server/index.js` (registerBeoHandlers in boot block)

### Unchanged
- Anything client-side (frontend untouched)
- All other route files

## Recommended next-window prompt

> Continue executing the BEO plan at `docs/superpowers/plans/2026-05-26-beo-implementation.md` starting at Phase 3 Task 13. The prior session shipped Phase 1+2 (commits `13907c2` through `c23a294`). Read `HANDOFF.md` first for plan-vs-schema adaptations (especially `onboarding_status='approved'` not `'active'`) and the DATABASE_URL sourcing pattern.

## Don't touch unless asked

- `docs/superpowers/specs/*` — settled, multiple review-fleet rounds folded
- `docs/superpowers/plans/*` — same, except to update task checkboxes if the executing-plans skill calls for it
