# Gratuity Section Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the proposal Sign & Pay gratuity block to the apothecary treatment and harden the no-jar gratuity floor from a passive warning into a hard submit block, with no change to payroll/payout math.

**Architecture:** A small tested pure helper owns the below-floor predicate and the shared floor message. `ProposalView.js` computes `gratuityBelowFloor` once and passes it down; it gates the Stripe create-intent fetch and the `handleSign` submit. `SignAndPaySection.js` consumes the prop (disables Pay, suppresses the payment form below the floor) and carries the reskinned markup. CSS is appended to `index.css`. The server floor enforcement (`deriveGratuityRate` + the `proposals_gratuity_jar_check` DB CHECK) is untouched and remains the authoritative backstop.

**Tech Stack:** React 18 (CRA), vanilla CSS, Stripe React Elements, Jest (client unit tests via `react-scripts test`).

**Spec:** `docs/superpowers/specs/2026-06-08-gratuity-redesign-design.md`
**Drop-in source (reference markup/CSS):** `.claude/_gratuity-redesign/DROP-IN-CODE.md`

---

## File Structure

- **Create** `client/src/pages/proposal/proposalView/gratuityFloor.js` — pure helpers: `isGratuityBelowFloor(...)` and `gratuityFloorMessage(...)`. One responsibility: the no-jar floor predicate + its client-facing copy, in one place so the inline warning and the `handleSign` guard cannot drift.
- **Create** `client/src/pages/proposal/proposalView/gratuityFloor.test.js` — Jest unit tests for the helper (coercion edges).
- **Modify** `client/src/pages/proposal/proposalView/ProposalView.js` — compute `gratuityBelowFloor`, pass it as a prop, gate the create-intent effect, add the `handleSign` floor guard.
- **Modify** `client/src/pages/proposal/proposalView/SignAndPaySection.js` — accept the prop, OR it into the Pay `disabled`, suppress the payment area below the floor, and (separately) swap the gratuity block markup to the reskin.
- **Modify** `client/src/index.css` — append the gratuity-block CSS, including `.tip-tablet:focus-within`.
- **Unchanged (reference only):** `server/utils/payrollAccrual.js`, `server/utils/payrollMath.js`, `server/utils/pricingEngine.js` (`deriveGratuityRate`, `GRATUITY_FLOOR_RATE`), `server/db/schema.sql` (`proposals_gratuity_jar_check`).

**Commit grouping:** Task 1 = one commit (helper). Task 2 = one commit (floor block). Task 3 = one commit (reskin). Task 4 = verification only.

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

Run (from the worktree root):
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

Wires `gratuityBelowFloor` through the live (not-yet-reskinned) component: it disables Pay, stops the create-intent fetch below the floor, replaces the payment area with a note, and guards `handleSign`. The server backstop is unchanged.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`

- [ ] **Step 1: Import the helper in `ProposalView.js`**

After the existing `import SignAndPaySection from './SignAndPaySection';` (line ~13), add:

```js
import { isGratuityBelowFloor, gratuityFloorMessage } from './gratuityFloor';
```

- [ ] **Step 2: Compute `gratuityBelowFloor` in `ProposalView.js`**

Immediately after the `gratuityFloor` derivation (currently `client/src/pages/proposal/proposalView/ProposalView.js:335`), add:

```js
  const gratuityBelowFloor = isGratuityBelowFloor({
    gratuityEnabled, tipJar, gratuityTotal, gratuityFloor,
  });
```

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

- [ ] **Step 5: Pass the prop to `SignAndPaySection`**

In the `<SignAndPaySection ... />` render (currently `ProposalView.js:446-489`), add a prop next to the other gratuity props (after `gratuityStaffNoun={gratuityStaffNoun}` at line 465):

```js
                gratuityBelowFloor={gratuityBelowFloor}
```

- [ ] **Step 6: Accept the prop + OR it into Pay `disabled` in `SignAndPaySection.js`**

In the `SignAndPaySection` props destructure, after `gratuityStaffNoun = 'bartender',` (currently `SignAndPaySection.js:78`), add:

```js
  gratuityBelowFloor = false,
```

Then change the `PaymentForm` `disabled` expression (currently `SignAndPaySection.js:317`) from:

```jsx
                  disabled={!sigName.trim() || !sigData || !venueComplete}
```

to:

```jsx
                  disabled={!sigName.trim() || !sigData || !venueComplete || gratuityBelowFloor}
```

- [ ] **Step 7: Suppress the payment area below the floor**

Replace the entire `{/* Stripe Payment Element */}` block (currently `SignAndPaySection.js:297-334`) with:

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

(Note: the `disabled` change from Step 6 now lives inside this replaced block — keep both consistent. Step 6's standalone edit and this block edit target the same `disabled` line; apply this block as the final state.)

- [ ] **Step 8: Build the client and verify it compiles**

Run (from the worktree root):
```bash
cd client && CI=true npm run build
```
Expected: `Compiled successfully` (warnings allowed, no errors).

- [ ] **Step 9: Manual verification**

Start the app against a proposal in a payable status that has a gratuity basis (staff x hours > 0). On the Sign & Pay card:
- Select **Skip it** → amount jumps to the floor, payment form loads normally.
- Type an amount **below** the floor → the floor warning shows, the Stripe form disappears and is replaced by "Add the required gratuity above to continue to payment.", and no "Unable to load payment form" banner appears.
- Raise the amount back to/above the floor → after the ~400ms debounce the payment form returns.
- Keep the jar (**Keep it**) and set $0 → no floor, payment form loads, Pay enabled.
- (Validation parity) With a below-floor no-jar amount, no `create-intent` request is sent (check the Network tab).

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "feat(gratuity): hard-block no-jar gratuity below the floor"
```

