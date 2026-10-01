# Menu Art Generator: design

**Date:** 2026-10-01
**Status:** brainstormed and approved section by section with Dallas on 2026-10-01 (flow, generation, storage and approval, failures and testing).
**Visual design:** in progress in claude.ai/design from the brief at `win-share/2026-10-01-menu-designer-design-brief.md` (also in Claude Drop, Drive file `1bjT0sEG0PyL7M7fRjZhXpZtYHrZ33hE4`). See section 11, which gates the page lane on it.

## 1. Goal and scope

Custom bar menus are hand-made today. 28 of the 56 submitted drink plans in prod chose "Custom Menu Design" (`selections.menuStyle = 'custom'`), and only 5 of those 28 have a print file posted. This feature generates a custom 8x10 menu for one event from its drink plan. An AI paints the art (one themed background plus one illustration per drink), the app lays real, editable text on top, Dallas reviews and edits, and Approve posts the final file into the event's existing bar menu print slot.

**In scope**
- A designer page per event, launched from the "Bar menu print" card.
- Server-side generation through OpenAI (words and images), stored as a draft with per-image pieces.
- Approve into the existing `proposals.menu_print_key` slot through the same code path as a manual upload.
- Fix-list item "Admin cannot download the menu print file" (`docs/fix-list-remaining-2026-07-02.md`, Admin UI): an admin download route and button on the card.

**Out of scope**
- A separate planner "inspiration image" upload. Deferred by Dallas to the fix list (Potions section, entry dated 2026-10-01). v1 works around it with a role picker (section 4).
- The mobile admin PWA. Desktop only.
- Any client-facing view of a draft. Drafts are admin-only; the client never sees them.
- Illustrations of beer, wine, or spirit bottles. Only cocktails and mocktails get art, which also avoids drawing real brand bottles.
- Automatic generation on plan submit. Generation is a manual button.
- Changes to the house (Standard) menu, which keeps its existing PNG button (`MenuPNG.jsx`).
- Deleting orphaned R2 objects. `storage.js` exposes no delete; this follows the menu-print and logo precedent.
- The "menu ready" staff notification (fix list, Staff section). It will hook into the shared helper this feature creates (section 8) when that item is built.

## 2. Verified context

