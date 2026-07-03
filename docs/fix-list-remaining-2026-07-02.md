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
Other windows own it. Post-merge findings F1/F2/F3 are recorded on main (`8efc44c` docs commit) and must be fixed before the compare UI goes live.

---

## Parked bigs (ready when Dallas says go)

### cc-import rework (v2) — Large, the biggest debt
A complete v2 design already exists: `docs/superpowers/specs/2026-05-30-cc-importer-v2-design.md`, cataloguing 9 production defects from v1 (wrong event totals, guest counts defaulted to 50, ~27% orphan payments, imported staff invisible, packages not linked, exact-match staff assignment misses, import fired real client comms, unreliable addresses, non-corrective re-runs).
Research map:
- Importer CLI: `scripts/cc-import.js` + `scripts/cc-import/phases/phase0..6.js` (0 attachments->R2, 1 staff, 2 clients, 3 proposals, 4 payments/refunds, 5 payouts archive, 6 leads/invoices raw). One-time operator run, no scheduler wiring.
- Admin recon UI: `server/routes/admin/ccImport/*` + `CcImportReviewPage`/`CcImportWrapUpPage` + `LegacyCcPaymentsPanel`/`CcImportBadge`.
- v2 keeps the schema and review pages; overhauls phase 1/3/4 parsing, adds `package_id` resolution, AI address normalization, dry-run-on-prod-copy safety, idempotent corrective re-runs.
- Open product questions: is the v2 spec still the direction; clean re-import over the botched v1 data vs forward-only correction; which CSV snapshot is canonical.

### Shopping list: custom request cocktails — Large as specced, Small with the reframe
Two-layer gap found in research:
1. The planner auto-gen path IGNORES `selections.customCocktails` entirely (`buildPlannerGeneratorInput` in `server/utils/shoppingListGen.js` only resolves structured `signatureDrinks`), while the consult path DOES fold customs in (`buildGeneratorInputFromConsult`, `shoppingList.js:449-473`). Inconsistent by source. Fixing layer 1 alone is a quick feed-through.
2. Even when fed in, free-text ingredients mostly do not map: `mergeSignatureIngredients` keys off an ~18-entry hardcoded `INGREDIENT_MAP` (`shoppingList.js:116-136`); "elderflower liqueur" or "aperol" contribute nothing. Real accuracy needs a structured ingredient/unit catalog. This is the "needs a lot of work" part.
- THE REFRAME on the table: surface custom cocktails as an un-costed "client requested X, bar lead to source" checklist section instead of computed quantities. Drops the project from Large to Small. Decide this before scoping.
- Cross-cutting law: the generator is deliberately duplicated client (`generateShoppingList.js`) and server (`shoppingList.js`); every change lands in both.

### Budget from Thumbtack feed (discount warning) — Medium, GATED on a 5-minute check
- BLOCKING UNKNOWN: `parseLead` (`server/routes/thumbtack.js:122-176`) does not extract any budget field, and research could not confirm TT sends one. It would arrive in the `request.details` {question, answer} array (same place guest count comes from) and is preserved in `thumbtack_leads.raw_payload`. FIRST STEP: query prod `raw_payload` for budget-like Q&A. If absent, the project dies.
- If present: parse step + column, normalization (budget is likely a range/string), and an admin warning on the drafted proposal comparing computed `total_price` vs budget ("offer a discount or trim scope"). Surface = the drafted ProposalDetail/pricing screen (there is no dedicated TT lead view; leads auto-draft).
- Intent (Dallas): win jobs; discounting a random Thursday-afternoon or 1-hour corporate happy hour is fine.

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
