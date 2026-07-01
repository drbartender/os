# Dr. Bartender — Pricing Reference

Complete, current pricing for every package, add-on, bundle, and other chargeable line item. Every number below was live-verified against the production Neon database (`service_packages` / `service_addons` tables) on **2026-07-01** — not just read from the seed file, which can drift from admin-edited values over time. Prices are admin-editable via the dashboard, so re-verify against the live DB before treating this as gospel after any pricing change.

Source of truth in code: `server/db/schema.sql` (catalog), `server/utils/pricingEngine.js` (the math), `server/utils/proposalRules.js` (bundle logic), `server/utils/gratuityLabels.js` (gratuity labels).

---

## 1. Packages

All packages include setup & breakdown, a cooler, a custom menu graphic, and $2M liquor liability insurance unless noted. "Standard" guest count is 50+; below that, the **small-event rate** kicks in (higher per-guest rate to cover fixed costs across a smaller headcount).

### BYOB / Service-Only

| Package | Price | Notes |
|---|---|---|
| **The Core Reaction** | **$350** flat, up to 4 hrs. **+$100/hr** beyond 4 hrs. | Client provides all alcohol/supplies (or shops from our custom list). Includes 1 bartender, bar tools, menu planning session, event-specific shopping list. No 3-hour discount — a 3-hour event still bills the 4-hour rate. |

### Hosted Full Bar

