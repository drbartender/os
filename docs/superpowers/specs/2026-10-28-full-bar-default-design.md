# Full bar by default in the drink planner: design

Date: 2026-10-28, revision 2. Brainstormed with Dallas in chat on 2026-10-27 and 2026-10-28; his section-by-section answers are the approval. Every decision below that is not quoted from him is Claude's call and is marked as such. Revision 2 folds the spec fleet (spec-grounding, spec-gaps, spec-risk): one blocker, raised by two of them (the marker reached hosted plans), and the warnings, all taken.

## 1. Why

Dallas: "Clients keep choosing signatures + Beer and wine but really they want a full bar. They come around feeling like things are missing or they don't buy the right things becuase there list is only what they actually asked for."

Dallas: "Yes the choice is the issue. [...] They need to ahve their hands held, but effieciently."

What the planner does today (planner v2, `client/src/pages/plan/v2/`):

- The first screen (`QuickPickV2.js`) offers four equal cards: Full Bar Experience, Signature Drinks + Beer & Wine, Beer & Wine Only, Mocktails Only. Production on 2026-10-28: of 33 submitted BYOB plans on planner v2, 16 picked Full Bar, 15 picked Signature Drinks + Beer & Wine, 2 picked Beer & Wine Only.
- A `sig_beer_wine` shopping list (`server/utils/shoppingList.js`, `buildPlannerLists`) carries the client's beer and wine, the basic mixers, garnishes and supplies, and the ingredients of their picked drinks. It carries none of the standard spirits a full bar list gets. A guest who asks for a vodka soda at a margarita-and-old-fashioned event gets nothing.
- The Full Bar path has a Spirits & Mixers screen (`SpiritsV2.js`) asking which spirits to stock and whether to include mixers. The shopping list never reads either answer: a `full_bar` list is the fixed standard set (`pars100`) scaled to the guest count, plus the picked drinks' ingredients. The answers are read by the client's Review screen, the admin recap (`client/src/components/DrinkPlanSelections.js`, which the shopping list modal's answers panel mirrors through `client/src/components/ShoppingList/answerSets.js`), the submission echo email (`drinkPlanEchoSection` in `server/utils/lifecycleEmailTemplates.js`) and the printed menu's "Also at the bar" Spirits line (`server/utils/menuDrinkSource.js` `plannerBar`, into `server/utils/menuAlsoAtBar.js`).
- Bar style never touches money. `server/utils/pricingEngine.js` never reads `serving_type`.

## 2. Goals, non-goals, anti-goals

Goals:

- A new BYOB plan lands on a full bar unless the client deliberately limits it.
- The limit, when chosen, names what the client's guests will not be able to order, computed from the client's own picks.
- The Full Bar path gets shorter, not longer.
- An extra spirit the client asks for reaches Dallas: Scotch and Mezcal straight onto the list and the menu, anything typed as a request he sees while reviewing the list.

Non-goals:

- Plans already in flight. Dallas: "For the old ones, let's just leave them alone. We'll deal with it like we always have. Lets just fix it moving forward." No outreach, no data change, no regenerate.
- Hosted packages (their own flow in `queue.js`), the legacy v1 wizard (`PotionPlanningLab.js` and `client/src/pages/plan/steps/`), pricing, shopping list quantities, the Beer & Wine screen, the Mocktails Only flow, the consult path (`buildConsultGeneratorInput`; once Dallas runs a consult, its own spirits chips, Scotch and Mezcal included, are the record), and the rule that a drinks flow needs at least one drink to submit.
- A full bar list's beer and wine. It stocks the fixed standard beers and wines whatever the client picked on the Beer & Wine screen; those picks feed the menu only. That is today's behavior and this build leaves it alone.

Anti-goals (a build that does any of these has failed even if it works):

- A plan submitted before this ships, or any hosted plan, gets a different shopping list, menu line, recap or email because of it.
- The planner asks the client more questions than it does today.
- The opt-out sells, scolds, or mentions money.

## 3. Decisions

### 3.1 The first screen

Three cards, in this order: Full Bar, Beer & Wine Only, Mocktails Only. The Signature Drinks + Beer & Wine card goes away. Dallas: "The only limited that is usually forced is beer and wine only."

Full Bar card copy (Claude's call; the builder may tune the words, not the meaning): label "Full Bar", description "Your signature cocktails plus a standard bar, so guests can still order a vodka soda or a rum and coke."

A plan already on `sig_beer_wine` (opted out, or a draft saved before the ship) shows the Full Bar card as its selected card, because the opted-out bar is a full bar the client trimmed. Tapping Full Bar there sets a full bar (3.5's switch rule applies).

Only the local `PICKS` list in `QuickPickV2.js` changes. `QUICK_PICKS` in `client/src/pages/plan/data/servingTypes.js` keeps every entry: `PlannerV2.withActiveModules` derives `activeModules` from it, and a plan saved as `sig_beer_wine` still needs its entry or the admin recap renders it near-empty.

### 3.2 The "Your bar" panel on the drinks screen

A panel on `DrinksV2.js`, shown only when the plan is not hosted (`isHosted` false, stated explicitly, since a hosted plan can owe a list and reach this screen through the content-readiness fallback), the plan owes a shopping list (`owesShoppingList(plan)`), and the quick pick is `full_bar` or `sig_beer_wine`. Never on Mocktails Only. It is visible on the drinks screen without switching tabs (Claude's call: below the custom-request card; the builder places it in the existing pp2 styling).

Full bar state:

- Heading "Your bar". Line: "Your drinks, plus a standard bar: vodka, gin, rum, tequila and whiskey, with the usual mixers, beer and wine."
- One optional extras line, "Anything you want on the bar that isn't standard?", with two quick-add chips, Scotch and Mezcal, and a short free-text box capped at 80 characters on the input itself (`maxLength`), matching the server cap. Claude's call on the chips: Scotch and Mezcal are the two spirits with house bottles in the catalog (production `par_items` `scotch-whiskey` and `mezcal`, `role` spirit, active, `spirit_key` set).
- A quiet link, "Keep it to just my drinks."

Tapping the link opens a confirm inside the panel: the gap line from 3.3, then two buttons, "Keep it to my drinks" and "Keep the full bar" (closes the confirm, nothing changes).

Opted-out state: the panel reads "Just your drinks, plus beer and wine.", shows the gap line, and offers a link "Give me the full bar." The extras line is hidden.

Opting out sets the quick pick to `sig_beer_wine` and empties `barExtras` and `barExtrasOther` (Claude's call: extras are a full bar thing, and clearing them keeps every reader simple). Undoing sets it back to `full_bar`. PlannerV2 already sends the quick pick as `serving_type` on every save, so the switch reaches the column the server reads; the test asserts the saved body carries the new value.

### 3.3 The gap line

A pure helper in its own client module (with the header comment the generated docs read), unit tested. The standard spirits are Vodka, Gin, Rum, Tequila, Whiskey, in that order. A picked cocktail covers its `base_spirit` (the public `GET /api/cocktails` the planner already loads carries it; in production on 2026-10-28 all 24 active cocktails have one). Matching ignores case, and Bourbon and Rye count as Whiskey (Claude's call). Mocktails and custom requests cover nothing. Gaps are the standard spirits not covered, in standard order.

Copy (Claude's call on the words; spirits lowercase mid-sentence, two names joined with "and", three or more as "a, b or c"):

- Some covered, some not (a margarita and an old fashioned): "Your drinks use tequila and whiskey. Guests who ask for vodka, gin or rum won't get one."
- None covered (no cocktails, or only bases outside the five, like Aperol): "None of your drinks use the standard spirits. Guests who ask for a mixed drink like a vodka soda won't get one."
- All five covered: "Your drinks use all five standard spirits, but you'd buy only what your drinks need, so guests ordering their own mixed drinks could run those bottles dry."
- Can't tell (the catalog has not loaded, failed to load, or a picked cocktail is missing from it): "Keeping it to your drinks means guests can order only what's on your menu, plus beer and wine." The helper never claims a gap it cannot see.

### 3.4 The Spirits & Mixers screen goes, and Review follows

`SpiritsV2.js` is deleted, with its lazy import in `PlannerV2.js` and its `STEP_LABELS` entry. The Full Bar queue in `queue.js` becomes `quickPick, drinks, beerWine, crowd, menu, dayof, review`, the same as the `sig_beer_wine` queue today (which does not change).

`ReviewV2.js`:

- Its "Bar style" row reads from its own `QUICK_PICK_LABELS`: `full_bar` becomes "Full bar" and `sig_beer_wine` becomes "Just your drinks, plus beer and wine". That row's edit link goes to the drinks step, where the panel lives.
- For a plan carrying the marker (3.5), the Spirits and Mixers rows are replaced by an "Extras" row (chips and typed text) on a full bar, and nothing on an opted-out plan.
- The Beer and Wine rows keep their own edit link to the Beer & Wine step.
- Its beer and wine rows pick the family by the quick pick, not by which family is non-empty.

### 3.5 The marker, the two new keys, and switching styles

New keys:

- `barExtras`: an array holding only `'scotch'` and `'mezcal'`.
- `barExtrasOther`: a string, trimmed, at most 80 characters.

The marker is `Array.isArray(selections.barExtras)`. It is never in `DEFAULT_SELECTIONS`. Exactly two client actions write it, both on BYOB-only screens: tapping a card on the new first screen, and any touch of the panel (a chip, the text box, the opt-out, the undo). A hosted plan never sees either screen, so it never carries the marker. A plan submitted before the ship never carries it either, and a PUT to a submitted plan is refused (409), so it cannot gain one.

When the marker is first written on a plan that has old answers (a draft saved before the ship), the old answers come with it: Scotch and Mezcal in `spirits` become `barExtras` entries, and `spiritsOther` becomes `barExtrasOther` if that is empty (Claude's call; otherwise the client's earlier answer would vanish).

Server side, every new rule (3.6, 3.7, 3.8, 3.9) applies only when `serving_type` is exactly `'full_bar'` and the marker is present. Never through `plannerServiceStyle`, which maps a null `serving_type` (every hosted v2 row) to `full_bar`.

The sanitizer (`server/routes/drinkPlans/submitSanitize.js`, `ALLOWED_SELECTIONS_KEYS`) accepts both keys. A `barExtras` that is not an array is dropped, never coerced to `[]`, so garbage cannot set the marker; an array keeps only the two known slugs, deduplicated. A `barExtrasOther` that is not a string is dropped; a string is trimmed and capped at 80. Both normalize only when present, following the `crowd` pattern there. The old keys (`spirits`, `spiritsOther`, `mixersForSpirits`) stay on the allow-list and in the defaults, because old plans carry them.

Switching styles. `BeerWineV2.js` stores beer and wine under two families: the full bar family (`beerFromFullBar`, `wineFromFullBar`, `wineOtherFullBar`) for `full_bar`, and the beer and wine family (`beerFromBeerWine`, `wineFromBeerWine`, `wineOtherBeerWine`) for `sig_beer_wine` and `beer_wine`. One switch function in PlannerV2 handles every quick pick change, from the panel and from the first screen alike: when the old and new picks use different families, the new family takes the old family's values and the old family is cleared. Clearing matters because three readers do not pick the family by style today: `ReviewV2.js` (fixed in 3.4), `drinkPlanEchoSection` (fixed in 3.9) and `client/src/pages/plan/data/menuSections.js`, which joins both families and is correct once one is always empty.

The `beforeunload` keepalive save in PlannerV2 recomputes `activeModules` through `withActiveModules` like the other saves, so a switch followed by closing the tab never leaves a draft with stale modules for the admin recap.

### 3.6 The shopping list

Only the `full_bar` recipe changes, and only under 3.5's server condition:

- The planner input builder in `server/utils/shoppingListGen.js` passes `barExtras` to the generator. Every caller of that builder inherits it: submit's auto-generate, `server/routes/drinkPlans/regenerate.js`, `server/routes/drinkPlans/labListRefresh.js` and the planner side of `server/routes/drinkPlanConsult.js`.
- In `shoppingList.js`, the `full_bar` branch adds the house bottle for each chip through the existing `addSpiritsByKey` (catalog spirit pars, scaled to the guest count, deduplicated by item name), right after the `pars100` rows and before `mergeSignatureRecipes`, which must stay last. A Mezcal drink's recipe resolves to the same par row, so the merge finds the chip's line by name and treats it like any par line already on the list, exactly as it treats Tito's under a vodka drink. If a second branded scotch or mezcal row is ever added and a recipe pins it, the two would not dedupe; Claude's call to accept that, since neither exists.
- The typed extra never becomes a list line (Claude's call, changed from revision 1 by the fleet: a client line would be resurrected or doubled by every regenerate, since admin holds match on item and size). It shows as a request in the shopping list modal's answers panel instead (3.8), where Dallas reviews the list, and he adds the bottle himself; his line is an admin edit, so regenerates keep it.
- `sig_beer_wine`, `beer_wine` and `mocktails` lists ignore the extras.
- A `full_bar` plan without the marker produces exactly the list it produces today.

### 3.7 The printed menu

`plannerBar` in `server/utils/menuDrinkSource.js`, under 3.5's server condition: the Spirits line is Vodka, Gin, Rum, Tequila, Whiskey, then Scotch and Mezcal when picked (about 51 characters, inside the 120-character line cap in `menuAlsoAtBar.js`). The typed extra is not printed (Claude's call: it is unreviewed client text, and Dallas edits the menu's lines in the designer anyway). Without the marker, or with any other `serving_type`, the old rule (`spirits` plus `spiritsOther` on a full bar) stands unchanged. The panel copy and this line name the five spirits as constants; they match the catalog's `in_full_bar` spirit rows today (Tito's, Tanqueray, Bacardi, Bulleit, 1800). If those rows change, both constants are edited by hand (Claude's call).

### 3.8 The admin recap and the list modal's answers panel

`DrinkPlanSelections.js`, for a plan carrying the marker on a full bar: "Bar extras: Scotch, Mezcal" for the chips and "Client asked for: <typed text>" for the request, and the old Spirits and Mixers lines are not rendered. On an opted-out plan, no extras lines. Plans without the marker render exactly as today. `answerSets.js` counts the extras as an answer under the same condition, so the shopping list modal's answers panel offers and shows them.

### 3.9 The submission echo email

`drinkPlanEchoSection`, under 3.5's condition: a "Your bar" row ("Full bar" or "Just your drinks, plus beer and wine"), an "Extras" row with the chips and the typed text, and no Spirits or Mixers rows. The function takes the plan's `serving_type` from its callers for this. Its beer and wine rows pick the non-empty family; today `selections.beerFromFullBar || selections.beerFromBeerWine` always takes the full bar family because an empty array is truthy, so a `sig_beer_wine` client's email shows no beer or wine. That fix applies to every plan, old ones included: it changes only the email sent at the next submit, and an old plan is already submitted. Values keep passing through `esc()`.

## 4. Left to the builder

The panel's exact placement, styling and chip look, within the existing pp2 classes in `client/src/index.css`; small copy tuning that keeps the meaning; the names of the gap helper's module and the switch function; whether the "first card tap" stamp lives in `QuickPickV2` or in PlannerV2's handler.

## 5. How we know it works

- The gap helper's unit tests (new file beside the module): each of the four copy branches, standard order in the gap list, Bourbon and Rye as Whiskey, case, mocktails and custom requests covering nothing, an unknown picked id giving the can't-tell line.
- A new `queue.test.js`: the Full Bar queue without the spirits step; the hosted queues and the other three styles unchanged.
- `DrinksV2.test.js`: the panel on a BYOB full bar; hidden on Mocktails Only, on a hosted plan and on the hosted fallback; opt-out and undo flip the quick pick and empty the extras.
- A PlannerV2-level test of the switch: the beer and wine family moves and the old family clears, from the panel and from the first screen; the saved body carries the new `serving_type`; the marker is absent until a first-screen tap or a panel touch; first stamping carries old Scotch and `spiritsOther` answers.
- `server/utils/shoppingList.generator.test.js`: Scotch added on a marked full bar; one mezcal line when the Mezcal chip and a mezcal drink are both picked; extras ignored on `sig_beer_wine`; a full bar plan without the marker, and a hosted plan with a null `serving_type` and a marker, byte-identical to today's output.
- `server/utils/menuDrinkSource.test.js`: the standard five plus chips with the marker on `full_bar`; the old line without it; no Spirits line for a null `serving_type` carrying a marker.
- `server/routes/drinkPlans/submitPlannerV2.test.js` (where the sanitizer's cases live): both keys kept; a non-array `barExtras` and a non-string `barExtrasOther` dropped; unknown slugs dropped; text trimmed and capped.
- The echo email's test: the new rows under the condition, the old rows without it, and beer and wine shown for a `sig_beer_wine` plan.
- `client/src/components/DrinkPlanSelections.test.js` and the answers panel's `answerSets.test.js`: the extras lines and their absence on an opted-out plan and an old plan.
- A browser walk on the dev server: a BYOB plan through the new planner on a full bar with Scotch and a typed extra, submitted, then the admin shopping list (Scotch line, no typed line), the modal's answers panel (the request), the recap and the echo email's text; a second plan opted out, showing the gap line, a list with no standard spirits, and the Review screen's "Just your drinks" row.
