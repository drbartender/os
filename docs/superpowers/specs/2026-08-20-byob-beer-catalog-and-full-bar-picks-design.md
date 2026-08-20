# BYOB beer catalog redo + full-bar picks are honored

Date: 2026-08-20
Owner: Dallas
Rev: 2 — folds in the 2026-08-20 plan-fleet findings (fidelity + decomposition +
feasibility, all verified against code). Material changes: the label inventory is FIVE
locations, not four, and the fifth is the live v2 picker; the legacy map gains the
label v2 actually stores; the Miller/Stella content writes become order-independent
against applyPackageLineup2026; the pars100 parity contract is restated honestly
(constants and fixtures move in lockstep, not "untouched"); two raw-selection consumer
surfaces join the scope so the default rule cannot make the list disagree with the
recap surfaces.
Brainstormed section by section in chat 2026-08-20 (that conversation IS the approval).

## Problem

Three separate defects, all in the same seam.

**1. The BYOB beer list is arbitrary.** Seven active beer rows with inconsistent
`style_key` values, inconsistent pack sizes, and one row ("Corona / Light") that names
two different products. Two rows, Corona and Yuengling, carry no `style_key` at all,
which makes them force-stocked on every full-bar list while being unpickable in the
style flow.

**2. Full-bar clients' beer and wine picks are collected and thrown away.**
`buildPlannerLists` in `server/utils/shoppingList.js`, `serviceStyle === 'full_bar'`
branch, stocks `pars100.liquorBeerWine` and never calls `buildBeerItems` or
`buildWineItems`. So `beerFromFullBar` / `wineFromFullBar` are stored on the plan and
read by nothing. Those clients receive whatever carries `in_full_bar = true`
(Michelob, Corona, Yuengling) no matter what they clicked. Verified against prod: 7 of
9 full-bar plans on file carry real picks that had no effect on their list.

**3. Skipping the step yields an empty pick.** `DEFAULT_SELECTIONS` seeds the beer and
wine arrays to `[]`, so a client who never opens the step is indistinguishable from one
who chose nothing. 2 of the 9 full-bar plans are in that state.

**And one live defect found by the rev-2 review:** the v2 picker stores
`'Non-Alcoholic (Athletic Brewing)'` verbatim, which matches nothing in
`BEER_STYLE_MAP` — an NA pick on a v2 plan silently produces no NA beer TODAY.

## The fragility underneath all of it

The beer style labels are plain strings that must agree across FIVE locations, and
every mismatch fails silently (`buildBeerItems` does `if (!mapped) continue`):

1. `par_items.style_key`, the database
2. **`client/src/pages/plan/v2/steps/BeerWineV2.js`, `BEER_STYLES` — the LIVE picker.**
   `PlannerV2.js:336` renders this component. Rev 1 of this spec missed it entirely and
   targeted only the two v1 files below; shipping rev 1 would have reproduced the exact
   silent-mismatch incident this spec exists to prevent.
3. `client/src/pages/plan/steps/BeerWineStep.js`, `BEER_STYLES` (v1 PotionPlanningLab)
4. `client/src/pages/plan/steps/FullBarBeerWineStep.js`, `BEER_STYLES` (v1, duplicated)
5. `server/utils/shoppingList.js`, `BEER_STYLE_MAP`, the legacy fallback used when the
   DB catalog read fails, and also the target of the parity assertion in
   `potionCatalog.test.js`

Any change that misses one of the five produces a client who picks a beer style and
receives no beer, with no error anywhere. This is the reason the work is one atomic
lane and cannot be split. All five sites move to the same five labels: v1 is
superseded but still mounted for `planner_version = 1` tokens, so its label arrays are
updated too — after this ships NO surface can store a retired label, and the legacy map
below covers history.

## Decisions

### Buckets and rows (Dallas's list)

| Bucket | Rows |
|---|---|
| Light & Easy | Michelob Ultra, Miller Lite, Yuengling |
| Imports | Corona Extra, Stella Artois |
| IPA | Goose Island IPA |
| Seltzer | White Claw Variety |
| Zero Proof | Athletic Brewing NA |

Row-level changes:

