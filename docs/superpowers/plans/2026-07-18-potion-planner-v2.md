---
spec: docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md
designs: win-share/'Recipe card design.zip' (recipe card 1a+1b, package editor), 'Planner v2 and enhancement lab.zip', 'Quantity review.zip'
lanes:
  - id: pp2-core
    footprint:
      - server/db/schema.sql                       # ALL project schema deltas ship here
      - server/utils/coverageEngine.js             # new, pure: drink-vs-package coverage + gap pricing
      - server/utils/coverageEngine.test.js
      - server/utils/quantityEngine.js             # new, pure: demand model (drinkers x hours x pace, weights, buffers)
      - server/utils/quantityEngine.test.js
      - server/scripts/migrateDrinkMeta.js         # one-time: drinkUpgrades.js + DRINK_SYRUP_MAP -> DB
      - server/routes/potions.js                   # recipes CRUD gains new drink fields
      - server/routes/potions.test.js
      - server/routes/packages.js                  # new: admin package-contents CRUD + makeability + margin
      - server/routes/packages.test.js
      - server/index.js                            # mount /api/admin/packages
      - server/routes/admin/settings.js            # buffer + pace-constant settings
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet          # schema + pricing-adjacent engines
  - id: pp2-recipe-card
    footprint:
      - client/src/components/potions/RecipeEditor.js        # v2 dossier (design 1b drawer layout)
      - client/src/components/potions/RecipeEditorSections.js # new sibling: enhancements/flags/syrup sections (ratchet)
      - client/src/pages/admin/potions/RecipesTab.js         # design 1a: batch-pass session strip
      - client/src/pages/admin/potions/PantryParsTab.js      # par cost column surface
      - client/src/pages/admin/PotionsPage.js                # Menu-tab "[object Object]" cosmetic fix rides here
      - client/src/pages/admin/CocktailMenuDashboard.js      # only if the cosmetic bug lives here after diagnosis
    blockedBy: [pp2-core]
    review: light               # admin UI, no money
  - id: pp2-package-editor
    footprint:
      - client/src/pages/admin/potions/PackagesTab.js        # new: 4th Potions tab (design)
      - client/src/pages/admin/potions/PackageDetail.js      # new: contents editor + margin rail
      - client/src/pages/admin/potions/MakeabilityPanel.js   # new: in-tier / fenced / unmakeable rail
      - client/src/pages/admin/PotionsPage.js                # add tab (shared with pp2-recipe-card; merge order handles)
    blockedBy: [pp2-core]
    review: light               # displays money, never charges
  - id: pp2-quantity-review
    footprint:
      - server/utils/shoppingListGen.js            # consume crowd answers + quantityEngine; admin-set hold markers
      - server/utils/shoppingList.js               # derivation metadata on generated lists
      - server/utils/shoppingList.generator.test.js
      - client/src/components/ShoppingList/ShoppingListModal.jsx   # design: derivation strip, buffers, client-view toggle
      - client/src/components/ShoppingList/DerivationStrip.jsx     # new sibling (ratchet: modal is 713 lines)
      - client/src/pages/public/ClientShoppingList (route component) # plain-language render + padding sentence + specialty guidance
    blockedBy: [pp2-core]
    review: standard            # generator drives ops; no payment paths
  - id: pp2-planner
    footprint:
      - client/src/pages/plan/PotionPlanningLab.js # version router + v2 orchestrator
      - client/src/pages/plan/v2/**                # new step components (welcome, quickpick, drinks, stocking, crowd, menu, dayof, review, celebration)
      - client/src/pages/plan/steps/**             # legacy kept mounted for planner_version<2 drafts; MakeItYoursPanel/CustomSetupStep no longer reachable from v2
      - client/src/index.css                       # potion-* additions; conf-leader block finally mounted
      - server/routes/drinkPlans.js                # serve planner_version + package/coverage payload on GET t/:token
      - server/routes/drinkPlans/submit.js         # allow-list additions; fence picks -> existing gap-addon/extras path; echo email trigger
      - server/routes/drinkPlans/submit.test.js
      - server/utils/lifecycleEmailTemplates.js    # submission echo email (full selections)
      - server/utils/drinkPlanNudge.js             # copy touch only (planner language)
    blockedBy: [pp2-core]
    review: full-fleet          # submit money path + selections contract
  - id: pp2-lab
    footprint:
      - client/src/pages/plan/EnhancementLab.js    # new page + route /plan/:token/lab
      - client/src/pages/plan/lab/**               # shelf components, balance banner, states
      - client/src/App.js                          # route registration (all four host blocks)
      - server/routes/drinkPlans/lab.js            # new: GET/PUT t/:token/lab (requireUuidToken, approval-gated)
      - server/routes/drinkPlans/lab.test.js
      - server/utils/drinkPlanExtras.js            # additions ride computeExtrasBreakdown; invoice refresh reuse
      - server/utils/lifecycleEmailTemplates.js    # Lab follow-up email template (shared file; serialize after pp2-planner)
      - server/utils/messageScheduling.js          # schedule follow-up on submit; cancel on approval/addition
      - server/utils/scheduledMessageDispatcher.js # dispatch handler for lab_followup
      - server/routes/drinkPlans.js                # approval closes Lab window (status read)
    blockedBy: [pp2-planner]
    review: full-fleet          # writes addOns post-submit + invoice refresh = money
---

# Potion Planner v2 Implementation Plan

> **For agentic workers:** execute lane-by-lane per the front-matter graph (this repo's lane model; superpowers:executing-plans semantics apply within a lane). Every lane re-reads the spec section it implements before building.

**Goal:** Ship the planner/selling split end to end: recipe-derived package coverage, the v2 client planner (no money), the Enhancement Lab (invoice-only selling), and the instrumented quantity review, per the 2026-07-18 spec.

**Architecture:** One core lane lands all schema + two pure engines (coverage, quantity) behind tests; three admin lanes and the client planner then build against those contracts in parallel; the Lab lands last because it shares the celebration CTA, the drink-plan server files, and the post-submit money seam. Design canvases in win-share are the visual source of truth; the spec is the behavioral source of truth; where a canvas and the spec disagree, the spec wins.

**Tech stack:** existing only. Raw SQL via pool.query, Express routers, CRA React, vanilla CSS in index.css. No new dependencies.

## Global constraints (bind every lane)

- Money paths: `computeExtrasBreakdown` is the ONE source of extras math; the Stripe intent route, submit transaction shape, and invoice machinery are reused, never rewritten. No card fields on any new surface.
- `drink_plans.selections` allow-list is additive-only; every new key updates ALL consumers in the same lane (generator, admin `DrinkPlanSelections.js` display, `menuSections.js`, `drink_names` enrichment).
- New public token routes use `requireUuidToken` + `publicReadLimiter` (UUID 22P02 rule).
- One pooled connection per request; helpers called post-COMMIT may take their own connection (release first).
- Money display: proposals/packages are DOLLARS; Stripe rows are CENTS. Never mix in one expression without explicit x100//100.
- No em dashes in ANY client-facing copy (including the quantity review's client-view render). NA beer copy is Athletic Brewing only.
- `potion-*` CSS namespace for planner; new Lab uses `potion-lab-*`. Vanilla CSS in index.css.
- File-size ratchet: new files aim under 300 lines; splits named in footprints are mandatory, not optional.
- Schema changes idempotent (`IF NOT EXISTS` / guarded UPDATE), and README/ARCHITECTURE updated in the same lane that changes shape.

## Pinned cross-lane contracts (the interface table)

These names are law across lanes; a lane that wants to deviate stops and surfaces.

**Schema (pp2-core):**
- `drink_plans.planner_version INTEGER` default `2` on new token issuance; existing rows backfilled `1`. The client route renders legacy wizard for `1`, v2 for `2`.
- `cocktails` / `mocktails` gain: `enhancements JSONB DEFAULT '[]'` (rows `{slug, pitch, flavors?[]}`), `syrup_id VARCHAR NULL`, `batchable BOOLEAN DEFAULT false`, `hosted_visible BOOLEAN DEFAULT true`. `ingredients` rows upgrade to `{name, par_item_id?, amount?, unit?}` (bare-string rows remain valid; readers tolerate both).
- `par_items.cost NUMERIC(10,2) NULL` (dollars).
- New `package_items` (`id serial, package_id int FK, category varchar, par_per_100 numeric, unit varchar, eligible_item_ids text[], sort_order int`) — category par + split-par eligible bottles.
- `service_packages` gain `slot_count INTEGER NULL`, `slot_kind VARCHAR CHECK (slot_kind IN ('hard','featured')) NULL`.
- New `ingredient_class_addons` (`class_key varchar PK, addon_slug varchar`) — gap pricing map (e.g. `coffee_liqueur -> craft addon`, `ginger_beer -> house-made-ginger-beer`).
- Package lineup updates from spec §5 as guarded UPDATEs in schema.sql (Refined `is_active=false`; Midrange +bitters/+simple, ginger-ale/scotch removals; Enhanced JW-Red removal + wine slim; F5 +lemon/+lime; Grand Maker's-for-Bulleit; contents land as `package_items` seed rows for all tiers).
- Buffer knobs + pace constant in the existing admin settings storage: keys `shopping_buffers` (`{spirits:1.25, mixers:1.4, garnish:1.5, supplies:1.25}`) and `pour_pace_per_hour` (`1.0`).

**Engines (pp2-core):**
- `coverageEngine.classify(drink, packageContents) -> { status: 'covered'|'fenced'|'unmakeable', gapClasses: [], gapPerGuest: number|null }` (pure; addon pricing passed in).
- `quantityEngine.computeDemand({guestCount, drinkers, profile, hours, pace, weights}) -> { pours, split: {cocktails, beer, wine}, perDrinkPours }` — profile nudges weights GENTLY (max ±10 points per category vs even baseline); `drinkers=null` (not sure) falls back to 75% of guest count.

**Selections keys (pp2-planner adds; allow-list + all consumers):**
- `crowd: { drinkers: number|null, unsure: boolean, profile: 'cocktail_forward'|'wine'|'beer'|'even'|'help' }`
- `barPlacement: 'indoors'|'outdoors'|'unsure'`, `powerAtBar: 'yes'|'no'|'unsure'`
- `mixersForSpirits` / `mixersForSignatureDrinks` unify on `true|false|'undecided'` for v2 writes (legacy null still read; `'undecided'` renders as "Not sure yet" everywhere, never as "included").
- v2 stops writing the three legacy balance keys; readers keep tolerating them.
- Hosted fence picks reuse the EXISTING auto-add gap-addon mechanism (`addOns[slug] = {enabled, autoAdded, triggeredBy[]}`) — no new money plumbing; `coverageEngine` supplies the slugs.

**Lab (pp2-lab):**
- Routes `GET/PUT /api/drink-plans/t/:token/lab` in new `server/routes/drinkPlans/lab.js`. PUT accepts `{addOns}` deltas only, 409s when `shopping_list_status='approved'` (window closed) or plan not `submitted`. Additions append to the plan's `addOns`, refresh the extras invoice via the existing `drinkPlanExtras` path, never touch Stripe.
- Follow-up message type `lab_followup`, scheduled +36h from submit, cancelled by: any Lab addition, window close, or event within 72h.

## Lane order and why

`pp2-core` alone, first (everything reads its contracts). Then `pp2-recipe-card`, `pp2-package-editor`, `pp2-quantity-review`, `pp2-planner` in parallel. `pp2-lab` last, after `pp2-planner` (shared files + celebration CTA + the post-submit money seam deserves the calmest tree). Dallas's content passes (recipes with amounts; package contents entry) start the moment `pp2-recipe-card` and `pp2-package-editor` merge and gate only the hosted coverage browser going live, not the code.

---

## Lane pp2-core — schema, engines, migration

Implements spec §4 (data model), §5 (lineup updates), quantity engine of §4.4.

1. Schema deltas per the contract table above, idempotent, with the §5 lineup UPDATEs and `package_items` seed rows for all ten packages (contents transcribed from the approved package table + Packages.png; Enhanced/Grand pinned during entry).
2. `coverageEngine.js` pure + tests: covered (all ingredients resolve to eligible items/classes), fenced (gap classes all priced by `ingredient_class_addons`), unmakeable (unpriceable gap: missing spirit), no-recipe passthrough. Test the F5-citrus case explicitly: with lemon/lime rows present, Margarita = covered; remove them, Margarita = fenced.
3. `quantityEngine.js` pure + tests: hand-checked example from the QR canvas (100 guests, 60 drinkers, 4h, pace 1.0 → 240 pours; 55/25/20 nudged split; wine 48 glasses ×1.25 → 12 bottles). Buffers applied by caller role.
4. `migrateDrinkMeta.js`: reads `client/src/pages/plan/data/drinkUpgrades.js` + `client/src/data/syrups.js` maps, writes `enhancements`/`syrup_id` onto drinks, idempotent, dry-run flag. Files are NOT deleted until pp2-planner merges (legacy wizard still imports them).
5. `packages.js` routes: admin CRUD for `package_items` + slots, `GET /:id/makeability` (classify every active drink), `GET /:id/margin?guests=&hours=&labor=` (directional math). Auth: admin/manager.
6. `potions.js` recipe CRUD accepts the new drink fields; `request_aliases` flow untouched.
7. Settings routes for buffers + pace. README/ARCHITECTURE.

## Lane pp2-recipe-card — admin recipes v2

Implements spec §6.1 with design 1a (tab) + 1b (drawer).

1. RecipeEditor v2: ingredient rows with par typeahead (alias-aware, existing catalog data), amount+unit (optional amount shows a quiet "par-scaled" tag), enhancements section (assignments + pitch + flavors), syrup link, flags (batchable/active/hosted-visible), review status. Extracted sections file keeps the editor under the ratchet.
2. RecipesTab batch-pass strip: drafts-remaining queue, sticky unit, duplicate-from, keyboard flow (Enter row-advance, Cmd/Ctrl+Enter = save-and-next). Both skins verified.
3. Both mounts verified: Recipes tab + shopping-list Add-recipe drawer (drawer keeps 1b compact layout).
4. Menu-tab "[object Object]" cosmetic: diagnose and fix in whichever of PotionsPage/CocktailMenuDashboard renders it.
5. DoD: enter 5 drafts back-to-back keyboard-only against dev DB.

## Lane pp2-package-editor — admin packages tab

Implements spec §6.2 + §6.3 per the approved canvas.

1. PackagesTab ladder list (price points, margin %, active/retired) + PackageDetail: category-par rows with eligible-bottle chips ("split pars share the category volume" helper line verbatim from canvas), slots config, prose (`includes`) in a display-only tab, pricing fields shown read-mostly.
2. Margin rail: guests/hours/labor/supplies knobs, labor default from settings, labeled "directional, not accounting".
3. MakeabilityPanel: in-tier / fenced (+$/guest) / unmakeable (with reason) / no-recipe, live-recomputed via the makeability route on edit.
4. DoD: enter Formula No. 5 for real; delete its citrus rows; watch Whiskey Sour/Daiquiri/Gimlet fall to fenced; restore.

## Lane pp2-quantity-review — generator inputs + review UI

Implements spec §4.4 consumers + §6.4 + §3.4.

1. `shoppingListGen.buildPlannerGeneratorInput` consumes `selections.crowd` and calls `quantityEngine`; generated list JSONB gains a `derivation` block (`{pours, split, perCategory: [{category, math-string, buffer}]}`) and per-line `admin_set: true` marker on any admin-edited quantity; regenerate holds `admin_set` lines.
2. ShoppingListModal: derivation strip, buffer chips (per-event override writes into the list's derivation, defaults from settings), Editor/Client-view toggle, needsRecipe queue unchanged, approve consequence line ("publishes this list and closes their Enhancement Lab window" — no em dash).
3. Client shopping-list render: plain-language quantities ("3 x 1.75L bottles, about 90 margaritas worth"), the padding sentence verbatim from spec §3.4, and specialty-item guidance (any line whose par item carries no retail ubiquity, i.e. flagged syrups/craft items, gets "find it at" text or the Lab cross-pitch when window open).
4. DoD: canvas hand-math example reproduced by the real engine end to end.

## Lane pp2-planner — the client wizard v2

Implements spec §3.1 + §3.2 per the walked canvas, PLUS the four review findings (2026-07-18): real-catalog picker structure, Lab attach-rate observability, specialty-guidance seam (owned by pp2-quantity-review), real recipes bound everywhere.

1. Version routing: `PotionPlanningLab` reads `planner_version`; `1` renders the untouched legacy tree (shims intact), `2` renders v2. Legacy step files stay until drain; a follow-up quick fix deletes them.
2. v2 BYOB steps per canvas: Welcome (honest 4-part roadmap), QuickPick (4 presets, Custom Setup gone), Drinks (cocktails + mocktails one screen **with the old planner's structure restored at real scale: category pills/sidebar with counts, sticky selected-count footer, "Your Menu" gathering view, custom-request typeahead** against live catalog with "on our menu" vs "bar lead will source it" states), Stocking (shared vocab; `'undecided'` value), Crowd (drinker chips computed from guest count; profile radios), Menu design (no recap), Day-of (parking disclosure as today, placement, power, access), Review ("The Full Prescription": leader rows, Not-answered states, required chips gate: ≥1 drink or explicit none + crowd + parking + day-of contact), Celebration (Lab CTA + email-echo promise).
3. Hosted shapes: slot picker (hard/featured; eligible = `batchable` for hard slots, full mocktail menu for Clear), coverage browser (two tiers, fence badges per-guest AND total, mocktail Jack rule line, fence pick = existing gap-addon auto-add), display-only ("confirmation, not a quiz" + taste questions only for rotating slots). Hosted readiness switch: a hosted plan whose package has zero `package_items` rows renders the legacy hosted flow (content-entry gate, per rollout).
4. Submit: allow-list additions per contract; echo email (full selections, lifecycle template, sent post-commit); fence-pick charges ride the existing submit extras path unchanged. No payment UI exists in v2 — the `extras_plus_balance` blocking scenario is unreachable from v2 (submit never collects; extras land on balance/invoice, per spec §2).
5. Attach-rate observability: log a `lab_cta_click` marker (plan row timestamp column or messageLog entry — pick the cheapest existing pattern) so the Lab funnel is queryable.
6. DoD: all five scenario walks at 390px + desktop against dev DB with the REAL catalog; legacy draft opens untouched; CI build green.

## Lane pp2-lab — the Enhancement Lab

Implements spec §3.3 per the walked canvas and its six states.

1. Route + page: shelf sections (per-drink flair from `enhancements`, syrup upsell with the prep-bench copy, event extras incl. champagne toast + toast-timing question + coupe nest + glassware + hosted NA/soft-drink), "Your additions" ledger, the one money sentence. States: open (nothing owed / due soon / past due banner variants), locked (with/without additions), empty-but-worth-the-click.
2. Server `lab.js` per the pinned contract; additions refresh the extras invoice through `drinkPlanExtras`; approval already flips `shopping_list_status` — the Lab reads it, nothing new to write there.
3. Follow-up email: template + `lab_followup` scheduling per contract (dispatcher handler, suppression rules, balance line rides along when owed).
4. Celebration CTA wiring (button lands in pp2-planner; the href target and click-marker land here if not already).
5. DoD: all six labState scenarios against dev DB; a Lab addition visibly lands on the balance invoice in admin; window closes on approve; second PUT 409s.

## Explicitly out of scope (parked per spec §9)

Swaps; client package browsing; day-of dunning policy; imagery (v1 none); legacy step-file deletion (post-drain quick fix); the admin menu-design page and drink-plan edit lock (adjacent projects).

## Content gates (Dallas, not code)

- Recipe pass (drafts + amounts + enhancement assignment + fill recipes) — unblocks hosted coverage browser + real quantity math. Starts after pp2-recipe-card merges.
- Package contents entry incl. pinning Enhanced/Grand bottle lists — starts after pp2-package-editor merges.
- Buffer/pace defaults confirmation at pp2-quantity-review merge.
