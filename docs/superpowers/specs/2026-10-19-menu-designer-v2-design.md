# Menu designer v2: design

**Date:** 2026-10-19
**Status:** the five additions Dallas asked for after first use of the designer that shipped 2026-10-17 (fix list, Potions section, "Menu designer v2, Dallas's notes from first use (2026-10-19)", items 1 to 4 and 7). Every decision below is his, settled in the brainstorm, except the one marked "(recommended; Dallas to confirm)" in section 6. This spec extends the v1 contract, `docs/superpowers/specs/2026-10-01-menu-art-generator-design.md` (cited below as "v1"), and amends it only where it says so. Where v1 and this document differ on a point this document names, this document wins; everything v1 says that this document does not touch stands.
**Visual design:** no claude.ai/design artifact for v2 (section 11).

## 1. Goal and scope

Five additions to the desktop designer, in the order Dallas listed them:
1. **Mark placement:** left, center or right for the Dr. Bartender mark (section 5).
2. **More font choices**, with the words step's suggestion still the default (section 6).
3. **Planner data on the Brief tab**, read-only, so a plan whose brief fields are empty no longer reads as "None" three times while it holds drinks, bar picks and notes (section 7.1).
4. **An admin brief**, typed by Dallas on the Brief tab and read by the words step ahead of the client's (section 7.2).
5. **Send to client for approval:** a frozen proof, an email with a token link, a public page with "Looks great" and "Request changes", the answer on the card, in the activity log, and (for a change request) in the Inbox (section 8).

**Out of scope, a later round**
- Event-type templates (fix-list item 5) and moving or resizing elements, including the cheaper nudge controls (item 6). Both are deliberately after this round: templates want the admin brief in place first, and move/resize reworks the fit rule and export parity (v1 11.2, 11.3; plan Lane 5, "keep the spec 11.2 fit rule as written", `docs/superpowers/plans/2026-10-01-menu-art-generator.md:852`).
- The phone lane (v1 decision 13). `client/src/pages/mobile/menu/` does not exist yet; the card states this spec adds (section 8.7) live in `menuCardState.js`, which that lane reuses unchanged, so it inherits them.
- SMS delivery of the proof (Dallas: email only, SMS costs money). A client who answers by replying to the email is handled as any email reply today; nothing here parses mail.
- A client-side edit of the menu, or any client reply other than the two buttons and one text box.
- Deleting superseded proofs from R2 (`storage.js` has no delete; v1 section 1).

## 2. Verified context

