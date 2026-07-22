# Dr. Bartender — Claude Code Instructions

CLAUDE.md is the **rules doc**, organized in two tiers:

- **Invariants** — genuine law that protects money, auth, data, and code. They change only with deliberate care, and the rewrite is coverage-checked so none is ever silently dropped.
- **Conventions** — how we work now, each carrying its *why*. Conventions are questionable by default: when one gets in your way, say so, change it, and update its *why* right then. The doc stays alive.

Structural reference (folder tree, route table) lives in `README.md` and `ARCHITECTURE.md`. Read those when you need to know where a file lives. Reference material (tech stack, env vars) sits at the end of this doc.

> TRANSITIONAL (remove once fully off Windows): primary development is the Linux box now. A few notes still describe Windows-era behavior; each carries a `TRANSITIONAL` marker until the Windows machine is retired.

---

# Invariants

## Git safety

Solo developer, vibe-coded. **Code preservation is the #1 priority.** Push to `main` = deploy to production via Render + Vercel. These rules protect work and the shared `main`; they do not bend.

- **os never leaves main.** The `os` checkout is permanently pinned to `main`. Never `checkout`, `switch`, or `checkout -b` inside `os`. *Why:* `os` is a single shared checkout with one HEAD across parallel windows; moving it drags another window onto the wrong branch and strands that window's commits. A branch exists only as a separate worktree ("lane") under `../worktrees/`, driven by path. A pre-commit guard (`scripts/guard-os-main.sh`) blocks any commit on a non-main branch from the `os` worktree, and any spec/plan doc committed off `main`.
- **Code preservation beats shipping speed.** When a git op could destroy uncommitted or unpushed work, stop and ask. *Why:* lost work is unrecoverable; a delayed ship is not.
- **Explicit staging only.** `git add <specific-path>` always. Never `git add .`, `-A`, or `-u`. *Why:* prevents sweeping in screenshots, `.playwright-mcp/`, `.env`, and other junk.
- **Never `git reset` on `main`.** Reset is safe inside a lane branch. Rewinding shared `main` is the exact collision the lane model removes. Unpushed work: `git reset --soft HEAD~N` (in a lane). Pushed work: `git revert <sha>` + push (a new undo commit, never a rewrite of pushed history). Unstage without losing work: `git restore --staged <path>`.
- **Never `--amend` a pushed commit.** On unpushed commits prefer new commits over amend; amend only if the user explicitly asks. *Why:* rewriting pushed history breaks every other checkout.
- **Destructive ops always require explicit approval — except merged-lane cleanup.** `push --force`, `reset --hard`, `clean -f`, `checkout .`, `restore .`, and `rm` on tracked files need a per-action yes every time. No "obviously safe" bypass. `branch -D` needs a yes too, with ONE standing pre-approval: deleting a lane branch after its squash-merge, verified by all three checks (Claude runs them and states the results in the same breath as the delete): (1) the lane's squash commit is on `main` (`git log main --grep "merge(lane <name>"` finds it); (2) `git diff main <branch> -- <every file the lane touched>` is EMPTY, i.e. every change the lane made is byte-identical on main, so deletion cannot lose work; (3) the lane's worktree is already removed. A `-D` that fails any check is back to per-action approval. *Why:* the others are irreversible; a squash-merged lane branch that passes the diff check is provably redundant, and asking permission to take out verified garbage just trains everyone to stop reading the prompts.
- **Push failures stop and report — never auto-resolve.** If `git push` is rejected (non-fast-forward, auth, network), stop and ask. Never auto-pull, auto-rebase, or force-push. *Why:* an auto-fix can silently clobber or ship the wrong thing.
- **Push = deploy.** Every push to `main` ships to Render + Vercel. Treat it with gravity. Pushes are explicit-cue only (see Push model).
- **Commits are finished, tested work, grouped by logical feature.** "Finished" means either (a) the user verified it works in the app, or (b) it is a behavior-inert change (copy, CSS, docs) the user approved. One commit per logical feature, not per file or step. No WIP or checkpoint commits on `main`. *Why:* clean, revertable history where a commit is a unit of intent. (Lane checkpoints are exempt: they never reach `main`; the squash merge is the unit.)
- **Branches and stashes outside the lane model need approval with a one-line reason.** Claude may propose but never creates them silently. *Why:* the lane lifecycle is blanket-authorized, but ad-hoc branches/stashes are where work goes missing.

## Money, auth, and data: cross-cutting consistency

When modifying any entity, always check and update **all** related entities too. Never leave one part of the system out of sync with another. Examples:

