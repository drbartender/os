# Instruction rewrite: main is prod, review is a receipt, docs come from code

Date: 2026-10-19. Status: design approved section by section in the brainstorm (Dallas, 2026-10-18 to 2026-10-19). Spec fleet (grounding, gaps, risk) and a builder check run on this draft; their findings are folded below where marked. Phase 3, the rewrite itself, starts only on Dallas's go.

This is the contract for rewriting every file that tells Claude how to work in this repo and on this box. It is written for an agent reading it cold. The audit that preceded it ran on 2026-10-17 and is summarized in section 1; the full report is not in the repo.

## 1. Why

Two failures prompted this, both named by Dallas on 2026-10-18.

**Phantom rules.** Sessions have told him "I have reached your 150k limit" when he never set one, and twice (2026-08-25, 2026-08-28) told him he had said not to run review agents when he had not. Each time a Claude-authored rule (a hook, a line in CLAUDE.md, a memory about either) lost its origin and was attributed to him. The fix is structural: every rule carries who set it and when, and rules live in fewer places.

**The push tax.** Pushes were batched to save review. Per-lane review before merge is now the primary gate, so batching saves nothing, and because the push gate fingerprints the shared working tree, a gate in flight freezes every other window ("hang on while I push in another window"). Dallas: "Once I'm done with a patch or a feature or section of a feature I want to deploy it. We aren't manually testing on the dev server before deployment nearly as much any more."

**What the audit found.** `os/.claude/CLAUDE.md` is 387 lines and 76 KB, about 19K tokens per session, and roughly 45% of it is reference duplicated in `README.md` and `.env.example` (three env tables with three row counts: 113, 128, 108). `README.md` is 227 KB and `ARCHITECTURE.md` 533 KB; both hand-maintain mirrors of the file tree and route table, and both drift (44 of 249 server utils and 5 route files missing from the README tree; ARCHITECTURE still says the database is on Render). The six code-review agents open with `git diff --name-only HEAD~1`, the wrong scope for every real call site. The code-review agent grades against try/catch plus `res.status(500)`, the pattern the codebase retired for `asyncHandler` plus `AppError` (111 of 142 route files use asyncHandler, 4 use `res.status(500)`). CLAUDE.md promises a plan front-matter schema it never shows and a footprint check nothing enforces. `codex-review.md` cites a deny rule that does not exist. Memory holds 240 files; its 20 KB index carries work-item state against its own rule; 20 of 198 wiki links dangle; 7 files still describe Windows procedures. The project CLAUDE.md loads lazily on the first Read-tool access under os and never in a Bash-only session: 4 of the last 12 sessions never loaded it.

## 2. Decisions

Each decision names its source. "Dallas" means he said it in the brainstorm. "Claude's call" means Claude proposed it, played it back, and Dallas did not object. Dates are 2026-10-18 and 2026-10-19 unless given.

