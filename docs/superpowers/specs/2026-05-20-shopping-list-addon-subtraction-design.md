# Spec: Shopping List Add-On Subtraction (Static Coverage)

> Make the auto-generated shopping list subtract items covered by static (non-cocktail-dependent) BYOB-support add-ons so the operator no longer has to manually strip them during audit. The cocktail-ingredient-dependent pieces (Signature Mixers, The Formula, and the mixer-shortfall warning) are deferred to a follow-up spec because the underlying cocktail ingredient data is not yet populated.

This spec implements the deferred work called out at §11 of `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md`. That spec shipped scope-banner copy on the planner promising *"anything you've added as an upgrade will come from us instead"*. The promise is in production; the server-side enforcement is what this spec adds, scoped to the add-ons whose coverage is statically defined.

---

## 1. Goals and non-goals

### Goals

- The auto-generated `pending_review` shopping list strips items covered by the client's active BYOB-support add-ons before it is staged.
- Cover the seven add-ons whose coverage is statically defined (no cocktail-ingredient lookup needed): `ice-delivery-only`, `cups-disposables-only`, `bottled-water-only`, `full-mixers-only`, `garnish-package-only`, `the-foundation`, `the-full-compound`.
- Categorization cleanup: Angostura Bitters moves from the `GARNISHES` constant to `BASIC_MIXERS` in `server/utils/shoppingList.js`. Bitters is not a garnish.

### Non-goals (explicit out-of-scope, deferred to follow-up specs)

- **`signature-mixers-only` and `the-formula` coverage logic.** Both depend on knowing which mixers each signature cocktail needs. The `cocktails.ingredients` JSONB column exists but is empty for all seeded cocktails (`DEFAULT '[]'`, never populated by INSERT or UPDATE in `schema.sql`). The existing generator's per-cocktail ingredient loop runs but adds nothing because the data isn't there. Until cocktail ingredients are populated, these two add-ons cannot be reliably subtracted.
- **Mixer-shortfall warning** (planner ConfirmationStep banner + admin EventDetailPage flag). Depends on the same cocktail-ingredient data. Deferred.
- **Cocktail-ingredient data population.** Filling in the 25+ seeded cocktails' ingredients arrays is its own data project; needs admin UI and/or seed authoring. Out of scope here.
- **Upcharge offer in the planner.** Out of scope until the shortfall warning ships in the follow-up.
- **Retroactive regeneration** of `pending_review` lists created before this change. The operator audits those manually as today.
- **Re-running subtraction** on already-approved lists. Approved lists are operator-edited and immutable from this code path.
- **Admin-editable add-on coverage mapping.** Stays in code for v1.
- **Subtraction for add-ons outside the `byob_support` category.** Premium, beverage, craft, staffing, and logistics add-ons do not strip shopping list items.
- **Changes to the manual shopping list editing UI on the admin side.** The audit modal and any manual edits work as they do today, just on a list that has already been pre-stripped where possible.

---

## 2. Status and prior art

- **Prior commitments**: `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md` §6 ships scope-banner copy promising subtraction. This spec partially closes the loop (static add-ons only); the follow-up cocktail-ingredient spec closes the rest.
- **Current generator**: `server/utils/shoppingList.js` builds the list from hardcoded `BASIC_MIXERS`, `ALWAYS_INCLUDE` (Water, Cups, Straws, Napkins, Ice), and `GARNISHES` constants plus dynamic per-cocktail ingredient decomposition via `INGREDIENT_MAP`. The per-cocktail decomposition is currently a no-op for seeded cocktails because `cocktails.ingredients` is empty; the BASIC_MIXERS, ALWAYS_INCLUDE, and GARNISHES additions all still apply.
- **Current input builder**: `server/utils/shoppingListGen.js#buildPlannerGeneratorInput` does NOT pass `selections.addOns` through to the generator. This is the first piece of plumbing the spec changes.
- **Auto-generation timing**: `autoGenerateShoppingList(planId, dbClient)` runs at submit time with strict no-overwrite semantics (`WHERE shopping_list IS NULL`). The list is staged as `pending_review`, the operator audits and approves. This spec changes what gets staged INITIALLY; the post-approval state is unchanged.
- **The 7 static byob_support add-ons** covered by this spec: `ice-delivery-only`, `cups-disposables-only`, `bottled-water-only`, `full-mixers-only`, `garnish-package-only`, `the-foundation`, `the-full-compound`.
- **The 2 deferred byob_support add-ons**: `signature-mixers-only` and `the-formula`. Both require cocktail-ingredient data the system does not yet have.