- **Proposal price changes** → re-evaluate payment status. If the new total exceeds `amount_paid`, remove or correct any "Paid in Full" flag. Never leave a proposal marked paid when it isn't.
- **Proposal event detail changes** (date, time, location, guest count) → check and update linked shifts accordingly.
- **Phone number / formatting changes** → update every component, route, and display that touches that field.
- **Schema column changes** → update every route (SELECT, INSERT, UPDATE), every component that reads/writes that field, and every place that displays it.
- **New feature data shape** → ensure every consumer of that data (backend endpoints, frontend components, PDF templates) is updated in the same PR.
- **Event identity** — client name and event type are separate, independent data points. Never concatenate them into a single "title" string or prompt for an `event_name`. Display uses `getEventTypeLabel({ event_type, event_type_custom })` with `'event'` as the graceful fallback. Available in `client/src/utils/eventTypes.js` (ESM) and `server/utils/eventTypes.js` (CJS — kept in sync manually).
- **Hosted-package bartender rule** — Hosted (per_guest) packages include bartender staffing in the per-guest rate **at a 1:100 guest ratio** (so 100 guests = 1 included, 250 guests = 3 included; controlled by `pkg.guests_per_bartender`). Bartenders **within** the ratio are $0 line items with $0 gratuity. Bartenders **above** the ratio — added via the `num_bartenders` override OR the `additional-bartender` add-on — are charged at the standard hourly rate (`pkg.extra_bartender_hourly`, default $40/hr) plus the same sub-100-guest gratuity surcharge that applies on BYOB ($50/$25/$15 per hour for <50/<75/<100 guests). Use `isHostedPackage(pkg)` and `staffing.required` from `server/utils/pricingEngine.js`. Grep for `isHostedPackage` before adding any new bartender-cost code path; only zero the charge for the first `staffing.required` bartenders. This rule has been re-lost multiple times — treat as load-bearing.
- **Drink plans: event-side is canonical, proposal-side is preview.** Bartender prep, shopping-list approval, and client communication all use the EVENT's drink plan (post-conversion). Verify drink-plan / shopping-list UI changes on the event path. Pricing logic still verifies on the proposal side (that's where money math runs).
- **Checkout gratuity** — gratuity is stored as a per-staff-per-hour RATE (`gratuity_rate`); the dollar line is always computed (`rate × staffCount × hours`, staff = bartenders + additional-bartender addon, NOT barbacks/servers) and layered on top of the forced `"Shared Gratuity"` surcharge. Added on top of `total_price` (never diluted by a discount/override), pooled with the forced surcharge in payroll (both labels via `gratuityLabels.GRATUITY_PAYROLL_LABELS`), and gated on funded before accrual. Applies to all packages via `staff_noun`. Labels come from the one shared constant module (`gratuityLabels.js`, server + client mirror). The no-jar floor (rate ≥ 50) is enforced at the route (`deriveGratuityRate`), in the engine, and by a DB CHECK. The Stripe webhook records the amount actually charged (additive), never `= total_price`. Grep `gratuityLineAmount` / `GRATUITY_LABEL` before touching gratuity.

The rule: **if you change X, search the codebase for everything that depends on X and update it too.**

## Coding patterns

- **No ORM** — use raw SQL via `pool.query()` with parameterized queries (`$1`, `$2`, etc.). Never concatenate user input into SQL.
- **One pooled connection per request.** If a handler holds a client from `pool.connect()`, every query it makes until `client.release()` must go through that client — never a bare `pool.query()`, which checks out a *second* connection. A request holding one connection while waiting for another is a pool deadlock: at `max` concurrent such requests, nobody can release until they get a connection nobody can free, and the whole app starves for `connectionTimeoutMillis`. After `COMMIT`/`ROLLBACK` the client is back in autocommit and is fine to keep using. *Why:* this has bitten twice (SERVER-17; the 2026-07-13 capture-lead deadlock). It is easy to reintroduce because `pool.query()` is the correct default *everywhere else*. Watch the post-COMMIT "best-effort" tail of a transaction handler especially — and note that a helper you call there (e.g. anything in `marketingHandlers.js`) may take its own pooled connection, in which case `release()` the client *before* that tail instead.
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

## Inline self-check (every change, free)

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

## Env-var debug discipline

Production env vars live in Render (server) and Vercel (client) dashboards — I cannot read those. Local `.env` is gitignored. If a bug looks env-related, I will NEVER assert *"X isn't set"* — phrase it as *"Can you confirm `X` is set in [Render | Vercel]?"* My inability to see a value ≠ the value being absent.

---

# Conventions (how we work now, and why)

