---
description: Autonomous overnight review + fix cycle. Runs 5 agents, auto-fixes safe findings, writes a summary log for the morning push.
---

You are running UNATTENDED at ~3am via Windows Task Scheduler. The user is asleep. They will read your log in the morning and, if clean, push to `main`.

Your job: review unpushed commits, auto-fix mechanical / low-risk findings, and leave a clear summary in `.claude/overnight-review.log`. Never push. Never ask questions.

## Preflight (abort cleanly if any fail)

Run these in order. If any check fails, write a one-line reason to `.claude/overnight-review.log` and exit. **Do not attempt recovery — a clean abort is always correct for overnight.**

1. `git rev-parse --abbrev-ref HEAD` — must equal `main`. Otherwise log `skipped: wrong branch (<actual>)` and exit.
2. `git status --porcelain` — must be empty. Working-tree dirt means user has WIP; do NOT touch it. Log `skipped: dirty working tree` and exit.
3. `git log origin/main..HEAD --oneline` — must be non-empty (**unless** Sentry has unresolved production issues — see Step 0). Otherwise log `skipped: no unpushed commits and no Sentry issues` and exit.
4. Record `ORIGINAL_HEAD=$(git rev-parse HEAD)` — this is the sha the agents will review.

## Step 0 — Pull production errors from Sentry

Use the Sentry MCP tools (namespace `mcp__sentry__*`) to pull unresolved issues across both `drbartender-server` and `drbartender-client` projects, org slug `dr-bartender`.

1. List unresolved issues, sorted by event count DESC, for both projects. Cap at 20 per project.
2. For each issue in the top list, pull full details: stack trace, first seen, last seen, event count, affected URL/route, sample event.
3. Classify each issue:
   - **Actionable-by-agent**: clear stack trace pointing into our code, deterministic error (not a transient network/timeout), root cause plausibly fixable via a small diff (null check, missing guard, schema drift, off-by-one, etc.).
   - **Flag-for-morning**: ambiguous cause, touches pricing/Stripe/auth, requires architectural judgment, or the error is in third-party code.

Issues become **inputs** to the 5 agents in Step 1: attach the issue list as context so the agents can root-cause them alongside reviewing the unpushed commits. An agent may decide a finding it would have surfaced anyway is in fact the root cause of a Sentry issue — in that case, noting the Sentry issue id alongside the finding is the goal.

**Sentry-only runs are allowed.** If there are no unpushed commits but Sentry has actionable issues, proceed with the 5 agents anyway — their job becomes "root-cause and fix these production errors."

## Step 1 — Run 5 agents in parallel

Single message, five concurrent `Agent` tool calls:

1. `@security-review`
2. `@code-review`
3. `@consistency-check`
4. `@database-review`
5. `@performance-review`

**Do NOT run `@ui-ux-review`** — it needs a browser and dev server you cannot start safely at 3am.

## Step 2 — Triage every finding

For each finding (across all 5 agents), classify into **auto-fix** or **flag-for-morning**.

### Auto-fix (apply tonight)
Only mechanical, unambiguous, behavior-inert fixes:

- Missing `auth` middleware on a non-public route → add it.
- SQL template literals / string concat inside `.query()` → convert to parameterized `$1`, `$2`.
- Missing `ROLLBACK` on a `BEGIN` error branch → add it.
- Missing `CREATE INDEX IF NOT EXISTS` on an obvious query hotspot → add idempotent DDL to `server/db/schema.sql`.
- Missing `asyncHandler` wrap on an async route handler → wrap it.
- Missing loading / error / empty states in a React component → add them, matching existing patterns.
- Dead code, unused imports, unused variables → delete (only when you can confirm zero references via Grep).
- Stale folder-tree entries in `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` → sync to reality.
- Missing `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` guards on schema DDL → add.
- Typos, naming inconsistencies inside a single file → fix.
- **Sentry-linked null/undefined crashes** with an unambiguous stack trace into our code → add the missing guard (e.g., `if (!x) return null`, optional chaining, default value). After committing, call `mcp__sentry__update_issue` with `status: "resolved"` and include the commit sha in the resolution comment.
- **Sentry-linked schema drift** (e.g., column removed but code still references it) with clear stack trace → sync the code to current schema. Resolve issue after commit.

### Flag for morning (DO NOT auto-fix)
When in doubt, flag. These always flag:

