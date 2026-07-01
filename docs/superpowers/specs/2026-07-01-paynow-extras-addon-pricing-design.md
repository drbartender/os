# Pay-Now Drink-Plan Extras: Price Non-Flat Add-Ons at Their Real Rate

**Date:** 2026-07-01
**Status:** Design approved via brainstorm dialogue; revised 2026-07-01 to fold in the spec-review fleet (grounding / gaps / risk — no hard blockers from grounding/risk, 4 call-site issues from gaps, all resolved below). Pending lane plan.

Follow-up to the deferred **Medium** from the payment-accounting-fixes Lane B push review (2026-07-01, commit 3e7a6be). Standalone correctness fix to how the "pay now" drink-plan extras flow prices add-ons; independent of, but rooted in, the code Lane B touched.

---

## Problem

The pay-now extras path prices every **non-`per_guest`** add-on at its **flat rate**, while the proposal engine prices `per_staff` / `per_hour` / `per_100_guests` / `per_guest_timed` add-ons at their **real, scaled rate**.

- Flat-pricing sites (two independent copies of the same math): `computeExtrasBreakdown` (`server/utils/drinkPlanExtras.js:49-54`) and `writeExtrasLineItems` (`server/utils/invoiceHelpers.js:586-588`) both do `if (billing_type === 'per_guest') rate * guests; else rate`.
- Fold: `calculateProposal` → `calculateAddonCost` (`server/utils/pricingEngine.js:131`) prices `per_staff` as `totalStaff * rate` (`totalStaff` = staffing.actual + additional-bartender + barbacks/servers, `:311`), `per_hour` as `effectiveHours * rate`, `per_100_guests` as `ceil(guests/100) * rate`, `per_guest_timed` as `(guests*rate + extraHours*guests*extra_hour_rate)`; `additional-bartender` uses a **special gratuity block** (`:328`), never `calculateAddonCost`.

### Consequences

1. The pay-now charge **under-bills** these add-ons; `total_price` (from `calculateProposal`) gets the real fold, so the difference silently lands on the Balance.
2. **Comp under-reverses `total_price`** (the deferred Medium): the extras invoice (flat) ≠ the folded amount (real), leaving a residual (client over-stated ~$20–40; **not DRB money lost**).
3. **Reachable set (verified against `client/src/pages/plan/**`):** the drink planner exposes only `parking-fee` (`per_staff`, auto-toggled by `LogisticsStep`), cocktail-triggered `per_100`/`per_guest_timed` upgrades (garnish, mocktail), champagne (`per_guest`), and bar rental. Staffing add-ons (`additional-bartender`/`barback`/`banquet-server`) are **NOT** drink-plan-selectable — they reach the extras path only via a hand-crafted API payload (`submit.js:184` honors user-added slugs).

**Root:** the original create-intent (~772c337) only special-cased `per_guest`, treating all else as flat. Lane B preserved that math byte-for-byte, so this predates Lane B.

## Goal

For the **drink-plan-reachable** add-on set, the pay-now **charge**, the "Drink Plan Extras" invoice **`amount_due` + line items**, and the **`total_price` fold** agree for every billing type, so clients are charged the real rate pay-now and comp reverses with no residual.

## Non-Goals

- No change to syrup or bar-rental pricing (already correct).
- No change to `calculateProposal` / `calculateAddonCost` — the engine is the source of truth, not the thing changed.
- No schema change, no data migration. Historical flat-priced extras invoices stay as-is; the one live abandoned case (Shiralee, 527) is syrup-only and unaffected.
- The `additional-bartender` + client-gratuity interaction (Warning below) is **out of scope** because staffing add-ons are not drink-plan-selectable.

## Design — reuse the engine via a with-vs-without delta, on a TARGETED path

Re-deriving add-on prices in the extras helper would replicate `calculateProposal`'s staffing / additional-bartender-gratuity / hosted-package logic (CLAUDE.md flags the hosted-bartender rule as load-bearing, "re-lost multiple times"). Instead, treat `calculateProposal` as the single source of truth and compute the add-on portion as the **delta it produces** — but only where needed.

### Core

