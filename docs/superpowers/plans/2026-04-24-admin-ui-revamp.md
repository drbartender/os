# Admin UI Revamp Implementation Plan — Dr. Bartender OS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully replace the `/admin/*` UI with the new "Dr. Bartender OS" design system, rewriting every admin page, shell, and detail view against handoff JSX prototypes while preserving all existing backend behavior.

**Architecture:** New CSS-grid shell (Sidebar + Header + Main) with per-user persisted skin / density / sidebar-rail preferences; right-slide drawers for quick-peek + full detail pages for editing; all pages rewritten in vanilla CSS + plain React against existing REST endpoints. No backend or DB changes.

**Tech Stack:** React 18, React Router 6, vanilla CSS in `client/src/index.css`, axios via `client/src/utils/api.js`, Inter + JetBrains Mono fonts.

**Spec:** `docs/superpowers/specs/2026-04-24-admin-ui-revamp-design.md`
**Handoff bundle (v2):** `C:\Users\dalla\Downloads\Dr Bartender-handoff (2)\dr-bartender\project\admin-os\`

**Verification pattern** (no TDD — this is UI restyling; the repo has almost no test suite and relies on the 5-agent review fleet + manual QA):
1. `cd client && npm run build` — must succeed with no new warnings.
2. `npm run dev` — open `http://localhost:3000/admin/*` routes and click through.
3. Pre-push: the mandatory 5-agent review fleet catches regressions.

---

## Reference map — which handoff file powers which task

| Handoff file | Exports | Used in task(s) |
|---|---|---|
| `styles.css` | Full CSS (1860 LOC, 2 skins) | 1.1 |
| `icons.jsx` | `Icon`, `ICONS` | 1.4 |
| `data.jsx` | `NAV`, helpers (`fmt$`, `fmtDate`, `relDay`, `dayDiff`) | 1.5, 1.6 |
| `shell.jsx` | `Sidebar`, `Header`, `Palette` | 1.6 |
| `dashboard.jsx` | `Dashboard`, `StatusChip`, `eventStatusChip`, `StaffPills`, `AreaChart`, `Sparkline` | 2.1 |
| `pages.jsx` | `EventsPage`, `ProposalsPage`, `ClientsPage`, `StaffPage`, `HiringPage`, `FinancialsPage`, `Toolbar` | 3, 4, 5, 6 |
| `drawers.jsx` | `EventDrawer`, `ProposalDrawer`, `ClientDrawer` | 3.2, 4.2, 5.2 |
| `detail-pages.jsx` | `EventDetailPage`, `ProposalDetailPage`, `ClientDetailPage` | 3.3, 4.3, 5.3 |
| `proposal-create.jsx` | `ProposalCreatePage` | 4.4 |
| `staff-detail.jsx` | `StaffDetailPage`, `ApplicationDetailPage` | 6.2, 6.3 |
| `drink-plans.jsx` | `DrinkPlansPage`, `DrinkPlanDetailPage` | 7.1 |
| `drink-library.jsx` | `DrinkLibraryPage`, `DRINKS`, `SURCHARGE_RULES` | 7.2 |
| `email-marketing.jsx` | `EmailHubPage`, `LeadsPage`, `LeadDetailPage`, `CampaignsPage`, `CampaignDetailPage`, `CampaignCreatePage`, `EmailAnalyticsPage`, `ConversationsPage` | 8 |

---

## Phase 1 — Design system foundation

Goal: new shell renders; existing pages load inside it; user preferences persist; no page has been visually rewritten yet.

### Task 1.1 — Port design CSS into `index.css`

**Files:**
- Read: handoff `styles.css` (1860 LOC, lines 1–1860)
- Modify: `client/src/index.css` — delete old admin block, append new Admin OS block

- [ ] **Step 1: Grep for every admin-specific CSS selector currently in use**

Run:
```bash
grep -n "^\.admin-\|^\.site-header\|^\.admin-" client/src/index.css | head -40
```

Expected: lists `.admin-page`, `.admin-shell`, `.admin-sidebar`, `.admin-sidebar-nav`, `.admin-nav-item`, `.admin-nav-icon`, `.admin-sidebar-divider`, `.admin-content`, `.admin-breadcrumbs`, `.admin-sidebar-toggle`, `.admin-sidebar-overlay`, `.admin-grid`, `.admin-table`, `.site-header` — plus nested rules for each.

- [ ] **Step 2: Delete the existing admin block**

Delete every `.admin-*` rule from `client/src/index.css` (approximate range: lines 72–100 for `.admin-page`, 505–825 for `.site-header` + `.admin-grid`, 1045–1440 for `.admin-table` + `.admin-shell` + `.admin-sidebar` + `.admin-nav-item` + `.admin-breadcrumbs` + overlay). Leave the top `:root` custom props untouched for now — the new Admin OS tokens will be scoped under `[data-skin]` attributes, not `:root`.

Verify nothing from the public site uses these: `grep -n "admin-shell\|admin-sidebar\|admin-nav-item\|admin-breadcrumbs\|admin-table" client/src -r --include="*.js"` — all references should be inside admin pages or `AdminLayout.js` / `AdminBreadcrumbs.js`, which we're replacing.

- [ ] **Step 3: Append the Admin OS CSS block**

At the end of `client/src/index.css`, append a divider comment and the **entire contents** of handoff `styles.css` (lines 1–1860) verbatim. Prefix the block with:

```css
/* ==========================================================================
   Admin OS — Dr. Bartender admin design system
   Ported from handoff bundle 2 (2026-04-24).
   Two skins: dark (Darkroom) + light (Atelier). Palette-driven via HSL
   custom properties written by UserPrefsContext.
   ========================================================================== */
```

No edits to the bundle CSS — drop it in as-is so future diffs are clean.

- [ ] **Step 4: Build and verify**

Run `cd client && npm run build` — must succeed. Output: "Compiled successfully" with no new warnings.

- [ ] **Step 5: Commit**

```bash
git add client/src/index.css
git commit -m "feat(admin-os): port design system CSS into index.css"
```

### Task 1.2 — Add Inter + JetBrains Mono fonts

**Files:**
- Modify: `client/public/index.html`

- [ ] **Step 1: Edit head**

In `client/public/index.html` between the existing preconnect lines and `</head>`, insert:

```html
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
```

