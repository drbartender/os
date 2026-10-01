# Menu Art Generator: design

**Date:** 2026-10-01
**Status:** brainstormed and approved section by section with Dallas on 2026-10-01 (flow, generation, storage and approval, failures and testing). Spec fleet (grounding, gaps, risk) run the same day: 1 blocker, 18 warnings, about 20 suggestions, all folded in at Dallas's direction, with his three calls recorded in section 3 (decisions 8 to 10).
**Visual design:** in progress in claude.ai/design from the brief vendored at `docs/design-artifacts/2026-10-01-menu-designer/brief.md`. Section 11 gates the page lane on it.

## 1. Goal and scope

Custom bar menus are hand-made today. 28 of the 56 submitted drink plans in prod chose "Custom Menu Design" (`selections.menuStyle = 'custom'`), and only 5 of those 28 have a print file posted. This feature generates a custom 8x10 menu for one event from its drink plan. An AI paints the art (one themed background plus one illustration per drink), the app lays real, editable text on top, Dallas reviews and edits, and Approve posts the final file into the event's existing bar menu print slot.

**In scope**
- A designer page per event, launched from the "Bar menu print" card.
- Server-side generation through OpenAI (words and images), stored as a draft with per-image pieces.
- Approve into the existing `proposals.menu_print_key` slot through the same helper the manual upload uses.
- Fix-list item "Admin cannot download the menu print file" (`docs/fix-list-remaining-2026-07-02.md`, Admin UI): an admin download route and button on the card.
- One line on the public privacy page naming OpenAI as a provider (decision 10).

**Out of scope**
- A separate planner "inspiration image" upload. Deferred by Dallas to the fix list (Potions section, entry dated 2026-10-01). v1 works around it with a role picker (section 4).
- The mobile admin PWA. Desktop only.
- Any client-facing view of a draft.
- Illustrations of beer, wine, or spirit bottles. Only cocktails and mocktails get art, which also avoids drawing real brand bottles.
- Automatic generation on plan submit.
- Changes to the house (Standard) menu and its PNG button (`MenuPNG.jsx`).
- Deleting orphaned R2 objects. `storage.js` exposes no delete; this follows the menu-print and logo precedent.
- The "menu ready" staff notification (fix list, Staff section). It will hook into the shared helper this feature creates (section 8) when that item is built.

## 2. Verified context