- **The engine-delta runs ONLY when the selection contains ≥1 new non-`{per_guest,flat}` add-on.** For everything else — syrup-only, `per_guest`/`flat` add-ons, bar rental — `computeExtrasBreakdown` keeps its existing (correct) math and **never calls `calculateProposal`**. This is essential: `calculateBaseCost` throws on a null/0 `pkg`/`duration`/`guest_count` (`pricingEngine.js:61-64`), and the syrup-only fast path (the common pay-now case) runs on proposals that may lack those. Guard exactly like submit's own fold guard (`if (pkg && guest_count && event_duration_hours)`, `submit.js:248`): if a non-flat add-on is present but the context is degenerate, fall back to flat and log — never 500 a drink-plan payment.
- **Add-on portion of the extras = `addonSum(existing ∪ new) − addonSum(existing)`**, where `addonSum(x)` = `sum(calculateProposal({...proposal, addons:x}).addons[].line_total)` (note: the engine returns `.addons`, not `.addonResults`, and exposes no `.addonTotal` field — sum the line totals; consider adding an `addonTotal` to the engine's return to avoid the ad-hoc sum). Both runs use identical pkg/guest/duration/num_bartenders context. This captures real rate, `per_staff` scaling on the correct `totalStaff`, and the additional-bartender path, with zero replication.
- **"new" = the UPSERT-FILTERED set, captured PRE-UPSERT.** The set that actually folds into `total_price` is `rawAddonSlugs` minus package-covered slugs minus invalid-autoAdded slugs (`submit.js:173-185`). The delta MUST use that filtered set, or a package-covered slug gets charged while the fold excludes it → charge ≠ fold and the residual returns. And it must be captured **before** the `proposal_addons` UPSERT (`submit.js:213`) — a variable `existingAddonsAtIntent` alongside the existing `numBarsAtIntent` (`submit.js:152`) — because the natural call site (`submit.js:329`) is *after* the UPSERT, where re-reading `proposal_addons` would make `existing == existing ∪ new` and collapse the delta to $0.
- Bar rental and syrups stay as they are. `totalCents = round((addonDelta + barRental + syrup) * 100)` — rounded sum, integer cents, equals the Stripe charge.
- **The delta is on `addonSum` only** (excludes `staffing.cost` and the client-gratuity line). That is correct: drink-plan extras add bartenders via the `additional-bartender` **add-on** (inside `addons`), never via the `num_bartenders` override — so the override path stays correctly untouched. It also means the charge = `addonDelta+bar+syrup` while the fold's `total_price` increment = that same sum **plus** any gratuity increment (≥0). **The charge is therefore always ≤ the fold — this change can never over-charge vs the proposal.**

### Why the delta, not direct `calculateAddonCost`

The reachable non-flat add-ons don't currently interact (nothing plan-toggleable changes another's staff/guest/duration basis), so direct per-add-on `calculateAddonCost` would also work today. The delta is chosen because it inherits `totalStaff`, the additional-bartender gratuity block, and the hosted-package rule from the one tested engine without re-deriving them — robust if a staffing add-on ever becomes plan-selectable, and the grounding + risk reviews confirmed it is sound and cannot over-charge.

### Interfaces

- **`computeExtrasBreakdown`** gains the context to run the engine when needed: `pkg` (full `service_packages` row), `guestCount`, `durationHours`, `numBars`, `numBartenders`, the **pre-UPSERT** existing `proposal_addons`, and the **filtered** new add-on set — plus the syrup/bar inputs it has today. Returns `{ totalCents, barRentalCents, syrupCents, addonDeltaCents, addonLineItems }`. `addonLineItems` are the new add-ons' `calculateProposal(...).addons` entries mapped to invoice lines that **preserve `source_type:'addon'` + `source_id`** (see comp dependency below).
- **create-intent (`server/routes/stripe.js`)** must expand its SELECT to match submit: it currently loads only `guest_count, num_bars, pricing_snapshot` (`stripe.js:45-55`) and must add the full `service_packages` row, `event_duration_hours`, `num_bartenders`, and the `proposal_addons` join, AND apply the same coverage/trigger filter submit uses — otherwise the create-intent charge diverges from the submit invoice. (`gratuity_rate`/`tip_jar` are inert for the delta and need not be added.)
- **submit (`server/routes/drinkPlans/submit.js`)**: capture `existingAddonsAtIntent` (+ the already-captured `numBarsAtIntent`) before the UPSERT; the transaction path (`:329`) already has pkg/duration/num_bartenders in scope; the syrup-only fast path (`:469`, thin SELECT) has no new non-flat add-on, so the guard skips the engine entirely — no new context needed there.
- **`writeExtrasLineItems`** itemizes add-on lines from `addonLineItems` **when provided** (preserving `source_type:'addon'`). When **absent** — the two post-commit callers `createDrinkPlanExtrasInvoice` at `stripeWebhook.js:295` (out-of-order webhook) and `backfillExtrasInvoices.js:121` — it MUST degrade gracefully: keep the current DB-read flat itemize (or emit a single fee line), with the drift-reconcile keeping the lines summing to `amount_due`. `amount_due` is correct in both (it flows from `intent.metadata.extras_amount_cents`, the real-rate charge). Do NOT remove the flat fallback — an unguarded `addonLineItems.map` there would throw and 500 the webhook. (Webhook-before-submit means the DB has no new add-ons yet, so a single lumped fee line is the honest representation.)
- **Comp (B4) is unchanged in code**, but depends on the new itemization keeping `source_type:'addon'`: `voidExtrasInvoiceWithReconcile` gates the total_price reversal on `source_type === 'addon' || description IN ('Portable Bar Rental','Additional Portable Bar')` (`invoiceHelpers.js:888-891`). If the real-rate add-on lines lose `source_type:'addon'`, `hasAddonOrBar` goes false → comp subtracts $0 → **the exact residual this spec fixes silently returns.** Make preserving `source_type:'addon'` an explicit requirement.

### Data flow

