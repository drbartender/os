# Menu Art Generator: design

**Date:** 2026-10-01
**Status:** brainstormed and approved section by section with Dallas on 2026-10-01 (flow, generation, storage and approval, failures and testing). Spec fleet (grounding, gaps, risk) run the same day: 1 blocker, 18 warnings, about 20 suggestions, all folded in at Dallas's direction, with his three calls recorded in section 3 (decisions 8 to 10).
**Visual design: COMPLETE again 2026-10-16 (v3, the event-page section).** On 2026-10-09 Dallas moved the designer off its own page and into a section of the event page, with editing opening over the event page (brief v3, `docs/design-artifacts/2026-10-01-menu-designer/brief.md`). The v3 design came back from Claude Design project "Menu Designer Admin Interface" (`89b66aac-dd5f-407d-b026-10b78702ce8a`) and is vendored byte for byte beside the brief: `Menu Designer v2.dc.html` (desktop), `Menu Phone.dc.html` and `Menu Designer Mobile.dc.html` (phone, follow-up lane), `menu-art.js`, `support.js` (the design runtime all three files load), `github.md` (the project's sync note), its design-system snapshot under `_ds/`, and the Dr. Bartender mark under `assets/`. Section 11.1 is rewritten from it. The 2026-10-01 artifact (https://claude.ai/artifact/CFXJvLLMr57mEyp1bP5jiJ, version `1790874392-ddd7`, snapshot `menu-designer.html`) remains the benchmark for the printed menu (11.2, 11.3, table P), amended only where section 11.2 says so.

**Amended 2026-10-16 with Dallas** (decisions 11 to 13): an image-model toggle with Gemini as a second provider and OpenAI the default; the event-page section folds in the print-file card and the client-logo widget; the phone version is a follow-up lane. The admin print-file download listed in this spec's first draft already shipped on 2026-10-06 (`7a1aa28b`), so it is no longer in scope here.

**Amended 2026-10-16 in the engine lane** (sections 2, 5.1, 6, 7, 10.2, 13 and 14), to match what lane `menu-art-engine` built and what its live smoke and review fleet found: Gemini calls send no `delivery` key and get no response id, Dismiss keeps the version, the GET carries `has_image` and `image_rev` instead of any R2 key, the job and route siblings join the sensitive list, and the box keys ride only the lane server's process environment.

## 1. Goal and scope

Custom bar menus are hand-made today. 28 of the 56 submitted drink plans in prod chose "Custom Menu Design" (`selections.menuStyle = 'custom'`), and only 5 of those 28 have a print file posted. This feature generates a custom 8x10 menu for one event from its drink plan. An AI paints the art (one themed background plus one illustration per drink), the app lays real, editable text on top, Dallas reviews and edits, and Approve posts the final file into the event's existing bar menu print slot.

**In scope**
- A **Bar menu** section on the event page: a card in the right column that also carries the print file and the client's image, and an editor that opens over the event page (decision 12).
- Server-side generation, stored as a draft with per-image pieces. OpenAI writes the words. The images come from OpenAI by default or from Gemini when Dallas flips the image-model toggle (decision 11).
- Approve into the existing `proposals.menu_print_key` slot through the same helper the manual upload uses.
- One line on the public privacy page naming OpenAI and Google Gemini as providers (decision 10).

**Out of scope**
- A separate planner "inspiration image" upload. Deferred by Dallas to the fix list (Potions section, entry dated 2026-10-01). v1 works around it with a role picker (section 4).
- The phone version. It is designed (`Menu Phone.dc.html`) and becomes the follow-up lane `menu-designer-phone` once the desktop lanes are on main (decision 13). v1 is desktop only, and the phone event page keeps leaving the menu to its Desktop-view escape until then.
- The admin print-file download route and button. Shipped 2026-10-06 (`7a1aa28b`): `GET /api/proposals/:id/menu-print` in `menuPrint.js` and `client/src/utils/downloadMenuPrint.js`. The new card reuses both.
- Any client-facing view of a draft.
- Illustrations of beer, wine, or spirit bottles. Only cocktails and mocktails get art, which also avoids drawing real brand bottles.
- Automatic generation on plan submit.
- Changes to the house (Standard) menu and its PNG button (`MenuPNG.jsx`).
- Deleting orphaned R2 objects. `storage.js` exposes no delete; this follows the menu-print and logo precedent.
- The "menu ready" staff notification (fix list, Staff section). It will hook into the shared helper this feature creates (section 8) when that item is built.

## 2. Verified context

- **The print slot.** `server/routes/proposals/menuPrint.js` (mounted in `server/routes/proposals/index.js`) owns `POST/PATCH/DELETE /api/proposals/:id/menu-print`. POST sniffs magic bytes (PDF, PNG, JPEG), uploads to R2 under `menu-print/<proposalId>/<uuid>.<ext>`, sets `menu_print_key` and clears `menu_not_required` with a bare `pool.query` and a rowCount guard, then calls `reaccrueDuty(id)`, which on `setImmediate` runs `payrollAccrual.maybeReaccrueForDuty`. That reads the proposal through `loadProposalDutyContext` (`server/utils/dutyLines.js`) with no row lock and re-reconciles the $5 `menu_print` duty line. `server/routes/proposals/menuPrint.test.js` stubs `storage` through `require.cache` before requiring the router. Since 2026-10-06 (`7a1aa28b`) both downloads stream through **`server/utils/menuPrintFile.js`**, which already exists and exports `sendMenuPrintFile(res, proposalId, key)`: the per-proposal key-prefix and traversal guard, the R2 proxy (`getSignedUrl` plus an 8-second bounded `fetch`), `Cache-Control: private, no-cache` and a digest ETag. Staff use `GET /api/shifts/:shiftId/menu-print` (`server/routes/eventDetails.js`); admins and managers use `GET /api/proposals/:id/menu-print` in `menuPrint.js` (`auth`, `requireAdminOrManager`, `beoReadLimiter`), fetched by the client through `client/src/utils/downloadMenuPrint.js`. This feature extends `menuPrintFile.js` (section 8) and leaves `sendMenuPrintFile` and both download routes untouched.
- **The event page's right column** (`client/src/pages/admin/EventDetailPage.js`, 659 lines, around line 554) stacks: `ProposalDetailPaymentPanel`, `ServiceExtensionPanel`, `DrinkPlanCard`, the "View event details" link (only once the plan is finalized), `AdminMenuPrintBlock`, `EventDetailPlanLogo` (only when a plan exists), `MenuPNG` (only for `menuStyle === 'house'`), then Activity.
- **The print card.** `client/src/components/AdminMenuPrintBlock.js` (203 lines): chip Uploaded / No menu needed / Not posted; Download (the shipped admin read), Upload or Replace file (PDF, PNG, JPEG, 10 MB client check), Remove, and a "No menu needed for this event" checkbox shown only without a file (`PATCH /menu-print { not_required }`). Busy labels ("Working...", and a separate "Downloading..." that never blocks an upload) and an inline `role="alert"` error line (the 10 MB message, the magic-byte `fieldErrors.file`, the 409 on the not-required flip). `client/src/components/AdminMenuPrintBlock.test.js` holds three Download tests.
- **The logo widget.** `client/src/pages/admin/EventDetailPlanLogo.js` (136 lines) shows the plan's `companyLogo` with Replace (`POST /api/drink-plans/:id/logo`, `accept="image/png,image/jpeg"`), Remove (`DELETE` the same) and Download original (a new tab, `target="_blank"`), behind a private `isSafeLogoUrl` allowlist, or "No logo uploaded." with Upload logo; "Uploading..." while busy and a `role="alert"` error (`fieldErrors.logo`). `EventDetailPage.js` passes `onChange` that calls `setDrinkPlan`, which `DrinkPlanCard` and `MenuPNG` also read. The original upload filename is never stored: `_logoFilename` is the R2 key `drink-plan-logos/<planId>-<ts>.<ext>`.
- **The admin shell.** `client/src/context/UserPrefsContext.js` keeps `prefs` (`skin`, `density`, `sidebar`), saves every `prefs` change to localStorage, writes `html[data-sidebar]`, and writes the status hues inline on `<html>` from its `PALETTES` (After Hours: ok 168, warn 192, danger 262, info 224), which override `index.css`'s own hue lines. `adminos/Sidebar.js` reads `prefs.sidebar` for `rail` (line 31) and in its footer collapse toggle (lines 107 to 110), which calls `setPref` and stays visible in rail mode. `useUserPrefs()` throws outside its provider, and `EventDetailPage.fork.test.js` renders the page without one. `StatusChip`'s `.chip.ok / .warn / .danger / .info` use fixed hues regardless of palette (145, 38, 358, 208).
- **Names.** `client/src/components/staff/BeoSections.js` already exports a staff `BarMenuCard`, so the admin card is named `MenuDesignerCard`.
- **html2canvas 1.4.1** draws no CSS `mask`, `filter`, `backdrop-filter`, `mix-blend-mode` or `object-fit` (an `<img>` is stretched to its box); it does draw radial gradients, inset box-shadows and `background-size: contain`, and its clone awaits `document.fonts.ready`.
- **Prior art for rendering.** `client/src/components/MenuPNG/MenuPNG.jsx` renders `MenuPreview variant="print"` (768x960) with `html2canvas` at scale 3 in the browser. The house menu's bar-label mapping is `collapseBeerWine` in `client/src/pages/plan/data/menuSections.js` (all non-Seltzer beer rolls up to "Beer"; spirits are not listed).
- **The plan.** `GET /api/drink-plans/by-proposal/:proposalId` returns the event's plan as the lowest-id plan on the proposal (`ORDER BY dp.id LIMIT 1`; `proposal_id` is not unique). `GET /api/beo/:proposalId/logo` (`server/routes/beo.js`) also proxies a plan logo, but its query has no `ORDER BY`, so this feature adds its own route under the lowest-id rule.
- **Two sides of a plan.** `selections` holds planner output; `consult_selections` holds the admin consult form's output; `shopping_list_source` (`planner` | `consult` | null) names the side the shopping list is built from (`server/db/schema.sql` around the consult columns; `server/utils/shoppingListGen.js` `buildConsultGeneratorInput`; `server/routes/drinkPlans/labListRefresh.js`). In prod, 22 plans are consult-sourced, and in 16 of the 19 comparable ones the consult drinks differ from the planner drinks. The consult shape (`buildGeneratorInputFromConsult`, `server/utils/shoppingList.js`): `signatureDrinks` and `mocktails` are catalog ids; `customCocktails` and `customMocktails` are `{ name, ingredients }` objects; mocktails count only when `mocktailsEnabled` or `barType === 'mocktails'`; `beer` is a boolean (true means the house mix "Light / Easy Drinking", "Craft / Local", "IPA"); `wine` is lowercase categories. The consult side carries no menu brief (`menuStyle`, `menuTheme`, `drinkNaming`, `menuDesignNotes` exist only in `selections`).
- **The planner side.** Drinks are `selections.signatureDrinks` and `selections.mocktails` (catalog ids) plus `selections.customCocktails` (client-typed name strings). Bar picks are category labels: `beerFromFullBar` / `beerFromBeerWine` ("Light / Easy Drinking", "Craft / Local", "IPA", "Seltzer", "Non-Alcoholic", "Non-Alcoholic (Athletic Brewing)", "None"), `wineFromFullBar` / `wineFromBeerWine` ("Red", "White", "Sparkling", "Other", "None"), `spirits` ("Vodka", "Tequila", "Whiskey", "Gin", "Rum", "Scotch", "Other") plus `spiritsOther`.
- **Typed names that match a real drink.** `matchCustomNames(customStrings, candidateRows)` with `loadRecipeCandidates(dbClient)` (`server/utils/shoppingListGen.js`) resolves a typed name to a catalog drink by exact normalized name or `request_aliases`, names before aliases, first wins, over every drink with a recipe including inactive ones. It returns `{ name, ingredients }` only.
- **Descriptions.** `cocktails.description` and `mocktails.description` (edited through Potions) cover all 37 active drinks and all 103 drink picks across the 28 custom plans. Drinks are soft-deleted with `is_active`, never hard-deleted.
- **The planner image.** The planner's only image upload is `LogoUploadField` ("Add your logo (optional)"), writing `selections.companyLogo` (a URL) and `selections._logoFilename` (R2 key `drink-plan-logos/<planId>-<ts><ext>`). Clients put mood boards there. The admin `DELETE /api/drink-plans/:id/logo` strips both. `submitSanitize.js` drops `_logoFilename` from client writes, so the key is always server-made.
- **Other R2 contents.** The bucket also holds staff W-9 images (`<userId>_w9_<uuid>`, `application.js`, `payment.js`), so any key the job reads must be prefix-checked before its bytes go to a provider (section 5.5).
- **Storage.** `server/utils/storage.js` exports `uploadFile(buffer, key)` and `getSignedUrl(key)` only.
- **Errors.** The global handler (`server/index.js`) serializes an `AppError` as `{ error, code, fieldErrors? }` with `err.statusCode`, and sends `ExternalServiceError` to Sentry. `AppError(message, statusCode, code, fieldErrors)` is constructible directly; `server/routes/stripe.js` throws `new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED')`.
- **Uploads.** `server/utils/fileValidation.js` exports `isValidUpload` (JPEG, PNG, WebP, PDF and more), `isValidImageUpload` (JPEG, PNG only), `safeUploadExtension`. Both `fileValidation.js` and `server/middleware/rateLimiters.js` are on `scripts/sensitive-paths.txt`.
- **Fonts.** `client/public/index.html` only preconnects to Google Fonts. `client/src/components/AdminLayout.js` injects its font stylesheet with the `media="print"` then `onload` swap, which lets `document.fonts.ready` resolve before the faces are declared.
- **Libraries.** `sharp` (server) and `html2canvas` (client) are installed. The `openai` npm package is not. The OpenAI Node SDK defaults to `maxRetries: 2` and a 10-minute timeout. The client already fetches R2-proxied files as blobs through `api.js` (`BeoSections.js`).
- **OpenAI.** The key at `~/.secrets/openai_api_key` (account contact@drbartender.com) is valid and lists `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` and `gpt-5.4-mini`. OpenAI's docs (2026-10-01): `background: "transparent"` with png or webp output is supported; sizes are any WxH with both sides multiples of 16 and edges at most 3840, and above 2560x1440 is labeled experimental; reference images can drive new generations. Older image models shut down 2026-12-01. A new account tier allows 5 images per minute.
- **Gemini (checked 2026-10-16 against ai.google.dev, the `@google/genai` 2.30.0 package, and a free models-list call with the box key).**
  - **Models:** `gemini-3-pro-image` (Nano Banana Pro, GA, no shutdown date) is the only Gemini image model with style-reference inputs (up to 3), and the only one this feature is built and smoke-tested for. `gemini-nano-banana-2.1` (GA 2026-10-06) is cheaper but treats input images as objects, not styles; it is not a supported setting. `gemini-3.1-flash-image` is deprecated, and Imagen is shut down on the Gemini API. The box key (`~/.gemini/.env`, the AI Studio prepay project with auto-refill that the second-opinion reviewer uses) lists both GA models.
  - **Sizes:** 4:5 at 4K is 3712x4608 (2K, 1856x2304, is below print size). 1:1 at 1K is 1024x1024. A request that passes an image and sets no ratio inherits the input's ratio, so drink calls set 1:1 explicitly.
  - **No transparency.** No Gemini image model returns alpha. The only requestable output is JPEG, every image carries SynthID, and Google's own sticker prompts ask for a white background. So Gemini drinks need a server-side key-out (section 5.4).
  - **SDK:** `@google/genai` (2.30.0, published 2026-10-15, Node 20 or later, CJS entry `dist/node/index.cjs`). The Interactions API (`ai.interactions.create(params, options)`) is GA and recommended; it retries up to 4 times (408, 409, 429, 5xx, connection errors) by default and has no client timeout, and the per-call `options` `{ timeout, maxRetries }` map to `timeout_ms` and the retry count, so every call passes `maxRetries: 0` and a timeout there. It stores requests for 55 days unless `store: false` is sent, and with `store: false` it returns no response id. Without `GEMINI_API_KEY` passed explicitly, the SDK falls back to `GOOGLE_API_KEY`. `response_format: { type: 'image', aspect_ratio, image_size: '512' | '1K' | '2K' | '4K', delivery }` is typed, but the live API rejects any `delivery` value on image output with 400 "Image delivery mode is not supported."; with the key left out the image comes back inline as base64 `data`, so calls send no `delivery` key. (Amended 2026-10-16 from the engine lane's live smoke, which also accepted `store: false` and `gemini-3-pro-image`.) Inputs are `{ type: 'text', text }` and `{ type: 'image', data: <base64>, mime_type }`; the SDK adds `output_image` (`data`, `mime_type`, `uri`) when an image block exists.
  - **Refusals:** the SDK throws an `APIError` with `status`, `headers` (a fetch `Headers`) and `error` (the parsed body), so the code may sit at `err.error.code` or `err.error.error.code`; the typed enums are uppercase (`IMAGE_SAFETY`, `PROHIBITED_CONTENT`) while the error docs list lowercase codes. A 200 can also carry `status: 'failed' | 'incomplete'` with an `errors[]` array, and a text-only answer has no `output_image`.
  - **Price** (paid tier): Pro is $0.24 per image at 4K and $0.134 at 1K or 2K. That makes a full eight-drink menu about $1.31, against about $0.60 on OpenAI.
  - **Limits:** spend-based, per project, per rolling 10 minutes ($10 at Tier 1), returned as 429 `RESOURCE_EXHAUSTED`.
  - **Data use:** on the paid tier, prompts and images are not used to train models, but they are kept 55 days for abuse monitoring. Zero retention needs Vertex AI.
- **Rate limiters.** `adminWriteLimiter` is 10 per minute per user; `beoReadLimiter` is 60 per 15 minutes, too tight for polling.
- **Privacy page.** `client/src/pages/website/legal/PrivacyPage.js` (with `PrivacyPage.test.js`) names Stripe, Twilio, Resend, Google (line 122), Sentry, Cloudflare, Neon and Anthropic (line 121). Not OpenAI, and not Gemini.
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
10. **The privacy page names OpenAI** in the same build (and Google Gemini, per decision 11).

From the v3 design (Dallas, 2026-10-16):
11. **Image-model toggle, OpenAI the default.** Dallas wants to compare the two. The editor carries a GPT Image / Gemini toggle; OpenAI is selected on every load. The model selected when an image is asked for draws it: a Generate, a single drink re-roll and a background re-roll each use the current setting, and every piece records the provider that drew it, so comparing means re-rolling one piece under the other model without discarding the draft. The words step stays on OpenAI either way. This amends decision 7, which was OpenAI for everything.
12. **The section folds in the print card and the logo widget.** One **Bar menu** card replaces `AdminMenuPrintBlock` and `EventDetailPlanLogo` in the right column and keeps every action they had. The house-menu `MenuPNG` button stays where it is, unchanged.
13. **Desktop first; the phone version is a follow-up lane** built to `Menu Phone.dc.html` after the desktop lanes are on main.

## 4. What Dallas sees and does

1. The event page's right column shows one **Bar menu** card (`MenuDesignerCard`) under the drink plan (decision 12). It shows for every event, with or without a plan. Its top half is the AI draft (thumbnail, status, next action); its bottom half carries the print file and the client's image, with every action the old print card and logo widget had, and keeps working when the draft cannot load. Generate needs at least one drink on the plan's source side (any plan status). For a house-menu or no-menu event the card says so (section 11.1) and still lets Dallas draft a custom menu. The card's in-place actions (Generate, Retry, Update draft) draw with GPT Image, the default; the editor's draw with its toggle.
2. **View** (or the card's other actions that need the editor, or the thumbnail) opens the editor over the event page, without leaving `/events/:id`: the open state is the query parameter `?menu=1`, so browser Back closes it and moving to another event drops it. The sidebar collapses to its rail (a temporary override, section 10.1), the header stays, and the editor fills the main area. Escape (with no dialog open) or the back button closes it, after flushing any pending autosave (section 10.1, Closing and leaving), and returns to the event page with the card updated. Brief inputs set before the first Generate (role, style reference, art direction) live in the page's draft hook, survive closing and reopening the editor, and are dropped only when Dallas leaves the event page.
3. The editor's right panel has three tabs, **Design**, **Drinks** and **Brief** (section 11.1). The Brief tab holds what the old brief panel held:
   - The client's theme, naming notes and design notes, read-only (from `selections`).
   - The planner image (if any) with a role picker: **Logo** (default) / **Style ref** / **Ignore**.
   - **Style reference**, optional, one total: the planner image when its role is Style ref, otherwise an optional upload (JPEG, PNG or WebP). Choosing an upload while the planner image is Style ref flips it to Ignore. Removing the planner image as the reference flips it to Ignore. Once a draft exists, a newly chosen upload is held and sent with the next Start over ("Applies when you start over"); removing a reference or flipping the role saves at once, and later re-rolls use whatever reference the draft then names.
   - **Art direction**, free text, up to 500 characters.

   Below the tabs, always visible: the **Image model** toggle (GPT Image / Gemini, GPT Image selected on every load, decision 11), then **Generate**, which once a draft exists reads **Start over** and replaces the draft after a confirm.
4. Generation fills the preview progressively: words within seconds, then the background, then each drink. Pending slots are visible. Text editing and the Design and Drinks tabs stay disabled until the words land.
5. Editing:
   - Click any text on the menu to edit it in place: the title, the four section headings, drink names and descriptions, and the "also at the bar" labels and lines.
   - Per drink: click its art on the menu (or its row on the Drinks tab) to select it; then **Re-roll art** (optional note, up to 200 characters) and **Hide** / **Show**.
   - **Re-roll background** (Design tab).
   - **Font pairing** (Design tab).
   - **Ink** and **Accent** colors as swatches (Design tab). Each pairing has a light-art and a dark-art default, chosen by how bright the background is; Dallas can override either from the swatches.
   - **Text backing:** Off / Soft (default) / Panel.
   - **Dr. Bartender mark:** a switch, on by default, and when on a **Wordmark color** of Theme ink (default) / Accent / Gold.
   - When the planner image is the logo: **Placement** (above the title, or replacing it) and **Backing** (none or a badge), on the Brief tab.
   - **Drink limits:** up to 8 drinks are illustrated. Visible drinks 9 to 12 list as text under "More from the bar", and more than 12 visible drinks must be hidden down to 12.
   - Edits autosave with a visible saving / saved / failed indicator.
6. **Approve** first flushes any pending autosave, then renders and posts, disabled and showing progress throughout. It confirms first whenever the event already has a print file (an earlier approval or a manual upload), since staff would download the new one instead. It is blocked while any text is flagged "Too long" and while any drawing the layout uses has failed or is still painting (section 11).
7. States: initial load; load error; not set up (no key); empty (never generated); no drinks on the plan; no plan on the event; generating; words failed (with Retry); a piece failed; daily cap reached (with the reset time); plan changed (Update draft / Dismiss); plan changed after approval; brief edited (Mark reviewed); saving / saved / save failed; save conflict (reloaded); text too long; Approve in progress; Approve rejected; approved; edited since approval; print file replaced by a manual upload; print file removed; marked "no menu needed".

## 5. Generation pipeline

### 5.1 Provider wrappers

`server/utils/openaiClient.js` is the only module that requires the `openai` package (the `stripeClient.js` and `anthropicClient.js` precedents). It builds the SDK client with the key passed explicitly, the API host pinned (an `OPENAI_BASE_URL` in the environment cannot redirect client images), quiet SDK logging, `maxRetries: 0` (the app owns retries, section 5.5) and explicit per-call timeouts (`MENU_ART_IMAGE_TIMEOUT_MS`, default 180000; text calls 60000). It exports `isConfigured()`, `draftMenuCopy(input)`, `generateImage(opts)` and `editImage(opts)`, each returning the payload plus OpenAI's request id. Under `NODE_ENV=test` it refuses every call unless a test has injected a stub, so a missed mock can never spend money. The routes that ask for words or images (Generate, re-roll and Update draft) check `isConfigured()` first and throw `new AppError('Menu art is not set up.', 503, 'MENU_ART_NOT_CONFIGURED')`, which does not page Sentry; that holds for a Gemini re-roll too, since "set up" means the OpenAI key. The GET, PATCH, dismiss, the image GETs and Approve work without it, so an existing draft can still be viewed, edited and approved. Model ids come from env (section 13).

`server/utils/geminiClient.js` is the only module that requires `@google/genai`, built the same way: one client with `GEMINI_API_KEY` passed explicitly and the API host pinned, the Interactions API (`ai.interactions.create`) with `store: false`, no `response_format.delivery` key (the live API answers any delivery value on image output with 400 "Image delivery mode is not supported."; left out, the image comes back inline as base64; amended 2026-10-16 from the engine lane's live smoke), and `{ maxRetries: 0, timeout }` in each call's own options. It exports `isConfigured()` (`GEMINI_API_KEY` set) and `generateImage({ prompt, images, aspectRatio, imageSize, model })`, returning `{ buffer, mimeType, responseId, usage }`, and it refuses under `NODE_ENV=test` without an injected stub. With `store: false` the Interactions API returns no response id, so `responseId` is null in practice: a Gemini ledger row carries a null `provider_request_id`, and the sanitized descriptor on a failed Gemini piece or ledger row a null `requestId`. It accepts exactly one `output_image`. Refusals become one `GeminiRefusal` with a readable reason: a thrown error whose code (read at `err.error.code` or `err.error.error.code`, matched case-insensitively on its last segment) is a safety, prohibited-content, blocklist, recitation, other-image or no-image code; a 200 whose `status` is `failed` or `incomplete` (reason from `errors[0]`); and a 200 with no `output_image`. The job treats it like an OpenAI moderation refusal.

**Both wrappers** log and store only a sanitized error descriptor (class, HTTP status, request id, mapped refusal code) in Sentry, `menu_draft_pieces.error`, `menu_art_calls.error` and `words_error`, never the raw SDK message, and each has a unit test that pins the client options (`maxRetries: 0`, the timeout, `store: false`, the pinned host, and for Gemini no `delivery` key).

`server/utils/menuImageProvider.js` is the one place the job asks for an image. It takes the piece's `provider` (`openai` | `gemini`), its stamped `model`, and the kind (`background` | `drink`) and calls the matching wrapper with that provider's settings (section 5.4). The words step always uses `openaiClient.js`. Gemini is optional: Generate and the re-rolls refuse `gemini` with `new AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED')` when its key is missing, and the GET payload carries `configured: { openai, gemini }` so the toggle can disable it.

**Payload rule.** OpenAI and Gemini receive only: the event type label (`getEventTypeLabel`), the three brief fields, drink names, catalog descriptions and ingredients, client-typed drink names (and consult ingredients), Dallas's art direction and re-roll notes, the reference image, and the generated background. Never the client's name, email, phone, venue, address or event date. Text calls set `store: false`.

### 5.2 Normalizing the plan

`server/utils/menuDrinkSource.js` turns the plan into one shape, whichever side feeds it:
- **Side:** `consult_selections` when `shopping_list_source = 'consult'`, otherwise `selections` (decision 8).
- **Drinks**, in this order: signature cocktails (catalog ids), then client-typed cocktails, then mocktails (catalog ids), then client-typed mocktails (consult side only; mocktails only when `mocktailsEnabled` or `barType === 'mocktails'` there). Catalog lookups ignore `is_active`, so a deactivated drink keeps its name and description. An id with no row at all is treated as client-typed.
- **Typed names that match a real drink** resolve through the existing matcher. `matchCustomNames` gains an additive `row` field on each matched entry (the candidate row as passed in), and `loadRecipeCandidates` additionally selects `id`, `description` and its `src` as the kind. Existing callers read only `name` and `ingredients`, so both changes are invisible to them. A matched typed name becomes that catalog drink, and a drink both picked and typed appears once.
- **Keys:** `cocktail:<id>`, `mocktail:<id>`, `custom:<slug>` (a catalog id outside `[a-z0-9-]{1,100}` is sanitized to a slug plus the first 6 hex of its SHA-1, so every key fits the section 7 pattern; `catalog_id` keeps the original), where the slug is the typed name lowercased with every run of characters outside `a-z0-9` turned into one hyphen, trimmed of hyphens, at most 60 characters; a name that slugs to nothing (emoji, non-Latin script) falls back to `x` plus the first 8 hex of the name's SHA-1. Two typed names with the same slug are one drink (first kept).
- **Bar lines** through a fixed label table (`server/utils/menuAlsoAtBar.js`), deliberately finer than the house menu's `collapseBeerWine`: beer becomes "Light beer", "Craft beer", "IPA", "Seltzer"; "Non-Alcoholic" and "Non-Alcoholic (Athletic Brewing)" become "Athletic Brewing NA" on the Non-Alcoholic line; wine becomes "Red", "White", "Sparkling"; spirits are listed by name plus `spiritsOther`; "None" and "Other" render nothing. The consult side maps `beer: true` to the house mix and its lowercase wine categories to the same labels; a field the side lacks renders nothing. Dallas adds brand names by editing.
- **Brief fingerprint:** the drink keys sorted, plus a SHA-256 over the three brief fields with null as empty, trimmed, and internal whitespace collapsed. It also keeps one such hash per field (`brief_fields: { theme, naming, notes }`), so the read can say which field the client edited (section 9), and the planner image's key (`planner_image_key`, the `_logoFilename` or null), so a replaced or removed client image reads as a change.

### 5.3 Step 1: the words

Deterministic fields never go to the model for authoring: catalog names and descriptions, and the bar lines. One structured-output call (`MENU_ART_TEXT_MODEL`) receives the brief (each field cut to 1,000 characters), the event type label, and the drink list (key, catalog name, catalog description or "client-typed", consult ingredients when present) and returns JSON validated against a schema:
- `title` (default "Bar Menu");
- per drink: `display_name` (the client's rename applied, or a themed name when the brief asks), `name_ai_suggested` (true when invented rather than taken from the catalog or an explicit client rename), `description` only for client-typed drinks and for catalog drinks whose catalog description is empty (some inactive drafts have none; both get `description_ai_written: true`), and `visual_note` (glass, color, garnish);
- `font_pairing`, one of the fixed ids in section 10.3;
- `palette`, up to 6 `{ name, hex }` entries (`hex` as `#rrggbb`, `name` as the client wrote the color, at most 20 characters) read from the client's theme text (empty when the brief names none), shown as swatches on the Brief tab and offered as the Accent swatches on the Design tab;
- `accent_color`, a `#rrggbb` taken from that palette when it suits the pairing, otherwise null (null means the pairing's default for the background's tone);
- `background_label`, a short name for the background it will ask for, at most 30 characters ("Pastel garden").

`ink_color` is never set by the model; it starts null (the pairing default). A catalog drink's description is always the catalog text. Output that fails validation fails the words step (section 12).

### 5.4 Steps 2 and 3: the art

- **Background:** one call. The prompt is built from the theme, colors, art direction and design notes, and always asks for decorative edges, a calm low-detail center for text, and no lettering, words or numbers. The same prompt goes to either provider.
  - **OpenAI:** at `MENU_ART_BACKGROUND_SIZE` (default `2560x3200`; `1664x2080` is the non-experimental fallback), quality high, JPEG output. With a reference image, the call goes through the edit endpoint with it as a style reference.
  - **Gemini:** `MENU_ART_GEMINI_IMAGE_MODEL` (default `gemini-3-pro-image`) at aspect ratio `4:5` and size `4K` (3712x4608), with the reference image, when set, passed as a style-reference input. The job resizes the result with `sharp` to 2560x3200 JPEG (`fit: 'cover'`, which trims about 0.7% because 3712x4608 is 0.8056, not 0.8) before storing it, so both providers' backgrounds have one size downstream.
- **Background tone:** when the background lands, the job reads the central 60% (width and height) with `sharp` `stats()`. `stats()` measures the original input even after `extract()`, so the crop is written out with `toBuffer()` first and measured as a new image. It stores the mean color as `ground_rgb` (`"r,g,b"`), which colors the Soft and Panel text backings, and stores `tone`: `dark` when that color's relative luminance is below 0.4, otherwise `light`. The tone picks the pairing's light-art or dark-art ink and accent defaults and the mark color.
- **Drinks:** one call per drink with `has_art`, sequential, 1024x1024, with the background (downscaled to 1024 px wide with `sharp`) plus the reference image when set as style references. The prompt carries `visual_note` and asks for one isolated illustration with no text. A re-roll appends Dallas's note. Every stored drink is a 1024x1024 PNG with real alpha, whichever provider drew it.
  - **OpenAI:** `background: "transparent"`, PNG output, through the edit endpoint; the prompt asks for no background.
  - **Gemini:** the same model at aspect ratio `1:1` and size `1K`, set explicitly (an image input would otherwise set the ratio). Gemini cannot return alpha, so the prompt asks for the drink on a flat, solid `#FF00FF` magenta background with nothing else in that color, and says the reference images are for style only. The output is resized to 1024x1024 if it is not already. `server/utils/menuKeyOut.js` (pure, on `sharp` raw pixels) then removes the key, but only in key-colored regions connected to the image border (a flood fill from the edges), so a pink or fuchsia drink (a Cosmopolitan, hibiscus, dragonfruit) keeps its body: in those regions a pixel close to the key color in chroma becomes transparent, a band of partly-close pixels gets partial alpha, and those edge pixels are despilled (the magenta cast pulled out) so no pink fringe shows on dark art. Magenta, not green, because garnishes are green. Gemini's JPEG chroma subsampling smears the key into edges, which is why the fixtures include a JPEG round trip and a real Gemini drink captured in the live smoke. If too little of the image matches the key (the model ignored the instruction), the piece fails with "Gemini didn't leave a clean background. Re-roll it." rather than storing a drink on a pink square.
- **Default art set:** the first 8 drinks in the section 5.2 order get `has_art` (mocktails count toward the 8). A drink added by Update draft gets art when fewer than 8 visible drinks already have it.
- **Reading images back:** `storage.js` gains `readFile(key)` (`getSignedUrl` plus a bounded `fetch`, the `menuPrintFile.js` pattern, returning `{ buffer, contentType }`, throwing `ExternalServiceError('r2', ...)` on failure). The job uses it for the background on every drink call and re-roll, the uploaded reference, and the planner image. **Before any of those bytes go to a provider, the job re-checks the key's prefix:** `menu-art/<proposalId>/` for art and uploaded references (`ref-`), `drink-plan-logos/<planId>-` for the planner image. A key outside its prefix fails the piece and is never read, so no other R2 object (a W-9, another event's art) can reach a provider.

### 5.5 Running the job

**Database discipline.** No connection is held across a provider call (OpenAI or Gemini) or an R2 call. Every write the job makes is a standalone `pool.query`. A request that needs a transaction opens its client only after any R2 or provider work it needs is done, and releases it before `setImmediate` (CLAUDE.md, one pooled connection per request).

**Generate.**
1. Validate and, when a file is attached, upload the reference to R2. No transaction is open yet.
2. One transaction on one client, whose first statement is `LOCK TABLE menu_art_calls IN EXCLUSIVE MODE` (the same in re-roll and Update draft, so the lock order never inverts; a deadlock, `40P01`, answers 409 `MENU_DRAFT_CHANGED`):
   - upsert `menu_drafts` in place (`INSERT ... ON CONFLICT (proposal_id) DO UPDATE`; never delete and recreate, so `version` and `art_version` keep counting);
   - set a fresh `run_id`, bump `version`, and reset `content` to the words status `pending` (so a words failure leaves no text; the previous draft's text is gone once Start over is confirmed);
   - release the old run's unspent reservations;
   - delete the old run's piece rows and insert the new pending ones (the background plus each drink with `has_art`);
   - reserve the run's images against the cap (below);
   - COMMIT.
3. Release the client, respond 202, and start the job with `setImmediate`.

Start over keeps the stored reference when no new file is attached and the source is unchanged, and keeps the `approved_*` stamps (the bumped `version` then reads "edited since approval"). A failed words step's **Retry** re-posts Generate with the saved inputs and skips the Start over confirm, since nothing is lost.

**The job.**
- It runs the words, then the background, then the drinks.
- **Heartbeats.** Every piece row carries `heartbeat_at`, set at insert. Before each attempt, and on every retry wait, the job refreshes the heartbeat of the active piece and of every remaining pending piece in its run, in one UPDATE. The words step does the same through `content.words_heartbeat_at`. When a piece reaches `done`, the job bumps `art_version`.
- **Superseded runs.** Every write is conditional on the draft's current `run_id`, or the piece's own `run_id` for a re-roll. The call itself is authorized atomically: before every provider call (OpenAI or Gemini, words or image) the job moves that call's reservation from `reserved` to `sent` with one UPDATE conditional on the reservation being `reserved` and the run still current, and calls only when that UPDATE changed one row. A superseded run writes nothing and spends nothing further, and there is no window between a re-read and the call.
- **End-of-run sweep.** The job wraps everything in `try/finally`. On any exit, every piece of its run still `pending` or `working` becomes `failed`, with reason "not attempted: <cause>" (for example "the words step failed"), conditional on `run_id`. Its reservations are settled by **their own** status, never the piece's: rows still `reserved` (never sent) move to `released`; rows already `sent` (billed, then a later step such as the key-out, `sharp` or the R2 upload failed) move to `failed` and keep counting. A words failure therefore fails every image piece at once and costs nothing against the cap, which is what the v3 copy promises ("No images were used").
- **Stuck rule (read time).** A piece, or the words step, that is `pending` or `working` with a heartbeat older than `MENU_ART_STALE_MS` (default 300000, above one image timeout plus one retry wait) reads as `failed` ("interrupted"), and its re-roll is allowed. This covers a server restart, which skips the `finally`.
- **Retries.** The job auto-retries a 429 only, on the words step (`OpenAIRateLimited`) and on image calls alike, waiting `Retry-After` capped at 60 seconds (20 seconds when the provider sends none, which Gemini's spend-limit 429 may not), at most 2 times. 429s are not billed. A timeout, 5xx or connection error fails the piece without retry, because the image may already have been billed. Dallas re-rolls, which reserves again.
- **Refusals.** A refusal fails the piece with the provider's reason text (OpenAI's moderation message, or Gemini's `error.code` made readable, section 5.1).
- **Provider per piece.** Generate stamps every piece it creates with the posted `image_model` as `provider` and the env model id for that provider as `model`; a re-roll and Update draft stamp their own. The job calls with the piece's stamped `provider` and `model`, never a draft-wide setting or the env value at run time, and refuses a piece with no provider, so a background drawn by one model and drinks by the other is normal (decision 11). Each ledger row records the provider too.
- **Errors.** Job failures are captured to Sentry by the job itself (`tags: { area: 'menuArt', step }`), since nothing passes through the request error handler.

**Re-roll.**
- It reserves one image (409 `MENU_ART_PIECE_BUSY` while that piece is working, or pending in a run that is still active, and not stuck), sets a new piece `run_id`, pending status, the posted `image_model` as its `provider` and that provider's model, then runs the piece the same way.
- A drink with `has_art` but no piece row gets one created.
- Re-rolling the background does not re-roll the drinks; Dallas re-rolls any drink that no longer matches.

**Daily cap (reservation).**
- One cap covers both providers: it bounds images, whoever draws them.
- Every image is reserved inside the request that asks for it (Generate, re-roll, Update draft), in a transaction that first takes `LOCK TABLE menu_art_calls IN EXCLUSIVE MODE`. (Advisory locks are a no-op on the Neon pooler; a transaction-scoped table lock is not.)
- It then counts rows of kind `image` created in the last 24 hours with status other than `released`, refuses if the request would pass `MENU_ART_DAILY_IMAGE_CAP` (default 60) with `new AppError('Daily menu art limit reached.', 429, 'MENU_ART_CAP_REACHED')`, and otherwise inserts one `reserved` row per image.
- The job moves a reservation to `sent` at the call, then `ok` or `failed`. A superseded run's unspent reservations become `released`.
- One reservation stands for at most one billed image, because only unbilled 429s are retried.
- Text calls are logged as kind `text` and do not count against the image cap. They have their own rolling 24-hour ceiling, `MENU_ART_DAILY_TEXT_CAP` (default 100), checked the same way in Generate and Update draft (`429 MENU_ART_TEXT_CAP_REACHED`), so a brief that keeps failing validation cannot be retried without limit.
- **Env numbers.** `MENU_ART_DAILY_IMAGE_CAP`, `MENU_ART_DAILY_TEXT_CAP`, `MENU_ART_IMAGE_TIMEOUT_MS` and `MENU_ART_STALE_MS` parse as positive integers through one shared helper, `server/utils/envInt.js` (`readEnvInt(name, fallback)`, used by both wrappers and the cap); zero, blank or nonsense falls back to the default with one boot warning (the `INBOX_AI_DAILY_CAP` and `LEAD_CALL_DAILY_CAP` precedent), so a typo can never uncap the providers.
- The GET payload carries `cap: { used, limit, remaining, resets_at }` for the card and the editor, where `resets_at` is when the oldest counted image ages out of the 24-hour window (one image frees then, not a whole Generate's worth).

## 6. Data model

Added to `server/db/schema.sql` with idempotent statements.

**`menu_drafts`** (one per event)
- `id SERIAL PRIMARY KEY`
- `proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE`
- `drink_plan_id INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL`
- `run_id UUID NOT NULL`
- `inputs JSONB NOT NULL`:
  - `planner_image_role`: `logo` | `reference` | `ignore`;
  - `reference_key`, written only by Generate from its own upload (`menu-art/<id>/ref-...`); never accepted from PATCH;
  - `reference_source`: `none` | `planner` | `upload`;
  - `art_direction`;
  - `drb_mark`;
  - `image_model`: `openai` | `gemini`, the toggle's value at the last Generate (a record only; the toggle itself opens at `openai` on every load, decision 11).
- `content JSONB NOT NULL`:
  - the words step's `words_status`, `words_error` and `words_heartbeat_at`;
  - `title`;
  - `headings`: `sig`, `mock`, `more` and `also`, defaulting to "Signature Cocktails", "Mocktails", "More from the bar" and "Also at the bar";
  - `drinks[]`, each with `key`, `source` (`catalog` | `custom`), `catalog_kind` (`cocktail` | `mocktail` | null), `group` (`sig` | `mock`), `catalog_id`, `display_name`, `description`, `name_ai_suggested`, `description_ai_written`, `visual_note`, `hidden`, `has_art` and `added_by_sync` (true for a drink Update draft added, cleared by the next Generate; it drives the Drinks tab's "New from plan");
  - `also_at_bar[]`, each with `label` and `text`;
  - `palette` (up to 6 `{ name, hex }` entries, display only);
  - `font_pairing`, `ink_color` (hex or null), `accent_color` (hex or null), `text_backing` (`off` | `soft` | `panel`, default `soft`), `logo_mode` (`above_title` | `replaces_title`, default `above_title`), `logo_badge` (boolean, default false) and `mark_color` (`ink` | `accent` | `gold`, default `ink`);
  - `background_label`, a short name for the background (at most 30 characters, for example "Pastel garden"), written by the words step and shown on the Design tab's Background row; display only.
- `plan_fingerprint JSONB NOT NULL` (section 5.2)
- `dismissed_plan_hash TEXT`, the plan fingerprint hash Dallas dismissed the plan-changed banner for (section 9)
- `version INTEGER NOT NULL DEFAULT 1`, bumped by every content or inputs write (edits, Generate, Update draft). Dismiss (amended 2026-10-16 in the engine lane) does not bump it: it writes only `dismissed_plan_hash` under the version check and returns the unchanged version, so Mark reviewed (the same route) never moves an approved menu to edited since approval
- `art_version INTEGER NOT NULL DEFAULT 0`, bumped by the job when a piece reaches `done`
- `approved_version INTEGER`, `approved_art_version INTEGER`, `approved_print_key TEXT`, `approved_planner_image_key TEXT` (the planner image key the approved file was rendered with, when its role was logo), `approved_at TIMESTAMPTZ`, `approved_by INTEGER REFERENCES users(id)`
- `created_at`, `updated_at` with the standard `update_updated_at_column` trigger

**`menu_draft_pieces`** (one per image)
- `id SERIAL PRIMARY KEY`
- `draft_id INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE`
- `piece_key TEXT NOT NULL` (`background` or a drink key), `UNIQUE (draft_id, piece_key)`
- `run_id UUID NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed'))`
- `r2_key TEXT`, `error TEXT`, `reroll_note TEXT`, `heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `started_at`, `finished_at`
- `tone TEXT CHECK (tone IS NULL OR tone IN ('light','dark'))` and `ground_rgb TEXT`, set on the background piece only (section 5.4)
- `provider TEXT NOT NULL CHECK (provider IN ('openai','gemini'))` and `model TEXT NOT NULL`, stamped when the piece is asked for (decision 11); the job draws with them, and the editor labels a `done` piece by them
- `drawn_count INTEGER NOT NULL DEFAULT 0`, bumped each time the piece reaches `done`; the Background row reads "Version <drawn_count>"

**`menu_art_calls`** (the cap's ledger, the cost record, the audit trail)
- `id SERIAL PRIMARY KEY`
- `proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL`
- `piece_key TEXT`, `run_id UUID`
- `kind TEXT NOT NULL CHECK (kind IN ('image','text'))`
- `status TEXT NOT NULL CHECK (status IN ('reserved','sent','ok','failed','released'))`
- `provider TEXT NOT NULL CHECK (provider IN ('openai','gemini'))` (no default, so a call can never be mislabeled), `model TEXT`, `size TEXT`, `error TEXT` (sanitized, section 5.1), `provider_request_id TEXT` (the request or response id from whichever provider made the call; null on Gemini rows, since `store: false` returns no response id, section 5.1)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ`, indexed on `created_at`

**Writers.**
- The job writes `menu_draft_pieces`, `art_version`, `menu_art_calls`, and exactly one fill of `content` by the words step (plus `words_status`, `words_error` and `words_heartbeat_at`), all conditional on `run_id`. The editor keeps editing disabled until `words_status = 'done'`, so that fill lands before any edit is possible.
- Every other `content` or `inputs` write (PATCH, Update draft, Generate) happens in a request under the `version` check.
- A PATCH and a job write touch different columns of `menu_drafts`.

**R2 keys.**
- Art: `menu-art/<proposalId>/<runId>/<pieceSlug>-<uuid>.<ext>`, where `pieceSlug` is the piece key with `:` replaced by `-`.
- Uploaded references: `menu-art/<proposalId>/ref-<uuid>.<ext>`.
- The planner image is read by its existing `_logoFilename` and never copied.

## 7. API

New route file `server/routes/proposals/menuDrafts.js`, mounted in `server/routes/proposals/index.js` beside `menuPrint` (before `crud` and `getOne`). Approve lives in its own file, `server/routes/proposals/menuDraftApprove.js`, mounted right after it, so the approve work can be built in parallel with the client. Every route uses `auth`, `requireAdminOrManager` (decision 9) and `asyncHandler`, with an integer-validated `:id`, and returns 404 when the proposal does not exist. `:pieceKey` arrives URL-encoded and must match `^(background|(cocktail|mocktail|custom):[a-z0-9-]{1,100})$`.

| Method and path | Limiter | Does |
|---|---|---|
| `GET /api/proposals/:id/menu-draft` | `menuDraftReadLimiter` | Draft (or `null`), pieces (stuck ones reported as failed), the brief, the staleness diff (section 9), print-slot state (section 8, with `approved_by_name`), `cap`, `configured: { openai, gemini }`, per piece its `provider`, `model`, `drawn_count`, `has_image` and `image_rev` (never `r2_key`, section 10.2), and `plan: { id, menu_style, drink_count, drinks: [{ name, mock }], bar_summary }` (null with no plan; `drinks` and `bar_summary` feed the phone lane's drink card). With no plan, a draft is returned read-only |
| `POST /api/proposals/:id/menu-draft/generate` | `adminWriteLimiter` | Multipart: optional `reference` plus `planner_image_role`, `reference_source`, `art_direction`, `drb_mark`, `image_model`. 503 not configured; 503 `MENU_ART_GEMINI_NOT_CONFIGURED` for `gemini` without its key; 422 `MENU_NO_DRINKS` (`new AppError(..., 422, ...)`) when the plan has no drinks or no plan exists; 429 when the run's images would pass the image cap or its words call the text cap. Supersedes any run in progress. 202 |
| `PATCH /api/proposals/:id/menu-draft` | `menuDraftEditLimiter` | Body `{ version, content?, inputs? }`, validated per section 7.1. 409 `MENU_DRAFT_CHANGED` on version mismatch. Bumps `version`; returns the new one |
| `POST /api/proposals/:id/menu-draft/pieces/:pieceKey/reroll` | `adminWriteLimiter` | Body `{ note?, image_model }`. Reserves one image, drawn by `image_model` (503 for `gemini` without its key). 409 while the piece is working, or pending in an active run. 202 |
| `POST /api/proposals/:id/menu-draft/sync` | `adminWriteLimiter` | **Update draft.** Body `{ version, image_model }`; the added drinks' art is drawn by `image_model`. Recomputes the diff (section 9). For each added client-typed drink, a words call for just those drinks runs before the main transaction: a short transaction (`LOCK TABLE` first) reserves its text row, the call is authorized from that row like any other (section 5.5), and a 429 at the text cap refuses the sync before anything is written. Then one transaction: version check (409), append the added drinks (catalog fields directly, `has_art` per section 5.4, `added_by_sync: true`), remove the dropped drinks and their piece rows, set `plan_fingerprint` to the current plan, reserve the added drinks' art, COMMIT. Then queues that art. 202 with the new `version` |
| `POST /api/proposals/:id/menu-draft/dismiss-plan-change` | `menuDraftEditLimiter` | Body `{ version }`. Stores the current plan hash in `dismissed_plan_hash` under the version check and returns the unchanged `version`; it never bumps it (section 6). The banner stays hidden until the plan changes again |
| `GET /api/proposals/:id/menu-draft/pieces/:pieceKey/image` | `menuDraftReadLimiter` | Streams the piece, a `done` one only (any other is a 404, so a piece pending a re-roll is not served). Key must start with `menu-art/<id>/` and contain no `..` or `//`. An optional `?w=240` or `?w=480` returns a `sharp` downscale (PNG keeps alpha) for the card's thumbnail and the phone, so an event-page visit never pulls the full-size layers; any other `w` is refused |
| `GET /api/proposals/:id/menu-draft/reference` | `menuDraftReadLimiter` | Streams the uploaded reference. Key must start with `menu-art/<id>/ref-`, no `..` or `//` |
| `GET /api/proposals/:id/menu-draft/planner-image` | `menuDraftReadLimiter` | Streams the planner image of the event's plan (lowest id). Key must start with `drink-plan-logos/<planId>-`, no `..` or `//`. 404 when the plan has none. Takes the same `?w=` |
| `POST /api/proposals/:id/menu-draft/approve` | `adminWriteLimiter` | Multipart `file` plus `version`, `art_version` and `expected_print_key` (the print key the client confirmed over, or empty for none). Section 8 |

The streaming routes share one helper, `server/utils/r2Proxy.js` (`sendR2Object(res, key, { filename, disposition, width })`: `readFile`, an optional `sharp` resize, then `Content-Type`, `Content-Disposition`, `Cache-Control: private, no-cache` and a digest ETag, the headers `menuPrintFile.js` already sends). It is deliberately a second small helper rather than a refactor of `sendMenuPrintFile`: the shipped print-file downloads are a working money path (staff print from them), and nothing here gives a reason to touch them.

New limiters in `server/middleware/rateLimiters.js`, keyed by user id: `menuDraftReadLimiter` (120 per minute) and `menuDraftEditLimiter` (30 per minute).

Upload checks:
- **Reference:** `isValidUpload(file)` and `safeUploadExtension(file)` returning `.jpg`, `.png` or `.webp`. Anything else, PDF included, is refused.
- **Approve:** JPEG magic bytes only.

### 7.1 Validation (server-enforced; the client mirrors it with `maxLength` and pickers)

| Field | Rule |
|---|---|
| `art_direction` | string, at most 500 characters |
| `image_model` | `openai` or `gemini`; required on Generate, re-roll and Update draft |
| `mark_color` | `ink`, `accent` or `gold` |
| `background_label` | words-step output only; never accepted from PATCH |
| re-roll `note` | string, at most 200 characters |
| `planner_image_role` | `logo`, `reference` or `ignore` |
| `reference_source` | `none`, `planner` or `upload`; a PATCH may set only `none` (removing a reference) or `planner` (when the role is `reference`); `upload` comes only with Generate's file |
| `reference_key`, `image_model` in `inputs` | never accepted from PATCH (`reference_key` is Generate's own upload; `image_model` is a record) |
| `added_by_sync` | written by Update draft and Generate only; never accepted from PATCH |
| `drb_mark` | boolean |
| `title` | 1 to 60 characters |
| `display_name` | 1 to 60 characters |
| `description` | 0 to 200 characters |
| `also_at_bar[].text` | 0 to 120 characters; labels fixed |
| `ink_color`, `accent_color` | `^#[0-9a-fA-F]{6}$` or null |
| `palette` | words-step output only; never accepted from PATCH |
| `headings.sig`, `.mock`, `.more`, `.also` | 1 to 40 characters each |
| `also_at_bar[].label` | 1 to 30 characters |
| `logo_badge` | boolean |
| `font_pairing` | one of the fixed ids (section 10.3) |
| `text_backing` | `off`, `soft` or `panel` |
| `logo_mode` | `above_title` or `replaces_title` |
| `drinks[]` | PATCH replaces the array, but the set of `key`s must equal the stored set; a PATCH may change `display_name`, `description`, `hidden` and `has_art` only (editing a name or description also sets its AI flag false). Adding and removing drinks is Update draft's job alone |
| `has_art` | at most 8 visible drinks true |
| visible drinks | at most 12 (`hidden` false); at most 4 of them without art (the More from the bar list) |

A PATCH replaces only the top-level `content` and `inputs` keys it sends; anything it omits is untouched. It never writes the words-status fields. As built in `menuDraftValidation.js` (2026-10-16): `validatePatch` returns `{ changed, content?, inputs? }` with only the sections the body sent, so the route writes only those columns (an inputs-only PATCH can never carry stale content over the words fill), and when nothing actually changed it returns `changed: false` and the route skips the write and the version bump. A content edit before the words land is a 400 field error; an inputs edit is allowed. `art_direction` may be edited after a draft exists (it applies at the next Start over). `planner_image_role === 'reference'` exactly when `reference_source === 'planner'`, so a PATCH that flips the role sends both. The drink limits refuse only a count that rises, so a Generate that leaves 14 visible can be hidden down one at a time; a stored value echoed back unchanged is never refused for length. Drink fields other than the editable four (and the AI flags, which may only be lowered) are fixed: they must deep-equal the stored value.

## 8. Approve and the print slot

**Shared helper.** `server/utils/menuPrintFile.js` already exists (section 2) and keeps `sendMenuPrintFile` exactly as it is. It gains `setMenuPrintKey(executor, proposalId, key)` beside it, and its header comment ("The ONE way a bar menu print file leaves the server") grows to say it is also the one way the print key is set. It runs the existing `UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2` with its rowCount guard on the executor passed in (the pool or a transaction client). It does NOT upload and does NOT fire duty reaccrual. `reaccrueDuty` moves to that module as an export, and callers fire it after their write is committed.

- **The manual upload (`POST /:id/menu-print`)** keeps today's order: R2 upload, then `setMenuPrintKey(pool, ...)`, then `reaccrueDuty`. `menuPrint.js` still requires `storage` itself, so `menuPrint.test.js`'s `require.cache` stub order is unchanged.
- **Approve:**
  1. The client awaits any pending autosave, then waits for every layer image (10-second timeout per layer; a missing layer fails Approve and names it) and for the fonts (section 10.3). It renders the 800x1000 canvas with `html2canvas` at scale 3, exports `image/jpeg` at quality 0.92, and posts it with the `version` and `art_version` it rendered.
  2. The server checks the JPEG magic bytes, checks with `sharp` that the image is exactly 2400x3000, and uploads it to R2 under `menu-print/<id>/<uuid>.jpg`. No transaction is open yet.
  3. One transaction on one client:
     - `SELECT ... FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE`;
     - refuse with 409 `MENU_DRAFT_CHANGED` when `version` or `art_version` differs from the posted values, or when any piece the layout uses is not `done`;
     - refuse with 409 `MENU_PRINT_CHANGED` ("The print file changed since you confirmed. Check it and approve again.") when the proposal's `menu_print_key` is not the posted `expected_print_key`, so a manual upload from another tab is never silently overwritten;
     - `setMenuPrintKey(client, ...)`;
     - stamp `approved_version` and `approved_art_version` with the posted values, `approved_print_key` with the new key, `approved_planner_image_key` with the planner image key when the role is `logo` (null otherwise), `approved_at`, `approved_by`;
     - insert `proposal_activity_log` (`action: 'menu_approved'`, `actor_type: 'admin'`, details `{ draft_id, version, art_version, print_key }`);
     - COMMIT.
  4. Release the client, then `reaccrueDuty(id)`.

     A rollback leaves an orphaned R2 object, which is the existing precedent. Because duty reaccrual fires after COMMIT, it always reads the committed key.
- **Derived print state on GET**, the first that applies:
  1. **marked no menu needed** when `menu_not_required` is true;
  2. **replaced by a manual upload** when `menu_print_key` is set and differs from `approved_print_key`;
  3. **print file removed** when `menu_print_key` is null and `approved_print_key` is set;
  4. **edited since approval** when `menu_print_key = approved_print_key` and either version moved, or the role is `logo` and the plan's current planner image key differs from `approved_planner_image_key` (the client image was replaced or removed, so staff print a menu with the old logo);
  5. **approved** when `menu_print_key = approved_print_key` and nothing moved;
  6. otherwise none (never approved). A draft may still exist and be edited; approving it posts a print file, and `setMenuPrintKey` clears the flag, as a manual upload does today.
- **Confirm before replacing.** The client asks first whenever `menu_print_key` is set, whether it is an earlier approval or a manual upload (the v3 design confirms in both cases; staff would download the new file instead).

## 9. Plan changed

On every GET, the server rebuilds the plan through `menuDrinkSource.js` (lowest-id plan, decision 8's side) and returns `{ added: [{ key, name }], dropped: [{ key, name }], brief_edited: ['theme' | 'naming' | 'notes', ...], image_changed }` against `plan_fingerprint` (an empty list means the brief is unchanged; `image_changed` is true when the planner image key differs). The card and the editor show a banner naming added and dropped drinks, with **Update draft** (the sync route: adds the added drinks and paints their art, removes the dropped ones) and **Dismiss** (hides the banner until the plan changes again). A softer "brief edited since this draft" note shows when only the brief changed, with **Mark reviewed**, which is the same dismiss route (the fingerprint hash covers the brief and the planner image key, so it hides the note until the plan, brief or image changes again). A changed client image shows the same note with "The client image changed since this draft." On the Brief tab the changed field is tinted and labeled "Edited by client"; the design's date and time are shown only if the plan carries a timestamp for the brief edit, and are left out otherwise rather than guessed from the plan's general `updated_at`. Update draft on an approved draft moves it to edited since approval. When the event has no plan, the editor shows the draft read-only with "No drink plan on this event" and disables Generate and Update draft.

## 10. Client

### 10.1 Files

No new route. The editor is an overlay inside the event page, opened by the query parameter `?menu=1` (section 4.2), so `App.js` is untouched and the admin guard on `/events/:id` covers it.
- `client/src/pages/admin/menuDesigner/MenuDesignerCard.js` (the top half and the card frame) and `MenuCardFold.js` (the Print file and Client image rows). Together they absorb `AdminMenuPrintBlock.js` and `EventDetailPlanLogo.js`, carrying their handlers, busy labels, inline errors, the 10 MB check, the logo input's `image/png,image/jpeg` accept list and messages, the `isSafeLogoUrl` allowlist (moved verbatim into `MenuCardFold.js`) and the shipped `downloadMenuPrint` call. `AdminMenuPrintBlock.test.js`'s three Download tests are ported to `MenuCardFold.test.js`. The two old components and that test are then deleted, after `grep -rn "AdminMenuPrintBlock\|EventDetailPlanLogo" client/src` shows only `EventDetailPage.js` and the ported test; the `.admin-plan-logo*` rules leave `index.css`, and the README and ARCHITECTURE entries for the old cards are updated in the same lane. (A comment in `server/routes/shifts.queries.js` names the old component; it is left alone.)
- `MenuEditor.js` (the overlay shell: top bar, preview column, right panel, confirm dialog), `DesignTab.js`, `DrinksTab.js`, `BriefTab.js`, `EditorBanner.js`, `ConfirmDialog.js`, `MenuCanvas.js` (the layered 800x1000 layout, used for the thumbnail, the live preview and the export), `layouts.js` (pure: drink count and options to slot geometry), `fontPairings.js` (section 10.3), `menuCardState.js` (pure: the GET payload plus local facts to the card's state by table C's precedence, and to the editor's banners and empty cards), `useMenuDraft.js`, `exportMenu.js` (font and layer waits, render, JPEG).
- **The draft hook lives at page level.** `EventDetailPage.js` calls `useMenuDraft(proposal.id)` once and passes it to both `MenuDesignerCard` and `MenuEditor`, so a pending save, a failed save, and the pre-draft brief inputs outlive the editor's open and close. It reads `?menu=1` for the open state and, while open, renders `MenuEditor` in place of the page body (an early return after its hooks). It swaps `AdminMenuPrintBlock` and `EventDetailPlanLogo` for `MenuDesignerCard` and must not grow: the two components it drops pay for what it adds. `useUserPrefs()` is called inside `MenuEditor` only, never in `EventDetailPage`, because `EventDetailPage.fork.test.js` renders the page without a prefs provider.
- **Closing and leaving.** Closing the editor with its back button or Escape awaits the hook's `flush()`. If the save fails, a confirm offers "Close anyway" (the unsaved edits stay in the hook and the card shows Save failed with Retry) or "Stay". Browser Back cannot be held (the app uses `BrowserRouter`, with no navigation blocker), so it closes at once; the flush runs right after, and a failure shows on the card as Save failed with Retry. Text being edited commits on blur before any flush runs.
- **The hook is keyed by event.** `/events/:id` is not a keyed route, so moving to another event (header search, the command palette) keeps `EventDetailPage` mounted and only changes the id. When `proposalId` changes, the hook first flushes any pending save to the **old** id (each PATCH carries the id it was made for, never the current one), then resets the draft, the brief inputs, the held style-reference file, the model choice and the layer cache; the editor closes because `?menu=1` is dropped. Leaving the event pages entirely flushes best-effort on unmount; an edit made in the last moment before navigating away can be lost, which the debounce makes rare and which is accepted for a tool used about 30 times a year.
- **The rail is a temporary override, never a saved preference.** Today the rail is the saved user pref `prefs.sidebar` (`UserPrefsContext.js` writes it to `html[data-sidebar]` and saves every `prefs` change to localStorage; `Sidebar.js` reads it for `rail` and in its footer collapse toggle, which calls `setPref`). `UserPrefsContext` gains `sidebarOverride` (null or `'rail'`) as its **own** `useState`, never a key inside `prefs`, with a setter, both added to the context value. While it is set, the `data-sidebar` write uses it (and the effect depends on it), `Sidebar.js`'s `rail` reads `sidebarOverride || prefs.sidebar`, and the footer collapse toggle is hidden, so nothing in the editor can save the layout. `MenuEditor` sets it on mount and clears it on close and on unmount. Dallas's saved choice and localStorage are untouched.
- **Narrow windows.** Below 900 px wide (the phone's Desktop-view escape lands here before the phone lane exists), the card's editor actions are replaced by the note "Edit the menu on a wider screen." The fold's actions still work.
- The Dr. Bartender mark images go to `client/public/images/menu-mark-avatar.png` and `client/public/images/menu-mark-wordmark.png`, copied byte for byte from the vendored `assets/`.

Each new file stays under 300 lines.

### 10.2 Data and images

- **Polling.** `useMenuDraft` polls GET every 2 seconds while the words step or any piece is pending or working (after the stuck rule), and stops otherwise. On a 429 it backs off to 10 seconds and shows a quiet "reconnecting" note.
- **Refreshing after the fold's actions.** A print-file Upload, Replace, Remove or No-menu change calls the page's `loadProposal` as today and refetches the draft, so the derived print state updates. A client-image Replace, Remove or Upload keeps calling `setDrinkPlan` (as `EventDetailPlanLogo` did; `DrinkPlanCard` and `MenuPNG` read it) and refetches the draft. Approve refetches both.
- **Autosave.** Debounced at 800 ms, with a saving / saved / failed indicator. A 409 refetches the draft, drops unsaved local edits, and says "This draft changed elsewhere and was reloaded."
- **Layer images** (background, drinks, planner logo) load through `api.get(path, { responseType: 'blob' })` into object URLs. The card's thumbnail asks for `?w=240` versions and the editor for full size. The GET never exposes `r2_key` (amended 2026-10-16 in the engine lane): each piece carries `has_image`, true only when the piece is `done` and stored, and an opaque `image_rev` that changes whenever the stored image changes. Piece layers are cached in the page-level hook by `image_rev` and size, and re-fetched only when a piece's `image_rev` changes, so an `art_version` bump downloads only the new piece; a piece with `has_image` false is not fetched. `drawn_count` restarts at 0 on Start over, so it is not a cache key. (The planner logo has no piece row; it is re-fetched after the fold's client-image actions, below.) That keeps the export untainted and stays well inside the read limiter. Object URLs are revoked on replacement and unmount.
- **The Dr. Bartender mark** is the v3 design's two images, the avatar and the wordmark (section 11.2), served from `client/public/images/` (same origin, so the export stays untainted). It replaces the 2026-10-01 glyph-and-text mark, and it is not `menu-logo-gold.png`.
- **AI-written text** renders as plain React text, never HTML.
- **Export failures** go to client Sentry (`tags: { area: 'menu-designer', step: 'export' }`).
- **Drink art is drawn at its own ratio.** html2canvas has no `object-fit`, so a square drink PNG inside the 0.72-wide art box would be stretched in the export. The canvas sizes each drink `<img>` as a square of the box's width, centered vertically in the box, in the preview and the export alike.

### 10.3 Fonts

**Pairing ids are fixed,** shared by the server schema and validation (`server/utils/menuFontPairings.js`) and the client (`fontPairings.js`): `elegant-script`, `rustic`, `modern-clean`, `retro`, `spooky`, `tropical`. The server knows only the ids; faces, sizes and default colors live on the client (section 11, table P).

**Loading.** Menu faces load through plain `<link rel="stylesheet">` tags built by one helper in `fontPairings.js` (a Google Fonts URL for a set of pairing ids). The card loads only the draft's current pairing when it has a thumbnail to draw, so an ordinary event-page visit does not pull all sixteen font families; the editor loads all six on open, since the Design tab previews every pairing. The mark is images, so it needs no face. Do NOT use the `media="print"` swap that `AdminLayout.js` uses; it lets `document.fonts.ready` resolve before the faces are declared, and the export would render in fallback fonts. Before rendering, the export awaits its link's `onload`, then `document.fonts.load()` for every face and weight the current pairing uses, then `document.fonts.ready`. Each wait times out at 10 seconds, and a timeout fails Approve naming the font.

## 11. Visual contract

**Benchmarks.**
- **Part 1, the event-page section (OS skin):** `docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html`, vendored byte for byte on 2026-10-16 from Claude Design project "Menu Designer Admin Interface" (`89b66aac-dd5f-407d-b026-10b78702ce8a`). It is the working input of the card and editor lanes, not only a record. Serve the folder over HTTP (`python3 -m http.server` from it) and open the file; its props switch the skin (After Hours / House Lights), the view (Event page / Editor) and all 19 states of brief v3. If the design project changes, re-pull with DesignSync (`list_files`, `get_file`) and re-vendor before building to it.
- **Part 2, the printed menu:** the 2026-10-01 artifact snapshot `menu-designer.html` (its Layout rules, Boards A to F, Legibility and Font pairings), amended by section 11.2. The quality bar remains `client/public/menu-samples/39.webp` and `40.webp`.
- **Phone (follow-up lane only):** `Menu Phone.dc.html`, shown framed by `Menu Designer Mobile.dc.html`.

**Gate: satisfied 2026-10-16** for Part 1 (v3). Part 2 was satisfied 2026-10-01 and is amended 2026-10-16 for the mark only. The plan's front-matter records this.

**What the vendored files are and are not.** They are built on the OS design system's own tokens and components, so the token rule (11.4) is one to one. Their drink and background art is placeholder SVG, the drafting is simulated with timers, and their JavaScript (the state switch, the timers, `menu-art.js`) is mockup scaffolding, not code to port. Layout, composition, component choices, copy and every number below are the contract, except where table D overrides the files.

### 11.1 Part 1: the Bar menu section (event page, OS skin)

**The card** (`MenuDesignerCard`; right column, after `DrinkPlanCard` and the "View event details" link; `.card`):
- **Head:** "Bar menu" and a `StatusChip` (table C).
- **Body:** a row, gap 12:
  - the thumbnail box, 96 x 120: the menu at scale 0.12 (`MenuCanvas` without editor affordances, from the `?w=240` layers), which opens the editor when clicked whenever a draft exists, whatever the actions say (except below 900 px, section 10.1); with no draft, a dashed box (1.5 px `--line-3`, radius 3) reading "8 × 10" in 10.5 px `--ink-4`;
  - a text column, gap 4: the message (13 px, 500, `--ink-1`) and the sub line (12 px, `--ink-3`) from table C; while drafting, a 4 px progress bar (`--bg-3` track, `--accent` fill); then, 8 px below, the actions (gap 6, wrapping): the primary as `btn btn-primary btn-sm` (or `btn btn-secondary btn-sm` where table C says so) and a secondary as `btn btn-ghost btn-sm`. When a draft exists, the primary is not View, the row has no secondary of its own, and the state is not Approving, a ghost **View** joins as the secondary (the vendored rule). An in-place action shows its own busy label while it runs, and its error (422, 429, 503, 409) appears as one `role="alert"` danger line under the actions, in the old cards' style.
- **Fold** (top border `--line-1`), two rows, each padded 9 / 16, with a `.meta-k` label over a 12.5 px value:
  - **Print file:** the value reads "Approved menu · <approved_at date>" (the approved file), "Uploaded file" (a manual upload; its name and date are not stored), "Removed", or "None yet". With a file: **Download** (`btn btn-secondary btn-sm`, the shipped admin read; "Downloading..." while it runs, never blocking an upload) and a `KebabMenu` with **Replace file** and **Remove**. Without one: **Upload** (`btn btn-ghost btn-sm`) and a `KebabMenu` with **No menu needed for this event**, which reads **A menu is needed after all** once marked (the old checkbox toggled both ways, and the fold must keep that even when the card's top half cannot load). "Working..." replaces the value while an upload, replace, remove or flag change runs. The hidden file input, its accept list, the 10 MB check and the old card's messages carry over from `AdminMenuPrintBlock` unchanged, shown as a `role="alert"` line under the row.
  - **Client image:** a 28 x 28 thumbnail (radius 4, `--line-2` border, on `#fbf8f3`) of the planner image (`?w=240`), then its role as the value: Logo on top, Style reference or Ignored (the draft's `planner_image_role`; Logo on top before any draft). The original filename is not stored, so none is shown. A `KebabMenu` holds the old widget's **Replace** and **Remove** and, behind its `isSafeLogoUrl` rule, **Download original** as an `onClick` that opens a new tab (`window.open(url, '_blank', 'noopener,noreferrer')`; a KebabMenu `href` item would navigate the admin tab away). "Uploading..." replaces the value while it runs, and its errors (`fieldErrors.logo`) show as a `role="alert"` line. With no image: "No image" and **Upload** (`btn btn-ghost btn-sm`). With no plan: "No drink plan" and no actions. An image replaced or uploaded here keeps the draft's current role.

**Table C: the card by state.** Kinds are `StatusChip` kinds. `<drink>`, `<date>` and the like are filled from the GET payload.

**Precedence.** Several facts can hold at once; the card and the editor's top-bar chip show the first that applies, in this order: Loading; Couldn't load; Approving; Save failed; Generating (a Generate, a single re-roll or an Update draft painting); Words failed; Drawing failed; Plan changed; Notes edited; then the print state in section 8's order (No menu needed; Replaced by upload; Print file removed; Edited since approval; Approved); Draft ready (Saving shows as its sub line); then, with no draft: Not set up; No plan; No drinks; Never generated. One secondary fact rides in the sub line instead of its own row: when the approved file is still the print file (`menu_print_key = approved_print_key`) under a later state, the sub reads "Staff still get the <date> version." The daily image limit and "Too long" are never card states: the cap is global and would otherwise mark every event, and overflow is measured only in the editor's full-size layout. Without the OpenAI key a draft still shows its own state (viewing, editing text, approving and the fold all work); only the editor's drawing controls are off.

| State | Chip | Message | Sub | Actions |
|---|---|---|---|---|
| Loading | (none) | a skeleton of the top half | | none; the fold renders as soon as the proposal is loaded |
| Couldn't load | danger, Error | Couldn't load the menu draft. | <reason> | Retry; the fold still works |
| Not set up | neutral, Not set up | Menu art isn't set up. | The AI key isn't on the server yet. | none |
| No plan | neutral, No plan | No drink plan yet. | Menus are built from the drink plan. | none |
| No drinks | neutral, No drinks | Nothing to put on a menu yet. | Drafts are built from the drink plan. | none |
| Never generated | neutral, Not started | Draft a custom 8×10 menu. (house menu: "The client chose the house menu." / no menu: "The client asked for no menu.") | From the drink plan and the client's menu notes. (house: "Draft a custom one anyway, or use the house menu below.") | Generate (a ghost Generate for house and no-menu events); ghost Open editor |
| Generating | info, Drafting | Writing the words... / Painting <k> of <n> | About 2 min. Keep working. | ghost Watch |
| Draft ready | warn, Draft | Ready to review. | Saved <relative time> | View |
| Drawing failed | danger, 1 drawing failed (or <n> drawings failed) | <drink> didn't draw. (or "<n> drawings didn't come through.") | Re-roll it in the editor. | Fix (opens the Drinks tab with the first failed drink selected) |
| Words failed | danger, Words failed | Couldn't write the menu text. | No images were used. | Retry |
| Plan changed | info, Plan changed | <drink> was added to the plan. (or dropped; "<n> drinks changed on the plan." for more than one) | Update the draft to include it. | Update draft; ghost Dismiss |
| Notes edited | info, Notes edited | Client edited their menu notes. (or "The client image changed.") | Review before approving. | Review (opens the Brief tab) |
| Saving | warn, Draft | Ready to review. | Saving... | View |
| Save failed | danger, Not saved | Last change didn't save. | Edits are kept until you retry. | Retry |
| Approving | info, Approving | Saving the print file... | (none) | none |
| Approved | ok, Approved | Print file ready for staff. | Approved <date> by <name> | View (secondary style) |
| Edited since approval | warn, Edited since approval | Staff still get the <date> version. | Approve again to update it. | Review & approve |
| Replaced by upload | neutral, Not in use | Print file is a manual upload. | This draft isn't what staff print. | View (secondary style) |
| Print file removed | warn, No print file | Print file was removed. | Staff have nothing to print. | Review & approve |
| No menu needed | neutral, No menu needed | Marked no menu needed. | (none; with a draft, "A draft exists; approving it posts a print file.") | ghost Undo |

Fix, Review, Review & approve, Watch and Open editor open the editor; Generate, Retry, Update draft, Dismiss and Undo act in place, drawing with GPT Image (section 4.1). The card's Generate posts the hook's current brief inputs (the defaults if the editor was never opened). Update draft at the cap is refused like any image request and says why in the error line.

**The editor** fills the admin main area in place of the event page body; the sidebar shows as its rail (section 10.1) and the header stays. On open, focus moves to its back button; on close it returns to the card button (or thumbnail) that opened it. Escape closes it when no dialog is open.

**Top bar** (56 px, padding 0 20, gap 12, bottom border `--line-1`), left to right:
- a ghost small back button with the `left` icon and the event's header label (client name plus `getEventTypeLabel`, never a stored title);
- a 1 x 18 divider (`--line-2`), then "Bar menu" (15 px, 600) and the status `StatusChip` (table C's chip);
- a flexible spacer, then the save text (`--font-numeric`, 11.5 px, `--ink-3`): Drafting..., Saving..., Saved, Approving..., or Not saved in danger; empty with no draft. When the save failed, a small secondary **Retry** follows it;
- a 1 x 20 divider, then **Approve** (`btn btn-primary`). Its label is Approve; Approve again after edits or after the print file was removed; Use as print file when a manual upload is in place; Approving...; or a disabled Approved. It is disabled with no draft, while drafting, while approving, once approved, while text is too long ("Shorten the long description first") and while a drawing has failed ("Fix the failed drawing first"); the reason is its title.

**Body:** a grid, `minmax(0, 1fr) 340px`.

*Preview column:*
- the banner, when one shows (margin 14 24 0; table B);
- a scrolling area (padding 14 24 28) centering a column (gap 8) as wide as the scaled canvas:
  - a meta row (`--font-numeric`, 11 px, `--ink-3`, space-between, wrapping): "8 × 10 in · <pairing name> · <n> drinks" and, with a draft, "Click text to edit · dotted = AI-written";
  - while drafting, a 3 px progress bar;
  - the canvas, scaled to fit: scale = the smaller of (viewport height minus 48, 56, the banner allowance and 60) over 1000 and (viewport width minus 56, 340 and 64) over 800, clamped to 0.3 to 0.8, where the banner allowance is 60 with a banner and 14 without. Shadow `0 1px 2px rgba(0,0,0,.2), 0 14px 34px rgba(0,0,0,.28)`;
  - with no draft, the empty card in the canvas's place: a dashed box (1.5 px `--line-3`, radius 4, `--bg-1`, padding 36) with a centered title (16 px, 600), text (12.5 px, `--ink-3`, at most 36ch) and a button (table E).

*Banner:* a rounded row (radius 6, padding 9 10 9 14, gap 12, 12.5 px) with a 7 px tone dot, a 600 title and `--ink-2` text, and on the right up to two small buttons: a ghost then a secondary. Tones are ok, warn, danger and info, built the vendored `TONE` way (fill at .10 alpha, line at .32 to .36, dot at 52 to 62% lightness) but on `StatusChip`'s fixed hues (ok 145 / 55%, warn 38 / 92%, danger 358 / 72%, info 208 / 72%), so a banner always matches the card's chip; and neutral (`--bg-2` fill, `--line-2` line, `--ink-3` dot). When two apply (plan changed after approval), they stack with an 8 px gap.

*Right panel* (`--bg-1`, left border `--line-1`):
- a tab strip (padding 0 12, bottom border `--line-1`): **Design**, **Drinks**, **Brief** (12.5 px, 600; the active tab `--ink-1` with a 2 px `--accent` underline, the others `--ink-3`). The default tab is Design with a draft and Brief without one; selecting a drink on the canvas switches to Drinks. Design and Drinks render at 0.45 opacity and inert until the words land (the `inert` attribute set through a ref, since React 18 has no `inert` prop);
- a scrolling body (padding 16). Every section label is 11 px, uppercase, 0.1em, 600, `--ink-3`, with an optional 11 px `--ink-4` note on the right.

**Design tab** (sections gap 22, each gap 8):
- **Font pairing:** six stacked buttons (gap 4; padding 6 10; radius 6; a `--line-1` border on `--bg-2`, or an `--accent` border on `--accent-soft` when chosen), each reading "Bar Menu" in that pairing's title face (at min(26, 0.3 × the title size) px, its weight and case, with 0.18em tracking for uppercase faces) and its id on the right in `--font-numeric` 10.5 px `--ink-3`. Choosing one resets ink and accent to that pairing's defaults.
- **Colors:** a 52 px label column (Ink, Accent; 12 px `--ink-3`) beside 22 px round swatches (gap 6, wrapping), each titled. The chosen swatch has the ring `0 0 0 2px var(--bg-1), 0 0 0 4px var(--accent)`, the others `inset 0 0 0 1px rgba(0,0,0,.2)`. Ink: Pairing default, Plum `#6b3a6e`, Navy `#1f2a44`, Charcoal `#2a2a2a`. Accent: Pairing default, then the words step's `palette`. "Pairing default" is the light-art or dark-art default by tone (11.2).
- **Text backing:** `.seg` Off / Soft / Panel.
- **Background:** a bordered row (padding 8 10, radius 6, `--line-1` on `--bg-2`) with `background_label` over "Version <drawn_count>" (or "Painting..."), plus " · Gemini" when the piece is `done` and Gemini drew it, and a small secondary **Re-roll**, disabled when no image remains under the cap or while drafting.
- **Dr. Bartender mark:** a `role="switch"` row (a 30 x 18 track, `--accent` on and `--line-3` off) reading "Dr. Bartender mark" over "Small, bottom right"; when on, a "Wordmark color" row with `.seg` Theme ink / Accent / Gold.

**Drinks tab:**
- the label "Drinks" with "<k> of 8 illustrated" on the right (`--font-numeric`, 11 px);
- a bordered list (radius 6), one row per drink in menu order. Each row is a button, a grid of `16px 1fr auto` (padding 8 10): the two-digit number (`--font-numeric`, 10.5 px, `--ink-4`); the name (12.5 px) over its sub line (11 px, `--ink-3`: Signature, Mocktail, or New from plan for a drink Update draft added, plus " · Gemini" when its art is `done` and Gemini drew it); and a status (10.5 px, 600): PAINTING (info), WAITING, FAILED (danger), HIDDEN, or nothing when done. "New from plan" reads `added_by_sync`. Hidden rows are at 0.5 opacity and struck through;
- the selected row (`--row-active`) opens beneath (padding 0 10 10 34): the re-roll note as an `.input` with the placeholder "Note for the re-roll, e.g. add a salt rim" (at most 200 characters), then **Re-roll art** (small secondary; disabled when no image remains under the cap) and **Hide** or **Show** (small ghost);
- a footer note (11.5 px, `--ink-3`): "Up to 8 are illustrated. Drinks 9 to 12 list as text under “More from the bar”."

**Brief tab** (sections gap 22):
- **Client brief**, noted "Potion Planner · read-only": a box (`--bg-2`, `--line-1` border, radius 6, padding 10 12, gap 10, 12.5 px) with `.meta-k` labels for Theme & colors (the text, the palette as 16 px dots, and the color names in 11.5 px `--ink-3`), Drink naming and Design notes. A field the client edited since the draft is tinted info at .14 and labeled "Edited by client" beneath (section 9).
- **Client image:** a 64 px thumbnail (radius 6, `--line-2`, on `#fbf8f3`), the label "From the planner" (`--font-numeric`, 11.5 px, `--ink-2`; the original filename is not stored) and `.seg` Logo / Style ref / Ignore. Under Logo, a grid with a 72 px label column: Placement (`.seg` Above title / Replace title) and Backing (`.seg` None / Badge). Under Style ref: "Used as the style reference below. Not printed." With no planner image the section reads "The client didn't upload an image."
- **Style reference**, noted "Optional · never printed": a file row (`--bg-2`, `--line-2`, radius 6, padding 7 10) with the name ("Client image" when it is the planner image) and a ghost **Remove**, or a dashed drop zone (1.5 px `--line-3`, radius 6, padding 12) reading "Drop an image to steer the style" with a small secondary **Upload**. A file dropped on the zone is taken like Upload. Once a draft exists, a newly chosen file is held in the hook and its row adds "Applies when you start over" (section 4.3).
- **Art direction:** a 3-row `.input` textarea (at least 64 px, resizable vertically), placeholder "e.g. watercolor, moody, gold accents", at most 500 characters.

**Panel footer** (fixed below the body; padding 12 16, top border, gap 8):
- an "Image model" row (12 px, `--ink-3`) with `.seg` **GPT Image** / **Gemini**, GPT Image first and selected on every load (decision 11). Without a Gemini key, Gemini is disabled and titled "Gemini isn't set up".
- the full-width Generate button with the `sparkles` icon: **Generate** (`btn btn-primary`) with no draft, or **Start over** (`btn btn-secondary`) once one exists. It is disabled when not set up, with no drinks, while drafting or approving, and when the images it needs (the background plus each drink with art) exceed `cap.remaining`. Marked no menu needed does not disable it.
- a centered 11.5 px `--ink-3` hint: "About 2 minutes, about <n> images, drawn by <GPT Image | Gemini>." with no draft, or "Re-drafts words and art from scratch, drawn by <model>." with one; "Needs <n> images; <remaining> left in the last 24 hours." when the cap is short; "Re-rolls resume <time>." when nothing remains; "Generate needs an AI key and drinks on the plan." when blocked.

**Confirm dialog** (over the editor; scrim `rgba(0,0,0,.45)`): a 400 px card (`--bg-elev`, `--line-2`, radius 10, `--shadow-pop`, padding 18 20, gap 10) with a 15 px 600 title, 12.5 px `--ink-2` text, then Cancel (ghost) and the action, right-aligned. Escape and Cancel close it; focus moves into it and returns to the button that opened it.
- **Start over:** "Start over?" / "This discards the draft, its drawings and your text edits, then drafts again from the plan. Uses about <n> images." / **Start over** (`btn btn-danger`).
- **Approve over an existing print file:** "Replace the print file?" / "Staff will download this version instead of the one approved <date>." (or, over a manual upload, "Staff currently download a manual upload. Approving makes this draft the print file instead.") / **Replace and approve** (`btn btn-primary`).

**On-canvas editing (never printed; canvas px, so it scales with the preview):**
- **Text:** editable elements are `contenteditable` with a text cursor, a 3 px radius and a 4 px outline offset; focus shows the system's 2 px accent outline. Edits commit on blur or Enter. AI-written or AI-suggested text carries a 2 px dotted underline in `rgba(43,120,214,.9)`, offset 5, until edited.
- **Selecting a drink:** clicking its art outlines the slot (2.5 px `#2b78d6`, offset 10, radius 8) and shows two pills above the art (16 px 600 Inter, padding 8 12, radius 7, white on `rgba(18,22,30,.9)`): **Re-roll art** (absent at the cap) and **Hide**. Clicking elsewhere clears the selection. The Drinks tab's rows are the keyboard path to the same actions.
- **Slots:** painting is a dashed box (2.5 px `rgba(90,90,100,.5)`, radius 12, on white at .4) with the moving sheen and "Painting..."; waiting is the same at .42 on white at .3 reading "Waiting"; failed is red (2.5 px dashed `rgba(190,50,30,.85)` on `rgba(255,236,232,.92)`, text `#8c2414`) reading "Couldn't draw this one" with a **Re-roll** button (`#8c2414`). A failed words step leaves no text, so the editor shows table E's empty card instead of a canvas, and its "not attempted" pieces raise no Drawing failed banner or Approve reason.
- **Background painting:** a flat `#ebe7ec` ground with the sheen and "Painting the background..." near the bottom (18 px, 600, `rgba(40,40,50,.5)`).
- **Too long:** the flagged element gets a 2.5 px dashed `#c0392b` outline, offset 5.
- **Reduced motion:** with `prefers-reduced-motion`, the sheens stop.

**Table B: editor banners.**

| State | Tone | Title | Text | Buttons |
|---|---|---|---|---|
| Generating | info | Words are in. / Painting <drink>... | Painting the background next. / <k> of <n> drinks done. Text is editable now. | none |
| Drawing failed | danger | One drawing failed. (or "<n> drawings failed.") | <drink> didn't draw<: the provider's reason, when given>. Re-roll it or hide it. (or "Re-roll or hide the flagged drinks.") | Re-roll (one failure only) |
| Image limit (nothing left) | warn | Daily image limit reached. | <used> of <limit> images used in the last 24 hours. Re-rolls resume <time>. Text, type and color still work. | none |
| Not set up, with a draft | neutral | Drawing is off. | The AI key isn't on the server. Text, type, color and Approve still work. | none |
| Plan changed | info | Plan changed since this draft. | <drink> was added. / <drink> was dropped. Updating paints only the new drinks. | ghost Dismiss, Update draft |
| Notes edited | info | Client edited their menu notes. (or "The client image changed since this draft.") | <field> changed. The draft hasn't been updated. | Mark reviewed |
| Save failed | danger | Last change didn't save. | Your edits are kept in this tab. | Retry |
| Save conflict | warn | This draft changed elsewhere. | It was reloaded. | none |
| Text too long | danger | Text too long to fit. | <element> runs past the page. Shorten it to approve. | none |
| Approve rejected | danger | Couldn't approve. | <the server's reason> | none |
| Approved | ok | Approved <date>. | This is the print file staff download. Edits make a new draft until you approve again. | Download |
| Edited since approval | warn | Edited since approval. | Staff still get the <date> version until you approve again. | none |
| Replaced by upload | neutral | Print file is a manual upload. | Approving replaces it with this draft. | none |
| Print file removed | warn | Print file was removed. | Staff have nothing to print. Approve to restore it. | none |
| No menu needed | neutral | Marked no menu needed. | Approving still posts this menu and clears the mark. | Undo |
| No plan, with a draft | neutral | No drink plan on this event. | The draft is read-only. | none |
| Couldn't load | danger | Couldn't load the menu. | <reason> | Retry |

**Table E: the empty editor.** Loading is a skeleton of the preview and the panel.

| State | Title | Text | Button |
|---|---|---|---|
| Not set up | Menu art isn't set up | The AI key isn't on the server yet. | none |
| No drinks | No drinks on the plan | Menus are built from the drink plan. Add drinks there, then come back. | Open drink plan (secondary; closes the editor, the drink plan card is beside the menu card) |
| No plan | No drink plan on this event | Menus are built from the drink plan. | none |
| Never generated | No draft yet | Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes. | Generate (primary) |
| Words failed | Couldn't write the menu text | The words step failed, so no images were used. Try again. | Retry (primary) |
| No menu needed | No menu for this event | Undo to draft one. | Undo (secondary) |

**Table D: where this contract overrides the vendored files.**
1. **Image model:** GPT Image is first and selected on every load (decision 11); the files had Gemini. Their model hints ("best at clean text and type", "best at painterly art, faster") are replaced by the factual "drawn by <model>", and a piece Gemini drew is labeled " · Gemini".
2. **Not set up:** there is no Settings screen for keys; they are Render environment variables. "Add a key in Settings" and the Open settings buttons are dropped.
3. **Daily limit:** the cap is `MENU_ART_DAILY_IMAGE_CAP` (60) over a rolling 24 hours, and the resume time comes from `cap.resets_at`. The files' "40 of 40" and "at midnight" are placeholders.
4. **Download:** one Download button. An approval is a JPEG, and a manual upload is whatever was uploaded; the files' separate PDF and PNG buttons are dropped.
5. **Facts the system does not store are left out, never invented:** the date a print file was removed, a manual upload's filename and date, the client image's original filename (the files' "monogram.png"), who marked "no menu needed" and when, and the time of the client's brief edit unless the plan records one (section 9). The files' sample filenames also carried client names, which the app never shows here.
6. **Actions the old cards had and the files did not draw** live in `KebabMenu`s on the fold rows (decision 12): Replace file, Remove, No menu needed, and the logo's Replace, Remove and Download original. The card's Not started state gains a ghost **Open editor**, so the brief can be set before generating.
7. **The printed menu:** the files' copy of it drifted from the 2026-10-01 benchmark (four drinks in one row instead of 2 + 2, slot widths 300 and 146 for one and four, art heights starting 260 / 210 / 160 / 120, the mark at 34 from the bottom). The 2026-10-01 numbers stand (11.2); only the mark changes.
8. **Banner colors:** the files build banners from the palette hues (`--ok-h` and friends), which `UserPrefsContext` sets at runtime to the snapshot's own values (in After Hours, danger is violet and warn cyan), while `StatusChip` uses fixed hues. Banners use the chips' fixed hues so a "Drawing failed" chip and its banner are the same red (11.1, Banner).
9. The Panel backing's `backdrop-filter` is not used (11.3).
10. **Image limit and Too long are not card states** (table C's precedence): the cap is global, and overflow is measured only in the editor. They stay editor banners.
11. **Navigation details the files leave out:** the `?menu=1` open state, flushing on close, Escape, focus return, and the 900 px narrow-window note (sections 4.2, 10.1).

### 11.2 Part 2: the printed menu (800 x 1000 canvas, 100 px = 1 in; not the OS skin)

**Layers, back to front:**
1. the background image, full bleed;
2. the text backing;
3. the page: logo, title, ornament, drink groups, More from the bar, Also at the bar;
4. the mark.

**Page box.**
- Padding 58 top, 66 sides, 86 bottom.
- A centered flex column with a 20 px gap.
- Text centered.
- The safe area is 40 px inside the trim for text, logo and mark; the background runs to the edge.

**Head.**
- **Logo:** 96 px tall above the title, or 150 px tall when replacing it. With **Badge**, it sits on `#fbf8f2` with a 20 px radius, 10/14 padding and a soft shadow, for white-box logos and dark art.
- **Title:** in the pairing's title face, at its size, weight, case and tracking, in the accent color.
- **Ornament:** a 230 x 14 rule with a center diamond and two dots, in the accent color.

**Drink groups.**
- **Group heading:** in the heading face, 15 px, 0.22em tracking, uppercase, accent color, with 46 px hairlines either side. Signatures and mocktails are separate groups; mocktails start a new row under their own heading and count toward the 8 illustrated.
- **Rows:** split per group by count. 1, 2 and 3 are one row; 4 is 2 + 2; 5 is 3 + 2; 6 is 3 + 3; 7 is 4 + 3; 8 is 4 + 4. Rows are centered, with gaps of 16 vertical and 26 horizontal.
- **Slot width** by row length: 1 → 360, 2 → 250, 3 → 200, 4 → 152 px.
- **Slot contents:** the art box (height `--il`, width 0.72 x `--il`), then the name (heading face at its size and weight, ink), then the description (body face at its size and weight, ink, line-height 1.32). Gap 6.
- **Art height:** starts by the total row count across both groups: 1 → 280, 2 → 210, 3 → 165, 4 or more → 130. While the page is taller than 1000 px it shrinks in 6 px steps, never below 65 px. Text never shrinks for art.

**More from the bar** (visible drinks without art, at most 4): a group heading, then a two-column grid 620 px wide with gaps of 10 and 40. Names are at 0.82 x the heading size and descriptions at 0.93 x the body size.

**Also at the bar:**
- A footer pinned to the bottom of the page box (`margin-top: auto`), max width 560.
- Its group heading, then one line per entry: the label (heading face, accent, uppercase, 0.08em, 0.78em) followed by the text (body face).
- Leaving it out returns its space to the art.

**Mark** (amended 2026-10-16 from the v3 design; it replaces the glyph and "Dr. Bartender" text):
- Absolute, 40 from the right and 40 from the bottom (the v3 files put it 34 from the bottom, which breaks the 40 px safe area; the safe area wins).
- A row, gap 8, vertically centered: the avatar (`menu-mark-avatar.png`, 40 px tall, natural width), then the wordmark (`menu-mark-wordmark.png`, 159 x 18) in the mark color.
- Mark color from `mark_color`: `ink` is the resolved ink (table P by tone, or `ink_color`), `accent` the resolved accent, `gold` `#d9b77e`.
- Off when `drb_mark` is false.

**Text backing** (color from the background piece's `ground_rgb`):
- **Off:** nothing.
- **Soft** (default): an elliptical feather, 60% x 56% at the center, at 0.8 alpha, 0.58 at 58%, and 0 at 86%.
- **Panel:** inset 50 / 54 px, filled at 0.86 alpha, with a 7 px inner ring of the same fill and a 1 px accent hairline inside it.

**Type floors and overflow.** Names never go below 20 px and descriptions never below 14 px. If the page still overflows with the art at 65 px:
1. heading and body sizes step down once, by 10%, never below the floors;
2. if it still overflows, the overflowing elements are flagged "Too long" (section 11.1), and Approve stays disabled until the text is shortened.

**Colors.** Ink and accent default to the pairing's light-art or dark-art set by the background piece's `tone`. While the background is pending, the light set applies. `ink_color` and `accent_color` override when set.

**Table P: pairings** (sizes in canvas px; a design key in brackets where it differs from the fixed id):

| id | Name · theme | Title | Heading (names) | Body | Light art ink / accent | Dark art ink / accent |
|---|---|---|---|---|---|---|
| `elegant-script` [script] | Garden Script · Elegant script | Pinyon Script 400, 88 | Cormorant Garamond 700, 25 | Cormorant Garamond 500, 17.5 | `#2c2238` / `#8a6a2f` | `#f5eedf` / `#dcbc6e` |
| `rustic` | Barn & Ledger · Rustic | Rye 400, 60, 0.02em | Alegreya SC 700, 22, 0.02em | Alegreya 400, 16 | `#33251a` / `#8e3b1c` | `#f2e7d3` / `#e5a45a` |
| `modern-clean` [modern] | Gallery · Clean modern | Josefin Sans 300, 54, uppercase, 0.32em | Josefin Sans 600, 18, 0.1em | Karla 400, 15 | `#1d232b` / `#3d5c8c` | `#eef2f6` / `#a7c4f2` |
| `retro` [disco] | Mirror Ball · Retro / disco | Shrikhand 400, 68 | Righteous 400, 21, 0.01em | Work Sans 400, 15 | `#2a1838` / `#c8336f` | `#fcf0f7` / `#ffb0d0` |
| `spooky` | Hollow · Spooky | Creepster 400, 84, 0.03em | IM Fell English SC 400, 23, 0.02em | IM Fell English 400, 16 | `#1f1a15` / `#8d2f10` | `#f0e7d7` / `#f2902e` |
| `tropical` | Tiki Hour · Tropical | Pacifico 400, 64 | Fredoka 600, 22 | Nunito Sans 400, 15 | `#173a38` / `#cf4f37` | `#f2fbf6` / `#ffb27a` |

### 11.3 Export parity (the preview must match the printed file)

- **Render a hidden instance.** The export renders a hidden, unscaled 800 x 1000 `MenuCanvas` instance without the editor affordances (the `MenuPNG.jsx` precedent), never the scaled live preview.
- **No CSS features `html2canvas` can't draw.** It does not draw `backdrop-filter`, so the Panel backing has no blur in the preview or the export; the 0.86 fill carries it alone.
- **The Soft backing is an image layer.** It is drawn to an offscreen canvas and placed as an image, so the export reproduces it exactly instead of depending on `html2canvas` radial-gradient support.
- **Vector parts are images or plain shapes.** The ornament is inline SVG with a fixed size and a stroke color set directly, not a CSS variable.
- **The wordmark is tinted before it is placed.** The v3 files color it with a CSS `mask`, which `html2canvas` does not draw. The canvas draws the wordmark PNG to an offscreen canvas, fills it with the mark color under `source-in`, and places the result as an image, in the preview and the export alike. Both mark images load from `client/public/images/` (same origin), so the export canvas is never tainted.

### 11.4 Token rule and components

**Part 1 adopts the design system's tokens one to one.** The v3 files are built on the OS design system, whose tokens were extracted from `index.css`'s `[data-app="admin-os"]` rules, so every token they use exists in `index.css` under the same name (checked 2026-10-16): `--bg-0` to `--bg-3`, `--bg-elev`, `--line-1` to `--line-3`, `--ink-1` to `--ink-4`, `--accent`, `--accent-soft`, the status hues `--ok-h/-s`, `--warn-h/-s`, `--danger-h/-s`, `--info-h/-s`, `--shadow-pop`, `--font-ui`, `--font-numeric`, `--row-active` and `--radius-lg`. The values come from `index.css`, except the status hues and accent, which `UserPrefsContext` writes inline at runtime from its `PALETTES` (identical to the snapshot's). Both skins come from those tokens. Banners take `StatusChip`'s fixed hues instead (table D, item 8). The literal colors inside the canvas's editor layer (`#2b78d6`, `#c0392b`, the slot states and the sheen) stay literal, since they draw over the menu, not the OS.

**Part 2 uses no OS tokens.** Its colors come from table P, `ink_color` / `accent_color`, `mark_color`, and the background's `tone` and `ground_rgb`.

**Components and classes** (all already in the app; checked 2026-10-16):
- `StatusChip`, the adminos `Icon` (`left`, `sparkles`, `kebab`, `download`, `plus`) and `KebabMenu`;
- the classes `.card`, `.card-head`, `.card-body`, `.meta-k`, `.tag`, `.seg` (with `button.active`), `.input`, `.scroll-thin` and the `btn btn-primary`, `btn-secondary`, `btn-ghost`, `btn-danger` and `btn-sm` variants, used as the files use them;
- new CSS goes in `index.css` under an `md-` prefix (the card's thumbnail box and fold rows, the editor shell and top bar, banners, tabs, panel sections, swatches, the drink list, the drop zone, the empty card, the confirm dialog) and an `mc-` prefix for the print canvas, which is styled only through the variables in table P. Inline styles in the vendored files become `md-` rules; the numbers carry over exactly.

### 11.5 Ownership

Two lanes own visual fidelity, each with `Menu Designer v2.dc.html` as its declared working input (layout, numbers, copy, states) and table D as its list of overrides: `menu-designer-card` owns the file's Event page view (the card, table C) and the printed menu (the 2026-10-01 snapshot plus section 11.2); `menu-designer-editor` owns its Editor view (tables B and E). `ui-ux-review` judges it against those files in both skins and every state the files can switch to: usability-clean but off-design is a finding. The follow-up lane `menu-designer-phone` owns `Menu Phone.dc.html` the same way.

## 12. Failure modes

| Failure | Behavior |
|---|---|
| `OPENAI_API_KEY` unset | `configured.openai: false`; with no draft the card and editor show "Menu art isn't set up"; with a draft they show its own state and the "Drawing is off" banner; Generate, re-roll and Update draft return 503 `MENU_ART_NOT_CONFIGURED`; no Sentry page |
| `GEMINI_API_KEY` unset | `configured.gemini: false`; the toggle's Gemini option is disabled ("Gemini isn't set up"); a `gemini` request returns 503 `MENU_ART_GEMINI_NOT_CONFIGURED`; OpenAI is unaffected |
| Gemini answers with text and no image, or blocks the prompt | The piece fails with the readable reason (section 5.1); re-roll |
| Gemini ignores the magenta instruction | The key-out finds too little key color and fails the piece: "Gemini didn't leave a clean background. Re-roll it." |
| Gemini's spend limit (429 `RESOURCE_EXHAUSTED`) | Waits 20 seconds when no `Retry-After` is sent, at most 2 retries, then fails the piece; OpenAI still works |
| Words step fails (network, billing, quota, bad JSON) | `words_status = failed` with the reason; the end-of-run sweep fails every image piece "not attempted"; Retry re-posts Generate |
| An image fails | Only that piece fails, with the reason and a re-roll |
| 429 from either provider | Wait `Retry-After` (max 60 s; 20 s when none is sent), at most 2 retries, then fail the piece |
| Timeout, 5xx, connection error | Fail the piece without retry (may be billed); re-roll reserves again |
| Moderation refusal | Piece fails with the provider's reason |
| Server restart mid-run | Heartbeats go stale; after `MENU_ART_STALE_MS` the words step and the run's pending and working pieces read as failed ("interrupted") |
| Daily cap reached | 429 `MENU_ART_CAP_REACHED`; `cap` on GET shows used, limit and reset time; nothing is called |
| Plan has no drinks, or no plan | Generate disabled with the reason; server 422 `MENU_NO_DRINKS` |
| Catalog id with no row | Treated as client-typed, AI-written description, marked |
| Planner image removed after generation, or R2 404 on a layer | That layer shows missing; Approve fails naming it; the logo role reads "planner image removed" |
| R2 unavailable | `ExternalServiceError`; the piece or Approve fails; nothing half-written in the database |
| Browser export fails | Approve shows the error; client Sentry; nothing posted |
| Text overflows the page after the art reaches 65 px and the one type step | Elements flagged "Too long"; Approve disabled until shortened (section 11.2) |
| Background tone cannot be read (`sharp` error) | `tone` stays null and the light set applies; the piece is still `done` |
| Draft changed between export and approve | 409 `MENU_DRAFT_CHANGED`: "The draft changed. Approve again." |
| Autosave conflict | Draft reloaded, unsaved local edits dropped, the editor says so |
| Proposal deleted | Draft and pieces cascade; ledger rows keep a null `proposal_id` |
| The draft GET fails on the event page | The card's top half shows Couldn't load with Retry; the fold (print file, client image) keeps working from the proposal and plan already loaded |
| Gemini returns 200 with `status: failed` or `incomplete` | The piece fails with the reason from `errors[0]`, as a refusal |
| A stored key outside its prefix reaches the job | The piece fails ("reference unavailable") and nothing is read or sent (section 5.4) |
| A cap, timeout or stale env value is zero, blank or nonsense | The default applies, with one boot warning (section 5.5) |
| The print file changed after the confirm | Approve answers 409 `MENU_PRINT_CHANGED`; the editor shows it and refetches |
| Closing the editor with a failed save | "Close anyway" or "Stay"; closing keeps the edits in the page's hook and the card shows Save failed |

## 13. Configuration, docs and lists

New env vars (CLAUDE.md and README environment tables, `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Enables the feature; unset means off. On the dev box the smoke and the walks pass the key from `~/.secrets/openai_api_key` into the lane server's process environment only; it never goes into the root `.env` (amended 2026-10-16) |
| `MENU_ART_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | Image model |
| `MENU_ART_TEXT_MODEL` | `gpt-5.4-mini` | Structured-output words model |
| `MENU_ART_BACKGROUND_SIZE` | `2560x3200` | Background size; `1664x2080` is the non-experimental fallback |
| `MENU_ART_DAILY_IMAGE_CAP` | `60` | Rolling 24-hour image reservations across all events and both providers |
| `MENU_ART_DAILY_TEXT_CAP` | `100` | Rolling 24-hour words calls (Generate and Update draft) |
| `MENU_ART_IMAGE_TIMEOUT_MS` | `180000` | Per image call |
| `MENU_ART_STALE_MS` | `300000` | Heartbeat age at which a pending or working step reads as interrupted |
| `GEMINI_API_KEY` | none | Enables the Gemini option of the image-model toggle; unset leaves it disabled and OpenAI working. In Render it must come from a billing-enabled AI Studio project (paid tier, so prompts and images are not used for training) with a hard ceiling: prepay without auto-refill, or a project spend cap. On the dev box the live smoke and the walks pass the reviewer's paid key from `~/.gemini/.env` (Dallas chose it for the smoke, 2026-10-16) into the lane server's process environment only; it never goes into the root `.env`. The dev database's own 60-image cap bounds it. BLAST RADIUS: the key can draw images billed to that project. Leak response: delete the key in AI Studio and unset it in Render; OpenAI keeps working |
| `MENU_ART_GEMINI_IMAGE_MODEL` | `gemini-3-pro-image` | Gemini image model for backgrounds and drinks. Only `gemini-3-pro-image` is supported (it takes style references); other ids are untested (section 2) |

Same-change docs:
- **README:** folder tree, Key Features, env table, tech stack.
- **ARCHITECTURE:** route table; the three tables; third-party integrations (OpenAI, Google Gemini); and mentions of the new utils `openaiClient.js`, `geminiClient.js`, `menuImageProvider.js`, `menuKeyOut.js`, `envInt.js`, `menuDrinkSource.js`, `menuAlsoAtBar.js`, `menuFontPairings.js`, `menuDraftValidation.js`, `menuArtCap.js`, `menuArtPrompts.js`, `menuBackgroundTone.js`, `menuArtJob.js`, `menuDraftRead.js`, `r2Proxy.js`, the new exports of the existing `menuPrintFile.js` (and its "written only by /api/proposals/:id/menu-print" line, no longer true once Approve writes the key), plus the `storage.readFile` addition.
- **CLAUDE.md:** env table and Tech Stack (OpenAI; Google Gemini through `@google/genai`, reached only through `geminiClient.js`).
- **`PrivacyPage.js`** (and `PrivacyPage.test.js`): one line, `<li>OpenAI and Google (Gemini), to generate artwork for custom bar menus from the drink plan's menu notes and any image uploaded to it</li>`, beside the existing Google line (decision 10). It does not claim what is never sent, because the brief is client free text.
- **README and ARCHITECTURE** drop or rewrite their entries for `AdminMenuPrintBlock` and Event Detail's "Bar menu print card" (README around line 688, ARCHITECTURE around line 386), and the `menuPrintFile.js` rows gain its new exports.
- **Root `package.json`:** gains `openai` and `@google/genai` (pinned exactly, the `@anthropic-ai/sdk` precedent).

`scripts/sensitive-paths.txt` gains `server/utils/menuPrintFile.js` (existing, not yet listed), `server/routes/proposals/menuPrint.js`, `server/routes/proposals/menuDrafts.js`, `server/routes/proposals/menuDraftApprove.js`, `server/utils/menuArtCap.js`, `server/utils/openaiClient.js`, `server/utils/geminiClient.js` and `server/utils/menuImageProvider.js`. These are two paid, capped external APIs and the duty-pay trigger; this is the same treatment as the consult call caps. Amended 2026-10-16 in the engine lane, the list also gains `server/utils/menuArtJob.js`, `server/utils/menuArtJobSteps.js` and `server/utils/menuArtJobWords.js` (the job and its siblings, which run `authorizeCall`, the actual spend gate, before every paid call) and the route siblings `server/routes/proposals/menuDraftSync.js`, `menuDraftImages.js` and `menuDraftShared.js` (the routes file was split by concern: Update draft, the image GETs, and the shared reserving transaction and key checks).

**Spend.** An estimate from OpenAI's published token pricing, to be confirmed by the smoke run's usage page: the background is about $0.14 to $0.25 at high quality, and each 1024 drink about $0.05. So a full eight-drink menu is roughly $0.55 to $0.65, and the cap of 60 images a day bounds a worst day at about $15 (all 60 at the background's top price). Dallas sets a monthly budget on the OpenAI project as the provider-side backstop. Dev and prod share one key, so they share OpenAI's per-minute limit, and each database keeps its own cap.

On Gemini (published prices, 2026-10-15): the background is $0.24 at 4K and each drink $0.134 at 1K, so a full eight-drink menu is about $1.31, roughly double OpenAI. The same 60-image cap bounds a worst day at about $14.40. The box's Gemini key belongs to the AI Studio project the second-opinion reviewer uses (prepay, auto-refill), and Gemini's limits are per project, so the dev smoke can use it; Dallas chose it for the smoke (2026-10-16). On the dev box both keys (this one, and the OpenAI key from `~/.secrets/openai_api_key`) ride only the lane server's process environment, never the root `.env`. The 2026-10-16 smoke could not read either usage page from the box, so the actual cost is Dallas's glance at the OpenAI and AI Studio usage pages. For Render, a key from a separate AI Studio project keeps menu art and code review from sharing a spend limit; Dallas picks which key goes in.

## 14. Testing

- **No provider is ever called from tests.** `openaiClient.js` and `geminiClient.js` both refuse under `NODE_ENV=test` without an injected stub. `node --test` does not set `NODE_ENV`, so every new server suite sets `process.env.NODE_ENV = 'test'` on its first line (the `anthropicClient.test.js` precedent); run anywhere a real key is in the environment, a suite without it would spend money. (The box keys never go into the shared root `.env`, section 13, but the guard does not depend on that.) Route suites stub both wrappers, because `setImmediate` runs the real job during the test, and wait for the job before closing the pool.
- **Pure helpers:**
  - `menuDrinkSource.js`: planner and consult sides, consult custom objects and mocktail gating, matcher hits through aliases, a picked-and-typed drink appearing once, slug collisions, inactive drinks keeping their description, missing ids becoming client-typed, brief-hash normalization;
  - `menuAlsoAtBar.js`, including "None", "Other" and the consult beer boolean;
  - the staleness diff;
  - the stuck rule;
  - `layouts.js` row splits and slot widths for 1 to 8 illustrated drinks, the More from the bar list, and the art-height start values (section 11);
  - validation for every row of section 7.1;
  - `matchCustomNames`'s additive `row`, with existing shopping-list suites unchanged;
  - `menuKeyOut.js` on fixture images: a drink on flat magenta comes out with transparent corners, opaque center, partial alpha on the edge band and no magenta cast left in edge pixels; the same after a JPEG round trip; a pink drink body (not connected to the border) stays opaque; a green garnish next to the key keeps its color; an image with too little key color is refused; and, once the live smoke has captured one, a real Gemini drink JPEG as a regression fixture;
  - the background tone on a fixture whose border color differs from its center (the `stats()` crop trap);
  - the env-number parse (zero, blank, nonsense fall back);
  - `menuImageProvider.js`: each provider and kind gets its own settings (Gemini at 4:5 4K then downscaled to 2560x3200 for a background, 1:1 1K then keyed out for a drink; OpenAI transparent PNG), and a Gemini refusal or text-only answer becomes one readable refusal;
  - the brief diff naming which field changed.
- **Routes** (`server/routes/proposals/menuDrafts.test.js`, shared dev DB, one suite at a time from the repo root):
  - auth (unauthenticated and staff refused; manager allowed);
  - Generate creates the draft and pieces, refuses with no drinks, no plan, and at cap, and the reservation holds under two concurrent Generates;
  - a second Generate supersedes the first, which writes nothing and makes no further call;
  - the words failure sweep fails every piece and releases its never-sent reservations, so the cap count is unchanged; a piece whose provider call succeeded and whose later step (key-out, upload) failed keeps its billed reservation as `failed`, still counted;
  - the call gate: a superseded run's `reserved` row is never moved to `sent`, so no provider call is made, on either provider;
  - a stored `reference_key` outside `menu-art/<id>/ref-` is never read or sent; PATCH refuses `reference_key` and `image_model`;
  - re-roll is refused for a pending piece in an active run;
  - `image_model` is required, stamped on each piece and ledger row, `gemini` without its key is refused with 503, and a re-roll under the other model changes only that piece's `provider`;
  - PATCH: version conflict; key-set change refused; more than 8 `has_art`, more than 12 visible, or more than 4 visible without art refused; `palette` refused; it never touches pieces, `art_version` or the words status;
  - Update draft: version conflict; adds added drinks with the art default; removes dropped drinks and their pieces; resets the fingerprint; Dismiss persists until the plan changes again and leaves `version` unchanged, so an approved draft stays approved;
  - re-roll: refused while working, allowed when stuck;
  - the pieceKey pattern and every key-prefix guard;
  - Approve rejects non-JPEG, wrong dimensions, a stale `version`, a stale `art_version`, a not-done piece, and an `expected_print_key` that no longer matches (409 `MENU_PRINT_CHANGED`); it stamps `approved_planner_image_key`, and a replaced planner logo then reads as edited since approval. On success it sets `menu_print_key` inside the transaction, clears `menu_not_required`, stamps the posted versions, writes the activity row, and fires duty reaccrual only after commit;
  - a re-roll after approval reads as edited since approval;
  - removal and "no menu needed" read correctly.
- **Existing suites the change reaches stay green:** `server/routes/proposals/menuPrint.test.js`, `server/routes/eventDetails.test.js`, `server/routes/beo.test.js`, `server/utils/dutyLines.test.js`, the shopping-list suites that cover `matchCustomNames` / `loadRecipeCandidates`; on the client `client/src/utils/downloadMenuPrint.test.js`, `EventDetailPage.fork.test.js`, `MorePage.test.js`, `AdminLayout.badges.test.js`, `adminos/nav.test.js` and `PrivacyPage.test.js`. New: `menuPrintFile.test.js` (the new exports, with `sendMenuPrintFile` unchanged) and `UserPrefsContext.test.js` (the override drives `html[data-sidebar]` while localStorage and the saved pref stay untouched).
- **Client test setup.** jsdom has no 2D canvas, no `document.fonts`, and never fires `<img>` load events. Tests mock `tintedWordmark.js` and `softBacking.js`, stub `document.fonts`, and fire image loads by hand; `html2canvas` is mocked.
- **Client:** `layouts.js` (row splits, slot widths, art-height start, More from the bar cap), the color resolver (pairing set by tone, overrides, `mark_color`) and `menuCardState.js` (every row of tables C and B from a GET payload) as pure tests; `exportMenu.js` waits on the font link and every layer including both mark images, tints the wordmark, and fails naming a missing layer; `MenuDesignerCard` and `MenuCardFold` keep the old cards' behaviors (Download and its three ported tests, the 10 MB check, busy labels and error lines, Remove, No menu needed and its Undo, the logo's Replace, Remove, Download original in a new tab and the `isSafeLogoUrl` rule) and keep the fold working when the draft GET fails; `menuCardState` follows table C's precedence; closing the editor flushes, and a failed flush asks before closing; the sidebar override never calls `setPref`, hides the footer toggle, and clears on close and unmount.
- **Server tone:** the background tone and `ground_rgb` from `sharp` on a known dark and a known light fixture image.
- **Visual:** `ui-ux-review` against `Menu Designer v2.dc.html` (both skins, the card and the editor in every state it switches to, table D's overrides applied) and, for the printed menu, the 2026-10-01 boards' cases (1 drink with logo above and badge; 3 drinks; the 5-drink garden sample; 4 drinks with nothing else; 6 drinks with the long name and the logo replacing the title; the 12-drink maximum) with the new mark in all three colors.
- **Live smoke on dev:** one full generation on each provider: OpenAI (the default), then Gemini with the box key, re-rolling one drink under the other model to see them side by side. Check the Gemini drinks' key-out on a dark theme (no pink fringe) and on the garden sample. Then approve onto a dev proposal, download it as staff, and read the actual cost on both usage pages.
- **Rollout check:** Dallas generates for one or two real upcoming custom events and compares them with hand-made quality before approving one for print.

## 15. Review level

**Server lanes: full review fleet.** They change `schema.sql`, `rateLimiters.js` and the paths added to the sensitive list, and they reorder the duty-pay trigger. That includes `/second-opinion` at push, per the cross-LLM rule.

**Server lanes and Gemini:** `geminiClient.js`, `menuImageProvider.js` and `menuKeyOut.js` ride the full fleet with the other server files.

**Card and editor lanes:** one reviewer each, the client suites, and `ui-ux-review` against `Menu Designer v2.dc.html` (section 11); the card lane adds a consistency check of the folded card against the two cards it deletes.

**Phone lane:** the full fleet, because `client/src/pages/mobile/EventDetailPhone.js` is on the sensitive list (it decides which sheet a link opens), plus the client suites and `ui-ux-review` against `Menu Phone.dc.html` on the phone recipe.

## 16. Rollout

1. Server lanes merge first; the feature stays dark until the key is set.
2. Live smoke on dev with the box keys (OpenAI and Gemini).
3. The card lane, then the editor lane (the visual contract was satisfied 2026-10-16).
4. Dallas adds `OPENAI_API_KEY` in Render and sets the OpenAI project budget. Optionally he adds `GEMINI_API_KEY`, only from a billing-enabled AI Studio project with a hard ceiling (section 13), preferably a separate project from the reviewer's. Then he pushes.
5. First real use on an upcoming custom event.
6. The phone follow-up lane, `menu-designer-phone`, once the desktop lanes are on main (decision 13).
