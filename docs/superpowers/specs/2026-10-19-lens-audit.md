# Review-lens audit: what the fleet checks against what actually broke

Date: 2026-10-19. Status: audit complete; report-only. Companion to `2026-10-19-instruction-rewrite-design.md`, whose section 3 (the review tiers and lenses) this audit revises. Dallas asked for it directly: "I do want to make sure that it has been properly reviewed as well. I think part of this should be an audit of what 'properly reviewed' actually means." and, on being offered the choice, "lets run it now as a separate audit. I feel like we are rushing thru this a bit."

## 1. The question and the method

Do the six code-review lenses under `.claude/agents/` look for the things this codebase actually breaks? Not "are the prompts well written" but "would the checklist, as written today, have flagged the defects that shipped?"

Method, in five passes, all read-only against the repo and the box:

1. **Collect.** Eighteen agents mined every source that records a defect since 2026-04-01: the fix commits on main (1,275 fix, hotfix, revert and lane-merge commits, read with their bodies and, for empty-bodied squashes, their diffs), the ledger's deleted history (6,671 lines at commit `4d674da4`), the open ledger, the comments in `scripts/sensitive-paths.txt` (each one explains a path found unlisted after a defect), the four audit documents under `.claude/` and `docs/audit-2026-07-13/`, the 193 project and reference memories, and production Sentry (which retains only about thirty days). Each defect became one normalized line: date, file, class, one-sentence mechanism, who found it, whether it bites, whether money is involved, whether its file is on the sensitive list today, and the fix.
2. **Dedupe.** 4,340 raw lines, 96 dropped as off-repo (Wildlight, the dev box), collapsed first mechanically by fix commit and then by twenty-five agents reading each class, with a coverage check that every line landed in exactly one cluster. Result: **3,056 distinct defects**, 1,513 of which bite (a wrong number, a wrong charge, a broken client or staff surface, a message to the wrong person, a security or PII exposure, lost work), 1,061 involving money, 770 still open.
3. **Number the checklists.** Every bullet in the six agent files got an id (security 79, performance 38, code 34, UI 32, database 18, consistency 18: 219 checks).
4. **Map.** For each of the 1,496 biting, code-relevant defects (tooling and process defects excluded) and each lens, a Fable reviewer answered one question with the checklist in front of it: is there a numbered check whose wording covers this defect's mechanism? Cite it or say none. Confidence high, medium or low; "a careful engineer would notice" was not allowed to count. Eighteen passes, 9,084 verdicts, every defect answered by every lens.
5. **Synthesize.** For the defects no lens covers, eight agents derived the checks that would have caught them, each check citing the defect ids behind it. Section 6.

What this audit is not: it does not measure how well the agents execute their checklists. The record cannot support that (section 5). It measures whether the checklists point at the right things.

## 2. The record, in numbers

| | count |
|---|---|
| distinct defects since April | 3,056 |
| that bite | 1,513 |
| that involve money | 1,061 |
| still open | 770 |
| biting defects found by the Claude fleet | 590 (39%) |
| found in production, by a client, a staffer or Dallas | 163 (11%) |
| found by codex or gemini | 123 (8%) |
| found by a sweep or audit | 167 |
| found by the author while building | 152 |
| finder not recorded | 314 |

The externals found 123 biting defects on a fraction of the fleet's runs; the fleet's own repeated misses (the press-one kill switch, the balance-fold quantity bug, the wrong-shift Drop, the autopay guard holes, the retainer refund) are all in the record under `found_by: external`.

Largest classes among biting defects: ui-state 164, money-seam 217, status-guard 182, error-handling 148, race-idempotency 126, money-math 95, auth-scope 71, time-date 66, pii-leak 56.

## 3. Coverage: what the lenses would have flagged

Cells are defects with a high or medium check for that lens; `+n` is low-confidence only. The last column is defects no lens covers at high or medium (and, in parentheses, even counting low).