```
create-intent / submit (with a new non-{per_guest,flat} add-on, valid pkg/guest/duration):
  existingFiltered = pre-UPSERT proposal_addons (coverage/trigger-filtered)
  newFiltered      = existingFiltered ∪ the new filtered slugs
  addonDelta = Σ calculateProposal({...ctx, addons:newFiltered}).addons[].line_total
             − Σ calculateProposal({...ctx, addons:existingFiltered}).addons[].line_total
  addonLineItems = calculateProposal({...ctx, addons:newFiltered}).addons ∩ new slugs  (source_type:'addon', source_id)
  totalCents = round((addonDelta + barRental + syrup) * 100)
otherwise (syrup-only / per_guest / flat / degenerate): existing flat/per_guest/syrup/bar math, no engine call.
```

## Edge cases

| Situation | Outcome |
|---|---|
| Syrup-only / per_guest / flat add-on / bar-only | existing math, **no engine call** — no throw, byte-identical to today |
| Non-flat add-on but null pkg / guest / duration | guard falls back to flat + logs; never 500s |
| New `per_staff` (parking) alone | `totalStaff` identical in both runs (nothing plan-toggleable adds staff) → `addonDelta = totalStaff × rate` = the fold increment exactly → comp restores to the cent |
| Slug already on the proposal, or package-covered / invalid-autoAdded | filtered out of "new" → not charged → charge == fold |
| Webhook / backfill create (no `addonLineItems`) | graceful flat/lumped itemize; `amount_due` correct from PI metadata |
| `additional-bartender` via hand-crafted payload | out of scope: its gratuity increment folds into total_price but not the extras → residual; not reachable in the drink-plan UI |
| Comp of a reachable non-flat extra | `source_type:'addon'` preserved → full-invoice reversal → `total_price` fully restored |

## Backwards-compat

- Historical flat-priced extras invoices: untouched.
- **In-flight create-intents across the deploy boundary:** a PaymentIntent created pre-deploy carries the old flat `extras_amount_cents`; if the client confirms after deploy, the webhook settles the invoice at the flat amount while a post-deploy submit would build it at the real rate. This mid-checkout window is small (a client actively paying at deploy time) and self-limiting; accept it, or gate the deploy off-peak. No data fix needed.

## Client parity

`LogisticsStep.js:41` previews parking as `rate × (numBartenders || 1)`, but the server (new) charges `per_staff` at `totalStaff`. Per CLAUDE.md's cross-cutting-consistency rule, reconcile the preview to `totalStaff` (bartenders + additional-bartender + barbacks/servers) so the client isn't shown a smaller number than they're charged. Small client-only change; include it in the lane.

## Testing

- **Unit (`drinkPlanExtras.test.js`):** the extras add-on delta for the reachable set — `per_staff` (parking), `per_100_guests` (garnish), `per_guest_timed` (mocktail), plus regression for `per_guest`/`flat`/syrup/bar — each asserted against a direct `calculateProposal` delta (not a magic number). Return-shape rename (`addonCents`→`addonDeltaCents`, add `addonLineItems`) touches only these tests (no prod reader of the component fields).
- **Throw guard:** a syrup-only submit and a non-flat add-on on a package-less/duration-null proposal both succeed (no engine 500).
- **Ordering:** a `parking-fee` pay-now submit charges/invoices `totalStaff × $20` and `amount_due == create-intent charge`, proving the pre-UPSERT capture (a post-UPSERT read would assert $0).
- **Consumer degradation:** a webhook/backfill `createDrinkPlanExtrasInvoice` with no `addonLineItems` writes lines that sum to `amount_due` (no throw, no phantom balance).
- **Comp regression (`invoices.extrasVoid.test.js`):** a `per_staff` add-on extras invoice comps `total_price` fully restored (no residual) — with the invoice seeded so its add-on line carries `source_type:'addon'`.

## Files

- `server/utils/drinkPlanExtras.js` — `computeExtrasBreakdown`: guarded engine-delta, richer context, returns `addonLineItems`
- `server/routes/stripe.js` — create-intent: expand SELECT (pkg row, duration, num_bartenders, proposal_addons) + apply the coverage/trigger filter
- `server/routes/drinkPlans/submit.js` — capture `existingAddonsAtIntent` pre-UPSERT; thread context on the transaction path; fast path skips the engine
- `server/utils/invoiceHelpers.js` — `writeExtrasLineItems` itemizes from `addonLineItems` (preserve `source_type:'addon'`) with a flat fallback; `createDrinkPlanExtrasInvoice`/`findOrRefreshExtrasInvoice` thread it
- `server/routes/stripeWebhook.js` + `server/scripts/backfillExtrasInvoices.js` — verify the no-`addonLineItems` fallback path (graceful lumped/flat itemize)
- `client/src/pages/plan/steps/LogisticsStep.js` — parking preview → `totalStaff`
- Tests as above

## Risk / rollout

Sensitive path (`stripe.js` charge + `stripeWebhook`/`invoices` money seam) → full per-lane review fleet before merge. Changes client-facing charge amounts for reachable non-flat add-ons (a correction upward, aligning pay-now with the proposal total; **provably never above the fold**). No schema change, no migration. Ship behind the normal explicit push gate.
