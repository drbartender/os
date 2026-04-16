# Git Workflow & Review Agent Design

**Date:** 2026-04-15
**Status:** Approved design, pending implementation plan
**Author:** Dallas (with Claude)

---

## Problem

The project has accumulated chronic git-workflow damage from prior sessions:

- 2 unmerged feature branches with real, shipped-quality work sitting local (~17 commits on one, 1 on another)
- 1 dangling stash (`wip-on-fix-homepage-faq-login-batch-pre-thumbtack-reviews`) with unknown content
- Uncommitted WIP scattered across the current branch
- Untracked artifacts (`.playwright-mcp/`, screenshots) polluting the root
- Code has been lost in at least one past merge/stash incident
- `CLAUDE.md` currently references a 6-agent review model, but `.claude/agents/` on disk still contains the old 7-file haiku/opus mix — the two are out of sync

The author works solo, vibe-codes heavily, and needs Claude to catch bugs they won't see themselves. The author also context-switches across tasks and cannot afford approval friction on every commit.

## Goals

1. Establish a **trunk-based** workflow rigorously enforced by Claude.
2. Never lose code again. Code preservation is the top priority — above ship speed, above cleanliness, above everything.
3. Minimize per-action friction. One human checkpoint per feature ("it works"), not per commit or per push.
4. Use opus review agents automatically on code-touching pushes to catch security, consistency, correctness, schema, and performance bugs before they ship.
5. Synchronize the on-disk agent files with the `CLAUDE.md` 6-agent model. No drift between documentation and reality.

## Non-Goals

- Multi-developer git workflow (feature branches, PR reviews, merge queues). Solo-only for now; may revisit.
- Automated rollback or deployment orchestration. Out of scope — Render and Vercel handle deploy; `git revert` handles rollback.
- Husky pre-commit / pre-push hooks to enforce rules. Noted as a possible future enhancement; not part of this design.
- Historical cleanup of the existing branches and stash. The user is handling that separately. This design applies to the *next* session after cleanup.

---

## Decision 1 — Branching Model: Trunk-Based (solo)

All work happens on `main`. No feature branches, no `develop`, no `fix/*`, no `feat/*`. `main` is the single source of truth and the deployment target.

**Rationale:** Solo developer, vibe-coded, periodic push/deploy cadence. Branches introduce merge risk without parallel-developer benefit. Every prior issue traces back to branches diverging from `main` or work getting parked and forgotten.

**Branch creation:** Claude may *propose* a branch with a one-line reason (e.g., "this schema migration touches 3 tables — want it on a branch so you can abandon?"), but never creates one silently. User approves with a yes/no.

## Decision 2 — Commit Granularity: Finished Work Only

Commits must represent complete, tested units of work. No WIP commits, no checkpoint commits, no "saving progress" commits.

**"Finished" definition:**
- **Behavior-affecting changes** (any `.js`, `.sql`, route, component): user has verified the change works in the app/browser.
- **Behavior-inert changes** (copy edits, CSS polish, `.md` docs): user has approved; no in-app test required.

**No `git add .` or `git add -A`.** Claude stages files by explicit name always. Prevents screenshots, `.playwright-mcp/`, and `.env` from being swept into commits accidentally.

## Decision 3 — Commit vs. Push Cadence: Split

Commits are local, frequent, per-finished-unit. Pushes are batched and explicit.

**Commit cue (Claude commits without further approval):**
- "looks good", "commit", "commit it", "next task"
- Any affirmative after Claude has reported what to test

**Push cue (Claude pushes without further approval, triggering agents first):**
- "push", "deploy", "send it", "ship it", "ready to push"
- NOT inferred from commit cues

**Proactive prompt:** At natural break points (end of a feature, after 3+ commits accumulated locally, end of a work block), Claude may ask: *"Ready to push these N commits?"*

**Why split:** push = deploy to Render + Vercel. Conflating commit and push makes every commit a production event, which is too aggressive for iterative work.

