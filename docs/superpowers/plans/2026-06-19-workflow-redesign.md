# Workflow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the think-on-main / build-in-lanes workflow from `docs/superpowers/specs/2026-06-19-workflow-redesign-design.md`: the os-stays-on-main guard, crash-safe merge/board tooling, lane lifecycle, the rewritten two-tier CLAUDE.md, and supporting cleanup, leaving auto-pull built-but-off.

**Architecture:** Mostly-independent lanes. **Built on the Linux box** (now up), which is what unblocks `flock` (merge lock) and real symlinks (worktrees). Built under the CURRENT workflow until lane L8 (the CLAUDE.md rewrite) flips the new model live. Tooling lanes are small self-contained scripts; doc lanes follow once the tooling exists.

**Tech Stack:** Bash (git hooks, `flock`), Node.js + `node:test` (existing test convention: `node --test`), Markdown, git worktrees.

## Global Constraints

- **os never leaves main.** No `checkout`/`switch`/`checkout -b` in the os (primary) worktree. Verbatim invariant.
- **Sensitive paths are one list** (L5), the single trigger for full-fleet review, conflict-escalation, AND auto-pull disqualification. Real globs, no `schedulers/`, `routes/webhooks/`, or `utils/comms/` folders exist.
- **Lanes merge by squash** behind a `flock` lock; squash commit message carries lane name + plan link; merge is not deploy; push to prod is a separate explicit call.
- **Review:** per-lane before merge, risk-scaled by L5, iron rule (incomplete = blocker), chunk-and-retry over a coverage manifest, push-time seam sweep + sensitive-path re-review.
- **Auto-pull ships OFF.**
- **Tests use `node:test`** (`node --test`), the repo's existing convention. No new bash-test runner.
- **No em dashes** in prose. Commits single-line, no co-author footer.
- **File-size ratchet** applies (aim under 300 lines/script).
- **Reference content** carried verbatim in the CLAUDE.md rewrite, never re-derived.

---

## Lane Map (the part to co-design)

| Lane | Deliverable | Depends on | Review fleet |
|---|---|---|---|
| **L5 sensitive-paths** | `scripts/sensitive-paths.txt` (real globs incl. migrations) + a tiny matcher + its test | none | security, consistency |
| **L1 os-guard** | pre-commit guard: blocks off-main spec/plan docs AND any commit on a non-main branch from the os worktree; `node:test` | L5 (none hard) | code, security |
| **L2 merge-tooling** | `flock` squash-merge wrapper: lock + squash + lane-name/plan-link commit msg + dirty-tree pause + verify-clean-before-cleanup + invocation wiring | L5 | code |
| **L3 board** | `docs/build-board.md` + write-helper (pull --rebase, commit, push `--ff-only`, atomic temp+rename, bounded retry+escalation, generic Stripe-id/PII denylist) | none | security |
| **L4 worktree-cleanup** | drop the `'junction'` flag/comments (safe on Linux); keep "always use the helper" rule (husky `.husky/_` needed on Linux) | none | code |
| **L6 lane-lifecycle** | stale detection (48h no-commit / 15+ main commits / any sensitive-path landed since cut), runner (session-start + push-sweep), `git log main..lane` unmerged check, `-d` never `-D` | L5 | code |
| **L7 pre-push-reconcile** | reconcile `.husky/pre-push` (client `CI=true` gate) with the new push confirmation step | none | code |
| **L8 CLAUDE.md (switch-flip, serial commits)** | one lane, sequential commits sharing the file: (a) two-tier rewrite + carry-forward + mechanical coverage check; (b) retire `/overnight-review` (command + `.log` cache + Pre-Push 4.5); (c) Windows-pruning + transitional markers; (d) review-procedure + lane-map schema | L1-L7 exist | consistency (vs invariant list) |
| **L9 memory-reconcile** | retire/trim the 8 stale notes + transitional markers + `MEMORY.md` | L8 | consistency |
| **L10 README/ARCH** | folder tree, NPM Scripts table, pre-commit description, ARCH pre-commit ref | L1-L4 | consistency |
| **L11 auto-pull (post-launch, knob OFF, split)** | 11a claim+footprint · 11b disqualifier + merge-time re-check (incl. re-check-FAIL resolution) · 11c prevention (no `npm install`, no shared-DB verify) · 11d knob + merge-cue | L1,L2,L3,L5,L8 | full fleet at knob-flip |

**Dependency graph:** L5 first (foundational data L2/L6/L8/L11 read). Then {L1, L2, L3, L4, L6, L7} parallel. Then L8 (serial internal commits, the flip). Then {L9, L10}. Then L11 sub-lanes, last, knob off.

**Collision resolution (was unresolved):** L8's four pieces all touch `.claude/CLAUDE.md`, so they are ONE lane with four sequential commits, NOT parallel lanes. No other cross-lane file overlap (verified by the review: L1 → `.husky/pre-commit`, L7 → `.husky/pre-push`, L4 → worktree scripts, L2/L3 → new scripts).

**"New model live"** is reached at the end of L8 + L9 + L10. L11 is optional throughput added later.

---

