# Potions (Bar Program): build spec

Date: 2026-07-09. Brainstormed and approved section by section with Dallas. Design provenance: `docs/cocktail-menu-design-prompt.md` (committed 2026-07-02) ran in the repo-linked claude.ai/design session; outputs reviewed from `~/win-share/Bar Program.dc.html`, `Bar Program Options.dc.html` (layout 1a chosen), and `barProgramData.js`. This spec supersedes the design's denormalized recipe contract and two-dataset pars model with decisions made in review (sections 2 revised, catalog aliases, custom-drink recipe requirement).

## 1. Problem and goals

The shopping-list generator runs on hardcoded tables (`PARS_100`, `SPIRIT_PARS`, `INGREDIENT_MAP`, `BASIC_MIXERS`, `GARNISHES`, `ALWAYS_INCLUDE`, beer/wine style maps) in `server/utils/shoppingList.js`, mirrored client-side. Operator pain, verbatim diagnosis: pars are not quite right so items get removed from every generated list; quantities are usually right; signature-drink ingredients always need manual adding; the drinks all need recipes. `cocktails.ingredients` JSONB has existed since April and is empty for every row (dev and prod); mocktails cannot store ingredients at all.

Goals:

1. One editable master par catalog whose items are called onto lists only when an event needs them.
2. Structured recipes on every drink, resolving generic ingredients ("vodka") to recommended purchasables ("Tito's Vodka 1.75L") through the catalog.
3. Custom client drink requests require an admin-entered recipe; the recipe catalog grows organically from real requests.
4. One generator (server), mirror law repealed.
5. One sidebar home: Drink Plans + Cocktail Menu merge into a single **Potions** item.
6. Day-one generated output byte-identical to today until Dallas edits data. Proven by test.

Non-goals (explicitly out of scope): the client-facing planner rework (fuzzy typeahead in the custom box, wizard confusion cleanup) is its own follow-on project; per-serving purchase math (quantity policy is unchanged in v1); editable beer/wine style CHOICE behavior beyond what the catalog rows express; any change to the shopping-list editor's editing UX; any change to drink-plan lifecycle/statuses.

## 2. Surface and navigation

Current reality (verified): `/cocktail-menu` and `/drink-menu` redirect to `/settings` (`App.js:551-552`); `CocktailMenuDashboard` (932 lines, ratchet-frozen) renders embedded in `SettingsDashboard` under its `drink-menu` tab; the sidebar has two items, `Drink Plans` (`/drink-plans`, badge `pending_shopping_lists`) and `Cocktail Menu` (`nav.js:19-20`).

Build:

- **New page** `client/src/pages/admin/PotionsPage.js` at `/potions` (lazy import, admin/manager guard, same shell as siblings). Top tabs per design layout 1a: **Menu · Recipes · Pars**, plus a **Client plans** header button opening a Drawer (`components/adminos/Drawer.js`). Tab and drawer state via `useUrlListState` (its `drawer`/`drawerId` passthrough is purpose-built for this); tabs are deep-linkable (`/potions?tab=pars`).
- **Menu tab** renders `<CocktailMenuDashboard embedded />` unchanged, byte for byte. Its internal cocktails/mocktails switcher and drinks/categories sub-tabs are untouched.
- **New sibling files**: `client/src/pages/admin/potions/RecipesTab.js`, `PantryParsTab.js` (name free), `PlansDrawer.js`. Nothing is added to `CocktailMenuDashboard.js` (ratchet: 932 at HEAD, may not grow).
- **SettingsDashboard** drops its `drink-menu` tab (one home, not two).
- **Nav merge** (`nav.js`): the two entries become one `{ id: 'potions', label: 'Potions', icon: 'flask', path: '/potions', badgeKey: 'pending_shopping_lists' }` in the same section position. CommandPalette: one `Potions` entry replaces the two.
- **Redirects** (`App.js`, `<Navigate replace>` precedent at :551): `/cocktail-menu` → `/potions`, `/drink-menu` → `/potions`. `/drink-plans` (index) and `/drink-plans/:id` stay routed and alive per Dallas's call; the index just leaves the sidebar. Deep links from events, proposals, and staff shift pages to `/drink-plans/:id` keep working unchanged.
- **Plans drawer** (design 1a): compact review list, newest first: event label (via `getEventTypeLabel`, never concatenated with client name), client, date, guests, service mode (`serving_type` via `SERVING_LABEL`), resolved drink names, one status chip. Chip logic must handle all five plan statuses including `exploration_saved` (the existing index forgets it). Rows link to `/drink-plans/:id`; footer link "Full index" opens `/drink-plans`.
- Sidebar `isActive` is startsWith-based; visiting kept-alive `/drink-plans` pages simply highlights nothing. Accepted.