## Decision 4 — Risk-Based Review Agents on Push

Every push that includes any code file triggers opus review agents in parallel before `git push` runs. Agents scan for security, consistency, correctness, schema, and performance issues.

**Auto-run in parallel before every code-touching push to `main`:**
- `consistency-check`
- `code-review`
- `security-review`
- `database-review`
- `performance-review`

**Skip agents only when the push contains exclusively non-code files:**
- `*.md` documentation
- `.gitignore`

Any `.js`, `.jsx`, `.ts`, `.tsx`, `.css`, `.scss`, `.sql`, `.json` (package files), `.yaml`, or config change → all 5 agents run.

**Explicit-only:** `ui-ux-review` (requires `npm run dev` running — cannot be autonomous).

**Cost:** Not a concern per user preference. Priority is catching bugs in a vibe-coded codebase.

## Decision 5 — Agent File Reorganization (sync disk to CLAUDE.md)

`CLAUDE.md` references 6 agents. `.claude/agents/` must match exactly.

**Target final state (6 files):**
- `security-review.md` (opus) — full OWASP audit, merges old `security-scan` + `full-security-audit`
- `code-review.md` (opus) — code quality + error handling, merges old `full-code-review` + `error-handling-check`
- `consistency-check.md` (opus) — cross-file synchronization; bumped from haiku
- `database-review.md` (opus) — schema + query analysis; already opus
- `performance-review.md` (opus) — new; React rendering, bundle, API perf
- `ui-ux-review.md` (opus) — Playwright visual + a11y review; already opus

**Operations required:**
- Delete: `security-scan.md`, `full-security-audit.md`, `full-code-review.md`, `error-handling-check.md`
- Create: `security-review.md`, `code-review.md`, `performance-review.md`
- Edit: `consistency-check.md` (model bump + description update), `database-review.md` (description update), `ui-ux-review.md` (description update)

## Decision 6 — Slash Command `/review-before-deploy`

Create `.claude/commands/review-before-deploy.md` that launches all 6 agents in parallel. Reserved for heavier gates (big deploys, end of feature sets, periodic quality check). Matches the "Full Pre-Deploy Review — Run ALL six agents" intent already written into CLAUDE.md.

## Decision 7 — Code Preservation Rules (Destructive Ops)

The #1 workflow priority is never losing user work — uncommitted, unpushed, or stashed. Stronger than "ship safely."

**Always require explicit per-action approval:**
- `git push --force`, `--force-with-lease`
- `git reset --hard`
- `git clean -f` (any form)
- `git branch -D`
- `git checkout .`, `git restore .` (mass-discard)
- `rm` / `rm -rf` on tracked files or directories
- `git stash` (rule also applies to branches — see Decision 1)

**Never automate:**
- Any recovery from a push failure (non-fast-forward, auth, network). Claude reports and waits — does NOT `git pull --rebase`, `--force`, or retry.
- Amending a pushed commit (would require force-push).

**Safe undo recipes (Claude may use without asking):**
- Unpushed commit undo: `git reset --soft HEAD~N` (keeps changes in working tree)
- Pushed commit undo: `git revert <sha>` then push (new undo commit)
- Unstage without losing work: `git restore --staged <path>`

---

## The 12 Core Workflow Rules

Go into `CLAUDE.md` verbatim as a new top-level "Git Workflow" section, placed before "Reasoning Effort."

1. **Trunk-only by default.** All work on `main`. Claude confirms branch at session start; if not on `main`, stops and asks — never auto-switches.
2. **Code preservation beats shipping speed.** When a git op could destroy uncommitted or unpushed work, stop and ask.
3. **Commits are finished, tested work only.** "Finished" means either (a) user verified it works in the app, or (b) it's a behavior-inert change (copy, CSS, docs) the user approved. No WIP commits, no checkpoint commits.
4. **Separate cues for commit vs. push.**
   - Commit cue: "looks good", "commit", "next task", or any affirmative after Claude reports what to test → commit without re-approval.
   - Push cue: explicit only — "push", "deploy", "ship it", "send it". Claude never auto-pushes on commit cues. At natural break points Claude may ask *"ready to push these N commits?"*
