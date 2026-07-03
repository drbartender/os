# Design prompt: Cocktail Menu screen becomes the Bar Program surface (`/cocktail-menu`)

> Per-surface prompt for a repo-linked design session. Read `DR_BARTENDER_REDESIGN_BRIEF.md` first and obey its §2 hard rules. UNLIKE the pure-reskin prompts, this session is also a WHAT-SHOULD-THIS-SURFACE-BE exploration: it adds two new tabs (Recipes, Pars) that do not exist yet. Their data endpoints do not exist either; design them against MOCK data matching the contracts below, and the Claude Code session wires them to real endpoints afterward. The existing Menu tab keeps its real fetches and logic untouched (restyle only).

## Why this surface is growing

The shopping-list generator currently runs on hardcoded tables in code (`PARS_100`, `SPIRIT_PARS`, and an 18-key `INGREDIENT_MAP` in `server/utils/shoppingList.js`, mirrored in `client/src/components/ShoppingList/generateShoppingList.js`). The operator's real-world pain, in his words: pars are not quite right so items get removed from every generated list; quantities are usually right; signature-drink ingredients usually have to be added by hand. The fix is making this screen the single home of the bar program: the menu (exists), a structured recipe per drink (new), and the editable par table (new). None of the 24 active cocktails currently has a recipe (`cocktails.ingredients` JSONB exists and is empty everywhere).

## The file(s)

- `client/src/pages/admin/CocktailMenuDashboard.js` — 932 lines already, so the two new tabs MUST be new sibling component files (e.g. `client/src/pages/admin/cocktailMenu/RecipesTab.js`, `PantryParsTab.js` — naming yours), not additions to this file. Restyle the existing file in place.
- Current structure to preserve functionally: a drink-type switcher (`cocktails` / others), sub-tabs `drinks` / `categories`, `DrinkTable` and `CategoryTable` with inline row editing and drag-to-reorder. The operator LIKES the editing ergonomics; keep inline-edit-in-table as the interaction family unless you find something clearly better in the same spirit.
- Vanilla CSS in `client/src/index.css` (new class namespace for new tabs), no Tailwind, no new deps. Both skins (apothecary default + After Hours) must hold; use tokens, never raw hex.

## Data contracts (structure is LAW, presentation is yours)

These shapes are what the shopping-list generator will consume. The design may arrange, group, and label freely, but every recipe row and par row must carry exactly these fields, structured, never free text:

**Recipe row** (per cocktail, 1..n rows):
- `ingredient` (display name, e.g. "Aperol")
- `amount` (numeric, per ONE serving) + `unit` (oz | dash | each | splash — small closed set, pick and show it)
- `purchasable`: `item` (what you actually buy, e.g. "Aperol"), `size` (string, e.g. "750mL", "12 pack", "64oz"), `section` (`liquorBeerWine` | `everythingElse`)
- Optional `note` (e.g. "garnish only")

**Par row** (the baseline stock table, replaces `PARS_100`):
- `item` (e.g. "Tito's Vodka"), `size` (string), `qty` (numeric, AT 100 GUESTS — the generator scales by guest count; the UI must say this loudly or nobody will trust the numbers), `section` (same two sections)
- Rows are orderable; the printed shopping list follows this order.

Mock 24 drinks (real names live in the repo's cocktail seed) with 3-6 recipe rows each, and mock the par table from the real `PARS_100` values in `server/utils/shoppingList.js:75-115` so the design reviews against true content density.

## What must not change (hard)

1. The Menu tab's existing behavior: category/drink CRUD, activation toggles, drag-reorder, inline editing. Restyle only.
2. No em dashes anywhere in copy.
3. Admin-only surface; no client-facing anything.
4. Do not build or fake generator logic; the tabs EDIT data, the generator consumes it later.
5. New-tab code renders from mock modules clearly marked `// MOCK — replaced by API wiring`; no invented axios calls.

## Design opportunities (where to spend the effort)

- The screen is becoming the "formulary": the apothecary metaphor's natural home. Menu = the published catalog, Recipes = the formulas, Pars = the dispensary stock ledger. Lean in.
- Recipe editing across 24 drinks is the hard UX problem: browsing density vs per-drink focus (master-detail? expandable rows? drawer?). The operator will seed all 24 in one sitting (drafts will be pre-filled for review), so a fast review-and-correct flow matters more than a from-blank composer.
- The par table is a quartermaster's list: two sections, ~35 rows, numbers that want tabular alignment and fast inline correction. The "at 100 guests" scaling rule needs a permanent, elegant explanation on-surface.
- Cross-links worth exploring: a recipe row's `purchasable` and a par row are the same vocabulary; consider whether the design should make that visible (e.g. "used by 6 recipes" on a par row) or keep the tabs independent for v1.
- One restrained magical-realism moment maximum, per the brief.

## Open questions the design should take a position on

1. Should pars vary by service mode (full bar vs consult/spirit-driven)? Today `SPIRIT_PARS` is a separate hardcoded table; one editable table with a mode column vs two tabs vs v1-ignores-it are all acceptable answers.
2. Where does a signature/custom cocktail's ad-hoc recipe get entered, if anywhere on this screen (vs staying a per-event concern elsewhere)? V1 may explicitly punt; say so if so.
3. Does the drink-type switcher (cocktails vs other drink types) constrain or complicate the new tabs? Recipes/pars are cocktail-and-bar concerns; take a stance on where the tabs sit relative to it.

## Previewing / definition of done

- Mock-data preview is expected; the shipped code must keep the Menu tab's real fetches exactly as they are.
- The Vercel gate is `cd client && CI=true npx react-scripts build` (warnings fail it); the Claude Code session runs it before merge regardless.
- Smoke both skins and both breakpoints on all three tabs; the par table must not cause page-level horizontal scroll on mobile.