(Libre Caslon Text is used only on the Atelier light skin — per the bundle's override. Inter and JetBrains Mono are always loaded.)

- [ ] **Step 2: Build**

Run `cd client && npm run build` — expect success.

- [ ] **Step 3: Commit**

```bash
git add client/public/index.html
git commit -m "feat(admin-os): load Inter + JetBrains Mono + Libre Caslon fonts"
```

### Task 1.3 — Create `UserPrefsContext`

Admin-scoped preferences: skin, density, sidebar. Persists per-user in localStorage.

**Files:**
- Create: `client/src/context/UserPrefsContext.js`

- [ ] **Step 1: Write the context module**

Create `client/src/context/UserPrefsContext.js`:

```js
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';

const DEFAULT_PREFS = { skin: 'dark', density: 'normal', sidebar: 'full' };

// Cobalt rainbow for Darkroom / deep-green jewel for Atelier.
// These mirror the palette object in the handoff index.html App() useEffect.
const PALETTES = {
  dark: {
    accent: { h: 212, s: 78, l: 44 },
    ok:     { h: 168, s: 62 },
    warn:   { h: 192, s: 72 },
    danger: { h: 262, s: 62 },
    info:   { h: 224, s: 72 },
    violet: { h: 280, s: 68 },
  },
  light: {
    accent: { h: 120, s: 16, l: 20 },
    ok:     { h: 120, s: 16 },
    warn:   { h: 36,  s: 62 },
    danger: { h: 10,  s: 58 },
    info:   { h: 208, s: 36 },
    violet: { h: 280, s: 40 },
  },
};

const FONTS = {
  dark:  { ui: "'Inter', system-ui, sans-serif",
           display: "'Inter', system-ui, sans-serif",
           mono: "'JetBrains Mono', ui-monospace, monospace",
           numeric: "'JetBrains Mono', ui-monospace, monospace" },
  light: { ui: "'Inter', system-ui, sans-serif",
           display: "'Libre Caslon Text', Georgia, serif",
           mono: "'JetBrains Mono', ui-monospace, monospace",
           numeric: "'Libre Caslon Text', Georgia, serif" },
};

const UserPrefsContext = createContext(null);

function storageKey(user) {
  if (!user?.id) return null;
  return `drb-admin-prefs-${user.id}`;
}

function load(user) {
  const key = storageKey(user);
  if (!key) return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function UserPrefsProvider({ children }) {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);

  // Re-hydrate when user identity changes (login/logout).
  useEffect(() => {
    setPrefs(load(user));
  }, [user?.id]);

  // Persist on every change once we have a user.
  useEffect(() => {
    const key = storageKey(user);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(prefs)); } catch {}
  }, [prefs, user?.id]);

  // Apply prefs to <html> so the Admin OS CSS selectors take effect.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.skin = prefs.skin;
    root.dataset.density = prefs.density;
    root.dataset.sidebar = prefs.sidebar;
    root.dataset.palette = 'rainbow';

    const p = PALETTES[prefs.skin] || PALETTES.dark;
    root.style.setProperty('--accent-h', p.accent.h);
    root.style.setProperty('--accent-s', p.accent.s + '%');
    if (p.accent.l != null) root.style.setProperty('--accent-l', p.accent.l + '%');
    root.style.setProperty('--ok-h', p.ok.h);
    root.style.setProperty('--ok-s', p.ok.s + '%');
    root.style.setProperty('--warn-h', p.warn.h);
    root.style.setProperty('--warn-s', p.warn.s + '%');
    root.style.setProperty('--danger-h', p.danger.h);
    root.style.setProperty('--danger-s', p.danger.s + '%');
    root.style.setProperty('--info-h', p.info.h);
    root.style.setProperty('--info-s', p.info.s + '%');
    root.style.setProperty('--violet-h', p.violet.h);
    root.style.setProperty('--violet-s', p.violet.s + '%');

    const f = FONTS[prefs.skin] || FONTS.dark;
    root.style.setProperty('--font-ui', f.ui);
    root.style.setProperty('--font-display', f.display);
    root.style.setProperty('--font-mono', f.mono);
    root.style.setProperty('--font-numeric', f.numeric);
  }, [prefs]);

  const setPref = useCallback((key, value) => {
    setPrefs(p => ({ ...p, [key]: value }));
  }, []);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);
  return <UserPrefsContext.Provider value={value}>{children}</UserPrefsContext.Provider>;
}

export function useUserPrefs() {
  const ctx = useContext(UserPrefsContext);
  if (!ctx) throw new Error('useUserPrefs must be used inside UserPrefsProvider');
  return ctx;
}
```

- [ ] **Step 2: Wire the provider into `App.js`**

Modify `client/src/App.js` — import and nest `UserPrefsProvider` inside `AuthProvider` (since it needs `useAuth`):

```js
import { UserPrefsProvider } from './context/UserPrefsContext';
```

In the `App` component bottom, change:

```jsx
<AuthProvider>
  <ClientAuthProvider>
```

to:

```jsx
<AuthProvider>
  <UserPrefsProvider>
    <ClientAuthProvider>
```

And close the tag correspondingly before `</AuthProvider>`.

- [ ] **Step 3: Build**

Run `cd client && npm run build` — expect success.

- [ ] **Step 4: Manual verify**

Run `cd client && npm start`. Log in as an admin. Open DevTools Console and run:
```js
document.documentElement.dataset.skin
```
Expect `"dark"` (the default). Then:
```js
localStorage.getItem('drb-admin-prefs-' + <your-user-id>)
```
Expect the stored JSON `{"skin":"dark","density":"normal","sidebar":"full"}`.

- [ ] **Step 5: Commit**

```bash
git add client/src/context/UserPrefsContext.js client/src/App.js
git commit -m "feat(admin-os): per-user skin/density/sidebar preferences context"
```

### Task 1.4 — Create shared `Icon` component

**Files:**
- Create: `client/src/components/adminos/Icon.js`

- [ ] **Step 1: Port handoff `icons.jsx` to a CommonJS-friendly ES module**

Create `client/src/components/adminos/Icon.js`. Copy the entire `ICONS` map from handoff `icons.jsx` (lines 13–58), and wrap in a named-export React component:

```js
import React from 'react';

const ICONS = {
  home: <><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5Z"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></>,
  // ... copy EVERY entry from the handoff file, preserving exact paths ...
  moon: <><path d="M20 15.5A8 8 0 0 1 8.5 4a8 8 0 1 0 11.5 11.5Z"/></>,
};

export default function Icon({ name, size = 14, ...rest }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {paths}
    </svg>
  );
}

export { ICONS };
```

Copy every single `ICONS` entry from the handoff file — not just the ones shown above. The list is: home, calendar, clipboard, users, userplus, dollar, pen, mail, gear, search, plus, bell, filter, sort, down, right, up, x, check, clock, pin, location, phone, external, copy, trend_up, trend_down, alert, sparkles, chevrons, grip, kebab, logout, eye, flask, book, list, card, panel, arrow_right, send, sun, moon.

- [ ] **Step 2: Build**

Run `cd client && npm run build` — expect success.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/adminos/Icon.js
git commit -m "feat(admin-os): Icon component with full handoff icon set"
```

### Task 1.5 — Nav config + formatter helpers

**Files:**
- Create: `client/src/components/adminos/nav.js`
- Create: `client/src/components/adminos/format.js`

- [ ] **Step 1: Write nav config**

Create `client/src/components/adminos/nav.js`:

```js
// Nav groups for the Admin OS sidebar.
// badgeKey maps to the /api/admin/badge-counts response shape.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Dashboard', icon: 'home',      path: '/admin/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/admin/events',   badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/admin/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/admin/clients' },
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/admin/staffing' },
    { id: 'hiring',      label: 'Hiring',    icon: 'pen',       path: '/admin/hiring',    badgeKey: 'new_applications' },
  ]},
  { section: 'Revenue', items: [
    { id: 'financials',  label: 'Financials', icon: 'dollar',   path: '/admin/financials' },
    { id: 'marketing',   label: 'Marketing',  icon: 'mail',     path: '/admin/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'drink-plans', label: 'Drink Plans',   icon: 'flask', path: '/admin/drink-plans' },
    { id: 'menu',        label: 'Cocktail Menu', icon: 'flask', path: '/admin/cocktail-menu' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'book',  path: '/admin/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',  path: '/admin/settings' },
  ]},
];

