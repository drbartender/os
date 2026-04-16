# Admin Edit: Pricing Adjustments, Multi-Bar, Save Guard

## Context

The admin proposal/event edit form needs three improvements:

1. **No way to adjust prices** — the pricing engine calculates everything formulaically with no mechanism for discounts, surcharges, or total overrides. Admins need to adjust prices for returning clients, holiday premiums, negotiated rates, etc.
2. **Bar rental capped at 1** — the UI has a yes/no toggle, but the pricing engine and DB already support multiple bars ($50 first + $100 each additional). Admins can't set 2+ bars.
3. **Unsaved changes lost** — admins edit fields then navigate away without saving. Need an unsaved changes guard, plus a more noticeable save button.

## Data Model

### New columns on `proposals` table

| Column | Type | Default | Purpose |
|---|---|---|---|
| `adjustments` | `JSONB` | `'[]'` | Array of price adjustment objects |
| `total_price_override` | `NUMERIC(10,2)` | `NULL` | When set, replaces the calculated total |

### Adjustment object shape

```json
{
  "type": "discount",
  "label": "Returning client discount",
  "amount": 150,
  "visible": true
}
```

- `type`: `"discount"` or `"surcharge"`
- `label`: freeform string displayed as a line item
- `amount`: always positive — sign derived from type
- `visible`: whether the client sees this line item on their proposal

### Override behavior

When `total_price_override` is not null, it becomes the final total. The pricing snapshot still stores the full calculation so the admin can see what the formula produced, but `snapshot.total` and `proposals.total_price` reflect the override.

### Bar rental

No schema change. `num_bars` is already an integer column — just a UI change from boolean to number picker.

## Pricing Engine

**File:** `server/utils/pricingEngine.js` — `calculateProposal()`

New parameters: `adjustments` (array), `totalPriceOverride` (number or null).

After existing calculation (base + bar + staffing + addons + syrups = subtotal):

1. Loop through `adjustments`, append each to the `breakdown` array:
   - Discount: `{ label: "Returning client discount", amount: -150 }`
   - Surcharge: `{ label: "Holiday rate", amount: 75 }`
2. Calculate `adjustmentNet` = sum of signed amounts
3. `total = Math.max(0, Math.round((subtotal + adjustmentNet) * 100) / 100)`
4. If `totalPriceOverride` is not null, `total = totalPriceOverride`
5. Return object includes: `adjustments` array, `total_price_override` value, and `subtotal` (pre-adjustment) for admin reference

## Backend Routes

**File:** `server/routes/proposals.js`

### `POST /proposals/calculate` (admin preview, ~line 556)
- Accept `adjustments` and `total_price_override` from request body
- Pass to `calculateProposal()`

### `PATCH /proposals/:id` (save edit, ~line 815)
- Accept `adjustments` and `total_price_override` from request body
- Pass to `calculateProposal()`
- Store both in DB: add to UPDATE query
- Fall back to existing: `adjustments ?? old.adjustments ?? []`, `totalPriceOverride ?? old.total_price_override`

### `POST /proposals/public/calculate` (public preview, ~line 200)
- No change — public users cannot add adjustments

### GET endpoints
- Already `SELECT *`, new columns included automatically

## Admin Edit UI

**File:** `client/src/pages/admin/ProposalDetail.js`

### Bar rental (left column, event fields)
- Replace yes/no "Portable Bar Needed?" dropdown with number input "Number of Portable Bars" (0-5)
- Pre-populate from `proposal.num_bars`
- Pass as `num_bars` directly to preview and save

### Adjustments (right column, inside Package & Pricing card)
Placement: below the PricingBreakdown component, inside the same card.

- Header: "Price Adjustments"
- Each row: type pill (Discount/Surcharge), text input for label, dollar input for amount, visibility toggle (show to client), delete button
- Two buttons: "+ Discount" and "+ Surcharge" — append empty row
- Pre-populated from `proposal.adjustments || []`
- Passed to calculate preview for live updates

