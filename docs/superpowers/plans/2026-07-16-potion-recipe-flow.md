---
spec: docs/superpowers/specs/2026-07-16-potion-custom-recipe-flow-design.md
lanes:
  - id: potion-recipe-flow
    footprint:
      - server/db/schema.sql
      - server/routes/potions.js          # sanitizeRequestAliases helper + export only
      - server/routes/potions.test.js
      - server/routes/cocktails.js
      - server/routes/mocktails.js
      - server/routes/drinkPlans.js       # PUT shopping-list: strip _unresolvedIngredients
      - server/routes/drinkPlans.shoppingListStrip.test.js
      - server/utils/shoppingListGen.js
      - server/utils/shoppingList.generator.test.js
      - client/src/components/potions/RecipeEditor.js
      - client/src/components/ShoppingList/NeedsRecipeSection.jsx
      - client/src/components/ShoppingList/ShoppingListModal.jsx
      - client/src/pages/admin/potions/RecipesTab.js
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # server/db/schema.sql is on scripts/sensitive-paths.txt
---

# Potion Custom-Recipe Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane, checkpoint commits in-lane, squash merge to main. Tasks 1-3 (server) and Tasks 4-6 (client) are independent tracks and may run as parallel subagents; Task 7 runs last.

**Goal:** A custom client drink can be given a recipe (with an editable name) in a drawer over the shopping list, missing par items can be added inline, and the finished recipe folds back into the list as a signature drink with its ingredients, surviving renames.

