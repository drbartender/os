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
- **Dashboard / Financials redesign (Money Board)** — BUILD COMPLETE on main 2026-07-09, NOT PUSHED: all 7 lanes merged (a list-filters 8aff846, b1 shell 5560d16, b2 analysis 16a4fed, b3 rainbow chart 345592e, c payroll card f80057c, d payouts focus cbb83dc, e prep queue 6c9ae0b), each per-lane reviewed (3 review FAILs found real bugs, all fixed pre-merge). Suites green on merged main (13+2+6), CI build exit 0, backend boots. Spec/plan: `docs/superpowers/specs/2026-07-09-money-board-design.md`, `docs/superpowers/plans/2026-07-09-money-board.md`. Owed before/at push: Dallas eyeball smoke (both skins + rainbow palette + 390px + chart interactions), manager walk (login manager-test@drbartender.com / manager-smoke-2026 on dev, network tab must show zero /admin/payroll/* calls), then the normal push gate (review sweep runs then).
- **Split-by metrics lane (COMMITTED follow-up, per Dallas 2026-07-09)** — close rate + revenue split by event type and lead source. Queue IMMEDIATELY after the Money Board ships; spec §11 carries the shape. Not wish-list.
- **Bar Program -> POTIONS** — BUILT 2026-07-09 per `docs/superpowers/specs/2026-07-09-potions-bar-program-design.md` + plan `docs/superpowers/plans/2026-07-09-potions-bar-program.md`; PUSHED LIVE 2026-07-09 (ba83407). /potions home (Menu + Recipes + Pars + plans drawer), single par catalog with call-on conditions, 41 draft recipes ready to seed, generator catalog-driven, client mirror killed. Owed: Dallas recipe review pass (6 low-confidence drafts), prod seedRecipeDrafts run (dry-run first). See [[project-bar-program]].
  - **SEED-RUN GATE: CLEARED 2026-07-09** (lane potions-g-gatefixes, merged a0c2a8a; awaiting next push). All 4 second-opinion findings fixed + regression-tested (28/28): (1) mocktails-only serving merges recipes; (2) seed script post-write parity validates LIVE rows + drift report; (3) Peychaud's normalized aliases (script + dev row); (4) matching-mixers pulls from the new pairableItems slice (all active mixer/garnish rows). Prod seed run is un-gated once this push ships.
- **Compare-page reskin** — `docs/compare-page-design-prompt.md`, sitting since 7/2; can ride either session above.

## Scope calls needed before scoping
- **Classes / field guide** — restyle existing (`ClassWizard.js` booking wizard + `FieldGuide.js` staff doc; redesign brief already covers restyles) OR new marketing/content pages? Unresolved.
- **Staff payment system** — quiet for weeks; superseded by the shipped paystub/payroll work, or still queued (minimal-first, absorbs multi-bartender tipping)?

## Known bugs (prod-confirmed, unbuilt)
- **A refund on a paid proposal leaves the entire booking live.** Found 2026-07-09 on proposal 500 (Shruti Parekh: refunded 7/1, still sitting on the Events board 8 days later with 11 pending client reminders queued). `issueRefund` (`server/utils/refundHelpers.js`) reverses the payment, reverses the linked invoice(s), and downgrades `proposals.status` back to `accepted` (`refundHelpers.js:282-283`). It touches nothing else: that file has zero references to `shifts` or `scheduled_messages`. So a fully-refunded booking keeps (1) its auto-created shift at `status='open'`, visible on the Events board *and* in the staff open-shifts feed, where a bartender can and did apply to work a cancelled event; (2) its balance invoice at `status='sent'`, still dunnable; (3) its whole pending `scheduled_messages` ladder. The dispatcher's `checkSuppression` gates only on `proposal.status === 'archived'` (`scheduledMessageDispatcher.js:140`), and `accepted` is not `archived`, so balance reminders (which recompute `total_price - amount_paid > 0`), drink-plan nudges, event-week and event-eve reminders all keep firing at the refunded client.
  - Compounding it: `POST /proposals/:id/archive` (`actions.js:397`) voids invoices and suppresses messages but **never touches shifts**; and neither the admin Events feed (`shifts.js:40`) nor `EventsDashboard.js` filters on `shifts.status` or `proposals.status`. So archiving the proposal does not remove the row, and soft-cancelling the shift does not either. Only a hard `DELETE FROM shifts` does.
  - Manual cleanup performed for 500: archive via the UI (Dallas) + `DELETE FROM shifts WHERE id=337` (cascaded one pending `shift_requests` row; no `payout_events`, so no payroll exposure). The staffer who had applied was never notified, since no code path does that.
  - Fix directions, unscoped: reap on refund-to-zero (shift + invoice + scheduled_messages together), or widen `checkSuppression` past its archived-only gate; teach the archive endpoint to reap shifts; filter cancelled shifts and archived proposals out of the Events feed. Same family as the open seam-sweep `record-payment status-downgrade` item.
- **`archive_reason` is never written by the archive endpoint.** `actions.js:397` sets `status='archived'` and leaves the column NULL. The CHECK constraint allows `no_hire`, `client_cancelled`, `we_cancelled`, `event_completed`, `other`, `option_not_chosen`, but only `option_not_chosen` has a live writer (`proposalGroupCommit.js`). Every manually archived proposal therefore shows no reason in the archive bucket. Small: wants a reason picker on the archive action.

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

## Small deferred / tech-debt
- **crud.js `/:id/legacy-cc-payments`** — now clientless (CC demolition deleted its only consumer); dead endpoint in sensitive `proposals/`, remove in a later proposals-touching lane.
- Refunds-on-invoice: a payment split across multiple invoices shows the FULL refund on each (rare, informational). Apportion if it bites.
- Payment accounting: non-flat add-on comp residual (brief owed).
- Audit leftover: manager iCal in `calendar.js` (last open audit item).
- Tech debt: `notifications_opt_in` dead column DROP (4 test fixtures still INSERT it); `.form-select` focus padding-right; no-tip-jar badge redness vs last-minute badge; `.staffing-stat strong` ink emphasis.
- Empty v1 tables (`legacy_cc_raw_imports`, `cc_import_runs`, `cc_import_phase0_failures`) stay as harmless scaffolding; dev DB still carries 1,215 v1 clients + 176 v1 proposals (guard-blocked from ledger load; scrub = housekeeping).
