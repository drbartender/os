# Instruction rewrite: main is prod, review is a receipt, docs come from code

Date: 2026-10-19. Status: design approved section by section in the brainstorm (Dallas, 2026-10-18 to 2026-10-19). Rev 2: the spec fleet (grounding, gaps, risk) and a cold builder check reviewed rev 1 on 2026-10-19; every confirmed finding is folded in below and marked "(fleet)". Rev 3 (2026-10-19): the review-lens audit (`2026-10-19-lens-audit.md`) and the process decisions that followed it are folded in: nine lenses selected by diff trigger (3.2), plans as lane maps without code (D12), the failing-test receipt field (D13), review once per lane (D14), superpowers kept through the flip (D15). Phase 3, the rewrite itself, starts only on Dallas's go.

This is the contract for rewriting every file that tells Claude how to work in this repo and on this box. It is written for an agent reading it cold. The audit that preceded it ran on 2026-10-17 and is summarized in section 1; the full report is not in the repo.

## 1. Why

Two failures prompted this, both named by Dallas on 2026-10-18.

**Phantom rules.** Sessions have told him "I have reached your 150k limit" when he never set one, and twice (2026-08-25, 2026-08-28) told him he had said not to run review agents when he had not. Each time a Claude-authored rule (a hook, a line in CLAUDE.md, a memory about either) lost its origin and was attributed to him. The fix is structural: every rule carries who set it and when, and rules live in fewer places.

**The push tax.** Pushes were batched to save review. Per-lane review before merge is now the primary gate, so batching saves nothing, and because the push gate fingerprints the shared working tree, a gate in flight freezes every other window ("hang on while I push in another window"). Dallas: "Once I'm done with a patch or a feature or section of a feature I want to deploy it. We aren't manually testing on the dev server before deployment nearly as much any more."

**What the audit found.** `os/.claude/CLAUDE.md` is 387 lines and 76 KB, about 19K tokens per session, and roughly 45% of it is reference duplicated in `README.md` and `.env.example` (three env tables with three row counts: 113, 128, 108). `README.md` is 227 KB and `ARCHITECTURE.md` 533 KB; both hand-maintain mirrors of the file tree and route table, and both drift (44 of 249 server utils and 5 route files missing from the README tree; ARCHITECTURE still says the database is on Render). Four of the six code-review agents open with `git diff --name-only HEAD~1`, the wrong scope for every real call site. The code-review agent grades against try/catch plus `res.status(500)`, the pattern the codebase retired for `asyncHandler` plus `AppError` (111 of 142 route files use asyncHandler, 4 use `res.status(500)`). CLAUDE.md promises a plan front-matter schema it never shows and a footprint check nothing enforces. `codex-review.md` cites a deny rule that does not exist. Memory holds 242 files; its 20 KB index carries work-item state against its own rule; 18 of 200 wiki links dangle; 7 files still describe Windows procedures. The project CLAUDE.md loads lazily on the first Read-tool access under os and never in a Bash-only session: 4 of the last 12 sessions never loaded it. Memory is keyed by launch directory, so a session launched from `os` gets a four-file memory from June instead of the real one.

## 2. Decisions

Each decision names its source. "Dallas" means he said it in the brainstorm. "Claude's call" means Claude proposed it, played it back, and Dallas did not object. "(fleet)" marks a change made after the rev 1 review. Dates are 2026-10-18 and 2026-10-19 unless given.

