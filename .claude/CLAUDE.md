# Dr. Bartender: project rules

Four sections: invariants (law that protects money, auth, data and code; whenever this file is staged, the pre-commit hook checks it against `scripts/claudemd-invariants.txt`, so a dropped invariant refuses the commit), how work flows, conventions, and pointers. Conventions are questionable by default: when one gets in the way, say so, change it and update its why in the same change. [Claude default 2026-06-19]

Every rule ends with its provenance: `[Dallas <date>]` when the owner decided it, `[Claude default]` when Claude derived it. A rule found without a bracket is a Claude default and may be dropped, saying so in one line; mechanics (what a script does) carry none. How to work with the owner lives in the private global rules file, never here. [Claude default 2026-10-19]

TRANSITIONAL (2026-10-29, removed by the step 5 legacy-removal lane): until the flip marker (`<git-common-dir>/drb-flip.json`) exists, pushes are cue-only, through `npm run gate` and then a push of the literal sha; `npm run ship` refuses until then. [Claude default 2026-10-20]

---

# Invariants

## Git safety

- `os` never leaves main: never `checkout`, `switch` or `checkout -b` inside `os`; a branch exists only as a lane worktree under `../worktrees/`, driven by path. Why: `os` is one shared checkout with one HEAD across parallel windows, and moving it strands another window's commits. `scripts/guard-os-main.sh` (pre-commit) refuses a commit on a non-main branch in `os` and a spec or plan committed off main. [Claude default 2026-06-19]
- Code preservation beats shipping speed: when a git operation could destroy uncommitted or unpushed work, stop and ask. Why: lost work is unrecoverable; a late ship is not. [Claude default 2026-04-15]
- Explicit staging: `git add <specific-path>` only, never `git add .`, `-A` or `-u`. Why: a sweep takes in screenshots, `.playwright-mcp/`, `.env` and another window's staged work. [Claude default 2026-04-15]
- Never `git reset` on main and never `--amend` a pushed commit: undo pushed work with `git revert <sha>`, unstage with `git restore --staged <path>`, keep `git reset --soft HEAD~N` for a lane, and on an unpushed commit prefer a new commit, amending only on request. Why: rewriting shared main or pushed history breaks every other checkout. [Claude default 2026-04-15]
- Destructive ops need explicit approval, a per-action yes every time: `push --force`, `reset --hard`, `clean -f`, `checkout .`, `restore .`, `rm` on tracked files and `branch -D`. The one standing exception is deleting a lane branch after its squash merge when three checks pass, run and stated with the delete: the squash is on main (`git log main --grep "merge(lane <name>"`), `git diff main <branch> -- <every file the lane touched>` is empty, and the lane's worktree is gone. Why: the others are irreversible, and a branch that passes the checks is provably redundant. [Claude default 2026-04-15; the merged-lane exception 2026-07-02]
- Never scrap unmerged work: before any scrap `git log main..<lane-branch>` must be empty, and when it is not, ask; an automatic scrap uses `git branch -d` (which refuses unmerged work), never `-D`. [Dallas 2026-06-19]
- Branches and stashes outside the lane model need a yes with a one-line reason and are never created silently. Why: ad-hoc branches and stashes are where work goes missing. [Claude default 2026-04-15]
- A push rejection stops and reports, never auto-resolves: no auto-pull, auto-rebase or force-push (a sha a fetch shows already in `origin/main` is reported as shipped by another window). Why: an automatic fix can clobber work or ship the wrong thing. [Claude default 2026-04-15]

## Main is prod

- Every commit on main ships after the gate: `npm run ship` gates `origin/main..<sha>` in a throwaway worktree, pushes that sha and starts the post-ship watch; the gate runs nothing for a docs-only range (the dated line above says what stands until the flip). [Dallas 2026-10-18]
- Nothing reaches main without a review receipt: a lane gets its receipt before its merge and a quick fix before its commit, through the review skill (`.claude/skills/review/`); from the flip on, the merge path and the pre-push hook check it. [Dallas 2026-10-18]
- Commits on main are finished work: reviewed, tested, one per logical feature; no WIP or checkpoint commit reaches main, since a lane's checkpoints are squashed away. Why: a revertable history where a commit is a unit of intent. [Claude default 2026-04-15]