## The model: think-on-main, build-in-lanes

**Thinking always lives on main.** Brainstorm, spec, and plan commit to `main` the moment they exist. Any number of parallel planning windows share the `os` main checkout, each writing its own spec/plan doc. *Why:* the old wound was branch-stranded thinking, a plan committed to a project branch whose code never fully landed, so the problem-solving was effectively lost while `main` moved on. Nothing valuable ever sits on a branch now, so nothing valuable can be stranded.

**Code is built in lanes.** A "lane" is a short-lived, throwaway git worktree under `../worktrees/`, holding code only, living hours not weeks, owned end-to-end by Claude. When a plan is ready and the user says go, Claude cuts a lane off current `main`, builds it, merges it back by squash, and deletes it. The user never names, finds, or returns to a lane. *Why:* worktrees kept the parallel-execution throughput; redefining them as code-only and Claude-managed removes the branch-hunting overhead. If a lane rots, the worst case is re-running mechanical code from a plan that is safe on `main`.

> TRANSITIONAL (remove once fully off Windows): a lane's shared `node_modules` / `client/node_modules` / `.husky/_` are real symlinks on Linux (the worktree helper's old `'junction'` arg was a Windows-only no-op). `.gitignore` matches them so a lane is born clean. Always use `npm run worktree:new` / `worktree:rm` (the husky `.husky/_` link is needed on Linux too); never a bare `git worktree add`.

## Two tracks

The user picks the track by how the work opens:

- **Quick fix → on main, in `os`.** "Just fix this real quick." Claude edits on `main`, commits, done. No branch, no merge. Staying on `main` is exactly what the os invariant guarantees, so quick fixes never fight it.
- **Project → think on main, build in a lane.** "Let's work on this." Brainstorm and plan on `main`, then Claude builds it in a lane and merges back.

## Thinking phase

- **Brainstorm.** Claude digs in, forms an opinion and leads with it, asks one question at a time, prose not menus. **Section-by-section approvals ARE the approval; there is no "now read the whole written spec" gate.**
- **Spec.** A byproduct of the live brainstorm, committed to `main`, fed to the spec-review agents. The user does not re-read it.
- **Plan = lane map.** The plan comes out as the work broken into independent, individually buildable-and-reviewable lanes, plus a dependency/parallelism graph, in structured front-matter (see schema below). That graph IS the run-order, co-designed with the user.

## Lane lifecycle and stale lanes

- Claude auto-handles the safe moves: create the lane, merge it when clean, clean it up after merge. No asking. ("Manage it for me.")
- **Stale detection.** A lane is flagged stale when it is older than 48h with no new commit, OR `main` has advanced 15+ commits since it was cut, OR any sensitive path has landed on `main` since it was cut. The check runs at session start (`npm run lane:status`) and again at each push-time sweep.
- **Default for a dead lane:** scrap and re-cut fresh from the plan (safe on `main`), salvaging half-written code only if it is substantial and clean.
- **Never scrap unmerged work.** Before any scrap, `git log main..<lane-branch>` must be empty. If it is non-empty, do NOT scrap without the user's okay. Auto-scrap always uses `git branch -d` (which refuses unmerged), never `-D`. ("Never lose my code.")

## Inside a lane (execution method)

Claude picks the most efficient method for the lane in front of it and does not default to subagents or any other ceremony because a skill says to. A small coherent lane is built in one pass; a lane with genuinely independent pieces is split across parallel subagents. Claude states the method so the user can wave it off. The Inline Self-Check still runs before every change. Inside a lane Claude self-commits freely as it builds (checkpoints, sandboxed, nothing ships); those checkpoints never reach `main` because the merge is a squash. On a mid-build failure (compile error, test fail, dev-server crash), the lane stays open for repair; if it cannot be repaired it follows the stale-lane default (re-cut from plan).

## Merge model

- **Serialized through `os`, behind a real lock.** Every merge runs in the one `os`/`main` checkout, never from inside a lane, and acquires an exclusive `flock` (`scripts/merge-lane.sh`). flock auto-releases if the holder dies, so a crashed merge cannot wedge future merges. The second merge waits.
- **Lanes merge by squash.** In-lane checkpoints do not land on `main`; the squash is one clean commit per logical feature, and its message carries the lane name + plan link. The squash merge is the test gate; in-lane checkpoints are never assumed individually tested.
- **Merge is not deploy.** `main` can hold several freshly merged lanes with nothing shipped. The push to prod is a separate, gated step.
- **Dirty-tree rule.** If `os` has uncommitted quick-fix work when a lane is ready to merge, Claude does not merge into a dirty tree. It pauses and asks the user to commit the quick fix first (or, with okay, auto-stashes with an explicit, reported recovery).
- **Source branch survives until the merge verifies clean** = no conflict AND the lane's per-lane review re-confirmed against main's new HEAD. Then the worktree is removed.
- **Conflict handling, path-based.** Ordinary textual conflicts: Claude resolves using both diffs and both plans (on `main`) and reports what it did. Claude stops and brings it to the user whenever the conflict touches a **sensitive path** (see below) or the resolution is genuinely ambiguous.

