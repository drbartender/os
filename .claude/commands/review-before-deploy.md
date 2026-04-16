---
description: Run full pre-deploy audit — all six agents in parallel
---

You are coordinating a full pre-deploy review. Launch these six agents **in parallel** using the Agent tool (single message, six concurrent tool calls):

1. `@security-review` — full OWASP Top 10 audit of the entire codebase
2. `@code-review` — code quality, dead code, error handling, React anti-patterns
3. `@consistency-check` — cross-file schema/route/frontend synchronization
4. `@database-review` — schema, indexes, query patterns, migration safety
5. `@performance-review` — React rendering, bundle size, API perf, public-page priority
6. `@ui-ux-review` — Playwright visual + accessibility review (requires `npm run dev` running)

When all six return, consolidate findings into one report grouped by severity: **blockers**, **warnings**, **suggestions**. If any blocker exists, explicitly tell the user they should NOT push.

If the dev server isn't running, warn the user that `ui-ux-review` will fail and ask whether to start the dev server or skip that agent.
