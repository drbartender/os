---
spec: docs/superpowers/specs/2026-10-28-full-bar-default-design.md   # rev 3 (spec fleet folded in rev 2; the plan fleet's two spec points settled in rev 3)
format: lane map without code (spec 2026-10-19 D12)
revision: 2 (2026-10-28; rev 1 the same day)
status: rev 2 folds the plan fleet (plan-fidelity, plan-decomposition; no blockers, seven warnings and six suggestions, all taken). Nothing is built until Dallas says go. Execution, Claude's call: each lane is built in one pass by Claude in its own worktree (npm run worktree:new); each lane gets the review skill at the tier it computes, merges through scripts/merge-lane.sh from os, and the three merged-lane checks run before its branch goes. The push is Dallas's cue, after both lanes are on main.
order: both lanes are cut from main together and built in parallel against the contract below; blockedBy in this plan means merge order only. fb-server merges first; fb-planner then rebases onto that main, resolves any conflict in the generated sections of README.md and ARCHITECTURE.md by re-running npm run docs (never by hand), runs its walk, reviews and merges.
contract: the keys and the conditions both lanes build against (spec 3.5). selections.barExtras is an array holding only 'scotch' and 'mezcal'; selections.barExtrasOther is a string, trimmed, at most 80 characters; the marker is Array.isArray(selections.barExtras), never set by a default. Extras rule (list, menu, extras rows): serving_type === 'full_bar' (the literal value, never plannerServiceStyle) AND the marker. Style rows ("Full bar" / "Just your drinks, plus beer and wine"): the marker AND serving_type 'full_bar' or 'sig_beer_wine'. Old Spirits and Mixers rows: hidden wherever the marker is present. The server keeps these in server/utils/barExtras.js and the client in client/src/pages/plan/v2/barStyle.js, so no reader writes its own copy.
lanes:
  - id: fb-server
    scope: the server half of the spec. One predicate module (server/utils/barExtras.js) exporting the extras rule and the style-row rule from the contract, used by every server reader. The sanitizer accepts and normalizes the two keys (3.5). The planner input builder (buildPlannerGeneratorInput in shoppingListGen.js, which maps serving_type through plannerServiceStyle, so the literal gate lives there) passes the chips; the full_bar branch of the list adds their house bottles through addSpiritsByKey after the pars100 rows and before mergeSignatureRecipes (3.6); the typed text never becomes a line. The printed menu's Spirits line becomes the standard five plus chips under the extras rule (3.7). The submission echo email gains the Your bar row under the style-row rule and the Extras row under the extras rule, drops Spirits and Mixers wherever the marker is present, takes serving_type from submitNotify (buildSelectionsEcho exported for its test), and picks the non-empty beer and wine family for every plan (3.9).
    footprint:
      - server/utils/barExtras.js  (new, with the header comment the generated docs read)
      - server/utils/barExtras.test.js  (new)
      - server/routes/drinkPlans/submitSanitize.js  (the allow-list and the two keys' normalization only)
      - server/routes/drinkPlans/submitPlannerV2.test.js  (the sanitizer cases)
      - server/utils/shoppingListGen.js  (buildPlannerGeneratorInput only)
      - server/utils/shoppingList.js  (the full_bar branch of buildPlannerLists only)
      - server/utils/shoppingList.generator.test.js
      - server/utils/menuDrinkSource.js  (plannerBar only)
      - server/utils/menuDrinkSource.test.js
      - server/utils/lifecycleEmailTemplates.js  (drinkPlanEchoSection only)
      - server/utils/lifecycleEmailTemplates.test.js
      - server/routes/drinkPlans/submitNotify.js  (buildSelectionsEcho takes the row's serving_type and passes it on; exported for its test)
      - server/routes/drinkPlans/submitNotify.test.js  (new; no suite tests submitNotify today)
      - README.md  (generated sections, npm run docs)
      - ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: []
    lenses: tier A floor (submitSanitize.js and submitNotify.js are sensitive-listed): money, lifecycle, concurrency, outcomes-providers, access-egress, seams; verify; the externals; the money smoke. Expected to find nothing money-shaped, since no price, payment or status moves; the floor runs anyway.
    laws: pricingEngine and every money path untouched; a full_bar plan without the marker, and any plan whose serving_type is not the literal 'full_bar' (every hosted v2 row is null), gets byte-identical list and menu output and an echo email changed only by the beer and wine family fix; the chip step runs before mergeSignatureRecipes, which stays last (its own comment in shoppingList.js); the sanitizer drops a non-array barExtras and a non-string barExtrasOther and never coerces either, so garbage cannot set the marker; the typed text reaches no shopping list line and no menu line; echo values keep passing through esc(); the consult generator input (buildConsultGeneratorInput) is untouched.
    seams: the selections shape and conditions shared with fb-planner (the contract above); every caller of the planner input builder inherits the chips (submit's auto-generate, regenerate.js, labListRefresh.js, the planner side of drinkPlanConsult.js) and none needs its own change; the echo picks the non-empty beer and wine family while ReviewV2 picks by quick pick (fb-planner), and the two agree because fb-planner's switch always clears the old family.
    test plan: barExtras.test.js (the extras rule true only for the literal full_bar with an array marker; false for null serving_type with a marker and for sig_beer_wine with a marker; the style-row rule true for marked full_bar and sig_beer_wine, false for null and for beer_wine; chips filtered to the two slugs); submitPlannerV2.test.js (both keys kept; non-array barExtras and non-string barExtrasOther dropped, the key absent from the stored selections; unknown slugs dropped; duplicates removed; text trimmed and capped at 80); shoppingList.generator.test.js, every case below run through buildPlannerGeneratorInput then generateShoppingList, never the generator alone (the Scotch par line on a marked full bar; exactly one mezcal line with the Mezcal chip plus a mezcal drink; the chips ignored on sig_beer_wine; a marker-less full bar and a null-serving_type plan carrying a marker each deep-equal to the output the same input gives with the keys removed; the typed text on no line); menuDrinkSource.test.js (standard five plus chips, in menuAlsoAtBar order, under the extras rule; the old spirits plus spiritsOther line without the marker; no Spirits line for a null serving_type with a marker; the typed text absent); lifecycleEmailTemplates.test.js (on a marked full bar the Your bar row reads Full bar, the Extras row carries chips and text, no Spirits or Mixers rows even when old spirits and mixersForSpirits values are present; on a marked sig_beer_wine plan the Your bar row reads Just your drinks, plus beer and wine, no Extras, Spirits or Mixers rows; a marker-less plan keeps the old rows; beer and wine shown for a sig_beer_wine plan whose full bar family is an empty array); the submitNotify case (buildSelectionsEcho with a marked full_bar row and a marked sig_beer_wine row produces the matching Your bar row, proving the real serving_type reaches the echo). The money smoke, as tier A requires.
    revert: revert fb-planner first if it has merged, then this lane, in one push. Rows submitted under the new screens keep barExtras and have no new Spirits answers (SpiritsV2 is gone); the restored server reads them under the old rules (no chip lines, no Spirits menu line), which the spec's "leave them alone" accepts.
  - id: fb-planner
    scope: the client half of the spec. The first screen goes to three cards, with a sig_beer_wine plan showing the Full Bar card as selected (3.1). The Your bar panel on the drinks screen, gated on not hosted, a list owed, and full_bar or sig_beer_wine, with the chips, the 80-character typed box, the opt-out with its confirm, and the undo (3.2). The gap line helper with its four branches (3.3). The Spirits & Mixers screen deleted and the Full Bar queue shortened; Review's bar style labels, its Extras row, its edit links, and its beer and wine rows changed to pick the family by quick pick (3.4). The marker written only by a first-screen tap or a panel touch, carrying old Scotch, Mezcal and spiritsOther answers on first write; one switch function in barStyle.js, called by PlannerV2 for every quick pick change from the first screen and from the panel, moving the beer and wine family and clearing the old one (3.5). One save body builder (saveBody.js, with withActiveModules moved into it) used by the draft save, the beforeunload keepalive and the submit, so every save carries serving_type from the quick pick and recomputed activeModules (3.5). The admin recap and the list modal's answers panel showing the chips and the request under the contract's rules, with serving_type passed into answerSets from pickAnswerSets (3.8).
    footprint:
      - client/src/pages/plan/v2/barStyle.js  (new: the gap helper, the switch, the marker stamp, the client predicates and the beer and wine family pick, pure, with the header comment)
      - client/src/pages/plan/v2/barStyle.test.js  (new)
      - client/src/pages/plan/v2/saveBody.js  (new: the save body builder and withActiveModules, pure, with the header comment)
      - client/src/pages/plan/v2/saveBody.test.js  (new)
      - client/src/pages/plan/v2/queue.js
      - client/src/pages/plan/v2/queue.test.js  (new)
      - client/src/pages/plan/v2/PlannerV2.js
      - client/src/pages/plan/v2/steps/QuickPickV2.js
      - client/src/pages/plan/v2/steps/QuickPickV2.test.js  (new)
      - client/src/pages/plan/v2/steps/DrinksV2.js
      - client/src/pages/plan/v2/steps/DrinksV2.test.js
      - client/src/pages/plan/v2/steps/YourBarPanel.js  (new, with the header comment)
      - client/src/pages/plan/v2/steps/SpiritsV2.js  (deleted)
      - client/src/pages/plan/v2/steps/ReviewV2.js
      - client/src/components/DrinkPlanSelections.js
      - client/src/components/DrinkPlanSelections.test.js
      - client/src/components/ShoppingList/answerSets.js
      - client/src/components/ShoppingList/answerSets.test.js
      - client/src/index.css  (the panel's pp2 rules only)
      - README.md  (generated sections, npm run docs)
      - ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: [fb-server]   # merge order only (see order)
    lenses: client (with captures of the drinks screen's panel in its three states and the first screen, at 320 and 390 wide, made by the session); seams. No tier A file.
    laws: a hosted plan never shows the panel and never gets the marker; the marker is never in DEFAULT_SELECTIONS; QUICK_PICKS in client/src/pages/plan/data/servingTypes.js and the legacy v1 wizard (PotionPlanningLab.js, client/src/pages/plan/steps/) are untouched; the planner asks no question it did not ask before; the opt-out copy names no price and no money and carries no em dash; the typed box's cap is the server's 80; the gap helper never names a gap for a picked cocktail it cannot find in the catalog; every save site builds its body through saveBody.js.
    seams: the contract above; the three family readers the spec names (ReviewV2 fixed here, the echo email fixed in fb-server, menuSections.js correct once one family is always empty); answerSets.js mirrors DrinkPlanSelections in listOnly mode, so both change together and both read barStyle.js's predicates.
    test plan: barStyle.test.js (the gap line's four branches with their exact copy, standard order, Bourbon and Rye as Whiskey, case, mocktails and custom requests covering nothing, an unknown picked id giving the can't-tell line; the switch moving and clearing each family pair in both directions, from full_bar to sig_beer_wine and to beer_wine and back, and leaving families alone for mocktails; the stamp carrying Scotch, Mezcal and spiritsOther once and never overwriting a non-empty barExtrasOther; the predicates against the contract's rules; the family pick by quick pick, including a draft with both families filled); saveBody.test.js (serving_type equals the quick pick; activeModules recomputed for a switched style; the hosted path's activeModules unchanged; the keepalive and draft bodies identical for the same state); queue.test.js (full_bar is quickPick, drinks, beerWine, crowd, menu, dayof, review; the other three styles and both hosted queues unchanged); QuickPickV2.test.js (three cards in order; a sig_beer_wine plan shows Full Bar selected; a tap calls the switch handler with the tapped style); DrinksV2.test.js (the panel on a BYOB full bar; absent on mocktails, on a hosted plan with a list owed, and on the hosted fallback; opt-out confirm then the switch to sig_beer_wine with the extras emptied; undo back to full_bar; the typed box's maxLength 80); DrinkPlanSelections.test.js and answerSets.test.js (on a marked full bar the extras lines present and the old Spirits and Mixers lines absent; on a marked opted-out plan neither; on a marker-less plan the old lines as today). The client build (CI=true) for the ESLint gate.
    revert: revert this lane and fb-server together, this lane first, in one push. Reverting this lane alone would leave drafts already carrying barExtras on the restored Spirits screen while fb-server's rules ignore those answers.
---

# Full bar by default: the lane map

Two lanes. `fb-server` carries the sanitizer, the list, the menu and the echo email, and is tier A because two of its files are on the sensitive list. `fb-planner` carries every screen the client and Dallas see, at the client tier. They share one contract (front matter) and are built side by side; the server merges first, because the planner without it would write keys the sanitizer drops.

The one piece of code that is a decision, the extras rule, as both predicate modules hold it:

```js
// a BYOB full bar that went through the new screens
servingType === 'full_bar' && Array.isArray(selections.barExtras)
```

## Lane fb-server

Acceptance checks, each run from the lane's worktree:

1. `node scripts/run-suites.js server/utils/barExtras.test.js server/routes/drinkPlans/submitPlannerV2.test.js server/utils/shoppingList.generator.test.js server/utils/menuDrinkSource.test.js server/utils/lifecycleEmailTemplates.test.js` plus `server/routes/drinkPlans/submitNotify.test.js` reports zero failures in every log, and each new case named in the test plan is present by name.
2. `grep -n "plannerServiceStyle" server/utils/barExtras.js` prints nothing, and `grep -n "barExtras" server/utils/shoppingListGen.js` shows the gate reading the row's `serving_type`, not the mapped style.
3. In `server/utils/shoppingList.js`, the chip step in the `full_bar` branch sits below the pars100 lines and above `mergeSignatureRecipes` (read; passes when the order holds).
4. `node scripts/testdb-smoke.js` passes (tier A).
5. `git diff main --stat` touches only the footprint; `npm run docs -- --check` reports nothing stale.

## Lane fb-planner

Acceptance checks, each run from the lane's worktree:

1. `cd client && CI=true npx react-scripts test --watchAll=false src/pages/plan/v2 src/components/DrinkPlanSelections src/components/ShoppingList/answerSets` passes with the new cases present by name.
2. `cd client && CI=true npx react-scripts build` exits 0.
3. `grep -rn "SpiritsV2" client/src` prints nothing; `grep -n "barExtras" client/src/pages/plan/v2/PlannerV2.js` shows no entry inside `DEFAULT_SELECTIONS`; every `axios` save call in PlannerV2 takes its body from `saveBody.js` (read; passes when all three do).
4. `git diff main -- client/src/pages/plan/data/servingTypes.js client/src/pages/plan/PotionPlanningLab.js client/src/pages/plan/steps` is empty.
5. A browser walk on a dev server cut from main with fb-server merged, each step read back from the dev database:
   - A BYOB plan through the new planner on a full bar, the Scotch chip and a typed extra, submitted: the row's `serving_type` is `full_bar` and its selections carry both keys; the admin shopping list shows the Scotch par line and no typed line; the list modal's answers panel and the recap show the request and no Spirits line.
   - A second plan opted out on the drinks screen after its Beer & Wine answers: the gap line names its gaps; the row's `serving_type` is `sig_beer_wine` with the beer and wine picks in the beer and wine family only; Review shows "Just your drinks, plus beer and wine". Then Back to the first screen: the Full Bar card shows selected; tapping it restores the full bar panel, and the row's picks are back in the full bar family only.
   - A hosted plan opened in the planner shows no panel, and its saved selections carry no `barExtras`.
   - Not walked, by design: the echo email's text, because the dev server does not send email (`SEND_NOTIFICATIONS` defaults off outside production, and the local `.env` does not turn it on); fb-server's submitNotify case proves the real `serving_type` reaches it.
6. `git diff main --stat` touches only the footprint; `npm run docs -- --check` reports nothing stale.

## Order and the push

Per `order` above. Both lanes reach production in one push on Dallas's cue; a push carrying only `fb-server` is inert (no client writes the keys), and one carrying only `fb-planner` cannot happen under the merge order.
