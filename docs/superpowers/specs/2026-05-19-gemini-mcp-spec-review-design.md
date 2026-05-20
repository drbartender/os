# Gemini MCP Spec Review — Design

**Date:** 2026-05-19
**Status:** Approved (design)

## Summary

Add Google Gemini 2.5 Pro as a **design-stage reviewer** via MCP, gated
behind `/gemini-spec`. Distinct from `/codex-review` (which stays as the
code/diff reviewer) — Gemini's long-context strength is wasted on diffs but
shines on whole-codebase questions you ask BEFORE writing code: "does this
spec miss anything?", "if we implement this, what does it conflict with?",
"did the author think about X risk class?"

Package: [`gemini-mcp-tool`](https://www.npmjs.com/package/gemini-mcp-tool)
v1.1.4. Auth: OAuth via Google account through `@google/gemini-cli` (free
tier, ~1000 Pro requests/day, no API key).

## Two tools, two stages

| Stage | Tool | Why |
|---|---|---|
| **Design / spec / plan** (pre-code) | `/gemini-spec` | Gemini's 1M-token context can hold the spec + the relevant codebase + related docs at once. Strong at gap-finding, cross-cutting impact analysis, and risk-pattern checklists before any code is written. |
| **Code / diff** (pre-push) | `/codex-review` | Codex is strong at the "you forgot to handle X" class — OTP edges, webhook idempotency, missing transactions, off-by-ones. Diff-scoped review where long context isn't useful. |

The two are **stage-complementary**, not competing. They're not meant to be
swapped or run on the same artifact most of the time.

### Money/auth bonus pattern

For Stripe webhooks, OTP flows, payouts, and auth changes — run both. The
two LLMs have different priors and disagree usefully on high-stakes code.
Encoded as a recommended-practice note in each slash command's docstring,
not as a CLAUDE.md hard rule (so you can override case-by-case).

Typical staged flow on a money/auth feature:

1. Brainstorm spec → write to `docs/superpowers/specs/`
2. `/gemini-spec risk-areas <path>` — Gemini checks the design against the
   project's known risk-pattern catalog
3. Iterate on the spec until clean
4. Write the code
5. `/codex-review risk-areas` — Codex checks the diff against the same
   catalog
6. Push

## Why not /gemini-review on diffs

Originally drafted as `/gemini-review` (third-opinion code review). User
correctly pointed out this underuses what Gemini is best at and overlaps
with Codex's strength. Reorienting to design-stage is sharper:

- Gemini's value-add over Codex on diffs alone is marginal (different
  priors, but Codex is already strong at diff review).
- Gemini's value-add on whole-codebase design questions is asymmetric —
  Codex literally can't do this work because the diff-scoped CLI doesn't
  ingest the surrounding codebase.

The renamed slash command makes the division of labor obvious at the call
site. No ambiguity about which tool to reach for.

## Non-goals

- **Not always-on.** Same intentional-invocation discipline as Codex. Not
  added to the auto-run agent fleet (Rule 6).
