# Dr. Bartender — Claude Code Instructions

CLAUDE.md is the **rules doc**. Structural reference (folder tree, route table) lives in `README.md` and `ARCHITECTURE.md`. Read those when you need to know where a file lives.

## Tech Stack

- **Backend**: Node.js 18+ / Express 4.18
- **Frontend**: React 18 (Create React App) / React Router 6
- **Database**: Neon PostgreSQL (via `pg` driver, raw SQL — no ORM)
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **File Storage**: Cloudflare R2 (AWS SDK v3)
- **Payments**: Stripe (server SDK + React Elements)
- **Email**: Resend
- **SMS**: Twilio
- **Rich Text Editor**: TipTap (ProseMirror-based WYSIWYG) for blog admin
- **HTML Sanitization**: DOMPurify + jsdom (server-side, for blog post bodies)
- **Styling**: Vanilla CSS (no Tailwind, no preprocessors)
- **Error Tracking**: `@sentry/node` (server), `@sentry/react` (client)
- **Dev tools**: nodemon, concurrently, ESLint + eslint-plugin-security, husky + lint-staged

## Environment Variables

**Env-var debug discipline.** Production env vars live in Render (server) and Vercel (client) dashboards — I cannot read those. Local `.env` is gitignored. If a bug looks env-related, I will NEVER assert *"X isn't set"* — phrase it as *"Can you confirm `X` is set in [Render | Vercel]?"* My inability to see a value ≠ the value being absent.

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Token signing key |
| `UNSUBSCRIBE_SECRET` | Optional. Separate signing key for unsubscribe/marketing-link JWTs (365-day lifetime). Falls back to `JWT_SECRET` if unset. |
| `RUN_SCHEDULERS` | Set to `false` on additional web instances to prevent duplicate scheduler runs. Default (unset) runs schedulers — single-instance deploys unaffected. |
| `CLIENT_URL` | Admin/staff frontend origin (CORS + admin dashboard links in emails). In prod: `https://admin.drbartender.com` |
| `PUBLIC_SITE_URL` | Public marketing site origin used in client-facing token URLs (proposal, drink plan, invoice, shopping list). In prod: `https://drbartender.com` |
| `STAFF_URL` | Staff portal origin in hire-confirmation emails. Optional — defaults to `https://staff.drbartender.com`. |
| `API_URL` | Backend origin for server-rendered email links (unsubscribe). Optional — defaults to `RENDER_EXTERNAL_URL` in prod, `localhost:5000` in dev. |
| `R2_*` | Cloudflare R2 credentials |
| `RESEND_API_KEY` | Resend email |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (svix) |
| `TWILIO_*` | Twilio SMS |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe live payments |
| `STRIPE_SECRET_KEY_TEST` / `STRIPE_PUBLISHABLE_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST` | Stripe test-mode credentials |
| `STRIPE_TEST_MODE_UNTIL` | ISO date; while in the future, all Stripe calls use `*_TEST` creds (auto-reverts to live after cutoff) |
| `STRIPE_DEPOSIT_AMOUNT` | Deposit in cents (default 10000 = $100) |
| `PUBLIC_GOOGLE_REVIEW_URL` / `REACT_APP_GOOGLE_REVIEW_URL` | Google review URL for the tip thank-you flow (set the same value on server + client) |
| `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` | Inbox for bartender-feedback submissions from the tip thank-you page (default `contact@drbartender.com`) |
| `THUMBTACK_WEBHOOK_SECRET` | Shared secret for Thumbtack webhook auth |
| `REACT_APP_API_URL` | Client-side API base URL (set in client/.env.production) |
| `SENTRY_DSN_SERVER` | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | Client-side Sentry DSN (optional in dev; required in prod) |

## Git Workflow

Solo developer, trunk-based, vibe-coded. Code preservation is the #1 priority. Push to `main` = deploy to production via Render + Vercel.

### Twelve Core Rules

