# Drink-plan submit must preserve negotiated prices

Date: 2026-07-16
Status: approved (Dallas, section-by-section)
Origin: Jack Van Dyke (proposal 600) invoice investigation

## Problem

`server/routes/drinkPlans/submit.js` re-prices a proposal from scratch when a client
submits a drink plan carrying financial extras (an add-on or a bar rental). Its
`calculateProposal({...})` call passes neither `totalPriceOverride` nor `adjustments`.
The engine therefore re-prices at full catalog and the handler writes the result to
`proposals.total_price`, silently destroying any negotiated price. It never touches the
`total_price_override` column, so the row is left internally inconsistent: the override
still holds the contracted number while `total_price` holds the catalog number. Every
invoice path reads `total_price`, so the client gets billed the catalog price.

The client does this to themselves. No admin action is involved.

### Confirmed damage

- **Jack Van Dyke (600), 2026-07-16.** Added a second bar via the planner. Contract
  $3,273 re-priced to $4,000. He was emailed "Extras Added $727, Updated Event Total
  $4,000.00, Remaining Balance $3,900.00". A balance invoice created at that moment
  would have overbilled him by $627. Corrected by hand in prod; invoice INV-0193 minted
  and locked.
- **Shiralee Mack Perkins (527), 2026-06-24.** Same path. Override $350 re-priced to
  $450. She paid $450. Refunded $80 by hand on 2026-07-15 (`refund_issued`, reason
  "Bar and Syrup") to land at $370, which is her $350 override plus the $20 parking
  add-on. The rule this spec implements reproduces that number exactly.

### Blast radius

Every proposal with a `total_price_override` and a live drink plan. That is the 12
remaining CC-transferred events plus any native proposal Dallas custom-prices. Exposure
runs both directions: Madelyn (+$277) and Emiline (+$50) would be overbilled; Julia
(-$350), Cecilia (-$320), Cody (-$280), Shazana (-$160), Eliana (-$150) and Amy (-$100)
would be underbilled, because their contracts sit above catalog.

## The trap: the obvious fix is wrong

Passing `totalPriceOverride` straight through does NOT work. The engine computes:

```js
const serviceTotal = totalPriceOverride !== null && totalPriceOverride !== undefined
  ? Math.round(Number(totalPriceOverride) * 100) / 100
  : calculatedTotal;
```

The override replaces the *entire* calculated total. Preserve it naively and every
drink-plan extra becomes free. Verified against the real engine with Jack's inputs:
adding his second bar moved the total by **$0.00**. That is the same bug pointing the
other way, and it would leak money silently.

## Design

### Rule

`newOverride = oldOverride + catalogDelta`, where `catalogDelta` is the catalog-priced
value of exactly what the client just added, computed with the override OFF so it cancels
out of both sides.

For Jack: catalog without the added bar $3,900, catalog with it $4,000, delta $100, so
`3273 + 100 = 3373`. That matches both the "Additional Portable Bar $100" the planner
quoted him and the figure settled by hand.

The rule handles the CC-era bar rule for free. Those contracts include one portable bar
(the $50 first-bar fee was introduced later as an opt-in add-on). Because the included
bar's fee appears in the catalog on both sides of the subtraction, it cancels, and only a
genuine second bar's $100 survives. No special-casing, no "bar is included" flag.

### Branching

- **`total_price_override IS NULL` (native):** behavior is unchanged. Keep today's
  catalog recompute and write `total_price = snapshot.total`. This is the battle-tested
  path and it stays intact.
- **`total_price_override IS NOT NULL`:** compute the delta, derive `newOverride`, build
  the snapshot with `totalPriceOverride: newOverride`, and write BOTH `total_price` and
  `total_price_override` so the row cannot drift apart again.

### Reconstructing the pre-extras state

The handler mutates state before it prices, so the "before" side must be captured first:

- `numBars`: `numBarsAtIntent` already exists (captured before the increment, and it is
  the same value `computeExtrasBreakdown` keys the first-vs-additional bar fee off).
- `addons`: requires a new query of `proposal_addons` BEFORE the upsert loop.
- `syrups`: read `pricing_snapshot.syrups.selections` from the pre-update snapshot.
- Everything else (guest count, duration, bartenders, gratuity, tip jar, adjustments) is
  unchanged across the submit and cancels out of the delta.

