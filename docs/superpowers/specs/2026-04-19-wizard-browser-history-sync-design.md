# Wizard Browser History Sync — Design

**Date**: 2026-04-19
**Scope**: `QuoteWizard`, `ClassWizard`

## Problem

Clicking the browser back/forward buttons (or the physical side buttons on a mouse) inside the QuoteWizard or ClassWizard leaves the page entirely, losing the user's current step. These are multi-step flows where the natural expectation is that back/forward navigate between steps — the header nav already provides "escape hatch" links for users who want to leave mid-stream.

`PotionPlanningLab` already solves this problem for its own flow using `window.history.pushState` + `popstate`. The two website wizards don't.

## Goal

Browser and mouse back/forward buttons navigate between wizard steps in `QuoteWizard` and `ClassWizard`. Users exit via the header nav, not via back-past-the-first-step.

## Non-Goals

- No URL changes (no `?step=N` query param). Step state rides entirely on `history.state` to avoid clashing with the existing `?resume=TOKEN` param on QuoteWizard.
- No changes to `PotionPlanningLab`. It has a working implementation with different semantics (string step keys, trap-user-in-wizard behavior) — leave alone.
- No attempt to map QuoteWizard's package-step sub-state (`bar_type` picker → package list) onto a distinct history entry. The in-app "Back" button still handles that two-click flow.

## Design

### New file: `client/src/hooks/useWizardHistory.js`

A shared hook that syncs a numeric wizard step with the browser's session history.

**Signature**

```js
useWizardHistory(step, setStep)
```

- `step` (number): current step index
- `setStep` (function): the raw state setter — `useState`'s second value

**Behavior**

1. **On mount** — anchor the wizard's current step at the current history entry:
   ```js
   window.history.replaceState({ wizardStep: step }, '', '');
   ```
   Uses `replaceState` so we don't add a history entry on mount. The wizard's first in-history step lives on whatever page entry the user was on when they navigated in.

2. **On step change** — push a new history entry when the step differs from `history.state.wizardStep`:
   ```js
   if (window.history.state?.wizardStep !== step) {
     window.history.pushState({ wizardStep: step }, '', '');
   }
   ```
   The `!==` guard prevents double-pushing when the popstate handler itself calls `setStep`.

3. **On popstate** — if the incoming state has a `wizardStep` number, sync component state and scroll to top:
   ```js
   const handler = (e) => {
     if (typeof e.state?.wizardStep === 'number') {
       setStep(e.state.wizardStep);
       window.scrollTo({ top: 0, behavior: 'smooth' });
     }
     // else: user is navigating to pre-wizard history — let browser handle it
   };
   window.addEventListener('popstate', handler);
   ```

### Call sites

**`client/src/pages/website/QuoteWizard.js`** — add one line near the other hook calls:
```js
useWizardHistory(step, setStep);
```

**`client/src/pages/website/ClassWizard.js`** — same.

No other changes needed. Existing `setStep(...)` call sites (Next button, step-dot clicks, review-section Edit buttons, `editAnswers`, `tryAdvance`) all trigger the step-change effect automatically.

## Edge Cases

### Resume from step N (QuoteWizard only)

When a user resumes a draft (`?resume=TOKEN` or localStorage), the flow is:
1. Component mounts with `step = 0`.
2. Hook runs its mount effect: `replaceState({ wizardStep: 0 })`.
3. Resume effect completes, calls `setStep(N)`.
4. Hook's step-change effect runs: `pushState({ wizardStep: N })`.

Result: history is `[wizardStep: 0 (replaced)] → [wizardStep: N (pushed)]`. Back from step N jumps directly to step 0.

**Accepted**: the user didn't linearly visit steps 1…N-1 on resume, so there's nothing meaningful to step back through. The step-dots UI already gives direct access to any previous step.

### Package-step sub-state (QuoteWizard only)

The package step has an inner mini-flow:
- No `bar_type` yet → show bar type picker (Full Bar vs Beer & Wine)
- `bar_type` set → show package list, with a "Change bar type" button

The in-app "Back" button clears `bar_type` first (staying on the same step), then on the second click moves to the previous step. Browser back will skip the bar-type sub-state and go directly to the previous step.

**Accepted**: mapping two intra-step sub-states onto `history.state` adds complexity (tagged state shape, extra push on bar_type set/clear) for marginal UX. The "Back" button covers the two-click case; browser back does the fast-path.

### Step 0 behavior

Browser back on step 0 leaves the wizard naturally (no trap). The header nav links are always available for mid-stream exits at any step. This matches the user's stated intent: "there are links to the other elements if they want to leave the quote wizard mid stream."

### Mouse side buttons

Physical back/forward buttons on a mouse fire `popstate` identically to browser UI back/forward. Covered by the same handler — no separate code path.

## Testing

Manual verification against each wizard:
1. Navigate through all steps with Next. Press browser back repeatedly — each press goes to the previous step, not off-page, until step 0 (at which point back leaves the wizard).
2. After going back, press browser forward — each press goes to the next step (already-visited path is preserved).
3. Test mouse side buttons on a mouse that has them.
4. (QuoteWizard) Resume a draft at step 3 via `?resume=TOKEN`. Browser back should jump directly to step 0, then browser back from there leaves the wizard.
5. (QuoteWizard) On the package step, select a bar type then press browser back — should go to the previous step (not clear bar_type).
6. Refresh the page mid-wizard — draft state resumes; history is re-anchored correctly.

## Consistency Check

- **Cross-file consistency**: hook applied to both website wizards. `PotionPlanningLab` keeps its own implementation.
- **Docs updates needed**: `CLAUDE.md` + `README.md` folder-tree entries under `client/src/hooks/` (new file). `ARCHITECTURE.md` — no section specifically covers hooks; no update needed.

## Risks

- **Double-push guard**: if `useWizardHistory`'s step-change effect runs after a popstate-triggered `setStep`, the `state?.wizardStep !== step` guard prevents duplicate entries. Validated by reading: popstate handler calls `setStep(prevStep)`, which re-runs the effect with `state.wizardStep === prevStep` (the state we popped to), so the push is skipped.
- **Interaction with page-unload save (QuoteWizard)**: the `beforeunload` save is independent of history navigation. Back/forward within the wizard doesn't trigger `beforeunload`. No interaction.