```
COVERAGE (defects with a high/medium check per lens; +n = low only)
class                 n | securi databa consis   code perfor   uiux | no lens
money-seam          217 |    1+7   7+10   8+11   9+11    1+5    0+4 | none  195 (161 even with low)
status-guard        177 |   7+22   4+11   24+7   1+30      0    0+7 | none  142 (90 even with low)
ui-state            159 |    0+3      0   5+14   8+11    3+1  45+26 | none  103 (64 even with low)
error-handling      147 |  29+19  11+13   2+14  13+13    1+4    7+9 | none  105 (64 even with low)
race-idempotency    126 |    6+2   11+6      1    1+4    0+1    2+3 | none  112 (100 even with low)
money-math           95 |      7    1+4    1+6    0+2    0+1    0+1 | none   86 (74 even with low)
auth-scope           71 |  13+20    1+1    2+3    0+3    2+2    1+1 | none   54 (33 even with low)
time-date            66 |    1+1      0    0+1    0+6      0      0 | none   65 (57 even with low)
pii-leak             56 |   14+9      1      0    0+1    2+3      0 | none   40 (31 even with low)
copy-content         51 |      0      1    0+3    0+6      0    0+6 | none   50 (37 even with low)
data-import          44 |      1    4+6    0+1      0    0+1      0 | none   40 (32 even with low)
contract-seam        43 |      0    2+1   13+9    3+3    0+1    0+2 | none   27 (17 even with low)
external-contract    39 |    1+2      0      0      0      0    0+3 | none   38 (33 even with low)
schema-constraint    38 |    1+3   17+7    3+7    0+3    0+1      0 | none   18 (11 even with low)
config-env           30 |    7+4      0    0+3      0    0+1      0 | none   23 (16 even with low)
catalog-data         27 |      0    0+1    0+2    1+1    0+1      0 | none   26 (23 even with low)
input-security       24 |   11+4      1      0      0      0    0+1 | none   12 (8 even with low)
comms-routing        20 |      0      1    1+7    0+1      0    0+4 | none   18 (10 even with low)
scheduler-blast      18 |    3+1      0      0      0      1      0 | none   15 (14 even with low)
pool-connection      15 |    4+2      4      0    0+2      0      0 | none    9 (8 even with low)
abuse-limits         12 |      0      0      0      0      0    0+3 | none   12 (9 even with low)
logic                 9 |      0      1    0+1      0      1      0 | none    8 (8 even with low)
a11y-design           6 |      0      0      0      0      0    4+1 | none    2 (1 even with low)
docs-drift            2 |      0      1      0      0      0      0 | none    1 (1 even with low)
supply-chain          2 |      2      0      0      0      0      0 | none    0 (0 even with low)
test-gap              2 |      0      0      0      0      0      0 | none    2 (2 even with low)

TOTAL 1496 | per-lens strong hits: security=108 database=68 consistency=60 code=36 performance=11 uiux=59 | no lens (strong) 1203 (80%)
```

Three readings of that table, each verified by spot-reading the "none" verdicts in the money classes by hand:

- **80% of biting defects (1,203 of 1,496) match no check in any lens.** For money defects it is 85% (616 of 725). The uncovered mechanisms are not exotic: a line re-priced from the live catalog instead of the frozen row, a reconcile that only demotes, a date-only bound cast to midnight, a webhook branch running side effects on a cancelled proposal, an SDK silently dropping a snake_case key the code lens would have endorsed.
- **The fleet's misses were not execution failures.** Of the 285 biting defects that reached production or were caught by a client, a staffer, Dallas, codex or gemini, a check existed for 33. For the other 252 the checklists had nothing to apply. Rewriting the prompts' mechanics (scope, budget, verdict tables) will not move this number; only the content will.
- **141 of the 219 checks matched nothing in six months.** The lenses with the most dead weight: security 51 of 79, performance 31 of 38, code 20 of 34, UI 19 of 32, database 11 of 18, consistency 9 of 18. Section 7 sorts them.

Where the lenses did earn their keep: consistency-check on column-add diffs (CON-02 and CON-03, 35 defects), security-review on server-side validation, transaction integrity, scheduler isolation and PII sinks (SEC-52, SEC-53, SEC-64, SEC-60), database-review on missing unique constraints and unconstrained enum columns (DAT-16, DAT-17), ui-ux-review on overflow, contrast and keyboard lockouts (UIX-07, UIX-12, UIX-17). Those checks are the seed of the rewrite, not its casualties.

## 4. The tier design: the sensitive list as the hinge

The rewrite spec makes `scripts/sensitive-paths.txt` decide which lenses run. The record tests that directly.

| biting money defects | count |
|---|---|
| in a file on the sensitive list today | 447 (61%) |
| in a file not on the list | 250 (34%) |
| in a subsystem with no single file | 36 |

