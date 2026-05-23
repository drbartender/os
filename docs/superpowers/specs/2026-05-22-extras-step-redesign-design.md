# Extras Step Redesign (Quote Wizard)

Design spec. Date: 2026-05-22. Branch: `extras-redesign`. Status: approved, revised after design-stage review (gemini-spec + consistency-check + code-review). Ready for implementation planning.

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
- Pricing logic, bundle rules, server endpoints, `pricingEngine.js`. No server work.
- A redesigned standalone syrup picker. The existing `SyrupPicker` component is reused as-is inside the new tile (see Decisions). A polished standalone picker is future work for the client portal, which is not yet designed.

## Styling baseline

Production `index.css` `:root` already carries the apothecary tokens the mockup uses (`--amber` teal `#1D8C89`, `--brass`, `--chalkboard`, `--paper`, `--deep-brown`, `--warm-brown`, `--text-muted`, and the `--font-display` / `--font-body` IM Fell families). No palette translation is needed. The mockup's `ex-*` classes are reimplemented as `wz-*` classes in `index.css`, beside the existing `wz-addon-*` block. The mockup's `drb-*` classes map to production's existing un-prefixed equivalents (`divider-ornate`, `kicker`, `btn`, `wz-card`).

## Architecture

Files:
- `steps/ExtrasStep.js`: orchestrator. Renders the three zones, splits add-ons into bundles vs a-la-carte, wires props. Stays at its current path so the `QuoteWizard` import is unchanged.
- `steps/extras/BundlePicker.js`: the bundle band. BYOB path only.
- `steps/extras/AddonAccordion.js`: the collapsible category list. Owns its own open/close state.
- `steps/extras/AddonTile.js`: one add-on tile, including the Flavor Blaster locked variant, the quantity stepper, and the handcrafted-syrups picker branch.
- `data/addonCategories.js`: add `blurb` and `glyph` fields to each `ADDON_CATEGORIES` entry. Existing `label` and `icon` fields are left unchanged.
- `index.css`: new `wz-*` CSS block.

Reused unchanged: `components/SyrupPicker.js` (rendered inside the syrup tile, not redesigned). Logic files unchanged: `proposalRules.js`, `bundleConfig.js`, `pricingEngine.js`. `helpers.js` gains a `priceLabel` helper. `QuoteWizard.js` changes are limited to passing the step roman numeral and the full `addons` list, and dropping the now-unused `expandedAddons` / `toggleExpand` / `update` props from the `ExtrasStep` call site.

## Zone 1: Step chrome

- Eyebrow, small caps: "Step {roman} . Apothecary Add-Ons". The roman numeral is dynamic. Extras is step index 2 (Step III) on the BYOB and mocktail paths, index 3 (Step IV) on the hosted path. `QuoteWizard` already has `step` and a `ROMANS` array; it passes the resolved numeral to `ExtrasStep` as a new prop.
- Title row: an h3 "Customize your experience." with an inline pill button "Skip this step" on the right. The pill calls the existing `onSkipExtras` handler (the lossless skip, which advances without clearing `addon_ids`).
- Reassurance band: a callout with a brass left border. Copy: "Every choice is optional, and nothing here is final. You can swap, add, or remove anything later, even after you book, during your Potion Planning consult."

## Zone 2: Bundle band (BYOB only)

- Renders only when BYOB bundle add-ons are present. The hosted and mocktail paths have no bundles, so the band is absent there.
- The three BYOB bundles (`BYOB_BUNDLE_SLUGS`: `the-foundation`, `the-formula`, `the-full-compound`, in that order) are pulled out of the a-la-carte category list and rendered as three cards inside a bordered "BUNDLES" band.
- Band header: a kicker "Lab notes . Where most BYOB events start" and a line "Pick a starter recipe." On the right: when no bundle is selected, an italic hint "Or skip and go a la carte"; when a bundle is selected, a "Skip the bundle" link button that toggles the selected bundle off.
- Each bundle card shows: name, tagline (`ADDON_TAGLINES[slug]`), a glyph, a dotted-rule list of included items (`BUNDLE_INCLUDED[slug]` resolved to add-on names from the full `addons` list), and a foot row with the price.
- A "Most picked" ribbon sits on The Foundation. Hardcoded to the `the-foundation` slug. No popular flag exists in the add-on data.
- No bundle is pre-selected. The step loads with nothing checked.
- Selecting a card calls `toggleAddon(bundleId)`. The existing rules engine handles the bundle mutex and the included/unavailable cascade. No new selection logic.

## Zone 3: A la carte

