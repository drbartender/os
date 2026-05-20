# Potion Planner Apothecary Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the post-booking drink wizard at `/plan/:token` in the Apothecary-Press visual system and adopt four UX additions (scope banners, welcome roadmap, three-way Menu Design, inline scope notes, continuous save pulse) without changing flow, payment math, schema, or step queue logic.

**Architecture:** Vanilla CSS appended to `client/src/index.css` scoped under a new `.potion-app` wrapper, with React JSX edits to mount new components (`<ScopeBanner>`, `<WelcomeRoadmap>`) and rewire one boolean field (`customMenuDesign`) into a three-value field (`menuStyle`). All work sits on top of the existing planner orchestrator (`PotionPlanningLab.js`); flow, queue, auto-save, and Stripe Elements are untouched.

**Tech Stack:** React 18, vanilla CSS, no Tailwind, no CSS-in-JS, no new dependencies. The pre-commit size hook gates only JS/JSX so CSS additions need no marker.

**Source spec:** `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md`

---

## Execution conventions

This codebase is vibe-coded; the planner has no jest suite. Verification is visual: load the dev server, navigate to the relevant surface, confirm the listed visual properties. The `verify` step in each task names the exact surface and what to look at. If the user reports the verification passes, commit. If anything looks wrong, fix in place before committing.

**Test plan URLs.** Every task that requires browser verification assumes the dev server is running and a draft drink plan exists. To create a usable test plan: (a) log in as admin, create a proposal, accept it as a test client, pay deposit, follow the email link to `/plan/<token>`; or (b) reuse an existing draft plan token from `drink_plans` where `status = 'draft'`. The token is the URL segment after `/plan/`.

**Commit pattern.** Per CLAUDE.md: plain `git commit -m "single line"` with no heredoc and no co-author footer. Always `git add <specific-path>`, never `git add .`. Each task commits as one logical change.

**Em dashes.** Do not introduce em dashes anywhere in copy or code. Use commas, periods, colons, or parentheticals.

---

## File structure

This plan touches these files. New files marked `(create)`; everything else is modify.

```
client/src/index.css                                            # +~900 lines of .potion-app scoped CSS appended at end
client/src/pages/plan/PotionPlanningLab.js                      # wrapper class on 5 returns + save indicator JSX + menuStyle migration + 2-variant submit copy + DEFAULT_SELECTIONS
client/src/pages/plan/steps/RefinementWelcomeStep.js            # mount <WelcomeRoadmap> + retune hosted package summary card
client/src/pages/plan/steps/MenuDesignStep.js                   # three-radio menuStyle + conditional reveals + mount <ScopeBanner>
client/src/pages/plan/steps/ConfirmationStep.js                 # three-way summary + mount <ScopeBanner> + split-with-seal total layout
client/src/pages/plan/steps/SignaturePickerStep.js              # mount <ScopeBanner>
client/src/pages/plan/steps/MocktailStep.js                     # mount <ScopeBanner> + inline field note
client/src/pages/plan/steps/FullBarSpiritsStep.js               # mount <ScopeBanner>
client/src/pages/plan/steps/FullBarBeerWineStep.js              # mount <ScopeBanner>
client/src/pages/plan/steps/BeerWineStep.js                     # mount <ScopeBanner>
client/src/pages/plan/steps/HostedGuestPrefsStep.js             # mount <ScopeBanner>
client/src/pages/plan/steps/LogisticsStep.js                    # inline field note (no banner)
client/src/pages/plan/components/ScopeBanner.js                 # (create) shared banner with three tones
client/src/pages/plan/components/WelcomeRoadmap.js              # (create) three-card welcome roadmap
```

No server-side files. No schema files. No package.json.

---

## Task 1: Scaffolding (wrapper class + base CSS + heading defenses)

This task lays the foundation so subsequent CSS tasks can scope to `.potion-app` and parchment-card headings render dark instead of cream.

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js:644, 657, 684, 702, 909`
- Modify: `client/src/index.css` (append at end of file)

- [ ] **Step 1: Add `.potion-app` to all 5 wrapper return statements in Lab.js**

Edit `client/src/pages/plan/PotionPlanningLab.js` at the five wrapper return locations:

Replace `<div className="auth-page">` with `<div className="auth-page potion-app">` on lines 644 (loading), 657 (locked), 684 (error), 702 (submitted), and 909 (main render).

- [ ] **Step 2: Append the section banner + base CSS block to the end of `client/src/index.css`**

Open `client/src/index.css`, scroll to the end, append:

```css

/* ═══════════════════════════════════════════════════════════
   POTION PLANNING LAB: APOTHECARY-PRESS RESKIN
   Spec: docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md
   All rules scoped to .potion-app to prevent leak into other surfaces.
   ═══════════════════════════════════════════════════════════ */

/* Page shell */
.potion-app {
  min-height: 100vh;
  background:
    radial-gradient(60vw 60vh at 50% 10%, rgba(184,146,74,0.06), transparent 60%),
    var(--chalkboard);
  position: relative;
  isolation: isolate;
  font-family: var(--font-body);
  color: var(--cream-text);
  padding-bottom: 6rem;
}
.potion-app::before {
  content: "";
  position: absolute; inset: 0;
  background-image:
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.07 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  pointer-events: none;
  z-index: 0;
}
.potion-app > * { position: relative; z-index: 1; }

.potion-app .potion-shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px clamp(20px, 4vw, 40px) 80px;
}

/* Cards: parchment with brass frame */
.potion-app .card,
.potion-app .potion-card {
  position: relative;
  background:
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.18  0 0 0 0 0.12  0 0 0 0 0.06  0 0 0 0.05 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"),
    linear-gradient(180deg, var(--paper) 0%, var(--card-bg) 100%);
  border: 2px solid var(--brass);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: clamp(20px, 2vw, 28px);
  color: var(--deep-brown);
}
.potion-app .potion-card-tight { padding: 18px 22px; }
.potion-app .potion-card-inner-frame::before {
  content: ""; position: absolute; inset: 8px;
  border: 1px solid var(--brass);
  pointer-events: none; opacity: 0.5;
  border-radius: 6px;
}

/* Headings inside parchment cards: defeats the global page-container h*
   { color: var(--cream-text) } rule that would otherwise cream-on-cream */
.potion-app .card h1,
.potion-app .card h2,
.potion-app .card h3,
.potion-app .card h4,
.potion-app .potion-card h1,
.potion-app .potion-card h2,
.potion-app .potion-card h3,
.potion-app .potion-card h4,
.potion-app .page-container .card h1,
.potion-app .page-container .card h2,
.potion-app .page-container .card h3,
.potion-app .page-container .card h4,
.potion-app .page-container .potion-card h1,
.potion-app .page-container .potion-card h2,
.potion-app .page-container .potion-card h3,
.potion-app .page-container .potion-card h4 {
  font-family: var(--font-display);
  font-weight: 400;
  margin: 0 0 0.5rem;
  color: var(--deep-brown);
  letter-spacing: 0.015em;
  line-height: 1.12;
}
.potion-app .card h2, .potion-app .potion-card h2 { font-size: clamp(1.6rem, 2.6vw, 2.1rem); }
.potion-app .card h3, .potion-app .potion-card h3 { font-size: 1.25rem; }
.potion-app .card p,
.potion-app .potion-card p {
  margin: 0 0 0.6rem;
  color: rgba(28,22,16,0.78);
  font-size: 1rem;
}
.potion-app .card .text-muted,
.potion-app .potion-card .text-muted { color: var(--text-muted); }

/* Kicker eyebrow above headings */
.potion-app .potion-kicker {
  display: inline-flex; align-items: center; gap: 12px;
  font-family: var(--font-display);
  font-size: 0.78rem;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--brass);
  margin: 0 0 10px;
}
.potion-app .potion-kicker::before {
  content: ""; width: 24px; height: 1px;
  background: var(--brass); opacity: 0.7;
}
.potion-app .potion-card .potion-kicker { color: var(--text-muted); }
.potion-app .potion-card .potion-kicker::before { background: var(--text-muted); }

/* Brass hairline divider */
.potion-app .potion-hairline {
  height: 1px;
  background: rgba(184,146,74,0.45);
  margin: 18px 0 14px;
}
.potion-app .potion-card .potion-hairline { background: rgba(28,22,16,0.18); }
```

- [ ] **Step 3: Verify in dev server**

Open `http://localhost:3000/plan/<draft-token>` in a browser. Expected:
- Wizard loads without errors (no console errors, no white screen)
- Welcome card heading "Welcome Back!" renders in dark brown (not cream-on-cream)
- The chalkboard background still shows through outside the card
- No visible layout shifts compared to before (only color treatment changed)

- [ ] **Step 4: Commit**

```
git add client/src/pages/plan/PotionPlanningLab.js client/src/index.css
git commit -m "feat(planner): add .potion-app scope wrapper and parchment card primitives"
```

---

## Task 2: Chrome (brass rail, step counter, step nav buttons)

Ports the chrome the user navigates through: the masthead-area step counter, the brass-rail tick progression, the step-nav button row.

**Files:**
- Modify: `client/src/index.css` (append after Task 1 block)

- [ ] **Step 1: Append chrome CSS to `client/src/index.css`**

