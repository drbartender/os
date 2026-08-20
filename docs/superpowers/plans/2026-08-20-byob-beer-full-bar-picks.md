---
spec: docs/superpowers/specs/2026-08-20-byob-beer-catalog-and-full-bar-picks-design.md
rev: 2  # plan-fleet findings folded in: BeerWineV2 is the live picker; style_key UPDATE not INSERT-only; NA-variant legacy label; resolver shared across 3 surfaces; fixtures move with behavior steps; potions.test.js + lineup script join the footprint
lanes:
  - id: beer-picks
    footprint:
      - server/utils/potionCatalog.js              # + pars100Spirits slice (additive)
      - server/utils/potionCatalog.test.js         # fixtures/SEED_ROWS counts/SNAPSHOT regen in lockstep; + pars100Spirits assertion
      - server/utils/shoppingList.js               # resolveBeerWinePicks resolver; full_bar branch; legacy map; BEER_STYLE_MAP + PARS_100 lockstep renames
      - server/utils/shoppingList.generator.test.js
      - server/utils/shoppingListGen.js            # buildPlannerGeneratorInput + deriveCategoryCounts read the resolver
      - server/utils/lifecycleEmailTemplates.js    # recap email beer/wine lines read the resolver
      - server/scripts/applyBeerCatalog2026.js     # NEW one-time content script (--dry-run flag opt-in, real run default, snapshot, idempotent — lineup convention)
      - server/scripts/applyPackageLineup2026.js   # cross-reference comment ONLY (miller/stella coupling); no behavior change
      - server/routes/potions.test.js              # full-bar preview count assertion (was >= 13; post-change 12)
      - client/src/pages/plan/v2/steps/BeerWineV2.js       # THE LIVE PICKER — BEER_STYLES -> 5 new labels
      - client/src/pages/plan/steps/BeerWineStep.js        # v1 labels follow (vocabulary only)
      - client/src/pages/plan/steps/FullBarBeerWineStep.js # v1 labels follow (vocabulary only)
      - client/src/pages/plan/v2/PlannerV2.js      # DEFAULT_SELECTIONS pre-picks beer/wine
      - README.md                                  # scripts table: applyBeerCatalog2026
      - ARCHITECTURE.md                            # note pars100Spirits slice + resolver
    blockedBy: []
    review: full-fleet   # fires PRE-MERGE per house model, re-confirmed against main's new HEAD at merge; generator seam from the Sidney incident
---

# BYOB beer catalog + full-bar picks — implementation plan (rev 2)

One lane, deliberately. The spec's FIVE-location label agreement (DB `style_key`, the
live v2 picker, two v1 picker arrays, server `BEER_STYLE_MAP`) fails silently on any
mismatch, so the pieces cannot ship separately. Rev 1 of this plan targeted the two v1
picker files and missed the live one — caught by the plan fleet; treat that as the
cautionary tale for every step below: verify which component is MOUNTED, not which
file matches the name.

## The deploy-coupling rule (read first)

**Do NOT touch prod `par_items` during the build.** The live picker still sends the
OLD labels until this deploys; rewriting `style_key` early breaks every in-flight
planner session silently. All catalog writes ride
`server/scripts/applyBeerCatalog2026.js`, run against prod AT deploy, immediately
after the push lands. The legacy label map makes the ordering forgiving in one
direction only: push-before-script is safe (old labels keep resolving), script-before-
push is broken (new rows, old code). The DEV DB is the exception and is sequenced
explicitly in Step 5.

## Step 1 — content script `applyBeerCatalog2026.js`