## Review model

- **Per-lane, before merge, is the primary gate.** A single lane is a small, coherent scope where review agents finish and return real verdicts. By push time every lane on `main` was already cleanly reviewed.
- **Risk-scaled by the sensitive-path list.** Cosmetic changes get a light look; anything touching a **sensitive path** gets the full agent fleet no matter how tiny. The one list is `scripts/sensitive-paths.txt` (matched by `scripts/sensitive-match.js`); it is the single trigger for review-scaling, conflict-escalation, AND auto-pull disqualification. Claude always states which level it ran.
- **Iron rule: a failed or incomplete agent is never a pass.** A non-completing agent is a blind spot, not a green light. An agent that completes but returns no explicit pass/fail (empty, inconclusive, low-confidence) counts as a non-completion.
- **Chunk-and-retry with a coverage manifest.** A review that does not finish is split into smaller chunks and re-run, halving down toward single-file. Coverage is guaranteed by a manifest: every file in `git diff --name-only` for the scope appears in exactly one chunk's input, and each file ends with an explicit pass/fail-or-anomaly recorded against it. The lane is blocked unless every file has a real verdict. If a single-file chunk still cannot complete after a retry, Claude stops, names the file, and blocks the merge (never allow-with-warning).
- **Quick-fix review gate.** A quick fix touching any **sensitive path** triggers the full fleet at push time on those specific commits, regardless of scope. A quick fix touching nothing sensitive gets the light look plus the push-time sweep.
- **Push-time integration sweep.** A focused pass over the seams between merged lanes and quick-fixes (files touched by more than one source since the last push, computed from `git log <lastPush>..HEAD --name-only`), checking that separately-clean pieces still agree. NOT a re-audit of every line. Same chunk-and-retry, manifest, and iron rule apply.
- **Sensitive-path re-review at push.** Any commit since the last push that touches a **sensitive path** gets the full fleet at push, against main's new HEAD, regardless of overlap. Because squash-merge hides within-squash overlap, this (not seam intersection) is what guarantees sensitive code is re-reviewed at push.
- **Cross-LLM second opinion on sensitive pushes.** Whenever the push-time full fleet runs on sensitive-path commits, also run `/second-opinion` on those same commits, in parallel with the fleet. Codex + gemini findings are Claude-verified before surfacing; external reviewers failing (quota, auth) is reported but does NOT block the push — the Claude fleet remains the gate. *Why:* decorrelated eyes; a different model family caught a money-seam bug the fleet passed (staffing-roster, 2026-07-01).

Agent specs live in `.claude/agents/`. This project is vibe-coded; the author relies on Claude to catch issues.

## Push model

The push to prod is the user's deliberate, explicit call ("push", "deploy", "ship it", "send it"). It carries forward the old strictness:

- **Confirmation gate (before any other step).** Claude announces the batch in one line: *"N commits / M files pending. Run review + push?"* and waits for an explicit yes. If the user says *defer / wait / one more thing / hold on*, Claude stands down silently and re-asks on the next push cue. **Claude NEVER volunteers a "ready to push?" prompt.** After a commit, silence is correct.
- The push-time sweep (and any sensitive quick-fix full-fleet review) runs ONLY after that yes. **Never pre-run review agents** at feature completion, "to verify," or as prep. The confirmation prompt is the single entry point to the fleet.
- A flagged finding gives the user a fix-now / push-anyway / abandon choice. **Root-cause discipline on the fix:** for anything important (security, auth, money/pricing, data integrity, logic, cross-cutting consistency, integration) or any non-trivial change, invoke `superpowers:systematic-debugging` — fix the root cause and check whether it manifests elsewhere, never just patch the symptom. Trivial one-liners (copy, a missing import, a doc tweak) get the direct fix.
- Push failures stop and report (Git-safety invariant).

> TRANSITIONAL (remove once fully off Windows): `.husky/pre-push` runs the exact Vercel client build (`CI=true react-scripts build`) only when a push changes `client/`, catching CI-fatal ESLint warnings that nothing else local catches. It sits below the confirmation gate as the last mechanical gate; emergencies bypass with `git push --no-verify`.

