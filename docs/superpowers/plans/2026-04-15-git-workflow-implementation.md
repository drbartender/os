# Git Workflow & Agent Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realize the design from `docs/superpowers/specs/2026-04-15-git-workflow-design.md` — sync `.claude/agents/` to the 6-agent opus model, add Git Workflow rules to CLAUDE.md, and create the `/review-before-deploy` slash command.

**Architecture:** All changes are configuration and documentation — no runtime code. Edit 3 existing agent files, create 1 slash command file, edit CLAUDE.md (insert one new section + rewrite one existing section), delete 4 old agent files. Single commit, single push, no agents run (commit contains only `*.md` files).

**Tech Stack:** Markdown files with YAML frontmatter; Claude Code agent definitions (`.claude/agents/`), slash commands (`.claude/commands/`), project instructions (`.claude/CLAUDE.md`).

---

## File Map

**Modify:**
- `.claude/agents/consistency-check.md` (bump model + new description)
- `.claude/agents/database-review.md` (new description)
- `.claude/agents/ui-ux-review.md` (new description)
- `.claude/CLAUDE.md` (insert new "Git Workflow" section; rewrite "Review Agents (All Opus)" section)

**Create:**
- `.claude/commands/review-before-deploy.md` (new slash command)

**Delete:**
- `.claude/agents/security-scan.md`
- `.claude/agents/full-security-audit.md`
- `.claude/agents/full-code-review.md`
- `.claude/agents/error-handling-check.md`

**Why this decomposition:** Each agent file is one focused concern (one reviewer, one trigger). The slash command is one coordinator. CLAUDE.md is the user-facing rulebook. No single file does multiple things.

---

### Task 1: Bump `consistency-check.md` to opus + new description

**Files:**
- Modify: `.claude/agents/consistency-check.md`

- [ ] **Step 1: Verify current state**

Run: `head -10 .claude/agents/consistency-check.md`
Expected: `model: haiku`, description starts with "Consistency checker. Use proactively after completing a feature..."

- [ ] **Step 2: Replace the frontmatter**

Edit `.claude/agents/consistency-check.md`. Replace the existing frontmatter (lines 1–8, ending after `maxTurns: 15`) with:

```yaml
---
name: consistency-check
description: Cross-file consistency checker. Auto-runs in parallel before every code-touching push to main. Verifies that schema, route, and frontend changes stay synchronized — no drift between layers.
tools: Read, Grep, Glob, Bash
model: opus
color: yellow
maxTurns: 15
---
```

Leave the body (everything from `You are a consistency checker...` onward) untouched.

- [ ] **Step 3: Verify**

Run: `head -8 .claude/agents/consistency-check.md`
Expected: shows `model: opus` and the new description starting with "Cross-file consistency checker. Auto-runs..."

---

### Task 2: Update `database-review.md` description

**Files:**
- Modify: `.claude/agents/database-review.md`

- [ ] **Step 1: Verify current state**

Run: `head -8 .claude/agents/database-review.md`
Expected: `model: opus`, description starts with "Database schema and query review. Only use when explicitly asked..."

- [ ] **Step 2: Replace the frontmatter description line**

Use Edit on `.claude/agents/database-review.md`. Replace the line:

```
description: Database schema and query review. Only use when explicitly asked or before a major deploy. Analyzes schema design, query patterns, and migration safety.
```

with:

```
description: PostgreSQL schema, query, and migration review. Auto-runs before any push that modifies server/db/schema.sql. Also invoked by /review-before-deploy. Analyzes index coverage, transaction safety, and migration idempotency.
```

Do not change `model:` (already opus), `color:`, or `maxTurns:`.

- [ ] **Step 3: Verify**

Run: `grep '^description:' .claude/agents/database-review.md`
Expected: matches the new description verbatim.

---

### Task 3: Update `ui-ux-review.md` description

**Files:**
- Modify: `.claude/agents/ui-ux-review.md`

- [ ] **Step 1: Verify current state**

Run: `head -14 .claude/agents/ui-ux-review.md`
Expected: existing description references "UI/UX reviewer using Playwright. Use when explicitly asked..."

- [ ] **Step 2: Replace the description line**

Use Edit on `.claude/agents/ui-ux-review.md`. Replace the line:

```
description: UI/UX reviewer using Playwright. Use when explicitly asked to review UI, check a page visually, or before a major deploy. Navigates to pages, takes screenshots, and provides design and accessibility feedback.
```

with:

```
description: Playwright-driven UI and accessibility review. Explicit-only — requires `npm run dev` running. Never auto-runs on push. Invoked by /review-before-deploy or on direct user request. Navigates pages, takes screenshots at desktop/tablet/mobile, checks contrast, labels, keyboard nav, and responsive behavior.
```

Leave the rest of the frontmatter (model, mcpServers, etc.) and body untouched.

