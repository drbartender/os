# Quote Wizard Stepper Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the washed-out, gap-only stepper in `QuoteWizard` and `ClassWizard` by adding a connecting rail, raising contrast on inactive states, and adding animations that clearly signal the current step.

**Architecture:** CSS-only change in `client/src/index.css`. No JSX edits — both wizards already share `.wz-steps` / `.wz-step-dot` / `.wz-step-num` / `.wz-step-label` markup, so the single stylesheet edit covers both consumers. Dead CSS (`.wz-step-connector`) is removed. The connecting rail is drawn via `::after` pseudo-elements; rail fill uses a `background-size` transition; active/enter/check-pop effects use `@keyframes`.

**Tech Stack:** Vanilla CSS (no preprocessors, no CSS modules). Project uses CSS custom properties (`--amber`, `--warm-brown`, `--deep-brown`, `--parchment`) defined at the top of `index.css`.

**Testing model:** No automated tests — this is a visual CSS change. Each task has a browser verification step. `npm run dev` must be running so `/quote` and `/classes` are reachable at `http://localhost:3000/quote` and `http://localhost:3000/classes`.

**Spec:** `docs/superpowers/specs/2026-04-19-quote-wizard-stepper-polish-design.md`

**Commit policy:** Per CLAUDE.md Rule 3 ("one commit per logical feature"), this entire change is a single commit at the end of Task 4, after all visual verifications pass.

---

## File Structure

| File | Responsibility | Change type |
|---|---|---|
| `client/src/index.css` | Stepper layout, rail, colors, animations, responsive sizing, reduced-motion guard | Modify |

No new files. No JSX changes.

**Touched CSS regions in `client/src/index.css`:**
- Lines 3518–3579: `.wz-steps` / `.wz-step-dot` / `.wz-step-num` / `.wz-step-label` / `.wz-step-connector` + `@keyframes wz-pulse` (rewrite)
- Lines 4719–4720: `.wz-steps { flex-wrap: wrap; }` and `.wz-step-label { display: inline; }` in the 768px media query (delete both — rail requires one row)
- Lines 4723–4727: `@media (max-width: 480px)` block (add stepper rules)
- Lines 5748–5754: `prefers-reduced-motion` block (widen selector list)

---

## Task 1: Restructure layout, add connecting rail, fix contrast

**Files:**
- Modify: `client/src/index.css:3518-3579` (the `.wz-steps` block and `@keyframes wz-pulse`)
- Modify: `client/src/index.css:4719-4720` (delete two lines inside the 768px media query)

- [ ] **Step 1.1: Replace the stepper CSS block (lines 3518–3579)**

Open `client/src/index.css`. Find the block that starts with `.wz-steps {` at roughly line 3518 and ends with the closing `}` of `@keyframes wz-pulse` at roughly line 3578. Replace the entire block with:

```css
.wz-steps {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  max-width: 600px;
  margin: 0 auto 2.5rem;
  position: relative;
}

.wz-step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  position: relative;
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
  color: rgba(107, 66, 38, 0.6);
  transition: color 0.3s;
}

.wz-step-dot:disabled { cursor: default; }
.wz-step-dot.active { color: var(--deep-brown); font-weight: 600; }
.wz-step-dot.done { color: var(--warm-brown); font-weight: 500; }

.wz-step-num {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid rgba(107, 66, 38, 0.4);
  background: transparent;
  color: rgba(107, 66, 38, 0.6);
  font-size: 0.8rem;
  font-weight: 600;
  transition: background 300ms ease, border-color 300ms ease, color 300ms ease;
}

.wz-step-dot.active .wz-step-num {
  background: var(--amber);
  color: #fff;
  border-color: var(--amber);
  animation: wz-step-enter 400ms ease-out, wz-active-glow 2.5s ease-in-out 400ms infinite;
}

.wz-step-dot.done .wz-step-num {
  background: var(--amber);
  color: #fff;
  border-color: var(--amber);
  animation: wz-check-pop 250ms ease-out;
}

.wz-step-label {
  display: block;
  text-align: center;
  max-width: 6rem;
  line-height: 1.2;
}

/* Connecting rail between dots */
.wz-step-dot:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 18px;
  left: calc(50% + 22px);
  right: calc(-50% + 22px);
  height: 2px;
  background-color: rgba(107, 66, 38, 0.2);
  background-image: linear-gradient(to right, var(--amber), var(--amber));
  background-size: 0% 100%;
  background-repeat: no-repeat;
  transition: background-size 500ms ease;
  z-index: 0;
}

.wz-step-dot.done:not(:last-child)::after {
  background-size: 100% 100%;
}

@keyframes wz-active-glow {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(193, 125, 60, 0.5);
  }
  50% {
    transform: scale(1.06);
    box-shadow: 0 0 0 10px rgba(193, 125, 60, 0);
  }
}

@keyframes wz-step-enter {
  0%   { transform: scale(0.85); }
  60%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}

@keyframes wz-check-pop {
  0%   { transform: scale(0.9); }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); }
}
```

