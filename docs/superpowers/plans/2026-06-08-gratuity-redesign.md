# Gratuity Section Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the proposal Sign & Pay gratuity block to the apothecary treatment and harden the no-jar gratuity floor from a passive warning into a hard submit block, with no change to payroll/payout math.

**Architecture:** A small tested pure helper owns the below-floor predicate and the shared floor message. `ProposalView.js` derives the gratuity basis and `gratuityBelowFloor` **above its effects** (so the create-intent effect can depend on it without a temporal-dead-zone crash), gates the Stripe create-intent fetch, and guards `handleSign`. `SignAndPaySection.js` consumes the prop (disables Pay, suppresses the payment form below the floor) and carries the reskinned markup. CSS is appended to `index.css`. The server floor enforcement (`deriveGratuityRate` + the `proposals_gratuity_jar_check` DB CHECK) is untouched and remains the authoritative backstop.

**Tech Stack:** React 18 (CRA), vanilla CSS, Stripe React Elements, Jest (client unit tests via `react-scripts test`).

**Spec:** `docs/superpowers/specs/2026-06-08-gratuity-redesign-design.md`
**Drop-in source (reference markup/CSS):** `.claude/_gratuity-redesign/DROP-IN-CODE.md`

---

## File Structure

- **Create** `client/src/pages/proposal/proposalView/gratuityFloor.js` — pure helpers: `isGratuityBelowFloor(...)` and `gratuityFloorMessage(...)`. One responsibility: the no-jar floor predicate + its client-facing copy, in one place so the inline warning and the `handleSign` guard cannot drift.
- **Create** `client/src/pages/proposal/proposalView/gratuityFloor.test.js` — Jest unit tests for the helper (coercion edges).
- **Modify** `client/src/pages/proposal/proposalView/ProposalView.js` — hoist the gratuity basis + `gratuityBelowFloor` above the effects, gate the create-intent effect, add the `handleSign` floor guard, pass the prop.
- **Modify** `client/src/pages/proposal/proposalView/SignAndPaySection.js` — accept the prop, OR it into the Pay `disabled`, unify the floor warning on the shared message, suppress the payment area below the floor, and (Task 3) swap the gratuity block markup.
- **Modify** `client/src/index.css` — append the gratuity-block CSS, including `.tip-tablet:focus-within`.
- **Unchanged (reference only):** `server/utils/payrollAccrual.js`, `server/utils/payrollMath.js`, `server/utils/pricingEngine.js` (`deriveGratuityRate`, `GRATUITY_FLOOR_RATE`), `server/db/schema.sql` (`proposals_gratuity_jar_check`).

**Commit grouping:** Task 1 = one commit (helper). Task 2 = one commit (floor block). Task 3 = one commit (reskin). Task 4 = verification only.

**Review checkpoints (project execution-review cadence):**
- After Task 2 (money/Stripe gating path): dispatch `security-review` + `code-review` on the worktree diff before continuing.
- After Task 3 (presentation): dispatch `code-review` + `consistency-check`.

---

### Task 1: Floor-predicate helper (pure, TDD)

**Files:**
- Create: `client/src/pages/proposal/proposalView/gratuityFloor.js`
- Test: `client/src/pages/proposal/proposalView/gratuityFloor.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/proposal/proposalView/gratuityFloor.test.js`:

```js
import { isGratuityBelowFloor, gratuityFloorMessage } from './gratuityFloor';

const base = { gratuityEnabled: true, tipJar: false, gratuityTotal: 0, gratuityFloor: 600 };

test('isGratuityBelowFloor > false when gratuity is disabled', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityEnabled: false, gratuityTotal: 0 })).toBe(false);
});

test('isGratuityBelowFloor > false in jar mode regardless of amount', () => {
  expect(isGratuityBelowFloor({ ...base, tipJar: true, gratuityTotal: 0 })).toBe(false);
});

test('isGratuityBelowFloor > false at or above the floor (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 600 })).toBe(false);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 700 })).toBe(false);
});

test('isGratuityBelowFloor > true below the floor (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 300 })).toBe(true);
});

test('isGratuityBelowFloor > empty/undefined/non-numeric coerce to 0, not NaN (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '' })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: undefined })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 'abc' })).toBe(true);
});

test('isGratuityBelowFloor > accepts numeric strings from the input', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '300' })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '600' })).toBe(false);
});

test('gratuityFloorMessage > builds the shared floor copy', () => {
  expect(gratuityFloorMessage('$600', 'bartender'))
    .toBe('Without a tip jar, gratuity must be at least $600 so your bartenders are covered.');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from the worktree root, in Git Bash via the Bash tool):
```bash
cd client && CI=true npm test -- src/pages/proposal/proposalView/gratuityFloor.test.js --watchAll=false
```
Expected: FAIL — `Cannot find module './gratuityFloor'`.

- [ ] **Step 3: Write the helper**

Create `client/src/pages/proposal/proposalView/gratuityFloor.js`:

```js
// Pure helpers for the no-jar gratuity floor on the proposal Sign & Pay card.
// The floor is GRATUITY_FLOOR_RATE ($50) x staff x hours, computed in
// ProposalView and mirrored server-side (pricingEngine.GRATUITY_FLOOR_RATE).
// Keep the predicate and the client-facing message here, in one place, so the
// inline warning and the handleSign guard can never drift apart.

// True when a no-jar gratuity is below the required floor. Coerce the input
// (which may be '', a raw string, or undefined) so a cleared field reads as 0,
// never NaN — NaN < floor is false and would silently slip the guard.
export function isGratuityBelowFloor({ gratuityEnabled, tipJar, gratuityTotal, gratuityFloor }) {
  if (!gratuityEnabled || tipJar) return false;
  return (Number(gratuityTotal) || 0) < gratuityFloor;
}