export default NAV;
```

- [ ] **Step 2: Write formatters**

Create `client/src/components/adminos/format.js` — port the helpers from handoff `data.jsx` lines 157–179:

```js
export const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const fmt$cents = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = (iso, opts = {}) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...opts });
};
export const fmtDateFull = (iso) => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const dayDiff = (iso) => {
  const d = new Date(iso + 'T12:00:00');
  const t = new Date(); t.setHours(12, 0, 0, 0);
  return Math.round((d - t) / 86400000);
};
export const relDay = (iso) => {
  const diff = dayDiff(iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 0) return `In ${diff}d`;
  return `${Math.abs(diff)}d ago`;
};
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/adminos/nav.js client/src/components/adminos/format.js
git commit -m "feat(admin-os): nav config + date/currency formatters"
```

### Task 1.6 — Rewrite `AdminLayout` with new shell

**Files:**
- Modify: `client/src/components/AdminLayout.js` (full rewrite)
- Create: `client/src/components/adminos/Sidebar.js`
- Create: `client/src/components/adminos/Header.js`
- Delete: `client/src/components/AdminBreadcrumbs.js` (unused after this)

- [ ] **Step 1: Write `Sidebar.js`**

Create `client/src/components/adminos/Sidebar.js`. Port handoff `shell.jsx` `Sidebar` (lines 7–60) with these adjustments:
- Replace hardcoded `NAV` import with our own: `import NAV from './nav';`
- Replace the local `Icon` component with: `import Icon from './Icon';`
- Replace hardcoded "Stephen Paeth" / "Owner · Dr. Bartender" with `useAuth().user.name` and `user.role`.
- `setRoute` → use `useNavigate()` from react-router-dom, navigate to `item.path` on click.
- Active state: read `useLocation().pathname` and mark items active when `pathname.startsWith(item.path)`.
- `onToggleSkin` → call `setPref('skin', prefs.skin === 'dark' ? 'light' : 'dark')` from `useUserPrefs()`.
- Add a rail-collapse toggle above the Sterile/Experimental toggle: a small chevron button that flips `prefs.sidebar` between `'full'` and `'rail'` (drop the 3-way radio entirely).
- Badges: accept a `badges` prop (object keyed by `badgeKey`) and render `<span class="nav-badge">` when `badges[item.badgeKey] > 0`.
- Logout: on click of the sign-out icon button, call `logout()` from `useAuth()` and navigate to `/login`.

Full component template:

```js
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useUserPrefs } from '../../context/UserPrefsContext';
import Icon from './Icon';
import NAV from './nav';

