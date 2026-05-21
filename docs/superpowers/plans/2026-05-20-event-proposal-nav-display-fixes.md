# Event & Proposal Navigation/Display Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a drawer back-navigation loop and a payment-terms display contradiction, and add Google Maps address links plus a clickable proposal client name, across the admin Event and Proposal screens.

**Architecture:** Seven client-side file changes plus one new shared component (`AddressLink`). No server, schema, or API changes. Fix 1 flips drawer URL-state from history-push to history-replace in one hook. Fix 4 wires an existing server policy flag into a second display surface. Fixes 2 and 3 reuse existing UI patterns.

**Tech Stack:** React 18 (Create React App), React Router 6, vanilla CSS in `client/src/index.css`.

---

## Testing approach

This codebase has no UI test suite. Per the design spec, verification is manual in-app testing plus a client production build. Each task below ends with manual verification steps and a commit; a final build check runs once at the end.

Do **not** add Jest or React Testing Library tests for these tasks: the codebase reserves `.test.js` files for pure logic (for example `packageGaps.test.js`), and every change here is UI wiring. Adding test infrastructure the codebase does not use would be scope creep.

The dev server is a Claude-managed background process and hot-reloads client edits, so no restart is needed for any task. In-app verification is performed against that running dev server.

---

## File structure

**New:**

- `client/src/components/adminos/AddressLink.js` — renders an address string as a Google Maps search link; renders a fallback placeholder when the address is empty.

**Modified:**

- `client/src/hooks/useDrawerParam.js` — drawer URL state replaces the history entry instead of pushing a new one.
- `client/src/index.css` — `.address-link` style.
- `client/src/pages/admin/EventDetailPage.js` — event address as a Maps link.
- `client/src/pages/admin/EventsDashboard.js` — location column as a Maps link.
- `client/src/pages/admin/ProposalDetail.js` — event address as a Maps link, and a clickable client name in the title.
- `client/src/pages/proposal/proposalView/ProposalView.js` — pass the full-payment-required flag to the pricing breakdown.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` — collapse the Payment Terms box to one row when full payment is required.
- `README.md` — list `AddressLink` in the components tree.

Each of the four tasks is one logical feature and produces exactly one commit.

---

## Task 1: Fix the drawer back-navigation loop

**Files:**

- Modify: `client/src/hooks/useDrawerParam.js:20-32`

- [ ] **Step 1: Replace the `open` and `close` callbacks**

In `client/src/hooks/useDrawerParam.js`, replace the existing `open` and `close` callback definitions:

```js
  const open = useCallback((newKind, newId) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    setParams(next, { replace: false });
  }, [params, setParams]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('drawer');
    next.delete('drawerId');
    setParams(next, { replace: false });
  }, [params, setParams]);
```

with this version (both `setParams` calls change to `replace: true`, plus an explanatory comment):

```js
  // Drawer open/close REPLACES the current history entry instead of pushing a
  // new one. A drawer is page state, not a navigation. Pushing made every open
  // and every close stack a history entry, so the Back button walked through
  // drawer-toggle states (re-opening drawers in a loop) instead of returning
  // to the previous page. Keep both `replace: true`.
  const open = useCallback((newKind, newId) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    setParams(next, { replace: true });
  }, [params, setParams]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('drawer');
    next.delete('drawerId');
    setParams(next, { replace: true });
  }, [params, setParams]);
```

- [ ] **Step 2: Manual verification**

On the dev server, in the admin app:
1. Open an event (`/events/:id`). Open and close the Staffing shift drawer two or three times. Click the page's Back button once. Expected: you land on the Events list (`/events`) immediately, no drawer open.
2. On the Events dashboard, open the Invoices drawer (row kebab menu → "View Invoices/Payments"), close it, then open an event row and click Back. Expected: you land on the Events list, with no Invoices drawer reappearing.

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useDrawerParam.js
git commit -m "fix: drawer state replaces history so Back exits the page instead of looping"
```

---

## Task 2: Link event addresses to Google Maps

**Files:**

- Create: `client/src/components/adminos/AddressLink.js`
- Modify: `client/src/index.css` (after the `.event-client-link` rule, around line 11635)
- Modify: `client/src/pages/admin/EventDetailPage.js` (import; line 218)
- Modify: `client/src/pages/admin/EventsDashboard.js` (import; line 414)
- Modify: `client/src/pages/admin/ProposalDetail.js` (import; line 339)
- Modify: `README.md:226`

- [ ] **Step 1: Create the `AddressLink` component**

Create `client/src/components/adminos/AddressLink.js` with this exact content:

```jsx
import React from 'react';

// Renders an address as a Google Maps search link that opens in a new tab.
// Used wherever an event address is shown in the admin UI. When `address` is
// empty, renders `fallback` instead. The anchor calls stopPropagation on click
// as a defensive guard so a link click does not bubble to a clickable parent.
export default function AddressLink({ address, fallback = '—' }) {
  const text = typeof address === 'string' ? address.trim() : '';
  if (!text) return fallback;
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="address-link"
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </a>
  );
}
```

