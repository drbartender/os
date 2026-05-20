# Spec: Shopping List Add-On Subtraction and Mixer-Shortfall Warning

> Make the auto-generated shopping list subtract items covered by the client's BYOB-support add-ons so the operator no longer has to manually strip them during audit. Surface a warning when the client has Signature Mixers or The Formula coverage but their signature cocktails need more than 3 mixers.

This spec implements the deferred work called out at §11 of `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md`. That spec shipped scope-banner copy on the planner promising *"anything you've added as an upgrade will come from us instead"*. The promise is in production; the server-side enforcement is what this spec adds.

---

## 1. Goals and non-goals

### Goals

- The auto-generated `pending_review` shopping list strips items covered by the client's active BYOB-support add-ons before it is staged.
- The add-on coverage rules are defined as code (a single source of truth) so additions or changes are easy to audit.
- A new pure helper detects when Signature Mixers or The Formula clients have selected signature cocktails that need more than 3 mixers, and surfaces a warning to both the client (on the planner ConfirmationStep) and the operator (on the admin EventDetailPage).
- Small categorization cleanup: Angostura Bitters moves from the `GARNISHES` constant to `BASIC_MIXERS`. Bitters is not a garnish.

### Non-goals (explicit out-of-scope)

- Upcharge offer in the planner. The warning's copy includes a nudge to upgrade the add-on; the actual "click to upgrade" button (price recalc + addons update + confirmation) is a separate future spec.
- Retroactive regeneration of `pending_review` lists created before this change. The operator audits those manually as today.
- Re-running subtraction on already-approved lists. Approved lists are operator-edited and immutable from this code path.
- Admin-editable add-on coverage mapping. Stays in code for v1.
- Subtraction for add-ons outside the `byob_support` category. Premium, beverage, craft, staffing, and logistics add-ons do not strip shopping list items.
- Changes to the manual shopping list editing UI on the admin side. The audit modal and any manual edits work as they do today, just on a list that has already been pre-stripped.

---

## 2. Status and prior art

- **Prior commitments**: `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md` §6 ships the scope-banner copy that promises subtraction. `docs/superpowers/specs/2026-05-20-standard-menu-autogen-design.md` §7 explicitly notes shopping-list subtraction as out-of-scope for that work. This spec closes that loop.
- **Current generator**: `server/utils/shoppingList.js` builds the list from hardcoded `BASIC_MIXERS`, `ALWAYS_INCLUDE` (Water, Cups, Straws, Napkins, Ice), and `GARNISHES` constants plus dynamic per-cocktail ingredient decomposition via `INGREDIENT_MAP`.
- **Current input builder**: `server/utils/shoppingListGen.js#buildPlannerGeneratorInput` does NOT pass `selections.addOns` through to the generator. This is the first piece of plumbing the spec changes.
- **Auto-generation timing**: `autoGenerateShoppingList(planId, dbClient)` runs at submit time with strict no-overwrite semantics. The list is staged as `pending_review`, the operator audits and approves. This spec changes what gets staged INITIALLY; the post-approval state is unchanged.
- **The 9 byob_support add-ons** that conceptually replace shopping list items: `ice-delivery-only`, `cups-disposables-only`, `bottled-water-only`, `signature-mixers-only`, `full-mixers-only`, `garnish-package-only`, `the-foundation`, `the-formula`, `the-full-compound`. See §3 for the coverage mapping.

---

## 3. Add-on coverage mapping

Defined in code as a new module at `server/utils/shoppingListAddonCoverage.js`. Stays out of `shoppingList.js` to keep the responsibility focused; `shoppingList.js` already crowds the line-count budget with the generator itself.

