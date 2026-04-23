---
description: Second-opinion code review via OpenAI Codex CLI (GPT) — cross-LLM perspective on uncommitted changes, a diff range, or a focused sweep
---

Run OpenAI Codex (GPT) as a second-opinion code reviewer. GPT and Claude have different priors, so Codex catches what Claude-style checklists miss.

**Use Codex for what it wins at vs. Claude's narrow checklist agents:**
- Logic correctness (off-by-ones, algorithm mistakes, state-machine holes)
- Business-intent alignment (does the diff actually do what the commit message claims?)
- Architectural smell (leaky abstractions, boundaries violated, coupling that will bite later)
- Test-gap reasoning (what tests *should* exist for this change?)

**Don't** use Codex to re-run security / consistency / code-quality / DB / perf checks — those already run as dedicated Claude agents pre-push (Rule 6).

## Argument handling ($ARGUMENTS)

Resolve `$ARGUMENTS` against the table below, **in order — first match wins**:

| $ARGUMENTS value | Command to run |
|---|---|
| *(empty)* | `codex review --uncommitted` — holistic "anything look off?" |
| `tests` | `codex review --uncommitted "What tests SHOULD exist for the changes in this diff but don't? Identify missing unit tests, integration tests, and edge cases. Skip critiquing existing test quality — only flag gaps."` |
| `pricing` | `codex review --uncommitted "Verify the pricing math. This project stores money as integer cents — flag any float arithmetic. Hosted (per_guest) packages have a load-bearing rule: additional bartenders are \$0 line items with \$0 gratuity via BOTH the num_bartenders override AND the additional-bartender addon — use isHostedPackage(pkg) from server/utils/pricingEngine.js. Check rounding, tax/gratuity handling, and any arithmetic the diff touches."` |
| `intent` | `codex review --uncommitted "Does this diff actually do what the most recent commit message (or stated intent in the branch) claims? Flag any mismatch between stated intent and actual behavior, including changes that go beyond what the commit message advertises."` |
| `architecture` | `codex review --uncommitted "Architectural review only. Look for leaky abstractions, violated module boundaries, tight coupling, design decisions that will be hard to change, and places where the structure obscures intent. Skip narrow code-quality nits — the Claude code-review agent covers those."` |
| `staged` | `codex review` — staged changes only (Codex default) |
| A branch-like value (`main`, `origin/main`, `feat/xyz`) | `codex review --base "$ARGUMENTS"` |
| A commit-ish (`HEAD`, `HEAD~N`, SHA) | `codex review --commit "$ARGUMENTS"` |
| Any other free text | `codex review --uncommitted "$ARGUMENTS"` |

Edge case: if a value could match multiple rows (e.g. someone literally has a branch named `tests`), **prefer the preset keyword** — that's almost always what the user meant.

## Execution

1. Run the selected `codex review ...` command via Bash in the project root.
   - Timeout: up to 5 minutes (Codex can stream for a while on large diffs).
   - Capture both stdout and stderr.
2. If Codex fails with an auth error, stop and tell the user to run `codex login` in a terminal (uses ChatGPT account) or `export OPENAI_API_KEY=...`.
3. If Codex reports "no changes to review", tell the user and exit without a summary.

## Read-only guarantee — Codex must NEVER modify the workspace

Codex is **review-only** in this project. The slash command runs exclusively `codex review ...`. The following subcommands are **forbidden** and are additionally blocked by a deny rule in `.claude/settings.local.json`:

- `codex apply` / `codex a` — applies diffs from a previous review
- `codex exec` / `codex e` — general non-interactive execution
- `codex cloud` — can apply remote changes locally
- `codex resume` / `codex fork` — interactive sessions that could edit
- `codex mcp-server` — would expose write-capable tools
- `codex app` / `codex app-server` — GUI/server modes

If Codex output includes a suggested patch or diff, **present it to the user as text** so they can apply it manually. Do not pipe it into `codex apply` or `git apply` on the user's behalf — they decide what lands.

## Reporting

When Codex finishes:

1. **Relay the raw Codex output verbatim** so the user sees the exact reasoning, not a filtered paraphrase.
2. **Summarize** findings grouped by severity: **blockers**, **warnings**, **suggestions**. For each, give file:line and a one-line concern.
3. **Cross-check with any Claude review agents that ran earlier in this session**: if Codex flags something a Claude agent already flagged, note "Also flagged by @<agent>" — convergence across independent LLMs is a stronger signal than either alone.
4. **Do NOT auto-fix anything.** Report only. Wait for the user to direct fixes.

## Notes on using it alongside the existing Claude review flow

- The 5 auto-run Claude agents (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`) stay in place — this command is an **additional** perspective, not a replacement.
- For heavier gates (end of a major feature, pre-deploy), the user can invoke `/review-before-deploy` AND this command to get Claude-on-Claude + Claude-on-Codex coverage.
- Typical targeted use: `/codex-review pricing` after touching pricingEngine, `/codex-review tests` before merging a new feature, `/codex-review intent` on a sprawling diff to make sure it matches the stated scope.