- `michelob-ultra`: `style_key` to "Light & Easy"
- `yuengling`: `style_key` to "Light & Easy" (was NULL)
- `corona-light`: item to "Corona Extra", `style_key` to "Imports"
- `miller-lite`: NEW, 'Miller Lite', 24pk, `qty_per_100` 3, "Light & Easy"
- `stella-artois`: NEW, 'Stella Artois', 24pk, `qty_per_100` 3, "Imports"
- `ipa-lagunitas-voodoo`: item to "Goose Island IPA", `style_key` stays "IPA"
- `white-claw-variety`: `style_key` stays "Seltzer"
- `athletic-na`: `style_key` to "Zero Proof" (was "Non-Alcoholic")
- `local-craft-beer`: `style_key` to NULL. It SURVIVES as an active row because the
  Grand Experiment stocks craft at par 6 and the Cultivated Complex at par 2, but it
  leaves the BYOB picker. This is Dallas's rule that hosted stock and BYOB
  recommendations are two different sets. Prod carries 11 stored "Craft / Local" picks;
  they keep resolving via the legacy map below.

**Order-independence against `applyPackageLineup2026` (rev 2).** That script also
creates `miller-lite` / `stella-artois` — deliberately with `style_key = NULL`
(`applyPackageLineup2026.js:357`, "never touch the consult beer/wine style pickers"),
so rev 1's "byte-identical" rule was unsatisfiable. The rule now: this project's
content script INSERTs the two rows (same id/item/size/qty as BRANDED_PARS,
`ON CONFLICT (id) DO NOTHING`) **and then absolutely UPDATEs `style_key` on both ids**.
Whichever script runs first, the end state converges: lineup-first leaves the rows
NULL-keyed until this script's UPDATE lands; this-first means lineup's insert no-ops.
Both scripts carry a cross-reference comment naming the other.

### Full-bar honors picks

The `full_bar` branch of `buildPlannerLists` stops force-stocking beer and wine and
calls `buildBeerItems` / `buildWineItems` like the `sig_beer_wine` branch does.

Implemented by ADDING a spirits-only slice, `pars100Spirits`, to `buildCatalogSlices`
(`liquorBeerWine` rows where `in_full_bar` is true AND `role === 'spirit'`). We do NOT
flip `in_full_bar` on the beer and wine rows: `in_full_bar` still legitimately drives
the non-planner consult path, which is out of scope here.

**Parity contract, restated honestly (rev 2).** Rev 1 said "pars100 untouched". That
is wrong on its face: the Corona rename flows into `pars100` because `corona-light` is
`in_full_bar = true`, so the parity assertion forces the same rename in the legacy
`PARS_100` constant (`shoppingList.js:91`) and in the test fixtures. The real
contract: the parity ASSERTIONS still pass, with the legacy constants and the fixtures
moved in lockstep with the catalog — the same lockstep rule the labels already
require. The frozen generator SNAPSHOTS in `potionCatalog.test.js` (~1,400 lines,
including three full_bar fixtures) are invalidated by the branch change plus renames
and are regenerated deliberately, with the diff reviewed, not hand-patched.

### One resolver, three rules, every surface

The 3-rule selection contract:

- `['None']`: the client deliberately chose none. Nothing.
- `[]`: the client never answered. The default set. Covers legacy v1 plans and drafts
  saved before this ships.
- anything else: honored literally.

**Rev 2: the rules live in ONE exported resolver** (`resolveBeerWinePicks(selections,
servingType)` in `shoppingList.js`), because three surfaces read these arrays and rev 1
put the rules only in the generator, which would make the shopping list disagree with
the recap surfaces on a defaulted plan:

- the generator input (`buildPlannerGeneratorInput`, `shoppingListGen.js:393`)
- the per-category split counts (`deriveCategoryCounts`, `shoppingListGen.js:261`),
  which would otherwise report zero beer while the list stocks the default
- the admin/client recap email (`lifecycleEmailTemplates.js:691`), whose current
  `beerFromFullBar || beerFromBeerWine` fallthrough is also serving-type-blind (`[]` is
  truthy), fixed by reading the resolver

`buildBeerItems` / `buildWineItems` keep only label→rows lookup (plus the legacy map);
they receive already-resolved arrays.

### Defaults are pre-picked

`DEFAULT_SELECTIONS` in `client/src/pages/plan/v2/PlannerV2.js` seeds:

- `beerFromFullBar` and `beerFromBeerWine`: `['Light & Easy']`
- `wineFromFullBar` and `wineFromBeerWine`: `['Red', 'White']`