```css

/* Chrome: step counter (existing markup wraps in inline style; restyle via class) */
.potion-app .potion-progress-counter {
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--brass);
  display: inline-flex; align-items: center; gap: 10px;
  min-height: 28px;
}
.potion-app .potion-progress-counter::before {
  content: ""; width: 24px; height: 1px;
  background: var(--brass); opacity: 0.7;
}

/* Chrome: brass-rail step indicator (done / active / upcoming) */
.potion-app .potion-rail {
  display: flex; gap: 6px;
  margin: 0 0 26px;
}
.potion-app .potion-rail-tick {
  flex: 1;
  height: 2px;
  background: rgba(184,146,74,0.18);
  position: relative;
}
.potion-app .potion-rail-tick.done   { background: var(--amber); opacity: 0.78; }
.potion-app .potion-rail-tick.active { background: var(--brass); }

/* Step transition */
.potion-app .potion-step { animation: potionFadeIn 320ms ease-out both; }
@keyframes potionFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Step-nav (Back / Next button row) */
.potion-app .step-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  margin-top: 22px;
  padding-top: 4px;
  min-height: 56px;
}
.potion-app .step-nav-right { display: flex; gap: 10px; }
.potion-app .step-nav .btn-secondary {
  color: var(--cream-text);
  border-color: rgba(184,146,74,0.5);
}
.potion-app .step-nav .btn-secondary:hover { background: rgba(184,146,74,0.10); }

/* Planner-scoped button polish */
.potion-app .btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 12px 22px;
  border-radius: var(--radius);
  font-family: var(--font-body);
  font-size: 0.96rem;
  letter-spacing: 0.05em;
  text-decoration: none;
  cursor: pointer;
  transition: transform .18s ease, background .18s ease, box-shadow .18s ease, color .18s ease, border-color .18s ease;
  white-space: nowrap;
  border: 2px solid transparent;
  font-weight: 500;
}
.potion-app .btn-primary {
  background: var(--amber);
  color: var(--cream-text);
  box-shadow: 0 2px 10px rgba(29,140,137,0.32);
}
.potion-app .btn-primary:hover { background: var(--warm-brown); transform: translateY(-1px); }
.potion-app .btn-secondary {
  background: transparent;
  color: var(--deep-brown);
  border-color: rgba(28,22,16,0.32);
}
.potion-app .btn-secondary:hover { background: rgba(184,146,74,0.10); }
.potion-app .btn-success {
  background: var(--forest);
  color: var(--cream-text);
  box-shadow: 0 2px 10px rgba(29,90,74,0.32);
}
.potion-app .btn-success:hover { background: var(--success); }
.potion-app .btn-ghost {
  background: transparent;
  color: var(--brass);
  border-color: transparent;
  padding: 8px 12px;
}
.potion-app .btn-ghost:hover { color: var(--brass-bright); }
.potion-app .btn-sm { padding: 7px 14px; font-size: 0.85rem; }
```

- [ ] **Step 2: Verify**

Reload the planner. Click through Welcome → Quick-Pick → first module step. Expected:
- "Step N of M" text in brass with the hairline lead-in
- Back/Next buttons sit comfortably at the bottom
- Next button is teal (`--amber`); hover deepens to `--warm-brown`
- Back button outlined cream-on-chalkboard
- Step transition fades in (~320ms)

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port chrome (step counter, brass rail, step-nav buttons)"
```

---

## Task 3: Continuous save indicator (JSX + CSS)

Switches the save indicator from visibility-toggled to always-visible with the whisper brass pulse. Idle, saving, and failed states share the dot.

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js:919-926`
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append save indicator CSS to `client/src/index.css`**

```css

/* Save indicator: continuous whisper brass pulse, three states */
.potion-app .potion-save-wrap {
  text-align: center;
  padding: 0.25rem;
  font-size: 0.85rem;
  min-height: 1.5rem;
}
.potion-app .potion-save {
  font-family: var(--font-body);
  font-style: italic;
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--brass);
  display: inline-flex; align-items: center; gap: 8px;
  min-width: 88px;
  opacity: 0.92;
}
.potion-app .potion-save::before {
  content: "";
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--brass);
  box-shadow: 0 0 0 0 rgba(184,146,74,0.55);
  animation: potion-brass-pulse 3s ease-in-out infinite;
}
@keyframes potion-brass-pulse {
  0%   { opacity: 0.55; transform: scale(0.9); box-shadow: 0 0 0 0 rgba(184,146,74,0.4); }
  50%  { opacity: 1;    transform: scale(1);   box-shadow: 0 0 12px 2px rgba(184,146,74,0.35); }
  100% { opacity: 0.55; transform: scale(0.9); box-shadow: 0 0 0 0 rgba(184,146,74,0.4); }
}
.potion-app .potion-save.saved { color: rgba(240,232,214,0.55); }
.potion-app .potion-save.saved::before { animation-play-state: paused; opacity: 0.4; box-shadow: none; }
.potion-app .potion-save.failed { color: var(--rust); }
.potion-app .potion-save.failed::before {
  background: var(--rust);
  box-shadow: 0 0 0 0 rgba(160,82,45,0.5);
  animation-play-state: paused;
}

@media (prefers-reduced-motion: reduce) {
  .potion-app .potion-save::before { animation: none; opacity: 0.7; }
}
```

- [ ] **Step 2: Replace the save indicator block in `PotionPlanningLab.js`**

Find this block at approximately `client/src/pages/plan/PotionPlanningLab.js:917-926`:

```jsx
        {/* Reserve vertical space so the indicator (when it appears for
            manual saves or intermittent save failures) doesn't shift layout. */}
        <div style={{ minHeight: '1.5rem', textAlign: 'center', padding: '0.25rem', fontSize: '0.85rem' }}>
          {saving && (
            <span role="status" aria-live="polite" style={{ opacity: 0.6 }}>Saving…</span>
          )}
          {saveFailed && !saving && (
            <span role="alert" style={{ color: '#c0392b' }}>Draft may not be saved. Check your connection.</span>
          )}
        </div>
```

Replace with:

```jsx
        {/* Continuous whisper brass pulse on the save indicator. Idle, saving,
            and failed states share the dot. aria-live="off" on idle so screen
            readers do not announce "Saved" every save cycle. */}
        {plan && step !== 'submitted' && (
          <div className="potion-save-wrap">
            <span
              className={`potion-save ${saveFailed ? 'failed' : (saving ? '' : 'saved')}`}
              role={saveFailed ? 'alert' : 'status'}
              aria-live={saveFailed ? 'assertive' : (saving ? 'polite' : 'off')}
            >
              {saveFailed
                ? 'Draft may not be saved. Check your connection.'
                : saving ? 'Saving…' : 'Saved'}
            </span>
          </div>
        )}
```

- [ ] **Step 3: Verify**

Reload the planner. Expected:
- Brass dot pulses continuously (3s cycle) next to the word "Saved" while idle
- Make a selection (e.g., click a serving-type card). The pulse brightens and the text flips to "Saving…" for ~500ms, then back to "Saved"
- Disable network in DevTools, make another selection, verify "Draft may not be saved..." renders with a rust-colored dot
- `prefers-reduced-motion` (DevTools rendering tab): pulse halts to a steady dot

- [ ] **Step 4: Commit**

```
git add client/src/pages/plan/PotionPlanningLab.js client/src/index.css
git commit -m "feat(planner): continuous whisper brass pulse on save indicator"
```

---

## Task 4: Welcome screen CSS

Ports `.potion-welcome-*` and `.potion-hosted-list` styling. The existing image grid layout and mobile reflow in `RefinementWelcomeStep.js` are preserved; only color treatment changes.

**Files:**
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append welcome CSS to `client/src/index.css`**

```css

/* Welcome screen */
.potion-app .potion-welcome-title,
.potion-app .potion-card .potion-welcome-title {
  font-family: var(--font-display);
  font-size: clamp(2rem, 4.2vw, 3.2rem);
  color: var(--deep-brown);
  margin: 0 0 4px;
  line-height: 1.04;
}
.potion-app .potion-welcome-sub {
  font-style: italic;
  color: var(--text-muted);
  margin: 0 0 18px;
  font-size: 1.05rem;
}
.potion-app .potion-welcome-body {
  display: grid;
  grid-template-columns: 120px 1fr 120px;
  align-items: center;
  gap: 28px;
  margin-top: 20px;
}
.potion-app .potion-welcome-bartender,
.potion-app .potion-welcome-drinks {
  width: 100%;
  height: 140px;
  border-radius: 6px;
  object-fit: contain;
}
.potion-app .potion-welcome-text p { color: rgba(28,22,16,0.82); }
.potion-app .potion-welcome-text strong { color: var(--deep-brown); }

@media (max-width: 720px) {
  .potion-app .potion-welcome-body {
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      "bartender drinks"
      "text text";
  }
  .potion-app .potion-welcome-bartender { grid-area: bartender; height: 110px; }
  .potion-app .potion-welcome-drinks    { grid-area: drinks;    height: 110px; }
  .potion-app .potion-welcome-text      { grid-area: text; }
}

/* Hosted "Your package" list with apothecary bullet */
.potion-app .potion-hosted-list {
  margin: 8px 0 6px;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 18px;
}
.potion-app .potion-hosted-list li {
  font-size: 0.93rem;
  color: var(--deep-brown);
  padding-left: 16px;
  position: relative;
}
.potion-app .potion-hosted-list li::before {
  content: "⚗";
  position: absolute;
  left: 0; top: 1px;
  color: var(--brass);
  font-family: var(--font-display);
  font-size: 0.85rem;
}

@media (max-width: 600px) {
  .potion-app .potion-hosted-list { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Verify**

Navigate to a draft plan at `/plan/<token>`. Expected on the welcome screen:
- Welcome card renders parchment with brass border
- "Welcome Back!" heading in dark brown
- Bartender PNG on left, drinks PNG on right, text centered (desktop)
- At ≤720px viewport (DevTools mobile): images side-by-side on row 1, text on row 2 (existing mobile reflow preserved)
- On a hosted plan token, the existing "Your package: ..." card above the welcome card now renders with ⚗ brass bullets in a 2-column grid

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port welcome screen and hosted package list styling"
```

