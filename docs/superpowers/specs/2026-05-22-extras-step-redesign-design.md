# Extras Step Redesign (Quote Wizard)

Design spec. Date: 2026-05-22. Branch: `extras-redesign`. Status: approved, ready for implementation planning.

Reference mockup at `C:\Users\dalla\Downloads\Dr Bartender Marketing (4)\`: `extras-explorations.html` for the inline `ex-*` CSS, `apothecary/PageExtras.jsx` for component structure, `styles/redesign.css` for the `drb-*` base classes.

## Goal

Reskin the public Quote Wizard's Extras step to the apothecary "Lab Add-Ons" design. All functionality and business rules are preserved. This is a presentation restructure, not a logic change.

## Scope

In scope:
- The content rendered inside the Extras step card: `client/src/pages/website/quoteWizard/steps/ExtrasStep.js` and new helper components under `steps/extras/`.
- New `wz-*` CSS in `client/src/index.css`.
- A small additive change to `client/src/data/addonCategories.js` (new display fields).

Out of scope:
- Wizard chrome: the shared page hero, the stepper, the pricing sidebar, and the Back/Continue nav. All live in `QuoteWizard.js`, are already apothecary-styled, and are shared across all five steps.
- The mockup's per-step hero ("The Lab Add-Ons."). The shared hero ("The Instant Quote.") stays as is.
- Pricing logic, bundle rules, server endpoints.
- The inline syrup flavor picker (intentionally removed, see Decisions).
- Auto-selecting or pre-checking any bundle (intentionally not done, see Decisions).

## Styling baseline

Production `index.css` `:root` already carries the apothecary tokens the mockup uses (`--amber` teal `#1D8C89`, `--brass`, `--chalkboard`, `--paper`, `--deep-brown`, `--warm-brown`, `--text-muted`, and the `--font-display` / `--font-body` IM Fell families). No palette translation is needed. The mockup's `ex-*` classes are reimplemented as `wz-*` classes in `index.css`, beside the existing `wz-addon-*` block. The mockup's `drb-*` classes map to production's existing un-prefixed equivalents (`divider-ornate`, `kicker`, `btn`, `wz-card`).

## Architecture

Files:
- `steps/ExtrasStep.js`: orchestrator. Renders the three zones, splits `groupedAddons` into bundles vs a-la-carte, wires props. Stays at its current path so the `QuoteWizard` import is unchanged.
- `steps/extras/BundlePicker.js`: the bundle band. BYOB path only.
- `steps/extras/AddonAccordion.js`: the collapsible category list. Owns its own open/close state.
- `steps/extras/AddonTile.js`: one add-on tile, including the Flavor Blaster locked variant and the quantity stepper.
- `data/addonCategories.js`: add `blurb` and `glyph` fields to each `ADDON_CATEGORIES` entry. Existing `label` and `icon` fields are left unchanged so the admin side (which also reads `ADDON_CATEGORIES`) is untouched.
- `index.css`: new `wz-*` CSS block.

Logic files left unchanged: `proposalRules.js`, `bundleConfig.js`, `helpers.js`. `QuoteWizard.js` changes are limited to passing the current step's roman numeral and dropping now-unused props.

## Zone 1: Step chrome

- Eyebrow, small caps: "Step {roman} . Apothecary Add-Ons". The roman numeral is dynamic. Extras is step index 2 (Step III) on the BYOB and mocktail paths, index 3 (Step IV) on the hosted path. `QuoteWizard` already has `step` and a `ROMANS` array; it passes the resolved numeral to `ExtrasStep` as a new prop.
- Title row: an h2 "Customize your experience." with an inline pill button "Skip this step" on the right. The pill calls the existing `onSkipExtras` handler (the lossless skip, which advances without clearing `addon_ids`).
- Reassurance band: a callout with a brass left border. Copy: "Every choice is optional, and nothing here is final. You can swap, add, or remove anything later, even after you book, during your Potion Planning consult."

## Zone 2: Bundle band (BYOB only)

- Renders only when BYOB bundle add-ons are present in the visible set. The hosted and mocktail paths have no bundles, so the band is absent there.
- The three BYOB bundles (`BYOB_BUNDLE_SLUGS`: `the-foundation`, `the-formula`, `the-full-compound`, in that order) are pulled out of the a-la-carte category list and rendered as three cards inside a bordered "BUNDLES" band.
- Band header: a kicker "Lab notes . Where most BYOB events start" and a line "Pick a starter recipe." On the right: when no bundle is selected, an italic hint "Or skip and go a la carte"; when a bundle is selected, a "Skip the bundle" link button that toggles the selected bundle off.
- Each bundle card shows: name, tagline (`ADDON_TAGLINES[slug]`), a glyph, a dotted-rule list of included items (`BUNDLE_INCLUDED[slug]` resolved to add-on names from the loaded `addons`), and a foot row with the price.
- A "Most picked" ribbon sits on The Foundation. This is hardcoded to the `the-foundation` slug. There is no popular flag in the add-on data.
- No bundle is pre-selected. The step loads with nothing checked.
- Selecting a card calls `toggleAddon(bundleId)`. The existing rules engine handles the bundle mutex and the included/unavailable cascade. No new selection logic.
- Card visual states: selected (amber border, teal tint, check mark) and default.

