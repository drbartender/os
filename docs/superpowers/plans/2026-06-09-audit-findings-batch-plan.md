# Audit Findings Remediation — Master Batch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: each batch is executed with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Batch 1 has task-level steps now; Batches 2–6 get their detailed TDD breakdown written just-in-time when the batch starts (planned against then-current `main`, not a stale snapshot). **First task of every batch: re-resolve the cited `file:line` against current `main` HEAD** — earlier batches shift line numbers in shared files. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix all remaining findings from the 2026-06-09 full-codebase audit (64 warnings + 49 suggestions; the 6 blockers already shipped) in themed, independently-shippable batches.

**Architecture:** One worktree + branch per batch, off `main`. Every code-touching batch runs the 5-agent pre-push review fleet before its push; docs-only batches skip the fleet. Ship each batch as it clears review. The authoritative finding list with exact `file:line` is `.claude/full-audit-2026-06-09.log` (appendix) + the flat digest `.claude/_audit_digest.txt`; this plan is the organization, order, and decisions over it.

**Tech Stack:** Node/Express + raw SQL (pg), React CRA client, JWT auth, Stripe/Resend/Twilio/R2, Neon Postgres. Server tests: `node:test` (run one suite at a time — shared dev DB). Client verify: `CI=true npx react-scripts build`.

---

## Re-baseline 2026-06-11 (verified against `main` @ a26d504)

8-agent verification of every remaining item against current code. **This section is the authoritative status; the line numbers in the batch bodies below are baseline-era (`8102539`) and have drifted, re-resolve at batch start.**