1. **Trunk-only by default.** All work on `main`. Claude confirms branch at session start; if not on `main`, stops and asks — never auto-switches.
2. **Code preservation beats shipping speed.** When a git op could destroy uncommitted or unpushed work, stop and ask.
3. **Commits are finished, tested work only — and grouped by logical feature, not by step.** "Finished" means either (a) user verified it works in the app, or (b) it's a behavior-inert change (copy, CSS, docs) the user approved. No WIP commits, no checkpoint commits. **Default to one commit per logical feature, not one per file or step.** If a feature touches the AppError class, asyncHandler middleware, and the routes that use them, that's ONE commit, not three. Only split when the pieces are genuinely independent and could be reverted separately.
4. **Separate cues for commit vs. push.**
   - **Commit cue:** "looks good", "commit", "next task", or any affirmative after Claude reports what to test → commit without re-approval. Use plain `git commit -m "single line"` (no heredoc, no co-author footer) unless the user asks otherwise — keeps permission prompts at zero.
   - **Push cue:** explicit only — "push", "deploy", "ship it", "send it". Claude never auto-pushes on commit cues. **Claude NEVER volunteers a "ready to push?" prompt.** Pushes are user-initiated only. The user coordinates push timing across multiple parallel Claude sessions / terminals and decides when the full batch is ready. After a commit, Claude stands down — silence is correct. No "ready to push?" question, no "want me to push these now?" nudge, nothing.
   - **Agent-run confirmation.** When the user issues a push cue, Claude's FIRST response is a one-line batch summary + confirmation — BEFORE any agent launch: *"N commits / M files pending. Run agents + push?"* Agents fire only on an explicit yes. If the user says *wait / one more thing / defer*, Claude stands down — no agent run, no push. Re-ask on the next push cue. **Never pre-run agents.** Not at end of feature, not to "verify," not on commit cues, not as prep. The confirmation prompt is the single entry point to the agent fleet. This guards against burning a review on a batch the user is about to amend, and lets the user consolidate commits across multiple terminals into ONE review pass.