- **The print slot.** `server/routes/proposals/menuPrint.js` (mounted in `server/routes/proposals/index.js`) owns `POST/PATCH/DELETE /api/proposals/:id/menu-print`. POST sniffs magic bytes (PDF, PNG, JPEG only), uploads to R2 under `menu-print/<proposalId>/<uuid>.<ext>`, sets `menu_print_key` and clears `menu_not_required`, then calls `reaccrueDuty(id)`, which re-reconciles the $5 `menu_print` duty line (`server/utils/dutyLines.js`, `payrollAccrual.maybeReaccrueForDuty`). Staff download through `GET /api/shifts/:shiftId/menu-print` (`server/routes/eventDetails.js`), an R2 proxy with a per-proposal key-prefix and traversal guard. There is no admin read route today.
- **The card.** `client/src/components/AdminMenuPrintBlock.js` on `client/src/pages/admin/EventDetailPage.js` (672 lines, near the 700 soft cap) shows Upload / Replace / Remove / "No menu needed". Client-side size check mirrors the server's 10 MB `MAX_FILE_SIZE`.
- **Prior art for rendering.** `client/src/components/MenuPNG/MenuPNG.jsx` renders `MenuPreview variant="print"` (768x960 canvas) with `html2canvas` at scale 3 in the browser.
- **The plan.** `GET /api/drink-plans/by-proposal/:proposalId` returns the event's plan as the lowest-id plan on the proposal (`ORDER BY dp.id LIMIT 1`; `proposal_id` is not unique). The menu brief is `selections.menuTheme`, `selections.drinkNaming`, `selections.menuDesignNotes`. Drinks are `selections.signatureDrinks` and `selections.mocktails` (catalog ids) plus `selections.customCocktails` (client-typed name strings, no recipe). Bar picks are category labels: `beerFromFullBar` / `beerFromBeerWine` ("Light / Easy Drinking", "Craft / Local", "IPA", "Seltzer", "Non-Alcoholic", "Non-Alcoholic (Athletic Brewing)", "None"), `wineFromFullBar` / `wineFromBeerWine` ("Red", "White", "Sparkling", "Other", "None"), `spirits` ("Vodka", "Tequila", "Whiskey", "Gin", "Rum", "Scotch", "Other") plus `spiritsOther`.
- **Descriptions.** `cocktails.description` and `mocktails.description` (edited through the Potions section) cover all 37 active drinks and all 103 drink picks across the 28 custom plans. 17 client-typed custom cocktails have no description.
- **The planner image.** The planner's only image upload is `LogoUploadField` ("Add your logo (optional)"), writing `selections.companyLogo` (a URL) and `selections._logoFilename` (R2 key under `drink-plan-logos/`). Clients put mood boards there. 7 of the 28 custom plans have one.
- **Storage.** `server/utils/storage.js` exports `uploadFile(buffer, key)` and `getSignedUrl(key)` only.
- **Libraries.** `sharp` is a server dependency. `html2canvas` is a client dependency. The `openai` npm package is NOT installed. The client already fetches R2-proxied files as blobs through `api.js` (`BeoSections.js`, `api.get('/shifts/:id/menu-print', { responseType: 'blob' })`).
- **OpenAI.** The key at `~/.secrets/openai_api_key` (account contact@drbartender.com) is valid and lists `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` and `gpt-5.4-mini`. Per OpenAI's docs (2026-10-01): `background: "transparent"` with png/webp output is supported; sizes are any WxH with both sides multiples of 16, edge at most 3840, and above 2560x1440 is labeled experimental; reference images can be passed to generate new images. Older image models (`gpt-image-1`, `-1.5`, `-1-mini`) shut down 2026-12-01. A new account tier allows 5 images per minute.
- **Rate limiters.** `adminWriteLimiter` is 10/min per user. `beoReadLimiter` is 60 per 15 minutes, too tight for a page polling every 2 seconds.

## 3. Decisions (from the brainstorm)

1. The AI paints art only; the app renders real text on top, so every word is exact and editable.
2. Per-drink illustrations, as in Dallas's sample menus (`client/public/menu-samples/39.webp`, `40.webp`).
3. The line under each drink is its Potions description, verbatim.
4. Generation is manual, from a button on the event page.
5. The client's logo goes at the top when used; the Dr. Bartender mark sits in a bottom corner with a toggle, on by default.
6. One optional reference image per draft, from Dallas's computer or the client's planner image. Style only, never placed on the menu.
7. Approach A: OpenAI for all AI calls, browser renders the final file, Approve posts into the existing print slot.

## 4. What Dallas sees and does

1. The "Bar menu print" card gets **Design menu** (shown when the event has a drink plan) and **Download** (shown when a print file exists).
2. **Design menu** opens `/events/:id/menu`, a full page: brief on the left, live 8x10 preview on the right.
3. Brief panel:
   - The client's theme, naming notes and design notes, read-only.
   - The planner image (if any) with a role picker: **Logo on top** (default) / **Style reference** / **Ignore**.
   - **Reference image**, optional, one total: the planner image when its role is Style reference, otherwise an optional upload (JPEG, PNG or WebP). Choosing an upload while the planner image is set to Style reference flips the planner image to Ignore.
   - **Art direction**, free text, up to 500 characters.
   - **Dr. Bartender mark** switch, on by default.
   - **Generate**. Once a draft exists it reads **Start over** and replaces the draft after a confirm.
4. Generation fills the preview progressively: words within seconds, then the background, then each drink one at a time. Pending slots are visible.
5. Editing on the preview: click any text to edit it in place; per drink **Re-roll art** (optional one-line note) and **Hide from menu**; background **Re-roll**; **Font pairing** picker; **Text color** picker. With more than 8 drinks, Dallas picks which 8 get art and the rest list as text. Edits autosave.
6. **Approve** renders the final file and posts it to the print slot, confirming first when a print file already exists.
7. States: empty, generating, ready, a piece failed, plan changed, approved, edited since approval, print file replaced by a manual upload.

