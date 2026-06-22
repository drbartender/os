# Potion Planner Welcome Step Redesign

Date: 2026-06-22
Surface: Potion Planning Lab, welcome step (`/plan/:token`, `step === 'welcome'`)

## Context / Problem

Clients land on the first page of the drink-plan wizard and don't know what to do. The three "PART 1 / 2 / 3" cards look like selectable tiles (they match the clickable cards used later in the flow: serving-type cards, drink tiles), so people think they have to click them and miss the "Next" button. Dallas has literally had to tell a client over the phone to "click Next." Worse, some clients get daunted by the unknown and call instead of self-completing. The business wants zero calls and full self-service completion.

A separate, already-shipped commit (`e72433f`) fixed the low-contrast text on this surface. That made the cards readable, which if anything made them look *more* like buttons, so the affordance problem is now the main event.

## Goals

1. Kill the false affordance: the roadmap must obviously not be clickable.
2. Make the single action (start the wizard) unmissable.
3. Defuse the daunt with honest, up-front expectation-setting so anxious clients self-complete instead of calling.

## Non-goals

- No change to the wizard's steps, branching, pricing, or data.
- Not the apothecary reskin (tokens already swapped); this is UX + copy on an already-skinned surface.
- No new "save and finish later" backend: autosave + resume already exists (`PotionPlanningLab.js:158` restores saved state; the `.potion-save` indicator shows saving/saved). So promising it is honest, not a build.

## Evidence basis (verified research, 2026-06-22 deep-research run)

High-confidence, primary-sourced findings the design leans on:
- **Perceived length/complexity drives the bail.** ~17 to 18% of checkout abandoners cite a "too long or complicated" process (Baymard). The fix is reducing *perceived* effort, not adding facts. (Domain caveat: these are ecommerce-checkout numbers; mechanism transfers, absolute % does not, since this is a no-payment finalization.)
- **Set expectations up front** (NN/g): state time, what the process looks like, and whether progress saves. Constraint: the estimate must be *accurate*, a broken promise drives immediate abandonment.
- **Endowed progress** (Nunes & Drèze, JCR 2006): an honest head start raises completion and cuts time-to-complete (their field test: 34% vs 19% for identical work). Must be real, not faked.
- **Show a calm step map** with plain, short labels (NN/g). This is the de-buttoned procedure.
- **Call deflection** (Gartner): low-effort, low-uncertainty self-service keeps people self-serving; pre-answering "what will this ask me, how long, can I undo it" removes the reason to call.
- **Reassurance microcopy** naming a short, honest duration ("about three minutes") helps prevent mid-form abandonment.

Deliberately NOT used (killed in verification as fabricated): "multi-step converts 86% higher," "~70% drop off at step one," "+22.3% per step," "no progress bar = +22% abandonment," the 29/27/11 abandonment-driver breakdown.

Accuracy constraint that shapes the copy: this wizard's step count is **dynamic** (depends on which modules a client picks: cocktails, mocktails, beer/wine, spirits). So we do NOT promise a hard step number. We promise **time** plus the **three stable parts** that never change.

## Design

### Layout and affordance

Top to bottom on the welcome step:
1. Welcome card (existing parchment card): greeting + endowed-progress line.
2. A short orienting line: what's left, how long.
3. The **vertical 3-part procedure**: three numbered nodes joined by a single thin vertical line, flat, no card chrome, no borders/fills/hover, obviously passive. This replaces the three horizontal tiles and is the page's signature element. A vertical numbered procedure is the hardest thing to misread as a row of buttons, and numbering is honest here because the parts are a real ordered sequence.
4. A low-stakes reassurance line.
5. One dominant **Start** button.

Spend all the visual boldness on the Start button; keep the procedure quiet so nothing competes with the real action.

### Endowed progress (honest)

They already booked, so "step zero" is genuinely complete. Surface it two ways:

1. Copy: "Your booking's confirmed, so you're already underway."
2. A small, presentational progress cue rendered ONLY on the welcome step: a short bar (or a "Booking confirmed" check plus a few step dots) seeded one notch in, so the head start is visible, not just stated. This is the research's highest-leverage lever (Nunes & Drèze: an honest visual head start, ~34% vs ~19% completion), and a visual cue is what carries it.

Constraint surfaced by spec review (load-bearing): the existing `.potion-rail` CSS is **orphaned**, it is rendered nowhere. The real in-flow indicator is the plain-text "Step N of M" in `PotionPlanningLab.js` (~line 933), which is intentionally hidden on the welcome step and whose total differs between BYOB (`moduleQueue` empty until QuickPick) and hosted (`moduleQueue` pre-built). So the welcome cue must be a **standalone presentational element** living in the welcome-step component, NOT wired into `progressStep` / `totalSteps` / `moduleQueue`. It shows a fixed, honest "you're underway" head start and nothing more. Do not touch the step controller. The head start is plausibly sized (one step of a short flow) and never fabricated beyond the booking.

### Copy (proposed; Dallas to redline, brand voice is his)

House style: no em dashes; plain, active voice; name things by what the client recognizes.

