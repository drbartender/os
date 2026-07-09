---
spec: docs/superpowers/specs/2026-07-09-potions-bar-program-design.md
lanes:
  - id: potions-a-catalog-core
    footprint:
      - server/db/schema.sql
      - server/utils/potionCatalog.js
      - server/utils/potionCatalog.test.js
    blockedBy: []
    review: full-fleet   # schema.sql is on the sensitive list; parity test is the ship gate for everything downstream
  - id: potions-b-generator
    footprint:
      - server/utils/shoppingList.js
      - server/utils/shoppingListGen.js
      - server/utils/shoppingList.generator.test.js
      - server/routes/drinkPlanConsult.js
    blockedBy: [potions-a-catalog-core]
    review: full-fleet   # spec calls it: generator runs inside/around the drink-plan submit transaction; wrong output = wrong real-world purchases
  - id: potions-c-api
    footprint:
      - server/routes/potions.js
      - server/routes/potions.test.js
      - server/routes/drinkPlans/regenerate.js
      - server/routes/cocktails.js
      - server/routes/mocktails.js
      - server/routes/drinkPlans.js
      - server/index.js
    blockedBy: [potions-b-generator]
    review: standard     # none of these files is on the sensitive list; escalate to full-fleet if the lane ends up editing schema.sql or any webhook/auth file
  - id: potions-d-page
    footprint:
      - client/src/pages/admin/PotionsPage.js
      - client/src/pages/admin/potions/RecipesTab.js
      - client/src/pages/admin/potions/PantryParsTab.js
      - client/src/pages/admin/potions/PlansDrawer.js
      - client/src/utils/servingLabels.js
      - client/src/pages/admin/DrinkPlansDashboard.js
      - client/src/pages/admin/SettingsDashboard.js
      - client/src/components/adminos/nav.js
      - client/src/components/adminos/CommandPalette.js
      - client/src/App.js
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
    blockedBy: [potions-c-api]
    review: standard     # client-only surfaces + docs; ui-ux-review agent included per new-surface convention
  - id: potions-e-mirror-kill
    footprint:
      - client/src/components/ShoppingList/ShoppingListButton.jsx
      - client/src/components/ShoppingList/ShoppingListModal.jsx
      - client/src/components/ShoppingList/ShoppingListPDF.jsx
      - client/src/components/ShoppingList/generateShoppingList.js
      - client/src/components/ShoppingList/shoppingListPars.js
      - client/src/pages/public/ClientShoppingList.js
      - server/routes/drinkPlans.js
      - README.md
    blockedBy: [potions-c-api]
    review: standard     # touches a public client-facing page; run ui-ux-review on the public list + PDF render
  - id: potions-f-recipe-drafts
    footprint:
      - server/scripts/seedRecipeDrafts.js
    blockedBy: [potions-a-catalog-core]
    review: standard     # data authoring + idempotent script; verify against dev DB, prod run is a deploy-day step
---

# Potions (Bar Program) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Lanes are built via the repo's think-on-main/build-in-lanes model (`npm run worktree:new`, squash-merge via `scripts/merge-lane.sh`).

**Goal:** One editable par catalog + structured recipes drive the shopping-list generator; Drink Plans + Cocktail Menu merge into one `Potions` admin surface at `/potions`; the client-side generator mirror is deleted.

**Architecture:** New `par_items` table is the single catalog; every legacy hardcoded table (`PARS_100`, `SPIRIT_PARS`, `INGREDIENT_MAP`, `BASIC_MIXERS`, `GARNISHES`, `ALWAYS_INCLUDE`, beer/wine style maps) becomes a derived slice via pure `server/utils/potionCatalog.js`, proven byte-identical by a parity test. `generateShoppingList()` stays pure and gains a `catalog` argument; callers load rows outside transactions and fall back to legacy constants on any read failure. Recipes live in `cocktails.ingredients` / `mocktails.ingredients` JSONB as structured rows resolving through catalog aliases. A new `PotionsPage` hosts Menu (existing dashboard embedded, untouched) + Recipes + Pars tabs and a Client-plans drawer.

**Tech Stack:** Express 4 + pg (raw SQL), React 18 CRA, vanilla CSS, node:test for server tests.

**Run order:** A → (B ∥ F) → C → (D ∥ E). Lane F may merge any time after A; its prod script run is a deploy-day step.

## Global Constraints