Both delta calls pass `totalPriceOverride: null` and the SAME `adjustments`, so
adjustments cancel and cannot distort the delta. Gratuity likewise cancels, unless the
extras change staff count, in which case the movement is a real delta and should count.

### Adjustments

Pass `adjustments: proposal.adjustments || []` in both branches. Today they are dropped,
which erases the visible discount lines from the breakdown. Verified against prod: no
proposal has adjustments without also having an override, and under an override
adjustments are decorative, so restoring them changes no live total. It fixes the
breakdown for the three Edward Marx proposals, which carry four discount lines each.

### Why `computeExtrasBreakdown` is not used for the delta

It is tempting, since it already prices the same selections for the pay-now path and
matches the client's quote. It is rejected because it deliberately uses RAW enabled
add-on slugs, "NOT validated against package coverage/triggers", whereas the submit path
validates slugs against `covered_addon_slugs` and cocktail upgrade triggers before
writing `proposal_addons`. Using it would let a package-covered add-on inflate
`total_price` while no matching `proposal_addons` row exists. The two-engine-call delta
uses the validated add-on set and the same engine that produces `total_price`, so the
total stays internally consistent.

### Out of scope

- **`generateLineItemsFromProposal` stays override-blind.** Every invoice flows through
  it. For an overridden proposal it would need a reconciling line whose only honest
  wording depends on the CC-era "bar included" fact, which exists in a 2024 PDF and not
  in the schema. It would produce an itemization Dallas would reject and hand-edit
  anyway. The wart (correct total over catalog line items) is pre-existing, cosmetic, and
  has gone unremarked since June. Log to the fix-list.
- **The $50 first-bar ghost.** Once the override survives, it can never reach a total
  again. It remains a cosmetic breakdown line that reappears on each admin save.
  Demoted to the fix-list.
- **Re-submit after an admin reset-to-draft.** `num_bars` increments per submit with
  `addBarRental`, so a reset-and-resubmit double-counts a bar. Pre-existing, gated by the
  submit-once rule, unchanged here.

## Part 2: CC balance-invoice operator script

Roughly ten CC balance invoices remain (Cody, Eliana, Emiline, Jayme, James, Emily,
Shazana, Madelyn, Julia, Cecilia) before Check Cherry is cancelled on 2026-07-21. Each
needs the shape INV-0193 ended up with, because the generator cannot produce it:

- label `Balance` (a real `CONTRACT_LABELS` member, so refunds classify correctly and do
  not treat the payment as extra-scope)
- born `status='sent'`, never `draft` (the draft-pay trap: the public page renders drafts
  but `create-intent-for-invoice` refuses them)
- `amount_due = total_price - amount_paid`
- line items that reconcile to `amount_due`: contract line, any real extras, then a
  negative "Less deposit paid <date>" credit
- `locked = true`, so `refreshUnlockedInvoices` cannot rebuild the itemization from
  catalog on the next admin save

`scripts/cc-balance-invoice.js`, dry-run by default, `--apply` to write, `--only <id>`
per proposal. Refuses any proposal that already has a non-void invoice. Prints the
resulting client link. It does NOT send email; Dallas writes those himself.

The script is a one-time closing-chapter tool and is deletable after 7/21.

## Testing

TDD. The first test fails against current `main` and reproduces Jack exactly.

1. **Regression (Jack):** overridden proposal ($3,273, `num_bars=1`), drink plan submitted
   with `addBarRental`. Expect `total_price = 3373`, `total_price_override = 3373`, and
   NOT 4000.
2. **Extras are not free:** same case pins the delta at exactly $100, guarding the naive
   fix from ever landing.
3. **Native unchanged:** no override, extras added, catalog recompute result identical to
   today, and `total_price_override` stays NULL.
4. **No-extras submit:** delta is 0, no money moves.
5. **Adjustments survive:** an overridden proposal with adjustments keeps its discount
   lines in the rebuilt breakdown.
6. **Second bar on a CC contract:** the included first bar cancels; only $100 is added.

Server suites share the dev DB, so run one suite at a time via `node -r dotenv/config`.

## Risk

Money path. Build in a lane off main, squash-merge back, and run the review fleet before
any push. Do not push directly. The native branch must be provably byte-for-byte
unchanged; that is the primary review question.
