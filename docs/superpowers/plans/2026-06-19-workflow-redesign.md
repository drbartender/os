# Workflow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the think-on-main / build-in-lanes workflow from `docs/superpowers/specs/2026-06-19-workflow-redesign-design.md`: the os-stays-on-main guard, crash-safe merge/board tooling, the rewritten two-tier CLAUDE.md, and the supporting cleanup, leaving auto-pull built-but-off.

**Architecture:** A set of mostly-independent lanes. The tooling lanes (guard, merge lock, board, worktree cleanup) are small self-contained scripts buildable in parallel. The doc lanes (CLAUDE.md rewrite, memory reconciliation, README/ARCHITECTURE) follow once the tooling exists so they describe real files. **Bootstrapping note:** this work is executed under the CURRENT workflow (today's worktree-per-project model, manual merges), because the new model's tooling does not exist yet. The CLAUDE.md rewrite lane is the switch-flip: once it lands, the new model is live.

**Tech Stack:** Bash (git hooks, `flock`), Node.js (existing `scripts/*.js` helpers), Markdown (CLAUDE.md, board, specs/plans), git worktrees.

## Global Constraints

- **os never leaves main.** No `checkout`/`switch`/`checkout -b` in the os (primary) worktree, ever. Verbatim invariant.
- **Sensitive paths are one list** (spec "Sensitive paths"), the single trigger for full-fleet review, conflict-escalation, and auto-pull disqualification. Pin exact globs to the real tree (no `schedulers/`, `routes/webhooks/`, or `utils/comms/` folders exist).
- **Lanes merge by squash** behind a `flock` lock; merge is not deploy; push to prod is a separate explicit call.
- **Review:** per-lane before merge, risk-scaled by the sensitive-path list, iron rule (incomplete = blocker), chunk-and-retry over a coverage manifest, push-time seam sweep + sensitive-path re-review.
- **Auto-pull ships OFF.**
- **No em dashes** in any prose (commas, periods, colons, parentheticals). Commits are single-line, no co-author footer.
- **File-size ratchet** applies to every new script (aim under 300 lines).
- **Reference content** (env vars, stack, paths) is carried verbatim in the CLAUDE.md rewrite, never re-derived.

---

## Lane Map (the part to co-design)

| Lane | Deliverable | Depends on | Parallel group |
|---|---|---|---|
| **L1 os-guard** | pre-commit guard that blocks off-main doc commits AND any commit on a non-main branch from the os worktree | none | A (parallel) |
| **L2 merge-lock** | `flock` squash-merge wrapper | none | A (parallel) |
| **L3 board** | `docs/build-board.md` + rebase/ff-only/atomic board-write helper with sensitive-string denylist | none | A (parallel) |
| **L4 worktree-cleanup** | drop misleading `'junction'` flag/comments in worktree scripts | none | A (parallel) |
| **L5 sensitive-paths** | the pinned glob list (one file consumed by review/conflict/auto-pull) | none | A (parallel) |
| **L6 CLAUDE.md rewrite** | two-tier rewrite + whys + carry-forward coverage check + retire `/overnight-review` + Pre-Push 4.5 | L1-L5 exist (to reference) | B (after A) |
| **L7 review-procedure** | document chunk-and-retry manifest rule + lane-map front-matter schema; optional manifest helper | L5 | B (after A) |
| **L8 memory-reconcile** | retire/trim the 8 stale workflow memory notes + MEMORY.md | L6 | C (after B) |
| **L9 README/ARCH** | folder tree + script/doc entries | L1-L4 | C (after B) |
| **L10 auto-pull** | full auto-pull mechanism, knob defaults OFF | L1, L2, L3, L5, L6 | D (post-launch, gated) |

**Dependency graph:** A = {L1, L2, L3, L4, L5} all parallel, no inter-deps. B = {L6, L7} after A. C = {L8, L9} after B. D = {L10} last, and the knob ships off so it is not on the critical path to "new model live."

**Recommended order:** build group A in parallel, then L6 (the switch-flip) with L7, then L8 + L9, and defer L10 until the model has run for a while. "New model live" is reached at the end of group C; L10 is optional throughput added later.

**Per-lane footprints** (for the independence/sensitive checks):
- L1: `scripts/guard-os-main.sh`, `.husky/pre-commit`, `scripts/__tests__/guard-os-main.test.sh`
- L2: `scripts/merge-lane.sh`
- L3: `docs/build-board.md`, `scripts/board-write.sh`
- L4: `scripts/worktree-new.js`, `scripts/worktree-rm.js`
- L5: `scripts/sensitive-paths.txt` (or `.json`), the canonical glob list
- L6: `.claude/CLAUDE.md`, delete `.claude/commands/overnight-review.md`
- L7: `.claude/CLAUDE.md` (review section), a lane-map template doc, optional `scripts/review-manifest.sh`
- L8: the 8 memory notes under `~/.claude/projects/.../memory/` + `MEMORY.md`
- L9: `README.md`, `ARCHITECTURE.md`

> L6 and L7 both touch `.claude/CLAUDE.md`, so they are NOT independent: build them as one merge or sequence them. Noted here because the new model would otherwise flag them as a collision.

---

## L1: os-guard (detailed, the exemplar lane)

**Files:**
- Create: `scripts/guard-os-main.sh`
- Modify: `.husky/pre-commit` (add one line after the existing `check-docs-drift.sh`, `check-file-size.js`, `lint-staged`)
- Test: `scripts/__tests__/guard-os-main.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a hook that exits non-zero (blocking the commit) when (a) the committing worktree is the primary/os worktree and its branch is not `main`, or (b) any staged path is under `docs/superpowers/specs/` or `docs/superpowers/plans/` while the branch is not `main`. Exits 0 otherwise.

- [ ] **Step 1: Write the failing test**

```bash
# scripts/__tests__/guard-os-main.test.sh
set -euo pipefail
tmp=$(mktemp -d); cd "$tmp"; git init -q; git commit -q --allow-empty -m init
cp "$OLDPWD/scripts/guard-os-main.sh" .
git checkout -q -b feature
# (a) doc commit on non-main branch must be blocked
mkdir -p docs/superpowers/specs && echo x > docs/superpowers/specs/t.md
git add docs/superpowers/specs/t.md
if bash guard-os-main.sh; then echo "FAIL: doc-off-main not blocked"; exit 1; fi
echo "PASS: doc-off-main blocked"
```

- [ ] **Step 2: Run it, verify it fails** — `bash scripts/__tests__/guard-os-main.test.sh` → FAIL (script missing).

- [ ] **Step 3: Implement `scripts/guard-os-main.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] && exit 0   # on main, nothing to guard

