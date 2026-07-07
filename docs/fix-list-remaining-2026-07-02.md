# Fix List: What's Left (2026-07-02)

The 2026-07-01 fix-list brain dump is fully processed: 15 items shipped end to end (chunk of quick fixes, resends + the nudge dead-link discovery, refunds under invoices, document preview modal, no-tip-jar prominence, TT lead spend, portal invite, client shopping-list PDF, After Hours token remap). This doc is everything that remains, with the research findings baked in so the next session starts warm. Research citations were verified 2026-07-01/02; re-verify line numbers before building.

---

## In flight (other windows, do not double-build)

### Stripe payout tracking
Spec + plan are on main (`docs/superpowers/specs/2026-07-01-stripe-payout-tracking-design.md`, plan alongside); the `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER` env row already landed in CLAUDE.md. Build resumes once proposal-options clears `stripeWebhook.js` (sensitive path, mid-flight).
Research that shaped it:
- NAMING TRAP: "payout" in this codebase means STAFF PAYROLL (`payouts`/`payout_events` tables, PayoutsTab etc.). The new subsystem needs its own vocabulary everywhere.
- Nothing pre-existed: no `payout.*` webhook handlers, no Stripe payouts/balance API calls, no settlement table; Financials read only proposals + proposal_payments.
- Reconciliation spine: payout -> balance transactions -> charge -> `charge.payment_intent` -> `proposal_payments.stripe_payment_intent_id` -> proposal/event, and invoices via `invoice_payments.payment_id`.
- Facts: payouts are net of fees (surface gross/fee/net; the gratuity fee-netting framing is ACCEPTED, never relitigate); refunds and disputes are negative lines; unmatched transactions need a bucket, not a silent drop; CheckCherry-era charges live in a different Stripe account (out of scope); read-side only per protect-working-paths.

### Proposal-options compare
DONE and fully live (2026-07-02): all 7 lanes shipped, findings F1/F2/F3 all FIXED (F1/F2 conflict-guards `b3f9c88`, F3 refund-display clamp `5e9c9d3`), plus archive-controls (first-payment same-client sweep of ungrouped alternatives + admin Archive button with one-vs-set popup + lock-hierarchy fix `0a907f4`). Remaining on this feature: money-seam smoke at the first real grouped booking; compare-page reskin (prompt doc: `docs/compare-page-design-prompt.md`); Dallas archives legacy stragglers 469 + 475 via the new button.

---

## Parked bigs (ready when Dallas says go)

