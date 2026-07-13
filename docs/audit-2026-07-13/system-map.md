# System Map — Dr. Bartender `os` (2026-07-13 audit)

**HEAD:** `46e969b` on `main` · **Method:** 12 parallel subsystem mappers, code-grounded (55-agent audit workflow, this doc + `tech-debt-register.md` + `migration-plan.yaml` are its outputs)

This is the altitude view: what each subsystem is, what it owns, and where it seams into the others. Route-by-route detail stays in `ARCHITECTURE.md`; folder tree and npm scripts stay in `README.md`. Read this doc first when planning any change that crosses a subsystem boundary.

## Vital statistics

| Metric | Value |
|---|---|
| Server code | ~90.8k LOC (`server/`, incl. tests) |
| Client code | ~78.2k LOC (`client/src`: 58.2k JS + index.css 18,175 lines / 515KB) |
| Database | 84 tables, `schema.sql` 3,778 lines (idempotent boot-replay, no migrations dir) |
| Route files | 94 · Util files ~130 (excl. tests) |
| Tests | ~230 `*.test.js` (203 server node:test, 19 client, 9 scripts) |
| Schedulers | 13 wrapped jobs + staleness monitor, all in the single web process |
| Deploy | push to `main` = Render (server) + Vercel (client); no hosted CI |

## Topology

```
                    drbartender.com          hiring./staff./admin. subdomains
                          │                                │
                 ┌────────┴────────────────────────────────┴───────┐
                 │  React 18 CRA SPA (one bundle, host-dispatched   │
                 │  into 4 route trees via getSiteContext)          │
                 └────────────────────────┬────────────────────────┘
                                          │ axios utils/api.js (JWT) + raw-axios token pages
                 ┌────────────────────────┴────────────────────────┐
   webhooks ───► │  Express (server/index.js): ~40 route mounts,   │ ◄─── Thumbtack, Cal.com,
   Stripe/Resend │  auth middleware, rate limiters, error funnel,  │      Telegram, Twilio Voice
                 │  13 schedulers registered in-process            │
                 └────────────────────────┬────────────────────────┘
                                          │ single pg Pool (max 50), raw SQL
                 ┌────────────────────────┴────────────────────────┐
                 │  Neon Postgres: 84 tables, schema.sql replayed  │
                 │  idempotently at every boot                     │
                 └─────────────────────────────────────────────────┘
   Side channels: R2 (files), Resend (email), Twilio (SMS/voice), Telegram (VA calls),
   Google Places (venues), Sentry (both sides), off-box Playwright harvester (Thumbtack email)
```

**The money spine** (the path to protect): quote pricing (`pricingEngine`, pure, DOLLARS) → `proposals.pricing_snapshot` + `total_price` → invoices (CENTS, `toCents()` in `invoiceShared.js` is the boundary) → Stripe intents → signature-verified webhook credits `amount_paid` additively → event completion triggers `payrollAccrual` (CENTS, fee-netted gratuity split across bartenders via `shift_requests.position`) → payouts → read-side Stripe payout mirror. Refunds, clawbacks, and late-tip roll-forwards are the reverse paths. There is **no direct proposals→payroll FK**: revenue connects to labor cost only through `shifts` (`payout_events.shift_id`) and the `stripe_payout_lines` mirror.

---

## 1. Server core (boot + cross-cutting primitives)

**Purpose.** Express composition root: Sentry init, fail-fast env guards, helmet CSP, CORS allowlist, raw-body webhook pre-mounts, ~40 route mounts in load-bearing order, the global AppError-aware error handler, pool + idempotent `initDb()`, and registration of all 13 schedulers. Owns the primitives everything imports: `auth`/`clientAuth`/`adminOnly`/`requireAdminOrManager`, `asyncHandler`, `AppError` hierarchy, 17 rate limiters.

**Key modules.** `server/index.js` (525L, scheduler block inlined at 311-518), `server/db/index.js` (223L: pool max 50, SERVER-17 error handler, `splitStatements` SQL parser), `server/middleware/auth.js` (119L), `server/middleware/rateLimiters.js` (228L), `server/utils/errors.js`, `server/utils/schedulerHealth.js` (wrapScheduler + 15-min staleness monitor).

**Load-bearing seams.**
- Route-mount ORDER matters: `emailChange` before `me` before `staffPortal`; `thumbtackAgent` before `admin`; `shifts` before `staffShiftActions`; `drink-plans/regenerate` before `drinkPlans`; raw-body webhook mounts before `express.json`; blog 10mb JSON override before the 1mb default.
- `auth()` hits the DB on every request (deliberate, for `token_version` revocation) and fires a presence touch side effect.
- Scheduler gating: exact `NODE_ENV === 'production'` string match, plus `RUN_*` per-scheduler flags.

