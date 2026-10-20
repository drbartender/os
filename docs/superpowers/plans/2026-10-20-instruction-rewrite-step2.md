---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 2 of section 8
format: lane map without code (spec D12)
revision: 1 (2026-10-20; drafted after step 1 merged as d6f02e8c)
status: draft, awaiting Dallas (his instruction: each step's plan is shown before the step is built); execute natively in one session launched through drb, lanes in the order below, the acceptance checks are the review (no per-task reviewers, spec D14)
lanes:
  - id: pii-shapes
    scope: the one shared PII shape module and allowlist (spec 3.3, 3.10); the board writer and the second-opinion mask read it
    footprint:
      - scripts/lib/piiShapes.js
      - scripts/lib/piiShapes.test.js
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - ~/.claude/commands/second-opinion.md  (outside git; .bak-20261020 first)
    blockedBy: []
    lenses: the current fleet's security-review on the two scripts (board-write.sh is a push path); the acceptance checks are the review
    review: current rules; merges only when every check passes; no push
    revert: git revert of the squash commit; copy second-opinion.md.bak-20261020 back
  - id: static-checks
    scope: the mechanical pre-steps as one script (spec 3.3)
    footprint:
      - scripts/static-checks.js
      - scripts/static-checks.test.js
    blockedBy: [pii-shapes]
    lenses: security-review (the script replaces its prose); the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
  - id: sensitive-match-2
    scope: the matcher gains `**`, sections, the content rule, the hinge set, the docs allowlist and a tier function (spec 3.3, 4.7, D11); the list itself does not change until the flip
    footprint:
      - scripts/sensitive-match.js
      - scripts/sensitive-match.test.js
      - scripts/content-rule-calibrate.js
    blockedBy: []
    lenses: security-review plus consistency-check (every consumer of the old exports); the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
  - id: suite-runner
    scope: the suite runner behind the dev-suite lock, the smoke lock in testdb-smoke.js, the docs/dev.md lines the step 1 plan deferred here (spec 4.3)
    footprint:
      - scripts/run-suites.js
      - scripts/run-suites.test.js
      - scripts/testdb-smoke.js
      - scripts/push-gate.test.js  (only if the smoke lock changes what it asserts)
      - package.json  (the run-suites script)
      - README.md  (the NPM scripts table row)
      - docs/dev.md
    blockedBy: []
    lenses: the full current fleet (testdb-smoke.js and push-gate.js are sensitive-listed gate machinery) plus /second-opinion; the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
  - id: receipt-lib
    scope: receipt keys, the verdict-table parser, the receipt directory and index, the commit-message block (spec 3.5, 3.7)
    footprint:
      - scripts/lib/receipt.js
      - scripts/lib/receipt.test.js
      - scripts/review-receipt.js
    blockedBy: []
    lenses: code-review and consistency-check; the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
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
    lenses: a Fable read of each lens file against its inventory sections (coverage: every kept check present, every cut check absent, every id resolves in defects.jsonl); the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
  - id: review-skill
    scope: the review skill, its brief template, lens selection and brief generation as scripts (spec 3.1 to 3.9, 9)
    footprint:
      - .claude/skills/review/SKILL.md
      - .claude/skills/review/brief-template.md
      - scripts/lib/lensTriggers.js
      - scripts/lib/lensTriggers.test.js
      - scripts/review-select.js
      - scripts/review-select.test.js
      - scripts/review-brief.js
      - scripts/review-brief.test.js
    blockedBy: [pii-shapes, static-checks, sensitive-match-2, suite-runner, receipt-lib, lenses]
    lenses: the skill run on its own lane diff (the first real receipt), then the current fleet on the scripts; the acceptance checks are the review
    review: current rules for the merge; no push
    revert: git revert of the squash commit
  - id: design-commands
    scope: the plan fleet shrinks to fidelity and decomposition and expects lane maps without code (spec 7, D12)
    footprint:
      - .claude/commands/review-plan.md
      - .claude/agents/plan-fidelity.md
      - .claude/agents/plan-decomposition.md
      - .claude/agents/plan-feasibility.md  (deleted)
    blockedBy: []
    lenses: none (prose); the acceptance checks are the review
    review: current rules; no push
    revert: git revert of the squash commit
  - id: retire-old-fleet
    scope: the five discipline agents, the three commands and the gemini MCP entry go; full-audit points at the new lenses; the project CLAUDE.md gets its transitional block (spec 7, 8)
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
      - .claude/CLAUDE.md  (the transitional block at the top, nothing else)
      - README.md  (the one tree line that counts the agents)
      - ~/.claude/agents/ui-ux-reviewer.md  (outside git; moved to ui-ux-reviewer.md.bak-20261020)
      - ~/.claude/settings.local.json  (outside git; .bak-20261020 first; the gemini-cli entry removed)
    blockedBy: [review-skill]
    lenses: reviewed by the new skill (its first use on a hinge diff); the acceptance checks are the review
    review: the new skill's receipt is required for this merge; no push
    revert: git revert of the squash commit; copy the two .bak files back
---

# Instruction rewrite, step 2: the review skill, the lenses, the pre-steps

**Goal:** make "properly reviewed" (spec section 3) a thing a session can run: a skill that computes the tier and the lenses from the diff, runs the mechanical pre-steps, writes one brief, dispatches the nine lenses and the verify pass, triages, runs the suites the change reaches behind a lock, and writes a receipt directory that steps 3 and 5 will consume. From the merge of the last lane on, every lane is reviewed this way before it merges, and the old push-time review layer is not run.

**Spec:** `docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md` (rev 6), sections 3.1 to 3.10, 4.3 (the locks), 4.7, 6.1, 7, 8 (step 2), 9, D11, D12, D13, D14, D15. The lens content comes from `docs/superpowers/specs/2026-10-19-lens-audit.md` sections 6 and 7 and the eight inventories under `docs/superpowers/specs/lens-audit/`.

**Two things this plan decides that the spec left to the builder (section 9), stated here so Dallas sees them:**

1. The receipt and the lens selection are scripts with tests, not prose the session re-derives each run: `scripts/review-receipt.js` (keys, verdict parsing, the receipt directory, the commit block), `scripts/review-select.js` (tier and lenses from the diff) and `scripts/review-brief.js` (the brief from the template). The skill's SKILL.md is the procedure that calls them. Steps 3 and 5 import the same `scripts/lib/receipt.js`, so the parser merge-lane.sh and ship trust is the one the skill wrote with.
2. The old agents are cut in the last lane, after the skill exists, so no lane merges with neither fleet available; the lenses lane only adds files.

## Global constraints

- No em dash character in any file this plan writes (feedback_no_em_dashes, 2026-08-14).
- Ids only under `os/`: no client or staff name, email or phone number in any file, fixture, lens example or commit message (feedback-no-client-pii-in-repo-docs, 2026-10-14; D9). Fixtures and the business lines may appear.
- Every rule in SKILL.md ends with a bracket, `[Dallas YYYY-MM-DD]` or `[Claude default]` (spec 6.1); lens checks cite defect ids instead and carry no bracket (3.2). No quote under `os/`.
- Files outside git get a `.bak-20261020` copy before the first edit, `sha256sum` before and `cmp` after; nothing under `~/.claude` is deleted (a cut file is renamed to `.bak-20261020`).
- Nothing is pushed. Pushes are cue-only until the flip (section 8). Lanes merge through `scripts/merge-lane.sh` from `os` on main.
- Thinking on main: this plan commits to main before any lane is cut.
- The executing session launches through `drb` (step 1), so the project's agents and the new skill register; a lane window through `drb <lane>`.
- Other windows: before the by-hand edits outside git (pii-shapes, retire-old-fleet), check for other live sessions the way step 1 did (process ages, memory and `~/.claude` mtimes) and re-read each file right before writing it.
- Model tiering: lenses `model: opus`; verify `model: fable` (spec 3.2; feedback_subagent_model_opus).
- A new script under `scripts/` gets a sibling `.test.js` run with `node --test`, as the twelve existing ones are; a lane's suite run reads the pass count from the TAP summary, never the exit code alone (feedback-gate-result-is-the-receipt).
- The dev database is shared: no lane runs a server suite while another window runs one, and never `CREATE TEMP` (docs/dev.md).

## Review focus

The five ways this step bites, each pinned to a check:

1. The content rule misses money diffs in unlisted files, which is the whole reason it exists (lens audit section 4): the calibration script reports recall over the money defects' fix diffs and the lane report lists every miss by id (sensitive-match-2, check 4).
2. The receipt key changes when it should not (a content-identical rebase) or stays when it should not (a conflict resolution, a new commit), and generated-doc churn is not excluded: pinned by the key tests (receipt-lib, check 1).
3. A lens that returns prose, a table missing files, or a table with an unknown verdict is read as a pass: the parser treats every one of those as `not reached` for the missing files (receipt-lib, check 2; review-skill, check 6).
4. The locks deadlock or do not hold: the smoke lock is taken blocking by testdb-smoke.js inside push-gate's own lock in the order the spec fixes (ship, then smoke), and a killed holder releases it (suite-runner, checks 2 and 3).
5. A real person's number or a token reaches codex or gemini, or a fixture is masked into uselessness: the mask tests carry both directions (pii-shapes, check 1).

## Order

1. pii-shapes, sensitive-match-2, suite-runner, receipt-lib, lenses and design-commands are independent and may run in parallel windows (each its own lane; the dev-DB rule above still serializes suite runs).
2. static-checks after pii-shapes.
3. review-skill after every lane above it.
4. retire-old-fleet last, reviewed by the skill it switches on.

## Contracts shared across lanes

These are the decisions the lanes build to; a lane that finds one wrong rules and ledgers it like the step 1 plan did.

**The verdict table (3.5).** The last thing in a lens report, a markdown table with the header row `| file | verdict | note |`, one row per file in the brief's file list, verdict exactly one of `pass`, `finding`, `not reached`, `escalate`, the note naming the finding ids (`H1`, `M2`, `L1`, severity letter plus number) or the reason. Findings are listed above the table under the same ids, each with file:line, the defect in one sentence, the failure path, and the check id from the lens that applies. A report with no table, or a table missing a file, reads as `not reached` for the missing files.

**The brief (3.4).** One markdown file per review, generated from `brief-template.md`, sections in this order: Review (key, kind, branch, tip, reviewed_against); Tier and why (matched paths, content-rule hits, triggers per lens); Files (the list the lens must return verdicts for); Diff (the path of the diff file: commit list, stat, `-U10`); Plan and spec (paths); Established (pre-step results, tests run with counts, build status, questions already settled); Triggers that fired for you; Money laws (the money lens and the externals only: `docs/money-laws.md` verbatim); Design artifact and captures (the client lens only: the artifact path and the screenshots at 320 and 390 wide the main session captured); Budget ("finish within roughly N tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach", N = 30 plus 5 per file in the list, capped at 150); Standing lines ("print no real person's phone number; fixtures and the business lines are fine; refer to people by role"); Output (findings, then the verdict table, nothing after it).

**The receipt (3.7).** Directory `<git-common-dir>/drb-review/<key>/` holding `receipt.json`, `brief.md`, `diff.patch`, one `<lens>.md` per lens report, `verify.md`, `externals/` (the codex and gemini outputs or a `not-run.txt` with the reason), and `tests/<suite>.log` for every runner log. `receipt.json` fields: `version` (1), `key`, `kind` (`lane`, `quick-fix`, `commit`, `squash`, `revert`, `comment-only`), `branch`, `tip`, `reviewed_against`, `base`, `tier`, `matched_paths`, `content_rule_hits`, `lenses` (per lens: `name`, `fired_because`, `raised`, `confirmed`, `fixed`, `rejected`, `verdicts` as file to verdict), `coverage` (`files_in_diff`, `files_with_verdicts`, `not_reached`), `tests` (per run: `command`, `log`, `pass`, `fail`, `read_from` the TAP summary line), `failing_test_on_old_code` (`file`, `count`, or null with a reason for a non-fix), `externals` (`codex` and `gemini`: `run` or `not_run` with the reason), `verify` (`run`, `findings`), `escalated` (true when any lens returned `escalate`), `timestamp`, `written_by` (`review skill` or `review --commit`). The index `<git-common-dir>/drb-review/index.json` maps branch name to `{key, tip, reviewed_against, at}`; a lookup falls back from key to branch (3.8).

**The keys (3.7).** lane: the first field of `git diff <base> <tip> -- . ':!README.md' ':!ARCHITECTURE.md' | git patch-id --stable`; quick-fix: `git write-tree` on the staged index; commit: the patch id of `<sha>^..<sha>` with the same exclusions. Steps 3 and 5 compute the same three through `scripts/lib/receipt.js`.

**Tier (3.3).** Per file: A when the path is in a money, auth-and-PII or client-money-surfaces section of the sensitive list, or the content rule fires on the diff; B for any other path under `server/`, any `.js`, `.mjs` or `.sh` file under `scripts/` not on the list, or any other status write; hinge for a path in the D11 hinge set when the content rule did not fire, for a non-script file under `scripts/` (a manifest or list configures the tooling), and for every unclassified path (anything not under `server/`, `client/`, `scripts/`, `docs/` and not on the docs allowlist; `.claude/**` and the root files are the common cases, spec 3.3); C for everything else under `client/`; docs for a path on the docs allowlist (4.7) that is not sensitive. The review's tier is the highest per-file tier in the order A, B, hinge, C, docs. Until the flip gives the list sections, an unsectioned list reads as one money section (today every listed path means the full fleet). The D11 hinge set lives in `sensitive-match.js` as a constant until the flip moves it into the list.

**Lens selection (3.2, 3.3).** The tier's floor plus every lens whose trigger matches the diff. Floors: A gets money, lifecycle, concurrency, outcomes-providers, access-egress, seams, the externals and verify; B gets seams, plus access-egress for a new file under `server/routes/` or `server/middleware/`; C gets client and seams; hinge gets seams and access-egress; docs gets none. Triggers, as regexes over the diff's added lines (paths in parentheses), the constants in `scripts/lib/lensTriggers.js`:

- money: `UPDATE\s+proposals\s+SET`, `\b(total_price|amount_paid|amount_due|external_paid|total_price_override|pricing_snapshot|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|gratuity_floor_rate|payout_id|deposit_amount)\b`, `stripe\.(refunds|paymentIntents|checkout|paymentLinks|customers|invoices|payouts)\.`, `\b(refundExecute|applyRefundReconciliation|calculateProposal|getStripe)\(` (and any path in a money section).
- lifecycle: `\bSET\s+status\b`, `\bstatus\s*=\s*'`, `_STATUSES\b`, `archive_reason`, `pay_periods`, `Scheduler\.js|Sweep\.js|Reaper\.js` (paths), `setInterval\(`.
- concurrency: `FOR UPDATE`, `pool\.connect\(`, `\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|SAVEPOINT`, `ON CONFLICT`, `Promise\.all\(`, `rowCount`, `retry|attempt`, `setTimeout\(`.
- business-time: `CURRENT_DATE|CURRENT_TIMESTAMP|NOW\(\)`, `new Date\(`, `::date\b|\bDATE\b|INTERVAL '`, `AT TIME ZONE`, `chicagoTodayYmd|toISOString|toLocaleDateString|setDate\(`, `_days?\b|Days?\b`.
- outcomes-providers: `catch\s*(\(|\{)`, `ok:\s*(true|false)`, `'skipped'|'failed'|'notifications_off'`, `process\.env\.`, `TwiML|<Response>|twiml`, `webhook`, `require\('(stripe|twilio|resend|@anthropic-ai/sdk|openai|@google/genai|web-push|googleapis)'\)`, `\.post\(|fetch\(`.
- access-egress: `router\.(get|post|put|patch|delete)\(`, `\bauth\b|req\.user|requireOnboarded|role`, `Limiter|rateLimit`, `console\.(log|error)\(|Sentry\.`, `send(Email|SMS|Push)\(|anthropicClient|openaiClient|geminiClient`, `res\.(json|send)\(` (and any path under `server/routes/` or `server/middleware/`).
- seams: every diff with a file outside the docs allowlist (seams is in every non-docs floor, so no trigger is needed; the constant records that).
- schema-data: `server/db/schema.sql|server/db/index.js|server/scripts/|scripts/|seed` (paths), `CREATE TABLE|ALTER TABLE|ADD COLUMN|CHECK \(|CREATE (UNIQUE )?INDEX`, `INSERT INTO (service_addons|service_packages|cocktails|mocktails|par_)`.
- client: any path under `client/src/`.

Escalation: a lens may return `escalate` in its table when it sees money, auth or PII material outside its tier; the skill bumps the review to tier A and re-runs selection before merge.

**The content rule (3.3).** Fires on an added line matching any of: `UPDATE\s+(proposals|invoices|invoice_payments|proposal_payments|proposal_refunds|payouts|pay_periods|tips|shifts|service_extensions)\b` whose hunk also writes `status` or a money column from the money list above; `stripe\.(refunds|paymentIntents|checkout|paymentLinks|customers|invoices|payouts)\.\w+\(`; `\b(refundExecute|issueRefund|applyRefundReconciliation)\(`; a read or write of `\b(total_price|amount_paid|amount_due|external_paid|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|payout_id|rate|quantity)\b` in a file under `server/` or `client/src/` outside tests. The calibration script runs it over `git show <fixed_ref>` for every row of `lens-audit/defects.jsonl` with `money: true`, `bites: true` and an 8-hex `fixed_ref` whose commit exists, and prints recall with the misses by id; the floor is 85 percent, and a lower figure means the lane widens the regexes (never the floor) and reports what it added.

**The locks (4.3).** `<git-common-dir>/drb-smoke.lock` taken blocking by `testdb-smoke.js` itself (flock, re-exec under the lock the way `merge-lane.sh` does, with a guard env var against re-exec loops) so a review-time smoke and a gate never reset ci-smoke under each other; push-gate's existing `drb-push-gate.lock` stays outside it, so the order is push-gate (later the ship lock), then smoke. `<git-common-dir>/drb-devdb.lock` taken blocking by `run-suites.js` for every run of the ordinary suites. Both print one line when they wait.

## Lane: pii-shapes

**`scripts/lib/piiShapes.js`.** Exports the shapes as named regexes: `EMAIL`, `PHONE` (the board writer's), `TOKEN` (bearer-style, the JWT-ish pair, `sk_`, 32 or more hex), `STRIPE_ID` (the board writer's family), `ROUTING_EIN` (nine digits with the hyphen shapes `\d{2}-\d{7}` and `\d{9}` beside the words routing, EIN, account); `ALLOWLIST` as path globs (`**/*.test.js`, `server/db/seedTestData.js`, `server/utils/smsLines.js`, `server/utils/companyPhone.js`, `scripts/mobile-capture.manifest.json`) plus the business lines as literals read from `smsLines.js` and `companyPhone.js` at load; `findPii(text, {path})` returning hits `{shape, line, match}` with the allowlist applied by path and by literal; `mask(text, {path})` replacing every hit with `<shape>`; a CLI: `node scripts/lib/piiShapes.js --check "<line>"` (exit 0 clean, 1 blocked, the board writer's old contract), `--mask < file`, `--find <paths...>`.

**`scripts/board-write.sh`.** `denylist_check` calls the module's `--check` instead of its four inline greps; the four greps are removed, the messages stay. `board-write.test.js` keeps its cases and adds one per new shape.

**`~/.claude/commands/second-opinion.md`.** Section 1 writes the diff through `node scripts/lib/piiShapes.js --mask` before anything is sent; a `--brief <file>` argument, when the review skill passes it, is appended to the shared brief (the money laws); section 5 ends with two fixed lines, `codex: run|not run (<reason>)` and `gemini: run|not run (<reason>)`, so the receipt can read them.

**Acceptance checks**

1. `node --test scripts/lib/piiShapes.test.js` passes and the suite holds at least these cases: a real-format phone number is found and masked; the two business lines are not; a 555 fixture number in a path matching `**/*.test.js` is not; `sk_live_` and a 32-hex token are found; `pi_...`, `cus_...`, `re_...` are found; `routing 123456789` and `12-3456789` beside EIN are found and a plain nine-digit proposal id beside the word proposal is not; an email is found; `--check` exits 1 on a blocked line and 0 on a clean one.
2. `node --test scripts/board-write.test.js` passes with the module behind `denylist_check`; `bash scripts/board-write.sh --check "<a line with a phone number>"` exits 1 and the old message prints.
3. `cmp` of `second-opinion.md.bak-20261020` against the pre-edit file passes; the edited file runs end to end on a scratch diff that contains one fixture number and one real-format number: the masked `so-diff.patch` contains `<PHONE>` once and the fixture untouched.
4. `grep -c` for the em dash character is 0 in every file the lane writes; no file carries a real-format number outside the test fixtures.

## Lane: static-checks

**`scripts/static-checks.js`.** `node scripts/static-checks.js --base <sha> --tip <sha>` (or `--staged`) runs over the changed files only and prints JSON `{findings: [{rule, file, line, text, blocking}], blocking: n}`, exit 1 when `blocking > 0`. Rules, each a named regex or small AST-free check over the changed file's text, blocking unless marked advisory: `parameterized-sql` (a `query(` whose SQL string interpolates or concatenates a variable); `command-injection` (`exec(`, `execSync(` with a template or concatenation); `ssrf` (`fetch(` or `axios(` whose URL comes from `req.`); `secrets-in-client-bundle` (`sk_live`, `sk_test`, `whsec_`, a 32-hex literal under `client/src/`); `env-ignored` (`.env` or `client/.env*` appearing in `git ls-files`); `stripe-direct` (`require('stripe')` outside `server/utils/stripeClient.js`); `jwt-literal-secret` (`jwt.sign(` whose secret argument is a literal); `missing-auth-import` (a new file under `server/routes/` with router handlers and no `auth` import, advisory); `dangerously-set-inner-html`; `swallowed-catch` (a catch with an empty body or a body that only comments); `begin-without-rollback` (a file adding `BEGIN` with no `ROLLBACK`); `env-default` (`process.env.X || <literal>`, advisory); `floating-security-versions` (`^` or `~` on `jsonwebtoken`, `bcryptjs`, `stripe`, `express`, `helmet`, `pg` in either `package.json`); `file-or-git-deps` (`file:` or `git+` in either `package.json`); `eslint-undef` (eslint with `no-undef` and `no-use-before-define` as errors over the changed `.js` files under `server/` and `scripts/`, run through the repo's config); `pii` (piiShapes `--find` over the changed files, allowlist applied).

**Acceptance checks**

1. `node --test scripts/static-checks.test.js` passes with one fixture per rule proving it fires and one proving it stays quiet, run against a throwaway git repo the test builds (the pattern of `board-write.test.js`).
2. Run against `d6f02e8c^..d6f02e8c` (step 1's squash, docs only): `blocking: 0` and no eslint run (no `.js` changed). Run against a scratch commit that adds `const x = y;` to a server file: `eslint-undef` fires.
3. The whole run over a 20-file server diff finishes in under 60 seconds on the box (the skill's budget assumes it).
4. No em dash; ids only.

## Lane: sensitive-match-2

**`scripts/sensitive-match.js`.** Keeps every current export (`isSensitive`, `matchSensitive`, `loadPatterns`, `patternToRegex`) with their behavior for `*` (never crosses a slash) and adds: `**` (crosses slashes; `server/utils/inbox/**` therefore matches the same 68 flat files today and any subdirectory later, and the spec's note about naming subdirectories is moot, there are none); sections, read from `# section: <name>` header lines in the list, returned as `{pattern, section}` from `loadPatterns`, with an unsectioned list reading as section `money`; `HINGE_PATHS`, the D11 set as path globs (the review skill and its brief template, the lens agents, `scripts/sensitive-paths.txt`, `scripts/sensitive-match.js`, `scripts/static-checks.js`, `.husky/*`, `.claude/settings.json`, `scripts/merge-lane.sh`, `scripts/ship.js`, `scripts/push-gate.js`, `scripts/post-ship-watch.js`, `scripts/gen-docs.js`, `scripts/lane-status.js`, `scripts/board-write.sh`, `scripts/lib/*`, `client/vercel.json`, `docs/money-laws.md`, `docs/runbooks/**`, `AGENTS.md`, `package.json`, `package-lock.json`, `client/package.json`, `client/package-lock.json`, `.node-version`, `eslint.config.mjs`, `.gitignore`); `DOCS_ALLOWLIST` (`docs/**`, `README.md`, `ARCHITECTURE.md`); `isDocsOnly(paths)` (every path on the allowlist and none sensitive, so `docs/money-laws.md` and `docs/runbooks/**` are never docs-only); `contentRuleHits(diffText)` returning `{file, line, rule}` per hit from the content rule above; `tier({paths, diffText})` returning `{tier, matchedPaths, sections, contentRuleHits, hingePaths}` per the tier contract. The CLI gains `--tier` (reads `git diff --name-only` and the diff from stdin or `--base/--tip`) and prints the JSON.

**`scripts/content-rule-calibrate.js`.** Read-only: selects the defects.jsonl rows per the content-rule contract, runs `contentRuleHits` over `git show --format= <fixed_ref>` for each, prints recall, the miss list by id with area, and the false-positive check over the docs-only commits since 2026-10-01 (expected zero hits).

**Acceptance checks**

1. `node --test scripts/sensitive-match.test.js` passes; the suite keeps every existing case and adds: `**` crosses a slash and `*` still does not; an unsectioned list yields section `money` for every pattern; a sectioned fixture list yields each pattern's section; `isDocsOnly(['docs/money-laws.md'])` is false and `isDocsOnly(['docs/x.md','README.md'])` is true; `tier` returns A for a diff that adds `UPDATE proposals SET amount_paid`, B for a plain server file, hinge for `scripts/merge-lane.sh` alone, C for a client CSS file, docs for a plan file; a mixed hinge-plus-client diff returns hinge.
2. Every current consumer still works: `grep -rn "sensitive-match" scripts/ .claude/ docs/ --include=*.js --include=*.sh --include=*.md -l` is listed in the lane report and each script among them runs its own test green (`push-gate.test.js`, `lane-status.test.js`, `merge-lane.test.js`).
3. `node scripts/sensitive-match.js --tier --base d6f02e8c^ --tip d6f02e8c` prints tier `hinge` (the step 1 squash touched `docs/money-laws.md` and `AGENTS.md`).
4. The calibration run's output is in the lane report: recall at or above 85 percent over the selected defects, the misses listed by id, and zero hits over the docs-only commits.

## Lane: suite-runner

**`scripts/run-suites.js`.** `node scripts/run-suites.js --changed <base>..<tip> [--log-dir <dir>]` or `node scripts/run-suites.js <file.test.js>...`. Computes the reached set: the `.test.js` sibling of every changed non-test file under `server/` and `scripts/`, plus every `.test.js` under those roots whose `require` targets resolve to a changed module (direct requires only, one hop, a stated limit). Takes `drb-devdb.lock` blocking, runs each suite serially with `node -r dotenv/config --test --test-reporter=tap <file>` (the invocation `testdb-smoke.js` already uses), writes each suite's full output to `<log-dir>/<suite-with-slashes-as-dashes>.log` (default `<git-common-dir>/drb-review/_runs/<timestamp>/`), parses `# pass N` and `# fail N` from the TAP summary, prints one line per suite and a totals line, exits 1 when any `# fail` is non-zero or any summary line is missing (a suite that died silently is a failure, not a zero). `npm run run-suites` maps to it.

**`scripts/testdb-smoke.js`.** Takes `drb-smoke.lock` blocking around the whole flow (reset, URI, initDb, suites), printing `waiting for the smoke lock` when blocked; nothing else changes. `push-gate.js` keeps its own lock outside, so a gate run holds push-gate then smoke, never the reverse.

**`docs/dev.md`.** The "Running tests" section gains: the ordinary suites run through `npm run run-suites` behind the dev-suite lock, which serializes every window; the money smoke takes the smoke lock itself; both print one line while waiting; the lock files live in the git common dir and need no cleanup after a crash (flock releases on exit).

**Acceptance checks**

1. `node --test scripts/run-suites.test.js` passes: the reached set for a fixture tree is the sibling plus the one-hop importer and nothing else; a suite whose output lacks the TAP summary is a failure; counts are read from `# pass`/`# fail`; the log file exists per suite.
2. Two concurrent `run-suites` processes on the same lock file serialize: the second prints the waiting line and starts after the first exits (a test with a sleep-based fake suite, under 10 seconds).
3. A holder killed with `kill -9` releases `drb-smoke.lock` and a second `testdb-smoke.js --dry-lock` (a new flag that takes the lock, prints, and exits without touching Neon) acquires it; `push-gate.test.js` stays green.
4. `node scripts/run-suites.js --changed d6f02e8c^..d6f02e8c` reports no suites reached (docs only) and exits 0; `node scripts/run-suites.js scripts/sensitive-match.test.js` reports `pass 6 fail 0` and exits 0.
5. `npm run run-suites -- scripts/sensitive-match.test.js` works from a lane worktree (the `.env` symlink makes `dotenv/config` find the dev database).
6. `docs/dev.md` lines pass `scripts/board-write.sh --check`; no em dash.

## Lane: receipt-lib

**`scripts/lib/receipt.js`.** Exports `laneKey(base, tip)`, `quickFixKey()`, `commitKey(sha)` (the key contract); `parseVerdictTable(markdown)` returning `{rows: [{file, verdict, note}], findings: [{id, severity, file, line, text}], malformed: bool}` where a missing table, a bad header or an unknown verdict sets `malformed` and yields no rows; `coverage(fileList, tablesByLens)` returning per lens the files with verdicts and the files not reached; `receiptDir(key)` under the common git dir; `writeReceipt(key, receipt)` and `readReceipt(key)`; `indexSet(branch, {key, tip, reviewedAgainst})` and `indexLookup(branchOrKey)`; `commitBlock(receipt)` rendering the squash-message block of spec 3.7 verbatim in shape (`Review: tier ...`, `lenses:`, `files: n/n verdicts`, `findings: raised, confirmed, fixed and re-reviewed, rejected`, `tests:`, `receipt: patch <key7>, reviewed against main <sha7>, <timestamp>`).

**`scripts/review-receipt.js`.** The CLI over the library: `key lane <base> <tip>`, `key quick-fix`, `key commit <sha>`, `init <key> --kind <kind> --branch <b> --tip <sha> --reviewed-against <sha> --base <sha> --tier <t>` (creates the directory and a skeleton receipt), `verdicts <key> <lens> <report.md>` (parses, stores the report, updates coverage), `tests <key> <command> <log>` (reads the TAP summary into the receipt), `finalize <key> [--failing-test <file>:<count>|--not-a-fix <reason>] [--externals codex=run|not_run:<reason> gemini=...]` (validates every field against the contract, writes `receipt.json`, updates the index), `show <key|branch>`, `block <key>` (prints the commit block).

**Acceptance checks**

1. `node --test scripts/lib/receipt.test.js` passes with: the lane key is identical before and after a content-identical rebase and differs after a one-line change in the lane and after a conflict resolution (a throwaway repo with a generated-doc file that churns and is excluded); the quick-fix key equals `HEAD^{tree}` after committing the staged index; the commit key of a squash equals the lane key when main did not move.
2. The parser: a report with no table yields `malformed: true` and zero rows; a table missing one file yields that file as not reached; an unknown verdict word marks the row malformed; findings with ids `H1`, `M2` are read with their file:line.
3. `finalize` refuses a receipt whose `coverage.not_reached` is non-empty unless `--allow-not-reached` is passed, refuses a missing `tests` entry at tier A and B, and refuses `kind` outside the six kinds; `show` finds a receipt by branch through the index after the key changed.
4. `block` output for a fixture receipt matches the spec 3.7 example line for line in shape (the lane report pastes both).
5. No em dash; ids only.

## Lane: lenses

**The nine lens files.** Each `.claude/agents/<lens>.md` with frontmatter `name`, `description` (one line: what it fires on), `tools: Read, Grep, Glob, Bash`, `model: opus`, `maxTurns: 170` (the brief's budget cap plus 20), and a body under about 150 lines: one paragraph on the shape it exists for (from the lens audit section 6 table), then the checks in descending order of the defect count behind them, each check two sentences and a trigger line, citing its defect ids, built from these inventory sections (spec 3.2): money from `checks-money-seam.md` and the money-math section of `checks-money-math-catalog-contract.md`; lifecycle from `checks-lifecycle.md` and the scheduler section of `checks-concurrency-scheduler.md`; concurrency from the race and pool sections of `checks-concurrency-scheduler.md`; business-time from the time section of `checks-business-time-import.md`; outcomes-providers from `checks-outcomes-providers.md`; access-egress from `checks-access-egress.md` plus the kept security checks of audit section 7 (UUID tokens, magic-byte uploads, webhook secret placement as placement and trust derivation, reset tokens at rest, session invalidation, admin actions attributed, payment events logged); seams from the contract-seam section of the money-math inventory, the copy section of `checks-client-copy-schema.md`, the siblings check of `checks-money-seam.md` and the status-enumeration checks of `checks-lifecycle.md`; schema-data from the schema section of `checks-client-copy-schema.md`, the import section of `checks-business-time-import.md`, the catalog section of the money-math inventory plus the kept database checks (idempotent statements, nullable column additions, no DROP without a plan, money columns in integer cents); client from the ui-state and a11y sections of `checks-client-copy-schema.md` plus the capture checks the audit kept (UIX-07, UIX-12, UIX-17 and the thirteen that earned hits, read from the current `ui-ux-review.md` before it is cut). Each file ends with the output contract (findings, then the verdict table, the budget line, the standing PII line) copied from the brief contract, and the money lens's first instruction is to read the Money laws section of the brief before any file. The mechanical greps of audit section 7 appear in no lens (they are `static-checks.js`).

**`verify.md`.** `model: fable`, `tools: Read, Grep, Glob, Bash`: an adversarial pass on each fix and on the money math of a tier A diff, returning findings only (no table, 3.5), with the same standing lines.

**`performance-review.md`.** Rewritten explicit-only: the description says it runs on request when a public page or a list endpoint changes and never by the skill; the checklist keeps only checks that are not in audit section 7's cut list and drops the priority-page list.

**Acceptance checks**

1. `wc -l .claude/agents/{money,lifecycle,concurrency,business-time,outcomes-providers,access-egress,seams,schema-data,client,verify}.md` shows each at or under 160 lines; every file has the frontmatter fields above; `grep -c 'model: opus'` is 9 and `verify.md` says `model: fable`.
2. Every defect id cited in the ten files resolves: `grep -ohE 'D[0-9]{4}' .claude/agents/*.md | sort -u` is a subset of the ids in `lens-audit/defects.jsonl` (a one-line script in the lane report).
3. Coverage of the inventories: for each lens, every numbered check in its mapped inventory sections appears (by its leading bold phrase) in the lens file, and none of audit section 7's cut checks (function length, nesting, props drilling, memo and lazy checks, pagination, compression, bundle size, the docs tables, the folder tree, CAPTCHA, "read every file") appears in any lens; the lane report lists any check deliberately merged or split with its reason.
4. A Fable read (dispatched by the lane, agent prompt inlined) of each lens against its sections returns a table with one row per inventory check: present, merged, or missing; missing is empty.
5. No quote, no bracket on a check, no em dash, no real person's number or name in any example; `bash scripts/board-write.sh --check` passes every line of the ten files.
6. `.claude/agents/performance-review.md` contains the words `explicit-only` in its description and no `priority` page list.

## Lane: review-skill

**`scripts/lib/lensTriggers.js`.** The trigger constants above as `{lens: [regex...], paths: [glob...]}` and `selectLenses({tier, paths, diffText})` applying the floors and triggers; `TIER_FLOORS` as data.

**`scripts/review-select.js`.** `node scripts/review-select.js --base <sha> --tip <sha> | --staged` prints JSON: tier (from `sensitive-match.js tier`), matched paths, content-rule hits, the lenses with the reason each fired, whether the externals and verify run, which tests the tier requires (smoke, reached suites, client build), and whether the collapse rule applies (a one- or two-file tier A diff may run as one agent carrying every applicable lens's checklist, returning one table per lens).

**`scripts/review-brief.js`.** `node scripts/review-brief.js --key <key> --select <select.json> --pre-steps <static.json> --tests <log...> [--artifact <path> --captures <png...>] [--plan <path> --spec <path>]` renders `brief-template.md` into `<receipt dir>/brief.md`, writes `diff.patch` (commit list, stat, `-U10`), inlines `docs/money-laws.md` when the money lens or the externals run, and splits a diff over 4,000 lines by area into several briefs up front (3.4), naming the split in the output.

**`.claude/skills/review/SKILL.md`.** The procedure a session follows, each rule bracketed: compute the key (`review-receipt.js key`), `init`; run `review-select.js`, then the pre-steps (`static-checks.js`, which the brief carries as established facts; a blocking pre-step finding stops the review until fixed); run the suites the tier requires through `run-suites.js` and `npm run test:smoke` for tier A, and the client build for anything under `client/`, before the lenses, so the brief carries counts; for a designed surface, capture at 320 and 390 wide yourself (a subagent cannot sign in); generate the brief; dispatch each selected lens as one Agent per lens with `model: opus` (or the collapse), verify with `model: fable` on tier A, and `/second-opinion` with `--brief` on tier A, in parallel; store each report through `verdicts`; triage every finding yourself against the cited code (confirmed with the failure path stated, or rejected with a one-line reason; agreement between agents is not evidence); fix confirmed findings, re-run only the lens that raised each (3.9), re-dispatch a `not reached` file to its lens once (a second miss blocks and is named); run the reached suites again on the final tree and record counts; for a bug fix, record the test that fails on the old code by file and count (D13), or `--not-a-fix`; `finalize`; print the one-line report ("Reviewed <branch>, tier <t>, <n> findings fixed, <suites> green"). Modes: `lane` (default: `base` is current main, rebase first, standing practice), `quick-fix` (`--staged`), `--commit <sha>` (a commit already on main with no receipt), `stale-base` (the overlap pass of 3.8, invoked by step 5's `check`; documented now, exercised in step 5). The skill states what stands until later steps: the receipt is the record and `merge-lane.sh` reads it from step 5; until then the session runs the skill before every merge by hand and the squash message stays one line.

**Acceptance checks**

1. `node --test scripts/lib/lensTriggers.test.js scripts/review-select.test.js scripts/review-brief.test.js` pass: a money diff selects the tier A floor plus business-time when `CURRENT_DATE` appears; a client CSS diff selects client and seams only; a docs diff selects nothing; the collapse applies to a one-file tier A diff and not to a three-file one; the brief for a money review contains the first heading of `docs/money-laws.md` and the brief for a client review does not; a 5,000-line fixture diff is split into two briefs by area.
2. The skill runs end to end on its own lane (dogfood): the receipt directory exists with `receipt.json`, `brief.md`, `diff.patch`, one report per selected lens, `verify.md` or `externals/not-run.txt` as the tier dictates, and the runner logs; `review-receipt.js show rewrite-step2-review-skill` finds it by branch; `block` prints the commit block; the lane report pastes `receipt.json`.
3. Every lens dispatched in the dogfood returned a parseable table covering every file; any `not reached` file was re-dispatched once and is named in the report.
4. The static pre-step and the suite run happened before the lenses were dispatched: the brief's Established section carries their results (the lane report quotes the section).
5. `grep -c '\]$'` on the bulleted rules of SKILL.md equals the count of lines beginning with `- ` in its Rules section; no quote under `os/`; no em dash.
6. A fixture lens report with no table, fed through `verdicts`, leaves every file not reached and `finalize` refuses without `--allow-not-reached`.

## Lane: design-commands

**`.claude/commands/review-plan.md`.** Runs plan-fidelity and plan-decomposition only (two Agent calls); the consolidation and the "no auto-fix" rule stay; the feasibility tag is removed.

**`plan-fidelity.md`, `plan-decomposition.md`.** Both expect a lane map without code (D12): a check that the plan declares per lane `id`, scope, `footprint`, `blockedBy`, the lenses expected, acceptance checks that can be run, the laws and seams that apply, and the test plan; checks that presume code in the plan (line anchors, signatures) are removed; the "no automated test framework for the surface (e.g., client UI)" example in plan-decomposition is dropped (the client has 203 jest files); references to CLAUDE.md sections stay as they are (step 5 re-points them).

**`plan-feasibility.md`.** Deleted (its job was checking code in plans against the codebase).

**Acceptance checks**

1. `grep -c 'plan-feasibility' .claude/commands/review-plan.md .claude/agents/*.md` is 0; the file is gone.
2. Both agents' bodies contain the eight lane-map fields by name and no instruction to check a line anchor or a code signature.
3. `/review-plan` (through a session launched by `drb`) on this plan returns two reports, not three, and the consolidation line reads `Plan fleet: ...` with only `[fidelity]` and `[decomposition]` tags.
4. No em dash.

## Lane: retire-old-fleet

**The cuts.** The five agents and three commands are `git rm`'d; `.mcp.json` is `git rm`'d; the `gemini-cli` entry leaves `~/.claude/settings.local.json` (by hand, backed up); `~/.claude/agents/ui-ux-reviewer.md` is renamed to `.bak-20261020` (its capture checks already live in the client lens).

**`.claude/commands/full-audit.md`.** Quarterly, explicit-only; its three agents become seams (the whole-codebase drift hunt), access-egress and schema-data; it adds a sensitive-list check (every file with a money defect fixed since the last audit, from `lens-audit/defects.jsonl`, is matched by the list or named) and a re-run of the lens coverage over the defects fixed since the last run (the audit's method in section 1, scoped to the delta), report-only as before.

**`.claude/CLAUDE.md`.** One block inserted after the first paragraph, nothing else touched:

> TRANSITIONAL (2026-10-20, instruction rewrite step 2; remove at the flip): from this commit every lane is reviewed before merge by the review skill (`.claude/skills/review/`), which writes a receipt under the git common dir; the old push-time review layer (the seam sweep, the sensitive-path re-review at push, the second opinion at push) is not run; pushes stay cue-only through `npm run gate` and a literal-sha push until the flip marker exists; where the Review model and Push model sections below describe that layer, this block supersedes them. [Claude default 2026-10-20, spec 2026-10-19 section 8]

**`README.md`.** The one tree line that counts twelve agents by name is rewritten to name the ten (nine lenses, verify) plus performance-review and the four design agents.

**Acceptance checks**

1. `ls .claude/agents/` lists exactly: business-time, client, concurrency, lifecycle, money, outcomes-providers, access-egress, schema-data, seams, verify, performance-review, plan-decomposition, plan-fidelity, spec-gaps, spec-grounding, spec-risk (16 files); `ls .claude/commands/` lists exactly full-audit, review-plan, review-spec; `.mcp.json` is absent; `grep -rn 'gemini-cli\|codex-review\|review-before-deploy\|gemini-spec' .claude/ README.md ARCHITECTURE.md docs/ --include=*.md --include=*.json -l` lists only history under `docs/superpowers/`.
2. `bash scripts/check-claudemd-invariants.sh` still prints `OK: all 16 invariants present`.
3. The block is the first blockquote in `.claude/CLAUDE.md`, ends in `]`, and `grep -c` for the em dash character in the file is unchanged from before the lane (the block adds none).
4. `cmp` of the two `.bak-20261020` files against their pre-edit originals passes; `python3 -c "import json;json.load(open('<settings.local.json>'))"` exits 0 and the diff against the backup touches only the gemini entry.
5. The lane itself carries a receipt written by the review skill; the computed tier is hinge (every path is under `.claude/` or is `.mcp.json`, unclassified paths per 3.3, with `README.md` on the docs allowlist) and the receipt shows seams and access-egress ran with every file covered; the lane report pastes `receipt.json`.
6. A fresh session through `drb` lists `/review` among its skills and the ten agents among its agents (the session's own listing, pasted in the report).

## Report back

When the lanes are done, one line per lane (what landed, the squash sha, the report file), the receipt key of the review-skill dogfood and of retire-old-fleet, the paths of the three `.bak` files, the content-rule recall figure and its misses, and any check that did not pass as a failure with its output. Nothing is pushed; say so.

## Test plan

Scripts and prose; the tests are the sibling suites named per lane plus the acceptance checks, each a command or a read with a stated pass condition. Each lane's report lists every check with its result.

## What this step does not do

The sensitive list's sections, header and the 122 additions are the flip commit (step 5). `merge-lane.sh check` and `ship`, the receipt check at merge, the squash-message block in the commit, the stale-base mode in anger, and `review --commit` on real old commits are step 5. `push-gate.js` sha mode, `ship.js`, the hook, the markers, `lane-status` and the SessionStart hook change are step 3. `gen-docs.js`, the header migration and the pre-commit docs check are step 4. The project CLAUDE.md rewrite is step 5; this step adds only the transitional block. The design agents' CLAUDE.md section references are re-pointed in step 5. The eslint `no-unused-vars` promotion is step 5. Lanes cut before the flip (`beer-picks`, `gv-post-server`, `gv-sender`, `override-removal`) get the new review by hand before their merge, as section 8 says, once review-skill has merged.