5. **Push = deploy.** Every push to `main` ships to Render + Vercel. Treat with gravity.
6. **Review agents run automatically before every code-touching push.** Claude launches all 5 non-UI agents in parallel (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`). Skip agents only when (a) the push contains exclusively `*.md` or `.gitignore` changes, or (b) a fresh `.claude/overnight-review.log` records the current `HEAD` as CLEAN or FIXED with zero flags (see Pre-Push Procedure step 4.5). Clean results → push proceeds silently. Any flag → stop, report findings, wait. Fixes to flagged findings follow the root-cause discipline in Pre-Push Procedure step 6. **Agents run exactly once per logical push, gated by the Pre-Push Procedure step 0.5 confirmation. Claude does NOT pre-run agents at feature completion, task completion, "let me verify," or any point outside the confirmed push flow.** Agent specs live in `.claude/agents/`.
7. **Explicit staging only.** `git add <specific-path>` always. Never `git add .`, `-A`, or `-u`. Prevents sweeping in screenshots, `.playwright-mcp/`, `.env`, etc.
8. **Branches and stashes require approval with a one-line reason.** Claude may propose but never creates silently.
9. **Undo rules (safe recipes).**
   - Unpushed commit: `git reset --soft HEAD~N`
   - Pushed commit: `git revert <sha>` + push (new undo commit — never rewrite pushed history)
   - Unstage without losing work: `git restore --staged <path>`
10. **Amend rules.** Never `--amend` a pushed commit. On unpushed commits, prefer new commits over amend; only amend if the user explicitly asks.
11. **Destructive ops always require explicit approval.** `push --force`, `reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `rm` on tracked files — per-action yes every time. No "obviously safe" bypass.
12. **Push failures stop and report — never auto-resolve.** If `git push` is rejected (non-fast-forward, auth, network), Claude stops and asks. Never auto-pulls, auto-rebases, or force-pushes.

### Pre-Push Procedure

When the user gives a push cue, Claude runs this checklist exactly. No steps skipped, no silent deviations.

**0.5 — Confirmation gate (runs BEFORE any other step).** Announce the pending batch in one line: *"N commits / M files. Run agents + push?"* Wait for explicit yes. If the user says *defer / wait / one more thing / hold on*, stand down silently — no agent run, no push, no further pre-push work. Re-ask on the next push cue. This gate ensures agents run AT MOST once per logical push, even when the user is batching work across multiple parallel Claude sessions.

1. **Verify branch.** Confirm current branch = `main`. If not, stop and ask.
2. **Sanity-check working tree.** If there are uncommitted modifications or untracked files other than known-ignored artifacts, pause and ask: *"There are uncommitted changes in X, Y, Z — meant to go in this push or leave them out?"* Not a hard block; user may just say "leave them."
3. **Inventory the batch.** Run `git log origin/main..HEAD --name-only` to see every file in the pending push.
4. **Classify code vs. non-code.** If all changed files are `*.md` or `.gitignore`, skip to step 7.
4.5. **Check overnight-review cache.** If `.claude/overnight-review.log` exists, honor it and skip to step 7 when ALL of the following hold:
   - Log timestamp is within the last 18 hours
   - `Current HEAD:` sha in the log matches `git rev-parse HEAD`
   - `## Result` line begins with `CLEAN` or `FIXED`
   - `## Flagged for morning (NOT fixed)` section contains only `none`

   If honored, announce one line: *"Honoring overnight-review cache (HEAD `<short-sha>`, result `<CLEAN|FIXED>`)"* and skip to step 7. Otherwise announce one line why the cache was rejected (stale / HEAD mismatch / has flags / missing) and continue to step 5.
5. **Launch 5 agents in parallel** (single message, 5 concurrent Agent tool calls): `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`.
6. **Wait for all agents. Consolidate.** All clean → proceed silently to push. Any flagged issue → stop, present a consolidated report grouped by severity (blockers, warnings, suggestions), ask for direction (fix now, push anyway, abandon).

   **Root-cause discipline on the fix.** When the user opts to fix a flagged finding, invoke `superpowers:systematic-debugging` for anything important (security, auth, money/pricing, data integrity, logic, cross-cutting consistency, integration) **or** not a trivial one-line change: find and fix the root cause and check whether the same cause manifests elsewhere — never just patch the symptom the agent pointed at. Trivial, obvious one-liners (copy, style, a missing import, a doc update, an `res.status().json` → `AppError` swap) get the direct fix, no debugging ceremony. Applies equally to an explicit `review-before-deploy` run; does **not** apply to `overnight-review`.
7. **Push.** `git push origin main`. If rejected, stop and report (per Rule 12).
8. **Report result.** Confirm push succeeded. Note Render + Vercel are now deploying. List commits that shipped.

## Reasoning Effort

**Use maximum reasoning effort when:**
- A change crosses system boundaries (schema → routes → components, backend ↔ frontend)
- Pricing, payment, or Stripe logic is involved (real money at stake)
- Auth, security, or role-guard logic is involved (data exposure risk)
- Schema migrations (hard to reverse in production)
- Any change that triggers the Cross-Cutting Consistency rules below

**Normal effort is fine for:**
- Single-file, single-layer edits (one component, one route, one style block)
- Copy, text, or documentation-only changes
- CSS-only styling tweaks
- Isolated bug fixes with an obvious cause and fix

**Quick test:** *"If I get this subtly wrong, will it cause a bug that's hard to catch?"* If yes — max effort. If the mistake would be immediately obvious — normal effort.

## Coding Patterns & Conventions

- **No ORM** — use raw SQL via `pool.query()` with parameterized queries (`$1`, `$2`, etc.). Never concatenate user input into SQL.
- **Route files** export an Express Router. One file per resource under `server/routes/`.
- **Auth middleware** — import `{ auth }` for protected routes; check `req.user.role` for admin/manager guards.
- **Async route handlers** — wrap with `asyncHandler` so rejections funnel to the global error middleware. Throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `PermissionError`, `ConflictError`, `ExternalServiceError`, `PaymentError`) for client-visible errors instead of `res.status(400).json({error: '...'})`. Hierarchy lives in `server/utils/errors.js`.
- **File uploads** use `express-fileupload` → validated with magic bytes via `server/utils/fileValidation.js` → uploaded to R2 → URL stored in DB.
- **Public token-gated routes** (drink plans, proposals, invoices) use UUID tokens in the URL instead of auth.
- **Frontend API calls** go through `client/src/utils/api.js` (axios with auto-attached JWT). Never raw `fetch`/`axios`.
- **Schema changes** go in `schema.sql` using idempotent statements (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- **Pricing logic** lives in `server/utils/pricingEngine.js` — pure functions, no DB calls. Money stored as integer cents, never floats.
- **Stripe** — all Stripe API calls go through `server/utils/stripeClient.js`, never `require('stripe')` directly. The factory honors `STRIPE_TEST_MODE_UNTIL` and fails closed if creds are missing.
- **Bank PII** — banking fields on `users` / `payouts` route through `server/utils/encryption.js` (AES-256-GCM, fails closed in prod). Never store plaintext.
- **CSS** — vanilla CSS in `index.css`. No CSS modules, no utility frameworks.
- **Naming**: camelCase for JS variables/functions, snake_case for DB columns and API JSON keys.

## Cross-Cutting Consistency

When modifying any entity, always check and update **all** related entities too. Never leave one part of the system out of sync with another. Examples:

- **Proposal price changes** → re-evaluate payment status. If the new total exceeds `amount_paid`, remove or correct any "Paid in Full" flag. Never leave a proposal marked paid when it isn't.
- **Proposal event detail changes** (date, time, location, guest count) → check and update linked shifts accordingly.
- **Phone number / formatting changes** → update every component, route, and display that touches that field.
- **Schema column changes** → update every route (SELECT, INSERT, UPDATE), every component that reads/writes that field, and every place that displays it.
- **New feature data shape** → ensure every consumer of that data (backend endpoints, frontend components, PDF templates) is updated in the same PR.
- **Event identity** — client name and event type are separate, independent data points. Never concatenate them into a single "title" string or prompt for an `event_name`. Display uses `getEventTypeLabel({ event_type, event_type_custom })` with `'event'` as the graceful fallback. Available in `client/src/utils/eventTypes.js` (ESM) and `server/utils/eventTypes.js` (CJS — kept in sync manually).
- **Hosted-package bartender rule** — Hosted (per_guest) packages include bartender staffing in the per-guest rate **at a 1:100 guest ratio** (so 100 guests = 1 included, 250 guests = 3 included; controlled by `pkg.guests_per_bartender`). Bartenders **within** the ratio are $0 line items with $0 gratuity. Bartenders **above** the ratio — added via the `num_bartenders` override OR the `additional-bartender` add-on — are charged at the standard hourly rate (`pkg.extra_bartender_hourly`, default $40/hr) plus the same sub-100-guest gratuity surcharge that applies on BYOB ($50/$25/$15 per hour for <50/<75/<100 guests). Use `isHostedPackage(pkg)` and `staffing.required` from `server/utils/pricingEngine.js`. Grep for `isHostedPackage` before adding any new bartender-cost code path; only zero the charge for the first `staffing.required` bartenders. This rule has been re-lost multiple times — treat as load-bearing.
- **Drink plans: event-side is canonical, proposal-side is preview.** Bartender prep, shopping-list approval, and client communication all use the EVENT's drink plan (post-conversion). Verify drink-plan / shopping-list UI changes on the event path. Pricing logic still verifies on the proposal side (that's where money math runs).

