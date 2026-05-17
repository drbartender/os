# Drink Plan: Post-Booking Only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the pre-booking Exploration phase of the Potion Planning Lab so the drink plan exists only after a client books (deposit paid); collapse the two-phase wizard into one linear post-booking flow.

**Architecture:** Mostly deletion of code that becomes provably unreachable once no pre-deposit token is created, plus one new tested behavior: the public drink-plan token route returns a "locked" payload for pre-deposit proposals (safety net for `/plan/:token` links already sitting in inboxes), and the client renders a minimal lock screen instead of the wizard. The post-deposit creation path (`createDrinkPlan` via the Stripe webhook) is untouched. No schema migration.

**Tech Stack:** Node/Express (raw `pg`), React (CRA), `node:test` for server unit tests (the established pattern — `server/utils/*.test.js`). There is no route/integration test harness; the testable core is extracted as a pure helper.

**Spec:** `docs/superpowers/specs/2026-05-17-drink-plan-post-booking-only-design.md`

---

## File Structure

**Create:**
- `server/utils/drinkPlanAccess.js` — pure helper: is a drink plan pre-booking (locked)?
- `server/utils/drinkPlanAccess.test.js` — node:test unit tests for the helper.

**Modify (server):**
- `server/routes/drinkPlans.js` — GET `/t/:token` returns locked payload pre-booking (+ select `p.token`); remove `exploration_saved` handling in PUT `/t/:token` and PATCH `/:id/status`.
- `server/routes/proposals/crud.js` — remove the pre-deposit `createDrinkPlan` + `planUrl` block; pass `planUrl: null`; drop now-unused import.

**Modify (client):**
- `client/src/pages/plan/data/servingTypes.js` — remove exploration exports + `derivePhase`.
- `client/src/pages/plan/steps/RefinementWelcomeStep.js` — strip exploration recap; becomes the sole entry screen.
- `client/src/pages/plan/PotionPlanningLab.js` — collapse phase machinery, consolidate the welcome step id, add the lock screen, retain legacy seeding shim.

**Delete (client):**
- `client/src/pages/plan/steps/VibeStep.js`
- `client/src/pages/plan/steps/FlavorDirectionStep.js`
- `client/src/pages/plan/steps/ExplorationBrowseStep.js`
- `client/src/pages/plan/steps/MocktailInterestStep.js`
- `client/src/pages/plan/steps/ExplorationSaveStep.js`
- `client/src/pages/plan/steps/WelcomeStep.js`

**Docs:** `ARCHITECTURE.md`, `CLIENT_FACING_SURFACES.md`, `README.md`, redesign-brief note.

---

### Task 1: Pure helper `isDrinkPlanPreBooking` (TDD)

**Files:**
- Create: `server/utils/drinkPlanAccess.js`
- Test: `server/utils/drinkPlanAccess.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/drinkPlanAccess.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDrinkPlanPreBooking } = require('./drinkPlanAccess');

test('post-booking statuses are NOT pre-booking (plan accessible)', () => {
  for (const s of ['deposit_paid', 'balance_paid', 'confirmed', 'completed']) {
    assert.equal(isDrinkPlanPreBooking(s), false, `${s} should be accessible`);
  }
});

test('pre-deposit statuses ARE pre-booking (plan locked)', () => {
  for (const s of ['sent', 'viewed', 'modified', 'accepted']) {
    assert.equal(isDrinkPlanPreBooking(s), true, `${s} should be locked`);
  }
});

test('fails safe: null/undefined/unknown statuses are locked', () => {
  assert.equal(isDrinkPlanPreBooking(null), true);
  assert.equal(isDrinkPlanPreBooking(undefined), true);
  assert.equal(isDrinkPlanPreBooking(''), true);
  assert.equal(isDrinkPlanPreBooking('cancelled'), true);
  assert.equal(isDrinkPlanPreBooking('totally_unknown'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/drinkPlanAccess.test.js`
Expected: FAIL — `Cannot find module './drinkPlanAccess'`.

- [ ] **Step 3: Write the helper**

Create `server/utils/drinkPlanAccess.js`:

```js
// A drink plan is "post-booking" only once the linked proposal has reached a
// deposit-paid (or later) state. Anything else — pre-deposit, missing, or an
// unknown/typo status — is treated as pre-booking and LOCKED. Fail-safe
// allowlist: we never expose the wizard (which can run a Stripe charge in
// ConfirmationStep) without a confirmed booking.
const POST_BOOKING_PROPOSAL_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

function isDrinkPlanPreBooking(proposalStatus) {
  return !POST_BOOKING_PROPOSAL_STATUSES.includes(proposalStatus);
}

module.exports = { isDrinkPlanPreBooking, POST_BOOKING_PROPOSAL_STATUSES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/drinkPlanAccess.test.js`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/drinkPlanAccess.js server/utils/drinkPlanAccess.test.js
git commit -m "feat(drink-plan): isDrinkPlanPreBooking helper — post-booking allowlist, fails safe"
```

---

### Task 2: Lock the public token route pre-booking

**Files:**
- Modify: `server/routes/drinkPlans.js:54-80` (GET `/t/:token`)

- [ ] **Step 1: Import the helper**

At the top of `server/routes/drinkPlans.js`, near the other `require('../utils/...')` lines (e.g. after line 7 `const { refreshUnlockedInvoices } = require('../utils/invoiceHelpers');`), add:

```js
const { isDrinkPlanPreBooking } = require('../utils/drinkPlanAccess');
```

- [ ] **Step 2: Select the proposal token + return a locked payload**

Replace the GET handler body (lines 54-80) with this (the only changes: add `p.token AS proposal_token` to the SELECT, and the locked-state branch before `res.json`):

```js
/** GET /api/drink-plans/t/:token — fetch plan by token (public) */
router.get('/t/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.client_name, dp.client_email, dp.event_type, dp.event_type_custom, dp.event_date,
            dp.status, dp.serving_type, dp.selections, dp.submitted_at, dp.created_at,
            dp.proposal_id, dp.exploration_submitted_at,
            p.guest_count, p.num_bartenders, p.num_bars, p.pricing_snapshot,
            p.status AS proposal_status,
            p.token  AS proposal_token,
            p.total_price AS proposal_total_price,
            p.amount_paid AS proposal_amount_paid,
            p.event_date AS proposal_event_date,
            p.balance_due_date AS proposal_balance_due_date,
            sp.bar_type            AS package_bar_type,
            sp.category            AS package_category,
            sp.slug                AS package_slug,
            sp.name                AS package_name,
            sp.includes            AS package_includes,
            sp.covered_addon_slugs AS package_covered_addon_slugs
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     LEFT JOIN service_packages sp ON sp.id = p.package_id
     WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');

  // The drink plan only opens after the client books (deposit paid). Outstanding
  // proposal-sent emails may still carry a /plan/:token link for a pre-deposit
  // proposal — never drop an unbooked client into the wizard (it can run a
  // Stripe charge in ConfirmationStep). Return a locked payload instead.
  const row = result.rows[0];
  if (isDrinkPlanPreBooking(row.proposal_status)) {
    return res.json({ locked: true, proposalToken: row.proposal_token });
  }

  res.json(row);
}));
```

- [ ] **Step 3: Sanity-check the route loads (no test harness for routes)**

Run: `npm run lint`
Expected: PASS (no eslint errors in `drinkPlans.js`).

Run: `node -e "require('./server/routes/drinkPlans.js'); console.log('route module loads OK')"`
Expected: prints `route module loads OK` (no throw).

- [ ] **Step 4: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "feat(drink-plan): GET /t/:token returns locked payload for pre-deposit proposals"
```

---

### Task 3: Remove `exploration_saved` server handling

**Files:**
- Modify: `server/routes/drinkPlans.js` (PUT `/t/:token` ~97-104, fast-path comment ~386, PATCH `/:id/status` ~666)

- [ ] **Step 1: Drop the `exploration_saved` status arm in PUT**

In `server/routes/drinkPlans.js`, replace lines 97-104:

```js
  const newStatus = status === 'submitted' ? 'submitted'
                  : status === 'exploration_saved' ? 'exploration_saved'
                  : 'draft';

  // Compute timestamps in JS to avoid PostgreSQL "inconsistent types" error
  // when reusing the same parameter ($3) in both SET and CASE WHEN contexts
  const submittedNow = newStatus === 'submitted' ? new Date() : null;
  const explorationNow = newStatus === 'exploration_saved' ? new Date() : null;
```

with:

```js
  const newStatus = status === 'submitted' ? 'submitted' : 'draft';

  // Compute timestamps in JS to avoid PostgreSQL "inconsistent types" error
  // when reusing the same parameter ($3) in both SET and CASE WHEN contexts
  const submittedNow = newStatus === 'submitted' ? new Date() : null;
  // Legacy: the Exploration phase was removed 2026-05-17. The
  // exploration_submitted_at column + its $-param are kept inert (always null)
  // so the financial UPDATE's parameter numbering stays untouched.
  const explorationNow = null;
```

- [ ] **Step 2: De-reference `exploration_saved` in the fast-path comment**

In the same file at ~line 386, replace the comment:

```js
  // Fast path: drafts, exploration_saved, or submit-without-addons. No
  // financial side effects, so we can use a single auto-committed UPDATE.
```

with:

```js
  // Fast path: drafts or submit-without-addons. No financial side effects, so
  // we can use a single auto-committed UPDATE.
```

