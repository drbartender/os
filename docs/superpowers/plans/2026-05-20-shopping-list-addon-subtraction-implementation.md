# Shopping List Add-On Subtraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the auto-generated `pending_review` shopping list strip items covered by static BYOB-support add-ons (Foundation, Full Mixers, Garnish Package, Full Compound, ice-only, cups-only, water-only) so the operator no longer has to remove them during audit.

**Architecture:** A new pure helper `server/utils/shoppingListAddonCoverage.js` exports `computeStripSet({ activeAddonSlugs })` returning a `Set<string>` of item names. The existing generator `server/utils/shoppingList.js#generateShoppingList` receives `activeAddonSlugs` via its input object (passed through from `buildPlannerGeneratorInput` / `buildConsultGeneratorInput` in `shoppingListGen.js`), then filters both `liquorBeerWine` and `everythingElse` arrays by the strip set as a final step before returning. Plus a small categorization cleanup: Angostura Bitters moves from `GARNISHES` to `BASIC_MIXERS` (it isn't a garnish).

**Tech Stack:** Node 18+, raw JS via `pg`, Node's built-in `node:test` + `node:assert/strict` test runner (matches the existing server-side pattern in `server/utils/bookingWindow.test.js` etc.). No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-05-20-shopping-list-addon-subtraction-design.md`. Scope was reduced after Gemini caught a BLOCKER: `cocktails.ingredients` is unpopulated in the seed data, so `signature-mixers-only` and `the-formula` coverage (which depend on knowing each cocktail's ingredients) are deferred to a follow-up spec. This plan covers the 7 static-coverage add-ons only.

---

## Execution conventions