---

## Task 5: Quick-pick grid

Ports `.serving-type-*` styles. The 400ms select delay and `.selected`/`.selecting` class transitions in the existing JSX are unchanged.

**Files:**
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append quick-pick CSS to `client/src/index.css`**

```css

/* Quick-pick: serving type cards */
.potion-app .serving-type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}
.potion-app .serving-type-card {
  position: relative;
  text-align: left;
  cursor: pointer;
  background: linear-gradient(180deg, var(--paper) 0%, var(--card-bg) 100%);
  border: 1px solid rgba(184,146,74,0.45);
  border-radius: var(--radius);
  padding: 22px 22px 20px;
  color: var(--deep-brown);
  font-family: var(--font-body);
  transition: transform .22s ease, border-color .22s ease, box-shadow .22s ease, background .22s ease;
  min-height: 168px;
  display: flex; flex-direction: column; gap: 8px;
}
.potion-app .serving-type-card:hover {
  border-color: var(--plum);
  background: linear-gradient(180deg, var(--paper) 0%, #DAC9DA 110%);
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(0,0,0,0.28);
}
.potion-app .serving-type-card.selected,
.potion-app .serving-type-card.selecting {
  border: 2px solid var(--amber);
  background: linear-gradient(180deg, #E8F0EE 0%, #DCEAE7 100%);
  box-shadow:
    0 0 0 3px rgba(29,140,137,0.18),
    var(--shadow-card);
  padding: 21px 21px 19px;
}
.potion-app .serving-type-card.selecting::after {
  content: "";
  position: absolute; inset: 6px;
  border: 1px solid var(--amber);
  border-radius: 6px;
  animation: potion-select-frame 400ms ease-out forwards;
  pointer-events: none;
}
@keyframes potion-select-frame {
  from { opacity: 0; transform: scale(0.94); }
  to   { opacity: 0.8; transform: scale(1); }
}
.potion-app .serving-type-card:disabled { cursor: default; }

.potion-app .serving-type-emoji {
  font-size: 26px;
  line-height: 1;
  width: 44px; height: 44px;
  border-radius: 50%;
  background: rgba(184,146,74,0.16);
  border: 1px solid rgba(184,146,74,0.4);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 4px;
}
.potion-app .serving-type-card.selected .serving-type-emoji {
  background: rgba(29,140,137,0.16);
  border-color: var(--amber);
}
.potion-app .serving-type-label {
  font-family: var(--font-display);
  font-size: 1.18rem;
  color: var(--deep-brown);
  margin: 0;
  line-height: 1.15;
}
.potion-app .serving-type-desc {
  margin: 0;
  font-size: 0.92rem;
  color: rgba(28,22,16,0.7);
  line-height: 1.45;
}
```

- [ ] **Step 2: Verify**

Click "Next" from welcome (BYOB plan) to land on QuickPickStep. Expected:
- Serving-type cards arranged in an auto-fit grid (1, 2, or 3 columns depending on width)
- Each card parchment with brass hairline border, plum-tinted hover lift
- Click a card: 400ms selection frame animates in (teal), then the wizard advances to the first module step
- Card label in dark brown, description in muted brown, emoji circle with brass border

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port quick-pick serving-type grid"
```

---

## Task 6: Drink picker grid + your-menu list

Ports the grid drink picker (`.drink-card-grid`, `.drink-tile`) and the selected-drinks list (`.your-menu-*`). The horizontal-list and sidebar variants from `planner.css` are NOT ported (designer chose grid).

**Files:**
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append drink picker CSS to `client/src/index.css`**

```css

/* Drink picker: grid variant (chosen by designer) */
.potion-app .drink-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.potion-app .drink-tile {
  cursor: pointer;
  padding: 16px 14px;
  background: linear-gradient(180deg, var(--paper) 0%, var(--card-bg) 100%);
  border: 1px solid rgba(184,146,74,0.4);
  border-radius: var(--radius);
  color: var(--deep-brown);
  font-family: var(--font-body);
  text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  position: relative;
  min-height: 134px;
}
.potion-app .drink-tile .drink-card-emoji {
  font-size: 26px;
  width: 52px; height: 52px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(184,146,74,0.16);
  border: 1px solid rgba(184,146,74,0.4);
  border-radius: 50%;
  flex-shrink: 0;
}
.potion-app .drink-tile.selected {
  border: 2px solid var(--amber);
  padding: 15px 13px;
  background: linear-gradient(180deg, #E8F0EE 0%, #DCEAE7 100%);
}
.potion-app .drink-tile.selected .drink-card-emoji {
  background: rgba(29,140,137,0.18);
  border-color: var(--amber);
}
.potion-app .drink-tile-name {
  font-family: var(--font-display);
  font-size: 1.02rem;
  color: var(--deep-brown);
}
.potion-app .drink-tile-desc {
  font-size: 0.8rem;
  color: rgba(28,22,16,0.6);
  line-height: 1.35;
}

/* Your-menu: list of selected drinks */
.potion-app .your-menu-list {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 10px;
}
.potion-app .your-menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: rgba(184,146,74,0.10);
  border: 1px solid rgba(184,146,74,0.32);
  border-radius: 6px;
  font-family: var(--font-body);
  color: var(--deep-brown);
}
.potion-app .your-menu-number {
  font-family: var(--font-display);
  color: var(--brass);
  width: 22px; flex-shrink: 0;
}
.potion-app .your-menu-emoji { font-size: 18px; }
.potion-app .your-menu-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.potion-app .your-menu-info strong { font-family: var(--font-display); font-weight: 400; font-size: 1.05rem; color: var(--deep-brown); }
.potion-app .your-menu-info .text-muted { color: rgba(28,22,16,0.6); font-size: 0.82rem; }
.potion-app .your-menu-remove {
  background: transparent;
  border: 1px solid rgba(28,22,16,0.25);
  width: 24px; height: 24px;
  border-radius: 50%;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.potion-app .your-menu-remove:hover {
  background: rgba(160,82,45,0.18);
  border-color: var(--rust);
  color: var(--rust);
}

/* Per-drink upgrade chips (plum) under selected drinks */
.potion-app .your-menu-drink-extras {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 6px 12px 10px 44px;
  margin-top: -8px;
}
.potion-app .your-menu-extra-tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px;
  background: rgba(107,77,122,0.16);
  color: var(--plum);
  border: 1px solid rgba(107,77,122,0.4);
  border-radius: 999px;
  font-size: 0.78rem;
}
.potion-app .your-menu-extra-tag.flair {
  background: rgba(184,146,74,0.16);
  color: var(--text-muted);
  border-color: rgba(184,146,74,0.4);
}

