---
name: review
description: The per-lane review that writes a receipt (spec 2026-10-19 section 3). Run it before every lane merge, on a staged quick fix before its commit, and on a commit already on main with no receipt. Trigger words review, review the lane, run the review, per-lane review, review receipt, quick-fix review, review --commit, properly reviewed.
---

# Review

The procedure a session follows to review one change and write its receipt, in the order the plan gives (plan 2026-10-20, lane review-skill), over the scripts merged in step 2.

## Rules

### Before the review

- The scripts are the mechanism and their usage headers name every flag: when a script and this file disagree, the script wins and this file is corrected in the same lane. [Claude default]
- Review is standing: run this skill on every lane before its merge and on every quick fix before its commit, without asking; the computed tier sets the proportion, never a question to Dallas. [Dallas 2026-08-28]
- In what follows, <wt> is the checkout under review (the lane's worktree, os for a quick fix), <branch> the lane branch, <base> the full sha of git merge-base main <branch>, <tip> the full sha of the branch tip, <plan> and <spec> the plan and spec paths, <name> and <work> the working name and directory init prints (<work> is <git-common-dir>/drb-review/_work/<name>/), and <rr> stands for node <wt>/scripts/review-receipt.js. [Claude default]
- Lane mode is the default and its base is current main: rebase the lane onto main before init when main has moved, as standing practice, and never while a review is open (stale-base below covers main moving during one). [Claude default]
- Before init the lane is checked out in exactly one worktree with nothing staged, changed or untracked, because position and every store refuse a dirty checkout and name only the counts. [Claude default]
- Every file the review writes (select.json, static.json, run dirs, logs, lens reports, captures) goes under <work>, never into the checkout, and nothing is committed in the lane while a lens runs. [Claude default]
- Run each script as the lane's own copy (node <wt>/scripts/...) at the tip, never from os for a lane, because review-select reads the reached suites from the working tree of the repo the script lives in. [Claude default]

### 1. Open

- Open the review with `<rr> init --branch <branch>`; it prints the name and the dir, and it refuses when a review of that name is already open (finalize it, or remove its directory to start over). [Claude default]

### 2. Select

- Select with `node <wt>/scripts/review-select.js --base <base> --tip <tip> --plan <plan> --lane <lane id> > <work>/select.json`, where <lane id> is the lane's id in the plan's front matter; leave out --plan and --lane together when the branch is no plan lane. [Claude default]
- review-select exits 1 on a refusal with one stderr line, which names a path by its index in git diff --name-only -z --no-renames <base> <tip> order (count there, never print the list), and exits 2 for a ref that names no commit. [Claude default]
- select.json carries the tier, the lenses with fired_because and forecast, externals, verify, tests (smoke, suites, client_build), collapse and unforecast_lenses; the computed lens set is binding and the plan's lens list is only a forecast. [Claude default]
- Tier docs selects no lens and no test: the review is init, select, the pre-step and finalize. [Claude default]

### 3. Pre-step

- Run `cd <wt> && node scripts/static-checks.js --base <base> --tip <tip> > <work>/static.json`, which reads the repo of its working directory; exit 1 means at least one blocking finding (a check that did not run blocks too), and exit 2 is argv misuse. [Claude default]
- A blocking finding stops the review until it is fixed and committed, and then select and the pre-step run again; a finding marked allowed true does not block and reaches the lenses as established through the brief. [Claude default]

### 4. Tests before the lenses

- Run the tests the tiers require before any lens, so the brief carries their counts; the runners need GNU coreutils timeout (gnutimeout on this box), and a run dir holds one run. [Claude default]
- Reached suites, for every tier but docs: `node <wt>/scripts/run-suites.js --changed <base>..<tip> --log-dir <work>/tests/suites`, which takes the dev-suite lock; an empty reach (a tier C lane) still writes the summary the receipt records and the brief reads, and a server suite never runs any other way, since every window shares the dev database. [Claude default]
- Money smoke, for any tier A file (tests.smoke true): `node <wt>/scripts/testdb-smoke.js --tap-dir <work>/tests/smoke`, under the smoke lock; a summary with skipped true or a did_not_run reason is not a pass, and the review never dispatches on one. [Claude default]
- Client build, for any client/ file (tests.client_build true): run `mkdir -p <work>/tests && cd <wt>/client && CI=true npx react-scripts build > <work>/tests/build.log 2>&1` and keep its exit code for --build <log> --exit <code>. [Claude default]
- Read every count from the runner's summary.json or TAP log, never from an exit code or the tail of a pipe. [Claude default]
- For a designed surface with the client lens selected, the main session captures it at 320 and 390 wide itself (a subagent cannot sign in to the dev app), saves the PNGs under <work>/captures/, and hands them with the artifact path to the brief. [Claude default]

### 5. Brief

- Write the brief with `node <wt>/scripts/review-brief.js --branch <name> --select <work>/select.json --pre-steps <work>/static.json --tests <work>/tests/suites --plan <plan> --spec <spec>`, adding --smoke <work>/tests/smoke, --build <work>/tests/build.log --exit <code>, --artifact <path> --captures <png>... and --settled <file> when they apply. [Claude default]
- Its first line is position <seq> tip <sha7>, because it runs position right before it writes the diff, and every store at that position passes the seq as --position <seq>. [Claude default]
- Then it prints brief: <path> (or, for a diff over 4,000 lines split by area, one brief.part-<n>.md and diff.part-<n>.patch per part) and diff: <path>; read the printed paths, never assume brief.md. [Claude default]
- review-brief exits 1 with one stderr line and writes no new brief or diff when it refuses (a blocking pre-step, no open review, a select.json read at another tip or staged tree, a quick-fix or lane mismatch), having already removed the earlier run's brief.md and diff.patch, and a refusal after its position step has taken a new seq, so run it again rather than dispatching on an older brief; exit 2 is argv misuse; --plan only labels its Plan and spec section, and it drops --artifact and --captures with a stderr line when the client lens is not selected. [Claude default]
- Record each test run at that position, one run per call: `<rr> tests <name> --suites <work>/tests/suites --position <seq>`, `<rr> tests <name> --smoke <work>/tests/smoke --position <seq>`, `<rr> tests <name> --build <work>/tests/build.log --exit <code> --position <seq>`, or --log <file> for one extra TAP log, which never stands in for the reached-suites run: tests.suites in select.json is recorded through --suites with run-suites' run dir and nothing else, a rule stricter than finalize, which still accepts a log entry as that run and names --log in its refusal (the precedence rule above covers flags and mechanics, never a looser reading of a stricter rule). [Claude default]

### 6. Dispatch

- Dispatch every selected lens at once, in one message so they run in parallel: one Agent per lens with subagent_type the lens name, told it is dispatched as one lens, handed the brief path, and told to end with the verdict table and nothing after it. [Claude default]
- Lenses run on model opus and verify on model fable, passed explicitly on every dispatch. [Dallas 2026-08-14]
- Every dispatch prompt carries the report form the store parses: a finding bullet opens with its id and the backticked path:line; no other line, bullet or bold span opens with an id (a closure is prose with the id mid-sentence); the table's note names an id only for a finding the report raises. A lens report that still parses malformed is stored (a non-collapsed report's findings are read and triaged under that report's name; a collapsed one yields none), the agent is asked by message to re-emit it, the re-emission is stored as the next pass and its findings are triaged again under the new name as duplicates, and a re-emission is neither a fix re-pass nor the not-reached re-dispatch. A malformed verify report is never stored: it is re-dispatched first, as section 7 says, because finalize refuses every malformed verify report stored. [Claude default]
- When a lens agent is not registered in the window, inline its .claude/agents/<lens>.md in the prompt instead. [Claude default]
- When select.json says collapse true (a one- or two-file tier A diff), the session may dispatch one Agent on model opus with every selected lens file as its checklist, told it is collapsed so that it writes one `## Lens: <name>` section per lens, each ending with that lens's own table. [Claude default]
- For a split brief each lens runs once per part, on that part's brief. [Claude default]
- On tier A, verify (subagent_type verify, model fable) joins the same message with every brief path (brief.md, or each brief.part-<n>.md of a split) and the money math and the lane's own fixes to break, and its prompt says in one line that verify.md's Output governs it: findings only, no verdict table, and the line No findings by itself when it finds nothing, even though the brief's Output section asks every lens for a table. [Claude default]
- On tier A, the externals join the same message as `/second-opinion <base>..<tip> --brief <the brief path review-brief printed, part 1 of a split, since every part carries the money laws>`, which sends codex and gemini only the masked diff and the brief: both run from a scratch directory that holds only the masked patch (codex with --skip-git-repo-check, gemini with the patch attached as a file, because the headless gemini CLI keeps file reads allowed), and the command drops every brief line that names a /drb-review/ path, and the Plan, Spec and Artifact lines, which name the checkout by absolute path, before it appends the brief, and removes the raw diff the moment the mask succeeds. [Claude default]
- Nothing from <work>/tests/ goes into an external brief or a dispatch prompt, because the smoke logs may hold production-derived data from ci-smoke assertions; the brief names those run dirs by path in Established, which is why /second-opinion drops those lines, and no lens is ever told to open them. [Claude default]
- No dispatch prompt, triage reason, report line or commit message carries a client or staff phone number, and no number is printed on screen: counts and file names only. [Dallas 2026-10-19]
- Nor a client or staff name or email address: files by path, people by role, records by id. [Claude default]
- An agent that finishes in seconds with no tool use, returns an empty or off-topic result, or fails is never a pass: re-dispatch it once with the same prompt, and a second failure leaves its files not reached. [Claude default]

### 7. Verdicts

- Save each returned report verbatim under <work>/incoming/ and store it with `<rr> verdicts <name> <lens> <work>/incoming/<lens>.md --position <seq>`, adding --pass <n> for a re-pass or --part <n> for a split part, or with `<rr> verdicts <name> --collapsed <report> --position <seq>` for a collapsed one. [Claude default]
- The store prints the rows it read, the findings and the files not reached; a report with no table, or a table missing a file, leaves those files not reached, and every report of a dispatch is stored before position runs again, since a store refuses a seq that is no longer current. [Claude default]
- Store verify with `<rr> verify <name> <work>/incoming/verify.md --position <seq>` (with --pass <n> on a re-pass) only after reading it: a report with neither a finding nor the No findings record, or a No findings line that goes on, is malformed and blocks finalize until a new init, so re-dispatch it once before storing. [Claude default]

### 8. Triage

- Triage every finding of every stored report, verify's included, against the cited code yourself, with `<rr> triage <name> <stored report> <id> confirmed --reason <the failure path, stated from the code>` or the same command with `rejected --reason <one line: wrong about the code, guarded upstream, unreachable, or style>`, where <stored report> is the name the store printed (seams.md, seams.pass-1.md, verify.md) and each reason is one shell argument. [Claude default]
- Agreement between agents is not evidence, since several agents repeating a claim share one blind spot, and finalize refuses any finding left untriaged. [Claude default]
- The bar for a fix: a finding is confirmed when its failure path is reachable through the plan's flow (a fail-open read, a lock race, a wrong result, a missed refusal, a money or data mistake); a surviving mutant on a test file, a wording gap in the plan, or a state reachable only by a hand edit of a record is triaged `rejected` with a reason that opens with `deferred minor`, listed in the lane report (for a quick fix, the receipt's triage reasons are that list), and never opens a fix round. [Dallas 2026-10-23, "lets fix the excessive review"]
- An exposure is confirmed whatever its flow and is never deferred: a real client's or staff member's name, phone number or email address, or a secret or a token, in a file of the repo, which the pre-step's shapes cannot always see; fixtures and the business lines are not exposures (spec D9). [Claude default]
- A contradiction between the plan's text and the code is one line of prose in the lens's report, never a finding against a diff file, and the plan takes it in its next revision without a re-pass. [Dallas 2026-10-23]
- The externals' findings are triaged the same way inside /second-opinion, and a confirmed one is fixed in the lane like a lens finding. [Claude default]
- A row with verdict escalate makes the review tier A: write the escalation into <work>/select.json (tier A, externals true, verify true, tests.smoke true, and the tier A floor lenses not yet listed added with fired_because floor), run the smoke, run the brief again so it carries Tier A and the money laws (a new position), dispatch the floor lenses not yet run, verify and the externals on that brief, re-apply that edit to select.json after every later select run (a fix re-pass, a stale-base), since review-select recomputes the tier from the diff alone and would drop the laws from the next brief, and finalize with --tier A, since finalize refuses an escalation below tier A and a brief rendered from a hinge select.json carries no money laws; a quick fix that escalates becomes a lane. [Claude default]