Dallas's rule: a default should be pre-selected so a client has to actively change it to
None if that is what they really want. Values chosen from prod pick frequency: beer
Light / Easy Drinking 25 plans (the runaway), wine White 24 and Red 21 (the pair almost
everyone takes). The default strings must match the LIVE picker's chips (BeerWineV2) or
the pre-pick renders unchecked — which is exactly what rev 1 would have shipped.

### Legacy labels keep resolving

A legacy label map ahead of `buildBeerItems` lookup maps retired labels onto current
rows rather than rewriting stored `selections`:

- "Light / Easy Drinking" → the Light & Easy group
- "Non-Alcoholic" → the Zero Proof group
- **"Non-Alcoholic (Athletic Brewing)" → the Zero Proof group** (rev 2: the string the
  live v2 picker has been storing verbatim; it already misses `BEER_STYLE_MAP` today)
- "Craft / Local" → the `local-craft-beer` row directly (its bucket no longer exists)

Prod carries 25, 3 and 11 plans on the v1 labels. Mapping instead of migrating means no
stored data is rewritten, every historical plan regenerates identically, and no new
client can pick a retired bucket. It is also reversible.

## Out of scope, deliberately

- **Redefining what "full bar" means**, and the other quick-pick categories. Dallas wants
  that redesign but explicitly deferred it: "for the moment, yes, the clients selections
  should matter when they select full bar." This spec must not harden the current
  category model. Concretely: the quick-pick keys (`full_bar`, `sig_beer_wine`,
  `beer_wine`, `mocktails`) are untouched, and the branch structure in
  `buildPlannerLists` stays as-is rather than being collapsed, so the later redesign has
  the same seams to work with.
- **The v1 `PotionPlanningLab`'s behavior.** Its two label arrays are updated (a label
  is vocabulary, not behavior) but nothing else in the v1 flow changes; v1 plans are
  covered by the `[]`-falls-back-to-default rule and the legacy map.
- **`in_full_bar` on beer and wine rows**, which still drives the consult path.
- **Beer costs.** IPA, White Claw and Athletic have no `cost`; Miller Lite and Stella
  will not either. Tracked with the wider par-cost gap (85 of 97 rows), not here.

## Testing

- `potionCatalog.test.js` parity assertions pass with fixtures and legacy constants
  moved in lockstep (see the restated parity contract). `pars100Spirits` gains its own
  assertion (spirit subset of `pars100.liquorBeerWine`).
- Fixture bookkeeping the fleet found, updated with their behavior steps, not batched
  at the end: `SEED_ROWS` count assertions (48 / 23 `liquorBeerWine`) shift when
  Miller/Stella join the fixture set; the frozen SNAPSHOTS regenerate; the full-bar
  preview assertion at `potions.test.js:184` (`>= 13`) is corrected to the new
  post-change count.
- New generator coverage: a full-bar plan with beer picks gets those beers and not the
  `in_full_bar` set; `['None']` yields no beer; `[]` yields the default set; legacy
  labels "Craft / Local" AND "Non-Alcoholic (Athletic Brewing)" resolve; the resolver
  feeds `deriveCategoryCounts` (defaulted plan reports the default counts, not zero).
- DoD walk covers BOTH directions: a defaults-kept submit asserting Michelob + Miller
  Lite + Yuengling actually appear on the generated list (the None-only walk would
  false-pass a broken label seam, since "no beer" is also the failure mode), and a
  switched-to-None submit asserting no beer.

## Verification before merge

Run the resolver and the generator over real prod-shaped selections BEFORE merge, not
deferred to the deploy spot-check: regenerate at least one stored legacy-label plan
shape and one v2 NA-variant shape and diff the beer lines. Re-run the
all-recipe-ingredients-resolve check (`seedRecipeDrafts.js` Gate D via `--dry-run`),
since beer rows are renamed.

## Rollback

`git revert` of the lane does NOT undo prod catalog rows. A post-deploy rollback pairs
the code revert with a row-restore from the content script's snapshot file
(`scripts/beer-snapshot-<ts>.json`) — same pattern as `applyPackageLineup2026.js`'s
header. The legacy map makes the mixed states survivable in one direction only: new
code + old rows resolves; old code + new rows does not.