---

## 3. Add-on coverage mapping

Defined in code as a new module at `server/utils/shoppingListAddonCoverage.js`. Stays out of `shoppingList.js` to keep responsibilities focused; `shoppingList.js` already has substantial line count.

| Slug | Strips |
|---|---|
| `ice-delivery-only` | Ice |
| `cups-disposables-only` | Cups (9oz), Straws, Napkins |
| `bottled-water-only` | Water |
| `full-mixers-only` | All items in `BASIC_MIXERS` (after the §5 cleanup this includes Simple Syrup and Angostura Bitters) |
| `garnish-package-only` | All items in `GARNISHES` (Premium Cherries, Lemons, Limes, Oranges) |
| `the-foundation` | Water, Cups (9oz), Straws, Napkins, Ice |
| `the-full-compound` | Foundation items + all `BASIC_MIXERS` + all `GARNISHES` |

**Union when multiple add-ons are active.** If the client has both Foundation AND full-mixers-only, the strip set is Foundation's items unioned with all BASIC_MIXERS.

**Override semantics.** `full-mixers-only` and `the-full-compound` cover all mixers. If either is active, all `BASIC_MIXERS` items are stripped regardless of which other add-ons are active.

**Truthy enable check.** An add-on is considered active when `selections.addOns[slug]?.enabled` is truthy. This matches the existing client-side pattern in `ConfirmationStep.js` (where `meta?.enabled` is the check), not a strict `=== true` comparison.

**Deferred add-ons.** `signature-mixers-only` and `the-formula` are silently skipped by the coverage helper in v1. The follow-up spec adds them.

---

## 4. Shopping list generator integration

### 4.1 Input builder change

`server/utils/shoppingListGen.js#buildPlannerGeneratorInput` is extended to read `sel.addOns` and pass the active slugs through. The active slugs are the keys of `selections.addOns` where the value's `enabled` is truthy:

```js
return {
  ...existing fields...,
  activeAddonSlugs: Object.entries(sel.addOns || {})
    .filter(([, meta]) => meta && meta.enabled)
    .map(([slug]) => slug),
};
```

The consult variant `buildConsultGeneratorInput` gets the same field, sourced from `consult.addOns` (mirroring the planner variant).

### 4.2 Generator change

`server/utils/shoppingList.js#generateShoppingList` accepts the new `activeAddonSlugs` field on its input object. After all the existing list-building logic (cocktail decomposition, BASIC_MIXERS merge, garnishes, pars scaling), it calls into the new coverage helper to produce the strip set and filters the final list:

```js
const stripSet = computeStripSet({ activeAddonSlugs });
return finalItems.filter((item) => !stripSet.has(item.item));
```

`computeStripSet` is the exported function from `shoppingListAddonCoverage.js`. It returns a `Set<string>` of item names to drop. Matching is by exact item-name string (e.g., `'Lemons'`, `'Cups (9oz)'`).

### 4.3 The strip happens last

After every other generator step. This keeps all existing math (per-100 scaling, mixer pairings, signature-cocktail decomposition) untouched. The subtraction is purely a final filter pass. If the strip set is empty (no covered add-ons active), the output is identical to today.

### 4.4 No regeneration of existing lists

The auto-generator at `autoGenerateShoppingList` has `WHERE shopping_list IS NULL` no-overwrite semantics. This spec does not change that. Lists already in `pending_review` (or `approved`) state are not touched. New submissions get the new behavior; old ones stay as they were.

---

