# Workflow Redesign — Design Spec

**Date:** 2026-06-19
**Status:** Design approved (section by section, live). Revised after spec-review fleet (see Revision Log).
**Author:** Dallas + Claude (brainstorm)

## Why

The current git/workflow rules in `CLAUDE.md` accreted over time. Many were Claude-proposed and rubber-stamped rather than designed from how Dallas actually works, and the Linux-box migration is the moment to re-examine them. Five concrete pains drive this:

1. **Lost thinking on branches.** Brainstorm and plan get committed onto a project branch; the code never fully lands; main moves on; weeks later the branch looks "caught up" (it only ever held docs) while all the problem-solving is effectively gone. Root cause: specs and plans live on the branch instead of main.
2. **Branch-switch collisions across windows.** `os` is a single shared checkout with one HEAD. A bare `git switch`/`checkout` in `os` moves that shared HEAD, dragging other windows onto the branch, so a commit made in another window lands on the wrong branch and is lost.
3. **Big-batch review failures.** Review agents have a fixed budget and choke on a large mixed diff, returning no usable verdict. Treating a non-completing agent as a pass creates a blind spot, not a green light.
4. **Windows scar tissue.** A large share of the rules and memory exist only to cope with Windows (junctions, PowerShell, codex/gemini sandbox failures); on Linux their reason evaporates.
5. **Rules treated as law.** The doc reads as undifferentiated commandments, so genuine invariants and incidental conventions are indistinguishable, and the doc resists adaptation.

## Goals

- Make the irreplaceable thinking (brainstorm, spec, plan) impossible to lose.
- Keep the parallel-execution throughput that worktrees gave, without the branch-hunting overhead.
- Make code review reliable (real verdicts, never a waved-off failure).
- Restructure `CLAUDE.md` so invariants and conventions are distinct and every rule carries its *why*, without reopening working law.

## Non-Goals

- Reopening the money/data invariants (Cross-Cutting Consistency: hosted-bartender ratio, gratuity, proposal payment status, etc.), coding patterns, the file-size ratchet, doc-update rules, or reference content. These are carried forward untouched.
- A big-bang rewrite of the whole doc in one swing (see Incremental Execution).

## Sensitive paths (single source of truth)

Several rules below key off "sensitive code." To avoid a fuzzy judgment call that drifts, sensitivity is defined ONCE here as an explicit path set. The spec-review fleet confirmed the real locations below; several do NOT live in tidy folders (noted inline), so the implementation plan pins them as final file globs. A change touching any of these is money/auth/data risk:

- Pricing / payments / PII: `server/utils/pricingEngine.js`, `server/utils/stripeClient.js`, `server/utils/encryption.js`, `server/utils/gratuityLabels.js`, `server/utils/eventTypes.js`, plus payroll/payout/tip-accrual (`server/utils/payroll*.js`).
- Schema / DDL: `server/db/schema.sql` and any migration.
- Webhook + inbound handlers (flat in `server/routes/`, NOT a folder): `stripeWebhook.js`, `stripe.js`, `calcom.js`, `emailMarketingWebhook.js`, `sms.js` (`/inbound`), `thumbtack.js`.
- Auth / guards / limits: `server/middleware/auth.js`, `server/middleware/rateLimiters.js`, role-guard (`req.user.role`) code, `server/middleware/asyncHandler.js`.
- Schedulers (scattered, NOT a folder): `server/utils/*Scheduler.js` and their handlers, plus their registration in `server/index.js`.
- Comms / external sends (flat in `server/utils/`, NOT `comms/`): the `*EmailTemplates.js` family and the `*Handlers.js` senders.
- `.env.example` (an env-var contract change).
- Cross-cutting module whose edits silently move money/auth behavior: `server/utils/errors.js`.

This is the ONE list. It is the trigger for full-fleet review (any track), conflict-escalation, AND auto-pull disqualification. Auto-pull does not keep a second list; it disqualifies on the side-effecting members already here (schema/migration, schedulers, webhooks, external sends). Exact globs are pinned in the plan.

## The Model: think-on-main, build-in-lanes