### Total override (right column, below adjustments)
- Collapsible section: checkbox "Override Total" + dollar input
- When enabled, preview shows that total
- Subtle note: "Overrides calculated total"

### `editForm` state additions
```javascript
adjustments: proposal.adjustments || [],
total_price_override: proposal.total_price_override ?? null,  // use ?? not || (0 is valid)
```

### Save payload additions
Pass `adjustments` and `total_price_override` in the `api.patch()` call.

### Live preview additions
Pass `adjustments` and `total_price_override` in the `api.post('/proposals/calculate')` call.

## ProposalCreate

**File:** `client/src/pages/admin/ProposalCreate.js`

- Replace `needs_bar` boolean with `num_bars` number input (0-5), default 0
- Update all references: `form.needs_bar ? 1 : 0` becomes `form.num_bars`
- No adjustments on create — adjustments are edit-only

## PricingBreakdown Component

**File:** `client/src/components/PricingBreakdown.js`

- When `item.amount < 0`, render in green with `-$X.XX` formatting (not `$-X.XX`)
- No special override handling needed — the pricing engine already sets `snapshot.total` to the override value, so PricingBreakdown renders it correctly as-is

## Client-Facing ProposalView

**File:** `client/src/pages/proposal/ProposalView.js`

- Include adjustments with `visible: true` in the `lineItems` array
- Discounts: negative green line items
- Surcharges: normal positive items
- `visible: false` adjustments excluded from display but still affect total
- If `total_price_override` is set, use it as the displayed total

## Unsaved Changes Guard

**File:** `client/src/pages/admin/ProposalDetail.js`

Note: App uses `BrowserRouter`, not a data router, so `useBlocker` is unavailable.

- Store initial form state when entering edit mode (`editFormInitial` ref)
- Derive dirty flag: `JSON.stringify(editForm) !== JSON.stringify(editFormInitial)`
- `window.beforeunload` listener while dirty — browser warns on refresh/tab close
- Intercept Back button click (line ~1209): if dirty, show `ConfirmModal` ("You have unsaved changes. Leave without saving?") before navigating
- Cancel button: same dirty check + confirm before discarding
- Remove `beforeunload` listener when edit mode exits or changes are saved

## Save Button Enhancement

**File:** `client/src/index.css`

- Add `box-shadow: 0 -4px 12px rgba(0,0,0,0.1)` to `.sticky-save-bar`
- Save button: amber/gold accent color, slightly larger font and padding for contrast
- Keep existing sticky positioning

## Files Modified

| File | Change |
|---|---|
| `server/db/schema.sql` | Add `adjustments` JSONB + `total_price_override` columns |
| `server/utils/pricingEngine.js` | Accept + apply adjustments and override |
| `server/routes/proposals.js` | Accept adjustments in calculate + PATCH endpoints |
| `client/src/pages/admin/ProposalDetail.js` | Multi-bar, adjustments UI, override, unsaved guard |
| `client/src/pages/admin/ProposalCreate.js` | Multi-bar number picker |
| `client/src/components/PricingBreakdown.js` | Negative amount styling |
| `client/src/pages/proposal/ProposalView.js` | Render visible adjustments |
| `client/src/index.css` | Save bar shadow + button color |

## Verification

1. `npm run dev` — start both servers
2. Admin edit: open any proposal, enter edit mode
   - Bar count is a number input (0-5), not yes/no
   - Add a discount with label and amount — pricing preview updates, total decreases
   - Add a surcharge — total increases
   - Toggle visibility on/off for an adjustment
   - Enable total override — total snaps to override value
   - Save — all adjustments persist on reload
3. Admin edit: make a change, click Back without saving — confirm modal appears
4. Admin edit: make a change, refresh browser — browser warns about unsaved changes
5. Admin create: bar count is number picker, no adjustments section
6. Client proposal view: visible adjustments appear as line items, hidden ones don't, total reflects all adjustments
7. Payment integrity: after discount, `total_price` in DB matches, balance = total - amount_paid
