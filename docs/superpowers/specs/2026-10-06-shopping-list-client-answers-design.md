# Client's Answers Beside the Shopping List: Design

**Date:** 2026-10-06. **Status:** designed in chat with Dallas, each decision approved as it was made (bounded brainstorm). He asked for the spec and plan to be reviewed before any build. **Rev 2 (2026-10-06):** folds in the design fleet (spec-grounding, spec-gaps, spec-risk, plan-fidelity, plan-decomposition): the name lookup fails soft on every path, the panel reads the admin catalogs, the width moves into classes, the planner set is defined by its drink answers, the staff payload keeps the raw key for one release, and the docs are scheduled.

**As built:** both lanes merged 2026-10-06 (`7d9a8d38`, `fb9bae0b`); the deltas from this spec that review produced are recorded in the plan's "As built" section.

**Amended 2026-10-06 (Dallas, after the build):** the consult notes are team-only. Decision 6 no longer holds word for word: the recap email drops the Notes line, while the staff Consult card and the answers panel keep it (`consultRecapLines` prints notes only when a team surface passes `includeNotes: true`), so a notes-only consult emails the placeholder. The client's public shopping-list JSON no longer serves the list's `notes` key either.

**Ledger entries this closes** (`docs/fix-list-remaining-2026-07-02.md`):
- Potions, "Planner answers beside the shopping list" (Dallas's 2026-09-22 drop, item 8).
- Section 4, "The staff brief's consult card prints a custom drink as `[object Object]`".
- Section 2, "The post-consult recap email lists drinks by their catalog slug".

**Not in scope, filed for Dallas** (same review): section 4, "The staff brief shows an unsubmitted planner draft's drinks as the event's menu".

## 1. Problem

Dallas, 2026-09-22: *"I want to see the answers from the potion planner on the shopping list. I often click back and forth."*

The admin shopping list is a portal modal (`client/src/components/ShoppingList/ShoppingListModal.jsx`) opened by `ShoppingListButton.jsx` from three pages: `/drink-plans/:id` (`DrinkPlanDetail.js`), and `/events/:id` and `/proposals/:id` (both through `DrinkPlanCard.js`). The planner answers render in exactly one place, the Selections card on `/drink-plans/:id` (`DrinkPlanSelections.js`, mounted at `DrinkPlanDetail.js:322`), which the modal covers. The event and proposal pages show no answers at all.

Consult answers (`drink_plans.consult_selections`) have three renderings today and two are broken:
- The staff event page's Consult card (`ConsultCard`, `client/src/components/staff/BeoSections.js:453`) prints the raw JSON: camelCase keys as labels, and every custom drink (stored as `{ name, ingredients }`) as `[object Object]`. The staff brief's cocktail card reads only the planner's `selections` (`ShiftDetail.js:316`), so on a consult-fed plan this card is where a bartender reads the consult's drinks.
- The post-consult recap email (`formatConsultRecap`, `server/utils/consultRecap.js:34`) joins the stored catalog ids straight into the client's email ("Signature cocktails: french-75, old-fashioned"). Its suite passes on a fixture of display names, a shape the form never writes.
- The consult form itself (`ConsultationForm.jsx`) is an editor, not a recap.

**Prod facts (read-only, production branch, 2026-10-06):** 23 plans carry consult answers and every one of them fed its list (`shopping_list_source = 'consult'`). 14 of the 23 hold a custom drink. 2 upcoming live bookings carry a consult custom drink. 11 plans hold both planner and consult answers, and on all 11 the planner was never submitted (`submitted_at IS NULL`). 9 consult recap emails have been sent (2026-07-19 to 2026-10-05), 6 of them to clients whose consult held picked cocktails, none edited before sending. Consult drink ids are catalog slugs (`cocktails.id` and `mocktails.id` are `VARCHAR(100)`, e.g. `french-75`).

## 2. Decisions (Dallas, 2026-10-06)

1. **Where.** The admin shopping-list modal gets a "Client's answers" panel. It works the same from all three pages that open the modal.
2. **What.** Only the answers that drive the list. Planner: the package line (bar style), signature cocktails with custom requests, mocktails with mocktail notes, spirits, beer, wine, the mixer flags, syrups DRB supplies vs. syrups the client brings, add-ons, drinkers and crowd profile, guest preferences, and "Anything else". Left out: menu design and every logistics answer (day-of contact, parking, equipment, event notes, bar placement, power at the bar, ice).
3. **Which set: the newest.** The consult counts from its last save (`consult_filled_at`, stamped `NOW()` on every save, `drinkPlanConsult.js:250,261`). The planner counts from its submit. A planner the client started but never submitted does not beat a consult. With only one set, show it (a planner draft is labeled "not submitted"). With neither, an empty state.
4. **A switch when both exist.** The panel header carries a two-way switch, each side labeled with its date or "not submitted" ("Consult · Oct 2", "Planner · not submitted"). The panel opens on the newest set every time; a flip is not remembered, because a remembered choice could hide answers that arrive later. The switch only changes what the panel shows. It never rebuilds the list. Rebuilding stays on the plan page's existing source switch (`PATCH /api/drink-plans/:id/shopping-list-source`), which discards edits and resets the list to review.
5. **List note.** Whenever the panel shows a set the list was not built from, one line says which one was: "This list was built from the consult." or "This list was built from the planner." When the list was built from a set that holds no drink answers (a consult saved empty, a planner with nothing that drives the list), the line says that instead: "This list was built from a consult with no drink answers." or "This list was built from a planner with no drink answers." No note when `shopping_list_source` is null.
6. **One consult recap everywhere.** The server recap resolves catalog ids to drink names and gains a Mixers line. The recap email, the staff Consult card and the new panel all read it. Client-facing consequence: the recap email shows real drink names and, for a full bar or signature-cocktail bar, a Mixers line.
7. **Layout.** On a wide screen the panel sits to the right of the list and stays in view while the list scrolls; the modal widens to make room. On a narrow screen it stacks above the list. A "Show answers" / "Hide answers" button in the modal header shows and hides it, and the choice is remembered per browser. It shows in the Editor, in Client view, and in the read-only finalized view.

## 3. Design

### 3.1 Server: one consult recap

`server/utils/consultRecap.js`:
- `consultRecapLines(consult, names = {})` builds the lines and returns `[]` for a consult with nothing to say. `formatConsultRecap(consult = {}, names = {})` returns those lines or, when empty, today's placeholder ("(no specific selections captured; notes are on file)"), so the email is unchanged in that case. Both are pure.
- `names` is `{ cocktails: Map<id, name>, mocktails: Map<id, name> }` (Maps, so a lookup never touches an object's prototype and never trips `security/detect-object-injection`). `signatureDrinks` resolve through `names.cocktails`, `mocktails` through `names.mocktails`; an id with no entry renders through `humanizeDrinkId(id)` (split on `-`, `_` and spaces, capitalise each word: `french-75` becomes `French 75`). An entry that is not a string or a number is skipped, never stringified. Omitting `names` keeps today's call shape working and every id humanizes.
- New Mixers line, only when `barType` is `full_bar` or `sig_beer_wine` and `mixers` is a known mode, placed after the wine line: `full` reads "Mixers: Full set", `matching` reads "Mixers: Only those that match your spirits", `none` reads "Mixers: None beyond your signature cocktail ingredients" (the form's own definition of `none`, `ConsultationForm.jsx:34`: signature drink ingredients still go on the list, so a bare "None" would contradict the list the client then receives). The form forces `none` on beer-and-wine and mocktail-only bars (`ConsultationForm.jsx:102,137`), so those bars never print it.
- New `async loadConsultDrinkNames(consult, db)`: collects the string ids present, runs `SELECT id, name FROM cocktails WHERE id = ANY($1::text[])` and the same against `mocktails`, and returns the `names` shape. It looks up by id whatever `is_active` says, so a drink retired after the client picked it still reads by name. Skips a table with no ids (no query at all for a consult with none). `db` is the caller's handle (the pool, or a client the caller already holds, per the one-connection rule). **It never throws:** a failed query is logged and reported to Sentry the way `reportCatalogIssue` does (`server/utils/shoppingListGen.js:31-38`) and returns empty Maps, so every caller degrades to humanized names instead of failing.
- New `unmatchedDrinkIds(consult, names)`: the picked ids the lookup did not name, for a warning log on the email path, so catalog drift shows up instead of being silently humanized into a client email.
- New `async buildConsultRecap(consult, db)`: `null` for a missing, non-object, array or empty consult, and `null` when `consultRecapLines` comes back empty (so the staff card and the panel hide rather than print the email's placeholder); otherwise the lines with names resolved. It never throws (its loader never throws and the formatter is pure).
- Exported alongside the existing two: `consultRecapLines`, `humanizeDrinkId`, `loadConsultDrinkNames`, `unmatchedDrinkIds`, `buildConsultRecap`.

Three readers:
- **Recap email** (`server/utils/comms/actions/consultRecap.js`): `defaultParts(row, names)` (`:116`, call at `:134`) passes `names` to the formatter. The names load in `buildMessages` (`:141`) and in `dispatch` (`:175`, `defaults` at `:178`), not in `load()`, so `resolveRecipient` (`:112`), which never prints a drink, runs no extra query. A failed lookup degrades to humanized names, so the one-shot automatic first-save send (`drinkPlanConsult.js:300-321`, which no later save repeats) is never lost to it. `dispatch` logs a warning naming the plan id and any unmatched ids. `body_edited`: the draft and the send each run their own lookup moments apart, so they agree unless the catalog renames a drink in between or the lookup fails on one side only; either marks an unedited send as edited. That touches only the ledger flag and is accepted.
- **Consult GET** (`server/routes/drinkPlanConsult.js:159`): the response gains `recap: await buildConsultRecap(consult_selections, pool)`, the lines or `null`. Existing fields unchanged, and because the recap cannot throw, the raw blob the consult form pre-populates from (`ConsultationForm.jsx:76`) always comes back.
- **Staff payload** (`server/utils/eventDetailsPayload.js`): the drink-plan read (`dpRowP`, `:87`) chains `buildConsultRecap(row.consult_selections, pool)` onto its own promise and stores the result on the row, so the name lookup overlaps the other five reads inside the existing `Promise.all` barrier instead of adding a round trip to the staff portal's hottest read. A proposal with no plan has no row, so no lookup; the lookup cannot reject the barrier. The payload's `drink_plan` gains `consult_recap` (lines or null). **For one release it keeps `consult_selections` beside it**, so a staff tab opened before the deploy keeps today's card until it reloads (`client/public/staff-sw.js` caches no fetches; only open tabs run an old bundle). Dropping the raw key is a follow-up on the ledger. Both routes built on this payload (`GET /api/shifts/:shiftId/event-details`, `GET /api/beo/:proposalId`) change together; the staff `ShiftDetail.js` is the only client reader of the raw blob.

`eventDetailsPayload.js` and `drinkPlanConsult.js` are not on the sensitive list, but they ride in the same lane as the comms action, which is, so the lane's full fleet covers them and the push-time sensitive re-review (run on the whole squash commit that touches a sensitive path) covers them again.

### 3.2 Staff Consult card

`ConsultCard({ lines })` renders each line as one row in the card it has today, the text before the first ": " in bold (the old card bolded its keys), and returns null for a missing or empty array. `ShiftDetail.js:689` passes `drinkPlan?.consult_recap`; the `consultSelections` local (`:192`) goes. Deploy order: an old client against the new server keeps today's raw card (both keys are sent); a new client against an old server hides the card until Render finishes deploying. Neither renders garbage.

### 3.3 Admin panel

`client/src/components/ShoppingList/answerSets.js`, pure:
- `hasPlannerAnswers(selections)` is true only when a key that drives the list holds a value: `signatureDrinks`, `customCocktails`, `mocktails`, `mocktailNotes`, `spirits`, `spiritsOther`, `beerFromFullBar`, `wineFromFullBar`, `wineOtherFullBar`, `beerWineBalanceFullBar`, `beerFromBeerWine`, `wineFromBeerWine`, `wineOtherBeerWine`, `beerWineBalanceBeerWine`, `syrupSelections`, `syrupSelfProvided`, `addOns`, `crowd`, `guestPreferences`, `additionalNotes`, and the legacy v1 keys `signatureCocktails`, `barFocus`, `wineStyles`, `beerStyles`, `beerWineBalance`, `beerWineNotes`, `fullBarNotes`. A value is a non-empty array, a non-blank string, or an object with at least one non-empty value. A planner holding only a logo (`companyLogo`, `_logoFilename`, merged in by the upload, `drinkPlans.js:161-164`), menu-design answers or logistics answers is no set.
- `pickAnswerSets(plan, hasConsult)` returns `{ sets, initial }`. `sets` lists the sets that exist, in the order Consult, Planner, each `{ key, at, submitted }`. A consult set exists when `hasConsult`, which the panel sets only when the consult GET returned non-empty `recap` lines. The planner counts as submitted when `submitted_at` is set or its status is `submitted` or `reviewed` (a submitted plan with no stamp then reads "submitted" with no date). `initial` applies decision 3: the planner opens first only when both stamps are known and the planner's is strictly later; a tie, an unsubmitted planner, or a missing stamp on either side goes to the consult.
- Copy helpers: `sourceLine(set)` ("From the consult, Oct 2", "From the planner, submitted Sep 25", "From the planner, not submitted", and "From the consult" / "From the planner, submitted" when the stamp is missing); `switchLabel(set)` ("Consult · Oct 2", "Planner · Sep 25", "Planner · not submitted", "Consult", "Planner · submitted"); `listNote(shownKey, listSource, offeredKeys)` (decision 5). Dates are the Chicago day via `fmtDate(ctDay(ts))`, the short form of what `DrinkPlanDetail.js` does with `fmtDateFull`, to fit a 300px panel.

`client/src/components/ShoppingList/ClientAnswersPanel.jsx`, props `{ planId }`:
- Loads in parallel `GET /drink-plans/:id`, `GET /cocktails/admin` and `GET /mocktails/admin`, then `GET /drink-plans/:id/consult` when `has_consult_selections`. The admin catalogs (`server/routes/cocktails.js:38`, `mocktails.js:35`: every drink, retired ones included, behind `auth` + `requireAdminOrManager`) keep the panel off the public read limiter (one 100-per-15-minutes-per-IP budget shared by 13 public route files) and let the planner view name a retired pick exactly as the consult view does.
- Any failure is the error state ("Couldn't load the client's answers." with Retry). It is all or nothing on purpose: the planner view filters picks against the catalogs, so a missing catalog would silently drop the client's drinks, and one error state is simpler than a half-loaded panel. A consult GET that answers without a `recap` key (a server older than this change, during a deploy or after a lone revert of the server lane) is the same error state, never "no answers".
- Loading state "Loading answers…" while in flight. Empty state "No planner or consult answers yet." when `sets` is empty, with the list note beneath it when the list was built from a set with no answers.
- Header: "Client's answers", the switch when two sets exist, the source line, and the list note. Planner view: `<DrinkPlanSelections plan={plan} cocktails={…} mocktails={…} listOnly />`. Consult view: the `recap` lines.
- "Hide answers" unmounts the panel, so nothing loads while it is hidden and each "Show answers" (and each modal open) loads fresh.

`DrinkPlanSelections.js` gains `listOnly` (default false, so the plan page is unchanged). With it on: the Menu Design block (`:129-153`) and the Logistics block (`:159-202`) do not render; drinkers and crowd profile (`:188`) and guest preferences (`:194`), which live inside Logistics today, render on their own, each line carrying its own label ("Crowd: …", "Guest preferences: …"); the legacy view drops `logisticsNotes` (`:293`).

### 3.4 Modal layout

`ShoppingListModal.jsx` is 930 lines against the 1000-line hard cap, so the panel lives in its own file and the modal takes only an import, the header button ("Show answers" / "Hide answers", `aria-pressed`) with its remembered state, the width class, and a layout wrapper around the body (target under 40 added lines). The storage helpers (`readAnswersOpen`, `writeAnswersOpen`) live in the panel's file.
- **Width moves into classes.** The container's inline `maxWidth: 960` (`:507`) becomes the class `sl-modal-box` (960px). With the panel open at 1200px and up, `sl-modal-box--answers` widens it to `min(1280px, calc(100vw - 2rem))`, so it never runs edge to edge between 1200px and 1280px. Below 1200px the width stays 960 and the panel stacks.
- **Wide** (viewport 1200px and up), panel open: the body becomes two columns, the existing list (flexible, `min-width: 0`) and the 300px panel. The panel is sticky (`top: calc(60px + 1rem)`, clearing the app bar the overlay already pads for) with its own scroll (`max-height: calc(100vh - 60px - 2rem)`).
- **Narrow** (below 1200px), panel open: the panel stacks above the list at full width, capped at `40vh` with its own scroll, so a long planner set never pushes the list below the fold.
- **Closed:** the modal is exactly today's 960px layout.
- The open state is a per-browser convenience in `localStorage` (`drb.sl.answersOpen`, every read and write in try/catch), default open.
- Styles are classes in `client/src/index.css` scoped under `html[data-app="admin-os"]` (the modal only ever renders on admin pages), painted only with the admin skin tokens (`--bg-*`, `--ink-*`, `--line-*`, `--accent*`), so both skins (House Lights and After Hours) are right by construction and `npm run check:css-scope` stays green.

### 3.5 Not changing

No schema change, no new endpoint, no money path. List generation, the plan page's source switch, the client's `/shopping-list/:token` page and the plan page's full Selections card are untouched. The plan page keeps its public catalogs, so its own card still drops a retired pick that the panel now names; that is today's plan-page behaviour, left alone.

### 3.6 Docs

- `README.md:397` (the `consultRecap.js` tree line): the shared recap with drink names, read by the email, the staff payload and the consult GET.
- `README.md:632` (the `ShoppingList/` tree line): `ClientAnswersPanel` and `answerSets.js`.
- `README.md` Key Features (`:725`): the answers panel beside the shopping list.
- `ARCHITECTURE.md:246` (the consult GET row): the `recap` field.
- `ARCHITECTURE.md:282` (the event-details payload row): `consult_recap`, and `consult_selections` kept for one release.
- `ARCHITECTURE.md:1555` (the `consult_recap` action entry): drink names and the Mixers line, loaded in build and dispatch, fail-soft.
- `ARCHITECTURE.md:1648` (the `ShoppingListModal.jsx` bullet) plus a new bullet for the panel and `answerSets.js`.

## 4. Edge cases

- **Legacy v1 planner** (plans 101 and 103): `LegacySelections` with `listOnly` drops only `logisticsNotes`.
- **Planner with no drink answers** (`{}`, null, only a logo, only menu or logistics answers): no planner set.
- **Consult with nothing to say** (`{}`, or only a guest-count override): no consult set. When it built the list, the list note says "This list was built from a consult with no drink answers."
- **A retired drink** (`is_active = false`): both views name it (the consult lookup ignores `is_active`; the planner view reads the admin catalogs). A drink deleted outright humanizes in the consult view and drops from the planner view.
- **Both sets, planner never submitted** (all 11 such plans on prod): consult shows; the switch offers "Planner · not submitted".
- **Planner submitted after the consult** (zero on prod today; the list does not rebuild on its own once one exists, `shoppingListGen.js:516`): planner shows, with the note "This list was built from the consult."
- **Planner status `submitted`/`reviewed` with no `submitted_at`:** counts as submitted with no date, and never beats a consult (no stamp to compare).
- **Name lookup fails:** humanized names on all three surfaces, a Sentry report, and nothing else fails.
- **Server older than the client** (deploy window, or a lone revert of the server lane): the panel shows its error state with Retry; the staff card hides.
- **No proposal linked** (the manual guest-count path): the panel loads by plan id like everything else; the staff payload has no plan row and runs no lookup.
- **Hosted plans:** normally no list, but `ShoppingListButton.jsx:41-59` regenerates one when none is saved (no hosted check), so the modal can open on a hosted plan and the panel renders there like anywhere else.
- **A finalized BEO** (the modal's locked, read-only view): the panel shows.

## 5. Testing

Server (`node:test`, one suite at a time from the repo root against the shared dev DB, pass count read each run):
- `server/utils/consultRecap.test.js` (pure): the first fixture moves to the stored shape (slug ids, wine categories); names resolve from the map; a missing id humanizes; a non-string id is skipped; the Mixers line appears for `full_bar` and `sig_beer_wine` only, with the `none` copy; `consultRecapLines` is `[]` where the formatter prints its placeholder; `unmatchedDrinkIds`; existing behaviours hold.
- `server/utils/consultRecap.names.test.js` (new, dev DB): `loadConsultDrinkNames` against seeded inactive rows with nonce ids (one id seeded in BOTH tables under different names, so each list provably resolves against its own table), no query for a consult with no drinks, empty Maps (no throw) when the query fails, and `buildConsultRecap` returning `null` for a missing, empty or nothing-to-say consult and humanized lines when the lookup fails.
- `server/utils/comms/actions/remainingActions.test.js`: the consult fixture's drink becomes a seeded cocktail with a fixed test id deleted before each run (the file's existing fixed-email pattern) and a name unlike its humanized id; the drafted body carries the name and the Mixers line, and not the id.
- `server/routes/drinkPlanConsult.recap.test.js` (new; `drinkPlanConsult.test.js` covers a helper and has no HTTP harness): `GET /api/drink-plans/:id/consult` returns `recap` with names beside the unchanged raw blob; `recap: null` with no consult.
- `server/routes/eventDetails.test.js`: the payload carries `drink_plan.consult_recap` lines with names and, for this release, `consult_selections` too.
- Every other suite that loads a file the lane edits runs in the lane gate: `drinkPlanConsult.sanitize.test.js`, `drinkPlans.beo.test.js`, `drinkPlans/hostedNoList.test.js` (its consult PUTs reach the email's post-commit dispatch, whose catch only logs, so the gate also greps the output for `post-commit notify failed`), `comms/registry.test.js`, `routes/comms.test.js`, `comms/actions/proposalActions.test.js`, `beoFinalize.auto.test.js`, and `beo.test.js`.

Client (jest + RTL, `CI=true npx react-scripts test --watchAll=false <files>`), each task's checkpoint also passing `CI=true npx react-scripts build`:
- `answerSets.test.js` (new): consult newer, planner newer, draft planner vs consult, tie, missing stamps, status-submitted with no stamp, only one set each way, neither, a planner with no drink answers (logo only, menu only, `{}`), the copy helpers, an evening stamp reading as its Chicago day, and every `listNote` branch.
- `ClientAnswersPanel.test.jsx` (new): planner view shows drinks and crowd but not menu design or parking; consult view shows the lines; the switch flips and writes nothing; a reopen starts on the newest set; the list note follows the shown set; a `{}` consult that built the list shows its note; an old server (no `recap` key) is the error state; a failed catalog read is the error state and Retry recovers; empty state.
- `DrinkPlanSelections.test.js` (new): `listOnly` hides Menu Design and Logistics and keeps the crowd and guest-preference lines; the default render is unchanged, guest preferences included.
- `client/src/components/staff/BeoSections.test.js` (exists, BarMenuCard only today): `ConsultCard` renders lines with bold labels; null on empty.

Browser, on the lane's own dev servers (:5001 and :3001, so a dev server another window left on :3000/:5000 is never disturbed):
- Lane `consult-recap`: the staff Consult card at `http://staff.localhost:3001/shifts/<id>` on a dev event whose consult names a catalog drink and a custom drink; and the recap email rendered on the dev DB (text and HTML) from `buildMessages`, read before merge and handed to the reviewers.
- Lane `sl-client-answers`: the modal from a drink-plan page and an event page at 1440px, 1200px and 1024px, in both skins; the sticky panel, the switch, the list note, the narrow stacking and its height cap, Editor and Client view with the panel open, the closed state matching today's layout, and a finalized plan (recorded as unverified in the review handoff if the dev DB holds none).

## 6. Review

`scripts/sensitive-match.js` run against every file in the plan (2026-10-06): two match, both through `server/utils/comms/actions/*.js` (the comms registry drives every admin-initiated external send): `server/utils/comms/actions/consultRecap.js` and its suite `remainingActions.test.js`. So the recap lane takes the full fleet that applies before merge (code-review, consistency-check across the three readers of one formatter, security-review on the staff payload's new key and the client email's content, performance-review on the staff payload's hot read), and at push the sensitive-path re-review plus `/second-opinion`. The panel lane touches nothing sensitive: code-review plus ui-ux-review, judged on usability and both skins (no design artifact exists for this surface), plus consistency-check on the `recap` contract the two lanes share across different files (`string[] | null`, null for an empty consult, absent on an older server), which the push-time seam sweep would not catch because the lanes share no code file.