- [ ] **Step 2: Add the `.address-link` style**

In `client/src/index.css`, immediately after the `.event-client-link:hover, .event-client-link:focus-visible { ... }` rule (around line 11635, just before the `/* Metrics filter bar */` comment), add:

```css

/* Inline event address rendered as a Google Maps link — inherits the
   surrounding text, underlines on hover/focus. */
.address-link {
  color: inherit;
  text-decoration: none;
}
.address-link:hover,
.address-link:focus-visible {
  text-decoration: underline;
  text-underline-offset: 3px;
}
```

- [ ] **Step 3: Wire `AddressLink` into EventDetailPage**

In `client/src/pages/admin/EventDetailPage.js`, add an import after the existing `BackButton` import (line 20):

```js
import AddressLink from '../../components/adminos/AddressLink';
```

Then in the identity-bar muted line, replace line 218:

```jsx
              {proposal.event_location && ` · ${proposal.event_location}`}
```

with:

```jsx
              {proposal.event_location && <>{' · '}<AddressLink address={proposal.event_location} /></>}
```

- [ ] **Step 4: Wire `AddressLink` into EventsDashboard**

In `client/src/pages/admin/EventsDashboard.js`, add an import after the existing `shifts` import (line 20):

```js
import AddressLink from '../../components/adminos/AddressLink';
```

Then in the `EventRow` table, replace line 414:

```jsx
      <td className="muted">{e.location || '—'}</td>
```

with:

```jsx
      <td className="muted"><AddressLink address={e.location} /></td>
```

- [ ] **Step 5: Wire `AddressLink` into ProposalDetail**

In `client/src/pages/admin/ProposalDetail.js`, add an import after the existing `BackButton` import (line 17):

```js
import AddressLink from '../../components/adminos/AddressLink';
```

Then in the Event card, replace the Location row at line 339:

```jsx
                    <dt>Location</dt><dd>{proposal.event_location || '—'}</dd>
```

with:

```jsx
                    <dt>Location</dt><dd><AddressLink address={proposal.event_location} /></dd>
```

- [ ] **Step 6: Document the new component in README**

In `README.md`, on the `adminos/` description line (line 226), add `AddressLink` to the primitives list. Replace:

```
│   │   │   │                   # StatusChip, StaffPills, AreaChart, Sparkline, Toolbar, Icon, KebabMenu,
```

with:

```
│   │   │   │                   # StatusChip, StaffPills, AreaChart, Sparkline, Toolbar, Icon, KebabMenu, AddressLink,
```

- [ ] **Step 7: Manual verification**

On the dev server:
1. Event detail page: the address in the header is a link; clicking it opens Google Maps in a new tab searching that address.
2. Events dashboard: the Location column shows addresses as links; clicking one opens Maps and does NOT also open the event row.
3. Proposal detail page: the Event card's Location field is a link.
4. An event or proposal with no address shows the `—` placeholder on each page.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/adminos/AddressLink.js client/src/index.css client/src/pages/admin/EventDetailPage.js client/src/pages/admin/EventsDashboard.js client/src/pages/admin/ProposalDetail.js README.md
git commit -m "feat: link event addresses to Google Maps on event and proposal screens"
```

---

## Task 3: Clickable client name on the Proposal detail page

**Files:**

- Modify: `client/src/pages/admin/ProposalDetail.js:237-239`

- [ ] **Step 1: Make the title client name a link**

In `client/src/pages/admin/ProposalDetail.js`, replace the identity-bar H1 (lines 237-239):

```jsx
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                {proposal.client_name || `Proposal #${proposal.id}`}
              </h1>
```

with:

```jsx
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                {proposal.client_id ? (
                  <button
                    type="button"
                    className="event-client-link"
                    onClick={() => navigate(`/clients/${proposal.client_id}`)}
                    title="Open client"
                  >
                    {proposal.client_name || `Proposal #${proposal.id}`}
                  </button>
                ) : (proposal.client_name || `Proposal #${proposal.id}`)}
              </h1>
