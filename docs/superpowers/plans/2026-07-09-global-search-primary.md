---
spec: docs/superpowers/specs/2026-07-09-global-search-primary-design.md
lanes:
  - id: gsearch-a-palette-kbd
    footprint:
      - client/src/components/adminos/CommandPalette.js
      - client/src/components/adminos/CommandPalette.test.js
      - client/src/index.css   # ONE rule: .palette-list.kbd-nav hover suppression, appended after the .palette-item rules (~12586)
    blockedBy: []
    review: standard   # client-only, nothing on the sensitive list; the keyboard/latch logic carries its own RTL suite
  - id: gsearch-b-launcher
    footprint:
      - client/src/context/PaletteContext.js
      - client/src/components/adminos/GlobalSearchButton.js
      - client/src/components/adminos/GlobalSearchButton.test.js
      - client/src/components/AdminLayout.js
      - client/src/components/adminos/Header.js
      - client/src/components/adminos/Toolbar.js
      - client/src/pages/admin/EventsDashboard.js
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/StaffDashboard.js
      - client/src/pages/admin/ClientsDashboard.js
      - client/src/pages/admin/DrinkPlansDashboard.js
      - client/src/index.css   # .gsearch-toolbar sizing + coarse-pointer un-collapse, appended after the pointer:coarse header block (~11877)
      - README.md
    blockedBy: []
    review: standard   # broad-but-mechanical prop/filter removals + two tiny new files; nothing sensitive. Pre-merge review MUST include a cross-file consistency pass: all 5 Toolbar call sites agree with the new 5-prop contract
---

# Global Search As Primary Per-Page Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Lanes are built via the repo's think-on-main/build-in-lanes model (`npm run worktree:new`, squash-merge via `scripts/merge-lane.sh`).

**Goal:** The ⌘K global search becomes the one prominent search on every admin list page (a launcher button where the weak filter box sits today), and the palette gains Enter→top-hit / ↑↓ keyboard selection with a pending-Enter latch so a fast typist always lands on the record.

**Architecture:** A new `PaletteContext` (provided by `AdminLayout`, which already owns `paletteOpen`) exposes `openPalette()` to any admin surface. A new `GlobalSearchButton` renders the existing `.header-search` look in both the Header and the shared `Toolbar`, replacing Toolbar's client-side filter input. The five list dashboards drop their `q` view-state and search predicates. `CommandPalette` gets a flat, display-ordered item model driving `activeIndex` selection, a combobox ARIA pattern (`aria-activedescendant`, focus never leaves the input), and a pending-Enter latch that fires the top record when debounced results land. Server untouched.

**Tech Stack:** React 18 (CRA), React Router 6, vanilla CSS in `index.css`, RTL + jest (`fireEvent` + `jest.useFakeTimers`, per `KebabMenu.test.js` convention).

**Run order:** A ∥ B (no dependency; both cut from main). Both append to `index.css` in disjoint regions (~12586 vs ~11877) — expect a clean auto-merge; any textual conflict is ordinary-path resolution.

## Global Constraints

- Client-only. `GET /admin/search`, `server/utils/globalSearch.js`, and all list endpoints are frozen — zero server diffs.
- Launcher copy verbatim: `Search events, clients, proposals…`. Palette input placeholder unchanged: `Search clients, proposals, events, staff…`.
- Reuse the existing `.active` row class (`index.css:12585`); do NOT introduce `is-active`.
- Focus stays in the palette input at all times: combobox + `aria-activedescendant`, no roving tabindex. The per-nav-item `tabIndex={0}`/`onKeyDown` is removed.
- The 2-char server floor stands (`term.length < 2` short-circuit in the debounce is untouched); a 1-char query + Enter activating a matching nav item is intended.
- The ⌘/Ctrl/Shift/Alt-click behavior on record `<Link>`s (new tab, palette stays open) is preserved exactly (`CommandPalette.js:127-131` logic).
- `CI=true npx react-scripts build` must pass clean (ESLint warnings are errors) — no dead `search`/`setSearch`/`useMemo` bindings may survive.
- No em dashes in any user-visible copy.
- `scrollIntoView` must be feature-guarded (`el.scrollIntoView && …`) — jsdom doesn't implement it and the tests run there.
- File-size ratchet: `CommandPalette.js` grows ~168 → ~300 lines (fine); no file approaches 700.

---

# Lane A — `gsearch-a-palette-kbd` (palette keyboard + latch)

### Task A1: Failing RTL suite for palette keyboard selection

**Files:**
- Create: `client/src/components/adminos/CommandPalette.test.js`

**Interfaces:**
- Consumes: `CommandPalette({ open, onClose })` as it exists today; `utils/api` mocked.
- Produces: the executable contract for Task A2 — option ids `palette-opt-<idx>`, input `role="combobox"` with `aria-activedescendant`, `.active` class on the selected row, Enter/latch/arrow semantics.

- [ ] **Step 1: Write the test file**

