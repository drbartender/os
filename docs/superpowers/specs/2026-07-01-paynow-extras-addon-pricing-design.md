# Pay-Now Drink-Plan Extras: Price Non-Flat Add-Ons at Their Real Rate

**Date:** 2026-07-01
**Status:** Design approved via brainstorm dialogue. Follow-up to the deferred **Medium** from the payment-accounting-fixes Lane B push review (2026-07-01, commit 3e7a6be). Pending lane plan.

This is a standalone correctness fix to how the "pay now" drink-plan extras flow prices add-ons. It is independent of, but rooted in, the same code Lane B touched (`stripe.js` create-intent, `drinkPlanExtras.js`, `invoiceHelpers.js`).

---

## Problem

The pay-now extras path prices every **non-`per_guest`** add-on at its **flat rate**, while the proposal pricing engine prices `per_staff` / `per_hour` / `per_100_guests` / `per_guest_timed` add-ons at their **real, scaled rate**.

- Charge + invoice side: `server/routes/stripe.js` create-intent → `computeExtrasBreakdown` (`server/utils/drinkPlanExtras.js`) and the line-item builder `writeExtrasLineItems` (`server/utils/invoiceHelpers.js`) both do `if (billing_type === 'per_guest') rate * guests; else rate` — i.e. flat for everything that isn't per-guest.
- Fold side: `calculateProposal` → `calculateAddonCost` (`server/utils/pricingEngine.js:131`) prices `per_staff` as `staffCount * rate`, `per_hour` as `effectiveHours * rate`, `per_100_guests` as `ceil(guests/100) * rate`, `per_guest_timed` as `(guests*rate + extraHours*guests*extra_hour_rate)`; and `additional-bartender` gets a **special gratuity-surcharge block** (`pricingEngine.js:328`), never `calculateAddonCost`. `per_staff` is priced off **`totalStaff`** = base staffing + add-on bartenders + barbacks/servers (`pricingEngine.js:311`).

### Consequences

1. **The pay-now charge under-bills these add-ons.** A submit runs `calculateProposal`, so `total_price` gets the *real* fold, but the client is charged (and invoiced) the *flat* amount. The difference silently lands on the Balance.
2. **Comp under-reverses `total_price`** (the deferred Medium): the extras invoice (flat) ≠ the folded amount (real), so voiding an unpaid such extra leaves a `total_price` residual (~$20–40; client over-stated, **not DRB money lost**).
3. **Reachable** via `parking-fee` (`per_staff`, auto-toggled by `LogisticsStep`) and any staffing / logistics / `garnish-package-only` (per_100) / mocktail (per_guest_timed) add-on the planner exposes. Confirmed active in prod: 9 non-`{per_guest,flat}` add-ons.

**Root:** the original create-intent (Potion pay-now, ~commit 772c337) only special-cased `per_guest` and treated all else as flat. Lane B faithfully preserved that math (`computeExtrasBreakdown` is byte-equivalent to the old create-intent), so this predates Lane B.

## Goal

The pay-now extras **charge**, the "Drink Plan Extras" invoice **`amount_due` + line items**, and the **`total_price` fold** agree for **every** add-on billing type, so (a) clients are charged the correct real rate pay-now, and (b) comp reverses with no residual.

## Non-Goals

- No change to syrups or bar-rental pricing (already correct).
- No change to which add-ons the planner exposes (a separate UX question).
- No change to `calculateProposal` / `calculateAddonCost` — the engine is the source of truth, not the thing being changed.
- No data migration. Historical flat-priced extras invoices stay as-is; the one live abandoned case (Shiralee, 527) is syrup-only and unaffected.

## Design — reuse the engine via a with-vs-without delta

The add-on pricing in `calculateProposal` is intertwined with the staffing count, the additional-bartender gratuity surcharge, and the hosted-package rule (CLAUDE.md flags the hosted-bartender rule as load-bearing, "re-lost multiple times"). **Re-deriving add-on prices in the extras helper would replicate that logic — brittle and exactly where money bugs hide.** Instead, treat `calculateProposal` as the single source of truth and compute the extras' add-on portion as the **delta it produces**.

### Core

