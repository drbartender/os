# Design prompt: Quantity Review (admin, shopping-list approval upgrade)

> Per-surface prompt for a repo-linked claude.ai/design session. Executes `docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md` §4.4 and §6.4.
>
> Design-system project: **Dr. Bartender OS Design System** (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). Both skins must render.
>
> Owner context, verbatim decisions: recipes carry amounts but "we set the pars higher to account for we don't want to run out, and we can return leftovers"; he wants bottle math but "I will want some say on where it lands"; within a category the split across drinks is explicitly agnostic ("we can never know if the mojito will be more popular than the vodka lemonade"). He has also said of the current surface: "I haven't been happy with what we have, but let's not mess with anything we don't have to."

## The one-sentence brief

The existing shopping-list approval gains instruments: the demand math shows its work, buffers are visible owner-owned knobs, and every quantity is editable before the approve click that (unchanged) publishes the list and closes the Enhancement Lab window.

## Grounding (current implementation)

- `client/src/components/ShoppingList/ShoppingListModal.jsx` (713 lines): the review/approve surface, opened from `ShoppingListButton` on `client/src/pages/admin/DrinkPlanDetail.js:203` and the event card. Siblings: `ConsultationForm.jsx` (431, the admin consult path), `NeedsRecipeSection.jsx` (client free-text drinks awaiting recipes, wired to the Add-recipe drawer), `ShoppingListPDF.jsx`.
- Lifecycle (engineering law, untouched): generated server-side on submit, staged `pending_review`, strict no-overwrite, admin approves, client sees it at `/shopping-list/:token`. Approval is the gate that closes the Enhancement Lab window.
- Quantity engine inputs (new, from the spec): expected pours = drinkers (crowd question) x hours x pace constant; category split gently nudged by the guest-profile answer; even split within category; per-role buffer multipliers; round up to purchasable units.

## What to design

1. **The derivation, visible**: a compact "how we got here" strip per category: "60 drinkers x 4h x pace ≈ 240 pours → 55% cocktails ≈ 132 → 6.9L tequila → **5 x 1.75L** (buffer x1.25)". Expandable, not shouting; the owner reads it in seconds, trusts it, overrides when he knows better.
2. **Buffer knobs**: global per-role defaults (spirits / mixers / garnish / supplies) live in settings; this screen shows the applied buffer per line with a per-event override. Overrides are visually distinct from computed values.
3. **Editable quantities**: every line editable inline (the modal already allows edits; keep the interaction, improve the legibility). Edited lines keep an "admin-set" marker so a regenerate never silently clobbers judgment (engineering guard exists; design the state).
4. **Client-render preview**: a toggle showing exactly what the client will see, including the padding sentence ("Quantities are rounded up so you never run out. Unopened bottles can be returned.") and plain-language quantity lines ("3 x 1.75L bottles, about 90 margaritas worth").
5. **The approve moment**: unchanged semantics, clearer consequence line: approving publishes the list to the client and closes the Enhancement Lab window.

## What must not change (hard)

1. Lifecycle, no-overwrite semantics, approve gate, the `/shopping-list/:token` client page contract, PDF export.
2. The NeedsRecipeSection flow to the Add-recipe drawer (it is how the recipe database grows organically; do not bury it).
3. Per the owner: minimal disruption. This is an upgrade of the existing modal (or its natural successor at the same mount points), not a new subsystem. If the modal's 713 lines need splitting, split by section per repo file-size law.
4. Vanilla CSS, adminos patterns, both skins, no new deps.

## Definition of done

- Both skins. States: fresh pending_review with derivation, admin-overridden lines, needsRecipe items present, regenerated-after-edit (markers held), approved/read-only.
- The derivation strip verified against a hand-computed example in the mock data.
- Approve flow reads clearly enough that the Enhancement-Lab-window consequence cannot be missed.