- D1. **Main is prod.** Every commit that lands on main ships after the mechanical gate, with no cue and no batching. (Dallas: the push cue was drawn "so long ago that idk if it is still really that important.") Section 4.
- D2. **Nothing reaches main without a review receipt, and the hook enforces it.** `merge-lane.sh` refuses a lane without one; the pre-push hook refuses a push whose range contains a non-docs commit without one, whichever window pushes. "Properly reviewed" is defined in section 3. (Dallas: "I do want to make sure that it has been properly reviewed as well." The definition is Claude's call, approved: "That sound right to me." Hook enforcement: fleet.)
- D3. **The gate tests the push range in isolation.** Money smoke and client build run in a throwaway worktree at the sha, classified by everything in `origin/main..sha`; the receipt is keyed on the sha; other windows never wait. (Claude's call; range classification: fleet.)
- D4. **The push-time review layer is deleted, not moved.** No seam sweep, no sensitive-path re-review at push, no second opinion at push, no inventory announcement, no "never volunteer a push prompt", no "pushing in another window freezes main". Review happens once, before a merge or before a quick-fix commit. The survivors are the stale-base re-review (3.7) and, in the one-line ship report, the names of other windows' commits that rode along (fleet). (Claude's call.)
- D5. **README and ARCHITECTURE are generated where they mirror code.** Folder tree, route table, env table and schema index come from scripts; each file's one-line description comes from its own header comment, migrated once from the README by script. Hand-written prose stays only where it explains what the code does not say. (Dallas: "I don't look at the readme or architecture. They are there for claude or any developer that might look at my code.")
- D6. **Every rule carries provenance.** One bracket: `[Dallas 2026-10-06]` or `[Claude default]`. A rule without an origin is a Claude default and may be dropped on sight. (Claude's call; the structural answer to the phantom rules.)
- D7. **The global file is about Dallas; the project file is about the code.** `~/.claude/CLAUDE.md` (private, loads everywhere including Wildlight) holds how he wants to be worked with. `os/.claude/CLAUDE.md` (public repo, loads lazily) holds invariants, workflow, conventions and pointers. (Claude's call, approved: "That all looks right.")
- D8. **Rules may live in memory**, with the same provenance, and the memory index goes back to being an index. Pruned files move to an archive folder that is never loaded; nothing is deleted. The money laws move into the repo so they load in every session. (Dallas: "I think I'm ok with those things being in the memory." The archive and the money-laws doc are Claude's call; the doc: fleet.)
- D9. **Phone numbers, narrowed.** Numbers of real people (clients, staff) never enter the repo, a board line, a spec, a commit message, or a diff sent to an external reviewer; the tooling masks them, and the board denylist's other shapes, before anything goes to codex or gemini. Fixtures and the business lines may be printed. The grep hygiene (file names and counts, not matching lines) stays because it costs nothing. (Dallas: "I'm really just worried about client and staff number." The narrowing is Claude's call.)
- D10. **Phase 3 has a code half.** The merge path, the gate, the receipt, the doc generators and the post-ship watch are scripts. The new CLAUDE.md lands in the same commit as the tooling it describes, or says plainly what stands until the tooling ships. Never again a rule for tooling that does not exist. (Claude's call; the footprint rule is the cautionary example.)
- D11. **The files that define "reviewed" and "sensitive" are themselves sensitive.** The review skill, the agents, the sensitive list and its matcher, the hooks, `.claude/settings.json`, the merge, ship, gate, watch and doc scripts and `client/vercel.json` are on the sensitive list from the flip commit on. "Docs-only" is a strict allowlist. (fleet)
- D12. **Plans are lane maps without code.** A plan carries, per lane, the scope, the footprint, what blocks it, the lenses it will get, acceptance checks that can be run, the money laws and seams that apply, and the test plan. Code appears only where the code is the decision (a predicate, a constant). The audit's precision pass found about half of the design fleet's recorded findings were plan hygiene (wrong line anchors, invented harness shapes), review of a copy of the code that drifts before it is built. Phase 3's own step plans follow this format. (Claude's call; Dallas: "If you are saying they shouldn't then that makes sense to me.")
- D13. **A bug-fix lane's receipt names the test that fails on the old code.** By file and count, read from the runner log. The record holds a fix closed on a grep that matched the wrong shape, nine suites that never connected to the database, tests billed as mutation-verified that stayed green with their condition deleted, and a day-boundary fix provable only by an evening-instant test. (Claude's call, from the audit.)
- D14. **Review runs once per lane.** The per-task implementer-plus-two-reviewers ritual from subagent-driven-development is retired; the implementer self-reviews, the lane gets its lenses, the receipt records it. (Dallas, 2026-07-22: "you are running reviews too much"; made structural here.)
- D15. **Superpowers stays through the flip.** Its brainstorming and systematic-debugging skills keep earning their place; its worktrees, per-task review, final spec re-read and menu defaults are overridden once, in the global file. After the flip a project `plan` skill replaces writing-plans and subagent-driven-development. (Claude's call.)

## 3. Properly reviewed

### 3.1 Definition

A change is properly reviewed when all of the following hold, and the receipt records each:

1. The lenses for its tier (3.2) ran on the whole diff from a written brief (3.3).
2. Each lens returned a per-file verdict table (3.4) covering every file in the diff.
3. Every finding was triaged by the main session against the code: confirmed with the failure path stated, or rejected with a one-line reason (3.5).
4. Confirmed findings were fixed and the fix was re-reviewed by the lens that raised it.
5. The tests the change reaches ran on the final reviewed tree, after every fix, and passed, with counts read from the runner's own log, not from a piped exit code: the money smoke for tier A; the suites whose subjects the diff touches for tiers A and B; the client build for anything under `client/`.
6. The receipt (3.6) is written for the reviewed content and the lens reports and runner logs are captured beside it.

### 3.2 Lenses and tiers

The audit (`2026-10-19-lens-audit.md`) replaced the six lenses by discipline with nine by mechanism. Each lens fires on what the diff contains; `scripts/sensitive-paths.txt` is a floor that forces the tier A set, not the selector. The check inventories, about 190 checks each citing the defects behind it, are in `lens-audit/`.

| lens | fires on | replaces |
|---|---|---|
| money | an `UPDATE proposals SET` on a money column, a Stripe or refund call, a price, rate, quantity or payout read, any file on the money list; reads `docs/money-laws.md` first | nothing today |
| lifecycle | a status write, a sweep, a scheduler, a terminal transition, a pay-period predicate, a candidate set | nothing today |
| concurrency | a status write, `FOR UPDATE`, `pool.connect()`, a provider call that moves money or sends, a retry, a partial update, a tick | nothing today |
| business-time | `CURRENT_DATE`, `new Date`, a formatter, a period pick, a window, a DATE column, a threshold in days | nothing today |
| outcomes and providers | a helper returning a status, a catch, a skip branch, a COMMIT followed by work, an SDK options object, a webhook branch, TwiML, an env flag, a DOM agent step | the error-handling halves of code-review and security-review |
| access and egress | a route or guard, a public form, a log, export or AI send, a limiter, a send, a webhook | security-review, rewritten; its mechanical greps move to `scripts/static-checks.js` |
| seams | a changed field, response shape, enumeration, entrance, a helper with copies, client-facing copy | consistency-check, rewritten around tracing one value from its writer to every reader |
| schema and data | `schema.sql`, `db/index.js`, `server/scripts/`, `scripts/`, a seed, a catalog change | database-review, trimmed, plus import, backfill and catalog work no lens read |
| client | any diff under `client/src`; captures at 320 and 390 wide provided by the main session | ui-ux-review, plus the code-reading half it never had |

performance-review becomes explicit-only, run on request when a public page or a list endpoint changes. code-review dissolves: dead code and naming to lint, duplication and status codes to seams, loading and empty states to client. The verify agent (Fable) stays on tier A.

| tier | trigger | what runs | tests |
|---|---|---|---|
| A | any path on the sensitive list, or a diff that touches a money column, a Stripe call, a price, rate or payout, or a status transition (content rule in `sensitive-match.js`) | money, lifecycle, concurrency, outcomes and providers, access and egress, seams, plus whichever of business-time, schema and data, client its triggers fire; second opinion (codex plus gemini, Claude-triaged); verify | money smoke plus every suite the change reaches; for a bug fix, the test that fails on the old code (D13) |
| B | any other server code; a new file under `server/routes/` or `server/middleware/` | the lenses its triggers fire, access and egress always for a new route or middleware file | every suite the change reaches |
| C | everything else under `client/`, and scripts not on the sensitive list | client, seams; copy-truth checks when copy changed | client build |
| docs | every file in the push range is on the docs allowlist (4.7) | none | the gate skips both checks |

The sensitive list gains, in the flip commit, the 122 files the audit found carrying money defects while unlisted, by directory and pattern: `server/routes/drinkPlans/`, `server/routes/stripeCreateIntent.js`, `server/utils/serviceExtension*.js`, `server/utils/drinkPlanExtras.js`, `server/utils/proposalGroupCommit.js`, `server/routes/proposals/metadata.js`, `server/utils/metricsQueries.js`, `server/utils/autoAssign.js`, `server/routes/admin/payrollTax.js`, `server/db/index.js`, `server/scripts/**`, `scripts/cc-*.js`, the public Sign and Pay page and its hooks, the proposal editor and `PricingBreakdown.js`, the Money Board cards, the payroll panels, `paystubData.js`, both contract text files, `ServicesPage.js`, and the hinge files of D11.

Escalation: any lens may return `escalate` in its verdict table when it sees money, auth or PII material outside its tier. That bumps the review to tier A before merge. The list itself gets a standing check at every quarterly full-audit.

Mechanical pre-steps the skill runs before any lens: `scripts/static-checks.js` (the greps that used to be security-review prose: parameterized SQL, command injection, SSRF, secrets in the client bundle, `.env` ignored, `STRIPE_TEST_MODE_UNTIL`, `JWT_SECRET` from env, missing `auth` import, `dangerouslySetInnerHTML`, swallowed catch, `BEGIN` without `ROLLBACK`, `process.env.X || default`, floating versions on security packages, `file:` and `git+` deps); eslint `no-undef` and `no-use-before-define` over changed files; `sensitive-match` over the diff with the content rule; a PII grep over the push range (names, real-format numbers, a name beside a dollar figure).

Model tiering stands as decided 2026-07-13 and 2026-08-14: Opus on the lenses, because the main session reads them; Fable on verification, because nothing downstream catches a false pass.

Two reviews are complete by construction and need no lenses, only the gate: a clean `git revert` of a shipped sha with no hand edits (the emergency path, 4.8), and a comment-only diff that a script proves adds nothing but comment lines (the header migration, 5.1). (fleet)

### 3.3 The brief

One file per review, generated by the review skill and handed to every lens. It contains: the diff as a file (commit list, stat, `-U10`); the plan and spec links; the tier and the matched paths that set it; the file list the lens must return verdicts for; what is already established (tests run and their counts, build status, questions already settled); for a designed surface, the artifact path and screenshots captured by the main session at 320 and 390 wide (a subagent cannot sign in to the dev app, so the lens judges the capture and the static render, never a live admin page); for the money lens, the row-truth rules from `docs/money-laws.md` verbatim; the results of the mechanical pre-steps (3.2) so no lens re-derives them; the budget ("finish within roughly N tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach"); and the standing line "do not print any phone number; refer to numbers by role". The agents' "How to start" sections are replaced by "read the brief at the path in your prompt". A diff too large for one brief is split by area up front, not after a failure.

### 3.4 The verdict table

Every lens ends its report with one row per file in the brief's list:

```
| file | verdict | note |
| server/utils/x.js | pass | |
| server/routes/y.js | finding | H1, M2 |
| client/src/z.js | not reached | budget |
| server/utils/w.js | escalate | writes payout rows |
```

`not reached` is the iron rule made mechanical: that file is re-dispatched alone to the same lens. A file not reached twice blocks the merge and is named in the window; that is today's rule and it stays. A lens that returns no table, or a table missing files, counts as not reached for the missing files. An agent that fails to complete is never a pass.

### 3.5 Triage

The main session reads the cited code for every finding before it counts. Confirmed means the main session can state the failure path itself. Rejected means a one-line reason: wrong about the code, guarded upstream, unreachable, style. Agreement between agents is not evidence; four agents repeating a claim share a blind spot. (Source: the 2026-07-22 push, 74 findings at about five percent real, two of the loudest false despite four-agent agreement.)

### 3.6 The receipt

The receipt is a directory, not a self-reported summary (fleet): `<git-common-dir>/drb-review/<key>/` holding `receipt.json`, every lens report, every runner log, and the brief. It lives in the common git dir because a lane's own git dir is deleted with the worktree, and a receipt is a local file, not a privilege boundary (anything that can forge it can run `--no-verify`).

The key is the reviewed content, not a commit sha (fleet):

- For a lane, the stable patch id of `base..tip` (`git diff base tip | git patch-id --stable`) plus the base sha. A content-identical rebase keeps the key; a conflict resolution or a new commit changes it. Lanes may still be rebased, as the standing memory says.
- For a quick fix, the tree hash of the staged index (`git write-tree`) at review time. The commit that follows must have exactly that tree (`HEAD^{tree}`), so a hunk another window staged into the shared index after the review, or a `git add` that swept in more than was reviewed, fails the check instead of shipping under the receipt.
- For a squash commit on main, the patch id of `parent..commit` is compared with the lane receipt's patch id when main did not move; when it did, the stale-base path (3.7) writes a new receipt for the squash.

`receipt.json` records: key, kind, tier and the matched paths, the lenses that ran and why each fired, per lens the findings raised, confirmed, fixed and rejected (the audit could not measure any lens's precision from the record; from the first lane after the flip the receipts can), tests with counts and the log they were read from, for a bug-fix lane the test that fails on the old code by file and count (D13), the main sha reviewed against, timestamp. `merge-lane.sh` and `ship` do not trust the summary: they parse the captured verdict tables, check coverage against their own `git diff --name-only`, recompute the tier against the current sensitive list and refuse when the receipt's tier is lower or its file list is short, and read test counts from the runner log. (fleet)

The squash commit message carries the summary so `git log` is the audit trail:

```
merge(lane invoice-step): docs/superpowers/plans/2026-10-16-price-override-removal.md

Review: tier A (sensitive: server/utils/invoiceLineItems.js, server/routes/proposals/*)
  lenses:   security, database, consistency, code, second-opinion (codex, gemini), verify (fable)
  files:    14/14 verdicts
  findings: 11 raised, 3 confirmed, 3 fixed and re-reviewed, 8 rejected
  tests:    money-smoke 79/79, invoiceLineItems.test.js 18/18, cancelLineItem.protected.test.js 9/9
  receipt:  patch 3f2a9c1 on main 8c1c660, reviewed 2026-10-19 14:02
```

A quick fix carries the same block, shorter, on its own commit. In the window the report is one line: "Shipped invoice-step, tier A, 3 findings fixed, 79 money suites green." If other windows' commits rode along in the push range, the line names them. (fleet)

### 3.7 Stale base

The receipt records the main sha the review ran against. When main has moved, `merge-lane.sh check` (4.1) computes the overlap: files touched by both the lane and main since that base. The session then runs a bounded re-review on the overlap (consistency and code; tier A adds security), re-runs the lane's reached suites on the merged tree, and, if any sensitive path landed on main since the base, runs consistency on the whole lane diff against new main. No overlap and no sensitive landing means no re-review. Known limit: overlap by file misses a seam where main changed a helper's contract and the lane added a caller in a file main never touched; the suite re-run and the money smoke on the squash are the net for that. (fleet)

### 3.8 Post-ship watch

Runs after every push, every tier, outside the merge lock, per sha, in the window that shipped (fleet):

1. Wait for the deploy. `GET /api/health` gains a `release` field set from `RENDER_GIT_COMMIT` (a one-line change in `server/index.js`, sensitive-listed, shipped in the flip lane); the watch polls until the field equals the pushed sha, with a bounded wait. The Vercel half is `vercel` CLI confirming the production deployment for the sha is READY. A deploy that is never observed is reported as "deploy not observed", never as clean. A queued ship that supersedes the watched one is tolerated and named.
2. Watch Sentry through the existing `~/.sentryclirc` token with `sentry-cli` (the token is never printed and is not an `.env.example` row): count events with a timestamp after the deploy time across all issues in `drbartender-server` and `drbartender-client`, not only issues first seen, so a regression of a resolved issue and the `initDb: N unexpected schema statement(s) failed` group both count. Server `Sentry.init` sets `release` from the same sha in the same change.
3. Report "no new Sentry events in ten minutes", never "clean": a wrong price, a zero gratuity or a wrong paid flag throws nothing. A watch that finds events sets the block marker (4.4) so the next ship does not stack on a broken prod, and `lane:status` prints "shipped X at T, N events since" at the next session start.

### 3.9 External reviewers

Diffs sent to codex or gemini pass through the board-write denylist shapes first (phone-number runs, emails, bearer-style tokens, the Stripe id family, nine-digit hyphenated routing and EIN shapes), and the brief says so. A token-shaped hit anywhere in the push range blocks the ship outright: a committed key never reaches a public origin. Both reviewers are metered; a 429 or an auth failure is reported and the Claude lenses remain the gate. (Standing since 2026-07-02 and 2026-08-19; the wider mask: fleet.)

## 4. Main is prod

### 4.1 The lane path, in two phases

The merge script cannot run a review fleet, so it is two commands under one lock discipline (fleet):

**`merge-lane.sh check <branch>`** takes the flock, refuses on any staged change in `os` (4.6), finds the lane's receipt (3.6), recomputes the tier and coverage, compares the receipt's base with current main, and exits with one of: `ready` (base unchanged, receipt valid); `stale` plus the overlap file list and the sensitive-landing flag (3.7); or `refused` with the reason. It releases the lock on exit. On `stale`, the session runs the review skill in stale-base mode, which writes a new receipt against the current main sha, and re-runs `check`. Bounded: three rounds, then the script refuses and the window reports that main will not hold still.

**`merge-lane.sh ship <branch> <plan>`** takes the flock, re-runs the `check` logic (refusing if main moved again), runs `git merge --squash`, regenerates the docs into the staged tree (5.1) and stages only the generated paths, commits once with the review block (3.6), gates the new HEAD against `origin/main..HEAD` (4.3), pushes that sha, releases the lock, starts the post-ship watch (3.8), then removes the lane worktree and branch after implementing the three merged-lane checks that today exist only as prose: the squash is on main, `git diff main <branch> -- <lane files>` is empty with generated docs excluded from the comparison, and the worktree is gone. A conflict in the squash still stops the script; the session resolves it in `os`, and the resolution is covered by the stale-base path because a conflict is by definition overlap.

The ship phase is unattended. Three lanes landing at once queue behind the lock and ship one gate length apart.

### 4.2 The quick-fix path

A quick fix on main is reviewed per its tier before the commit, on the staged diff, with the receipt keyed on the staged tree (3.6). Tier A gets the full fleet before the commit, because after the commit is prod. The session runs `npm run docs` so the generated sections are current (5.3 refuses the commit otherwise), commits with the review block, then runs `npm run ship`, which gates `origin/main..HEAD` (4.3), checks the review receipts for every non-docs commit in that range (D2), pushes the sha, and starts the watch. The ask itself is the go.

"Hold this", said up front, means the work is done in a lane and left unmerged until Dallas says ship. Nothing held ever sits on main, because the next ship from any window would carry it. A hold marker written any time before the push aborts a ship in progress at the last check before `git push`. (fleet)

### 4.3 Gate on the range

`push-gate.js` gains a mode that gates a commit in isolation: `git worktree add --detach <tmp> <sha>` with the symlinks `worktree-new.js` makes, the list extracted to `scripts/lib/` so the two cannot drift; run the needed gates there; write a receipt keyed on the sha to the common git dir; remove the worktree in a trap so a crash leaves no registered worktree. What is "needed" is classified from everything in `origin/main..sha`, exactly as `neededGates` does today, never from the tip commit alone: money smoke when that range touches `server/`, `package.json`, the lock, or the gate's own machinery; client build when it touches `client/`; neither when every file in the range is on the docs allowlist (4.7). (fleet)

Two differences from a lane worktree (fleet): the gate worktree gets its own env file holding only what the smoke suites need (`NODE_ENV=test`, `SEND_NOTIFICATIONS=false`, `RUN_SCHEDULERS=false`, `JWT_SECRET`, the Stripe test credentials the suites read; the builder verifies the exact set by running them), never the box's live `.env`; and when the range touches `package.json` or `package-lock.json`, the gate runs `npm ci` into a private `node_modules` in the worktree instead of using the symlink, or refuses with the reason, because prod installs from the new lock.

`testdb-smoke.js` resolves its repo root from its own location, so invoking the worktree's copy runs the worktree's suites against the worktree's schema. It takes the common-dir flock itself, blocking, so a review-time smoke and a gate never reset the shared Neon ci-smoke branch under each other (today `npm run test:smoke` takes no lock). The pre-push hook validates a sha receipt for the sha being pushed; the working-tree fingerprint goes away; the age guard stays at a generous seven days, because ci-smoke resets from a prod parent that moves. The hook never runs the gate itself inside the SSH window (that is the 2026-08-14 hang): no receipt means refuse with "run npm run ship". `git push --no-verify` and `HUSKY=0` remain the named emergency escapes, visible and per-push. (fleet)

The sha receipt may also be keyed on the tree hash so a review-time smoke on the same tree is honored and a tier A ship skips a second smoke; builder's option.

### 4.4 Failure, and the block marker

A gate that fails after a merge leaves an ungated commit on main. The gate writes a block marker in the common git dir naming the failing sha. Every push path (the hook, `ship`, `merge-lane.sh`, the board writer) refuses while that sha is an ancestor of what it would push, and prints the marker; `lane:status` prints it at session start. The marker clears only when a gate passes on a descendant. The fix-forward commit is reviewed at its own tier like any quick fix; the invariant against reset on main stands. The lane whose squash failed keeps its worktree until the fix ships. (fleet)

A push rejection stops and reports as today, with one exception (fleet): after a fetch, a sha that is already an ancestor of `origin/main` was shipped by another window's range push and is reported as shipped, not rejected; the watch for it runs in whichever window pushed it.

### 4.5 One push path, one lock

Every push to origin goes through `ship` (or `merge-lane.sh ship`, which calls the same code) under the same flock: the hook, the board writer, the quick fix, the lane. `board-write.sh` stops doing its own branch push and calls `ship` instead; its "only unpushed commit" guard is retired because the range gate, the receipt check and the block marker now decide. (fleet)

### 4.6 The index and the dirty tree

`git merge --squash` stages into the shared index and `git commit` takes the whole index, so a quick fix another window has staged would ride into the lane's squash under the lane's receipt. `merge-lane.sh` therefore refuses on any staged change, whatever its path. Unstaged edits and untracked files block only when their paths intersect the lane's paths or the generated docs. `scripts/merge-lane.test.js` is rewritten to this rule. (fleet)

### 4.7 Docs-only

A push range is docs-only when every file in it is on the allowlist: `docs/**`, `README.md`, `ARCHITECTURE.md`, `docs/build-board.md`. Nothing under `.claude/`, `scripts/`, `.husky/`, nor `render.yaml` or `client/vercel.json`, is ever docs (D11). (fleet)

### 4.8 The emergency path

The fastest fix after a bad ship is `git revert <sha>`. A clean revert with no hand edits is reviewed by construction: `ship` recognizes it (the commit's tree equals the parent's tree with the reverted diff applied) and runs the gate only. Render's dashboard rollback is the hand lever if the box is unavailable, and `docs/dev.md` says where it is. (fleet)

### 4.9 Docs-only pushes and build filters

Specs, plans and board lines still commit to main the moment they exist (thinking lives on main) and now push immediately through `ship`; the gate skips both checks. So that a plan revision does not restart prod, `client/vercel.json` gains an `ignoreCommand` that exits 0 when the diff is docs-only (committed in the flip, under D10), and Render gets the same filter in the dashboard, by Dallas's hand: the production service (`os`, created in the dashboard 2026-03-16) is not Blueprint-managed. It differs from `render.yaml` in name, start command and health check path, so the yaml was never applied; it is cut (section 7) and the service's real settings are recorded in `docs/dev.md`. (Resolved 2026-10-19 through the Render CLI.) Before the flip, one docs-only push through the old path must show no deploy on either host; that evidence is a sequencing step (section 8). (fleet)

## 5. Docs from code

### 5.1 Generated

- **README folder tree**: generated from the file list under `server/` and `client/src/`. Each file's description is its header comment: the first comment after an optional shebang line, `'use strict'` directive or eslint directive. 553 of 1,053 non-test source files have no header today, so the flip includes a one-time migration: a script moves each file's current README description into its header as a `//` block, skipping files that already have one, and a second script proves the diff adds nothing but comment lines. That diff is reviewed by construction (3.2) and gated. After it, the drift gate (5.3) fails any source file without a header, with no grandfathering. (fleet)
- **ARCHITECTURE route table**: generated from a static parse of the mounts in `server/index.js` plus a walk of each router (`scripts/route-inventory.js` already walks one router and counts handlers; requiring `index.js` would start the server, so the mounts are parsed, not required). Auth is marked from the middleware present; the description comes from the comment above the handler. A router the walker cannot parse (routes registered in a loop, a composition router it cannot follow) is marked `unparsed` in the table and fails `--check`; a route is never dropped silently. (fleet)
- **Env table**: generated from `.env.example`, which becomes the one copy. Before the tables in CLAUDE.md and README are deleted, every row is ported into `.env.example` as a comment block above its variable (the `THUMBTACK_AGENT_SECRET` row, for example, carries a blast radius and a leak response that `.env.example` lacks today), and the port is checked row by row. (fleet)
- **Schema index**: table, columns, constraints, generated from `schema.sql` with a pointer to the line.

The generator is `npm run docs`. In the lane path it runs after `git merge --squash` has staged the lane, on the merged tree, and stages only the generated paths into the same squash commit (fleet). In the quick-fix path the author runs it before committing, and the pre-commit hook's `--check` refuses a commit that leaves a generated section stale. Output is deterministic, so a no-change run is a no-op. Generated sections sit between markers so hand-written prose around them survives.

### 5.2 Hand-written, trimmed

ARCHITECTURE keeps: the high-level diagram, auth flow, error handling, pricing engine, proposal rules, booking window, third-party integrations, deployment (corrected to Neon), dev tooling. Each is cut to what the code does not say. "Plan-execution review cadence" goes, superseded by section 3. README keeps: what it is, local dev (rewritten against `docs/dev.md`), the scripts table (generated from `package.json`), deployment and the test gate. Key Features, 218 lines of release notes, goes. The outsider's entry point stays `docs/reviewer-map.md`.

### 5.3 The drift gate

`scripts/check-docs-drift.sh` is replaced by `npm run docs -- --check` in `.husky/pre-commit`: regenerate to a temp file and diff; a stale generated section or a header-less source file refuses the commit instead of warning. The "Mandatory documentation updates" table in CLAUDE.md becomes one sentence: write the header comment; hand-write ARCHITECTURE prose only when a concept changes.

## 6. Rules and provenance

### 6.1 Format

Every rule in either CLAUDE.md, in a skill, in an agent, or in a feedback memory ends with a bracket: `[Dallas 2026-10-06]`, `[Dallas 2026-08-28, "Since when do I have to ASK for review"]` when the words carry weight, or `[Claude default]`. Quotes go in the private global file or in memory, never in any file under `os/` (agents, skills and commands are public too). A rule found without a bracket is a Claude default and the session may drop it, saying so in one line.

### 6.2 `~/.claude/CLAUDE.md` (private, about 35 lines)

Review is standing; never ask; never attribute "no agents" to Dallas. No compaction; handoff only when asked. Brainstorm in prose, one question at a time, no menus; section approvals are the approval; skip the final spec re-review. Latest word beats the spec. Verify behavior, not shape; don't rubber-stamp; say it once; cursing is a signal. Env-var debug discipline: never assert a production variable is unset; ask him to confirm it in Render or Vercel. No client or staff phone numbers in any repo, board line, spec, commit or external diff; the personal cell nowhere. No em dashes in client, staff or spec prose. Dallas is both DRB accounts; never call him Dan. Each line bracketed with its date. This file is the only place outside memory where a rule about working with Dallas lives. It is backed up as `CLAUDE.md.bak-<date>` before each rewrite because `~/.claude` is not in git. Between Phase 3 step 1 and the flip it carries one dated transitional line: pushes are cue-only through `npm run gate` until `merge-lane.sh ship` lands.

### 6.3 `os/.claude/CLAUDE.md` (public, about 130 lines)

Four sections, in this order.

**Invariants.** Git safety: `os` stays on main (the guard script); explicit staging; no reset or amend on main; destructive ops need a per-action yes except verified merged-lane cleanup; never scrap unmerged work; code preservation beats shipping speed; a push rejection stops and reports, never auto-resolves. Main is prod: every commit ships after the gate; nothing reaches main without a review receipt, and the hook checks (pointer to the review skill). Money, auth, data, each one line with a pointer: integer cents; pricing in `pricingEngine.js`, pure, no DB; Stripe through `stripeClient.js`, which honors `STRIPE_TEST_MODE_UNTIL` and fails closed without credentials; a price change re-evaluates the paid flag against `amount_paid`; the hosted 1:100 bartender rule with a pointer to `isHostedPackage`; gratuity in three lines with a pointer to `docs/money-laws.md`; parameterized SQL, never concatenation; `asyncHandler` plus `AppError`, and error responses never leak stacks, SQL or paths; auth middleware and role guards on every non-public route, and reads scoped by `req.user.id`; public routes token-gated by UUID; server-side validation of every input; uploads validated by magic bytes through `fileValidation.js`; secrets only from `process.env`; multi-table writes inside `BEGIN`/`COMMIT`/`ROLLBACK`; bank PII through `encryption.js`; one pooled connection per request; `schema.sql` idempotent; event identity never concatenated (`getEventTypeLabel`, the hand-synced `eventTypes.js` pair); the event-side drink plan is canonical; the cross-cutting rule (change X, grep every consumer of X); the dev box talks to live Stripe; the legal-hold proposal (pointer to `legalHold.js`). (The rev 1 outline dropped a dozen of these without a home; fleet.)

**How work flows.** Two tracks: a quick fix on main, a project that thinks on main and builds in a lane. The lane lifecycle: `worktree:new` and `worktree:rm` only; `lane:status` runs at session start (hook) and prints the block marker and the last ship; the stale-lane defaults; the merge path in one paragraph with a pointer to `merge-lane.sh`; the hold rule; the emergency revert. Design artifacts are contracts, in five lines. A plan is a lane map without code (D12): per lane `id`, `footprint`, `blockedBy`, the lenses it will get, acceptance checks, the laws and seams that apply, the test plan; stated as the convention the design agents read, with no enforcement claim. Review runs once per lane (D14).

**Conventions.** camelCase JS, snake_case columns and JSON keys. Vanilla CSS; tokens in `client/src/styles/drb-tokens.css`; per-page CSS files allowed. Client API calls through `utils/api.js`; the error shape is `{message, code, fieldErrors, status}`. Header comments feed the generated docs. No ORM.

**Pointers.** The review skill; `docs/dev.md`; `docs/money-laws.md`; `scripts/sensitive-paths.txt`; `.env.example`; the ledger (`docs/fix-list-remaining-2026-07-02.md`, Dallas's list); `docs/ops-runbook.md`; `docs/reviewer-map.md`.

Gone from this file: the env table, the tech stack list, the reasoning-effort section, the file-size section (one pointer line stays; the hook explains itself), the three TRANSITIONAL Windows blocks, the push model, the review-model mechanics (now the skill), the design-stage fleet paragraph (now one pointer line), the 700-word gratuity paragraph (moved verbatim to `docs/money-laws.md`), and the inline self-check as a checklist: its security and data-integrity lines survive as the one-line invariants above.

`scripts/claudemd-invariants.txt` is edited in a commit that lands before the rewrite, not with it, so the coverage check can fail on a dropped rule: every key that the rewrite retires or moves is named in the plan Dallas sees, and `check-claudemd-invariants.sh` is wired into pre-commit whenever `CLAUDE.md` is staged. (fleet)

### 6.4 `docs/money-laws.md` (new, public, ids only)

The money rules that today live only in memory glosses, so they load in every session from any launch directory, and the money lens reads them before any verdict: the retainer survives full payment; `acknowledged_total` is row truth and create-intent's total is a projection; a `?paid=true` load never renders money; frozen rates beat the live catalog; the label partition and its five constant sets, and that a label is neither a semantic nor a key; the addon quantity column's shape per billing type and `storedToInputCount`; off-ledger invoice labels; the paid flag is `amount_paid` plus `external_paid` against `total_price`, never status or payment type; refund scope (allowance is headroom plus contract slack); the hosted 1:100 ratio; owner no-draw payouts; which pay period is now is `chicagoTodayYmd()`; the stale-proposal sweep never adds `accepted`; the gratuity rules, verbatim from the current CLAUDE.md paragraph; the legal-hold proposal by id. Each with a pointer to the code and a provenance bracket. (fleet; the table of contents: the lens audit)

### 6.5 Memory

`MEMORY.md` becomes index-only: one line per memory that survives, no shas, no merged or pushed state, no "next up". The money-law glosses move to `docs/money-laws.md` (6.4) rather than being lost. Feedback memories get the provenance bracket. The prune moves files to `memory/_archive/` (never loaded, never indexed), nothing is deleted. Archived at the flip, not before (fleet): the 13 push-day project notes; `feedback-push-cue-must-be-imperative`; `feedback-push-in-progress-freezes-main`; `reference-push-ssh-keepalive`. Kept: `feedback-gate-result-is-the-receipt` (a piped gate exiting 0 on failure is a bash trap that outlives the push model) and `reference-memory-carries-no-push-state` (its merge-base check is how a session finds unpushed work, which 4.4 can still leave). Archived at step 1: the 7 Windows-procedure files. Every link to an archived file is rewritten in the files that stay (the referrers are listed in the prune plan), so the prune creates no new dangling links; the 18 pre-existing ones are fixed or their referrers archived. Project memories that hold lane state get a pointer to the ledger or the board instead.

The memory root for a session launched from `os` (`~/.claude/projects/-home-drbartender-projects-os/memory/`) becomes a symlink to the main memory directory after its four June files are archived, so both launch directories share one memory. (fleet)

## 7. Files afterward

| Path | Fate | Owns |
|---|---|---|
| `~/.claude/CLAUDE.md` | rewrite, about 35 lines | how Dallas wants to be worked with |
| `~/.claude/settings.json` | edit or regenerate | the auto-mode environment block says the repo is private with no remotes; it is public with an origin |
| `~/.claude/commands/handoff.md` | keep | the handoff format |
| `~/.claude/commands/second-opinion.md` | keep, edit | external review; adds the denylist mask; invoked by the review skill on tier A |
| `~/.claude/agents/ui-ux-reviewer.md` | cut, merged into `os` `ui-ux-review` | |
| `~/.claude/projects/-home-drbartender/memory/` | prune to `_archive`; index rewritten | facts and dated rules |
| `~/.claude/projects/-home-drbartender-projects-os/memory/` | archive its four files; becomes a symlink to the main memory | |
| `os/.claude/CLAUDE.md` | rewrite, about 130 lines | invariants, workflow, conventions, pointers |
| `os/.claude/settings.json` | edit | SessionStart: `show-location.js` then `lane:status` (wrapped to exit 0) |
| `os/.claude/skills/review/` | new | section 3: computes the tier, generates the brief, dispatches, triages, writes the receipt directory |
| `docs/dev.md` | new | how the servers and tests actually run (section 9); the Render rollback lever; the win-share clone |
| `docs/money-laws.md` | new | section 6.4 |
| `os/.claude/agents/money.md`, `lifecycle.md`, `concurrency.md`, `business-time.md`, `outcomes-providers.md`, `access-egress.md`, `seams.md`, `schema-data.md`, `client.md` | new, built from `lens-audit/` | the nine lenses of 3.2; brief-driven; verdict table with `escalate`; each check cites the defect ids behind it |
| `os/.claude/agents/security-review.md`, `database-review.md`, `consistency-check.md`, `code-review.md`, `ui-ux-review.md` | cut, replaced by the nine | their live checks carried into the new files (the audit's keep list) |
| `os/.claude/agents/verify.md` | new, `model: fable` | the tier A adversarial pass |
| `os/.claude/agents/performance-review.md` | rewrite, explicit-only | run on request when a public page or a list endpoint changes |
| `scripts/static-checks.js` | new | the mechanical greps of 3.2; run by the review skill and the gate |
| `os/.claude/agents/spec-*.md`, `plan-fidelity.md`, `plan-decomposition.md` | edit | the Windows line and the "no client tests" line removed; plans without code (D12); references point at the new CLAUDE.md sections by name |
| `os/.claude/agents/plan-feasibility.md` | cut | its job was checking code in plans against the codebase; plans carry no code |
| `os/.claude/skills/plan/` | new, after the flip | the lane-map format of D12; replaces writing-plans and subagent-driven-development (D15) |
| `os/.claude/commands/review-spec.md`, `review-plan.md` | keep | |
| `os/.claude/commands/full-audit.md` | edit | quarterly; adds the sensitive-list check |
| `os/.claude/commands/codex-review.md`, `gemini-spec.md`, `review-before-deploy.md` | cut | |
| `os/.mcp.json` | cut, with the `gemini-cli` entry in `settings.local.json` | its only consumer was `gemini-spec` |
| `scripts/merge-lane.sh` + `merge-lane.test.js` | rewrite | `check` and `ship` phases per 4.1 |
| `scripts/push-gate.js` + `push-gate.test.js` | rewrite | gate a sha in a throwaway worktree classified by the push range; sha receipt in the common git dir; block marker |
| `scripts/ship.js` (`npm run ship`) | new | the one push path: receipt check over the range, gate, push, watch, hold and block markers |
| `scripts/post-ship-watch.js` | new | deploy wait, Sentry window, Vercel READY check |
| `scripts/gen-docs.js` (`npm run docs`) | new | section 5 generators and `--check` |
| `scripts/migrate-headers.js` | new, one-shot | the README-to-header migration and its comment-only proof |
| `scripts/lib/worktreeLinks.js` | new | the symlink list shared by `worktree-new.js` and the gate |
| `scripts/testdb-smoke.js` | edit | takes the common-dir flock, blocking |
| `scripts/board-write.sh` + `board-write.test.js` | edit | pushes through `ship`; the only-unpushed-commit guard retired |
| `scripts/lane-status.js` + `lane-status.test.js` | edit | prints the block marker and the last ship |
| `scripts/check-docs-drift.sh` | cut | replaced by `npm run docs -- --check` |
| `scripts/check-claudemd-invariants.sh`, `claudemd-invariants.txt` | edit | manifest updated before the rewrite; check wired into pre-commit |
| `scripts/sensitive-paths.txt` | edit, in the flip commit | adds the hinge files (D11) and the client money surfaces (3.2) |
| `.husky/pre-commit` | edit | docs `--check` replaces the drift script; invariants check when CLAUDE.md is staged |
| `.husky/pre-push` | edit | validates the sha receipt and the review receipts over the range; refuses without them; never runs the gate itself |
| `server/index.js` | edit, sensitive | `/api/health` returns `release`; `Sentry.init` sets `release` |
| `client/vercel.json` | edit | `ignoreCommand` for docs-only ranges |
| `render.yaml` | cut | never applied: the live service was created in the dashboard and does not match it; its settings move to `docs/dev.md` |
| `README.md` | regenerate and trim | generated tree, scripts, env; prose per 5.2 |
| `ARCHITECTURE.md` | regenerate and trim | generated routes, schema index; prose per 5.2 |
| `.env.example` | edit | every row of the two deleted tables ported as comments |
| `.comms-sms-contract.md`, `.plan-2-contract.md`, `_cleanup_payroll.js` | cut | |
| `os/.claude/_audit_*`, `_thread-mining/`, `mobile-audit-2026-05-15/`, `full-audit-2026-06-09.log`, `gen-liquor-beer-wine-pdf.js` | cut, gitignored scratch | |
| `~/win-share/os` | leave; `docs/dev.md` notes it is a July clone and not a source of rules | |
| `docs/walkthroughs-owed.md` | unchanged; fate deferred (Dallas looks at shipped work without checking it off) | |
| `wildlight/CLAUDE.md`, `AGENTS.md` | unchanged this round | |

Old versions: every repo file is replaced in a normal commit, so `git diff <before>..<after> -- <path>` shows the change. Files outside git get a `.bak-<date>` copy first.

## 8. Sequencing

Until `merge-lane.sh ship` is live, the current push rules stand: pushes are cue-only, through `npm run gate` and a literal-sha push. The flip happens in one merge: the tooling (merge-lane, push-gate, ship, gen-docs, post-ship-watch, migrate-headers, the review skill, the hooks, the health and Sentry release change, the build filters, the sensitive-list additions) and the rewritten `os/.claude/CLAUDE.md` land together, reviewed as tier A. The flip merge itself ships through the old path and is the last cue-gated push. The global CLAUDE.md and the memory step-1 prune can land any time before that. (fleet)

Dormancy (fleet): `ship` and the new hook refuse unless a marker file in the common git dir says the flip has landed, so a tool that exists before step 5 cannot push without a cue. The agents keep their current "How to start" until the skill lands beside them in step 2.

Before the flip, with evidence: one docs-only push through the old path, after the build filters are in place, showing no deploy on Render or Vercel. In-flight lanes at the flip (today: `beer-picks`) get a receipt by running the review skill by hand before their merge. The first unattended ship after the flip is a trivial commit with Dallas watching; `merge-lane.sh` and `ship` carry a `--no-push` dry run for the rehearsal. (fleet)

Before the flip, by Dallas's hand, in the Render dashboard for the `os` service: the build filter that ignores docs-only paths (4.9), and the Health Check Path set to `/api/health`, which is empty today, so Render cuts a deploy over without checking that the app answers (the post-ship watch in 3.8 needs it too). The Vercel half is committed.

Order for Phase 3, each file's plan shown to Dallas before it is written (his instruction):

1. `~/.claude/CLAUDE.md`; the Windows-era memory prune and the link fixes; `docs/money-laws.md`; `docs/dev.md`; the `claudemd-invariants.txt` edit.
2. The review skill with the brief template, `static-checks.js` and the verify agent; the nine lens agents built from `lens-audit/`; the design agents (feasibility retired); the commands; `testdb-smoke.js` takes its lock. The skill is usable by hand before merge-lane enforces it, so every lane from this step on gets the new review. Phase 3's own step plans are lane maps without code (D12).
3. `push-gate.js` sha mode with the block marker; `post-ship-watch.js`; `ship.js`; the hooks; `board-write.sh` and `lane-status.js`; all dormant.
4. `gen-docs.js` and `migrate-headers.js`; the `.env.example` port; README and ARCHITECTURE regenerated.
5. `merge-lane.sh` rewrite; `server/index.js` release; the build filters and the docs-only evidence push; the sensitive-list additions; `os/.claude/CLAUDE.md` rewrite; the flip, then the push-era memory archive and the rehearsal ship.

## 9. Left to the builder

- The exact brief template, the verdict-table parser, and the receipt directory layout beyond 3.6.
- The money and auth route prefix list the skill uses for the tier B client rule.
- `docs/dev.md` content: the backend is a Claude-managed background process with no reload (restart after server edits); the client flags are command-line env, not in `client/.env` (`HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none`); background servers die at two hours; subagents cannot mint dev tokens (`dev-signin.js` is the controller's); server suites share the dev DB (one at a time, behind a lock, never from a lane while another runs, read the pass count, never CREATE TEMP); the Node mismatch (box 24.16.0, prod 26.5.0); the Neon dev and prod branch ids; the Render rollback lever; the win-share clone.
- The gen-docs markers and output format; the header `//` block format; the comment-only proof.
- The gate env file's exact contents, verified by running the smoke suites with it.
- The watch window (ten minutes is Claude's call), the deploy wait bound, and the Sentry query.
- How the SessionStart hook wraps `lane:status` so a stale lane or a block marker prints without a non-zero exit.
- Whether the sha gate receipt is keyed on the tree hash as well, to honor a review-time smoke.

## 10. Open questions

- Whether `full-audit` gets a schedule or stays a manual quarterly.
- The fate of `docs/walkthroughs-owed.md`.
- Whether the Node 24/26 mismatch on the box is fixed in Phase 3 (nvm default) or only documented.
- Closing a ledger entry by a commit that names it, so the ledger stops lagging git (the audit found dozens of entries open in the ledger and fixed in git, and the reverse). A later round.
- A lighter audit of the design-stage agents against their own record (about half their recorded findings were plan hygiene); owed before they are edited beyond D12.
- The prod findings in section 9 of the lens audit (unsubscribe, payout sync, client Sentry, the unique index, the commit with names in it) are Dallas's to place on the ledger; they are not on the rewrite's path.