- **Add-on portion of the extras = `addonTotal(existing proposal add-ons ∪ the new drink-plan add-ons) − addonTotal(existing add-ons)`**, both computed by `calculateProposal`. This captures the real rate AND interactions (e.g. `parking-fee` per_staff scaling when a bartender is also added), with zero replication. "New" = add-on slugs enabled in the drink-plan selections that are not already on the proposal (matches the submit UPSERT, and avoids double-charging a slug already folded into `total_price`).
- Bar rental and syrups are already correct and stay as they are.
- `totalCents = round((addonDelta + barRental + syrup) * 100)` — still the rounded sum, still equals what Stripe charges.
- **Ordering (mirrors Lane B's pre-increment `num_bars`):** the delta must be computed against the proposal's **pre-submit** add-on set + staffing, captured before the submit transaction UPSERTs the new add-ons and recomputes `total_price` — otherwise "existing" already includes the new add-ons and the delta collapses to zero. Same pre-mutation-state discipline Lane B used for the bar-rental line.

### Interfaces

- **`computeExtrasBreakdown` becomes engine-backed.** It gains the full pricing context it needs to run `calculateProposal` (pkg, guestCount, durationHours, numBars, numBartenders, existing proposal add-ons, gratuityRate, tipJar) plus the new drink-plan selections. It returns `{ totalCents, addonDeltaCents, barRentalCents, syrupCents, addonLineItems }`, where `addonLineItems` are the **new** add-ons' `addonResults` entries (real-rate `line_total`s) for the invoice.
- **`stripe.js` create-intent** and **`submit.js`** both call this one helper with the same context, so charge == invoice by construction. create-intent already reads most of this context; it gains the existing-add-on resolution.
- **`writeExtrasLineItems`** itemizes the add-on lines from `addonLineItems` (real-rate) instead of re-pricing; bar + syrup lines unchanged; the existing drift-reconcile keeps the lines summing to `amount_due`.
- **Comp (B4) is unchanged** — `voidExtrasInvoiceWithReconcile`'s "reverse the whole invoice when any add-on/bar line exists" is already exact once invoice == fold; the `invoices.extrasVoid` mixed-case test just gets real-rate line seeds.

### Data flow

```
create-intent / submit
  → computeExtrasBreakdown(fullProposalContext, newSelections)
      addonDelta = calculateProposal(existing ∪ new).addonTotal − calculateProposal(existing).addonTotal
      addonLineItems = calculateProposal(existing ∪ new).addonResults ∩ new slugs
      totalCents = round((addonDelta + barRental + syrup) * 100)
  → charge = totalCents (create-intent);  amount_due = totalCents + itemize(addonLineItems, bar, syrup) (submit)
```

## Edge cases

| Situation | Outcome |
|---|---|
| New `per_staff` add-on (parking), no new staff | delta = `staff × rate` on current `totalStaff` — real rate, matches fold |
| New bartender + parking together | delta captures the bartender line AND parking's increase on the higher staff count |
| Slug already on the proposal | not "new" → no delta → no double-charge |
| Hosted package / additional-bartender gratuity | honored by `calculateProposal`, not replicated |
| Interaction delta not attributable to a single new line (e.g. parking increase from a new bartender) | `amount_due` = the engine delta (authoritative); the itemization's drift-reconcile absorbs the small unattributed remainder into the last line |
| Syrup-only / per_guest / flat add-ons | unchanged (delta equals the old flat/guest math for those) |
| Comp of any such extra | full-invoice reversal, `total_price` fully restored, no residual |

## Testing

- **Unit (`drinkPlanExtras.test.js`):** the extras delta for `per_staff`, `per_hour`, `per_100_guests`, `per_guest_timed`, `per_guest`, `flat` add-ons, each asserted against a direct `calculateProposal` delta (not a magic number). Include the parking-scales-with-staff interaction.
- **Integration (submit):** a `parking-fee` pay-now submit creates an extras invoice at the real rate (`staff × $20`), and `amount_due` equals the create-intent charge for the same selections.
- **Comp regression (`invoices.extrasVoid.test.js`):** a `per_staff` add-on extras invoice comps to `total_price` fully restored (no residual) — the exact case that motivated this spec.
- **Regression:** syrup-only, `per_guest` add-on, and bar-rental pay-now paths produce identical amounts to today.

## Files

- `server/utils/drinkPlanExtras.js` — `computeExtrasBreakdown` → engine-delta, richer context, returns `addonLineItems`
- `server/routes/stripe.js` — create-intent feeds full context + resolves existing add-ons
- `server/routes/drinkPlans/submit.js` — feeds full context; `findOrRefreshExtrasInvoice`/create carry `addonLineItems`
- `server/utils/invoiceHelpers.js` — `writeExtrasLineItems` itemizes from `addonLineItems`; `createDrinkPlanExtrasInvoice`/`findOrRefreshExtrasInvoice` thread it through
- Tests as above

## Risk / rollout

Sensitive path (`stripe.js` charge + `stripeWebhook`/`invoices` money seam) → full per-lane review fleet before merge. This **changes client-facing charge amounts** for non-flat add-ons (a correction upward, aligning pay-now with the proposal total). No schema change, no migration. Ship behind the normal explicit push gate.