- Push = deploy. Lanes merge by squash via `scripts/merge-lane.sh`; no direct commits to `main` from lanes.
- `CocktailMenuDashboard.js` is ratchet-frozen at 932 lines; it may not grow. It is NOT in any lane footprint on purpose — no task edits it.
- `drinkPlans.js` and other existing files under the 700-line soft cap: prefer new sibling files (`regenerate.js` precedent: `server/routes/proposals/getOne.js`).
- Money-free project: no pricing, Stripe, payroll, or invoice files are touched. If a task seems to need one, stop and escalate.
- Schema changes idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT (id) DO NOTHING`).
- Parameterized SQL only. `AppError` subclasses for client-visible errors. `auth + requireAdminOrManager` on every write route.
- API JSON keys snake_case; JS camelCase. No em dashes in any user-facing copy. Both skins (apothecary default + After Hours) and both breakpoints on every new surface; par table must not cause page-level horizontal scroll on mobile.
- Client work must pass `cd client && CI=true npx react-scripts build` (warnings fail).
- Server test suites run one at a time (`node -r dotenv/config --test <file>`); shared dev DB.
- The spec is the contract: `docs/superpowers/specs/2026-07-09-potions-bar-program-design.md`. Where this plan and the spec disagree, the spec wins; surface the conflict.

## Shared contracts (all lanes)

**Recipe row (stored in `cocktails.ingredients` / `mocktails.ingredients` JSONB array, ordered):**

```json
{ "ingredient": "Vodka", "amount": 1.5, "unit": "oz", "note": "", "override_item_id": null }
```

`unit` ∈ `['oz','dash','each','splash']`. `amount` number > 0. `note` string, may be empty/absent. `override_item_id` string par_items id or null/absent. Legacy plain-string array entries may exist transitionally; every consumer must treat a string entry as `{ ingredient: <string> }`.

**par_items row (DB, snake_case) and its API JSON (identical keys):**

```
id (varchar slug PK) | item | size | qty_per_100 (numeric) | section ('liquorBeerWine'|'everythingElse')
role ('spirit'|'wine'|'beer'|'mixer'|'garnish'|'supplies') | spirit_key | style_key
paired_spirits text[] | ingredient_aliases text[] | in_full_bar bool | is_active bool | sort_order int
```

**`server/utils/potionCatalog.js` exports (pure, no DB, CJS):**

```js
buildCatalogSlices(parRows) // -> catalog object below
resolveIngredient(name, catalog)      // -> { itemId, item, size, section } | null
resolveRecipeRow(row, catalog)        // override-first (active only), then alias -> same shape | null
// catalog = {
//   pars100: { liquorBeerWine: [{item,size,qty}], everythingElse: [...] },
//   spiritPars: { vodka: {item,size,qty}, gin, rum, tequila, bourbon, whiskey, scotch, mezcal },
//   beerStyleMap: { 'Light / Easy Drinking': [...], 'Craft / Local': [...], 'IPA': [...], 'Seltzer': [...], 'Non-Alcoholic': [...] },
//   wineStyleMap: { Red: [...], White: [...], Sparkling: [...] },
//   basicMixers: [...], garnishes: [...], alwaysInclude: [...],
//   spiritMixerPairings: { vodka: ['Cranberry Juice', ...], ... },
//   aliasIndex: [{ alias, itemId, item, size, section }],  // sorted alias.length DESC
//   byId: Map,
//   isEmpty: bool
// }
```

Slices carry `qty` as a Number (pg returns NUMERIC as string; `buildCatalogSlices` casts). Slice rows are `{ item, size, qty }` exactly like the legacy constants (no extra keys) so the parity test can deep-equal.

**Generator signature change (`server/utils/shoppingList.js`):**

```js
generateShoppingList(eventData, catalog /* optional; falls back to LEGACY_* slices when absent/empty */)
```

`eventData` gains optional `needsRecipe: [{ name }]` (passed through to the output object untouched). Output object gains `needsRecipe` (always an array, possibly empty).

**Catalog loading helper (`server/utils/shoppingListGen.js`):**

```js
async function loadCatalog(dbClient) // SELECT * FROM par_items WHERE is_active = true ORDER BY sort_order, id
// -> buildCatalogSlices(rows); on ANY error or zero rows -> null + Sentry captureMessage
// callers pass catalog=null through; generateShoppingList treats null as "use LEGACY_*"
```

Load the catalog BEFORE any `BEGIN` in the consult path. Never inside a transaction.

**Name normalization (shared by alias + custom-drink matching):** lowercase, trim, collapse whitespace, strip `[^a-z0-9 ]`. Custom-drink matching is normalized EXACT equality only. Alias matching is exact-first then longest-alias substring.

**Regenerate endpoint (Lane C produces, Lane E consumes):**

```
POST /api/drink-plans/:id/shopping-list/regenerate   (auth + requireAdminOrManager)
body: { guest_count_override?: int 1..1000 }
200 -> { list: <generateShoppingList output> }        // NOT saved
400 ValidationError 'Set a guest count to generate this list' when no guest count anywhere
```

Builder choice: `shopping_list_source === 'consult'` → consult builder; `'planner'` or `NULL` → planner builder.

**Preview endpoint (Lane C produces, Lane D consumes):**

```
GET /api/potions/preview?guests=175&mode=full_bar|spirit_driven   (auth + requireAdminOrManager)
200 -> { list: <generateShoppingList output> }
```

`mode=full_bar` → planner input `{ serviceStyle: 'full_bar', guestCount }`. `mode=spirit_driven` → consult input `{ mixerMode: 'matching', additionalSpirits: <all spirit_keys present in catalog>, guestCount }`.

**Pars CRUD (Lane C produces, Lane D consumes):** `GET /api/potions/pars` → `{ pars: [rows] }` (active only, ordered). `POST /api/potions/pars` (row minus id → server slugs it; 201 `{ par: row }`). `PUT /api/potions/pars/:id` (COALESCE partial update; 200 `{ par: row }`). `DELETE /api/potions/pars/:id` (soft; `ConflictError` naming referencing drinks when used-by > 0). `POST /api/potions/pars/reorder` `{ items: [{id, sort_order}] }`.

**Used-by computation (server, shared by DELETE guard and Lane D display):** a drink references par row P when any recipe row's `resolveRecipeRow` result has `itemId === P.id`. Implemented in Lane C as `computeUsedBy(parId)` inside `potions.js` (reads all cocktails+mocktails ingredients + catalog, reuses `potionCatalog` resolver).

**Accepted output delta (the only one):** consult `mixerMode: 'matching'` lists keep identical CONTENT but may reorder mixers (pairing order now derives from catalog row order, not the legacy per-spirit arrays). Every other path is byte-identical, enforced by the parity test.

**Merge-size rule (parity-critical):** the legacy `INGREDIENT_MAP` deliberately added sig-drink spirits as 750mL bottles while baseline pars use 1.75L. Preserved as a rule, not data: in the signature-merge path only, a resolved item with `role='spirit'` and `size='1.75L'` is added as `750mL`. The parity test asserts all 18 legacy `INGREDIENT_MAP` entries resolve to identical `{item,size,section}`.

---

## Lane A — potions-a-catalog-core

**Files:** Modify `server/db/schema.sql`. Create `server/utils/potionCatalog.js`, `server/utils/potionCatalog.test.js`.
**Interfaces:** Produces the `potionCatalog` exports and the seeded `par_items` table per Shared contracts. Consumes nothing.

### Task A1: schema — par_items + recipe columns

- [ ] **A1.1** Append to `schema.sql` (after the mocktails section): the `par_items` CREATE TABLE from Shared contracts verbatim, with `CHECK` constraints on `section`, `role`, and `qty_per_100 >= 0`, the `update_par_items_updated_at` trigger (copy the cocktails trigger pattern at `schema.sql:397-403`), and:

```sql
ALTER TABLE cocktails  ADD COLUMN IF NOT EXISTS recipe_review VARCHAR(20) NOT NULL DEFAULT 'empty';
ALTER TABLE mocktails  ADD COLUMN IF NOT EXISTS ingredients JSONB DEFAULT '[]';
ALTER TABLE mocktails  ADD COLUMN IF NOT EXISTS recipe_review VARCHAR(20) NOT NULL DEFAULT 'empty';
-- CHECKs added idempotently (users.role precedent, schema.sql:270):
--   cocktails_recipe_review_check / mocktails_recipe_review_check IN ('empty','draft','reviewed')
```

- [ ] **A1.2** Seed `par_items` with `INSERT ... ON CONFLICT (id) DO NOTHING` — all 48 rows. This table IS the parity contract; values copied from `shoppingList.js:13-165`:

```
section liquorBeerWine (sort_order 10..):
  titos-vodka          "Tito's Vodka"         1.75L  5  spirit  spirit_key=vodka    aliases={vodka}                       in_full_bar
  tanqueray-gin        "Tanqueray Gin"        1.75L  1  spirit  spirit_key=gin      aliases={gin}                         in_full_bar
  bacardi-rum          "Bacardi Rum"          1.75L  2  spirit  spirit_key=rum      aliases={rum,white rum}               in_full_bar
  bulleit-bourbon      "Bulleit Bourbon"      1.75L  4  spirit  spirit_key=bourbon  aliases={bourbon,whiskey}             in_full_bar
  1800-blanco-tequila  "1800 Blanco Tequila"  1.75L  4  spirit  spirit_key=tequila  aliases={tequila,blanco tequila}      in_full_bar
  cabernet-sauvignon   "Cabernet Sauvignon"   750mL  6  wine    style_key=Red                                             in_full_bar
  pinot-noir           "Pinot Noir"           750mL  6  wine    style_key=Red                                             in_full_bar
  moscato              "Moscato"              750mL  6  wine    style_key=White                                           in_full_bar
  sauvignon-blanc      "Sauvignon Blanc"      750mL  6  wine    style_key=White                                           in_full_bar
  champagne            "Champagne"            750mL 12  wine    style_key=Sparkling aliases={champagne,prosecco}          in_full_bar
  michelob-ultra       "Michelob Ultra"       24pk   2  beer    style_key=Light / Easy Drinking                           in_full_bar
  corona-light         "Corona / Light"       24pk   3  beer                                                              in_full_bar
  yuengling            "Yuengling"            24pk   2  beer                                                              in_full_bar
  local-craft-beer     "Local Craft Beer"     24pk   2  beer    style_key=Craft / Local
  ipa-lagunitas-voodoo "IPA (Lagunitas / Voodoo Ranger)" 12pk 2 beer style_key=IPA
  white-claw-variety   "White Claw Variety"   12pk   2  beer    style_key=Seltzer
  athletic-na          "Athletic Brewing NA"  12pk   1  beer    style_key=Non-Alcoholic
  scotch-whiskey       "Scotch Whiskey"       1.75L  1  spirit  spirit_key=scotch   aliases={scotch}
  mezcal               "Mezcal"               750mL  1  spirit  spirit_key=mezcal   aliases={mezcal}
  raspberry-vodka      "Raspberry Vodka"      750mL  1  spirit  aliases={raspberry vodka}
  malibu-coconut-rum   "Malibu Coconut Rum"   750mL  1  spirit  aliases={coconut rum,malibu}
  island-blue-pucker   "Island Blue Pucker"   750mL  1  spirit  aliases={island blue pucker}
  blue-curacao         "Blue Curacao"         750mL  1  spirit  aliases={blue curacao}