### 9. Fix and re-pass

- Review runs once per lane: one full pass of the selected lenses, then at most two fix re-passes (each bounded as below) and the stale-base overlap pass; after the second re-pass a finding the bar defers goes to the report, and a reachable finding still open means the lane is split and the finding fixed in the new lane, never deferred and never left confirmed in a merged receipt (finalize today refuses only an untriaged finding and a fixed mark with no clearing pass, so the session holds this line itself until a later tier A change to receiptFinalize.js refuses a confirmed finding left open) (spec 2026-10-19, D14 as amended). [Dallas 2026-07-22; the cap 2026-10-23]
- No lens mutation-tests a test file, and a surviving mutant a lens reports is a deferred minor under the bar. [Dallas 2026-10-23]
- A test-only fix would still stale every lens's verdict on the test file under finalize's rule, which is why the bar sends test gaps to the report instead of a round; relaxing the stale rule for `.test.js` files is a later tier A change to receiptFinalize.js. [Claude default]
- Fix each confirmed finding in the lane in its own commit with explicit pathspecs; once every report of the earlier dispatch is stored, run select, the pre-step and the brief again (a new position seq; the brief leaves out --tests, --smoke and --build, which ran at the earlier tip, carries --overlap <main sha> again in a stale-base review, and for a designed surface takes new captures of the fixed tip, since the earlier PNGs render the earlier tip) and re-dispatch the lens that raised it, stored as --pass <n> with a new n. [Claude default]
- Any other lens whose verdict covers a file a fix changed re-passes that file too, because finalize refuses a verdict read before a later change to its file and names the lens and the files; in a stale-base review where a sensitive path landed on main, every later seams pass (a fix re-pass or a not reached re-dispatch) gives every diff file a verdict, since finalize reads the latest seams report as the overlap pass. [Claude default]
- When the re-pass is stored, mark the finding with `<rr> triage <name> <stored report> <id> fixed --reason <the fix commit and what it changed>`; finalize accepts fixed only when a later pass of the raising lens lists the finding's file as pass. [Claude default]
- On tier A, verify re-passes after the last fix, handed the confirmed findings, each fix's diff written masked to <work>/fixes/<n>.patch through `node <wt>/scripts/lib/piiShapes.js --mask-diff` (the file path, never pasted text) and the failing-test record, because finalize needs verify's latest pass to have read the final tip. [Claude default]
- Re-dispatch each not reached file to its lens once, alone (the prompt names that one file and asks for a row for it, not reached with the reason when it still cannot read it; the same brief and seq while the tip has not moved), and store the report as --pass <n>. [Claude default]
- A file not reached twice blocks the merge and is named in the window; --allow-not-reached, which finalize accepts only when that --pass report carries an explicit not reached row for the file (a re-pass that leaves the file out does not count), is Dallas's call to ship anyway, never the session's; in a stale-base review where a sensitive path landed on main the flag does nothing for a file the seams overlap pass itself leaves not reached, since the overlap check reads the latest seams report and counts a not reached row as no verdict, so that file blocks the merge until seams can read it. [Claude default]