The rule: **if you change X, search the codebase for everything that depends on X and update it too.**

## File Size Discipline

After the 2026-04-27 cleanup pass split five 1000+ line mega-files, the codebase enforces line-count limits to prevent backsliding. The pre-commit hook (`.husky/check-file-size.sh`) runs on staged source files (`server/**/*.js`, `client/src/**/*.{js,jsx}`, excluding tests) and:

- **Warns at 700 lines** — "plan a split, this is getting big." Doesn't block.
- **Fails at 1000 lines** — hard floor. Either split the file or add an explicit opt-out.

When you write a new file or add to an existing one, aim for the soft sweet spot:
- **<300 lines** — comfortable. Holds in your head, fits on a screen, easy to review.
- **300–600 lines** — fine for a focused page or route file with one clear concern.
- **600–700 lines** — yellow zone. Ask: is this one concern, or two?
- **>700 lines** — actively plan a split (per-tab, per-section, per-endpoint-group, helpers extracted to a sibling file).

When a file genuinely needs to be big (rare — usually the right answer is to split), opt out by adding this in the first 5 lines:

```js
// claude-allow-large-file
// Reason: <one-line justification — what's special about this file>
```

The marker is intentional friction. If you're reaching for it, double-check that the file isn't actually two files mashed together.

## Mandatory Documentation Updates

