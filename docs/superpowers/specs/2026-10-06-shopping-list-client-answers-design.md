# Client's Answers Beside the Shopping List: Design

**Date:** 2026-10-06. **Status:** designed in chat with Dallas, each decision approved as it was made (bounded brainstorm). He asked for a plan review before any build, so this spec and its plan exist for the plan fleet.

**Ledger entries this closes** (`docs/fix-list-remaining-2026-07-02.md`):
- Potions, "Planner answers beside the shopping list" (Dallas's 2026-09-22 drop, item 8).
- Section 4, "The staff brief's consult card prints a custom drink as `[object Object]`".
- Section 2, "The post-consult recap email lists drinks by their catalog slug".

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
3. **Which set: the newest.** The consult counts from its last save (`consult_filled_at`, stamped `NOW()` on every save, `drinkPlanConsult.js:250,261`). The planner counts from its submit (`submitted_at`). A planner the client started but never submitted does not beat a consult. With only one set, show it (a planner draft is labeled "not submitted"). With neither, an empty state.
4. **A switch when both exist.** The panel header carries a two-way switch, Consult and Planner, each with its date or "not submitted". The panel opens on the newest set every time; a flip is not remembered, because a remembered choice could hide answers that arrive later. The switch only changes what the panel shows. It never rebuilds the list. Rebuilding stays on the plan page's existing source switch (`PATCH /api/drink-plans/:id/shopping-list-source`), which discards edits and resets the list to review.
5. **Mismatch note.** Whenever the panel shows a set the list was not built from, one line says which one was: "This list was built from the consult." or "This list was built from the planner." No note when `shopping_list_source` is null.
6. **One consult recap everywhere.** The server recap resolves catalog ids to drink names and gains a Mixers line. The recap email, the staff Consult card and the new panel all read it. Client-facing consequence: the recap email shows real drink names and, for a full bar or signature-cocktail bar, a Mixers line.
7. **Layout.** On a wide screen the panel sits to the right of the list and stays in view while the list scrolls; the modal widens to make room. On a narrow screen it stacks above the list. An "Answers" button in the modal header shows and hides it, and the choice is remembered per browser. It shows in the Editor, in Client view, and in the read-only finalized view.

## 3. Design

### 3.1 Server: one consult recap

`server/utils/consultRecap.js`:
- `formatConsultRecap(consult = {}, names = {})` stays pure. `names` is `{ cocktails: { [id]: name }, mocktails: { [id]: name } }`. `signatureDrinks` resolve through `names.cocktails`, `mocktails` through `names.mocktails`; an id with no entry renders through `humanizeDrinkId(id)` (split on `-` and `_`, capitalise each word: `french-75` becomes `French 75`). Omitting `names` keeps today's call shape working and every id humanizes.
- New Mixers line, only when `barType` is `full_bar` or `sig_beer_wine` and `mixers` is a known mode, placed after the wine line: `full` reads "Mixers: Full set", `matching` reads "Mixers: Only those that match your spirits", `none` reads "Mixers: None". (The form forces `none` on beer-and-wine and mocktail-only bars, `ConsultationForm.jsx:102,137`, so those bars never print it.)
- New `async loadConsultDrinkNames(consult, db)`: collects the ids present, runs `SELECT id, name FROM cocktails WHERE id = ANY($1::text[])` and the same against `mocktails`, and returns the `names` shape. Skips a table with no ids (no query at all for a consult with none). `db` is the caller's handle (the pool, or a client the caller already holds, per the one-connection rule).
- Exported alongside the existing two.

Three readers:
- **Recap email** (`server/utils/comms/actions/consultRecap.js`): `load()` (`:38`) attaches `row.drink_names = await loadConsultDrinkNames(row.consult_selections, pool)`; `defaultParts` (`:116`, call at `:134`) passes it to the formatter. `buildMessages` (`:141`) and `dispatch` (`:175`, `defaults` at `:178`) both go through `load()`, so the draft the admin sees and the defaults `dispatch` compares against stay identical and `body_edited` stays honest.
- **Consult GET** (`server/routes/drinkPlanConsult.js:159`): the response gains `recap`, the formatted lines, or `null` when `consult_selections` is null. Existing fields unchanged; the form still pre-populates from the raw blob.
- **Staff payload** (`server/utils/eventDetailsPayload.js`): after the drink-plan row loads (`:87`), compute the lines when `consult_selections` is a non-empty object. The payload's `drink_plan.consult_recap` (lines or null) replaces `drink_plan.consult_selections` (`:318`). Both routes built on this payload (`GET /api/shifts/:shiftId/event-details`, `GET /api/beo/:proposalId`) change together; the staff `ShiftDetail.js` is the only client reader of the raw blob.

### 3.2 Staff Consult card

`ConsultCard({ lines })` renders each line as one row in the card it has today, and returns null for a missing or empty array. `ShiftDetail.js:689` passes `drinkPlan?.consult_recap`; the `consultSelections` local (`:192`) goes. Server (Render) and client (Vercel) deploy separately: an old client against the new server, or the reverse, hides the card. Neither renders garbage.

### 3.3 Admin panel

`client/src/components/ShoppingList/answerSets.js`, pure: `pickAnswerSets(plan, hasConsult)` returns `{ sets, initial }`. `sets` lists the sets that exist, in the order Consult, Planner, each `{ key, at, submitted }`. A planner set exists when `plan.selections` is a non-empty object; a consult set exists when `hasConsult`. `initial` applies decision 3, ties going to the consult.

`client/src/components/ShoppingList/ClientAnswersPanel.jsx`, props `{ planId }`:
- Loads in parallel `GET /drink-plans/:id`, `GET /cocktails`, `GET /mocktails`, then `GET /drink-plans/:id/consult` when `has_consult_selections`. Any failure is an error state with Retry (an empty catalog would silently drop picked drinks, since `DrinkPlanSelections` filters picks against the catalog). Loading state while in flight. Empty state "No planner or consult answers yet." when `sets` is empty.
- Header: "Client's answers", the source line ("From the consult, Oct 2" / "From the planner, submitted Sep 25" / "From the planner, not submitted", Chicago day via `fmtDateFull(ctDay(ts))` as `DrinkPlanDetail.js` does), the switch when two sets exist, and the mismatch note.
- Planner view: `<DrinkPlanSelections plan={plan} cocktails={…} mocktails={…} listOnly />`. Consult view: the `recap` lines.

`DrinkPlanSelections.js` gains `listOnly` (default false, so the plan page is unchanged). With it on: the Menu Design block (`:129-153`) and the Logistics block (`:159-202`) do not render; drinkers and crowd profile (`:188`) and guest preferences (`:194`), which live inside Logistics today, render in their own "Crowd" block; the legacy view drops `logisticsNotes` (`:293`).

### 3.4 Modal layout

`ShoppingListModal.jsx` is 930 lines against the 1000-line hard cap, so the panel lives in its own file and the modal takes only an import, the "Answers" header button with its remembered state, and a layout wrapper around the body (target under 40 added lines).
- Wide (viewport 1200px and up), panel open: the modal's max width grows from 960 to 1280 and the body becomes two columns, the existing list (flexible, `min-width: 0`) and the 300px panel. The panel is sticky (`top: calc(60px + 1rem)`, clearing the app bar the overlay already pads for) with its own scroll (`max-height: calc(100vh - 60px - 2rem)`).
- Narrow (below 1200px), panel open: the panel stacks above the list at full width.
- Closed: the modal is exactly today's 960px layout.
- The open state is a per-browser convenience in `localStorage` (`drb.sl.answersOpen`, every read and write in try/catch), default open.
- Styles are classes in `client/src/index.css` scoped under `html[data-app="admin-os"]`, painted only with the admin skin tokens (`--bg-*`, `--ink-*`, `--line-*`, `--accent*`), so both skins (House Lights and After Hours) are right by construction and `npm run check:css-scope` stays green.

### 3.5 Not changing

No schema change, no new endpoint, no money path. List generation, the plan page's source switch, the client's `/shopping-list/:token` page and the plan page's full Selections card are untouched. Catalog behaviour is unchanged: the panel uses the same public catalogs the plan page loads, so a drink later removed from them drops out of both views alike.

## 4. Edge cases

- **Legacy v1 planner** (plans 101 and 103): `LegacySelections` with `listOnly` drops only `logisticsNotes`.
- **Planner selections `{}` or null:** no planner set.
- **A consult drink id no longer in the catalog:** humanized fallback, never the raw slug, never dropped.
- **Both sets, planner never submitted** (all 11 such plans on prod): consult shows; the switch offers "Planner, not submitted".
- **Planner submitted after the consult** (zero on prod today; the list does not rebuild on its own once one exists, `shoppingListGen.js:516`): planner shows, with the note "This list was built from the consult."
- **No proposal linked** (the manual guest-count path): the panel loads by plan id like everything else.
- **Hosted plans:** no list is staged, so the modal does not open for them; nothing new.
- **A finalized BEO** (the modal's locked, read-only view): the panel shows.

## 5. Testing

Server (`node:test`, one suite at a time from the repo root against the shared dev DB, pass count read each run):
- `server/utils/consultRecap.test.js`: fixtures move to the stored shape (slug ids, wine categories); names resolve from the map; a missing id humanizes; the Mixers line appears for `full_bar` and `sig_beer_wine` only; existing behaviours hold. `loadConsultDrinkNames` against seeded rows with unique ids, cleaned up after.
- `server/utils/comms/actions/remainingActions.test.js`: the consult fixture's drink becomes a seeded cocktail with a unique id; the drafted body carries its name and not its id.
- `server/routes/drinkPlanConsult.test.js`: `GET /:id/consult` returns `recap` with names; `null` with no consult.
- `server/routes/eventDetails.test.js`: the payload carries `drink_plan.consult_recap` lines and no `consult_selections` key.

Client (jest + RTL, `CI=true npx react-scripts test --watchAll=false <files>`):
- `answerSets.test.js`: consult newer, planner newer, draft planner vs consult, tie, only one set each way, neither, `{}` selections.
- `ClientAnswersPanel.test.jsx`: planner view shows drinks and crowd but not menu design or parking; consult view shows the lines; the switch flips; the mismatch note follows the shown set; error state retries; empty state.
- `DrinkPlanSelections.test.js`: `listOnly` hides Menu Design and Logistics and keeps the Crowd block; default render unchanged.
- `client/src/components/staff/BeoSections.test.js`: `ConsultCard` renders lines; null on empty.

Browser (dev server on :3000): open the modal from a drink-plan page and an event page at 1440px and 1024px widths, in both skins; check the sticky panel, the switch, the narrow stacking and the closed state matching today's layout.

## 6. Review

Nothing touched is on `scripts/sensitive-paths.txt` (checked with `scripts/sensitive-match.js` against every file in the plan), so the light track: per lane, code-review plus the suites, consistency-check on the recap lane (three readers of one formatter), and ui-ux-review on the panel lane.
