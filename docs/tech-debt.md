# Tech Debt Backlog

**Source:** `.claude/full-audit-2026-04-24.log` — items identified by the 2026-04-24 `/full-audit` but deferred from the bucket-B remediation (commits `cbd42a9..b6c85dc`).

Each item is eligible to be re-opened as its own spec when priorities align. Sorted by risk/effort category.

> **Note (2026-04-27):** File paths and line numbers below were captured before the structural cleanup pass that split `server/routes/admin.js` → `server/routes/admin/`, `server/routes/proposals.js` → `server/routes/proposals/`, `client/src/pages/AdminUserDetail.js` → `pages/admin/userDetail/`, `client/src/pages/website/QuoteWizard.js` → `pages/website/quoteWizard/`, and `client/src/pages/proposal/ProposalView.js` → `pages/proposal/proposalView/`. **File paths updated below; line numbers may be approximate** — re-grep for exact line if doing surgery.

---

## Schema migrations — need backup + verification plan

### shifts.positions_needed + equipment_required: TEXT → JSONB

**Source:** audit log, "Follow-up pass" item L; schema-drift scan section 5.
**What:** Both columns currently store JSON text (default `'[]'`) and require `JSON.stringify`/`JSON.parse` at every callsite and `::json` casts at query time. The 2026-04-15 plan doc flagged this for migration; never executed.
**Why deferred:** Requires a production data migration (TEXT → JSONB with content coercion) and a sweep of every callsite removing the stringify/parse boilerplate. Belongs in its own spec with a rollback plan.
**Callsites to update after migration:** `server/utils/autoAssign.js:128-129`, `server/routes/admin/settings.js:129-132` (badge-counts `::jsonb` casts in the unstaffed-events sub-select; remove after migration), `client/src/pages/admin/AdminDashboard.js:400`, `client/src/pages/staff/StaffShifts.js:97`, `client/src/pages/admin/ProposalDetail.js:156`.
**Next step:** Brainstorm migration script → coordinate with a deploy window → roll codebase sweep.

### Dead column drops

**Source:** audit log, schema-drift scan section 2.
**What:** Columns that are in schema but unused anywhere in code:
- `service_addons.is_default` — default `false`, never read or written
- `users.calendar_token_created_at` — written but never read
- `shifts.client_email`, `shifts.client_phone` — INSERTed via manual-event path, never SELECTed
- `applications.favorite_color` — INSERTed + displayed but never used in logic (humor field — confirm intent before dropping)

**Why deferred:** Each drop needs a quick user confirmation ("is this truly dead or scaffold for a future feature?"). Batchable into a single cleanup spec.
**Next step:** Confirm each column → write a single DROP COLUMN migration with idempotency guards.

---

## Shape validators — cross-cutting refactor

### pricing_snapshot shape validator

**Source:** audit log, item K.
**What:** `proposals.pricing_snapshot` JSONB is written by `server/utils/pricingEngine.js:343` and read by 6+ distinct files: `server/routes/stripe.js`, `server/utils/invoiceHelpers.js` (twice), `server/routes/clientPortal.js`, `server/routes/proposals/publicToken.js` (GET /t/:token), `server/routes/proposals/crud.js` (PATCH /:id reads `old.pricing_snapshot`), `server/routes/drinkPlans.js` (twice). Any key rename in the pricing engine silently breaks all downstream consumers at runtime.
**Why deferred:** Requires a `PRICING_SNAPSHOT_VERSION` constant, a validator function, a consumer-side assert on read, and a write-time version stamp. Cross-cutting refactor — not trivial.
**Next step:** Design the validator contract → add version field → wrap all 6 read sites in version-aware parsing.

### adjustments + class_options shape validators

**Source:** audit log, items N + Phase 2 scope.
**What:** `proposals.adjustments` (JSONB array of `{label, amount, type?}`) has no server-side shape validation before INSERT. `proposals.class_options` has a whitelist in ONE insert path (`proposals.js:385-388`); other writers could bypass.
**Why deferred:** Requires extracting `normalizeAdjustments()` and `normalizeClassOptions()` helpers in `server/utils/` and routing every writer through them.
**Next step:** Write the helpers → find every writer (`rg "adjustments.*JSON.stringify"`, `rg "class_options"`) → route through normalizers.

---

## Architecture refactors — each needs its own design session

### True schedulers-to-worker-process split

**Source:** Codex server `[P1]`, audit top-21 item #6. Bucket B landed the env-guard stopgap (`RUN_SCHEDULERS=false` on additional instances); the ideal is a dedicated worker entrypoint.
**What:** A dedicated `server/worker.js` that runs ONLY the schedulers (balance/event-completion/auto-assign/email-sequence/quote-draft-cleanup). Render runs one web service (no schedulers) + one worker service (schedulers only). Eliminates every class of "scheduler ran N times because N web instances" bug.
**Why deferred:** Changes deployment topology on Render; needs a second service or process-group setup; might affect pricing.
**Next step:** Design doc for worker-process split + Render YAML + migration runbook.