// The single client-facing floor message, shared by the inline warning and the
// handleSign guard. `floorText` is the already-formatted dollar floor (fmt()).
export function gratuityFloorMessage(floorText, staffNoun) {
  return `Without a tip jar, gratuity must be at least ${floorText} so your ${staffNoun}s are covered.`;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd client && CI=true npm test -- src/pages/proposal/proposalView/gratuityFloor.test.js --watchAll=false
```
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/gratuityFloor.js client/src/pages/proposal/proposalView/gratuityFloor.test.js
git commit -m "feat(gratuity): add isGratuityBelowFloor + shared floor message helper"
```

---

### Task 2: Hard floor block (behavior change)

Wires `gratuityBelowFloor` through the live (not-yet-reskinned) component: it disables Pay, stops the create-intent fetch below the floor, replaces the payment area with a note, unifies the floor warning on the shared message, and guards `handleSign`. The server backstop is unchanged.

> **Why the hoist (Step 2):** `gratuityBelowFloor` is consumed by the create-intent effect's dependency array (Step 3, `ProposalView.js:189`), which React evaluates *during render at that line*. If the `const` were declared lower (the current basis block sits at `:326-335`, below the effect), the deps array would hit its temporal dead zone and throw `ReferenceError: Cannot access 'gratuityBelowFloor' before initialization`. So the whole gratuity basis moves above the effects.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`

- [ ] **Step 1: Import the helper in `ProposalView.js`**

After the existing `import SignAndPaySection from './SignAndPaySection';` (line ~13), add:

```js
import { isGratuityBelowFloor, gratuityFloorMessage } from './gratuityFloor';
```

- [ ] **Step 2: Hoist the gratuity basis + `gratuityBelowFloor` above the effects**

**(a)** Immediately after the gratuity state declarations (currently `const [gratuityDirty, setGratuityDirty] = useState(false);` at `ProposalView.js:44`), insert:

```js

  // Gratuity chooser basis (§4): suggested = 25 x staff x hours, no-jar floor =
  // GRATUITY_FLOOR_RATE ($50) x staff x hours. Read from the frozen snapshot
  // gratuity block. Derived HERE (above the payment-intent effect) so that
  // effect's below-floor gate can depend on `gratuityBelowFloor` without a TDZ.
  // NOTE: the literal 50 mirrors the server GRATUITY_FLOOR_RATE
  // (server/utils/pricingEngine.js) — keep them in sync; a server bump would
  // otherwise silently under-block the client here.
  const gratuityBasis = proposal?.pricing_snapshot?.gratuity || null;
  const gratuityStaffCount = gratuityBasis?.staff_count ?? 0;
  const gratuityHours = gratuityBasis?.hours ?? 0;
  const gratuityStaffNoun = gratuityBasis?.staff_noun || 'bartender';
  const gratuityEnabled = gratuityStaffCount * gratuityHours > 0;
  const gratuitySuggested = Math.round(25 * gratuityStaffCount * gratuityHours);
  const gratuityFloor = Math.round(50 * gratuityStaffCount * gratuityHours);
  const gratuityBelowFloor = isGratuityBelowFloor({
    gratuityEnabled, tipJar, gratuityTotal, gratuityFloor,
  });
```

(`proposal` is state and may be `null` during loading; the optional chaining yields a disabled, $0-floor, not-below-floor basis until it loads — safe before the early returns.)

**(b)** Delete the now-duplicate derivation further down. Remove the block currently at `ProposalView.js:326-335` (the comment `// Gratuity chooser basis (§4)...` through `const gratuityFloor = Math.round(50 * gratuityStaffCount * gratuityHours);`). **Leave** `const snapshot = proposal.pricing_snapshot;` (:308) and `totalPrice`/`balanceAmount` (:323-324) in place — those still feed the live total.

- [ ] **Step 3: Gate the create-intent effect below the floor**

In the consolidated payment-intent effect, just after `if (!paymentOption) return;` (currently `ProposalView.js:129`), add:

```js
    // Never quote a below-floor no-jar gratuity: the server would reject it
    // (deriveGratuityRate). Drop the loading state and let the gratuity floor
    // warning + the payment-area note (SignAndPaySection) be the only UI.
    if (gratuityBelowFloor) { setLoadingIntent(false); return; }
```

Then add `gratuityBelowFloor` to that effect's dependency array (currently ends `..., tipJar, gratuityTotal, gratuityDirty]);` at `ProposalView.js:189`):

```js
  }, [isPayableStatus, paymentOption, autopayChecked, token, depositSecret, fullSecret, tipJar, gratuityTotal, gratuityDirty, gratuityBelowFloor]);
```

- [ ] **Step 4: Add the `handleSign` floor guard**

In `handleSign`, after the venue-validation block (currently ends at `ProposalView.js:251`) and before `// If already signed ...` (line 253), insert — mirroring the existing `throw`-based early-exits so `PaymentForm` aborts the Stripe confirm:

```js
    if (gratuityBelowFloor) {
      const msg = gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun);
      setFormError(msg);
      throw new Error(msg);
    }
```

(This is belt-and-suspenders: below the floor the payment form is suppressed (Step 7), so the user cannot reach Pay; this guard only fires if a programmatic path slips through before the server/DB backstop. The `setFormError` is harmless even though the banner is unmounted in that state.)

- [ ] **Step 5: Pass the prop to `SignAndPaySection`**

In the `<SignAndPaySection ... />` render (currently `ProposalView.js:446-489`), add a prop after `gratuityStaffNoun={gratuityStaffNoun}` (line 465):

```js
                gratuityBelowFloor={gratuityBelowFloor}
```

- [ ] **Step 6: Update `SignAndPaySection.js` — prop, import, disabled, unified warning**

**(a)** Add the message import after the helpers import (currently `SignAndPaySection.js:5`):

```js
import { gratuityFloorMessage } from './gratuityFloor';
```

**(b)** In the props destructure, after `gratuityStaffNoun = 'bartender',` (currently `SignAndPaySection.js:78`), add:

```js
  gratuityBelowFloor = false,
```

**(c)** Replace the live inline floor warning (currently `SignAndPaySection.js:253-257`) with the shared-message version (single source of truth from this commit on):

```jsx
            {gratuityBelowFloor && (
              <p className="payment-policy-warn" role="alert" style={{ marginTop: '0.4rem' }}>
                {gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun)}
              </p>
            )}
```

(Task 3 reskins this paragraph's class; the condition + message stay.)

- [ ] **Step 7: Disable Pay + suppress the payment area below the floor**

Replace the entire `{/* Stripe Payment Element */}` block (currently `SignAndPaySection.js:297-334`) with the following. This folds in the `disabled` change (so there is no separate, immediately-overwritten edit) and gates the whole block on `gratuityBelowFloor`. Note the note reuses the existing `sign-pay-needs` class (already on `main` at `SignAndPaySection.js:292`), not a reskin-introduced class:

```jsx
        {/* Stripe Payment Element */}
        <div>
          {gratuityBelowFloor ? (
            <p className="sign-pay-needs" role="status" aria-live="polite">
              Add the required gratuity above to continue to payment.
            </p>
          ) : (
            <>
              {loadingIntent && (
                <div style={{ textAlign: 'center', padding: '2rem' }} role="status" aria-live="polite">
                  <div className="spinner" />
                </div>
              )}

              <FormBanner error={formError} fieldErrors={fieldErrors} />

              {activeSecret && stripePromise && !loadingIntent && (
                <div className="sign-pay-stripe-wrap">
                  <Elements
                    key={activeSecret}
                    stripe={stripePromise}
                    options={elementsOptions}
                  >
                    <PaymentForm
                      onSubmit={handleSign}
                      payLabel={payLabel}
                      disabled={!sigName.trim() || !sigData || !venueComplete || gratuityBelowFloor}
                    />
                  </Elements>
                </div>
              )}

              {activeSecret && !stripePromise && !loadingIntent && (
                <div style={{ textAlign: 'center', padding: '1rem' }} role="status" aria-live="polite">
                  <div className="spinner" />
                </div>
              )}

              {!activeSecret && !loadingIntent && !formError && (
                <p style={{ color: 'var(--rust)', fontSize: '0.875rem' }}>
                  Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
                </p>
              )}
            </>
          )}
        </div>
```

- [ ] **Step 8: Build the client**

Run (from the worktree root):
```bash
cd client && CI=true npm run build
```
Expected: `Compiled successfully` (warnings allowed, no errors). Confirms no TDZ/ESLint break from the hoist.

- [ ] **Step 9: Manual verification**

On a proposal in a payable status with a gratuity basis (staff x hours > 0):
- **Skip it** → amount jumps to the floor, payment form loads normally.
- Type **below** the floor → floor warning shows, the Stripe form is replaced by "Add the required gratuity above to continue to payment.", and no "Unable to load payment form" banner appears.
- Confirm (Network tab) NO `create-intent` request fires while below the floor.
- Raise back to/above the floor → after the ~400ms debounce the payment form returns.
- **Keep it** + $0 → no floor, form loads, Pay enabled.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "feat(gratuity): hard-block no-jar gratuity below the floor"
```

- [ ] **Step 11: Review checkpoint (money path)**

Dispatch `security-review` and `code-review` on the Task 2 worktree diff (Stripe gating, `handleSign` throw, create-intent gate, Pay `disabled`). Resolve any blocker before Task 3.

---

### Task 3: Apothecary reskin of the gratuity block (presentation)

Swaps the gratuity block markup to the drop-in treatment and appends the CSS. Behavior-preserving relative to Task 2, with the `None` chip correctly gated, the question eyebrow restored, the focus ring added, and the copy de-em-dashed. `gratuityBelowFloor`, `gratuityFloorMessage`, and `fmt` are already in scope from Task 2.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`
- Modify: `client/src/index.css`

- [ ] **Step 1: Replace the gratuity block markup**

Replace the entire `{/* Gratuity (§4) ... */}` block (the `{gratuityEnabled && (...)}` JSX, currently around `SignAndPaySection.js:216-259` — note its inline warning was already updated in Task 2 Step 6c) with:

```jsx
        {/* Gratuity (§4): plain dollars; the rate is internal. Server confirms
            the new total before it shows. Hidden when staff x hours <= 0. */}
        {gratuityEnabled && (
          <div className="gratuity-block">
            <span className="sign-pay-eyebrow">Tip jar at the bar?</span>
            <div className="gratuity-head">
              <span className="sign-pay-eyebrow">Step · Gratuity</span>
              <h3 className="gratuity-heading">Tipping, handled your way</h3>
              <p className="gratuity-intro">
                <span className="assured">Every dollar</span> goes straight to your
                {` ${gratuityStaffNoun}s`}. None of it is kept by Dr. Bartender.
              </p>
            </div>

            <div className="tip-jar-choices" role="radiogroup" aria-label="Tip jar">
              <label className={`tip-tablet ${tipJar ? 'is-selected' : ''}`}>
                <input type="radio" name="tipJar" checked={tipJar}
                  onChange={() => { setTipJar(true); setGratuityDirty(true); }} />
                <span className="tip-tablet-top">
                  <span className="tip-tablet-mark" aria-hidden="true">&#9906;</span>
                  <span className="tip-tablet-label">Keep the tip jar</span>
                </span>
                <span className="tip-tablet-desc">
                  A jar sits on the bar; guests tip as they like. Add a little extra below
                  if you'd like to start it off.
                </span>
              </label>
              <label className={`tip-tablet ${!tipJar ? 'is-selected' : ''}`}>
                <input type="radio" name="tipJar" checked={!tipJar}
                  onChange={() => {
                    setTipJar(false);
                    setGratuityDirty(true);
                    setGratuityTotal((g) => Math.max(Number(g) || 0, gratuityFloor));
                  }} />
                <span className="tip-tablet-top">
                  <span className="tip-tablet-mark" aria-hidden="true">&#10005;</span>
                  <span className="tip-tablet-label">Skip the tip jar</span>
                </span>
                <span className="tip-tablet-desc">
                  No jar out. A set gratuity for your {gratuityStaffNoun}s is added to the
                  total instead.
                </span>
              </label>
            </div>

            <div className="gratuity-amount">
              <span className="sign-pay-eyebrow" style={{ display: 'block' }}>
                {tipJar ? 'Add a gratuity?' : `Gratuity for your ${gratuityStaffNoun}s`}
              </span>

              <div className="gratuity-presets">
                {tipJar && (
                  <>
                    <button type="button" className="gratuity-chip"
                      onClick={() => { setGratuityTotal(0); setGratuityDirty(true); }}>
                      None
                    </button>
                    <button type="button" className="gratuity-chip"
                      onClick={() => { setGratuityTotal(gratuitySuggested); setGratuityDirty(true); }}>
                      {fmt(gratuitySuggested)}<span className="chip-note">suggested</span>
                    </button>
                  </>
                )}
              </div>

              <div className="gratuity-input-frame">
                <span className="gratuity-input-currency">$</span>
                <input className="gratuity-input" type="number" min={tipJar ? 0 : gratuityFloor} step="1"
                  value={gratuityTotal}
                  onChange={(e) => { setGratuityTotal(e.target.value); setGratuityDirty(true); }} />
                <span className="gratuity-input-hint">100%&nbsp;to your<br />{gratuityStaffNoun}s</span>
              </div>

              {gratuityBelowFloor && (
                <p className="gratuity-floor-warn" role="alert">
                  {gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun)}
                </p>
              )}
            </div>
          </div>
        )}
```

- [ ] **Step 2: Append the gratuity-block CSS**

In `client/src/index.css`, immediately after the `.payment-tablet-autopay` rule block (search for `.payment-tablet-autopay`; it is at ~line 9576), append:

```css
/* ── Gratuity chooser (§4) — apothecary treatment ───────────────── */
.gratuity-block { display: flex; flex-direction: column; gap: 14px; }
.gratuity-head { display: flex; flex-direction: column; gap: 6px; }
.gratuity-heading {
  font-family: var(--font-display);
  font-size: 1.18rem; font-weight: 400;
  color: var(--cream-text); margin: 0; letter-spacing: 0.015em;
}
.gratuity-intro {
  margin: 0; font-size: 0.85rem; line-height: 1.5;
  color: rgba(240, 232, 214, 0.72);
}
.gratuity-intro .assured { color: var(--brass-bright); font-style: italic; }

.tip-jar-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 420px) { .tip-jar-choices { grid-template-columns: 1fr; } }

.tip-tablet {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  border: 2px solid rgba(184, 146, 74, 0.45); border-radius: 8px;
  padding: 13px 14px 14px; cursor: pointer;
  background: transparent; color: var(--cream-text);
  transition: background 0.18s, border-color 0.18s;
}
.tip-tablet:hover { border-color: var(--brass-bright); }
.tip-tablet:focus-within { border-color: var(--amber); box-shadow: 0 0 0 3px rgba(29, 140, 137, 0.18); }
.tip-tablet input { position: absolute; opacity: 0; pointer-events: none; }
.tip-tablet.is-selected {
  border-color: var(--amber); background: var(--paper); color: var(--deep-brown);
}
.tip-tablet-top { display: flex; align-items: center; gap: 9px; }
.tip-tablet-mark {
  width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%;
  border: 1.5px solid var(--brass);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px; line-height: 1; color: var(--brass);
}
.tip-tablet.is-selected .tip-tablet-mark {
  border-color: var(--amber); background: var(--amber); color: var(--paper);
}
.tip-tablet-label { font-family: var(--font-display); font-size: 0.98rem; letter-spacing: 0.01em; }
.tip-tablet-desc { font-size: 0.78rem; line-height: 1.45; color: rgba(240, 232, 214, 0.66); }
.tip-tablet.is-selected .tip-tablet-desc { color: var(--text-muted); }

.gratuity-amount { display: flex; flex-direction: column; gap: 8px; }
.gratuity-presets { display: flex; gap: 8px; flex-wrap: wrap; }
.gratuity-chip {
  font-family: var(--font-display); font-size: 0.82rem; letter-spacing: 0.04em;
  padding: 8px 14px; border-radius: 999px;
  border: 1.5px solid rgba(184, 146, 74, 0.5);
  background: transparent; color: var(--cream-text); cursor: pointer;
  transition: border-color 0.16s, background 0.16s, color 0.16s;
}
.gratuity-chip:hover { border-color: var(--brass-bright); }
.gratuity-chip .chip-note {
  font-family: var(--font-body); font-style: italic; font-size: 0.72rem;
  opacity: 0.7; margin-left: 4px;
}

.gratuity-input-frame {
  display: flex; align-items: center;
  background: var(--paper); border: 1px solid rgba(28, 22, 16, 0.22);
  border-radius: 6px; padding: 4px 4px 4px 14px; max-width: 300px;
}
.gratuity-input-frame:focus-within {
  border: 2px solid var(--amber); padding: 3px 3px 3px 13px;
  box-shadow: 0 0 0 3px rgba(29, 140, 137, 0.18);
}
.gratuity-input-currency { font-family: var(--font-display); font-size: 1.1rem; color: var(--text-muted); }
.gratuity-input {
  border: none; background: transparent;
  font-family: var(--font-display); font-size: 1.25rem; color: var(--deep-brown);
  width: 90px; padding: 8px 6px; font-variant-numeric: tabular-nums;
}
.gratuity-input:focus { outline: none; }
.gratuity-input-hint {
  margin-left: auto; font-size: 0.7rem; font-family: var(--font-display);
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--sage);
  padding: 0 12px; text-align: right; line-height: 1.3;
}

.gratuity-floor-warn {
  font-size: 0.8rem; margin: 2px 0 0; padding: 0.55rem 0.75rem;
  background: rgba(160, 82, 45, 0.14); border-left: 3px solid var(--rust);
  border-radius: 4px; color: var(--brass-bright);
}
```

- [ ] **Step 3: Build the client**

Run:
```bash
cd client && CI=true npm run build
```
Expected: `Compiled successfully`, no errors.

- [ ] **Step 4: Manual verification**

On the Sign & Pay card:
- The gratuity block renders as two tip-jar tablets, brass preset chips, and the parchment input frame.
- **Visual order:** the "Tip jar at the bar?" eyebrow sits directly above the "Step · Gratuity" / "Tipping, handled your way" header (two `sign-pay-eyebrow` lines render back-to-back — confirm this matches the mockup; if it reads cramped, drop one).
- **Keep the tip jar**: `None` and `{suggested}` chips show; clicking each sets the amount; $0 allowed; Pay enabled.
- **Skip the tip jar**: no chips show; amount at the floor; the floor warning + payment-area note appear only when typing below the floor (Task 2 behavior intact).
- Keyboard: Tab to a tablet shows a teal focus ring; Arrow keys move selection.
- Copy reads "Every dollar goes straight to your {staff}s. None of it is kept by Dr. Bartender." with "Every dollar" italicized; no em dash anywhere.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/index.css
git commit -m "feat(gratuity): apothecary reskin of the Sign & Pay gratuity block"
```

- [ ] **Step 6: Review checkpoint (presentation)**

Dispatch `code-review` + `consistency-check` on the Task 3 worktree diff.

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the client unit tests**

```bash
cd client && CI=true npm test -- src/pages/proposal/proposalView/gratuityFloor.test.js --watchAll=false
```
Expected: PASS.

- [ ] **Step 2: Full client build (the Vercel lint gate)**

```bash
cd client && CI=true npm run build
```
Expected: `Compiled successfully`, no errors.

- [ ] **Step 3: Em-dash sweep (Git Bash)**

Confirm no em dash slipped into the changed client copy. Run in Git Bash (the Bash tool), scoped to the two files that carry copy:
```bash
git diff main -- client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/index.css | grep -n '—' || echo "no em dashes"
```
Expected: `no em dashes`.

- [ ] **Step 4: Validation-parity spot check (manual)**

Confirm the server still rejects a below-floor no-jar gratuity if the client gate is bypassed. With the proposal token, issue a raw request that skips the client gate, e.g. in the browser console:
```js
fetch(`/api/stripe/create-intent/${token}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_option: 'full', autopay: false, tip_jar: false, gratuity_total: 1 }),
}).then(r => r.json()).then(console.log);
```
Expected: a 4xx with the floor `ValidationError` from `deriveGratuityRate` (`GRATUITY_BELOW_FLOOR`) — client guard and server floor agree. (Adjust the base path if the API origin differs from the app origin.)

- [ ] **Step 5: Confirm no regression in the preserved handlers**

Toggle jar/amount and confirm the "New total" only updates after the server re-quote (the `gratuityDirty` → secret-invalidation → fresh intent chain still fires).

---

## Self-Review

**1. Spec coverage:**
- §3.1 reskin + invariants → Task 3 Step 1 (markup), handlers preserved verbatim. ✓
- §3.2 None-chip gating → Task 3 Step 1 (both chips inside `{tipJar && (...)}`). ✓
- §3.3 hard floor block (single-home `gratuityBelowFloor` hoisted above effects, coercion via helper, no intent below floor, `throw` guard, single floor message, floor-rate dup flagged in the hoist comment) → Task 1 + Task 2. ✓
- §3.4 keyboard focus → Task 3 Step 2 (`.tip-tablet:focus-within`). ✓
- §3.5 copy (em-dash → period, `.assured` span, 100% chip, colon-less label, accepted-claim) → Task 3 Step 1. ✓
- §4 edge cases (empty/coerced input, jar mode, switching, payOnly) → helper coercion (Task 1) + payOnly branch untouched. ✓
- §5 verification (build, manual, below-floor no-intent, validation parity, no-regression) → Task 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**3. Type/name consistency:** `isGratuityBelowFloor` / `gratuityFloorMessage` defined in Task 1, used with identical signatures in Tasks 2-3; `gratuityBelowFloor` declared once (Task 2 Step 2a, above the effects) and consumed in the effect deps, `handleSign`, the prop, and the warning. The Pay `disabled` expression appears only once (Task 2 Step 7) — no redundant intermediate edit. ✓

**Decomposition note:** Tasks ordered helper → floor block → reskin; only backward dependencies. Task 2 ships a complete hard-floor block (warning + guard share one message from this commit); Task 3 reskins on top. The hoist (Step 2) fixes the TDZ the plan review caught and gives `gratuityBelowFloor` a single home. Review checkpoints: `security-review`+`code-review` after Task 2 (money path), `code-review`+`consistency-check` after Task 3.