| Slug | Strips |
|---|---|
| `ice-delivery-only` | Ice |
| `cups-disposables-only` | Cups (9oz), Straws, Napkins |
| `bottled-water-only` | Water |
| `signature-mixers-only` | Up to 3 mixers needed by signature cocktails, selected by frequency (most-used first; ties broken by `BASIC_MIXERS` list order) |
| `full-mixers-only` | All items in `BASIC_MIXERS` (after the §6 cleanup this includes Simple Syrup and Angostura Bitters) |
| `garnish-package-only` | All items in `GARNISHES` (Premium Cherries, Lemons, Limes, Oranges) |
| `the-foundation` | Water, Cups (9oz), Straws, Napkins, Ice |
| `the-formula` | Foundation items + up to 3 sig-cocktail mixers (same frequency rule as `signature-mixers-only`) + Lemons + Limes + Oranges + Angostura Bitters |
| `the-full-compound` | Foundation items + all `BASIC_MIXERS` + all `GARNISHES` |

**Union when multiple add-ons are active.** If the client has both Foundation AND Signature Mixers, the strip set is Foundation's items unioned with Signature Mixers' coverage.

**Override semantics.** `full-mixers-only` and `the-full-compound` cover all mixers regardless of demand. If either is active, the signature-mixer-shortfall warning (§5) cannot trigger.

**No-mixer-needed case.** A client with `signature-mixers-only` who picks zero signature cocktails has no mixers to strip and no shortfall. The coverage helper returns an empty strip set for that add-on in that scenario.

---

## 4. Signature-mixer coverage logic

Pure function at the top of `shoppingListAddonCoverage.js`:

```
pickCoveredMixers(signatureCocktails, ingredientMap, mixerIngredientNames, cap = 3)
  -> string[]  // array of BASIC_MIXERS item names to strip
```

**Inputs:**
- `signatureCocktails`: resolved cocktails (the same `[{id, name, ...}]` shape `buildPlannerGeneratorInput` already produces).
- `ingredientMap`: `INGREDIENT_MAP` from `shoppingList.js` (exported for the helper to consume).
- `mixerIngredientNames`: a new exported `Map<string, string>` from `shoppingList.js`. Maps INGREDIENT_MAP atoms to `BASIC_MIXERS` display names. Roughly one entry per `BASIC_MIXERS` row (Coca Cola, Diet Coke, Ginger Ale, Ginger Beer, Sprite, Club Soda, Tonic, juices, Simple Syrup, Bitters). The exact key names depend on the existing `INGREDIENT_MAP` shape; the bridge map glues them.
- `cap`: defaults to 3; only signature-mixers-only and the-formula use the cap.

**Algorithm:**
1. For each cocktail in `signatureCocktails`, look up its ingredient atoms via `ingredientMap`.
2. For each atom, look up its display name via `mixerIngredientNames`. Drop atoms that are not mixers (spirits, garnishes, ice, etc.).
3. Tally frequency: how many cocktails reference each mixer name.
4. Sort by frequency descending. Break ties by `BASIC_MIXERS` array order (stable, deterministic).
5. Return the top `cap` mixer display names.
6. If fewer than `cap` unique mixers are needed, return all of them. No padding.

