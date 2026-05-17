# Admin Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every adminOS detail-page hardcoded "‹ Section" back button with one shared history-aware Back primitive, and delete the fake `Workspace / X` header crumb system and all its dead CSS.

**Architecture:** A single `BackButton.js` in `components/adminos/` exports `useSmartBack(fallback)` (returns `navigate(-1)` when in-app history exists, else `navigate(fallback)`) and a `<BackButton fallback>` component. Six detail pages drop their bespoke buttons for it. `Header.js` loses the fake crumb and renders an honest non-clickable page title. Dead breadcrumb CSS and a stale source comment are swept.

**Tech Stack:** React 18, react-router-dom@6.20 (`location.key === 'default'` ⇒ cold entry), CRA `react-scripts test` (Jest + React Testing Library 13.4 + jest-dom 5.17). No `src/setupTests.js` exists — the test file imports `@testing-library/jest-dom` itself.

**Commit grouping (CLAUDE.md Rule 3 overrides the skill's commit-per-task default):** This ships in **two** logical commits, not five. Tasks 1+2 are one feature ("history-aware back") → **one** commit at the end of Task 2 (no commit after Task 1 — the primitive is inert without its consumers; this is a deliberate deviation from the skill's "commit after green," per CLAUDE.md "no checkpoint commits, one commit per logical feature"). Task 3 (kill fake crumb + dead CSS + comment) is independent and separately revertible → its own commit. Task 4 is verification only, no commit. Use plain `git commit -m "..."` single-line, explicit `git add <path>` only. Do NOT push (push is user-initiated only).

**Command note:** All `npx react-scripts ...` commands run from the `client/` directory via the Bash tool (bash). `CI=true` matches the Vercel CI gate (warnings → errors).

**Pre-implementation verification (completed during planning — do not re-litigate, but rely on these facts):**
- App uses `<BrowserRouter>` (App.js:443), so `location.key === 'default'` is the correct cold-entry signal.
- Row-open is a **push**: `EventsDashboard` row → `dispatch('rowClick')` → `navigate('/events/${id}')` (no `replace`). Same push pattern for ⌘K (`CommandPalette` `navigate(path)`), Clients kebab, and Proposal→client/event links. So `navigate(-1)` correctly returns to the originating list/page.
- `EventEditForm` and `ProposalDetailEditForm` are **in-page editors, not routed** (App.js has only `/events/:id` and `/proposals/:id` — no `/edit` route). Editing creates no history entry, so Back never bounces into a stale edit form. Do NOT add navigation to these forms.
- `findPageTitle` (the renamed `findNavLabel`) mislabels nothing: every admin route resolves to a correct NAV label via prefix match, including `/staffing/users/:id`, `/staffing/applications/:id`, and all `/email-marketing/*` children (they are *nested* routes, so the pathname starts with `/email-marketing/`). The `'Dashboard'` fallback is unreachable for real admin routes.
- The 6 detail pages are the **exhaustive** set of fake back buttons (verified by a full sweep for `‹`/`←`/`arrow_left`/`name="left"`/`navigate(-1)`/section-navigate across `client/src/pages/admin`). Email sub-pages have no such button.

**Out of scope (noticed during verification, NOT part of this task):** `nav.js` still lists a `Cocktail Menu` item → `/cocktail-menu`, but that route is now `<Navigate to="/settings" replace>` (App.js:403). Stale dead nav, unrelated to the breadcrumb system. Leave it unless the user explicitly folds it in.

---

### Task 1: Create the `BackButton` primitive (TDD)

**Files:**
- Create: `client/src/components/adminos/BackButton.js`
- Test: `client/src/components/adminos/BackButton.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/adminos/BackButton.test.js`:

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import BackButton from './BackButton';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function EventsList() {
  return (
    <div>
      <h1>Events List</h1>
      <Link to="/events/1">Open event 1</Link>
    </div>
  );
}

function EventDetail() {
  return (
    <div>
      <BackButton fallback="/events" />
      <h1>Event 1 Detail</h1>
    </div>
  );
}

function Harness() {
  return (
    <Routes>
      <Route path="/events" element={<EventsList />} />
      <Route path="/events/1" element={<EventDetail />} />
    </Routes>
  );
}

