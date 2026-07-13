# Tech-Debt Register — 2026-07-13 audit

**HEAD:** `46e969b` · **Method:** 11 debt hunters across distinct dimensions + 3 reconcilers re-verifying every item in the prior debt docs against current code; every medium/high finding then faced adversarial verification (money/auth findings got two independent skeptics). 49 raw findings → 48 after dedupe → 18 verified medium/high (0 refuted) + 30 evidence-based lows. Reconciliation covered `docs/tech-debt.md` (30 items), `docs/fix-list-remaining-2026-07-02.md` + `docs/open-threads.md` (30 items), and `.claude/seam-sweep-2026-07-02.md` + the 2026-07-11 payment/auth audit (7 items).

**Relationship to `docs/tech-debt.md`:** this register absorbs it. Every item there was re-verified below (§4); several are now FIXED or OBSOLETE. The actionable subset of this register is sequenced in `migration-plan.yaml`.

**Standing constraints honored throughout:** the payment flow was audited 2026-07-11 and judged hardened, with an explicit recommendation AGAINST rewriting it. Fixes below that touch money paths carry a `fix-risk` note from verification; several suggested fixes were explicitly REJECTED on that basis (§5).

**Decisions resolved 2026-07-13 (Dallas):** all five open calls answered; see `migration-plan.yaml` `decisions_resolved` for the one-liners and the affected items for detail. Headlines: M-1 goes archive-does-the-reaping; mergeClients gets DELETED; CI lands pre-push-smoke-first; pricing_snapshot validator is tolerate-and-tag; crud tail extraction is opportunistic-only. Lightning round: `favorite_color` KEEP / `is_default` DROP; notification bell REMOVE; unsubscribePush WIRE; manager iCal feed is intended behavior (closed); ginger ale out of the consult copy; `migrate-to-gcs.js` deleted (archive/ dir convention stays). Node fact from Sentry runtime context: prod runs **v26.5.0** (non-LTS Current) while dev tests on 24.16 and docs said 18; pin 26 as-is first, LTS alignment deferred.

---

## 1. Verified findings — act on these (sequenced in migration-plan.yaml)

### Correctness / resilience

