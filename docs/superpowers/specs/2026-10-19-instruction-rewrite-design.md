# Instruction rewrite: main is prod, review is a receipt, docs come from code

Date: 2026-10-19. Status: rev 5, a consolidated rewrite that supersedes revs 1 to 4. Design approved section by section in the brainstorm (Dallas, 2026-10-18 to 2026-10-19). Rev 1 was reviewed by the spec fleet (grounding, gaps, risk) and a cold builder check; rev 3 folded the review-lens audit (`2026-10-19-lens-audit.md`); rev 4 added the step-back items; rev 5 resolves the 35 contradictions and 20 ambiguities a consistency read found between the four revisions and the six questions a second builder check raised, and it adds one decision (D16, sessions launch from `os`). Phase 3, the rewrite itself, starts only on Dallas's go.

This is the contract for rewriting every file that tells Claude how to work in this repo and on this box, and the tooling the rules depend on. It is written for an agent reading it cold.

## 1. Why

Two failures prompted this, both named by Dallas on 2026-10-18.

**Phantom rules.** Sessions have told him "I have reached your 150k limit" when he never set one, and twice (2026-08-25, 2026-08-28) told him he had said not to run review agents when he had not. Each time a Claude-authored rule (a hook, a line in CLAUDE.md, a memory about either) lost its origin and was attributed to him. The fix is structural: every rule carries who set it and when, and rules live in fewer places.

**The push tax.** Pushes were batched to save review. Per-lane review before merge is now the primary gate, so batching saves nothing, and because the push gate fingerprints the shared working tree, a gate in flight freezes every other window ("hang on while I push in another window"). Dallas: "Once I'm done with a patch or a feature or section of a feature I want to deploy it. We aren't manually testing on the dev server before deployment nearly as much any more."

**What the audit of the instruction files found (2026-10-17).** `os/.claude/CLAUDE.md` is 387 lines and 76 KB, about 19K tokens per session, and roughly 45% of it is reference duplicated in `README.md` and `.env.example` (three env tables with three row counts). `README.md` is 227 KB and `ARCHITECTURE.md` 533 KB; both hand-maintain mirrors of the file tree and route table, and both drift (44 of 249 server utils and 5 route files missing from the README tree; ARCHITECTURE still says the database is on Render). CLAUDE.md promises a plan front-matter schema it never shows and a footprint check nothing enforces. `codex-review.md` cites a deny rule that does not exist. Memory holds 242 files; its 20 KB index carries work-item state against its own rule; 18 of 200 wiki links dangle; 7 files still describe Windows procedures. The project CLAUDE.md loads lazily on the first Read-tool access under os and never in a Bash-only session: 4 of the last 12 sessions never loaded it. Every one of the last 65 sessions launched from the home folder, where the project's agents, skills, commands and hooks are not registered, and the memory root is keyed to the launch folder.

**What the audit of the review lenses found (2026-10-19, `2026-10-19-lens-audit.md`).** Of 1,496 biting defects since April, 80% match no check in any of the six review agents as written; for money defects, 85%. Of the 285 defects that reached production or were caught by Dallas, a client, a staffer, codex or gemini, a check existed for 33. 141 of the 219 checks matched nothing in six months. A third of biting money defects sit in files the sensitive list does not cover. The fleet was not failing to apply its checklists; the checklists did not cover what this codebase breaks.

## 2. Decisions

Each decision names its source. "Dallas" means he said it in the brainstorm. "Claude's call" means Claude proposed it, played it back, and Dallas did not object. Dates are 2026-10-18 and 2026-10-19 unless given.