## 3. Data model

### 3.1 Recipes (on the drink rows)

- `cocktails.ingredients` JSONB (exists, empty) stores the whole recipe as an ordered array. **Row shape (LAW):**

```json
{ "ingredient": "Vodka", "amount": 1.5, "unit": "oz", "note": "", "override_item_id": null }
```

  `unit` ∈ `oz | dash | each | splash`. `amount` numeric > 0. `note` optional. `override_item_id` optional FK-by-value to a `par_items.id`, used only when a drink demands a specific purchasable (Malibu, not house rum). Rows are ordered; order is presentation order.
- Purchasable identity (item, size, section) is NOT stored per recipe row. It resolves at read/generation time through catalog aliases (3.2). Legacy free-text string arrays already in `ingredients` (none in prod, but defensive) are treated as unresolved free text by the resolver.
- New column on **both** `cocktails` and `mocktails`: `recipe_review VARCHAR(20) NOT NULL DEFAULT 'empty' CHECK (recipe_review IN ('empty','draft','reviewed'))` (inline-CHECK precedent: `drink_plans.status`).
- `mocktails` additionally gains `ingredients JSONB DEFAULT '[]'` (idempotent ADD COLUMN, precedent `schema.sql:417`).
- Review-state transitions: editing any recipe cell of an `empty` drink flips it to `draft` (server-side, same UPDATE); `reviewed` is set only by the explicit Mark-reviewed action; editing a `reviewed` recipe leaves it `reviewed`.

### 3.2 Par catalog (single list, call-on conditions per row)

New table `par_items` (idempotent CREATE, slug PK like `cocktails` so seeds stay idempotent under edits):

