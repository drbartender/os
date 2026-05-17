# Drink Plan: Post-Booking Only — Remove the Pre-Booking Exploration Phase

**Date:** 2026-05-17
**Status:** Design — awaiting review
**Type:** Cross-cutting removal (client + server + email + docs). No schema migration.

## Goal

The drink plan should exist **only after a client books** (deposit paid). Remove the pre-booking "Exploration" phase of the Potion Planning Lab entirely and collapse the two-phase abstraction into a single linear post-booking flow. The post-booking experience is unchanged in behavior.

## Why

- The pre-booking Exploration phase is an emoji personality-quiz with cartoon mascots — it conflicts with the brand's explicit hard rule (redesign brief §2.2: *not childish, not kitschy*) and is the least-premium surface an unconverted prospect touches.
- It hands the full exploratory experience to someone who has committed nothing, and creates `drink_plans` rows for proposals that may never convert.
- The post-booking (Refinement) phase is provably independent of exploration data and is the experience the owner wants to keep as-is.

## Decision Record (settled in brainstorming)

- **Deep collapse, now** — not a surgical hide. Remove the pre-deposit creation/link, delete the exploration step files, and collapse the phase abstraction into one linear post-booking flow. Rationale: once the token only exists post-deposit, `derivePhase` can never return `exploration`; keeping the abstraction is a dead branch and a confusing artifact. One verified pass over this money-adjacent surface is less total risk than two.
- **No schema migration.** `drink_plans.exploration_submitted_at` and `'exploration_saved'` in the status CHECK constraint stay as inert legacy. Altering a production CHECK on a deposit-paid table for tidiness is risk without user benefit (CLAUDE.md code-preservation). Flagged as optional future cleanup, not in scope.
- **Legacy in-flight data is protected, not stranded** (see "Legacy shims").

## Non-Goals

- No visual redesign of the Refinement flow. That is the separate Apothecary Press "Potion Lab" bite. (That bite gets simpler — it no longer has to style 5 exploration steps.)
- Not forcing the `PotionPlanningLab.js` 1000-line split. The deletions likely drop it under the hard limit; split only if it falls out naturally. Not a goal here.
- No change to `createDrinkPlan` (`server/utils/eventCreation.js`), `createEventShifts`, or the Stripe deposit webhook. They are confirmed independent and stay untouched.
- No change to `emailTemplates.proposalSent` — its `planUrl ? section : ''` conditional already omits the CTA when `planUrl` is absent.

## Current Mechanism (verified)

- **Phase gate:** `derivePhase(proposal_status)` in `client/src/pages/plan/data/servingTypes.js`. Exploration = `sent|viewed|modified|accepted`; Refinement = `deposit_paid|balance_paid|confirmed|completed`. Last meaningfully changed 2026-04-23 / 2026-04-10; nothing recent altered it.
- **Pre-deposit entry vector (the only one):** `server/routes/proposals/crud.js` ~492–522. On proposal status → `sent`, calls `createDrinkPlan(id, {...}, { skipEmail: true })`, builds `planUrl = ${PUBLIC_SITE_URL}/plan/${token}`, plus an `existingPlan` fallback that surfaces `planUrl` if a row already exists, then passes `planUrl` into `emailTemplates.proposalSent(...)` which renders a "Plan Your Drinks" CTA.
- **Post-deposit entry vector (unchanged):** Stripe webhook → `createEventShifts` (`eventCreation.js` ~92–157) → `createDrinkPlan(proposalId, proposal)` *without* `skipEmail` → sends the `drinkPlanLink` email. `createDrinkPlan` is idempotent (returns null if a row exists), so removing the pre-deposit call does not affect this path.
- **Refinement is standalone:** the Phase-2 seeding block (`PotionPlanningLab.js` ~221–227) is conditional on `savedSel.exploration?.favoriteDrinks?.length > 0`, skipped entirely when no exploration data exists — already the normal case (most clients pay the deposit without exploring).

## Changes

### Client — `client/src/pages/plan/`

**Delete files:** `steps/VibeStep.js`, `steps/FlavorDirectionStep.js`, `steps/ExplorationBrowseStep.js`, `steps/MocktailInterestStep.js`, `steps/ExplorationSaveStep.js`, `steps/WelcomeStep.js`.