- **Commit pattern.** Per CLAUDE.md: plain `git commit -m "single line"` with no heredoc and no co-author footer. Always `git add <specific-path>`, never `git add .`. Each task commits as one logical change.
- **Em dashes.** Do not introduce em dashes anywhere in code, copy, or comments. Use commas, periods, colons, parentheticals.
- **Working directory:** `C:\Users\dalla\DRB_OS\os`. Branch: `main`. No worktree, no push (the user controls push timing).
- **Server-side tests** run with `node --test <path-to-test-file>` (Node 18+'s built-in runner). No jest config needed.

---

## File structure

```
server/utils/shoppingList.js                          # MODIFY: relocate Bitters; export BASIC_MIXERS + GARNISHES; integrate computeStripSet at the tail of generateShoppingList
server/utils/shoppingListGen.js                       # MODIFY: pass activeAddonSlugs through buildPlannerGeneratorInput + buildConsultGeneratorInput
server/utils/shoppingListAddonCoverage.js             # CREATE: coverage map + computeStripSet export
server/utils/shoppingListAddonCoverage.test.js        # CREATE: node:test unit tests for the helper
```

No client-side files. No schema changes. No new dependencies.

---

## Task 1: Move Angostura Bitters from GARNISHES to BASIC_MIXERS

A categorization cleanup. Bitters lives bottle-stored on the mixer rail, not with the garnish prep. Item, size, and qty stay identical, so shopping list output for plans without any covering add-ons is unchanged.

**Files:**
- Modify: `server/utils/shoppingList.js` (the `BASIC_MIXERS` and `GARNISHES` array literals near the top of the file)

- [ ] **Step 1: Locate the two arrays**

Open `server/utils/shoppingList.js`. `BASIC_MIXERS` is around lines 45-60 and `GARNISHES` is around lines 61-68. Find this exact content in `GARNISHES`:

```js
const GARNISHES = [
  { item: 'Angostura Bitters',   size: '4oz',     qty: 1 },
  { item: 'Premium Cherries',    size: 'ea.',     qty: 1 },
  { item: 'Lemons',              size: 'ea.',     qty: 4 },
  { item: 'Limes',               size: 'ea.',     qty: 12 },
  { item: 'Oranges',             size: 'ea.',     qty: 2 },
];
```

- [ ] **Step 2: Remove Bitters from GARNISHES**

Replace the `GARNISHES` block with:

```js
const GARNISHES = [
  { item: 'Premium Cherries',    size: 'ea.',     qty: 1 },
  { item: 'Lemons',              size: 'ea.',     qty: 4 },
  { item: 'Limes',               size: 'ea.',     qty: 12 },
  { item: 'Oranges',             size: 'ea.',     qty: 2 },
];
```

- [ ] **Step 3: Add Bitters to BASIC_MIXERS**

Find the `BASIC_MIXERS` block. It currently ends with `{ item: 'Simple Syrup', size: '1L', qty: 2 },` followed by `];`. Insert the Bitters line immediately AFTER Simple Syrup and BEFORE the closing `];`:

The block becomes:

```js
const BASIC_MIXERS = [
  { item: 'Coca Cola',           size: '12 pack', qty: 2 },
  { item: 'Diet Coke',           size: '12 pack', qty: 1 },
  { item: 'Ginger Ale',          size: '12 pack', qty: 1 },
  { item: 'Ginger Beer',         size: '4 pack',  qty: 3 },
  { item: 'Sprite',              size: '12 pack', qty: 1 },
  { item: 'Club Soda',           size: '8 pack',  qty: 6 },
  { item: 'Tonic Water',         size: '1L',      qty: 2 },
  { item: 'Cranberry Juice',     size: '64oz',    qty: 2 },
  { item: 'Pineapple Juice',     size: '64oz',    qty: 2 },
  { item: 'Orange Juice',        size: '1G',      qty: 1 },
  { item: 'Lemon Juice',         size: '31oz',    qty: 1 },
  { item: 'Lime Juice (UNSWEET)',size: '15oz',    qty: 1 },
  { item: 'Simple Syrup',        size: '1L',      qty: 2 },
  { item: 'Angostura Bitters',   size: '4oz',     qty: 1 },
];
```

- [ ] **Step 4: Verify no other references to Bitters need updating**

Run:
```
cd /c/Users/dalla/DRB_OS/os
grep -rn "Angostura Bitters\|Bitters" server/utils/shoppingList.js
```

Expected: one hit in `BASIC_MIXERS` and zero references elsewhere. (The `SPIRIT_MIXER_PAIRINGS` and `INGREDIENT_MAP` blocks may mention "bitters" lowercase as an ingredient atom; those reference cocktail ingredient atoms, not the exact display string. Don't touch them.)

- [ ] **Step 5: Commit**

```
git add server/utils/shoppingList.js
git commit -m "refactor(shopping-list): move Angostura Bitters from GARNISHES to BASIC_MIXERS"
```

---

## Task 2: Create shoppingListAddonCoverage.js helper (TDD)

A pure function that takes the list of active add-on slugs and returns a `Set<string>` of shopping list item names to strip. Tests first, then implementation.

**Files:**
- Create: `server/utils/shoppingListAddonCoverage.test.js`
- Create: `server/utils/shoppingListAddonCoverage.js`
- Modify: `server/utils/shoppingList.js` (export `BASIC_MIXERS` and `GARNISHES`)

- [ ] **Step 1: Export BASIC_MIXERS and GARNISHES from shoppingList.js**

The coverage helper imports BASIC_MIXERS and GARNISHES from `shoppingList.js` to derive the names for "all mixers" / "all garnishes" coverage. The existing `module.exports` line at the bottom of `shoppingList.js` (line ~491) is:

```js
module.exports = { generateShoppingList, getBottlesPerSyrup, buildGeneratorInputFromConsult };
```

Replace with:

```js
module.exports = { generateShoppingList, getBottlesPerSyrup, buildGeneratorInputFromConsult, BASIC_MIXERS, GARNISHES };
```

- [ ] **Step 2: Write the failing test file**

Create `server/utils/shoppingListAddonCoverage.test.js` with this exact content:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeStripSet } = require('./shoppingListAddonCoverage');

test('returns empty Set when activeAddonSlugs is missing', () => {
  const r = computeStripSet({});
  assert.equal(r.size, 0);
});

test('returns empty Set when activeAddonSlugs is empty array', () => {
  const r = computeStripSet({ activeAddonSlugs: [] });
  assert.equal(r.size, 0);
});

test('returns empty Set when activeAddonSlugs is null', () => {
  const r = computeStripSet({ activeAddonSlugs: null });
  assert.equal(r.size, 0);
});

test('ice-delivery-only strips Ice', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only'] });
  assert.deepEqual([...r].sort(), ['Ice']);
});

