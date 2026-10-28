---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 5 of section 8, the switch-over
format: lane map without code (spec D12)
revision: 1 (2026-10-28)
status: written 2026-10-28 while step 4's last lane (merge-docs-split, the merge script's remaining windows) is in its first fix round; that lane's as-built amendment lands in rev 2 with the plan fleet's findings; reviewed by the plan fleet (fidelity, decomposition) and folded; shown to Dallas before any lane is cut (spec section 8, his instruction); not built until he says go. Execution model as in step 4: each lane is built by an opus implementer from a brief beside the ledger, the controller verifies every acceptance check itself, the review skill runs per lane at the tier it computes and writes a receipt, the lane merges through scripts/merge-lane.sh from os (the step 4 script until the merge-ship lane lands, then the new one), the three merged-lane checks run, the worktree and branch go, a lane report goes beside the ledger, and the plan gets a revision through the docs quick-fix chain. Every push in this step is Dallas's cue (pushes stay cue-only until the flip marker exists), and the flip itself, the rehearsal ship and the legacy-removal ship happen with him in the window.
lanes:
  - id: release-field
    scope: the deploy becomes observable (spec 3.11 step 2): GET /api/health returns a release field set from RENDER_GIT_COMMIT (absent locally), and Sentry.init on the server sets release from the same value, so the post-ship watch can tell when the pushed sha is live and Sentry events carry the sha
    footprint:
      - server/index.js  (the health handler and Sentry.init only)
      - server/index.health.test.js  (new, or the existing health case extended)
    blockedBy: []
    laws: the health route stays public and keeps its 2-second DB probe and its registration before the React catch-all; the field is a string or absent, never the box's hostname or a path; Sentry's release is set only when the variable is present; nothing else in index.js moves
    lenses: tier A floor (server/index.js is sensitive-listed): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the health suite (release absent without the variable, the sha with it); the smoke on the first and final tips
    revert: git revert of the squash commit (the watch then reports deploy not observed on every ship until it is back)
  - id: vercel-ignore
    scope: a docs-only push does not rebuild the client (spec 4.9): client/vercel.json gains an ignoreCommand that exits 0 (skip) when every file of the pushed commit is on the docs allowlist (docs/**, README.md, ARCHITECTURE.md) and 1 (build) otherwise; its own pre-flip commit, shipped with the evidence push
    footprint:
      - client/vercel.json
      - scripts/vercel-ignore.sh  (new: the command the json names, so it is testable; one git diff over HEAD^..HEAD with the allowlist as pathspec exclusions)
      - scripts/vercel-ignore.test.js  (new)
    blockedBy: []
    laws: the allowlist equals sensitive-match's docs-only list minus the hinge docs (a change under docs/money-laws.md or docs/runbooks/** builds, since the push path never calls it docs-only); a shallow clone, a first commit or a missing HEAD^ builds (fail toward building); the command never reads secrets and prints one line saying why it built or skipped
    lenses: hinge floor (client/vercel.json is on the D11 hinge set; scripts/ path): seams, access-egress; schema-data
    test plan: the sibling suite over throwaway repos (docs-only, mixed, a hinge doc, a shallow clone); the evidence push is the real run
    revert: git revert of the squash commit (every push then rebuilds the client, as today)
  - id: sensitive-list
    scope: the sensitive list becomes the one role the spec gives it (D11, 3.3): the header rewritten to say it scales the review tier and nothing else (the conflict-escalation and auto-pull clauses go with the push model), the file split into named sections (money, auth and PII, hinge, client money surfaces), the D11 hinge set listed explicitly (the review skill and its brief template, the lens agents, .claude/settings.json, client/vercel.json, docs/money-laws.md, docs/runbooks/**, AGENTS.md, the root configuration files) beside what the matcher's globs already cover, the step 3 additions it still lacks (scripts/lib/shipLog.js, scripts/lib/receipt.js, scripts/lib/piiShapes.js) and the step 3 plan's 122 additions; this is the flip commit's content, and the list is tier A from that commit on
    footprint:
      - scripts/sensitive-paths.txt
      - scripts/sensitive-match.js  (only if a section marker needs parsing it does not have; its test with it)
      - scripts/sensitive-match.test.js
    blockedBy: []
    laws: no path the list covers today leaves it (the diff is additions, section headers and the header rewrite; a removal is a finding); every added path exists in the tree or is a glob that matches at least one tracked path; the matcher's output for every tracked path is unchanged or raised, never lowered (a script in the lane compares the tier of every tracked path before and after)
    lenses: tier A floor (the list and the matcher are sensitive): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the matcher's suite; the before-and-after tier comparison over git ls-files pasted in the lane report
    revert: git revert of the squash commit (the list goes back to its 2026-10-27 shape; nothing in the push path reads the sections yet)
  - id: lint-errors
    scope: no-unused-vars becomes an error for server/ in eslint.config.mjs (spec section 7) if the lane can fix every existing violation under server/ without a behavior change; the count is measured first and, if the fixes are not mechanical (an unused binding whose removal changes a call's arity, or a variable a later change clearly meant to use), the rule stays a warning and the lane records why
    footprint:
      - eslint.config.mjs
      - server/**  (only the lines eslint names; no logic change)
    blockedBy: []
    laws: every edit is a deletion of an unused binding or a rename to an underscore-prefixed name the rule ignores; a deletion that changes a function's arity, a destructuring's shape, or an exported name is out of scope; the server suites a changed file reaches run green; the money smoke runs when a sensitive file is touched
    lenses: what the touched files fire (a sensitive server file makes it tier A); seams and access-egress floors on the config
    test plan: eslint server/ exits 0 with the rule at error; the reached suites; the smoke if tier A
    revert: git revert of the squash commit
  - id: design-agents
    scope: the design-stage agents point at the rules as they now are (spec section 7, step 5): spec-risk's Secrets question asks for the .env.example block, never a CLAUDE.md mention; plan-decomposition's stale "commit rule 3" pointer and every reference to a CLAUDE.md section name are re-pointed at the rewritten file's section names (after the claudemd-rewrite lane fixes them) or at docs/dev.md and docs/money-laws.md; the Windows line and the no-client-tests line are confirmed gone; a lighter audit of the five agents against their own record is not this lane (open question, section 10)
    footprint:
      - .claude/agents/spec-grounding.md
      - .claude/agents/spec-gaps.md
      - .claude/agents/spec-risk.md
      - .claude/agents/plan-fidelity.md
      - .claude/agents/plan-decomposition.md
      - .claude/commands/review-spec.md
      - .claude/commands/review-plan.md
    blockedBy: [claudemd-rewrite]
    laws: no agent gains or loses a check; only pointers and names change (a diff a reader can see is wording); no em dash
    lenses: hinge floor (the agent files are on the hinge set): seams, access-egress
    test plan: a grep over the seven files for the retired names (the documentation table, the env table, check-docs-drift, the old section headings) finds none; /review-spec and /review-plan run on this step's own plan once after the lane merges
    revert: git revert of the squash commit
  - id: invariants-manifest
    scope: the coverage manifest edited before the rewrite (spec 6.3): every key the rewrite retires or moves is named here with its fate (retired because the rule moves to docs/money-laws.md or docs/dev.md, kept, or reworded with a pattern that matches both the current and the rewritten file), so the hook's check can fail on a dropped rule when the rewrite lands
    footprint:
      - scripts/claudemd-invariants.txt
      - scripts/check-claudemd-invariants.sh  (only if a pattern needs a form the script cannot read)
    blockedBy: []
    laws: every pattern matches today's file (the check prints OK on the tip); no key is retired whose rule has no other home named in this plan; the keys for money, auth and data invariants stay
    lenses: hinge floor: seams, access-egress; schema-data (scripts/ path)
    test plan: the check on the tip; the check on a copy of today's file with each retired rule's line removed (must still print OK) and with each kept rule's line removed (must print MISSING for that key)
    revert: git revert of the squash commit
  - id: claudemd-rewrite
    scope: os/.claude/CLAUDE.md rewritten to about 130 lines in the four sections of spec 6.3 (invariants; how work flows; conventions; pointers); gone: the push model, the review-model mechanics, the design-stage fleet paragraph (one pointer line stays), the reasoning-effort section, the file-size section (one pointer line), the inline self-check as a checklist (its lines survive as one-line invariants), the two TRANSITIONAL blocks of 2026-10-20 and the Windows block, the tech stack list (README's table is the copy); the gratuity paragraph moves verbatim to docs/money-laws.md if it is not already there in full; every rule carries its provenance bracket (D6); the invariants check prints OK on the tip
    footprint:
      - .claude/CLAUDE.md
      - docs/money-laws.md  (only if the gratuity paragraph is not already carried verbatim)
      - docs/dev.md  (a pointer line if a rule moves there)
    blockedBy: [invariants-manifest]
    laws: every invariant key in the manifest is matched by a line of the new file; every rule the old file carried is either in the new file, in a file the new file points at, or named as retired in this plan's decisions (the lane report lists each); no rule about working with Dallas lives in this file (D7); nothing here quotes him; no em dash
    lenses: hinge floor (.claude/CLAUDE.md is on the hinge set): seams, access-egress; schema-data (the manifest's path)
    test plan: the invariants check on the tip; a side-by-side table in the lane report, old section by old section, saying where each rule went
    revert: git revert of the squash commit (the manifest commit stands either way)
  - id: receipt-cap
    scope: the receipt-tool half of the review cap (D14 as amended; the step 3 and step 4 reports): finalize refuses a confirmed finding left open and a third fix re-pass (a position whose brief is the third re-pass after the first full pass); the store refuses a malformed report instead of storing it with no rows; a fixed mark clears when the raising lens's later pass lists the file as pass or lists only findings that are themselves rejected on that file (the twelve fixed-then-recorded findings of one step 4 lane are the case); the stale rule for a .test.js file relaxed so a test-only fix does not stale a lens's verdict on the library (the review skill section 9 names it as a later tier A change); the skill's lines updated to match
    footprint:
      - scripts/lib/receiptFinalize.js
      - scripts/lib/receiptFinalize.test.js
      - scripts/lib/receiptVerdicts.js  (or wherever the store lives; the lane names it)
      - scripts/review-receipt.js  (the usage header)
      - scripts/review-receipt.test.js
      - .claude/skills/review/SKILL.md  (sections 8 and 9 and the malformed-report line of section 6)
    blockedBy: []
    laws: finalize never accepts a receipt with a confirmed finding left open (the bar's "never left confirmed in a merged receipt"); a refusal names every problem, one line each, and moves nothing; every existing finalize case stays green or is changed only where this lane's rule changes it, each change named in the report; the relaxed stale rule applies to .test.js files only
    lenses: hinge floor (scripts/lib/**, the skill file): seams, access-egress; schema-data; outcomes-providers (exit codes)
    test plan: the two suites with the new cases; one real receipt directory from step 4 replayed through finalize in a throwaway common dir to show the twelve-mark case now clears
    revert: git revert of the squash commit (the skill's lines go back with it)
  - id: gate-markers
    scope: the three marker rules the step 3 review deferred, now that no escape push is needed to reach them: a superseded gate failure that shipped untested is kept until a gate passes on a descendant; a failure whose sha left main requires every check it names on the next gate; a marker with no gates list reads as every check; plus the retention rule for the gate's kept smoke logs and ship's raw stdio logs (a count and an age, decision 7)
    footprint:
      - scripts/lib/markers.js
      - scripts/lib/markers.test.js
      - scripts/lib/shaGate.js
      - scripts/lib/shaGate.test.js
      - scripts/lib/shaGateWorktree.js  (the sweep)
      - scripts/lib/shipLog.js  (the raw-log retention)
      - scripts/lib/shipLog.test.js
    blockedBy: []
    laws: a marker is cleared only by a passing gate on a descendant of the failing sha (fix forward); nothing here pushes; a retention sweep deletes only files older than the rule under the gate's and ship's own directories, never a log the latest record names
    lenses: tier A floor (push-gate's machinery and markers.js are sensitive-listed): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the sibling suites over throwaway repos; the smoke on the first and final tips
    revert: git revert of the squash commit
  - id: board-writer
    scope: the board writer's three pre-existing hazards the step 3 report deferred: its bare opening pull of the shared checkout on both branches replaced by a fetch and a fast-forward-only merge that refuses when main cannot fast-forward (git safety); its retry after a rejected push no longer duplicates the board line; it refuses with a clear line when os has a staged or edited file instead of failing mid-way; its header carries the long-timeout instruction for callers; its ship call stays behind the flip marker as step 3 built it
    footprint:
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - docs/dev.md  (one line under Lanes and ships)
    blockedBy: []
    laws: the writer never rebases, resets or force-moves the shared checkout; a push rejection stops and reports; the only-unpushed-commit guard stays until the flip marker exists
    lenses: hinge floor (board-write.sh is on the hinge set): seams, access-egress; outcomes-providers (exit codes); concurrency (the lock)
    test plan: the sibling suite with the new cases in throwaway repos with a local bare remote
    revert: git revert of the squash commit
  - id: merge-check
    scope: the merge script's check phase and the merge-time receipt check (spec 4.1, D2, 3.7): merge-lane.sh check <branch> takes the ship lock, refuses on any staged change in os, finds the lane's receipt by key or by branch through the index, recomputes the tier and the coverage against the current sensitive list and its own git diff --name-only, compares reviewed_against with current main and prints ready, ready-moved, stale (with the overlap list and the sensitive-landing flag) or refused; the three merged-lane checks become code (the squash on main; the lane's files byte-identical on main with the two generated docs excluded; the worktree gone); the lock moves from .git/merge-lane.lock onto the ship lock through flockExec
    footprint:
      - scripts/merge-lane.sh
      - scripts/lib/mergeCheck.js  (new: the receipt lookup, the tier and coverage recompute, the overlap computation, the merged-lane checks; so the shell stays small)
      - scripts/lib/mergeCheck.test.js  (new)
      - scripts/merge-lane.test.js
      - scripts/merge-lane.docs.test.js
      - docs/dev.md  (the merge lines)
    blockedBy: [receipt-cap, merge-docs-split]
    laws: check never changes the index or the working tree; a receipt whose tier is lower than the recomputed one, or whose file list is short, is refused by name; a missing receipt is refused, never a full review started by the script; the step 4 guard rules stand (nothing another window staged or committed during a merge is ever discarded; every refusal names what it left)
    lenses: tier A floor (merge-lane.sh is hinge; the check reads receipts and the sensitive list, so the plan asks for the A floor): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the suites over throwaway repos carrying receipt directories written by the real receipt tool; the four pre-flip lanes run through check in a scratch clone (read-only on the real lanes), each result pasted
    revert: git revert of the squash commit (the step 4 script stands)
  - id: merge-ship
    scope: the merge script's ship phase (spec 4.1, D10): merge-lane.sh ship <branch> <plan> re-runs the check logic, squashes (the step 4 regeneration, resolution and guard), lands the squash commit once as the step 4 script does (the private copy of the index, the four commit hooks through git hook run, commit-tree on the pinned HEAD, main moved by a compare-and-swap update-ref) with the review block of 3.7 in the message, writes the squash receipt (the patch id of parent..commit, generated docs excluded), then runs shipFlow (the range gate, the markers, the literal-sha push, the watch) under the lock it already holds, and after the push removes the worktree, runs the merged-lane checks and deletes the branch; --resolved skips the squash and verifies the index holds only the lane's paths plus the resolution (the union of step 4); the prose rule's reference under --resolved is the resolved docs' prose, not the merge-tree's (step 4's finding); ship's "leaves the index clean" exceptions are the step 4 refusals, named in the header; everything computed after the commit reads HEAD's tree, never the shared index; dormant until the flip marker, before which ship behaves as the step 4 merge did and prints the cue-only line
    footprint:
      - scripts/merge-lane.sh
      - scripts/lib/mergeShip.js  (new, if the shell would pass 700 lines otherwise)
      - scripts/lib/mergeShip.test.js
      - scripts/merge-lane.test.js
      - scripts/merge-lane.docs.test.js
      - scripts/lib/receipt.js  (the squash kind, if finalize does not write it today)
      - scripts/lib/receipt.test.js
      - docs/dev.md  (the merge lines)
    blockedBy: [merge-check]
    laws: one squash commit, one push, one watch per ship, under one lock; a conflict stops ship with a clean index and named files; a push rejection stops and reports; the marker refusals of 4.4 hold; nothing here weakens the step 4 guard
    lenses: tier A floor: money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the suites over throwaway repos with a local bare remote and the flip marker written there, the gate and the watch stubbed by the step 3 overrides for the server cases and real for the docs-only case; the real run is the rehearsal ship
    revert: git revert of the squash commit (the check phase stands)
  - id: legacy-removal
    scope: the first tier A ship after the flip (spec 4.3, 8): push-gate.js's legacy working-tree-fingerprint path and npm run gate go, the pre-push hook's fallthrough to it goes, the two transitional blocks (the project CLAUDE.md's 2026-10-20 block if the rewrite did not already drop it; the global file's transitional line is Dallas's file, done by hand with a .bak) go, and the board writer's only-unpushed-commit guard retires; built after the flip, shipped through ship with Dallas in the window
    footprint:
      - scripts/push-gate.js
      - scripts/push-gate.test.js
      - .husky/pre-push
      - package.json  (the gate script removed)
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - README.md  (the generated scripts table; regenerated in-lane)
      - docs/dev.md  (the sha gate section's "until the flip" lines)
    blockedBy: [the flip]
    laws: the sha gate and the hook's receipt validation are untouched; every existing push-gate case for sha mode stays green; nothing pushes without the gate
    lenses: tier A floor: money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the suites; the ship of this lane is the first tier A ship after the flip, watched
    revert: git revert of the squash commit (the legacy path returns, dormant behind the marker's presence)
  - id: rehearsal
    scope: the rehearsal ship (spec section 8): a one-line comment change in a server file (a tier A file, so a lane with a comment-only receipt, the step 4 rule), merged and shipped through merge-lane.sh ship with --no-push first (the dry run: the gate, the squash receipt, the watch's manifest, nothing pushed) and then for real with Dallas watching, so the gate, the push, the release field and the watch all run once on a change that can do nothing
    footprint:
      - server/utils/pricingEngine.js  (one comment line; the file is tier A and headed)
    blockedBy: [merge-ship, release-field, the flip]
    laws: the diff is comment-only by the proof; the receipt is comment-only; the ship report names the watch's result honestly (no new Sentry events in the window, never clean)
    lenses: none (comment-only)
    test plan: the proof; the dry run's log; the real ship's log and the watch's record, pasted in the step report
    revert: git revert of the squash commit (ship recognizes the clean revert and writes a revert receipt: the second thing the rehearsal proves)
  - id: comment-followups
    scope: optional, Dallas's call (decision 9): the step 4 leftovers a comment-only lane can take: the two code comments that point at the deleted env table (client/src/utils/uploadLimits.js, server/routes/telegram.js), the owner's payment handle in the Venmo parser's header, and the two shell scripts whose set line precedes their header (board-write.sh, guard-os-main.sh); the 300 placeholder headers under client/src are a separate, larger lane for a later step, Dallas's list
    footprint:
      - client/src/utils/uploadLimits.js
      - server/routes/telegram.js
      - server/scripts/staffPaymentImport/parsers/venmoCsv.js
      - scripts/board-write.sh
      - scripts/guard-os-main.sh
      - README.md  (the generated tree; regenerated in-lane)
    blockedBy: []
    laws: comment lines only, by the proof; no variable, no code
    lenses: none (comment-only; the tier is what the files compute, and a tier A comment-only edit is a lane, which this is)
    test plan: the proof; npm run docs twice changes nothing
    revert: git revert of the squash commit
---

# Instruction rewrite, step 5: the switch-over

**Goal:** make main prod. Everything step 3 built dormant comes alive behind one marker: the merge script gains its check and ship phases and merges through the one push path; the deploy becomes observable; a docs-only push rebuilds nothing; the sensitive list takes its one role; the project rules file is rewritten to the four sections the spec names, with its invariants checked by the hook; the review cap's receipt-tool half lands; the gate's deferred marker rules and the board writer's hazards close; then the flip push through the old path, the marker, the memory archive, the rehearsal ship with Dallas watching, and the legacy path's removal as the first ship after it.

**Spec:** sections 3.7 to 3.11, 4.1 to 4.9, 6.3 to 6.5, 7, 8 (item 5) and the owed items of the step 3 and step 4 reports.

**Decisions this plan makes on what the spec left to the builder (section 9) or left open, stated here so Dallas sees them and can reverse any.**

1. **The Vercel ignore rule is the docs allowlist, not "no client change".** The spec's rule (4.9) is docs-only; the wider rule (skip when nothing under client/ changed) would skip more builds but means a root change that affects the client build (a lockfile, a Node pin) is never built; this plan takes the spec's rule and names the wider one here for Dallas to choose.
2. **The ignore command is a script in scripts/, named by vercel.json**, so it has a test; the json holds one line.
3. **no-unused-vars goes to error only if every existing violation under server/ is mechanical**; the count and the verdict are the lint-errors lane's first report line, and a warning stays otherwise.
4. **The sensitive list's sections are four**, as D11 names them; the D11 hinge set is listed explicitly even where the matcher's globs already cover it, so a reader sees the role without reading the matcher.
5. **The invariants manifest lands in its own commit before the rewrite** (spec 6.3), so the hook can refuse the rewrite if it drops a kept rule.
6. **The receipt cap's rules are the four named in the receipt-cap lane**; the relaxed stale rule applies to .test.js files only.
7. **Retention: the gate keeps the last 20 smoke-log directories and ship keeps raw stdio logs for 30 days**; the sweep runs at the start of the next gate or ship, never on a schedule.
8. **The merged-lane checks as code exclude README.md and ARCHITECTURE.md from the byte-identical check**, as spec 4.1's ship does; the merge regenerates them.
9. **The comment follow-ups are an optional lane**, taken only if Dallas wants them in this step.
10. **The rehearsal's file is pricingEngine.js** (tier A, pure, headed), one comment line, so the ship exercises the money smoke and the watch on a change that cannot act.
11. **The memory archive at the flip is the spec's list (6.5)**: the push-day notes (eighteen files today, 2026-08-16 to 2026-10-27) and the four push-model notes move to memory/_archive/, every link to them rewritten, the two kept notes stay; done by the shipping session, outside git, after the marker is written.
12. **The global file's transitional line is removed by hand at the flip**, with a dated .bak first, by the shipping session (the file is outside git).
13. **Every push in this step is Dallas's cue**: the evidence push, the flip push (through npm run gate and a literal-sha push, the legacy path), the rehearsal ship and the legacy-removal ship; after the legacy-removal ship, D1 holds and no cue is asked for again.
14. **The flip commit is the sensitive-list lane's squash** (D11: the list is tier A from the flip commit on); the flip push is the push whose range carries every lane of this plan but legacy-removal and rehearsal; the marker names that push's sha.
15. **The four pre-flip lanes are not this plan's**: each rebases onto main after the flip (standing practice), meets the hook on its first commit (the step 4 report says what each hits), and gets its receipt through the review skill before its merge; the merge-check lane's acceptance check runs check against them read-only.

## Global constraints

As step 4's: no em dash in any file this plan writes; ids only under os/ (no client or staff name, email or phone number; nothing quotes Dallas); every rule about working with Dallas carries its bracket, mechanics carry none; lanes named rewrite-step5-<id>, cut with npm run worktree:new, the ledger at .superpowers/sdd/2026-10-28-instruction-rewrite-step5/progress.md; implementers and lenses on opus, verify on fable; every new script under scripts/ or scripts/lib/ gets a sibling .test.js and stays under 700 lines; no npm install in a lane; the generated sections regenerated in-lane before every checkpoint under the live hook; the step 4 rule that a comment-only edit to a tier A file is a lane; a lane that edits outside its footprint stops and surfaces.

## Review focus

1. The flip itself: the flip push goes through the legacy path with everything dormant; the marker is written only after origin shows the sha; nothing in the range can push on its own before the marker exists (every push path's marker check, run against a scratch common dir with and without the marker, before the flip).
2. The merge path's receipt check refuses what it must: a lane with no receipt, a receipt at a lower tier than the recomputed one, a short file list, a stale base with overlap; and accepts ready-moved without a session step (merge-check's suite over real receipt directories).
3. The watch never says clean: deploy not observed, superseded, no deploy expected, the event count against the before-window (post-ship-watch's existing suite, unchanged; the rehearsal's real record).
4. The rules file rewrite drops nothing: the manifest commit first, the hook refusing a rewrite that drops a kept rule (the claudemd-rewrite lane's side-by-side table; the invariants-manifest lane's removal checks).
5. The guard rules of step 4 survive the ship phase: nothing another window staged or committed during a merge is discarded (merge-ship's suite reruns the step 4 race cases through ship).

## Order

1. First wave, independent and parallel: release-field, vercel-ignore, sensitive-list, lint-errors, invariants-manifest, receipt-cap, gate-markers, board-writer; comment-followups if taken.
2. claudemd-rewrite after invariants-manifest; design-agents after claudemd-rewrite.
3. merge-check after receipt-cap and merge-docs-split (step 4's last lane); merge-ship after merge-check.
4. The evidence push after vercel-ignore merges: a docs-only commit (a plan revision serves) pushed on Dallas's cue through the legacy path; the shipping session watches Render (no deploy: the build filter) and Vercel (the build skipped: the ignore command) by hand and records both in the ledger.
5. The flip, when every lane of 1 to 3 is merged and the evidence push is recorded: npm run gate, the literal-sha push on Dallas's cue, origin confirmed, the marker written (drb-flip.json: sha, pushed_at, written_by), lane:status read back, the memory archive, the global file's transitional line, the project file's transitional block (if the rewrite left it).
6. rehearsal after the flip: the dry run, then the real ship with Dallas watching.
7. legacy-removal after the rehearsal, shipped through ship.

Revert in reverse dependency order.

## Contracts shared across lanes

**merge-lane.sh check and ship.** The spec's 4.1 as the interface, the step 4 script as the base (the union, the snapshot taken from merge-tree, the guard, the scoped reset judged against the snapshot, the prose rule, the private-index commit landed by commit-tree on the pinned HEAD with a compare-and-swap on main, the put-back of a lane path another window unstaged during the hook, a doc left staged for another window rendered against HEAD, MERGE_LANE_COMMIT handed to the generator, the wait on another git's index.lock, the two nothing-to-merge refusals, the hash check, the render that runs at most twice; the step 4 report and the merge-docs-split lane's amendment in the step 4 plan are the behavior to keep, and rev 2 of this plan names that amendment's final shape). check prints one of ready, ready-moved, stale <files> [sensitive], refused <reason>, exits 0 for the first two and 1 for the others, and changes nothing. ship takes the ship lock through flockExec with the DRB_SHIP_LOCK guard, re-runs check, squashes, lands the commit as step 4 does with the 3.7 block in its message (the receipt tool's block command renders it), writes the squash receipt through the receipt tool (kind squash, the patch id of parent..commit with the generated docs excluded), calls shipFlow with the lock held, and after the push removes the worktree, runs the three merged-lane checks (generated docs excluded) and deletes the branch, each a log line; before the marker exists, ship stops after the commit and prints the cue-only line, which is how every lane of this plan but the last two merges. --resolved: the squash is skipped, the index must hold exactly the lane's union plus the resolution, the prose reference is the resolved docs.

**The release field.** /api/health returns {status, release} where release is process.env.RENDER_GIT_COMMIT when set, else absent; Sentry.init gets release: the same value when set. The watch already reads the field (step 3).

**The ignore command.** scripts/vercel-ignore.sh: exit 0 (skip the build) when git diff --name-only HEAD^ HEAD lists only paths under docs/ (excluding docs/money-laws.md and docs/runbooks/) or README.md or ARCHITECTURE.md; exit 1 otherwise, and on any git failure; one stdout line either way.

**The sensitive list's sections.** A section is a comment line of the form "# == <name> ==" and the header's role sentence; the matcher ignores comments, so the sections are for readers and for the receipt's matched-paths report (which names the section a path fell in, if sensitive-match.js already parses sections from step 2, else that is the lane's one matcher change).

**The receipt cap.** finalize refuses: a finding with verdict confirmed and no fixed or rejected mark; a position whose brief is a third fix re-pass (the store counts the briefs after the first full pass that carry a fix). A fixed mark clears when the raising lens's latest pass lists the file as pass, or lists it as finding with every finding of that pass on that file rejected. A verdict on a .test.js file read before a later change to that same file is not stale for the library file beside it.

**The markers' three rules and retention.** As the gate-markers lane says; the sweep's bounds are decision 7.

## Lane sections

Each lane's acceptance checks follow the pattern of step 4's: a command or a read with a stated pass condition, run by the controller from the worktree; the implementer pastes its own run. The sections are written when a lane is cut, from this front matter, in the brief beside the ledger; the plan's next revision carries each as built. (Written this way so the plan Dallas reads is the lane map above and the decisions, not twenty pages of checks.)

## Report back

When the lanes are done: one line per lane (what landed, the squash sha, the report file, the receipt key); the fifteen decisions restated for Dallas to reverse; the evidence push's two observations; the flip push's sha and the marker; the rehearsal's dry run and real ship logs and the watch's record; the legacy-removal ship's log; the memory archive list; what the four pre-flip lanes now need; the deferred items for his list; any check that did not pass as a failure with its output.

## Test plan

Scripts and prose; the sibling suites per lane plus the acceptance checks; the real runs are the evidence push, the flip push, the rehearsal ship and the legacy-removal ship, each with Dallas's cue and, for the last three, with him in the window.

## What this step does not do

The within-section trim of kept prose (step 4 decision 10) and the 300 placeholder headers stay on Dallas's list. The walkthroughs-owed file's fate, the Node 24/26 mismatch, the ledger-closing-by-commit idea and the lighter audit of the design agents stay open questions (spec section 10). The project plan skill that replaces writing-plans and subagent-driven-development (D15) is after the flip, its own plan. The prod findings of the lens audit's section 9 are Dallas's to place on the ledger.
