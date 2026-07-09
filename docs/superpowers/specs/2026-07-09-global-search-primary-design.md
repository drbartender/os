# Global search as the primary per-page search

Date: 2026-07-09. Brainstormed and approved section by section with Dallas. Approach A + the "Enter → top hit" palette upgrade approved; alternatives B (inline results) and C (seeded modal) rejected as more code / more fiddle for little gain. Client-only change; no server, schema, money, or auth surface. Design-review findings (grounding / gaps / risk fleet) folded in — see §9.

## 1. Problem and goals

Two searches compete on every admin list page, and the weaker one wins the operator's attention:

- **Global command palette** — the capable one. Opened by ⌘/Ctrl+K (`AdminLayout.js:86-99`) or the header search button (`Header.js:32-38`). Server-side, cross-entity: matches clients, proposals, events, and staff by partial name / email / phone and navigates straight to the record (`CommandPalette.js` → `GET /admin/search` → `server/utils/globalSearch.js`, top 6 per group). Already renders as a proper search bar with placeholder and a ⌘K badge, but it lives in the top chrome.
- **Per-page Toolbar "Search…" box** — the weak one. The shared `Toolbar` (`components/adminos/Toolbar.js:32-42`) renders a text input that each page wires to a **client-side filter of already-loaded rows** (confirmed in `EventsDashboard.js:223-231`, `ProposalsDashboard.js:122-131`, `StaffDashboard.js:56-64`, `ClientsDashboard.js:99-112`, `DrinkPlansDashboard.js:92-100`). It never queries the server, so it cannot find any record outside the current tab/load. It sits in the content area directly above each table — the spot the hand reaches for — so it is more prominent than the better search.

Operator diagnosis, verbatim: the global search is "stashed way up in the corner and there is a less helpful search below it that is more prevalent," and "almost always [I'm] just looking for one thing." The find-one-record-and-open-it intent is exactly what the palette does well and the client-side filter does poorly.

Goals:

1. Make the global search the single, prominent search on every admin list page, occupying the content-area spot the weak filter holds today.
2. Retire the per-page client-side text filter.
3. Add a fast path to the palette: type → Enter jumps to the top hit; ↑/↓ selects another — and it still lands you on the record even when you out-run the debounced search (§3.3 latch).

## 2. Non-goals (explicitly out of scope)

- No change to what the global search indexes or to `GET /admin/search` / `globalSearch.js`. Server is untouched.
- No replacement in-table filtering. **Accepted consequence** (operator confirmed): list pages lose row-narrowing. Most noticeable on **Clients** (~187 rows), the **Drink Plans** page (drink plans are not a record type in global search, reached via their client/event), and **Proposals** (server-paginated at ~50 rows per bucket — §4 — so you also lose name-narrowing *within* a loaded bucket; an in-bucket proposal beyond the loaded page is reachable via the palette). Re-adding a clearly-labeled "Filter" box on a specific page later is a small, separate job.
- Events-as-landing-page and the Dashboard/Financials consolidation are separate efforts discussed in the same session; neither is part of this spec.
- No change to the palette's result set, endpoint, ranking, or the `filters`/`tabs` slots of the Toolbar (status/sort/source controls stay).

## 3. Design

### 3.1 Shared launcher component — `GlobalSearchButton`

Extract the existing header search button markup (`Header.js:32-38`: search icon + placeholder text + ⌘K badge — note lines 21-30 are the separate mobile menu button, not part of this) into a new `client/src/components/adminos/GlobalSearchButton.js`. It is a real `<button>` (`aria-label="Open command palette"`) that calls `openPalette()` from context (§3.2) on click. One source of truth for the search-bar look, rendered in two places:

- **Header** renders `<GlobalSearchButton />` in place of its inline button. Header drops its `onOpenPalette` prop.
- **Toolbar** renders `<GlobalSearchButton />` where its old text `<input>` was (`Toolbar.js:32-42`), so every list page shows the global search in the same prominent content-area spot. Toolbar drops its `search` and `setSearch` props.

Placeholder copy stays the current header wording ("Search events, clients, proposals…"). **Responsive sizing (required):** the launcher must replicate the removed input's Toolbar sizing — `flex: 1; min-width: 240px; max-width: 340px` (`Toolbar.js:33`) — so the Toolbar's `flex-wrap` layout does not break at small widths. A size/`compact` prop is allowed if the header slot wants different metrics than the Toolbar slot; visual only.