The 250 sit in 122 distinct files. The ones that recur: the public Sign and Pay page and its hooks (`ProposalView.js`, `useSettle.js`, `intentQuote.js`, `paidState.js`), the admin proposal editor and its pricing breakdown, `stripeCreateIntent.js` (where proposal 784 was charged twice), `drinkPlanExtras.js`, `serviceExtensionPricing.js` and `serviceExtensionSweep.js`, `proposals/metadata.js` and `metricsQueries.js` (the Financials numbers), `autoAssign.js` (the position field that drives the tip split), `proposalGroupCommit.js`, `payrollTax.js` (the 1099 year), the Money Board cards, the payroll UI panels, `paystubData.js`, `db/index.js` (the constraint contract), and every money script under `server/scripts/staffPaymentImport/` and `scripts/cc-*.js` (the glob never matches `scripts/`). The list grew after misses: 28 of its 44 comment stories are a path found unlisted after the fact. The 8/14 audit named ten files to add; one was added.

Consequence for the spec: the list cannot be the only hinge. The rewrite should (a) add the 122 files, or rather the directories and name patterns that cover them, in the flip commit; (b) make tier B the floor for any file whose diff touches a money column, a Stripe call, a price or rate, a payout, or a status transition, detected by diff grep rather than by path; and (c) keep the escalate verdict, because a name-based list will lag again.

## 5. Precision: what the fleet raises

A separate pass read the fold notes in forty plans and the review reports of the Inbox build to measure how much of what the lenses raise is real. It could not: 84% of recorded findings are attributed to "the fleet" or "the review" with no lens named, and the record keeps what was folded, not what was rejected. The one push measured end to end (2026-07-22) ran 74 raw findings to about 5% real. The receipt in the rewrite spec (per lens: raised, confirmed, rejected) is what makes this measurable from the first lane after the flip; nothing before it can be.

Two things the precision pass could see: codex had 12 confirmed and 2 rejected findings where the source named it, several of them seams the Claude lenses had passed; and about half of the design-stage fleet's recorded findings are plan hygiene (wrong line anchors, invented harness shapes, footprint gaps) rather than product defects.

## 6. What the lenses should look at

For the 1,203 defects no lens covers, eight synthesis passes derived the checks that would have caught them, each check citing the defect ids behind it, with a diff trigger and the home lens. The full check inventories are in `lens-audit/` beside this file (eight documents, about 190 checks, every id traceable to `defects.jsonl`). The passes proposed sixteen lens names between them; consolidated, the fleet becomes nine lenses cut by mechanism instead of six cut by discipline. Each lens fires on a diff trigger, not a file path; the sensitive list is a floor, not the selector.

| lens | replaces | fires on | checks (from) | the shape it exists for |
|---|---|---|---|---|
| **money** | nothing today; the only money lines in any checklist (SEC-38, SEC-39) point the wrong way | an `UPDATE proposals SET` on a money column, a Stripe or refund call, a price, rate, quantity or payout read, any file on the money list | about 25 (money-seam 15, money-math 10); reads `docs/money-laws.md` first | one money fact in six stores and no transaction owns it: a reprice without its tail, a reader reconstructing truth from a label or a live catalog row, a re-derivation destroying rows it did not author, a second entrance with no tail |
| **lifecycle** | the state-machine half of nothing | a status write, a sweep, a scheduler, a terminal transition, a pay-period predicate, a candidate set | 16 (lifecycle 8, scheduler 8) | terminal-state fan-out, late writers that do not read the row first, refused money writes that land nowhere, four inlined copies of "frozen", every state needs an exit, first-run blast radius |
| **concurrency** | nothing | a status write, `FOR UPDATE`, `pool.connect()`, a provider call that moves money or sends, a retry, a partial update, a tick | 19 (race 14, pool 5) | in-flight money counts as money, claim then key then call, conditional UPDATE with a rowCount gate on side effects, lock order, ON CONFLICT by business key, one client per request and never Promise.all on it |
| **business-time** | nothing; three lenses straddle it and none asks | `CURRENT_DATE`, `new Date`, a formatter, a period pick, a window, a DATE column, a threshold in days | 12 | the Chicago day resolved in SQL or by a UTC slice, date-only bounds cast to midnight, formatter input shape, millisecond versus microsecond equality, a fix proven only by a daytime test |
| **outcomes and providers** | the error-handling halves of code-review and security-review | a helper that returns a status, a catch, a skip branch, a COMMIT followed by work, an SDK options object, a webhook branch, TwiML, an env flag, a DOM agent step | 29 (outcome 14, provider 9, config 6) | a designed-in skip reported upward as success (110 such sites today), side effects before COMMIT, SDK options verified from memory, a handler whose event was never subscribed, a flag that defaults on |
| **access and egress** | security-review, rewritten | a route or guard, a public form, a log, export or AI send, a limiter, a send, a webhook | about 34 (auth 12, egress 7, input 5, limits 5, comms 5) | the guard wrong relative to the decision in both directions, unauthenticated forms resolving a stranger's row, scrubber escapes, limits sized below the surface's own traffic, a money action sharing a bucket with browsing; the mechanical greps (injection, secrets in the bundle, SSRF, missing auth import, swallowed catch) move to a script the gate runs |
| **seams** | consistency-check, rewritten from "grep the table name" to "trace one value from its writer to every reader" | any diff that changes a field, a response shape, an enumeration, an entrance, a helper that has copies, or client-facing copy | about 30 (siblings and entrances, contract-seam 6, status enumerations, duplicate helpers, copy-truth 7) | a step added to one entrance and not its siblings, a constant defined twice with different members, a figure shown in two places from two functions, copy drifting from the row it bills from (all 50 copy defects were drift, none taste) |
| **schema and data** | database-review, trimmed, plus the import and catalog work no lens reads today | `schema.sql`, `db/index.js`, `server/scripts/`, `scripts/`, a seed, a catalog change | about 20 (schema 5 plus the live DAT checks, import-backfill 8, catalog 6) | unique constraints that never applied, enum columns without a CHECK, re-run traps at boot, column width, trigger side effects, an import whose verifier reads the sheet it imported from, a catalog resolver whose substring fallback masks missing rows (10 of 26 found only in prod) |
| **client** | ui-ux-review, plus the code-reading half it never had | any diff under `client/src`; captures provided by the main session | about 28 (ui-mechanics 14, the 13 capture checks that earned hits, a11y 1) | stale-by-identity renders (no shared latest-request guard; re-implemented in about 18 files), async states with no exit, entered work lost on exit, controls bound to the wrong row, garbage values in captures, tap targets at 320 wide |

