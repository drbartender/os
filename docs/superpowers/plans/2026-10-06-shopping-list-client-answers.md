# Client's Answers Beside the Shopping List (lanes consult-recap, sl-client-answers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin shopping-list modal shows the client's answers that drive the list (newest set, consult or planner, with a view-only switch), and every consult rendering (the client recap email, the staff Consult card, the new panel) reads one server recap that prints drink names instead of catalog ids or raw JSON.

**Architecture:** Two lanes, merged in order. Lane `consult-recap` (Tasks 1 to 5) teaches `server/utils/consultRecap.js` to resolve drink ids to names through a lookup that never throws, adds a Mixers line, and points its three readers at it: the recap email action, the staff event-details payload with its card, and the consult GET (a new `recap` field). Lane `sl-client-answers` (Tasks 6 to 9), cut from main after the first squash lands, adds a list-only mode to the existing answers card, a pure set-picker, the panel component, and the modal wiring with its CSS. No schema change, no new endpoint, no money path.

**Tech Stack:** Node 26 + Express 4 + `pg` (raw SQL), `node:test` server suites against the shared dev DB; React 18 (CRA) with jest + RTL 13 (jest-dom imported per file, CRA `resetMocks: true`), the `api` axios client; vanilla CSS in `client/src/index.css` under the admin-os scope; Playwright for the browser checks.

