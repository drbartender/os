# Mobile Admin Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The installable phone-first admin shell: one breakpoint fork, bottom-tab chrome, per-screen Desktop-view escape hatch, resume-last-route, admin PWA manifest + service worker with offline reads, and the install path, so every later phone screen is designed inside the real container.

**Architecture:** Same React app, same admin host. A single `useIsPhone` hook forks AdminLayout into a mobile chrome (top bar, `Outlet`, bottom tab bar); desktop rendering at desktop width stays byte-identical. A per-screen persisted Desktop-view override is the no-dead-ends floor: until a surface gets its phone-first component, it renders its desktop component inside the mobile chrome, and one tap forces the full desktop chrome. A new admin-scoped service worker adds push display, offline shell, and stamped read caching; the staff PWA surface is never touched.

**Tech Stack:** React 18 (CRA) / React Router 6, vanilla CSS in `index.css`, `react-scripts test` (jest + RTL 13, `renderHook` available), `playwright-core` via the existing `scripts/mobile-capture.js` harness, `sharp` (already installed at the repo root) for icon rasterization.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md` (approved section-by-section 2026-08-12/13)

**Scope:** Lanes ma-a-shell and ma-b-pwa only. Push wiring, WebAuthn auth, the Events/Proposals phone screens, and the DesignSync fitting pass are declared in the lane map with dependencies and get their own plans.

**Visual contract inputs (added 2026-08-14; the benchmark now exists):** the shell design benchmark is `docs/design-artifacts/2026-08-14-mobile-admin-shell.dc.html` and the vendored mobile family under `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/` (components-mobile.css, mobile cards, mobile-idiom guidelines). Lane ma-a builds the chrome AGAINST them, and its review includes `ui-ux-review` pointed at the artifact per CLAUDE.md "Design artifacts are contracts". The chrome elements the benchmark pins for the shell: the ℞ brand chip in the list header, the active-tab accent stripe, the neutral aggregate badge on the More tab, the back-arrow header variant on detail routes, and the ℞ glyph in the return pill.

**Proven context (verified against the repo 2026-08-13, not from memory):**
- `getSiteContext()` (`client/src/App.js:277`) maps `admin.*`, `localhost`, `127.0.0.1` to the admin surface; `staff.*` is the staff gate.
- `AdminLayout` (`client/src/components/AdminLayout.js`) owns badges polling (`/admin/badge-counts`), PaletteContext, the `data-app="admin-os"` attribute, and the `.shell` grid. The admin route wrapper is `client/src/App.js:574`. `AdminLayout` imports NO auth hook today; Task 9 adds `useAuth` explicitly. `ProtectedRoute adminOnly` admits managers, so role-gated nav items (`nav.js` `adminOnly: true`, filtered at `Sidebar.js:67`) must be filtered on the phone too.
- There is **no `client/src/setupTests.js`**: every client test that uses jest-dom matchers imports `'@testing-library/jest-dom'` itself, first line. Every test in this plan does the same.
- `Icon` defaults to `size = 14`; chrome icons must pass an explicit size.
- `Icon` (`client/src/components/adminos/Icon.js`) includes `calendar`, `clipboard`, `menu`, `search`, `right`, `down`, `dollar`, `external`. `NAV` is `client/src/components/adminos/nav.js` (default export, `{section, items:[{id,label,icon,path,badgeKey}]}`).
- `client/src/utils/api.js` has one request interceptor (JWT attach) and one response interceptor pair; success handler is currently `(res) => res`.
- Admin OS tokens: dark-skin page bg `--bg-0: #0b0d10`, accent `hsl(212 78% 44%)` (`#196ac8`), panel `--bg-1`, lines `--line-1/2`, text `--ink-1..4` (`index.css` ~10784-10875).
- Staff PWA reference files (READ-ONLY for this plan): `client/src/utils/installStaffPwaMeta.js`, `client/public/staff-manifest.json`, `client/public/staff-sw.js` (its `push` + `notificationclick` handlers are the pattern ma-b copies).
- `require('sharp')` resolves at the repo root.
- RTL 13.4 is installed; `renderHook` ships in `@testing-library/react` >= 13.1.

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string. Commas, colons, parentheses only.
- **One breakpoint.** `PHONE_BREAKPOINT_PX = 700` in `client/src/hooks/useIsPhone.js` is the only definition. The mobile chrome adds ZERO new `@media (max-width: ...)` queries; layout is flex inside the fork.
- **Desktop width is byte-identical.** Every fork is guarded by `isPhone`; at desktop width the rendered tree must be exactly today's. The existing small-width hamburger drawer stays intact: it is the chrome a Desktop-view override shows at phone width.
- **Staff surface untouched.** `installStaffPwaMeta.js`, `staff-manifest.json`, `staff-sw.js` must not change. The admin injector is a NEW sibling module, not a generalization of the staff one.
- **CSS:** vanilla CSS appended to `client/src/index.css`, every rule scoped `html[data-app="admin-os"] .m-...`. No new CSS files, no other selectors touched.
- **Service worker law (spec §7, tightened 2026-08-14 by the fleet fold-in):** `admin-sw.js` never intercepts non-GET requests and never queues writes. API reads are network-first over an explicit **allowlist** of phone-surface GET paths only; cache fallback fires ONLY on transport failure (a server-answered non-2xx, especially 401/403, is never answered from cache); the live fetch races a ~4s timeout when a cached copy exists; cached copies carry `x-sw-cached-at`; the API cache name embeds the authenticated user id, other users' namespaces are purged on boot, and a logout message purges everything.
- **Frontend API calls** go through `client/src/utils/api.js`. Never raw fetch/axios in components.
- **Client tests:** `cd client && CI=true npx react-scripts test --watchAll=false <path>`. **Before any commit touching `client/`:** `cd client && CI=true npx react-scripts build` (the only local gate catching CI-fatal warnings).
- **File size:** new files aim under 300 lines.
- **Explicit staging only:** `git add <specific paths>`, never `-A`/`.`.
- **Docs law:** new files land in README's folder tree in the same lane; the PWA/service-worker surface lands in ARCHITECTURE.md.
- **A11y floor:** the mobile chrome keeps the skip-nav link, labels every icon-only button with `aria-label`, and all tap targets are min 44px.

## Lane map

```yaml
lanes:
  - id: ma-a-shell
    phase: 1
    scope: >
      The phone fork and chrome: useIsPhone, per-screen Desktop-view override
      store and context, screen-key mapping, route record/restore, bottom tab
      bar, mobile top bar, More page, AdminLayout fork, /more route, shell CSS.
    footprint:
      - client/src/hooks/useIsPhone.js
      - client/src/hooks/useIsPhone.test.js
      - client/src/utils/desktopViewStore.js
      - client/src/utils/desktopViewStore.test.js
      - client/src/utils/screenKey.js
      - client/src/utils/screenKey.test.js
      - client/src/utils/routeRestore.js
      - client/src/utils/routeRestore.test.js
      - client/src/context/MobileViewContext.js
      - client/src/context/MobileViewContext.test.js
      - client/src/components/mobile/MobileTabBar.js
      - client/src/components/mobile/MobileTabBar.test.js
      - client/src/components/mobile/MobileHeader.js
      - client/src/pages/mobile/MorePage.js
      - client/src/components/AdminLayout.js
      - client/src/App.js
      - client/src/index.css
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check, ui-ux-review]  # designed surface: ui-ux-review points at the benchmark artifact

  - id: ma-b-pwa
    phase: 1
    scope: >
      Install + offline: admin manifest and icon set, admin PWA meta injector,
      admin-sw.js (push display, notification click, shell precache, stamped
      read cache), SW registration, api.js staleness surface, install prompt
      capture and the More install row, offline verification.
    footprint:
      - scripts/make-admin-icon.js
      - client/public/admin-manifest.json
      - client/public/admin-icon-512.png
      - client/public/admin-icon-192.png
      - client/public/admin-icon-maskable-512.png
      - client/public/admin-sw.js
      - client/src/utils/installAdminPwaMeta.js
      - client/src/utils/installAdminPwaMeta.test.js
      - client/src/utils/adminSw.js
      - client/src/utils/installPrompt.js
      - client/src/utils/installPrompt.test.js
      - client/src/utils/api.js
      - client/src/utils/api.stale.test.js
      - client/src/utils/staleTime.js
      - client/src/utils/staleTime.test.js
      - client/src/pages/mobile/MorePage.js
      - client/src/components/AdminLayout.js
      - client/src/context/AuthContext.js
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
    depends_on: [ma-a-shell]
    # SENSITIVE-BY-LIST: this footprint touches four scripts/sensitive-paths.txt
    # entries (AuthContext, admin-sw.js, admin-manifest.json, the injector), so
    # the lane declares the full fleet up front instead of leaving it to the
    # push-time sweep. database-review is N/A: the lane touches no schema.
    review_fleet: [code-review, consistency-check, security-review, second-opinion]

  # Phase numbers are wave labels; the depends_on edges are what serialize.
  # Declared, not planned here. Each gets its own plan when its turn comes,
  # and inherits its review_fleet from this map.
  - id: ma-c-push
    phase: 2
    scope: >
      Admin push wiring: subscribe path for the admin user, More > Notifications
      toggles, and server-side emits at the four phase-1 trigger points (new
      lead, proposal accepted, payment received, staffing drop). Touches the
      Stripe webhook tail: sensitive, own plan.
    footprint: []  # declared in its own plan
    depends_on: [ma-b-pwa]
    review_fleet: [code-review, consistency-check, security-review, database-review]
  - id: ma-d-auth
    phase: 2
    scope: >
      WebAuthn biometric unlock per spec section 8: webauthn_credentials table,
      register/assert endpoints, 12h phone JWT (credential = device session),
      30-minute background lock, desktop revoke UI, SessionExpiryHandler and
      AuthContext 401/transport fixes. Auth: max effort, 5-agent fleet, own plan.
    footprint: []  # declared in its own plan
    depends_on: [ma-a-shell]
    review_fleet: [code-review, consistency-check, security-review, database-review, second-opinion]
  - id: ma-e-events
    phase: 3
    scope: >
      Events phone surfaces (spec section 4): card list and detail with
      ShiftDrawer-as-sheet, list scroll restore (spec section 9), the rich
      detail header, and the route-dead fallback dispatch on 404/403 reads.
      Planned against the benchmark artifact.
    footprint: []  # declared in its own plan
    depends_on: [ma-b-pwa]
    review_fleet: [code-review, consistency-check, ui-ux-review]
  - id: ma-f-proposals-search
    phase: 3
    scope: >
      Proposals phone surfaces and full-screen global search (spec sections 5-6),
      reusing proposalEditor formState/patchBody/repriceSummary with the full
      hydration law, list scroll restore, and the route-dead fallback dispatch.
      Money edits: full fleet.
    footprint: []  # declared in its own plan
    depends_on: [ma-e-events]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]
  - id: ma-g-design-fit
    phase: 4  # rolling: one pass per refreshed benchmark snapshot
    scope: >
      Fitting pass for each refreshed benchmark snapshot, folding the settled
      treatment into index.css, replacing placeholder visuals (including the
      admin icon), and promoting the benchmark's accordion class reuse into
      proper .m-section classes.
    footprint: []  # declared per pass
    depends_on: [ma-a-shell]
    review_fleet: [code-review, ui-ux-review]
```

