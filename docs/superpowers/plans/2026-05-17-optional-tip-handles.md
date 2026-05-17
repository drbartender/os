# Optional Tip Handles + Trustworthy Edit-Later Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make customer-facing tip handles optional at onboarding (UI only), fix the printed QR card so it advertises only the payment methods a bartender actually has, and rebuild the staff "My Tip Page" screen to brand quality so bartenders trust it with their money.

**Architecture:** Frontend + print-rendering only. One new pure helper drives the QR card's logo row from saved handles + Stripe-link presence. The onboarding form is visually split into a required "how we pay you" card and an optional "your tip page" card with **no change to validation, submit payload, or any server route** — the server already enforces "one payroll method required, all other handles optional." My Tip Page is rebuilt on the existing Dr. Bartender design tokens using the same existing endpoints.

**Tech Stack:** React 18 (CRA), React Router 6, CRA Jest (`react-scripts test`), vanilla CSS with `drb-tokens.css` design system, `qrcode.react`.

**Spec:** `docs/superpowers/specs/2026-05-17-optional-tip-handles-design.md`

**Guardrail (do not violate):** No edits to `server/**`. No schema changes. No new endpoints. `submit()` validation logic in `PaydayProtocols.js` is preserved verbatim — only JSX layout changes. If a step seems to require a server change, stop: it doesn't.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `client/src/utils/tipCardMarks.js` | Create | Pure: saved handles + `has_stripe_link` → array of available mark keys |
| `client/src/utils/tipCardMarks.test.js` | Create | Unit tests for the helper (all combinations) |
| `client/src/pages/staff/PrintTipCard.jsx` | Modify | Compute marks once, pass into layouts |
| `client/src/pages/staff/PrintTipCard.layouts.jsx` | Modify | Layouts take a `marks` prop; render only available marks; drop the logo block when empty |
| `client/src/pages/PaydayProtocols.js` | Modify | Split payment section into required "How we pay you" + optional "Your tip page" cards (JSX only) |
| `client/src/pages/staff/MyTipPage.js` | Rewrite | Brand-quality staff tip-page manager (same endpoints) |
| `client/src/pages/staff/MyTipPage.css` | Create | Styling for the rebuilt page (beside the page, matching `PrintTipCard.css` convention) |
| `client/src/pages/admin/userDetail/tabs/TipPageTab.js` | Modify | Add payroll-method selector (admin route already accepts it) |
| `README.md` | Modify | Add new util to folder-structure tree |

Tasks 1–2 (helper + sign) are independent of Tasks 3–5. Task order below is recommended for clean commits but tasks 3, 4, 5 can be done in any order.

---

## Task 1: `tipCardMarks` pure helper (TDD)

**Files:**
- Create: `client/src/utils/tipCardMarks.js`
- Test: `client/src/utils/tipCardMarks.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/tipCardMarks.test.js` (mirrors the existing `client/src/utils/timeOptions.test.js` CRA-Jest style — no framework imports needed):

```js
import { buildTipCardMarks } from './tipCardMarks';

describe('buildTipCardMarks', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks({})).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
  });

  test('stripe link only → card-network group only', () => {
    expect(buildTipCardMarks({ has_stripe_link: true }))
      .toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('each P2P handle alone', () => {
    expect(buildTipCardMarks({ venmo_handle: 'x' })).toEqual(['venmo']);
    expect(buildTipCardMarks({ cashapp_handle: 'x' })).toEqual(['cashapp']);
    expect(buildTipCardMarks({ paypal_url: 'https://paypal.me/x' })).toEqual(['paypal']);
  });

  test('empty-string handles are treated as absent', () => {
    expect(buildTipCardMarks({ venmo_handle: '', cashapp_handle: '', paypal_url: '' }))
      .toEqual([]);
  });

  test('P2P handles without a stripe link → no card-network marks', () => {
    expect(buildTipCardMarks({ venmo_handle: 'a', cashapp_handle: 'b' }))
      .toEqual(['venmo', 'cashapp']);
  });

  test('everything → P2P first, then card-network group, canonical order', () => {
    expect(buildTipCardMarks({
      venmo_handle: 'a', cashapp_handle: 'b', paypal_url: 'c', has_stripe_link: true,
    })).toEqual(['venmo', 'cashapp', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (Bash tool uses bash; `CI=true` makes CRA's runner execute once and exit):
```bash
cd client && CI=true npx react-scripts test src/utils/tipCardMarks.test.js --watchAll=false
```
Expected: FAIL — `Cannot find module './tipCardMarks'`.

- [ ] **Step 3: Write the minimal implementation**

Create `client/src/utils/tipCardMarks.js`:

```js
// Pure: given a bartender's saved tip handles + whether a Stripe Payment Link
// exists, return which payment-method marks the printed QR card may show.
//
// The card-network group (Apple/Google Pay + Visa/MC/Amex) is gated on the
// Stripe link because that link is what actually accepts cards. Each P2P mark
// appears only when that handle is set. Print layouts intersect this list with
// their own curated mark order, so an unavailable method simply drops out and
// the card never advertises a payment route that doesn't work.

const CARD_NETWORK_MARKS = ['apple', 'google', 'visa', 'mc', 'amex'];