Pattern-copy `applyPackageLineup2026.js`: `--dry-run` FLAG (opt-in; real run is the
default — that is the lineup script's convention), snapshot prior rows to
`scripts/beer-snapshot-<ts>.json` before writes, idempotent, all in one transaction.

Writes (spec §Buckets):
- UPDATE michelob-ultra   style_key='Light & Easy'
- UPDATE yuengling        style_key='Light & Easy'
- UPDATE corona-light     item='Corona Extra', style_key='Imports', aliases +['corona','corona extra']
- UPDATE ipa-lagunitas-voodoo item='Goose Island IPA', aliases +['goose island','goose island ipa']
- UPDATE athletic-na      style_key='Zero Proof'
- ASSERT white-claw-variety style_key='Seltzer' (no-op guard)
- UPDATE local-craft-beer style_key=NULL
- INSERT miller-lite      ('Miller Lite','24pk',3,'Light & Easy',in_full_bar=false) ON CONFLICT DO NOTHING
- INSERT stella-artois    ('Stella Artois','24pk',3,'Imports',in_full_bar=false) ON CONFLICT DO NOTHING
- **then absolute UPDATE style_key on miller-lite ('Light & Easy') and stella-artois
  ('Imports') — unconditionally, AFTER the inserts.** This is the order-independence
  fix: `applyPackageLineup2026.js` BRANDED_PARS creates the same two ids with
  `style_key=NULL` by design (its :357 insert), so lineup-first + INSERT-only here
  would leave both rows keyless and silently absent from their buckets. With the
  UPDATE, either run order converges. Item/size/qty stay matched to BRANDED_PARS
  (verified: Miller Lite / Stella Artois, 24pk, qty 3).

Add the cross-reference comment in BOTH scripts (applyPackageLineup2026.js is in the
footprint for this comment ONLY).

Checkpoint: `--dry-run` against the DEV DB prints exactly the writes above (9 + 2
style_key updates); diff the miller/stella literals against BRANDED_PARS.

## Step 2 — catalog slice

`buildCatalogSlices`: add `pars100Spirits = bySection.liquorBeerWine.filter(r =>
r.in_full_bar && r.role === 'spirit').map(toSliceRow)`; mirror in `_legacySlices`.
`seedRecipeDrafts.js`'s closed 8-slice parity list tolerates unknown keys (verified) —
leave it; note in the script comment that `pars100Spirits` is deliberately outside its
guard.

Tests IN THIS STEP: `pars100Spirits` assertion (spirit subset of
`pars100.liquorBeerWine`). Existing `pars100` assertions untouched HERE (renames land
in Step 3's lockstep).

Checkpoint: `node --test server/utils/potionCatalog.test.js` green.

## Step 3 — generator + lockstep renames

`shoppingList.js`:
- `resolveBeerWinePicks(selections, servingType)` — exported, pure. Returns
  `{ beer, wine }` per the 3-rule contract (`['None']`→[], `[]`→DEFAULT_BEER_PICKS
  `['Light & Easy']` / DEFAULT_WINE_PICKS `['Red','White']`, else literal). Module
  consts exported for tests.
- `LEGACY_BEER_LABELS`: `'Light / Easy Drinking'`→'Light & Easy', `'Non-Alcoholic'`→
  'Zero Proof', `'Non-Alcoholic (Athletic Brewing)'`→'Zero Proof' (the string the LIVE
  v2 picker stores verbatim — it already misses BEER_STYLE_MAP today), `'Craft /
  Local'`→ the `local-craft-beer` row directly (bucket retired; implement as label
  rewrite + one special-case row push).
- `buildBeerItems`/`buildWineItems`: legacy-map rewrite then group lookup only; they
  receive resolved arrays. 'Other' keeps its skip. Wine style keys unchanged.
- `buildPlannerLists` full_bar branch: `pars100Spirits` + buildBeerItems +
  buildWineItems. `everythingElse` unchanged. Branch structure NOT collapsed.
- LOCKSTEP renames in the same commit: `BEER_STYLE_MAP` → new labels/new rows
  (L&E: Michelob+Miller+Yuengling; Imports: Corona Extra+Stella; IPA: Goose Island;
  Seltzer: White Claw; Zero Proof: Athletic); `PARS_100` constant :91 'Corona / Light'
  → 'Corona Extra'.

`shoppingListGen.js`: `buildPlannerGeneratorInput` (:393) and `deriveCategoryCounts`
(:261) read `resolveBeerWinePicks`. `lifecycleEmailTemplates.js` (:691) beer/wine
lines read it too (fixes the `[]`-is-truthy fallthrough).

Tests IN THIS STEP: fixture label/item flips in `potionCatalog.test.js` (old labels at
~:680/:1749/:2024/:2186, `beerSelections` case :2248), `SEED_ROWS` count assertions
(48/23 shift with Miller+Stella), SNAPSHOT regeneration (regenerate, review the diff —
expected motion: full_bar fixtures gain default beer/wine + lose forced beer; renames
throughout), new generator cases (picks honored; None; []→defaults; both legacy labels
resolve; deriveCategoryCounts on a defaulted plan reports default counts not zero).
`potions.test.js:184` `>= 13` → the new exact count (preview passes no selections →
defaults now apply; expected 12: 5 spirits + 3 beer + 4 wine — assert the REAL number
observed, don't trust this arithmetic).

Checkpoint: `node --test` on potionCatalog, shoppingList.generator, potions.test —
green. (These are fixture-pure / route-test suites; the dev-DB-backed suite runs in
Step 5 AFTER the dev catalog run.)

## Step 4 — client

- **`v2/steps/BeerWineV2.js` `BEER_STYLES` → `['Light & Easy','Imports','IPA',
  'Seltzer','Zero Proof']`.** This is the live picker (PlannerV2.js:336).
- Same array in the two v1 files (vocabulary only; no v1 behavior change).
- `PlannerV2.js` `DEFAULT_SELECTIONS`: beer arrays `['Light & Easy']`, wine arrays
  `['Red','White']` — strings must equal BeerWineV2 chips exactly or the pre-pick
  renders unchecked.
- Verify draft hydration: a saved `[]` merging over the new defaults must not crash;
  either resulting shape converges server-side via the resolver.

Checkpoint: CI client build (`CI=true react-scripts build`) compiles; manual: v2
planner beer step renders 5 chips with Light & Easy pre-checked.

## Step 5 — dev catalog run, DB-backed suite, DoD walk

ORDERED:
1. `applyBeerCatalog2026.js --dry-run` on DEV, review output; then the real run on
   DEV. (Until the lane's code reaches the dev server, dev picks resolve oddly — the
   legacy map isn't deployed there yet; expected, don't chase it from another window.)
2. `seedRecipeDrafts.js --dry-run` Gate D (`[resolve] hard check`) — every recipe
   ingredient still resolves post-rename.
3. `node --test server/routes/drinkPlans/submitPlannerV2.test.js` from repo root, one
   suite at a time (shared dev DB).
4. Prod-shaped regenerates (spec §Verification): one stored legacy-label plan shape,
   one v2 `'Non-Alcoholic (Athletic Brewing)'` shape — diff the beer lines.
5. DoD walk, BOTH directions: defaults-kept submit → Michelob + Miller Lite +
   Yuengling ON the generated list (the None-only walk false-passes a broken seam);
   switch-to-None submit → no beer.

## Merge + deploy runbook

1. Full fleet PRE-MERGE on the lane; merge via `scripts/merge-lane.sh`; suites green
   on merged main; fleet re-confirmed against main's HEAD.
2. Push (Dallas's cue; normal gates).
3. `applyBeerCatalog2026.js` on PROD: `--dry-run`, review, real run — immediately
   after the push lands.
4. Spot-check: regenerate one legacy plan (beer unchanged via legacy map); one live v2
   full-bar walk if a token is available.
5. **Rollback pairing:** `git revert` alone does NOT undo prod rows — pair it with a
   row-restore from `scripts/beer-snapshot-<ts>.json` (lineup-script pattern). Old
   code + new rows does not resolve; the pairing is mandatory, not advisory.

Independent of the deferred full-bar redesign and of `applyPackageLineup2026` gates
1/3 (this script does not write package_items; the miller/stella coupling is handled
by Step 1's absolute UPDATE).