(Do NOT change the `UPDATE drink_plans SET ... exploration_submitted_at = COALESCE($5, exploration_submitted_at) ...` query or its params — `explorationNow` is now always null, a harmless no-op COALESCE. Renumbering params in this financial write is out of scope.)

- [ ] **Step 3: Remove `exploration_saved` from the admin status allowlist**

At ~line 666, replace:

```js
  if (!['pending', 'draft', 'exploration_saved', 'submitted', 'reviewed'].includes(status)) {
```

with:

```js
  if (!['pending', 'draft', 'submitted', 'reviewed'].includes(status)) {
```

- [ ] **Step 4: Lint + load check**

Run: `npm run lint`
Expected: PASS.
Run: `node -e "require('./server/routes/drinkPlans.js'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "refactor(drink-plan): drop exploration_saved status handling (PUT + admin PATCH)"
```

---

### Task 4: Stop creating the drink plan / sending the link pre-deposit

**Files:**
- Modify: `server/routes/proposals/crud.js:491-524`

- [ ] **Step 1: Remove the pre-deposit creation + planUrl block**

In `server/routes/proposals/crud.js`, replace lines 491-523:

```js
        // Create drink plan and include link in email
        let planUrl = null;
        try {
          const drinkPlan = await createDrinkPlan(req.params.id, {
            client_name: p.client_name,
            client_email: p.client_email,
            event_type: p.event_type,
            event_type_custom: p.event_type_custom,
            event_date: p.event_date,
            created_by: p.created_by,
          }, { skipEmail: true });

          if (drinkPlan?.token) {
            planUrl = `${PUBLIC_SITE_URL}/plan/${drinkPlan.token}`;
          } else {
            // Already exists — look up existing token
            const existingPlan = await pool.query(
              'SELECT token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
              [req.params.id]
            );
            if (existingPlan.rows[0]?.token) {
              planUrl = `${PUBLIC_SITE_URL}/plan/${existingPlan.rows[0].token}`;
            }
          }
        } catch (planErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(planErr, { tags: { route: 'proposals/status', issue: 'drink-plan-creation' } });
          }
          console.error('Drink plan creation failed (non-blocking):', planErr);
        }

        const tpl = emailTemplates.proposalSent({ clientName: p.client_name, eventTypeLabel, proposalUrl, planUrl });
```

with:

```js
        // The drink plan is created only after the client books (deposit paid),
        // via the Stripe webhook → createEventShifts → createDrinkPlan. No
        // pre-deposit plan or link. proposalSent() omits the drink-plan CTA
        // when planUrl is null.
        const tpl = emailTemplates.proposalSent({ clientName: p.client_name, eventTypeLabel, proposalUrl, planUrl: null });
```

- [ ] **Step 2: Drop the now-unused `createDrinkPlan` import if unused**

Run: `grep -n "createDrinkPlan" server/routes/proposals/crud.js`
- If the only remaining reference is the destructured import on line 6, edit line 6:

  from:
  ```js
  const { createEventShifts, createDrinkPlan, syncShiftsFromProposal } = require('../../utils/eventCreation');
  ```
  to:
  ```js
  const { createEventShifts, syncShiftsFromProposal } = require('../../utils/eventCreation');
  ```
- If `createDrinkPlan` is still referenced elsewhere in the file, leave line 6 unchanged.

- [ ] **Step 3: Lint (catches unused-var regressions — server lint is enforced)**

Run: `npm run lint`
Expected: PASS, no `no-unused-vars` for `createDrinkPlan`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/proposals/crud.js
git commit -m "feat(proposals): no pre-deposit drink plan or planUrl — post-booking only"
```

---

### Task 5: Delete the six exploration-only step files

**Files:**
- Delete: `client/src/pages/plan/steps/{VibeStep,FlavorDirectionStep,ExplorationBrowseStep,MocktailInterestStep,ExplorationSaveStep,WelcomeStep}.js`

- [ ] **Step 1: Confirm no consumer outside `PotionPlanningLab.js`**

Run:
```bash
grep -rn "VibeStep\|FlavorDirectionStep\|ExplorationBrowseStep\|MocktailInterestStep\|ExplorationSaveStep\|steps/WelcomeStep\|from './WelcomeStep'\|WelcomeStep'" client/src --include=*.js | grep -v "PotionPlanningLab.js"
```
Expected: no output (only `PotionPlanningLab.js` references them; it is rewired in Task 8).

- [ ] **Step 2: Delete the files**

```bash
git rm client/src/pages/plan/steps/VibeStep.js \
       client/src/pages/plan/steps/FlavorDirectionStep.js \
       client/src/pages/plan/steps/ExplorationBrowseStep.js \
       client/src/pages/plan/steps/MocktailInterestStep.js \
       client/src/pages/plan/steps/ExplorationSaveStep.js \
       client/src/pages/plan/steps/WelcomeStep.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(plan): delete exploration step files + dual WelcomeStep"