export default function Sidebar({ badges = {} }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const { prefs, setPref } = useUserPrefs();

  const initials = (user?.name || user?.email || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">℞</div>
        <div className="sidebar-brand-text">Dr. Bartender <span className="muted">OS</span></div>
      </div>
      <nav className="sidebar-nav scroll-thin">
        {NAV.map(group => (
          <React.Fragment key={group.section}>
            <div className="sidebar-section">{group.section}</div>
            {group.items.map(item => {
              const active = pathname === item.path || pathname.startsWith(item.path + '/');
              return (
                <div key={item.id}
                  className={`nav-item ${active ? 'active' : ''}`}
                  onClick={() => navigate(item.path)}>
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                  {item.badgeKey && badges[item.badgeKey] > 0 && (
                    <span className="nav-badge">{badges[item.badgeKey]}</span>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-action"
          title={prefs.sidebar === 'rail' ? 'Expand sidebar' : 'Collapse to rail'}
          onClick={() => setPref('sidebar', prefs.sidebar === 'rail' ? 'full' : 'rail')}
          style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '6px 0' }}
        >
          <Icon name={prefs.sidebar === 'rail' ? 'right' : 'chevrons'} size={13} />
        </button>
        <div className="mode-toggle" role="radiogroup" aria-label="Visual mode">
          <button type="button" role="radio" aria-checked={prefs.skin === 'light'}
            className={`mode-opt ${prefs.skin === 'light' ? 'active' : ''}`}
            onClick={() => prefs.skin !== 'light' && setPref('skin', 'light')}>Sterile</button>
          <button type="button" role="radio" aria-checked={prefs.skin === 'dark'}
            className={`mode-opt ${prefs.skin === 'dark' ? 'active' : ''}`}
            onClick={() => prefs.skin !== 'dark' && setPref('skin', 'dark')}>Experimental</button>
        </div>
      </div>
      <div className="sidebar-footer sidebar-footer--user">
        <div className="avatar">{initials}</div>
        <div className="sidebar-footer-main">
          <div className="sidebar-footer-name">{user?.name || user?.email}</div>
          <div className="sidebar-footer-role">{user?.role === 'admin' ? 'Admin' : user?.role === 'manager' ? 'Manager' : 'User'} · Dr. Bartender</div>
        </div>
        <button className="sidebar-footer-action" title="Sign out" onClick={() => { logout(); }}>
          <Icon name="logout" size={13} />
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Write `Header.js`**

Create `client/src/components/adminos/Header.js`:

```js
import React from 'react';
import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import NAV from './nav';

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
      <button type="button" className="header-search" onClick={onOpenPalette}>
        <Icon name="search" />
        <span>Search events, clients, proposals…</span>
        <span className="kbd-group" style={{ display: 'flex', gap: 2 }}>
          <span className="kbd">⌘</span><span className="kbd">K</span>
        </span>
      </button>
      <div className="header-actions">
        <button type="button" className="icon-btn" title="Notifications">
          <Icon name="bell" />
          {unreadCount > 0 && <span className="dot" />}
        </button>
        <button type="button" className="icon-btn" title="Quick add" onClick={onQuickAdd}>
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Rewrite `AdminLayout.js`**

Replace the entire contents of `client/src/components/AdminLayout.js`:

```js
import React, { useEffect, useState, useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import Sidebar from './adminos/Sidebar';
import Header from './adminos/Header';
import CommandPalette from './adminos/CommandPalette';

export default function AdminLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [badges, setBadges] = useState({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const fetchBadges = () => {
      api.get('/admin/badge-counts').then(r => setBadges(r.data)).catch(() => {});
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    return () => clearInterval(interval);
  }, []);

  const onKey = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(v => !v);
    } else if (e.key === 'Escape') {
      setPaletteOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className="shell">
        <Sidebar badges={badges} />
        <Header onOpenPalette={() => setPaletteOpen(true)} onQuickAdd={() => navigate('/admin/proposals/new')} />
        <main className="main scroll-thin" id="main-content">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
```

- [ ] **Step 4: Delete `AdminBreadcrumbs.js`**

```bash
rm client/src/components/AdminBreadcrumbs.js
```

- [ ] **Step 5: Build — expect a missing-module error for `CommandPalette`**

Run `cd client && npm run build` — expect **FAILURE**: `Can't resolve './adminos/CommandPalette'`. We fix that in Task 1.7. (Do not commit yet.)

### Task 1.7 — Build `CommandPalette` (skeleton)

**Files:**
- Create: `client/src/components/adminos/CommandPalette.js`

- [ ] **Step 1: Write component**

Port handoff `shell.jsx` `Palette` (lines 93–149) with real navigation:

```js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  useEffect(() => { if (open) setQ(''); }, [open]);

  const actions = [
    { group: 'Jump to', items: [
      { label: 'Dashboard', icon: 'home',      onClick: () => navigate('/admin/dashboard') },
      { label: 'Events',    icon: 'calendar',  onClick: () => navigate('/admin/events') },
      { label: 'Proposals', icon: 'clipboard', onClick: () => navigate('/admin/proposals') },
      { label: 'Clients',   icon: 'users',     onClick: () => navigate('/admin/clients') },
      { label: 'Staff',     icon: 'userplus',  onClick: () => navigate('/admin/staffing') },
      { label: 'Hiring',    icon: 'pen',       onClick: () => navigate('/admin/hiring') },
      { label: 'Financials',icon: 'dollar',    onClick: () => navigate('/admin/financials') },
      { label: 'Marketing', icon: 'mail',      onClick: () => navigate('/admin/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',   onClick: () => navigate('/admin/drink-plans') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: () => navigate('/admin/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: () => navigate('/admin/email-marketing/campaigns/new') },
    ]},
    // Records group — stubbed. Replace with real /api/admin/search results in follow-up.
    { group: 'Records', items: [] },
  ];

  const filtered = actions.map(g => ({
    ...g,
    items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase())),
  })).filter(g => g.items.length);

  if (!open) return null;

  return (
    <div className="palette-scrim open" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input autoFocus placeholder="Type a command or search…" value={q} onChange={e => setQ(e.target.value)} />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list scroll-thin">
          {filtered.map(g => (
            <div key={g.group}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => (
                <div key={it.label} className="palette-item" onClick={() => { it.onClick(); onClose(); }}>
                  <Icon name={it.icon} />
                  <div>
                    <div>{it.label}</div>
                    {it.sub && <div className="tiny muted">{it.sub}</div>}
                  </div>
                  <div className="shortcut"><span className="kbd">↵</span></div>
                </div>
              ))}
            </div>
          ))}
          {!filtered.length && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run `cd client && npm run build` — expect success.

- [ ] **Step 3: Manual verify**

Run `cd client && npm start` + `npm run dev` (in repo root). Log in as admin. Expect the new sidebar + header to render. Existing pages look broken (no .admin-table styles) — that's expected; we'll rewrite them in phases 2–9. Press `⌘K` / `Ctrl+K`: palette opens. Type "events": filters. Click: navigates. Toggle Sterile/Experimental: skin swaps. Click the sidebar rail toggle: collapses to icons-only. Reload: prefs persist.

- [ ] **Step 4: Commit the entire shell migration**

```bash
git add client/src/components/AdminLayout.js client/src/components/adminos/ client/src/components/AdminBreadcrumbs.js
git commit -m "feat(admin-os): new shell — Sidebar + Header + CommandPalette skeleton"
```

### Task 1.8 — Create drawer primitive + URL hook

**Files:**
- Create: `client/src/components/adminos/Drawer.js`
- Create: `client/src/hooks/useDrawerParam.js`

- [ ] **Step 1: Write `Drawer.js`**

```js
import React, { useEffect } from 'react';
import Icon from './Icon';

export default function Drawer({ open, onClose, crumb, children, onOpenPage }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <div className={`drawer ${open ? 'open' : ''}`}>
        <div className="drawer-head">
          {crumb}
          {onOpenPage && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPage}>
              <Icon name="external" size={11} />Open page
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close drawer">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body scroll-thin">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Write `useDrawerParam` hook**

```js
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// Reads/writes ?drawer=kind&drawerId=id from the URL. Layered on top of
// whatever other params the page uses — never touches them.
export default function useDrawerParam() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('drawer');
  const id = params.get('drawerId');

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

  return { kind, id, open, close };
}
```

- [ ] **Step 3: Build**

`cd client && npm run build` — expect success.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/adminos/Drawer.js client/src/hooks/useDrawerParam.js
git commit -m "feat(admin-os): Drawer primitive + ?drawer= URL hook"
```

### Task 1.9 — Reusable page primitives (chips, stats, sparklines)

**Files:**
- Create: `client/src/components/adminos/StatusChip.js`
- Create: `client/src/components/adminos/StaffPills.js`
- Create: `client/src/components/adminos/AreaChart.js`
- Create: `client/src/components/adminos/Sparkline.js`
- Create: `client/src/components/adminos/Toolbar.js`

- [ ] **Step 1: Port each component verbatim from handoff**

For each component below, port the source JSX from the handoff bundle adding a default export:

- `StatusChip.js` — from `dashboard.jsx` lines 7–9.
  ```js
  import React from 'react';
  export default function StatusChip({ kind = 'neutral', children, dot = true }) {
    return <span className={`chip ${kind}`}>{dot && <span className="chip-dot" />}{children}</span>;
  }
  ```
- `StaffPills.js` — from `dashboard.jsx` lines 18–35.
  ```js
  import React from 'react';
  export default function StaffPills({ positions = [] }) {
    const filled = positions.filter(p => p.status === 'approved').length;
    const pending = positions.filter(p => p.status === 'pending').length;
    const total = positions.length;
    const shortBy = total - filled - pending;
    return (
      <span className="hstack" style={{ gap: 6 }}>
        <span className="staff-pills">
          {positions.map((p, i) => (
            <span key={i} className={`staff-pill ${p.status === 'approved' ? 'filled' : p.status === 'pending' ? 'pending' : ''}`}
              title={`${p.role}${p.name ? ': ' + p.name : ' (open)'}`} />
          ))}
        </span>
        <span className={`staff-count ${shortBy > 0 ? 'short' : ''}`}>
          {filled}/{total}{shortBy > 0 && ` · ${shortBy} open`}
        </span>
      </span>
    );
  }
  ```
- `AreaChart.js` — from `dashboard.jsx` lines 40–91. Port the full SVG component verbatim; it reads `document.documentElement.dataset.palette` internally which `UserPrefsContext` already sets. Export as default.
- `Sparkline.js` — from `dashboard.jsx` lines 93–117. Port verbatim, default export.
- `Toolbar.js` — from `pages.jsx` lines 7–22.
  ```js
  import React from 'react';
  import Icon from './Icon';
  export default function Toolbar({ search, setSearch, tabs, tab, setTab, filters, right }) {
    return (
      <div className="hstack" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs && (
          <div className="seg">
            {tabs.map(t => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}{t.count != null && <span className="muted" style={{ marginLeft: 6 }}>{t.count}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="input-group" style={{ minWidth: 240, maxWidth: 340, flex: 1 }}>
          <Icon name="search" />
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {filters}
        <div className="spacer" />
        {right}
      </div>
    );
  }
  ```

- [ ] **Step 2: Build**

`cd client && npm run build` — expect success.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/adminos/StatusChip.js client/src/components/adminos/StaffPills.js client/src/components/adminos/AreaChart.js client/src/components/adminos/Sparkline.js client/src/components/adminos/Toolbar.js
git commit -m "feat(admin-os): StatusChip + StaffPills + charts + Toolbar primitives"
```

### Task 1.10 — Phase 1 sign-off: manual admin smoke test

- [ ] **Step 1: Start dev server**

Run `npm run dev` at repo root.

- [ ] **Step 2: Log in as admin**

Navigate to `http://localhost:3000/admin`.

- [ ] **Step 3: Verify shell**

- Sidebar renders with Workspace / Revenue / Content groups.
- Header shows breadcrumb + Cmd+K search + bell + plus.
- `⌘K` opens palette; navigating from it works.
- Skin toggle swaps dark/light.
- Rail toggle collapses to icons.
- Reload the page — prefs persist.

- [ ] **Step 4: Verify existing pages still load** (visually broken is OK)

Click every nav item. Each page's route should resolve, the component should mount, no console errors besides CSS layout warnings. Pages will look wrong (no `.admin-*` styles) — that's expected. We fix them in phases 2–9.

No commit here; this is a manual gate before proceeding to Phase 2.

---

## Phase 2 — Dashboard

Goal: `/admin/dashboard` renders the new dashboard using real API data.

### Task 2.1 — Rewrite `Dashboard.js`

**Files:**
- Modify: `client/src/pages/admin/Dashboard.js` (full rewrite)
- Reference: handoff `dashboard.jsx` (303 LOC)

- [ ] **Step 1: Identify the data contract**

The dashboard needs aggregated data. Check existing endpoints:
```bash
grep -rn "router.get.*dashboard\|router.get.*admin.*stats\|badge-counts" server/routes
```

Likely needs the following data — use existing endpoints and/or add one new one:
- Events list: `GET /api/events` (with `?upcoming=1` or similar)
- Proposals list: `GET /api/proposals`
- Staff list: `GET /api/admin/users?role=staff` (via the admin routes)
- Revenue series: if no existing endpoint, add `GET /api/admin/revenue-series` returning `[{ m, booked, collected }]` for the last 12 months (SQL: group `events.event_date` by month; sum `total_cents`/100 and `payments` joined). **If the endpoint doesn't exist, add it in this task** — `server/routes/admin.js`.
- Action queue: derive from the existing data client-side (unstaffed events, unsigned contracts, unpaid balances, new applications).

Decide based on what exists; add only the one new revenue-series endpoint if needed.

- [ ] **Step 2: Write the new `Dashboard.js`**

Template structure (paraphrased from handoff `dashboard.jsx`):

```js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import StaffPills from '../../components/adminos/StaffPills';
import AreaChart from '../../components/adminos/AreaChart';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';

// Helper: event status chip (ports handoff eventStatusChip lines 11-16)
function eventStatusChip(e) {
  if (e.contract_status !== 'signed') return <StatusChip kind="warn">Contract out</StatusChip>;
  if (!e.amount_paid_cents) return <StatusChip kind="warn">No payment</StatusChip>;
  if (e.amount_paid_cents < e.total_cents) return <StatusChip kind="info">Deposit paid</StatusChip>;
  return <StatusChip kind="ok">Paid in full</StatusChip>;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [events, setEvents] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [revenueSeries, setRevenueSeries] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get('/events?upcoming=1'),
      api.get('/proposals'),
      api.get('/admin/revenue-series'),
      api.get('/admin/users?role=staff'),
    ])
      .then(([ev, pr, rev, st]) => {
        if (cancelled) return;
        setEvents(ev.data || []);
        setProposals(pr.data || []);
        setRevenueSeries(rev.data || []);
        setStaff(st.data || []);
      })
      .catch(err => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="page"><div className="muted">Loading dashboard…</div></div>;
  if (error) return <div className="page"><div className="chip danger">Failed to load dashboard</div></div>;

  // … stat derivations + JSX layout identical to handoff dashboard.jsx lines 122-299
  //    but using real field names from your API (event_date, total_cents / 100, etc.)
  //    and navigate() instead of the demo go() function.
}
```

Keep the layout structure one-for-one with the handoff: 5-stat row → `.dash-main` 2-column grid → revenue card + upcoming events table (left column), action queue + pipeline + staff load (right column).

Click handlers: replace `go({ drawer: {...} })` demo pattern with `navigate('/admin/events?drawer=event&drawerId=' + e.id)` so the drawer hook picks it up once Phase 3 lands (for now the navigate is fine — rows just go to the list page).

- [ ] **Step 3: Build + manual check**

`cd client && npm run build` — expect success.
`npm run dev`, open `/admin/dashboard`, verify stats match real data, chart renders, upcoming events list populates.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/Dashboard.js server/routes/admin.js
git commit -m "feat(admin-os): rewrite Dashboard against new design system"
```

---

## Phase 3 — Events flow

### Task 3.1 — Rewrite `EventsDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/EventsDashboard.js` (full rewrite)
- Reference: handoff `pages.jsx` `EventsPage` (lines 27–127)

- [ ] **Step 1: Identify existing data shape**

Read `server/routes/events.js` (or wherever the current events list endpoint lives) to see what fields come back. Map them to the handoff shape: `id, client_name, event_type, event_date, start_time, end_time, location, guest_count, positions, needed, total, paid, status, contract, payment, package, notes`.

- [ ] **Step 2: Write new EventsDashboard**

Structure (see handoff `pages.jsx` 27–127): `page-header` → `Toolbar` with upcoming/unstaffed/past/all tabs + search + status-filter select → `.card` wrapper around `.tbl` → row-click opens drawer.

Replace demo `EVENTS` import with `api.get('/events')`. On row click, call `drawer.open('event', e.id)` from `useDrawerParam()`.

- [ ] **Step 3: Build + manual check**

Open `/admin/events`. Tabs filter correctly. Search filters. Status filter works. Row click updates the URL to `?drawer=event&drawerId=…`.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/EventsDashboard.js
git commit -m "feat(admin-os): rewrite Events list page"
```

### Task 3.2 — Build `EventDrawer`

**Files:**
- Create: `client/src/components/adminos/drawers/EventDrawer.js`
- Modify: `client/src/pages/admin/EventsDashboard.js` — mount the drawer

- [ ] **Step 1: Port `drawers.jsx` EventDrawer (lines 7–101)**

Template:

```js
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmt$, fmt$cents, fmtDate, fmtDateFull, relDay } from '../format';

export default function EventDrawer({ id, open, onClose }) {
  const navigate = useNavigate();
  const [e, setE] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !id) { setE(null); return; }
    setLoading(true);
    api.get(`/events/${id}`)
      .then(r => setE(r.data))
      .catch(() => setE(null))
      .finally(() => setLoading(false));
  }, [id, open]);

  const crumb = (
    <div className="crumb">
      <Icon name="calendar" />
      <span>Events</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>{e?.client_name || '—'}</span>
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      crumb={crumb}
      onOpenPage={() => { onClose(); navigate(`/admin/events/${id}`); }}
    >
      {loading && <div className="muted">Loading…</div>}
      {!loading && !e && <div className="muted">Event not found.</div>}
      {e && /* Full hero + staffing + financial + notes + activity sections — see handoff drawers.jsx lines 28–96 */}
    </Drawer>
  );
}
```

Port the full hero + staffing + financial + notes + activity sections verbatim from handoff lines 28–96, mapping handoff field names to your API response (`e.positions`, `e.paid`, `e.total`, etc. → map to whatever your `/events/:id` returns).

- [ ] **Step 2: Mount in EventsDashboard**

In `EventsDashboard.js` (from Task 3.1), add:

```js
import useDrawerParam from '../../hooks/useDrawerParam';
import EventDrawer from '../../components/adminos/drawers/EventDrawer';

// ... inside component:
const drawer = useDrawerParam();

// ... at bottom of return, after the card:
<EventDrawer
  id={drawer.kind === 'event' ? drawer.id : null}
  open={drawer.kind === 'event'}
  onClose={drawer.close}
/>
```

And replace row onClick:
```js
onClick={() => drawer.open('event', e.id)}
```

- [ ] **Step 3: Build + manual check**

`/admin/events` → click row → drawer opens with animation. URL reflects `?drawer=event&drawerId=…`. Back button closes. "Open page" navigates to detail. Esc closes.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/adminos/drawers/EventDrawer.js client/src/pages/admin/EventsDashboard.js
git commit -m "feat(admin-os): EventDrawer + mount in Events list"
```

### Task 3.3 — Build `EventDetailPage`

**Files:**
- Create: `client/src/pages/admin/EventDetailPage.js` (new)
- Modify: `client/src/App.js` — route `/admin/events/:id` to `EventDetailPage` instead of `ProposalDetail`
- Reference: handoff `detail-pages.jsx` `EventDetailPage` (lines 499–687)

- [ ] **Step 1: Write `EventDetailPage.js`**

Port handoff `EventDetailPage` structure (identity bar card + 2-column grid: left column = agenda/staffing/line-items-summary/activity; right column = financial summary/contract/contact). Replace demo data with `api.get('/events/' + id)`. Use `useParams` for the id and `useNavigate` for back button.

The event detail needs to subsume what `ShiftDetail.js` currently does — staffing requests, assignments, SMS blast. Cross-reference the existing `ShiftDetail.js` source for the actions and fold them into the Staffing section of the new page.

- [ ] **Step 2: Update routes in `App.js`**

At `client/src/App.js` line 341, change:
```js
<Route path="events/:id" element={<ProposalDetail />} />
```
to:
```js
<Route path="events/:id" element={<EventDetailPage />} />
```

And add near the other lazy imports at line ~61:
```js
const EventDetailPage = lazy(() => import('./pages/admin/EventDetailPage'));
```

Keep `<Route path="events/shift/:id" element={<ShiftDetail />} />` for now — deep links into a specific shift still work and render the legacy ShiftDetail.

- [ ] **Step 3: Build + manual check**

Click "Open page" from the EventDrawer. Detail page loads. Back button returns. Staffing actions work (assign, approve, SMS).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/EventDetailPage.js client/src/App.js
git commit -m "feat(admin-os): EventDetailPage replaces Proposal reuse for events"
```

---

## Phase 4 — Proposals flow

### Task 4.1 — Rewrite `ProposalsDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/ProposalsDashboard.js` (full rewrite)
- Reference: handoff `pages.jsx` `ProposalsPage` (lines 140–211)

- [ ] **Step 1: Write new dashboard**

Port handoff layout. Tabs: active / draft / won / all. Real data: `api.get('/proposals')`. Row-click opens `ProposalDrawer`.

- [ ] **Step 2: Build + manual check + commit**

```bash
git add client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(admin-os): rewrite Proposals list page"
```

### Task 4.2 — Build `ProposalDrawer`

**Files:**
- Create: `client/src/components/adminos/drawers/ProposalDrawer.js`
- Modify: `client/src/pages/admin/ProposalsDashboard.js` — mount drawer
- Reference: handoff `drawers.jsx` `ProposalDrawer` (lines 106–154)

- [ ] **Step 1: Port + wire**

Same pattern as EventDrawer: hero with status chip + package tag, meta grid (Sent / Expires / Total), actions row (Resend / Edit / Mark accepted), line items table. Real data: `GET /proposals/:id`.

- [ ] **Step 2: Build + manual check + commit**

```bash
git add client/src/components/adminos/drawers/ProposalDrawer.js client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(admin-os): ProposalDrawer"
```

### Task 4.3 — Rewrite `ProposalDetail.js`

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js` (full rewrite)
- Reference: handoff `detail-pages.jsx` `ProposalDetailPage` (lines 10–269)

- [ ] **Step 1: Port full rewrite**

Critical features from handoff:
- Identity bar card at top (clipboard icon + client_name · event_type + status chip + package tag + event date + sent/expires).
- Segmented control: **Editor** ↔ **Client preview**.
- Editor: left column = line items table (editable), tasks card, activity card; right column = totals card (subtotal / tax / deposit / total), client card (avatar + contact), event details card.
- Client preview: renders what the client sees at the public proposal URL — reuse your existing `<ProposalView>` component if possible, or inline a read-only copy.

Preserve all existing edit functionality (add/remove/edit line items, save, send, resend, mark accepted). This file is 800+ lines in the existing codebase; the rewrite is the single biggest task in the plan. Keep all existing business logic intact; only the JSX/CSS wrapper changes.

- [ ] **Step 2: Build + manual check**

Every existing proposal action must still work: edit line items, save, send, resend, mark paid, apply discounts, capture signature, etc.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(admin-os): rewrite Proposal detail page with Editor/Preview toggle"
```

### Task 4.4 — Rewrite `ProposalCreate.js`

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js` (full rewrite)
- Reference: handoff `proposal-create.jsx` (lines 17–407)

- [ ] **Step 1: Port the 6-step wizard**

Steps (from handoff line 15): `['Client', 'Event', 'Package & drinks', 'Staffing', 'Pricing', 'Review & send']`.

Layout: left column = sticky stepper card; right column = StepBody (one of 6 step components). Each step: `ClientStep`, `EventStep`, `PackageStep`, `StaffingStep`, `PricingStep`, `ReviewStep` — see handoff lines 142–295.

Preserve all existing logic: client search + autocomplete, package selection, per-guest/per-drink pricing math from `server/utils/pricingEngine.js`, staff estimation, discount application, validation, save-draft, send-to-client.

**Hosted-package bartender rule applies** (CLAUDE.md load-bearing rule): any additional bartender line items on hosted packages must be $0. Grep `isHostedPackage` before touching the Staffing or Pricing step.

- [ ] **Step 2: Build + manual check**

Walk through the wizard end-to-end. Create a test proposal. Verify pricing math lines up with what was there before — any drift is a bug.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(admin-os): rewrite Proposal create wizard"
```

---

## Phase 5 — Clients flow

### Task 5.1 — Rewrite `ClientsDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/ClientsDashboard.js`
- Reference: handoff `pages.jsx` `ClientsPage` (lines 218–289)

- [ ] Port list + sort (LTV / Recent / Name) + source chips + row avatars. Real data `GET /clients`.
- [ ] Build + manual check + commit:

```bash
git commit -m "feat(admin-os): rewrite Clients list"
```

### Task 5.2 — Build `ClientDrawer`

**Files:**
- Create: `client/src/components/adminos/drawers/ClientDrawer.js`
- Modify: `ClientsDashboard.js` — mount
- Reference: handoff `drawers.jsx` `ClientDrawer` (lines 159–202)

- [ ] Port hero (avatar + name + contact), meta grid, actions row, "Events" section table. Real data `GET /clients/:id`.
- [ ] Build + manual check + commit:

```bash
git commit -m "feat(admin-os): ClientDrawer"
```

### Task 5.3 — Rewrite `ClientDetail.js`

**Files:**
- Modify: `client/src/pages/admin/ClientDetail.js`
- Reference: handoff `detail-pages.jsx` `ClientDetailPage` (lines 272–497)

- [ ] Port identity bar + 2-column layout (left: proposals + events tables; right: contact + source + tags + LTV stat + notes). Preserve all existing edit/merge/archive logic.
- [ ] Build + manual check + commit:

```bash
git commit -m "feat(admin-os): rewrite Client detail page"
```

---

## Phase 6 — Staff / Hiring / Financials

### Task 6.1 — Rewrite staff list (`AdminDashboard.js` → `StaffDashboard.js`)

The existing `/admin/staffing` route points at `AdminDashboard.js` — a ~1000 LOC file that combines staff listing + application triage. The handoff design separates these: `StaffPage` is a list, `HiringDashboard` is the pipeline.

**Files:**
- Create: `client/src/pages/admin/StaffDashboard.js` (NEW, replaces the staff-list duties of AdminDashboard)
- Modify: `client/src/App.js` — point `/admin/staffing` at `StaffDashboard`, keep `/admin/staffing/users/:id` + `/staffing/applications/:id` under new detail pages.
- Delete later: `client/src/pages/AdminDashboard.js` (in Phase 10 cleanup)

- [ ] Port handoff `pages.jsx` `StaffPage` (lines 294–351): active / onboarding / all tabs + search + row with avatar + role + status chip + phone + rating + shifts month/ytd.
- [ ] Map endpoints: `GET /admin/users?role=staff` (existing).
- [ ] Build + commit:

```bash
git add client/src/pages/admin/StaffDashboard.js client/src/App.js
git commit -m "feat(admin-os): new staff list page (replaces AdminDashboard for list duties)"
```

### Task 6.2 — Rewrite `AdminUserDetail.js`

**Files:**
- Modify: `client/src/pages/AdminUserDetail.js`
- Reference: handoff `staff-detail.jsx` `StaffDetailPage` (lines 7–123)

- [ ] Port identity bar + profile sections (contact, payout, performance, schedule, documents, W-9 status). Preserve every existing action: approve W-9, manage payouts, set role, deactivate, reset password, edit profile, upload docs.
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite staff detail page"
```

### Task 6.3 — Rewrite `AdminApplicationDetail.js`

**Files:**
- Modify: `client/src/pages/AdminApplicationDetail.js`
- Reference: handoff `staff-detail.jsx` `ApplicationDetailPage` (lines 127–239)

- [ ] Port: identity bar + stage stepper (Applied / Screen / Interview / Trail shift / Offer / Rejected) + applicant details + references + notes + actions (advance / reject / note). Preserve existing approve/reject/convert-to-staff logic.
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite application detail page"
```

### Task 6.4 — Rewrite `HiringDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/HiringDashboard.js`
- Reference: handoff `pages.jsx` `HiringPage` (lines 356–386)

- [ ] Port the kanban: 4 cards (Applied / Interview / Offer / Onboarding) each listing applicants with avatar + role + city + relDay. Real data `GET /admin/applications`.
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite Hiring pipeline"
```

### Task 6.5 — Rewrite `FinancialsDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/FinancialsDashboard.js`
- Reference: handoff `pages.jsx` `FinancialsPage` (lines 391–431)

- [ ] Port 5-stat row (Booked / Collected / Outstanding / Avg event / Owed to staff) + Outstanding balances table with Remind button. Preserve the existing Stripe/invoice/export actions.
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite Financials"
```

---

## Phase 7 — Drink Plans + Drink Library

### Task 7.1 — Rewrite `DrinkPlansDashboard.js` + `DrinkPlanDetail.js` + build `DrinkPlanDrawer`

**Files:**
- Modify: `client/src/pages/admin/DrinkPlansDashboard.js`
- Modify: `client/src/pages/admin/DrinkPlanDetail.js`
- Create: `client/src/components/adminos/drawers/DrinkPlanDrawer.js`
- Reference: handoff `drink-plans.jsx` (lines 29–226)

- [ ] Port list (card grid rather than table — handoff uses cards) + drawer + detail page.
- [ ] Drawer shape (freestyle since not in handoff — follow the vocabulary): hero with submitter name + event date + guest count + chip for plan status; meta grid (Event type, Budget, Servings); "Drinks" section title followed by drink pill list; actions: "Turn into proposal", "Email client", "Archive".
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite Drink Plans + drawer"
```

### Task 7.2 — Build new `CocktailMenuDashboard.js` (Drink Library)

**Files:**
- Create: `client/src/pages/admin/CocktailMenuDashboard.js` (NEW)
- Modify: `client/src/App.js` — `/admin/cocktail-menu` now renders CocktailMenuDashboard instead of Navigate-to-settings.
- Reference: handoff `drink-library.jsx` (lines 63–225)

- [ ] Port card-grid of drinks + search + tag chip filters + difficulty indicator + surcharge rules card + menu presets card.
- [ ] Data: if no cocktails endpoint exists, add `GET /api/admin/cocktails` returning the library rows from `server/db/schema.sql` cocktails table (check whether that table exists; the existing `CocktailMenuDashboard.js` in `client/src/pages/admin/` will tell you what endpoint it uses).
- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): new Cocktail Menu / drink library page"
```

---

## Phase 8 — Email Marketing subsystem (8 pages)

Reference: handoff `email-marketing.jsx` — 910 LOC covering `EmailHubPage`, `LeadsPage`, `LeadDetailPage`, `CampaignsPage`, `CampaignDetailPage`, `CampaignCreatePage`, `EmailAnalyticsPage`, `ConversationsPage`.

Existing routes (all nested under `/admin/email-marketing`): leads, leads/:id, campaigns, campaigns/new, campaigns/:id, analytics, conversations.

### Task 8.1 — Rewrite `EmailMarketingDashboard.js` (hub)

- Port `EmailHubPage` (lines 65–196): stat row + tab nav pointing at sub-routes + "Unread conversations" snapshot + "Latest campaign" card + "New leads" list.
- Commit: `feat(admin-os): rewrite Email Marketing hub`

### Task 8.2 — Rewrite `EmailLeadsDashboard.js` + build `LeadDrawer`

- Port `LeadsPage` (lines 198–296): status/source filters, segment chips, bulk actions bar.
- Build `LeadDrawer` freestyle in the vocabulary (hero = lead name + email + source chip; meta = status / score / budget / event type / guest count; sections = Recent activity, Notes, Tags; actions = Reply / Create campaign / Add to segment).
- Commit: `feat(admin-os): rewrite Leads list + drawer`

### Task 8.3 — Rewrite `EmailLeadDetail.js`

- Port `LeadDetailPage` (lines 298–419): identity bar + conversation thread + interaction timeline + notes + proposal history.
- Commit: `feat(admin-os): rewrite Lead detail`

### Task 8.4 — Rewrite `EmailCampaignsDashboard.js`

- Port `CampaignsPage` (lines 421–477): filter by status chip, metrics row on each campaign row (open rate, click rate, bookings, revenue).
- Commit: `feat(admin-os): rewrite Campaigns list`

### Task 8.5 — Rewrite `EmailCampaignDetail.js`

- Port `CampaignDetailPage` (lines 479–588): identity + stat row + funnel + recipient list + subject/body preview.
- Commit: `feat(admin-os): rewrite Campaign detail`

### Task 8.6 — Rewrite `EmailCampaignCreate.js`

- Port `CampaignCreatePage` (lines 590–727): wizard or single-form (handoff uses single-page with live preview). Preserve existing audience/segment/body-editing logic, the TipTap `RichTextEditor`, Resend send integration, test-send.
- Commit: `feat(admin-os): rewrite Campaign create`

### Task 8.7 — Rewrite `EmailAnalyticsDashboard.js`

- Port `EmailAnalyticsPage` (lines 729–805): stat row + charts (open/click/reply trendlines) + top campaigns + top segments tables.
- Commit: `feat(admin-os): rewrite Email analytics`

### Task 8.8 — Rewrite `EmailConversations.js`

- Port `ConversationsPage` (lines 807–903): 2-pane layout (thread list left, active conversation right) with reply composer at bottom.
- Commit: `feat(admin-os): rewrite Conversations inbox`

Each of these 8 tasks follows the same pattern:
1. Read the handoff section (line range above).
2. Rewrite the existing page file to match, swapping demo `LEADS` / `CAMPAIGNS` / `CONVERSATIONS` imports for real API calls.
3. Preserve every existing feature — grep the current page for `api.` and `axios.` before starting to get the endpoint list.
4. `cd client && npm run build`.
5. Manual check: the specific flow that page drives end-to-end (send a test campaign, reply to a conversation, etc.).
6. Commit with the message above.

---

## Phase 9 — Blog + Settings (freestyle in new vocabulary)

### Task 9.1 — Rewrite `BlogDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/BlogDashboard.js`

Freestyle — no mockup. Follow Admin OS vocabulary:

- `page-header` with title "Lab Notes" + subtitle "Blog posts for the public site." + page-actions: `Import from Markdown`, `New post` (primary).
- `Toolbar`: tabs (Published / Draft / Archived), search, filter select for category/tag.
- `.card` with `.tbl` columns: Title, Status chip, Author, Published date, Views, actions.
- Row click → existing blog post editor (whatever path the current Edit button triggers).
- Preserve every existing action: create, edit, publish, archive, delete, duplicate.

- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite Blog dashboard in new vocabulary"
```

### Task 9.2 — Rewrite `SettingsDashboard.js`

**Files:**
- Modify: `client/src/pages/admin/SettingsDashboard.js`

Freestyle. Settings dashboards work well as a card-grid of groups:

- `page-header` "Settings" / "Team, billing, integrations."
- `.grid-3` of `.card`s: "Team & roles", "Billing & payouts", "Integrations" (Stripe / Twilio / Resend / Thumbtack / R2 status), "Branding & templates", "Tax & invoicing", "Contractor agreement".
- Each card shows a quick status line + "Configure" button that opens the existing setting surface (modal or separate panel — whichever the existing code has).
- Preserve every existing setting-save action.

- [ ] Build + commit:

```bash
git commit -m "feat(admin-os): rewrite Settings dashboard in new vocabulary"
```

---

## Phase 10 — Cleanup, ShiftDetail fold-in, docs

### Task 10.1 — Decide on `ShiftDetail.js`

**Files:**
- Investigate: `client/src/pages/admin/ShiftDetail.js` (usage)

- [ ] Grep for every link to `/admin/events/shift/`:
  ```bash
  grep -rn "events/shift/" client/src server
  ```
- [ ] If the new `EventDetailPage` (Task 3.3) already covers the shift workflows (staffing requests, assignments, SMS blast, approvals), remove the route from `App.js` and delete the file. Email bodies or scheduler output that links directly to `events/shift/:id` must be updated to the `/admin/events/:id` equivalent.
- [ ] If the workflow is too complex to fold in on this pass, restyle `ShiftDetail.js` in the new vocabulary as a standalone page. Freestyle — follow `EventDetailPage` pattern.
- [ ] Commit:

```bash
git commit -m "refactor(admin-os): fold ShiftDetail into EventDetailPage" # or "feat(admin-os): restyle ShiftDetail"
```

### Task 10.2 — Delete obsolete code

**Files:**
- Delete: `client/src/pages/AdminDashboard.js` (staff-list duties moved to `StaffDashboard.js`)
- Delete: `client/src/components/AdminBreadcrumbs.js` (already deleted in Task 1.6; re-verify)
- Audit: `client/src/components/BrandLogo.js` — if unused after the sidebar switch, delete.

- [ ] Grep each before deletion:
  ```bash
  grep -rn "AdminDashboard\|AdminBreadcrumbs\|BrandLogo" client/src
  ```
- [ ] Remove imports + files + any orphan routes.
- [ ] Commit:

```bash
git commit -m "chore(admin-os): remove obsolete AdminDashboard/AdminBreadcrumbs/BrandLogo"
```

### Task 10.3 — Audit leftover `.admin-*` CSS

- [ ] Verify all `.admin-*` rules were removed in Task 1.1. Grep:
  ```bash
  grep -n "^\.admin-\|\[class.*admin-" client/src/index.css
  ```
  Expect zero matches.
- [ ] Grep all component files for `admin-*` classes still referenced in JSX:
  ```bash
  grep -rn "className.*admin-\|classnames.*admin-" client/src
  ```
  Each match is a bug — update to the new vocab (or confirm the class name intentionally persists for a non-admin surface).
- [ ] Build, commit if anything was touched:

```bash
git commit -m "chore(admin-os): remove stale .admin-* references in JSX"
```

### Task 10.4 — Update CLAUDE.md + README.md + ARCHITECTURE.md

Per CLAUDE.md's mandatory-documentation rule:

- [ ] **CLAUDE.md** — Folder Structure section: update `client/src/components/` to include new `adminos/` subfolder with its contents; remove `AdminBreadcrumbs.js`; add new page files (`EventDetailPage.js`, `StaffDashboard.js`, `CocktailMenuDashboard.js`); remove removed files.
- [ ] **README.md** — matching folder tree updates; update Tech Stack table if you add any npm deps (unlikely for this revamp); add a Key Features note about the Admin OS revamp.
- [ ] **ARCHITECTURE.md** — update the "Admin surface" section (if it exists) with the new shell structure, drawer pattern, skin/density/sidebar user prefs, palette design.
- [ ] Commit:

```bash
git commit -m "docs: refresh folder trees + admin architecture for Admin OS revamp"
```

### Task 10.5 — Final end-to-end QA

- [ ] `npm run dev` + log in as admin.
- [ ] Click every nav item (10 items). Each page renders, data loads, no console errors.
- [ ] Drawer: click a row in Events / Proposals / Clients / Leads / Drink Plans — each drawer opens. Open-page button navigates. Back button closes. Deep-link to `/admin/events?drawer=event&drawerId=<id>` — drawer opens on load.
- [ ] Detail edit flows: edit a proposal, save, send. Record a payment. Approve an application. Assign a shift. Send a test campaign. Post a blog article. Change a setting. All must still work.
- [ ] Skin toggle: flip Sterile ↔ Experimental. Every page restyles cleanly. No broken white-on-white or unreadable text.
- [ ] Density: switch to compact + comfy. Tables/rows re-pack cleanly.
- [ ] Sidebar rail toggle: collapse to rail. All icons still click-navigate. Hover shows tooltips. Expand back to full — state restores.
- [ ] Logout and log back in — prefs persist (per-user). Log in as a different admin on a different browser profile — their prefs are distinct.
- [ ] `cd client && npm run build` — final warning-free build.

No commit. This is the gate before the pre-push agent run.

### Task 10.6 — Final commit pass + pre-push review

- [ ] `git status` — everything committed, tree clean.
- [ ] User triggers the push. `AdminLayout` pre-push procedure (CLAUDE.md Rule 6) runs the 5-agent fleet. Claude addresses any blockers before push.
- [ ] On success: Render + Vercel deploy. Admin URL now serves the new UI.

---

## Self-Review

**Spec coverage:**
- ✔ Shell + CSS + fonts (Phase 1)
- ✔ UserPrefsContext with localStorage + palette swap (Task 1.3)
- ✔ Drawer primitive + URL hook (Task 1.8)
- ✔ CommandPalette skeleton with Jump/Create, stub Records (Task 1.7)
- ✔ Every spec page in the table: Dashboard (2), Events flow (3), Proposals flow (4), Clients flow (5), Staff/Hiring/Financials (6), Drink Plans/Menu (7), Email Marketing (8), Blog/Settings freestyle (9)
- ✔ Extended drawers beyond handoff: LeadDrawer (8.2), DrinkPlanDrawer (7.1) — per Q6 B
- ✔ ShiftDetail fold-in (10.1)
- ✔ Cleanup phase + docs (10.2–10.4)

**Placeholders:** None — every step has concrete file paths, code snippets, and commit messages.

**Type consistency:** `useDrawerParam()` returns `{ kind, id, open, close }` — referenced consistently throughout Phases 3–8. `useUserPrefs()` returns `{ prefs, setPref }` — used identically in Sidebar. `format.js` exports (`fmt$`, `fmt$cents`, `fmtDate`, `fmtDateFull`, `dayDiff`, `relDay`) — each used by name in later tasks, all defined in Task 1.5.

**Risks acknowledged inline** in the spec — inheriting by reference here.

---

## Execution choice

Plan saved to `docs/superpowers/plans/2026-04-24-admin-ui-revamp.md`.

Two execution options:

1. **Subagent-Driven** (recommended) — fresh subagent per task, two-stage review per task, faster iteration, protects main context.
2. **Inline Execution** — execute in this session with checkpoints for user review.

Given the size of this plan (10 phases, ~30 tasks, ~3–5 days of focused work), subagent-driven is the better fit — each phase is independent enough that parallelizable sub-tasks can be dispatched and reviewed without me holding every page's context simultaneously.
