# Hosted Package-Aware Menu Planner

**Date**: 2026-04-23
**Status**: Design approved, pending implementation plan
**Scope**: Potion Planning Lab — refinement phase on hosted packages. Exploration phase unchanged.

## Problem

The Potion Planning Lab (`client/src/pages/plan/PotionPlanningLab.js`) was built before hosted packages were given priority. In refinement, for a client who has paid a deposit on a hosted package (e.g. *The Enhanced Solution*), the planner:

1. Asks them to re-pick a serving style in `QuickPickStep` — redundant, the package already determines it.
2. Asks them to check off spirits from a fixed 6-item list (`FullBarSpiritsStep`) — the spirits are already fixed by the package.
3. Asks them to pick beer and wine styles (`FullBarBeerWineStep` / `BeerWineStep`) — also fixed by the package.
4. Asks them "do you want mixers?" inside `SignaturePickerStep` — mixers are included in every hosted full-bar package.
5. Presents a cocktail menu "filthy with premium ingredients" — Moscow Mule (ginger beer), Negroni (Campari + sweet vermouth), Aperol Spritz, Sidecar, Last Word, Mai Tai, Smokey Piña, Sazerac, and more — none of which are stocked in the hosted packages below *The Grand Experiment*. The client picks a Moscow Mule and the planner silently assumes it's available.
6. Can offer add-ons the client already paid for — e.g. `soft-drink-addon` on a package that already includes Coke, Sprite, etc.

Nothing warns the client that their drink picks need ingredients the package doesn't stock. The bartender discovers the gap at setup, and the admin eats the cost or scrambles to charge an upgrade after the fact.

## Goal

Teach the planner which package the client is on and reshape the refinement flow so that:

- Steps that duplicate package decisions are hidden.
- A compact "your package includes" recap makes the fixed catalog visible at pick time.
- Each cocktail that requires ingredients outside the package surfaces a clear "not in your package · +$X/guest" badge, and picking it auto-adds the relevant upgrade add-on to the proposal with a toast confirmation.
- Add-ons the package already covers are suppressed from every offer point.
- BYOB packages are untouched — the current flow still fits them.
- Exploration phase is untouched — package isn't yet locked in.

The client sees a planner that matches what they paid for. The admin sees the auto-added upgrades labelled as such on the proposal, so case-by-case decisions still land in their lap without surprise.

## Non-goals

- No automatic "swap" system (drop unused spirits, add specialty ingredients). Explicitly ruled out by the user — swap rules are brittle and context-dependent. Every gap becomes a transparent upgrade instead.
- No blocking modals. Toasts and inline badges only.
- No changes to the exploration phase. Still shows the full cocktail menu, no gap flags.
- No changes to BYOB flow. The `applies_to = 'byob'` addon filter already handles BYOB vs. hosted add-on visibility.
- No admin "unbundle this auto-add-on from the drink" button in v1. Admin edits via existing proposal-edit flow.
- No new mocktail logic. Mocktail pricing is already add-on-driven; the gap model doesn't apply.

## Flow changes (hosted refinement only)

Detection: `plan.package_category === 'hosted'` AND `derivePhase(plan.proposal_status) === 'refinement'`. The `package_category` field is exposed by the drink-plans GET route alongside the existing `package_bar_type`.

### Steps removed from the queue

- `QuickPickStep` — routing decided by `package_bar_type`:
  - `full_bar` → signature cocktails, mocktails, guest prefs, menu design, logistics
  - `beer_and_wine` → mocktails, guest prefs, menu design, logistics (no signature cocktails)
  - `mocktail` → mocktails, guest prefs, menu design, logistics (existing auto-route preserved)
- `FullBarSpiritsStep` — spirits fixed by package.
- `FullBarBeerWineStep` — beer/wine styles fixed by package.
- `BeerWineStep` — same.
- The "Would you like mixers?" radio group inside `SignaturePickerStep` — hosted packages always include mixers.

### Step added

- `HostedGuestPrefsStep` — one compact card, reuses the existing `BALANCE_OPTIONS` (mostly beer / mostly cocktails / mostly wine / balanced / help me decide). Drives how much of each category we stock from the fixed catalog. Stored as `selections.guestPreferences = { balance: '...' }`. On `beer_and_wine` bar type, adds a follow-up: *"Will any guest not drink beer or wine?"* → nudges toward `pre-batched-mocktail` or `non-alcoholic-beer` add-ons (not forced).

