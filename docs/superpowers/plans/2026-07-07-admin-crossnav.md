---
spec: docs/superpowers/specs/2026-07-07-admin-crossnav-design.md
lanes:
  - id: crossnav-a-primitives
    footprint:
      - client/src/components/EntityLink.js
      - client/src/components/EntityLink.test.js
      - client/src/hooks/useUrlListState.js
      - client/src/hooks/useUrlListState.test.js
      - client/src/hooks/useDrawerParam.js
      - client/src/components/ScrollToTop.js
      - client/src/index.css
      - client/src/components/adminos/CommandPalette.js
      - client/src/components/adminos/PresenceStrip.js
      - client/src/components/adminos/drawers/PresenceDrawer.js
      - README.md
    blockedBy: []
    review: light        # shell + new pure client primitives, no money/auth/data surface
  - id: crossnav-b-events
    footprint:
      - client/src/pages/admin/EventsDashboard.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/Dashboard.js
      - client/src/components/adminos/drawers/ShiftDrawer.js
      - server/routes/shifts.queries.js
    blockedBy: [crossnav-a-primitives]
    review: standard     # one read-only SELECT alias in shifts.queries.js (not on sensitive list)
  - id: crossnav-c-proposals-clients
    footprint:
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/ProposalDetailEditForm.js
      - client/src/pages/admin/ProposalCreate.js
      - client/src/pages/admin/AlternativesPanel.js
      - client/src/pages/admin/ChangeRequestsDashboard.js
      - client/src/pages/admin/ClientsDashboard.js
      - client/src/pages/admin/ClientDetail.js
      - client/src/pages/admin/CcImportReviewPage.js
      - client/src/pages/admin/CcImportWrapUpPage.js
      - server/routes/clients.js
    blockedBy: [crossnav-a-primitives]
    review: standard     # clients.js touch is only-if-needed read flag; escalate to full-fleet if any money field moves
  - id: crossnav-d-money
    footprint:
      - client/src/pages/admin/payroll/PayrollPage.js
      - client/src/pages/admin/payroll/HistoryView.js
      - client/src/pages/admin/payroll/PayoutRow.js
      - client/src/pages/admin/payroll/EventLineItem.js
      - client/src/pages/admin/payroll/DeferredTipsPanel.js
      - client/src/pages/admin/payroll/UnassignedTipsPanel.js
      - client/src/pages/admin/payroll/PayQRModal.js
      - client/src/pages/admin/FinancialsDashboard.js
      - client/src/pages/admin/StripePayoutsTab.js
      - client/src/pages/admin/TipsAdmin.js
      - client/src/components/InvoiceDropdown.js
      - client/src/components/adminos/drawers/InvoicesDrawer.js
      - server/routes/proposals/metadata.js
      - server/routes/admin/payroll.js
      - server/routes/stripePayouts.js
    blockedBy: [crossnav-a-primitives]
    review: full-fleet   # money surfaces (payroll/financials/payouts); read .claude/seam-sweep-2026-07-02.md before touching these routes
  - id: crossnav-e-staffing
    footprint:
      - client/src/pages/admin/StaffDashboard.js
      - client/src/pages/admin/HiringDashboard.js
      - client/src/pages/AdminDashboard.js
      - client/src/pages/admin/userDetail/AdminUserDetail.js
      - client/src/pages/admin/userDetail/tabs/OverviewTab.js
      - client/src/pages/admin/userDetail/tabs/ShiftsTab.js
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js
      - client/src/pages/admin/userDetail/tabs/MessagesTab.js
      - client/src/pages/admin/userDetail/tabs/ApplicationTab.js
      - client/src/pages/admin/userDetail/components/AssignToEventModal.js
      - client/src/pages/admin/applicationDetail/AdminApplicationDetail.js
      - client/src/components/adminos/InterviewScheduleModal.js
    blockedBy: [crossnav-a-primitives]
    review: standard     # client-only, zero server files
  - id: crossnav-f-comms
    footprint:
      - client/src/pages/admin/EmailLeadsDashboard.js
      - client/src/pages/admin/EmailLeadDetail.js
      - client/src/pages/admin/EmailCampaignDetail.js
      - client/src/pages/admin/EmailConversations.js
      - client/src/pages/admin/Messages.js
      - client/src/pages/admin/DrinkPlansDashboard.js
      - client/src/pages/admin/DrinkPlanDetail.js
      - client/src/components/DrinkPlanCard.js
      - client/src/components/AudienceSelector.js
      - server/routes/drinkPlans.js
      - server/routes/emailMarketing.js
    blockedBy: [crossnav-a-primitives]
    review: standard     # emailMarketing.js touch is verify-first; sms.js is deliberately NOT touched (sensitive)
---

# Admin Cross-Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every entity referenced on an admin screen a real link to that entity's canonical page, with Back restoring the exact prior view (tab + filters in URL, native scroll restoration).

**Architecture:** Lane A ships three primitives (EntityLink, useUrlListState, ScrollToTop POP guard) plus a drawer-href helper, then five parallel surface lanes sweep their screens: wrap the spec appendix's finding list in links, adopt URL view state, and add seven read-only SELECT columns where the payload lacks an id. No schema changes, no new pages, no route-table changes.

**Tech Stack:** React 18 + React Router 6 (useSearchParams, useNavigationType), RTL + jest-dom for client tests (MemoryRouter harness style, see BackButton.test.js), raw SQL via pool.query on the server.

## Global Constraints