export function buildTipCardMarks(handles) {
  const h = handles || {};
  const marks = [];
  if (h.venmo_handle) marks.push('venmo');
  if (h.cashapp_handle) marks.push('cashapp');
  if (h.paypal_url) marks.push('paypal');
  if (h.has_stripe_link) marks.push(...CARD_NETWORK_MARKS);
  return marks;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run:
```bash
cd client && CI=true npx react-scripts test src/utils/tipCardMarks.test.js --watchAll=false
```
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/tipCardMarks.js client/src/utils/tipCardMarks.test.js
git commit -m "feat(tip-card): pure helper deriving printable payment marks from saved handles"
```

---

## Task 2: Drive the printed QR card from real handles

**Files:**
- Modify: `client/src/pages/staff/PrintTipCard.jsx`
- Modify: `client/src/pages/staff/PrintTipCard.layouts.jsx`

`/me/tip-page` (already fetched by `PrintTipCard.jsx`) returns `venmo_handle`, `cashapp_handle`, `paypal_url`, and `has_stripe_link` — exactly the helper's inputs. No endpoint change.

- [ ] **Step 1: Import + compute marks in `PrintTipCard.jsx`**

In `client/src/pages/staff/PrintTipCard.jsx`, add the import after the existing layout import (line ~10):

```js
import { buildTipCardMarks } from '../../utils/tipCardMarks';
```

Find:
```js
  const { renderFront: Front, renderBack: Back } = SIZES[size];
  const name = data.preferred_name || 'your bartender';
```
Replace with:
```js
  const { renderFront: Front, renderBack: Back } = SIZES[size];
  const name = data.preferred_name || 'your bartender';
  const marks = buildTipCardMarks(data);
```

Find:
```jsx
        <div className="sheet">
          <Front name={name} tipUrl={data.url} />
        </div>
```
Replace with:
```jsx
        <div className="sheet">
          <Front name={name} tipUrl={data.url} marks={marks} />
        </div>
```
(Leave the `<Back …>` call unchanged — `BizCardBackA` is contact-info only and has no payment row.)

- [ ] **Step 2: `BizCardFrontA` — render only available marks**

In `client/src/pages/staff/PrintTipCard.layouts.jsx`, change the signature:

Find:
```jsx
export function BizCardFrontA({ name = 'your bartender', tipUrl = '' }) {
  return (
```
Replace with:
```jsx
const BIZ_MARKS = ['apple', 'venmo', 'cashapp', 'paypal', 'visa'];

export function BizCardFrontA({ name = 'your bartender', tipUrl = '', marks = null }) {
  // marks === null → no caller passed it: keep the original full row (back-compat).
  const shownMarks = marks == null ? BIZ_MARKS : BIZ_MARKS.filter((m) => marks.includes(m));
  return (
```

Find this block (the logo-strip label + row in the left column):
```jsx
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 10,
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
            color: 'var(--drb-warm-brown)',
            marginTop: 6,
            marginBottom: 6,
          }}>Scan to Tip</div>
          <PaymentRow size={20} gap={4} marks={['apple', 'venmo', 'cashapp', 'paypal', 'visa']} align="flex-start" />
```
Replace with:
```jsx
          {shownMarks.length > 0 && (
            <>
              <div style={{
                fontFamily: 'var(--drb-font-display)',
                fontSize: 10,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: 'var(--drb-warm-brown)',
                marginTop: 6,
                marginBottom: 6,
              }}>Scan to Tip</div>
              <PaymentRow size={20} gap={4} marks={shownMarks} align="flex-start" />
            </>
          )}
```

- [ ] **Step 3: `FourBySixA` — render only available marks**

Find:
```jsx
export function FourBySixA({ name = 'your bartender', tipUrl = '' }) {
  return (
```
Replace with:
```jsx
const FEATURE_ROW_MARKS = ['apple', 'google', 'venmo', 'cashapp', 'paypal'];
const FEATURE_NET_MARKS = ['visa', 'mc', 'amex'];

export function FourBySixA({ name = 'your bartender', tipUrl = '', marks = null }) {
  const rowMarks = marks == null ? FEATURE_ROW_MARKS : FEATURE_ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? FEATURE_NET_MARKS : FEATURE_NET_MARKS.filter((m) => marks.includes(m));
  const showPayCard = rowMarks.length > 0 || netMarks.length > 0;
  return (
```

Find:
```jsx
        {/* Payment methods — feature row */}
        <div style={{
          background: 'var(--drb-card-bg)',
          border: '1.5px solid var(--drb-brass)',
          borderRadius: 10,
          padding: '12px 16px',
          width: '100%',
        }}>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 8,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass)',
            textAlign: 'center',
            marginBottom: 8,
          }}>Pay any way you like</div>
          <PaymentRow size={32} gap={8} marks={['apple', 'google', 'venmo', 'cashapp', 'paypal']} />
          <div style={{ height: 8 }} />
          <PaymentRow size={26} gap={8} marks={['visa', 'mc', 'amex']} />
        </div>
```
Replace with:
```jsx
        {/* Payment methods — feature row (only the methods this bartender has) */}
        {showPayCard && (
          <div style={{
            background: 'var(--drb-card-bg)',
            border: '1.5px solid var(--drb-brass)',
            borderRadius: 10,
            padding: '12px 16px',
            width: '100%',
          }}>
            <div style={{
              fontFamily: 'var(--drb-font-display)',
              fontSize: 8,
              letterSpacing: '0.28em',
              textTransform: 'uppercase',
              color: 'var(--drb-brass)',
              textAlign: 'center',
              marginBottom: 8,
            }}>Pay any way you like</div>
            {rowMarks.length > 0 && <PaymentRow size={32} gap={8} marks={rowMarks} />}
            {rowMarks.length > 0 && netMarks.length > 0 && <div style={{ height: 8 }} />}
            {netMarks.length > 0 && <PaymentRow size={26} gap={8} marks={netMarks} />}
          </div>
        )}
```

- [ ] **Step 4: `FiveBySevenA` — render only available marks**

Find:
```jsx
export function FiveBySevenA({ name = 'your bartender', tipUrl = '' }) {
  return (
```
Replace with:
```jsx
export function FiveBySevenA({ name = 'your bartender', tipUrl = '', marks = null }) {
  const rowMarks = marks == null ? FEATURE_ROW_MARKS : FEATURE_ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? FEATURE_NET_MARKS : FEATURE_NET_MARKS.filter((m) => marks.includes(m));
  const showPayCard = rowMarks.length > 0 || netMarks.length > 0;
  return (
```
(Reuses the `FEATURE_ROW_MARKS` / `FEATURE_NET_MARKS` consts defined above `FourBySixA` in Step 3.)

Find:
```jsx
        {/* Payment methods — feature card */}
        <div style={{
          background: 'var(--drb-card-bg)',
          border: '1.5px solid var(--drb-brass)',
          borderRadius: 10,
          padding: '14px 18px',
          width: '100%',
        }}>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 9,
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass)',
            textAlign: 'center',
            marginBottom: 10,
          }}>Pay any way you like</div>
          <PaymentRow size={38} gap={10} marks={['apple', 'google', 'venmo', 'cashapp', 'paypal']} />
          <div style={{ height: 8 }} />
          <PaymentRow size={28} gap={10} marks={['visa', 'mc', 'amex']} />
        </div>
```
Replace with:
```jsx
        {/* Payment methods — feature card (only the methods this bartender has) */}
        {showPayCard && (
          <div style={{
            background: 'var(--drb-card-bg)',
            border: '1.5px solid var(--drb-brass)',
            borderRadius: 10,
            padding: '14px 18px',
            width: '100%',
          }}>
            <div style={{
              fontFamily: 'var(--drb-font-display)',
              fontSize: 9,
              letterSpacing: '0.32em',
              textTransform: 'uppercase',
              color: 'var(--drb-brass)',
              textAlign: 'center',
              marginBottom: 10,
            }}>Pay any way you like</div>
            {rowMarks.length > 0 && <PaymentRow size={38} gap={10} marks={rowMarks} />}
            {rowMarks.length > 0 && netMarks.length > 0 && <div style={{ height: 8 }} />}
            {netMarks.length > 0 && <PaymentRow size={28} gap={10} marks={netMarks} />}
          </div>
        )}
```

- [ ] **Step 5: Verify the client still compiles**

Run:
```bash
cd client && CI=true npx react-scripts build
```
Expected: `Compiled successfully.` (warnings tolerated; no errors).

- [ ] **Step 6: Manual smoke (dev server already runs, Claude-managed)**

Visit `/my-tip-page/print` as a staff user. Confirm: a bartender with only Venmo shows only the Venmo (+ card, if Stripe link) marks; the QR, name, and headshot always render; no empty bordered "Pay any way you like" box when there are zero marks.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/staff/PrintTipCard.jsx client/src/pages/staff/PrintTipCard.layouts.jsx
git commit -m "fix(tip-card): printed QR card shows only the payment methods the bartender has"
```

---

## Task 3: Split onboarding into required payroll + optional tip page

**Files:**
- Modify: `client/src/pages/PaydayProtocols.js` (JSX inside `<form onSubmit={submit}>` only)

**Hard constraint:** Do NOT touch `submit()`, `handle`, `handleVenmoHandle`, `handleCashappHandle`, the `useEffect` loader, `migrateLegacyMethod`, `stripVenmo`, `stripCashapp`, `PAYMENT_METHODS`, state, imports, or the W-9 block. Only the markup that arranges the fieldset changes. Field `name=` attributes and the FormData payload are unchanged, so the existing server-side "one method + its detail required" gate is preserved.

- [ ] **Step 1: Add one derived constant**

In `client/src/pages/PaydayProtocols.js`, find:
```jsx
  const method = form.preferred_payment_method;

  return (
```
Replace with:
```jsx
  const method = form.preferred_payment_method;
  // A P2P method (venmo/cashapp/paypal) is BOTH the payroll target and a tip-page
  // handle — it lives in one shared column, so it is collected once in Card A
  // and shown read-only in Card B (no duplicate input bound to the same state).
  const p2pPayroll = method === 'venmo' || method === 'cashapp' || method === 'paypal';

  return (
```

- [ ] **Step 2: Replace the form body with the two-card structure**

In `client/src/pages/PaydayProtocols.js`, replace the entire region from `<form onSubmit={submit}>` through its closing `</form>` with the following. Every handler, id, `name`, helper string, the direct-deposit block, the check alert, the W-9 block, `FormBanner`, and the nav buttons are preserved — only grouping/labels/conditional-visibility change.

```jsx
        <form onSubmit={submit}>
          {/* ── Card A — How we pay you (REQUIRED) ── */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ marginBottom: '0.35rem' }}>How we pay you</h3>
            <p className="text-small text-muted" style={{ marginBottom: '0.25rem' }}>
              Pick one way to receive your wages and pooled tips. This is the only
              payment detail we require to finish onboarding.
            </p>
            <p className="text-small text-muted italic" style={{ marginBottom: '1.25rem' }}>
              Encrypted and never shared outside Dr. Bartender.
            </p>

            <div className={`form-group${fieldClass('preferred_payment_method')}`} role="radiogroup" aria-labelledby="pp-payroll-legend">
              <div id="pp-payroll-legend" className="form-label">Pay me out via *</div>
              <div className="radio-group">
                {PAYMENT_METHODS.map(opt => (
                  <label
                    key={opt.value}
                    className={`radio-option${method === opt.value ? ' selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="preferred_payment_method"
                      value={opt.value}
                      checked={method === opt.value}
                      onChange={handle}
                    />
                    <span className="radio-label">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {method === 'venmo' && (
              <div className={`form-group${fieldClass('venmo_handle')}`}>
                <label htmlFor="pp-venmo_handle" className="form-label">Venmo handle *</label>
                <input
                  id="pp-venmo_handle" name="venmo_handle" type="text"
                  className={`form-input${inputClass('venmo_handle')}`}
                  value={form.venmo_handle} onChange={handleVenmoHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the username — we'll strip the @ or venmo.com/u/ for you.</p>
              </div>
            )}

            {method === 'cashapp' && (
              <div className={`form-group${fieldClass('cashapp_handle')}`}>
                <label htmlFor="pp-cashapp_handle" className="form-label">Cash App handle *</label>
                <input
                  id="pp-cashapp_handle" name="cashapp_handle" type="text"
                  className={`form-input${inputClass('cashapp_handle')}`}
                  value={form.cashapp_handle} onChange={handleCashappHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the cashtag — we'll strip the $ or cash.app/$ for you.</p>
              </div>
            )}

            {method === 'paypal' && (
              <div className={`form-group${fieldClass('paypal_url')}`}>
                <label htmlFor="pp-paypal_url" className="form-label">PayPal URL *</label>
                <input
                  id="pp-paypal_url" name="paypal_url" type="text"
                  className={`form-input${inputClass('paypal_url')}`}
                  value={form.paypal_url} onChange={handle}
                  placeholder="paypal.me/yourname"
                />
                <p className="form-helper">Either paypal.me/yourname or a full URL.</p>
              </div>
            )}

            {method === 'direct_deposit' && (
              <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--warm-brown)', marginBottom: '0.85rem' }}>
                  Bank Account Details
                </div>
                <div className={`form-group${fieldClass('routing_number')}`}>
                  <label htmlFor="pp-routing_number" className="form-label">Routing Number *</label>
                  <input
                    id="pp-routing_number" name="routing_number" className={`form-input${inputClass('routing_number')}`}
                    value={form.routing_number} onChange={handle}
                    placeholder="9 digits" maxLength={9} inputMode="numeric"
                    style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                  />
                  <p className="form-helper">The 9-digit number on the bottom-left of your check</p>
                </div>
                <div className={`form-group${fieldClass('account_number')}`} style={{ marginBottom: 0 }}>
                  <label htmlFor="pp-account_number" className="form-label">Account Number *</label>
                  <input
                    id="pp-account_number" name="account_number" className={`form-input${inputClass('account_number')}`}
                    value={form.account_number} onChange={handle}
                    placeholder="Your account number"
                    style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                  />
                  <p className="form-helper">Your checking account number — found on a check or in your banking app</p>
                </div>
              </div>
            )}

            {method === 'check' && (
              <div className="alert alert-info" style={{ marginBottom: 0 }}>
                Checks are mailed to the address on your Contractor Profile. Make sure your mailing address there is current.
              </div>
            )}

            {method === 'other' && (
              <div className="alert alert-info" style={{ marginBottom: 0 }}>
                No problem — we'll coordinate your payout method with you directly before your first payday.
              </div>
            )}
          </div>

          {/* ── Card B — Your public tip page (handles OPTIONAL) ── */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ marginBottom: '0.35rem' }}>Your public tip page</h3>
            <p className="text-small text-muted" style={{ marginBottom: '1.25rem' }}>
              Your tip page lives at <strong>drbartender.com/tip/your-name</strong> with a
              QR you can print. Your name is required; the tip handles below are
              <strong> optional</strong> — add them now, later from My Tip Page, or never.
              None of this is shared outside DRB.
            </p>

            <div className={`form-group${fieldClass('preferred_name')}`}>
              <label htmlFor="pp-preferred_name" className="form-label">Preferred name *</label>
              <input
                id="pp-preferred_name" name="preferred_name" type="text"
                className={`form-input${inputClass('preferred_name')}`}
                value={form.preferred_name} onChange={handle}
                maxLength={80} required
                placeholder="What customers see on your tip page"
              />
              <p className="form-helper">
                The name customers see on your tip page. Use whatever you go by — your real name, a nickname, a stage name.
              </p>
            </div>

            {p2pPayroll && (
              <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
                Your payroll {method === 'venmo' ? 'Venmo' : method === 'cashapp' ? 'Cash App' : 'PayPal'}{' '}
                handle is already on your tip page — no need to re-enter it here.
              </div>
            )}

            {method !== 'venmo' && (
              <div className={`form-group${fieldClass('venmo_handle')}`}>
                <label htmlFor="pp-venmo_handle-tip" className="form-label">Venmo handle <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-venmo_handle-tip" name="venmo_handle" type="text"
                  className={`form-input${inputClass('venmo_handle')}`}
                  value={form.venmo_handle} onChange={handleVenmoHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the username — we'll strip the @ or venmo.com/u/ for you.</p>
              </div>
            )}

            {method !== 'cashapp' && (
              <div className={`form-group${fieldClass('cashapp_handle')}`}>
                <label htmlFor="pp-cashapp_handle-tip" className="form-label">Cash App handle <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-cashapp_handle-tip" name="cashapp_handle" type="text"
                  className={`form-input${inputClass('cashapp_handle')}`}
                  value={form.cashapp_handle} onChange={handleCashappHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the cashtag — we'll strip the $ or cash.app/$ for you.</p>
              </div>
            )}

            {method !== 'paypal' && (
              <div className={`form-group${fieldClass('paypal_url')}`} style={{ marginBottom: 0 }}>
                <label htmlFor="pp-paypal_url-tip" className="form-label">PayPal URL <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-paypal_url-tip" name="paypal_url" type="text"
                  className={`form-input${inputClass('paypal_url')}`}
                  value={form.paypal_url} onChange={handle}
                  placeholder="paypal.me/yourname"
                />
                <p className="form-helper">Either paypal.me/yourname or a full URL.</p>
              </div>
            )}
          </div>

          {/* ── W-9 (unchanged, still required) ── */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
              W-9 Form *
            </div>
            <FieldError error={fieldErrors?.w9} />

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'fill' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { setW9Mode('fill'); setW9Done(false); }}
              >
                Fill Out Online
              </button>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'upload' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setW9Mode('upload')}
              >
                Upload Existing W-9
              </button>
            </div>

            {w9Mode === 'fill' ? (
              w9Done ? (
                <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>W-9 filled out and signed — PDF ready to submit.</span>
                  <button type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--success)', borderColor: 'var(--success)' }} onClick={() => { setW9Done(false); setW9File(null); }}>
                    Edit W-9
                  </button>
                </div>
              ) : (
                <W9Form
                  onComplete={(file) => {
                    setW9File(file);
                    setW9Done(true);
                  }}
                />
              )
            ) : (
              <FileUpload
                label="Upload Your Signed W-9"
                name="w9"
                helper="Photo or PDF accepted. Need a blank W-9? Download from IRS.gov."
                onChange={(name, file) => setW9File(file)}
                currentFile={w9File || existingW9}
              />
            )}
          </div>

          <FormBanner error={error} fieldErrors={fieldErrors} />

          <div className="flex gap-2" style={{ justifyContent: 'space-between', marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/contractor-profile')}>
              ← Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Submitting...' : 'Submit Onboarding →'}
            </button>
          </div>
        </form>
```

- [ ] **Step 3: Verify the client compiles**

Run:
```bash
cd client && CI=true npx react-scripts build
```
Expected: `Compiled successfully.` — no "unused variable" errors (every preserved handler/state is still referenced).

- [ ] **Step 4: Manual verification (the money-gate must be intact)**

On `/payday-protocols`:
- Select **Check** → no handle fields shown, no asterisk on any handle; fill name + W-9 → submit succeeds.
- Select **Venmo**, leave the Venmo field blank → submit is **blocked** with the existing "Venmo handle is required…" message (proves the gate survived).
- Select **Direct deposit** → routing/account appear required; add an optional Cash App handle in Card B → submit succeeds; the Cash App handle persists.
- Select **Venmo**, fill it → Card B shows the "already on your tip page" notice and **no** second Venmo input.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PaydayProtocols.js
git commit -m "feat(onboarding): split payment step into required payroll + optional tip-page handles"
```

---

## Task 4: Rebuild "My Tip Page" to brand quality

**Files:**
- Rewrite: `client/src/pages/staff/MyTipPage.js`
- Create: `client/src/pages/staff/MyTipPage.css` (beside the page — matches the `PrintTipCard.css` convention)

Same endpoints only: `GET /me/tip-page`, `PATCH /me/tip-page`, `GET /me/tips`. Renders inside `StaffLayout`'s light `admin-content`; the page mounts its own self-contained `.drb` styled surface. Preserves every existing behavior: copy-URL, print CTA gating (`has_stripe_link` + `url`), not-active-yet message, Stripe-not-ready message, the honest "P2P tips don't show here" copy, and the tips table.

- [ ] **Step 1: Create `client/src/pages/staff/MyTipPage.css`**

```css
/* My Tip Page — staff money screen. Self-contained Dr. Bartender surface
   rendered inside the light staff shell. Scoped under .mtp so it can't leak. */
.mtp {
  --mtp-paper: #EDE6D6;
  --mtp-ink: #1C1610;
  --mtp-muted: #5A5048;
  --mtp-teal: #1D8C89;
  --mtp-brass: #B8924A;
  --mtp-line: #D8CFBE;
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  color: var(--mtp-ink);
}
.mtp h1 {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.9rem;
  margin: 0 0 4px;
  color: var(--mtp-ink);
}
.mtp .mtp-sub { color: var(--mtp-muted); margin: 0 0 24px; font-size: 0.95rem; }
.mtp-card {
  background: linear-gradient(180deg, #EFE9DB 0%, #E6DDCC 100%);
  border: 1px solid var(--mtp-brass);
  border-radius: 12px;
  padding: 20px 22px;
  margin-bottom: 18px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
.mtp-card h2 {
  font-family: Georgia, serif;
  font-size: 1.05rem;
  letter-spacing: 0.02em;
  margin: 0 0 14px;
  color: var(--mtp-ink);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.mtp-kicker {
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.18em;
  color: var(--mtp-brass); font-weight: 700;
}
.mtp-url {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #fff; border: 1px solid var(--mtp-line);
  border-radius: 8px; padding: 10px 12px;
}
.mtp-url code { font-size: 0.95rem; color: var(--mtp-ink); word-break: break-all; }
.mtp-btn {
  font: inherit; cursor: pointer; border-radius: 8px;
  padding: 9px 16px; border: 1px solid var(--mtp-teal);
  background: var(--mtp-teal); color: #fff; transition: filter .15s ease;
}
.mtp-btn:hover { filter: brightness(1.08); }
.mtp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.mtp-btn.ghost { background: transparent; color: var(--mtp-teal); }
.mtp-btn.ghost:hover { background: rgba(29,140,137,0.08); }
.mtp-field { margin-bottom: 14px; }
.mtp-field:last-child { margin-bottom: 0; }
.mtp-field label {
  display: block; font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.14em; color: var(--mtp-muted); margin-bottom: 5px;
}
.mtp-field input, .mtp-field select {
  font: inherit; width: 100%; padding: 10px 12px;
  border: 1px solid var(--mtp-line); border-radius: 8px;
  background: #fff; color: var(--mtp-ink);
}
.mtp-field input:focus, .mtp-field select:focus {
  outline: 0; border-color: var(--mtp-teal);
  box-shadow: 0 0 0 3px rgba(29,140,137,0.15);
}
.mtp-note {
  font-size: 0.85rem; color: var(--mtp-muted); font-style: italic; margin: 8px 0 0;
}
.mtp-reassure {
  display: flex; gap: 8px; align-items: flex-start;
  font-size: 0.85rem; color: var(--mtp-muted);
  background: rgba(29,140,137,0.07); border-radius: 8px;
  padding: 10px 12px; margin-top: 12px;
}
.mtp-preview-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
.mtp-preview-list li {
  display: flex; justify-content: space-between; gap: 12px;
  font-size: 0.9rem; padding: 8px 12px;
  background: #fff; border: 1px solid var(--mtp-line); border-radius: 8px;
}
.mtp-preview-list .mtp-empty { color: var(--mtp-muted); font-style: italic; justify-content: center; }
.mtp-row-actions { display: flex; gap: 8px; margin-top: 16px; }
.mtp-tips-total { font-size: 1.5rem; font-weight: 700; color: var(--mtp-ink); }
.mtp-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9rem; }
.mtp-table th { text-align: left; color: var(--mtp-muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--mtp-line); }
.mtp-table td { padding: 6px 8px; border-bottom: 1px solid var(--mtp-line); }
.mtp-state { text-align: center; color: var(--mtp-muted); padding: 40px 0; }
@media (max-width: 560px) {
  .mtp h2 { flex-direction: column; align-items: flex-start; }
  .mtp-row-actions { flex-direction: column; }
  .mtp-row-actions .mtp-btn { width: 100%; }
}
```

- [ ] **Step 2: Rewrite `client/src/pages/staff/MyTipPage.js`**

Replace the entire file with:

```jsx
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import './MyTipPage.css';

const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];
const METHOD_LABEL = Object.fromEntries(PAY_METHODS);

export default function MyTipPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tips, setTips] = useState([]);
  const [loadErr, setLoadErr] = useState(false);
  const [edit, setEdit] = useState(null);          // null until loaded
  const [savingHandles, setSavingHandles] = useState(false);
  const [savingMethod, setSavingMethod] = useState(false);
  const [editingMethod, setEditingMethod] = useState(false);
  const [copied, setCopied] = useState(false);

  function hydrate(d) {
    setData(d);
    setEdit({
      preferred_name: d.preferred_name || '',
      venmo_handle: d.venmo_handle || '',
      cashapp_handle: d.cashapp_handle || '',
      paypal_url: d.paypal_url || '',
      preferred_payment_method: d.preferred_payment_method || '',
    });
  }

  useEffect(() => {
    api.get('/me/tip-page')
      .then(r => hydrate(r.data))
      .catch(() => { setLoadErr(true); toast.error("Couldn't load your tip page. Try refreshing."); });
    api.get('/me/tips')
      .then(r => setTips(r.data.tips || []))
      .catch(() => { /* tips are secondary; page still usable */ });
    // toast is stable from the provider; adding it would retrigger on hot-reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveHandles(e) {
    e.preventDefault();
    setSavingHandles(true);
    try {
      await api.patch('/me/tip-page', {
        preferred_name: edit.preferred_name,
        venmo_handle: edit.venmo_handle,
        cashapp_handle: edit.cashapp_handle,
        paypal_url: edit.paypal_url,
      });
      const r = await api.get('/me/tip-page');
      hydrate(r.data);
      toast.success('Saved.');
    } catch (err) {
      toast.error(err?.message || "Couldn't save. Try again.");
    } finally {
      setSavingHandles(false);
    }
  }

  async function saveMethod() {
    setSavingMethod(true);
    try {
      await api.patch('/me/tip-page', { preferred_payment_method: edit.preferred_payment_method });
      const r = await api.get('/me/tip-page');
      hydrate(r.data);
      setEditingMethod(false);
      toast.success('Payout method updated.');
    } catch (err) {
      toast.error(err?.message || "Couldn't update. Try again.");
    } finally {
      setSavingMethod(false);
    }
  }

  function copyUrl() {
    if (!data?.url) return;
    navigator.clipboard.writeText(data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loadErr && !data) {
    return (
      <div className="mtp">
        <div className="mtp-state">Couldn't load your tip page. Refresh the page to try again.</div>
      </div>
    );
  }
  if (!data || !edit) {
    return <div className="mtp"><div className="mtp-state">Loading your tip page…</div></div>;
  }

  const previewMethods = [
    edit.venmo_handle && ['Venmo', `@${edit.venmo_handle}`],
    edit.cashapp_handle && ['Cash App', `$${edit.cashapp_handle}`],
    edit.paypal_url && ['PayPal', edit.paypal_url.replace(/^https?:\/\//, '')],
    data.has_stripe_link && ['Credit Card', 'Apple Pay · Google Pay'],
  ].filter(Boolean);

  return (
    <div className="mtp">
      <h1>My Tip Page</h1>
      <p className="mtp-sub">Your tips, your handles, your money — manage it all here.</p>

      {/* ── Your tip page ── */}
      <section className="mtp-card">
        <h2><span>Your tip page</span><span className="mtp-kicker">Public</span></h2>
        {data.url ? (
          <>
            <div className="mtp-url">
              <code>{data.url}</code>
              <button type="button" className="mtp-btn" onClick={copyUrl}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
            <ul className="mtp-preview-list">
              {previewMethods.length === 0 ? (
                <li className="mtp-empty">No tip options yet — add a handle below and it appears here.</li>
              ) : previewMethods.map(([label, sub]) => (
                <li key={label}><span>{label}</span><span style={{ color: 'var(--mtp-muted)' }}>{sub}</span></li>
              ))}
            </ul>
            {data.has_stripe_link ? (
              <div className="mtp-row-actions">
                <Link to="/my-tip-page/print" className="mtp-btn">Print my QR card</Link>
              </div>
            ) : (
              <p className="mtp-note">Your card-payment link isn't ready yet — contact an admin to generate it. Your other handles still work.</p>
            )}
          </>
        ) : (
          <p className="mtp-note">Your tip page isn't active yet. Finish onboarding and an admin will switch it on.</p>
        )}
      </section>

      {/* ── How you get paid ── */}
      <section className="mtp-card">
        <h2><span>How you get paid</span><span className="mtp-kicker">Payroll</span></h2>
        {editingMethod ? (
          <>
            <div className="mtp-field">
              <label htmlFor="mtp-method">Pay me out via</label>
              <select
                id="mtp-method"
                value={edit.preferred_payment_method}
                onChange={e => setEdit(s => ({ ...s, preferred_payment_method: e.target.value }))}
              >
                <option value="">Select a method…</option>
                {PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="mtp-row-actions">
              <button type="button" className="mtp-btn" disabled={savingMethod || !edit.preferred_payment_method} onClick={saveMethod}>
                {savingMethod ? 'Saving…' : 'Save method'}
              </button>
              <button
                type="button"
                className="mtp-btn ghost"
                disabled={savingMethod}
                onClick={() => { setEditingMethod(false); setEdit(s => ({ ...s, preferred_payment_method: data.preferred_payment_method || '' })); }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '1.05rem' }}>
              {data.preferred_payment_method
                ? <strong>{METHOD_LABEL[data.preferred_payment_method] || data.preferred_payment_method}</strong>
                : <span style={{ color: 'var(--mtp-muted)' }}>No payout method on file yet.</span>}
            </p>
            <div className="mtp-row-actions">
              <button type="button" className="mtp-btn ghost" onClick={() => setEditingMethod(true)}>
                {data.preferred_payment_method ? 'Change payout method' : 'Set payout method'}
              </button>
            </div>
          </>
        )}
        <div className="mtp-reassure">
          <span aria-hidden="true">🔒</span>
          <span>This is how Dr. Bartender sends your wages and pooled tips. Encrypted, never shared outside DRB.</span>
        </div>
      </section>

      {/* ── Tip handles ── */}
      <section className="mtp-card">
        <h2><span>Tip handles</span><span className="mtp-kicker">Optional</span></h2>
        <p className="mtp-note" style={{ marginTop: 0, marginBottom: 14 }}>
          These only affect your public tip page and printed QR card. Add, change, or
          clear them anytime — leaving one blank simply hides it.
        </p>
        <form onSubmit={saveHandles}>
          <div className="mtp-field">
            <label htmlFor="mtp-name">Preferred name</label>
            <input id="mtp-name" required value={edit.preferred_name}
              onChange={e => setEdit(s => ({ ...s, preferred_name: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-venmo">Venmo handle</label>
            <input id="mtp-venmo" placeholder="yourname" value={edit.venmo_handle}
              onChange={e => setEdit(s => ({ ...s, venmo_handle: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-cashapp">Cash App handle</label>
            <input id="mtp-cashapp" placeholder="yourname" value={edit.cashapp_handle}
              onChange={e => setEdit(s => ({ ...s, cashapp_handle: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-paypal">PayPal URL</label>
            <input id="mtp-paypal" placeholder="paypal.me/yourname" value={edit.paypal_url}
              onChange={e => setEdit(s => ({ ...s, paypal_url: e.target.value }))} />
          </div>
          <div className="mtp-row-actions">
            <button type="submit" className="mtp-btn" disabled={savingHandles}>
              {savingHandles ? 'Saving…' : 'Save handles'}
            </button>
          </div>
        </form>
      </section>

      {/* ── Tips earned ── */}
      <section className="mtp-card">
        <h2><span>Tips earned</span><span className="mtp-kicker">This month</span></h2>
        <p className="mtp-tips-total">${((data.tips_this_month_cents || 0) / 100).toFixed(2)}</p>
        <p className="mtp-note">
          Only the Credit Card path goes through Stripe and shows here. Venmo, Cash App,
          and PayPal taps go straight to your account, so they aren't counted. Stripe
          tips are pooled with co-workers per event and paid out via your next payroll —
          the final amount may differ.
        </p>
        {tips.length === 0 ? (
          <p className="mtp-note" style={{ marginTop: 12 }}>No card tips yet. Print your QR and bring it to your next event.</p>
        ) : (
          <table className="mtp-table">
            <thead><tr><th>Amount</th><th>Date</th><th>Source</th></tr></thead>
            <tbody>
              {tips.map(t => (
                <tr key={t.id}>
                  <td>${(t.amount_cents / 100).toFixed(2)}</td>
                  <td>{new Date(t.tipped_at).toLocaleString()}</td>
                  <td>via Stripe</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Verify the client compiles**

Run:
```bash
cd client && CI=true npx react-scripts build
```
Expected: `Compiled successfully.`

- [ ] **Step 4: Manual verification**

As a staff user at `/my-tip-page`:
- Loading state shows, then the four cards render.
- Copy link works; "Print my QR card" only when `has_stripe_link`; otherwise the not-ready note.
- Add a Cash App handle → Save → it appears in the "what customers see" preview list and on the public tip page.
- "Change payout method" → pick a method → Save → persists after reload and shows in the admin contractor record.
- Tips total + honesty copy present; empty-tips message when none.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/staff/MyTipPage.js client/src/pages/staff/MyTipPage.css
git commit -m "feat(my-tip-page): brand-quality rebuild — handles, payout method, tips on existing endpoints"
```

---

## Task 5: Expose payroll method in the admin override tab

**Files:**
- Modify: `client/src/pages/admin/userDetail/tabs/TipPageTab.js`

`PATCH /admin/contractors/:userId/tip-page` already accepts `preferred_payment_method` (verified in `server/routes/admin/users.js`). Only the admin UI lacks the control. Reuse the existing `edit` buffer + `saveEdits` flow.

- [ ] **Step 1: Add the payroll-method constant**

In `client/src/pages/admin/userDetail/tabs/TipPageTab.js`, find:
```js
export default function TipPageTab({ userId, payment, profile, onChanged }) {
```
Insert immediately above it:
```js
const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];

```

- [ ] **Step 2: Add a derived current value**

Find:
```js
  const venmo = payment?.venmo_handle || '';
  const cashapp = payment?.cashapp_handle || '';
  const paypal = payment?.paypal_url || '';
```
Replace with:
```js
  const venmo = payment?.venmo_handle || '';
  const cashapp = payment?.cashapp_handle || '';
  const paypal = payment?.paypal_url || '';
  const payMethod = payment?.preferred_payment_method || '';
```

- [ ] **Step 3: Add the selector to the Handles card**

Find:
```jsx
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>PayPal URL</div>
                <input
                  className="input"
                  placeholder="https://paypal.me/username"
                  value={edit.paypal_url ?? paypal}
                  onChange={(e) => setEdit(s => ({ ...s, paypal_url: e.target.value }))}
                />
              </div>
            </div>
```
Replace with:
```jsx
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>PayPal URL</div>
                <input
                  className="input"
                  placeholder="https://paypal.me/username"
                  value={edit.paypal_url ?? paypal}
                  onChange={(e) => setEdit(s => ({ ...s, paypal_url: e.target.value }))}
                />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Payroll method (how DRB pays them)</div>
                <select
                  className="input"
                  value={edit.preferred_payment_method ?? payMethod}
                  onChange={(e) => setEdit(s => ({ ...s, preferred_payment_method: e.target.value }))}
                >
                  <option value="">— not set —</option>
                  {PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
```

- [ ] **Step 4: Verify the client compiles**

Run:
```bash
cd client && CI=true npx react-scripts build
```
Expected: `Compiled successfully.`

- [ ] **Step 5: Manual verification**

Admin → a contractor → Tip Page tab: change "Payroll method", Save → it persists (reload), and the same value shows in that contractor's record and on the bartender's My Tip Page.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/userDetail/tabs/TipPageTab.js
git commit -m "feat(admin): payroll-method selector in contractor Tip Page override tab"
```

---

## Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the client utils list**

Run:
```bash
grep -n "buildTipDeepLink" README.md
```
Expected: one or more lines in the folder-structure tree referencing `client/src/utils/`.

- [ ] **Step 2: Add the new util**

In `README.md`, in the `client/src/utils/` section of the folder-structure tree, add a line next to the existing `buildTipDeepLink.js` entry, matching the surrounding indentation/format exactly:

```
│   │   ├── tipCardMarks.js      # derives printable QR-card payment marks from saved handles
```

(Match the tree's actual box-drawing prefix for that level — copy the prefix from the adjacent `buildTipDeepLink.js` line; the comment text above is the content to use.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add tipCardMarks util to README folder structure"
```

---

## Task 7: Full verification

- [ ] **Step 1: Unit tests green**

```bash
cd client && CI=true npx react-scripts test src/utils/tipCardMarks.test.js --watchAll=false
```
Expected: PASS, 6 tests.

- [ ] **Step 2: Production build clean**

```bash
cd client && CI=true npx react-scripts build
```
Expected: `Compiled successfully.` — no errors (this is the same gate Vercel CI / the husky pre-push hook enforces; client lint is only caught here).

- [ ] **Step 3: Run the spec's manual checklist**

From `docs/superpowers/specs/2026-05-17-optional-tip-handles-design.md` §10 — walk every item:
- Onboard with **Check**, no handles → not blocked → finishes.
- Onboard with **Venmo** payroll, no Venmo handle → still blocked (gate intact).
- Onboard with **Direct deposit** + optional Venmo tip handle → finishes; Venmo on page + printed card.
- After onboarding: add Cash App in My Tip Page → on public page; reprint card → Cash App shown; remove it → drops from both.
- My Tip Page: change payout method → persists; visible in admin record.
- Admin TipPageTab: change payroll method → persists.
- Bartender with zero handles + no Stripe link → My Tip Page renders cleanly; printed card is QR-only, no empty logo box.

- [ ] **Step 4: Confirm no server/schema files changed**

```bash
git diff --name-only origin/main..HEAD
```
Expected: only files under `client/`, `README.md`, and `docs/superpowers/`. **Zero** `server/` or `schema.sql` paths. If any server path appears, stop and revert it — the guardrail was violated.

---

## Self-Review

**1. Spec coverage:**
- §5 Onboarding split → Task 3 ✔
- §6 Data-driven QR sign (helper + layouts + PrintTipCard wiring) → Tasks 1, 2 ✔
- §7 My Tip Page rebuild (handles + payout method + tips, brand, states) → Task 4 ✔
- §8 Admin parity → Task 5 ✔
- §4 Server guardrail (untouched) → enforced by Task 3 hard-constraint + Task 7 Step 4 ✔
- §10 Testing (unit + manual checklist) → Tasks 1, 7 ✔
- §9 No schema change → Task 7 Step 4 ✔
- Mandatory docs (new util → README tree) → Task 6 ✔

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step contains complete code. No vague instructions.

**3. Type/name consistency:** `buildTipCardMarks(handles)` defined Task 1, imported Task 2 with the same single-arg shape (`data` from `/me/tip-page` contains `venmo_handle`/`cashapp_handle`/`paypal_url`/`has_stripe_link`). Layout props `marks` (nullable) consistent across `BizCardFrontA`/`FourBySixA`/`FiveBySevenA`. `FEATURE_ROW_MARKS`/`FEATURE_NET_MARKS` defined once (Step 3) and reused (Step 4). `MyTipPage` uses only fields the existing `GET /me/tip-page` returns (`url`, `has_stripe_link`, `preferred_name`, `venmo_handle`, `cashapp_handle`, `paypal_url`, `preferred_payment_method`, `tips_this_month_cents`) and the existing `PATCH` allow-list. `TipPageTab` `edit` keys match the admin route's accepted set (`venmo_handle`, `cashapp_handle`, `paypal_url`, `preferred_payment_method`).

No gaps found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-17-optional-tip-handles.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