### Step modified

- `RefinementWelcomeStep` — package-recap card inserted below the welcome copy (details in next section).
- `SignaturePickerStep` — gap badges on cards, auto-add-on wiring, toast-on-select, "Your Menu" items show upgrade nested beneath the drink.
- `ConfirmationStep` — Estimated Costs block renders auto-added upgrades nested under their triggering drink; other add-ons (champagne toast, real glassware, etc.) render flat as today.
- `MakeItYoursPanel` — if the package already covers a per-drink addon (e.g. Grand Experiment covers `house-made-ginger-beer`), that addon option is suppressed for that drink. The syrup/flair experience is otherwise unchanged.

### Exploration phase

Unchanged. Queue: `stepVibe → stepFlavorDirection → stepExplorationBrowse → stepMocktailInterest → explorationSave`. Full cocktail menu, no gap flags. Package-aware behavior activates only in refinement.

## Cocktail gap UX (hosted refinement)

### Package recap card

On `RefinementWelcomeStep` and at the top of `SignaturePickerStep`, a card:

> **Your package: *The Enhanced Solution***
> *Stocked & ready:* Tito's Vodka • Bombay Sapphire Gin • Bacardi Rum • Jim Beam Bourbon • 1800 Blanco • Johnnie Walker Red • Yuengling • Miller Lite • Michelob Ultra • 2 reds, 2 whites, sparkling • Coke/Diet/Sprite • Ginger Ale • Club Soda • Tonic • OJ / cranberry / pineapple • simple syrup • lemon / lime juice • bitters • bottled water
> *Anything beyond this list is an upgrade.*

Source: `service_packages.includes` JSONB (already rendered in proposal view). The recap strips service-terms placeholders (`{hours}`, `{bartenders}`) so only consumables show.

### Cocktail card badge

For each cocktail card in `SignaturePickerStep` and (refinement-phase) `ExplorationBrowseStep`:

- Compute `gap = cocktail.upgrade_addon_slugs - package.covered_addon_slugs`.
- **No gap** → card renders as today.
- **Gap** → small amber badge inline with the drink name: `Not in your package · +$2.50/guest` (sum of per-guest rates on gap add-ons). Full price on click-into panel.

### Auto-add on select

When the client toggles ON a gap cocktail:

1. Cocktail added to `selections.signatureDrinks`.
2. For each `slug` in gap: `selections.addOns[slug] = { enabled: true, autoAdded: true, triggeredBy: [cocktailId, ...] }`. If the addon was already present with `autoAdded: true`, append the cocktailId to `triggeredBy`. If it was already present WITHOUT `autoAdded` (client added it deliberately), leave `autoAdded: false` and append `triggeredBy` anyway for provenance.
3. Toast (via `useToast`): *"Added Moscow Mule · includes $2.50/guest for house-made ginger beer."*

When the client toggles OFF a gap cocktail:

- Remove cocktailId from each upgrade's `triggeredBy`.
- If `triggeredBy` becomes empty AND `autoAdded === true`, delete the addon entry. The existing `pruneAddOnsForRemovedDrinks` helper is extended to handle this `autoAdded` + `triggeredBy` shape.
- If the addon was user-added (`autoAdded: false`), leave it on regardless of `triggeredBy`.

### "Your Menu" + Confirmation display

In the "Your Menu" review inside `SignaturePickerStep`, each drink row with an auto-added upgrade shows a small nested sub-row:

```
1. 🫙 Moscow Mule              [×]
     Includes + House-Made Ginger Beer · $2.50/guest
```

`ConfirmationStep`'s Estimated Costs block renders auto-added upgrades nested beneath the drink:

```
Moscow Mule
  + House-Made Ginger Beer  · $2.50/guest × 100 guests      $250.00

Negroni
  + Bitter Aperitifs  · $3.00/guest × 100                   $300.00
  + Vermouth & Fortified  · $1.50/guest × 100               $150.00
```

Non-auto addons (champagne toast, real glassware, additional bartender, etc.) keep the existing flat row format.

## Add-on suppression