```js
import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

// Two record groups so ordering (clients before events) and wrap-around are real.
const RESULTS = {
  clients: [{ type: 'client', id: 7, name: 'Ana Smith', detail: 'ana@example.com' }],
  proposals: [],
  events: [{ type: 'event', id: 12, name: 'Bo Smith', detail: 'Wedding · Aug 2, 2026' }],
  staff: [],
};
const EMPTY = { clients: [], proposals: [], events: [], staff: [] };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette() {
  const onClose = jest.fn();
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <CommandPalette open onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>
  );
  return { onClose, input: screen.getByRole('combobox') };
}

describe('CommandPalette keyboard selection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    api.get.mockReset();
  });
  afterEach(() => {
    act(() => { jest.runOnlyPendingTimers(); });
    jest.useRealTimers();
  });

  test('Enter activates the top record hit and closes', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText('Ana Smith')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/7');
    expect(onClose).toHaveBeenCalled();
  });

  test('ArrowDown/ArrowUp move the active option with wrap; Enter fires the selection', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    // No nav label contains "smith", so the flat list is exactly the 2 records.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveClass('active');
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // wraps to top
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    fireEvent.keyDown(input, { key: 'ArrowUp' });   // wraps to bottom
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/events/12');
  });

  test('Enter while results are loading latches; fires the top record on arrival (fast-typist path)', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const { onClose, input } = renderPalette();
    // "sett" matches the "Settings" nav item, which IS on screen while loading —
    // the latch must prevent Enter from misfiring onto it.
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); }); // request in flight
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no nav misfire
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolveSearch({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/3');
    expect(onClose).toHaveBeenCalled();
  });

  test('Enter before the debounce even fires still latches (sub-200ms typist)', async () => {
    api.get.mockResolvedValue({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'sett' } });
    fireEvent.keyDown(input, { key: 'Enter' }); // debounce hasn't fired yet — nothing is loading
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no nav misfire
    await act(async () => { jest.advanceTimersByTime(200); }); // debounce fires; mocked request resolves
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/3');
    expect(onClose).toHaveBeenCalled();
  });

  test('the latch clears if the user keeps typing', async () => {
    let resolveFirst;
    api.get
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smi' } });
    act(() => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'Enter' });               // latch set
    fireEvent.change(input, { target: { value: 'smit' } });   // keystroke clears it
    act(() => { jest.advanceTimersByTime(200); });            // second request fires
    await act(async () => { resolveFirst({ data: { results: RESULTS } }); }); // stale, dropped
    await act(async () => {});                                // flush second resolve
    expect(screen.getByText('Ana Smith')).toBeInTheDocument(); // results shown…
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // …but no auto-jump
  });

  test('Enter never activates stale rows from the previous query', async () => {
    api.get
      .mockResolvedValueOnce({ data: { results: RESULTS } })
      .mockResolvedValueOnce({ data: { results: EMPTY } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText('Ana Smith')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'smithx' } }); // old rows still on screen
    fireEvent.keyDown(input, { key: 'Enter' });               // must latch, NOT jump to stale Ana Smith
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    await act(async () => { jest.advanceTimersByTime(200); }); // 'smithx' returns empty → latch clears, visible no-op
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('an explicit arrow selection beats the latch', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'Enter' });      // latch set while loading
    fireEvent.keyDown(input, { key: 'ArrowDown' });  // arrow clears the latch, takes manual control
    fireEvent.keyDown(input, { key: 'Enter' });      // fires the explicit selection (Settings nav)
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
    expect(onClose).toHaveBeenCalled();
    await act(async () => { resolveSearch({ data: { results: EMPTY } }); }); // late arrival is inert
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
  });

  test('single-char query stays under the server floor; Enter activates the first matching nav item', () => {
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'e' } });
    act(() => { jest.advanceTimersByTime(200); });
    expect(api.get).not.toHaveBeenCalled(); // 2-char floor
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/events'); // "Events" is the first label containing "e"
  });

  test('selection resets to the top on a new keystroke', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.change(input, { target: { value: 'smiths' } });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    await act(async () => { jest.advanceTimersByTime(200); }); // flush the second fetch
  });

  test('Enter with zero matches is a no-op', async () => {
    api.get.mockResolvedValue({ data: { results: EMPTY } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'zzzz' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a latched Enter never fires after the palette is dismissed', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const onClose = jest.fn();
    const { rerender } = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CommandPalette open onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); });   // request in flight
    fireEvent.keyDown(input, { key: 'Enter' });      // latch armed
    rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CommandPalette open={false} onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    );                                               // parent-initiated close (Esc path)
    await act(async () => {
      resolveSearch({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no ghost navigation
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `cd client && CI=true npx react-scripts test CommandPalette.test.js`
Expected: FAIL — every test errors with `Unable to find an accessible element with the role "combobox"` (the input has no combobox role yet).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/adminos/CommandPalette.test.js
git commit -m "test(palette): failing suite for keyboard selection + pending-Enter latch"
```

### Task A2: Implement keyboard selection, latch, and combobox ARIA

**Files:**
- Modify: `client/src/components/adminos/CommandPalette.js` (full replacement below)

**Interfaces:**
- Consumes: `open`/`onClose` props (unchanged contract with `AdminLayout`); `GET /admin/search` response shape (unchanged).
- Produces: option row ids `palette-opt-<flatIndex>`; input `role="combobox"` + `aria-activedescendant`; `.palette-list` gains a `kbd-nav` class while keyboard-navigating (consumed by the Task A3 CSS rule).

- [ ] **Step 1: Replace `CommandPalette.js` with the following**

Semantics being added (everything else — groups, debounce, stale-request guard, new-tab clicks — is byte-preserved):
- Flat, display-ordered actionable item list (records then nav/create) drives `activeIndex`; index 0 is the top hit and is pre-selected.
- `ArrowDown`/`ArrowUp`: `preventDefault` (caret must not move), wrap-around, mark manual control (`movedRef`), clear any latch, scroll the active row into view (feature-guarded for jsdom).
- `Enter`: if the user has arrow-moved this query, activate the current selection immediately (even mid-load — an explicit selection wins, per spec §3.3 "defaulting to index 0 when the user has not moved"). Otherwise, if the ≥2-char term's FRESH results are not yet on screen (debounce pending, request in flight, or only stale prior-query rows showing — `resultsForRef` tracks which term the current results answered) and there's no search error, set the pending-Enter latch; else activate the top item. The latch fires the top RECORD when results land (records only — never a nav item, never a stale row), clears on keystroke/arrow/error/empty.
- Keystroke: reset `activeIndex` to 0, clear latch and `movedRef`. Async result arrival does NOT reset (render-time clamp handles shrinkage).
- Hover: `mouseenter` sets `activeIndex` only when not in keyboard mode (prevents scroll-under-cursor yank); any real `mousemove` exits keyboard mode.
- ARIA: input `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant` + `aria-autocomplete="list"`; list `role="listbox"`; rows `role="option"` + `aria-selected`; group wrappers `role="group"` with the label div `aria-hidden`. Focus never leaves the input; nav rows lose `tabIndex`/`onKeyDown`.