## Zone 3: A la carte

- An "a la carte" ornate divider (reusing the existing `divider-ornate` class) followed by a lede line: "Add anything else your event needs, beyond what your bundle covers."
- A category accordion. Categories are `groupedAddons` (already built by `QuoteWizard` from `ADDON_CATEGORIES` intersected with `filterAddons`), minus the three bundles, which are hoisted to the band. Empty categories are not rendered.
- Each collapsed accordion row shows: a glyph chip, the category label, an italic blurb, a count pill, and a chevron. The count pill reads "{n} added" when the category has selections, otherwise "{n} options".
- The first category is open by default; the rest are collapsed. Accordion open/close state is local to `AddonAccordion` and resets when the step remounts. This is acceptable.
- An open row reveals a two-column responsive grid of `AddonTile`s.

## AddonTile

One tile per add-on. Receives the add-on record, its selected / included / unavailable state, the toggle handler, and quantity state.

- Layout: a 44px icon chip (`ADDON_ICONS[slug]` emoji), the name, a price or status pill, the tagline (`ADDON_TAGLINES[slug]`), an expandable description, and a quantity row.
- Price label: reuse the current `ExtrasStep` price logic (the `billing_type` switch). Included add-ons show an "Included" pill; unavailable add-ons show a "Covered" pill.
- Description: collapsible, toggled by an info chevron, showing `addon.description`. Expand state is local to the tile.
- Quantity stepper: shown when `isQuantityCapable(addon)` is true (barback, banquet-server, additional-bartender, pre-batched-mocktail) and the add-on is selected. It reads and writes `form.addon_quantities` through `setForm`, clamped 1 to 10.
- States: selected, included (locked on, dimmed, brass check pill), unavailable (dashed, grayed, tagline replaced with "Your bundle supersedes this"). Dependent add-ons such as the champagne coupe upgrade only appear once their parent is selected; `filterAddons` already handles that visibility, so no special tile handling is needed.
- Handcrafted syrups: a plain tile. No inline picker. The description copy comes from the add-on record. `form.syrup_selections` is no longer written by the wizard.
- Flavor Blaster locked variant: when the slug is `flavor-blaster-rental` and the glassware requirement is unmet (`glasswareRequirementMet` is false), the tile renders a locked state. It shows a message that proper glassware is required, plus unlock actions: an "Add Real Glassware" button (shown when `guestCount <= 100` and `realGlasswareAddon` exists) that calls `toggleAddon(realGlasswareAddon.id)`, and an "I'll provide my own" button that sets `client_provides_glassware` to true. This is the current behavior, re-skinned into the tile design.

## Data flow

- `QuoteWizard` continues to own `form`, `addons`, `toggleAddon`, `groupedAddons`, the glassware guardrail values, and `skipExtras`. The props passed to `ExtrasStep` are essentially today's set, plus the resolved step roman numeral.
- `ExtrasStep` splits `groupedAddons`: add-ons whose slug is in `BYOB_BUNDLE_SLUGS` go to `BundlePicker`; the remainder feeds `AddonAccordion`.
- All toggles route through `toggleAddon`, which calls `toggleAddonWithRules`. The server `calculate` preview, which consumes `addon_ids` and `addon_quantities`, is unaffected.
- The `expandedAddons` and `toggleExpand` props become unused once tile expand state is local; they are removed from the `ExtrasStep` call site in `QuoteWizard`.

## Decisions

- Syrup picker removed: the inline `SyrupPicker` is dropped on purpose. Flavors are chosen later at the Potion Planning consult. The syrups add-on becomes a plain toggle tile.
- No auto-check: no bundle is pre-selected when the step loads. This keeps the live estimate honest from the first render, avoids a pre-checked paid line item on a money flow, and avoids fiddly apply-once and resume-guard state in `QuoteWizard`. The featured bundle band plus the "Most picked" badge are the nudge.
- "Most picked" on The Foundation, not The Formula: The Foundation is the genuine common floor for a BYOB bar and it sidesteps "what mixers do I get" confusion.
- Flavor Blaster lock preserved: re-skinned into the new tile language rather than dropped.
- Shared hero kept: the wizard hero stays shared across steps; the mockup's per-step hero is not adopted.

## Error and empty states

- A package with no add-ons keeps the existing "No add-ons available" message.
- Hosted and mocktail paths render no bundle band, only the accordion.
- Wizard data loading and error states are handled by `QuoteWizard` and are unchanged.

## Verification

- Manual walkthrough of all three paths: BYOB (band shows, three cards, pick and skip, included/unavailable cascade visible on a-la-carte tiles), hosted (no band), mocktail (no band).
- Flavor Blaster locked tile, with and without glassware, exercising both unlock buttons.
- Quantity steppers on barback, banquet server, additional bartender, pre-batched mocktail.
- The "Skip this step" pill advances without clearing selections.
- The live estimate sidebar updates as tiles toggle.
- `CI=true react-scripts build` runs clean (the client lint gate).
- Existing tests, including `proposalRules.test.js`, remain green; no rule logic changes.
