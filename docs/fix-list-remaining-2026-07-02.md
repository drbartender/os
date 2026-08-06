# Fix List: What's Left (refreshed 2026-07-07)

The 2026-07-01 brain dump is fully processed and shipped. As of 2026-07-07 the
tree is clean and everything below the line is either LIVE, a design session
Dallas drives, a scope call, a prod-confirmed bug, or an operational tail.
Re-verify line numbers before building anything.

## Shipped & LIVE (was the backlog, now done)
- **cc-import rework — ALL 3 PHASES LIVE 2026-07-07.** Phase 1: 187 CheckCherry clients. Phase 2: frozen CC-era ledger (P&L penny-tie) + v1 demolition (13.5K lines) + blended dashboard/financials metrics (include_cc tri-state, close rate). Phase 3: 13 future events transferred to native confirmed proposals (money override-locked, external_paid folded, durable nudge suppression, comms-guarded). Post-transfer fix: 3 events' rosters (Cody/Shazana/Cecilia) had a spurious additional-bartender add-on stripped -> 2 bartenders each. See [[project-cc-clients-import]].
- **Admin cross-navigation — LIVE 2026-07-07.** 6 lanes: clickable EntityLink entity refs + useUrlListState URL view-state across proposals/clients/events/staffing/comms/money surfaces. Shared primitives (EntityLink, useUrlListState, ScrollToTop, useDrawerParam).
- **Stripe payout tracking — LIVE** (settlement mirror, payout.* webhooks, unmatched bucket).
- **Proposal-options compare — LIVE**; legacy stragglers 469 + 475 archived.
- **Thumbtack budget warning — LIVE** (over-budget badge draft/sent + payment-panel stated-budget line).

---