### Drink-plan extras pricing service

**Source:** Codex server `[P2]`.
**What:** Add-on + bar-rental + syrup charges are recomputed inline in three places: `server/routes/stripe.js:197-216` (create-drink-plan-intent), `server/routes/drinkPlans.js` (mutating `proposal_addons`), and `server/utils/invoiceHelpers.js` (building the extras invoice). One concept, three owners.
**Why deferred:** Cross-cutting extraction; needs tests around pricing parity.
**Next step:** Extract to `server/utils/drinkPlanPricing.js`; route all three consumers through it; add golden tests.

### Proposal-creation workflow consolidation

**Source:** Codex server `[P2]`.
**What:** Public and admin proposal-creation paths in `proposals.js:365` already diverge in validation, side effects, and pricing calculation. Every new field requires manual sync across both branches.
**Why deferred:** Real refactor; needs behavioral tests to confirm no regression across both flows.
**Next step:** Design doc; extract `createProposal(ctx, input)` service; both routes consume.

### PotionPlanningLab state-controller split

**Source:** Codex client `[P2]`.
**What:** `client/src/pages/plan/PotionPlanningLab.js` orchestrates API loading, migration, autosave, browser-history interception, payment-redirect handling, queue derivation, AND step rendering. Steps are thin leaves over shared mutable state — large prop bags.
**Why deferred:** Large restructure; risk of breaking an already-complex wizard.
**Next step:** Extract controller hooks (`usePlanAutosave`, `usePlanHistory`, `usePlanQueue`) or a flow context; steps become presentation-only.

### ClientAuthContext via utils/api.js

**Source:** Codex client `[P2]`.
**What:** `client/src/context/ClientAuthContext.js:13-23` uses raw `fetch` instead of the shared `utils/api.js` axios instance. Two auth domains, two error-handling paths, two base-URL resolutions. Error semantics drift by user type.
**Why deferred:** Small enough to do standalone but needs verification it doesn't break the client portal.
**Next step:** Route client auth through `utils/api.js` (preserve separate token storage key); verify client-portal flow end-to-end.

### App.js route manifest dedup

**Source:** Codex client `[P2]`.
**What:** `HiringRoutes`, `StaffSiteRoutes`, and the admin branch in `AppRoutes` (`client/src/App.js:189-231`) re-declare the same onboarding, portal, and token-based routes with small variations. Three manifests to keep in sync.
**Why deferred:** Routing refactor; high risk of breaking site-context switching.
**Next step:** Extract shared route groups and compose them from a single source.

### QuoteWizard ↔ ProposalCreate policy dedup

**Source:** Codex client `[P2]`.
**What:** `client/src/pages/website/quoteWizard/QuoteWizard.js` (parent + step components in `quoteWizard/steps/`) and `client/src/pages/admin/ProposalCreate.js` both own package/add-on eligibility, draft persistence, pricing preview, event-type lookup, and submission rules. They have already drifted (`filteredAddons`, event-type search, preview payloads/endpoints).
**Why deferred:** Large refactor.
**Next step:** Centralize policy + preview/draft adapters in shared modules consumed by both flows.

---

## Perf — low-frequency admin loops (deferred by risk/reward)

### Geocode backfill bulk UPDATE

**Source:** audit follow-up item D.
**What:** `server/routes/admin/settings.js:68-100` (POST /backfill-geocodes) — per-profile and per-shift geocode backfill loops do sequential 1.1s Nominatim + per-row `UPDATE`. Admin one-off endpoints, rarely hit.
**Why deferred:** Low frequency; replacing the per-row UPDATE with a bulk `unnest()` CTE is straightforward but not urgent.
**Next step:** Keep the 1.1s Nominatim throttle, collect successes, bulk UPDATE at end.

### Blog import parallel uploads + batch INSERT

**Source:** audit follow-up item E.
**What:** `server/routes/admin/blog.js` (POST /blog/import) — sequential image uploads + single-row INSERTs per blog post. Used once every few months at most.
**Why deferred:** Low frequency.
**Next step:** Parallelize image uploads with `Promise.all`; single multi-row VALUES INSERT.

---

## Low-value / nice-to-have

### Failed-login DB audit trail

**Source:** audit log A09.
**What:** Failed logins are logged to console only; Render retention is short. In-memory `loginAttempts` Map provides basic lockout.
**Why deferred:** Low immediate risk. Sentry captures patterns via rate-limit 429s.
**Next step:** Optional — add `failed_logins` table if audit/compliance needs grow.