**Why frequency?** It maximizes operational value (the most-shared mixers get covered, leaving the niche ones on the client's list).

**Edge cases handled:**
- No signature cocktails selected: returns `[]`.
- Sig cocktails reference an atom not in `mixerIngredientNames`: silently dropped.
- All cocktails reference the same one mixer: returns one item, not padded.

---

## 5. Shopping list generator integration

### 5.1 Input builder change

`server/utils/shoppingListGen.js#buildPlannerGeneratorInput` is extended to read `sel.addOns` and pass the active slugs through. The active slugs are the keys of `selections.addOns` where `selections.addOns[slug].enabled === true`.

```
return {
  ...existing fields...,
  activeAddonSlugs: Object.entries(sel.addOns || {})
    .filter(([, meta]) => meta && meta.enabled === true)
    .map(([slug]) => slug),
};
```

The consult variant `buildConsultGeneratorInput` gets the same field, sourced from `consult.addOns` (mirroring the planner variant).

### 5.2 Generator change

`server/utils/shoppingList.js#generateShoppingList` accepts the new `activeAddonSlugs` field on its input object. After all the existing list-building logic (cocktail decomposition, BASIC_MIXERS merge, garnishes, pars scaling), it calls into the new coverage helper to produce the strip set and filters the final list:

```js
const stripSet = computeStripSet({
  activeAddonSlugs,
  signatureCocktails,
  ingredientMap: INGREDIENT_MAP,
  mixerIngredientNames: MIXER_INGREDIENT_NAMES,
  basicMixers: BASIC_MIXERS,
  garnishes: GARNISHES,
  alwaysInclude: ALWAYS_INCLUDE,
});

return finalItems.filter((item) => !stripSet.has(item.item));
```

`computeStripSet` is the exported function from `shoppingListAddonCoverage.js`. It returns a `Set<string>` of item names to drop. Matching is by exact item-name string (e.g., `'Lemons'`, `'Cups (9oz)'`).

### 5.3 The strip happens last

After every other generator step. This keeps all existing math (per-100 scaling, mixer pairings, signature-cocktail decomposition) untouched. The subtraction is purely a final filter pass. If the strip set is empty (no add-ons that cover anything), the output is identical to today.

### 5.4 No regeneration of existing lists

The auto-generator at `autoGenerateShoppingList` has `WHERE shopping_list IS NULL` no-overwrite semantics. This spec does not change that. Lists already in `pending_review` (or `approved`) state are not touched. New submissions get the new behavior; old ones stay as they were.

---

## 6. Mixer-shortfall detection and warning

### 6.1 Detection helper

Pure function at `shoppingListAddonCoverage.js`:

```
detectMixerShortfall(signatureCocktails, activeAddonSlugs, ingredientMap, mixerIngredientNames)
  -> { neededCount, coveredCount, shortfall, upgradeTarget } | null
```

**Returns `null`** if no shortfall is possible (no Signature Mixers or Formula active; or Full Mixers / Full Compound override is active; or no signature cocktails selected).

**Returns the object** when a shortfall is detected. Fields:
- `neededCount`: unique mixers needed by the signature cocktails (count, not list).
- `coveredCount`: how many the add-on covers (always 3 for the triggering add-ons in v1).
- `shortfall`: boolean, `true` when `neededCount > coveredCount`.
- `upgradeTarget`: the recommended upgrade add-on slug:
  - `signature-mixers-only` active alone → `'full-mixers-only'`
  - `the-formula` active alone → `'the-full-compound'`
  - Both active (rare): `'the-full-compound'` (covers more)

**Trigger conditions (all must hold):**
1. `signature-mixers-only` OR `the-formula` is in `activeAddonSlugs`.
2. `full-mixers-only` is NOT in `activeAddonSlugs`.
3. `the-full-compound` is NOT in `activeAddonSlugs`.
4. Unique mixer count from signature cocktails > 3.

### 6.2 Planner-side warning

A new component `<MixerShortfallBanner>` at `client/src/pages/plan/components/MixerShortfallBanner.js`. Renders on `ConfirmationStep` when `detectMixerShortfall` (called client-side from `selections` + a client-side INGREDIENT_MAP mirror or via a small new endpoint) returns a non-null shortfall object.

**Client-side computation.** The helper is server-side today (lives in `shoppingList.js`). Two options for the client-side detection:
- **(a)** Import the helper directly: `server/utils/` is server-only, so the helper would need to be moved to a shared location or duplicated in the client. The data structures (INGREDIENT_MAP, MIXER_INGREDIENT_NAMES, BASIC_MIXERS) would need a client-side mirror.
- **(b)** New server endpoint that returns the shortfall summary for a token-gated plan: `GET /api/drink-plans/t/:token/mixer-shortfall`. Client fetches on ConfirmationStep mount and rerenders the banner.

**Recommendation: (b).** Avoids client/server data drift. The single source of truth stays server-side. Endpoint is cheap (pure computation, no DB write). Cached by the React component until selections change.

**Copy (verbatim):**

> Heads up: your drink selections need **{neededCount}** mixers, but your **{currentAddonName}** add-on covers 3. The remaining **{neededCount - 3}** will be on your shopping list. To have us cover them all, consider upgrading to **{upgradeTargetName}**.

`currentAddonName` and `upgradeTargetName` are the human-readable names from the `service_addons` table (e.g., "Signature Mixers", "Full Mixers"). The component receives the slug→display-name map alongside the shortfall data.

**Visual treatment.** Brass-toned banner, same `.potion-scope.aside` chrome that the planner reskin established for "heads up" messaging. Mounted at the TOP of `ConfirmationStep`, before the summary card, so the client sees it before scrolling.

### 6.3 Admin-side warning

`GET /api/drink-plans/:id` (admin route) returns a new optional field:

```
mixerShortfall: { neededCount, coveredCount, upgradeTarget } | null
```

The field is computed server-side using the same helper, so the admin sees the same numbers the client did.

On `EventDetailPage.js`, a small admin banner renders near the drink-plan section when `mixerShortfall` is non-null. Copy is operator-facing and factual:

> Mixer shortfall: client picked drinks needing **{neededCount}** mixers; their **{currentAddonName}** add-on covers 3. The remaining **{neededCount - 3}** will appear on the shopping list. Verify before approval, or upgrade the client to **{upgradeTargetName}**.

No upgrade button in v1; the operator handles upgrades manually via existing admin proposal workflows.

### 6.4 No persisted state

The shortfall is computed on demand from `selections` + active add-ons. Nothing is stored on the plan or anywhere else. When selections or add-ons change, the next read recomputes.

---

## 7. Categorization cleanup

Small refactor in `server/utils/shoppingList.js`:

Move `{ item: 'Angostura Bitters', size: '4oz', qty: 1 }` from the `GARNISHES` array to the `BASIC_MIXERS` array. The bitters are bottle-stored mixer-adjacent essentials, not garnishes.

**No behavior change at the shopping list output**: the bitters still get added at the same quantity. The only difference is which array it lives in.

**Implication for coverage mapping**: `garnish-package-only` strips 4 items (Premium Cherries, Lemons, Limes, Oranges) instead of 5; `full-mixers-only` and `the-full-compound` automatically pick up the relocated Bitters because they strip the entirety of `BASIC_MIXERS`; `the-formula` explicitly lists "Angostura Bitters" in its strip set so the bitters are covered regardless of which array it lives in.

The §3 coverage table is written assuming this cleanup has already happened.

---

## 8. Data shape

### 8.1 No new persisted fields

The active add-on slugs already live in `selections.addOns[slug].enabled`. The shortfall is computed on demand. Nothing new in the database.

### 8.2 New shape in generator input

The internal generator-input object (passed into `generateShoppingList`) gains:
- `activeAddonSlugs: string[]`

### 8.3 New shape in admin GET response

`GET /api/drink-plans/:id` response gains:
- `mixerShortfall: { neededCount: number, coveredCount: number, upgradeTarget: string } | null`

This field is also returned by `GET /api/drink-plans/t/:token/mixer-shortfall` (the new token-gated endpoint) but in a tighter wrapper:

```json
{
  "shortfall": { "neededCount": 5, "coveredCount": 3, "upgradeTarget": "full-mixers-only" },
  "currentAddonName": "Signature Mixers",
  "upgradeTargetName": "Full Mixers"
}
```

The token-gated endpoint joins `service_addons` to resolve the human-readable names, keeping the client thin.

---

## 9. Component changes summary

### 9.1 Files to create

- `server/utils/shoppingListAddonCoverage.js`: the coverage map, `pickCoveredMixers`, `computeStripSet`, and `detectMixerShortfall` exports.
- `server/utils/shoppingListAddonCoverage.test.js`: unit tests for the three pure helpers (see §11 quality gates for the test list).
- `client/src/pages/plan/components/MixerShortfallBanner.js`: the planner-side warning component.

### 9.2 Files to modify

- `server/utils/shoppingList.js`: relocate Angostura Bitters from GARNISHES to BASIC_MIXERS; export `INGREDIENT_MAP` and the new `MIXER_INGREDIENT_NAMES` map; integrate the strip set filter at the end of `generateShoppingList`.
- `server/utils/shoppingListGen.js`: extend `buildPlannerGeneratorInput` and `buildConsultGeneratorInput` to pass `activeAddonSlugs` through.
- `server/routes/drinkPlans.js`: extend `GET /api/drink-plans/:id` response with `mixerShortfall`; add new `GET /api/drink-plans/t/:token/mixer-shortfall` token-gated route.
- `client/src/pages/plan/steps/ConfirmationStep.js`: fetch the shortfall on mount and mount `<MixerShortfallBanner>` at the top when non-null.
- `client/src/pages/admin/EventDetailPage.js`: render a small admin shortfall banner near the drink-plan section when `drinkPlan.mixerShortfall` is non-null.
- `client/src/index.css`: append banner styles under `.potion-app` (planner) and at root scope (admin).

### 9.3 No new dependencies

Pure JS + Postgres + the existing patterns. No package additions.

---

## 10. Quality gates (definition of done)

Ship when ALL hold:

- [ ] Auto-generated `pending_review` shopping lists strip items covered by active add-ons. Verified by submitting a plan with each of the 9 byob_support add-ons (one at a time) and inspecting the generated list.
- [ ] Multi-add-on plans get union coverage. Verified by submitting a plan with Foundation + Signature Mixers and confirming both Foundation items AND up to 3 mixers are stripped.
- [ ] `signature-mixers-only` picks mixers by frequency, capped at 3. Verified by unit test with a contrived cocktail set whose mixer demand exceeds 3.
- [ ] `the-formula` covers Foundation + 3 mixers + Lemons + Limes + Oranges + Bitters. Verified by unit test.
- [ ] `full-mixers-only` and `the-full-compound` cover all mixers regardless of demand. Verified by unit test.
- [ ] Mixer-shortfall warning fires on the planner ConfirmationStep when sig cocktails need >3 mixers AND Signature Mixers OR Formula is active. Verified by browser walk-through.
- [ ] Mixer-shortfall warning does NOT fire when Full Mixers or Full Compound is also active (override).
- [ ] Admin EventDetailPage shows the matching shortfall banner with the same numbers.
- [ ] `GET /api/drink-plans/:id` response includes `mixerShortfall: null` when no shortfall, or the shortfall object when present. Verified by curl + JSON inspection.
- [ ] `GET /api/drink-plans/t/:token/mixer-shortfall` returns the expected shape with resolved add-on names. Verified by curl.
- [ ] Lists already in `pending_review` or `approved` state are NOT regenerated. Verified by submitting a second plan AFTER this change while a pre-existing pending_review list is loaded; the existing list is untouched.
- [ ] No em dashes introduced anywhere in code, copy, or comments.
- [ ] All unit tests in `shoppingListAddonCoverage.test.js` pass.
- [ ] No new server-side dependencies. No schema changes. No DDL.

---

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `INGREDIENT_MAP` atoms don't map cleanly to `BASIC_MIXERS` names | Medium | Build the `MIXER_INGREDIENT_NAMES` bridge map carefully, with unit tests asserting every BASIC_MIXERS entry has at least one INGREDIENT_MAP atom (or is intentionally unreachable from cocktails, like Club Soda which may be added as a basic mixer regardless of cocktails). Mismatches surface as "no covered mixers" not as crashes. |
| Cocktail with no INGREDIENT_MAP entry (deleted or renamed cocktail) | Low | `pickCoveredMixers` silently drops cocktails not in the map (matches the existing graceful-degradation pattern in `shoppingListGen.js`). |
| Stripping an item that was supposed to be on the list (false positive) | Medium | Coverage mapping is by exact item-name match. Unit tests cover each strip case. The operator's audit before approval is still the safety net for the first few real-event uses; if a real shortfall surfaces, it's a data fix to the coverage map, not a code fix. |
| Frequency tie-breaks pick the "wrong" 3 mixers | Low | Ties broken by `BASIC_MIXERS` array order (stable, deterministic). If the resulting choice is operationally wrong, the operator adjusts during audit; the coverage rule can be tweaked in a follow-up. |
| Client-side INGREDIENT_MAP drift | Low (mitigated by recommendation b) | Recommendation (b) keeps the shortfall computation server-side. The client never holds a copy of INGREDIENT_MAP. |
| Token-gated `/mixer-shortfall` endpoint is fetched on every ConfirmationStep render | Low | The component fetches once on mount and memoizes by `JSON.stringify(selections.signatureDrinks + Object.keys(selections.addOns))`. Re-fetch only when those change. |
| Auto-generation runs and a separate process modifies `selections` between snapshot and write | Low | The auto-generator's existing `WHERE shopping_list IS NULL` clause is a row-level guard; concurrent modification of `selections` JSON elsewhere doesn't trigger an auto-gen for that plan. |
| Operator hasn't yet updated the coverage mapping for a new byob_support add-on | Low | Document the coverage map clearly. The auto-gen falls back to no-strip for unknown slugs (graceful), so the new add-on just shows up as a non-stripping add-on until the map entry lands. |

---

## 12. Implementation order (suggested)

1. Categorization cleanup: relocate Angostura Bitters from GARNISHES to BASIC_MIXERS. Update any references in pricing or pars logic if any exist.
2. Server: export `INGREDIENT_MAP` and add `MIXER_INGREDIENT_NAMES` map to `shoppingList.js`.
3. Server: create `shoppingListAddonCoverage.js` with `pickCoveredMixers`, `computeStripSet`, and `detectMixerShortfall` exports.
4. Server: write `shoppingListAddonCoverage.test.js` with unit tests for all 9 add-on slugs + frequency cap + shortfall detection. Run; all pass.
5. Server: integrate `computeStripSet` into `generateShoppingList`. Verify generated lists subtract correctly.
6. Server: extend `buildPlannerGeneratorInput` and `buildConsultGeneratorInput` to pass `activeAddonSlugs`.
7. Server: extend `GET /api/drink-plans/:id` with `mixerShortfall` field.
8. Server: add `GET /api/drink-plans/t/:token/mixer-shortfall` token-gated route with resolved add-on names.
9. Client: create `<MixerShortfallBanner>` component.
10. Client: mount banner on ConfirmationStep with fetch + memoization.
11. Client: append banner CSS scoped under `.potion-app`.
12. Admin: render admin shortfall banner on EventDetailPage near the drink-plan section.
13. Admin: append admin banner CSS at root scope.
14. End-to-end verification pass: submit plans with each add-on combination; verify list output + warning behavior.

---

## 13. Out of scope (explicitly)

- Upcharge offer in the planner (one-click upgrade button).
- Retroactive regeneration of existing pending_review lists.
- Admin-editable coverage mapping (lives in code for v1).
- Subtraction for add-ons outside `byob_support` (premium, beverage, craft, staffing, logistics categories).
- Changes to the admin shopping list editing UI or PDF rendering. The list shape and audit modal stay the same, just with fewer items pre-stripped.
- A second tier of shortfall detection (e.g., garnish shortfall, ice shortfall). Mixers are the most operationally fraught case; the others are either binary (you have ice or you don't) or static (garnish package is a fixed package).
- Localization. All copy is English.

---

## 14. Open questions (resolve at writing-plans time, not now)

- The exact shape of `INGREDIENT_MAP` atom keys (e.g., `'club_soda'` vs `'clubSoda'`). The MIXER_INGREDIENT_NAMES bridge map needs to use the actual key shape. Confirm by inspecting `shoppingList.js` at plan-writing time.
- Whether `BASIC_MIXERS` should be sorted alphabetically for stable tie-breaking, or whether the existing order is the intended priority. Probably the existing order, since the operator has implicitly curated it.
- Whether the planner banner should re-fetch the shortfall on the ConfirmationStep itself, or compute it client-side as a fallback if the network is unavailable. Recommendation: fetch only, and gracefully render nothing on fetch failure (the admin warning is the backstop).