Per-guest, includes bartender(s) at a 1:100 guest ratio (see [Bartender Ratio](#bartender-ratio--over-ratio-charges) below).

| Package | Standard rate (≥50 guests) | Small-event rate (<50 guests) | Extra hour | Minimum total |
|---|---|---|---|---|
| **The Base Compound** | $18/guest | $23/guest | +$5/guest/hr | $500 |
| **The Midrange Reaction** | $22/guest | $27/guest | +$6/guest/hr | $600 |
| **The Enhanced Solution** | $28/guest | $33/guest | +$8/guest/hr | $700 |
| **Formula No. 5** | $33/guest | $39/guest | +$9/guest/hr | $850 |
| **The Grand Experiment** | $40/guest | $46/guest | +$11.25/guest/hr | $1,000 |

All rates cover the first 4 hours; the "extra hour" rate applies per guest, per hour beyond that. The **minimum total** is a floor — if guests × rate comes in under it, the client is charged the minimum instead.

### Hosted Beer & Wine

| Package | Standard rate (≥50 guests) | Small-event rate (<50 guests) | Extra hour | Minimum total |
|---|---|---|---|---|
| **The Primary Culture** | $12/guest | $17/guest | +$4/guest/hr | $400 |
| **The Refined Reaction** | $14/guest | $19/guest | +$5/guest/hr | $400 |
| **The Carbon Suspension** | $15/guest | $20/guest | +$5.75/guest/hr | $425 |
| **The Cultivated Complex** | $17/guest | $22/guest | +$6.25/guest/hr | $450 |

### Hosted Mocktail

| Package | Standard rate (≥50 guests) | Small-event rate (<50 guests) | Extra hour | Minimum total |
|---|---|---|---|---|
| **The Clear Reaction** | $14/guest | $18/guest | +$4/guest/hr | $400 |

Mocktail bar for corporate events, baby showers, religious/cultural events, or sober-curious crowds. 3-4 signature mocktail recipes, mixers/garnishes/syrups included.

### Cocktail Classes

Fixed 2-hour format, 8-guest minimum, no extra-hour billing (duration is locked). All six classes are priced identically:

| Class | Price |
|---|---|
| Mixology 101 | $35/guest |
| Spirits Tasting | $35/guest |
| Margarita Workshop | $35/guest |
| Tropical / Tiki Night | $35/guest |
| Brunch Cocktails | $35/guest |
| Mocktail Workshop | $35/guest |

Class price is instruction + venue setup only — spirits/supplies are billed separately via the class supply add-ons below. Classes are exempt from bartender over-ratio charges and gratuity surcharges (see [Bartender Ratio](#bartender-ratio--over-ratio-charges)).

---

## 2. Add-Ons

### BYOB Supply Bundles

Three tiered bundles cover BYOB clients' bar supplies. Selecting a bundle automatically suppresses the individual à-la-carte items it already includes, so clients are never double-charged.

| Bundle | Price | Covers | Also blocks |
|---|---|---|---|
| **The Foundation** | $3.00/guest, +$0.75/guest/hr past 4hrs | Ice delivery, cups & disposables, bottled water | — |
| **The Formula** | $5.50/guest, +$1.25/guest/hr past 4hrs | Everything in Foundation + signature mixers | Full Mixers |
| **The Full Compound** | $8.00/guest, +$2.00/guest/hr past 4hrs | Everything in Foundation + full mixers + garnish package | Signature Mixers |

Only one BYOB bundle can be selected per proposal, and only one mixer tier (Signature or Full) can be active at a time.

### BYOB Supply Add-Ons (à la carte)

For clients who don't want a full bundle:

| Add-on | Price |
|---|---|
| Ice Delivery | $2.00/guest |
| Cups & Disposables | $1.50/guest |
| Bottled Water | $0.50/guest |
| Signature Mixers | $2.00/guest |
| Full Mixers | $4.50/guest |
| Garnish Package | $50.00 per 100 guests (rounds up) |

### Beverage Add-Ons

| Add-on | Applies to | Price |
|---|---|---|
| Soft Drink Add-On | All | $3.50/guest — extra soda/juice supply for non-drinking guests beyond what's stocked as cocktail mixer |
| Pre-Batched Mocktail | All | $2.00/guest |
| Mocktail Bar | All | $7.50/guest, +$2.00/guest/hr past 4hrs |
| Non-Alcoholic Beer | Hosted only | $4.00/guest — Athletic Brewing (Upside Dawn, Free Wave Hazy IPA) |
| Zero-Proof Spirits | Hosted only | $5.00/guest — Lyre's NA spirits |

### Premium / Glassware Add-Ons

| Add-on | Price | Notes |
|---|---|---|
| Champagne Toast | $2.50/guest | — |
| Coupe Glass Upgrade | $2.00/guest | Requires Champagne Toast; capped at 100 guests |
| Real Glassware Upgrade | $5.00/guest | Capped at 100 guests |

### Craft Ingredient Add-Ons

| Add-on | Price |
|---|---|
| Handcrafted Syrups (single 750ml) | $30.00 flat |
| Handcrafted Syrups 3-Pack | $75.00 flat |
| House-Made Ginger Beer | $2.50/guest |
| Carbonated Cocktails (up to 2 signature) | $2.00/guest |
| Smoked Cocktail Kit | $75.00 flat |
| Flavor Blaster Rental | $150.00 flat (guests must have real/own glassware) |

> The drink-plan builder (post-booking) also auto-calculates syrup cost from a guest-scaled quantity — 1 bottle per flavor up to 50 guests, then 1 additional bottle per flavor per 50 guests — using these same $30/$75 unit prices, bundled into 3-packs where possible. Same numbers, different entry point (proposal add-on vs. drink-plan quantity picker).

### Specialty Spirit Add-Ons (hosted only)

Auto-suggested when a client's chosen cocktail needs a spirit/liqueur category their hosted package doesn't stock:

| Add-on | Price |
|---|---|
| Bitter Aperitifs (Campari, Aperol, Cynar, amaro) | $3.00/guest |
| Vermouth & Fortified Wines | $1.50/guest |
| Specialty Liqueurs (Cointreau, amaretto, absinthe, etc.) | $2.50/guest |
| Mezcal | $3.00/guest |
| Cognac | $4.00/guest |

### Staffing Add-Ons

| Add-on | Price |
|---|---|
| Additional Bartender | $40.00/hr + gratuity surcharge if under guest ratio (see below) |
| Banquet Server | $75.00/hr, 4-hour minimum ($300 minimum charge) |
| Barback | $75.00/hr, 4-hour minimum ($300 minimum charge). Gratuity included in the rate. |

### Logistics

| Add-on | Price |
|---|---|
| Parking Fee | $20.00 per staff member on-site |

### Class Supply Add-Ons

Each linked to its specific class — spirits, mixers, garnishes, ice, and disposables for the session:

| Add-on | Class | Price |
|---|---|---|
| Mixology 101 Supplies | Mixology 101 | $25.00/guest |
| Standard Tier Spirits | Spirits Tasting | $30.00/guest |
| Premium Tier Spirits | Spirits Tasting | $45.00/guest |
| Margarita Workshop Supplies | Margarita Workshop | $25.00/guest |
| Tropical / Tiki Supplies | Tropical / Tiki Night | $30.00/guest |
| Brunch Cocktails Supplies | Brunch Cocktails | $30.00/guest |
| Mocktail Workshop Supplies | Mocktail Workshop | $15.00/guest |

"Top Shelf" spirits tier for Spirits Tasting has no fixed price — it routes to a manual admin quote instead of a catalog price.

### Class Equipment Add-Ons

Mutually exclusive (client picks one):

| Add-on | Price |
|---|---|
| Tool Kit (Purchase) — guests keep it | $55.00/guest |
| Tool Kit (Rental) | $10.00/guest |

---

## 3. Other Chargeable / Computed Line Items

### Bar Rental

Every package: **$50** for the first bar, **+$100** for each additional bar. (Cocktail classes: $0 — no bar rental charged.)

### Bartender Ratio & Over-Ratio Charges

Hosted packages include bartender staffing in the per-guest rate at a **1 bartender per 100 guests** ratio (100 guests = 1 included, 250 guests = 3 included, etc.) — those bartenders are a $0 line item. BYOB packages include 1 bartender only.

Bartenders added beyond that ratio — whether by raising the bartender count or adding the "Additional Bartender" add-on — are charged:
- **$40.00/hr** base rate, **plus**
- A **"Staffing Gratuity" surcharge**, scaled to guest count (compensates bartenders for lighter tip volume at smaller events):
  - Under 50 guests: **+$50/hr**
  - Under 75 guests: **+$25/hr**
  - Under 100 guests: **+$15/hr**
  - 100+ guests: **$0**

Cocktail classes are exempt from both the hourly charge and the surcharge — all instructors are included free.

### Client-Elected Gratuity

A separate, optional gratuity the client can pre-pay at checkout, on top of the service total. Stored as a **$/staff/hour rate**; the charged amount is `rate × staff count × hours`. Staff count = bartenders + "Additional Bartender" add-on quantity (barbacks and banquet servers are excluded from this pool). If the client opts out of an on-site tip jar, a **$50/staff/hour minimum** is enforced. A $1,000/staff/hour sanity cap guards against data-entry mistakes. This gratuity is never reduced by discounts or admin price overrides, and it pays out to staff net of the pro-rata Stripe processing fee.

### Deposit

**$100** flat, payable in lieu of paying the full total up front — available up until 14 days before the event. Inside that 14-day window, full payment is required (the deposit option is removed). Inside 72 hours of the event, bookings are flagged "last-minute" and get a cancellation-policy caveat added to client communications — this is a policy notice, not an additional fee.

### Drink Plan Extras

If a client's final drink selections (chosen after booking, via the drink-plan tool) push the total above what was already quoted and paid, the difference is billed separately as a "Drink Plan Extras" charge. There's no fixed price — it's whatever the computed delta is.

### Price Adjustments / Custom Total

Admin-only tools, not standing line items: a proposal can carry arbitrary discount/surcharge adjustments, or have its entire total manually overridden for one-off custom pricing. Client-elected gratuity is layered on top of either and is never affected by them.

---

## What We Don't Charge

- No travel or mileage fee, regardless of distance.
- No cancellation fee (only the last-minute booking policy notice above 72 hours out).
- No card-processing/convenience fee passed through to clients on Stripe payments.
- No separate table/linen/spandex rental SKU — that equipment isn't in the current catalog.
