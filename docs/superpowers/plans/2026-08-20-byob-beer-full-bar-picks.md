---
spec: docs/superpowers/specs/2026-08-20-byob-beer-catalog-and-full-bar-picks-design.md
rev: 1
lanes:
  - id: beer-picks
    footprint:
      - server/utils/potionCatalog.js              # + pars100Spirits slice (additive; pars100 untouched)
      - server/utils/potionCatalog.test.js         # new-label fixtures + pars100Spirits assertions; pars100 parity UNCHANGED
      - server/utils/shoppingList.js               # full_bar branch honors picks; 3-rule selection handling; legacy label map; BEER_STYLE_MAP + defaults to new labels
      - server/utils/shoppingList.generator.test.js # full-bar-honors-picks / None / empty-default / legacy-label coverage
      - server/scripts/applyBeerCatalog2026.js     # NEW one-time content script (lineup-script pattern: dry-run default, snapshot, idempotent)
      - client/src/pages/plan/steps/BeerWineStep.js        # BEER_STYLES -> 5 new labels
      - client/src/pages/plan/steps/FullBarBeerWineStep.js # BEER_STYLES -> 5 new labels
      - client/src/pages/plan/v2/PlannerV2.js      # DEFAULT_SELECTIONS pre-picks beer/wine
      - README.md                                  # scripts table: applyBeerCatalog2026
      - ARCHITECTURE.md                            # note pars100Spirits slice
    blockedBy: []
    review: full-fleet   # touches the shopping-list generator seam that produced the Sidney incident; client-facing artifact correctness
---

# BYOB beer catalog + full-bar picks — implementation plan

One lane, deliberately. The spec's four-location label agreement (DB `style_key`,
two client `BEER_STYLES` arrays, server `BEER_STYLE_MAP`) fails silently on any
mismatch, so the pieces cannot ship separately.

## The deploy-coupling rule (read first)

**Do NOT touch prod `par_items` during the build.** The live picker still sends the
OLD labels until this deploys; rewriting `style_key` early breaks every in-flight
planner session silently. All catalog writes ride
`server/scripts/applyBeerCatalog2026.js`, run against prod AT deploy, immediately
after the push lands. Dev DB may run it earlier for verification (dev is where the
suites point). The legacy label map makes the ordering forgiving in one direction
only: new code + old rows still resolves (legacy map covers old labels; new labels
absent from the map just means picker-vs-rows agree once the script runs). Old code +
new rows does NOT. Script before push = broken; push before script = fine (legacy
map covers the gap window).

## Step 1 — content script `applyBeerCatalog2026.js`

Pattern-copy `applyPackageLineup2026.js`: `--dry-run` default off (match its flag
convention: dry-run flag prints + rolls back in-tx), snapshot prior rows to
`scripts/beer-snapshot-<ts>.json` before writes, idempotent (`ON CONFLICT (id) DO
NOTHING` for creates, absolute UPDATEs for renames/keys so re-runs converge).

Writes (spec §Buckets):
- UPDATE michelob-ultra   style_key='Light & Easy'
- UPDATE yuengling        style_key='Light & Easy'
- UPDATE corona-light     item='Corona Extra', style_key='Imports', aliases +['corona','corona extra']
- UPDATE ipa-lagunitas-voodoo item='Goose Island IPA', aliases +['goose island','goose island ipa']  (style_key stays 'IPA')
- UPDATE athletic-na      style_key='Zero Proof'
- UPDATE white-claw-variety (no-op guard; asserts style_key='Seltzer')
- UPDATE local-craft-beer style_key=NULL
- INSERT miller-lite      ('Miller Lite','24pk',3,'Light & Easy',in_full_bar=false)
- INSERT stella-artois    ('Stella Artois','24pk',3,'Imports',in_full_bar=false)

miller-lite / stella-artois definitions MUST stay byte-identical to
`applyPackageLineup2026.js` BRANDED_PARS (both use ON CONFLICT DO NOTHING; whichever
runs second is a no-op). Add a comment in BOTH scripts pointing at each other.

