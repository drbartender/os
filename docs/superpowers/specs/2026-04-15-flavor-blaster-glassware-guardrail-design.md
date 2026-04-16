# Flavor Blaster Glassware Guardrail — Quote Wizard

## Context

The Potion Planning Lab already enforces that selecting the Flavor Blaster (Smoke Bubble) add-on requires glassware — either our real glassware upgrade or the client providing their own. The Quote Wizard on the public website has no such guardrail: a client can select Flavor Blaster without any glassware, which creates issues since aromatic bubbles require proper glassware to form correctly. This spec adds the same guardrail to the Quote Wizard.

## Design Decisions

- **Approach**: Inline special-case in the addon rendering loop (matches existing patterns for syrups, quantity controls, bundles). No new components or abstractions.
- **UX model**: Locked tile with inline unlock buttons. No scrolling/jumping — clicking "Add Real Glassware" auto-checks the real-glassware tile in the same category above. Clicking "I'll provide my own" sets a form flag and unlocks immediately.
- **100+ guests**: Real Glassware is hidden for 100+ guests (existing behavior). Flavor Blaster shows locked with only "I'll provide my own" button.

## Files Modified

| File | Change |
|------|--------|
| `client/src/pages/website/QuoteWizard.js` | Form state, locked tile rendering, auto-deselect useEffect, review step note, submission payload |
| `server/routes/proposals.js` | Accept `client_provides_glassware` in `/public/submit`, write to `admin_notes` |
| `client/src/index.css` | `.wz-addon-option.locked` styles, `.wz-addon-locked-message`, `.wz-addon-unlock-actions` |

## Specification

### 1. State & Data Flow

Add `client_provides_glassware: false` to `defaultForm` in QuoteWizard.

Glassware requirement satisfied when either:
- `real-glassware` addon ID is in `form.addon_ids`, OR
- `form.client_provides_glassware === true`

On submission: if `client_provides_glassware` is true, include it in the POST body. Backend appends "Client will provide their own glassware (for Flavor Blaster)" to the proposal's `admin_notes` column.

On the Review step: if `client_provides_glassware` is true, show "Client providing own glassware" as a line item in the Add-ons section.

### 2. Locked Tile Rendering

In the addon rendering loop (~line 964), when `addon.slug === 'flavor-blaster-rental'`:

1. Compute `isFlavorBlasterLocked`:
   - `true` when `real-glassware` is NOT in `addon_ids` AND `client_provides_glassware` is `false`

2. If locked, render:
   - Same `.wz-addon-option` wrapper with `.locked` class added
   - Addon icon and name (no checkbox)
   - Message: "Aromatic finishing bubbles require proper glassware to form and present correctly. This enhancement is available with our real glassware upgrade."
   - **Under 100 guests**: Two buttons:
     - "Add Real Glassware" (primary style) — calls `toggleAddon(realGlasswareId)` to auto-check the tile above
     - "I'll provide my own" (secondary/text style) — sets `client_provides_glassware: true`
   - **100+ guests**: One button:
     - "I'll provide my own" (primary style)

3. If unlocked, render as normal addon tile (existing code, no changes).

### 3. Auto-Deselection & Edge Cases

**Auto-deselect useEffect**: Watches `form.addon_ids` and `form.client_provides_glassware`. If `flavor-blaster-rental` is selected but glassware requirement is not satisfied, remove it from `addon_ids`.

**client_provides_glassware persistence**: The flag stays set even if Flavor Blaster is unchecked. It represents a venue fact, not a Flavor Blaster dependency. Re-selecting Flavor Blaster later finds it already unlocked.

**Draft persistence**: Adding `client_provides_glassware` to `defaultForm` means it's automatically included in the existing localStorage draft serialization.

**Guest count changes**: If guest count changes from <100 to 100+:
- `real-glassware` gets filtered out (existing behavior)
- Auto-deselect useEffect fires, removing Flavor Blaster from selections (unless `client_provides_glassware` is true)
- Flavor Blaster tile shows 100+ locked state with only "I'll provide my own"

### 4. CSS

All styles in `client/src/index.css` alongside existing `.wz-addon-*` rules:

- `.wz-addon-option.locked` — opacity: 0.7, no pointer cursor on main row, dashed border or muted background
- `.wz-addon-locked-message` — styled like `.wz-addon-tagline`, allows wrapping for the longer message text
- `.wz-addon-unlock-actions` — flex row with gap, buttons use existing `.btn` / `.btn-secondary` styles at smaller scale

### 5. Backend

In `server/routes/proposals.js` at the `/public/submit` handler (~line 371):
- Destructure `client_provides_glassware` from `req.body`
- The existing INSERT into `proposals` does not include `admin_notes`. Add `admin_notes` to the INSERT column list and values, set to `"Client will provide their own glassware (for Flavor Blaster)"` when `client_provides_glassware` is truthy, otherwise `null`

## Verification

1. Start dev server (`npm run dev`)
2. Open Quote Wizard, select a hosted package, reach the Addons step
3. Confirm Flavor Blaster appears locked with message and two buttons (under 100 guests)
4. Click "Add Real Glassware" — confirm real-glassware tile above auto-checks, Flavor Blaster unlocks
5. Uncheck real-glassware — confirm Flavor Blaster auto-deselects and re-locks
6. Click "I'll provide my own" — confirm Flavor Blaster unlocks, no visual change near real-glassware tile
7. Set guest count to 100+ — confirm only "I'll provide my own" button appears in locked state
8. Complete and submit a quote with `client_provides_glassware` — confirm `admin_notes` populated on the proposal in admin view
9. Check Review step shows "Client providing own glassware" line item
10. Verify localStorage draft round-trips the `client_provides_glassware` flag
