---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 2 of section 8
format: lane map without code (spec D12)
revision: 2 (2026-10-20; the plan fleet's fidelity and decomposition findings folded, see "What the plan fleet changed")
status: approved by Dallas 2026-10-20 ("Go"); execute natively, lanes in the order below, each lane window opened through drb <lane>, the acceptance checks are the review (no per-task reviewers, spec D14)
lanes:
  - id: pii-shapes
    scope: the one shared PII shape module and allowlist (spec 3.3, 3.10); the board writer reads it; the second-opinion mask reads it after the merge
    footprint:
      - scripts/lib/piiShapes.js
      - scripts/lib/piiShapes.test.js
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - ~/.claude/commands/second-opinion.md  (outside git; edited by hand AFTER the lane merges; .bak-20261020 first)
    blockedBy: []
    laws: D9 (real people's numbers never reach an external reviewer; fixtures and the business lines may); the board writer is a push path
    lenses: the current fleet's security-review on the two scripts; the acceptance checks are the review
    test plan: the sibling suites named in the checks, run through node --test; the mask exercised on a scratch diff
    revert: git revert of the squash commit; copy second-opinion.md.bak-20261020 back (revert this lane only after static-checks and review-tooling, which import it)
  - id: static-checks
    scope: the mechanical pre-steps as one script (spec 3.3)
    footprint:
      - scripts/static-checks.js
      - scripts/static-checks.test.js
    blockedBy: [pii-shapes]
    laws: the greps of lens-audit section 7 move from prose to a script; a blocking finding stops a review
    lenses: security-review (the script replaces its prose); the acceptance checks are the review
    test plan: one fixture per rule, both directions, in a throwaway repo
    revert: git revert of the squash commit
  - id: sensitive-match-2
    scope: the matcher gains `**`, sections, the content rule, the hinge set, the docs allowlist and a tier function (spec 3.3, 4.7, D11); the list itself does not change until the flip
    footprint:
      - scripts/sensitive-match.js
      - scripts/sensitive-match.test.js
      - scripts/content-rule-calibrate.js
    blockedBy: []
    laws: a sensitive hit is never docs-only (4.7); the content rule is a tier floor, not the selector
    lenses: security-review plus consistency-check (every consumer of the old exports); the acceptance checks are the review
    test plan: the existing suite kept whole plus the new cases; every consumer's own suite re-run; the calibration report
    revert: git revert of the squash commit (after review-tooling, which imports it)
  - id: suite-runner
    scope: the shared TAP summary parser, the suite runner behind the dev-suite lock, the smoke lock and a TAP log mode in testdb-smoke.js, the docs/dev.md lines the step 1 plan deferred here (spec 4.3, D13)
    footprint:
      - scripts/lib/tapSummary.js
      - scripts/lib/tapSummary.test.js
      - scripts/run-suites.js
      - scripts/run-suites.test.js
      - scripts/testdb-smoke.js
      - scripts/push-gate.test.js  (only if the lock changes what it asserts)
      - package.json  (the run-suites script)
      - docs/dev.md
    blockedBy: []
    laws: a skipped money gate is never a pass (feedback-gate-result-is-the-receipt, push-gate guard 5); counts come from the runner's own summary, never the exit code
    lenses: the full current fleet (testdb-smoke.js and push-gate.js are sensitive-listed gate machinery) plus /second-opinion; the acceptance checks are the review
    test plan: the sibling suites; two concurrent runners on one lock; a killed lock holder
    revert: git revert of the squash commit (after review-tooling and receipt-lib, which import tapSummary)
  - id: receipt-lib
    scope: receipt keys, the verdict-table parser, the receipt directory and index, the commit-message block (spec 3.5, 3.7)
    footprint:
      - scripts/lib/receipt.js
      - scripts/lib/receipt.test.js
      - scripts/review-receipt.js
      - scripts/review-receipt.test.js
    blockedBy: [suite-runner]
    laws: a report with no table is not a pass (3.5); a receipt is a local file, not a privilege boundary (3.7)
    lenses: code-review and consistency-check; the acceptance checks are the review
    test plan: the key stability cases in a throwaway repo; the parser's malformed cases; the CLI end to end
    revert: git revert of the squash commit (after review-tooling and review-skill)
  - id: lenses
    scope: the nine lens agents built from lens-audit/, the verify agent, performance-review rewritten explicit-only (spec 3.2, 7); adds only, the cuts are retire-old-fleet
    footprint:
      - .claude/agents/money.md
      - .claude/agents/lifecycle.md
      - .claude/agents/concurrency.md
      - .claude/agents/business-time.md
      - .claude/agents/outcomes-providers.md
      - .claude/agents/access-egress.md
      - .claude/agents/seams.md
      - .claude/agents/schema-data.md
      - .claude/agents/client.md
      - .claude/agents/verify.md
      - .claude/agents/performance-review.md
    blockedBy: []
    laws: the money lens reads docs/money-laws.md before any file; lens checks cite defect ids and carry no bracket (3.2)
    lenses: a Fable read of each lens file against its sources (coverage: every kept check present, every cut check absent, every id resolves); the acceptance checks are the review
    test plan: the mechanical checks plus the Fable read
    revert: git revert of the squash commit
  - id: review-tooling
    scope: lens selection and brief generation as scripts (spec 3.2 to 3.4, 9)
    footprint:
      - scripts/lib/lensTriggers.js
      - scripts/lib/lensTriggers.test.js
      - scripts/review-select.js
      - scripts/review-select.test.js
      - scripts/review-brief.js
      - scripts/review-brief.test.js
    blockedBy: [pii-shapes, sensitive-match-2, suite-runner, receipt-lib]
    laws: the computed lens set is binding and the plan's list is a forecast (3.3); the brief carries the money laws verbatim for the money lens and the externals (3.4)
    lenses: code-review and consistency-check; the acceptance checks are the review
    test plan: the sibling suites; a money diff, a client diff, a docs diff and an oversized diff as fixtures
    revert: git revert of the squash commit (after review-skill)
  - id: review-skill
    scope: the review skill and its brief template (spec 3.1 to 3.9), proven on its own lane
    footprint:
      - .claude/skills/review/SKILL.md
      - .claude/skills/review/brief-template.md
    blockedBy: [static-checks, lenses, review-tooling]
    laws: spec 3.1 items 1 to 6 are the definition of properly reviewed; D13 (a bug fix's receipt names the test that fails on the old code); D14 (one full pass, three bounded re-passes)
    lenses: the skill run on its own lane (the first real receipt), then the current fleet on the two files; the acceptance checks are the review
    test plan: the dogfood receipt, read field by field against the contract
    revert: git revert of the squash commit
  - id: design-commands
    scope: the plan fleet shrinks to fidelity and decomposition and expects lane maps without code (spec 7, D12)
    footprint:
      - .claude/commands/review-plan.md
      - .claude/agents/plan-fidelity.md
      - .claude/agents/plan-decomposition.md
      - .claude/agents/plan-feasibility.md  (deleted)
    blockedBy: []
    laws: none (prose about plans)
    lenses: none; the acceptance checks are the review
    test plan: /review-plan run on this plan from a drb session
    revert: git revert of the squash commit
  - id: retire-old-fleet
    scope: the five discipline agents, the three commands and the gemini MCP entry go; every tracked reference to them is re-pointed; full-audit points at the new lenses; the project CLAUDE.md gets its transitional block; the review memories get a dated pointer (spec 7, 8)
    footprint:
      - .claude/agents/security-review.md  (deleted)
      - .claude/agents/database-review.md  (deleted)
      - .claude/agents/consistency-check.md  (deleted)
      - .claude/agents/code-review.md  (deleted)
      - .claude/agents/ui-ux-review.md  (deleted)
      - .claude/commands/codex-review.md  (deleted)
      - .claude/commands/gemini-spec.md  (deleted)
      - .claude/commands/review-before-deploy.md  (deleted)
      - .mcp.json  (deleted)
      - .claude/commands/full-audit.md
      - .claude/CLAUDE.md  (the transitional block at the top; the design-stage fleet paragraph; the design-artifacts Review bullet; nothing else)
      - docs/runbooks/override-conversion.md  (the one line that dispatches two cut agents)
      - README.md  (the one tree line that counts the agents)
      - .claude/settings.local.json  (gitignored, project-local; .bak-20261020 first; the enabledMcpjsonServers gemini-cli entry removed)
      - ~/.claude/agents/ui-ux-reviewer.md  (outside git; renamed to ui-ux-reviewer.md.bak-20261020)
      - ~/.claude/projects/-home-drbartender/memory/{feedback_preprod_review_agents,feedback_review_proportionality,feedback_review_agents_foreground,feedback_execution_review_cadence,feedback_consistency_check_verdict,project-design-stage-review-fleet}.md  (outside git; one dated pointer line each; the memory backup of 2026-10-20 already exists)
    blockedBy: [review-skill, design-commands]
    laws: no lane merges with neither fleet available (this lane is last); the old push-time review layer is not run from this merge on (spec 8)
    lenses: reviewed by the new skill (its first use on a hinge diff); the acceptance checks are the review
    test plan: the skill's receipt for this lane; the greps over tracked files; a fresh drb session listing the skill and the agents
    revert: git revert of the squash commit; copy the .bak files back; strip the dated lines from the six memories
---

# Instruction rewrite, step 2: the review skill, the lenses, the pre-steps

**Goal:** make "properly reviewed" (spec section 3) a thing a session can run: a skill that computes the tier and the lenses from the diff, runs the mechanical pre-steps, writes one brief, dispatches the nine lenses and the verify pass, triages, runs the tests the tier requires behind a lock, and writes a receipt directory that steps 3 and 5 will consume. From the merge of the last lane on, every lane is reviewed this way before it merges, and the old push-time review layer is not run.

**Spec:** `docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md` (rev 6), sections 3.1 to 3.10, 4.3 (the locks), 4.7, 6.1, 7, 8 (step 2), 9, D11, D12, D13, D14, D15. The lens content comes from `docs/superpowers/specs/2026-10-19-lens-audit.md` sections 6 and 7 and the eight inventories under `docs/superpowers/specs/lens-audit/`.

**Decisions this plan makes that the spec left open or left contradictory, stated here so Dallas sees them:**

1. The receipt, the lens selection and the brief are scripts with tests, not prose the session re-derives each run: `scripts/review-receipt.js` (keys, verdict parsing, the receipt directory, the commit block), `scripts/review-select.js` (tier and lenses from the diff) and `scripts/review-brief.js` (the brief from the template). The skill's SKILL.md is the procedure that calls them. Steps 3 and 5 import the same `scripts/lib/receipt.js` and `scripts/lib/tapSummary.js`, so the parser merge-lane.sh and ship trust is the one the skill wrote with.
2. The old agents are cut in the last lane, after the skill exists, so no lane merges with neither fleet available; the lenses lane only adds files.
3. D11 says the hinge set is "tier A from the flip" and 3.3 gives it its own lighter tier; this plan follows 3.3 (hinge is a tier: seams plus access-egress, the pre-steps, the reached suites, no smoke, no externals). When tiers mix in one diff, the review takes the union of the per-file floors and is labelled by the highest tier in the order A, hinge, B, C, docs.
4. The content rule and the PII pre-step look only at added lines in code paths (`server/`, `client/src/`, `scripts/` with `.js`, `.mjs`, `.sh`), never at tests, docs or `.claude/`. The spec's 4.7 docs tier is by path alone, and a plan that quotes `UPDATE proposals SET` must not compute tier A (the fleet verified it would have, on this plan's own commit).
5. The `logic` section of `checks-client-copy-schema.md` (8 defects) maps to no lens in spec 3.2; it goes to seams. code-review's duplication, status-code and naming checks go to seams and its loading and empty states to client, as the lens audit says.
6. The receipt is keyed at the end, not the start: the skill works under a branch-named working directory and `finalize` computes the key from the final tip, so a fix committed after the first pass never leaves the key stale.

## What the plan fleet changed (rev 1 to rev 2)

Fidelity and decomposition each returned two blockers and a dozen warnings; every finding was read against the repo and folded. The gemini-cli entry is in `os/.claude/settings.local.json`, not the home file. The content rule and the PII pre-step scope to added lines in code paths. The tier order and the union of floors (decision 3). The receipt is keyed at finalize, re-pass reports have a storage rule, and an unforecast lens is recorded. testdb-smoke.js gains a TAP log mode and no lane trusts its exit code. run-suites gains `--staged` and an exported `reachedSuites`. review-tooling split out of review-skill. Registration points for the skill and the lenses named. The client lens's inputs named honestly (the audit's "thirteen" capture checks are not enumerable from committed files; the lane carries the capture checks of both ui-ux files and lists what it dropped). Every surviving reference to a cut agent is in a footprint (the project CLAUDE.md's design-fleet paragraph and Review bullet, plan-decomposition's checkpoint lines, the override-conversion runbook, the six review memories); ARCHITECTURE's fleet list and cadence table are named as step 4's. The per-lane D12 fields added. Smaller: `fail 0` instead of a hard-coded count, the Stripe shape anchored, the mobile-capture manifest dropped from the allowlist, the `stripe-test-mode-until` rule and the secret-default rule stated, the branch naming convention, the revert order, the README rows deferred to step 4, the spec agents and review-spec confirmed as no-ops.

## Global constraints

- No em dash character in any file this plan writes (feedback_no_em_dashes, 2026-08-14).
- Ids only under `os/`: no client or staff name, email or phone number in any file, fixture, lens example or commit message (feedback-no-client-pii-in-repo-docs, 2026-10-14; D9). Fixtures and the business lines may appear.
- Every rule in SKILL.md ends with a bracket, `[Dallas YYYY-MM-DD]` or `[Claude default]` (spec 6.1); lens checks cite defect ids instead and carry no bracket (3.2). No quote under `os/`.
- Files outside git get a `.bak-20261020` copy before the first edit, `sha256sum` before and `cmp` after; nothing under `~/.claude` is deleted (a cut file is renamed to `.bak-20261020`). Before a by-hand edit outside git, check for other live sessions the way step 1 did and re-read the file right before writing it.
- Nothing is pushed. Pushes are cue-only until the flip (section 8). Lanes merge through `scripts/merge-lane.sh` from `os` on main.
- Thinking on main: this plan commits to main before any lane is cut.
- Lane branches are named `rewrite-step2-<lane id>`. Each lane window opens through `drb rewrite-step2-<lane id>`; the review-skill window opens after the lane is rebased onto a main that holds the lenses, and the retire-old-fleet window opens after the lane is rebased onto a main that holds the skill, so the agents and the skill register from the worktree. Fallback when something is not registered: inline the agent file in the Agent prompt, as step 1 did.
- Model tiering: lenses `model: opus`; verify `model: fable` (spec 3.2; feedback_subagent_model_opus).
- A new script under `scripts/` gets a sibling `.test.js` run with `node --test`, as the twelve existing ones are, with one exemption: `scripts/content-rule-calibrate.js` is a one-off report whose output is the lane report. Counts are read from the TAP summary, never the exit code alone (feedback-gate-result-is-the-receipt).
- The dev database is shared: no lane runs a server suite while another window runs one, and never `CREATE TEMP` (docs/dev.md).
- README's tree and scripts table are not edited for the new scripts; step 4's generator writes them (the fleet asked for this to be said).

## Review focus

The five ways this step bites, each pinned to a check:

1. The content rule misses money diffs in unlisted files, which is the whole reason it exists (lens audit section 4), or fires on docs: the calibration script reports recall over the money defects' fix diffs with every miss by id, and zero hits over the docs-only commits (sensitive-match-2, check 4).
2. The receipt key changes when it should not (a content-identical rebase) or stays when it should not (a conflict resolution, a new commit), or generated-doc churn is not excluded: pinned by the key tests (receipt-lib, check 1).
3. A lens that returns prose, a table missing files, or a table with an unknown verdict is read as a pass: the parser treats every one of those as `not reached` for the missing files (receipt-lib, check 2; review-skill, check 6).
4. The locks deadlock or do not hold, or a skipped smoke reads as a pass: the smoke lock is taken blocking inside push-gate's own lock in the spec's order, a killed holder releases it, and a `skipped: true` summary is refused by `finalize` (suite-runner, checks 2, 3 and 6).
5. A real person's number or a token reaches codex or gemini, or a fixture or a snake_case identifier is masked into noise: the shape tests carry both directions (pii-shapes, check 1).

## Order

1. pii-shapes, sensitive-match-2, suite-runner, lenses and design-commands are independent and may run in parallel windows (each its own lane; the dev-DB rule still serializes suite runs).
2. static-checks after pii-shapes; receipt-lib after suite-runner.
3. review-tooling after pii-shapes, sensitive-match-2, suite-runner and receipt-lib.
4. review-skill after static-checks, lenses and review-tooling.
5. retire-old-fleet last, after review-skill and design-commands, reviewed by the skill it switches on.

Revert in reverse dependency order: retire-old-fleet, review-skill, review-tooling, then the libraries; a library reverted first breaks its importers.

## Contracts shared across lanes

These are the decisions the lanes build to; a lane that finds one wrong rules and ledgers it like the step 1 plan did.

**The verdict table (3.5).** The last thing in a lens report, a markdown table with the header row `| file | verdict | note |`, one row per file in the brief's file list, verdict exactly one of `pass`, `finding`, `not reached`, `escalate`, the note naming the finding ids (`H1`, `M2`, `L1`, severity letter plus number) or the reason. Findings are listed above the table under the same ids, each with file:line, the defect in one sentence, the failure path, and the check id from the lens that applies. A report with no table, or a table missing a file, reads as `not reached` for the missing files.

**Named triggers (3.2).** Every trigger regex in `scripts/lib/lensTriggers.js` has a name, `<lens>.<slug>` (for example `money.update-proposals`, `concurrency.for-update`). The brief's "Triggers that fired for you" section lists the names; each check in a lens file ends its trigger line with the names that point at it, and the lens reads those checks first.

**The brief (3.4).** One markdown file per review, generated from `brief-template.md`, sections in this order: Review (working name, kind, branch, tip, reviewed_against); Tier and why (matched paths with their sections, content-rule hits, the per-file tiers and the union of floors); Files (the list the lens must return verdicts for); Diff (the path of the diff file: commit list, stat, `-U10`); Plan and spec (paths, and the lane's forecast lens list when `--plan` and `--lane` are given); Established (pre-step results, tests run with counts and their logs, build status, questions already settled); Triggers that fired for you (names); Money laws (the money lens and the externals only: `docs/money-laws.md` verbatim); Design artifact and captures (the client lens only: the artifact path and the screenshots at 320 and 390 wide the main session captured, with the adherence instruction of spec 6.3); Budget ("finish within roughly N tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach", N = 30 plus 5 per file in the list, capped at 150); Standing lines ("print no real person's phone number; fixtures and the business lines are fine; refer to people by role"); Output (findings, then the verdict table, nothing after it). A diff over 4,000 lines is split by area into several briefs up front, each with its own file list; the lens reports are then `<lens>.part-<n>.md`.

**The receipt (3.7).** While a review runs its files live under `<git-common-dir>/drb-review/_work/<branch>/` (quick fixes: `_work/quick-fix-<timestamp>/`). `finalize` computes the key from the final tip, moves the directory to `<git-common-dir>/drb-review/<key>/` and records `base`, `tip` and `reviewed_against` as they stand then. The directory holds `receipt.json`, `brief.md` (or `brief.part-<n>.md`), `diff.patch`, `<lens>.md` for each lens's first pass, `<lens>.pass-<n>.md` for a re-pass (a fix re-review or a not-reached re-dispatch), `<lens>.part-<n>.md` for a split brief, `verify.md`, `externals/` (the codex and gemini outputs or `not-run.txt` with the reason), and `tests/` (every runner log and the smoke `summary.json`). `verdicts` merges by file: the latest stored report that lists a file sets its verdict; coverage is computed over the merged map. `receipt.json` fields: `version` (1), `key`, `kind` (`lane`, `quick-fix`, `commit`, `squash`, `revert`, `comment-only`), `branch`, `tip`, `reviewed_against`, `base`, `tier`, `tiers_by_file`, `matched_paths` (with sections), `content_rule_hits`, `lenses` (per lens: `name`, `fired_because` (trigger names or `floor`), `forecast` (true when the plan's lane named it), `raised`, `confirmed`, `fixed`, `rejected`, `passes` (report file names), `verdicts` as file to verdict), `unforecast_lenses`, `coverage` (`files_in_diff`, `files_with_verdicts`, `not_reached`), `tests` (per run: `command`, `log`, `pass`, `fail`, `read_from` the summary line; the smoke entry carries `suites`, `skipped`), `failing_test_on_old_code` (`file`, `count`, `log`, or null with a reason for a non-fix), `externals` (`codex` and `gemini`: `run` or `not_run` with the reason), `verify` (`run`, `findings`), `escalated`, `timestamp`, `written_by` (`review skill`, `review --commit`, or `comment-only proof`). The index `<git-common-dir>/drb-review/index.json` maps branch name to `{key, tip, reviewed_against, at}`; a lookup falls back from key to branch (3.8).

