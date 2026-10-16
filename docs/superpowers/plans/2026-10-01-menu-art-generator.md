---
spec: docs/superpowers/specs/2026-10-01-menu-art-generator-design.md
designGate: SATISFIED 2026-10-16 (v3). Spec section 11 rewritten from Claude Design project 89b66aac-dd5f-407d-b026-10b78702ce8a, vendored at docs/design-artifacts/2026-10-01-menu-designer/ (Menu Designer v2.dc.html for the page lane, Menu Phone.dc.html for the phone lane); the printed menu stays on the 2026-10-01 snapshot menu-designer.html (84aed5bc) except the mark. Amended the same day for decisions 11 to 13 (image-model toggle with Gemini, the folded card, the phone follow-up lane).
lanes:
  - id: menu-art-foundation
    footprint:
      - server/db/schema.sql                         # three tables (spec 6)
      - server/db/schema.menuArt.test.js             # new
      - package.json                                 # openai + @google/genai dependencies
      - package-lock.json
      - server/utils/openaiClient.js                 # new (spec 5.1)
      - server/utils/openaiClient.test.js
      - server/utils/geminiClient.js                 # new (spec 5.1, decision 11)
      - server/utils/geminiClient.test.js
      - server/utils/menuKeyOut.js                   # new: magenta key-out for Gemini drinks (spec 5.4)
      - server/utils/menuKeyOut.test.js
      - server/utils/envInt.js                       # new: readEnvInt, shared by the wrappers and the cap (spec 5.5)
      - server/utils/envInt.test.js
      - scripts/sensitive-paths.txt                  # added in the build: openaiClient.js and geminiClient.js listed in the lane that creates them
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
    review: full-fleet   # schema.sql is sensitive-listed; two paid-API wrappers
  - id: menu-art-engine
    footprint:
      - server/utils/menuArtCap.js                   # new: reservations under the table lock (spec 5.5)
      - server/utils/menuArtCap.test.js
      - server/utils/menuArtPrompts.js               # new: words, background, drink prompt builders
      - server/utils/menuArtPrompts.test.js
      - server/utils/menuImageProvider.js            # new: one image call, routed by provider (spec 5.1, 5.4)
      - server/utils/menuImageProvider.test.js
      - server/utils/__fixtures__/gemini-drink-raw.jpg # new: captured in the E7 live smoke
      - server/utils/menuKeyOut.test.js              # E7 adds the real-Gemini regression case only
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
      - server/utils/menuPrintFile.js                # EXISTING (7a1aa28b, sendMenuPrintFile): extend with setMenuPrintKey + reaccrueDuty (spec 8); sendMenuPrintFile untouched
      - server/utils/menuPrintFile.test.js           # new
      - server/routes/proposals/menuPrint.js         # uses the helper (its admin GET shipped 2026-10-06, 7a1aa28b)
      - server/routes/proposals/menuPrint.test.js    # run unchanged; no edits
      - server/routes/proposals/menuDraftApprove.js  # new: POST /:id/menu-draft/approve
      - server/routes/proposals/menuDraftApprove.test.js
      - server/routes/proposals/index.js             # mount approve
      - scripts/sensitive-paths.txt                  # menuPrintFile.js, menuPrint.js, menuDraftApprove.js (spec 13)
      - README.md                                    # server rows: menuDraftApprove.js, menuPrintFile.js exports
      - ARCHITECTURE.md                              # the approve route row and the menuPrintFile.js mentions
    blockedBy: [menu-art-engine]
    review: full-fleet   # reorders the duty-pay trigger; second-opinion at push
  - id: menu-designer-card
    footprint:
      - client/src/pages/admin/menuDesigner/layouts.js            # + .test.js each, below
      - client/src/pages/admin/menuDesigner/fontPairings.js
      - client/src/pages/admin/menuDesigner/menuColors.js
      - client/src/pages/admin/menuDesigner/MenuCanvas.js
      - client/src/pages/admin/menuDesigner/ornament.js
      - client/src/pages/admin/menuDesigner/softBacking.js
      - client/src/pages/admin/menuDesigner/tintedWordmark.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js
      - client/src/pages/admin/menuDesigner/menuCardState.js
      - client/src/pages/admin/menuDesigner/MenuDesignerCard.js
      - client/src/pages/admin/menuDesigner/MenuCardFold.js
      - client/src/pages/admin/menuDesigner/*.test.js
      - client/public/images/menu-mark-avatar.png    # new, byte copy of the vendored assets/dr-bartender-avatar.png
      - client/public/images/menu-mark-wordmark.png  # new, byte copy of the vendored assets/dr-bartender-wordmark.png
      - client/src/components/AdminMenuPrintBlock.js # DELETED: folded into MenuDesignerCard / MenuCardFold (decision 12)
      - client/src/components/AdminMenuPrintBlock.test.js # DELETED after its three Download tests are ported to MenuCardFold.test.js
      - client/src/pages/admin/EventDetailPlanLogo.js # DELETED: folded into MenuCardFold (decision 12)
      - client/src/pages/admin/EventDetailPage.js    # swap the two cards for MenuDesignerCard; useMenuDraft at page level; must not grow
      - client/src/index.css                         # mc- block, md- card block; .admin-plan-logo* rules out
      - client/src/pages/website/legal/PrivacyPage.js # one provider line (decision 10); Generate is reachable from the card
      - client/src/pages/website/legal/PrivacyPage.test.js
      - README.md                                    # client folder rows; old component row out
      - ARCHITECTURE.md                              # the old "Bar menu print card" mention
    blockedBy: [menu-art-engine]
    review: one-reviewer + consistency-check (fold parity with the two deleted cards) + ui-ux-review against docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html, Event page view, every table C state, both skins, and the printed menu against the 2026-10-01 boards
    note: parallel with menu-print-approve (disjoint footprints except README.md and ARCHITECTURE.md rows, which merge textually). The card's editor-opening actions render only when EventDetailPage passes onOpenEditor, which this lane does not pass yet; everything else (Generate, Retry, Update draft, Dismiss, Undo, the fold) works, so main is shippable after this lane alone.
  - id: menu-designer-editor
    footprint:
      - client/src/pages/admin/menuDesigner/MenuEditor.js         # + .test.js each, below
      - client/src/pages/admin/menuDesigner/DesignTab.js
      - client/src/pages/admin/menuDesigner/DrinksTab.js
      - client/src/pages/admin/menuDesigner/BriefTab.js
      - client/src/pages/admin/menuDesigner/EditorBanner.js
      - client/src/pages/admin/menuDesigner/ConfirmDialog.js
      - client/src/pages/admin/menuDesigner/exportMenu.js
      - client/src/pages/admin/menuDesigner/*.test.js
      - client/src/pages/admin/menuDesigner/MenuCanvas.js         # the editable mode and on-canvas affordances
      - client/src/pages/admin/EventDetailPage.js    # ?menu=1 open state and onOpenEditor only; must not grow
      - client/src/context/UserPrefsContext.js       # sidebarOverride as its own state (spec 10.1)
      - client/src/context/UserPrefsContext.test.js  # new
      - client/src/components/adminos/Sidebar.js     # rail reads the override; footer toggle hidden while set
      - client/src/index.css                         # md- editor block
      - README.md                                    # Key Features
    blockedBy: [menu-designer-card, menu-print-approve]
    review: one-reviewer + ui-ux-review against docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html, Editor view, tables B, E and D, both skins
  - id: menu-designer-phone
    footprint:
      - client/src/pages/mobile/menu/**              # new: the phone cards, viewer and sheets (pattern-copied from components/mobile, which is not edited)
      - client/src/pages/mobile/EventDetailPhone.js  # a new `menu` drawer kind; mount the two cards; update the phase-1 "not on the phone" comment
      - client/src/pages/mobile/EventDetailPhone.test.js
      - client/src/index.css                         # m- block for the menu screens
      - README.md                                    # the pages/mobile/menu/ folder row
      - ARCHITECTURE.md                              # the phone's desktop-only list
    blockedBy: [menu-designer-editor]
    review: full-fleet   # EventDetailPhone.js is sensitive-listed; plus ui-ux-review against docs/design-artifacts/2026-10-01-menu-designer/Menu Phone.dc.html on the Pixel recipe
    note: follow-up lane (decision 13); reuses MenuCanvas, useMenuDraft, exportMenu and menuCardState unchanged; its data comes from the menu-draft GET's `plan` payload (E5), so it stays client-only. The walkthroughs-owed entry is written on main after the merge.
---

# Menu Art Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bar menu section on each event page that generates a custom 8x10 bar menu from the drink plan (AI art from OpenAI by default or Gemini by toggle, under real, editable text), and an Approve that posts it into the existing bar menu print slot.

**Architecture:** Six lanes. Foundation lands the tables, the two provider wrappers and the pure helpers. Engine lands the paid generation job, the cap and the draft routes. Approve moves the print-slot write into the existing `menuPrintFile.js` and adds the atomic approve route. The card lane builds the event-page card (and the printed-menu canvas) to the v3 Claude Design file's Event page view; the editor lane builds the editor to its Editor view. The phone lane is the follow-up (decision 13). Foundation and engine are serial; approve and card run in parallel after engine; editor runs after both; phone after editor.

**Tech Stack:** Node 26 / Express 4 / raw `pg` / R2 via AWS SDK v3 / `sharp` / `openai` (new) / `@google/genai` (new) / React 18 CRA / `html2canvas` / `node:test` (server) / Jest via react-scripts (client).

**Spec:** `docs/superpowers/specs/2026-10-01-menu-art-generator-design.md`. Every task below names the spec sections it implements. Read those sections before starting the task; this plan does not restate them.

## Global Constraints

- No em dashes in any user-facing copy or code comment written for this feature.
- Raw SQL with `$n` parameters only; `AppError` subclasses or `new AppError(msg, status, CODE)` for client-visible errors (spec 2, Errors).
- No pooled connection is held across a provider call (OpenAI or Gemini) or an R2 call; a request that needs a transaction opens its client after that work and releases it before `setImmediate` (spec 5.5).
- `openaiClient.js` is the only module that requires `openai`, and `geminiClient.js` the only one that requires `@google/genai`; the job reaches images only through `menuImageProvider.js`. Model ids, sizes, timeouts and caps come from env with the spec 13 defaults.
- Vanilla CSS in `client/src/index.css` only; page classes `md-`, print-canvas classes `mc-`.
- Client API calls through `client/src/utils/api.js` only.
- Each new file stays under 300 lines (spec 10.1); none may exceed 700 in any case.
- Every new server suite sets `process.env.NODE_ENV = 'test'` on its first line; route suites stub both provider wrappers and wait for the background job before `pool.end()` (spec 14).
- Server tests run one suite at a time from the repo root: `node --test <path>`. Read the pass count; a missing `require('dotenv').config()` reads as ECONNREFUSED.
- Client tests: `cd client && CI=true npx react-scripts test --watchAll=false <path>`.
- Commits use explicit pathspecs and `git commit -F - <<'MSG'` (no backticks in messages).
- No provider is ever called from any test (spec 14). The live smoke (Task E7) holds the only real calls before Dallas's first use.

## Review Focus

1. **A client-typed drink name with no ASCII letters or digits** ("🍹", "Señorita" is fine, "日本酒" is not) slugs to empty. The slug must fall back to `x` plus the first 8 hex of the name's SHA-1, never `custom:` with an empty slug. Test in Task F4.
2. **A huge brief** (a 3,000-character theme pasted from an email) must not blow up the words prompt. Each brief field is cut to 1,000 characters before it is sent, and art direction is already capped at 500. Test in Task E2.
3. **Every drink hidden,** leaving only "Also at the bar" or nothing, must still lay out, preview and approve. A menu of beer and wine is legitimate. Test in Task C1 (`layouts.js` with 0 drinks) and Task A3 (approve with zero `has_art` pieces).
4. **Google Fonts slow or blocked** must not hang Approve. Each font wait times out at 10 seconds and Approve fails, naming the font. Test in Task D3.
5. **Transparent drink art fringing on a dark background:** the model's alpha edges can leave a light halo on navy or black art. This can't be unit-tested; it is a named check in the live smoke (Task E7) on a dark theme, and if it shows, the drink prompt gains "clean anti-aliased edges, no white outline".
6. **Gemini's keyed-out drinks** are the riskiest pixels in the feature: Gemini returns JPEG on magenta, so compression smears the key into the drink's edge. `menuKeyOut.js` must leave no pink fringe on dark art and must not eat magenta-adjacent garnish colors (a raspberry, a hibiscus). Unit fixtures in Task F7, and the dark-theme check in Task E7's Gemini run.
7. **The editor's sidebar rail must never save.** Collapsing it through `setPref` would silently change Dallas's saved layout on every event he opens. Task D1 asserts `setPref` is not called, the footer collapse toggle is hidden, and the override clears on close and on unmount; `UserPrefsContext.test.js` proves localStorage is untouched.

---

## Lane 1: menu-art-foundation

Cut with `npm run worktree:new menu-art-foundation`. No routes yet; nothing user-visible.

### Task F1: the three tables

**Spec:** 6.
**Files:** modify `server/db/schema.sql` (append a block after the menu-print columns); create `server/db/schema.menuArt.test.js`.

- [ ] Write `schema.menuArt.test.js` in the `schema.vaCalling.test.js` style (pure regex over `schema.sql`, plus one live block that runs the DDL twice against the dev DB and checks `information_schema.columns`). Assert every column, default, CHECK and constraint in spec 6, including `UNIQUE (proposal_id)` on `menu_drafts`, `UNIQUE (draft_id, piece_key)` on `menu_draft_pieces`, the `tone` and `provider` CHECKs, the NOT NULL `provider` and `model` and the `drawn_count` default on `menu_draft_pieces`, the `kind`, `status` and `provider` CHECKs (and no `provider` default) on `menu_art_calls`, `approved_planner_image_key` on `menu_drafts`, the `created_at` index, and the `update_updated_at_column` trigger on `menu_drafts`.
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
  approved_planner_image_key TEXT,
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
  provider TEXT NOT NULL CHECK (provider IN ('openai','gemini')),
  model TEXT NOT NULL,
  drawn_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (draft_id, piece_key)
);

CREATE TABLE IF NOT EXISTS menu_art_calls (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  piece_key TEXT,
  run_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('image','text')),
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','ok','failed','released')),
  provider TEXT NOT NULL CHECK (provider IN ('openai','gemini')),
  model TEXT,
  size TEXT,
  error TEXT,
  provider_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_menu_art_calls_created_at ON menu_art_calls (created_at);
```

- [ ] Run the test. Expect PASS. Restart the dev server once so `initDb` applies the block, and confirm the boot log has no schema alert.
- [ ] Commit `server/db/schema.sql server/db/schema.menuArt.test.js`.

### Task F1b: `envInt.js`

**Spec:** 5.5 (Env numbers).
**Interface:** `readEnvInt(name, fallback)` returns `process.env[name]` as a positive integer, or `fallback` (with one console warning per name per process) when it is unset, blank, zero, negative, fractional or not a number.
- [ ] Tests: '60' gives 60; '', '0', '-5', '1.5', 'abc' and unset give the fallback; the warning fires once per name.
- [ ] Implement, pass, commit.

### Task F2: `openaiClient.js`

**Spec:** 5.1, 13.
**Files:** `package.json` and `package-lock.json` (`npm install --save-exact openai@7.34.0` from the lane root, the latest on 2026-10-16, Node 22 or later; afterwards re-check that the `node_modules` symlink is still a symlink, per the lane-install trap); create `server/utils/openaiClient.js` and its test.

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
- [ ] Implement (spec 5.1, Both wrappers). Build the SDK client lazily on first call with `{ apiKey: process.env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout, logLevel: 'off' }` (quiet logging where the SDK supports the option; the host pinned so an env override cannot redirect; a test pins these options), using `readEnvInt('MENU_ART_IMAGE_TIMEOUT_MS', 180000)` for image calls. Image calls return `Buffer.from(b64, 'base64')`.
- [ ] Tests pass, then commit.

### Task F2b: `geminiClient.js`

**Spec:** 2 (Gemini), 5.1, 12, 13, decision 11.
**Files:** `package.json` and `package-lock.json` (`npm install --save-exact @google/genai@2.30.0` from the lane root, then re-check the `node_modules` symlink as in F2); create `server/utils/geminiClient.js` and its test.

**Interfaces, produced:**

```js
isConfigured()                    // -> boolean (GEMINI_API_KEY set)
generateImage({ prompt, images: [{ buffer, mimeType }], aspectRatio, imageSize, model })
  // -> { buffer, mimeType, responseId, usage }
  // new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { baseUrl: <pinned> } })
  // ai.interactions.create({ model,
  //   input: [{ type: 'text', text: prompt },
  //           ...images.map(i => ({ type: 'image', data: <base64>, mime_type: i.mimeType }))],
  //   store: false,
  //   response_format: { type: 'image', aspect_ratio, image_size, delivery: 'inline' } },
  //   { timeout: MENU_ART_IMAGE_TIMEOUT_MS, maxRetries: 0 })   // per-call options
  // image_size uses an uppercase K ('1K', '4K'); a lowercase value is rejected by the API
  // returns { buffer, mimeType, responseId, usage }; exactly one output_image is accepted
__setTestStub(stub)               // test-only injection; null clears
class GeminiRefusal extends Error     // .reason, readable ("Gemini blocked this image for safety.")
class GeminiRateLimited extends Error // .retryAfterSec (err.headers.get('retry-after') when sent, else 20; capped 60)
```

- [ ] Tests:
  - Under `NODE_ENV=test` with no stub, every call rejects with "Gemini disabled under test" and nothing is constructed.
  - With a stub, the request carries `store: false`, the explicit `aspect_ratio` and `image_size`, `maxRetries: 0` and the timeout.
  - A thrown `APIError` whose code (read at `err.error.code`, else `err.error.error.code`; matched case-insensitively on the last path segment, so `IMAGE_SAFETY`, `image_safety` and a URI ending in either all match) is a safety, prohibited-content, blocklist, content-blocked, recitation, other-image or no-image code maps to `GeminiRefusal` with a readable reason; a 200 with `status` `failed` or `incomplete` maps to `GeminiRefusal` from `errors[0]`; a 200 with no `output_image`, or more than one, maps to `GeminiRefusal("Gemini answered without a single image.")`.
  - The constructor receives the explicit key and the pinned host (a test pins them), never `GOOGLE_API_KEY`.
  - Errors stored or sent to Sentry are the sanitized descriptor only (spec 5.1).
  - A 429 (`RESOURCE_EXHAUSTED`) maps to `GeminiRateLimited`, 20 seconds when no `Retry-After` is sent.
  - Any other error rethrows as `ExternalServiceError('gemini', ...)`.
  - `isConfigured()` follows the env var.
- [ ] Implement. Build the client lazily as in the interface above (the explicit key and the pinned host; the timeout from `readEnvInt('MENU_ART_IMAGE_TIMEOUT_MS', 180000)`), decode `output_image.data` from base64, and never log the prompt or the images.
- [ ] Tests pass, then commit.

### Task F3: R2 read-back and the proxy helper

**Spec:** 5.4, 7.
**Files:** `server/utils/storage.js` (add `readFile` to the exports; `uploadFile` and `getSignedUrl` untouched); create `server/utils/storage.readFile.test.js`, `server/utils/r2Proxy.js` and `server/utils/r2Proxy.test.js`.

**Interfaces:**
- `readFile(key, { timeoutMs = 8000 } = {})` returns `{ buffer, contentType }`. It throws `ExternalServiceError('r2', ...)` on a fetch error or a non-OK status, and a `NotFoundError` on 404 so callers can say "missing".
- `sendR2Object(res, key, { filename, disposition = 'inline', width })` calls `readFile`; when `width` is 240 or 480 it resizes with `sharp` to that width (PNG kept as PNG, so alpha survives); then it sets `Content-Type`, `Content-Disposition`, `Cache-Control: private, no-cache` and an ETag built the way `menuPrintFile.js` builds its own (read it and match it; the width joins the digest input).
- `assertKeyUnder(key, prefix)` throws `NotFoundError` unless `key.startsWith(prefix)` and the key contains no `..` and no `//`.

- [ ] Tests:
  - stub global `fetch`: OK, 404, 500 and abort;
  - the presigner stubbed by stubbing `@aws-sdk/s3-request-presigner` through `require.cache` before requiring `storage.js` (a `require.cache` stub of `storage` itself cannot reach `readFile`'s internal call), or `readFile` calling through `module.exports.getSignedUrl` so the stub reaches it;
  - `assertKeyUnder` cases: a good key, a wrong prefix, `..`, `//`;
  - `sendR2Object` with `width: 240` returns a 240-wide image with alpha intact and a different ETag from the full size.
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
  // -> { drink_keys: [...sorted], brief_hash, brief_fields: { theme, naming, notes }, planner_image_key }

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
  - brief hash normalization: null equals empty equals whitespace, and internal runs collapse; one field's change moves only that field's hash; `planner_image_key` follows `_logoFilename`;
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
  - the `text_backing`, `logo_mode`, `logo_badge` and `mark_color` enums;
  - `background_label` and `added_by_sync` are refused (server-written only, like `palette`);
  - `inputs` may change `planner_image_role`, `drb_mark` and `reference_source` (to `none`, or to `planner` when the role is `reference`) only; `reference_key` and `image_model` are refused.
- `validateImageModel(value)` returns `'openai'` or `'gemini'` or throws `ValidationError({ image_model })`; `validateGenerateInputs` includes it, and the re-roll and sync routes call it on their bodies.
- `validateRerollNote(note)` caps the note at 200 characters.

- [ ] Tests: one passing and one failing case per spec 7.1 row, plus "omitted keys untouched".
- [ ] Implement, pass, commit.

### Task F7: `menuKeyOut.js`

**Spec:** 5.4 (Drinks, Gemini), Review Focus 6.
**Interface:** `keyOutMagenta(buffer, { minKeyFraction = 0.25 } = {})` resizes to 1024x1024 first when the input is any other size, then resolves to a 1024x1024 PNG `Buffer` with alpha, or throws `MenuKeyOutFailed` ("Gemini didn't leave a clean background. Re-roll it.") when less than `minKeyFraction` of the pixels are near the key. Pure: `sharp(buffer).ensureAlpha().raw()`, per-pixel work in JS, `sharp(raw, { raw }).png()` out.
- Only key-colored regions connected to the image border are removed (a flood fill from the edges over pixels within the outer threshold), so a pink or fuchsia drink body survives. Distance is measured in chroma, not RGB, so a dark magenta shadow still keys: a border-connected pixel within the inner threshold of `#FF00FF` becomes alpha 0; one between the inner and outer thresholds gets alpha scaled by distance; everything else stays opaque.
- Despill: in partial-alpha pixels, red and blue are clamped toward green by the magenta excess, so the edge loses its pink cast.
- Fixtures (`sharp({ create })` plus composited shapes): a cream glass on flat magenta; the same after a JPEG round trip at quality 80 (the real case); a green lime garnish touching the key; a raspberry-red garnish near magenta; a pink (`#e8509a`) drink body enclosed by its glass outline; an image with no magenta; a 1000x1000 input.

- [ ] Tests:
  - the corners are alpha 0 and the glass center is alpha 255;
  - the edge band has partial alpha, and no edge pixel keeps a magenta cast above a small tolerance;
  - the green garnish keeps its color; the raspberry keeps at least 90% of its pixels opaque; the enclosed pink body stays fully opaque; the 1000x1000 input comes out 1024x1024;
  - the JPEG round trip still keys cleanly;
  - the no-magenta image throws `MenuKeyOutFailed`.
- [ ] Implement, pass, commit.

**Lane 1 exit:** every suite above green, plus `requestAliases.test.js` and `shoppingList.generator.test.js`. Then the full fleet on the lane diff, then merge.

---

## Lane 2: menu-art-engine

**Notes from the foundation build and its review fleet (2026-10-16). Read before cutting this lane; they override the task text below where they differ.**
- **Lock order.** `lockCalls` is the FIRST statement of every reserving transaction, before any row lock: in re-roll it comes before locking the piece row (otherwise re-roll holding the piece while Generate holds the table lock and deletes pieces deadlocks), and sync's main transaction takes it too. `reserveImages` and `reserveText` assert the lock is held (`pg_locks`, `ExclusiveLock` on `menu_art_calls` for `pg_backend_pid()`), so a caller that forgets cannot pass the cap concurrently.
- **Stranded reservations.** Re-roll and sync reservations carry a piece `run_id`, so Generate's `releaseReserved(old run)` misses them after a restart. Inside the locked Generate transaction, also release `WHERE proposal_id = $1 AND status = 'reserved'`. Sync's words reservation needs a `run_id` that `authorizeCall` can match (a NULL never authorizes).
- **The ledger stamps `updated_at` by trigger** (`update_menu_art_calls_updated_at`); writers need not set it. The open-run index `idx_menu_art_calls_open_run (run_id) WHERE status IN ('reserved','sent')` serves the release and sweep queries.
- **`validatePatch` contract** (spec 7.1, as built): `{ changed, content?, inputs? }`. Write only the columns present; on `changed: false` skip the write and the version bump and return the current version. `validateGenerateInputs(body, { hasFile, storedInputs })` takes that second argument; without it every Generate with a kept reference fails.
- **Stored drinks carry exactly spec 6's thirteen fields.** `normalizePlan`'s drinks also carry `name`, `typed_name` and `ingredients`; build the stored entries explicitly (fixed extra fields would round-trip, but keep the stored shape to spec).
- **Image shapes differ between the wrappers.** `openaiClient.editImage` takes `[{ buffer, filename, contentType }]` (never a client's original filename); `geminiClient.generateImage` takes `[{ buffer, mimeType }]`. `storage.readFile` returns `{ buffer, contentType }`. `menuImageProvider` converts.
- **Refusals.** `OpenAIRefusal`, `GeminiRefusal` and `MenuKeyOutFailed` all carry `.reason` (a fixed readable sentence, never provider text) and a code; fold them into `MenuArtRefusal`. Send only `err.descriptor` to Sentry.
- **The words schema must be strict-mode compatible** (`draftMenuCopy` sends `strict: true`): `additionalProperties: false` and every property required.
- **Drink prompt.** Ask for opaque glassware (magenta seen through a glass or a handle gap is enclosed, so the key-out cannot remove it) and for the drink to fill no more than about 70% of the frame (the key-out refuses an image with under 25% background).
- **Per-run work, once.** Read and downscale the background once per run, not per drink; downscale an uploaded reference before base64-ing it for Gemini.
- **Polling cost.** `loadCatalogMaps` is two catalog queries; do not run it on every 2-second poll (skip the plan diff on poll requests, or cache the maps per process for about 60 seconds). Inside a transaction pass the client to `loadEventPlan` and `loadCatalogMaps`. Use `fingerprintHash(fp)` for `dismissed_plan_hash` (it is stable across JSONB key reordering).
- **`sendR2Object` requires `prefix`** (it runs `assertKeyUnder` itself) and accepts `width` 240 or 480 (or the strings); images over 50 MP answer 422 `IMAGE_TOO_LARGE`, unreadable ones 422 `IMAGE_UNREADABLE`, neither paging Sentry.
- **The R2 signer moved** (`@smithy/*` minors, forced by openai's optional peers). E7's live smoke must include a real R2 upload and signed read.
- **Approve-lane tests** delete their draft before any temp user (`approved_by` has no ON DELETE action, by spec).


Cut after Lane 1 is on main.

### Task E1: the cap and reservations (`menuArtCap.js`)

**Spec:** 5.5 (Daily cap, Superseded runs, End-of-run sweep, Env numbers), 12.
**Interfaces:**

```js
lockCalls(client)
  // LOCK TABLE menu_art_calls IN EXCLUSIVE MODE; callers make it the FIRST statement of
  // Generate, re-roll and sync transactions (one lock order); 40P01 -> 409 MENU_DRAFT_CHANGED

reserveImages(client, { proposalId, runId, pieceKeys, provider, model })
  // after lockCalls, inside the caller's transaction:
  //   count kind = 'image' AND status <> 'released' AND created_at > NOW() - interval '24 hours'
  //   throw new AppError('Daily menu art limit reached.', 429, 'MENU_ART_CAP_REACHED')
  //     when count + pieceKeys.length > imageCap
  //   insert one 'reserved' row per key, stamped with provider and model; returns ids by key
  //   one cap covers both providers (spec 5.5)

reserveText(client, { proposalId, runId })
  // the same against kind = 'text' and textCap; 429 MENU_ART_TEXT_CAP_REACHED

authorizeCall(id, { draftId, runId, pieceRunId })
  // ONE UPDATE: reserved -> sent WHERE id = $1 AND status = 'reserved' AND the run is still
  // current (draft run_id, or the piece's run_id for a re-roll); returns true only when
  // rowCount = 1. The job calls a provider only after true (spec 5.5, Superseded runs).

releaseReserved(client, { proposalId, runId })
  // inside the caller's transaction (Generate superseding an old run): that run's
  // reserved rows -> released; sent rows are untouched (the old job settles them)

settleRun({ runId, pieceKeys? })
  // standalone, for the job's finally: by the RESERVATION's own status:
  // reserved -> released; sent -> failed (billed, still counted)

markCall(id, status, { error, requestId, model, size })
  // standalone pool.query; error is the sanitized descriptor

capUsage(db = pool)
  // -> { used, limit, remaining, resets_at }; resets_at = the oldest counted row's created_at + 24h, or null

// caps come from envInt.readEnvInt('MENU_ART_DAILY_IMAGE_CAP', 60) and ('MENU_ART_DAILY_TEXT_CAP', 100)
```

- [ ] Tests (dev DB; clean up rows by a unique `run_id`):
  - the reservation counts;
  - a refusal at the cap writes nothing;
  - `released` rows do not count;
  - two concurrent `reserveImages` transactions at cap minus one: exactly one succeeds;
  - `authorizeCall` returns false for a superseded run and for an already-sent row, and true exactly once;
  - `settleRun` releases a reserved row and fails (does not release) a sent row, which still counts;
  - `releaseReserved` inside a transaction releases only the old run's reserved rows and leaves its sent rows;
  - the text cap refuses at its limit and does not count image rows;
  - a cap env set to 'abc' falls back to its default (through `readEnvInt`);
  - `capUsage`'s `remaining` and `resets_at`.
- [ ] Implement, pass, commit.

### Task E2: prompts (`menuArtPrompts.js`)

**Spec:** 5.1 (payload rule), 5.3, 5.4.
**Interfaces:**
- `wordsRequest({ normalized, eventTypeLabel })` returns `{ system, user, schema }`. The schema is the spec 5.3 JSON schema, with `font_pairing` as an enum of `FONT_PAIRING_IDS`, `palette` up to 6 `{ name (at most 20), hex }` entries, `accent_color` as hex or null, and `background_label` (at most 30 characters).
- `backgroundPrompt({ brief, artDirection })` returns a string.
- `drinkPrompt({ visualNote, rerollNote, provider })` returns a string. For `gemini` it adds the key clause: the drink alone on a flat, solid `#FF00FF` magenta background, nothing else in that color, no shadow on the background, and the attached images are style references only.
- `parseWords(json, normalized)` returns the content-step fields, with every catalog description forced back to the catalog text. It throws `MenuWordsInvalid` on a missing or extra drink key or a bad type.

- [ ] Tests:
  - the user payload contains none of: the client name, email, phone, venue or address, and the event date (build the fixture with all of them present on the plan row);
  - each brief field is truncated at 1,000 characters (Review Focus 2);
  - the background prompt always contains the no-lettering and calm-center clauses;
  - the Gemini drink prompt carries the magenta clause and the OpenAI one does not;
  - `parseWords` refuses a missing key and an extra key, and overwrites a model-supplied catalog description.
- [ ] Implement, pass, commit.

### Task E3: background tone (`menuBackgroundTone.js`)

**Spec:** 5.4 (Background tone), 12.
**Interface:** `readTone(buffer)` returns `{ tone: 'light' | 'dark', ground_rgb: 'r,g,b' }` or `{ tone: null, ground_rgb: null }` on any `sharp` error. It crops the central 60% with `extract(...).toBuffer()`, then calls `stats()` on a new `sharp` instance of that crop (`stats()` ignores a pending `extract`), and uses the channel means; dark means sRGB relative luminance below 0.4.

- [ ] Tests on generated fixtures (`sharp({ create: ... })`): navy gives dark, cream gives light, garbage bytes give nulls, and a cream center inside a thick navy border gives light (it fails if the crop is ignored).
- [ ] Implement, pass, commit.

### Task E3b: the provider router (`menuImageProvider.js`)

**Spec:** 5.1, 5.4, decision 11.
**Interface:** `drawImage({ provider, model, kind: 'background' | 'drink', prompt, references: [{ buffer, mimeType }] })` resolves to `{ buffer, contentType, model, size, requestId }`, the stored bytes. It draws with the stamped `model` passed in, never the env value at call time:
- `openai` background: `generateImage`, or `editImage` with references, at `MENU_ART_BACKGROUND_SIZE`, quality high, JPEG.
- `openai` drink: `editImage`, 1024x1024, `background: 'transparent'`, PNG.
- `gemini` background: `geminiClient.generateImage` at `4:5` / `4K`, with the references as style inputs, then `sharp` resize to 2560x3200 JPEG with `fit: 'cover'` (about 0.7% is trimmed, since 3712x4608 is not exactly 4:5).
- `gemini` drink: `geminiClient.generateImage` at `1:1` / `1K`, then `keyOutMagenta`, PNG.
- It throws one shared `MenuArtRefusal` (`.reason`) for `OpenAIRefusal`, `GeminiRefusal` and `MenuKeyOutFailed`, and one shared `MenuArtRateLimited` (`.retryAfterSec`) for both rate-limit classes, so the job handles one shape. It throws `AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED')` for `gemini` without its key.

- [ ] Tests (both clients stubbed through `__setTestStub`): each of the four cases calls the right client with the right size and the stamped model and returns the right content type and dimensions; a Gemini background passes its reference; the Gemini drink passes through the key-out; refusals and rate limits normalize; an unknown or missing provider throws.
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
- Before each provider call (the words call and every image call, on either provider):
  - refresh the active piece's heartbeat and the heartbeats of the run's remaining pending pieces in one UPDATE;
  - `authorizeCall` on that call's reservation; call only when it returns true, otherwise stop the run (it was superseded).
- Before any stored bytes go to a provider (the uploaded reference, the planner image, the background), re-check the key's prefix (spec 5.4); a key outside it fails the piece and is never read.
- **Words:** `draftMenuCopy` then `parseWords`. On success, one conditional UPDATE writes the content fill plus `words_status = 'done'`. On failure it writes `words_status = 'failed'` and `words_error`.
- **Background:** `drawImage({ provider: piece.provider, kind: 'background', ... })` with the reference (read with `readFile`) when one exists; upload to R2 under spec 6's key; `readTone`; piece `done` with `tone`, `ground_rgb`, `drawn_count + 1`; `art_version + 1`.
- **Drinks** (sequential, `has_art` only): `drawImage({ provider: piece.provider, kind: 'drink', ... })` with the background (downscaled with `sharp` to 1024 wide) plus the reference; upload the PNG; `done`, `drawn_count + 1`; `art_version + 1`.
- **Provider per piece:** the job reads each piece's own `provider`; there is no draft-wide setting (decision 11). Each `markCall` records the provider and model.
- **Retries:** `MenuArtRateLimited` (images) and `OpenAIRateLimited` (the words step) wait `retryAfterSec`, refreshing the heartbeat while they wait, at most 2 times; a retry is the same reservation, still `sent`. Every other error fails the piece with no retry. `MenuArtRefusal` stores its `reason`.
- **The `finally` sweep:** every `pending` or `working` piece of this run becomes `failed` with "not attempted: <cause>" (conditional on `run_id`); `settleRun` (by each reservation's own status); `Sentry.captureException` with `{ area: 'menuArt', step }` and the sanitized descriptor on any unexpected error.
- **Connections:** standalone `pool.query` everywhere; no client held.

- [ ] Tests (dev DB fixtures; the stub is injected through `__setTestStub`; R2 is stubbed through `require.cache`):
  - happy path: words, background and two drinks done, `art_version` 3, each `drawn_count` 1;
  - a mixed run: background by OpenAI and a drink re-rolled by Gemini, each piece's `provider` and each call row's provider correct;
  - a Gemini key-out failure fails only that piece, with the readable reason;
  - a words failure leaves every piece failed "not attempted" and every never-sent reservation `released`;
  - a drink whose provider call succeeded and whose key-out then failed ends `failed` with its reservation `failed` (still counted);
  - a 429 on the words step, then success;
  - a reference key outside its prefix fails the piece with no provider call;
  - a 429 then success;
  - a 500 fails without retry;
  - a refusal reason is stored;
  - the run is superseded mid-run (the test swaps `run_id` after the background): no further stub calls on either provider and no writes;
  - a re-roll of one piece;
  - the reservation rows end `ok`, `failed` or `released`.
- [ ] Implement, pass, commit.

### Task E5: the read model (`menuDraftRead.js`)

**Spec:** 5.5 (Stuck rule), 8 (Derived print state), 9.
**Interfaces:**
- `stuck(row, now, staleMs)` returns a boolean.
- `readDraftPayload(proposalId)` returns the spec 7 GET payload: `{ draft, pieces (each with provider, model and drawn_count), brief, diff: { added, dropped, brief_edited: [fields], image_changed, dismissed }, print: { state, approved_at, approved_by_name }, cap: { used, limit, remaining, resets_at }, configured: { openai, gemini }, plan: { id, menu_style, drink_count, drinks: [{ name, mock }], bar_summary } | null }`. The print state counts a changed planner image as edited since approval when the role is logo (spec 8). Stuck pieces and the words step are reported `failed` / "interrupted". `diff.dismissed` is true when the current plan hash equals `dismissed_plan_hash`.

- [ ] Tests:
  - the stuck boundary at `MENU_ART_STALE_MS`, for pending and working;
  - every derived print state in spec 8 (approved, edited by `version`, edited by `art_version`, replaced, removed, no menu needed);
  - the diff, added and dropped;
  - brief edited only, naming the changed field (theme, naming or notes); the planner image replaced (`image_changed`), and as edited since approval on an approved logo draft;
  - the `plan` payload shape, including no plan and a house menu;
  - dismissed until the plan changes again;
  - no plan.
- [ ] Implement, pass, commit.

### Task E6: the routes (`menuDrafts.js`) and limiters

**Spec:** 7 (every row except approve, which is Lane 3), 5.5 (Generate, Re-roll), 9, 3 (decision 9).
**Files:** create `server/routes/proposals/menuDrafts.js` and `server/routes/proposals/menuDrafts.test.js`; add `menuDraftReadLimiter` (120/min) and `menuDraftEditLimiter` (30/min) to `rateLimiters.js`, keyed `menudraft-r-<userId>` and `menudraft-e-<userId>`; mount with `router.use('/', require('./menuDrafts'))` right after `menuPrint` in `server/routes/proposals/index.js`.

**Route behavior** (every route: `auth`, `requireAdminOrManager`, `asyncHandler`, integer `:id`, proposal 404, and 503 `MENU_ART_NOT_CONFIGURED` before any OpenAI work; the image routes also 503 `MENU_ART_GEMINI_NOT_CONFIGURED` for `image_model: 'gemini'` without its key):

- **`GET /:id/menu-draft`:** `readDraftPayload`.
- **`POST /:id/menu-draft/generate`:**
  1. `validateGenerateInputs`.
  2. `loadEventPlan` and `normalizePlan`; 422 `MENU_NO_DRINKS` on no plan or zero drinks.
  3. Upload an attached reference first (the upload checks in spec 7). Start over carries `reference_key` forward when nothing is attached and the source is unchanged.
  4. Then one client transaction: upsert in place (`INSERT ... ON CONFLICT (proposal_id) DO UPDATE`), new `run_id`, `version + 1`, content reset to `{ words_status: 'pending', words_heartbeat_at: now }`, `lockCalls` first, then `releaseReserved` for the old run, delete the old pieces, insert pending pieces (the background plus the first 8 drinks) stamped with the posted `image_model` as `provider` and that provider's env model id as `model`, `reserveText` for the words call, store it in `inputs.image_model`, `reserveImages`, COMMIT.
  5. Release, return 202, then `setImmediate(runGeneration)`.
- **`PATCH /:id/menu-draft`:** `validatePatch` against the stored row, then `UPDATE ... SET content, inputs, version = version + 1 WHERE proposal_id = $1 AND version = $2 RETURNING version`; no row means 409 `MENU_DRAFT_CHANGED`. Editing is refused with 409 while `words_status` is not `done`.
- **`POST /:id/menu-draft/pieces/:pieceKey/reroll`:** pattern-check the key (spec 7) and `validateRerollNote`. In one transaction: lock the piece row; 409 `MENU_ART_PIECE_BUSY` when it is working and not stuck; `reserveImages` for one; set a new piece `run_id`, `pending`, the note, the posted `image_model` as `provider`, that provider's model id as `model`, and a fresh heartbeat (creating the row for a `has_art` drink that has none); COMMIT. Return 202, then `setImmediate(runPieceReroll)`.
- **`POST /:id/menu-draft/sync`** (spec 7 row, 9):
  1. Recompute the diff.
  2. For added client-typed drinks: a short transaction (`lockCalls`, `reserveText`, COMMIT), then `authorizeCall` and `runWordsForDrinks`, all before the main transaction; a 429 at the text cap refuses the sync before anything is written.
  3. One transaction: version check; append the added drinks (`has_art` while fewer than 8 visible have art); remove the dropped drinks from `content` and delete their pieces; set `plan_fingerprint`; clear `dismissed_plan_hash`; `reserveImages` for the added drinks with art, their pieces stamped with the posted `image_model` and its model id; `version + 1`; COMMIT.
  4. Return 202, then queue `runPieceReroll` for each.
- **`POST /:id/menu-draft/dismiss-plan-change`:** stores the current plan hash under the version check.
- **The three image `GET`s:** `assertKeyUnder`, then `sendR2Object`. The piece prefix is `menu-art/<id>/`, the reference prefix `menu-art/<id>/ref-`, and the planner prefix `drink-plan-logos/<planId>-`. The piece and planner routes take `?w=240` or `?w=480` (a `sharp` downscale, PNG keeping alpha); any other `w` is a 400.
- **Lock order and conflicts:** Generate, re-roll and sync call `lockCalls` first in their transactions; a `40P01` maps to 409 `MENU_DRAFT_CHANGED`. Re-roll also answers 409 `MENU_ART_PIECE_BUSY` for a piece pending in a run that is still active. Generate resets every drink's `added_by_sync` to false; sync sets it on the drinks it adds. Each words call reserves through `reserveText`.

- [ ] Tests (the `menuPrint.test.js` harness style: a real router, real `express-fileupload`, hand-built multipart, R2 and BOTH `openaiClient` and `geminiClient` stubbed; `process.env.NODE_ENV = 'test'` on the first line; each test waits for the queued job before the next and before `pool.end()`). Cover every spec 14 Routes bullet that is not approve:
  - auth: no token, staff and manager;
  - generate: 503 with no key; 503 for `gemini` without its key while `openai` still works; `image_model` required; 422 with no plan and with no drinks; 429 at cap; two concurrent generates (exactly one run survives, and the superseded job makes no further call);
  - PATCH: 409 on a version mismatch; 409 before the words land; key-set change refused; more than 8 `has_art` refused; more than 12 visible refused; more than 4 visible without art refused; `palette` refused; pieces untouched;
  - re-roll: busy (working, and pending in an active run), then stuck, allowed; a re-roll under the other model changes only that piece's `provider` and `model`;
  - PATCH refuses `inputs.reference_key`, `inputs.image_model` and `added_by_sync`, and allows `reference_source: 'none'`;
  - the image GETs' `?w=` (240, 480 accepted; others 400);
  - sync: adds, removes, version 409;
  - dismiss;
  - every key guard.
- [ ] Implement, pass, commit.

### Task E7: docs, lists, live smoke

**Spec:** 13, 14 (Live smoke), 16.
**Files:** `.env.example`, `README.md` (env table, tech stack, server folder rows), `ARCHITECTURE.md` (the three tables, OpenAI and Google Gemini under integrations, the new utils, the `menuDrafts` route rows), `.claude/CLAUDE.md` (env table, Tech Stack), `scripts/sensitive-paths.txt` (this lane's five: `openaiClient.js`, `geminiClient.js`, `menuImageProvider.js`, `menuArtCap.js`, `menuDrafts.js`, with a one-line reason each; Lane 3 adds its own three).

- [ ] Write the docs, including `MENU_ART_DAILY_TEXT_CAP` and the `GEMINI_API_KEY` blast-radius and leak-response note (spec 13). Run `node scripts/sensitive-match.js server/utils/openaiClient.js server/utils/geminiClient.js server/utils/menuImageProvider.js server/utils/menuArtCap.js server/routes/proposals/menuDrafts.js` and confirm all five match.
- [ ] **Live smoke on dev** (run by the controlling session, not a subagent: a subagent cannot mint the admin dev JWT):
  1. Put the box keys in the repo-root `.env` (the file every lane symlinks; there is no `server/.env`): `OPENAI_API_KEY` from `~/.secrets/openai_api_key` and `GEMINI_API_KEY` from `~/.gemini/.env`. Confirm in AI Studio that the Gemini key's project is on the paid tier. Start a lane-scoped server from the lane on a spare port (the managed :5000 server runs main, which has neither these routes nor this schema), and point the steps below at it.
  2. With curl and an admin dev JWT, `POST /api/proposals/<a dev proposal with a custom-menu plan>/menu-draft/generate`.
  3. Poll `GET` until nothing is pending.
  4. Record the wall-clock time, every piece's status, the background's `tone`, and whether any drink PNG shows a light fringe when composited on a dark ground (Review Focus 5: composite one with `sharp` onto `#121b35` and look at it).
  5. Repeat steps 2 to 4 with `image_model: 'gemini'`, then re-roll one drink under the other provider. Composite a Gemini drink onto `#121b35` and onto the garden ground and look for a pink fringe (Review Focus 6). Save one raw Gemini drink JPEG (before the key-out) as `server/utils/__fixtures__/gemini-drink-raw.jpg` and add it to `menuKeyOut.test.js` as a regression fixture. Check on the usage page that one Pro call billed one image.
  6. Read each run's cost on the OpenAI and AI Studio usage pages, or note that it was unavailable, and record both in the lane's merge notes.
  7. If either account refuses with "verify organization", billing or prepay depletion, stop and tell Dallas.
- [ ] Commit the docs.

**Lane 2 exit:** every Lane 2 suite plus the Lane 1 suites green. Then the full fleet, then merge.

---

## Lane 3: menu-print-approve

Cut after Lane 2 is on main. Runs in parallel with Lane 4.

### Task A1: extend `menuPrintFile.js`, and the manual route keeps its order

**Spec:** 2 (The print slot), 8 (Shared helper, the manual upload).
**`server/utils/menuPrintFile.js` already exists** (`7a1aa28b`). It exports `sendMenuPrintFile`, which `eventDetails.js:22` (staff download) and `menuPrint.js:24` (admin download) both use. Do NOT recreate the file. Add the two exports beside `sendMenuPrintFile`, leave that function byte-identical, and grow the header comment to say the module is also the one way the print key is set.
**Interfaces (added):**
- `setMenuPrintKey(executor, proposalId, key)` returns `{ rowCount }`. It runs the existing UPDATE verbatim and throws `NotFoundError('Proposal not found.')` on 0 rows.
- `reaccrueDuty(proposalId)` is moved from `menuPrint.js` with its body verbatim, `setImmediate` and Sentry tags included; only its `require` path changes (to `./payrollAccrual`).

- [ ] Tests (new `server/utils/menuPrintFile.test.js`, `NODE_ENV=test` on line 1): the executor is honored (pass a stub executor and assert the SQL and params); 0 rows throws; `reaccrueDuty` schedules exactly one `maybeReaccrueForDuty` call (stub through `require.cache`); `module.exports.sendMenuPrintFile` is still the same function the two routes import.
- [ ] Refactor `menuPrint.js` POST to: R2 upload, then `setMenuPrintKey(pool, ...)`, then `reaccrueDuty`. DELETE keeps calling `reaccrueDuty`, now imported. `menuPrint.js` still requires `storage` itself.
- [ ] Run `node --test server/routes/proposals/menuPrint.test.js`, `server/routes/eventDetails.test.js`, `server/utils/dutyLines.test.js` and `server/routes/beo.test.js`. All must stay green with no test edits; both downloads included.
- [ ] Add `menuPrintFile.js`, `menuPrint.js` and (after A3) `menuDraftApprove.js` to `scripts/sensitive-paths.txt`; update README's `menuPrintFile.js` row with the new exports.
- [ ] Commit.

### Task A2: (shipped)

The admin download, `GET /api/proposals/:id/menu-print`, shipped on 2026-10-06 in `7a1aa28b` (the admin-ui-batch lane) with `beoReadLimiter` and `client/src/utils/downloadMenuPrint.js`. Nothing to build; Task A1's refactor must leave it and its tests untouched.

### Task A3: approve (`menuDraftApprove.js`)

**Spec:** 8 (Approve 2 to 4), 12, 14 (Approve bullets).
**Files:** create `server/routes/proposals/menuDraftApprove.js` and its test; mount it after `menuDrafts` in `server/routes/proposals/index.js`.

**Behavior:**
1. Multipart `file` plus `version` and `art_version` (integers) and `expected_print_key` (a string, or empty for none).
2. JPEG magic bytes, then `sharp(buffer).metadata()` must be exactly 2400 x 3000.
3. R2 upload to `menu-print/<id>/<uuid>.jpg` before any transaction.
4. Then one client transaction:
   - `SELECT version, art_version, id FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE`;
   - 409 `MENU_DRAFT_CHANGED` when either version differs;
   - 409 when any piece the layout uses (the background plus every visible `has_art` drink) is not `done`. Zero illustrated drinks is allowed (Review Focus 3);
   - `SELECT menu_print_key FROM proposals WHERE id = $1 FOR UPDATE`; 409 `MENU_PRINT_CHANGED` when it is not the posted `expected_print_key` (empty means null);
   - `setMenuPrintKey(client, ...)`;
   - stamp `approved_*` with the POSTED versions and the new key, and `approved_planner_image_key` with the plan's `_logoFilename` when the draft's role is `logo` (else null);
   - `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'menu_approved', 'admin', $2, $3)` with `{ draft_id, version, art_version, print_key }`;
   - COMMIT.
5. Release, then `reaccrueDuty(id)`. Respond with the derived print state.

- [ ] Tests:
  - non-JPEG and wrong dimensions refused;
  - a stale `version` and a stale `art_version`, each 409;
  - a changed print key since the confirm, 409 `MENU_PRINT_CHANGED`, nothing stamped;
  - `approved_planner_image_key` stamped for a logo draft, null otherwise;
  - a not-done piece 409;
  - zero illustrated drinks approves;
  - success sets `menu_print_key`, clears `menu_not_required`, stamps the posted versions and writes the activity row;
  - `reaccrueDuty` is called once and only after COMMIT (stub it and assert the proposal row already shows the new key when the stub runs);
  - a re-roll after approval reads as edited since approval through `readDraftPayload`;
  - auth.
- [ ] Implement, pass, commit. Add `ARCHITECTURE.md`'s route row for the approve route and its `menuPrintFile.js` mentions, README's `menuDraftApprove.js` row, and the sensitive-list entry.

**Lane 3 exit:** the A suites plus `menuPrint`, `eventDetails`, `beo`, `dutyLines` and `menuDrafts` green. Then the full fleet, then merge.

---

## Lane 4: menu-designer-card

Cut after Lane 2 is on main. Runs in parallel with Lane 3 (disjoint footprints except README and ARCHITECTURE rows). **Owns the visual fidelity of the card and of the printed menu.** First check whether Claude Design project `89b66aac-dd5f-407d-b026-10b78702ce8a` changed since 2026-10-16 (DesignSync `list_files`); if it did, re-pull and re-vendor on main before building (spec 11). The working input is `docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html` in its **Event page** view: serve the folder (`python3 -m http.server` from it) and switch its skin and state props. Build to spec 11.1 (the card, table C and its precedence) and table D; the printed menu follows the 2026-10-01 snapshot `menu-designer.html` plus spec 11.2. The vendored JavaScript is scaffolding; port the layout, not the code.

**Test setup for this lane and the next:** jsdom has no 2D canvas, no `document.fonts`, and never fires `<img>` load events. Mock `tintedWordmark.js` and `softBacking.js` where they are not under test, stub `document.fonts`, and fire image `load` events by hand (spec 14).

### Task C1: `layouts.js`

**Spec:** 11.2 (Rows, Slot width, Art height, More from the bar), Review Focus 3.
**Interfaces:**
- `splitRows(n)` returns the row sizes: `[1]`, `[2]`, `[3]`, `[2,2]`, `[3,2]`, `[3,3]`, `[4,3]`, `[4,4]`, and `[]` for 0.
- `slotWidth(rowLen)` returns 360, 250, 200 or 152.
- `artStart(totalRows)` returns 280, 210, 165 or 130 (130 for 4 or more), with a fallback for 0.
- `partitionDrinks(drinks)` returns `{ sig: [...], mock: [...], more: [...] }`, with visible drinks only and the illustrated ones by group.

- [ ] Pure tests for every count from 0 to 8; `partitionDrinks` with 12 visible (8 illustrated, 4 more) and with all hidden.
- [ ] Implement, pass, commit.

### Task C2: pairings, colors, the canvas and the mark

**Spec:** 11.2 (with the amended Mark), table P, 11.3, 10.2 (Drink art at its own ratio), 10.3.
**Files:** `fontPairings.js` (the table P data; ids match `FONT_PAIRING_IDS`; a comment maps the design keys; `fontsHref(pairingIds)` builds one Google Fonts URL for a set of pairings), `menuColors.js` (`resolveColors({ pairing, tone, ink, accent, markColor })`), `MenuCanvas.js` (read-only mode in this lane), `ornament.js` (the `ORN` path), `softBacking.js` (`drawSoftBacking(groundRgb)` to a data URL through an offscreen canvas), `tintedWordmark.js` (`tintWordmark(img, color)` to a data URL: draw, then `source-in` fill), the two mark images copied byte for byte from the vendored `assets/` to `client/public/images/menu-mark-avatar.png` and `menu-mark-wordmark.png`, and the `mc-` CSS block in `index.css`.

- [ ] Tests:
  - `resolveColors`: tone dark picks the dark set, light and null pick the light set, overrides win, and `markColor` resolves ink, accent and gold (`#d9b77e`);
  - `fontsHref` lists exactly the families and weights of the pairings asked for;
  - `MenuCanvas` (read-only) renders the title, headings, drinks, More from the bar, Also at the bar and the mark (both images, the wordmark through the mocked tint) from props, with no mark when `drb_mark` is false, and draws each drink `<img>` as a square of its box's width (never stretched, since html2canvas has no `object-fit`).
- [ ] Implement to the numbers in 11.2: the padding, gaps, slot widths, art-height starts, the 6 px shrink loop with the 65 px floor (in a `useLayoutEffect` against `scrollHeight`), the one-step type reduction and the "Too long" flagging, the logo sizes and badge, the backings (the Soft backing as an image layer, the Panel backing with no blur), and the mark at 40 / 40 with the avatar at 40 px tall and the wordmark at 159 x 18. Use the 2026-10-01 row splits and sizes, not the v3 files' drifted ones (table D, item 7).
- [ ] Commit.

### Task C3: the data hook and the state mapper

**Spec:** 10.1 (The draft hook lives at page level), 10.2, 11.1 (table C and its precedence, tables B and E), 8 (Derived print state), 9.
**Files:** `useMenuDraft.js` and `menuCardState.js`, with tests.
- `useMenuDraft(proposalId)`: the GET, polling, autosave, `flush()`, the layer cache keyed by `r2_key` and size (`?w=240` for the card), the pre-draft brief inputs and a staged reference file (held in memory for the page visit), and the image-model choice (starting at `openai` on every mount, never persisted; decision 11) sent on Generate, re-roll and Update draft. The card's in-place actions always send `openai`.
- `menuCardState({ payload, local })` (pure) returns `{ chip: { kind, text }, message, sub, primary, secondary, banners, empty, approve: { label, disabled, why }, generate: { disabled, hint } }`, applying table C's precedence, where `local` carries the client-only facts (saving, save failed, too long, approving, the editor's toggle).

- [ ] Tests (mock `api`):
  - polling runs only while something is pending, working or the words step is pending; a 429 backs off to 10 s;
  - the autosave debounce is 800 ms; a 409 refetches and reports a conflict; `flush()` resolves after an in-flight save and rejects when the save fails;
  - image blobs are cached by `r2_key` and size, only a changed piece is fetched, and object URLs are revoked on replacement and unmount;
  - the pre-draft inputs survive a simulated editor close and reopen;
  - a `proposalId` change flushes the pending save to the OLD id (the PATCH carries the old id), then resets the draft, the brief inputs, the held reference, the model choice and the layer cache;
  - the model choice resets to `openai` on remount and rides each image request;
  - `menuCardState`: every row of tables C, B and E; the precedence cases (approved plus plan changed, approved plus notes edited, a failed drawing plus plan changed, no menu needed with a draft, not set up with a draft, the global cap never on the card); the ghost View rule (not beside Watch, Update draft, Undo or during Approving); the "Staff still get the <date> version." sub; Generate's `cap.remaining` gating and hints; the facts table D says to leave out.
- [ ] Implement, pass, commit.

### Task C4: the card and the fold

**Spec:** 11.1 (The card, table C), 4.1, 10.1, decision 12.
**Files:** `MenuDesignerCard.js`, `MenuCardFold.js`, their tests, the `md-` card block in `index.css`; `EventDetailPage.js` (calls `useMenuDraft` once, swaps `AdminMenuPrintBlock` and `EventDetailPlanLogo` for `MenuDesignerCard`, passes `setDrinkPlan` and `loadProposal` for the fold, passes no `onOpenEditor` yet). Port the three Download tests from `AdminMenuPrintBlock.test.js` into `MenuCardFold.test.js`; move `isSafeLogoUrl` verbatim into `MenuCardFold.js`. Then run `grep -rn "AdminMenuPrintBlock\|EventDetailPlanLogo" client/src`, confirm only `EventDetailPage.js` and the old test remain, delete `AdminMenuPrintBlock.js`, its test and `EventDetailPlanLogo.js`, remove the `.admin-plan-logo*` rules (around `index.css` 14901 to 14948), and update README's old row and ARCHITECTURE's "Bar menu print card" mention. Leave the comment in `server/routes/shifts.queries.js` alone. `PrivacyPage.js` and its test get the spec 13 line.

- [ ] Tests (React Testing Library, mocked hook; both rows' kebabs share the trigger title "More actions", so use `getAllByTitle`):
  - every table C row's chip, lines and actions, the thumbnail opening nothing yet (no `onOpenEditor`), and the 900 px narrow-window note;
  - the Print file row: the four value texts; Download (the three ported tests, "Downloading..." never blocking an upload); Upload with the 10 MB check and the magic-byte `fieldErrors.file` message; the kebab's Replace file, Remove and No menu needed, which reads "A menu is needed after all" once marked (and the card's Undo), each calling `loadProposal` and refetching the draft; "Working..." while busy;
  - the Client image row: Replace, Remove, Upload (the `image/png,image/jpeg` accept list, `fieldErrors.logo`, "Uploading..."), each calling `setDrinkPlan` and refetching; Download original only for an `isSafeLogoUrl` value, opening a new tab through `window.open`; "No drink plan";
  - the fold keeps working when the draft GET fails;
  - `EventDetailPage.fork.test.js` still passes (no `useUserPrefs` in the page).
- [ ] Implement with `StatusChip`, `Icon`, `KebabMenu` and the existing classes per 11.4; the vendored inline styles become `md-` rules with the same numbers. Check both skins against the vendored file's Event page view in a browser. `EventDetailPage.js` must not grow: compare `wc -l` before and after.
- [ ] **Walk on the dev server** (rebased onto Lane 3 if it has merged, else against main's unchanged print routes): upload a print file, download it, replace it, remove it, mark no menu needed and undo it, and replace, remove and re-upload a client image, checking the drink plan card and the house-menu button still read the new image. Generate from the card with the box key; the thumbnail fills from `?w=240` layers.
- [ ] Run a consistency check of the new card against the two deleted cards and their test (fold parity), then commit.

**Lane 4 exit:** the client suites above plus `downloadMenuPrint.test.js`, `EventDetailPage.fork.test.js` and `PrivacyPage.test.js` green, and `CI=true npm run build` in `client/` clean. Then one reviewer, the consistency check, and `ui-ux-review` (the Event page view in every table C state, both skins, and the printed menu against the 2026-10-01 boards' cases in spec 14 with the mark in all three colors), then merge.

---

## Lane 5: menu-designer-editor

Cut after Lanes 3 and 4 are on main. **Owns the visual fidelity of the editor.** The working input is `Menu Designer v2.dc.html` in its **Editor** view (tables B, E and D).

### Task D1: the shell, the open state and the sidebar override

**Spec:** 4.2, 10.1 (Closing and leaving, The rail is a temporary override), 11.1 (The editor, Top bar, Confirm dialog), Review Focus 7.
**Files:** `MenuEditor.js`, `EditorBanner.js`, `ConfirmDialog.js`, the `md-` editor block in `index.css`; `EventDetailPage.js` (reads `?menu=1`, passes `onOpenEditor` to the card, renders `MenuEditor` in place of the body while open); `UserPrefsContext.js` (`sidebarOverride` as its own `useState`, never a key inside `prefs`; the `data-sidebar` write uses `sidebarOverride || prefs.sidebar` with `sidebarOverride` in the effect's deps; both in the memoized value); `Sidebar.js` (`rail` reads `sidebarOverride || prefs.sidebar`; the footer collapse toggle is not rendered while the override is set); the new `UserPrefsContext.test.js`.

- [ ] Tests:
  - opening sets `?menu=1`; browser Back and Escape close; a different event id drops the editor; focus moves to the back button and returns to the opener;
  - closing with the back button or Escape awaits `flush()`; a failed flush asks "Close anyway" / "Stay", and Close anyway keeps the edits in the page's hook with the card on Save failed; browser Back closes at once and a failed flush afterwards shows as Save failed on the card;
  - the top bar's label, chip, save text, Retry, and Approve's label and disabled reasons;
  - every table B banner (with the chips' fixed hues), stacked when two apply;
  - the confirm dialog's texts, Escape, Cancel and focus return;
  - the sidebar: the editor never calls `setPref`, the footer toggle is hidden while open, and the override clears on close and on unmount; `UserPrefsContext.test.js` shows `html[data-sidebar]` follows the override while the saved pref and localStorage stay untouched.
- [ ] Implement, pass, commit. `EventDetailPage.js` must still not exceed its pre-Lane-4 line count.

### Task D2: the tabs, the panel footer and on-canvas editing

**Spec:** 4.3 to 4.5, 11.1 (Right panel, Design, Drinks and Brief tabs, Panel footer, On-canvas editing, table E).
**Files:** `DesignTab.js`, `DrinksTab.js`, `BriefTab.js`, `MenuCanvas.js` (its editable mode), the `md-` panel rules.

- [ ] Tests:
  - tabs: the default (Design with a draft, Brief without), the switch to Drinks on a drink click, Design and Drinks inert (attribute set through a ref) until the words land;
  - Design: choosing a pairing resets ink and accent; the swatch rings; the Background row's "Version n" and " · Gemini" only on a done Gemini piece; the mark switch hides the Wordmark color row;
  - Drinks: "<k> of 8 illustrated", the row statuses, "New from plan" from `added_by_sync`, " · Gemini" only on done Gemini art, hidden rows struck through, the open row's 200-character note, Re-roll art disabled when no image remains;
  - Brief: the role `.seg` with Placement and Backing under Logo; an upload while the planner image is the style ref flips it to Ignore; Remove flips it to Ignore; a dropped file is taken like Upload; after a draft exists a new file is staged with "Applies when you start over"; the edited-field tint and "The client image changed" note;
  - the panel footer: GPT Image selected on mount, Gemini disabled with its title when not configured, Generate and Start over labels, `cap.remaining` gating and hints;
  - on-canvas editing: click-to-edit text commits on blur and Enter into autosave; the dotted underline until edited; selecting a drink shows the two pills (no Re-roll pill when no image remains); the painting, waiting and failed slots; the background-painting ground; the Too long outline; reduced motion stops the sheens; table E's empty cards, including Words failed.
- [ ] Implement, pass, commit. Check both skins against the vendored file's Editor view in a browser.

### Task D3: export (`exportMenu.js`) and Approve

**Spec:** 8 (Approve 1, expected_print_key), 10.3 (Loading), 11.3, Review Focus 4.
**Interface:** `exportMenu({ draft, images, fonts })` resolves to a JPEG `Blob` at 2400 x 3000. It injects or awaits the font link (10 s timeout), runs `document.fonts.load` for each face of the current pairing (10 s each), and waits for every layer image, including both mark images (10 s each). It renders a hidden unscaled `MenuCanvas` with `editable={false}` (the wordmark pre-tinted, drink images square, 11.3 and 10.2) through `html2canvas` at scale 3, then `toBlob('image/jpeg', 0.92)`.

- [ ] Tests:
  - a font timeout rejects naming the font; a missing layer, the mark images included, rejects naming it;
  - the happy path calls `html2canvas` with scale 3 and returns a JPEG blob (mock `html2canvas`);
  - Approve: `flush()`, then export, then a POST with `version`, `art_version` and `expected_print_key`; the confirm shows whenever the event already has a print file; a 409 (`MENU_DRAFT_CHANGED` or `MENU_PRINT_CHANGED`) shows the "Couldn't approve." banner with the reason and refetches;
  - Approve is disabled while generating, too long, with a failed drawing, approving or approved (a pending save is flushed first, not a reason to disable);
  - an export failure reports to client Sentry with `{ area: 'menu-designer', step: 'export' }`.
- [ ] Implement, pass, commit.

### Task D4: the end-to-end walk and review

**Spec:** 14 (Visual, Live smoke). Run by the controlling session (it needs the admin dev JWT).
- [ ] On a lane-scoped dev server with both box keys:
  1. From the event page, open the editor from the card; set a role and an art direction on the Brief tab; close and reopen it (the inputs survive); Generate with GPT Image.
  2. Edit a name; re-roll one drink under Gemini; hide one; switch the pairing, the backing and the wordmark color.
  3. Approve, through the replace confirm when a print file exists.
  4. Close the editor with Escape: the card shows Approved, and the sidebar is back to the saved layout (reload the page to confirm the saved pref did not change).
  5. Download from the card, and as staff from the shift page.
  6. Check that edited since approval (one more edit), plan changed (edit the dev plan's drinks), notes edited (edit the dev plan's design notes) and a replaced client logo all render on the card and in the editor.
  7. Check the JPEG is 2400 x 3000 and under 10 MB, the wordmark printed in its color, and the drinks are not stretched.
  8. Use browser Back while the editor is open, and switch events through the header search while it is open.
- [ ] Run `ui-ux-review` against `Menu Designer v2.dc.html`'s Editor view: both skins, tables B and E, table D applied.
- [ ] Remove `GEMINI_API_KEY` from the repo-root `.env` (spec 13: the dev box keeps it only for the smoke and this walk).
- [ ] Update README's Key Features. Commit.

**Lane 5 exit:** the client suites green, plus `MorePage.test.js`, `AdminLayout.badges.test.js`, `adminos/nav.test.js`, `EventDetailPage.fork.test.js` and `UserPrefsContext.test.js` (the shell change reaches them), and `CI=true npm run build` in `client/` clean. Then one reviewer plus `ui-ux-review`, then merge.

---

## Lane 6: menu-designer-phone (follow-up)

Cut after Lane 5 is on main (decision 13). **Full fleet:** `EventDetailPhone.js` is sensitive-listed. **Owns the phone screens' fidelity.** The working input is `Menu Phone.dc.html`, framed five ways by `Menu Designer Mobile.dc.html` (01 event card, 02 viewer, 03 Edit sheet, 04 Drink sheet, 05 Approve), with table D applied (no separate PDF button; the printed menu is the 2026-10-01 one, not `menu-art.js`'s drifted copy). It reuses `MenuCanvas`, `useMenuDraft`, `menuCardState` and `exportMenu` unchanged. `client/src/components/mobile/*` (`EditSheet`, `AssignmentSheet`, `useEditSheet` are sensitive) is pattern-copied into `pages/mobile/menu/`, never edited. Text and brief edits stay on desktop; the screens say so and link to the Desktop view.

**Data:** the phone page reads the drink plan only as `fields=day_of_contact`, on purpose (the full plan carries the token and internal notes). The cards read everything from the menu-draft GET instead: `plan.drinks`, `plan.bar_summary` and `plan.drink_count` (Lane 2, E5), the draft, the print state and the `?w=240` / `?w=480` layers. With no plan or no key, the cards show table C's rows.
**Navigation:** the viewer and its sheets are a new `menu` drawer kind in `EventDetailPhone`'s `SHEETS` / drawer parameter, so Back behaves as for the existing sheets. No `App.js` route.

### Task M1: the phone drink plan card

**Spec:** 11 (Phone), decision 13. **File:** `PhoneDrinkPlanCard.js`, mounted in `EventDetailPhone.js`, whose phase-1 "Not on the phone" comment loses the drink plan card.
- The drinks with a Mocktail tag and the "+ beer & wine, spirits, NA" line from `plan.bar_summary`; no shopping-list Approve (that stays on desktop).
- [ ] Tests; implement; commit.

### Task M2: the phone bar menu card

**File:** `PhoneBarMenuCard.js`; the comment loses the menu print block and the plan logo.
- An 84 x 105 thumbnail (`?w=240`), table C's chip, message and sub, a full-width 44 px **View** that opens the `menu` drawer; the fold's Print file row with a 44 px **Download** when a file exists, and the Client image row read-only.
- [ ] Tests per table C's chip and actions on the phone; implement; commit.

### Task M3: the viewer and the Approve sheet

**Files:** `PhoneMenuViewer.js`, `MenuApproveSheet.js`, the `m-` block in `index.css`.
- The viewer: table B's banner, the meta row, the canvas at 358 px wide (`?w=480` layers), the hint "Tap a drink to re-roll or hide it. Text edits are on desktop.", and a bottom bar with **Edit** (secondary) and **Approve** (primary, the same disabled rules), each 48 px.
- Approve sheet: "Approve this menu?" with the print-file text, **Approve print file** and Cancel; it runs `exportMenu` on the phone (full-size layers fetched at Approve time) and posts with `expected_print_key`.
- [ ] Tests; implement; commit.

### Task M4: the Edit sheet

**File:** `MenuEditSheet.js`. Font pairing (a row to the six-pairing list, each "Bar Menu" in its face with a check), Accent color (44 px targets around 28 px swatches), Text backing (three 44 px buttons), Hidden drinks (a row to a Show list, only when any are hidden), Re-roll background ("Version n"), and "Edit text and brief on desktop".
- [ ] Tests; implement; commit.

### Task M5: the Drink sheet

**File:** `MenuDrinkSheet.js`. The description, **Re-roll art**, **Hide from menu**, and "Edit name and description on desktop". The image model is the same in-memory choice, starting at GPT Image.
- [ ] Tests; implement; commit.

### Task M6: the Pixel walk and review

- [ ] On the phone recipe (the Pixel review recipe and the phone gate traps in memory), walk M1 to M5 end to end on a dev event, including Approve, a check that the exported JPEG is 2400 x 3000, and a download as staff.
- [ ] `ui-ux-review` against `Menu Phone.dc.html` in both skins. Then the full fleet, then merge. On main after the merge, add the Pixel walk to `docs/walkthroughs-owed.md` (Tier 3b) until Dallas walks it, and update README's `pages/mobile/menu/` row and ARCHITECTURE's desktop-only list in the lane.

---

## After the lanes

- The fix-list item "Admin cannot download the menu print file" is already marked shipped (`7a1aa28b`); nothing to do for it here.
- Add a `docs/walkthroughs-owed.md` entry: the first real use on an upcoming custom event, compared with hand-made quality, trying both image models.
- **Push** (Dallas's cue only). Dallas adds `OPENAI_API_KEY` in Render and sets the monthly budget on the OpenAI project first. `GEMINI_API_KEY` is optional and must come from a billing-enabled AI Studio project with a hard ceiling (spec 13), preferably separate from the reviewer's.