Filter rule applied everywhere add-ons are offered to the client in the planner:

> An add-on is hidden if its slug is in `package.covered_addon_slugs`.

Touchpoints:

- `MakeItYoursPanel` (per-drink featured + flair addons)
- `SignaturePickerStep` Estimated Costs summary (the bottom-of-menu block)
- `MocktailStep` addon list
- `LogisticsStep` (champagne toast, real glassware, parking, bar rental — only rendered if not covered)
- `ConfirmationStep` (doesn't need filtering — it only lists what's selected — but the `covered_addon_slugs` helps mark "included" context)

BYOB packages: `covered_addon_slugs` is empty by default; current behavior preserved.

## Data model

Three schema additions. Each idempotent, in `server/db/schema.sql`.

### `service_packages` — what this package already covers

```sql
ALTER TABLE service_packages
  ADD COLUMN IF NOT EXISTS covered_addon_slugs TEXT[] DEFAULT '{}';
```

Seeded at the bottom of `schema.sql`:

```sql
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-base-compound';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                WHERE slug = 'the-midrange-reaction';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                WHERE slug = 'the-enhanced-solution';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                WHERE slug = 'formula-no-5';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon, house-made-ginger-beer}' WHERE slug = 'the-grand-experiment';
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-primary-culture';
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-refined-reaction';
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-carbon-suspension';
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-cultivated-complex';
UPDATE service_packages SET covered_addon_slugs = '{}'                               WHERE slug = 'the-clear-reaction';
```

### `cocktails` — what this drink needs beyond the basics

```sql
ALTER TABLE cocktails
  ADD COLUMN IF NOT EXISTS upgrade_addon_slugs TEXT[] DEFAULT '{}';
```

Seeded via `UPDATE cocktails SET upgrade_addon_slugs = '{...}' WHERE id = '...'` blocks. Starting map is conservative — cheap gaps (grapefruit juice for a Paloma, triple sec for a Margarita, prosecco-for-champagne sub on French 75) are absorbed by DRB, not billed. Admin adjusts via `CocktailsDashboard` as real cost data comes in.

