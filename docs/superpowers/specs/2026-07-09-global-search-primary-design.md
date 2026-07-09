# Global search as the primary per-page search

Date: 2026-07-09. Brainstormed and approved section by section with Dallas. Approach A + the "Enter → top hit" palette upgrade approved; alternatives B (inline results) and C (seeded modal) rejected as more code / more fiddle for little gain. Client-only change; no server, schema, money, or auth surface.

## 1. Problem and goals

Two searches compete on every admin list page, and the weaker one wins the operator's attention:

- **Global command palette** — the capable one. Opened by ⌘/Ctrl+K (`AdminLayout.js:86-99`) or the header search button (`Header.js:21-38`). Server-side, cross-entity: matches clients, proposals, events, and staff by partial name / email / phone and navigates straight to the record (`CommandPalette.js` → `GET /admin/search` → `server/utils/globalSearch.js`, top 6 per group). Already renders as a proper search bar with placeholder and a ⌘K badge, but it lives in the top chrome.
- **Per-page Toolbar "Search…" box** — the weak one. The shared `Toolbar` (`components/adminos/Toolbar.js:32-42`) renders a text input that each page wires to a **client-side filter of already-loaded rows** (confirmed in `EventsDashboard.js:223-231`, `ProposalsDashboard.js:122-131`, `StaffDashboard.js:56-64`, `ClientsDashboard.js:99-112`, `DrinkPlansDashboard.js:92-100`). It never queries the server, so it cannot find any record outside the current tab/load. It sits in the content area directly above each table — the spot the hand reaches for — so it is more prominent than the better search.

Operator diagnosis, verbatim: the global search is "stashed way up in the corner and there is a less helpful search below it that is more prevalent," and "almost always [I'm] just looking for one thing." The find-one-record-and-open-it intent is exactly what the palette does well and the client-side filter does poorly.

Goals:

1. Make the global search the single, prominent search on every admin list page, occupying the content-area spot the weak filter holds today.
2. Retire the per-page client-side text filter.
3. Add a fast path to the palette: type → Enter jumps to the top hit; ↑/↓ selects another.

## 2. Non-goals (explicitly out of scope)

- No change to what the global search indexes or to `GET /admin/search` / `globalSearch.js`. Server is untouched.
- No replacement in-table filtering. **Accepted consequence** (operator confirmed): list pages lose row-narrowing. Most noticeable on **Clients** (~187 rows, the most scannable list) and the **Drink Plans** page (drink plans are not a record type in global search, so they are reached via their client/event). Re-adding a clearly-labeled "Filter" box on a specific page later is a small, separate job.
- Events-as-landing-page and the Dashboard/Financials consolidation are separate efforts discussed in the same session; neither is part of this spec.
- No change to the palette's result set, endpoint, ranking, or the `filters`/`tabs` slots of the Toolbar (status/sort/source controls stay).

## 3. Design

### 3.1 Shared launcher component — `GlobalSearchButton`

Extract the existing header search button markup (`Header.js:21-38`: search icon + placeholder text + ⌘K badge) into a new `client/src/components/adminos/GlobalSearchButton.js`. It is a real `<button>` (`aria-label="Open command palette"`) that calls `openPalette()` from context (§3.2) on click. One source of truth for the search-bar look, rendered in two places:

- **Header** renders `<GlobalSearchButton />` in place of its inline button. Header drops its `onOpenPalette` prop.
- **Toolbar** renders `<GlobalSearchButton />` where its old text `<input>` was (`Toolbar.js:32-42`), so every list page shows the global search in the same prominent content-area spot. Toolbar drops its `search` and `setSearch` props.

Placeholder copy stays the current header wording ("Search events, clients, proposals…"). A `compact`/size prop is allowed if the Toolbar slot needs a different width than the header; visual only.

Open visual detail, resolved at build against the rendered page: the header search bar and the Toolbar launcher will both be visible on list pages (two entry points, one palette — harmless, same behavior). If stacked they read as redundant, de-emphasize the header instance on Toolbar pages (shrink to an icon-only button). Decide by looking, not in advance.

### 3.2 Opening the palette from anywhere — `PaletteContext`

The palette's open state lives in `AdminLayout` (`paletteOpen`, `AdminLayout.js:21`), but `Toolbar` is rendered deep inside each page via `<Outlet/>`. New `client/src/context/PaletteContext.js` (matching the existing `context/` pattern — Toast/UserPrefs/Auth) exposes `{ openPalette }`.

- `AdminLayout` wraps the shell in `<PaletteContext.Provider value={{ openPalette: () => setPaletteOpen(true) }}>`. The ⌘K global handler and `<CommandPalette>` render are unchanged.
- `GlobalSearchButton` reads `openPalette` via `useContext`. Header no longer needs the `onOpenPalette` prop (AdminLayout stops passing it).

### 3.3 Palette keyboard — Enter → top hit, ↑/↓ to move

In `CommandPalette.js`, add keyboard selection over the already-rendered, display-ordered items (record-result groups first, then filtered nav, then create — the current visual order):