### Phase 1 — Thinking, always on main
Brainstorm, spec, and plan all live on main and commit to main the moment they exist. Any number of parallel planning windows share the `os` main checkout, each writing its own spec/plan doc. A finished plan waits on main as a "ready to build" document. Nothing valuable ever sits on a branch, so nothing valuable can be stranded.

### Phase 2 — Building, in a throwaway worktree (a "lane")
When a plan is ready and Dallas says go, Claude cuts a worktree off current main, the run order is co-designed (the lane map, see Thinking Phase), Claude executes it, merges it back to main, and deletes the worktree. A lane holds code only and lives hours, not weeks. Claude owns its whole lifecycle. Dallas never names, finds, or returns to a lane.

If a lane stalls and rots, the worst case is re-running mechanical code from a plan still sitting safe on main. Redo-able code can be lost; thinking cannot.

## Invariant: os never leaves main

The `os` folder is permanently pinned to `main`. Claude never runs `checkout`, `switch`, or `checkout -b` inside `os`. The only way a branch exists is as a separate worktree folder with its own HEAD under `../worktrees/`, created and driven by path. Working in a worktree cannot move os's HEAD because it is a different checkout.

**Guard (mechanical backstop), covering code, not just docs:** a dedicated hook (`scripts/guard-os-main.*`, invoked as its own line in `.husky/pre-commit` alongside the existing `check-docs-drift.sh`, `check-file-size.js`, and `lint-staged`, NOT folded into any of them) enforces two rules at commit time:
1. **No commit on a non-main branch from the primary (os) worktree.** The hook identifies the primary worktree (e.g. comparing `git rev-parse --show-toplevel` against the main working tree, or detecting the non-linked worktree via `git rev-parse --git-common-dir`). If the committing worktree is the primary one and its branch is not `main`, the commit is blocked with a loud message. A linked worktree (a lane) committing code on its own branch is allowed, that is normal. This closes the Why #2 loss path for code, not only docs.
2. **No spec/plan doc committed off main** (`docs/superpowers/specs/**`, `docs/superpowers/plans/**`) from any worktree.

The guard never inspects code content and never blocks anything on main, so it is invisible on the quick-fix path. It ships with a positive test that proves it fires (create a branch, stage a doc and a code file, attempt commit, assert block). Note: `--no-verify` bypasses all pre-commit hooks; keeping the guard as its own script (not merged into another) keeps that escape reasoning clean.

## Two tracks

Dallas picks the track by how he opens the work:

- **Quick fix → on main, in os.** "Just fix this real quick." Claude edits on main, commits, done. No branch, no merge. Staying on main is exactly what the os invariant guarantees, so quick fixes never fight it.
- **Project → think on main, build in a lane.** "Let's work on this." Brainstorm and plan on main, then Claude builds it in a lane and merges back.

**Quick-fix review gate (closes the unreviewed-to-prod hole).** A quick fix is still reviewed; it just is not a lane:
- A quick-fix commit touching any **sensitive path** triggers the FULL agent fleet at push time, run on those specific commits, regardless of seam scope. It is never enough for a sensitive quick fix to ride only the seam sweep.
- A quick-fix commit touching nothing sensitive gets the light look and is covered by the push-time sweep.
- Either way the push gate (below) is the enforcement point: no quick-fix commit reaches prod without the appropriate review level having actually completed.

## Merge model

- **Serialized through os, with a real lock.** Every merge runs in the one `os`/main checkout, never from inside a lane. Merges acquire an exclusive lock via `flock`, chosen specifically because it auto-releases when the holding process dies, so a crashed or killed merge cannot wedge every future merge across windows (a plain lockfile is NOT used because it would leak on crash). The second merge waits. Documented manual recovery exists but should never be needed. No simultaneous write to main, no clobber, no ref race.
- **Lanes merge by squash.** A lane's in-progress checkpoint commits do not land on main; the squash merge is one clean commit per logical feature (preserving the intent of the existing "no WIP commits / one commit per feature" rule). The squash merge is the test gate; in-lane checkpoints are never assumed individually tested.
- **Merge is not deploy.** Main can hold several freshly merged lanes with nothing shipped. The push to prod is a separate, deliberate, gated step. A botched merge cannot silently reach customers; it is caught at the push gate.
- **Dirty-tree rule.** If `os` has uncommitted quick-fix work when a lane is ready to merge, Claude does not merge into a dirty tree. It pauses and asks Dallas to commit the quick fix first (or, with okay, auto-stashes with an explicit, reported recovery). Never a silent partial merge.
- **Source branch survives until the merge verifies clean,** where "verifies clean" means the squash merge produced no conflict AND the lane's per-lane review is re-confirmed against main's new HEAD (not merely "no conflict"). Then the worktree is removed.
- **Conflict handling, path-based not judgment-based.** Textual conflicts: Claude resolves using both diffs and both plans (which are on main). Claude resolves ordinary conflicts and reports what it did, but stops and brings it to Dallas whenever the conflict touches a **sensitive path** or the resolution is genuinely ambiguous. Semantic conflicts (no textual clash but combined behavior breaks) are the job of the push-time integration sweep.