- **The mark.** `MenuCanvas.js:97-109` renders `Mark({ color, inPanel })` as `.mc-mark`, or `.mc-mark.mc-mark-panel` with the Panel backing; it is placed at `MenuCanvas.js:272` after the page box. `index.css:22874` fixes it `position: absolute; right: 40px; bottom: 40px`, and `index.css:22883` moves it to `right: 68px; bottom: 64px` inside the Panel (the 2026-10-17 review fix: at 40 / 40 the panel line ran through the wordmark). The avatar is 40 px tall at its natural ratio (`index.css:22875`; the PNG is 283 x 273, so about 41.5 px wide), the wordmark is 159 x 18 (`index.css:22876`), the row gap is 8, so the mark is about 208 px wide. The page box pads 58 / 66 / 86 (`index.css:22824-22826`, `layouts.js:18-22` `PAGE_PAD_BOTTOM = 86`) and 110 at the bottom under the Panel (`index.css:22882`). The mark sits entirely inside that bottom padding (top edge 80 px from the bottom; 104 under the Panel), below the "Also at the bar" footer (`.mc-also`, centered, max-width 560, `index.css:22865`). So the fit loop (`layouts.js:41-45`, v1 11.2) already leaves the mark its room at every horizontal position; nothing in the fit rule changes.
- **The mark's controls.** `DesignTab.js:124-136`: a `role="switch"` row reading "Dr. Bartender mark" over "Small, bottom right" (`:127`) that PATCHes `inputs.drb_mark`, and, when on, the "Wordmark color" `.seg` that PATCHes `content.mark_color` (`:133`). `menuColors.js:29-38` resolves the mark color; `menuDraftValidation.js:251` validates `mark_color` as `ink | accent | gold`.
- **Pairings.** The six ids live in `server/utils/menuFontPairings.js:8-15` (`FONT_PAIRING_IDS`, `isFontPairingId` at `:17-19`) and `fontPairings.js:27-29`; the faces, sizes, tracking and light / dark ink-accent defaults in `fontPairings.js:37-88` (v1 table P). `pairingFaces` (`:99-111`) feeds `fontsHref` (`:117-133`, one Google Fonts css2 URL), `ensureFontsLink` (`:135-148`) and `useFontsRevision` (`:150-178`). The Design tab loads every pairing's faces on open (`DesignTab.js:56`) and draws six stacked "Bar Menu" buttons (`:76-95`); choosing one resets ink and accent to null (`:85`). The words step's schema offers the model exactly `FONT_PAIRING_IDS` (`menuArtPrompts.js:150`), and PATCH refuses any other id (`menuDraftValidation.js:245`). The export waits on the pairing's link, each face and `document.fonts.ready`, 10 s each (`exportMenu.js:11-18, 59, 118-121`).
- **The brief.** `normalizePlan` returns `brief: { theme, naming, notes }` from `selections.menuTheme`, `drinkNaming` and `menuDesignNotes` (`menuDrinkSource.js:303-307`), whichever side feeds the drinks (`:229`, v1 decision 8). The fingerprint hashes those three client fields only (`:319-331`), and the GET's diff compares them (`menuDraftRead.js:106-128`). The words step cuts each to `BRIEF_MAX = 1000` (`menuArtPrompts.js:32, 159-165`); the background prompt sends theme, notes, art direction and the palette (`menuArtImagePrompts.js:39-54`). The job hands `normalized.brief` to the words step (`menuArtJob.js:185-188`), the background (`:200-203`) and a re-roll (`:253-263`), all from `freshPlan` (`menuArtJobSteps.js:123-126`); Update draft's words call for client-typed drinks passes `first.brief` (`menuDraftSync.js:98-108, 132`).
- **The Brief tab** shows the three client fields read-only (`BriefTab.js:32, 103-111`, "None" when empty at `:38`), the client image and its role, the style reference, and Art direction (`:164-168`, `inputs.art_direction`, 500 characters). Inputs may be PATCHed before the words land; content may not (`menuDraftValidation.js:309, 313-323`). Before any draft exists the hook keeps the brief inputs in `DEFAULT_BRIEF` (`useMenuDraft.js:30`) and posts them with Generate as multipart strings (`:236-250`).
- **What the planner stores that the tab does not show.** `selections.signatureDrinks`, `customCocktails`, `mocktails`, the bar picks (`beerFromFullBar`, `wineFromFullBar`, `beerFromBeerWine`, `wineFromBeerWine`, `spirits`, `spiritsOther`), `menuStyle`, `additionalNotes` and `mocktailNotes` (`client/src/pages/plan/v2/PlannerV2.js:25-50`; `PotionPlanningLab.js:36, 56`; all on the submit allow-list, `server/routes/drinkPlans/submitSanitize.js:13-22`). The GET already carries `plan: { id, menu_style, drink_count, drinks: [{ name, mock }], bar_summary }` for the draft's side (`menuDraftRead.js:137-148`). Event 608, plan 103 (prod) is the real case: menu style house, consult-sourced, all three brief fields empty.
- **Approve, the pattern the proof follows.** The browser flushes, renders a hidden unscaled `ExportCanvas`, exports a 2400 x 3000 JPEG and posts it with `version`, `art_version`, `expected_print_key` (`exportMenu.js:118-136, 140-148, 180-265`; `MenuEditor.js:70, 187-191, 292`). The server takes JPEG magic bytes only, checks the header and a bounded full decode (`menuDraftApprove.js:103-129`), uploads to R2 before any transaction (`:232-234`), then in one transaction locks the draft, refuses a moved `version` or `art_version` (`:165`), requires the words (`:166`), requires every layout piece done (`:131-139, 167-172`), writes the `menu_approved` activity row (`:192-195`) and commits. The shared route helpers are `menuDraftShared.js` (`parseId :52-59`, `parseVersion :63-68`, `requireProposal :78-82`, `requireWords :92-99`, `inLockedTx :117-131`).
- **Public token routes.** `requireUuidToken(param, message)` (`server/utils/tokens.js:22-27`) answers a non-UUID with a 404 before any query. Limiters keyed by IP: `publicLimiter` 20 per 15 min (`rateLimiters.js:3-9`), `publicReadLimiter` 100 per 15 min shared by 13 public files (`:11-17`), `publicTokenIpLimiter` 300 per 15 min, chained ahead of token-keyed limiters so a random UUID cannot mint itself a fresh bucket (`:98-113`); `proposalCheckoutLimiter` is the token-keyed shape (`:78-85`). `publicFeedback.js` is the closest write precedent: a local `submissionLimiter` keyed `ip:token` (`:18-25`), a 2,000-character comment cap (`:52`), one submission per token (409 `FEEDBACK_ALREADY_SUBMITTED`, `:121`). The only SQL-enforced link expiry is the voicemail listen link's `'30 days'` (`voicemailListen.js:48`). Archived proposals are excluded from the proposal page with `status <> 'archived'` (`publicToken.js:221`). URLs come from `server/utils/urls.js` (`PUBLIC_SITE_URL :8`, `proposalUrl :23-25`).
- **The public pages.** Token routes are declared per site context in `client/src/App.js` (`:387-397` public site, `:461-471`, `:524-534`, `:553-565`), unguarded, lazy-loaded (`:92-104`). Token pages are chromeless with their own root class; the shared bad-token shell is `.public-error*` (`index.css:7953-8006`). `client/src/pages/public/FeedbackPage.jsx` is the analog: `api.get` by token (`:18`), not-found / loading / already-answered / done states (`:24-65`), `api.post` with a 409 read as done (`:99-102`).
- **Email.** `sendEmail({ to, subject, html, text, from, replyTo, attachments, meta })` (`server/utils/email.js:52`) sends nothing when `RESEND_API_KEY` is unset or notifications are off (`:64-67`, returns `{ id: 'dev-skipped' }`; `notificationsEnabled.js:21-25`), uses `ADMIN_EMAIL` as the default Reply-To (`:70`), and throws on a Resend error (`:88-92`, Resend itself never throws; `.error` is checked). Client-facing lifecycle templates return `{ subject, html: wrapEmail(...), text }` and sign off "Cheers, Dallas" (`lifecycleEmailTemplates.js:36-54, 259-274`). The client's address is the live `clients.email` through `proposals.client_id` (`schema.sql:845-846, 865`; `comms/actions/invoiceSend.js:37`); `proposals` has no email column.
- **The activity log.** `proposal_activity_log (proposal_id, action, actor_type, actor_id, details)` (`schema.sql:935-943`), raw INSERTs, no helper; client-actor precedents `'viewed'` and `'signed'` (`publicToken.js:399-401, 628-629`). The event page lists the first 12 rows by `a.action` (`EventDetailPage.js:601-625`).
- **The Inbox is derived, not stored.** It reads the source tables live and stores only taps (`inbox_actions`: claim, release, done, snooze, wake, reopen), seen marks and AI reads (`schema.sql:5445-5462`). An item is a **person** (`c-<client_id>`, `personKey.js:6-13`), built from events each reader returns in one shape (`{ ref, personKey, channel, line, direction, at, author, kind, text, meta: { source, ... } }`; `readProposalSends.js:9-26` is the smallest reader; the readers run in `engine.js:321-347`). A person is waiting while a counted inbound sits after the anchor, the latest of our real reply, a Done and a Zola close (`rules.js:189-210`); counted inbound kinds are `message`, `media`, `tt_missed`, `zola_unread` (`classify.js:29-32`), and the AI may never close `media`, `tt_missed`, `zola_unread` or an empty message (`:37-40`). Replies are recognized by `meta.source` (`:44-77`). The Inbox spec put change requests out of scope ("Correspondence only", `2026-10-06-inbox-design.md:173`, `:44`); a menu change request is the first exception, by Dallas's 2026-10-19 call (decision 5 below).
- **R2.** `sendR2Object(res, key, { prefix, filename, disposition, width })` requires a prefix and 404s a key outside it or containing `..` or `//` (`r2Proxy.js:58-65, 141-144`); `storage.js` exports `uploadFile(buffer, key)` (`:22`) and `readFile(key)` (`:66`).
- **Sensitive paths.** `scripts/sensitive-paths.txt:3-7` lists money, auth, data and external-send risk; it already carries `rateLimiters.js` (`:229`), `server/utils/*EmailTemplates.js` (`:237`), `publicToken.js` (`:428`), `voicemailListen.js` as "a PUBLIC route that streams a client's recorded voice" (`:198-200`) and the menu art routes (`:594-615`).
- **Privacy page.** `PrivacyPage.js:27-29` lists the client data collected, `:97-103` says we email about the quote, booking, payments and event, `:120` names Resend, `:123` OpenAI and Gemini, `:125` Cloudflare and Neon.

## 3. Decisions (Dallas, 2026-10-19)

1. **Mark placement** is a content field, `mark_position`, default `right`, so every existing draft renders as today.
2. **Fonts:** the words step's pick stays the default; more choices join it. The shape is section 6's recommendation, marked for his confirmation.
3. **Planner data** is reference only: read-only on the Brief tab, never sent to a provider.
4. **The admin brief** is Dallas's own theme, naming and design notes, used whether or not the client filled the planner in; the words step reads it first, then the client's.
5. **Send to client** shows the DRAFT, before the print Approve, so staff never print something the client is still reviewing; the client's answer never gates printing. The client sees a frozen PROOF (an image stamped with the draft version), never the live draft. Delivery is email through Resend, with the link copyable from the card. A change request becomes an Inbox item waiting on Dallas ("so we don't miss any feedback"), and shows on the card and in the activity log; "Looks great" updates the card and the log and closes quietly.

## 4. What Dallas sees and does

1. **Design tab:** beside the mark switch, when the mark is on, a **Placement** `.seg` Left / Center / Right (section 5). The switch's sub line reads "Small, bottom left / center / right" to match.
2. **Design tab, Font pairing:** twelve pairings instead of six, the words step's pick tagged "Suggested" (section 6).
3. **Brief tab:** the Client brief box stays; under it an **Admin brief** box with three editable fields (section 7.2), then a read-only **From the planner** box with the planner's own drinks, bar picks and notes, and a line saying when the menu's drinks come from the consult side instead (section 7.1).
4. **Editor top bar:** a secondary **Send to client** button to the left of Approve (section 8.3). It confirms, freezes the proof, emails it, and the top bar's status chip and the card update.
5. **Card:** a third fold row, **Client review**, with the proof's state, **Copy link**, and a kebab with Send to client (section 8.7). New card states: Sent to client, Client approved, Client asked for changes, Client saw an older version.
6. **The client** opens the link, sees the proof, taps **Looks great** or writes a note and taps **Request changes**, and sees a thank-you. A change request lands in the Inbox under the client's row.