section everythingElse (sort_order 10..):
  coca-cola            "Coca Cola"            12 pack 2 mixer   paired={rum,bourbon,whiskey}
  diet-coke            "Diet Coke"            12 pack 1 mixer
  sprite               "Sprite"               12 pack 1 mixer   aliases={sprite}
  club-soda            "Club Soda"            8 pack  6 mixer   paired={vodka,gin,tequila,bourbon,whiskey,scotch} aliases={club soda,soda water}
  tonic-water          "Tonic Water"          1L      2 mixer   paired={vodka,gin}  aliases={tonic}
  cranberry-juice      "Cranberry Juice"      64oz    2 mixer   paired={vodka}      aliases={cranberry}
  pineapple-juice      "Pineapple Juice"      64oz    2 mixer   paired={rum}        aliases={pineapple juice}
  orange-juice         "Orange Juice"         64oz    1 mixer   paired={vodka,rum}  aliases={orange juice}
  lemon-juice          "Lemon Juice"          31oz    1 mixer   paired={gin}        aliases={lemon juice}
  lime-juice-unsweet   "Lime Juice (UNSWEET)" 15oz    1 mixer   paired={vodka,rum,tequila,mezcal} aliases={lime juice}
  simple-syrup         "Simple Syrup"         1L      2 mixer   paired={gin,tequila,mezcal} aliases={simple syrup}
  angostura-bitters    "Angostura Bitters"    4oz     1 mixer   paired={bourbon,whiskey} aliases={angostura,bitters}
  premium-cherries     "Premium Cherries"     ea.     1 garnish paired={bourbon,whiskey} aliases={brandied cherry,cherry}
  lemons               "Lemons"               ea.     4 garnish paired={gin}        aliases={lemon twist,lemon wheel,lemon wedge,lemon peel}
  limes                "Limes"                ea.    12 garnish paired={vodka,rum,tequila,mezcal} aliases={lime wedge,lime wheel}
  oranges              "Oranges"              ea.     2 garnish aliases={orange peel,orange slice,orange wheel,orange twist}
  water                "Water"                24pk    4 supplies
  cups-9oz             "Cups (9oz)"           500     1 supplies
  straws               "Straws"               box     1 supplies
  napkins              "Napkins"              100     1 supplies
  ice                  "Ice"                  lbs   150 supplies
  ginger-beer          "Ginger Beer"          4 pack  1 mixer   aliases={ginger beer}
  ginger-ale           "Ginger Ale"           12 pack 1 mixer   aliases={ginger ale}
  lemonade-real        "Lemonade (REAL)"      1G      1 mixer   aliases={lemonade}
  sour-mix             "Sour Mix"             64oz    1 mixer   aliases={sour}