## L1: os-guard (detailed exemplar)

**Files:**
- Create: `scripts/guard-os-main.sh`
- Modify: `.husky/pre-commit` (append `bash scripts/guard-os-main.sh || exit 1` after the existing three lines, preserving the explicit `|| exit 1` so a non-zero exit aborts the hook)
- Test: `scripts/guard-os-main.test.js` (`node:test`, run by `npm test`)

**Interfaces:**
- Produces: a hook exiting non-zero when (a) the committing worktree is the primary/os worktree and branch is not `main`, or (b) any staged path is under `docs/superpowers/specs|plans/` while branch is not `main`. Exits 0 otherwise.

- [ ] **Step 1: Implement `scripts/guard-os-main.sh`** (git plumbing validated against `worktree-new.js`):

```bash
#!/usr/bin/env bash
set -euo pipefail
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] && exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir)
primary=$(dirname "$common")
toplevel=$(git rev-parse --show-toplevel)
staged=$(git diff --cached --name-only)
if [ "$toplevel" = "$primary" ]; then
  echo "BLOCKED: os worktree is on '$branch', not main. os must never leave main."; exit 1
fi
if echo "$staged" | grep -Eq '^docs/superpowers/(specs|plans)/'; then
  echo "BLOCKED: spec/plan docs may only be committed on main (branch '$branch')."; exit 1
fi
exit 0
```

- [ ] **Step 2: Write `scripts/guard-os-main.test.js`** — a `node:test` suite that, per case, builds a throwaway repo with `child_process` (setting `git config user.email/user.name` so commits work), creates a LINKED worktree via `git worktree add` so `toplevel != primary`, runs `bash scripts/guard-os-main.sh` in the right cwd, and asserts the exit code. Cover all five:
  1. primary worktree on `feature`, stage any file → exit 1
  2. linked worktree on `feature`, stage a `docs/superpowers/specs/x.md` → exit 1 (docs rule, the case the old test never reached)
  3. linked worktree on `feature`, stage a code file → exit 0
  4. primary worktree on `main`, stage anything → exit 0
  5. linked worktree on `main`, stage a doc → exit 0

- [ ] **Step 3: Run `npm test`** → the new suite FAILS (script not wired / assertions red), confirming the test exercises each rule distinctly.

- [ ] **Step 4: Make it pass**, then **Step 5: wire `.husky/pre-commit`** (Step 1 line), then **Step 6: manual check** in a real worktree, then **Step 7: commit** `feat(workflow): add os-stays-on-main pre-commit guard + node:test`.

---

## L2 - L11: per-lane briefs (expanded to bite-sized steps at pull time)

- **L5 sensitive-paths:** `scripts/sensitive-paths.txt` (gitignore-style) naming the real files: `pricingEngine.js`, `stripeClient.js`, `encryption.js`, `gratuityLabels.js`, `eventTypes.js`, `payroll*.js`; `server/db/schema.sql` + `server/scripts/migrations/**` (or wherever migrations live, pin at build); the 6 route files (`stripeWebhook.js`, `stripe.js`, `calcom.js`, `emailMarketingWebhook.js`, `sms.js`, `thumbtack.js`); `server/middleware/{auth,rateLimiters,asyncHandler}.js`; `server/utils/*Scheduler.js` + handlers; `server/utils/*EmailTemplates.js` + `*Handlers.js`; `.env.example`; `errors.js`. Plus `scripts/sensitive-match.js` (reads the list, returns whether a path set is sensitive) and its `node:test`. Acceptance: matches a known sensitive file, rejects a cosmetic one.
- **L2 merge-tooling:** `scripts/merge-lane.sh`, run only in os, invoked explicitly (document: Claude runs it during integration, not a hook). Steps: acquire `flock`; refuse if os tree is dirty (pause, tell Dallas to commit/stash the quick fix); `git merge --squash <lane>` then commit with message `merge(lane <name>): <plan-link>`; re-run the lane's per-lane review against new HEAD ("verifies clean"); only then signal the worktree is safe to remove. Acceptance: two concurrent invocations serialize; a killed run releases the lock (flock auto-release); dirty tree pauses.
- **L3 board:** `docs/build-board.md` (Ready / In flight / Recently shipped, stable anchors) + `scripts/board-write.sh` doing `pull --rebase`, atomic temp-file write + rename, `git commit`, `git push --ff-only`, bounded retry then escalate. Denylist regex rejects emails, phones, and the generic Stripe-id family (`(pi|cus|ch|re|evt|in|sub|cs|seti|pm)_[A-Za-z0-9]+`) and tokens. Acceptance: concurrent writes do not lost-update; denylist blocks a seeded sensitive line.
- **L4 worktree-cleanup:** drop the `'junction'` 3rd arg + junction comments in `scripts/worktree-new.js`; comment the now-dormant junction-replacement guard in `scripts/worktree-rm.js`; KEEP the "always use the helper" rule (husky `.husky/_` needed on Linux too). Acceptance: helper creates/removes a worktree on Linux with real symlinks; `npm test` green.
- **L6 lane-lifecycle:** `scripts/lane-status.sh` (or node) listing open worktrees vs board, flagging stale (older than 48h with no commit, OR 15+ commits on main since cut, OR any L5 sensitive-path landed on main since cut), run at session start and in the push sweep. Safe-scrap: `git log main..<lane>` must be empty before any removal; always `git branch -d`, never `-D`; non-empty → ask Dallas. Acceptance: a fabricated stale lane is flagged; a lane with unmerged commits refuses auto-scrap.
- **L7 pre-push-reconcile:** decide and document how `.husky/pre-push` (client `CI=true` build gate) coexists with the new push confirmation (keep it as the mechanical client-build gate; the confirmation + sweep sit above it). Update the hook only if needed. Acceptance: a client change still gets the CI build gate.
- **L8 CLAUDE.md (serial commits, the flip):**
  - (a) Rewrite the Git Workflow section into the two-tier model (Invariants / Conventions, why on each); carry forward every named invariant; add `scripts/check-claudemd-invariants.sh` that greps a committed `scripts/claudemd-invariants.txt` (Rule 2/7/9/10/11/12 keywords, `STRIPE_TEST_MODE_UNTIL`, "fails closed", inline-self-check headings, env-var debug discipline phrase) against the rewritten doc, so the coverage check is mechanical, not a human read. Also fold in the quick-fix review gate, conflict-handling escalation (L5-keyed), dirty-tree rule, lane lifecycle, inside-a-lane rules.
  - (b) Retire `/overnight-review`: delete `.claude/commands/overnight-review.md`, remove the `.claude/overnight-review.log` cache handling, delete CLAUDE.md Rule 6's overnight mention + the entire Pre-Push step 4.5 block + the "Honoring overnight-review cache" string. Acceptance: `grep -ri overnight .claude/` returns only this plan/spec, nothing in CLAUDE.md or commands.
  - (c) Drop Windows scar tissue with a defined transitional marker (a `> TRANSITIONAL (remove once fully off Windows):` block) so a marker is distinguishable from accidental retention.
  - (d) Document the chunk-and-retry coverage-manifest rule and the lane-map front-matter schema (footprint globs, dependency graph, lane id) consumed by `plan-decomposition`, auto-pull, and the footprint-drift abort.
  - Acceptance: `check-claudemd-invariants.sh` passes; overnight grep clean.