## Money, auth and data

- Money is integer cents, never floats. [Claude default]
- Pricing lives in `server/utils/pricingEngine.js`: pure functions, no DB calls. [Claude default]
- Stripe calls go through `server/utils/stripeClient.js`, never `require('stripe')`; it honors `STRIPE_TEST_MODE_UNTIL` and fails closed without credentials. [Claude default]
- The dev box talks to live Stripe by design: a dev charge, refund or payment link is real, and no `NODE_ENV` gate or test key goes in; the gate worktree (`push-gate.js sha`, docs/dev.md) is the one exempt environment and holds no live key. [Dallas 2026-08-19; Claude default 2026-10-22 for the gate worktree]
- A price change re-evaluates the paid flag against `amount_paid` (which carries `external_paid`) through `reconcileProposalPaymentStatus`; never leave a proposal marked paid when it is not (`docs/money-laws.md` law 8). [Claude default]
- Hosted (per-guest) packages include one bartender per `pkg.guests_per_bartender` guests (default 100) at $0 with $0 gratuity; bartenders above the ratio, by the `num_bartenders` override or the `additional-bartender` add-on, are charged at `pkg.extra_bartender_hourly` plus the sub-100-guest surcharge. Use `isHostedPackage(pkg)` and `staffing.required` from the engine, zero only the first `staffing.required`, and grep `isHostedPackage` before any new bartender-cost path; this rule has been lost more than once (`docs/money-laws.md` law 10). [Dallas 2026-05-14]
- Gratuity is a per-staff-per-hour rate (`gratuity_rate`); the dollar line is always computed (`gratuityLineAmount`) and added on top of `total_price`, never diluted by a discount or override. [Claude default 2026-06-08]
- Outside an admin mandate the client's election persists only at payment: create-intent stamps it into PaymentIntent metadata and the `payment_intent.succeeded` webhook applies it under the payable-status guard inside a `SAVEPOINT`; the admin PATCH takes only `gratuity_mandate_total`. [Dallas 2026-08-10 for the mandate; Claude default for the mechanics]
- The full gratuity rule is `docs/money-laws.md` section 14, moved there verbatim; read it, and grep `gratuityLineAmount` and `GRATUITY_LABEL`, before touching gratuity. [Claude default 2026-10-20]
- Parameterized SQL (`$1`, `$2`) only; never concatenate input into SQL. [Claude default]
- One pooled connection per request: a handler holding a `pool.connect()` client sends every query through it until `client.release()`, never a bare `pool.query()`, and releases it before a post-COMMIT tail that calls a helper taking its own connection (anything in `marketingHandlers.js`). Why: a request waiting on a second connection deadlocks the pool at `max` (SERVER-17; the 2026-07-13 capture-lead deadlock), and `pool.query()` is the right default everywhere else. [Claude default 2026-07-13]
- Route handlers are wrapped in `asyncHandler` and throw `AppError` subclasses (`server/utils/errors.js`) for client-visible errors; error responses never leak internals (stacks, SQL, paths, a raw database or SDK error), and the one allowed surfacing in an error response is a payment provider's decline or rejection reason on an admin or manager money route (refund, charge-balance), meant for the operator to read. [Claude default]
- Auth middleware (`{ auth }`, or `clientAuth` on the client portal) on every non-public route, with a role guard (`req.user.role`) wherever a role is required, `requireOnboarded` on every staff-data surface (a self-registered applicant holds a live staff JWT until onboarding completes), and a `req.user.id` scope where the caller's own rows are the answer; a new client route goes into `App.js` behind the matching guard; reads are scoped by the current relationship row or `req.user.id`, never open to IDOR. [Claude default]
- `server/routes/webauthn.js` (`assert-verify`) is the only site that mints the 12h device JWT; revoking a passkey bumps `users.token_version`, a deliberate global logout. [Claude default 2026-08-13]
- Public routes (drink plans, proposals, invoices) are token-gated by a UUID token in the URL instead of auth. [Claude default]
- Server-side validation of every input (type, length, format); client checks mirror it and never replace it. [Claude default]
- Uploads (`express-fileupload`) are validated by magic bytes through `server/utils/fileValidation.js` before they go to R2, with the URL stored in the DB. [Claude default]
- Secrets come only from `process.env`, never from code. [Claude default]
- Multi-table writes run inside `BEGIN`/`COMMIT`/`ROLLBACK`. [Claude default]
- Bank PII (the banking fields on `users` and `payouts`) goes through `server/utils/encryption.js` (AES-256-GCM, fails closed in prod), never plaintext. [Claude default]
- Schema changes go in `schema.sql` as idempotent statements (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). [Claude default]
- Client name and event type are separate data points, never concatenated into a title and never prompted as an `event_name`; display uses `getEventTypeLabel({ event_type, event_type_custom })` with `'event'` as the fallback, from the hand-synced pair `client/src/utils/eventTypes.js` (ESM) and `server/utils/eventTypes.js` (CJS). [Claude default 2026-04-17]
- The event-side drink plan is canonical and the proposal-side plan a preview: bartender prep, shopping-list approval and client messages use the event's plan, so drink-plan UI is verified on the event path; pricing still verifies on the proposal side. [Claude default 2026-04-29]
- The legal-hold proposal (`docs/money-laws.md` law 15) keeps its database state exactly: never archived, swept, repriced, chased, cleaned up or read by the AI; every writer guard calls `server/utils/legalHold.js:isLegalHold`, which fails closed. [Dallas 2026-08-11]
- The AI and mail providers are reached only through their one wrapper each in `server/utils/` (`anthropicClient.js`, `openaiClient.js`, `geminiClient.js`, `gmailClient.js`), whose header holds its rules; each refuses a real call under `NODE_ENV=test` unless a test injected a stub, and `node --test` does not set it, so every menu art suite sets `process.env.NODE_ENV = 'test'` on its first line. Every wrapper pins its host; the Gmail feed is read-only and never sends; Gemini runs with `store: false` and Vertex off; the OpenAI org, project and logging variables are ignored. [Claude default 2026-10-01]
- Nothing leaves the OS for the Inbox AI read without `server/utils/inbox/aiRedact.js` (phone, card and account numbers, email addresses and links dropped, and the surname when it is capitalized or right after the first name, an everyday-word surname only right after the first name); menu art sends no client name, contact, venue, address or event date (`menuArtPrompts.js`), and its wrappers store or send to Sentry only a sanitized error descriptor, never the SDK message. [Claude default 2026-10-06]
- The repo is public: no real client's or staff member's name, phone number or email address goes into any file, commit message, fixture or diff sent to an external reviewer. People are named by role and records by id; fixture values stay in the shapes the PII scanner allows (a phone on the 555 exchange, a business line or an unassignable number; an email on a reserved or the business domain), as `scripts/lib/piiShapes.js` defines them, and codex and gemini get only a diff it masked; the business lines, and the owner's first name inside a provenance bracket, are not exposures. [Dallas 2026-10-02 for phone numbers, narrowed 2026-10-19; Claude default 2026-10-14 for names and emails]
- Cross-cutting: if you change X, grep every consumer of X and update it in the same change: a price change and its payment status; event details (date, time, location, guest count) and the linked shifts; a phone field's format and every component, route and display of it; a schema column and every SELECT, INSERT, UPDATE, component and display; a data shape and every endpoint, component and PDF template. Why: one part of the system left out of sync is the defect. [Claude default]

