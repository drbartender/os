# Menu designer v2: design

**Date:** 2026-10-19, revised 2026-11-03 (rev 2).
**Status:** rev 1 (2026-10-19) specified five additions Dallas asked for after first use of the designer that shipped 2026-10-17 (fix list, Potions section, "Menu designer v2, Dallas's notes from first use (2026-10-19)", items 1 to 4 and 7). Rev 2 (2026-11-03) adds his second round: the menu generates itself when the client submits the drink plan, a finished menu lands in the Inbox, approving it sends it to the client, staff can print only after the client says it looks great (or Dallas releases it), and a client with no instructions gets the house card with small event touches (fix-list item 5, pulled into this round). It also folds in two breakages he reported ("menu generator has not been working lately and has not been tagging clients that do not need a printed menu") and the fix-list line on bar picks. Section 3 lists every decision; a decision is Dallas's only where his words are quoted beside it, and every other one is marked as Claude's call. This spec extends the v1 contract, `docs/superpowers/specs/2026-10-01-menu-art-generator-design.md` (cited below as "v1"), and amends it only where it says so. Where v1 and this document differ on a point this document names, this document wins.
**Review:** rev 1's spec-grounding pass (2026-10-19) came back grounded with five warnings, all folded in below; its gaps and risk passes were cut off by a usage limit and run on rev 2.
**Visual design:** two sketches Dallas reviewed on 2026-11-03 are the benchmarks for the new surfaces (section 22). The admin controls follow v1's design artifact.

## 1. Goal and scope

1. **Mark placement:** left, center or right for the Dr. Bartender mark (section 5).
2. **More font choices:** twelve hand-picked pairings, the words step's pick tagged "Suggested" (section 6).
3. **Planner data on the Brief tab**, read-only (section 7.1).
4. **An admin brief**, typed by Dallas, read by the words step ahead of the client's; it is also where instructions a client gave by email or text go (section 7.2).
5. **Auto-generate:** the menu drafts itself when the client submits the drink plan (section 8).
6. **The house card template:** a client who chose the Standard Menu, or gave no instructions, gets the apothecary house card with small event touches drawn into the background (section 9).
7. **Approve and send:** approving a menu emails the client a frozen proof; staff can print it only after the client says "Looks great" or Dallas releases it (sections 10 to 12).
8. **The Inbox:** four menu tasks under the client: ready to review, couldn't be generated, the client asked for changes, and no answer yet (section 13).
9. **The no-menu mark:** a client who picks Skip the Menu marks the event as needing no printed menu (section 15).
10. **Out of credit:** a provider refusing for an empty balance says so, and stops (section 16).
11. **Bar picks in the plan-changed check** (section 17).