**Health.** Strong: fail-fast JWT_SECRET guard, pool error handler (closes the SERVER-17 crash class), aggressive Sentry PII scrubbing, user-keyed rate limiters, staggered scheduler boots. Watch: no process-level `unhandledRejection` net (see register OPS-1), static `/api/health` never touches the DB (OPS-3), no SIGTERM drain (OPS-2).

## 2. Money spine (pricing → payments → payroll)

**Purpose.** End-to-end money pipeline described above. This subsystem was audited 2026-07-11 and judged HARDENED; the standing decision is to not rewrite it.

**Key modules.** `pricingEngine.js` (540L, pure, hosted 1:100 rule), `stripeWebhookHandlers/paymentIntentSucceeded.js` (482L, the settlement heart: idempotent ON CONFLICT gate, additive credits), `checkoutSessionCompleted.js` (470L, tips + payment-link settlement), `payrollAccrual.js` (440L), `refundHelpers.js` (320L, row-locked, idempotent on `stripe_refund_id`), `invoiceLifecycle.js` / `invoiceExtras.js` / `invoiceLineItems.js` / `invoiceLinking.js`, `stripePayoutSync.js`, `payrollClawback.js` / `payrollLateTip.js` / `payrollTips.js` / `payrollMath.js`, `routes/stripe.js` (621L composition router), `stripeCreateIntent.js`, `routes/admin/payroll.js`, `routes/publicTip.js`.

**Data owned.** `proposals` money columns (DOLLARS) · `proposal_payments`/`proposal_refunds`/`invoices`/`invoice_line_items`/`invoice_payments`/`stripe_sessions` (CENTS) · `tips`/`tips_orphaned` · `pay_periods`/`payouts`/`payout_events` · `stripe_payouts`/`stripe_payout_lines`.

**Designed-in protections worth knowing before touching anything.** Idempotency at every money-in path (partial unique indexes, ON CONFLICT); additive derived-status credits (never `amount_paid = total_price`); live-mode webhook gate keyed on WHICH secret verified the event; `linkPaymentToInvoice` caps credit and warns rather than throws; gratuity fee-netting centralized in `payrollMath.proRataFeeCents`; deliberate client-reuse in deferral paths to avoid pool exhaustion.

**Known sharp edges** (tracked in register): `CONTRACT_LABELS` duplicated 3x by hand; `extractGratuityCents` matches snapshot lines by label string (a diverging label silently reads gratuity as 0); `gratuityBasisFromSnapshot` lossy inverse for legacy snapshots; best-effort fee capture leaves `fee_cents` NULL under a Stripe outage; overpay/mismatch branches Sentry-flag rather than reconcile.

## 3. Proposals (quoting + sign-and-pay pipeline)

**Purpose.** Turns package + event details into a priced, token-linked proposal a client can view/sign/pay; status machine `draft → sent → viewed → accepted → deposit_paid → balance_paid → confirmed → completed | archived(+reason)`. Three creation sources: admin cockpit, public quote wizard, Thumbtack auto-draft. Owns compare groups, change-request decisions, financial/funnel aggregates.

**Key modules.** `routes/proposals/` composition (mount-order contract in `index.js`, `getOne.js` greedy route mounted LAST): `crud.js` (879L; PATCH `/:id` is a ~535-line handler, the hottest money file, 52 commits since May), `actions.js` (record-payment, archive), `lifecycle.js` (STATUS_TRANSITIONS + hooks), `public.js` (unauth quote-wizard endpoints; carries its own raw proposals INSERT), `publicToken.js`, `metadata.js`, `compareGroup.js`/`groups.js`, `list.js`. Client: `ProposalCreate.js` (1330L, RED/frozen), `ProposalDetail.js` (820L) + `ProposalDetailEditForm.js` (846L), `proposalView/` public sign-and-pay, `compare/ProposalCompare.js`.

**JSONB blobs.** `pricing_snapshot` (written by crud POST/PATCH + public submit, read by 6+ downstream files, **no version/validator**, the highest-value carry-forward from the old debt doc), `adjustments` (unvalidated), `class_options` (normalized inline in both crud paths).

**Seams.** Stripe webhooks are the ONLY writers of `deposit_paid`/`balance_paid` from real card money. `eventCreation.createEventShifts`/`syncShiftsFromProposal` keep shifts in lockstep (sync only fires when a proposal has exactly 1 shift). Invoices refresh post-commit in a separate tx. `metricsQueries` predicates shared by list drill-outs and dashboard so funnel numbers can't drift. Client portal creates change requests; proposals decides them.

