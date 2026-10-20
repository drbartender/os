---
spec: docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md   # rev 6; this plan is Phase 3 step 1 of section 8
format: lane map without code (spec D12)
lanes:
  - id: global-rules
    scope: rewrite ~/.claude/CLAUDE.md to spec 6.2 and add the drb launcher (D16); outside git, backed up first
    footprint:
      - ~/.claude/CLAUDE.md
      - ~/.claude/CLAUDE.md.bak-20261020
      - ~/.local/bin/drb
    blockedBy: []
    lenses: none (prose outside the repo); acceptance checks below are the review
  - id: memory-prune
    scope: spec 6.5, step-1 half: strip Windows-era paragraphs, correct what the audit found wrong, fix dangling links, bracket the feedback memories, rewrite the index, symlink the os-launch memory root
    footprint:
      - ~/.claude/projects/-home-drbartender/memory/**
      - ~/.claude/projects/-home-drbartender-projects-os/memory  (becomes a symlink)
    blockedBy: [global-rules]   # the index rewrite cites the new global file
    lenses: none; every correction carries its git evidence; acceptance checks below are the review
  - id: step1-docs
    scope: docs/money-laws.md, docs/dev.md, AGENTS.md on a worktree lane, merged through merge-lane.sh under the current (pre-flip) rules
    footprint:
      - docs/money-laws.md
      - docs/dev.md
      - AGENTS.md
    blockedBy: []
    lenses: a verify pass (Fable) that reads every money law against the code it points to; a read of dev.md against what was actually run
    review: pre-flip rules; the lane merges only after the verify pass returns no finding and the acceptance checks pass; no push (the cue rules stand until the flip)
---

# Instruction rewrite, step 1: the global file, the memory, the three docs

**Goal:** land everything in Phase 3 that has no code dependency: the private global rules file with provenance, the launcher that fixes discovery, the memory prune and corrections, the money-laws doc the money lens will read, the dev runbook, and the root pointer file for external agents.

**Spec:** `docs/superpowers/specs/2026-10-19-instruction-rewrite-design.md` (rev 6), sections 6.2, 6.4, 6.5, 7, 8 (step 1), 9, D6, D8, D9, D16.

**Deviation from the spec, flagged:** section 8 puts the `claudemd-invariants.txt` edit in step 1. The manifest's check (`check-claudemd-invariants.sh`) runs against the project CLAUDE.md, which is rewritten in step 5; adding the new keys now leaves the check red for the whole of steps 2 to 4 with nothing to catch. The manifest edit becomes the first commit of the step 5 lane, before the rewrite commit, which satisfies the spec's reason for it ("lands before the rewrite, not with it"). The retire, move and keep list for the manifest is in this plan (lane global-rules, acceptance 6) so Dallas sees it now.

## Global constraints

- No em dashes in any prose written here (feedback_no_em_dashes, extended 2026-08-14).
- Ids only in the repo: no client or staff name, email or phone number in `docs/money-laws.md`, `docs/dev.md`, `AGENTS.md` or any commit message (feedback-no-client-pii-in-repo-docs, 2026-10-14). The business lines and fixtures may appear (D9).
- Every rule written carries a bracket `[Dallas YYYY-MM-DD]` or `[Claude default]` (D6). A quote appears only in the private global file or in memory, never under `os/` (6.1).
- Files outside git get a `.bak-20261020` copy before the first edit; nothing under `~/.claude` is deleted, archived files move to `memory/_archive/`.
- Nothing is pushed. Pushes are cue-only until the flip (section 8). The repo lane merges through `scripts/merge-lane.sh` from `os` on main.
- Thinking on main: this plan commits to main before any lane is cut.

## Review focus

The five ways this step bites if done carelessly, each pinned to an acceptance check:

1. A money law transcribed from memory that the code no longer matches: every law in `docs/money-laws.md` is checked against the code it points to by a verify pass before merge (step1-docs, acceptance 2). The memory was wrong about shas and attributions in at least three places; it can be wrong about a rule.
2. A memory "correction" that is itself wrong: every correction in memory-prune cites the git evidence (sha, `git merge-base --is-ancestor` result, or the file and line) in the corrected line, and the sweep never changes a claim it could not check (memory-prune, acceptance 3).
3. A Windows paragraph stripped that carried a live Linux fact: the seven files are edited paragraph by paragraph, and the diff of each is read once before the backup is left behind (memory-prune, acceptance 1).
4. The launcher breaking lane windows or losing memory: `drb` is tested against a real worktree path and the memory symlinks are checked to resolve before the old session habit is dropped (global-rules, acceptance 4 and 5).
5. The index rewrite losing a tripwire gloss: the money glosses move into `docs/money-laws.md` first (step1-docs merges before the index is cut), so no "NEVER" line exists only in a deleted index line (memory-prune, acceptance 5; ordering below).

## Order

1. step1-docs is cut, built and merged first (it has no dependency and the index rewrite points at `docs/money-laws.md`).
2. global-rules.
3. memory-prune (its index cites the global file and money-laws).

## Lane: global-rules

**Scope.** Rewrite `~/.claude/CLAUDE.md` to spec 6.2: the rules about working with Dallas, each one line, each bracketed with its date from the feedback memory that records it; the main-is-prod line; the launch-from-os line; the dated transitional line (pushes cue-only through `npm run gate` and a literal-sha push until the flip marker exists; the per-lane review uses the new skill from step 2 on; the old push-time review layer is not run). Add `~/.local/bin/drb`.

**What the file carries, in order** (dates come from the memory's own record; where a memory has no date the file's modification date is used and marked "approx."):

- Review is standing; never ask; never attribute "no agents" to Dallas. `[Dallas 2026-08-28, "Since when do I have to ASK for review"]`
- No compaction; handoff only when asked; there is no context line. `[Dallas 2026-10-14, 2026-10-17]`
- Brainstorm in prose, one question at a time, no menus; section approvals are the approval; skip the final spec re-read. `[Dallas 2026-08-04; the re-read rule from feedback_brainstorm_no_final_review]`
- Latest word beats the spec; amend quietly, flag only a real hidden cost. `[Dallas 2026-08-14]`
- Verify behavior, not shape; don't rubber-stamp; say it once; cursing is a signal. `[Dallas 2026-08-25; 2026-07-18]`
- Env-var debug discipline: never assert a production variable is unset; ask him to confirm it in Render or Vercel. `[Claude default, carried from the project file]`
- The ledger is his to update: report a fix with its sha and the test that failed on the old code; never write "fixed" on a grep; never close a ledger entry yourself. `[Dallas 2026-08-25 for the ownership; the test clause is spec D13, Claude's call]`
- No client or staff phone numbers in any repo, board line, spec, commit or external diff; the personal cell nowhere; fixtures and the business lines are fine. `[Dallas 2026-10-02, 2026-10-06; narrowed 2026-10-19]`
- No em dashes in client, staff or spec prose. `[Dallas 2026-08-14]`
- Dallas is both DRB accounts (admin 1, staff 12); never call him Dan. `[Dallas 2026-08-19]`
- Prefer email over SMS for notifications. `[Dallas, from feedback_notification_cost]`
- In the os repo every commit on main ships after the gate and nothing reaches main without a review receipt. `[Dallas 2026-10-18]`
- Sessions for DRB launch from `os` through `drb`; a lane window launches through `drb <lane>`. `[Claude default 2026-10-19, spec D16]`
- Transitional, dated 2026-10-20: pushes are cue-only through `npm run gate` and a literal-sha push until the flip marker exists; the per-lane review runs through the new skill from step 2 on; the old push-time review layer is not run.
- This file is the only place outside memory where a rule about working with Dallas lives; it is backed up before every rewrite because `~/.claude` is not in git.

**`drb`.** A bash script: with no argument, `cd ~/projects/os` and `exec claude "$@"`; with a lane name as the first argument, `cd ~/projects/worktrees/<lane>` and, before launching, create `~/.claude/projects/-home-drbartender-projects-worktrees-<lane>/memory` as a symlink to the main memory directory if it does not exist (spec 6.5), then `exec claude` with the remaining arguments. Refuses a lane name whose worktree does not exist.

**Acceptance checks**

1. `~/.claude/CLAUDE.md.bak-20261020` exists and is byte-identical to the file before the edit.
2. The new file is at most 45 lines; every rule line ends with a `]`; the file contains no em dash character.
3. The memory rule and the rules the rev 1 file carried (review standing, no compaction) survive verbatim in meaning: a reviewer reads old and new side by side and lists any rule dropped; the list must be empty.
4. `drb --help` prints the claude help from `~/projects/os`; `drb invoice-step --help` prints it from that worktree, and `readlink ~/.claude/projects/-home-drbartender-projects-worktrees-invoice-step/memory` resolves to the main memory directory.
5. `drb nope` exits non-zero with a one-line message naming the missing worktree.
6. The manifest list for step 5 is written at the end of this plan's commit message or as a section in the step 5 plan: keep (code-preservation, explicit-staging, no-add-dot, no-reset-main, no-amend-pushed, destructive-approval, push-fail-stop, stripe-test-mode, stripe-fails-closed, hosted-bartender-ratio, proposal-payment-status, money-cents, encryption-pii, doc-updates as the one-sentence rule), move (gratuity to `docs/money-laws.md`, pointer stays; env-debug-discipline to the global file; design-review-fleet to the review skill, one pointer line), retire (inline-self-check as a checklist; file-size-ratchet prose beyond one pointer line).

## Lane: memory-prune

**Scope.** Spec 6.5, the step-1 half. Nothing here touches the repo.

**Work, in order**

1. **Backups.** Copy the memory directory to `~/.claude/projects/-home-drbartender/memory.bak-20261020/` (never loaded; a plain copy) before the first edit.
2. **Windows-era paragraphs.** In `machine-remote-access.md`, `project-linux-dev-box.md`, `project-workflow-redesign.md`, `reference_dev_server_process.md`, `project-worktree-workflow.md`, `reference_staff_portal_local_review.md`, `reference-zul-dev-setup.md`: remove the paragraphs marked STALE or TRANSITIONAL or describing `taskkill`, PowerShell, `netstat`, junctions or `%USERPROFILE%`; keep every Linux fact; where a file would be left with nothing live, move it whole to `_archive/`. Each edit is a paragraph removal, never a rewrite of a kept paragraph.
3. **Corrections, each with its evidence written into the corrected line:**
   - `reference-payroll-completion-gate.md`: the verify command is stale; the fix is on main at `5b7c111a`.
   - `reference-contractor-profiles-updated-at-trigger.md`: the trigger pattern landed in `c10ae187`, not `677baf95` (which is the dbTarget banner).
   - `reference-gratuity-fee-netting.md`: the ruling was Dallas's, not Dan's.
   - `project-gratuity-redesign.md`, `project-linux-dev-box.md`, `project_paystub_pdf_pipeline.md`, `project-thumbtack-autodraft.md`, `project-thumbtack-comms-noise.md`, `reference-sentry-access.md`, `reference-stripe-webhook-api-version.md`: each mention of Dan on a DRB code, infra or workflow subject becomes Dallas (user-identity.md, 2026-08-19); a mention about the Wildlight business stays.
   - The sweep: every memory line that says a sha or lane is unpushed, unmerged, open or owed is checked: `git merge-base --is-ancestor <sha> origin/main` for shas; `git log --grep 'merge(lane <name>'` for lanes; the line is corrected with the result and the date, or left alone with no note when the check cannot be run. `project-mobile-admin.md` (ma-f3 "unpushed"), the 8/16 push notes, and the four lanes the collectors flagged (`smsInbound.js` and `answeringMessageTypes.js` listed, the CANT residual, the Thumbtack duplicate-client fix) are the known cases; the sweep covers every file.
4. **Dangling links.** Rewrite each to the file that exists: `claude-code-agent-discovery` to `reference_claude_code_agent_discovery`; `feedback-brainstorm-no-final-review`, `feedback-codex-trust`, `feedback-max-effort-multifile` to their underscore twins; `os_shared_git_index` to `reference_os_shared_git_index`; `project-check-cherry-cutover` to `project_check_cherry_cutover`; `project_client_portal` to `project-client-portal`; `project-comms.md` to `project-comms`; `project-external-payment-parked` to `project_external_payment_parked`; `project-redesign-surface-prompts` to `project_redesign_surface_prompts`; `review-proportionality` to `feedback_review_proportionality`; `sms-phone-routing` to `reference-sms-phone-routing`; `subagent-model-opus` to `feedback_subagent_model_opus`; `project-potion-planner-redesign` to `project-potion-planner-v2`. Remove the link and keep the sentence for the ones with no successor: `project-hotspot-until-2026-09-22`, `reference_codex_cli_windows`, `reference_gemini_cli_windows`, `reference_vercel_cli_windows`, `reference_worktree_npm_install_junction`, `reference_worktree_rm_locked_folder_windows`, `subagent-model-always-opus`.
5. **Provenance brackets.** Every `type: feedback` memory gets, as the first body line, `[Dallas YYYY-MM-DD]` when the file quotes or dates his words (the date from its own record; the file's modification date marked "approx." when the body has none), or `[Claude default]` when the rule is Claude-derived. `reference-playwright-clipped-control-false-pass.md` is mistyped feedback; it becomes `type: reference`.
6. **The index.** `MEMORY.md` is rewritten: the same group headings, one line per surviving memory, title plus a hook of at most twelve words, no sha, no merged, pushed or unpushed state, no "next" or "owed". The money-law glosses are replaced by one line pointing at `docs/money-laws.md` (which has merged by then). The push-day notes stay listed until the flip (6.5).
7. **The os-launch memory root.** The four files under `~/.claude/projects/-home-drbartender-projects-os/memory/` are moved to the main `_archive/`; the directory is replaced by a symlink to the main memory directory.
8. **`_archive/README.md`** lists what was archived and why, one line each, dated.

**Acceptance checks**

1. For each of the seven Windows-era files, the diff against the backup removes only paragraphs that contain one of the marker words and adds nothing; a reviewer reads the seven diffs once.
2. A link check over the memory directory (`grep -oh '\[\[[^]]*\]\]'` resolved against the file list) reports zero dangling links.
3. Every corrected line contains the sha, lane name or command that justified it and the date 2026-10-20; the sweep's list of checked claims and results is in the lane's report.
4. Every feedback memory's first body line matches `^\[(Dallas|Claude)`.
5. `MEMORY.md` matches none of `[0-9a-f]{8}`, `unpushed`, `UNPUSHED`, `MERGED`, `PUSHED`, `next `, `OWED` (case-insensitive); the money-law section is one pointer line; the line count is at most 80.
6. `readlink ~/.claude/projects/-home-drbartender-projects-os/memory` resolves to the main memory directory, and `ls _archive/` lists the four June files.
7. A fresh session launched through `drb` loads the new index (checked by reading the session's first system reminder in its transcript).

## Lane: step1-docs

**Scope.** Three files, on a lane named `rewrite-step1` cut from main with `npm run worktree:new`.

**`docs/money-laws.md`.** One section per law, each: the rule in one or two sentences; the code it lives in (`file:function` or `file:line`); the memory or spec it came from; a provenance bracket; and a "checked against code 2026-10-20" line written only after the check. The laws (spec 6.4): the retainer survives full payment (read off the upgrade breadcrumb, never the label); `acknowledged_total` is row truth and create-intent's total is a projection; a `?paid=true` load never renders money; frozen rates beat the live catalog; the label partition, its five constant sets, and that a label is neither a semantic nor a key; the addon quantity column's stored shape per billing type and `storedToInputCount`; off-ledger invoice labels join `OFF_LEDGER_INVOICE_LABELS`; the paid flag is `amount_paid` plus `external_paid` against `total_price`, never status or payment type; refund scope (allowance is headroom plus contract slack); the hosted 1:100 bartender ratio through `isHostedPackage`; owner no-draw payouts; which pay period is now is `chicagoTodayYmd()`, never SQL `CURRENT_DATE`; the stale-proposal sweep never adds `accepted` to its statuses; the gratuity rules, moved verbatim from the current project CLAUDE.md paragraph; the legal-hold proposal, by id, with the actions that never touch it. A closing line says who reads this file: the review skill before any money lens, the money lens's brief, the externals' brief, and any session before a money-path change.

**`docs/dev.md`.** Sections: starting the backend (a Claude-managed background process, no reload, restart after server edits, the port and the two lines to wait for); starting the client (the three command-line env flags, not in `client/.env`); the two-hour background limit; what a subagent cannot do (mint a dev token; `dev-signin.js` is the controller's); running tests (the suites share the dev database; one at a time; never from a lane while another runs; read the pass count; never CREATE TEMP; the money smoke through `npm run test:smoke`); the Node mismatch (box 24.16.0, prod 26.5.0) and the caveat on fixing it; the Neon dev and prod branch ids and that prod data fixes go through a guarded DO block; the Render service (`os`, dashboard-created, start command, no health check path today, the rollback lever in the dashboard); the win-share clone (a July copy, not a source of rules). Every "how to" line is written only after it was run on 2026-10-20, or carries "from memory, not re-run on 2026-10-20".

**`AGENTS.md`.** Ten lines: what the repo is in one line; read `.claude/CLAUDE.md` for the rules; read `docs/money-laws.md` before touching money; read `docs/dev.md` to run anything; the repo is public, ids only; no em dashes in prose; nothing else.

**Acceptance checks**

1. Every `file:function` pointer in `docs/money-laws.md` resolves (`grep -n` finds the function in the file).
2. A verify pass (Fable, the agent file inlined since the session may not register project agents) reads each law against its code and returns a table, one row per law: pass, or a finding with the line that contradicts the law. Zero findings before merge; a finding is fixed in the doc or, if the code is wrong, recorded as a defect for the ledger and the law stays as the rule.
3. `docs/dev.md`: the backend start recipe was run once on a spare port during the lane and stopped; the output lines it names were seen; the Neon branch ids were confirmed read-only through `list_branches`; the Render settings match the CLI listing from 2026-10-19.
4. No em dashes, no email, no real-format phone number, no client or staff name in the three files (the PII shapes grep from the audit tooling).
5. `AGENTS.md` is at most 12 lines and contains no rule that is not a pointer.
6. The lane merges through `scripts/merge-lane.sh rewrite-step1 docs/superpowers/plans/2026-10-20-instruction-rewrite-step1.md` from `os` on main; nothing is pushed.

## Test plan

Prose and configuration; the tests are the acceptance checks above, each a command or a read with a stated pass condition. The lane report lists each check with its result.

## What this step does not do

The project CLAUDE.md, the agents, the commands, the skill, the hooks and every script are steps 2 to 5. The manifest edit is step 5's first commit (deviation above). The push-era memory notes stay until the flip.