- **Not replacing Claude agents or Codex.** Both stay.
- **No write capability.** `gemini-mcp-tool` exposes only read tools
  (`ask-gemini`, `sandbox-test` in Google's sandbox, `Ping`, `Help`). No
  deny rules needed.
- **No OpenAI API key in repo.** OAuth-only.

## Design

### 1. MCP server config — `.mcp.json` at project root

Unchanged from the original spec. Project-scoped, committed to repo:

```json
{
  "mcpServers": {
    "gemini-cli": {
      "command": "npx",
      "args": ["-y", "gemini-mcp-tool"]
    }
  }
}
```

### 2. Slash command — `.claude/commands/gemini-spec.md`

Renamed from `gemini-review.md`. Argument table reorients from diff-review
presets to design-review presets:

| Arg | Behavior |
|---|---|
| *(empty)* | Review the most recent file in `docs/superpowers/specs/` |
| `<path>.md` | Review that specific spec or plan file |
| `code-impact <path>` | Find existing files that need parallel updates the spec doesn't mention. Long-context advantage. |
| `risk-areas <path>` | Audit the design against known risk patterns: OTP edges, webhook idempotency, transaction safety, cross-cutting consistency |
| Free text | Pass-through prompt |

Full preset prompts live in `.claude/commands/gemini-spec.md`.

### 3. Output format — `═══ GEMINI ═══` template

Every Gemini prompt appends a required-output-format block instructing
Gemini to wrap findings in `═══ GEMINI (spec review) ═══` separators with
`▸ [BLOCKER|WARNING|SUGGESTION]` bullets. Goal: at-a-glance distinction
from Codex output without using emojis.

```
═══ GEMINI (spec review) ═══

▸ [BLOCKER] section 3 — missing error path for X
▸ [WARNING] section 5 — conflicts with server/utils/pricingEngine.js:88
▸ [SUGGESTION] consider Y

═══════════════════════════
```

If no findings: `Looks clean.` inside the envelope.

### 4. Codex changes — add `risk-areas` preset + output wrapping

`.claude/commands/codex-review.md` gets two small updates:

1. **New `risk-areas` preset** mirroring `/gemini-spec risk-areas` but
   scoped to the diff: scan for OTP edge cases, webhook idempotency
   gaps, missing DB transactions, and the "you forgot to handle X" class.
2. **Output wrapping instruction**: when relaying Codex output, wrap the
   verbatim prose in `═══ CODEX (code review) ═══` ... `═══════════════════════════` separators. The prose itself stays untouched (Codex's GPT-style prose is information-dense and shouldn't be reshaped), but the wrapper gives parity with Gemini's visual envelope for at-a-glance differentiation.

### 5. Permissions — `.claude/settings.local.json`

Same six entries as the original spec — tied to the MCP server name
(`gemini-cli`), not the slash command name. Rename doesn't affect them.

- `mcp__gemini-cli__ask-gemini`
- `mcp__gemini-cli__sandbox-test`
- `mcp__gemini-cli__Ping`
- `mcp__gemini-cli__Help`
- `Bash(gemini *)`
- `Bash(npx -y gemini-mcp-tool*)`

(Auto Mode classifier blocked the edit in this session — user adds the
entries manually OR accepts a one-time permission prompt on first MCP
call.)

### 6. Auth — unchanged from original

One-time user step: `npm install -g @google/gemini-cli` + run `gemini` once
to OAuth. Already documented in `gemini-spec.md`'s Prerequisites section.

### 7. No CLAUDE.md / README / ARCHITECTURE updates

Same reasoning as the original: `/codex-review` isn't documented in those
files either; dev tooling stays in slash command files only.

## Implementation order

1. Write `.claude/commands/gemini-spec.md` with full argument table +
   required output format block.
2. Write this spec at
   `docs/superpowers/specs/2026-05-19-gemini-mcp-spec-review-design.md`.
3. Edit `.claude/commands/codex-review.md`: add `risk-areas` preset, add
   the `═══ CODEX ═══` output-wrapping instruction.
4. Delete the superseded files:
   - `.claude/commands/gemini-review.md`
   - `docs/superpowers/specs/2026-05-19-gemini-mcp-code-review-design.md`
5. `.mcp.json` is unchanged from original — no edit.
6. User: install gemini-cli + OAuth (one-time), restart Claude Code so MCP
   config loads.
7. Commit (user-cued).

## Verification

After install + OAuth + restart:

1. `/gemini-spec` with no args — should pull the most recent spec from
   `docs/superpowers/specs/`, review it, return findings in the templated
   envelope.
2. `/gemini-spec risk-areas docs/superpowers/specs/2026-05-19-gemini-mcp-spec-review-design.md`
   — smoke test on this very spec (recursive but fine).
3. `/codex-review risk-areas` on any recent diff — confirm output now
   wraps in `═══ CODEX ═══` envelope.
4. At-a-glance check: when both tools have run in the same session, can you
   spot which is which from 10ft away? If yes, format differentiation
   works.

## Rollback

Delete `.mcp.json`, `.claude/commands/gemini-spec.md`, revert the
codex-review.md edits, remove the permission entries. Single revert
commit, fully reversible.

## Out-of-scope follow-ups

- Adding Gemini to the auto-run fleet — not aligned with intentional
  invocation discipline.
- Multimodal Gemini for screenshot review on UI specs — interesting but
  separate scope.
- Future Gemini slash commands (e.g., `/gemini-something-else` for
  another design-stage use case) — the `/gemini-spec` name leaves room
  for siblings without conflict.
