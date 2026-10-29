---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 5 of section 8, the switch-over
format: lane map without code (spec D12)
revision: 6 (2026-10-29; revs 1 to 5 on 2026-10-28)
status: written 2026-10-28 while step 4's last lane (merge-docs-split, the merge script's remaining windows) was in its first fix round; rev 2 folds the plan fleet's findings (two reviewers, four blockers, twelve warnings); rev 3 names that lane's final shape, merged the same day as 4fef2ba0 (the step 4 plan's rev 12 amendment is the record); rev 4 records Dallas's answers of 2026-10-28 on the four decisions put to him (decision 9) and the Vercel setting he confirmed (the Order's step 0); shown to Dallas before any lane is cut (spec section 8, his instruction); not built until he says go; built from 2026-10-28 on his go, given after rev 4 was reported to him (his words in the step 5 ledger); rev 5 records the first lane as built; rev 6 (2026-10-29) drops the shown-to-Dallas rule for the rest of the step (his words of 2026-10-29 in the step 5 ledger: he never wanted to read plans, and nothing in this step waits on him but the word push when real server code ships), orders the core lanes first, and records the manifest lane as built. Execution model as in step 4: each lane is built by an opus implementer from a brief beside the ledger, the controller verifies every acceptance check itself, the review skill runs per lane at the tier it computes and writes a receipt, the lane merges through scripts/merge-lane.sh from os (the step 4 script until the merge-ship lane lands, then the new one), the three merged-lane checks run, the worktree and branch go, a lane report goes beside the ledger, and the plan gets a revision through the docs quick-fix chain. Every push in this step is Dallas's cue (pushes stay cue-only until the flip marker exists), and the flip itself, the rehearsal ship and the legacy-removal ship happen with him in the window. Rev 7 (2026-10-29): the sensitive-list, claudemd-rewrite, css-scope-suite and release-field lanes as built (the third a repair lane outside this front matter), the section names and two acceptance checks corrected, and the merge order the merge-time check imposes. Rev 8 (2026-10-29): the merge-check lane as built, its acceptance check 2 reworded to what was built, and the merge-ship lane cut. Rev 9 (2026-10-29): the merge-ship lane as built, decision 25 (the resume and the dry run's semantics), the merge-ship and rehearsal acceptance checks reworded, and the ship-resume lane added as the split from merge-ship's last review pass, merged before the flip.
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
    scope: a docs-only push does not rebuild the client (spec 4.7, 4.9): client/vercel.json gains an ignoreCommand running client/scripts/vercel-ignore.sh, which exits 0 (cancel the build) when every file changed between the last successful deployment's sha (VERCEL_GIT_PREVIOUS_SHA, which Vercel exposes only to the ignore step) and HEAD is on the docs allowlist (docs/** minus docs/money-laws.md and docs/runbooks/**, README.md, ARCHITECTURE.md), and 1 (build) otherwise, on an empty previous sha, on a sha the ten-commit clone does not hold, and on any git failure; merged first, pushed with the step 4 push, proven by the evidence push
    footprint:
      - client/vercel.json  (one ignoreCommand line; the redirects and rewrites byte-identical)
      - client/scripts/vercel-ignore.sh  (new; under client/ because Vercel's root directory is client/ and the build cannot reach above it)
      - scripts/vercel-ignore.test.js  (new; builds throwaway repos and runs the script with the variables set by hand)
    blockedBy: []
    laws: the range judged is the deployed range, never the tip commit alone; the allowlist equals sensitive-match's docs-only list minus the hinge docs; every failure builds (fail toward building); the command reads no secret and prints one line saying why it built or cancelled
    lenses: hinge floor (client/vercel.json is on the D11 hinge set; scripts/ path): seams, access-egress; schema-data
    test plan: the sibling suite over throwaway repos (docs-only range, mixed range, a hinge doc alone, a multi-commit range whose tip is docs-only but whose earlier commit touches client/, an empty previous sha, a previous sha outside a depth-limited clone); the evidence push is the real run
    revert: git revert of the squash commit (every push then rebuilds the client, as today)
  - id: sensitive-list
    scope: the sensitive list becomes the one role the spec gives it (D11, 3.3): the header rewritten to say it scales the review tier and nothing else (the conflict-escalation and auto-pull clauses go with the push model), the file split into the matcher's four sections through its own `# section: <name>` header lines (money, auth, client, hinge), the D11 hinge set moved from the matcher's HINGE_PATHS constant into the list's hinge section (the constant then empty or gone, with its test), the step 3 additions it still lacks (scripts/lib/shipLog.js, scripts/lib/receipt.js, scripts/lib/piiShapes.js) and the step 3 plan's 122 money additions, and client/scripts/vercel-ignore.sh added to the hinge section (the vercel-ignore review: the script decides whether the client deploys and computed tier C, outside the content rule's roots); this is the flip commit's content
    footprint:
      - scripts/sensitive-paths.txt
      - scripts/sensitive-match.js  (the HINGE_PATHS constant retired in favour of the list's hinge section; nothing else)
      - scripts/sensitive-match.test.js
      - client/scripts/vercel-ignore.sh  (one comment line: its header's pointer at HINGE_PATHS re-pointed at the list's hinge section)
    blockedBy: []
    laws: no path the list covers today leaves it and no path's tier is lowered (a script in the lane prints every tracked path's tier at the base and the tip; the diff is additions, section headers and the header rewrite); every added pattern matches at least one tracked path; the hinge section keeps the hinge tier of spec 3.3 (D11's "tier A" reads as sensitive-listed); a path in each section reports that section to the matcher
    lenses: hinge, as the list and the matcher compute under decision 4 (the rev 1 to 5 line claiming a tier A floor was wrong about the computed tier): seams, access-egress; schema-data; the before-and-after tier comparison is the law's proof
    test plan: the matcher's suite with a case per section header and a malformed-header refusal; the before-and-after tier comparison over git ls-files pasted in the lane report
    revert: git revert of the squash commit (the list goes back to its 2026-10-27 shape and the matcher's constant returns with it)
  - id: lint-errors
    scope: no-unused-vars becomes an error for server/ in eslint.config.mjs (spec section 7) if every existing violation under server/ is mechanical (an unused binding deleted, or renamed with an underscore prefix the rule ignores); the count is measured first; when some are not mechanical, the mechanical fixes land, the rule stays a warning, and the report counts what is left and why
    footprint:
      - eslint.config.mjs
      - server/**  (only the lines eslint names; never server/index.js or server/routes/telegram.js, which other lanes hold)
    blockedBy: [release-field, comment-followups]
    laws: every edit is a deletion of an unused binding or an underscore rename; a deletion that changes a function's arity, a destructuring's shape or an exported name is out of scope; the server suites a changed file reaches run green; the money smoke runs when a sensitive file is touched
    lenses: what the touched files fire (a sensitive server file makes it tier A); seams and access-egress floors on the config
    test plan: eslint server/ exits 0 with the rule at error, or the count line when it stays a warning; the reached suites; the smoke if tier A
    revert: git revert of the squash commit
  - id: design-agents
    scope: the design-stage agents point at the rules as they now are (spec section 7, step 5): spec-risk's Secrets question asks for the .env.example block, never a CLAUDE.md mention; plan-decomposition's stale "commit rule 3" pointer and every reference to a CLAUDE.md section name are re-pointed at the rewritten file's section names or at docs/dev.md and docs/money-laws.md; the Windows line and the no-client-tests line are confirmed gone; a lighter audit of the five agents against their own record is not this lane (open question, section 10)
    footprint:
      - .claude/agents/spec-grounding.md
      - .claude/agents/spec-gaps.md
      - .claude/agents/spec-risk.md
      - .claude/agents/plan-fidelity.md
      - .claude/agents/plan-decomposition.md
      - .claude/commands/review-spec.md
      - .claude/commands/review-plan.md
    blockedBy: [claudemd-rewrite]
    laws: no agent gains or loses a check; only pointers and names change; no em dash
    lenses: hinge floor (the agent files are on the hinge set): seams, access-egress
    test plan: a grep over the seven files for the retired names finds none; /review-spec and /review-plan run on this plan once after the lane merges
    revert: git revert of the squash commit
  - id: invariants-manifest
    scope: the coverage manifest edited before the rewrite (spec 6.3): every one of its 16 keys named below with its fate (14 kept as they are, encryption-pii reworded to match the rewritten line, none retired), four keys added for invariants 6.3 keeps that the manifest never covered (os-on-main, one-connection, dev-live-stripe, receipt-required), so the hook's check can fail on a dropped rule when the rewrite lands
    footprint:
      - scripts/claudemd-invariants.txt
      - scripts/check-claudemd-invariants.sh  (as built: the additive mode and the malformed-manifest refusals)
      - .husky/pre-commit  (as built: one call line and its header; a widening by ruling at the review)
      - ARCHITECTURE.md  (the hook sentence, by hand)
      - README.md  (the generated tree)
    blockedBy: []
    laws: every pattern matches today's file (the check prints OK on the tip); no key is retired; the keys for money, auth and data invariants stay
    lenses: hinge floor: seams, access-egress; schema-data (scripts/ path)
    test plan: the check on the tip; the check on a copy of today's file with each kept rule's line removed (MISSING for that key, 20 times)
    revert: git revert of the squash commit
  - id: claudemd-rewrite
    scope: os/.claude/CLAUDE.md rewritten to about 130 lines in the four sections of spec 6.3 (invariants; how work flows; conventions; pointers); gone: the push model, the review-model mechanics, the design-stage fleet paragraph (one pointer line stays), the reasoning-effort section, the file-size section (one pointer line), the inline self-check as a checklist (its lines survive as one-line invariants), the 2026-10-20 transitional block and the Windows block, the tech stack list (README's table is the copy); kept: exactly one dated transitional line saying pushes are cue-only through npm run gate and a literal-sha push until the flip marker exists, which legacy-removal removes (D10); the gratuity paragraph moves verbatim to docs/money-laws.md if it is not already there in full; every rule carries its provenance bracket (D6); the invariants check prints OK on the tip
    footprint:
      - .claude/CLAUDE.md
      - scripts/claudemd-invariants.txt  (one key added, dev-live-stripe, in the same commit as its line; the hook's additive mode allows an added key and refuses a changed one)
      - docs/money-laws.md  (only if the gratuity paragraph is not already carried verbatim)
      - docs/dev.md  (a pointer line if a rule moves there)
    blockedBy: [invariants-manifest]
    laws: every invariant key in the manifest is matched by a line of the new file; every rule the old file carried is either in the new file, in a file the new file points at, or named as retired in the lane report's side-by-side table; no rule about working with Dallas lives in this file (D7); nothing here quotes him; no em dash
    lenses: hinge floor (.claude/CLAUDE.md is on the hinge set): seams, access-egress; schema-data (the manifest's path)
    test plan: the invariants check on the tip; the side-by-side table in the lane report, old section by old section, saying where each rule went
    revert: git revert of the squash commit (the manifest commit stands either way)
  - id: receipt-cap
    scope: the receipt-tool half of the review cap (D14 as amended; the step 3 and step 4 reports): finalize refuses a confirmed finding left open and a third fix re-pass (a position whose brief is the third re-pass after the first full pass); the store refuses a malformed report with exit 1 instead of storing it with no rows; a fixed mark clears when the raising lens's later pass lists the file as pass or lists only findings that are themselves rejected on that file (the 32 fixed-then-recorded findings of step 4 are the case); the skill's lines updated to match
    footprint:
      - scripts/lib/receiptFinalize.js
      - scripts/lib/receiptFinalize.test.js
      - scripts/lib/receiptVerdicts.js  (or wherever the store lives; the lane names it)
      - scripts/review-receipt.js  (the usage header)
      - scripts/review-receipt.test.js
      - .claude/skills/review/SKILL.md  (sections 8 and 9 and the malformed-report line of section 6)
    blockedBy: []
    laws: finalize never accepts a receipt with a confirmed finding left open; a refusal names every problem, one line each, and moves nothing; every existing finalize case stays green or is changed only where this lane's rule changes it, each change named in the report; the .test.js staleness rule is not touched (deferred, decision 6)
    lenses: hinge floor (scripts/lib/**, the skill file): seams, access-egress; schema-data; outcomes-providers (exit codes)
    test plan: the two suites with the new cases; one real receipt directory from step 4 replayed through finalize in a throwaway common dir to show the twelve-mark case now clears
    revert: git revert of the squash commit (the skill's lines go back with it)
  - id: gate-markers
    scope: the three marker rules the step 3 review deferred, now that no escape push is needed to reach them (a superseded gate failure that shipped untested is kept until a gate passes on a descendant; a failure whose sha left main requires every check it names on the next gate; a marker with no gates list reads as every check), and the whole-tree docs check of spec 5.1 and 5.3 in the sha gate (node scripts/gen-docs.js --check --ref <sha> on the gated sha, a stale section or a header-less source file failing the gate by name), which ship reaches through the gate
    footprint:
      - scripts/lib/markers.js
      - scripts/lib/markers.test.js
      - scripts/lib/shaGate.js
      - scripts/lib/shaGate.test.js
      - scripts/lib/shaGateWorktree.js  (the sweep)
      - docs/dev.md  (the sha gate section's check list)
    blockedBy: []
    laws: a marker is cleared only by a passing gate on a descendant of the failing sha (fix forward); nothing here pushes; the docs check runs on the sha's tree, never the working tree
    lenses: tier A floor (push-gate's machinery and markers.js are sensitive-listed): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the sibling suites over throwaway repos; the smoke on the first and final tips
    revert: git revert of the squash commit
  - id: log-retention
    scope: the retention rule for the gate's kept smoke logs and ship's raw stdio logs (decision 7): the gate keeps the last 20 smoke-log directories and ship keeps raw logs for 30 days; each sweep runs inside the writer the gate and ship already call (the smoke-log writer in shaGate's worktree module; shipLog's append), never on a schedule, and never removes the log the latest record names
    footprint:
      - scripts/lib/shipLog.js
      - scripts/lib/shipLog.test.js
      - scripts/lib/shaGateWorktree.js  (the smoke-log directory writer)
      - scripts/lib/shaGate.test.js  (the retention case)
    blockedBy: [gate-markers]
    laws: a sweep deletes only files older than the rule under the gate's and ship's own directories; the latest record's log is never removed; nothing here pushes
    lenses: tier A floor (shaGate's modules are sensitive-listed): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the two suites with the retention cases over throwaway directories; the smoke on the first and final tips
    revert: git revert of the squash commit (logs then accumulate, as today)
  - id: board-writer
    scope: the board writer's three pre-existing hazards the step 3 report deferred: its bare opening pull of the shared checkout on both branches replaced by a fetch and a fast-forward-only merge that refuses when main cannot fast-forward (git safety); its retry after a rejected push no longer duplicates the board line; it refuses with a clear line when os has a staged or edited file instead of failing mid-way; its header carries the long-timeout instruction for callers and its set line moves below the header (the step 4 follow-up); its ship call stays behind the flip marker as step 3 built it
    footprint:
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - docs/dev.md  (one line under Lanes and ships)
    blockedBy: []
    laws: the writer never rebases, resets or force-moves the shared checkout; a push rejection stops and reports; the only-unpushed-commit guard stays until the flip marker exists
    lenses: hinge floor (board-write.sh is on the hinge set): seams, access-egress; outcomes-providers (exit codes); concurrency (the lock)
    test plan: the sibling suite with the new cases in throwaway repos with a local bare remote
    revert: git revert of the squash commit
  - id: stale-files
    scope: the spec's cut list (section 7) finished: .comms-sms-contract.md and .plan-2-contract.md deleted from the repo root (render.yaml went in step 1 and _cleanup_payroll.js is not tracked), README's tree regenerated in-lane
    footprint:
      - .comms-sms-contract.md  (deleted)
      - .plan-2-contract.md  (deleted)
      - README.md  (the generated tree, regenerated in-lane)
    blockedBy: []
    laws: nothing else changes; a grep over the tree finds the two names only in history files (plans, specs, the lens audit)
    lenses: what the files compute (root .md files are unclassified, so hinge: seams, access-egress)
    test plan: git ls-files empty for both; npm run docs -- --check exit 0
    revert: git revert of the squash commit
  - id: merge-check
    scope: the merge script's check phase and the merge-time receipt check (spec 4.1, 3.7, 3.8, 4.6, D2): merge-lane.sh check <branch> takes the ship lock through flockExec (the lock moves from .git/merge-lane.lock onto the ship lock), refuses on any staged change in os, blocks on an unstaged edit or an untracked file only when its path intersects the lane's paths or the generated docs (4.6; the step 4 script refuses any dirty tree), finds the lane's receipt by key or by branch through the index, recomputes the tier and the coverage against the current sensitive list and its own git diff --name-only, compares reviewed_against with current main and the receipt's recorded tip with the branch tip (recorded_tip..tip is named as needing review at its own tier), reads the receipt's test counts from the runner log as rangeCheck.js does, and prints ready, ready-moved, stale (with the overlap list and the sensitive-landing flag) or refused; the three merged-lane checks become code (the squash on main; the lane's files byte-identical on main with the two generated docs excluded; the worktree gone); the step 4 guard rules stand unchanged; the split lane's two deferred minors that touch the check phase are taken here: the carried-by check reads the own paths without the two docs, so a prose-only lane taken by another window's plain commit during the hook still gets the nothing-was-merged lines, and docs/dev.md's merge sentence overclaims that the last line never says nothing was merged
    footprint:
      - scripts/merge-lane.sh
      - scripts/lib/mergeCheck.js  (new: the receipt lookup, the tier and coverage recompute, the overlap computation, the merged-lane checks; so the shell stays small)
      - scripts/lib/mergeCheck.test.js  (new)
      - scripts/merge-lane.test.js
      - scripts/merge-lane.docs.test.js
      - scripts/merge-lane.check.test.js  (new, the sibling suite for the two subcommands; the two existing merge suites are at 699 lines)
      - docs/dev.md  (the merge lines)
      - README.md  (the generated tree, regenerated in-lane for the new library file)
    blockedBy: [merge-docs-split]  (receipt-cap dropped as a blocker at the build: check reads receipts as finalize writes them today)
    laws: check never changes the index or the working tree; a receipt whose tier is lower than the recomputed one, or whose file list is short, is refused by name; a missing receipt is refused, never a full review started by the script; the step 4 guard rules stand (nothing another window staged or committed during a merge is ever discarded; every refusal names what it left)
    lenses: the computed tier (hinge), decision 22 reversed for this lane at the build: check runs nothing until the flip, and a dormant tooling script gets the computed pass; merge-ship, which pushes, keeps tier A by hand
    test plan: the suites over throwaway repos carrying receipt directories written by the real receipt tool; the four pre-flip lanes run through check in a scratch clone (read-only on the real lanes), each result pasted
    revert: git revert of the squash commit (the step 4 script stands)
  - id: merge-ship
    scope: the merge script's ship phase (spec 4.1, 3.8, 3.11, D10): merge-lane.sh ship <branch> <plan> [--no-push] re-runs the check logic, squashes (the step 4 regeneration, resolution and guard), on ready-moved re-runs the suites the receipt names on the merged tree before the gate, lands the squash commit once as the step 4 script does (the private copy of the index, the four commit hooks through git hook run, commit-tree on the pinned HEAD, main moved by a compare-and-swap update-ref) with the review block of 3.7 in the message, writes the squash receipt (the patch id of parent..commit, generated docs excluded), then runs shipFlow (the range gate, the markers, the literal-sha push; --no-push passed through, so the dry run stops before the push) under the lock it already holds, releases the lock after the push, starts the watch detached outside the lock (3.11), and after the push removes the worktree, runs the merged-lane checks and deletes the branch; the ship phase runs in the background and writes its progress and result to <git-common-dir>/drb-ship/<sha>.log, which lane:status and the window read (4.1); --resolved skips the squash and verifies the index holds only the lane's paths plus the resolution (the union of step 4), with the prose rule's reference the resolved docs' prose, not the merge-tree's; ship's "leaves the index clean" exceptions are the step 4 refusals, named in the header; everything computed after the commit reads HEAD's tree, never the shared index; dormant until the flip marker, before which ship stops after the commit and prints the cue-only line
    footprint:
      - scripts/merge-lane.sh
      - scripts/lib/mergeShip.js  (new, if the shell would pass 700 lines otherwise)
      - scripts/lib/mergeShip.test.js
      - scripts/merge-lane.test.js
      - scripts/merge-lane.docs.test.js
      - scripts/lib/receipt.js  (the squash kind, if finalize does not write it today)
      - scripts/lib/receipt.test.js
      - docs/dev.md  (the merge lines)
      - README.md  (the generated tree, regenerated in-lane for the new library file)
    blockedBy: [merge-check]
    laws: one squash commit, one push, one watch per ship, under one lock; the lock is released before the watch; a conflict stops ship with a clean index and named files; a push rejection stops and reports; the marker refusals of 4.4 hold; nothing here weakens the step 4 guard
    lenses: tier A, taken above the computed hinge tier at finalize as merge-check does: money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the suites over throwaway repos with a local bare remote and the flip marker written there, the gate and the watch stubbed by the step 3 overrides for the server cases and real for the docs-only case; the step 4 race cases re-run through ship; the real run is the rehearsal
    revert: git revert of the squash commit (the check phase stands)
  - id: ship-resume
    scope: the split from merge-ship's last review pass (the review bar: a reachable finding after the second re-pass is fixed in a new lane): the branch delete after a push and the resume compare the branch's tree with the squash's tree outside the two docs; a reverted squash is not resumable and the refusal names the real way through; the push-rejection ending names the replay of main's unpushed squashes and a replayed squash resumes by its patch-id key; the phase lines retire once the squash is on origin and the lane is gone, with a cap at session start
    footprint:
      - scripts/lib/mergeShip.js
      - scripts/lib/mergeShipSquash.js
      - scripts/lib/mergeShipLog.js
      - scripts/lib/mergeShipTestkit.js
      - scripts/lib/mergeCheck.js  (the check CLI's merged answer)
      - scripts/lane-status.js
      - the sibling suites of each, scripts/merge-lane.resume.test.js and scripts/merge-lane.ship.test.js
      - docs/dev.md  (the ship and check lines)
    blockedBy: [merge-ship]
    laws: nothing a push never carried is ever deleted (a branch -D only when the branch's tree equals the squash's outside the two docs); a resume never pushes a squash whose receipt its key does not hold; the push-failure rule stands (no auto-pull, no force; the replay is the owner's call)
    lenses: the computed tier (hinge, since no money-listed file moves): seams, access-egress, and whichever the diff fires
    test plan: the suites over throwaway repos, each new case failing first on main's code
    revert: git revert of the squash commit (the ship phase stands as merged)
  - id: legacy-removal
    scope: the first tier A ship after the flip (spec 4.3, 8): push-gate.js's legacy working-tree-fingerprint path and npm run gate go, the pre-push hook's fallthrough to it goes, the project CLAUDE.md's one dated transitional line goes (decision 17), and the board writer's only-unpushed-commit guard retires; built after the flip, shipped through ship with Dallas in the window
    footprint:
      - scripts/push-gate.js
      - scripts/push-gate.test.js
      - .husky/pre-push
      - package.json  (the gate script removed)
      - scripts/board-write.sh
      - scripts/board-write.test.js
      - .claude/CLAUDE.md  (the dated line only)
      - README.md  (the generated scripts table; regenerated in-lane)
      - docs/dev.md  (the sha gate section's "until the flip" lines)
    blockedBy: [rehearsal]
    laws: the sha gate and the hook's receipt validation are untouched; every existing push-gate case for sha mode stays green; nothing pushes without the gate; the invariants check prints OK with the line gone
    lenses: tier A floor: money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke
    test plan: the suites; the ship of this lane is the first tier A ship after the flip, watched
    revert: git revert of the squash commit (the legacy path returns, dormant behind the marker's presence)
  - id: rehearsal
    scope: the rehearsal ship (spec section 8), three actions with Dallas in the window after the flip (Order 6): a one-line comment change in server/utils/pricingEngine.js (a tier A file, so a lane with a comment-only receipt, the step 4 rule), first merge-lane.sh ship --no-push (the dry run: the gate, the squash receipt, nothing pushed), then the real ship (the gate, the push, the release field, the watch), then a git revert of that squash shipped the same way, so ship's clean-revert recognition and its revert receipt run once for real
    footprint:
      - server/utils/pricingEngine.js  (one comment line; the file is tier A and headed)
    blockedBy: [merge-ship, release-field]
    laws: the diff is comment-only by the proof; the receipt is comment-only; the ship report names the watch's result honestly (no new Sentry events in the window, never clean); the three actions run only after the flip push is confirmed on origin and the marker exists
    lenses: none (comment-only)
    test plan: the proof; the dry run's log; the real ship's log and the watch's record; the revert ship's log and receipt, all pasted in the step report
    revert: the third action is the revert
  - id: comment-followups
    scope: optional, Dallas's call (decision 9): the step 4 leftovers a comment-only lane can take: the two code comments that point at the deleted env table (client/src/utils/uploadLimits.js, server/routes/telegram.js) and guard-os-main.sh's set line moved below its header (board-write.sh's goes with the board-writer lane); the owner's payment handle in the Venmo parser's header stays, Dallas's decision of 2026-10-28 (decision 9); the 300 placeholder headers under client/src are a separate, larger lane for a later step, Dallas's list
    footprint:
      - client/src/utils/uploadLimits.js
      - server/routes/telegram.js
      - scripts/guard-os-main.sh
      - README.md  (the generated tree; regenerated in-lane)
    blockedBy: []
    laws: comment lines only, by the proof; no variable, no code
    lenses: none (comment-only; the tier is what the files compute, and a tier A comment-only edit is a lane, which this is)
    test plan: the proof; npm run docs twice changes nothing
    revert: git revert of the squash commit
---

# Instruction rewrite, step 5: the switch-over

**Goal:** make main prod. Everything step 3 built dormant comes alive behind one marker: the merge script gains its check and ship phases and merges through the one push path; the deploy becomes observable; a docs-only push rebuilds nothing; the sensitive list takes its one role; the project rules file is rewritten to the four sections the spec names, with its invariants checked by the hook; the review cap's receipt-tool half lands; the gate's deferred marker rules, the whole-tree docs check, the log retention and the board writer's hazards close; the two stale root files go; then, each on Dallas's cue, the step 4 push, the evidence push, the flip push through the old path, the marker, the memory archive, the rehearsal's three ships with Dallas watching, and the legacy path's removal as the first ship after it.

**Spec:** sections 3.7 to 3.11, 4.1 to 4.9, 5.1, 5.3, 6.3 to 6.5, 7, 8 (item 5) and the owed items of the step 3 and step 4 reports.

**Decisions this plan makes on what the spec left to the builder (section 9) or left open, stated here so Dallas sees them and can reverse any.**

1. **The Vercel ignore rule is the docs allowlist over the deployed range, not "no client change" and not the tip commit.** The spec's rule (4.7, 4.9) is docs-only over the push range; Vercel exposes the last successful deployment's sha to the ignore step alone, so the script diffs that sha to HEAD, and an empty value (a first deployment), a sha the ten-commit clone does not hold, or any git failure builds. The wider rule (skip when nothing under client/ changed) would skip more builds but means a root change that affects the client build (a lockfile, a Node pin) is never built; this plan takes the spec's rule and names the wider one here for Dallas to choose.
2. **The ignore script lives under client/scripts/, its test under scripts/, and vercel.json holds one line.** Vercel runs the ignore command inside the project's root directory (client/), which cannot use `..`; a script above it would fail and every push would build. The test runs the script from a throwaway repo with the variables set by hand.
3. **no-unused-vars goes to error only if every existing violation under server/ is mechanical**; the count and the verdict are the lint-errors lane's first report line; when some are not mechanical, the mechanical fixes land, the rule stays a warning, and the report counts what is left.
4. **The sensitive list's sections are the matcher's own `# section: <name>` headers**, four of them (hinge, auth-and-pii, client-money-surfaces, money, in that order in the file so that a block appended at the end lands in money; rev 7 corrects the short names rev 2 wrote), since sensitive-match.js already reads that form and throws on a malformed header; the D11 hinge set moves from the matcher's constant into the list's hinge section, where it keeps the hinge tier of spec 3.3 (D11's "tier A from the flip commit on" is read as "sensitive-listed from the flip commit on"; raising the hinge set to tier A would put six lenses, verify, the externals and the smoke on every skill-file edit, which 3.3 does not ask for). The matcher's test gains a case per section.
5. **The invariants manifest lands in its own commit before the rewrite** (spec 6.3), so the hook can refuse the rewrite if it drops a kept rule; the 16 keys' fates and the four new keys are listed below.
6. **The receipt cap's rules are three refusals and the clearing rule** named in the receipt-cap lane; the .test.js staleness relaxation the review skill's section 9 names as its own later tier A change is deferred (section "What this step does not do"), so the lane's revert is one feature.
7. **Retention: the gate keeps the last 20 smoke-log directories and ship keeps raw stdio logs for 30 days**; the sweep runs inside the writers the gate and ship already call, never on a schedule; its own lane (log-retention), so a wrong marker rule and a wrong sweep revert apart.
8. **The merged-lane checks as code exclude README.md and ARCHITECTURE.md from the byte-identical check**, as spec 4.1's ship does; the merge regenerates them.
9. **The comment follow-ups are an optional lane**, taken only if Dallas wants them in this step; board-write.sh's header fix moves to the board-writer lane so no two first-wave lanes edit one file. On 2026-10-28 Dallas was shown that the owner's payment handle sits in the public README through the generated tree (from the Venmo parser's header) and decided it stays (his decision; his words are in the step 4 ledger's entry of that day), so the lane loses that item and its file; what is left is housekeeping he did not ask for, so the lane is not cut in this step unless he asks (my call) and lint-errors follows release-field alone. The other three decisions put to him the same day stand as written, by his answer: the step 4 push as a real deploy (decision 13), his presence in the window for the flip push, the rehearsal's two real ships and the legacy-removal ship (the status line), and the review tooling's own files at the hinge depth with the two merge-script lanes alone at tier A (decision 22).
10. **The rehearsal's file is pricingEngine.js** (tier A, pure, headed), one comment line, so the ship exercises the money smoke and the watch on a change that cannot act; the rehearsal is three actions (the dry run, the real ship, the revert ship), so the clean-revert recognition runs once for real too.
11. **The memory archive at the flip is the spec's list (6.5)**: the push-day notes (eighteen files today, 2026-08-16 to 2026-10-27) and the four push-model notes move to memory/_archive/, every link to them rewritten, the two kept notes stay; done by the shipping session, outside git, after the marker is written.
12. **The global file's transitional line is removed by hand at the flip**, with a dated .bak first, by the shipping session (the file is outside git).
13. **Every push in this step is Dallas's cue, and there are six**: the step 4 push (everything unpushed since 2026-10-27, today 27 commits over 437 client files, 126 server files, 45 scripts, the hook and the two package files, plus vercel-ignore's squash and this plan: a real deploy of step 4's comment-only source changes and scripts, through npm run gate and a literal-sha push, with the shipping session watching Render and Vercel by hand since the watch is not live); the evidence push (one docs-only commit, a plan revision, pushed alone); the flip push; the rehearsal's real ship and its revert ship; the legacy-removal ship. After the legacy-removal ship, D1 holds and no cue is asked for again.
14. **The flip commit is the sensitive-list lane's squash** (D11: the list is tier A from the flip commit on); the flip push is the push whose range carries every lane merged after the evidence push (all but legacy-removal and rehearsal, and but those already out in the step 4 push); the marker names that push's sha.
15. **The four pre-flip lanes are not this plan's**: each rebases onto main after the flip (standing practice), meets the hook on its first commit (the step 4 report says what each hits), and gets its receipt through the review skill before its merge; the merge-check lane's acceptance check runs check against them read-only.
16. **The 26 pre-skill commits and the 5 PII-flagged lines are taken as given**: they are on origin since the 2026-10-27 push (6ee533ea), outside every range the gate reads (origin/main..sha), so review --commit on them is not run and the flip push's range starts after them.
17. **The project file's transitional block has one owner**: the claudemd-rewrite lane drops the 2026-10-20 block and keeps exactly one dated line saying pushes are cue-only through npm run gate and a literal-sha push until the flip marker exists (D10: the file says plainly what stands until the tooling ships); the legacy-removal lane removes that line, with .claude/CLAUDE.md in its footprint; the flip itself touches only the global file (decision 12).
18. **The flip has a written rollback**: until the legacy-removal ship, un-flipping is deleting the marker file (every push path then falls through to the legacy fingerprint path and the cue-only rule) and restoring the global file from its dated .bak; the project file's dated line still stands then. After the legacy-removal ship there is no un-flip, only a revert of that ship.
19. **The whole-tree docs and header check of spec 5.1 and 5.3 lands in the sha gate** (gate-markers), run on the gated sha's tree with --ref; ship reaches it through the gate, so no second wiring in merge-ship.
20. **Two mismatches are deferred, named**: Render's build filter ignores all of docs/** while the push path and the ignore rule treat docs/money-laws.md and docs/runbooks/** as hinge, so a push touching only a hinge doc makes the watch wait for a Render deploy that never comes and report "deploy not observed" after its bounded wait (honest, not wrong; aligning the two lists is a watch change for a later step); and rangeCheck.js's re-proof of a comment-only receipt at push stays undone, because the receipt key already binds the proof to the exact tree it proved.
21. **The two root contract files go in their own small lane (stale-files)**; render.yaml went in step 1 and _cleanup_payroll.js is not tracked, so the spec's cut list is then complete.
22. **The merge-ship lane reviews at tier A by the controller's hand** (its files compute hinge, and the review skill raises a tier only through a lens's escalate or finalize's --tier above the computed one, so the controller runs the smoke, verify and the externals and finalizes with --tier A, stated in the receipt), because ship pushes to production. merge-check reviews at its computed tier (rev 6, my call at the build: check runs nothing until the flip, and the proportion rule gives a dormant tooling script the computed pass).
25. **The same ship command resumes a lane's unpushed squash, and a dry run lands the squash** (rev 9, my call at the build): `merge-lane.sh ship --no-push` squashes, gates and writes the squash receipt with nothing pushed, so the squash sits on main unpushed; the same command run again finds it (the merge(lane <branch>) subject between origin/main and main, the branch at the receipt's recorded lane tip) and resumes at the push, with the cleanup after it; a cue-only run (no flip marker) is the same shape. So the rehearsal's dry run then real ship is one command twice, and its check 3 reads origin/main at the squash sha when nothing landed on main in between. The progress log is keyed on the judged lane tip, lane:status reads a phase manifest beside it, and the check CLI answers a squashed lane with a fifth answer. The ship-resume lane closes the four gaps the last review pass found in this design (the branch delete and the resume reading the net diff; a reverted squash still resumable; a replayed squash refused for want of a receipt its key holds; the phase lines never retiring).
23. **The step is built without being shown to Dallas lane by lane** (rev 6, 2026-10-29): he never wanted to read plans, and after the step 4 deploy he said so plainly (his words in the step 5 ledger); the core lanes run first (release-field, sensitive-list, invariants-manifest, claudemd-rewrite, merge-check, merge-ship, then the flip, the rehearsal and legacy-removal) and the hardening lanes (lint-errors, design-agents, receipt-cap, gate-markers, log-retention, board-writer, stale-files, comment-followups) stay in the plan and run after; the rehearsal runs without him in the window and is reported; the only thing asked of him is the word push when real server code ships, because the harness's permission gate refuses a push until he says it.
24. **The manifest holds 37 keys, not 20** (rev 6): the manifest lane's review found that the twenty would let the rewrite drop the auth, data and code rules spec 6.3 keeps, and that several patterns were satisfiable by a pointer line the rewritten file must carry; the keys and the tightened patterns are in the file's header; dev-live-stripe is the one key the rewrite lane adds with its line, and the hook's additive mode is what makes that safe.

## Global constraints

As step 4's: no em dash in any file this plan writes; ids only under os/ (no client or staff name, email or phone number; nothing quotes Dallas); every rule about working with Dallas carries its bracket, mechanics carry none; lanes named rewrite-step5-<id>, cut with npm run worktree:new, the ledger at .superpowers/sdd/2026-10-28-instruction-rewrite-step5/progress.md; implementers and lenses on opus, verify on fable; every new script under scripts/ or scripts/lib/ gets a sibling .test.js and stays under 700 lines; no npm install in a lane; the generated sections regenerated in-lane before every checkpoint under the live hook (a lane that adds a file under scripts/ or scripts/lib/ names README.md in its footprint for that reason); the step 4 rule that a comment-only edit to a tier A file is a lane; a lane that edits outside its footprint stops and surfaces. docs/dev.md is written by five lanes (board-writer, gate-markers, claudemd-rewrite, merge-check, merge-ship, legacy-removal), several in one wave: the merge script refuses a prose conflict in it, so the second lane to merge rebases onto main first and resolves the section by hand in its worktree before its review re-pass (step 4's rule).

## Review focus

1. The flip itself: the flip push goes through the legacy path with everything dormant; the marker is written only after origin shows the sha; nothing in the range can push on its own before the marker exists (every push path's marker check, run against a scratch common dir with and without the marker, before the flip); the rollback of decision 18 rehearsed once in a scratch common dir (delete the marker, confirm the legacy path re-arms).
2. The merge path's receipt check refuses what it must: a lane with no receipt, a receipt at a lower tier than the recomputed one, a short file list, a stale base with overlap or with a sensitive landing, a recorded tip whose diff is not the reviewed one byte for byte (the refusal naming the lane's own commits since it and their tier; rev 8); and accepts ready-moved without a session step (merge-check's suite over real receipt directories).
3. The watch never says clean: deploy not observed, superseded, no deploy expected, the event count against the before-window (post-ship-watch's existing suite, unchanged; the rehearsal's real record).
4. The rules file rewrite drops nothing: the manifest commit first, the hook refusing a rewrite that drops a kept rule (the claudemd-rewrite lane's side-by-side table; the invariants-manifest lane's removal checks).
5. The guard rules of step 4 survive the ship phase: nothing another window staged or committed during a merge is discarded (merge-ship's suite reruns the step 4 race cases through ship).
6. The Vercel predicate judges the deployed range: the multi-commit case in vercel-ignore's suite, and the evidence push observed on a docs-only commit pushed alone after the step 4 push deployed vercel-ignore's squash.

## Order

0. Before any lane: Dallas confirms in the Vercel project that access to system environment variables is enabled (the ignore step reads VERCEL_GIT_PREVIOUS_SHA; when the setting is off the script sees an empty value and builds, which the evidence push would show as a build, not a cancel). Done: Dallas confirmed it enabled from the Vercel app on 2026-10-28 (docs/dev.md's Vercel section records it); not asked for again. The three dashboard items of spec section 8 are done since 2026-10-27 (the Render build filter, the Render health check path, the client Sentry DSN; docs/dev.md's Render section records them) and are not asked for again.
1. vercel-ignore first, alone, so its squash rides in the step 4 push. Done 2026-10-28: merged as d91b8c7f (receipt 8447022; the Amendments section).
2. The step 4 push, on Dallas's cue: everything unpushed since 2026-10-27 plus vercel-ignore's squash and this plan, through npm run gate and a literal-sha push (the legacy path; the pre-push hook runs the money smoke and the client build since server/ and client/ change). The shipping session states the inventory in one line first (the counts by top-level directory), then watches Render's deploy and Vercel's build by hand and records both in the ledger. This is a real deploy of step 4's work: header comments over 563 source files, the generator, the migration tool, the merge script, the hook.
3. The evidence push, on Dallas's cue: one docs-only commit (docs/dev.md's Vercel section gaining the two operator notes the vercel-ignore review deferred; this plan's rev 5 rides in the step 4 push instead) pushed alone, DONE 2026-10-29 as 42af5ef1: Vercel cancelled it in 5 s (the ignore script's line in its log), Render did NOT skip it (deploy dep-dbhedpavcj2c73fvvd30 ran), so the Render half stays open on the dashboard's build filter, which only Dallas can read, and does not block the step (an extra two-minute server deploy per docs-only push until it is right); right after the step 4 deploy is live. Expected: Render skips the deploy (the build filter), Vercel's deployment is cancelled by the ignore step (its log line names the docs-only diff); the shipping session records both. A build on either side is a failed check and stops the step until its cause is known.
4. The core first (rev 6): release-field, sensitive-list, invariants-manifest and merge-check in parallel (cut 2026-10-29 from 42af5ef1); claudemd-rewrite after invariants-manifest; merge-ship after merge-check.
5. The hardening lanes after the core, in any order their blockers allow: receipt-cap, gate-markers then log-retention, board-writer, stale-files, design-agents after claudemd-rewrite, lint-errors after release-field, comment-followups if asked for.
6. (folded into 4 and 5)
7. The flip, when every lane of 4 to 6 is merged: npm run gate, the literal-sha push on Dallas's cue (the inventory stated first), origin confirmed, the marker written (drb-flip.json: sha, pushed_at, written_by), lane:status read back, the memory archive, the global file's transitional line removed with its .bak. The rollback until the legacy-removal ship: delete the marker, restore the global file from the .bak (decision 18).
8. rehearsal after the flip: the dry run, the real ship, the revert ship, with Dallas watching (the ship-resume lane merged before the flip, rev 9).
9. legacy-removal after the rehearsal, shipped through ship.

Revert in reverse dependency order.

## Contracts shared across lanes

**merge-lane.sh check and ship.** The spec's 4.1 as the interface, the step 4 script as the base: the union of the squash's own paths, the snapshot taken from merge-tree, the guard, the scoped reset judged against the snapshot, the prose rule, the private-index commit landed by commit-tree on the pinned HEAD with a compare-and-swap on main, the put-back of a lane path another window unstaged during the hook, a doc left staged for another window rendered against HEAD, MERGE_LANE_COMMIT handed to the generator, the wait on another git's index.lock, the three nothing-to-merge refusals, the hash check, the render that runs at most twice; the step 4 report and the merge-docs-split lane's amendment in the step 4 plan are the behavior to keep (its two review rounds added: the file-and-directory conflict labelled as the squash labels it; an empty tree refused before the hooks, the third nothing-to-merge refusal; main checked right before the squash and the own set and snapshots planned again against the head the squash merged onto; a lock wait of thirty seconds that the generator's staging reads too; a render that could not be staged discarded at the refusal, only inside the generated sections; a window's plain commit that carried the squash, in full or in part, named at every refusal and once more after the reset; the step 4 plan's rev 12 amendment is the record of the final shape). check prints one of ready, ready-moved, stale <files> [sensitive], refused <reason>, exits 0 for the first two and 1 for the others, and changes nothing. ship takes the ship lock through flockExec with the DRB_SHIP_LOCK guard, re-runs check, squashes, on ready-moved re-runs the receipt's suites on the merged tree, lands the commit as step 4 does with the 3.7 block in its message (the receipt tool's block command renders it), writes the squash receipt through the receipt tool (kind squash, the patch id of parent..commit with the generated docs excluded), calls shipFlow with the lock held and --no-push passed through, releases the lock after the push, starts the watch detached outside the lock, and after the push removes the worktree, runs the three merged-lane checks (generated docs excluded) and deletes the branch, each a log line in <git-common-dir>/drb-ship/<sha>.log; the phase runs in the background; before the marker exists, ship stops after the commit and prints the cue-only line, which is how every lane of this plan but the last two merges. --resolved: the squash is skipped, the index must hold exactly the lane's union plus the resolution, the prose reference is the resolved docs.

**The release field.** /api/health returns {status, release} where release is process.env.RENDER_GIT_COMMIT when set, else absent; Sentry.init gets release: the same value when set. The watch already reads the field (step 3).

**The ignore command.** client/scripts/vercel-ignore.sh, run by Vercel from client/: with VERCEL_GIT_PREVIOUS_SHA set and non-empty, `git diff --name-only <that sha> HEAD` (git resolves the repository from client/; the paths come back repo-relative); exit 0 (cancel the build) when every path is under docs/ (excluding docs/money-laws.md and docs/runbooks/) or is README.md or ARCHITECTURE.md; exit 1 (build) otherwise, on an empty or unset variable, on a previous sha the clone does not hold (refused before any diff, as built), on an empty diff (a redeploy, as built), on a diff that fails, and on any other git failure; one stdout line either way naming the reason. The test sets the variable by hand in throwaway repos.

**The sensitive list's sections.** A section header is a line `# section: <name>` with <name> one of hinge, auth-and-pii, client-money-surfaces, money, the matcher's names (any other line opening with `#` is a comment, and a line that looks like a header attempt but is malformed throws); hinge comes first and money last, so a block appended at the end of the file lands in money; the header's role sentence stays a comment above the first section. The hinge set inside the list is sensitive-listed too, so lane-status's stale flag and the review's overlap pass fire when a hinge path lands on main (the list's header says so, rev 7). The receipt's matched-paths report names the section a path fell in, which the matcher already returns.

**The receipt cap.** finalize refuses: a finding with verdict confirmed and no fixed or rejected mark; a position whose brief is a third fix re-pass (the store counts the briefs after the first full pass that carry a fix). The store refuses a malformed report (exit 1, nothing stored). A fixed mark clears when the raising lens's latest pass lists the file as pass, or lists it as finding with every finding of that pass on that file rejected.

**The markers' three rules, the docs check and retention.** As the gate-markers and log-retention lanes say; the sweep's bounds are decision 7; the docs check is `node scripts/gen-docs.js --check --ref <sha>` on the gated sha.

## The invariants manifest's keys and their fates (spec 6.3)

Kept as they are, because the rewritten file carries the matching line: code-preservation; explicit-staging; no-add-dot; no-reset-main; no-amend-pushed; destructive-approval; push-fail-stop; design-review-fleet (its pattern already matches "review skill", the one pointer line that stays); stripe-test-mode; stripe-fails-closed; hosted-bartender-ratio (the hosted line keeps its pointer to isHostedPackage); gratuity (its pattern already matches money-laws, the pointer the three gratuity lines carry); proposal-payment-status; money-cents; doc-updates. Reworded: encryption-pii, whose pattern gains `encryption\.js` beside AES-256, since the rewritten line says "bank PII through encryption.js". Retired: none. Added, for invariants 6.3 keeps that the manifest never covered: os-on-main (`never leaves main|stays on main`), one-connection (`one pooled connection`), dev-live-stripe (`live Stripe`), receipt-required (`review receipt`). The check then reads 20 keys. (As built, rev 7: 37 keys at the manifest lane's merge and 46 after the rewrite lane's, each Amendments entry below naming its additions; the gratuity and design-review-fleet patterns no longer accept a pointer line alone, by the manifest lane's review.)

## Lane sections

Each lane's acceptance checks are a command or a read with a stated pass condition, run by the controller from the worktree; the implementer pastes its own run. Every lane also passes the standing checks: the suites it names green from TAP (`# fail 0`), `node scripts/gen-docs.js --check` exit 0 at the tip, em dash count 0 over its changed files, the diff inside the footprint.

### Lane: release-field

1. The health suite from TAP: with RENDER_GIT_COMMIT set in the test's environment the response carries `release` equal to it; with it unset the response has no `release` key; `# fail 0`.
2. The dev server (the controller's) with the variable exported: `curl -s localhost:5000/api/health` shows `release` equal to the value; restarted without it: no `release` key, `status` unchanged.
3. `git diff main..<tip> -- server/index.js` touches only the health handler and Sentry.init (a read; no other hunk).
4. The money smoke on the first and final tips: every suite green, read from the smoke summary.

### Lane: vercel-ignore

1. `node --test --test-reporter=tap scripts/vercel-ignore.test.js`: the docs-only range exits 0 with the cancel line; the mixed range, the hinge-doc-only range, the multi-commit range whose tip is docs-only but whose earlier commit touches client/, the empty variable and the sha outside a depth-limited clone each exit 1 with the reason line; `# fail 0`.
2. `node -e` parses client/vercel.json; it holds one `ignoreCommand` naming `bash scripts/vercel-ignore.sh`; `git diff main..<tip> -- client/vercel.json` is that one line.
3. The real run: the evidence push (Order 3) shows the Vercel deployment for the docs-only sha cancelled by the ignore step, the cancel line in its build log, recorded in the ledger.

### Lane: sensitive-list

1. `node --test --test-reporter=tap scripts/sensitive-match.test.js`: a case per section header (a path under each reports that section), the malformed-header refusal, the hinge section computing tier hinge; `# fail 0`.
2. The tier comparison script over `git ls-files` at the base and the tip, pasted: 0 paths lowered; the count raised; every D11 path reports section hinge and tier hinge unless a heavier section also names it (13 do, tier A by the heaviest-section rule; rev 7); every addition reports section money.
3. Every added pattern matches at least one tracked path (the lane's script prints the unmatched patterns: none).
4. `grep -c "conflict-escalation\|auto-pull" scripts/sensitive-paths.txt` is 0; the header's first sentence says the list scales the review tier.
5. `node scripts/review-select.js --base <base> --tip <tip>` on the lane computes tier hinge (rev 7: no file of the lane is in a tier A section; rev 2 wrote tier A).

### Lane: lint-errors

1. `npx eslint server/` exits 0 with no-unused-vars at error; or, when the rule stays a warning, the report's first line gives the count of non-mechanical violations and eslint.config.mjs is unchanged.
2. A read of `git diff main..<tip> -- server/`: every hunk deletes an unused binding or renames it with an underscore prefix; no function signature, destructuring shape or export changes; none of the three excluded files appears.
3. `node scripts/run-suites.js --changed <base>..<tip>` green from the summary; the smoke when a sensitive file is touched.

### Lane: design-agents

1. A grep over the seven files for `check-docs-drift`, `Mentioned in CLAUDE.md`, `commit rule 3`, and the old section headings the rewrite removes (Mandatory documentation updates, Environment Variables, Push model, Review model, Reasoning effort): 0 hits.
2. The count of numbered checks per file is equal at the base and the tip (a read of each file's check list).
3. `/review-spec` and `/review-plan` run once on this plan after the merge; each returns a verdict.

### Lane: invariants-manifest

1. `bash scripts/check-claudemd-invariants.sh` on the tip's manifest against today's .claude/CLAUDE.md prints OK with 20 invariants.
2. For each of the 20 keys, a copy of today's file with that rule's line removed makes the check print MISSING naming that key (a loop pasted in the report).
3. The manifest's header names the date and the four new keys with their provenance (spec 6.3).

### Lane: claudemd-rewrite

1. `bash scripts/check-claudemd-invariants.sh` on the tip prints OK with 20 invariants, and the lane's own commit passed the hook (the commit exists).
2. `wc -l .claude/CLAUDE.md` under 160.
3. The side-by-side table in the lane report, old section by old section: every rule in the new file, in a file the new file points at, or named as retired; the controller reads it against the old file.
4. grep: `TRANSITIONAL` exactly once (the dated line of decision 17); `Push model`, `Reasoning effort`, `Tech Stack`, `Mandatory documentation` 0; `File-size` at most one pointer line; `Dallas` only inside provenance brackets.
5. docs/money-laws.md holds the gratuity paragraph verbatim (a diff of the paragraph against the old file's).

### Lane: receipt-cap

1. `node --test --test-reporter=tap scripts/lib/receiptFinalize.test.js` and `scripts/review-receipt.test.js`: a confirmed finding left open refuses by name; a third fix re-pass refuses; a malformed report refuses at the store with exit 1 and nothing stored; a fixed mark clears when the later pass's findings on that file are all rejected; `# fail 0`.
2. The step 4 merge-docs receipt directory (key 37964654) copied into a throwaway common dir and replayed through finalize with the twelve rejected-with-fix marks changed to fixed: finalize accepts (the replay script pasted).
3. The skill's sections 6, 8 and 9 read against the tool's usage header: no line disagrees.

### Lane: gate-markers

1. The markers and sha-gate suites from TAP: a superseded failure kept until a passing gate on a descendant; a failure whose sha left main requires every named check; a marker with no gates list reads as every check; the docs check on a sha with a stale section fails the gate naming the section, and passes on a current one; `# fail 0`.
2. The gate run in a scratch clone against a sha whose README is stale: the gate fails naming gen:tree; against a current sha: passes.
3. The money smoke on the first and final tips.

### Lane: log-retention

1. The shipLog and sha-gate suites from TAP: raw logs older than 30 days removed at the next append, the latest record's log kept; smoke-log directories beyond the last 20 removed at the next gate, the latest kept; `# fail 0`.
2. A throwaway drb-ship directory with 25 dated logs and one append: the newest 20 plus the new one remain and the latest record's log is among them (a listing pasted).
3. The money smoke on the first and final tips.

### Lane: board-writer

1. `node --test --test-reporter=tap scripts/board-write.test.js` over a local bare remote: a fetch and fast-forward-only merge; a refusal when main cannot fast-forward; one board line after a rejected push and its retry refusal; a refusal before any write when os has a staged or edited file; `# fail 0`.
2. `head -5 scripts/board-write.sh`: the header comment first, the set line below it; the header carries the long-timeout instruction.
3. `grep -c "git pull" scripts/board-write.sh` is 0 outside comments.

### Lane: stale-files

1. `git ls-files .comms-sms-contract.md .plan-2-contract.md` prints nothing at the tip.
2. `grep -rl "comms-sms-contract\|plan-2-contract" --exclude-dir=node_modules .` names only history files (plans, specs, the lens audit).
3. `node scripts/gen-docs.js --check` exit 0 (the tree regenerated).

### Lane: merge-check

1. `node --test --test-reporter=tap scripts/lib/mergeCheck.test.js`, `scripts/merge-lane.test.js` and `scripts/merge-lane.docs.test.js`: ready; ready-moved; stale with the overlap list; stale with the sensitive flag; refused for no receipt, a lower tier, a short file list, a recorded tip behind the branch tip (recorded_tip..tip named), a staged change in os; an unstaged edit outside the lane's paths allowed and inside refused; `# fail 0`.
2. `bash scripts/merge-lane.sh check <branch>` for each of the four pre-flip lanes in a scratch `git clone --shared` of os (read-only on the real lanes): the printed line for each pasted (stale for the three the step 4 report says conflict in the docs; the fourth ready-moved or stale).
3. check changes nothing: `git status --porcelain` and `git rev-parse HEAD` and the index file's sha256 equal before and after each run.
4. The receipt lookup finds a real step 4 receipt by key and by branch in a scratch common dir.
5. `bash -n scripts/merge-lane.sh`; the money smoke on the first and final tips; finalize at --tier A with verify and the externals recorded.

### Lane: merge-ship

1. The mergeShip suite and both merge-lane suites from TAP, over throwaway repos with a local bare remote: with the marker absent, ship stops after the commit and prints the cue-only line; with the marker present and --no-push, the gate runs and nothing is pushed; with the marker present, one squash commit with the 3.7 block, one push, one watch record, the worktree removed, the three merged-lane checks logged, the branch deleted; a conflict stops with a clean index naming the files; a push rejection stops and reports; the marker refusals; ready-moved re-runs the receipt's suites before the gate; the squash receipt's key is the patch id of parent..commit without the docs; the step 4 race cases through ship with nothing lost; `# fail 0`.
2. A throwaway ship's progress is in `<common>/drb-ship/<tip>.log` (keyed on the judged lane tip, with its phase manifest under `phase/`), read after the run; the ship process ran detached (rev 9).
3. The serialization case: a second ship queued behind the first waits; the watch holds no lock descriptor and outlives the lock holder (shipFlow spawns it as its last act and the lock is released right after, rev 9).
4. `bash -n`; the money smoke on the first and final tips; finalize at --tier A.
5. The real run is the rehearsal.

### Lane: legacy-removal

1. `node --test --test-reporter=tap scripts/push-gate.test.js`: every sha-mode case green; the fingerprint cases gone; `grep -c fingerprint scripts/push-gate.js` 0 outside the header's history line.
2. package.json has no `gate` script; `.husky/pre-push` has no fallthrough (a read).
3. The board writer's only-unpushed-commit guard gone (a grep) and its suite green.
4. `.claude/CLAUDE.md` holds no TRANSITIONAL line; the invariants check prints OK.
5. `node scripts/gen-docs.js --check` exit 0 (the scripts table regenerated).
6. The ship of this lane, watched, its log and the watch's record pasted in the step report.

### Lane: rehearsal

1. The proof over the lane says comment-only yes for server/utils/pricingEngine.js; the receipt kind is comment-only.
2. The dry run, `merge-lane.sh ship <branch> <plan> --no-push`: the log shows the gate's result and the squash receipt written; origin/main is unchanged.
3. The real ship (the same command again, which resumes the dry run's squash, rev 9): origin/main at the squash sha when nothing landed on main in between; `/api/health` on the production host shows `release` equal to it within the watch's bounded wait; the Vercel half skipped (no client change); the watch's Sentry line pasted ("no new events in ten minutes" or the count).
4. The revert ship: ship recognizes the clean revert, writes a revert receipt, pushes; the watch's record pasted.

### Lane: comment-followups

1. The proof says comment-only yes for the three source files.
2. grep for the deleted env table's name in the two code comments: 0; `head -5 scripts/guard-os-main.sh` shows the header before the set line; the comments at `server/utils/refreshDisplayName.js:40` and in its test point at the rules file's Invariants section instead of the removed Coding patterns heading (rev 7, from the rewrite lane's review).
3. `npm run docs` twice changes nothing.

## What the plan fleet changed (rev 1 to rev 2), and revs 3 to 9

Rev 9 (2026-10-29, no fleet run): the merge-ship lane as built (the Amendments entry); decision 25; merge-ship's acceptance checks 2 and 3 and the rehearsal's check 3 reworded to what was built; the ship-resume lane (the four reachable findings of merge-ship's third review pass, split under the review bar) added to the front matter and the Order, before the flip.

Rev 8 (2026-10-29, no fleet run): the merge-check lane as built (the Amendments entry); its acceptance check 2 reworded (the refusal names the lane's own commits since the recorded tip; the three pre-flip lanes' expected stale answer now comes only through a sensitive landing or a code overlap, since the two docs are set aside, a note the lane report carries); the merge-ship lane's footprint gains the .env.example row and the carried items from the merge-check reviews (its brief's two added sections); the merge-ship lane cut from main.

Rev 7 (2026-10-29, no fleet run): decision 4's and the contract paragraph's section names as the matcher has them (hinge, auth-and-pii, client-money-surfaces, money, hinge first); the sensitive-list lane's acceptance checks 2 and 5 as built; the keys paragraph's as-built count; the comment-followups lane's one more pair of comments; the Amendments entries for sensitive-list, css-scope-suite, claudemd-rewrite and release-field, and the merge-order note.

Rev 6 (2026-10-29, no fleet run): decisions 23 and 24 and the Order's core-first steps 4 to 6; decision 22 narrowed to merge-ship; the sensitive-list lane's lens line corrected to the computed hinge; the manifest lane's and the rewrite lane's footprints as built and as needed; merge-check unblocked from receipt-cap with its sibling suite; Order step 3's evidence push recorded; the Amendments entry for invariants-manifest.

Rev 5 (the same day, no fleet run): the vercel-ignore lane as built (the Amendments section), the sensitive-list lane's scope and footprint gaining the ignore script's hinge entry and header line, the contract paragraph's two corrections, the Order's steps 1 and 3.

Rev 4 (the same day, no fleet run): Dallas's answers of 2026-10-28 recorded in decision 9, the Order's step 0 and the status line; the comment-followups lane loses the payment-handle item and the Venmo parser's file, its two checks and lint-errors' held-files note follow.

Rev 3 (the same day, no fleet run): the last step 4 lane merged, so the merge contract names its final shape (three nothing-to-merge refusals; the generator's staging on the merge's lock budget; the discard of a failed render; the carried-by check at every refusal, in full or in part) and the merge-check lane takes that lane's two deferred minors that touch the check phase.

Fidelity returned four blockers and eleven warnings, decomposition one blocker and twelve warnings; every finding was read against the spec and the repo (the matcher's header form, the ship command's flags, Vercel's documentation on the ignore step, the root directory and the clone depth, the unpushed range's size, the cut list's files). Folded: acceptance checks for every lane (the cross-confirmed blocker); the manifest keys' fates; the ignore rule over the deployed range with the script under client/; the step 4 push before the evidence push and the six cues named; the matcher's section form and the hinge tier kept; log retention split out of the marker rules; the whole-tree docs check in the gate; one owner for the transitional block and the flip's rollback; the two stale root files; the 3.8 and 3.11 rules in merge-check and merge-ship (the recorded tip, ready-moved's suites, the watch outside the lock, background execution, --no-push, 4.6's dirty-tree rule); README.md in the footprints that add a library file; lint-errors sequenced after the two lanes whose files it could touch; board-write.sh out of comment-followups; blockedBy lane ids only; the pre-skill commits taken as given; the deferrals named in the last section. Not folded: the wider Vercel rule (named in decision 1 for Dallas); the .test.js staleness relaxation (deferred, decision 6); the Render-filter mismatch (deferred, decision 20).

## Amendments (lanes as built)

- **vercel-ignore** (merged 2026-10-28 as d91b8c7f; receipt 8447022, tier hinge; lane report `lane-report-vercel-ignore.md` beside the step 5 ledger). As built: `client/scripts/vercel-ignore.sh` (96 lines, `set -u` only) reads one variable and judges in this order: the variable unset or empty builds; no repository builds before any diff (outside a repository `git diff a b` becomes `--no-index` over two file paths); a value that is not a 4-to-64 hex string, or not a commit the clone holds, builds (revision syntax and option-shaped values never reach the diff); `git -c core.quotePath=false -c diff.relative=false diff --name-only --no-renames <sha> HEAD` failing builds with the exit code on the line; an empty diff builds (a redeploy of the same sha is a person asking for a build, my ruling); then a bash case judges every path (`docs/money-laws.md` and `docs/runbooks/*` off, `docs/*` on, `README.md` and `ARCHITECTURE.md` exactly, everything else off), the first path off the list builds naming it, and all on cancels naming the count. `client/vercel.json` holds `"ignoreCommand": "bash scripts/vercel-ignore.sh"` as its first key, the rest byte-identical. `scripts/vercel-ignore.test.js` (233 lines, 18 cases in throwaway repos with the script run from `client/` under `GIT_CEILING_DIRECTORIES`): the plan's six, plus the unset variable, a redeploy, lookalike paths, a rename out of client/, a deleted doc, no repository, a space, a non-ASCII name, a path git quotes, `diff.relative` in the config, and non-sha values with a leak check. Review: three lenses (access-egress, seams, client; schema-data did not fire), 6 low findings raised, 0 confirmed, 6 deferred under the bar: a failed here-string redirection would skip the loop and cancel with 0 files (its trigger is a container with no writable temp directory at all, since bash falls back from TMPDIR to /var/tmp and /tmp; a guard that the count equals the line count is the one-line hardening for the next lane that touches the script); the allowlist is a hand copy of the matcher's with no agreement test (the two agree on the lenses' 22 paths; a suite case through `isDocsOnly` is owed); the script decides whether the client deploys but computes tier C and sits outside the content rule's roots (the sensitive-list lane adds it to the hinge section and re-points its header, above); a dashboard change (an env var) followed by a docs-only push is cancelled, and a redeploy of a cancelled docs-only row is cancelled again, so docs/dev.md's Vercel section gains two operator notes (redeploy the current deployment after a dashboard change; redeploy the current row, never the newest cancelled one), which is the evidence push's docs-only commit. The contract paragraph is corrected above to what was built. Acceptance check 3 (the real run) is the evidence push.
- **sensitive-list** (merged 2026-10-29 as 3b7eb1e5; receipt 1913711a, tier hinge; lane report `lane-report-sensitive-list.md`). As built: the list's header says it scales the review tier and nothing else and that the hinge set inside it is sensitive-listed too (the stale flag and the overlap pass fire on a hinge landing); four `# section:` headers, hinge (27 patterns, the D11 set verbatim) first, then auth-and-pii (20), client-money-surfaces (7) and money (201, the 25 globs the calibration script carried now list rows, the script still holding its copy), so a block appended at the end lands in money; the matcher's HINGE_PATHS constant is gone, `hingeRegexes` reads the list's hinge section, `isSensitive` covers it, `matchDetailed` reports a path's section, a malformed header throws; six suite cases (a case per header, the real list's headers exactly once in order, an appended pattern landing in money, no hinge pattern matching a code path); the ignore script's header re-pointed. Laws proved over 2591 tracked paths: 0 tiers lowered, every added pattern matching a tracked path; 13 D11 paths report tier A because a heavier section also names them. Review: five lenses over two positions, 10 findings, 3 fixed (hinge first with three cases; the header naming the stale-flag widening; the additions' comment), 7 deferred to the lane report; 26 suites and the client build green at finalize. This squash is the flip commit's content (decision 14).
- **css-scope-suite** (a repair lane outside this front matter; merged 2026-10-29 as 1f0b04c2; receipt df0f7bd2, tier hinge, failing test `scripts/check-css-palette-scope.test.js:2`; lane report `lane-report-css-scope-suite.md`). Why: that suite had failed on main since fb9bae0b (2026-10-06), so the review's reached-suites record was refused for release-field (a red run is never recorded) and merge-ship's ready-moved re-run would have hit the same wall. As built: check B of `scripts/check-css-palette-scope.js` records each admin colour override's ancestor classes and credits coverage only when the legacy rule's own selector carries them (a same-ancestor or bare twin still covers); two cases gained assertions. The real stylesheet's 83 candidates give the same verdicts before and after. Reviewed twice: three lenses (five lows deferred: the context is class-only, a comma-list rule's first part, specificity ignored), then, because the sensitive-list squash landed first and the merge-time check reads that as stale, rebased and reviewed again with the unchanged verdicts re-stored and seams as the overlap pass. The merge order lesson: a sensitive landing on main restales every open receipt without overlap, so finalized non-sensitive lanes merge before a sensitive one, a lane mid-review rebases before its last re-pass so that pass is also the overlap pass, and the two sensitive lanes (release-field, merge-check) merge last, one after the other.
- **claudemd-rewrite** (merged 2026-10-29 as ccab95fc; receipt 00651788, tier hinge, --stale-base; lane report `lane-report-claudemd-rewrite.md`). As built: `.claude/CLAUDE.md` at 117 lines in the four sections of spec 6.3, every rule about working with Dallas bracketed, the old reference sections gone and their load-bearing lines promoted to invariants, one dated TRANSITIONAL line for the cue-only pushes (legacy-removal removes it), the public-repo PII rule as its own line; the manifest at 46 keys (dev-live-stripe, six keys for lines the first review found uncovered, gratuity-rate and gratuity-election); ARCHITECTURE's review pointer at the review skill. Review: two lenses over three positions, 16 findings, 11 fixed (eight wordings and six keys, the code-preservation and review-line brackets, the error rule's one allowed surfacing), 5 deferred or split; one finding raised at the third pass (the live-Stripe line's bracket covering the gate-worktree clause, a Claude default of 2026-10-22) split to a quick fix on main right after the merge with two wording gaps (line 43's rejection reason, line 44's role-guard overstatement). Decision 17's one-owner rule holds: the transitional block is gone and the one dated line remains.
- **release-field** (merged 2026-10-29 as 84048c43; receipt 0198b603, tier A, --not-a-fix; lane report `lane-report-release-field.md`). As built: `Sentry.init` spreads `release` from RENDER_GIT_COMMIT only when the variable is truthy, and the health handler spreads the same field into the 200 and the 503 bodies (a degraded instance names its build too; the watch and Render's health check decide on the status code); `server/index.health.test.js` boots the real index.js in a child on a free port with initDb swapped for a no-op, polls up to 30 seconds for a 200 (the dev database's cold start), and pins both cases with strict deep equality. Review: the six floor lenses collapsed into one agent on the two-file diff, verify, the externals (codex not run for want of credits; gemini NO FINDINGS); nothing confirmed; verify's three notes (the empty-string arm untested, the probe unpinned, the missing .env.example row) deferred, the row landing as a docs quick fix after the merge. The acceptance check on the real deploy is the first ship's watch log: Render must supply the full 40-character sha, and a reading of release absent means the variable is not reaching the process (never asserted from the box).
- **merge-check** (merged 2026-10-29 as 9e0ee5b7; receipt d060111b, tier hinge, --stale-base, --not-a-fix; lane report `lane-report-merge-check.md`). As built: `scripts/lib/mergeCheck.js` (652 lines) holds `checkLane` (the receipt found by branch or by the lane key; a recorded tip that is not the branch tip must hold the reviewed diff byte for byte, a verbatim patch id of the recorded base..tip against base..tip with the two docs excluded, a missing or unresolvable recorded tip or base refusing, a docs-only post-review range exempt; the tier recompute and the sensitive-landing flag read main's list through ls-tree and cat-file into a temp copy; the list beside sensitive-match.js, the copy the deep judge reads, must equal main's blob byte for byte, checked before the judge and again before any non-refusal answer; the deep judge through rangeCheck; stale when a lane file moved on main or a sensitive path landed; settle re-reads main and the staged status before answering; the recorded-tip refusal names the lane's own commits since the recorded tip and their tier, in result.unreviewed), `mergedLane` (the squash on main by subject; every lane file byte-identical, README.md and ARCHITECTURE.md compared outside their generated sections through the generator's own markers; the worktree gone) and `lock` (the positional squash form re-executed under the ship lock through flockExec, a nested run trusted only when MERGE_LANE_LOCKED equals the parent pid; .git/merge-lane.lock retired); `scripts/merge-lane.sh` (1198 lines) dispatches check and merged at any argument count and refuses a lane named check or merged; exit 0 for ready and ready-moved, 1 for stale and refused, 2 for usage; one stdout line. Suites: `scripts/lib/mergeCheck.test.js` (23), the new sibling `scripts/merge-lane.check.test.js` (12), `scripts/merge-lane.test.js` (22, its serialization case started after the first merge's hook marks the lock held); docs/dev.md's merge lines. Review: six lenses over three positions, two fix rounds (eight commits, then four), 14 confirmed findings fixed and closed by their lenses, the rest deferred to the lane report; the third position doubled as the overlap pass after six commits landed on main. Check and merged run on real lanes already: merged agreed with the three hand checks on this lane's own squash.
- **merge-ship** (merged 2026-10-29 as 8781a200; receipt 4f85e507, tier A, --not-a-fix; lane report `lane-report-merge-ship.md`). As built: `merge-lane.sh ship <branch> <plan> [--no-push] [--resolved] [--foreground]` in `scripts/lib/mergeShip.js` with its concerns in `mergeShipSquash.js`, `mergeShipLog.js` and a testkit: the argument parse and the wrapper's own line for a silent stop; the locked foreground (the ship lock, the prior run's log moved aside, the resume check, the --resolved index checks, checkLane, the pre-merge refusals including shipFlow's own precheck with the marker present and the comment-only key computed ahead, one stdout line, the run spawned detached with the lock on fd 3); the detached run (the lock proved, the re-judge, the squash through the shell's positional form with the re-run environment scrubbed, the ready-moved suites on the merged tree, the squash receipt under the patch-id key, cue-only without the marker, else shipFlow then the release and the cleanup after a push); the phase manifest lane:status prints; the check CLI's merged answer. The shell flat at 1199 lines. Review: eight lenses, verify and gemini over three positions, two fix rounds, 51 findings (38 fixed, 10 split to ship-resume, 3 deferred or unreachable); the 18 reached suites and the smoke green at the final tip. Decision 25 records the resume and the dry run.
- **invariants-manifest** (merged 2026-10-29 as 109763d5; receipt a73b16e0, tier hinge; lane report `lane-report-invariants-manifest.md`). As built: `scripts/claudemd-invariants.txt` at 37 keys (the 16 kept, encryption-pii reworded, os-on-main, one-connection, receipt-required, never-scrap and ships-after-gate added, sixteen auth, data and code keys added for the inline-self-check lines 6.3 turns into rules; stripe-fails-closed, gratuity, design-review-fleet, receipt-required, os-on-main, push-fail-stop, pricing-engine, secrets-env and legal-hold tightened at the review so that a pointer line the rewritten file must carry cannot stand in for a dropped rule; dev-live-stripe left to the rewrite lane since today's file has no line for it); `scripts/check-claudemd-invariants.sh` rewritten: its repository top is the parent of its own directory (a walk from scripts/ named scripts/ as the top under the GIT_DIR git hands a hook in a linked worktree, which would have refused every lane commit that stages CLAUDE.md), an `--additive-against <ref>` mode in which both manifests come from git (the ref's and the index's copy the commit is made from) and a removed or changed key refuses, so a commit that stages the rules file may only add keys and a pattern change lands in a commit of its own (spec 6.3's before-not-with rule, mechanical), and refusals of a malformed manifest (an empty pattern, a pattern matching an empty line, one grep cannot parse, no key at all); `.husky/pre-commit` passes `--additive-against HEAD` and its refusal line names the three cases; ARCHITECTURE's hook sentence and README's tree line follow. Review: tier hinge, five lenses over three positions (access-egress and seams, then concurrency, outcomes-providers and schema-data fired by the manifest's own pattern text and the script path), two fix rounds by the controller, everything raised closed or recorded in the lane report. Deferred, for the lane report: a pointer description that names gratuity satisfies the gratuity key; the per-key removal test is the lane report's, not a suite; the legal-hold key holds today through a Tech Stack sentence.

## Report back

When the lanes are done: one line per lane (what landed, the squash sha, the report file, the receipt key); the twenty-two decisions restated for Dallas to reverse; the step 4 push's and the evidence push's observations; the flip push's sha and the marker; the rehearsal's three logs and the watch's records; the legacy-removal ship's log; the memory archive list; what the four pre-flip lanes now need; the deferred items for his list; any check that did not pass as a failure with its output.

## Test plan

Scripts and prose; the sibling suites per lane plus the acceptance checks; the real runs are the step 4 push, the evidence push, the flip push, the rehearsal's three ships and the legacy-removal ship, each with Dallas's cue and, for the last five, with him in the window.

## What this step does not do

The within-section trim of kept prose (step 4 decision 10) and the 300 placeholder headers stay on Dallas's list. Deferred, named: the review skill's .test.js staleness relaxation (its own tier A change later; decision 6); rangeCheck.js's re-proof of a comment-only receipt at push and the Render-filter mismatch on hinge docs (decision 20); the two ship.js edge cases the step 3 report named (a hard kill with a dropped connection and a queued push can mislabel a push that landed, never a wrong push; a stop sent to a foreground push's outer process alone reports exit 1 while the record is right); the docs' prose riding outside every receipt key (by design: README.md and ARCHITECTURE.md are excluded from the key, so a prose edit alone carries no receipt; Dallas's call whether that stands); RUN_VA_CALLING_SCHEDULER declared twice as an active line in .env.example (a tier A lane for one line; taken when another tier A change touches the file); the masking generator's deferred list (a run cut by the type cut; the schema's one-line column list; a mask token in plain markdown; the allowlist's working-tree sources); the review-tooling notes of the step 4 report beyond what receipt-cap takes (a dispatch prompt must carry the brief's id form; a position run by hand invalidates a report read at the earlier snapshot). The walkthroughs-owed file's fate, the Node 24/26 mismatch, the ledger-closing-by-commit idea and the lighter audit of the design agents stay open questions (spec section 10). The project plan skill that replaces writing-plans and subagent-driven-development (D15) is after the flip, its own plan. The prod findings of the lens audit's section 9 are Dallas's to place on the ledger.