### 10. Final-tree tests

- After the last re-pass is stored, run `<rr> position <name>` by hand, run every test the tiers require again on the final tip with the same commands (a runner clears its own earlier files from its run dir), and record each with the new seq; entries from an earlier tip move to tests_superseded and never count. [Claude default]
- With no fix, the first run already ran on the final tip and stands as the final record. [Claude default]

### 11. The failing test

- For a bug fix, prove the test fails on the old code: `git worktree add --detach <old> <base>` outside the checkout, symlink node_modules and .env into it, write the reviewed version of the test there with `git show <tip>:<test> > <old>/<test>` for a lane or a commit and `git show :<test> > <old>/<test>` for a quick fix, whose test lives in the index, run that one suite with `RUN_SUITES_ROOT=<old> node <wt>/scripts/run-suites.js <test> --log-dir <work>/old-code`, read the # fail line of its log, and then `git worktree remove --force <old>`. [Claude default]
- Hand that to finalize as --failing-test <test>:<count> --failing-log <work>/old-code/<its log>, and a change that fixes no bug takes --not-a-fix <reason> instead. [Claude default]

### 12. Externals

- On tier A, record the externals with `<rr> externals <name>` and the two fixed lines /second-opinion ends with, verbatim, each as one shell argument, or with codex=run:<output file> or codex=not_run:<reason> and the same for gemini. [Claude default]
- Codex is out of credits since 2026-10-20, so record codex as not run (no credits) until Dallas adds some. [Claude default]
- An external that fails (a 429, a timeout, an auth failure) is recorded as not run and never blocks; the Claude lenses remain the gate and the externals are optional second opinions. [Dallas 2026-07-02]
- Below tier A record nothing: finalize writes externals/not-run.txt with not required at tier <t> for both. [Claude default]