test('cups-disposables-only strips Cups, Straws, Napkins', () => {
  const r = computeStripSet({ activeAddonSlugs: ['cups-disposables-only'] });
  assert.deepEqual([...r].sort(), ['Cups (9oz)', 'Napkins', 'Straws']);
});

test('bottled-water-only strips Water', () => {
  const r = computeStripSet({ activeAddonSlugs: ['bottled-water-only'] });
  assert.deepEqual([...r].sort(), ['Water']);
});

test('full-mixers-only strips all BASIC_MIXERS including Bitters and Simple Syrup', () => {
  const r = computeStripSet({ activeAddonSlugs: ['full-mixers-only'] });
  // After Task 1 cleanup, BASIC_MIXERS contains 14 items.
  assert.equal(r.size, 14);
  assert.ok(r.has('Coca Cola'));
  assert.ok(r.has('Simple Syrup'));
  assert.ok(r.has('Angostura Bitters'));
  assert.ok(!r.has('Lemons'));      // Lemons stay in GARNISHES, not stripped here
  assert.ok(!r.has('Ice'));         // Ice is ALWAYS_INCLUDE, not BASIC_MIXERS
});

test('garnish-package-only strips all 4 GARNISHES items (no Bitters)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['garnish-package-only'] });
  assert.deepEqual([...r].sort(), ['Lemons', 'Limes', 'Oranges', 'Premium Cherries']);
});

test('the-foundation strips Foundation items (Water, Cups, Straws, Napkins, Ice)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-foundation'] });
  assert.deepEqual([...r].sort(), ['Cups (9oz)', 'Ice', 'Napkins', 'Straws', 'Water']);
});

test('the-full-compound strips Foundation + all BASIC_MIXERS + all GARNISHES', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-full-compound'] });
  // 5 Foundation + 14 BASIC_MIXERS + 4 GARNISHES = 23
  assert.equal(r.size, 23);
  assert.ok(r.has('Ice'));
  assert.ok(r.has('Angostura Bitters'));
  assert.ok(r.has('Premium Cherries'));
  assert.ok(r.has('Lemons'));
  assert.ok(r.has('Coca Cola'));
});

test('unknown slug is silently ignored (no error, empty contribution)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['some-future-addon-slug'] });
  assert.equal(r.size, 0);
});

test('signature-mixers-only is silently skipped in v1 (deferred to follow-up spec)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['signature-mixers-only'] });
  assert.equal(r.size, 0);
});

test('the-formula is silently skipped in v1 (deferred to follow-up spec)', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-formula'] });
  assert.equal(r.size, 0);
});

test('multiple add-ons union their coverage', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only', 'bottled-water-only'] });
  assert.deepEqual([...r].sort(), ['Ice', 'Water']);
});

test('Foundation + Full Mixers stripped together: union covers 5 + 14 items', () => {
  const r = computeStripSet({ activeAddonSlugs: ['the-foundation', 'full-mixers-only'] });
  // 5 Foundation + 14 BASIC_MIXERS, no overlap.
  assert.equal(r.size, 19);
  assert.ok(r.has('Ice'));
  assert.ok(r.has('Angostura Bitters'));
});