## Review model

- **Per-lane, before merge, is the primary gate.** A single lane is a small, coherent scope, exactly where review agents finish and return real verdicts. By push time every lane on main was already cleanly reviewed.
- **Risk-scaled by the sensitive-path list.** Cosmetic changes get a light look; anything touching a sensitive path gets the full agent fleet no matter how tiny. Claude always states which level it ran. (Same list as conflict-escalation and auto-pull.)
- **Iron rule: a failed or incomplete agent is never a pass.** A non-completing agent is a blind spot, not a green light. An agent that completes but returns no explicit pass/fail (empty, inconclusive, low-confidence) counts as a non-completion.
- **Chunk-and-retry with a coverage manifest (proven, not asserted).** A review that does not finish is split into smaller chunks and re-run; if a chunk still fails, it is split again, halving down toward single-file. Coverage is guaranteed by a manifest: every file in `git diff --name-only` for the scope must appear in exactly one chunk's input, and each file must end with an explicit pass/fail-or-anomaly recorded against it. The lane is blocked unless every file in the manifest has a real verdict. The "union of chunks" therefore provably equals the full diff, with no file silently dropped.
- **Floor and failure UX.** If a single smallest-unit chunk (one file) still cannot complete after a retry, that is a genuine anomaly: Claude stops, names the file, and blocks the merge (never allow-with-warning). Dallas sees the file and the reason.
- **Push-time integration sweep.** A focused pass over the seams between merged lanes and quick-fixes (files touched by more than one source), checking that separately-clean pieces still agree. It is NOT a re-audit of every line; that is what choked the old batch review. Same chunk-and-retry, manifest, and iron rule apply. Overlap is computed from `git log <lastPush>..HEAD --name-only`, intersected by file.
- **Sensitive-path re-review at push (not seam-overlap alone).** Any commit since the last push that touches a **sensitive path** gets the full fleet at push, against main's new HEAD, regardless of whether anything else overlapped it. This closes the case a single lane (or quick fix) touches sensitive code no other source overlapped: its pre-merge review ran only on its own diff, so push re-checks it against integrated main. Because squash-merge hides within-squash overlap, this sensitive-path rule, not seam intersection, is what guarantees sensitive code is re-reviewed at push.
- **No overnight review.** The `/overnight-review` command (`.claude/commands/overnight-review.md`), the `.claude/overnight-review.log` cache, and Pre-Push step 4.5 (cache honoring) are retired. Its two jobs are explicitly reassigned, not dropped: **Sentry prod-error triage → Dallas does it manually on his own cadence.** **Whole-tree drift (file-size creep, dead routes, schema drift in idle files) → the quarterly `full-audit` plus the file-size ratchet hook that runs on every commit.** Per-lane review plus the push-time seam sweep cover everything else it did.

## Push model

The push to prod stays Dallas's deliberate, explicit call ("push", "deploy", "ship it", "send it"). It is firm, carrying forward today's Rule 4 strictness:
- Confirmation gate: Claude announces the batch in one line and waits for an explicit yes before running the push-time sweep. It never auto-pushes and never volunteers a "ready to push?" nudge.
- The sweep (and any sensitive quick-fix full-fleet review) runs only after that yes.
- A flagged finding gives Dallas the same fix-now / push-anyway / abandon choice as today's Pre-Push step 6, with the root-cause fix discipline preserved.
- Push failure stops and reports, never auto-resolves (carry-forward of Rule 12).