**The keys (3.7).** lane: the first field of `git diff <base> <tip> -- . ':!README.md' ':!ARCHITECTURE.md' | git patch-id --stable`; quick-fix: `git write-tree` on the staged index; commit: the patch id of `<sha>^..<sha>` with the same exclusions. Steps 3 and 5 compute the same three through `scripts/lib/receipt.js`.

**Tier (3.3).** Per file: A when the path is in a money, auth-and-PII or client-money-surfaces section of the sensitive list, or the content rule fires on its added lines; hinge for a path in the D11 hinge set when the content rule did not fire, for a non-code file under `scripts/` (a manifest or list configures the tooling), and for every unclassified path (anything not under `server/`, `client/`, `scripts/`, `docs/` and not on the docs allowlist; `.claude/**`, `.mcp.json` and the root files are the common cases, spec 3.3); B for any other path under `server/`, any `.js`, `.mjs` or `.sh` file under `scripts/` not on the list, or any other status write; C for everything else under `client/`; docs for a path on the docs allowlist (4.7) that is not sensitive. The review's lens floor is the union of the per-file floors; its label is the highest per-file tier in the order A, hinge, B, C, docs; its tests are the union too (smoke for any A file, the reached suites for A, B and hinge, the client build for any `client/` file). Until the flip gives the list sections, an unsectioned list reads as one money section (today every listed path means the full fleet). The D11 hinge set lives in `sensitive-match.js` as a constant until the flip moves it into the list.