- **The spec appendix is the work list.** Every row of `docs/superpowers/specs/2026-07-07-admin-crossnav-design.md` Appendix for your lane MUST be resolved; every "Skipped (approved cuts)" row MUST be left alone. Line numbers in the appendix were captured 2026-07-07; re-locate by the quoted display expression if drift has occurred.
- LabRat surfaces are untouched (feature being removed).
- Self-references never link (the entity a page is about).
- No em dashes in any rendered copy or spec/plan prose.
- All new/edited SQL stays parameterized; additions are SELECT-column aliases only, never new write paths. Lane D reads `.claude/seam-sweep-2026-07-02.md` before editing its three server files.
- API JSON keys snake_case; client goes through `client/src/utils/api.js`.
- Lane worktrees do not carry `.env`: after cutting a lane run `ln -sf ../../os/.env <worktree>/.env`.
- In-lane commits are checkpoints (squashed at merge): explicit pathspec always, never `git add .`.
- Client gate per lane: `cd client && CI=true npx react-scripts build` passes (Vercel parity; local lint skips client/).
- Server suites (lanes B/D/F if extended) run ALONE, one at a time: `node --test <file>` with `-r dotenv/config` where the suite needs the dev DB.
- Dev server is a Claude-managed background process and does NOT auto-reload server edits: after touching `server/`, kill the :5000 listener, relaunch, confirm boot lines.
- `useUrlListState` defaults objects are declared at module scope (stable identity), never inline in the component body.
- Keys/param names are part of the URL contract and exactly as specified in the spec table (tab, q, status, source, sort, page, period, client, thread, basis, from, to, include_cc); the pay-period deep link is exactly `/financials/payroll?tab=history&period=<id>`.

---

### Task 1 (Lane A): EntityLink component + styles

**Files:**
- Create: `client/src/components/EntityLink.js`
- Create: `client/src/components/EntityLink.test.js`
- Modify: `client/src/index.css` (append to the components section)

**Interfaces:**
- Produces: `EntityLink({ to, className, children, ...rest })` default export. `to` nullish renders children unlinked (plain fragment); otherwise a react-router `<Link>` with class `entity-link` (plus any passed className). All surface lanes consume this exact contract, including the null-`to` fallback for legacy rows missing an id.

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/components/EntityLink.test.js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EntityLink from './EntityLink';

test('renders a real anchor with entity-link class and href', () => {
  render(
    <MemoryRouter>
      <EntityLink to="/staffing/users/7">Zul Ahmed</EntityLink>
    </MemoryRouter>
  );
  const a = screen.getByRole('link', { name: 'Zul Ahmed' });
  expect(a).toHaveAttribute('href', '/staffing/users/7');
  expect(a).toHaveClass('entity-link');
});

test('nullish to renders children without an anchor', () => {
  render(
    <MemoryRouter>
      <EntityLink to={null}>Walk-in Client</EntityLink>
    </MemoryRouter>
  );
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Walk-in Client')).toBeInTheDocument();
});