```

(The client build is intentionally broken between here and Task 8 — `PotionPlanningLab.js` still imports these. Tasks 5-8 are one logical unit; the build is verified green at the end of Task 8. Do not push mid-unit.)

---

### Task 6: Remove exploration exports from `servingTypes.js`

**Files:**
- Modify: `client/src/pages/plan/data/servingTypes.js` (~63-73, ~130-137)

- [ ] **Step 1: Delete `EXPLORATION_STEPS` + `buildExplorationQueue`**

Remove the `EXPLORATION_STEPS` array (~lines 63-68) and the `buildExplorationQueue` function (~lines 71-73):

```js
export const EXPLORATION_STEPS = [
  // ... (whatever entries are present)
];

export function buildExplorationQueue() {
  return [...EXPLORATION_STEPS];
}
```

- [ ] **Step 2: Delete `EXPLORATION_STATUSES`, `REFINEMENT_STATUSES` (if unused), and `derivePhase`**

Remove (~lines 130-137):

```js
const EXPLORATION_STATUSES = ['sent', 'viewed', 'modified', 'accepted'];
const REFINEMENT_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

export function derivePhase(proposalStatus) {
  if (!proposalStatus || EXPLORATION_STATUSES.includes(proposalStatus)) return 'exploration';
  if (REFINEMENT_STATUSES.includes(proposalStatus)) return 'refinement';
  return 'exploration';
}
```

- [ ] **Step 3: Verify no other consumer of the removed exports**

Run:
```bash
grep -rn "buildExplorationQueue\|EXPLORATION_STEPS\|derivePhase\|EXPLORATION_STATUSES\|REFINEMENT_STATUSES" client/src --include=*.js
```
Expected: only matches inside `PotionPlanningLab.js` (rewired in Task 8). If `REFINEMENT_STATUSES` is referenced anywhere else, keep that one constant; otherwise it is removed with the block above.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/plan/data/servingTypes.js
git commit -m "refactor(plan): remove exploration queue + derivePhase from servingTypes"
```

---

### Task 7: Strip exploration recap from `RefinementWelcomeStep.js`

**Files:**
- Modify: `client/src/pages/plan/steps/RefinementWelcomeStep.js`

- [ ] **Step 1: Replace the file with the exploration-free version**

Replace the entire contents of `client/src/pages/plan/steps/RefinementWelcomeStep.js` with:

```jsx
import React from 'react';

export default function RefinementWelcomeStep({ plan, guestCount }) {
  return (
    <>
      {plan?.package_category === 'hosted' && Array.isArray(plan.package_includes) && plan.package_includes.length > 0 && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
            Your package: {plan.package_name}
          </h3>
          <p className="text-muted text-small" style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
            Stocked &amp; ready:
          </p>
          <ul style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', paddingLeft: '1.25rem', margin: 0 }}>
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
    </>
  );
}
```

(Removed: `VIBE_LABELS`, the `exploration` prop, `hasExploration`, the entire "From your exploration:" block and its hardcoded `rgba(193,125,60,0.08)` inline style. Copy changed from "build on what you already explored" → "finalize the details for your bar".)

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/plan/steps/RefinementWelcomeStep.js
git commit -m "refactor(plan): RefinementWelcomeStep — drop exploration recap, sole entry screen"
```

---

### Task 8: Collapse the wizard in `PotionPlanningLab.js`

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js`

Apply each edit. Line numbers are anchors from the current file; match on the quoted code.

- [ ] **Step 1: Remove the deleted lazy imports**

Replace lines 23-29:

```js
// Exploration phase steps
const VibeStep = lazy(() => import('./steps/VibeStep'));
const FlavorDirectionStep = lazy(() => import('./steps/FlavorDirectionStep'));
const ExplorationBrowseStep = lazy(() => import('./steps/ExplorationBrowseStep'));
const MocktailInterestStep = lazy(() => import('./steps/MocktailInterestStep'));
const ExplorationSaveStep = lazy(() => import('./steps/ExplorationSaveStep'));
const RefinementWelcomeStep = lazy(() => import('./steps/RefinementWelcomeStep'));
```

with:

```js
const RefinementWelcomeStep = lazy(() => import('./steps/RefinementWelcomeStep'));
```

- [ ] **Step 2: Remove the `exploration` default selections sub-object**

Replace lines 34-43:

```js
const DEFAULT_SELECTIONS = {
  // Exploration data (Phase 1)
  exploration: {
    vibe: null,
    flavorDirections: [],
    dreamDrinkNotes: '',
    favoriteDrinks: [],
    mocktailInterest: null,
  },
  // Refinement data (Phase 2 — existing fields)
```

with:

```js
const DEFAULT_SELECTIONS = {
  // Refinement data (existing fields)
```

- [ ] **Step 3: Update the `servingTypes` import**

Find the import line:
```js
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildExplorationQueue, derivePhase, buildHostedStepQueue, hostedActiveModules, HOSTED_GUEST_PREFS_STEP } from './data/servingTypes';
```
Replace with:
```js
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildHostedStepQueue, hostedActiveModules, HOSTED_GUEST_PREFS_STEP } from './data/servingTypes';
```

- [ ] **Step 4: Remove `phase` and `explorationQueue` state**

Delete the line `const [phase, setPhase] = useState('exploration');` (~91) and the line `const [explorationQueue, setExplorationQueue] = useState([]);` (~127).

- [ ] **Step 5: Remove phase derivation in the loader**

Replace lines 149-156:

```js
        // Derive phase from proposal status
        const derivedPhase = derivePhase(planRes.data.proposal_status);
        setPhase(derivedPhase);

        // Set up exploration queue
        if (derivedPhase === 'exploration') {
          setExplorationQueue(buildExplorationQueue());
        }
```

with:

```js
        // Pre-deposit plans are served as { locked: true } by the API (the
        // wizard never mounts for them) — handled in the loading/guard block
        // below. Everything past this point is the post-booking flow.
```

- [ ] **Step 6: Simplify the restore branch + keep the legacy seeding shim**

In the restore block, line 179, replace:
```js
        if (data.status === 'draft' || data.status === 'submitted' || data.status === 'exploration_saved') {
```
with:
```js
        if (data.status === 'draft' || data.status === 'submitted') {
```

At ~line 201, add a legacy comment above the `favDrinks` line so its retention is intentional:
```js
            // Legacy: pre-2026-05-17 exploration data. Safe to delete once all
            // such proposals have closed.
            const favDrinks = savedSel.exploration?.favoriteDrinks || [];
```

Replace the Phase-2 seeding block (lines 221-227):
```js
          // Phase 2 seeding: if entering refinement and exploration data exists, seed refinement fields
          if (derivedPhase === 'refinement' && savedSel.exploration?.favoriteDrinks?.length > 0 && !data.serving_type) {
            const expl = savedSel.exploration;
            if (expl.favoriteDrinks.length > 0 && (!savedSel.signatureDrinks || savedSel.signatureDrinks.length === 0)) {
              savedSel.signatureDrinks = [...expl.favoriteDrinks];
            }
          }
```
with:
```js
          // Legacy shim: a few in-flight clients explored under the old
          // pre-booking flow before 2026-05-17. When they book, still seed
          // their saved favorites into signature drinks so they aren't
          // stranded. Safe to delete once those proposals have closed.
          if (savedSel.exploration?.favoriteDrinks?.length > 0 && !data.serving_type) {
            const expl = savedSel.exploration;
            if (expl.favoriteDrinks.length > 0 && (!savedSel.signatureDrinks || savedSel.signatureDrinks.length === 0)) {
              savedSel.signatureDrinks = [...expl.favoriteDrinks];
            }
          }
```

Replace the step-setting tail (lines 250-268):
```js
          if (data.status === 'submitted') {
            setStep('submitted');
          } else if (derivedPhase === 'exploration' && data.status === 'exploration_saved') {
            // Re-entering exploration — show exploration save screen or let them re-explore
            setStep('welcome');
          } else if (derivedPhase === 'refinement') {
            // If already has a serving type and modules, stay at current state
            // Otherwise start at refinement welcome
            if (!data.serving_type) {
              if (planData.package_category === 'hosted') {
                // Hosted package — skip QuickPick, derive queue directly from bar_type
                const barType = planData.package_bar_type || 'full_bar';
                setQuickPickChoice(barType);
                setActiveModules(hostedActiveModules(barType));
                setModuleQueue(buildHostedStepQueue(barType));
              }
              setStep('refinementWelcome');
            }
          }
```
with:
```js
          if (data.status === 'submitted') {
            setStep('submitted');
          } else if (!data.serving_type) {
            // Fresh post-booking entry — start at the welcome screen.
            if (planData.package_category === 'hosted') {
              // Hosted package — skip QuickPick, derive queue directly from bar_type
              const barType = planData.package_bar_type || 'full_bar';
              setQuickPickChoice(barType);
              setActiveModules(hostedActiveModules(barType));
              setModuleQueue(buildHostedStepQueue(barType));
            }
            setStep('welcome');
          }
```

- [ ] **Step 7: Delete `handleExplorationSave` and `updateExploration`**

Delete the whole `handleExplorationSave` function (lines 364-384, including the `// Save exploration` comment) and the whole `updateExploration` function (lines 436-442, including the `// Update exploration sub-field` comment).

- [ ] **Step 8: Remove the exploration branch in `handleNext`**

