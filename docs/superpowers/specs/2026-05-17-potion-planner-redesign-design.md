# Prompt — Apothecary-Press Reskin: The Potion Planner

> Hand this whole file to the repo-linked design session. It is the complete brief for one surface. Read the files it names before writing any CSS.

---

## Mission

Reskin **the Potion Planner** (`/plan/:token` — the post-booking drink-design wizard) into the Apothecary-Press visual system. **The flow does not change. Not one step, not one state, not one redirect.** You are repainting a working machine while it runs.

This is a *visual* pass only. Same routes, same step queue, same state machine, same API calls, same Stripe flow, same auto-save. If a change would alter what the wizard *does*, it is out of scope — stop and flag it instead.

The app-wide color tokens were already swapped (Stage 1 — `:root` in `client/src/index.css` already resolves `--amber` to teal, `--brass`, `--plum`, parchment, Midnight Ink). **Do not re-swap tokens.** Colors have already cascaded for free. Your job is the *surface polish* the cascade can't give: parchment step cards, brass hairlines, the apothecary register applied with restraint, and the one bespoke magical-realism moment this surface earns.

A precedent already exists for exactly this kind of per-surface pass — the **shopping-list reskin**. Read it and match its restraint and structure (see "What to read").

---

## What to read first (in this order)

1. **`DR_BARTENDER_REDESIGN_BRIEF.md`** (repo root) — the master visual system. You do not need all of it. Read:
   - **§2** Hard Rules — all of it. Especially §2.4 texture rule, §2.5 rainbow rule, §2.6 "magic, but not really".
   - **§4** Typography (IM Fell stack is fixed; do not propose alternatives).
   - **§5.0** Density-by-surface — **this is the load-bearing rule for this surface. The Potion Planner is FUNCTIONAL, not Atmospheric.** Re-read it.
   - **§5.1–§5.4, §5.6** — cards, buttons, form inputs, dividers, the ⚗ glyph.
   - **§6.2** — the `PotionPlanningLab.js` paragraph. **One line in it is stale — see "Hard rules" #5 below for the override.**
   - **§7** — motion. Moment **#5 (brass pulse on auto-save)** is the one magical-realism beat this surface implements.
   - **§11** — quality gates. These are your definition of done.
2. **`CLIENT_FACING_SURFACES.md`** (repo root) — source of truth for what mounts where. Confirm the `/plan/:token` surface scope.
3. **The shopping-list precedent** — read both, then match the bar they set:
   - `docs/superpowers/specs/2026-05-17-shopping-list-redesign-design.md`
   - the shopping-list class blocks in `client/src/index.css` (search `shopping`/`client-`) — this is what "apothecary-press surface reskin, done right, in this codebase" looks like.

## What to read to understand the surface you're reskinning