### 13. Finalize

- Finalize with `<rr> finalize <name> --kind lane --base <base> --reviewed-against <base> --tier <tier> --select <work>/select.json` and either --not-a-fix <reason> or --failing-test <file>:<count> --failing-log <log>, with --tier never below the tier select.json computed. [Claude default]
- A refusal names every problem, one line each, and moves nothing: fix each and finalize again; exit 3 means the receipt is published but index.json was not updated, and show still finds it by key. [Claude default]
- Finalize moves <work> to <git-common-dir>/drb-review/<key>/ (receipt.json, brief.md, diff.patch, every report, externals/not-run.txt, tests/) and maps the name to the key in index.json; `<rr> show <name>` then finds it by branch and `<rr> block <name>` prints the commit block. [Claude default]

### 14. Report

- End with one line, Reviewed <branch>, tier <t>, <n> findings fixed, <suites> green; unforecast lenses: <names or none>, and name in it any file not reached twice and any external not run. [Claude default]

### Modes

- lane, the default: the procedure above, on a base that is current main, rebased first. [Claude default]
- quick-fix: stage the fix in os with explicit pathspecs, run `npm run docs -- --staged` so the generated sections are current and staged (spec 4.2), then open with `<rr> init --branch main --quick-fix` (the name is quick-fix-<UTC timestamp>), and select with `node <wt>/scripts/review-select.js --staged > <work>/select.json`. [Claude default]
- When that select.json says refuse_quick_fix true, the quick fix stops there with the line tier A is a lane, and the work moves to a lane. [Claude default]
- Otherwise a quick fix runs the same steps on the staged diff: `cd <wt> && node scripts/static-checks.js --staged > <work>/static.json`, `node <wt>/scripts/run-suites.js --staged --log-dir <work>/tests/suites`, the brief, the lenses and the stores, finalized with `--kind quick-fix --base <HEAD sha> --reviewed-against <HEAD sha>`. [Claude default]
- Nothing is staged or unstaged while a quick fix's lens runs; a fix restaged afterwards moves the staged tree, so `npm run docs -- --staged` runs again first (a quick fix's receipt key is the whole staged tree, the two docs included, and the hook refuses a stale section at the commit), then select, the pre-step, the brief (without --tests, --smoke and --build, which ran on the earlier tree, and with new captures for a designed surface), every lens (as --pass <n>) and the tests run again on the new tree. [Claude default]
- A quick fix's tests store needs the working tree to hold exactly the staged tree (no unstaged change to a tracked file, no untracked file git does not ignore); when another window's file blocks it, stop and say so by count, and never touch that file. [Claude default]
- After a quick fix finalizes, commit exactly the staged tree with a message that carries the review block `<rr> block <name>` prints (spec 3.7 and 4.2; through git commit -F, never -m), and confirm that `git rev-parse HEAD^{tree}` equals the receipt key, the block's tree line. [Claude default]
- --commit <sha>, for a commit already on main with no receipt: <wt> is os, check the commit out in a detached worktree <tmp> with node_modules, client/node_modules and .env symlinked, open with `<rr> init --commit <sha>` (the name is commit-<sha7>), and run every step over --base <sha>^ --tip <sha> against <tmp>: the receipt, select and brief scripts with REVIEW_RECEIPT_ROOT=<tmp>, static-checks with <tmp> as its working directory, run-suites with RUN_SUITES_ROOT=<tmp>, the smoke as `node <tmp>/scripts/testdb-smoke.js --tap-dir <work>/tests/smoke` from <tmp> (the smoke has no root override) and the client build from <tmp>/client; a commit older than 7e30f154 (2026-10-20, the runner merge) carries a testdb-smoke.js that takes no lock and resets ci-smoke, so its smoke is never run from <tmp>, and a tier A commit that old is outside this skill until the smoke can run with the current runner (a lane cut from main already holds the commit, and one cut at its parent carries the old scripts): the session names the commit in the window and finalizes nothing for it, since --not-a-fix and comment-only never stand in for the smoke. [Claude default]
- That is because a commit review's tests are stored only while the checkout's HEAD is the commit; it finalizes with `--kind commit --base <sha>^ --reviewed-against <sha>^` and refuses --stale-base. [Claude default]
- comment-only: run the pre-step first (`cd <wt> && node scripts/static-checks.js --base <base> --tip <tip> > <work>/static.json`, or `--staged` for a quick fix; a blocking finding stops here as in section 3, since the PII shapes must scan prose that no lens reads), then `node <wt>/scripts/review-select.js --base <base> --tip <tip> > <work>/select.json` (or `--staged`) for the tier alone, since no lens runs; finalize takes `--tier <that tier> --base <base> --reviewed-against <base>` as every other kind does, and a quick fix whose tier is A is a lane (tier A is never a quick fix), then `node <wt>/scripts/comment-only-proof.js --base <base> --tip <tip> --out <work>/proof.json` (for a quick fix `--staged`), then `finalize --kind comment-only --proof <work>/proof.json`, which runs no lens, no test, no verify and no externals, the proof being the receipt's body (spec 3.7); a proof that says no means the change is reviewed at its tier like any other. [Claude default]
- stale-base, when main moved under a lane after its reports were stored: rebase the lane onto main first, run select and the pre-step again on the rebased range (<base> is now the new main), then the brief with --overlap <main sha> and without --tests, --smoke and --build, which ran on the earlier tip, with new captures for a designed surface (the brief runs position itself; never run position --overlap by hand, since a snapshot without a new diff.patch would pin a verdict to a diff the lens never read), re-pass every lens whose files the rebase changed (finalize's stale line names them), with seams as the overlap pass (money and access-egress too at tier A, and seams gives every diff file a verdict when a sensitive path landed on main), run the tests on the rebased tip, and finalize with --stale-base --base <main sha> --reviewed-against <main sha>. [Claude default]
- stale-base is documented now and exercised in step 5, where merge-lane.sh check invokes it. [Claude default]

### What stands until later steps

- The receipt is the record of the review; merge-lane.sh reads it from step 5 on, and until then the session runs this skill by hand before every merge and the squash message stays one line. [Claude default]
- This skill never merges, pushes or ships; those keep the current merge and push rules until the flip. [Claude default]