## 5. Categorization cleanup

Small refactor in `server/utils/shoppingList.js`:

Move `{ item: 'Angostura Bitters', size: '4oz', qty: 1 }` from the `GARNISHES` array to the `BASIC_MIXERS` array. The bitters are bottle-stored mixer-adjacent essentials, not garnishes.

**No behavior change at the shopping list output**: the bitters still get added at the same quantity. The only difference is which array it lives in.

**Implication for coverage mapping**: `garnish-package-only` strips 4 items (Premium Cherries, Lemons, Limes, Oranges) instead of 5; `full-mixers-only` and `the-full-compound` automatically pick up the relocated Bitters because they strip the entirety of `BASIC_MIXERS`.

The §3 coverage table is written assuming this cleanup has already happened.

---

## 6. Data shape

### 6.1 No new persisted fields

The active add-on slugs already live in `selections.addOns[slug].enabled`. Nothing new in the database.

### 6.2 New shape in generator input

The internal generator-input object (passed into `generateShoppingList`) gains:
- `activeAddonSlugs: string[]`

### 6.3 No API response changes

This spec does not modify any HTTP route response shape. The admin `GET /api/drink-plans/:id` and the public `GET /api/drink-plans/t/:token` return their existing shapes. The shopping list itself has fewer items in it for plans that bought covering add-ons, but the wrapper shape is the same.

---

## 7. Component changes summary

### 7.1 Files to create

- `server/utils/shoppingListAddonCoverage.js` — the coverage map and `computeStripSet` export.
- `server/utils/shoppingListAddonCoverage.test.js` — unit tests for the helper (see §9 quality gates).

### 7.2 Files to modify

- `server/utils/shoppingList.js`: relocate Angostura Bitters from GARNISHES to BASIC_MIXERS; integrate the strip set filter at the end of `generateShoppingList`.
- `server/utils/shoppingListGen.js`: extend `buildPlannerGeneratorInput` and `buildConsultGeneratorInput` to pass `activeAddonSlugs` through.

### 7.3 No client-side changes

The client renders the shopping list as data; fewer items just means a shorter list. No UI changes needed.

### 7.4 No new dependencies

Pure JS + Postgres + the existing patterns. No package additions.

---

## 8. Implementation order (suggested)

1. **Categorization cleanup**: relocate Angostura Bitters from GARNISHES to BASIC_MIXERS in `shoppingList.js`. Run any existing shopping-list-related tests to confirm no regressions.
2. **Coverage helper**: create `shoppingListAddonCoverage.js` with the coverage map and `computeStripSet` export.
3. **Helper tests**: create `shoppingListAddonCoverage.test.js` with unit tests for each of the 7 supported slugs plus the union and override cases. Run; all pass.
4. **Input builder**: extend `buildPlannerGeneratorInput` and `buildConsultGeneratorInput` to pass `activeAddonSlugs`.
5. **Generator integration**: in `generateShoppingList`, compute the strip set from `activeAddonSlugs` and filter the final items.
6. **End-to-end verification**: submit a plan with each of the 7 add-ons (one at a time), inspect the resulting `pending_review` shopping list, confirm the right items are absent.

---

## 9. Quality gates (definition of done)

Ship when ALL hold:

- [ ] Auto-generated `pending_review` shopping lists strip items covered by active static add-ons. Verified by submitting plans with each of the 7 supported add-ons and inspecting the generated list.
- [ ] Multi-add-on plans get union coverage. Verified by submitting a plan with Foundation + Full Mixers and confirming both Foundation items AND BASIC_MIXERS are stripped.
- [ ] `full-mixers-only` and `the-full-compound` strip all `BASIC_MIXERS` (including the relocated Angostura Bitters). Verified by unit test.
- [ ] `garnish-package-only` strips only the 4 garnish items (Premium Cherries, Lemons, Limes, Oranges) and does NOT strip Bitters. Verified by unit test.
- [ ] Plans with `signature-mixers-only` or `the-formula` active but no other covering add-ons produce shopping lists with NO stripping (these slugs are silently skipped in v1). Verified by unit test.
- [ ] Lists already in `pending_review` or `approved` state are NOT regenerated. Verified by submitting a second plan AFTER this change while a pre-existing pending_review list is loaded; the existing list is untouched.
- [ ] The Angostura Bitters relocation does not change shopping list output for plans with NO add-ons. Verified by snapshot diff of a sample plan's generated list before and after the cleanup.
- [ ] No em dashes introduced anywhere in code, copy, or comments.
- [ ] All unit tests in `shoppingListAddonCoverage.test.js` pass.
- [ ] No new server-side dependencies. No schema changes. No DDL.