test('duplicate slugs in input do not cause duplicate Set entries', () => {
  const r = computeStripSet({ activeAddonSlugs: ['ice-delivery-only', 'ice-delivery-only'] });
  assert.equal(r.size, 1);
  assert.ok(r.has('Ice'));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```
cd /c/Users/dalla/DRB_OS/os
node --test server/utils/shoppingListAddonCoverage.test.js
```

Expected: ALL tests fail with "Cannot find module './shoppingListAddonCoverage'" (the file doesn't exist yet).

- [ ] **Step 4: Create the helper**

Create `server/utils/shoppingListAddonCoverage.js` with this exact content:

```js
// Per-add-on shopping list coverage map. Each entry lists the item names
// that the corresponding service add-on (from the byob_support category)
// substitutes for. The list is filtered out of the auto-generated
// shopping list at the end of generateShoppingList in shoppingList.js.
//
// signature-mixers-only and the-formula are NOT in this map. They are
// silently skipped in v1 because their coverage depends on per-cocktail
// ingredient data that is not yet populated for seeded cocktails
// (cocktails.ingredients defaults to '[]' for every row). The follow-up
// spec at docs/superpowers/specs/ (to be authored) will add them once
// the ingredient data is in place.
//
// Unknown slugs are silently ignored. The operator's audit before
// approval is the safety net for any drift.

const { BASIC_MIXERS, GARNISHES } = require('./shoppingList');

const FOUNDATION_ITEMS = ['Water', 'Cups (9oz)', 'Straws', 'Napkins', 'Ice'];

function namesOf(items) {
  return items.map((i) => i.item);
}

function addAll(set, names) {
  for (const n of names) set.add(n);
}

function computeStripSet({ activeAddonSlugs } = {}) {
  const stripSet = new Set();
  if (!Array.isArray(activeAddonSlugs) || activeAddonSlugs.length === 0) {
    return stripSet;
  }

  const allBasicMixers = namesOf(BASIC_MIXERS);
  const allGarnishes = namesOf(GARNISHES);

  for (const slug of activeAddonSlugs) {
    switch (slug) {
      case 'ice-delivery-only':
        stripSet.add('Ice');
        break;
      case 'cups-disposables-only':
        stripSet.add('Cups (9oz)');
        stripSet.add('Straws');
        stripSet.add('Napkins');
        break;
      case 'bottled-water-only':
        stripSet.add('Water');
        break;
      case 'full-mixers-only':
        addAll(stripSet, allBasicMixers);
        break;
      case 'garnish-package-only':
        addAll(stripSet, allGarnishes);
        break;
      case 'the-foundation':
        addAll(stripSet, FOUNDATION_ITEMS);
        break;
      case 'the-full-compound':
        addAll(stripSet, FOUNDATION_ITEMS);
        addAll(stripSet, allBasicMixers);
        addAll(stripSet, allGarnishes);
        break;
      default:
        // signature-mixers-only, the-formula, and any unknown slug.
        // Silently skipped; the operator's audit handles any gaps.
        break;
    }
  }

  return stripSet;
}

module.exports = { computeStripSet };
```

- [ ] **Step 5: Run the tests, verify all pass**

```
cd /c/Users/dalla/DRB_OS/os
node --test server/utils/shoppingListAddonCoverage.test.js
```

Expected: all 16 tests pass.

- [ ] **Step 6: Commit**

```
git add server/utils/shoppingList.js server/utils/shoppingListAddonCoverage.js server/utils/shoppingListAddonCoverage.test.js
git commit -m "feat(shopping-list): add-on coverage helper with computeStripSet plus node:test unit tests"
```

---

## Task 3: Pass activeAddonSlugs through input builders

Extend `buildPlannerGeneratorInput` and `buildConsultGeneratorInput` in `server/utils/shoppingListGen.js` to read `selections.addOns` (or `consult.addOns`) and project to the active-slugs array on the generator input.

**Files:**
- Modify: `server/utils/shoppingListGen.js`

- [ ] **Step 1: Find and extend `buildPlannerGeneratorInput`**

Open `server/utils/shoppingListGen.js`. Locate `buildPlannerGeneratorInput` around line 44. Its current return block (around lines 51-67) ends with `mixersForSignatureDrinks` followed by a closing `};`. Add a new field `activeAddonSlugs` to the returned object, derived from `sel.addOns`. The relevant edit context:

```js
async function buildPlannerGeneratorInput(plan, dbClient) {
  const sel = plan.selections || {};
  const sigDrinkIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  const signatureCocktails = await resolveCocktailIds(sigDrinkIds, dbClient);
  const syrupSelfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const syrupNamesById = syrupSelfProvided.length > 0 ? SYRUP_NAME_LOOKUP : {};
  const isFullBar = (plan.serving_type || 'full_bar') === 'full_bar';
  const beerSelections = isFullBar ? (sel.beerFromFullBar || []) : (sel.beerFromBeerWine || []);
  const wineSelections = isFullBar ? (sel.wineFromFullBar || []) : (sel.wineFromBeerWine || []);
  return {
    clientName: plan.client_name,
    guestCount: plan.guest_count,
    signatureCocktails,
    syrupSelfProvided,
    syrupNamesById,
    eventDate: plan.event_date,
    notes: plan.admin_notes || '',
    serviceStyle: plan.serving_type || 'full_bar',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: sel.mixersForSignatureDrinks ?? null,
  };
}
```

Add the `activeAddonSlugs` field by changing the return to:

```js
  return {
    clientName: plan.client_name,
    guestCount: plan.guest_count,
    signatureCocktails,
    syrupSelfProvided,
    syrupNamesById,
    eventDate: plan.event_date,
    notes: plan.admin_notes || '',
    serviceStyle: plan.serving_type || 'full_bar',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: sel.mixersForSignatureDrinks ?? null,
    activeAddonSlugs: Object.entries(sel.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
```

The check is `meta && meta.enabled` (truthy) rather than `=== true` to match the existing client-side pattern in `ConfirmationStep.js`.

- [ ] **Step 2: Find and extend `buildConsultGeneratorInput`**

In the same file, locate `buildConsultGeneratorInput` around line 69. It calls `buildGeneratorInputFromConsult` from `./shoppingList` and returns its result. The helper passes `consult` through; the consult variant should ALSO surface active add-on slugs.

Modify the body to capture the slug list from `consult.addOns` and add it to whatever object `buildGeneratorInputFromConsult` returns:

```js
async function buildConsultGeneratorInput(plan, dbClient) {
  const consult = plan.consult_selections || {};
  const sigIds = Array.isArray(consult.signatureDrinks) ? consult.signatureDrinks : [];
  const mockIds = Array.isArray(consult.mocktails) ? consult.mocktails : [];
  const [resolvedSigs, resolvedMocktails] = await Promise.all([
    resolveCocktailIds(sigIds, dbClient),
    resolveCocktailIds(mockIds, dbClient),
  ]);
  const generatorInput = buildGeneratorInputFromConsult(
    consult,
    {
      clientName: plan.client_name,
      guestCount: plan.guest_count,
      eventDate: plan.event_date,
    },
    resolvedSigs,
    resolvedMocktails
  );
  return {
    ...generatorInput,
    activeAddonSlugs: Object.entries(consult.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
}
```

The change is wrapping the existing `buildGeneratorInputFromConsult(...)` return value into a spread, then adding `activeAddonSlugs`.

- [ ] **Step 3: Verify file still parses**

```
cd /c/Users/dalla/DRB_OS/os
node -c server/utils/shoppingListGen.js
```

Expected: no output (clean parse).

- [ ] **Step 4: Commit**

```
git add server/utils/shoppingListGen.js
git commit -m "feat(shopping-list): pass activeAddonSlugs through planner and consult input builders"
```

---

## Task 4: Integrate computeStripSet into generateShoppingList

Apply the strip set as a final filter to both `liquorBeerWine` and `everythingElse` arrays before `generateShoppingList` returns.

**Files:**
- Modify: `server/utils/shoppingList.js`

- [ ] **Step 1: Import computeStripSet**

At the top of `server/utils/shoppingList.js` (alongside the `const crypto = require('crypto');` line near line 9), add:

```js
const { computeStripSet } = require('./shoppingListAddonCoverage');
```

- [ ] **Step 2: Apply the filter inside `generateShoppingList`**

Locate `generateShoppingList` around line 388. Find the return block around lines 412-426:

```js
  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine,
    everythingElse,
    serviceStyle,
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks,
    _signatureCocktails: signatureCocktails,
    _syrupSelfProvided: syrupSelfProvided,
  };
}
```

Replace with (apply the strip filter just before return; only `liquorBeerWine` and `everythingElse` need filtering since they're the only arrays containing shopping items, while other fields are metadata):

```js
  // Final pass: subtract items covered by static BYOB-support add-ons.
  // See server/utils/shoppingListAddonCoverage.js. Empty strip set when
  // no covering add-ons are active, in which case this is a no-op.
  const stripSet = computeStripSet({ activeAddonSlugs: eventData.activeAddonSlugs });
  const filteredLiquorBeerWine = stripSet.size > 0
    ? liquorBeerWine.filter((i) => !stripSet.has(i.item))
    : liquorBeerWine;
  const filteredEverythingElse = stripSet.size > 0
    ? everythingElse.filter((i) => !stripSet.has(i.item))
    : everythingElse;

  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine: filteredLiquorBeerWine,
    everythingElse: filteredEverythingElse,
    serviceStyle,
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks,
    _signatureCocktails: signatureCocktails,
    _syrupSelfProvided: syrupSelfProvided,
  };
}
```

The `eventData.activeAddonSlugs` field is populated by the input builders modified in Task 3. If absent (e.g., legacy callers haven't been updated), `computeStripSet` returns an empty Set and no items are stripped.

- [ ] **Step 3: Verify file still parses and existing tests still pass**

```
cd /c/Users/dalla/DRB_OS/os
node -c server/utils/shoppingList.js
node --test server/utils/shoppingListAddonCoverage.test.js
```

Expected: clean parse + all 16 helper tests pass.

- [ ] **Step 4: Commit**

```
git add server/utils/shoppingList.js
git commit -m "feat(shopping-list): apply add-on coverage strip set at the tail of generateShoppingList"
```

---

## Task 5: End-to-end verification on the dev server

Manual verification by submitting plans with each add-on active and inspecting the generated shopping list. The dev server is running in the background (controller-managed).

**Files:**
- Possibly modify any file if a defect is found during verification

- [ ] **Step 1: Identify or create test drink plans**

Pick or create at least one in-progress draft drink plan that you can submit. You need to be able to toggle which add-ons are active via the admin proposal page (add-ons live on the proposal; the planner reads them from `selections.addOns`).

The 7 add-on slugs to test:
- `ice-delivery-only`
- `cups-disposables-only`
- `bottled-water-only`
- `full-mixers-only`
- `garnish-package-only`
- `the-foundation`
- `the-full-compound`

- [ ] **Step 2: Run a baseline submission with NO covering add-ons**

Submit a plan with no byob_support add-ons active. Inspect the auto-generated `pending_review` shopping list (admin Event Detail page or the shopping-list editing modal). Note the items that appear, especially the contents of "Everything Else" section (BASIC_MIXERS, GARNISHES, ALWAYS_INCLUDE items).

Expected: all 14 BASIC_MIXERS items present, all 4 GARNISHES items present, all 5 ALWAYS_INCLUDE items (Water, Cups (9oz), Straws, Napkins, Ice) present.

- [ ] **Step 3: Submit a plan with each individual add-on**

For each of the 7 slugs above (creating a fresh plan or repeatedly toggling addons + resubmitting, depending on what's easiest):

| Slug | Expected stripped items |
|---|---|
| `ice-delivery-only` | `Ice` is GONE |
| `cups-disposables-only` | `Cups (9oz)`, `Straws`, `Napkins` are GONE |
| `bottled-water-only` | `Water` is GONE |
| `full-mixers-only` | All 14 BASIC_MIXERS items GONE (incl. Angostura Bitters, Simple Syrup) |
| `garnish-package-only` | `Premium Cherries`, `Lemons`, `Limes`, `Oranges` GONE; Bitters STAYS (now in BASIC_MIXERS) |
| `the-foundation` | `Water`, `Cups (9oz)`, `Straws`, `Napkins`, `Ice` GONE |
| `the-full-compound` | All 5 Foundation items + 14 BASIC_MIXERS + 4 GARNISHES items GONE (23 items total stripped) |

If any expected strip doesn't happen, dig into the auto-gen logs and the `eventData.activeAddonSlugs` value during the submission.

- [ ] **Step 4: Submit a plan with TWO add-ons active**

Pick any two slugs (e.g., `the-foundation` + `full-mixers-only`). Submit and verify the strip set is the UNION (Foundation items + all BASIC_MIXERS = 19 items stripped).

- [ ] **Step 5: Confirm pre-existing pending_review lists are NOT regenerated**

Pick a plan that already has a `pending_review` shopping list from BEFORE this change. Resubmit it (if your test setup permits) or just verify that the existing list is unchanged in the admin UI. The auto-gen's `WHERE shopping_list IS NULL` guard means existing lists are never overwritten.

- [ ] **Step 6: No commit unless defects surfaced**

If verification passed cleanly, no commit needed. If a defect surfaced, fix in place and commit with `fix(shopping-list): <issue>` as a separate commit.

---

## Self-review

A check against the spec, run after writing the plan above.

**1. Spec coverage**

| Spec section | Implemented in task |
|---|---|
| §1 Goals (subtract static add-ons) | Tasks 2, 3, 4 |
| §1 Categorization cleanup (Bitters move) | Task 1 |
| §1 Non-goals (signature-mixers / formula / shortfall) | Task 2 step 4 (helper has `default` case that silently skips deferred slugs); Task 2 tests assert the skip behavior |
| §3 Coverage mapping | Task 2 step 4 (the helper's switch statement maps each slug to its strip items) |
| §3 Truthy enable check (`meta?.enabled`) | Task 3 (input builder uses `meta && meta.enabled`) |
| §4 Input builder change | Task 3 (both planner and consult variants) |
| §4 Generator integration (strip at tail) | Task 4 |
| §4 No regeneration of existing lists | Task 5 step 5 (verification only; the existing `WHERE shopping_list IS NULL` guard in `autoGenerateShoppingList` enforces this) |
| §5 Categorization cleanup | Task 1 |
| §6 No new persisted fields | All tasks (no schema changes) |
| §6 New shape on generator input | Task 3 |
| §6 No API response changes | All tasks (no route changes) |
| §7 Files to create / modify | Mapped 1-to-1 in task headers |
| §8 Implementation order | Task ordering matches |
| §9 Quality gates | Task 2 unit tests + Task 5 end-to-end |
| §10 Risks | Addressed in plan structure (TDD, exact item-name match, helper silently skips unknown slugs) |
| §11 Out of scope | Acknowledged in Task 2's deferred-slug tests |

No spec gaps identified.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", or vague handwaving. Every step contains actual code or commands. The "deferred to follow-up" mentions are explicit and documented as non-goals.

**3. Type consistency**

- `activeAddonSlugs: string[]` shape is used identically in Task 3 (builder output) and Task 4 (generator input).
- `computeStripSet({ activeAddonSlugs })` signature with destructured option object is consistent across Task 2 tests, Task 2 implementation, and Task 4 call site.
- The strip set `Set<string>` of item names is consistent everywhere.
- Item-name strings match BASIC_MIXERS / GARNISHES / ALWAYS_INCLUDE literals exactly (e.g., `'Cups (9oz)'` with parenthesized size, `'Angostura Bitters'` capitalization, `'Lime Juice (UNSWEET)'` if needed). Note that `Lime Juice (UNSWEET)` is in BASIC_MIXERS and gets stripped via `full-mixers-only`, not by individual reference.

No drift detected.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-shopping-list-addon-subtraction-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended).** Fresh subagent per task, two-stage review after each. Tasks are small and independent; subagent isolation works cleanly. 4 implementation tasks + 1 verification task.

2. **Inline Execution.** Walk through tasks in this session with batch checkpoints.

Which approach?