- **L9 memory-reconcile:** retire `reference_worktree_npm_install_junction`, `reference_worktree_rm_locked_folder_windows`, `reference_codex_cli_windows`, `reference_gemini_cli_windows`, `reference_vercel_cli_windows`; trim `reference_dev_server_process` to its platform-independent core; rewrite `project-worktree-workflow` + `reference_os_shared_git_index` to the new model; put a transitional marker on anything kept-but-Windows-flavored; update `MEMORY.md`. Acceptance: no memory note contradicts the new CLAUDE.md.
- **L10 README/ARCH:** add `docs/build-board.md` + new `scripts/*` to the README folder tree; update the NPM Scripts table (worktree entries no longer mention junctions); update the pre-commit description (now 4 steps incl. the os-guard); update the ARCHITECTURE pre-commit reference. Acceptance: each named section reflects reality; `check-docs-drift.sh` satisfied.
- **L11 auto-pull (post-launch, knob OFF, four sub-lanes):** 11a claim via `--ff-only` board push + rebase/re-read + footprint from lane-map front-matter; 11b independence check widened to the L5 sensitive/side-effect members + re-check at merge time + a defined resolution when the re-check FAILS (abort the lane, re-queue on the board, surface to Dallas); 11c prevention (block `npm install` in an auto-lane; no shared-Neon-DB verification, defer that to os post-merge); 11d the on/off knob (defaults OFF) + whether "merge it" is a distinct cue. Acceptance per sub-lane; knob-off means nothing auto-starts.

---

## Self-Review (post plan-review revision)

- **Spec coverage:** every spec Implementation-surface AND Deferred item now maps to a lane: stale-lane/dirty-tree/squash-bookkeeping/pre-push (previously dropped) are now L6 / L2 / L2 / L7; the rest unchanged. Covered.
- **Decomposition:** L8's four CLAUDE.md commits are sequential within one lane (collision resolved); L11 split into 11a-11d; L1 test now `node:test` with a real linked-worktree fixture covering all five behaviors.
- **Feasibility:** built on Linux (flock + symlinks available); L1 git plumbing matches `worktree-new.js`; tests use the repo's `node:test` runner; L4 junction removal is safe on Linux.
- **Review cadence:** each lane names its fleet (column above), matched to what it touches.
- **Placeholder scan:** L1 fully coded; L2-L11 are intentional pull-time briefs, each now naming its files, acceptance, and owning the spec mechanism it implements.

## Open items folded from /review-plan (2026-06-19)
Blockers: Windows feasibility (resolved by Linux), four dropped mechanisms (added), L6/L10 oversize (L8 serial + L11 split), L1 test bug (ported to node:test). Warnings: `--ff-only` wording, L10 enumerated targets, L2 wiring, transitional-marker shape, review-cadence column, generic Stripe-id denylist, mechanical invariant coverage check, group ordering. All addressed above.