- `client/src/pages/plan/PotionPlanningLab.js` — the orchestrator. Owns the wrapper, the `Step N of M` indicator, the save indicator, `.potion-step`, `.step-nav`, and the inline-styled **loading / locked / error / submitted** states. (~950 lines — see hard rule #5 before you touch it.)
- `client/src/pages/plan/steps/*.js` — every step component: `RefinementWelcomeStep`, `QuickPickStep`, `CustomSetupStep`, `SignaturePickerStep`, `MocktailStep`, `FullBarSpiritsStep`, `FullBarBeerWineStep`, `BeerWineStep`, `MenuDesignStep`, `HostedGuestPrefsStep`, `LogisticsStep`, `ConfirmationStep`, plus `MakeItYoursPanel`. Most colors already resolve via tokens; you are retuning *treatment* (frames, spacing, card surfaces, dividers), not hunting hex.
- `client/src/index.css` — the blocks you will actually edit:
  - `.potion-welcome-*` (welcome screen, ~1819–1891)
  - `.potion-step` + `@keyframes potionFadeIn` (~1893)
  - `.serving-type-grid` / `.serving-type-card` / `-emoji` / `-label` / `-desc` (~1901+)
  - `.step-nav` (~2375) and `.potion-step .btn-secondary` (~2382)

---

## Hard rules (these override anything softer, including a stale line in the brief)

1. **The flow is frozen.** `welcome → quickPick` (or `customSetup`) `→ module steps` (from `buildStepQueue` / `buildHostedStepQueue`) `→ confirmation → submitted`. Hosted packages skip `quickPick`; mocktail-only bar type skips `quickPick`. Do not touch step order, the queue builders, `serving_type` logic, the browser-back `popstate` handling, the 30s auto-save, the `beforeunload` save, or the Stripe extras submit on confirmation. Reskin only.
2. **Vanilla CSS in `client/src/index.css` only.** No Tailwind, no CSS-in-JS, no CSS modules, no new dependency. Inline `style={{}}` already in the step files / orchestrator may be retuned in place to use existing tokens; prefer moving repeated treatment into a `.potion-*` class.
3. **Preserve every class name and CSS variable name.** Values/treatment change; names do not. `.potion-*`, `.serving-type-*`, `.step-nav`, `--amber`, `--brass`, etc. all stay.
4. **Do not restyle shared primitives or `.auth-page` as a side effect.** The planner wraps in `.auth-page` (shared with Login/Register/ClientLogin) and leans on global `.card` / `.btn-primary` / `.btn-secondary` (Stage-2 primitives, a separate pass). Scope every new rule to the planner: `.potion-step …`, `.potion-*`, `.serving-type-*`, `.step-nav`. **Do not edit the bare `.auth-page` rule or global `.card` / `.btn-*` rules here** — if a primitive looks unfinished, note it for the primitives stage and move on. This surface must not bleed into auth pages or the whole app.
5. **Override the stale line in brief §6.2.** It says "split into `ExplorationPhase.js` and `RefinementPhase.js`." That is **out of date** — the exploration phase was removed; the Lab is a single post-booking flow and `PotionPlanningLab.js` is now ~950 lines, under the 1000-line hard cap. For a CSS reskin you barely touch the `.js`. **Do not split the file.** If retuning inline styles somehow pushes it past 1000 lines, extract the styles into `index.css` classes (which is the goal anyway) — never fragment the state machine.
6. **No accessibility regression.** Preserve `role="status"` / `aria-live="polite"` (loading + saving), `role="alert"` (save-failed), the spinner, focus-visible outlines, keyboard activation on any clickable non-`<button>` card, and the `useFormValidation` → `<FieldError>` → `<FormBanner>` chain.
7. **Stripe is sacred.** `ConfirmationStep` mounts Stripe Elements for the drink-plan-extras pay-now. The reskin must not break Element mounting or confirmation. Elements inherit the form-input style — keep inputs clean (brief §5.3), no texture on the field itself.

---

## The register: FUNCTIONAL density (do not get this wrong)

The Potion Planner is where a booked client is **working** — designing their bar, selecting drinks, paying for extras. It is not a page they browse for atmosphere. Per brief §5.0, the apothecary **recedes to accents**:

- Parchment (`--card-bg`) step cards on the Midnight Ink (`--chalkboard`) base, with a **2px brass frame** and the §5.1 card shadow.
- Brass **hairline** dividers and section markers — not ornamental borders, not scratched-out surfaces, not bottle-label maximalism.
- Teal (`--amber`) for active/selected states and the primary CTA. Plum (`--plum`) only for hover depth.
- Kicker eyebrow in `--brass` (small-caps, existing `h4` treatment) above step headings where a step has a heading; display font for the heading itself, clean modern type for the body and all controls.
- **One** seal/accent on the confirmation total — not on every card.

If a treatment would look at home on the *HomePage hero*, it is too much for this surface. When unsure, choose the plainer option. The brand wins here on calm clarity, not flourish.

---

## Sub-surface checklist (every one of these gets visited)

| Sub-surface | Component / location | Treatment |
|---|---|---|
| **Welcome** | `RefinementWelcomeStep` + `.potion-welcome-*` | Parchment card, brass frame. Preserve the bartender/drinks image layout **and its mobile reflow + ordering** exactly (it is hand-tuned). Optional brass hairline under the title. Hosted "Your package / Stocked & ready" card above it gets the same parchment+brass card treatment. |
| **Serving-type grid** | `QuickPickStep` + `.serving-type-*` | Parchment cards, brass hairline border, **teal selected state**, plum hover tint. Preserve the 400ms select delay and the `selected`/`selecting` visual. Emoji stays; do not swap for ⚗ or new glyphs. |
| **Custom setup** | `CustomSetupStep` | Same parchment-card register as the steps; controls stay clean per §5.3. |
| **Module steps** | `SignaturePickerStep`, `MocktailStep`, `FullBarSpiritsStep`, `FullBarBeerWineStep`, `BeerWineStep`, `MenuDesignStep`, `HostedGuestPrefsStep`, `LogisticsStep`, `MakeItYoursPanel` | Each: parchment content card, comfortable padding, brass kicker eyebrow, display-font heading, clean modern controls. **Drink/mocktail cards:** parchment with brass frame, teal selected state, per-drink upgrade chips in `--plum`. Long lists stay legible and scannable — restraint over decoration. |
| **Confirmation** | `ConfirmationStep` | Parchment summary card; line items in `--deep-brown`; the **total row** in display font with a brass top-border and the single seal accent (§5.6 ⚗ in `--brass`, used once). Stripe extras pay-now: Elements inherit clean form-input style; success/paid uses sage/forest from brief §3. **Verify Elements still mount + confirm.** |
| **Submitted** | the `step === 'submitted'` block in `PotionPlanningLab.js` | Celebration card → parchment + brass. Keep the 🎉 + `potion-bartender.png`. "Payment Received" / "What happens next?" panels retuned to tokens (teal wash / sage). |
| **Loading / Locked / Error** | inline-styled blocks in `PotionPlanningLab.js` | All three: parchment card on dark, brass frame, deep-brown text, spinner preserved. **Locked** ("unlocks after you book") and **Error** ("link may have expired") must stay clear and reassuring — this is a paying client hitting a wall; calm, not spooky. |
| **Chrome: progress + save + nav** | `Step N of M` text, save indicator, `.potion-step`, `.step-nav` | Step indicator: brass/cream, understated. **Save indicator gets the bespoke magical moment — see below.** `.step-nav`: Back = `.btn-secondary` register, Next = teal `.btn-primary`; keep the reserved vertical space so the indicator never shifts layout. Preserve `potionFadeIn`. |

---

## The one magical-realism moment (brief §7, moment #5)

The auto-save indicator (`Saving…`, every 30s) gets a **soft, slow brass pulse** — the science quietly breathing, the brand winking at a working user. Subtle. A gentle opacity/glow cycle in `--brass`, not a blink, not a spinner. This is the *only* bespoke magical beat on this surface. The iridescent `.btn-primary` hover (rainbow placement #2) belongs to the global primitive, not here — do not re-implement it locally. No rainbow anywhere else on this surface (§2.5).

---

## Definition of done (brief §11 — the gates that apply here)

Ship when all of these hold; then **stop iterating** (brief §11 stop rule — do not propose further polish):

- [ ] Flow unchanged: every step, the hosted/mocktail skips, browser-back, and step order behave exactly as before.
- [ ] Auto-save still fires every 30s **and** on `beforeunload`; save/save-failed indicators still render with `role="status"`/`role="alert"`.
- [ ] Stripe Elements on `ConfirmationStep` still mount and confirm the extras payment.
- [ ] `useFormValidation` → `<FieldError>` → `<FormBanner>` chain still functional on every step that validates.
- [ ] Every sub-surface in the checklist visited, including loading / locked / error / submitted.
- [ ] Mobile: no responsive regression — **especially the welcome screen's image reflow + ordering** and the serving-type grid.
- [ ] Focus-visible outlines, keyboard activation on clickable cards, all ARIA preserved.
- [ ] No new framework/preprocessor; vanilla CSS in `index.css` only; class + variable names unchanged.
- [ ] No edits leaked into the bare `.auth-page` rule or global `.card`/`.btn-*` rules.
- [ ] `PotionPlanningLab.js` not split and still under 1000 lines.
- [ ] Restraint check: a step card next to a sage-and-cream wedding vendor reads premium and calm, not themed or busy.

**When in doubt, choose restraint.** Every flourish you add to a working wizard is a small tax on the client trying to finish booking their bar. Spend the apothecary where it's earned — a brass hairline, a parchment frame, one pulsing save indicator — and nowhere else.
