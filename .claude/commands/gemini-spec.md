---
description: Design-stage review via Google Gemini 2.5 Pro (MCP) — long-context spec/plan audit that catches gaps, missing edge cases, and conflicts with existing patterns BEFORE code is written
---

Run Google Gemini 2.5 Pro as a **design-stage reviewer**. Gemini's 1M-token context can hold the whole codebase + the spec + related docs at once, which makes it strong at "does this spec miss anything?" and "if we implement this, what existing code does it conflict with?" — questions you want answered before any code lands.

**Use `/gemini-spec` for what Gemini wins at:**
- Spec and plan review — catching missing edge cases, unstated assumptions, contradictions with existing code patterns
- Code-impact analysis — "if we implement this design, which existing files need parallel updates that the spec doesn't currently mention?"
- Risk-area design checklist — "did the spec author think about OTP edge cases / webhook idempotency / transaction safety / failure modes?"

**Use `/codex-review` for code-stage review** — diff scrutiny, "you forgot to handle X" class, pre-push gates. Different tool, different stage.

**Bonus pattern: run both on money/auth subjects.** Stripe webhooks, OTP flows, payouts, auth changes — `/gemini-spec` at design time, `/codex-review` before pushing. They disagree often enough on high-stakes code that a second opinion pays for itself.

## Prerequisites (one-time)

`gemini-mcp-tool` shells out to `@google/gemini-cli`. If `/gemini-spec` errors with an auth message:

```
npm install -g @google/gemini-cli
gemini
# OAuth browser flow → sign in with Google account
```

Credentials cache to `%USERPROFILE%\.gemini\` and persist across sessions. Free tier covers ~1000 Pro requests/day.

## Argument handling ($ARGUMENTS)

Resolve `$ARGUMENTS` against the table below, **in order — first match wins**:

| $ARGUMENTS value | Behavior |
|---|---|
| *(empty)* | Review the **most recently modified** file in `docs/superpowers/specs/`. Use `ls -t docs/superpowers/specs/*.md` or equivalent to find it. Call `ask-gemini` with the file referenced via `@docs/superpowers/specs/<file>.md` syntax. Prompt: *"Review this spec for gaps. What edge cases does it miss? What unstated assumptions does it rely on? Where does it contradict existing patterns in the codebase you can see via `@server/` and `@client/src/`?"* |
| Any path ending in `.md` (e.g. `docs/superpowers/specs/2026-05-19-foo-design.md` or `docs/superpowers/plans/2026-05-19-foo.md`) | Review that specific spec or plan. Same prompt as empty case, scoped to that file. |
| `code-impact <path>` | Long-context code-impact analysis. Call `ask-gemini` with `@<path>` plus `@server/` and `@client/src/`. Prompt: *"If we implement this spec as written, what existing files in the codebase will need parallel updates that the spec doesn't currently mention? Per CLAUDE.md's Cross-Cutting Consistency rule, missed parallel updates = bugs. List file:line pairs with one-line reasons. Reference `@CLAUDE.md`."* |
| `risk-areas <path>` | Risk-pattern design checklist run against a spec. Prompt: *"Audit this design for the high-risk patterns this codebase has been bitten by before: (1) OTP / auth flow edge cases — expired codes, race conditions, rate-limit gaps, brute-force surfaces. (2) Stripe webhook idempotency — event.id dedup, signature verification, replay safety, partial-failure recovery. (3) DB transactions — multi-table writes that should be wrapped in BEGIN/COMMIT, partial-failure rollback safety. (4) Cross-cutting consistency — places where the spec changes X but doesn't mention all the consumers of X. For each finding, point to the spec section and explain what's missing."* |
| Any other free text | Pass `$ARGUMENTS` as the prompt verbatim. If there's a clear file target in the text, reference it with `@` syntax; otherwise just send the prompt. |

Edge case: a file path can theoretically match the `code-impact` pattern if the user types `code-impact` followed by a path. Use the `code-impact` preset only when the literal token `code-impact` (or `risk-areas`) appears as the first whitespace-separated token; anything else falls through to free-text or path matching.

## Required output format

Append this to every prompt sent to `ask-gemini`:

```
Format your response EXACTLY as follows. Use this template literally; do not add prose outside the envelope.

═══ GEMINI (spec review) ═══

▸ [BLOCKER] <spec section or file:line> — <one-line concern>
▸ [WARNING] <spec section or file:line> — <one-line concern>
▸ [SUGGESTION] <spec section or file:line> — <one-line concern>

If a finding needs more context than one line, add a short paragraph
immediately below the bullet. If a severity has no findings, omit that
bullet. If there are no findings at all, return only:

═══ GEMINI (spec review) ═══
Looks clean.
═══════════════════════════

═══════════════════════════
```

This template is non-negotiable — it's how `/gemini-spec` output gets distinguished from `/codex-review` output at a glance.

## Execution

1. **Resolve the target.** Run the argument table; identify the file(s) to feed Gemini.
2. **Call `mcp__gemini-cli__ask-gemini`** with the constructed prompt + `@file/path` references + the required output format block appended.
3. Timeout: up to 5 minutes (long-context reads can stream).

## Read-only guarantee — Gemini cannot modify the workspace

`gemini-mcp-tool` exposes `ask-gemini`, `sandbox-test`, `Ping`, `Help`. None modify the local workspace. `sandbox-test` runs in **Google's** sandbox, not on the user's machine.

If Gemini's output includes a suggested patch or rewrite, **present it to the user as text**. Do NOT pipe it into any edit tool — the user decides what lands.

## Reporting

When Gemini finishes:

1. **Relay the templated output verbatim** so the user sees the exact format. Don't strip the `═══` separators or the bullets.
2. **Cross-check with any `/codex-review` from earlier in the session**: if Gemini flags something Codex already flagged, note "Also flagged by Codex" — convergence across independent LLMs is the strong signal.
3. **Do NOT auto-fix anything.** Report only. Wait for the user to direct fixes.

## Notes on using it alongside the existing review flow

- The 5 auto-run Claude agents (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`) stay in place — they run on code, pre-push. `/gemini-spec` runs on designs, pre-code.
- `/codex-review` covers the code-stage review surface. `/gemini-spec` and `/codex-review` are stage-complementary, not competing.
- Typical use:
  - Just finished a brainstorming spec? → `/gemini-spec` to catch gaps before writing-plans.
  - Spec touches Stripe / OTP / payouts? → `/gemini-spec risk-areas <path>` for the high-risk checklist.
  - About to merge a sprawling refactor? → `/gemini-spec code-impact <path>` first to find missed consumers, then implement, then `/codex-review` the diff.
