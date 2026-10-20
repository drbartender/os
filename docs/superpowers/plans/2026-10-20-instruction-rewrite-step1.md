---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 1 of section 8
format: lane map without code (spec D12)
revision: 2 (2026-10-20; the plan fleet's fidelity and decomposition findings folded)
lanes:
  - id: step1-docs
    scope: docs/money-laws.md, docs/dev.md, AGENTS.md, the retire-and-move half of scripts/claudemd-invariants.txt, and the render.yaml cut, on a worktree lane merged through merge-lane.sh under the current (pre-flip) rules
    footprint:
      - docs/money-laws.md
      - docs/dev.md
      - AGENTS.md
      - scripts/claudemd-invariants.txt
      - render.yaml  (deleted)
    blockedBy: []
    lenses: a verify pass (Fable) that reads every money law against the code it points to; a read of dev.md against what was actually run
    review: pre-flip rules; the lane merges only when the verify pass has zero unresolved rows and every acceptance check passes; no push (the cue rules stand until the flip)
    revert: git revert of the squash commit
  - id: global-rules
    scope: rewrite ~/.claude/CLAUDE.md to spec 6.2, correct the auto-mode environment block in ~/.claude/settings.json, add the drb launcher (D16); outside git, backed up first
    footprint:
      - ~/.claude/CLAUDE.md
      - ~/.claude/CLAUDE.md.bak-20261020
      - ~/.claude/settings.json
      - ~/.claude/settings.json.bak-20261020
      - ~/.local/bin/drb
    blockedBy: []
    lenses: none (prose outside the repo); the acceptance checks are the review
    revert: copy the two .bak files back; remove drb
  - id: memory-prune
    scope: spec 6.5, the step-1 half: strip Windows-era spans, correct what the audit found wrong, fix dangling links, bracket the feedback memories, turn the money-law memories into pointers, rewrite the index, symlink the os-launch memory root
    footprint:
      - ~/.claude/projects/-home-drbartender/memory/**
      - ~/.claude/projects/-home-drbartender/memory.bak-20261020/  (a plain copy, never loaded)
      - ~/.claude/projects/-home-drbartender-projects-os/memory  (becomes a symlink)
    blockedBy: [global-rules, step1-docs]   # the index cites the global file and docs/money-laws.md must be on main before the glosses move
    lenses: none; every correction carries its evidence; the acceptance checks are the review
    revert: copy memory.bak-20261020 over the directory; remove the symlink and move the four archived os-launch files back
---

# Instruction rewrite, step 1: the three docs, the global file, the memory

**Goal:** land everything in Phase 3 that has no code dependency: the money-laws doc the money lens will read, the dev runbook, the root pointer file for external agents, the pruned invariants manifest, the private global rules file with provenance, the launcher that fixes discovery, and the memory prune and corrections.

**Spec:** `docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md` (rev 6), sections 6.2, 6.4, 6.5, 7, 8 (step 1), 9, D6, D8, D9, D16.

**Two deviations from the spec, flagged:**

1. Section 6.5 says step 1 "archives the 7 Windows-procedure files". Read against the files, six of the seven carry live Linux facts beside the Windows paragraphs (the box hostname and the DHCP note, the dev-server restart rule, the lane helper rule, the symlink and `.gitignore` fact). The plan strips the Windows spans and archives a file only when nothing live is left. The acceptance check guards the risk directly (every removed span states no fact true on Linux today, or names the file that still carries it).
2. The spec puts the `claudemd-invariants.txt` edit in step 1; rev 1 of this plan moved it to step 5 on the belief that the check would go red. The check is one-directional (it fails only when a manifest key matches nothing in the project CLAUDE.md) and is not wired into pre-commit until step 4, so the retire-and-move half cannot break anything. It lands here, in step1-docs, as the spec says; only new keys (main-is-prod, review-receipt) wait for step 5, where the regexes are re-aimed at the rewritten file.

## Global constraints

- No em dash character in any prose written here (feedback_no_em_dashes, extended 2026-08-14).
- Ids only in the repo: no client or staff name, email or phone number in any file this plan writes under `os/` or in a commit message (feedback-no-client-pii-in-repo-docs, 2026-10-14). The business lines and fixtures may appear (D9).
- Every rule written carries a bracket `[Dallas YYYY-MM-DD]` or `[Claude default]` (D6). A quote appears only in the private global file or in memory, never under `os/` (6.1).
- Files outside git get a `.bak-20261020` copy before the first edit, with `sha256sum` recorded before the copy and `cmp` run after; nothing under `~/.claude` is deleted; archived memory files move to `memory/_archive/`.
- Nothing is pushed. Pushes are cue-only until the flip (section 8). The repo lane merges through `scripts/merge-lane.sh` from `os` on main.
- Thinking on main: this plan commits to main before the lane is cut.

## Review focus

The five ways this step bites if done carelessly, each pinned to an acceptance check:

1. A money law transcribed from memory that the code no longer matches: every law in `docs/money-laws.md` is checked against the code it points to by a verify pass before merge (step1-docs, check 2). The memory was wrong about shas and attributions in at least three places; it can be wrong about a rule.
2. A memory "correction" that is itself wrong: every correction cites its evidence (a sha, a `git merge-base --is-ancestor` result after a fetch, or a file and line) in the corrected line, and the sweep never changes a claim it could not check (memory-prune, check 4).
3. A Windows span stripped that carried a live Linux fact: each removed span is listed in the lane report with the statement that it carries no fact true on Linux today, or the name of the file that still carries it (memory-prune, check 1).
4. The launcher breaking lane windows or splitting memory: `drb` is tested against a real worktree and the memory symlinks are checked to be links, not directories (global-rules, checks 5 and 6).
5. The index rewrite losing a tripwire gloss: `docs/money-laws.md` merges before any gloss leaves memory, and the money-law memories become pointers to it in the same lane that cuts the index (memory-prune, checks 6 and 7).

## Order

1. step1-docs is cut, built and merged first.
2. global-rules.
3. memory-prune (its index cites the global file and `docs/money-laws.md`).

## Lane: step1-docs

**Scope.** Five files, on a lane named `rewrite-step1` cut from main with `npm run worktree:new`.

**`docs/money-laws.md`.** One section per law, each: the rule in one or two sentences; the code it lives in (`file:function` or `file:line`); the memory or spec it came from; a provenance bracket; and a "checked against code 2026-10-20" line written only after the check, carrying a ledger defect id when the code contradicts the law. The laws (spec 6.4): the retainer survives full payment (read off the upgrade breadcrumb, never the label); `acknowledged_total` is row truth and create-intent's total is a projection; a `?paid=true` load never renders money; frozen rates beat the live catalog; the label partition, its five constant sets, and that a label is neither a semantic nor a key; the addon quantity column's stored shape per billing type and `storedToInputCount`; off-ledger invoice labels join `OFF_LEDGER_INVOICE_LABELS`; the paid flag is `amount_paid` plus `external_paid` against `total_price`, never status or payment type; refund scope (allowance is headroom plus contract slack); the hosted 1:100 bartender ratio through `isHostedPackage`; owner no-draw payouts; which pay period is now is `chicagoTodayYmd()`, never SQL `CURRENT_DATE`; the stale-proposal sweep never adds `accepted` to its statuses; the gratuity rules, moved verbatim from the current project CLAUDE.md paragraph; the legal-hold proposal, by id, with the actions that never touch it. A closing line names who reads this file: the review skill before any money lens, the money lens's brief, the externals' brief, and any session before a money-path change.

**`docs/dev.md`.** Sections: starting the backend (a Claude-managed background process, no reload, restart after server edits, the port and the two lines to wait for); starting the client (the command-line env flags, not in `client/.env`, including whether `NODE_ENV=development` is needed for the server's CORS gate, which memory says and the spec omits: settled by running it); the two-hour background limit; what a subagent cannot do (mint a dev token; `dev-signin.js` is the controller's; `sudo` has no TTY under Claude, so a sudo command is handed to Dallas); running tests (the suites share the dev database; one at a time; never from a lane while another runs; read the pass count; never CREATE TEMP; the money smoke through `npm run test:smoke`; until the flip, the pre-push client build can OOM beside a concurrent lane build, so wait rather than `--no-verify`; the dev-suite lock and the smoke lock arrive in steps 2 and 3, and those plans carry the edit to this file); the Node mismatch (box 24.16.0, prod 26.5.0) and the caveat on fixing it; the Neon dev and prod branch ids and that prod data fixes go through a guarded DO block; the Render service (`os`, dashboard-created on 2026-03-16, `npm run start`, no health check path today, the rollback lever in the dashboard, from the CLI listing of 2026-10-19); the win-share clone (a July copy, not a source of rules). Every "how to" line is written only after it was run on 2026-10-20, or carries "from memory, not re-run on 2026-10-20".

**`AGENTS.md`.** At most ten lines, pointers only: what the repo is in one line; read `.claude/CLAUDE.md` for the rules; read `docs/money-laws.md` before touching money; read `docs/dev.md` to run anything; the repo is public, so see the PII rule in CLAUDE.md. No rule of its own.

**`scripts/claudemd-invariants.txt`.** Retire `inline-self-check` and `file-size-ratchet` (the first dies with the checklist; the second becomes one pointer line, which the key would not match). Move: `gratuity` becomes `gratuityLineAmount|GRATUITY_LABEL|money-laws`; `env-debug-discipline` is removed (the rule moves to the global file); `design-review-fleet` becomes `spec-grounding|review-spec|review skill`; `doc-updates` becomes `mandatory doc|header comment`; `push-fail-stop` becomes `push fail.*stop|stop and report|stops and reports`; `proposal-payment-status` becomes `paid in full|paid flag`. Keep the other twelve as they are. Every pattern stays an alternation that matches today's file and the step 5 file, so the check is green now and only new keys can turn it red later.

**`render.yaml`.** Deleted; its real counterpart is described in `docs/dev.md` (spec 4.9, section 7).

**Acceptance checks**

1. Every `file:function` pointer in `docs/money-laws.md` resolves (`grep -n` finds the function in the file).
2. A verify pass (Fable, the agent file inlined since the session may not register project agents) reads each law against its code and returns a table, one row per law: pass, or a finding with the line that contradicts the law. Pass means zero unresolved rows: a row resolves by a doc fix re-verified by the pass, or by a ledger defect whose id is written into that law's "checked against code" line.
3. `docs/dev.md`: the backend start recipe and the client start recipe were each run once on spare ports during the lane and stopped, the output lines they name were seen, and the CORS-gate question is settled by the run; the Neon branch ids were confirmed read-only through `list_branches`; the Render settings match the CLI listing of 2026-10-19 or a read-only `render services -o json` run on the day. The lane report counts the lines marked "from memory, not re-run".
4. Every line of the three prose files passes `scripts/board-write.sh --check "<line>"` (the one PII shape check that exists today), and `grep -c` for the em dash character is 0 in each.
5. `AGENTS.md` is at most ten lines and contains exactly the pointers listed above and nothing else.
6. `bash scripts/check-claudemd-invariants.sh` prints `OK: all 17 invariants present` against the current `.claude/CLAUDE.md` after the manifest edit.
7. `render.yaml` is gone and no file under `docs/` or `.claude/` still tells a reader it governs the service (`grep -rn 'render.yaml' docs/ .claude/ README.md ARCHITECTURE.md` lists only history).
8. The lane merges through `scripts/merge-lane.sh rewrite-step1 docs/superpowers/plans/2026-10-20-instruction-rewrite-step1.md` from `os` on main; nothing is pushed.

## Lane: global-rules

**Scope.** Rewrite `~/.claude/CLAUDE.md` to spec 6.2 with provenance; correct `~/.claude/settings.json`'s auto-mode environment block; add `~/.local/bin/drb`.

**What the global file carries, in order.** Each a one-line rule ending in a bracket; dates come from the feedback memory's own record, and where a memory has no date the file's modification date is used and marked "approx.":

- Review is standing; never ask; never attribute "no agents" to Dallas; a skipped review is reported as "I skipped review because X", never as his ask; the Workflow tool's opt-in gate says nothing about the Agent tool. `[Dallas 2026-08-28, "Since when do I have to ASK for review"]`
- No compaction, never turn it back on, never suggest /compact; handoff only when asked; there is no context line. `[Dallas 2026-10-14, 2026-10-17]`
- Brainstorm in prose, one question at a time, no menus; section approvals are the approval; skip the final spec re-read. `[Dallas 2026-08-04; the re-read rule from feedback_brainstorm_no_final_review, approx.]`
- Latest word beats the spec; amend quietly, flag only a real hidden cost. `[Dallas 2026-08-14]`
- Verify behavior, not shape; don't rubber-stamp; say it once; cursing is a signal. `[Dallas 2026-08-25; 2026-07-18]`
- Env-var debug discipline: never assert a production variable is unset; ask him to confirm it in Render or Vercel. `[Claude default, carried from the project file]`
- The ledger is his to update: report a fix with its sha and the test that failed on the old code; never write "fixed" on a grep; never close a ledger entry yourself. `[Dallas 2026-08-25 for the ownership; the test clause is spec D13, Claude's call]`
- No client or staff phone numbers in any repo, board line, spec, commit or external diff; the personal cell nowhere; fixtures and the business lines are fine. `[Dallas 2026-10-02, 2026-10-06; narrowed 2026-10-19]`
- No em dashes in client, staff or spec prose. `[Dallas 2026-08-14]`
- Dallas is both DRB accounts (admin 1, staff 12); never call him Dan. `[Dallas 2026-08-19]`
- In the os repo every commit on main ships after the gate and nothing reaches main without a review receipt. `[Dallas 2026-10-18]`
- Sessions for DRB launch from `os` through `drb`; a lane window launches through `drb <lane>`. `[Claude default 2026-10-19, spec D16]`
- Transitional: pushes are cue-only through `npm run gate` and a literal-sha push until the flip marker exists; the per-lane review runs through the new skill from step 2 on; the old push-time review layer is not run. `[Claude default 2026-10-20, spec section 8; delete at the flip]`
- This file is the only place outside memory where a rule about working with Dallas lives; it is backed up before every rewrite because `~/.claude` is not in git. `[Claude default 2026-10-19, spec 6.2]`

The email-over-SMS preference stays in memory (D8); it is not in spec 6.2 and is not added here.

**`~/.claude/settings.json`.** Only the `autoMode.environment` block changes: the repository is public (drbartender/os on GitHub) with an origin remote; the trusted repo is `~/projects/os`. Nothing else in the file moves.

**`drb`.** A bash script: with no argument, `cd ~/projects/os` and `exec claude "$@"`; with a lane name as the first argument, `cd ~/projects/worktrees/<lane>`, then ensure `~/.claude/projects/-home-drbartender-projects-worktrees-<lane>/memory` is a symlink to the main memory directory (a missing path is linked; a real directory is moved to the main `_archive/` under a prefixed name and then linked, the way memory-prune treats the os root), then `exec claude` with the remaining arguments. Refuses a lane name whose worktree does not exist, with a one-line message. `drb` carries the lane-memory link until `scripts/worktree-new.js` takes it over in step 3.

**Acceptance checks**

1. `sha256sum ~/.claude/CLAUDE.md` and `~/.claude/settings.json` are recorded before the copies, and `cmp` of each original against its `.bak-20261020` passes right after; both are in the lane report.
2. The new file is at most 45 lines; the number of lines beginning with `- ` equals the number of lines ending in `]`; the file contains no em dash character.
3. A reviewer reads the rev 1 file (the `.bak`) beside the new one and lists any rule or sub-rule dropped, against the denominator of the old file's bullets (review standing; never attribute; the skipped-review wording; the Workflow-gate note; review runs when work is done; compaction off and never re-enabled; no context line; handoff only when asked); the list must be empty.
4. `python3 -c "import json;json.load(open('/home/drbartender/.claude/settings.json'))"` exits 0 and the diff against the `.bak` touches only the environment block.
5. `drb --help` prints the claude help from `~/projects/os`; `drb override-removal --help` prints it from that worktree; `test -L ~/.claude/projects/-home-drbartender-projects-worktrees-override-removal/memory` passes and its target is the main memory directory.
6. `drb nope` exits non-zero with a one-line message naming the missing worktree.

## Lane: memory-prune

**Scope.** Spec 6.5, the step-1 half. Nothing here touches the repo.

**Work, in order**

1. **Backups.** Copy the memory directory to `~/.claude/projects/-home-drbartender/memory.bak-20261020/` (never loaded) before the first edit. Fetch origin (`git -C ~/projects/os fetch`) before any sweep.
2. **Windows-era spans.** In `machine-remote-access.md`, `project-linux-dev-box.md`, `project-workflow-redesign.md`, `reference_dev_server_process.md`, `project-worktree-workflow.md`, `reference_staff_portal_local_review.md` (not `reference-zul-dev-setup.md`, whose only hit is inside a paragraph about how Dallas learns): remove the spans (a paragraph, or a sentence inside a mixed paragraph) that describe `taskkill`, PowerShell, `netstat`, junctions, `%USERPROFILE%` or are marked STALE or TRANSITIONAL in capitals; keep every Linux fact; where a file would be left with nothing live, move it whole to `_archive/`. The two live facts that exist only in the os-launch files (sudo has no TTY; the pre-push build OOM) are already carried by `docs/dev.md` from step1-docs.
3. **Corrections, each with its evidence written into the corrected line:**
   - `reference-payroll-completion-gate.md`: the verify command is stale; the fix is on main at `5b7c111a` (2026-09-16).
   - `reference-contractor-profiles-updated-at-trigger.md`: the trigger pattern landed in `c10ae187`, not `677baf95` (the dbTarget banner).
   - `reference-gratuity-fee-netting.md`, `project-gratuity-redesign.md`, `project_paystub_pdf_pipeline.md`, `project-thumbtack-autodraft.md`, `project-thumbtack-comms-noise.md`: each mention of Dan on a DRB subject becomes Dallas, citing `user-identity.md` (2026-08-19). `project-linux-dev-box.md`, `reference-sentry-access.md` and `reference-stripe-webhook-api-version.md` are not touched: their mentions are Wildlight context.
   - The forward sweep: every memory line that says a sha or lane is unpushed, unmerged, open or owed is checked (`git merge-base --is-ancestor <sha> origin/main` for a sha; `git log --grep 'merge(lane <name>'` for a lane) and corrected with the result and the date, or left alone with no note when the check cannot be run.
   - The reverse sweep: every eight-character sha a memory cites as a fix is compared with `lens-audit/defects.jsonl`'s `fixed_ref` for the same subject; a disagreement is checked in git and the memory corrected with the evidence.
   - Lane state: a memory line that carries lane state (cut, in flight, merged, pushed) is replaced by a pointer to the board or the ledger (spec 6.5).
4. **Dangling links.** Resolve by filename (strip `|alias` and `.md`). Rewrite: `claude-code-agent-discovery` to `reference_claude_code_agent_discovery`; `feedback-brainstorm-no-final-review`, `feedback-codex-trust`, `feedback-max-effort-multifile` to their underscore twins; `os_shared_git_index` to `reference_os_shared_git_index`; `project-check-cherry-cutover` to `project_check_cherry_cutover`; `project_client_portal` to `project-client-portal`; `project-comms.md` to `project-comms`; `project-external-payment-parked` to `project_external_payment_parked`; `project-redesign-surface-prompts` to `project_redesign_surface_prompts`; `review-proportionality` to `feedback_review_proportionality`; `sms-phone-routing` to `reference-sms-phone-routing`; `subagent-model-opus` to `feedback_subagent_model_opus`; `project-potion-planner-redesign` to `project-potion-planner-v2`. Remove the link and keep the sentence for the ones with no successor: `project-hotspot-until-2026-09-22`, `reference_codex_cli_windows`, `reference_gemini_cli_windows`, `reference_vercel_cli_windows`, `reference_worktree_npm_install_junction`, `reference_worktree_rm_locked_folder_windows`, `subagent-model-always-opus`.
5. **Provenance brackets.** Every `type: feedback` memory gets, as the first body line, `[Dallas YYYY-MM-DD]` when the file quotes or dates his words (the date from its own record; the file's modification date marked "approx." when the body has none), or `[Claude default]` when the rule is Claude-derived. `reference-playwright-clipped-control-false-pass.md` is mistyped feedback; it becomes `type: reference`.
6. **Money-law memories become pointers.** For each law in `docs/money-laws.md`, the memory that held it (`project-retainer-survives-full-payment`, `reference-acknowledged-total-is-row-truth`, `reference-post-payment-redirect-races-webhook`, `reference-addon-quantity-column`, `reference-off-ledger-invoices`, `reference-refund-scope-rules`, `feedback_hosted_bartender_rule`, `project-owner-no-draw-payouts`, `reference-pay-period-boundary-current-date`, `reference-gratuity-fee-netting`, `reference-proposal-600-legal-hold`, and the law line of `project-stale-proposal-sweep`): the law's text is replaced by one line pointing at the doc's section; any other fact the file holds stays; a file whose whole body was the law becomes a one-line pointer with its frontmatter and bracket kept.
7. **The index.** `MEMORY.md` is rewritten: the same group headings, one line per surviving memory, title plus a hook of at most twelve words, no sha, no merged, pushed or unpushed state, no "next" or "owed". The money-law section is one line pointing at `docs/money-laws.md`. The push-day notes stay listed until the flip (6.5).
8. **The os-launch memory root.** Its four files move to the main `_archive/` under the prefix `os-launch-` (so its `MEMORY.md` does not collide); the directory is replaced by a symlink to the main memory directory.
9. **`_archive/README.md`** lists what was archived and why, one line each, dated.

**Acceptance checks**

1. Taken right after item 2 and before item 3: for each of the six files, the diff against the backup removes only spans that contain a marker and adds nothing, and the lane report lists every removed span with the statement that it carries no fact true on Linux today or the file that still carries it; a file moved whole to `_archive/` is listed with the statement that no paragraph in it states a fact true today that is recorded nowhere else.
2. A link check over the memory directory resolves both link forms (`[[x]]` and `](x.md)`) by filename against the file list and reports zero dangling.
3. Every remaining `\bDan\b` hit in the memory directory is on a Wildlight line, named in the report.
4. Every corrected line contains the sha, lane name, command or memory file and line that justified it and the date 2026-10-20; the sweeps' lists of checked claims and results are in the report.
5. Every feedback memory's first body line matches `^\[(Dallas|Claude)`.
6. Each money-law memory named in item 6 either is a one-line body pointing at `docs/money-laws.md` or contains that pointer in place of the law and no sentence restating the law.
7. `MEMORY.md` matches none of `[0-9a-f]{8}`, `unpushed`, `merged`, `pushed`, `\bnext\b`, `\bowed\b` (case-insensitive); the money-law section is one pointer line; the line count is at most 80.
8. `test -L ~/.claude/projects/-home-drbartender-projects-os/memory` passes with the main memory directory as its target, and `ls _archive/` lists the four `os-launch-` files.
9. A fresh session launched through `drb` reports the first line of its memory index when asked, and it is the new index's first line.

## Test plan

Prose and configuration; the tests are the acceptance checks above, each a command or a read with a stated pass condition. Each lane's report lists every check with its result and the evidence lines the checks require.

## What this step does not do

The project CLAUDE.md, the agents, the commands, the skill, the hooks and every script are steps 2 to 5. New manifest keys (main-is-prod, review-receipt) and the re-aiming of patterns at the rewritten file are step 5's first commit. The dev-suite lock and the smoke lock are steps 2 and 3, and their plans carry the `docs/dev.md` edit. The push-era memory notes stay until the flip. `scripts/worktree-new.js` takes over the lane-memory link in step 3.
