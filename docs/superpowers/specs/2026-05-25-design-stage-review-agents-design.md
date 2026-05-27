# Design-Stage Review Agents

## Background

The code-stage review fleet (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`, plus `ui-ux-review` on explicit invocation) is strong: it runs in parallel before every code-touching push to `main` and catches misses that surface once the diff exists.

What it can't catch: the spec already assumed the wrong shape; the plan forgot a touchpoint; the design referenced a pattern that doesn't actually exist in the codebase. Those defects cost more to fix in code than in prose.

`/gemini-spec` partially fills this gap with long-context Google Gemini 2.5 Pro, but it is a single second-opinion lens from outside Anthropic. The brainstorming-to-spec pipeline that produces the doc should also have an in-family Claude fleet that mirrors the rigor of the code-stage fleet on the design surface.

## Goal

A six-agent design-stage review fleet (three agents for specs, three for plans), invoked explicitly via slash command or natural language at the end of brainstorming or writing-plans, before any code is written. Findings come back severity-tagged and consolidated, same shape as the code fleet.

## Non-goals

- Auto-firing after brainstorming or writing-plans saves the doc. Section-by-section approval during brainstorming IS the final approval (per the standing rule). These agents are an optional deeper audit, not a re-approval gate.
- Replacing `/gemini-spec`. Claude fleet leads; Gemini supplements when a second opinion is wanted (same pattern as Claude code fleet + Codex on the code side).
- Auto-fixing anything. Report only. The user folds findings back into the spec or plan doc by hand or with Claude's help in the same session.
- A UI/UX agent at design stage. The spec is text; there is no surface to screenshot. Visual review stays at code stage where `ui-ux-review` already handles it.

## The fleet

### Spec agents

**spec-grounding** verifies the spec is grounded in the actual current codebase, not the codebase as the brainstormer remembered it.

Checks:
- Every file, function, route, table, and column the spec names actually exists at that location.
- Every claim of the form "we'll mirror X" or "we'll extend Y" is checked: does X/Y actually have the shape the spec assumes?
- Hidden invariants from `CLAUDE.md` that the spec might be about to break: hosted-bartender 1:100 rule, `event_type` vs `event_name` separation, money stored as integer cents, `AppError` vs `res.status().json()` for client-visible errors, encryption for bank PII, drink-plan event-side is canonical.
- Cross-Cutting Consistency table from `CLAUDE.md`: if the spec adds a column or changes an API shape, does it enumerate every route, component, display, email, and PDF that touches it?

**spec-gaps** surfaces what the spec does not say: flows it should cover but glosses over.

Checks:
- Loading, empty, and error UI states for any new surface the spec describes.
- Null / undefined handling for new fields, missing related entities (deleted user, deleted proposal), boundary conditions (date ranges, pagination, off-by-one).
- Refund, cancellation, and reversal of the new behavior.
- Race conditions, double-submit, concurrent edits on the new mutation.
- Migration path for existing rows: what is the default for old data on the new column or state?
- Backwards-compat for in-flight tokens, half-paid invoices, scheduled emails or SMS.
- Server vs client validation parity.
- Audit and observability adequate to debug the new flow later.

**spec-risk** pre-flights the design through the high-stakes lenses: money, auth, data integrity, side effects.

Checks:
- Money: pricing math in integer cents (never floats), refund paths, deposit handling, tip flow, Stripe live vs test mode, paid-in-full re-evaluation after total mutation, Connect / payout impact.
- Auth: who can call this, IDOR exposure, role guards (admin, manager, bartender, public-token), token expiry and leak surface.
- Data integrity: multi-table writes wrapped in `BEGIN` / `COMMIT` / `ROLLBACK`, schema change rollback path, soft vs hard delete, foreign-key implications.
- Side effects: emails and SMS dispatched on this path. Idempotency, dedupe, suppression checks, runaway guards.
- Webhook signature verification, replay protection, secrets routed through env, PII encryption, graceful degradation when Resend, Twilio, Stripe, or R2 fail.

### Plan agents

**plan-fidelity** verifies the plan implements the spec with no scope creep and no scope drop.

Checks:
- Every behavioral requirement in the spec maps to one or more plan steps, or is explicitly deferred with a noted reason.
- Every plan step traces back to a spec requirement (no rogue refactors smuggled in).
- Spec decisions the plan re-decides differently are surfaced as conflicts.
- Edge cases the spec named each have a plan step.
- The spec's Cross-Cutting Consistency rows: the plan touches all the named places.

**plan-decomposition** verifies the plan is reviewable, testable, and revertable.

Checks:
- Batch boundaries respect `CLAUDE.md` commit rule 3: one logical feature per commit, not per file, not multi-feature mega-commits.
- Each batch ends at a verifiable checkpoint the user can manually test in the app.
- No forward dependencies (batch 4 does not need batch 6 to make sense).
- Automated tests where they fit (node:test for utils); manual verification list where they don't.
- Each batch could be reverted without breaking earlier batches.
- Execution-review cadence: which specialized review agents should fire at which checkpoint (per the existing review-cadence pattern).

**plan-feasibility** verifies each plan step is actually executable against the current codebase.

Checks:
- Each step names specific files and section markers where useful.
- Function signatures the plan references match the current code.
- Step ordering: schema before reader, env var set before code reads it, dependency before consumer.
- Test commands the plan invokes actually exist (correct `npm` script names).
- File-size ratchet respected: no step pushes a file over the soft cap without a split sub-step.

## Trigger and orchestration

Two slash commands in `.claude/commands/`:

- `/review-spec [path]`
- `/review-plan [path]`

Natural-language phrases route to the same commands: "review the spec", "review the plan", "design review", "review my spec", "review my plan", and equivalents. When Claude sees one of these and a target is obvious from conversation context or recent commits, it invokes the corresponding command without asking again.

Each command:

1. **Resolve target.** Resolution order (first match wins):
   1. If `$ARGUMENTS` ends in `.md` and the file exists, use that path.
   2. If the conversation just produced or referenced a specific spec or plan path, use that.
   3. Otherwise, use the most recently modified file in `docs/superpowers/specs/` (for `/review-spec`) or `docs/superpowers/plans/` (for `/review-plan`).
   4. If multiple candidates within 5 minutes of each other, ask which one.
2. **Launch fleet.** Single message, three concurrent `Agent` tool calls (one per agent), each with a prompt that names the resolved path and the agent's checks.
3. **Wait for all three. Consolidate.** Group findings by severity (Blockers / Warnings / Suggestions). Within each severity, group by agent so the user knows which lens caught what. If two agents converge on the same finding, mark it as cross-confirmed (strong signal).
4. **Report.** No auto-fix. The user decides what to fold back into the spec or plan.

## Agent file format

Each of the six agents is a separate file in `.claude/agents/`, following the existing pattern:

```yaml
---
name: spec-grounding
description: <one-line role; appears in Agent tool selection>
tools: Read, Grep, Glob, Bash
model: opus
color: <distinct from existing agents>
maxTurns: <budget>
---
```

`maxTurns` budget:
- 25 for `spec-grounding`, `plan-feasibility` (heavy codebase reading).
- 15 for the others (mostly doc-bound).

Body of each agent file:
1. Mission statement (one or two sentences).
2. How to start: read the target file (path supplied in the invocation prompt), then perform the agent-specific reads.
3. Numbered checks (the bullets above, expanded with examples and grep patterns where useful).
4. Output format spec.

## Output format

Each agent returns:

```
## Blockers
- [spec section: <section>] <one-line concern>
  <optional short paragraph if context needed>

## Warnings
- [spec section: <section>] <one-line concern>

## Suggestions
- [spec section: <section>] <one-line concern>

## Summary
<one or two sentences on overall design health for this agent's lens>
```

If a severity is empty, the agent omits that section. If the agent finds nothing, it returns:

```
## Clean
<lens name>: no findings.
```

The orchestrating command consolidates the three reports into a single severity-grouped view, tagging each finding with the agent that raised it:

```
## Blockers
- [grounding] spec section 3 says we'll extend proposalRules.js but no such file exists
- [risk] paid_in_full flag is not re-evaluated after the new admin override

## Warnings
- [gaps] spec does not describe the empty state for the new staff payout list
- [gaps] no refund path described for the new add-on

## Suggestions
- [grounding] consider mirroring the eventTypes.js ESM/CJS twin pattern explicitly

## Summary
2 blockers, 2 warnings, 1 suggestion. Grounding and risk both flagged proposal-side mutations.
```

If all three agents return Clean, the command outputs a single line: `Design fleet: clean across all three lenses.`

## Workflow position

```
brainstorm
  -> save spec
  -> [optional] /review-spec  (or "review the spec")
  -> fold findings into spec
writing-plans
  -> save plan
  -> [optional] /review-plan  (or "review the plan")
  -> fold findings into plan
executing-plans
  -> code
  -> push  (auto code-fleet fires per CLAUDE.md Pre-Push Procedure)
```

Same explicit-only philosophy as `/review-before-deploy` and `/gemini-spec`. The user invokes when the spec or plan is non-trivial enough to warrant the pass; skips on quick fixes.

When findings flag something non-trivial, the user edits the spec or plan in place, or re-enters brainstorming / writing-plans for a major rethink, then optionally re-runs the reviewers. No `systematic-debugging` skill required: there is no code yet.

## Files created

```
.claude/agents/
  spec-grounding.md
  spec-gaps.md
  spec-risk.md
  plan-fidelity.md
  plan-decomposition.md
  plan-feasibility.md
.claude/commands/
  review-spec.md
  review-plan.md
```

`CLAUDE.md` gets a one-line addition under the review section, naming the two commands and noting they are explicit-only.

## Relationship to existing tools

- **Code fleet** (`/review-before-deploy` and auto-on-push): code stage. Unchanged.
- **`/gemini-spec`**: long-context second opinion from Google Gemini. Unchanged. Still the right tool for high-stakes designs (Stripe, OTP, payouts) where cross-LLM convergence matters.
- **`/codex-review`**: code-stage second opinion from OpenAI Codex. Unchanged.
- **New design fleet**: in-family Claude reviewers at design stage. Mirrors the rigor of the code fleet on the design surface.

Convergence rule: when the new `spec-risk` agent and `/gemini-spec`'s risk-areas pass both flag the same item, that is a strong signal worth treating as a blocker even if neither labeled it that way.

## Open questions

None. All operational details are spelled out above; ready for an implementation plan.
