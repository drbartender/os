---
spec: docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md
designs: win-share/'Recipe card design.zip' (recipe card 1a+1b, package editor), 'Planner v2 and enhancement lab.zip', 'Quantity review.zip'
rev: 3 (pp2-core BUILT + MERGED 2026-07-18, squash 2bf3667; footprint corrected to cocktails/mocktails routers; computeDemand takes counts not weightsCap; classify also returns gapAddonSlugs/missing + no_recipe status)
lanes:
  - id: pp2-core
    footprint:
      - server/db/schema.sql                       # STRUCTURE only (tables/columns); lineup CONTENT lives in pp2-lineup
      - server/utils/coverageEngine.js             # new, pure: drink-vs-package coverage + gap pricing + mocktail addon rule
      - server/utils/coverageEngine.test.js
      - server/utils/quantityEngine.js             # new, pure: demand model
      - server/utils/quantityEngine.test.js
      - server/scripts/migrateDrinkMeta.js         # one-time: drinkUpgrades.js + DRINK_SYRUP_MAP -> DB
      - server/routes/potions.js                   # shared dossier-field validators (recipes CRUD lives in cocktails/mocktails)
      - server/routes/cocktails.js                 # dossier fields on POST/PUT [rev3 footprint fix: real CRUD location]
      - server/routes/mocktails.js                 # dossier fields on POST/PUT [rev3 footprint fix]
      - server/routes/packages.js                  # new: admin package-contents CRUD + makeability + margin
      - server/routes/packages.test.js
      - server/index.js                            # mount /api/admin/packages
      - server/routes/admin/settings.js            # buffer/pace/split-default settings (FLAT scalar keys)
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet          # schema + pricing-adjacent engines
  - id: pp2-recipe-card
    footprint:
      - client/src/components/potions/RecipeEditor.js        # v2 dossier (design 1b drawer layout)
      - client/src/components/potions/RecipeEditorSections.js # new sibling: enhancements/flags/syrup sections (ratchet)
      - client/src/pages/admin/potions/RecipesTab.js         # design 1a: batch-pass session strip
      - client/src/pages/admin/potions/PantryParsTab.js      # par cost column surface (editable)
      - client/src/pages/admin/CocktailMenuDashboard.js      # Menu-tab "[object Object]" cosmetic fix (931 lines: fix must be non-growing or extract)
    blockedBy: [pp2-core]
    review: light               # admin UI, no money
  - id: pp2-package-editor
    footprint:
      - client/src/pages/admin/potions/PackagesTab.js        # new: 4th Potions tab
      - client/src/pages/admin/potions/PackageDetail.js      # new: contents editor + margin rail
      - client/src/pages/admin/potions/MakeabilityPanel.js   # new: in-tier / fenced / unmakeable rail
      - client/src/pages/admin/PotionsPage.js                # SOLE owner of PotionsPage edits (tab registration); pp2-recipe-card must not touch it
    blockedBy: [pp2-core]
    review: standard            # primary money-display surface (margin, fence prices)
  - id: pp2-lineup
    footprint:
      - server/scripts/applyPackageLineup2026.js   # one-time script: spec §5 lineup + package_items content (NOT in boot path)
      - client/src/data/packages.js                # marketing/wizard prose updated to the new lineup
      - client/src/pages/website/PackagesPage.js   # verify render of updated prose
      - client/src/pages/website/quoteWizard/steps/PackageStep.js  # Refined removed from wizard choices
      - client/src/pages/proposal/compare/PackageMatrix.js   # verify against new lineup (path per repo; locate at build)
      - client/src/components/PackageIncludesModal.js        # verify against new lineup (path per repo; locate at build)
    blockedBy: [pp2-core]
    review: standard            # public pricing prose + prod data mutation script
  - id: pp2-quantity-review
    footprint:
      - server/utils/shoppingListGen.js            # consume selections.crowd (ABSENT-SAFE) + quantityEngine; admin-set hold markers
      - server/utils/shoppingList.js               # derivation metadata on generated lists
      - server/utils/shoppingList.generator.test.js
      - client/src/components/ShoppingList/ShoppingListModal.jsx   # derivation strip, buffers, client-view toggle
      - client/src/components/ShoppingList/DerivationStrip.jsx     # new sibling (modal is 713 lines)
      - client/src/pages/public/ClientShoppingList (route component) # plain-language render + padding sentence + specialty guidance
    blockedBy: [pp2-core]
    review: standard            # generator drives ops; no payment paths
  - id: pp2-planner
    footprint:
      - client/src/App.js                          # routes /plan/:token to NEW PlannerRouter (all four host blocks)
      - client/src/pages/plan/PlannerRouter.js     # new: version switch; PotionPlanningLab.js (998/1000) is NOT modified
      - client/src/pages/plan/v2/**                # new step components (welcome, quickpick, drinks, stocking, crowd, menu, dayof, review, celebration)
      - client/src/index.css                       # potion-* additions; conf-leader block finally mounted
      - server/routes/drinkPlans.js                # serve planner_version + package/coverage payload on GET t/:token
      - server/routes/drinkPlans/submit.js         # allow-list additions; fence picks -> existing gap-addon/extras path; echo email trigger
      - server/routes/drinkPlans/submitExtras.test.js   # extend EXISTING suites (no new orphan test file)
      - server/utils/lifecycleEmailTemplates.js    # submission echo email (full selections)
      - server/utils/drinkPlanNudge.js             # copy touch only
    blockedBy: [pp2-core]
    review: full-fleet          # submit money path + selections contract
  - id: pp2-lab
    footprint:
      - client/src/pages/plan/EnhancementLab.js    # new page + route /plan/:token/lab
      - client/src/pages/plan/lab/**               # shelf components, balance banner, states
      - client/src/App.js                          # lab route registration (after pp2-planner's edit; serialized by blockedBy)
      - server/routes/drinkPlans/lab.js            # new: GET/PUT t/:token/lab (requireUuidToken, approval-gated)
      - server/routes/drinkPlans/lab.test.js
      - server/utils/drinkPlanExtras.js            # additions ride computeExtrasBreakdown; invoice refresh reuse
      - server/utils/lifecycleEmailTemplates.js    # Lab follow-up email template (shared file; serialized behind pp2-planner)
      - server/utils/messageScheduling.js          # lab_followup scheduling (entityType 'proposal', drink_plan_nudge precedent)
      - server/utils/scheduledMessageDispatcher.js # dispatch handler for lab_followup
      - server/routes/drinkPlans.js                # approval closes Lab window (status read) + triggers list regenerate with holds
    blockedBy: [pp2-planner, pp2-quantity-review]  # QR lane owns the admin-set hold regenerate the Lab's syrup flip depends on
    review: full-fleet          # writes addOns post-submit + invoice refresh = money
---

# Potion Planner v2 Implementation Plan (rev 2)

> **For agentic workers:** execute lane-by-lane per the front-matter graph (this repo's lane model; superpowers:executing-plans semantics apply within a lane). Every lane re-reads the spec section it implements before building. Rev 2 incorporates the 2026-07-18 plan-fleet findings; deltas are marked [rev2].

**Goal:** Ship the planner/selling split end to end: recipe-derived package coverage, the v2 client planner (no money), the Enhancement Lab (invoice-only selling), and the instrumented quantity review, per the 2026-07-18 spec.

**Architecture:** One core lane lands all schema STRUCTURE + two pure engines behind tests; admin lanes, the lineup-content lane, and the client planner build against those contracts in parallel; the Lab lands last (shared files, celebration CTA, post-submit money seam). Design canvases in win-share are the visual source of truth; the spec is the behavioral source of truth; where they disagree, the spec wins.

**Tech stack:** existing only. Raw SQL via pool.query, Express routers, CRA React, vanilla CSS in index.css. No new dependencies.

## Global constraints (bind every lane)

- Money paths: `computeExtrasBreakdown` is the ONE source of extras math; the Stripe intent route, submit transaction shape, and invoice machinery are reused, never rewritten. No card fields on any new surface.
- `drink_plans.selections` allow-list is additive-only; every new key updates ALL consumers in the same lane (generator, admin `DrinkPlanSelections.js` display, `menuSections.js`, `drink_names` enrichment).
- New public token routes use `requireUuidToken` + `publicReadLimiter` (UUID 22P02 rule).
- One pooled connection per request; helpers called post-COMMIT may take their own connection (release first).
- Money display: proposals/packages are DOLLARS; Stripe rows are CENTS.
- No em dashes in ANY client-facing copy (including the quantity review's client-view render). NA beer copy is Athletic Brewing only.
- `potion-*` CSS namespace for planner; new Lab uses `potion-lab-*`. Vanilla CSS in index.css.
- File-size ratchet: new files aim under 300 lines; splits named in footprints are mandatory. **[rev2] `PotionPlanningLab.js` sits at 998/1000 and is NOT modified by any lane** (version routing lives in the new `PlannerRouter.js`); `CocktailMenuDashboard.js` (931) accepts only non-growing edits.
- Schema STRUCTURE changes are idempotent in schema.sql. **[rev2] Package lineup CONTENT changes are a one-time script, never boot-path schema.sql UPDATEs** — the spec makes admin/DB canonical after seed, and a re-running UPDATE would clobber admin edits.
- README/ARCHITECTURE updated in the same lane that changes shape.

## Pinned cross-lane contracts (the interface table)

These names are law across lanes; a lane that wants to deviate stops and surfaces.

**Schema (pp2-core):**
- `drink_plans.planner_version INTEGER` default `2` on new token issuance; existing rows backfilled `1`.
- `cocktails` / `mocktails` gain: `enhancements JSONB DEFAULT '[]'` (rows `{slug, pitch, flavors?[]}`), `syrup_id VARCHAR NULL`, `batchable BOOLEAN DEFAULT false`, `hosted_visible BOOLEAN DEFAULT true`. `ingredients` rows upgrade to `{name, par_item_id?, amount?, unit?}` (bare-string rows remain valid; readers tolerate both).
- `par_items.cost NUMERIC(10,2) NULL` (dollars).
- New `package_items` (`id serial, package_id int FK, category varchar, par_per_100 numeric, unit varchar, eligible_item_ids text[], sort_order int`).
- `service_packages` gain `slot_count INTEGER NULL`, `slot_kind VARCHAR CHECK (slot_kind IN ('hard','featured')) NULL`.
- New `ingredient_class_addons` (`class_key varchar PK, addon_slug varchar`) — gap pricing map. (Deliberate small new table; `service_addons` stays the pricing source, this only maps classes to it.)
- **[rev2] Settings are FLAT scalar keys** (existing `app_settings.value TEXT` + `String()` coercion cannot hold objects): `shopping_buffer_spirits`, `shopping_buffer_mixers`, `shopping_buffer_garnish`, `shopping_buffer_supplies`, `pour_pace_per_hour`, `pour_split_cocktails`, `pour_split_beer`, `pour_split_wine` (defaults `1.25/1.4/1.5/1.25/1.0/45/30/25`).

**Engines (pp2-core):**
- `coverageEngine.classify(drink, packageContents) -> { status: 'covered'|'fenced'|'unmakeable', gapClasses: [], gapPerGuest: number|null }` (pure; addon pricing passed in).
- **[rev2]** `coverageEngine.mocktailAddonFor(count) -> null | 'pre-batched-mocktail' | 'mocktail-bar'` (0 → null, 1 → pre-batched, 2+ → mocktail-bar). The Jack rule is MONEY logic and lives here; client applies it via the plan payload, submit re-derives server-side and never trusts the client.
- **[rev2]** `quantityEngine.computeDemand({guestCount, drinkers, profile, hours, pace, splitDefaults, counts}) -> { pours, split, perDrinkPours }` — profile nudges the **settings default split** (45/30/25), NOT even thirds, by at most ±10 points per category. DoD fixture: `cocktail_forward` on 45/30/25 → 55/25/20 (matches the QR canvas hand-math). `drinkers=null` (not sure) falls back to 75% of guest count.

**Selections keys (pp2-planner adds; allow-list + all consumers):**
- `crowd: { drinkers: number|null, unsure: boolean, profile: 'cocktail_forward'|'wine'|'beer'|'even'|'help' }`
- `barPlacement: 'indoors'|'outdoors'|'unsure'`, `powerAtBar: 'yes'|'no'|'unsure'`
- `mixersForSpirits` / `mixersForSignatureDrinks` unify on `true|false|'undecided'` for v2 writes (legacy null still read; `'undecided'` renders as "Not sure yet" everywhere, never as "included").
- v2 stops writing the three legacy balance keys; readers keep tolerating them.
- Hosted fence picks reuse the EXISTING auto-add gap-addon mechanism (`addOns[slug] = {enabled, autoAdded, triggeredBy[]}`); `coverageEngine` supplies the slugs, including the mocktail flip above.

**Lab (pp2-lab):**
- Routes `GET/PUT /api/drink-plans/t/:token/lab` in new `server/routes/drinkPlans/lab.js`. PUT accepts `{addOns}` deltas only, 409s when `shopping_list_status='approved'` (window closed) or plan not `submitted`. Additions append to the plan's `addOns` and refresh the extras invoice via the existing `drinkPlanExtras` path; never touch Stripe.
- **[rev2] Syrup-add cross-surface effect:** a Lab syrup addition must also flip that syrup OFF the client shopping list. Mechanism: the Lab PUT triggers a shopping-list regenerate through the pp2-quantity-review hold machinery (admin-set quantities held). This is why pp2-lab is blockedBy pp2-quantity-review.
- **[rev2]** Follow-up message type `lab_followup` binds `entityType: 'proposal'` (the `drink_plan_nudge` precedent; `VALID_ENTITY_TYPES` has no drink_plan type). Scheduled +36h from submit; cancelled by any Lab addition, window close, or event within 72h.
- **[rev2] Deploy seam:** pp2-planner and pp2-lab ship in the SAME prod push. If they must ever push separately, the celebration CTA renders only when the GET t/:token payload carries `lab_enabled: true`, which only the Lab lane's server code sets.

## Lane order and why

`pp2-core` alone, first. Then `pp2-recipe-card`, `pp2-package-editor`, `pp2-lineup`, `pp2-quantity-review`, `pp2-planner` in parallel. `pp2-lab` last (blockedBy planner + quantity-review). **[rev2] Revert expectation is LIFO:** a revert of pp2-planner after pp2-lab merged strands the Lab; revert in reverse merge order. Dallas's content passes (recipes; package contents; par costs) start when recipe-card/package-editor merge and gate only the hosted coverage browser going live.

---

## Lane pp2-core — schema structure, engines, migration

Implements spec §4 (data model) structure + engines of §4.4. **[rev2] Does NOT apply the §5 lineup content** (moved to pp2-lineup) — engines and tables land content-agnostic, tests use fixtures.

1. Schema deltas per the contract table, idempotent, STRUCTURE only.
2. `coverageEngine.js` pure + tests: covered / fenced / unmakeable / no-recipe, plus `mocktailAddonFor` (0/1/2+ cases). Test the F5-citrus case explicitly with fixture data: with lemon/lime rows present, Margarita = covered; remove them, fenced.
3. `quantityEngine.js` pure + tests incl. the canvas fixture (100 guests, 60 drinkers, 4h, pace 1.0 → 240 pours; cocktail_forward on 45/30/25 defaults → 55/25/20; wine 48 glasses ×1.25 → 12 bottles).
4. `migrateDrinkMeta.js`: reads `client/src/pages/plan/data/drinkUpgrades.js` + `client/src/data/syrups.js` maps, writes `enhancements`/`syrup_id` onto drinks, idempotent, dry-run flag. Source files are NOT deleted until legacy-wizard drain (named in Out of scope).
5. `packages.js` routes: admin CRUD for `package_items` + slots, `GET /:id/makeability`, `GET /:id/margin?guests=&hours=&labor=`. Auth: admin/manager. Mounted in `server/index.js` in this lane.
6. `potions.js` recipe CRUD accepts the new drink fields; `request_aliases` flow untouched.
7. Settings routes accept the flat keys. README/ARCHITECTURE.
8. **[rev2] DoD:** suites green (`node --test` one suite at a time per repo law); schema loads clean on dev Neon (verify new tables in a DB client); `GET /api/admin/packages/:id/makeability` and `/margin` return sane fixtures against a hand-entered test package.

## Lane pp2-recipe-card — admin recipes v2

Implements spec §6.1 with design 1a (tab) + 1b (drawer). Unchanged from rev 1 except: **[rev2] does not touch PotionsPage.js** (pp2-package-editor owns it); the "[object Object]" fix targets `CocktailMenuDashboard.js` after diagnosis and must be non-growing (931/1000). DoD: enter 5 drafts back-to-back keyboard-only against dev DB; both mounts verified; both skins.

## Lane pp2-package-editor — admin packages tab

Implements spec §6.2 + §6.3 per the approved canvas. Sole owner of PotionsPage.js (tab registration). Margin rail labor default from settings. DoD: enter Formula No. 5 for real; delete its citrus rows; watch Whiskey Sour/Daiquiri/Gimlet fall to fenced; restore. **[rev2] review: standard** (primary money-display surface).

## Lane pp2-lineup — the §5 lineup, everywhere at once [rev2 new lane]

Implements spec §5 as CONTENT, in one reviewable batch, so the four-sources-of-truth problem actually dies.

1. `applyPackageLineup2026.js`: one-time, guarded, dry-run-first script applying the §5 table (Refined `is_active=false`; Midrange +bitters/+simple, ginger-ale + scotch out; Enhanced JW-Red out + wine slim; F5 +lemon/+lime; Grand Maker's-for-Bulleit) AND the `package_items` content rows for all ten packages (transcribed from the approved table + Packages.png; Enhanced/Grand bottle lists pinned with Dallas during entry). Runs on dev, verified via the makeability preview, then on prod at rollout. NOT in the boot path.
2. `client/src/data/packages.js` prose updated to match (and Refined removed from wizard choices); consumers verified: website PackagesPage, quote wizard PackageStep, compare matrix, includes modal. Note: the "cooler" line in SERVICE_INCLUDES STAYS (the cooler is still provided; only the planner's coolers QUESTION died).
3. DoD: makeability preview per package matches the spec table's intent (margarita covered on Enhanced + Grand, fenced on Midrange; mule covered only on Grand); website package pages render the new lists; wizard no longer offers Refined.
4. Rollback note: the script logs prior values; reverting = re-running with the logged snapshot (kept in the script's output file), since git revert cannot undo prod data.

## Lane pp2-quantity-review — generator inputs + review UI

Implements spec §4.4 consumers + §6.4 + §3.4.

1. `buildPlannerGeneratorInput` consumes `selections.crowd` **[rev2] absent-safely: when `crowd` is missing entirely (every legacy and consult plan), the generator takes the exact current par-scaled path with zero behavior change** — this lane must land harmlessly against pre-v2 plans and is tested for that. Generated list JSONB gains `derivation` block + per-line `admin_set: true` markers; regenerate holds admin-set lines.
2. ShoppingListModal: derivation strip (extracted `DerivationStrip.jsx`), buffer chips (per-event override; defaults from flat settings keys), Editor/Client-view toggle, needsRecipe queue unchanged, approve consequence line (no em dash).
3. Client shopping-list render: plain-language quantities, the padding sentence verbatim from spec §3.4, specialty-item guidance (flagged syrup/craft items get find-it-at text or the Lab cross-pitch while the window is open).
4. DoD: canvas hand-math example reproduced end to end by the real engine; a legacy plan regenerates byte-identically to pre-lane behavior.

## Lane pp2-planner — the client wizard v2

Implements spec §3.1 + §3.2 per the walked canvas, plus the 2026-07-18 review findings.

1. **[rev2] Version routing in a NEW `PlannerRouter.js`** mounted by App.js at `/plan/:token` (all four host blocks): fetches the plan, renders legacy `PotionPlanningLab` for `planner_version` 1 (file untouched, 998/1000), v2 orchestrator for 2. Legacy shims intact; legacy deletion is a post-drain quick fix.
2. v2 BYOB steps per canvas: Welcome (honest roadmap), QuickPick (4 presets), Drinks (cocktails + mocktails one screen with the old planner's structure restored at real scale: category pills/sidebar with counts, sticky selected-count footer, "Your Menu" gathering view, custom-request typeahead against the live catalog with "on our menu" vs "bar lead will source it" states — presentation over free-text, stored strings unchanged), Stocking (shared vocab; `'undecided'`), Crowd (drinker chips from guest count; profile radios), Menu design (no recap), Day-of (parking disclosure, placement, power, access), Review ("The Full Prescription" with required chips gate), Celebration (Lab CTA per deploy-seam contract + email-echo promise).
3. Hosted shapes: slot picker (hard/featured; hard-slot eligibility = `batchable`; Clear = full mocktail menu), coverage browser (two tiers, badges per-guest AND total, fence pick = existing gap-addon auto-add via engine payload), display-only ("confirmation, not a quiz" + taste questions only for rotating slots). **[rev2] Hosted-specific variants are explicit deliverables: hosted Welcome copy ("your package already answered the big questions"), hosted Crowd framing (red/white lean, hoppy/light; never "what should we buy"), and the mocktail count flip (1 = pre-batched, 2+ = Mocktail Bar) applied live in the picker from `mocktailAddonFor`.** Hosted readiness switch: a hosted plan whose package has zero `package_items` rows renders the legacy hosted flow.
4. Submit: allow-list additions per contract; **server re-derives fence addons + the mocktail flip via coverageEngine (never trusts client addOns for hosted gap slugs)**; echo email post-commit; fence charges ride the existing submit extras path unchanged. No payment UI exists in v2.
5. Attach-rate observability: `lab_cta_click` marker via the cheapest existing pattern (messageLog entry) so the Lab funnel is queryable.
6. Tests: extend the EXISTING submit suites (`submitExtras.test.js` et al) — no orphan new test file. DoD: all five scenario walks at 390px + desktop against dev DB with the REAL catalog; a legacy draft opens untouched through PlannerRouter; CI build green.

## Lane pp2-lab — the Enhancement Lab

Implements spec §3.3 per the walked canvas and its six states. As rev 1, plus rev 2 pins: syrup-add list-flip via the QR hold-regenerate (blockedBy added), `lab_followup` on `entityType 'proposal'`, same-push law with pp2-planner (or `lab_enabled` gate). DoD: all six labState scenarios against dev DB; a Lab addition lands on the balance invoice in admin AND flips the syrup off the client list while holding admin-set lines; window closes on approve; second PUT 409s.

## Explicitly out of scope (parked per spec §9)

Swaps; client package browsing; day-of dunning policy; imagery (v1 none); **[rev2] post-drain deletions named precisely: legacy step files under `client/src/pages/plan/steps/`, `client/src/pages/plan/data/drinkUpgrades.js`, and the `DRINK_SYRUP_MAP`/pricing exports in `client/src/data/syrups.js`** (one quick-fix commit after the last `planner_version=1` draft submits); the admin menu-design page and drink-plan edit lock (adjacent projects).

## Content gates (Dallas, not code)

- Recipe pass (drafts + amounts + enhancement assignment + fill recipes) — unblocks hosted coverage browser + real quantity math. Starts after pp2-recipe-card merges.
- Package contents entry incl. pinning Enhanced/Grand bottle lists — with pp2-lineup's script run (dev first).
- **[rev2] Par costs entry** (from the costs spreadsheet, via PantryParsTab) — unblocks the margin rail showing real numbers.
- Buffer/pace/split defaults confirmation at pp2-quantity-review merge.
