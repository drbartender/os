# Admin UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three independent admin-UI fixes: add `zola`/`instagram`/`other` client sources everywhere (Instagram promoted to a real source but ordered low), show each collapsed-sidebar nav label on hover, and drop the example hint from the refund-reason box.

**Architecture:** Item 1 is a data-sync change across five definition sites plus the DB CHECK constraint. Item 2 is a JS-positioned `position: fixed` tooltip in `Sidebar.js` (pure CSS can't escape the sidebar's double `overflow` clip) styled via one rule in `index.css`. Item 3 is a one-string placeholder edit; the reason stays required on client and server.

**Tech Stack:** React 18 (CRA), vanilla CSS in `index.css`, raw SQL in `schema.sql`, Express route validation.

**Worktree:** None. By the user's decision these run in the `os` window on `main` (the changes are tiny and don't overlap other in-flight work).

**On testing:** These three changes are data-config, a hover/focus visual affordance, and a copy tweak. Unit tests here would be either tautological (asserting an array contains a string) or unable to observe the behavior (hover state, rendered `<option>` list, placeholder text). So each task uses concrete **verification steps** (build + run + observe) instead of TDD. No synthetic tests are invented to satisfy a template.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/utils/clientSources.js` | Canonical source list (feeds `ProposalCreate` dropdown) | add 3 entries (zola, instagram, other), fix the comment |
| `server/routes/clients.js` | Server-side source allow-list | add 3 values to `VALID_SOURCES` |
| `server/db/schema.sql` | DB CHECK constraint on `clients.source` | widen the enum +zola/+instagram/+other (live ALTER + stale inline) |
| `client/src/pages/admin/ClientsDashboard.js` | Local `SOURCE` badge/label map (create dropdown + table) | add zola + other (instagram already present) |
| `client/src/components/adminos/drawers/ClientDrawer.js` | Local `SOURCE` badge/label map (drawer) | add zola + other (instagram already present) |
| `client/src/components/adminos/Sidebar.js` | Sidebar nav; owns rail-mode hover tooltip state | add hover/focus tooltip |
| `client/src/index.css` | All admin-os styling | add `.nav-rail-tip` rule |
| `client/src/pages/admin/ProposalDetailPaymentPanel.js` | Refund form | drop placeholder hint |

---

## Task 1: Add `zola`, `instagram`, `other` client sources

`instagram` already exists as a key in both local `SOURCE` badge maps but was never a valid server/DB source, so picking it in the create form would 400. This task promotes it to a real, accepted source (placed low in the order, since it is low-usage) and adds `zola` + `other`.

**Files:**
- Modify: `client/src/utils/clientSources.js:1-11`
- Modify: `server/routes/clients.js:9`
- Modify: `server/db/schema.sql:780` and `server/db/schema.sql:2618`
- Modify: `client/src/pages/admin/ClientsDashboard.js:19-26`
- Modify: `client/src/components/adminos/drawers/ClientDrawer.js:12-19`

- [ ] **Step 1: Update the canonical list + comment**

Replace the whole of `client/src/utils/clientSources.js` with:

```js
// Canonical client source list. Must match `VALID_SOURCES` in
// server/routes/clients.js, the `clients_source_check` constraint in
// server/db/schema.sql, and the duplicated local `SOURCE` badge maps in
// client/src/pages/admin/ClientsDashboard.js and
// client/src/components/adminos/drawers/ClientDrawer.js.
export const CLIENT_SOURCES = [
  { value: 'direct',    label: 'Direct' },
  { value: 'referral',  label: 'Referral' },
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'zola',      label: 'Zola' },
  { value: 'website',   label: 'Website' },
  { value: 'calcom',    label: 'Cal.com' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'other',     label: 'Other' },
];
```

- [ ] **Step 2: Widen the server allow-list**

In `server/routes/clients.js:9`, change:

```js
const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website', 'calcom'];
```

to:

```js
const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website', 'calcom', 'zola', 'instagram', 'other'];
```

- [ ] **Step 3: Widen the DB CHECK constraint (both copies)**

In `server/db/schema.sql:780` (the stale inline CHECK inside `CREATE TABLE clients` — also still missing `calcom`), change:

```sql
  source VARCHAR(50) DEFAULT 'direct' CHECK (source IN ('direct', 'thumbtack', 'referral', 'website')),
```

to:

```sql
  source VARCHAR(50) DEFAULT 'direct' CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom', 'zola', 'instagram', 'other')),
```

In `server/db/schema.sql:2618` (the authoritative `ALTER ... ADD CONSTRAINT clients_source_check`), change:

```sql
  CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom'))
```

to:

```sql
  CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom', 'zola', 'instagram', 'other'))
