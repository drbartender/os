# Client's Answers Beside the Shopping List (lanes consult-recap, sl-client-answers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin shopping-list modal shows the client's answers that drive the list (newest set, consult or planner, with a view-only switch), and every consult rendering (the client recap email, the staff Consult card, the new panel) reads one server recap that prints drink names instead of catalog ids or raw JSON.

**Architecture:** Two lanes, merged in order. Lane `consult-recap` (Tasks 1 to 4) teaches `server/utils/consultRecap.js` to resolve drink ids to names and adds a Mixers line, then points its three readers at it: the recap email action, the staff event-details payload (which stops shipping the raw consult JSON) with its card, and the consult GET (a new `recap` field). Lane `sl-client-answers` (Tasks 5 to 8), cut from main after the first squash lands, adds a list-only mode to the existing answers card, a pure set-picker, the panel component, and the modal wiring with its CSS. No schema change, no new endpoint, no money path.

**Tech Stack:** Node 26 + Express 4 + `pg` (raw SQL), `node:test` server suites against the shared dev DB; React 18 (CRA) with jest + RTL 13 (jest-dom imported per file, CRA `resetMocks: true`), the `api` axios client; vanilla CSS in `client/src/index.css` under the admin-os scope; Playwright for the browser check.

**Spec:** `docs/superpowers/specs/2026-10-06-shopping-list-client-answers-design.md` (decisions in section 2 are Dallas's, 2026-10-06).

**Decision trail:** Dallas's 2026-09-22 drop, item 8 (`docs/fix-list-remaining-2026-07-02.md`, Potions, "Planner answers beside the shopping list"), plus the two ledger entries filed 2026-10-06: section 2 "The post-consult recap email lists drinks by their catalog slug" and section 4 "The staff brief's consult card prints a custom drink as `[object Object]`". Brainstormed in chat 2026-10-06; Dallas asked for this plan to go through the plan fleet before any build.

**Prod facts (read-only, production branch, 2026-10-06):** 23 plans carry consult answers, all with `shopping_list_source = 'consult'`; 14 hold a custom drink; 2 upcoming live bookings carry a consult custom drink; 11 plans hold both sets and on all 11 the planner was never submitted; 9 consult recap emails sent (2026-07-19 to 2026-10-05), 6 with picked cocktails, none edited before sending; consult drink ids are catalog slugs (`french-75`).

## Global Constraints

- No em dashes in any new client-facing or admin-facing copy (email lines, panel copy, button labels).
- No schema change, no new endpoint, nothing on a money path; the plan page's source switch (`PATCH /api/drink-plans/:id/shopping-list-source`) and list generation are untouched.
- One pooled connection per request (CLAUDE.md): `loadConsultDrinkNames(consult, db)` always queries through the handle its caller passes.
- File-size ratchet: `ShoppingListModal.jsx` is 930 lines against the 1000 hard cap; Task 8 adds at most 40. `ShiftDetail.js` (870) must not grow.
- Admin CSS is scoped under `html[data-app="admin-os"]` and painted only with admin skin tokens; `npm run check:css-scope` stays green.
- Client commits pass `cd client && CI=true npx react-scripts build` first (a lint warning is fatal on Vercel).
- Server suites run one at a time from the lane root against the dev DB; read the pass count every run. Every row a test seeds is removed by that test file.
- Staging is explicit (`git add <path>`), never `-A`; lanes merge only through `scripts/merge-lane.sh`.
- Dates in admin copy are the Chicago day: `fmtDate(ctDay(ts))` from `client/src/components/adminos/format.js`.

## Review Focus

The five inputs most likely to bite that the spec implies and no happy-path test reaches, each pinned by a test in the task named:

1. **A consult saved as `{}`** (the hosted path can write one, `server/routes/drinkPlans/hostedNoList.test.js:108`): the staff card and the panel must hide, never print the email's "(no specific selections captured; notes are on file)" placeholder. Pinned in Task 1 (`buildConsultRecap` returns null) and Task 7 (a `{}` consult is no set).
2. **Mocktail ids resolved against the cocktails table** (the generator shipped exactly that bug once, `shoppingListGen.js:85-87`): every mocktail would humanize instead of naming. Pinned in Task 1 by one id seeded in BOTH tables under different names.
3. **A failed catalog read** in the panel: `DrinkPlanSelections` filters picks against the catalog, so an empty catalog silently drops the client's drinks. Pinned in Task 7 (error with Retry, no planner view).
4. **A tie or an unstamped consult** against a submitted planner: must open on the consult. Pinned in Task 6.
5. **The switch writing anything, or being remembered**: it is view-only and resets on reopen. Pinned in Task 7 (no `put`/`post`/`patch`; a remount opens on the newest set).

## Proven context (verified against main on 2026-10-06, not from memory)

- `server/utils/consultRecap.js` (97 lines): `BAR_TYPE_LABELS` `:3-8`, `titleCase` `:10`, `ingredientSuffix` `:21`, `formatConsultRecap(consult = {})` `:34-86` (signature drinks joined raw at `:48-49`, mocktails at `:59-61`, the placeholder at `:85`), `pickNextStepLine` `:92`, exports `:97`. Its suite `server/utils/consultRecap.test.js` is pure (no DB) and its first fixture holds display names (`'Old Fashioned'`), a shape the form never writes.
- `client/src/components/ShoppingList/ConsultationForm.jsx`: stores catalog ids (`c.id`, `:412-417`), custom drinks as `{ name, ingredients: string[] }` (`:365`), wine as `'red' | 'white' | 'sparkling'`, `mixers` as `'full' | 'matching' | 'none'` (options `:32-34`), forcing `'none'` when the bar is beer-and-wine or mocktails-only (`:102`, `:137`).
- `cocktails.id` and `mocktails.id` are `VARCHAR(100)` primary keys; `name` is `NOT NULL`; every other column has a default (`server/db/schema.sql:424-434`, `:533-543`, later `ADD COLUMN`s all defaulted). `drink_plans` has no NOT NULL column without a default.
- `server/utils/comms/actions/consultRecap.js` (233 lines, SENSITIVE: `server/utils/comms/actions/*.js`): imports `:22-29` (`formatConsultRecap, pickNextStepLine` at `:27`); `load(planId)` `:38-56` (pool query, `if (!rows[0]) throw` then `return rows[0]`); `defaultParts(row)` `:116`, formatter call `:134`; `buildMessages` `:141-143`; `dispatch` `:175`, `defaults = defaultParts(row)` `:178` (compared against the sent body to set `bodyEdited`). `consultRecapParts` (`server/utils/lifecycleEmailTemplates.js:381`) prints the lines verbatim, one per line.
- `server/utils/comms/actions/remainingActions.test.js` (SENSITIVE by the same glob): `require('dotenv').config()` at `:13`; `before` `:23` (idempotent teardown `:24-37`); the drink plan fixture `:55-63` with consult JSON inline; `after` `:87-94`; consult tests `:202-258` (buildMessages `:212`).
- `server/routes/drinkPlanConsult.js` (404 lines): imports `:11-25`; `GET /:id/consult` `:159-170` (`auth, requireAdminOrManager`, returns `consult_selections`, `consult_filled_at`, `consult_filled_by_user_id`). Mounted at `/api/drink-plans` (`server/index.js:382`). `consult_filled_at = NOW()` on every save (`:250`, `:261`). Its suite `drinkPlanConsult.test.js` covers `performConsultsCompletionFlip` only and has no HTTP harness.
- `server/utils/eventDetailsPayload.js` (338 lines): imports `:26-29`; `buildEventDetailsPayload(req, proposalId)` `:59`; `dpRowP` `:87-93` (`SELECT id, status, finalized_at, finalized_by, selections, consult_selections, admin_notes, shopping_list_status, (selections ? '_logoFilename') AS has_logo FROM drink_plans WHERE proposal_id = $1`); the barrier `Promise.all` `:208-210`; `dp = dpRow.rows[0] || null` `:217`; `drink_plan.consult_selections` `:318`. Every read uses `pool.query` (no held client). Served by `GET /api/shifts/:shiftId/event-details` (`server/routes/eventDetails.js`) and `GET /api/beo/:proposalId` (`server/routes/beo.js`). Route suite `server/routes/eventDetails.test.js` (385 lines): HTTP harness `:52-78`, fixtures `:80-173` (`proposalId`, `shiftId`, `browsingToken`), `after` `:175-185`, no drink plan seeded.
- `client/src/pages/staff/ShiftDetail.js` (870 lines): fetches `GET /shifts/:shiftId/event-details` (`:153`); `consultSelections` local `:192` (its only other use is `:689`, `<ConsultCard consultSelections={consultSelections} />`). The brief's cocktail card reads `selections.customCocktails` (`:316`). Suites `ShiftDetail.test.js` and `ShiftDetail.catalogCache.test.js` do not reference the consult.
- `client/src/components/staff/BeoSections.js` (554 lines): `ConsultCard({ consultSelections })` `:453-472` prints `Object.entries` raw; suite `BeoSections.test.js` covers `BarMenuCard` only and mocks `../../utils/api`.
- `client/src/components/DrinkPlanSelections.js` (302 lines): default export `:19-26`; `NewSelections` `:28`; Menu Design comment and IIFE `:129-153` (IIFE opens `:132`); "Anything else" `:155-157`; Logistics block `:159-202` (crowd `:188-193`, guest preferences `:194-198`); syrups `:204`; add-ons `:231`; `LegacySelections` `:248`; `logisticsNotes` `:293-295`; empty fallback `:297-299`. Mounted only at `DrinkPlanDetail.js:322`. No test file.
- `client/src/components/ShoppingList/ShoppingListModal.jsx` (930 lines): imports end `:24`; `mode` state `:57`; `createPortal` `:495`; container `maxWidth: 960` `:507`; header `:515-584` with the Editor / Client view toggle `:536-545`; locked banner `:586-598`; editor block `:600-683`; preview `:685-694`; footer comment `:696`; `SendModal` and closing tags `:764-774`. The overlay scrolls (`overflowY: 'auto'`) and pads `calc(60px + 1.5rem)` for the app bar. Locked plans force `mode = 'preview'` (`:86-88`).
- `client/src/components/ShoppingList/ShoppingListButton.jsx` (160 lines): passes `planId`, `planToken` and approve/lock seeds only; mounted by `DrinkPlanDetail.js:234` and `DrinkPlanCard.js` (rendered by `EventDetailPage.js` and `ProposalDetail.js`).
- `GET /api/drink-plans/:id` (`server/routes/drinkPlans.js:447-470`, admin/manager) returns `selections`, `serving_type`, `submitted_at`, `consult_filled_at`, `has_consult_selections` (`consult_selections IS NOT NULL`, so `{}` reads true), `shopping_list_source`. `GET /api/cocktails` and `GET /api/mocktails` are public (`publicReadLimiter`) and return `{ cocktails }` / `{ mocktails }` (`DrinkPlanDetail.js:50-58`).
- `client/src/components/adminos/format.js`: `fmtDate(iso, opts)` `:26` ("Oct 2"), `ctDay(ts)` `:156` (Chicago `YYYY-MM-DD`). Session token: `localStorage.token` (`client/src/context/AuthContext.js:103`).
- `client/src/index.css`: the admin-os `.doc-preview-*` block ends at `:8831`; `/* ─── Menu Samples Modal ─── */` follows at `:8833`. `.gitignore` ignores `.env.*` (so `client/.env.development.local` stays untracked).
- `scripts/sensitive-match.js` over all 22 footprint paths: only `server/utils/comms/actions/consultRecap.js` and `server/utils/comms/actions/remainingActions.test.js` match.

## Lane map

- **Lane `consult-recap`** (Tasks 1 to 4).
  - **Footprint:** `server/utils/consultRecap.js`, `server/utils/consultRecap.test.js`, `server/utils/consultRecap.names.test.js` (new), `server/utils/comms/actions/consultRecap.js`, `server/utils/comms/actions/remainingActions.test.js`, `server/utils/eventDetailsPayload.js`, `server/routes/eventDetails.test.js`, `server/routes/drinkPlanConsult.js`, `server/routes/drinkPlanConsult.recap.test.js` (new), `client/src/components/staff/BeoSections.js`, `client/src/components/staff/BeoSections.test.js`, `client/src/pages/staff/ShiftDetail.js`, `ARCHITECTURE.md`.
  - **Depends on:** nothing.
  - **Method:** one pass by Claude; small, one shared formatter, each task test-first.
  - **Review before merge:** sensitive (comms action), so the seats that apply, on Opus with the diff handed over as a file: code-review; consistency-check (three readers of one formatter, and the payload key's one client reader); security-review (a new key on a payload every onboarded staffer can read, and changed content in a client email); performance-review (one chained lookup on the staff portal's hottest read). database-review is not seated: the only new SQL is two primary-key `= ANY` reads. At push: the sensitive-path re-review plus `/second-opinion` on the squash.
- **Lane `sl-client-answers`** (Tasks 5 to 8), cut from main AFTER `consult-recap`'s squash lands (the panel reads the consult GET's `recap`).
  - **Footprint:** `client/src/components/DrinkPlanSelections.js`, `client/src/components/DrinkPlanSelections.test.js` (new), `client/src/components/ShoppingList/answerSets.js` (new), `client/src/components/ShoppingList/answerSets.test.js` (new), `client/src/components/ShoppingList/ClientAnswersPanel.jsx` (new), `client/src/components/ShoppingList/ClientAnswersPanel.test.jsx` (new), `client/src/components/ShoppingList/ShoppingListModal.jsx`, `client/src/index.css`, `README.md`, `ARCHITECTURE.md`.
  - **Method:** one pass by Claude.
  - **Review before merge:** nothing sensitive: code-review plus ui-ux-review (usability and both skins; no design artifact exists for this surface, so it is judged on the spec's section 3.4).
- **Lane life:** `npm run worktree:new -- <lane>` from `os`; checkpoint commits inside the lane; `scripts/merge-lane.sh <branch> docs/superpowers/plans/2026-10-06-shopping-list-client-answers.md <lane>` from `os`; `npm run worktree:rm -- <lane>` after the merge verifies. Board lines through `scripts/board-write.sh` at cut and at merge.

---

# Lane `consult-recap`

### Task 1: One consult recap with drink names and a Mixers line

**Files:**
- Modify: `server/utils/consultRecap.js` (whole file, 97 lines)
- Modify: `server/utils/consultRecap.test.js:1-24` (import and first test) and append tests
- Create: `server/utils/consultRecap.names.test.js`

**Interfaces:**
- Produces: `consultRecapLines(consult, names = {}) -> string[]` (`[]` when there is nothing to say); `formatConsultRecap(consult = {}, names = {}) -> string[]` (never empty); `humanizeDrinkId(id) -> string`; `loadConsultDrinkNames(consult, db) -> Promise<{ cocktails: Map<string,string>, mocktails: Map<string,string> }>`; `buildConsultRecap(consult, db) -> Promise<string[] | null>`; `pickNextStepLine` unchanged.

- [ ] **Step 1: Write the failing pure tests.** In `server/utils/consultRecap.test.js`, change the import (`:3`) and replace the first test (`:5-24`, "full mix of selections") with:

```js
const {
  formatConsultRecap, consultRecapLines, humanizeDrinkId, pickNextStepLine,
} = require('./consultRecap');

test('formatConsultRecap: stored ids render as catalog names, in the shape the form writes', () => {
  const names = {
    cocktails: new Map([['old-fashioned', 'Old Fashioned'], ['margarita', 'Margarita']]),
    mocktails: new Map([['virgin-mojito', 'Virgin Mojito']]),
  };
  const lines = formatConsultRecap({
    barType: 'full_bar',
    spirits: ['vodka', 'tequila', 'whiskey'],
    signatureDrinks: ['old-fashioned', 'margarita'],
    customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
    mocktailsEnabled: true,
    mocktails: ['virgin-mojito'],
    beer: true,
    wine: ['red', 'white'],
    mixers: 'full',
  }, names);
  assert.ok(lines.includes('Bar style: Full bar'));
  assert.ok(lines.includes('Spirits: Vodka, Tequila, Whiskey'));
  assert.ok(lines.includes('Signature cocktails: Old Fashioned, Margarita'));
  assert.ok(lines.includes('Custom cocktail: House Mule (vodka, ginger beer, lime)'));
  assert.ok(lines.includes('Mocktails: Virgin Mojito'));
  assert.ok(lines.includes('Beer: yes'));
  assert.ok(lines.includes('Wine: red, white'));
  assert.ok(lines.includes('Mixers: Full set'));
  assert.doesNotMatch(lines.join(' | '), /old-fashioned|virgin-mojito/);
});
```

Append at the end of the file:

```js
test('formatConsultRecap: an id with no catalog name reads as words, never a slug', () => {
  const lines = formatConsultRecap({ signatureDrinks: ['french-75', 'long_gone_sour'], mocktails: ['no-name-spritz'] });
  assert.ok(lines.includes('Signature cocktails: French 75, Long Gone Sour'));
  assert.ok(lines.includes('Mocktails: No Name Spritz'));
});

test('formatConsultRecap: the Mixers line prints only on the bars that offer the choice', () => {
  const mixers = (c) => formatConsultRecap(c).find((l) => l.startsWith('Mixers:'));
  assert.equal(mixers({ barType: 'full_bar', mixers: 'full' }), 'Mixers: Full set');
  assert.equal(mixers({ barType: 'sig_beer_wine', mixers: 'matching' }), 'Mixers: Only those that match your spirits');
  assert.equal(mixers({ barType: 'full_bar', mixers: 'none' }), 'Mixers: None');
  assert.equal(mixers({ barType: 'beer_wine', mixers: 'none' }), undefined);
  assert.equal(mixers({ barType: 'mocktails', mixers: 'none' }), undefined);
  assert.equal(mixers({ barType: 'full_bar', mixers: 'weird' }), undefined);
  assert.equal(mixers({ mixers: 'full' }), undefined);
});

test('humanizeDrinkId: dashes, underscores and spaces split; each word capitalised', () => {
  assert.equal(humanizeDrinkId('french-75'), 'French 75');
  assert.equal(humanizeDrinkId('mccoy-swamp-juice'), 'Mccoy Swamp Juice');
  assert.equal(humanizeDrinkId(''), '');
  assert.equal(humanizeDrinkId(null), '');
});

test('consultRecapLines: [] exactly where the email prints its placeholder', () => {
  assert.deepEqual(consultRecapLines({}), []);
  assert.deepEqual(consultRecapLines(null), []);
  assert.deepEqual(consultRecapLines({ spirits: [], notes: '   ' }), []);
  assert.deepEqual(
    formatConsultRecap({ spirits: [], notes: '   ' }),
    ['(no specific selections captured; notes are on file)']
  );
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/utils/consultRecap.test.js`. Expected: FAIL (`consultRecapLines is not a function`, `humanizeDrinkId is not a function`, and the first test's names assertion).

- [ ] **Step 3: Write the failing DB test.** Create `server/utils/consultRecap.names.test.js`:

```js
require('dotenv').config();

// loadConsultDrinkNames / buildConsultRecap against the dev DB (spec
// 2026-10-06, section 3.1). Every drink row here is seeded INACTIVE with a
// nonce id, so no public menu ever lists it, and removed in after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { loadConsultDrinkNames, buildConsultRecap } = require('./consultRecap');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const COCKTAIL_ID = `recap-test-cocktail-${NONCE}`;
const MOCKTAIL_ID = `recap-test-mocktail-${NONCE}`;
// One id in BOTH tables under different names: proves each list resolves
// against its own table (the generator once resolved mocktails as cocktails).
const SHARED_ID = `recap-test-shared-${NONCE}`;

before(async () => {
  await pool.query(
    "INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Recap Test Sour', false), ($2, 'Shared As Cocktail', false)",
    [COCKTAIL_ID, SHARED_ID]
  );
  await pool.query(
    "INSERT INTO mocktails (id, name, is_active) VALUES ($1, 'Recap Test Spritz', false), ($2, 'Shared As Mocktail', false)",
    [MOCKTAIL_ID, SHARED_ID]
  );
});

after(async () => {
  await pool.query('DELETE FROM cocktails WHERE id = ANY($1::text[])', [[COCKTAIL_ID, SHARED_ID]]);
  await pool.query('DELETE FROM mocktails WHERE id = ANY($1::text[])', [[MOCKTAIL_ID, SHARED_ID]]);
  await pool.end();
});

test('loadConsultDrinkNames: each list resolves against its own table', async () => {
  const names = await loadConsultDrinkNames(
    { signatureDrinks: [COCKTAIL_ID, SHARED_ID], mocktails: [MOCKTAIL_ID, SHARED_ID] },
    pool
  );
  assert.equal(names.cocktails.get(COCKTAIL_ID), 'Recap Test Sour');
  assert.equal(names.cocktails.get(SHARED_ID), 'Shared As Cocktail');
  assert.equal(names.mocktails.get(MOCKTAIL_ID), 'Recap Test Spritz');
  assert.equal(names.mocktails.get(SHARED_ID), 'Shared As Mocktail');
});

test('loadConsultDrinkNames: a consult that names no drinks runs no query', async () => {
  let calls = 0;
  const db = { query: async () => { calls += 1; return { rows: [] }; } };
  const names = await loadConsultDrinkNames({ barType: 'beer_wine', beer: true }, db);
  assert.equal(calls, 0);
  assert.equal(names.cocktails.size, 0);
  assert.equal(names.mocktails.size, 0);
});

test('buildConsultRecap: names, not ids; a retired id humanizes', async () => {
  const lines = await buildConsultRecap({
    barType: 'full_bar',
    signatureDrinks: [COCKTAIL_ID, 'long-gone-75'],
    mocktailsEnabled: true,
    mocktails: [MOCKTAIL_ID],
    mixers: 'matching',
  }, pool);
  assert.ok(lines.includes('Signature cocktails: Recap Test Sour, Long Gone 75'));
  assert.ok(lines.includes('Mocktails: Recap Test Spritz'));
  assert.ok(lines.includes('Mixers: Only those that match your spirits'));
  assert.ok(!lines.join(' ').includes(COCKTAIL_ID));
});

test('buildConsultRecap: null for a missing, empty or nothing-to-say consult (never the placeholder)', async () => {
  assert.equal(await buildConsultRecap(null, pool), null);
  assert.equal(await buildConsultRecap({}, pool), null);
  assert.equal(await buildConsultRecap([], pool), null);
  assert.equal(await buildConsultRecap({ spirits: [], notes: '  ' }, pool), null);
});
```

- [ ] **Step 4: Run it and watch it fail.** Run: `node --test server/utils/consultRecap.names.test.js`. Expected: FAIL (`loadConsultDrinkNames is not a function`).

- [ ] **Step 5: Implement.** Replace `server/utils/consultRecap.js` with:

```js
const { recipeRowLabel } = require('./potionCatalog');

const BAR_TYPE_LABELS = {
  full_bar: 'Full bar',
  sig_beer_wine: 'Signature cocktails plus beer and wine',
  beer_wine: 'Beer and wine',
  mocktails: 'Mocktails',
};

// The three mixer modes ConsultationForm.jsx writes. Printed only on the two
// bars that offer the choice: the form forces 'none' on beer-and-wine and
// mocktail-only bars, where "Mixers: None" would be noise.
const MIXER_LABELS = new Map([
  ['full', 'Full set'],
  ['matching', 'Only those that match your spirits'],
  ['none', 'None'],
]);
const MIXER_BAR_TYPES = new Set(['full_bar', 'sig_beer_wine']);

const EMPTY_PLACEHOLDER = '(no specific selections captured; notes are on file)';

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// "french-75" -> "French 75". The consult form stores catalog ids, so a drink
// that has since left the catalog still reads as words, never as a slug.
function humanizeDrinkId(id) {
  return String(id || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ids -> display names through a Map from loadConsultDrinkNames. A caller with
// no names (or an id the catalog no longer holds) gets the humanized id.
function drinkNames(ids, map) {
  return ids.map(id => (map instanceof Map && map.get(id)) || humanizeDrinkId(id));
}

// " (gin, lime, simple syrup)" for a custom drink's ingredient rows, or '' when
// there is nothing usable to name. Array.join() stringifies each element, so a
// structured { ingredient, amount, unit } row (the shape cocktails.ingredients
// uses) would join as '[object Object]' — in an email a client reads. Fork on
// the row shape through the one shared helper instead.
function ingredientSuffix(rows) {
  if (!Array.isArray(rows)) return '';
  const labels = rows.map(recipeRowLabel).filter(Boolean);
  return labels.length ? ` (${labels.join(', ')})` : '';
}

/**
 * The saved consult_selections JSON as one-line strings, drink ids resolved
 * through `names` ({ cocktails: Map, mocktails: Map }). Fields are all
 * optional; missing fields are skipped. [] when there is nothing to say.
 */
function consultRecapLines(consult, names = {}) {
  if (!consult || typeof consult !== 'object') return [];
  const { cocktails, mocktails } = names || {};
  const lines = [];

  if (consult.barType && BAR_TYPE_LABELS[consult.barType]) {
    lines.push(`Bar style: ${BAR_TYPE_LABELS[consult.barType]}`);
  }

  if (Array.isArray(consult.spirits) && consult.spirits.length) {
    lines.push(`Spirits: ${consult.spirits.map(titleCase).join(', ')}`);
  }

  if (Array.isArray(consult.signatureDrinks) && consult.signatureDrinks.length) {
    lines.push(`Signature cocktails: ${drinkNames(consult.signatureDrinks, cocktails).join(', ')}`);
  }

  if (Array.isArray(consult.customCocktails) && consult.customCocktails.length) {
    for (const c of consult.customCocktails) {
      if (!c || !c.name) continue;
      lines.push(`Custom cocktail: ${c.name}${ingredientSuffix(c.ingredients)}`);
    }
  }

  if (consult.mocktailsEnabled || (Array.isArray(consult.mocktails) && consult.mocktails.length)) {
    if (Array.isArray(consult.mocktails) && consult.mocktails.length) {
      lines.push(`Mocktails: ${drinkNames(consult.mocktails, mocktails).join(', ')}`);
    } else {
      lines.push('Mocktails: yes (selections TBD)');
    }
  }

  if (Array.isArray(consult.customMocktails) && consult.customMocktails.length) {
    for (const c of consult.customMocktails) {
      if (!c || !c.name) continue;
      lines.push(`Custom mocktail: ${c.name}${ingredientSuffix(c.ingredients)}`);
    }
  }

  if (consult.beer) lines.push('Beer: yes');

  if (Array.isArray(consult.wine) && consult.wine.length) {
    lines.push(`Wine: ${consult.wine.join(', ')}`);
  }

  if (MIXER_BAR_TYPES.has(consult.barType) && MIXER_LABELS.has(consult.mixers)) {
    lines.push(`Mixers: ${MIXER_LABELS.get(consult.mixers)}`);
  }

  if (consult.notes && typeof consult.notes === 'string' && consult.notes.trim()) {
    lines.push(`Notes: ${consult.notes.trim()}`);
  }

  return lines;
}

/**
 * Render the saved consult_selections JSON into a list of one-line strings
 * suitable for the postConsultClient email recap. Never empty: a consult with
 * nothing to say gets the notes-on-file placeholder, as it always has.
 */
function formatConsultRecap(consult = {}, names = {}) {
  const lines = consultRecapLines(consult, names);
  return lines.length ? lines : [EMPTY_PLACEHOLDER];
}

// One query per drink table, only for the string ids the consult holds.
// `db` is the caller's handle: the pool, or a client it already holds (one
// pooled connection per request, CLAUDE.md).
async function loadConsultDrinkNames(consult, db) {
  const safe = consult && typeof consult === 'object' ? consult : {};
  const idsOf = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const sigIds = idsOf(safe.signatureDrinks);
  const mockIds = idsOf(safe.mocktails);
  const none = { rows: [] };
  const [c, m] = await Promise.all([
    sigIds.length ? db.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [sigIds]) : none,
    mockIds.length ? db.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [mockIds]) : none,
  ]);
  return {
    cocktails: new Map(c.rows.map(r => [r.id, r.name])),
    mocktails: new Map(m.rows.map(r => [r.id, r.name])),
  };
}

/**
 * The consult as readable lines for the staff Consult card and the shopping
 * list's answers panel, or null. Null, never the email's placeholder, for a
 * missing, non-object or empty consult, or one with nothing to say, so those
 * surfaces hide instead of printing a line about nothing.
 */
async function buildConsultRecap(consult, db) {
  if (!consult || typeof consult !== 'object' || Array.isArray(consult)) return null;
  if (consultRecapLines(consult).length === 0) return null;
  const names = await loadConsultDrinkNames(consult, db);
  return consultRecapLines(consult, names);
}

/**
 * Choose the right next-step line based on bar option. BYOB sends the
 * shopping-list pointer; Hosted points at bartender prep. Unknown defaults
 * to BYOB.
 */
function pickNextStepLine(barOption) {
  if (barOption === 'hosted') return 'Your bartender will prep based on this.';
  return "We'll send your shopping list shortly.";
}

module.exports = {
  formatConsultRecap,
  consultRecapLines,
  humanizeDrinkId,
  loadConsultDrinkNames,
  buildConsultRecap,
  pickNextStepLine,
};
```

(The "selections TBD" string and the em dash inside the moved `ingredientSuffix` comment are existing text, carried over unchanged.)

- [ ] **Step 6: Run both suites, one at a time.** Run: `node --test server/utils/consultRecap.test.js` then `node --test server/utils/consultRecap.names.test.js`. Expected: 14 pass, 0 fail; then 4 pass, 0 fail.

- [ ] **Step 7: Commit (lane checkpoint).**

```bash
git add server/utils/consultRecap.js server/utils/consultRecap.test.js server/utils/consultRecap.names.test.js
git commit -m "feat(consult-recap): drink names, a Mixers line, and buildConsultRecap"
```

### Task 2: The recap email prints names

**Files:**
- Modify: `server/utils/comms/actions/consultRecap.js:27`, `:54-55`, `:134`
- Test: `server/utils/comms/actions/remainingActions.test.js` (`:17-20`, `:24-37`, `:55-63`, `:87-94`, `:212-217`)

**Interfaces:**
- Consumes: `loadConsultDrinkNames(consult, db)`, `formatConsultRecap(consult, names)` from Task 1.
- Produces: `load(planId)` rows now carry `drink_names` (`{ cocktails: Map, mocktails: Map }`).

- [ ] **Step 1: Write the failing test.** In `remainingActions.test.js`, after `const STALE_EMAIL = ...` (`:19`) add `const RECAP_COCKTAIL_ID = 'remaining-recap-sour';`. In `before`, after the idempotent teardown (`:37`), add:

```js
  // An inactive catalog drink for the consult recap to name (never on a menu).
  // Its name deliberately differs from the humanized id ("Remaining Recap
  // Sour"), so the assertion below can tell a resolved name from the fallback.
  await pool.query('DELETE FROM cocktails WHERE id = $1', [RECAP_COCKTAIL_ID]);
  await pool.query(
    "INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Remaining Recap Sour (catalog)', false)",
    [RECAP_COCKTAIL_ID]
  );
```

Replace the drink plan fixture (`:55-63`) with:

```js
  const dp = await pool.query(
    `INSERT INTO drink_plans
        (client_name, client_email, event_type, event_date, proposal_id,
         consult_selections, consult_filled_at)
     VALUES ('Remaining Test', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             $3::jsonb, NULL)
     RETURNING id, token`,
    [STALE_EMAIL, proposalId, JSON.stringify({
      barType: 'full_bar', spirits: ['vodka', 'gin'], signatureDrinks: [RECAP_COCKTAIL_ID], mixers: 'full',
    })]
  );
```

In `after`, before `await pool.end();`, add `await pool.query('DELETE FROM cocktails WHERE id = $1', [RECAP_COCKTAIL_ID]);`. In the `buildMessages` test, after the "Full bar" assertion (`:216`), add:

```js
  assert.ok(byob.email.bodyText.includes('Signature cocktails: Remaining Recap Sour (catalog)'), 'drink ids render as catalog names');
  assert.ok(!byob.email.bodyText.includes(RECAP_COCKTAIL_ID), 'never the raw catalog id');
  assert.ok(byob.email.bodyText.includes('Mixers: Full set'), 'a full bar prints its mixer choice');
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/utils/comms/actions/remainingActions.test.js`. Expected: the buildMessages test FAILS on "drink ids render as catalog names". Task 1's humanized fallback is already live, so before Step 3 the body reads "Signature cocktails: Remaining Recap Sour" (the id, humanized), not the catalog name; the Mixers assertion already passes (Task 1 added the line).

- [ ] **Step 3: Implement.** In `server/utils/comms/actions/consultRecap.js`, change `:27` to:

```js
const { formatConsultRecap, pickNextStepLine, loadConsultDrinkNames } = require('../../consultRecap');
```

Replace the end of `load` (`:54-55`, `if (!rows[0]) throw new NotFoundError('Drink plan not found.');` and `return rows[0];`) with:

```js
  if (!rows[0]) throw new NotFoundError('Drink plan not found.');
  const row = rows[0];
  // Drink names for the recap lines. buildMessages (the draft the admin sees)
  // and dispatch (the defaults it compares against for body_edited) both come
  // through here, so they always render the same names.
  row.drink_names = await loadConsultDrinkNames(row.consult_selections, pool);
  return row;
```

Change `:134` to `drinkRecapLines: formatConsultRecap(row.consult_selections, row.drink_names),`.

- [ ] **Step 4: Run it and watch it pass.** Run: `node --test server/utils/comms/actions/remainingActions.test.js`. Expected: every test passes, 0 fail (read the count; it is the file's full count, unchanged plus the three new assertions inside an existing test).

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add server/utils/comms/actions/consultRecap.js server/utils/comms/actions/remainingActions.test.js
git commit -m "fix(consult-recap): the client recap email names drinks instead of printing catalog ids"
```

### Task 3: The staff Consult card reads the recap

**Files:**
- Modify: `server/utils/eventDetailsPayload.js:26-29`, `:87-93`, `:318`
- Modify: `client/src/components/staff/BeoSections.js:453-472`
- Modify: `client/src/pages/staff/ShiftDetail.js:192`, `:689`
- Modify: `ARCHITECTURE.md` (the `GET /:proposalId` row of the event-details table, `:282`)
- Test: `server/routes/eventDetails.test.js` (append), `client/src/components/staff/BeoSections.test.js` (append)

**Interfaces:**
- Consumes: `buildConsultRecap(consult, db)` from Task 1.
- Produces: the payload's `drink_plan.consult_recap: string[] | null`; `drink_plan.consult_selections` is gone. `ConsultCard({ lines })`.

- [ ] **Step 1: Write the failing server test.** Append to `server/routes/eventDetails.test.js`:

```js
test('event-details: the consult rides as recap lines with drink names, never raw JSON', async () => {
  const cocktailId = `evdet-recap-${NONCE}`;
  await pool.query("INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'EvDet Recap Sour', false)", [cocktailId]);
  const dp = await pool.query(
    'INSERT INTO drink_plans (proposal_id, client_name, consult_selections) VALUES ($1, $2, $3::jsonb) RETURNING id',
    [proposalId, `EvDet Recap ${NONCE}`, JSON.stringify({
      barType: 'full_bar',
      signatureDrinks: [cocktailId],
      customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer'] }],
    })]
  );
  try {
    const res = await request('GET', `/api/shifts/${shiftId}/event-details`, { token: browsingToken });
    assert.strictEqual(res.status, 200);
    const lines = res.body.drink_plan.consult_recap;
    assert.ok(Array.isArray(lines), 'consult_recap is an array of lines');
    assert.ok(lines.includes('Signature cocktails: EvDet Recap Sour'));
    assert.ok(lines.includes('Custom cocktail: House Mule (vodka, ginger beer)'));
    assert.ok(!('consult_selections' in res.body.drink_plan), 'the raw consult JSON no longer rides along');
    assert.doesNotMatch(JSON.stringify(lines), /object Object/);
  } finally {
    await pool.query('DELETE FROM drink_plans WHERE id = $1', [dp.rows[0].id]);
    await pool.query('DELETE FROM cocktails WHERE id = $1', [cocktailId]);
  }
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/routes/eventDetails.test.js`. Expected: the new test FAILS (`consult_recap` is undefined); every other test passes.

- [ ] **Step 3: Implement the server half.** In `server/utils/eventDetailsPayload.js`, after `:29` add `const { buildConsultRecap } = require('./consultRecap');`. Replace `dpRowP` (`:87-93`) with:

```js
  const dpRowP = pool.query(
    `SELECT id, status, finalized_at, finalized_by, selections, consult_selections,
            admin_notes, shopping_list_status,
            (selections ? '_logoFilename') AS has_logo
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  ).then(async (r) => {
    // The consult as readable lines (catalog names, never ids or raw JSON).
    // Chained onto this read rather than awaited after the barrier, so its
    // name lookup overlaps the other five reads instead of adding a round
    // trip to the staff portal's hottest read. No query at all for a consult
    // that names no drinks.
    const row = r.rows[0];
    if (row) row.consult_recap = await buildConsultRecap(row.consult_selections, pool);
    return r;
  });
```

At `:318` replace `consult_selections: dp.consult_selections,` with `consult_recap: dp.consult_recap ?? null,`.

- [ ] **Step 4: Run the server suite and watch it pass.** Run: `node --test server/routes/eventDetails.test.js`. Expected: every test passes, 0 fail. Then run `node --test server/routes/beo.test.js` (the other route on this payload). Expected: all pass.

- [ ] **Step 5: Write the failing client test.** In `client/src/components/staff/BeoSections.test.js` change the import to `import { BarMenuCard, ConsultCard } from './BeoSections';` and append:

```js
describe('ConsultCard', () => {
  test('renders the server lines, label bold, never raw JSON', () => {
    render(<ConsultCard lines={['Signature cocktails: French 75, Margarita', 'Custom cocktail: House Mule (vodka, ginger beer)']} />);
    expect(screen.getByText('Consult')).toBeInTheDocument();
    expect(screen.getByText('Signature cocktails:')).toBeInTheDocument();
    expect(screen.getByText('French 75, Margarita')).toBeInTheDocument();
    expect(screen.getByText('House Mule (vodka, ginger beer)')).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
  });

  test('renders nothing without lines', () => {
    const { container: empty } = render(<ConsultCard lines={[]} />);
    expect(empty).toBeEmptyDOMElement();
    const { container: missing } = render(<ConsultCard />);
    expect(missing).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 6: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/staff/BeoSections.test.js`. Expected: the ConsultCard tests FAIL (the current card takes `consultSelections`).

- [ ] **Step 7: Implement the client half.** Replace `ConsultCard` in `client/src/components/staff/BeoSections.js` (`:453-472`) with:

```jsx
// The consult as the server formats it (server/utils/consultRecap.js: catalog
// names, the same lines the client's recap email carries). The card used to
// print the raw JSON, so a custom drink reached the bar as "[object Object]".
export function ConsultCard({ lines }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Consult</div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--sp-ink-3)', lineHeight: 1.55 }}>
        {lines.map((line, i) => {
          const cut = line.indexOf(': ');
          return (
            <div key={i} style={{ padding: '4px 0' }}>
              {cut > 0 ? (
                <>
                  <strong style={{ color: 'var(--sp-ink-2)' }}>{line.slice(0, cut + 1)}</strong>{' '}
                  {line.slice(cut + 2)}
                </>
              ) : line}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

In `client/src/pages/staff/ShiftDetail.js` delete `:192` (`const consultSelections = drinkPlan?.consult_selections || null;`) and change `:689` to `<ConsultCard lines={drinkPlan?.consult_recap} />` (net line count: one fewer).

- [ ] **Step 8: Run the client suites and the build.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/staff/BeoSections.test.js src/pages/staff/ShiftDetail.test.js src/pages/staff/ShiftDetail.catalogCache.test.js`. Expected: all pass. Then `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully".

- [ ] **Step 9: Docs.** In `ARCHITECTURE.md`'s event-details table, the `GET /:proposalId` row (`:282`), change "drink plan (without `token`)" to "drink plan (without `token`; the consult rides as `consult_recap`, readable lines with drink names, never the raw `consult_selections` JSON)".

- [ ] **Step 10: Commit (lane checkpoint).**

```bash
git add server/utils/eventDetailsPayload.js server/routes/eventDetails.test.js client/src/components/staff/BeoSections.js client/src/components/staff/BeoSections.test.js client/src/pages/staff/ShiftDetail.js ARCHITECTURE.md
git commit -m "fix(staff): the Consult card prints drink names, not raw consult JSON"
```

### Task 4: The consult GET carries the recap

**Files:**
- Modify: `server/routes/drinkPlanConsult.js:18` (imports), `:159-170`
- Create: `server/routes/drinkPlanConsult.recap.test.js`
- Modify: `ARCHITECTURE.md` (the `GET /:id/consult` row, `:246`)

**Interfaces:**
- Consumes: `buildConsultRecap(consult, db)` from Task 1.
- Produces: `GET /api/drink-plans/:id/consult` responds `{ consult_selections, consult_filled_at, consult_filled_by_user_id, recap: string[] | null }`. Lane 2's panel reads `recap`.

- [ ] **Step 1: Write the failing route test.** Create `server/routes/drinkPlanConsult.recap.test.js`:

```js
require('dotenv').config();

// GET /api/drink-plans/:id/consult carries the read-only recap the shopping
// list modal's answers panel renders (spec 2026-10-06, section 3.1). Same
// harness as eventDetails.test.js: a minimal express app over real HTTP with
// the real router; every row seeded here is removed in after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const consultRouter = require('./drinkPlanConsult');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const COCKTAIL_ID = `consult-recap-route-${NONCE}`;
let server;
let baseUrl;
let adminToken;
let adminUserId;
let withConsultId;
let withoutConsultId;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body = null;
          try { body = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`consult-recap-route-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  await pool.query("INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Route Recap Sour', false)", [COCKTAIL_ID]);
  const a = await pool.query(
    "INSERT INTO drink_plans (client_name, consult_selections) VALUES ('Consult Recap Route', $1::jsonb) RETURNING id",
    [JSON.stringify({ barType: 'sig_beer_wine', signatureDrinks: [COCKTAIL_ID], mixers: 'matching', beer: true })]
  );
  withConsultId = a.rows[0].id;
  const b = await pool.query("INSERT INTO drink_plans (client_name) VALUES ('Consult Recap Route') RETURNING id");
  withoutConsultId = b.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', consultRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [[withConsultId, withoutConsultId].filter(Boolean)]);
  await pool.query('DELETE FROM cocktails WHERE id = $1', [COCKTAIL_ID]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('consult GET: recap lines carry drink names beside the unchanged raw blob', async () => {
  const res = await get(`/api/drink-plans/${withConsultId}/consult`, adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.consult_selections.signatureDrinks, [COCKTAIL_ID], 'the form still pre-populates from the raw blob');
  assert.ok(res.body.recap.includes('Signature cocktails: Route Recap Sour'));
  assert.ok(res.body.recap.includes('Mixers: Only those that match your spirits'));
  assert.ok(!res.body.recap.join(' ').includes(COCKTAIL_ID), 'never the raw id');
});

test('consult GET: recap is null when the plan has no consult', async () => {
  const res = await get(`/api/drink-plans/${withoutConsultId}/consult`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.consult_selections, null);
  assert.equal(res.body.recap, null);
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/routes/drinkPlanConsult.recap.test.js`. Expected: the first test FAILS (`res.body.recap` is undefined); the second fails on `recap` too.

- [ ] **Step 3: Implement.** In `server/routes/drinkPlanConsult.js` add after `:18`: `const { buildConsultRecap } = require('../utils/consultRecap');`. Replace the handler body of `GET /:id/consult` (`:159-170`) with:

```js
router.get('/:id/consult', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT consult_selections, consult_filled_at, consult_filled_by_user_id
     FROM drink_plans WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  const consult = result.rows[0].consult_selections || null;
  res.json({
    consult_selections: consult,
    consult_filled_at: result.rows[0].consult_filled_at || null,
    consult_filled_by_user_id: result.rows[0].consult_filled_by_user_id || null,
    // The read-only recap (catalog names, the same lines as the client's
    // recap email) for the shopping-list modal's answers panel. Null with no
    // consult, or one with nothing to say.
    recap: await buildConsultRecap(consult, pool),
  });
}));
```

Keep the JSDoc above the handler and add one sentence to it: "Also returns `recap`, the readable lines, for the shopping-list answers panel."

- [ ] **Step 4: Run it and watch it pass.** Run: `node --test server/routes/drinkPlanConsult.recap.test.js`. Expected: 2 pass, 0 fail. Then `node --test server/routes/drinkPlanConsult.test.js` with `ALLOW_TEST_DB_WRITES=1` set inline. Expected: all pass.

- [ ] **Step 5: Docs.** In `ARCHITECTURE.md`'s drink-plans route table, the `GET | /:id/consult` row (`:246`), change the description to "Fetch admin-side consult-form payload for re-populating the form, plus `recap` (readable lines with drink names, or null) for the shopping-list answers panel".

- [ ] **Step 6: Commit (lane checkpoint), then the lane gate.**

```bash
git add server/routes/drinkPlanConsult.js server/routes/drinkPlanConsult.recap.test.js ARCHITECTURE.md
git commit -m "feat(consult-recap): the consult GET returns the readable recap"
```

Lane gate before review: re-run each server suite this lane touched, one at a time, reading every count: `consultRecap.test.js`, `consultRecap.names.test.js`, `comms/actions/remainingActions.test.js`, `routes/eventDetails.test.js`, `routes/beo.test.js`, `routes/drinkPlanConsult.recap.test.js`, `routes/drinkPlanConsult.test.js` (with `ALLOW_TEST_DB_WRITES=1`). Then the client build. Then the review seats in the lane map. A failed or incomplete reviewer is never a pass.

**Browser check for this lane** (lane dev servers on :5001 and :3001, see Task 8 Step 6 for the start commands): on the dev DB, find an event whose consult names a custom drink (`SELECT dp.proposal_id, s.id AS shift_id FROM drink_plans dp JOIN shifts s ON s.proposal_id = dp.proposal_id AND s.status <> 'cancelled' WHERE jsonb_typeof(dp.consult_selections->'customCocktails') = 'array' AND jsonb_array_length(dp.consult_selections->'customCocktails') > 0 LIMIT 3;` on branch `br-delicate-union-adt2hvor`). Open `http://staff.localhost:3001/shifts/<shift_id>` as staff user 5 (JWT minted per the local-review recipe: `{ userId, tokenVersion }` into `localStorage.token`, never printed). Expected: the Consult card shows bold labels and drink names; no `[object Object]`, no camelCase key.

---

# Lane `sl-client-answers` (cut from main after `consult-recap` merges)

### Task 5: A list-only mode for the answers card

**Files:**
- Modify: `client/src/components/DrinkPlanSelections.js:19-26`, `:28`, `:129-133`, `:159-161`, `:188-198`, `:202-204`, `:248`, `:293-299`
- Create: `client/src/components/DrinkPlanSelections.test.js`

**Interfaces:**
- Produces: `DrinkPlanSelections({ plan, cocktails, mocktails, listOnly = false })`. With `listOnly`, no Menu Design block and no Logistics block; drinkers/crowd and guest preferences render on their own.

- [ ] **Step 1: Write the failing test.** Create `client/src/components/DrinkPlanSelections.test.js`:

```jsx
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import DrinkPlanSelections from './DrinkPlanSelections';

const plan = {
  serving_type: null,
  selections: {
    activeModules: { signatureDrinks: true, fullBar: true },
    signatureDrinks: ['margarita'],
    customCocktails: ['Spicy Paloma'],
    spirits: ['Vodka'],
    crowd: { drinkers: 80, profile: 'moderate' },
    guestPreferences: { beerVsWine: 'mostly_wine' },
    additionalNotes: 'Bride loves tequila',
    menuStyle: 'house',
    logistics: { parking: 'street_parking', equipment: ['bar_table'] },
    barPlacement: 'outdoors',
  },
};
const cocktails = [{ id: 'margarita', name: 'Margarita' }];

test('listOnly keeps the answers that drive the list', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} listOnly />);
  expect(screen.getByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText(/Spicy Paloma/)).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('Guest preferences: beer vs wine: mostly wine')).toBeInTheDocument();
  expect(screen.getByText(/Bride loves tequila/)).toBeInTheDocument();
});

test('listOnly drops menu design and every logistics answer', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} listOnly />);
  expect(screen.queryByText(/Menu Design/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Logistics/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Parking/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Bar placement/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Equipment/)).not.toBeInTheDocument();
});

test('the default render is unchanged: menu design, logistics and crowd all show', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} />);
  expect(screen.getByText(/Menu Design/)).toBeInTheDocument();
  expect(screen.getByText(/Logistics/)).toBeInTheDocument();
  expect(screen.getByText('Parking: street parking')).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
});

test('a legacy plan drops its logistics notes in listOnly', () => {
  const legacy = { serving_type: 'beer-wine-only', selections: { beerStyles: ['IPA'], logisticsNotes: 'Load in via alley' } };
  render(<DrinkPlanSelections plan={legacy} listOnly />);
  expect(screen.getByText(/IPA/)).toBeInTheDocument();
  expect(screen.queryByText(/Load in via alley/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/DrinkPlanSelections.test.js`. Expected: the two `listOnly` tests and the legacy test FAIL (menu design and logistics still render); the default-render test passes.

- [ ] **Step 3: Implement.** In `client/src/components/DrinkPlanSelections.js`:

Replace `:19-26` with:

```jsx
// listOnly: the shopping-list modal's answers panel (spec 2026-10-06) shows
// only the answers that drive the list, so menu design and every logistics
// answer stay on the plan page's full card.
export default function DrinkPlanSelections({ plan, cocktails = [], mocktails = [], listOnly = false }) {
  const sel = plan.selections || {};

  if (isNewFormat(sel)) {
    return <NewSelections plan={plan} sel={sel} cocktails={cocktails} mocktails={mocktails} listOnly={listOnly} />;
  }
  return <LegacySelections plan={plan} sel={sel} cocktails={cocktails} listOnly={listOnly} />;
}

// One string each for the crowd and guest-preference answers, so the full
// card (inside Logistics) and the list-only card render them identically.
function crowdText(sel) {
  const c = sel.crowd;
  if (!c) return null;
  const hasDrinkers = c.drinkers !== null && c.drinkers !== undefined;
  if (!hasDrinkers && !c.profile) return null;
  const count = hasDrinkers ? `${c.drinkers} drinkers` : 'drinker count unsure';
  return `Crowd: ${count}${c.profile ? ` · ${String(c.profile).replace(/_/g, ' ')}` : ''}`;
}

function guestPreferencesText(sel) {
  const gp = sel.guestPreferences;
  if (!gp || Object.keys(gp).length === 0) return null;
  return `Guest preferences: ${Object.entries(gp)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(v).replace(/_/g, ' ')}`)
    .join(' · ')}`;
}
```

Change `NewSelections`' signature (`:28`) to `function NewSelections({ plan, sel, cocktails, mocktails, listOnly }) {`.

Change the Menu Design IIFE's opening line (`:132`, `{(() => {`) to `{!listOnly && (() => {`.

Change the Logistics opening (`:159-160`, `{/* Logistics */}` then `<div className="mb-1">`) to:

```jsx
      {/* Logistics: not shown in the shopping-list answers panel */}
      {!listOnly && (
      <div className="mb-1">
```

Replace the crowd and guest-preference paragraphs inside Logistics (`:188-198`) with:

```jsx
        {crowdText(sel) && <p className="text-muted">{crowdText(sel)}</p>}
        {guestPreferencesText(sel) && <p className="text-muted">{guestPreferencesText(sel)}</p>}
```

Close the Logistics wrapper and add the list-only block: replace the Logistics closing `</div>` (`:202`) and the blank line before `{/* Flavor Add-Ons (Dr. Bartender supplied) */}` with:

```jsx
      </div>
      )}
      {listOnly && (crowdText(sel) || guestPreferencesText(sel)) && (
        <div className="mb-1">
          {crowdText(sel) && <p className="text-muted">{crowdText(sel)}</p>}
          {guestPreferencesText(sel) && <p className="text-muted">{guestPreferencesText(sel)}</p>}
        </div>
      )}

```

Change `LegacySelections`' signature (`:248`) to `function LegacySelections({ plan, sel, cocktails, listOnly }) {`, its logistics-notes guard (`:293`) to `{!listOnly && sel.logisticsNotes && (`, and its empty fallback (`:297`) to `{!typeName && !sel.spirits?.length && (listOnly || !sel.logisticsNotes) && (`.

- [ ] **Step 4: Run it and watch it pass.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/DrinkPlanSelections.test.js`. Expected: 4 pass.

- [ ] **Step 5: Manual check of the unchanged plan page** happens in Task 8 Step 7 (the full card on `/drink-plans/:id` still shows Menu Design and Logistics).

- [ ] **Step 6: Commit (lane checkpoint).**

```bash
git add client/src/components/DrinkPlanSelections.js client/src/components/DrinkPlanSelections.test.js
git commit -m "feat(answers): a list-only mode for the planner answers card"
```

### Task 6: Pick and label the answer set

**Files:**
- Create: `client/src/components/ShoppingList/answerSets.js`
- Create: `client/src/components/ShoppingList/answerSets.test.js`

**Interfaces:**
- Produces: `hasPlannerAnswers(selections) -> boolean`; `pickAnswerSets(plan, hasConsult) -> { sets: Array<{ key: 'consult'|'planner', at: string|null, submitted: boolean }>, initial: 'consult'|'planner'|null }`; `sourceLine(set) -> string`; `switchLabel(set) -> string`; `mismatchNote(shownKey, listSource) -> string|null`.

- [ ] **Step 1: Write the failing test.** Create `client/src/components/ShoppingList/answerSets.test.js`:

```js
import { hasPlannerAnswers, pickAnswerSets, sourceLine, switchLabel, mismatchNote } from './answerSets';

const SEL = { activeModules: { signatureDrinks: true }, signatureDrinks: ['margarita'] };
const plan = (o = {}) => ({ selections: SEL, submitted_at: null, consult_filled_at: null, ...o });

describe('pickAnswerSets', () => {
  test('consult saved after the planner submit opens on the consult', () => {
    const r = pickAnswerSets(plan({ submitted_at: '2026-09-20T15:00:00Z', consult_filled_at: '2026-10-02T15:00:00Z' }), true);
    expect(r.sets.map((s) => s.key)).toEqual(['consult', 'planner']);
    expect(r.initial).toBe('consult');
  });

  test('a planner submitted after the consult opens on the planner', () => {
    const r = pickAnswerSets(plan({ submitted_at: '2026-09-25T15:00:00Z', consult_filled_at: '2026-09-20T15:00:00Z' }), true);
    expect(r.initial).toBe('planner');
  });

  test('an unsubmitted planner never beats a consult', () => {
    const r = pickAnswerSets(plan({ consult_filled_at: '2026-01-01T15:00:00Z' }), true);
    expect(r.initial).toBe('consult');
    expect(r.sets[1]).toEqual({ key: 'planner', at: null, submitted: false });
  });

  test('a tie, or a consult with no stamp, goes to the consult', () => {
    const at = '2026-09-25T15:00:00Z';
    expect(pickAnswerSets(plan({ submitted_at: at, consult_filled_at: at }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ submitted_at: at, consult_filled_at: null }), true).initial).toBe('consult');
  });

  test('one set alone opens on itself; neither is the empty case', () => {
    expect(pickAnswerSets(plan(), false)).toEqual({ sets: [{ key: 'planner', at: null, submitted: false }], initial: 'planner' });
    expect(pickAnswerSets(plan({ selections: null }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ selections: null }), false)).toEqual({ sets: [], initial: null });
    expect(pickAnswerSets(null, true)).toEqual({ sets: [], initial: null });
  });

  test('empty selections are no planner set', () => {
    expect(hasPlannerAnswers({})).toBe(false);
    expect(hasPlannerAnswers([])).toBe(false);
    expect(hasPlannerAnswers(null)).toBe(false);
    expect(hasPlannerAnswers(SEL)).toBe(true);
  });
});

describe('copy', () => {
  test('source lines and switch labels carry the Chicago day', () => {
    expect(sourceLine({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('From the consult, Oct 2');
    expect(sourceLine({ key: 'planner', at: '2026-09-25T15:00:00Z', submitted: true })).toBe('From the planner, submitted Sep 25');
    expect(sourceLine({ key: 'planner', at: null, submitted: false })).toBe('From the planner, not submitted');
    expect(switchLabel({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('Consult · Oct 2');
    expect(switchLabel({ key: 'planner', at: null, submitted: false })).toBe('Planner · not submitted');
  });

  test('an evening stamp reads as its Chicago day, not the UTC day', () => {
    // 2026-10-03T02:30Z is 9:30 PM on Oct 2 in Chicago.
    expect(sourceLine({ key: 'consult', at: '2026-10-03T02:30:00Z', submitted: true })).toBe('From the consult, Oct 2');
  });

  test('the mismatch note names the set that built the list, only when it differs', () => {
    expect(mismatchNote('planner', 'consult')).toBe('This list was built from the consult.');
    expect(mismatchNote('consult', 'planner')).toBe('This list was built from the planner.');
    expect(mismatchNote('consult', 'consult')).toBeNull();
    expect(mismatchNote('planner', null)).toBeNull();
    expect(mismatchNote('planner', 'something-else')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList/answerSets.test.js`. Expected: FAIL (`Cannot find module './answerSets'`).

- [ ] **Step 3: Implement.** Create `client/src/components/ShoppingList/answerSets.js`:

```js
import { fmtDate, ctDay } from '../adminos/format';

// Which of a drink plan's two answer sets the shopping-list modal's answers
// panel offers, and which it opens on (spec 2026-10-06, decisions 3 and 4).
// The consult counts from its last save (consult_filled_at is stamped on every
// save); the planner counts from its submit. The planner opens first only when
// the client SUBMITTED it strictly after a known consult stamp: an unsubmitted
// draft never beats a consult, and a tie or an unstamped consult goes to the
// consult.

export function hasPlannerAnswers(selections) {
  return Boolean(selections) && typeof selections === 'object' && !Array.isArray(selections)
    && Object.keys(selections).length > 0;
}

// hasConsult: the consult GET returned non-empty recap lines (a consult saved
// as {} is no set at all).
export function pickAnswerSets(plan, hasConsult) {
  const sets = [];
  if (!plan) return { sets, initial: null };
  if (hasConsult) {
    sets.push({ key: 'consult', at: plan.consult_filled_at || null, submitted: true });
  }
  if (hasPlannerAnswers(plan.selections)) {
    sets.push({ key: 'planner', at: plan.submitted_at || null, submitted: Boolean(plan.submitted_at) });
  }
  if (sets.length === 0) return { sets, initial: null };
  if (sets.length === 1) return { sets, initial: sets[0].key };
  const [consult, planner] = sets;
  const plannerLater = planner.submitted && Boolean(consult.at)
    && new Date(planner.at).getTime() > new Date(consult.at).getTime();
  return { sets, initial: plannerLater ? 'planner' : 'consult' };
}

const day = (ts) => fmtDate(ctDay(ts));

// "From the consult, Oct 2" / "From the planner, submitted Sep 25" /
// "From the planner, not submitted".
export function sourceLine(set) {
  if (!set) return '';
  if (set.key === 'consult') return set.at ? `From the consult, ${day(set.at)}` : 'From the consult';
  return set.submitted ? `From the planner, submitted ${day(set.at)}` : 'From the planner, not submitted';
}

// The switch's own label for each side.
export function switchLabel(set) {
  if (set.key === 'consult') return set.at ? `Consult · ${day(set.at)}` : 'Consult';
  return set.submitted ? `Planner · ${day(set.at)}` : 'Planner · not submitted';
}

// One line whenever the panel shows a set the list was not built from.
export function mismatchNote(shownKey, listSource) {
  if (!shownKey || shownKey === listSource) return null;
  if (listSource === 'consult') return 'This list was built from the consult.';
  if (listSource === 'planner') return 'This list was built from the planner.';
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList/answerSets.test.js`. Expected: 9 pass.

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/answerSets.js client/src/components/ShoppingList/answerSets.test.js
git commit -m "feat(answers): pick the newest answer set and label it"
```

### Task 7: The Client's answers panel

**Files:**
- Create: `client/src/components/ShoppingList/ClientAnswersPanel.jsx`
- Create: `client/src/components/ShoppingList/ClientAnswersPanel.test.jsx`

**Interfaces:**
- Consumes: `GET /api/drink-plans/:id/consult` `recap` (Task 4); `DrinkPlanSelections` `listOnly` (Task 5); `pickAnswerSets`, `sourceLine`, `switchLabel`, `mismatchNote` (Task 6).
- Produces: default `ClientAnswersPanel({ planId })`; named `readAnswersOpen() -> boolean`, `writeAnswersOpen(open: boolean) -> void`.

- [ ] **Step 1: Write the failing test.** Create `client/src/components/ShoppingList/ClientAnswersPanel.test.jsx`:

```jsx
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ClientAnswersPanel from './ClientAnswersPanel';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const COCKTAILS = [{ id: 'margarita', name: 'Margarita' }];
const PLANNER = {
  activeModules: { signatureDrinks: true, fullBar: true },
  signatureDrinks: ['margarita'],
  spirits: ['Vodka'],
  crowd: { drinkers: 80, profile: 'moderate' },
  menuStyle: 'house',
  logistics: { parking: 'street_parking' },
};
const RECAP = ['Bar style: Full bar', 'Signature cocktails: French 75'];

const plan = (o = {}) => ({
  id: 42,
  serving_type: null,
  selections: PLANNER,
  submitted_at: null,
  has_consult_selections: false,
  consult_filled_at: null,
  shopping_list_source: 'planner',
  ...o,
});

// CRA resetMocks wipes implementations before every test, so each test mocks.
function mockApi(p, { recap = null, failUrl = null } = {}) {
  api.get.mockImplementation((url) => {
    if (url === failUrl) return Promise.reject(new Error('boom'));
    if (url === `/drink-plans/${p.id}`) return Promise.resolve({ data: p });
    if (url === '/cocktails') return Promise.resolve({ data: { cocktails: COCKTAILS } });
    if (url === '/mocktails') return Promise.resolve({ data: { mocktails: [] } });
    if (url === `/drink-plans/${p.id}/consult`) return Promise.resolve({ data: { recap } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

test('planner only: the drink answers and crowd, never menu design or parking, no switch', async () => {
  mockApi(plan());
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('From the planner, not submitted')).toBeInTheDocument();
  expect(screen.queryByText(/Menu Design/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Parking/)).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Which answers' })).not.toBeInTheDocument();
});

test('both sets, consult newer: opens on the consult, flips to the planner, writes nothing', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: RECAP });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('Signature cocktails: French 75')).toBeInTheDocument();
  expect(screen.getByText('From the consult, Oct 2')).toBeInTheDocument();
  expect(screen.queryByText(/This list was built from/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Planner · not submitted' }));
  expect(screen.getByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText('This list was built from the consult.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a planner submitted after the consult opens on the planner, with the note', async () => {
  mockApi(plan({
    has_consult_selections: true,
    consult_filled_at: '2026-09-20T15:00:00Z',
    submitted_at: '2026-09-25T15:00:00Z',
    shopping_list_source: 'consult',
  }), { recap: RECAP });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the planner, submitted Sep 25')).toBeInTheDocument();
  expect(screen.getByText('This list was built from the consult.')).toBeInTheDocument();
});

test('a reopen starts on the newest set again (a flip is not remembered)', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: RECAP });
  const first = render(<ClientAnswersPanel planId={42} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Planner · not submitted' }));
  expect(screen.getByText('From the planner, not submitted')).toBeInTheDocument();
  first.unmount();
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the consult, Oct 2')).toBeInTheDocument();
});

test('a consult saved as {} is no set: the planner shows alone', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z' }), { recap: null });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the planner, not submitted')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Which answers' })).not.toBeInTheDocument();
});

test('a failed catalog read is an error with Retry, never a planner view missing its drinks', async () => {
  const p = plan();
  mockApi(p, { failUrl: '/mocktails' });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText("Couldn't load the client's answers.")).toBeInTheDocument();
  expect(screen.queryByText(/Crowd:/)).not.toBeInTheDocument();
  mockApi(p);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/Margarita/)).toBeInTheDocument();
});

test('no answers at all: the empty state', async () => {
  mockApi(plan({ selections: null, shopping_list_source: null }));
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('No planner or consult answers yet.')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList/ClientAnswersPanel.test.jsx`. Expected: FAIL (`Cannot find module './ClientAnswersPanel'`).

- [ ] **Step 3: Implement.** Create `client/src/components/ShoppingList/ClientAnswersPanel.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import DrinkPlanSelections from '../DrinkPlanSelections';
import { pickAnswerSets, sourceLine, switchLabel, mismatchNote } from './answerSets';

// The client's answers beside the shopping list (spec
// docs/superpowers/specs/2026-10-06-shopping-list-client-answers-design.md).
// Shows the answers that drive the list from the newest set, with a view-only
// switch when the plan has both. Nothing here writes: rebuilding the list from
// the other set stays on the plan page's source switch.

const OPEN_KEY = 'drb.sl.answersOpen';

// A per-browser convenience. Storage can be blocked (private windows, cleared
// site data), so every access is guarded and the default is open.
export function readAnswersOpen() {
  try { return window.localStorage.getItem(OPEN_KEY) !== 'false'; } catch { return true; }
}

export function writeAnswersOpen(open) {
  try { window.localStorage.setItem(OPEN_KEY, open ? 'true' : 'false'); } catch { /* the default (open) still works */ }
}

export default function ClientAnswersPanel({ planId }) {
  const [data, setData] = useState({ status: 'loading' });
  const [shown, setShown] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData({ status: 'loading' });
    (async () => {
      try {
        // All or nothing: DrinkPlanSelections filters picks against the
        // catalogs, so an empty catalog would silently drop the client's drinks.
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          api.get(`/drink-plans/${planId}`),
          api.get('/cocktails'),
          api.get('/mocktails'),
        ]);
        const plan = planRes.data;
        let recap = null;
        if (plan.has_consult_selections) {
          const consultRes = await api.get(`/drink-plans/${planId}/consult`);
          const lines = consultRes.data && consultRes.data.recap;
          recap = Array.isArray(lines) && lines.length > 0 ? lines : null;
        }
        if (cancelled) return;
        const { sets, initial } = pickAnswerSets(plan, recap !== null);
        setData({
          status: 'ready',
          plan,
          recap,
          sets,
          cocktails: (cocktailsRes.data && cocktailsRes.data.cocktails) || [],
          mocktails: (mocktailsRes.data && mocktailsRes.data.mocktails) || [],
        });
        setShown(initial);
      } catch {
        if (!cancelled) setData({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [planId, attempt]);

  const ready = data.status === 'ready';
  const shownSet = ready ? data.sets.find((s) => s.key === shown) : null;
  const note = ready ? mismatchNote(shown, data.plan.shopping_list_source) : null;

  return (
    <aside className="sl-answers" aria-label="Client's answers">
      <div className="sl-answers-head">
        <h3 className="sl-answers-title">Client's answers</h3>
        {ready && data.sets.length === 2 && (
          <div className="sl-answers-switch" role="group" aria-label="Which answers">
            {data.sets.map((s) => (
              <button
                key={s.key}
                type="button"
                className={shown === s.key ? 'sl-answers-seg is-on' : 'sl-answers-seg'}
                aria-pressed={shown === s.key}
                onClick={() => setShown(s.key)}
              >
                {switchLabel(s)}
              </button>
            ))}
          </div>
        )}
        {shownSet && <p className="sl-answers-source">{sourceLine(shownSet)}</p>}
        {note && <p className="sl-answers-note">{note}</p>}
      </div>
      <div className="sl-answers-body">
        {data.status === 'loading' && <p className="sl-answers-muted">Loading answers…</p>}
        {data.status === 'error' && (
          <div className="sl-answers-muted">
            <p>Couldn't load the client's answers.</p>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {ready && data.sets.length === 0 && (
          <p className="sl-answers-muted">No planner or consult answers yet.</p>
        )}
        {ready && shown === 'planner' && (
          <div className="sl-answers-planner">
            <DrinkPlanSelections plan={data.plan} cocktails={data.cocktails} mocktails={data.mocktails} listOnly />
          </div>
        )}
        {ready && shown === 'consult' && (
          <ul className="sl-answers-lines">
            {data.recap.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run it and watch it pass.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList/ClientAnswersPanel.test.jsx`. Expected: 7 pass.

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/ClientAnswersPanel.jsx client/src/components/ShoppingList/ClientAnswersPanel.test.jsx
git commit -m "feat(answers): the Client's answers panel"
```

### Task 8: Mount the panel in the modal, style it, document it, see it

**Files:**
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx:24`, `:57`, `:507`, `:543-545`, `:586`, `:696`
- Modify: `client/src/index.css` (insert after `:8831`)
- Modify: `README.md:632`, `ARCHITECTURE.md:1648`

**Interfaces:**
- Consumes: `ClientAnswersPanel`, `readAnswersOpen`, `writeAnswersOpen` (Task 7).

- [ ] **Step 1: Wire the modal.** In `ShoppingListModal.jsx`:

After `:24` add:

```js
import ClientAnswersPanel, { readAnswersOpen, writeAnswersOpen } from './ClientAnswersPanel';
```

After the `mode` state (`:57`) add:

```js
  // The client's answers beside the list (spec 2026-10-06). Open by default;
  // the choice is a per-browser convenience.
  const [answersOpen, setAnswersOpen] = useState(readAnswersOpen);
  const showAnswers = answersOpen && Boolean(planId);
  const toggleAnswers = () => {
    const next = !answersOpen;
    setAnswersOpen(next);
    writeAnswersOpen(next);
  };
```

Change the container's `maxWidth: 960,` (`:507`) to `maxWidth: showAnswers ? 1280 : 960,`.

After the Editor / Client view toggle (the `</div>` that follows `<button onClick={() => setMode('preview')} style={segBtn(mode === 'preview')}>Client view</button>`, `:544-545`) add:

```jsx
          {planId && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={toggleAnswers}
              aria-pressed={answersOpen}
              style={{ whiteSpace: 'nowrap' }}
            >
              {answersOpen ? 'Hide answers' : 'Show answers'}
            </button>
          )}
```

Immediately before the locked banner (`        {locked && (` at `:586`) add:

```jsx
        <div className={showAnswers ? 'sl-modal-body sl-modal-body--answers' : 'sl-modal-body'}>
          <div className="sl-modal-main">
```

Immediately before `        {/* ── Footer actions ── */}` (`:696`) add:

```jsx
          </div>
          {showAnswers && <ClientAnswersPanel planId={planId} />}
        </div>
```

Leave the wrapped lines' indentation as it is (JSX ignores it; re-indenting 110 lines would bury the change). Confirm `wc -l` reads 956 or less.

- [ ] **Step 2: Style it.** In `client/src/index.css`, insert after the `.doc-preview-empty` rule (ends `:8831`), before `/* ─── Menu Samples Modal ─── */`:

```css
/* ─── Shopping list: the client's answers panel (spec 2026-10-06) ─── */
html[data-app="admin-os"] .sl-modal-body--answers {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  padding-right: 1.25rem;
}
html[data-app="admin-os"] .sl-modal-body--answers .sl-modal-main {
  flex: 1 1 auto;
  min-width: 0;
}
html[data-app="admin-os"] .sl-answers {
  flex: 0 0 300px;
  width: 300px;
  margin-top: 1.25rem;
  position: sticky;
  top: calc(60px + 1rem);
  max-height: calc(100vh - 60px - 2rem);
  overflow-y: auto;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  color: var(--ink-1);
  font-size: 13px;
  line-height: 1.5;
}
html[data-app="admin-os"] .sl-answers-head {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 0.875rem 0.5rem;
  border-bottom: 1px solid var(--line-2);
}
html[data-app="admin-os"] .sl-answers-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.95rem;
  color: var(--ink-1);
}
html[data-app="admin-os"] .sl-answers-switch {
  display: inline-flex;
  align-self: flex-start;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
html[data-app="admin-os"] .sl-answers-seg {
  background: transparent;
  color: var(--ink-3);
  border: none;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}
html[data-app="admin-os"] .sl-answers-seg.is-on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
html[data-app="admin-os"] .sl-answers-source {
  margin: 0;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--ink-3);
}
html[data-app="admin-os"] .sl-answers-note {
  margin: 0;
  padding: 0.35rem 0.55rem;
  font-size: 0.75rem;
  color: var(--ink-2);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
}
html[data-app="admin-os"] .sl-answers-body {
  padding: 0.75rem 0.875rem;
}
html[data-app="admin-os"] .sl-answers-lines {
  margin: 0;
  padding-left: 1.1rem;
}
html[data-app="admin-os"] .sl-answers-lines li {
  padding: 0.15rem 0;
}
html[data-app="admin-os"] .sl-answers-muted {
  color: var(--ink-3);
}
html[data-app="admin-os"] .sl-answers-muted p {
  margin: 0 0 0.5rem;
}
@media (max-width: 1199px) {
  html[data-app="admin-os"] .sl-modal-body--answers {
    flex-direction: column;
    align-items: stretch;
    padding-right: 0;
  }
  html[data-app="admin-os"] .sl-answers {
    order: -1;
    position: static;
    flex: none;
    width: auto;
    max-height: none;
    margin: 1rem 1.25rem 0;
  }
}
```

- [ ] **Step 3: Docs.** `README.md:632` (the `ShoppingList/` tree line): append " + ClientAnswersPanel (the client's newest planner or consult answers beside the list, with a view-only switch; answerSets.js picks and labels the set)". `ARCHITECTURE.md:1648` (the `ShoppingListModal.jsx` bullet): append "A Show answers / Hide answers header toggle (remembered per browser) opens `ClientAnswersPanel` beside the list." and add after that bullet:

```markdown
- **`ClientAnswersPanel.jsx`** + **`answerSets.js`** — The client's answers that drive the list, from the newest set (consult by its last save, planner by its submit; an unsubmitted planner never beats a consult), with a view-only Consult / Planner switch and a one-line note when the shown set did not build the list. Planner answers render through `DrinkPlanSelections` with `listOnly`; consult answers are the `recap` lines from `GET /api/drink-plans/:id/consult`. Reads only; rebuilding the list from the other set stays on the plan page's source switch.
```

- [ ] **Step 4: Gates.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList src/components/DrinkPlanSelections.test.js`. Expected: all pass (NeedsRecipeSection included). Run: `npm run check:css-scope` and `npm run check:filesize`. Expected: green; `ShoppingListModal.jsx` under 1000. Run: `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully".

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/ShoppingListModal.jsx client/src/index.css README.md ARCHITECTURE.md
git commit -m "feat(answers): the answers panel beside the shopping list"
```

- [ ] **Step 6: Start the lane's own dev servers** (never touch a server another window runs on :3000/:5000). From the lane root:

```bash
cp ../../os/.env .env
printf 'REACT_APP_API_URL=http://localhost:5001\n' > client/.env.development.local
PORT=5001 NODE_ENV=development node server/index.js   # background; wait for "Server running on port 5001"
cd client && PORT=3001 HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none npx react-scripts start   # background
```

Both files are gitignored (`.env`, `.env.*`). Find test data on the dev branch (`br-delicate-union-adt2hvor`, read-only):

```sql
SELECT dp.id AS plan_id, dp.proposal_id, dp.submitted_at IS NOT NULL AS planner_submitted,
       dp.shopping_list_source, dp.finalized_at IS NOT NULL AS finalized
  FROM drink_plans dp
 WHERE dp.shopping_list IS NOT NULL
   AND dp.consult_selections IS NOT NULL AND dp.consult_selections <> '{}'::jsonb
   AND dp.selections ? 'activeModules'
 ORDER BY dp.id DESC LIMIT 5;
```

If no row comes back, take a dev plan with a list and planner answers and save a consult on it through the plan page's "Input from consult" form on the lane's dev server (dev DB only; it regenerates that dev plan's list). Sign in as admin user 1 with a JWT minted per the local-review recipe (`{ userId, tokenVersion }` from the dev `users` row, signed with `JWT_SECRET`, set into `localStorage.token` by Playwright, never printed).

- [ ] **Step 7: See it** (Playwright, both skins, screenshots kept for the review):
  - 1440px, `http://localhost:3001/drink-plans/<plan_id>`, Shopping List: the panel sits right of the list, titled "Client's answers"; the switch reads "Consult · <day>" and "Planner · not submitted" (or the submit day); consult lines print drink names. Scroll the list: the panel stays in view. Click Planner: the planner answers show with no Menu Design and no Logistics, and the note "This list was built from the consult." appears.
  - Hide answers: the modal returns to 960px with no panel, matching today's layout. Close, reload, reopen: still hidden. Show answers: back.
  - 1024px: the panel stacks above the list at full width.
  - `http://localhost:3001/events/<proposal_id>`: Shopping List from the drink plan card shows the same panel.
  - The plan page's own Selections card still shows Menu Design and Logistics (the full card is unchanged).
  - Switch the admin skin (House Lights and After Hours): the panel's text, switch and note are readable on both.
  - A finalized plan (if the query returned one): the read-only Client view shows the panel too.
  - Expected every time: no console errors; no request other than the four GETs from the panel.

- [ ] **Step 8: Lane gate, review, merge.** Seats per the lane map (code-review, ui-ux-review with the Step 7 screenshots). A failed or incomplete reviewer is never a pass. Merge with `scripts/merge-lane.sh`.

## After each merge (on main)

- `consult-recap` merged: delete the two ledger entries it closes (section 2 "The post-consult recap email lists drinks by their catalog slug" and section 4 "The staff brief's consult card prints a custom drink as `[object Object]`") and their rows in the one-screen table; add to `docs/walkthroughs-owed.md` a walk for Dallas once pushed: a consult-fed event's staff page shows drink names, and the next consult recap email reads names and a Mixers line.
- `sl-client-answers` merged: delete the Potions entry "Planner answers beside the shopping list" and mark item 8 of the 2026-09-22 drop list SHIPPED with the squash sha; add a walk: open a list from the plan page and the event page, flip the switch, hide and show the panel.
- Board lines through `scripts/board-write.sh` at each cut and merge.
