# Potions: custom-drink recipe flow from the shopping list (design)

Date: 2026-07-16
Status: approved in brainstorm (section-by-section)
Related: `docs/superpowers/specs/2026-07-09-potions-bar-program-design.md` (parent build)

## Problem

When a client free-types a custom drink in the potion planner, the admin is asked to
create a recipe for it from the shopping list. The current flow is a one-way trip with
three holes:

1. The "Add recipe" button creates the off-menu draft with the client's raw text as the
   drink name, and the name is not editable anywhere in the recipe editor.
2. The flow navigates away to `/potions?tab=recipes&drink=<id>`, abandoning the shopping
   list modal. There is no way back; modal state (including a pending debounced edit) is
   lost.
3. After the recipe is authored, nothing folds the drink back into the shopping list. The
   drink should appear on the Signature Cocktails line and its ingredients should be
   merged into the list. Worse: if the recipe uses an ingredient with no par-catalog
   match, the generator silently drops it (`server/utils/shoppingList.js:264-267`
   pushes to `unresolved` and `continue`s, so no line item is ever created). The only
   trace is a Sentry `unresolved_ingredient` warning. The bar ships without the bottle.

## Current behavior (verified 2026-07-16)

- Client custom text lands in `plan.selections.customCocktails` (strings).
- Generation calls `matchCustomNames` (`server/utils/shoppingListGen.js:109`):
  normalized-EXACT match of the client string against every drink that has a recipe,
  both tables, including off-menu (`loadRecipeCandidates`, UNION ALL, requires non-empty
  `ingredients`). Hits fold into `signatureCocktails` (drives both
  `signatureCocktailNames` and ingredient merge). Misses surface as `needsRecipe`.
- `ShoppingListModal.jsx` renders `needsRecipe` with an "Add recipe" button.
  `handleAddRecipe` (line 270) POSTs `/cocktails` `{ name, is_active: false }` then
  navigates to the Recipes tab.
- The modal autosaves list edits on a 1.5s debounce; the effect cleanup
  (`ShoppingListModal.jsx:100`) clears the pending timer without flushing on unmount, so
  the navigate can silently drop the last edit. (`RecipesTab.js` flushes correctly at
  line 169; the modal never got the same treatment.)
- `RecipesTab.js` shows the drink name as a static div (line 274). No rename surface.
- Recipe rows resolve to purchasables through `par_items.ingredient_aliases` only
  (`buildAliasIndex` indexes aliases, never `par.item`); the red "No match" chip's only
  affordance is `goToPars`, a jump to another tab.
- The regenerate endpoint already returns `_unresolvedIngredients` on the list object
  (`server/routes/drinkPlans/regenerate.js:74`, built at `shoppingList.js:519`); no
  client code reads it.
- `PUT /:id/shopping-list` (`drinkPlans.js:506`) stores the blob wholesale
  (`JSON.stringify(shopping_list)`), no field stripping.
- `matchCustomNames` matches on drink NAME only, so renaming a drink breaks the match to
  the client's stored request string and resurrects the `needsRecipe` entry.
- Verified in DB (83 par rows): `role` determines `section` with zero exceptions
  (spirit/beer/wine → liquorBeerWine; mixer/garnish/supplies → everythingElse).
- Public GETs use explicit column lists (`PUBLIC_COCKTAIL_COLUMNS`,
  `PUBLIC_MOCKTAIL_COLUMNS`); admin GETs use `c.*` / `m.*`.

## Approved design

### 1. `request_aliases` on drinks (rename-safe matching)

New column on BOTH drink tables (idempotent DDL in `server/db/schema.sql`):

```sql
ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}';
ALTER TABLE mocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}';
```

- Seeded at Add-recipe creation: the POST carries `request_aliases: [<client's raw
  string>]`. The client's stored request text is never rewritten.
