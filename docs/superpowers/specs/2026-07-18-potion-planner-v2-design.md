# Potion Planner v2, Enhancement Lab, and the Package Model

**Spec date:** 2026-07-18 (brainstormed 2026-07-16 through 2026-07-18)
**Status:** Approved section by section in brainstorm. Ready for plan decomposition.
**Sources:** Client feedback log (`win-share/Potion_Planner_Client_Feedback.md`), full planner code audit (2026-07-16), package pricing review against `All-inclusive per person costs.xlsx` (directional only, not truth), prod sales data.

---

## 1. Why

The live planner audit and the client feedback file converge on four root problems:

1. **Selling is tangled into planning.** Upsell radios that look required (Sid Khaitan), payment fused into the confirmation step (Anna Simpson, Julia Frye), and the extras_plus_balance scenario that blocks drink submission behind balance payment.
2. **Hosted clients can order outside their package silently.** Mocktails carry no package-gap logic at all (the Jack Van Dyke case), forcing after-the-fact no/free/pay compromises.
3. **The planner collects ambiguous or dead data.** "Not sure" stored as null (indistinguishable from unanswered), the balance question never consumed by the shopping-list generator, custom drinks captured as bare strings with no ingredients.
4. **Package contents are prose, not data.** Four disagreeing sources of truth (cost sheet, marketing page, DB seed, owner's head). Formula No. 5 shipped without citrus and nothing noticed.

## 2. Principles (decided)

- **The planner gathers information. The Enhancement Lab sells.** The planner never shows a card field and never blocks submission on money.
- **Disclosure rule:** the planner never takes payment, but any choice that creates a charge says so at the moment of choice (parking fee precedent; hosted fence picks). Charges land on the balance via existing invoice machinery.
- **Need vs want:** charges that are part of delivering the drinks the client chose live in the planner (fence picks). Optional enhancements live in the Enhancement Lab.
- **Variants are drinks, not options.** A spicy margarita is a new recipe row, not a customization matrix. The recipe database is the variant engine.
- **The recipe card is the single source of truth for a drink.** Ingredients, amounts, enhancement eligibility, pitches, bubble flavors, syrup link, batchable flag, visibility. Hardcoded JS data files (`drinkUpgrades.js` applicability maps, `DRINK_SYRUP_MAP`) migrate into the DB and are deleted.
- **Package contents are structured data.** Marketing prose (`includes`) stays a separate display field and never drives logic.
- **Protect working money paths.** No new payment surfaces. Invoice-only everywhere. Reuse the extras-invoice and balance machinery untouched.

## 3. Client surfaces

### 3.1 BYOB planner flow

Steps: Welcome, Quick Pick, Drink Picking, Bar Stocking, Crowd Questions (new), Menu Design, Day-Of Details, Review and Submit.

- **Welcome:** unchanged in structure (it is the strongest screen). Copy updated for honest step count.
- **Quick Pick:** four presets. **Custom Setup is deleted.** Degenerate combos route through Full Bar's existing None/skip answers (verified: the Cathy Murphy case is expressible).
- **Drink Picking:** uninterrupted fun. No syrup radios, no upsell panels, no source toggles, no dollar signs. Custom drink requests stay as free text and feed the admin recipe flow (merged 2026-07-16, c0495f7). The 2 to 4 drink guidance and over-selection warning stay.
- **Bar Stocking (spirits / beer / wine):** as today, with fixes: one shared vocabulary per flow (no "Mostly Cocktails" in beer-and-wine-only), and "not sure yet" becomes a real stored value distinct from unanswered, everywhere.
- **Crowd Questions (new, one screen):** (a) "About how many of your N guests drink?" (carries real weight in quantity math), (b) the balance question (light weight only, hosts guess). Both consumed by the generator; asking questions we do not use is banned.
- **Menu Design:** as today minus the duplicate selections recap.
- **Day-Of Details:** parking, day-of contact, access notes, plus the promised-but-never-asked items: bar placement (indoor/outdoor) and power access. Champagne toast moves out (to Enhancement Lab). Coolers question deleted (derivable). Toast timing asked when the toast add-on exists.
- **Review and Submit:** summary, "anything else?" box, submit. **No payment section, ever.** Celebration screen gains the Enhancement Lab CTA. Confirmation email echoes full selections (kills "did you get my info?").
- **Required to submit:** at least one drink or an explicit none, crowd questions, parking, day-of contact. Everything else optional.

### 3.2 Hosted planner flow

Far fewer questions: package already answered them. Steps: Welcome (hosted variant), Drink Step (shape per package), Crowd Questions (preference-framed: red vs white lean, IPA vs light crowd; never "what should we buy"), Menu Design, Day-Of Details, Review and Submit.

**Drink step takes one of three shapes, chosen by package config:**

1. **Slot picker** (Base Compound: hard 2; Clear Reaction: featured 4). Hard slots mean the picks ARE the bar (Base has no open spirits). Featured slots mean the picks headline the menu and the bar improvises beyond them. Clear Reaction copy: "we stock the basics plus what your picks need, so your bartender can improvise beyond the menu, just like a real bar." Never promise the whole syrup lab.
2. **Coverage browser** (Midrange, Enhanced, Formula No. 5, Grand). Two tiers: "Included in your package" (computed: every recipe ingredient resolves to covered package contents) and a visibly fenced "Available as an add-on" tier with real per-guest prices on the badge. Picking a fenced drink is allowed; the price tag is the disclosure; the charge lands on balance at submit. Mocktails get identical gap treatment (closes the Jack hole).
3. **Display-only** (all beer and wine tiers). "Here's your bar" confirmation showpiece. No picking. Taste-preference questions only where the package says rotating/craft.

**The fill-recipes flywheel:** hosted in-tier lists are computed over ALL active recipes, not just the BYOB menu. Adding simple call-drink recipes (whiskey sour, gimlet, daiquiri) instantly enriches every package whose contents cover them. Per-recipe hosted-visibility toggle to hide oddballs. Owner intends to author fill recipes to make tiers look generous at zero marginal cost.

**Mocktail rule on non-mocktail hosted packages:** one flavor = pre-batched mocktail add-on ($2/guest). Two or more = the fence flips to the full Mocktail Bar add-on at its price. "Limited quantities" goodwill stays a manual discount, never implied by the planner.

**No advertised batch-signature slots on Midrange and up.** Management-discretion goodwill only. Flavored signature cocktails are always fenced add-on territory on hosted tiers.

### 3.3 The Enhancement Lab (new surface)

- **Access:** same drink-plan token, own route. Entry: celebration CTA ("Your formulas are filed. Care to enhance them?" / button "Enter the Enhancement Lab") plus one follow-up email a day or two later, only if the window is open and nothing was added. Email rides the existing scheduled-message dispatcher.
- **Window:** closes at shopping-list approval. After close: read-only "locked in" summary.
- **Page order:** (1) balance banner when money is owed (due soon: visible line + pay link out to invoice; past due: leads the page; never blocks), (2) per-drink flair cards against the client's actual drinks by name, one tap add/remove, real prices, nothing pre-checked, (3) housemade syrup upsell (see below), (4) event extras: champagne toast (serving style + coupe nested; quiet and classy presentation on Formula No. 5 and Grand: "classy, never carnival"), real glassware, NA add-ons and the soft-drink add-on for hosted (ginger ale's new home), (5) running total + "Everything here is added to your event balance. No payment now."
- **Syrups are a pure upsell, no fork UI.** BYOB: a drink's syrup goes on the shopping list automatically, silently. The Lab pitches: "Upgrade to our housemade [flavor] syrup, hand-crafted in the lab, +$X." Adding flips it off the client list onto prep. Declining changes nothing. Hosted needs no special case (flavored-syrup drinks are already fence-priced).
- **Invoice-only.** No card fields. Everything is a line item through the existing extras/balance invoice machinery. Payment happens on existing invoice surfaces.
- **Data-driven:** enhancements come from DB (recipe enhancement assignments + addon pricing). Craft ice later = new rows, no code.
- **Tone:** apothecary lab voice throughout.

