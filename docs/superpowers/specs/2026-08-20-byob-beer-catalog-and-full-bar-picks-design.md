# BYOB beer catalog redo + full-bar picks are honored

Date: 2026-08-20
Owner: Dallas
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

## The fragility underneath all of it

The five beer style labels are plain strings that must agree across FOUR locations, and
every mismatch fails silently (`buildBeerItems` does `if (!mapped) continue`):

1. `par_items.style_key`, the database
2. `client/src/pages/plan/steps/BeerWineStep.js`, `BEER_STYLES`
3. `client/src/pages/plan/steps/FullBarBeerWineStep.js`, `BEER_STYLES` (duplicated)
4. `server/utils/shoppingList.js`, `BEER_STYLE_MAP`, the legacy fallback used when the
   DB catalog read fails, and also the target of the parity assertion in
   `potionCatalog.test.js`

Any change to the labels that misses one of the four produces a client who picks a beer
style and receives no beer, with no error anywhere. This is the reason the work is one
atomic lane and cannot be split.

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
- `miller-lite`: NEW, 24pk, `qty_per_100` 3, "Light & Easy"
- `stella-artois`: NEW, 24pk, `qty_per_100` 3, "Imports"
- `ipa-lagunitas-voodoo`: item to "Goose Island IPA", `style_key` stays "IPA"
- `white-claw-variety`: `style_key` stays "Seltzer"
- `athletic-na`: `style_key` to "Zero Proof" (was "Non-Alcoholic")
- `local-craft-beer`: `style_key` to NULL. It SURVIVES as an active row because the
  Grand Experiment stocks craft at par 6 and the Cultivated Complex at par 2, but it
  leaves the BYOB picker. This is Dallas's rule that hosted stock and BYOB
  recommendations are two different sets. Prod carries 11 stored "Craft / Local" picks;
  they keep resolving via the legacy map below.

`miller-lite` and `stella-artois` are also created by `applyPackageLineup2026`'s
`BRANDED_PARS` with the same ids, sizes and quantities. Creating them here is
deliberate and the script's insert is `ON CONFLICT (id) DO NOTHING`, so the two do not
collide. Keep the definitions identical.

### Full-bar honors picks

The `full_bar` branch of `buildPlannerLists` stops force-stocking beer and wine and
calls `buildBeerItems` / `buildWineItems` like the `sig_beer_wine` branch does.

Implemented by ADDING a spirits-only slice, `pars100Spirits`, to `buildCatalogSlices`
(`liquorBeerWine` rows where `in_full_bar` is true AND `role === 'spirit'`). We do NOT
flip `in_full_bar` on the beer and wine rows, for two reasons: `pars100` stays
byte-identical so the parity contract in `potionCatalog.test.js` is untouched, and
`in_full_bar` still legitimately drives the non-planner consult path, which is out of
scope here.

### Three rules for a selection array

Applied in `buildBeerItems` and `buildWineItems`:

- `['None']`: the client deliberately chose none. Stock nothing.
- `[]`: the client never answered. Fall back to the default set. This covers legacy v1
  plans and any draft saved before this ships.
- anything else: honor it literally.

### Defaults are pre-picked

`DEFAULT_SELECTIONS` in `client/src/pages/plan/v2/PlannerV2.js` seeds:

- `beerFromFullBar` and `beerFromBeerWine`: `['Light & Easy']`
- `wineFromFullBar` and `wineFromBeerWine`: `['Red', 'White']`

Dallas's rule: a default should be pre-selected so a client has to actively change it to
None if that is what they really want. Values chosen from prod pick frequency: beer
Light / Easy Drinking 25 plans (the runaway), wine White 24 and Red 21 (the pair almost
everyone takes).

### Legacy labels keep resolving

A legacy label map in `buildBeerItems` maps retired labels onto current rows rather than
rewriting stored `selections`:

- "Light / Easy Drinking" to the Light & Easy group
- "Non-Alcoholic" to the Zero Proof group
- "Craft / Local" to `local-craft-beer`

Prod carries 25, 3 and 11 plans on those labels respectively. Mapping instead of
migrating means no stored data is rewritten, every historical plan regenerates
identically, and no new client can pick a retired bucket. It is also reversible.

## Out of scope, deliberately

- **Redefining what "full bar" means**, and the other quick-pick categories. Dallas wants
  that redesign but explicitly deferred it: "for the moment, yes, the clients selections
  should matter when they select full bar." This spec must not harden the current
  category model. Concretely: the quick-pick keys (`full_bar`, `sig_beer_wine`,
  `beer_wine`, `mocktails`) are untouched, and the branch structure in
  `buildPlannerLists` stays as-is rather than being collapsed, so the later redesign has
  the same seams to work with.
- **The v1 `PotionPlanningLab`**, at 998 lines against the 1000-line hard cap and
  superseded by PlannerV2. v1 plans keep their current behavior and are covered by the
  `[]`-falls-back-to-default rule.
- **`in_full_bar` on beer and wine rows**, which still drives the consult path.
- **Beer costs.** IPA, White Claw and Athletic have no `cost`; Miller Lite and Stella
  will not either. Tracked with the wider par-cost gap (85 of 97 rows), not here.

## Testing

- `potionCatalog.test.js` parity assertions must still pass UNCHANGED for `pars100`.
  Adding `pars100Spirits` is additive; `pars100` is not modified.
- The fixtures in `potionCatalog.test.js` and the legacy `BEER_STYLE_MAP` in
  `shoppingList.js` are updated together to the new labels, or the parity assertion on
  `beerStyleMap` fails.
- New generator coverage: a full-bar plan with beer picks gets those beers and not the
  `in_full_bar` set; `['None']` yields no beer; `[]` yields the default set; a legacy
  label still resolves.

## Verification before merge

Run the resolver and the generator over real prod-shaped selections, not fixtures alone.
Re-run the check that every distinct recipe ingredient resolves, since beer rows are
being renamed.
