# NA Beverage Add-ons & Quote Wizard Reorder

## Context

The Clear Reaction (mocktail-only package) currently includes juice, soda, and syrups but has no way to offer NA beer or zero-proof spirits. Clients booking NA events — or hosted alcohol events wanting NA options for some guests — have no path to add these. Rather than creating a new package tier, these become per-guest add-ons available on all hosted packages (including Clear Reaction).

Separately, the quote wizard's "Who provides the alcohol?" question lists mocktails last, burying the NA-first option. Moving it to first position surfaces it for the growing sober-curious market.

## Design

### 1. Quote Wizard — Reorder alcohol_provider options

**File:** `client/src/pages/website/QuoteWizard.js`

Reorder the `<select>` options for `alcohol_provider` from:
```
1. I'll provide the alcohol (byob)
2. Dr. Bartender provides the alcohol (hosted)
3. No alcohol (mocktails only) (mocktail)
```
to:
```
1. No alcohol (mocktails only) (mocktail)
2. I'll provide the alcohol (byob)
3. Dr. Bartender provides the alcohol (hosted)
```

No logic changes — `handleAlcoholChange` works off the value, not position.

### 2. New service_addons — Non-Alcoholic Beer & Zero-Proof Spirits

**File:** `server/db/schema.sql`

Two new rows in the `service_addons` INSERT block:

| Field | Non-Alcoholic Beer | Zero-Proof Spirits |
|---|---|---|
| slug | `non-alcoholic-beer` | `zero-proof-spirits` |
| name | Non-Alcoholic Beer | Zero-Proof Spirits |
| description | NA beer selection for guests (Athletic Brewing, Heineken 0.0, etc.) | Premium zero-proof spirit alternatives for crafted NA cocktails (Seedlip, Lyre's, etc.) |
| billing_type | `per_guest` | `per_guest` |
| rate | 4.00 | 5.00 |
| extra_hour_rate | NULL | NULL |
| applies_to | `hosted` | `hosted` |
| category | `beverage` | `beverage` |
| sort_order | 23 | 24 |

**Pricing note:** Rates ($4 and $5/guest) are initial values, expected to be refined after real-world costing. Adjustable in the database without code changes.

### 3. Add-on icons

**File:** `client/src/data/addonCategories.js`

Add to the `ADDON_ICONS` beverage section:
- `'non-alcoholic-beer'`: `'🍺'`
- `'zero-proof-spirits'`: `'🫗'`

## What does NOT change

- **pricingEngine.js** — existing `per_guest` billing type handles these: `guestCount * rate * quantity`
- **ProposalCreate.js** — existing `applies_to` filtering shows these for hosted packages, hides for BYOB
- **QuoteWizard.js add-on filtering** — same `applies_to` logic, no special-case code needed
- **PricingBreakdown.js** — iterates `snapshot.breakdown[]` which the engine populates automatically
- **ProposalDetail.js / ProposalView.js** — read from pricing snapshot, no changes needed
- **No new files, routes, components, or billing types**

## Verification

1. Run `npm run dev`
2. **Quote wizard:** Confirm mocktail option appears first in the alcohol dropdown
3. **Quote wizard (hosted path):** Select a hosted package, reach Extras step — confirm Non-Alcoholic Beer and Zero-Proof Spirits appear in Beverage Options
4. **Quote wizard (mocktail path):** Select "No alcohol (mocktails only)", reach Extras — confirm both NA add-ons appear
5. **Quote wizard (BYOB path):** Select "I'll provide the alcohol" — confirm NA add-ons do NOT appear
6. **Pricing preview:** Add one or both NA add-ons, confirm pricing updates correctly (guest_count * rate)
7. **Admin ProposalCreate:** Create a proposal with a hosted package — confirm both add-ons are selectable and price correctly
8. **Admin ProposalCreate with Clear Reaction:** Select Clear Reaction package — confirm both add-ons available