- `matchCustomNames` gains alias awareness: candidates are indexed by normalized name
  AND each normalized `request_aliases` entry. Names index first and win over aliases
  (two-pass build, first-wins preserved within each pass). Matching stays
  normalized-EXACT with ONE addition (full-fleet finding): match keys strip
  apostrophes before normalizing, because the shared normalizer maps
  punctuation to a space ("jennys" vs "Jenny's" would never match, breaking
  this spec's own cross-plan example). Scoped to the matcher and the client
  reuse-lookup only; slugs and par-alias resolution keep `normalizeName`
  untouched. No other fuzz.
- `loadRecipeCandidates` selects `request_aliases` in both UNION arms AND gains a
  deterministic order: `ORDER BY is_active DESC, created_at ASC, name ASC` (wrap the
  UNION in a subquery selecting those columns). On a normalized-name or alias
  collision (a draft renamed to an existing drink's name; legacy dupes), an active
  menu drink beats an off-menu draft, and the oldest wins among peers, so which
  bottles land on a list is stable and reviewable instead of raw SQL row order
  (review finding: first-wins over unordered rows was nondeterministic).
- Name validation parity (review finding): POST and PUT on BOTH drink routers
  validate `name` whenever it is provided: trimmed non-empty, max 255 chars
  (`name VARCHAR(255)`); violations throw `ValidationError` instead of today's
  silent COALESCE keep-old on empty and raw 22001 -> 500 on overflow.
- `POST /cocktails` and `POST /mocktails` accept an optional `request_aliases` field:
  array, max 20 entries, each trimmed and sliced to 200 chars (matches the planner's
  name cap), empty strings dropped. Admin/manager auth already gates these routes.
- `PUT /:id` does not touch the column, so renames automatically preserve aliases.
- Privacy: `request_aliases` is client-typed free text. It must NOT be added to
  `PUBLIC_COCKTAIL_COLUMNS` / `PUBLIC_MOCKTAIL_COLUMNS`. It reaches admin surfaces only
  (admin GETs use `*`).
- Invariant: with all `request_aliases` empty (every existing row), generator output is
  byte-identical to today.

### 2. Recipe drawer over the shopping list (no navigation)

Extract the recipe editor out of `RecipesTab.js` into a shared component
(`client/src/components/potions/RecipeEditor.js`) and mount it in a drawer on top of
the shopping list modal. "Add recipe" stops navigating.

- **Extraction.** `RecipeEditor` owns: editable rows state, the debounced
  autosave/flush machinery (the existing target-bound `pendingRef` pattern moves with
  it), the ingredient table, the display-only alias resolver, Mark reviewed, and the new
  name editor and inline add-par (below). `RecipesTab` keeps the master list, search,
  cocktails/mocktails seg control, review counts, and data loading, and renders
  `RecipeEditor` in its detail pane. Props: `drink`, `type`
  (`'cocktails' | 'mocktails'`), `pars`, `onDrinkChange(updated)` (parent merges the PUT
  result into its cache), `onParsChange(created)` (parent appends the new par).
- **Editable name.** An input in the editor header, saved through the same debounced
  PUT path (`{ name }` rides the recipe PUT). Gated to off-menu drafts
  (`is_active === false`) in v1: that is exactly the created-from-request case, and it
  keeps accidental live-menu renames off this surface (active drinks keep the static
  name; the Menu tab remains their name editor). Renaming never breaks the client match
  because of the seeded alias (decision 1). Client rules mirror the server (§1): save
  blocked while the name is empty, input capped at 255 chars.
- **Drawer.** In the modal, "Add recipe" POSTs the draft as today (now with
  `request_aliases` seeded), then opens a drawer hosting `RecipeEditor` instead of
  navigating. Par catalog is fetched lazily on first drawer open. The
  `needsRecipe` block, drawer, and add-par form live in a new
  `client/src/components/ShoppingList/NeedsRecipeSection.jsx` so
  `ShoppingListModal.jsx` (671 lines) stays under the 700 soft cap. Reuse the existing
  admin Drawer chrome (as used by `PlansDrawer`). Stacking is a hard requirement, not
  a check: the Drawer chrome is z-index 51 (scrim 50) vs the modal portal's inline
  zIndex 1000, so the Drawer MUST render inside the modal's portal subtree (the
  Drawer component does not portal itself, so mounting the section in the modal JSX
  suffices); a future refactor that portals it to body would paint it UNDER the
  modal. First drawer open shows a "Loading catalog..." state while pars fetch.
- **Reuse before create** (review finding: re-click on a still-visible needsRecipe
  entry after a declined fold-in or abandoned drawer must not mint `<slug>-2`
  duplicates, and a third click must not dead-end on ConflictError). Add recipe first
  matches the requested name (normalized) against the admin drink lists' names AND
  `request_aliases`, both tables, fetched lazily once per modal session alongside the
  par catalog. A hit opens the drawer on the existing drink (with its real type;
  name stays read-only if it is an active drink). Only a true miss POSTs the off-menu
  draft (create-on-miss keeps the status quo semantics). This also prevents two plans
  seeding the same client string onto two different drafts. An abandoned empty draft
  is inert (candidates require non-empty `ingredients`) and shows as "Empty" in the
  Recipes tab, which serves as a to-do. Accepted corner (full-fleet finding):
  when the reuse lookup matches by NAME (a drink that never carried the client
  string as an alias), a drawer rename CAN break the match, resurfacing the
  needsRecipe entry; the failure is admin-visible and the proper fix (an
  alias-append on reuse) is on the fix-list backlog.
- **Fold-in on close.** On drawer close, if the recipe now has at least one ingredient
  row (after flush), prompt with the established regenerate confirm (REGEN_CONFIRM
  semantics: regeneration replaces manual edits and returns an approved list to review).
  On confirm, call the modal's existing `regenerate()`; the server recomputes, the drink
  moves out of `needsRecipe` and onto `signatureCocktailNames`, and its resolvable
  ingredients merge into the list. On decline, the list stays stale until the next
  regenerate; the `needsRecipe` entry remains visible. If the recipe is still empty,
  close silently. Closing the WHOLE modal (its close affordances stay reachable behind
  the drawer's scrim edge and the drawer intercepts Escape first) with a freshly
  authored recipe skips the fold-in prompt: accepted for v1; the list stays stale and
  the needsRecipe entry visible until the next regenerate, and the reuse-before-create
  rule makes the next Add-recipe click land back on the authored draft.
- The Recipes-tab deep-link flow (`?tab=recipes&drink=<id>`) keeps working; it is simply
  no longer the Add-recipe destination.

### 3. Inline add-par from the "No match" chip

Inside `RecipeEditor`, the red "No match" chip becomes a button that opens a small
inline form instead of jumping to the Pars tab (works in both drawer and Recipes-tab
contexts; a secondary "open Pars tab" link remains where `goToPars` is available).

- Three visible fields: item name, size, role (the six existing roles).
- Derived/defaulted, not shown: `section` derived from role (spirit/beer/wine →
  liquorBeerWine, else everythingElse; matches all 83 existing rows), `qty_per_100: 1`
  (recipe-driven quantities use ceil(guests/25) + reuse boosts, not qty_per_100; it only
  matters for full-bar baseline rows), `in_full_bar: false` (a one-off client item must
  not land on every full-bar list), `spirit_key`/`style_key`/`paired_spirits` null/empty
  (consult and baseline machinery).
- `ingredient_aliases` seeded with the recipe row's ingredient text (server sanitizer
  lowercases and caps at 60 chars; that matches how the resolver normalizes).
  Accepted edge (review finding): ingredient text allows 120 chars, so a 61+ char
  ingredient's seeded alias is truncated and resolves via the display resolver's
  substring fallback rather than exact match; real ingredient names run far shorter.
- Uses the existing `POST /potions/pars` (already validates and slugs; no new server
  surface). On success the parent appends the row to `pars`, the display resolver
  repaints, and the chip flips to the resolved "→ item · size" hint. On slug-collision
  ConflictError, surface the message inline so the admin can rename the item.
- Promotion to the standard bar program (aliases, pairing, full-bar flag, qty tuning)
  stays on the Pars tab, which keeps the full editor.

### 4. Surface `_unresolvedIngredients` in the modal

- The modal renders a warning block (next to the "recipe needed" block, amber styling)
  when `edited._unresolvedIngredients` is non-empty: these drink/ingredient pairs are
  referenced by recipes but missing from the par catalog, and are NOT on the list.
  This catches the silent-wrong-list failure (par renamed or soft-deleted after a recipe
  referenced it) that today only reaches Sentry.
- Strip on save, both sides, ALL underscore-prefixed keys (review finding):
  `_unresolvedIngredients` plus the sibling generation-run fields `_signatureCocktails`
  and `_syrupSelfProvided` (`shoppingList.js:520-521`; verified zero runtime readers of
  the saved copies). The client omits them from BOTH PUT call sites (the debounced
  autosave AND the approve path's synchronous save); the PUT handler deletes every
  `_`-prefixed key before persisting (defense in depth, and it self-heals historical
  blobs saved wholesale since 7/11 on their next save). `needsRecipe` (no underscore)
  stays persisted deliberately; the modal, public page, and PDF render it from the
  saved blob.
- Public GET hygiene (review finding): the server-side auto-gen at plan submit
  (`shoppingListGen.js` `autoGenerateShoppingList`, line 235) persists the whole list,
  underscore keys included, and `GET /t/:token/shopping-list` serves the saved blob
  wholesale. The public GET deletes `_`-prefixed keys from the RESPONSE only (the
  stored blob keeps them so the admin modal's first open still shows the warning);
  client-typed diagnostics never ride public JSON.
- Decay direction, documented: the auto-gen blob shows the warning on first open; any
  admin save strips it, so a reopened modal shows no warning until the next regenerate
  even if the par gap persists. Accepted for v1 (the fold-in flow regenerates
  naturally; Sentry `unresolved_ingredient` stays the backstop).

### 5. Fix the modal autosave flush

The debounce cleanup keeps clearing per re-run, but unmount must FLUSH the pending save
instead of dropping it (the `RecipesTab` target-bound pattern: bind payload at schedule
time, fire on unmount). With the drawer, Add-recipe no longer unmounts the modal, so the
remaining loss window is closing the modal within 1.5s of an edit; still a real leak,
still fixed.

Interaction the flush creates (review finding): any PUT to an APPROVED list reverts it
to `pending_review` server-side, hiding it from the client; an unmount flush does that
after the modal (and its re-approve button) is gone. Decision: flush anyway (an edit is
never silently lost), and when the pre-flush status was approved, fire a toast so the
revert is visible: "List saved and returned to review. Re-approve to publish the update
to the client." Reopening the modal shows the re-armed Re-approve button as usual.

## End-to-end flow (after this change)

1. Client types "Jenny's spicy marg" in the planner. It lands in
   `selections.customCocktails`.
2. Admin generates the shopping list. No recipe matches; the name shows under "Client
   requested: recipe needed".
3. Admin clicks Add recipe. Draft cocktail created off-menu with
   `request_aliases: ["Jenny's spicy marg"]`. Drawer opens over the list.
4. Admin renames it "Spicy Margarita", authors rows. "Blood orange juice" shows No
   match; admin adds it inline (name/size/role), row resolves.
5. Admin closes the drawer, confirms the regenerate prompt. The list now shows Spicy
   Margarita on the Signature Cocktails line, tequila/triple sec merged into existing
   rows, blood orange juice as a new line. `needsRecipe` block is gone.
6. Next client who types "jennys spicy marg" matches automatically via the alias.

## Error handling

- Draft POST failure: existing inline error in the needsRecipe block (unchanged).
- Recipe PUT failure: existing editor toast + error save-state (moves with extraction).
- Par POST failure: inline field errors from `ValidationError`; ConflictError message
  shown inline.
- Regenerate failure on fold-in: existing `regenError` surface in the modal footer.
- Pars fetch failure in drawer: editor renders with empty catalog (every row shows No
  match) plus a retry affordance; recipe authoring is not blocked.

## Testing

Server (`node:test`, shared dev DB, one suite at a time, `node -r dotenv/config`):

- `matchCustomNames`: alias hit, name-beats-alias precedence, normalization
  (case/punctuation), no-fuzz miss still lands in `needsRecipe`.
- Regenerate route test: custom string matches via alias after the drink is renamed
  (the rename-safety property, end to end).
- `POST /cocktails` sanitizes `request_aliases` (cap 20, slice 200, drops empties,
  rejects non-arrays).
- `PUT /:id/shopping-list` strips `_unresolvedIngredients` before persist.
- Parity invariant: existing potionCatalog/generator snapshots stay byte-identical
  (all existing rows have empty `request_aliases`).

Client: `CI=true react-scripts build` (the Vercel CI lint gate). Manual verify on the
event-side path (event → drink plan → shopping list), which is the canonical surface;
proposal-side is preview.

## File-size plan

- `RecipesTab.js` (361) shrinks to master-list shell.
- New `components/potions/RecipeEditor.js` (~250, shared).
- New `components/ShoppingList/NeedsRecipeSection.jsx` (needsRecipe block + drawer +
  add-par form) keeps `ShoppingListModal.jsx` (671) under the 700 soft cap; the modal
  loses the needsRecipe JSX and `handleAddRecipe` and gains a section mount.
- `server/routes/drinkPlans.js` is 779 lines, already over the warn-only 700 soft cap;
  the strip + public-GET hygiene add a handful of lines (hard cap 1000 not in play).
  Expect the pre-commit warning; no split required by this change.

## Docs

- README folder tree: two new component files.
- ARCHITECTURE schema section: `request_aliases` on cocktails/mocktails.

## Non-goals (v1)

- No alias-editing UI (seeded at create only; grep-able in DB if one ever needs fixing).
- No mocktail branch of the Add-recipe flow (planner customs are the cocktails path;
  the mocktails column and POST acceptance exist for symmetry and future use).
- No consult-path changes (its customs flow through `customSigs`, untouched).
- No quantity-policy changes (qty stays ceil(guests/25) + reuse boosts).
- No name editing for active menu drinks from the recipe editor (Menu tab owns that).
- No changes to the public client shopping-list page (it already renders `needsRecipe`
  read-only).

## Rollout

Additive idempotent DDL; JS reads guard with `|| []` (the pg driver returns TEXT[] as a
JS array, null when absent; the SQL default `'{}'` backfills existing rows so NULLs
should not occur, and a string literal `'{}'` fallback would be a wrong-typed iterable).
Deploy order safe (column lands with the same push as the readers; schema.sql applies
on boot). `schema.sql` is a sensitive path, so the lane gets the full review fleet
regardless of size.