```

The surrounding block (`DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT ... NOT VALID` → `VALIDATE CONSTRAINT`) is already idempotent: re-applying drops the old constraint and re-adds it with the widened enum. Widening an `IN (...)` list never rejects existing rows, so `VALIDATE` passes.

- [ ] **Step 4: Add `zola` + `other` to the ClientsDashboard badge map**

In `client/src/pages/admin/ClientsDashboard.js:19-26`, change the `SOURCE` object to (adds `zola` high, `other` last; `instagram` already present, kept low):

```js
const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  zola:      { label: 'Zola',      kind: 'info' },
  calcom:    { label: 'Cal.com',   kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
  other:     { label: 'Other',     kind: 'neutral' },
};
```

(This map drives both the create-client `<select>` at line ~165 and the table badge at line ~215, so both pick up the new options automatically.)

- [ ] **Step 5: Add `zola` + `other` to the ClientDrawer badge map**

In `client/src/components/adminos/drawers/ClientDrawer.js:12-19`, change the `SOURCE` object to:

```js
const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  zola:      { label: 'Zola',      kind: 'info' },
  calcom:    { label: 'Cal.com',   kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
  other:     { label: 'Other',     kind: 'neutral' },
};
```

- [ ] **Step 6: Check ARCHITECTURE.md**

Run: `grep -n "thumbtack" ARCHITECTURE.md`
If a `clients.source` enum is documented there, add `zola`, `instagram`, and `other` to it. If not found, no doc change is needed.

- [ ] **Step 7: Verify the client build**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: build succeeds, no ESLint errors. (CRA build is the only place client lint is enforced.)

- [ ] **Step 8: Verify in the running app (UI level)**

Restart the dev server, open `/clients`. Click "New client" — the Source `<select>` lists Zola, Instagram, and Other. Open an existing client's drawer — a known source still renders its badge. (Actual save of a `zola`/`instagram`/`other` client also requires the widened DB constraint to be live; see "DB constraint note" below.)

- [ ] **Step 9: Commit**

```bash
git add client/src/utils/clientSources.js server/routes/clients.js server/db/schema.sql client/src/pages/admin/ClientsDashboard.js client/src/components/adminos/drawers/ClientDrawer.js
git commit -m "feat(clients): add zola, instagram, and other as client sources"
```

**DB constraint note:** The widened constraint takes effect when `schema.sql` is applied (on deploy). Until then, the shared Neon DB still enforces the old 5-value enum, so creating a `zola`/`instagram`/`other` client will 400 against the live DB even though the dropdown offers it. End-to-end save verification therefore happens post-deploy (or by applying the `ALTER` to Neon manually with approval — it only widens the enum, so it is backward-compatible).

---

## Task 2: Show collapsed-sidebar nav label on hover (styled flyout)

**Files:**
- Modify: `client/src/components/adminos/Sidebar.js`
- Modify: `client/src/index.css` (add one rule near the rail-mode block at ~11170)

**Why JS, not pure CSS:** `.sidebar` is `overflow: hidden` (index.css:11097) and `.sidebar-nav` is `overflow-y: auto` (index.css:11135, which forces `overflow-x` to clip). A CSS `::after` flyout positioned past the rail edge gets clipped by both. A `position: fixed` element positioned from the hovered item's `getBoundingClientRect()` escapes all ancestor overflow.

- [ ] **Step 1: Import `useState`**

In `client/src/components/adminos/Sidebar.js:1`, change:

```js
import React from 'react';
```

to:

```js
import React, { useState } from 'react';
```

- [ ] **Step 2: Add tooltip state + handlers**

In `Sidebar.js`, inside the component after the existing hooks (after `const { prefs, setPref } = useUserPrefs();`, ~line 27), add:

```js
  const [tip, setTip] = useState(null); // { label, top, left } | null
  const rail = prefs.sidebar === 'rail';

  const showTip = (e, label) => {
    if (!rail) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hideTip = () => setTip(null);
```

- [ ] **Step 3: Wire the nav item to the tooltip + give it an accessible name in rail mode**

In `Sidebar.js`, replace the nav-item `<div>` (currently lines ~57-68) with:

```jsx
                <div
                  key={item.id}
                  className={`nav-item ${active ? 'active' : ''}`}
                  onClick={() => { hideTip(); navigate(item.path); }}
                  role="button"
                  tabIndex={0}
                  aria-label={rail ? item.label : undefined}
                  onMouseEnter={(e) => showTip(e, item.label)}
                  onMouseLeave={hideTip}
                  onFocus={(e) => showTip(e, item.label)}
                  onBlur={hideTip}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hideTip(); navigate(item.path); } }}
                >
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                  {count > 0 && <span className="nav-badge">{count}</span>}
                </div>
