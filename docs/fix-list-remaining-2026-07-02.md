# The Backlog (consolidated 2026-08-13)

**This is the ONE list.** Dallas's ask (2026-08-12): "those 5 fix lists or whatever turned
into one." As of 2026-08-13 the former `tech-debt.md`, `open-threads.md`, and
`staff-ops-backlog-2026-07-22.md` are folded in below (their standalone files are deleted;
git history keeps every prior revision). Exactly three tracking files remain, one job each:

- **THIS FILE** — every defect, deferral, decision, unbuilt project, and tech-debt item.
- **`build-board.md`** — lane state only: what is being built right now.
- **`walkthroughs-owed.md`** — verification only: shipped work awaiting human eyes. Shrinks.

Reading conventions: the file accretes chronologically, newest sections at the bottom, and
push-review residual sections carry their review date. Retractions and corrections are kept
inline (marked RETRACTED / CORRECTED) as provenance — several plausible findings here died
on inspection, and the reasoning is worth more than a clean page. Re-verify line numbers
before building anything; other windows edit both the code and this file.

2026-08-14 full audit: every open entry below was verified against code on main (e6e6edaf).
Stale entries are marked inline with that date; ~190 open items were re-confirmed genuinely
open in code, so an unmarked entry is a verified-open entry as of that date.

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
- **Bar Program -> POTIONS** — BUILT 2026-07-09 per `docs/superpowers/specs/2026-07-09-potions-bar-program-design.md` + plan `docs/superpowers/plans/2026-07-09-potions-bar-program.md`; PUSHED LIVE 2026-07-09 (ba83407). /potions home (Menu + Recipes + Pars + plans drawer), single par catalog with call-on conditions, 41 draft recipes ready to seed, generator catalog-driven, client mirror killed. Owed: **THE RECIPE SESSION (Dallas, deferred by his call 2026-08-14 — "I have to do recipes at some point... not rn tho")**: one sitting that (a) reviews the ~41 drafts incl. the 6 low-confidence, (b) corrects Margarita to the house OJ build (decision 2026-08-14, spec is in his head only), (c) thereby clears GATE 2 of the applyPackageLineup2026 prod run, then (d) the prod seedRecipeDrafts run (dry-run first). See [[project-bar-program]].
  - **SEED-RUN GATE: CLEARED 2026-07-09** (lane potions-g-gatefixes, merged a0c2a8a; SHIPPED — on origin/main, 2026-08-14 audit). All 4 second-opinion findings fixed + regression-tested (28/28): (1) mocktails-only serving merges recipes; (2) seed script post-write parity validates LIVE rows + drift report; (3) Peychaud's normalized aliases (script + dev row); (4) matching-mixers pulls from the new pairableItems slice (all active mixer/garnish rows). Prod seed run is un-gated (the push shipped); the run itself is still owed, after Dallas's recipe pass.