## 5. Generation pipeline

### 5.1 OpenAI wrapper

`server/utils/openaiClient.js` is the only place that requires the `openai` package (the `stripeClient.js` precedent). It exports `isConfigured()`, `draftMenuCopy(input)`, `generateImage(opts)` and `editImage(opts)`. With `OPENAI_API_KEY` unset, `isConfigured()` is false, every call throws `ExternalServiceError('openai', ...)`, and the page shows "Menu art is not set up" instead of Generate. Model ids come from env (section 13), never literals in code, because the image lineup turns over within months.

### 5.2 Step 1: the words

Deterministic fields are filled by the server and never sent to the model for authoring:
- each catalog drink's name and description, from `cocktails` / `mocktails`;
- the "also at the bar" lines, from the bar picks through a fixed label table in a pure helper (`server/utils/menuAlsoAtBar.js`): beer categories become "Light beer", "Craft beer", "IPA", "Seltzer"; wine becomes "Red", "White", "Sparkling"; spirits are listed by name plus `spiritsOther`; "Non-Alcoholic (Athletic Brewing)" becomes "Athletic Brewing NA"; "None" and "Other" render nothing. Dallas adds brand names by editing.

One structured-output call (`MENU_ART_TEXT_MODEL`) receives the brief, the drink list (key, catalog name, catalog description or "client-typed"), and the event type, and returns JSON validated against a schema:
- `title` (default "Bar Menu");
- per drink: `display_name` (the client's rename applied, or a themed name when the brief asks for one), `name_ai_suggested` (true when the name is invented rather than taken from the catalog or a client's explicit rename), `description` only for client-typed drinks (marked `description_ai_written`), and `visual_note` (glass, color, garnish) for the illustrator;
- `font_pairing` (one id from the curated set, section 10.3) and `ink_color` (hex).

A catalog drink's description is always the catalog text, whatever the model returns. Output that fails schema validation fails the words step cleanly (section 12). The drink art follows `visual_note`, so a renamed drink is still drawn as what it is.

### 5.3 Step 2: the background

One call to `MENU_ART_IMAGE_MODEL` at `MENU_ART_BACKGROUND_SIZE` (default `2560x3200`, 4:5; fallback configurable to `1664x2080`), quality high, JPEG output. The prompt is built from the theme, colors, art direction and design notes, and always asks for decorative edges, a calm low-detail center for text, and no lettering, words or numbers anywhere. When a reference image is set, the call goes through the edit endpoint with that image as a style reference.

### 5.4 Step 3: the drinks

One call per visible drink, sequential, at 1024x1024, `background: "transparent"`, PNG output, through the edit endpoint with the background (downscaled to 1024 px wide with `sharp` to cut input cost) as the style reference, plus the reference image when set. The prompt carries the drink's `visual_note` and asks for a single isolated illustration with no text and no background. A re-roll appends Dallas's optional note to the prompt.

### 5.5 Running the job