- Maintain a flat, ordered array of actionable items with their action (navigate to a record path, or run a nav/create `onClick`) plus `activeIndex` state.
- **↑/↓** move `activeIndex` (wrapping); **Enter** activates the active item, defaulting to index 0 (the top hit) when the user has not moved; **Esc** still closes (existing).
- The active item gets a highlight class (e.g. `is-active`); mouse hover syncs `activeIndex` so keyboard and mouse do not fight. `aria-selected` (or roving `tabindex`) marks the active row.
- Reset `activeIndex` to 0 whenever the query or the results change.
- Preserve existing mouse behavior for record `<Link>`s, including ⌘/Ctrl/middle-click opening a new tab (`CommandPalette.js:127-131`); Enter on a record navigates in-app and closes.

### 3.4 Per-page cleanup (5 dashboards)

For each of `EventsDashboard.js`, `ProposalsDashboard.js`, `StaffDashboard.js`, `ClientsDashboard.js`, `DrinkPlansDashboard.js`:

- Stop passing `search`/`setSearch` to `<Toolbar>`.
- Remove the free-text term from view state: drop `q` from `LIST_DEFAULTS` / the `useUrlListState` defaults and the `const search = listState.q` local (Events `:44,:78`; Proposals `:39,:54`; Staff `:39`; Clients `:38,:46`; DrinkPlans `:36,:37`).
- Remove the **search predicate** from each page's `filtered` `useMemo`, keeping every other predicate (tab / status / sort / source): Events `:223-231`, Proposals `:122-131`, Staff `:56-64`, Clients `:99-112`, DrinkPlans `:92-100`.
- Fix empty-state / count copy that named the search: Clients "No clients match this search." (`:219`) → tab/context-appropriate empty copy; Proposals empty-state search reference (`:278`); DrinkPlans "No drink plans match these filters." (`:175`) keeps sense because a tab filter remains.
- Leave `tabs`, `filters` (sort/source selects), badge counts, and list fetches untouched.

## 4. Data flow

Server-side unchanged. The palette still debounces to `GET /admin/search` → `runGlobalSearch` → four capped groups. Removing per-page filters removes only client-side array narrowing; the list fetches (`/clients`, `/shifts`, `/proposals`, `/drink-plans`, `/admin/active-staff?include_stubs=true`) already return the full set each page renders, so each list simply shows all its rows (its empty-box behavior today).

## 5. Error and edge handling

- Palette keyboard: empty results → Enter is a no-op; `activeIndex` clamps to the available item count; a debounce tick landing after close is already guarded (`CommandPalette.js:42-43`).
- Old bookmarked `?q=` URLs: the param is unmanaged and ignored, page renders unfiltered. No error, no crash.
- Accessibility: launcher is a labeled `<button>`; palette keeps `role="dialog"`/`aria-modal`; the active row is exposed via `aria-selected` or roving tabindex; the ⌘K badge stays as the discoverability hint.
- Mobile: `GlobalSearchButton` must stay tappable in the Toolbar at small widths and the palette must remain usable (verify on the mobile harness; the Toolbar already wraps via `flex-wrap`).

## 6. Testing / verification

- Manual, per the five list pages: the content-area field opens the palette; ⌘K still toggles; the header button still opens it; typing then **Enter** lands on the top hit; ↑/↓ selects other results; ⌘/Ctrl-click opens a record in a new tab; Esc closes.
- Confirm each list still renders all rows with no dead `search` reference and no console error, and that tabs / sort / source still filter.
- Client CI gate: `CI=true react-scripts build` must pass clean (ESLint-as-error — catches unused `search`/`setSearch`/`useMemo` leftovers).
- No server tests (server unchanged).

## 7. Footprint (files touched)

New:
- `client/src/components/adminos/GlobalSearchButton.js`
- `client/src/context/PaletteContext.js`

Edited:
- `client/src/components/AdminLayout.js` (provider; stop passing `onOpenPalette`)
- `client/src/components/adminos/Header.js` (render `GlobalSearchButton`; drop `onOpenPalette` prop)
- `client/src/components/adminos/Toolbar.js` (render `GlobalSearchButton`; drop `search`/`setSearch`)
- `client/src/components/adminos/CommandPalette.js` (keyboard selection)
- `client/src/pages/admin/EventsDashboard.js`
- `client/src/pages/admin/ProposalsDashboard.js`
- `client/src/pages/admin/StaffDashboard.js`
- `client/src/pages/admin/ClientsDashboard.js`
- `client/src/pages/admin/DrinkPlansDashboard.js`
- `client/src/index.css` (highlight/active-row style; launcher-in-toolbar sizing if needed)

Docs (same change, per the mandatory-docs table): `README.md` folder tree (new component + context); `ARCHITECTURE.md` only if it documents the command palette / search surface.

## 8. Risk

Client-only; touches no sensitive path (no money, auth, schema, Stripe, PII). The real failure modes are (a) a list page left with a dead `search` reference after incomplete removal, and (b) a palette keyboard regression (wrong item on Enter, focus fight, lost new-tab behavior). Both are contained to single files, caught by the client build plus the manual pass. Review scales to a focused per-lane correctness look, not the full money/auth fleet.