| Cocktail | Needs | `upgrade_addon_slugs` |
|---|---|---|
| `moscow-mule` | ginger beer | `{house-made-ginger-beer}` |
| `espresso-martini` | coffee liqueur (Kahlúa) + espresso | `{specialty-niche-liqueurs}` |
| `aperol-spritz` | Aperol (prosecco sub'd from pkg sparkling) | `{specialty-bitter-aperitifs}` |
| `sidecar` | cognac + orange liqueur | `{specialty-cognac, specialty-niche-liqueurs}` |
| `martini` | dry vermouth | `{specialty-vermouths}` |
| `manhattan` | sweet vermouth | `{specialty-vermouths}` |
| `negroni` | Campari + sweet vermouth | `{specialty-bitter-aperitifs, specialty-vermouths}` |
| `amaretto-sour` | amaretto | `{specialty-niche-liqueurs}` |
| `smokey-pina` | mezcal | `{specialty-mezcal}` |
| `boulevardier` | Campari + sweet vermouth | `{specialty-bitter-aperitifs, specialty-vermouths}` |
| `black-manhattan` | amaro | `{specialty-bitter-aperitifs}` |
| `sazerac` | rye + absinthe + Peychaud's | `{specialty-niche-liqueurs}` |
| `mai-tai` | orgeat | `{specialty-niche-liqueurs}` |
| `paper-plane` | Aperol + amaro | `{specialty-bitter-aperitifs}` |
| `corpse-reviver` | Lillet + Cointreau + absinthe | `{specialty-vermouths, specialty-niche-liqueurs}` |
| `last-word` | green Chartreuse + maraschino | `{specialty-niche-liqueurs}` |
| `paloma`, `french-75`, `margarita`, `cosmopolitan`, `daiquiri`, etc. | small/absorbable gaps or fully covered | `{}` |

"Absorbed" means DRB brings the small extra (grapefruit juice, triple sec) without passing cost to the client — matches existing informal practice. Admin moves any cocktail from `{}` to an upgrade bucket when a specific drink's gap turns out to hurt margin.

### Specialty-ingredient add-ons — new catalog

New `service_addons` rows, `category = 'craft_ingredients'`, `applies_to = 'all'`, `billing_type = 'per_guest'`. AI-estimated v1 rates (admin tunes later):

| Slug | Name | Rate/guest | Covers |
|---|---|---|---|
| `specialty-bitter-aperitifs` | Bitter Aperitifs | $3.00 | Campari, Aperol, Cynar, amaro |
| `specialty-vermouths` | Vermouth & Fortified Wines | $1.50 | Sweet & dry vermouth, Lillet |
| `specialty-niche-liqueurs` | Specialty Liqueurs | $2.50 | Cointreau, Chartreuse, maraschino, amaretto, orgeat, absinthe, rye, coffee liqueur, grapefruit soda |
| `specialty-mezcal` | Mezcal | $3.00 | Mezcal (as base spirit) |
| `specialty-cognac` | Cognac | $4.00 | Cognac (as base spirit) |

`house-made-ginger-beer` stays as-is ($2.50/guest).

Descriptions follow the existing tone in `service_addons.description`. Per-guest rates are consistent with DRB's bring-and-take-back model — the user explicitly ruled out flat per-event pricing because flat implies the client keeps the bottle.

### Computation helpers

New helpers in `server/utils/pricingEngine.js`:

```js
function computeCocktailGap(cocktail, pkg) {
  const required = cocktail.upgrade_addon_slugs || [];
  const covered = pkg?.covered_addon_slugs || [];
  return required.filter(slug => !covered.includes(slug));
}

function packageSuppressedAddons(pkg) {
  return pkg?.covered_addon_slugs || [];
}

function isCocktailFullyCovered(cocktail, pkg) {
  return computeCocktailGap(cocktail, pkg).length === 0;
}
```

Client-side mirror in new `client/src/pages/plan/data/packageGaps.js` — pure, no DB, operates on the plan data already in `PotionPlanningLab`'s state.

## API surface

### `GET /api/drink-plans/t/:token`

Extend the SELECT (currently sending only `sp.bar_type AS package_bar_type`):

```sql
SELECT
  dp.* ...,
  sp.bar_type           AS package_bar_type,
  sp.category           AS package_category,
  sp.slug               AS package_slug,
  sp.name               AS package_name,
  sp.includes           AS package_includes,
  sp.covered_addon_slugs AS package_covered_addon_slugs
FROM drink_plans dp
LEFT JOIN proposals p ON ...
LEFT JOIN service_packages sp ON ...
```

### `GET /api/cocktails`

Already returns `ingredients` JSONB via `SELECT c.*`. Adding `upgrade_addon_slugs` to the `cocktails` table means `SELECT c.*` picks it up automatically — no route change needed. Confirm via the `/admin` variant too (same shape).

### `GET /api/proposals/public/addons`

No shape change. Client filters client-side using `package_covered_addon_slugs` received from the plan data. Keeps the addons route cacheable/shared.

### `PUT /api/drink-plans/t/:token` (submit reconciliation)

The existing addon-upsert block in the submit branch (around lines 128–310 of `server/routes/drinkPlans.js`) gets a sanity pass:

- For each `selections.addOns[slug]` where `autoAdded === true`: re-verify the slug is still in at least one selected cocktail's `upgrade_addon_slugs` AND not in the package's `covered_addon_slugs`. If not, drop it before upsert. Handles stale drafts where the client toggled off the trigger drink without the client state catching up.
- `proposal_activity_log` entry adds a `specialty_upgrades` array: `[{ slug, addonName, triggeredBy: [cocktailIds] }]`.

## Notifications + copy

Toast wording (via existing `useToast`):

- On select: `Added Moscow Mule · includes $2.50/guest for house-made ginger beer.`
- If multiple gap addons for one drink: `Added Negroni · includes $4.50/guest total for bitter aperitifs + vermouth.`
- On deselect (when the auto-addon is removed because it has no remaining triggers): no toast. Silent.

Package recap copy: pulled dynamically from the package's `includes` JSONB — no hardcoded package descriptions in code.

## Mocktails on hosted

- **`bar_type = 'mocktail'`** (e.g. *The Clear Reaction*): existing auto-route to mocktail step stays. Package recap card shows the mocktail package's included items. `pre-batched-mocktail` / `mocktail-bar` / `non-alcoholic-beer` / `zero-proof-spirits` add-ons remain offered.
- **Mocktails on full-bar hosted**: `MocktailStep` still appears in the queue when `activeModules.mocktails === true`. Mocktails have no gap model (they're made from syrups + soda + citrus and priced as add-ons). No `upgrade_addon_slugs` on mocktail rows.

## NA beer copy cleanup

Separately from the gap logic, correct the `non-alcoholic-beer` addon description per the "Athletic only, never Heineken 0.0" rule:

```sql
UPDATE service_addons
SET description = 'Non-alcoholic beer from Athletic Brewing — crisp, refreshing, and endorsed by the doctor.'
WHERE slug = 'non-alcoholic-beer';
```

Current seed includes "Heineken 0.0" which violates the rule. One-line cleanup shipped in the same change.

## Admin side (ProposalDetail)

Two touches:

1. **Auto-added badge.** In the proposal's add-ons list, each auto-added specialty add-on carries a small badge: `Auto-added · from Moscow Mule`. Rendered from the `autoAdded` + `triggeredBy` metadata already stored in `selections.addOns`. One-liner render change in `ProposalDetail.js`.
2. **Activity-log detail.** The `drink_plan_addons_added` event in the Activity tab grows a `specialty_upgrades` section listing auto-added slugs and the drinks that triggered them (payload written in the submit reconciliation).

No new admin UI beyond these touches. Admin edits case-by-case through the existing proposal-edit flow.

## Admin data entry (Cocktails + Packages dashboards)

- `CocktailsDashboard` / cocktail edit form: new multi-select field *Upgrade add-ons* (reads `service_addons` where `category IN ('craft_ingredients', 'beverage')`). Persists as `upgrade_addon_slugs TEXT[]`.
- Package-edit UI (settings dashboard or wherever packages are managed): new multi-select *Covered add-ons* for each package. Persists as `covered_addon_slugs TEXT[]`.

Both fields default to empty and are safe no-ops when blank — existing packages and cocktails continue to work without admin action.

## Cross-cutting consistency

Per `CLAUDE.md` rules:

- Schema touch → update every SELECT / INSERT / UPDATE and every client component that reads package or cocktail data. Search grid:
  - `service_packages` new column → update the drink-plan SELECT (above), any admin package-list queries, `ProposalCreate.js` package selector (no UI change needed, but confirm shape), proposal snapshot JSONB (no change — snapshot is pricing, not coverage).
  - `cocktails` new column → `SELECT c.*` endpoints pick it up automatically; confirm `shopping-list-data` route (line 427 of `drinkPlans.js`) still works — it selects `id, name, ingredients` only, so it's unaffected. `generateShoppingList.js` on the client reads `ingredients`, unaffected.
  - `service_addons` new rows → no schema change, just seed data. All existing queries continue to work.
- Doc updates: CLAUDE.md, README.md, ARCHITECTURE.md get folder-tree entries for the new `HostedGuestPrefsStep`, new `packageGaps.js` helper, and new schema columns.
- Hosted package rule (existing, load-bearing): this work does NOT touch bartender pricing, but the `isHostedPackage` helper gets a sibling (`computeCocktailGap`, etc.) in the same file. Keep them next to each other so grep `isHostedPackage` still finds everything money-related.

## Files touched

| Category | File | Change |
|---|---|---|
| Schema | `server/db/schema.sql` | 2 ALTER TABLE, 5 INSERT (specialty add-ons), ~12 UPDATE (seed + NA copy) |
| Server util | `server/utils/pricingEngine.js` | Add `computeCocktailGap`, `packageSuppressedAddons`, `isCocktailFullyCovered` |
| Server route | `server/routes/drinkPlans.js` | Extend SELECT on GET; sanity-check `autoAdded` addons on PUT submit; log `specialty_upgrades` |
| Client data | `client/src/pages/plan/data/packageGaps.js` | New — pure helpers mirroring server |
| Client orchestrator | `client/src/pages/plan/PotionPlanningLab.js` | Detect hosted+refinement; skip quick-pick, spirits, beer/wine steps; route to `HostedGuestPrefsStep`; propagate package context |
| Client steps | `client/src/pages/plan/steps/HostedGuestPrefsStep.js` | New — replaces 3 killed steps |
| Client steps | `client/src/pages/plan/steps/RefinementWelcomeStep.js` | Add package recap card |
| Client steps | `client/src/pages/plan/steps/SignaturePickerStep.js` | Gap badges, auto-add-on wiring, toast, nested display; remove mixer radio group on hosted |
| Client steps | `client/src/pages/plan/steps/MakeItYoursPanel.js` | Suppress addons already covered by package |
| Client steps | `client/src/pages/plan/steps/MocktailStep.js` | Addon list filter (uses `packageSuppressedAddons`) |
| Client steps | `client/src/pages/plan/steps/LogisticsStep.js` | Addon filter (champagne toast, real glassware still offered unless covered) |
| Client steps | `client/src/pages/plan/steps/ConfirmationStep.js` | Nested rendering for auto-added upgrades |
| Client admin | `client/src/pages/admin/ProposalDetail.js` | Auto-added badge; activity-log detail |
| Client admin | `client/src/pages/admin/CocktailMenuDashboard.js` + edit form | Multi-select for `upgrade_addon_slugs` |
| Client admin | `client/src/pages/admin/SettingsDashboard.js` or package-edit UI | Multi-select for `covered_addon_slugs` |
| Docs | CLAUDE.md, README.md, ARCHITECTURE.md | Folder-tree additions, schema-column additions, add-on catalog reference |

## Test plan (functional outline)

- Client on `the-enhanced-solution` picks Moscow Mule → card badge shows `Not in your package · +$2.50/guest`, toast fires, `selections.addOns['house-made-ginger-beer']` gets `autoAdded: true, triggeredBy: ['moscow-mule']`, deselects → addon removed.
- Client on `the-grand-experiment` picks Moscow Mule → no badge (covered), no auto-add, no toast. `house-made-ginger-beer` not offered anywhere as a separate addon.
- Client on `the-base-compound` picks Negroni → badge shows `Not in your package · +$4.50/guest` (sum of the two specialty addons); both addons auto-add with `triggeredBy: ['negroni']`. Picks Boulevardier too → both addons' `triggeredBy` gets `'boulevardier'` appended. Deselects Negroni → addons remain (still triggered by Boulevardier). Deselects Boulevardier → both addons removed.
- Client deliberately toggles on `house-made-ginger-beer` at the Estimated Costs panel (manual), then picks Moscow Mule → addon gets `triggeredBy: ['moscow-mule']` appended but `autoAdded` stays `false`. Deselecting Moscow Mule leaves the addon on.
- Hosted flow renders no QuickPick, no FullBarSpirits, no FullBarBeerWine, no BeerWineOnly, no mixer radio group. Renders the new `HostedGuestPrefsStep`. Step numbers correct.
- BYOB flow unchanged — all the old steps still appear.
- Exploration phase unchanged — no gap badges, full menu visible, even when a hosted package is linked to the proposal.
- ConfirmationStep Estimated Costs: auto-added upgrades nested beneath drinks, other addons flat.
- ProposalDetail shows auto-added badge + activity-log detail after submission.
- `soft-drink-addon` suppressed on hosted full-bar packages 2+. Offered on hosted mocktail package (no mixers there). Offered on BYOB.

## Open questions / intentional deferrals

- **Admin data-entry UI polish**: multi-select components reuse the existing addon-picker pattern in `ProposalCreate.js`; no new UI primitives. Exact visual design deferred to implementation.
- **Rate tuning**: v1 AI-estimated specialty rates are placeholders. User will adjust via admin addon-edit as real data comes in.
- **Cocktail-level upgrade overrides**: v1 uses bucketed specialty add-ons. If a specific drink needs unique pricing (e.g. a cocktail using rare aged rum that doesn't fit any bucket), admin can create a new single-purpose addon and add it to that cocktail's `upgrade_addon_slugs`. No schema change needed.
- **Mocktail gap flags**: not applicable in v1 — mocktails are add-on-driven already. Revisit if/when mocktails get specialty-ingredient variants.
- **Menu design / shopping list regeneration**: the existing `generateShoppingList.js` reads `ingredients` JSONB per cocktail. When an auto-added upgrade covers an ingredient, the shopping list already reflects the actual bottle needed via the `ingredients` data. No change in v1; may revisit if shopping list misses an edge case.