**Out of scope, a later round**
- Moving or resizing elements, including the cheaper nudge controls (fix-list item 6): it reworks the fit rule and export parity (v1 11.2, 11.3).
- The phone lane (v1 decision 13). `client/src/pages/mobile/menu/` does not exist yet; the card states this spec adds live in `menuCardState.js`, which that lane reuses.
- SMS delivery of the proof: email only, Dallas's standing preference (email over SMS, which costs money). A client who answers by replying to the email is handled as any email reply today; nothing here parses mail.
- A client-side edit of the menu, or any client reply other than the two buttons and one text box.
- Deleting superseded proofs or held print files from R2 (`storage.js` has no delete; v1 section 1).
- Retiring the standalone Standard Menu PNG export on the event page (`client/src/components/MenuPNG/MenuPNG.jsx`, shown when `menuStyle === 'house'`, `EventDetailPage.js:598-602`). It stays as it is; the house card template in the designer is the path forward, and the export can go in a later cleanup.
- Auto-generating for plans submitted before this ships (Claude's call): those events keep today's manual Generate.

## 2. Verified context

Rev 1's citations were checked by the 2026-10-19 grounding pass; the five it corrected are fixed here. Rev 2's new citations come from reads on 2026-11-03.

- **The mark.** `MenuCanvas.js:97-109` renders `Mark({ color, inPanel })` as `.mc-mark`, or `.mc-mark.mc-mark-panel` with the Panel backing; it is placed at `MenuCanvas.js:272` after the page box. `index.css:22874` fixes it `position: absolute; right: 40px; bottom: 40px`, and `index.css:22883` moves it to `right: 68px; bottom: 64px` inside the Panel. The avatar is 40 px tall at its natural ratio (`index.css:22875`; the PNG is 283 x 273, so about 41.5 px wide), the wordmark is 159 x 18 (`index.css:22876`), the row gap is 8, so the mark is about 208 px wide. The page box pads 58 / 66 / 86 (`index.css:22824-22826`, `layouts.js:18-22` `PAGE_PAD_BOTTOM = 86`) and 110 at the bottom under the Panel (`index.css:22882`). The mark sits entirely inside that bottom padding, below the "Also at the bar" footer (`.mc-also`, `index.css:22865`). The fit loop (`MenuCanvas.js:177`, v1 11.2) already leaves the mark its room at every horizontal position.
- **The mark's controls.** `DesignTab.js:124-136`: a `role="switch"` row "Dr. Bartender mark" over "Small, bottom right" (`:127`) that PATCHes `inputs.drb_mark`, and, when on, the "Wordmark color" `.seg` PATCHing `content.mark_color` (`:133`). `menuColors.js:29-38` resolves the color; `menuDraftValidation.js:251` validates `mark_color`.
- **Pairings.** Six ids in `server/utils/menuFontPairings.js:8-15` (`FONT_PAIRING_IDS`, `isFontPairingId` `:17-19`) and `fontPairings.js:27-29`; faces, sizes, tracking and light / dark defaults in `fontPairings.js:37-88` (v1 table P). `pairingFaces`, `fontsHref`, `ensureFontsLink`, `useFontsRevision` (`:95-178`). The Design tab loads every pairing on open (`DesignTab.js:56`) and draws six stacked buttons (`:76-95`); choosing one resets ink and accent (`:85`). The words schema offers exactly `FONT_PAIRING_IDS` (`menuArtPrompts.js:150`); PATCH refuses any other id (`menuDraftValidation.js:245`). The export waits on the pairing's link, each face and `document.fonts.ready` (`exportMenu.js:11-18, 59, 118-121`). None of the six uses Pirata One; `spooky` shares the IM Fell faces (`fontPairings.js:72-79`), and Pirata One is already loaded app-wide (`index.css:21-22`).
- **The brief.** `normalizePlan` returns `brief: { theme, naming, notes }` from `selections.menuTheme`, `drinkNaming`, `menuDesignNotes` (`menuDrinkSource.js:303-307`), whichever side feeds the drinks (`:229`, v1 decision 8). The fingerprint hashes `drink_keys`, the brief and `planner_image_key`, never the bar (`:319-344`); the GET's diff compares them (`menuDraftRead.js:106-128`). The words step cuts each brief field to `BRIEF_MAX = 1000` (`menuArtPrompts.js:32, 159-165`) and takes `event_type`, the brief and per drink `key, menu_section, kind, name, catalog_description, ingredients, needs_description` (`:160-168`); its strict schema returns `title`, `drinks[{ key, display_name, name_ai_suggested, description, visual_note }]`, `font_pairing`, `palette`, `accent_color`, `background_label` (`:111-139`); the prompt keeps a drink's given name unless the naming notes rename it (`:146`), by prompt only (`parseWords` accepts any `display_name`, `:181`). The background prompt sends theme, notes, art direction, the palette and `hasReference`, with fixed clauses last (edges and corners, calm centre, no drinks, no text; `menuArtImagePrompts.js:17-19, 39-54`). `loadDraft` already selects `p.event_type, p.event_type_custom` (`menuArtJobSteps.js:114`), but only the words step receives `getEventTypeLabel(draft)` (`menuArtJob.js:187`); the background calls (`:200-203`, re-roll `:262-265`) do not.
- **The Brief tab** shows the three client fields read-only (`BriefTab.js:32, 103-111`, "None" when empty at `:38`), the client image and its role, the style reference, and Art direction (`:164-168`, `inputs.art_direction`, 500 characters). Inputs may be PATCHed before the words land; content may not (`menuDraftValidation.js:309, 313-323`). Before any draft exists the hook keeps the brief inputs in `DEFAULT_BRIEF` (`useMenuDraft.js:30`) and posts them with Generate (`:236-250`); the image model opens at `openai` on every load (`useMenuDraft.js:68`, v1 decision 11).
- **What the planner stores that the tab does not show.** `selections.signatureDrinks`, `customCocktails`, `mocktails`, the bar picks (`beerFromFullBar`, `wineFromFullBar`, `beerFromBeerWine`, `wineFromBeerWine`, `spirits`, `spiritsOther`), `menuStyle`, `additionalNotes`, `mocktailNotes` (`PlannerV2.js:25-50`; `PotionPlanningLab.js:36, 56`; the submit allow-list `submitSanitize.js:13-22`, which allows `menuStyle` without checking its value, `:21`). The planner migrates the legacy `customMenuDesign: false` to `menuStyle: 'none'` on load (`PotionPlanningLab.js:212-215`). The catalog maps are loaded in the read model (`menuDraftRead.js:219-224`, `normalizePlan` at `:230`); the GET carries `plan: { id, menu_style, drink_count, drinks, bar_summary }` (`menuDraftRead.js:137-148`). The bar labels are `LINE_LABELS`, server-only (`menuAlsoAtBar.js:197`). `normalizePlan` returns `bar: { beer, wine, spirits, na }`, deduped string lists capped at 50 of 200 characters (`menuDrinkSource.js:29-32, 299-302`), from `plannerBar` (`:169-186`) or `consultBar` (`:188-206`). The designer reads the lowest-id plan for a proposal (`menuDrinkSource.js:96-109`).
- **Generate.** `POST /:id/menu-draft/generate` (`menuDrafts.js:101`; `auth, requireAdminOrManager, adminWriteLimiter`): `requireOpenAI` (503 `MENU_ART_NOT_CONFIGURED`, `menuDraftShared.js:103`), `parseId`, `requireProposal`, the reference file, `validateGenerateInputs` (`menuDraftValidation.js:97`; `image_model` required, no default, `:101-102`; defaults `planner_image_role 'logo'`, `reference_source 'none'`, `art_direction ''`, `drb_mark true`), `requireImageModel`, `job.freshPlan` (422 `MENU_NO_DRINKS`, `:110-111`); then `inLockedTx` (`menuDraftShared.js:117-131`) releases reserved calls, upserts the draft (`:62-70`), deletes the pieces, pends the background plus the first 8 drinks (`menuDrafts.js:126`), and reserves the text and image calls. The caps throw inside that transaction (429 `MENU_ART_TEXT_CAP_REACHED`, `menuArtCap.js:145-150`; 429 `MENU_ART_CAP_REACHED`, `:107-110`), so a capped Generate writes no draft. After the 202, `queue('generate', () => job.runGeneration(...))` (`menuDrafts.js:155`; `queue` is a `setImmediate` wrapper, `menuDraftShared.js:153`). Nothing in the route reads `req.user`, and `menu_art_calls` has no user column (`schema.sql:5027-5041`). The words step ends `words_status` `done` or `failed` with `words_error` (`menuArtJobWords.js:56-67`); pieces go `working`, `done` (with `art_version + 1`) or `failed` (`menuArtJobSteps.js:63-95`); the finally sweep fails any piece left open (`menuArtJob.js:221-237`); a stalled run reads as interrupted after `MENU_ART_STALE_MS` (`menuDraftRead.js:28-33`). **No hook fires when a run finishes.**
- **Pieces and the text-only limit.** Drinks with `has_art` take art slots (8 at most); drinks without go to a text "More from the bar" list of at most 4 (`partitionDrinks`, `layouts.js:138-147`; `MAX_MORE` `:51-53`); PATCH refuses a fifth ("At most 4 visible drinks can go without art.", `menuDraftValidation.js:29, 202`). `has_art` is set to the reserved keys (`menuArtJobWords.js:89`; `menuArtPrompts.js:197`); Approve requires every piece of `layoutPieceKeys`, the background plus each visible `has_art` drink (`menuDraftApprove.js:131-139, 167-172`); `menuCardState.js:71-72` and `MenuCanvas.js:209-216, 241-248` follow the same rule.
- **The Standard Menu card today.** `client/src/pages/plan/components/MenuPreview.js` (`PRINT`, `:15-26`): 768 x 960, ground `#12161C`, cream `#F0E8D6`, brass `#B8924A`, bright brass `#D6AE65`; faces IM Fell English SC, IM Fell English, Pirata One; 48 px margins; the fixed title "The Bar Menu" (`:122`) in Pirata One 72 px between brass hairlines with a diamond (`:174-220`); sections 30 px apart (`:223-239`), each labelled in IM Fell SC 17 px, .22em, bright brass, diamonds either side and a rule under (`:272-299`); drink **names only**, IM Fell SC 35 px, centred (`:301-316`); Beer & Wine as one 21 px line joined by " · " unless it is the only section (`:244-261`); a 107 px footer band under a brass rule with the Dr. Bartender lockup on the left (64 px logo and "DR. BARTENDER" 19 px, .32em, `:347-375`) and the client's logo on the right behind a brass divider, at most 160 x 72 (`:127-167`). Sections come from `extractMenuSections` (`client/src/pages/plan/data/menuSections.js:40-74`): Cocktails, Mocktails, then Beer & Wine collapsed to Beer, Seltzer, Red, White, Sparkling (`:18-38, 64`); a full bar with no signatures prints "Bar Service: Call Drinks" (`:69`); spirits are never listed. `MenuPNG.jsx` exports it with html2canvas at scale 3 (`:33, 106`). The planner promises it as "Our apothecary house card with your selections." (`MenuDesignV2.js:33`).
- **Approve today.** `menuDraftApprove.js:221-241`: parse `version`, `art_version`, `expected_print_key`, the logo rev; a JPEG of exactly 2400 x 3000 (`:103-129`); upload to `menu-print/<id>/<uuid>.jpg`; then `approveInTx` (`:155-204`): the draft `FOR UPDATE` and 409 on a moved version, `requireWords`, every layout piece done, the logo rev, the proposal `FOR UPDATE` and 409 `MENU_PRINT_CHANGED` on an unexpected key, **`setMenuPrintKey(client, id, key)` at `:189`**, `STAMP_SQL` (`:141-150`: `approved_version`, `approved_art_version`, `approved_print_key`, `approved_planner_image_key`, `approved_at`, `approved_by`), the `menu_approved` activity row, COMMIT; then **`reaccrueDuty(id)` at `:239`**. `setMenuPrintKey` (`menuPrintFile.js:85-92`) is `UPDATE proposals SET menu_print_key = $1, menu_not_required = false`; `reaccrueDuty` (`:98-108`) runs `payrollAccrual.maybeReaccrueForDuty` on `setImmediate`, and the $5 `menu_print` duty line keys on `menu_print_key` (`dutyLines.js:151, 192, 203`). "Edited since approval" is the print key equal to `approved_print_key` with a version, art version or logo key moved (`menuPrintState.js:37-40`).
- **Who reads `menu_print_key`** (what "held from staff" must cover): the staff download `GET /api/shifts/:shiftId/menu-print` (`eventDetails.js:153-178`), the ready / not-required / pending status in `eventDetailsPayload.js:72, 343-347` (event details and the BEO, `beo.js:33-38`; staff UI `BeoSections.js:299-348`, `ShiftDetail.js:695`), `menu_done` in `shifts.queries.js:202` (the Menu Design tag, `eventPlan.js:72`), duty lines, and the admin reads (`menuPrint.js:52, 62, 76`; `menuDraftRead.js:192, 233`; `getOne.js:26` for `MenuDesignerCard.js:195` and `MenuCardFold.js:72-99`). Writers: `menuPrint.js` POST (`:79-96`) and DELETE (`:126`), and Approve.
- **`menu_not_required`** (`schema.sql:4952-4956`, no record of who set it): written by the admin PATCH (`menuPrint.js:110-113`, guarded to true only with no key; called from `MenuCardFold.js:130`, `MenuDesignerCard.js:108`, `MenuEditor.js:179`) and cleared by `setMenuPrintKey`; read by `eventDetailsPayload.js:72, 345`, `shifts.queries.js:202`, duty lines, `menuDraftRead.js:192, 258`, `menuPrintState.js:30`. Nothing sets it from the plan: the card only says "The client asked for no menu." (`menuCardState.js:168-169`).
- **Drink plan submit.** `handleSubmit` (`server/routes/drinkPlans/submit.js:66`), public `PUT /t/:token` (`drinkPlans.js:115-118`): 409 when already submitted (`:94-97`), then one of three paths: financial (one transaction, `:157-625`), extras-invoice (`:653-699`) or plain (one autocommit UPDATE with no status guard in its WHERE, `:712-721`, so two racing submits can both land). After commit: the notifications, then `triggerShoppingListAutoGen` (`:638`, `:740`; the fire-and-forget precedent, `shoppingListGen.js:562-571`) and the lab follow-up (`:630-640, 732-742`). An admin can reopen a plan to draft (`drinkPlans.js:532-545`), after which the client can submit again (`submit.js:597-599`).
- **Legal hold.** `isLegalHold(id)` (`server/utils/legalHold.js:49-53`): synchronous, fails closed; callers throw 409 (`patchGuards.js:43-46` `assertNotLegalHold`; `proposalExtrasFold.js:169`) or skip.
- **Business time.** `server/utils/businessTime.js`: `eventLocalToUtc(ymd, hour, minute, tz)`, `chicagoTodayYmd()`, `chicagoYmdOf(value)` (`:29-98`); `proposals.event_date` is a nullable `DATE` (`schema.sql:866`).
- **Provider errors.** OpenAI `mapError` (`openaiClient.js:185-195`): a 429 whose code is not `insufficient_quota` becomes `OpenAIRateLimited`; `insufficient_quota` becomes `ExternalServiceError`; the code `credit_balance_exhausted` appears nowhere, so it is treated as a rate limit. The descriptor keeps the code (`:126-129, 141`; `menuArtJobErrors.js:70-81`) but only the ledger and Sentry see it. Sentry issue DRBARTENDER-SERVER-2T, "openai RateLimitError 429 ... credit_balance_exhausted", fired on 2026-10-30 and 2026-10-31 (four events). Gemini `mapError` (`geminiClient.js:194-202`) makes every 429 or `RESOURCE_EXHAUSTED` a `GeminiRateLimited`; the rpc status is read at `:198` but not stored. `menuImageProvider.js:107-108` wraps both as `MenuArtRateLimited`; `withRetries` retries twice (`menuArtJobErrors.js:147-168`). What the admin sees today for an empty OpenAI balance: "OpenAI is busy right now. Try again in a minute." (`menuArtJobErrors.js:31`).
- **Approve-path facts rev 1 relied on** (unchanged): the proof pattern (`exportMenu.js:118-136, 140-148, 180-265`; `MenuEditor.js:70, 187-191, 292`); the shared helpers `menuDraftShared.js` (`parseId :52-59`, `parseVersion :63-68`, `requireProposal :78-82`, `requireWords :92-99`, `inLockedTx :117-131`).
- **Public token routes.** `requireUuidToken` (`tokens.js:22-27`); limiters `publicLimiter` (`rateLimiters.js:3-9`), `publicReadLimiter` (`:11-17`), `publicTokenIpLimiter` (`:98-113`), the token-keyed `proposalCheckoutLimiter` shape (`:78-85`); `publicFeedback.js` (a local `ip:token` limiter `:18-25`, a 2,000-character cap `:52`, one submission per token `:121`); the voicemail link's SQL expiry (`voicemailListen.js:48`); archived proposals excluded with `status <> 'archived'` (`publicToken.js:221`); `urls.js` (`PUBLIC_SITE_URL :8`, `proposalUrl :23-25`). Token pages per site context in `App.js` (`:387-397, 461-471, 524-534, 553-565`), lazy (`:92-104`); `FeedbackPage.jsx` is the analog (`:18, 24-65, 99-102`); the bad-token shell `.public-error*` (`index.css:7953-8006`).
- **Email.** `sendEmail` (`email.js:52`) returns `{ id: 'skipped-invalid' }` for an RFC 2606 `.invalid` placeholder address (`:56-60`, the staff-payment import) and `{ id: 'dev-skipped' }` when notifications are off (`:64-67`); Reply-To defaults to `ADMIN_EMAIL` (`:70`); a Resend error throws (`:88-92`). Lifecycle templates return `{ subject, html: wrapEmail(...), text }` and sign "Cheers, Dallas" (`lifecycleEmailTemplates.js:36-54, 259-274`). The client's address is the live `clients.email` through `proposals.client_id` (`schema.sql:845-846, 865`).
- **The activity log.** `proposal_activity_log (proposal_id, action, actor_type, actor_id, details)` (`schema.sql:935-943`); client-actor precedents `'viewed'`, `'signed'` (`publicToken.js:399-401, 628-629`). The event page lists rows by `a.action` and reads `a.metadata.note || a.metadata.message` (`EventDetailPage.js:601-625`), a key these rows never carry, so it prints only the action and the time.
- **The Inbox is derived.** It stores only taps (`inbox_actions`), seen marks, AI reads and the reply send-id ledger (`inbox_sends`, `schema.sql:5445-5462, 5521-5527`). Readers in `server/utils/inbox/read*.js` emit `{ ref, personKey, channel, line, direction, at, author, kind, text, meta: { source, ... } }` (`readProposalSends.js:18-24`, the smallest; `direction` may be `'system'`, `readZola.js:51-60`); a reader is registered in `engine.js` at the import (`:29-35`), the query inside `Promise.all` (`:322-337`), the row-count sum (`:338-339`) and the map (`:340-347`), and in `readers.test.js:224-230`. A person waits while a counted inbound sits at or after the anchor, the latest of the last real reply, the last Done and the last `zola_closed` (`rules.js:187-210`); counted kinds include the task kinds `tt_missed` and `zola_unread` (`classify.js:29-32`), which the AI may not close (`:37-40`), but `rules.js:209` checks only the newest event, so a later inbound the AI covers closes the whole stretch (`:131-134, 154`). Any outbound event from an unknown source with a user-id author counts as a reply by default (`classify.js:72-75`). `tt_missed` is the precedent for an item that vanishes when its state resolves (`normalize.js:151-180, 163`); a vanished item leaves no "Recently handled" row (`rules.js:136-142`). Nothing filters `at <= now` (`normalize.js:223`; `rules.js:199`), and a newer event ends an older snooze (`rules.js:75`). Thread rows carry no link (`thread.js:29-35`); list rows show `need` (`payload.js:38-42`, `WaitingRows.js:45, 82`) from `eventNeedText` (`classify.js:109-117`); the reply box takes the newest inbound's channel from `CONVERSATION_CHANNELS` (`replyRules.js:66-69`), so a menu event must carry `channel: null`. The AI reads only `message` and `media` subjects (`subjects.js:37-41, 53, 89-92`). The snapshot cache lasts 30 s (`constants.js:57`); writers call `inboxCache.invalidate()` (`routes/sms.js:200`).
- **R2.** `sendR2Object(res, key, { prefix, ... })` 404s a key outside its prefix (`r2Proxy.js:58-65, 141-144`); `storage.js` exports `uploadFile` (`:22`) and `readFile` (`:66`).
- **Sensitive paths.** `scripts/sensitive-paths.txt` already lists `rateLimiters.js`, `*EmailTemplates.js`, `publicToken.js`, `voicemailListen.js` and the menu art routes.
- **Privacy page.** `PrivacyPage.js:27-29, 97-103, 120, 123, 125`.

## 3. Decisions

**From 2026-10-19 (rev 1), standing:**
1. **Mark placement** is a content field, `mark_position`, default `right`, so every existing draft renders as today (fix-list notes, item 1).
2. **Planner data** is reference only: read-only on the Brief tab, never sent to a provider (fix-list notes, item 3).
3. **The admin brief** is Dallas's own theme, naming and design notes, used whether or not the client filled the planner in, read first by the words step (fix-list notes, item 4; Dallas: "sometimes the planner inputs a theme through the drink planner, sometimes not. it would be nice to be able to manually add it incase they don't deliberately include it in the form").
4. **The client sees a frozen proof**, never the live draft (Dallas: "let's go with the frozen one"). Delivery is email through Resend, with the link copyable from the card.
5. **A change request becomes an Inbox item** (Dallas: "let's put it in inbox so we don't miss any feedback"), and also shows on the card and in the activity log.
6. **Dallas can release a menu for printing with no client answer** (Dallas: "i still want to be able to approve the menu for printing regardless if the client gives feedback or not because sometimes they don't respond to such inquiry").

**From 2026-11-03 (rev 2):**
7. **Fonts:** twelve curated pairings with the words step's pick tagged Suggested (Dallas: "twelve sets is fine, keep the suggested tag"). This settles rev 1's open recommendation.
8. **Auto-generate** (Dallas: "auto-generate an image of the menu as soon as the client has submitted their drink plan").
9. **Inbox notice when a menu is generated** (Dallas: "admin gets a notification as soon as a menu has been generated (preferrably through OS inbox to keep all notification in one place) so they can check whether they want any changes").
10. **Approving sends** (Dallas: "send to client once it has been approved by admin"). **Staff print only after the client approves** (asked "should staff be kept from printing it until the client says Looks great (or you override)?", Dallas: "yes - wait for client approval before we allow staff to print"). This replaces rev 1's order, where the proof went out before a separate print Approve.
11. **The no-answer reminder:** a week before the event in the Inbox (Dallas: "a week out in my inbox is fine"); for short notice, Claude proposed a day after sending with under a week to go and at once with two days or less (Dallas: "that sounds good").
12. **The house card template** (Dallas: "pattern menus with a template if client has no specific instructions on what they want (e.g. they just chose Dr. Bartender Standard menu - we fit the template and the event type)"), with small touches in the background (Dallas: "adding elements on the background to fit the event: ex. balloons and streamers for birthdays, or gift boxes for Christmas, just small additions, nothing too dramatic"). Placement, from the sketches: corner clusters (Dallas: "I like A, but maybe add more balloons in the corner and more confetti or streamers towards the center"), and the holiday gifts low (Dallas: "move gift boxes to the bottom corner s for the holiday"). He confirmed the birthday version ("okay on the birthday").
13. **Instructions given by email or text go in the admin brief** (Dallas: "ability to manually add details to the brief in case the client gave instructions through email or text, and not through the drink planner"); rev 1's section 7.2 already covers it.
14. **The client page and the email** as sketched (Dallas, after the sketch: "all good").

**Claude's calls (played back to Dallas on 2026-11-03; he answered "sounds good", "okay" and "go ahead and write it up", which approve writing, not each call):**
- A menu generates once, on the first submission; a later plan edit shows the existing plan-changed banner instead of a fresh, billed run.
- Auto-generate runs only when a menu is owed (`menuStyle` `custom` or `house`, the `menuOwedFor` rule, `nextStepsCopy.js:23`), and skips an archived or past event, the legal-hold proposal, and an event that already has a draft, a print file or the no-menu mark.
- An admin brief counts as instructions, so a client whose instructions Dallas typed gets a custom design, not the template.
- The touch list per event type (section 9.4), including the plain house card for a celebration of life, a custom or unknown event type, and a holiday party outside December.
- The house card is text only, like today's Standard Menu card: one background image, no per-drink pictures, no words call.
- When an event's touches use the bottom corners, the house card's footer lockup centres.
- The four Inbox items are tasks kept apart from the conversation: a reply to the client never clears them, approving never counts as a reply, and the AI never reads or closes them.
- The no-menu mark's provenance, so a client's later choice never undoes Dallas's own mark, and a one-time backfill for upcoming events.
- Out-of-credit errors stop without retries and say so.
- The bar picks join the plan-changed check.
- Re-approving after a release keeps the released file live for staff until the new proof is released.
- The email drops "custom" ("a first look at the bar menu for your Birthday Party"), since Standard Menu clients get one too.

## 4. The flow, end to end

1. **The client submits the drink plan.** Skip the Menu marks the event as needing no printed menu (section 15). A Custom or Standard Menu choice starts a draft on the server (section 8): the house card for a Standard Menu client or one with no instructions (section 9), a custom design otherwise.
2. **The Inbox shows "Menu ready to review"** under the client when the run finishes, or "Menu couldn't be generated" with the reason (section 13).
3. **Dallas opens the event,** edits what he wants in the designer (placement, fonts, the admin brief, Start over), and clicks **Approve and send**. The client gets the frozen proof by email; the print file is made at the same moment but held from staff (section 10).
4. **The client answers** on the proof page (section 12). Looks great releases the print file to staff. Request changes puts the note in the Inbox and on the card; Dallas edits and approves again, which sends a fresh proof and retires the old link.
5. **No answer:** the menu comes back to the Inbox on the schedule in section 13.3, and Dallas can **Release for printing** from the card or the editor at any time.
6. **Staff** see and download the print file only once it is released.

**What Dallas sees on the admin side:**
- **Design tab:** a Placement `.seg` (Left / Center / Right) beside the mark switch (section 5); twelve pairings with the words step's pick tagged Suggested (section 6). On a house card draft the font and color controls are replaced by a note (section 9.5).
- **Brief tab:** the Client brief box; an **Admin brief** box (section 7.2); a **Look** `.seg` (House card / Custom design, section 9.1); a read-only **From the planner** box (section 7.1); a **Client review** section (section 14).
- **Editor top bar:** **Approve and send** (was Approve), and **Release for printing** while a released file is owed (section 14).
- **Card:** a **Client review** fold row with Copy link and Release for printing, and the new states in table C (section 14).
- **Inbox:** the four menu tasks (section 13).

## 5. Mark placement

- **Field:** `content.mark_position`: `left` | `center` | `right`; missing reads as `right`. Written by PATCH like `mark_color`; never by the job; `parseWords` does not set it.
- **Layout** (`MenuCanvas.js:97-109, 272`; `index.css:22874, 22883`): `Mark` takes `position`. `right` keeps today's CSS (40 / 40; 68 / 64 under the Panel). `left` mirrors it (`left: 40px; right: auto`; 68 under the Panel). `center` sets an inline `left` in canvas px of `(800 - markWidth) / 2`, where `markWidth` is the avatar's rendered width (40 x 283 / 273) + 8 + 159, about 208, so about 296 px; never a CSS `transform` (v1 11.3: nothing html2canvas might draw differently). The vertical offsets are unchanged, so the mark stays inside the page box's bottom padding and the fit loop needs no new room.
- **Design tab** (`DesignTab.js:124-136`): the Placement `.seg` under the switch, above Wordmark color, PATCHing `{ content: { mark_position } }`; disabled with the rest of the tab until the words land. The switch's sub line reads "Small, bottom left / center / right" to match.
- **Export:** the hidden `ExportCanvas` renders the same `MenuCanvas`, so the proof and the print file carry the mark where the preview shows it.
- **Validation:** `mark_position` joins `CONTENT_CHECKS` beside `mark_color` (`menuDraftValidation.js:240-252`); the client mirrors it.
- **House card drafts** have no `.mc-mark`; their footer carries the lockup (section 9.3).

## 6. More font choices

**Decision 7: twelve curated pairings, the words step's pick tagged "Suggested".** Not a Custom mode with separate pickers: each id carries three faces tuned together, a light-art and a dark-art ink and accent pair, the font link and the export waits, the server's id validation and the words step's enum. Twelve ids cost six rows in table P and nothing new in the machinery.

| id | Name · theme | Title | Heading (names) | Body | Light ink / accent | Dark ink / accent |
|---|---|---|---|---|---|---|
| `art-deco` | Gatsby · Art deco | Limelight 400, 56, uppercase, 0.12em | Josefin Sans 600, 18, 0.08em | Josefin Sans 400, 15 | `#1b1b1f` / `#a8842e` | `#f3ead6` / `#e3c56a` |
| `botanical` | Conservatory · Botanical serif | Playfair Display 700, 62 | Lora 600, 22 | Lora 400, 16 | `#2f3b2a` / `#6d7f4c` | `#eef3e6` / `#b7cf8a` |
| `hand-lettered` | Chalkboard · Hand lettered | Caveat 700, 76 | Patrick Hand 400, 24 | Nunito 400, 15 | `#2b2b2b` / `#b8433a` | `#f6f1e8` / `#f4b183` |
| `fiesta` | Fiesta · Bold festive | Lilita One 400, 66 | Baloo 2 700, 22 | Baloo 2 500, 15.5 | `#2a1a3a` / `#e4572e` | `#fff4e6` / `#ffcf5c` |
| `editorial` | Masthead · Minimal serif | DM Serif Display 400, 62 | DM Sans 600, 18, uppercase, 0.06em | DM Sans 400, 15 | `#141414` / `#8a1c1c` | `#f5f5f0` / `#e8b4a0` |
| `black-tie` | Black Tie · Formal | Cinzel 700, 54, 0.1em | Cinzel 500, 18, 0.06em | Cormorant Garamond 500, 17 | `#15161d` / `#7d6a3c` | `#f1ede4` / `#d6c08a` |

Sizes, tracking and colors are starting values the lane tunes against the 2026-10-01 boards by table P's method.

- **Server:** `FONT_PAIRING_IDS` gains the six ids (`menuFontPairings.js:8-15`); the words schema enum grows with it (`menuArtPrompts.js:150`); the prompt line stays "the pairing that best suits the theme".
- **Suggested:** `parseWords` stores the model's pick as `content.font_pairing_suggested` (words-step output only; `CONTENT_SERVER_ONLY`, `menuDraftValidation.js:253-254`, so PATCH refuses it). The Design tab tags that button "Suggested" (a `.tag`, `DesignTab.js:76-95`); Dallas's choice stays `font_pairing`; choosing another pairing still resets ink and accent (`:85`). Old drafts have no suggested value; the tag is absent.
- **Loading:** the editor still loads every pairing on open (`DesignTab.js:56`), one css2 link for about 30 families; the card loads one pairing (v1 10.3).
- **Design tab layout:** twelve stacked buttons in the same list; the panel scrolls.

## 7. The Brief tab: planner data and the admin brief

### 7.1 Planner data, read-only

- **Payload.** The GET's `plan` block (`menuDraftRead.js:137-148`) gains `side` (`planner` | `consult`, from `normalized.side`) and `planner_reference`, built from `selections` regardless of the side the drinks come from: `normalizePlan({ ...planRow, shopping_list_source: 'planner' }, maps)` in the read model (`menuDraftRead.js:219-230`, where the catalog maps are already loaded) gives `drinks: [{ name, mock, typed }]` and the bar, which the read model emits as **labelled strings** using `LINE_LABELS` (`menuAlsoAtBar.js:197`), so the client needs no label mirror; plus `additional_notes` and `mocktail_notes` from `selections.additionalNotes` and `selections.mocktailNotes`, trimmed, each cut to 2,000 characters for display, null when empty. `planner_reference` is null with no plan.
- **Brief tab.** A **From the planner** section ("Potion Planner · read-only") under the Admin brief box: "Menu style: Custom / Standard (house) / Skip / not chosen" from `plan.menu_style`; "Drinks (<n>)" as a comma list, mocktails marked; "Bar" as the labelled strings; "Additional notes" and "Mocktail notes" when present. When `plan.side === 'consult'`: "This menu's drinks come from the consult form, which the shopping list uses. The planner picks below are what the client chose on their own." When the planner side has no drinks: "The client hasn't picked drinks yet."
- **Payload rule.** `planner_reference` is display only: never part of `normalized.brief`, the words request, the background prompt or a re-roll. Nothing in this section goes to OpenAI or Gemini (section 25 pins it).

### 7.2 The admin brief

- **Storage: `inputs.admin_brief`**, `{ theme, naming, notes }`, each a trimmed string of at most 1,000 characters, empty allowed; absent means none. Inputs, not content: every Generate resets content (v1 5.5), so a brief kept there would be wiped by the Generate it was written for; inputs are editable before the words land (`menuDraftValidation.js:313-323`), live in the hook's pre-draft brief (`useMenuDraft.js:30`) and are posted with Generate (`:236-250`). The job never writes it.
- **Writes.** PATCH `inputs.admin_brief` (one object; `INPUT_CHECKS`, `menuDraftValidation.js:256-262`), and Generate as three multipart fields `admin_brief_theme`, `admin_brief_naming`, `admin_brief_notes` (`validateGenerateInputs`, `:97-122`; absent means the stored value on Start over, else empty). Applied at the next Generate, Start over, Update draft and background re-roll. Like every inputs PATCH it bumps `version` (`menuDrafts.js:180`), so after an approval it reads "edited since approval", as an art direction edit does today.
- **The merge**, one pure function `effectiveBrief(clientBrief, adminBrief)` in `menuDrinkSource.js`: per field, the admin text when non-empty after trim, else the client's; each cut to 1,000. Applied at the four provider seams and nowhere else: the words step (`menuArtJob.js:185-188`), the background prompt (`:200-203`), a re-roll (`:253-263`) and Update draft's typed-drinks words call (`menuDraftSync.js:132`). `normalized.brief` stays the client's.
- **Staleness.** The fingerprint and the diff keep hashing the client's three fields; an admin brief edit never touches `plan_fingerprint`, so it never reads as "Edited by client".
- **Brief tab.** An **Admin brief** section ("Yours · read first") under the Client brief: three `.input` textareas, Theme & colors, Drink naming, Design notes, each `maxLength` 1,000, placeholders "e.g. navy and brass, art deco, a little playful", "e.g. name the cocktails after the couple's dogs", "e.g. keep the title small, no florals", saved through the hook's debounced PATCH. A hint under the box: "Used first. Where you leave a field blank, the client's text is used. Use it for anything the client told you by email, text or phone. Applies at the next Generate or Start over." Never gated on the words; read-only on a read-only draft.
- **Payload rule.** The admin brief goes to the providers exactly where the client's brief goes, and nowhere else.

## 8. Auto-generate on submit

### 8.1 The trigger

- **`triggerMenuAutoStart(planId)`** in a new `server/utils/menuAutoStart.js`, the `triggerShoppingListAutoGen` shape (`shoppingListGen.js:562-571`: fire-and-forget, console plus Sentry on failure). It is called beside `triggerShoppingListAutoGen` after every submit path commits (`submit.js:638, 740`); the lane confirms the extras-invoice path (`:653-699`) reaches one of those two calls and adds the call if it does not. It runs after the submit's transaction has committed and its client is released, on its own `pool` connections (CLAUDE.md, one pooled connection per request).
- **It does two things, in order:** the no-menu mark (section 15), then the auto-start below.

### 8.2 When a draft starts

All of these must hold; otherwise nothing is started and nothing is recorded:
1. The submitted plan has a `proposal_id`, and `menuOwedFor(selections)` holds (`menuStyle` is `custom` or `house`; server-side mirror of `nextStepsCopy.js:23`).
2. The proposal exists, its status is not `archived`, `isLegalHold(proposal_id)` is false (it fails closed), and `event_date` is null or on or after `chicagoTodayYmd()`.
3. The proposal has no `menu_drafts` row, no `menu_print_key`, and `menu_not_required` is false.
4. **The run-once guard:** `INSERT INTO menu_auto_starts (proposal_id, plan_id) VALUES ($1, $2) ON CONFLICT (proposal_id) DO NOTHING`; a rowCount of 0 stops. This is what makes "once, on the first submission" true: it absorbs the two racing plain submits (`submit.js:712-721`) and a plan an admin reopened and the client resubmitted.

### 8.3 Starting it

- **The Generate route's body is extracted** into `startGeneration({ proposalId, inputs, file })` in `server/routes/proposals/menuDraftGenerate.js` (or a util beside it), returning `{ draftId, runId }` and throwing the route's AppErrors. The route calls it with the request's values and keeps its 202 and `queue(...)`; the auto-start calls it with `inputs = { image_model: 'openai' }` plus `validateGenerateInputs`'s defaults (OpenAI is the default image model, v1 decision 11) and `look` from section 9.1, and no file. Nothing in the path reads `req.user`.
- **On success** it stores `draft_id` and `run_id` on the guard row, queues `job.runGeneration` exactly as the route does, and calls `inboxCache.invalidate()`.
- **On a thrown error** it stores `error_code` and `error_sentence` on the guard row: 503 `MENU_ART_NOT_CONFIGURED` ("Menu art is not set up."), 503 `MENU_ART_GEMINI_NOT_CONFIGURED`, 422 `MENU_NO_DRINKS` ("The drink plan has no drinks to put on the menu."), 429 `MENU_ART_CAP_REACHED` / `MENU_ART_TEXT_CAP_REACHED` ("Today's menu art limit is reached. Generate it from the event page tomorrow."), anything else ("The menu couldn't be started. Generate it from the event page.", plus Sentry). Each becomes the Inbox's "couldn't be generated" item (section 13).
- **A process that dies** between the guard insert and the draft leaves a row with no `draft_id` and no error; after 10 minutes the Inbox reader treats it as the last sentence above.

### 8.4 Data

**`menu_auto_starts`** (idempotent, in `schema.sql` after the menu art block):
- `proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE`
- `plan_id INTEGER REFERENCES drink_plans(id) ON DELETE SET NULL`
- `attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `draft_id INTEGER REFERENCES menu_drafts(id) ON DELETE SET NULL`, `run_id UUID`
- `error_code TEXT`, `error_sentence TEXT`

Writers: the auto-start only. The Inbox reader and the card read it. It is never deleted, so a proposal is auto-started at most once in its life.

### 8.5 Which plan the draft reads

The designer reads the lowest-id plan for the proposal (`menuDrinkSource.js:96-109`), as every Generate does today. On the rare proposal with two plans, the auto-started draft reads that plan, not necessarily the one just submitted; this matches a manual Generate and is accepted.

## 9. The house card template

### 9.1 Who gets it: `inputs.look`

- **`inputs.look`:** `house` | `custom`. When Generate (manual or auto) has no stored or posted value, it is decided: `house` when `selections.menuStyle === 'house'`, or when all of these are empty after trim: the client's three brief fields, the admin brief's three fields, `art_direction`, and the reference (no `reference` upload, no planner image with role `reference`). A client logo (role `logo`) is not an instruction. Otherwise `custom`.
- **The admin can switch it:** a **Look** `.seg` on the Brief tab (House card / Custom design) PATCHing `inputs.look`; it applies at the next Generate or Start over, like every input. A hint under it: "House card: our apothecary card with small touches for the event. Custom design: drawn from the brief."
- Existing drafts have no `look`; they read as `custom` and render exactly as today.

### 9.2 What the run does for a house card

- **No words call.** The job fills the content deterministically from the normalized plan and sets `words_status` `done` without a provider call and without reserving the text cap: `title` "The Bar Menu"; each drink's `display_name` is its own name (never renamed), `description` null, `has_art` false; `font_pairing` null; `background_label` from the touch set (9.4). The plan-changed banner and Update draft keep working on the same drink keys.
- **One image at most.** Generate reserves only `background`, and only when the event's touch set is not plain; a plain card reserves no image and the canvas paints the ground. `layoutPieceKeys` for a house draft is `['background']` or `[]` accordingly, on the server (`menuDraftApprove.js:131-139`, moved to `menuDraftShared.js`) and the client (`menuCardState.js:71-72`).
- **The text-only cap does not apply.** The four-drink limit on drinks without art (`menuDraftValidation.js:29, 202`; `layouts.js:51-53`) is for the custom layout; a house draft lists every visible drink in its sections.
- **The background prompt** (`menuArtImagePrompts.js:39-54`) gets a house branch: the ground `#12161C` across the whole image with a faint paper texture; the touch set's description and zones (9.4); muted touch colors that sit with brass (dusty rose, slate blue, sage, brass gold, soft lilac); and the fixed clauses, extended: "Keep every decoration inside the named zones. The centre column and the lower two thirds stay plain dark ground. No frame, no border, no text, no drinks." The event type reaches the prompt through a new `eventTouches` argument built from `loadDraft`'s `event_type` and the event date (`menuArtJobSteps.js:114`; the calls at `menuArtJob.js:200-203, 262-265`). Custom looks are unchanged.

### 9.3 The house layout on the canvas

A port of `MenuPreview.js`'s print variant into the designer canvas at 800 x 1000 (the 768 x 960 values scaled by 800/768), rendered by `MenuCanvas` when `content.look === 'house'` (the job copies `inputs.look` into content at Generate, so the canvas reads content only):
- Under everything, the background piece when there is one, else the flat ground `#12161C`.
- The house frame and rules, title, section labels and diamonds as `MenuPreview.js:174-299` draws them, in its palette and faces (Pirata One title, IM Fell English SC labels and names, IM Fell English body).
- Sections from the draft's drinks and the normalized bar, in `extractMenuSections`'s order and wording (Cocktails, Mocktails, Beer & Wine collapsed as `menuSections.js:18-38, 64` does; "Bar Service: Call Drinks" for a full bar with no signatures, `:69`; spirits never listed). The lane ports the collapse to the server or computes it in the canvas from content; either way one function, tested.
- **Fit:** names start at 35 px (MenuPreview's size, scaled) and step down 1 px to a 24 px floor until the sections fit above the footer; below the floor the draft reads Too long (v1 11.2's state) and Approve is disabled, as today.
- **Footer band** as `MenuPreview.js:127-167, 347-375`: the lockup on the left and, when the client image's role is `logo`, the client's logo on the right behind the brass divider. When the touch set uses the bottom corners (9.4), the lockup and the logo centre as one group.
- No `.mc-mark`, no Panel, no "Also at the bar" footer (the house sections already list beer and wine).
- The export renders the same canvas (v1 11.3), so the proof and the print file match the preview.

### 9.4 The touch sets (table T; Claude's call except the two rows marked Dallas)

| Event types (`event_type` id) | Touches | Zones | Footer |
|---|---|---|---|
| `birthday-party`, `milestone-birthday` (Dallas, the sketch) | four or five balloons in each top corner, gathered with a bow; streamers curling in toward the title; confetti across the band above the title and drifting down the side margins | top corners, top band, side margins | as is |
| `holiday-party` with an `event_date` in December (Dallas, the sketch) | gift boxes stacked in each bottom corner; holly sprigs in the top corners; ribbon curls toward the title; small gold stars and snow across the top band | all four corners, top band | centred |
| `wedding-reception`, `rehearsal-dinner`, `engagement-party`, `bridal-shower`, `anniversary` | small white florals and greenery in the top corners; a few petals drifting toward the title | top corners, top band | as is |
| `bachelor-bachelorette` | a popping champagne bottle in each top corner; gold confetti toward the title | top corners, top band | as is |
| `graduation-party` | a grad cap and a rolled diploma in each top corner; confetti toward the title | top corners, top band | as is |
| `retirement-party` | gold streamers and confetti in the top corners | top corners | as is |
| `baby-shower` | a few soft pastel balloons and small stars in the top corners | top corners | as is |
| `corporate-event`, `corporate-happy-hour`, `fundraiser-gala` | a little gold sparkle in the top corners, nothing else | top corners | as is |
| `cocktail-party`, `private-party`, `dinner-party`, `housewarming` | gold sparkle and a few confetti flecks in the top corners | top corners | as is |
| `block-party`, `festival-outdoor` | a string of bistro lights across the band above the title | top band | as is |
| `cocktail-class` | a jigger and a shaker, small, in the top corners | top corners | as is |
| `celebration-of-life`, `other`, any `event_type_custom`, `holiday-party` outside December, no event type | none: the plain house card | none | as is |

- **Where it lives:** one pure module, `server/utils/menuEventTouches.js`, exporting `touchSetFor({ event_type, event_type_custom, event_date })` returning `{ key, description, zones, bottomCorners, plain }`; the December test reads the event date's month (a `DATE`, no time zone question). The canvas reads `bottomCorners` from content (copied at Generate) to centre the footer.
- **"Small, nothing too dramatic"** (decision 12) is the acceptance bar: every touch sits in its zones, the drink names stay clear, and Dallas reviews every menu before it goes out.
- **Re-roll** of the background keeps the touch set; Start over re-reads it (an event type changed since takes effect then).

### 9.5 The Design tab on a house card

The font pairing list, the ink and accent controls, the Panel and the mark controls do not apply to the house card. The Design tab shows one line in their place: "This is the house card. Its fonts and colors are fixed. Switch the look to Custom design on the Brief tab to choose your own." The background re-roll stays (the touches can be re-drawn).

## 10. Approve and send

### 10.1 The proof and the held print file

- **One render, two files.** The html2canvas step is factored out of `exportMenu` into `renderPrintCanvas({ node, pairingId, nameOf, onBeforeRender })`, returning the 2400 x 3000 canvas. Approve calls it once and encodes two files from that one canvas: the **print file** exactly as today (2400 x 3000 JPEG at 0.92, byte for byte the same path), and the **proof**: the canvas scaled to 1200 x 1500 on an offscreen canvas with a **56 px band** under it (fill `#fbf8f3`, a 1 px `#d8d2c6` hairline at its top, the text `PROOF · not for print · v<version>.<art_version>` in 20 px `Inter, system-ui, sans-serif`, 600, 0.08em tracking, `#6b665e`, centred), drawn with the 2D API, encoded JPEG at 0.85: **1200 x 1556**, a few hundred KB.
- **Stored:** the print file under `menu-print/<proposalId>/<uuid>.jpg` as today, but **held**: it is written to `menu_drafts.approved_print_key`, never to `proposals.menu_print_key`, until it is released (10.3). The proof under a new prefix `menu-proof/<proposalId>/<uuid>.jpg`, never under `menu-print/` or `menu-art/`.
- **Frozen.** The proof row carries its `r2_key`, `version` and `art_version`; later edits never change what the client sees.

### 10.2 The Approve route, amended

`POST /api/proposals/:id/menu-draft/approve` (`menuDraftApprove.js`) takes multipart `file` (print) and `proof`, plus `version`, `art_version`, `expected_print_key` and the logo rev, as today.
1. Both files are checked before anything is written: the print file as today (`:103-129`); the proof by `isValidUpload` and `safeUploadExtension === '.jpg'`, `sharp` metadata exactly 1200 x 1556, the bounded full decode with `failOn: 'warning'`, at most 3 MB.
2. `isLegalHold(id)` refuses with 409 `LEGAL_HOLD` (the proposal under legal hold keeps its state exactly, CLAUDE.md).
3. Both uploads, with no transaction open.
4. `approveInTx`, as today (`:155-204`) except: **no `setMenuPrintKey` and no `reaccrueDuty`**; the archived check (409 `MENU_PROOF_ARCHIVED`, since the proof page would 404); the send cap (10.4); `STAMP_SQL` as today plus `released_print_key` untouched; `UPDATE menu_proofs SET superseded_at = NOW() WHERE draft_id = $1 AND superseded_at IS NULL`; INSERT the new proof with `email_status` `no_address` when the client has no email or an `.invalid` placeholder, else `sent` provisionally; the activity rows `menu_approved` (as today) and `menu_proof_sent` (`actor_type 'admin'`, `actor_id`, details `{ proof_id, draft_id, version, art_version, emailed }`); COMMIT; release.
5. **The email**, after release, outside any transaction: `sendEmail` with the template (section 11) to the live `clients.email`; then one `pool.query` setting `email_status` (`sent`; `skipped` for any id `sendEmail` returns without sending, `dev-skipped` or `skipped-invalid`; `failed` on a throw, with Sentry) and `sent_to`. A failed send never fails the request: the proof exists and the link is copyable.
6. `inboxCache.invalidate()`. Response: the GET's `proof` and `print` blocks.

The proposal `FOR UPDATE` and `MENU_PRINT_CHANGED` stay: they still guard against an admin upload landing between the render and the post.

### 10.3 Release

The held print file reaches staff (`setMenuPrintKey`) at one of two moments:
- **The client taps Looks great** on the latest proof (section 12, the answer route), when that proof's `version` and `art_version` equal the draft's `approved_version` and `approved_art_version` and `approved_print_key` is set.
- **Dallas taps Release for printing** on the card or in the editor: `POST /api/proposals/:id/menu-draft/release`.

Both run the same helper, `releaseHeldPrint(client, { draftId, proposalId, via, actorId })`, inside their transaction: the draft and the proposal `FOR UPDATE`; refuse on legal hold (the answer route records the answer and skips the release; the admin route answers 409 `LEGAL_HOLD`); require `approved_print_key` and that it is not already released; **never overwrite a file the admin uploaded**: proceed only when `proposals.menu_print_key` is null or equals the draft's `released_print_key` (otherwise the admin route answers 409 `MENU_PRINT_CHANGED` and the answer route records the answer and skips); `setMenuPrintKey(client, proposalId, approved_print_key)` (which clears `menu_not_required`); stamp `released_print_key`, `released_at`, `released_by`, `released_via`; the activity row `menu_released` (`actor_type` `client` or `admin`, details `{ draft_id, version, art_version, via }`); COMMIT; then **`reaccrueDuty(proposalId)`** and `inboxCache.invalidate()`.

**New `menu_drafts` columns:** `released_print_key TEXT`, `released_at TIMESTAMPTZ`, `released_by INTEGER REFERENCES users(id) ON DELETE SET NULL`, `released_via TEXT CHECK (released_via IS NULL OR released_via IN ('client', 'admin'))`. The same change sets `approved_by` to `ON DELETE SET NULL` (fix-list line, menu art second opinion: deleting a user fails while a draft names them).

**Re-approving after a release** (Claude's call): the new approval holds its own print file and sends a fresh proof; the released file stays live for staff, since it was approved by the client or by Dallas, until the new one is released.

**An admin upload or remove** (`menuPrint.js` POST, DELETE) works as today and needs no release; the client flow never touches a file it did not release.

### 10.4 The send cap

At most 5 approvals per proposal per rolling 24 hours, counted from `menu_proofs.sent_at` inside the transaction: 429 `MENU_PROOF_SEND_CAP` "You've sent this menu 5 times today. Try again tomorrow." A constant in the route; it protects the client's inbox and the Resend allowance.

### 10.5 The editor

- **Approve and send** replaces Approve in the top bar (`EditorBanner.js:64-80`), same gate (`menuCardState.js:193-199`). Confirm: "Approve and send to the client?" / "Emails the client a proof of the menu as it is now, with a link to say it looks great or ask for changes. Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see." / **Approve and send**. With no email on file the text ends "No email is on file for this client, so no email goes out. Copy the link from the card and send it yourself." and the button reads **Approve and create link**.
- **The hook** is `useApproveMenu` (`exportMenu.js:180-265`) extended to encode and post both files; 409 `MENU_DRAFT_CHANGED` refetches and says "The draft changed. Approve again."; an export failure goes to client Sentry (`tags: { area: 'menu-designer', step: 'approve-export' }`).
- **Release for printing** (secondary) shows while a held file is not released; it confirms ("Release for printing?" / "Staff will be able to download and print this menu now, without waiting for the client.") and posts the release route.
- Rev 1's separate Send to client button, `useSendProof` and `menuDraftProof.js` are dropped: Approve is the send.

## 11. The email

`menuProofReady({ clientName, eventTypeLabel, proofUrl })` in `server/utils/lifecycleEmailTemplates.js` (the `shoppingListReady` shape, `:259-274`; `wrapEmail`, `esc`, `firstNameOf`, `ctaButton`), `proofUrl` from a new `menuProofUrl(token)` in `server/utils/urls.js` (`${PUBLIC_SITE_URL}/menu-proof/${encodeURIComponent(token)}`). Default `FROM_EMAIL` and Reply-To, `meta: { kind: 'menu_proof', proposalId }`. No event date, venue or amounts; the client's first name only, from `clients.name`.
- **Subject:** "Your bar menu is ready for a look"
- **Body:** "Hi <first name>," / "Here's a first look at the bar menu for your <event type label>. Open it, and let us know if it looks great or if you'd like any changes." / button **Review the menu** / "The link works for 30 days. If you have questions, just reply to this email." / "Cheers," / "Dallas"
- **Text part:** the same lines with the URL in place of the button.

## 12. The client page

**Route** `/menu-proof/:token` in every site context (`App.js:387-397, 461-471, 524-534, 553-565`), lazy, unguarded. **Component** `client/src/pages/public/MenuProofPage.jsx` (under 300 lines), its own `menu-proof-page` root class, the `FeedbackPage.jsx` shape, the `.public-error*` shell for a bad token. It fetches `GET /api/menu-proof/:token` and shows the image from `GET /api/menu-proof/:token/image` (`Cache-Control: private, no-cache`).

**States**, from the GET's `state` (the benchmark is the sketch, section 22):
- **`open`:** the kicker "DR. BARTENDER", the heading "Your bar menu", "Here's the menu we drafted for your event. Tap the menu to see it larger.", the proof (full width, tap opens it in a new tab), **Looks great** (primary) and **Request changes** (secondary), which reveals one textarea ("Tell us what you'd like changed", at most 1,000 characters, a live counter) and **Send changes**. Under the buttons: "Replying here doesn't change your booking. We'll take it from here."
- **`approved`:** "Thanks! We've got it." / "You said this looks great on <date>. We'll get it printed for your event." with the proof and no buttons.
- **`changes`:** "Thanks! We've got your notes." / "We'll make the changes and send you a fresh look. Reply to our email if you think of anything else." with the client's note read-only above the proof, and no buttons.
- **`superseded`:** "A newer version was sent." / "Check your email for the latest link." No image, no buttons.
- **`expired`:** "This link has expired." / "Reply to our email and we'll send a fresh one." No image, no buttons.
- **Unknown token, archived proposal, or a deleted draft:** the `.public-error` shell, "We couldn't find that menu." with the mailto link the invoice page uses.
- **A failed post:** an inline `role="alert"` "That didn't go through. Please try again."; a 409 `MENU_PROOF_ANSWERED` or `MENU_PROOF_SUPERSEDED` re-fetches and shows the state the server reports.
- **The image missing in R2:** "We couldn't load the menu picture. Reply to our email and we'll send it again."; the buttons still work.

**No PII beyond the menu:** no client name, email, event date, venue or amounts; the proof shows what the menu shows. The token is the only key. **Token life:** 30 days from `sent_at`, enforced in SQL; one answer per proof; a newer approval supersedes the older link at once; no revoke action.

**The answer route** (`POST /api/menu-proof/:token/answer`), one transaction: `UPDATE menu_proofs SET answer, answer_note, answered_at WHERE token = $1 AND answer IS NULL AND superseded_at IS NULL AND expires_at > NOW()` with a rowCount guard (0 rows re-reads to answer 409 `MENU_PROOF_ANSWERED` / `MENU_PROOF_SUPERSEDED`, or 404); the activity row `menu_proof_approved` or `menu_proof_changes` (`actor_type 'client'`, details `{ proof_id, version, art_version }` plus `note_length` for changes, never the note); for `approved`, `releaseHeldPrint` with `via 'client'` (10.3); COMMIT; then `reaccrueDuty` when released, and `inboxCache.invalidate()`. It is a public route that can move `menu_print_key` and so start a duty-pay re-accrual: the token, the conditional UPDATE and the release helper's guards are the whole of its authority, and section 26 gives it the full fleet.

## 13. The Inbox: four menu tasks

### 13.1 The reader

A new reader, `server/utils/inbox/readMenuTasks.js` (the `readProposalSends.js` shape), registered in `engine.js` at its four places and in `readers.test.js`. It is called with `[floor, now]` and emits, per proposal with a `client_id`, **only tasks that are open right now**. Every event is `{ ref, personKey: 'c-<client_id>', channel: null, line: null, direction: 'system', at, author: null, kind, text, meta: { source: 'menu_task', proposalId, link: '/events/<proposalId>?menu=1' } }`. No task is emitted for an archived proposal, the legal-hold proposal, or once `event_date` is before `chicagoTodayYmd()`.

| kind | Open while | `at` | Text (the list row's need line) |
|---|---|---|---|
| `menu_ready` | an auto-started run (`menu_auto_starts.run_id`) is still the draft's current run, it has finished (words `done`, no piece `pending` or `working`), and no proof exists for the draft | the run's finish (the latest of the words and pieces finish times) | "Menu ready to review" (" · <n> picture(s) failed" when pieces failed) |
| `menu_failed` | the auto-start row has an error, or its run is the draft's current run and the words `failed` or the run went stale (`MENU_ART_STALE_MS`), or a row with no draft is older than 10 minutes; and no later run exists | `attempted_at` or the failure time | "Menu couldn't be generated: <sentence>" |
| `menu_changes` | the latest proof (`superseded_at IS NULL`) has `answer = 'changes'` | `answered_at` | "Asked for menu changes" (the thread shows the note) |
| `menu_no_answer` | the latest proof has no answer, the draft's held file is not released, and the due time (13.3) is at or before `now` | the due time | "No answer on the menu yet. Release it for printing?" |

A manual Generate raises no `menu_ready` or `menu_failed` (Dallas is watching the editor); a manual Generate after an auto run makes that auto run no longer current, which closes its task.

### 13.2 Tasks are kept apart from the conversation

The Inbox decides "waiting" per person with one anchor (section 2), so a menu event treated as an ordinary inbound would be closed by any reply to that client, and a menu event counting as a reply would close the client's unanswered texts. So:
- **`rules.js`** keeps `source: 'menu_task'` events out of the conversation set U and out of the anchor: a person waits when U waits (today's rule, unchanged) **or** at least one menu task is open and the person is not snoozed. A task closes only by its state: the reader stops emitting it (the `tt_missed` precedent, `normalize.js:151-180`). Done on the person never clears a task; a row held only by tasks shows the task line and the event link and hides Done. Snooze works as today, and a newly opened task ends an older snooze (`rules.js:75`).
- **`classify.js`:** menu task kinds are not counted inbound, never count as replies (an explicit `false` for `source: 'menu_task'`, ahead of the user-id default at `:72-75`), and are listed in `aiCannotClose` for safety; `subjects.js` stays as it is, so the AI never reads them and the client's note never reaches `aiRedact` or a provider.
- **The need line:** when a task is the newest reason a person waits, the row shows the task's text; the thread shows each open task as a system line with its link (a new optional `link` on thread rows: `thread.js`, `threadModel`, `Thread.js`, and the list row in `payload.js` and `WaitingRows.js`).
- **`reasons.js`** gets no new closer: a vanished task leaves no "Recently handled" row (`rules.js:136-142`), accepted.
- **Freshness:** writers that open or close a task call `inboxCache.invalidate()` (auto-start, approve, answer, release); a task that falls due on its own appears within the 30 s cache (`constants.js:57`).

### 13.3 When an unanswered proof comes back (decision 11)

A pure function, `menuReminderDueAt({ sentAt, eventDate })` in `server/utils/menuReminder.js`, in business time:
- `days = eventDate - chicagoYmdOf(sentAt)` in calendar days.
- `days >= 8`: 9:00 a.m. Chicago on `eventDate - 7` (`eventLocalToUtc(ymd, 9, 0, 'America/Chicago')`).
- `3 <= days <= 7`: `sentAt + 24 h`.
- `days <= 2`: `sentAt` (at once).
- No event date: `sentAt + 24 h`.

The due time is computed from the latest proof's `sent_at`, so re-approving restarts the clock.

### 13.4 The Inbox spec

`2026-10-06-inbox-design.md`, decision 2 ("Correspondence only") and its out-of-scope line (`:44, :173`), gain one sentence: menu tasks are the one non-correspondence item, kept apart from the conversation rules as section 13.2 says.

## 14. The card and the editor

**GET payload.** `proof: null | { id, url, sent_at, email_status, expires_at, expired, answer, answer_note, answered_at, stale }` (the latest proof; `url` is the public link, admin-only payload; `stale` when the proof's versions differ from the draft's current pair), and `print` gains `held` (an approved file not yet released) and `released_via`, `released_at`.

**Fold row "Client review"** (third row): "Not sent yet"; "Sent <date>" (plus " · no email on file", " · email failed" or " · link expired"); "Looks great, <date>"; "Changes requested <date>". Actions: **Copy link** (`btn btn-ghost btn-sm` while a proof exists and is not expired; "Copied" for 2 s; on failure a `role="alert"` "Couldn't copy. Open the editor to approve again."), and a `KebabMenu` with **Release for printing** (while held) and **Read the client's notes** (for a change request; opens the editor's Brief tab). Below 900 px the row keeps Copy link and drops the kebab.

**Table C, amended precedence:** Loading; Couldn't load; Approving; Save failed; Generating; Words failed; Drawing failed; Plan changed; Notes edited; **Client asked for changes**; **Waiting on the client**; the print states (No menu needed; Replaced by upload; Print file removed; Edited since approval; **Released**, which is today's Approved); Draft ready; then the no-draft states. "Edited since approval" compares against `approved_print_key` whether or not it is released (`menuPrintState.js:37-40` amended).

| State | Chip | Message | Sub | Actions |
|---|---|---|---|---|
| Client asked for changes | warn, Changes requested | The client asked for changes. | the first 90 characters of the note, then "..."; with `stale`: "They saw the version sent <date>; the draft changed since." | Read notes; ghost Release for printing |
| Waiting on the client | info, Waiting on client | Sent to the client <date>. Staff can print once they say it looks great. | no email: "No email on file. Copy the link and send it yourself." · email failed: "The email didn't go out. Copy the link and send it yourself." · expired: "The link expired. Approve again to send a fresh one." · `stale`: "The draft changed since. Approve again if it matters." | Release for printing; ghost Copy link |
| Released | ok, Approved | Approved for print. Staff can download it. | "The client said it looks great <date>." or "You released it <date>." | View; ghost Download |

**Table B, editor banners** (same tones, after Notes edited and before the print banners): Client asked for changes: "The client asked for changes.", the full note, and with `stale` "They saw the version sent <date>."; no buttons (Approve and send is in the top bar). Waiting on the client: info, "Proof sent <date>.", "Waiting on the client's answer. Edits here don't change what they see."; secondary **Release for printing**. Released: as today's Approved banner, plus who released it.

**Brief tab:** a compact **Client review** section at its end: the latest proof's value line and, for a change request, the note in full, read-only.

**Auto-started drafts:** the card's sub line on Draft ready reads "Drafted automatically when the client submitted their plan." while the `menu_ready` task is open.

## 15. The no-menu mark

- **New column:** `proposals.menu_not_required_by TEXT CHECK (menu_not_required_by IS NULL OR menu_not_required_by IN ('admin', 'planner'))`.
- **On submit** (`triggerMenuAutoStart`, before the auto-start), skipping an archived proposal and the legal-hold proposal:
  - `menuStyle === 'none'`: `UPDATE proposals SET menu_not_required = true, menu_not_required_by = 'planner' WHERE id = $1 AND menu_print_key IS NULL AND menu_not_required = false`, and on a row the activity row `menu_not_required` (`actor_type 'client'`, details `{ by: 'planner' }`).
  - `menuStyle` `custom` or `house`: `UPDATE proposals SET menu_not_required = false, menu_not_required_by = NULL WHERE id = $1 AND menu_not_required = true AND menu_not_required_by = 'planner'`. A mark Dallas set himself is never undone by the client.
- **The admin PATCH** (`menuPrint.js:110-113`) writes `menu_not_required_by = 'admin'` when it sets the mark and `NULL` when it clears it. `setMenuPrintKey` (`menuPrintFile.js:87`) clears both columns.
- **The card's sub line** for No menu needed adds "The client chose Skip the Menu." when the mark is the planner's.
- **The legacy planner value:** a plan with `customMenuDesign: false` and no `menuStyle` counts as `none`, as the planner itself reads it (`PotionPlanningLab.js:212-215`).
- **Backfill** (Claude's call): a one-time script, `server/scripts/backfillMenuNotRequired.js`, dry run by default (prints counts and proposal ids only), marking `planner` on every proposal with `event_date` on or after `chicagoTodayYmd()`, not archived, not the legal-hold proposal, no `menu_print_key`, `menu_not_required` false, whose designer plan (the lowest-id plan) says `none`. Past events are left alone. It runs on production once, after the lane ships, with Dallas's yes at that time (a production data write).

## 16. Out of credit

- **OpenAI:** `mapError` (`openaiClient.js:185-195`) maps a 429 or 403 whose code is `insufficient_quota` or `credit_balance_exhausted` to a new `OpenAIOutOfCredit`, never a rate limit and never retried; `menuImageProvider.js` wraps it as `MenuArtOutOfCredit`.
- **Sentences** (`menuArtJobErrors.js` `SENTENCES`): words: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then Generate again."; piece: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then re-roll." The words failure stops the run (pieces read "not attempted", as today). Sentry captures it once per run.
- **Gemini:** every 429 or `RESOURCE_EXHAUSTED` is a rate limit today (`geminiClient.js:194-202`), and the rpc status is not kept. The lane stores the status and reads the error details; if a spent prepaid balance is distinguishable (a billing reason in the details), it maps to `MenuArtOutOfCredit` with "Gemini is out of credit. Add credit in Google AI Studio's billing, then re-roll." If it is not distinguishable, Gemini keeps today's retries, and after the second retry fails the sentence becomes "Gemini is still refusing. If this keeps happening, check Gemini's billing." The lane reports which case it found.
- **The Inbox's "couldn't be generated" item** carries the same sentence.
- **Tests** that pin today's mapping change with it: `openaiClient.test.js:413, 420-428`, `geminiClient.test.js:417-438`, `menuImageProvider.test.js:317`, `menuArtJob.test.js:541, 579, 591, 619-647, 1025`.

## 17. Bar picks in the plan-changed check

- `buildFingerprint` and `fingerprintHash` (`menuDrinkSource.js:319-344`) add `bar_hash`, a hash of `normalized.bar` with each list sorted; `computeDiff` (`menuDraftRead.js:106-128`) reports a bar change as Plan changed with the line "The bar picks changed since this draft." Update draft and Dismiss store the new hash as they store the rest.
- **Existing drafts:** a stored fingerprint without `bar_hash` reads as unchanged for the bar, so nothing lights up on deploy; the next Generate, Update draft or Dismiss stores it.
- This closes the fix-list line "The menu art draft fingerprint ignores bar picks" (an approved menu could print an old pick). The same lane fixes the line on `menuDraftSync.js` ~144 running a `Promise.all` on one pg client (through `loadCatalogMaps`), since it touches that read.

## 18. Security

- **Token guard:** `requireUuidToken('token', "We couldn't find that menu.")` on the three public routes; the SQL also requires `superseded_at`, `expires_at` and the proposal's status.
- **Limiters:** the two GETs run `publicTokenIpLimiter` then a new token-keyed `menuProofReadLimiter` (60 per 15 min per token, the `proposalCheckoutLimiter` shape); the POST runs `publicLimiter` then a new `menuProofAnswerLimiter` keyed `ip:token`, 5 per hour. Release is admin-only behind `adminWriteLimiter`.
- **The proof bytes** stream only through `sendR2Object(res, row.r2_key, { prefix: 'menu-proof/<proposal_id>/' })` with the prefix from the row's own `proposal_id`, never from input; nothing under `menu-print/` is reachable from a public route.
- **The posted files:** JPEG by magic bytes, exact sizes, a full bounded decode, the proof at most 3 MB; the declared name and type are never trusted.
- **The note:** a trimmed string, 1 to 1,000 characters for changes, absent for approved; rendered as plain React text everywhere, never HTML.
- **The public GET** answers no admin data: only `{ state, answered_at, answer, answer_note, image: true }`.
- **The legal-hold proposal:** auto-start, the no-menu mark, Approve and Release all check `isLegalHold` (fails closed); no proof can exist for it.
- **Money seam:** `menu_print_key` drives the $5 `menu_print` duty line; it moves only through `setMenuPrintKey` inside `releaseHeldPrint` (or the admin upload, as today), and `reaccrueDuty` fires only after the release commits.

## 19. The privacy page

No change. The proof is stored on R2 and emailed through Resend, both named (`PrivacyPage.js:120, 125`); `:97-103` already says we email about the event; the client's note is never sent to a provider.

## 20. API

Admin routes keep v1 section 7's guard (`auth`, `requireAdminOrManager`, `asyncHandler`, `parseId`). Public routes carry no auth.

| Method and path | File | Limiter | Does |
|---|---|---|---|
| `GET /api/proposals/:id/menu-draft` | `menuDrafts.js:97-99` (`menuDraftRead.js`) | `menuDraftReadLimiter` | Adds `plan.side`, `plan.planner_reference`, `proof`, `print.held`, `print.released_*`, `auto_started`; `inputs.admin_brief`, `inputs.look`, `content.look`, `content.mark_position`, `content.font_pairing_suggested` ride in their columns |
| `PATCH /api/proposals/:id/menu-draft` | `menuDrafts.js:158-184` | `menuDraftEditLimiter` | Accepts `content.mark_position`, `inputs.admin_brief`, `inputs.look`; refuses `font_pairing_suggested` and `content.look` |
| `POST /api/proposals/:id/menu-draft/generate` | `menuDrafts.js:101`, body in `startGeneration` | `adminWriteLimiter` | Takes `admin_brief_*` and `look` |
| `POST /api/proposals/:id/menu-draft/approve` | `menuDraftApprove.js` | `adminWriteLimiter` | Multipart `file` and `proof`; holds the print file, writes the proof, emails (10.2). Adds 409 `LEGAL_HOLD`, `MENU_PROOF_ARCHIVED`; 429 `MENU_PROOF_SEND_CAP` |
| `POST /api/proposals/:id/menu-draft/release` | new, in `menuDraftApprove.js` or `menuDraftRelease.js` | `adminWriteLimiter` | Body `{ version, art_version }` (the approved pair the admin saw). 409 `MENU_NOT_HELD`, `MENU_PRINT_CHANGED`, `MENU_DRAFT_CHANGED`, `LEGAL_HOLD`. 200 the `print` block |
| `GET /api/menu-proof/:token` | new `server/routes/menuProof.js`, mounted beside `/api/public/feedback` | `requireUuidToken`, `publicTokenIpLimiter`, `menuProofReadLimiter` | `{ state, answer, answer_note, answered_at }`; 404 unknown, archived or cascaded |
| `GET /api/menu-proof/:token/image` | same | same | Streams the proof (18); 404 unless `open`, `approved` or `changes` |
| `POST /api/menu-proof/:token/answer` | same | `requireUuidToken`, `publicLimiter`, `menuProofAnswerLimiter` | Body `{ answer, note? }` (12). 200 `{ state, answered_at }`; 409 `MENU_PROOF_ANSWERED` / `MENU_PROOF_SUPERSEDED`; 404 |

Error bodies keep `{ error, code, fieldErrors? }`. Key on codes, never messages.

## 21. Validation (extends v1 section 7.1)

| Field | Rule |
|---|---|
| `mark_position` | `left`, `center` or `right`; content; missing reads as `right` |
| `font_pairing` | one of the twelve ids, server and client in sync; null on a house draft |
| `font_pairing_suggested` | words-step output only; never accepted from PATCH |
| `admin_brief` (inputs) | an object with only `theme`, `naming`, `notes`; each a trimmed string, 0 to 1,000 characters; an omitted key keeps the stored value |
| `look` (inputs) | `house` or `custom`; PATCH and Generate; `content.look` is job output only |
| Generate `admin_brief_*`, `look` | multipart strings, the same bounds; absent means the stored value, else empty or decided (9.1) |
| approve `file`, `proof` | JPEG by magic bytes; 2400 x 3000 and 1200 x 1556; full decode; the proof at most 3 MB |
| release `version`, `art_version` | integers equal to the draft's `approved_version`, `approved_art_version` |
| answer `answer` | `approved` or `changes` |
| answer `note` | required, 1 to 1,000 characters, for `changes`; absent or empty for `approved` |
| `planner_reference`, `plan.side`, `proof`, `print.held`, `auto_started` | read-model output only |

## 22. Visual contract

- **The house card touches:** the sketch Dallas chose from on 2026-11-03 (published at claude.ai/artifact/LQc5kmKEw1Rzeea4NVT3U3, version 3), vendored as `docs/design-artifacts/2026-11-03-menu-house-touches/menu-accents.html`: the birthday corner clusters and the holiday gifts in the bottom corners. It benchmarks where touches sit and how much room they take, not how they are drawn (the image model draws them). The house layout itself benchmarks against `MenuPreview.js`'s print variant (section 9.3).
- **The client page and email:** the sketch Dallas reviewed on 2026-11-03 (claude.ai/artifact/43hAY5EX3jNRcxkvhFn2YV, version 2), vendored as `docs/design-artifacts/2026-11-03-menu-proof/menu-proof-page.html`: five phone screens (the email; the open page; Request changes; after Send changes; after Looks great), on the client pages' paper, teal and brass, IM Fell faces, phone first. This settles rev 1's open recommendation for a design pass: the sketch is that pass. The `client` lens judges adherence to it.
- **The admin controls** follow v1's benchmark, `docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html`: the Placement and Look `.seg`s are the Wordmark color row's twins; the twelve pairing buttons are the six's list, longer; the Admin brief fields are the Art direction `.input` three times; From the planner and Client review are Client brief boxes (`.md-brief-box`); the Client review fold row is a third Print file row; Release for printing is a `btn btn-secondary`; banners and chips use table B's tones. New CSS stays under `md-`; the house layout's CSS under a new `mc-house-` prefix.
- **The Inbox rows** use the Inbox's existing row and system-line styles; the task link is a plain text link.

## 23. Failure modes (extends v1 section 12)

| Failure | Behavior |
|---|---|
| OpenAI out of credit (today's case) | Auto-start's run fails at the words step with the out-of-credit sentence; the Inbox shows "Menu couldn't be generated: OpenAI is out of credit..."; no retries; one Sentry event per run |
| Menu art not configured, or the daily cap reached, at auto-start | No draft; the guard row keeps the error; the Inbox shows the sentence; Dallas generates from the event page later |
| Two submits race, or a reopened plan is resubmitted | The guard row's primary key starts at most one run per proposal |
| The process dies mid auto-start | A guard row with no draft and no error reads as failed after 10 minutes |
| A client edits the plan after the auto run | The plan-changed banner, as today (now including bar picks); no new run |
| Client has no email on file | Approve creates the proof and link (`no_address`); the confirm, card and editor say so; Copy link is the path; the reminder still falls due |
| Resend throws or the quota is reached | The proof is kept; `email_status failed`; Sentry; the card says the email didn't go out |
| Notifications off (dev) | `email_status skipped`; the proof and link exist for the walks |
| Draft moved between the render and the post | 409 `MENU_DRAFT_CHANGED`; "The draft changed. Approve again." |
| Proposal archived | 409 on Approve; the public page 404s; tasks stop |
| The client answers twice, or an older link | 409; the page re-fetches and shows the state |
| Looks great arrives after Dallas uploaded his own print file | The answer is recorded; the release is skipped; the card shows Replaced by upload |
| Looks great on a proof that is no longer the approved pair (Dallas re-approved in between) | The old link is superseded, so the answer is refused with 409 `MENU_PROOF_SUPERSEDED` |
| Release clicked twice, or after the client released it | 409 `MENU_NOT_HELD`; the card refetches |
| The legal-hold proposal | No auto-start, no mark, Approve and Release refused |
| The Inbox reader's SQL fails | The engine's per-reader error path; other feeds render; Sentry |
| A due reminder for a past event | Not emitted (13.1) |
| House card names too long at the floor | Too long; Approve disabled; Dallas trims drinks or switches to Custom design |
| An event type changed after Generate | The touches follow at the next Start over or background re-roll |
| `mark_position`, `look`, `bar_hash` missing on an old draft | `right`, `custom`, unchanged; nothing moves |

## 24. Configuration, docs and lists

- **Env vars:** none new. Auto-start uses OpenAI's image model (`MENU_ART_IMAGE_MODEL`) and the existing caps.
- **Owed outside the code:** OpenAI credit must be added in OpenAI's billing settings before the auto-start lane ships, or every auto-started menu fails at once (section 23). That is Dallas's dashboard step; Claude cannot read the balance.
- **Schema:** `menu_proofs` (rev 1's table, unchanged), `menu_auto_starts` (8.4), the four `menu_drafts.released_*` columns and `approved_by ON DELETE SET NULL` (10.3), `proposals.menu_not_required_by` (15); all idempotent. ARCHITECTURE's schema section gains them.
- **README and ARCHITECTURE** (regenerated by `npm run docs` from headers): the new files `menuAutoStart.js`, `menuEventTouches.js`, `menuReminder.js`, `menuProof.js`, `readMenuTasks.js`, `MenuProofPage.jsx`, `backfillMenuNotRequired.js`, the release route; ARCHITECTURE's prose gains the hold-and-release concept and the menu tasks in the Inbox concept.
- **Inbox spec:** the sentence in 13.4.
- **`scripts/sensitive-paths.txt`** gains `server/routes/menuProof.js` (a public route that takes a client write and can release a print file), `server/utils/menuAutoStart.js` (a billed provider run started without a person), `server/utils/inbox/readMenuTasks.js` and `server/utils/inbox/rules.js` if not listed (they decide what waits on Dallas), and the release helper's file.
- **The fix list** is Dallas's to update: the lane reports name the lines this spec closes (bar picks; the one-client `Promise.all`; `approved_by` ON DELETE; the activity page's `metadata` read is a separate latent bug and stays on the list).

## 25. Testing (extends v1 section 14)

- **Pure:** `mark_position` and the canvas's `left` per position; `effectiveBrief`; the fingerprint unchanged by the admin brief and changed by a bar pick, and an old fingerprint without `bar_hash` reading unchanged; `font_pairing_suggested` refused by PATCH; the pairing ids identical on both sides; `fontsHref` for all twelve; the look decision (9.1) for every combination of style, briefs, art direction, reference and logo; `touchSetFor` for every event type id, a custom type, no type, and a holiday party in December and in November; `menuReminderDueAt` for 30, 8, 7, 3, 2, 0 days out, no date, and a `sent_at` late in a Chicago evening (the GMT day is the next day) across a DST change; the house sections from a plan (the collapse, Call Drinks, spirits never listed); `menuCardState` for every row of table C, the `stale` variants and expiry; `menuPrintState` with a held file.
- **Payload rule:** the words request and background prompt carry the merged brief and nothing from `planner_reference`; a house run makes no words call; the house background prompt names the touch zones and the event, and a custom background prompt is unchanged.
- **Routes (shared dev DB, one suite at a time):**
  - **Auto-start:** each skip in 8.2 starts nothing; the guard row stops a second call and two concurrent calls; each thrown error lands on the guard row with its sentence; success stores the draft and run; it runs after the submit commits and holds no submit client.
  - **No-menu mark:** set by `none`, cleared by a later `custom` only when the planner set it, never when the admin did; the PATCH and `setMenuPrintKey` keep the provenance column right; the backfill's dry run writes nothing.
  - **Approve:** both files validated; nothing written on a bad proof; `menu_print_key` untouched and no duty re-accrual; the proof and activity rows in one transaction; the previous proof superseded; the send cap; legal hold and archived refused; the email after commit with each `email_status`.
  - **Release (admin):** sets the key, stamps `released_*`, writes the activity row, fires `reaccrueDuty` after commit; refuses a second release, a moved pair, an admin-uploaded file and the legal-hold proposal.
  - **Answer:** each state; one answer; `approved` releases only the matching held file and never overwrites an upload; `changes` requires a note; the activity row never carries the note; the limiters are on the chain.
- **Inbox:** `readMenuTasks` emits each kind exactly while its state holds and never for a past, archived or legal-hold event; a future due time is not emitted; a reply to the client does not close a task, and a task does not close the client's unanswered text; Done does not clear a task; snooze hides it until a new task opens; the AI never reads a menu task; the existing Inbox suites (`rules.*.test.js`, `engine.test.js`, `readers.test.js`, `subjects.test.js`, `server/routes/admin/inbox.test.js`) stay green.
- **Errors:** `credit_balance_exhausted` and `insufficient_quota` map to out of credit with no retry and the new sentences; a plain 429 still retries.
- **Client:** the Placement picker and the Suggested tag; the Look `.seg` and the house-card note on the Design tab; the admin brief fields; From the planner; the fold row and kebab; Approve and send's confirm and the no-email variant; Release for printing; `MenuProofPage` in every state with a mocked `api`; `exportMenu` still producing 2400 x 3000 at 0.92 after the factoring; the house canvas fitting and centring its footer.
- **Existing suites the change reaches stay green:** every v1 suite, `menuDraftApprove.test.js`, `menuDraftValidation.test.js`, `fontPairings.test.js`, `DesignTab.test.js`, `BriefTab.test.js`, `MenuCardFold.test.js`, `menuCardState.test.js`, `exportMenu.test.js`, `useMenuDraft.test.js`, the drink plan submit suites, `menuPrint` tests, the duty-line tests, `lifecycleEmailTemplates` tests, `PrivacyPage.test.js`.
- **Visual:** the `client` lens on the Design and Brief tabs against v1's artifact; on the proof page and the house card against the 2026-11-03 sketches, phone width first.
- **Live walk on dev** (after OpenAI credit is added): submit a test plan for a dev birthday event with a client email Dallas owns and `SEND_NOTIFICATIONS=true` on that server only; see the Inbox's "Menu ready to review"; open it, approve and send; open the email on a phone; Request changes and see the Inbox task and the card; approve again and see the old link superseded; Looks great and see the staff download appear and the duty line re-accrue on a completed shift; on a second event, approve and use Release for printing with no answer; a Skip the Menu submit marks the event; a holiday party in December draws gifts low and centres the footer.

## 26. Review level

- **Approve and send, release, the client page, the Inbox tasks:** the full fleet plus the external second opinion: a public route that takes a client write and can move `menu_print_key` (a duty-pay seam), an external send, the Inbox's waiting rules, and sensitive-listed files.
- **Auto-start:** the full fleet: a billed provider run started by a public submit with no person in the loop, the run-once guard, and the legal-hold check.
- **The no-menu mark and backfill:** schema and data lenses; the backfill's production run waits for Dallas's yes.
- **Out of credit, bar picks:** one reviewer each plus the suites they reach.
- **Mark, fonts, Brief tab, house card:** one reviewer each plus the `client` lens; the admin brief and the house card add the payload-rule tests, since they change what leaves the OS.

## 27. Rollout

1. **Fixes first,** independent of the rest: out of credit (16), bar picks (17), the no-menu mark (15).
2. **The designer additions:** mark placement (5), fonts (6), the Brief tab (7).
3. **The house card template** (9).
4. **Approve and send, the client page, release and the Inbox tasks** (10 to 14), one full-fleet lane or two (the plan decides).
5. **Auto-start** (8) last, so an auto-started draft lands in an Inbox and an Approve that already send. It ships only after OpenAI credit is added (section 24).
6. **First real use:** the next upcoming event whose client submits a plan; Dallas watches the Inbox.
7. The phone lane picks up the new card states from `menuCardState.js` when it is cut.

## 28. Copy (every new client-facing and admin string; ids only, no em dashes)

- **Email:** subject "Your bar menu is ready for a look"; "Hi <first name>,"; "Here's a first look at the bar menu for your <event type label>. Open it, and let us know if it looks great or if you'd like any changes."; button "Review the menu"; "The link works for 30 days. If you have questions, just reply to this email."; "Cheers," / "Dallas".
- **Page, open:** "DR. BARTENDER"; "Your bar menu"; "Here's the menu we drafted for your event. Tap the menu to see it larger."; "Looks great"; "Request changes"; "Tell us what you'd like changed"; "Send changes"; "Replying here doesn't change your booking. We'll take it from here."
- **Page, approved:** "Thanks! We've got it."; "You said this looks great on <date>. We'll get it printed for your event."
- **Page, changes:** "Thanks! We've got your notes."; "We'll make the changes and send you a fresh look. Reply to our email if you think of anything else."
- **Page, superseded / expired / errors:** "A newer version was sent."; "Check your email for the latest link."; "This link has expired."; "Reply to our email and we'll send a fresh one."; "We couldn't find that menu."; "That didn't go through. Please try again."; "We couldn't load the menu picture. Reply to our email and we'll send it again."
- **Proof band:** "PROOF · not for print · v<version>.<art_version>".
- **Inbox:** "Menu ready to review"; " · <n> picture(s) failed"; "Menu couldn't be generated: <sentence>"; "Asked for menu changes"; "No answer on the menu yet. Release it for printing?"
- **Errors:** "OpenAI is out of credit. Add credit in OpenAI's billing settings, then Generate again."; "OpenAI is out of credit. Add credit in OpenAI's billing settings, then re-roll."; "Gemini is out of credit. Add credit in Google AI Studio's billing, then re-roll."; "Gemini is still refusing. If this keeps happening, check Gemini's billing."; "Today's menu art limit is reached. Generate it from the event page tomorrow."; "The menu couldn't be started. Generate it from the event page."
- **Admin:** the Placement labels; "Suggested"; the admin brief placeholders and hint (7.2); the Look labels and hint (9.1); the house-card note (9.5); the planner hints (7.1); "Approve and send", "Approve and create link" and the confirm text (10.5); "Release for printing" and its confirm; "The draft changed. Approve again."; the fold row values; table C and table B rows; "Drafted automatically when the client submitted their plan."; "The client chose Skip the Menu."; "The bar picks changed since this draft."; "You've sent this menu 5 times today. Try again tomorrow."
