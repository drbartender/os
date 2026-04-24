---
description: Quarterly fine-tooth-comb audit of the whole codebase. 3 Claude agents + Codex + Sentry cross-reference. Report-only, no auto-fixes.
---

Run a whole-codebase audit aimed at the issues that per-push reviews CAN'T catch: drift across many commits, cumulative attack surface, bundle/schema bloat, dead code that piled up. Not a re-run of what's already reviewed per push.

**Mode: report-only.** Never auto-fix. Never commit. Never push. The findings list is the whole output — the user triages in the morning and picks what to address.

## Preflight

1. `git rev-parse --abbrev-ref HEAD` — must equal `main`. Otherwise log `skipped: wrong branch (<actual>)` and exit.
2. `git status --porcelain` — should be clean. If dirty, log `skipped: dirty working tree` and exit (don't want agents confused by WIP).
3. Record timestamp: `AUDIT_DATE=$(date -u +%Y-%m-%d)`. Log file path: `.claude/full-audit-${AUDIT_DATE}.log`.
4. Record current HEAD: `AUDIT_HEAD=$(git rev-parse HEAD)`.

## Step 0 — Pull unresolved Sentry issues

Use the Sentry MCP (`mcp__sentry__*` tools) to pull unresolved issues across `drbartender-server` and `drbartender-client` projects, org `dr-bartender`. Cap at 30 per project, sorted by event count DESC. Record the list — agents will cross-reference their findings against real prod errors.

If Sentry MCP is unavailable or errors, log `sentry pull skipped: <reason>` and proceed without it — don't abort.

## Step 1 — Three Claude agents in parallel

Launch in a single message, three concurrent `Agent` calls. Each gets a whole-codebase scope and a prompt that emphasizes **what per-push reviews miss**.

### @consistency-check — highest-value agent tonight

Prompt: "Whole-codebase drift hunt. Per-push reviews have handled individual changes; your job is to find drift that accumulated across many commits. Start from `server/db/schema.sql` — for every column/table, grep every consumer (server routes, client components, PDF/email templates, scripts). Flag:
- Columns referenced with old/renamed names in stale handlers
- Deprecated fields still used somewhere
- Server route paths that don't have matching `App.js` routes (or vice versa)
- API response shape changes handled by some consumers but not others
- `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` folder trees drifting from actual filesystem
- Server `eventTypes.js` ↔ client `eventTypes.js` divergence
- `server/utils/errors.js` AppError subclasses not handled uniformly in global error middleware

Produce findings as: `[severity] <file:line> — <drift description>` with remediation one-liner. Severity: BLOCKER / WARNING / SUGGESTION."

### @security-review — cumulative attack surface

Prompt: "Whole-codebase OWASP Top 10:2025 audit, emphasis on CUMULATIVE surface area. Per-push review sees a single change; you see everything that exists now. Focus:
- A01 Access Control: every non-public route has `auth` middleware? every ownership check uses `req.user.id`? token-gated routes (proposals, drink plans, invoices) scope properly to the token's resource?
- A02 Misconfiguration: CORS, Helmet CSP, error leakage, `STRIPE_TEST_MODE_UNTIL` residual
- A03 Supply chain: `npm audit` output, lockfile integrity, suspicious postinstall
- A05 Injection: grep for SQL template literals or string concat in `.query()`, `dangerouslySetInnerHTML`, command injection, path traversal in storage/R2 paths
- A08 Data integrity: webhook signature verification (Stripe, Resend, Thumbtack), transaction atomicity
- A09 Logging: Sentry init (confirm DSN gating), PII redaction in `beforeSend`
- A10 Exceptions: every async route handler wrapped in `asyncHandler`? every BEGIN has a ROLLBACK on error branch?

Cross-reference: for each Sentry issue (if list provided), check whether a finding in your audit is its root cause.

Format: `[severity] <file:line> — <issue> — <remediation>`. Severity: BLOCKER / WARNING / SUGGESTION."

### @performance-review — bundle + public pages

Prompt: "Whole-codebase performance pass focused on cumulative bloat. Per-push review sees incremental weight; you see the full picture.

Client bundle:
- Heavy imports (`moment`, full `lodash`, unused `@sentry/*` paths, oversized icon sets)
- Missing lazy-loading on admin-only pages, blog admin, rich-text editor
- Dead code shipped to client

Public-facing pages (priority — these are user-seen):
- `client/src/pages/website/HomePage.js`
- `client/src/pages/plan/PotionPlanningLab.js` (+ its steps/ subdirectory)
- `client/src/pages/proposal/ProposalView.js`
- `client/src/pages/public/Blog.js` + `BlogPost.js`
- `client/src/pages/invoice/InvoicePage.js`

Server:
- N+1 query patterns across all route files
- `SELECT *` without specific column lists
- Missing `LIMIT` on list endpoints
- Sequential `await` that could be `Promise.all`
- Oversized API responses (returning full `proposals.questionnaire_data` blobs when only summary is used, etc.)

Format: `[severity] <file:line> — <perf issue> — <remediation>`. Severity: BLOCKER (user-facing slowness) / WARNING (notable bloat) / SUGGESTION (nice-to-have)."

## Step 2 — Codex passes (supplementary, runs in parallel with Step 1)

Codex is a second opinion, not the primary reviewer. Run three serial `codex review` passes; if any errors out, log it and proceed.

First, find the initial commit: `FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD | tail -1)`.

1. **Server architecture sweep:**
   ```
   codex review --base "$FIRST_COMMIT" "Whole-codebase architecture sweep of server/ only. Look for: leaky abstractions, violated module boundaries (routes that duplicate util logic, utils that reach into routes), tight coupling that'll bite during feature work, business-intent drift (code that doesn't match the file/folder name anymore), patterns that started coherent but have fragmented across small changes. Skip security/perf/consistency — those already have dedicated Claude agents. Skip code-quality nits (long functions, naming) — low value here."
   ```

2. **Client architecture sweep:**
   ```
   codex review --base "$FIRST_COMMIT" "Same architectural lens, but client/src/ only. Leaky abstractions, components that became state orchestrators they shouldn't be, props-drilling depth, context misuse, routing coherence, shared utilities that drifted. Skip perf (Claude agent handles that). Skip code-quality."
   ```

3. **Logic + test gaps (runs AFTER Steps 1+2 finish):**
   Pass Codex the consolidated Claude findings and ask it to critique.
   ```
   codex review --uncommitted "Second-opinion on the attached findings list. Do you agree with the severity assigned to each? Any you think are false positives? Any categories you think were missed entirely — particularly in logic correctness, state machine holes, test coverage gaps for money/auth/webhook paths?"
   ```
   (Stage a temp file with the findings before calling this so `--uncommitted` has something to review; then `git reset HEAD <tempfile>` and delete it after.)

If Codex auth fails: log `codex skipped: run 'codex login' first` and continue with Claude-only findings.

## Step 3 — Consolidate + cross-reference

Merge findings from all 3 Claude agents + 3 Codex passes + Sentry. Build the report.

**Cross-reference rules:**
- If both a Claude agent AND Codex flag the same `file:line`, mark `[CONVERGENCE]` — stronger signal.
- If a finding maps to a Sentry issue (same file/route as a prod error), mark `[SENTRY: <issue-id>]` — prioritize.
- Deduplicate obvious overlaps.

**Rank by:**
1. BLOCKER severity first
2. Within BLOCKER: convergence-flagged first, Sentry-linked next
3. Then WARNING by same rules, then SUGGESTION

Cap the top of the report at the **top 20 items**. Put the rest in an appendix. A log you won't read past item 12 is a log that failed.

## Step 4 — Write the report

Write to `.claude/full-audit-${AUDIT_DATE}.log`:

```
Full-codebase audit — <ISO timestamp UTC>
Audit HEAD: <AUDIT_HEAD>
Agents run: @consistency-check, @security-review, @performance-review
Codex passes: 3 (server / client / findings-critique)
Sentry issues pulled: <count>

## Top 20 findings (read these first)
1. [BLOCKER] [CONVERGENCE] server/routes/invoices.js:247 — <finding> — <remediation>
   Flagged by: @security-review, codex-server
2. [BLOCKER] [SENTRY: DRBARTENDER-SERVER-4A2] server/routes/proposals.js:891 — <finding> — <remediation>
   Flagged by: @consistency-check
...

## Sentry cross-reference
- <issue-id> [<count> events] <error title> — mapped to finding #<N> / not mapped
...

## Full findings (appendix)
### Consistency drift (@consistency-check)
- [severity] <file:line> — ...
### Security (@security-review)
- [severity] <file:line> — ...
### Performance (@performance-review)
- [severity] <file:line> — ...
### Architecture (Codex server/client)
- [severity] <file:line> — ...
### Codex critique of findings
- <paragraph summary of Codex's agree/disagree + added items>

## Agents / passes with zero findings
- <list>

## Errors / skipped
- <any agent crash, Codex auth failure, Sentry MCP unreachable, etc.>
```

## Hard rules (never break)

- Never push. Never commit. Never force-push. Never rebase.
- Never modify any source file. Never auto-fix. Report only.
- Never touch `server/utils/pricingEngine.js`, Stripe code, auth design, `.env*`, `package.json`, or lockfiles (even for "just a look" — report, don't edit).
- Never run `npm install`, `npm update`, dev server, or anything that mutates environment.
- Never mark a Sentry issue resolved. Full audits only read, never write Sentry state.
- Never delete the report log if a previous audit ran the same day — append timestamp suffix (`-${AUDIT_DATE}-T${HHMM}.log`) instead.
- If any agent or Codex pass crashes, log the error in the report's "Errors / skipped" section and proceed with the others. Don't abort the whole run on a single failure.
- On any unexpected git state (not on main, dirty tree, detached HEAD): abort, write a one-line log, exit. Do NOT try to recover.