> `WelcomeStep.js` is **not** exploration-only — it is also rendered in the refinement path (the `case 'welcome'` reachable via `handleBack` from `quickPick` when there is no `exploration_submitted_at`). It is deleted because the single post-booking entry screen becomes the (renamed) old `RefinementWelcomeStep`. See step-id consolidation below.

**`servingTypes.js`:** remove `EXPLORATION_STEPS`, `buildExplorationQueue`, `EXPLORATION_STATUSES`, `derivePhase`. Remove `REFINEMENT_STATUSES` only if it has no other consumer (grep first; keep if referenced elsewhere). The wizard no longer derives a phase — it always builds the refinement queue.

**`steps/RefinementWelcomeStep.js`:** becomes the sole entry screen.
- Remove the `exploration` and `guestCount`-unrelated exploration logic: delete the `VIBE_LABELS` constant, the `hasExploration` derivation, the `exploration` prop, and the entire "From your exploration:" block (lines ~67–82, including the hardcoded `rgba(193,125,60,0.08)` inline style — that artifact disappears with the block).
- Change the body copy that references exploration: *"We'll build on what you already explored and lock everything in."* → *"Let's finalize the details for your bar and lock everything in."*
- Keep the hosted package-recap card and the "your booking is confirmed" framing unchanged.

**Step-id consolidation:** the single welcome step id is `welcome`, rendered by the kept `RefinementWelcomeStep` component. The file and component keep their name (`RefinementWelcomeStep.js` / `RefinementWelcomeStep`) — only the wizard **step id** is consolidated from `refinementWelcome` to `welcome`; the old `welcome` id (which rendered the now-deleted `WelcomeStep`) goes away. Concretely:
- `renderStep()`: delete `case 'welcome'` (old `WelcomeStep`) and the exploration `case`s (`stepVibe`, `stepFlavorDirection`, `stepExplorationBrowse`, `stepMocktailInterest`, `explorationSave`). Rename `case 'refinementWelcome'` → `case 'welcome'` rendering `RefinementWelcomeStep` (drop the `exploration` prop; keep `plan`, `guestCount`).
- Update every other `refinementWelcome` / `'welcome'` reference accordingly (initial-step set ~266, `handleNext` ~660, `handleBack` ~703–704, `showBack`/`showNext` arrays ~832–833).

**`PotionPlanningLab.js` removals:**
- Lazy imports of the 6 deleted components (~23–28). Keep `RefinementWelcomeStep` import.
- `DEFAULT_SELECTIONS.exploration` sub-object (~35–42). Note legacy-shim exception below.
- `phase` state + `explorationQueue` state (~91, ~127); `derivePhase`/`buildExplorationQueue` calls and `setPhase` (~149–156).
- `handleExplorationSave` (~365–384) and `updateExploration` (~436–442).
- `handleNext` exploration branch (~645–657); `handleBack` exploration branch (~689–700).
- `explorationSaved` celebration screen (~810–826).
- Restore logic (~177–269): drop `'exploration_saved'` from the status OR (~179); delete the `exploration_saved` re-entry branch (~252–254); the `derivedPhase === 'refinement'` guard becomes unconditional (always refinement now).
- `nextLabel` (~836): `phase === 'exploration' ? 'Keep Going' : 'Next'` → `'Next'`.
- `handleBack` line ~703: `goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome')` → `goToStep('welcome')` (single consolidated id).
- Audit every refinement step still receiving an `exploration` prop (confirmed: `QuickPickStep` at ~907; sweep for others). Remove the prop and any "based on your exploration" UI those steps render.

**Legacy shims (deliberately retained, commented):** existing post-deposit plans created under the old flow may carry `selections.exploration` JSON; a small number of in-flight proposals may have pre-change exploration data not yet booked. To avoid stranding them:
- Keep the Phase-2 seeding block (~221–227) and the `savedSel.exploration?.favoriteDrinks` read in the addon-migration inference (~201) as **legacy-data fallbacks**, each marked with a comment: `// Legacy: pre-2026-05-17 exploration data; safe to delete once all such proposals have closed.`
- These fire only when old data is present and cost nothing otherwise. They are the only references to `exploration` that survive in `PotionPlanningLab.js`.

### Client — pre-deposit lock screen (REQUIRED, data integrity)