describe('BackButton', () => {
  test('renders an icon button labelled Back', () => {
    render(
      <MemoryRouter initialEntries={['/events/1']}>
        <Harness />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  test('with in-app history, goes back to the previous location (navigate(-1))', () => {
    render(
      <MemoryRouter initialEntries={['/events']}>
        <Harness />
        <LocationProbe />
      </MemoryRouter>
    );
    expect(screen.getByText('Events List')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open event 1'));
    expect(screen.getByText('Event 1 Detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/events');
    expect(screen.getByText('Events List')).toBeInTheDocument();
  });

  test('on cold entry (no in-app history), falls back to the section list', () => {
    render(
      <MemoryRouter initialEntries={['/events/1']}>
        <Harness />
        <LocationProbe />
      </MemoryRouter>
    );
    expect(screen.getByText('Event 1 Detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/events');
    expect(screen.getByText('Events List')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from `client/`): `CI=true npx react-scripts test src/components/adminos/BackButton.test.js --watchAll=false`
Expected: FAIL — `Cannot find module './BackButton'`.

- [ ] **Step 3: Write the minimal implementation**

Create `client/src/components/adminos/BackButton.js`:

```jsx
import React, { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Icon from './Icon';

// react-router-dom@6 stamps the first history entry with key === 'default'.
// That means the user arrived cold (deep link, hard refresh, new tab, or a
// command-palette jump) and there is no in-app "back" — fall back to the
// section list. Otherwise navigate(-1) returns them exactly where they were.
export function useSmartBack(fallback) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.key && location.key !== 'default') navigate(-1);
    else navigate(fallback);
  }, [navigate, location.key, fallback]);
}

export default function BackButton({ fallback }) {
  const onBack = useSmartBack(fallback);
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
      <Icon name="left" size={11} />Back
    </button>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run (from `client/`): `CI=true npx react-scripts test src/components/adminos/BackButton.test.js --watchAll=false`
Expected: PASS — 3 passing tests.

- [ ] **Step 5: Do NOT commit yet.** Per the commit-grouping note, this primitive commits together with its consumers at the end of Task 2.

---

### Task 2: Wire all 6 detail pages to `<BackButton>`

Each page currently wraps its back button in `<div className="hstack" style={{ marginBottom: 8 }}>`. Keep that wrapper; replace only the inner `<button>…</button>` with `<BackButton fallback="…" />`, and add the import. Use the exact strings below with the Edit tool.

**Files:**
- Modify: `client/src/pages/admin/EventDetailPage.js` (2 instances)
- Modify: `client/src/pages/admin/DrinkPlanDetail.js` (2 instances)
- Modify: `client/src/pages/admin/ClientDetail.js` (1)
- Modify: `client/src/pages/admin/ProposalDetail.js` (1)
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js` (2 instances)
- Modify: `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js` (1)

- [ ] **Step 1: EventDetailPage.js**

Add the import near the other adminos imports (path is two levels up from `pages/admin/`):

```jsx
import BackButton from '../../components/adminos/BackButton';
```

Replace BOTH occurrences of this exact block:

```jsx
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/events')}>
          <Icon name="left" size={11} />Events
        </button>
```

with:

```jsx
        <BackButton fallback="/events" />
```

(One occurrence is indented under the not-found `return`, one under the main `return`; both have identical text — use Edit with `replace_all: true` on that exact string.)

- [ ] **Step 2: DrinkPlanDetail.js**

Add import:

```jsx
import BackButton from '../../components/adminos/BackButton';
```

Replace BOTH occurrences (not-found state + main) of this exact block:

```jsx
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/drink-plans')}>
            <Icon name="left" size={11} />Drink Plans
          </button>
```

and (note the main one is indented two spaces less):

```jsx
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/drink-plans')}>
          <Icon name="left" size={11} />Drink Plans
        </button>
```

each with:

```jsx
        <BackButton fallback="/drink-plans" />
```

Leave `navigate('/drink-plans')` on line ~118 (the post-delete redirect) UNTOUCHED.

- [ ] **Step 3: ClientDetail.js**

Add import:

```jsx
import BackButton from '../../components/adminos/BackButton';
```

Replace this exact block:

```jsx
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/clients')}>
          <Icon name="left" size={11} />Clients
        </button>
```

with:

```jsx
        <BackButton fallback="/clients" />
```

Leave the post-delete `navigate('/clients')` (line ~58) UNTOUCHED.

- [ ] **Step 4: ProposalDetail.js**

Add import:

```jsx
import BackButton from '../../components/adminos/BackButton';
```

Replace this exact block:

```jsx
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/proposals')}>
          <Icon name="left" size={11} />Proposals
        </button>
```

with:

```jsx
        <BackButton fallback="/proposals" />
```

Leave the post-delete `navigate('/proposals')` (line ~79) UNTOUCHED.

- [ ] **Step 5: userDetail/AdminUserDetail.js**

Add import (this file is one level deeper — `pages/admin/userDetail/`):

```jsx
import BackButton from '../../../components/adminos/BackButton';
```

Replace BOTH occurrences of this exact block:

```jsx
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/staffing')}>
          <Icon name="left" size={11} />Staff
        </button>
```

each with:

```jsx
        <BackButton fallback="/staffing" />
```

- [ ] **Step 6: applicationDetail/AdminApplicationDetail.js**

Add import (also one level deeper — `pages/admin/applicationDetail/`):

```jsx
import BackButton from '../../../components/adminos/BackButton';
```

Replace this exact block:

```jsx
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/hiring')}>
          <Icon name="arrow_right" size={11} style={{ transform: 'rotate(180deg)' }} />
          Hiring pipeline
        </button>
```

with:

```jsx
        <BackButton fallback="/hiring" />
```

- [ ] **Step 7: Build, fix any now-unused imports**

Run (from `client/`): `CI=true npx react-scripts build`

The back-button removal may leave `Icon` or `navigate`/`useNavigate` unused in some of the six files (Vercel CI treats `'X' is defined but never used` as an error). For EACH such error the build reports, open that file and:
- If `Icon` is now unused → remove its `import Icon from ...` line.
- If `navigate` is now unused → remove the `const navigate = useNavigate();` line AND drop `useNavigate` from the `react-router-dom` import.
- Do NOT remove `navigate` from files that still use it for a post-delete redirect (DrinkPlanDetail, ClientDetail, ProposalDetail keep it).

Re-run the build until it exits 0 with no warnings.
Expected final: `Compiled successfully.`

- [ ] **Step 8: Manual smoke test**

Start the dev server if not running (Claude-managed background process — see project memory). Verify each verified journey:
1. **The grr fix:** Events list → open an event → open its Drink Plan → **Back** → returns to **the event** (not the Drink Plans queue). **Back** again → returns to the Events list.
2. **List round-trip:** Clients list → open a client → **Back** → returns to the Clients list.
3. **Command palette:** from any page press ⌘K → jump to a proposal → **Back** → returns to the page you were on before ⌘K.
4. **Cold entry:** paste a drink-plan URL into a fresh browser tab → **Back** → lands on `/drink-plans` (fallback; does not leave the app).
5. **No edit bounce:** open an event → edit it in-page and save → **Back** → returns to the Events list (not a stale edit view).

- [ ] **Step 9: Commit (covers Task 1 + Task 2 — the whole back-nav feature)**

```bash
git add client/src/components/adminos/BackButton.js client/src/components/adminos/BackButton.test.js client/src/pages/admin/EventDetailPage.js client/src/pages/admin/DrinkPlanDetail.js client/src/pages/admin/ClientDetail.js client/src/pages/admin/ProposalDetail.js client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/admin/applicationDetail/AdminApplicationDetail.js
git commit -m "feat(admin): history-aware Back button replaces hardcoded section back links"
```

(If Step 7 modified import lines in any page, those same files are already in the `git add` list above — no extra paths needed.)

---

### Task 3: Kill the fake header crumb + dead CSS + stale comment

**Files:**
- Modify: `client/src/components/adminos/Header.js`
- Modify: `client/src/index.css` (three regions)
- Modify: `client/src/pages/admin/ProposalDetailEditForm.js` (comment only)

- [ ] **Step 1: Header.js — drop the fake crumb, render an honest title**

Replace this exact block:

```jsx
function findNavLabel(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.label;
    }
  }
  return 'Dashboard';
}

export default function Header({ onOpenPalette, onQuickAdd, unreadCount = 0 }) {
  const { pathname } = useLocation();
  const title = findNavLabel(pathname);

  return (
    <header className="header">
      <div className="header-crumbs">
        <span>Workspace</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-current">{title}</span>
      </div>
```

with:

```jsx
function findPageTitle(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.label;
    }
  }
  return 'Dashboard';
}

export default function Header({ onOpenPalette, onQuickAdd, unreadCount = 0 }) {
  const { pathname } = useLocation();
  const title = findPageTitle(pathname);

  return (
    <header className="header">
      <div className="header-title">{title}</div>
```

- [ ] **Step 2: index.css — replace both `.header-crumbs` blocks with `.header-title`**

Replace this exact block (light skin):

```css
html[data-app="admin-os"][data-skin="light"] .header-crumbs {
  font-family: var(--font-ui);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-weight: 500;
  color: var(--ink-3);
}
html[data-app="admin-os"][data-skin="light"] .header-crumbs .crumb-current {
  color: var(--ink-1);
  font-weight: 600;
}
html[data-app="admin-os"][data-skin="light"] .header-crumbs .crumb-sep { color: var(--ink-4); }
```

with:

```css
html[data-app="admin-os"][data-skin="light"] .header-title {
  font-family: var(--font-ui);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-weight: 600;
  color: var(--ink-1);
}
```

Then replace this exact block (base):

```css
html[data-app="admin-os"] .header-crumbs {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 12.5px;
  color: var(--ink-3);
  min-width: 0;
  flex: 1;
}
html[data-app="admin-os"] .header-crumbs .crumb-sep { color: var(--ink-4); }
html[data-app="admin-os"] .header-crumbs .crumb-current { color: var(--ink-1); font-weight: 500; }
```

with:

```css
html[data-app="admin-os"] .header-title {
  font-size: 12.5px;
  color: var(--ink-1);
  font-weight: 500;
  min-width: 0;
  flex: 1;
}
```

(`flex: 1; min-width: 0;` is retained so the search button still sits where it did.)

- [ ] **Step 3: index.css — delete the dead `.admin-breadcrumbs` block**

This block has zero JSX references anywhere. Delete it entirely — the comment line through the `.breadcrumb-sep` closing brace:

```css
/* Breadcrumbs */
.admin-breadcrumbs {
  padding: 0.75rem 1.5rem;
  font-size: 0.85rem;
  color: var(--text-muted, #5C3319);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  background: var(--card-bg);
}
.admin-breadcrumbs ol {
  display: flex;
  align-items: center;
  list-style: none;
  margin: 0;
  padding: 0;
  flex-wrap: wrap;
  gap: 0;
}
.admin-breadcrumbs li {
  display: flex;
  align-items: center;
}
.admin-breadcrumbs a {
  color: var(--amber);
  text-decoration: none;
  transition: color 0.15s;
}
.admin-breadcrumbs a:hover {
  color: var(--primary-hover, #5a4bd1);
  text-decoration: underline;
}
.admin-breadcrumbs span[aria-current="page"] {
  color: var(--text-primary, #1f2937);
  font-weight: 500;
}
.breadcrumb-sep {
  margin: 0 0.4rem;
  color: var(--text-muted, #9ca3af);
  font-weight: 300;
}
```

- [ ] **Step 4: ProposalDetailEditForm.js — trim the stale comment**

Replace this exact text:

```jsx
  // Browser refresh / close guard. (In-app navigation away — sidebar clicks,
  // breadcrumbs — would need react-router's `useBlocker`, which requires
```

with:

```jsx
  // Browser refresh / close guard. (In-app navigation away — sidebar clicks,
  // in-app links — would need react-router's `useBlocker`, which requires
```

- [ ] **Step 5: Build — expect clean**

Run (from `client/`): `CI=true npx react-scripts build`
Expected: `Compiled successfully.` (CSS-only + one JSX rename; no behavior change.)

- [ ] **Step 6: Artifact-sweep grep (the "zero artifacts" gate)**

Run from repo root:

```bash
grep -rn "header-crumbs\|crumb-sep\|crumb-current\|admin-breadcrumbs\|breadcrumb-sep\|findNavLabel" client/src
```

Expected: **no output** (exit 1). Any match is a leftover artifact — remove it before continuing. (The `crumb` *prop* in `Drawer.js`/`drawers/*` is a different word boundary and intentionally NOT matched by these patterns; it is out of scope per the spec.)

- [ ] **Step 7: Commit**

```bash
git add client/src/components/adminos/Header.js client/src/index.css client/src/pages/admin/ProposalDetailEditForm.js
git commit -m "refactor(admin): remove fake Workspace/X header crumb + dead breadcrumb CSS, honest page title"
```

---

### Task 4: Final verification (no commit)

- [ ] **Step 1: Prove the 6-page set was exhaustive**

Run from repo root:

```bash
grep -rn 'Icon name="left"' client/src/pages/admin
```

Expected: no matches inside the six detail pages. Any remaining `Icon name="left"` paired with an `onClick={() => navigate('/<section>')}` on a detail page is a missed straggler → fix it with `<BackButton>` and amend Task 2's commit only if not yet pushed (else a new commit). Allowed remaining navigators that are NOT back buttons and must stay: `ProposalCreate.js` "Cancel", staff onboarding wizard "← Back" (`ContractorProfile.js` etc.), and the post-delete redirects in DrinkPlanDetail/ClientDetail/ProposalDetail.

- [ ] **Step 2: Full client test suite**

Run (from `client/`): `CI=true npx react-scripts test --watchAll=false`
Expected: all suites pass, including `BackButton.test.js` (3 tests).

- [ ] **Step 3: Production build**

Run (from `client/`): `CI=true npx react-scripts build`
Expected: `Compiled successfully.`

- [ ] **Step 4: Report**

Summarize: 2 commits made (back-nav feature; crumb removal), 9 back buttons across 6 pages replaced, fake header crumb + 3 CSS regions + stale comment removed, artifact grep clean. Stand down — do not push (push is user-initiated per CLAUDE.md).