- D1. **Main is prod.** Every commit that lands on main ships after the mechanical gate, with no cue and no batching. (Dallas: the push cue was drawn "so long ago that idk if it is still really that important.") Section 4.
- D2. **Nothing reaches main without a review receipt.** `merge-lane.sh` refuses a lane without one; a quick fix carries its own. "Properly reviewed" is defined in section 3. (Dallas: "I do want to make sure that it has been properly reviewed as well." The definition is Claude's call, approved: "That sound right to me.")
- D3. **The gate tests a commit, not the working tree.** Money smoke and client build run in a throwaway worktree at the sha; the receipt is keyed on the sha; other windows never wait. (Claude's call.)
- D4. **The push-time review layer is deleted, not moved.** No seam sweep, no sensitive-path re-review at push, no second opinion at push, no inventory announcement, no "never volunteer a push prompt", no "pushing in another window freezes main". Review happens once, before a merge or before a quick-fix commit. The one survivor is the stale-base re-review in 3.7. (Claude's call.)
- D5. **README and ARCHITECTURE are generated where they mirror code.** Folder tree, route table, env table and schema index come from scripts; each file's one-line description comes from its own header comment. Hand-written prose stays only where it explains what the code does not say. (Dallas: "I don't look at the readme or architecture. They are there for claude or any developer that might look at my code.")
- D6. **Every rule carries provenance.** One bracket: `[Dallas 2026-10-06]` or `[Claude default]`. A rule without an origin is a Claude default and may be dropped on sight. (Claude's call; the structural answer to the phantom rules.)
- D7. **The global file is about Dallas; the project file is about the code.** `~/.claude/CLAUDE.md` (private, loads everywhere including Wildlight) holds how he wants to be worked with. `os/.claude/CLAUDE.md` (public repo, loads lazily) holds invariants, workflow, conventions and pointers. (Claude's call, approved: "That all looks right.")
- D8. **Rules may live in memory**, with the same provenance, and the memory index goes back to being an index. Pruned files move to an archive folder that is never loaded; nothing is deleted. (Dallas: "I think I'm ok with those things being in the memory." The archive is Claude's call.)
- D9. **Phone numbers, narrowed.** Numbers of real people (clients, staff) never enter the repo, a board line, a spec, a commit message, or a diff sent to an external reviewer; the tooling masks digits before anything goes to codex or gemini. Fixtures and the business lines may be printed. The grep hygiene (file names and counts, not matching lines) stays because it costs nothing. (Dallas: "I'm really just worried about client and staff number." The narrowing is Claude's call.)
- D10. **Phase 3 has a code half.** The merge path, the gate, the receipt, the doc generators and the post-ship watch are scripts. The new CLAUDE.md lands in the same commit as the tooling it describes, or says plainly what stands until the tooling ships. Never again a rule for tooling that does not exist. (Claude's call; the footprint rule is the cautionary example.)

## 3. Properly reviewed

### 3.1 Definition

A change is properly reviewed when all of the following hold, and the receipt records each:

1. The lenses for its tier (3.2) ran on the whole diff from a written brief (3.3).
2. Each lens returned a per-file verdict table (3.4) covering every file in the diff.
3. Every finding was triaged by the main session against the code: confirmed with the failure path stated, or rejected with a one-line reason (3.5).
4. Confirmed findings were fixed and the fix was re-reviewed by the lens that raised it.
5. The tests the change reaches ran and passed, with counts read, not inferred: the money smoke for tier A; the suites whose subjects the diff touches for tiers A and B; the client build for anything under `client/`.
6. The receipt (3.6) is written and keyed to the sha under review.

### 3.2 Tiers

Decided by what the diff touches, with `scripts/sensitive-paths.txt` as the one list.

| Tier | Trigger | Lenses | Tests |
|---|---|---|---|
| A | any path matched by `sensitive-paths.txt` | security, database, consistency, code (Opus); second opinion (codex plus gemini, Claude-triaged); verify (a Fable adversarial pass on each fix and on the money math) | money smoke plus every suite the change reaches |
| B | server code outside the list, or client code that calls a money or auth endpoint | code, consistency (Opus) | every suite the change reaches |
| C | client-only, CSS, copy, scripts | one reviewer: `ui-ux-review` when the surface has a design artifact, otherwise code | client build |
| docs | only docs, specs, plans, the board | none | the gate decides (docs-only skips both checks) |

Performance review becomes explicit-only: run when a public page or a list endpoint changes. In the record it has never produced a confirmed finding on its own.

Escalation: any lens on a tier B or C review may return `escalate` in its verdict table when it sees money, auth or PII material. That bumps the review to tier A before merge. The sensitive list itself gets a standing check at every quarterly full-audit (it has been wrong before: the staff-home route and the bank-details route both shipped money defects while unlisted).

Model tiering stands as decided 2026-07-13 and 2026-08-14: Opus on the lenses, because the main session reads them; Fable on verification, because nothing downstream catches a false pass.

### 3.3 The brief

One file per review, generated by the review skill and handed to every lens. It contains: the diff as a file (commit list, stat, `-U10`); the plan and spec links; the tier and why; the file list the lens must return verdicts for; what is already established (tests run and their counts, build status, questions already settled); the budget ("finish within roughly N tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach"); and the standing line "do not print any phone number; refer to numbers by role". The agents' "How to start" sections are replaced by "read the brief at the path in your prompt".

### 3.4 The verdict table

Every lens ends its report with one row per file in the brief's list:

```
| file | verdict | note |
| server/utils/x.js | pass | |
| server/routes/y.js | finding | H1, M2 |
| client/src/z.js | not reached | budget |
| server/utils/w.js | escalate | writes payout rows |
```

`not reached` is the iron rule made mechanical: that file is re-dispatched alone to the same lens. A lens that returns no table, or a table missing files, counts as not reached for the missing files. An agent that fails to complete is never a pass. This replaces the chunk-and-retry halving: a diff too large for one brief is split by area up front, not after a failure.

### 3.5 Triage

The main session reads the cited code for every finding before it counts. Confirmed means the main session can state the failure path itself. Rejected means a one-line reason: wrong about the code, guarded upstream, unreachable, style. Agreement between agents is not evidence; four agents repeating a claim share a blind spot. (Source: the 2026-07-22 push, 74 findings at about five percent real, two of the loudest false despite four-agent agreement.)

### 3.6 The receipt

Written by the review skill to `<git-dir>/drb-review-receipt-<sha>.json`: sha, the main base sha the review ran against, tier, lenses, per-file verdict summary, findings raised, confirmed, fixed, rejected, tests with counts, timestamp. `merge-lane.sh` refuses a lane whose tip has no receipt or whose receipt predates the tip. The squash commit message carries the summary so `git log` is the audit trail:

```
merge(lane invoice-step): docs/superpowers/plans/2026-10-16-price-override-removal.md

Review: tier A (sensitive: server/utils/invoiceLineItems.js, server/routes/proposals/*)
  lenses:   security, database, consistency, code, second-opinion (codex, gemini), verify (fable)
  files:    14/14 verdicts
  findings: 11 raised, 3 confirmed, 3 fixed and re-reviewed, 8 rejected
  tests:    money-smoke 42/42, invoiceLineItems.test.js 18/18, cancelLineItem.protected.test.js 9/9
  receipt:  lane tip 3f2a9c1, reviewed 2026-10-19 14:02
```

A quick fix carries the same block, shorter, on its own commit. In the window the report is one line: "Shipped invoice-step, tier A, 3 findings fixed, 42 money suites green."

### 3.7 Stale base

The receipt records the main sha the review ran against. If main has moved when `merge-lane.sh` runs, it computes the files touched by both the lane and main since that base and runs a bounded re-review on that overlap only (consistency and code; tier A adds security) before pushing. No overlap means no re-review. This replaces the push-time seam sweep at the one moment a seam can exist.

### 3.8 Post-ship watch

After a tier A or B push, the ship path waits for the Render deploy to go live (the health endpoint reports the new release), then polls Sentry (projects `drbartender-server` and `drbartender-client`) for issues first seen after the deploy, for a bounded window (Claude's call: ten minutes), and reports in the same line. Nothing today looks at prod after a push, which is how `docs/walkthroughs-owed.md` reached 200 KB.

### 3.9 External reviewers

Diffs sent to codex or gemini pass through a digit mask first (any run of ten or more digits with phone punctuation becomes `<num>`), and the brief says so. Both reviewers are metered; a 429 or an auth failure is reported and the Claude lenses remain the gate. (Standing since 2026-07-02 and 2026-08-19.)

## 4. Main is prod

### 4.1 The lane path

1. The lane is reviewed per section 3 and the receipt is written.
2. `scripts/merge-lane.sh <branch> <plan>` takes the flock, checks the receipt (3.6), runs the stale-base re-review if main moved (3.7), regenerates the docs (5.1), and squash-merges with the review block in the message.
3. The ship step, inside the same script and the same lock: gate the new HEAD (4.3), push that sha (`git push origin <sha>:main`), run the post-ship watch (3.8), then remove the lane worktree and branch. The three checks in the existing merged-lane invariant still run before `branch -D`.
4. One line in the window.

### 4.2 The quick-fix path

A quick fix on main is reviewed per its tier before the commit (tier A gets the full fleet before the commit, because after the commit is prod), committed with its review block, then shipped with `npm run ship` (the same gate, push and watch). The ask itself is the go.

"Hold this", said up front, means the work is done in a lane and left unmerged until Dallas says ship. Nothing held ever sits on main, because the next ship from any window would carry it.

### 4.3 Gate on the sha

`push-gate.js` gains a mode that gates a commit in isolation: `git worktree add --detach <tmp> <sha>` with the same five symlinks `worktree-new.js` makes (`node_modules`, `client/node_modules`, `.husky/_`, `.env`, `client/.env`), run the needed gates there (money smoke when `server/` or the gate's own machinery changed; client build when `client/` changed; neither for docs-only), write a receipt keyed on the sha alone, remove the worktree. `testdb-smoke.js` resolves its repo root from its own location, so invoking the worktree's copy runs the worktree's suites against the worktree's schema. The pre-push hook validates a sha receipt for the sha being pushed; the working-tree fingerprint and its twelve-hour clock go away. Gate runs still serialize behind the existing flock in the common git dir, because there is one Neon ci-smoke branch.

### 4.4 Serialization and failure

Merges and ships queue behind the merge-lane flock, so a third lane landing at once ships roughly twenty minutes after the first, unattended. A gate failure after a merge is fixed forward on main (the invariant against reset on main stands); the failing commit is not pushed and the window says so. A push rejection stops and reports, as today.

### 4.5 Dirty tree

With the gate in a throwaway worktree, uncommitted edits in `os` no longer affect it. `merge-lane.sh` refuses only when the dirty paths intersect the lane's paths. The rest of "never merge into a dirty tree" goes.

### 4.6 Docs-only commits

Specs, plans and board lines still commit to main the moment they exist (thinking lives on main) and now push immediately through the same path; the gate skips both checks. `board-write.sh` loses its "only unpushed commit" guard because there is no unpushed work by design. Because every docs commit now reaches origin, Render and Vercel need build filters that ignore `docs/**` and `*.md` before the flip, or the servers rebuild on every plan revision. Both are dashboard settings set by Dallas's hand (section 8).

## 5. Docs from code

### 5.1 Generated

- **README folder tree**: generated from the file list under `server/` and `client/src/`. Each file's description is its header comment (the first `//` line or `/** */` block). A new source file without a header fails the drift gate (5.3).
- **ARCHITECTURE route table**: generated from a walk of the mounts in `server/index.js` and each router. `scripts/route-inventory.js` already walks one router and counts handlers; it is extended to every mount, to mark auth from the middleware present, and to read the comment above each handler for the description.
- **Env table**: generated from `.env.example`, which becomes the one copy. The tables in CLAUDE.md and README go.
- **Schema index**: table, columns, constraints, generated from `schema.sql` with a pointer to the line.

The generator is `npm run docs`, run by `merge-lane.sh` before the squash commit and by the quick-fix ship path. Output is deterministic, so a no-change run is a no-op. Generated sections sit between markers so hand-written prose around them survives.

### 5.2 Hand-written, trimmed

ARCHITECTURE keeps: the high-level diagram, auth flow, error handling, pricing engine, proposal rules, booking window, third-party integrations, deployment (corrected to Neon), dev tooling. Each is cut to what the code does not say. "Plan-execution review cadence" goes, superseded by section 3. README keeps: what it is, local dev (rewritten against `docs/dev.md`), the scripts table (generated from `package.json`), deployment and the test gate. Key Features, 218 lines of release notes, goes. The outsider's entry point stays `docs/reviewer-map.md`.

### 5.3 The drift gate

`scripts/check-docs-drift.sh` is replaced by `npm run docs -- --check`: regenerate to a temp file and diff; a stale generated section fails the merge instead of warning. The "Mandatory documentation updates" table in CLAUDE.md becomes one sentence: write the header comment; hand-write ARCHITECTURE prose only when a concept changes.

## 6. Rules and provenance

### 6.1 Format

Every rule in either CLAUDE.md, in a skill, in an agent, or in a feedback memory ends with a bracket: `[Dallas 2026-10-06]`, `[Dallas 2026-08-28, "Since when do I have to ASK for review"]` when the words carry weight, or `[Claude default]`. Quotes go in the private global file or in memory, not in the public project file. A rule found without a bracket is a Claude default and the session may drop it, saying so in one line.

### 6.2 `~/.claude/CLAUDE.md` (private, about 30 lines)

Review is standing; never ask; never attribute "no agents" to Dallas. No compaction; handoff only when asked. Brainstorm in prose, one question at a time, no menus; section approvals are the approval; skip the final spec re-review. Latest word beats the spec. Verify behavior, not shape; don't rubber-stamp; say it once; cursing is a signal. No client or staff phone numbers in any repo, board line, spec, commit or external diff; the personal cell nowhere. No em dashes in client, staff or spec prose. Dallas is both DRB accounts; never call him Dan. Each line bracketed with its date. This file is the only place outside memory where a rule about working with Dallas lives. It is backed up as `CLAUDE.md.bak-<date>` before each rewrite because `~/.claude` is not in git.

### 6.3 `os/.claude/CLAUDE.md` (public, about 110 lines)

Four sections, in this order.

**Invariants.** Git safety: `os` stays on main (the guard script); explicit staging; no reset or amend on main; destructive ops need a per-action yes except verified merged-lane cleanup; never scrap unmerged work. Main is prod: every commit ships after the gate; nothing reaches main without a review receipt (pointer to the review skill). Money, auth, data: integer cents; pricing in `pricingEngine.js`; Stripe through `stripeClient.js`; the hosted 1:100 bartender rule in three lines with a pointer to `isHostedPackage`; gratuity in three lines with pointers to `gratuityLabels.js` and the 2026-08-10 spec; `asyncHandler` plus `AppError`; auth middleware and role guards; bank PII through `encryption.js`; one pooled connection per request; `schema.sql` idempotent; the event-side drink plan is canonical; the cross-cutting rule (change X, grep every consumer of X); the dev box talks to live Stripe; the legal-hold proposal (pointer to `legalHold.js`).

**How work flows.** Two tracks: a quick fix on main, a project that thinks on main and builds in a lane. The lane lifecycle: `worktree:new` and `worktree:rm` only; `lane:status` runs at session start (hook); the stale-lane defaults; the merge path in one paragraph with a pointer to `merge-lane.sh`. Design artifacts are contracts, in five lines. Plan front-matter: lanes with `id`, `footprint`, `blockedBy`, `review`, stated as the convention the design agents read, with no enforcement claim.

**Conventions.** camelCase JS, snake_case columns and JSON keys. Vanilla CSS; tokens in `client/src/styles/drb-tokens.css`; per-page CSS files allowed. Client API calls through `utils/api.js`; the error shape is `{message, code, fieldErrors, status}`. Header comments feed the generated docs. No ORM.

**Pointers.** The review skill; `docs/dev.md`; `scripts/sensitive-paths.txt`; `.env.example`; the ledger (`docs/fix-list-remaining-2026-07-02.md`, Dallas's list); `docs/ops-runbook.md`; `docs/reviewer-map.md`.

Gone from this file: the env table, the tech stack list, the inline self-check, the reasoning-effort section, the file-size section (one pointer line stays; the hook explains itself), the three TRANSITIONAL Windows blocks, the push model, the review-model mechanics (now the skill), the design-stage fleet paragraph (now one pointer line), the 700-word gratuity paragraph.

`scripts/claudemd-invariants.txt` is updated to the surviving rules and the coverage check runs in the rewrite commit.

### 6.4 Memory

`MEMORY.md` becomes index-only: one line per memory, no shas, no merged or pushed state, no "next up"; under 60 lines. Feedback memories get the provenance bracket. The prune moves files to `memory/_archive/` (never loaded, never indexed), nothing is deleted: the 7 Windows-procedure files; the twelve push-day project notes; the push-model notes that D1 and D4 retire (`feedback-push-cue-must-be-imperative`, `feedback-push-in-progress-freezes-main`, `reference-push-ssh-keepalive`, `reference-memory-carries-no-push-state`); the orphan `~/.claude/projects/-home-drbartender-projects-os` folder. The 20 dangling links are fixed or their referrers archived. Every other push-era note is judged one by one; `feedback-gate-result-is-the-receipt` stays, because a piped gate exiting 0 on failure is a bash trap that outlives the push model. Project memories that hold lane state get a pointer to the ledger or the board instead.

## 7. Files afterward

| Path | Fate | Owns |
|---|---|---|
| `~/.claude/CLAUDE.md` | rewrite, about 30 lines | how Dallas wants to be worked with |
| `~/.claude/settings.json` | edit or regenerate | the auto-mode environment block says the repo is private with no remotes; it is public with an origin |
| `~/.claude/commands/handoff.md` | keep | the handoff format |
| `~/.claude/commands/second-opinion.md` | keep, edit | external review; adds the digit mask; invoked by the review skill on tier A |
| `~/.claude/agents/ui-ux-reviewer.md` | cut, merged into `os` `ui-ux-review` | |
| `~/.claude/projects/-home-drbartender/memory/` | prune to `_archive`; index rewritten | facts and dated rules |
| `~/.claude/projects/-home-drbartender-projects-os/` | archive | |
| `os/.claude/CLAUDE.md` | rewrite, about 110 lines | invariants, workflow, conventions, pointers |
| `os/.claude/settings.json` | edit | SessionStart: `show-location.js` then `lane:status` (wrapped to exit 0) |
| `os/.claude/skills/review/` | new | section 3: generates the brief, dispatches, triages, writes the receipt |
| `docs/dev.md` (or a `dev` skill) | new | how the servers and tests actually run (section 9) |
| `os/.claude/agents/security-review.md`, `database-review.md`, `consistency-check.md`, `code-review.md` | rewrite | brief-driven; verdict table; code-review graded against asyncHandler plus AppError; stale file names fixed; the CLAUDE.md folder-tree check removed |
| `os/.claude/agents/performance-review.md` | rewrite, explicit-only | |
| `os/.claude/agents/ui-ux-review.md` | rewrite, absorbs the global reviewer | design-artifact adherence first |
| `os/.claude/agents/spec-*.md`, `plan-*.md` | edit | the Windows line and the "no client tests" line removed; references point at the new CLAUDE.md sections by name |
| `os/.claude/commands/review-spec.md`, `review-plan.md` | keep | |
| `os/.claude/commands/full-audit.md` | edit | quarterly; adds the sensitive-list check; "Rule 6" removed |
| `os/.claude/commands/codex-review.md`, `gemini-spec.md`, `review-before-deploy.md` | cut | |
| `os/.mcp.json` | cut, with the `gemini-cli` entry in `settings.local.json` | its only consumer was `gemini-spec` |
| `scripts/merge-lane.sh` | rewrite | receipt check, stale-base re-review, docs regen, gate, push, watch, cleanup |
| `scripts/push-gate.js` | rewrite | gate a sha in a throwaway worktree; sha receipt; the hook validates it |
| `npm run ship` (`scripts/ship.js`) | new | the quick-fix path: gate, push, watch |
| `npm run docs` (`scripts/gen-docs.js`) | new | section 5 generators and `--check` |
| `scripts/check-docs-drift.sh` | cut | replaced by `npm run docs -- --check` |
| `scripts/post-ship-watch.js` | new | health plus the Sentry window |
| `scripts/claudemd-invariants.txt` | edit | the surviving rules |
| `README.md` | regenerate and trim | generated tree, scripts, env; prose per 5.2 |
| `ARCHITECTURE.md` | regenerate and trim | generated routes, schema index; prose per 5.2 |
| `.comms-sms-contract.md`, `.plan-2-contract.md`, `_cleanup_payroll.js` | cut | |
| `os/.claude/_audit_*`, `_thread-mining/`, `mobile-audit-2026-05-15/`, `full-audit-2026-06-09.log`, `gen-liquor-beer-wine-pdf.js` | cut, gitignored scratch | |
| `~/win-share/os` | leave; `docs/dev.md` notes it is a July clone and not a source of rules | |
| `docs/walkthroughs-owed.md` | unchanged; fate deferred (Dallas looks at shipped work without checking it off) | |
| `wildlight/CLAUDE.md`, `AGENTS.md` | unchanged this round | |

Old versions: every repo file is replaced in a normal commit, so `git diff <before>..<after> -- <path>` shows the change. Files outside git get a `.bak-<date>` copy first.

## 8. Sequencing

Until the ship path in `merge-lane.sh` is live, the current push rules stand: pushes are cue-only, through `npm run gate` and a literal-sha push. The flip happens in one merge: the tooling (merge-lane, push-gate, ship, gen-docs, post-ship-watch, the review skill) and the rewritten `os/.claude/CLAUDE.md` land together, reviewed as tier A (`push-gate.js` is sensitive-listed; merge-lane and ship touch the deploy). The global CLAUDE.md and the memory prune can land any time before that. Agents and commands land with or before the skill. README and ARCHITECTURE regenerate in the same merge as gen-docs.

Before the flip, by Dallas's hand: Render build filter and Vercel ignored build step so docs-only pushes do not rebuild (4.6).

Order for Phase 3, each file's plan shown to Dallas before it is written (his instruction):

1. `~/.claude/CLAUDE.md` and the memory prune (no code dependency).
2. The review skill, the brief template, the six code agents, the design agents, the commands. The skill is usable by hand before merge-lane enforces it.
3. push-gate sha mode, post-ship-watch, ship.
4. gen-docs and the drift check; README and ARCHITECTURE regenerated.
5. merge-lane rewrite; `os/.claude/CLAUDE.md` rewrite; `claudemd-invariants.txt`; the flip.

## 9. Left to the builder

- The exact brief template and the verdict-table parser.
- The receipt JSON shape beyond the fields in 3.6.
- Whether `docs/dev.md` is a plain doc or a skill. It must cover: the backend is a Claude-managed background process with no reload (restart after server edits); the client env flags (`HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none`); background servers die at two hours; subagents cannot mint dev tokens (`dev-signin.js` is the controller's); server suites share the dev DB (one at a time, never from a lane while another runs, read the pass count, never CREATE TEMP); the Node mismatch (box 24.16.0, prod 26.5.0); the Neon dev and prod branch ids; the win-share clone.
- The gen-docs markers and output format.
- What "new Sentry issue" means precisely, and the watch window.
- How the review skill names and re-dispatches a not-reached file.
- How the SessionStart hook wraps `lane:status` so a stale lane prints without a non-zero exit.

## 10. Open questions

- Whether `full-audit` gets a schedule or stays a manual quarterly.
- The fate of `docs/walkthroughs-owed.md`.
- Whether the Node 24/26 mismatch on the box is fixed in Phase 3 (nvm default) or only documented.