## 5. Mark placement

- **Field:** `content.mark_position`: `left` | `center` | `right`; missing reads as `right` (v1 section 6, content). Written by PATCH like `mark_color`; never by the job; `parseWords` does not set it (the model has no say over placement).
- **Layout** (`MenuCanvas.js:97-109, 272`; `index.css:22874, 22883`): `Mark` takes `position`. `right` keeps today's CSS (40 / 40; 68 / 64 under the Panel). `left` mirrors it: `left: 40px; right: auto` (68 under the Panel). `center` sets an inline `left` computed in canvas px as `(800 - markWidth) / 2`, where `markWidth` is the avatar's rendered width (40 x 283 / 273) + 8 + 159, about 208, so about 296 px; never a CSS `transform`, keeping to v1 11.3's rule of nothing html2canvas might draw differently from the browser. The vertical offsets are unchanged in every position, so the mark stays inside the page box's bottom padding (section 2) and the fit loop needs no new room. The 40 px safe area holds on both sides.
- **Design tab** (`DesignTab.js:124-136`): the Placement `.seg` under the switch, above Wordmark color, PATCHing `{ content: { mark_position } }`; disabled with the rest of the tab until the words land (content). The sub line text follows the value.
- **Export:** the hidden `ExportCanvas` renders the same `MenuCanvas`, so the proof and the print file carry the mark where the preview shows it (v1 11.3). The proof (section 8.2) is rendered from the same node.
- **Validation** (section 10): `mark_position` joins `CONTENT_CHECKS` beside `mark_color` (`menuDraftValidation.js:240-252`), and the client mirrors it with the picker.

## 6. More font choices

**Decision (recommended; Dallas to confirm): a larger curated pairing list, twelve pairings, with the words step's pick tagged "Suggested".** Not a Custom mode with separate heading and body pickers. What v1 hangs on a pairing id decides it: each id carries three faces with their sizes, weights, case and tracking tuned to each other (table P), a light-art and a dark-art ink and accent pair that the tone picks (`fontPairings.js:37-88`, `menuColors.js:29-38`), the Google Fonts link and the per-face 10 s waits before Approve (`fontPairings.js:117-148`, `exportMenu.js:59, 118-121`), the server's id validation (`menuFontPairings.js:17-19`) and the words step's enum (`menuArtPrompts.js:150`). A Custom mode would have to invent per-face size tables, tracking and color defaults for every combination, re-prove the fit rule and export parity on arbitrary face sets, and give the words step nothing to suggest. Twelve ids cost six rows in table P and nothing new in the machinery; every face still loads through the one link helper, and the server still validates one enum.