```

(`aria-label` is set only in rail mode — in full mode the visible `.nav-label` text plus badge already name the control; in rail mode that span is `display:none`, which also hides it from screen readers, so the label restores the accessible name.)

- [ ] **Step 4: Render the fixed tooltip outside the clipped `<aside>`**

In `Sidebar.js`, wrap the returned `<aside>` in a fragment and append the tooltip as a sibling (so it is not inside `.sidebar`'s `overflow: hidden`). Change `return (` ... `</aside>\n  );` to:

```jsx
  return (
    <>
      <aside className="sidebar" id="primary-nav" aria-label="Primary navigation">
        {/* ...existing aside contents unchanged... */}
      </aside>
      {tip && (
        <div className="nav-rail-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      )}
    </>
  );
```

(Keep every existing child of `<aside>` exactly as-is; only the wrapping fragment and the trailing `{tip && ...}` block are new.)

- [ ] **Step 5: Style the tooltip**

In `client/src/index.css`, immediately after the rail nav-label rule (line 11170, `...[data-sidebar="rail"] .nav-label { display: none; }`), add:

```css
html[data-app="admin-os"] .nav-rail-tip {
  position: fixed;
  transform: translateY(-50%);
  z-index: calc(var(--z-sidebar) + 1);
  background: var(--bg-2);
  color: var(--ink-1);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
  padding: 0.3rem 0.55rem;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  box-shadow: var(--shadow-soft);
  pointer-events: none;
}
```

(`--z-sidebar` is 300, overlay/modal/toast are 400/500/600, so `+1` sits just above the rail and below every dialog. The element only exists in rail mode, so the rule needs no rail selector.)

- [ ] **Step 6: Verify the client build**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: build succeeds, no ESLint errors (no unused vars, hooks rules satisfied).

- [ ] **Step 7: Verify in the running app**

Restart the dev server, open the admin OS. Collapse the sidebar (footer chevron). Hover each icon: a pill slides out to the right showing the label, vertically centered on the icon, not clipped at the sidebar edge. Move away: it disappears. Tab through the nav with the keyboard: the pill appears on focus. Toggle House Lights / After Hours: the pill is legible in both skins.
**Contingency:** If the pill is clipped or offset (only happens if some ancestor has a `transform`/`filter` creating a containing block for `fixed`), switch Step 4 to render via `import { createPortal } from 'react-dom'` → `createPortal(<div className="nav-rail-tip" .../>, document.body)`.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/adminos/Sidebar.js client/src/index.css
git commit -m "feat(adminos): show nav label on hover when sidebar is collapsed"
```

---

## Task 3: Drop the example hint from the refund-reason box

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js:398`

The reason stays **required** — client guard at line 91 (`'A reason is required.'`) and server guard in `server/routes/stripe.js:564` (`REASON_REQUIRED`) are unchanged. Only the placeholder hint changes.

- [ ] **Step 1: Edit the placeholder**

In `client/src/pages/admin/ProposalDetailPaymentPanel.js:398`, change:

```jsx
                  <textarea className="input" placeholder="Reason (e.g. second bartender no-show)"
```

to:

```jsx
                  <textarea className="input" placeholder="Reason"
```

- [ ] **Step 2: Verify in the running app**

Open a proposal with payments → "Issue refund". The reason box placeholder reads "Reason". Enter an amount, leave the reason blank, click "Confirm refund": the toast still says "A reason is required." (requirement intact).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js
git commit -m "fix(refunds): simplify the refund reason placeholder"
```

---

## Observations / out-of-scope flags

1. **Client source is defined in 5 places.** `clientSources.js` claims to be canonical, but `ClientsDashboard.js` and `ClientDrawer.js` each keep their own `SOURCE` map (with badge `kind`), and `ProposalCreate.js` imports the canonical list. A future DRY pass could fold the badge `kind` into `clientSources.js` and have both maps derive from it. Not done here to keep scope to the source additions. **Note:** the two dropdowns are not order-synced — `ProposalCreate` follows `CLIENT_SOURCES` order, while the `ClientsDashboard` create `<select>` follows its local `SOURCE` map order. Both now include all sources; exact order parity is left to the future DRY pass.

---

## Self-Review

- **Spec coverage:** Item 1 (zola/instagram/other, Instagram low) → Task 1 (all 5 sites + constraint; Instagram promoted and ordered low). Item 2 (label on hover, option B styled flyout) → Task 2. Item 3 (drop the reason hint, keep required) → Task 3. All three covered.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code.
- **Type/name consistency:** `tip` shape `{ label, top, left }` is set in `showTip` and read in the render identically. `rail` defined once, used in `showTip`/`aria-label`. `.nav-rail-tip` class name matches between Sidebar render and CSS rule. `CLIENT_SOURCES` value strings (`zola`, `instagram`, `other`) match `VALID_SOURCES`, the CHECK enum (both copies), and both `SOURCE` map keys.