Open visual detail, resolved at build against the rendered page: the header search bar and the Toolbar launcher will both be visible on list pages (two entry points, one palette — harmless, same behavior). If stacked they read as redundant, de-emphasize the header instance on Toolbar pages (the header search already collapses to icon-only on mobile via `index.css:11875-11876`, which is the natural lever). Decide by looking, not in advance.

### 3.2 Opening the palette from anywhere — `PaletteContext`

The palette's open state lives in `AdminLayout` (`paletteOpen`, `AdminLayout.js:21`), but `Toolbar` is rendered deep inside each page via `<Outlet/>`. New `client/src/context/PaletteContext.js` (matching the existing `context/` pattern — `AuthContext`, `ToastContext`, `UserPrefsContext`) exposes `{ openPalette }`.

- `AdminLayout` wraps the shell in `<PaletteContext.Provider value={{ openPalette: () => setPaletteOpen(true) }}>`. The ⌘K global handler and `<CommandPalette>` render are unchanged.
- `GlobalSearchButton` reads `openPalette` via `useContext`. Header no longer needs the `onOpenPalette` prop (AdminLayout stops passing it).

### 3.3 Palette keyboard — Enter → top hit, ↑/↓ to move

Add keyboard selection to `CommandPalette.js` over the already-rendered, display-ordered items (record-result groups first, then filtered nav, then create — the current visual order). Focus stays in the text input throughout; nothing below uses roving `tabindex`.

**Item model.** Build a flat, ordered array of actionable items, each with a stable id and an action (navigate to a record path, or run a nav/create action). Track `activeIndex` (default 0).

**Selection movement.**
- `ArrowDown` / `ArrowUp` move `activeIndex` with wrap-around, and **`preventDefault`** on the input's keydown (otherwise the arrows move the text caret). After moving, **scroll the active row into view** — `.palette-list` is `max-height: 340px; overflow-y: auto` (`index.css:12568`), so a selection past the fold must be scrolled back (`scrollIntoView({ block: 'nearest' })`).
- **Reset rule (fixes the async-yank):** reset `activeIndex` to 0 **only on query change** (each keystroke). Do **not** reset when async results arrive — instead clamp `activeIndex` into the new range. Records arrive ~200ms+ after the last keystroke and prepend before the nav items; resetting on their arrival would snap a user who had already arrowed down back to the top.

**Enter, including out-running the search (the latch).**
- If a record/nav item is available at `activeIndex`, `Enter` activates it (record → in-app navigate + close; nav/create → its action). `preventDefault`.
- **Pending-Enter latch:** if `Enter` is pressed with a ≥2-char query whose **fresh** results are not yet on screen — the 200ms debounce hasn't fired yet, the request is in flight, or only stale rows from the *previous* query are showing (tracked by remembering which term the current results answered) — and the user has not arrow-moved, do **not** fire a nav item or a stale row. Instead set a `pendingEnter` flag. When results land for the typed query: if there is ≥1 record, activate the **top record** and clear the flag; if results are empty, clear the flag (visible no-op). The flag also clears on any further keystroke, on an arrow key (an explicit selection takes over), and on a search error (nothing will arrive; Enter then acts on the visible selection). This makes "type + Enter" land on the record even when the operator out-runs the debounce entirely — the marquee interaction. Keying the latch on `loading` alone would miss the sub-200ms window and could activate stale rows; fresh-results semantics covers all three fast-typist windows. The latch also dies with the palette: any dismissal (row click, scrim, Esc, ⌘K toggle) clears it and invalidates the in-flight request, so a late-arriving response can never navigate after close.
- Note the **2-char floor:** server search requires ≥2 chars (`CommandPalette.js:45`) while `filteredNav` filters from 1 char. A single-character query + Enter therefore activates a matching nav item (e.g. "e" → Events), not a record. Intended; documented so it is not read as a bug.