### Completed and shipped to `main`
- **Blockers, Batch 1 (docs), Batch 2 (error-envelope)** (pre-session).
- **Batch 2 carve-out (clientAuth `token_version` revocation):** shipped mechanism-only. The email-change bump was deliberately dropped (decision: client login is OTP-only, so the lever is kept-in-reserve, no automatic trigger).
- **Batch 3a (money + PII):** all 7 shipped. stripe.js webhook extraction (into `stripeWebhook.js` + `stripePaymentNotifications.js`); invoice `proposal_id` cross-check before linking; orphaned-tip recording to new `tips_orphaned` table; `/tips`+`/tip-feedback`(+review) gated `adminOnly`; pricingEngine (per_staff single-instance documented, gratuity basis deduped across all 3 sites incl. `gratuityBasisFromSnapshot`); dispute idempotency documented (the clawback/notify helpers are already idempotent, no event-level guard needed); invoices client-token UUID guard.
- **Bonus: uuid-token-guard sweep** (NOT in the original plan, surfaced by 3a's review). Canonical `server/utils/tokens.js` (`UUID_RE`/`isUuid`/`requireUuidToken`), 15 route guards across calendar/drinkPlans/stripe/stripeCreateIntent/clientPortal/changeRequests/messages, 6 inline regexes deduped. Fleet-cleared. (Follow-up logged: split `drinkPlans.js`, 1179 lines, in `open-threads.md`.)
- **3b loginAttempts Map doc:** already done in `docs/tech-debt.md:207`.

### Corrections to the plan (re-verified, fix before executing)
- **3c imgur CSP prune is MOOT, STRIKE IT.** The audit's premise ("no live imgur origins") is wrong on current `main`: `client/src/pages/website/Website.js` renders 11 i.imgur.com images. Dropping it from `imgSrc` breaks the marketing site.
- **3b `me.js:347` is MIS-PATHED.** The `/api/me` handler lives in `server/routes/auth.js:347-363`, not `me.js`. Re-path the Sentry-capture item there.
- **4a `idx_payout_events_payout_id`:** the index exists on the right column but is named `idx_payout_events_payout`. Verification intent already met; fix the plan's name.
- **3c-deps:** `axios` advisory is already cleared (commits `449abca` + `8e68b5f`). `express` is now 4.22.1 (target the patch 4.22.2, not the digest's 4.21.x). `uuid` still 9.0.1 (bump stands). Live `npm audit --omit=dev`: 3 moderate (qs via express, uuid).
- **5b-3 gratuity-origin display still stands.** The gratuity-redesign project shipped + is live (`062f551`) but did NOT touch this: `gratuity_rate_change_origin` is still write-only (`crud.js:565,638`), no client display.

### Parallel-window commits that touched audit code (the "other windows")
- **`4ccd7a8`** hotfixed my stripe.js extraction: it restored `DEPOSIT_AMOUNT` + `getOrCreateCustomer` (used by the payment-link / charge-balance / create-intent-for-invoice routes) that my prune dropped, throwing `ReferenceError` at request time. My anchor test only exercised the webhook path. Current `main` is correct.
- **`cbebee4`** enabled `no-undef` on server files + Node globals (guards against the above class going forward) and converted the missions test to `node:test`.
- **`8c80859`** documented the `token_version` monotonic + webhook invoice-mismatch behavior (review comments on my work).

### Remaining work, accurate list (status per item)
- **Batch 3b** (2 valid, 2 changed): forgot-password `EMAIL_RE` (`auth.js:366`); emailChange confirm `FOR UPDATE` race (`emailChange.js:51-58` SELECT is outside the txn); changeRequests cancel `AND client_id` scope (now `:159-167`, route already has BEGIN/COMMIT + requireUuidToken); `/api/me` Sentry catch (re-pathed to `auth.js:347`).
- **Batch 3c-route** (8 valid, imgur struck): emailMarketingWebhook idempotency gate; shifts.js user_id validate (`:658`), jsonb-cast guard (the `::jsonb` cast itself throws, not just array-length), `updated_at=NOW()` on PUT (`:419`); clients pagination bounds (`:23`); calendar parseInt radix (`:431`); messages recipient allow-list (`:69`); blog rate-limit; encryption.js key-strength guard.
- **Batch 3c-roles** (all valid): ccImport `requireAdminOrManager`→`adminOnly` (12 call sites across review/phase0/wrapUp/search/proposalActions); review.js promote-path transactions (extract first, still 999 lines). search.js:94 inner check likely deletable once admin-only.
- **Batch 3c-deps** (all valid): bump `uuid` + `express`(4.22.2), verify audit clears.
- **Batch 4a** (14 valid, 1 partial): dashboard-stats 14-query fan-out, qRevenue correlated subqueries, shifts.js LATERAL + dup contractor fetches, payouts/payroll/applications LIMITs, settings unnest upsert, users explicit columns, accountReads Promise.all, crud total-count. (Index name partial.) Watch caps: shifts.js 952, crud.js 981.
- **Batch 4b** (11 valid, NO drift, implement as written): drop dead `react-signature-canvas`, lazy TipTap (2 leaf imports), App.js chunk-reload TTL, html2canvas defer, public-page memos (MakeItYoursPanel, SignaturePickerStep, Blog images, ProposalView, PotionPlanningLab useCallback).
- **Batch 5** (all valid): 5a syncShifts 4 cols + agreements rewire-not-drop + the 2 remaining con-schema (contractor/applications PII source-of-truth doc; proposals.feedback_* zero-consumer). 5b dead-column features: email-harvest (GATED on D1), equipment picker, gratuity-origin display, SMS metadata, notifications_opt_in lying-checkbox fix.
- **Batch 6** (smaller than estimated): the digest has **48** suggestions (not 49). ~5 already done on main, ~30 already folded into Batches 1-5, ~5 declined by KEEP-ALL-COLUMNS. Genuine leftover sweep (~8, all trivial): actions.js admin_notes length-cap + balance-due-date ISO guard; changeRequests existence-probe; drinkPlanConsult res.json placement; eventTypes.js doc-note; beo.js ExternalServiceError serialization audit. Decline: the emailMarketingWebhook/thumbtack webhook-envelope items (webhook clients don't speak the AppError envelope), findOrCreateClient refactor (cleanup-only).

### Still open: D1 (gates Batch 5 email-harvest)
Email-harvest scope: cover the CC-import placeholder clients (`cc-import-noemail-*`) too, or Thumbtack-only?

---

## Plan-review folds (applied 2026-06-09 after `/review-plan`)

The 3-agent plan fleet (fidelity / decomposition / feasibility) returned 3 blockers, 8 warnings, 6 suggestions. Incorporated:
- **B1 — auth.js coupling:** the `clientAuth` token-version gate **moved out of Batch 3b into Batch 2** so `server/middleware/auth.js` is touched once.
- **B2 — ccImport overlap:** the `search.js:94` envelope fix **moved out of Batch 2 into Batch 3c-roles** so ccImport is touched once.
- **B3 — stripe.js is RED (1585 lines, over the 1000 cap):** Batch 3a now **extracts the webhook handlers into a sub-module first**, before adding to it.
- **File-size ratchet** noted on `review.js` (999), `shifts.js` (952), `crud.js` (981) — those tasks must extract-first or stay non-growing.
- **Batch 3c split** into route-hardening / ccimport-roles / deps; **Batch 5b split** per-feature.
- **Keep-all-columns decision** (owner): **nothing gets dropped** — the "destructive schema" concern is gone (see Decisions D2). The two dead columns are kept and wired/relabeled instead.
- Per-batch review-agent lens, commit-per-bullet guidance, and a per-agent coverage table (Self-review) added.

---

## Process (applies to every batch)

1. `npm run worktree:new -- <batch-name>` from `os` (creates the worktree + junctions).
2. **First task: re-resolve cited `file:line` vs current `main`.** Then work the branch.
3. TDD for any money/auth/data-integrity/logic change; behavior-preserving refactors keep the existing suite green.
4. **One commit per bullet** unless two bullets share the same file/function. No WIP commits.
5. Verify: server suites via `node --test <file>` (one at a time); client via `CI=true npx react-scripts build`.
6. **File-size guard:** if a target file is already near/over 1000 lines, extract first (per the `server/routes/proposals/` split pattern) — the pre-commit ratchet blocks growing commits to over-cap files.
7. Merge to `main` in `os`, **confirm the pending batch (rule 0.5)**, run the **5-agent review fleet** (foreground, parallel) on `git diff origin/main..HEAD`, fix any flag, then push. **Docs-only Batch 1 skips the fleet** but still gets the confirm gate.
8. `npm run worktree:rm -- <batch-name>` after merge; `npm install` in `os` if deps changed.

**Per-batch review lens (floor is all 5 agents; weight these):** B2 → code-review + consistency-check; B3a → security-review + money lens; B3b → security-review; B4a → database-review + performance-review; B5 → database-review + security-review.

**Coordination:** `main` is shared across parallel Claude windows. Inventory `git log origin/main..HEAD` before every push; never blind-commit/push. Don't start a merge while another window owns the push.

---

## Decisions

**Made:**
- **CC importer → admin-only.** Swap `requireAdminOrManager` → `adminOnly` across `server/routes/admin/ccImport/*` (Batch 3c-roles).
- **Manager PII → admin-only.** Lock `/tips` + `/tip-feedback` customer-email to admin (Batch 3a).
- **KEEP ALL COLUMNS (D2 resolved).** Owner wants the columns they built — **nothing is dropped.** `notifications_opt_in` stays (its misleading checkbox gets fixed); the duplicate `agreements` columns stay (the importer is rewired so it stops adding to the drift). No `DROP COLUMN`, so no rollback-window concern. App is new with no imported data yet, so no backfills needed either.
- **D3 resolved — build the dead-column features** (equipment picker, gratuity-origin display, SMS metadata) per Batch 5b.
- **CRA → Vite is its OWN deferred project.** The ~15 client HIGH `npm audit` advisories are build-time dev-tooling (not runtime exposure). Accept-and-document now.
- **CocktailMenuDashboard is NOT dead** — it's the Settings → Drink Menu tab. Batch 1 adds a doc note only.

**Open:**
- **D1 — email-harvest scope:** cover CC-import placeholder clients (`cc-import-noemail-*`) too, or Thumbtack-only? (Recommendation: both. Gates Batch 5b-1 only.)

**Future projects (out of scope, tracked):** permissions toggle system (promote staff→admin + granular manager toggles); CRA → Vite migration; the Playwright email-harvester on the Linux box (see [[project-linux-dev-box]]) — the audit work builds only the server endpoint it POSTs to.

---

## Batch 1 — Docs drift (13 findings, docs-only, no review fleet)

**Files:** `README.md`, `ARCHITECTURE.md`, `.claude/CLAUDE.md`, `.env.example`. No code. Single commit `--no-verify`, confirm gate, push (no fleet).

- [ ] **README folder tree:** add `client/src/pages/labrat/` (LabRatLanding, LabRatQuiz, LabRatMissions, LabRatMission, BugDialog, linkify); add `server/routes/admin/payroll.js`; add `server/routes/proposals/actions.js` and move the notes/create-shift/balance-due-date/send-reminder/record-payment desc off `crud.js`; add `adminCoverSwaps.js`, `staffShiftActions.js`, `labrat.js`, `shifts.queries.js`, `stripeCreateIntent.js` (note `clientPortal/summary.js` is a helper); add components PublicLayout, ConfirmModal, BrandLogo, LocationInput, W9Form, DrinkPlanSelections; add admin `eventDetail/` (MessageLogCard.js); add the Drink Menu = Settings tab note.
- [ ] **README env table:** add `RUN_PENDING_EMAIL_CLEANUP_SCHEDULER` + `ENCRYPTION_KEY`.
- [ ] **ARCHITECTURE API table:** add `GET /shifts/user/:userId/events`, `GET /shifts/detail/:id`, `POST /shifts/:id/assign`, the `/api/qa` router, the `/api/admin/payroll/*` router, `POST /api/stripe/create-intent-for-invoice/:token`, `POST /api/drink-plans/for-proposal/:proposalId`, the `/api/shifts` Drop/Cover endpoints + the `/api/admin` cover-swap routes.
- [ ] **ARCHITECTURE `/api/me` table:** add `POST`/`DELETE /api/me/push-subscriptions`, `POST /api/me/request-email-change`, `/cancel-pending-email-change`, `/confirm-email-change`.
- [ ] **CLAUDE.md env table:** add `ENCRYPTION_KEY`, `ADMIN_PASSWORD`, `UPLOAD_DIR`, `MAX_FILE_SIZE` — **verify each is actually read by code before adding the row** (don't document phantom vars).
- [ ] **.env.example:** add `STAFF_URL` (commented).
- [ ] **Commit + push** docs-only (no fleet).

**Effort:** S. **Risk:** none.

---

## Batch 2 — Auth middleware + error-envelope consistency (12 findings)

**Theme:** `server/middleware/auth.js` is the one shared file here — do ALL its changes in this batch (envelope throws + the clientAuth revocation gate folded from 3b) so it's touched once.

- [ ] **errors.js:** add `PayloadTooLargeError extends AppError` (413, `PAYLOAD_TOO_LARGE`).
- [ ] **auth.js L61–91:** replace 7 hand-rolled 401/403 responses with `throw new AppError(...,401,...)` / `PermissionError` (so client `data.code` works).
- [ ] **auth.js L79–93 (folded from 3b):** add a `token_version` revocation gate to `clientAuth` — `clients.token_version` column + JWT embed + bump points. (Same file/region as above → same batch.)
- [ ] **shifts.js L31,39:** `requireStaffing`/`requireOnboarded` → `PermissionError`.
- [ ] **admin/users.js:751:** → `ConflictError('...','STRIPE_LINK_EXISTS')`.
- [ ] **staffPortal.js L689,817,851:** 413 → `PayloadTooLargeError`; 409s → `ConflictError(...,'EMAIL_IN_USE'|'ALREADY_PENDING')`.
- [ ] **staffShiftActions.js L346,714:** 413 → `PayloadTooLargeError`.
- [ ] **clientPortal/changeRequests.js:96:** add the `error` message to the PRICE_CHANGED 409.
- [ ] **(Suggestion) emailMarketingWebhook.js:168, thumbtack.js:332/413/481:** drop redundant 500 catch-alls — **add a route test asserting the global error-middleware shape on one of these paths** (removing a catch-all changes observable behavior).
- [ ] **(Suggestion) adminCoverSwaps.js, emailChange.js:** comment-document the deliberate contractual envelopes (no behavior change).

**Note:** `admin/ccImport/search.js:94` (envelope) is intentionally **NOT here** — it moved to Batch 3c-roles. **Effort:** M. **Lens:** code-review + consistency-check.

---

## Batch 3 — Security warnings (split into 4 sub-batches, fleet each)

### 3a — Money + admin PII (+ stripe.js extraction first)
- [ ] **Pre-task — extract stripe.js (1585 lines, RED).** Move the webhook event handlers into `server/routes/stripe/webhook.js` (or similar) behind a composition router, per the `server/routes/proposals/` split pattern, so the file drops under cap and the fixes below can land. Behavior-identical; keep existing Stripe tests green.
- [ ] **stripe.js:1062:** verify the invoice's `proposal_id` matches webhook metadata before `linkPaymentToInvoice` (mirror the `drink_plan_with_balance` branch).
- [ ] **stripe.js:1273-1346:** orphaned-tip handling — drop invalid-metadata tip sessions into a `tips_orphaned` surface (or 5xx on token-not-found so Stripe retries).
- [ ] **admin/users.js /tips + /tip-feedback:** gate to `adminOnly` (DECISION).
- [ ] **(promoted from Batch 6) con-pricing-types:** `pricingEngine` per_staff addon qty fix + `computeGratuityBasis` dedupe — load-bearing gratuity paths, reviewed under the money lens here.
- [ ] **(Suggestion) stripe.js:1558:** dispute clawback idempotency via `webhook_events`. **(Suggestion) invoices.js:318:** UUID-validate the token.

### 3b — Portals + auth (token_version moved to Batch 2)
- [ ] **auth.js:366:** add `EMAIL_RE` to `/forgot-password` (keep neutral success).
- [ ] **emailChange.js:41-122:** add `FOR UPDATE` in the confirm transaction (closes the double-confirm race).
- [ ] **(Track) auth.js loginAttempts Map:** document the single-instance assumption.
- [ ] **(Suggestion) clientPortal/changeRequests.js:158:** `AND client_id = $3` on cancel. **(Suggestion) me.js:347:** Sentry-capture the `/api/me` fallback catch.

### 3c — route hardening
- [ ] **emailMarketingWebhook.js:67:** add a replay/idempotency gate (UNIQUE on `(resend_id,event_type)` + `ON CONFLICT DO NOTHING`) BEFORE side-effect UPDATEs.
- [ ] **shifts.js (952 lines — watch the cap):** validate `user_id` before assign (L657); `CASE WHEN jsonb_typeof(...)='array'` guard (L85); `updated_at=NOW()` on PUT (L419).
- [ ] **clients.js:23:** bound `page`/`limit`. **calendar.js:431:** `parseInt(...,10)` + `Number.isFinite`. **messages.js:69:** add the role+onboarding allow-list to the recipient fetch.
- [ ] **(Suggestion)** blog.js public rate-limiting; sec-xcut imgur CSP prune + `encryption.js` key-strength guard.

### 3c-roles — ccImport admin-only (single coherent change)
- [ ] Swap `requireAdminOrManager` → `adminOnly` across `review.js, phase0.js, wrapUp.js, search.js, proposalActions.js`. **Re-evaluate `search.js:94`'s inner role check** — likely deletable once the route is admin-only (this absorbs the Batch 2 item).
- [ ] **review.js (999 lines — extract first):** wrap the promote/enqueue + raw-imports UPDATE in a shared transaction (skipDedup retry can create duplicate proposals). **NOT the already-shipped N+1** — that's the read batching in `wrapUp.js` (commit 6ab02e2); this is write-atomicity.

### 3c-deps — supply-chain (own commit, per CLAUDE.md rule 3)
- [ ] `uuid` + `express`(qs) version bumps via `--package-lock-only` (like the axios blocker bump). Verify `npm audit` clears them.

**Effort:** L. **Lens:** security-review (+ money on 3a).

---

## Batch 4 — Performance (server then client; commit per item, checkpoint between groups)

### 4a — Server (checkpoint after each group)
- [ ] **metadata.js:243 + metricsQueries.js:237 (SENTRY-11):** collapse dashboard-stats' 14 round-trips to one FILTER-aggregate; rewrite `qRevenue` as one `GROUP BY date_trunc` LEFT JOIN `generate_series`.
- [ ] **shifts.js (952, watch cap):** correlated subqueries → LATERAL (L44, L196); merge duplicate contractor-profile fetches (L663, L839); explicit columns not `s.*`.
- [ ] **staffPortal/payouts.js:45 + admin/payroll.js:63,413:** add LIMIT/pagination; LATERAL/GROUP BY the `event_count`; **verify `idx_payout_events_payout_id` exists (Neon check).**
- [ ] **admin/settings.js:47:** bulk upsert via `unnest`. **admin/users.js:64:** explicit columns not `SELECT *`. **admin/applications.js:242:** add LIMIT. **staffPortal/accountReads.js:58:** `Promise.all`. **proposals/crud.js:54 (981, watch cap):** return a `total` count.

### 4b — Client (each its own commit; `CI=true npx react-scripts build` per commit)
- [ ] Remove dead dep `react-signature-canvas` (`--package-lock-only`).
- [ ] Lazy-load `RichTextEditor` at the `EmailCampaignCreate.js`/`SequenceStepEditor.js` leaf imports.
- [ ] **App.js:26 (SENTRY CLIENT-4):** TTL on the chunk-reload guard.
- [ ] Defer `html2canvas` to `await import()` in MenuPNG.jsx.
- [ ] perf-public-pages: `React.memo`+`useMemo` on `MakeItYoursPanel`; memoize `countForCategory` in `SignaturePickerStep`; `loading="lazy"` + dims on Blog/BlogPost images + memoize the BlogPost sanitize; memoize `ProposalView` line-items; (suggestion) shared IntersectionObserver in HomePage.
- [ ] `PotionPlanningLab.js:399`: `useCallback` `updateSelections` (realizes the shipped AdditionalNotesCard memo).

**Effort:** M–L. **Lens:** database-review + performance-review.

---

## Batch 5 — Schema drift + dead-column features (NO drops — keep all columns)

### 5a — Schema-drift (enumerate each con-schema finding at batch start — 7 staff + 5 proposals)
- [ ] **eventCreation.js:231-257:** add `client_email, client_phone, guest_count, event_duration_hours` to `syncShiftsFromProposal`'s UPDATE.
- [ ] **agreements dual columns — rewire, DON'T drop.** Point cc-import phase1 at the new `ack_*` columns so it stops adding to the drift; **keep the legacy columns** (empty, no data yet). Add a `-- deprecated, kept` comment. No backfill, no drop.
- [ ] **(remaining con-schema findings)** enumerate + home them when this batch decomposes: contractor_profiles/applications duplicate PII (document source-of-truth), proposals.feedback_* (wire or leave), etc.

### 5b — Dead-column features (split per-feature; each its own sub-batch/commit)

- [ ] **5b-1 email-harvest (server side).** Effort ~1.5d. Mark Thumbtack leads (and per **D1** CC-import placeholders) `email_harvest_status='pending'` on arrival; new `POST /api/admin/thumbtack/email-harvested` (manual paste + SMS-reply sources) → set email + `harvested` + dedupe-merge + audit + fire the existing auto-draft; admin paste box + pending worklist; `emailHarvestRetryScheduler.js` (mirror `webhookEventsPruneScheduler.js`) + `RUN_EMAIL_HARVEST_SCHEDULER` env gate. **The `source: harvester` path is intentional dead code until the Linux Playwright project ships** — note it in the endpoint; it just isn't called yet.
- [ ] **5b-2 equipment picker.** Extract a shared equipment-options constant (`client/src/utils/equipmentOptions.js` + `server/utils/equipmentOptions.js`, mirrored like `eventTypes.js`); refactor the 4 inlined copies + `autoAssign.js`; add the 3-checkbox picker to the shift create forms + an edit affordance on `ShiftDrawer.js`; fold in `auto_assign_days_before`.
- [ ] **5b-3 gratuity-origin display.** Caption in `ProposalDetailEditForm.js` (827 lines, watch); close the `stripeCreateIntent.js` checkout write-gap (preserve prior value, no schema change). Column is already a live guard input — only display is missing.
- [ ] **5b-4 SMS metadata.** Add the payload (`from,to,message_type,proposal_id,client_id,twilio_sid,error`) to the 3 outbound INSERTs (`sms.js sendAndLogSms`, `routes/sms.js` reply, `routes/messages.js` blast). No backfill.
- [ ] **5b-5 notifications_opt_in — KEEP, fix the lie.** Do NOT drop. The signup checkbox currently promises "text me when shifts post" but nothing reads the column. Either remove the checkbox, or (better) rewire it so checking it actually sets `staff_notification_preferences.channels.shift_offered`. Column stays.

**Effort:** L (split). **Lens:** database-review + security-review (harvest endpoint). TDD on the harvest endpoint.

---

## Batch 6 — Suggestions sweep (triage first, then sweep)

- [ ] **6-triage:** produce a concrete checklist of EVERY remaining SUGGESTION not folded into Batches 1–5 (pull from `_audit_digest.txt`), each marked fold / defer / decline with a one-line rationale. This is the deliverable of the triage step — Batch 6 doesn't execute against a vague "fold the cheap ones."
- [ ] **6-sweep:** execute the "fold" items from the checklist. Fleet only if any touch code beyond trivial.

**Effort:** S–M.

---

## Self-review

**Per-agent coverage (scope-drop check):**

| Agent | Findings | Home |
|---|---|---|
| sec-proposals | 3 | Batch 6 |
| sec-money | 4 | 3a |
| sec-admin | 3 | 3a |
| sec-portals-auth | 6 | 3b (+ token_version → B2) |
| sec-webhooks | 4 | 2 + 3c (enumerate the other 3 at 3c start) |
| sec-rest-event | 8 | 3c |
| sec-rest-content | 3 | 3c |
| sec-ccimport | 9 | 3c-roles |
| sec-xcut | 6 | 3c + 3c-deps |
| con-schema-proposals | 5 | 5a |
| con-schema-staff | 7 | 5a + 5b (enumerate each at batch start) |
| con-errors | 11 | 2 |
| con-pricing-types | 3 | 3a (2 promoted) + 6 |
| con-docs-routes | 13 | 1 |
| perf-bundle | 5 | 4b |
| perf-public-pages | 11 | 4b |
| perf-server | 18 | 4a |

**Sentry:** SERVER-11 → 4a; CLIENT-4 → 4b; SERVER-10 already fixed pre-audit.
**Placeholder scan:** Batch 1 fully itemized; Batches 2–6 cite real `file:line` + prescribed fix, step-level TDD just-in-time (stated convention).
**Coupling resolved:** auth.js touched once (Batch 2); ccImport touched once (Batch 3c-roles); stripe.js extracted before growth.
**Destructive ops:** none — keep-all-columns decision removed every `DROP`.

---

## Follow-ups discovered during Batch 3b/3c-route post-merge verification (2026-06-12)

The adversarial-verification pass on the W1 (manager-assignable) + webhook-heal fixes surfaced
work that was deliberately **not** bundled into batch-3b. Each is a real, scoped item.

### F1 — Webhook strand-on-failure, systemic (own mini-batch)
The Resend webhook's "row already exists ⇒ skip" idempotency gate let an event that 500'd
*after* the dedupe INSERT but *before* finishing be stranded forever. Fixed in the email webhook
(gate on a `processed` flag, heal on redelivery; commit on batch-3b). **The same pattern exists in
two more handlers** and should be fixed the same way (each needs a `processed` column where absent):
- **`server/routes/calcom.js:71-79`** — `webhook_events` INSERT autocommits via `pool.query` BEFORE
  `handleCreated/Cancelled/Rescheduled/NoShow` runs in its own transaction. If that inner tx fails,
  the dedupe row stays committed and Cal.com's retry short-circuits as "Already processed" → the
  consult is never filed. `schema.sql` `webhook_events` (~2787) has **no `processed` column** — add it.
- **`server/utils/smsInbound.js:440-446`** (via `server/routes/sms.js:69-83`) — `processInboundSms`
  early-returns "duplicate" on bare `twilio_sid` row-existence. If a side-effect (opt-out/opt-in,
  CONFIRM/CANT shift mutation, admin SMS) throws after `recordInboundMessage` commits, Twilio's retry
  short-circuits and the action is lost. Gate on a `processed` flag (or wrap record+side-effects in
  one tx). The "safe no-op" header comment at sms.js:81-82 is the bug.
- **Correctly different (no action):** Stripe webhook (dedupe INSERT lives inside the same
  `dbClient` BEGIN/COMMIT as side-effects; retry re-runs cleanly), Thumbtack `/leads`, `/messages`,
  `/reviews` (dedupe inside tx and/or post-insert work is try/catch non-blocking).

### F2 — Email webhook idempotency, remaining hardening (small)
On `server/routes/emailMarketingWebhook.js`, after the COALESCE-timestamps + unknown-type-processed
fixes (batch-3b): (a) `email_sends.status` has **no monotonic guard**, so an out-of-order replay of
an earlier-pipeline event (`delivered` after `opened`) regresses status — this is **pre-existing**
(each event type is its own row; out-of-order delivery triggers it independent of the heal). Add a
status-rank "advance only" guard. (b) No `FOR UPDATE` lock around the `processed` re-check — two
concurrent redeliveries can both run the (now idempotent) side-effect block; tighten with a row lock
or a `... AND processed = false` guard on the final UPDATE. Both low-urgency (side-effects converge).

### F3 — Manager-as-staffer iCal feed (pre-existing UX, now more relevant)
`server/routes/calendar.js:297` — `isAdmin = role IN ('admin','manager')` routes a manager's iCal
feed to the admin path, so a manager who is actually **assigned to specific shifts** (now possible
post-W1) sees EVERY shift in their feed, not just their own (no position/BEO-ack/drink-plan
projection). Split: a manager who holds approved shifts should get the staffer feed for those, or a
merged view. Pre-existing; W1 raises its relevance.