- Header: "Welcome back, {firstName}." where `{firstName}` is the first token of `plan.client_name` (which is a full name and is **nullable**). If no name is available, the greeting is just "Welcome back." (mirrors the existing "friend" fallback on the submitted screen). Never render "Welcome back, ."
- Endowed + orient: "Your booking's confirmed, so you're already underway. All that's left is finalizing the bar: three parts, just a few minutes." (Softened from "about three minutes": a full-bar BYOB client traverses ~6 steps, and the research's accuracy rule requires the estimate hold for the longest realistic path.)
- Pre-fill reassurance (returning-customer lever, research findings 5/6/9): one line that we already carried their info over, e.g. "We've carried over your booking details, so you won't re-enter anything." The data is already pre-seeded (guest count, bartenders, proposal syrups, package contents), so this is honest.

Procedure, BYOB mode:
1. **Choose your drinks** — "Cocktails, beer and wine, spirits, whatever you'd like to pour. We turn it into your shopping list."
2. **Design your menu card** — "Custom, standard, or skip it. We print and frame it to display on the bar."
3. **The day-of details** — "Where the bar sets up, parking, power, and how we get in. The practical stuff so the day runs smooth."

Procedure, hosted mode (only Part 1 differs):
1. **Pick what we pour** — "Your {packageName} is set. Just choose the specific drinks within it."
(Parts 2 and 3 identical to BYOB.)

- Reassurance (near the button): "No wrong answers. Your progress saves as you go, and you can go back and change anything before you submit." (Bounded to in-flow on purpose: a submitted plan hard-locks server-side at `drinkPlans.js:166` and the client routes to a read-only celebration screen, so do NOT promise an unbounded "change anything later." Autosave + resume is real, so "progress saves" is honest.)
- Optional (residual call-trigger): a light cost-reassurance, "Nothing here charges you, you'll see the price before any upgrade," which defuses the "will picking these cost me more?" call. Include only if it doesn't crowd the page.
- Primary button label on the welcome step: **"Start"** (currently hardcoded "Next").

The de-jargoning is the key content move: "Confirm logistics" becomes "The day-of details," "Choose menu design" becomes "Design your menu card." Each part is one warm sentence that *names* what's inside it (no bullet stacks, which read as a workload and re-trigger the daunt). This rename is **scoped to the welcome step only**. The actual step headers stay as they are ("The Day-Of Rundown", "Menu Design"), which are close enough not to mislead; renaming step headers, emails, or the BEO is out of scope.

### Files touched

- `client/src/pages/plan/components/WelcomeRoadmap.js` — restructure three horizontal cards into the vertical numbered procedure; new copy; keep the `mode` (byob/hosted) branch. Note this component also renders a `.potion-roadmap-footer` "after you submit..." block (~lines 49-53); decide whether to keep it as the page's closing line, move it, or drop it, and account for its CSS in the net-flat math.
- `client/src/pages/plan/steps/RefinementWelcomeStep.js` — greeting (with first-name and no-name fallback) + endowed/orient + pre-fill + reassurance copy, the standalone welcome-only progress cue, and the layout around the procedure.
- `client/src/pages/plan/PotionPlanningLab.js` — Start label on the welcome step (`nextLabel` is hardcoded `'Next'`, **line 767**). Do NOT touch `progressStep` / `totalSteps` / `moduleQueue` (the welcome progress cue is presentational and lives in the welcome-step component, not the controller).
- `client/src/index.css` (`.potion-app` scope) — replace the existing `.potion-roadmap*` block (at ~13277-13365, **including** the `.potion-roadmap-footer` rules) with the vertical-procedure styles, plus the small welcome progress-cue styles and Start-button prominence. Edit by selector; line numbers drift.

### File-size constraint (load-bearing)

`index.css` is far over the 1000-line hard cap (~16.9k lines), so the pre-commit hook blocks any commit that *grows* it. The new procedure CSS plus the small welcome progress-cue CSS must be written by **replacing** the old `.potion-roadmap*` block (including its footer rules) in place, keeping the file net flat or shrinking. Reuse existing tokens, keep the cue minimal. If the replacement genuinely cannot fit the budget, resolve it at build (replace a bit more of the old roadmap styling, or extract), not with `--no-verify`. Do not add the new rules alongside the old ones.

## Verification

- Render the welcome step in **both** byob and hosted modes (the isolated-CSS harness used for the contrast fix, or a real `/plan/:token`), at desktop **and** mobile widths, and confirm: nothing reads as clickable except the Start button; the orient line, three plain-language parts, pre-fill line, and reassurance line are present and legible; the standalone welcome progress cue shows the honest head start; the vertical connecting line behaves on narrow screens and the welcome-banner grid rules aren't orphaned.
- Check the no-name case (null `client_name` renders "Welcome back." cleanly) and the hosted null-package case (still reads "Your package is set").
- Accessibility: the numbered nodes are non-interactive (no `role`, `tabindex`, or `onClick`); the Start button keeps a visible keyboard focus ring.
- `ui-ux-reviewer` agent sweep for affordance and clarity.
- `CI=true react-scripts build` before any push.

## Track

Project (multi-file client change), so: think on main (this spec), build in a lane, squash-merge back. Not a sensitive path (client UI / CSS / copy; no money, auth, or schema), so a light review fleet plus the welcome-specific verification above. The work is small and coherent enough to build in one pass.
