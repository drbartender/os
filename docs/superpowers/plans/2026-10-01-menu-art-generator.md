---
spec: docs/superpowers/specs/2026-10-01-menu-art-generator-design.md
designGate: REOPENED 2026-10-09 for the page lane (designer moved into an event-page section, brief v3); server lanes unaffected. Earlier: satisfied by 84aed5bc (spec section 11 amended from artifact version 1790874392-ddd7, snapshot docs/design-artifacts/2026-10-01-menu-designer/menu-designer.html)
lanes:
  - id: menu-art-foundation
    footprint:
      - server/db/schema.sql                         # three tables (spec 6)
      - server/db/schema.menuArt.test.js             # new
      - package.json                                 # openai dependency
      - package-lock.json
      - server/utils/openaiClient.js                 # new (spec 5.1)
      - server/utils/openaiClient.test.js
      - server/utils/storage.js                      # readFile, additive (spec 5.4)
      - server/utils/storage.readFile.test.js        # new
      - server/utils/r2Proxy.js                      # new (spec 7)
      - server/utils/r2Proxy.test.js
      - server/utils/menuFontPairings.js             # new (spec 10.3)
      - server/utils/menuDrinkSource.js              # new (spec 5.2)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuAlsoAtBar.js                # new (spec 5.2)
      - server/utils/menuAlsoAtBar.test.js
      - server/utils/menuDraftValidation.js          # new (spec 7.1)
      - server/utils/menuDraftValidation.test.js
      - server/utils/shoppingListGen.js              # matchCustomNames row + loadRecipeCandidates columns, additive
      - server/utils/shoppingListGen.matchRow.test.js # new
    blockedBy: []
    review: full-fleet   # schema.sql is sensitive-listed; paid-API wrapper
  - id: menu-art-engine
    footprint:
      - server/utils/menuArtCap.js                   # new: reservations under the table lock (spec 5.5)
      - server/utils/menuArtCap.test.js
      - server/utils/menuArtPrompts.js               # new: words, background, drink prompt builders
      - server/utils/menuArtPrompts.test.js
      - server/utils/menuBackgroundTone.js           # new: sharp tone + ground_rgb (spec 5.4)
      - server/utils/menuBackgroundTone.test.js
      - server/utils/menuArtJob.js                   # new: the background job (spec 5.5)
      - server/utils/menuArtJob.test.js
      - server/utils/menuDraftRead.js                # new: GET payload, stuck rule, diff, derived print state
      - server/utils/menuDraftRead.test.js
      - server/routes/proposals/menuDrafts.js        # new (spec 7)
      - server/routes/proposals/menuDrafts.test.js
      - server/routes/proposals/index.js             # mount after menuPrint
      - server/middleware/rateLimiters.js            # two limiters (sensitive-listed)
      - scripts/sensitive-paths.txt                  # spec 13
      - .env.example
      - README.md                                    # env table, tech stack, server folder rows
      - ARCHITECTURE.md                              # tables, integrations, utils, menuDrafts route rows
      - .claude/CLAUDE.md                            # env table, Tech Stack
    blockedBy: [menu-art-foundation]
    review: full-fleet   # rateLimiters + sensitive list + paid API; second-opinion at push
  - id: menu-print-approve
    footprint:
      - server/utils/menuPrintFile.js                # new: setMenuPrintKey + reaccrueDuty (spec 8)
      - server/utils/menuPrintFile.test.js
      - server/routes/proposals/menuPrint.js         # uses the helper; adds admin GET
      - server/routes/proposals/menuPrint.test.js    # extend
      - server/routes/proposals/menuDraftApprove.js  # new: POST /:id/menu-draft/approve
      - server/routes/proposals/menuDraftApprove.test.js
      - server/routes/proposals/index.js             # mount approve
      - ARCHITECTURE.md                              # the two route rows ONLY
    blockedBy: [menu-art-engine]
    review: full-fleet   # reorders the duty-pay trigger; second-opinion at push
  - id: menu-designer-page
    footprint:
      - client/src/pages/admin/menuDesigner/**       # page, panels, canvas, hooks, export, tests
      - client/src/components/AdminMenuPrintBlock.js # Design menu + Download
      - client/src/components/AdminMenuPrintBlock.test.js
      - client/src/pages/admin/EventDetailPage.js    # pass hasDrinks to the card ONLY
      - client/src/App.js                            # /events/:id/menu
      - client/src/index.css                         # md- and mc- blocks
      - client/src/pages/website/legal/PrivacyPage.js # one provider line (decision 10)
      - README.md                                    # client folder rows + Key Features ONLY
    blockedBy: [menu-art-engine]
    review: one-reviewer + ui-ux-review against the artifact snapshot
    note: build and unit-test in parallel with menu-print-approve; its end-to-end walk (Task P6) runs after menu-print-approve is on main
---

# Menu Art Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A designer page per event that generates a custom 8x10 bar menu from the drink plan (OpenAI art under real, editable text), and an Approve that posts it into the existing bar menu print slot.

**Architecture:** Four lanes. Foundation lands the tables and the pure helpers. Engine lands the paid generation job, the cap and the draft routes. Approve extracts the print-slot write into a shared helper and adds the atomic approve route. The page builds the client to the Claude Design artifact. Foundation and engine are serial; approve and page run in parallel after engine.

**Tech Stack:** Node 26 / Express 4 / raw `pg` / R2 via AWS SDK v3 / `sharp` / `openai` (new) / React 18 CRA / `html2canvas` / `node:test` (server) / Jest via react-scripts (client).

**Spec:** `docs/superpowers/specs/2026-10-01-menu-art-generator-design.md`. Every task below names the spec sections it implements. Read those sections before starting the task; this plan does not restate them.

## Global Constraints

- No em dashes in any user-facing copy or code comment written for this feature.
- Raw SQL with `$n` parameters only; `AppError` subclasses or `new AppError(msg, status, CODE)` for client-visible errors (spec 2, Errors).
- No pooled connection is held across an OpenAI or R2 call; a request that needs a transaction opens its client after that work and releases it before `setImmediate` (spec 5.5).
- `openaiClient.js` is the only module that requires `openai`; model ids, sizes, timeouts and caps come from env with the spec 13 defaults.
- Vanilla CSS in `client/src/index.css` only; page classes `md-`, print-canvas classes `mc-`.
- Client API calls through `client/src/utils/api.js` only.
- New files aim under 300 lines; none may exceed 700 without a split.
- Server tests run one suite at a time from the repo root: `node --test <path>`. Read the pass count; a missing `require('dotenv').config()` reads as ECONNREFUSED.
- Client tests: `cd client && CI=true npx react-scripts test --watchAll=false <path>`.
- Commits use explicit pathspecs and `git commit -F - <<'MSG'` (no backticks in messages).
- OpenAI is never called from any test (spec 14). The live smoke (Task E7) is the only real call before Dallas's first use.

## Review Focus

1. **A client-typed drink name with no ASCII letters or digits** ("🍹", "Señorita" is fine, "日本酒" is not) slugs to empty. The slug must fall back to `x` plus the first 8 hex of the name's SHA-1, never `custom:` with an empty slug. Test in Task F4.
2. **A huge brief** (a 3,000-character theme pasted from an email) must not blow up the words prompt. Each brief field is cut to 1,000 characters before it is sent, and art direction is already capped at 500. Test in Task E2.
3. **Every drink hidden,** leaving only "Also at the bar" or nothing, must still lay out, preview and approve. A menu of beer and wine is legitimate. Test in Task P2 (`layouts.js` with 0 drinks) and Task A3 (approve with zero `has_art` pieces).
4. **Google Fonts slow or blocked** must not hang Approve. Each font wait times out at 10 seconds and Approve fails, naming the font. Test in Task P5.
5. **Transparent drink art fringing on a dark background:** the model's alpha edges can leave a light halo on navy or black art. This can't be unit-tested; it is a named check in the live smoke (Task E7) on a dark theme, and if it shows, the drink prompt gains "clean anti-aliased edges, no white outline".

---

## Lane 1: menu-art-foundation

Cut with `npm run worktree:new menu-art-foundation`. No routes yet; nothing user-visible.

### Task F1: the three tables

**Spec:** 6.
**Files:** modify `server/db/schema.sql` (append a block after the menu-print columns); create `server/db/schema.menuArt.test.js`.

- [ ] Write `schema.menuArt.test.js` in the `schema.vaCalling.test.js` style (pure regex over `schema.sql`, plus one live block that runs the DDL twice against the dev DB and checks `information_schema.columns`). Assert every column, default, CHECK and constraint in spec 6, including `UNIQUE (proposal_id)` on `menu_drafts`, `UNIQUE (draft_id, piece_key)` on `menu_draft_pieces`, the `tone` CHECK, the `kind` and `status` CHECKs on `menu_art_calls`, the `created_at` index, and the `update_updated_at_column` trigger on `menu_drafts`.
- [ ] Run it: `node --test server/db/schema.menuArt.test.js`. Expect FAIL.
- [ ] Append the DDL. Shape (complete column lists are in spec 6):

```sql
-- ─── Menu art generator (spec 2026-10-01-menu-art-generator) ───────────────
CREATE TABLE IF NOT EXISTS menu_drafts (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
  drink_plan_id INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL,
  run_id UUID NOT NULL,
  inputs JSONB NOT NULL,
  content JSONB NOT NULL,
  plan_fingerprint JSONB NOT NULL,
  dismissed_plan_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  art_version INTEGER NOT NULL DEFAULT 0,
  approved_version INTEGER,
  approved_art_version INTEGER,
  approved_print_key TEXT,
  approved_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
DROP TRIGGER IF EXISTS update_menu_drafts_updated_at ON menu_drafts;
CREATE TRIGGER update_menu_drafts_updated_at BEFORE UPDATE ON menu_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS menu_draft_pieces (
  id SERIAL PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE,
  piece_key TEXT NOT NULL,
  run_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed')),
  r2_key TEXT,
  error TEXT,
  reroll_note TEXT,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  tone TEXT CHECK (tone IS NULL OR tone IN ('light','dark')),
  ground_rgb TEXT,
  UNIQUE (draft_id, piece_key)
);

CREATE TABLE IF NOT EXISTS menu_art_calls (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  piece_key TEXT,
  run_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('image','text')),
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','ok','failed','released')),
  model TEXT,
  size TEXT,
  error TEXT,
  openai_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_menu_art_calls_created_at ON menu_art_calls (created_at);
```

- [ ] Run the test. Expect PASS. Restart the dev server once so `initDb` applies the block, and confirm the boot log has no schema alert.
- [ ] Commit `server/db/schema.sql server/db/schema.menuArt.test.js`.

### Task F2: `openaiClient.js`

**Spec:** 5.1, 13.
**Files:** `package.json` and `package-lock.json` (`npm install openai` from the lane root; afterwards re-check that the `node_modules` symlink is still a symlink, per the lane-install trap); create `server/utils/openaiClient.js` and its test.

**Interfaces, produced:**

```js
isConfigured()                    // -> boolean (OPENAI_API_KEY set)
draftMenuCopy({ system, user, schema, model })
  // -> { json, requestId }; Responses API structured output, store: false, timeout 60000
generateImage({ prompt, size, quality, outputFormat, background, model })
  // -> { buffer, requestId }; size like '2560x3200'
editImage({ prompt, images: [{ buffer, filename, contentType }], size, quality, outputFormat, background, model })
  // -> { buffer, requestId }
__setTestStub(stub)               // test-only injection; null clears
class OpenAIRefusal extends Error  // .reason (moderation text)
class OpenAIRateLimited extends Error // .retryAfterSec
```

- [ ] Tests:
  - Under `NODE_ENV=test` with no stub, every call rejects with "OpenAI disabled under test" and nothing is constructed.
  - With a stub, calls are forwarded with `maxRetries: 0` and the timeout.
  - A 429 maps to `OpenAIRateLimited` with `retryAfterSec` parsed from the header (default 20, capped 60).
  - A moderation error maps to `OpenAIRefusal`.
  - Any other error rethrows as `ExternalServiceError('openai', ...)`.
  - `isConfigured()` follows the env var.
- [ ] Implement. Build the SDK client lazily on first call with `{ apiKey, maxRetries: 0, timeout }`, using `MENU_ART_IMAGE_TIMEOUT_MS` (default 180000) for image calls. Image calls return `Buffer.from(b64, 'base64')`.
- [ ] Tests pass, then commit.

### Task F3: R2 read-back and the proxy helper

**Spec:** 5.4, 7.
**Files:** `server/utils/storage.js` (add `readFile` to the exports; `uploadFile` and `getSignedUrl` untouched); create `server/utils/storage.readFile.test.js`, `server/utils/r2Proxy.js` and `server/utils/r2Proxy.test.js`.

**Interfaces:**
- `readFile(key, { timeoutMs = 8000 } = {})` returns `{ buffer, contentType }`. It throws `ExternalServiceError('r2', ...)` on a fetch error or a non-OK status, and a `NotFoundError` on 404 so callers can say "missing".
- `sendR2Object(res, key, { filename, disposition = 'inline' })` calls `readFile`, then sets `Content-Type`, `Content-Disposition`, `Cache-Control: private, no-cache` and a weak ETag from `sha256(key).slice(0,32)`, as `eventDetails.js` does.
- `assertKeyUnder(key, prefix)` throws `NotFoundError` unless `key.startsWith(prefix)` and the key contains no `..` and no `//`.

- [ ] Tests:
  - stub global `fetch`: OK, 404, 500 and abort;
  - `getSignedUrl` stubbed through `require.cache`;
  - `assertKeyUnder` cases: a good key, a wrong prefix, `..`, `//`.
- [ ] Implement, pass, commit.

### Task F4: `menuDrinkSource.js` and the matcher row

**Spec:** 5.2 (all bullets), decision 8.
**Files:** `server/utils/shoppingListGen.js` (additive only); create `server/utils/shoppingListGen.matchRow.test.js`, `server/utils/menuDrinkSource.js` and `server/utils/menuDrinkSource.test.js`.

**Interfaces, produced:**

```js
// shoppingListGen.js (additive)
matchCustomNames(customStrings, candidateRows)
  // matched entries gain row: <the candidate row>
loadRecipeCandidates(dbClient)
  // rows gain id, description, kind ('cocktail' | 'mocktail', from src)

// menuDrinkSource.js
loadEventPlan(proposalId, db = pool)
  // -> plan row | null; lowest drink_plans.id; selects selections,
  //    consult_selections, shopping_list_source, id

normalizePlan(plan, { catalogById, candidates })                     // pure
  // -> { side: 'planner' | 'consult',
  //      drinks: [{ key, group: 'sig' | 'mock', source: 'catalog' | 'custom',
  //                 catalog_kind, catalog_id, name, description, typed_name,
  //                 ingredients }],
  //      bar: { beer: [], wine: [], spirits: [], na: [] },
  //      brief: { theme, naming, notes },
  //      plannerImageKey }

buildFingerprint(normalized)
  // -> { drink_keys: [...sorted], brief_hash }

drinkKey(entry)
  // -> 'cocktail:<id>' | 'mocktail:<id>' | 'custom:<slug>'

slugifyTyped(name)
  // -> lowercase a-z0-9 runs joined by '-', trimmed, max 60;
  //    empty -> 'x' + first 8 hex of sha1(name)   (Review Focus 1)

loadCatalogMaps(db)
  // -> { catalogById: Map('cocktail:<id>' | 'mocktail:<id>' -> row),
  //      candidates: loadRecipeCandidates rows }
  // catalog lookups IGNORE is_active
```

- [ ] `matchRow` test: `matched[i].row` is the candidate object, and `name`/`ingredients` are unchanged. Run the existing `server/routes/requestAliases.test.js` and `server/utils/shoppingList.generator.test.js` before and after; both must stay green.
- [ ] `menuDrinkSource.test.js` (pure, fixture objects, no DB). Cover:
  - planner side;
  - consult side: object customs, `customMocktails`, mocktails gated by `mocktailsEnabled` or `barType`, beer boolean, lowercase wine;
  - `shopping_list_source` null means planner;
  - an alias hit becomes a catalog drink;
  - a drink both picked and typed appears once;
  - two typed names with one slug are one drink;
  - an inactive catalog row keeps its description;
  - a missing id becomes client-typed;
  - the order is sig, typed cocktails, mocktails, typed mocktails;
  - brief hash normalization: null equals empty equals whitespace, and internal runs collapse;
  - the emoji-only name fallback (Review Focus 1).
- [ ] Implement, pass, commit.

### Task F5: `menuAlsoAtBar.js` and `menuFontPairings.js`

**Spec:** 5.2 (bar lines), 10.3.
**Files:** create `server/utils/menuAlsoAtBar.js`, its test, and `server/utils/menuFontPairings.js`.

**Interfaces:**
- `buildAlsoAtBar(bar)` returns `[{ label: 'Beer and Wine' | 'Spirits' | 'Non-Alcoholic', text }]`, omitting empty lines. It joins with ", " and ends with ".".
- `FONT_PAIRING_IDS = ['elegant-script','rustic','modern-clean','retro','spooky','tropical']`.

- [ ] Tests: every label in spec 5.2's table, "None" and "Other" dropped, `spiritsOther` appended, consult `beer: true`, the Athletic Brewing line, and an empty bar giving `[]`.
- [ ] Implement, pass, commit.

### Task F6: `menuDraftValidation.js`

**Spec:** 7.1 (every row), 4.5.
**Files:** create `server/utils/menuDraftValidation.js` and its test.

**Interfaces:**
- `validateGenerateInputs(body)` returns `{ planner_image_role, reference_source, art_direction, drb_mark }` or throws `ValidationError(fieldErrors)`.
- `validatePatch({ stored, body })` returns `{ content, inputs }`, the full next objects with only the sent top-level keys replaced, or throws `ValidationError`. It enforces:
  - the drink key set is unchanged;
  - only `display_name`, `description`, `hidden` and `has_art` may change, and editing a name or description sets its AI flag false;
  - `has_art` is at most 8 among visible drinks;
  - at most 12 visible drinks, at most 4 of them without art;
  - `palette` is refused;
  - `words_*` fields are refused;
  - headings are 1 to 40 characters, also-at-bar labels 1 to 30 and text 0 to 120;
  - hex or null for both colors;
  - the font id is in the set;
  - the `text_backing`, `logo_mode` and `logo_badge` enums;
  - `inputs` may change `planner_image_role` and `drb_mark` only.
- `validateRerollNote(note)` caps the note at 200 characters.

- [ ] Tests: one passing and one failing case per spec 7.1 row, plus "omitted keys untouched".
- [ ] Implement, pass, commit.

**Lane 1 exit:** every suite above green, plus `requestAliases.test.js` and `shoppingList.generator.test.js`. Then the full fleet on the lane diff, then merge.

---

## Lane 2: menu-art-engine

Cut after Lane 1 is on main.

### Task E1: the cap and reservations (`menuArtCap.js`)

**Spec:** 5.5 (Daily cap), 12.
**Interfaces:**

```js
reserveImages(client, { proposalId, runId, pieceKeys })
  // inside the caller's open transaction:
  //   LOCK TABLE menu_art_calls IN EXCLUSIVE MODE
  //   count kind = 'image' AND status <> 'released' AND created_at > NOW() - interval '24 hours'
  //   throw new AppError('Daily menu art limit reached.', 429, 'MENU_ART_CAP_REACHED')
  //     when count + pieceKeys.length > cap
  //   insert one 'reserved' row per key; returns ids by key

releaseUnspent(client, { proposalId, runId, pieceKeys? })
  // reserved rows of that run (or of those keys) -> 'released'

markCall(id, status, { error, requestId, model, size })
  // standalone pool.query

logTextCall({ proposalId, runId, status, error, requestId, model })

capUsage(db = pool)
  // -> { used, limit, resets_at }; resets_at = the oldest counted row's created_at + 24h, or null
```

- [ ] Tests (dev DB; clean up rows by a unique `run_id`):
  - the reservation counts;
  - a refusal at the cap writes nothing;
  - `released` rows do not count;
  - two concurrent `reserveImages` transactions at cap minus one: exactly one succeeds;
  - `capUsage`'s `resets_at`.
- [ ] Implement, pass, commit.

### Task E2: prompts (`menuArtPrompts.js`)

**Spec:** 5.1 (payload rule), 5.3, 5.4.
**Interfaces:**
- `wordsRequest({ normalized, eventTypeLabel })` returns `{ system, user, schema }`. The schema is the spec 5.3 JSON schema, with `font_pairing` as an enum of `FONT_PAIRING_IDS`, `palette` up to 6 hex values, and `accent_color` as hex or null.
- `backgroundPrompt({ brief, artDirection })` returns a string.
- `drinkPrompt({ visualNote, rerollNote })` returns a string.
- `parseWords(json, normalized)` returns the content-step fields, with every catalog description forced back to the catalog text. It throws `MenuWordsInvalid` on a missing or extra drink key or a bad type.

- [ ] Tests:
  - the user payload contains none of: the client name, email, phone, venue or address, and the event date (build the fixture with all of them present on the plan row);
  - each brief field is truncated at 1,000 characters (Review Focus 2);
  - the background prompt always contains the no-lettering and calm-center clauses;
  - `parseWords` refuses a missing key and an extra key, and overwrites a model-supplied catalog description.
- [ ] Implement, pass, commit.

### Task E3: background tone (`menuBackgroundTone.js`)

**Spec:** 5.4 (Background tone), 12.
**Interface:** `readTone(buffer)` returns `{ tone: 'light' | 'dark', ground_rgb: 'r,g,b' }` or `{ tone: null, ground_rgb: null }` on any `sharp` error. It crops the central 60% and uses `stats()` channel means; dark means sRGB relative luminance below 0.4.

- [ ] Tests on generated fixtures (`sharp({ create: ... })`): navy gives dark, cream gives light, garbage bytes give nulls.
- [ ] Implement, pass, commit.

### Task E4: the job (`menuArtJob.js`)

**Spec:** 5.3, 5.4, 5.5 (The job, Re-roll, Retries, Refusals, Errors), 6 (Writers).
**Interfaces:**

```js
runGeneration({ draftId, runId, proposalId })
  // never throws; schedule with setImmediate

runPieceReroll({ draftId, pieceKey, pieceRunId, proposalId })

runWordsForDrinks({ normalizedDrinks, brief, eventTypeLabel })
  // -> per-drink words; used by sync (E6) inside a request, before its transaction
```

**Behavior, each item testable:**
- Before each OpenAI call:
  - re-read the draft's `run_id` (or the piece's) and stop if it moved;
  - refresh the active piece's heartbeat and the heartbeats of the run's remaining pending pieces in one UPDATE;
  - `markCall(..., 'sent')`.
- **Words:** `draftMenuCopy` then `parseWords`. On success, one conditional UPDATE writes the content fill plus `words_status = 'done'`. On failure it writes `words_status = 'failed'` and `words_error`.
- **Background:** `generateImage` or `editImage` (when a reference exists, read with `readFile`); upload to R2 under spec 6's key; `readTone`; piece `done` with `tone` and `ground_rgb`; `art_version + 1`.
- **Drinks** (sequential, `has_art` only): `editImage` with the background (downscaled with `sharp` to 1024 wide) plus the reference; transparent PNG; upload; `done`; `art_version + 1`.
- **Retries:** `OpenAIRateLimited` waits `retryAfterSec`, refreshing the heartbeat while it waits, at most 2 times. Every other error fails the piece with no retry. `OpenAIRefusal` stores its `reason`.
- **The `finally` sweep:** every `pending` or `working` piece of this run becomes `failed` with "not attempted: <cause>" (conditional on `run_id`); `releaseUnspent`; `Sentry.captureException` with `{ area: 'menuArt', step }` on any unexpected error.
- **Connections:** standalone `pool.query` everywhere; no client held.

- [ ] Tests (dev DB fixtures; the stub is injected through `__setTestStub`; R2 is stubbed through `require.cache`):
  - happy path: words, background and two drinks done, `art_version` 3;
  - a words failure leaves every piece failed "not attempted";
  - a 429 then success;
  - a 500 fails without retry;
  - a refusal reason is stored;
  - the run is superseded mid-run (the test swaps `run_id` after the background): no further stub calls and no writes;
  - a re-roll of one piece;
  - the reservation rows end `ok`, `failed` or `released`.
- [ ] Implement, pass, commit.

### Task E5: the read model (`menuDraftRead.js`)

**Spec:** 5.5 (Stuck rule), 8 (Derived print state), 9.
**Interfaces:**
- `stuck(row, now, staleMs)` returns a boolean.
- `readDraftPayload(proposalId)` returns the spec 7 GET payload: `{ draft, pieces, brief, diff: { added, dropped, brief_edited, dismissed }, print: { state, approved_at }, cap, configured, plan }`. Stuck pieces and the words step are reported `failed` / "interrupted". `diff.dismissed` is true when the current plan hash equals `dismissed_plan_hash`.

- [ ] Tests:
  - the stuck boundary at `MENU_ART_STALE_MS`, for pending and working;
  - every derived print state in spec 8 (approved, edited by `version`, edited by `art_version`, replaced, removed, no menu needed);
  - the diff, added and dropped;
  - brief edited only;
  - dismissed until the plan changes again;
  - no plan.
- [ ] Implement, pass, commit.

### Task E6: the routes (`menuDrafts.js`) and limiters

**Spec:** 7 (every row except approve and the admin GET, which are Lane 3), 5.5 (Generate, Re-roll), 9, 3 (decision 9).
**Files:** create `server/routes/proposals/menuDrafts.js` and `server/routes/proposals/menuDrafts.test.js`; add `menuDraftReadLimiter` (120/min) and `menuDraftEditLimiter` (30/min) to `rateLimiters.js`, keyed `menudraft-r-<userId>` and `menudraft-e-<userId>`; mount with `router.use('/', require('./menuDrafts'))` right after `menuPrint` in `server/routes/proposals/index.js`.

**Route behavior** (every route: `auth`, `requireAdminOrManager`, `asyncHandler`, integer `:id`, proposal 404, and 503 `MENU_ART_NOT_CONFIGURED` before any OpenAI work):

- **`GET /:id/menu-draft`:** `readDraftPayload`.
- **`POST /:id/menu-draft/generate`:**
  1. `validateGenerateInputs`.
  2. `loadEventPlan` and `normalizePlan`; 422 `MENU_NO_DRINKS` on no plan or zero drinks.
  3. Upload an attached reference first (the upload checks in spec 7). Start over carries `reference_key` forward when nothing is attached and the source is unchanged.
  4. Then one client transaction: upsert in place (`INSERT ... ON CONFLICT (proposal_id) DO UPDATE`), new `run_id`, `version + 1`, content reset to `{ words_status: 'pending', words_heartbeat_at: now }`, `releaseUnspent` for the old run, delete the old pieces, insert pending pieces (the background plus the first 8 drinks), `reserveImages`, COMMIT.
  5. Release, return 202, then `setImmediate(runGeneration)`.
- **`PATCH /:id/menu-draft`:** `validatePatch` against the stored row, then `UPDATE ... SET content, inputs, version = version + 1 WHERE proposal_id = $1 AND version = $2 RETURNING version`; no row means 409 `MENU_DRAFT_CHANGED`. Editing is refused with 409 while `words_status` is not `done`.
- **`POST /:id/menu-draft/pieces/:pieceKey/reroll`:** pattern-check the key (spec 7) and `validateRerollNote`. In one transaction: lock the piece row; 409 `MENU_ART_PIECE_BUSY` when it is working and not stuck; `reserveImages` for one; set a new piece `run_id`, `pending`, the note and a fresh heartbeat (creating the row for a `has_art` drink that has none); COMMIT. Return 202, then `setImmediate(runPieceReroll)`.
- **`POST /:id/menu-draft/sync`** (spec 7 row, 9):
  1. Recompute the diff.
  2. `runWordsForDrinks` for added client-typed drinks, before the transaction.
  3. One transaction: version check; append the added drinks (`has_art` while fewer than 8 visible have art); remove the dropped drinks from `content` and delete their pieces; set `plan_fingerprint`; clear `dismissed_plan_hash`; `reserveImages` for the added drinks with art; `version + 1`; COMMIT.
  4. Return 202, then queue `runPieceReroll` for each.
- **`POST /:id/menu-draft/dismiss-plan-change`:** stores the current plan hash under the version check.
- **The three image `GET`s:** `assertKeyUnder`, then `sendR2Object`. The piece prefix is `menu-art/<id>/`, the reference prefix `menu-art/<id>/ref-`, and the planner prefix `drink-plan-logos/<planId>-`.

- [ ] Tests (the `menuPrint.test.js` harness style: a real router, real `express-fileupload`, hand-built multipart, R2 and `openaiClient` stubbed). Cover every spec 14 Routes bullet that is not approve:
  - auth: no token, staff and manager;
  - generate: 503 with no key; 422 with no plan and with no drinks; 429 at cap; two concurrent generates (exactly one run survives, and the superseded job makes no further call);
  - PATCH: 409 on a version mismatch; 409 before the words land; key-set change refused; more than 8 `has_art` refused; more than 12 visible refused; more than 4 visible without art refused; `palette` refused; pieces untouched;
  - re-roll: busy, then stuck, allowed;
  - sync: adds, removes, version 409;
  - dismiss;
  - every key guard.
- [ ] Implement, pass, commit.

### Task E7: docs, lists, live smoke

**Spec:** 13, 14 (Live smoke), 16.
**Files:** `.env.example`, `README.md` (env table, tech stack, server folder rows), `ARCHITECTURE.md` (the three tables, OpenAI under integrations, the new utils, the `menuDrafts` route rows), `.claude/CLAUDE.md` (env table, Tech Stack), `scripts/sensitive-paths.txt` (the four paths in spec 13, with a one-line reason each).

- [ ] Write the docs. Run `node scripts/sensitive-match.js server/utils/openaiClient.js server/routes/proposals/menuDrafts.js` and confirm both match.
- [ ] **Live smoke on dev:**
  1. Put the box key in `server/.env` as `OPENAI_API_KEY` (from `~/.secrets/openai_api_key`) and restart the dev server.
  2. With curl and an admin dev JWT, `POST /api/proposals/<a dev proposal with a custom-menu plan>/menu-draft/generate`.
  3. Poll `GET` until nothing is pending.
  4. Record the wall-clock time, every piece's status, the background's `tone`, and whether any drink PNG shows a light fringe when composited on a dark ground (Review Focus 5: composite one with `sharp` onto `#121b35` and look at it).
  5. Read the run's cost on OpenAI's usage page, or note that it was unavailable, and record it in the lane's merge notes.
  6. If the account refuses with "verify organization" or billing, stop and tell Dallas.
- [ ] Commit the docs.

**Lane 2 exit:** every Lane 2 suite plus the Lane 1 suites green. Then the full fleet, then merge.

---

## Lane 3: menu-print-approve

Cut after Lane 2 is on main. Runs in parallel with Lane 4.

### Task A1: `menuPrintFile.js`, and the manual route keeps its order

**Spec:** 8 (Shared helper, the manual upload).
**Interfaces:**
- `setMenuPrintKey(executor, proposalId, key)` returns `{ rowCount }`. It runs the existing UPDATE verbatim and throws `NotFoundError('Proposal not found.')` on 0 rows.
- `reaccrueDuty(proposalId)` is moved verbatim from `menuPrint.js`, `setImmediate` and Sentry tags included.

- [ ] Tests: the executor is honored (pass a stub executor and assert the SQL and params); 0 rows throws; `reaccrueDuty` schedules exactly one `maybeReaccrueForDuty` call (stub through `require.cache`).
- [ ] Refactor `menuPrint.js` POST to: R2 upload, then `setMenuPrintKey(pool, ...)`, then `reaccrueDuty`. DELETE keeps calling `reaccrueDuty`, now imported. `menuPrint.js` still requires `storage` itself.
- [ ] Run `node --test server/routes/proposals/menuPrint.test.js`, `server/routes/eventDetails.test.js`, `server/utils/dutyLines.test.js` and `server/routes/beo.test.js`. All must stay green with no test edits.
- [ ] Commit.

### Task A2: admin download, `GET /api/proposals/:id/menu-print`

**Spec:** 7 (last row), 1 (the fix-list item).
- [ ] Extend `menuPrint.test.js`: 404 with no file; 200 streams through the stubbed `readFile` with an attachment disposition `bar-menu-<id>.<ext>`; prefix guard; staff refused.
- [ ] Implement with `assertKeyUnder(key, 'menu-print/<id>/')` and `sendR2Object(..., { disposition: 'attachment' })`, using `menuDraftReadLimiter`.
- [ ] Commit.

### Task A3: approve (`menuDraftApprove.js`)

**Spec:** 8 (Approve 2 to 4), 12, 14 (Approve bullets).
**Files:** create `server/routes/proposals/menuDraftApprove.js` and its test; mount it after `menuDrafts` in `server/routes/proposals/index.js`.

**Behavior:**
1. Multipart `file` plus `version` and `art_version` (integers).
2. JPEG magic bytes, then `sharp(buffer).metadata()` must be exactly 2400 x 3000.
3. R2 upload to `menu-print/<id>/<uuid>.jpg` before any transaction.
4. Then one client transaction:
   - `SELECT version, art_version, id FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE`;
   - 409 `MENU_DRAFT_CHANGED` when either version differs;
   - 409 when any piece the layout uses (the background plus every visible `has_art` drink) is not `done`. Zero illustrated drinks is allowed (Review Focus 3);
   - `setMenuPrintKey(client, ...)`;
   - stamp `approved_*` with the POSTED versions and the new key;
   - `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'menu_approved', 'admin', $2, $3)` with `{ draft_id, version, art_version, print_key }`;
   - COMMIT.
5. Release, then `reaccrueDuty(id)`. Respond with the derived print state.

- [ ] Tests:
  - non-JPEG and wrong dimensions refused;
  - a stale `version` and a stale `art_version`, each 409;
  - a not-done piece 409;
  - zero illustrated drinks approves;
  - success sets `menu_print_key`, clears `menu_not_required`, stamps the posted versions and writes the activity row;
  - `reaccrueDuty` is called once and only after COMMIT (stub it and assert the proposal row already shows the new key when the stub runs);
  - a re-roll after approval reads as edited since approval through `readDraftPayload`;
  - auth.
- [ ] Implement, pass, commit. Update `ARCHITECTURE.md`'s route rows for the approve and admin GET routes.

**Lane 3 exit:** the A suites plus `menuPrint`, `eventDetails`, `beo`, `dutyLines` and `menuDrafts` green. Then the full fleet, then merge.

---

## Lane 4: menu-designer-page

Cut after Lane 2 is on main. Runs in parallel with Lane 3. Owns visual fidelity: work from `docs/design-artifacts/2026-10-01-menu-designer/menu-designer.html` (open it in a browser) and spec section 11, number for number.

### Task P1: pairings, colors, and the canvas

**Spec:** 11.2, table P, 11.3, 10.3.
**Files:** `client/src/pages/admin/menuDesigner/fontPairings.js` (the table P data; ids match `FONT_PAIRING_IDS`; a comment maps the design keys), `menuColors.js` (`resolveColors({ pairing, tone, ink, accent })`), `MenuCanvas.js`, `markGlyph.js` (the `MARKGLYPH` and `ORN` paths), `softBacking.js` (`drawSoftBacking(groundRgb)` to a data URL through an offscreen canvas), and the `mc-` CSS block in `index.css`.

- [ ] Tests:
  - `resolveColors`: tone dark picks the dark set, light and null pick the light set, overrides win;
  - `MenuCanvas` renders the title, headings, drinks, More from the bar, Also at the bar and the mark from props (React Testing Library), with no editor affordances when `editable` is false.
- [ ] Implement to the numbers in 11.2: the padding, gaps, slot widths, art-height starts, the 6 px shrink loop with the 65 px floor (run in a `useLayoutEffect` against `scrollHeight`), the one-step type reduction and the "Too long" flagging, the logo sizes and badge, the backings (the Soft backing as an image layer, the Panel backing with no blur), and the mark color by tone.
- [ ] Commit.

### Task P2: `layouts.js`

**Spec:** 11.2 (Rows, Slot width, Art height, More from the bar), Review Focus 3.
**Interfaces:**
- `splitRows(n)` returns the row sizes: `[1]`, `[2]`, `[3]`, `[2,2]`, `[3,2]`, `[3,3]`, `[4,3]`, `[4,4]`, and `[]` for 0.
- `slotWidth(rowLen)` returns 360, 250, 200 or 152.
- `artStart(totalRows)` returns 280, 210, 165 or 130 (130 for 4 or more), with a fallback for 0.
- `partitionDrinks(drinks)` returns `{ sig: [...], mock: [...], more: [...] }`, with visible drinks only and the illustrated ones by group.

- [ ] Pure tests for every count from 0 to 8; `partitionDrinks` with 12 visible (8 illustrated, 4 more) and with all hidden.
- [ ] Implement, pass, commit.

### Task P3: the data hook (`useMenuDraft.js`)

**Spec:** 10.2.
- [ ] Tests (mock `api`):
  - polling runs only while something is pending, working or the words step is pending;
  - a 429 backs off to 10 s;
  - the autosave debounce is 800 ms;
  - a 409 refetches and reports a conflict;
  - `flush()` resolves after an in-flight save;
  - image blobs are cached by `r2_key` and only a changed piece is fetched;
  - object URLs are revoked on replacement and unmount.
- [ ] Implement, pass, commit.

### Task P4: the page, panels and states

**Spec:** 11.1 (all of it), 4, 9.
**Files:** `MenuDesignerPage.js`, `BriefPanel.js`, `DrinkList.js`, `ToolsBar.js`, `Banners.js`, `PreviewColumn.js`, the `md-` CSS block in `index.css`, and the `/events/:id/menu` route in `App.js` (admin guard, beside `/events/:id`, lazy-loaded).

- [ ] Tests (React Testing Library, mocked hook):
  - one test per state in the 11.1 table plus the design's four banners;
  - the Start over confirm copy;
  - the Approve popover copy for each prior file;
  - the tools bar is disabled until the words land;
  - the "AI pick" tag clears after a pairing change;
  - hiding and showing a drink updates "N drinks, M of 8 illustrated".
- [ ] Implement with `StatusChip`, the adminos `Icon` and the existing `.btn` classes per 11.4. Map the tokens per the 11.4 table and check both skins.
- [ ] Commit.

### Task P5: export (`exportMenu.js`) and Approve

**Spec:** 8 (Approve 1), 10.3 (Loading), 11.3, Review Focus 4.
**Interface:** `exportMenu({ draft, images, fonts })` resolves to a JPEG `Blob` at 2400 x 3000. It injects or awaits the font link (10 s timeout), runs `document.fonts.load` for each face (10 s each), and waits for every layer image (10 s each). It renders a hidden unscaled `MenuCanvas` with `editable={false}` through `html2canvas` at scale 3, then `toBlob('image/jpeg', 0.92)`.

- [ ] Tests:
  - a font timeout rejects naming the font;
  - a missing layer rejects naming it;
  - the happy path calls `html2canvas` with scale 3 and returns a JPEG blob (mock `html2canvas`);
  - Approve: `flush()`, then export, then a POST with `version` and `art_version`; a 409 shows the reason banner;
  - Approve is disabled while saving, generating, too long or approving.
- [ ] Implement, pass, commit.

### Task P6: the card, the privacy line, the end-to-end walk

**Spec:** 4.1, 1 (privacy), decision 10, 14 (Visual).
**Files:** `AdminMenuPrintBlock.js` gains **Design menu** (a link to `/events/:id/menu`, shown when `hasDrinks`) and **Download** (shown when ready; it fetches the admin route as a blob and saves it). Add its test. `EventDetailPage.js` passes `hasDrinks`, true when the loaded plan has any drink on its source side. Mirror the server rule in a tiny helper inside `AdminMenuPrintBlock.js`: consult when `shopping_list_source === 'consult'`. `PrivacyPage.js` gets the line `<li>OpenAI, to generate artwork for custom bar menus</li>`. `README.md` gets the client folder rows and Key Features.

- [ ] Card tests: Design menu is hidden without drinks; Download is shown only when ready and calls the admin route.
- [ ] **End-to-end walk** (needs Lane 3 on main; rebase first). On the dev server with the box key:
  1. Generate on a dev event with a custom plan.
  2. Edit a name; re-roll one drink; hide one; switch the pairing and the backing.
  3. Approve.
  4. Download from the card.
  5. Download as staff from the shift page.
  6. Check that the approved state, edited since approval after one more edit, and plan changed (edit the dev plan's drinks) all render.
  7. Check the JPEG is 2400 x 3000 and under 10 MB.
- [ ] Run `ui-ux-review` against the snapshot: both skins and the six board cases in spec 14.
- [ ] Commit.

**Lane 4 exit:** the client suites green and `CI=true npm run build` in `client/` clean (it catches the ESLint warnings Vercel fails on). Then one reviewer plus `ui-ux-review`, then merge.

---

## After all four lanes

- Mark the fix-list item "Admin cannot download the menu print file" shipped (delete it, per the ledger rule) with the Lane 3 squash sha.
- Add a `docs/walkthroughs-owed.md` entry: the first real use on an upcoming custom event, compared with hand-made quality.
- **Push** (Dallas's cue only). Dallas adds `OPENAI_API_KEY` in Render and sets the monthly budget on the OpenAI project first.
