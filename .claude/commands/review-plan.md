---
description: Design-stage review of an implementation plan via 3 specialized Claude agents (plan-fidelity, plan-decomposition, plan-feasibility) in parallel.
---

You are coordinating a design-stage review of an implementation plan.

Natural-language phrases route to this same flow: "review the plan", "review my plan", "design review on the plan", and equivalents. When the user says one of those and the target plan is obvious from conversation context or recent commits, invoke this flow without asking again.

## Step 1: Resolve target

Resolve the plan file to review by the rules below, first match wins:

1. If `$ARGUMENTS` ends in `.md` and the file exists, use that path.
2. If the conversation just produced or referenced a specific plan path (e.g., the file just saved by the writing-plans skill), use that.
3. Otherwise, use the most recently modified file in `docs/superpowers/plans/`.
4. If two or more candidates were modified within 5 minutes of each other and none was disambiguated by context, ask the user which one.

State the resolved path back in one line: `Reviewing plan: docs/superpowers/plans/<file>.md` before launching agents.

## Step 2: Launch the plan fleet in parallel

Single message, 3 concurrent `Agent` tool calls. Each agent is launched with `subagent_type` matching the agent name and a prompt that includes the resolved target path.

1. `plan-fidelity` (subagent_type: `plan-fidelity`)
2. `plan-decomposition` (subagent_type: `plan-decomposition`)
3. `plan-feasibility` (subagent_type: `plan-feasibility`)

Prompt template for each (substitute `<target>` with the resolved path and `<agent>` with the agent name):

> Review the implementation plan at `<target>` for `<agent>` concerns. The plan should reference a spec file under `docs/superpowers/specs/`; read both. Apply every check in your standing instructions. Return findings in the output format you were given. Be concise; cite the plan task and step and the codebase location (where relevant) for every finding.

## Step 3: Consolidate

When all 3 agents return:

- Merge their findings into one severity-grouped view: **Blockers**, **Warnings**, **Suggestions**.
- Within each severity, tag each finding with the agent that raised it: `[fidelity]`, `[decomposition]`, `[feasibility]`.
- If two agents converged on the same underlying issue, mark it as `[cross-confirmed: fidelity + feasibility]` and treat it as one finding at the higher severity.
- End with a one-line summary: `Plan fleet: N blockers, M warnings, K suggestions.`

If all three agents returned Clean, output a single line:

> Design fleet (plan): clean across all three lenses.

## Step 4: No auto-fix

Report only. Do not edit the plan. Wait for the user to decide what to fold back in.

The user may follow up by editing the plan, re-entering writing-plans for a larger rethink, or asking for a single finding to be addressed. They may also re-run `/review-plan` after edits.