> TRANSITIONAL (not-yet-blocking until `NEON_API_KEY` is configured): the same `.husky/pre-push` also runs the money-path smoke gate (`node scripts/testdb-smoke.js`) when a push changes `server/` — money suites against an isolated Neon `ci-smoke` branch — first (fails faster than the client build); until the key exists it prints a loud SKIP banner and allows the push, then becomes hard/fail-closed. See README > Test gate. Same `--no-verify` escape.

## Plan = lane map (front-matter schema)

A plan's lanes are declared in structured front-matter so the spec-review agents, auto-pull, and the footprint-drift check can all read them. Each lane declares: a lane id, its `footprint` (the file globs it expects to touch), its dependencies (what blocks it), and its review fleet. A lane that edits outside its declared footprint aborts and surfaces rather than silently widening.

## Reasoning effort

**Use maximum reasoning effort when:**
- A change crosses system boundaries (schema → routes → components, backend ↔ frontend)
- Pricing, payment, or Stripe logic is involved (real money at stake)
- Auth, security, or role-guard logic is involved (data exposure risk)
- Schema migrations (hard to reverse in production)
- Any change that triggers the Cross-Cutting Consistency rules

**Normal effort is fine for:**
- Single-file, single-layer edits (one component, one route, one style block)
- Copy, text, or documentation-only changes
- CSS-only styling tweaks
- Isolated bug fixes with an obvious cause and fix

**Quick test:** *"If I get this subtly wrong, will it cause a bug that's hard to catch?"* If yes — max effort. If the mistake would be immediately obvious — normal effort.

## File-size discipline

The codebase enforces line-count limits to prevent mega-files. A pre-commit hook runs `node scripts/check-file-size.js --staged` on staged source files (`server/**/*.js`, `client/src/**/*.{js,jsx}`, excluding tests). It is a **ratchet**, not a flat cap:

- **Soft cap, 700 lines** — warns ("plan a split"). Never blocks.
- **Hard cap, 1000 lines** — a file over 1000 lines blocks the commit **only if this commit makes it longer than it is at `HEAD`.** A non-growing change (bugfix, refactor, or anything flat or shrinking) to an over-cap file is always allowed. The only way to *add* to an over-cap file is to first extract enough that the file stays flat or shrinks.

There is no per-file opt-out marker. A file over the cap is frozen at its current size, and the ratchet tightens: once a file sheds lines, the lower count becomes its new ceiling. For a genuine emergency where a growing commit to an over-cap file cannot wait, `git commit --no-verify` is the escape: per-commit, deliberate, and visible, not a permanent exemption.

Run `npm run check:filesize` any time for a full-tree RED / YELLOW report.

**When you write a new file or add to one, aim for the sweet spot:** under 300 lines is comfortable; 300 to 600 is fine for a focused page or route file; 600 to 700 is the yellow zone (one concern or two?); over 700, actively plan a split.

**How to split, by the patterns already in the codebase:** route files into per-concern files behind a composition router (see `server/routes/proposals/`); template files into per-domain siblings (`lifecycleEmailTemplates.js`, `marketingEmailTemplates.js` alongside `emailTemplates.js`); page components by extracting self-contained sections.

## Mandatory documentation updates

**This is not optional.** When you add, rename, or remove anything that touches the codebase shape, update the relevant docs in the same change. The pre-commit hook will warn if you don't. Most structural updates land in `README.md` (folder tree, npm scripts, key features) and `ARCHITECTURE.md` (route table, schema, third-party integrations). Only env vars and integrations also touch this doc.

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

## Design-stage review fleet

Explicit-only Claude agents for reviewing specs and plans BEFORE any code is written. `/review-spec` runs three agents (`spec-grounding`, `spec-gaps`, `spec-risk`) in parallel on a spec doc. `/review-plan` runs three agents (`plan-fidelity`, `plan-decomposition`, `plan-feasibility`) in parallel on an implementation plan. Natural-language triggers ("review the spec", "review the plan", "design review") route to the same commands. Both resolve to the most recent file in `docs/superpowers/specs/` or `docs/superpowers/plans/` unless an explicit path is given. Report-only; no auto-fix. Complements `/gemini-spec`.

---

# Reference

## Tech Stack