**This is not optional.** When you add, rename, or remove anything that touches the codebase shape, update the relevant docs in the same change. The pre-commit hook will warn if you don't.

CLAUDE.md is the rules doc — most structural updates land in `README.md` (folder tree, npm scripts, key features) and `ARCHITECTURE.md` (route table, schema, third-party integrations). Only env vars and integrations also touch CLAUDE.md.

| What changed | CLAUDE.md | README.md | ARCHITECTURE.md |
|---|---|---|---|
| New/removed route file | — | Folder structure tree | Add/remove API route table |
| New/removed util file | — | Folder structure tree | Mention in relevant section |
| New/removed component | — | Folder structure tree | — |
| New/removed page | — | Folder structure tree | — |
| New/removed context | — | Folder structure tree | — |
| Schema column/table change | — | — | Database Schema section |
| New env variable | Environment Variables table | Environment Variables table | — |
| New npm script | — | NPM Scripts table | — |
| New integration | Tech Stack list | Tech Stack table | Third-Party Integrations |
| New feature | — | Key Features section | Relevant architecture section |

---

## Code Verification System

This project is vibe-coded — the author relies on Claude to catch issues. Verification has two layers: an inline self-check on every change (below), and opus-powered review agents triggered automatically before code-touching pushes (see Git Workflow Rule 6 + Pre-Push Procedure). Agent specs live in `.claude/agents/` — what each agent checks is documented there, not duplicated here.

### Inline Self-Check (Every Change — Free)

Before presenting ANY code change, silently verify:

**Security**
- All SQL uses parameterized queries (`$1`, `$2`) — never string concatenation
- All non-public routes have `auth` middleware; admin routes check `req.user.role`
- Endpoints filter by `req.user.id` to prevent accessing other users' data (IDOR)
- No secrets hardcoded — everything from `process.env`
- User input validated on server side (type, length, format)
- File uploads validated with magic bytes via `fileValidation.js`
- Error responses never leak stack traces, SQL, or internals

**Data Integrity**
- Multi-table writes wrapped in `BEGIN/COMMIT/ROLLBACK`
- Schema changes are idempotent (`IF NOT EXISTS`)
- Money stored as integer cents, never floats
- Changed columns updated in ALL routes that touch that table

**Frontend**
- Async ops have loading, error, and empty states
- API calls go through `utils/api.js` — never raw fetch/axios
- New routes added to `App.js` with correct auth guards
- Client-side validation matches server-side rules

**Logic**
- Null/undefined handled for DB results, API responses, optional fields
- Date ranges and pagination boundaries correct
- No race conditions on payment/mutation endpoints