- [ ] **Step 3: Verify**

Run: `grep '^description:' .claude/agents/ui-ux-review.md`
Expected: matches the new description verbatim.

---

### Task 4: Create `.claude/commands/review-before-deploy.md`

**Files:**
- Create: `.claude/commands/review-before-deploy.md`

- [ ] **Step 1: Verify the directory does not yet exist**

Run: `ls .claude/commands/ 2>&1 || echo "directory missing — Write tool will create it"`
Expected: either "directory missing" or empty listing.

- [ ] **Step 2: Create the file**

Write `.claude/commands/review-before-deploy.md` with this exact content:

````markdown
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
````

- [ ] **Step 3: Verify**

Run: `cat .claude/commands/review-before-deploy.md | head -3`
Expected: shows the frontmatter `---` and `description: Run full pre-deploy audit — all six agents in parallel`.

Run: `wc -l .claude/commands/review-before-deploy.md`
Expected: 17 lines.

---

### Task 5: Add "Git Workflow" section to CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md` (insert before the existing `## Reasoning Effort` heading)

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n '^## Reasoning Effort' .claude/CLAUDE.md`
Expected: returns one line number (currently around line 213). Note this number — call it `N`.

- [ ] **Step 2: Insert the Git Workflow section**

Use Edit on `.claude/CLAUDE.md`. Find the exact text:

```
## Reasoning Effort
```

Replace it with:

````markdown
## Git Workflow

Solo developer, trunk-based, vibe-coded. Code preservation is the #1 priority. Push to `main` = deploy to production via Render + Vercel.

### Twelve Core Rules

1. **Trunk-only by default.** All work on `main`. Claude confirms branch at session start; if not on `main`, stops and asks — never auto-switches.
2. **Code preservation beats shipping speed.** When a git op could destroy uncommitted or unpushed work, stop and ask.
3. **Commits are finished, tested work only.** "Finished" means either (a) user verified it works in the app, or (b) it's a behavior-inert change (copy, CSS, docs) the user approved. No WIP commits, no checkpoint commits.
4. **Separate cues for commit vs. push.**
   - **Commit cue:** "looks good", "commit", "next task", or any affirmative after Claude reports what to test → commit without re-approval.
   - **Push cue:** explicit only — "push", "deploy", "ship it", "send it". Claude never auto-pushes on commit cues. At natural break points Claude may ask *"ready to push these N commits?"*
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

### Pre-Push Procedure

When the user gives a push cue, Claude runs this checklist exactly. No steps skipped, no silent deviations.

1. **Verify branch.** Confirm current branch = `main`. If not, stop and ask.
2. **Sanity-check working tree.** If there are uncommitted modifications or untracked files other than known-ignored artifacts, pause and ask: *"There are uncommitted changes in X, Y, Z — meant to go in this push or leave them out?"* Not a hard block; user may just say "leave them."
3. **Inventory the batch.** Run `git log origin/main..HEAD --name-only` to see every file in the pending push.
4. **Classify code vs. non-code.** If any changed file is not `*.md` or `.gitignore`, agents run. Otherwise skip to step 7.
5. **Launch 5 agents in parallel** (single message, 5 concurrent Agent tool calls): `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`.
6. **Wait for all agents. Consolidate.** All clean → proceed silently to push. Any flagged issue → stop, present a consolidated report grouped by severity (blockers, warnings, suggestions), ask for direction (fix now, push anyway, abandon).
7. **Push.** `git push origin main`. If rejected, stop and report (per Rule 12).
8. **Report result.** Confirm push succeeded. Note Render + Vercel are now deploying. List commits that shipped.

## Reasoning Effort
````

- [ ] **Step 3: Verify**

Run: `grep -n '^## Git Workflow\|^## Reasoning Effort\|^### Twelve Core Rules\|^### Pre-Push Procedure' .claude/CLAUDE.md`
Expected: 4 lines, in this order: "## Git Workflow", "### Twelve Core Rules", "### Pre-Push Procedure", "## Reasoning Effort".

Run: `grep -c '^[0-9]\+\. \*\*' .claude/CLAUDE.md`
Expected: at least 12 (the 12 rules) plus any other numbered lists already in the file. Should be ≥12.

---

### Task 6: Rewrite "Review Agents (All Opus)" section in CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Locate the section**

Run: `grep -n '^### Review Agents\|^\*\*Full Pre-Deploy Review\*\*' .claude/CLAUDE.md`
Expected: 2 lines — start of section (~line 313 in current file) and the trailing "Full Pre-Deploy Review" line.

- [ ] **Step 2: Replace the entire section**

Use Edit on `.claude/CLAUDE.md`. Find the exact line:

```
### Review Agents (All Opus)
```

Find the matching closing line:

```
**Full Pre-Deploy Review** — Run ALL six agents in parallel before deploying.
```

Replace everything from the heading through (and including) the closing line with:

````markdown
### Review Agents (All Opus)

Six review agents live in `.claude/agents/`, all running on opus. Triggered automatically per the Git Workflow rules above (see Rule 6 + Pre-Push Procedure) or explicitly via the `/review-before-deploy` slash command.

**Auto-run in parallel before every code-touching push to `main`:**

- **@security-review** — Full OWASP Top 10 audit:
  - SQL injection (string concat in queries), XSS (`dangerouslySetInnerHTML`), SSRF
  - Missing `auth` middleware, IDOR (missing `req.user.id` ownership checks)
  - Hardcoded secrets, JWT implementation, Stripe/Resend/Thumbtack webhook verification
  - Rate limiting, CORS config, file upload validation, `npm audit`

- **@code-review** — Code quality + error handling:
  - Missing try/catch on async handlers, missing ROLLBACK after BEGIN, unhandled promises
  - Missing loading/error/empty states in React components
  - Dead code, duplication, function complexity (>50 lines), naming conventions
  - React anti-patterns: useEffect deps, component size (>200 lines), props drilling
  - API consistency: response shapes, HTTP status codes, snake_case keys

- **@consistency-check** — Cross-file synchronization:
  - Schema column changes reflected in all routes (SELECT, INSERT, UPDATE)
  - New routes mounted in `index.js` with matching `App.js` frontend routes
  - Pricing logic changes reflected in all consumers (ProposalCreate, ProposalDetail, PricingBreakdown)
  - API response shape changes handled by all frontend consumers
  - Doc updates: CLAUDE.md, README.md, ARCHITECTURE.md folder trees

- **@performance-review** — Frontend, API, and bundle performance:
  - Unnecessary React re-renders (missing memo/useMemo/useCallback)
  - Heavy imports, missing lazy loading, unused code shipped to client
  - Sequential DB queries that could use Promise.all, missing pagination
  - Oversized API responses, `SELECT *` instead of specific columns
  - Prioritizes public-facing pages (HomePage, ProposalView, PotionPlanningLab, Blog)

**Auto-run additionally when `server/db/schema.sql` is modified:**

- **@database-review** — Schema + query analysis:
  - Missing indexes, foreign keys, NOT NULL constraints
  - N+1 query patterns, `SELECT *`, missing LIMIT on list queries
  - Transaction integrity (BEGIN/COMMIT/ROLLBACK)
  - Migration safety (idempotent DDL, nullable new columns)

**Explicit-only (requires `npm run dev` running):**

- **@ui-ux-review** — Playwright visual + accessibility review:
  - Screenshots at desktop, tablet, and mobile viewports
  - Color contrast, form labels, heading hierarchy, keyboard navigation
  - Loading states, error messages, empty states, form validation feedback
  - Responsive layout, touch targets, admin sidebar behavior

**Slash Command — `/review-before-deploy`:**

Runs ALL six agents in parallel (the five auto-runners plus `ui-ux-review`). Reserved for heavier gates: end of a major feature, before quarterly deploy, after adding a new third-party integration. Will warn if `npm run dev` isn't running and ask whether to start it or skip the UI agent.
````

- [ ] **Step 3: Verify**

Run: `grep -c '^- \*\*@' .claude/CLAUDE.md`
Expected: 6 (one bullet per agent: security-review, code-review, consistency-check, performance-review, database-review, ui-ux-review).

Run: `grep -c '@security-scan\|@full-security-audit\|@full-code-review\|@error-handling-check' .claude/CLAUDE.md`
Expected: 0 (no references to old agent names anywhere in the file).

---

### Task 7: Delete the 4 obsolete agent files

**Files:**
- Delete: `.claude/agents/security-scan.md`
- Delete: `.claude/agents/full-security-audit.md`
- Delete: `.claude/agents/full-code-review.md`
- Delete: `.claude/agents/error-handling-check.md`

> **Per Rule 11, these `rm` operations on tracked files require explicit user approval. Pause execution here and ask the user to approve the batch before proceeding.**

- [ ] **Step 1: Confirm files exist and are tracked**

Run: `git ls-files .claude/agents/`
Expected: lists all 7 current agent files (3 new + 3 carried + the 4 to delete? actually only the 6 from the prior commit + the 4 carried from before — verify).

Run: `ls .claude/agents/`
Expected: includes `security-scan.md`, `full-security-audit.md`, `full-code-review.md`, `error-handling-check.md`.

- [ ] **Step 2: Get user approval**

Stop and ask the user: *"About to `git rm` four obsolete agent files: security-scan.md, full-security-audit.md, full-code-review.md, error-handling-check.md. Their content has been merged into security-review.md and code-review.md. Approve?"*

Wait for explicit approval before running the next step.

- [ ] **Step 3: Delete the files**

Run:
```bash
git rm .claude/agents/security-scan.md .claude/agents/full-security-audit.md .claude/agents/full-code-review.md .claude/agents/error-handling-check.md
```
Expected: 4 lines of `rm '<path>'` output, no errors.

- [ ] **Step 4: Verify**

Run: `ls .claude/agents/`
Expected: exactly 6 files: `code-review.md`, `consistency-check.md`, `database-review.md`, `performance-review.md`, `security-review.md`, `ui-ux-review.md`.

Run: `ls .claude/agents/ | wc -l`
Expected: `6`.

---

### Task 8: Final consistency check (disk vs CLAUDE.md)

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm 6 agent files all use opus**

Run: `grep -l '^model: opus' .claude/agents/*.md | wc -l`
Expected: `6`.

Run: `grep -L '^model: opus' .claude/agents/*.md`
Expected: empty output (no files lacking `model: opus`).

- [ ] **Step 2: Confirm CLAUDE.md references all 6 agents and no others**

Run: `grep -oE '@(security-review|code-review|consistency-check|database-review|performance-review|ui-ux-review)' .claude/CLAUDE.md | sort -u`
Expected: 6 unique names, one per line.

Run: `grep -oE '@(security-scan|full-security-audit|full-code-review|error-handling-check)' .claude/CLAUDE.md`
Expected: empty (no orphan references).

- [ ] **Step 3: Confirm slash command exists**

Run: `cat .claude/commands/review-before-deploy.md | grep -c '@'`
Expected: at least 6 (one `@agent-name` per agent, or more).

- [ ] **Step 4: Confirm no untracked or unintended changes**

Run: `git status`
Expected: shows only the deletions from Task 7 + the modifications from Tasks 1–6. No surprises.

---

### Task 9: Stage, commit, and push

**Files:** none modified — git operations only.

- [ ] **Step 1: Stage everything explicitly**

Run:
```bash
git add .claude/agents/consistency-check.md .claude/agents/database-review.md .claude/agents/ui-ux-review.md .claude/commands/review-before-deploy.md .claude/CLAUDE.md
```

(Deletions from Task 7 were already staged by `git rm`.)

Run: `git status`
Expected: 5 modifications (3 agent edits + slash command + CLAUDE.md) and 4 deletions, all staged.

- [ ] **Step 2: Verify the diff one last time**

Run: `git diff --staged --stat`
Expected: shows ~9 file changes. CLAUDE.md should show roughly +90 lines (Git Workflow section). Agent edits are small (~5 lines each).

- [ ] **Step 3: Determine if agents must run before push**

Run: `git diff --staged --name-only | grep -vE '\.md$|^\.gitignore$'`
Expected: empty output. All staged changes are `*.md` files. Per Rule 6, no review agents need to run.

- [ ] **Step 4: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore(claude): finalize 6-agent opus model + add Git Workflow rules

- Bump consistency-check to opus; rewrite descriptions for new auto-trigger semantics
- Update database-review and ui-ux-review descriptions for new trigger rules
- Delete superseded agents: security-scan, full-security-audit, full-code-review, error-handling-check
- Create /review-before-deploy slash command (launches all 6 agents in parallel)
- Add Git Workflow section to CLAUDE.md (12 core rules + pre-push procedure)
- Rewrite Review Agents section to document trigger structure

Fully implements the design at docs/superpowers/specs/2026-04-15-git-workflow-design.md.
On-disk agent set now matches CLAUDE.md verbatim (6 files, all opus).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds, hash printed.

- [ ] **Step 5: Push**

Run: `git push origin main`
Expected: `main -> main` confirmation. Render + Vercel will redeploy (no behavioral impact — pure config/docs change).

- [ ] **Step 6: Confirm new state**

Run: `git log --oneline -3`
Expected: top commit is the implementation; previous two are the cherry-pick + foundation.

Run: `git status`
Expected: clean working tree, in sync with origin.

---

## Success Criteria (matches spec section)

After this plan completes:

1. ✅ `.claude/CLAUDE.md` contains a "Git Workflow" section with all 12 rules and the pre-push procedure.
2. ✅ `.claude/agents/` contains exactly 6 files, all `model: opus`, each matching a description in CLAUDE.md.
3. ✅ `.claude/commands/review-before-deploy.md` exists and launches all 6 agents in parallel.
4. ✅ `.gitignore` already suppresses `.playwright-mcp/` and root-level `*.png` (done in foundation commit).
5. ✅ A new work session, when given a push cue, runs the 5 non-UI agents in parallel and surfaces findings before pushing (rules now active in CLAUDE.md).
6. ✅ Claude never creates branches, stashes, or destructive ops without per-action approval (rules now active).
7. ✅ No drift between CLAUDE.md agent list and `.claude/agents/` directory contents (verified in Task 8).
