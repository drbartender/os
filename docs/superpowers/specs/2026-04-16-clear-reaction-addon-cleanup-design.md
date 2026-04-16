# Clear Reaction Add-On Cleanup + Non-Alcoholic Bubbles Toggle

## Context

The Clear Reaction package is a full mocktail bar service. Two add-ons — "Mocktail Bar" and "Pre-Batched Mocktail" — currently appear as selectable extras for this package, which is redundant (the package already includes mocktail service). These should be hidden when Clear Reaction is the selected package.

Separately, the Champagne Toast add-on ($2.50/guest) needs a toggle to switch it to "Non-Alcoholic Bubbles" at the same price. This applies across all packages, not just Clear Reaction.

---

## Change 1: Filter Redundant Add-Ons for Clear Reaction

### Behavior
- When the selected package slug is `the-clear-reaction`, hide `mocktail-bar` and `pre-batched-mocktail` from the add-on selection UI
- Filter applies in **ProposalCreate** and **ProposalDetail** (edit mode) only
- Legacy proposals that already have these add-ons attached display them normally in read-only views
- No backend or pricing engine changes needed — the engine only processes selected add-ons

### Implementation
- Add a constant mapping of package slugs to excluded add-on slugs (e.g., in `addonCategories.js` or inline in the proposal pages)
- Apply the filter when rendering the add-on checkbox list, before the `.map()` call

### Files to modify
- `client/src/pages/admin/ProposalCreate.js` — filter `filteredAddons` before rendering
- `client/src/pages/admin/ProposalDetail.js` — filter add-ons in edit mode rendering

---

## Change 2: Non-Alcoholic Bubbles Toggle on Champagne Toast

### Schema
- Add `variant VARCHAR(50) DEFAULT NULL` to `proposal_addons` table
- Idempotent migration: `ALTER TABLE proposal_addons ADD COLUMN IF NOT EXISTS variant VARCHAR(50) DEFAULT NULL`

### Stored value
- When toggle is off (default): `variant` is NULL — displays as "Champagne Toast"
- When toggle is on: `variant = 'non-alcoholic-bubbles'` — displays as "Non-Alcoholic Bubbles Toast"

### Admin UI (ProposalCreate + ProposalDetail edit mode)
- When `champagne-toast` is checked, render a small toggle/switch directly below it
- Toggle label: **"Non-Alcoholic Bubbles"**
- Toggle controls a `champagne_toast_variant` field in the form state
- On form submission, the variant value is included in the add-on data sent to the backend

### Pricing engine (`server/utils/pricingEngine.js`)
- When building the breakdown label for champagne toast, check if `variant === 'non-alcoholic-bubbles'`
- If yes, label = "Non-Alcoholic Bubbles Toast" instead of "Champagne Toast"
- Price calculation unchanged ($2.50/guest regardless of variant)

### Backend routes
- `server/routes/proposals.js` — accept `variant` field when saving proposal add-ons; store in `proposal_addons.variant`
- Pricing preview endpoint — pass variant through to pricing engine

### Client-facing views
- No changes needed. The label comes from the pricing snapshot, which is built by the pricing engine using the correct variant name. ProposalView, InvoicePage, and PricingBreakdown all render from the snapshot.

### Coupe upgrade interaction
- `champagne-coupe-upgrade` (requires `champagne-toast`) continues to work — the dependency is on champagne toast being selected, not on the variant. Non-alcoholic bubbles in a coupe glass is a valid combination.

### Files to modify
- `server/db/schema.sql` — add `variant` column to `proposal_addons`
- `server/utils/pricingEngine.js` — use variant-aware label for champagne toast
- `server/routes/proposals.js` — accept and store `variant` on proposal add-ons
- `client/src/pages/admin/ProposalCreate.js` — add toggle UI + form state for variant
- `client/src/pages/admin/ProposalDetail.js` — add toggle UI + edit form state for variant

---

## Verification

1. **Create a new proposal** with The Clear Reaction package
   - Confirm `mocktail-bar` and `pre-batched-mocktail` do NOT appear in the add-on list
   - Confirm `champagne-toast` and all other add-ons still appear
2. **Create a new proposal** with any other package (e.g., The Remedy)
   - Confirm `mocktail-bar` and `pre-batched-mocktail` DO appear
3. **Select champagne toast** on any proposal
   - Confirm the "Non-Alcoholic Bubbles" toggle appears below it
   - Toggle it on, save the proposal
   - Confirm the pricing breakdown shows "Non-Alcoholic Bubbles Toast" at $2.50/guest
4. **View the saved proposal** in read-only detail and public proposal view
   - Confirm it displays "Non-Alcoholic Bubbles Toast" (not "Champagne Toast")
5. **Select champagne toast + coupe upgrade + non-alcoholic toggle**
   - Confirm all three work together, coupe upgrade isn't broken by the variant
6. **Check a legacy Clear Reaction proposal** that has mocktail-bar attached
   - Confirm the read-only view still shows it (no data loss)
