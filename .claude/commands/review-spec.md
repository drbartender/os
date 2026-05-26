---
description: Design-stage review of a spec via 3 specialized Claude agents (spec-grounding, spec-gaps, spec-risk) in parallel.
---

You are coordinating a design-stage review of a spec.

Natural-language phrases route to this same flow: "review the spec", "review my spec", "design review on the spec", "design review", and equivalents. When the user says one of those and the target spec is obvious from conversation context or recent commits, invoke this flow without asking again.

## Step 1: Resolve target

Resolve the spec file to review by the rules below, first match wins:

1. If `$ARGUMENTS` ends in `.md` and the file exists, use that path.
2. If the conversation just produced or referenced a specific spec path (e.g., the file just saved by the brainstorming skill), use that.
3. Otherwise, use the most recently modified file in `docs/superpowers/specs/`.
4. If two or more candidates were modified within 5 minutes of each other and none was disambiguated by context, ask the user which one.

State the resolved path back in one line: `Reviewing spec: docs/superpowers/specs/<file>.md` before launching agents.

## Step 2: Launch the spec fleet in parallel

Single message, 3 concurrent `Agent` tool calls. Each agent is launched with `subagent_type` matching the agent name and a prompt that includes the resolved target path.

1. `spec-grounding` (subagent_type: `spec-grounding`)
2. `spec-gaps` (subagent_type: `spec-gaps`)
3. `spec-risk` (subagent_type: `spec-risk`)

Prompt template for each (substitute `<target>` with the resolved path and `<agent>` with the agent name):

> Review the spec at `<target>` for `<agent>` concerns. The spec has been brainstormed but not implemented yet. Apply every check in your standing instructions. Return findings in the output format you were given. Be concise; cite the spec section and the codebase location (where relevant) for every finding.

## Step 3: Consolidate

When all 3 agents return:

- Merge their findings into one severity-grouped view: **Blockers**, **Warnings**, **Suggestions**.
- Within each severity, tag each finding with the agent that raised it: `[grounding]`, `[gaps]`, `[risk]`.
- If two agents converged on the same underlying issue, mark it as `[cross-confirmed: grounding + risk]` and treat it as one finding at the higher severity.
- End with a one-line summary: `Spec fleet: N blockers, M warnings, K suggestions.`

If all three agents returned Clean, output a single line:

> Design fleet (spec): clean across all three lenses.

## Step 4: No auto-fix

Report only. Do not edit the spec. Wait for the user to decide what to fold back in.

The user may follow up by editing the spec, re-entering brainstorming for a larger rethink, or asking for a single finding to be addressed. They may also re-run `/review-spec` after edits.