### 3.4 Shopping list rendering

- Plain-language quantities with derivation available ("3 x 1.75L bottles, about 90 margaritas worth").
- The padding sentence, verbatim principle: "Quantities are rounded up so you never run out. Unopened bottles can be returned." Generosity explained, not mysterious.
- Wrong-file class of error already dead (server-generated, approval-gated, token-served). This spec only upgrades the rendering.

## 4. Data model

### 4.1 Recipes (drinks tables)

- Ingredient rows: par_item reference (alias-resolvable) + amount + unit, **amount optional per ingredient** (missing amount falls back to par scaling; partial data degrades gracefully).
- Enhancement assignments: which upgrades apply, per-drink pitch copy, bubble flavor options.
- Linked housemade syrup product where relevant.
- Flags: batchable, active, hosted-visible, BYOB menu category (existing).
- Migration: one-time script moves `drinkUpgrades.js` applicability/pitches/bubbles and `DRINK_SYRUP_MAP` into DB; files deleted.
- **The owner's recipe pass happens once, against this schema, in the recipe drawer.** This spec is the reason the pass was deferred.

### 4.2 par_items

- Gains a cost column (owner's Mixer sheet imports nearly verbatim). Cost feeds margin readouts and (parked) swap math.

### 4.3 Package contents (new structured mapping)

- Per package: **category pars** ("tequila: 4 bottles per 100 guests") with **eligible bottles per category** (split pars: multiple labels share category volume; "for show" never multiplies cost).
- Slot config: hard slot count (Base 2), featured slot count (Clear 4), none elsewhere.
- Covered generic classes ("one red wine") alongside specific bottles.
- `includes` prose stays display-only.
- Coverage computation: a drink is in-tier when every recipe ingredient resolves to covered package contents. Gap = uncovered classes, priced via class-to-addon mapping (existing `service_addons`, e.g. craft_ingredients rows).

### 4.4 Quantity engine

- Expected pours = drinkers (from crowd question) x hours x pace constant.
- Category split nudged **gently** by the balance answer (light prior; hosts guess). Within category: explicitly even split across drinks (popularity is unknowable; the math never pretends).
- Buffer multipliers per role (spirits vs mixers vs garnish), tunable in settings, then round up to purchasable units. Buffers are policy the owner owns.
- Owner's say, twice: global knobs + per-event editable quantities at the existing approval gate.

## 5. Package lineup changes (decided 2026-07-18)

| Package | Decision |
|---|---|
| Base Compound $18/$23 | Keep unchanged. Budget anchor. Hard 2-signature slots. Low conversion is acceptable; it anchors the ladder. |
| Midrange Reaction $22/$27 | Keep; the happy decoy. Add bitters + simple syrup (Old Fashioned works). Ginger ale out. Scotch out (5 spirits). |
| Enhanced Solution $28/$33 | The pitch tier (Tito's effect). JW Red out, scotch out (5 spirits). Ginger ale out. Wine slims to 1 red, 1 white, sparkling stays. |
| Formula No. 5 $33/$39 | Add lemon + lime juice (margaritas legal). No sparkling; champagne toast add-on pushed classy on this tier. Bulleit stays. |
| Grand Experiment $40/$46 | The showpiece; abundance is the product. Split pars encoded (category volume shared across labels). Maker's Mark replaces Bulleit. Keeps both vodkas, both tequilas, three whiskeys (incl. Monkey Shoulder: scotch lives only at the apex), four wines + sparkling, craft rotation, ginger beer (mules; ginger BEER is exempt from the ginger-ale purge). |
| Refined Reaction | **Retired.** Never quoted once; niche sits $1 under Carbon. |
| Primary Culture $12 / Carbon Suspension $15 / Cultivated Complex $17 | Clean 3-step beer-and-wine ladder. Carbon wine slims to 1 red, 1 white. Seltzer is the feature people pay for; it stays at Carbon and up. Cultivated keeps its spread (inherits "for show" at this ladder's top). |
| Clear Reaction $14/$18 | Keep. Featured 4 slots; basics + picks' ingredients enable improvisation; still feels like a bar. |
| Cross-cutting | Ginger ale exists only on the soft-drink add-on (its buyers don't drink). All prices hold. Sales note: F5/Grand were never quoted due to quoting habit, not client rejection. |

Package edits are applied in the DB directly (seed is INSERT-DO-NOTHING; admin dashboard is source of truth) plus the marketing/wizard page copy.

## 6. Admin surfaces

1. **Recipe drawer v2** (extends c0495f7 drawer): full dossier per section 4.1. **Design in claude.ai/design first (DRB OS system).**
2. **Package contents editor** (new tab): category pars, eligible bottles, slots, covered classes, live margin per package at any guest count. Self-serve package changes with no code. **Design in claude.ai/design first.**
3. **Makeability preview:** pick a package, see every drink sorted in-tier / fenced-with-price / unmakeable. The sanity-check surface after any recipe or package edit.
4. **Quantity review** (upgrade of existing shopping-list approval): demand derivation shown, buffer knobs, editable quantities. Approval still closes the Enhancement Lab window. **Design in claude.ai/design first.**
5. Client surfaces (planner v2, Enhancement Lab) designed on the Apothecary system, per-surface prompt docs per the established reskin workflow.

## 7. Rollout (conservative, per owner)

- New tokens get the new planner. In-flight drafts finish on the legacy wizard until drained, then legacy code deletes. No forced migrations.
- Enhancement Lab email = new scheduled-message type on existing dispatcher.
- No changes to payment plumbing anywhere.

## 8. Ride-along fixes

Most audit findings die in the rewrite (null "not sure", truthy-mixers misreport on MenuDesign, "Mostly Cocktails" in beer-wine flows, duplicate summary, upsell dark patterns). Explicit surviving line items:

- Submitted-email selections echo.
- Welcome step-count honesty; roadmap promises match asked questions (bar placement, power).
- Toast timing question when champagne toast is added.
- Admin Menu-tab "[object Object]" cosmetic fix.

## 9. Parked / out of scope

- **Swaps** (bottle upgrades, add-a-category): parked entirely per owner 2026-07-18. Data model (par costs + category pars) keeps it a cheap future add. Curated-list-only if ever built; never free-form.
- **Client-browsable package catalog** with guest count pre-filled ("browse the options with their details set"): separate project; pairs with proposal-options/compare.
- **Day-of payment enforcement / dunning policy** (staff nagging at events): adjacent, not planner design. Balance banner + Lab email are this project's only contributions.
- Shopping-list generator internals beyond the quantity engine inputs (rendering + weights only here).

## 10. Open items

- Owner recipe pass (approx. 40 drafts + new fill recipes) after recipe schema lands. Blocks hosted coverage browser going live.
- Enhanced/Grand `includes` bullets pinned to real bottle lists during package-editor data entry.
- Pace constant + default buffers: owner sets initial values at quantity-review build time.
