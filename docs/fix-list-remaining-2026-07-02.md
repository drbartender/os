# Fix List: What's Left (refreshed 2026-07-07)

The 2026-07-01 brain dump is fully processed and shipped. As of 2026-07-07 the
tree is clean and everything below the line is either LIVE, a design session
Dallas drives, a scope call, or an operational tail. Re-verify line numbers
before building anything.

## Shipped & LIVE (was the backlog, now done)
- **cc-import rework — ALL 3 PHASES LIVE 2026-07-07.** Phase 1: 187 CheckCherry clients. Phase 2: frozen CC-era ledger (P&L penny-tie) + v1 demolition (13.5K lines) + blended dashboard/financials metrics (include_cc tri-state, close rate). Phase 3: 13 future events transferred to native confirmed proposals (money override-locked, external_paid folded, durable nudge suppression, comms-guarded). Post-transfer fix: 3 events' rosters (Cody/Shazana/Cecilia) had a spurious additional-bartender add-on stripped -> 2 bartenders each. See [[project-cc-clients-import]].
- **Admin cross-navigation — LIVE 2026-07-07.** 6 lanes: clickable EntityLink entity refs + useUrlListState URL view-state across proposals/clients/events/staffing/comms/money surfaces. Shared primitives (EntityLink, useUrlListState, ScrollToTop, useDrawerParam).
- **Stripe payout tracking — LIVE** (settlement mirror, payout.* webhooks, unmatched bucket).
- **Proposal-options compare — LIVE**; legacy stragglers 469 + 475 archived.
- **Thumbtack budget warning — LIVE** (over-budget badge draft/sent + payment-panel stated-budget line).

---

## Design sessions Dallas drives (prompt docs committed, none started)
- **Dashboard / Financials redesign** — `docs/dashboard-financials-design-prompt.md`. The timely one: the full CC+native ledger is now live behind these pages and Dallas doesn't use them today ("they both need work"). Contracts in the doc are LAW; build spec after the design lands.
- **Bar Program** (cocktail-menu -> Recipes + Pars tabs) — `docs/cocktail-menu-design-prompt.md`. `cocktails.ingredients` JSONB exists, 0/24 populated; pars hardcoded `shoppingList.js:75-141` + client mirror. No movement since the doc landed. See [[project-bar-program]].
- **Compare-page reskin** — `docs/compare-page-design-prompt.md`, sitting since 7/2; can ride either session above.

## Scope calls needed before scoping
- **Classes / field guide** — restyle existing (`ClassWizard.js` booking wizard + `FieldGuide.js` staff doc; redesign brief already covers restyles) OR new marketing/content pages? Unresolved.
- **Staff payment system** — quiet for weeks; superseded by the shipped paystub/payroll work, or still queued (minimal-first, absorbs multi-bartender tipping)?

## Specced, deliberately parked
- **Drink-plan edit lock (Option A)** — decouple the lock from submit (currently `status IN ('submitted','reviewed')` in `drinkPlans/submit.js`), tie to `shopping_list_status`, add an admin "reopen for client" control. Option B (autosave tracking) already exists. Medium; event-side-canonical drink-plan territory.

## Dallas-owned / skipped by his call
- **Intro message: remove phone, add cal.com link** — candidates: `smsInbound.js:15` HUMAN_CONTACT_LINE + client `COMPANY_PHONE` (`constants.js`). `CAL_BOOKING_URL` already wired.
- **Syrup picker** — suspected bug: generators never cross-check `syrupSelfProvided` vs comped/paid `proposalSyrups` (`addSelfProvidedSyrups`, both mirrored generators). Re-diagnose fresh; pay-now-extras comp-fold touched this territory.

---

## Operational tails (not builds)
- **Zul VA calling go-live — IN PROGRESS 2026-07-07.** Code + all 3 prod tables (pending_call/call_audit/telegram_update) LIVE; webhook helpers ready. Remaining = console bring-up + Zul validation, runbook `docs/va-calling-runbook.md`:
  1. @BotFather `/newbot` -> `TELEGRAM_BOT_TOKEN`.
  2. Render env (first deploy, allowlist UNSET): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (fresh one generated this session), `VOICE_CALLER_ID=+12242220082`, `VA_CELL=<Zul +63 cell>`. Deploy.
  3. Twilio console: confirm PH geo (low on/high off, already verified) + auto-refill/spend alert; point 224 "A call comes in" -> POST `<API_URL>/api/voice/inbound`.
  4. Claude registers the webhook (setTelegramWebhook) + verifies once step 2 is deployed.
  5. Zul Start+message -> bot replies her id; set `TELEGRAM_ALLOWED_USER_ID` in Render, redeploy.
  6. Validation tests 1-3 (audio to Zul cell / Telegram round-trip / inbound forward).
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