# primary (os) worktree? its toplevel == the dir holding the common .git dir's parent
common=$(git rev-parse --path-format=absolute --git-common-dir)
primary=$(dirname "$common")
toplevel=$(git rev-parse --show-toplevel)
staged=$(git diff --cached --name-only)

if [ "$toplevel" = "$primary" ]; then
  echo "BLOCKED: os worktree is on '$branch', not main. os must never leave main."; exit 1
fi
if echo "$staged" | grep -Eq '^docs/superpowers/(specs|plans)/'; then
  echo "BLOCKED: spec/plan docs may only be committed on main (branch is '$branch')."; exit 1
fi
exit 0
```

- [ ] **Step 4: Run the test, verify it passes** — `bash scripts/__tests__/guard-os-main.test.sh` → PASS.

- [ ] **Step 5: Add the positive on-main case to the test** (a doc commit on main, and a code commit in a linked worktree, both must pass), run, verify PASS.

- [ ] **Step 6: Wire into `.husky/pre-commit`** — add `bash scripts/guard-os-main.sh` as its own line (not folded into the other scripts), after the existing three steps.

- [ ] **Step 7: Manual verification** — in os: `git switch -c tmp; touch docs/superpowers/specs/z.md; git add z.md; git commit` → blocked. `git switch main`, delete tmp. Confirm normal main commit still works.

- [ ] **Step 8: Commit** — `git commit -m "feat(workflow): add os-stays-on-main pre-commit guard"`

---

## L2 - L10: per-lane briefs (expanded to bite-sized steps when pulled)

Per the new model, each remaining lane is detailed at pull time by its building agent, guided by the brief below plus the spec. Each ends with its own per-lane review.

- **L2 merge-lane.sh:** `flock`-wrapped squash merge of a lane branch into main, run only in os. Acceptance: two concurrent invocations serialize; killing one mid-merge releases the lock (flock auto-release). Verify with two backgrounded calls.
- **L3 board:** initial `docs/build-board.md` (Ready / In flight / Recently shipped sections, stable anchors) + `scripts/board-write.sh` doing `pull --rebase` then temp-file write then `--ff-only` commit with bounded retry, plus a denylist regex rejecting customer-name / token / `pi_`/`cus_` patterns. Acceptance: concurrent writes do not lost-update; denylist blocks a seeded sensitive string.
- **L4 worktree-cleanup:** in `scripts/worktree-new.js` drop the `'junction'` third arg and the junction comments (no-op on Linux); in `scripts/worktree-rm.js` comment the now-dormant junction-replacement guard. Acceptance: scripts still create/remove a worktree; no behavior change on Windows, real symlinks on Linux.
- **L5 sensitive-paths:** materialize the spec's list as `scripts/sensitive-paths.txt` (gitignore-style globs) naming the real files (pricingEngine, stripeClient, encryption, gratuityLabels, eventTypes, payroll*; schema.sql; the 6 webhook/inbound route files; auth/rateLimiters/asyncHandler middleware; `*Scheduler.js` + handlers; `*EmailTemplates.js` + `*Handlers.js`; `.env.example`; errors.js). Acceptance: a small script can read it and match a known sensitive file and reject a known cosmetic one.
- **L6 CLAUDE.md rewrite:** replace the Git Workflow section with the two-tier model (Invariants / Conventions, why on each), carry forward the named invariants (Rules 2/7/9/10/11/12, inline self-check, env-var debug discipline, Stripe fails-closed), drop the Windows scar tissue with transitional markers, delete `/overnight-review` and Pre-Push step 4.5. Acceptance: the audited coverage check (every inventoried invariant present, the at-risk list confirmed) passes; no dangling overnight references (`grep -ri overnight .claude/CLAUDE.md` empty).
- **L7 review-procedure:** document the chunk-and-retry manifest rule and the lane-map front-matter schema (footprint globs, dependency graph, lane id) in CLAUDE.md / a template; optional `scripts/review-manifest.sh` that prints `git diff --name-only` for a scope. Acceptance: schema has every field the three consumers need.
- **L8 memory-reconcile:** retire `reference_worktree_npm_install_junction`, `reference_worktree_rm_locked_folder_windows`, `reference_codex_cli_windows`, `reference_gemini_cli_windows`, `reference_vercel_cli_windows`; trim `reference_dev_server_process` to its platform-independent core; rewrite `project-worktree-workflow` and `reference_os_shared_git_index` to the new model; update `MEMORY.md`. Acceptance: no memory note contradicts the new CLAUDE.md.
- **L9 README/ARCH:** add `docs/build-board.md`, the new `scripts/*`, to the README folder tree and any NPM-script changes; update ARCHITECTURE if folders changed. Acceptance: `check-docs-drift.sh` is satisfied.
- **L10 auto-pull (post-launch, knob OFF):** claim via `--ff-only` board push + rebase/re-check loop, footprint from the lane-map front-matter, independence widened to the sensitive/side-effect list, re-check at merge, no `npm install`, no shared-DB verification. Acceptance: with the knob off, nothing auto-starts; with it on in a test, two overlapping candidates do not both start. Build last.

---

## Self-Review

- **Spec coverage:** every Implementation-surface bullet maps to a lane (guard L1, merge lock L2, board L3, worktree scripts L4, sensitive paths L5, CLAUDE.md + overnight retirement L6, chunk-and-retry + lane-map schema L7, memory L8, README/ARCH L9, auto-pull L10). Covered.
- **Placeholder scan:** L1 is fully specified with code; L2-L10 are briefs by design (the new model details a lane at pull time), not TODO placeholders. The one risk is treating a brief as done without expansion; the per-lane review gate catches that.
- **Collision note:** L6 and L7 share `.claude/CLAUDE.md` and must not run as independent parallel lanes (flagged in the lane map).