---

## 10. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Stripping an item that was supposed to be on the list (false positive) | Low | Coverage mapping is by exact item-name match. Unit tests cover each strip case. The operator's audit before approval is still the safety net. |
| Operator hasn't yet updated the coverage mapping for a new byob_support add-on | Low | Document the coverage map clearly. The helper falls back to no-strip for unknown slugs (graceful), so a new add-on shows up as a non-stripping add-on until the map entry lands. |
| Auto-generation runs and a separate process modifies `selections` between snapshot and write | Low | The auto-generator's existing `WHERE shopping_list IS NULL` clause is a row-level guard; concurrent modification of `selections` JSON elsewhere doesn't trigger an auto-gen for that plan. |
| `signature-mixers-only` and `the-formula` clients don't get any subtraction in v1 | Acknowledged | Documented in §1 as deferred. Operator audit is the existing backstop; these clients are no worse off than today. The follow-up spec closes this loop once cocktail ingredients are populated. |
| The Angostura Bitters move breaks an unknown downstream consumer | Low | Bitters as an item-name string is unchanged. Quantity is unchanged. Only the source array constant changes. Snapshot test verifies no diff on a clean (no-addon) plan. |
| Coverage map drift (a new byob_support add-on gets added to `service_addons` table but not to the coverage map) | Medium | The helper silently no-strips unknown slugs. The operator notices during audit and updates the map. Document this in the helper's header comment. |

---

## 11. Out of scope (explicitly)

- `signature-mixers-only` coverage logic.
- `the-formula` coverage logic.
- Mixer-shortfall detection.
- Mixer-shortfall warning banner on planner ConfirmationStep.
- Admin-side mixer-shortfall flag on EventDetailPage.
- Token-gated `/mixer-shortfall` endpoint.
- Upcharge offer in the planner.
- Retroactive regeneration of existing pending_review lists.
- Admin-editable coverage mapping.
- Subtraction for add-ons outside `byob_support` (premium, beverage, craft, staffing, logistics categories).
- Changes to the admin shopping list editing UI, PDF rendering, or any email referencing the list.
- Cocktail-ingredient data population (the follow-up's prerequisite).
- Localization. All copy is English.

---

## 12. Follow-up spec (for the deferred work)

A follow-up spec will cover the cocktail-ingredient-dependent pieces. It will need:

1. **Cocktail-ingredient data population.** Either an admin UI to edit `cocktails.ingredients` per cocktail, or a SQL UPDATE block in the seed file with the ~25 cocktail recipes, or both. This is the load-bearing prerequisite.
2. **`signature-mixers-only` coverage**: pick up to 3 mixers needed by the signature cocktails (by frequency, ties broken by `BASIC_MIXERS` array order).
3. **`the-formula` coverage**: same 3-mixer rule + Lemons + Limes + Oranges + Angostura Bitters + Foundation items.
4. **Mixer-shortfall warning**: detect when Signature Mixers or The Formula is active AND sig cocktails need more than 3 unique mixers; render warning on planner ConfirmationStep (token-gated server endpoint to compute, banner with `role="alert"` for accessibility) and admin EventDetailPage (server-computed on whichever route the admin page actually calls — verify against `GET /api/drink-plans/by-proposal/:proposalId` since `EventDetailPage.js` calls that, not `/:id`).
5. **Upcharge offer copy and button**: optional, can be a third spec if it grows.
