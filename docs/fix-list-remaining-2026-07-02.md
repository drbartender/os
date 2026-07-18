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
- server/routes/drinkPlans/submit.js at 865 lines (soft cap 700): split by the established per-concern pattern on next touch (pp2-lab will touch this area — good moment).
- Jack-rule corner (code-review low): on hosted non-mocktail packages, a client submit with zero resolved mocktails clears BOTH pair rows, so an admin-seeded Mocktail Bar addon would be removed by a client submit. Consistent with picks-are-authoritative design; revisit if admins start seeding mocktail addons.
- Perf quick-wins (performance fleet, optional): narrow coverageContext's SELECT * FROM par_items; hoist DrinksV2 typeahead pool memo; precompute DrinksV2 tab counts.
- QR lane residuals: per-item admin_set flag rides the public payload (inert); no un-hold UI for admin-set quantities; buffer chips informational only (per-event override deferred by metadata-only scope).
- Legacy planner drain: delete client/src/pages/plan/steps/ + data/drinkUpgrades.js + DRINK_SYRUP_MAP/pricing exports in data/syrups.js after the last planner_version=1 draft submits (query: SELECT COUNT(*) FROM drink_plans WHERE planner_version=1 AND status IN ('pending','draft')).
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