- **The six new pairings** (ids fixed now; faces are all on Google Fonts; sizes, tracking and colors are starting values set by the lane against the 2026-10-01 boards by table P's method, as the six existing ones were):

| id | Name · theme | Title | Heading (names) | Body | Light ink / accent | Dark ink / accent |
|---|---|---|---|---|---|---|
| `art-deco` | Gatsby · Art deco | Limelight 400, 56, uppercase, 0.12em | Josefin Sans 600, 18, 0.08em | Josefin Sans 400, 15 | `#1b1b1f` / `#a8842e` | `#f3ead6` / `#e3c56a` |
| `botanical` | Conservatory · Botanical serif | Playfair Display 700, 62 | Lora 600, 22 | Lora 400, 16 | `#2f3b2a` / `#6d7f4c` | `#eef3e6` / `#b7cf8a` |
| `hand-lettered` | Chalkboard · Hand lettered | Caveat 700, 76 | Patrick Hand 400, 24 | Nunito 400, 15 | `#2b2b2b` / `#b8433a` | `#f6f1e8` / `#f4b183` |
| `fiesta` | Fiesta · Bold festive | Lilita One 400, 66 | Baloo 2 700, 22 | Baloo 2 500, 15.5 | `#2a1a3a` / `#e4572e` | `#fff4e6` / `#ffcf5c` |
| `editorial` | Masthead · Minimal serif | DM Serif Display 400, 62 | DM Sans 600, 18, uppercase, 0.06em | DM Sans 400, 15 | `#141414` / `#8a1c1c` | `#f5f5f0` / `#e8b4a0` |
| `black-tie` | Black Tie · Formal | Cinzel 700, 54, 0.1em | Cinzel 500, 18, 0.06em | Cormorant Garamond 500, 17 | `#15161d` / `#7d6a3c` | `#f1ede4` / `#d6c08a` |

- **Server:** `FONT_PAIRING_IDS` gains the six ids (`menuFontPairings.js:8-15`); nothing else on the server knows a face. The words schema enum grows with it (`menuArtPrompts.js:150`); the prompt line stays "the pairing that best suits the theme".
- **Suggested:** `parseWords` also stores the model's pick as `content.font_pairing_suggested` (words-step output only; `CONTENT_SERVER_ONLY`, `menuDraftValidation.js:253-254`, so PATCH refuses it). The Design tab tags that button "Suggested" (a `.tag` beside the id, `DesignTab.js:76-95`); Dallas's choice stays `font_pairing` as today, and choosing another pairing still resets ink and accent (`:85`). The meta row's "<pairing name>" (v1 11.1) is unchanged. Existing drafts have no `font_pairing_suggested`; the tag is simply absent.
- **Loading:** the editor still loads every pairing on open (`DesignTab.js:56`): one css2 link for about 30 families; the font files themselves download only for the glyphs the samples and the canvas use. The card keeps loading one pairing (v1 10.3). `pairingFaces`, `fontsHref` and the export waits need no change: they read table P.
- **Design tab layout:** twelve stacked buttons in the same list (v1 11.1, Design tab), no grid; the panel scrolls.

## 7. The Brief tab: planner data and the admin brief

### 7.1 Planner data, read-only

- **Payload.** The GET's `plan` block (`menuDraftRead.js:137-148`) gains `side` (`planner` | `consult`, from `normalized.side`, `menuDrinkSource.js:229, 300`) and `planner_reference`, built from `selections` **regardless of the side the drinks come from**: `normalizePlan({ ...planRow, shopping_list_source: 'planner' }, maps)` (the planner branch, `:240-246`) gives `drinks: [{ name, mock, typed }]` and `bar: { beer, wine, spirits, na }` (`plannerBar`, `:169-186`); plus `additional_notes` and `mocktail_notes` from `selections.additionalNotes` and `selections.mocktailNotes`, trimmed, each cut to 2,000 characters for display, null when empty. `planner_reference` is null with no plan. The second normalization runs only in the read model (the catalog maps are already loaded, `:219-224`).
- **Brief tab.** A **From the planner** section (noted "Potion Planner · read-only") under the Admin brief box: "Menu style: Custom / Standard (house) / Skip / not chosen" from `plan.menu_style`; "Drinks (<n>)" as a comma list of names, mocktails marked; "Bar" as the labels per family (the same words `menuAlsoAtBar.js` prints); "Additional notes" and "Mocktail notes" when present. When `plan.side === 'consult'`, a hint line above the list: "This menu's drinks come from the consult form, which the shopping list uses. The planner picks below are what the client chose on their own." When `plan.side === 'planner'` and the plan has no drinks: "The client hasn't picked drinks yet."
- **Payload rule (v1 5.1, extended).** `planner_reference` and its notes are display only. They are never part of `normalized.brief`, the words request, the background prompt or a re-roll. Nothing in this section is sent to OpenAI or Gemini. The test in section 14 pins it.

### 7.2 The admin brief

- **Storage: `inputs.admin_brief`**, `{ theme, naming, notes }`, each a trimmed string of at most 1,000 characters, empty allowed; absent means none. Inputs, not content, because: content is reset to the words status `pending` by every Generate (v1 5.5, step 2) and filled by the job (v1 section 6, Writers), so an admin brief kept there would be wiped by the very Generate it was written for; inputs are what Dallas tells the drafter (role, reference, art direction, mark), are editable before the words land (`menuDraftValidation.js:313-323`), live in the hook's pre-draft brief (`useMenuDraft.js:30`) and are posted with Generate (`:236-250`). It is never written by the job.
- **Writes.** PATCH `inputs.admin_brief` (one object; `INPUT_CHECKS`, `menuDraftValidation.js:256-262`), and Generate as three multipart fields `admin_brief_theme`, `admin_brief_naming`, `admin_brief_notes` (`validateGenerateInputs`, `:97-122`, absent means the stored value on Start over, else empty). Editable before and after a draft exists, like `art_direction`; applied at the next Generate, Start over, Update draft (its words call for added drinks) and background re-roll. Like every inputs PATCH it bumps `version` (`menuDrafts.js:180`), so after a print approval it reads "edited since approval" (v1 section 8, rule 4), exactly as an art direction edit does today; accepted.
- **The merge**, one pure function `effectiveBrief(clientBrief, adminBrief)` in `menuDrinkSource.js`: per field, the admin text when non-empty after trim, else the client's; then each cut to 1,000 (`BRIEF_MAX`, `menuArtPrompts.js:32`). It is applied at the four provider seams and nowhere else: the words step (`menuArtJob.js:185-188`), the background prompt (`:200-203`), a re-roll (`:253-263`) and Update draft's typed-drinks words call (`menuDraftSync.js:132`). `normalized.brief` itself stays the client's.
- **Staleness (v1 section 9).** The fingerprint and the diff keep hashing `normalized.brief`, the client's three fields (`menuDrinkSource.js:319-331`; `menuDraftRead.js:123`). An admin brief edit is an inputs write and never touches `plan_fingerprint`, so it can never read as "Edited by client" or raise the Notes edited state. Section 14 pins it.
- **Brief tab.** An **Admin brief** section (noted "Yours · read first") under the Client brief: three `.input` textareas, Theme & colors, Drink naming, Design notes, each `maxLength` 1,000, placeholders "e.g. navy and brass, art deco, a little playful", "e.g. name the cocktails after the couple's dogs", "e.g. keep the title small, no florals", saved through the hook's debounced PATCH (inputs); before a draft, held in the hook's brief. A hint under the box: "Used first. Where you leave a field blank, the client's text is used. Applies at the next Generate or Start over." Never inert, never gated on the words, read-only on a read-only draft.
- **Payload rule.** The admin brief is brief text: it goes to the providers exactly where the client's brief goes, and nowhere else.

## 8. Send to client for approval

### 8.1 Data model

Added to `server/db/schema.sql` with idempotent statements, after the menu art block (`:4958-5081`).

**`menu_proofs`** (one per send; the draft's history)
- `id SERIAL PRIMARY KEY`
- `draft_id INTEGER NOT NULL REFERENCES menu_drafts(id) ON DELETE CASCADE`, `proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE`
- `token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()` (the public key; the `drink_plans` / `proposals` token precedent, CLAUDE.md)
- `version INTEGER NOT NULL`, `art_version INTEGER NOT NULL` (the draft the proof was rendered from)
- `r2_key TEXT NOT NULL` (`menu-proof/<proposalId>/<uuid>.jpg`)
- `sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `sent_by INTEGER REFERENCES users(id)`, `sent_to TEXT` (the address the email went to; null when none was on file)
- `email_status TEXT NOT NULL CHECK (email_status IN ('sent', 'failed', 'no_address', 'skipped'))` (`skipped` is `sendEmail`'s `dev-skipped`)
- `expires_at TIMESTAMPTZ NOT NULL` (`sent_at` + 30 days), `superseded_at TIMESTAMPTZ` (set when a newer proof is sent for the draft)
- `answer TEXT CHECK (answer IS NULL OR answer IN ('approved', 'changes'))`, `answer_note TEXT`, `answered_at TIMESTAMPTZ`, `CHECK ((answer IS NULL) = (answered_at IS NULL))`
- `CREATE INDEX IF NOT EXISTS idx_menu_proofs_draft ON menu_proofs (draft_id, sent_at DESC)`

**The latest proof** of a draft is the row with `superseded_at IS NULL` (at most one). Everything the card, the editor and the Inbox show derives from it plus the draft's current `version` and `art_version`; no state column is stored.

**Writers.** The send route inserts a row and supersedes the previous latest; the public answer route writes `answer`, `answer_note`, `answered_at` once; `sendEmail`'s result writes `email_status` and `sent_to` after the send. Nothing else touches the table. `menu_drafts` and `menu_draft_pieces` are not changed by this section.

### 8.2 The proof image

- **Rendered in the browser from the editor**, the Approve path: flush the autosave, render the hidden unscaled `ExportCanvas` from the draft as saved, wait on the fonts and every layer (`exportMenu.js:118-136`). The html2canvas step is factored out of `exportMenu` into `renderPrintCanvas({ node, pairingId, nameOf, onBeforeRender })` returning the 2400 x 3000 canvas; `exportMenu` calls it and encodes as today, byte for byte the same output, and the new `exportProof` calls it and then draws the proof on an offscreen canvas: the print canvas scaled to 1200 x 1500 (`drawImage`), and under it a **56 px band**, so nothing on the menu is covered: fill `#fbf8f3`, a 1 px `#d8d2c6` hairline at its top, and the text `PROOF · not for print · v<version>.<art_version>` in 20 px `Inter, system-ui, sans-serif`, 600, 0.08em tracking, `#6b665e`, centered. Encoded `image/jpeg` at 0.85. The result is **1200 x 1556**, a few hundred KB; the band text uses a system face so the proof adds no font wait, and the band is drawn with the 2D API, never through html2canvas.
- **Posted** as multipart `file` with `version` and `art_version`, the values rendered (section 9).
- **Stored** under `menu-proof/<proposalId>/<uuid>.jpg`, a new R2 prefix; never under `menu-print/` (the print slot's prefix, which staff downloads read) and never under `menu-art/`.
- **Frozen.** The row carries `r2_key`, `version` and `art_version`; later edits never change what the client sees. The card and the editor compare the latest proof's versions with the draft's to say when the draft moved since (section 8.7).

### 8.3 Sending (admin)

**Send to client** in the editor top bar (`EditorBanner.js:64-80`, left of Approve, `btn btn-secondary`): label Send to client, or Send again once a proof exists, Sending... while it runs. Disabled on the same facts as Approve (`menuCardState.js:193-199`: no draft, drafting, approving, a failed layout drawing, Too long) and while a send runs; Approve is disabled while a send runs. It is not disabled by a client answer, an open change request, or a print state: a proof can go out before, after or instead of a print approval.

1. **Confirm** (v1's dialog): "Send to the client?" / "Emails them a proof of the draft as it is now, with a link to say it looks great or ask for changes. Edits you make after this won't change what they see." / **Send** (primary). With no email on file the text ends "No email is on file for this client, so no email goes out; copy the link from the card and send it yourself." and the button reads **Create link**.
2. **The hook** `useSendProof`, a sibling of `useApproveMenu` (`exportMenu.js:180-265`) with its own snapshot and hidden instance (only one of the two renders at a time, since each disables the other): flush, snapshot, export the proof, POST `/api/proposals/:id/menu-draft/proof` with `file`, `version`, `art_version`. On 200 it refetches the draft (the card and the top bar read the new proof). On 409 `MENU_DRAFT_CHANGED` it refetches and says "The draft changed. Send again." An export failure goes to client Sentry (`tags: { area: 'menu-designer', step: 'proof-export' }`).
3. **The route** (section 9): file checks, R2 upload with no transaction open, then one transaction on one client: the draft row `FOR UPDATE`; 409 `MENU_DRAFT_CHANGED` when `version` or `art_version` moved; `requireWords`; every layout piece done (`layoutPieceKeys`, moved from `menuDraftApprove.js:131-139` into `menuDraftShared.js` so both routes share it); the proposal's `client_id` and `status` (an archived proposal is refused, 409 `MENU_PROOF_ARCHIVED`, since its page would 404); the send cap (below); `UPDATE menu_proofs SET superseded_at = NOW() WHERE draft_id = $1 AND superseded_at IS NULL`; INSERT the new row with `email_status` `no_address` when the client has no email, else `sent` provisionally; the activity row `menu_proof_sent` (`actor_type 'admin'`, `actor_id`, details `{ proof_id, draft_id, version, art_version, emailed: boolean }`); COMMIT; release.
4. **The email**, after release, outside any transaction (CLAUDE.md, one pooled connection): `sendEmail` with the template below to the live `clients.email`; then one bare `pool.query` setting `email_status` (`sent`, `skipped` on `dev-skipped`, `failed` on a throw) and `sent_to`. A failed send is reported to Sentry and never fails the request: the proof exists and the link is copyable, which is the point of the copy affordance.
5. **Response:** `{ proof }` shaped as the GET's `proof` block (section 9), so the editor can show "Sent" and the copy link at once.

**Send cap:** at most 5 sends per proposal per rolling 24 hours, counted from `menu_proofs.sent_at` inside the transaction, 429 `MENU_PROOF_SEND_CAP` "You've sent this menu 5 times today. Try again tomorrow." A constant in the route, not an env var: the route is admin-only behind `adminWriteLimiter` (10 per minute per user, `rateLimiters.js:147-154`), and the cap exists to protect the client's inbox and the Resend allowance (`RESEND_DAILY_CAP`), not to bound spend.

### 8.4 The email

`menuProofReady({ clientName, eventTypeLabel, proofUrl })` in `server/utils/lifecycleEmailTemplates.js` (the `shoppingListReady` shape, `:259-274`; `wrapEmail`, `esc`, `firstNameOf`, `ctaButton`), `proofUrl` from a new `menuProofUrl(token)` in `server/utils/urls.js` beside `proposalUrl` (`:23-25`): `${PUBLIC_SITE_URL}/menu-proof/${encodeURIComponent(token)}`. Sent from the default `FROM_EMAIL` with the default Reply-To (`email.js:10, 70`), `meta: { kind: 'menu_proof', proposalId }`. The email carries no event date, venue, or amounts; the client's first name only, from `clients.name` (names come from the source, never derived).

- **Subject:** "Your bar menu is ready for a look"
- **Body:** "Hi <first name>," / "Here's a first look at the custom bar menu for your <event type label>. Open it, and let us know if it looks great or if you'd like any changes." / button **Review the menu** / "The link works for 30 days. If you have questions, just reply to this email." / "Cheers," / "Dallas"
- **Text part:** the same lines with the URL in place of the button.

### 8.5 The client page

**Route** `/menu-proof/:token`, declared beside the other token routes in every site context (`App.js:387-397, 461-471, 524-534, 553-565`), lazy-loaded, unguarded. **Component** `client/src/pages/public/MenuProofPage.jsx` (under 300 lines) with its own `menu-proof-page` root class, the `FeedbackPage.jsx` shape (`api.get` by token, then `api.post`; `:18, 99-102`), and the `.public-error*` shell for a bad or unknown token (`index.css:7953-8006`). It fetches `GET /api/menu-proof/:token` and shows the image from `GET /api/menu-proof/:token/image` (an `<img>` whose `src` is the API URL, as the proposal page does for its assets; the route sets `Cache-Control: private, no-cache`).

**States**, from the GET's `state`:
- **`open`:** the heading "Your bar menu", the line "Here's the menu we drafted for your event. Tap the menu to see it larger.", the proof (full width, tap opens it in a new tab), then **Looks great** (primary) and **Request changes** (secondary), which reveals one textarea ("Tell us what you'd like changed", at most 1,000 characters, a live counter) and **Send changes**. A note under the buttons: "Replying here doesn't change your booking. We'll take it from here."
- **`approved`** (after Looks great, or on a reopen): "Thanks! We've got it." / "You said this looks great on <date>. We'll get it printed for your event." with the proof still shown and no buttons.
- **`changes`:** "Thanks! We've got your notes." / "We'll make the changes and send you a fresh look. Reply to our email if you think of anything else." with the proof and the note the client wrote, read-only.
- **`superseded`:** "A newer version was sent." / "Check your email for the latest link." No image, no buttons.
- **`expired`:** "This link has expired." / "Reply to our email and we'll send a fresh one." No image, no buttons.
- **Unknown token, archived proposal, or a draft deleted since:** the `.public-error` shell, "We couldn't find that menu." with the mailto link the invoice page uses.
- **A failed post:** an inline `role="alert"` line "That didn't go through. Please try again." A 409 `MENU_PROOF_ANSWERED` or `MENU_PROOF_SUPERSEDED` re-fetches and shows the state the server now reports.

**No PII beyond the menu.** The page shows no client name, no email, no event date, no venue and no amounts; the proof itself shows what the menu shows (drink names, the title, and the client's own logo when its role is logo). The token is the only key.

**Token life:** 30 days from `sent_at` (the voicemail listen link precedent, `voicemailListen.js:48`), enforced in the route's SQL. One answer per proof. A newer send supersedes the older link at once. There is no revoke action; a proof that must die is superseded by sending again, or expires.

### 8.6 The Inbox, the activity log, and quiet closing

- **Activity log** (`proposal_activity_log`): `menu_proof_sent` (8.3); `menu_proof_approved` (`actor_type 'client'`, no `actor_id`, details `{ proof_id, version, art_version }`); `menu_proof_changes` (`actor_type 'client'`, details `{ proof_id, version, art_version, note_length }`, never the note itself: the note lives on the proof row and the event page's Activity list prints `details` raw). Each client row is written inside the answer route's transaction.
- **Inbox: a change request is an inbound event; nothing is stored in the Inbox.** A new reader `server/utils/inbox/readMenuProofs.js` (the `readProposalSends.js` shape, `:9-26`) selects proofs with `answer = 'changes'` and `answered_at >= $1` joined to `proposals.client_id`, and maps each to `{ ref: 'mp:<proof_id>', personKey: 'c-<client_id>', channel: 'email', line: null, direction: 'in', at: answered_at, author: null, kind: 'menu_changes', text: <the note>, meta: { source: 'menu_proof', id, proposalId } }`. It also emits the send as an outbound event: proofs with `email_status = 'sent'` map to `{ ref: 'mp-sent:<id>', direction: 'out', at: sent_at, author: sent_by, kind: 'menu_proof_sent', text: null, meta: { source: 'menu_proof_sent', ... } }`. Wiring, each a one-line addition in the files the Inbox already routes by kind and source: the reader's SQL and map in `engine.js:321-347`; `menu_changes` in `isCountedInbound` and `aiCannotClose` (`classify.js:29-40`, the `tt_missed` treatment: the AI never reads or closes it, and the person waits until a human acts); `menu_proof_sent` in `countsAsReply` by `meta.source` (`:44-77`), so **sending a new proof closes the item** the way a sent proposal does; `eventNeedText` / `sliceText` (`:109-117, 136-145`) and the thread line (`thread.js:46-82`): "Asked for menu changes" over the note, with a link to `/events/<id>?menu=1`. The Inbox's own Done and snooze taps work as for any person (`actions.js:53-59`). **Approving for print does not close the Inbox item** (the client still has no answer; Dallas taps Done or sends again). The email channel is a label: the Inbox's reply rules pick the line for a `c-` person as they do today; this spec changes none of them.
- **Looks great** writes the activity row and the proof row and emits **no** Inbox event, by decision 5.
- **The AI read** never sees a `menu_changes` event as a subject (`subjects.js:37-41, 89-92` read only `message` and `media`), which is the intended behavior: the note is for Dallas, not for the summarizer.
- **Amendment to the Inbox spec** (`2026-10-06-inbox-design.md`, decision 2 and the out-of-scope line): "change requests" there means the proposal change-request flow, which stays on the Needs-attention card (`queueItems.js:144-157`); a menu proof change request is the one non-correspondence item, by Dallas's 2026-10-19 call. The lane adds that sentence to the Inbox spec's decision 2.

### 8.7 The card and the editor

**GET payload.** `proof: null | { id, url, sent_at, email_status, expires_at, expired, answer, answer_note, answered_at, stale }`, the latest proof; `url` is the public link (admin-only payload, so it may carry it; the card's Copy link reads it); `stale` is true when `version` or `art_version` differs from the draft's current pair.

**Fold row "Client review"** (third row, after Client image; v1 11.1 Fold vocabulary): the value reads "Not sent yet"; "Sent <date>" (plus " · no email on file" for `no_address`, " · email failed" for `failed`, " · link expired" when `expired`); "Looks great, <date>"; "Changes requested <date>". Actions: **Copy link** (`btn btn-ghost btn-sm`, when a proof exists and is not expired; `navigator.clipboard.writeText(proof.url)`, the label reads "Copied" for 2 s; on failure a `role="alert"` line "Couldn't copy. Open the editor to send again."), and a `KebabMenu` with **Send to client** / **Send again** (opens the editor with the intent `{ send: true }`, which opens the Send confirm once the draft is loaded; the editor owns the full-size layers and the hidden canvas, the card has only `?w=240` layers) and **Read the client's notes** (opens the editor; shown when `answer === 'changes'`). Below 900 px the row keeps Copy link and drops the kebab (v1 10.1, Narrow windows).

**Table C, amended precedence:** Loading; Couldn't load; Approving; Save failed; Generating; Words failed; Drawing failed; Plan changed; Notes edited; **Client asked for changes**; the print states (No menu needed; Replaced by upload; Print file removed; Edited since approval; Approved); **Client approved**; **Sent to client**; Draft ready; then the no-draft states. "Client saw an older version" is the `stale` variant of Client approved and Client asked for changes and keeps its base state's slot. A client state shows only while the latest proof is not expired, except Client asked for changes, which shows until it is cleared: it clears when a newer proof is sent, or when the print was approved after the answer (`approved_at > answered_at`; Dallas decided to print anyway). Client approved likewise clears once the print approval is later than the answer (the print state then says what matters).

| State | Chip | Message | Sub | Actions |
|---|---|---|---|---|
| Client asked for changes | warn, Changes requested | The client asked for changes. | the first 90 characters of the note, then "..."; with `stale`: "They saw the version sent <date>; the draft changed since." | Read notes (opens the editor, Brief tab); ghost View |
| Client approved | ok, Client approved | The client says it looks great. | Approved by the client <date>. Approve for print when you're ready. · with `stale`: "They saw the version sent <date>; the draft changed since." | Review & approve; ghost View |
| Sent to client | info, Sent to client | Proof sent to the client <date>. | Waiting on their answer. (· no email on file: "No email on file; copy the link and send it yourself." · `stale`: "The draft changed since; send again if it matters.") | View; ghost Copy link |

**Table B, new banners** (the editor, same tones): Client asked for changes: title "The client asked for changes.", text: the full note (wrapping) and, when `stale`, "They saw the version sent <date>."; buttons: secondary **Send again** (runs the send flow). Client approved: ok, "The client says it looks great.", "<date>. Approve for print when you're ready."; no buttons. Sent to client: info, "Proof sent <date>.", "Waiting on the client's answer. Edits here don't change what they see."; no buttons. The three sit after Notes edited and before the print banners, and stack with them (v1 11.1, Banner).

**Brief tab** gains a compact **Client review** section at its end: the latest proof's value line (as the fold row) and, for a change request, the note in full, read-only.

### 8.8 Security

- **Token guard:** `requireUuidToken('token', "We couldn't find that menu.")` on all three public routes (`tokens.js:22-27`); the SQL also requires `superseded_at`, `expires_at` and the proposal's status, so a guessed token answers a 404 and a valid one only its own state.
- **Limiters** (`rateLimiters.js`, sensitive-listed): the two GETs run `publicTokenIpLimiter` (300 per 15 min per IP, `:98-113`) then a new token-keyed `menuProofReadLimiter` (60 per 15 min per token, the `proposalCheckoutLimiter` shape `:78-85`); the POST runs `publicLimiter` (20 per 15 min per IP, `:3-9`) then a new `menuProofAnswerLimiter` keyed `ip:token`, 5 per hour (the `publicFeedback.js:18-25` shape). One answer per proof is enforced in SQL (`UPDATE ... WHERE token = $1 AND answer IS NULL AND superseded_at IS NULL AND expires_at > NOW()` with a rowCount guard; 0 rows re-reads the row to answer 409 `MENU_PROOF_ANSWERED` or `MENU_PROOF_SUPERSEDED`, or 404).
- **The proof bytes** are served only through `sendR2Object(res, row.r2_key, { prefix: 'menu-proof/<proposal_id>/' })` with the prefix built from the row's own `proposal_id` (`r2Proxy.js:58-65, 141-144`), never from input, so no other object (a W-9, another event's art or print file) can be reached through this route. The admin never streams the proof; the card shows the draft thumbnail as today.
- **The posted proof:** `isValidUpload` and `safeUploadExtension === '.jpg'` (JPEG magic bytes only), `sharp` metadata exactly 1200 x 1556, then the bounded full decode with `failOn: 'warning'` and `limitInputPixels` at the proof size (the Approve checks, `menuDraftApprove.js:103-129`), and at most 3 MB (400 `file` "The proof must be 3 MB or smaller."). The declared name and type are never trusted.
- **The note:** a string, trimmed, 1 to 1,000 characters for Request changes, absent for Looks great; stored as text and rendered as plain React text everywhere (never HTML), in the Inbox thread, the banner, the Brief tab and the public page.
- **Caps:** the send cap (8.3); the Resend quota error (`QuotaExceededError`, `email.js:91`) marks the proof `failed` like any throw.
- **Cross-site:** the public GET answers no admin data: no proposal id, no client id, no draft content, only `{ state, answered_at, answer, answer_note, image: true }`. CORS is the public site's as for every token page.

### 8.9 The privacy page

No change. The proof is stored on Cloudflare R2 and emailed through Resend, both already named (`PrivacyPage.js:120, 125`), and `:97-103` already says we email about the event; the page is shown to the client whose data it is, and nothing new goes to a third party. The OpenAI / Gemini line (`:123`) describes generation and is untouched: the client's note is never sent to a provider.

## 9. API

Admin routes keep v1 section 7's guard (`auth`, `requireAdminOrManager`, `asyncHandler`, `parseId`, 404 on no proposal or no draft). Public routes carry no auth.

| Method and path | File | Limiter | Does |
|---|---|---|---|
| `GET /api/proposals/:id/menu-draft` | `menuDrafts.js:97-99` (read model `menuDraftRead.js`) | `menuDraftReadLimiter` | Adds `plan.side`, `plan.planner_reference` (7.1), `proof` (8.7); `draft.inputs.admin_brief` and `content.mark_position`, `content.font_pairing_suggested` ride in their columns |
| `PATCH /api/proposals/:id/menu-draft` | `menuDrafts.js:158-184` | `menuDraftEditLimiter` | Accepts `content.mark_position` and `inputs.admin_brief` (section 10); refuses `font_pairing_suggested` |
| `POST /api/proposals/:id/menu-draft/generate` | `menuDrafts.js:101` | `adminWriteLimiter` | Takes `admin_brief_theme`, `admin_brief_naming`, `admin_brief_notes` (7.2) |
| `POST /api/proposals/:id/menu-draft/proof` | new `server/routes/proposals/menuDraftProof.js`, mounted after `menuDraftApprove` in `proposals/index.js:25-27` | `adminWriteLimiter` | Multipart `file`, `version`, `art_version` (8.3). 400 field errors; 404; 409 `MENU_DRAFT_CHANGED`, `MENU_WORDS_PENDING`, `MENU_WORDS_NOT_WRITTEN`, `MENU_PROOF_ARCHIVED`; 429 `MENU_PROOF_SEND_CAP`. 200 `{ proof }` |
| `GET /api/menu-proof/:token` | new `server/routes/menuProof.js`, mounted in `server/index.js` beside `/api/public/feedback` | `requireUuidToken`, `publicTokenIpLimiter`, `menuProofReadLimiter` | `{ state: 'open' \| 'approved' \| 'changes' \| 'superseded' \| 'expired', answer, answer_note, answered_at }`. 404 for an unknown token, an archived proposal, or a cascaded draft |
| `GET /api/menu-proof/:token/image` | same | same | Streams the proof through `sendR2Object` with the row's prefix (8.8); 404 unless the state is `open`, `approved` or `changes` |
| `POST /api/menu-proof/:token/answer` | same | `requireUuidToken`, `publicLimiter`, `menuProofAnswerLimiter` | Body `{ answer: 'approved' \| 'changes', note? }`. One transaction: the conditional UPDATE, the activity row; COMMIT. 200 `{ state, answered_at }`; 409 `MENU_PROOF_ANSWERED` / `MENU_PROOF_SUPERSEDED`; 404 |

Error bodies keep the global handler's `{ error, code, fieldErrors? }`. Key on codes, never messages.

## 10. Validation (extends v1 section 7.1)

| Field | Rule |
|---|---|
| `mark_position` | `left`, `center` or `right`; content; missing reads as `right` |
| `font_pairing` | one of the twelve ids (section 6), server and client in sync |
| `font_pairing_suggested` | words-step output only; never accepted from PATCH |
| `admin_brief` (inputs) | an object with only `theme`, `naming`, `notes`; each a string, trimmed, 0 to 1,000 characters; an omitted key keeps the stored value; editable before and after the words land, as every inputs key is |
| Generate `admin_brief_*` | three multipart strings, the same bounds; absent means the stored value, else empty |
| proof `version`, `art_version` | the Approve parses (`menuDraftApprove.js:81-87`) |
| proof `file` | JPEG by magic bytes, exactly 1200 x 1556, full decode, at most 3 MB |
| answer `answer` | `approved` or `changes` |
| answer `note` | required, 1 to 1,000 characters, for `changes`; must be absent or empty for `approved` |
| `planner_reference`, `plan.side`, `proof` | read-model output only; no route accepts them |

## 11. Visual contract

- **No design artifact for v2.** The admin controls follow v1's vocabulary and benchmark, `docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html` (v1 section 11): the Placement `.seg` is the Wordmark color row's twin; the twelve pairing buttons are the six's list, longer; the Admin brief fields are the Art direction `.input` three times with `.meta-k` labels; From the planner and Client review are Client brief boxes (`.md-brief-box`); the Client review fold row is a third Print file row; Send to client is a `btn btn-secondary` beside Approve; the banners and chips use table B's tones. New CSS stays under the `md-` prefix; the printed menu changes only the mark's `left` (an `mc-` rule and one inline value).
- **The client proof page** follows the existing public token pages' shell: chromeless, its own root class, the `.public-error*` states, `InvoicePage.js`'s brand header and mailto footer, the proof image at full width on a quiet ground, two buttons and one textarea in the public site's button and input styles.
- **Open recommendation for Dallas:** the proof page is the first client-facing surface the designer has, and the one a client will judge the whole thing by. It deserves a short design pass (one screen in four states, phone first) through claude.ai/design before the lane builds it, as the admin section had. If he declines, the lane builds to the shell above and `ui-ux-review` judges it against the invoice and feedback pages for consistency.

## 12. Failure modes (extends v1 section 12)

| Failure | Behavior |
|---|---|
| Client has no email on file | The proof and link are still created (`email_status no_address`); the confirm, the card and the editor say so; Copy link is the path |
| Resend throws, or the quota is reached | The proof row is kept; `email_status failed`; Sentry; the card reads "Sent <date> · email failed"; Send again is allowed within the cap |
| Notifications are off (dev) | `email_status skipped`; the proof and link exist for the walks |
| Draft moved between the render and the post | 409 `MENU_DRAFT_CHANGED`; the editor refetches and says "The draft changed. Send again." |
| A layout piece is not done, or the words are not written | 409 as Approve; the button was disabled, so this is a race only |
| Proposal archived | 409 `MENU_PROOF_ARCHIVED` on send; the public page 404s for every proof of it |
| Send cap reached | 429 `MENU_PROOF_SEND_CAP` with the message in 8.3 |
| Token unknown, malformed, expired, superseded | 404, 404, `expired`, `superseded`, each with its own page copy (8.5); nothing is written |
| Client answers twice, or answers an older link | 409 `MENU_PROOF_ANSWERED` / `MENU_PROOF_SUPERSEDED`; the page re-fetches and shows the state |
| Proof object missing in R2 | The image route 404s; the page shows "We couldn't load the menu picture. Reply to our email and we'll send it again."; the answer buttons still work |
| Draft deleted (proposal deleted) | Proofs cascade; the link 404s; the Inbox event vanishes with its row (derived) |
| The Inbox reader's SQL fails | The engine's existing per-reader error path; the other feeds still render; Sentry |
| Clipboard refused | The inline line in 8.7 |
| A pairing id the client has but the server lacks, or the reverse | Impossible by construction (section 14's sync test); a stored unknown id reads as the default pairing (`fontPairings.js:95-97`) |
| `mark_position` missing on an old draft | Reads as `right`; nothing moves |
| Admin brief edited after a print approval | Version bumps; "Edited since approval", as an art direction edit does today; the print file is unchanged until Approve again |

## 13. Configuration, docs and lists

- **Env vars:** none new. `PUBLIC_SITE_URL`, `RESEND_API_KEY`, `SEND_NOTIFICATIONS` and `ADMIN_EMAIL` already govern the link, the send and the Reply-To.
- **Schema:** `menu_proofs` (8.1), idempotent, in `schema.sql` after the menu art block; ARCHITECTURE's Database Schema section gains it.
- **README:** folder tree (`menuDraftProof.js`, `menuProof.js`, `readMenuProofs.js`, `MenuProofPage.jsx`, `exportProof.js`, `useSendProof` in `exportMenu.js` or its own file), Key Features (client proof approval), the route table.
- **ARCHITECTURE:** the two new route files and the public route, the proof table, the Inbox reader, the activity actions, `menuProofUrl`.
- **Inbox spec** `2026-10-06-inbox-design.md`: the one-sentence amendment in 8.6.
- **`scripts/sensitive-paths.txt`** gains `server/routes/menuProof.js` (a public route that streams a client-facing image and takes a client write; the `voicemailListen.js` criterion), `server/routes/proposals/menuDraftProof.js` (an external send and an R2 write), and `server/utils/inbox/readMenuProofs.js` (it decides what waits on Dallas). `lifecycleEmailTemplates.js` and `rateLimiters.js` are already listed.
- **Privacy page:** no change (8.9).

## 14. Testing (extends v1 section 14)

- **Pure:** `mark_position` validation and the canvas's computed `left` for each position with and without the Panel; `effectiveBrief` (admin wins per field when non-empty, trim, the 1,000 cut, the client's text filling blanks); the fingerprint and `computeDiff` unchanged by any `admin_brief` value (an admin brief edit never yields `brief_edited`); `font_pairing_suggested` refused by PATCH and set by `parseWords`; the pairing ids identical on both sides (`FONT_PAIRING_IDS` equals `PAIRING_IDS`, a test that imports both); `fontsHref` for all twelve ids sorts weights and names "Baloo 2" and "DM Serif Display" correctly; `menuCardState` for every new row of table C, the `stale` variants, the clearing rules (a newer proof; a print approval later than the answer) and the expiry; the proof's band geometry (1200 x 1556) in `exportProof` with html2canvas mocked.
- **Payload rule:** `wordsRequest` and `backgroundPrompt` given a normalized plan plus `planner_reference` and the admin brief send the merged brief and nothing from `planner_reference` (a fixture with distinctive note text asserted absent from the request).
- **Routes (shared dev DB, one suite at a time):** the proof route refuses non-JPEG, the wrong size, a cut file, a file over 3 MB, a moved `version` or `art_version`, missing words, a not-done layout piece, an archived proposal, and the sixth send in 24 hours; it uploads before the transaction, supersedes the previous latest, inserts the row and the activity row inside one transaction, and marks `email_status` from the `sendEmail` stub (`sent`, `skipped`, `failed` on a throw) after commit without failing the request. The public GET answers each state and 404s an unknown token, a bad UUID, an archived proposal; the image route 404s outside `open` / `approved` / `changes` and streams only a key under the row's prefix; the answer route writes once, refuses the second answer and an older link, requires a note for `changes` and caps it at 1,000, writes the client activity row with no note in `details`. The limiters are present on each route (the test asserts the middleware chain, the `publicFeedback` precedent).
- **Inbox:** `readMenuProofs` maps a change request to a counted inbound the AI cannot close and a send to a reply by source; `rules.computeInbox` shows the person waiting after a change request and closed after a later send or Done; `subjects.buildSubjects` never picks a `menu_changes` event; the existing Inbox suites (`rules.*.test.js`, `engine.test.js`, `readers.test.js`, `subjects.test.js`) stay green.
- **Client:** the Design tab's Placement picker and the Suggested tag; the Brief tab's admin fields save through the hook (debounced, inputs) and hold pre-draft; From the planner renders names, bar labels, both notes and the consult hint; the fold row's Copy link and kebab; the editor's Send to client gate, confirm, the no-email variant, and the 409 path; `MenuProofPage` in every state with a mocked `api`; `exportMenu` still produces 2400 x 3000 at 0.92 (unchanged by the factoring).
- **Existing suites the change reaches stay green:** every v1 suite named in its section 14, `menuDraftApprove.test.js` (the moved `layoutPieceKeys`), `menuDraftValidation.test.js`, `fontPairings.test.js`, `DesignTab.test.js`, `BriefTab.test.js`, `MenuCardFold.test.js`, `menuCardState.test.js`, `exportMenu.test.js`, `useMenuDraft.test.js`, `App` route tests if any, `lifecycleEmailTemplates` tests, and `PrivacyPage.test.js` (unchanged by design).
- **Visual:** `ui-ux-review` on the Design and Brief tabs against `Menu Designer v2.dc.html` (both skins), and on the proof page against the invoice and feedback pages (and against the design artifact if Dallas takes the pass in section 11), on a phone width first.
- **Live walk on dev:** generate on a dev proposal with a client email set to a mailbox Dallas owns, `SEND_NOTIFICATIONS=true` for that server only; send, open the email on a phone, tap Request changes, see the item in the Inbox and on the card; send again, see the old link say "A newer version was sent" and the Inbox item close; tap Looks great on the new one; approve for print and confirm the client's answer never blocked it. Then the pairing sweep: approve once in each of the six new pairings and check the faces in the print file.

## 15. Review level

- **Client-approval lane (schema, the send route, the public routes, the email template, the Inbox reader, `rateLimiters.js`): full fleet**, plus `/second-opinion` at push (the cross-LLM rule): a public route, a client write, an external send and sensitive-listed files.
- **Mark, fonts, planner data and admin brief lanes:** one reviewer each plus the suites the change reaches; the admin brief lane adds the payload-rule test above and a reviewer pass over the four provider seams, since it changes what leaves the OS. The font lane runs `ui-ux-review` on the twelve-button tab.

## 16. Rollout

1. Lanes in Dallas's order: mark placement, fonts (after he confirms section 6), planner data and admin brief together (both are the Brief tab), then client approval. The first three are independent of the fourth and can merge first; the fourth is the full-fleet lane.
2. The client-approval lane ships dark in effect: nothing sends until Dallas clicks Send to client, and `SEND_NOTIFICATIONS` already gates dev. No env var needs setting in Render.
3. First real use: one upcoming custom event, the proof sent to the client, Dallas watching the Inbox for the answer.
4. The phone lane (v1 decision 13) picks up the new card states from `menuCardState.js` when it is cut; the fold row and Send to client stay desktop until then.

## 17. Copy (every new client-facing string; ids only, no em dashes)

- **Email:** subject "Your bar menu is ready for a look"; "Hi <first name>,"; "Here's a first look at the custom bar menu for your <event type label>. Open it, and let us know if it looks great or if you'd like any changes."; button "Review the menu"; "The link works for 30 days. If you have questions, just reply to this email."; "Cheers," / "Dallas".
- **Page, open:** "Your bar menu"; "Here's the menu we drafted for your event. Tap the menu to see it larger."; "Looks great"; "Request changes"; "Tell us what you'd like changed"; "Send changes"; "Replying here doesn't change your booking. We'll take it from here."
- **Page, approved:** "Thanks! We've got it."; "You said this looks great on <date>. We'll get it printed for your event."
- **Page, changes:** "Thanks! We've got your notes."; "We'll make the changes and send you a fresh look. Reply to our email if you think of anything else."
- **Page, superseded:** "A newer version was sent."; "Check your email for the latest link."
- **Page, expired:** "This link has expired."; "Reply to our email and we'll send a fresh one."
- **Page, errors:** "We couldn't find that menu."; "That didn't go through. Please try again."; "We couldn't load the menu picture. Reply to our email and we'll send it again."
- **Proof band:** "PROOF · not for print · v<version>.<art_version>".
- **Admin strings** are in sections 5 to 8 (the Placement labels, the Suggested tag, the admin brief placeholders and hint, the planner hints, the confirm, the fold row values, table C and table B rows, the error sentences).