Outstanding proposal-sent emails contain live `/plan/:token` links for pre-deposit proposals. With exploration removed and the wizard collapsed to refinement-only, such a link must **not** drop an unbooked client into the wizard (they could submit a plan or trigger the `ConfirmationStep` mid-flow Stripe extras charge before booking).

- The token GET route returns a locked state when the linked proposal status ∈ {`sent`,`viewed`,`modified`,`accepted`} (i.e., not yet `deposit_paid`+). See server change below.
- `PotionPlanningLab.js` renders a minimal lock screen for that state: short message — *"Your drink plan unlocks once your deposit is paid."* — and a button linking to `/proposal/:token`. No wizard, no exploration, no auto-save.
- This is the formal answer to "what does `/plan/:token` show pre-deposit": a lock screen, only ever reached by stale legacy links. The new flow never creates a pre-deposit token at all.

### Server

**`server/routes/proposals/crud.js` (~492–522):** remove the pre-deposit `createDrinkPlan(..., { skipEmail: true })` call, the `planUrl` construction, and the `existingPlan` `planUrl` fallback. Call `emailTemplates.proposalSent({ ..., planUrl: null })`. No template change.

**`server/routes/drinkPlans.js`:**
- Remove `'exploration_saved'` handling: status derivation (~98–99), the restore conditional (~179), the phase check (~252), and the admin `PATCH /:id/status` accepted value (~666).
- `GET /api/drink-plans/t/:token`: when the linked proposal status is pre-deposit ({`sent`,`viewed`,`modified`,`accepted`}), respond with an explicit locked payload (e.g. `{ locked: true, proposalToken }`) instead of the plan. The client renders the lock screen from this. Keep the existing not-found behavior for genuinely missing tokens.

**`server/utils/eventCreation.js`:** unchanged. Explicitly verified — `createDrinkPlan` stays idempotent and is the sole post-deposit creation point after this change.

### Schema

No migration. `drink_plans.exploration_submitted_at` and `'exploration_saved'` remain in the CHECK constraint (the constraint still *permits* the value; code simply never writes it). Documented as inert legacy / optional future cleanup.

## Verification Matrix (ship gate)

This is a paid-client surface with a mid-flow Stripe charge. Before push, verify:

1. Each serving style routes end-to-end: signatures / full bar / beer-wine / mocktail / custom-setup.
2. Hosted-package path: skips QuickPick, routes via Guest Preferences, skips dead steps.
3. Browser back/forward step navigation within refinement (history sync) — no dead ends, single `welcome` entry.
4. Auto-save fires every 30s and on unload.
5. `ConfirmationStep` mid-flow Stripe extras still confirm; surcharge tally correct; "Drink Plan Extras" invoice lands.
6. Submit → confirmation/celebration screen → BEO email to admin.
7. Proposal-sent email renders correctly with **no** drink-plan CTA.
8. Deposit webhook still creates/reuses the drink plan and sends the `drinkPlanLink` email; fresh post-deposit plan (zero exploration data) loads straight into `welcome` → refinement.
9. Legacy pre-deposit token link → lock screen, cannot enter the wizard; "view your proposal" link works.
10. In-flight legacy plan with saved `exploration.favoriteDrinks` that then books → seeding shim still pre-fills `signatureDrinks` (not stranded).
11. `CI=true react-scripts build` passes for the client (client lint is only enforced by Vercel CI).

## Docs to Update (CLAUDE.md mandatory rule)

- `ARCHITECTURE.md` — drink-plan flow / phase description: now single post-booking flow.
- `CLIENT_FACING_SURFACES.md` — remove the 5 exploration step rows + `WelcomeStep`; rewrite the Exploration→Refinement booking-flow narrative to post-booking-only.
- `README.md` — folder tree: remove the 6 deleted step files.
- Note in the redesign brief / Potion Lab bite that exploration steps no longer exist (smaller scope).

## Risk & Rollback

Mostly deletion of code that becomes provably unreachable; the one additive piece (pre-deposit lock) is safe-by-construction. No schema change → no migration rollback. Rollback = revert the commit(s). Primary risk is navigation regression on the post-deposit wizard — fully covered by the verification matrix, which is the explicit ship gate.

## Testing Approach

- New behavior (`GET /api/drink-plans/t/:token` returns locked for pre-deposit proposal) gets an automated test (TDD).
- Deletions verified via the manual verification matrix + the client CI build.
- The legacy seeding shim retains its existing behavior (no test change).