test('merges extra className', () => {
  render(
    <MemoryRouter>
      <EntityLink to="/clients/3" className="event-client-link">Jane</EntityLink>
    </MemoryRouter>
  );
  expect(screen.getByRole('link')).toHaveClass('entity-link', 'event-client-link');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx react-scripts test --watchAll=false EntityLink.test.js`
Expected: FAIL, cannot find module './EntityLink'

- [ ] **Step 3: Implement**

```jsx
// client/src/components/EntityLink.js
import React from 'react';
import { Link } from 'react-router-dom';

// Inline reference to another entity (a name in a card header, a roster row,
// a timeline item, a drawer body): a real anchor, so cmd/ctrl/middle-click
// open a new tab natively. Visual stays quiet (inherits color, hover
// underline) so admin surfaces don't sprout blue links. Nullish `to` (legacy
// rows with no id) renders the children unlinked instead of a dead anchor.
export default function EntityLink({ to, className = '', children, ...rest }) {
  if (!to) return <>{children}</>;
  return (
    <Link to={to} className={`entity-link${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </Link>
  );
}
```

Append to `client/src/index.css`:

```css
/* EntityLink: quiet inline entity reference (admin cross-nav) */
.entity-link { color: inherit; text-decoration: none; }
.entity-link:hover,
.entity-link:focus-visible { text-decoration: underline; text-underline-offset: 2px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx react-scripts test --watchAll=false EntityLink.test.js`
Expected: 3 passed

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/components/EntityLink.js client/src/components/EntityLink.test.js client/src/index.css
git commit -m "feat(crossnav): EntityLink inline entity reference"
```

---

### Task 2 (Lane A): useUrlListState hook

**Files:**
- Create: `client/src/hooks/useUrlListState.js`
- Create: `client/src/hooks/useUrlListState.test.js`

**Interfaces:**
- Produces: `useUrlListState(defaults)` default export returning `[state, setState]`. `state` mirrors the declared keys (string values; missing/empty param = default). `setState(patch)` writes only declared keys, deletes params equal to their default (or empty/nullish), always with `{ replace: true }`, and never touches undeclared params (drawer/drawerId pass through). Values are plain strings; enum clamping is caller-side: `const tab = TABS.includes(state.tab) ? state.tab : DEFAULTS.tab`.

- [ ] **Step 1: Write the failing test**

```jsx
// client/src/hooks/useUrlListState.test.js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import useUrlListState from './useUrlListState';

const DEFAULTS = { tab: 'upcoming', q: '' };

function Harness() {
  const [state, setState] = useUrlListState(DEFAULTS);
  const loc = useLocation();
  return (
    <div>
      <div data-testid="tab">{state.tab}</div>
      <div data-testid="q">{state.q}</div>
      <div data-testid="search">{loc.search}</div>
      <button onClick={() => setState({ tab: 'past' })}>past</button>
      <button onClick={() => setState({ tab: 'upcoming' })}>reset-tab</button>
      <button onClick={() => setState({ q: 'ketan' })}>type</button>
    </div>
  );
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Harness />
    </MemoryRouter>
  );
}

test('reads defaults when params absent, and param values when present', () => {
  renderAt('/events?tab=past&drawer=shift&drawerId=9');
  expect(screen.getByTestId('tab')).toHaveTextContent('past');
  expect(screen.getByTestId('q')).toHaveTextContent('');
});

test('setState writes non-defaults and omits defaults from the URL', () => {
  renderAt('/events');
  fireEvent.click(screen.getByText('past'));
  expect(screen.getByTestId('search')).toHaveTextContent('?tab=past');
  fireEvent.click(screen.getByText('reset-tab'));
  expect(screen.getByTestId('search')).toHaveTextContent('');
});

test('preserves undeclared params (drawer passthrough)', () => {
  renderAt('/events?drawer=shift&drawerId=9');
  fireEvent.click(screen.getByText('type'));
  const s = screen.getByTestId('search').textContent;
  expect(s).toContain('drawer=shift');
  expect(s).toContain('drawerId=9');
  expect(s).toContain('q=ketan');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx react-scripts test --watchAll=false useUrlListState.test.js`
Expected: FAIL, cannot find module './useUrlListState'

- [ ] **Step 3: Implement**

```jsx
// client/src/hooks/useUrlListState.js
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-backed view state for admin list/dashboard screens (admin cross-nav
// spec). Declared keys only; anything else in the query string (drawer,
// drawerId) passes through untouched. Defaults are omitted from the URL so
// /events stays /events, and every write replaces the history entry so
// typing and filter flips never create Back stops: Back always crosses
// pages, never filter states. `defaults` must be a module-scope constant
// (stable identity).
export default function useUrlListState(defaults) {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => {
    const out = {};
    for (const key of Object.keys(defaults)) {
      const raw = searchParams.get(key);
      out[key] = raw === null || raw === '' ? defaults[key] : raw;
    }
    return out;
  }, [searchParams, defaults]);

  const setState = useCallback((patch) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in defaults)) continue;
        if (value === undefined || value === null || value === '' || String(value) === String(defaults[key])) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      return next;
    }, { replace: true });
  }, [setSearchParams, defaults]);

  return [state, setState];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx react-scripts test --watchAll=false useUrlListState.test.js`
Expected: 3 passed

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/hooks/useUrlListState.js client/src/hooks/useUrlListState.test.js
git commit -m "feat(crossnav): useUrlListState URL-backed view state hook"
```

---

### Task 3 (Lane A): ScrollToTop POP guard + drawerHref helper

**Files:**
- Modify: `client/src/components/ScrollToTop.js`
- Modify: `client/src/hooks/useDrawerParam.js` (add named export)

**Interfaces:**
- Produces: `drawerHref(searchParams, kind, id)` named export from `client/src/hooks/useDrawerParam.js`, returning a `?`-prefixed search string that merges `drawer=<kind>&drawerId=<id>` into the current params. Lanes B and D consume it to build real links to drawers.

- [ ] **Step 1: Guard ScrollToTop against POP navigations**

Replace the component body:

```jsx
// client/src/components/ScrollToTop.js
import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Resets scroll to top on every route-pathname change. Yields to hash-anchor
// navigation (e.g. /#services) so PublicLayout's scrollIntoView can win, and
// to POP (Back/Forward) so the browser's native scroll restoration works:
// returning to a long admin list lands where you left it.
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (hash) return;
    if (navigationType === 'POP') return;
    window.scrollTo(0, 0);
  }, [pathname, hash, navigationType]);
  return null;
}
```

- [ ] **Step 2: Add drawerHref to useDrawerParam.js**

Append (keeping the existing default export untouched):

```jsx
// Builds a same-page href that opens a drawer, preserving all other query
// params. Real links (cmd-click new tab) instead of onClick drawer.open.
export function drawerHref(searchParams, kind, id) {
  const next = new URLSearchParams(searchParams);
  next.set('drawer', kind);
  next.set('drawerId', String(id));
  return `?${next.toString()}`;
}
```

- [ ] **Step 3: Verify nothing regressed**

Run: `cd client && npx react-scripts test --watchAll=false BackButton.test.js && CI=true npx react-scripts build`
Expected: BackButton suite passes; build succeeds with zero ESLint warnings.

- [ ] **Step 4: Checkpoint commit**

```bash
git add client/src/components/ScrollToTop.js client/src/hooks/useDrawerParam.js
git commit -m "feat(crossnav): ScrollToTop POP guard + drawerHref helper"
```

---

### Task 4 (Lane A): shell coverage (CommandPalette, PresenceStrip, PresenceDrawer) + README

**Files:**
- Modify: `client/src/components/adminos/CommandPalette.js:128` (pattern-upgrade)
- Modify: `client/src/components/adminos/PresenceStrip.js:89` and `:126` (staff names -> EntityLink)
- Modify: `client/src/components/adminos/drawers/PresenceDrawer.js:47` and `:70` (staff names -> EntityLink)
- Modify: `README.md` (folder tree: EntityLink.js, useUrlListState.js)

**Interfaces:**
- Consumes: `EntityLink` (Task 1).

- [ ] **Step 1: CommandPalette results become real links**

At `CommandPalette.js:128` the result rows navigate via `PATH_BY_TYPE[it.type] + '/' + it.id` in an onClick. Wrap each result row's label in `<EntityLink to={PATH_BY_TYPE[it.type] + '/' + it.id}>` (or convert the row wrapper to a Link if the row is a plain div), keep the existing keyboard-selection behavior (Enter still navigates via the existing handler), and make sure the palette closes on plain click (add the existing close() to the link's onClick without preventing default).

- [ ] **Step 2: Presence staff names link to profiles**

In `PresenceStrip.js` (lines 89 and 126) and `PresenceDrawer.js` (lines 47 and 70), wrap the rendered staff display name in `<EntityLink to={'/staffing/users/' + <the row's user id>}>name</EntityLink>`. Use the id field already present in each payload row (the strip/drawer rows are keyed by user id). Do not link the viewing admin's own row differently: all rows link (a profile is not a self-reference for the strip).

- [ ] **Step 3: README folder tree**

Add `EntityLink.js` under components and `useUrlListState.js` under hooks in the folder-structure tree.

- [ ] **Step 4: Verify + checkpoint commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: clean build. Then:

```bash
git add client/src/components/adminos/CommandPalette.js client/src/components/adminos/PresenceStrip.js client/src/components/adminos/drawers/PresenceDrawer.js README.md
git commit -m "feat(crossnav): shell entity links (palette, presence)"
```

---

### Task 5 (Lane B): events URL state

**Files:**
- Modify: `client/src/pages/admin/EventsDashboard.js`

**Interfaces:**
- Consumes: `useUrlListState` (Task 2).

- [ ] **Step 1: Adopt URL state**

At module scope: `const LIST_DEFAULTS = { tab: 'upcoming', q: '', status: '' };` and inside the component replace the three `useState` view-state hooks (search, tab, statusFilter) with:

```jsx
const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
const tab = ['upcoming', 'unstaffed', 'past', 'all'].includes(listState.tab) ? listState.tab : 'upcoming';
const search = listState.q;
const statusFilter = listState.status;
```

Every former `setTab(x)` becomes `setListState({ tab: x })`, `setSearch(v)` becomes `setListState({ q: v })`, `setStatusFilter(v)` becomes `setListState({ status: v })`. The create-form draft state stays local useState (not view state). Drawer params keep working untouched (hook passthrough).

- [ ] **Step 2: Verify by hand**

Dev server click-through: set tab Past + a search string, open an event, press Back. Expected: URL shows `?tab=past&q=...` before navigating, and Back restores both. Typing in search must NOT grow history (Back from the list leaves the admin area in one step).

- [ ] **Step 3: Checkpoint commit**

```bash
git add client/src/pages/admin/EventsDashboard.js
git commit -m "feat(crossnav): events dashboard URL view state"
```

---

### Task 6 (Lane B): events + home link coverage (+ shift payload client_id)

**Files:**
- Modify: `client/src/pages/admin/EventsDashboard.js:512`, `client/src/pages/admin/EventDetailPage.js` (194, 201, 339, 382), `client/src/pages/admin/Dashboard.js` (306, 308), `client/src/components/adminos/drawers/ShiftDrawer.js` (400, 445, 481, 533)
- Modify: `server/routes/shifts.queries.js` (detail query: add `c.id AS client_id` beside the existing `COALESCE(c.name, s.client_name) AS client_name` at line ~74)

**Interfaces:**
- Consumes: `EntityLink` (Task 1), `drawerHref` (Task 3).
- Produces: `/shifts/detail/:id` payload gains `client_id` (nullable).

Resolve each appendix row for Lane B:

- [ ] **Step 1: EventDetailPage**
  - `:382` staff roster names: `<EntityLink to={member.user_id ? '/staffing/users/' + member.user_id : null}>{member.name || member.email}</EntityLink>` (legacy string-shape members have no id: EntityLink's null fallback covers them).
  - `:201` client heading button: replace the `<button onClick={() => navigate(...)}>` with `<EntityLink to={proposal.client_id ? '/clients/' + proposal.client_id : null} className="event-client-link">`, keeping the existing null-client plain-text branch behavior via the null fallback.
  - `:194` identity-bar eyebrow: make the `Event · {proposal.id}` eyebrow's id an `<EntityLink to={'/proposals/' + proposal.id}>` cross-link (views stay separate; this is a link, not a merge).
  - `:339` shift rows: replace the row div's `onClick={openShift}` with a wrapping `<Link to={drawerHref(searchParams, 'shift', s.id)}>` (get `searchParams` from `useSearchParams()`), preserving the row markup; remove the now-dead role/tabIndex attributes.

- [ ] **Step 2: Dashboard needs-attention queue (306, 308)**

Queue items currently navigate via onClick. Wrap each item title in `EntityLink`: events to `'/events/' + item.proposal_id` when `proposal_id` present else `'/events/shift/' + item.shift_id`; proposals to `'/proposals/' + item.id`.

- [ ] **Step 3: EventsDashboard manual events (512)**

Manual (no `proposal_id`) rows: give the `<strong>` name an `<EntityLink to={drawerHref(searchParams, 'shift', e.id)}>` so cmd-click opens a tab with the drawer; the existing row `onActivate` drawer-open stays for plain row clicks.

- [ ] **Step 4: ShiftDrawer (400, 445, 481, 533) + server alias**

Staff names at 445/481/533: `<EntityLink to={'/staffing/users/' + <row user_id>}>`. Client name at 400 (and the crumb at 367): needs `client_id`; add `c.id AS client_id` to the `/shifts/detail/:id` SELECT in `server/routes/shifts.queries.js` (the clients join `c` already exists at line ~74), then `<EntityLink to={shift.client_id ? '/clients/' + shift.client_id : null}>`.

- [ ] **Step 5: Verify**

Restart the managed dev server (server edit). Run `node --test server/routes/shifts.unstaffedJsonbGuard.test.js` if it covers the detail query, else confirm via curl: `curl -s localhost:5000/api/shifts/detail/<known-id> -H "Authorization: Bearer <dev JWT>" | grep client_id`. Client: `cd client && CI=true npx react-scripts build` clean; click-through every touched surface (event detail roster name, drawer staff name, manual-event cmd-click).

- [ ] **Step 6: Checkpoint commit**

```bash
git add client/src/pages/admin/EventsDashboard.js client/src/pages/admin/EventDetailPage.js client/src/pages/admin/Dashboard.js client/src/components/adminos/drawers/ShiftDrawer.js server/routes/shifts.queries.js
git commit -m "feat(crossnav): events surface entity links + shift detail client_id"
```

---

### Task 7 (Lane C): proposals/clients URL state

**Files:**
- Modify: `client/src/pages/admin/ProposalsDashboard.js` (tab/q/source), `client/src/pages/admin/ClientsDashboard.js` (q/sort)

Same mechanical adoption as Task 5 (module-scope defaults, caller-side tab clamp, every setter through `setListState`). ProposalsDashboard defaults: `{ tab: 'active', q: '', source: '' }`. ClientsDashboard defaults: `{ q: '', sort: <current initial sort value from line 41> }`.

- [ ] **Step 1: Adopt on both screens** (as above)
- [ ] **Step 2: Verify by hand** (filters in URL, Back restores, typing doesn't grow history)
- [ ] **Step 3: Checkpoint commit**

```bash
git add client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ClientsDashboard.js
git commit -m "feat(crossnav): proposals + clients dashboards URL view state"
```

---

### Task 8 (Lane C): proposals + clients + CC-import link coverage

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js` (367, 486, 712, 741), `client/src/pages/admin/AlternativesPanel.js:137`, `client/src/pages/admin/ProposalsDashboard.js` (222, 251), `client/src/pages/admin/ProposalCreate.js:460`, `client/src/pages/admin/ProposalDetailEditForm.js:340`, `client/src/pages/admin/ChangeRequestsDashboard.js:17`, `client/src/pages/admin/ClientDetail.js:250`, `client/src/pages/admin/CcImportReviewPage.js` (218, 294, 416, 476), `client/src/pages/admin/CcImportWrapUpPage.js` (246, 295, 306)
- Modify (only if needed): `server/routes/clients.js`

**Interfaces:**
- Consumes: `EntityLink` (Task 1).

- [ ] **Step 1: ProposalDetail + panels**
  - 367 title + 486 "Open client": convert both navigate-buttons to `EntityLink` (`'/clients/' + proposal.client_id`), keeping existing classes.
  - 712 "Open event": `EntityLink to={'/events/' + proposal.id}` (event shares the proposal id), keep the status gate.
  - 741 archive-scope modal: render each `openSiblings` entry as `<EntityLink to={'/proposals/' + p.id} target="_blank" rel="noopener noreferrer">` inside the summary sentence (new tab so the modal decision isn't lost).
  - AlternativesPanel 137: sibling rows to `EntityLink` (`'/proposals/' + m.id`), self member stays `<strong>`.

- [ ] **Step 2: dashboards + create/edit + change requests**
  - ProposalsDashboard 251 "View event" icon-button -> `EntityLink to={'/events/' + p.id}` keeping the icon; 222 (wrong-target edge): make the client cell an `EntityLink to={p.client_id ? '/clients/' + p.client_id : null}` instead of whatever it currently mis-targets.
  - ProposalCreate 460: the seeded-client banner name -> `EntityLink to={'/clients/' + <seed client id>}`.
  - ProposalDetailEditForm 340: client name -> `EntityLink` same shape.
  - ChangeRequestsDashboard 17: client name in each request row -> `EntityLink to={'/clients/' + r.client_id}`.

- [ ] **Step 3: ClientDetail event rows (250)**

Check the `/clients/:id` payload's proposals array: if each row already carries `status`, link rows whose status is in `['deposit_paid','balance_paid','confirmed','completed']` to `'/events/' + p.id` and the rest to `'/proposals/' + p.id`, both via RowLink in the identifying cell (rows may already be ClickableRow; follow the file's current row pattern). If status is absent, add it to the SELECT in `server/routes/clients.js` (read-only alias) and then do the same.

- [ ] **Step 4: CC import (218, 294, 416, 476, 246, 295, 306)**

ReviewPage 218: switch the existing event link target to `'/proposals/' + it.id` only if the row is proposal-stage (follow the appendix note; both resolve since event id == proposal id; keep `/events/` where the row represents a converted event). 294/416/476 (modal references): wrap named proposal/staff in `EntityLink` (`'/proposals/' + id`, `'/staffing/users/' + id`). WrapUpPage 246/295/306: plain-text proposal/event/client references become `EntityLink`s per the appendix targets (`'/events/' + it.id` for the completed-events table, `'/clients/' + it.client_id` for the client column).

- [ ] **Step 5: Verify + checkpoint commit**

`cd client && CI=true npx react-scripts build` clean; click-through ProposalDetail (all four), ClientDetail rows, one CC table. If clients.js changed, restart dev server and confirm `/clients/:id` payload.

```bash
git add client/src/pages/admin/ProposalDetail.js client/src/pages/admin/AlternativesPanel.js client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ProposalCreate.js client/src/pages/admin/ProposalDetailEditForm.js client/src/pages/admin/ChangeRequestsDashboard.js client/src/pages/admin/ClientDetail.js client/src/pages/admin/CcImportReviewPage.js client/src/pages/admin/CcImportWrapUpPage.js
git commit -m "feat(crossnav): proposals + clients + cc-import entity links"
```

(add `server/routes/clients.js` to the pathspec only if Step 3 touched it)

---

### Task 9 (Lane D): payroll/financials URL state + pay-period deep-link receiver

**Files:**
- Modify: `client/src/pages/admin/payroll/PayrollPage.js`, `client/src/pages/admin/payroll/HistoryView.js`, `client/src/pages/admin/FinancialsDashboard.js`

**Interfaces:**
- Consumes: `useUrlListState` (Task 2).
- Produces: `/financials/payroll?tab=history&period=<id>` lands on history with that period expanded and scrolled into view. Lane E's PayoutsTab links against exactly this contract.

- [ ] **Step 1: PayrollPage** adopts `const PAYROLL_DEFAULTS = { tab: 'current', period: '' };`. Tab clamp to `['current','history','unassigned']`. Pass `period` (string id or '') down to `HistoryView` as `initialPeriodId`.

- [ ] **Step 2: HistoryView receiver**

```jsx
// inside HistoryView, after periods load:
const targetRef = useRef(null);
useEffect(() => {
  if (!initialPeriodId || !periods.length) return;
  setExpanded(prev => (prev.has(initialPeriodId) ? prev : new Set(prev).add(initialPeriodId)));
  targetRef.current?.scrollIntoView({ block: 'start' });
}, [initialPeriodId, periods.length]);
```

Attach `ref={String(p.id) === String(initialPeriodId) ? targetRef : undefined}` on the matching period element. Adapt names to the file's actual expanded-state shape (if expansion is per-row state, set that row open); if the history endpoint pages and the target period is absent from page 1, fall back gracefully (no crash, no scroll).

- [ ] **Step 3: FinancialsDashboard** adopts `const FIN_DEFAULTS = { tab: 'overview', basis: <current initial>, from: '', to: '', include_cc: 'all' };` wiring its existing tab/filter-bar state through the hook (the basis/from/to/include_cc values currently feeding the `params` object at lines 31-33 become URL-backed).

- [ ] **Step 4: Verify by hand + checkpoint commit**

Visit `/financials/payroll?tab=history&period=<real id>` on the dev server: history tab opens, period expanded and scrolled. Back/forward across financials tabs behaves (replace semantics: tab flips don't stack history).

```bash
git add client/src/pages/admin/payroll/PayrollPage.js client/src/pages/admin/payroll/HistoryView.js client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(crossnav): payroll + financials URL state, period deep link"
```

---

### Task 10 (Lane D): money-surface link coverage

**Files:**
- Modify: `client/src/pages/admin/payroll/PayoutRow.js:20`, `client/src/pages/admin/payroll/EventLineItem.js:73`, `client/src/pages/admin/payroll/UnassignedTipsPanel.js:60`, `client/src/pages/admin/payroll/DeferredTipsPanel.js` (79, 80), `client/src/pages/admin/payroll/PayQRModal.js:22`, `client/src/pages/admin/TipsAdmin.js` (160, 237), `client/src/pages/admin/FinancialsDashboard.js` (143, 183, 185), `client/src/pages/admin/StripePayoutsTab.js` (12, 14, 15), `client/src/components/InvoiceDropdown.js:67`, `client/src/components/adminos/drawers/InvoicesDrawer.js:65`

**Interfaces:**
- Consumes: `EntityLink` (Task 1), `drawerHref` (Task 3), server fields from Task 11 (`client_id` on financials rows, `staff_ids` on deferred tips, `staff_user_id` on payout lines). Client renders `EntityLink to={x ? ... : null}` so it degrades safely if deployed before Task 11 data flows.

- [ ] **Step 1: payroll components**
  - PayoutRow 20: `<EntityLink to={'/staffing/users/' + payout.contractor_id}>{payout.contractor_name}</EntityLink>`.
  - EventLineItem 73: wrap the date + event label in `<EntityLink to={'/events/shift/' + event.shift_id}>` (redirect route resolves the owning event; NO server change).
  - UnassignedTipsPanel 60: `EntityLink to={'/staffing/users/' + tip.target_user_id}`.
  - DeferredTipsPanel 79/80: staff names use the Task 11 `staff_ids` parallel array: render each name as its own `EntityLink to={'/staffing/users/' + staff_ids[i]}` joined by ', '; the shift line at 80 links via `'/events/shift/' + t.shift_id`.
  - PayQRModal 22: staffer name -> `EntityLink` (`contractor_id` is in the payout row the modal receives).

- [ ] **Step 2: TipsAdmin (160, 237)**: `EntityLink to={t.target_user_id ? '/staffing/users/' + t.target_user_id : null}` on the bartender name in both tables.

- [ ] **Step 3: FinancialsDashboard (143, 183, 185)**: client cells -> `EntityLink to={row.client_id ? '/clients/' + row.client_id : null}` (Task 11 field); the payments-in-range row (183) identifying cell -> `EntityLink to={'/proposals/' + pp.proposal_id}`.

- [ ] **Step 4: StripePayoutsTab (12, 14, 15)**: in `lineLabel`, gratuity staff names -> `EntityLink to={l.staff_user_id ? '/staffing/users/' + l.staff_user_id : null}` (Task 11 field); payment lines -> `EntityLink to={l.proposal_id ? '/proposals/' + l.proposal_id : null}`; invoice_number stays plain text UNLESS the line carries an invoice token, in which case wrap it in `<a href={'/invoice/' + l.invoice_token} target="_blank" rel="noopener noreferrer">` (decision 2 secondary affordance; do not add new server fields for it).

- [ ] **Step 5: invoice surfaces (decision 2)**
  - InvoiceDropdown 67: keep the existing `/invoice/${inv.token}` anchor but give it `target="_blank" rel="noopener noreferrer"` so it stops navigating the admin SPA away.
  - InvoicesDrawer 65: each row gets the same new-tab token anchor on the invoice label; the drawer itself remains the admin surface (no admin invoice page).

- [ ] **Step 6: Verify + checkpoint commit**

`cd client && CI=true npx react-scripts build` clean; click-through payroll current + history payout cards, tips, financials tables, Stripe payouts tab.

```bash
git add client/src/pages/admin/payroll/PayoutRow.js client/src/pages/admin/payroll/EventLineItem.js client/src/pages/admin/payroll/UnassignedTipsPanel.js client/src/pages/admin/payroll/DeferredTipsPanel.js client/src/pages/admin/payroll/PayQRModal.js client/src/pages/admin/TipsAdmin.js client/src/pages/admin/FinancialsDashboard.js client/src/pages/admin/StripePayoutsTab.js client/src/components/InvoiceDropdown.js client/src/components/adminos/drawers/InvoicesDrawer.js
git commit -m "feat(crossnav): money-surface entity links"
```

---

### Task 11 (Lane D): money-surface SELECT additions

**Files:**
- Modify: `server/routes/proposals/metadata.js` (GET /financials handler, line ~112): add `client_id` to BOTH the proposals-table rows and the payments-in-range rows (alias from the proposals/clients join already present in each query).
- Modify: `server/routes/admin/payroll.js` (GET /payroll/deferred-tips, line ~558): alongside the existing staff-name string array, add `staff_ids` (same order, same length; `array_agg(u.id ORDER BY ...)` mirroring however the names are aggregated).
- Modify: `server/routes/stripePayouts.js` (payout lines query): add `staff_user_id` on gratuity-matched lines (the tip row's target user id; NULL on non-gratuity lines) and confirm `proposal_id` is already emitted (appendix says yes).

**Interfaces:**
- Produces: `client_id` (nullable int) on both /proposals/financials row sets; `staff_ids` (int[] parallel to names) on deferred-tips; `staff_user_id` (nullable int) on stripe-payout lines. Task 10 consumes exactly these names.

- [ ] **Step 0: Read `.claude/seam-sweep-2026-07-02.md`** (standing rule before touching payroll/invoice routes). Additions here are SELECT aliases only; if any change would touch amounts, statuses, or write paths, STOP and surface.
- [ ] **Step 1: Make the three additions** (read each query first; keep aliases snake_case; nullable where joins can miss).
- [ ] **Step 2: Test**

Run, ONE AT A TIME: `node -r dotenv/config --test server/routes/admin/payroll.test.js` then `node -r dotenv/config --test server/routes/stripePayouts.test.js` then `node -r dotenv/config --test server/routes/proposals/financialsNetting.test.js`. Expected: all pass (additions are non-breaking columns). Restart the managed dev server; curl each endpoint and grep the new fields.

- [ ] **Step 3: Checkpoint commit**

```bash
git add server/routes/proposals/metadata.js server/routes/admin/payroll.js server/routes/stripePayouts.js
git commit -m "feat(crossnav): id columns for money-surface links"
```

---

### Task 12 (Lane E): staffing URL state (dashboards + user-detail tab)

**Files:**
- Modify: `client/src/pages/admin/StaffDashboard.js` (`{ tab: 'active', q: '' }`), `client/src/pages/admin/HiringDashboard.js` (`{ q: '' }`), `client/src/pages/admin/userDetail/AdminUserDetail.js` (`{ tab: 'overview' }`, clamp to its tab list at line ~38)

Same adoption mechanics as Task 5. AdminUserDetail is the canonical case: `/staffing/users/7?tab=shifts` must select the shifts tab on load, and Back from an event must land there.

- [ ] **Step 1: Adopt on all three screens**
- [ ] **Step 2: Verify by hand** (the spec's founding example: staff -> shifts tab -> event -> Back -> shifts tab still selected)
- [ ] **Step 3: Checkpoint commit**

```bash
git add client/src/pages/admin/StaffDashboard.js client/src/pages/admin/HiringDashboard.js client/src/pages/admin/userDetail/AdminUserDetail.js
git commit -m "feat(crossnav): staffing URL view state (incl. user-detail tab)"
```

---

### Task 13 (Lane E): staffing link coverage

**Files:**
- Modify: `client/src/pages/admin/HiringDashboard.js` (169, 318), `client/src/pages/AdminDashboard.js` (410, 477, 616, 684, 725), `client/src/pages/admin/userDetail/tabs/ShiftsTab.js:76`, `client/src/pages/admin/userDetail/tabs/OverviewTab.js:118`, `client/src/pages/admin/userDetail/tabs/PayoutsTab.js:44`, `client/src/pages/admin/userDetail/tabs/MessagesTab.js` (27, 41), `client/src/pages/admin/userDetail/tabs/ApplicationTab.js:11`, `client/src/pages/admin/userDetail/AdminUserDetail.js:433`, `client/src/pages/admin/userDetail/components/AssignToEventModal.js:142`, `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js:128`, `client/src/components/adminos/InterviewScheduleModal.js:78`

**Interfaces:**
- Consumes: `EntityLink` (Task 1); Task 9's deep-link contract `/financials/payroll?tab=history&period=<id>`.

- [ ] **Step 1: the founding example**: ShiftsTab 76 and OverviewTab 118 event references -> `<EntityLink to={row.proposal_id ? '/events/' + row.proposal_id : '/events/shift/' + row.shift_id}>` around the event label (type + client name stays one link).
- [ ] **Step 2: PayoutsTab 44**: period rows -> `EntityLink to={'/financials/payroll?tab=history&period=' + p.period_id}` replacing the raw navigate.
- [ ] **Step 3: HiringDashboard 169/318**: search-result rows and kanban card names become real links to `'/staffing/applications/' + a.id` (keep drag behavior on cards: link only the name text, not the whole draggable card).
- [ ] **Step 4: legacy AdminDashboard (410, 477, 616, 684, 725)**: events -> `'/events/' + proposal_id` (fallback `'/events/shift/' + shift_id`), staff names -> `'/staffing/users/' + user_id`, all via EntityLink.
- [ ] **Step 5: remaining detail refs**: MessagesTab 27 (event via `'/events/shift/' + m.shift_id`) and 41 (sender via `'/staffing/users/' + m.sender_id`); ApplicationTab 11 -> `'/staffing/applications/' + <application user id>`; AdminUserDetail 433 proposal ref -> `'/proposals/' + id`; AssignToEventModal 142 event rows get an EntityLink on the label (modal stays usable: link is secondary to the assign action, so stopPropagation on the link click); AdminApplicationDetail 128 staff ref -> `'/staffing/users/' + id`; InterviewScheduleModal 78 applicant -> `'/staffing/applications/' + id`.
- [ ] **Step 6: Verify + checkpoint commit**

`cd client && CI=true npx react-scripts build` clean; walk the founding example end to end.

```bash
git add client/src/pages/admin/HiringDashboard.js client/src/pages/AdminDashboard.js client/src/pages/admin/userDetail client/src/pages/admin/applicationDetail/AdminApplicationDetail.js client/src/components/adminos/InterviewScheduleModal.js
git commit -m "feat(crossnav): staffing surface entity links"
```

---

### Task 14 (Lane F): comms URL state

**Files:**
- Modify: `client/src/pages/admin/EmailLeadsDashboard.js` (`{ q: '', status: '', source: '', page: '1' }`), `client/src/pages/admin/DrinkPlansDashboard.js` (`{ tab: 'all', q: '' }`), `client/src/pages/admin/Messages.js` (`{ client: '' }` for the selected thread), `client/src/pages/admin/EmailConversations.js` (`{ thread: '' }`)

Adoption mechanics as Task 5. Messages: `selectedClientId` derives from `state.client` (empty = current default behavior of newest thread) and selecting a thread does `setState({ client: String(id) })`; Back from a client profile then reopens the same thread.

- [ ] **Step 1: Adopt on all four screens**
- [ ] **Step 2: Verify by hand** (leads filters survive Back; Messages thread survives the client round trip)
- [ ] **Step 3: Checkpoint commit**

```bash
git add client/src/pages/admin/EmailLeadsDashboard.js client/src/pages/admin/DrinkPlansDashboard.js client/src/pages/admin/Messages.js client/src/pages/admin/EmailConversations.js
git commit -m "feat(crossnav): comms URL view state"
```

---

### Task 15 (Lane F): comms link coverage (+ drink-plan client_id, conversations lead_id verify)

**Files:**
- Modify: `client/src/pages/admin/EmailCampaignDetail.js` (255, 288), `client/src/pages/admin/EmailLeadDetail.js:162`, `client/src/pages/admin/EmailConversations.js` (89, 109), `client/src/pages/admin/Messages.js` (111, 130), `client/src/pages/admin/DrinkPlanDetail.js` (185, 189, 247), `client/src/components/DrinkPlanCard.js:183`, `client/src/components/AudienceSelector.js:119`
- Modify: `server/routes/drinkPlans.js` (GET /:id: add `client_id` alias from the proposals/clients join)
- Modify (verify-first): `server/routes/emailMarketing.js` (conversations thread list: ONLY if `lead_id` is genuinely absent from the payload, add it as a SELECT alias; no other change)

**Interfaces:**
- Consumes: `EntityLink` (Task 1).
- Produces: `/drink-plans/:id` payload gains `client_id` (nullable).

- [ ] **Step 1: email surfaces**: EmailCampaignDetail enrollment (255) + send-log (288) lead cells -> ClickableRow/RowLink per the file's table idiom, target `'/email-marketing/leads/' + row.lead_id`; EmailLeadDetail 162 campaign name -> `EntityLink to={'/email-marketing/campaigns/' + s.campaign_id}`; EmailConversations 109 header + 89 sidebar names -> `EntityLink to={t.lead_id ? '/email-marketing/leads/' + t.lead_id : null}` (verify `lead_id` in the threads payload first; add the alias in emailMarketing.js only if missing); AudienceSelector 119 lead rows in the picker get an EntityLink on the name with `target="_blank"` (picking stays the primary click; link opens a tab).
- [ ] **Step 2: Messages (111, 130)**: thread-list names and the conversation header -> `EntityLink to={'/clients/' + thread.client_id}` (id present per inventory).
- [ ] **Step 3: drink plans**: DrinkPlanDetail 185 client name -> `EntityLink to={plan.client_id ? '/clients/' + plan.client_id : null}` (server alias added this task); 189: render a small "Open proposal" EntityLink to `'/proposals/' + plan.proposal_id` in the header meta row (the not-rendered core finding); 247 staff name -> `'/staffing/users/' + id`; DrinkPlanCard 183 "View details" -> `EntityLink to={'/drink-plans/' + drinkPlan.id}` styled as the existing button.
- [ ] **Step 4: server + tests**: add the drinkPlans.js alias; restart dev server; `node -r dotenv/config --test server/routes/drinkPlans.beo.test.js` (one at a time) plus curl-grep `client_id` on a real plan id. If emailMarketing.js needed the alias, curl-grep `lead_id` on the threads endpoint.
- [ ] **Step 5: Verify + checkpoint commit**

`cd client && CI=true npx react-scripts build` clean.

```bash
git add client/src/pages/admin/EmailCampaignDetail.js client/src/pages/admin/EmailLeadDetail.js client/src/pages/admin/EmailConversations.js client/src/pages/admin/Messages.js client/src/pages/admin/DrinkPlanDetail.js client/src/components/DrinkPlanCard.js client/src/components/AudienceSelector.js server/routes/drinkPlans.js
git commit -m "feat(crossnav): comms entity links + drink-plan client_id"
```

(add `server/routes/emailMarketing.js` to the pathspec only if the verify-first alias was needed)
