# Design prompt: Recipe Card v2 (admin, Potions → Recipes)

> Per-surface prompt for a repo-linked claude.ai/design session. Executes `docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md` §4.1 and §6.1.
>
> Design-system project: **Dr. Bartender OS Design System** (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). Both skins (After Hours dark / House Lights light) must render.

## The one-sentence brief

The recipe card becomes the drink's **complete dossier**, the single source of truth every surface reads (planner tiers, Enhancement Lab, shopping list, coverage engine), and the editor the owner will use for the one-time recipe pass (~40 drafts plus new fill recipes), so batch-entry speed is a first-class requirement.

## Grounding (current implementation)

- `client/src/components/potions/RecipeEditor.js` (414 lines): the existing editor, mounted in TWO places that must both survive: `client/src/pages/admin/potions/RecipesTab.js` (117 lines, the Recipes tab drawer) and the shopping-list Add-recipe drawer (merged 2026-07-16, c0495f7, incl. `request_aliases` for matching client free-text).
- `client/src/pages/admin/PotionsPage.js` (63 lines): the tab shell. `PantryParsTab.js` (332): the par_items admin the ingredient picker will lean on.
- Ingredient alias resolution already exists server-side (`server/utils/potionCatalog.js`); unresolved ingredients are Sentry-reported. The editor should surface resolution state, not reinvent it.

## What the card gains (spec law)

1. **Ingredient rows**: par-item picker (alias-aware typeahead against `par_items`), amount, unit (`oz`/`dash`/`each`/`splash`), with **amount optional per row** (missing amount = falls back to par scaling; show that state honestly, e.g. a quiet "par-scaled" tag).
2. **Enhancement assignments**: which enhancements apply to this drink (smoke, bubble, carbonation, craft ginger beer, future rows), each with per-drink pitch copy and, for bubbles, the flavor options. This data migrates in from `client/src/pages/plan/data/drinkUpgrades.js` and `DRINK_SYRUP_MAP`; the editor must display and edit the migrated values.
3. **Linked housemade syrup product** where relevant (one reference, not a matrix).
4. **Flags**: batchable, active, hosted-visible, BYOB menu category (existing), review status (existing `draft`/`reviewed`).
5. **Coverage echo** (read-only, nice-to-have): which hosted packages can make this drink as currently written, recomputed from the package model. One line, links to the makeability preview on the package editor.

## The batch-entry requirement

The owner will sit down once and enter/finish dozens of recipes. Design for that session: keyboard-first row entry, enter-to-add-ingredient, duplicate-from-drink, sticky defaults (unit, last-used par section), a visible queue of drafts remaining, and save-and-next. If the pass takes an evening instead of a week, this screen paid for itself.

## What must not change (hard)

1. Both mounts (Recipes tab + shopping-list Add-recipe drawer) keep working; the drawer flow for entering a recipe mid-shopping-list-review stays fast.
2. Alias/request-alias matching semantics are server truth; the editor displays state, never invents matching rules.
3. Vanilla CSS, existing adminos patterns and nav, both skins, no new deps.
4. Per CLAUDE.md file-size discipline: RecipeEditor is at 414 lines; growth should split by section, not balloon the file.

## Definition of done

- Both skins, both mounts, mobile-usable (admin sometimes triages from a phone).
- States: empty new recipe, migrated recipe with enhancements, draft mid-pass, reviewed, a recipe with unresolvable ingredient (shows resolution warning).
- A mock batch session: 5 drafts entered back-to-back without touching the mouse.