Two lenses go. **performance-review** becomes explicit-only, run on request when a public page or a list endpoint changes: across 1,496 defects its checklist reached 11 at medium confidence and none at high, three of its own recommendations are the mechanism behind recorded defects (Promise.all on a held client, offset pagination, lazy chunks), and its priority-page list names a file that no longer exists. **code-review** dissolves: its live checks (dead code, duplication, status codes, loading and empty states) move to lint, seams and client; its error-handling section graded against the retired try/catch pattern; and its naming check would have endorsed the defect it was shown (snake_case `reply_to`, which the SDK silently drops).

Tier A under the rewrite spec runs money, lifecycle, concurrency, outcomes and providers, access and egress, and seams, plus the externals and the Fable verify pass. The other three fire on their triggers at any tier.

## 7. The 219 checks today: keep, move, cut

78 checks matched at least one defect. 141 matched none, sorted on reading:

- **Keep as mechanical gates, out of the prose** (about 40, all security): parameterized SQL, command injection, SSRF, secrets in the client bundle, `.env` ignored, `STRIPE_TEST_MODE_UNTIL`, `JWT_SECRET` from env, missing `auth` import, `dangerouslySetInnerHTML`, swallowed catch, `BEGIN` without `ROLLBACK`, `process.env.X || default`, floating versions on security packages, `file:` and `git+` deps. They matched nothing because the conventions hold, which is the point; a script that fails the gate is cheaper and more reliable than a reviewer re-reading them per lane.
- **Keep in a lens** (about 15): UUID tokens, magic-byte uploads, webhook secret placement (rewritten as placement and trust derivation), reset tokens at rest, session invalidation, idempotent schema statements, nullable column additions, no DROP without a plan, money columns in integer cents, admin actions attributed, payment events logged.
- **Cut** (about 85): function and component length, nesting depth, props drilling, camelCase and snake_case (lint), unused imports (lint), commented code, inline styles, every React memo, callback and lazy-loading check, parallel queries, pagination, compression, bundle size, the priority-page list, the three docs-table checks (generated after the rewrite), the folder-tree check against a CLAUDE.md tree that no longer exists, the UI setup and output-format lines that were numbered as checks, the stale "common issues" list, CAPTCHA, "read every file".

## 8. What this changes in the rewrite spec

Section 3 of `2026-10-19-instruction-rewrite-design.md` stands in its mechanics (the brief, the verdict table, triage, the receipt, stale base, the watch) and changes in its content:

1. **3.2 lenses.** The six-by-discipline fleet is replaced by the nine lenses above. Lens selection is by diff trigger, with the sensitive list as a floor that forces the tier A set. The verify agent stays. The second opinion stays on tier A; the record shows codex and gemini catching 123 biting defects, repeatedly on seams the fleet had passed.
2. **The sensitive list.** The flip commit adds the 122 unlisted money files by directory and pattern (`server/routes/drinkPlans/`, `server/routes/stripeCreateIntent.js`, `server/utils/serviceExtension*.js`, `server/utils/drinkPlanExtras.js`, `server/utils/proposalGroupCommit.js`, `server/routes/proposals/metadata.js`, `server/utils/metricsQueries.js`, `server/utils/autoAssign.js`, `server/routes/admin/payrollTax.js`, `server/db/index.js`, `server/scripts/**`, `scripts/cc-*.js`, the public Sign and Pay page and its hooks, the proposal editor and `PricingBreakdown.js`, the Money Board cards, the payroll panels, `paystubData.js`, both contract text files, `ServicesPage.js`), and the matcher gains a diff-content rule so a money column, a Stripe call or a status transition in any file is tier B at least.
3. **The brief.** For the money lens it carries the row-truth rules verbatim (`docs/money-laws.md`, which the spec already plans, now has its table of contents: acknowledged_total, frozen rates, the label partition and its five constant sets, the quantity shapes, refund scope, the paid flag, owner no-draw, the hosted ratio). For the client lens it carries captures at 320 and 390 wide, not 390 alone.
4. **Mechanical pre-steps the skill runs before any lens**: the security grep script; eslint `no-undef` and `no-use-before-define` over changed files (the rule that would have caught the ReferenceError family); `sensitive-match` over the diff with the content rule; a PII grep over the push range (names, real-format numbers, a name beside a dollar figure).
5. **The receipt** records per lens: raised, confirmed, rejected. The record could not measure any lens's precision; from the first lane after the flip it can.
6. **The design-stage fleet** (spec and plan agents) is out of scope here. The precision pass showed about half its recorded findings are plan hygiene rather than product defects; a lighter pass is owed before those six agents are edited.

## 9. Found along the way, not acted on

Live or unresolved in production, surfaced by the collectors and confirmed in code where stated; ids only.

- The email unsubscribe POST is rejected by the CORS allowlist in prod (the API serves the confirmation page, whose form posts with an Origin the allowlist refuses); four opt-outs since 2026-09-20 were never written. Inferred from code and the rejected requests, not reproduced in a browser.
- The Stripe payout reconciliation sweep fails on every run for manual payouts (`syncPayout` asks for balance transactions by payout id, which Stripe rejects); the stuck-line alarm grew from 4 to 12 in a week.
- The client Sentry project reports nothing at all; the React app initializes Sentry only when the DSN is present at build time, so the Vercel build may lack it.
- `invoice_number` uniqueness was never applied to existing databases: the `CREATE UNIQUE INDEX IF NOT EXISTS` matched the old non-unique index's name.
- The dashboard-stats endpoint still runs fourteen pool queries in one Promise.all; SERVER-11 has been open since June, and the record marks it fixed.
- The shopping-list approval snapshot is written but never served; the public page still shows the placeholder and the dead-link behavior the fix list calls open.
- A commit message (`dacd1619`) names nine client couples in the public repository's history.
- Several ledger and memory entries record fixes that git contradicts (the staff Pay-screen date bug closed on a grep that matched the wrong shape; a trigger pattern credited to the wrong commit; a memory attributing a DRB payroll ruling to the Wildlight owner) and defects recorded open that are fixed. The collectors corrected `fixed_ref` from git where they could; `defects.jsonl` carries the corrected values.

## 10. Limits of this audit

- Deduplication within a class is agent judgment with a mechanical coverage check; cross-class duplicates (the same defect classed money-seam by one source and status-guard by another) were not merged, so counts carry some double-counting in that direction, and the mechanical pre-merge by fix commit hid about thirty distinct defects inside sibling lines in the other direction. Neither moves the headline ratios.
- The finder is unrecorded for 314 biting defects, mostly June one-line commits; "found by the fleet" is therefore a floor.
- Sentry retains thirty days; everything older came from the ledger, git and memory.
- Each mapping verdict is one Fable reviewer's reading of one checklist against one defect, held to "cite the check or say none". Spot-reads of the none verdicts in the money classes by the auditor agreed with them; the standard is conservative, and a looser reading would move coverage by a few points, not by the forty needed to change the conclusion.
- Precision (how much of what a lens raises is real) could not be measured from the record at all.

Evidence files beside this document: `lens-audit/defects.jsonl` (the 3,056 distinct defects, ids only, no PII), `lens-audit/coverage-matrix.txt`, and the eight check inventories.