/* Mobile collapses grid to single column (rare; min-width 180 usually keeps 2 columns) */
@media (max-width: 380px) {
  .potion-app .drink-card-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Verify**

Pick a serving type that includes signature cocktails (e.g., "Specialty Cocktails Only"). On SignaturePickerStep:
- Drink cards arranged in an auto-fit grid
- Tile is parchment with brass hairline; emoji circle on top, name + description below
- Click a drink: 2px teal border, light-teal background fade, drink slides into the "Your Menu" list below
- Your-menu items render with brass number, emoji, drink name, and an X remove button
- If a drink has an upgrade chip (e.g., carbonation), it renders as a plum pill below the menu line

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port drink picker grid and your-menu list"
```

---

## Task 7: Form elements + on-paper text-color overrides

Ports `.form-*` and `.checkbox-*` plus the specificity override block that ensures every parchment-card label renders dark brown.

**Files:**
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append form element CSS to `client/src/index.css`**

```css

/* Form elements: clean inputs on paper */
.potion-app .form-group { margin-bottom: 18px; }
.potion-app .form-label {
  display: block;
  font-family: var(--font-display);
  font-size: 0.75rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.potion-app .form-input,
.potion-app .form-textarea,
.potion-app .form-select {
  width: 100%;
  font-family: var(--font-body);
  font-size: 1rem;
  background: var(--paper);
  color: var(--deep-brown);
  border: 1px solid rgba(28,22,16,0.22);
  border-radius: var(--radius);
  padding: 11px 13px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.potion-app .form-input:focus,
.potion-app .form-textarea:focus,
.potion-app .form-select:focus {
  outline: 0;
  border: 2px solid var(--amber);
  padding: 10px 12px;
  box-shadow: 0 0 0 3px rgba(29,140,137,0.18);
}

.potion-app .checkbox-grid { display: flex; flex-direction: column; gap: 8px; }
.potion-app .checkbox-label {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: transparent;
  border: 1px solid rgba(28,22,16,0.18);
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--font-body);
  color: var(--deep-brown);
}
.potion-app .checkbox-label:hover { background: rgba(28,22,16,0.04); }
.potion-app .checkbox-label input { accent-color: var(--amber); }
.potion-app .checkbox-label.checked,
.potion-app .checkbox-label:has(input:checked) {
  background: rgba(29,140,137,0.10);
  border-color: var(--amber);
}

/* Component-rule overrides: beats global h*/p color rules inside parchment surfaces */
.potion-app .serving-type-card h1,
.potion-app .serving-type-card h2,
.potion-app .serving-type-card h3,
.potion-app .serving-type-card h4,
.potion-app .drink-tile h1,
.potion-app .drink-tile h2,
.potion-app .drink-tile h3 { color: var(--deep-brown); }

.potion-app .serving-type-card p,
.potion-app .drink-tile p,
.potion-app .your-menu-item p,
.potion-app .checkbox-label p { color: rgba(28,22,16,0.78); }

.potion-app .serving-type-label { color: var(--deep-brown); }
.potion-app .serving-type-desc  { color: rgba(28,22,16,0.7); }
.potion-app .drink-tile-name    { color: var(--deep-brown); }
.potion-app .drink-tile-desc    { color: rgba(28,22,16,0.6); }
```

- [ ] **Step 2: Verify**

On any step with text inputs (e.g., CustomSetupStep, MenuDesignStep, LogisticsStep):
- Form input has parchment background with thin dark border
- Focus state: 2px teal border with soft teal glow
- Form-label renders in muted brown small-caps above the input
- Checkbox/radio labels in dark brown on parchment, teal-tinted when checked
- No cream-on-cream text anywhere in the parchment surfaces

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port form elements and on-paper text-color overrides"
```

---

## Task 8: menuStyle migration + DEFAULT_SELECTIONS + 2-variant submit copy

The first JS-logic task. Migrates legacy `customMenuDesign` boolean into the new `menuStyle` three-value field, adds the default, and updates the celebration copy to fork on whether a menu was picked.

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js:26-60` (DEFAULT_SELECTIONS)
- Modify: `client/src/pages/plan/PotionPlanningLab.js:153-228` (saved-state restoration)
- Modify: `client/src/pages/plan/PotionPlanningLab.js:730-732` (celebration copy)

- [ ] **Step 1: Add `menuStyle: null` to DEFAULT_SELECTIONS**

In `client/src/pages/plan/PotionPlanningLab.js` around line 48-51, find:

```js
  syrupSelections: {},
  syrupSelfProvided: [],
  addOns: {},
  customMenuDesign: null,
  menuTheme: '',
  drinkNaming: '',
  menuDesignNotes: '',
```

Replace with (add `menuStyle: null`):

```js
  syrupSelections: {},
  syrupSelfProvided: [],
  addOns: {},
  customMenuDesign: null,
  menuStyle: null,
  menuTheme: '',
  drinkNaming: '',
  menuDesignNotes: '',
```

- [ ] **Step 2: Add the migration inside the saved-state restore block**

In `PotionPlanningLab.js`, find the existing migration block (around line 155-170, just after `const savedSel = data.selections || {};`). After the existing migrations (the legacy flat `syrupSelections` array migration and the proposal-syrups merge), insert:

```js
          // Migrate legacy customMenuDesign boolean to three-value menuStyle.
          // Only runs when menuStyle has not been set yet (idempotent).
          // customMenuDesign is preserved in the JSON for any consumer reading old plans.
          if (savedSel.menuStyle === undefined) {
            if (savedSel.customMenuDesign === true) savedSel.menuStyle = 'custom';
            else if (savedSel.customMenuDesign === false) savedSel.menuStyle = 'none';
            else savedSel.menuStyle = null;
          }
```

The exact placement is after the existing addOns migration block at line ~196 (`if (savedSel.addOns) { ... }`) and before the legacy-exploration shim at line ~200. Inserting between those two blocks keeps the migrations in logical order.

- [ ] **Step 3: Update the celebration copy to fork on `menuStyle`**

In `PotionPlanningLab.js` around line 730-732, find:

```jsx
              <p className="text-muted text-small">
                {selections.customMenuDesign === true
                  ? "We'll use your selections to create a shopping list, custom menu, and BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"
                  : "We'll use your selections to create a shopping list and BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"}
              </p>
```

Replace with:

```jsx
              <p className="text-muted text-small">
                {(selections.menuStyle === 'custom' || selections.menuStyle === 'house')
                  ? "We'll use your selections to create a shopping list, a menu, and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"
                  : "We'll use your selections to create a shopping list and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"}
              </p>
```

- [ ] **Step 4: Verify migration with a legacy plan**

Pick a draft plan that was created before this change. The plan's `selections` JSON has `customMenuDesign` (boolean or null) but no `menuStyle`. Load it at `/plan/<token>`. In the browser console:

```js
// Open React DevTools, find <PotionPlanningLab>, inspect `selections` state.
// Or peek into the next auto-save payload via the Network tab. The PUT to
// /api/drink-plans/t/<token> should now include menuStyle alongside the legacy
// customMenuDesign field.
```

Expected: a plan with `customMenuDesign: true` shows `menuStyle: 'custom'`. A plan with `customMenuDesign: false` shows `menuStyle: 'none'`. A plan with `customMenuDesign: null` shows `menuStyle: null`.

For the celebration copy, navigate a submitted plan or test by manually editing the saved JSON (admin route or DB). The "What happens next?" text on the submitted screen should flip correctly.

- [ ] **Step 5: Commit**

```
git add client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(planner): migrate customMenuDesign to menuStyle and fork celebration copy"
```

---

## Task 9: MenuDesignStep three-radio UI + reveals

Replaces the two-radio Yes/No with the three-radio Custom / Standard Menu / No Menu Card. Conditional reveals: Custom shows existing textareas, Standard and None show field notes.

**Files:**
- Modify: `client/src/pages/plan/steps/MenuDesignStep.js` (whole file rework)

- [ ] **Step 1: Replace the file contents**

Open `client/src/pages/plan/steps/MenuDesignStep.js` and replace the entire file with:

```jsx
import React, { useState } from 'react';
import MenuSamplesModal from '../../../components/MenuSamplesModal';
import { MENU_SAMPLES } from '../../../data/menuSamples';

export default function MenuDesignStep({ selections, activeModules, cocktails = [], mocktails = [], onChange }) {
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));
  const [samplesOpen, setSamplesOpen] = useState(false);

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Menu Design
        </h2>
        <p className="text-muted">
          Here's a summary of your selections. Below, choose how you'd like your drink menu displayed at the event.
        </p>
      </div>

      {/* Summary */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Your Selections
        </h3>

        {activeModules.signatureDrinks && selectedDrinks.length > 0 && (
          <div className="mb-2">
            <strong>Signature Cocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {selections.signatureDrinkSpirits?.length > 0 && (
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks && (
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
                Basic mixers included for simple mixed drinks
              </p>
            )}
          </div>
        )}

        {activeModules.mocktails && selectedMocktails.length > 0 && (
          <div className="mb-2">
            <strong>Mocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedMocktails.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {selections.mocktailNotes && (
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
                Notes: {selections.mocktailNotes}
              </p>
            )}
          </div>
        )}

        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}
                {selections.spiritsOther && `, ${selections.spiritsOther}`}
              </p>
            )}
            {selections.mixersForSpirits && (
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
                Mixers requested for bar spirits
              </p>
            )}
            {selections.beerFromFullBar?.length > 0 && selections.beerFromFullBar[0] !== 'None' && (
              <p><strong>Beer:</strong> {selections.beerFromFullBar.join(', ')}</p>
            )}
            {selections.beerFromFullBar?.[0] === 'None' && (
              <p><strong>Beer:</strong> None</p>
            )}
            {selections.wineFromFullBar?.length > 0 && selections.wineFromFullBar[0] !== 'None' && (
              <p><strong>Wine:</strong> {selections.wineFromFullBar.join(', ')}
                {selections.wineOtherFullBar && ` (${selections.wineOtherFullBar})`}
              </p>
            )}
            {selections.wineFromFullBar?.[0] === 'None' && (
              <p><strong>Wine:</strong> None</p>
            )}
            {selections.beerWineBalanceFullBar && (
              <p><strong>Guest preference:</strong> {selections.beerWineBalanceFullBar.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</p>
            )}
          </div>
        )}

        {activeModules.beerWineOnly && !activeModules.fullBar && (
          <div className="mb-2">
            {selections.beerFromBeerWine?.length > 0 && selections.beerFromBeerWine[0] !== 'None' && (
              <p><strong>Beer:</strong> {selections.beerFromBeerWine.join(', ')}</p>
            )}
            {selections.beerFromBeerWine?.[0] === 'None' && (
              <p><strong>Beer:</strong> None</p>
            )}
            {selections.wineFromBeerWine?.length > 0 && selections.wineFromBeerWine[0] !== 'None' && (
              <p><strong>Wine:</strong> {selections.wineFromBeerWine.join(', ')}
                {selections.wineOtherBeerWine && ` (${selections.wineOtherBeerWine})`}
              </p>
            )}
            {selections.wineFromBeerWine?.[0] === 'None' && (
              <p><strong>Wine:</strong> None</p>
            )}
            {selections.beerWineBalanceBeerWine && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {!activeModules.signatureDrinks && !activeModules.fullBar && !activeModules.beerWineOnly && !activeModules.mocktails && (
          <p className="text-muted" style={{ color: 'var(--text-muted)' }}>No drink selections yet.</p>
        )}
      </div>

      {/* Three-way Menu Design */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">How would you like your drink menu displayed at the event?</label>
          {MENU_SAMPLES.length > 0 && (
            <button
              type="button"
              className="menu-samples-trigger"
              onClick={() => setSamplesOpen(true)}
            >
              See sample menus →
            </button>
          )}
          <div className="checkbox-grid">
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'custom'}
                onChange={() => onChange('menuStyle', 'custom')}
              />
              <span>Custom Menu Design (designed for your event's look and feel)</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'house'}
                onChange={() => onChange('menuStyle', 'house')}
              />
              <span>Standard Menu (Dr. Bartender branded, drinks listed in plain terms)</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'none'}
                onChange={() => onChange('menuStyle', 'none')}
              />
              <span>No Menu Card (we'll skip the printed menu)</span>
            </label>
          </div>
        </div>

        <MenuSamplesModal isOpen={samplesOpen} onClose={() => setSamplesOpen(false)} />

        {selections.menuStyle === 'custom' && (
          <>
            <div className="form-group">
              <label className="form-label">Your event theme, colors, or overall vibe</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rustic fall colors, elegant black and gold, tropical vibes, garden party..."
                value={selections.menuTheme || ''}
                onChange={(e) => onChange('menuTheme', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Any drink names you'd like included?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rename 'Old Fashioned' to 'The Groom's Go-To', or let us get creative..."
                value={selections.drinkNaming || ''}
                onChange={(e) => onChange('drinkNaming', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Any other inspiration or preferences for the menu design?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., we have a Pinterest board, match our invitation style, include our monogram..."
                value={selections.menuDesignNotes || ''}
                onChange={(e) => onChange('menuDesignNotes', e.target.value)}
              />
            </div>
          </>
        )}

        {selections.menuStyle === 'house' && (
          <span className="potion-field-note">
            Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you.
          </span>
        )}

        {selections.menuStyle === 'none' && (
          <span className="potion-field-note">
            No printed menu will be created. Your selections still drive your shopping list.
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Navigate to MenuDesignStep. Expected:
- Three radio options labeled Custom Menu Design / Standard Menu / No Menu Card
- Clicking Custom: theme / drink-naming / notes textareas appear below
- Clicking Standard: a single italic note appears about the Dr. Bartender branded menu printed and framed
- Clicking None: a single italic note appears about no printed menu
- Selecting a radio updates the underlying state (verify by clicking Next, then Back; the radio remains selected)
- Legacy plans (`customMenuDesign === true`) load with "Custom" pre-selected; `false` loads with "No Menu Card" pre-selected; `null` loads with no radio selected

- [ ] **Step 3: Commit**

```
git add client/src/pages/plan/steps/MenuDesignStep.js
git commit -m "feat(planner): three-way Menu Design with Custom, Standard, and No Menu options"
```

---

## Task 10: ConfirmationStep three-way Menu Design summary

Updates the Menu Design summary in ConfirmationStep from two cases (yes/no) to three cases (custom/standard/none).

**Files:**
- Modify: `client/src/pages/plan/steps/ConfirmationStep.js:407-425`

- [ ] **Step 1: Replace the Menu Design summary block**

In `client/src/pages/plan/steps/ConfirmationStep.js`, find the block around lines 407-425:

```jsx
        {/* Menu Design */}
        {selections.customMenuDesign === true && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> Yes
            {selections.menuTheme && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Theme: {selections.menuTheme}</p>
            )}
            {selections.drinkNaming && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Custom naming: {selections.drinkNaming}</p>
            )}
            {selections.menuDesignNotes && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Design notes: {selections.menuDesignNotes}</p>
            )}
          </div>
        )}
        {selections.customMenuDesign === false && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> No
          </div>
        )}
```

Replace with:

```jsx
        {/* Menu Design (three-way) */}
        {selections.menuStyle === 'custom' && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> Yes
            {selections.menuTheme && (
              <p className="text-muted" style={{ color: 'var(--text-muted)' }}>Theme: {selections.menuTheme}</p>
            )}
            {selections.drinkNaming && (
              <p className="text-muted" style={{ color: 'var(--text-muted)' }}>Custom naming: {selections.drinkNaming}</p>
            )}
            {selections.menuDesignNotes && (
              <p className="text-muted" style={{ color: 'var(--text-muted)' }}>Design notes: {selections.menuDesignNotes}</p>
            )}
          </div>
        )}
        {selections.menuStyle === 'house' && (
          <div className="mb-2">
            <strong>Menu Design:</strong> Standard menu (Dr. Bartender branded, printed and framed for the bar)
          </div>
        )}
        {selections.menuStyle === 'none' && (
          <div className="mb-2">
            <strong>Menu Design:</strong> No menu card
          </div>
        )}
```

Note the `var(--warm-brown)` substitutions to `var(--text-muted)` to match the brown semantic the spec calls out.

- [ ] **Step 2: Verify**

Navigate to ConfirmationStep on plans in each of the three states:
- A plan with `menuStyle === 'custom'`: shows "Custom Menu Design: Yes" with any theme/naming/notes details
- A plan with `menuStyle === 'house'`: shows "Menu Design: Standard menu (Dr. Bartender branded, printed and framed for the bar)"
- A plan with `menuStyle === 'none'`: shows "Menu Design: No menu card"

- [ ] **Step 3: Commit**

```
git add client/src/pages/plan/steps/ConfirmationStep.js
git commit -m "feat(planner): three-way Menu Design summary on confirmation"
```

---

## Task 11: ScopeBanner component + CSS + mount on 8 steps

Creates the shared `<ScopeBanner>` component and mounts it on every step that gets one. Three tones: shopping (brass), hosted (teal), aside (muted).

**Files:**
- Create: `client/src/pages/plan/components/ScopeBanner.js`
- Modify: `client/src/index.css` (append)
- Modify: `client/src/pages/plan/steps/SignaturePickerStep.js`
- Modify: `client/src/pages/plan/steps/MocktailStep.js`
- Modify: `client/src/pages/plan/steps/FullBarSpiritsStep.js`
- Modify: `client/src/pages/plan/steps/FullBarBeerWineStep.js`
- Modify: `client/src/pages/plan/steps/BeerWineStep.js`
- Modify: `client/src/pages/plan/steps/HostedGuestPrefsStep.js`
- Modify: `client/src/pages/plan/steps/MenuDesignStep.js`
- Modify: `client/src/pages/plan/steps/ConfirmationStep.js`
- Modify: `client/src/pages/plan/PotionPlanningLab.js` (pass `plan` prop to steps that don't yet receive it)

- [ ] **Step 1: Create the shared ScopeBanner component**

Create `client/src/pages/plan/components/ScopeBanner.js` with:

```jsx
import React from 'react';

/**
 * Scope banner that frames each step's purpose for the client.
 *
 * Three tones:
 *   - "shopping" (brass): BYOB; the section feeds the shopping list
 *   - "hosted" (teal):    hosted package; we're providing
 *   - "aside" (muted):    not part of shopping (menu design)
 *
 * The seal character (default ⚗) renders on the left in a small circle.
 */
export default function ScopeBanner({ tone = 'shopping', title, body, seal = '⚗' }) {
  return (
    <div className={`potion-scope ${tone}`}>
      <span className="potion-scope-seal" aria-hidden="true">{seal}</span>
      <div className="potion-scope-body">
        <h3 className="potion-scope-title">{title}</h3>
        <p className="potion-scope-text">{body}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append ScopeBanner CSS to `client/src/index.css`**

```css

/* Scope banners: three tones */
.potion-app .potion-scope {
  display: grid;
  grid-template-columns: 44px 1fr;
  align-items: stretch;
  gap: 14px;
  padding: 14px 18px 14px 14px;
  margin: 0 0 14px;
  background: rgba(184,146,74,0.10);
  border: 1px solid rgba(184,146,74,0.40);
  border-radius: var(--radius);
  color: var(--deep-brown);
  position: relative;
  box-shadow: 0 1px 4px rgba(0,0,0,0.15);
}
.potion-app .potion-scope-seal {
  display: flex; align-items: center; justify-content: center;
  width: 44px; min-height: 44px;
  border-radius: 50%;
  background: rgba(184,146,74,0.18);
  border: 1px solid rgba(184,146,74,0.55);
  color: var(--brass);
  font-family: var(--font-display);
  font-size: 1.4rem;
  line-height: 1;
  align-self: start;
  margin-top: 2px;
}
.potion-app .potion-scope-body { min-width: 0; }

/* Scoped under .potion-app to beat the global page-container h3 / p rules */
.potion-app .potion-scope h3.potion-scope-title,
.potion-app .potion-scope .potion-scope-title {
  font-family: var(--font-display);
  font-size: 1.08rem;
  color: var(--deep-brown);
  margin: 0 0 4px;
  line-height: 1.2;
  text-transform: none;
  letter-spacing: 0.01em;
}
.potion-app .potion-scope p.potion-scope-text,
.potion-app .potion-scope .potion-scope-text {
  margin: 0;
  font-size: 0.94rem;
  line-height: 1.5;
  color: rgba(28,22,16,0.82);
}
.potion-app .potion-scope .potion-scope-text strong { color: var(--deep-brown); }

/* Tone: hosted (we provide) */
.potion-app .potion-scope.hosted {
  background: rgba(29,140,137,0.10);
  border-color: rgba(29,140,137,0.40);
}
.potion-app .potion-scope.hosted .potion-scope-seal {
  background: rgba(29,140,137,0.16);
  border-color: rgba(29,140,137,0.55);
  color: var(--amber);
}
.potion-app .potion-scope.hosted h3.potion-scope-title,
.potion-app .potion-scope.hosted .potion-scope-title { color: var(--deep-brown); }

/* Tone: aside (not part of shopping) */
.potion-app .potion-scope.aside {
  background: rgba(28,22,16,0.05);
  border-color: rgba(28,22,16,0.18);
}
.potion-app .potion-scope.aside .potion-scope-seal {
  background: rgba(28,22,16,0.06);
  border-color: rgba(28,22,16,0.22);
  color: var(--text-muted);
}
.potion-app .potion-scope.aside h3.potion-scope-title,
.potion-app .potion-scope.aside .potion-scope-title { color: var(--text-muted); }
.potion-app .potion-scope.aside p.potion-scope-text,
.potion-app .potion-scope.aside .potion-scope-text { color: rgba(28,22,16,0.66); }
```

- [ ] **Step 3: Mount on `SignaturePickerStep.js`**

Open `client/src/pages/plan/steps/SignaturePickerStep.js`. Read the file first to confirm the existing imports and component signature. At the top, add the import (alongside the other component imports):

```jsx
import ScopeBanner from '../components/ScopeBanner';
```

Find the component's first JSX return (typically the outer `<div>` or fragment). Just inside that wrapper, before any other content, add:

```jsx
{plan?.package_category === 'hosted' ? (
  <ScopeBanner
    tone="hosted"
    title="We're providing"
    body="Pick what you want served. No beverage shopping on your end."
  />
) : (
  <ScopeBanner
    tone="shopping"
    title="Builds your shopping list"
    body="Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy."
  />
)}
```

Verify the component already receives a `plan` prop. If it does not, ALSO update the call site in `PotionPlanningLab.js` (around lines 771-801 where SignaturePickerStep is rendered) to pass `plan={plan}` (it likely already does since Lab.js passes `plan` to many steps; check first).

- [ ] **Step 4: Mount on `MocktailStep.js`**

Open `client/src/pages/plan/steps/MocktailStep.js`. Add the import:

```jsx
import ScopeBanner from '../components/ScopeBanner';
```

Add the conditional banner at the top of the component's return:

```jsx
{plan?.package_category === 'hosted' ? (
  <ScopeBanner
    tone="hosted"
    title="We're providing"
    body="Pick what you want served. No beverage shopping on your end."
  />
) : (
  <ScopeBanner
    tone="shopping"
    title="Builds your shopping list"
    body="Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy."
  />
)}
```

MocktailStep already receives `plan` per Lab.js:817.

- [ ] **Step 5: Mount on `FullBarSpiritsStep.js`**

Open `client/src/pages/plan/steps/FullBarSpiritsStep.js`. Add the import and the conditional banner block (same as Step 3 above).

Check whether this component currently receives a `plan` prop. If not, add `plan` to its props signature and update Lab.js:824-828 to pass `plan={plan}`.

- [ ] **Step 6: Mount on `FullBarBeerWineStep.js`**

Open `client/src/pages/plan/steps/FullBarBeerWineStep.js`. Same pattern as Step 5: add the import, add the conditional banner block, ensure `plan` is in props.

- [ ] **Step 7: Mount on `BeerWineStep.js`**

Open `client/src/pages/plan/steps/BeerWineStep.js`. Same pattern: add the import, add the conditional banner, ensure `plan` is in props.

- [ ] **Step 8: Mount on `HostedGuestPrefsStep.js`** (always hosted)

Open `client/src/pages/plan/steps/HostedGuestPrefsStep.js`. Add the import. Add the banner block at the top of the return (hosted tone always; no conditional needed):

```jsx
<ScopeBanner
  tone="hosted"
  title="We're providing"
  body="Pick what you want served. No beverage shopping on your end."
/>
```

HostedGuestPrefsStep already receives `plan` per Lab.js:858.

- [ ] **Step 9: Mount on `MenuDesignStep.js`** (aside tone)

Open `client/src/pages/plan/steps/MenuDesignStep.js`. Add the import:

```jsx
import ScopeBanner from '../components/ScopeBanner';
```

At the top of the component's return (before the existing center-aligned title card), add:

```jsx
<ScopeBanner
  tone="aside"
  title="Not part of your shopping list"
  body="How you'd like your drink menu displayed at the event."
/>
```

- [ ] **Step 10: Mount on `ConfirmationStep.js`**

Open `client/src/pages/plan/steps/ConfirmationStep.js`. Add the import:

```jsx
import ScopeBanner from '../components/ScopeBanner';
```

At the top of the component's return (before the existing "Here's Your Bar Plan" card), add:

```jsx
{plan?.package_category === 'hosted' ? (
  <ScopeBanner
    tone="hosted"
    title="You're all set"
    body="We'll stock everything based on your picks. No shopping on your end."
  />
) : (
  <ScopeBanner
    tone="shopping"
    title="Your shopping list"
    body="After you submit, we'll generate your final shopping list from everything you've picked. Anything you've added as an upgrade will come from us instead. Menu design isn't on the list."
  />
)}
```

ConfirmationStep already receives `plan` per Lab.js:883.

- [ ] **Step 11: Verify across all 8 steps**

Walk through the wizard on a BYOB plan that activates as many modules as possible (signature + mocktail + full bar + menu design + confirmation). Expected:
- SignaturePickerStep: brass-toned "Builds your shopping list" banner
- MocktailStep: same brass banner
- FullBarSpiritsStep: same brass banner
- FullBarBeerWineStep: same brass banner
- BeerWineStep: same brass banner
- MenuDesignStep: muted-toned "Not part of your shopping list" banner
- ConfirmationStep: brass-toned "Your shopping list" banner with subtraction promise

Walk through a hosted plan. Expected: every banner above flips to teal "We're providing" / "You're all set" except MenuDesignStep which stays the muted aside tone.

LogisticsStep should have NO banner.

- [ ] **Step 12: Commit**

```
git add client/src/pages/plan/components/ScopeBanner.js client/src/index.css client/src/pages/plan/steps/SignaturePickerStep.js client/src/pages/plan/steps/MocktailStep.js client/src/pages/plan/steps/FullBarSpiritsStep.js client/src/pages/plan/steps/FullBarBeerWineStep.js client/src/pages/plan/steps/BeerWineStep.js client/src/pages/plan/steps/HostedGuestPrefsStep.js client/src/pages/plan/steps/MenuDesignStep.js client/src/pages/plan/steps/ConfirmationStep.js client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(planner): scope banners on drink steps, menu design, and confirmation"
```

(Lab.js is only included in the add list if you needed to add `plan` props to step calls; remove it from the add list otherwise.)

---

## Task 12: WelcomeRoadmap component + CSS + mount + hosted summary retune

Adds the three-card welcome roadmap below the existing welcome card. Retunes the hosted package summary card with `.potion-hosted-list`.

**Files:**
- Create: `client/src/pages/plan/components/WelcomeRoadmap.js`
- Modify: `client/src/index.css` (append)
- Modify: `client/src/pages/plan/steps/RefinementWelcomeStep.js` (mount roadmap + restyle hosted summary)

- [ ] **Step 1: Create the WelcomeRoadmap component**

Create `client/src/pages/plan/components/WelcomeRoadmap.js` with:

```jsx
import React from 'react';

/**
 * Welcome roadmap: three cards showing the journey through the wizard.
 * Mounted below the welcome card on RefinementWelcomeStep.
 *
 * - mode: 'byob' | 'hosted'
 * - packageName: required when mode === 'hosted' (used in Part 1 body)
 */
export default function WelcomeRoadmap({ mode = 'byob', packageName = '' }) {
  const isHosted = mode === 'hosted';

  return (
    <div className="potion-roadmap">
      <div className={`potion-roadmap-step ${isHosted ? 'hosted' : 'shopping'}`}>
        <div className="potion-roadmap-num">Part 1</div>
        <h4 className="potion-roadmap-title">
          {isHosted ? 'Pick what we serve' : 'Build your drink menu'}
        </h4>
        <p className="potion-roadmap-body">
          {isHosted
            ? `Your ${packageName || 'package'} is locked in. Choose the specific drinks within it.`
            : "Cocktails, mocktails, beer and wine, spirits. Whatever you'd like to serve, we'll tally up what you need."}
        </p>
        <span className="potion-roadmap-tag">
          {isHosted ? '→ we stock everything' : '→ becomes your shopping list'}
        </span>
      </div>

      <div className="potion-roadmap-step">
        <div className="potion-roadmap-num">Part 2</div>
        <h4 className="potion-roadmap-title">Choose menu design</h4>
        <p className="potion-roadmap-body">
          Custom, standard, or skip it. We bring the printed and framed menu to display on the bar.
        </p>
      </div>

      <div className="potion-roadmap-step">
        <div className="potion-roadmap-num">Part 3</div>
        <h4 className="potion-roadmap-title">Confirm logistics</h4>
        <p className="potion-roadmap-body">
          Event-day contact, parking, equipment, access notes.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append WelcomeRoadmap CSS to `client/src/index.css`**

```css

/* Welcome roadmap: three-card journey */
.potion-app .potion-roadmap {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 18px 0 4px;
}
@media (max-width: 720px) {
  .potion-app .potion-roadmap { grid-template-columns: 1fr; }
}
.potion-app .potion-roadmap-step {
  padding: 14px 16px;
  background: rgba(184,146,74,0.06);
  border: 1px solid rgba(184,146,74,0.30);
  border-radius: var(--radius);
  position: relative;
}
.potion-app .potion-roadmap-step.shopping {
  background: rgba(184,146,74,0.14);
  border-color: rgba(184,146,74,0.55);
}
.potion-app .potion-roadmap-step.hosted {
  background: rgba(29,140,137,0.10);
  border-color: rgba(29,140,137,0.45);
}
.potion-app .potion-roadmap-num {
  font-family: var(--font-display);
  font-size: 0.72rem; letter-spacing: 0.32em; text-transform: uppercase;
  color: var(--brass);
  display: inline-flex; align-items: center; gap: 8px;
  margin-bottom: 4px;
}
.potion-app .potion-roadmap-num::before {
  content: ""; width: 18px; height: 1px;
  background: var(--brass); opacity: 0.7;
}
.potion-app .potion-roadmap-step.hosted .potion-roadmap-num,
.potion-app .potion-roadmap-step.hosted .potion-roadmap-num::before {
  color: var(--amber); background: var(--amber);
}

/* Defeats global .drb h4 (brass + uppercase) and global .page-container h4 (cream) */
.potion-app h4.potion-roadmap-title,
.potion-app .potion-roadmap-title {
  font-family: var(--font-display);
  font-size: 1.05rem;
  color: var(--deep-brown);
  margin: 0 0 4px;
  text-transform: none;
  letter-spacing: 0.01em;
}
.potion-app .potion-roadmap-body {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.45;
  color: rgba(28,22,16,0.74);
}
.potion-app .potion-roadmap-tag {
  display: inline-block;
  margin-top: 8px;
  font-size: 0.74rem;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(184,146,74,0.22);
  color: var(--text-muted);
  border: 1px solid rgba(184,146,74,0.45);
  font-family: var(--font-body);
  font-style: italic;
}
.potion-app .potion-roadmap-step.hosted .potion-roadmap-tag {
  background: rgba(29,140,137,0.18);
  color: var(--amber);
  border-color: rgba(29,140,137,0.45);
}
```

- [ ] **Step 3: Update RefinementWelcomeStep to mount the roadmap and use `.potion-hosted-list` styling**

Replace the entire contents of `client/src/pages/plan/steps/RefinementWelcomeStep.js` with:

```jsx
import React from 'react';
import WelcomeRoadmap from '../components/WelcomeRoadmap';

export default function RefinementWelcomeStep({ plan, guestCount }) {
  const isHosted = plan?.package_category === 'hosted';
  const mode = isHosted ? 'hosted' : 'byob';
  const packageName = plan?.package_name || 'package';

  return (
    <>
      {isHosted && Array.isArray(plan.package_includes) && plan.package_includes.length > 0 && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
            Your package: {plan.package_name}
          </h3>
          <p className="text-muted text-small" style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Stocked &amp; ready:
          </p>
          <ul className="potion-hosted-list">
            {plan.package_includes
              .filter((item) => !/\{(hours|bartenders|bartenders_s)\}/.test(item))
              .map((item, i) => (
                <li key={i}>{item}</li>
              ))}
          </ul>
          <p className="text-muted text-small" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
            Anything beyond this list is an upgrade.
          </p>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <h1 className="potion-welcome-title">
          Welcome Back!
        </h1>

        <div className="potion-welcome-body">
          <img
            src="/images/potion-bartender.png"
            alt="Dr. Bartender"
            className="potion-welcome-bartender"
          />

          <div className="potion-welcome-text">
            {plan?.client_name && (
              <p style={{ fontWeight: 700, marginBottom: '0.5rem' }}>
                {plan.client_name}, your booking is confirmed!
              </p>
            )}

            {guestCount && (
              <p style={{ fontFamily: 'var(--font-display)', marginBottom: '1rem', color: 'var(--deep-brown)' }}>
                Guest count: {guestCount}
              </p>
            )}

            <p>
              Let's finalize the details for your bar and lock everything in.
            </p>
          </div>

          <img
            src="/images/potion-drinks.png"
            alt="Signature cocktails"
            className="potion-welcome-drinks"
          />
        </div>
      </div>

      <WelcomeRoadmap mode={mode} packageName={packageName} />
    </>
  );
}
```

- [ ] **Step 4: Verify**

Load a BYOB plan at `/plan/<token>`. Expected on the welcome screen:
- Welcome card with bartender + drinks images (unchanged)
- Three roadmap cards below, in a row at desktop width:
  - Part 1: brass-tinted, "Build your drink menu", body about cocktails / mocktails / beer & wine / spirits, tag "→ becomes your shopping list"
  - Part 2: neutral parchment, "Choose menu design"
  - Part 3: neutral parchment, "Confirm logistics"
- At ≤720px (DevTools mobile): all three cards stack vertically

Load a hosted plan. Expected:
- Hosted package summary card above the welcome card, with ⚗ brass bullets on the package includes list
- Welcome card unchanged
- Three roadmap cards: Part 1 is teal-tinted, "Pick what we serve", body references the actual package name, tag "→ we stock everything"

- [ ] **Step 5: Commit**

```
git add client/src/pages/plan/components/WelcomeRoadmap.js client/src/index.css client/src/pages/plan/steps/RefinementWelcomeStep.js
git commit -m "feat(planner): welcome roadmap and hosted package summary apothecary retune"
```

---

## Task 13: Inline field notes on MocktailStep and LogisticsStep

Adds the `.potion-field-note` styled hints under two specific notes textareas.

**Files:**
- Modify: `client/src/index.css` (append)
- Modify: `client/src/pages/plan/steps/MocktailStep.js`
- Modify: `client/src/pages/plan/steps/LogisticsStep.js`

- [ ] **Step 1: Append `.potion-field-note` CSS to `client/src/index.css`**

```css

/* Inline scope footnote under a notes textarea */
.potion-app .potion-field-note {
  display: block;
  margin-top: 6px;
  font-size: 0.82rem;
  font-style: italic;
  color: var(--text-muted);
  line-height: 1.45;
}
.potion-app .potion-field-note strong { color: var(--deep-brown); font-style: normal; }
```

- [ ] **Step 2: Mount under the mocktail notes textarea in `MocktailStep.js`**

Open `client/src/pages/plan/steps/MocktailStep.js`. Find the textarea bound to `mocktailNotes` (it's usually labeled "Any notes about your mocktails?" or similar). Immediately after the closing `</textarea>` tag and inside the same `.form-group`, add:

```jsx
<span className="potion-field-note">
  You don't need to tell us what you're providing. Your selections above already settle that. Use this box only for preferences or anything we should know.
</span>
```

- [ ] **Step 3: Mount under the access-notes textarea in `LogisticsStep.js`**

Open `client/src/pages/plan/steps/LogisticsStep.js`. Find the textarea bound to `logistics.accessNotes` (it should be labeled something like "Anything we should know about access or load-in?"). Immediately after the closing `</textarea>` and inside the same `.form-group`, add:

```jsx
<span className="potion-field-note">
  Anything tricky we should know about the venue, like parking, load-in, stairs, or building rules. You don't need to repeat anything you've selected above.
</span>
```

- [ ] **Step 4: Verify**

Navigate to MocktailStep. Below the mocktail notes textarea, an italic muted note appears explaining what NOT to repeat.

Navigate to LogisticsStep. Below the access-notes textarea, an italic muted note appears explaining what kinds of things to mention.

Both notes render in muted brown (`--text-muted`), italic, with a small top margin so they sit just under the field.

- [ ] **Step 5: Commit**

```
git add client/src/index.css client/src/pages/plan/steps/MocktailStep.js client/src/pages/plan/steps/LogisticsStep.js
git commit -m "feat(planner): inline scope notes under mocktail and access-notes fields"
```

---

## Task 14: Confirmation polish + Submitted + Loading/Locked/Error

Ports the remaining CSS blocks: split-with-seal confirmation total, the submitted celebration treatment, and the blocking-state cards.

**Files:**
- Modify: `client/src/index.css` (append)

- [ ] **Step 1: Append confirmation, submitted, and blocking CSS to `client/src/index.css`**

```css

/* Confirmation: leader rows + split total with brass seal */
.potion-app .conf-section { margin-bottom: 16px; }
.potion-app .conf-section strong {
  display: block;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 1.1rem;
  color: var(--deep-brown);
  margin-bottom: 6px;
}
.potion-app .conf-section ul { list-style: none; padding: 0; margin: 0; }
.potion-app .conf-section li {
  padding: 4px 0;
  color: rgba(28,22,16,0.82);
  font-size: 0.95rem;
}
.potion-app .conf-section .conf-note {
  color: var(--text-muted);
  font-size: 0.88rem;
  margin: 4px 0 0;
}

.potion-app .conf-leader {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px dotted rgba(28,22,16,0.22);
  font-family: var(--font-body);
  font-size: 0.96rem;
}
.potion-app .conf-leader:last-of-type { border-bottom: 0; }
.potion-app .conf-leader-label { color: var(--deep-brown); }
.potion-app .conf-leader-amount { color: var(--text-muted); font-variant-numeric: tabular-nums; }

.potion-app .conf-total {
  display: flex; justify-content: space-between;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 2px solid var(--brass);
  align-items: center;
}
.potion-app .conf-total-label {
  font-family: var(--font-display);
  font-size: 1rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-muted);
  display: inline-flex; align-items: center; gap: 10px;
}
.potion-app .conf-total-seal {
  font-family: var(--font-display);
  color: var(--brass);
  font-size: 1.2rem;
}
.potion-app .conf-total-amount {
  font-family: var(--font-display);
  font-size: 2.1rem;
  color: var(--deep-brown);
  letter-spacing: 0.01em;
}

/* Confirmation Stripe payment area */
.potion-app .conf-stripe {
  margin-top: 14px;
  padding: 14px;
  background: var(--paper);
  border: 1px solid rgba(28,22,16,0.18);
  border-radius: var(--radius);
}

/* Payment radio cards */
.potion-app .pay-radio {
  display: block;
  padding: 12px 14px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 8px;
  border: 1px solid rgba(28,22,16,0.18);
  background: transparent;
  color: var(--deep-brown);
}
.potion-app .pay-radio.active {
  border: 2px solid var(--amber);
  padding: 11px 13px;
  background: rgba(29,140,137,0.08);
}
.potion-app .pay-radio-title { font-weight: 600; }
.potion-app .pay-radio-sub { font-size: 0.85rem; color: var(--text-muted); margin-top: 2px; }

/* Submitted celebration */
.potion-app .potion-submitted { text-align: center; }
.potion-app .potion-submitted .potion-ornament {
  font-family: var(--font-display);
  font-size: 1.6rem;
  color: var(--brass);
  letter-spacing: 0.4em;
  display: inline-flex; align-items: center; gap: 14px;
  margin-bottom: 12px;
}
.potion-app .potion-submitted .potion-ornament::before,
.potion-app .potion-submitted .potion-ornament::after {
  content: ""; width: 36px; height: 1px;
  background: var(--brass); opacity: 0.7;
}
.potion-app .potion-submitted h1 {
  font-family: var(--font-display);
  font-size: clamp(2.2rem, 4.6vw, 3.4rem);
  color: var(--deep-brown);
  margin: 0 0 6px;
}

.potion-app .potion-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 20px;
  text-align: left;
}
@media (max-width: 600px) {
  .potion-app .potion-panels { grid-template-columns: 1fr; }
}
.potion-app .potion-panel {
  padding: 16px 18px;
  border-radius: 6px;
}
.potion-app .potion-panel-paid {
  background: rgba(29,90,74,0.14);
  border: 1px solid rgba(29,90,74,0.4);
}
.potion-app .potion-panel-next {
  background: rgba(29,140,137,0.10);
  border: 1px solid rgba(29,140,137,0.32);
}
.potion-app .potion-panel h4 {
  font-family: var(--font-display);
  font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.22em;
  color: var(--text-muted);
  margin: 0 0 6px;
}
.potion-app .potion-panel p {
  font-size: 0.92rem;
  color: rgba(28,22,16,0.82);
  margin: 0;
}

/* Loading / Locked / Error */
.potion-app .potion-blocking {
  display: flex; align-items: center; justify-content: center;
  min-height: 70vh;
  padding: 40px 0;
}
.potion-app .potion-blocking .potion-card,
.potion-app .potion-blocking .card {
  max-width: 480px; text-align: center;
  padding: 36px 32px;
}
.potion-app .potion-spinner {
  width: 36px; height: 36px;
  border-radius: 50%;
  border: 2px solid rgba(28,22,16,0.18);
  border-top-color: var(--amber);
  animation: potion-spin 0.9s linear infinite;
  margin: 0 auto 16px;
}
@keyframes potion-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 2: Verify**

Navigate to ConfirmationStep on a plan with extras (e.g., add a bar rental). Expected:
- Line items render as `.conf-leader` rows with leader-dot dividers
- Total row shows the brass top-border, brass `⚗` seal, and a large display-font dollar amount
- Stripe Elements wrap renders cleanly on paper background
- Pay-now flow still triggers Stripe correctly (sanity-check that confirm payment still works)

Submit the plan. Expected on the submitted celebration:
- Parchment card with the brass ornament line, "Plan Submitted!" heading in dark brown display font
- Bartender PNG centered
- The "Payment Received" green panel (if paid) and the "What happens next?" teal panel render side-by-side at desktop, stack on mobile

Trigger the locked state (e.g., visit a plan token before deposit). Expected: parchment card centered on the chalkboard, dark brown text, button to view proposal.

Trigger the error state (use an invalid token). Expected: same blocking layout with the calm error copy.

Refresh the planner while the network is throttled. Expected: spinner centered, parchment card, "Loading your drink plan..." in muted brown.

- [ ] **Step 3: Commit**

```
git add client/src/index.css
git commit -m "feat(planner): port confirmation total, submitted celebration, and blocking states"
```

---

## Task 15: Specificity audit + cross-device pass

Final verification sweep. No new code. Touches index.css only if a missed cream-on-cream is found or a mobile reflow is broken.

**Files:**
- Possibly modify: `client/src/index.css` (only if fixes are needed)

- [ ] **Step 1: Specificity audit**

Walk through every surface listed in the spec's §9 "definition of done" checklist. At each surface, confirm every heading, label, and text element inside a parchment card renders in `--deep-brown` (real brown, not cream).

Surfaces to check:
- Welcome card (BYOB and hosted)
- Hosted package summary card
- QuickPick serving-type cards (default, hovered, selected, selecting state)
- CustomSetupStep card
- Every drink-card grid tile (default, selected)
- Your-menu items (with and without upgrade chips)
- MocktailStep with notes textarea
- FullBarSpiritsStep (spirits checkboxes)
- FullBarBeerWineStep (beer/wine checkboxes)
- BeerWineStep
- MenuDesignStep (all three radio states)
- LogisticsStep (every field)
- HostedGuestPrefsStep
- ConfirmationStep summary + extras + payment
- Submitted celebration
- Loading card
- Locked card
- Error card

If you find a heading or label rendering cream-on-cream, add a targeted override at the end of `client/src/index.css`:

```css
.potion-app .<component-class> <heading-tag> { color: var(--deep-brown); }
```

- [ ] **Step 2: Mobile reflow audit**

Set DevTools to mobile viewport (360px width). Walk through the wizard end-to-end. Confirm:
- Welcome card image grid: bartender and drinks images side-by-side on row 1, text on row 2
- Welcome roadmap: three cards stack vertically
- Serving-type grid: cards stack to one column
- Drink-card grid: tiles flow to one or two columns depending on width
- Your-menu items: full-width rows
- Confirmation: line items and total stay readable
- Submitted: panels stack vertically

Resize to 720px and 1200px and confirm desktop layouts.

If any layout breaks, add a targeted media-query rule at the end of `client/src/index.css`.

- [ ] **Step 3: Stripe Elements smoke test**

On ConfirmationStep with extras > $0:
- The Stripe `<Elements>` wrapper renders
- The PaymentElement iframe mounts (you should see the card-number / expiration / CVC input fields)
- Click "Pay" with a Stripe test card (e.g., `4242 4242 4242 4242`, any future exp, any CVC, any ZIP)
- Verify the payment goes through (redirected to `?paid=true`, celebration shows "Payment Received")

- [ ] **Step 4: Save-pulse accessibility check**

Verify in a screen reader (or VoiceOver / NVDA / TalkBack):
- On wizard mount: no announcement of "Saved" (aria-live="off" on idle)
- During an auto-save: hear "Saving…" once (aria-live="polite")
- Force a save failure (offline): hear the alert text (aria-live="assertive")

- [ ] **Step 5: Commit (only if fixes were made)**

If you added any override or media-query rules during the audit:

```
git add client/src/index.css
git commit -m "fix(planner): specificity and mobile-reflow fixes from audit pass"
```

If the audit found no issues, no commit needed; the work is done.

---

## Self-review

A check against the spec, run after writing the plan above.

**1. Spec coverage**

| Spec section | Implemented in task |
|---|---|
| §2.1 Visual reskin (all sub-surfaces) | Tasks 1, 2, 4, 5, 6, 7, 14 |
| §2.2 Scope banners on 8 steps | Task 11 |
| §2.3 Welcome roadmap | Task 12 |
| §2.4 Three-way Menu Design (`menuStyle`) | Tasks 8, 9 |
| §2.5 Inline scope notes | Task 13 |
| §2.6 Continuous brass pulse on save | Task 3 |
| §2.7 Hosted welcome polish | Task 12 |
| §2.8 `.potion-app` scoping wrapper | Task 1 |
| §3 Carve-outs | Out of scope (documented in spec only) |
| §4.1 Wrapper class | Task 1 |
| §4.2 Token strategy | Applied throughout (every CSS task uses bare token names) |
| §4.3 Specificity defenses | Tasks 1, 7, 11, 12 + final audit in Task 15 |
| §4.4 Skipped blocks | Implicit; no task ports them |
| §4.5 File size | Implicit; CSS is out of size-hook scope |
| §5.1 index.css append | Tasks 1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14 |
| §5.2 PotionPlanningLab.js edits | Tasks 1 (wrapper), 3 (save indicator), 8 (migration + celebration) |
| §5.3 RefinementWelcomeStep.js | Task 12 |
| §5.4 MenuDesignStep.js | Task 9 |
| §5.5 ConfirmationStep.js | Tasks 10 (summary), 11 (banner mount), 14 (total polish) |
| §5.6 Other step components (scope banner mount) | Task 11 |
| §5.7 Inline scope notes | Task 13 |
| §6 Verbatim copy | Tasks 9, 11, 12, 13 (copy embedded in JSX) + Task 8 (celebration copy) |
| §7 Data shape (`menuStyle` + migration) | Task 8 |
| §8 Implementation order | This plan's task ordering |
| §9 Quality gates | Task 15 audit |
| §10 Risks | Tasks 3 (aria-live mitigation), 12 (hosted stacking verify), 15 (general audit) |

No gaps identified.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "fill in details", or vague handwaving in any task. Every step contains the actual code or command an engineer needs to execute.

**3. Type consistency**

- `menuStyle` values: `'custom'`, `'house'`, `'none'`, `null`, consistent across Task 8 (default + migration), Task 9 (radio onChange), Task 10 (summary conditionals), and Task 8 (celebration conditional). Internal value stays `'house'` even though the user-facing label is "Standard Menu" (documented in Task 9).
- `ScopeBanner` props: `tone`, `title`, `body`, `seal`, consistent across Task 11 (component definition) and all 8 mount points (Task 11 steps 3-10).
- `WelcomeRoadmap` props: `mode` (`'byob'` | `'hosted'`), `packageName`, consistent across Task 12 (component definition) and Task 12 step 3 (mount in RefinementWelcomeStep).
- `.potion-save` class structure: base = saving, `.saved` = idle, `.failed` = error, consistent across Task 3 CSS and Task 3 JSX.
- `plan?.package_category === 'hosted'` check used consistently across Task 11 banner mounts and Task 12 roadmap mode derivation.

No drift detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-potion-planner-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended).** I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because each task is genuinely independent (CSS port chunks + isolated JSX edits) and the user can pace verification.

2. **Inline Execution.** Execute tasks in this session using executing-plans, batch execution with checkpoints. Better if you want to ride along and steer copy/style at each verify step.

Which approach?