- **The print slot.** `server/routes/proposals/menuPrint.js` (mounted in `server/routes/proposals/index.js`) owns `POST/PATCH/DELETE /api/proposals/:id/menu-print`. POST sniffs magic bytes (PDF, PNG, JPEG), uploads to R2 under `menu-print/<proposalId>/<uuid>.<ext>`, sets `menu_print_key` and clears `menu_not_required` with a bare `pool.query` and a rowCount guard, then calls `reaccrueDuty(id)`, which on `setImmediate` runs `payrollAccrual.maybeReaccrueForDuty`. That reads the proposal through `loadProposalDutyContext` (`server/utils/dutyLines.js`) with no row lock and re-reconciles the $5 `menu_print` duty line. Staff download through `GET /api/shifts/:shiftId/menu-print` (`server/routes/eventDetails.js`), an R2 proxy using `getSignedUrl` plus an 8-second bounded `fetch`, with a per-proposal key-prefix and traversal guard. `server/routes/proposals/menuPrint.test.js` stubs `storage` through `require.cache` before requiring the router. There is no admin read route today.
- **The card.** `client/src/components/AdminMenuPrintBlock.js` on `client/src/pages/admin/EventDetailPage.js` (672 lines) shows Upload / Replace / Remove / "No menu needed".
- **Prior art for rendering.** `client/src/components/MenuPNG/MenuPNG.jsx` renders `MenuPreview variant="print"` (768x960) with `html2canvas` at scale 3 in the browser. The house menu's bar-label mapping is `collapseBeerWine` in `client/src/pages/plan/data/menuSections.js` (all non-Seltzer beer rolls up to "Beer"; spirits are not listed).
- **The plan.** `GET /api/drink-plans/by-proposal/:proposalId` returns the event's plan as the lowest-id plan on the proposal (`ORDER BY dp.id LIMIT 1`; `proposal_id` is not unique). `GET /api/beo/:proposalId/logo` (`server/routes/beo.js`) also proxies a plan logo, but its query has no `ORDER BY`, so this feature adds its own route under the lowest-id rule.
- **Two sides of a plan.** `selections` holds planner output; `consult_selections` holds the admin consult form's output; `shopping_list_source` (`planner` | `consult` | null) names the side the shopping list is built from (`server/db/schema.sql` around the consult columns; `server/utils/shoppingListGen.js` `buildConsultGeneratorInput`; `server/routes/drinkPlans/labListRefresh.js`). In prod, 22 plans are consult-sourced, and in 16 of the 19 comparable ones the consult drinks differ from the planner drinks. The consult shape (`buildGeneratorInputFromConsult`, `server/utils/shoppingList.js`): `signatureDrinks` and `mocktails` are catalog ids; `customCocktails` and `customMocktails` are `{ name, ingredients }` objects; mocktails count only when `mocktailsEnabled` or `barType === 'mocktails'`; `beer` is a boolean (true means the house mix "Light / Easy Drinking", "Craft / Local", "IPA"); `wine` is lowercase categories. The consult side carries no menu brief (`menuStyle`, `menuTheme`, `drinkNaming`, `menuDesignNotes` exist only in `selections`).
- **The planner side.** Drinks are `selections.signatureDrinks` and `selections.mocktails` (catalog ids) plus `selections.customCocktails` (client-typed name strings). Bar picks are category labels: `beerFromFullBar` / `beerFromBeerWine` ("Light / Easy Drinking", "Craft / Local", "IPA", "Seltzer", "Non-Alcoholic", "Non-Alcoholic (Athletic Brewing)", "None"), `wineFromFullBar` / `wineFromBeerWine` ("Red", "White", "Sparkling", "Other", "None"), `spirits` ("Vodka", "Tequila", "Whiskey", "Gin", "Rum", "Scotch", "Other") plus `spiritsOther`.
- **Typed names that match a real drink.** `matchCustomNames(customStrings, candidateRows)` with `loadRecipeCandidates(dbClient)` (`server/utils/shoppingListGen.js`) resolves a typed name to a catalog drink by exact normalized name or `request_aliases`, names before aliases, first wins, over every drink with a recipe including inactive ones. It returns `{ name, ingredients }` only.
- **Descriptions.** `cocktails.description` and `mocktails.description` (edited through Potions) cover all 37 active drinks and all 103 drink picks across the 28 custom plans. Drinks are soft-deleted with `is_active`, never hard-deleted.
- **The planner image.** The planner's only image upload is `LogoUploadField` ("Add your logo (optional)"), writing `selections.companyLogo` (a URL) and `selections._logoFilename` (R2 key `drink-plan-logos/<planId>-<ts><ext>`). Clients put mood boards there. The admin `DELETE /api/drink-plans/:id/logo` strips both.
- **Storage.** `server/utils/storage.js` exports `uploadFile(buffer, key)` and `getSignedUrl(key)` only.
- **Errors.** The global handler (`server/index.js`) serializes an `AppError` as `{ error, code, fieldErrors? }` with `err.statusCode`, and sends `ExternalServiceError` to Sentry. `AppError(message, statusCode, code, fieldErrors)` is constructible directly; `server/routes/stripe.js` throws `new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED')`.
- **Uploads.** `server/utils/fileValidation.js` exports `isValidUpload` (JPEG, PNG, WebP, PDF and more), `isValidImageUpload` (JPEG, PNG only), `safeUploadExtension`. Both `fileValidation.js` and `server/middleware/rateLimiters.js` are on `scripts/sensitive-paths.txt`.
- **Fonts.** `client/public/index.html` only preconnects to Google Fonts. `client/src/components/AdminLayout.js` injects its font stylesheet with the `media="print"` then `onload` swap, which lets `document.fonts.ready` resolve before the faces are declared.
- **Libraries.** `sharp` (server) and `html2canvas` (client) are installed. The `openai` npm package is not. The OpenAI Node SDK defaults to `maxRetries: 2` and a 10-minute timeout. The client already fetches R2-proxied files as blobs through `api.js` (`BeoSections.js`).
- **OpenAI.** The key at `~/.secrets/openai_api_key` (account contact@drbartender.com) is valid and lists `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` and `gpt-5.4-mini`. OpenAI's docs (2026-10-01): `background: "transparent"` with png or webp output is supported; sizes are any WxH with both sides multiples of 16 and edges at most 3840, and above 2560x1440 is labeled experimental; reference images can drive new generations. Older image models shut down 2026-12-01. A new account tier allows 5 images per minute.
- **Rate limiters.** `adminWriteLimiter` is 10 per minute per user; `beoReadLimiter` is 60 per 15 minutes, too tight for polling.
- **Privacy page.** `client/src/pages/website/legal/PrivacyPage.js` names Stripe, Twilio, Resend, Google, Sentry, Cloudflare and Neon. Not OpenAI.
- **Activity log.** `proposal_activity_log (proposal_id, action, actor_type, actor_id, details)`; precedent `server/routes/proposals/lifecycle.js`.
- **Event type.** `getEventTypeLabel({ event_type, event_type_custom })` in `server/utils/eventTypes.js`.

## 3. Decisions

From the brainstorm:
1. The AI paints art only; the app renders real text on top.
2. Per-drink illustrations, as in Dallas's sample menus (`client/public/menu-samples/39.webp`, `40.webp`).
3. The line under each drink is its Potions description, verbatim.
4. Generation is manual, from a button on the event page.
5. The client's logo goes at the top when used; the Dr. Bartender mark sits in a bottom corner with a toggle, on by default.
6. One optional reference image per draft, from Dallas's computer or the client's planner image. Style only.
7. Approach A: OpenAI for all AI calls, the browser renders the final file, Approve posts into the existing print slot.

