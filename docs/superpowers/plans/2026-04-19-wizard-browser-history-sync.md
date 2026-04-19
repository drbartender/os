# Wizard Browser History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser back/forward buttons (and mouse side buttons) navigate between wizard steps in QuoteWizard and ClassWizard, instead of leaving the page.

**Architecture:** Introduce a shared `useWizardHistory(step, setStep)` hook that syncs a numeric step index with `window.history` via `replaceState` / `pushState` / `popstate`. Consumers call it once and existing `setStep` call sites work unchanged. No URL changes.

**Tech Stack:** React 18 hooks, raw `window.history` API (not `react-router-dom`). Matches the existing pattern in `PotionPlanningLab.js`.

**Spec:** `docs/superpowers/specs/2026-04-19-wizard-browser-history-sync-design.md`

**Testing note:** The client has no test files or test infra in use. Verification is manual via `npm run dev` plus a browser with mouse side buttons. Do not introduce Jest / React Testing Library patterns — they're not used in this codebase.

**Commit strategy:** One commit per CLAUDE.md rule 3 — this is one logical feature (new hook + two call sites + docs). All tasks land in a single commit at the end.

---

## Task 1: Create the useWizardHistory hook

**Files:**
- Create: `client/src/hooks/useWizardHistory.js`

- [ ] **Step 1: Create the hook file**

Create `client/src/hooks/useWizardHistory.js` with exactly this content:

```js
import { useEffect } from 'react';

export default function useWizardHistory(step, setStep) {
  useEffect(() => {
    window.history.replaceState({ wizardStep: step }, '', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (window.history.state?.wizardStep !== step) {
      window.history.pushState({ wizardStep: step }, '', '');
    }
  }, [step]);

  useEffect(() => {
    const handler = (e) => {
      if (typeof e.state?.wizardStep === 'number') {
        setStep(e.state.wizardStep);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [setStep]);
}
```

Notes on the code:
- Mount effect uses `replaceState` so we don't add an entry on mount — we just tag the current entry with the wizard's starting step.
- Step-change effect's `!==` guard prevents double-pushing when `setStep` was itself called by the popstate handler (the popped entry's state already matches the new step, so we skip the push).
- Popstate handler only reacts if `e.state?.wizardStep` is a number. If not, we let the browser navigate naturally (e.g., back past step 0 leaves the wizard).
- No JSDoc comments — matches the style of `useDebounce.js` and `useFormValidation.js` in the same folder.

- [ ] **Step 2: Verify it builds**

Run:
```bash
cd client && npx eslint src/hooks/useWizardHistory.js
```

Expected: no errors. (The `// eslint-disable-next-line react-hooks/exhaustive-deps` comment is intentional — we only want the mount effect to run on first render, not when `step` changes.)

---

## Task 2: Wire the hook into QuoteWizard

**Files:**
- Modify: `client/src/pages/website/QuoteWizard.js`

- [ ] **Step 1: Add the import**

In `client/src/pages/website/QuoteWizard.js`, add the import alongside the other hook imports. Find this block near the top:

```js
import useFormValidation from '../../hooks/useFormValidation';
```

Add directly after it:

```js
import useWizardHistory from '../../hooks/useWizardHistory';
```

- [ ] **Step 2: Call the hook**

Find the existing step state declaration (around line 65):

```js
  const [step, setStep] = useState(0);
```

Immediately below that line, add:

```js
  useWizardHistory(step, setStep);
```

Placement rationale: the hook call must come after the `step`/`setStep` declaration. Putting it directly below keeps the history-sync intent visually adjacent to the state it syncs.

- [ ] **Step 3: Verify the file builds**

Run:
```bash
cd client && npx eslint src/pages/website/QuoteWizard.js
```

Expected: no new errors. Pre-existing warnings (if any) are fine.

---

## Task 3: Wire the hook into ClassWizard

**Files:**
- Modify: `client/src/pages/website/ClassWizard.js`

- [ ] **Step 1: Add the import**

In `client/src/pages/website/ClassWizard.js`, find the existing imports block at the top. After the existing imports (the last one is `import { useToast } from '../../context/ToastContext';`), add:

```js
import useWizardHistory from '../../hooks/useWizardHistory';
```

- [ ] **Step 2: Call the hook**

Find the existing step state declaration (around line 34):

```js
  const [step, setStep] = useState(0);
```

Immediately below that line, add:

```js
  useWizardHistory(step, setStep);
```

- [ ] **Step 3: Verify the file builds**

Run:
```bash
cd client && npx eslint src/pages/website/ClassWizard.js
```

Expected: no new errors.

---

## Task 4: Update folder-tree documentation

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `.claude/CLAUDE.md` folder tree**

In `.claude/CLAUDE.md`, find the hooks section (around line 128):

```
│   │   ├── hooks/
│   │   │   └── useFormValidation.js # Form validation hook
```

Replace it with:

```
│   │   ├── hooks/
│   │   │   ├── useDebounce.js     # Debounced callback helper
│   │   │   ├── useFormValidation.js # Form validation hook
│   │   │   └── useWizardHistory.js # Wizard step ↔ browser history sync
```

Rationale: `useDebounce.js` was already in the repo but missing from CLAUDE.md (pre-existing doc drift). Adding it alongside the new hook fixes that drift in the same pass.

- [ ] **Step 2: Update `README.md` folder tree**

In `README.md`, find line 167:

```
│   │   ├── hooks/              # Custom hooks (useFormValidation)
```

Replace with:

```
│   │   ├── hooks/              # Custom hooks (useDebounce, useFormValidation, useWizardHistory)
```

---

## Task 5: Manual QA

**Files:** none (testing only)

- [ ] **Step 1: Start the dev server**

Run:
```bash
npm run dev
```

Wait until Express reports `listening on 5000` and React reports `compiled successfully` (on :3000).

- [ ] **Step 2: QuoteWizard — forward / back walk**

1. Navigate to `http://localhost:3000/quote`.
2. Fill step 1 (Event Details) and click Next. URL should still read `/quote`.
3. Fill step 2 (Your Info — Name + Email) and click Next.
4. Press the browser Back button. Expected: wizard shows step 2 (Your Info), form data preserved.
5. Press browser Back again. Expected: wizard shows step 1 (Event Details).
6. Press browser Back again. Expected: browser leaves `/quote` and goes to the prior page (homepage or wherever you came from).
7. Press browser Forward. Expected: browser returns to `/quote` showing step 1.
8. Press Forward again. Expected: step 2.

- [ ] **Step 3: QuoteWizard — mouse side buttons**

If your mouse has physical back/forward side buttons, repeat the walk from Step 2 using those buttons instead. They fire `popstate` natively and should behave identically.

- [ ] **Step 4: QuoteWizard — package step sub-state**

1. Start a fresh `/quote` visit. Fill step 1 with `alcohol_provider = hosted`, proceed through contact, reach the Package step.
2. Click "Full bar with cocktails" — the UI should show the package list.
3. Press the browser Back button. Expected: wizard jumps directly to the previous step (Your Info or Event Details depending on flow). Note: it does NOT clear `bar_type` first — that's an in-app "Back" button behavior only. Confirm this matches the spec's accepted edge case.

- [ ] **Step 5: QuoteWizard — step-dot direct jump**

1. Walk forward to step 3 or later.
2. Click a step dot for an earlier step (e.g., step 0).
3. Press browser Back. Expected: wizard goes to step 3 (walks history stack, does not reverse the dot jump). Acceptable per spec.

- [ ] **Step 6: ClassWizard — forward / back walk**

1. Navigate to `http://localhost:3000/classes`.
2. Click Next through the 4 steps (Choose Class → Details → Equipment → Your Info).
3. Press browser Back at each stage. Expected: each press decrements the step by 1. After reaching step 0, one more Back leaves `/classes`.
4. Press browser Forward to walk back up. Expected: each press increments by 1, preserving form state.

- [ ] **Step 7: Confirm no console errors**

Open the browser DevTools console during the walks above. Expected: no errors or warnings related to `useWizardHistory`, `popstate`, or `history.state`.

---

## Task 6: Commit

**Files:** all of the above

- [ ] **Step 1: Stage the exact paths**

Per CLAUDE.md rule 7 (explicit staging only):

```bash
git add client/src/hooks/useWizardHistory.js client/src/pages/website/QuoteWizard.js client/src/pages/website/ClassWizard.js .claude/CLAUDE.md README.md
```

- [ ] **Step 2: Verify the diff**

Run:
```bash
git diff --cached --stat
```

Expected: exactly 5 files changed — 1 new file (hook), 2 wizards modified (~2 lines each), 2 docs updated (~2-4 lines each).

- [ ] **Step 3: Commit**

Per CLAUDE.md rule 4 (plain `-m`, no heredoc, no co-author footer — keeps permission prompts at zero):

```bash
git commit -m "feat(wizards): sync browser back/forward with wizard steps"
```

- [ ] **Step 4: Stop and wait for push cue**

Per CLAUDE.md rule 4: commit cues do NOT authorize a push. Do not push. Report the commit and wait for an explicit push cue from the user.

---

## Self-Review Checklist

Before handoff, verified against the spec:

- **Spec coverage**: ✓ Hook created per spec §Design. ✓ Both wizards wired per spec §Call sites. ✓ Edge cases called out in Task 5 manual QA match spec §Edge Cases. ✓ PotionPlanningLab untouched per spec §Non-Goals.
- **No placeholders**: every step has exact paths, exact code, exact commands.
- **Type consistency**: hook signature `useWizardHistory(step, setStep)` used identically in both call sites.
- **Docs**: CLAUDE.md and README.md folder trees updated per CLAUDE.md §Mandatory Documentation Updates. ARCHITECTURE.md has no hooks section — no update needed.