---

### Task 1: `useIsPhone` hook

**Files:**
- Create: `client/src/hooks/useIsPhone.js`
- Test: `client/src/hooks/useIsPhone.test.js`

**Interfaces:**
- Produces: `default useIsPhone(): boolean` (live, updates on viewport change); `export const PHONE_BREAKPOINT_PX = 700`.

- [ ] **Step 1: Write the failing test**

```js
// client/src/hooks/useIsPhone.test.js
import { renderHook, act } from '@testing-library/react';
import useIsPhone, { PHONE_BREAKPOINT_PX } from './useIsPhone';

function mockMatchMedia(initialMatches) {
  const listeners = new Set();
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_evt, fn) => listeners.add(fn),
    removeEventListener: (_evt, fn) => listeners.delete(fn),
  };
  window.matchMedia = jest.fn().mockReturnValue(mql);
  return {
    flip(matches) {
      mql.matches = matches;
      act(() => listeners.forEach((fn) => fn({ matches })));
    },
  };
}

test('reflects the media query and updates on change', () => {
  const m = mockMatchMedia(true);
  const { result } = renderHook(() => useIsPhone());
  expect(result.current).toBe(true);
  m.flip(false);
  expect(result.current).toBe(false);
});

test('queries the one breakpoint constant', () => {
  mockMatchMedia(false);
  renderHook(() => useIsPhone());
  expect(window.matchMedia).toHaveBeenCalledWith(
    `(max-width: ${PHONE_BREAKPOINT_PX - 1}px)`
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useIsPhone.test.js`
Expected: FAIL, cannot resolve `./useIsPhone`.

- [ ] **Step 3: Implement the hook**

```js
// client/src/hooks/useIsPhone.js
import { useEffect, useState } from 'react';

// The single mobile breakpoint for the phone-first admin surfaces
// (spec 2026-08-13-mobile-admin, section 3). ONE constant, defined once.
// Never add another width query for the mobile shell.
export const PHONE_BREAKPOINT_PX = 700;
const QUERY = `(max-width: ${PHONE_BREAKPOINT_PX - 1}px)`;

const canQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export default function useIsPhone() {
  const [isPhone, setIsPhone] = useState(() =>
    canQuery() ? window.matchMedia(QUERY).matches : false
  );

  useEffect(() => {
    if (!canQuery()) return undefined;
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsPhone(e.matches);
    // Older engines expose addListener only; the guard costs two lines.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    setIsPhone(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  return isPhone;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Same command as Step 2. Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useIsPhone.js client/src/hooks/useIsPhone.test.js
git commit -m "feat(mobile-admin): useIsPhone hook, the one 700px breakpoint"
```

---

### Task 2: Desktop-view override store + screen keys

**Files:**
- Create: `client/src/utils/desktopViewStore.js`, `client/src/utils/screenKey.js`
- Test: `client/src/utils/desktopViewStore.test.js`, `client/src/utils/screenKey.test.js`

**Interfaces:**
- Produces: `readOverrides(): object`, `writeOverride(screenKey, on): object` (returns the next map); `routeScreenKey(pathname): string`, `screenTitle(screenKey): string`.
- Screen keys are route-shaped: `/events` -> `events-list`, `/events/123` -> `event-detail`, `/proposals` -> `proposals-list`, `/proposals/42` -> `proposal-detail`, `/more` -> `more`, anything else -> its first path segment (`/financials/payroll` -> `financials`).

- [ ] **Step 1: Write the failing tests**

```js
// client/src/utils/desktopViewStore.test.js
import { readOverrides, writeOverride } from './desktopViewStore';

beforeEach(() => window.localStorage.clear());

test('round-trips an override and deletes on off', () => {
  expect(readOverrides()).toEqual({});
  expect(writeOverride('events-list', true)).toEqual({ 'events-list': true });
  expect(readOverrides()).toEqual({ 'events-list': true });
  expect(writeOverride('events-list', false)).toEqual({});
  expect(readOverrides()).toEqual({});
});

test('survives corrupt storage', () => {
  window.localStorage.setItem('adminDesktopViewOverrides', 'not json');
  expect(readOverrides()).toEqual({});
  window.localStorage.setItem('adminDesktopViewOverrides', '[1,2]');
  expect(readOverrides()).toEqual({});
});
```

```js
// client/src/utils/screenKey.test.js
import { routeScreenKey, screenTitle } from './screenKey';

test.each([
  ['/events', 'events-list'],
  ['/events/123', 'event-detail'],
  ['/proposals', 'proposals-list'],
  ['/proposals/42', 'proposal-detail'],
  ['/more', 'more'],
  ['/financials/payroll', 'financials'],
  ['/staffing/users/9', 'staffing'],
  ['/dashboard', 'dashboard'],
])('routeScreenKey(%s) -> %s', (path, key) => {
  expect(routeScreenKey(path)).toBe(key);
});

test('titles for the known screens, fallback capitalizes', () => {
  expect(screenTitle('events-list')).toBe('Events');
  expect(screenTitle('event-detail')).toBe('Event');
  expect(screenTitle('proposals-list')).toBe('Proposals');
  expect(screenTitle('proposal-detail')).toBe('Proposal');
  expect(screenTitle('more')).toBe('More');
  expect(screenTitle('staffing')).toBe('Staffing');
});
```

- [ ] **Step 2: Run both, verify both fail on unresolved imports**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/desktopViewStore.test.js src/utils/screenKey.test.js`

- [ ] **Step 3: Implement**

```js
// client/src/utils/desktopViewStore.js
// Per-screen "Desktop view" overrides for the phone admin (spec section 3:
// the no-dead-ends escape hatch). localStorage-persisted so the choice is a
// real exit that survives reloads; keyed per screen so opting one surface out
// of the phone treatment does not opt out all of them.
const KEY = 'adminDesktopViewOverrides';

export function readOverrides() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (e) {
    return {};
  }
}

export function writeOverride(screenKey, on) {
  const next = readOverrides();
  if (on) next[screenKey] = true;
  else delete next[screenKey];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    // Storage blocked or full: the toggle still works, it just won't persist.
  }
  return next;
}
```

```js
// client/src/utils/screenKey.js
// Route -> screen-key mapping for the Desktop-view override store and the
// mobile header title. Detail screens get their own key so "desktop for this
// event page" does not drag the list along with it.
export function routeScreenKey(pathname) {
  const segs = (pathname || '/').split('/').filter(Boolean);
  if (segs.length === 0) return 'dashboard';
  if (segs[0] === 'events') return segs.length > 1 ? 'event-detail' : 'events-list';
  if (segs[0] === 'proposals') return segs.length > 1 ? 'proposal-detail' : 'proposals-list';
  return segs[0];
}

const TITLES = {
  'events-list': 'Events',
  'event-detail': 'Event',
  'proposals-list': 'Proposals',
  'proposal-detail': 'Proposal',
  more: 'More',
  dashboard: 'Overview',
};

export function screenTitle(screenKey) {
  if (TITLES[screenKey]) return TITLES[screenKey];
  return screenKey.charAt(0).toUpperCase() + screenKey.slice(1);
}
```

- [ ] **Step 4: Run both tests, verify pass**
- [ ] **Step 5: Commit**

```bash
git add client/src/utils/desktopViewStore.js client/src/utils/desktopViewStore.test.js \
        client/src/utils/screenKey.js client/src/utils/screenKey.test.js
