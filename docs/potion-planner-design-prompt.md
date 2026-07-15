# Design prompt: Potion Planning Lab rework (`/plan/:token`)

> Per-surface prompt for a repo-linked claude.ai/design session. Read `DR_BARTENDER_REDESIGN_BRIEF.md` first and obey its §2 hard rules, with ONE explicit carve-out: unlike the pure-reskin prompts, this session is a WHAT-SHOULD-THIS-FLOW-BE exploration. Step structure, step count, question wording, and disclosure patterns are all in play. Routes, endpoints, the selections data contract, and the money math are NOT (see "What must not change"). The visual system already landed here and the operator likes it; this is a comprehension redesign wearing the existing skin, not a new skin.
>
> Closest design-system project on claude.ai/design: **Dr. Bartender — Apothecary Design System** (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`). The planner renders on the app's base `:root` tokens in `client/src/index.css:26-92`, which ARE the apothecary press look (IM Fell, parchment cards on Midnight Ink, teal + brass). It never receives the admin After Hours skin: single skin, no theme toggle.

## Why this surface, in the operator's words

The operator loves the surface ("the last of the Fable love: I love it") but: **"it confuses my clients too often."** Preserved symptom from 2026-07-13: clients get confused, want phone calls, and **think they chose something different than what got recorded.** From his fix-list dump, verbatim: "need better questions about balance, (ie spirit forward, wine lovers, etc...)". A real client (Angel Davis, July 2026) went to pay her balance and believed the system was "making her do the potion planner again" (the CTA routing bug is fixed; the deeper lesson stands: clients cannot always tell what this page is for, what is saved, and what is owed).

The stakes: this is the single most-used client-facing working surface. Every booked client is nudged into it by email + SMS at T-21 days. What it records drives the shopping list, the printed menu, the BEO, and real Stripe charges.

## What it is

A public, unauthenticated, token-gated wizard where a booked client designs the bar for their event: picks drinks, flavors, menu design, day-of logistics, then submits. Route `/plan/:token` where `:token` is the DRINK-PLAN token (`drink_plans.token`, NOT the proposal token; they look identical, a classic operator trip-wire). Mounted 4x in `client/src/App.js:334,403,461,488` (host-based routing; same page on every host).

How clients arrive:
- T-21-day nudge email + SMS (`server/utils/drinkPlanNudge.js`, offset at :45-46, URL from the drink-plan token at :147,159)
- Client portal: `client/src/pages/public/portal/tabs/PotionTab.js`, `portal/nextUp.js`, `ProposalView.js:636`
- Admin "Resend planner link" (`server/routes/drinkPlans.js:701`) and copy-link on the event card (`client/src/components/DrinkPlanCard.js:106`)

Lifecycle: `drink_plans.status` is `pending → draft → submitted → reviewed` (CHECK at `server/db/schema.sql:345-346`; `exploration_saved` is a legacy value). Pre-booking, the API returns `{locked: true}` and the page shows "unlocks after you book" (`PotionPlanningLab.js:673-698`). Post-submit the wizard is read-only (submit-once gate, `server/routes/drinkPlans/submit.js:90-92`); reopening for edits is a separately parked project (drink-plan edit lock, Option A in the fix-list doc).

Law (CLAUDE.md): **event-side drink plan is canonical, proposal-side is preview.** Admin reviews submissions on the event card; the shopping list is generated from `selections`, edited and approved by admin, then served back to the client at a separate page.

## The current flow (state machine)

Orchestrator: `client/src/pages/plan/PotionPlanningLab.js` (998 lines). Steps are lazy-loaded chunks.

```
welcome ──► quickPick ──► [module queue] ──► confirmation ──► submitted
              │  ▲
              └─ customSetup (only when "Fully Custom" picked)

Hosted packages and mocktail-only packages SKIP quickPick entirely:
the queue is derived from package_bar_type (PotionPlanningLab.js:249-255).
```

The module queue is built from `activeModules` flags (`data/servingTypes.js:63-79`):

| Entry choice | Queue |
|---|---|
| Full Bar Experience | signature → mocktails → fullBarSpirits → fullBarBeerWine → menuDesign → logistics |
| Signature + Beer & Wine | signature → mocktails → beerWine → menuDesign → logistics |
| Beer & Wine only | beerWine → menuDesign → logistics |
| Mocktails only | mocktails → menuDesign → logistics |
| Fully Custom | customSetup derives flags from 5 toggles (`CustomSetupStep.js:33-38`) |
| Hosted full bar | signature → mocktails → hostedGuestPrefs → menuDesign → logistics |
| Hosted beer & wine / mocktail | mocktails → hostedGuestPrefs → menuDesign → logistics |

Cross-cutting mechanics:
- **Autosave**: on every Next, plus a silent 30s interval, plus a keepalive PUT on tab close (`PotionPlanningLab.js:302-351`). A pulsing brass save dot shows Saving / Saved / "Draft may not be saved" (:960-972).
- **Browser back is intercepted** to navigate steps instead of leaving (:270-288).
- **Progress**: "Step N of M" + a thin segmented tick rail (:936-954). Welcome/quickPick/customSetup are uncounted, so M changes after the client makes their first choice.
- **Legacy migration shims on load** (:163-243): flat syrup array to per-drink map, `customMenuDesign` boolean to 3-value `menuStyle`, exploration-era favorites, per-drink addon inference. These stay; any redesign must tolerate old drafts.

## File map

Client (the design surface):

| File | Lines | What it is |
|---|---|---|
| `client/src/pages/plan/PotionPlanningLab.js` | 998 | Orchestrator: fetch, state, autosave, queue, nav, progress, submitted screen |
| `steps/RefinementWelcomeStep.js` | 59 | Welcome card, "Start" CTA |
| `components/WelcomeRoadmap.js` | 74 | The "3 Parts" procedure roadmap (non-clickable) |
| `steps/QuickPickStep.js` | 42 | 5-card serving-type fork (BYOB only) |
| `steps/CustomSetupStep.js` | 85 | 5 toggles that derive activeModules |
| `steps/SignaturePickerStep.js` | 665 | Cocktail picker: category tabs, Your Menu, custom free-text, cost summary |
| `steps/MakeItYoursPanel.js` | 432 | Per-drink syrups + flair upgrades, DRB-vs-shopping-list radios, locks/caps |
| `steps/MocktailStep.js` | 241 | Mocktail picker + notes |
| `steps/FullBarSpiritsStep.js` | 156 | Spirits multi-select + mixers yes/no/undecided |
| `steps/FullBarBeerWineStep.js` | 170 | Beer/wine checkboxes + balance radio (fullBar key family) |
| `steps/BeerWineStep.js` | 172 | Near-duplicate of the above (beerWine key family) |
| `steps/HostedGuestPrefsStep.js` | 134 | Hosted balance radio + NA interest + paid NA add-ons |
| `steps/MenuDesignStep.js` | 258 | Selections recap + menu style (custom/house/none) + theme/naming/notes |
| `components/MenuPreview.js` | 372 | Inline-styled dark menu card, screen + print variants |
| `components/LogoUploadField.js` | 109 | Logo upload (writes to server immediately, separate save path) |
| `steps/LogisticsStep.js` | 359 | Day-of contact, parking, equipment, bar rental, champagne toast, notes |
| `steps/ConfirmationStep.js` | 800 | Full recap, estimated extras, Stripe payment scenarios, submit |
| `components/ScopeBanner.js` | 23 | shopping/hosted/aside tone banner with wax-seal glyph |
| `data/servingTypes.js` | 114 | QUICK_PICKS, module order, queue builders (BYOB + hosted) |
| `data/drinkUpgrades.js` | 165 | Upgrade catalog: applicability, caps, requires-addon locks, pitches (no prices) |
| `data/packageGaps.js` | 40 | Hosted coverage math (gap slugs, per-guest gap cost) |
| `data/menuSections.js` | 73 | Printed-menu section extractor (merges both beer/wine key families) |
| `client/src/data/syrups.js` | 297 | Syrup catalog + 3-pack bottle/pricing helpers |

Server (context; NOT to be redesigned, listed so the session reads the contracts):

| File | Lines | Role |
|---|---|---|
| `server/routes/drinkPlans.js` | 779 | Public GET/PUT `/t/:token`, logo routes, admin CRUD/shopping-list/approve/resend-nudge |
| `server/routes/drinkPlans/submit.js` | 630 | `sanitizeSelections` allow-list (:28-42), autosave fast path, submit money path |
| `server/routes/drinkPlans/regenerate.js` | 77 | Admin shopping-list regenerate (read-only preview) |
| `server/utils/drinkPlanNudge.js` | 249 | T-21 nudge email/SMS + suppression + durable `nudge_suppressed` |
| `server/utils/drinkPlanExtras.js` | 93 | `computeExtrasBreakdown`: the ONE source of extras math (charge + invoice) |
| `server/utils/shoppingListGen.js` | 297 | Generator input builders; `matchCustomNames` exact-match + `needsRecipe` (:109-125) |
| `server/routes/stripe.js` | | `POST /create-drink-plan-intent/:token` (:34), archived-event 409 guard (:68-73) |

CSS: the authoritative block is `client/src/index.css:13272-14241` (~970 lines, all scoped `.potion-app`), plus shared `.btn`/`.card`/form-control families it re-polishes. Namespace `potion-*` must survive (brief §2.1).

## Data contract (LAW: structure frozen, presentation free)

`drink_plans.selections` JSONB. The server drops any key not in `ALLOWED_SELECTIONS_KEYS` (`server/routes/drinkPlans/submit.js:28-42`). Current keys the wizard writes:

- Drinks: `signatureDrinks` (cocktail ids), `signatureDrinkSpirits`, `customCocktails` (free-text strings), `mocktails` (ids), `mocktailNotes`
- Full bar: `spirits`, `spiritsOther`, `mixersForSpirits` (true/false/null "not sure yet"), `mixersForSignatureDrinks`
- Beer/wine, TWO parallel families: `beerFromFullBar`/`wineFromFullBar`/`wineOtherFullBar`/`beerWineBalanceFullBar` and `beerFromBeerWine`/`wineFromBeerWine`/`wineOtherBeerWine`/`beerWineBalanceBeerWine`
- Hosted: `guestPreferences` `{balance, naInterest}`
- Flavor/money: `syrupSelections` (per-drink map), `syrupSelfProvided`, `addOns` (`{slug: {enabled, drinks[], autoAdded, triggeredBy[], servingStyle, bubbles}}`)
- Menu: `menuStyle` ('custom'|'house'|'none'), `menuTheme`, `drinkNaming`, `menuDesignNotes`, `companyLogo`
- Logistics: `logistics` `{dayOfContact{name,phone}, parking, equipment[], equipmentOther, accessNotes, addBarRental}`
- Misc: `additionalNotes`, `activeModules`, plus read-only legacy keys

New keys are allowed but must be ADDED to the allow-list in the same change, and every consumer must be checked: the shopping-list generator, `DrinkPlanSelections.js` (admin display), `menuSections.js` (printed menu), `drink_names` enrichment (`server/routes/drinkPlans.js:303`). There is deliberately NO `customMocktails` key today (consult-side only); adding one is a known candidate but it is a cross-system change, not a design-file edit.

Add-on pricing arrives as `[{slug, name, rate, billing_type}]` from `GET /proposals/public/addons`; `billing_type` is `per_guest` or flat. Steps compute `rate x guestCount` at render. No price is ever hardcoded in step copy.

## The money paths (handle with gloves)

1. **Submit with extras** (`submit.js:117-477`): one transaction reprices the proposal (`calculateProposal`), can demote paid-in-full and disarm autopay, and either refreshes the balance invoice or creates a separate "Drink Plan Extras" invoice when the client pays now.
2. **Pay-now Stripe intent** (`stripe.js:34`): public, token-gated, three scenarios surfaced on ConfirmationStep: `extras_plus_balance` (past-due balance MUST ride along), `extras_required`, `extras_optional` (radios: Pay Now / Pay Extras + Balance in Full / Add to My Balance). Amount math is shared with invoicing via `computeExtrasBreakdown` so charge and invoice cannot drift. 409 guard rejects archived (cancelled) events.
3. **Auto-added paid add-ons**: hosted package gaps (`SignaturePickerStep.js:81-107`) and the parking-fee dropdown (`LogisticsStep.js:44-56`) write to `addOns` as a side effect of seemingly descriptive choices.

The design may re-present all of this freely (and should; see below) but the scenarios, endpoints, and amounts are law.

## What it looks like today (so the session can picture it before running it)

Apothecary press, single skin: Midnight Ink page (#12161C) with film-grain noise and a faint radial teal/brass glow; parchment cards (2px brass border, paper-grain texture, IM Fell headings in deep brown); Deep Apothecary Teal (#1D8C89) as the selected/CTA color; antique brass (#B8924A) for hairlines, kickers, seals; dusty plum for upgrade chips and hovers. Key set pieces:

- Welcome card with an embossed-medallion "procedure" roadmap: a done-checkmark "Booking confirmed" node then Parts One/Two/Three joined by dashed brass lines, and one loud teal Start button
- Thin segmented progress rail under a letterspaced "STEP N OF M" counter (no labels, never collapses)
- Serving-type and drink tiles: parchment cards with emoji tokens in brass rings, teal selection state with an animated frame draw-in
- "Your Menu" rows: brass-tinted list with IM Fell numbers and plum upgrade pills
- Scope banners with a round wax-seal glyph in three tones (brass = feeds your shopping list, teal = hosted "we bring it", ghost = aside)
- A pulsing brass save-dot ("Saving... / Saved / Draft may not be saved")

Two facts the session should exploit:
1. **A large confirmation/celebration CSS block is fully built and UNWIRED** (`index.css:14028-14194`: `.conf-leader` dotted leader rows, `.conf-total` brass seal total, `.pay-radio` cards, `.potion-submitted` panels, `.potion-blocking`, `.potion-spinner`). The live ConfirmationStep uses plain `.card`/`.btn` with inline styles instead. The prettiest money UI in the codebase was never mounted; the confirmation redesign can start from it or replace it, but do not leave it half-dead again.
2. **Mobile is fluid but never adaptive**: fixed 40px/44px icon columns on the roadmap and scope banners, no small-screen rules for the procedure list, and the rail is a bare bar at all widths. Most clients open the nudge SMS on a phone.

## Known confusion inventory (ranked, verified against code)

1. **Silent paid auto-adds.** Tapping a hosted-gap cocktail attaches a recurring per-guest charge disclosed by a toast and a small `+$X/guest` badge that is never multiplied out (`SignaturePickerStep.js:81-107,593-611`). Choosing "Paid parking required" (a factual venue description) auto-adds a per-staff fee with the consequence text appearing only after selection (`LogisticsStep.js:44-56,155-160`). This is the closest mechanical match to "clients think they chose something different than recorded."
2. **"Estimated" recap vs exact Stripe charge.** The confirmation panel labels everything Estimated with a "final pricing will be confirmed" footnote, then charges an exact amount on "Pay $X & Submit" (`ConfirmationStep.js:536-624,764`). The optional-payment radios also mix the unrelated event balance into the drink-plan moment, and "Add to My Balance" submits without paying, which reads ambiguously as paid.
3. **The "Liquor" toggle secretly means the full-bar path** (`CustomSetupStep.js:33-38`): checking Liquor makes the independent Beer and Wine toggles inert with no indication, and nothing shows that toggles change how many screens follow.
4. **Two near-duplicate beer/wine screens** write different key families for identical-looking questions (`FullBarBeerWineStep.js` vs `BeerWineStep.js`), and their third card asks a "balance" question with different titles ("Guest Preferences" vs "Beer & Wine Balance") whose options include "Mostly Cocktails" on a beer-and-wine screen.
5. **Syrup source radios are money decisions dressed as style choices** ("Hand-crafted by Dr. Bartender" vs "Add to my shopping list", `MakeItYoursPanel.js:168-204`), with prices hidden once selected and "(included)" appearing inconsistently when a proposal syrup already covers a drink.
6. **The roadmap promises "Three parts, just a few minutes"** while the real queue runs 4 to 7 steps and the step counter's M shifts after the first choice (`WelcomeRoadmap.js`, `PotionPlanningLab.js:653-657`).
7. **The balance questions are the wrong questions** (the operator's #2 complaint): three different single-radio "balance" prompts exist (`beerWineBalanceFullBar`, `beerWineBalanceBeerWine`, `guestPreferences.balance`) and none ask what he actually wants to know: spirit-forward crowd? wine lovers? light drinkers? The redesign should propose one coherent guest-profile ask and say where its answer lands in `selections`.
8. **Custom drink free-text sets no expectation.** Entries match the recipe book by normalized EXACT name only; a miss silently becomes a "needs recipe" item the bar lead sources later (`shoppingListGen.js:109-125`). The client sees "we'll do our best." A fuzzy typeahead against the live cocktail/mocktail catalog (public GETs already feed the page) is the long-planned fix; mocktail custom entries have nowhere to go at all (notes only).
9. Smaller: the Smoke Bubble upsell chain (bubble needs glassware, glassware costs money, capped at 100 guests) is revealed through a lock message (`MakeItYoursPanel.js:331-367`); "Skip Mocktails" next to "Continue to Mocktails" with unclear permanence (`SignaturePickerStep.js:563-570`); logo upload saves immediately on a different path than everything else (`LogoUploadField.js:31-33`); the 400ms artificial delay on quick-pick cards reads as a frozen UI (`QuickPickStep.js:8-13`); three "don't repeat yourself" notes helpers patch over scoping the form never makes self-evident.

## Design opportunities (where to spend the effort)

- **One disclosure pattern for money.** Every dollar consequence (gap add-ons, parking, champagne, syrups, NA add-ons) should surface the same way at the same moment, with per-guest math multiplied out, and persist after selection (a running "your extras" ledger is a natural apothecary artifact: an itemized receipt/manifest). The unwired `.conf-leader`/`.conf-total` CSS is already the right visual language.
- **An honest map.** Roadmap and progress should reflect the client's actual queue once known, and the recap should make "what we will actually pour / buy / print" unmistakable. The confirmation step is the trust moment: it should read like a checkable document, not a summary blur.
- **The guest-profile question.** Replace the three scattered balance radios with the questions the operator wishes he could ask (spirit-forward, wine lovers, mix). Keep it to one screen.
- **Custom drinks that teach.** Typeahead against the live menu, clear "we found it" vs "our bar lead will source this" states, and a home for custom mocktails (flag: requires the cross-system allow-list + generator change; design it, note the dependency).
- **Phone-first.** Design every screen at 390px first; the nudge SMS is the front door.
- The brief's posture for this surface holds: sparse and clear, apothecary recedes while the client is working. One restrained magical-realism moment maximum per screen; the save-dot pulse and the wax seals already spend most of that budget.

## What must not change (hard)

1. Endpoints, methods, token semantics, and the autosave cadence (Next + 30s silent + beforeunload). The wizard must keep tolerating legacy drafts via the load shims.
2. The `selections` allow-list contract: additive only, with every consumer updated in the same change (generator, admin display, menu extractor, drink_names enrichment).
3. All three Stripe scenarios and the shared `computeExtrasBreakdown` math; the archived-event 409; submit-once; the proposal reprice/reconcile transaction.
4. `potion-*` class namespace, vanilla CSS in `client/src/index.css`, no new deps, no Tailwind (brief §2.1).
5. Accessibility primitives: the save indicator's role/aria-live wiring, reduced-motion guards, keyboard paths.
6. No em dashes in client copy. NA beer copy is Athletic Brewing only, never Heineken 0.0.
7. Do not absorb the adjacent queued projects: the admin Menu design page (consumes `menuStyle`/`menuTheme`/`drinkNaming`/`menuDesignNotes` downstream) and the drink-plan edit lock (post-submit reopen). Design seams to them, not solutions for them.

## Previewing / definition of done

- Mock data is fine for design previews (a hosted plan with gaps, a BYOB full-bar plan, and an extras_plus_balance payment scenario cover the hard cases); shipped code keeps the real fetches exactly as they are.
- The Vercel gate is `cd client && CI=true npx react-scripts build` (warnings fail it).
- Smoke at 390px and desktop on every step variant (BYOB full bar, beer/wine only, mocktails only, hosted full bar, hosted beer & wine), plus the locked, error, and submitted terminal states.
- The submit money path is sensitive: any change touching `ConfirmationStep.js`, `submit.js`, or the intent route gets the full review fleet per CLAUDE.md.