Replace lines 645-657:
```js
    // Exploration navigation
    if (phase === 'exploration') {
      if (step === 'welcome') return goToStep(explorationQueue[0] || 'stepVibe');
      const explorationIdx = explorationQueue.indexOf(step);
      if (explorationIdx !== -1) {
        const nextIdx = explorationIdx + 1;
        if (nextIdx < explorationQueue.length) {
          return goToStep(explorationQueue[nextIdx]);
        }
        return goToStep('explorationSave');
      }
      return;
    }

    // Refinement navigation
    if (step === 'welcome' || step === 'refinementWelcome') {
```
with:
```js
    if (step === 'welcome') {
```

- [ ] **Step 9: Remove the exploration branch + consolidate ids in `handleBack`**

Replace lines 688-704:
```js
  const handleBack = () => {
    // Exploration back
    if (phase === 'exploration') {
      if (step === explorationQueue[0]) return goToStep('welcome');
      const explorationIdx = explorationQueue.indexOf(step);
      if (explorationIdx > 0) {
        return goToStep(explorationQueue[explorationIdx - 1]);
      }
      if (step === 'explorationSave') {
        return goToStep(explorationQueue[explorationQueue.length - 1]);
      }
      return;
    }

    // Refinement back
    if (step === 'quickPick') return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
    if (step === 'refinementWelcome') return; // no back from refinement welcome
    if (step === 'customSetup') return goToStep('quickPick');
```
with:
```js
  const handleBack = () => {
    if (step === 'quickPick') return goToStep('welcome');
    if (step === 'welcome') return; // no back from welcome
    if (step === 'customSetup') return goToStep('quickPick');
```

Then at lines 713-718 (hosted/mocktail back-from-first-step), replace:
```js
      if (plan?.package_category === 'hosted') {
        return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
      }
      if (plan?.package_bar_type === 'mocktail') {
        return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
      }
```
with:
```js
      if (plan?.package_category === 'hosted') {
        return goToStep('welcome');
      }
      if (plan?.package_bar_type === 'mocktail') {
        return goToStep('welcome');
      }
```

- [ ] **Step 10: Make progress + labels unconditional (no `phase`)**

Replace lines 730-735:
```js
  // Compute step progress (refinement only)
  const totalSteps = moduleQueue.length + 1;
  const currentQueueIdx = moduleQueue.indexOf(step);
  const progressStep = phase === 'refinement' && currentQueueIdx !== -1
    ? currentQueueIdx + 1
    : (phase === 'refinement' && step === 'confirmation' ? totalSteps : null);
```
with:
```js
  // Compute step progress
  const totalSteps = moduleQueue.length + 1;
  const currentQueueIdx = moduleQueue.indexOf(step);
  const progressStep = currentQueueIdx !== -1
    ? currentQueueIdx + 1
    : (step === 'confirmation' ? totalSteps : null);
```

Replace line 836:
```js
  const nextLabel = phase === 'exploration' ? 'Keep Going' : 'Next';
```
with:
```js
  const nextLabel = 'Next';
```

- [ ] **Step 11: Delete the `explorationSaved` screen**

Delete the whole block (lines 810-826):
```js
  // Exploration saved screen
  if (step === 'explorationSaved') {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '3rem' }}>
          <div className="card">
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>&#10024;</div>
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Exploration Saved!</h2>
            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
              We've saved your preferences, {plan?.client_name || 'friend'}. When you're ready
              to book, all your favorites will be waiting for you.
            </p>
          </div>
        </div>
      </div>
    );
  }
```

- [ ] **Step 12: Add the pre-deposit lock screen**

The API returns `{ locked: true, proposalToken }` for pre-deposit plans (Task 2). Render a lock screen when `plan?.locked` is true. Add this block immediately AFTER the `if (loading) { ... }` block and BEFORE the existing `if (error)` / main render (around line 737-746, right after the loading return closes):

```jsx
  if (plan?.locked) {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
              Your drink plan unlocks after you book
            </h2>
            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
              Once your deposit is paid, you'll design your drinks here. Until
              then, review and accept your proposal.
            </p>
            {plan.proposalToken && (
              <a
                className="btn btn-primary"
                href={`/proposal/${plan.proposalToken}`}
                style={{ marginTop: '1.25rem', display: 'inline-block' }}
              >
                View your proposal
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }
```

> The loader already does `setPlan(planRes.data)`; when the API returns `{ locked: true, proposalToken }` that becomes `plan`, so `plan.locked` / `plan.proposalToken` are present. The exploration restore/seed code only runs under `if (data.status === 'draft' || 'submitted')` — a locked payload has no `status`, so none of it executes. No extra guard needed.

- [ ] **Step 13: Delete exploration cases + fix the welcome case in `renderStep`**