From the spec review (Dallas's calls):
8. **Drinks come from the side the shopping list uses** (`shopping_list_source`), so the menu matches what is poured. The brief (theme, naming, notes, planner image) always comes from `selections`.
9. **Admin and manager** can use the designer, the same guard as the print card. The daily cap bounds spend.
10. **The privacy page names OpenAI** in the same build.

## 4. What Dallas sees and does

1. The "Bar menu print" card shows **Design menu** when the event's plan has at least one drink on its source side (any plan status), and **Download** when a print file exists.
2. **Design menu** opens `/events/:id/menu`, a full page: brief on the left, live 8x10 preview on the right.
3. Brief panel:
   - The client's theme, naming notes and design notes, read-only (from `selections`).
   - The planner image (if any) with a role picker: **Logo on top** (default) / **Style reference** / **Ignore**.
   - **Reference image**, optional, one total: the planner image when its role is Style reference, otherwise an optional upload (JPEG, PNG or WebP). Choosing an upload while the planner image is Style reference flips it to Ignore.
   - **Art direction**, free text, up to 500 characters.
   - **Dr. Bartender mark** switch, on by default.
   - **Generate**. Once a draft exists it reads **Start over**, which replaces the draft after a confirm.
4. Generation fills the preview progressively: words within seconds, then the background, then each drink. Pending slots are visible. Text editing and the font and color pickers stay disabled until the words land.
5. Editing: click any text to edit it in place; per drink **Re-roll art** (optional note, up to 200 characters) and **Hide from menu**; background **Re-roll**; **Font pairing**; **Text color**; **Text panel** (none, soft, solid) and **Logo placement** (above the title, or replacing it) when the visual design keeps those options. With more than 8 drinks, Dallas picks which 8 get art. Edits autosave with a visible saving / saved / failed indicator.
6. **Approve** first flushes any pending autosave, then renders and posts, disabled and showing progress throughout. It confirms first when a different print file is already posted.
7. States: initial load; load error; not set up (no key); empty (never generated); no drinks on the plan; no plan on the event; generating; words failed (with Retry); a piece failed; daily cap reached (with the reset time); plan changed; brief edited; saving / saved / save failed; save conflict (reloaded); Approve in progress; Approve rejected; approved; edited since approval; print file replaced by a manual upload; print file removed; marked "no menu needed".

## 5. Generation pipeline

### 5.1 OpenAI wrapper

`server/utils/openaiClient.js` is the only module that requires the `openai` package (the `stripeClient.js` precedent). It builds the SDK client with `maxRetries: 0` (the app owns retries, section 5.5) and explicit per-call timeouts (`MENU_ART_IMAGE_TIMEOUT_MS`, default 180000; text calls 60000). It exports `isConfigured()`, `draftMenuCopy(input)`, `generateImage(opts)` and `editImage(opts)`, each returning the payload plus OpenAI's request id. Under `NODE_ENV=test` it refuses every call unless a test has injected a stub, so a missed mock can never spend money. Routes check `isConfigured()` first and throw `new AppError('Menu art is not set up.', 503, 'MENU_ART_NOT_CONFIGURED')`, which does not page Sentry. Model ids come from env (section 13).

**Payload rule.** OpenAI receives only: the event type label (`getEventTypeLabel`), the three brief fields, drink names, catalog descriptions and ingredients, client-typed drink names (and consult ingredients), Dallas's art direction and re-roll notes, the reference image, and the generated background. Never the client's name, email, phone, venue, address or event date. Text calls set `store: false`.

### 5.2 Normalizing the plan

`server/utils/menuDrinkSource.js` turns the plan into one shape, whichever side feeds it:
- **Side:** `consult_selections` when `shopping_list_source = 'consult'`, otherwise `selections` (decision 8).
- **Drinks**, in this order: signature cocktails (catalog ids), then client-typed cocktails, then mocktails (catalog ids), then client-typed mocktails (consult side only; mocktails only when `mocktailsEnabled` or `barType === 'mocktails'` there). Catalog lookups ignore `is_active`, so a deactivated drink keeps its name and description. An id with no row at all is treated as client-typed.
- **Typed names that match a real drink** resolve through the existing matcher. `matchCustomNames` gains an additive `row` field on each matched entry (the candidate row as passed in), and `loadRecipeCandidates` additionally selects `id`, `description` and its `src` as the kind. Existing callers read only `name` and `ingredients`, so both changes are invisible to them. A matched typed name becomes that catalog drink, and a drink both picked and typed appears once.
- **Keys:** `cocktail:<id>`, `mocktail:<id>`, `custom:<slug>`, where the slug is the typed name lowercased with every run of characters outside `a-z0-9` turned into one hyphen, trimmed of hyphens, at most 60 characters. Two typed names with the same slug are one drink (first kept).
- **Bar lines** through a fixed label table (`server/utils/menuAlsoAtBar.js`), deliberately finer than the house menu's `collapseBeerWine`: beer becomes "Light beer", "Craft beer", "IPA", "Seltzer"; "Non-Alcoholic" and "Non-Alcoholic (Athletic Brewing)" become "Athletic Brewing NA" on the Non-Alcoholic line; wine becomes "Red", "White", "Sparkling"; spirits are listed by name plus `spiritsOther`; "None" and "Other" render nothing. The consult side maps `beer: true` to the house mix and its lowercase wine categories to the same labels; a field the side lacks renders nothing. Dallas adds brand names by editing.
- **Brief fingerprint:** the drink keys sorted, plus a SHA-256 over the three brief fields with null as empty, trimmed, and internal whitespace collapsed.

### 5.3 Step 1: the words

Deterministic fields never go to the model for authoring: catalog names and descriptions, and the bar lines. One structured-output call (`MENU_ART_TEXT_MODEL`) receives the brief, the event type label, and the drink list (key, catalog name, catalog description or "client-typed", consult ingredients when present) and returns JSON validated against a schema:
- `title` (default "Bar Menu");
- per drink: `display_name` (the client's rename applied, or a themed name when the brief asks), `name_ai_suggested` (true when invented rather than taken from the catalog or an explicit client rename), `description` only for client-typed drinks (`description_ai_written: true`), and `visual_note` (glass, color, garnish);
- `font_pairing`, one of the fixed ids in section 10.3;
- `ink_color`, `#rrggbb`.

A catalog drink's description is always the catalog text. Output that fails validation fails the words step (section 12).

### 5.4 Steps 2 and 3: the art

- **Background:** one call at `MENU_ART_BACKGROUND_SIZE` (default `2560x3200`; `1664x2080` is the non-experimental fallback), quality high, JPEG output. The prompt is built from the theme, colors, art direction and design notes, and always asks for decorative edges, a calm low-detail center for text, and no lettering, words or numbers. With a reference image, the call goes through the edit endpoint with it as a style reference.
- **Drinks:** one call per drink with `has_art`, sequential, 1024x1024, `background: "transparent"`, PNG output, through the edit endpoint with the background (downscaled to 1024 px wide with `sharp`) plus the reference image when set. The prompt carries `visual_note` and asks for one isolated illustration with no text and no background. A re-roll appends Dallas's note.
- **Default art set:** the first 8 drinks in the section 5.2 order get `has_art`. An added drink gets art when fewer than 8 already have it.
- **Reading images back:** `storage.js` gains `readFile(key)` (`getSignedUrl` plus a bounded `fetch`, the `eventDetails.js` pattern, returning `{ buffer, contentType }`, throwing `ExternalServiceError('r2', ...)` on failure). The job uses it for the background on every drink call and re-roll, the uploaded reference, and the planner image.

### 5.5 Running the job

**Database discipline.** No connection is held across an OpenAI or R2 call. Every write the job makes is a standalone `pool.query`. A request that needs a transaction opens its client only after any R2 or OpenAI work it needs is done, and releases it before `setImmediate` (CLAUDE.md, one pooled connection per request).

**Generate.**
1. Validate and, when a file is attached, upload the reference to R2. No transaction is open yet.
2. One transaction on one client:
   - upsert `menu_drafts` in place (`INSERT ... ON CONFLICT (proposal_id) DO UPDATE`; never delete and recreate, so `version` and `art_version` keep counting);
   - set a fresh `run_id`, bump `version`, and reset the words status to `pending`;
   - release the old run's unspent reservations;
   - delete the old run's piece rows and insert the new pending ones (the background plus each drink with `has_art`);
   - reserve the run's images against the cap (below);
   - COMMIT.
3. Release the client, respond 202, and start the job with `setImmediate`.

Start over keeps the stored reference when no new file is attached and the source is unchanged, and keeps the `approved_*` stamps (the bumped `version` then reads "edited since approval"). A failed words step's **Retry** re-posts Generate with the saved inputs and skips the Start over confirm, since nothing is lost.

**The job.**
- It runs the words, then the background, then the drinks.
- **Heartbeats.** Every piece row carries `heartbeat_at`, set at insert. Before each attempt, and on every retry wait, the job refreshes the heartbeat of the active piece and of every remaining pending piece in its run, in one UPDATE. The words step does the same through `content.words_heartbeat_at`. When a piece reaches `done`, the job bumps `art_version`.
- **Superseded runs.** Every write is conditional on the draft's current `run_id`, or the piece's own `run_id` for a re-roll. Before every OpenAI call the job re-reads it and stops if it has moved. A superseded run writes nothing and spends nothing further.
- **End-of-run sweep.** The job wraps everything in `try/finally`. On any exit, every piece of its run still `pending` or `working` becomes `failed`, with reason "not attempted: <cause>" (for example "the words step failed"), conditional on `run_id`. A words failure therefore fails every image piece at once.
- **Stuck rule (read time).** A piece, or the words step, that is `pending` or `working` with a heartbeat older than `MENU_ART_STALE_MS` (default 300000, above one image timeout plus one retry wait) reads as `failed` ("interrupted"), and its re-roll is allowed. This covers a server restart, which skips the `finally`.
- **Retries.** The job auto-retries a 429 only, waiting `Retry-After` capped at 60 seconds, at most 2 times. 429s are not billed. A timeout, 5xx or connection error fails the piece without retry, because the image may already have been billed. Dallas re-rolls, which reserves again.
- **Refusals.** A moderation refusal fails the piece with OpenAI's reason text.
- **Errors.** Job failures are captured to Sentry by the job itself (`tags: { area: 'menuArt', step }`), since nothing passes through the request error handler.

**Re-roll.**
- It reserves one image (409 `MENU_ART_PIECE_BUSY` while that piece is working and not stuck), sets a new piece `run_id` and pending status, then runs the piece the same way.
- A drink with `has_art` but no piece row gets one created.
- Re-rolling the background does not re-roll the drinks; Dallas re-rolls any drink that no longer matches.

**Daily cap (reservation).**
- Every image is reserved inside the request that asks for it (Generate, re-roll, add-drink), in a transaction that first takes `LOCK TABLE menu_art_calls IN EXCLUSIVE MODE`. (Advisory locks are a no-op on the Neon pooler; a transaction-scoped table lock is not.)
- It then counts rows of kind `image` created in the last 24 hours with status other than `released`, refuses if the request would pass `MENU_ART_DAILY_IMAGE_CAP` (default 60) with `new AppError('Daily menu art limit reached.', 429, 'MENU_ART_CAP_REACHED')`, and otherwise inserts one `reserved` row per image.
- The job moves a reservation to `sent` at the call, then `ok` or `failed`. A superseded run's unspent reservations become `released`.
- One reservation stands for at most one billed image, because only unbilled 429s are retried.
- Text calls are logged as kind `text` and not counted.
- The GET payload carries `cap: { used, limit, resets_at }` for the page.

## 6. Data model

Added to `server/db/schema.sql` with idempotent statements.

**`menu_drafts`** (one per event)
- `id SERIAL PRIMARY KEY`
- `proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE`
- `drink_plan_id INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL`
- `run_id UUID NOT NULL`
- `inputs JSONB NOT NULL`:
  - `planner_image_role`: `logo` | `reference` | `ignore`;
  - `reference_key`;
  - `reference_source`: `none` | `planner` | `upload`;
  - `art_direction`;
  - `drb_mark`.
- `content JSONB NOT NULL`:
  - the words step's `words_status`, `words_error` and `words_heartbeat_at`;
  - `title`;
  - `drinks[]`, each with `key`, `source` (`catalog` | `custom`), `catalog_kind`, `catalog_id`, `display_name`, `description`, `name_ai_suggested`, `description_ai_written`, `visual_note`, `hidden` and `has_art`;
  - `also_at_bar[]`, each with `label` and `text`;
  - `font_pairing`, `ink_color`, `text_panel` and `logo_mode`.
- `plan_fingerprint JSONB NOT NULL` (section 5.2)
- `version INTEGER NOT NULL DEFAULT 1`, bumped by every content or inputs write (edits, Generate, add-drink)
- `art_version INTEGER NOT NULL DEFAULT 0`, bumped by the job when a piece reaches `done`
- `approved_version INTEGER`, `approved_art_version INTEGER`, `approved_print_key TEXT`, `approved_at TIMESTAMPTZ`, `approved_by INTEGER REFERENCES users(id)`
- `created_at`, `updated_at` with the standard `update_updated_at_column` trigger

**`menu_draft_pieces`** (one per image)
- `id SERIAL PRIMARY KEY`
- `draft_id INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE`
- `piece_key TEXT NOT NULL` (`background` or a drink key), `UNIQUE (draft_id, piece_key)`
- `run_id UUID NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed'))`
- `r2_key TEXT`, `error TEXT`, `reroll_note TEXT`, `heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `started_at`, `finished_at`

**`menu_art_calls`** (the cap's ledger, the cost record, the audit trail)
- `id SERIAL PRIMARY KEY`
- `proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL`
- `piece_key TEXT`, `run_id UUID`
- `kind TEXT NOT NULL CHECK (kind IN ('image','text'))`
- `status TEXT NOT NULL CHECK (status IN ('reserved','sent','ok','failed','released'))`
- `model TEXT`, `size TEXT`, `error TEXT`, `openai_request_id TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ`, indexed on `created_at`

**Writers.**
- The job writes `menu_draft_pieces`, `art_version`, `menu_art_calls`, and exactly one fill of `content` by the words step (plus `words_status`, `words_error` and `words_heartbeat_at`), all conditional on `run_id`. The page keeps editing disabled until `words_status = 'done'`, so that fill lands before any edit is possible.
- Every other `content` or `inputs` write (PATCH, add-drink, Generate) happens in a request under the `version` check.
- A PATCH and a job write touch different columns of `menu_drafts`.

**R2 keys.**
- Art: `menu-art/<proposalId>/<runId>/<pieceSlug>-<uuid>.<ext>`, where `pieceSlug` is the piece key with `:` replaced by `-`.
- Uploaded references: `menu-art/<proposalId>/ref-<uuid>.<ext>`.
- The planner image is read by its existing `_logoFilename` and never copied.

## 7. API

New route file `server/routes/proposals/menuDrafts.js`, mounted in `server/routes/proposals/index.js` beside `menuPrint` (before `crud` and `getOne`). Every route uses `auth`, `requireAdminOrManager` (decision 9) and `asyncHandler`, with an integer-validated `:id`, and returns 404 when the proposal does not exist. `:pieceKey` arrives URL-encoded and must match `^(background|(cocktail|mocktail|custom):[a-z0-9-]{1,100})$`.

| Method and path | Limiter | Does |
|---|---|---|
| `GET /api/proposals/:id/menu-draft` | `menuDraftReadLimiter` | Draft, pieces (stuck ones reported as failed), the brief, the staleness diff (section 9), print-slot state (section 8), `cap`, `configured`. With no plan, returns the draft read-only and `plan: null` |
| `POST /api/proposals/:id/menu-draft/generate` | `adminWriteLimiter` | Multipart: optional `reference` plus `planner_image_role`, `reference_source`, `art_direction`, `drb_mark`. 503 not configured; 422 `MENU_NO_DRINKS` (`new AppError(..., 422, ...)`) when the plan has no drinks or no plan exists; 429 at cap. Supersedes any run in progress. 202 |
| `PATCH /api/proposals/:id/menu-draft` | `menuDraftEditLimiter` | Body `{ version, content?, inputs? }`, validated per section 7.1. 409 `MENU_DRAFT_CHANGED` on version mismatch. Bumps `version`; returns the new one |
| `POST /api/proposals/:id/menu-draft/pieces/:pieceKey/reroll` | `adminWriteLimiter` | Body `{ note? }`. Reserves one image. 202 |
| `POST /api/proposals/:id/menu-draft/drinks` | `adminWriteLimiter` | Body `{ key, version }`, a key from the diff's `added`. Catalog fields directly; for a client-typed drink, a one-drink words call runs before any transaction opens. Then one transaction: version check (409), content write, reservation when the drink gets art, COMMIT. Then queues the art. 202 with the new `version` |
| `GET /api/proposals/:id/menu-draft/pieces/:pieceKey/image` | `menuDraftReadLimiter` | Streams the piece. Key must start with `menu-art/<id>/` and contain no `..` or `//` |
| `GET /api/proposals/:id/menu-draft/reference` | `menuDraftReadLimiter` | Streams the uploaded reference. Key must start with `menu-art/<id>/ref-`, no `..` or `//` |
| `GET /api/proposals/:id/menu-draft/planner-image` | `menuDraftReadLimiter` | Streams the planner image of the event's plan (lowest id). Key must start with `drink-plan-logos/<planId>-`, no `..` or `//`. 404 when the plan has none |
| `POST /api/proposals/:id/menu-draft/approve` | `adminWriteLimiter` | Multipart `file` plus `version` and `art_version`. Section 8 |
| `GET /api/proposals/:id/menu-print` | `menuDraftReadLimiter` | In `menuPrint.js`. Admin download of the current print file, prefix `menu-print/<id>/`, same guard as the staff route |

The streaming routes share one helper, `server/utils/r2Proxy.js` (`sendR2Object(res, key, { filename, disposition })`: `readFile`, then `Content-Type`, `Content-Disposition`, `Cache-Control: private, no-cache` and an ETag from the key's digest, as the staff route does). The existing staff and BEO routes are not refactored.

New limiters in `server/middleware/rateLimiters.js`, keyed by user id: `menuDraftReadLimiter` (120 per minute) and `menuDraftEditLimiter` (30 per minute).

Upload checks:
- **Reference:** `isValidUpload(file)` and `safeUploadExtension(file)` returning `.jpg`, `.png` or `.webp`. Anything else, PDF included, is refused.
- **Approve:** JPEG magic bytes only.

### 7.1 Validation (server-enforced; the client mirrors it with `maxLength` and pickers)

| Field | Rule |
|---|---|
| `art_direction` | string, at most 500 characters |
| re-roll `note` | string, at most 200 characters |
| `planner_image_role` | `logo`, `reference` or `ignore` |
| `reference_source` | `none`, `planner` or `upload` |
| `drb_mark` | boolean |
| `title` | 1 to 60 characters |
| `display_name` | 1 to 60 characters |
| `description` | 0 to 200 characters |
| `also_at_bar[].text` | 0 to 120 characters; labels fixed |
| `ink_color` | `^#[0-9a-fA-F]{6}$` |
| `font_pairing` | one of the fixed ids (section 10.3) |
| `text_panel` | `none`, `soft` or `solid` |
| `logo_mode` | `above_title` or `replaces_title` |
| `drinks[]` | PATCH replaces the array, but the set of `key`s must equal the stored set; a PATCH may change `display_name`, `description`, `hidden` and `has_art` only. Adding is add-drink's job; drinks are hidden, never removed |
| `has_art` | at most 8 drinks true |

A PATCH replaces only the top-level `content` and `inputs` keys it sends; anything it omits is untouched. It never writes the words-status fields.

## 8. Approve and the print slot

**Shared helper.** `server/utils/menuPrintFile.js` exports `setMenuPrintKey(executor, proposalId, key)`. It runs the existing `UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2` with its rowCount guard on the executor passed in (the pool or a transaction client). It does NOT upload and does NOT fire duty reaccrual. `reaccrueDuty` moves to that module as an export, and callers fire it after their write is committed.

- **The manual upload (`POST /:id/menu-print`)** keeps today's order: R2 upload, then `setMenuPrintKey(pool, ...)`, then `reaccrueDuty`. `menuPrint.js` still requires `storage` itself, so `menuPrint.test.js`'s `require.cache` stub order is unchanged.
- **Approve:**
  1. The client awaits any pending autosave, then waits for every layer image (10-second timeout per layer; a missing layer fails Approve and names it) and for the fonts (section 10.3). It renders the 800x1000 canvas with `html2canvas` at scale 3, exports `image/jpeg` at quality 0.92, and posts it with the `version` and `art_version` it rendered.
  2. The server checks the JPEG magic bytes, checks with `sharp` that the image is exactly 2400x3000, and uploads it to R2 under `menu-print/<id>/<uuid>.jpg`. No transaction is open yet.
  3. One transaction on one client:
     - `SELECT ... FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE`;
     - refuse with 409 `MENU_DRAFT_CHANGED` when `version` or `art_version` differs from the posted values, or when any piece the layout uses is not `done`;
     - `setMenuPrintKey(client, ...)`;
     - stamp `approved_version` and `approved_art_version` with the posted values, `approved_print_key` with the new key, `approved_at`, `approved_by`;
     - insert `proposal_activity_log` (`action: 'menu_approved'`, `actor_type: 'admin'`, details `{ draft_id, version, art_version, print_key }`);
     - COMMIT.
  4. Release the client, then `reaccrueDuty(id)`.

     A rollback leaves an orphaned R2 object, which is the existing precedent. Because duty reaccrual fires after COMMIT, it always reads the committed key.
- **Derived print state on GET:**
  - **approved** when `version = approved_version`, `art_version = approved_art_version` and `menu_print_key = approved_print_key`;
  - **edited since approval** when either version moved;
  - **replaced by a manual upload** when the key is set and differs from `approved_print_key`;
  - **print file removed** when the key is null and `approved_print_key` is set;
  - **marked no menu needed** when `menu_not_required` is true.
- **Confirm before replacing.** The client asks first whenever `menu_print_key` is set and differs from `approved_print_key`.

## 9. Plan changed

On every GET, the server rebuilds the plan through `menuDrinkSource.js` (lowest-id plan, decision 8's side) and returns `{ added: [{ key, name }], dropped: [{ key, name }], brief_edited }` against `plan_fingerprint`. The page shows a banner naming added and dropped drinks with **Add to draft** per added drink, and a softer "brief edited since this draft" note when only the brief changed. Dropped drinks are not removed; Dallas hides or keeps them. When the event has no plan, the page shows the draft read-only with "No drink plan on this event" and disables Generate and Add to draft.

## 10. Client

### 10.1 Files

- `client/src/pages/admin/menuDesigner/MenuDesignerPage.js`, routed at `/events/:id/menu` in `App.js` under the existing admin guard beside `/events/:id`.
- `BriefPanel.js`, `MenuCanvas.js` (the layered 800x1000 layout, used for the live preview and the export), `layouts.js` (pure: drink count and options to slot geometry), `fontPairings.js` (section 10.3), `useMenuDraft.js`, `exportMenu.js` (font and layer waits, render, JPEG).
- `client/src/components/AdminMenuPrintBlock.js` gains **Design menu** and **Download**.

Each file stays under 300 lines. `EventDetailPage.js` passes what the card already receives plus a has-drinks flag and grows by no more than that.

### 10.2 Data and images

- **Polling.** `useMenuDraft` polls GET every 2 seconds while the words step or any piece is pending or working (after the stuck rule), and stops otherwise. On a 429 it backs off to 10 seconds and shows a quiet "reconnecting" note.
- **Autosave.** Debounced at 800 ms, with a saving / saved / failed indicator. A 409 refetches the draft, drops unsaved local edits, and says "This draft changed elsewhere and was reloaded."
- **Layer images** (background, drinks, planner logo) load through `api.get(path, { responseType: 'blob' })` into object URLs. They are cached by `r2_key` and re-fetched only when a piece's key changes, so an `art_version` bump downloads only the new piece. That keeps the export untainted and stays well inside the read limiter. Object URLs are revoked on replacement and unmount.
- **The Dr. Bartender mark** is the same-origin `client/public/images/menu-logo-gold.png` unless the visual design supplies another.
- **AI-written text** renders as plain React text, never HTML.
- **Export failures** go to client Sentry (`tags: { area: 'menu-designer', step: 'export' }`).

### 10.3 Fonts

**Pairing ids are fixed now,** shared by the server schema and validation (`server/utils/menuFontPairings.js`) and the client (`fontPairings.js`): `elegant-script`, `rustic`, `modern-clean`, `retro`, `spooky`, `tropical`. The visual design assigns each id its faces (title, heading, body) on the client; the server only knows the ids.

**Loading.** A pairing's stylesheet is injected as a plain `<link rel="stylesheet">`. Do NOT use the `media="print"` swap that `AdminLayout.js` uses; it lets `document.fonts.ready` resolve before the faces are declared, and the export would render in fallback fonts. Before rendering, the export awaits that link's `onload`, then `document.fonts.load()` for every face and weight the pairing uses, then `document.fonts.ready`.

## 11. Visual contract

**Benchmark.** The claude.ai/design artifact produced from `docs/design-artifacts/2026-10-01-menu-designer/brief.md`, in the Dr. Bartender OS Design System project (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). It covers:
- **Part 1, the designer page** in the OS skin, every state in section 4.7.
- **Part 2, the printed menu layouts:**
  - templates for 1 to 8 illustrated drinks, with and without mocktails, client logo and also-at-the-bar lines;
  - faces for the six pairing ids;
  - the legibility treatment over unknown art (the `text_panel` options);
  - logo placement (`logo_mode`).

The quality bar for Part 2 is `client/public/menu-samples/39.webp` and `40.webp`.

**Gate.** The page lane does not start until all four of these are done:
- the artifact is complete;
- its screens are pulled through DesignSync (`list_files`, then `get_file`) and snapshotted under `docs/design-artifacts/2026-10-01-menu-designer/`;
- this section is amended with the per-screen layout and composition, the component vocabulary, and the token rule;
- the plan's front-matter records that amendment as the page lane's dependency.

**Token rule.** For Part 1, design-system tokens map to existing `index.css` tokens. Part 2 does not use OS tokens; its colors come from `ink_color` and the pairing.

**Server-lane coupling, made explicit.**
- The server lanes fix the pairing ids, `text_panel` and `logo_mode` now, so they can merge before the artifact.
- If the amendment adds a draft field the server must validate, that amendment reopens the server lane for the schema and PATCH validation before the page lane builds on it.
- An option the design drops is removed from the page, and its value stays at its default.

**Ownership.** The page lane owns visual fidelity and works from the pulled screen files. `ui-ux-review` judges it against the artifact.

## 12. Failure modes

| Failure | Behavior |
|---|---|
| `OPENAI_API_KEY` unset | `configured: false`; page shows "Menu art is not set up"; routes return 503 `MENU_ART_NOT_CONFIGURED`; no Sentry page |
| Words step fails (network, billing, quota, bad JSON) | `words_status = failed` with the reason; the end-of-run sweep fails every image piece "not attempted"; Retry re-posts Generate |
| An image fails | Only that piece fails, with the reason and a re-roll |
| 429 from OpenAI | Wait `Retry-After` (max 60 s), at most 2 retries, then fail the piece |
| Timeout, 5xx, connection error | Fail the piece without retry (may be billed); re-roll reserves again |
| Moderation refusal | Piece fails with OpenAI's reason |
| Server restart mid-run | Heartbeats go stale; after `MENU_ART_STALE_MS` the words step and the run's pending and working pieces read as failed ("interrupted") |
| Daily cap reached | 429 `MENU_ART_CAP_REACHED`; `cap` on GET shows used, limit and reset time; nothing is called |
| Plan has no drinks, or no plan | Generate disabled with the reason; server 422 `MENU_NO_DRINKS` |
| Catalog id with no row | Treated as client-typed, AI-written description, marked |
| Planner image removed after generation, or R2 404 on a layer | That layer shows missing; Approve fails naming it; the logo role reads "planner image removed" |
| R2 unavailable | `ExternalServiceError`; the piece or Approve fails; nothing half-written in the database |
| Browser export fails | Approve shows the error; client Sentry; nothing posted |
| Draft changed between export and approve | 409 `MENU_DRAFT_CHANGED`: "The draft changed. Approve again." |
| Autosave conflict | Draft reloaded, unsaved local edits dropped, the page says so |
| Proposal deleted | Draft and pieces cascade; ledger rows keep a null `proposal_id` |

## 13. Configuration, docs and lists

New env vars (CLAUDE.md and README environment tables, `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Enables the feature; unset means off |
| `MENU_ART_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | Image model |
| `MENU_ART_TEXT_MODEL` | `gpt-5.4-mini` | Structured-output words model |
| `MENU_ART_BACKGROUND_SIZE` | `2560x3200` | Background size; `1664x2080` is the non-experimental fallback |
| `MENU_ART_DAILY_IMAGE_CAP` | `60` | Rolling 24-hour image reservations across all events |
| `MENU_ART_IMAGE_TIMEOUT_MS` | `180000` | Per image call |
| `MENU_ART_STALE_MS` | `300000` | Heartbeat age at which a pending or working step reads as interrupted |

Same-change docs:
- **README:** folder tree, Key Features, env table, tech stack.
- **ARCHITECTURE:** route table; the three tables; third-party integrations (OpenAI); and mentions of the new utils `openaiClient.js`, `menuDrinkSource.js`, `menuAlsoAtBar.js`, `menuFontPairings.js`, `menuPrintFile.js`, `r2Proxy.js`, plus the `storage.readFile` addition.
- **CLAUDE.md:** env table and Tech Stack (OpenAI).
- **`PrivacyPage.js`:** one line adding OpenAI (decision 10).
- **Root `package.json`:** gains `openai`.

`scripts/sensitive-paths.txt` gains `server/utils/menuPrintFile.js`, `server/routes/proposals/menuPrint.js`, `server/routes/proposals/menuDrafts.js` and `server/utils/openaiClient.js`. These are a paid, capped external API and the duty-pay trigger; this is the same treatment as the consult call caps.

**Spend.** An estimate from OpenAI's published token pricing, to be confirmed by the smoke run's usage page: the background is about $0.14 to $0.25 at high quality, and each 1024 drink about $0.05. So a full eight-drink menu is roughly $0.55 to $0.65, and the cap of 60 images a day bounds a worst day at about $15 (all 60 at the background's top price). Dallas sets a monthly budget on the OpenAI project as the provider-side backstop. Dev and prod share one key, so they share OpenAI's per-minute limit, and each database keeps its own cap.

## 14. Testing

- **OpenAI is never called from tests.** `openaiClient.js` refuses under `NODE_ENV=test` without an injected stub.
- **Pure helpers:**
  - `menuDrinkSource.js`: planner and consult sides, consult custom objects and mocktail gating, matcher hits through aliases, a picked-and-typed drink appearing once, slug collisions, inactive drinks keeping their description, missing ids becoming client-typed, brief-hash normalization;
  - `menuAlsoAtBar.js`, including "None", "Other" and the consult beer boolean;
  - the staleness diff;
  - the stuck rule;
  - `layouts.js` geometry for 1 to 8 drinks;
  - validation for every row of section 7.1;
  - `matchCustomNames`'s additive `row`, with existing shopping-list suites unchanged.
- **Routes** (`server/routes/proposals/menuDrafts.test.js`, shared dev DB, one suite at a time from the repo root):
  - auth (unauthenticated and staff refused; manager allowed);
  - Generate creates the draft and pieces, refuses with no drinks, no plan, and at cap, and the reservation holds under two concurrent Generates;
  - a second Generate supersedes the first, which writes nothing and makes no further call;
  - the words failure sweep fails every piece;
  - PATCH: version conflict; key-set change refused; more than 8 `has_art` refused; it never touches pieces, `art_version` or the words status;
  - add-drink: version conflict;
  - re-roll: refused while working, allowed when stuck;
  - the pieceKey pattern and every key-prefix guard;
  - Approve rejects non-JPEG, wrong dimensions, a stale `version`, a stale `art_version` and a not-done piece. On success it sets `menu_print_key` inside the transaction, clears `menu_not_required`, stamps the posted versions, writes the activity row, and fires duty reaccrual only after commit;
  - a re-roll after approval reads as edited since approval;
  - removal and "no menu needed" read correctly.
- **Admin download:** `GET /api/proposals/:id/menu-print` returns 404 with no file, enforces the prefix guard and auth.
- **Existing suites the change reaches stay green:** `server/routes/proposals/menuPrint.test.js`, `server/routes/eventDetails.test.js`, `server/routes/beo.test.js`, `server/utils/dutyLines.test.js`, and the shopping-list suites that cover `matchCustomNames` / `loadRecipeCandidates`.
- **Visual:** `ui-ux-review` against the artifact.
- **Live smoke on dev:** one full generation against OpenAI. Then approve onto a dev proposal, download it as staff, and read the actual cost on OpenAI's usage page.
- **Rollout check:** Dallas generates for one or two real upcoming custom events and compares them with hand-made quality before approving one for print.

## 15. Review level

**Server lanes: full review fleet.** They change `schema.sql`, `rateLimiters.js` and the paths added to the sensitive list, and they reorder the duty-pay trigger. That includes `/second-opinion` at push, per the cross-LLM rule.

**Page lane:** one reviewer, the client suites, and `ui-ux-review` against the artifact.

## 16. Rollout

1. Server lanes merge first; the feature stays dark until the key is set.
2. Live smoke on dev with the box key.
3. Page lane after the visual contract is amended.
4. Dallas adds `OPENAI_API_KEY` in Render, sets the OpenAI project budget, then pushes.
5. First real use on an upcoming custom event.
