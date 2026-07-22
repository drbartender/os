# Design prompt: Potion Planner v2 (`/plan/:token`)

> Per-surface prompt for a repo-linked claude.ai/design session. Read `DR_BARTENDER_REDESIGN_BRIEF.md` (repo root) and obey its §2 hard rules. **The flow decisions are already made**: this session executes `docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md` §3.1 and §3.2, which supersedes the earlier what-should-this-flow-be exploration this file used to carry (git history has it). Screens, layout, copy, and interaction design are in play; the flow structure, data contract, and money doctrine are law from the spec.
>
> Design-system project: **Dr. Bartender — Apothecary Design System** (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`). The planner renders on the app's base `:root` tokens in `client/src/index.css:26-92` (IM Fell, parchment cards on Midnight Ink, teal + brass). Single skin, no theme toggle. `potion-*` class namespace must survive; the authoritative CSS block is `client/src/index.css:13272-14241`, all scoped `.potion-app`.

## The one-sentence brief

The planner becomes pure, fun information gathering: **zero dollar signs except disclosure notes, no payment section, no upsells** (selling moved to the Enhancement Lab, its own surface and prompt). Every question visibly earns its place.

## What changed from the live flow (spec is authoritative; this is the delta list)

**Deleted outright:** Custom Setup quick-pick, the Make It Yours per-drink panel (syrup radios, flair upsells, source toggles), the entire Stripe/payment section on confirmation, champagne toast in logistics, the coolers question, the duplicate selections recap on Menu Design.

**BYOB flow:** Welcome → Quick Pick (4 presets) → Drink Picking (uninterrupted; free-text custom requests stay) → Bar Stocking (spirits / beer / wine, one shared vocabulary, "not sure yet" is a real value) → **Crowd Questions (new screen)** → Menu Design → Day-Of Details → Review & Submit → Celebration.

**Hosted flow:** Welcome (hosted variant) → Drink Step in one of three package-driven shapes → Crowd Questions (preference-framed) → Menu Design → Day-Of Details → Review & Submit → Celebration. The three shapes:

1. **Slot picker** — Base Compound (hard 2: the picks ARE the bar) and Clear Reaction (featured 4: picks headline the menu, the bar improvises; copy promises "the basics plus what your picks need", never the whole syrup lab).
2. **Coverage browser** — Midrange / Enhanced / Formula No. 5 / Grand. Two tiers: "Included in your package" and a visibly fenced "Available as an add-on" tier with real per-guest prices on the badge, **multiplied out at the known guest count**. Picking a fenced drink is allowed; the price tag is the disclosure; the charge lands on the balance at submit. Mocktails get identical fence treatment.
3. **Display-only** — beer & wine tiers. "Here's your bar" as a confirmation showpiece, no picking, taste-preference asks only where the package says rotating/craft.

**Crowd Questions screen (new, one screen):** (a) "About how many of your N guests drink?" and (b) a light guest-profile ask (spirit-forward / wine crowd / beer crowd / help me decide). This replaces all three scattered balance radios. Both answers are consumed by the quantity engine, which is the honesty test the old questions failed.

**Day-Of Details:** parking (fee note stays: the disclosure precedent), day-of contact, access notes, plus the promised-but-never-asked items: **bar placement (indoor/outdoor) and power access**.

**Review & Submit:** recap reads like a checkable document, then submit. Required to submit: at least one drink or an explicit none, crowd questions, parking, day-of contact. Everything else optional; validation is gentle and inline.

**Celebration:** "Your formulas are filed. Care to enhance them?" with the button **"Enter the Enhancement Lab"** (its own prompt doc). Also states that a confirmation email echoing every selection is on its way.

## Design opportunities carried forward (still true from the audit)

- **The unwired confirmation CSS**: `index.css:14028-14194` (`.conf-leader` dotted leader rows, `.conf-total` brass seal, `.potion-submitted` panels) was built and never mounted. The Review recap and Celebration should finally spend it (payment radios in that block are dead: no payment here anymore).
- **An honest map**: the welcome roadmap and the progress rail must match the client's actual queue once known; no "three parts" promise over a seven-step reality.
- **Custom drinks that teach**: typeahead against the live cocktail/mocktail catalog with clear "on our menu" vs "our bar lead will source this" states (server matching is normalized-exact, `shoppingListGen.js:109-125`; misses become needsRecipe and feed the admin recipe flow).
- **Phone-first**: design every screen at 390px first; the T-21 nudge SMS is the front door. The roadmap and scope banners currently have no small-screen rules.
- Scope banners (wax seals) keep doing the "why we ask" work: brass = feeds your shopping list, teal = we bring it, ghost = aside.

## Grounding (current implementation)

Orchestrator `client/src/pages/plan/PotionPlanningLab.js` (998 lines): fetch, autosave (Next + silent 30s + beforeunload keepalive), browser-back interception, progress, legacy-draft shims. All of that machinery survives. Step files live in `client/src/pages/plan/steps/`; the file map, selections allow-list contract, and arrival paths are unchanged from before and documented in git history of this file and in the spec. Key contract: `drink_plans.selections` JSONB behind `ALLOWED_SELECTIONS_KEYS` (`server/routes/drinkPlans/submitSanitize.js`), additive-only, every consumer updated in the same change (generator, admin display, menu extractor, drink_names enrichment). New keys this redesign introduces (crowd answers, bar placement, power) follow that rule.

## What must not change (hard)

1. Endpoints, methods, token semantics, autosave cadence, legacy-draft tolerance.
2. The selections allow-list contract (additive only, consumers updated together).
3. **No payment UI, no card fields, no Stripe on this surface, ever.** Fence picks and parking are disclosed charges that land on the balance; the wording "added to your event balance" is the only money language allowed.
4. `potion-*` namespace, vanilla CSS in `client/src/index.css`, no new deps, no Tailwind.
5. Accessibility: save-dot role/aria-live wiring, reduced-motion guards, keyboard paths.
6. No em dashes in client copy. NA beer copy is Athletic Brewing only.
7. Do not absorb adjacent projects: the Enhancement Lab (own prompt), the admin menu-design page, the drink-plan edit lock. Design seams, not solutions.

## Definition of done

- Mock data previews: BYOB full bar, beer & wine only, hosted coverage-browser (with fenced picks), hosted slot-picker (Base and Clear), hosted display-only, plus locked / error / submitted terminal states.
- Every screen at 390px and desktop. Vercel gate: `cd client && CI=true npx react-scripts build` (warnings fail).
- One restrained magical-realism moment maximum per screen; the save-dot and wax seals already spend most of that budget.