```js
import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from './Icon';
import api from '../../utils/api';
import useDebounce from '../../hooks/useDebounce';

// Result groups, in display order. `key` matches the endpoint response;
// `type` matches each result's `type` field and keys into PATH_BY_TYPE.
const RECORD_GROUPS = [
  { key: 'clients',   group: 'Clients',   type: 'client',   icon: 'users' },
  { key: 'proposals', group: 'Proposals', type: 'proposal', icon: 'clipboard' },
  { key: 'events',    group: 'Events',    type: 'event',    icon: 'calendar' },
  { key: 'staff',     group: 'Staff',     type: 'staff',    icon: 'userplus' },
];

const PATH_BY_TYPE = {
  client: '/clients',
  proposal: '/proposals',
  event: '/events',
  staff: '/staffing/users',
};

// Walk the groups in display order; the first record is the "top hit" the
// pending-Enter latch activates when results land.
function firstRecord(results) {
  for (const g of RECORD_GROUPS) {
    const items = (results && results[g.key]) || [];
    if (items.length) return items[0];
  }
  return null;
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  // Keyboard position in the flat item list; 0 = the top hit, pre-selected.
  const [activeIndex, setActiveIndex] = useState(0);
  // While true, CSS suppresses :hover paint (.palette-list.kbd-nav) so a mouse
  // resting on one row and the keyboard on another don't double-highlight.
  // Cleared by the next real mousemove.
  const [kbdNav, setKbdNav] = useState(false);
  // Monotonic id: a response whose id is stale (input changed since) is dropped.
  const reqIdRef = useRef(0);
  // Enter pressed while results were still loading: remember it and activate
  // the top record the moment they land (spec: pending-Enter latch). Cleared
  // by any keystroke, arrow key, error, or empty result — and it dies with the
  // palette: any dismissal kills it so a late response can't navigate.
  const pendingEnterRef = useRef(false);
  // The user arrow-moved during this query: their explicit selection beats the
  // latch/top-hit default. Cleared on keystroke and on open.
  const movedRef = useRef(false);
  // The term the current `results` answered. Enter only activates directly when
  // results are FRESH for the typed term; otherwise it latches. Covers all three
  // fast-typist windows: debounce not yet fired, request in flight, and stale
  // rows from the previous query still on screen.
  const resultsForRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setLoading(false);
      setSearchError(false);
      setActiveIndex(0);
      setKbdNav(false);
      pendingEnterRef.current = false;
      movedRef.current = false;
      resultsForRef.current = null;
    } else {
      // Dismissal (Esc, scrim, row click, ⌘K toggle) must kill a pending latch
      // and invalidate any in-flight request: a response landing after close
      // can neither navigate nor write state.
      pendingEnterRef.current = false;
      reqIdRef.current += 1;
    }
  }, [open]);

  // Keep the active row visible as ↑/↓ move past the fold of the 340px list.
  // scrollIntoView is feature-guarded: jsdom (tests) doesn't implement it.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`palette-opt-${activeIndex}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useDebounce(() => {
    // A debounce tick can land after the palette closed; don't search then.
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      reqIdRef.current += 1; // invalidate any in-flight request
      setResults(null);
      resultsForRef.current = null;
      setLoading(false);
      setSearchError(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setSearchError(false);
    api.get('/admin/search', { params: { q: term } })
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        setResults(res.data.results);
        resultsForRef.current = term; // these results answer THIS term
        setLoading(false);
        if (pendingEnterRef.current) {
          pendingEnterRef.current = false;
          const top = firstRecord(res.data.results);
          if (top) {
            navigate(`${PATH_BY_TYPE[top.type]}/${top.id}`);
            onClose();
          }
        }
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setSearchError(true);
        setLoading(false);
        pendingEnterRef.current = false;
      });
  }, 200, [q]);

  if (!open) return null;

  // Every in-component close goes through dismiss so a pending latch and any
  // in-flight request die synchronously with the close. (Parent-initiated
  // closes — Esc, ⌘K toggle — are covered by the open-effect's else branch.)
  const dismiss = () => {
    pendingEnterRef.current = false;
    reqIdRef.current += 1;
    onClose();
  };
  const go = (path) => () => { navigate(path); dismiss(); };

  const navGroups = [
    { group: 'Jump to', items: [
      { label: 'Dashboard',   icon: 'home',      onClick: go('/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/hiring') },
      { label: 'Financials',  icon: 'dollar',    onClick: go('/financials') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',     onClick: go('/drink-plans') },
      { label: 'Cocktail Menu', icon: 'book',    onClick: go('/cocktail-menu') },
      { label: 'Lab Notes',   icon: 'pen',       onClick: go('/blog') },
      { label: 'Settings',    icon: 'gear',      onClick: go('/settings') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: go('/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: go('/email-marketing/campaigns/new') },
    ]},
  ];

  const filteredNav = navGroups
    .map(g => ({ ...g, items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter(g => g.items.length);

  const recordGroups = results
    ? RECORD_GROUPS
        .map(g => ({ ...g, items: results[g.key] || [] }))
        .filter(g => g.items.length)
    : [];

  // Flat, display-ordered actionable list. The index into this list IS the
  // keyboard position; `start` offsets let grouped rendering compute each
  // row's flat index without a second pass.
  let cursor = 0;
  const recordGroupsIdx = recordGroups.map((g) => {
    const start = cursor;
    cursor += g.items.length;
    return { ...g, start };
  });
  const navGroupsIdx = filteredNav.map((g) => {
    const start = cursor;
    cursor += g.items.length;
    return { ...g, start };
  });
  const flatItems = [];
  recordGroupsIdx.forEach((g) => g.items.forEach((it) => {
    flatItems.push({ kind: 'record', path: `${PATH_BY_TYPE[it.type]}/${it.id}` });
  }));
  navGroupsIdx.forEach((g) => g.items.forEach((it) => {
    flatItems.push({ kind: 'nav', onClick: it.onClick });
  }));

  // Clamp instead of resetting when async results shrink/grow the list — a
  // reset here would yank a selection made while records were still loading.
  const activeIdx = flatItems.length ? Math.min(activeIndex, flatItems.length - 1) : -1;

  const activate = (item) => {
    if (!item) return;
    if (item.kind === 'record') {
      navigate(item.path);
      dismiss();
    } else {
      item.onClick();
    }
  };

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // keep the caret still
      if (!flatItems.length) return;
      movedRef.current = true;
      pendingEnterRef.current = false; // manual control cancels the latch
      setKbdNav(true);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(((activeIdx + delta) % flatItems.length + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim();
      // Fast-typist path: the user hasn't picked anything and fresh results
      // for this exact term aren't on screen yet (debounce pending, request in
      // flight, or only stale rows from the previous query showing) — latch,
      // and land on the top record when they arrive. Never misfire onto a nav
      // item or a stale row. On a search error there is nothing to wait for,
      // so Enter falls through to the visible selection.
      const fresh = !!results && resultsForRef.current === term;
      if (term.length >= 2 && !movedRef.current && !fresh && !searchError) {
        pendingEnterRef.current = true;
        return;
      }
      activate(flatItems[activeIdx]);
    }
  };

  const onQChange = (e) => {
    setQ(e.target.value);
    setActiveIndex(0); // reset ONLY on keystroke, never on async arrival
    pendingEnterRef.current = false;
    movedRef.current = false;
  };

  const term = q.trim();
  const showNoMatches = !loading && !searchError && results && !recordGroupsIdx.length && term.length >= 2;
  const showNoResults = !recordGroupsIdx.length && !filteredNav.length && !loading && !searchError && !showNoMatches;

  const rowProps = (idx) => ({
    id: `palette-opt-${idx}`,
    role: 'option',
    'aria-selected': idx === activeIdx,
    className: `palette-item${idx === activeIdx ? ' active' : ''}`,
    onMouseEnter: () => { if (!kbdNav) setActiveIndex(idx); },
  });

  return (
    <div className="palette-scrim open" onClick={dismiss} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={flatItems.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={activeIdx >= 0 ? `palette-opt-${activeIdx}` : undefined}
            aria-autocomplete="list"
            placeholder="Search clients, proposals, events, staff…"
            value={q}
            onChange={onQChange}
            onKeyDown={onInputKeyDown}
            aria-label="Command search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div
          id="palette-listbox"
          role="listbox"
          aria-label="Search results"
          className={`palette-list scroll-thin${kbdNav ? ' kbd-nav' : ''}`}
          onMouseMove={() => { if (kbdNav) setKbdNav(false); }}
        >
          {recordGroupsIdx.map(g => (
            <div key={g.key} role="group" aria-label={g.group}>
              <div className="palette-group-label" aria-hidden="true">{g.group}</div>
              {g.items.map((it, i) => {
                const idx = g.start + i;
                const path = `${PATH_BY_TYPE[it.type]}/${it.id}`;
                // Real anchor: cmd/ctrl/middle-click open a new tab natively
                // (palette stays open for those); plain click closes it.
                return (
                  <Link key={`${it.type}-${it.id}`} to={path} {...rowProps(idx)}
                    onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) dismiss(); }}>
                    <Icon name={g.icon} />
                    <div>
                      <div>{it.name}</div>
                      {it.detail && <div className="palette-item-sub">{it.detail}</div>}
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}

          {loading && <div className="palette-item muted">Searching…</div>}
          {searchError && <div className="palette-item muted">Search unavailable.</div>}
          {showNoMatches && <div className="palette-item muted">No matches for “{term}”.</div>}

          {navGroupsIdx.map(g => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="palette-group-label" aria-hidden="true">{g.group}</div>
              {g.items.map((it, i) => {
                const idx = g.start + i;
                return (
                  <div key={it.label} {...rowProps(idx)} onClick={it.onClick}>
                    <Icon name={it.icon} />
                    <div>
                      <div>{it.label}</div>
                    </div>
                    <div className="shortcut"><span className="kbd">↵</span></div>
                  </div>
                );
              })}
            </div>
          ))}

          {showNoResults && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run the suite to verify it passes**

Run: `cd client && CI=true npx react-scripts test CommandPalette.test.js`
Expected: PASS — 11 passed, 0 failed.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/adminos/CommandPalette.js
git commit -m "feat(palette): Enter->top-hit with pending latch, arrow selection, combobox ARIA"
```

### Task A3: Hover-suppression CSS + lane verification

**Files:**
- Modify: `client/src/index.css` — append ONE rule directly after the `.palette-item:hover, .palette-item.active` rule (currently `index.css:12585`)

**Interfaces:**
- Consumes: the `kbd-nav` class Task A2 toggles on `.palette-list`.

- [ ] **Step 1: Add the rule**

```css
/* While keyboard-navigating, only the .active row paints — a mouse resting on
   another row must not double-highlight. The kbd-nav class is cleared by the
   next real mousemove. */
html[data-app="admin-os"] .palette-list.kbd-nav .palette-item:hover:not(.active) { background: transparent; }
```

- [ ] **Step 2: Full client test suite + production build**

Run: `cd client && CI=true npx react-scripts test`
Expected: PASS — all suites (including the pre-existing ones) green.

Run: `cd client && CI=true npx react-scripts build`
Expected: `Compiled successfully.`

- [ ] **Step 3: Manual smoke (dev server)**

Restart the Claude-managed dev server if it's running stale, open `/events`, hit ⌘K and verify: type a real client name and slam Enter immediately (lands on the record via the latch); arrows move + scroll the highlight, hover doesn't double-highlight; ⌘-click a result opens a new tab with the palette still open.

- [ ] **Step 4: Commit**

```bash
git add client/src/index.css
git commit -m "style(palette): suppress hover paint during keyboard nav"
```

---

# Lane B — `gsearch-b-launcher` (launcher + context + per-page cleanup)

### Task B1: `PaletteContext` + `GlobalSearchButton` (TDD)

**Files:**
- Create: `client/src/context/PaletteContext.js`
- Create: `client/src/components/adminos/GlobalSearchButton.js`
- Create: `client/src/components/adminos/GlobalSearchButton.test.js`

**Interfaces:**
- Produces: `PaletteContext` (default export) + `usePalette()` hook returning `{ openPalette }`; `<GlobalSearchButton variant="header"|"toolbar" />`. Tasks B2/B3 consume both; the provider VALUE comes from `AdminLayout` (Task B2).

- [ ] **Step 1: Write the failing test**

```js
import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent } from '@testing-library/react';
import PaletteContext from '../../context/PaletteContext';
import GlobalSearchButton from './GlobalSearchButton';

test('clicking the launcher opens the palette via context', () => {
  const openPalette = jest.fn();
  render(
    <PaletteContext.Provider value={{ openPalette }}>
      <GlobalSearchButton variant="toolbar" />
    </PaletteContext.Provider>
  );
  const btn = screen.getByRole('button', { name: /open command palette/i });
  expect(btn).toHaveClass('header-search');
  expect(btn).toHaveClass('gsearch-toolbar');
  fireEvent.click(btn);
  expect(openPalette).toHaveBeenCalledTimes(1);
});

test('header variant renders without the toolbar modifier', () => {
  render(
    <PaletteContext.Provider value={{ openPalette: jest.fn() }}>
      <GlobalSearchButton />
    </PaletteContext.Provider>
  );
  const btn = screen.getByRole('button', { name: /open command palette/i });
  expect(btn).not.toHaveClass('gsearch-toolbar');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && CI=true npx react-scripts test GlobalSearchButton.test.js`
Expected: FAIL — `Cannot find module '../../context/PaletteContext'`.

- [ ] **Step 3: Implement both files**

`client/src/context/PaletteContext.js`:

```js
import { createContext, useContext } from 'react';

// Lets any admin surface (Header, the shared Toolbar) open the Cmd/Ctrl+K
// command palette without prop-drilling through the page tree. AdminLayout
// provides the value: { openPalette }.
const PaletteContext = createContext(null);

export function usePalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used within AdminLayout');
  return ctx;
}

export default PaletteContext;
```

`client/src/components/adminos/GlobalSearchButton.js`:

```js
import React from 'react';
import Icon from './Icon';
import { usePalette } from '../../context/PaletteContext';

// The one search affordance: a search-bar-shaped button that opens the Cmd/Ctrl+K
// command palette. Rendered in the Header (chrome) and in the shared Toolbar
// (list pages). variant="toolbar" adds sizing that fills the Toolbar slot and
// opts back out of the coarse-pointer icon collapse.
export default function GlobalSearchButton({ variant = 'header' }) {
  const { openPalette } = usePalette();
  return (
    <button
      type="button"
      className={`header-search${variant === 'toolbar' ? ' gsearch-toolbar' : ''}`}
      onClick={openPalette}
      aria-label="Open command palette"
    >
      <Icon name="search" />
      <span>Search events, clients, proposals…</span>
      <span className="kbd-group">
        <span className="kbd">⌘</span><span className="kbd">K</span>
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && CI=true npx react-scripts test GlobalSearchButton.test.js`
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/context/PaletteContext.js client/src/components/adminos/GlobalSearchButton.js client/src/components/adminos/GlobalSearchButton.test.js
git commit -m "feat(search): PaletteContext + GlobalSearchButton launcher"
```

### Task B2: AdminLayout provides context + focus return; Header consumes the launcher

**Files:**
- Modify: `client/src/components/AdminLayout.js`
- Modify: `client/src/components/adminos/Header.js`

**Interfaces:**
- Consumes: `PaletteContext` + `GlobalSearchButton` from B1.
- Produces: `openPalette()` in context for B3; every palette close restores focus to the opener.

- [ ] **Step 1: Edit `AdminLayout.js`**

Add imports (alongside the existing ones at the top):

```js
import PaletteContext from '../context/PaletteContext';
```

Inside the component, next to the existing `paletteOpen` state (`AdminLayout.js:21`), add the trigger capture, the context value, and the focus-return effect:

```js
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Where focus goes back to when the palette closes. Captured at open time
  // (launcher click or Cmd/Ctrl+K), restored on ANY close path (Esc, scrim,
  // navigation) so a keyboard user is never dropped to <body>.
  const paletteTriggerRef = useRef(null);
  const prevPaletteOpenRef = useRef(false);

  const openPalette = useCallback(() => {
    paletteTriggerRef.current = document.activeElement;
    setPaletteOpen(true);
  }, []);
  const paletteCtx = useMemo(() => ({ openPalette }), [openPalette]);

  useEffect(() => {
    if (prevPaletteOpenRef.current && !paletteOpen) {
      const el = paletteTriggerRef.current;
      paletteTriggerRef.current = null;
      // The opener may have unmounted (e.g. Enter navigated to a new page);
      // only restore focus if it's still in the document.
      if (el && el.isConnected && typeof el.focus === 'function') el.focus();
    }
    prevPaletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);
```

(`useMemo` joins the existing `react` import list: `import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';`)

In the ⌘K handler (`AdminLayout.js:86-94`), capture the trigger when the shortcut OPENS the palette:

```js
  const onKey = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(v => {
        if (!v) paletteTriggerRef.current = document.activeElement;
        return !v;
      });
    } else if (e.key === 'Escape') {
      setPaletteOpen(false);
      setMobileNavOpen(false);
    }
  }, []);
```

Wrap the shell in the provider and stop passing `onOpenPalette` to Header — the return becomes:

```js
  return (
    <PaletteContext.Provider value={paletteCtx}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className={`shell${mobileNavOpen ? ' mobile-nav-open' : ''}`}>
        <Sidebar badges={badges} presence={presence} onPresenceChange={applyPresence} onCloseMobileNav={closeMobileNav} />
        <Header
          onQuickAdd={() => navigate('/proposals/new')}
          onOpenMobileNav={openMobileNav}
          mobileNavOpen={mobileNavOpen}
        />
        <main className="main scroll-thin" id="main-content">
          <Outlet />
        </main>
        <div
          className={`shell-scrim${mobileNavOpen ? ' open' : ''}`}
          onClick={closeMobileNav}
          aria-hidden="true"
        />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </PaletteContext.Provider>
  );
```

- [ ] **Step 2: Edit `Header.js`**

Replace the inline search button (`Header.js:32-38` — NOT the mobile menu button at 21-30) with the shared launcher, and drop the prop. Full new file:

```js
import React from 'react';
import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import NAV from './nav';
import GlobalSearchButton from './GlobalSearchButton';

function findPageTitle(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.label;
    }
  }
  return 'Dashboard';
}

export default function Header({ onQuickAdd, unreadCount = 0, onOpenMobileNav, mobileNavOpen = false }) {
  const { pathname } = useLocation();
  const title = findPageTitle(pathname);

  return (
    <header className="header">
      <button
        type="button"
        className="header-menu-btn"
        onClick={onOpenMobileNav}
        aria-label="Open menu"
        aria-expanded={mobileNavOpen}
        aria-controls="primary-nav"
      >
        <Icon name="menu" size={20} />
      </button>
      <div className="header-title">{title}</div>
      <GlobalSearchButton />
      <div className="header-actions">
        <button type="button" className="icon-btn" title="Notifications" aria-label="Notifications">
          <Icon name="bell" />
          {unreadCount > 0 && <span className="dot" />}
        </button>
        <button type="button" className="icon-btn" title="New proposal" aria-label="Quick create" onClick={onQuickAdd}>
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Verify**

Run: `cd client && CI=true npx react-scripts test`
Expected: PASS (no suite references the dropped prop).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/AdminLayout.js client/src/components/adminos/Header.js
git commit -m "feat(search): AdminLayout provides PaletteContext + focus return; Header uses launcher"
```

### Task B3: Toolbar renders the launcher

**Files:**
- Modify: `client/src/components/adminos/Toolbar.js` (full replacement — the file is 48 lines)

**Interfaces:**
- Consumes: `GlobalSearchButton` (B1); context provided by B2.
- Produces: `Toolbar({ tabs, tab, setTab, filters, right })` — `search`/`setSearch` are GONE from the contract; B4 removes them from all 5 call sites.

- [ ] **Step 1: Replace `Toolbar.js`**

```js
import React from 'react';
import GlobalSearchButton from './GlobalSearchButton';

/**
 * Shared list-page toolbar: segmented tabs + global-search launcher + filter
 * slot + right slot. The launcher opens the Cmd/Ctrl+K palette — list pages
 * have no per-page text filter (find-one-thing goes through global search).
 *
 * Props:
 *   tabs: [{ id, label, count? }]   — optional left-side tab bar
 *   tab, setTab                     — active tab id + setter
 *   filters                         — optional node rendered to the right of search
 *   right                           — optional node rendered at the far right
 */
export default function Toolbar({ tabs, tab, setTab, filters, right }) {
  return (
    <div className="hstack" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {tabs && (
        <div className="seg">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="muted" style={{ marginLeft: 6 }}>{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      <GlobalSearchButton variant="toolbar" />
      {filters}
      <div className="spacer" />
      {right}
    </div>
  );
}
```

(Note: `Icon` import is dropped — the launcher owns its icon. The launcher renders unconditionally: all five consumers are list pages that want it.)

- [ ] **Step 2: Commit**

```bash
git add client/src/components/adminos/Toolbar.js
git commit -m "feat(search): Toolbar renders the global-search launcher, drops per-page filter input"
```

(Between B3 and B4 the five dashboards still pass `search`/`setSearch` — Toolbar simply ignores the unknown props, and their state stays referenced until B4 removes it, so nothing is dead yet. Everything is verified together in B5; in-lane checkpoints never reach main, so a mid-sweep interim is fine.)

### Task B4: Remove the client-side filter from the five dashboards

**Files:**
- Modify: `client/src/pages/admin/EventsDashboard.js`
- Modify: `client/src/pages/admin/ProposalsDashboard.js`
- Modify: `client/src/pages/admin/StaffDashboard.js`
- Modify: `client/src/pages/admin/ClientsDashboard.js`
- Modify: `client/src/pages/admin/DrinkPlansDashboard.js`

**Interfaces:**
- Consumes: Toolbar's new prop contract (B3).
- Produces: five pages with zero `search`/`q` references; `filtered` survives only where other predicates remain.

Line numbers below are pre-change positions; apply top-to-bottom per file.

- [ ] **Step 1: EventsDashboard.js (7 edits)**

`:42-44` — defaults + comment:
```js
// URL-backed view state (tab / status filter). Kept at module scope so
// the hook's default identity is stable. Back restores the exact list view.
const LIST_DEFAULTS = { tab: 'upcoming', status: '' };
```
`:78` — delete the line `const search = listState.q;`

`:185` — comment tail `(e.g. typing into the search box).` → `(e.g. list-state changes).`

`:223-231` — inside the `filtered` `useMemo`, delete the search block and its dep:
```js
        // DELETE these five lines:
        if (search) {
          const q = search.toLowerCase();
          const fields = [e.client_name, e.client_email, e.location].filter(Boolean).join(' ').toLowerCase();
          if (!fields.includes(q)) return false;
        }
```
and the deps line becomes `}, [events, tab, statusFilter]);`

`:233-234` — comment becomes:
```js
  // Tab badge counts are independent of the active tab/filter — keying
  // them only on `events` keeps them from recomputing on every list-state change.
```

`:384-385` — in the `<Toolbar` call, delete the two lines `search={search}` and `setSearch={(v) => setListState({ q: v })}`.

`:473-476` — trailing comment becomes:
```js
// Memoized row — only re-renders when its event reference changes. Dispatch is
// a stable callback from the parent, so list-state changes no longer rebuild
// 5 closures × N rows.
```

- [ ] **Step 2: ProposalsDashboard.js (6 edits)**

`:37-39` — comment + defaults:
```js
// View state lives in the URL (admin cross-nav): tab/source survive
// Back from a proposal, and the URL is shareable. Writes replace history.
const LIST_DEFAULTS = { tab: 'active', source: '' };
```
`:54` — delete `const search = listState.q;`

`:122-131` — delete the entire `filtered` `useMemo` INCLUDING its two comment lines (search was its only predicate; a passthrough memo is a no-op).

`:136-152` — the `rows` rollup consumes `proposals` directly (three references + deps):
```js
  const rows = useMemo(() => {
    const counts = new Map();
    proposals.forEach(p => {
      if (p.group_id != null) counts.set(p.group_id, (counts.get(p.group_id) || 0) + 1);
    });
    const seen = new Set();
    return proposals
      .filter(p => {
        if (p.group_id == null) return true;
        if (seen.has(p.group_id)) return false;
        seen.add(p.group_id);
        return true;
      })
      .map(p => (p.group_id != null && counts.get(p.group_id) > 1
        ? { ...p, _optionCount: counts.get(p.group_id) }
        : p));
  }, [proposals]);
```

`:181` — Toolbar call: `<Toolbar tabs={tabs} tab={tab} setTab={(t) => setListState({ tab: t })} />`

`:276-282` — footer count loses the search branch:
```js
      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {`${total} ${total === 1 ? 'proposal' : 'proposals'}${proposals.length < total ? ` · showing first ${proposals.length}` : ''}`}
          {' · Click a row to open'}
        </div>
      )}
```

- [ ] **Step 3: StaffDashboard.js (4 edits)**

`:16` — `const STAFF_DEFAULTS = { tab: 'active' };`

`:39-40` — delete BOTH lines (this page uniquely hoists the setter):
```js
  const search = listState.q;
  const setSearch = (v) => setListState({ q: v });
```

`:56-64` — the `filtered` `useMemo` keeps only the tab predicate:
```js
  const filtered = useMemo(() => staff.filter(s => {
    if (tab === 'active' && s.onboarding_status !== 'approved') return false;
    return true;
  }), [staff, tab]);
```

`:88` — `<Toolbar tabs={tabs} tab={tab} setTab={setTab} />`

(The `:107` empty copy "No staff match these filters." stays — the tab filter remains.)

- [ ] **Step 4: ClientsDashboard.js (5 edits)**

`:36-38` — comment + defaults:
```js
// View state lives in the URL (admin cross-nav): sort survives Back
// from a client profile. Writes replace history.
const LIST_DEFAULTS = { sort: 'recent' };
```
`:46` — delete `const search = listState.q;`

`:99-112` — the `filtered` `useMemo` becomes sort-only. **Correctness note:** the old code's `.filter()` produced a fresh array that `.sort()` then mutated safely; with the filter gone, sorting `clients` directly would mutate React state in place — copy first:
```js
  const filtered = useMemo(() => {
    return [...clients].sort((a, b) => {
      if (sort === 'ltv') return Number(b.lifetime_value || 0) - Number(a.lifetime_value || 0);
      if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
      // default 'recent'
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }, [clients, sort]);
```

`:191-192` — in the `<Toolbar` call, delete the `search={search}` and `setSearch={(v) => setListState({ q: v })}` lines (keep `filters`).

`:219` — empty copy: `<tr><td colSpan={7} className="muted">No clients yet.</td></tr>`

- [ ] **Step 5: DrinkPlansDashboard.js (4 edits)**

`:36` — `const [listState, setListState] = useUrlListState({ tab: 'all' });`

`:37` — delete `const search = listState.q;`

`:92-100` — tab-only filter:
```js
  const filtered = useMemo(() => plans.filter(p => {
    if (tab !== 'all' && p.status !== tab) return false;
    return true;
  }), [plans, tab]);
```

`:157` — `<Toolbar tabs={tabs} tab={tab} setTab={(v) => setListState({ tab: v })} />`

(The `:175` empty copy "No drink plans match these filters." stays — the tab filter remains.)

- [ ] **Step 6: Verify zero leftovers, then commit**

Run: `cd client && rg -n "setSearch|listState\.q|const search\b|search=\{" src/pages/admin/EventsDashboard.js src/pages/admin/ProposalsDashboard.js src/pages/admin/StaffDashboard.js src/pages/admin/ClientsDashboard.js src/pages/admin/DrinkPlansDashboard.js src/components/adminos/Toolbar.js`
Expected: no output — the pattern targets bindings and props only (a bare-word `search` pattern would false-positive on Toolbar's new JSDoc, which legitimately says "global-search launcher"). Comment drift in the dashboards is handled by the explicit comment edits in Steps 1-5.

```bash
git add client/src/pages/admin/EventsDashboard.js client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/StaffDashboard.js client/src/pages/admin/ClientsDashboard.js client/src/pages/admin/DrinkPlansDashboard.js
git commit -m "feat(search): dashboards drop client-side text filters; global search is the search"
```

### Task B5: Launcher CSS, README, and lane verification

**Files:**
- Modify: `client/src/index.css` — two additions, both appended directly AFTER the closing brace of the existing `@media (pointer: coarse)` block that collapses `.header-search` (block ends at `index.css:11877`)
- Modify: `README.md` — folder-tree entries

- [ ] **Step 1: Add the CSS**

```css
/* Toolbar-slot variant of the global-search launcher: fills the slot the old
   per-page filter input held (Toolbar flex row), matching the 32px control
   height of .input-group / .select so the row doesn't jiggle. */
html[data-app="admin-os"] .header-search.gsearch-toolbar {
  flex: 1 1 auto;
  min-width: 240px;
  max-width: 340px;
  height: 32px;
}

/* On touch, the header instance collapses to an icon (rule above) — the
   toolbar instance must NOT: it is the page's primary search affordance.
   Restore the bar shape at a 44px tap-target height; the kbd hint stays
   hidden (shortcut is irrelevant on touch). */
@media (pointer: coarse) {
  html[data-app="admin-os"] .header-search.gsearch-toolbar {
    width: auto;
    min-width: 240px;
    flex: 1 1 auto;
    height: 44px;
    padding: 0 0.6rem;
    justify-content: flex-start;
  }
  html[data-app="admin-os"] .header-search.gsearch-toolbar > span:not(.kbd-group) { display: inline; }
}
```

- [ ] **Step 2: README folder tree**

In the `client/src` folder tree, add (matching the surrounding tree formatting and comment style):
- under `components/adminos/`: `GlobalSearchButton.js` — `search-bar-shaped button that opens the ⌘K command palette (header + toolbar)`
- under `context/`: `PaletteContext.js` — `openPalette() for any admin surface; provided by AdminLayout`

- [ ] **Step 3: Full suite + build**

Run: `cd client && CI=true npx react-scripts test`
Expected: PASS — all suites green.

Run: `cd client && CI=true npx react-scripts build`
Expected: `Compiled successfully.` (this is the gate that proves no dead bindings survived B4).

- [ ] **Step 4: Manual smoke (dev server)**

Restart the managed dev server, then on each of `/events`, `/proposals`, `/clients`, `/staffing`, `/drink-plans`: the toolbar shows the launcher (sized like the old input); clicking it opens the palette; Esc returns focus to the launcher; tabs/sort/source filters still work; each list renders all rows; Clients' empty state reads "No clients yet." only when the table is truly empty. Header: search bar still present and opens the palette. Mobile width (or DevTools touch emulation): toolbar launcher stays a full bar, header search collapses to icon.

**§3.1 decide-by-looking call (record the outcome in the lane notes):** with both the header bar and the toolbar launcher visible, judge whether they read as redundant. If yes, the pre-approved lever is collapsing the header instance to icon-only on Toolbar pages — but prefer leaving both if it doesn't grate; zero extra code.

- [ ] **Step 5: Commit**

```bash
git add client/src/index.css README.md
git commit -m "style(search): toolbar launcher sizing + touch un-collapse; README tree"
```

---

# Post-merge (on main, after both lanes squash-merge)

- [ ] Merge order: either lane first (`scripts/merge-lane.sh`); the second merge re-verifies against main's new HEAD per the merge model. `index.css` hunks are disjoint (~11877 vs ~12586) — expect auto-merge.
- [ ] Combined smoke: the Lane A latch behavior exercised THROUGH the Lane B launcher (open palette from the Events toolbar, type, instant Enter → record). This is the one seam the lanes share.
- [ ] `npm run check:filesize` — expect no new YELLOW/RED from these files.
- [ ] Push is Dallas's explicit call, per the push model (review sweep runs then).

# Self-review notes (writing-plans checklist, run inline)

- **Spec coverage:** §3.1 launcher+variant (B1/B3/B5), §3.2 context (B1/B2), §3.3 keyboard+latch+ARIA+hover+scroll (A1/A2/A3), §3.4 five-page cleanup incl. Staff's hoisted setter, Proposals' collapsed memo, comment drift (B4), §5 focus-return + `?q=` inertness (B2 / nothing to do — param unmanaged), §6 tests+build+manual (A1, A3, B5), §7 footprint matches lane front-matter exactly, docs = README only per the mandatory-docs table (component/context rows are "—" for ARCHITECTURE).
- **Placeholders:** none — every step carries the actual code or exact copy.
- **Type/name consistency:** `palette-opt-<idx>` ids (A1 tests ↔ A2 impl ↔ aria-activedescendant), `kbd-nav` class (A2 ↔ A3 CSS), `gsearch-toolbar` class (B1 ↔ B5 CSS), `usePalette()`/`openPalette` (B1 ↔ B2 ↔ B3), Toolbar's new 5-prop contract (B3 ↔ B4 call sites).
- **Refinements now synced INTO the spec (no divergence):** explicit arrow selection beats the latch and arrows cancel a set latch (A1 tests 3/7); latch uses fresh-results semantics rather than `loading` — covers the sub-200ms pre-debounce window and never activates stale prior-query rows (plan-fleet fidelity finding; A1 tests 4/6); the latch dies with the palette — `dismiss()` on every in-component close plus an open-effect branch for parent closes, so a late response never navigates post-dismissal (per-lane review finding; A1 test 11). Spec §3.3 and §9 updated to match.