```sql
CREATE TABLE IF NOT EXISTS par_items (
  id VARCHAR(100) PRIMARY KEY,            -- slug, e.g. 'titos-vodka'
  item VARCHAR(255) NOT NULL,             -- display + purchase name
  size VARCHAR(50),                       -- '1.75L', '12 pack', 'ea.', 'lbs'
  qty_per_100 NUMERIC NOT NULL,           -- baseline at 100 guests
  section VARCHAR(30) NOT NULL CHECK (section IN ('liquorBeerWine','everythingElse')),
  role VARCHAR(20) NOT NULL CHECK (role IN ('spirit','wine','beer','mixer','garnish','supplies')),
  spirit_key VARCHAR(30),                 -- spirit rows: 'vodka'..'mezcal'
  style_key VARCHAR(50),                  -- beer/wine rows: 'IPA', 'Red', ...
  paired_spirits TEXT[] DEFAULT '{}',     -- mixer/garnish rows: matching-mixer triggers
  ingredient_aliases TEXT[] DEFAULT '{}', -- generic names that resolve here ('vodka')
  in_full_bar BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,   -- soft delete (cocktails precedent)
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Derivations (LAW).** Every legacy constant is a slice of active rows, ordered by `sort_order`:

| Legacy constant | Slice |
|---|---|
| `PARS_100.liquorBeerWine` / `.everythingElse` | `in_full_bar` rows by section |
| `SPIRIT_PARS[k]` | the `role='spirit'` row with `spirit_key = k` |
| `BEER_STYLE_MAP[s]` / `WINE_STYLE_MAP[s]` | `role='beer'/'wine'` rows with `style_key = s` |
| `BASIC_MIXERS` | `role='mixer'` rows |
| `GARNISHES` | `role='garnish'` rows |
| `ALWAYS_INCLUDE` | `role='supplies'` rows |
| `SPIRIT_MIXER_PAIRINGS` | inversion of `paired_spirits` tags |
| `INGREDIENT_MAP` | `ingredient_aliases` (+ item/size/section from the row) |

Seed (in `schema.sql`, `INSERT … ON CONFLICT (id) DO NOTHING`) reproduces today's values exactly, including: scotch and mezcal rows not flagged `in_full_bar` (spirit-driven only, as today); Corona / Yuengling flagged `in_full_bar` with no `style_key` (full-bar only); IPA / White Claw / Craft / Athletic NA rows with `style_key` only; Ginger Beer / Ginger Ale / Lemonade (REAL) / Sour Mix / Raspberry Vodka / Malibu / Island Blue Pucker / Blue Curacao rows carrying their `INGREDIENT_MAP` aliases (several are alias-only rows: not in any baseline, called on only by recipes or free text). `whiskey` and `bourbon` spirit keys both resolve to the Bulleit row via `spirit_key='bourbon'` plus alias handling (one row, two keys: `spirit_key` holds 'bourbon', `ingredient_aliases` include 'whiskey' and 'bourbon'; the consult chip-grid lookup maps whiskey→bourbon in the derivation layer exactly as `SPIRIT_PARS` does today).

**Alias resolution (LAW):** normalize (lowercase, trim, strip punctuation), then exact alias match first, then longest-alias substring fallback (preserves today's free-text consult behavior; retires the ginger-before-gin ordering hack because substring candidates are tried longest first). No fuzzy matching server-side, ever: a silent wrong match puts wrong bottles on a list. Unresolved ingredients surface visibly (Recipes tab chip; consult free text falls through exactly as today when `INGREDIENT_MAP` missed).

## 4. API surface

- **Recipes** ride the existing routers. `PUT /api/cocktails/:id` and `POST /api/cocktails` already round-trip `ingredients`; add structured-row validation (shape above; reject non-array, bad units, non-numeric amounts) and `recipe_review` handling (auto empty→draft on recipe change; explicit `recipe_review: 'reviewed'` accepted only from the Mark-reviewed action). Mirror on the mocktails router (which gains the columns). Auth unchanged (`auth + requireAdminOrManager` on writes).
- **Pars**: new `server/routes/potions.js` mounted at `/api/potions` (`server/index.js`, one line, beside the cocktails mount; separate prefix sidesteps the greedy `/:id` mount-order trap). Endpoints, all admin/manager: `GET /pars` (full active catalog), `POST /pars`, `PUT /pars/:id`, `DELETE /pars/:id` (soft: `is_active = false`), `POST /pars/reorder` (unnest bulk pattern verbatim from `cocktails.js:50-64`, text ids). Validation: role/section enums, qty numeric ≥ 0, slug id server-generated from item name when absent, 23505 → ConflictError.
- **Preview**: `GET /api/potions/preview?guests=175&mode=full_bar|spirit_driven` (admin) runs the pure generator against the live catalog with a synthetic input; feeds the Pars tab "Preview shopping list" button and the Projected column sanity check. Read-only, saves nothing.
- **Plans list enrichment** (additive, existing consumers unaffected): `GET /drink-plans` gains `shopping_list_status` (already on the row), `guest_count` (LEFT JOIN proposals, the join `GET /:id` already uses), and `drink_names` (batched: collect `selections.signatureDrinks` + `selections.mocktails` ids across returned rows, one query per table, map in JS; no N+1).
- **Regenerate**: `POST /drink-plans/:id/shopping-list/regenerate` (admin), body `{ guestCountOverride? }`. Respects `shopping_list_source` (planner vs consult input builders), returns the fresh list JSON, **does not write**. The modal's existing `PUT /:id/shopping-list` and `PATCH /:id/shopping-list/approve` remain the only writers.
- **Zero new public endpoints.** `GET /api/drink-plans/t/:token/shopping-list` keeps serving the materialized blob.

## 5. Generator rewiring

- `generateShoppingList()` stays pure ("no DB calls" header contract). New signature accepts a `catalog` argument. `server/utils/potionCatalog.js` (new, pure) owns `buildCatalogSlices(parRows)` (the derivations table above), alias resolution, and the recipe resolver. Callers load rows and pass them in: `shoppingListGen.js` (`buildPlannerGeneratorInput`, `buildConsultGeneratorInput`, `autoGenerateShoppingList`), the manual admin path in `drinkPlans.js`, and the new preview + regenerate endpoints.
- **Fallback discipline**: if `par_items` returns zero active rows, fall back to the legacy constants (kept in `shoppingList.js` as `LEGACY_*`, no longer consumed on the happy path) and `Sentry.captureMessage('par_catalog_empty')`. Never generate a bare list because a table is empty.
- **Structured recipe contribution** replaces `mergeSignatureIngredients`'s `INGREDIENT_MAP` matching: for each selected drink, resolve each recipe row via override-or-alias to a catalog item; missing items are added and shared items boosted using the UNCHANGED v1 quantity policy (`max(1, ceil(guests/25))`, +1 per additional drink sharing the item). Free-text ingredient arrays (consult custom drinks) flow through the same alias resolver. Per-serving amounts are stored and displayed but do not drive purchase quantities in v1 (deliberate: "quantities are usually right"; per-serving math is a later opt-in once recipe data is trusted).
- **Planner custom cocktails connected**: `buildPlannerGeneratorInput` reads `sel.customCocktails` (stored today, consumed by nothing). Each string gets the conservative name-match (normalized exact equality) against ALL cocktails+mocktails with non-empty recipes, including `is_active = false` rows. Matched → treated as a selected drink. Unmatched → emitted in a new list field `needsRecipe: [{ name }]`.
- **Needs-recipe flow**: `needsRecipe` renders as a distinct block in the editor modal ("Client requested: recipe needed"), and on the public list page + PDF with client-appropriate copy ("Special requests: your bar lead will source these"), all additive; existing sections and editing UX byte-compatible. The modal block carries an "Add recipe" affordance: `POST /api/cocktails` with `is_active: false` (off-menu, client-invisible; retired-drink precedent), then deep-link `/potions?tab=recipes&drink=<id>`. After the admin writes the recipe, Regenerate resolves it. Every one-off request permanently teaches the catalog.
- **Mocktail fixes**: `resolveCocktailIds` gains a table-aware variant (`resolveDrinkIds(ids, table)`); consult mocktail resolution stops querying the cocktails table for mocktail ids (today it silently returns nothing); planner-side mocktail selections feed the same recipe pipeline. Mocktail recipe rows resolve through the same catalog (their purchasables are largely `everythingElse` items).
- **Mirror kill**: `ShoppingListModal.jsx` regenerate (line ~78) calls the new regenerate endpoint instead of the local generator. Delete `client/src/components/ShoppingList/generateShoppingList.js` and `shoppingListPars.js`. `client/src/data/syrups.js` stays (planner wizard UI data, not generator). `ClientShoppingList.js` is unaffected (renders stored blob; imports only the PDF module). `GET /drink-plans/:id/shopping-list-data` (the client-side generation input feed) is retired with the mirror if nothing else consumes it (verify at build time; if consumed, leave and mark deprecated).
- **Forward-only materialization** (unchanged semantics, now documented): editing pars/recipes never rewrites an existing generated/approved list; Regenerate is the explicit refresh, and the auto-gen no-overwrite guard (`shopping_list IS NULL`) stays.

## 6. Tab UI

- **Recipes tab** (design master-detail): left list (search, per-drink chip `OK/Draft/Empty`, drink-type seg cocktails/mocktails), right detail card (recipe table: drag-order rows; cells ingredient / amount / unit(select) / resolved purchasable "→ Tito's Vodka · 1.75L" with override picker / note; add/delete row; category select; **Mark reviewed** button; "N of M reviewed" counter in the page header). Unresolved ingredient renders a warning chip linking to the Pars tab ("alias it or add an item"). Editing writes through the whole-recipe PUT (drafts saved on blur/debounce, matching inline-edit conventions).
- **Pars tab**: two section cards (Liquor · Beer · Wine / Everything Else), rows drag-orderable, inline cells item / size / qty @ 100 / **Projected @ N** (computed, `max(1, ceil(qty × guests / 100))`, accent-styled), **Called on** chips (`Full bar`, `Vodka · pairs`, `Style: IPA`, `Always`, from role/flags/keys), **Used by** chip (count of recipes resolving to the row), delete (soft). "Baseline stock is set for 100 guests" explainer card with the pulsing flask icon (the one magical-realism moment), guest-count preview input, mode preview filter seg (Full Bar / Spirit-Driven), and "Preview shopping list" button (calls `/api/potions/preview`). Add-item form generates the slug server-side.
- **Both skins, both breakpoints**; the par table must not cause page-level horizontal scroll on mobile (wrap in `tbl-wrap`/overflow container per existing pattern). No em dashes in any copy. Vanilla CSS in `index.css` under a new `potions-` class namespace; tokens only, no raw hex.

## 7. Seeding and migration

- **Catalog seed**: `schema.sql` inserts (~45 rows) derived by hand from the seven legacy constants, byte-identical values, aliases from `INGREDIENT_MAP`, pairings from `SPIRIT_MIXER_PAIRINGS`.
- **Parity test (gate)**: `server/utils/potionCatalog.test.js` builds slices from the seed rows and asserts deep-equality with the legacy constants, and runs `generateShoppingList` on fixture inputs (each serviceStyle + consult modes) against snapshots captured from the pre-change generator. Run one suite at a time (shared dev DB caveat); the parity test itself is pure (no DB) by feeding it the seed literals.
- **Recipe drafts**: Claude drafts recipes for all 25 seeded cocktails + 16 mocktails (`recipe_review = 'draft'`; Rooftop-style empties only where genuinely unknown), via `server/scripts/seedRecipeDrafts.js` (dotenv + pool + `--dry-run`, backfill precedent), skipping any drink whose `ingredients` is already non-empty. Dallas corrects in the Recipes tab; that pass is the point of the review states. Script targets the correct DB branch (prod = Neon default branch via MCP connection string, NOT the local `.env` branch; guard scripted writes).
- **Docs law**: README folder tree + npm scripts (if any added), ARCHITECTURE route table (`/api/potions`, drink-plans additions, regenerate), schema section (par_items, new columns), this spec linked from the fix-list Bar Program entry.

## 8. Verification

1. Parity unit test (above) green before any UI work merges.
2. Generator behavior tests: planner custom matched/unmatched, consult mocktails resolve, alias exact-vs-substring, empty-catalog fallback fires Sentry path.
3. `CI=true npx react-scripts build` (Vercel gate) for every client-touching lane.
4. Manual smoke on localhost: all three tabs + drawer, both skins, mobile widths; regenerate round-trip on a scratch plan; needs-recipe → add recipe → regenerate loop; redirects (`/cocktail-menu`, `/drink-menu`), Settings tab removal, nav badge intact.
5. Review model: per-lane review before merge; generator/submit-transaction lanes get the full fleet (sensitive-adjacent operational path), UI lanes get the light look; push-time sweep per CLAUDE.md.