### cc-import rework — v2 spec RETIRED 2026-07-06; rebooted lean, phase 1 (clients) MERGED
Dallas's call: v1 gave him anxiety, so no sprawling re-import. Fresh FINAL CheckCherry exports (2026-07-06, archived `~/cc-archive/2026-07-06/` + Windows share root; books tie out to the penny vs the all-time P&L), smaller safer bits, clients first. The v2 spec (`2026-05-30-cc-importer-v2-design.md`) is history, not direction.
Ground truth discovered: prod was VERIFIED CLEAN of v1 data (all `legacy_cc_*` tables empty; the prelaunch scrub got it) — the old "purge/corrective re-run" framing was moot. Dev still carries 1,215 v1-imported contacts (future housekeeping, harmless).
- **Phase 1 MERGED to main (6406d44, not yet pushed):** `scripts/cc-clients-import.js` imports 187 real clients (paid or confirmed-event only, of 1,175 contacts), name/email/phone + neutral history digest in notes (no CC branding, per Dallas), `source='checkcherry'` + `cc_id` idempotency; 3 returning clients merge fill-blanks-only. Rehearsed --apply on a Neon branch of prod (184 insert / 3 merge / 0 skip). Runbook: `docs/superpowers/plans/2026-07-06-cc-clients-import.md` — deploy FIRST (constraint rides initDb), dry-run, then --apply on Dallas's go.
- **URGENT tail:** 14 future confirmed CC events (~$11.4K in balances; 2 due mid-July) exist ONLY in CheckCherry, and Dallas cancels CC within ~a month. He enters them manually in DRB once clients are in prod (balances reflect CC-collected deposits WITHOUT native payment rows — never re-key CC payments or blended financials double-count). Contracts bulk-download before cancellation still owed; per-year P&L exports (2024/2025/2026) recommended while access lasts.
- **Phase 2 MERGED to main 2026-07-07 (3 lanes, not yet pushed):** cc-ledger (56308f8: loader fills the ledger from the exports, P&L penny-tie gates + double-count guard, applied on dev), cc-demolition (f39de17: 13,549 lines of v1 importer/UI deleted incl. the CC badge that phase 1 accidentally lit up on 187 prod clients; proposalActions.js kept, it serves LIVE endpoints), cc-metrics (61dea20: include_cc tri-state = all/native-only/CC-era-only, additive ledger legs on money + funnel metrics, close rate finally has its CC denominator). Post-push: run scripts/cc-ledger-import.js against prod (dry-run, Dallas's go, --replace --apply, verify frozen numbers).
- **Next design session (Dallas runs):** dashboard/financials redesign prompt doc, written AFTER the prod load so it enumerates every metric the ledger supports. Dallas: "I haven't really used the dashboard or the financial pages at all. They both need work."
- Deferred cleanup: crud.js /:id/legacy-cc-payments is now clientless (dead endpoint, sensitive path, remove in a later proposals-touching lane); empty v1 tables (legacy_cc_raw_imports, cc_import_runs, cc_import_phase0_failures) stay as scaffolding; dev DB still carries 1,215 v1 clients + 176 v1 proposals (blocked from ledger-loading by the guard, scrub = housekeeping).

### Shopping list / Bar Program — IN FLIGHT 2026-07-02, design-first
RESHAPED after Dallas diagnosis (pars wrong so items get removed; quantities right; sig ingredients missing; "drinks all need recipes"): the project is now the cocktail-menu screen becoming the Bar Program surface — Menu (exists) + Recipes tab (structured rows; `cocktails.ingredients` JSONB exists, 0/24 populated on prod) + Pars tab (editable, replacing hardcoded `PARS_100`/`SPIRIT_PARS` in shoppingList.js:75-141 + client mirror). Design session FIRST per Dallas ("the tool decides what a surface should be"): prompt doc `docs/cocktail-menu-design-prompt.md` committed, Dallas runs it at claude.ai/design; build spec (endpoints, generator consumption, 24 seeded draft recipes, custom-cocktail fallback) comes after the design lands. Original notes below still describe the generator internals.

### (superseded notes) Shopping list: custom request cocktails — Large as specced, Small with the reframe
Two-layer gap found in research:
1. The planner auto-gen path IGNORES `selections.customCocktails` entirely (`buildPlannerGeneratorInput` in `server/utils/shoppingListGen.js` only resolves structured `signatureDrinks`), while the consult path DOES fold customs in (`buildGeneratorInputFromConsult`, `shoppingList.js:449-473`). Inconsistent by source. Fixing layer 1 alone is a quick feed-through.
2. Even when fed in, free-text ingredients mostly do not map: `mergeSignatureIngredients` keys off an ~18-entry hardcoded `INGREDIENT_MAP` (`shoppingList.js:116-136`); "elderflower liqueur" or "aperol" contribute nothing. Real accuracy needs a structured ingredient/unit catalog. This is the "needs a lot of work" part.
- THE REFRAME on the table: surface custom cocktails as an un-costed "client requested X, bar lead to source" checklist section instead of computed quantities. Drops the project from Large to Small. Decide this before scoping.
- Cross-cutting law: the generator is deliberately duplicated client (`generateShoppingList.js`) and server (`shoppingList.js`); every change lands in both.

### Budget from Thumbtack feed (discount warning) — DONE, merged to main 2026-07-02 (a4efe12, not yet pushed)
- The 5-minute gate PASSED: budget Q&A exists on 191/194 prod leads at `raw_payload -> data -> request -> details` (multi-select ranges + "I'm not sure" ~20%). Built same day: `extractBudget` at webhook time -> `thumbtack_leads.budget_min/budget_max/budget_raw` (whole dollars, forward-only, NO backfill by Dallas's call), lateral join on GET /proposals/:id, red over-budget badge on ProposalDetail (draft/sent only) + "Stated budget" payment-panel line. Full fleet 5x PASS. Spec/plan: `docs/superpowers/specs/2026-07-02-tt-budget-warning-design.md`.
- Side effects: GET /:id extracted to `server/routes/proposals/getOne.js` (crud.js hit the 1000-line ratchet); `idx_thumbtack_leads_proposal_id` added (also serves /lead-cost).
- Owed: Dallas eyeball smoke (staged: dev lead `smoke-budget-eyeball` -> proposal 8146; delete the scratch row after).

### Classes pages / field guide design — "way later," scope ambiguity unresolved
- `/classes` today is `ClassWizard.js`, a 4-step BOOKING wizard (packages with `bar_type='class'`), not a marketing page; the primary nav does not even link to it. Content source `dr-bartender-class-menu.md` sits at repo root.
- `FieldGuide.js` is the staff-onboarding long-form doc (hiring flow step), not public marketing.
- The redesign brief already specs restyles for both (`DR_BARTENDER_REDESIGN_BRIEF.md` ~:318 ClassWizard "same treatment as QuoteWizard"; ~:367 FieldGuide parchment cards + brass anchors).
- UNRESOLVED: does Dallas mean restyle-existing (Medium, brief already covers it) or NEW marketing/content pages (Large)? Ask before scoping. Runs through the redesign's per-surface prompt-doc model regardless.

---

## Medium items deliberately not started

### Drink-plan edit lock (Option A)
Original ask: client can edit until the shopping list is generated, then admin can re-enable. Research: the current lock is tied to SUBMIT (`status IN ('submitted','reviewed')` hard-rejects in `drinkPlans/submit.js`), not to list generation, and the list auto-generates ON submit, so the two are conflated. Option B (autosave so admin can track progress) turned out to already exist (`PotionPlanningLab` saves every change + 30s interval; admin reads live selections). Option A means decoupling the lock from submit, tying it to `shopping_list_status`, an admin "reopen for client" control, and re-plumbing the planner's post-submit lock handling. Medium; touches the event-side-canonical drink-plan rules.

### Staff payment system — status unclear, confirm before anything
Memory says it was "the active next project" (worktree staff-payments, minimal-first, absorbs multi-bartender tipping) but it has been quiet for weeks. Confirm with Dallas whether superseded (the paystub pipeline + payroll work shipped since) or still queued.

---

## Dallas-owned / skipped by his call
- **Intro message: remove phone, add cal.com link** — HIS: sharing the real number defeats Thumbtack's proxy-number protections. `CAL_BOOKING_URL` env already wired for other touches; the SMS templates carry no phone; candidates are the smsInbound HUMAN_CONTACT_LINE (`server/utils/smsInbound.js:15`) and client-side `COMPANY_PHONE` (`client/src/utils/constants.js`).
- **Syrup picker** — skipped "for now." Research for when it returns: two distinct syrup UIs (`SyrupPicker.js` admin/quote-side; `MakeItYoursPanel.js` planner-side with the drb/self radio writing `syrupSelfProvided`). The suspected bug: the generators never cross-check `syrupSelfProvided` against comped/paid `proposalSyrups`, so a flavor toggled to self then comped by admin still ships on the client list (`addSelfProvidedSyrups`, both mirrored generators). Some of this territory was touched by the pay-now-extras comp syrup-fold fix; re-diagnose fresh.
- **Edit button in proposal list rows** — skipped; edit exists on the detail page (`?edit=1` deep-link works from the Events kebab).

---

## Operational loose ends (not builds)
- **Zul VA calling go-live** — merged and deployed but NOT live until the Task 9 runbook runs: Telegram bot config, Render env, setWebhook, point the 224 voice line, audio validation call, apply the 3 tables to prod Neon. Runbook: `docs/va-calling-runbook.md`.
- **Verification tails owed to Dallas's eyeball**: (1) After Hours both-skin sweep in the running app (event page, a dashboard, blog-editor form fields, primary-button hover) — machine probes proved the token flip and House Lights invariance; polish is human. (2) Document preview modal: open a real W-9 PDF and a headshot in both skins (PDF-in-iframe is browser-proven only live).
- **Resend Pro upgrade** — free 100/day cap was being hit; scheduled sends degrade gracefully; Dallas upgrading later.

## Small deferred follow-ups (from this week's lanes, all noted in reviews)
- Refunds-on-invoice: a payment split across multiple invoices shows the FULL refund on each (rare, same client, informational only). Apportion if it ever bites.
- Payment accounting: one deferred MEDIUM, the non-flat add-on comp residual (a brief is owed).
- Audit leftover F3: manager iCal in calendar.js (low-urgency UX, the only open audit item).
- Tech debt: `notifications_opt_in` dead column awaits its DROP (4 test fixtures still INSERT it); `.form-select` focus padding-right collapse (pre-existing, noted in the After Hours review); no-tip-jar admin badge could read redder than the last-minute badge (2-line CSS if wanted); `.staffing-stat strong` emphasis could bump ink-3 -> ink-2 if it reads flat.

## Merged, awaiting the next push (as of this writing)
TT lead spend (3dc0625), portal invite (b08633e), client shopping-list PDF (2d75a6e), After Hours token remap (f2d3e53), plus whatever the parallel windows have merged since. Push = deploy; Dallas calls it.