**Highlight + accessibility.**
- The active row carries the **existing** `.active` class (already styled at `index.css:12585`) — do not introduce a parallel `is-active`.
- **Hover/keyboard de-conflict:** CSS `.palette-item:hover` paints independently of JS. To avoid two highlighted rows when the cursor rests on row A while the keyboard moves to row B, gate `:hover` styling behind a flag while keyboard-navigating (e.g. a `kbd-nav` class on `.palette-list` that neutralizes the `:hover` background), cleared on the next `mousemove`. Mouse `mouseenter` on a row also sets `activeIndex` to that row so click and keyboard agree.
- **ARIA (combobox pattern, keeps focus in the input):** the input becomes `role="combobox"` with `aria-expanded`, `aria-controls={listId}`, and `aria-activedescendant={activeItemId}`; the results container gets `role="listbox"` + `id={listId}`; each actionable row gets `role="option"` + a stable `id`. This announces the active row to a screen reader without moving DOM focus out of the input. The existing per-nav-item `tabIndex={0}` + Enter `onKeyDown` (`CommandPalette.js:151-152`) is now redundant under the central handler and is removed (nav rows are driven by the same `activeIndex`/click path as record rows).
- Preserve existing mouse behavior for record `<Link>`s, including ⌘/Ctrl/middle-click opening a new tab (`CommandPalette.js:127-131`); a plain click still closes the palette.

### 3.4 Per-page cleanup (5 dashboards)

For each of `EventsDashboard.js`, `ProposalsDashboard.js`, `StaffDashboard.js`, `ClientsDashboard.js`, `DrinkPlansDashboard.js`:

- Stop passing `search`/`setSearch` to `<Toolbar>`.
- Remove the free-text term from view state and **leave no dead binding** (the client build's ESLint-as-error gate, §6, fails on an unused var):
  - Events: `q` out of `LIST_DEFAULTS` (`:44`), drop `const search = listState.q` (`:78`).
  - Proposals: `q` out of `LIST_DEFAULTS` (`:39`), drop `search` (`:54`).
  - **Staff (unique shape):** defaults are `STAFF_DEFAULTS` (`:16`, not `LIST_DEFAULTS`); drop `q` there, drop `const search = listState.q` (`:39`), and drop the **hoisted** `const setSearch = (v) => setListState({ q: v })` (`:40`) — the other four inline `setSearch` in JSX, Staff does not.
  - Clients: `q` out of `LIST_DEFAULTS` (`:38`), drop `search` (`:46`).
  - Drink Plans: `q` out of the `useUrlListState({ tab, q })` default (`:36`), drop `search` (`:37`).
- Remove the **search predicate** from each `filtered` `useMemo`, keeping every other predicate (tab / status / sort / source): Events `:223-231`, Staff `:56-64`, Clients `:99-112`, DrinkPlans `:92-100`. **Proposals is special:** its `filtered` `useMemo` (`:122-131`) has *only* the search predicate (tab/source are server-side), so after removal it collapses to a passthrough — delete the `useMemo` entirely and render `proposals` directly rather than leave a no-op.
- Fix empty-state / count copy that named the search: Clients "No clients match this search." (`:219`) → context-appropriate empty copy; Proposals empty-state search reference (`:278`); DrinkPlans "No drink plans match these filters." (`:175`) keeps sense (a tab filter remains).
- **Comment cleanup (Events):** remove/adjust the now-inaccurate comments referencing the search box (`EventsDashboard.js:185`, `:233-234`, `:474-476`) — the ESLint gate catches dead bindings but not comment drift, and §8 names a "dead search reference" as the top failure mode.
- Leave `tabs`, `filters` (sort/source selects), badge counts, and list fetches untouched.

## 4. Data flow

Server-side unchanged. The palette still debounces to `GET /admin/search` → `runGlobalSearch` → four capped groups. Removing per-page filters removes only client-side array narrowing; the list each page renders is exactly what it renders today with an empty search box:

- **Clients** (`/clients`), **Events** (`/shifts`), **Staff** (`/admin/active-staff?include_stubs=true`), **Drink Plans** (`/drink-plans`) fetch their full list and filtered only client-side, so they now simply show all rows.
- **Proposals is server-paginated** (`/proposals`, page size ~50, `X-Total-Count`; `ProposalsDashboard.js:46-49,100-101,280`). Removing the client filter changes nothing about what is fetched — the page already showed the loaded ≤50 rows when the box was empty. The only lost capability is name-narrowing within that loaded page (captured in §2).

## 5. Error and edge handling

- Palette keyboard: empty results → Enter is a no-op (and clears any latch); `activeIndex` clamps to the available item count; a debounce tick landing after close is already guarded (`CommandPalette.js:42-43`); the search-error path already renders "Search unavailable." (`:61-65,144`).
- Old bookmarked `?q=` URLs: the param is unmanaged and ignored, page renders unfiltered. No error, no crash (verified against `useUrlListState`: a key absent from defaults is simply not applied).
- Accessibility: launcher is a labeled `<button>`; palette keeps `role="dialog"`/`aria-modal`; the active option is exposed via the combobox `aria-activedescendant` (§3.3) with focus retained in the input; the ⌘K badge stays as the discoverability hint. On close, return focus to the element that opened the palette (the launcher or header button) so a keyboard user is not dropped to `<body>`.
- Mobile: `GlobalSearchButton` keeps the Toolbar input's responsive sizing (§3.1) so `flex-wrap` does not break; verify the palette itself remains usable at small widths on the mobile harness.

## 6. Testing / verification

- Manual, per the five list pages: the content-area field opens the palette; ⌘K still toggles; the header button still opens it; typing then **Enter** lands on the top hit — **including the fast case**: type a name and hit Enter *before* results render, and confirm you still land on the top record once they arrive (latch); ↑/↓ selects other results and scrolls them into view; ⌘/Ctrl-click opens a record in a new tab; Esc closes and returns focus to the launcher.
- Confirm each list still renders all rows with no dead `search` reference and no console error, and that tabs / sort / source still filter. Proposals: confirm the collapsed `filtered` removal renders the loaded page correctly.
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
- `client/src/components/adminos/CommandPalette.js` (keyboard selection, latch, combobox ARIA)
- `client/src/pages/admin/EventsDashboard.js`
- `client/src/pages/admin/ProposalsDashboard.js`
- `client/src/pages/admin/StaffDashboard.js`
- `client/src/pages/admin/ClientsDashboard.js`
- `client/src/pages/admin/DrinkPlansDashboard.js`
- `client/src/index.css` (active-row / `kbd-nav` hover-suppression styles; launcher-in-toolbar sizing if needed)

Docs (same change, per the mandatory-docs table): `README.md` folder tree (new component + context). `ARCHITECTURE.md` has no command-palette/search section, so its conditional resolves to no update.

## 8. Risk

Client-only; touches no sensitive path (no money, auth, schema, Stripe, PII). The risk lens confirmed clean: `GET /admin/search` is already `auth` + `requireAdminOrManager` + rate-limited (`adminSearchLimiter`, 60/min/user, read-only) with a working error path; the launcher renders only inside the admin/manager shell, so a more prominent search widens no audience and adds no meaningful load (still debounced, still capped). The real failure modes are (a) a list page left with a dead `search` reference after incomplete removal (Staff is the trap — §3.4), and (b) a palette keyboard regression (wrong item on Enter, focus fight, lost new-tab behavior, latch misfire). Both are contained to single files, caught by the client build plus the manual pass. Review scales to a focused per-lane correctness look, not the full money/auth fleet.

## 9. Design review (fleet)

Reviewed by the design-stage fleet on 2026-07-09 (grounding / gaps / risk). Outcome and disposition:

- **Blocker (gaps): Enter pressed before debounced results arrive** had no defined behavior → resolved with the pending-Enter latch (§3.3).
- **Grounding fixes folded:** Header cite corrected to `32-38`; Staff removal expanded to `:16`/`:39`/`:40` (unique `STAFF_DEFAULTS` + hoisted `setSearch`); §4 corrected for Proposals' server pagination; §2 accepted-consequence extended to Proposals.
- **Gaps warnings folded:** combobox `aria-activedescendant` ARIA (replacing a self-contradictory roving-tabindex note), `:hover`/keyboard de-conflict, scroll-into-view, reset-only-on-keystroke, reuse `.active`, `preventDefault` arrows, remove redundant per-item Enter handler, delete the Proposals passthrough `useMemo`, Events comment cleanup, launcher mobile sizing, 2-char-floor note.
- **Risk: clean** (no money/auth/schema/webhook/PII surface; endpoint already guarded).

Plan-stage fleet (fidelity / decomposition / feasibility, same date) folded back one substantive finding:

- **Sub-debounce Enter gap (fidelity):** the latch originally keyed on `loading === true`, which missed Enter pressed *before* the 200ms debounce fired and could activate stale rows from the previous query. Widened to fresh-results semantics (§3.3): latch whenever the typed term's results aren't on screen yet; stale rows never activate; a search error falls through to the visible selection.

Per-lane review (build stage, same date) folded back one finding:

- **Latch survived dismissal (Lane A reviewer):** an armed latch could fire after Esc/scrim/row-click dismissal while its request was in flight, navigating (or double-navigating) post-close. Fixed: every in-component close goes through a `dismiss()` that synchronously kills the latch and invalidates the in-flight request, plus an open-effect branch covering parent-initiated closes; pinned by an 11th test.

The lenses converged: no unresolved finding remains open.
