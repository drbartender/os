# Quote Wizard Stepper — Polish + Animations

## Problem

The `wz-steps` progress bar at the top of `QuoteWizard` and `ClassWizard` has two user-reported issues:

1. **Poor contrast.** Inactive step dots use `--parchment-dark` (#D4C9A8) against a `--parchment` background (#E8DFC4) — only a single shade apart, so inactive dots and their labels nearly vanish.
2. **"Funky" layout + weak progression cue.** Steps render as a row of buttons with a tiny 0.25rem gap and no connecting rail between them, even though `.wz-step-connector` CSS is defined (but never rendered in the JSX). Labels sit inline beside each circle, which wraps awkwardly on narrow screens. The active step has a subtle box-shadow pulse that doesn't clearly communicate "you are here."

## Goal

Reshape the stepper into a classic numbered-dots-with-connecting-rail pattern, fix the contrast, and add animations that make the current step unmistakable.

## Scope

- `QuoteWizard.js` and `ClassWizard.js` use identical stepper markup — both benefit from the CSS-only change. **No JSX changes to either component.** All work is in `client/src/index.css`.
- The existing `.wz-step-connector` CSS rule is unused dead code — it will be removed.

## Design

### Layout

- `.wz-steps`: flex row, `justify-content: space-between`, `max-width: 600px`, horizontally centered with `margin: 0 auto 2.5rem`. `position: relative` so the rail can anchor off children.
- `.wz-step-dot`: becomes a vertical column (`flex-direction: column`) with circle on top and label below. `flex: 1` so each step takes equal horizontal space (which is what makes the rail math work). `position: relative` so its `::after` can draw the rail segment.
- Remove the current inline-label layout and the `flex-wrap: wrap` override in the 768px media query — the rail requires steps to stay on one row.

### Connecting rail

Drawn purely via CSS pseudo-elements — no JSX change.

- Every `.wz-step-dot` except the last gets an `::after`: absolutely positioned, `top` aligned to the vertical center of the circle (18px — half of 36px), `left: calc(50% + 22px)` (past the circle's right edge), `right: calc(-50% + 22px)` (to the next circle's left edge), `height: 2px`, sitting behind the circles (`z-index: 0`; circles use `z-index: 1`).
- Inactive rail color: `rgba(107, 66, 38, 0.2)` (warm-brown @ 20%).
- Done rail color: `var(--amber)`.
- Fill mechanism: see the "Rail fill" animation section below — uses a `background-size` transition, not a keyframe.

### Colors (contrast fix)

| Element | State | Color |
|---|---|---|
| Circle border | inactive | `rgba(107, 66, 38, 0.4)` |
| Circle number | inactive | `rgba(107, 66, 38, 0.6)` |
| Step label | inactive | `rgba(107, 66, 38, 0.6)` |
| Circle border / bg | active, done | `var(--amber)` (unchanged) |
| Circle number / check | active, done | `#fff` (unchanged) |
| Step label | active | `var(--deep-brown)`, `font-weight: 600` |
| Step label | done | `var(--warm-brown)`, `font-weight: 500` |

Rationale for rgba over a named variable: we want translucent warm-brown that picks up the parchment tone beneath, not a separately-defined opaque color. Inline rgba is clearer than defining `--warm-brown-muted`, `--warm-brown-softer`, etc., just for this component.

### Animations

All animations respect `prefers-reduced-motion`. The existing `@media (prefers-reduced-motion: reduce)` block already disables `.wz-step-dot.active .wz-step-num`; we extend it to cover the new animations.

#### Continuous: active-step pulse

```css
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
```

Applied to `.wz-step-dot.active .wz-step-num` at `2.5s ease-in-out infinite`. Replaces the current `wz-pulse` animation, which stays put and only pulses the shadow. The new version scales gently so the circle visibly "breathes" — unmistakable as the current step.

#### One-shot: step-enter

```css
@keyframes wz-step-enter {
  0%   { transform: scale(0.85); }
  60%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}
```

Fires once when a step becomes active (`.wz-step-dot.active .wz-step-num` has both this animation and the continuous one — CSS runs them in sequence by stacking: `animation: wz-step-enter 400ms ease-out, wz-active-glow 2.5s ease-in-out 400ms infinite`).

The `400ms` delay on the continuous one keeps it from overlapping the enter animation.

#### One-shot: rail fill

Rail uses `background-color: rgba(107, 66, 38, 0.2)` (the inactive tone) plus `background-image: linear-gradient(to right, var(--amber), var(--amber))` with `background-size: 0% 100%` and `background-repeat: no-repeat`. When the step becomes `.done`, the `::after` switches to `background-size: 100% 100%` with a 500ms `transition: background-size`, sweeping the gradient left-to-right over the base color. A CSS `transition` (not `@keyframes`) is the right fit here because `.done` is applied exactly once per step, and `transition` runs automatically on state change.

#### One-shot: checkmark reveal

The checkmark appears because React swaps the span's text content from `1` to `✓`. CSS can't animate a content swap directly, so we attach an animation to `.wz-step-dot.done .wz-step-num` that briefly scales and fades the whole circle (`wz-check-pop`, 250ms). The user perceives this as the checkmark "arriving":

```css
@keyframes wz-check-pop {
  0%   { transform: scale(0.9); }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); }
}
```

### Mobile (≤480px)

- Keep column-per-step layout (do not wrap).
- Circle shrinks to 28px (from 36px). Adjust rail `top` to 14px, `left/right` offsets to `calc(50% + 18px)` / `calc(-50% + 18px)`.
- Step label: `font-size: 0.7rem`, `text-align: center`, `max-width: 4.5rem`, `overflow: hidden`, `text-overflow: ellipsis` — keeps long labels ("Event Details") from pushing siblings off the row.
- Remove the existing 768px `flex-wrap: wrap` override on `.wz-steps` — the rail requires one row.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  .wz-step-dot .wz-step-num,
  .wz-step-dot.active .wz-step-num,
  .wz-step-dot.done .wz-step-num,
  .wz-step-dot:not(:last-child)::after {
    animation: none !important;
    transition: none !important;
  }
}
```

This replaces the existing narrower rule, which only covers `.wz-step-dot.active .wz-step-num`.

## Out of scope

- No changes to step logic, navigation, keyboard behavior, or ARIA semantics.
- No refactor to share a `<Stepper />` component between QuoteWizard and ClassWizard — they already share the CSS, which is enough for now. A component extraction can happen later if a third consumer appears.
- The review-agents list (code-review, etc.) is not affected — these are pure CSS changes to an existing component.

## Verification

1. Dev server running. Navigate to `/quote` (QuoteWizard) and `/classes` (ClassWizard).
2. Confirm inactive steps are clearly visible against the parchment background — step labels and numbers must be readable, not washed out.
3. Advance through steps. Confirm: (a) the rail fills amber left-to-right, (b) the newly-active circle has an enter animation (brief scale), (c) the active circle continues to pulse/breathe subtly, (d) completed steps show the checkmark.
4. Resize to ≤480px. Confirm stepper stays on one row; labels truncate rather than wrap.
5. Enable "reduce motion" in OS settings. Reload. Confirm no animations run — static styling only.
6. Keyboard nav: Tab through the step buttons, confirm focus outline still visible.