**Spec:** `docs/superpowers/specs/2026-10-06-shopping-list-client-answers-design.md` (rev 2; decisions in section 2 are Dallas's, 2026-10-06).

**Decision trail:** Dallas's 2026-09-22 drop, item 8 (`docs/fix-list-remaining-2026-07-02.md`, Potions, "Planner answers beside the shopping list"), plus the two ledger entries filed 2026-10-06: section 2 "The post-consult recap email lists drinks by their catalog slug" and section 4 "The staff brief's consult card prints a custom drink as `[object Object]`". Brainstormed in chat 2026-10-06. Dallas: build once the spec and plan are reviewed.

**Rev 2 (2026-10-06):** folds in the design fleet (spec-grounding, spec-gaps, spec-risk, plan-fidelity, plan-decomposition, plan-feasibility; no blockers). The name lookup never throws and moves out of the recipient resolve; the panel reads the admin catalogs and treats a missing `recap` key as an error; the planner set is defined by its drink answers; the list note covers a set with no answers; the staff payload keeps `consult_selections` for one release; the modal width moves into classes; the server lane gets its own gate task with every suite that loads an edited file, a staff-card browser check and a read of the rendered email; corrected red-step counts and line numbers.

**Prod facts (read-only, production branch, 2026-10-06):** 23 plans carry consult answers, all with `shopping_list_source = 'consult'`; 14 hold a custom drink; 2 upcoming live bookings carry a consult custom drink; 11 plans hold both sets and on all 11 the planner was never submitted; 9 consult recap emails sent (2026-07-19 to 2026-10-05), 6 with picked cocktails, none edited before sending; consult drink ids are catalog slugs (`french-75`).

**Dev facts (read-only, dev branch `br-delicate-union-adt2hvor`, 2026-10-06):** admin user 1 and staff user 5 exist, both `approved`. Plan 451 (proposal 9819) has open shift 4308, no consult (`consult_selections` NULL) and no list. Plan 19 holds both sets and a list. No plan is finalized with a list. Cocktail `margarita` is named "Margarita".

## Global Constraints

- No em dashes in any new client-facing or admin-facing copy (email lines, panel copy, button labels).
- No schema change, no new endpoint, nothing on a money path; the plan page's source switch (`PATCH /api/drink-plans/:id/shopping-list-source`) and list generation are untouched.
- One pooled connection per request (CLAUDE.md): `loadConsultDrinkNames(consult, db)` always queries through the handle its caller passes.
- File-size ratchet: `ShoppingListModal.jsx` is 930 lines against the 1000 hard cap; Task 9 brings it to 955. `ShiftDetail.js` (870) must not grow.
- Admin CSS is scoped under `html[data-app="admin-os"]` and painted only with admin skin tokens; `npm run check:css-scope` stays green.
- Every client checkpoint (Tasks 3, 6, 7, 8, 9) passes `cd client && CI=true npx react-scripts build` before its commit: jest does not run ESLint, and a lint warning is fatal on Vercel.
- Server suites run one at a time from the lane root against the dev DB; read the pass count every run. Every row a test seeds is removed by that test file.
- Staging is explicit (`git add <path>`), never `-A`; lanes merge only through `scripts/merge-lane.sh`.
- Dates in admin copy are the Chicago day: `fmtDate(ctDay(ts))` from `client/src/components/adminos/format.js`.
- A test that would send to Sentry clears `SENTRY_DSN_SERVER` for its duration.

## Review Focus

The five inputs most likely to bite that the spec implies and no happy-path test reaches, each pinned by a test in the task named:

1. **The name lookup failing** (a transient DB error): the one-shot first-save client email, the staff brief and the consult form must all survive with humanized names. Pinned in Task 1 (the loader returns empty Maps and `buildConsultRecap` returns humanized lines on a failing `db`).
2. **Mocktail ids resolved against the cocktails table** (the generator shipped exactly that bug once, `shoppingListGen.js:85-87`). Pinned in Task 1 by one id seeded in BOTH tables under different names.
3. **A server older than the panel** (deploy window, or a lone revert of the server lane): the consult GET answers without `recap`; the panel must show its error, never "No planner or consult answers yet." beside a consult-built list. Pinned in Task 8.
4. **A planner holding no drink answers** (only a logo, or only menu-design or logistics answers): no planner set, never a blank switch side. Pinned in Task 7, with the list note for a list built from such a set pinned in Tasks 7 and 8.
5. **The switch writing anything, or being remembered:** it is view-only and resets on reopen. Pinned in Task 8 (no `put`/`post`/`patch`; a remount opens on the newest set).

## Proven context (verified against main on 2026-10-06, not from memory)

- `server/utils/consultRecap.js` (97 lines): `recipeRowLabel` import `:1`; `BAR_TYPE_LABELS` `:3-8`; `titleCase` `:10`; `ingredientSuffix` `:21`; `formatConsultRecap(consult = {})` `:34-86` (signature drinks joined raw at `:48-49`, mocktails at `:59-61`, placeholder at `:85`); `pickNextStepLine` `:92`; exports `:97`. Its suite `server/utils/consultRecap.test.js` is pure (10 tests, all green on main) and its first fixture holds display names, a shape the form never writes.
- `server/utils/shoppingListGen.js:31-38` `reportCatalogIssue`: `console.error` plus, when `SENTRY_DSN_SERVER` is set, `require('@sentry/node').captureException(err, { tags: { op } })`. The pattern the new lookup's failure report copies.
- `client/src/components/ShoppingList/ConsultationForm.jsx`: stores catalog ids (`c.id`, `:412-417`), custom drinks as `{ name, ingredients: string[] }` (`:365`), wine as `'red' | 'white' | 'sparkling'`, `mixers` as `'full' | 'matching' | 'none'` (options `:32-34`, `none` = "Don't include extra mixers (sig drink ingredients still go on the list)"), forcing `'none'` on beer-and-wine and mocktail-only bars (`:102`, `:137`).
- `cocktails.id` and `mocktails.id` are `VARCHAR(100)` primary keys; only `name` is `NOT NULL` without a default. `drink_plans` has no NOT NULL column without a default; `consult_selections` has no default.
- `server/utils/comms/actions/consultRecap.js` (233 lines, SENSITIVE: `server/utils/comms/actions/*.js`, `scripts/sensitive-paths.txt:226`): imports `:22-29` (`formatConsultRecap, pickNextStepLine` at `:27`); `load(planId)` `:38-56`; `resolveRecipient` `:112-114` (also through `load`); `defaultParts(row)` `:116`, formatter call `:134`; `buildMessages` `:141-143`; `dispatch` `:175`, `row` `:176`, `recipient` `:177`, `defaults = defaultParts(row)` `:178` (compared against the sent body to set `bodyEdited`). `consultRecapParts` (`server/utils/lifecycleEmailTemplates.js:381`) prints the lines verbatim, one per line. `renderPartsEmail` (`server/utils/comms/render.js:15`) returns `{ subject, html, text }`. The first-save auto-send (`server/routes/drinkPlanConsult.js:300-321`) dispatches through this action after releasing its pooled client (`:284`) and only logs a failure as `[consult_recap] post-commit notify failed (non-fatal):` (`:313`).
- `server/utils/comms/actions/remainingActions.test.js` (SENSITIVE by the same glob; 18 tests, green on main): `require('dotenv').config()` `:13`; `LIVE_EMAIL` `:19`; `STALE_EMAIL` `:20`; `before` `:23` (idempotent teardown `:24-37`); drink plan fixture `:55-63` with consult JSON inline; `after` `:87-94`; buildMessages test `:212`.
- `server/routes/drinkPlanConsult.js` (404 lines): imports `:11-25` (`recipeRowLabel` at `:18`); `GET /:id/consult` handler `:159-171` (`auth, requireAdminOrManager`; returns `consult_selections`, `consult_filled_at`, `consult_filled_by_user_id`). Mounted at `/api/drink-plans` (`server/index.js:382`). `consult_filled_at = NOW()` on every save (`:250`, `:261`). Its suite `drinkPlanConsult.test.js` (5 tests, needs `ALLOW_TEST_DB_WRITES=1`) covers `performConsultsCompletionFlip` only.
- `server/utils/eventDetailsPayload.js` (338 lines): imports `:26-29`; `dpRowP` `:87-93`; the barrier `Promise.all` `:208-210`; `dp = dpRow.rows[0] || null` `:217`; `drink_plan.consult_selections` `:318`. Every read uses `pool.query`. Served by `GET /api/shifts/:shiftId/event-details` and `GET /api/beo/:proposalId`. `server/routes/eventDetails.test.js` (19 tests, green): harness `request(method, path, { token })` `:52-78`, `NONCE`, fixtures `:80-173` (`proposalId`, `shiftId`, `browsingToken`), no drink plan seeded. `server/routes/beo.test.js`: 29 tests, green.
- `client/src/pages/staff/ShiftDetail.js` (870 lines): `consultSelections` `:192`, used only at `:689`. Suites `ShiftDetail.test.js` and `ShiftDetail.catalogCache.test.js` never mention the consult. `client/src/components/staff/BeoSections.js` (554 lines): `ConsultCard({ consultSelections })` `:453-472`, returns null on a missing blob (`:454`); suite `BeoSections.test.js` covers `BarMenuCard` only.
- `client/src/components/DrinkPlanSelections.js` (302 lines): default export `:19-26`; `NewSelections` `:28`; Menu Design comment and IIFE `:129-153` (IIFE opens `:132`); "Anything else" `:155-157`; Logistics block `:159-202` (crowd `:188-193`, guest preferences `:194-198`); syrups `:204`; add-ons `:231`; `LegacySelections` `:248`; `logisticsNotes` `:293-295`; empty fallback `:297-299`. No test file.
- `client/src/components/ShoppingList/ShoppingListModal.jsx` (930 lines): `DerivationStrip` import `:24`; `mode` state `:57`; `createPortal` `:495`; container `<div style={{` `:503` with `maxWidth: 960,` `:507`; the "Client view" button `:543`, its toggle `</div>` `:544`; header closes `:588`; `{locked && (` `:590`; editor block from `:604`; footer comment `:696`.
- `server/routes/cocktails.js:38` and `server/routes/mocktails.js:35`: `GET /admin` (`auth, requireAdminOrManager`) returns `{ categories, cocktails }` / `{ categories, mocktails }` with every drink, inactive included. The public `GET /` routes filter `is_active = true` behind `publicReadLimiter`.
- `GET /api/drink-plans/:id` (`server/routes/drinkPlans.js:447-470`, admin/manager) returns `selections`, `serving_type`, `status`, `submitted_at`, `consult_filled_at`, `has_consult_selections` (`consult_selections IS NOT NULL`), `shopping_list_source`. Plan logo uploads merge `companyLogo` and `_logoFilename` into `selections` (`:161-164`).
- `client/src/components/adminos/format.js`: `fmtDate(iso, opts)` `:26` ("Oct 2"), `ctDay(ts)` `:156`. Session token: `localStorage.token`.
- `client/src/index.css`: the admin-os `.doc-preview-*` block ends at `:8831`; `/* ─── Menu Samples Modal ─── */` at `:8833`.
- Docs anchors: `README.md:397` (`consultRecap.js` tree line), `:632` (`ShoppingList/` tree line), `:725` (`## Key Features`); `ARCHITECTURE.md:246` (consult GET row), `:282` (event-details payload row), `:1555` (`consult_recap` action entry), `:1648` (`ShoppingListModal.jsx` bullet).
- `npm run worktree:new -- <lane>` symlinks the lane's `.env` and `client/.env` to main's (`scripts/worktree-new.js:122-123`); `.gitignore` ignores `.env.*`.
- `scripts/sensitive-match.js` over all footprint paths: only `server/utils/comms/actions/consultRecap.js` and `remainingActions.test.js` match.

## Local dev servers for a lane (used by Tasks 5 and 9)

From the lane root, never touching a dev server another window runs on :3000/:5000 (`$SCRATCH` is the session scratchpad):

```bash
printf 'REACT_APP_API_URL=http://localhost:5001\n' > client/.env.development.local   # gitignored by .env.*
PORT=5001 NODE_ENV=development node server/index.js > "$SCRATCH/lane-server.log" 2>&1 &
# wait until the log shows "Server running on port 5001"
(cd client && PORT=3001 HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none npx react-scripts start > "$SCRATCH/lane-client.log" 2>&1 &)
# wait until the log shows "Compiled"
```

Sign in with JWTs minted per the local-review recipe (`{ userId, tokenVersion }` from the dev `users` row, signed with `JWT_SECRET`, set into `localStorage.token` by Playwright, never printed): admin user 1 for `http://localhost:3001`, staff user 5 for `http://staff.localhost:3001`. Afterwards stop only the processes listening on :5001 and :3001, and delete `client/.env.development.local`.

## Lane map

- **Lane `consult-recap`** (Tasks 1 to 5).
  - **Footprint:** `server/utils/consultRecap.js`, `server/utils/consultRecap.test.js`, `server/utils/consultRecap.names.test.js` (new), `server/utils/comms/actions/consultRecap.js`, `server/utils/comms/actions/remainingActions.test.js`, `server/utils/eventDetailsPayload.js`, `server/routes/eventDetails.test.js`, `server/routes/drinkPlanConsult.js`, `server/routes/drinkPlanConsult.recap.test.js` (new), `client/src/components/staff/BeoSections.js`, `client/src/components/staff/BeoSections.test.js`, `client/src/pages/staff/ShiftDetail.js`, `README.md`, `ARCHITECTURE.md`.
  - **Depends on:** nothing.
  - **Method:** one pass by Claude, each task test-first.
  - **Review before merge (Task 5):** sensitive (the comms action), so the seats that apply, on Opus, with the diff handed over as a file: code-review; consistency-check (three readers of one formatter, and the payload's one client reader); security-review (a new key on a payload every onboarded staffer can read, and changed content in a client email); performance-review (one chained lookup on the staff portal's hottest read). database-review is not seated: the only new SQL is two primary-key `= ANY` reads. `eventDetailsPayload.js` and `drinkPlanConsult.js` are not sensitive-listed, so they stay pinned to this lane: its fleet covers them, and at push the sensitive-path re-review of this squash commit (plus `/second-opinion`) covers them again.
- **Lane `sl-client-answers`** (Tasks 6 to 9), cut from main AFTER `consult-recap`'s squash lands (the panel reads the consult GET's `recap`).
  - **Footprint:** `client/src/components/DrinkPlanSelections.js`, `client/src/components/DrinkPlanSelections.test.js` (new), `client/src/components/ShoppingList/answerSets.js` (new), `client/src/components/ShoppingList/answerSets.test.js` (new), `client/src/components/ShoppingList/ClientAnswersPanel.jsx` (new), `client/src/components/ShoppingList/ClientAnswersPanel.test.jsx` (new), `client/src/components/ShoppingList/ShoppingListModal.jsx`, `client/src/index.css`, `README.md`, `ARCHITECTURE.md`.
  - **Method:** one pass by Claude.
  - **Review before merge (Task 9):** nothing sensitive: code-review, ui-ux-review (usability and both skins; no design artifact exists, so it is judged on spec section 3.4), and consistency-check on the `recap` contract the lanes share across different files (`string[] | null`; null for an empty consult; absent on an older server), which the push-time seam sweep would miss because the lanes share no code file.