- **Generate** creates or replaces the draft with a fresh `run_id`, bumps `version`, inserts one pending piece per image (the background plus each drink with `has_art`), returns 202, and starts the job with `setImmediate` off the response path (the `reaccrueDuty` precedent). Generate always supersedes a run in progress (that is how Start over aborts a bad run); the client disables the button while the request is in flight.
- The job runs words, then background, then drinks in order. Each piece moves `pending → working → done | failed` with `started_at` / `finished_at`. When a piece reaches `done`, the job bumps `menu_drafts.art_version`.
- **Superseded runs.** Every write is conditional on the draft's current `run_id` (and the piece's own `run_id` for a re-roll), and the job re-reads the `run_id` before every OpenAI call and stops when it has moved. A run replaced by Start over, or a piece replaced by a newer re-roll, writes nothing and spends nothing further.
- **Restart safety.** A piece in `working` with `started_at` older than 3 minutes is reported as `failed` (reason "interrupted") on read, and its re-roll is allowed. No scheduler is involved.
- **Re-roll** creates a new `run_id` for that piece only and runs it the same way. A re-roll of a piece already `working` (and not stale) is refused with 409. Re-rolling a drink with `has_art` but no piece row (art turned on after generation) creates the row. Re-rolling the background does not re-roll the drinks; Dallas re-rolls any drink that no longer matches.
- **Rate limits.** A 429 waits for `Retry-After` (capped at 60 s) and retries up to 3 times, then fails the piece.
- **Refusals.** An OpenAI moderation refusal fails the piece with OpenAI's reason text.
- **Daily cap.** Every image call writes a row to `menu_art_calls` before it is sent. Generate, re-roll and add-drink are refused with 429 and a reset time when the rolling 24-hour count across all events has reached `MENU_ART_DAILY_IMAGE_CAP` (default 60). Generate checks that the whole run fits.
- **Errors.** Job failures are captured to Sentry with tags `{ route: 'menuArt', step }` when `SENTRY_DSN_SERVER` is set.

## 6. Data model

Added to `server/db/schema.sql` with idempotent statements.

**`menu_drafts`** (one per event)
- `id SERIAL PRIMARY KEY`
- `proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE`
- `drink_plan_id INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL`, the plan it was generated from
- `run_id UUID NOT NULL`
- `inputs JSONB NOT NULL`: `planner_image_role` (`logo` | `reference` | `ignore`), `reference_key` (R2 key or null), `reference_source` (`none` | `planner` | `upload`), `art_direction`, `drb_mark`
- `content JSONB NOT NULL`: `title`, `drinks[]` (`key`, `source` `catalog` | `custom`, `catalog_kind` `cocktail` | `mocktail` | null, `catalog_id`, `display_name`, `description`, `name_ai_suggested`, `description_ai_written`, `visual_note`, `hidden`, `has_art`), `also_at_bar[]` (`label`, `text`), `font_pairing`, `ink_color`, and the words step's `status` / `error`
- `plan_fingerprint JSONB NOT NULL`: sorted drink keys at generation time, plus a SHA-256 of the three brief fields
- `version INTEGER NOT NULL DEFAULT 1`, bumped by every content or inputs write (edits, Generate, add-drink)
- `art_version INTEGER NOT NULL DEFAULT 0`, bumped by the job whenever a piece reaches `done`
- `approved_version INTEGER`, `approved_art_version INTEGER`, `approved_print_key TEXT`, `approved_at TIMESTAMPTZ`, `approved_by INTEGER REFERENCES users(id)`
- `created_at`, `updated_at` with the standard `update_updated_at_column` trigger

Drink keys are `cocktail:<id>`, `mocktail:<id>`, and `custom:<lowercased trimmed name>`.

**`menu_draft_pieces`** (one per image)
- `id SERIAL PRIMARY KEY`
- `draft_id INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE`
- `piece_key TEXT NOT NULL` (`background` or a drink key), `UNIQUE (draft_id, piece_key)`
- `run_id UUID NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed'))`
- `r2_key TEXT`, `error TEXT`, `reroll_note TEXT`, `started_at`, `finished_at`