```

  All 22 rows marked `in_full_bar` in liquorBeerWine plus the 21 legacy everythingElse rows (through `ice`) are `in_full_bar = true`; alias-only tail rows (`ginger-beer` onward, and the non-baseline liquor rows) are `in_full_bar = false`. Every alias above that came from `INGREDIENT_MAP` must reproduce its mapping exactly (test A3).

- [ ] **A1.3** Run `psql $DATABASE_URL -f server/db/schema.sql` against dev (idempotent; verify re-run is a no-op) and `SELECT COUNT(*) FROM par_items` → 48. Commit.

### Task A2: potionCatalog.js (pure)

- [ ] **A2.1** Implement per Shared contracts. `buildCatalogSlices` filters `is_active`, orders by `(section, sort_order, id)`, casts `qty_per_100` → Number, emits slice rows as `{item, size, qty}` only. `spiritPars.whiskey` = the `bourbon` row (legacy duplication). `spiritMixerPairings` built by iterating mixer-then-garnish rows in order, appending `item` to each spirit in `paired_spirits`. `aliasIndex` sorted alias length DESC. `resolveIngredient(name)`: normalize (Shared contracts), exact alias match, else first substring hit in the sorted index, else null. `resolveRecipeRow(row)`: string row → `resolveIngredient(row)`; object row → active `override_item_id` lookup first, else `resolveIngredient(row.ingredient)`.
- [ ] **A2.2** No DB imports anywhere in the module (test asserts `require` graph is clean by inspection; module header comment states the purity contract like `shoppingList.js:1-9`).

### Task A3: parity test (the gate)

- [ ] **A3.1** `server/utils/potionCatalog.test.js` (node:test, PURE — feeds the seed literals, no DB): embed the 48 seed rows as fixtures (copied from A1.2; a comment marks them as the schema.sql mirror). Assert deep-equality: `pars100` vs `PARS_100`, `spiritPars` vs `SPIRIT_PARS` (incl. whiskey===bourbon values), `beerStyleMap`/`wineStyleMap` vs legacy maps, `basicMixers`/`garnishes`/`alwaysInclude` vs legacy arrays, `spiritMixerPairings` vs legacy as SETS per spirit (order exempt, the one accepted delta). Assert all 18 `INGREDIENT_MAP` keys resolve to identical `{item,size,section}` (after the merge-size spirit rule).
- [ ] **A3.2** Snapshot fixtures: run legacy `generateShoppingList` (pre-change, exported constants) on 6 representative inputs (full_bar 100/175/40 guests + sig drinks using only legacy-mapped ingredient strings; sig_beer_wine; beer_wine; consult full + matching) and freeze outputs (strip `_id` uuids). These snapshots move to Lane B's test to prove the catalog-driven generator reproduces them.
- [ ] **A3.3** `node -r dotenv/config --test server/utils/potionCatalog.test.js` → PASS. Commit.

## Lane B — potions-b-generator

**Files:** Modify `server/utils/shoppingList.js`, `server/utils/shoppingListGen.js`, `server/routes/drinkPlanConsult.js`. Create `server/utils/shoppingList.generator.test.js`.
**Interfaces:** Consumes `potionCatalog` exports + Lane A snapshots. Produces `generateShoppingList(eventData, catalog)`, `loadCatalog(dbClient)`, needsRecipe passthrough, custom/mocktail feed-through — signatures per Shared contracts.

### Task B1: catalog-driven generator

- [ ] **B1.1** `shoppingList.js`: rename the seven constants `LEGACY_*` (exported for the fallback + tests). Add `catalog` param; at entry, `const slices = (catalog && !catalog.isEmpty) ? catalog : legacySlices()` where `legacySlices()` wraps the LEGACY_* constants in the same catalog shape (including `aliasIndex` built from `LEGACY_INGREDIENT_MAP`). Every internal consumer (`buildPlannerLists`, `buildConsultLists`, `addSpiritsByKey`, `addMatchingMixers`, `buildBeerItems`, `buildWineItems`) reads from `slices`, never the constants.
- [ ] **B1.2** `mergeSignatureIngredients` → `mergeSignatureRecipes(signatureCocktails, ..., slices)`: per drink, per recipe row, `resolveRecipeRow`; apply the merge-size spirit rule (1.75L→750mL); missing item pushed with `qty = max(1, ceil(guestCount/25))`, shared-item boost `+1` per extra drink (UNCHANGED policy, keyed by resolved itemId instead of map key). String rows keep working (legacy free text). Unresolved rows: skip + collect; `generateShoppingList` calls `Sentry.captureMessage('unresolved_ingredient', {extra:{drink, ingredient}})` per unresolved (lazy-require Sentry like the existing pattern; no-throw).
- [ ] **B1.3** `needsRecipe`: `eventData.needsRecipe` (default `[]`) copied onto the output object.
- [ ] **B1.4** Run Lane A snapshots through the new generator with the seed catalog → byte-identical (minus consult-matching order, compared as sets). Commit.

### Task B2: callers

- [ ] **B2.1** `shoppingListGen.js`: add `loadCatalog(dbClient)` per Shared contracts (try/catch → null + `captureMessage('par_catalog_read_failed')`; zero rows → null + `'par_catalog_empty'`). `resolveCocktailIds` → also `resolveDrinkIds(ids, table, dbClient)` with `table ∈ {'cocktails','mocktails'}` (validated against that allowlist, never interpolated from input); consult mocktails resolve from `mocktails` (bug fix). `buildPlannerGeneratorInput` additions: resolve `sel.mocktails` (verify exact selections key against `PotionPlanningLab.js` state at build time; adjust to the real key) into signatureCocktails; read `sel.customCocktails` (strings) → normalized-exact match against all cocktails+mocktails names WHERE `ingredients != '[]'` (one query, includes inactive) → matched ids resolve as drinks, unmatched → `needsRecipe`.
- [ ] **B2.2** `autoGenerateShoppingList` + `buildConsultGeneratorInput` callers pass `catalog` (loaded once per generation). `drinkPlanConsult.js`: hoist the catalog load ABOVE the `BEGIN` (verify placement against the transaction at `drinkPlanConsult.js:204-226`).
- [ ] **B2.3** Behavior tests (`shoppingList.generator.test.js`, pure where possible): custom matched / unmatched→needsRecipe; mocktail resolution table fix; alias exact-beats-substring; ginger-beer-vs-gin via length ordering; throwing/empty catalog → legacy fallback output identical to snapshots; unresolved-ingredient collection. Run suite alone → PASS. Commit.

## Lane C — potions-c-api

**Files:** Create `server/routes/potions.js`, `server/routes/potions.test.js`, `server/routes/drinkPlans/regenerate.js`. Modify `server/routes/cocktails.js`, `server/routes/mocktails.js`, `server/routes/drinkPlans.js` (list SELECT only), `server/index.js`.
**Interfaces:** Consumes Lane A catalog + Lane B builders/loadCatalog. Produces the endpoints in Shared contracts (pars CRUD, preview, regenerate, enriched list, recipe validation).

### Task C1: potions router

- [ ] **C1.1** `potions.js` per Shared contracts. Slug generation: normalize item name (same normalizer), spaces→`-`; on 23505 retry with `-2` suffix, then ConflictError. `computeUsedBy(parId, db)`: load catalog + all drinks with non-empty `ingredients`; return `[{id, name, table}]` of drinks whose any recipe row resolves to `parId`. DELETE throws `ConflictError('Used by: <names>')` when non-empty. Mount in `index.js` beside cocktails.
- [ ] **C1.2** Preview endpoint per Shared contracts (guests int 1..1000 else ValidationError; mode enum). Reuses Lane B input builders with synthetic input; NOT the drink-plan builders.
- [ ] **C1.3** Route tests: CRUD happy paths, delete-blocked-when-used, reorder order round-trip, preview 400s. Run alone → PASS. Commit.

### Task C2: recipe validation + public trim + enriched list + regenerate

- [ ] **C2.1** `cocktails.js` + `mocktails.js`: validate structured `ingredients` on POST/PUT (array; per-row: `ingredient` non-empty string ≤120, `amount` number > 0, `unit` in set, `note` ≤200, `override_item_id` null or existing ACTIVE par id — one `SELECT id FROM par_items WHERE id = ANY(...) AND is_active` batch check → ValidationError naming the bad row). `recipe_review` transitions: recipe-changed + current `empty` → set `draft`; body may set `recipe_review:'reviewed'` explicitly; any other body value → ValidationError. Mocktails POST/PUT gain `ingredients`/`recipe_review` params (table has the columns from Lane A).
- [ ] **C2.2** Public trim: `GET /api/cocktails` and `GET /api/mocktails` switch `SELECT c.*`/`m.*` → explicit column lists WITHOUT `recipe_review` (keep `ingredients`; accepted exposure per spec §4). `GET /admin` keeps everything.
- [ ] **C2.3** `drinkPlans.js` list route: add `shopping_list_status`, `p.guest_count` (LEFT JOIN proposals), and `drink_names` (batched id→name across the page of rows; skip when id set empty). Additive only; assert existing fields unchanged in a route test.
- [ ] **C2.4** `drinkPlans/regenerate.js` per Shared contracts; mounted in `index.js` BEFORE the flat drinkPlans router (path-specific POST; verify no shadowing of existing routes by listing both routers' paths in the lane notes). Uses Lane B `loadCatalog` + source-NULL→planner rule + guest-count guard. Tests: NULL-source, consult-source, no-guest-count 400, override clamp. Run alone → PASS. Commit.

## Lane D — potions-d-page

**Files:** Create `PotionsPage.js`, `potions/RecipesTab.js`, `potions/PantryParsTab.js`, `potions/PlansDrawer.js`, `client/src/utils/servingLabels.js`. Modify `DrinkPlansDashboard.js` (import the extracted label map only), `SettingsDashboard.js`, `nav.js`, `CommandPalette.js`, `App.js`, `index.css`, `README.md`, `ARCHITECTURE.md`.
**Interfaces:** Consumes `/api/potions/pars|preview`, cocktails/mocktails admin GET/PUT/POST, enriched `GET /drink-plans`. Produces the `/potions` surface per spec §2 + §6.

- [ ] **D1** `servingLabels.js`: extract `SERVING_LABEL` from `DrinkPlansDashboard.js:24`; both consumers import it.
- [ ] **D2** `PotionsPage.js`: tabs `menu|recipes|pars` via `useUrlListState` (default `menu`), drawer via its `drawer` passthrough; Menu tab renders `<CocktailMenuDashboard embedded />`; header carries the Client-plans button (warn chip = count of `shopping_list_status==='pending_review'` from the enriched list, lazy-loaded on first render of the button badge via the same fetch the drawer uses).
- [ ] **D3** `RecipesTab.js` per spec §6: self-contained fetches (`/cocktails/admin`, `/mocktails/admin`, `/potions/pars` for the resolver display), master list + detail card, debounced whole-recipe PUT autosave with saved/unsaved indicator, flush-before-Mark-reviewed, client validation mirroring C2.1 (FieldError + "fix amount to save"), resolved-purchasable cell with override picker (active pars only), unresolved warning chip linking `/potions?tab=pars`, loading/empty/error+retry states, drink-type seg. Client-side resolution duplicates ONLY the normalize+alias-match display logic (a ~30-line helper in `RecipesTab.js`; generation authority stays server-side).
- [ ] **D4** `PantryParsTab.js` per spec §6: two section cards, inline edit → PUT per row (optimistic, toast on failure per existing reorder convention), drag-reorder → `/pars/reorder`, Called-on chips, Used-by chip (from a `used_by_counts` field added to `GET /pars` in Lane C — verify; if absent, compute client-side from the recipes fetch), delete with ConflictError copy surfaced, explainer card + pulsing flask (CSS animation under `potions-` namespace), guest preview input + mode seg + Preview button rendering the preview response in a read-only modal.
- [ ] **D5** `PlansDrawer.js` per spec §2: enriched list fetch, five-status chip map + "List to review" warn chip, rows → `/drink-plans/:id`, footer "Full index" → `/drink-plans`, loading/empty/error states.
- [ ] **D6** Nav merge: `nav.js` one `Potions` entry (flask, `/potions`, badgeKey `pending_shopping_lists`); CommandPalette single entry; `App.js` route + redirects (`/cocktail-menu`, `/drink-menu` → `/potions`); `SettingsDashboard` drops `drink-menu` tab AND re-points its default `activeTab` (`SettingsDashboard.js:288`).
- [ ] **D7** `CI=true npx react-scripts build` green; smoke both skins + mobile widths (no page-level horizontal scroll); README/ARCHITECTURE updates per spec §7. Commit per logical step throughout.

## Lane E — potions-e-mirror-kill

**Files:** Modify `ShoppingListButton.jsx`, `ShoppingListModal.jsx`, `ShoppingListPDF.jsx`, `ClientShoppingList.js`, `server/routes/drinkPlans.js` (retire `/shopping-list-data`), `README.md`. Delete `generateShoppingList.js`, `shoppingListPars.js` (client copies).
**Interfaces:** Consumes the regenerate endpoint (Shared contracts). Produces: zero client-side generation; needsRecipe rendering on modal/public/PDF.

- [ ] **E1** `ShoppingListButton.jsx`: first-generate + manual-guest-count flows call regenerate (`guest_count_override` from the manual input); drop the `/shopping-list-data` fetch and the local generator import; loading/error states on the button per existing pattern.
- [ ] **E2** `ShoppingListModal.jsx`: regenerate button → endpoint, behind `window.confirm` copy: "Regenerate replaces your edits, and saving will set the list back to Needs review. Continue?"; remove generator import; needsRecipe block ("Client requested: recipe needed") with Add-recipe affordance (`POST /cocktails` `is_active:false`, FormBanner on failure, then `navigate('/potions?tab=recipes&drink=<id>')`).
- [ ] **E3** `ClientShoppingList.js` + `ShoppingListPDF.jsx`: render `needsRecipe` when non-empty as "Special requests: your bar lead will source these" (client copy, list of names only).
- [ ] **E4** Delete the two client generator files; grep client/src (js AND jsx) for `generateShoppingList|shoppingListPars` → only the PDF-internal names remain; retire `GET /:id/shopping-list-data` from `drinkPlans.js` after re-verifying `ShoppingListButton.jsx:66` was its sole consumer. `CI=true npx react-scripts build` green. README tree updated (deletions). Commit.

## Lane F — potions-f-recipe-drafts

**Files:** Create `server/scripts/seedRecipeDrafts.js`.
**Interfaces:** Consumes Lane A schema. Produces drafted recipes (`recipe_review='draft'`) for all 25 cocktails + 16 mocktails and the supporting alias-only par rows.

- [ ] **F1** Script per backfill precedent (`backfillExtrasInvoices.js`: dotenv, pool, `--dry-run`, idempotent: skip drinks whose `ingredients != '[]'`; par inserts `ON CONFLICT (id) DO NOTHING`). It first inserts the recipe-support par rows (all `in_full_bar=false`, `is_active=true`, no baseline flags — invisible to every legacy slice, so parity holds): `sweet-vermouth`, `dry-vermouth`, `campari`, `aperol` (aliases `{aperol}`), `triple-sec` (aliases `{triple sec,orange liqueur,cointreau}`), `coffee-liqueur` (`{coffee liqueur,kahlua}`), `espresso` (section everythingElse, `{espresso,cold brew}`), `orgeat` (`{orgeat,almond syrup}`), `grenadine` (`{grenadine}`), `peychauds-bitters` (`{peychauds}`), `absinthe`, `rye-whiskey` (`{rye}`), `amaretto`, `amaro-nonino` (`{amaro nonino,amaro}`), `averna` (`{averna}`), `green-chartreuse` (`{green chartreuse,chartreuse}`), `maraschino-liqueur` (`{maraschino}`), `lillet-blanc` (`{lillet}`), `mint` (everythingElse, garnish, `{mint,mint leaves,fresh mint}`), `agave-syrup` (`{agave}`), `cream-of-coconut` (`{cream of coconut,coconut cream}`), `heavy-cream` (`{heavy cream,cream}`), `egg-whites` (`{egg white}`), `ginger-syrup` (`{ginger syrup}`), `hibiscus-tea` (`{hibiscus}`), `apple-cider` (`{apple cider}`), `peach-nectar` (`{peach nectar,peach}`), `mango-nectar` (`{mango nectar,mango}`), `strawberries` (`{strawberry,strawberries}`), `cucumber` (`{cucumber}`), `basil` (`{basil}`), `elderflower-syrup` (`{elderflower}`), `chocolate-syrup` (`{chocolate}`), `vanilla-syrup` (`{vanilla}`), `smoked-chips` (`{smoke,smoked}`, note-only garnish). Sizes 750mL for liquors, sensible retail sizes otherwise; `qty_per_100 = 1`.
- [ ] **F2** Recipes: classic specs, per-serving, resolving through the aliases above (write each as structured rows; e.g. Old Fashioned = Bourbon 2 oz / Simple Syrup 0.25 oz / Angostura 2 dash / Orange peel 1 each note "expressed, garnish"; Margarita = Blanco Tequila 2 oz / Triple Sec 0.75 oz / Lime Juice 1 oz / Simple Syrup 0.25 oz / Lime wheel 1 each; Espresso Martini = Vodka 1.5 oz / Coffee Liqueur 0.5 oz / Espresso 1 oz / Simple Syrup 0.25 oz; ... all 25 cocktails from `schema.sql:420-446` and all 16 mocktails from `schema.sql:521-538`, including retired `last-word`). The full drink-by-drink table is authored IN the script (it is the source of truth Dallas will correct in the UI; `recipe_review='draft'` everywhere).
- [ ] **F3** `node server/scripts/seedRecipeDrafts.js --dry-run` → prints per-drink plan, 0 writes; run live against dev; verify Recipes tab (or `SELECT` counts: 41 drinks with non-empty ingredients, review='draft'; every recipe row resolves — script exits non-zero listing unresolved rows otherwise, so alias gaps are caught at seed time, not in prod). Commit. **Deploy-day step (checklist item, not code): run against prod Neon default branch via MCP connection string, `--dry-run` first, Dallas go/no-go in between.**

## Self-review notes (kept with the plan)

- Spec coverage walked section-by-section 2026-07-09; every §2-§8 requirement maps to a task above (§2→D, §3→A, §4→C, §5→B+E, §6→D, §7→A1/F/D7, §8→A3/B2.3/C tests/D7).
- The one intentionally-unplanned file: `CocktailMenuDashboard.js` (frozen; embedded untouched).
- Type consistency: `catalog`/`slices` naming, `resolveRecipeRow` signature, and `needsRecipe` field name used identically in A/B/C/E tasks.
- Selections keys (`sel.mocktails`, custom box key) flagged for build-time verification in B2.1 rather than asserted blind.