Beer rows keep `in_full_bar` exactly as they are today (spec: consult path + parity
untouched). New rows are created `in_full_bar=false`.

## Step 2 — catalog slice

`buildCatalogSlices`: add `pars100Spirits = bySection.liquorBeerWine.filter(r =>
r.in_full_bar && r.role === 'spirit').map(toSliceRow)`. Export in the returned
object; mirror in `_legacySlices` (spirit rows of PARS_100.liquorBeerWine). Parity
test gains an assertion that `pars100Spirits` equals the spirit subset; existing
`pars100` assertions UNCHANGED.

## Step 3 — generator

`shoppingList.js`:
- `BEER_STYLE_MAP` keys -> new labels; rows -> new items (Light & Easy: Michelob +
  Miller Lite + Yuengling; Imports: Corona Extra + Stella; IPA: Goose Island;
  Seltzer: White Claw; Zero Proof: Athletic). This is the DB-read-failure fallback;
  it must mirror the script's end state.
- `LEGACY_BEER_LABELS = { 'Light / Easy Drinking': 'Light & Easy', 'Non-Alcoholic':
  'Zero Proof', 'Craft / Local': <local-craft-beer row> }`. Craft maps to the row
  directly (its bucket no longer exists); implement as a pre-resolution label rewrite
  plus one special-case row push.
- `buildBeerItems` / `buildWineItems` 3-rule contract: `['None']` -> nothing; `[]` ->
  DEFAULT_BEER_PICKS / DEFAULT_WINE_PICKS (module consts: `['Light & Easy']`,
  `['Red','White']`); else honor. Rewrite through the legacy map before lookup.
- `buildPlannerLists` `full_bar` branch: `liquorBeerWine =
  scaleItems(slices.pars100Spirits, ...)` then push `buildBeerItems` +
  `buildWineItems` results. `everythingElse` unchanged (mixers/garnish/supplies keep
  the pars100 baseline). Branch structure NOT collapsed (spec non-goal: full-bar
  redesign seams stay).

Wine: `wineStyleMap` keys (Red/White/Sparkling) are unchanged; only the empty-array
default is new. 'Other' keeps its current skip behavior.

## Step 4 — client

- Both `BEER_STYLES` arrays -> `['Light & Easy','Imports','IPA','Seltzer','Zero Proof']`.
- `PlannerV2.js` `DEFAULT_SELECTIONS`: `beerFromFullBar/beerFromBeerWine:
  ['Light & Easy']`, `wineFromFullBar/wineFromBeerWine: ['Red','White']`.
- Check hydration: PlannerV2 merges saved drafts over defaults — a draft saved with
  `[]` must NOT be resurrected into the default (server treats `[]` as
  fall-back-to-default anyway, so both roads lead to the same list; just verify the
  merge doesn't crash on the new shape).

## Step 5 — tests + verification

- Suites: `potionCatalog.test.js`, `shoppingList.generator.test.js`,
  `submitPlannerV2.test.js` (grep for other generator callers per house rule), CI
  client build.
- New generator cases (spec §Testing): picks honored on full_bar; None; empty ->
  defaults; legacy 'Craft / Local' resolves to Local Craft Beer; legacy
  'Light / Easy Drinking' resolves to the Light & Easy group.
- Post-script (dev DB): re-run the all-recipe-ingredients-resolve check (beer renames
  touch the alias index).
- DoD walk: v2 planner full-bar flow on dev — defaults pre-picked on the beer/wine
  step, switch to None, submit, generated list carries no beer.

## Deploy runbook

1. Merge lane, suites green on merged main.
2. Push (Dallas's cue; normal gates).
3. Run `applyBeerCatalog2026.js` on PROD (dry-run, then real) immediately after.
4. Spot-check: one legacy plan regenerate (beer unchanged via legacy map), one new
   full-bar dev... prod token walk if available.

Independent of the deferred full-bar redesign and of `applyPackageLineup2026` gates
1/3 (this script does not write package_items).