**PAT-1 · Thumbtack `/leads` webhook holds a pooled client while the post-commit tail opens a second connection** (low after verification, but it is the codebase's #1 documented bug class) — `server/routes/thumbtack.js:366` holds `dbClient` until the `finally` at :454, but the post-commit tail (`runPostCommitSteps` at :441, heal path :387) calls `createDraftProposalFromLead`, which takes its OWN `pool.connect()` through a full transaction (`thumbtackProposalDraft.js:166`). Two connections per webhook; Thumbtack retries can burst. The sibling capture-lead handler got exactly this fix on 2026-07-13; this one was missed. **Fix caution (from verification):** a bare early `release()` would double-release in the `finally` and pg throws; use a released-flag guard mirroring the capture-lead fix. Effort S.

**OPS-1 · Floating `pool.query()` in geocode `.then()` callbacks + no process-level rejection net = one DB blip crashes web + all 13 schedulers** — `shifts.js:400,509`, `contractor.js:213`, `admin/users.js:372`: the inner `pool.query` is not returned into the chain and has no own `.catch`; grep confirms NO `process.on('unhandledRejection'|'uncaughtException')` anywhere. Node's default kills the process. Fix: `return` the inner promises + add a Sentry-capturing process-level net in `index.js`. Effort S.

**OPS-3 · Health check is a static 200; render.yaml declares no healthCheckPath** — `index.js:268` never touches the DB; Render falls back to a TCP probe, so a post-boot Neon outage keeps routing traffic to a dead backend. Fix: `SELECT 1` with short timeout → 503, plus `healthCheckPath` in render.yaml. Effort S.

**OPS-2 · No graceful shutdown** — `start()` never captures the server or registers SIGTERM; every deploy severs in-flight requests (webhook handlers mid-transaction included). Damage is bounded (rollback + provider retries + stranded-claim reaper), but a drain window is cheap: `server.close()` → `pool.end()` → hard timeout. Effort S.

**OPS-4 · Boot env validation is fail-fast only for JWT_SECRET** — a typo'd `RESEND_API_KEY`/`R2_*`/`TWILIO_*` boots green and first fails mid customer flow. Money-critical creds already fail closed (stripeClient, encryption). Fix: one required-env assertion block for transactional-provider keys. Effort S.

**SCH-1 · `message_log.client_id` is the only client FK without ON DELETE SET NULL** — `schema.sql:3312` (NOT NULL, NO ACTION) contradicts the "all client FKs are SET NULL" invariant `clientMerge.js:8` documents; `mergeClients`/labrat cleanup survive only by accident of ordering. Fix: guarded DROP/ADD constraint + drop NOT NULL. Effort S.

### Safety net (the two verified MEDIUMs)

**M-CI · No automated test gate anywhere — 203 server tests never run before a prod deploy** (medium, CONFIRMED) — no CI config exists; `npm test` (package.json:14) is invoked by nothing; pre-commit runs docs-drift/file-size/lint/git-guard only; pre-push only builds the client. Push = deploy. The reason is real (tests share the live dev Neon DB and FK-collide in parallel), so this is a scoping problem: ephemeral Neon branch (or throwaway schema) per run, then a gate — even a smoke subset over pricingEngine/webhook/payroll closes the highest-value gap. Verification: purely additive, zero risk to money paths. Effort M-L (design session for the isolation approach).

**DUP-S1 · The "booked/paid" status set is independently defined 13+ times under 5 different names** (medium, CONFIRMED) — `['deposit_paid','balance_paid','confirmed','completed']` exists as `BOOKED` (twice, in two different modules!), `CONVERTED_STATUSES`, `POST_SIGNPAY`, `POST_BOOKING_PROPOSAL_STATUSES`, plus raw SQL literals in metricsQueries/globalSearch/list/metadata/clients/paymentIntentSucceeded. This set IS the definition of "counts as booked": it drives revenue/LTV, drink-plan access, change-request eligibility, reschedule guards. **Fix caution:** centralize the JS Sets first (mechanical); the SQL literals are NOT all the bare set (several negate it plus `'archived'`), so migrate those opportunistically and value-identically, or not at all. Effort M.

### Test coverage on guarded paths (all additive, zero production-code risk)

- **TST-1** · staff `auth()` status gate + token-version revocation: zero tests. The suspended-manager bypass fix and the admin-exemption (owner lockout guard) would regress silently. ~4 middleware cases. Effort S.
- **TST-4** · `routes/sms.js` Twilio signature gate + dev allow-through: no route-level test (contrast stripeWebhook's 8). Effort S.
- **TST-5** · `formatMoney.js` + `buildTipDeepLink.js`: pure, branch-heavy, customer-facing money/tip-link helpers, untested. Under an hour. Effort S.
- **TST-2** · Payroll test isolation: 12 suites mutate the single live `pay_periods` row (`payrollAccrual.test.js:32` mutates the CURRENT_DATE row), forcing serial runs. Fix the isolation (unique far-past dates per suite, like payrollLateTip already does); **do NOT re-enable `--test-concurrency`** (verifiers: suites also collide on users/proposals; serial stays the convention). Effort M.
- **TST-3** · crud.test.js "Case 8" is NOT a product bug: it's adminWriteLimiter bucket exhaustion on the shared `primaryToken`. Fix = `makeFreshAdmin()` like Case 10. Stops suite noise masking real regressions. Effort S.
- **TST-6** · rateLimiters (login brute-force thresholds) untested · **TST-7** · `preEventHandlers.js` formatters untested (last `*Handlers.js` without a test sibling). Both S.

### Endpoint hygiene (small, sibling-consistent)

- **SEC-1** · `proposals/list.js:133`: `limit`/`page` reach LIMIT/OFFSET unclamped (`?limit=abc` → 500; the ONLY list endpoint without the `Math.min` clamp its siblings use). S.
- **PERF-2** · `emailMarketing.js:37`: leads list `limit` uncapped + per-page COUNT with leading-wildcard ILIKE. Clamp now; trigram index only if search slows. S.
- **SEC-2** · public cocktails/mocktails `/categories` missing `publicReadLimiter` (siblings have it). S.
- **PT-1** (from fix-list recon) · `publicToken.js:59` GET `/t/:token` missing `requireUuidToken` while its siblings have it (22P02→500 class). S.

### Consolidation (drift-killers, mechanical)

- **DUP-S5** · `payrollAccrual.js:177` filters the tip pool with an inline `.toLowerCase()==='bartender'` that skips the shared `isBartender()` (which also trims). A whitespace-padded position would be counted by the helper but excluded from the tip pool. One-line import; it IS the money seam, so full fleet anyway. S.
- **DUP-C2** · Proposal + drink-plan status label/kind maps hand-copied per admin page and ALREADY diverging (`completed` renders green on detail, gray on dashboard; `exploration_saved` missing from one map). Extract shared maps (pattern: `gratuityLabels.js`). S.
- **FIX-1** (fix-list, grew since written) · `safeAddonQty` now duplicated in FOUR files (crud, public, metadata, changeRequests). Lift to one helper. S.
- **MS-1** (map observation) · `CONTRACT_LABELS ['Deposit','Balance','Full Payment']` hand-synced across payrollAccrual/refundHelpers/invoiceLifecycle; a new contract label silently breaks gratuity extraction. Shared constant module. S.
- **DUP-S3** · `proposalUrl(token)` defined identically 3x + inlined ~10x (only stripe.js encodes the token). One helper in a urls module. S.
- **DUP-C1 (safe slice only)** · the change-request `fmt` dollar formatter copied byte-identical 3x (admin + public portal). Consolidate JUST these three; see §5 for the rejected larger version. S.
- **DUP-C3/C4** · ~15 hand-rolled client date formatters with three incompatible date-only timezone strategies (one is the off-by-one-day trap in Chicago); duplicated 12h-time + end-time math between proposal and event surfaces. Shared `fmtDateOnly`/`fmtDateTime` + one end-time helper. M.
- **FIX-2** (fix-list) · client/lead source list defined 5 ways (2 client utils + server + 4 schema CHECKs). M.
- **MS-2** (map observation) · `coverBroadcast.js:46` local `parsePositionsNeeded` copy vs shared `utils/positionsNeeded.js`. S.
- **DUP-S4** · `shoppingList.js` header instructs syncing against client files that no longer exist (server is now authoritative via the API). Fix the header, keep the one still-live syrups.js note. S.

### Structural (file-size ratchet relief, where hot)

- **CPX-4** · `ProposalCreate.js` (1330L, the only RED file, 19 commits since May) already contains four self-contained section components in-file (ClientSection :436, EventSection :557, PackageSection :734, AddonSection :864). Extract per the documented split pattern; client form code, pricing is server-side, low risk, unfreezes the ratchet. M.
- **FIX-3** (fix-list) · near-hard-cap cluster: `emailTemplates.js` (980) and `scheduledMessageDispatcher.js` (947) will block their next feature add. Dispatcher split is clean by concern (engine vs concrete handlers vs dead-letter recovery, CPX-3). M each.
- **CPX-7** · `admin/users.js` (886L) bundles user CRUD + onboarding state machine + a whole contractor tip-page/Stripe sub-API + tips review. Split the tip-page/Stripe endpoints (605-810) into a sibling route file. M.
- **CPX-6** · `shifts.js` (707L, 30 commits) PUT + cancel-or-unassign handlers → `staffShiftHandlers.js`, continuing the established extraction pattern. M.
- **CPX-1 (tail only)** · `proposals/crud.js` PATCH: extract ONLY the five post-commit best-effort blocks (:721-835) into one helper. Verification flagged the closure-state subtleties (hoisted flags, fresh re-reads), so even this is design-session + full fleet; the in-transaction body stays untouched. See §5 for the rejected larger refactor. M.
- **CPX-5** · `staffShiftActions.js` (903L): shared status-transition helper for the four ~200-line cover/drop handlers. Lower priority than the above. M.

### Schema hygiene

- **SCH-3** · `shift_requests.transport_acknowledged_at` is the schema's ONLY bare TIMESTAMP (~200 others are TIMESTAMPTZ); currently read only as a boolean so conversion is cheap now, expensive after someone compares it. S.
- **SCH-4** · `payout_events.shift_id` FK unindexed; joined by `staffShiftActions.js:98` and checked by ON DELETE RESTRICT. One CREATE INDEX. S.
- **SCH-5** · `proposal_payments.amount` / `invoices.amount_due/amount_paid` lack the non-negative CHECKs the newer money tables have (`tips`, `staff_payment_history`). Free defense-in-depth; use NOT VALID + VALIDATE. (`invoice_payments.amount` intentionally signed.) S.
- **SCH-2** · JSON-in-TEXT beyond the tracked pair: `shift_requests.requested_positions`, `applications.positions_interested`, `experience_types` (the first feeds the payroll position seam). Fold into the existing TEXT→JSONB migration item so a future pass doesn't miss them. (Rides with the deferred migration.)

### Dependencies / build

- **DEP-1** · Node runtime unpinned (`>=18.0.0`), documented target (18) is EOL, dev box runs 24. **Fix caution:** pin the major Render currently resolves first (config-only); a deliberate jump to 22 LTS is its own verified step, since pg/bcryptjs/sharp are native. S then M.
- **DEP-4** · `eslint.config.mjs:2` hard-imports `client/node_modules/eslint-plugin-react-hooks` (ESLint 10 root vs ESLint 8 inside CRA); a client dep reshuffle silently breaks the only enforced server lint gate. Make it a root devDep. S.
- **DEP-3** · CRA/Vite migration scoping (input for the already-deferred project): blocker inventory is unusually clean — no jsconfig, exactly 7 `REACT_APP_` vars, one SW in public/, CRA `proxy` field, jest→vitest. The cost centers are env-prefix rename + test-runner swap + Sentry sourcemaps, not app code. L (own project, unchanged decision).

### Performance / ops (small)

- **PERF-1** · `emailSequenceScheduler.js:82-118` textbook N+1 (2 step queries per enrollment per 15-min tick); batch per campaign. S.
- **PERF-3** · `index.css` = 515KB/18,175 lines, render-blocking on every surface incl. mobile marketing; JS is aggressively code-split so CSS is now the largest single asset, and nothing prunes orphaned rules from past reskins. First step is measurement only (PurgeCSS report / DevTools coverage), then decide. M.
- **OPS-5** · Scheduler pile-up re-checked: 13 jobs + monitor, but every money/comms-critical job verified individually hardened (atomic claims + idempotency keys), so NO new double-run hazard; worker split stays deferred. The real coupling cost is crash blast-radius, which OPS-1 addresses for far less than a worker service. No action.

### Dead code

- **DC-1** · `blog-import/test.webp` (1.7MB) + `writetest.txt` are tracked write-probe leftovers, referenced by nothing. `git rm`. S.
- **DC-2** · `server/scripts/archive/` holds a GCS migrator (storage path never shipped) + superseded blog importers. DECIDED 2026-07-13: archive-dir convention stays; delete `migrate-to-gcs.js` only (rides qw-dead-files). S.
- **FIX-4** (fix-list) · dead `GET /:id/legacy-cc-payments` endpoint (clientless after CC v1 demolition; test still exercises it). Remove in a later proposals-touching lane. S.
- **FIX-5** (fix-list) · header notification bell renders with no onClick and a hardcoded 0 count. Wire it or remove it. S.
- **FIX-6** (fix-list) · `unsubscribePush()` exported, no UI calls it. Wire a remove-device action or delete. S.

---

## 2. Known open items re-verified and carried (from prior docs, still real at HEAD)

| ID | Item | Status at HEAD | Sev/Eff |
|---|---|---|---|
| **M-1** | **Refund on a paid proposal leaves the booking live**: `refundHelpers.js` never touches shifts/scheduled_messages; `issueRefund` reconciles status back to `accepted`, so reminders keep firing and the shift stays staffed (prod-confirmed, proposal 500) | still-open | **high**/M |
| M-2 | Payment-link **'full' settlement branch skips last-minute staffing** (`checkoutSessionCompleted.js:193-206` never sets `last_minute_hold`/`notifyLastMinuteBooking`; only paymentIntentSucceeded does) | still-open | medium/S |
| M-3 | **Unauth `/api/qa/seed` mints role='staff' accounts** + returns plaintext password; only defense is 2/IP/hr + 20/hr global limits (2026-07-11 audit medium) | still-open | medium/S |
| M-4 | **Autopay double-charge after >24h webhook outage**: 24h stuck-claim reclaim + Stripe idempotency keys expiring at 24h; surgical fix = query Stripe for a succeeded PI before charging a reclaimed row (2026-07-11 audit medium) | still-open | medium/M |
| M-5 | **Drink-plan submit raises total_price but never reconciles proposal payment status** (`submit.js:264`); low reachability (submit-once gate) but violates the cross-cutting rule (2026-07-11 audit medium) | still-open | low/M |
| M-6 | **`mergeClients` ships unwired** (`clientMerge.js:58` exported, zero consumers; no admin gate/audit/confirm exists because no route exists). First consumer MUST be admin-gated + activity-logged + confirmation-guarded | still-open | medium/S |
| M-7 | = SCH-1 above (message_log FK breaks the invariant clientMerge relies on) | still-open | low/S |
| M-8 | **The 2026-07-11 payment/auth audit was never persisted in-repo**; its 3 low/info findings are unrecoverable (memory only). Transcribe what is known into `.claude/` like the seam-sweep doc | still-open | low/S |
| F-AR | `archive_reason` never written by the `/archive` endpoint (only group-commit writes one); wants a reason picker | still-open | medium/S |
| F-PS | **`pricing_snapshot` has no version stamp or validator** — written by pricingEngine, read unversioned by 6+ files (eventCreation, payrollAccrual, invoiceExtras, changeRequests, preEventHandlers, setupTime); a key rename silently breaks all of them at runtime. Highest-value carry from the old doc | still-open | medium/M (design) |
| F-ADJ | `proposals.adjustments` still unvalidated before INSERT (class_options half of the old item is now closed inline in both crud paths) | partially-fixed | low/M |
| F-DPE | Drink-plan extras pricing: `drinkPlanExtras.js` now unifies 2 of 3 consumers; `invoiceExtras.js` still computes inline via `calculateSyrupCost` | partially-fixed | low/M |
| F-PCW | Proposal-creation consolidation: shared `insertProposalRecord` exists but `public.js:366` still hand-rolls its own 22-column INSERT | partially-fixed | low/L |
| F-SYR | Syrup picker generators don't cross-check self-provided vs comped/paid syrups (suspected bug, needs fresh re-diagnosis) | still-open | low/M |
| F-DL | Drink-plan edit lock still coupled to submit status; admin reopen control unbuilt (Option A, deliberately parked) | parked | medium/M |
| F-ICAL | Manager iCal feed scope (audit F3): managers get the full admin feed — CONFIRMED INTENDED 2026-07-13, item closed | closed | — |
| F-ING | INGREDIENT_MAP substring-match fragility mitigated (length-sorted aliases) not eliminated | still-open | low/S |
| F-GA | ConsultationForm copy still says "ginger ale" (Dallas call) | still-open | low/S |
| D-TXT | shifts TEXT→JSONB migration (now + SCH-2's three columns) | still-open | low/L (own spec) |
| D-WRK | Schedulers→worker split (re-checked by OPS-5: nothing new raises urgency) | still-open, deferred | low/L |
| D-PLL | PotionPlanningLab state-controller split · D-APP App.js route-manifest dedup · D-QWPC QuoteWizard↔ProposalCreate policy dedup · D-CMD CocktailMenuDashboard redesign (Dallas-driven) | still-open, deferred | low/L each |
| D-PAG | LIMIT-500 pagination endpoints (unchanged; conversation-history DID gain paging) · campaign-list COUNT FILTER refactor (index landed, query shape didn't) · geocode/blog import loops · applications CASE-blocks-index · metricsQueries include_cc composite index · DEFAULT-vs-supplied duplication · failed-login audit table | still-open, all low, trigger-based | low |
| D-NOI | `users.notifications_opt_in` DROP COLUMN + 4 test fixtures — SHIPPED in the P0 schema-hygiene lane (aebd556, 2026-07-13): column dropped from base CREATE + guarded DROP, fixtures cleaned | fixed | — |
| D-DEAD | Dead columns DECIDED 2026-07-13: `service_addons.is_default` DROPS (rides qw-schema-hygiene); `applications.favorite_color` KEEPS (displayed humor field, off the dead list). NOTE: the old doc's other two "dead" columns came alive — `calendar_token_created_at` and `shifts.client_email/phone` are now read; dropped from the dead list | resolved | low/S |

## 3. Accepted risks (re-affirmed, do not fix)

Carried verbatim from the prior register, still deliberate: CRA transitive CVEs (migration is its own project) · helmet CSP `unsafe-inline` styleSrc (Stripe Elements) · in-memory loginAttempts (single instance) · campaign-step html_body payload · uuid GHSA (unreachable path) · @opentelemetry/core GHSA (fold into next Sentry bump) · record-payment pre-tx `currentPaid` read (benign; re-read under lock if ever reworked) · payroll orphan-sweep excluding negative clawback lines (deliberate: never destroy clawback debt; residual stranded-line incidence near zero) · gratuity fee-netting + "100% to staff" framing (ACCEPTED, do not soften) · dollars-vs-cents split (documented convention; every bridge is a manual `*100` site — the discipline, not the design, is the guard).

## 4. Closed since the last register (verified fixed at HEAD, dropped)

- **Stripe webhook catch no longer swallows DB errors**: handlers re-throw after ROLLBACK so Stripe retries (`paymentIntentSucceeded.js:384-395`, `checkoutSessionCompleted.js:256-265`). Fixed exactly as prescribed.
- **Record-payment status-downgrade guard** (seam-sweep open item): double guard, pre-tx + in-tx against the locked row (`actions.js:171-178, 245-247`).
- **stripe.js split** (1,720 → 621 + `stripeWebhookHandlers/`), **webhook amount_paid hardening** (additive + derived status), **multi-invoice refund clamping** (per-invoice apportionment, tested), **C1 admin sidebar mobile**, **axios 1.17 sync**, **--amber comment**.
- **CC-import orphan TOCTOU race**: OBSOLETE — the entire promote/link flow was deleted (`ccImport/review.js` gone); race surface no longer exists.
- **M8/L2 refund core**: money bug fixed (label-classified reversal, refund_id stamped per invoice); what remains is the design item for an admin refund-scope selector (register §2, low).
- Old "dead columns" that came alive (see D-DEAD note).

## 5. Explicitly REJECTED fixes (verification verdicts; do not resurrect casually)

1. **Extracting `fullPayCents`/`balanceDueCents` helpers across stripe.js/stripeCreateIntent/balanceScheduler** (DUP-S2): mechanically safe but edits three hardened charge paths for marginal DRY gain; against the minimal-first rule. Revisit only inside a future design session that already has those files open.
2. **Unifying POST/PATCH pricing setup in crud.js** (CPX-2): POST and PATCH genuinely diverge (old-record fallbacks, post-payment gratuity guard, override bounds); a shared helper risks introducing the divergence it aims to prevent. The "Mirror POST" comments stay as the sync mechanism; any consolidation is its own full-fleet design session.
3. **Replacing payroll `.toFixed(2)` sites with a locale money formatter** (DUP-C1 full version): those sites are NOT displays — they feed Venmo/CashApp/PayPal deep-link URL params (commas break the link), editable number inputs, and CSV export cells. Only the 3x change-request formatter is safe to consolidate.
4. **Re-enabling `--test-concurrency`** after pay-period isolation (TST-2): suites also collide on users/proposals in the shared dev DB. Serial runs remain the convention.
5. **Extracting crud.js PATCH's in-transaction change-request block** (CPX-1 full version): real money-adjacent writes inside the tx; only the post-commit tail is extractable, and even that needs the full fleet.
6. **Blind Node 22 jump** (DEP-1): pin current major first; major bump is its own verified step.