- D1. **Main is prod.** Every commit that lands on main ships after the mechanical gate, with no cue and no batching. (Dallas: the push cue was drawn "so long ago that idk if it is still really that important.") Section 4.
- D2. **Nothing reaches main without a review receipt, and the hook enforces it.** `merge-lane.sh` refuses a lane without one; the pre-push hook refuses a push whose range contains a non-docs commit without one, whichever window pushes. "Properly reviewed" is section 3. (Dallas: "I do want to make sure that it has been properly reviewed as well." The definition is Claude's call, approved: "That sound right to me." Hook enforcement: the rev 1 fleet.)
- D3. **The gate tests the push range in isolation.** Money smoke and client build run in a throwaway worktree at the sha, classified by everything in `origin/main..sha`; the receipt is keyed on the sha; other windows never wait. (Claude's call.)
- D4. **The push-time review layer is deleted, not moved.** No seam sweep, no sensitive-path re-review at push, no second opinion at push, no inventory announcement, no "never volunteer a push prompt", no "pushing in another window freezes main". Review happens once per lane (D14). The survivors are the stale-base re-review (3.8) and, in the ship report, the names of other windows' commits that rode along. (Claude's call.)
- D5. **README and ARCHITECTURE are generated where they mirror code.** Folder tree, route table, env table and schema index come from scripts; each file's one-line description comes from its own header comment, migrated once from the README by script. Hand-written prose stays only where it explains what the code does not say. (Dallas: "I don't look at the readme or architecture. They are there for claude or any developer that might look at my code.")
- D6. **Every rule carries provenance.** One bracket: `[Dallas 2026-10-06]` or `[Claude default]`. A rule without an origin is a Claude default and may be dropped on sight. (Claude's call.)
- D7. **The global file is about Dallas; the project file is about the code.** `~/.claude/CLAUDE.md` (private, loads everywhere including Wildlight) holds how he wants to be worked with. `os/.claude/CLAUDE.md` (public repo) holds invariants, workflow, conventions and pointers. (Claude's call, approved: "That all looks right.")
- D8. **Rules may live in memory**, with the same provenance, and the memory index goes back to being an index. Pruned files move to an archive folder that is never loaded; nothing is deleted. The money laws move into the repo, where the review skill and any money-path work read them. (Dallas: "I think I'm ok with those things being in the memory." The archive and the money-laws doc are Claude's call.)
- D9. **Phone numbers, narrowed.** Numbers of real people (clients, staff) never enter the repo, a board line, a spec, a commit message, or a diff sent to an external reviewer; the tooling masks them, and the board denylist's other shapes, before anything goes to codex or gemini. Fixtures and the business lines may be printed. The grep hygiene (file names and counts, not matching lines) stays because it costs nothing. (Dallas: "I'm really just worried about client and staff number." The narrowing is Claude's call.)
- D10. **Phase 3 has a code half.** The merge path, the gate, the receipt, the doc generators and the post-ship watch are scripts. The new CLAUDE.md lands with the tooling it describes, or says plainly what stands until the tooling ships. Never again a rule for tooling that does not exist. (Claude's call; the footprint rule is the cautionary example.)
- D11. **The files that define "reviewed" and "sensitive" are themselves sensitive (the hinge set).** The review skill and its brief template, the lens agents, `scripts/sensitive-paths.txt` and `scripts/sensitive-match.js`, `scripts/static-checks.js`, `.husky/*`, `.claude/settings.json`, `scripts/merge-lane.sh`, `scripts/ship.js`, `scripts/push-gate.js`, `scripts/post-ship-watch.js`, `scripts/gen-docs.js`, `scripts/lane-status.js`, `scripts/board-write.sh`, `scripts/lib/*`, `client/vercel.json`, `docs/money-laws.md`, `AGENTS.md`, and the root configuration files (`package.json` and its lock, `client/package.json`, `.node-version`, `eslint.config.mjs`, `.gitignore`) are tier A from the flip commit on. A sensitive hit is never docs-only. (The rev 1 fleet; widened in rev 5.)
- D12. **Plans are lane maps without code.** A plan carries, per lane: `id`, scope, `footprint`, `blockedBy`, the lenses the plan expects, acceptance checks that can be run, the money laws and seams that apply, and the test plan. Code appears only where the code is the decision (a predicate, a constant). The lens audit's precision pass found about half the design fleet's recorded findings were plan hygiene (wrong line anchors, invented harness shapes): review of a copy of the code that drifts before it is built. Phase 3's own step plans follow this format. (Claude's call; Dallas: "If you are saying they shouldn't then that makes sense to me.")
- D13. **A bug fix's receipt names the test that fails on the old code**, at every tier, lane or quick fix, by file and count from the runner log. The record holds a fix closed on a grep that matched the wrong shape, nine suites that never connected to the database, tests billed as mutation-verified that stayed green with their condition deleted, and a day-boundary fix provable only by an evening-instant test. (Claude's call, from the audit.)
- D14. **Review runs once per lane**: one full pass of the selected lenses, plus bounded re-passes (a fix is re-reviewed by the lens that raised the finding; a file a lens did not reach is re-dispatched to that lens alone; a lane whose main moved gets the overlap re-review of 3.8). The per-task implementer-plus-two-reviewers ritual is retired. (Dallas, 2026-07-22: "you are running reviews too much"; made structural here.)
- D15. **Superpowers stays through the flip.** Its brainstorming and systematic-debugging skills keep earning their place. Its defaults that this project overrides are written once: menus and the final spec re-read in the global file (6.2); worktrees-as-lanes and review-once-per-lane in the project file (6.3). After the flip a project `plan` skill replaces writing-plans and subagent-driven-development. (Claude's call.)
- D16. **Sessions for this repo launch from `os`, and lane windows from the lane's worktree.** Claude Code registers a project's agents, skills, commands, hooks and memory from the launch folder, and every session so far launched from the home folder, where none of what this spec builds under `os/.claude/` would exist. A shell wrapper (`drb`, in `~/.local/bin`) runs `claude` inside `os`; the memory root for os-launched sessions becomes a symlink to the real one (6.5), so nothing is lost by the move. (Claude's call, rev 5; the rev 4 builder check. The one change to how Dallas starts a session.)

## 3. Properly reviewed

### 3.1 Definition

A change is properly reviewed when all of the following hold, and the receipt records each:

1. The lenses selected for it (3.3) ran on the whole diff from a written brief (3.4).
2. Each lens returned a per-file verdict table (3.5) covering every file in the diff.
3. Every finding was triaged by the main session against the code: confirmed with the failure path stated, or rejected with a one-line reason (3.6).
4. Confirmed findings were fixed and each fix was re-reviewed by the lens that raised it.
5. The tests the change reaches ran on the final reviewed tree, after every fix, and passed, with counts read from the runner's own log: the money smoke for tier A; the suites whose subjects the diff touches for tiers A and B; the client build for anything under `client/`. For a bug fix at any tier, the test that fails on the old code, by file and count (D13).
6. The receipt (3.7) is written for the reviewed content, and the lens reports and runner logs are captured beside it.

### 3.2 The nine lenses

The lens audit replaced the six lenses by discipline with nine by mechanism. The check inventories, about 190 checks each citing the defects behind it, are in `lens-audit/`; each lens file is built from its inventory. A lens file stays under about 150 lines: checks ordered by the number of defects behind them, two sentences and a trigger each, so a lens is read rather than skimmed. The brief tells the lens which of its triggers fired, and it reads those checks first.

| lens | fires on | replaces |
|---|---|---|
| money | an `UPDATE proposals SET` on a money column, a Stripe or refund call, a price, rate, quantity or payout read, any path in the money section of the sensitive list; reads `docs/money-laws.md` first | nothing today |
| lifecycle | a status write, a sweep, a scheduler, a terminal transition, a pay-period predicate, a candidate set | nothing today |
| concurrency | a status write, `FOR UPDATE`, `pool.connect()`, a provider call that moves money or sends, a retry, a partial update, a tick | nothing today |
| business-time | `CURRENT_DATE`, `new Date`, a formatter, a period pick, a window, a DATE column, a threshold in days | nothing today |
| outcomes and providers | a helper returning a status, a catch, a skip branch, a COMMIT followed by work, an SDK options object, a webhook branch, TwiML, an env flag, a DOM agent step | the error-handling halves of code-review and security-review |
| access and egress | a route or guard, a public form, a log, export or AI send, a limiter, a send, a webhook | security-review, rewritten; its mechanical greps move to `scripts/static-checks.js` |
| seams | a changed field, response shape, enumeration, entrance, a helper with copies, client-facing copy | consistency-check, rewritten around tracing one value from its writer to every reader |
| schema and data | `schema.sql`, `db/index.js`, `server/scripts/`, `scripts/`, a seed, a catalog change | database-review, trimmed, plus the import, backfill and catalog work no lens read |
| client | any diff under `client/src`; captures at 320 and 390 wide provided by the main session | ui-ux-review, plus the code-reading half it never had |

performance-review becomes explicit-only, run on request when a public page or a list endpoint changes. code-review dissolves: dead code to lint (`no-unused-vars` promoted to error for `server/` in `eslint.config.mjs` at the flip), duplication, status codes and naming to seams, loading and empty states to client. The verify agent (Fable) stays on tier A: an adversarial pass on each fix and on the money math.

Model tiering stands as decided 2026-07-13 and 2026-08-14: Opus on the lenses, because the main session reads them; Fable on verification, because nothing downstream catches a false pass.

Lens checks cite the defect ids behind them; that is their provenance, and no bracket is needed. The bracket of D6 is for rules.

### 3.3 Selection and tiers

The review skill computes the lens set from the diff: the tier's floor plus every lens whose trigger the diff content matches. The plan's per-lane lens list (D12) is a forecast; the computed set is binding, and the receipt notes a lens that fired which the plan did not name.

| tier | trigger | floor | tests |
|---|---|---|---|
| A | any path on the sensitive list (D11 hinge set, the money section, the auth and PII section, the client money surfaces), or the content rule: a diff that writes a money column, calls Stripe or a refund helper, reads or writes a price, rate, quantity or payout, or writes `status` on a money-bearing table (`proposals`, `invoices`, `invoice_payments`, `proposal_payments`, `proposal_refunds`, `payouts`, `pay_periods`, `tips`, `shifts`, `service_extensions`) | money, lifecycle, concurrency, outcomes and providers, access and egress, seams; the second opinion (3.10); verify | money smoke plus every suite the change reaches |
| B | any other server code, any script not on the list, any other status write | seams; access and egress for a new file under `server/routes/` or `server/middleware/` | every suite the change reaches |
| C | everything else under `client/` | client, seams | client build |
| docs | every file in the push range is on the docs allowlist (4.7) and none is sensitive | none | the gate skips both checks |

The content rule's regexes are calibrated against `lens-audit/defects.jsonl` by the builder; the audit proposed it as a tier B floor and this design raises it to tier A on purpose, because the record's uncovered money defects sit in unlisted files. Unclassified paths (anything not under `server/`, `client/`, `scripts/`, `docs/`) are hinge files and tier A.

The sensitive list gains, in the flip commit, the 122 files the audit found carrying money defects while unlisted, in a money section: `server/routes/drinkPlans/*`, `server/routes/stripeCreateIntent.js`, `server/utils/serviceExtension*.js`, `server/utils/drinkPlanExtras.js`, `server/utils/proposalGroupCommit.js`, `server/routes/proposals/metadata.js`, `server/utils/metricsQueries.js`, `server/utils/autoAssign.js`, `server/routes/admin/payrollTax.js`, `server/db/index.js`, `server/scripts/staffPaymentImport/*`, `scripts/cc-*.js`, the public Sign and Pay page and its hooks (`client/src/pages/proposal/proposalView/*`), the proposal editor (`client/src/pages/admin/proposalEditor/*`, `ProposalDetailEditForm.js`, `ProposalDetailPaymentPanel.js`) and `client/src/components/PricingBreakdown.js`, the Money Board cards (`client/src/pages/admin/overview/*`), the payroll panels (`client/src/pages/admin/payroll/*`, `client/src/pages/staff/PayPage.js`), `paystubData.js`, the two contract text files (`client/src/data/eventServicesAgreement.js`, `server/data/contractorAgreement.js`), and `client/src/pages/website/ServicesPage.js`. The matcher gains `**` (today `*` never crosses a slash and the list's header says so; the header is rewritten at the flip to the list's one role, a tier floor) and the content rule. Escalation: any lens may return `escalate` in its verdict table when it sees money, auth or PII material outside its tier; that bumps the review to tier A before merge. The list gets a standing check at every quarterly full-audit.

Mechanical pre-steps the skill runs before any lens, and hands to the lenses as established facts: `scripts/static-checks.js` (the greps that used to be security-review prose: parameterized SQL, command injection, SSRF, secrets in the client bundle, `.env` ignored, `STRIPE_TEST_MODE_UNTIL`, `JWT_SECRET` from env, missing `auth` import, `dangerouslySetInnerHTML`, swallowed catch, `BEGIN` without `ROLLBACK`, `process.env.X || default`, floating versions on security packages, `file:` and `git+` deps); eslint `no-undef` and `no-use-before-define` over changed files; `sensitive-match` over the diff with the content rule; a PII grep over the diff under review (names, real-format numbers, a name beside a dollar figure), and again over the push range in `ship`, where a hit blocks.

Cost: merge-is-deploy makes lanes smaller and more frequent, and tier A runs six lenses plus the externals and verify. Trigger selection is the mitigation, and the skill may run a one- or two-file tier A diff's lenses as one agent carrying every applicable checklist rather than six agents; the receipt still records per-lens counts. The externals are metered (codex about six dollars a run, gemini prepaid); that stays a tier A cost by decision.

### 3.4 The brief

One file per review, generated by the review skill and handed to every lens. It contains: the diff as a file (commit list, stat, `-U10`); the plan and spec links; the tier, the matched paths and the triggers that fired, per lens; the file list the lens must return verdicts for; what is already established (the pre-step results, tests run and their counts, build status, questions already settled); for the money lens, the row-truth rules from `docs/money-laws.md` verbatim; for a designed surface, the artifact path and screenshots captured by the main session at 320 and 390 wide (a subagent cannot sign in to the dev app, so the lens judges the capture and the static render, never a live admin page); the budget ("finish within roughly N tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach"); and the standing line "print no real person's phone number; fixtures and the business lines are fine; refer to people by role". A diff too large for one brief is split by area up front, not after a failure.

### 3.5 The verdict table

Every lens ends its report with one row per file in the brief's list:

```
| file | verdict | note |
| server/utils/x.js | pass | |
| server/routes/y.js | finding | H1, M2 |
| client/src/z.js | not reached | budget |
| server/utils/w.js | escalate | writes payout rows |
```

`not reached` is the iron rule made mechanical: that file is re-dispatched alone to the same lens. A file not reached twice blocks the merge and is named in the window. A lens that returns no table, or a table missing files, counts as not reached for the missing files. The coverage-bearing passes are the nine lenses and verify. The externals (3.10) are recorded as run or not run, never as not reached: their failure never blocks.

### 3.6 Triage

The main session reads the cited code for every finding before it counts. Confirmed means the main session can state the failure path itself. Rejected means a one-line reason: wrong about the code, guarded upstream, unreachable, style. Agreement between agents is not evidence; four agents repeating a claim share a blind spot. (Source: the 2026-07-22 push, 74 findings at about five percent real.)

### 3.7 The receipt

The receipt is a directory, not a self-reported summary: `<git-common-dir>/drb-review/<key>/` holding `receipt.json`, every lens report, every runner log, and the brief. It lives in the common git dir because a lane's own git dir is deleted with the worktree. A receipt is a local file, not a privilege boundary (anything that can forge it can run `--no-verify`). An index file maps branch name and tip to key, so a lookup can fall back from key to branch (3.8).

Receipt kinds and keys:

- **lane**: the stable patch id of `base..tip` (`git diff base tip | git patch-id --stable`); `base`, `tip` and `reviewed_against` (the main sha at review time) are recorded fields, not part of the key. A content-identical rebase keeps the key; a conflict resolution or a new commit changes it. Lanes may still be rebased.
- **quick-fix**: the tree hash of the staged index (`git write-tree`) at review time, taken after `npm run docs` has staged the generated paths (4.2). The commit must have exactly that tree (`HEAD^{tree}`), so a hunk another window staged after the review, or a `git add` that swept in more than was reviewed, fails the check instead of shipping under the receipt.
- **commit**: for a commit already on main that has no receipt (another window's old habit, a checkpoint committed in `os` by mistake): the patch id of `parent..commit`; written by `review --commit <sha>`. A wedge with an escape, never a new gate on committing.
- **squash**: written by the merge path for the squash commit, the patch id of `parent..commit` with the generated doc paths excluded; equal to the lane key when main did not move and the resolution added nothing, otherwise written by the stale-base path (3.8).
- **revert** and **comment-only**: written by `ship` for a clean `git revert` of a shipped sha with no hand edits, and for a diff a script proves adds nothing but comment lines (the header migration); the proof is the receipt's body, and no lens runs.

`receipt.json` records: key, kind, branch and tip, `reviewed_against`, tier and the matched paths and triggers, the lenses that ran and why each fired, per lens the findings raised, confirmed, fixed and rejected (the audit could not measure any lens's precision from the record; from the first lane after the flip the receipts can), tests with counts and the log they were read from, for a bug fix the test that fails on the old code by file and count (D13), the externals' run or not-run state, timestamp. `merge-lane.sh` and `ship` do not trust the summary: they parse the captured verdict tables, check coverage against their own `git diff --name-only`, recompute the tier against the current sensitive list and refuse when the receipt's tier is lower or its file list is short, and read test counts from the runner log.

The squash commit message carries the summary so `git log` is the audit trail:

```
merge(lane invoice-step): docs/superpowers/plans/2026-10-16-price-override-removal.md

Review: tier A (sensitive: server/utils/invoiceLineItems.js, server/routes/proposals/*)
  lenses:   money, lifecycle, concurrency, outcomes, access, seams; second opinion (codex, gemini); verify
  files:    14/14 verdicts
  findings: 11 raised, 3 confirmed, 3 fixed and re-reviewed, 8 rejected
  tests:    money-smoke 79/79, invoiceLineItems.test.js 18/18, cancelLineItem.protected.test.js 9/9
  receipt:  patch 3f2a9c1, reviewed against main 8c1c660, 2026-10-19 14:02
```

A quick fix carries the same block, shorter, on its own commit. In the window the report is one line: "Shipped invoice-step, tier A, 3 findings fixed, 79 money suites green." If other windows' commits rode along in the push range, the line names them.

### 3.8 Stale base

`merge-lane.sh check` compares the receipt's `reviewed_against` with current main. When main has moved, it computes the overlap: files touched by both the lane and main since that sha. If there is no overlap and no sensitive path landed on main since then, the lane is `ready-moved` and ships with no session step; the suite re-run on the merged tree and the money smoke on the squash are the net. Otherwise the session runs the review skill in stale-base mode on the overlap: seams plus whatever lenses the overlap's content fires; tier A adds money and access and egress; when a sensitive path landed on main since the base, seams runs on the whole lane diff against new main. The lane's reached suites re-run on the merged tree. The skill writes a new receipt (kind squash) with the new `reviewed_against`. A receipt the key lookup cannot find (a post-review rebase with overlap changes the patch id) is found by branch through the index and treated the same way; a branch with no receipt at all is a full review. Known limit: overlap by file misses a seam where main changed a helper's contract and the lane added a caller in a file main never touched; the suites and the smoke are the net for that.

### 3.9 Re-passes

D14 restated for the builder: one full pass of the selected lenses per lane, then three bounded re-passes only: a fix is re-reviewed by the lens that raised the finding; a file a lens did not reach is re-dispatched to that lens alone, twice at most; a stale base gets the overlap pass of 3.8. Three rounds of `check` returning stale ends in refusal and a report that main will not hold still.

### 3.10 External reviewers

On tier A the review skill invokes `/second-opinion` (codex plus gemini) with a brief that carries the same money-laws section the money lens reads. The repo root gains a ten-line `AGENTS.md` pointing a cold external agent at `docs/money-laws.md`, `docs/dev.md` and the project CLAUDE.md (codex reads it when it opens the repo). Diffs sent out pass through the board-write denylist shapes first (phone-number runs, emails, bearer-style tokens, the Stripe id family, nine-digit hyphenated routing and EIN shapes). A token-shaped hit anywhere in the push range blocks the ship. Both reviewers are metered; a 429 or an auth failure is recorded as not run and the Claude lenses remain the gate. (Standing since 2026-07-02 and 2026-08-19.)

### 3.11 Post-ship watch

Runs after every push that deploys something, outside the ship lock, per sha, in the window that shipped:

1. Short-circuit: a docs-only range deploys nothing, so the watch records "no deploy expected" and ends. A range with no `client/` change skips the Vercel half.
2. Wait for the deploy. `GET /api/health` gains a `release` field set from `RENDER_GIT_COMMIT` (a one-line change in `server/index.js`, sensitive-listed, shipped in the flip lane); the watch polls until the field equals the pushed sha, with a bounded wait. The Vercel half is the `vercel` CLI confirming the production deployment for the sha is READY. A deploy never observed is reported as "deploy not observed", never as clean. A queued ship that supersedes the watched one is tolerated and named.
3. Watch Sentry through the existing `~/.sentryclirc` token with `sentry-cli` (never printed, not an `.env.example` row): count events with a timestamp after the deploy time across all issues in `drbartender-server` and `drbartender-client`, not only issues first seen, so a regression of a resolved issue and the `initDb: N unexpected schema statement(s) failed` group both count. Server `Sentry.init` sets `release` from the same sha in the same change. The client project reports nothing today; its DSN in the Vercel build is a before-the-flip step (section 8).
4. Report "no new Sentry events in ten minutes", never "clean": a wrong price, a zero gratuity or a wrong paid flag throws nothing. A watch that finds events sets the watch marker (4.4) and `lane:status` prints "shipped X at T, N events since" at the next session start.

## 4. Main is prod

### 4.1 The lane path, in two phases

The merge script cannot run a review fleet, so it is two commands under one lock discipline.

**`merge-lane.sh check <branch>`** takes the ship lock, refuses on any staged change in `os` (4.6), finds the lane's receipt by key or by branch (3.7), recomputes the tier and coverage, compares `reviewed_against` with current main, and exits with one of: `ready` (main unchanged, receipt valid); `ready-moved` (main moved, no overlap, no sensitive landing); `stale` plus the overlap file list and the sensitive-landing flag; or `refused` with the reason. It releases the lock on exit. On `stale`, the session runs the review skill in stale-base mode (3.8) and re-runs `check`; three rounds, then refusal.

**`merge-lane.sh ship <branch> <plan>`** takes the ship lock, re-runs the `check` logic (refusing if main moved into overlap again), runs `git merge --squash`, regenerates the docs into the staged tree (5.1) and stages only the generated paths, commits once with the review block (3.7), writes the squash receipt, gates the new HEAD against `origin/main..HEAD` (4.3), pushes that sha, releases the lock, starts the post-ship watch (3.11), then removes the lane worktree and branch after implementing the three merged-lane checks that today exist only as prose: the squash is on main, `git diff main <branch> -- <lane files>` is empty with generated docs excluded, and the worktree is gone.

A conflict in the squash stops `ship`: it leaves the index clean (aborts the squash) and names the files. The session resolves the conflict in `os` by re-running the squash, editing only the conflicting files, and staging only the lane's paths plus the resolution; a conflict is by definition overlap, so the session runs the stale-base pass on it (3.8), writes the squash receipt, and runs `merge-lane.sh ship <branch> <plan> --resolved`, which skips the squash, verifies the index holds only the lane's paths, and continues from the commit. A sensitive-path conflict needs no stop for Dallas: the overlap pass at tier A covers the resolution, and the ship report names the conflict.

The ship phase is unattended. The Bash tool's foreground limit is ten minutes, so `ship` runs in the background, writes its progress and result to `<git-common-dir>/drb-ship/<sha>.log`, and `lane:status` and the window read that file; three lanes landing at once queue behind the lock and ship one gate length apart.

### 4.2 The quick-fix path

A quick fix on main: the session runs `npm run docs` first so the generated sections are current, then the review at the fix's tier on the staged diff with the receipt keyed on the staged tree (3.7). Tier A gets the full floor before the commit, because after the commit is prod. The commit carries the review block; the pre-commit hook's `--check` refuses a commit that leaves a generated section stale. Then `npm run ship`, which gates `origin/main..HEAD` (4.3), checks the receipts for every non-docs commit in that range (D2), pushes the sha, and starts the watch. The ask itself is the go. A bug fix records the failing test (D13).

"Hold this", said up front, means the work is done in a lane and left unmerged until Dallas says ship. Nothing held ever sits on main, because the next ship from any window would carry it. There is no cancel of a ship in progress; a ship is minutes, and a hold is a lane.

### 4.3 Gate on the range

`push-gate.js` gains a sha mode that gates a commit in isolation: `git worktree add --detach <tmp> <sha>` with the symlinks `worktree-new.js` makes, the list extracted to `scripts/lib/worktreeLinks.js` so the two cannot drift; run the needed gates there; write a receipt keyed on the sha to the common git dir; remove the worktree in a trap so a crash leaves no registered worktree. What is "needed" is classified from everything in `origin/main..sha`, exactly as `neededGates` does today, never from the tip commit alone: money smoke when that range touches `server/`, `package.json`, the lock, or the gate's own machinery; client build when it touches `client/`; neither when every file in the range is on the docs allowlist and none is sensitive (4.7).

The gate worktree gets its own env file holding only what the smoke suites need (`NODE_ENV=test`, `SEND_NOTIFICATIONS=false`, `RUN_SCHEDULERS=false`, `JWT_SECRET`, the Stripe test credentials the suites read; the builder verifies the exact set by running them), never the box's live `.env`. It is the one environment exempt from the "dev box talks to live Stripe" invariant, and 6.3 says so. When the range touches `package.json` or the lock, the gate runs `npm ci` into a private `node_modules` in the worktree instead of using the symlink, or refuses with the reason, because prod installs from the new lock.

Locks, named: the **ship lock** (`<common>/drb-ship.lock`) serializes `merge-lane.sh`, `ship` and the board writer; the **smoke lock** (`<common>/drb-smoke.lock`) serializes every money smoke run, taken by `testdb-smoke.js` itself, blocking, so a review-time smoke and a gate never reset the shared Neon ci-smoke branch under each other. A gate inside `ship` holds the ship lock and takes the smoke lock, always in that order. The pre-push hook validates only and takes no lock. The sha receipt's age guard stays at a generous seven days, because ci-smoke resets from a prod parent that moves. The hook never runs the gate itself inside the SSH window (the 2026-08-14 hang): no receipt means refuse with "run npm run ship". `git push --no-verify` and `HUSKY=0` remain the named emergency escapes, visible and per-push.

Before the flip marker exists (section 8), `push-gate.js verify` keeps today's working-tree-fingerprint check as a legacy path, and the hook falls through to it; the flip push itself goes through that legacy path. The first tier A ship after the flip deletes the legacy path.

### 4.4 Two markers

A **gate marker** is written by the gate when it fails after a merge, naming the failing sha. A **watch marker** is written by the post-ship watch when it sees Sentry events after a deploy, naming the sha and the count. Every push path (`ship`, `merge-lane.sh ship`, the board writer, the hook) refuses to push while either marker stands, checked before the gate runs, and prints it; `lane:status` prints both at session start. The gate marker clears when a gate passes on a descendant of the failing sha (fix forward; the invariant against reset on main stands; the fix-forward commit is reviewed at its own tier; the lane whose squash failed keeps its worktree until the fix ships). The watch marker clears only by an explicit acknowledgement, `npm run ship -- --ack-watch <sha>`, by a session that has read the Sentry events and says in the ship report what it saw and decided; a gate cannot clear it.

A push rejection stops and reports as today, with one exception: after a fetch, a sha that is already an ancestor of `origin/main` was shipped by another window's range push and is reported as shipped, not rejected; the watch for it runs in whichever window pushed it.

### 4.5 One push path

Every push to origin goes through `ship` (or `merge-lane.sh ship`, which calls the same code) under the ship lock: the quick fix, the lane, the board writer. `board-write.sh` keeps its own guarded push until the flip marker exists, then calls `ship`; its "only unpushed commit" guard is retired at that point because the range gate, the receipt check and the markers decide.

### 4.6 The index and the dirty tree

`git merge --squash` stages into the shared index and `git commit` takes the whole index, so a quick fix another window has staged would ride into the lane's squash under the lane's receipt. `merge-lane.sh` therefore refuses on any staged change, whatever its path. Unstaged edits and untracked files block only when their paths intersect the lane's paths or the generated docs. `scripts/merge-lane.test.js` is rewritten to this rule.

### 4.7 Docs-only

A push range is docs-only when every file in it is on the allowlist (`docs/**`, `README.md`, `ARCHITECTURE.md`, `docs/build-board.md`) and none of them is on the sensitive list; `sensitive-match.js` enforces the second clause, so `docs/money-laws.md` and `docs/runbooks/*` are never docs-only. Nothing under `.claude/`, `scripts/`, `.husky/`, nor any root configuration file, is ever docs.

### 4.8 The emergency path

The fastest fix after a bad ship is `git revert <sha>`. A clean revert with no hand edits is reviewed by construction: `ship` recognizes it (the commit's tree equals the parent's tree with the reverted diff applied), writes a `revert` receipt, and runs the gate only. Render's dashboard rollback is the hand lever if the box is unavailable, and `docs/dev.md` says where it is.

### 4.9 Docs-only pushes and build filters

Specs, plans and board lines still commit to main the moment they exist (thinking lives on main) and now push immediately through `ship`; the gate skips both checks and the watch short-circuits. So that a plan revision does not restart prod: `client/vercel.json` gains an `ignoreCommand` that exits 0 when the diff is docs-only, committed as its own pre-flip commit (section 8); and the Render filter is set in the dashboard by Dallas's hand, because the production service (`os`, created in the dashboard 2026-03-16) is not Blueprint-managed. It differs from `render.yaml` in name, start command and health check path, so the yaml never governed it; the yaml is cut (section 7) and the service's real settings are recorded in `docs/dev.md`. (Resolved 2026-10-19 through the Render CLI.)

## 5. Docs from code

### 5.1 Generated

- **README folder tree**: generated from the file list under `server/`, `client/src/`, `scripts/` and `server/scripts/`. Each file's description is its header comment: the first comment after an optional shebang line, `'use strict'` directive or eslint directive. 553 of 1,053 non-test source files have no header today, so the flip includes a one-time migration: a script moves each file's current README description into its header as a `//` block, skipping files that already have one, and a second script proves the diff adds nothing but comment lines (a `comment-only` receipt, 3.7). After it, the drift gate fails any source file under those four roots without a header, with no grandfathering.
- **ARCHITECTURE route table**: generated from a static parse of the mounts in `server/index.js` plus a walk of each router (`scripts/route-inventory.js` already walks one router and counts handlers; requiring `index.js` would start the server, so the mounts are parsed, not required). Columns: method, path, auth (from the middleware present), handler file, and the comment above the handler when there is one. A router the walker cannot parse is marked `unparsed` in the table and fails `--check`; a route is never dropped silently. The 388 hand-written route rows today carry prose the code does not say; the migration script moves a row's text into a comment above its handler where the match is unambiguous (mount prefix plus path), and the rest stays as a hand-written "route notes" section outside the generated markers, keyed by path, trimmed by hand over time. No second fuzzy-match pass.
- **Env table**: generated from `.env.example`, which becomes the one copy. Before the tables in CLAUDE.md and README are deleted, every row is ported into `.env.example` as a comment block above its variable (the `THUMBTACK_AGENT_SECRET` row, for example, carries a blast radius and a leak response that `.env.example` lacks today), and the port is checked row by row.
- **Schema index**: table, columns, constraints, generated from `schema.sql` with a pointer to the line.
- **Scripts table** in README: generated from `package.json`.

The generator is `npm run docs`. In the lane path it runs after `git merge --squash` has staged the lane, on the merged tree, and stages only the generated paths into the same squash commit. In the quick-fix path the author runs it before the review (4.2). Output is deterministic, so a no-change run is a no-op. Generated sections sit between markers so hand-written prose around them survives.

### 5.2 Hand-written, trimmed

ARCHITECTURE keeps: the high-level diagram, auth flow, error handling, pricing engine, proposal rules, booking window, third-party integrations, deployment (corrected to Neon and to the real Render settings), dev tooling, and the route notes section. Each is cut to what the code does not say. "Plan-execution review cadence" goes, superseded by section 3. README keeps: what it is, local dev (rewritten against `docs/dev.md`), deployment and the test gate. Key Features, 218 lines of release notes, goes. The outsider's entry point stays `docs/reviewer-map.md`.

### 5.3 The drift gate

`scripts/check-docs-drift.sh` is replaced by `npm run docs -- --check` in `.husky/pre-commit`: regenerate to a temp file and diff; a stale generated section or a header-less source file refuses the commit instead of warning. It lands with the generator and the migration in step 4 and is live from that commit on. The "Mandatory documentation updates" table in CLAUDE.md becomes one sentence: write the header comment; hand-write ARCHITECTURE prose only when a concept changes.

## 6. Rules and provenance

### 6.1 Format

Every rule in either CLAUDE.md, in a skill, or in a feedback memory ends with a bracket: `[Dallas 2026-10-06]`, `[Dallas 2026-08-28, "Since when do I have to ASK for review"]` when the words carry weight, or `[Claude default]`. Quotes go in the private global file or in memory, never in any file under `os/` (agents, skills and commands are public too). A rule found without a bracket is a Claude default and the session may drop it, saying so in one line. Lens checks cite defect ids instead (3.2).

### 6.2 `~/.claude/CLAUDE.md` (private, about 40 lines)

Review is standing; never ask; never attribute "no agents" to Dallas. No compaction; handoff only when asked. Brainstorm in prose, one question at a time, no menus; section approvals are the approval; skip the final spec re-read. Latest word beats the spec. Verify behavior, not shape; don't rubber-stamp; say it once; cursing is a signal. Env-var debug discipline: never assert a production variable is unset; ask him to confirm it in Render or Vercel. The ledger is his to update: report a fix with its sha and the test that failed on the old code, never write "fixed" on a grep, never close a ledger entry yourself. No client or staff phone numbers in any repo, board line, spec, commit or external diff; the personal cell nowhere. No em dashes in client, staff or spec prose. Dallas is both DRB accounts; never call him Dan. In the os repo every commit on main ships after the gate and nothing reaches main without a review receipt, so a session that has not yet loaded the project file still knows the one rule that changed how pushes work. Sessions for DRB launch from `os` through the `drb` wrapper (D16). Each line bracketed with its date. This file is the only place outside memory where a rule about working with Dallas lives. It is backed up as `CLAUDE.md.bak-<date>` before each rewrite because `~/.claude` is not in git. Between Phase 3 step 1 and the flip it carries one dated transitional line: pushes are cue-only through `npm run gate` and a literal-sha push until the flip marker exists; the per-lane review uses the new skill from step 2 on, and the old push-time review layer is not run.

### 6.3 `os/.claude/CLAUDE.md` (public, about 130 lines)

Four sections, in this order.

**Invariants.** Git safety: `os` stays on main (the guard script); explicit staging; no reset or amend on main; destructive ops need a per-action yes except verified merged-lane cleanup; never scrap unmerged work; code preservation beats shipping speed; a push rejection stops and reports, never auto-resolves. Main is prod: every commit ships after the gate; nothing reaches main without a review receipt, and the hook checks (pointer to the review skill). Money, auth, data, each one line with a pointer: integer cents; pricing in `pricingEngine.js`, pure, no DB; Stripe through `stripeClient.js`, which honors `STRIPE_TEST_MODE_UNTIL` and fails closed without credentials; a price change re-evaluates the paid flag against `amount_paid`; the hosted 1:100 bartender rule with a pointer to `isHostedPackage`; gratuity in three lines with a pointer to `docs/money-laws.md`; parameterized SQL, never concatenation; `asyncHandler` plus `AppError`, and error responses never leak stacks, SQL or paths; auth middleware and role guards on every non-public route, and reads scoped by the current relationship row; public routes token-gated by UUID; server-side validation of every input; uploads validated by magic bytes through `fileValidation.js`; secrets only from `process.env`; multi-table writes inside `BEGIN`/`COMMIT`/`ROLLBACK`; bank PII through `encryption.js`; one pooled connection per request; `schema.sql` idempotent; event identity never concatenated (`getEventTypeLabel`, the hand-synced `eventTypes.js` pair); the event-side drink plan is canonical; the cross-cutting rule (change X, grep every consumer of X); the dev box talks to live Stripe, with the gate worktree (4.3) as the one exempt environment; the legal-hold proposal (pointer to `legalHold.js`).

**How work flows.** Two tracks: a quick fix on main, a project that thinks on main and builds in a lane. The lane lifecycle: `worktree:new` and `worktree:rm` only, never a bare worktree (the superpowers worktrees skill does not apply here); `lane:status` runs at session start (hook) and prints the markers and the last ship; the stale-lane defaults; the merge path in one paragraph with a pointer to `merge-lane.sh`; the hold rule; the emergency revert. Design artifacts are contracts, in five lines. A plan is a lane map without code (D12): per lane `id`, scope, `footprint`, `blockedBy`, the lenses expected, acceptance checks, the laws and seams that apply, the test plan; stated as the convention the design agents read, with no enforcement claim. Review runs once per lane with bounded re-passes (D14); the per-task reviewer ritual does not apply here.

**Conventions.** camelCase JS, snake_case columns and JSON keys. Vanilla CSS; tokens in `client/src/styles/drb-tokens.css`; per-page CSS files allowed. Client API calls through `utils/api.js`; the error shape is `{message, code, fieldErrors, status}`. Header comments feed the generated docs. No ORM.

**Pointers.** The review skill; `docs/dev.md`; `docs/money-laws.md`; `scripts/sensitive-paths.txt`; `.env.example`; the ledger (`docs/fix-list-remaining-2026-07-02.md`, Dallas's list); `docs/ops-runbook.md`; `docs/reviewer-map.md`.

Gone from this file: the env table, the tech stack list, the reasoning-effort section, the file-size section (one pointer line stays; the hook explains itself), the three TRANSITIONAL Windows blocks, the push model, the review-model mechanics (now the skill), the design-stage fleet paragraph (now one pointer line), the 700-word gratuity paragraph (moved verbatim to `docs/money-laws.md`), and the inline self-check as a checklist: its security and data-integrity lines survive as the one-line invariants above.

`scripts/claudemd-invariants.txt` is edited in a commit that lands before the rewrite, not with it, so the coverage check can fail on a dropped rule: every key that the rewrite retires or moves is named in the plan Dallas sees, and `check-claudemd-invariants.sh` is wired into pre-commit whenever `CLAUDE.md` is staged.

### 6.4 `docs/money-laws.md` (new, public, ids only, hinge)

The money rules that today live only in memory glosses, read by the review skill before any money lens runs, carried verbatim into the money lens's brief and the externals' brief, and pointed at from CLAUDE.md for any session touching a money path: the retainer survives full payment; `acknowledged_total` is row truth and create-intent's total is a projection; a `?paid=true` load never renders money; frozen rates beat the live catalog; the label partition and its five constant sets, and that a label is neither a semantic nor a key; the addon quantity column's shape per billing type and `storedToInputCount`; off-ledger invoice labels; the paid flag is `amount_paid` plus `external_paid` against `total_price`, never status or payment type; refund scope (allowance is headroom plus contract slack); the hosted 1:100 ratio; owner no-draw payouts; which pay period is now is `chicagoTodayYmd()`; the stale-proposal sweep never adds `accepted`; the gratuity rules, verbatim from the current CLAUDE.md paragraph; the legal-hold proposal by id. Each with a pointer to the code and a provenance bracket.

### 6.5 Memory

`MEMORY.md` becomes index-only: one line per memory that survives, no shas, no merged or pushed state, no "next up". The money-law glosses move to `docs/money-laws.md` (6.4). Feedback memories get the provenance bracket. The prune moves files to `memory/_archive/` (never loaded, never indexed), nothing is deleted. Step 1 archives the 7 Windows-procedure files, corrects the memories the lens audit found wrong against git (fixes credited to the wrong commit, a DRB ruling attributed to the Wildlight owner, entries recorded open that are fixed; the corrected references are in `lens-audit/defects.jsonl`), fixes the 18 dangling links, and makes the os-launch memory root (`~/.claude/projects/-home-drbartender-projects-os/memory/`) a symlink to the main memory directory after its four June files are archived, so D16 loses nothing. At the flip, not before: the 13 push-day project notes and the push-model notes D1 and D4 retire (`feedback-push-cue-must-be-imperative`, `feedback-push-in-progress-freezes-main`, `reference-push-ssh-keepalive`) are archived, every link to them rewritten in the files that stay. Kept: `feedback-gate-result-is-the-receipt` (a piped gate exiting 0 on failure is a bash trap that outlives the push model) and `reference-memory-carries-no-push-state` (its merge-base check is how a session finds unpushed work, which 4.4 can still leave). Project memories that hold lane state get a pointer to the ledger or the board instead.

## 7. Files afterward

| Path | Fate | Owns |
|---|---|---|
| `~/.claude/CLAUDE.md` | rewrite, about 40 lines | how Dallas wants to be worked with (6.2) |
| `~/.local/bin/drb` | new | launches `claude` inside `os` (D16) |
| `~/.claude/settings.json` | edit or regenerate | the auto-mode environment block says the repo is private with no remotes; it is public with an origin |
| `~/.claude/commands/handoff.md` | keep | the handoff format |
| `~/.claude/commands/second-opinion.md` | keep, edit | external review; adds the denylist mask and the money-laws section; invoked by the review skill on tier A |
| `~/.claude/agents/ui-ux-reviewer.md` | cut, its capture checks merged into the `client` lens | |
| `~/.claude/projects/-home-drbartender/memory/` | prune to `_archive`; index rewritten; corrections per 6.5 | facts and dated rules |
| `~/.claude/projects/-home-drbartender-projects-os/memory/` | archive its four files; becomes a symlink to the main memory (step 1) | |
| `os/.claude/CLAUDE.md` | rewrite, about 130 lines | invariants, workflow, conventions, pointers (6.3) |
| `os/.claude/settings.json` | edit | SessionStart: `show-location.js` then `lane:status` (wrapped to exit 0) |
| `os/.claude/skills/review/` | new | section 3: computes tier and lenses, runs the pre-steps, generates the brief, dispatches, triages, writes the receipt directory; `review --commit <sha>` |
| `os/.claude/skills/plan/` | new, after the flip | the lane-map format of D12; replaces writing-plans and subagent-driven-development (D15) |
| `docs/dev.md` | new | how the servers and tests actually run (section 9); the Render service's real name, start command and health check path; the Render rollback lever; the win-share clone |
| `docs/money-laws.md` | new, hinge | section 6.4 |
| `AGENTS.md` (repo root) | new, ten lines, hinge | points a cold external agent at `docs/money-laws.md`, `docs/dev.md` and the project CLAUDE.md |
| `os/.claude/agents/money.md`, `lifecycle.md`, `concurrency.md`, `business-time.md`, `outcomes-providers.md`, `access-egress.md`, `seams.md`, `schema-data.md`, `client.md` | new, built from `lens-audit/` | the nine lenses of 3.2 |
| `os/.claude/agents/security-review.md`, `database-review.md`, `consistency-check.md`, `code-review.md`, `ui-ux-review.md` | cut, replaced by the nine | their live checks carried into the new files (the audit's keep list) |
| `os/.claude/agents/verify.md` | new, `model: fable` | the tier A adversarial pass |
| `os/.claude/agents/performance-review.md` | rewrite, explicit-only | run on request when a public page or a list endpoint changes |
| `os/.claude/agents/spec-*.md`, `plan-fidelity.md`, `plan-decomposition.md` | edit | the Windows line and the "no client tests" line removed; plans without code (D12); references point at the new CLAUDE.md sections by name |
| `os/.claude/agents/plan-feasibility.md` | cut | its job was checking code in plans against the codebase; plans carry no code |
| `os/.claude/commands/review-spec.md`, `review-plan.md` | edit | review-plan runs fidelity and decomposition only |
| `os/.claude/commands/full-audit.md` | edit | quarterly; adds the sensitive-list check and a re-run of the lens audit's coverage over the defects fixed since the last run, so the lenses stay evidence-based |
| `os/.claude/commands/codex-review.md`, `gemini-spec.md`, `review-before-deploy.md` | cut | |
| `os/.mcp.json` | cut, with the `gemini-cli` entry in `settings.local.json` | its only consumer was `gemini-spec` |
| `scripts/static-checks.js` | new, hinge | the mechanical greps of 3.3; run by the review skill and the gate |
| `scripts/sensitive-paths.txt` | edit, in the flip commit | sections (money, auth and PII, hinge, client money surfaces); the 3.3 additions; the header rewritten to the one role |
| `scripts/sensitive-match.js` | edit, step 2 | `**`, the content rule, sections, "a sensitive hit is never docs-only" |
| `scripts/merge-lane.sh` + `merge-lane.test.js` | rewrite | `check` and `ship` phases per 4.1, background execution, the conflict flow |
| `scripts/push-gate.js` + `push-gate.test.js` | rewrite | sha mode in a throwaway worktree classified by the push range; sha receipt in the common git dir; the gate marker; the legacy fingerprint path until the flip marker exists |
| `scripts/ship.js` (`npm run ship`) | new | the one push path: receipt check over the range, markers, gate, push, watch, `--ack-watch`, `revert` and `comment-only` receipts |
| `scripts/post-ship-watch.js` | new | deploy wait, Sentry window, Vercel READY check, docs-only short-circuit |
| `scripts/gen-docs.js` (`npm run docs`) | new | section 5 generators and `--check` |
| `scripts/migrate-headers.js` | new, one-shot | the README-to-header migration, the route-row migration where unambiguous, and the comment-only proof |
| `scripts/lib/worktreeLinks.js` | new | the symlink list shared by `worktree-new.js` and the gate |
| `scripts/worktree-new.js` | edit | consumes `worktreeLinks.js` |
| `scripts/testdb-smoke.js` | edit | takes the smoke lock, blocking |
| `scripts/board-write.sh` + `board-write.test.js` | edit | pushes through `ship` once the flip marker exists; the only-unpushed-commit guard retired then |
| `scripts/lane-status.js` + `lane-status.test.js` | edit | prints both markers, the last ship, and the ship log |
| `scripts/check-docs-drift.sh` | cut | replaced by `npm run docs -- --check` |
| `scripts/check-claudemd-invariants.sh`, `claudemd-invariants.txt` | edit | manifest updated before the rewrite; check wired into pre-commit |
| `package.json` | edit | `ship` and `docs` scripts; `gate` stays as the legacy path until the flip, then goes; `no-unused-vars` to error for `server/` in `eslint.config.mjs` |
| `.husky/pre-commit` | edit, step 4 | docs `--check` replaces the drift script; invariants check when CLAUDE.md is staged |
| `.husky/pre-push` | edit, step 3 | validates the sha receipt and the review receipts over the range once the flip marker exists; falls through to the legacy fingerprint check before it; never runs the gate itself |
| `server/index.js` | edit, sensitive | `/api/health` returns `release`; `Sentry.init` sets `release` |
| `client/vercel.json` | edit, its own pre-flip commit | `ignoreCommand` for docs-only ranges |
| `render.yaml` | cut | never applied: the live service was created in the dashboard and does not match it; its settings move to `docs/dev.md` |
| `README.md` | regenerate and trim | generated tree, scripts, env; prose per 5.2 |
| `ARCHITECTURE.md` | regenerate and trim | generated routes, schema index; route notes; prose per 5.2 |
| `.env.example` | edit | every row of the two deleted tables ported as comments |
| `.comms-sms-contract.md`, `.plan-2-contract.md`, `_cleanup_payroll.js` | cut | |
| `os/.claude/_audit_*`, `_thread-mining/`, `mobile-audit-2026-05-15/`, `full-audit-2026-06-09.log`, `gen-liquor-beer-wine-pdf.js` | cut, gitignored scratch | |
| `~/win-share/os` | leave; `docs/dev.md` notes it is a July clone and not a source of rules | |
| `docs/walkthroughs-owed.md` | unchanged; fate deferred (Dallas looks at shipped work without checking it off) | |
| `wildlight/CLAUDE.md`, `wildlight/AGENTS.md` | unchanged this round | |

Old versions: every repo file is replaced in a normal commit, so `git diff <before>..<after> -- <path>` shows the change. Files outside git get a `.bak-<date>` copy first.

## 8. Sequencing

Until the flip marker exists, the current push rules stand: pushes are cue-only, through `npm run gate` and a literal-sha push, and the hook falls through to the legacy fingerprint check. Tools that land before the flip are dormant: `ship` refuses without the marker, the new hook path and the board writer's `ship` call wait for it. The flip merge carries step 5's items; the shipping session writes the marker after the flip push is confirmed on origin; the first tier A ship after the flip removes the legacy path and `npm run gate`.

Order for Phase 3, each file's plan shown to Dallas before it is written (his instruction), each plan a lane map without code (D12):

1. `~/.claude/CLAUDE.md` with the transitional line; the `drb` wrapper; the memory step-1 prune, corrections and the os-launch symlink; `docs/money-laws.md`; `docs/dev.md`; `AGENTS.md`; the `claudemd-invariants.txt` edit.
2. The review skill with the brief template, `static-checks.js`, `sensitive-match.js` with the content rule and `**`, and the verify agent; the nine lens agents built from `lens-audit/`; the design agents (feasibility retired); the commands; `testdb-smoke.js` takes the smoke lock. From this step on every lane gets the new review by hand, and the old push-time review layer is not run.
3. `push-gate.js` sha mode with the gate marker and the legacy path; `post-ship-watch.js`; `ship.js`; the pre-push hook; `board-write.sh` and `lane-status.js`; all dormant behind the marker.
4. `gen-docs.js` and `migrate-headers.js`; the pre-commit hook; the `.env.example` port; README and ARCHITECTURE regenerated. Live from this commit on.
5. `merge-lane.sh` rewrite; `server/index.js` release; `client/vercel.json` as its own commit; the docs-only evidence push (after the Render filter is set); the sensitive-list additions and header; `os/.claude/CLAUDE.md` rewrite; the flip merge through the old path, reviewed as tier A; the marker; the push-era memory archive; the rehearsal ship (a trivial commit, Dallas watching, `--no-push` dry run first); then the legacy-path removal ship.

Before the flip, by Dallas's hand, in the Render dashboard for the `os` service: the build filter that ignores docs-only paths (4.9), and the Health Check Path set to `/api/health`, which is empty today, so Render cuts a deploy over without checking that the app answers; and in Vercel, confirm the client Sentry DSN is in the build, or the watch is blind to every client-only ship.

Lanes cut before the flip (today: `beer-picks`, `gv-post-server`, `gv-sender`, `override-removal`) carry the old `.claude/` files in their worktrees and load the old rules; each is rebased onto main after the flip (standing practice) before its review, so no lane merges under the old model, and each gets its receipt by running the review skill by hand before its merge. The header migration touches files those lanes hold; they rebase over it.

## 9. Left to the builder

- The exact brief template, the verdict-table parser, and the receipt directory and index layout beyond 3.7.
- The content rule's regexes, calibrated against `lens-audit/defects.jsonl`.
- `docs/dev.md` content: the backend is a Claude-managed background process with no reload (restart after server edits); the client flags are command-line env, not in `client/.env` (`HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none`); background servers die at two hours; subagents cannot mint dev tokens (`dev-signin.js` is the controller's); server suites share the dev DB (one at a time, behind the smoke lock for money suites, never from a lane while another runs, read the pass count, never CREATE TEMP); the Node mismatch (box 24.16.0, prod 26.5.0); the Neon dev and prod branch ids; the Render service's real settings and the rollback lever; the win-share clone.
- The gen-docs markers and output format; the header `//` block format; the comment-only proof; the route-row match rule.
- The gate env file's exact contents, verified by running the smoke suites with it.
- The watch window (ten minutes is Claude's call), the deploy wait bound, and the Sentry query.
- The ship log format that `lane:status` reads, and how the SessionStart hook wraps `lane:status` so markers print without a non-zero exit.
- Whether the sha gate receipt is also keyed on the tree hash, to honor a review-time smoke on the same tree.
- The `drb` wrapper's handling of a lane window (launch from the worktree path given as an argument).

## 10. Open questions

- Whether `full-audit` gets a schedule or stays a manual quarterly.
- The fate of `docs/walkthroughs-owed.md`.
- Whether the Node 24/26 mismatch on the box is fixed in Phase 3 (nvm default) or only documented. Caveat for the fix: the claude, codex and gemini CLIs are installed under the v24 global bin, so switching the nvm default means reinstalling all three; the gate worktree could instead pin 26 through `.node-version` with nvm per invocation.
- Closing a ledger entry by a commit that names it, so the ledger stops lagging git (the audit found dozens of entries open in the ledger and fixed in git, and the reverse). A later round.
- A lighter audit of the design-stage agents against their own record (about half their recorded findings were plan hygiene); owed before they are edited beyond D12.
- The prod findings in section 9 of the lens audit (unsubscribe, payout sync, the unique index, the commit with names in it) are Dallas's to place on the ledger; they are not on the rewrite's path. The client Sentry DSN is the exception: it is a before-the-flip step (section 8).
