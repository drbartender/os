# Handoff: Thumbtack Auto-Draft Proposal

You are in the `thumbtack-autodraft` worktree, on branch `thumbtack-autodraft`, to **implement** an already-designed, already-reviewed feature. The spec and plan are written, committed, and review-clean (design fleet + Gemini at both spec and plan stages, plus a delta re-review). Your job is to execute the plan task by task. Do NOT re-design or re-brainstorm.

**Worktree:** `C:\Users\dalla\DRB_OS\worktrees\thumbtack-autodraft` · **Branch:** `thumbtack-autodraft`

## What this builds

When a Thumbtack lead arrives via webhook, auto-create an inert **draft** proposal (The Core Reaction, BYOB) prefilled from the lead, so the admin opens it, adds an email, and clicks Send instead of rebuilding it by hand. No auto-send (the admin still clicks Send). The draft builder only ever writes a `draft`; it never creates an invoice, sends mail/SMS, or sets `sent`.

## Read these first (already committed in this worktree)

1. Plan (your task list, with exact code + commands): `docs/superpowers/plans/2026-06-05-thumbtack-auto-draft-proposal.md`
2. Spec (the why + decisions): `docs/superpowers/specs/2026-06-05-thumbtack-auto-draft-proposal-design.md`
3. `.claude/CLAUDE.md` (project rules: git workflow, coding patterns, file-size ratchet).

## How to execute

Use the **superpowers:subagent-driven-development** skill (recommended) or **superpowers:executing-plans** to work the plan task by task. The plan steps use `- [ ]` checkboxes. The order is fixed by dependencies:

`1 schema -> 2 shared insertProposalRecord -> 3 pure mappers -> 4 draft builder -> 5 notification template -> 6 webhook wiring -> 6b webhook tests -> 7 server source filter -> 8 dashboard badge/filter -> 9 Send confirm -> 10 docs`

Each task ends in its own commit (the plan gives the exact `git commit -m` line). Commit per task; do not batch tasks into one commit. **Do NOT push** (see Git below).

## Load-bearing traps (do not lose these)

- **`num_bars` MUST be 0 for the Core Reaction.** It is a `service_only` package. The pricing engine's `calculateBarRental` does `Number(pkg.first_bar_fee || 50)`, so any `num_bars >= 1` adds a $50 bar fee even when the column is 0. With `num_bars: 0` the draft is $350; with 1 it would wrongly be $400. The plan's Task 4 and its test pin this.
- **Shared `insertProposalRecord` (Task 2) is a money-path refactor of `crud.js`.** Behavior must be byte-identical for the manual path. `server/routes/proposals/crud.test.js` is the regression gate and must stay green after the extraction.
- **The webhook draft step is best-effort, post-commit.** Lead capture commits first and must never roll back or 500 because the draft failed. The catch logs (`console.error` + Sentry when DSN set) and the webhook still returns 200. Task 6b proves this.
- **`proposals.source`**: `'thumbtack'` for auto-drafts, `null` for everything else, and `null` means manual/direct **permanently** (never "unknown").
- The Send confirm copy is exactly: `No email on file. Send via SMS only?` (it is a spec/test literal).

## Repo-specific gotchas

- **Dev server is a Claude-managed background process with no auto-reload.** After any server edit, restart it (kill the PID on port 5000, relaunch) before exercising the webhook (Tasks 6, 7).
- **Schema apply (Task 1):** there is no migrate script. Apply `schema.sql` with:
  `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('schema applied');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
- **Server tests share the dev DB. Run node:test suites ONE AT A TIME**, never in parallel:
  - `node --test server/utils/thumbtackProposalDraft.test.js`
  - `node --test server/routes/thumbtack.test.js`
  - `node --test server/routes/proposals/crud.test.js`
- **Client lint is only enforced by Vercel CI**, not the local hook. Verify any client change (Tasks 8, 9) with: `cd client && CI=true npx react-scripts build` (expect "Compiled successfully").
- **Do NOT run `npm install` in this worktree.** It replaces the shared `node_modules` junction with a real dir. This feature needs no new deps. If one were ever truly required, it gets installed in `os` after merge.
- **File-size ratchet** runs in the pre-commit hook. `crud.js` should SHRINK after Task 2's extraction; no touched file should cross 1000 lines while growing. `npm run check:filesize` for a report.

## Execution-review cadence

The plan has an "Execution review cadence" section. Honor it: run the relevant specialized agents at the checkpoints it names (e.g. `database-review` after Task 1, `code-review` + `consistency-check` after the Task 2 money-path refactor, `security-review` after Task 6/6b and Task 7). These are in addition to the standard pre-push fleet.

## Git workflow (critical)

- All work commits to branch `thumbtack-autodraft` here. Explicit staging only (`git add <specific-path>`), never `git add .` / `-A`.
- **Never push from this worktree.** Pushing and merging happen from the `os` window on `main`, user-initiated. When implementation is complete and all three suites + the client build are green, stop and report back so the `os` window can `git merge thumbtack-autodraft` and Dallas decides when to push.
- Plain one-line commit messages (the plan provides them). No co-author footer.

## Definition of done (the plan's Final verification)

- All three server suites pass individually.
- `cd client && CI=true npx react-scripts build` compiles.
- `npm run check:filesize` shows no new RED.
- Manual end-to-end: POST a fake lead (plan Task 6), confirm a `draft` / `source='thumbtack'` / `$350` proposal appears in the dashboard with a Thumbtack badge, the source filter narrows to it, and the admin notes carry the Q&A. Clean up the test row.

Then report completion to the `os` window for merge.

Start by reading the plan, then execute Task 1.