- **Anything touching `server/utils/pricingEngine.js`, Stripe code, or money math** — re-lost too many times, humans review these.
- **Anything touching auth design** — JWT signing, token lifetimes, role model changes. Middleware addition above is mechanical; design changes are not.
- **Any finding marked CRITICAL severity** — even if mechanically fixable.
- **Any fix that would touch >5 files** — too much surface to land unattended.
- **Design-question findings** ("is this endpoint meant to be public?", "should this be paginated?") — those need the user's intent.
- **Anything requiring browser or visual verification to confirm.**
- **Anything that changes user-facing behavior** — copy, UI layout, API response shapes.
- **Anything touching `.env*`, secrets, lockfiles, or `package.json` dependencies.**
- **Sentry issues without a clear stack trace into our code** (stack bottoms out in node_modules, browser internals, or third-party SDK) — root cause is ambiguous.
- **Sentry issues in routes you are not touching tonight AND where the fix would require more than a null/type guard** — flag with recommended fix so morning user can decide.

## Step 3 — Apply auto-fixes

For each auto-fixable finding:

1. Make the edit with `Edit` / `Write`.
2. **Group related fixes into one logical commit** (Rule 3: one commit per logical feature, not per finding). E.g., "fix(security): parameterize remaining SQL queries in clients.js" is one commit covering all queries in that file.
3. Stage explicitly: `git add <specific-path>` per file. **Never** `git add .` / `-A` / `-u` (Rule 7).
4. Commit with plain one-line message: `git commit -m "fix(review): <short description>"`. No heredoc, no co-author footer (Rule 4 commit-cue convention).
5. **Never push** (Rule 4 push-cue requires explicit human approval). The morning user pushes after reviewing.

If any fix attempt errors or leaves the working tree dirty, `git restore --staged .` and skip — log as "attempted but aborted".

## Step 4 — Write the summary log

Overwrite `.claude/overnight-review.log` with this exact structure:

```
Overnight review — <ISO timestamp, UTC>
Reviewed from: <ORIGINAL_HEAD sha>
Current HEAD:  <sha after fixes, or ORIGINAL_HEAD if no fixes>
Commits reviewed: <count from git log origin/main..ORIGINAL_HEAD>
Fixes committed: <count of new commits you created>
Sentry issues pulled: <total unresolved count>
Sentry issues auto-resolved: <count you resolved via mcp__sentry__update_issue>

## Result
<ONE of these lines, exactly>
CLEAN — no findings. Safe to push.
FIXED — N auto-fixes applied. Review diffs then push. K items still flagged for morning.
BLOCKED — M items require human attention. Do NOT push until resolved.

## Sentry — top unresolved (at start of run)
- <issue-id> [<project>] <count> events — <error title>
  URL: <sentry issue URL>
  Disposition: <auto-fixed | flagged | ignored (reason)>
...
(or: "none" if Sentry had zero unresolved issues)

## Auto-fixed (committed)
- [<agent or "sentry">] <severity> <file:line> — <finding summary>
  Commit: <sha> <commit message>
  Sentry issue (if any): <issue-id> — resolved
...
(or: "none" if nothing was auto-fixed)

## Flagged for morning (NOT fixed)
- [<agent or "sentry">] <severity> <file:line> — <finding summary>
  Reason not auto-fixed: <which flag-for-morning rule caught it>
  Recommended fix: <what to do>
  Sentry issue (if any): <issue-id> — left unresolved
...
(or: "none" if nothing was flagged)

## Clean agents (no findings)
- @<agent-name>
...

## Abort / error notes
<any agent crashes, Sentry MCP failures, timeouts, or attempted-but-aborted fixes>
```

Result-line rules:
- **CLEAN** → no findings at all from any agent AND zero unresolved Sentry issues (or all Sentry issues were auto-resolved this run).
- **FIXED** → at least one auto-fix committed (agent-derived OR Sentry-derived) AND zero flagged-for-morning items.
- If there are any flagged-for-morning items, result is **BLOCKED** regardless of how many fixes you applied.

## Hard rules (never break)

- Never push. Never force-push. Never rebase. Never reset.
- Never commit to any branch other than `main`.
- Never modify `.env*`, `*.key`, `package.json`, `package-lock.json`, `.husky/*`, or any secret / lockfile / hook.
- Never touch `server/utils/pricingEngine.js` — always flag for morning.
- Never run `npm install`, `npm update`, or anything that would mutate dependencies.
- Never delete a file unless Grep confirms zero references.
- Never open the dev server, never run `npm run dev`.
- Never resolve a Sentry issue unless you committed a fix this run. "Looks fine now" is not grounds for resolution — only a commit sha tied to the root cause.
- If the Sentry MCP is unavailable / errors out: log "sentry step skipped: <reason>" and proceed with the 5 agents over commits only. Do not abort the whole run.
- If anything feels ambiguous: flag for morning, write the log, exit.
- On any unexpected state (unexpected branch, remote change, merge conflict): abort, write log, exit. Do NOT try to recover.