Notes on what changed vs. the original block:
- `.wz-steps`: `gap: 0.25rem` replaced with `justify-content: space-between` + `max-width: 600px` + `margin: 0 auto 2.5rem` + `position: relative`.
- `.wz-step-dot`: becomes `flex-direction: column` (circle on top, label below); `flex: 1` distributes steps evenly; `color` uses readable rgba instead of `var(--parchment-dark)`; removes `border-radius` and `padding` since the dot is no longer a pill-shaped button.
- `.wz-step-num`: border and text colors use readable rgba; gains `position: relative; z-index: 1` so it sits above the rail.
- `.wz-step-dot.active .wz-step-num`: replaces the old `wz-pulse` with `wz-step-enter` (one-shot) + `wz-active-glow` (continuous, delayed 400ms to follow the enter).
- `.wz-step-dot.done .wz-step-num`: new `wz-check-pop` one-shot.
- `.wz-step-connector` class: **deleted** (was never used in JSX).
- Old `@keyframes wz-pulse`: **deleted** (replaced by `wz-active-glow`).
- Rail: new `::after` pseudo-element on every step except the last.

- [ ] **Step 1.2: Delete two lines from the 768px media query (lines 4719–4720)**

Open `client/src/index.css`. Inside the `@media (max-width: 768px)` block, find:

```css
  .wz-steps { flex-wrap: wrap; }
  .wz-step-label { display: inline; }
```

Delete both lines. The rail depends on all steps staying on one row, so wrapping and inline labels must not activate on small screens.

- [ ] **Step 1.3: Ensure dev server is running and verify in browser**

If `npm run dev` isn't already running, start it:

```bash
npm run dev
```

Navigate to `http://localhost:3000/quote`. Verify:

- Steps are laid out as columns (circle on top, label below), evenly spaced.
- A thin muted rail connects adjacent circles.
- Inactive dots (steps 3, 4, 5 when you're on step 1) are clearly visible — numbers readable, border visible, labels legible. Not washed-out.
- Current step circle is solid amber with white number; it scales in briefly then breathes (subtle continuous pulse).
- Advance one step. The rail segment you crossed fills amber left-to-right over ~500ms. The completed step shows a checkmark and briefly pops.
- Go back (click the "Back" button, or click a completed step in the stepper). Confirm the rail segment stays amber — the `.done` class is still applied.

Also verify at `http://localhost:3000/classes` — the ClassWizard should look identical.

---

## Task 2: Mobile sizing (≤480px)

**Files:**
- Modify: `client/src/index.css:4723-4727` (extend the existing `@media (max-width: 480px)` block)

- [ ] **Step 2.1: Add stepper rules inside the 480px media query**

Open `client/src/index.css`. Find the `@media (max-width: 480px)` block at approximately line 4723. It currently looks like:

```css
@media (max-width: 480px) {
  .ws-hero-btns { flex-direction: column; }
  .ws-hero-btns .btn { width: 100%; }
  .ws-contact-form { padding: 0 0.5rem; }
}
```

Add these rules before the closing brace:

```css
  .wz-step-num {
    width: 28px;
    height: 28px;
    font-size: 0.7rem;
  }
  .wz-step-dot:not(:last-child)::after {
    top: 14px;
    left: calc(50% + 18px);
    right: calc(-50% + 18px);
  }
  .wz-step-label {
    font-size: 0.7rem;
    max-width: 4.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
```

The resulting block is:

```css
@media (max-width: 480px) {
  .ws-hero-btns { flex-direction: column; }
  .ws-hero-btns .btn { width: 100%; }
  .ws-contact-form { padding: 0 0.5rem; }
  .wz-step-num {
    width: 28px;
    height: 28px;
    font-size: 0.7rem;
  }
  .wz-step-dot:not(:last-child)::after {
    top: 14px;
    left: calc(50% + 18px);
    right: calc(-50% + 18px);
  }
  .wz-step-label {
    font-size: 0.7rem;
    max-width: 4.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
```

Rationale:
- Shrinking to 28px keeps 5 circles comfortably on a 360px-wide phone.
- Rail `top: 14px` is the new half-circle height, so the rail still runs through the vertical center.
- Rail `left`/`right` offsets adjust from `22px` (36/2 + 4 padding) to `18px` (28/2 + 4 padding) so the rail meets each circle edge cleanly.
- Label truncation prevents "Event Details" and "Your Info" from pushing siblings off the row.

- [ ] **Step 2.2: Verify at mobile width**

With dev server running, open `http://localhost:3000/quote` and shrink the browser to 360px (Chrome DevTools device toolbar → set width to 360). Verify:

- All 5 steps stay on one row. No wrapping.
- Circles are smaller but still visible; rail still runs through their centers.
- Labels are truncated with ellipsis where necessary. No layout break.
- Advance through steps — rail fill still sweeps correctly at mobile width.

Also verify `/classes` at 360px width.

---

## Task 3: Reduced-motion guard

**Files:**
- Modify: `client/src/index.css:5748-5754` (widen the `prefers-reduced-motion` selector list)

- [ ] **Step 3.1: Update the reduced-motion selector list**

Open `client/src/index.css`. Find the block at approximately line 5748:

```css
  .potion-step,
  .wz-step-dot.active .wz-step-num,
  .ws-testimonial-card,
  .ws-service-image-card {
    animation: none !important;
    transition: none !important;
  }
```

Replace the `.wz-step-dot.active .wz-step-num` line so the full block reads:

```css
  .potion-step,
  .wz-step-dot .wz-step-num,
  .wz-step-dot.active .wz-step-num,
  .wz-step-dot.done .wz-step-num,
  .wz-step-dot:not(:last-child)::after,
  .ws-testimonial-card,
  .ws-service-image-card {
    animation: none !important;
    transition: none !important;
  }
```

This kills the enter/glow, check-pop, number-color transition, and rail-fill transition when the user prefers reduced motion. The stepper remains fully functional — just static.

- [ ] **Step 3.2: Verify reduced-motion behavior**

Enable reduced motion at the OS level:
- **Windows:** Settings → Accessibility → Visual effects → turn off "Animation effects".
- **macOS:** System Settings → Accessibility → Display → "Reduce motion".
- **DevTools alternative (Chrome):** Cmd/Ctrl+Shift+P → "Show Rendering" → "Emulate CSS media feature prefers-reduced-motion" → "reduce".

Reload `http://localhost:3000/quote`. Verify:

- No pulse on the active circle.
- No scale-in animation when advancing steps.
- Rail fill appears instantly (no 500ms sweep).
- Colors and layout are otherwise identical — the stepper still looks correct, just static.

Disable reduced motion and confirm animations resume.

---

## Task 4: Commit

- [ ] **Step 4.1: Stage only the CSS file**

Per CLAUDE.md Rule 7 (explicit staging only):

```bash
git add client/src/index.css
```

- [ ] **Step 4.2: Confirm nothing else sneaks into the commit**

```bash
git status
```

Expected: only `client/src/index.css` is staged. The spec + plan docs were already committed earlier and should not appear.

- [ ] **Step 4.3: Commit**

```bash
git commit -m "style(wizard): add connecting rail and animations to quote/class wizard stepper"
```

Expected: commit succeeds. No push — push is a separate user cue per CLAUDE.md Rule 4.