---

### Task 3: Apothecary reskin of the gratuity block (presentation)

Swaps the gratuity block markup to the drop-in treatment and appends the CSS. Behavior-preserving relative to the live block, with the `None` chip correctly gated, the question eyebrow restored, the focus ring added, and the copy de-em-dashed. Uses the `gratuityBelowFloor` prop from Task 2 for the warning.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`
- Modify: `client/src/index.css`

- [ ] **Step 1: Import the shared message in `SignAndPaySection.js`**

Change the helpers import (currently `SignAndPaySection.js:5`) to also pull in the message, and add the gratuityFloor helper import below it:

```js
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import { gratuityFloorMessage } from './gratuityFloor';
```

- [ ] **Step 2: Replace the gratuity block markup**

Replace the entire `{/* Gratuity (§4) ... */}` block (currently `SignAndPaySection.js:216-259`, the `{gratuityEnabled && (...)}` JSX) with:

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

- [ ] **Step 3: Append the gratuity-block CSS**

In `client/src/index.css`, immediately after the `.payment-tablet-autopay` rule block (search for `.payment-tablet-autopay`), append:

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

- [ ] **Step 4: Build the client**

Run:
```bash
cd client && CI=true npm run build
```
Expected: `Compiled successfully`, no errors.

- [ ] **Step 5: Manual verification**

On the Sign & Pay card:
- The gratuity block renders as two tip-jar tablets, brass preset chips, and the parchment input frame, with the "Tip jar at the bar?" eyebrow above.
- **Keep the tip jar**: `None` and `{suggested}` chips show; clicking each sets the amount; $0 allowed; Pay enabled.
- **Skip the tip jar**: no chips show; amount is at the floor; the floor warning + payment-area note appear only when typing below the floor (Task 2 behavior intact).
- Keyboard: Tab to a tablet shows a teal focus ring; Arrow keys move selection.
- Copy reads "Every dollar goes straight to your {staff}s. None of it is kept by Dr. Bartender." with "Every dollar" italicized; no em dash anywhere.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/index.css
git commit -m "feat(gratuity): apothecary reskin of the Sign & Pay gratuity block"
```

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
Expected: `Compiled successfully`, no errors (this is the gate Vercel enforces).

- [ ] **Step 3: Em-dash sweep**

Confirm no em dash slipped into the changed client copy:
```bash
git diff main -- client/src | grep -n $'—' || echo "no em dashes"
```
Expected: `no em dashes`.

- [ ] **Step 4: Validation-parity spot check (manual)**

In the browser, with a no-jar amount below the floor, remove the Pay button's `disabled` via DevTools (or force a `create-intent` with a below-floor `gratuity_total`) and confirm the server still rejects it (`deriveGratuityRate` → `GRATUITY_BELOW_FLOOR`) — the client block and the server floor agree.

- [ ] **Step 5: Confirm no regression in the preserved handlers**

Toggle jar/amount and confirm the "New total" only updates after the server re-quote (the `gratuityDirty` → secret-invalidation → fresh intent chain still fires).

---

## Self-Review

**1. Spec coverage:**
- §3.1 reskin + invariants → Task 3 (markup/CSS), handlers preserved verbatim in the replacement block. ✓
- §3.2 None-chip gating → Task 3 Step 2 (both chips inside `{tipJar && (...)}`). ✓
- §3.3 hard floor block (single-home `gratuityBelowFloor`, coercion, no intent below floor, `throw` guard, single floor message, floor-rate dup noted) → Task 1 (helper) + Task 2 (wiring). ✓
- §3.4 keyboard focus → Task 3 Step 3 (`.tip-tablet:focus-within`). ✓
- §3.5 copy (em-dash → period, `.assured` span, 100% chip, colon-less label, accepted-claim) → Task 3 Step 2. ✓
- §4 edge cases (empty/coerced input, jar mode, switching, payOnly) → covered by helper coercion (Task 1) + payOnly untouched (no edit to payOnly branch). ✓
- §5 verification (build, manual, below-floor no-intent, validation parity, no-regression) → Task 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**3. Type/name consistency:** `isGratuityBelowFloor` / `gratuityFloorMessage` defined in Task 1 and used with identical signatures in Tasks 2-3; `gratuityBelowFloor` prop named identically in `ProposalView` (Task 2 Step 5) and `SignAndPaySection` destructure/use (Task 2 Step 6, Task 3). The Pay `disabled` expression appears in Task 2 Step 6 and again in the Task 2 Step 7 block — Step 7 is the final state (noted inline). ✓

**Decomposition note:** Tasks are ordered helper → floor block → reskin so each has only backward dependencies. Task 2 ships a working hard-floor block on the live markup; Task 3 reskins on top. Both are independently revertable.