- **Push and revert order:** `consult-recap` must be live before `sl-client-answers` (it is merged first; both may ride one push, and the panel's missing-`recap` error state covers the minutes Vercel runs ahead of Render). Revert `sl-client-answers` before `consult-recap`, never the reverse.
- **Lane life:** `npm run worktree:new -- <lane>` from `os`; checkpoint commits inside the lane; `scripts/merge-lane.sh <branch> docs/superpowers/plans/2026-10-06-shopping-list-client-answers.md <lane>` from `os`; `npm run worktree:rm -- <lane>` after the merge verifies. Board lines through `scripts/board-write.sh` at cut and at merge.

---

# Lane `consult-recap`

### Task 1: One consult recap with drink names, a Mixers line, and a lookup that never throws

**Files:**
- Modify: `server/utils/consultRecap.js` (whole file, 97 lines)
- Modify: `server/utils/consultRecap.test.js:1-24` (import and first test) and append tests
- Create: `server/utils/consultRecap.names.test.js`
- Modify: `README.md:397`

**Interfaces:**
- Produces: `consultRecapLines(consult, names = {}) -> string[]` (`[]` when there is nothing to say); `formatConsultRecap(consult = {}, names = {}) -> string[]` (never empty); `humanizeDrinkId(id) -> string`; `loadConsultDrinkNames(consult, db) -> Promise<{ cocktails: Map<string,string>, mocktails: Map<string,string> }>` (never rejects); `unmatchedDrinkIds(consult, names) -> string[]`; `buildConsultRecap(consult, db) -> Promise<string[] | null>` (never rejects); `pickNextStepLine` unchanged.

- [ ] **Step 1: Write the failing pure tests.** In `server/utils/consultRecap.test.js`, change the import (`:3`) and replace the first test (`:5-24`, "full mix of selections") with:

```js
const {
  formatConsultRecap, consultRecapLines, humanizeDrinkId, unmatchedDrinkIds, pickNextStepLine,
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

test('formatConsultRecap: a picked id that is not a string or a number is skipped, never stringified', () => {
  const lines = formatConsultRecap({ signatureDrinks: ['margarita', { id: 'x' }, '', null, 7] });
  assert.ok(lines.includes('Signature cocktails: Margarita, 7'));
  assert.doesNotMatch(lines.join(' | '), /object Object/);
});

test('formatConsultRecap: the Mixers line prints only on the bars that offer the choice', () => {
  const mixers = (c) => formatConsultRecap(c).find((l) => l.startsWith('Mixers:'));
  assert.equal(mixers({ barType: 'full_bar', mixers: 'full' }), 'Mixers: Full set');
  assert.equal(mixers({ barType: 'sig_beer_wine', mixers: 'matching' }), 'Mixers: Only those that match your spirits');
  assert.equal(mixers({ barType: 'full_bar', mixers: 'none' }), 'Mixers: None beyond your signature cocktail ingredients');
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

test('unmatchedDrinkIds: the picked ids the lookup did not name', () => {
  const names = { cocktails: new Map([['a', 'A']]), mocktails: new Map() };
  assert.deepEqual(unmatchedDrinkIds({ signatureDrinks: ['a', 'b'], mocktails: ['c'] }, names), ['b', 'c']);
  assert.deepEqual(unmatchedDrinkIds({}, names), []);
  assert.deepEqual(unmatchedDrinkIds(null), []);
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/utils/consultRecap.test.js`. Expected: FAIL on the new tests (`consultRecapLines is not a function`, `humanizeDrinkId is not a function`, `unmatchedDrinkIds is not a function`) and on the first test's names assertion.

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
const failingDb = { query: async () => { throw new Error('simulated lookup failure'); } };

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

// The failure path reports to Sentry when a DSN is set; a test must not.
async function withoutSentry(fn) {
  const saved = process.env.SENTRY_DSN_SERVER;
  delete process.env.SENTRY_DSN_SERVER;
  try { return await fn(); } finally { if (saved !== undefined) process.env.SENTRY_DSN_SERVER = saved; }
}

test('loadConsultDrinkNames: each list resolves against its own table, inactive drinks included', async () => {
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

test('loadConsultDrinkNames: a failed lookup returns empty Maps instead of throwing', async () => {
  const names = await withoutSentry(() => loadConsultDrinkNames({ signatureDrinks: [COCKTAIL_ID] }, failingDb));
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

test('buildConsultRecap: a failed lookup degrades to humanized names, never a throw', async () => {
  const lines = await withoutSentry(() => buildConsultRecap({ signatureDrinks: ['french-75'] }, failingDb));
  assert.deepEqual(lines, ['Signature cocktails: French 75']);
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

// The three mixer modes ConsultationForm.jsx writes, in the form's own terms.
// Printed only on the two bars that offer the choice: the form forces 'none'
// on beer-and-wine and mocktail-only bars. 'none' still puts signature
// cocktail ingredients on the list, so a bare "None" would contradict the
// list the client then receives.
const MIXER_LABELS = new Map([
  ['full', 'Full set'],
  ['matching', 'Only those that match your spirits'],
  ['none', 'None beyond your signature cocktail ingredients'],
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

// The picked ids as strings. Anything else (an object, a boolean, a blank)
// is skipped, never stringified into "[object Object]".
function drinkIds(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter(x => (typeof x === 'string' && x.trim()) || (typeof x === 'number' && Number.isFinite(x)))
    .map(String);
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

  const sigIds = drinkIds(consult.signatureDrinks);
  if (sigIds.length) {
    lines.push(`Signature cocktails: ${drinkNames(sigIds, cocktails).join(', ')}`);
  }

  if (Array.isArray(consult.customCocktails) && consult.customCocktails.length) {
    for (const c of consult.customCocktails) {
      if (!c || !c.name) continue;
      lines.push(`Custom cocktail: ${c.name}${ingredientSuffix(c.ingredients)}`);
    }
  }

  const mockIds = drinkIds(consult.mocktails);
  if (consult.mocktailsEnabled || mockIds.length) {
    if (mockIds.length) {
      lines.push(`Mocktails: ${drinkNames(mockIds, mocktails).join(', ')}`);
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

// Reported, never thrown: every caller would rather print a humanized name
// than fail (the one-shot first-save client email, the staff brief, the
// consult form's load). Same shape as reportCatalogIssue in shoppingListGen.
function reportNameLookupFailure(err) {
  console.error('[consultRecap] drink name lookup failed:', err ? err.message : '');
  if (process.env.SENTRY_DSN_SERVER) {
    const Sentry = require('@sentry/node');
    Sentry.captureException(err, { tags: { op: 'consult_recap_names' } });
  }
}

// One query per drink table, only for the ids the consult holds, whatever
// is_active says (a drink retired after the client picked it still reads by
// name). `db` is the caller's handle: the pool, or a client it already holds
// (one pooled connection per request, CLAUDE.md). Never rejects.
async function loadConsultDrinkNames(consult, db) {
  const empty = () => ({ cocktails: new Map(), mocktails: new Map() });
  const safe = consult && typeof consult === 'object' ? consult : {};
  const sigIds = drinkIds(safe.signatureDrinks);
  const mockIds = drinkIds(safe.mocktails);
  if (!sigIds.length && !mockIds.length) return empty();
  try {
    const none = { rows: [] };
    const [c, m] = await Promise.all([
      sigIds.length ? db.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [sigIds]) : none,
      mockIds.length ? db.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [mockIds]) : none,
    ]);
    return {
      cocktails: new Map(c.rows.map(r => [r.id, r.name])),
      mocktails: new Map(m.rows.map(r => [r.id, r.name])),
    };
  } catch (err) {
    reportNameLookupFailure(err);
    return empty();
  }
}

// The picked ids the lookup did not name: catalog drift that would otherwise
// be humanized silently into a client email.
function unmatchedDrinkIds(consult, names = {}) {
  const safe = consult && typeof consult === 'object' ? consult : {};
  const { cocktails, mocktails } = names || {};
  const named = (map, id) => map instanceof Map && map.has(id);
  return [
    ...drinkIds(safe.signatureDrinks).filter(id => !named(cocktails, id)),
    ...drinkIds(safe.mocktails).filter(id => !named(mocktails, id)),
  ];
}

/**
 * The consult as readable lines for the staff Consult card and the shopping
 * list's answers panel, or null. Null, never the email's placeholder, for a
 * missing, non-object or empty consult, or one with nothing to say, so those
 * surfaces hide instead of printing a line about nothing. Never rejects: its
 * lookup never throws and the formatter is pure.
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
  unmatchedDrinkIds,
  buildConsultRecap,
  pickNextStepLine,
};
```

(The "selections TBD" string and the em dash inside the carried-over `ingredientSuffix` comment are existing text, unchanged.)

- [ ] **Step 6: Run both suites, one at a time.** Run: `node --test server/utils/consultRecap.test.js` then `node --test server/utils/consultRecap.names.test.js`. Expected: 16 pass, 0 fail; then 6 pass, 0 fail (the failure tests print one `[consultRecap] drink name lookup failed` line each; that is the report, not an error).

- [ ] **Step 7: Docs.** `README.md:397`: replace the comment on the `consultRecap.js` line with "# The one consult recap: saved consult selections as readable lines with catalog drink names (the post-consult email, the staff Consult card, the consult GET's `recap`); its name lookup never throws".

- [ ] **Step 8: Commit (lane checkpoint).**

```bash
git add server/utils/consultRecap.js server/utils/consultRecap.test.js server/utils/consultRecap.names.test.js README.md
git commit -m "feat(consult-recap): drink names, a Mixers line, and a lookup that never throws"
```

### Task 2: The recap email prints names

**Files:**
- Modify: `server/utils/comms/actions/consultRecap.js:27`, `:116`, `:134`, `:141-143`, `:178`
- Test: `server/utils/comms/actions/remainingActions.test.js` (`:20`, `:37`, `:55-63`, `:87-94`, `:212-217`)
- Modify: `ARCHITECTURE.md:1555`

**Interfaces:**
- Consumes: `loadConsultDrinkNames`, `unmatchedDrinkIds`, `formatConsultRecap(consult, names)` from Task 1.
- Produces: `defaultParts(row, names)`; `load()` and `resolveRecipient` unchanged.

- [ ] **Step 1: Write the failing test.** In `remainingActions.test.js`, after `const STALE_EMAIL = ...` (`:20`) add `const RECAP_COCKTAIL_ID = 'remaining-recap-sour';`. In `before`, after the idempotent teardown (`:37`), add:

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

In `after`, before `await pool.end();`, add `await pool.query('DELETE FROM cocktails WHERE id = $1', [RECAP_COCKTAIL_ID]);`. In the `buildMessages` test, after the "Full bar" assertion, add:

```js
  assert.ok(byob.email.bodyText.includes('Signature cocktails: Remaining Recap Sour (catalog)'), 'drink ids render as catalog names');
  assert.ok(!byob.email.bodyText.includes(RECAP_COCKTAIL_ID), 'never the raw catalog id');
  assert.ok(byob.email.bodyText.includes('Mixers: Full set'), 'a full bar prints its mixer choice');
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/utils/comms/actions/remainingActions.test.js`. Expected: the buildMessages test FAILS on "drink ids render as catalog names": Task 1's humanized fallback is already live, so the body reads "Signature cocktails: Remaining Recap Sour" (the id, humanized), not the catalog name. The other 17 pass.

- [ ] **Step 3: Implement.** In `server/utils/comms/actions/consultRecap.js`:

`:27` becomes:

```js
const { formatConsultRecap, pickNextStepLine, loadConsultDrinkNames, unmatchedDrinkIds } = require('../../consultRecap');
```

`defaultParts` (`:116`) becomes `function defaultParts(row, names) {`, and its formatter call (`:134`) `drinkRecapLines: formatConsultRecap(row.consult_selections, names),`.

`buildMessages` (`:141-143`) becomes:

```js
async function buildMessages(planId) {
  const row = await load(planId);
  // Names load here and in dispatch, never in load(): resolveRecipient never
  // prints a drink, so it runs no extra query.
  return defaultParts(row, await loadConsultDrinkNames(row.consult_selections, pool));
}
```

In `dispatch`, replace `const defaults = defaultParts(row);` (`:178`) with:

```js
  // loadConsultDrinkNames never throws (a failed lookup degrades to humanized
  // names), so the one-shot first-save send can never be lost to it.
  const names = await loadConsultDrinkNames(row.consult_selections, pool);
  const unmatched = unmatchedDrinkIds(row.consult_selections, names);
  if (unmatched.length) {
    console.warn(`[consult_recap] plan ${planId}: no catalog name for ${unmatched.join(', ')}`);
  }
  const defaults = defaultParts(row, names);
```

- [ ] **Step 4: Run it and watch it pass.** Run: `node --test server/utils/comms/actions/remainingActions.test.js`. Expected: 18 pass, 0 fail.

- [ ] **Step 5: Docs.** `ARCHITECTURE.md:1555` (the `consult_recap` entry): append "Its recap lines name drinks from the catalog (resolved in `buildMessages` and `dispatch`, never in `resolveRecipient`) and carry a Mixers line; a failed name lookup degrades to humanized ids and never fails the send, and `dispatch` warns on ids the catalog no longer names."

- [ ] **Step 6: Commit (lane checkpoint).**

```bash
git add server/utils/comms/actions/consultRecap.js server/utils/comms/actions/remainingActions.test.js ARCHITECTURE.md
git commit -m "fix(consult-recap): the client recap email names drinks instead of printing catalog ids"
```

### Task 3: The staff Consult card reads the recap

**Files:**
- Modify: `server/utils/eventDetailsPayload.js:29` (import), `:87-93`, `:318`
- Modify: `client/src/components/staff/BeoSections.js:453-472`
- Modify: `client/src/pages/staff/ShiftDetail.js:192`, `:689`
- Modify: `ARCHITECTURE.md:282`
- Test: `server/routes/eventDetails.test.js` (append), `client/src/components/staff/BeoSections.test.js` (append)

**Interfaces:**
- Consumes: `buildConsultRecap(consult, db)` from Task 1.
- Produces: the payload's `drink_plan.consult_recap: string[] | null`; `drink_plan.consult_selections` stays for one release. `ConsultCard({ lines })`.

- [ ] **Step 1: Write the failing server test.** Append to `server/routes/eventDetails.test.js`:

```js
test('event-details: the consult rides as recap lines with drink names', async () => {
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
    assert.doesNotMatch(JSON.stringify(lines), /object Object/);
    // Kept for ONE release so a staff tab opened before the deploy keeps today's card.
    assert.deepStrictEqual(res.body.drink_plan.consult_selections.signatureDrinks, [cocktailId]);
  } finally {
    await pool.query('DELETE FROM drink_plans WHERE id = $1', [dp.rows[0].id]);
    await pool.query('DELETE FROM cocktails WHERE id = $1', [cocktailId]);
  }
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/routes/eventDetails.test.js`. Expected: the new test FAILS (`consult_recap` is undefined); the other 19 pass (each runs with no drink plan, so they also prove a proposal with no plan still builds).

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
    // trip to the staff portal's hottest read. No plan row means no lookup;
    // buildConsultRecap never rejects, so it can never fail the barrier.
    const row = r.rows[0];
    if (row) row.consult_recap = await buildConsultRecap(row.consult_selections, pool);
    return r;
  });
```

At `:318`, keep `consult_selections: dp.consult_selections,` and add after it:

```js
      // The readable consult. consult_selections above rides along for ONE
      // release so a staff tab opened before the deploy keeps today's card
      // until it reloads; dropping it is a follow-up on the ledger.
      consult_recap: dp.consult_recap ?? null,
```

- [ ] **Step 4: Run the server suites and watch them pass.** Run: `node --test server/routes/eventDetails.test.js` (expected 20 pass, 0 fail), then `node --test server/routes/beo.test.js` (expected 29 pass, 0 fail).

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

- [ ] **Step 6: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/staff/BeoSections.test.js`. Expected: 1 FAIL ("renders the server lines"; today's card takes `consultSelections` and ignores `lines`); "renders nothing without lines" already passes (today's card returns null on a missing blob, `:454`), and the BarMenuCard tests pass.

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

In `client/src/pages/staff/ShiftDetail.js` delete `:192` (`const consultSelections = drinkPlan?.consult_selections || null;`) and change `:689` to `<ConsultCard lines={drinkPlan?.consult_recap} />` (one line fewer).

- [ ] **Step 8: Run the client suites and the build.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/staff/BeoSections.test.js src/pages/staff/ShiftDetail.test.js src/pages/staff/ShiftDetail.catalogCache.test.js`. Expected: all pass. Then `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully".

- [ ] **Step 9: Docs.** `ARCHITECTURE.md:282` (the `GET /:proposalId` event-details row): change "drink plan (without `token`)" to "drink plan (without `token`; the consult rides as `consult_recap`, readable lines with drink names, with the raw `consult_selections` kept for one release while open staff tabs turn over)".

- [ ] **Step 10: Commit (lane checkpoint).**

```bash
git add server/utils/eventDetailsPayload.js server/routes/eventDetails.test.js client/src/components/staff/BeoSections.js client/src/components/staff/BeoSections.test.js client/src/pages/staff/ShiftDetail.js ARCHITECTURE.md
git commit -m "fix(staff): the Consult card prints drink names, not raw consult JSON"
```

### Task 4: The consult GET carries the recap

**Files:**
- Modify: `server/routes/drinkPlanConsult.js:18` (imports), the whole `GET /:id/consult` handler `:159-171`
- Create: `server/routes/drinkPlanConsult.recap.test.js`
- Modify: `ARCHITECTURE.md:246`

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
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'recap'), 'the key is always present');
  assert.equal(res.body.recap, null);
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node --test server/routes/drinkPlanConsult.recap.test.js`. Expected: both tests FAIL (`res.body.recap` is undefined).

- [ ] **Step 3: Implement.** In `server/routes/drinkPlanConsult.js` add after `:18`: `const { buildConsultRecap } = require('../utils/consultRecap');`. Replace the WHOLE `GET /:id/consult` handler (`:159-171`, from `router.get('/:id/consult'` through its closing `}));`) with:

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
    // consult, or one with nothing to say. buildConsultRecap never rejects,
    // so the raw blob the form pre-populates from always comes back.
    recap: await buildConsultRecap(consult, pool),
  });
}));
```

Add one sentence to the JSDoc above the handler: "Also returns `recap`, the readable lines, for the shopping-list answers panel."

- [ ] **Step 4: Run it and watch it pass.** Run: `node --test server/routes/drinkPlanConsult.recap.test.js`. Expected: 2 pass, 0 fail.

- [ ] **Step 5: Docs.** `ARCHITECTURE.md:246` (the `GET | /:id/consult` row): "Fetch admin-side consult-form payload for re-populating the form, plus `recap` (readable lines with drink names, or null) for the shopping-list answers panel".

- [ ] **Step 6: Commit (lane checkpoint).**

```bash
git add server/routes/drinkPlanConsult.js server/routes/drinkPlanConsult.recap.test.js ARCHITECTURE.md
git commit -m "feat(consult-recap): the consult GET returns the readable recap"
```

### Task 5: Lane `consult-recap` gate, browser and email checks, review, merge

**Files:** none new; checks only (plus the review handoff file in `$SCRATCH`).

- [ ] **Step 1: Every suite that loads an edited file, one at a time, counts read.** From the lane root, each as `ALLOW_TEST_DB_WRITES=1 node --test <file>`:
  `server/utils/consultRecap.test.js` (16), `server/utils/consultRecap.names.test.js` (6), `server/utils/comms/actions/remainingActions.test.js` (18), `server/routes/eventDetails.test.js` (20), `server/routes/beo.test.js` (29), `server/routes/drinkPlanConsult.recap.test.js` (2), `server/routes/drinkPlanConsult.test.js` (5), `server/routes/drinkPlanConsult.sanitize.test.js`, `server/routes/drinkPlans.beo.test.js`, `server/routes/drinkPlans/hostedNoList.test.js`, `server/utils/comms/registry.test.js`, `server/routes/comms.test.js`, `server/utils/comms/actions/proposalActions.test.js`, `server/utils/beoFinalize.auto.test.js`. Expected: 0 fail in every suite (the unbracketed ones keep main's count). The hostedNoList run must also show no `post-commit notify failed` line (its consult PUTs reach the email's dispatch, whose catch only logs): `ALLOW_TEST_DB_WRITES=1 node --test server/routes/drinkPlans/hostedNoList.test.js 2>&1 | grep -c "post-commit notify failed"` prints `0`.

- [ ] **Step 2: Client.** `cd client && CI=true npx react-scripts test --watchAll=false src/components/staff src/pages/staff/ShiftDetail` (all pass) and `CI=true npx react-scripts build` ("Compiled successfully").

- [ ] **Step 3: Seed one dev consult (dev DB only, restored in Step 6).** Through the Neon MCP on branch `br-delicate-union-adt2hvor`, confirm plan 451 still has no consult (`SELECT consult_selections FROM drink_plans WHERE id = 451` returns NULL; if not, save the value to `$SCRATCH` to restore), then:

```sql
UPDATE drink_plans
   SET consult_selections = '{"barType":"full_bar","signatureDrinks":["margarita","long-gone-75"],"customCocktails":[{"name":"House Mule","ingredients":["vodka","ginger beer","lime"]}],"mixers":"none","notes":"Lane check"}'::jsonb
 WHERE id = 451;
```

- [ ] **Step 4: See the staff card.** Start the lane's dev servers (the recipe above). Open `http://staff.localhost:3001/shifts/4308` as staff user 5. Expected Consult card rows, each with its label bold: "Bar style: Full bar", "Signature cocktails: Margarita, Long Gone 75", "Custom cocktail: House Mule (vodka, ginger beer, lime)", "Mixers: None beyond your signature cocktail ingredients", "Notes: Lane check". No `[object Object]`, no camelCase key. Screenshot it for the review handoff.

- [ ] **Step 5: Read the client email before it reaches a client.** From the lane root:

```bash
node -e "require('dotenv').config(); const a = require('./server/utils/comms/actions/consultRecap'); const { renderPartsEmail } = require('./server/utils/comms/render'); const { pool } = require('./server/db'); a.buildMessages(451).then((m) => { const r = renderPartsEmail(m.email); require('fs').writeFileSync(process.argv[1], r.html); console.log(m.email.subject); console.log(m.email.bodyText.split('\n\n')[1]); return pool.end(); })" "$SCRATCH/consult-recap-email.html"
```

Expected printed recap paragraph: "Here's what we landed on:" followed by the five lines from Step 4 ("Long Gone 75" is the humanized fallback for an id the catalog does not hold). Screenshot `$SCRATCH/consult-recap-email.html` in Playwright and confirm the HTML body shows the same lines. Nothing is sent: `buildMessages` only builds.

- [ ] **Step 6: Restore dev and stop the servers.** `UPDATE drink_plans SET consult_selections = NULL WHERE id = 451;` (or the saved value). Stop only :5001 and :3001; delete `client/.env.development.local`.

- [ ] **Step 7: Review seats.** Write the handoff file `$SCRATCH/consult-recap-review.md`: `git log --oneline main..HEAD`, `git diff --stat main...HEAD`, `git diff -U10 main...HEAD`, the suite counts from Steps 1-2, the two screenshots' paths and the printed email paragraph. Dispatch code-review, consistency-check, security-review and performance-review in parallel on Opus, each with its `.claude/agents/<seat>.md` instructions inlined and the handoff file as input, each told to finish within a budget and end with a verdict. A failed or incomplete reviewer is never a pass. Fix every real finding test-first, re-run the affected suites, and re-confirm with the seat that raised it.

- [ ] **Step 8: Merge.** From `os` (clean tree): `scripts/merge-lane.sh consult-recap docs/superpowers/plans/2026-10-06-shopping-list-client-answers.md consult-recap`. Re-run `node --test server/utils/consultRecap.test.js` and `node --test server/routes/eventDetails.test.js` on main after the merge. Then `npm run worktree:rm -- consult-recap` and a board line. On main: delete the two ledger entries this lane closes (section 2 recap email, section 4 staff Consult card) and their one-screen rows; file the follow-up "Drop `consult_selections` from the staff event-details payload (kept one release for open tabs, lane consult-recap)" below the divider; add the walk to `docs/walkthroughs-owed.md` (once pushed: a consult-fed event's staff page shows drink names; the next consult recap email reads names and the Mixers line).

---

# Lane `sl-client-answers` (cut from main after `consult-recap` merges)

### Task 6: A list-only mode for the answers card

**Files:**
- Modify: `client/src/components/DrinkPlanSelections.js:19-26`, `:28`, `:132`, `:159-160`, `:188-198`, `:202`, `:248`, `:293`, `:297`
- Create: `client/src/components/DrinkPlanSelections.test.js`

**Interfaces:**
- Produces: `DrinkPlanSelections({ plan, cocktails, mocktails, listOnly = false })`. With `listOnly`, no Menu Design block and no Logistics block; the crowd and guest-preference lines render on their own, each carrying its label.

- [ ] **Step 1: Write the test.** Create `client/src/components/DrinkPlanSelections.test.js`:

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

// A regression guard, not a red test: today's card already renders all of this.
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

test('the default render is unchanged: menu design, logistics, crowd and guest preferences all show', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} />);
  expect(screen.getByText(/Menu Design/)).toBeInTheDocument();
  expect(screen.getByText(/Logistics/)).toBeInTheDocument();
  expect(screen.getByText('Parking: street parking')).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('Guest preferences: beer vs wine: mostly wine')).toBeInTheDocument();
});

test('a legacy plan drops its logistics notes in listOnly', () => {
  const legacy = { serving_type: 'beer-wine-only', selections: { beerStyles: ['IPA'], logisticsNotes: 'Load in via alley' } };
  render(<DrinkPlanSelections plan={legacy} listOnly />);
  expect(screen.getByText(/IPA/)).toBeInTheDocument();
  expect(screen.queryByText(/Load in via alley/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/DrinkPlanSelections.test.js`. Expected: 2 FAIL ("listOnly drops menu design…" and the legacy test, because today's card ignores `listOnly`); the two others pass (they guard what must not change).

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

`NewSelections`' signature (`:28`) becomes `function NewSelections({ plan, sel, cocktails, mocktails, listOnly }) {`. The Menu Design IIFE's opening line (`:132`, `{(() => {`) becomes `{!listOnly && (() => {`.

The Logistics opening (`:159-160`, `{/* Logistics */}` then `<div className="mb-1">`) becomes:

```jsx
      {/* Logistics: not shown in the shopping-list answers panel */}
      {!listOnly && (
      <div className="mb-1">
```

The crowd and guest-preference paragraphs inside Logistics (`:188-198`) become:

```jsx
        {crowdText(sel) && <p className="text-muted">{crowdText(sel)}</p>}
        {guestPreferencesText(sel) && <p className="text-muted">{guestPreferencesText(sel)}</p>}
```

The Logistics closing `</div>` (`:202`) and the blank line after it become:

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

`LegacySelections`' signature (`:248`) becomes `function LegacySelections({ plan, sel, cocktails, listOnly }) {`; its logistics-notes guard (`:293`) `{!listOnly && sel.logisticsNotes && (`; its empty fallback (`:297`) `{!typeName && !sel.spirits?.length && (listOnly || !sel.logisticsNotes) && (`.

- [ ] **Step 4: Run it and the build.** Run the Step 2 command. Expected: 4 pass. Then `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully".

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/DrinkPlanSelections.js client/src/components/DrinkPlanSelections.test.js
git commit -m "feat(answers): a list-only mode for the planner answers card"
```

### Task 7: Pick and label the answer set

**Files:**
- Create: `client/src/components/ShoppingList/answerSets.js`
- Create: `client/src/components/ShoppingList/answerSets.test.js`

**Interfaces:**
- Produces: `hasPlannerAnswers(selections) -> boolean`; `pickAnswerSets(plan, hasConsult) -> { sets: Array<{ key: 'consult'|'planner', at: string|null, submitted: boolean }>, initial: 'consult'|'planner'|null }`; `sourceLine(set) -> string`; `switchLabel(set) -> string`; `listNote(shownKey, listSource, offeredKeys) -> string|null`.

- [ ] **Step 1: Write the failing test.** Create `client/src/components/ShoppingList/answerSets.test.js`:

```js
import { hasPlannerAnswers, pickAnswerSets, sourceLine, switchLabel, listNote } from './answerSets';

const SEL = { activeModules: { signatureDrinks: true }, signatureDrinks: ['margarita'] };
const plan = (o = {}) => ({ selections: SEL, status: 'draft', submitted_at: null, consult_filled_at: null, ...o });

describe('hasPlannerAnswers', () => {
  test('only answers that drive the list count', () => {
    expect(hasPlannerAnswers(SEL)).toBe(true);
    expect(hasPlannerAnswers({ crowd: { drinkers: 50, profile: null } })).toBe(true);
    expect(hasPlannerAnswers({ additionalNotes: 'More tequila' })).toBe(true);
    expect(hasPlannerAnswers({ beerStyles: ['IPA'] })).toBe(true); // legacy v1
  });

  test('a logo, menu design, logistics or nothing at all is no set', () => {
    expect(hasPlannerAnswers({ companyLogo: 'x.png', _logoFilename: 'x.png' })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: { fullBar: true }, menuStyle: 'custom', menuTheme: 'Gatsby' })).toBe(false);
    expect(hasPlannerAnswers({ logistics: { parking: 'street' }, barPlacement: 'outdoors' })).toBe(false);
    expect(hasPlannerAnswers({ crowd: { drinkers: null, profile: null }, spirits: [], additionalNotes: '  ' })).toBe(false);
    expect(hasPlannerAnswers({})).toBe(false);
    expect(hasPlannerAnswers([])).toBe(false);
    expect(hasPlannerAnswers(null)).toBe(false);
  });
});

describe('pickAnswerSets', () => {
  test('consult saved after the planner submit opens on the consult', () => {
    const r = pickAnswerSets(plan({ status: 'submitted', submitted_at: '2026-09-20T15:00:00Z', consult_filled_at: '2026-10-02T15:00:00Z' }), true);
    expect(r.sets.map((s) => s.key)).toEqual(['consult', 'planner']);
    expect(r.initial).toBe('consult');
  });

  test('a planner submitted after the consult opens on the planner', () => {
    const r = pickAnswerSets(plan({ status: 'submitted', submitted_at: '2026-09-25T15:00:00Z', consult_filled_at: '2026-09-20T15:00:00Z' }), true);
    expect(r.initial).toBe('planner');
  });

  test('an unsubmitted planner never beats a consult', () => {
    const r = pickAnswerSets(plan({ consult_filled_at: '2026-01-01T15:00:00Z' }), true);
    expect(r.initial).toBe('consult');
    expect(r.sets[1]).toEqual({ key: 'planner', at: null, submitted: false });
  });

  test('a tie, or a missing stamp on either side, goes to the consult', () => {
    const at = '2026-09-25T15:00:00Z';
    expect(pickAnswerSets(plan({ status: 'submitted', submitted_at: at, consult_filled_at: at }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ status: 'submitted', submitted_at: at, consult_filled_at: null }), true).initial).toBe('consult');
  });

  test('a submitted status with no stamp counts as submitted, with no date', () => {
    const r = pickAnswerSets(plan({ status: 'reviewed', submitted_at: null, consult_filled_at: '2026-10-02T15:00:00Z' }), true);
    expect(r.sets[1]).toEqual({ key: 'planner', at: null, submitted: true });
    expect(r.initial).toBe('consult');
  });

  test('one set alone opens on itself; neither is the empty case', () => {
    expect(pickAnswerSets(plan(), false)).toEqual({ sets: [{ key: 'planner', at: null, submitted: false }], initial: 'planner' });
    expect(pickAnswerSets(plan({ selections: null }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ selections: { companyLogo: 'x' } }), false)).toEqual({ sets: [], initial: null });
    expect(pickAnswerSets(null, true)).toEqual({ sets: [], initial: null });
  });
});

describe('copy', () => {
  test('source lines and switch labels carry the Chicago day', () => {
    expect(sourceLine({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('From the consult, Oct 2');
    expect(sourceLine({ key: 'planner', at: '2026-09-25T15:00:00Z', submitted: true })).toBe('From the planner, submitted Sep 25');
    expect(sourceLine({ key: 'planner', at: null, submitted: false })).toBe('From the planner, not submitted');
    expect(switchLabel({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('Consult · Oct 2');
    expect(switchLabel({ key: 'planner', at: '2026-09-25T15:00:00Z', submitted: true })).toBe('Planner · Sep 25');
    expect(switchLabel({ key: 'planner', at: null, submitted: false })).toBe('Planner · not submitted');
  });

  test('a missing stamp drops the date, never prints a placeholder', () => {
    expect(sourceLine({ key: 'consult', at: null, submitted: true })).toBe('From the consult');
    expect(sourceLine({ key: 'planner', at: null, submitted: true })).toBe('From the planner, submitted');
    expect(switchLabel({ key: 'consult', at: null, submitted: true })).toBe('Consult');
    expect(switchLabel({ key: 'planner', at: null, submitted: true })).toBe('Planner · submitted');
  });

  test('an evening stamp reads as its Chicago day, not the UTC day', () => {
    // 2026-10-03T02:30Z is 9:30 PM on Oct 2 in Chicago.
    expect(sourceLine({ key: 'consult', at: '2026-10-03T02:30:00Z', submitted: true })).toBe('From the consult, Oct 2');
  });

  test('the list note names the set that built the list, or says it had no answers', () => {
    const both = ['consult', 'planner'];
    expect(listNote('planner', 'consult', both)).toBe('This list was built from the consult.');
    expect(listNote('consult', 'planner', both)).toBe('This list was built from the planner.');
    expect(listNote('consult', 'consult', both)).toBeNull();
    expect(listNote('planner', null, both)).toBeNull();
    expect(listNote('planner', 'something-else', both)).toBeNull();
    expect(listNote('planner', 'consult', ['planner'])).toBe('This list was built from a consult with no drink answers.');
    expect(listNote(null, 'planner', [])).toBe('This list was built from a planner with no drink answers.');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList/answerSets.test.js`. Expected: FAIL (`Cannot find module './answerSets'`).

- [ ] **Step 3: Implement.** Create `client/src/components/ShoppingList/answerSets.js`:

```js
import { fmtDate, ctDay } from '../adminos/format';

// Which of a drink plan's two answer sets the shopping-list modal's answers
// panel offers, and which it opens on (spec 2026-10-06, decisions 3 to 5).
// The consult counts from its last save (consult_filled_at is stamped on every
// save); the planner counts from its submit. The planner opens first only when
// both stamps are known and the planner's is strictly later: an unsubmitted
// draft never beats a consult, and a tie or a missing stamp goes to the consult.

// The planner keys that drive the shopping list: what DrinkPlanSelections
// renders in listOnly mode, plus the legacy v1 keys. A planner holding only a
// logo (companyLogo / _logoFilename, merged in by the upload), menu-design or
// logistics answers is no answer set.
const DRINK_ANSWER_KEYS = [
  'signatureDrinks', 'customCocktails', 'mocktails', 'mocktailNotes',
  'spirits', 'spiritsOther', 'beerFromFullBar', 'wineFromFullBar', 'wineOtherFullBar',
  'beerWineBalanceFullBar', 'beerFromBeerWine', 'wineFromBeerWine', 'wineOtherBeerWine',
  'beerWineBalanceBeerWine', 'syrupSelections', 'syrupSelfProvided', 'addOns',
  'crowd', 'guestPreferences', 'additionalNotes',
  'signatureCocktails', 'barFocus', 'wineStyles', 'beerStyles', 'beerWineBalance',
  'beerWineNotes', 'fullBarNotes',
];

function hasValue(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number' || v === true) return true;
  if (v && typeof v === 'object') return Object.values(v).some(hasValue);
  return false;
}

export function hasPlannerAnswers(selections) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return false;
  return DRINK_ANSWER_KEYS.some((k) => hasValue(selections[k]));
}

const SUBMITTED_STATUSES = new Set(['submitted', 'reviewed']);

// hasConsult: the consult GET returned non-empty recap lines (a consult saved
// with nothing to say is no set at all).
export function pickAnswerSets(plan, hasConsult) {
  const sets = [];
  if (!plan) return { sets, initial: null };
  if (hasConsult) {
    sets.push({ key: 'consult', at: plan.consult_filled_at || null, submitted: true });
  }
  if (hasPlannerAnswers(plan.selections)) {
    const submitted = Boolean(plan.submitted_at) || SUBMITTED_STATUSES.has(plan.status);
    sets.push({ key: 'planner', at: plan.submitted_at || null, submitted });
  }
  if (sets.length === 0) return { sets, initial: null };
  if (sets.length === 1) return { sets, initial: sets[0].key };
  const [consult, planner] = sets;
  const plannerLater = planner.submitted && Boolean(planner.at) && Boolean(consult.at)
    && new Date(planner.at).getTime() > new Date(consult.at).getTime();
  return { sets, initial: plannerLater ? 'planner' : 'consult' };
}

const day = (ts) => fmtDate(ctDay(ts));

// "From the consult, Oct 2" / "From the planner, submitted Sep 25" /
// "From the planner, not submitted"; a missing stamp drops the date.
export function sourceLine(set) {
  if (!set) return '';
  if (set.key === 'consult') return set.at ? `From the consult, ${day(set.at)}` : 'From the consult';
  if (!set.submitted) return 'From the planner, not submitted';
  return set.at ? `From the planner, submitted ${day(set.at)}` : 'From the planner, submitted';
}

// The switch's own label for each side.
export function switchLabel(set) {
  if (set.key === 'consult') return set.at ? `Consult · ${day(set.at)}` : 'Consult';
  if (!set.submitted) return 'Planner · not submitted';
  return set.at ? `Planner · ${day(set.at)}` : 'Planner · submitted';
}

// One line naming the set the list was built from, when the panel is showing
// the other one, or when the set that built it holds no drink answers.
export function listNote(shownKey, listSource, offeredKeys = []) {
  if (listSource !== 'consult' && listSource !== 'planner') return null;
  if (!offeredKeys.includes(listSource)) {
    return `This list was built from a ${listSource} with no drink answers.`;
  }
  if (shownKey && shownKey !== listSource) return `This list was built from the ${listSource}.`;
  return null;
}
```

- [ ] **Step 4: Run it and the build.** Run the Step 2 command. Expected: 12 pass. Then `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully" (the module is unused until Task 8; CRA does not lint an unreferenced file into a failure).

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/answerSets.js client/src/components/ShoppingList/answerSets.test.js
git commit -m "feat(answers): pick the newest answer set and label it"
```

### Task 8: The Client's answers panel

**Files:**
- Create: `client/src/components/ShoppingList/ClientAnswersPanel.jsx`
- Create: `client/src/components/ShoppingList/ClientAnswersPanel.test.jsx`

**Interfaces:**
- Consumes: `GET /api/drink-plans/:id/consult` `recap` (Task 4); `GET /api/cocktails/admin`, `GET /api/mocktails/admin`; `DrinkPlanSelections` `listOnly` (Task 6); `pickAnswerSets`, `sourceLine`, `switchLabel`, `listNote` (Task 7).
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
  status: 'draft',
  selections: PLANNER,
  submitted_at: null,
  has_consult_selections: false,
  consult_filled_at: null,
  shopping_list_source: 'planner',
  ...o,
});

// CRA resetMocks wipes implementations before every test, so each test mocks.
// consultBody defaults to the current server's shape ({ recap }).
function mockApi(p, { recap = null, consultBody, failUrl = null } = {}) {
  api.get.mockImplementation((url) => {
    if (url === failUrl) return Promise.reject(new Error('boom'));
    if (url === `/drink-plans/${p.id}`) return Promise.resolve({ data: p });
    if (url === '/cocktails/admin') return Promise.resolve({ data: { cocktails: COCKTAILS } });
    if (url === '/mocktails/admin') return Promise.resolve({ data: { mocktails: [] } });
    if (url === `/drink-plans/${p.id}/consult`) return Promise.resolve({ data: consultBody || { recap } });
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
    status: 'submitted',
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

test('a consult with nothing to say that built the list: the planner shows alone, with the note', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: null });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the planner, not submitted')).toBeInTheDocument();
  expect(screen.getByText('This list was built from a consult with no drink answers.')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Which answers' })).not.toBeInTheDocument();
});

test('a server older than this panel (no recap key) is the error state, never "no answers"', async () => {
  mockApi(plan({ selections: null, has_consult_selections: true, shopping_list_source: 'consult' }), {
    consultBody: { consult_selections: { barType: 'full_bar' } },
  });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText("Couldn't load the client's answers.")).toBeInTheDocument();
  expect(screen.queryByText('No planner or consult answers yet.')).not.toBeInTheDocument();
});

test('a failed catalog read is an error with Retry, never a planner view missing its drinks', async () => {
  const p = plan();
  mockApi(p, { failUrl: '/mocktails/admin' });
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
import { pickAnswerSets, sourceLine, switchLabel, listNote } from './answerSets';

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
        // catalogs, so a missing catalog would silently drop the client's
        // drinks. The admin catalogs carry retired drinks too and sit behind
        // admin auth, off the public read limiter.
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          api.get(`/drink-plans/${planId}`),
          api.get('/cocktails/admin'),
          api.get('/mocktails/admin'),
        ]);
        const plan = planRes.data;
        let recap = null;
        if (plan.has_consult_selections) {
          const body = (await api.get(`/drink-plans/${planId}/consult`)).data || {};
          // A server older than this panel answers without `recap`: an error,
          // never "no answers" beside a list the consult built.
          if (!Object.prototype.hasOwnProperty.call(body, 'recap')) {
            throw new Error('consult GET carries no recap');
          }
          recap = Array.isArray(body.recap) && body.recap.length > 0 ? body.recap : null;
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
  const note = ready
    ? listNote(shown, data.plan.shopping_list_source, data.sets.map((s) => s.key))
    : null;

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

- [ ] **Step 4: Run it and the build.** Run the Step 2 command. Expected: 8 pass. Then `cd client && CI=true npx react-scripts build`. Expected: "Compiled successfully".

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/ClientAnswersPanel.jsx client/src/components/ShoppingList/ClientAnswersPanel.test.jsx
git commit -m "feat(answers): the Client's answers panel"
```

### Task 9: Mount the panel, style it, document it, see it, review, merge

**Files:**
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx:24`, `:57`, `:503-507`, `:544`, `:590`, `:696`
- Modify: `client/src/index.css` (insert after `:8831`)
- Modify: `README.md:632`, `README.md:725` (Key Features), `ARCHITECTURE.md:1648`

**Interfaces:**
- Consumes: `ClientAnswersPanel`, `readAnswersOpen`, `writeAnswersOpen` (Task 8).

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

Give the container (`:503`) its width classes and drop its inline `maxWidth: 960,` (`:507`), so a class can widen it:

```jsx
      <div className={showAnswers ? 'sl-modal-box sl-modal-box--answers' : 'sl-modal-box'} style={{
        backgroundColor: 'var(--bg-elev)',
        margin: '0 auto 1.5rem',
        width: '100%',
```

(the lines after `width: '100%',` stay exactly as they are).

After the Editor / Client view toggle's closing `</div>` (`:544`, the line after `<button onClick={() => setMode('preview')} style={segBtn(mode === 'preview')}>Client view</button>`) add:

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

Immediately before the locked banner (`        {locked && (`, `:590`) add:

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

Leave the wrapped lines' indentation as it is (JSX ignores it; re-indenting 100 lines would bury the change). `wc -l` must read 955.

- [ ] **Step 2: Style it.** In `client/src/index.css`, insert after the `.doc-preview-empty` rule (ends `:8831`), before `/* ─── Menu Samples Modal ─── */`:

```css
/* ─── Shopping list: the client's answers panel (spec 2026-10-06) ─── */
html[data-app="admin-os"] .sl-modal-box {
  max-width: 960px;
}
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
@media (min-width: 1200px) {
  html[data-app="admin-os"] .sl-modal-box--answers {
    max-width: min(1280px, calc(100vw - 2rem));
  }
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
    max-height: 40vh;
    margin: 1rem 1.25rem 0;
  }
}
```

- [ ] **Step 3: Docs.** `README.md:632` (the `ShoppingList/` tree line): append " + ClientAnswersPanel (the client's newest planner or consult answers beside the list, with a view-only switch; answerSets.js picks and labels the set)". `README.md` Key Features (`:725`): add a bullet "**Client's answers beside the shopping list**: the shopping-list modal shows the newest planner or consult answers that drive the list, with a view-only switch between the two." `ARCHITECTURE.md:1648` (the `ShoppingListModal.jsx` bullet): append "A Show answers / Hide answers header toggle (remembered per browser) opens `ClientAnswersPanel` beside the list." and add after that bullet:

```markdown
- **`ClientAnswersPanel.jsx`** + **`answerSets.js`** — The client's answers that drive the list, from the newest set (consult by its last save, planner by its submit; an unsubmitted planner never beats a consult), with a view-only Consult / Planner switch and a one-line note when the shown set did not build the list or the set that built it holds no drink answers. Planner answers render through `DrinkPlanSelections` with `listOnly` against the admin catalogs (`/api/cocktails/admin`, `/api/mocktails/admin`, retired drinks included); consult answers are the `recap` lines from `GET /api/drink-plans/:id/consult`, and a response without `recap` is the error state. Reads only; rebuilding the list from the other set stays on the plan page's source switch.
```

- [ ] **Step 4: Gates.** `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList src/components/DrinkPlanSelections.test.js` (all pass, NeedsRecipeSection included). `npm run check:css-scope` (exit 0). `npm run check:filesize` (exit 0; it lists the modal in its 700-1000 band at 955). `cd client && CI=true npx react-scripts build` ("Compiled successfully").

- [ ] **Step 5: Commit (lane checkpoint).**

```bash
git add client/src/components/ShoppingList/ShoppingListModal.jsx client/src/index.css README.md ARCHITECTURE.md
git commit -m "feat(answers): the answers panel beside the shopping list"
```

- [ ] **Step 6: Dev data.** Plan 19 holds both sets and a list (dev, 2026-10-06). For the finalized view, no dev plan is finalized with a list: on `br-delicate-union-adt2hvor`, `SELECT finalized_at, finalized_by FROM drink_plans WHERE id = 19` (save to `$SCRATCH`), then `UPDATE drink_plans SET finalized_at = NOW() WHERE id = 19` for the one check in Step 7, restored in Step 8. Start the lane's dev servers (the recipe above) and sign in as admin user 1.

- [ ] **Step 7: See it** (Playwright, screenshots kept for the review):
  - **1440px, House Lights, `http://localhost:3001/drink-plans/19`, Shopping List:** the panel sits right of the list, titled "Client's answers", the switch reads "Consult · <day>" and "Planner · <day or not submitted>", the consult lines print drink names. Scroll the list: the panel stays in view. Click Planner: the planner answers show with no Menu Design and no Logistics, and the list note appears. Switch Editor ↔ Client view: the panel stays.
  - **Hide answers:** the modal returns to today's 960px layout with no panel. Close, reload, reopen: still hidden. Show answers: back.
  - **1200px:** two columns, the modal stops 1rem short of each edge.
  - **1024px:** the panel stacks above the list at full width, capped near 40% of the viewport height with its own scroll.
  - **After Hours skin** at 1440px and 1024px: the panel's text, switch and note are readable.
  - **The event page** (`/events/<proposal_id of plan 19>`) at 1440px and 1024px, both skins, and **the proposal page** (`/proposals/<same id>`) at 1440px, House Lights: Shopping List from the drink plan card shows the same panel.
  - **The plan page's own Selections card** still shows Menu Design and Logistics.
  - **Finalized** (plan 19 with `finalized_at` set): the read-only Client view shows the panel.
  - **Every time:** no console errors; the panel issues only GETs (the plan, the two admin catalogs, plus the consult when `has_consult_selections`), never PUT/POST/PATCH.

- [ ] **Step 8: Restore dev and stop the servers.** `UPDATE drink_plans SET finalized_at = <saved>, finalized_by = <saved> WHERE id = 19`. Stop only :5001 and :3001; delete `client/.env.development.local`.

- [ ] **Step 9: Review seats.** Handoff file `$SCRATCH/sl-client-answers-review.md` (commit list, stat, `-U10` diff, suite counts, screenshot paths, spec section 3.4 as the ui-ux benchmark). Dispatch code-review, ui-ux-review and consistency-check (the `recap` contract: `string[] | null`, null for an empty consult, absent on an older server) in parallel on Opus with their `.claude/agents/<seat>.md` instructions inlined. A failed or incomplete reviewer is never a pass. Fix every real finding test-first and re-confirm.

- [ ] **Step 10: Merge.** From `os` (clean tree): `scripts/merge-lane.sh sl-client-answers docs/superpowers/plans/2026-10-06-shopping-list-client-answers.md sl-client-answers`. Re-run `cd client && CI=true npx react-scripts test --watchAll=false src/components/ShoppingList` on main. `npm run worktree:rm -- sl-client-answers` and a board line. On main: delete the Potions entry "Planner answers beside the shopping list", mark item 8 of the 2026-09-22 drop SHIPPED with the squash sha, and add the walk to `docs/walkthroughs-owed.md` (open a list from the plan page and the event page, flip the switch, hide and show the panel).

## As built (2026-10-06)

- **Lane `consult-recap`, merged `7d9a8d38`.** Tasks 1-4 as planned, then one review round (code, consistency, security, performance; all PASS or SAFE on re-check): `consultRecap.dispatch.test.js` pins what the automatic first-save send actually emails (it fails against a dispatch without names); `buildConsultRecap` also guards the formatter (null on an unreadable row, reported) and the Sentry report is itself guarded; the lookup returns `failed: true` and `dispatch` then skips the drift warning, which is capped; wine lines are title-cased like spirits; a separator-only id keeps its raw form. Gate: 14 server suites one at a time, 198 tests, plus the dispatch suite. The client email was rendered on dev plan 451 and read before merge. **Not done:** the staff-card browser check (a dev sign-in was refused by the session's permission policy).
- **Lane `sl-client-answers`, merged `fb9bae0b`.** Tasks 6-9 as planned, then two review rounds (code, consistency on the recap contract, UI/UX static-only; all PASS on re-check): `hasPlannerAnswers` mirrors what the list-only card renders, module flags included; `LegacySelections`' empty line keys on `anyAnswer`, so the plan page no longer prints it under a legacy plan's own answers; the list note reads "This list was built from the {set}, which has no answers to show here" (true for an empty set, an unreadable consult row and planner answers without `activeModules`, 5 prod plans, filed); the toggle is `aria-expanded`; sticky `top: 0` with `max-height: calc(100vh - 60px - 2.5rem)` (the overlay's padding offsets a stuck box); widened box `min(1280px, calc(100% - 2rem))`; narrow query `1199.98px`; muted panel text `--ink-2`; the switch's focus ring inset and its selected segment `--ink-1` with an accent underline; the empty-state note sits in the panel head. Gate: 54 client tests on main, CI build, CSS scope. **Not done:** any rendered check; the visual walk is owed (`docs/walkthroughs-owed.md`, Tier 6).