---

# How work flows

## Two tracks

- How the work is asked for picks the track: a quick fix is done on main in `os` (edit, `npm run docs`, the review skill on the staged diff, commit); a project thinks on main and builds in a lane. A tier A change is a lane however small. Why: a commit on main is prod, and the shared index cannot be held through a money review. [Claude default 2026-10-19]
- Thinking lives on main: brainstorm, spec and plan commit to main the moment they exist, any number of planning windows at once. Why: a plan committed to a branch whose code never landed was lost thinking, and nothing valuable sits on a branch now. [Claude default 2026-06-19]

## Lanes

- A lane is a short-lived worktree under `../worktrees/`, code only, owned end to end by Claude, who cuts it from current main, builds and reviews it, squash-merges it and removes it, all without asking. [Dallas 2026-06-19]
- Create and remove a lane only with `npm run worktree:new` and `npm run worktree:rm` (they link `node_modules`, `client/node_modules`, `.husky/_`, both env files and the lane's memory root), never a bare `git worktree add`; the superpowers worktrees skill does not apply here. [Claude default 2026-06-19]
- Inside a lane, pick the build method that fits (one pass for a small coherent lane, parallel subagents for independent pieces) and say which; commit checkpoints freely, since the squash is the unit, and re-cut from the plan a lane that cannot be repaired. [Claude default 2026-06-19]
- `lane:status` runs at every session start through the `SessionStart` hook and prints the flip, gate and watch markers, the last ship and the stale lanes; `npm run lane:status` is the full report. A lane is stale after 48h with no commit, 15 or more commits behind main, or once a sensitive path landed on main since its cut; a dead lane is scrapped and re-cut from its plan, salvaging code only when it is substantial and clean. [Claude default 2026-06-19]
- The merge path is `scripts/merge-lane.sh`, run from `os` on main, never from a lane: one merge at a time under an exclusive lock, refusing a dirty `os` (commit the quick fix first) and the other cases its header names; it squashes the lane, regenerates the docs on the merged index and commits once as `merge(lane <name>): <plan>`. The lane's worktree and branch stay until the merge verifies clean and its review holds against main's new head (a stale base gets the overlap pass of the review skill). [Claude default 2026-06-19]
- A merge conflict: an ordinary one is resolved from both diffs and both plans and reported; one on a sensitive path, or one with no clear resolution, stops. [Claude default 2026-06-19]
- Hold: work asked to be held is built in a lane and left unmerged until the owner says ship, since the next ship from any window carries whatever sits on main. [Claude default 2026-10-19]
- A standing gate marker (a failed gate on a sha on main) or watch marker (Sentry events after a deploy) refuses every push until it clears: the first by a passing gate on a descendant (fix forward, never reset), the second by `npm run ship -- --ack-watch <sha> --note <text>` after reading the events (docs/dev.md, The sha gate). [Claude default 2026-10-19]
- After a bad ship the fastest fix is `git revert <sha>`: a clean revert is reviewed by construction (`ship` recognizes it and writes a revert receipt); Render's dashboard rollback is the hand lever (docs/dev.md, Render). [Claude default 2026-10-19]

## Plans, design and review

- A plan is a lane map without code: per lane its `id`, scope, `footprint`, `blockedBy`, the lenses expected, runnable acceptance checks, the money laws and seams that apply, and the test plan, in the front matter the design agents read; code appears only where the code is the decision, and a lane that needs a file outside its footprint stops and says so. [Claude default 2026-10-19]
- Design-stage review before any code: `/review-spec` (spec-grounding, spec-gaps, spec-risk) on a spec and `/review-plan` (plan-fidelity, plan-decomposition) on a plan, report-only. [Claude default 2026-06-19]
- Design artifacts are contracts: a surface designed through claude.ai/design delivers its decisions (IA, copy, semantics) and its visual system (layout, component vocabulary, tokens), and both must survive to the build, by the four lines below. [Claude default 2026-08-14]
  - Spec: a Visual contract section in the body names the artifact (the snapshot under `docs/design-artifacts/` and the design-project id) as the build benchmark and states per-screen layout and composition, the component vocabulary and the token-translation rule; a bare "Design source:" header line is provenance, not a contract.
  - Plan: one named lane owns visual fidelity ("match the artifact") with the artifact as its declared input and pulls the generated screen files through DesignSync (`list_files`, then `get_file`); a design that arrives as an export (DesignSync serves only `/design-sync` flows) is vendored byte for byte and is the working input instead, and the spec says so (the 2026-10-06 Inbox is the precedent); otherwise the vendored `.dc.html` is a snapshot for the record.
  - Review: the `client` lens on a designed surface judges adherence to the artifact, so usability-clean but off-design is a finding.
  - Why: on 2026-08-14 an approved design was vendored and cited but never made a requirement, every gate checked only its immediate upstream, and the section shipped with no fidelity to the design; the spec is the pipeline's root of truth.
- Review runs once per lane: one full pass of the lenses the review skill selects, then at most two fix re-passes; only a reachable failure path or an exposure opens a round, the rest goes to the lane report, and a reachable finding still open after the second re-pass splits the lane. The superpowers per-task reviewer ritual does not apply here, and nothing is reviewed again at push. [Dallas 2026-07-22; the cap 2026-10-23; Claude default 2026-10-20 for no review at push]
- A finding on anything important (money, auth, data integrity, logic, cross-cutting, integration) is fixed at its root through `superpowers:systematic-debugging`, checking where else it shows; a trivial one-liner gets the direct fix. [Claude default]

---

# Conventions

- camelCase for JS variables and functions, snake_case for DB columns and API JSON keys. Why: one spelling per layer. [Claude default]
- No ORM: raw SQL through `pool.query()` or the held client. Why: every query is visible where it runs. [Claude default]
- Route files export an Express Router, one file per resource under `server/routes/`; a big one splits into per-concern files behind a composition router (`server/routes/proposals/`). [Claude default]
- Client API calls go through `client/src/utils/api.js` (axios with the JWT attached), never raw `fetch` or `axios`; a failed call rejects with `{ message, code, fieldErrors, status }`. Why: one place for auth, session expiry and the error shape. [Claude default]
- Vanilla CSS: `client/src/index.css`, the tokens in `client/src/styles/drb-tokens.css`, and a per-page CSS file where a page needs one; no CSS modules, utility frameworks or preprocessors. [Claude default]
- Every source file under `server/`, `client/src/` and `scripts/` starts with a header comment whose first paragraph is its line in README's generated tree; `npm run docs` regenerates the generated sections of README.md and ARCHITECTURE.md, the pre-commit hook refuses a stale section or a header-less staged file, and ARCHITECTURE prose is hand-written only when a concept changes (docs/dev.md, Docs). Why: the docs come from the code, so they cannot drift. [Claude default 2026-10-27]
- File-size ratchet: `scripts/check-file-size.js` (pre-commit) warns at 700 lines and refuses a commit that grows a file past 1000; aim under 300 and split by the codebase's patterns (a composition router, per-domain template siblings such as `lifecycleEmailTemplates.js`, extracted page sections). [Claude default]

---

# Pointers

- The review skill, `.claude/skills/review/SKILL.md`: how a change is reviewed and its receipt written.
- `docs/dev.md`: the servers, the tests, the gate, lanes and ships, the docs, Render and Vercel, as they run on the dev box.
- `docs/money-laws.md`: the money laws, read before any money-path change.
- `scripts/sensitive-paths.txt`: the sensitive list, matched by `scripts/sensitive-match.js`.
- `.env.example`: the one copy of every environment variable, each described by the comment above it, which README renders; add or change a variable there and nowhere else.
- The ledger, `docs/fix-list-remaining-2026-07-02.md`: the owner's one list.
- `docs/ops-runbook.md`: the manual procedures. `docs/reviewer-map.md`: a two-minute map of the system for a reviewer.
- `README.md`: the stack table, the generated folder tree, env table and scripts list, the test gate. `ARCHITECTURE.md`: the generated route table and the concepts. Read them to find where a file lives.