### Pagination on tenure-dependent endpoints

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** Five admin/staff endpoints now have `LIMIT 500` added in the bucket-B push to prevent unbounded list returns, but the cap is high enough that long-tenured users won't hit it for 1-2 years:
- `server/routes/shifts.js:/user/:userId/events` (LIMIT 500) — 2.5+ year bartender at 4 events/week hits it
- `server/routes/shifts.js:/my-requests` (LIMIT 500) — same tenure threshold
- `server/routes/emailMarketing.js:/campaigns/:id` sends (LIMIT 500) — hits with a single 10k-lead campaign
- `server/routes/emailMarketing.js:/campaigns/:id` enrollments (LIMIT 500) — same
- `server/routes/emailMarketing.js:/campaigns/:id` conversation history — paginated already
**Why deferred:** Each needs frontend pagination support (paging controls, "load more" button, or infinite scroll). Frontend consumers were not touched in the bucket-B push to keep the commit focused. Once a user hits the cap, the UI silently shows an incomplete list with no indicator.
**Next step:** Add `?page=` / `?limit=` query support and frontend paging in an incremental PR. Triggered event: first support ticket mentioning "missing old events" or "campaign shows 500 sends but blast went to 10k."

### Campaign-list query performance

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** `GET /api/email-marketing/campaigns` list uses three correlated `COUNT(*) FROM email_sends WHERE campaign_id = c.id AND status = ...` subqueries per row. At 100 campaigns × 10k sends per campaign that's 3M row scans per list call.
**Why deferred:** Scale concern, not a current problem.
**Next step:** Add partial indexes on `email_sends(campaign_id) WHERE status = 'opened'` / `WHERE status = 'clicked'`, OR refactor to a single aggregated subquery with `COUNT(*) FILTER (WHERE status = ...)`.

### admin.js applications filter CASE expression blocks index

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** `server/routes/admin/applications.js:22-50` (the `ARCHIVED_FILTER` const + its callsite in GET /applications) uses `CASE WHEN $1 THEN u.onboarding_status = 'rejected' ELSE u.onboarding_status IN ('applied','interviewing') END`. The parameterized CASE prevents Postgres from using `idx_users_onboarding_status` — predicate pushdown doesn't apply to parameterized branches.
**Why deferred:** At current scale (~100s of applicants) seq-scan is faster than index anyway. Parameterization was chosen over string-concat specifically to remove the SQL-injection-adjacent pattern flagged by the audit.
**Next step:** When application volume exceeds 10k rows, rewrite as two branches selected in JS with const string literals (no user input = no injection surface):
```js
const statusPredicate = archived
  ? `u.onboarding_status = 'rejected'`
  : `u.onboarding_status IN ('applied','interviewing')`;
```

### Stripe webhook catch swallows DB errors (returns 200)

**Source:** 2026-04-24 push pre-review (security-review agent, M2).
**What:** `server/routes/stripe.js:788-798` (and 931-941) — when the DB transaction fails inside the signature-verified webhook handler, the `catch` block captures to Sentry + ROLLBACKs, but falls through to `res.json({ received: true })` on line 961. Stripe sees 200, does not retry. A transient DB outage during `payment_intent.succeeded` processing silently drops the payment record.
**Why deferred:** Pre-existing behavior (not introduced by bucket B). Narrow-scope remediation was the goal.
**Next step:** Rethrow from the catch blocks to propagate to asyncHandler → 500 response → Stripe retry.

### Dead-letter readers for forensic blobs

**Source:** schema-drift scan section 5.
**What:** `email_webhook_events.processed`, `thumbtack_leads.raw_payload`, `thumbtack_messages.raw_payload`, `thumbtack_reviews.raw_payload`, `proposal_activity_log.details` — all written, never read back in any admin UI.
**Why deferred:** Intentional forensic/audit storage per design.
**Next step:** Revisit only if a debugging incident requires on-demand access.

### DEFAULT vs always-supplied column duplication

**Source:** schema-drift scan section 7.
**What:** ~10 columns have schema DEFAULTs that never trigger because every writer supplies a value (`users.notifications_opt_in`, `proposals.guest_count`, `proposals.event_duration_hours`, `stripe_sessions.amount`, etc.).
**Why deferred:** Harmless code smell. Removing the explicit JS fallback OR the DEFAULT is a one-line cleanup but provides no behavior change.
**Next step:** Sweep during next routine DB maintenance.

---

## Accepted risks — document, don't fix

These were identified during audit but are deliberately not addressed:

- **npm audit `react-scripts` transitive CVEs** (14 high / 6 moderate). CRA is abandoned upstream. None ship to production browser bundle (webpack-dev-server is dev-only, svgo/nth-check/workbox are build-time). Migration off CRA to Vite or Next.js is its own project.
- **Helmet CSP `'unsafe-inline'` in `styleSrc`**. Required by Stripe Elements + inline React styles. Documented compromise.
- **In-memory `loginAttempts` Map** in `server/routes/auth.js:15-17`. Acceptable for single-instance Render. Multi-instance deploys will bypass the lockout per-IP rotation. Revisit if/when moving to multi-instance.
- **Email `html_body` shipped to every campaign-step edit request**. Campaign-step detail needs the body to edit; no meaningful optimization available short of a separate `/steps/:id/body` lazy-fetch endpoint. Current scale doesn't warrant.