```

`navigate` is already imported and in scope (`ProposalDetail.js:47`). The `event-client-link` CSS class already exists in `index.css`. This mirrors the existing pattern at `EventDetailPage.js:196-205`. The separate "Open client" button in the Client card (`ProposalDetail.js:301-306`) is left as-is.

- [ ] **Step 2: Manual verification**

On the dev server:
1. Open a proposal with a linked client. The title is clickable and opens that client's detail page (`/clients/:id`).
2. Open a proposal with no client (if one exists). The title shows `Proposal #<id>` as plain, non-clickable text.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat: make the proposal client name a link to the client file"
```

---

## Task 4: Payment Terms box honors full-payment-required

**Files:**

- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:6-15` and `:162-175`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js:361-370`

- [ ] **Step 1: Add the `fullPaymentRequired` prop to `ProposalPricingBreakdown`**

In `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`, replace the component signature (lines 6-15):

```jsx
export default function ProposalPricingBreakdown({
  proposal,
  includes,
  lineItems,
  snapshot,
  balanceAmount,
  balanceDueDate,
  showSignAndPay,
  showPayOnly,
}) {
```

with:

```jsx
export default function ProposalPricingBreakdown({
  proposal,
  includes,
  lineItems,
  snapshot,
  balanceAmount,
  balanceDueDate,
  fullPaymentRequired,
  showSignAndPay,
  showPayOnly,
}) {
```

- [ ] **Step 2: Make the Payment Terms rows conditional**

In the same file, replace the payment-summary block (lines 162-175):

```jsx
        <div style={styles.paymentSummary}>
          <div style={styles.paymentRow}>
            <span style={styles.paymentLabel}>Deposit Due at Signing</span>
            <span style={styles.paymentValue}>{fmt(DEPOSIT_DOLLARS)}</span>
          </div>
          <div style={styles.paymentRow}>
            <span style={styles.paymentLabel}>Remaining Balance</span>
            <span style={styles.paymentValue}>{fmt(balanceAmount)}</span>
          </div>
          <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
            <span style={styles.paymentLabel}>Balance Due By</span>
            <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
          </div>
        </div>
```

with:

```jsx
        <div style={styles.paymentSummary}>
          {fullPaymentRequired ? (
            <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
              <span style={styles.paymentLabel}>Full Payment Due</span>
              <span style={styles.paymentValue}>{snapshot ? fmt(snapshot.total) : '—'}</span>
            </div>
          ) : (
            <>
              <div style={styles.paymentRow}>
                <span style={styles.paymentLabel}>Deposit Due at Signing</span>
                <span style={styles.paymentValue}>{fmt(DEPOSIT_DOLLARS)}</span>
              </div>
              <div style={styles.paymentRow}>
                <span style={styles.paymentLabel}>Remaining Balance</span>
                <span style={styles.paymentValue}>{fmt(balanceAmount)}</span>
              </div>
              <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
                <span style={styles.paymentLabel}>Balance Due By</span>
                <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
              </div>
            </>
          )}
        </div>
```

- [ ] **Step 3: Pass the flag from `ProposalView`**

In `client/src/pages/proposal/proposalView/ProposalView.js`, replace the `<ProposalPricingBreakdown>` element (lines 361-370):

```jsx
            <ProposalPricingBreakdown
              proposal={proposal}
              includes={includes}
              lineItems={lineItems}
              snapshot={snapshot}
              balanceAmount={balanceAmount}
              balanceDueDate={balanceDueDate}
              showSignAndPay={showSignAndPay}
              showPayOnly={showPayOnly}
            />
```

with:

```jsx
            <ProposalPricingBreakdown
              proposal={proposal}
              includes={includes}
              lineItems={lineItems}
              snapshot={snapshot}
              balanceAmount={balanceAmount}
              balanceDueDate={balanceDueDate}
              fullPaymentRequired={fullPaymentRequired}
              showSignAndPay={showSignAndPay}
              showPayOnly={showPayOnly}
            />
```

`fullPaymentRequired` is already computed at `ProposalView.js:314` (`const fullPaymentRequired = !!policy.full_payment_required;`) and is in scope here. This mirrors how the same flag is already passed to `<SignAndPaySection>`.

- [ ] **Step 4: Manual verification**

On the dev server, view the public proposal page (`/proposal/:token`; the admin proposal page's "Preview as client" button opens it):
1. For a proposal whose event is 14 days away or less, the Payment Terms section shows a single "Full Payment Due" row with the event total, matching the Sign & Pay button amount.
2. For a proposal whose event is more than 14 days away, the Payment Terms section still shows three rows: Deposit Due at Signing, Remaining Balance, Balance Due By.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
git commit -m "fix: proposal payment terms show full amount due inside the deposit window"
```

---

## Final check

- [ ] **Run the client production build**

After all four tasks are committed, run the client production build to confirm no compile or lint errors (the pre-push hook gates this anyway):

```bash
CI=true npm --prefix client run build
```

Expected: `Compiled successfully.` and exit code 0. With `CI=true`, lint warnings fail the build. If it fails, fix the reported issue and add a follow-up commit for the fix.

---

## Self-review

Checked against the spec (`docs/superpowers/specs/2026-05-20-event-proposal-nav-display-fixes-design.md`):

- **Spec coverage:** Fix 1 → Task 1. Fix 2 (AddressLink + three pages + README) → Task 2. Fix 3 → Task 3. Fix 4 → Task 4. The `.address-link` CSS in Task 2 implements the spec's "subtle link styling" requirement (the spec's file list named the styling behavior but not `index.css` explicitly; the plan includes it).
- **Placeholders:** none. Every code step contains complete code.
- **Type consistency:** the `fullPaymentRequired` prop name matches between `ProposalView` (passes it) and `ProposalPricingBreakdown` (destructures it). `AddressLink` props (`address`, `fallback`) are consistent across the component and all three call sites.