5. **Push = deploy.** Every push to `main` ships to Render + Vercel. Treat with gravity.
6. **Review agents run automatically before every code-touching push.** Claude launches all 5 non-UI agents in parallel (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`). Skip agents only when the push contains exclusively `*.md` or `.gitignore` changes. Clean results → push proceeds silently. Any flag → stop, report findings, wait.
7. **Explicit staging only.** `git add <specific-path>` always. Never `git add .`, `-A`, or `-u`. Prevents sweeping in screenshots, `.playwright-mcp/`, `.env`, etc.
8. **Branches and stashes require approval with a one-line reason.** Claude may propose but never creates silently.
9. **Undo rules (safe recipes).**
   - Unpushed commit: `git reset --soft HEAD~N`
   - Pushed commit: `git revert <sha>` + push (new undo commit — never rewrite pushed history)
   - Unstage without losing work: `git restore --staged <path>`
10. **Amend rules.** Never `--amend` a pushed commit. On unpushed commits, prefer new commits over amend; only amend if the user explicitly asks.
11. **Destructive ops always require explicit approval.** `push --force`, `reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `rm` on tracked files — per-action yes every time. No "obviously safe" bypass.
12. **Push failures stop and report — never auto-resolve.** If `git push` is rejected (non-fast-forward, auth, network), Claude stops and asks. Never auto-pulls, auto-rebases, or force-pushes.

---

## Risky Paths (reference, for trigger classification)

With Decision 4, agents run on any code-touching push. Risky paths are retained as reference for *when to escalate scrutiny* and for future rule tuning. Touching any of these should also cause Claude to apply max reasoning effort:

```
server/routes/**/*.js
server/middleware/**/*.js
server/db/schema.sql
server/db/index.js
server/utils/pricingEngine.js
server/utils/autoAssign.js
server/utils/fileValidation.js
server/utils/storage.js
server/utils/email.js
server/utils/sms.js
server/index.js
.env.example
package.json
client/package.json
```

---

## Pre-Push Procedure (Claude's checklist)

When the user gives a push cue, Claude runs this checklist exactly. No steps skipped, no silent deviations.

1. **Verify branch.** Confirm current branch = `main`. If not, stop and ask.
2. **Sanity-check working tree.** If there are uncommitted modifications or untracked files other than known-ignored artifacts, pause and ask: *"There are uncommitted changes in X, Y, Z — meant to go in this push or leave them out?"* Not a hard block; user may just say "leave them."
3. **Inventory the batch.** Run `git log origin/main..HEAD --name-only` to see every file in the pending push.
4. **Classify code vs. non-code.** If any changed file is not `*.md` or `.gitignore`, agents run. Otherwise skip to step 7.
5. **Launch 5 agents in parallel** (single message, 5 concurrent Agent tool calls):
   - `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`
6. **Wait for all agents. Consolidate.**
   - All clean → proceed silently to push.
   - Any flagged issue → stop. Present a consolidated report grouped by severity (blockers, warnings, suggestions). Ask for direction: fix now, push anyway, or abandon?
7. **Push.** `git push origin main`. If rejected, stop and report (per Rule 12). Never auto-pull, rebase, or force.
8. **Report result.** Confirm push succeeded. Note Render + Vercel are now deploying. List commits that shipped.

---

## Implementation Scope (Harness Artifacts)

This is the concrete file-level work the implementation plan will break down.

### A. `.claude/CLAUDE.md` edits

- Add new top-level section "Git Workflow" with the 12 rules (before "Reasoning Effort").
- Add "Pre-Push Procedure" subsection under Git Workflow.
- Update the existing "Review Agents (All Opus)" section to explicitly document trigger rules:
  - Auto-run on code push: 5 agents listed
  - Explicit-only: `ui-ux-review`
  - `/review-before-deploy` runs all 6
- Confirm each agent description in CLAUDE.md matches the final `.claude/agents/*.md` file (spec says 6, agents on disk must equal 6).

### B. `.claude/agents/` reorganization

| Action | File | Details |
|---|---|---|
| Delete | `security-scan.md` | Superseded by `security-review.md` |
| Delete | `full-security-audit.md` | Renamed; content merged into `security-review.md` |
| Delete | `error-handling-check.md` | Merged into `code-review.md` |
| Delete | `full-code-review.md` | Renamed; content merged into `code-review.md` |
| Create | `security-review.md` | `model: opus`, description matches CLAUDE.md @security-review |
| Create | `code-review.md` | `model: opus`, description matches CLAUDE.md @code-review |
| Create | `performance-review.md` | `model: opus`, description matches CLAUDE.md @performance-review |
| Edit | `consistency-check.md` | `model: haiku` → `opus`; description updated to reflect new trigger rules (pre-push, not post-feature) |
| Edit | `database-review.md` | Description updated to reflect auto-trigger on schema changes and manual via `/review-before-deploy` |
| Edit | `ui-ux-review.md` | Description updated to clarify explicit-only / dev-server requirement |

### C. New slash command

Create `.claude/commands/review-before-deploy.md`:

```markdown
---
description: Run full pre-deploy audit — all six agents in parallel
---

You are coordinating a full pre-deploy review. Launch these six agents **in parallel** using the Agent tool (single message, six concurrent tool calls):

1. `@security-review` — full OWASP Top 10 audit of the entire codebase
2. `@code-review` — code quality, dead code, error handling, React anti-patterns
3. `@consistency-check` — cross-file schema/route/frontend synchronization
4. `@database-review` — schema, indexes, query patterns, migration safety
5. `@performance-review` — React rendering, bundle size, API perf, public-page priority
6. `@ui-ux-review` — Playwright visual + accessibility review (requires `npm run dev` running)

When all six return, consolidate findings into one report grouped by severity: **blockers**, **warnings**, **suggestions**. If any blocker exists, explicitly tell the user they should NOT push.

If the dev server isn't running, warn the user that `ui-ux-review` will fail and ask whether to start the dev server or skip that agent.
```

### D. `.gitignore` additions

Append to `.gitignore`:
```
.playwright-mcp/
/*.png
```

The `/*.png` is root-only so it doesn't catch intentional image assets under `client/public/` or `client/src/`.

### E. Documentation updates

- Update `README.md` folder tree to add `.claude/commands/` if it's new
- Update `ARCHITECTURE.md` only if the agent table is referenced there (spot-check required during implementation)

---

## Out of Scope (deferred)

- **Historical cleanup** of existing branches (`fix/homepage-faq-login-batch`, `feat/homepage-thumbtack-reviews`) and stash. User is handling separately.
- **Husky pre-push hooks** enforcing the rules mechanically. Possible future enhancement once the Claude-driven rules prove reliable.
- **Multi-developer workflow** (PRs, review queues). Revisit if/when collaborators join.
- **Automated deploy gating** (GitHub Actions blocking push if agents fail). Current model trusts Claude to honor the pre-push procedure.

## Open Questions

None at spec approval time. Any that emerge during implementation go into the plan doc, not back here.

---

## Success Criteria

After implementation:

1. `.claude/CLAUDE.md` contains a "Git Workflow" section with all 12 rules and the pre-push procedure.
2. `.claude/agents/` contains exactly 6 files, all `model: opus`, each matching a description in `CLAUDE.md`.
3. `.claude/commands/review-before-deploy.md` exists and launches all 6 agents in parallel.
4. `.gitignore` suppresses `.playwright-mcp/` and root-level `*.png`.
5. A new work session, when given a push cue, runs the 5 non-UI agents in parallel and surfaces findings before pushing.
6. Claude never creates branches, stashes, or destructive ops without per-action approval.
7. No drift between `CLAUDE.md` agent list and `.claude/agents/` directory contents.