## 4. Events & staffing

**Purpose.** Booked proposal → staffed event: auto-created shifts with role rosters, ranked staff requests, approve/waitlist, drop/cover/emergency-drop marketplace, BEO, presence strip. **The money seam:** `shift_requests.position` is resolved once at approval; payroll splits gratuity/card tips by `LOWER(position)='bartender'`.

**Key modules.** `routes/shifts.js` (707L) + `shifts.approval.js` (566L, the extracted approval money seam) + `staffShiftActions.js` (903L: drop 214-339, request-cover 339-489, claim-cover 489-701, emergency-drop 701-903) + `staffPortal.js` (918L), `utils/eventCreation.js` (roster derivation + idempotent shift creation + drink-plan auto-create), `autoAssign.js` (seniority + haversine + equipment), `coverBroadcast.js`, `staffShiftHandlers.js` (723L scheduled comms), `lastMinuteStaffingConfirmation.js`, `beo.js`, `presenceStore.js` + `admin/presence.js`, `coverApprovalCascade.js`. Client: `staff/ShiftsPage.js` (798L), `ShiftDetail.js` (804L), `HomePage.js`, `PayPage.js`.

**Health.** Strong: position never defaulted; presence writes FOR-UPDATE + one-open-interval unique index; emergency-drop transactional with ownership + 72h gates; BEO 404-before-403; idempotent shift/message creation. Sharp edges: the `'bartender'` magic string is duplicated across accrual/clawback (and one inline compare skips the shared `isBartender` trim, register DUP-S5); `parsePositionsNeeded` reimplemented locally in `coverBroadcast`; `positions_needed`/`equipment_required` are JSON-in-TEXT; multi-shift proposals silently skip event-identity sync.

## 5. Drink plans / bar program (Potions)

**Purpose.** Booked client designs their menu (`/plan/:token`, wizard) or admin captures via consult; auto-generated shopping list gated behind admin approval; Potions catalog (cocktails, mocktails, `par_items` single stock catalog). **Event-side plan is canonical; proposal-side is preview. `/plan/:token` resolves `drink_plans.token`, not the proposal token.**

**Key modules.** `routes/drinkPlans.js` (779L) + `drinkPlans/submit.js` (587L, transactional financial submit: addons + total + invoice move together) + `drinkPlans/regenerate.js` (mounted BEFORE flat router), `drinkPlanConsult.js`, `potions.js` (par CRUD + shared recipe validators), `cocktails.js`/`mocktails.js`, `utils/shoppingList.js` (593L pure generator) + `shoppingListGen.js` (catalog-miss degrades to legacy constants, Sentry-flagged) + `potionCatalog.js` (alias resolution, never fuzzy), `drinkPlanNudge.js` (T-21). Client: `PotionPlanningLab.js` (998L), `steps/ConfirmationStep.js` (915L, can charge Stripe, so pre-booking plans lock), `CocktailMenuDashboard.js` (931L), `PotionsPage.js` tabs.

**Money seam.** `submit.js` runs `calculateProposal` + `refreshUnlockedInvoices` + extras invoice in one tx (dollars→cents boundary). Note: it does NOT reconcile proposal payment status after raising `total_price` (known audit medium, register M-5).

**Watch.** Legacy `DrinkPlansDashboard.js`/`DrinkPlanDetail.js` still coexist with PotionsPage (confirm-dead candidate); `computeUsedByMap` scans all recipes per par GET/DELETE (fine at scale today).

## 6. Comms (email / SMS / push / Telegram + scheduled queue)

**Purpose.** Renders and sends every outbound touch; owns the `scheduled_messages` queue (balance ladder, pre-event ladder, drip, retention); inbound SMS (staff CONFIRM/CANT with by-shift disambiguation, STOP/START, client replies, Thumbtack relay suppression); VA-calling Telegram trigger. Master gate: `notificationsEnabled()` (SEND_NOTIFICATIONS / NODE_ENV).