- An "a la carte" ornate divider (reusing the existing `divider-ornate` class) followed by a lede line: "Add anything else your event needs, beyond what your bundle covers."
- A category accordion. Categories are `groupedAddons` (already built by `QuoteWizard` from `ADDON_CATEGORIES` intersected with `filterAddons`), minus the three bundles, which are hoisted to the band. Empty categories are not rendered.
- Each collapsed accordion row shows: a glyph chip, the category label, an italic blurb, a count pill, and a chevron. The count pill reads "{n} added" when the category has selections, otherwise "{n} options".
- The first category is open by default; the rest are collapsed. Accordion open/close state is local to `AddonAccordion` and resets when the step remounts. This is acceptable.
- An open row reveals a two-column responsive grid of `AddonTile`s.

## AddonTile

One tile per add-on. Receives the add-on record, its selected / included / unavailable state, the toggle handler, quantity state, and `syrup_selections`.

- Layout: a 44px icon chip (`ADDON_ICONS[slug]` emoji), the name, a price or status pill, the tagline (`ADDON_TAGLINES[slug]`), an expandable description, and a quantity row.
- Price label: `priceLabel` from `helpers.js`. Included add-ons show an "Included" pill; unavailable add-ons show a "Covered" pill. The `handcrafted-syrups` tile shows the "$30/bottle . 3 for $75" label (a per-slug case in `priceLabel`), matching the current step.
- Description: collapsible, toggled by an info chevron, showing `addon.description`. Expand state is local to the tile.
- Quantity stepper: shown when `isQuantityCapable(addon)` is true (barback, banquet-server, additional-bartender, pre-batched-mocktail) and the add-on is selected. Reads and writes `form.addon_quantities` through `setForm`, clamped 1 to 10.
- States: selected, included (locked on, dimmed, brass check pill), unavailable (dashed, grayed, tagline replaced with "Your bundle supersedes this"). Dependent add-ons such as the champagne coupe upgrade only appear once their parent is selected; `filterAddons` already handles that visibility.
- Flavor Blaster locked variant: when the slug is `flavor-blaster-rental` and `glasswareRequirementMet` is false, the tile renders a locked state with a message that proper glassware is required, plus unlock actions: an "Add Real Glassware" button (shown when `guestCount <= 100` and `realGlasswareAddon` exists) that calls `toggleAddon(realGlasswareAddon.id)`, and an "I'll provide my own" button that sets `client_provides_glassware` to true. This is the current behavior, re-skinned.
- Handcrafted syrups branch: the `handcrafted-syrups` tile is a normal toggle tile, and when it is selected it also renders the existing `SyrupPicker` component (compact mode) inside the tile, plus a note that flavors can be picked now or chosen later at the consult. The picker writes `form.syrup_selections` through `setForm`, exactly as the current step does. Syrup pricing, `calculateSyrupCost`, and the 3-for-$75 tiering are untouched. Clicks inside the syrup section stop propagation so they do not toggle the tile.

## Data flow

- `QuoteWizard` continues to own `form`, `addons`, `toggleAddon`, `groupedAddons`, the glassware guardrail values, and `skipExtras`. It passes `ExtrasStep` the current set of props plus the full `addons` list (for bundle-name resolution) and the resolved step roman numeral.
- `ExtrasStep` splits `groupedAddons`: add-ons whose slug is in `BYOB_BUNDLE_SLUGS` go to `BundlePicker`; the remainder feeds `AddonAccordion`. It builds a slug-to-name map from the full `addons` list for `BundlePicker`.
- All add-on toggles route through `toggleAddon` / `toggleAddonWithRules`. The syrup picker writes `form.syrup_selections`. The server `calculate` and `submit` payloads, which consume `addon_ids`, `addon_quantities`, and `syrup_selections`, are unchanged.
- The `expandedAddons` / `toggleExpand` props are removed once tile expand state is local; `update` is removed since the syrup picker writes through `setForm`. All three are dropped from the `ExtrasStep` call site in `QuoteWizard`.

## Decisions

- Syrup picker kept. The existing inline `SyrupPicker` stays in the Extras step, reused as-is and restyled only by being placed inside the new add-on tile. All syrup rules and pricing are unchanged. A polished standalone picker is future work for the client portal (not yet designed); this redesign does not touch it. Tile copy is aligned to "pick flavors now, or at the consult."
- No auto-check: no bundle is pre-selected when the step loads. Keeps the live estimate honest from the first render and avoids a pre-checked paid line item on a money flow. The featured bundle band plus the "Most picked" badge are the nudge.
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
- Handcrafted Syrups: selecting the tile reveals the in-tile `SyrupPicker`; picked flavors persist in `syrup_selections` and the syrup cost appears in the live estimate, matching current behavior.
- Quantity steppers on barback, banquet server, additional bartender, pre-batched mocktail.
- The "Skip this step" pill advances without clearing selections.
- The live estimate sidebar updates as tiles toggle.
- `CI=true react-scripts build` runs clean (the client lint gate).
- Existing tests, including `proposalRules.test.js`, remain green; no rule logic changes.