- **Compare-page reskin** — `docs/compare-page-design-prompt.md`, sitting since 7/2; can ride either session above.
- **Potion Planner rework (client wizard)** — prompt doc committed 2026-07-15: `docs/potion-planner-design-prompt.md` (current-state map, file refs, ranked confusion inventory incl. Dallas's balance-questions ask, money-path law). Flow/comprehension redesign in the existing skin, claude.ai/design session next. Absorbs the deferred 7/13 items #1 (custom drinks/mocktails on shopping list) and #2 (better balance questions). **BUILT & SHIPPED 2026-07-18 as Planner v2** (pp2 lanes: `client/src/pages/plan/v2/PlannerV2.js` via PlannerRouter, `planner_version >= 2` branch at `drinkPlans/submit.js:92` — 2026-08-14 audit). Residuals live in the Planner v2 sections below; this design session is done.
- **Client-detail messaging (QUEUED 2026-07-14, from Needs-Attention-tabs spec §7)** — full SMS history + reply on the client details page; Messages nav demotes to an "All messages" link; the overview's unread-SMS queue items retarget to the client page (one-line change). Driver: finding a thread in the Messages tab is too tedious. Endpoints already exist (`/sms/conversations/:clientId` + reply route). **CORE SHIPPED** (lane sms-client-panel 9020c68a: `ClientDetail.js:271` renders the Messages card + ClientConversation reply — 2026-08-14 audit; the Messages-nav demotion and overview-retarget halves of this entry were not separately verified).
- **Menu design page (QUEUED 2026-07-14, from Needs-Attention-tabs spec §7)** — real workflow over the planner-captured menu prefs (`menuStyle`/`menuTheme`/`drinkNaming`/`menuDesignNotes`); produces a real artifact and the done-state that then powers "menu to design" Prep queue items (deliberately NOT hand-flagged in the tabs build). Dallas has page ideas to brainstorm.

## Scope calls needed before scoping
- ~~**Classes / field guide** — restyle existing OR new marketing/content pages? Unresolved.~~ **DECIDED 2026-08-14 (Dallas): classes are ON HOLD pending a full rework of structure and design** — no restyle, no new pages, no class work at all until that project opens. `FieldGuide.js` (the staff manual, not a classes surface) stays tracked under the staff-portal skin item in the 8/10 drop.
- ~~**Staff payment system** — superseded or still queued?~~ **DECIDED 2026-08-14 (Dallas): RETIRED as superseded** — the payroll screen redesign, paystub PDFs, duty pay, clawback/late-tip, payout tracking, and owner no-draw shipped the substance piecemeal. The one surviving piece is **1099 generation, now queued in its own right** (see the Phase 4 entry in the folded-in section; recipient copies due ~Jan 31, and the standing W-9 tripwire applies: no 1099 run while Zul's W-9 is a .png). The multi-bartender tipping thread is closed with it — tip signs are per-bartender and settled.

## Known-bugs batch — FIXED on main 2026-07-14, since PUSHED (header corrected 2026-08-14)
The 14-bug sweep below (B1-B14) was re-verified against HEAD by a parallel
investigation, specced + plan-reviewed (docs/superpowers/{specs,plans}/2026-07-14-known-bugs-batch*),
built in 8 file-disjoint lanes (kb-a..kb-h), each per-lane review-fleet clean
(full fleet on the 7 money/sensitive lanes, light on kb-h), and squash-merged
(90f3029..419f585 + docs c1bfd2c). CORRECTED 2026-08-14: long since pushed —
419f585 is an ancestor of origin/main; the old "NOT PUSHED / at push" state is history.
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
- ~~**W1 (from kb-a review): a THIRD archive door does not reap.**~~ **FIXED 2026-08-14 (84812517)** — lifecycle->archived now runs the shared `reapShiftsForProposal` (transactional, best-effort) + the email-only staff notify; regression test in archive.test.js pins shift soft-cancel, request denial, and comms suppression through this door. Original: `PATCH /proposals/:id/status -> 'archived'` (lifecycle.js, admin, `?force=true` from any status) reaps only marketing/change-requests, never shifts/messages/invoices. NOT reachable from the UI (ProposalDetail only posts sent/accepted through it; the Archive button uses `/:id/archive`), and the dispatcher archived-cascade backstops comms, but a raw-API archive of a shift-bearing booking keeps the shift live — the B1 symptom via a different door. Fix: route lifecycle->archived through `reapShiftsForProposal` or block it for shift-bearing proposals. Small; do in a later proposals-touching lane.
- **B5 cross-cycle residual:** after cancel -> refund -> restore -> re-book -> re-pay -> re-cancel, the second cancellation's snapshot is computed from a gross SUM of all succeeded payments (refunds never demote payment rows), so the forfeited cycle-1 retainer can partially leak back into the cycle-2 cap. Visible in the preview before money moves. Snapshot-per-cycle or a payment-row demotion would close it.
- **B9 edge:** a reschedule landing in the seconds-wide mid-send window whose send then hangs >10 min gets reaper-redispatched with the hardcoded "tomorrow" copy for an event now days out (details otherwise fresh). Double-rare; part of the notification-dup cluster.
- **B4/B13:** a held reimbursement clawed to exactly 0 while the worker is still off-roster is deleted by the next sweep's adj==0 path (loses only the audit note, zero money). B11 NULL-CallSid dead legs (non-prod, forged posts fail signature) no longer write a forensic audit row.
- **B10:** if Thumbtack counts repeated 503s toward webhook health/auto-disable, a crash-strand whose only retry lands inside the 10-min window stays unhealed until manual replay (lead+client rows are committed and visible). B6: an ambiguous-error pending row blocks that charge's headroom for ~45 min and is invisible in refund history until the sweeper resolves it.

## Known bugs (prod-confirmed, unbuilt) — STALE SECTION, both FIXED (2026-08-14 audit)

Written before the known-bugs batch above landed; both entries shipped with it, and the
batch is pushed. Refund-leaves-booking-live = B1 (`shiftReap.js`; `actions.js:498` reaps
shifts/messages/invoices in the archive tx; the panel prompts archive at amount_paid=0).
`archive_reason` = B2 (`actions.js:444-446` validates + `:491-492` writes it; also
`cancel.js:306`; pinned by `archive.test.js`). The `actions.js:397` pointers below are
stale (the archive endpoint now sits ~`:440`). Kept as provenance; nothing below is open.

- **A refund on a paid proposal leaves the entire booking live.** Found 2026-07-09 on proposal 500 (Shruti Parekh: refunded 7/1, still sitting on the Events board 8 days later with 11 pending client reminders queued). `issueRefund` (`server/utils/refundHelpers.js`) reverses the payment, reverses the linked invoice(s), and downgrades `proposals.status` back to `accepted` (`refundHelpers.js:282-283`). It touches nothing else: that file has zero references to `shifts` or `scheduled_messages`. So a fully-refunded booking keeps (1) its auto-created shift at `status='open'`, visible on the Events board *and* in the staff open-shifts feed, where a bartender can and did apply to work a cancelled event; (2) its balance invoice at `status='sent'`, still dunnable; (3) its whole pending `scheduled_messages` ladder. The dispatcher's `checkSuppression` gates only on `proposal.status === 'archived'` (`scheduledMessageDispatcher.js:140`), and `accepted` is not `archived`, so balance reminders (which recompute `total_price - amount_paid > 0`), drink-plan nudges, event-week and event-eve reminders all keep firing at the refunded client.
  - Compounding it: `POST /proposals/:id/archive` (`actions.js:397`) voids invoices and suppresses messages but **never touches shifts**; and neither the admin Events feed (`shifts.js:40`) nor `EventsDashboard.js` filters on `shifts.status` or `proposals.status`. So archiving the proposal does not remove the row, and soft-cancelling the shift does not either. Only a hard `DELETE FROM shifts` does.
  - Manual cleanup performed for 500: archive via the UI (Dallas) + `DELETE FROM shifts WHERE id=337` (cascaded one pending `shift_requests` row; no `payout_events`, so no payroll exposure). The staffer who had applied was never notified, since no code path does that.
  - Fix directions, unscoped: reap on refund-to-zero (shift + invoice + scheduled_messages together), or widen `checkSuppression` past its archived-only gate; teach the archive endpoint to reap shifts; filter cancelled shifts and archived proposals out of the Events feed. Same family as the open seam-sweep `record-payment status-downgrade` item.
- **`archive_reason` is never written by the archive endpoint.** `actions.js:397` sets `status='archived'` and leaves the column NULL. The CHECK constraint allows `no_hire`, `client_cancelled`, `we_cancelled`, `event_completed`, `other`, `option_not_chosen`, but only `option_not_chosen` has a live writer (`proposalGroupCommit.js`). Every manually archived proposal therefore shows no reason in the archive bucket. Small: wants a reason picker on the archive action.

## Post-push review 2026-07-13 residuals (confirmed P2s) — 6 of 8 since FIXED (2026-08-14 audit)
The 27-commit batch (031fb6d..77005c5) got its push-time fleet + /second-opinion pass AFTER the push; the two P1s it found (drink-plan rails unreachable by /cancel/refund; UTC-vs-Chicago notice date) plus the pending-refund retry double-issue were fixed same-day in lane `cancel-refund-hotfix` (merged e97dfec, all confirmed by regression tests that fail pre-fix). These confirmed P2s remain, all conservative-direction or narrow-window:
- **Post-cancel money doors — FIXED** (= B3: `stripe.js:564-570` throws EVENT_CANCELLED for archived proposals on the public intent route; `stripe.invoiceIntentArchived.test.js` + `stripeWebhook.archivedSettle.test.js`). Original: A partially-paid invoice survives cancel as `partially_paid`, and `create-intent-for-invoice/:token` (`stripe.js:~536`) has no archived-proposal guard, so a client on a stale emailed link can keep paying a cancelled event; likewise an intent already `processing` at cancel time settles later (the webhook credits archived proposals unconditionally — only status promotion is guarded). Money lands outside the refund math; a /cancel/refund re-run picks it up, but nothing prompts one. Fix direction: archived guard on the public invoice intent route + Sentry/admin alert when a payment lands on an archived proposal.
- **`payout_events.held_state` is invisible to the clawback/late-tip ON CONFLICT upserts — FIXED** (= B4: both DO UPDATEs now branch on held, `payrollClawback.js:207-215` + `payrollLateTip.js:177-185`). Original (`payrollClawback.js:196-212`, `payrollLateTip.js:168-182`): their DO UPDATE recomputes `line_total` with no held awareness, so a narrow remove→re-approve→tip-refund chain can resurrect a HELD reimbursement as payable with `held_state='held'` (breaks paystub footing). Fix direction: make both upserts preserve held zeroing, or trigger re-accrual on shift_request approval.
- **Cancel-refund retry can over-refund via the retainer feedback loop — FIXED** (= B5: `cancel.js:529-547` caps against the cancelled-row `refund_owed_cents` snapshot + post-cancel headroom). Original: `applyRefundReconciliation` decrements `invoices.amount_paid`, and `retainerCents` reads live from the Deposit invoice, so a second /cancel/refund run after a mid-loop failure computes a higher client-mode target (~+5% of retainer). Converges after one extra run; pending-netting (now shipped) narrows it. Fix direction: snapshot the agreement target at cancel time (activity log already records `refund_owed_cents`) and cap lifetime cancel refunds against it.
- **Stranded pre-Stripe `pending` refund row has no healer — FIXED** (= B6: `refundSweepScheduler.js` wired at `index.js:572`; and `refundExecute.js:84-95` now fails rows only on definitive Stripe rejections, closing the inverse hole too). Original: Pending rows now (correctly) block refund headroom; a row orphaned by a crash BEFORE the Stripe call can never be webhook-adopted and permanently under-refunds until a manual `UPDATE ... SET status='failed'`. Also invisible in the refunds history (`stripe.js:399` filters pending). Fix direction: stale-pending sweeper that reconciles rows older than N minutes against Stripe. Related inverse hole (pre-existing): `refundExecute.js:68` marks 'failed' on ANY Stripe error including ambiguous timeouts where the refund may exist — only definitive rejections should fail the row.
- **`shortfall_cents` isn't surfaced in CancelEventDialog — FIXED** (= B7: `CancelEventDialog.js:108-111` toast + `:268-270` persistent warning; `CancelEventDialog.test.js:76,93`). Original: server returns it + Sentry warns, but the admin toast still reads as complete. One-line UI add whenever the dialog is next touched. (Legacy-CC / manual payments are the live trigger: refund those by hand.)
- **Cancel-path frozen-period clawback deferral retry loses the pre-denial bartender list** (`payrollDeferredRetry.js:28` replays without opts; by then shift_requests are denied → marker advances with zero clawed). Defense-in-depth path only; near-unreachable by construction.
- **Boot re-asserts P4 floor values** (`schema.sql:2119` UPDATE runs at every initDb): hand-tuning `min_total`/`min_billed_guests` in SQL silently reverts on next deploy. By design for a seed-managed table — just know the only way to change floors is editing schema.sql.
- **`checkoutSessionCompleted.lastMinute.test.js` never calls `registerAll()` — FIXED** (= B8: `before()` calls `preEventHandlers.registerAll()` at `:127`). Original — the deposit-paid reminder scheduling errors (swallowed, non-blocking) in every smoke run, so the suite isn't asserting reminders get scheduled. Prod is safe (`server/index.js:518` registers before any webhook can dispatch). One-line `before()` fix mirroring `preEventScheduling.test.js:23`.

## Specced, deliberately parked
- **Drink-plan edit lock (Option A)** — decouple the lock from submit (currently `status IN ('submitted','reviewed')` in `drinkPlans/submit.js`), tie to `shopping_list_status`, add an admin "reopen for client" control. Option B (autosave tracking) already exists. Medium; event-side-canonical drink-plan territory.

## Dallas-owned / skipped by his call
- ~~**Intro message: remove phone, add cal.com link**~~ **CLOSED 2026-08-14** — the 8/14 decision (bottom of this file) keeps the 312 in staff auto-replies, and the client `COMPANY_PHONE` already moved to the 1922 with phone 1a (`constants.js:5`). `CAL_BOOKING_URL` already wired.
- **Syrup picker** — suspected bug: generators never cross-check `syrupSelfProvided` vs comped/paid `proposalSyrups` (`addSelfProvidedSyrups`, both mirrored generators). Re-diagnose fresh; pay-now-extras comp-fold touched this territory.

---

## Operational tails (not builds)
- **Zul VA calling — LIVE and in use.** Confirmed via prod usage 2026-07-06 (7 calls, 17 Telegram updates logged); Zul places/receives US calls through the Telegram->Twilio bridge. The bring-up runbook is done; nothing owed.
- ~~**CC migration hand-off (owner, before CC dies 7/21)**~~ **CLOSED 2026-08-14 (Dallas): "CC is gone. We'll handle any issues as they arise with the clients that transferred."** No open task remains; original checklist kept for reference: turn OFF CheckCherry client notifications; send the 12 Stripe balance invoices (invoice link is the pay path for confirmed proposals; the auto-reminder /proposal link has no pay button); intro-note each client + re-enroll their drink-plan nudge (the reenroll button clears the durable suppression); download signed contracts + a 2026 YTD P&L export. If Sid (due 7/9) / Cody (7/17) pay via CC first, bump external_paid/amount_paid via the documented UPDATE (never a payment row). Check/cash balances: case-by-case UPDATE (record-payment refuses confirmed by design).
- **Eyeball sweeps owed:** After Hours both-skin (event page, a dashboard, blog-editor fields, primary-button hover); ~~doc-preview modal with a real W-9 PDF + headshot in both skins~~ **DONE — VERIFIED GOOD in Dallas's 2026-08-13 doc-preview walk** (see that section below).
- **Resend Pro upgrade** — free 100/day cap hit; scheduled sends degrade gracefully; whenever. **DECIDED 2026-08-14 (Dallas): not yet** — revisit before the first real campaign blast (campaigns share the allowance with transactional sends; raise `RESEND_DAILY_CAP` on Render when the plan changes so the Overview budget reads true).

## Payroll-redesign follow-ups (2026-07-15, from lane fleet reviews)
ALL RESOLVED 2026-07-16 (commits 5c5a769 + f3fa6f7): PaydayProtocols zelle re-add + POST /payment zelle support; staffShiftActions frozen-period guard rewritten as correlated EXISTS; emergency-drop past-event 409 (event_started); PayPanel/PayoutRow zelle label shims collapsed. Old-UI zelle null-handle records: prod queried read-only 2026-07-16, ZERO affected rows, closed as no-op.

## Small deferred / tech-debt
- ~~**crud.js `/:id/legacy-cc-payments`** — now clientless (CC demolition deleted its only consumer); dead endpoint in sensitive `proposals/`, remove in a later proposals-touching lane.~~ **REMOVED 2026-08-14 (Dallas-approved)**: route + test deleted; verified dead three ways first (no caller since f39de178, prod has ZERO legacy_charge_id payment rows, and the refund machinery structurally can't select PI-less rows anyway). ARCHITECTURE row dropped; crud.js 995→976. Provenance note: the route/doc edits are fbed9e0a, but the three FILE deletions rode another window's commit be555426 (marketing css) via the shared os index — content correct, attribution off.
- ~~Refunds-on-invoice: a payment split across multiple invoices shows the FULL refund on each (rare, informational). Apportion if it bites.~~ **DONE** (lane refund-attribution c89fe834: `invoices.js:105-119` two-regime LATERAL, `invoices.refunds.test.js` — 2026-08-14 audit).
- Payment accounting: non-flat add-on comp residual (brief owed).
- **Admin OS baseline omits text color, so legacy cream can leak in (root cause, admin-wide).** The 2026-08-14 marketing adherence review found two surfaces (ContactDrawer + ShiftDrawer heroes, the Compose resume banner) rendering `--cream-text` at ~1:1 on House Lights because the unscoped legacy globals `h1..h4 { color: var(--cream-text) }` (`index.css:148`) and `p { … color: var(--cream-text) }` (`:165`) win wherever an admin-os rule omits `color`. Both call sites are patched (3af0edd9), but the systematic fix is one declaration: add `color: var(--ink-1)` to the existing admin-os `h1..h4` baseline (`index.css:11844`) and add an admin-os `p` baseline beside it. Admin-WIDE blast radius (every admin-os surface, both skins), so it wants its own small lane with a visual sweep, not a ride-along. Until then, any new bare `<p>`/`<hN>` on an admin-os screen must declare its color.
- ~~Audit leftover: manager iCal in `calendar.js` (last open audit item).~~ **CLOSED** — confirmed intended 2026-07-13 (`docs/audit-2026-07-13/tech-debt-register.md` F-ICAL); manager treated as admin at `calendar.js:348,488` (2026-08-14 audit).
- Tech debt: ~~`notifications_opt_in` dead column DROP (4 test fixtures still INSERT it)~~ **DONE** (aebd5562, `schema.sql:4341`; zero fixture INSERTs remain — 2026-08-14 audit); ~~`.form-select` focus padding-right; no-tip-jar badge redness vs last-minute badge; `.staffing-stat strong` ink emphasis~~ **all three FIXED 2026-08-14 (8045743e)**: focus rule re-asserts chevron clearance, no-jar badge joins the red family (`.nojar-badge`), stat strong uses `--ink`.
- Empty v1 tables (`legacy_cc_raw_imports`, `cc_import_runs`, `cc_import_phase0_failures`) stay as harmless scaffolding. Dev v1 junk SCRUBBED 2026-07-14: 176 v1 proposals (+ shifts/refunds/scheduled messages) and 1,199 v1 clients deleted transactionally with verification; 16 CC-marked clients with real proposals kept; ~1,207 dev `legacy_cc_proposals.client_id` links nulled (no live consumer); 22 `users.cc_id` rows deliberately untouched.

## Potion custom-recipe flow residuals (2026-07-16, full-fleet accepted-not-fixed)

- Reuse-by-NAME rename gap: Add-recipe reusing a drink matched by name (never
  aliased) loses the match if the admin renames it in the drawer; needsRecipe
  resurfaces, next click mints a fresh draft. Proper fix: a small alias-append
  on reuse (server surface; PUT deliberately ignores request_aliases).
- Reuse-before-create lookup downloads both full admin drink lists (ingredients
  JSONB included) for a name match; fine at ~43 drinks, wants a lean lookup
  endpoint as the off-menu pool grows.
- ~~RecipeEditor renders every par (83) as an option per row; memoize the row
  component or hoist options if the catalog grows several-fold.~~
  **FIXED 2026-08-14 (46d2974c)**: one `useMemo` hoists the option list out of the
  per-row render. Note the original was slightly less bad than logged: `buildSuggestions`
  was already gated on the open row, so only the option list was recomputing.
- `loadRecipeCandidates` awaits serially after the resolveDrinkIds Promise.all
  in `buildPlannerGeneratorInput` (~one extra Neon round-trip per regenerate).
- ~~`server/routes/drinkPlans.js` is ~795 lines (soft cap 700); next change in
  that file should carry the split (per-concern extraction, proposals/ pattern).~~
  **DONE** — split landed, drinkPlans.js is now 622 (coverageContext/lab/submit/
  regenerate/shoppingList extracted). **NEW 2026-08-14: `drinkPlans/submit.js` has
  regrown 599→717, back over the soft cap; next touch there carries a trim.**
- ~~PantryParsTab.js reads `err.response?.data?.*` (lines ~83/93/129), always
  undefined under the api.js interceptor, so its toasts degrade to generic
  copy; same defect class fixed in RecipeEditor. Quick fix on main.~~
  **FIXED 2026-08-14 (4d8a5394)**: all three catches read the flat
  {message, fieldErrors} shape.
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
  hygiene, empty-channel rule, retry guard, partial-failure shape. (2026-08-14:
  `comms.silent.test.js` now covers the empty-channel rule + a retry-guard
  interaction at route level; still missing subject caps, header hygiene, and
  the partial-failure shape.)
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
- ~~LEAD_CALL_DAILY_CAP=0 silently means 25 (NaN-guard); the kill switch is the
  only off path. Doc note whenever the env table is next touched.~~
  **DONE 2026-08-14 (982e6f5a)**: noted in .env.example, README, and CLAUDE.md.

## Comms send-modal lanes P+N residuals (2026-07-18, post-merge 80da937 + f1d2e88)

- ~~LIVE BUG: submit.js slow-path drink_plan_ready emailed the stale drink_plans.client_email snapshot (dead proposal.client_email fallback)~~ **FOLDED into lane pp2-planner 2026-07-18**: the existing-plan SELECT now JOINs live `c.email`/`c.name` (live first, snapshot fallback), mirroring the fast path. Ships with the lane's squash merge.
- ~~Compare-send toast reads "Text skipped: Compare sends have no text message" (truthful, noisy).~~ **FIXED 2026-08-14 (7b5be986)**: 'not selected' unless SMS was actually requested; both behaviors test-pinned. (P fleet code-review.)
- ~~ProposalDetailPaymentPanel double-fetches `/invoices/proposal/:id` (its own list + InvoiceDropdown's self-fetch, keyed together). Lift the fetch and pass the list down.~~ **FIXED 2026-08-14 (2233a1b6)**: InvoiceDropdown takes an optional `invoices` prop and only self-fetches without it; the `key` remount went away with the double-fetch, so the dropdown no longer snaps shut. (N fleet code-review.)
- Deprecated resend-nudge delegation makes 3 DB round-trips (resolve + ensure + dispatch loads) vs legacy 1; archived case is now 409 vs legacy 400. Compat-only route, low traffic; tidy if ever touched. (N fleet.)
- ~~invoiceSend docblock: "the level the legacy send path had" should reference the nudge route's posture (invoice send is new, no legacy).~~ **DONE 2026-08-14 (982e6f5a).** (N fleet.)
- paymentReminder/drinkPlanNudge email availability does not require the token although the email body embeds it (937ba35 only added the guard to SMS + placeholder email). Harmless (no-token proposals are rare and the CTA link just dies), tidy with the next comms touch. (Psync report.)

## Planner v2 residuals (2026-07-18, post-merge of all 6 pp2 lanes)

**Dallas content calls (from the lineup lane + live coverage):**
- ~~CONFIRM: F5 ginger-ale removal was extrapolated from the Midrange/Enhanced purge (flagged by the lineup script; DB + prose already reflect removal).~~ **CONFIRMED 2026-08-14 (Dallas): ginger ale stays gone.** The extrapolation flag in applyPackageLineup2026.js can drop on its next touch.
- ~~RECONCILE: Grand Experiment stocks Miller Lite in package_items but the marketing prose omits it — add to prose or drop from lineup.~~ **DECIDED 2026-08-14 (Dallas): keep it stocked, add it to the prose.** Folds into the includes-prose extension of applyPackageLineup2026 (prod-run gate 1): Grand's new `includes` text names Miller Lite, brand-level per the Athletic posture.
- ~~CONTENT CALL: Enhanced has no triple sec, so Margarita is FENCED on Enhanced...~~ **RESOLVED 2026-08-14 (Dallas): none of the three options — the premise was wrong. "Our marg recipe used OJ."** The seeded Margarita draft (`seedRecipeDrafts.js:134-140`) is the classic triple-sec build, not the house recipe; correcting it to the OJ build (spec lives only in Dallas's head) is part of THE RECIPE SESSION below. Once corrected, OJ is already in every package's mixer stock, so the Enhanced fence dissolves on recompute; Midrange stays honestly limited (no lime juice). No package-contents change, no new add-on.
- ~~pp2 lane branches await the -D nod (worktrees removed; shared-file tails make the byte-diff check inapplicable): pp2-recipe-card, pp2-package-editor, pp2-lineup, pp2-quantity-review, pp2-planner (+ pp2-core already deleted).~~ **DONE — all five branches deleted** (`git branch` lists none, 2026-08-14 audit).

**Tech-debt / small residuals:**
- ~~server/routes/drinkPlans/submit.js at 865 lines (soft cap 700): split by the established per-concern pattern on next touch~~ **DONE 2026-07-22** (lane fs-split-drinkplans): submitSanitize.js + submitNotify.js extracted; submit.js 830→599.
- Jack-rule corner (code-review low): on hosted non-mocktail packages, a client submit with zero resolved mocktails clears BOTH pair rows, so an admin-seeded Mocktail Bar addon would be removed by a client submit. Consistent with picks-are-authoritative design; revisit if admins start seeding mocktail addons.
- Perf quick-wins (performance fleet, optional): **the two DrinksV2 items are FIXED 2026-08-14 (46d2974c)**, namely ~~hoist DrinksV2 typeahead pool memo~~ and ~~precompute DrinksV2 tab counts~~. **STILL OPEN: narrow coverageContext's `SELECT * FROM par_items`** (server-side, untouched by the wave).
- QR lane residuals: per-item admin_set flag rides the public payload (inert); no un-hold UI for admin-set quantities; buffer chips informational only (per-event override deferred by metadata-only scope).
- Legacy planner drain: delete client/src/pages/plan/steps/ + data/drinkUpgrades.js + DRINK_SYRUP_MAP/pricing exports in data/syrups.js after the last planner_version=1 draft submits (query: SELECT COUNT(*) FROM drink_plans WHERE planner_version=1 AND status IN ('pending','draft')).
- **pp2-lab fleet advisories (all non-blocking, 2026-07-18):** (1) pay-then-add delta invoice line items list the cumulative lab set with the drift folded into the last line — amount_due is exact, labels warp; consider delta-scoped selections or an explicit "less previously invoiced" credit line. (2) Client removes additions AFTER paying the lab invoice → over-collection silently retained (admin refunds manually; DRB-favorable, surfaced at list re-approval). (3) ~~Lab PUT accepts any active non-Jack addon slug~~ **FIXED** (fc3780fc: `offeredSlugs` allowlist at `lab.js:189-196`; `sanitizeLabAddOns` throws on out-of-list — 2026-08-14 audit). (4) refreshListAfterLabChange fires per save with no per-plan coalescing (correct, off-response-path; cheap robustness win). (5) No in-flight guard on the debounced client save (server FOR UPDATE serializes; self-heals). (6) Syrup shopping-list strip matches by normalized-name substring — admin re-approval is the backstop. (7) ~~A syrup already priced into pricing_snapshot.syrups is still offered by GET but bills $0~~ **FIXED** (`contractSyrupSet` at `labHelpers.js:64-69` excludes snapshot syrups on GET `lab.js:78,88` and PUT `:199-203` — 2026-08-14 audit).
- Rollout runbook (at push): run server/scripts/applyPackageLineup2026.js on PROD (dry-run first) + server/scripts/migrateDrinkMeta.js on PROD; both idempotent, snapshot/skip-guarded. **TWO GATES before the lineup script's prod run: (1) the `includes`-prose item in the push-review section below; (2) the recipe pass on the ~40 drafts — package_items existence flips hosted coverage live (coverageContext has no recipe_review filter), so fence charges would derive from unreviewed recipes.** migrateDrinkMeta has no such gate.

## Push-review residuals (2026-07-18 push gate: fleet + codex/gemini, Claude-verified)

- **BEFORE applyPackageLineup2026's prod run:** extend the script to UPDATE the changed
  packages' `service_packages.includes` prose (and refresh the stale seed copy at
  schema.sql ~623-660 — pointer re-verified 2026-08-14: stale "Dewar's" at :635,
  "Ginger Ale" at :641; the script still has no `includes` write). Four public surfaces serve `includes` live (proposals
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
- ~~v2 wizard refresh resets to the Welcome step (answers preserved via autosave);
  polish: persist/restore step position.~~ **FIXED 2026-08-14 (46d2974c)**: step position
  persists in sessionStorage keyed by plan token, and the restore validates the stored step
  against the live queue so an unknown or stale step falls back to the start rather than
  stranding a client on a screen that no longer exists. (addendum client F3.)
- Margin sketch (decorative, admin-only): (a) `||` fallbacks treat an explicit 0
  labor-rate/supplies setting or slider value as unset — needs ?? + query-param
  presence checks (gemini); (b) flat-package revenue ignores extra hours while labor
  cost scales with them (codex LOW); (c) PackagesTab fires one margin request per
  package on tab open, each re-reading all of par_items — fold margin_pct into the
  list response or add a batch margins endpoint (perf fleet).
- ~~RecipeEditor small pair (code-review Consider): unit validation dropped from
  rowProblems (server still rejects bad units; defense-in-depth only);
  ClientConversation handleReply setState-after-unmount unguarded (React 18 benign).~~
  **BOTH FIXED 2026-08-14 (46d2974c)**: unit validation is back in rowProblems, checked
  only on rows that carry an amount so a half-typed row does not shout; ClientConversation
  guards its post-await setState with an `aliveRef`.

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
- ~~EnhancementLab debounced save timer not cleared on SPA route-change unmount~~ **FIXED 2026-08-14 (4d8a5394)**: unmount now runs the same keepalive flush as pagehide — timer cleared, pending edit saved, no post-unmount setState.

**CLEARED 2026-07-21 — verified moot under the balance-fold (removed from deferred):** off-ledger webhook/refund test (OFF_LEDGER set is empty; lab money rides the standard contract paths their suites cover); planRefund's `EXCEEDS_AMOUNT_PAID` guard "excludes lab dollars" (lab payments now roll into `amount_paid`, so the guard already includes them — verified refundHelpers.js:59 + empty OFF_LEDGER); multi-invoice lab delta negative-final-line (the fold prices the CURRENT additions via buildLabLineItems, not a cumulative breakdown, so remainder ≈ line sum and foldLinesTo can't go negative in the fully-paid branch); GET `computeExtrasBreakdown` round-trip (replaced by sync `priceLabAdditions`, 0 occurrences); desired-state overpay edges (removing paid additions now flows through general proposal-overpay + `reconcileProposalPaymentStatus`, not a lab-specific gap; the approval-race Sentry warn shipped at lab.js:363).

**Deferred (non-lab):**
- Lead-call: a VA leg Twilio PLACED but reports terminal CallStatus='failed' (carrier/route failure; known PH-route quirk) classifies as quiet 'missed' — no alert, not in the attention feed. Option: treat agent-leg 'failed' as fault-class, or include va/admin_call_status='failed' in the feed WHERE. (security advisory.)
- ~~admin/leadCalls attention query has no LIMIT~~ **DONE 2026-08-14 (7b5be986)**: LIMIT 200.

---

## Payment history in the admin UI (added 2026-07-21)

There is no way to see individual payments on a proposal. The payment panel shows totals only
(amount paid, balance due); `proposal_payments` rows are never listed and no endpoint returns
them. Surfaced while speccing [notify-client confirmation](superpowers/specs/2026-07-21-notify-client-confirmation-design.md),
where a per-payment "Send receipt" action had nowhere to live and was cut for that reason.

Shape: a `GET /api/proposals/:id/payments` plus a compact table in `ProposalDetailPaymentPanel.js`
(date, amount, type, method, status). Natural home for a per-payment Send receipt action and for
refund attribution, which today is also invisible per-payment.

Ride-along when this is built: `actions.js:293` (drifted from :286) re-reads the just-inserted payment via
`SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1`
instead of `RETURNING id` on the INSERT. Under concurrent inserts that links the wrong payment
row to the invoice.

## Push-review residuals (2026-07-22, unverified suggestions, deferred)
- googlePlaces.js: out-of-area guard + pick() shortText fallback not routed through normalizeVenueState (two spots; Places flow only).
- ~~proposalEditor: blank guest_count previews at 50 but PATCHes 0; add client-side required validation.~~ **FIXED 2026-08-14 (2233a1b6)**: blocked at the submit gate, mirroring the existing package_id guard; the preview's `|| 50` is deliberately kept so an empty field still renders a sane estimate.
- ~~repriceSummary: already-overpaid + price-increase edge shows consequence lines the server will not perform (copy precision).~~ **FIXED 2026-08-14 (2233a1b6)**: the overpaid case now splits three ways (overpayment still covers the increase, covers it exactly, increase outruns it). The fix also caught a second untruth this entry did not name: the demotion line was unconditional, while `reconcileProposalPaymentStatus` does not demote while `paid >= total`.
- leadCallTrigger: reply_stale/reply_confirmed_late fault rows consume LEAD_CALL_DAILY_CAP headroom (status 'failed' counts as non-skipped); irrelevant at current volume, revisit if cap ever tightens.

---

## Notify-client confirmation residuals (added 2026-07-22)

Shipped across three lanes (notify-server / notify-client / notify-refunds); spec + plan under
docs/superpowers/{specs,plans}/2026-07-21-notify-client-confirmation*. Deferred with reasons:

- **"Do not contact" toggle on the client admin page** writing `communication_preferences`.
  **Re-verified and sharpened 2026-08-14.** `communication_preferences.email_enabled` has NO
  product writer anywhere: `smsConsent.js:122` and `smsInbound.js:332,341` write only
  `sms_enabled`, and the marketing unsubscribe writes only `marketing_enabled`. Yet
  `email_enabled === false` is read and honored in about a dozen places
  (`messageSuppression.js:34`, `notificationChannelResolver.js:54,66`, `eventEveSms.js:208`,
  `channelFallback.js:22`, `marketingAudience.js:44,66,127,359`,
  `scheduledMessageDispatcher.js:170`, `serviceExtensionNotify.js:202`,
  `marketingHandlers.js:342`, `consultRecap.js:64`). Prod: all 525 clients carry the key and
  all 525 are `true`, so the only way to set it is a manual DB edit.
  It is NOT redundant with the controls that DO have writers, and this is the reason to build
  rather than drop it: the dispatcher's `marketing_excluded` / `marketing_enabled` gates are
  scoped to `meta?.category === 'marketing'`, so neither touches an `operational` message.
  `email_enabled` is the only system-wide email mute. (Note `marketing_excluded` is `false`
  for every client in prod, so that control has never actually been exercised either.)
  **DECIDED 2026-08-14 (Dallas): "drop".** Against my recommendation to wire it, and taken
  with the trade-off stated: dropping it means there is no system-wide email mute at all, and
  the marketing-scoped controls (`marketing_excluded`, `marketing_enabled`) cannot reach an
  `operational` send. That is the accepted cost. The "do not contact toggle" line item is
  closed with it; do not re-propose either.

  **This is a careful removal, not a delete, and it is a LANE not a quick fix.** What makes it
  delicate is `marketingAudience.js`: `email_enabled` appears at `:44`, `:66`, `:127` and
  `:359` interleaved with `marketing_enabled` and `lead_unsubscribed`, and `:66`/`:359` fold
  it into the same `'unsubscribed'` label as the real unsubscribe signal. Twelve prod rows
  carry `marketing_enabled=false` and those are LIVE opt-outs. Dropping the wrong arm of that
  CASE silently re-adds twelve unsubscribed people to a campaign audience, which is a
  compliance problem, not a cosmetic one. Every removal there must be proven a no-op against
  the other two signals.
  Everything else is mechanical: the guards at `messageSuppression.js:34`,
  `notificationChannelResolver.js:54,66`, `eventEveSms.js:208`, `channelFallback.js:22`,
  `scheduledMessageDispatcher.js:170`, `serviceExtensionNotify.js:202`,
  `marketingHandlers.js:342`, `consultRecap.js:64`, plus the key in the DEFAULT_PREFS literals
  at `smsConsent.js:117` and `smsInbound.js:333,342`, plus the stale comments at
  `messageSuppression.js:63` and `channelFallback.js:8`.
  **Existing data is deliberately left alone.** All 525 rows keep an orphaned `email_enabled`
  key that nothing reads. A 525-row jsonb rewrite of the clients table to tidy a harmless
  orphan is not worth the blast radius; new rows simply stop getting the key.
- **PATCH /api/proposals/:id has no adminWriteLimiter** while now carrying admin-composed
  client sends; the comms send path and even the read-only notify-preflight are throttled
  10/min. Deferred from the lane because bolting a limiter onto the busiest admin endpoint
  risks every existing edit flow and the rate-limiter-bound test debt (TST-3) for a threat
  that needs valid admin credentials. ~~Decide deliberately~~ **DECIDED 2026-08-14 (Dallas):
  parity gap ACCEPTED, no limiter.** The threat needs valid admin credentials (two humans),
  the client-fan-out paths are already throttled, and a 10/min trip on the busiest editor
  endpoint costs more than it protects. Revisit only if manager accounts multiply or a
  portal ever writes through this route. (security-review, lane fleet 2026-07-22.)
- **Provider idempotency keys (Resend `Idempotency-Key`, Twilio)** are the precondition for
  any future failed-send Retry; without them a timeout-ambiguous retry can double-send. No
  Retry exists by design (spec: rejected alternatives).
- ~~**`server/utils/groupSend.js` is require-dead** (superseded by the proposalSendGroup comms
  action); delete when convenient.~~ **DELETED 2026-08-14 (Dallas-approved)**: file + test
  removed; the porting-history comments in proposalSendGroup.js/groups.js stay as provenance.
  (Deletions physically live in be555426 via the shared-index sweep — see the
  legacy-cc-payments entry's provenance note.)
- ~~**`emailTemplates.rescheduleNotificationClient` is orphaned**~~ **DELETED 2026-08-14
  (7b5be986)**: function + export removed, tombstone comments left at both sites so
  nobody resurrects the pre-rendered-HTML path the spec rejected. emailTemplates.js
  shrank 853→819.
- **ProposalEditorForm.js at ~790 lines** (soft cap 700; **867** after the 2026-08-14
  guest-count guard, still growing): plan a split on the next substantial touch.
- ~~**Suppression skip-reasons surface enum tokens** ("Suppressed: channel_disabled.") in admin
  toasts, on both the receipt path (actions.js) and the refund path (refundClientNotify.js).
  Map to human copy at the source, both call sites together. (code-review, lane-3 fleet.)
  (2026-08-14: two MORE call sites leak the same tokens — `lineItemRemovedNotify.js:87`
  and `rescheduleProposal.js:412-471`; fix all four together or the leak survives.)~~
  **FIXED 2026-08-14 (ed08114f)**: fixed at the source with `suppressionMessage(reason, channel)`
  in `messageSuppression.js`, routed through all 7 occurrences across the 4 files, so a new
  caller gets human copy for free instead of leaking the next enum.

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
  against the RC1 fixtures in `refundHelpers.scope.test.js`. (2026-08-14: the
  netting term now EXISTS — `sumOffContractPaidCents`, `invoiceExtras.js:340-361`,
  shipped in 28f0134f — but is wired only into cancel-line's `overpaymentCents`
  (`lineItemCancel.js:701`); the payment-panel refund path still issues 'contract'
  scope and still shrinks the total. Half the fix is on the shelf.)
- Related, same cause: after a FAILED cancel-line refund the dialog sends the
  admin to the payment panel, which can only issue `'contract'` scope and would
  therefore lower a total the fold already corrected. Until the above is fixed,
  the safe recovery on that path is a manual Stripe-dashboard refund (the
  `charge.refunded` webhook reconciles it) rather than the panel.

**Cancel-line feature**
- `matchCancelTargets` (the ambiguity refusal and amount corroboration) has no
  test: ~~the client has no test runner~~ (stale premise — 2026-08-14: react-scripts
  test + ~20 client test files exist now, so a component test is the natural home),
  and the new server-side test only pins
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
  `drink_plan_extras` row would pin it. (Task 6 review.) (2026-08-14: partially
  closed — `refundHelpers.extensionScope.test.js` now exercises the real query on
  the default panel rails four times plus the wide-rails seam; the specific
  `drink_plan_extras` exclusion assert is still missing.)
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
- ~~**Two docstring over-reaches in `addonQuantity.js`**~~ **FIXED 2026-08-14 (982e6f5a)** — both comments corrected (service_addons CHECK acknowledged; eventCreation named as the hardcoded fourth site). Original, both cheap, design
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
  (2026-08-14: now 810 lines, still growing.)
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
  (2026-08-14: half closed — a `fetchSeqRef` in-flight guard landed in
  ShiftDetail.js, so an older response can no longer paint over a newer one;
  `details` is still never cleared on shiftId change, so the flash remains.)

## TT first-reply push-review residuals (2026-08-03, fleet on 61abacf3/7161e8bf/e3e16899)

- ~~`thumbtack_leads.created_at` is nullable while the offer query leans on it
  in four predicates and the sweep's retirement arm; a NULL row would sit
  `pending` forever, invisible to both. Zero such rows exist today. One
  idempotent line closes it: `ALTER TABLE thumbtack_leads ALTER COLUMN
  created_at SET NOT NULL;`~~ **FIXED 2026-08-14 (9b695af0)**: closed with a guarded
  `DO` block that checks `is_nullable` first, so it is a no-op on an already-tightened
  DB, and runs a defensive UPDATE before the `SET NOT NULL` so a stray NULL cannot
  fail the migration. (db-review, low)
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
- ~~**DEFERRED to the orchestrator's post-merge walkthrough**: the in-app browser
  pass over these surfaces with a settled extension on a dev event, plus
  confirming the Money Board and the events list render that event without
  error.~~ **DONE 2026-08-13** (b323b821: all six surfaces passed, ticked in
  `docs/walkthroughs-owed.md` — staff event details, admin BEO/event page, Money
  Board, events list, calendar feed via curl, client view).

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
  file is at 850 lines (soft cap 700; 869 as of 2026-08-14); the extension tail (`:649-765`) is the
  natural first extraction, matching the `stripeWebhookHandlers/` split
  pattern. The hard-cap ratchet forces this at the next substantial addition
  anyway.
- ~~**Dead `settle_on_closed_event` subject entry.**~~ **DELETED 2026-08-14 (7b5be986)**
  — no caller ever passed the kind; the entry is gone from PROBLEM_SUBJECTS. If the
  closed-event settle check is ever wanted, wire it fresh.
- **Admin panel renders no loading skeleton (cosmetic, deliberate).**
  `ServiceExtensionPanel.js:137-143` returns null on first load (merge-gate
  perf finding: most events have zero extensions, so a skeleton card would
  flash and shove the cards below it on nearly every event view). Nuance vs
  the merge-gate note that called the skeleton class "unused": `.sp-skeleton`
  (`index.css:19431`) IS still used by the two staff surfaces
  (`RequestMoreTime.js:70`, `ShiftDetail.js:639`); only the admin-panel usage
  is gone. ~~The CSS comment at `index.css:19430` still says "+ admin panel",
  which now overstates.~~ **Comment trimmed 2026-08-14 (8045743e)**; the
  no-skeleton panel itself stays deliberate.

**Gratuity election, push-review note (2026-08-04)**
- `stripeCreateIntent.js` mints a second identical intent when a pending
  election-bearing intent matches the request's amount AND election exactly
  (documented in-code as accepted; matches prior behavior; damage shape =
  visible double payment, refund one). Codex push-review suggests the safe
  hardening: when metadata AND amount match the CURRENT request exactly, the
  election is not stale, so returning the existing intent's clientSecret is
  safe and removes the double-charge window. Behavior change on a money path;
  do it deliberately, with the gratuityApply suite extended. (low)
  **DECIDED 2026-08-14 (Dallas): leave it, documented-as-accepted.** Protect-working-paths:
  the gratuity machinery is freshly reworked and prod-verified, no double-charge has ever
  occurred, and the edge is self-announcing + cleanly refundable when it fires. Revisit
  only if it actually bites; then it's a small deliberate lane + money fleet.

- ~~`server/utils/balanceReminderScheduling.test.js` hardcodes `balance_due_date = '2026-07-15'`~~
  **FIXED** (bf4139f4, 2026-08-13: re-fixtured with rolling years, 2/2 green; the DST math was
  never wrong). Found by the display-name Task 14 gate, 2026-08-04.
- ~~`server/utils/payrollDisputeNotify.test.js:323` asserts elapsed < 400ms; observed 477ms under
  serial-suite load, 12/12 green in isolation. Loosen the bound or restructure the timing
  assertion.~~ **FIXED 2026-08-14 (9b695af0)**: restructured rather than loosened. The test now
  asserts structurally, on a flag proving the call returned without awaiting the slow send,
  so it pins the actual property instead of a wall-clock number that drifts with load. (low)
- Whole-tree serial suite runs need `NODE_ENV=test` (calcom.test.js + drinkPlanConsult.test.js
  self-guard and abort at module load without it) — plan gates citing "run the full server
  suite" must carry the env var; display-name plan rev 3.3 records it. (note)

## Push-gate residuals 2026-08-05 (display-name + seniority + sms-optin batch — all non-blocking, batch pushed)

- `scripts/testdb-smoke.js` cannot fail on a failed schema statement: `initDb()` logs+Sentry's
  per-statement errors and RESOLVES, so the child exits 0 and the gate passes while a
  constraint silently didn't build. Make the smoke child assert zero unexpected failures.
  The gate's strongest claim is currently unenforceable. (med, gate hardening)
- ~~Post-commit `refreshDisplayName` UNCONTAINED at admin/users.js, me.js, staffPortal.js,
  contractorTipPage.js~~ **FIXED** (c10ae187, lane gate-fixes-0805: try/catch +
  Sentry.captureException at all five sites, each carrying the "Contained (contractor.js
  pattern)" comment — 2026-08-14 audit).
- `refreshDisplayName` SELECT-then-UPDATE is unlocked: two concurrent name saves for the SAME
  user can persist a stale display_name (adjudicated acceptable at checkpoint 1; `--check`
  detects, next save heals). Optional: `SELECT ... FOR UPDATE` inside a tx. (low)
- ~~`sanitizeProfile` (contractor.js) policy drift: `preferred_name_reviewed_at` rides the staff
  self-profile response~~ **DONE** (`contractor.js:29` destructures it out; see the 8/06
  aftermath note below).
- `email_leads` unique index is on raw `email` (not LOWER): the "can't resurrect an unsubscribed
  lead" guard is defeatable via any uppercase-stored row (PUT /leads/:id writes verbatim;
  legacy rows). Pre-existing (capture-lead has it live); smsOptIn now relies on it. Normalize
  the column + retarget the index/ON CONFLICTs together. Also: the upsert's
  `COALESCE(email_leads.name, EXCLUDED.name)` is dead (`name` NOT NULL) — an 'Unknown' from
  capture-lead is never upgraded to a real name. (low)
- ~~`staffDisplayName.validate.js` NAME_CHARS is ASCII-only~~ **FIXED 2026-08-14 (Dallas:
  "widen")**: `/^[\p{L}][\p{L} .'-]*$/u` in BOTH copies — the entry missed that a client
  mirror exists (`client/src/utils/preferredName.js:93`); both widened together with
  keep-in-sync comments. Tests extended both sides (José/Renée/Zoë/Núñez/D'Ángelo/Søren/李娜
  accepted; digit-among-unicode and emoji rejected): server 39/39 + 24/24, client 44/44.
  (low, gemini catch)
- ~~Seniority panel: clearing the Historical-events box sends 0 (parseInt||0), bypassing the PUT's
  ''-keep path~~ **FIXED** (c10ae187: `AdminUserDetail.js:295-303` sends raw trimmed strings,
  "leave blank to keep current · type 0 to zero" helper copy at `PayoutsTab.js:209` —
  2026-08-14 audit).
- ~~New batch suites are NOT on `scripts/money-smoke-list.txt` (incl. payrollTax.legalName.test.js —
  the 1099 name path). Add deliberately, not mid-push: the gate would immediately run them
  prod-shaped.~~ **RESOLVED BY DECISION 2026-08-14 (9b695af0)**: `payrollTax.legalName` added
  (it is the 1099 name path, and it qualifies: 3/3 in 1.5s). The other three are deliberately
  left off, each with a reason, so this is settled rather than open: `smsOptIn` is
  rate-limiter-bound, `displayName` is not a money path, and `seniority` execFiles a CLI that
  does DDL. (note)

## 8/06 push aftermath (display-name + seniority batch shipped 677baf95)

- `sanitizeProfile` `preferred_name_reviewed_at` item ABOVE is DONE (shipped in gate-fixes-0805). (done)
- ~~Prod data hygiene: two probable duplicate-person pairs share a phone AND a name —
  users 39/40 ("Felicia", 40 has the trailing-space variant, 219-804-3426) and 51/62
  ("Adelle", two emails, 312-371-6554). The smsInbound shared-number tiebreak between each
  pair was a literal updated_at TIE pre-backfill (already arbitrary); 40 now wins its pair
  (trim stamp). Real fix is a human merge/deactivate of the dupes, not code. (med, ops)~~
  **LARGELY STALE — re-verified against PROD 2026-08-14.** The dedupe already happened:
  in BOTH pairs the second row is `onboarding_status='deactivated'` (40 and 62, both stamped
  2026-08-06) and the first is `hired` (39 and 51). And the tiebreak worry is moot by
  construction, not by luck: `findStaffCandidatesByPhone` (`smsInbound.js:188`) and its
  sibling at `:156` both exclude `deactivated/rejected/suspended`, so each number now
  resolves to exactly ONE candidate and the `ORDER BY cp.updated_at DESC` never arbitrates.
  Note the deactivated rows carry the LATER `updated_at`, so without that exclusion the
  dead account would have won both pairs; the block-list is load-bearing here, not cosmetic.
  Neither pair has any `shift_requests`, so there is no work history to merge.
  **No residual, and a correction worth keeping.** A first pass here read the Adelle pair as
  having its good data split, because live 51 holds `hire_date` 2025-06-26 and
  `historical_events_worked=2` with `can_staff=false`, while dead 62 holds `can_staff=true`
  and no hire_date. That is NOT a split: `can_staff` is a MANAGER permission, not a
  "this person can be staffed" flag. Every guard reads it as
  `role === 'manager' && can_staff` (`shifts.js:41`, `admin/users.js:464`), and it is only
  ever written by the manager routes (`admin/managers.js:33,44`, `admin/users.js:452`).
  On a `role='staff'` row it is inert, so both Adelle rows are correct as they sit and
  nothing needs moving. Same for user 61, whose `can_staff=true` is equally inert.
  Both pairs are fully closed.
- Backfill hand-fix names (script report, informational): users 15 "Ariel D. Smith",
  31 "Nicholas or Nick", 61 "Miss Taylor", 62 "Adelle M. Reynolds" — malformed preferred
  names to settle with the humans; users 1/61/62/237 have no legal name on file. (ops)
  **TRIAGED + LARGELY SETTLED against PROD 2026-08-14.** Only two of the five were live,
  and only two rows in the whole table rendered a bad display name.
  - **61 — FIXED IN PROD 2026-08-14 (Dallas supplied the name: "Taylor Hogan").** She is
    `hired`, `can_staff=true`, hire_date 2025-10-24, 3 events worked, and was rendering as
    **"Miss T."** on every roster, BEO and staff surface that reads `display_name`. She has
    NO legal name anywhere (no `agreements` row, no `applications` row), so
    `computeDisplayName` takes the `initialSource='preferred'` fallback and draws the
    initial from the preferred name's own last token. Set `preferred_name='Taylor Hogan'`,
    `display_name='Taylor H.'`, `preferred_name_reviewed_at=NOW()` (stamped, NOT cleared:
    the owner just blessed this name, so re-raising the §3.5 notice would be a lie), guarded
    with `IS DISTINCT FROM`. Her phone is unique in the table, so the `updated_at` trigger
    stamp cannot re-aim any smsInbound tiebreak. Old value banked here for reversibility:
    `preferred_name='Miss Taylor'`, `display_name='Miss T.'`, reviewed_at 2026-08-06.
  - **31 — CLOSED 2026-08-14 as an OFFBOARDING, not a name fix. Dallas: "nick can be
    removed he got fired... no notice. its been like a year."** The name was never the
    issue. Deactivated in prod by hand: `onboarding_status='deactivated'`,
    `pre_hired=false` (that flag is a one-time bypass of the admin-review gate, so leaving
    it set would let him re-register himself later), guarded `IS DISTINCT FROM`.
    `preferred_name` deliberately LEFT as "Nicholas or Nick" — he is off the roster, so
    rewriting a fired person's name buys nothing.
    Verified before the flip that this was a clean one-field change: NO `payment_profiles`
    row, so `deactivateTipPage` would have been a no-op with no tip page or Stripe link to
    tear down; zero `shift_requests`, zero payouts, no `hire_date`. He signed an agreement
    ("Nicholas George DiCristina") and never worked a shift. The agreement row is kept.
    **Why by hand instead of the UI:** `PUT /admin/users/:id/status` sends
    `applicationDeactivated` to the person ("...if you believe this was done in error, or
    if you have questions, please reply to this email"), and Dallas explicitly did not want
    a notice a year after the fact. The route's other side effects were reproduced
    faithfully: the `interview_notes` status_change row ("Hired → Deactivated") and the
    `application_activity` row, both actor 12. The activity `via` is recorded honestly as
    `manual_sql_offboarding`, NOT the route's `admin_users_endpoint`, and carries
    `notice_suppressed: true` so the missing email is a recorded decision rather than a gap.
    Lockout is immediate and needs no `token_version` bump: `middleware/auth.js` re-reads
    `onboarding_status` per request and `auth.js:339` blocks the login outright.
  - **15 and 62 are NOT broken and need nothing.** Both are `deactivated`, and both already
    render correctly anyway ("Ariel D. Smith" -> "Ariel S.", "Adelle M. Reynolds" ->
    "Adelle R."): the middle-initial pop and the legal-surname pop both did their job. They
    were flagged for having over-long *stored* values, not bad output.
  - **237 is not a name problem at all.** It is an import placeholder
    (`import_source='payment_history_import'`, `@imported.invalid` email, `pre_hired`,
    `in_progress`) and belongs with the import backlog.

  **Class check, so this does not come back:** a prod sweep for title-prefixed or 3+ word
  preferred names returns exactly the rows above. Taylor was the ONLY title-prefixed row in
  the table, and after her fix user 31 is the only remaining bad `display_name` in prod.
  Worth knowing why she survived: `validatePreferredName` rejects a leading title and caps
  at two words, but `computeDisplayName` never STRIPS one, and the change-validator
  deliberately grandfathers an unchanged legacy value so nobody is locked out of editing
  their own phone. So pre-validator rows keep their titles forever unless an admin settles
  them by hand. That is working as designed, but it means the fix is always ops, never code.
- ~~`toYmd` in applySeniorityBackfill/generateSeniorityMapping assumes UTC-or-negative offset
  (`toISOString().slice(0,10)` on a local-midnight Date shifts a day on UTC+X boxes). Fails
  CLOSED (false PARTIAL, exit 1), never corrupts. Fine on Chicago box + Render/UTC.~~
  **FIXED 2026-08-14 (9b695af0)**: both copies now read the local calendar date and are
  byte-identical to each other; verified under `TZ=Asia/Tokyo`. **The same shape is repo-wide
  and one instance is a MONEY path: see the 8/14 wave-2 findings section at the end.** (low)
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
  bare/second-source name reads flagged by the display-name code review — ~~gratuityStaffNotice
  selects bare preferred_name on a money-adjacent notice~~ **FIXED 2026-08-14 (ed08114f)**: now
  `COALESCE(display_name, preferred_name)`; 4 of 79 rows were being greeted "Hi there," and now
  get a name. **STILL OPEN:** the roster recomputes display name
  live (util-based, but `--check` cannot see drift there, and JS || vs SQL COALESCE diverge on
  empty-string legal names — 0 such rows today). Sensitive paths; deliberate no-touch at the
  gate. (low)
- Post-deploy owed — 2 of 4 DONE (2026-08-14 audit): ~~`refreshDisplayNames.js --check` against
  prod~~ **DONE** (93875bd9, 8/14: 62 rows clean); ~~Stripe test Payment Links deactivation~~
  **DONE** (06552c8c, 8/14: verified inactive via live API). Still owed: Dallas walkthroughs
  T6/T10-T13 + seniority panel smoke; CC seniority mapping generation → hand review → --apply
  (human-gated, Chicago box). (ops)

## From the duty-pay review fleet (2026-08-06)

- **v1 LogisticsStep parking preview mis-quotes**: `client/src/pages/plan/steps/LogisticsStep.js:41-42, 155-159` previews `$20 x num_bartenders` while the server bills per_staff over ALL staff (bartenders + additional-bartender + barback + banquet-server). Live-reachable: prod still carries v1 draft/pending plans (e.g. plan 69 / proposal 472: shown $40, billed $60). Was already ordered in spec 2026-07-01-paynow-extras-addon-pricing-design.md:92 and never shipped. One-line fix, outside the parking-rewire lane's footprint.
- **Explicit-empty syrupSelections still strips contract syrups on submit**: `server/routes/drinkPlans/submit.js` — the 2026-08-06 guard treats an ABSENT syrupSelections key as "carry contract syrups forward", but an explicit `[]`/`{}` still enters the fold and strips. Pre-existing on main (unvalidated `rawAddonSlugs` already opens the fold); candidate fix: normalize in submitSanitize.js, or treat empty-on-a-no-syrup-UI planner version as "no opinion". (security, low)
- **paid_separately submit dodges the parking fee**: deliberate 2026-08-06 hardening (half-billed state was worse); a pay-now v2 submit with paid parking attaches nothing, so the fee is admin-added later or missed. Revenue-miss direction only. (low)
- **Out-of-area residuals (fleet-cleared 2026-08-06, merge a106defd; pruned after the
  duty-residuals lane, merge afb6e5e6 2026-08-07)**: (1) `staff_within_40` field name +
  "within 40 miles" copy in `RemoteStaffingFeePrompt.js:181` hard-couple
  `REMOTE_STAFF_RADIUS_MILES` across three semantics (proximity radius, prompt floor, frozen
  copy) — changing the constant silently breaks the others. (2) Legacy ungated geocoders at
  `shifts.js` + `shifts.handlers.js` write city-centroid lat/lng to `shifts.lat/lng`,
  which now feed venue/home distance surfaces and the band suggestion (advisory only; admin
  types the amount). (3) Approve/deny/assign lock stamp+release are separate autocommit
  statements (millisecond window, admin-only, pre-notification). (all low)
  CLOSED by duty-residuals: same-value dead-end (true no-op + tightened disable), queue-ordering
  test, ShiftDrawer knob (spec §9). DECIDED: no `min_locked_cents` floor — Dallas 2026-08-07,
  remove-then-lower flexibility is deliberate, audit trail suffices; do not re-raise.

## From the push-time gate (2026-08-07, fleet + codex on the 20-commit batch)

- **`listUnattributedDuties` N+1**: one `loadProposalDutyContext` (5-6 queries) per completed
  proposal per Process attempt; fine at <=9 proposals/week, JOIN or Promise.all it if periods
  grow ~10x. Related: `loadProposalDutyContext` re-SELECTs the proposal + roster that
  `accruePayoutsForProposal` already holds; `checkContractCurfew` + `maxDurationHoursBeforeCurfew`
  double-read the same proposal row. (low)
- **Curfew-unguarded admin/system duration writers** (documented in ARCHITECTURE as deliberate):
  shifts.js admin mint, thumbtackProposalDraft, proposalGroups clone, seeds/imports. Closing them
  is this fix-list's work, not silent coverage. (low)
  CLOSED by the duty-residuals lane (merge afb6e5e6, 2026-08-07): hosted_supplies clamp
  (structurally moot — flat $50 per Dallas, announced to staff); geocode elapsed-time throttle +
  depth-4 background shedding (negative caching deliberately DECLINED — a failed address must
  stay retryable; documented in serviceArea.js); create.js now uses the shared curfewMessage;
  serviceExtensionPricing carries its own JS pre-screen; both stale-comment/filename nits
  (test renamed to eventEndInstant.curfew.test.js, smoke list updated).

## Phone 1a — interception canary is aimed at the wrong signature (2026-08-11) — RESOLVED: option (a) SHIPPED 2026-08-14

**Dallas picked (a), demote to log-only.** The Sentry page + its claim throttle are gone;
the per-call `dialSec` console line stays as honest telemetry (SUSPECT still marked in the
log), `interceptionSuspicion` itself is kept and test-pinned, and the voice.test canary
case now asserts NO page on a fast human answer (voice 67/67, voicemailLine 9/9). Option
(c), the press-1 screening whisper, is the on-the-shelf conclusive fix if an interception
is ever actually observed — the code already exists in voiceEscalate.js. Original finding:

`interceptionSuspicion` (`server/utils/voicemailLine.js`) fires when the dialed leg's
`DialCallDuration` is <= 3s. That value is the leg's CONNECTED duration, not its
time-to-answer, so the detector is inverted in practice:

- A REAL Google Voice voicemail interception answers in ~1s and then holds the caller
  through a greeting and a message — a LONG connected leg. Canary stays silent.
- A human answering fast and hanging up (a rejected robocall, or Dallas answering his
  own test call) is a SHORT connected leg. Canary fires.

Confirmed live 2026-08-11: Dallas answered his own 1922 test at ~2s, the canary paged
(DRBARTENDER-SERVER-20, resolved as a false positive), and the follow-up call that
genuinely rang out delivered correctly through our path. The pre-merge code review
predicted this exact false positive; it shipped deliberately and the first real call
proved it out.

Options, cheapest first: (a) demote to log-only — keep the per-call `dialSec` line for
Twilio-console reconciliation, drop the Sentry page, which is honest telemetry rather
than a detector; (b) derive real answer latency by fetching the child call via
`req.body.DialCallSid` (date_created -> start_time) on a detached path after the TwiML
is sent; (c) the conclusive fix — a `<Number url=...>` screening whisper on the primary
dial leg, the same keypress gate the press-1 escalation already uses, which a machine
cannot satisfy. (c) is the only one that PREVENTS interception rather than reporting it,
and the code already exists in voiceEscalate.js.

## Dallas fix-list drop 2026-08-10 (11 items, triaged)

Raw drop, verified against code before triage. Ordering below is the recommended build
order.

**STATUS 2026-08-11 (updated at the push):** items 1, 3, 4, 5, 6 are **LIVE IN PROD** —
pushed 2026-08-11 in the 34-commit batch `e0f777b7..b27b6d4e`, behind the full push fleet
(6 agents), a clean cross-LLM second opinion (codex + gemini both NO FINDINGS), all 42
money-path smoke suites green against ci-smoke, and the CI client build. Item 1 was
already live on the box before the push (agent-only change) and still owes its
next-real-lead proof. Item 5 shipped with a fix the fleet caught pre-push: the greeting
sweep would have dropped the partner for the 9 couple-named clients, closed in `dacd1619`
(see item 21 below for the residual test-coverage gap). Item 2 is NOT built, its mechanism
did not survive scrutiny, see below. Item 7 is blocked on Dallas naming the new cap.
Items 8-11 are unstarted.

### P0 — live regression, costing leads right now

1. **TT first reply is broken again, and it IS a Thumbtack change (CONFIRMED).**
   Dallas: "Thumbtack may have changed. first reply didn't seem to fire." He is right.
   Evidence from the box (`journalctl --user -u thumbtack-agent`): lead
   587060300545875971 sent fine 8/08 11:19, then BOTH 8/10 leads failed
   `ai_draft_clear_failed` (587240325025259524 at 13:19, 587259547793113095 at 18:39),
   and 587243737936961539 hit `already_replied` at 14:16 because Dallas beat it manually.
   Root cause pinned from the diag captures in `~/.thumbtack-profile/diag/`: **the Clear
   control no longer exists on the respond panel.** Both 8/10 dumps show an AI draft
   sitting in the composer (`len` 306 and 234) and ZERO buttons whose text or aria
   contains "clear". The 8/03 fix (738cb32e) pinned that chip as aria "Clear message";
   TT has since removed or renamed it. `clearAiDraft`
   (`thumbtack-agent/src/index.js:281`) can only clear by clicking a labeled control, so
   `pickByLabelPriority` returns null, the loop spins out its budget, and the reply dies
   before the quick-reply pick. Everything downstream is healthy: "Use your quick reply"
   and "Send" are both present in the dumps, session is valid, harvest works.
   **Fix: stop depending on a Clear control existing.** Add a programmatic fallback to
   `clearAiDraft` (focus the composer textarea, select-all + delete, or `fill('')`), keep
   the label click as the preferred path, and keep the existing empty-proof read-twice
   beat so a mid-stream AI fragment still cannot reach the send. The strict
   `boxText === ''` send-verify law is unchanged and becomes the thing that proves it.
   Agent-only change (box), no server change, no push required to test.
   See [[project-tt-auto-first-reply]].
   **BUILT + LIVE 2026-08-11.** `clearComposer()` added next to `composerText()` (both now
   share one `composerBox()` locator so the read path and the clear path cannot drift),
   and `clearAiDraft` falls through to it when `pickByLabelPriority` finds no Clear
   control. The read-twice empty proof and the strict `boxText === ''` send verify are
   untouched, so the guarantee is unchanged; only the means of getting there is cheaper.
   Agent tests 8/8; service restarted 05:24Z on the new code (journal 19 ids intact,
   nothing was in flight). PROOF STILL OWED: the next real lead.

### P1 — data loss and wrong-on-its-face output

2. **Adding a client: picking "Other" for Source navigates away and drops the
   in-progress client. MECHANISM NOT YET ESTABLISHED — needs a live repro.**
   The obvious suspect does NOT hold up. `ClickableRow`
   (`client/src/components/ClickableRow.js`) does activate on **mouseUp** (line 37) and
   the add-client form does sit directly above the table in
   `client/src/pages/admin/ClientsDashboard.js`, which suggested a native `<select>`
   popup passing its mouseUp through to the row underneath. But `onMouseDown` (line 32)
   stashes `pressRef` per row, and `onMouseUp` returns immediately when it is null
   (line 40). A mousedown on the select above the table sets no row's `pressRef`, so a
   stray mouseUp on a row should be a no-op. Line 46 additionally bails when the event
   target is inside `button, a, input, select, textarea, [role="button"]`. So the row
   already defends against the story that fits the symptom, and the real path is
   something else.
   Other candidates not yet ruled out: the `<select>` sits inside the `<form>`, so a
   keyboard-committed choice could submit; `RowLink`/`EntityLink` anchors inside the row
   are separate activation paths; or the click landed on a row's Source chip rather than
   the dropdown (row 1 under the default `recent` sort IS the most recently added
   client, which matches the symptom exactly).
   NOT reproducible via Playwright: a native select popup is an out-of-DOM widget that
   automation cannot drive, so this needs Dallas to reproduce it once with devtools open,
   or a temporary listener logging mousedown/mouseup/click targets plus navigation.
   Ask him: did he click the option with the mouse or commit it with the keyboard, and
   did the form disappear at the moment of the click or on submit?

3. **Staff-portal recipes render `· [object Object]` (ROOT CAUSE CONFIRMED).**
   `cocktails.ingredients` / `mocktails.ingredients` are JSONB arrays of OBJECTS
   (`{ingredient, amount, ...}`), which the server generator handles explicitly
   (`server/utils/shoppingList.js:265`: `typeof row === 'string' ? row : row.ingredient`).
   `BeoDrinkRow` in `client/src/components/staff/BeoSections.js:476` does
   `String(line || '').trim()` on each entry, so every object stringifies to
   `[object Object]` and falls to the `· {s}` branch. Bartenders cannot read a spec at
   the bar. Client-only fix in one component: normalize each row to
   `{qty, name}` (object → `amount` + `ingredient`, string → the existing regex split)
   and render both shapes. `resolveDrinks` (`client/src/pages/staff/ShiftDetail.js:737`)
   passes the raw catalog value straight through, so it can stay as-is.
   ALSO CHECK while in there: `buildGeneratorInputFromConsult`
   (`server/utils/shoppingList.js:534` and `:540`) runs the same `String(i).trim()`
   coercion over `customCocktails[].ingredients`. Those are believed to be strings from
   the consult form, but if a custom recipe ever arrives object-shaped it would poison a
   real shopping list. Confirm the shape before deciding whether it needs the same guard.
   **BUILT 2026-08-11.** Shape confirmed against the dev DB: rows are
   `{ingredient, amount, unit, note?}`. New `ingredientParts()` in BeoSections.js
   normalizes object OR string rows to `{qty, name}`; `unit: 'each'` drops the unit so a
   card reads "2 Strawberries" not "2 each Strawberries", and `note` renders in parens.
   (2026-08-14 audit: the ALSO-CHECK guard was never added — `shoppingList.js:535,541`
   still run `String(i).trim()` over `customCocktails[].ingredients`; strings-only holds
   today, but an object-shaped custom recipe would still poison a real shopping list.)
   Every row now goes through the aligned two-span markup (the old string fallback used a
   bare `· ` line), which `.sp-drink-ings-qty { min-width: 56px }` already columnizes.
   The shoppingList.js custom-drink coercion is still UNCHECKED.

### P2 — cheap, high friction-per-line

4. **Inbound auto-responder should name the staffer.** Three admin alerts in
   `server/utils/smsInbound.js` say "A staff member" when the identity is already in
   scope: line 688 (CANT with no upcoming shift), 704 (CANT lost a race), 709 (freeform,
   the common one). `sender.staffUserId` is resolved by `lookupSender` before the branch,
   and `findStaffCandidatesByPhone` / `resolveShiftResponder` have already run on the
   CANT paths. Include name and phone, and on the no-shift/ambiguous paths list the
   candidate names rather than just user ids (the ambiguous alert at line 671 prints bare
   `user ids`, which is the same complaint one level down). Fold the whole file's alert
   copy in one pass.
   **BUILT 2026-08-11.** New `describeStaff(userIds)` helper labels ids as
   "Display Name (user N)", preferring display_name then preferred_name then email, and
   degrading to the bare "user N" it replaced on any failure so an alert can never be
   lost to the lookup. Applied to all four alerts (ambiguous, CANT-no-shift, CANT-race,
   freeform); each now also carries the sender's number. Suite 42/42.

5. **Message greetings should be first name only.** "Hi Monica Donnely," reads wrong.
   The codebase already has first-name handling in at least six places
   (`marketingHandlers.js:42`, `preEventHandlers.js:41`, `drinkPlanNudge.js:129`,
   `lifecycleEmailTemplates.js:746`, `rescheduleProposal.js:293`,
   `ccWrapUpEmailTemplate.js:4`), so the newer templates use `first` while most of
   `emailTemplates.js` still interpolates the full `name`. Fix is a single shared
   `firstNameOf` helper applied at every `Hi ${name}` site, plus dedup of the five
   near-identical local copies. Touches a lot of template lines but is behavior-inert
   otherwise. Watch the SMS templates too.
   **BUILT 2026-08-11.** New `server/utils/firstName.js` exporting `firstNameOf`, which
   reuses the `TITLES` set from staffDisplayName.js rather than duplicating that judgment,
   so "Dr. Monica Donnely" greets as "Monica" and a name that is ONLY a title falls to
   "there". Applied at all 100 greeting sites across 10 template files as
   `Hi ${firstNameOf(x)}` / `Hi ${esc(firstNameOf(x))}`. Deliberately wrapped AT the
   greeting rather than at each `const name =`, because several of those same `name`
   variables feed admin-facing copy ("A client ...") that must keep the full name.
   The helper is idempotent, which also closed a latent bug: `first` was
   `clientFirstName || clientName || 'there'`, so it silently fell back to the FULL name
   whenever clientFirstName was absent. Removed the duplicate local helper in
   drinkPlanNudge.js (it collided with the import). SMS templates have zero greetings.
   Suites green: emailTemplates.parts 12, lifecycle 8, marketing 21, smsTemplates 34,
   comms 8 (one assertion updated to pin the new contract), drinkPlanNudge 9,
   preEventHandlers 15, staffDisplayName 24, beoHandlers 21. CI client build exit 0.
   RESIDUAL: the local firstName helpers in marketingHandlers.js / preEventHandlers.js
   are now redundant (their output gets re-narrowed idempotently). Left in place to keep
   this change out of the *Handlers.js sensitive path; fold them in a later pass.

6. **Guest count at the top of the event details page.** `EventDetailPage.js:501` already
   renders `{guest_count} guests · {hours}hr`, but gated on `event_duration_hours` also
   being non-null and sitting below the fold. Surface guest count in the header block
   independently of duration.
   **BUILT 2026-08-11.** Appended to the header date/time line, gated only on
   `guest_count != null`, so it reads "Sat, Aug 16 · setup 4:00 PM · service 5-10 PM ·
   120 guests". The pricing-card copy is left alone.

7. ~~**Alternatives: allow more than 3 options.**~~ **NO LONGER BLOCKED ON A NUMBER, and no
   longer its own item.** Absorbed by the compare-and-book spec
   (`superpowers/specs/2026-08-11-proposal-compare-and-book-design.md`, §2): sibling
   proposals stop being how alternatives are expressed, so "there is no cap to raise" and
   the `MAX_OPTIONS = 3` question dissolves. Do NOT ask Dallas for a new cap number; that
   question was retired by the design, not answered.
   Historical detail if the spec is ever abandoned: the cap is `MAX_OPTIONS = 3` in
   `server/utils/proposalGroups.js:14` (enforced at line 82), mirrored client-side as
   `members.length < 3` at `client/src/pages/admin/AlternativesPanel.js:32`, with the test
   at `proposalGroups.test.js:70` reading the constant. All three move together.

### P3 — design work, needs a session

8. **Client-facing alternatives/compare surface is unreadable.** Dallas: "the list is run
   together and hard to compare. bullets or something would be better." Surface is
   `client/src/pages/proposal/compare/ProposalCompare.js` + `PackageMatrix.js`. Note
   there is ALREADY a reskin prompt doc parked for this page
   (`docs/compare-page-design-prompt.md`, sitting since 7/02, listed above under design
   sessions), and the known finding there is that the page renders light because it
   references undefined tokens. This item is comprehension, not just skin, so the prompt
   doc needs a comparability section: per-option bullets, aligned rows so options can be
   read across, and a defined behavior at more than 3 options. `?choose=1` and both
   redirect effects are load-bearing and untouchable.

9. **Staff portal skin work + the staff portal menu.** Dallas: "Field guide shows in
   marketing/admin hybrid skin." `client/src/pages/FieldGuide.js` is reachable from the
   staff portal but is not wearing the staff skin. There is an existing unresolved scope
   call above ("Classes / field guide: restyle existing OR new marketing/content pages?")
   that this collides with, so settle that first. ~~Dallas's sentence about the staff
   portal menu was cut off mid-thought ("staff portal menu is") and needs re-asking.~~
   **RE-ASKED 2026-08-14 — the sentence finishes: the staff portal menu "works, but is
   icky. maybe a pass with the claude.ai/design."** And the classes collision resolved
   the same day (classes ON HOLD), so item 9 is now scopeable as: a Dallas-driven
   claude.ai/design session over the staff-portal skin — the menu/nav plus FieldGuide —
   subject to the design-artifacts-are-contracts custody rules in CLAUDE.md (visual
   contract in the spec, a lane that owns match-the-artifact, ui-ux-review against it).

10. **Price guide lookup tool.** Dallas: "If somebody wants to know how much xyz or what
    comes in 'the Full Compound' I want to be able to look it up real quick." Admin for
    sure, possibly marketing-facing too, which is the scope call. The data already exists
    (packages, add-ons, and their descriptions are seeded in `schema.sql`; the pricing
    engine is the authority on how they combine), so an admin lookup is mostly a read
    surface over existing tables rather than new content. A marketing-facing version is a
    different and much bigger thing: public pricing is a business decision, and it would
    need to stay in sync with the engine or it becomes a liability. Recommend building
    the admin lookup first and deciding on public exposure after seeing it.
    **2026-08-14 (Dallas): "this needs a proper brainstorm at some point"** — no scope
    decision taken; queued for a real brainstorm session, admin-first recommendation
    on the table when it happens.

### Scope call, not yet a build

11. **Wedding Pro / The Knot leads — PROMOTED to a queued project (2026-08-14).**
    Dallas: "we need to do it soonish, but its a whole project. We get leads, but don't
    really do anything with them." So the answer to the old ambiguity is (a)-shaped:
    real leads arrive on those platforms today and go unworked — revenue on the floor.
    Whole-project treatment: brainstorm → spec → plan when picked up (soonish), not a
    quick fix. Design should decide how much of the Thumbtack pipeline shape to reuse
    (harvest → auto first-reply → call bridge) vs start simpler (e.g. lead-email capture
    + notify first), remembering (a) inherits the whole scraper-fragility surface — a UI
    change silently broke the TT pipeline twice in one week.

### Added 2026-08-10 (cross-LLM push review, admin gratuity mandate)

12. **Cleared sub-$50 mandate orphans a paid gratuity.** Found by codex at the
    push-time second opinion on `de23daa3`, confirmed against the code; gemini-pro
    returned NO FINDINGS. In `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`
    the apply-time floor check reads the CURRENT row floor, not the floor the
    PaymentIntent was created under. Sequence: admin sets a mandate BELOW $50/staff/hr,
    the client elects "skip the tip jar" at exactly that mandate (legal — the amended
    CHECK's third disjunct exists for this), admin then CLEARS the mandate while the
    client still holds a live intent, and the client pays. `rowFloor` is now 0, so the
    check falls back to the legacy `tip_jar OR rate >= 50` rule, the sub-50 no-jar
    election fails it, and the gratuity is skipped as `below_floor`. The client is
    charged the gratuity-inclusive amount, `total_price` has already dropped from the
    clear, so `amount_paid` exceeds it and payroll's `extractGratuityCents` finds no
    Gratuity line: DrB holds gratuity money the bartender never receives.
    **Not silent** (fires `warnGratuityApplySkipped('below_floor')` to Sentry with the
    proposal id + metadata) and **not currently reachable** — prod has zero mandates, and
    a mandate at exactly $50/staff/hr or above is immune because the fallback rule passes.
    Only a sub-$50 mandate is exposed.
    Candidate fix (a behavior decision, deliberately NOT made at push time): when no
    mandate remains and the only failing rule is no-jar/sub-50, honor the dollars the
    client actually paid and apply the gratuity with `tip_jar` forced true (which is what
    the clear implied anyway) instead of skipping — the DB CHECK is then satisfied and the
    money reaches payroll. Needs a test and would change the pinned skip-reason on the
    legacy no-mandate path, so it wants its own small lane rather than a drive-by patch.

### Added 2026-08-11 (found while running the vm-listen-link merge gate)

13. ~~**`criticalIndexes.test.js` has been red on main since the duty-pay lane.**~~ **CLOSED 2026-08-13** by `bf4139f4` ("un-redden the two permanently-red suites on main") in another window. Verified green: 6 pass / 0 fail. Original report follows. Two
    assertions in `server/db/criticalIndexes.test.js` compare against hardcoded expected
    arrays that were never updated when `duty_lines` indexes joined the critical list:
    "DB has none of them" expects `['uq_invoice_payments_positive_link']` but gets that
    plus `idx_duty_lines_event_kinds` / `idx_duty_lines_bounty` / `idx_duty_lines_contest`,
    and "DB reports the index present" expects `[]` but gets the same three. Reproduced on
    a clean `main` checkout, so it is not lane contamination.
    This one matters more than a stale fixture normally would: the test's whole job is to
    fail loudly when a critical index is missing from the DB, and it currently fails
    loudly ALL the time. A permanently-red guard is a guard nobody reads, so the next
    genuinely missing index will land in the noise. Fix is to derive the expected arrays
    from the manifest instead of restating it, so adding an index can never redden it.
    **CONFIRMED STALE FIXTURE ONLY, 2026-08-11** (database-review, push gate): no index is
    genuinely missing. All four names in `CRITICAL_INDEXES` — `uq_invoice_payments_positive_link`,
    `idx_duty_lines_event_kinds`, `idx_duty_lines_bounty`, `idx_duty_lines_contest` — were
    verified present in the dev DB AND in prod. The suite is 3 pass / 2 fail, and the one
    test that touches a real database is among the PASSES; both failures are the two
    mock-driven tests whose expected arrays were frozen in the single-element era. So this
    is cheap to close and carries no hidden DB problem behind it.
    **FIXED 2026-08-13**: `CRITICAL_INDEXES` is now exported and both mocks derive from it
    (plus a new one-absent case); adding an index can never redden the suite again. 6/6
    green, verified by running it.

14. ~~**`balanceReminderScheduling.test.js` CDT case is red on main.**~~ **CLOSED 2026-08-13** by the same commit `bf4139f4`. Verified green: 2 pass / 0 fail. So it was the fixture, not the DST math — balance reminders were never firing at the wrong hour. Original report follows. "summer (CDT) anchors
    each reminder to 10:00am Chicago = 15:00Z" asserts `actual: 0, expected: 1`. Also
    reproduced on clean `main`. Reads like a DB-state dependency (it wants a row the
    shared dev DB no longer has) rather than a DST math bug, but that is a guess — it
    needs someone to actually look, because if it IS the DST math then balance reminders
    are firing at the wrong hour for half the year, which is client-facing.
    **CLOSED 2026-08-13 — it was the fixture, and the DST math is PROVEN FINE.** The winter
    (CST) case passed at 16:00Z all along; only the summer fixture's hardcoded
    `balance_due_date '2026-07-15'` had aged into the past, which the scheduler correctly
    skips. Re-fixtured with rolling years (July 15 always CDT with a June-1 cutoff, the
    following Jan 15 always CST), so it cannot age out again. 2/2 green, verified by
    running it. Balance reminders were never firing at the wrong hour.

15. **Two suites need an opt-in env var and silently "fail" without it.**
    `server/routes/calcom.test.js` and `server/routes/drinkPlanConsult.test.js` throw at
    import unless `NODE_ENV=test` or `ALLOW_TEST_DB_WRITES=1` (they DELETE from
    `webhook_events`). The guard is right, but `npm test` does not set either, so the
    documented way to run the suite reports two failures that look like broken code. Give
    the npm script the env var, or make the guard skip the file rather than throw.

16. ~~**Twilio Account SID and full Recording SID reach Sentry unredacted.**~~ **CLOSED 2026-08-11** in the vm-listen-link squash merge (`56d0fcd1`). Two caveats worth carrying, because the close is not shaped like the item. (a) Only the **Account SID** is redacted; the **Recording SID is deliberately kept**, so this item's title still describes live behavior. The Account SID is a per-deployment CONSTANT, byte-identical on every span the system emits, so it carries zero diagnostic value and is half a credential pair (it is the basic-auth username). The Recording SID varies per event and is the only key correlating a Sentry trace to a `voicemail_delivery` row, and it is useless without the credential pair. (b) The fix is **broader than proposed**: rather than adding an `api.twilio.com` path shape, `scrubUrl` redacts the SID pattern wherever it appears, so it covers all four locations named below plus any future one, on both pipelines and in breadcrumbs. Original report follows. Found during
    the sentryScrub review (2026-08-11), verified in a real captured envelope at
    `.spans[].data.url`, `.spans[].data['url.full']`, `.spans[].description`, and
    `.breadcrumbs[].data.url`, from the OUTGOING media GET to Twilio. No credential
    leaks (the auth token rides in a header, `voicemail.js:204-208`), but the Account SID
    is the basic-auth username, so this is half a credential pair sitting in a third-party
    vendor. Pre-existing, unrelated to the listen link. The by-value span scrubbing added
    in `fb3a1e68` gives an obvious place to hang the fix: add the `api.twilio.com` media
    path shape to `scrubUrl` and it is covered on both pipelines at once.

### Added 2026-08-11 (push gate on the 34-commit batch `e0f777b7..b27b6d4e`)

Six-agent fleet plus cross-LLM second opinion (codex + gemini, both NO FINDINGS). Nothing
below blocked the push; all six agents returned SAFE TO PUSH. Recorded here because the
batch shipped and these did not.

17. **`event.extra` is unscrubbed on BOTH Sentry hooks, and `server/index.js` puts a raw
    request URL there.** (security-review, MED.) `sentryScrub.js` scrubs `request`,
    `breadcrumbs`, `contexts.trace`, `tags.route`, `transaction`, and `spans`, and never
    touches `event.extra`. Verified by executing both hooks against a synthetic event.
    Live carrier: the global `fileUpload` middleware is registered before routing, so an
    over-limit body on ANY path fires `limitHandler`, which calls
    `Sentry.captureMessage('upload_limit_exceeded', { extra: { path: req.originalUrl } })`
    — and `beforeSend` ships that URL verbatim. It is not only the voicemail token: the
    same bypass carries `/t/<proposal-token>`, `/api/public/tip/<token>`, and
    `/reset-password/<token>`.
    NOT a live hole — the attacker must already hold the token, so it grants them nothing
    new; what it does is widen that token's audience from one operator to everyone with
    Sentry read access (org members, Seer, exports). That is precisely the property this
    module exists to prevent, and this file has now leaked a token FOUR times across its
    own review plus this one, each time through a channel no key list covered. Fix shape:
    scrub `event.extra` by VALUE on both hooks, the same way the span attributes are done,
    rather than naming another field. (Also worth deciding separately whether
    `limitHandler` should be putting a full URL in telemetry at all.)

18. **Three shadow `firstNameOf` implementations survived the greeting sweep.**
    (consistency-check + code-review, MED.) `bbda4db2` deleted the local copy in
    `server/utils/drinkPlanNudge.js` but left naive `split(/\s+/)[0]` copies in
    `server/utils/comms/actions/drinkPlanNudge.js:128`,
    `server/utils/comms/actions/drinkPlanNudgeReenroll.js:31`, and
    `server/utils/preEventHandlers.js:41` (`marketingHandlers.js:42` is the fourth, named
    as a known residual in the commit message; the other three were not). These feed
    `clientFirstName` into templates that now re-apply the canonical title-aware helper,
    so they stack: `"Dr. Monica Donnely"` → local naive returns `"Dr."` → `firstNameOf("Dr.")`
    sees only a title → the email greets **"Hi there,"**. On the marketing path the
    SUBJECT would read "Dr." while the body reads "there".
    Latent today: 0 of 508 prod client names carry a leading title. But `ARCHITECTURE.md`
    now states `firstNameOf()` is "the single source for the name in every 'Hi ...' line,"
    which is not true while these three exist. Fix: delete all four locals and let the
    templates narrow. They were left in place at the time to keep the change out of the
    `*Handlers.js` sensitive path.
    NOTE: the couples half of this family was FIXED pre-push in `dacd1619` — the helper now
    preserves "Aubrey & Dominic" rather than dropping the partner for the 9 couple-named
    client rows.

19. **`GET /api/voice/vm/:token` has a per-IP limiter but no global or per-token ceiling,
    and buffers the whole recording per request.** (performance-review, 2x MED.) The route
    does have an inline `listenLimiter` (30/60s per IP) — it is not from `rateLimiters.js`,
    which is why it does not grep as `publicLimiter`. What it lacks is the pattern this repo
    already built for exactly this case: `venueSearchGlobalLimiter` (`rateLimiters.js:108-115`)
    exists to stop IP rotation from multiplying a per-IP cap on a paid third-party resource.
    `express-rate-limit` counts requests per window, not requests in flight, so all 30 of an
    IP's budget can simultaneously hold a full mp3 buffer (`voicemail.js:216` does
    `Buffer.from(await res.arrayBuffer())`) for up to the 10s abort timeout. At ~1MB peak
    each that is ~30MB of heap per attacking IP; on a 512MB Render instance roughly 17
    rotated IPs would OOM the process that serves the whole API.
    Second half, same line: there is no cache, and `Cache-Control: no-store` means the
    client can never produce the `If-None-Match`/`If-Range` the ETag code at `:136-165`
    carefully reasons about — so that conditional path is effectively unreachable, and
    iOS Safari's `bytes=0-1` probe-then-body pattern costs TWO full authenticated Twilio
    downloads per playback, plus another per seek.
    Requires a valid token to reach any of it, so this is hardening, not a live hole.

20. ~~**`client/src/utils/downloadFilename.js` is absent from `ARCHITECTURE.md`.**~~
    **DONE 2026-08-14 (982e6f5a)** — added to the tip-page route row in ARCHITECTURE.
    (consistency-check, MED — the one real docs-law miss in the batch.) The docs table
    requires a new util to be mentioned in ARCHITECTURE; it landed in the README tree only.
    The file's own comment says a second private copy "is how two exports start disagreeing
    about what a legal filename is," which is exactly what invisibility in the architecture
    doc invites. One line.
    Related, pre-existing and NOT caused by this batch: `PrivacyPage.js` and `TermsPage.js`
    do not appear in `CLIENT_FACING_SURFACES.md`, a doc that bills itself as "a complete
    map of every surface." They were absent before this batch and still are.

21. **The greeting contract is pinned at one of ~50 template functions.** (code-review, MED.)
    `comms.test.js:83-84` is a genuine contract change (it asserts both directions) but
    covers only `shoppingListReadyParts`. The other greeting assertions in
    `emailTemplates.parts.test.js`, `lifecycleEmailTemplates.test.js`, and
    `remainingActions.test.js` all PREDATE the sweep and pass on paths that already narrowed
    upstream. Consequence: reverting `firstNameOf` in `emailTemplates.js`,
    `staffHiringEmailTemplates.js`, or `marketingEmailTemplates.js` — roughly 62 of the 100
    sites — goes entirely undetected by CI.
    PARTIALLY CLOSED 2026-08-11: `server/utils/firstName.test.js` now exists (19 tests,
    added with the couples fix) and pins the HELPER's contract — couples, titles,
    idempotency, empty and hostile input, non-ASCII, and the non-split of names that merely
    contain the joiner letters. What is still unpinned is the APPLICATION of it at the ~100
    call sites. The cheap version is one rendered-output assertion per template FILE rather
    than per function.

## Compare surface: contract-vs-engine delta re-baselines on first toggle (2026-08-12)

The current option shows `total_price` verbatim on first load and an engine price
after any selection change. When those two disagree, the "Yours" card jumps on the
client's first tap, and every "$X more than yours" delta shifts with it.

They disagree only when the stored total was not produced by today's engine: a
legacy row with a null `pricing_snapshot`, or a catalog rate edited after the
quote went out. Prod has ZERO null-snapshot comparable proposals, so this does
not occur there today; dev has two April rows that do (ids 12 and 15).

The fix is to anchor on the contract rather than swap off it: show
`total_price + (engine price of the client's selection − engine price of the
stored selection)`, so the number only ever moves by what the client actually
changed. Deferred because prod is unaffected and a live pricing fix should not
wait on it. Related: the BYOB tier strip under the card is always engine-priced,
so on a BYOB current proposal the same drift shows as the card and its selected
tier disagreeing.

### Added 2026-08-12 (found by Dallas during the walkthroughs)

**FIXED 2026-08-12 (both instances, one change, on main — not yet pushed).** CSS-only plus a
marker class; behavior-inert, admin-only, no money path. CI client build exit 0 and both
rules verified in the built `main.*.css`, including that the sidebar override lands AFTER the
transparent rule in source order. **Dallas confirmed both surfaces fixed in the app
2026-08-12.** Closed.
Corrections to the original entry below: **StaffReviews.js is NOT affected** — its modal
styles the panel inline (`background: var(--bg-1)`), same as PackageIncludesModal and
NotifyConfirmModal.jsx. **And the first sweep MISSED a file**: it grepped `--include=*.js`,
which silently skips `.jsx`. Re-swept 2026-08-12 with `--include=*.jsx` added and found
`client/src/components/ShoppingList/ShoppingListButton.jsx:110`, a `className="card"` panel
inside a portalled fixed overlay, mounted from `pages/admin/DrinkPlanDetail.js` so it IS
admin-skinned and was genuinely broken. Patched. Final blast radius: **10 files / 12 panels**
(RemoteStaffingFeePrompt and ProposalDetail carry two each).
LESSON: this codebase mixes `.js` and `.jsx` for components. Any component-wide sweep must
pass BOTH or it will under-report and the fix will look complete when it is not.
Fix as landed: a `.modal-card` marker class beside `.card` on all 11 floating panels, plus
one rule giving them `var(--bg-elev)` (the floating-surface token, defined in BOTH skins —
dark's own comment calls it "floating (modal/palette)"); and inside the `max-width: 900px`
block, a light-skin `.sidebar` override restoring an opaque drawer. Both rules carry the
`[data-skin="light"]` attribute deliberately, per the specificity note below.

**THE PATTERN: House Lights sets surfaces transparent by design, and every component that
reuses such a surface as a FLOATING OVERLAY goes see-through.** Two confirmed instances,
found within hours of each other by two different walkthroughs. They are one defect wearing
two hats, and a third will appear the next time someone borrows a light-skin surface for an
overlay — reach for `.modal-card` (or the same `--bg-elev` treatment) rather than inventing
a third private background.

Shared trap for whoever fixes it: `html[data-app="admin-os"][data-skin="light"] .x` outranks
the responsive block's `html[data-app="admin-os"] .x`, and **media queries contribute no
specificity**, so a mobile/overlay rule cannot override the transparent background unless it
matches or exceeds that selector's specificity. Both fixes must be written with that in mind.

**Instance 2 — the mobile sidebar drawer is see-through in House Lights.** Dallas, during the
Money Board walkthrough: "the sidebar is effed in house lights in mobile." NOT the old C1
responsive item — the mobile drawer exists and works (`index.css` ~13340: `.sidebar` becomes
`position: fixed`, `width: 280px`, `transform: translateX(-100%)`, slid in by
`.shell.mobile-nav-open`, with `.header-menu-btn` / `.sidebar-close-btn` revealed). The
defect is purely the skin: `html[data-app="admin-os"][data-skin="light"] .sidebar`
(`index.css:11127`) sets `background: transparent; border-right: 1px solid var(--line-1);
padding: 0 0.1rem`. Correct for a flat desktop column; on mobile that element is a drawer
floating over the page, so the page content reads straight through the nav items. The drawer
carries a `box-shadow` but no fill. After Hours is unaffected because it has **zero**
`[data-skin="dark"] .sidebar` rules and keeps the opaque base.
FIX: give the drawer an opaque surface inside the mobile media query at light-skin
specificity. C1 in the open-threads ledger should be re-described: the responsive work is
DONE, only this skin bug remains.

**Instance 1 — every admin modal is a boxless ghost in House Lights.** Dallas, walking
cancel-line-item on proposal 678: the math was right and both Close and "Never mind" worked,
but "you can't see the dialog box in the House Lights skin."

ROOT CAUSE, confirmed in CSS: `html[data-app="admin-os"][data-skin="light"] .card`
(`client/src/index.css:11346`) is deliberately `background: transparent; border: 0;
border-top: 1px solid var(--ink-1); border-radius: 0; box-shadow: none` — the light skin's
design language, where a card is a flat page section with a hairline rule, not a box. That
is right on a page and wrong in a modal: every admin dialog reuses `className="card"` as
its floating panel over an inline `rgba(0,0,0,0.5)` scrim, so on House Lights the panel has
no surface at all and the content floats on the dimmer. After Hours is fine because
`html[data-app="admin-os"] .card` gives it an opaque `var(--bg-1)` (`:12588`).

BLAST RADIUS — ten files, every one a `className="card"` panel inside a `position: 'fixed'`
overlay: `CancelLineDialog.js`, `CancelEventDialog.js`, `payroll/AttributionModal.js`,
`RemoteStaffingFeePrompt.js`, `applicationDetail/components/RejectModal.js`,
`userDetail/components/AssignToEventModal.js`, `components/adminos/InterviewScheduleModal.js`,
`StaffReviews.js`, `userDetail/AdminUserDetail.js`, `ProposalDetail.js`.
`components/adminos/PackageIncludesModal.js` is NOT affected: it styles its panel inline
instead of borrowing `.card`, which is exactly why it survives.

SAME FAMILY as the 2026-05-17 deferral carried into the re-triaged ledger ("systemic
`.card > *` stacking-context bug across ~6-8 modals, separate broader sweep needed"). That
entry closes with this fix.

FIX SHAPE: do NOT patch ten files with ten inline backgrounds — that is how the copies
drifted in the first place (`AttributionModal.js:7` literally says "Overlay idiom copied
from CancelLineDialog.js"). Introduce ONE shared modal surface: a `modal-overlay` /
`modal-card` pair defined once, opaque in both skins, replacing the duplicated inline
`OVERLAY` const and the bare `className="card"` in all ten. Behavior-inert, admin-only, no
money path — a quick fix on main, but a ten-file one, so run the CI client build before it
lands.

### Added 2026-08-12 (found by Dallas during the Money Board walkthrough)

**The revenue chart silently shows a WHOLE MONTH of money under any sub-month filter, and
only escapes notice because it fails to draw.** Dallas: "the day and week filters don't work
on the chart so anything shorter than a month doesn't show. I think that whole chart is gonna
need a bit of work."

MEASURED against prod 2026-08-12:

| Filter | Buckets returned | Label | What the bucket sums |
|---|---|---|---|
| week 8/06-8/12 | 1 | 2026-08-01 | ALL of August ($4,230) |
| day 8/12 | 1 | 2026-08-01 | ALL of August ($4,230) |

ROOT CAUSE: `qRevenue` (`server/utils/metricsQueries.js:344`) has no granularity concept.
Month is hardcoded in four independent places: the range bounds
(`lo`/`hi` = `date_trunc('month', $n::date)`), the series
(`generate_series(lo, hi, INTERVAL '1 month')`), every one of the ~8 value subqueries
(`>= ms AND < ms + INTERVAL '1 month'`), and the CC-era legs on `legacy_cc_payments` /
`legacy_cc_proposals`. A sub-month range collapses `lo` and `hi` to the same month start, so
`generate_series` yields exactly ONE row and the subqueries sum that entire month.

WHY IT LOOKS LIKE "nothing shows": one data point. `RevenueChartCard.js:256` only renders
"No revenue in this range" at `n === 0`, and n is 1 here, so no message appears — a line
chart just cannot draw a single vertex.

**TRAP, do not fix the symptom.** Making the chart render a point at `n === 1` would EXPOSE
the wrong number rather than fix it: the user would see a full month of revenue labelled as
one day or one week. The blank plot is currently the only thing preventing a wrong money
figure from being read off the dashboard. Either fix the granularity or leave it blank —
never make it draw without fixing the query.

SCOPE (this is a project, not a drive-by; it is a money-reporting surface):
- `qRevenue` needs a real granularity parameter threading through all four hardcoded sites
  plus the CC-era legs.
- Client-side assumes months too: `RevenueChartCard.js:8` documents the series as monthly,
  the x-axis keys are month strings, and the era test is the literal `ERA_MONTH = '2026-05'`
  (`:19`).
- Compare shifts by a whole prior period and mirrors `metricsQueries.priorPeriod`; equal-length
  windows must stay equal-length under day/week granularity.
- LAW constraint: `dashboard-stats` / `financials` response shapes are byte-frozen (see the
  split-by metrics note), so this wants a sibling endpoint or an additive opt-in param, not a
  reshape of the existing response.
- Decide the product question first: at day granularity over a 12-month range you get 365
  buckets. Either the granularity is derived from the range length, or the range picker and
  the granularity picker have to constrain each other.
  **ASKED AND SKIPPED 2026-08-14 (Dallas: "skip for now").** Not decided either way, so the
  project stays unscoped. Recommendation left on the table for whoever picks it up: DERIVE
  the granularity from the range (roughly a month or less draws daily, six months or less
  weekly, longer monthly). One control instead of two, no invalid combinations to design
  around or explain, and it lands on the granularity a human would have picked by hand
  nearly every time; an explicit picker mostly buys the ability to build a bad chart on
  purpose. Reminder for the pickup: the blank chart is PROTECTIVE. Do not make it render at
  `n === 1` without fixing the query, or it will draw a whole month of revenue labelled as
  one day.

### Added 2026-08-12 (found by Dallas during the duty-pay walkthrough)

**A. A blocked duty attribution is a SILENT no-op. No money is owed; the guard is right, the
silence is the defect.**

CORRECTED 2026-08-12 after Dallas: "I don't owe anybody any money. Nobody is owed for 'duty'
except for the most recent pay period. It didn't exist before that." Duty pay shipped
2026-08-07. Period 80 is 2026-07-28..08-03 and ENDED before the feature existed, so proposal
598 (Eliana Stoyanoff, event 08-01, in period 80) could never have accrued a duty line and
nothing is owed to its staffer (user 212). The earlier draft of this entry called that an
unpaid bartender; that was wrong.

WHAT IS ACTUALLY WRONG: `payrollAccrual.js:191` is `if (payPeriod.status !== 'open') { skip }`,
and the transition map has no path back to `open` (`open -> processing -> reopened ->
processing -> paid`; Reopen only ever produces `reopened`). The refusal is CORRECT. It is
also invisible: `PUT /api/admin/payroll/duty-attributions` accepts the request, saves nothing
that pays, and returns as if it worked. The only trace is a Sentry warning.

Live evidence, Sentry `DRBARTENDER-SERVER-21` (substatus **escalating**): 14 occurrences
2026-08-11T21:36 .. 2026-08-12T18:59, `pay_period_status: "reopened"`, `proposalId: 598`.
Fourteen attempts is the tell — an admin re-trying because nothing told him why it did not
take.

**PARTIALLY FIXED 2026-08-13 (the silence, not the policy).** Root cause was more precise than
this entry first said: the SERVER already answers honestly. `payrollDuty.js:335` returns 200
with `accrual.skipped` and `accrual.reason` in the body, and `:333` even audit-logs
`accrual_skipped`. The CLIENT threw it away — `AttributionModal.js` awaited the PUT, caught
only thrown errors, and a 200 carrying `skipped: true` passed as success, so the modal closed
on a no-op. Now read: a skipped accrual becomes a per-row error naming the period status
("Attribution saved, but no pay line was created: this pay period is reopened, not open").
A 200 stays correct because the attribution row genuinely DID save; only the money line did
not, and the copy says exactly that. CI build exit 0.
(2026-08-14 audit — final shape after the 54fb77cb repair: skips render from their own
`notices` state OUTSIDE the row list, proposal label baked in pre-refresh; the per-row
version described above died to the post-submit refresh, see METHOD FAILURE below. The
silence half of this item is genuinely CLOSED; only the policy question remains.)
ALSO 2026-08-13: `server/routes/admin/payrollDuty.js` was NOT on `sensitive-paths.txt` — the
duty routes were split out of `payroll.js` and took the money with them while the emptied
parent kept the listing, so the file that moves duty money was invisible to review-scaling.
Added; matcher test still 6/6.
~~Remaining policy question~~ **SETTLED 2026-08-14 (Dallas: "blessed")**: the current shape is
final — accrual ONLY in `open` periods; a skip is loud (notices) but still saves the
attribution fact, which the sweep-before-payroll picks up when a period opens; no 409, no
`reopened` acceptance; Sentry SERVER-21 stays the tripwire. Historical framing: whether
accrual should ever accept `reopened`. Original
fix direction: make the endpoint refuse loudly — a 409 with the period status and a
plain-language reason ("this pay period is closed; duty pay only accrues in an open period"),
surfaced in the UI. Do NOT make accrual accept `reopened`, and do NOT make Reopen return a
period to `open`: both were considered and rejected 2026-08-12 because they would open a path
for retroactive accrual into periods that predate the feature, which is exactly the wrong
direction.

DO NOT resolve `DRBARTENDER-SERVER-21` as noise. It is correctly reporting a real gap; the
gap is the silence, not the skip.

**B. RETRACTED 2026-08-12 — there was no overpay and no reconcile bug.** This slot
originally claimed proposal 642 (Brittany Welch) carried a stale `hosted_supplies` $50 beside
its `bar_rental` $20, and reasoned backwards to a package change on 8/06 that `reconcileDutyLines`
could not undo because the period had frozen. All of that was wrong, and wrong because the
query behind it selected `kind`/`amount_cents` and omitted the row's own bookkeeping columns.

The actual row: `origin: 'admin'`, `admin_owned: true`, `removed_at: 2026-08-11 17:04:13`,
`removed_by: 1`. It was HAND-ADDED by an admin, so the derivation never emitted it and the
strict either/or at `dutyLines.js:117` was never violated. Dallas then removed it and did not
pay it. Confirmed by him: "brittney wasn't overpaid I removed that line item and didn't pay
it. Its not showing up in the closed payroll now." Money is correct; the soft-delete is
working exactly as designed.

LESSON, worth more than the retracted finding: `payout_duty_lines` rows carry `origin`,
`admin_owned`, `removed_at`, `removed_by` and `held_state`, and a row is NOT live money just
because it exists. Any audit of duty money must filter on `removed_at IS NULL` and read
`origin` before drawing a conclusion — an `origin='admin'` row says a human decided, not that
the deriver misfired. This is the same failure shape as the retracted ClickableRow diagnosis
in the 8/10 drop: a story that fit the symptom, believed before reading the whole row.

**C. Also live, same feature:** Sentry `DRBARTENDER-SERVER-1N` "pricingSnapshot: legacy
snapshot without _version", 56 events, culprit `GET /api/admin/payroll/periods/:id/unattributed-duties`.
Not triaged here.

**VERIFIED GOOD (the money math itself):** all six production duty lines sit at exactly the
specced flat amounts — `bar_rental` 3 x $20, `hosted_supplies` 2 x $50, `menu_print` 1 x $5.
The flat-$50 hosted decision (Dallas 2026-08-07) is live and correct.

### Added 2026-08-13 (found by Dallas during the staff event-details walkthrough)

**RETRACTED, and replaced with the smaller real defect: the staff equipment card renders raw
snake_case tokens.**

The original claim here — "the server sends `equipment_required` and the staff UI never reads
it" — was WRONG. `EquipmentCard` exists (`client/src/components/staff/BeoSections.js:197`),
is mounted at `client/src/pages/staff/ShiftDetail.js:576`, and receives
`equipment={myShift?.equipment_required}` plus `supplyRun={...}`. It is wired end to end. It
rendered nothing on shift 14 because that shift's `equipment_required` is `"[]"` — there was
no equipment to show, and `EquipmentCard` correctly returns null when the list is empty and
there is no supply run.

The claim came from grepping the client for the literal string `equipment_required` and
finding only the admin editor. It is passed as a prop named `equipment`, so the grep missed
it. Same failure shape as the `--include=*.js` miss earlier the same day: searched one
spelling, concluded absence.

THE REAL DEFECT, found while checking: `EquipmentCard` rendered `{item}` directly, so a
staffer read the raw token. Three live PROD shifts carry `["portable_bar"]`, meaning three
bartenders saw **`portable_bar`** on their shift briefing. The label map
(`SHIFT_EQUIPMENT_OPTIONS`, `portable_bar` -> "Portable Bar") already existed but only the
admin editor used it.
FIXED 2026-08-13: `BeoSections.js` now imports `SHIFT_EQUIPMENT_OPTIONS` from the admin
module — deliberately the same list rather than a staff-side copy — and maps each token
through it, with an unknown token falling back to a de-underscored form so a future option
degrades to "weird thing" rather than vanishing. CI build exit 0. Owed: an eyeball on one of
the three affected shifts.

NOT A BUG, checked at the same time: the page showed no drink specs because drink plan 11 is
`status: 'pending'` with `finalized_at` NULL. Specs are correctly gated on a finalized plan.

### Added 2026-08-13 (found by Dallas on the real-phone walkthrough)

**The quote wizard's TimePicker puts three sub-minimum tap targets in 48px, on the public
lead-capture form.** Dallas, on a phone: "the drop down arrow and up and down arrows for start
time are overlapping each other although both are functional, they don't look clean and can be
annoying when you want to click on a specific arrow."

Not literal overlap — crowding. Measured from `client/src/index.css:10527-10582`:
`.time-picker-chevron` is `right: 1px; width: 24px` (full input height);
`.time-picker-steppers` is `right: 26px; width: 22px` split into TWO stacked buttons, so each
stepper is ~22px wide by HALF the input height (~19px). All three carry the same `#f9fafb`
background and `#d1d5db` divider, so they read as one strip rather than three controls.

**There is NO `@media` rule for `.time-picker` anywhere in the stylesheet** — the desktop
geometry ships to phones unchanged. ~22x19px is under half the 44pt iOS / 48dp Android
minimum in both dimensions.

Surface: `client/src/components/TimePicker.js`, used by
`client/src/pages/website/quoteWizard/steps/EventDetailsStep.js:60` — the PUBLIC quote wizard,
the most phone-heavy surface in the product and the top of the lead funnel.

**FIXED 2026-08-13.** Dropped the +/- steppers under `@media (pointer: coarse)` and gave the
chevron the whole 48px gutter (44px wide, input padding-right 52px to clear it). `pointer:
coarse` rather than a width breakpoint on purpose: the constraint is the finger, not the
viewport, and a landscape tablet has plenty of width and the same problem. CI build exit 0.
Owed: an eyeball on a real phone.
Original fix direction, for the record: drop the +/- steppers on narrow/touch viewports and let the
chevron dropdown own the full 48px. The dropdown already lists every valid time between
`minHour` and `maxHour`, so the steppers are a desktop convenience, not a capability — nothing
is lost, and the remaining target becomes comfortably tappable. Alternatives considered: grow
the targets under a media query (fights the input height), or swap to native
`<input type="time">` on mobile (better native pickers, but loses the minHour/maxHour clamp
the component enforces).

### Added 2026-08-13 (needs-attention tabs prod smoke)

**The Money tab holds nothing but payroll, and payroll does not belong there (Dallas's call,
2026-08-13):** "money tab is just payroll and needs to go elsewhere."

Why it is empty of everything else: `buildMoneyItems(payoutBadge)` emits exactly one kind of
item, unmatched Stripe payout lines — and as of 2026-08-13 prod has **213 of 213 payout lines
matched, zero unmatched, zero acknowledged-unmatched**. The payout mirror has fully caught up,
so that item never fires any more and the tab collapses to the payroll-overdue entry alone.
(This also retires the long-standing "119 unmatched pre-cutover expected" note — obsolete.)

~~DECISION NEEDED~~ **DECIDED 2026-08-14 (Dallas): "leave it be for now."** The Money tab
stays as-is — a quiet money-alarm panel holding payroll-overdue plus the dormant
unmatched-payout alarm (still the only mounted surface for the day that fires again on a
restore, historical import, or unattributable payment). No new surface, no Staffing fold,
no header badge. Historical options considered: own surface / fold into Staffing /
persistent header badge.

**The rest of the tabs were verified ACCURATE against prod the same day**, after three
approximations of mine disagreed with them and the tabs turned out right every time:
- Staffing 14 reconciles exactly: 10 short-staffed upcoming shifts + 1 applications item +
  3 uncertified staffable users + 0 preferred-name notices.
- Clients 0 is correct: of 116 unread inbound SMS, 92 carry `metadata->>'thumbtack_relay' =
  'true'` and are deliberately excluded by `GET /sms/conversations` as relay traffic rather
  than the client speaking; the remaining 24 belong to ZERO distinct clients (no `client_id`).
- Sales shows sent-unviewed-past-72h by design.

METHOD NOTE, the reason this took four tries: the Overview does NOT use
`GET /shifts/unstaffed-upcoming`. It computes client-side from the full `/shifts` feed as
`upcoming.filter(e => approvedCount(e) < parsePositionsCount(e))`, and the Staffing tab then
ADDS applications, uncertified and name-notice items on top. Any future attempt to predict a
queue's count must read `client/src/pages/admin/overview/OverviewPage.js` +
`queueItems.js` rather than re-deriving from the database, or it will disagree with a correct
screen and look like a bug.

### Added 2026-08-13 (skin sweep — the real finding)

**The rich text editor never got a skin pass, and it is on FIVE admin surfaces.** Dallas,
looking at the blog editor: "Its in the old skin before there was a difference between
marketing and admin... house lights is totally in the old skin while after hours content box
is in old skin as well."

`client/src/components/RichTextEditor.js` (the `.rte-*` block, `client/src/index.css:7995+`)
is styled entirely in the LEGACY marketing/apothecary vocabulary — `--parchment`,
`--parchment-dark`, `--dark-ink`, `--amber`, `--border`, `--radius` — and has **zero**
`html[data-app="admin-os"]` or `[data-skin]` scoped rules. Verified: 0 adminos-scoped `.rte-*`
rules, 0 `.ProseMirror` rules, and 0 of its five tokens remapped for the dark skin.

That last part is by DESIGN and is the whole mechanism: the After Hours token-remap block
(`index.css` ~10830) says outright that surface tokens "(`--paper`, `--parchment`, `--card-bg`,
`--cream`) ... are deliberately NOT remapped: light islands stay light and get per-island
treatment in the restores section below." The editor is such an island and its per-island
treatment was never written. So on After Hours it renders as a light parchment box on a
near-black page; on House Lights it blends but keeps old-skin chrome (wrong radius, wrong
fonts, and an active-toolbar-button in `--amber`, which is the token that is actually teal
`#1D8C89`).

BLAST RADIUS — five admin surfaces, not just the blog:
`pages/admin/BlogDashboard.js`, `pages/admin/EmailCampaignCreate.js`,
`components/SequenceStepEditor.js`, `components/emailBuilder/BlockSettings.js`,
`components/emailBuilder/CampaignBlastEditor.js`.

**Sequencing note:** three of those five are marketing/campaign tooling, and the marketing
section redesign (spec approved 2026-08-11, building on lane `mkt-a-tags`, Sep 5 deadline)
will be working in exactly that area. Skin the editor as part of that work rather than
separately, or the redesign lands on top of an unskinned component and the fix has to be
redone.
(2026-08-14: that window CLOSED — the marketing redesign shipped all three phases
2026-08-14 without touching the editor; zero adminos-scoped `.rte-*` rules exist. The
skin pass is now standalone work, exactly the outcome this note warned about.)

SUPERSEDES the contrast angle I opened this sweep with. I computed `--ink-4` at 2.16 (House
Lights) and 2.78 (After Hours) against the admin tokens and pointed Dallas at the blog editor
to see it. Those ratios are real for admin surfaces generally, but they were the WRONG lens
here: this page does not use the admin tokens at all. Measuring the tokens a surface does not
consume proves nothing about that surface. The old ledger figures (House Lights muted ~4.22,
danger ~2.56) came from the same era — muted still reproduces at 4.22, danger does NOT
(bordeaux `#9e3a2a` on card computes 6.51, comfortably passing), so that one is stale.

### Added 2026-08-13 (doc-preview walkthrough)

**Zul's W-9 on file is a screenshot, and it is the same file as her headshot.** `payment_profiles`
for user 2 holds `w9_filename = "Screenshot 2026-01-29 at 14.14.51.png"`, and
`contractor_profiles.headshot_filename` for the same user is the identical name. So the W-9 slot
almost certainly received a mis-upload rather than a signed W-9. Data issue, not code — but it
is a 1099 input, so it wants fixing before tax season rather than during it. Worth a sweep of
`payment_profiles.w9_filename` for other non-PDF entries at the same time.

**W-9 status (updated 2026-08-14): CLEARED from the active list by Dallas** — he is
chasing Zul's real W-9 offline. The row is UNCHANGED in prod (still the screenshot, last
touched March); the standing TRIPWIRE is 1099 season: no 1099 run should proceed while
`payment_profiles.w9_filename` for user 2 is a .png. Original finding follows.

**VERIFIED GOOD, same walk:** the document preview modal renders correctly in both skins with a
real W-9 PDF and a real headshot (Dallas, 2026-08-13). Unlike the rich text editor, this surface
is properly built — every rule scoped under `html[data-app="admin-os"]` and using the adaptive
tokens (`--bg-elev`, `--ink-1`, `--line-2`, `--shadow-pop`), so it follows the skin instead of
fighting it. It is the model for what an admin overlay should look like.

**METHOD FAILURE worth keeping (both of my 2026-08-13 fixes shipped broken and were corrected
by a later session, `54fb77cb` and `fc5e6ca2`):**
- The AttributionModal skip message went into `rowErrors`, keyed by a row that the post-submit
  refresh REMOVES (a skipped accrual still saves the attribution), so it rendered nowhere and
  the modal returned to claiming success over the same silent no-op.
- The TimePicker `@media (pointer: coarse)` block was placed BEFORE an existing
  `@media (max-width: 640px)` block that re-sets the same two properties at equal specificity,
  so on a phone — coarse AND narrow, the exact target device — source order kept the old sizing.

Both were "verified" by me as CI-build-green with the rules present in the compiled CSS.
**Presence is not precedence, and a rule rendering is not a rule being reachable.** For a CSS
fix, verify the cascade outcome at the target viewport/pointer, not that the selector exists in
the bundle. For a UI message, verify it against the state AFTER the refresh that follows the
action, not the state at the moment of writing.

### Added 2026-08-13 (quote-wizard Extras deployed-copy check)

**`soft-drink-addon`'s description has drifted permanently out of schema.sql, and a rebuilt
environment would ship different client-facing copy than production.**

Verified against prod 2026-08-13. Three of the four guarded copy UPDATEs applied cleanly:
`non-alcoholic-beer` (now Athletic Brewing only, Heineken correctly gone),
`zero-proof-spirits` (Lyre's), and `specialty-niche-liqueurs`. The fourth did not and cannot.

`schema.sql:760-762` reads
`UPDATE service_addons SET description = '<~600 char version>' WHERE slug = 'soft-drink-addon'
AND description = 'Soft drinks for all guests.'`. Prod's description is now a THIRD text, 257
chars, that matches neither the guard nor the replacement:

> "For designated drivers, kids, and anyone skipping the spirits but still sipping. Includes
> Coke, Diet Coke, Sprite, OJ, cranberry juice, pineapple juice, soda water, tonic water, and
> grenadine. Required for hosted parties expecting more than 10 non-drinkers."

It is BETTER than the schema version (shorter, plainer, same facts), so the live copy is not
the problem. The problem is the divergence: the guard can never match again, so schema.sql is
now permanently wrong about this row, and on a fresh database the seed INSERT would set the old
text, the guard WOULD match, and the environment would come up with the ~600-char version
instead of what clients read today.

**FIXED 2026-08-13**: seed now carries the live 257-char text, and the guarded UPDATE's
IN() also converges any env holding the long paragraph. Verified: prod, dev, and the seed
all agree (dev turned out to already hold the live text — the "third version" was authored
on dev and hand-applied to prod, which is exactly how the drift happened).
Original fix direction: promote the live 257-char text into `schema.sql` as the seeded value
(and drop or re-point the now-dead guarded UPDATE). This is the same class as the `service_packages.includes` prose
hazard already logged for `applyPackageLineup2026`: client-facing copy that lives only in the
database, with the file that claims to define it disagreeing.

~~WORTH A SWEEP: every guarded `UPDATE service_addons SET description = ... WHERE ... AND
description = '<old>'` in schema.sql is load-bearing exactly once and silently dead afterwards.
Check the rest for the same drift rather than assuming they applied.~~ **SWEPT 2026-08-14
(code side clean)**: four guarded description UPDATEs + one gated restore exist, and in every
case the seed INSERT already carries the post-update text, so a fresh DB comes up with the
live copy and each guard is a genuine no-op, not a drift source.

---

### Added 2026-08-14 (marketing-site perf pass, measured against a slow competitor site)

Context: Dallas hit a painfully slow Squarespace site (thecluttercurator.com) and asked whether
ours is in the same category. It is not. Same harness, 4x CPU throttle + fast-4G, headless
Chrome 151, `www.drbartender.com` measured LCP 1,324 ms / TBT 181 ms / FCP 1,088 ms / 3 long
tasks (331 ms total) / 17 requests, against their 10,268 ms / 5,234 ms / 4,120 ms / 28 long
tasks (6,634 ms) / 111 requests. Nothing below is a regression or a user-visible bug. Both are
cheap wins found while confirming that.

**1. Marketing photos in `client/public/images/marketing/` are served
`cache-control: public, max-age=0, must-revalidate`, so every repeat visitor revalidates
~1.35 MB of photos on every page load.**

Verified 2026-08-14 by header fetch against prod:

- `/images/marketing/service-byob-bar.jpg` → `cache-control: public, max-age=0, must-revalidate`,
  `content-type: image/jpeg`, 334,058 bytes
- `/static/media/chalkboard_background.728db7f949e93f7f0d93.png` → `s-maxage=31536000, immutable`,
  242,623 bytes

So the CRA-hashed `/static/media/` assets are cached correctly and the hand-placed `public/`
folder is not. That is the whole bug: files under `public/` ship with no content hash, so
Vercel's default for unhashed static assets is revalidate-every-time. The seven marketing
images measured 1,353 KB transferred, the two largest at 326 KB and 298 KB.

Two parts to the fix, both independent:

- Add a `headers` rule in `vercel.json` for `/images/marketing/(.*)` with a long
  `max-age`. These filenames are stable and the photos change roughly never, so a long TTL
  plus a manual rename on the rare swap is the right trade. Do NOT mark them `immutable`
  without renaming on change, since the names carry no hash.
- Serve modern formats. These are raw JPEG with no WebP or AVIF variant and no `srcset`.
  Per the existing marketing-photos convention (mozjpeg q82, see
  `project-marketing-photos`), add WebP siblings and a `<picture>` source, or move them
  behind Vercel's image optimizer. Expect roughly 25 to 35 percent off 1.35 MB.

**2. Zero `rel="preload"` hints in the client's `index.html`, so three IM Fell English woff2
files (267 KB total) are discovered late in the CSS and each took 900 to 975 ms.**

Verified 2026-08-14: `grep -c 'rel="preload"' ` on the deployed `index.html` returns 0.
Measured font timings on the throttled run: `IMFellEnglish-Italic` 94 KB / 975 ms,
`IMFellEnglish-Regular` 90 KB / 901 ms, `IMFellEnglishSC-Regular` 83 KB / 925 ms.

The font files themselves are correctly `s-maxage=31536000, immutable`, so this only costs
first-time visitors, which is exactly the visitor who matters on a marketing site. Fix is a
`<link rel="preload" as="font" type="font/woff2" crossorigin>` for the one or two faces used
above the fold (Regular, and SC if the hero uses small caps), not all three. Confirm which
faces the hero actually renders before adding the tags, since preloading a font the first
screen does not use makes things worse, not better.

---
---

# FOLDED IN 2026-08-13 (consolidation)

The three standalone lists below were merged into this file and deleted. Content is
near-verbatim from each file's last revision; git history holds the originals, including
open-threads' closed-item audit trail.

## From `staff-ops-backlog-2026-07-22.md` — the two unbuilt projects

Project A (staff event details) SHIPPED 2026-08-03 and Project B (logistics duties + duty
pay) SHIPPED 2026-08-07; only C and D below remain, both verified unbuilt (zero code hits,
2026-08-11).

### Staff ops: Project C: receipt reimbursements

- Staff submit a receipt image plus a chosen amount. Receipt must be itemized. Submit goes to admin for approve or deny. Approved amounts land in the staffer's payout.
- Fraud edges to design for: duplicate receipt submissions, amount vs receipt mismatch.

### Staff ops: Project D: staff directory + comms shift

- Staff directory for covers, bonding, and good fun. Phone-visibility rule TBD.
- Context: many staff do not have or do not check WhatsApp and miss group messages. Direction: DRB comms move mostly to SMS; WhatsApp becomes a relic/backup, possibly last-minute staffing only. Not yet decided.

## From `open-threads.md` — decisions, unbuilt projects, verified loose ends

Re-triaged against code/schema/prod on 2026-08-11; every surviving item was verified, not
carried forward. The closed-item audit (≈half the original ledger) lives in git history of
`docs/open-threads.md`.

### Money-adjacent records (from the 2026-08-11 re-triage)

These are not from the original ledger. They surfaced while verifying its
"Shift #31 still open" entry against production, and both are live.

- ~~**A bartender worked an event on 2026-07-18 and has no payout line.**~~ **CLOSED
  2026-08-11 by Dallas: user 12 is Dallas himself, and the unpaid invoice on 557 was already
  known.** No money is owed to anyone. Kept as a record because the SHAPE is still live and
  the next instance may not be benign: proposal 557 (event 2026-07-18) has an approved shift
  request and zero `payout_events` lines because it is still `deposit_paid` even though its
  Deposit ($100) and Balance ($250) invoices are both `paid`. Accrual is completion-only and
  the status ladder is demote-only, so any past event stuck below `completed` silently never
  accrues and nothing alerts. For a contractor rather than the owner, that is an unpaid
  person with no signal. The standing mitigation is the sweep before every payroll run; a
  real fix would be an alert on "past event, not completed, has approved staff".
- **Proposal 600 — DO NOT TOUCH. Legal hold (Dallas, 2026-08-11).** Its unpaid balance,
  `confirmed` status, and still-`open` shift 348 are all to be **left exactly as they are**.
  Do not archive it, do not reap or close its shift, do not void or re-send its invoice, do
  not chase the balance, and do not include it in any cleanup, sweep, or reconciliation.
  Its current state may be evidence. It is listed here only so that nobody "fixes" it.
  No further detail is recorded in this file and none is needed.
- **50 more open shifts sit on `completed` proposals** (oldest 2026-04-25, newest
  2026-08-09). These are cosmetic rather than money: staff never see them, because the
  open-shifts feed filters `s.event_date >= CURRENT_DATE` (`server/routes/shifts.js:195`).
  They are the residue of the same "nothing closes a shift" gap. Worth one sweep.
  **That sweep must exclude proposal 600 / shift 348** per the legal hold above — scope it
  to `p.status = 'completed'`, which excludes 600 (`confirmed`) by construction, and confirm
  the row count before running anything.

  **IN PROGRESS 2026-08-14, lane `shift-closure`. Scope widened from a sweep to the root
  cause, on Dallas's routing ("this seems like something for fable").** Re-measured against
  prod first, and the sweep alone was the wrong shape: **nothing in this system EVER closes a
  shift.** Only 5 shifts in the entire prod database have ever reached `completed`, and
  `filled` has never been used once (live distribution: 71 open / 5 completed / 2 cancelled,
  against a CHECK permitting open/filled/completed/cancelled). Sweep the 50 and the bucket
  refills. Also more real than "cosmetic": of the 50, **42 carry `shift_requests` and 31 carry
  `payout_events`** — those shifts were worked and PAID while the row still reads `open`.
  Staff genuinely do not see them (the feed's `event_date >= CURRENT_DATE` filter), so it is
  data honesty and a latent trap, not a live staff-facing bug.
  The hook already exists: `processEventCompletions` in `balanceScheduler.js` (hourly
  `autocomplete` scheduler, wired at `index.js:487`) already flips the proposal AND drives
  that shift's payout accrual, so closure belongs in a transaction already touching these
  rows. Lane does that plus a dry-run-default backfill script for the 50.
  **HARD CONSTRAINT on any lane in that file:** `balanceScheduler.js:77` holds the Stripe
  idempotency key mirrored by `stripe.js:340`; it must be byte-identical to main, including
  its known latent date bug, which is deliberately owned by a different lane together with its
  twin. A dedicated reviewer gates exactly that.
  Open design question the lane must answer honestly rather than assume: an unworked,
  unstaffed shift on a completed event arguably did not "complete", so `cancelled` may be the
  truer terminal value than `completed`. Note that choice is NOT inert — `eventDetailsPayload`
  and `beoHandlers` both filter `status != 'cancelled'`, so it changes what a BEO renders.
  Build was dispatched to Fable, reviews kept at Opus, per [[subagent-model-tiering]]'s
  execution-versus-judgment split.

  **FIRST PASS FAILED REVIEW 2026-08-14, and the catch is worth keeping.** The build chose
  worked -> `completed`, never-staffed -> `cancelled`, reasoning that an unworked shift did not
  complete. Defensible in isolation, WRONG here: `shifts.status = 'cancelled'` is overloaded as
  an EVENT-cancelled signal by two verified consumers. `isCancelledEvent(e)` at
  `client/src/components/adminos/shifts.js:79` tests `e.status === 'cancelled'`, and on the
  admin `GET /shifts` feed that IS the shift status, so the Events dashboard renders a Cancelled
  chip; `calendar.js:432` sets `cancelled: s.status === 'closed' || s.status === 'cancelled'`,
  which becomes `STATUS:CANCELLED` in the iCal VEVENT with a bumped SEQUENCE, striking the event
  off the owner's subscribed Google Calendar.
  Not hypothetical. Of the 8 never-staffed candidates in prod, 6 are $0 seed junk (null
  `client_name`, most with `positions_needed='[]'`) but TWO are real and paid in full:
  **shift 31 / proposal 54 (Ketan Patel, 2026-05-16, $450/$450)** and **shift 19 / proposal 21
  (Stef D., 2026-04-25, $400/$400)**. Both would have been labelled cancelled and struck from
  the calendar.
  **CORRECTION: the terminal status from this path is ALWAYS `completed`, never `cancelled`,
  worked or not.** The event completed; an unrecorded roster is a data gap, not a cancellation.
  Reasoning is written into the code so nobody re-adds the `cancelled` arm.

  **Why those two have no roster — ANSWERED by Dallas 2026-08-14: "I worked them both."** Not a
  data error, and not an ongoing pattern. He began rostering himself on 2026-05-15 and has 24
  approved non-dropped `shift_requests` since, through 2026-10-17; these two sit at the boundary
  (4/25 predates it, 5/16 was an early-days miss). So going forward, "completed and paid in full
  with ZERO shift_requests of any status" IS a genuine anomaly, which is why the backfill's
  dry-run surfaces that combination loudly rather than closing it silently. Expect it to fire on
  exactly these two known rows and nothing else. Related: [[project-owner-no-draw-payouts]],
  which covers the money side (he works events and takes no draw); this note covers the ROSTER
  side, which that entry does not.
- Shift #31 itself (the original entry) is **confirmed still open**, event date 2026-05-16,
  on a `completed` proposal. It is one of the 50 above.

---

### Blocked on Dallas (decisions, not builds)

- ~~**Contractor agreement v3 re-sign.**~~ **DONE (2026-08-14 audit)** — v3 is live
  (`contractorAgreement.js:3` CURRENT_VERSION = v3, defined at :102 with the duty-pay
  clause) and the re-acknowledge DECISION is recorded in-code at :99: v3 applies to new
  signers, already-signed contractors stay on v2, both versions frozen.
- ~~**Wix W9 / resume / gallery backup before CheckCherry sunset.**~~ **CLOSED 2026-08-14
  (Dallas): the Wix site is on the free tier and stays live — "backed up enough."**
  Nothing was lost; the content remains reachable on Wix itself.
- ~~**Two-step DROP COLUMN safety.**~~ **DONE (2026-08-14 audit)** — `notifications_opt_in`
  dropped at `schema.sql:4341` (aebd5562, lane p0-schema-hygiene) with the two-step
  reasoning written out at :4334-4340; no duplicate agreement columns remain in schema.
- ~~**Settings page direction**: lean two-card (Auto-Assign + Calendar Feed) vs a read-only
  integrations status board. Not locked.~~ **DEFERRED 2026-08-14 (Dallas: "defer settings").**
  Not a decision against either shape, just not now. Context banked for whoever reopens it:
  the two-card layout was never actually a choice, it is the status quo. `SettingsDashboard.js`
  already renders Calendar Feed (URL + how to subscribe) and Auto-Assign (algorithm weights +
  geocode backfill), and it works. The only live question is whether anything gets added on
  top. Recommendation on the table when it reopens: NOT an integrations health board, which
  goes stale and then lies, and which Stripe/Twilio/Resend's own dashboards plus Sentry
  already beat on truthfulness. The narrow version that would pay is a config-PRESENCE board:
  which env vars are actually SET on Render and Vercel, presence only, no values, no health
  checks. That is the one fact neither Dallas nor Claude can see today, and it is a standing
  debug tax (see the Env-var debug discipline section of CLAUDE.md, which exists because of it).
- **Deposit invoice gap.** First-post-cutover bookings skipped `createInvoiceOnSend`; that
  was Ketan's symptom. Whether other early bookings share the shape was never checked.
  Proposal 54 itself is now clean (`completed`, 450/450), so the original repair is
  reconciled; the open part is only "did others have this shape".

### Unbuilt projects with thinking already done

- **Comms Phase 5/6 — about 20 LOCKED design decisions, zero code.** Reschedule flow,
  per-event time zones, notification priority ladder with a 1/channel/client/day cap,
  delivery-failure fallback rules, 5-touch drip cadence, sentiment-routed post-event
  review, retention nudges restricted to repeat-likely event types, stale-lead
  auto-archive, cancellation notice as an admin-discretion toggle, voice conventions,
  setup-time language. Partially overtaken: STOP-keyword TCPA compliance SHIPPED, and
  `proposals.event_timezone` now EXISTS in schema (`schema.sql:2554`) so the time-zone
  decision is half-built. The rest reads like a ready-to-execute plan stub.
  (2026-08-14 audit: MORE than half-built now — the reschedule flow shipped
  (`rescheduleProposal.js` + the notify-staff toggle), `event_timezone` is genuinely
  consumed (staffShiftHandlers, drinkPlanNudge), and the drip sequence shipped
  (`emailSequenceScheduler.js`). Genuinely absent: the priority ladder + 1/channel/
  client/day cap, sentiment-routed post-event review, stale-lead auto-archive.)
- **Staff payment Phase 4 — 1099 generation.** The ledger keeps YTD totals exportable;
  the 1099 output itself has no plan and no code. (Phase 3, the staff pay surface, has
  since shipped: `server/routes/staffPortal/payouts.js` plus the payroll screen redesign.)
  **PROMOTED 2026-08-14 (Dallas): this is now the QUEUED successor to the retired
  staff-payment-system umbrella.** Clock: recipient copies due ~Jan 31; needs a spec
  first (form generation vs export-for-accountant is an open design call). Gates:
  Zul's real W-9 (no run while `payment_profiles.w9_filename` for user 2 is a .png)
  and the `users.exclude_from_1099` flag honored.
- **Client portal v2 remainder.** The day-of brief slot (#4, decisions captured: preferred
  name + headshot + "subject to change", no phone/messaging, 30-90 min generic arrival),
  and deferred sub-projects #7/#8/#9 (multi-event switcher, quote-resume, in-portal
  sign/pay/lab). Case Files still has 4 tab stubs with no design pass: Prescription, Potion
  Plan, Big Experiment, Receipts, Account. (2026-08-14 audit: partially stale — the tabs
  under `pages/public/portal/tabs/` are real now: Overview, Potion (fetches the live drink
  plan), Receipts, Prescription (with its own test), and a per-event route token +
  ArchiveList give a partial multi-event switcher. Still absent entirely: Big Experiment
  and Account tabs, the day-of brief slot, quote-resume, in-portal sign/pay/lab.)
- **Vite migration.** Decision locked (Vite, not Next). Confirmed still on
  `react-scripts 5.0.1` with zero vite references. 15-16 CRA-tied HIGH advisories are
  accept-and-document until this happens.
- **Mobile remediation: C1 is DONE, Batches 5-8 remain.** CORRECTED 2026-08-12. My
  2026-08-11 re-triage said C1 was untouched, based on grepping `Sidebar.js` for
  "hamburger/mobile-nav/isMobile" and finding nothing. That was the wrong place to look —
  the work lives in CSS, not the component. `index.css` ~13340 has the whole off-canvas
  drawer: `.sidebar` goes `position: fixed`, 280px, `translateX(-100%)`, slid in by
  `.shell.mobile-nav-open`, with `.header-menu-btn` and `.sidebar-close-btn` revealed and
  the rail compaction undone. The 220px-column-crush description is obsolete.
  ~~What IS still broken is a skin bug, not a responsive one: the drawer is transparent in
  House Lights, so page content reads through the nav items.~~ **FIXED (2026-08-14 audit)**:
  `index.css:13433-13436` gives the House Lights drawer `background: var(--bg-elev)` +
  border inside the drawer media block, with the specificity note above it.
  Batches 5-8 (tablet band 768-1024, 4 standalone Highs, post-C1 residual, Med/Low cleanup)
  are still genuinely unstarted.
- **Cocktail Menu page redesign.** `CocktailMenuDashboard.js` at 931 lines, double-mounted,
  ~90% duplicate code between Cocktails and Mocktails. Pull it out of Settings entirely.

### Real loose ends, verified still true

**Money / payments**
- `amount_paid` vs captured-amount: the webhook sets `amount_paid` on settle without
  asserting `session.amount_total` matches. The TIP branch does guard
  (`checkoutSessionCompleted.js:80`); the proposal settle branch still does not.
- Status demotion covers `balance_paid` but not `confirmed` on a price increase.
  (2026-08-14: now explicitly by design — the ladder was extracted to
  `proposalStatus.js`, and `proposalStatus.test.js:33` pins "lifecycle states
  (confirmed/completed) are never demoted." Closed-by-decision unless re-opened.)
- One-time prod audit of pre-existing `paypal_url` rows never run. Narrowed 2026-08-11:
  `tipMethods.readSideNormalize` now drops an unnormalizable value on read and Sentry-warns,
  so bad rows can no longer reach a client-facing sign. The audit is now cleanup, not risk.
- Payouts endpoint has no LIMIT and no `/ytd`; rated clean at today's volume.
- `findOpenPeriodForDate` is non-locking (low race window). Multi-admin mark-paid race:
  ~~the Phase 2 plan said lock the parent period row; nobody confirmed it landed.~~
  **it landed** (2026-08-14 audit: `admin/payroll.js:538` and `:631` take
  `FOR UPDATE OF po, pp`, `:432` locks the period before finalize). Only
  `findOpenPeriodForDate` itself (`payrollProcessing.js:12`) remains non-locking.
- Late-tip roll-forward into a frozen period is CLOSED (fixed in `dc313d3`). The sibling
  case, a refunded or disputed tip after payout, still has no admin-alert design.
  (2026-08-14: the MECHANISM is fully built — `payrollClawback.js:295-323` even rewinds a
  dispute-WON ledger, and every degraded path Sentry-alerts. What's missing is only the
  admin-FACING alert: no email/SMS/UI, Sentry only.)

**Perimeter / correctness**
- Auto-claim on `/onboarding` is silent: no confirmation UI, no `activity_log` row. Narrowed
  2026-08-11: the self-promotion hole itself was closed 2026-08-01 by `requireOnboarded` in
  `middleware/auth.js`, so what remains is only the missing confirmation and audit trail.
  (2026-08-14: the AUDIT TRAIL now exists — `auth.js:255-286` writes a `pre_hire_claimed`
  activity row + interview note post-COMMIT. Only the confirmation UI is still missing;
  `PreHireOnboarding.js` fires the claim in an effect and renders just a loader.)
- ~~`proposals_status_check` still has **4 non-transactional CONSTRAINT definitions** in
  schema.sql, source of a rare 1-in-16 dispatcher-test flake.~~ **FIXED** (b9c5e4c4:
  collapsed to 2 definitions, each wrapped in a guarded DO block — the flake source is
  gone. 2026-08-14 audit.)
- ~~Pre-hire who already has an account hits the application gate; workaround is the admin
  Hire button.~~ **FIXED** (2026-08-14 audit: `POST /auth/claim-pre-hire`, `auth.js:183-240`,
  self-claims — `in_progress` sets pre_hired, `applied` promotes to hired under FOR UPDATE.
  The admin workaround is no longer required.)
- ~~Stripe Dashboard refunds reconcile but never email the client.~~ **FIXED** (2026-08-14
  audit: `chargeRefunded.js:62-75` sends `sendRefundClientNotification({source:'webhook'})`
  when the webhook applied the reconcile — exactly the dashboard-issued case — and skips
  when the in-app route already handled it, so no double-send.)
- The "accepted before charge" sequencing bug (sign/accept fires before Stripe
  `confirmPayment`, so a declined card still yields an "accepted" toast and a signed
  proposal) ~~could NOT be re-located on 2026-08-11~~ **RE-LOCATED 2026-08-14**:
  `client/src/pages/proposal/proposalView/PaymentForm.js:28-55` — `await onSubmit()`
  (which signs) runs first, then `stripe.confirmPayment`; a confirm error only sets
  `payError`, leaving the proposal signed. The ordering is documented as DELIBERATE
  in-code at :7-9 ("Preserve this exactly"), so this is a known trade-off, not a lost bug.

**File-size ratchet** (`npm run check:filesize`: RED 0, YELLOW 32)
- `crud.js` is 995 lines and has gone the WRONG way (946 when logged). Closest to the hard
  cap of anything in the tree.
- `CocktailMenuDashboard.js` 931, `emailTemplates.js` 853, `QuoteWizard.js` 837 (now at
  `client/src/pages/website/quoteWizard/`), `ProposalCreate.js` 750, `admin/users.js` 713.
- ~~`safeAddonQty` is triplicated across `crud.js` / `public.js` / `metadata.js`.~~
  **DONE** (single definition at `proposalMoneyShared.js:12`, imported by all four
  consumers — 2026-08-14 audit).

**Housekeeping**
- ~~`handoff.md` / `handoff.beo.md` / `handoff.audit.md` in the os root~~ **DELETED
  2026-08-14 (Dallas: "delete all three")** — all were untracked Windows-era relics
  (`C:\Users\dalla\` worktree paths) whose described work has long since shipped.
- Local Postgres password from the pre-rebase leak (commit `885b074`, scrubbed from
  history) was never confirmed rotated. Cheap insurance.
- ~~Neon branch `br-morning-union-ad26nq4r` (prelaunch-scrub-rehearsal)~~ **DELETED
  2026-08-14** on Dallas's explicit cue, via Neon MCP.
- Stale Vercel preview branch `preview/claude/change-admin-password-IQlVD` (archived) plus
  its matching git branch `remotes/origin/claude/change-admin-password-IQlVD`, both from
  2026-05-20. **Deletion APPROVED 2026-08-14; execution owed to Dallas** — Claude's push
  hit the pre-push-hook timeout and the permission classifier blocked the hook-skip form.
  One-liner: `! HUSKY=0 git push origin --delete claude/change-admin-password-IQlVD`
  (a deletion ships no code; the archived Vercel preview is inert either way).
- ~~`--amber` is still `#1D8C89`, a teal. Rename it or comment it so a design session does
  not go orange.~~ **DONE (comment arm)** — `index.css:27-29` now explains the stable-name/
  shifted-value situation right above the token (760c8be3; 2026-08-14 audit).
- No admin UI exists to edit `service_addons` descriptions; live client-facing copy is
  still changed only by ungated `schema.sql` UPDATEs.
- `qLostValue` will start counting `archive_reason='event_completed'` as lost revenue the
  moment auto-archival ships. Needs the filter at that time, not before.
- ~~`crud.test.js` is not parallel-safe (global COUNT); needs `--test-concurrency=1`.~~
  **DONE** — replaced by an email-scoped `proposalCountForEmail()` (`crud.test.js:110-120`,
  comment names the exact flake); no concurrency flag needed (2026-08-14 audit).
- A dev `pay_period` stuck in `processing` makes 5 payrollAccrual tests skip. Refactor the
  test to manage its own period rather than depend on shared dev DB state.
- Hardcoded 60-minute orientation setup time, flagged as a V1 simplification.
  (2026-08-14: half-done — `setupTime.js:68-70` `effectiveSetupMinutes` honors a
  per-proposal `setup_minutes_before` override and branches 90 hosted / 60 otherwise;
  the fallback literals are still hardcoded, no settings-table source.)
- `BundlePicker` hardcodes "popular" to `the-foundation`. **PARTIAL 2026-08-14 (2233a1b6)**: the literal is hoisted to a named `POPULAR_BUNDLE_SLUG` constant with a comment saying where the real fix lives. Data-driving it stays OPEN: it needs a new schema column, a seed, and the server twin in `server/utils/proposalRules.js` moved to the same source, which is a lane not a ride-along.
- Client-side gratuity floor still duplicates the literal 50; the server has
  `GRATUITY_FLOOR_RATE` (`pricingEngine.js:236`). Lift the client to a shared constant.

### Ideas, unscoped

Referral program. Admin permissions / manager-toggle framework. Contractor onboarding flow
audit. AI responder for staff SMS. Google Reviews monitoring + staff review-forward.
Newsletter and seasonal campaigns (now partly absorbed by the marketing redesign).
Thumbtack auto-draft becoming auto-send. Auto-assign weights as one slider instead of two
"should sum to 1.0" inputs. Editable env-shaped settings (deposit amount, admin SMS phone,
notification email) behind a real settings table. A `/capture` command to distill a wrapped
thread into this ledger in one keystroke.

### Pointers, not duplicates

- **Owed walkthroughs** now live in `docs/walkthroughs-owed.md`. Everything in the old
  ledger of the form "shipped but never eyeballed" moved there.
- **Anything with a file and line number** lives in `fix-list-remaining-2026-07-02.md`.
- **Multi-bartender tipping** is absorbed by the staff payment system project. Note the
  standing rule: tip signs are per-bartender and settled; do not re-raise shared-bar or
  pooled-QR sign designs.
- **Lane and project status** is `build-board.md`.

---

## From `tech-debt.md` — deliberate deferrals from the 2026-04-24 full audit

Provenance: the standalone `tech-debt.md` (sourced from the 2026-04-24 `/full-audit`,
paths refreshed 2026-04-27). All deliberate deferrals; each is eligible to be re-opened as
its own spec. Line numbers are old — re-grep before surgery.
CROSS-LINK (2026-08-13): the "pricing_snapshot shape validator" item below is now HALF-built
— a `_version` check exists and is what fires Sentry `DRBARTENDER-SERVER-1N` ("legacy
snapshot without _version", 54 events) on every legacy row it meets. Finishing the item now
means stamping/backfilling legacy snapshots (or demoting the log), not just writing the
validator.

### Tech debt: Schema migrations — need backup + verification plan

### Tech debt: shifts.positions_needed + equipment_required: TEXT → JSONB

**Source:** audit log, "Follow-up pass" item L; schema-drift scan section 5.
**What:** Both columns currently store JSON text (default `'[]'`) and require `JSON.stringify`/`JSON.parse` at every callsite and `::json` casts at query time. The 2026-04-15 plan doc flagged this for migration; never executed.
**Why deferred:** Requires a production data migration (TEXT → JSONB with content coercion) and a sweep of every callsite removing the stringify/parse boilerplate. Belongs in its own spec with a rollback plan.
**Callsites to update after migration:** `server/utils/autoAssign.js:128-129` (2026-08-14: drifted to :141), `server/routes/admin/settings.js:129-132` (now :132-135; badge-counts `::jsonb` casts in the unstaffed-events sub-select; remove after migration), `client/src/pages/admin/AdminDashboard.js:400`, `client/src/pages/staff/StaffShifts.js:97`, `client/src/pages/admin/ProposalDetail.js:156`. Note `shifts.js:198` has since added an `IS JSON ARRAY` guard on top of the still-TEXT column.
**Next step:** Brainstorm migration script → coordinate with a deploy window → roll codebase sweep.

### Tech debt: Dead column drops

**Source:** audit log, schema-drift scan section 2.
**What:** Columns that are in schema but unused anywhere in code:
- ~~`service_addons.is_default` — default `false`, never read or written~~ **DROPPED** (`schema.sql:4342`, aebd5562 — 2026-08-14 audit)
- `users.calendar_token_created_at` — written but never read
- `shifts.client_email`, `shifts.client_phone` — INSERTed via manual-event path, never SELECTed
- `applications.favorite_color` — INSERTed + displayed but never used in logic (humor field — confirm intent before dropping)

**Why deferred:** Each drop needs a quick user confirmation ("is this truly dead or scaffold for a future feature?"). Batchable into a single cleanup spec.
**Next step:** Confirm each column → write a single DROP COLUMN migration with idempotency guards.

---

### Tech debt: Shape validators — cross-cutting refactor

### Tech debt: pricing_snapshot shape validator

**Source:** audit log, item K.
**What:** `proposals.pricing_snapshot` JSONB is written by `server/utils/pricingEngine.js:343` and read by 6+ distinct files: `server/routes/stripe.js`, `server/utils/invoiceHelpers.js` (twice), `server/routes/clientPortal.js`, `server/routes/proposals/publicToken.js` (GET /t/:token), `server/routes/proposals/crud.js` (PATCH /:id reads `old.pricing_snapshot`), `server/routes/drinkPlans.js` (twice). Any key rename in the pricing engine silently breaks all downstream consumers at runtime.
**Why deferred:** Requires a `PRICING_SNAPSHOT_VERSION` constant, a validator function, a consumer-side assert on read, and a write-time version stamp. Cross-cutting refactor — not trivial.
**Next step:** Design the validator contract → add version field → wrap all 6 read sites in version-aware parsing.
**2026-08-14 audit — HALF-DONE, matching the cross-link above:** `pricingSnapshot.js` exists (`PRICING_SNAPSHOT_VERSION = 1`, `readSnapshot` with legacy tolerance + the SERVER-1N Sentry warn + future-version throw; stamped on write at `pricingEngine.js:557`) and is routed through invoiceExtras, preEventHandlers, payrollAccrual, setupTime, eventCreation, lineItemCancel, dutyLines. Still parsing raw: `routes/stripe.js`, `serviceExtensionSettle.js`, `payrollMath.js`, `eventDetailsPayload.js`, `proposalExtrasFold.js`, `invoiceLineItems.js`, `proposalGroups.js`, `changeRequests.js`, `gratuityLabels.js`, `routes/shifts.js`. Legacy rows still unstamped.

### Tech debt: adjustments + class_options shape validators

**Source:** audit log, items N + Phase 2 scope.
**What:** `proposals.adjustments` (JSONB array of `{label, amount, type?}`) has no server-side shape validation before INSERT. `proposals.class_options` has a whitelist in ONE insert path (`proposals.js:385-388`); other writers could bypass.
**Why deferred:** Requires extracting `normalizeAdjustments()` and `normalizeClassOptions()` helpers in `server/utils/` and routing every writer through them.
**Next step:** Write the helpers → find every writer (`rg "adjustments.*JSON.stringify"`, `rg "class_options"`) → route through normalizers.

---

### Tech debt: Architecture refactors — each needs its own design session

### Tech debt: True schedulers-to-worker-process split

**Source:** Codex server `[P1]`, audit top-21 item #6. Bucket B landed the env-guard stopgap (`RUN_SCHEDULERS=false` on additional instances); the ideal is a dedicated worker entrypoint.
**What:** A dedicated `server/worker.js` that runs ONLY the schedulers (balance/event-completion/auto-assign/email-sequence/quote-draft-cleanup). Render runs one web service (no schedulers) + one worker service (schedulers only). Eliminates every class of "scheduler ran N times because N web instances" bug.
**Why deferred:** Changes deployment topology on Render; needs a second service or process-group setup; might affect pricing.
**Next step:** Design doc for worker-process split + Render YAML + migration runbook.

### Tech debt: Drink-plan extras pricing service

**Source:** Codex server `[P2]`.
**What:** Add-on + bar-rental + syrup charges are recomputed inline in three places: `server/routes/stripe.js:197-216` (create-drink-plan-intent), `server/routes/drinkPlans.js` (mutating `proposal_addons`), and `server/utils/invoiceHelpers.js` (building the extras invoice). One concept, three owners.
**Why deferred:** Cross-cutting extraction; needs tests around pricing parity.
**Next step:** Extract to `server/utils/drinkPlanPricing.js`; route all three consumers through it; add golden tests.

### Tech debt: Proposal-creation workflow consolidation

**Source:** Codex server `[P2]`.
**What:** Public and admin proposal-creation paths in `proposals.js:365` already diverge in validation, side effects, and pricing calculation. Every new field requires manual sync across both branches.
**Why deferred:** Real refactor; needs behavioral tests to confirm no regression across both flows.
**Next step:** Design doc; extract `createProposal(ctx, input)` service; both routes consume.
**2026-08-14 audit — PARTIAL:** a shared `proposalInsert.js` (`insertProposalRecord`) now exists, consumed by `crud.js`, `proposalGroups.js`, `thumbtackProposalDraft.js` — but the PUBLIC path still hand-rolls its own INSERT at `public.js:458`, so the two branches still diverge. No `createProposal(ctx, input)` service yet.

### Tech debt: PotionPlanningLab state-controller split

**Source:** Codex client `[P2]`.
**What:** `client/src/pages/plan/PotionPlanningLab.js` orchestrates API loading, migration, autosave, browser-history interception, payment-redirect handling, queue derivation, AND step rendering. Steps are thin leaves over shared mutable state — large prop bags.
**Why deferred:** Large restructure; risk of breaking an already-complex wizard.
**Next step:** Extract controller hooks (`usePlanAutosave`, `usePlanHistory`, `usePlanQueue`) or a flow context; steps become presentation-only.
**2026-08-14 audit:** worse — the file is now 998 lines; none of the hooks exist.

### Tech debt: ClientAuthContext via utils/api.js

**Source:** Codex client `[P2]`.
**What:** `client/src/context/ClientAuthContext.js:13-23` uses raw `fetch` instead of the shared `utils/api.js` axios instance. Two auth domains, two error-handling paths, two base-URL resolutions. Error semantics drift by user type.
**Why deferred:** Small enough to do standalone but needs verification it doesn't break the client portal.
**Next step:** Route client auth through `utils/api.js` (preserve separate token storage key); verify client-portal flow end-to-end.
**2026-08-14 audit — PARTIAL:** `ClientAuthContext.js:2` now imports `API_BASE_URL` from `../utils/api` (base-URL resolution shared), but :15-25 still uses raw `fetch` with its own error path, so the two-error-semantics half stands.

### Tech debt: App.js route manifest dedup

**Source:** Codex client `[P2]`.
**What:** `HiringRoutes`, `StaffSiteRoutes`, and the admin branch in `AppRoutes` (`client/src/App.js:189-231`) re-declare the same onboarding, portal, and token-based routes with small variations. Three manifests to keep in sync.
**Why deferred:** Routing refactor; high risk of breaking site-context switching.
**Next step:** Extract shared route groups and compose them from a single source.

### Tech debt: QuoteWizard ↔ ProposalCreate policy dedup

**Source:** Codex client `[P2]`.
**What:** `client/src/pages/website/quoteWizard/QuoteWizard.js` (parent + step components in `quoteWizard/steps/`) and `client/src/pages/admin/ProposalCreate.js` both own package/add-on eligibility, draft persistence, pricing preview, event-type lookup, and submission rules. They have already drifted (`filteredAddons`, event-type search, preview payloads/endpoints).
**Why deferred:** Large refactor.
**Next step:** Centralize policy + preview/draft adapters in shared modules consumed by both flows.

---

### Tech debt: Perf — low-frequency admin loops (deferred by risk/reward)

### Tech debt: Geocode backfill bulk UPDATE

**Source:** audit follow-up item D.
**What:** `server/routes/admin/settings.js:68-100` (POST /backfill-geocodes) — per-profile and per-shift geocode backfill loops do sequential 1.1s Nominatim + per-row `UPDATE`. Admin one-off endpoints, rarely hit.
**Why deferred:** Low frequency; replacing the per-row UPDATE with a bulk `unnest()` CTE is straightforward but not urgent.
**Next step:** Keep the 1.1s Nominatim throttle, collect successes, bulk UPDATE at end.

### Tech debt: Blog import parallel uploads + batch INSERT

**Source:** audit follow-up item E.
**What:** `server/routes/admin/blog.js` (POST /blog/import) — sequential image uploads + single-row INSERTs per blog post. Used once every few months at most.
**Why deferred:** Low frequency.
**Next step:** Parallelize image uploads with `Promise.all`; single multi-row VALUES INSERT.

---

### Tech debt: Low-value / nice-to-have

### Tech debt: Failed-login DB audit trail

**Source:** audit log A09.
**What:** Failed logins are logged to console only; Render retention is short. In-memory `loginAttempts` Map provides basic lockout.
**Why deferred:** Low immediate risk. Sentry captures patterns via rate-limit 429s.
**Next step:** Optional — add `failed_logins` table if audit/compliance needs grow.

### Tech debt: Pagination on tenure-dependent endpoints

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** Five admin/staff endpoints now have `LIMIT 500` added in the bucket-B push to prevent unbounded list returns, but the cap is high enough that long-tenured users won't hit it for 1-2 years:
- `server/routes/shifts.js:/user/:userId/events` (LIMIT 500) — 2.5+ year bartender at 4 events/week hits it (2026-08-14: SQL extracted to `shifts.queries.js:85`)
- `server/routes/shifts.js:/my-requests` (LIMIT 500) — same tenure threshold (now `shifts.js:248`; sibling query at `shifts.queries.js:121`)
- `server/routes/emailMarketing.js:/campaigns/:id` sends (LIMIT 500) — hits with a single 10k-lead campaign (file split: now `emailMarketing/campaigns.js:116`)
- `server/routes/emailMarketing.js:/campaigns/:id` enrollments (LIMIT 500) — same (now `emailMarketing/campaigns.js:137`)
- `server/routes/emailMarketing.js:/campaigns/:id` conversation history — paginated already
**Why deferred:** Each needs frontend pagination support (paging controls, "load more" button, or infinite scroll). Frontend consumers were not touched in the bucket-B push to keep the commit focused. Once a user hits the cap, the UI silently shows an incomplete list with no indicator.
**Next step:** Add `?page=` / `?limit=` query support and frontend paging in an incremental PR. Triggered event: first support ticket mentioning "missing old events" or "campaign shows 500 sends but blast went to 10k."

### Tech debt: Campaign-list query performance

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** `GET /api/email-marketing/campaigns` list uses three correlated `COUNT(*) FROM email_sends WHERE campaign_id = c.id AND status = ...` subqueries per row. At 100 campaigns × 10k sends per campaign that's 3M row scans per list call.
**Why deferred:** Scale concern, not a current problem.
**Next step:** Add partial indexes on `email_sends(campaign_id) WHERE status = 'opened'` / `WHERE status = 'clicked'`, OR refactor to a single aggregated subquery with `COUNT(*) FILTER (WHERE status = ...)`.

### Tech debt: CC-Import: orphan-payment link refund branch — TOCTOU race — MOOT (2026-08-14 audit)

**`ccImport/review.js` was DELETED in the cc-demolition lane (f39de178); `promoteSingleLegacyRefund` and `phase4.js` have zero hits repo-wide, and `legacy_cc_payments` survives only as a read-side metrics table with no writer to race. Kept below as provenance.**

**Source:** 2026-05-28 Task 2 checkpoint review (database-review agent).
**What:** `server/routes/admin/ccImport/review.js:334-346` reads `cc_event_id, promoted_*_id` outside any txn or row lock, then `:392-395` (refund branch) runs a bare `UPDATE legacy_cc_payments SET cc_event_id = $1` with no `WHERE cc_event_id IS NULL` clause. Two admin clicks racing on the same orphan row can both pass the guards, both run the UPDATE, then both call `promoteSingleLegacyRefund`. The helper's `FOR UPDATE` on `proposals` (phase4.js:585-589) serializes the row-lock contention, but the per-proposal `legacy_charge_id` idempotency index does NOT fire when `legacy_charge_id` is NULL (legitimate per the CC export), so both calls can produce duplicate `proposal_refunds` inserts. Payment branch is NOT affected — shared txn + FOR UPDATE inside `promoteSingleLegacyPayment` makes the second caller block and see `promoted_payment_id` set.
**Why deferred:** Pre-existing race, not introduced by codex-followups Task 2. The atomicity fix in commit `6455fdb` closes the bigger "non-success status strands cc_event_id" gap; this concurrency hole is narrower and only fires under double-click. Operator UX could mitigate via button-disable-on-click; the durable fix is server-side.
**Next step:** Tighten the refund-branch UPDATE to `... WHERE id = $1 AND cc_event_id IS NULL`, check `rowCount === 0` → throw `ConflictError('race lost')`. Alternatively, add `SELECT ... FOR UPDATE` to the guard SELECT at `review.js:334-338` to serialize concurrent reads.

### Tech debt: metricsQueries `include_cc` filter join lacks composite index

**Source:** 2026-05-27 push pre-review (performance-review agent, finding L4).
**What:** `server/utils/metricsQueries.js:200-203, 263-272` — the `include_cc !== 'all'` paid-money branch joins `proposal_payments → proposals` on every Financials/Dashboard call and adds `p.cc_id IS NULL` / `IS NOT NULL`. The join key on `pp.proposal_id` is FK-indexed, but there's no composite `(proposal_id, cc_id)` and the existing partial unique `idx_proposals_cc_id` (schema 2805) only covers the `IS NOT NULL` selectivity path.
**Why deferred:** Fine at current volumes — `proposals` is small. Only becomes a problem once `proposal_payments` crosses ~100k rows. The `include_cc` chip itself was just wired (commit `c4a18e1`) so usage data starts now.
**Next step:** Revisit once the financials dashboard slows on a CC-heavy filter. Likely fix: add `CREATE INDEX idx_proposals_id_cc_id ON proposals(id, cc_id)` — covers both `IS NULL` and `IS NOT NULL` branches via index-only scan.

### Tech debt: admin.js applications filter CASE expression blocks index

**Source:** 2026-04-24 push pre-review (database-review agent).
**What:** `server/routes/admin/applications.js:22-50` (the `ARCHIVED_FILTER` const + its callsite in GET /applications) uses `CASE WHEN $1 THEN u.onboarding_status = 'rejected' ELSE u.onboarding_status IN ('applied','interviewing') END`. The parameterized CASE prevents Postgres from using `idx_users_onboarding_status` — predicate pushdown doesn't apply to parameterized branches.
**Why deferred:** At current scale (~100s of applicants) seq-scan is faster than index anyway. Parameterization was chosen over string-concat specifically to remove the SQL-injection-adjacent pattern flagged by the audit.
**Next step:** When application volume exceeds 10k rows, rewrite as two branches selected in JS with const string literals (no user input = no injection surface):
```js
const statusPredicate = archived
  ? `u.onboarding_status = 'rejected'`
  : `u.onboarding_status IN ('applied','interviewing')`;
```

### Tech debt: Stripe webhook catch swallows DB errors (returns 200) — FIXED (2026-08-14 audit)

**The handler moved out of `stripe.js` into `stripeWebhook.js` + `stripeWebhookHandlers/`, and the catches now RETHROW so asyncHandler returns 5xx and Stripe retries (`paymentIntentSucceeded.js:626-637`, `chargeRefunded.js:58`, each with the retry comment). Original below.**

**Source:** 2026-04-24 push pre-review (security-review agent, M2).
**What:** `server/routes/stripe.js:788-798` (and 931-941) — when the DB transaction fails inside the signature-verified webhook handler, the `catch` block captures to Sentry + ROLLBACKs, but falls through to `res.json({ received: true })` on line 961. Stripe sees 200, does not retry. A transient DB outage during `payment_intent.succeeded` processing silently drops the payment record.
**Why deferred:** Pre-existing behavior (not introduced by bucket B). Narrow-scope remediation was the goal.
**Next step:** Rethrow from the catch blocks to propagate to asyncHandler → 500 response → Stripe retry.

### Tech debt: Dead-letter readers for forensic blobs

**Source:** schema-drift scan section 5.
**What:** `email_webhook_events.processed`, `thumbtack_leads.raw_payload`, `thumbtack_messages.raw_payload`, `thumbtack_reviews.raw_payload`, `proposal_activity_log.details` — all written, never read back in any admin UI. (2026-08-14: `email_webhook_events.processed` is now READ and load-bearing — it is the idempotency gate at `emailMarketingWebhook.js:102` `SELECT ... FOR UPDATE`. The three thumbtack blobs + activity-log details remain write-only.)
**Why deferred:** Intentional forensic/audit storage per design.
**Next step:** Revisit only if a debugging incident requires on-demand access.

### Tech debt: DEFAULT vs always-supplied column duplication

**Source:** schema-drift scan section 7.
**What:** ~10 columns have schema DEFAULTs that never trigger because every writer supplies a value (~~`users.notifications_opt_in`~~ (dropped), `proposals.guest_count`, `proposals.event_duration_hours`, `stripe_sessions.amount`, etc.).
**Why deferred:** Harmless code smell. Removing the explicit JS fallback OR the DEFAULT is a one-line cleanup but provides no behavior change.
**Next step:** Sweep during next routine DB maintenance.

### Tech debt: Dead column: `users.notifications_opt_in` — DONE (2026-08-14 audit)

**Dropped at `schema.sql:4341` (aebd5562) with the two-step rationale written at :4334-4340; zero fixture INSERTs remain. Original below.**

**Source:** audit batch 5b, L1 (lane audit-5b-notif).
**What:** `users.notifications_opt_in` was write-only — set by the `/register` and `/register-pre-hired` routes from the PreHire onboarding signup checkbox ("Text me when new shifts post"), but gated NO notification. Real shift-SMS gating is `staff_notification_preferences` JSONB via `notificationChannelResolver.js` (defaults opted-in). The checkbox implied an effect that never happened. Removed the checkbox + both writers (auth routes) + the two admin SELECTs; column is now dead (no writers remain in `client/src` or `server/routes`; only `schema.sql` + test fixtures reference it).
**Why deferred:** `DROP COLUMN` not done yet — defer one clean deploy so the no-writer change ships first, then drop in a follow-up migration. Test fixtures (`notificationChannelResolver.test.js`, `messageScheduling.test.js`, `scheduledMessageDispatcher.test.js`, `beoHandlers.test.js`) still INSERT the column; update them when the DROP migration lands.
**Next step:** `ALTER TABLE users DROP COLUMN notifications_opt_in;` migration after one clean deploy, plus drop the column from the test INSERTs.

---

### Tech debt: Accepted risks — document, don't fix

These were identified during audit but are deliberately not addressed:

- **npm audit `react-scripts` transitive CVEs** (14 high / 6 moderate). CRA is abandoned upstream. None ship to production browser bundle (webpack-dev-server is dev-only, svgo/nth-check/workbox are build-time). Migration off CRA to Vite or Next.js is its own project.
- **Helmet CSP `'unsafe-inline'` in `styleSrc`**. Required by Stripe Elements + inline React styles. Documented compromise.
- **In-memory `loginAttempts` Map** in `server/routes/auth.js:15-17`. Acceptable for single-instance Render. Multi-instance deploys will bypass the lockout per-IP rotation. Revisit if/when moving to multi-instance.
- **Email `html_body` shipped to every campaign-step edit request**. Campaign-step detail needs the body to edit; no meaningful optimization available short of a separate `/steps/:id/body` lazy-fetch endpoint. Current scale doesn't warrant.
- **`uuid` advisory GHSA-w5hq-g745-h8pq (moderate)** — audit batch 3c-deps. The advisory is a missing buffer bounds check in `v3`/`v5`/`v6` **only when a `buf` argument is passed**. Every `require('uuid')` site in the codebase uses `v4` with no `buf` (grep `require('uuid')` — application.js, payment.js, contractor.js, admin/users.js, admin/blog.js, scripts), so the code path is unreachable for us. The only fix npm offers is `uuid@14` (semver-major: ESM-leaning rewrite that would need all 7 CJS `require` sites verified) for zero real-world gain. Deferred — revisit if a future uuid major bump happens for another reason.
- **`@opentelemetry/core` < 2.8.0 advisory GHSA-8988-4f7v-96qf (moderate)** — audit batch 3c-deps. Unbounded memory allocation in W3C Baggage propagation, pulled transitively by `@sentry/node`'s OTel instrumentation (`instrumentation-http` → `resources` → `sdk-trace-base`). NOT overridden: `@opentelemetry/core` is tightly version-coupled across the OTel packages `@sentry/node` pins, so forcing core alone risks breaking Sentry tracing. The clean fix is a coordinated `@sentry/node` bump to a release on OTel core ≥ 2.8.0 — fold it into the next Sentry upgrade rather than a surgical override. (2026-08-14: that plan did NOT clear it — `@sentry/node` is now `^10.49.0` but the lockfile still resolves `@opentelemetry/core` at 2.6.1, below the 2.8.0 threshold. Re-check whether a newer Sentry line clears it.)
- **record-payment reads `currentPaid` pre-transaction** (`server/routes/proposals/actions.js`; flagged non-blocking by the archive-controls push-gate reviewer, 2026-07-02). The `currentPaid === 0` gate for the client-lock hoist and the same-client sweep uses an `amount_paid` value read before `BEGIN`; a concurrent first payment landing in that gap could leave it a stale 0. Consequences are benign (an extra client lock is harmless; a re-sweep is idempotent via the status filter; the amount math itself uses guarded in-tx UPDATEs), so this is documented rather than fixed. If the handler is ever reworked: re-read `amount_paid` under the in-tx row lock and derive the gate from that.

---

# Sentry unresolved — swept 2026-08-13

The live Sentry queue, triaged into this list so it stops being a sixth list nobody reads.
Do NOT resolve `DRBARTENDER-SERVER-21` as noise (see the 2026-08-12 duty-accrual entry).

**Needs a real look:**
- ~~**`WILDLIGHT-E`**~~ **DIAGNOSED 2026-08-14: designed telemetry of a handled condition,
  not an outage — ARCHIVED-UNTIL-ESCALATING in Sentry.** The full mechanism, from
  `wildlight/lib/db.ts`: Neon idle-kills pooled connections while Vercel has the lambda
  FROZEN, so pg's reaper cannot notice; the dead socket surfaces as a pool `'error'` event
  on thaw. With no listener that was an uncaughtException crashing in-flight requests
  (WILDLIGHT-1, already fixed); the listener now logs `db.pool_connection_error`, and
  `logger.warn` unconditionally pipes to Sentry `captureMessage` — which is the entire
  "issue". Evidence it is harmless: pg-pool evicts the dead client before any request can
  draw it; Users Impacted 0 on all 99 events; ~5/day matching the freeze-thaw rhythm; and a
  month of the event stream contains ZERO error-level "Connection terminated"/ECONNRESET —
  no visitor has ever eaten the request-time version. Archive-until-escalating keeps the
  tripwire: a genuine Neon incident bursts the rate and re-pages.
  LOW, optional hardening left behind: `withConnRetry` (built for exactly this drop class)
  has exactly ONE consumer, an admin draft route — the shop's read paths are unwrapped.
  Zero observed failures in a month says do NOT churn the live storefront for it now
  (protect-working-paths law); wrap the hot reads opportunistically the next time that code
  is open. Also note `logger.warn`→Sentry means any recurring expected warn becomes an
  issue — same shape as WILDLIGHT-2's login noise; consider a `logger.expected()` tier if a
  third one appears.
- ~~**`WILDLIGHT-G` — Anthropic credits**~~ **CLEARED by Dallas 2026-08-14** (handling the
  top-up himself; it was ONE handled event when a journal generate was tried on 8/13, the
  app degraded gracefully). Sentry issue marked RESOLVED as the tripwire: if a generate
  fails on credits again it reopens as a regression and pages. No code change.
- **`DRBARTENDER-SERVER-22` — `AggregateError` on `GET /api/admin/thumbtack/pending-first-replies`**
  (new 2026-08-13, 1 event). The box agent's polling call threw. Same pipeline that still
  owes its next-lead proof — check `journalctl --user -u thumbtack-agent` on the box before
  trusting the next lead to it.
- **`DRBARTENDER-SERVER-1H` — `unresolved_ingredient`, 16 events, ongoing** on the public
  drink-plan PUT. Potion custom-recipe family; a client-entered ingredient the resolver
  cannot map. Needs one triage: either a missing alias (data fix) or a resolver gap.
- **`DRBARTENDER-SERVER-1N`** — see the tech-debt cross-link above (legacy pricing_snapshot
  rows without `_version`; 54 events).

**Known shape / low:**
- N+1 query cluster (`SERVER-11`, `-1F`, `-1P`, `-1Q`, `-1C`) on dashboard-stats, financials,
  staff-home — perf-category, related indexes already itemized in the tech-debt section.
- `WILDLIGHT-9` / `WILDLIGHT-F` — anthropic URL-fetch retry + image recompress: working
  fallbacks doing their job, log-noise tier.
- `WILDLIGHT-2` — `auth.login_failed`, 7 events/29 days: someone poking the admin login;
  lockout Map covers it.

---

# Ready to build, discovered off-board (2026-08-13 sweep)

- ~~**Proposals list pagination** — NOT built~~ **BUILT & SHIPPED (2026-08-14 audit; the
  entry was never updated)** — lane prop-pagination 1dc72df6, hardened by 92efc663 +
  9dc29682: `pages/admin/ProposalsDashboard.js` (file moved out of components/) sends
  explicit `?page`/`?limit`, reads `X-Total-Count`, renders a real pager with a stale-page
  snap-back guard; the "showing first 50" string no longer exists anywhere in the file.
  Still standing from the original entry: events/shifts deliberately stay unpaginated
  (Dallas 2026-08-12: "I like it all on one page"), and the latent `LIMIT 500` hazard on
  `GET /shifts` is recorded in the spec for later. (Note the cross-page option-group
  rollup duplicate from the round-3 push-gate findings below is still open.)


---

# Added 2026-08-13 (walkthrough-file audit)

Two open items that were living only in memory entries and had never reached this list:

- ~~**`smsInbound.js:9` still hands staff the old 312 in every auto-reply**~~ **CLOSED BY
  DECISION 2026-08-14** — see "Decisions landed 2026-08-14" at the bottom of this file:
  the 312 in staff auto-replies STAYS (the 312 GV is staffed and its mailbox deliberately
  alive). Code is correctly unchanged (`smsInbound.js:17-18`). No action.
- ~~**Archive legacy proposal-options stragglers Ruta 469 + Anna 475**~~ **CLOSED
  2026-08-14 — they were ALREADY archived** (the July TODO went stale; someone did them
  along the way). Checked prod: both `archived`, $0 paid, zero shifts / live invoices /
  pending messages. Only blemish was `archive_reason` NULL (pre-reason-picker era);
  backfilled to `option_not_chosen` via a guarded UPDATE so the archive bucket reads
  truthfully. Nothing else to do.

Also corrected during this audit: the phone-1a memory claimed the 1922 cutover was still
owed — it completed 2026-08-11, proven by the live canary test calls. ~~The one unverified
half is the 1922's MESSAGING webhook (`/api/sms/inbound`), which has no recorded live test~~
(SUPERSEDED same day: the messaging webhook was PROVEN 2026-08-13 — see the easy-walk
bundle entry below and the ticked walkthroughs-owed line; do not re-open it from this
paragraph).


# Added 2026-08-13 (from Dallas's easy-walk bundle)

- **Bar-rental shifts don't list the bar: the duty deriver and the equipment card don't
  talk.** Dallas opened his own past bar-rental shifts (367 Jelena, 373 Drew) expecting the
  Equipment card to show the bar — it showed nothing, correctly, because
  `shifts.equipment_required` is `'[]'` on both. Yet BOTH shifts paid him the $20
  `bar_rental` duty, derived from the booking (`num_bars > 0` + snapshot bar_rental total).
  So the system knows a bar is coming for PAY purposes while the staffer-facing equipment
  list stays empty unless an admin hand-sets it.
  **FIXED 2026-08-13 — derive-at-read won, not prefill** (a prefill snapshots a booking fact
  that can change; derivation tracks the proposal and fixed every existing shift instantly).
  One shared SQL fragment, `barRequiredSql` in `shifts.queries.js`, matching the duty
  deriver's MONEY predicates exactly — hosted (per_guest) with `num_bars > 0`, or BYOB with
  `num_bars > 0` AND snapshot bar-rental money — because bare `num_bars > 0` over-claims
  (the column DEFAULTS to 1; 17 prod proposals carry a defaulted bar and no bar money; the
  first draft used it and correctly broke four bare-request tests). Consumed by the staff
  feed, the request transport gate (`shiftRequiresTransport` + RequestSheet mirror, so
  staff must ACKNOWLEDGE the bar before requesting), and the event-details payload
  (EquipmentCard renders "Portable bar — DRB pickup at Pilsen, or bring your own").
  Cooler copy fixed at the same time (Dallas: kit includes an EMPTY cooler — ice and beer
  are not part of it): EquipmentCard note + FieldGuide standard-kit list (which had no
  cooler line at all). Suites: approval 30/30 incl. a new booked-bar-alone ack test,
  beo 29/29, eventDetails 17/17, CI build green. `shifts.approval.js` is a sensitive path
  → full fleet at push.
- **NA beer copy law extended (Dallas 2026-08-13): name the BRAND only, never varieties.**
  "Upside Dawn / Free Wave" removed everywhere; prod UPDATEd directly, schema seed + both
  guarded UPDATEs aligned, converging IN() guard added. Athletic's lineup changes; variety
  names in catalog copy read as a menu we then fail to honor.
- **1922 messaging webhook PROVEN 2026-08-13** — Dallas texted it, the inbound pipeline
  answered with the freeform staff auto-reply. That reply also live-demonstrated the
  `smsInbound.js:9` 312-handout item above: the automated line told Dallas to contact
  Dallas at the 312. Phone-1a cutover is now fully verified, voice and messaging.


# Added 2026-08-13 (marketing phases 1+2 push-gate, non-blocking findings)

The HIGH (compose resume dying at unmount) and two MEDIUMs (fieldErrors never rendered,
Sent placeholder naming the wrong phase) were fixed at the gate before the push. These are
the LOWs that rode to this list instead:

- ~~**Campaign archive doesn't guard against mid-send**~~ **FIXED 2026-08-14 (7b5be986)**: the archive UPDATE excludes `status = 'sending'` and 409s with a plain-language message; not-found still 404s. Original (`emailMarketing/campaigns.js:207`):
  DELETE archives unconditionally, including a campaign whose run is in flight. The run
  keeps mailing (per-recipient claims still arbitrate, so no duplicates), but the release
  UPDATE matches nothing and the campaign strands archived with a claim-stamp `sent_at`.
  Guard the archive on `status <> 'sending'`.
- **CSV lead import: one bad row poisons the transaction and the response lies**
  (`emailMarketing/leads.js:130-166`, pre-existing, carried through the file split): the
  per-row catch sits inside one transaction, so a genuine row error aborts it, every later
  row fails 25P02, COMMIT silently rolls back, and the response still reports
  `imported > 0`. Same block echoes raw Postgres error text (constraint/column names) to
  the admin. Per-row savepoints or batch-validate first.
- ~~**CommandPalette offers Marketing to managers**~~ **FIXED 2026-08-14 (4d8a5394)**: the palette now mirrors the Sidebar's adminOnly gate via useAuth. Original (`components/adminos/CommandPalette.js:148`): the palette
  has no role filter, so a manager picking Marketing is bounced home by adminStrict.
  Mirror the Sidebar's `adminOnly` filtering.
- **Sequence drip can miss single-row lead suppression on case-variant twins**
  (`emailSequenceScheduler.js:72-87`): `email_leads` is unique on RAW email, so
  case-variant rows for one address coexist; the Resend webhook flips exactly one row by
  `lead_id`, and the drip gates only on its own row's `status='active'` while campaigns
  suppress by normalized address. Narrow (the unsubscribe POST flips all rows by address);
  gate the drip through the shared `leadUnsubscribedByEmail` to close it.
- ~~**`marketingAudience.js:18-24` sender registry says THREE senders; there are FOUR.**~~ **FIXED 2026-08-14 (982e6f5a)**: registry counts four, designer test send listed.
  The designer test send became a gated sender in this batch. The registry comment is what
  a future "audit all senders" pass reads; add the fourth entry.
- **Send loop trusts mailability resolved at run start** (`marketingSend.js:235`, codex):
  a contact who unsubscribes mid-run (a multi-minute window at 600ms pacing) is still
  mailed. The per-recipient claim moment could re-check the two shared suppression
  helpers cheaply.
- **Sent-but-recorded-failed duplicate seam** (`marketingSend.js:336-359`, codex): a
  successful Resend call followed by a transient failure of the `status='sent'` UPDATE
  lands in the catch and marks the row `'failed'`; a later retry reclaims and re-sends
  that one recipient. Needs a single-query DB blip, so rare, and at-least-once is the
  deliberate lean here; a targeted fix is separating send-success bookkeeping failures
  from send failures.
- **`schema.sql:1642-1647` (drifted from 1634-1637) re-creates the email_sends CHECK every boot**: the DROP+ADD
  pair replays per deploy (ACCESS EXCLUSIVE + validation scan). Fine at current table
  size; convert to a guarded DO block when email_sends grows.
- **Deploy-mid-send is recoverable but reads wrong** (`server/index.js:762` +
  `marketingSend.js`): SIGTERM's 15s hard-exit can kill an in-flight blast; claims protect
  everyone mailed and the campaign unlocks after the 15-min stale window, but the UI toast
  says "The send failed." for a half-completed run and retry 409s until the window lapses.
  Operational rule meanwhile: don't push to prod while a campaign is sending.

# Added 2026-08-13 (growth-gate, codex)

- ~~**Soft-drink convergence guard misses the em-dash-era variant**~~ **FIXED 2026-08-14 (7b5be986)**: the em-dash variant (recovered from June history) is the IN() list's third member. Original:
  (`server/db/schema.sql` ~:761): the IN() list converges the terse original seed and the
  comma/colon long paragraph, but a third historical state exists: the em-dash punctuation
  variant seeded roughly Apr 22 to Jul 11 (the no-em-dashes sweep re-guarded only against
  the terse seed, so em-dash-era DBs kept it). Zero live impact today: prod was
  hand-converged and dev verified at the final text on 2026-08-13, and fresh DBs seed the
  new text directly. Only a restore of an Apr-Jul snapshot could resurrect it. One-line
  fix when convenient: add the em-dash variant to the IN() list.

# Added 2026-08-13 (round-3 push-gate, non-blocking findings)

The stale-response race in ProposalsDashboard (codex) was fixed at the gate. The rest:

- **Option-group rollup splits across the 50-row page boundary**
  (`ProposalsDashboard.js` rollup memo, codex): grouping happens client-side over one
  fetched page, so a group straddling the boundary renders on BOTH pages, each with its
  local option count. Rare (needs siblings at exactly rows 50/51) and display-only, but a
  real artifact. Fix needs a design call: group server-side, or fetch group tails, or
  accept and note it in the pager copy. The owed pagination browser walk should try to
  catch one live.
- **`barRequiredSql` casts snapshot money with `::numeric` while the duty deriver
  tolerates malformed snapshots** (`shifts.queries.js`, database lens): a non-numeric
  `pricing_snapshot->'bar_rental'->>'total'` would 22P02 the staff feed where
  `readSnapshot` would shrug. Engine-owned data, not currently reachable; align the
  tolerance if a snapshot writer ever diversifies.
- ~~**Double bar row when an admin hand-sets `portable_bar`**~~ **FIXED 2026-08-14 (4d8a5394)**: the equipment list drops a hand-set `portable_bar` token whenever the derived row renders. Original (`BeoSections.js`, seam +
  code lenses): the derived bar row and the equipment-list token both render on the three
  prod shifts with hand-set tokens. Redundant, not wrong. A
  `list.filter(t => t !== 'portable_bar')` when barRequired closes it; the owed
  walkthrough already retargets those shifts.
- ~~**BeoSections comment names one of two duty kinds**~~ **FIXED 2026-08-14 (4d8a5394)**: comment names both bar_rental (BYOB) and hosted_supplies (hosted). Original (seam lens): the bar row is paid
  via `bar_rental` on BYOB but `hosted_supplies` on hosted; the comment says only
  bar_rental. Two-line comment fix.
- ~~**Em dashes in new staff-facing copy**~~ **DECIDED + SWEPT 2026-08-14 (Dallas:
  "extend it")**: the law now covers staff-facing copy. Swept: BeoSections bar row
  (colon), BeoSections cooler note (colon), FieldGuide cooler line (comma). Exempt by
  scope: lone '—' empty-value placeholders (glyphs, not prose), comments, internal
  error strings, and the version-frozen `contractorAgreement.js` (punctuation edits
  to a signed document mean a v4, never a sweep).

# SESSION WRAP 2026-08-14 — read this first if you are picking the work back up

**NOTHING IS PUSHED.** Everything below is on LOCAL main or in a lane. `origin/main` is
untouched, so a push carries all of it at once and needs the full gate.

**Merged to local main, reviewed clean:**
- `3155625c` lane `drop-email-enabled` — `communication_preferences.email_enabled` removed
  (Dallas: "drop"). 3/3 lenses PASS, incl. a campaign-audience compliance lens that re-derived
  the truth tables and confirmed the 12 live opt-outs still bucket via `marketing_enabled`.
- `d2380803` lane `date-trap-live-fixes` — two LIVE prod bugs: the paystub paid date (UTC day
  off a TIMESTAMPTZ, wrong on 9 of 25 issued stubs) and staff shifts bucketing 'past' at 19:00
  Chicago on the day of the event. 3/3 PASS, tests fail-before/pass-after at TZ=UTC AND Chicago.

**Prod data changed by hand this session** (all recorded inline above with before-values):
user 61 preferred_name/display_name -> "Taylor Hogan" / "Taylor H."; user 31 deactivated
(fired, notice deliberately suppressed, audit rows written with `via=manual_sql_offboarding`).

**Three more lanes merged to local main (still unpushed):**
- `5d078096` `misquote-qualifier` — the client-facing `per_guest_timed` misquote. Owed suite run
  green (`publicOptions.test.js` 14/14). Found a FIFTH bare-rate site the brief missed, and
  caught that the admin quote builder was already rounding a $0.50 rate to "$1".
- `697cef2a` `wave2-residuals` — repriceSummary overpaid tests + the consult ingredient-shape
  guard. All 5 owed suites green (one needed `ALLOW_TEST_DB_WRITES=1`; its refusal is a guard,
  not a failure). Correctly went BEYOND its brief: `sanitizeConsult` is the ONLY writer of
  `consult_selections`, so fixing it there stops `[object Object]` being PERSISTED into JSONB
  rather than merely re-rendered, and `consultRecap.js` is a third reader that puts it in a
  client-facing email.
- `3ed7db5f` `admin-os-legacy-palette` — the legacy palette scoped out of admin-os at the
  source. Re-verified against the NEW main HEAD, which carries 245 lines of mobile-admin CSS the
  lane never saw: checker green, CI client build exit 0.

**Open lanes:**
| lane | HEAD | state |
|---|---|---|
| `shift-lifecycle` | `4762b481` | THE re-cut, per spec `0b54f138`. Built; review in flight. Supersedes the two below. |
| `shift-closure` | `b8512e15` | 3 rounds, 2 FAILs outstanding. Superseded; keep until the re-cut merges. |
| `current-date-shift-visibility` | `18768c72` | 2 rounds, P0 outstanding. Superseded; keep until the re-cut merges. |
| `mkt-perf` | `b410d374` | FAILED review. Font preload lands in the ONE index.html served to every host, so admin/staff would pull 173 KB of marketing fonts. Needs rework. |

Do NOT scrap `shift-closure` or `current-date-shift-visibility` without Dallas's okay:
`git log main..<branch>` is non-empty on both. The re-cut lane is salvaging their tests.
Branches `admin-os-legacy-palette`, `misquote-qualifier` and `wave2-residuals` are merged; the
first is kept (its byte-identical check is non-empty only because main is AHEAD on `index.css`
and `README.md`, verified: all 193 of its added lines are present on main).

## The CSS palette checker ships with KNOWN BLIND SPOTS — do not trust its green tick

`scripts/check-css-palette-scope.js` merged in `3ed7db5f`. It is **warn-only** in
`.husky/pre-commit` (`|| true`, with a comment saying reverting that is not a cleanup), so it
cannot block a commit; `npm run check:css-scope` still exits 1. It catches the exact regression
that bit twice (an unscoped bare-element rule painting `--cream-text`), which was its purpose.
It does NOT catch these, all proven by fuzzing with real CLI output:
- **`input[type="text"] { color: var(--cream-text) }` passes.** Check A treats ANY attribute
  selector as app-scoping, but `[type="text"]` confines nothing.
- **`p:not(.mkt-only) { color: var(--cream-text) }` passes.** It escapes check A (contains a dot)
  and then check B, whose "every class must be admin-reachable" test is logically inverted for
  `:not()` classes.
- **A parse desync silently passes.** One stray apostrophe upstream collapses the sheet to 10
  rules and it still prints the tick with a live leak in the file; the anti-vacuous guard only
  fires at EXACTLY zero tokens.
- Lesser: a rule that locally redefines a skin-aware token to a legacy value; a hex literal
  reached through a `var()` alias chain; `VAR(` uppercase; `[data-app="admin-os" i]` (the only
  false positive found); and `background`/`border` are not checked at all, only text colour.
Fixing these is a bounded, well-specified job — the fuzzing report lists the exact inputs.
Until then treat a green tick as "the known re-arming shapes are absent", not "the leak is closed".

**Owed by a human, not by Claude:**
- The admin two-skin eyeball on House Lights. No browser has been run in ANY of this work; every
  contrast figure is arithmetic on token values. The lane produced a screen-by-screen list.
- POST-DEPLOY ONLY: clear `paystub_storage_key` on the 9 wrong paystubs so they re-render.
  Doing it BEFORE the fix deploys just re-renders the same wrong date.

**Still undecided:** nothing blocking. The shift-lifecycle design question was resolved
("your call" -> end-instant re-cut, spec `0b54f138`).

# Decisions landed 2026-08-14

- **The 312 in staff auto-replies STAYS (Dallas: "312 is still being used").** The
  `smsInbound.js` item from 2026-08-13 is closed as decided-keep, not fixed: the 312 GV is
  staffed by Dallas/Zul and remains the human-contact line for STAFF, while clients get the
  1922. Do not re-raise; revisit only if the 312 is ever retired.

# Push-gate 2026-08-14 (fleet 5/5 + codex/gemini on the 34-commit batch)

**Blocking findings FIXED pre-push (same day):**
- **F1 (fleet, money):** the new lifecycle archive reap had no source-status gate — a
  `?force=true` archive from `completed` denied the shift_requests roster the tip
  clawback reads, so a later `charge.refunded` would claw NOTHING and mark itself done,
  permanently. Fixed: `REAP_SOURCE_STATUSES` gate (matching actions.js's door) + an
  in-tx archived re-check under FOR UPDATE (also closes codex's archive-vs-restore
  race) + `reapedShifts` assigned only post-COMMIT (F2: no "cancelled" emails for a
  rolled-back reap). New regression test pins the completed-source no-reap; the test
  helper now forwards query strings (`u.search`) so `?force=true` actually arrives.
- **Voice docs lied post-demotion (fleet):** ARCHITECTURE ×2, voice.js's window-claim
  rationale, and the 1a plan's operational note all still said the canary pages Sentry.
  Corrected to log-only at all four sites.
- **BizCardLayout surrogate split (fleet seam):** `word[0]`/`slice(1)` small-caps would
  split an astral-plane first letter across two spans on a pressed card — made
  reachable by the unicode-names widening in the same batch. `capSplit` now
  spread-iterates code points (mirrors the server's staffDisplayName hardening).
- **admin-os `.form-select:focus`** had the same padding-shorthand chevron clobber the
  global fix addressed; re-asserted. (Potion's rest/focus values agree; left alone.)
- **`proposals/lifecycle.js` added to sensitive-paths.txt** — it gates status
  transitions including force-archive and was invisible to review scaling.

**Non-blocking, recorded for later:**
- marketingSend's run claim (`status <> 'sending' OR ...`) accepts an ARCHIVED campaign
  (codex HIGH; PRE-EXISTING, ms race window, DELETE has no UI caller). Harden someday:
  `AND status <> 'archived'` on the claim WHERE.
- `DELETE /campaigns/:id` has NO client caller at all — the new 409 guard is API-only
  and the marketing UI offers no archive control (coverage gap, pre-existing).
- A campaign stranded `sending` by a process death is un-archivable until a re-send
  recovers the stale claim (recoverable by design; note only).
- SMS cost line: one non-GSM-7 letter in a bartender's preferred name (Zoë, Núñez,
  李娜) flips the event-eve SMS from 2 to 4 segments. Cost, not correctness.
- Paystub PDF renders CJK preferred names as mojibake on the fallback path only (no
  crash; agreement/application full_name wins when present). Tip-sign display fonts
  lack Han/Cyrillic (browser per-glyph fallback at 300 DPI). Latin accents fine in both.
- Client `computeDisplayName` port lacks the server's surrogate hardening
  (preview-only surface; `charAt(0)` last-initial).
- ~~The `.staffing-stat strong` ink fix is DEAD CSS — zero consumers in client/src;
  delete the rule (or the block) whenever that area is next touched.~~
  **DONE 2026-08-14 (2233a1b6)**: the whole `.staffing-stats` / `.staffing-stat` block was
  deleted, not just the one rule, since it had zero consumers. This supersedes the earlier
  same-day ink fix (8045743e) on that selector.
- ~~15cc4df0's message overstates: the inert 38% `th` width hint survives at
  `ContactTable.js:59` (harmless; no `table-layout: fixed`).~~
  **FIXED 2026-08-14 (2233a1b6)**: the inert hint is removed, so the commit message and the
  code agree now.
- **tip-e-redesign merged without a declared lane** in its plan (lanes a-d only) and
  outside tip-d's declared footprint; its design-artifact README documents the
  re-scope deliberately, but the custody chain is incomplete (no .dc.html snapshot;
  README and Task 8 name DIFFERENT design-project ids). Accepted for this push
  (per-lane reviewed, nothing sensitive-listed); reconcile the ids and tighten the
  footprint discipline on the next tip lane.
- NFD-normalized input (decomposed é) and iOS curly-apostrophe names still reject
  with the generic letters-only error (pre-existing; the widening is strictly
  additive). Candidate fix: `.normalize('NFC')` + a U+2019→' fold in `norm()`.

# Added 2026-08-14 (small-fix wave 2 findings)

Surfaced while shipping the four wave-2 commits (ed08114f, 9b695af0, 2233a1b6, 46d2974c).
None of these were in scope for that wave; each is logged here rather than fixed in passing.

- **The `toYmd` shape is repo-wide, and TWO instances are LIVE ON PROD — not latent.**
  **Fully re-audited 2026-08-14. The version of this entry written earlier that day was
  wrong on the most important point and is corrected below; read this, not it.**

  **The "nothing is wrong in prod today, this is latent" claim was FALSE. Two sites are
  broken on Render right now, and both are being fixed in lane `date-trap-live-fixes`
  (owner approved 2026-08-14, "yes fix both"):**
  1. **The paystub paid date, wrong on 9 of 25 issued stubs.** `paystubData.js:147`
     renders `ymd(h.paid_at)`, but `payouts.paid_at` is `TIMESTAMPTZ` (`schema.sql:3112`)
     written by `NOW()` at `admin/payroll.js:581`, i.e. a true instant, and `ymd`
     (`:18-22`) takes the UTC day off it. A payout marked paid at 8:30pm Chicago prints
     the NEXT day. Wrong on a Chicago box AND on Render, because `toISOString()` is UTC
     regardless of process TZ, so no timezone change is needed to trigger it. Counted
     against prod: 9 of the 25 paid payouts have a Chicago date differing from their UTC
     date. **The PDFs are cached in R2** (`staffPortal/payouts.js:326` serves the stored
     key and only re-renders on a miss), so fixing the code does NOT repair the nine
     already issued: their `paystub_storage_key` must be cleared AFTER the fix deploys,
     never before, or they re-render just as wrong. Correct helper is `chicagoYmdOf`
     (`businessTime.js:67`), NOT `toCalendarYmd`. This same bug was already found and
     fixed once at `proposals/cancel.js:511-513`, whose comment reads "toCalendarYmd on a
     TIMESTAMPTZ reads the GMT day on prod".
  2. **Staff shifts bucket as "past" 30 minutes before the event.** `shifts.js:223` is
     `new Date().toISOString().slice(0,10)`, UTC today, compared against event dates at
     `:224-231` (route `GET /shifts/user/:userId/events`, consumed by
     `staff/ShiftsPage.js:141`). On Render every staffer's event silently leaves Upcoming
     at 7pm Chicago (6pm in winter) ON THE DAY OF THE EVENT. Fix is `chicagoTodayYmd()`
     (`businessTime.js:55`). Note `:227` in the same block needs `toCalendarYmd` instead
     and the two errors point in OPPOSITE directions, so they do not cancel.

  **DO NOT retarget `balanceScheduler.js:77` on its own.** It and `server/routes/stripe.js:340`
  build the SAME Stripe idempotency key (`autopay-balance-<id>-<balanceDueIso>`) from this
  expression, deliberately mirrored (see the comments at `balanceScheduler.js:73-76` and
  `stripe.js:337-338`) so a manual click racing a scheduler tick returns the same
  PaymentIntent. Changing one and not the other makes the keys diverge and removes the only
  guard against a second real balance charge. One commit, its own lane, nothing else in it.
  Both are on `sensitive-paths.txt`. The earlier "first five to check" ordering listed
  `balanceScheduler` fifth and never mentioned `stripe.js` at all, which is exactly how that
  fix would have gone wrong.

  **Corrected facts:**
  - **Direction.** A pg `DATE` parsed at local midnight shifts back a day EAST of UTC
    (UTC+X), not west; west is the safe side for a DATE. Proven across
    UTC/Chicago/Manila/Sydney/Kiritimati. Separately a `TIMESTAMP WITHOUT TIME ZONE` with
    an evening time shifts FORWARD west of UTC. Lumping "DATE/TIMESTAMP" together hides
    two opposite hazards. (`:1075` and four in-repo docblocks already had this right.)
  - **Count.** 32 occurrences across 28 non-test files, plus 9 test files. The old "26
    across 21" was right for `server/**` + `scripts/**` only and missed SIX client-side
    sites (`useMetricsFilter.js:12`, `RevenueChartCard.js:63`, `DocumentsSection.js:92`,
    `ReplaceConfirmModal.js:76`, `ClassWizard.js:401`, `EventDetailsStep.js:53`).
    Classified: 14 dangerous, 13 safe-by-construction, 3 safe-by-design, 1 unclear.
  - **The helper is hand-rolled SIXTEEN times, not five, and the five `toCalendarYmd`
    copies are THREE different implementations with three different behaviors.**
    `preEventScheduling.js:30` has no guards and returns the literal string `"null"` on
    null input; `rescheduleProposal.js:46` and `staffShiftHandlers.js:52` are
    byte-identical with full guards; `payrollAccrual.js:100` and `cancel.js:57` are
    byte-identical with a falsy guard but NO NaN guard, returning `"NaN-NaN-NaN"` on an
    Invalid Date. Eleven more open-coded under other names: `coverBroadcast.js:83`,
    `balanceReminderScheduling.js:38`, `serviceCurfew.js:100`, `smsEventDate.js:20`,
    `staffShiftActions.js:132` and `:849`, `eventEveSms.js:69`, `importValidation.js:118`,
    `generateSeniorityMapping.js:40`, `applySeniorityBackfill.js:43`, client
    `PayPage.js:576`.
  - **The 1099 tax-year worry is NOT real** and must not drive urgency here. The 1099 comes
    from `GET /payroll/tax-totals`, which buckets entirely in SQL (`payrollTax.js:109,131`)
    and never touches the JS helper; the paystub does not feed the 1099; and
    `payrollTax.js:125-130` already documents and fixes the Chicago/GMT year skew on
    `paid_at` in SQL.
  - **Sensitivity gap (same shape the list documents four times elsewhere):**
    `paystubData.js` — the file this entry calls a MONEY path — is NOT on
    `sensitive-paths.txt`, and neither is `admin/payrollTax.js`, the 1099 surface. Both
    scale to a light look. Also unlisted: `shifts.js`, `shiftTime.js`,
    `staffCalendarFeedExt.js`, `orientationData.js`, `balanceInvoiceMonitor.js`,
    `calendar.js`. And `staffPortal/payouts.paystub.test.js`, the only direct paystub
    suite, is not on `money-smoke-list.txt` (though `payouts.test.js` is).
  - **No existing test can catch any of this**: the one TZ-pinned suite pins UTC, which is
    the value at which several of these bugs are silent. Any fix here needs tests at two
    or more TZ values or it proves nothing.
  - `orientationData.js:60` carries a factually wrong comment that will mislead the next
    reader.

  **FIXED 2026-08-14, lane `date-trap-live-fixes`, merged `d2380803`** (3/3 review lenses PASS;
  tests fail before and pass after at BOTH `TZ=UTC` and `TZ=America/Chicago`, which is the
  point, since the whole bug class is timezone-dependent and the one pre-existing TZ-pinned
  suite pins UTC, the value at which these are silent). `paystubData.js:147` now uses
  `chicagoYmdOf`, null-guarded so an unpaid payout does not render the 1969 epoch;
  `shifts.js:223` now uses `chicagoTodayYmd()`. The sibling `ymd()` in
  `staffPortal/payouts.js` was checked and needed NO change: all five of its call sites take
  pg `DATE` columns, and `paid_at` is projected raw to the client and never passes through it.

  **STILL OPEN, and the first of these is arguably worse than what was just fixed. Found by
  two independent reviewers, and NOT introduced by that lane:**
  - **`shifts.queries.js:84` (`STAFF_OPEN_SHIFTS_SQL`) and `shifts.js:199`
    (`GET /shifts/unstaffed-upcoming`) filter `s.event_date >= CURRENT_DATE`, and the
    Postgres session TimeZone is `GMT` — verified, not assumed (`SHOW timezone` returns GMT;
    `SELECT current_date` returned 2026-08-14 at 12:06 Chicago).** So `CURRENT_DATE` is the
    UTC day: the identical trap, in SQL instead of JS, 25 lines from the one just fixed.
    From 19:00 Chicago (18:00 in winter) an open shift TONIGHT is dropped from both lists for
    five hours. **The admin side is the real damage:** `unstaffed-upcoming` feeds
    `AssignToEventModal`, so at 19:01 an under-staffed shift starting at 20:00 is invisible to
    the person trying to cover a no-show, at exactly the hour that matters. This is LIVE today
    and was live before the fix. Consequence of fixing only the JS half: the staffer's Mine tab
    now says the shift is upcoming while the Available tab and the admin modal say it does not
    exist. Fix is the same shape (`chicagoTodayYmd()` bound as a parameter, or
    `CURRENT_DATE AT TIME ZONE 'America/Chicago'`).
  - **`client/src/pages/staff/PayPage.js:581` and `PayoutDetail.js:422`** both do
    `String(iso).slice(0,10)` on the RAW `paid_at` the API returns, i.e. the UTC day again, one
    layer out. Before the lane the PDF and the Pay screen were wrong together; now only the PDF
    is right and they disagree. Worked example: paid 2026-12-31 18:01 CST renders "Paid Fri
    Jan 1" on screen while the PDF says 2026-12-31 and the 1099 counts it in 2026 (SQL extracts
    the year `AT TIME ZONE 'America/Chicago'`).
  - **The 9 already-issued paystubs are NOT repaired by the code fix.**
    `staffPortal/payouts.js:325` early-returns the cached R2 PDF whenever
    `paystub_storage_key` is set, so the assembler is never called. Their storage keys must be
    cleared AFTER the fix deploys (clearing them before just re-renders the same wrong date).
    Post-deploy step, owner-owned.
  - **Sensitivity gap:** `paystubData.js`, `paystubPdf.js` and `businessTime.js` are not on
    `sensitive-paths.txt`, so a change to the money content of a tax document does not pull the
    push-time full fleet. Only `payrollAccrual.js` matched, via the `payroll*.js` glob, which
    does not cover `paystub*`.
  - **Shared-dev-DB test hygiene:** `paystubData.paidDate.test.js:57` adopts a `pay_periods`
    row via `ON CONFLICT (start_date) DO UPDATE` and `after()` deletes that id, so an
    interrupted run can rewrite another lane's period boundary and then fail its own cleanup on
    the FK. Dev-only, no prod path, but this DB is explicitly shared.

- **repriceSummary's new overpaid branches are untested.**
  `client/src/pages/admin/proposalEditor/repriceSummary.test.js` has no
  overpaid-plus-increase case: every existing increase test runs with
  `amountPaid <= totalPrice` (1000/1000, 100/1606.25, 0/1000, 100/1606.25). So all three
  shapes 2233a1b6 introduced are unpinned: overpayment still covers the increase,
  overpayment covers it exactly, and the increase outruns the overpayment. The demotion
  suppression is unpinned for the same reason. Cheap to add, and this is admin-facing
  money copy, so it should not stay on trust.

- **`createAdditionalInvoiceIfNeeded` mints the full `newTotal - oldTotal` without
  netting an existing overpayment.** `server/utils/invoiceLifecycle.js:338` computes
  `diffCents = newTotalCents - oldTotalCents` and passes it straight to the invoice as
  `amountDueCents` (`:346`), with no read of `amount_paid`. On an already-overpaid,
  fully-locked proposal that invoices the client for money DRB is already holding. This
  is server behavior and was out of scope for the wave's copy fix, but it is the same
  defect the copy fix was describing, one layer down. It rhymes with the standing
  "Refunds: overpayment never clears" entry above and should be picked up with it, not
  on its own: both turn on the system having no single notion of credit-on-hand.

- **`communication_preferences.email_enabled` has NO product writer.** Every writer in
  the codebase sets something else: `smsConsent.js:122` and `smsInbound.js:332,341` write
  `sms_enabled`, `emailMarketing/unsubscribe.js:179` writes `marketing_enabled`, and
  `proposals/public.js:364` writes `sms_enabled`. Yet `email_enabled === false` is read
  and honored in at least five places (`messageSuppression.js:34`, `eventEveSms.js:208`,
  `channelFallback.js:22`, `notificationChannelResolver.js:54,66`,
  `marketingAudience.js:359`). So the flag can only ever become false via a manual DB
  edit, which makes it invisible ops state that silently mutes a client. Two honest
  outcomes: wire a writer, where the "Do not contact" toggle already on this list is the
  natural home, or drop the field and let the readers collapse. Note
  `messageSuppression.js:63` already carries a comment saying no product path sets it,
  so the code knows.

- **`PUT /contacts/:id/email-status` can clear a bad-email flag but has no admin UI wired
  to it.** The route is real and tested (`server/routes/marketingContacts.js:185`, covered
  in `marketingContacts.tags.test.js`), but nothing in `client/src` calls it. An admin who
  fixes a bounced address therefore has no way to un-mark it from a screen, and the contact
  stays flagged until someone hits the API by hand. `messageSuppression.js:70` already
  carries this as advice in a comment. Small win: one control on the contact row.

- **Client-side name handling has two residuals, both worth one pass.** The client
  `computeDisplayName` port lacks the server's surrogate hardening (`charAt(0)` for the
  last initial, which splits an astral-plane letter), preview-only surface. Separately,
  NFD-normalized input (decomposed accents) and iOS curly apostrophes still bounce off the
  widened name regex in both copies. Candidate fix for the second: `.normalize('NFC')` plus
  a U+2019 to `'` fold inside `norm()`, applied to both the server and client copies
  together per the keep-in-sync comments. These consolidate the two name notes in the
  8/14 push-gate section above; track them here.

# Price guide: what the 2026-08-14 brainstorm produced before Dallas stopped it

Attempted, stopped partway ("that sounds riddled with problems. I dont want to do
this rn"). Recorded so the next attempt starts here instead of re-treading. Nothing
was built and no spec was written.

**Why this project keeps stalling (Dallas's own read: "this project keeps getting
put off because of this").** The information architecture is the hard part, and it
resists the two obvious answers:
- Search alone fails, because he often cannot NAME the thing. Verbatim: "WTF did we
  decide to call the add-on bundles? Full compound?" Search requires the word.
- Categories alone fail, because when he DOES know it is the Full Compound he should
  not have to remember it lives under BYOB supplies and click twice to see $8.
Every design that optimizes one of those is bad at the other. My proposal of one
page holding the whole catalog was rejected outright and correctly: "one big giant
scrolling hell. No." Categories, search, or something else entirely are all still
open. The next attempt should start from the IA, not from a surface.

**Requirements established (these are solid, reuse them):**
- Desktop first. "I hate using the phone." This is NOT the mobile-admin beachhead,
  though a later mobile view should inherit the same endpoint.
- THE governing rule: **small numbers must be exact, the big number can be fuzzy.**
  Verbatim: "If I say the full compound costs $7/guest and then send a proposal and
  its $9/guest, that is an error. If I say that brings the total to $555 and really
  its $600, but the line items were right, that is forgivable." So this is a rate
  card first and a calculator a distant second, which is the opposite of where the
  brainstorm started.
- The real cost of not having it: he says "I'll let you know" and loses the moment on
  a warm call, or stumbles while hunting. He is not missing the data, he is missing
  recall: "I have researched and carefully chosen these numbers, but I don't have
  them memorized."
- Scope is the WHOLE catalog, not just the call-facing sellables ("I need it all").
- Read-only by construction: no drafts, no saves, no proposal can ever be created
  from it. That is what makes it different from the quote wizard.
- Today's three surfaces all fail because they are transactional: event details is
  about one booked event, the quote wizard is about building something, and both
  make you navigate to a specific record before they will tell you a general fact.

**Live numbers pulled during the session** (prod, 2026-08-14; the tool would read
these live, never a copy, because catalog copy has drifted from schema.sql before):
hosted per-guest at 4hr, extra hour in parens: Primary Culture $12 (+$4), Clear
Reaction $14 (+$4), Refined Reaction $14 (+$5), Carbon Suspension $15 (+$5.75),
Cultivated Complex $17 (+$6.25), Base Compound $18 (+$5), Midrange Reaction $22
(+$6), Enhanced Solution $28 (+$8), Formula No. 5 $33 (+$9), Grand Experiment $40
(+$11.25); all hosted carry min_total $550 and min_billed_guests 25. BYOB: Core
Reaction $350 flat at 4hr (+$100/hr). Six class packages all at $35/guest. Bundles:
Foundation $3.00, Formula $5.50, Full Compound $8.00. A la carte: Full Mixers $4.50,
Signature Mixers $2.00, Ice $2.00, Cups & Disposables $1.50, Bottled Water $0.50,
Garnish $50 per 100 guests. Bundle CONTENTS live in code (client bundleConfig.js
mirrored by server proposalRules.js), not the DB, so any lookup surface must read
that shared config rather than restate it.

## LIVE MISQUOTE RISK, independent of whether the tool is ever built

The three BYOB bundles bill `per_guest_timed` (`pricingEngine.js:160-165`): the
listed rate is the FOUR-HOUR price, and each hour beyond four adds the addon's
`extra_hour_rate` per guest. So The Full Compound is $8.00/guest at 4 hours and
**$10.00/guest at 5** (+$2.00/hr); The Formula $5.50 goes to $6.75 (+$1.25); The
Foundation $3.00 goes to $3.75 (+$0.75). Quoting the bare rate on a five-hour party
is a 25% error on exactly the kind of small number Dallas says is unforgivable.

CORRECTED at the 2026-08-14 push gate (this entry originally claimed "nothing on any
admin surface warns about it," which is false). The admin proposal editor DOES warn:
`proposalEditor/PackageSection.js:86` renders the complete form, `$8/guest (4hr) +
$2/guest/hr after`, and `proposalCreate/AddonSection.js:39` shows a partial `(4hr)`.
The real gap is CLIENT-FACING, where the bare per-guest rate prints with no timing
qualifier at all: `quoteWizard/helpers.js:54` and
`proposal/otherOptions/ExtrasPanel.js:15`. Those two are where a client reads $8 and
holds us to it. Also wider than stated: `mocktail-bar` ($7.50 / +$2.00) is a FOURTH
`per_guest_timed` addon with the same shape, so a fix should key on the billing type
rather than on the three bundle slugs.

## Schema regression trap found at the 2026-08-14 push gate (FIXED in the same batch)

`proposals_archive_reason_check` is defined TWICE in `schema.sql`, and the two lists
disagreed: the earlier definition (~line 2714) omitted `option_not_chosen`, which the
later one (~line 3977) adds for losing options archived at choice. Statements apply in
file order, so a complete boot ends on the correct definition and everything looks
fine. An initDb run that aborts or is interrupted ANYWHERE between the two leaves the
narrower constraint in place, and every `option_not_chosen` write then fails 23514.

This is not hypothetical: it happened to the DEV database on 2026-08-14, between two
suite runs in the same session. Symptom was three `notifyClient` record-payment tests
turning 500, because record-payment's same-client sweep archives siblings with exactly
that reason. Prod was verified UNAFFECTED at the time (its constraint carried the full
list), but only by luck of a complete boot, and a prod hit would have broken the
proposal-options archive flow rather than a test.

Fixed by making the earlier list identical to the later one, so a partial run can no
longer regress it, with a comment at both sites saying a new reason goes in BOTH. Dev
was healed by hand to match.

**The general shape is worth a sweep:** any constraint that schema.sql DROPs and
re-adds more than once is a regression trap if the definitions differ, because the
file is re-executed on every boot and is not transactional end to end. `proposals_
status_check` was already collapsed for a related reason (b9c5e4c4). Worth grepping
for every `DROP CONSTRAINT IF EXISTS` that appears more than once with differing
bodies and collapsing or aligning each pair.

### The same trap: DEFINITIVE sweep 2026-08-14 (supersedes the "FIVE more times" list)

**A full re-sweep replaced the earlier ranked list. Two of its five were NOT traps, its
worst-case reasoning was wrong in both directions, and it missed two indexes and a live
dev regression. Read this; the old list is kept in git history only.** Confirmed counts:
**8** constraints added more than once (not 5+1), and exactly **20** bare DROP-then-ADD
pairs (the "~20" was right).

**REAL, ranked by what it actually costs:**
1. **`scheduled_messages_status_check` — still the worst, but for a different reason.**
   Three definitions; the earliest omits `processing`, `dead_letter`,
   `suppressed_by_sibling`. The old entry's "stops the entire pipeline" OVERSTATED the
   ordinary case: the dispatcher ticks every 300s (`server/index.js:735-737`) against a
   ~7s window, so roughly 3% of deploys collide and the next tick would normally recover.
   It UNDERSTATED the consequence of a collision: the 23514 lands in the generic catch at
   `scheduledMessageDispatcher.js:638-647`, which marks the row `'failed'` — a value the
   NARROW list still permits — and `'failed'` is TERMINAL. So a collision does not skip a
   tick, it **permanently drops every due message in that batch**. Balance reminders,
   event-week, event-eve, nudges, silently gone.
2. **`scheduled_messages_channel_check`** — narrowed to `(email, sms)` for ~4s of every
   boot; the earlier body omits `'push'`, which `notificationChannelResolver.js` returns.
3. **`idx_scheduled_messages_pending_uniq` (`schema.sql:2890` narrow → `4212/4213` wide)**
   — the same trap shape on an INDEX, and `4212/4213` is a bare DROP-then-CREATE that
   removes the enqueue-dedupe guard on EVERY boot. Not in `CRITICAL_INDEXES`, so its
   absence boots clean. Missed entirely by the earlier sweep.
4. **`idx_sms_messages_twilio_sid` (`2998/2999`)** — bare DROP-then-CREATE every boot on
   the Twilio dedupe guard. Also not in `CRITICAL_INDEXES`. Also missed.
5. **20 bare DROP-then-ADD constraint pairs**; `email_sends_recipient_check` and the three
   tip FKs rank highest.
6. **`users_onboarding_status_check` — demoted to P3.** There is NO live writer of
   `'suspended'`: `admin/users.js:108` `validStatuses` excludes it and the route throws
   first, and the other writers never emit it. `middleware/auth.js:60` only READS it as a
   deny-list. Prod has zero suspended rows.

**NOT traps, corrected:**
- **`proposals_gratuity_jar_check` is NOT a trap and was wrongly ranked #2 MONEY.**
  `schema.sql:1316-1320` is `IF NOT EXISTS (...) THEN ADD`, so on any DB that already has
  the constraint it is a pure no-op and never drops. The narrow body can only be created
  on a fresh database, and `:1338-1346` swaps it under a `pg_get_constraintdef ... NOT
  LIKE '%gratuity_floor_rate%'` guard, so even an interrupted fresh boot self-heals next
  boot. The guards are what make it safe, not the 22-line distance. Prod and dev both
  carry the correct three-clause definition. (Minor: `gratuity_floor_rate` is read by 9
  server modules, not 8.)
- **`drink_plans_proposal_id_fkey` is NOT a trap** — same `IF NOT EXISTS` guard shape at
  `:889-893`; the earlier site never drops. Prod and dev both have `ON DELETE CASCADE`.
- `proposals_status_check` (direction-safe, earlier is wider) and
  `proposal_payments_payment_type_check` (identical bodies) remain cleared.

**The shape claim was BACKWARDS.** Proven live: a failing BARE `ADD` raises 23514, which
is NOT in `IDEMPOTENT_PG_CODES`, so it DOES reach initDb's `unexpected` array and DOES page
Sentry. The bare form trades safety for visibility; the `DO $$ ... EXCEPTION WHEN OTHERS
THEN NULL` form trades visibility for safety. Neither is uniformly worse, so "wrap
everything in the atomic form" is the wrong prescription on its own. And the DO form has a
worse case nobody identified: **when a constraint has never successfully existed, atomic
rollback protects nothing, and you get a permanently absent constraint with zero output
forever.** 37 DO-blocks currently swallow every failure to NULL. `RAISE WARNING` plus a
notice listener fixes that at zero boot noise.

**LIVE STATE (verified 2026-08-14):**
- **PROD IS CLEAN.** No repair needed now, but re-check after the deploy that ships any fix.
- **DEV IS REGRESSED RIGHT NOW**: `users_onboarding_status_check` is missing `'suspended'`.
- **`shifts_status_check` has been silently ABSENT from dev forever** (`schema.sql:1861-1864`,
  blocked by three `shifts` rows with `status='confirmed'`) — the DO-form worst case, live,
  and initDb still prints its success line.
- Correcting the earlier "prod was unaffected only by luck": for `archive_reason` prod had
  REAL protection (10 rows carry `option_not_chosen`, so a narrow re-add 23514s and rolls
  back). But for the scheduled-message constraints prod has ZERO rows in the new states and
  therefore NO data protection at all, so those are genuinely narrowed for ~4 to 22 seconds
  of EVERY boot, not only interrupted ones. With `render.yaml:8` `healthCheckPath` giving a
  zero-downtime rollover with the OLD dispatcher still live, that is a real concurrency
  window on every single deploy.

**What the fix needs that nobody has built:** a `CONSTRAINT_CONTRACT` check, because today a
silently absent or narrowed constraint boots clean and nothing notices; and a static linter
over `schema.sql`, because without one any collapse decays back into duplicates. The
verification harness already exists: `testdb-smoke` resets `ci-smoke` from the prod parent
and runs initDb, so a partial-boot regression can be proven rather than argued.

# Push-gate receipt system SHIPPED 2026-08-14 (pushed in 316a43b3) — residuals

The push-hang root cause is FIXED: git push opens its SSH connection before the
pre-push hook runs, and the ~8-minute hook (money smoke went live ~8/11) left it
idle until GitHub closed it. Now `npm run gate` runs the gates once and banks a
receipt keyed on HEAD + the sha256 content of every dirty file, and the hook
skips in under a second when the receipt covers the exact tree and the pushed
sha IS HEAD. First fully self-service push landed 316a43b3 the same day. Five
review rounds (fleet + codex + gemini) broke four drafts before this one; the
history is in the commit messages of 74a95bfd..db6f7b10.

**Known cosmetics, both fail closed, next-batch material:**
- The run-mode summary can print "gate PASSED, skips the hook" right after "no
  receipt was written" when the tree moved mid-run: the summary re-reads the
  STALE receipt from disk and its gates cover `needed`, so the shortfall check
  passes. The hook itself correctly refuses that stale receipt, so this is
  message-only. Fix: compare the banked receipt's fingerprint to fpAfter before
  claiming a pass.
- flock exit-code conflation: a gate that legitimately FAILS with exit 1 also
  prints "another push gate is already running" after its real diagnostic,
  because flock -n uses exit 1 for lock-held. Exit code and blocking behavior
  are right either way. Fix: `flock -n -E 99` and branch on 99.

**Acknowledged non-coverage (documented in push-gate.js, deliberate):**
- `npm run test:smoke` calls testdb-smoke.js directly and takes NO lock, so a
  manual smoke run can still collide with a gate run.
- No file lock can cover a second clone or machine; serializing ci-smoke across
  machines would need a Neon-side lock.
- Gitignored files (.env, client/.env*, ~/.secrets) are outside the receipt
  fingerprint; the 12h expiry is the only backstop.

**Operational reality:** any commit from ANY window during the ~7-minute gate
run moves the fingerprint and the receipt is refused (by design; it happened
twice on 8/14, once from my own edits and once from a spec-doc commit). The
recovery is just rerunning `npm run gate` on the settled tree.

## "N staffed" denominator disagrees between the two shift surfaces (found 2026-08-14, out-of-area walk)

Cosmetic, prod-reachable, low priority. The same shift reads a different
"needed" count on the Event Detail staffing card and in the ShiftDrawer one
click away, whenever `positions_needed` is an empty array:

- `client/src/components/adminos/shifts.js:98` `parsePositionsCount` returns
  `arr.length || 1`, so the card shows **2/1 staffed**.
- `client/src/components/adminos/drawers/ShiftDrawer.js:213`
  `totalNeeded = roster.length`, so the drawer shows **2/0 staffed** (and
  "Assigned 2/0") for that same shift.

Two definitions of the same number, and the `|| 1` is a guess ("assume at least
one is needed") while `roster.length` is literal. Pick one and share it; the
literal reading is probably right, but the card's chip colour logic keys off
"fully staffed", so check that a 0 denominator does not paint every such shift
green before switching.

**Prod reach: 6 shifts of 78** (297, 288, 248, 262, 306, 296), all
`positions_needed = '[]'`, all dated 2026-05-15, all still `status = 'open'`.
Note their six proposals (412, 400, 322, 334, 420, 411) are ALL `completed`, so
these are exactly the rows the in-flight shift-closure sweep is built to close —
worth knowing as concrete first-run fodder for that lane, and it means this
cosmetic bug's only live instances are about to become past/closed anyway.

Found while walking the duty-pay out-of-area knob (walkthroughs-owed Tier 1);
not a defect in the knob itself, which passed clean.