git commit -m "feat(mobile-admin): desktop-view override store and screen keys"
```

---

### Task 3: Route record/restore

**Files:**
- Create: `client/src/utils/routeRestore.js`
- Test: `client/src/utils/routeRestore.test.js`

**Interfaces:**
- Produces: `recordRoute(pathname, search)`, `consumeRestoredRoute(currentPathname): string | null`. The consumer (Task 5) calls `consumeRestoredRoute` exactly once per app launch; the once-guard lives inside (sessionStorage survives in-app navigation but not a cold start, which is exactly the boundary spec section 9 wants).

- [ ] **Step 1: Write the failing test**

```js
// client/src/utils/routeRestore.test.js
import { recordRoute, consumeRestoredRoute } from './routeRestore';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

test('restores the recorded route once per launch', () => {
  recordRoute('/proposals/42', '?tab=activity');
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42?tab=activity');
  // Second call in the same launch: the guard has burned.
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('returns null when already on the saved route', () => {
  recordRoute('/events', '');
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('returns null with nothing recorded', () => {
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('rejects non-path and protocol-relative junk', () => {
  window.localStorage.setItem(
    'adminLastRoute',
    JSON.stringify({ pathname: 'https://evil.example', search: '' })
  );
  expect(consumeRestoredRoute('/events')).toBe(null);
  window.sessionStorage.clear();
  window.localStorage.setItem(
    'adminLastRoute',
    JSON.stringify({ pathname: '//evil.example', search: '' })
  );
  expect(consumeRestoredRoute('/events')).toBe(null);
});
```

- [ ] **Step 2: Run it, verify unresolved-import failure**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/routeRestore.test.js`

- [ ] **Step 3: Implement**

```js
// client/src/utils/routeRestore.js
// Resume-where-I-left-off (spec section 9). The admin manifest's start_url is
// /events; on a cold standalone launch the shell restores the last recorded
// admin route instead. sessionStorage guards once-per-launch. Half-finished
// edit sheets are deliberately NOT restored; this is route-level only.
const LAST_ROUTE_KEY = 'adminLastRoute';
const RESTORED_KEY = 'adminRouteRestoredThisLaunch';

export function recordRoute(pathname, search) {
  try {
    window.localStorage.setItem(
      LAST_ROUTE_KEY,
      JSON.stringify({ pathname, search: search || '' })
    );
  } catch (e) {
    // Best-effort; a full store just means no resume this time.
  }
}

export function consumeRestoredRoute(currentPathname) {
  try {
    if (window.sessionStorage.getItem(RESTORED_KEY)) return null;
    window.sessionStorage.setItem(RESTORED_KEY, '1');
    const raw = window.localStorage.getItem(LAST_ROUTE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.pathname !== 'string') return null;
    if (!saved.pathname.startsWith('/')) return null; // same-origin paths only
    if (saved.pathname.startsWith('//')) return null; // protocol-relative guard
    if (saved.pathname === currentPathname) return null;
    return saved.pathname + (typeof saved.search === 'string' ? saved.search : '');
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 4: Run it, verify 4 passed**
- [ ] **Step 5: Commit**

```bash
git add client/src/utils/routeRestore.js client/src/utils/routeRestore.test.js
git commit -m "feat(mobile-admin): route record/restore with once-per-launch guard"
```

---

### Task 4: MobileViewContext

**Files:**
- Create: `client/src/context/MobileViewContext.js`
- Test: `client/src/context/MobileViewContext.test.js`

**Interfaces:**
- Consumes: `useIsPhone` (Task 1), `readOverrides`/`writeOverride` (Task 2).
- Produces: `<MobileViewProvider>` and `useMobileView(): { isPhone: boolean, desktopView(screenKey): boolean, setDesktopView(screenKey, on): void }`. Every later phone screen forks on this hook; the names here are the contract.

- [ ] **Step 1: Write the failing test** (the escape-hatch state machine gets its own checkpoint; nothing downstream tests it)

```js
// client/src/context/MobileViewContext.test.js
import '@testing-library/jest-dom';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MobileViewProvider, useMobileView } from './MobileViewContext';

jest.mock('../hooks/useIsPhone', () => ({ __esModule: true, default: () => true }));

const wrapper = ({ children }) => <MobileViewProvider>{children}</MobileViewProvider>;

beforeEach(() => window.localStorage.clear());

test('exposes isPhone and toggles a per-screen override with persistence', () => {
  const { result } = renderHook(() => useMobileView(), { wrapper });
  expect(result.current.isPhone).toBe(true);
  expect(result.current.desktopView('events-list')).toBe(false);
  act(() => result.current.setDesktopView('events-list', true));
  expect(result.current.desktopView('events-list')).toBe(true);
  expect(result.current.desktopView('event-detail')).toBe(false); // per-screen
  expect(
    JSON.parse(window.localStorage.getItem('adminDesktopViewOverrides'))
  ).toEqual({ 'events-list': true });
  act(() => result.current.setDesktopView('events-list', false));
  expect(result.current.desktopView('events-list')).toBe(false);
});
```

- [ ] **Step 1a: Run it, verify unresolved-import failure**

`cd client && CI=true npx react-scripts test --watchAll=false src/context/MobileViewContext.test.js`

- [ ] **Step 1b: Implement**

```js
// client/src/context/MobileViewContext.js
import React, {
  createContext, useCallback, useContext, useMemo, useState,
} from 'react';
import useIsPhone from '../hooks/useIsPhone';
import { readOverrides, writeOverride } from '../utils/desktopViewStore';

// isPhone plus the per-screen Desktop-view overrides (spec section 3).
// Provided by AdminLayout so every admin page, current and future, can fork.
const MobileViewContext = createContext({
  isPhone: false,
  desktopView: () => false,
  setDesktopView: () => {},
});

export function MobileViewProvider({ children }) {
  const isPhone = useIsPhone();
  const [overrides, setOverrides] = useState(readOverrides);
  const desktopView = useCallback(
    (screenKey) => !!overrides[screenKey],
    [overrides]
  );
  const setDesktopView = useCallback((screenKey, on) => {
    setOverrides(writeOverride(screenKey, on));
  }, []);
  const value = useMemo(
    () => ({ isPhone, desktopView, setDesktopView }),
    [isPhone, desktopView, setDesktopView]
  );
  return (
    <MobileViewContext.Provider value={value}>
      {children}
    </MobileViewContext.Provider>
  );
}

export const useMobileView = () => useContext(MobileViewContext);
export default MobileViewContext;
```

- [ ] **Step 1c: Run the test, verify pass**

- [ ] **Step 2: Commit**

```bash
git add client/src/context/MobileViewContext.js client/src/context/MobileViewContext.test.js
git commit -F - <<'MSG'
feat(mobile-admin): MobileViewContext provider with its own checkpoint
MSG
```

---

### Task 5: Mobile chrome (tab bar, header, More page, AdminLayout fork, CSS, /more route)

**Files:**
- Create: `client/src/components/mobile/MobileTabBar.js`, `client/src/components/mobile/MobileHeader.js`, `client/src/pages/mobile/MorePage.js`
- Test: `client/src/components/mobile/MobileTabBar.test.js`
- Modify: `client/src/components/AdminLayout.js`, `client/src/App.js`, `client/src/index.css`

**Interfaces:**
- Consumes: `useMobileView` (Task 4), `routeScreenKey`/`screenTitle` (Task 2), `recordRoute`/`consumeRestoredRoute` (Task 3), `usePalette` from `client/src/context/PaletteContext.js`, `Icon` and `NAV` from `components/adminos/`.
- Produces: the mobile chrome that ma-b and every screen lane render inside. CSS class names `.m-shell`, `.m-header`, `.m-main`, `.m-tabbar`, `.m-tab`, `.m-tab-badge`, `.m-more`, `.m-more-heading`, `.m-more-list`, `.m-more-row`, `.m-iconbtn`, `.m-return-pill` are the vocabulary later lanes extend.

- [ ] **Step 1: Write the failing tab-bar test**

```js
// client/src/components/mobile/MobileTabBar.test.js
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileTabBar from './MobileTabBar';

test('renders three tabs, the needs-you badge, and the neutral More aggregate', () => {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <MobileTabBar badges={{
        unstaffed_events: 3, pending_proposals: 0,
        unread_sms: 2, new_applications: 1, pending_shopping_lists: 1,
      }} />
    </MemoryRouter>
  );
  expect(screen.getByText('Events')).toBeInTheDocument();
  expect(screen.getByText('Proposals')).toBeInTheDocument();
  expect(screen.getByText('More')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  // More aggregates 2+1+1 into the NEUTRAL badge variant (benchmark).
  const moreBadge = screen.getByText('4');
  expect(moreBadge).toHaveClass('m-tab-badge', 'neutral');
  // A zero count renders no badge node at all.
  expect(screen.queryByText('0')).toBe(null);
});

test('active tab carries the accent stripe', () => {
  render(
    <MemoryRouter initialEntries={['/events']}>
      <MobileTabBar badges={{}} />
    </MemoryRouter>
  );
  const active = screen.getByText('Events').closest('a');
  expect(active.querySelector('.m-tab-stripe')).not.toBe(null);
  expect(screen.getByText('More').closest('a').querySelector('.m-tab-stripe')).toBe(null);
});
```

- [ ] **Step 2: Run it, verify unresolved-import failure**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/MobileTabBar.test.js`

- [ ] **Step 3: Implement the three components**

```js
// client/src/components/mobile/MobileTabBar.js
import React from 'react';
import { NavLink } from 'react-router-dom';
import Icon from '../adminos/Icon';

// Bottom tab bar for the phone admin shell (spec section 3, benchmark
// composition). Events/Proposals carry needs-you badges from the sidebar's
// badgeKey mapping; More aggregates the remaining badge-counts keys into the
// NEUTRAL badge variant so "something is waiting in there" reads without
// crying danger. Active tab carries the benchmark's accent stripe.
const MORE_KEYS = ['unread_sms', 'new_applications', 'pending_shopping_lists'];
const TABS = [
  { id: 'events', label: 'Events', icon: 'calendar', path: '/events', badgeKey: 'unstaffed_events' },
  { id: 'proposals', label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
  { id: 'more', label: 'More', icon: 'menu', path: '/more', neutral: true },
];

export default function MobileTabBar({ badges = {} }) {
  return (
    <nav className="m-tabbar" aria-label="Primary">
      {TABS.map((t) => {
        const count = t.neutral
          ? MORE_KEYS.reduce((a, k) => a + (badges[k] || 0), 0)
          : badges[t.badgeKey] || 0;
        return (
          <NavLink
            key={t.id}
            to={t.path}
            className={({ isActive }) => `m-tab${isActive ? ' active' : ''}`}
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="m-tab-stripe" aria-hidden="true" />}
                <span className="m-tab-icon">
                  <Icon name={t.icon} size={20} />
                  {count > 0 && (
                    <span className={`m-tab-badge${t.neutral ? ' neutral' : ''}`}>{count}</span>
                  )}
                </span>
                <span className="m-tab-label">{t.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
```

```js
// client/src/components/mobile/MobileHeader.js
import React from 'react';
import Icon from '../adminos/Icon';
import { usePalette } from '../../context/PaletteContext';
import { useMobileView } from '../../context/MobileViewContext';

// Top bar of the phone chrome (benchmark composition): the ℞ brand chip on
// list screens, a back arrow instead on detail screens, title, global search
// (opens the existing command palette until the full-screen search screen
// lands), and the per-screen Desktop-view escape hatch (spec section 3).
// The rich detail header (client · type, guests, venue) arrives with the
// screen lanes; this is the chrome-level variant.
export default function MobileHeader({ title, screenKey, onBack = null }) {
  const { openPalette } = usePalette();
  const { setDesktopView } = useMobileView();
  return (
    <header className="m-header">
      {onBack ? (
        <button type="button" className="m-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="left" size={20} />
        </button>
      ) : (
        <span className="m-brandmark" aria-hidden="true">&#8478;</span>
      )}
      <h1>{title}</h1>
      <button
        type="button"
        className="m-iconbtn"
        onClick={openPalette}
        aria-label="Search"
      >
        <Icon name="search" size={20} />
      </button>
      <button
        type="button"
        className="m-iconbtn"
        onClick={() => setDesktopView(screenKey, true)}
        aria-label="Switch to desktop view"
        title="Desktop view"
      >
        <Icon name="external" size={20} />
      </button>
    </header>
  );
}
```

```js
// client/src/pages/mobile/MorePage.js
import React from 'react';
import { Link } from 'react-router-dom';
import NAV from '../../components/adminos/nav';
import Icon from '../../components/adminos/Icon';
import { useAuth } from '../../context/AuthContext';

// The third tab: every admin surface that is not Events or Proposals, as tap
// rows. Until a surface gets its phone-first treatment it opens its desktop
// component inside the mobile chrome: ugly but reachable, which is the
// no-dead-ends floor (spec section 1).
const TAB_IDS = new Set(['events', 'proposals']);

export default function MorePage() {
  // Same adminOnly filter as Sidebar.js and CommandPalette.js: the admin
  // shell admits managers, and nav.js's own comment says never to offer a
  // manager a link that bounces them straight back out.
  const { user } = useAuth();
  const visible = (i) => !i.adminOnly || user?.role === 'admin';
  return (
    <div className="m-more">
      {NAV.map((section) => {
        const items = section.items.filter((i) => !TAB_IDS.has(i.id) && visible(i));
        if (!items.length) return null;
        return (
          <section key={section.section}>
            <h2 className="m-more-heading">{section.section}</h2>
            <ul className="m-more-list">
              {items.map((i) => (
                <li key={i.id}>
                  <Link className="m-more-row" to={i.path}>
                    <Icon name={i.icon} size={20} />
                    <span>{i.label}</span>
                    <Icon name="right" size={16} />
                  </Link>
                </li>
              ))}
              {section.section === 'Workspace' && (
                <li>
                  {/* Deliberate phone-only row (spec section 1 no-dead-ends):
                      /financials/payroll is a live route Dallas named in the
                      project's original scope, but it appears in neither
                      nav.js nor the sidebar, so the phone must offer it
                      explicitly or payroll is unreachable on the go. */}
                  <Link className="m-more-row" to="/financials/payroll">
                    <Icon name="dollar" size={20} />
                    <span>Payroll</span>
                    <Icon name="right" size={16} />
                  </Link>
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the tab-bar test, verify pass**

- [ ] **Step 5: Fork AdminLayout**

Restructure `client/src/components/AdminLayout.js`: rename the current component body to `AdminLayoutInner`, export a thin default that provides the context:

```js
export default function AdminLayout() {
  return (
    <MobileViewProvider>
      <AdminLayoutInner />
    </MobileViewProvider>
  );
}
```

Inside `AdminLayoutInner`, after the existing hooks (`badges`, palette, location), add:

```js
const { isPhone, desktopView, setDesktopView } = useMobileView();
const screenKey = routeScreenKey(location.pathname);
const mobileChrome = isPhone && !desktopView(screenKey);

// Resume-where-I-left-off: record every admin route; on the first render of
// a standalone (installed) launch, jump to the saved one (spec section 9).
useEffect(() => {
  recordRoute(location.pathname, location.search);
}, [location.pathname, location.search]);

const restoredRef = useRef(false);
useEffect(() => {
  if (restoredRef.current) return;
  restoredRef.current = true;
  const standalone =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches;
  if (!standalone || !isPhone) return;
  const target = consumeRestoredRoute(location.pathname);
  if (target) navigate(target, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// Dead-route fallback (spec section 9): a restored route whose entity is
// gone (archived proposal, role change) must fall back to /events, never
// strand. The chrome owns the listener; the screen lanes dispatch
// `mobile-route-dead` from their 404/403 read handlers. One-shot per mount.
useEffect(() => {
  const onDead = () => navigate('/events', { replace: true });
  window.addEventListener('mobile-route-dead', onDead, { once: true });
  return () => window.removeEventListener('mobile-route-dead', onDead);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// Phone-specific breakage must be independently visible (spec section 10).
useEffect(() => {
  Sentry.setTag('surface', mobileChrome ? 'mobile-admin' : undefined);
}, [mobileChrome]);
```

New import at top: `import * as Sentry from '@sentry/react';` (already a dependency; `index.js` initializes it).

Then fork the return. The existing return stays byte-for-byte as the desktop branch, with ONE addition (the return pill, shown only when a phone-width user has forced desktop view):

```jsx
if (mobileChrome) {
  const isDetail = screenKey === 'event-detail' || screenKey === 'proposal-detail';
  return (
    <PaletteContext.Provider value={paletteCtx}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className="m-shell">
        <MobileHeader
          title={screenTitle(screenKey)}
          screenKey={screenKey}
          onBack={isDetail ? () => navigate(-1) : null}
        />
        <main className="m-main" id="main-content"><Outlet /></main>
        <MobileTabBar badges={badges} />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </PaletteContext.Provider>
  );
}
```

and inside the existing desktop return, immediately before the closing `</PaletteContext.Provider>` (the ℞ glyph is benchmark composition):

```jsx
{isPhone && (
  <button
    type="button"
    className="m-return-pill"
    onClick={() => setDesktopView(screenKey, false)}
  >
    <span className="m-return-pill-rx" aria-hidden="true">&#8478;</span> Phone view
  </button>
)}
```

New imports at top of the file: `MobileViewProvider, useMobileView` from `../context/MobileViewContext`; `routeScreenKey, screenTitle` from `../utils/screenKey`; `recordRoute, consumeRestoredRoute` from `../utils/routeRestore`; `MobileHeader` from `./mobile/MobileHeader`; `MobileTabBar` from `./mobile/MobileTabBar`. Note `useRef` is already imported.

- [ ] **Step 6: Add the /more route**

In `client/src/App.js`, alongside the other lazy admin pages (~line 131): `const MorePage = lazy(() => import('./pages/mobile/MorePage'));` and inside the AdminLayout route block (line 573's children): `<Route path="/more" element={<MorePage />} />`.

- [ ] **Step 7: Append the shell CSS to `client/src/index.css`**

At the end of the file, one block, all rules scoped:

```css
/* ==========================================================================
   Mobile admin shell (spec 2026-08-13-mobile-admin). Phone chrome only:
   rendered exclusively when the useIsPhone fork is live, so nothing here can
   leak into desktop rendering. No media queries by design; the ONE breakpoint
   lives in client/src/hooks/useIsPhone.js.
   ========================================================================== */
html[data-app="admin-os"] .m-shell {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  background: var(--bg-0);
}
html[data-app="admin-os"] .m-header {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 52px;
  padding: 0 0.5rem 0 1rem;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line-1);
  flex-shrink: 0;
}
html[data-app="admin-os"] .m-header h1 {
  flex: 1;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--ink-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
html[data-app="admin-os"] .m-iconbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  border-radius: var(--radius);
  color: var(--ink-2);
  cursor: pointer;
}
html[data-app="admin-os"] .m-iconbtn:active { background: var(--row-hover); }
html[data-app="admin-os"] .m-brandmark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  margin-right: 8px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  line-height: 1;
}
html[data-app="admin-os"] .m-stale {
  font-size: var(--fs-meta);
  color: var(--ink-3);
  margin: 0 0 0.5rem;
}
html[data-app="admin-os"] .m-stale .m-stale-time { font-family: var(--font-numeric); }
html[data-app="admin-os"] .m-main {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  -webkit-overflow-scrolling: touch;
}
html[data-app="admin-os"] .m-tabbar {
  display: flex;
  flex-shrink: 0;
  background: var(--bg-1);
  border-top: 1px solid var(--line-2);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
html[data-app="admin-os"] .m-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0 6px;
  min-height: 52px;
  color: var(--ink-3);
  text-decoration: none;
  font-size: 11px;
}
html[data-app="admin-os"] .m-tab.active { color: var(--accent); }
html[data-app="admin-os"] .m-tab { position: relative; }
html[data-app="admin-os"] .m-tab-stripe {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 28px;
  height: 2px;
  background: var(--accent);
}
html[data-app="admin-os"] .m-tab-icon { position: relative; display: flex; }
html[data-app="admin-os"] .m-tab-badge {
  position: absolute;
  top: -4px;
  right: -12px;
  padding: 2px 5px;
  border-radius: 8px;
  background: hsl(var(--danger-h) var(--danger-s) 45%);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  font-family: var(--font-numeric);
}
html[data-app="admin-os"] .m-tab-badge.neutral {
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  color: var(--ink-2);
}
html[data-app="admin-os"] .m-more section { margin-bottom: 1rem; }
html[data-app="admin-os"] .m-more-heading {
  margin: 0 0 0.25rem;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}
html[data-app="admin-os"] .m-more-list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
html[data-app="admin-os"] .m-more-list li + li { border-top: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-more-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-height: 48px;
  padding: 0 1rem;
  background: none;
  border: none;
  color: var(--ink-1);
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
}
html[data-app="admin-os"] .m-more-row span:first-of-type { flex: 1; }
html[data-app="admin-os"] .m-more-row svg:last-child { color: var(--ink-4); }
html[data-app="admin-os"] .m-return-pill {
  position: fixed;
  right: 12px;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--ink-1);
  font-size: 13px;
  box-shadow: var(--shadow-pop);
  cursor: pointer;
}
html[data-app="admin-os"] .m-return-pill-rx { color: var(--accent); }
```

- [ ] **Step 8: Verify the build and the desktop invariant**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero warnings. Then run the full client suite touched so far:
`CI=true npx react-scripts test --watchAll=false src/hooks src/utils/desktopViewStore.test.js src/utils/screenKey.test.js src/utils/routeRestore.test.js src/components/mobile`

- [ ] **Step 9: Update README's folder tree** (new `hooks/useIsPhone.js`, `context/MobileViewContext.js`, `components/mobile/`, `pages/mobile/`, `utils/desktopViewStore.js`, `utils/screenKey.js`, `utils/routeRestore.js`).

- [ ] **Step 10: Commit**

```bash
git add client/src/components/mobile/MobileTabBar.js client/src/components/mobile/MobileTabBar.test.js \
        client/src/components/mobile/MobileHeader.js client/src/pages/mobile/MorePage.js \
        client/src/components/AdminLayout.js client/src/App.js client/src/index.css README.md
git commit -m "feat(mobile-admin): phone chrome with bottom tabs, More page, desktop-view escape"
```

---

### Task 6: Lane A on-device verification

**Files:** none created (screenshots land in `mobile-audit/`).

- [ ] **Step 1: Start the dev stack** per the standing recipe (dev server is a Claude-managed background process; restart it if `server/` was touched, it was not).

- [ ] **Step 2: Playwright phone pass.** Read `scripts/mobile-capture.js` and reuse its PATTERN, not the script: it is manifest-driven with no hook for custom assertions, and it hard-gates on the dev Neon `DATABASE_URL` host (lines 27-32), so write a scratch script in the scratchpad that borrows `mintToken`, the `page.addInitScript` JWT plant, and the `http://<host>:3000` convention. Load `http://admin.localhost:3000/events` at viewport 390x844 with a dev admin JWT. Assert:
  - `.m-tabbar` is visible and `.m-header` is visible; the sidebar is NOT in the DOM.
  - For each of the three tabs, `document.elementFromPoint(cx, cy)` at the tab's center resolves inside its `NavLink` (the clipped-control false-pass check).
  - Tap More, assert the `.m-more-row` for Clients navigates to `/clients` and the desktop ClientsDashboard renders inside `.m-main`.
  - Tap the desktop-view button in `.m-header`, assert the desktop `.shell` chrome renders and `.m-return-pill` is present; tap the pill, assert the mobile chrome returns.
  - Save a screenshot of `/events` and `/more` to `mobile-audit/`.

- [ ] **Step 3: Desktop invariant.** At viewport 1440x900, assert `.m-tabbar` is absent and the `.shell` grid renders exactly as before (sidebar + header present).

- [ ] **Step 4: Report results in the lane summary.** Any failure: fix inside the lane before merge, using superpowers:systematic-debugging for anything non-trivial.

---

### Task 7: Admin icon set + manifest (lane ma-b-pwa starts here)

**Files:**
- Create: `scripts/make-admin-icon.js`, `client/public/admin-manifest.json`
- Generated: `client/public/admin-icon-512.png`, `client/public/admin-icon-192.png`, `client/public/admin-icon-maskable-512.png`

**Interfaces:**
- Produces: `/admin-manifest.json` and the three icon files at the web root. The icon is a deliberate placeholder (dark tile, accent ring, "OS"); lane ma-g-design-fit replaces the art, the filenames are stable.

- [ ] **Step 1: Write the generator**

```js
// scripts/make-admin-icon.js
// One-shot: rasterize the admin app icon set from an inline SVG.
// Placeholder mark until the design round-trip supplies the real one; the
// FILENAMES are the stable contract, rerun this script to regenerate.
// Run from the repo root: node scripts/make-admin-icon.js
const sharp = require('sharp');
const path = require('path');

const svg = (maskable) => Buffer.from(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#0b0d10"/>
  <circle cx="256" cy="256" r="${maskable ? 168 : 190}" fill="none" stroke="#196ac8" stroke-width="20"/>
  <text x="256" y="${maskable ? 300 : 308}" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${maskable ? 130 : 150}" fill="#eef1f4">OS</text>
</svg>`);

(async () => {
  const out = (f) => path.join(__dirname, '..', 'client', 'public', f);
  await sharp(svg(false)).png().toFile(out('admin-icon-512.png'));
  await sharp(svg(false)).resize(192, 192).png().toFile(out('admin-icon-192.png'));
  await sharp(svg(true)).png().toFile(out('admin-icon-maskable-512.png'));
  console.log('admin icons written to client/public/');
})();
```

- [ ] **Step 2: Run it**

`node scripts/make-admin-icon.js` then `ls -la client/public/admin-icon-*.png`: three files, each a few KB. Then guard against silent tofu (sharp's SVG text rendering depends on fontconfig; a missing font still writes a file):

```bash
node -e "require('sharp')('client/public/admin-icon-512.png').stats().then(s => { const flat = s.channels.every(c => c.stdev < 5); if (flat) { console.error('icon looks blank'); process.exit(1); } console.log('icon has content'); })"
```

and open the PNG to eyeball the OS mark.

- [ ] **Step 3: Write the manifest**

```json
{
  "name": "DrB OS",
  "short_name": "DrB OS",
  "start_url": "/events",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0b0d10",
  "theme_color": "#196ac8",
  "icons": [
    { "src": "/admin-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/admin-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/admin-icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Verify it parses: `node -e "JSON.parse(require('fs').readFileSync('client/public/admin-manifest.json'))" && echo OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/make-admin-icon.js client/public/admin-manifest.json \
        client/public/admin-icon-512.png client/public/admin-icon-192.png \
        client/public/admin-icon-maskable-512.png
git commit -m "feat(mobile-admin): admin PWA manifest and placeholder icon set"
```

---

### Task 8: Admin PWA meta injector

**Files:**
- Create: `client/src/utils/installAdminPwaMeta.js`
- Test: `client/src/utils/installAdminPwaMeta.test.js`
- Modify: `client/src/components/AdminLayout.js`

**Interfaces:**
- Produces: `isAdminHost(hostname): boolean` (pure, exported for tests) and `installAdminPwaMeta(): void` (idempotent). Called once from `AdminLayoutInner`'s mount effect.

- [ ] **Step 1: Write the failing test**

```js
// client/src/utils/installAdminPwaMeta.test.js
import { isAdminHost, installAdminPwaMeta } from './installAdminPwaMeta';

test('isAdminHost mirrors getSiteContext admin mapping, never staff', () => {
  expect(isAdminHost('admin.drbartender.com')).toBe(true);
  expect(isAdminHost('admin.localhost')).toBe(true);
  expect(isAdminHost('localhost')).toBe(true);
  expect(isAdminHost('127.0.0.1')).toBe(true);
  expect(isAdminHost('staff.drbartender.com')).toBe(false);
  expect(isAdminHost('drbartender.com')).toBe(false);
  expect(isAdminHost('hiring.drbartender.com')).toBe(false);
  expect(isAdminHost('')).toBe(false);
});

test('injects manifest link and metas once (jsdom host is localhost)', () => {
  document.head.innerHTML =
    '<meta name="viewport" content="width=device-width, initial-scale=1" />';
  installAdminPwaMeta();
  installAdminPwaMeta(); // idempotent
  expect(
    document.head.querySelectorAll('link[rel="manifest"][href="/admin-manifest.json"]')
  ).toHaveLength(1);
  expect(
    document.head.querySelectorAll('meta[name="mobile-web-app-capable"]')
  ).toHaveLength(1);
  expect(
    document.head.querySelector('meta[name="viewport"]').getAttribute('content')
  ).toContain('viewport-fit=cover');
});
```

- [ ] **Step 2: Run it, verify unresolved-import failure**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/installAdminPwaMeta.test.js`

- [ ] **Step 3: Implement**

```js
// client/src/utils/installAdminPwaMeta.js
// Inject the ADMIN-scoped PWA metadata at runtime. Sibling of
// installStaffPwaMeta.js, which stays untouched: the same built bundle serves
// admin, staff, hiring, and public, so each surface injects its own manifest
// behind its own host gate and the installs never collide (spec section 7).
const MARKER_ATTR = 'data-admin-pwa';

// Mirrors getSiteContext()'s admin mapping in App.js (admin.* or bare
// localhost). staff./hiring./public hosts must never match.
export function isAdminHost(hostname) {
  if (!hostname) return false;
  return (
    hostname.startsWith('admin.') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  );
}

export function installAdminPwaMeta() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!isAdminHost(window.location && window.location.hostname)) return;
  if (document.head.querySelector(`[${MARKER_ATTR}]`)) return;

  const head = document.head;

  const manifestLink = document.createElement('link');
  manifestLink.rel = 'manifest';
  manifestLink.href = '/admin-manifest.json';
  manifestLink.setAttribute(MARKER_ATTR, '');
  head.appendChild(manifestLink);

  const metas = [
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'DrB OS' },
    // Full-bleed status bar in standalone; the staff injector sets the same.
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
  ];
  for (const { name, content } of metas) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', content);
    meta.setAttribute(MARKER_ATTR, '');
    head.appendChild(meta);
  }

  // index.html already ships a theme-color meta (#2C1F0E, apothecary) and
  // browsers honor the FIRST match, so injecting a second one is dead code.
  // Mutate the existing one in place on the admin host instead.
  const themeMeta = head.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', '#196ac8');

  // Safe-area insets (the tab bar sits over the gesture bar) need
  // viewport-fit=cover. Amend the existing viewport meta in place.
  const viewport = head.querySelector('meta[name="viewport"]');
  if (viewport) {
    const content = viewport.getAttribute('content') || '';
    if (!/viewport-fit/.test(content)) {
      viewport.setAttribute('content', `${content}, viewport-fit=cover`);
    }
  }
}
```

- [ ] **Step 4: Run the test, verify pass**

- [ ] **Step 5: Wiring deferred to Task 9.** The AdminLayout wiring for BOTH `installAdminPwaMeta()` and SW registration happens as ONE AdminLayout touch in Task 9 Step 6 (so this task's checkpoint is the unit test + build, and the layout edit is exercised together with the SW registration in Task 11's browser pass, instead of two separate AdminLayout edits with the first one untested).

- [ ] **Step 6: Commit**

```bash
cd client && CI=true npx react-scripts build && cd ..
git add client/src/utils/installAdminPwaMeta.js client/src/utils/installAdminPwaMeta.test.js
git commit -F - <<'MSG'
feat(mobile-admin): admin PWA meta injector behind the admin host gate
MSG
```

---

### Task 9: `admin-sw.js` + registration + staleness surface

**Files:**
- Create: `client/public/admin-sw.js`, `client/src/utils/adminSw.js`, `client/src/utils/staleTime.js`
- Modify: `client/src/utils/api.js`, `client/src/components/AdminLayout.js` (injector + SW wiring, one touch), `client/src/context/AuthContext.js` (logout purge call only; AuthContext is a sensitive path, keep the diff to that one hook)
- Test: `client/src/utils/api.stale.test.js`, `client/src/utils/staleTime.test.js`

**Interfaces:**
- Produces: `/admin-sw.js` at the web root; `registerAdminSw(): Promise<ServiceWorkerRegistration|null>`; `markStaleFromHeaders(response): response` exported from `api.js` (sets `response.staleAt` to the `x-sw-cached-at` ISO string when present). Screen lanes read `res.staleAt` to render the "as of 2:14 PM" line.

- [ ] **Step 1: Write the failing staleness test**

```js
// client/src/utils/api.stale.test.js
import { markStaleFromHeaders } from './api';

test('stamps staleAt from the SW header, leaves fresh responses alone', () => {
  const cached = { headers: { 'x-sw-cached-at': '2026-08-13T14:02:00.000Z' } };
  expect(markStaleFromHeaders(cached).staleAt).toBe('2026-08-13T14:02:00.000Z');
  const fresh = { headers: {} };
  expect(markStaleFromHeaders(fresh).staleAt).toBe(undefined);
  expect(markStaleFromHeaders(null)).toBe(null);
});
```

- [ ] **Step 2: Run it, verify it fails** (named export does not exist yet):

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/api.stale.test.js`

- [ ] **Step 3: Implement the api.js surface**

In `client/src/utils/api.js`, add the exported helper and use it in the EXISTING response interceptor's success handler (currently `(res) => res`):

```js
// Offline reads (spec section 7): admin-sw.js stamps cache-served responses
// with x-sw-cached-at. Surface it as response.staleAt so screens can render
// "as of <time>" instead of presenting stale data as live.
export function markStaleFromHeaders(response) {
  const t = response && response.headers
    ? response.headers['x-sw-cached-at']
    : null;
  if (t) response.staleAt = t;
  return response;
}
```

and change the success handler to `(res) => markStaleFromHeaders(res)`. The error handler is untouched.

- [ ] **Step 3b: The staleness display util** (spec §7: "as of 2:14 PM", device-local; §11 names its unit test). Test first:

```js
// client/src/utils/staleTime.test.js
import { formatStaleAt } from './staleTime';

test('same-day timestamps render as a time, older ones carry the day', () => {
  const now = new Date('2026-08-14T21:30:00');
  expect(formatStaleAt('2026-08-14T14:02:00', now)).toBe('as of 2:02 PM');
  expect(formatStaleAt('2026-08-13T21:12:00', now)).toBe('as of Aug 13, 9:12 PM');
  expect(formatStaleAt(null, now)).toBe(null);
  expect(formatStaleAt('garbage', now)).toBe(null);
});
```

Implementation:

```js
// client/src/utils/staleTime.js
// Renders the offline staleness line (spec section 7). Device-local time by
// design: the line answers "how old is what I'm seeing", not a business
// timestamp, so the repo's Chicago-keyed convention does not apply here.
const TIME = { hour: 'numeric', minute: '2-digit' };
const DAY = { month: 'short', day: 'numeric' };

export function formatStaleAt(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', TIME);
  return sameDay
    ? `as of ${time}`
    : `as of ${d.toLocaleDateString('en-US', DAY)}, ${time}`;
}
```

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/staleTime.test.js`, expect fail-then-pass per the TDD cycle. Screen lanes consume `formatStaleAt(res.staleAt)` inside the `.m-stale` element (CSS landed in Task 5).

- [ ] **Step 4: Run the api.stale test, verify pass**

- [ ] **Step 5: Write the service worker**

`client/public/admin-sw.js`, plain static JS at the origin root (same reasoning as the header comment in `staff-sw.js`):

```js
// Dr. Bartender admin OS service worker (mobile-admin spec section 7).
// Plain static JS, NOT webpack-bundled; served at the origin root so it can
// control top-level navigations. Three jobs:
//   1. push events -> OS notifications (pattern copied from staff-sw.js).
//   2. notificationclick -> focus or open the deep link.
//   3. Offline shell + stamped read cache:
//      - navigations: network-first, fall back to cached index.html
//      - /static/ assets: cache-first (content-hashed names are immutable)
//      - GET */api/*: network-first; good responses are cached stamped with
//        x-sw-cached-at; on network failure the stamped copy is served so the
//        UI shows staleness instead of a spinner. Non-GET is NEVER touched:
//        writes fail loudly and are never queued (spec: no offline writes).
// Bump SW_VERSION on every meaningful change (staff-sw.js convention).
const SW_VERSION = 'admin-sw-2026-08-13-v1';
const SHELL_CACHE = `admin-shell-${SW_VERSION}`;
const API_CACHE = `admin-api-${SW_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.add('/index.html')).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Purge by VERSION prefix: per-user API caches are named
    // admin-api-<SW_VERSION>-u<id>, so an exact-name compare would treat the
    // current user's cache as stale and wipe it on every activation.
    await Promise.all(
      names
        .filter((n) =>
          (n.startsWith('admin-shell-') || n.startsWith('admin-api-')) &&
          !n.includes(SW_VERSION))
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

async function stampAndPut(cache, key, response) {
  try {
    const headers = new Headers(response.headers);
    headers.set('x-sw-cached-at', new Date().toISOString());
    const body = await response.clone().blob();
    await cache.put(
      key,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    );
  } catch (e) {
    // Cache quota or opaque body: never let caching break the live response.
  }
}

// Per-user API cache namespace (spec §7: managers share these routes; one
// device must never show another user's cached data). The client posts the
// authenticated user id after registration; it is persisted in a tiny meta
// cache so it survives SW restarts.
let userId = null;
const META_CACHE = 'admin-meta';
const apiCacheName = () => `${API_CACHE}-u${userId || 'anon'}`;

async function purgeApiCaches({ keepCurrent = false } = {}) {
  const names = await caches.keys();
  await Promise.all(names
    .filter((n) => n.startsWith('admin-api-') && !(keepCurrent && n === apiCacheName()))
    .map((n) => caches.delete(n)));
}

async function loadUserId() {
  if (userId !== null) return;
  try {
    const meta = await caches.open(META_CACHE);
    const hit = await meta.match('/__admin-user');
    if (hit) userId = (await hit.text()) || null;
  } catch (e) { /* stay anon */ }
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'admin-user' && msg.id) {
    event.waitUntil((async () => {
      userId = String(msg.id);
      const meta = await caches.open(META_CACHE);
      await meta.put('/__admin-user', new Response(userId));
      await purgeApiCaches({ keepCurrent: true }); // evict other users' data
    })());
  } else if (msg.type === 'admin-logout') {
    event.waitUntil((async () => {
      userId = null;
      await caches.delete(META_CACHE);
      await purgeApiCaches(); // spec §7: full purge on logout
    })());
  }
});

// Only phone-surface reads are ever cached (spec §7 allowlist). Desktop-view
// traffic through the escape hatch (payroll, users, paystubs) must never
// land in Cache Storage.
const API_ALLOWLIST = [
  '/api/shifts',
  '/api/proposals',
  '/api/admin/badge-counts',
  '/api/admin/search',
  '/api/admin/active-staff',
];
const isAllowlisted = (pathname) =>
  API_ALLOWLIST.some((p) => pathname === p || pathname.startsWith(`${p}/`));

// Race a live fetch against a timeout. Weak signal hangs rather than failing
// (cross-origin API + CORS preflight); with a cached copy in hand we prefer
// stale-with-a-label over a spinner (spec §7). Without one, wait it out.
// The in-flight request is NOT abandoned on timeout: when it eventually
// lands, the late response still refreshes the cache stamp, so a
// persistently slow link doesn't freeze "as of" forever.
const TIMEOUT_MS = 4000;
function raceWithTimeout(fetchPromise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), TIMEOUT_MS);
    fetchPromise.then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // writes are never intercepted, never queued
  const url = new URL(req.url);

  // App-shell navigations (same-origin only).
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        await stampAndPut(cache, '/index.html', fresh);
        return fresh;
      } catch (e) {
        const cached = await caches.match('/index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Bundle assets: cache-first ONLY for content-hashed filenames (the
  // `main.a1b2c3d4.js` shapes `react-scripts build` emits). The dev server
  // serves `/static/js/bundle.js` under a STABLE name; cache-first there
  // would pin a frozen bundle on the dev box until the SW is unregistered.
  const CONTENT_HASHED = /\.[0-9a-f]{8}\./;
  if (url.origin === self.location.origin && url.pathname.startsWith('/static/')
      && CONTENT_HASHED.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // API reads. Matched by path, not origin: dev talks to localhost:5000/api,
  // prod to the api host on Render (REACT_APP_API_URL), and the SW sees both
  // because the page is the client. Cross-origin note for future readers:
  // this works BECAUSE the SW's fetch handler runs before the CORS preflight
  // (offline fallback fires even though a preflight would fail) and a
  // SW-synthesized Response is not CORS-filtered, so x-sw-cached-at is
  // readable by axios. Do not "fix" it with Access-Control-Expose-Headers.
  // Cache law (spec §7): allowlisted paths only; fallback ONLY on transport
  // failure or timeout-with-cache. A server-answered non-2xx (401/403 after
  // expiry or revocation) is returned as-is, NEVER answered from cache: a
  // dead session renders no data.
  if (url.pathname.startsWith('/api/') && isAllowlisted(url.pathname)) {
    event.respondWith((async () => {
      await loadUserId();
      const cache = await caches.open(apiCacheName());
      const cached = await cache.match(req);
      const live = fetch(req.clone());
      // Late responses still refresh the stamp (fire-and-forget).
      live.then((res) => { if (res.ok) stampAndPut(cache, req, res); }).catch(() => {});
      try {
        return cached ? await raceWithTimeout(live) : await live;
      } catch (e) {
        if (cached) return cached;
        throw e;
      }
    })());
  }
});

// ---- Rollback recipe (a registered SW outlives a git revert) --------------
// To KILL a shipped admin SW: replace this file's body with the stub below,
// bump SW_VERSION, deploy. Browsers pick it up on their next update check,
// it unregisters itself and drops every admin cache. Verified once in the
// Task 11 pass via registration.unregister().
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (e) => e.waitUntil((async () => {
//     const names = await caches.keys();
//     await Promise.all(names
//       .filter((n) => n.startsWith('admin-'))
//       .map((n) => caches.delete(n)));
//     await self.registration.unregister();
//   })()));
```

Then append the `push` and `notificationclick` handlers: copy both handler blocks VERBATIM from `client/public/staff-sw.js` (they are generic: parse payload defensively, show notification, focus-or-open the target URL). Do not edit the staff file.

- [ ] **Step 6: Registration util + wiring**

```js
// client/src/utils/adminSw.js
// Register the admin service worker and speak its message protocol.
// Callers do not await anything useful from failure: an unregistered SW just
// means no offline shell this session.
import { isAdminHost } from './installAdminPwaMeta';

export async function registerAdminSw() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!isAdminHost(window.location.hostname)) return null;
  try {
    return await navigator.serviceWorker.register('/admin-sw.js');
  } catch (e) {
    return null;
  }
}

// Post to whichever admin SW controls the page (active registration is fine
// even before controllerchange). Fire-and-forget by design.
async function postToAdminSw(message) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/admin-sw.js');
    const target = (reg && (reg.active || reg.waiting)) || navigator.serviceWorker.controller;
    if (target) target.postMessage(message);
  } catch (e) { /* no SW, nothing to scope or purge */ }
}

// Spec section 7: the API cache is namespaced per authenticated user. The
// announce is chained on serviceWorker.ready because on the very first load
// the registration has no active worker yet and controller is null; posting
// immediately would drop the message and the whole session would cache into
// the anonymous namespace.
export async function announceAdminSwUser(userId) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.ready;
    await postToAdminSw({ type: 'admin-user', id: String(userId) });
  } catch (e) { /* no SW this session */ }
}

// Spec section 7 purge rule: logout clears EVERYTHING phone-local: the SW
// caches AND the localStorage the shell writes (desktop-view overrides,
// saved route). One call site in AuthContext.logout.
const PHONE_LOCAL_KEYS = ['adminDesktopViewOverrides', 'adminLastRoute'];
export function purgeMobileAdminState() {
  postToAdminSw({ type: 'admin-logout' });
  try {
    PHONE_LOCAL_KEYS.forEach((k) => window.localStorage.removeItem(k));
    window.sessionStorage.removeItem('adminRouteRestoredThisLaunch');
  } catch (e) { /* storage blocked: nothing to clear */ }
}
```

Wiring, all in ONE AdminLayout touch (Task 8's injector wiring lands here too): `AdminLayoutInner` adds `import { useAuth } from '../context/AuthContext';` (AdminLayout imports no auth hook today; `user` is guaranteed non-null because `ProtectedRoute` renders children only after `loading` is false and `user` is truthy) and extends the existing `data-app` mount effect:

```js
installAdminPwaMeta();
registerAdminSw().then(() => announceAdminSwUser(user.id));
```

In `client/src/context/AuthContext.js`, the existing `logout` function gains ONE line before it clears state: `purgeMobileAdminState();` (import from `../utils/adminSw`). That is the entire AuthContext diff in this lane; the 401/transport-failure rework belongs to lane ma-d-auth per the spec. Known residual, accepted and documented: between first paint and the announce landing, reads may cache into the previous namespace; the announce's purge-others then evicts them, and the window is one screen's worth of GETs.

- [ ] **Step 7: Full client suite + build gate + commit.** This task rewrites the GLOBAL axios response interceptor, and eight existing suites import `utils/api` (CommandPalette, ShiftDrawer, CancelEventDialog, ProposalEditorForm.smoke, AssignToEventModal, PayoutDetail, PrescriptionTab, useFormDraft). Per the run-the-suites-a-change-reaches rule, run the WHOLE client suite, not just the new tests:

```bash
cd client && CI=true npx react-scripts test --watchAll=false && CI=true npx react-scripts build && cd ..
git add client/public/admin-sw.js client/src/utils/adminSw.js \
        client/src/utils/api.js client/src/utils/api.stale.test.js \
        client/src/utils/staleTime.js client/src/utils/staleTime.test.js \
        client/src/components/AdminLayout.js client/src/context/AuthContext.js
git commit -F - <<'MSG'
feat(mobile-admin): admin service worker with allowlisted, user-scoped offline read cache
MSG
```

---

### Task 10: Install prompt capture + More row

**Files:**
- Create: `client/src/utils/installPrompt.js`
- Test: `client/src/utils/installPrompt.test.js`
- Modify: `client/src/pages/mobile/MorePage.js`

**Interfaces:**
- Consumes: MorePage structure from Task 5.
- Produces: `canInstall(): boolean`, `onInstallAvailability(fn): unsubscribe`, `promptInstall(): Promise<{outcome}>`. The module captures `beforeinstallprompt` at import time (the event usually fires before any React mount).

- [ ] **Step 1: Write the failing test**

```js
// client/src/utils/installPrompt.test.js
import { canInstall, onInstallAvailability, promptInstall } from './installPrompt';

function fireBeforeInstallPrompt() {
  const e = new Event('beforeinstallprompt');
  e.prompt = jest.fn();
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
  return e;
}

test('captures the event, notifies subscribers, prompts once', async () => {
  expect(canInstall()).toBe(false);
  const seen = [];
  onInstallAvailability((v) => seen.push(v));
  const e = fireBeforeInstallPrompt();
  expect(canInstall()).toBe(true);
  expect(seen).toEqual([true]);
  const choice = await promptInstall();
  expect(e.prompt).toHaveBeenCalledTimes(1);
  expect(choice.outcome).toBe('accepted');
  expect(canInstall()).toBe(false);
  expect(await promptInstall()).toEqual({ outcome: 'unavailable' });
});
```

- [ ] **Step 2: Run it, verify unresolved-import failure**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/installPrompt.test.js`

- [ ] **Step 3: Implement**

```js
// client/src/utils/installPrompt.js
// Capture Chrome's beforeinstallprompt so the More tab can offer an explicit
// "Install app" row instead of depending on the browser banner's mood
// (spec section 7). Captured at module import: the event fires early.
let deferred = null;
const subs = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    subs.forEach((fn) => fn(true));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    subs.forEach((fn) => fn(false));
  });
}

export function canInstall() {
  return !!deferred;
}

export function onInstallAvailability(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function promptInstall() {
  if (!deferred) return { outcome: 'unavailable' };
  const e = deferred;
  deferred = null;
  e.prompt();
  const choice = await e.userChoice;
  subs.forEach((fn) => fn(false));
  return choice;
}
```

- [ ] **Step 4: Run the test, verify pass**

- [ ] **Step 5: Add the More row**

In `MorePage.js`, add an App section ABOVE the NAV sections, rendered only when installable and not already standalone:

```jsx
function InstallRow() {
  const [available, setAvailable] = React.useState(canInstall());
  React.useEffect(() => onInstallAvailability(setAvailable), []);
  const standalone =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches;
  if (standalone || !available) return null;
  return (
    <section>
      <h2 className="m-more-heading">App</h2>
      <ul className="m-more-list">
        <li>
          <button type="button" className="m-more-row" onClick={() => promptInstall()}>
            <Icon name="down" />
            <span>Install app</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
```

with `import { canInstall, onInstallAvailability, promptInstall } from '../../utils/installPrompt';` and `<InstallRow />` as the first child of `.m-more`.

- [ ] **Step 6: Build gate + commit**

```bash
cd client && CI=true npx react-scripts build && cd ..
git add client/src/utils/installPrompt.js client/src/utils/installPrompt.test.js \
        client/src/pages/mobile/MorePage.js
git commit -m "feat(mobile-admin): explicit install row backed by beforeinstallprompt capture"
```

---

### Task 11: Offline verification, docs, owed walkthrough

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `docs/walkthroughs-owed.md`

- [ ] **Step 1: Playwright offline pass.** Reuse the Task 6 harness pattern against `http://admin.localhost:3000` at 390x844 with a dev admin JWT:
  - Load `/events`, `await page.evaluate(() => navigator.serviceWorker.ready)`, confirm `(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))` ends with `/admin-sw.js` (first load may need one reload for the SW to take control).
  - **Online-first precondition, stated because `Cache.match` is exact-URL including query string:** while still online, let `/events` finish its data fetches (the reload that gave the SW control populates the cache with the exact request URLs the page uses). Only then go offline.
  - `context.setOffline(true)`, reload: the shell renders (`.m-tabbar` present) and the events list shows data served from the API cache, not a network error screen.
  - Confirm a write fails loudly, not silently: while offline, `page.evaluate(() => fetch('/api/admin/badge-counts', { method: 'POST' }))` rejects (the SW must not answer non-GET).
  - Allowlist check: online, visit a Desktop-view surface (e.g. `/financials/payroll`), then `caches.keys()` + `cache.keys()` in the page must show NO cached entry for any non-allowlisted `/api/` path.
  - Purge check: trigger logout, then `caches.keys()` contains no `admin-api-*` or `admin-meta` cache, AND `localStorage` no longer holds `adminDesktopViewOverrides` / `adminLastRoute`.
  - Kill-path check (the SW outlives a git revert, so prove the exit once): `page.evaluate(() => navigator.serviceWorker.getRegistration('/admin-sw.js').then((r) => r.unregister()))` returns true; after a reload `navigator.serviceWorker.controller` is null. Then reload once more so the layout re-registers and the dev box is left in the normal state.
  - `context.setOffline(false)`, reload, confirm live data returns.
  - Confirm `/admin-manifest.json` loads with status 200 and Chrome sees the manifest link (`document.querySelector('link[rel="manifest"]').href`).

- [ ] **Step 2: Staff-surface regression check.** Load `http://staff.localhost:3000` with a dev staff JWT: the manifest link is `/staff-manifest.json`, no `[data-admin-pwa]` node exists, and no `/admin-sw.js` registration is present (`navigator.serviceWorker.getRegistrations()` contains only the staff worker, if any).

- [ ] **Step 3: Docs.**
  - README: folder-tree entries for `client/public/admin-manifest.json`, `client/public/admin-sw.js`, `client/public/admin-icon-*.png`, `scripts/make-admin-icon.js`, plus the Task 5 entries if not yet landed.
  - ARCHITECTURE.md: extend the web-push/PWA section with the admin surface: admin manifest + `admin-sw.js` (push display, offline shell, stamped `/api/` read cache, never intercepts writes), host-gated injector.
  - `docs/walkthroughs-owed.md`: append one line: install on the Pixel, offline open, tab nav, Desktop-view round-trip, owed once ma-b-pwa merges.

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md docs/walkthroughs-owed.md
git commit -m "docs(mobile-admin): PWA surface docs and owed on-device walkthrough"
```

---

## Self-Review (updated 2026-08-14 after the plan-fleet fold-in)

1. **Spec coverage:** section 3 (fork, shell, escape hatch, tabs, badges, Visual contract chrome elements) = Tasks 1-5; section 7 install = Tasks 7-8, 10; section 7 offline incl. purge and staleness formatting = Task 9; section 9 route restore + dead-route fallback mechanism = Tasks 3, 5 (screens dispatch the event later); section 9 list scroll restore = ma-e/ma-f scopes; section 10 Sentry surface tag = Task 5. Sections 4-6, 7-push, 8 are declared lanes with owners, deliberately not in this plan.
2. **Placeholder scan:** the icon art is an explicit placeholder with a stable-filename contract and a named replacing lane (ma-g-design-fit); no TBDs elsewhere.
3. **Type consistency:** `useMobileView` returns `{ isPhone, desktopView(screenKey), setDesktopView(screenKey, on) }` everywhere it is consumed (Tasks 4, 5, 8); `markStaleFromHeaders` / `formatStaleAt` / `announceAdminSwUser` / `purgeMobileAdminState` are defined and consumed under one name each; screen keys flow `routeScreenKey` -> `desktopView`/`setDesktopView`/`screenTitle` with the same strings.
4. **Fleet round:** the 2026-08-14 plan fleet's 9 blockers and 10 warnings are folded (benchmark inputs + ui-ux-review, adminOnly filter, purge of phone local state, dead-route fallback, Task 4 checkpoint, SW rollback recipe + kill-path verification, jest-dom imports, hashed-filename cache-first guard, announce ordering, activate-purge version prefix, late-response stamp refresh, full-suite run on the interceptor change, icon tofu check, harness-pattern wording, theme-color mutation, exact-URL offline precondition).

## Lane review round, as-built deltas (ma-a-shell, 2026-08-14)

The lane's three-agent fleet (code-review, consistency-check, ui-ux-review)
returned findings after Tasks 1-6; commit `0b7db1dc` in the lane applied them.
Where this section disagrees with a Task snippet above, AS-BUILT WINS:

- **Restore ordering (critical):** the plan's Step 5 effect pair was dead on
  arrival; the record effect flushes first and overwrites the saved route.
  As built, the restore target is captured in a lazy `useState` initializer
  during the first render, then navigated in a mount effect.
- **`mobile-route-dead` contract:** persistent listener (not once) gated on
  `mobileChrome`, so every dead route falls back and desktop can never be
  yanked. Screen lanes dispatch as planned.
- **Back arrow:** falls back to the parent list when `history.state.idx` is 0
  (a restored cold launch has no in-app history; `navigate(-1)` would exit
  the PWA).
- **Sentry tag:** cleared on unmount.
- **`desktopViewStore` API:** `readOverrides()` + `persistOverrides(map)`;
  the context owns the merge (storage-blocked browsers no longer drop other
  screens' overrides). `writeOverride` no longer exists.
- **MorePage:** Payroll row admin-gated (payroll API is admin-only; managers
  got a page of 403s); per-row neutral badges from the chrome's
  `<Outlet context={{ badges }}>`; a Lighting section (After Hours / House
  Lights via `useUserPrefs`) because the phone otherwise has no skin control.
- **MobileHeader:** title is a `.m-title` span (desktop pages inside the
  chrome bring their own h1); detail variant drops the search button; the
  More screen drops the Desktop-view escape.
- **MobileTabBar:** active tab derived from the pathname (More lights up on
  every More-reached surface); badges aria-hidden with the count in the
  NavLink's aria-label.
- **screenTitle:** falls through to nav LABELS by first URL segment
  ("staffing" is "Staff", "blog" is "Lab Notes"), `financials` mapped to
  "Payroll" by hand.
- **CSS:** `.m-main` sets `background: var(--bg-0)` + `min-height: 0` (the
  unscoped legacy `main {}` chalkboard rule leaks in otherwise); House Lights
  geometry ported for `.m-*`; `.m-more-row` 13px and heading tracking 0.1em
  per the design system; return pill `z-index: 39` (deliberately below the
  mobile-nav drawer tier); new `.m-more-badge` / `.m-seg*` rules.
- **Note for ma-b:** `--fs-meta` does not exist in `index.css`; `.m-stale`
  ships with a literal fallback. Do not lean on that token.