In `renderStep()` replace lines 841-899:
```jsx
      case 'welcome':
        return <WelcomeStep plan={plan} phase={phase} />;
      case 'refinementWelcome':
        return (
          <RefinementWelcomeStep
            plan={plan}
            exploration={selections.exploration}
            guestCount={guestCount}
          />
        );

      // Exploration steps
      case 'stepVibe':
        return (
          <VibeStep
            value={selections.exploration.vibe}
            onChange={(val) => updateExploration('vibe', val)}
          />
        );
      case 'stepFlavorDirection':
        return (
          <FlavorDirectionStep
            selected={selections.exploration.flavorDirections}
            onChange={(val) => updateExploration('flavorDirections', val)}
            dreamNotes={selections.exploration.dreamDrinkNotes}
            onDreamNotesChange={(val) => updateExploration('dreamDrinkNotes', val)}
          />
        );
      case 'stepExplorationBrowse':
        return (
          <ExplorationBrowseStep
            cocktails={cocktails}
            categories={cocktailCategories}
            favoriteDrinks={selections.exploration.favoriteDrinks}
            onChange={updateFavoriteDrinks}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            toggleAddOnForDrink={toggleAddOnForDrink}
            addonPricing={addonPricing}
            syrupSelections={selections.syrupSelections || {}}
            onSyrupToggle={toggleSyrup}
          />
        );
      case 'stepMocktailInterest':
        return (
          <MocktailInterestStep
            value={selections.exploration.mocktailInterest}
            onChange={(val) => updateExploration('mocktailInterest', val)}
          />
        );
      case 'explorationSave':
        return (
          <ExplorationSaveStep
            exploration={selections.exploration}
            cocktails={cocktails}
            onSave={handleExplorationSave}
            saving={saving}
          />
        );

      // Refinement steps
      case 'quickPick':
        return (
          <QuickPickStep
            selected={quickPickChoice}
            onSelect={handleQuickPickSelect}
            exploration={selections.exploration}
          />
        );
```
with:
```jsx
      case 'welcome':
        return (
          <RefinementWelcomeStep
            plan={plan}
            guestCount={guestCount}
          />
        );

      case 'quickPick':
        return (
          <QuickPickStep
            selected={quickPickChoice}
            onSelect={handleQuickPickSelect}
          />
        );
```

- [ ] **Step 14: Reconcile remaining step-id arrays + sweep for dangling refs**

In the `showBack` / `showNext` arrays (~832-833), remove the now-dead step ids `'explorationSave'`, `'explorationSaved'`, and `'refinementWelcome'`; keep `'welcome'`, `'quickPick'`, `'customSetup'`, `'confirmation'`, `'submitted'`. Resulting lines:
```js
  const showBack = !['welcome', 'quickPick'].includes(step) && !hideGlobalNav;
  const showNext = !['quickPick', 'customSetup', 'confirmation', 'submitted'].includes(step) && !hideGlobalNav;
```

Then sweep for anything still referencing removed identifiers:
```bash
grep -n "phase\|explorationQueue\|derivePhase\|buildExplorationQueue\|refinementWelcome\|updateExploration\|handleExplorationSave\|explorationSaved\|stepVibe\|stepFlavorDirection\|stepExplorationBrowse\|stepMocktailInterest\|explorationSave\|WelcomeStep\b\|VibeStep\|FlavorDirectionStep\|ExplorationBrowseStep\|MocktailInterestStep\|ExplorationSaveStep\|selections\.exploration\b" client/src/pages/plan/PotionPlanningLab.js
```
Expected remaining matches ONLY: the two legacy-shim lines that read `savedSel.exploration?.favoriteDrinks` (Step 6) and `QuickPickStep`/other steps that may still accept an optional `exploration` prop. For any refinement step still passed `exploration={...}`, remove that prop from the JSX here and delete the prop usage in that step component (check `QuickPickStep.js`, `ConfirmationStep.js` — grep `props.exploration`/`exploration` in `client/src/pages/plan/steps/`). Any other match is a bug — fix before continuing.

- [ ] **Step 15: Client CI build (the gate)**

Run (bash): `cd client && CI=true npm run build`
(Windows PowerShell: `cd client; $env:CI='true'; npm run build`)
Expected: `Compiled successfully` / build completes with no ESLint errors. If it fails on an undefined identifier, return to Step 14's sweep.

- [ ] **Step 16: Commit**

```bash
git add client/src/pages/plan/PotionPlanningLab.js
git commit -m "refactor(plan): collapse to single post-booking flow + pre-deposit lock screen"
```

---

### Task 9: Documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `CLIENT_FACING_SURFACES.md`, `README.md`, `DR_BARTENDER_REDESIGN_BRIEF.md`