- **Backend**: Node.js 26 (pinned; see .node-version) / Express 4.18
- **Frontend**: React 18 (Create React App) / React Router 6
- **Database**: Neon PostgreSQL (via `pg` driver, raw SQL — no ORM)
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **File Storage**: Cloudflare R2 (AWS SDK v3)
- **Payments**: Stripe (server SDK + React Elements)
- **Email**: Resend
- **SMS**: Twilio
- **VA calling (Zul)**: Telegram Bot API (raw HTTPS to the Bot API, no SDK) as the outbound-call trigger channel + Twilio Programmable Voice (`calls.create`) callback bridge that dials Zul's PH cell and bridges to a US target with the 224 as caller ID
- **Web Push**: `web-push` (VAPID) for staff-portal browser / PWA notifications
- **Booking / scheduling**: Cal.com (webhook integration; self-hosted target for V2)
- **Venue search**: Google Places API (New) for venue-name autocomplete
- **Rich Text Editor**: TipTap (ProseMirror-based WYSIWYG) for blog admin
- **HTML Sanitization**: DOMPurify + jsdom (server-side, for blog post bodies)
- **Styling**: Vanilla CSS (no Tailwind, no preprocessors)
- **Error Tracking**: `@sentry/node` (server), `@sentry/react` (client)
- **Dev tools**: nodemon, concurrently, ESLint + eslint-plugin-security, husky + lint-staged, playwright-core (mobile:check harness)

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Token signing key |
| `UNSUBSCRIBE_SECRET` | Optional. Separate signing key for unsubscribe/marketing-link JWTs (365-day lifetime). Falls back to `JWT_SECRET` if unset. |
| `ENCRYPTION_KEY` | 64-hex-char (32-byte) AES-256-GCM key encrypting bank-account PII at rest (`server/utils/encryption.js`). Fails closed in prod when unset. |
| `ADMIN_PASSWORD` | Password for the seeded admin account (`server/scripts/createAdmin.js`, `server/db/seed.js`). |
| `MAX_FILE_SIZE` | Upload size limit in bytes (default `10485760` = 10MB), applied by the file-upload middleware in `server/index.js`. |
| `RUN_SCHEDULERS` | Schedulers fire only when `NODE_ENV=production` (Render's default). In any other environment they default to OFF, so a local dev server never burns Resend/Twilio allotments by iterating the shared Neon DB. Set `RUN_SCHEDULERS=true` to force-on locally (testing a handler against a scratch row). Set `RUN_SCHEDULERS=false` on a secondary prod instance to prevent duplicate runs. |
| `SEND_NOTIFICATIONS` | Real outbound email (Resend) + SMS (Twilio) fire only when `NODE_ENV=production` by default — same philosophy as `RUN_SCHEDULERS` — so a local dev server never burns provider allotments against the shared Neon DB. Set `SEND_NOTIFICATIONS=true` to force real sends locally (testing a real send to a scratch row). Set `SEND_NOTIFICATIONS=false` to force off anywhere. When gated off, `sendEmail`/`sendSMS` take their existing log-and-skip path. |
| `RUN_AUTOPAY_SCHEDULER` / `RUN_AUTOCOMPLETE_SCHEDULER` / `RUN_AUTO_ASSIGN_SCHEDULER` / `RUN_SEQUENCE_SCHEDULER` / `RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER` | Optional. Per-scheduler disable. Set to `false` to disable that specific scheduler. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_MESSAGE_DISPATCHER_SCHEDULER` | Optional. Set to `false` to disable the scheduled-message dispatcher (balance reminders, plus future drip / event-week handlers). Defaults on. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` | Optional. Set to `false` to disable the hourly `webhook_events` 30-day prune. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_PENDING_EMAIL_CLEANUP_SCHEDULER` | Optional. Set to `false` to disable the daily `pending_email_changes` 7-day purge (spec §6.10). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER` | Optional. Set to `false` to disable the daily Stripe payout mirror sweep (webhook-miss heal, pending bucket, re-match). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_REFUND_PENDING_SWEEP_SCHEDULER` | Optional. Set to `false` to disable the 15-minute stale-pending-refund sweep (reconciles `proposal_refunds` rows stuck `pending` >30 min against Stripe: adopts the real refund or marks it failed). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `CLIENT_URL` | Admin/staff frontend origin (CORS + admin dashboard links in emails). In prod: `https://admin.drbartender.com` |
| `PUBLIC_SITE_URL` | Public marketing site origin used in client-facing token URLs (proposal, drink plan, invoice, shopping list). In prod: `https://drbartender.com` |
| `STAFF_URL` | Staff portal origin in hire-confirmation emails. Optional — defaults to `https://staff.drbartender.com`. |
| `API_URL` | Backend origin for server-rendered email links (unsubscribe). Optional — defaults to `RENDER_EXTERNAL_URL` in prod, `localhost:5000` in dev. |
| `R2_*` | Cloudflare R2 credentials |
| `RESEND_API_KEY` | Resend email |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (svix) |
| `TWILIO_*` | Twilio SMS. `TWILIO_AUTH_TOKEN` is also used to verify the inbound-SMS webhook signature (`POST /api/sms/inbound`). |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe live payments |
| `STRIPE_SECRET_KEY_TEST` / `STRIPE_PUBLISHABLE_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST` | Stripe test-mode credentials |
| `STRIPE_TEST_MODE_UNTIL` | ISO date; while in the future, all Stripe calls use `*_TEST` creds (auto-reverts to live after cutoff) |
| `STRIPE_DEPOSIT_AMOUNT` | Deposit in cents (default 10000 = $100) |
| `PUBLIC_GOOGLE_REVIEW_URL` / `REACT_APP_GOOGLE_REVIEW_URL` | Google review URL for the tip thank-you flow (set the same value on server + client) |
| `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` | Inbox for bartender-feedback submissions from the tip thank-you page (default `contact@drbartender.com`) |
| `ADMIN_EMAIL` | Admin inbox address. Seed-account email, and the default `Reply-To` on every client-facing email sent via `sendEmail`. Set to a monitored inbox in prod so client replies do not bounce. Falls through to no `Reply-To` header when unset. |
| `ADMIN_PHONE` | Optional. E.164 number for last-minute (<72h) booking SMS alerts. Unset → admin SMS skipped; broad staff blast still fires. |
| `THUMBTACK_WEBHOOK_SECRET` | Shared secret for Thumbtack webhook auth |
| `THUMBTACK_AGENT_SECRET` | Shared secret for the Thumbtack box-agent surface (`/api/admin/thumbtack/*`: email harvesting + auto first-reply). Timing-safe compare; **fails closed (401) in every environment when unset**. BLAST RADIUS (2026-07-21): the secret now also reads customer names (pending-first-replies), can trigger window-bypassed call chains one-shot per pending day lead (first-reply-sent), and can suppress replies (first-reply-failed x3). Leak response: rotate the secret AND flip `TT_AUTOREPLY_ENABLED` + `LEAD_CALL_ENABLED`. |
| `HARVESTER_ENABLED` | Optional. Set to `false` to make `GET /api/admin/thumbtack/pending-harvest` return `[]` (redeploy-free kill-switch) and idle the box agent. Defaults on. |
| `MAX_HARVEST_ATTEMPTS` | Optional. Transient-failure retry cap before a harvest lead is marked `failed`. Default 3. |
| `HARVEST_COOLDOWN_INTERVAL` | Optional. Postgres interval before a leased-but-unresolved harvest lead is re-offered by `pending-harvest`. Default `'6 hours'`. |
| `CAL_WEBHOOK_SECRET` | HMAC-SHA256 signing secret for the Cal.com webhook. Fails closed: webhook returns 503 if unset. |
| `CAL_BOOKING_URL` | Public Cal.com booking page URL. Surfaced in 3 client comms touches (drink-plan nudge email + SMS, six-months-out marketing). Optional; templates omit the consult line when unset. |
| `GOOGLE_PLACES_API_KEY` | Google Places API (New) key for venue-name search. Server-only. When unset, venue search degrades to a plain text input. |
| `REACT_APP_API_URL` | Client-side API base URL (set in client/.env.production) |
| `SENTRY_DSN_SERVER` | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | Client-side Sentry DSN (optional in dev; required in prod) |
| `VAPID_PUBLIC_KEY` | Web Push (VAPID) public key for staff-portal push notifications (spec §6.17). Generate with `npx web-push generate-vapid-keys`. The same value is exposed to the client as `REACT_APP_VAPID_PUBLIC_KEY`. |
| `VAPID_PRIVATE_KEY` | Web Push (VAPID) private key. Server-only — never commit, never expose to the client. When unset, the push sender fails closed (`vapid_unset`) and the server still boots normally; SMS + email keep covering every notification. |
| `REACT_APP_VAPID_PUBLIC_KEY` | Client-side copy of `VAPID_PUBLIC_KEY` (identical value), used by the staff portal to subscribe the browser to push. Set on the client side (Vercel). |
| `VAPID_CONTACT_EMAIL` | Contact email embedded in the VAPID JWT (`mailto:`). Optional — defaults to `contact@drbartender.com`. |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token (@BotFather) for the Zul VA-calling trigger. When unset, `sendTelegramMessage`/`setTelegramWebhook` no-op (log + skip) and outbound calling is dead. |
| `TELEGRAM_WEBHOOK_SECRET` | Doubles as the secret URL path segment (`/api/telegram/<secret>`) AND the value compared constant-time against the `X-Telegram-Bot-Api-Secret-Token` header. Set the same value at `setWebhook`. Unset → `verifyTelegramSecret` returns false (all updates 403). |
| `TELEGRAM_ALLOWED_USER_ID` | Numeric Telegram user id of Zul (the only sender allowed to trigger a call). **When UNSET the webhook runs in bootstrap mode**: it replies to any sender with their own id and dials nothing. Set it, redeploy; then all other senders are silent no-ops. |
| `VOICE_CALLER_ID` | The 224 US voice line in strict E.164 (`+12242220082`). Caller ID on Zul's outbound calls and the number clients dial inbound. |
| `VA_CELL` | Zul's cell in strict E.164 (`+63…`), the bridge target Twilio calls. **Never run through `normalizePhone`** (US-centric). Lives only here — never on a DB record, never committed. |
| `RUN_VA_CALLING_SCHEDULER` | Optional. Set to `false` to disable the VA-calling scheduler (hourly prune of `pending_call`/`call_audit`/`telegram_update`/`voicemail_delivery`, the undelivered-voicemail redelivery sweep, and the Telegram webhook heartbeat). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_PRESENCE_SCHEDULER` | Optional. Set to `false` to disable the presence stale-desk nudge / auto-flip sweep. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `VA_CALL_DAILY_CAP` / `VA_CALL_PER_MIN_CAP` | Toll-fraud spend caps: max calls placed per rolling 24h (default 40, DB-backed by counting `call_audit`) and max triggers accepted per minute (default 5). On trip the bot tells Zul and no call is placed. |
| `VA_CALL_TIME_LIMIT_SEC` / `PENDING_CALL_TTL_SEC` | Per-call hard `timeLimit` on both call legs (default 1800 = 30 min) and confirm-before-dial pending-record TTL (default 120s). |
| `LEAD_CALL_ENABLED` | Lead call bridge kill switch: `false` disables the new-Thumbtack-lead auto-call trigger entirely (redeploy-free, `HARVESTER_ENABLED` precedent). Default on — set `false` in Render BEFORE the feature's first deploy (ship dark until the live relay test passes). |
| `LEAD_CALL_DAILY_CAP` | Max lead-call attempt chains opened per rolling 24h (default 25). Toll-fraud backstop for the lead call bridge; normal volume is ~2-3 leads/day. |
| `VOICEMAIL_ENABLED` | 224-inbound voicemail master switch, **default OFF** (only `'true'` enables). Off means a missed inbound call hangs up exactly as it did pre-feature: no Telegram ping, no greeting, no recording. Ships dark; flip in Render after the live call test. |
| `VM_MAX_LENGTH_SEC` | Max voicemail recording length in seconds (default 120, parsed and clamped to 30..300). Per-call recording spend cap. |
| `VM_DAILY_CAP` | Max voicemail-path calls per rolling 24h (default 50), counted from `voicemail_delivery`. The inbound analog of `VA_CALL_DAILY_CAP`: a missed call used to cost nothing after ring timeout and now costs greeting + up to `VM_MAX_LENGTH_SEC` of billed recording. On trip the missed handler hangs up and sends no ping. |
| `VA_INBOUND_PER_MIN_CAP` | Global inbound-call flood cap per minute (default 30) on `POST /api/voice/inbound`; on trip it returns busy TwiML and never dials. Long-standing but undocumented until 2026-07-22. |
| `TT_AUTOREPLY_ENABLED` | TT auto first-reply master switch, **default OFF** (`'true'` enables). Gates the webhook-tail fork (enqueue vs direct call) AND empties the agent offer endpoint. Deliberately does NOT gate the fallback sweep, so a rollback flip still drains in-flight day leads. |
| `FIRST_REPLY_FALLBACK_MINUTES` / `FIRST_REPLY_CALL_MAX_AGE_MINUTES` | Day-lead call fires anyway when the reply is unconfirmed past the fallback threshold (default 3 min); no callback/sweep call ever fires for a lead older than the freshness bound (default 240 min; the promise of a call expires). |
| `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` | Optional. `false` disables the 60s first-reply sweep (call fallback + strand hygiene). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `MAX_FIRST_REPLY_ATTEMPTS` / `FIRST_REPLY_COOLDOWN_INTERVAL` | Offer-side attempts cap before a queued reply flips to `failed` (default 3; the OFFER bumps the counter, so a dead agent still hits the cap) and the lease re-offer interval (default `'10 minutes'`). |