**Architecture:** New `request_aliases TEXT[]` on both drink tables makes custom matching rename-safe (seeded at Add-recipe with the client's raw string). The recipe editor is extracted from `RecipesTab` into a shared `RecipeEditor` component, mounted both in the Recipes tab and in a new drawer inside the shopping list modal. The generator's silent-drop of unresolved ingredients is surfaced in the modal from the `_unresolvedIngredients` field the server already returns.

**Tech Stack:** Express + raw SQL (`pool.query`, parameterized), React 18 CRA, `node:test` against the shared dev DB.

## Global Constraints

- Raw SQL only, parameterized (`$1, $2`); schema changes idempotent (`ADD COLUMN IF NOT EXISTS`).
- API JSON keys snake_case; JS camelCase.
- Client API calls via `client/src/utils/api.js` only.
- Errors on server: throw `ValidationError` / `NotFoundError` / `ConflictError` (never `res.status(4xx).json`).
- No em dashes in any client-facing copy.
- Server test law: suites run ALONE against the shared dev DB: `node -r dotenv/config --test <file>`; every created row cleaned up in `after()`.
- Client gate: `cd client && CI=true npx react-scripts build` must pass (CI-fatal ESLint).
- Git: explicit pathspec staging only; lane checkpoints commit freely (squash-merged later).
- `request_aliases` is client-typed text: it must NEVER be added to `PUBLIC_COCKTAIL_COLUMNS` (`server/routes/cocktails.js:15`) or `PUBLIC_MOCKTAIL_COLUMNS` (`server/routes/mocktails.js:14`).
- Dev server is a Claude-managed background process with no auto-reload: restart it after server edits before manual verification.

---

### Task 1: Schema + `request_aliases` accepted on drink creation

**Files:**
- Modify: `server/db/schema.sql` (after line 3810, next to the recipe_review ALTERs)
- Modify: `server/routes/potions.js` (new helper + export, next to `validateRecipeRows`)
- Modify: `server/routes/cocktails.js:153-190` (POST)
- Modify: `server/routes/mocktails.js:149-186` (POST)
- Test: `server/routes/potions.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sanitizeRequestAliases(value) -> string[]` exported from `server/routes/potions.js` (throws `ValidationError` on non-array or >20 entries; trims, slices each to 200 chars, drops empties; `undefined` -> `[]`). `POST /api/cocktails` and `POST /api/mocktails` accept optional `request_aliases: string[]`; the column is returned by both admin GETs automatically (`SELECT c.*` / `m.*`). Name validation parity on all four write routes (POST + PUT, both routers): a provided `name` must be trimmed non-empty and <= 255 chars, else `ValidationError` (today: empty rename silently COALESCEs to the old name; 256+ chars is a raw 22001 -> 500).

- [ ] **Step 1: DDL**

Append to `server/db/schema.sql` directly after the `mocktails ADD COLUMN IF NOT EXISTS recipe_review` line (3810):

```sql
-- Client-request aliases: raw free-text strings a client typed that resolve to
-- this drink (seeded by the shopping-list Add-recipe flow). Makes custom-drink
-- matching rename-safe. Client-typed text: NEVER exposed on public GETs.
ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}';
ALTER TABLE mocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}';
```

- [ ] **Step 2: Apply to the dev DB**

Run from repo root:

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  await pool.query(\"ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}'\");
  await pool.query(\"ALTER TABLE mocktails ADD COLUMN IF NOT EXISTS request_aliases TEXT[] DEFAULT '{}'\");
  console.log('ok');
  await pool.end();
})();
"
```

Expected: `ok`. (Prod applies via schema.sql on deploy, per the existing pattern.)

- [ ] **Step 3: Write the failing tests**

In `server/routes/potions.test.js` (harness already mounts `./cocktails`; use the existing `request()` helper and push created ids onto `createdCocktailIds`):

```js
test('POST /cocktails accepts and sanitizes request_aliases', async () => {
  const res = await request('POST', '/api/cocktails', {
    name: 'Alias Sanitize Test Drink',
    is_active: false,
    request_aliases: ['  Jenny\'s spicy marg  ', '', 'x'.repeat(300)],
  });
  assert.equal(res.status, 201);
  createdCocktailIds.push(res.body.id);
  assert.deepEqual(res.body.request_aliases, ["Jenny's spicy marg", 'x'.repeat(200)]);
});

test('POST /cocktails rejects non-array and oversized request_aliases', async () => {
  const bad = await request('POST', '/api/cocktails', {
    name: 'Alias Reject Test Drink', is_active: false, request_aliases: 'not-an-array',
  });
  assert.equal(bad.status, 400);
  const tooMany = await request('POST', '/api/cocktails', {
    name: 'Alias Reject Test Drink 2', is_active: false,
    request_aliases: Array.from({ length: 21 }, (_, i) => `a${i}`),
  });
  assert.equal(tooMany.status, 400);
});

test('name validation parity: POST rejects oversized, PUT rejects empty and oversized', async () => {
  const longName = 'n'.repeat(256);
  const post = await request('POST', '/api/cocktails', { name: longName, is_active: false });
  assert.equal(post.status, 400);

  const created = await request('POST', '/api/cocktails', { name: 'Name Rule Test Drink', is_active: false });
  assert.equal(created.status, 201);
  createdCocktailIds.push(created.body.id);
  const emptyRename = await request('PUT', `/api/cocktails/${created.body.id}`, { name: '   ' });
  assert.equal(emptyRename.status, 400);
  const longRename = await request('PUT', `/api/cocktails/${created.body.id}`, { name: longName });
  assert.equal(longRename.status, 400);
  const okRename = await request('PUT', `/api/cocktails/${created.body.id}`, { name: 'Name Rule Test Drink 2' });
  assert.equal(okRename.status, 200);
  assert.equal(okRename.body.name, 'Name Rule Test Drink 2');
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `node -r dotenv/config --test server/routes/potions.test.js`
Expected: both new tests FAIL (`request_aliases` undefined on the response / status 201 instead of 400).

- [ ] **Step 5: Implement the sanitizer in `server/routes/potions.js`**

Next to `nextRecipeReview` (line 99):

```js
// Client-typed request aliases on drinks (Add-recipe flow). Cap 20 entries,
// 200 chars each (the planner's custom-name cap); undefined means "not sent".
function sanitizeRequestAliases(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ValidationError({ request_aliases: 'Must be an array of at most 20 strings.' });
  }
  return value.map((s) => String(s).trim().slice(0, 200)).filter(Boolean);
}
```

And at the bottom (after line 347):

```js
module.exports.sanitizeRequestAliases = sanitizeRequestAliases;
```

- [ ] **Step 6: Accept the field in both POSTs**

`server/routes/cocktails.js`: add `sanitizeRequestAliases` to the line-7 import from `'./potions'`. In the POST (line 154), destructure `request_aliases` from `req.body`, then:

```js
const requestAliases = sanitizeRequestAliases(request_aliases);
```

INSERT becomes (column + `$12`):

```js
`INSERT INTO cocktails (id, name, category_id, emoji, description, sort_order, base_spirit, ingredients, upgrade_addon_slugs, is_active, recipe_review, request_aliases)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`
```

with `requestAliases` appended to the params array. Mirror in `server/routes/mocktails.js` POST (line 149): destructure `request_aliases`, import the sanitizer from `'./potions'`, add the column as `$10` with `requestAliases` appended.

- [ ] **Step 6b: Name validation on all four write routes**

In BOTH routers' POST, replace `if (!name) throw new ValidationError({ name: 'Name is required.' });` with:

```js
  if (!name || !String(name).trim() || String(name).trim().length > 255) {
    throw new ValidationError({ name: 'Name is required (255 characters max).' });
  }
```

In BOTH routers' PUT, immediately after the destructure:

```js
  if (name !== undefined && name !== null) {
    const trimmedName = String(name).trim();
    if (!trimmedName || trimmedName.length > 255) {
      throw new ValidationError({ name: 'Name is required (255 characters max).' });
    }
  }
```

(No behavior change for requests that omit `name`; the PUT's `name || null` COALESCE path stays.)

- [ ] **Step 7: Run to verify they pass**

Run: `node -r dotenv/config --test server/routes/potions.test.js`
Expected: PASS (all suite tests, not just the new ones).

- [ ] **Step 8: Checkpoint commit (in lane)**

```bash
git add server/db/schema.sql server/routes/potions.js server/routes/cocktails.js server/routes/mocktails.js server/routes/potions.test.js
git commit -m "feat(potions): request_aliases column + accepted on drink creation"
```

---

### Task 2: Alias-aware custom matching

**Files:**
- Modify: `server/utils/shoppingListGen.js:109-140` (`matchCustomNames`, `loadRecipeCandidates`)
- Test: `server/utils/shoppingList.generator.test.js`

**Interfaces:**
- Consumes: `request_aliases` column (Task 1); `normalizeName` from `../utils/potionCatalog` (already imported).
- Produces: `matchCustomNames(customStrings, candidateRows)` unchanged in signature; candidate rows may now carry `request_aliases: string[]`. `loadRecipeCandidates` returns `{ name, ingredients, request_aliases }` rows.

- [ ] **Step 1: Write the failing tests**

In `server/utils/shoppingList.generator.test.js` (module already imports `matchCustomNames`; follow the existing test at line 120):

```js
test('matchCustomNames: request_aliases keep matching after a rename', () => {
  const { matched, needsRecipe } = matchCustomNames(
    ["jenny's spicy MARG!!"],
    [{
      name: 'Spicy Margarita',
      ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }],
      request_aliases: ["Jenny's spicy marg"],
    }]
  );
  assert.deepEqual(needsRecipe, []);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'Spicy Margarita');
});

test('matchCustomNames: a drink NAME beats another drink\'s alias', () => {
  const paloma = { name: 'Paloma', ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }] };
  const squatter = {
    name: 'Grapefruit Thing',
    ingredients: [{ ingredient: 'vodka', amount: 2, unit: 'oz' }],
    request_aliases: ['Paloma'],
  };
  // Alias-carrying row listed FIRST so a single-pass index would wrongly win.
  const { matched } = matchCustomNames(['paloma'], [squatter, paloma]);
  assert.equal(matched[0].name, 'Paloma');
});

test('matchCustomNames: duplicate normalized names are first-wins (candidate order is the contract)', () => {
  const gin = { name: 'Twin Drink', ingredients: [{ ingredient: 'gin', amount: 2, unit: 'oz' }] };
  const rum = { name: 'TWIN DRINK', ingredients: [{ ingredient: 'rum', amount: 2, unit: 'oz' }] };
  const { matched } = matchCustomNames(['twin drink'], [gin, rum]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].ingredients[0].ingredient, 'gin');
});

test('matchCustomNames: rows without request_aliases behave exactly as before', () => {
  const { matched, needsRecipe } = matchCustomNames(
    ['Mystery Drink'],
    [{ name: 'Old Fashioned', ingredients: [{ ingredient: 'bourbon', amount: 2, unit: 'oz' }] }]
  );
  assert.deepEqual(matched, []);
  assert.deepEqual(needsRecipe, [{ name: 'Mystery Drink' }]);
});
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `node -r dotenv/config --test server/utils/shoppingList.generator.test.js`
Expected: alias test FAILS (lands in `needsRecipe`); precedence test FAILS or passes vacuously; the no-alias test PASSES (regression guard).

- [ ] **Step 3: Implement the two-pass index**

Replace the index-building loop in `matchCustomNames` (`server/utils/shoppingListGen.js:110-114`):

```js
function matchCustomNames(customStrings, candidateRows) {
  const byNorm = new Map();
  // Two passes, names first: a real drink name always beats another drink's
  // client-typed alias; first-wins is preserved within each pass.
  for (const row of candidateRows || []) {
    const norm = normalizeName(row.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, row);
  }
  for (const row of candidateRows || []) {
    for (const alias of row.request_aliases || []) {
      const norm = normalizeName(alias);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, row);
    }
  }
  // (matching loop below unchanged)
```

And rewrite `loadRecipeCandidates` (line 132) to select the column AND pin a
deterministic candidate order (spec §1: collisions resolve stably, active beats draft,
oldest wins among peers; matchCustomNames is first-wins so this ORDER BY is the
tiebreak contract):

```js
`SELECT name, ingredients, request_aliases FROM (
   SELECT name, ingredients, request_aliases, is_active, created_at FROM cocktails
    WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'
   UNION ALL
   SELECT name, ingredients, request_aliases, is_active, created_at FROM mocktails
    WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'
 ) candidates
 ORDER BY is_active DESC, created_at ASC, name ASC`
```

- [ ] **Step 4: Run to verify green, plus the parity invariant**

Run: `node -r dotenv/config --test server/utils/shoppingList.generator.test.js`
Expected: PASS.
Run: `node -r dotenv/config --test server/utils/potionCatalog.test.js`
Expected: PASS (all existing rows have empty `request_aliases`, so generator output is byte-identical; the parity snapshots prove it).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/shoppingListGen.js server/utils/shoppingList.generator.test.js
git commit -m "feat(potions): alias-aware custom-drink matching (names beat aliases)"
```

---

### Task 3: Rename-safety end to end + PUT strips `_unresolvedIngredients`

**Files:**
- Modify: `server/routes/drinkPlans.js:506-525` (PUT shopping-list)
- Test: `server/routes/potions.test.js` (regenerate e2e)
- Test: Create `server/routes/drinkPlans.shoppingListStrip.test.js`

**Interfaces:**
- Consumes: Tasks 1-2. The potions.test.js harness (mounts `./potions`, `./drinkPlans/regenerate`, `./cocktails`; has `planId`, `adminToken`, `request()`, cleanup arrays).
- Produces: `PUT /api/drink-plans/:id/shopping-list` silently drops `_unresolvedIngredients` from the stored blob. No response-shape change.

- [ ] **Step 1: Write the failing e2e test in `server/routes/potions.test.js`**

Uses the suite's existing plan row (`planId`); set its `selections.customCocktails`, then create + author + rename a draft and regenerate:

```js
test('regenerate: custom request matches via request_aliases after a rename', async () => {
  const created = await request('POST', '/api/cocktails', {
    name: "Dallas's test fizz", is_active: false,
    request_aliases: ["Dallas's test fizz"],
  });
  assert.equal(created.status, 201);
  createdCocktailIds.push(created.body.id);

  const authored = await request('PUT', `/api/cocktails/${created.body.id}`, {
    ingredients: [{ ingredient: 'vodka', amount: 2, unit: 'oz' }],
  });
  assert.equal(authored.status, 200);

  const renamed = await request('PUT', `/api/cocktails/${created.body.id}`, { name: 'Test Fizz Supreme' });
  assert.equal(renamed.status, 200);

  await pool.query(
    `UPDATE drink_plans SET selections = jsonb_set(COALESCE(selections, '{}'::jsonb), '{customCocktails}', $1::jsonb)
      WHERE id = $2`,
    [JSON.stringify(["dallas's test FIZZ"]), planId]
  );

  const regen = await request('POST', `/api/drink-plans/${planId}/shopping-list/regenerate`, {
    guest_count_override: 50,
  });
  assert.equal(regen.status, 200);
  assert.ok(regen.body.list.signatureCocktailNames.includes('Test Fizz Supreme'));
  assert.deepEqual(regen.body.list.needsRecipe, []);
});
```

(If the suite's shared plan already carries `customCocktails` used by the NULL-source test at line 180, restore the prior `selections` value in `after()` or in the test's own tail; read that test first and reuse its restore pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/potions.test.js`
Expected: new test FAILS at the `signatureCocktailNames` assert (name renamed away, alias not yet... this passes only once Tasks 1+2 are merged in the lane; if the lane built Tasks 1-2 first, expected PASS. Keep the test either way; it is the rename-safety regression guard.)

- [ ] **Step 3: Strip in the PUT + public GET hygiene**

`server/routes/drinkPlans.js`, inside the PUT after the type check (line 510). Spec §4:
ALL underscore-prefixed keys are generation-run diagnostics (`_unresolvedIngredients`,
`_signatureCocktails`, `_syrupSelfProvided`), none has a runtime reader of the saved
copy:

```js
  if (!shopping_list || typeof shopping_list !== 'object') {
    throw new ValidationError({ shopping_list: 'Invalid shopping list data.' });
  }
  // Underscore keys are generation-run diagnostics (built fresh by every
  // generate/regenerate); never persisted, so stale copies can't outlive
  // the generation they described.
  for (const key of Object.keys(shopping_list)) {
    if (key.startsWith('_')) delete shopping_list[key];
  }
```

And in `GET /t/:token/shopping-list` (line 54, the `ready: true` branch): the
server-side auto-gen persists these keys at submit time and this route serves the blob
wholesale, so strip them from the RESPONSE only (the stored blob keeps them so the
admin modal's first open still shows the unresolved warning):

```js
  const publicList = { ...plan.shopping_list };
  for (const key of Object.keys(publicList)) {
    if (key.startsWith('_')) delete publicList[key];
  }
  res.json({
    ready: true,
    shopping_list: publicList,
    // (remaining fields unchanged)
```

- [ ] **Step 4: Write the strip test**

Create `server/routes/drinkPlans.shoppingListStrip.test.js` on the harness pattern of `server/routes/drinkPlans.beo.test.js` (fresh express app, mount `require('./drinkPlans')` at `/api/drink-plans`, real admin JWT, dev DB, cleanup in `after()`):

```js
test('PUT shopping-list strips every underscore-prefixed key before persisting', async () => {
  const res = await request('PUT', `/api/drink-plans/${planId}/shopping-list`, {
    shopping_list: {
      guestCount: 50, liquorBeerWine: [], everythingElse: [],
      _unresolvedIngredients: [{ drink: 'X', ingredient: 'y' }],
      _signatureCocktails: [{ name: 'X' }],
      _syrupSelfProvided: ['lavender'],
    },
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT shopping_list FROM drink_plans WHERE id = $1', [planId]);
  const savedKeys = Object.keys(rows[0].shopping_list).filter((k) => k.startsWith('_'));
  assert.deepEqual(savedKeys, []);
  assert.equal(rows[0].shopping_list.guestCount, 50);
});

test('public token GET never serves underscore-prefixed keys', async () => {
  await pool.query(
    `UPDATE drink_plans
       SET shopping_list = $1::jsonb, shopping_list_status = 'approved'
     WHERE id = $2`,
    [JSON.stringify({
      guestCount: 50, liquorBeerWine: [], everythingElse: [],
      _unresolvedIngredients: [{ drink: 'X', ingredient: 'y' }],
    }), planId]
  );
  const { rows } = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [planId]);
  const res = await request('GET', `/api/drink-plans/t/${rows[0].token}/shopping-list`, undefined, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  const servedKeys = Object.keys(res.body.shopping_list).filter((k) => k.startsWith('_'));
  assert.deepEqual(servedKeys, []);
});
```

(The public GET runs through `publicReadLimiter` and `requireUuidToken`; the harness
mounts the flat router so both apply. Reset `shopping_list_status` in `after()` along
with the other cleanup.)

- [ ] **Step 5: Run both suites (one at a time)**

Run: `node -r dotenv/config --test server/routes/potions.test.js`
Expected: PASS.
Run: `node -r dotenv/config --test server/routes/drinkPlans.shoppingListStrip.test.js`
Expected: PASS.

- [ ] **Step 6: Checkpoint commit**

```bash
git add server/routes/drinkPlans.js server/routes/potions.test.js server/routes/drinkPlans.shoppingListStrip.test.js
git commit -m "feat(potions): rename-safe regenerate e2e + PUT strips _unresolvedIngredients"
```

---

### Task 4: Extract `RecipeEditor` (shared, with name editing + inline add-par)

**Files:**
- Create: `client/src/components/potions/RecipeEditor.js`
- Modify: `client/src/pages/admin/potions/RecipesTab.js`

**Interfaces:**
- Consumes: `api`, `useToast`, `StatusChip`; existing endpoints `PUT /cocktails/:id`, `PUT /mocktails/:id`, `POST /potions/pars`.
- Produces (the contract Tasks 5-6 build against):

```jsx
<RecipeEditor
  drink={drinkRow}            // full row from /cocktails/admin | /mocktails/admin | POST response
  type={'cocktails'|'mocktails'}
  pars={parRowsArray}
  onDrinkChange={(updatedRow) => {}}   // fired with the PUT response row after EVERY successful persist
  onParsChange={(createdParRow) => {}} // fired after a successful inline par POST
  onRowsChange={(nonEmptyRowCount) => {}} // optional; fired on every rows edit (live, pre-save)
  goToPars={fn}               // optional; renders the "open Pars tab" link when provided
  autoFocusName={bool}        // optional; focuses the name input on mount (drawer flow)
/>
```

Also exported: `normalizeName` (named export; NeedsRecipeSection's reuse-before-create
lookup uses the same normalization the matcher uses).

- [ ] **Step 1: Create `client/src/components/potions/RecipeEditor.js`**

Move VERBATIM from `RecipesTab.js`: `UNITS`, `REVIEW`, `normalizeName` (re-export it: `export { normalizeName }`), `buildAliasIndex`, `resolveDisplay`, `rowProblems`, and the whole detail-pane block (rows state, `persist`, `flushPending`, rehydrate-on-selection effect, unmount flush effect, `scheduleSave`, `updateRow`/`addRow`/`deleteRow`, `markReviewed`, the `<div className="card potions-detail">` JSX). Adapt:

1. Selection is gone: the component receives ONE `drink`; the rehydrate effect keys on `` `${type}:${drink.id}` ``.
2. `persist` calls `onDrinkChange(res.data)` after `setData`-style merging is removed (the parent owns caches now).
3. Every `setRows` path also calls `onRowsChange?.(next.filter((r) => String(r.ingredient || '').trim()).length)`.
4. **Name editing** (spec: off-menu drafts only). Add state + header input:

```jsx
const [nameDraft, setNameDraft] = useState(drink.name);
useEffect(() => { setNameDraft(drink.name); }, [drink.id]);
const nameEditable = drink.is_active === false;
const nameProblem = nameEditable && !String(nameDraft || '').trim()
  ? 'Name this drink to save.' : null;
```

In the header, replace the static `<div className="potions-detail-name">{drink.name}</div>` with:

```jsx
{nameEditable ? (
  <input
    className={`input potions-cell potions-name-input ${nameProblem ? 'potions-cell-bad' : ''}`}
    value={nameDraft}
    autoFocus={autoFocusName}
    maxLength={255}
    onChange={(e) => { setNameDraft(e.target.value); scheduleSave(rowsRef.current); }}
    placeholder="Drink name"
    aria-label="Drink name"
  />
) : (
  <div className="potions-detail-name">{drink.name}</div>
)}
{nameProblem && <div className="potions-cell-error">{nameProblem}</div>}
```

`scheduleSave` gains the name: block when `nameProblem`, and `pendingRef.current = { drink, type, rows: nextRows, name: nameDraftRef.current }` (mirror `rowsRef` with a `nameDraftRef`). `persist(drink, type, nextRows, extra)` sends:

```js
const trimmedName = String(nameRef || '').trim();
const body = { ingredients: clean, ...extra };
if (drink.is_active === false && trimmedName && trimmedName !== drink.name) body.name = trimmedName;
const res = await api.put(`/${type}/${drink.id}`, body);
```

5. **Inline add-par.** Replace the No-match chip cell content. New local state `addingParForRow` (row index or null) and `parForm` (`{ item, size, role }`):

```jsx
const deriveSection = (role) =>
  ['spirit', 'wine', 'beer'].includes(role) ? 'liquorBeerWine' : 'everythingElse';

const submitInlinePar = async (rowIngredient) => {
  setParSaving(true); setParError('');
  try {
    const res = await api.post('/potions/pars', {
      item: parForm.item, size: parForm.size || null, role: parForm.role,
      section: deriveSection(parForm.role), qty_per_100: 1, in_full_bar: false,
      ingredient_aliases: [rowIngredient],
    });
    onParsChange?.(res.data.par);
    setAddingParForRow(null);
  } catch (err) {
    setParError(err?.message || 'Could not add the item. Try again.');
  } finally {
    setParSaving(false);
  }
};
```

The chip becomes `onClick={() => { setAddingParForRow(i); setParForm({ item: row.ingredient, size: '', role: 'mixer' }); setParError(''); }}`. When `addingParForRow === i`, render under the cell a compact form: item `input`, size `input` (placeholder `"750mL, 12 pack, ea."`), role `select` over `['spirit','wine','beer','mixer','garnish','supplies']`, Save (`btn btn-sm`, disabled while `parSaving` or `!parForm.item.trim()`), Cancel (`btn btn-ghost btn-sm`), and `{parError && <div className="potions-cell-error">{parError}</div>}`. Keep the existing "open Pars tab" affordance only when `goToPars` is provided:

```jsx
{goToPars && <button type="button" className="btn btn-ghost btn-sm" onClick={goToPars}>Pars tab</button>}
```

- [ ] **Step 2: Shrink `RecipesTab.js` to the master-list shell**

Keep: data/pars loading, seg control, search, `focusDrinkId` deep-link consume, `reviewedCount`, master list. Delete everything moved. Detail pane becomes:

```jsx
{selected ? (
  <RecipeEditor
    drink={selected}
    type={drinkType}
    pars={pars}
    onDrinkChange={(updated) => setData((prev) => ({
      ...prev,
      [drinkType]: prev[drinkType].map((d) => (d.id === updated.id ? { ...d, ...updated } : d)),
    }))}
    onParsChange={(par) => setPars((prev) => [...prev, par])}
    goToPars={goToPars}
  />
) : (
  <div className="card potions-detail"><div className="potions-state text-muted">Pick a drink to edit its recipe.</div></div>
)}
```

Import: `import RecipeEditor from '../../../components/potions/RecipeEditor';`

- [ ] **Step 3: Build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: compiles with no ESLint errors.

- [ ] **Step 4: Manual smoke (Recipes tab unchanged behavior)**

Restart the dev server (Claude-managed, no auto-reload). On `/potions?tab=recipes`: pick a drink, edit an amount, watch `Saving… -> Saved`; switch drinks fast (flush check); active drink shows a STATIC name; a `?drink=<id>` deep link still focuses. On a row with no catalog match, the chip now opens the inline form; Cancel closes it.

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/components/potions/RecipeEditor.js client/src/pages/admin/potions/RecipesTab.js
git commit -m "refactor(potions): extract shared RecipeEditor with name editing + inline add-par"
```

---

### Task 5: `NeedsRecipeSection` + drawer over the shopping list modal

**Files:**
- Create: `client/src/components/ShoppingList/NeedsRecipeSection.jsx`
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx`

**Interfaces:**
- Consumes: `RecipeEditor` contract (Task 4), `Drawer` (`client/src/components/adminos/Drawer.js`, props `{ open, onClose, crumb, children }`), `POST /cocktails`, `GET /potions/pars`, and the modal's existing `regenerate(count)` + `guestCount`.
- Produces:

```jsx
<NeedsRecipeSection
  needsRecipe={arrayOrUndefined}          // edited.needsRecipe
  unresolved={arrayOrUndefined}           // edited._unresolvedIngredients (rendered in Task 6)
  onRegenerate={() => regenerate(guestCount)}  // already confirm-free; section owns the confirm
/>
```

- [ ] **Step 1: Create the section component**

`client/src/components/ShoppingList/NeedsRecipeSection.jsx`. It owns everything the modal's needsRecipe block owned, plus the drawer:

```jsx
import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import Drawer from '../adminos/Drawer';
import RecipeEditor, { normalizeName } from '../potions/RecipeEditor';

// Client-requested drinks with no recipe yet, plus the drawer that authors the
// recipe in place (no navigation away from the shopping list). Fold-in happens
// via the modal's regenerate, confirm-gated because it replaces manual edits.
export default function NeedsRecipeSection({ needsRecipe, unresolved, onRegenerate }) {
  const [addingRecipe, setAddingRecipe] = useState(null); // name being created, or null
  const [addRecipeError, setAddRecipeError] = useState('');
  const [drawerTarget, setDrawerTarget] = useState(null); // { drink, type } or null
  const [pars, setPars] = useState(null);                 // lazy: fetched on first drawer open
  const [parsError, setParsError] = useState(false);
  const [rowCount, setRowCount] = useState(0);
  const drinkListsRef = useRef(null);                     // { cocktails, mocktails } lazy cache

  const loadPars = async () => {
    try {
      const res = await api.get('/potions/pars');
      setPars(res.data.pars || []);
      setParsError(false);
    } catch (err) {
      setPars([]);
      setParsError(true);
    }
  };

  // Reuse before create (spec §2): the same client string must land on the
  // SAME draft across re-clicks and across plans, never mint a "<slug>-2"
  // duplicate or dead-end on ConflictError. Normalized match against names
  // AND request_aliases of both admin lists.
  const findExistingDrink = async (name) => {
    if (!drinkListsRef.current) {
      const [c, m] = await Promise.all([
        api.get('/cocktails/admin'),
        api.get('/mocktails/admin'),
      ]);
      drinkListsRef.current = {
        cocktails: c.data.cocktails || [],
        mocktails: m.data.mocktails || [],
      };
    }
    const norm = normalizeName(name);
    for (const type of ['cocktails', 'mocktails']) {
      for (const drink of drinkListsRef.current[type]) {
        const names = [drink.name, ...(drink.request_aliases || [])];
        if (names.some((n) => normalizeName(n) === norm)) return { drink, type };
      }
    }
    return null;
  };

  const handleAddRecipe = async (name) => {
    setAddingRecipe(name);
    setAddRecipeError('');
    try {
      if (pars === null) loadPars();
      const existing = await findExistingDrink(name);
      if (existing) {
        setRowCount((existing.drink.ingredients || []).length);
        setDrawerTarget(existing);
        return;
      }
      const res = await api.post('/cocktails', {
        name, is_active: false, request_aliases: [name],
      });
      drinkListsRef.current.cocktails.push(res.data); // future re-clicks reuse it
      setRowCount(0);
      setDrawerTarget({ drink: res.data, type: 'cocktails' });
    } catch (err) {
      setAddRecipeError(err?.message || `Could not add "${name}". Try again.`);
    } finally {
      setAddingRecipe(null);
    }
  };

  const closeDrawer = () => {
    const target = drawerTarget;
    setDrawerTarget(null);
    if (target && rowCount > 0 && window.confirm(
      `Fold "${target.drink.name}" into the list? Regenerating replaces your manual edits, and saving will set the list back to Needs review.`
    )) {
      onRegenerate();
    }
  };
  // needsRecipe block JSX (moved verbatim from the modal, button wired to
  // handleAddRecipe) + unresolved block (Task 6) + drawer:
  // <Drawer open={!!drawerTarget} onClose={closeDrawer}
  //   crumb={<span className="drawer-crumb">Potions · New recipe</span>}>
  //   {drawerTarget && (
  //     pars === null ? <div className="potions-state text-muted">Loading catalog…</div> : (
  //       <>
  //         {parsError && (
  //           <div className="potions-state text-muted">
  //             Par catalog failed to load; every row will read No match.{' '}
  //             <button type="button" className="btn btn-secondary btn-sm" onClick={loadPars}>Retry</button>
  //           </div>
  //         )}
  //         <RecipeEditor
  //           drink={drawerTarget.drink} type={drawerTarget.type} pars={pars} autoFocusName
  //           onDrinkChange={(u) => setDrawerTarget((prev) => (prev ? { ...prev, drink: { ...prev.drink, ...u } } : prev))}
  //           onParsChange={(p) => setPars((prev) => [...(prev || []), p])}
  //           onRowsChange={setRowCount}
  //         />
  //       </>
  //     )
  //   )}
  // </Drawer>
}
```

(The commented JSX is the real structure to write, shown compact here; the needsRecipe list itself is the exact block from `ShoppingListModal.jsx:442-481` with `handleAddRecipe(entry.name)` and the same `addingRecipe`/`addRecipeError` rendering.)

- [ ] **Step 2: Rewire the modal**

In `ShoppingListModal.jsx`: delete `handleAddRecipe` (lines 270-278), the `addingRecipe`/`addRecipeError` state (lines 38-39), the `useNavigate` import + `navigate` (the Add-recipe flow was its only use; verify with grep before removing), and the needsRecipe JSX block (lines 442-481). In its place:

```jsx
<NeedsRecipeSection
  needsRecipe={edited.needsRecipe}
  unresolved={edited._unresolvedIngredients}
  onRegenerate={() => regenerate(guestCount)}
/>
```

Render it unconditionally (the section returns null when both arrays are empty); import at top.

- [ ] **Step 3: Build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: compiles clean (unused-var ESLint errors from the removed state are CI-fatal; the grep in Step 2 prevents them).

- [ ] **Step 4: Manual verify (event-side path, the canonical surface)**

Restart the dev server. Event -> drink plan -> Shopping List. On a plan whose custom drink has no recipe: "Add recipe" opens the DRAWER over the modal (drawer paints above: it renders inside the modal's portal subtree, so its z-index 51 only competes inside that stacking context where nothing exceeds 10 - verify visually). Name input is focused and editable; author two rows; one row with an unknown ingredient shows No match -> add it inline -> chip resolves. Close the drawer -> confirm prompt -> list regenerates: drink on the Signature Cocktails line, its resolvable ingredients merged, needsRecipe entry gone. Decline path: close without confirm leaves the list untouched.

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/components/ShoppingList/NeedsRecipeSection.jsx client/src/components/ShoppingList/ShoppingListModal.jsx
git commit -m "feat(potions): recipe drawer over the shopping list (no navigation)"
```

---

### Task 6: Unresolved-ingredients warning + strip on save + autosave flush fix

**Files:**
- Modify: `client/src/components/ShoppingList/NeedsRecipeSection.jsx` (warning block)
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx` (strip + flush)

**Interfaces:**
- Consumes: `unresolved` prop (`[{ drink, ingredient }]`), the modal's autosave effect (lines 66-103) and `handleApprove` PUT (lines ~250).
- Produces: no new exports; the PUT payload never carries `_unresolvedIngredients`; pending edits survive modal close.

- [ ] **Step 1: Warning block in `NeedsRecipeSection`**

Above the needsRecipe list (same container style as the needsRecipe block, amber accent via the existing `--accent-line` border pattern):

```jsx
{Array.isArray(unresolved) && unresolved.length > 0 && (
  <div style={{
    margin: '0.75rem 1.25rem 0', backgroundColor: 'var(--bg-2)',
    border: '1px solid var(--accent-line)', borderRadius: 'var(--radius)',
    padding: '0.75rem 0.875rem',
  }}>
    <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
      Missing from the par catalog (NOT on this list)
    </p>
    {unresolved.map((u, i) => (
      <div key={`${u.drink}-${u.ingredient}-${i}`} style={{ color: 'var(--ink-2)', fontSize: '0.85rem', padding: '0.15rem 0' }}>
        {u.drink}: {u.ingredient}
      </div>
    ))}
    <p style={{ color: 'var(--ink-3)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>
      Add the item from the recipe editor, or alias an existing one on the Pars tab, then regenerate.
    </p>
  </div>
)}
```

- [ ] **Step 2: Strip underscore keys from both PUT payloads in the modal**

Add one helper near `deepClone`:

```js
// Generation-run diagnostics (_unresolvedIngredients, _signatureCocktails,
// _syrupSelfProvided) never ride a save; the server strips them too.
const stripGenerationKeys = (list) =>
  Object.fromEntries(Object.entries(list).filter(([k]) => !k.startsWith('_')));
```

Autosave effect (line ~80) and `handleApprove` (line ~250) both become:

```js
await api.put(`/drink-plans/${planId}/shopping-list`, {
  shopping_list: {
    ...stripGenerationKeys(edited),
    guestCount: parseInt(guestCount, 10) || edited.guestCount,
  },
});
```

- [ ] **Step 3: Flush-on-unmount fix**

In the modal: mirror the pending payload into a ref at schedule time, and add an unmount-only effect. The debounce cleanup (line 100) stays as-is; unmount flushing is a SEPARATE effect so dep-change cleanups don't fire spurious PUTs:

```js
const pendingSaveRef = useRef(null); // set when a debounce is armed, cleared on save
```

In the autosave effect, before arming the timer: `pendingSaveRef.current = { edited, guestCount };` and inside the fired timer + after a successful save: `pendingSaveRef.current = null;` (also null it in `handleApprove` after its explicit PUT). Then:

The modal gains `const toast = useToast();` (import `useToast` from
`../../context/ToastContext`; the provider is app-level and outlives the modal). Spec
§5: flushing an edit to an APPROVED list reverts it to pending_review after the
re-approve button is gone, so the flush must say so out loud:

```js
// Unmount: flush a pending debounced save instead of dropping it (fire and
// forget; the modal is gone, but the edit must not be). Flushing an APPROVED
// list reverts it to review server-side; the toast makes that visible since
// the re-approve button unmounted with the modal.
useEffect(() => () => {
  const pending = pendingSaveRef.current;
  if (!pending || !planId) return;
  const wasApprovedAtFlush = approveStatusRef.current === 'approved';
  api.put(`/drink-plans/${planId}/shopping-list`, {
    shopping_list: {
      ...stripGenerationKeys(pending.edited),
      guestCount: parseInt(pending.guestCount, 10) || pending.edited.guestCount,
    },
  }).then(() => {
    if (wasApprovedAtFlush) {
      toast.info('List saved and returned to review. Re-approve to publish the update to the client.');
    }
  }).catch((err) => console.error('Flush-on-close save failed:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

(`toast.info` verified on the ToastContext API, `client/src/context/ToastContext.js:56`.)

- [ ] **Step 4: Build gate + manual verify**

Run: `cd client && CI=true npx react-scripts build`
Expected: compiles clean.
Manual: edit a qty and close the modal within 1.5s; reopen: the edit persisted. Generate a list for a plan whose saved recipe references a par item that was soft-deleted (or temporarily rename an alias on the Pars tab): the amber block lists the drink/ingredient pair; save the list; SELECT the row (`node -r dotenv/config -e` one-liner) and confirm no `_unresolvedIngredients` key.

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/components/ShoppingList/NeedsRecipeSection.jsx client/src/components/ShoppingList/ShoppingListModal.jsx
git commit -m "feat(potions): surface unresolved ingredients + never persist them; flush pending edits on close"
```

---

### Task 7: Docs + full gates

**Files:**
- Modify: `README.md` (folder tree: `components/potions/RecipeEditor.js`, `components/ShoppingList/NeedsRecipeSection.jsx`)
- Modify: `ARCHITECTURE.md` (Database Schema section: `request_aliases` on cocktails + mocktails; one line on the Add-recipe drawer flow in the Potions section)

**Interfaces:** none.

- [ ] **Step 1: README folder tree**

Add the two new component files to the existing tree, matching its indentation and comment style.

- [ ] **Step 2: ARCHITECTURE schema + flow note**

In the cocktails/mocktails schema block: `request_aliases TEXT[] DEFAULT '{}'` with the one-line purpose (client-typed request strings; rename-safe custom matching; never on public GETs). In the Potions/shopping-list section: Add-recipe now authors in a drawer over the modal and folds in via regenerate.

- [ ] **Step 3: Full gate run (each server suite ALONE)**

```bash
node -r dotenv/config --test server/utils/shoppingList.generator.test.js
node -r dotenv/config --test server/utils/potionCatalog.test.js
node -r dotenv/config --test server/routes/potions.test.js
node -r dotenv/config --test server/routes/drinkPlans.shoppingListStrip.test.js
cd client && CI=true npx react-scripts build
```

Expected: all PASS / clean build.

- [ ] **Step 4: Checkpoint commit, then lane wrap**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: potion custom-recipe flow (request_aliases, drawer, unresolved surfacing)"
```

Lane wrap per house flow: full-fleet per-lane review (schema.sql is sensitive), squash merge via `scripts/merge-lane.sh`, worktree cleanup. Merge is not deploy; push waits for Dallas's explicit cue.

---

## Self-review notes

- Spec coverage: §1 aliases -> Tasks 1-3; §2 drawer/extraction/name -> Tasks 4-5; §3 inline add-par -> Task 4 (built into the shared editor, so both surfaces get it); §4 unresolved -> Tasks 3+6; §5 flush -> Task 6; docs/rollout -> Tasks 1+7.
- Type consistency: `onDrinkChange(row)` / `onParsChange(par)` / `onRowsChange(count)` used identically in Tasks 4, 5; `sanitizeRequestAliases` defined Task 1, consumed Task 1 only; `deriveSection` local to RecipeEditor.
- Known judgment call: the e2e rename test (Task 3) double-covers Task 2's unit tests deliberately; it is the regression guard for the whole reason aliases exist.