- [ ] **Step 1: ARCHITECTURE.md** — find the drink-plan / Potion Planning Lab section. Replace any "two-phase (Exploration → Refinement)" description with: the drink plan is created only after deposit (Stripe webhook → `createEventShifts` → `createDrinkPlan`); it is a single post-booking flow; `/plan/:token` returns a locked screen for pre-deposit proposals (legacy links only).

- [ ] **Step 2: CLIENT_FACING_SURFACES.md** — in the token-gated pages section, delete the rows for `WelcomeStep.js`, `VibeStep.js`, `FlavorDirectionStep.js`, `ExplorationBrowseStep.js`, `MocktailInterestStep.js`, `ExplorationSaveStep.js`. Rewrite the "Exploration phase first … then Refinement" booking-flow narrative (the numbered flow + the "What Currently Exists" paragraph) to: deposit paid → drink plan link emailed → single post-booking planning flow. Update `RefinementWelcomeStep.js`'s description (no longer "recaps exploration data").

- [ ] **Step 3: README.md** — in the folder-structure tree under `client/src/pages/plan/steps/`, remove the six deleted files.

- [ ] **Step 4: Redesign brief note** — in `DR_BARTENDER_REDESIGN_BRIEF.md` §6.2 (Potion Planning Lab) and the bite-1 reference, add a one-line note: the Exploration phase and its 5 steps + dual WelcomeStep were removed 2026-05-17; the Lab is post-booking only — the redesign bite no longer styles exploration steps.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CLIENT_FACING_SURFACES.md README.md DR_BARTENDER_REDESIGN_BRIEF.md
git commit -m "docs: drink plan is post-booking only — remove exploration from architecture/surfaces/readme/brief"
```

---

### Task 10: Verification matrix (ship gate — manual, no auto-push)

Do NOT push until every box is checked. This is the spec's ship gate (paid-client surface with a mid-flow Stripe charge).

- [ ] `node --test server/utils/drinkPlanAccess.test.js` → pass.
- [ ] `npm run lint` → pass (server).
- [ ] `cd client && CI=true npm run build` → compiled, no ESLint errors.
- [ ] Local run, post-deposit plan, each serving style routes end-to-end: signatures / full bar / beer-wine / mocktail / custom-setup → confirmation.
- [ ] Hosted-package plan: enters at welcome, skips QuickPick, routes via Guest Preferences, no dead steps, reaches confirmation.
- [ ] Browser back/forward within the flow: single `welcome` entry, no dead ends, no `refinementWelcome`.
- [ ] Auto-save fires every 30s and on tab close (network tab shows the PUT).
- [ ] `ConfirmationStep` paid extras: Stripe confirms, surcharge tally correct, "Drink Plan Extras" invoice lands.
- [ ] Submit → celebration screen → BEO email to admin.
- [ ] Proposal-sent email renders with NO "Plan Your Drinks" CTA.
- [ ] Deposit webhook still creates/reuses the drink plan and sends the `drinkPlanLink` email; fresh post-deposit plan (no exploration data) loads at `welcome` → flows.
- [ ] Pre-deposit `/plan/:token` (proposal status `sent`/`viewed`/`modified`/`accepted`) → lock screen, "View your proposal" link works, wizard never mounts, no auto-save PUT.
- [ ] (If a legacy plan with saved `exploration.favoriteDrinks` is reachable) booking it pre-fills `signatureDrinks` — shim intact.

- [ ] Report results to the user. Push is user-initiated only (CLAUDE.md) — do not push from this plan.

---

## Self-Review

**Spec coverage:** removal of pre-deposit creation/link → Task 4. Delete exploration step files incl. WelcomeStep → Task 5. servingTypes exploration exports → Task 6. RefinementWelcomeStep recap strip + copy → Task 7. PotionPlanningLab collapse / step-id consolidation / nav / progress / labels → Task 8. Pre-deposit lock (server + client) → Tasks 1, 2, 8 Step 12. `exploration_saved` server handling (PUT + PATCH) → Task 3. Legacy shims retained with comments → Task 8 Step 6. Schema untouched → no task (deliberate, per spec). Docs → Task 9. Verification matrix → Task 10. No gaps.

**Placeholder scan:** every code step shows exact before/after; commands have expected output; grep verifications are concrete. The only conditional ("if `createDrinkPlan` still referenced, leave line 6") is a clear decision rule with both branches specified.

**Type/identifier consistency:** helper `isDrinkPlanPreBooking` defined Task 1, imported/used Task 2. Locked payload shape `{ locked, proposalToken }` produced in Task 2, consumed in Task 8 Step 12 as `plan.locked`/`plan.proposalToken`. Step id `welcome` rendered by `RefinementWelcomeStep` consistently (Tasks 7, 8). `RefinementWelcomeStep` prop set is `{ plan, guestCount }` in both Task 7 (component) and Task 8 Step 13 (call site).