## Design sessions Dallas drives (prompt docs committed, none started)
- **Dashboard / Financials redesign (Money Board)** — SHIPPED, PUSHED LIVE 2026-07-10 (f6c9c90, batch e99fbb6..f6c9c90; sweep CLEAN on the 3 seam files, zero sensitive paths): all 7 lanes merged (a list-filters 8aff846, b1 shell 5560d16, b2 analysis 16a4fed, b3 rainbow chart 345592e, c payroll card f80057c, d payouts focus cbb83dc, e prep queue 6c9ae0b), each per-lane reviewed (3 review FAILs found real bugs, all fixed pre-merge). Suites green on merged main (13+2+6), CI build exit 0, backend boots. Spec/plan: `docs/superpowers/specs/2026-07-09-money-board-design.md`, `docs/superpowers/plans/2026-07-09-money-board.md`. Owed now on PROD: Dallas eyeball smoke (both skins + rainbow palette + 390px + chart hover/zoom/Compare) and the manager walk (manager-test login exists on DEV only; prod walk needs a prod manager account or do it on the dev box, network tab must show zero /admin/payroll/* calls). NEXT PICK: the committed split-by metrics lane (spec section 11).
- **Split-by metrics lane (COMMITTED follow-up, per Dallas 2026-07-09)** — MERGED to main 2026-07-13 (0861a41, lane splitby-a): close rate + revenue split by event type and lead source on the Funnel card. New native-only `GET /api/proposals/metrics-split` sibling (LAW dashboard-stats/financials byte-frozen); query-time vocabulary normalization merges the twin event-type vocabularies + `__untyped` sentinel; list-route `event_type` filter now normalizes both sides for the drill-outs; Funnel card gains a URL-backed `Split: None | Source | Type` seg. Server suites green (metricsSplit 12, crud.filters 17), CI client build exit 0, `metadata.shapes` LAW untouched. Spec/plan: `docs/superpowers/specs/2026-07-13-split-by-metrics-design.md`, `docs/superpowers/plans/2026-07-13-split-by-metrics.md`. Chart split DEFERRED per spec §10.
- **Bar Program -> POTIONS** — BUILT 2026-07-09 per `docs/superpowers/specs/2026-07-09-potions-bar-program-design.md` + plan `docs/superpowers/plans/2026-07-09-potions-bar-program.md`; PUSHED LIVE 2026-07-09 (ba83407). /potions home (Menu + Recipes + Pars + plans drawer), single par catalog with call-on conditions, 41 draft recipes ready to seed, generator catalog-driven, client mirror killed. Owed: Dallas recipe review pass (6 low-confidence drafts), prod seedRecipeDrafts run (dry-run first). See [[project-bar-program]].
  - **SEED-RUN GATE: CLEARED 2026-07-09** (lane potions-g-gatefixes, merged a0c2a8a; awaiting next push). All 4 second-opinion findings fixed + regression-tested (28/28): (1) mocktails-only serving merges recipes; (2) seed script post-write parity validates LIVE rows + drift report; (3) Peychaud's normalized aliases (script + dev row); (4) matching-mixers pulls from the new pairableItems slice (all active mixer/garnish rows). Prod seed run is un-gated once this push ships.
- **Compare-page reskin** — `docs/compare-page-design-prompt.md`, sitting since 7/2; can ride either session above.
- **Potion Planner rework (client wizard)** — prompt doc committed 2026-07-15: `docs/potion-planner-design-prompt.md` (current-state map, file refs, ranked confusion inventory incl. Dallas's balance-questions ask, money-path law). Flow/comprehension redesign in the existing skin, claude.ai/design session next. Absorbs the deferred 7/13 items #1 (custom drinks/mocktails on shopping list) and #2 (better balance questions).
- **Client-detail messaging (QUEUED 2026-07-14, from Needs-Attention-tabs spec §7)** — full SMS history + reply on the client details page; Messages nav demotes to an "All messages" link; the overview's unread-SMS queue items retarget to the client page (one-line change). Driver: finding a thread in the Messages tab is too tedious. Endpoints already exist (`/sms/conversations/:clientId` + reply route).
- **Menu design page (QUEUED 2026-07-14, from Needs-Attention-tabs spec §7)** — real workflow over the planner-captured menu prefs (`menuStyle`/`menuTheme`/`drinkNaming`/`menuDesignNotes`); produces a real artifact and the done-state that then powers "menu to design" Prep queue items (deliberately NOT hand-flagged in the tabs build). Dallas has page ideas to brainstorm.

## Scope calls needed before scoping
- **Classes / field guide** — restyle existing (`ClassWizard.js` booking wizard + `FieldGuide.js` staff doc; redesign brief already covers restyles) OR new marketing/content pages? Unresolved.
- **Staff payment system** — quiet for weeks; superseded by the shipped paystub/payroll work, or still queued (minimal-first, absorbs multi-bartender tipping)?

## Known-bugs batch — FIXED on main 2026-07-14 (UNPUSHED, awaiting Dallas push cue)
The 14-bug sweep below (B1-B14) was re-verified against HEAD by a parallel
investigation, specced + plan-reviewed (docs/superpowers/{specs,plans}/2026-07-14-known-bugs-batch*),
built in 8 file-disjoint lanes (kb-a..kb-h), each per-lane review-fleet clean
(full fleet on the 7 money/sensitive lanes, light on kb-h), and squash-merged
(90f3029..419f585 + docs c1bfd2c). NOT PUSHED. At push: full fleet +
/second-opinion on the sensitive commits + money-smoke gate.
- **B1 refund-leaves-booking-live** — FIXED (M-1 archive-does-the-reaping): shared `shiftReap.js`, archive endpoint reaps shifts + pending messages + voids invoices, refund UI prompts archive at amount_paid=0, eventStatusChip 'Cancelled' branch, email-only staff notify on reap.
- **B2 archive_reason** — FIXED: reason picker (allowlist, default no_hire, client_cancelled default on the refund-prompt path), written + displayed in the archived list.
- **B3 post-cancel money doors** — FIXED: 409 EVENT_CANCELLED on the invoice AND drink-plan public intent routes; settle-on-archived Sentry+admin alert in both webhook handlers; cancel cancels PIs on surviving invoices too.
  - **B3 push-review hardening (2026-07-14, codex + Claude-fleet re-review caught):** the settle-on-archived detection originally suppressed only the ledger *credit*; every *conversion* side effect still ran on a cancelled event. Fixed in both webhook handlers by detecting archived ONCE up front (early read + breadcrumb, before commitGroupChoice) and gating ALL conversion behavior on `!archivedSettle`: Balance invoice mint, last-minute hold + staff SMS blast, `createEventShifts` phantom-shift, reminder ladder, sign+pay marketing, client receipt, AND `commitGroupChoice` + `sweepClientAlternatives` (the last two were a SECOND gap the focused re-review caught: a stale payment on a cancelled solo booking was silently archiving the client's live rebooking quotes as `option_not_chosen` and voiding their invoices). The credit + payment row + invoice link + admin alert are deliberately preserved so a manual refund can return the money. Pinned by hardened assertions in `stripeWebhook.archivedSettle.test.js` (no phantom shift — seed now sets event_date so the shift is genuinely insertable; no Balance invoice; the client rebooking quote is NOT swept); all webhook-suite regression tests (optionGroup, lastMinute, balanceBranch, invoiceLink, extrasLink, guards) stay green, confirming the gates are no-ops on the live path. Also fixed the `payment_on_archived` alert COPY (both handlers) to point the admin at the manual Refund panel instead of Cancel→Refund, which can 409 (`NOT_CANCELLED` on an already-archived booking) or under-target (the ≤14d client-cancel agreement math ignores post-cancel payments). The money is always recoverable via `POST /refund/:id` (no status guard), so the copy now routes there. (Known benign edge: that panel excludes the `drink_plan_*` rails; a stale drink-plan payment on an archived proposal is a non-scenario and is the pre-existing panel limitation, not introduced here.)
- **B4 held_state-blind upserts** — FIXED: clawback + late-tip held-branch CASE honors the shared invariant (line_total = payable components + LEAST(net adjustment, 0)).
- **B5 cancel-refund retry over-refund** — FIXED: lifetime cap = min(liveMath, cancel-time refund_owed_cents snapshot + post-cancel headroom); lifecycle restore clears cancel state.
- **B6 stranded pending refund + ambiguous-error misclassification** — FIXED: refundExecute leaves ambiguous errors pending; new `refundSweepScheduler.js` reconciles stale pendings against Stripe.
- **B7 shortfall_cents in CancelEventDialog** — FIXED (display).
- **B8 lastMinute test registerAll** — FIXED (test).
- **B9 eventEveSms processing-delete** — FIXED (revert to pending-only DELETE).
- **B10 thumbtack heal re-notify** — FIXED (10-min in-flight gate, 503 retry_later); calcom refuted (no notifications there).
- **B11 voice dead-leg TOCTOU** — FIXED (atomic claim + `uq_call_audit_dead_leg` partial unique index; prod+dev pre-checked no dup pairs).
- **B12 autopay-guard drink-plan blindness** — was ALREADY FIXED (2f6e0dc); docs/meta stamped only.
- **B13 orphan-sweep negative-adjustment** — FIXED (held-with-payable, sign-scoped readers foot).
- **B14 un-TRIMmed position** — FIXED at cancel.js (money) + autoAssign + coverBroadcast; the shift_requests CHECK made padded rows unseedable, so it landed as P3 idiom alignment.

**Accepted residuals + follow-ups recorded from this batch (deliberately not built):**
- **W1 (from kb-a review): a THIRD archive door does not reap.** `PATCH /proposals/:id/status -> 'archived'` (lifecycle.js, admin, `?force=true` from any status) reaps only marketing/change-requests, never shifts/messages/invoices. NOT reachable from the UI (ProposalDetail only posts sent/accepted through it; the Archive button uses `/:id/archive`), and the dispatcher archived-cascade backstops comms, but a raw-API archive of a shift-bearing booking keeps the shift live — the B1 symptom via a different door. Fix: route lifecycle->archived through `reapShiftsForProposal` or block it for shift-bearing proposals. Small; do in a later proposals-touching lane.
- **B5 cross-cycle residual:** after cancel -> refund -> restore -> re-book -> re-pay -> re-cancel, the second cancellation's snapshot is computed from a gross SUM of all succeeded payments (refunds never demote payment rows), so the forfeited cycle-1 retainer can partially leak back into the cycle-2 cap. Visible in the preview before money moves. Snapshot-per-cycle or a payment-row demotion would close it.
- **B9 edge:** a reschedule landing in the seconds-wide mid-send window whose send then hangs >10 min gets reaper-redispatched with the hardcoded "tomorrow" copy for an event now days out (details otherwise fresh). Double-rare; part of the notification-dup cluster.
- **B4/B13:** a held reimbursement clawed to exactly 0 while the worker is still off-roster is deleted by the next sweep's adj==0 path (loses only the audit note, zero money). B11 NULL-CallSid dead legs (non-prod, forged posts fail signature) no longer write a forensic audit row.
- **B10:** if Thumbtack counts repeated 503s toward webhook health/auto-disable, a crash-strand whose only retry lands inside the 10-min window stays unhealed until manual replay (lead+client rows are committed and visible). B6: an ambiguous-error pending row blocks that charge's headroom for ~45 min and is invisible in refund history until the sweeper resolves it.

## Known bugs (prod-confirmed, unbuilt)
- **A refund on a paid proposal leaves the entire booking live.** Found 2026-07-09 on proposal 500 (Shruti Parekh: refunded 7/1, still sitting on the Events board 8 days later with 11 pending client reminders queued). `issueRefund` (`server/utils/refundHelpers.js`) reverses the payment, reverses the linked invoice(s), and downgrades `proposals.status` back to `accepted` (`refundHelpers.js:282-283`). It touches nothing else: that file has zero references to `shifts` or `scheduled_messages`. So a fully-refunded booking keeps (1) its auto-created shift at `status='open'`, visible on the Events board *and* in the staff open-shifts feed, where a bartender can and did apply to work a cancelled event; (2) its balance invoice at `status='sent'`, still dunnable; (3) its whole pending `scheduled_messages` ladder. The dispatcher's `checkSuppression` gates only on `proposal.status === 'archived'` (`scheduledMessageDispatcher.js:140`), and `accepted` is not `archived`, so balance reminders (which recompute `total_price - amount_paid > 0`), drink-plan nudges, event-week and event-eve reminders all keep firing at the refunded client.
  - Compounding it: `POST /proposals/:id/archive` (`actions.js:397`) voids invoices and suppresses messages but **never touches shifts**; and neither the admin Events feed (`shifts.js:40`) nor `EventsDashboard.js` filters on `shifts.status` or `proposals.status`. So archiving the proposal does not remove the row, and soft-cancelling the shift does not either. Only a hard `DELETE FROM shifts` does.
  - Manual cleanup performed for 500: archive via the UI (Dallas) + `DELETE FROM shifts WHERE id=337` (cascaded one pending `shift_requests` row; no `payout_events`, so no payroll exposure). The staffer who had applied was never notified, since no code path does that.
  - Fix directions, unscoped: reap on refund-to-zero (shift + invoice + scheduled_messages together), or widen `checkSuppression` past its archived-only gate; teach the archive endpoint to reap shifts; filter cancelled shifts and archived proposals out of the Events feed. Same family as the open seam-sweep `record-payment status-downgrade` item.
- **`archive_reason` is never written by the archive endpoint.** `actions.js:397` sets `status='archived'` and leaves the column NULL. The CHECK constraint allows `no_hire`, `client_cancelled`, `we_cancelled`, `event_completed`, `other`, `option_not_chosen`, but only `option_not_chosen` has a live writer (`proposalGroupCommit.js`). Every manually archived proposal therefore shows no reason in the archive bucket. Small: wants a reason picker on the archive action.

## Post-push review 2026-07-13 residuals (confirmed P2s, deliberately deferred)
The 27-commit batch (031fb6d..77005c5) got its push-time fleet + /second-opinion pass AFTER the push; the two P1s it found (drink-plan rails unreachable by /cancel/refund; UTC-vs-Chicago notice date) plus the pending-refund retry double-issue were fixed same-day in lane `cancel-refund-hotfix` (merged e97dfec, all confirmed by regression tests that fail pre-fix). These confirmed P2s remain, all conservative-direction or narrow-window:
- **Post-cancel money doors.** A partially-paid invoice survives cancel as `partially_paid`, and `create-intent-for-invoice/:token` (`stripe.js:~536`) has no archived-proposal guard, so a client on a stale emailed link can keep paying a cancelled event; likewise an intent already `processing` at cancel time settles later (the webhook credits archived proposals unconditionally — only status promotion is guarded). Money lands outside the refund math; a /cancel/refund re-run picks it up, but nothing prompts one. Fix direction: archived guard on the public invoice intent route + Sentry/admin alert when a payment lands on an archived proposal.
- **`payout_events.held_state` is invisible to the clawback/late-tip ON CONFLICT upserts** (`payrollClawback.js:196-212`, `payrollLateTip.js:168-182`): their DO UPDATE recomputes `line_total` with no held awareness, so a narrow remove→re-approve→tip-refund chain can resurrect a HELD reimbursement as payable with `held_state='held'` (breaks paystub footing). Fix direction: make both upserts preserve held zeroing, or trigger re-accrual on shift_request approval.
- **Cancel-refund retry can over-refund via the retainer feedback loop**: `applyRefundReconciliation` decrements `invoices.amount_paid`, and `retainerCents` reads live from the Deposit invoice, so a second /cancel/refund run after a mid-loop failure computes a higher client-mode target (~+5% of retainer). Converges after one extra run; pending-netting (now shipped) narrows it. Fix direction: snapshot the agreement target at cancel time (activity log already records `refund_owed_cents`) and cap lifetime cancel refunds against it.
- **Stranded pre-Stripe `pending` refund row has no healer.** Pending rows now (correctly) block refund headroom; a row orphaned by a crash BEFORE the Stripe call can never be webhook-adopted and permanently under-refunds until a manual `UPDATE ... SET status='failed'`. Also invisible in the refunds history (`stripe.js:399` filters pending). Fix direction: stale-pending sweeper that reconciles rows older than N minutes against Stripe. Related inverse hole (pre-existing): `refundExecute.js:68` marks 'failed' on ANY Stripe error including ambiguous timeouts where the refund may exist — only definitive rejections should fail the row.
- **`shortfall_cents` isn't surfaced in CancelEventDialog** — server returns it + Sentry warns, but the admin toast still reads as complete. One-line UI add whenever the dialog is next touched. (Legacy-CC / manual payments are the live trigger: refund those by hand.)
- **Cancel-path frozen-period clawback deferral retry loses the pre-denial bartender list** (`payrollDeferredRetry.js:28` replays without opts; by then shift_requests are denied → marker advances with zero clawed). Defense-in-depth path only; near-unreachable by construction.
- **Boot re-asserts P4 floor values** (`schema.sql:2119` UPDATE runs at every initDb): hand-tuning `min_total`/`min_billed_guests` in SQL silently reverts on next deploy. By design for a seed-managed table — just know the only way to change floors is editing schema.sql.
- **`checkoutSessionCompleted.lastMinute.test.js` never calls `registerAll()`** — the deposit-paid reminder scheduling errors (swallowed, non-blocking) in every smoke run, so the suite isn't asserting reminders get scheduled. Prod is safe (`server/index.js:518` registers before any webhook can dispatch). One-line `before()` fix mirroring `preEventScheduling.test.js:23`.

## Specced, deliberately parked
- **Drink-plan edit lock (Option A)** — decouple the lock from submit (currently `status IN ('submitted','reviewed')` in `drinkPlans/submit.js`), tie to `shopping_list_status`, add an admin "reopen for client" control. Option B (autosave tracking) already exists. Medium; event-side-canonical drink-plan territory.

## Dallas-owned / skipped by his call
- **Intro message: remove phone, add cal.com link** — candidates: `smsInbound.js:15` HUMAN_CONTACT_LINE + client `COMPANY_PHONE` (`constants.js`). `CAL_BOOKING_URL` already wired.
- **Syrup picker** — suspected bug: generators never cross-check `syrupSelfProvided` vs comped/paid `proposalSyrups` (`addSelfProvidedSyrups`, both mirrored generators). Re-diagnose fresh; pay-now-extras comp-fold touched this territory.

---

## Operational tails (not builds)
- **Zul VA calling — LIVE and in use.** Confirmed via prod usage 2026-07-06 (7 calls, 17 Telegram updates logged); Zul places/receives US calls through the Telegram->Twilio bridge. The bring-up runbook is done; nothing owed.
- **CC migration hand-off (owner, before CC dies 7/21):** turn OFF CheckCherry client notifications; send the 12 Stripe balance invoices (invoice link is the pay path for confirmed proposals; the auto-reminder /proposal link has no pay button); intro-note each client + re-enroll their drink-plan nudge (the reenroll button clears the durable suppression); download signed contracts + a 2026 YTD P&L export. If Sid (due 7/9) / Cody (7/17) pay via CC first, bump external_paid/amount_paid via the documented UPDATE (never a payment row). Check/cash balances: case-by-case UPDATE (record-payment refuses confirmed by design).
- **Eyeball sweeps owed:** After Hours both-skin (event page, a dashboard, blog-editor fields, primary-button hover); doc-preview modal with a real W-9 PDF + headshot in both skins.
- **Resend Pro upgrade** — free 100/day cap hit; scheduled sends degrade gracefully; whenever.

## Payroll-redesign follow-ups (2026-07-15, from lane fleet reviews)
ALL RESOLVED 2026-07-16 (commits 5c5a769 + f3fa6f7): PaydayProtocols zelle re-add + POST /payment zelle support; staffShiftActions frozen-period guard rewritten as correlated EXISTS; emergency-drop past-event 409 (event_started); PayPanel/PayoutRow zelle label shims collapsed. Old-UI zelle null-handle records: prod queried read-only 2026-07-16, ZERO affected rows, closed as no-op.

## Small deferred / tech-debt
- **crud.js `/:id/legacy-cc-payments`** — now clientless (CC demolition deleted its only consumer); dead endpoint in sensitive `proposals/`, remove in a later proposals-touching lane.
- Refunds-on-invoice: a payment split across multiple invoices shows the FULL refund on each (rare, informational). Apportion if it bites.
- Payment accounting: non-flat add-on comp residual (brief owed).
- Audit leftover: manager iCal in `calendar.js` (last open audit item).
- Tech debt: `notifications_opt_in` dead column DROP (4 test fixtures still INSERT it); `.form-select` focus padding-right; no-tip-jar badge redness vs last-minute badge; `.staffing-stat strong` ink emphasis.
- Empty v1 tables (`legacy_cc_raw_imports`, `cc_import_runs`, `cc_import_phase0_failures`) stay as harmless scaffolding. Dev v1 junk SCRUBBED 2026-07-14: 176 v1 proposals (+ shifts/refunds/scheduled messages) and 1,199 v1 clients deleted transactionally with verification; 16 CC-marked clients with real proposals kept; ~1,207 dev `legacy_cc_proposals.client_id` links nulled (no live consumer); 22 `users.cc_id` rows deliberately untouched.

## Potion custom-recipe flow residuals (2026-07-16, full-fleet accepted-not-fixed)

- Reuse-by-NAME rename gap: Add-recipe reusing a drink matched by name (never
  aliased) loses the match if the admin renames it in the drawer; needsRecipe
  resurfaces, next click mints a fresh draft. Proper fix: a small alias-append
  on reuse (server surface; PUT deliberately ignores request_aliases).
- Reuse-before-create lookup downloads both full admin drink lists (ingredients
  JSONB included) for a name match; fine at ~43 drinks, wants a lean lookup
  endpoint as the off-menu pool grows.
- RecipeEditor renders every par (83) as an option per row; memoize the row
  component or hoist options if the catalog grows several-fold.
- `loadRecipeCandidates` awaits serially after the resolveDrinkIds Promise.all
  in `buildPlannerGeneratorInput` (~one extra Neon round-trip per regenerate).
- `server/routes/drinkPlans.js` is ~795 lines (soft cap 700); next change in
  that file should carry the split (per-concern extraction, proposals/ pattern).
- PantryParsTab.js reads `err.response?.data?.*` (lines ~83/93/129), always
  undefined under the api.js interceptor, so its toasts degrade to generic
  copy; same defect class fixed in RecipeEditor. Quick fix on main.
- `generateLineItemsFromProposal` is override-blind: it always itemizes from
  catalog, so any proposal whose `total_price_override` differs from catalog
  gets an invoice with a correct total sitting over line items that do not add
  up to it (Shiralee INV-0120: $450 of lines on a $270 invoice). Deliberately
  NOT fixed alongside the 2026-07-16 drink-plan money fix: every invoice flows
  through that generator, and an honest reconciling line for the CC events would
  depend on the "package includes a bar" fact that exists only in the 2024
  contract PDFs, so it would produce an itemization we would hand-edit anyway.
  Affects native custom-priced proposals (the Edward Marx set) too. The CC tail
  is handled by `scripts/cc-balance-invoice.js` instead.
- The $50 first-bar ghost resurrects on recompute. CC-transferred proposals
  carry `num_bars >= 1` where the contract bundles the bar, so any snapshot
  recompute re-adds the package's `first_bar_fee` to the breakdown. Demoted to
  cosmetic by the 2026-07-16 fix (the override now always pins the total, so it
  can never reach a charge), but it still reappears as a breakdown line on the
  proposal page after each admin save.
- Drink-plan submit: deselecting an already-CONTRACTED syrup reduces the
  negotiated override (`total_price_override`). The delta prices `catalogAfter`
  from the client's current selection while `catalogBefore` carries the snapshot
  syrups, so a contracted syrup the client drops (without marking it
  self-provided) yields a negative delta and shaves the contract — the same
  "client mutates the negotiated contract" invariant the 2026-07-16 fix protects,
  opposite direction. Found by codex second-opinion 2026-07-17. DEFERRED (Dallas
  call): unreachable on live data (0 override'd proposals carry snapshot syrups),
  reduction-only, and the potion planner + syrup picker are slated for rework —
  fixing contract semantics in code about to change is wasted. Ready fix if it
  ever bites: price `catalogAfter` syrups as `preSyrupsPriced ∪ net-new` so
  contracted syrups are fully neutral to the delta. Fold into the planner rework.

## Comms send-modal residuals (2026-07-18, push-review accepted-not-fixed)

- Post-flip total-failure dead-end: if the confirm 500s wholesale AFTER the
  approve flip but BEFORE any send (dispatch throw outside the per-channel
  trys), Retry is unreachable and a re-click skips with a misleading
  "concurrent confirm" reason; recoverable by editing the list (PUT reverts
  to pending_review). Rare; strictly better than the double-email it replaced.
- Route-level tests for POST /api/comms/send (T5 debt): subject caps, header
  hygiene, empty-channel rule, retry guard, partial-failure shape.
- messageLog proposalId foot-gun: any future admin-alert send that passes
  meta.proposalId lands on the client-facing Messages card.

## Lead-call bridge residuals (2026-07-18, push-review accepted-not-fixed)

- Cap-trip rows (status 'failed', detail 'cap_tripped') COUNT toward the
  rolling daily cap, so a flood keeps the cap saturated past the original
  attempts aging out. Adjudicated intended (fail-closed backstop; gemini
  flagged, two fleets blessed). Escape hatch if the lockout ever bites a
  normal day: exclude detail='cap_tripped' from the cap COUNT.
- 'connected'-but-unbridged rows (lead hangs up <20s after press-1) are
  terminal-invisible: no reap, no email, not in needs-attention. Spec accepts
  with a week-one bridge_duration_sec eyeball; make a permanent low-duration
  attention filter after launch week.
- LEAD_CALL_DAILY_CAP=0 silently means 25 (NaN-guard); the kill switch is the
  only off path. Doc note whenever the env table is next touched.

## Comms send-modal lanes P+N residuals (2026-07-18, post-merge 80da937 + f1d2e88)

- ~~LIVE BUG: submit.js slow-path drink_plan_ready emailed the stale drink_plans.client_email snapshot (dead proposal.client_email fallback)~~ **FOLDED into lane pp2-planner 2026-07-18**: the existing-plan SELECT now JOINs live `c.email`/`c.name` (live first, snapshot fallback), mirroring the fast path. Ships with the lane's squash merge.
- Compare-send toast reads "Text skipped: Compare sends have no text message" (truthful, noisy). Set the sms skip reason to 'not selected' when SMS is not in channels, or gate the toast on submitted channels. (P fleet code-review.)
- ProposalDetailPaymentPanel double-fetches `/invoices/proposal/:id` (its own list + InvoiceDropdown's self-fetch, keyed together). Lift the fetch and pass the list down. (N fleet code-review.)
- Deprecated resend-nudge delegation makes 3 DB round-trips (resolve + ensure + dispatch loads) vs legacy 1; archived case is now 409 vs legacy 400. Compat-only route, low traffic; tidy if ever touched. (N fleet.)
- invoiceSend docblock: "the level the legacy send path had" should reference the nudge route's posture (invoice send is new, no legacy). (N fleet.)
- paymentReminder/drinkPlanNudge email availability does not require the token although the email body embeds it (937ba35 only added the guard to SMS + placeholder email). Harmless (no-token proposals are rare and the CTA link just dies), tidy with the next comms touch. (Psync report.)

## Planner v2 residuals (2026-07-18, post-merge of all 6 pp2 lanes)

**Dallas content calls (from the lineup lane + live coverage):**
- CONFIRM: F5 ginger-ale removal was extrapolated from the Midrange/Enhanced purge (flagged by the lineup script; DB + prose already reflect removal).
- RECONCILE: Grand Experiment stocks Miller Lite in package_items but the marketing prose omits it — add to prose or drop from lineup.
- CONTENT CALL: Enhanced has no triple sec, so Margarita is FENCED on Enhanced (old marketing copy said "sharp enough for margaritas"); and no citrus add-on exists, so a Midrange margarita reads unmakeable rather than fenced. Options: add triple sec to Enhanced contents, create a citrus/liqueur add-on, or accept the honest fence/unmakeable readings.
- pp2 lane branches await the -D nod (worktrees removed; shared-file tails make the byte-diff check inapplicable): pp2-recipe-card, pp2-package-editor, pp2-lineup, pp2-quantity-review, pp2-planner (+ pp2-core already deleted).

**Tech-debt / small residuals:**
- ~~server/routes/drinkPlans/submit.js at 865 lines (soft cap 700): split by the established per-concern pattern on next touch~~ **DONE 2026-07-22** (lane fs-split-drinkplans): submitSanitize.js + submitNotify.js extracted; submit.js 830→599.
- Jack-rule corner (code-review low): on hosted non-mocktail packages, a client submit with zero resolved mocktails clears BOTH pair rows, so an admin-seeded Mocktail Bar addon would be removed by a client submit. Consistent with picks-are-authoritative design; revisit if admins start seeding mocktail addons.
- Perf quick-wins (performance fleet, optional): narrow coverageContext's SELECT * FROM par_items; hoist DrinksV2 typeahead pool memo; precompute DrinksV2 tab counts.
- QR lane residuals: per-item admin_set flag rides the public payload (inert); no un-hold UI for admin-set quantities; buffer chips informational only (per-event override deferred by metadata-only scope).
- Legacy planner drain: delete client/src/pages/plan/steps/ + data/drinkUpgrades.js + DRINK_SYRUP_MAP/pricing exports in data/syrups.js after the last planner_version=1 draft submits (query: SELECT COUNT(*) FROM drink_plans WHERE planner_version=1 AND status IN ('pending','draft')).
- **pp2-lab fleet advisories (all non-blocking, 2026-07-18):** (1) pay-then-add delta invoice line items list the cumulative lab set with the drift folded into the last line — amount_due is exact, labels warp; consider delta-scoped selections or an explicit "less previously invoiced" credit line. (2) Client removes additions AFTER paying the lab invoice → over-collection silently retained (admin refunds manually; DRB-favorable, surfaced at list re-approval). (3) Lab PUT accepts any active non-Jack addon slug, wider than the UI advertises — priced correctly, input-surface note only. (4) refreshListAfterLabChange fires per save with no per-plan coalescing (correct, off-response-path; cheap robustness win). (5) No in-flight guard on the debounced client save (server FOR UPDATE serializes; self-heals). (6) Syrup shopping-list strip matches by normalized-name substring — admin re-approval is the backstop. (7) A syrup already priced into pricing_snapshot.syrups is still offered by GET but bills $0 (v1-snapshot plans only; v2 has no planner syrup picker).
- Rollout runbook (at push): run server/scripts/applyPackageLineup2026.js on PROD (dry-run first) + server/scripts/migrateDrinkMeta.js on PROD; both idempotent, snapshot/skip-guarded. **TWO GATES before the lineup script's prod run: (1) the `includes`-prose item in the push-review section below; (2) the recipe pass on the ~40 drafts — package_items existence flips hosted coverage live (coverageContext has no recipe_review filter), so fence charges would derive from unreviewed recipes.** migrateDrinkMeta has no such gate.

## Push-review residuals (2026-07-18 push gate: fleet + codex/gemini, Claude-verified)

- **BEFORE applyPackageLineup2026's prod run:** extend the script to UPDATE the changed
  packages' `service_packages.includes` prose (and refresh the stale seed copy at
  schema.sql ~602-611). Four public surfaces serve `includes` live (proposals
  publicToken/getOne/public + clientPortal) and no route can write it, so running the
  script as-is leaves client-facing proposal/portal copy on the retired lineup
  (Dewar's/ginger-ale era) while the marketing site shows 2026. (consistency MED.)
- SMS thread completeness: comms-action SMS (proposalResend etc.) goes out via bare
  sendSMS + message_log only — never lands in sms_messages, so the Messages/ClientDetail
  conversation view shows client replies without the outbound touch they answer.
  Dual-write an outbound sms_messages row or move comms SMS onto sendAndLogSms.
  (codex MED, confirmed.)
- ~~planner_version re-backfill obligation~~ MOOT — the v2 wizard shipped in the SAME
  push as the column (2438d62 merged mid-gate and rode the 7/18 push), so prod
  drafts are never mis-versioned. Do NOT run a later re-backfill: it would flip
  genuine v2 drafts onto the legacy wizard and strand their crowd/day-of answers.
  Only real residual: stale cached client bundles for minutes post-deploy; dev-DB
  drafts created 7/18 pre-merge are version-2-on-legacy, dev-only, harmless.
  (addendum review F4.)
- pp2-planner addendum residuals (post-gate, by design of the null-no-delete rule):
  a v2 client who removes all mocktail picks after an admin reset-to-draft leaves
  the previously-flipped pair addon billed until an admin removes it (client
  submits never strip pair rows), and the fast path never reconciles pair rows.
  Admin proposal surface is the reconcile point. (codex C, accepted narrow.)
- HostedDrinksV2 hardcodes "$2.00 per guest" for the pre-batched fence line while
  billing uses live service_addons.rate — carry pair rates in the hosted_coverage
  payload and render from data. (addendum F3.)
- v2 wizard refresh resets to the Welcome step (answers preserved via autosave);
  polish: persist/restore step position. (addendum client F3.)
- Margin sketch (decorative, admin-only): (a) `||` fallbacks treat an explicit 0
  labor-rate/supplies setting or slider value as unset — needs ?? + query-param
  presence checks (gemini); (b) flat-package revenue ignores extra hours while labor
  cost scales with them (codex LOW); (c) PackagesTab fires one margin request per
  package on tab open, each re-reading all of par_items — fold margin_pct into the
  list response or add a batch margins endpoint (perf fleet).
- RecipeEditor small pair (code-review Consider): unit validation dropped from
  rowProblems (server still rejects bad units; defense-in-depth only);
  ClientConversation handleReply setState-after-unmount unguarded (React 18 benign).

## Push-review residuals (2026-07-20 push gate: fleet + codex/gemini, Claude-verified)

**SUPERSEDED 2026-07-20 (same day, lane pp2-lab-fold2):** the off-ledger lab
model below was replaced by Dallas's fold decision — lab additions now fold
into total_price via proposal_addons + `utils/proposalExtrasFold.js` (the
submit path's reprice core, extracted and shared), the open Balance invoice
absorbs them with itemized lines, and only a nothing-owed event gets ONE open
itemized 'Enhancement Lab' invoice at the uninvoiced remainder.
`OFF_LEDGER_INVOICE_LABELS` is now EMPTY; the webhook/refund/lockedTotal
machinery stays wired for a future genuinely-additive label (that rule still
holds: any such label MUST be added to the constant). Lab PUT allowlist =
offered surface (now also minus package-covered slugs); syrup dossier pairing
kept. AT PUSH: re-run `SELECT count(*) FROM invoices WHERE label='Enhancement
Lab'` on prod — it was 0 at rework time, and any invoice minted in the interim
old-model window is auto-zeroed by the first lab reconcile while a Balance
absorbs, but a PAID one would need manual reconcile (payment never rolled into
amount_paid under the old model). OWNER CONFIRM (security advisory, low): a
refund on a paid lab invoice reverses the money but does NOT remove the item
from total_price (Additional Services precedent; removal is the lab's own
remove path) — confirm that is the intended shape.
(Historical record of the superseded model:) Enhancement Lab was briefly
OFF-LEDGER: webhook skipped the amount_paid roll-up, refunds skipped the
decrement, Balance lockedTotal excluded the label.

**Balance-fold PUSHED LIVE 2026-07-20 (6aa9a62, all 5 batch commits deployed; both gates green: money smoke 12 suites + client build).** The cross-LLM push review (codex+gemini) caught a prod-reachable money bug the Claude fleet missed: the fold loaded addon rows via bare `SELECT sa.*`, dropping `proposal_addons.quantity`, so per_hour addons (additional-bartender/banquet-server/barback — live at qty up to 6) repriced as qty 1 and would shave total_price on the first lab save of a native proposal. Fixed via shared `loadRepriceAddons` in submit + lab (+ remainder excludes pay-now Drink Plan Extras, pre-booking gate, contract-syrup preservation); fix commit re-reviewed 3/3 PASS. Deploy re-check ran: 0 'Enhancement Lab' invoices in prod, so the off-ledger→fold model switch had zero rows to migrate.

**Deferred (lab balance-fold follow-ups):**
- Offer-side snapshot race (security Low): the PUT builds `offeredSyrupByDrink`/`contractSyrupSet` from `plan.pricing_snapshot` (read under `FOR UPDATE OF dp` only) while the fold syrup legs use the freshly `FOR UPDATE`'d `proposal.pricing_snapshot`. A concurrent contract-syrup write in the sub-ms window could let that syrup be offered+accepted as lab-owned, re-opening the add-then-remove shave on a later PUT. 0 v2 proposals carry contract syrups today; closing it means moving syrup sanitization past the proposal lock (handler restructure) — not worth it for a zero-exposure race.
- ~~Owner confirm (from 598987d): a refund on a paid lab invoice reverses the money but does NOT remove the item from total_price~~ **RESOLVED 2026-07-24 by the cancel-line-item feature** (docs/superpowers/specs/2026-07-22-cancel-line-item-design.md): admin cancel removes the item AND settles the money in one act (fold-based reprice + overpayment-scoped refund).
- ~~submit.js at 830 lines / lab.js at 721 lines (both over the 700 soft cap) — plan a split on next substantial touch~~ **DONE 2026-07-22** (lane fs-split-drinkplans, behavior-inert moves, 31/31 suites green): submit.js 830→599 (+submitSanitize.js, submitNotify.js), lab.js 721→488 (+labHelpers.js, labListRefresh.js). Both money transactions untouched.
- Lab GET serves the full shelf payload even in not_ready/locked states (client gates rendering; same token audience — API-payload tightening only). (low.)
- Lab invoice find-or-create has no DB unique constraint (plan-row FOR UPDATE covers the realistic path; only the fully-paid branch mints one); optional partial unique index on invoices(proposal_id) WHERE label='Enhancement Lab' AND status IN ('sent','partially_paid'). (database advisory, low.)
- EnhancementLab debounced save timer not cleared on SPA route-change unmount — a pending 500ms save can fire one stray idempotent PUT after unmount (the pagehide flush already covers tab-close). React 18 benign; trivial.

**CLEARED 2026-07-21 — verified moot under the balance-fold (removed from deferred):** off-ledger webhook/refund test (OFF_LEDGER set is empty; lab money rides the standard contract paths their suites cover); planRefund's `EXCEEDS_AMOUNT_PAID` guard "excludes lab dollars" (lab payments now roll into `amount_paid`, so the guard already includes them — verified refundHelpers.js:59 + empty OFF_LEDGER); multi-invoice lab delta negative-final-line (the fold prices the CURRENT additions via buildLabLineItems, not a cumulative breakdown, so remainder ≈ line sum and foldLinesTo can't go negative in the fully-paid branch); GET `computeExtrasBreakdown` round-trip (replaced by sync `priceLabAdditions`, 0 occurrences); desired-state overpay edges (removing paid additions now flows through general proposal-overpay + `reconcileProposalPaymentStatus`, not a lab-specific gap; the approval-race Sentry warn shipped at lab.js:363).

**Deferred (non-lab):**
- Lead-call: a VA leg Twilio PLACED but reports terminal CallStatus='failed' (carrier/route failure; known PH-route quirk) classifies as quiet 'missed' — no alert, not in the attention feed. Option: treat agent-leg 'failed' as fault-class, or include va/admin_call_status='failed' in the feed WHERE. (security advisory.)
- admin/leadCalls attention query has no LIMIT (near-empty at steady state; add LIMIT 200 someday for a Twilio-outage worst case).

---

## Payment history in the admin UI (added 2026-07-21)

There is no way to see individual payments on a proposal. The payment panel shows totals only
(amount paid, balance due); `proposal_payments` rows are never listed and no endpoint returns
them. Surfaced while speccing [notify-client confirmation](superpowers/specs/2026-07-21-notify-client-confirmation-design.md),
where a per-payment "Send receipt" action had nowhere to live and was cut for that reason.

Shape: a `GET /api/proposals/:id/payments` plus a compact table in `ProposalDetailPaymentPanel.js`
(date, amount, type, method, status). Natural home for a per-payment Send receipt action and for
refund attribution, which today is also invisible per-payment.

Ride-along when this is built: `actions.js:286` re-reads the just-inserted payment via
`SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1`
instead of `RETURNING id` on the INSERT. Under concurrent inserts that links the wrong payment
row to the invoice.

## Push-review residuals (2026-07-22, unverified suggestions, deferred)
- googlePlaces.js: out-of-area guard + pick() shortText fallback not routed through normalizeVenueState (two spots; Places flow only).
- proposalEditor: blank guest_count previews at 50 but PATCHes 0; add client-side required validation.
- repriceSummary: already-overpaid + price-increase edge shows consequence lines the server will not perform (copy precision).
- leadCallTrigger: reply_stale/reply_confirmed_late fault rows consume LEAD_CALL_DAILY_CAP headroom (status 'failed' counts as non-skipped); irrelevant at current volume, revisit if cap ever tightens.

---

## Notify-client confirmation residuals (added 2026-07-22)

Shipped across three lanes (notify-server / notify-client / notify-refunds); spec + plan under
docs/superpowers/{specs,plans}/2026-07-21-notify-client-confirmation*. Deferred with reasons:

- **"Do not contact" toggle on the client admin page** writing `communication_preferences`
  (no UI exists today; only the marketing unsubscribe writes those fields). Luva's row is set
  by hand post-deploy (ops step in the plan); the toggle converts that class of rule to
  something visible and reversible on screen.
- **PATCH /api/proposals/:id has no adminWriteLimiter** while now carrying admin-composed
  client sends; the comms send path and even the read-only notify-preflight are throttled
  10/min. Deferred from the lane because bolting a limiter onto the busiest admin endpoint
  risks every existing edit flow and the rate-limiter-bound test debt (TST-3) for a threat
  that needs valid admin credentials. Decide deliberately: add the limiter (and budget the
  tests) or record the parity gap as accepted. (security-review, lane fleet 2026-07-22.)
- **Provider idempotency keys (Resend `Idempotency-Key`, Twilio)** are the precondition for
  any future failed-send Retry; without them a timeout-ambiguous retry can double-send. No
  Retry exists by design (spec: rejected alternatives).
- **`server/utils/groupSend.js` is require-dead** (superseded by the proposalSendGroup comms
  action); delete when convenient.
- **`emailTemplates.rescheduleNotificationClient` is orphaned** (the reviewed-text send
  renders via renderPartsEmail); delete or mark deprecated so nobody resurrects the
  pre-rendered-HTML path the spec rejected.
- **ProposalEditorForm.js at ~790 lines** (soft cap 700): plan a split on the next
  substantial touch.
- **Suppression skip-reasons surface enum tokens** ("Suppressed: channel_disabled.") in admin
  toasts, on both the receipt path (actions.js) and the refund path (refundClientNotify.js).
  Map to human copy at the source, both call sites together. (code-review, lane-3 fleet.)

---

## Coverage language in signed documents (added 2026-07-25)

Surfaced while speccing [on-site service extension](superpowers/specs/2026-07-25-service-extension-design.md).
That spec puts the insurance sentence on the client's extension terms screen and in the
staffer's decline text, but both only reach someone who already came to the system. The client
who was always going to hand a bartender $60 in cash never opens either one. The place to catch
that case is upstream, in documents both sides agree to before anyone is negotiating in a
kitchen at 10pm.

Three copy changes, each to a document a real person signs or receives. Not code, and each
wants Dallas's eyes before it ships:

- **Event services agreement** (master contract at sign-and-pay, shipped 2026-06-05): state that
  bar service runs to the contracted end time, that additional service time is arranged through
  Dr. Bartender, and that service arranged privately with a bartender is not covered by DRB's
  $2 million liquor liability policy.
- **Pre-event client email**: one sentence of the same, arriving before the event rather than
  during it.
- **Contractor agreement**: the staff-side mirror. Serving past the contracted end time without
  a system greenlight is not DRB work and is not covered by DRB insurance, and bartenders may
  not accept payment directly from a client for service time.

Blocked on: Dallas confirming the coverage position with the broker in writing. The exact
wording should follow that answer rather than lead it.

---

## Deferred from the 2026-07-26 push review (cancel-line batch)

The fleet's blocking findings were fixed before that push (three refund root
causes in `05c38bb0`, the UI mis-bind in `e1eb303e`). These are the ones judged
real but not worth expanding that batch for. Severity as the reviewers rated
them; none is a money-wrong path.

**Refunds: overpayment never clears (REAL, unfixed, do not re-attempt naively)**
- Refunding a TRUE overpayment lowers `total_price` AND `amount_paid` by the
  same amount, so the proposal stays overpaid by exactly the same figure and the
  contract silently shrinks on every attempt. Measured 2026-07-26: total 2300 /
  paid 2500, refund $200 → total 2100 / paid 2300, still overpaid $200.
- A fix WAS written and REVERTED before shipping. It derived the excess as
  `amount_paid - total_price` and spared that portion from lowering the total.
  That premise is wrong in this schema: Drink Plan Extras (syrup-only pay-now,
  `submit.js` fast path) and manual-label invoices roll into `amount_paid` and
  never into `total_price`, so the difference counts them as overpayment and
  then subtracts them twice. Two independent reviewers reproduced it: a $150
  goodwill refund on a 2000/2150 proposal left the total at 2000 instead of
  1850, and a $1100 refund on a deposit-stage 1000/1300 proposal left a $100
  phantom balance the autopay scheduler would have charged. It also made the
  multi-split loops order-dependent.
- Prod exposure is currently ZERO: the only proposal with
  `amount_paid > total_price` (599, $60) is a paid Drink Plan Extras invoice,
  not an overpayment. That is why this is logged rather than fixed under push
  pressure.
- The candidate fix, if this is ever picked up: net out still-outstanding
  non-contract invoice money before deriving the excess, read BEFORE the invoice
  walk decrements it — `excess = paid - total - Σ amount_paid on non-CONTRACT_LABELS
  invoices (status <> 'void')`. Verify it against the multi-split loops in
  `proposals/cancel.js` and the cancel-line route for order-independence, and
  against the RC1 fixtures in `refundHelpers.scope.test.js`.
- Related, same cause: after a FAILED cancel-line refund the dialog sends the
  admin to the payment panel, which can only issue `'contract'` scope and would
  therefore lower a total the fold already corrected. Until the above is fixed,
  the safe recovery on that path is a manual Stripe-dashboard refund (the
  `charge.refunded` webhook reconciles it) rather than the panel.

**Cancel-line feature**
- `matchCancelTargets` (the ambiguity refusal and amount corroboration) has no
  test: the client has no test runner, and the new server-side test only pins
  the override target's label/amount. The collision case is reproducible with a
  throwaway node script against the exported function.
- `POST /:id/cancel-line/preview` runs the whole mutation (proposals FOR UPDATE,
  addon writes, drink_plans FOR UPDATE, invoice refresh + delta reconcile, shift
  sync) and then ROLLBACKs. Side-effect-free outside the DB and connection-clean,
  but a nominally read-only endpoint holds exclusive row locks for the full core,
  so a concurrent `charge.refunded` webhook on the same proposal blocks behind an
  admin previewing a change they may never make. Each preview also burns
  `proposal_activity_log` / `invoice_line_items` SERIAL values. (low)
- Lock-order inversion vs `drinkPlans/lab.js`: lab takes drink_plans then
  proposals; `applyLineItemCancel` takes proposals then drink_plans (on the addon
  and syrup kinds). A client saving the Enhancement Lab while an admin cancels a
  lab-owned addon can deadlock; Postgres aborts one, both roll back atomically,
  no corruption, admin sees a 500. Widened by the preview endpoint running the
  same core. (low)
- A gratuity-removal refund passes no `gratuityCents`, so `proposal_refunds
  .gratuity_cents` is NULL for the one cancel kind the column exists to describe
  (the cancel-event flow does populate it). Audit fidelity only. (low)
- The preview's `locked_invoices` line promises "a locked invoice for $X stands",
  but on the fully-paid path the overpayment refund deliberately drops that same
  locked invoice's `amount_due`. Not a ledger error; the stated consequence is
  just wrong for exactly the case that fires a refund. (low)
- RC4 (adopt the caller's own pending row by id) was applied to `refundExecute`
  and the stale-pending sweeper, but NOT to the `charge.refunded` webhook, which
  also has the row id available on `refundObj.metadata.proposal_refund_row_id`
  (stamped by `refundExecute`). Same failure shape: a stranded same-amount
  pending row of the other scope can be adopted instead. (low)
- The by-id adoption lookup checks only `id + status + stripe_refund_id IS NULL`;
  it dropped the corroborating `proposal_id` / intent / amount predicates. Safe
  today (only `refundExecute` and the sweeper pass an id, always their own row),
  but a future caller passing a wrong id would reconcile against the wrong
  proposal. Cheap to harden. (low)

**Add-on quantity semantics (2026-07-26 lane)**
- CORRECTION: a code comment in `lineItemCancel.js` (the post-fold sync) claimed
  `proposal_addons.quantity` holds "the RAW unit count", and `ARCHITECTURE.md`
  described it as fractional hours. Both are wrong; it holds the engine's OUTPUT
  display quantity. See `server/utils/addonQuantity.js` and the rewritten
  ARCHITECTURE schema note. The 2026-07-24 checkpoint change that stopped
  writing `quantity` in the post-fold sync was made on that wrong belief and has
  been reverted.
- Not fixed, same family: `server/utils/changeRequests.js` is a THIRD reader that
  disagrees with the column. `priceProposedState` (:57-69) re-prices the
  proposal's existing add-ons with `safeAddonQty(quantities[id])`, which returns
  1 for `undefined`, so a client-portal change-request price preview silently
  drops any count above 1 and under-quotes; `buildDiff` (:129-137) compares the
  stored OUTPUT against a proposed INPUT count. The diff half is unreachable
  today (the v1 client form exposes no add-on editing, so `addon_ids` is never
  sent) but the preview half is not. Left out of the 2026-07-26 lane to keep it
  narrow. The fix is the same one: route it through `addonQuantity.js`.
- FIXED 2026-07-26, same family, opposite direction: for `per_guest` add-ons the
  fold could not recover the admin's unit count, so one sold at count 2 repriced
  as count 1 and UNDER-billed. The lane originally deferred this on the basis
  that no live proposal carried such a row. That basis was checked against prod
  mid-lane and was FALSE: proposal 482 carries a Pre-Batched Mocktail at count 2
  (`quantity 50`, `rate 2.00`, `line_total 200.00`), reachable through the admin
  editor's ordinary quantity stepper (`pre-batched-mocktail` is in
  `QUANTITY_CAPABLE_SLUGS`). The count is now recovered as
  `line_total / (quantity x rate)` from the row's OWN frozen rate, matching the
  client inverter (`formState.js:92-98`). `per_guest_timed` is deliberately still
  excluded: its `line_total` carries an extra-hours term, so the division does
  not hold (prod 464 reads 1.250 for a genuine count of 1).
- `REPRICE_ADDON_SQL` does not select `pa.variant`, so a no-op fold drops the
  variant from `snapshot.addons[]` and the line renames itself: a
  `champagne-toast` sold as `non-alcoholic-bubbles` reverts to "Champagne Toast"
  on the client-facing snapshot, and the next writer persists `variant = null`
  off that snapshot. No money moves, but it is the same "a no-op fold must
  change nothing" family this lane is about, and the fix is one column in a
  SELECT this lane already widened (Task 3 review, 2026-07-26).
- A client drink-plan submit or lab save re-prices an existing add-on line at the
  CURRENT catalog rate, because both upserts recompute `line_total` from
  `service_addons.rate` rather than the rate frozen on the row. A catalog price
  rise therefore reaches proposals that were sold at the old price. Pre-existing
  and deliberately unchanged on 2026-07-26; the lane only stopped the row's
  `rate` column from disagreeing with its own `line_total`.
- A client drink-plan submit can reset an admin-negotiated add-on quantity. The
  upsert loop in `submit.js` honors any active slug in the client payload
  (`return true; // user-added addon`) and its `ON CONFLICT DO UPDATE` overwrites
  `quantity` with the count it just computed for one unit. A payload naming a
  slug an admin had already set to 3 knocks it back to 1. Pre-existing, not
  reachable through the planner UI (it offers no staffing add-on), and untouched
  by the 2026-07-26 work, which only changed what that statement writes, not
  which rows it is allowed to write.
- A partial removal of a LAB-owned add-on leaves the `labAdded` entry in
  `drink_plans.selections`, so the client's next Lab save re-upserts it at the
  lab's own quantity and undoes the partial removal. Narrow: the lab creates
  its add-ons at count 1, so a partial removal is only possible if an admin
  first raised the quantity in the editor.
- `computeCancelTargets` enumerates targets for a package-less proposal, but
  `applyLineItemCancel` throws `NO_PACKAGE` for it, so every button 409s.

**Add-on quantity semantics: what the lane's own task reviews parked (2026-07-26)**

Raised by the per-task reviews INSIDE that lane, judged real, and left out to keep
each task's footprint honest. Written down here because the lane's ledger is not
tracked and went away with its worktree.

- **Latent 2x on `additional-bartender` the moment that catalog row acquires a
  `minimum_hours`.** Three reviewers reported this family independently, in
  three different files: Task 1 closed its instance inside `storedToInputCount`,
  Task 4's is the next bullet, Task 5 found this one in the pre-fold write. The
  sites agree on every row that exists today and disagree only here. The reader
  (`server/utils/addonQuantity.js`, `effectiveHoursFor`) dispatches on the SLUG
  first and divides by RAW `event_duration_hours`, matching the engine's bespoke
  branch (`pricingEngine.js:387-405`, which multiplies by raw hours and never
  looks at `minimum_hours`). The two pre-fold writers
  (`drinkPlans/submit.js:318` and `drinkPlans/lab.js:303`) bypass the module
  entirely and call `calculateAddonCost`, whose `per_hour` branch stores
  `Math.max(durationHours, minimum_hours) x count` (`pricingEngine.js:166-169`).
  Trace, 2-hour event, one bartender, `minimum_hours` hypothetically 4: the
  pre-fold write stores 4, the fold recovers 4 / 2 = 2, the engine bills two
  bartenders, the post-fold re-sync persists 2 x 2 = 4, and the row LATCHES at
  two permanently. The dollar figure is the one place it does not announce
  itself (four bartender-hours is exactly what a 4-hour minimum was asking for,
  so the invoice line reads plausibly); the damage lands in the staffing
  channels instead. The gratuity staff count doubles
  (`pricingEngine.js:369` sums the recovered count, `:437` folds that sum into
  `gratuityStaffCountFrom`), `eventCreation.addonHeadcount` divides the stored 4
  by the raw 2 and reports two bartenders for the one add-on line, and
  `syncShiftsFromProposal` therefore creates a second shift for a one-bartender
  order. The trigger has precedent: `schema.sql:777` is literally
  `UPDATE service_addons SET minimum_hours = 4 WHERE slug = 'banquet-server';`.
  The agreed fix, and the reason this is logged rather than patched in place: a
  shared `countToStored` inverse living beside `storedToInputCount` in
  `addonQuantity.js`, called by the two pre-fold writers in place of
  `calculateAddonCost` for that slug. A fourth local patch is how the
  definitions drifted apart in the first place. (Task 1, 4 and 5 reviews.)
- **The cancel-line write-back dispatches on `billing_type` while the reader
  dispatches slug-first**, same family, same fix.
  `lineItemCancel.js:499-501` restores a partially-removed row as
  `storedIsInputCount(row.billing_type) ? remainingCount : remainingCount x
  effectiveHoursFor(row, durationHours)`. If `additional-bartender`'s catalog row
  were ever edited off `per_hour`, `storedIsInputCount` would return true and the
  write would store a raw count into a column the slug-first reader still divides
  by hours. The reviewer verified it is unreachable through any application path
  today (no route anywhere updates `service_addons`) and also verified that in
  the hypothetical the post-fold sync does NOT self-heal it, it cements the wrong
  value. Closed by the same shared `countToStored` inverse. (Task 4 review.)
- **The `additional-bartender` cancel target can bind to the `num_bartenders`
  OVERRIDE row's amount, but only against a STALE snapshot.**
  `computeCancelTargets` (`lineItemCancel.js:175-182`) scans
  `pricing_snapshot.breakdown` for labels starting "Additional Bartender" and
  deliberately takes the LAST when there is more than one, because the engine
  emits the override row first (`pricingEngine.js:458-482`) and the add-on rows
  after (`:483-505`). The lone-match branch (`matches[0]`) is the hazard, and it
  needs all three of: the override row present, the add-on row ABSENT, and
  `rb.removable` at 0 so no competing `extra-bartender` target is emitted
  (`:211`). A fresh snapshot carries both rows whenever both exist, so it always
  picks correctly; only a stale snapshot can reach the branch. Display-level,
  with a mis-click risk once the client's amount corroboration binds the add-on's
  remove button to the override's breakdown row. Suggested guard: skip the
  lone-match fallback when `snap.staffing.extra > 0`. (Task 6 review.)
- **No automated coverage of the DEFAULT-rails `loadPaymentsWithRemaining`
  call.** Every DB exercise of that SQL now runs through the cancel-line route
  with the WIDE rails (`CANCEL_LINE_REFUND_RAILS`). The admin panel path
  (`routes/stripe.js:463`, which takes the default `PANEL_REFUND_RAILS`) has no
  suite at all, and `refundHelpers.test.js` / `refundHelpers.splits.test.js`
  exercise only the pure planners, never the query. The 2026-07-26 refactor from
  a hardcoded `IN (...)` list to `= ANY($2::text[])` was verified
  behavior-preserving by reading the schema (`payment_type` is
  `VARCHAR(30) NOT NULL`, so no NULL can change the predicate) rather than by a
  test. A two-line unit test asserting the default call EXCLUDES a seeded
  `drink_plan_extras` row would pin it. (Task 6 review.)
- **`lab.js`'s pre-fold upsert and post-fold re-sync are pinned only by prose.**
  Both (`lab.js:303-314` and `:379-386`) are near-duplicate hand-copied logic of
  their `submit.js` twins (`:318-336` and `:424-431`), not shared code, so they
  can drift; the lab side's only regression cover is a comment pointing at
  `submitOverride.test.js`. The scoping in particular is a live path: an
  admin-seeded `mocktail-bar` at count 2 plus a client Enhancement Lab save would
  be HALVED if `lab.js`'s `if (!touchedAddonIds.has(entry.id)) continue;` were
  ever dropped, because `storedToInputCount` returns null for `per_guest_timed`
  and the fold then reprices it at count 1. The submit twin's own cover is
  partial too: deleting its re-sync loop outright leaves both new tests green,
  because the pre-fold upsert already writes the right figures at 175 guests /
  4 hours. The re-sync's distinguishing value is `additional-bartender`'s
  sub-100-guest gratuity surcharge and `per_staff`'s totalStaff basis, and that
  fixture zeroes the surcharge, so the "belt" half of belt-and-braces is
  untested. (Task 5 review.)
- **The two dispatch sites read `billing_type` off different tables.**
  `withRepriceQuantities` (`proposalExtrasFold.js:82-90`) dispatches on the
  CATALOG row, because `REPRICE_ADDON_SQL` selects `sa.*`; both cancel-line
  queries (`lineItemCancel.js:107` and `:458`) dispatch on the FROZEN
  `pa.billing_type`. A row whose catalog type was flipped after it was sold
  therefore reads as two different billing types at once: flipped INTO the
  count-less set, the cancel-line side still offers a quantity picker while the
  fold refuses to recover a count at all, and flipped out of it the reverse. The
  partial-removal write-back at `:499` can therefore disagree with the fold's own
  re-read of that same row two statements later (`:505`), inside one
  transaction. Catalog flips are not hypothetical: `schema.sql:785` and `:788` did
  exactly that to `parking-fee` and `garnish-package-only`. Deciding which source
  is authoritative is the actual fix; today they simply differ.
- **Two docstring over-reaches in `addonQuantity.js`**, both cheap, design
  unaffected in each case. The exclusion list's stated rationale, "billing_type is
  a bare VARCHAR(20) with no CHECK" (`:33`), is true of
  `proposal_addons.billing_type` (`schema.sql:866`) but false of
  `service_addons.billing_type` (`schema.sql:641`, a six-value CHECK), and
  `service_addons` is the column the reprice SELECT actually delivers. And
  `effectiveHoursFor`'s claim that `eventCreation.js` encodes "the same split"
  (`:48`) glosses over `eventCreation.js:45` hardcoding
  `STAFFING_ADDON_MIN_HOURS = 4` rather than reading the catalog, which makes it a
  FOURTH site that agrees with the other three only by coincidence. (Task 1
  review, plus the lane's whole-branch review.)

**Cancel-line admin UI**
- After a removal the payment panel's invoice list still shows the pre-removal
  amount due until a manual reload: `invoiceRefreshKey` is panel-private and
  `onDone` cannot reach it, so the refund history refreshes while the invoice
  half does not. (medium)
- Two Escape listeners fire for one keypress (NotifyConfirmModal binds document,
  the dialog binds window, neither stops propagation), so Escape at the "email
  the client?" prompt unmounts the whole dialog and loses the typed reason and
  loaded preview instead of stepping back one level. (low)
- `ProposalDetail`'s unmatched-targets strip is guarded only by `cancelTargets`,
  not by the snapshot, so a proposal with a null/legacy `pricing_snapshot` shows
  an empty pricing card followed by every target as a ✕ button. EventDetailPage
  wraps its whole card in `snapshot?.breakdown &&` and does not have this. (low)
- `EventDetailPage.loadProposal`'s catch sets `err`, which early-returns the
  error view, so a blip on the post-removal refetch destroys the done view (with
  its refund confirmation and any manual-return warning) mid-flight.
  ProposalDetail only toasts. (low)
- `loadCancelTargets` has no in-flight cancellation guard, so navigating between
  proposals without unmount can bind the previous proposal's targets onto the new
  snapshot by label; the preview then 404s or previews a line the admin did not
  click. (low)

**Stripe payout mirror (Sentry-triage lane, same batch)**
- Acknowledged payout lines are permanently excluded from the re-match loop AND
  from the unmatched count, and the backfill UPDATE replays on every boot, so
  hand-NULLing `acknowledged_at` is re-stamped at the next deploy. A future
  historical-payment import (the CC-clients import is exactly this shape) could
  make one matchable and it would never be re-matched or surfaced. Escape is a
  manual `matchLine(id)`, which is not reachable from the admin UI. (low)
- `StripePayoutsTab`'s In-transit table and "Unmatched only" empty state were not
  made acknowledged-aware. Inert today (the backfill predicate requires
  `payout_id IS NOT NULL`, so no acknowledged line can reach the pending array).
  (low)
- The `proposal_refunds_total_scope_check` DO block matches `pg_constraint` on
  `conname` alone rather than `(conrelid, conname)`. Harmless with this name;
  would false-positive if another table ever took the same constraint name. (low)

**Overpayment netting / invoice provenance (2026-07-28 push review)**

Context: `applyLineItemCancel`'s `overpaymentCents` feeds `planOverpaymentSplits`,
which fires real Stripe refunds. It must be "money paid ABOVE what is now owed on
the contract". Three implementations have each been wrong on a different real prod
row: un-netted (over-refunds paid syrup/manual money), netted by
`∉ CONTRACT_LABELS` (under-refunds, because Additional Services and Enhancement
Lab money IS in `total_price`), and the shipped one below. The shipped version is
correct on every currently reachable row and is kept for that reason, but it is
not correct in general.

ROOT CAUSE, and the fix that closes both gaps at once: **an invoice does not
record whether its money is inside `proposals.total_price`.** Every classifier is
therefore a proxy. Add that fact to the row (a boolean set at mint time by each of
the six `createInvoice` callers, plus a hand backfill of the few ambiguous
existing rows) and `sumOffContractPaidCents` becomes a single column read, correct
by construction. This is the SAME root cause as the pulled invoice-derivation
rewrite (see `docs/superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md`
post-mortem) — do them together, provenance first.

- **Free-text labels that carry contract money are netted out (under-refund).**
  `invoiceExtras.IN_TOTAL_PRICE_LABELS` is a closed list of the five labels code
  generates, but `POST /api/invoices/proposal/:id` writes `label.trim()` with no
  constraint and `PATCH /api/invoices/:id` can rename any unlocked invoice. Both
  free-text-labelled PAID invoices in the entire prod ledger are contract money
  (`INV - Balance` $250 on prop 596; `Gratuity Balance` $100 on prop 547), so the
  base rate of the "bespoke label ⇒ off-contract" assumption is 0 for 2. NOT
  reachable today: 596 is `completed` (cancel blocked) and 547's invoice is still
  unpaid, and the netting only counts `amount_paid > 0`. Becomes live the moment
  someone pays prop 547's $100. (medium)
- **`reconcileOpenDeltaInvoices` destroys the fold marker it depends on.**
  `lineItemCancel.js` step 6 replaces an unlocked `sent`/`partially_paid` Drink
  Plan Extras invoice's line items with one synthetic `source_type: 'manual'`
  line whenever its amount moves, deleting the `source_type = 'addon'` /
  bar-rental rows. Those rows are the ONLY record of whether that invoice folded
  into `total_price`, read by `extrasLinesAreFolded` for the netting AND by
  `voidExtrasInvoiceWithReconcile`'s comp reconcile (which has depended on them
  since before this work). The deletion is committed, so one cancel-line
  misclassifies that invoice permanently in both consumers. Not reachable on any
  current prod row (the only paid extras invoice, prop 599, is locked and `paid`,
  which step 6 skips). Independent of the netting; it is a cancel-line defect.
  (medium)
- Third option if the provenance work is deferred: stop computing this at all.
  Show the admin the components (paid, new total, each non-contract invoice and
  its amount) and let them enter the refund figure. It is the only version with
  no wrong answer, because it stops guessing. (option, not a bug)

**Staff event-details revival (2026-08-03 push review residuals)**

All non-blocking; the blockers found in review were fixed pre-push.

- `ShiftDetail.js:~590` CustomMenuCard logo renders through a bare `<img src>`
  pointing at the auth-required `GET /api/beo/:id/logo`, which never carries the
  JWT, so the logo silently 401s for staff. Pre-existing on main before the
  revival; fails closed. Fix: blob-fetch through api.js like BarMenuCard. (low)
- `server/routes/eventDetails.js:89-91` legacy proposal-less shifts hardcode
  `approved_by_role: {}` and `cover_requested_at: null`, so a filled manual
  shift renders fully open ("Request this shift" instead of "Join waitlist")
  and an active cover never shows its chip. One aggregate query closes it.
  Flagged independently by the fleet and codex. (low)
- `ShiftDetail.js` fetches the full cocktail + mocktail catalogs on every
  detail-page view; a module-level cache would drop 2 requests per view. Also
  the file is at 795 lines (soft cap 700): split candidate. (low)
- `server/routes/proposals/menuPrint.js:26` duplicates fileValidation.js's
  PDF/JPEG/PNG magic bytes because it needs the canonical extension; a
  sniff-to-extension helper in fileValidation.js would keep one copy. (low)
- `server/utils/eventDetailsPayload.js:66` selects `p.status`,
  `p.balance_due_date`, `p.client_id` it never returns (attractive nuisance in
  a redaction-sensitive SELECT), and the six-query fan-out is not one snapshot
  (a drop committed mid-fan-out can transiently disagree between
  `viewer.is_assigned` and `my_request_status`; heals on refetch). (low)
- `server/routes/eventDetails.js` menu-print proxy emits an ETag but never
  checks `If-None-Match`, so revalidation always re-downloads. (low)
- On an in-place shift-A→shift-B nav across different events, stale `details`
  can flash the "no longer on the schedule" card until B's fetch lands
  (details is never cleared on shiftId change; pre-existing shape). (low)

## TT first-reply push-review residuals (2026-08-03, fleet on 61abacf3/7161e8bf/e3e16899)

- `thumbtack_leads.created_at` is nullable while the offer query leans on it
  in four predicates and the sweep's retirement arm; a NULL row would sit
  `pending` forever, invisible to both. Zero such rows exist today. One
  idempotent line closes it: `ALTER TABLE thumbtack_leads ALTER COLUMN
  created_at SET NOT NULL;` (db-review, low)
- `server/routes/thumbtackAgent.js` crossed the 700-line soft cap (~790 after
  the 8/06 delay + clamp work);
  split candidate: the first-reply queue section into
  `thumbtackAgent.replies.js` behind the composition router. (low)
- Agent post-send reports (`clickedSend` path) go through `apiReport`, which
  gives up on any 4xx with no legacy-reason downgrade; only send_unverified
  (legacy) flows there today, but a future post-send reason added agent-side
  before the server enum would 400 silently. Route it through the downgrade
  wrapper when one is ever added. (consistency, low)
- `FIRST_REPLY_NIGHT_JITTER_END_HOUR` default 8 is coupled by comment to
  `CALL_WINDOW_START_HOUR = 8` in `leadCallTrigger.js`; nothing enforces it
  and no test pins "daytime day→night downgrades still offer immediately"
  if either moves. (consistency, low)

## Service-extension revenue reporting (added when the feature shipped)

Decision record from plan Task 18 (spec §12 of
`docs/superpowers/specs/2026-07-25-service-extension-design.md`), verified
against the merged ext-* lanes on 2026-08-04. Extension money lives in
`proposal_payments` and `invoices` and NEVER in `proposals.amount_paid` or
`total_price`: the 'Service Extension' label is the sole member of
`OFF_LEDGER_INVOICE_LABELS` (`server/utils/proposalMoneyShared.js:47`), and the
webhook's invoice branch skips the `amount_paid` roll-up for it
(`server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js:318-355`) while
the unconditional `proposal_payments` insert (`:86`) still records the payment.
Consequence: every payments-sum surface includes extension revenue and every
`amount_paid` / `total_price` surface excludes it. Neither is a bug; this table
is the record of which is which, per surface.

| Surface | File | Basis | Extension revenue | Verdict |
|---|---|---|---|---|
| Money Board "Collected" tile (financials summary) | `server/routes/proposals/metadata.js:189-191` + `metricsQueries.refundsInWindow` | succeeded `proposal_payments` minus succeeded `proposal_refunds` (plus frozen CC leg) | INCLUDED | Correct: Collected means cash in, and extension cash is real. |
| Dashboard-stats headline, basis = paid | `server/utils/metricsQueries.js:283-312` (`qMoney` paid branch) | payments minus refunds | INCLUDED | Correct, same reasoning. |
| Dashboard-stats headline, basis = booked / scheduled | `metricsQueries.js:313-325` | `SUM(total_price)` | INVISIBLE | Correct: these lenses measure contract value, and extension money is off-contract by design (spec D12). |
| Outstanding tile + balance-due list filter | `metricsQueries.js:327-337` (`qOutstanding`); `server/routes/proposals/list.js:145` | `total_price` minus `amount_paid` | INVISIBLE on both sides | Correct: an extension can never create or offset contract balance due; an unpaid extension invoice is voided by the sweep, never owed. |
| Revenue monthly chart | `metricsQueries.js:344-421` (`qRevenue`), rendered by `RevenueChartCard.js` | `paid` series = payments minus refunds; booked / scheduled value series = `total_price` | paid series INCLUDES, value series excludes | Correct both ways; the paid line is where extension money shows up by month. |
| Funnel metrics (`qSent` / `qAccepted` / `qLostValue` / `qPipelineOutstanding`) and financials `avgEvent` | `metricsQueries.js:195-280`; `metadata.js:218` | `SUM(total_price)` | INVISIBLE | Correct: the sales funnel values contracts, not mid-event add-on cash. |
| Metrics split (Funnel card Split seg) | `server/routes/proposals/metricsSplit.js:73,87` | `SUM(p.total_price)` on both axes | INVISIBLE | Correct; verified it sums `total_price` only, matching the prior audit's claim. |
| Financials recent-payments table | `metadata.js:162-188` | raw succeeded `proposal_payments` rows | rows APPEAR, linked to the extension invoice via the `invoice_payments` LATERAL | Correct: the ledger view shows the real payment. |
| Clients lifetime value (ClientsDashboard LTV column + proposal-create client picker) | `server/routes/clients.js:38` | `SUM(p.amount_paid)` over paid-status proposals | INVISIBLE | Leave as is with a known gap: a client's true spend is understated by exactly their extension money (drink-plan extras and Additional Services DO enter `amount_paid`, so extensions are the only miss). Acceptable because LTV is a ranking and reference column, not accounting. If it ever matters, the fix is a per-client sum of succeeded `proposal_payments` minus refunds. |
| Stripe payout ledger + matching | `server/routes/stripePayouts.js:35-62`; `server/utils/stripePayoutSync.js:148-170` | Stripe's own balance transactions | INCLUDED automatically | Correct and reconciles: an extension charge matches its proposal via `stripe_payment_intent_id` against the `proposal_payments` row the webhook always inserts. |

Refund symmetry: an extension refund is issued directly in Stripe (spec §12);
the `charge.refunded` webhook reconciles it into `proposal_refunds`, so
Collected nets it like any other refund while `amount_paid` stays untouched,
which is exactly right for an off-ledger payment.

**WARNING (spec §12): do NOT "fix" any of these exclusions by rolling extension
payments into `amount_paid`.** That reintroduces the spec §2 landmine: it would
falsely satisfy the funded-gratuity gate and the auto-complete gate, and it
breaks the `total_price` / `amount_paid` contract-ledger invariant every refund
and cancel path depends on. Any surface that ever needs extension revenue gets
it from `proposal_payments` / `invoices` sums, never from `amount_paid`.

**`event_duration_hours` consumers (spec §12), code-level verification.** The
column now moves mid-event, so each reader was checked for a stale cached copy.
None found:

- **Staff event details / admin BEO**: `server/utils/eventDetailsPayload.js:63`
  selects `p.event_duration_hours` live per request (returned at `:290`);
  `server/routes/beo.js` delegates entirely to `buildEventDetailsPayload`, so
  both the shift-keyed staff page and the proposal-keyed admin route read the
  post-bump value.
- **Calendar feed** (`server/routes/calendar.js`): feeds from
  `shifts.start_time` / `shifts.end_time` (the `s.*` selects at `:357` / `:377`
  / `:501`), not the proposal column. `settleExtension` rewrites the single
  shift's `end_time` and `event_duration_hours` in the same transaction as the
  proposal bump (`server/utils/serviceExtensionSettle.js:159-167`), and the
  `update_shifts_updated_at` trigger (`schema.sql:308`) bumps `updated_at`, so
  the iCal SEQUENCE / LAST-MODIFIED advance and subscribed calendars refresh.
  On a multi-shift event the settle deliberately rewrites no shift and fires
  the `multi_shift` admin alert instead, so the calendar shows the old end time
  until the admin edits the right shift by hand: known, alerted, by design.
- **Client portal**: `server/routes/clientPortal.js:86` selects
  `p.event_duration_hours` live in the proposal-detail allowlist.
- **DEFERRED to the orchestrator's post-merge walkthrough**: the in-app browser
  pass over these surfaces with a settled extension on a dev event, plus
  confirming the Money Board and the events list render that event without
  error. Code-level verification above is done; the eyeball pass is not.

**Deferred follow-ups from the ext-* merge gates** (recorded here because the
lanes' review ledgers died with their worktrees; all verified against the
merged code 2026-08-04):

- **Webhook pre-ack settle-tail latency (judgment call, accepted).** The whole
  extension settle tail runs synchronously inside the webhook handler after
  commit and release but BEFORE the 200 to Stripe
  (`paymentIntentSucceeded.js:649-765`): settle transaction, payroll hours,
  possible accrual recompute, Twilio + email notifies, finalize stamp. A slow
  tail can push the delivery past Stripe's timeout, marking it failed and
  triggering a retry; the retry is harmless (`ON CONFLICT` + `isFirstDelivery`
  make it a no-op) but the dashboard shows failed deliveries and the first
  tail keeps running. Accepted at current volume; the fix shape if latency
  alerts appear is queueing the tail (the heal already covers a crash mid-tail).
- **Heal gate: counters vs line existence (narrow crash window).** The heal
  re-runs accrual only when `applyExtensionHours` reports touched lines
  (`server/utils/serviceExtensionSweep.js:208`). A crash in the webhook tail
  AFTER `applyExtensionHours` applied the hours but BEFORE
  `accruePayoutsForProposal` ran leaves the row unfinalized with the hours
  already correct, so the heal's re-run no-ops with all counters at zero, skips
  the accrual recompute, and the extension gratuity addend stays at $0 until
  anything else recomputes accrual for that proposal. Fix shape: gate the heal's
  recompute on payroll-line existence for the proposal, not on this run's
  update counters.
- **Settle-tail extraction next time `paymentIntentSucceeded.js` grows.** The
  file is at 850 lines (soft cap 700); the extension tail (`:649-765`) is the
  natural first extraction, matching the `stripeWebhookHandlers/` split
  pattern. The hard-cap ratchet forces this at the next substantial addition
  anyway.
- **Dead `settle_on_closed_event` subject entry.**
  `server/utils/serviceExtensionNotify.js:251` defines the PROBLEM_SUBJECTS
  entry but no caller ever passes that kind (verified by grep). Delete it, or
  wire the alert it was minted for (a settle landing on a completed or archived
  event) if that check is still wanted.
- **Admin panel renders no loading skeleton (cosmetic, deliberate).**
  `ServiceExtensionPanel.js:137-143` returns null on first load (merge-gate
  perf finding: most events have zero extensions, so a skeleton card would
  flash and shove the cards below it on nearly every event view). Nuance vs
  the merge-gate note that called the skeleton class "unused": `.sp-skeleton`
  (`index.css:19431`) IS still used by the two staff surfaces
  (`RequestMoreTime.js:70`, `ShiftDetail.js:639`); only the admin-panel usage
  is gone, and the CSS comment at `index.css:19430` still says "+ admin
  panel", which now overstates. Trim the comment whenever that block is next
  touched.

**Gratuity election, push-review note (2026-08-04)**
- `stripeCreateIntent.js` mints a second identical intent when a pending
  election-bearing intent matches the request's amount AND election exactly
  (documented in-code as accepted; matches prior behavior; damage shape =
  visible double payment, refund one). Codex push-review suggests the safe
  hardening: when metadata AND amount match the CURRENT request exactly, the
  election is not stale, so returning the existing intent's clientSecret is
  safe and removes the double-charge window. Behavior change on a money path;
  do it deliberately, with the gratuityApply suite extended. (low)

- `server/utils/balanceReminderScheduling.test.js` hardcodes `balance_due_date = '2026-07-15'`; the
  function skips past-due dates, so the suite has been red in whole-tree serial runs since ~7/16.
  Re-fixture with rolling dates (Chicago local frame per test law). Found by the display-name
  Task 14 gate, 2026-08-04. (med-low)
- `server/utils/payrollDisputeNotify.test.js:323` asserts elapsed < 400ms; observed 477ms under
  serial-suite load, 12/12 green in isolation. Loosen the bound or restructure the timing
  assertion. (low)
- Whole-tree serial suite runs need `NODE_ENV=test` (calcom.test.js + drinkPlanConsult.test.js
  self-guard and abort at module load without it) — plan gates citing "run the full server
  suite" must carry the env var; display-name plan rev 3.3 records it. (note)

## Push-gate residuals 2026-08-05 (display-name + seniority + sms-optin batch — all non-blocking, batch pushed)

- `scripts/testdb-smoke.js` cannot fail on a failed schema statement: `initDb()` logs+Sentry's
  per-statement errors and RESOLVES, so the child exits 0 and the gate passes while a
  constraint silently didn't build. Make the smoke child assert zero unexpected failures.
  The gate's strongest claim is currently unenforceable. (med, gate hardening)
- Post-commit `refreshDisplayName` is try/catch-contained in contractor.js + agreement.js but
  UNCONTAINED at admin/users.js:382, me.js:183, staffPortal.js:343/345, contractorTipPage.js:78 —
  a transient refresh failure 500s a save that already committed. Mirror the contractor.js
  containment at all five. (low; also flagged by codex)
- `refreshDisplayName` SELECT-then-UPDATE is unlocked: two concurrent name saves for the SAME
  user can persist a stale display_name (adjudicated acceptable at checkpoint 1; `--check`
  detects, next save heals). Optional: `SELECT ... FOR UPDATE` inside a tx. (low)
- `sanitizeProfile` (contractor.js) policy drift: `preferred_name_reviewed_at` (admin ack stamp)
  rides the staff self-profile response; the sanitizer's own header says admin-only columns
  belong in the destructure. One-word fix. (low)
- `email_leads` unique index is on raw `email` (not LOWER): the "can't resurrect an unsubscribed
  lead" guard is defeatable via any uppercase-stored row (PUT /leads/:id writes verbatim;
  legacy rows). Pre-existing (capture-lead has it live); smsOptIn now relies on it. Normalize
  the column + retarget the index/ON CONFLICTs together. Also: the upsert's
  `COALESCE(email_leads.name, EXCLUDED.name)` is dead (`name` NOT NULL) — an 'Unknown' from
  capture-lead is never upgraded to a real name. (low)
- `staffDisplayName.validate.js` NAME_CHARS is ASCII-only: "José"/"Renée" cannot be SET as a
  preferred name (grandfathering covers only unchanged values). Product call: widen to
  `/^[\p{L}][\p{L} .'-]*$/u` keeping length/shape rules. (low, gemini catch)
- Seniority panel: clearing the Historical-events box sends 0 (parseInt||0), bypassing the PUT's
  ''-keep path — one-keystroke zeroing of a backfilled baseline (plan-mandated snippet; open
  decision w/ Dallas; ~3-line client fix + "leave blank to keep" helper copy). (low, decision)
- New batch suites are NOT on `scripts/money-smoke-list.txt` (incl. payrollTax.legalName.test.js —
  the 1099 name path). Add deliberately, not mid-push: the gate would immediately run them
  prod-shaped. (note)

## 8/06 push aftermath (display-name + seniority batch shipped 677baf95)

- `sanitizeProfile` `preferred_name_reviewed_at` item ABOVE is DONE (shipped in gate-fixes-0805). (done)
- Prod data hygiene: two probable duplicate-person pairs share a phone AND a name —
  users 39/40 ("Felicia", 40 has the trailing-space variant, 219-804-3426) and 51/62
  ("Adelle", two emails, 312-371-6554). The smsInbound shared-number tiebreak between each
  pair was a literal updated_at TIE pre-backfill (already arbitrary); 40 now wins its pair
  (trim stamp). Real fix is a human merge/deactivate of the dupes, not code. (med, ops)
- Backfill hand-fix names (script report, informational): users 15 "Ariel D. Smith",
  31 "Nicholas or Nick", 61 "Miss Taylor", 62 "Adelle M. Reynolds" — malformed preferred
  names to settle with the humans; users 1/61/62/237 have no legal name on file. (ops)
- `toYmd` in applySeniorityBackfill/generateSeniorityMapping assumes UTC-or-negative offset
  (`toISOString().slice(0,10)` on a local-midnight Date shifts a day on UTC+X boxes). Fails
  CLOSED (false PARTIAL, exit 1), never corrupts. Fine on Chicago box + Render/UTC. (low)
- Admin profile PUT omitted-vs-cleared now protects ONLY preferred_name; a partial payload
  still nulls phone/email/address/emergency contact (bare $3..$22). Latent — the sole caller
  round-trips every field — but phone feeds smsInbound sender resolution, so it is the
  higher-stakes column if a second caller ever appears. (low)
- Numeric :id guards accept arbitrarily long digit strings (int4 22003 → 500 survives for
  `99999999999999999999`); hire_date on the seniority PUT has no route-level format check
  (22007 → 500, unreachable from the UI's date input). (low)
- Test debt: no suite exercises PUT /api/admin/users/:id/profile (the 24-param CASE upsert),
  and the seniority PUT's no-op-guard property (no updated_at restamp) is hand-verified only.
  The scripts' invariant IS pinned (seniorityBackfill.test re-run updated_at assert). (med)
- `gratuityStaffNotice.js:67` + `eventDetailsPayload.js` team_roster recompute: two surviving
  bare/second-source name reads flagged by the display-name code review — gratuityStaffNotice
  selects bare preferred_name on a money-adjacent notice; the roster recomputes display name
  live (util-based, but `--check` cannot see drift there, and JS || vs SQL COALESCE diverge on
  empty-string legal names — 0 such rows today). Sensitive paths; deliberate no-touch at the
  gate. (low)
- Post-deploy owed: `refreshDisplayNames.js --check` against prod after the first week of
  organic writes; Dallas walkthroughs T6/T10-T13 + seniority panel smoke; CC seniority
  mapping generation → hand review → --apply (human-gated, Chicago box); Stripe test
  Payment Links deactivation (plink_1U0nVQ... / plink_1U0nVP..., admin-blocked for Claude). (ops)

## From the duty-pay review fleet (2026-08-06)

- **v1 LogisticsStep parking preview mis-quotes**: `client/src/pages/plan/steps/LogisticsStep.js:41-42, 155-159` previews `$20 x num_bartenders` while the server bills per_staff over ALL staff (bartenders + additional-bartender + barback + banquet-server). Live-reachable: prod still carries v1 draft/pending plans (e.g. plan 69 / proposal 472: shown $40, billed $60). Was already ordered in spec 2026-07-01-paynow-extras-addon-pricing-design.md:92 and never shipped. One-line fix, outside the parking-rewire lane's footprint.
- **Explicit-empty syrupSelections still strips contract syrups on submit**: `server/routes/drinkPlans/submit.js` — the 2026-08-06 guard treats an ABSENT syrupSelections key as "carry contract syrups forward", but an explicit `[]`/`{}` still enters the fold and strips. Pre-existing on main (unvalidated `rawAddonSlugs` already opens the fold); candidate fix: normalize in submitSanitize.js, or treat empty-on-a-no-syrup-UI planner version as "no opinion". (security, low)
- **paid_separately submit dodges the parking fee**: deliberate 2026-08-06 hardening (half-billed state was worse); a pay-now v2 submit with paid parking attaches nothing, so the fee is admin-added later or missed. Revenue-miss direction only. (low)