**Key modules.** `scheduledMessageDispatcher.js` (947L: registry + atomic claim pipeline + dead-letter recovery + 3 balance handlers in one file), `emailTemplates.js` (980L, near hard cap) + `lifecycleEmailTemplates.js` + `marketingEmailTemplates.js` + `smsTemplates.js`, `smsInbound.js` (695L), `marketingHandlers.js` (drip/retention), `preEventScheduling.js` (DST-correct 10:00 event-local) + `preEventHandlers.js`, `balanceScheduler.js` (autopay claim + auto-complete), `eventEveSms.js` (bespoke T-24h), `emailSequenceScheduler.js` (abandoned-quote drip), `routes/emailMarketing.js` (877L console) + `emailMarketingWebhook.js` (svix, fail-closed prod), `routes/messages.js` (staff blast), `routes/sms.js` + `routes/telegram.js`, channel plumbing (`email.js`, `sms.js`, `pushDispatch.js`/`pushSender.js`, `notificationChannelResolver.js`, `channelFallback.js`, `adminNotifications.js`, `messageLog.js`, `messageScheduling.js`).

**Discipline worth preserving.** Exactly-once via atomic claims + partial-unique pending index + stranded-claim reaper; Resend 429 → `QuotaExceededError` → defer-and-retry; handler metadata (offset/anchor) is the single source both initial scheduling and the reschedule cascade read; fail-closed external verification everywhere.

**Watch.** Post-commit comms tails that open their own pooled connection are the documented deadlock class (CLAUDE.md pool rule); `notifyAdminCategory` silently drops on quota; `lastFour()` always returns null (self-documented TODO); no in-app SMS spend cap outside VA-calling.

## 7. Integrations (webhooks in, API clients out)

**Purpose.** Thumbtack (leads/messages/reviews webhooks + off-box Playwright email harvester + auto-draft proposals), Cal.com (HMAC webhook, replay-deduped via `webhook_events`), Telegram→Twilio-Voice VA-call bridge (layered toll-fraud guards, DB-backed spend caps, CallSid-keyed bridging), Google Places proxy (fails soft), R2 storage, Stripe client factory (`stripeClient.js`, fails closed), Sentry.

**Auth models per webhook.** Thumbtack: shared secret (Basic or header, timing-safe). Agent routes: `x-thumbtack-agent-secret`, fails closed ALL envs. Cal.com: HMAC-SHA256 raw body, 503 if secret unset. Telegram: secret path + header, both timing-safe. Twilio voice/SMS: signature validation (prod 403, dev warn-allow).

**Watch.** `googlePlaces`/`telegram` fetches have no timeout; R2 ContentType derived from filename not validated bytes; venue search is a public paid-API proxy guarded only by rate limiters (intentional); harvester session dies silently until an RDP re-login.

## 8. Auth & identity

**Purpose.** Two disjoint identity systems sharing `JWT_SECRET`: staff/admin/manager (users, bcrypt, 7-day JWT, `onboarding_status` lifecycle, in-memory login lockout) and clients (email OTP, separate `clients` table + `db_client_token`). Owns registration/pre-hire promotion, password reset + email change (SHA-256 hashed single-use tokens, `token_version` bumps), agreement signing, encrypted bank PII (AES-256-GCM, fails closed in prod), `requireUuidToken`.

**Cross-cutting seams.** `token_version` is THE session-revocation lever (any new invalidation path must bump it); `req.user` shape is a contract; `pre_hired` couples auth.js/application.js/admin-users.js; mount order keeps `/confirm-email-change` unauthenticated; `calendar_token` UUID alone authorizes the iCal feed.

**Watch** (register): staff auth() status-gate + token-version branches have zero test coverage (T-1); onboarding-status lists drift across surfaces (`suspended` missing from admin settable list); login timing oracle (bcrypt only runs for known emails); unsubscribe JWT falls back to `JWT_SECRET`.

## 9. Client app — admin surfaces

**Purpose.** The Admin OS shell (Sidebar/Header/⌘K palette) behind `ProtectedRoute adminOnly`, host-dispatched by `getSiteContext()`. Money Board (`overview/OverviewPage.js`), proposals cockpit, events, clients, staffing + payroll, potions, messaging/marketing, settings.

**Primitives to reuse** (uniform across newer pages): `useUrlListState`, `useDrawerParam`, `EntityLink`, `adminos/format.js` (`fmt$fromCents` vs `fmt$2dp` money discipline), `StatusChip`, CommandPalette with pending-Enter latch + stale-response guards.

**Seams.** `utils/api.js` axios: attaches JWT, 401 → `session-expired` event; `userRoutes.getHomePath` is deliberately kept in sync with `server/middleware/auth.js` + `RequirePortal` (drift = redirect loops, Sentry CLIENT-5/6); `AdminLayout` polls `/admin/badge-counts` 60s; skin/density prefs write `<html>` data-attrs that `index.css` scopes on.

**Watch.** `ProposalCreate.js` (1330L RED) and `CocktailMenuDashboard.js` (931L) ratchet-frozen; legacy `.badge` CSS coexists with `StatusChip` chips; status label maps hand-copied per page and already diverging (register DUP-C2).