Commit vs push cues stay distinct. **Inside a lane Claude self-commits freely** as it builds (checkpoints, sandboxed, nothing ships); the commit cue still governs quick-fixes on main and the merge. This does not violate the "no WIP commits on main" rule because lane checkpoints never reach main (squash merge).

## Lane lifecycle and stale lanes

- Claude auto-handles the safe moves: create the lane, merge it when clean, clean it up after merge. No asking.
- **Stale detection (concrete trigger + runner).** A lane is flagged stale when it is older than 48h with no new commit, OR main has advanced 15+ commits since the lane was cut, OR any sensitive-path change has landed on main since the lane was cut (a small sensitive change is higher conflict risk than many unrelated docs commits). The check runs at session start and again at each push-time sweep, so a stale lane is surfaced, not left to rot silently.
- **Default for a truly dead lane:** scrap it and re-cut fresh from the plan (which is safe on main), salvaging half-written code only if it is substantial and clean.
- **Hard line, with a concrete unmerged check.** Before any scrap, Claude verifies the lane holds no distinct unmerged work: `git log main..<lane-branch>` must be empty (or every commit's tree already exists on main). If it is non-empty, Claude does NOT scrap without Dallas's okay. Auto-scrap always uses `git branch -d` (which itself refuses unmerged), never `-D`. ("Manage it for me" and "never lose my code" both hold.)

## The board

A single markdown file on main (`docs/build-board.md`), maintained by Claude, never by Dallas. Three states: **ready to build** (plan written and reviewed, no lane cut), **in flight** (lane open and building), **recently shipped** (then ages off). Each ready item links to its spec and plan, so the board is the index and the thinking is one click away. Stale-lane flags surface here. It updates as a byproduct of Claude working (writing a plan adds a card, cutting a lane moves it, merging moves it again). Zero upkeep for Dallas.

- **Concurrency.** Because multiple windows touch the board, all board writes go through a single helper that does `pull --rebase` then write then commit with `--ff-only`, retrying on rejection. The format is anchored/structured (stable section headings, one line per item) so rebased writes do not lost-update. On a push failure, the "recently shipped" entry is not advanced.
- **No sensitive content.** The board carries titles and paths only, never copy-pasted spec/plan bodies, so it never records a customer name, token, Stripe id, or payload.

## Auto-pull (with a knob) — specify fully BEFORE turning the knob on

Auto-pull ships **OFF** (wait-for-go). Everything in this section must be implemented and verified before the knob is ever flipped on; until then, Dallas points at the next plan and Claude builds it.

When on, and a lane finishes freeing capacity, Claude pulls the next ready plan and builds it. Safety:

- **Atomic claim.** The claim is a board commit pushed to `origin/main` with `--ff-only`. If the push is rejected (another window claimed first), Claude rebases, re-reads the board, re-runs the independence check (the winner's claim may have just made this candidate dependent), and retries, up to a bounded retry count.
- **File footprint, defined.** Each plan's lane-map declares its footprint (the files/globs it expects to touch) in structured front-matter. Claude verifies actual edits stay within the declared footprint; a lane that edits outside its footprint aborts and surfaces, rather than silently widening.
- **Independence check, widened beyond files.** A candidate is disqualified from auto-pull if its footprint overlaps any in-flight lane OR any uncommitted change in os, AND additionally if it touches any **sensitive path** or side-effecting surface: `schema.sql`/migrations, schedulers, webhook handlers, env-var contract, or external-comms (mass client email/SMS). Those wait for explicit Dallas-says-go regardless of independence, because the build itself can have side effects against the shared prod Neon DB or external providers.
- **Re-check at merge time.** Independence is re-evaluated when the lane is ready to merge, not only at cut time, because a Dallas-led quick fix may have started in between.
- **No `npm install` in an auto-lane** (it mutates the shared `node_modules` and breaks sibling lanes; existing memory `reference_worktree_npm_install_junction`); a lane needing new deps de-junctions first or waits for explicit go.
- **No shared-DB verification in an auto-lane.** A lane's git edits are isolated, but its *runtime* verification is not: `npm test` or a dev-server boot inside a worktree hits the SHARED Neon DB (memory `reference_server_test_db_shared`). An auto-pulled lane therefore does not run server tests or boot the server against the shared DB; that verification defers to os post-merge or a scratch DB. Any lane whose verification must touch the live DB joins the disqualifier and waits for explicit go. ("Build is not deploy" holds for git refs, not for runtime side effects against shared infra.)
- **Why the residual case is safe:** lanes are separate worktrees, so an auto-pulled build edits its own copy of a file, never the copy under Dallas's hands in os. The only meeting point is the serialized, locked, conflict-checked merge. Worst case is a merge conflict, already handled, never a live clobber.

## Thinking phase

- **Brainstorm.** Codify the style already in use: Claude digs in, forms an opinion and leads with it, asks one question at a time, prose not menus. Section-by-section approvals ARE the approval. Cut the "now read the whole written spec" gate.
- **Spec.** A byproduct of the live brainstorm. Committed to main, fed to the spec-review agents (`spec-grounding`, `spec-gaps`, `spec-risk`). Dallas does not re-read it.
- **Plan = lane map.** The plan comes out as the work broken into independent, individually buildable-and-reviewable lanes plus a dependency/parallelism graph (what blocks what, what runs side by side) in a defined structured shape (front-matter the consumers parse, not ad-hoc prose), since both the spec-review agents and auto-pull consume it. The footprint per lane lives here. That graph IS the run-order, co-designed with Dallas, so the separate "execution plan" step is folded into the plan itself. Run through plan-review agents (`plan-fidelity`, `plan-decomposition`, `plan-feasibility`); `plan-decomposition` validates the lane carving. The lane map is the part of a plan a non-developer can read and steer.

## Inside a lane (execution method)

Claude picks the most efficient method for the lane in front of it and does not default to subagents or any other ceremony because a skill says to. A small coherent lane is built in one pass; a lane with genuinely independent pieces is split across parallel subagents. Claude states the method so Dallas can wave it off. The inline self-check (carried forward, see Disposition) still runs before every change. Macro parallelism is handled by the lane map; inside a lane it is usually just "build it the simplest way that works," verified by running it plus the per-lane review. On a mid-build failure (compile error, test fail, dev-server crash), the lane stays open for repair; if it cannot be repaired it follows the stale-lane default (re-cut from plan), never ad-hoc handling.

## The doc itself (CLAUDE.md reorg)

The goal state is a full reorg into two clearly labeled tiers, executed safely and incrementally.

- **Two tiers.** **Invariants** = genuine law that protects money, auth, data, and code. **Conventions** = how we work now and why (everything in this spec). Changeable on purpose.
- **Every rule carries its why** in one line, in both tiers.
- **Conventions are questionable by default.** When one gets in Dallas's way, Claude says so and they change it, updating the doc and its why right then. The doc stays alive.
- **Rules get rewritten; reference is carried verbatim** (tech stack, env vars, paths, file-size mechanics), not re-derived, to avoid introducing wrong values.

### Audited migration (safety net)

1. **Inventory** every rule currently in `CLAUDE.md` (done; see Disposition).
2. **Disposition** each: kept-as-invariant, kept-as-convention, or dropped-with-reason.
3. **Coverage check** the new doc against the inventory to prove no invariant was weakened or lost. The coverage check MUST explicitly confirm these named invariants survived the rewrite (they are easy to drop because the old Git Workflow section is being replaced wholesale): code-preservation (old Rule 2), explicit-staging-only (Rule 7), never-`git reset`-on-main (Rule 9), never-`--amend`-pushed (Rule 10), destructive-ops-need-per-action-approval (Rule 11), push-failures-stop-and-report (Rule 12), the entire Inline Self-Check, the env-var debug discipline note, and the Stripe `STRIPE_TEST_MODE_UNTIL` / fails-closed-on-missing-creds invariant.

### Disposition summary (from the inventory)

- **Carry forward, untouched (re-homed with a why):** all Cross-Cutting Consistency invariants; all Coding Patterns; Tech Stack and the env-var table (verbatim); File-Size Discipline; Mandatory Doc Updates; Reasoning Effort; the Inline Self-Check; the env-var debug discipline note; the design-stage review fleet; and the named git-safety invariants from the Twelve Core Rules (2, 7, 9, 10, 11, 12).
- **Replaced by this spec:** the Git Workflow section's old model (Project Worktrees, the Twelve Core Rules where they describe the old worktree-per-project flow, the Pre-Push Procedure).
- **Dropped as Windows scar tissue** (with a transitional marker until Dallas is fully off Windows): worktree `node_modules`/husky junction *rules*, `worktree:rm` locked-folder behavior, the bare-`git worktree add`/`EnterWorktree` warning, single-dev-server / port-5000 sharing, the PowerShell dev-server-restart ceremony. **Keep** the platform-independent core of `reference_dev_server_process` (the dev backend is a managed process that does NOT auto-reload, so restart after server edits). The `worktree-new.js`/`worktree-rm.js` cleanup is a comment/flag sweep, not a rewrite: `fs.symlinkSync(..., 'junction')` is already a no-op on Linux. Matching memory notes retired/updated: `reference_worktree_npm_install_junction`, `reference_worktree_rm_locked_folder_windows`, `reference_dev_server_process` (trim to core), `reference_codex_cli_windows`, `reference_gemini_cli_windows`, `reference_vercel_cli_windows`, `project-worktree-workflow`, `reference_os_shared_git_index`.

### Incremental execution

Full reorg is the end state, but it lands section by section, not in one swing:

1. Workflow section first (the only part actually redesigned), into the new two-tier structure.
2. Then migrate the remaining sections into the new structure one at a time, adding whys, brainstorming only the residue as it surfaces.

Each migration is itself a lane, reviewed the new way. This reorg dogfoods the new workflow on the very doc that defines it.

## Implementation surface

- Rewrite the Git Workflow section of `CLAUDE.md` (new model, two tiers, whys).
- Add `scripts/guard-os-main.*` (the two-rule branch/doc guard) as its own line in `.husky/pre-commit`, coexisting with `check-docs-drift.sh`, `check-file-size.js`, and `lint-staged`. Add a positive test that it fires.
- Add the merge lock (lockfile/`flock` wrapper) and the board-write helper (`pull --rebase` + `--ff-only` + retry).
- Create `docs/build-board.md` and the convention for keeping it current (Claude updates it as a byproduct of each workflow action, not an automated script).
- Add the chunk-and-retry coverage-manifest logic to the review flow.
- Define the plan lane-map front-matter schema (footprint + dependency graph) consumed by review agents and auto-pull.
- Update `worktree-new.js` / `worktree-rm.js` comments/flags for Linux (drop the misleading `'junction'` flag and junction comments).
- Retire `/overnight-review`: the command file, the `.claude/overnight-review.log` cache, and Pre-Push step 4.5.
- Reconcile the stale workflow memory notes listed above.
- Update `README.md` (folder tree gains `docs/build-board.md`; NPM Scripts if worktree scripts change) and `ARCHITECTURE.md` if folders change, per the carried-forward Mandatory Doc Updates rule.
- Build the auto-pull mechanism and its on/off knob (ships off; full spec above must be met first).

## Deferred to the implementation plan (not design gaps)

The second spec-review round confirmed all prior blockers closed and surfaced items that belong in the plan/build, not the design:

- **Pin the sensitive-path globs** to the real locations enumerated above (no `schedulers/`, `routes/webhooks/`, or `utils/comms/` folders exist, so globs must name files).
- **Define the lane-map front-matter schema** (footprint glob format, dependency-graph shape, lane identifier) consumed by `plan-decomposition`, auto-pull, and the footprint-drift abort.
- **Serialization composition:** specify the ordering of the merge lock, the board-write helper, and (when enabled) the auto-pull claim push so they cannot starve or deadlock; atomic board writes (temp file + rename); bounded board-retry + escalation.
- **Squash-merge bookkeeping:** the squash commit message must carry the lane name + plan link so the push inventory stays legible; whole-feature revert granularity is the accepted trade for clean history.
- **Auto-pull internals (knob ships off, so these gate the knob, not launch):** resolution path when the merge-time independence re-check fails; a real prevention for `npm install` in an auto-lane (pre-commit fires too late to help); whether "merge it" is a distinct cue or part of the lane lifecycle.
- **Board denylist:** a cheap regex so a status line can never commit a customer name, token, or Stripe id to main.
- **Keep "always use the worktree helper" on platform-neutral grounds** (husky `.husky/_` is needed on Linux too); drop only the Windows framing.
- **`.husky/pre-push`** (client `CI=true` build gate) relationship to the new push confirmation step.

## Decisions Log

- Worktrees kept (they earned their place on parallel execution) but redefined as code-only, short-lived, Claude-managed lanes.
- Thinking lives on main; branches hold code only.
- os pinned to main, backed by a pre-commit guard that blocks BOTH off-main spec/plan docs AND any commit on a non-main branch from the os worktree.
- Sensitive code is one explicit path list, reused by review-scaling, conflict-escalation, and auto-pull.
- Review is per-lane before merge, risk-scaled, with chunk-and-retry over a coverage manifest and a hard no-pass-on-failure rule, plus a push-time seam sweep. Quick fixes touching sensitive paths get the full fleet at push.
- Merges serialize through os behind a real lock; lanes merge by squash; dirty-tree merges pause.
- Overnight review retired; Sentry triage → Dallas manual; whole-tree drift → quarterly full-audit + file-size hook.
- Branches/stashes outside the lane model still need Dallas's okay; the lane lifecycle is blanket-authorized.
- Inside a lane, Claude self-commits freely; the commit cue still governs main and every merge.
- Push confirmation gate kept and firm (explicit yes, fix-now/push-anyway/abandon, Rule 12 carried).
- Board: a markdown file on main, written through a single rebase-and-retry helper, titles/paths only.
- Auto-pull: claim via `--ff-only` push with rebase+re-check, footprint declared in the lane map, independence widened to schema/scheduler/webhook/env/external-comms, re-checked at merge, no `npm install`; ships OFF.
- Doc reorg: full two-tier rewrite, executed as an audited, incremental migration; coverage check names the at-risk invariants.

## Open dependency

Final pruning of Windows scar tissue tracks the Linux migration; until Dallas is fully off Windows, dropped items keep a transitional marker rather than vanishing.

## Revision Log

**2026-06-19, after spec-review fleet (spec-grounding / spec-gaps / spec-risk):** Folded in 6 blockers and the key warnings. (1) Added the quick-fix review gate so sensitive quick fixes get the full fleet at push, closing the unreviewed-to-prod hole. (2) Widened the os guard from docs-only to also block any commit on a non-main branch from the os worktree. (3) Added the chunk-and-retry coverage manifest so "union = full coverage" is provable. (4) Replaced the fuzzy money/auth conflict boundary with the single Sensitive-paths list. (5) Added a real merge lock. (6) Added a concrete unmerged-code check before lane scrap and pinned `-d` not `-D`. Plus: dirty-tree merge rule, board concurrency helper, squash-merge for lanes, firm push gate carrying Rules 4 and 12, stale-lane thresholds + runner, no-`npm install`-in-auto-lanes, explicit carry-forward of the git-safety invariants and inline self-check, and the grounding nits (overnight is a /command not a skill; guard is its own hook alongside the existing three; keep the dev-server no-auto-reload core; worktree junction flag is already a Linux no-op). Auto-pull internals fully specified but explicitly gated behind the knob, which ships off. Overnight-review coverage reassigned (Sentry manual; drift to full-audit + file-size hook) rather than dropped.

**2026-06-19, after second spec-review round:** All prior blockers confirmed closed by all three lenses. Folded the day-one refinements the round surfaced: grounded the Sensitive-paths list to the real tree and unified it as the single source for review / conflict / auto-pull; specified `flock` for the merge lock (crash-safe); generalized the push-time full-fleet review to any sensitive-path change since last push (squash-merge made seam-overlap alone insufficient); barred shared-Neon-DB verification inside auto-lanes; added the env-var-debug and Stripe-fails-closed invariants to the coverage check; pinned the stale threshold. Remaining items are plan-level or auto-pull-knob-gated and are listed under "Deferred to the implementation plan."