**Lens selection (3.2, 3.3).** The tier floors plus every lens whose trigger matches the diff. Floors: A gets money, lifecycle, concurrency, outcomes-providers, access-egress, seams, the externals and verify; B gets seams, plus access-egress for a new file under `server/routes/` or `server/middleware/`; C gets client and seams; hinge gets seams and access-egress; docs gets none. Triggers, regexes over the diff's added lines in code paths (file-path triggers in parentheses), the named constants in `scripts/lib/lensTriggers.js`:

- money: `UPDATE\s+proposals\s+SET`; `\b(total_price|amount_paid|amount_due|external_paid|total_price_override|pricing_snapshot|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|gratuity_floor_rate|payout_id|deposit_amount)\b`; `stripe\.(refunds|paymentIntents|checkout|paymentLinks|customers|invoices|payouts)\.`; `\b(refundExecute|applyRefundReconciliation|calculateProposal|getStripe)\(` (and any path in a money section).
- lifecycle: `\bSET\s+status\b|\bstatus\s*=\s*'`; `_STATUSES\b`; `archive_reason`; `pay_periods`; `setInterval\(` (and paths matching `Scheduler\.js|Sweep\.js|Reaper\.js`).
- concurrency: `FOR UPDATE`; `pool\.connect\(`; `\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|SAVEPOINT`; `ON CONFLICT`; `Promise\.all\(`; `rowCount`; `retry|attempt`; `setTimeout\(|setInterval\(`; the status write regexes of lifecycle; a provider call that moves money or sends: `stripe\.\w+\.\w+\(|twilio|resend|send(Email|SMS|Push)\(|fetch\(` (and the scheduler paths of lifecycle, the tick).
- business-time: `CURRENT_DATE|CURRENT_TIMESTAMP|NOW\(\)`; `new Date\(`; `::date\b|\bDATE\b|INTERVAL '`; `AT TIME ZONE`; `chicagoTodayYmd|toISOString|toLocaleDateString|setDate\(`; `_days?\b|Days?\b`.
- outcomes-providers: `catch\s*(\(|\{)`; `ok:\s*(true|false)`; `'skipped'|'failed'|'notifications_off'`; `process\.env\.`; `TwiML|<Response>|twiml`; `webhook`; `\bCOMMIT\b` (a COMMIT followed by work is the lens's check); `require\('(stripe|twilio|resend|@anthropic-ai/sdk|openai|@google/genai|web-push|googleapis)'\)`; `\.post\(|fetch\(`; `page\.(click|goto|fill|waitFor)\(` (and paths under `thumbtack-agent/`, the DOM agent).
- access-egress: `router\.(get|post|put|patch|delete)\(`; `\bauth\b|req\.user|requireOnboarded|role`; `Limiter|rateLimit`; `console\.(log|error)\(|Sentry\.`; `send(Email|SMS|Push)\(|anthropicClient|openaiClient|geminiClient`; `res\.(json|send|download)\(`; `webhook`; `requireUuidToken|publicToken|/t/:token` (a public form or token route); `\.csv|exportCsv|Content-Disposition` (an export) (and any path under `server/routes/` or `server/middleware/`).
- seams: no trigger; seams is in every non-docs floor and the constant records that.
- schema-data: `CREATE TABLE|ALTER TABLE|ADD COLUMN|CHECK \(|CREATE (UNIQUE )?INDEX`; `INSERT INTO (service_addons|service_packages|cocktails|mocktails|par_)` (and paths `server/db/schema.sql`, `server/db/index.js`, `server/scripts/`, `scripts/`, anything named `seed`).
- client: any path under `client/src/`.

Escalation: a lens may return `escalate` in its table when it sees money, auth or PII material outside its tier; the skill bumps the review to tier A and re-runs selection before merge. An unforecast lens (one that fired which the plan's lane did not name) is recorded in the receipt and named in the one-line report.

**The content rule (3.3).** Applies to added lines in code paths only (`server/`, `client/src/`, `scripts/`, files ending `.js`, `.mjs` or `.sh`, excluding `*.test.js` and `scripts/content-rule-calibrate.js`); docs-allowlisted paths, `.claude/**` and every other path never fire it. It fires on: `UPDATE\s+(proposals|invoices|invoice_payments|proposal_payments|proposal_refunds|payouts|pay_periods|tips|shifts|service_extensions)\b` in a hunk that also writes `status` or a money column from the money list above; `stripe\.(refunds|paymentIntents|checkout|paymentLinks|customers|invoices|payouts)\.\w+\(`; `\b(refundExecute|issueRefund|applyRefundReconciliation)\(`; a read or write of `\b(total_price|amount_paid|amount_due|external_paid|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|payout_id|rate|quantity)\b`. The calibration script runs it over `git show <fixed_ref>` for every row of `lens-audit/defects.jsonl` with `money: true`, `bites: true` and an 8-hex `fixed_ref` whose commit exists, and prints recall with the misses by id; the floor is 85 percent, and a lower figure means the lane widens the regexes (never the floor) and reports what it added. Its false-positive run is every docs-only commit on main since 2026-10-01 (including `c7646136` and this plan's commits), expected zero.

**PII pre-step and mask (3.3, 3.10).** Shapes: `EMAIL`; `PHONE` (the board writer's); `TOKEN` (bearer-style, the JWT-ish pair, `sk_`, 32 or more hex); `STRIPE_ID` anchored, `\b(pi|cus|ch|re|evt|in|sub|cs|seti|pm)_[A-Za-z0-9]{14,}`, so `files_in_diff` and `min_total` never match; `ROUTING_EIN` (nine digits plain or `\d{2}-\d{7}` within 40 characters of the words routing, EIN or account). Allowlist, the one list: path globs `**/*.test.js`, `server/db/seedTestData.js`, `server/utils/smsLines.js`, `server/utils/companyPhone.js`; literals read at load from `smsLines.js` and `companyPhone.js` (the business lines); the `555` fixture prefix for phone shapes; the `@drbartender.com` domain for emails (the business addresses, named in code and docs by design). The pre-step scans added lines of code paths only; the mask (`--mask-diff`) reads `diff --git a/<path>` headers and applies the per-file allowlist to each file's hunks.

**The smoke summary.** `testdb-smoke.js --tap-dir <dir>` runs each suite with `--test-reporter=tap`, writes `<dir>/<suite>.log` per suite and `<dir>/summary.json` `{suites: [{file, pass, fail}], total_pass, total_fail, skipped}`, `skipped: true` when no Neon key resolved (today's SKIP banner path); without the flag its console behavior is unchanged. `review-receipt.js tests --smoke <dir>` reads the summary and refuses `skipped: true` as a pass (push-gate's guard 5, kept). One parser, `scripts/lib/tapSummary.js`, reads `# pass N` and `# fail N` for run-suites, testdb-smoke and review-receipt; a log with no summary line is a failure, never a zero.

**The locks (4.3).** `<git-common-dir>/drb-smoke.lock` taken blocking by `testdb-smoke.js` itself (flock, re-exec under the lock the way `merge-lane.sh` does, with a guard env var against re-exec loops) so a review-time smoke and a gate never reset ci-smoke under each other; push-gate's existing `drb-push-gate.lock` stays outside it, so the order is push-gate (later the ship lock), then smoke. `<git-common-dir>/drb-devdb.lock` taken blocking by `run-suites.js` for every run of the ordinary suites. Both print one line when they wait.

## Lane: pii-shapes

**`scripts/lib/piiShapes.js`.** Exports the shapes and `ALLOWLIST` of the PII contract; `findPii(text, {path})` returning hits `{shape, line, match}` with the allowlist applied by path and by literal; `mask(text, {path})` replacing every hit with `<SHAPE>`; `maskDiff(diffText)` applying `mask` per file from the diff headers; a CLI: `node scripts/lib/piiShapes.js --check "<line>"` (exit 0 clean, 1 blocked, the board writer's old contract), `--mask-diff < diff`, `--find --added <base> <tip>` (added lines of code paths only; the static-checks `pii` rule calls this).

**`scripts/board-write.sh`.** `denylist_check` calls the module's `--check` instead of its four inline greps; the four greps are removed, the messages stay. `board-write.test.js` keeps its cases and adds one per new shape and one snake_case negative.

**`~/.claude/commands/second-opinion.md`.** Edited by hand after this lane has merged to main (the edit is live in every window the moment it lands, and the four pre-flip worktrees have no module). Section 1 writes the diff through `node /home/drbartender/projects/os/scripts/lib/piiShapes.js --mask-diff` (the absolute path) before anything is sent, and refuses to run when that file is missing; a `--brief <file>` argument, when the review skill passes it, is appended to the shared brief (the money laws); section 5 ends with two fixed lines, `codex: run|not run (<reason>)` and `gemini: run|not run (<reason>)`, so the receipt can read them.

**Acceptance checks**

1. `node --test scripts/lib/piiShapes.test.js` passes and the suite holds at least: a real-format phone number is found and masked; the two business lines are not; a 555 fixture is not; a number in a `*.test.js` path is not; `sk_live_` and a 32-hex token are found; `pi_` plus 24 characters is found and `files_in_diff`, `min_total`, `share_cents`, `admin_owned`, `recapture_line` are not; `routing 123456789` and `12-3456789` beside EIN are found and a plain nine-digit id beside the word proposal is not; an email is found and a `@drbartender.com` address is not; `--check` exits 1 on a blocked line and 0 on a clean one; `maskDiff` masks a real-format number in one file of a two-file diff and leaves a fixture in the other file untouched.
2. `node --test scripts/board-write.test.js` passes with the module behind `denylist_check`; `bash scripts/board-write.sh --check "<a line with a phone number>"` exits 1 and the old message prints.
3. After the merge: `cmp` of `second-opinion.md.bak-20261020` against the pre-edit file passes; the edited command runs end to end on a scratch diff that contains one fixture number and one real-format number: the masked `so-diff.patch` contains `<PHONE>` once and the fixture untouched; with the module path temporarily unreadable it stops before launching either reviewer.
4. `grep -c` for the em dash character is 0 in every file the lane writes; no file carries a real-format number outside the test fixtures.

## Lane: static-checks

**`scripts/static-checks.js`.** `node scripts/static-checks.js --base <sha> --tip <sha>` (or `--staged`) runs over the changed files only and prints JSON `{findings: [{rule, file, line, text, blocking}], blocking: n}`, exit 1 when `blocking > 0`. Rules, each a named regex or small AST-free check over the changed file's added lines (whole-file where the rule says so), blocking unless marked advisory: `parameterized-sql` (a `query(` whose SQL string interpolates or concatenates a variable); `command-injection` (`exec(`, `execSync(` with a template or concatenation); `ssrf` (`fetch(` or `axios(` whose URL comes from `req.`); `secrets-in-client-bundle` (`sk_live`, `sk_test`, `whsec_`, a 32-hex literal under `client/src/`); `env-ignored` (`.env` or `client/.env*` appearing in `git ls-files`, whole repo); `stripe-direct` (`require('stripe')` outside `server/utils/stripeClient.js`); `stripe-test-mode-until` (an added line that assigns `STRIPE_TEST_MODE_UNTIL` a literal date outside `.env.example`, advisory: the gate worktree and prod settings are Dallas's); `jwt-literal-secret` (`jwt.sign(` whose secret argument is a literal); `secret-default` (`process.env.<NAME> || <literal>` where NAME ends in `_SECRET` or `_KEY` or is `JWT_SECRET`; blocking); `env-default` (any other `process.env.X || <literal>`, advisory); `missing-auth-import` (a new file under `server/routes/` with router handlers and no `auth` import, advisory); `dangerously-set-inner-html`; `swallowed-catch` (a catch with an empty body or a body that only comments); `begin-without-rollback` (a file adding `BEGIN` with no `ROLLBACK`, whole file); `floating-security-versions` (`^` or `~` on `jsonwebtoken`, `bcryptjs`, `stripe`, `express`, `helmet`, `pg` in either `package.json`); `file-or-git-deps` (`file:` or `git+` in either `package.json`); `eslint-undef` (eslint with `no-undef` and `no-use-before-define` as errors over the changed `.js` files under `server/` and `scripts/` through the repo's config; the client is covered by its CI build); `pii` (piiShapes `--find --added`).

**Acceptance checks**

1. `node --test scripts/static-checks.test.js` passes with one fixture per rule proving it fires and one proving it stays quiet, run against a throwaway git repo the test builds (the pattern of `board-write.test.js`).
2. Run against `d6f02e8c^..d6f02e8c` (step 1's squash, docs and prose): `blocking: 0` and no eslint run (no `.js` changed). Run against a scratch commit that adds `const x = y;` to a server file: `eslint-undef` fires.
3. The whole run over the largest recent squash by file count among `git log main --grep='merge(lane' -20` (named in the lane report with its count) finishes in under 60 seconds on the box.
4. No em dash; ids only.

## Lane: sensitive-match-2

**`scripts/sensitive-match.js`.** Keeps every current export (`isSensitive`, `matchSensitive`, `loadPatterns`, `patternToRegex`) with their behavior for `*` (never crosses a slash) and adds: `**` (crosses slashes; `server/utils/inbox/**` therefore matches the same 68 flat files today and any subdirectory later, and the spec's note about naming subdirectories is moot, there are none); sections, read from `# section: <name>` header lines in the list, returned as `{pattern, section}` from `loadPatterns`, with an unsectioned list reading as section `money`; `HINGE_PATHS`, the D11 set as path globs (the review skill and its brief template, the lens agents, `scripts/sensitive-paths.txt`, `scripts/sensitive-match.js`, `scripts/static-checks.js`, `.husky/*`, `.claude/settings.json`, `scripts/merge-lane.sh`, `scripts/ship.js`, `scripts/push-gate.js`, `scripts/post-ship-watch.js`, `scripts/gen-docs.js`, `scripts/lane-status.js`, `scripts/board-write.sh`, `scripts/lib/*`, `client/vercel.json`, `docs/money-laws.md`, `docs/runbooks/**`, `AGENTS.md`, `package.json`, `package-lock.json`, `client/package.json`, `client/package-lock.json`, `.node-version`, `eslint.config.mjs`, `.gitignore`); `DOCS_ALLOWLIST` (`docs/**`, `README.md`, `ARCHITECTURE.md`); `isDocsOnly(paths)` (every path on the allowlist and none sensitive, so `docs/money-laws.md` and `docs/runbooks/**` are never docs-only); `CODE_PATHS` and `isCodePath(path)` (the content rule's scope); `contentRuleHits(diffText)` returning `{file, line, rule}` per hit, code paths only; `tier({paths, diffText})` returning `{tier, tiersByFile, floors, matchedPaths, sections, contentRuleHits, hingePaths}` per the tier contract. The CLI gains `--tier` (reads `git diff --name-only` and the diff from stdin or `--base/--tip`) and prints the JSON.

**`scripts/content-rule-calibrate.js`.** Read-only: selects the defects.jsonl rows per the content-rule contract, runs `contentRuleHits` over `git show --format= <fixed_ref>` for each, prints recall, the miss list by id with area, and the false-positive check over the docs-only commits since 2026-10-01 (expected zero hits).

**Acceptance checks**

1. `node --test scripts/sensitive-match.test.js` passes; the suite keeps every existing case and adds: `**` crosses a slash and `*` still does not; an unsectioned list yields section `money` for every pattern; a sectioned fixture list yields each pattern's section; `isDocsOnly(['docs/money-laws.md'])` is false and `isDocsOnly(['docs/x.md','README.md'])` is true; `tier` returns A for a diff that adds `UPDATE proposals SET amount_paid` in a server file, docs (not A) for the same line in `docs/x.md`, nothing for the same line in a `*.test.js`, B for a plain server file, hinge for `scripts/merge-lane.sh` alone, C for a client CSS file, docs for a plan file; a hinge-plus-server diff returns label hinge with floors seams and access-egress; a hinge-plus-client diff returns hinge with floors seams, access-egress and client.
2. Every current consumer still works: the list of files that require or invoke `sensitive-match` (from `grep -rln "sensitive-match" scripts/ .claude/ docs/ --include=*.js --include=*.sh --include=*.md`) is in the lane report and each script among them runs its own test green (`push-gate.test.js`, `lane-status.test.js`, `merge-lane.test.js`).
3. `node scripts/sensitive-match.js --tier --base d6f02e8c^ --tip d6f02e8c` prints label `hinge` (the step 1 squash touched `docs/money-laws.md`, `AGENTS.md`, `.claude/agents/*` and `scripts/claudemd-invariants.txt`, all hinge, plus docs).
4. The calibration run's output is in the lane report: recall at or above 85 percent over the selected defects, the misses listed by id, and zero hits over the docs-only commits since 2026-10-01.

## Lane: suite-runner

**`scripts/lib/tapSummary.js`.** `parse(text)` returning `{pass, fail, cancelled, skipped, found}` from the TAP summary lines (`found: false` when no `# pass` line exists); `sum(summaries)`.

**`scripts/run-suites.js`.** `node scripts/run-suites.js --changed <base>..<tip> | --staged [--log-dir <dir>]` or `node scripts/run-suites.js <file.test.js>...`. Exports `reachedSuites(changedPaths)`: the `.test.js` sibling of every changed non-test file under `server/` and `scripts/`, plus every `.test.js` under those roots whose `require` targets resolve to a changed module (direct requires only, one hop, a stated limit). Takes `drb-devdb.lock` blocking, runs each suite serially with `node -r dotenv/config --test --test-reporter=tap <file>`, writes each suite's full output to `<log-dir>/<suite-with-slashes-as-dashes>.log` (default `<git-common-dir>/drb-review/_runs/<timestamp>/`), parses the summary through `tapSummary`, prints one line per suite and a totals line, exits 1 when any `fail` is non-zero or any summary is missing. `npm run run-suites` maps to it.

**`scripts/testdb-smoke.js`.** Takes `drb-smoke.lock` blocking around the whole flow (reset, URI, initDb, suites), printing `waiting for the smoke lock` when blocked; gains `--tap-dir <dir>` per the smoke-summary contract and `--dry-lock` (take the lock, print, exit, touch nothing); otherwise unchanged, and `push-gate.js` keeps its own lock outside, so a gate run holds push-gate then smoke, never the reverse.

**`docs/dev.md`.** The "Running tests" section gains: the ordinary suites run through `npm run run-suites` behind the dev-suite lock, which serializes every window; the money smoke takes the smoke lock itself; both print one line while waiting; the lock files live in the git common dir and need no cleanup after a crash (flock releases on exit).

**Acceptance checks**

1. `node --test scripts/lib/tapSummary.test.js scripts/run-suites.test.js` pass: the reached set for a fixture tree is the sibling plus the one-hop importer and nothing else; `--staged` resolves the staged paths; a suite whose output lacks the TAP summary is a failure; counts are read from `# pass`/`# fail`; the log file exists per suite.
2. Two concurrent `run-suites` processes on the same lock file serialize: the second prints the waiting line and starts after the first exits (a test with a sleep-based fake suite, under 10 seconds).
3. A holder killed with `kill -9` releases `drb-smoke.lock` and `node scripts/testdb-smoke.js --dry-lock` acquires it; `push-gate.test.js` stays green.
4. `node scripts/run-suites.js --changed d6f02e8c^..d6f02e8c` reports no suites reached (docs and prose) and exits 0; `node scripts/run-suites.js scripts/sensitive-match.test.js` reports `fail 0` and a `pass` count equal to the suite's own `# pass` line, and exits 0.
5. `npm run run-suites -- scripts/sensitive-match.test.js` works from a lane worktree (the `.env` symlink makes `dotenv/config` find the dev database).
6. `node scripts/testdb-smoke.js --tap-dir <tmp>` with the Neon key unset writes `summary.json` with `skipped: true` and exits as today; with the key present it is not run by this lane (a real smoke is eight minutes of a shared branch) and the summary shape is covered by a unit test over a fixture log set.
7. `docs/dev.md` lines pass `scripts/board-write.sh --check`; no em dash.

## Lane: receipt-lib

**`scripts/lib/receipt.js`.** Exports `laneKey(base, tip)`, `quickFixKey()`, `commitKey(sha)` (the key contract); `parseVerdictTable(markdown)` returning `{rows: [{file, verdict, note}], findings: [{id, severity, file, line, text}], malformed: bool}` where a missing table, a bad header or an unknown verdict sets `malformed` and yields no rows; `mergeVerdicts(reportsInOrder)` (latest report that lists a file wins); `coverage(fileList, merged)` returning the files with verdicts and the files not reached; `workDir(branch)` and `receiptDir(key)` under the common git dir; `writeReceipt`, `readReceipt`; `indexSet(branch, {key, tip, reviewedAgainst})` and `indexLookup(branchOrKey)`; `commitBlock(receipt)` rendering the squash-message block of spec 3.7 verbatim in shape (`Review: tier ...`, `lenses:`, `files: n/n verdicts`, `findings: raised, confirmed, fixed and re-reviewed, rejected`, `tests:`, `receipt: patch <key7>, reviewed against main <sha7>, <timestamp>`).

**`scripts/review-receipt.js`.** The CLI over the library: `init --branch <b> [--quick-fix]` (creates the working directory and a skeleton receipt); `verdicts <branch> <lens> <report.md> [--pass <n>|--part <n>]` (parses, stores the report under the contract's name, merges, updates coverage); `tests <branch> --log <file> [--command <text>]` and `tests <branch> --smoke <dir>` (reads summaries through `tapSummary`; a smoke `skipped: true` is refused); `externals <branch> codex=run|not_run:<reason> gemini=...`; `verify <branch> <report.md>`; `finalize <branch> --kind <kind> --base <sha> --reviewed-against <sha> --tier <t> [--select <select.json>] [--failing-test <file>:<count> --failing-log <log> | --not-a-fix <reason>] [--allow-not-reached] [--proof <file>]` (validates every field against the contract, computes the key from the current tip, moves the directory, writes `receipt.json`, updates the index; `--proof` is only valid with `--kind comment-only` and records `written_by: comment-only proof`); `show <key|branch>`; `block <key>`.

**Acceptance checks**

1. `node --test scripts/lib/receipt.test.js` passes with: the lane key is identical before and after a content-identical rebase and differs after a one-line change in the lane and after a conflict resolution (a throwaway repo with a generated-doc file that churns and is excluded); the quick-fix key equals `HEAD^{tree}` after committing the staged index; the commit key of a squash equals the lane key when main did not move; `finalize` after a post-review commit yields a key equal to `laneKey(base, newTip)` and records the new tip.
2. The parser: a report with no table yields `malformed: true` and zero rows; a table missing one file yields that file as not reached; an unknown verdict word marks the row malformed; findings with ids `H1`, `M2` are read with their file:line; a re-pass report that covers two of five files flips only those two.
3. `node --test scripts/review-receipt.test.js` passes: `finalize` refuses a receipt whose `coverage.not_reached` is non-empty unless `--allow-not-reached` is passed, refuses a missing `tests` entry at tier A, B and hinge, refuses `kind` outside the six kinds, refuses `--failing-test` whose count disagrees with the log's `# fail` line, refuses a smoke summary with `skipped: true`, and refuses `--proof` with any kind but comment-only; `show` finds a receipt by branch through the index after the key changed.
4. `block` output for a fixture receipt matches the spec 3.7 example line for line in shape (the lane report pastes both).
5. No em dash; ids only.

## Lane: lenses

**The nine lens files.** Each `.claude/agents/<lens>.md` with frontmatter `name`, `description` (one line: what it fires on), `tools: Read, Grep, Glob, Bash`, `model: opus`, `maxTurns: 170` (the brief's budget cap plus 20), and a body under about 150 lines: one paragraph on the shape it exists for (from the lens audit section 6 table), then the checks in descending order of the defect count behind them, each check two sentences and a trigger line that ends with the trigger names of the lens-selection contract that point at it, citing its defect ids, built from these sources (spec 3.2 and decision 5): money from `checks-money-seam.md` and the money-math section of `checks-money-math-catalog-contract.md`; lifecycle from `checks-lifecycle.md` and the scheduler section of `checks-concurrency-scheduler.md`; concurrency from the race and pool sections of `checks-concurrency-scheduler.md`; business-time from the time section of `checks-business-time-import.md`; outcomes-providers from `checks-outcomes-providers.md`; access-egress from `checks-access-egress.md` plus the kept security checks of audit section 7 (UUID tokens, magic-byte uploads, webhook secret placement as placement and trust derivation, reset tokens at rest, session invalidation, admin actions attributed, payment events logged); seams from the contract-seam section of the money-math inventory, the copy section of `checks-client-copy-schema.md`, the `logic` section of the same file, the siblings check of `checks-money-seam.md`, the status-enumeration checks of `checks-lifecycle.md`, and code-review's duplication, status-code and naming checks; schema-data from the schema section of `checks-client-copy-schema.md`, the import section of `checks-business-time-import.md`, the catalog section of the money-math inventory plus the kept database checks (idempotent statements, nullable column additions, no DROP without a plan, money columns in integer cents); client from the ui-state and a11y sections of `checks-client-copy-schema.md`, code-review's loading and empty states, the design-artifact adherence block of the current `ui-ux-review.md` (kept because spec 6.3 keeps the contract and 3.4 puts the artifact in the brief), and the capture checks of both ui-ux files (the project `ui-ux-review.md` and the global `~/.claude/agents/ui-ux-reviewer.md`): every bullet that reads as a check on a capture (overflow, contrast, keyboard lockouts, tap targets at 320 wide, garbage values, states) is carried, and the lane report lists each bullet of both files as carried or dropped with the reason; the audit's "thirteen that earned hits" is not enumerable from committed files, and the plan says so. Each file ends with the output contract (findings, then the verdict table, the budget line, the standing PII line) copied from the brief contract; the money lens's first instruction is to read the Money laws section of the brief before any file; the first instruction of every lens is to read the checks whose trigger names appear in the brief first. The mechanical greps of audit section 7 appear in no lens (they are `static-checks.js`).

**`verify.md`.** `model: fable`, `tools: Read, Grep, Glob, Bash`: an adversarial pass on each fix and on the money math of a tier A diff, returning findings only (no table, 3.5), with the same standing lines.

**`performance-review.md`.** Rewritten explicit-only: the description says it runs on request when a public page or a list endpoint changes and never by the skill; the checklist keeps only checks that are not in audit section 7's cut list and drops the priority-page list.

**Acceptance checks**

1. For the ten new files: `wc -l` shows each at or under 160 lines; every file has the frontmatter fields above; the sum of `grep -c 'model: opus'` over the nine lens files is 9 and `verify.md` says `model: fable`.
2. Every defect id cited in the ten files resolves: `grep -ohE 'D[0-9]{4}' <the ten files> | sort -u` is a subset of the ids in `lens-audit/defects.jsonl` (a one-line script in the lane report).
3. Every trigger name cited in a lens file exists in the lens-selection contract (and, once review-tooling lands, in `lensTriggers.js`): a one-line script in the lane report.
4. A Fable read (dispatched by the lane, agent prompt inlined) of each lens against its sources returns a table with one row per source check (inventory checks, the kept security and database checks, the capture bullets of both ui-ux files, the design-artifact block, code-review's moved checks): present, merged, dropped-with-reason, or missing; missing is empty, and no row names a check from audit section 7's cut list as present.
5. No quote, no bracket on a check, no em dash, no real person's number or name in any example; `bash scripts/board-write.sh --check` passes every line of the ten files.
6. `.claude/agents/performance-review.md` contains the words `explicit-only` in its description and no priority page list.

## Lane: review-tooling

**`scripts/lib/lensTriggers.js`.** The named trigger constants of the lens-selection contract as `{lens: [{name, regex}], paths: [{name, glob}]}`, `TIER_FLOORS` as data, and `selectLenses({tiersByFile, floors, diffText, paths})` returning per lens `{name, firedBecause}`; `forecastDiff(selected, planPath, laneId)` reading the plan's front matter `lenses` line for that lane and returning the lens names selected that the line does not mention.

**`scripts/review-select.js`.** `node scripts/review-select.js --base <sha> --tip <sha> | --staged [--plan <path> --lane <id>]` prints JSON: the tier result from `sensitive-match.js tier`, the lenses with the reason each fired, `unforecast_lenses`, whether the externals and verify run, which tests the tiers require (smoke, reached suites from `run-suites.reachedSuites`, client build), whether the collapse rule applies (a one- or two-file tier A diff may run as one agent carrying every applicable lens's checklist, returning one table per lens), and `refuse_quick_fix: true` when `--staged` computes any tier A file (4.2: tier A is a lane).

**`scripts/review-brief.js`.** `node scripts/review-brief.js --branch <b> --select <select.json> --pre-steps <static.json> [--tests <log>...] [--smoke <dir>] [--artifact <path> --captures <png>...] [--plan <path> --spec <path>]` renders `brief-template.md` into the working directory as `brief.md`, writes `diff.patch` (commit list, stat, `-U10`), inlines `docs/money-laws.md` when the money lens or the externals run, and splits a diff over 4,000 lines by area into `brief.part-<n>.md` up front, naming the split in the output.

**Acceptance checks**

1. `node --test scripts/lib/lensTriggers.test.js scripts/review-select.test.js scripts/review-brief.test.js` pass: a money diff selects the tier A floor plus business-time when `CURRENT_DATE` appears, with `firedBecause` naming `business-time.current-date`; a server status write selects lifecycle and concurrency; a client CSS diff selects client and seams only; a docs diff selects nothing; a `--staged` money diff sets `refuse_quick_fix`; `forecastDiff` against this plan's `lenses` line for a fixture lane returns the unforecast names; the collapse applies to a one-file tier A diff and not to a three-file one; the brief for a money review contains the first heading of `docs/money-laws.md` and the brief for a client review does not; the Triggers section lists names; a 5,000-line fixture diff is split into two briefs by area.
2. `node scripts/review-select.js --base d6f02e8c^ --tip d6f02e8c` prints label `hinge`, lenses seams and access-egress, no externals, no verify, tests: reached suites only.
3. No em dash; ids only.

## Lane: review-skill

**`.claude/skills/review/SKILL.md`.** The procedure a session follows, each rule bracketed, in this order: `review-receipt.js init`; `review-select.js` (with `--plan` and `--lane` when the branch is a plan lane); the pre-steps (`static-checks.js`, carried into the brief as established facts; a blocking finding stops the review until fixed); the tests the tiers require, before the lenses so the brief carries counts: `run-suites.js --changed` for the reached suites, `testdb-smoke.js --tap-dir` for any tier A file, `cd client && CI=true npx react-scripts build` for any `client/` file; for a designed surface, capture at 320 and 390 wide yourself (a subagent cannot sign in); `review-brief.js`; dispatch each selected lens as one Agent per lens with `model: opus` (or the collapse), verify with `model: fable` on tier A, and `/second-opinion --brief` on tier A, in parallel; `verdicts` for each report; triage every finding yourself against the cited code (confirmed with the failure path stated, or rejected with a one-line reason; agreement between agents is not evidence); fix confirmed findings, re-run only the lens that raised each as a `--pass <n>` report (3.9), re-dispatch a `not reached` file to its lens once (a second miss blocks and is named); after the last fix, run every test the tiers require again on the final tree (the reached suites, the smoke for tier A, the client build) and record the final counts; for a bug fix, run the failing test against the base tree in a throwaway detached worktree (`git worktree add --detach <tmp> <base>`, symlink `node_modules` and `.env`, one suite, remove the worktree) and record it with `--failing-test <file>:<count> --failing-log <log>` (D13), else `--not-a-fix <reason>`; `externals`; `finalize`; print the one-line report ("Reviewed <branch>, tier <t>, <n> findings fixed, <suites> green; unforecast lenses: <names or none>"). Modes: lane (default: `base` is current main, rebase first, standing practice); quick-fix (`--staged`; refused when `review-select` reports `refuse_quick_fix`, with the line "tier A is a lane"); `--commit <sha>` (a commit already on main with no receipt, `kind: commit`); comment-only (`--kind comment-only --proof <file>`, no lens; the proof script that shows a diff adds nothing but comment lines is step 4's, and until it exists the mode is documented and not used); stale-base (the overlap pass of 3.8, invoked by step 5's `check`; documented now, exercised in step 5). The skill states what stands until later steps: the receipt is the record and `merge-lane.sh` reads it from step 5; until then the session runs the skill before every merge by hand and the squash message stays one line.

**Acceptance checks**

1. The skill runs end to end on its own lane (dogfood; the lane window opened through `drb rewrite-step2-review-skill` after the rebase that brings the lenses in): the receipt directory exists under the computed key with `receipt.json`, `brief.md`, `diff.patch`, one report per selected lens, `verify.md` or `externals/not-run.txt` as the tiers dictate, and the runner logs; `review-receipt.js show rewrite-step2-review-skill` finds it by branch; `block` prints the commit block; the lane report pastes `receipt.json`. The expected label is hinge (the two files are under `.claude/`), lenses seams and access-egress, no smoke.
2. Every lens dispatched in the dogfood returned a parseable table covering every file; any `not reached` file was re-dispatched once and is named in the report.
3. The static pre-step and the suite run happened before the lenses were dispatched: the brief's Established section carries their results (the lane report quotes the section), and the final-tree run is recorded in `tests` after the last fix (or the report says there was no fix).
4. `grep -c '\]$'` on the bulleted rules of SKILL.md equals the count of lines beginning with `- ` in its Rules section; no quote under `os/`; no em dash.
5. A fixture lens report with no table, fed through `verdicts`, leaves every file not reached and `finalize` refuses without `--allow-not-reached` (receipt-lib check 3 covers the library; this check runs it through the skill's own commands on the dogfood branch before the real reports are stored).
6. The quick-fix refusal: `review-select.js --staged` on a staged change to `server/utils/pricingEngine.js` prints `refuse_quick_fix: true`, and SKILL.md's quick-fix section names that output as the stop.

## Lane: design-commands

**`.claude/commands/review-plan.md`.** Runs plan-fidelity and plan-decomposition only (two Agent calls); the consolidation and the "no auto-fix" rule stay; the feasibility tag is removed.

**`plan-fidelity.md`, `plan-decomposition.md`.** Both expect a lane map without code (D12): a check that the plan declares per lane `id`, scope, `footprint`, `blockedBy`, the lenses expected, acceptance checks that can be run, the laws and seams that apply, and the test plan; checks that presume code in the plan (line anchors, signatures) are removed; the "no automated test framework for the surface (e.g., client UI)" example in plan-decomposition is dropped (the client has 203 jest files); plan-decomposition's checkpoint lines that name security-review, database-review, consistency-check and code-review say instead that a lane is reviewed by the review skill at the tier it computes; references to CLAUDE.md sections stay as they are (step 5 re-points them).

**`plan-feasibility.md`.** Deleted (its job was checking code in plans against the codebase).

**Acceptance checks**

1. `grep -rc 'plan-feasibility\|security-review\|database-review\|consistency-check\|code-review' .claude/commands/review-plan.md .claude/agents/plan-*.md` is 0 for every file; `plan-feasibility.md` is gone.
2. Both agents' bodies contain the eight lane-map fields by name and no instruction to check a line anchor or a code signature.
3. `/review-plan` (through a session launched by `drb`) on this plan returns two reports, not three, and the consolidation line reads `Plan fleet: ...` with only `[fidelity]` and `[decomposition]` tags.
4. No em dash.

## Lane: retire-old-fleet

**The cuts.** The five agents, the three commands and `.mcp.json` are `git rm`'d; the `enabledMcpjsonServers` `gemini-cli` entry leaves `os/.claude/settings.local.json` (gitignored; by hand, backed up); `~/.claude/agents/ui-ux-reviewer.md` is renamed to `.bak-20261020` (its capture checks were carried into the client lens by the lenses lane, whose report lists each bullet's fate).

**`.claude/commands/full-audit.md`.** Quarterly, explicit-only; its three agents become seams (the whole-codebase drift hunt), access-egress and schema-data (performance-review is explicit-only and leaves the audit, a choice this plan makes); it adds a sensitive-list check (every file with a money defect fixed since the last audit, from `lens-audit/defects.jsonl`, is matched by the list or named) and a re-run of the lens coverage over the defects fixed since the last run (the audit's method in section 1, scoped to the delta), report-only as before.

**`.claude/CLAUDE.md`.** Three edits and nothing else: this block inserted after the first paragraph; the "Design-stage review fleet" paragraph loses `plan-feasibility` from its list and its last sentence (the `/gemini-spec` complement); the "Design artifacts are contracts" Review bullet names the `client` lens in place of `ui-ux-review`.

> TRANSITIONAL (2026-10-20, instruction rewrite step 2; remove at the flip): from this commit every lane is reviewed before merge by the review skill (`.claude/skills/review/`), which writes a receipt under the git common dir; the old push-time review layer (the seam sweep, the sensitive-path re-review at push, the second opinion at push) is not run; pushes stay cue-only through `npm run gate` and a literal-sha push until the flip marker exists; where the Review model and Push model sections below describe that layer, this block supersedes them. [Claude default 2026-10-20, spec 2026-10-19 section 8]

**`docs/runbooks/override-conversion.md`.** The one line that dispatches database-review and consistency-check says "the review skill at the tier it computes" instead (a sensitive hinge file; the override-removal lane rebases over it).

**`README.md`.** The one tree line that lists twelve agents by name is rewritten to name the sixteen: the nine lenses, verify, performance-review (explicit-only), and the five design agents (spec-grounding, spec-gaps, spec-risk, plan-fidelity, plan-decomposition).

**The six review memories.** Each gets one dated line appended: "From 2026-10-20 (instruction rewrite step 2) the per-lane review runs through the review skill in `os/.claude/skills/review/`; the agents this memory names were cut in that step and this memory is history." No other change; `MEMORY.md` is untouched (its hooks name no cut agent).

**Acceptance checks**

1. `ls .claude/agents/` lists exactly: access-egress, business-time, client, concurrency, lifecycle, money, outcomes-providers, performance-review, plan-decomposition, plan-fidelity, schema-data, seams, spec-gaps, spec-grounding, spec-risk, verify (16 files); `ls .claude/commands/` lists exactly full-audit, review-plan, review-spec; `.mcp.json` is absent; over tracked files only, `git grep -l -E 'gemini-cli|codex-review|review-before-deploy|gemini-spec|plan-feasibility|ui-ux-review|security-review|database-review|consistency-check|code-review' -- ':!docs/superpowers/' ':!ARCHITECTURE.md'` lists nothing (ARCHITECTURE's fleet list and cadence table are step 4's, spec 5.2, and the lane report names the lines).
2. `bash scripts/check-claudemd-invariants.sh` still prints `OK: all 16 invariants present`.
3. The block is the first blockquote in `.claude/CLAUDE.md`, ends in `]`, and `grep -c` for the em dash character in the file is unchanged from before the lane (the three edits add none).
4. `cmp` of `.claude/settings.local.json.bak-20261020` against the pre-edit file passes; `python3 -c "import json;json.load(open('.claude/settings.local.json'))"` exits 0 and the diff against the backup touches only the `enabledMcpjsonServers` entry; `~/.claude/agents/ui-ux-reviewer.md.bak-20261020` exists and the original path does not.
5. The lane carries a receipt written by the review skill; the computed label is hinge (every path is under `.claude/`, is `.mcp.json`, or is a runbook or README, so hinge plus docs), the receipt shows seams and access-egress ran with every file covered, and the lane report pastes `receipt.json`.
6. A fresh session through `drb` lists `/review` among its skills and the sixteen agents among its agents (the session's own listing, pasted in the report).
7. Each of the six memories ends with the dated line and `MEMORY.md` is byte-identical to before the lane.

## Report back

When the lanes are done, one line per lane (what landed, the squash sha, the report file), the receipt keys of the review-skill dogfood and of retire-old-fleet, the paths of the three `.bak` files, the content-rule recall figure and its misses, the client lens's dropped-bullet list, and any check that did not pass as a failure with its output. Nothing is pushed; say so.

## Test plan

Scripts and prose; the tests are the sibling suites named per lane plus the acceptance checks, each a command or a read with a stated pass condition. Each lane's report lists every check with its result.

## What this step does not do

The sensitive list's sections, header and the 122 additions are the flip commit (step 5). `merge-lane.sh check` and `ship`, the receipt check at merge, the squash-message block in the commit, the stale-base mode in anger, and `review --commit` on real old commits are step 5. `push-gate.js` sha mode, `ship.js`, the hook, the markers, `lane-status`, the SessionStart hook change and `scripts/lib/worktreeLinks.js` are step 3. `gen-docs.js`, the header migration, the comment-only proof script and the pre-commit docs check are step 4, as are README's tree and scripts rows for this step's scripts and ARCHITECTURE's fleet list and cadence table (spec 5.2). The project CLAUDE.md rewrite is step 5; this step adds the transitional block and the two one-line re-points. The design agents' CLAUDE.md section references are re-pointed in step 5. The eslint `no-unused-vars` promotion is step 5. The spec agents (`spec-grounding`, `spec-gaps`, `spec-risk`) and `review-spec.md` need no edit in this step: the Windows line is in `plan-feasibility.md`, which is deleted, and none of them references anything cut (checked 2026-10-20). Lanes cut before the flip (`beer-picks`, `gv-post-server`, `gv-sender`, `override-removal`) get the new review by hand before their merge, as section 8 says, once review-skill has merged.