**`menu_art_calls`** (one per image call; the cap's ledger and the cost record)
- `id SERIAL PRIMARY KEY`, `proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL`, `piece_key TEXT`, `model TEXT NOT NULL`, `size TEXT NOT NULL`, `ok BOOLEAN`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, indexed on `created_at`

The words and the art never share a writer. The background job writes `menu_draft_pieces` and the `art_version` column, plus exactly one fill of `content` by the words step, conditional on `run_id`; that fill lands before any edit is possible, because the page renders the words only after it lands. Every other `content` write (PATCH, add-drink) happens inside a request under the `version` check. A PATCH and a job write touch different columns of `menu_drafts`, so neither can clobber the other.

**R2 keys.** `menu-art/<proposalId>/<runId>/<pieceKeySlug>-<uuid>.<ext>` for art; `menu-art/<proposalId>/ref-<uuid>.<ext>` for uploaded references. The planner image is read by its existing `_logoFilename` key and never copied.

## 7. API

New route file `server/routes/proposals/menuDrafts.js`, mounted in `server/routes/proposals/index.js` beside `menuPrint`. Every route: `auth`, `requireAdminOrManager`, `asyncHandler`, integer-validated `:id`, 404 when the proposal does not exist.

| Method and path | Limiter | Does |
|---|---|---|
| `GET /api/proposals/:id/menu-draft` | `menuDraftReadLimiter` | Draft, pieces (with stale-working reported as failed), the plan brief, the staleness diff (section 9), print-slot status, cap usage, `configured` |
| `POST /api/proposals/:id/menu-draft/generate` | `adminWriteLimiter` | Multipart: optional `reference` file plus `planner_image_role`, `reference_source`, `art_direction`, `drb_mark`. 422 when the plan has no drinks; 429 when the run would exceed the cap. Supersedes any run in progress. Returns 202 |
| `PATCH /api/proposals/:id/menu-draft` | `menuDraftEditLimiter` | Body `{ version, content?, inputs? }`; 409 on version mismatch; validates and bumps `version`. `inputs` here may change `planner_image_role` and `drb_mark` only |
| `POST /api/proposals/:id/menu-draft/pieces/:pieceKey/reroll` | `adminWriteLimiter` | Body `{ note? }` (max 200 chars). 202 |
| `POST /api/proposals/:id/menu-draft/drinks` | `adminWriteLimiter` | Body `{ key, version }`, a key from the staleness diff's `added`. Inside the request: catalog fields directly, or for a client-typed drink a one-drink words call (seconds); then the content write under the version check (409 on mismatch). Then queues the drink's art. 202 with the new `version` |
| `GET /api/proposals/:id/menu-draft/pieces/:pieceKey/image` | `menuDraftReadLimiter` | Streams the piece's R2 object. Key must start with `menu-art/<id>/` and contain no `..` or `//` |
| `GET /api/proposals/:id/menu-draft/reference` | `menuDraftReadLimiter` | Streams the uploaded reference image (key under `menu-art/<id>/`) |
| `GET /api/proposals/:id/menu-draft/planner-image` | `menuDraftReadLimiter` | Streams the plan's planner image by `_logoFilename` (key must start with `drink-plan-logos/`, the guard `drinkPlans.js` already applies). Used for the logo layer and the thumbnail, so the export never loads a cross-origin image |
| `POST /api/proposals/:id/menu-draft/approve` | `adminWriteLimiter` | Multipart `file` plus `version` and `art_version`. Section 8 |
| `GET /api/proposals/:id/menu-print` | `menuDraftReadLimiter` | In `menuPrint.js`. Admin download of the current print file, same R2 proxy and guard as the staff route |

New limiters in `server/middleware/rateLimiters.js`: `menuDraftReadLimiter` (120 per minute per user, for polling and image loads) and `menuDraftEditLimiter` (30 per minute per user, for debounced autosave). Both keyed by user id like `adminWriteLimiter`.

Upload validation: the reference upload accepts JPEG, PNG and WebP by magic bytes (`fileValidation.js`); the approve upload accepts JPEG only.

## 8. Approve and the print slot

1. The browser waits for `document.fonts.ready` and every layer image, renders the 800x1000 print canvas with `html2canvas` at scale 3, and exports `image/jpeg` at quality 0.92 (a full-color 2400x3000 PNG can exceed the 10 MB upload cap).
2. It posts the file with the draft `version` and `art_version` it rendered.
3. The server refuses with 409 when either no longer matches, or when any piece the layout uses is not `done`. It checks JPEG magic bytes, and checks with `sharp` that the image is exactly 2400x3000.
4. It writes the file through `postMenuPrintFile(proposalId, buffer, ext)`, a helper extracted from the existing `POST /:id/menu-print` handler in `menuPrint.js`. That helper owns the R2 upload, the `menu_print_key` / `menu_not_required` update with its rowCount guard, and `reaccrueDuty`. The manual upload route calls the same helper, so the duty line and the card chip behave exactly as today.
5. It stamps `approved_version`, `approved_art_version`, `approved_print_key`, `approved_at`, `approved_by`.
6. Reads derive: **approved** when `version = approved_version`, `art_version = approved_art_version` and `menu_print_key = approved_print_key`; **edited since approval** when either version moved (a word edit or a re-rolled drawing); **replaced by a manual upload** when the key moved.
7. The client confirms before Approve whenever `menu_print_key` is set and differs from `approved_print_key`.

## 9. Plan changed

On every GET, the server recomputes the plan's drink keys (same plan rule as `by-proposal`: lowest `drink_plans.id` for the proposal) and the brief hash, and returns `{ added: [{ key, name }], dropped: [{ key, name }], brief_edited: bool }` against `plan_fingerprint`. The page shows a banner naming added and dropped drinks with **Add to draft** per added drink, and a softer "brief edited since this draft" note when only the brief changed. Dropped drinks are not removed automatically; Dallas hides or keeps them.

## 10. Client

### 10.1 Files

- `client/src/pages/admin/menuDesigner/MenuDesignerPage.js`: the page, routed at `/events/:id/menu` in `App.js` under the existing admin guard beside `/events/:id`.
- `client/src/pages/admin/menuDesigner/BriefPanel.js`, `MenuCanvas.js` (the layered 800x1000 layout, used for both the live preview and the export), `layouts.js` (pure: drink count and options to slot geometry), `fontPairings.js` (the curated set), `useMenuDraft.js` (load, poll every 2 s while any piece is pending or working, autosave PATCH debounced at 800 ms with version tracking).
- `client/src/components/AdminMenuPrintBlock.js`: adds **Design menu** and **Download**.

Each file stays under 300 lines; `EventDetailPage.js` is not grown beyond passing what the card already receives plus a has-plan flag.

### 10.2 Images

Layer images (background, drinks, planner logo) load through `api.get(path, { responseType: 'blob' })` and render from object URLs, so they carry the JWT, never touch a public URL, and never taint the `html2canvas` export. The Dr. Bartender mark is the same-origin `client/public/images/menu-logo-gold.png` the house menu already uses, unless the visual design supplies another. Object URLs are revoked on unmount and on replacement. AI-written text renders as plain React text, never as HTML.

### 10.3 Fonts

About 6 curated pairings (title plus heading plus body), all Google Fonts, loaded by injecting the pairing's stylesheet link the same way `client/public/index.html` loads its fonts. The exact faces come from the visual design (section 11).

## 11. Visual contract

**Benchmark:** the claude.ai/design artifact produced from the brief above, in the Dr. Bartender OS Design System project (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). It covers Part 1, the designer page in the OS skin (all states in section 4), and Part 2, the printed menu layouts: templates for 1 to 8 illustrated drinks, with and without mocktails, client logo and also-at-the-bar lines; the font pairings; and the legibility treatment over unknown art. The quality bar for Part 2 is `client/public/menu-samples/39.webp` and `40.webp`.

**Gate:** the page lane does not start until the artifact is complete, its screens are pulled through DesignSync (`list_files` then `get_file`) and snapshotted under `docs/design-artifacts/2026-10-01-menu-designer/`, and this section is amended with the per-screen layout and composition, the component vocabulary, and the token rule. Token rule for Part 1: design-system tokens map to existing `index.css` tokens. Part 2 does not use OS tokens; its colors come from the draft (`ink_color`) and the pairing. The server lanes do not depend on the artifact and may start first.

**Ownership:** the designer-page lane owns visual fidelity and works from the pulled screen files, not the snapshot. `ui-ux-review` judges that lane against the artifact.

## 12. Failure modes

| Failure | Behavior |
|---|---|
| `OPENAI_API_KEY` unset | `configured: false`; the page shows "Menu art is not set up"; no routes call OpenAI |
| Words step fails (network, billing, quota, bad JSON) | Draft shows the reason with Retry; no image is attempted |
| An image fails | Only that piece is failed, with the reason and a re-roll |
| 429 from OpenAI | Waits `Retry-After` (max 60 s), 3 retries, then fails the piece |
| Moderation refusal | Piece fails with OpenAI's reason; re-roll with a note |
| Server restart mid-run | Pieces stuck `working` over 3 minutes read as failed ("interrupted") |
| Daily cap reached | 429 with used, limit and reset time; nothing is called |
| Plan has no drinks | Generate disabled with the reason; server 422 |
| A picked drink is no longer in the catalog | Treated as client-typed: AI-written description, marked |
| R2 unavailable | `ExternalServiceError`; the piece or approve fails, nothing half-written |
| Browser export fails | Approve shows the error; nothing is posted |
| Draft edited between export and approve | 409 "The draft changed. Approve again." |
| Proposal deleted | Draft and pieces cascade; call log rows keep a null `proposal_id` |

## 13. Configuration and docs

New env vars (CLAUDE.md and README environment tables, `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Enables the feature; unset means off |
| `MENU_ART_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | Image model for background and drinks |
| `MENU_ART_TEXT_MODEL` | `gpt-5.4-mini` | Structured-output model for the words step |
| `MENU_ART_BACKGROUND_SIZE` | `2560x3200` | Background size; `1664x2080` is the non-experimental fallback |
| `MENU_ART_DAILY_IMAGE_CAP` | `60` | Rolling 24-hour image-call cap across all events |

Docs in the same change: README (folder tree, Key Features, env table, tech stack), ARCHITECTURE (route table, the three tables, third-party integrations: OpenAI), CLAUDE.md (env table, Tech Stack: OpenAI). Root `package.json` gains `openai`.

## 14. Testing

- **OpenAI is never called from tests.** `openaiClient.js` is mocked at the module boundary.
- **Pure helpers:** the words-input builder (catalog descriptions verbatim, client-typed drinks marked, keys formed correctly); `menuAlsoAtBar.js` label mapping including "None" and "Other"; the staleness diff (added, dropped, brief edited); stale-working detection; `layouts.js` geometry for 1 to 8 drinks.
- **Routes** (`server/routes/proposals/menuDrafts.test.js`, against the shared dev DB, run from the repo root one suite at a time): auth (unauthenticated and staff refused); generate creates the draft and pieces and refuses at cap and with no drinks; a second generate supersedes the first, and the superseded job writes nothing and makes no further OpenAI call; PATCH version conflict; PATCH never touches pieces or `art_version`; add-drink version conflict; malformed words JSON fails cleanly; re-roll refused while working, allowed when stale; image and planner-image prefix guards; approve rejects non-JPEG, wrong dimensions, a stale `version`, a stale `art_version` and a not-done piece, and on success sets `menu_print_key`, clears `menu_not_required`, stamps approval and calls the duty reaccrual; a re-roll after approval reads as edited since approval.
- **Admin download:** `GET /api/proposals/:id/menu-print` 404 with no file, prefix guard, auth.
- **Existing suites the refactor reaches stay green:** `server/routes/eventDetails.test.js`, `server/utils/dutyLines.test.js`, and any suite exercising `menuPrint.js`.
- **Visual:** `ui-ux-review` against the artifact (section 11).
- **Live smoke on dev:** one real generation end to end against OpenAI (cents), approve onto a dev proposal, staff download from the shift page.
- **Rollout check:** Dallas generates for one or two real upcoming custom events and compares against hand-made quality before approving one for print.

## 15. Review level

The server lane gets the full review fleet: it changes `server/db/schema.sql` (sensitive-listed) and extracts the print-file helper that triggers `payrollAccrual` duty reaccrual. The designer-page lane gets one reviewer, the client test suite, and `ui-ux-review` against the artifact.

## 16. Rollout

1. Server lanes merge first (feature dark until the key is set).
2. Live smoke on dev with the box key.
3. Page lane after the visual contract is filled in.
4. Dallas adds `OPENAI_API_KEY` in Render, then pushes.
5. First real use on an upcoming custom event, compared against hand-made quality.