## 10. Client app — public / client / staff surfaces

**Purpose.** Marketing site + quote/class funnels (open), token-by-possession documents (proposal/compare/invoice/plan/shopping-list/tip/feedback/email-verify: URL UUID is the authorization), client portal (OTP JWT realm), staff portal (JWT + `RequirePortal` on onboarding status), hiring flow, Lab Rat QA.

**Three auth realms coexist client-side** and must not be conflated: `token` (staff/admin), `db_client_token` (client portal), and no-session UUID tokens. `api.js` exempts `/auth/` + `/client-auth/` from the session-expired event.

**Watch.** Public token pages inconsistently use raw axios vs the shared instance (register PAT-2); portal passes Bearer manually per call; `/qa/seed` staff mint is the tracked unauth endpoint (M-3); `ClientShoppingList` hand-builds its own `/api` base URL.

## 11. Database

**Purpose.** Single idempotent `schema.sql` replayed at boot (guarded DO-blocks, IF NOT EXISTS; unexpected failures collected → Sentry, boot continues); single pool. Domains: identity/onboarding (~13 tables), proposals/money (~16), events/shifts/payroll (~11), drink plans/bar program (~6), comms (~12), integrations (~7), ops/cc-import (~12).

**Conventions that protect money.** Dollars-vs-cents boundary documented at schema.sql:542-551; FK semantics chosen per relationship (RESTRICT on paid invoices/refunds/payout_events, CASCADE only on child line items, SET NULL for client links); partial unique idempotency indexes on payment intents/refunds/tips; CHECK constraints (gratuity no-jar floor, autopay claim enum).

**Watch** (register): `proposals.status` CHECK defined three times in-file, only the last is canonical; `message_log.client_id` is the one client FK without SET NULL, contradicting the invariant `clientMerge.js` documents (M-7); JSON-in-TEXT columns beyond the tracked pair; one bare TIMESTAMP column (`transport_acknowledged_at`); `legacy_cc_payouts` write-only alongside `staff_payment_history`; swallowed-exception DO-blocks on a few constraint migrations.

## 12. Tests & tooling

**Purpose.** Local-only quality gates: 203 server node:test files against the SHARED dev Neon DB (serial-run constraint from pay-period fixtures), file-size ratchet (soft 700 / hard 1000, growth-blocking), sensitive-path matcher, os-main guard, lane/worktree helpers + flock-serialized squash merge, docs-drift warn, ESLint (server enforced at pre-commit; client only via the pre-push Vercel-equivalent build).

**The headline gap** (register M-CI, confirmed medium): there is NO automated test gate anywhere. `npm test` is invoked by nothing; a money-path regression that breaks 50 assertions deploys clean. The blocker is real (shared dev DB), so the fix is a scoping problem: ephemeral Neon branch per run + a smoke gate.

**Also:** client tests (19 files) never run automatically; `scripts/` own tests excluded from the `npm test` glob; root eslint config hard-imports from `client/node_modules` (two ESLint majors in one repo).

---

## Cross-cutting inventory (quick reference)

**All 13 schedulers** (web process, staggered 30s-270s boots, each `RUN_*`-gateable): autopay (hourly), autocomplete (hourly, triggers payroll accrual + marketing), auto_assign (hourly), email_sequence (15m), quote_draft_cleanup (daily), labrat_purge (hourly), webhook_events_prune (hourly), pending_email_cleanup (daily), stripe_payout_sweep (daily), va_calling_prune (hourly) + va_calling_webhook_health, presence sweep (15m), message_dispatcher (5m). Plus the stale-scheduler monitor.

**Token types:** staff/admin JWT (7d) · client JWT (7d) · UUID public tokens (proposal, drink plan, invoice, tip page, shopping list, compare group, cover swap) · SHA-256-hashed single-use tokens (password reset 1h, email change 24h) · unsubscribe JWT (365d) · calendar_token UUID (no expiry).

**Deliberate mirrors kept in sync by hand** (grep both sides before editing either): `eventTypes.js` (client ESM / server CJS) · `gratuityLabels.js` (client + server) · shopping-list constants + `SYRUP_NAME_LOOKUP` (server ↔ client syrups.js) · `userRoutes.getHomePath` ↔ `server/middleware/auth.js` gates.

**Hottest files by commits since 2026-05-01** (churn × size = review risk): `proposals/crud.js` (52), `shifts.js` (30), `scheduledMessageDispatcher.js` (24), `ProposalCreate.js` (19), `admin/users.js` (19).
