# Mobile Admin Global Search (lane ma-f3-search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone header's magnifier stops opening the desktop command palette and opens the full-screen Global search from the 2026-10-14 benchmark: a back arrow and a search field in place of the header, results grouped Clients, Proposals, Events, Staff with counts, a "More clients on desktop · 6 shown" row ending every full group, a Desktop tag on client and staff rows, and the empty-field, keep-typing, in-flight, no-match, too-long, failed and offline states.

**Architecture:** One additive field extension on the existing search (`server/utils/globalSearch.js`: proposal and event rows also carry `status`, `event_date` and `kind`; every key the palette reads is unchanged). One pure model (`client/src/utils/searchView.js`) turning the endpoint's groups into what the screen draws and where each row leads. One phone page (`client/src/pages/mobile/SearchPhone.js`) at a new phone-only route `/search`, which `AdminLayout` renders as a takeover with no phone header and no tab bar. The read is `api.get`, never `offlineGet`, so the admin service worker never stores a result. A second kind of Desktop-view override in `MobileViewContext` (`setDesktopForVisit`: one visit, in memory, never stored) opens the desktop pages search leads to without changing the phone afterwards. Three small shell edits: the magnifier navigates to `/search`, `routeRestore` never records `/search`, and the route joins `App.js`.

**Tech Stack:** Express + pg on the server (`node:test` against the shared dev DB); React 18, react-router v6, axios through `utils/api`, React Testing Library; the mobile CSS block in `client/src/index.css`.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`, section 6 Global Search (`:178-181`), section 3 Visual contract (the 2026-09-15 Global search line, `:53`, the copy law, and the "Plan decisions of 2026-10-15 (lane ma-f3)" block this plan's fold added), section 2 endpoint rule (`:25`, which names this lane's field extension since the fold), section 7 Offline (the opt-in storage rule; the allowlist sentence at `:219`), section 9 (resume where I left off; "Never persisted" at `:251`), section 10 (error surfacing, `:259`).

**Dispatch rule:** every task's implementer and reviewer receive, with the task text, this plan's Plan decisions, Global Constraints and Review Focus. The decisions are the sanctioned departures from the benchmark; a reviewer holding the benchmark needs them to tell a departure from a defect. Benchmark: `docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html`, the Global search screen (markup `:607-690`, script `searchGroups` `:1023-1061` and the note logic `:1683-1716`, `:1779-1790`; data props `searchState` in `live typing`, `empty field`, `type more`, `in flight`, `results`, `nothing matched`, plus `keyboard` and `offline`). Declared as lane `ma-f3-search` in `docs/superpowers/plans/2026-09-15-mobile-admin-events-list.md:137-145` (depends on `ma-e1-events-list`, which is built; review fleet code-review, consistency-check, ui-ux-review).

## Proven context (read on main at `b3ad570a`, 2026-10-15; anchors are line numbers that day)

- `server/routes/admin/search.js` (19 lines): `router.get('/search', auth, requireAdminOrManager, adminSearchLimiter, ...)` answers `{ results: await runGlobalSearch(req.query.q) }`. Untouched by this lane.
- `server/utils/globalSearch.js` (183 lines): `GROUP_LIMIT = 6` (`:8`); `eventDetail(row)` (`:49-55`) joins `getEventTypeLabel(...)` and `event_date_label` with ` · `; `runGlobalSearch` (`:61-175`) trims, short-circuits under 2 and over 100 characters to `{ clients: [], proposals: [], events: [], staff: [] }` (`:62-64`), matches phone columns only at 3+ digits (`:67-70`); `proposalsSql` (`:83-97`, status NOT IN the booked four and `archived`) and `eventsSql` (`:99-113`, status IN `deposit_paid, balance_paid, confirmed, completed`) both select `p.id, c.name AS client_name, p.event_type, p.event_type_custom, to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label, p.cc_id AS proposal_cc_id, c.cc_id AS client_cc_id`; the mappings at `:151-166` emit `{ type, id, name, detail, proposal_cc_id, client_cc_id }`. Clients emit `detail: r.email || formatPhoneDisplay(r.phone)` (`:148`), staff `detail: humanizeStaffStatus(...)` (`:171`). `server/utils/eventTypes.js:31-37` `getEventTypeLabel` falls back to `'event'`.
- `server/utils/globalSearch.test.js` (88 lines): pure-helper tests, then DB tests under a `zz_searchtest_` client fixture seeded in `before` (`:51-58`) and deleted in `after` (`:60-63`, then `pool.end()`). No production guard today. It is the only suite that imports `globalSearch.js`.
- `server/routes/proposals/list.sort.test.js:66-80` is the proposal-fixture exemplar: `INSERT INTO proposals (client_id, status, total_price, event_date, event_type) VALUES (...) RETURNING id`, one row with a NULL `event_date`; `after` deletes the proposals, then the clients.
- `client/src/components/adminos/CommandPalette.js` (336 lines): the record groups and order at `:10-15` (Clients, Proposals, Events, Staff); paths at `:17-22` (`/clients`, `/proposals`, `/events`, `/staffing/users`); the debounce `useDebounce(..., 200, [q])` at `:91-127` with the `reqIdRef` superseded-response guard; it renders `it.name` and `it.detail` only (`:300-301`). Untouched by this lane (it stays mounted in the phone chrome for a hardware ⌘K and for the desktop pages' toolbar launcher inside the chrome).
- `client/src/hooks/useDebounce.js` (21 lines): `useDebounce(callback, delay, deps)`, the latest callback through a ref, the timer re-armed on every deps change and cleared on unmount.
- `client/src/components/mobile/MobileHeader.js` (111 lines): `:3` imports `usePalette`, `:54` `const { openPalette } = usePalette();`, `:88-97` the magnifier (rendered only when `!onBack`) with `onClick={openPalette}` and `aria-label="Search"`; the comment at `:6-12` says it opens the palette "until the full-screen search screen lands". `client/src/components/mobile/MobileHeader.test.js` mocks `PaletteContext` and `MobileViewContext` and renders the header WITHOUT a router (its only other importer is `mobileClassContract.test.js`, which reads the file as text).
- `client/src/components/AdminLayout.js` (328 lines): the phone fork at `:191-194` (`screenKey = routeScreenKey(location.pathname)`, `mobileChrome = isPhone && !desktopView(screenKey)`); `recordRoute(location.pathname, location.search)` at `:220-222`; the phone branch at `:253-281` renders `MobileHeader`, `PasskeyEnrollNudge`, `<main className="m-main" id="main-content"><Outlet context={outletCtx} /></main>`, `MobileTabBar` and `CommandPalette`, with `onBack` = `navigate(-1)` when `window.history.state.idx > 0`, else the screen's fallback with `replace` (`:260-263`). `client/src/components/AdminLayout.badges.test.js` is the harness exemplar (its mock list at `:13-25`; desktop width through `window.matchMedia`).
- `client/src/utils/screenKey.js:7-15`: `routeScreenKey` falls through to `segs[0]`, so `/search` already maps to `'search'`, `/clients/:id` to `'clients'`, `/staffing/users/:id` and `/staffing` to `'staffing'`, `/events` to `'events-list'`, `/proposals` to `'proposals-list'`. No change needed there; `screenKey.test.js` gains the `/search` row as a pin.
- `client/src/utils/routeRestore.js:22-31` `recordRoute(pathname, search)` writes `{ pathname, search }` to localStorage key `adminLastRoute`; `client/src/utils/routeRestore.test.js` is its suite.
- `client/src/App.js` (708 lines, over the 700 soft cap, so the two added lines draw the size hook's warning, never a block): the phone pages are `lazy` (`:141-142` `MorePage`, `NotificationsPhone`); the admin block's phone routes at `:612-613` (`/more`, `/more/notifications`).
- `client/src/context/MobileViewContext.js` (58 lines; `setDesktopView` at `:35-45`, `useMobileView` at `:57`): `useMobileView()` gives `{ isPhone, desktopView(screenKey), setDesktopView(screenKey, on) }`; an override persists in storage until the "Phone view" pill clears it (`AdminLayout.js:303-311`).
- `client/public/admin-sw.js:186-201`: `/api/admin/search` is in `API_EXACT`, but `asksForOffline` (`:230-231`) stores and stale-serves only requests that carry `X-Offline-Ok: 1` (and `/api/auth/me`); every other request on an allowlisted path goes to the network untouched and is never stored. `client/src/utils/offlineRead.js` `offlineGet` is the only caller that adds the header.
- `client/src/utils/api.js:28-40`: a request with no response (offline, refused, timeout) rejects with `{ message, code: 'NETWORK_ERROR', status: 0 }`; a server answer rejects with its `status` (429 from `adminSearchLimiter`, `server/middleware/rateLimiters.js:160-167`, 60 a minute keyed on the user). `api` sets no timeout.
- Desktop destinations for a More row (no desktop list has a free-text filter except Proposals; `Toolbar.js:4-7` says list pages route find-one-thing through global search): `ProposalsDashboard.js:62` `LIST_DEFAULTS` includes `q`, sent as the API's `search` (`:127`, matched on the client's name and email, `server/routes/proposals/list.js`), and counted by `anyFilterActive` (`:285-288`); `EventsDashboard.js:27-28` `tab` takes `upcoming | unstaffed | past | all`; `StaffDashboard.js:16` `tab` takes `active | deactivated | all` (`:118-120`); `ClientsDashboard.js:38` has only `sort`.
- `client/src/utils/eventCards.js:17-25` `railParts(ymd)` (noon-anchored; `{ dow, day, mon }` upper-case, day zero-padded; empty strings on a bad date). `client/src/utils/proposalStatusMap.js` `proposalStatusMeta(status)` (sent = info "Sent", draft = neutral "Draft", ...). `client/src/components/adminos/StatusChip.js` renders `<span class="chip {kind}"><span class="chip-dot" />{children}</span>`. `client/src/components/adminos/Icon.js` has `left, search, x, users, clipboard, calendar, userplus, external, clock, alert`.
- `client/src/pages/mobile/ProposalsListPhone.js:236-245` is the no-date rail pattern (glyphs `aria-hidden`, a `sr-only` "no date"). `client/src/pages/mobile/ProposalsListPhone.test.js:1-40` is the page-test exemplar (`jest.mock('../../utils/api', ...)`, a `LocationProbe`, `MemoryRouter` + `Routes`).
- `client/src/index.css` mobile block: `.m-shell` (`:21108`, flex column, 100dvh), `.m-header` (`:21114`, `gap: 0.25rem; min-height: 52px; padding: 0 0.5rem 0 1rem`), `.m-iconbtn` (`:21135`, 44 by 44), `.m-main` (`:21173`, `padding: 0.75rem`), `.m-card` (`:21538`, `padding: 10px 14px 10px 10px; margin: 0 0 0.5rem; gap: 8px`), `.m-rail` 44px with a 7px right inset (Dallas 2026-09-24), `.m-card-kind` (block, ellipsised), `.m-card-meta` (numeric face, fs-meta, ink-3), `.m-retry-btn`, `.m-empty`/`.m-empty-title`/`.m-empty-body` (`:21629-21632`, padding `70px 24px 40px`, body max 230px), `@keyframes m-pulse` (`:21638`), House Lights card rules (`:21641-21652`, last line `html[data-app="admin-os"][data-skin="light"] .m-empty.ok { color: var(--ms-emerald); }`). The assignment sheet's search field already carries the two field rules this screen needs: iOS-only 16px (`:22103-22105`) and the hidden browser clear button (`:22107`). The global `.tag` (`:13185`, House Lights twin `:11826`) is the benchmark's Desktop tag. `.sr-only` exists (`:9325`).
- `client/src/utils/mobileClassContract.test.js:7-26` `SOURCES` (a phone file's every `m-*` string token must be a defined class; `css` is `index.css` read at `:6`).
- `scripts/mobile-capture.js:68` counts tap targets under 36px (report), `:72` text under 12px (report). `scripts/mobile-capture.manifest.json:82-87` the proposals entries (the new entry goes after them).
- Docs anchors: `README.md:650` (the `proposalCards.js` utils line; `searchView.js` goes right after it), `README.md:707` (the `pages/mobile/` line; `SearchPhone` goes after the `ProposalsListPhone` clause); `ARCHITECTURE.md:225` (the admin `GET /search` row), `ARCHITECTURE.md:2136` ("Phone Proposals list" bullet; the new bullet follows it); `scripts/sensitive-paths.txt:475-481` (the `offlineGet` block listing `ProposalsListPhone.js`); `README.md:813-820` (the "Phone Admin PWA" Key Features section, one bullet per lane, the last one ma-c-push's); `docs/walkthroughs-owed.md` Tier 6 (`:2093`, its item-count sentence at `:2115` reading "As of 2026-10-15 this tier holds ONE item, below: the consult call record.", the tier ending before `## Tier 4` at `:2191`); `docs/fix-list-remaining-2026-07-02.md:3042-3044` (the 2026-10-14 AMENDED sentence ending "Still declared and unbuilt: `ma-f2-proposal-detail`, `ma-f3-search`.").
- Benchmark Global search (2026-10-14 snapshot): header `gap: 6px; padding: 8px 10px 8px 2px` with a 44px back button (`aria-label="Close search"`, icon `left`) and the field (`min-height: 40px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: segR; background: var(--bg-3); gap: 8px`; segR is `var(--radius)` in After Hours and `0` in House Lights) holding a 16px search icon in ink-3, the input (`type="search"`, 13.5px UI face, ink-1, `opacity: 0.55` when disabled offline, placeholder "Search clients, proposals, events, staff…", `aria-label="Global search"`), and a 30px Clear button (`aria-label="Clear search"`, icon `x`) shown while the trimmed term is non-empty; NO tab bar during search (`notDesktop2`); `main` with `padding-top: 4px`; the in-flight line (`padding: 8px 4px 4px`, centred, mono 10px, 0.1em, uppercase, ink-3, `m-pulse 1.2s`) reading "searching…" or "searching · showing “ma”" (the term the rows on screen answer); group head (`padding: 12px 4px 6px; gap: 8px`, baseline) with the label (mono 10px, 0.12em, uppercase, ink-3) and the count (numeric 10.5px, ink-4; `6+` for a full group); rows are `.m-card` with `flex-direction: row; align-items: center; gap: 12px; padding: 10px 14px 10px 10px; min-height: 56px`: clients a 34px icon tile (`users`, radius-sm, bg-3, ink-3) + name + `.m-card-meta` email-or-phone + Desktop tag; proposals a `clipboard` tile + "name · kind" (kind in ink-3, 400) + `.m-card-meta` date + status chip; events a 46px date rail (`align-self: stretch`, right rule, padding-right 10, dow and mon ink-4, day 20px 600 ink-2) + "name · kind", no meta, no chip; staff a 34px initials tile (mono 11px 600, ink-2, bg-3) + name + `.m-card-meta` role + Desktop tag; the More row (`.m-card`, `padding: 12px 14px; min-height: 48px; gap: 10px`) with a 16px `external` icon and "More clients on desktop" (fs-meta 600) in the link colour (After Hours `hsl(var(--accent-h) var(--accent-s) 62%)`, House Lights `var(--accent)`) and "6 shown" (mono 9px, 0.1em, uppercase, ink-4); the note (`padding: 58px 24px 40px`, gap 8, a 28px icon in ink-4, title fs-body 600 ink-2, body fs-meta ink-3 max 240px line-height 1.55, an optional micro line mono 9.5px 0.1em uppercase ink-4 with 2px above). Copy, verbatim: offline "Search needs the server" / "Global search runs a live query. Nothing is cached on the phone. Reconnect to search." / "offline · field kept, results off"; too long (icon `x`) "Too long to search" / "The server stops at 100 characters. Trim the term down." / "<N> characters"; empty "Search every record" / "Clients, proposals, events and staff, by name, email, or phone number." / "phone match needs 3+ digits"; one character "Keep typing" / "Nothing is searched until two characters."; no match "No matches for “<term>”" / "Try a last name, an email address, or the last four digits of a phone.". Escape closes; Back (popstate) closes; opening focuses the field; Clear refocuses it. The drawn keyboard (`keyboard` prop) is a mockup of the device's own.

## Plan decisions (stated here so the contract is whole)

1. **Search is a route, `/search`, phone only.** Android Back closes it through history, as the benchmark's `pushState` does, and the screen key is `search`. `AdminLayout` renders it as a takeover: the `.m-shell` holds only the screen, which draws its own header (Back and the field) and its own `<main id="main-content">`; no phone header, no passkey nudge, no tab bar (the benchmark hides the tab bar during search). At desktop width `/search` redirects to `/dashboard` (the desktop has the ⌘K palette). The search header carries no Desktop-view toggle (the benchmark draws none; spec section 3 asks every screen for one): the desktop twin of this screen is the ⌘K palette, and every row that leaves the phone opens its desktop page for that visit (decisions 7 and 8). Cost if wrong: none; the palette is untouched.
2. **The term survives Back from a result.** Once a search answers, the term is written into the `/search` history entry's state (`navigate('/search', { replace: true, state: { q } })`), so Back from a row lands on the screen with the term in the field and runs it again (one fresh query; results are never kept anywhere). The term never enters the URL, so neither the route restore nor the browser's URL history keeps search words; `routeRestore` never records `/search` at all, so a cold launch resumes the screen before it (a cold launch has no history state, and an empty field with the keyboard up is not "where I left off"). The field takes focus only when the screen opens empty; a restored term opens with the keyboard down so the results show.
3. **Nothing is stored on the phone.** The read is `api.get('/admin/search', { params: { q }, timeout: 10000 })`, never `offlineGet`, so the worker passes it to the network untouched (search rows carry client emails and phones). The worker's allowlist entry for `/api/admin/search` stays: under the opt-in rule it stores nothing, and the worker is not otherwise in this lane's footprint; a fix-list line records the dead entry for the next worker change. Offline means `navigator.onLine === false`, tracked through the `online` and `offline` events: the field keeps its text and is disabled, results are dropped (an answer in flight is discarded), the offline note shows, and coming back online runs the kept term.
4. **Failed searches are drawn here; the benchmark draws none.** Three notes, each with the existing `.m-retry-btn` "Retry", which runs the same term. No answer at all (`err.status` 0: offline while the phone believes it is online, a refused connection, the 10-second timeout) reads "Search didn’t answer" / "Check the signal, then try again." (icon `alert`). A 429 reads "Too many searches" / "Wait a minute, then try again." (icon `clock`). Any other server answer reads "Search failed" / "The server couldn’t run this search. Try again in a moment." (icon `alert`). The screen reads `err.status` (spec section 10's normalized shape) but writes its own copy rather than `err.message`: the limiter's message says what the 429 note says, and a 500's message is the generic server line. A failed search drops the rows that were on screen. Cost if wrong: copy.
5. **The kind sits under the name, not beside it.** Dallas ruled this for the card family on 2026-09-24 ("beside the name it was ellipsised on nearly every card"); the search rows are narrower still (a tile, a chip or a tag share the line). So a proposal row has three lines, as the family's card does: the name, the kind on its own line in `.m-card-kind` (the UI face), and the date in `.m-card-meta` ("Oct 24, 2026", formatted from `event_date`; no line when there is no date). An event row has two: the name and the kind, the rail carrying the date. The benchmark draws "name · kind" inline with the date as the proposal's meta. Until the server ships the new fields (Vercel can serve the client first), a proposal or event row with no `kind` shows the endpoint's `detail` ("kind · date") as its one meta line.
6. **Event rail:** the family's 44px rail with the 7px inset (the 2026-09-24 ruling; the benchmark draws 46/10), stretched to the row's height, with the benchmark's quieter search inks (dow and month ink-4, day ink-2) and no TODAY accent (the search drawing has none). The row's gap stays the benchmark's 12px: one gap for every row kind in the list, tile and rail alike; the ruling's 8px card gap answered the list card's cramped body, which a search row does not have. A booked event with no date shows the en-dash rail and a spoken "no date", as the Proposals list does.
7. **Where rows lead.** Client and staff rows open in desktop view (they have no phone screen; the benchmark's `goDesktop`), for this visit only (decision 8's rule): `/clients/:id` or `/staffing/users/:id` opens in the desktop chrome with the Phone view pill. Event rows open `/events/:id`, the phone event detail. Proposal rows open `/proposals/:id`, which renders the desktop proposal page inside the phone chrome until lane ma-f2 draws the phone detail (the same interim the Proposals list ships).
8. **Where More rows lead, and nothing sticks.** A full group (6 rows; the endpoint's cap, so "full" means "there may be more") ends in "More <group> on desktop · 6 shown", which opens the group's desktop list: Clients `/clients`; Proposals `/proposals?q=<term>` (the one desktop list with a text filter; it matches the client's name and email, so a digits-only term opens an empty filtered list there); Events `/events?tab=all` and Staff `/staffing?tab=all` (the search spans past events and every staff state). Every desktop page search opens, More rows and decision 7's client and staff rows alike, is desktop for THAT VISIT ONLY (Dallas, 2026-10-16: "I'd rather it not stick"): a new one-visit override in `MobileViewContext` (`setDesktopForVisit`, Task 3), held in memory and never stored, that keeps the page's own tabs, filters, drawers and paging in desktop view and ends the moment the user leaves that screen, Back included, or taps the Phone view pill. So after "More events on desktop", Back to the search and Back to Events shows the phone list. The header's own escape (`setDesktopView`) stays sticky, as spec section 3 has it; search never calls it.
9. **Tap targets:** the field is 44px tall (drawn 40), the phone's 44px floor and the assignment sheet's search field's height. Its Clear button is 44px wide by the field's full inner height, 42px (drawn 30 by 30): the one stated exception to the floor, since a 44px-tall button would make the field 46. A tap on the field's 1px border lands on the field, which is harmless. The browser's own clear button is suppressed (spec), the iOS-only 16px rule is copied from the sheet field.
10. **The in-flight line runs from the keystroke to the answer** (debounce plus request), as the benchmark's mock does, so the no-match note never flashes between a keystroke and its answer. While a new term runs, the rows of the last answered term stay on screen under "searching · showing “ma”". Typing below two characters, or past a hundred, drops the rows at once (the benchmark's `onSQ`).
11. **Keys:** Enter (the keyboard's Search key) puts the keyboard away so the rows show; it does not navigate (there is no top hit on the phone). Escape closes the screen, heard on the window as the benchmark listens, so it works offline too, when the field is disabled.
12. **Accessibility the benchmark does not draw:** a visually hidden `h1` "Search" (the takeover has no other heading of rank one), one polite status line that mounts with the screen and always reads its current state: "Searching", the note's title, or "N results" (`N+` when a group is full). Its first reading is not announced (it mounts with the screen; the visible note says the same), every later change is. Because it repeats the note's title, tests find a note by `{ selector: '.m-empty-title' }`; a focus ring on the field (its border takes the accent colour while the input has focus; the input itself has `outline: none`, as drawn), group heads as `h2` with a real space between the label and the count (the "Needs staff30" lesson), real spaces between a row's pieces so its accessible name reads in words. The rows are buttons, as every phone list's cards are.
13. **The mock keyboard is not built** (it stands for Android's own), and the debounce is the palette's 200 ms, as spec section 6 asks.
14. **Staff initials stop at two letters.** The benchmark joins every word's first letter ("Mary Ann Lee" draws MAL); two letters always fit the 34px tile, whatever the name.

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. Commas, colons, parentheses, the middle dot. The en dash in an empty rail is a glyph, not prose. Typographic quotes and apostrophes as the benchmark writes them (“ ” ’).
- **One fork, one breakpoint:** the phone branch comes from `useMobileView()` only. No new media queries; every new rule lives in the mobile block of `index.css`, scoped `html[data-app="admin-os"]`; a modifier is its own `m-*` class, never a bare word beside one.
- **The palette's contract is frozen:** every search row keeps `type, id, name, detail` (and the `cc_id` keys) exactly as today; the new keys are additive. A test pins `detail` for the proposal and event fixtures.
- **Nothing from search is stored at rest:** `SearchPhone.js` calls `api.get` and never `offlineGet`; no request it sends carries `X-Offline-Ok`. A test pins the request config. The term never enters a URL the phone records (`/proposals?q=` on the desktop is the desktop page's own contract, reached only through a More row).
- **Copy from the benchmark, verbatim** (the list in Proven context), plus this plan's three failed-search notes (decision 4), "Retry", "Desktop", "More <group> on desktop", "6 shown".
- **Writes: none in this lane.**
- **Nothing search opens sticks** (Dallas, 2026-10-16): `SearchPhone.js` opens desktop pages only through `setDesktopForVisit`; it never calls the sticky `setDesktopView`. A test pins it.
- **44px minimum tap targets;** the whole row is the target. The one stated exception is the Clear button's 42px height (decision 9).
- **Server tests:** `node --test server/utils/globalSearch.test.js` from the lane root, one suite at a time; `require('dotenv').config()` on the first line; a `NODE_ENV === 'production'` guard; every fixture row deleted in `after`; read the pass count.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`. It prints "Compiled with warnings." today for one known, pre-existing reason (a missing source map inside `html2pdf.js` in `node_modules`, "Failed to parse source map"), which CRA leaves out of the CI warnings-as-errors check; any OTHER warning is a failure. The build lints only modules the bundle imports, so a new file not yet imported is linted directly: `cd client && npx eslint --max-warnings=0 <file>`. No "not wrapped in act(...)" warnings in the suites this lane adds or touches; the baseline "`ReactDOMTestUtils.act` is deprecated" console error and the React Router v7 future-flag warnings print across the existing suites and are known noise. CRA jest runs `resetMocks: true`: a `jest.fn` implementation set in a mock factory is wiped before each test, so set return values inside the test or `beforeEach`.
- **The class contract:** `mobileClassContract.test.js` reads every `m-*` token in a listed source as a class, so no id, storage key or test id in `SearchPhone.js` may start with `m-`.
- **File sizes:** `globalSearch.js` stays under 220 lines; `SearchPhone.js` under 300; `searchView.js` under 240; `AdminLayout.js` grows by under 20.
- **Explicit staging only;** commit messages carry NO backticks (bash runs them); `git commit -F - <<'MSG'` heredocs with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Docs law (CLAUDE.md):** README folder tree (the new util and the new page), ARCHITECTURE (the route row and the phone surfaces), the sensitive list, the capture manifest, the walk, the fix list, all in the lane; the board line at lane close through `scripts/board-write.sh`.
- **Never `npm install` in the lane** (the symlinked `node_modules` would be clobbered); nothing here needs a package.

## Review Focus

1. **A late answer after leaving the screen.** A search still in flight when the user taps a row (or Back) must never pull them back: the success handler writes the term into the `/search` history entry, so an answer landing after a tap would replace the page they went to. Pinned in Task 4 (tap a row while a newer search is in flight, resolve it, the location stays on the row's page).
2. **A superseded answer.** "ma" answering after "mar" must never paint over "mar". Pinned in Task 4.
3. **Losing and regaining the connection mid-search.** Going offline with a search in flight drops its answer; coming back online runs the kept term; offline at open sends nothing. Pinned in Task 4.
4. **Rows with missing fields:** a client with neither email nor phone (no blank second line), a booked event with no date (dash rail, spoken "no date"), a proposal or event from a server that has not deployed the new fields yet (Vercel can serve the client before Render serves the route: no chip, the event's line 2 falls back to `detail`, no crash). Pinned in Task 2 and Task 4.
5. **Hostile or odd terms:** a term with LIKE wildcards or quotes (`50%`, `o'brien`) is sent raw (the server already escapes LIKE, `globalSearch.test.js`) and quoted verbatim in the no-match note; a 101-character paste sends nothing and says "Too long to search"; spaces alone are the empty field. Pinned in Task 2 (`termState`, the note's quoting) and Task 4 (no request past 100).

---

## Lane map

```yaml
lanes:
  - id: ma-f3-search
    plan: docs/superpowers/plans/2026-10-15-mobile-admin-search.md
    scope: >
      Full-screen phone global search at /search over GET /admin/search,
      matching the 2026-10-14 benchmark's Global search screen (declared input:
      docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html) apart from
      this plan's stated decisions: groups with counts, More on desktop rows,
      Desktop tag on client and staff rows, empty, keep-typing, in-flight,
      no-match, too-long, failed and offline states, nothing stored; the
      proposal and event search rows gain status, event_date and kind;
      MobileHeader's magnifier stops opening the palette; desktop pages opened
      from search are desktop for that visit only (a one-visit override in
      MobileViewContext).
    footprint:
      - server/utils/globalSearch.js
      - server/utils/globalSearch.test.js
      - client/src/utils/searchView.js
      - client/src/utils/searchView.test.js
      - client/src/context/MobileViewContext.js
      - client/src/context/MobileViewContext.test.js
      - client/src/pages/mobile/SearchPhone.js
      - client/src/pages/mobile/SearchPhone.test.js
      - client/src/index.css
      - client/src/utils/mobileClassContract.test.js
      - client/src/App.js
      - client/src/components/AdminLayout.js
      - client/src/components/AdminLayout.search.test.js
      - client/src/components/mobile/MobileHeader.js
      - client/src/components/mobile/MobileHeader.test.js
      - client/src/utils/routeRestore.js
      - client/src/utils/routeRestore.test.js
      - client/src/utils/screenKey.test.js
      - scripts/mobile-capture.manifest.json
      - scripts/sensitive-paths.txt
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
    depends_on: [ma-e1-events-list, ma-f1-proposals-list]
    review_fleet: [code-review, consistency-check, ui-ux-review, second-opinion]
```

Cut: from `os` on `main`, `npm run worktree:new -- ma-f3-search`, then work only in `../worktrees/ma-f3-search`. The ledger lives at `.superpowers/sdd/2026-10-15-mobile-admin-search/progress.md` in the lane (git-ignored). `ma-f1-proposals-list` is a dependency because this plan's anchors (the class contract's SOURCES, the capture manifest, the README, ARCHITECTURE, sensitive-list and fix-list lines) and the no-date rail sit on that lane's work; it is merged and pushed (`9f2c1f1c`).

**Review level, and why.** Read-only, no money, no auth, no schema: the lane map's three seats plus `/second-opinion` (cheap, decorrelated), reviewers on Opus. Cadence: a task reviewer after every task (code-review lens on Task 1's SQL projection; Task 3 changes the context every phone fork reads, so its reviewer checks every `desktopView` caller, `AdminLayout.js`, `EventsDashboard.js`, `ProposalsDashboard.js`, `EventDetailPage.js`, `Inbox.js`, `NotificationsPhone.js`, `EventDetailPhone.js`, `MobileHeader.js`, against the new rule; Tasks 4 and 5 together carry Review Focus 1 to 3, so their reviewer gets those lines), the ui-ux seat at Task 6, consistency-check after Task 7, then the whole-branch fleet in Task 8. Heads-up for the push: Task 7 puts `SearchPhone.js` on the sensitive list, so the push that carries this squash runs the sensitive-path re-review (full fleet plus `/second-opinion`) over it. That is expected, not a surprise.

## File structure

- `server/utils/globalSearch.js` (modify): `phoneFields(row)` and two projection columns; nothing else moves.
- `server/utils/globalSearch.test.js` (modify): the production guard, three proposal fixtures, three tests.
- `client/src/context/MobileViewContext.js` (modify): `setDesktopForVisit`, the one-visit override; `desktopView` honours it.
- `client/src/utils/searchView.js` (create): `MIN_TERM`, `MAX_TERM`, `GROUP_LIMIT`, `termState`, `initialsOf`, `rowTarget`, `moreTarget`, `searchRow`, `searchGroups`, `searchNote`, `flightLabel`, `liveSummary`. Pure; no class names (the class contract reads the page, not this file).
- `client/src/pages/mobile/SearchPhone.js` (create): the screen, `Lead` and `SearchRow`.
- `client/src/index.css` (modify): the search block after the House Lights list rules.
- `client/src/components/AdminLayout.js` (modify): the takeover branch.
- `client/src/components/mobile/MobileHeader.js` (modify): the magnifier navigates.
- `client/src/utils/routeRestore.js` (modify): `/search` is never recorded.
- `client/src/App.js` (modify): the lazy page and its route.
- Tests, manifest, docs as in the footprint.

---

### Task 1: The proposal and event search rows carry `status`, `event_date` and `kind`

**Files:**
- Modify: `server/utils/globalSearch.js:47-55` (a helper after `eventDetail`), `:83-113` (two projections), `:151-166` (two mappings)
- Modify: `server/utils/globalSearch.test.js:1-3` (the guard), `:49-63` (fixtures), end of file (three tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: every item in `results.proposals` and `results.events` of `GET /api/admin/search` gains `status: string` (the proposal's raw status), `event_date: 'YYYY-MM-DD' | null`, `kind: string` (`getEventTypeLabel`, `'event'` as the fallback). Every existing key (`type, id, name, detail, proposal_cc_id, client_cc_id`) is unchanged. Task 2 reads exactly `status`, `event_date`, `kind`, `detail`, `name`, `id`.

- [ ] **Step 1: Write the failing tests**

In `server/utils/globalSearch.test.js`, after the `require('dotenv').config();` line add:

```js
if (process.env.NODE_ENV === 'production') throw new Error('refusing to run search tests against production');
```

Replace the fixture block (from `const MARKER = 'zz_searchtest_';` through the end of the `after(...)` call) with:

```js
const MARKER = 'zz_searchtest_';
let clientId;
// One proposal per shape the phone search draws (lane ma-f3): a sent one with
// a date and a known type, a draft with neither, and a booked one (which the
// search files under events).
const P = {};

before(async () => {
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'zz_searchtest_%')");
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, 'direct') RETURNING id`,
    [`${MARKER}gandalf`, `${MARKER}grey@example.com`, '(555) 867-5309']
  );
  clientId = c.rows[0].id;
  const seed = async (status, eventType, eventDate) => (await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, event_date, event_type)
     VALUES ($1, $2, 1000, $3, $4) RETURNING id`,
    [clientId, status, eventDate, eventType]
  )).rows[0].id;
  P.sent = await seed('sent', 'wedding-reception', '2026-10-24');
  P.draft = await seed('draft', 'other', null);
  P.booked = await seed('confirmed', 'birthday-party', '2027-01-09');
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  await pool.end();
});
```

Append at the end of the file:

```js
// ---- the phone search's row fields (lane ma-f3) ----

test('runGlobalSearch > a proposal row carries status, event_date and kind beside the palette keys', async () => {
  const { proposals } = await runGlobalSearch('gandalf');
  const sent = proposals.find((p) => p.id === P.sent);
  assert.ok(sent, 'the sent proposal is in the proposals group');
  assert.strictEqual(sent.type, 'proposal');
  assert.strictEqual(sent.name, `${MARKER}gandalf`);
  assert.strictEqual(sent.detail, 'Wedding Reception · Oct 24, 2026');
  assert.ok('proposal_cc_id' in sent && 'client_cc_id' in sent);
  assert.strictEqual(sent.status, 'sent');
  assert.strictEqual(sent.event_date, '2026-10-24');
  assert.strictEqual(sent.kind, 'Wedding Reception');
});

test('runGlobalSearch > a proposal with no date answers event_date null and the fallback kind', async () => {
  const { proposals } = await runGlobalSearch('gandalf');
  const draft = proposals.find((p) => p.id === P.draft);
  assert.ok(draft, 'the draft is in the proposals group');
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(draft.event_date, null);
  assert.strictEqual(draft.kind, 'event');
  assert.strictEqual(draft.detail, 'event');
});

test('runGlobalSearch > a booked proposal is an event row with the same three fields', async () => {
  const { proposals, events } = await runGlobalSearch('gandalf');
  assert.ok(!proposals.some((p) => p.id === P.booked), 'a booked proposal is not in proposals');
  const ev = events.find((e) => e.id === P.booked);
  assert.ok(ev, 'the booked proposal is in the events group');
  assert.strictEqual(ev.type, 'event');
  assert.strictEqual(ev.detail, 'Birthday Party · Jan 9, 2027');
  assert.strictEqual(ev.status, 'confirmed');
  assert.strictEqual(ev.event_date, '2027-01-09');
  assert.strictEqual(ev.kind, 'Birthday Party');
});
```

- [ ] **Step 2: Run the suite to see the three new tests fail**

Run (lane root): `node --test server/utils/globalSearch.test.js`
Expected: the ten existing tests pass; the three new ones FAIL on `sent.status` (`undefined !== 'sent'`) and the like. If an INSERT fails instead (a NOT NULL or CHECK on `proposals` this dev DB enforces), stop and report the error text; do not change the fixture shape without saying so.

- [ ] **Step 3: Implement**

In `server/utils/globalSearch.js`, right after `eventDetail` (after `:55`), add:

```js
// The phone search (lane ma-f3) draws a proposal's status chip and an event's
// date rail and kind line, so those rows also carry the raw status, the date
// as YYYY-MM-DD (null when unset) and the kind label. The palette reads only
// type, id, name and detail; nothing it reads changes.
function phoneFields(row) {
  return {
    status: row.status,
    event_date: row.event_ymd || null,
    kind: getEventTypeLabel({
      event_type: row.event_type,
      event_type_custom: row.event_type_custom,
    }),
  };
}
```

In BOTH `proposalsSql` and `eventsSql`, change the select list's second line from

```sql
    SELECT p.id, c.name AS client_name, p.event_type, p.event_type_custom,
           to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label,
```

to

```sql
    SELECT p.id, c.name AS client_name, p.event_type, p.event_type_custom,
           p.status, to_char(p.event_date, 'YYYY-MM-DD') AS event_ymd,
           to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label,
```

In the return value, change the proposals and events mappings to spread the helper last:

```js
    proposals: proposals.rows.map((r) => ({
      type: 'proposal',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
      proposal_cc_id: r.proposal_cc_id,
      client_cc_id: r.client_cc_id,
      ...phoneFields(r),
    })),
    events: events.rows.map((r) => ({
      type: 'event',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
      proposal_cc_id: r.proposal_cc_id,
      client_cc_id: r.client_cc_id,
      ...phoneFields(r),
    })),
```

Update the file's header comment's last line to: `// events, and staff by partial name, email, or phone number. Proposal and event rows also carry the fields the phone search draws (phoneFields).` (keep it under 100 characters per line; wrap as needed).

- [ ] **Step 4: Run the suite**

Run: `node --test server/utils/globalSearch.test.js`
Expected: pass 13, fail 0 (Node's spec reporter prints them as `ℹ pass 13` and `ℹ fail 0`). Quote the counts. Then confirm the fixtures are gone: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT count(*) FROM clients WHERE name LIKE 'zz_searchtest_%'\").then(r=>{console.log(r.rows[0].count); return pool.end();})"` prints `0`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/globalSearch.js server/utils/globalSearch.test.js && git commit -F - <<'MSG'
feat(search): proposal and event search rows carry status, event_date and kind for the phone search

The palette's keys are unchanged; the new ones are additive.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 2: The pure search model

**Files:**
- Create: `client/src/utils/searchView.js`
- Create: `client/src/utils/searchView.test.js`

**Interfaces:**
- Consumes: Task 1's row fields (`status`, `event_date`, `kind`) plus `name`, `detail`, `id`; `railParts` from `./eventCards`; `proposalStatusMeta` from `./proposalStatusMap`.
- Produces (Task 4 imports these names exactly):
  - `MIN_TERM = 2`, `MAX_TERM = 100`, `GROUP_LIMIT = 6`
  - `termState(raw) -> 'empty' | 'short' | 'long' | 'ok'` (on the trimmed term)
  - `initialsOf(name) -> string`
  - `rowTarget(groupKey, id) -> { path: string, screenKey: string | null }`
  - `moreTarget(groupKey, term) -> { path: string, screenKey: string } | null`
  - `searchRow(groupKey, item) -> Row | null` where `Row = { key, title, kind, meta, lead, chip: { label, kind } | null, desktop: boolean, target }`: `kind` is the event-type label for its own line (`''` for none) and `meta` the line under it (`''` for none); `lead` is `{ kind: 'icon', icon }`, `{ kind: 'initials', initials }` or `{ kind: 'rail', rail: { dow, day, mon }, noDate: boolean }`
  - `searchGroups(results, term) -> Group[]` where `Group = { key, label, rows: Row[], full: boolean, count: string, moreLabel: string, more: target | null }`, in the order Clients, Proposals, Events, Staff, empty groups left out
  - `searchNote({ raw, offline, error, pending, resultsFor, groups }) -> Note | null` where `Note = { icon, title, body, micro, retry: boolean }` and `error` is `null` or `{ term, kind: 'network' | 'rate' | 'server' }`
  - `errorKind(err) -> 'network' | 'rate' | 'server'` (from the normalized `err.status`: 0 or none is `network`, 429 is `rate`, anything else `server`)
  - `flightLabel(resultsFor) -> string`
  - `liveSummary({ pending, note, groups }) -> string`
- Decisions implemented here: 4 (three failed-search notes, `errorKind`), 5 (the kind on its own line, the proposal's date under it, the `detail` fallback), 6 (the no-date rail), 7 (row targets), 8 (More targets), 10 (the in-flight label), 12 (the status line's words), 14 (two-letter initials).

- [ ] **Step 1: Write the failing tests**

Create `client/src/utils/searchView.test.js`:

```js
import {
  MIN_TERM, MAX_TERM, GROUP_LIMIT, termState, initialsOf, rowTarget, moreTarget,
  searchRow, searchGroups, searchNote, errorKind, flightLabel, liveSummary,
} from './searchView';
import { routeScreenKey } from './screenKey';

const client = (over = {}) => ({ type: 'client', id: 3, name: 'Marcus Keller', detail: 'mkeller@example.test', cc_id: null, ...over });
const proposal = (over = {}) => ({
  type: 'proposal', id: 40, name: 'Alexis Henderson', detail: 'Wedding Reception · Oct 24, 2026',
  status: 'sent', event_date: '2026-10-24', kind: 'Wedding Reception', ...over,
});
const event = (over = {}) => ({
  type: 'event', id: 41, name: 'Nautilus Group', detail: 'Corporate Event · Oct 3, 2026',
  status: 'confirmed', event_date: '2026-10-03', kind: 'Corporate Event', ...over,
});
const staff = (over = {}) => ({ type: 'staff', id: 12, name: 'Jordan Lee', detail: 'Active bartender', cc_id: null, ...over });
const many = (make, n) => Array.from({ length: n }, (_, i) => make({ id: 100 + i, name: `Name ${i}` }));

test('the endpoint bounds', () => {
  expect([MIN_TERM, MAX_TERM, GROUP_LIMIT]).toEqual([2, 100, 6]);
});

test.each([
  ['', 'empty'], ['   ', 'empty'], [null, 'empty'], ['k', 'short'], [' k ', 'short'],
  ['ma', 'ok'], ['x'.repeat(100), 'ok'], [`  ${'x'.repeat(100)}  `, 'ok'], ['x'.repeat(101), 'long'],
])('termState(%p) is %s', (raw, state) => {
  expect(termState(raw)).toBe(state);
});

test.each([
  ['Marcus Keller', 'MK'], ['jordan', 'J'], ['Mary Ann Lee', 'MA'], ['  a  b ', 'AB'], ['', ''], [null, ''],
])('initialsOf(%p) is %p', (name, out) => {
  expect(initialsOf(name)).toBe(out);
});

test('every override a row or a More row arms is the screen key of the page it opens', () => {
  const targets = [
    rowTarget('clients', 3), rowTarget('staff', 12),
    moreTarget('clients', 'ma'), moreTarget('proposals', 'ma'), moreTarget('events', 'ma'), moreTarget('staff', 'ma'),
  ];
  targets.forEach((t) => expect(routeScreenKey(t.path.split('?')[0])).toBe(t.screenKey));
  expect(rowTarget('proposals', 40)).toEqual({ path: '/proposals/40', screenKey: null });
  expect(rowTarget('events', 41)).toEqual({ path: '/events/41', screenKey: null });
  expect(rowTarget('clients', 3)).toEqual({ path: '/clients/3', screenKey: 'clients' });
  expect(rowTarget('staff', 12)).toEqual({ path: '/staffing/users/12', screenKey: 'staffing' });
});

test('More targets: the group desktop lists; only Proposals carries the term', () => {
  expect(moreTarget('clients', 'ma')).toEqual({ path: '/clients', screenKey: 'clients' });
  expect(moreTarget('proposals', ' smith & co ')).toEqual({ path: '/proposals?q=smith%20%26%20co', screenKey: 'proposals-list' });
  expect(moreTarget('events', 'ma')).toEqual({ path: '/events?tab=all', screenKey: 'events-list' });
  expect(moreTarget('staff', 'ma')).toEqual({ path: '/staffing?tab=all', screenKey: 'staffing' });
  expect(moreTarget('nope', 'ma')).toBeNull();
});

test('a client row: icon tile, name, email or phone as meta, Desktop', () => {
  expect(searchRow('clients', client())).toEqual({
    key: 'clients-3', title: 'Marcus Keller', kind: '', meta: 'mkeller@example.test',
    lead: { kind: 'icon', icon: 'users' }, chip: null, desktop: true,
    target: { path: '/clients/3', screenKey: 'clients' },
  });
  expect(searchRow('clients', client({ detail: '' })).meta).toBe('');
});

test('a proposal row: the kind on its own line, the date under it, the stage chip, no Desktop', () => {
  const row = searchRow('proposals', proposal());
  expect(row.lead).toEqual({ kind: 'icon', icon: 'clipboard' });
  expect(row.title).toBe('Alexis Henderson');
  expect(row.kind).toBe('Wedding Reception');
  expect(row.meta).toBe('Oct 24, 2026');
  expect(row.chip).toEqual({ label: 'Sent', kind: 'info' });
  expect(row.desktop).toBe(false);
  // No date: no date line; a date that does not parse is no date either.
  expect(searchRow('proposals', proposal({ event_date: null })).meta).toBe('');
  expect(searchRow('proposals', proposal({ event_date: 'garbage' })).meta).toBe('');
  // A server that has not deployed the new fields yet: no chip, the detail
  // as the one meta line, no crash.
  const old = searchRow('proposals', proposal({ status: undefined, kind: undefined, event_date: undefined }));
  expect(old.chip).toBeNull();
  expect(old.kind).toBe('');
  expect(old.meta).toBe('Wedding Reception · Oct 24, 2026');
});

test('an event row: the date rail, the kind on its own line, no meta, no chip', () => {
  const row = searchRow('events', event());
  expect(row.lead).toEqual({ kind: 'rail', rail: { dow: 'SAT', day: '03', mon: 'OCT' }, noDate: false });
  expect(row.title).toBe('Nautilus Group');
  expect(row.kind).toBe('Corporate Event');
  expect(row.meta).toBe('');
  expect(row.chip).toBeNull();
  expect(row.desktop).toBe(false);
  expect(searchRow('events', event({ event_date: null })).lead).toEqual({ kind: 'rail', rail: { dow: '', day: '–', mon: '' }, noDate: true });
  expect(searchRow('events', event({ event_date: 'garbage' })).lead.noDate).toBe(true);
  // Before the server ships kind, the palette's detail stands in as the meta.
  const old = searchRow('events', event({ kind: undefined }));
  expect(old.kind).toBe('');
  expect(old.meta).toBe('Corporate Event · Oct 3, 2026');
});

test('a staff row: initials, the status as meta, Desktop', () => {
  const row = searchRow('staff', staff());
  expect(row.lead).toEqual({ kind: 'initials', initials: 'JL' });
  expect(row.kind).toBe('');
  expect(row.meta).toBe('Active bartender');
  expect(row.desktop).toBe(true);
  expect(row.target).toEqual({ path: '/staffing/users/12', screenKey: 'staffing' });
  expect(searchRow('nope', staff())).toBeNull();
});

test('groups: the palette order whatever the object order, empty ones left out, counts', () => {
  const groups = searchGroups({ staff: [staff()], events: [], clients: [client(), client({ id: 4, name: 'Marrow Gallery' })], proposals: [proposal()] }, 'ma');
  expect(groups.map((g) => [g.label, g.count])).toEqual([['Clients', '2'], ['Proposals', '1'], ['Staff', '1']]);
  expect(groups.every((g) => !g.full && g.more === null)).toBe(true);
  expect(searchGroups(null, 'ma')).toEqual([]);
  expect(searchGroups({ clients: [client()] }, 'ma').map((g) => g.key)).toEqual(['clients']);
});

test('a full group says 6+ and ends in its More row; five rows do not', () => {
  const [full] = searchGroups({ clients: many(client, 6) }, 'ma');
  expect(full.count).toBe('6+');
  expect(full.full).toBe(true);
  expect(full.moreLabel).toBe('More clients on desktop');
  expect(full.more).toEqual(moreTarget('clients', 'ma'));
  const [five] = searchGroups({ proposals: many(proposal, 5) }, 'ma');
  expect(five.count).toBe('5');
  expect(five.more).toBeNull();
  expect(searchGroups({ staff: many(staff, 6) }, 'ma')[0].moreLabel).toBe('More staff on desktop');
});

const none = { offline: false, error: null, pending: false, resultsFor: null, groups: [] };

test('notes, in the benchmark order: offline beats everything', () => {
  expect(searchNote({ ...none, raw: 'x'.repeat(101), offline: true })).toEqual({
    icon: 'search', title: 'Search needs the server',
    body: 'Global search runs a live query. Nothing is cached on the phone. Reconnect to search.',
    micro: 'offline · field kept, results off', retry: false,
  });
  expect(searchNote({ ...none, raw: 'x'.repeat(101) })).toEqual({
    icon: 'x', title: 'Too long to search', body: 'The server stops at 100 characters. Trim the term down.',
    micro: '101 characters', retry: false,
  });
  expect(searchNote({ ...none, raw: '  ' })).toEqual({
    icon: 'search', title: 'Search every record',
    body: 'Clients, proposals, events and staff, by name, email, or phone number.',
    micro: 'phone match needs 3+ digits', retry: false,
  });
  expect(searchNote({ ...none, raw: 'k' })).toEqual({
    icon: 'search', title: 'Keep typing', body: 'Nothing is searched until two characters.', micro: '', retry: false,
  });
});

test('a failed search for the term on screen offers Retry; one for an older term says nothing', () => {
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'rate' } })).toEqual({
    icon: 'clock', title: 'Too many searches', body: 'Wait a minute, then try again.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'network' } })).toEqual({
    icon: 'alert', title: 'Search didn’t answer', body: 'Check the signal, then try again.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'ma', error: { term: 'ma', kind: 'server' } })).toEqual({
    icon: 'alert', title: 'Search failed', body: 'The server couldn’t run this search. Try again in a moment.', micro: '', retry: true,
  });
  expect(searchNote({ ...none, raw: 'mar', pending: true, error: { term: 'ma', kind: 'network' } })).toBeNull();
});

test('errorKind reads the normalized status: none at all, the limiter, the server', () => {
  expect(errorKind({ status: 0, code: 'NETWORK_ERROR' })).toBe('network');
  expect(errorKind({})).toBe('network');
  expect(errorKind(undefined)).toBe('network');
  expect(errorKind({ status: 429 })).toBe('rate');
  expect(errorKind({ status: 500 })).toBe('server');
  expect(errorKind({ status: 403 })).toBe('server');
});

test('nothing matched quotes the term verbatim; pending or results say nothing', () => {
  expect(searchNote({ ...none, raw: "50% o'brien", resultsFor: "50% o'brien" })).toEqual({
    icon: 'search', title: 'No matches for “50% o\'brien”',
    body: 'Try a last name, an email address, or the last four digits of a phone.', micro: '', retry: false,
  });
  expect(searchNote({ ...none, raw: 'zephyr', resultsFor: 'zephyr', pending: true })).toBeNull();
  expect(searchNote({ ...none, raw: 'ma', resultsFor: 'ma', groups: searchGroups({ clients: [client()] }, 'ma') })).toBeNull();
  expect(searchNote({ ...none, raw: 'mar', resultsFor: 'ma', pending: true })).toBeNull();
});

test('the in-flight line names the term whose rows are on screen', () => {
  expect(flightLabel(null)).toBe('searching…');
  expect(flightLabel('ma')).toBe('searching · showing “ma”');
});

test('the status line: searching, the note, or how many rows', () => {
  expect(liveSummary({ pending: true, note: null, groups: [] })).toBe('Searching');
  expect(liveSummary({ pending: false, note: { title: 'Keep typing' }, groups: [] })).toBe('Keep typing');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: [client()] }, 'ma') })).toBe('1 result');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: [client(), client({ id: 4 })], staff: [staff()] }, 'ma') })).toBe('3 results');
  expect(liveSummary({ pending: false, note: null, groups: searchGroups({ clients: many(client, 6), staff: [staff()] }, 'ma') })).toBe('7+ results');
  expect(liveSummary({ pending: false, note: null, groups: [] })).toBe('');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/searchView.test.js`
Expected: FAIL, `Cannot find module './searchView'`.

- [ ] **Step 3: Implement**

Create `client/src/utils/searchView.js`:

```js
// The phone global search's model (spec 2026-08-13-mobile-admin section 6
// and the 2026-09-15 Global search line; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Global search;
// lane ma-f3). Pure: GET /admin/search's groups in, what the screen draws and
// where each row leads out. Class names live in SearchPhone.js, which the
// class contract test reads; this file has none.
import { railParts } from './eventCards';
import { proposalStatusMeta } from './proposalStatusMap';

// The endpoint's own bounds (server/utils/globalSearch.js): a trimmed term
// under 2 or over 100 characters gets empty groups without a query, and a
// group holds at most 6 rows, so a group of 6 may have more behind it.
export const MIN_TERM = 2;
export const MAX_TERM = 100;
export const GROUP_LIMIT = 6;

export function termState(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 'empty';
  if (t.length < MIN_TERM) return 'short';
  if (t.length > MAX_TERM) return 'long';
  return 'ok';
}

// Two letters at most, so any name fits the 34px tile (the benchmark joins
// every word's first letter).
export function initialsOf(name) {
  return String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => Array.from(w)[0]).join('').toUpperCase();
}

// The palette's order (CommandPalette.js RECORD_GROUPS).
const GROUPS = [
  { key: 'clients', label: 'Clients' },
  { key: 'proposals', label: 'Proposals' },
  { key: 'events', label: 'Events' },
  { key: 'staff', label: 'Staff' },
];

// Where a row leads, and the screen key it opens in desktop view for that
// visit only (MobileViewContext's setDesktopForVisit; the key is the one
// routeScreenKey gives the path; null opens in the phone chrome). Clients and
// staff have no phone screen, so the benchmark's Desktop tag opens their page
// in the desktop chrome. An event opens the phone event detail; a proposal
// opens the desktop proposal page inside the phone chrome until lane ma-f2
// draws the phone detail.
export function rowTarget(groupKey, id) {
  switch (groupKey) {
    case 'clients': return { path: `/clients/${id}`, screenKey: 'clients' };
    case 'staff': return { path: `/staffing/users/${id}`, screenKey: 'staffing' };
    case 'proposals': return { path: `/proposals/${id}`, screenKey: null };
    case 'events': return { path: `/events/${id}`, screenKey: null };
    default: return null;
  }
}

// A full group's More row opens the group's desktop list in desktop view,
// for that visit only (spec section 6). Only the desktop Proposals list takes
// a text filter (?q=, matched on the client's name and email); Events and
// Staff open on All because the search spans past events and every staff
// state.
export function moreTarget(groupKey, term) {
  switch (groupKey) {
    case 'clients': return { path: '/clients', screenKey: 'clients' };
    case 'proposals': return { path: `/proposals?q=${encodeURIComponent(String(term ?? '').trim())}`, screenKey: 'proposals-list' };
    case 'events': return { path: '/events?tab=all', screenKey: 'events-list' };
    case 'staff': return { path: '/staffing?tab=all', screenKey: 'staffing' };
    default: return null;
  }
}

// A booked event with no date keeps its rail, an en dash in the day slot
// (the Proposals list's rule).
function railLead(eventDate) {
  const ymd = eventDate ? String(eventDate).slice(0, 10) : '';
  const parts = ymd ? railParts(ymd) : null;
  if (parts && parts.day) return { kind: 'rail', rail: parts, noDate: false };
  return { kind: 'rail', rail: { dow: '', day: '–', mon: '' }, noDate: true };
}

// "Oct 24, 2026" from a YYYY-MM-DD, noon-anchored like railParts; '' for no
// date or one that does not parse.
function dateLabel(eventDate) {
  const ymd = eventDate ? String(eventDate).slice(0, 10) : '';
  const d = ymd ? new Date(`${ymd}T12:00:00`) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// One row. The kind sits on its own line under the name (Dallas, 2026-09-24,
// on the card family): a proposal shows the kind, then its date; an event
// shows the kind, its date being on the rail. A server that has not shipped
// the kind yet sends only the palette's detail ("kind · date"), which then
// stands in as the one meta line.
export function searchRow(groupKey, item) {
  const target = rowTarget(groupKey, item.id);
  if (!target) return null;
  const base = {
    key: `${groupKey}-${item.id}`,
    title: item.name || '',
    target,
    desktop: Boolean(target.screenKey),
    chip: null,
    kind: '',
  };
  if (groupKey === 'clients') {
    return { ...base, lead: { kind: 'icon', icon: 'users' }, meta: item.detail || '' };
  }
  if (groupKey === 'proposals') {
    const status = item.status ? proposalStatusMeta(item.status) : null;
    return {
      ...base,
      lead: { kind: 'icon', icon: 'clipboard' },
      kind: item.kind || '',
      meta: item.kind ? dateLabel(item.event_date) : item.detail || '',
      chip: status ? { label: status.label, kind: status.kind } : null,
    };
  }
  if (groupKey === 'events') {
    return {
      ...base,
      lead: railLead(item.event_date),
      kind: item.kind || '',
      meta: item.kind ? '' : item.detail || '',
    };
  }
  return { ...base, lead: { kind: 'initials', initials: initialsOf(item.name) }, meta: item.detail || '' };
}

export function searchGroups(results, term) {
  if (!results) return [];
  return GROUPS.map((g) => {
    const items = Array.isArray(results[g.key]) ? results[g.key] : [];
    const rows = items.map((it) => searchRow(g.key, it)).filter(Boolean);
    const full = rows.length >= GROUP_LIMIT;
    return {
      key: g.key,
      label: g.label,
      rows,
      full,
      count: full ? `${rows.length}+` : String(rows.length),
      moreLabel: `More ${g.label.toLowerCase()} on desktop`,
      more: full ? moreTarget(g.key, term) : null,
    };
  }).filter((g) => g.rows.length > 0);
}

// What went wrong, from the normalized error (utils/api.js): no response at
// all (offline, refused, the timeout) is status 0; the limiter answers 429.
export function errorKind(err) {
  const status = err && err.status;
  if (!status) return 'network';
  return status === 429 ? 'rate' : 'server';
}

// The one note under the field, in the benchmark's order. The copy is the
// benchmark's, word for word, except the failed-search notes, which the
// benchmark does not draw. They use the screen's own words rather than the
// server's message: the limiter's message says what the rate note says, and
// a 500's is the generic server line.
export function searchNote({ raw, offline, error, pending, resultsFor, groups }) {
  const t = String(raw ?? '').trim();
  const state = termState(t);
  if (offline) {
    return {
      icon: 'search', title: 'Search needs the server',
      body: 'Global search runs a live query. Nothing is cached on the phone. Reconnect to search.',
      micro: 'offline · field kept, results off', retry: false,
    };
  }
  if (state === 'long') {
    return {
      icon: 'x', title: 'Too long to search', body: 'The server stops at 100 characters. Trim the term down.',
      micro: `${t.length} characters`, retry: false,
    };
  }
  if (state === 'empty') {
    return {
      icon: 'search', title: 'Search every record',
      body: 'Clients, proposals, events and staff, by name, email, or phone number.',
      micro: 'phone match needs 3+ digits', retry: false,
    };
  }
  if (state === 'short') {
    return { icon: 'search', title: 'Keep typing', body: 'Nothing is searched until two characters.', micro: '', retry: false };
  }
  if (error && error.term === t) {
    if (error.kind === 'rate') {
      return { icon: 'clock', title: 'Too many searches', body: 'Wait a minute, then try again.', micro: '', retry: true };
    }
    if (error.kind === 'server') {
      return { icon: 'alert', title: 'Search failed', body: 'The server couldn’t run this search. Try again in a moment.', micro: '', retry: true };
    }
    return { icon: 'alert', title: 'Search didn’t answer', body: 'Check the signal, then try again.', micro: '', retry: true };
  }
  if (!pending && resultsFor === t && (!groups || groups.length === 0)) {
    return {
      icon: 'search', title: `No matches for “${t}”`,
      body: 'Try a last name, an email address, or the last four digits of a phone.', micro: '', retry: false,
    };
  }
  return null;
}

export function flightLabel(resultsFor) {
  return resultsFor ? `searching · showing “${resultsFor}”` : 'searching…';
}

// What the polite status line says.
export function liveSummary({ pending, note, groups }) {
  if (pending) return 'Searching';
  if (note) return note.title;
  const n = (groups || []).reduce((sum, g) => sum + g.rows.length, 0);
  if (!n) return '';
  const more = groups.some((g) => g.full);
  return `${n}${more ? '+' : ''} ${n === 1 && !more ? 'result' : 'results'}`;
}
```

- [ ] **Step 4: Run the tests and lint the new module**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/searchView.test.js`
Expected: PASS, every test. Quote the count.
Then: `cd client && npx eslint --max-warnings=0 src/utils/searchView.js` (the build cannot lint it yet: nothing the bundle imports reaches it until Task 5). Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/searchView.js client/src/utils/searchView.test.js && git commit -F - <<'MSG'
feat(mobile): the phone search model, groups, rows, targets and notes (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 3: A desktop view for one visit (`MobileViewContext`)

Dallas, 2026-10-16, on the More rows' sticky override: "I'd rather it not stick." Search therefore opens a desktop page for that visit only. This task adds that second kind of override to the one context every phone fork reads; Task 4's page is its only caller.

**Files:**
- Modify: `client/src/context/MobileViewContext.js` (58 lines: imports `:1-6`, the default value `:10-14`, the overrides and their setter `:30-49`)
- Modify: `client/src/context/MobileViewContext.test.js` (62 lines; three tests appended)

**Interfaces:**
- Consumes: `routeScreenKey(pathname)` from `client/src/utils/screenKey.js` (`/events?tab=all` is `events-list`, `/clients/3` is `clients`, `/search` is `search`).
- Produces: `useMobileView()` also returns `setDesktopForVisit(screenKey)`. It arms a desktop view for `screenKey` that is held in memory only (never written to `adminDesktopViewOverrides`), applies while the routed screen key equals `screenKey`, and ends when the routed screen key changes (Back included) or when `setDesktopView(screenKey, false)` runs (the Phone view pill). It is armed BEFORE the navigation: until the next route lands the visit waits, and a landing on any other screen drops it. `desktopView(screenKey)` is true for a sticky override OR a live visit. `setDesktopView` (the sticky kind, the header's escape) is unchanged.
- Decisions implemented here: 7 and 8 (search's desktop pages are for the visit only).

- [ ] **Step 1: Write the failing tests**

In `client/src/context/MobileViewContext.test.js`, after the `wrapper` const (`:15`) add:

```js
const wrapperAt = (path) => ({ children }) => (
  <MemoryRouter initialEntries={[path]}>
    <MobileViewProvider>{children}</MobileViewProvider>
  </MemoryRouter>
);
const stored = () => JSON.parse(window.localStorage.getItem('adminDesktopViewOverrides') || '{}');
```

and append at the end of the file:

```js
// Global search opens a desktop page for ONE visit (lane ma-f3; Dallas,
// 2026-10-16: "I'd rather it not stick").
test('a visit shows its screen in desktop view, survives navigation within the page, and ends when the user leaves', () => {
  const { result } = renderHook(
    () => ({ view: useMobileView(), navigate: useNavigate() }),
    { wrapper: wrapperAt('/search') },
  );
  act(() => {
    result.current.view.setDesktopForVisit('events-list');
    result.current.navigate('/events?tab=all');
  });
  expect(result.current.view.desktopView('events-list')).toBe(true);
  expect(result.current.view.desktopView('event-detail')).toBe(false);
  expect(stored()).toEqual({});
  // The page's own tabs, filters and drawers are the same visit.
  act(() => result.current.navigate('/events?tab=upcoming', { replace: true }));
  act(() => result.current.navigate('/events?tab=upcoming&drawer=shift:12'));
  expect(result.current.view.desktopView('events-list')).toBe(true);
  // Leaving ends it, and Back does not bring it back.
  act(() => result.current.navigate('/search'));
  expect(result.current.view.desktopView('events-list')).toBe(false);
  act(() => result.current.navigate(-1));
  expect(result.current.view.desktopView('events-list')).toBe(false);
  expect(stored()).toEqual({});
});

test('a visit armed in one step and navigated in the next still lands; one that lands elsewhere is dropped', () => {
  const { result } = renderHook(
    () => ({ view: useMobileView(), navigate: useNavigate() }),
    { wrapper: wrapperAt('/search') },
  );
  act(() => result.current.view.setDesktopForVisit('clients'));
  expect(result.current.view.desktopView('clients')).toBe(false); // waiting, still on /search
  act(() => result.current.navigate('/clients/3'));
  expect(result.current.view.desktopView('clients')).toBe(true);
  act(() => result.current.navigate('/search'));
  act(() => result.current.view.setDesktopForVisit('staffing'));
  act(() => result.current.navigate('/events'));
  act(() => result.current.navigate('/staffing/users/12'));
  expect(result.current.view.desktopView('staffing')).toBe(false); // dropped, not lying in wait
});

test('the Phone view pill ends a visit; a sticky override is untouched by visits', () => {
  const { result } = renderHook(
    () => ({ view: useMobileView(), navigate: useNavigate() }),
    { wrapper: wrapperAt('/search') },
  );
  act(() => result.current.view.setDesktopView('inbox', true));
  act(() => {
    result.current.view.setDesktopForVisit('clients');
    result.current.navigate('/clients/3');
  });
  expect(result.current.view.desktopView('clients')).toBe(true);
  act(() => result.current.view.setDesktopView('clients', false));
  expect(result.current.view.desktopView('clients')).toBe(false);
  expect(result.current.view.desktopView('inbox')).toBe(true);
  expect(stored()).toEqual({ inbox: true });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/context/MobileViewContext.test.js`
Expected: the two existing tests pass; the three new ones FAIL with `result.current.view.setDesktopForVisit is not a function`.

- [ ] **Step 3: Implement**

In `client/src/context/MobileViewContext.js`:
- After `import { readOverrides, persistOverrides } from '../utils/desktopViewStore';` add `import { routeScreenKey } from '../utils/screenKey';`.
- In the default value, after `setDesktopView: () => {},` add `setDesktopForVisit: () => {},`.
- Replace everything from `const [overrides, setOverrides] = useState(readOverrides);` through the end of the `value` memo with:

```js
  const [overrides, setOverrides] = useState(readOverrides);
  // A desktop view for ONE visit (lane ma-f3; Dallas, 2026-10-16: "I'd rather
  // it not stick"). Global search opens a desktop page this way. It lives in
  // memory only, never in the store. It holds while the routed screen is the
  // one it was armed for, so that page's own tabs, filters, drawers and paging
  // keep it, and it ends the moment the user leaves that screen, Back
  // included. It is armed before the navigation: on `from`, the path it was
  // armed on, it waits; a landing on any other screen drops it.
  const [visit, setVisit] = useState(null);
  const routed = routeScreenKey(pathname);
  let liveVisit = visit;
  if (visit) {
    if (routed === visit.screenKey) {
      if (!visit.entered) {
        liveVisit = { ...visit, entered: true };
        setVisit(liveVisit);
      }
    } else if (visit.entered || pathname !== visit.from) {
      liveVisit = null;
      setVisit(null);
    }
  }
  // A visit still waiting for its navigation applies to nothing yet.
  const visitKey = liveVisit && liveVisit.entered ? liveVisit.screenKey : null;
  const desktopView = useCallback(
    (screenKey) => !!overrides[screenKey] || screenKey === visitKey,
    [overrides, visitKey]
  );
  const setDesktopView = useCallback((screenKey, on) => {
    // The Phone view pill calls this with false; it ends a visit too.
    if (!on) setVisit((v) => (v && v.screenKey === screenKey ? null : v));
    // The context owns the merge; the store only persists. Storage failures
    // therefore never drop other screens' overrides from live state.
    setOverrides((prev) => {
      const next = { ...prev };
      if (on) next[screenKey] = true;
      else delete next[screenKey];
      persistOverrides(next);
      return next;
    });
  }, []);
  const setDesktopForVisit = useCallback((screenKey) => {
    setVisit({ screenKey, from: pathname, entered: false });
  }, [pathname]);
  const value = useMemo(
    () => ({ isPhone, desktopView, setDesktopView, setDesktopForVisit }),
    [isPhone, desktopView, setDesktopView, setDesktopForVisit]
  );
```

Also extend the comment at `:8-9` to: `// isPhone plus the per-screen Desktop-view overrides (spec section 3): the sticky kind the header's escape sets, and the one-visit kind global search uses.`

The render-time `setVisit` follows the `latch` pattern a few lines above it (React re-renders at once and the guard makes the second pass a no-op).

- [ ] **Step 4: Run the context suite and every suite that reads the context**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/context/MobileViewContext.test.js src/components/AdminLayout.badges.test.js src/components/mobile src/pages/mobile src/pages/admin/EventsDashboard.fork.test.js src/pages/admin/ProposalsDashboard.fork.test.js src/pages/admin/EventDetailPage.fork.test.js src/pages/admin/Inbox.test.js`
Expected: PASS, every test (five in the context suite). Quote the counts. Then `cd client && CI=true npx react-scripts build` (the context is already in the bundle, so the build lints it): exit 0, only the known banner warning.

- [ ] **Step 5: Commit**

```bash
git add client/src/context/MobileViewContext.js client/src/context/MobileViewContext.test.js && git commit -F - <<'MSG'
feat(mobile): a desktop view for one visit, held in memory, ending when the user leaves the screen

Global search opens its desktop pages this way so nothing sticks
(Dallas, 2026-10-16). The sticky header escape is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 4: `SearchPhone`, its CSS, and the class contract

**Files:**
- Create: `client/src/pages/mobile/SearchPhone.js`
- Create: `client/src/pages/mobile/SearchPhone.test.js`
- Modify: `client/src/index.css` (a new block after the line `html[data-app="admin-os"][data-skin="light"] .m-empty.ok { color: var(--ms-emerald); }`, about `:21652`)
- Modify: `client/src/utils/mobileClassContract.test.js:7-26` (`SOURCES`) and one new test at the end

**Interfaces:**
- Consumes, from the committed `client/src/utils/searchView.js` (Task 2; read it, it is the source of truth): `GROUP_LIMIT` (6); `termState(raw)` (`'empty' | 'short' | 'long' | 'ok'`); `searchGroups(results, term)` returning groups `{ key, label, rows, full, count, moreLabel, more }`, each row `{ key, title, kind, meta, lead, chip, desktop, target }` with `lead` one of `{ kind: 'icon', icon }`, `{ kind: 'initials', initials }`, `{ kind: 'rail', rail: { dow, day, mon }, noDate }`, `chip` `{ label, kind }` or null, `target` and `more` `{ path, screenKey }` (`screenKey` null when no override is armed); `searchNote({ raw, offline, error, pending, resultsFor, groups })` returning `{ icon, title, body, micro, retry }` or null; `errorKind(err)` (`'network' | 'rate' | 'server'`); `flightLabel(resultsFor)`; `liveSummary({ pending, note, groups })`. Also `useMobileView()` (`isPhone`, and `setDesktopForVisit(screenKey)` from Task 3, the one-visit desktop view; never the sticky `setDesktopView`); `useDebounce(callback, delay, deps)`; `api.get`; `Icon`, `StatusChip`.
- Decisions implemented here: 1 (the takeover's own header, no toggle), 2 (the term in history state, focus only on an empty open), 3 (api.get only; offline from `navigator.onLine`), 4 (three failed-search notes), 5 (the kind on its own line), 6 (the quiet rail), 7 and 8 (rows and More rows open desktop for the visit only), 9 (the 44px field), 10 (the in-flight line), 11 (Enter and a window Escape), 12 (the status line and the scoped note queries), and Review Focus 1, 2, 3 and 5.
- Produces: `export default function SearchPhone()`, the screen for the route `/search`. It renders a `<header className="m-header m-search-head">` and a `<main className="m-main m-search-main" id="main-content">` as siblings, so its parent must be the `.m-shell` with nothing else in it (Task 5).

- [ ] **Step 1: Write the failing tests**

Create `client/src/pages/mobile/SearchPhone.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import SearchPhone from './SearchPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const mockMobileView = { isPhone: true, setDesktopView: jest.fn(), setDesktopForVisit: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));

const client = (over = {}) => ({ type: 'client', id: 3, name: 'Marcus Keller', detail: 'mkeller@example.test', cc_id: null, ...over });
const proposal = (over = {}) => ({
  type: 'proposal', id: 40, name: 'Alexis Henderson', detail: 'Wedding Reception · Oct 24, 2026',
  status: 'sent', event_date: '2026-10-24', kind: 'Wedding Reception', ...over,
});
const event = (over = {}) => ({
  type: 'event', id: 41, name: 'Nautilus Group', detail: 'Corporate Event · Oct 3, 2026',
  status: 'confirmed', event_date: '2026-10-03', kind: 'Corporate Event', ...over,
});
const staff = (over = {}) => ({ type: 'staff', id: 12, name: 'Jordan Lee', detail: 'Active bartender', cc_id: null, ...over });
const NONE = { clients: [], proposals: [], events: [], staff: [] };
const RESULTS = { clients: [client(), client({ id: 4, name: 'Marrow Gallery', detail: '' })], proposals: [proposal()], events: [event()], staff: [staff()] };
const answer = (results) => ({ data: { results } });
const many = (make, n) => Array.from({ length: n }, (_, i) => make({ id: 100 + i, name: `Name ${i}` }));

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc" data-state={JSON.stringify(l.state)}>{l.pathname + l.search}</div>;
}
function mount(entry = '/search') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/search" element={<><SearchPhone /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}
const field = () => screen.getByRole('searchbox', { name: 'Global search' });
const type = (v) => fireEvent.change(field(), { target: { value: v } });
// The polite status line repeats the note's title (plan decision 12), so a
// note is found by its visible title element.
const NOTE = { selector: '.m-empty-title' };
const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const loc = () => screen.getByTestId('loc');
function setOnline(v) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockMobileView.isPhone = true;
  setOnline(true);
});

test('opens on the empty field: focused, the note, no request, no Clear', async () => {
  mount();
  expect(field()).toHaveFocus();
  expect(field()).toHaveAttribute('placeholder', 'Search clients, proposals, events, staff…');
  expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
  expect(screen.getByText('Search every record', NOTE)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Search every record');
  expect(screen.getByText('Clients, proposals, events and staff, by name, email, or phone number.')).toBeInTheDocument();
  expect(screen.getByText('phone match needs 3+ digits')).toHaveClass('m-snote-micro');
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('one character keeps typing and searches nothing', async () => {
  mount();
  type('k');
  expect(screen.getByText('Keep typing', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Nothing is searched until two characters.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('two characters search the live endpoint, never the offline store, and group in the palette order', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'ma' }, timeout: 10000 }));
  expect(api.get.mock.calls[0][1].headers).toBeUndefined();
  await screen.findByText('Marcus Keller');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Clients 2', 'Proposals 1', 'Events 1', 'Staff 1']);
  expect(screen.getByRole('status')).toHaveTextContent('5 results');
  expect(JSON.parse(loc().dataset.state)).toEqual({ q: 'ma' });
});

test('each group draws its row anatomy', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  const c = (await screen.findByText('Marcus Keller')).closest('button');
  expect(c).toHaveClass('m-card', 'm-srow');
  expect(within(c).getByText('mkeller@example.test')).toHaveClass('m-card-meta');
  expect(within(c).getByText('Desktop')).toHaveClass('tag');
  expect(c.querySelector('.m-srow-tile svg')).not.toBeNull();
  // No email or phone: no blank second line.
  expect(screen.getByText('Marrow Gallery').closest('button').querySelector('.m-card-meta')).toBeNull();
  const p = screen.getByText('Alexis Henderson').closest('button');
  expect(within(p).getByText('Wedding Reception')).toHaveClass('m-card-kind');
  expect(within(p).getByText('Oct 24, 2026')).toHaveClass('m-card-meta');
  expect(within(p).getByText('Sent').closest('.chip')).toHaveClass('info');
  expect(within(p).queryByText('Desktop')).toBeNull();
  const e = screen.getByText('Nautilus Group').closest('button');
  expect(within(e).getByText('SAT')).toHaveClass('m-rail-dow');
  expect(within(e).getByText('03')).toHaveClass('m-rail-day');
  expect(within(e).getByText('OCT')).toHaveClass('m-rail-mon');
  expect(within(e).getByText('Corporate Event')).toHaveClass('m-card-kind');
  const s = screen.getByText('Jordan Lee').closest('button');
  expect(within(s).getByText('JL')).toHaveClass('m-srow-tile', 'm-srow-initials');
  expect(within(s).getByText('Active bartender')).toHaveClass('m-card-meta');
  expect(within(s).getByText('Desktop')).toBeInTheDocument();
  expect(c).toHaveAccessibleName('Marcus Keller mkeller@example.test Desktop');
});

test('typing fast sends one request, for the settled term', async () => {
  api.get.mockResolvedValue(answer(NONE));
  mount();
  type('m'); type('ma'); type('mar'); type('mars');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  await wait(300);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'mars' }, timeout: 10000 });
});

test.each([
  ['Marcus Keller', '/clients/3', 'clients'],
  ['Jordan Lee', '/staffing/users/12', 'staffing'],
  ['Alexis Henderson', '/proposals/40', null],
  ['Nautilus Group', '/events/41', null],
])('tapping %s opens %s', async (name, path, screenKey) => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  fireEvent.click((await screen.findByText(name)).closest('button'));
  expect(loc()).toHaveTextContent(path);
  // Desktop for this visit only; search never arms the sticky override.
  if (screenKey) expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith(screenKey);
  else expect(mockMobileView.setDesktopForVisit).not.toHaveBeenCalled();
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('a full group says 6+ and ends in its More row, which opens the desktop list', async () => {
  api.get.mockResolvedValue(answer({ ...NONE, clients: many(client, 6), proposals: many(proposal, 6) }));
  mount();
  type('ma');
  await screen.findByText('More clients on desktop');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Clients 6+', 'Proposals 6+']);
  expect(screen.getAllByText('6 shown')).toHaveLength(2);
  fireEvent.click(screen.getByText('More proposals on desktop').closest('button'));
  expect(mockMobileView.setDesktopForVisit).toHaveBeenCalledWith('proposals-list');
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
  expect(loc()).toHaveTextContent('/proposals?q=ma');
});

test('nothing matched quotes the term', async () => {
  api.get.mockResolvedValue(answer(NONE));
  mount();
  type('zephyr');
  expect(await screen.findByText('No matches for “zephyr”', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Try a last name, an email address, or the last four digits of a phone.')).toBeInTheDocument();
});

test('past a hundred characters: no request, the note counts them', async () => {
  mount();
  type('x'.repeat(101));
  expect(screen.getByText('Too long to search', NOTE)).toBeInTheDocument();
  expect(screen.getByText('101 characters')).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('an older answer that lands last never paints', async () => {
  const first = deferred(); const second = deferred();
  api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  type('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  await act(async () => { second.resolve(answer({ ...NONE, clients: [client({ name: 'Second Answer' })] })); });
  expect(await screen.findByText('Second Answer')).toBeInTheDocument();
  await act(async () => { first.resolve(answer({ ...NONE, clients: [client({ name: 'First Answer' })] })); });
  await wait(50);
  expect(screen.queryByText('First Answer')).toBeNull();
  expect(screen.getByText('Second Answer')).toBeInTheDocument();
});

test('the in-flight line: searching… first, then the old term while the new one runs', async () => {
  const next = deferred();
  api.get.mockResolvedValueOnce(answer(RESULTS)).mockReturnValueOnce(next.promise);
  mount();
  type('ma');
  expect(screen.getByText('searching…')).toHaveClass('m-sflight');
  expect(screen.getByRole('status')).toHaveTextContent('Searching');
  await screen.findByText('Marcus Keller');
  expect(screen.queryByText('searching…')).toBeNull();
  type('mar');
  expect(screen.getByText('searching · showing “ma”')).toBeInTheDocument();
  expect(screen.getByText('Marcus Keller')).toBeInTheDocument();
  expect(screen.queryByText(/No matches/)).toBeNull();
});

test('a search that answers after the user left never pulls them back', async () => {
  const late = deferred();
  api.get.mockResolvedValueOnce(answer(RESULTS)).mockReturnValueOnce(late.promise);
  mount();
  type('ma');
  await screen.findByText('Nautilus Group');
  type('mar');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('Nautilus Group').closest('button'));
  expect(loc()).toHaveTextContent('/events/41');
  await act(async () => { late.resolve(answer(RESULTS)); });
  await wait(50);
  expect(loc()).toHaveTextContent('/events/41');
});

test('offline: the field keeps its text, disabled, the rows go, the note; back online searches again', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await screen.findByText('Marcus Keller');
  setOnline(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  expect(field()).toBeDisabled();
  expect(field()).toHaveValue('ma');
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
  expect(screen.getByText('offline · field kept, results off')).toBeInTheDocument();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  setOnline(true);
  act(() => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
  expect(field()).not.toBeDisabled();
});

test('offline at open sends nothing', async () => {
  setOnline(false);
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toBeDisabled();
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('going offline mid-search drops the answer', async () => {
  const late = deferred();
  api.get.mockReturnValueOnce(late.promise);
  mount();
  type('ma');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  setOnline(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  await act(async () => { late.resolve(answer(RESULTS)); });
  await wait(50);
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  expect(screen.getByText('Search needs the server', NOTE)).toBeInTheDocument();
});

test('a failed search offers Retry; a 429 says too many; any other server answer says it failed', async () => {
  api.get.mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  mount();
  type('ma');
  expect(await screen.findByText('Search didn’t answer', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Check the signal, then try again.')).toBeInTheDocument();
  api.get.mockResolvedValueOnce(answer(RESULTS));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
  api.get.mockRejectedValueOnce({ status: 429, message: 'Too many searches. Please slow down.' });
  type('mar');
  expect(await screen.findByText('Too many searches', NOTE)).toBeInTheDocument();
  expect(screen.getByText('Wait a minute, then try again.')).toBeInTheDocument();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  api.get.mockRejectedValueOnce({ status: 500, message: 'Something went wrong.' });
  type('mars');
  expect(await screen.findByText('Search failed', NOTE)).toBeInTheDocument();
  expect(screen.getByText('The server couldn’t run this search. Try again in a moment.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('Back from a result: the term returns with the keyboard down and runs again', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toHaveValue('ma');
  expect(field()).not.toHaveFocus();
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/search', { params: { q: 'ma' }, timeout: 10000 }));
  expect(await screen.findByText('Marcus Keller')).toBeInTheDocument();
});

test('Clear empties the field, drops the rows and puts focus back', async () => {
  api.get.mockResolvedValue(answer(RESULTS));
  mount();
  type('ma');
  await screen.findByText('Marcus Keller');
  field().blur();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(field()).toHaveValue('');
  expect(field()).toHaveFocus();
  expect(screen.queryByText('Marcus Keller')).toBeNull();
  expect(screen.getByText('Search every record', NOTE)).toBeInTheDocument();
});

// Under MemoryRouter window.history.state is null, so these exercise the
// fallback to /events; the navigate(-1) branch is browser check S2.
test('the back arrow and Escape leave the screen; Escape works offline too', () => {
  const { unmount } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
  expect(loc()).toHaveTextContent('/events');
  unmount();
  const second = mount();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(loc()).toHaveTextContent('/events');
  second.unmount();
  setOnline(false);
  mount({ pathname: '/search', state: { q: 'ma' } });
  expect(field()).toBeDisabled();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(loc()).toHaveTextContent('/events');
});

test('the keyboard Search key puts the keyboard away', () => {
  mount();
  expect(field()).toHaveFocus();
  fireEvent.submit(field().closest('form'));
  expect(field()).not.toHaveFocus();
  expect(screen.getByRole('search')).toContainElement(field());
});

test('at desktop width the route goes to the dashboard', async () => {
  mockMobileView.isPhone = false;
  mount();
  expect(loc()).toHaveTextContent('/dashboard');
  await wait(300);
  expect(api.get).not.toHaveBeenCalled();
});

test('an event with no date keeps its rail with a dash and a spoken "no date"', async () => {
  api.get.mockResolvedValue(answer({ ...NONE, events: [event({ event_date: null })] }));
  mount();
  type('na');
  const e = (await screen.findByText('Nautilus Group')).closest('button');
  expect(within(e).getByText('–')).toHaveAttribute('aria-hidden', 'true');
  expect(within(e).getByText('no date')).toHaveClass('sr-only');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/SearchPhone.test.js`
Expected: FAIL, `Cannot find module './SearchPhone'`.

- [ ] **Step 3: Implement the page**

Create `client/src/pages/mobile/SearchPhone.js`:

```js
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import useDebounce from '../../hooks/useDebounce';
import { useMobileView } from '../../context/MobileViewContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import {
  GROUP_LIMIT, termState, searchGroups, searchNote, errorKind, flightLabel, liveSummary,
} from '../../utils/searchView';

// Phone global search (spec 2026-08-13-mobile-admin section 6; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Global search;
// lane ma-f3). A full-screen takeover at /search: AdminLayout renders no
// header and no tab bar for this route, so the screen draws its own header
// (Back and the field) and its own scrolling <main>.
//
// Nothing from search is ever stored on the phone: the read is api.get, never
// offlineGet, so the admin service worker sends it to the network untouched
// (the rows carry client emails and phones). Offline, the field keeps its
// text, disabled, and the note says search needs the server.
//
// Once a search answers, its term rides in this history entry's state, so
// Back from a result lands here with the term and runs it again. The term
// never enters the URL, and the route restore never records /search
// (utils/routeRestore.js).

// The palette's debounce (CommandPalette.js), as spec section 6 asks.
const DEBOUNCE_MS = 200;
// api.js sets no timeout; without one a search on a dead link pulses forever.
const TIMEOUT_MS = 10000;

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function Lead({ lead }) {
  if (lead.kind === 'rail') {
    const hide = lead.noDate ? 'true' : undefined;
    return (
      <span className="m-rail">
        {/* No date: the glyphs (an en dash) are hidden, so "no date" is the
            rail's whole spoken content (the Proposals list's rule). */}
        <span className="m-rail-dow" aria-hidden={hide}>{lead.rail.dow}</span>
        <span className="m-rail-day" aria-hidden={hide}>{lead.rail.day}</span>
        <span className="m-rail-mon" aria-hidden={hide}>{lead.rail.mon}</span>
        {lead.noDate && <span className="sr-only">no date</span>}
      </span>
    );
  }
  if (lead.kind === 'initials') {
    return <span className="m-srow-tile m-srow-initials" aria-hidden="true">{lead.initials}</span>;
  }
  return <span className="m-srow-tile" aria-hidden="true"><Icon name={lead.icon} size={18} /></span>;
}

// The spaces between pieces are for the button's accessible name; inside the
// flex row they render as nothing. The kind has its own line in the UI face
// (.m-card-kind, the card family's), the meta its own in the numeric face.
function SearchRow({ row, onOpen }) {
  return (
    <button type="button" className="m-card m-srow" onClick={() => onOpen(row.target)}>
      <Lead lead={row.lead} />{' '}
      <span className="m-srow-body">
        <span className="m-srow-title">{row.title}</span>
        {row.kind ? <>{' '}<span className="m-card-kind">{row.kind}</span></> : null}
        {row.meta ? <>{' '}<span className="m-card-meta">{row.meta}</span></> : null}
      </span>
      {row.chip ? <>{' '}<StatusChip kind={row.chip.kind}>{row.chip.label}</StatusChip></> : null}
      {row.desktop ? <>{' '}<span className="tag">Desktop</span></> : null}
    </button>
  );
}

export default function SearchPhone() {
  const { isPhone, setDesktopForVisit } = useMobileView();
  const navigate = useNavigate();
  const location = useLocation();
  const [initialTerm] = useState(() => {
    const s = location.state;
    return s && typeof s.q === 'string' ? s.q : '';
  });
  const [q, setQ] = useState(initialTerm);
  const [results, setResults] = useState(null);       // the last answer's groups, raw
  const [resultsFor, setResultsFor] = useState(null); // the term that answer is for
  const [error, setError] = useState(null);           // { term, kind: 'rate' | 'failed' }
  const [offline, setOffline] = useState(() => !isOnline());
  const reqId = useRef(0);
  const inputRef = useRef(null);
  const term = q.trim();
  const state = termState(term);

  // Any answer still on its way is dropped when it lands.
  const cancel = useCallback(() => { reqId.current += 1; }, []);
  const forget = useCallback(() => {
    cancel();
    setResults(null);
    setResultsFor(null);
    setError(null);
  }, [cancel]);

  const run = useCallback((t) => {
    const id = ++reqId.current;
    setError(null);
    api.get('/admin/search', { params: { q: t }, timeout: TIMEOUT_MS })
      .then((res) => {
        if (id !== reqId.current) return;
        setResults((res && res.data && res.data.results) || {});
        setResultsFor(t);
        navigate('/search', { replace: true, state: { q: t } });
      })
      .catch((err) => {
        if (id !== reqId.current) return;
        setResults(null);
        setResultsFor(null);
        setError({ term: t, kind: errorKind(err) });
      });
  }, [navigate]);

  useDebounce(() => {
    if (!isPhone || offline || state !== 'ok') return;
    run(term);
  }, DEBOUNCE_MS, [term, offline]);

  const close = useCallback(() => {
    cancel();
    if (window.history.state && window.history.state.idx > 0) navigate(-1);
    else navigate('/events', { replace: true });
  }, [cancel, navigate]);

  // Leaving: an answer that lands later must not write this screen's history
  // entry over the page the user went to. Its own effect, so re-subscribing
  // the listeners below can never drop a search in flight.
  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    const goOffline = () => { forget(); setOffline(true); };
    const goOnline = () => setOffline(false);
    // Escape closes from anywhere on the screen, as the benchmark listens,
    // including offline, when the field is disabled.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('keydown', onKey);
    };
  }, [forget, close]);

  if (!isPhone) return <Navigate to="/dashboard" replace />;

  // A desktop page from search is for this visit only (MobileViewContext's
  // setDesktopForVisit): leaving it, Back included, returns the phone to how
  // it was. Search never arms the sticky override.
  const open = (target) => {
    if (!target) return;
    cancel();
    if (target.screenKey) setDesktopForVisit(target.screenKey);
    navigate(target.path);
  };
  const onChange = (e) => {
    const v = e.target.value;
    setQ(v);
    // Below two characters or past a hundred nothing is searched: the rows on
    // screen go at once, as the benchmark draws it, not at the debounce.
    if (termState(v) !== 'ok') forget();
  };
  const clear = () => {
    setQ('');
    forget();
    if (inputRef.current) inputRef.current.focus();
  };
  const retry = () => { if (state === 'ok' && !offline) run(term); };
  // The keyboard's Search key: put the keyboard away so the rows show.
  const onSubmit = (e) => {
    e.preventDefault();
    if (inputRef.current) inputRef.current.blur();
  };

  const pending = state === 'ok' && !offline && term !== resultsFor && !(error && error.term === term);
  const groups = state === 'ok' && !offline ? searchGroups(results, resultsFor) : [];
  const note = searchNote({ raw: term, offline, error, pending, resultsFor, groups });

  return (
    <>
      <header className="m-header m-search-head">
        <button type="button" className="m-iconbtn" onClick={close} aria-label="Close search">
          <Icon name="left" size={20} />
        </button>
        <form className="m-search-field" role="search" onSubmit={onSubmit}>
          <span className="m-search-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
          <input
            ref={inputRef}
            type="search"
            className="m-search-input"
            value={q}
            onChange={onChange}
            disabled={offline}
            autoFocus={!initialTerm}
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search clients, proposals, events, staff…"
            aria-label="Global search"
          />
          {term.length > 0 && (
            <button type="button" className="m-search-clear" onClick={clear} aria-label="Clear search">
              <Icon name="x" size={16} />
            </button>
          )}
        </form>
      </header>
      <main className="m-main m-search-main" id="main-content">
        <h1 className="sr-only">Search</h1>
        <div className="sr-only" role="status" aria-live="polite">{liveSummary({ pending, note, groups })}</div>
        {pending && <div className="m-sflight" aria-hidden="true">{flightLabel(resultsFor)}</div>}
        {groups.map((g) => (
          <section key={g.key}>
            <h2 className="m-sgroup-head">
              <span className="m-sgroup-label">{g.label}</span>{' '}
              <span className="m-sgroup-count">{g.count}</span>
            </h2>
            {g.rows.map((row) => <SearchRow key={row.key} row={row} onOpen={open} />)}
            {g.more && (
              <button type="button" className="m-card m-srow-more" onClick={() => open(g.more)}>
                <span className="m-srow-more-icon" aria-hidden="true"><Icon name="external" size={16} /></span>
                <span className="m-srow-more-label">{g.moreLabel}</span>{' '}
                <span className="m-srow-more-count">{GROUP_LIMIT} shown</span>
              </button>
            )}
          </section>
        ))}
        {note && (
          <div className="m-empty m-snote">
            <Icon name={note.icon} size={28} />
            <div className="m-empty-title">{note.title}</div>
            <div className="m-empty-body">{note.body}</div>
            {note.micro ? <div className="m-snote-micro">{note.micro}</div> : null}
            {note.retry ? <button type="button" className="m-retry-btn" onClick={retry}>Retry</button> : null}
          </div>
        )}
      </main>
    </>
  );
}
```

If `react-scripts build` (Step 6) flags `react-hooks/exhaustive-deps` on the `useDebounce` call, do NOT add a disable comment there: the hook already carries its own (`useDebounce.js:19`); report the exact warning instead.

- [ ] **Step 4: The CSS**

In `client/src/index.css`, right after the line `html[data-app="admin-os"][data-skin="light"] .m-empty.ok { color: var(--ms-emerald); }`, insert:

```css

/* ---- Mobile admin: global search (lane ma-f3; spec section 6, benchmark
   docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Global
   search). A takeover: this header replaces the phone header and the tab bar
   is gone. The field is 44px tall and its Clear button 44px wide (drawn 40
   and 30), the phone's tap-target floor; the event rail keeps the family's
   44px width with the search's quieter inks. ---- */
html[data-app="admin-os"] .m-header.m-search-head { gap: 6px; padding: 8px 10px 8px 2px; }
html[data-app="admin-os"] .m-search-field {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  min-height: 44px; margin: 0; padding: 0 10px;
  border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--bg-3);
}
/* The input draws no outline (as drawn); the field's border carries focus. */
html[data-app="admin-os"] .m-search-field:focus-within { border-color: var(--accent); }
html[data-app="admin-os"] .m-search-icon { flex: none; display: flex; color: var(--ink-3); }
html[data-app="admin-os"] .m-search-input {
  flex: 1; min-width: 0; height: 42px; padding: 0; border: none; outline: none; background: transparent;
  color: var(--ink-1); font-family: var(--font-ui); font-size: 13.5px; -webkit-appearance: none; appearance: none;
}
/* type="search" draws its own clear button; the screen draws one of its own. */
html[data-app="admin-os"] .m-search-input::-webkit-search-cancel-button,
html[data-app="admin-os"] .m-search-input::-webkit-search-decoration { -webkit-appearance: none; display: none; }
html[data-app="admin-os"] .m-search-input:disabled { opacity: 0.55; }
/* iOS Safari zooms the page when a field under 16px takes focus (the
   assignment sheet's field carries the same rule). */
@supports (-webkit-touch-callout: none) {
  html[data-app="admin-os"] .m-search-input { font-size: 16px; }
}
html[data-app="admin-os"] .m-search-clear {
  flex: none; display: flex; align-items: center; justify-content: center;
  width: 44px; height: 42px; margin-right: -10px; padding: 0;
  border: none; background: transparent; color: var(--ink-3); cursor: pointer;
}
html[data-app="admin-os"] .m-main.m-search-main { padding-top: 4px; }
html[data-app="admin-os"] .m-sflight {
  padding: 8px 4px 4px; text-align: center; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); animation: m-pulse 1.2s ease-in-out infinite;
}
html[data-app="admin-os"] .m-sgroup-head {
  display: flex; align-items: baseline; gap: 8px; margin: 0; padding: 12px 4px 6px;
  font-size: inherit; font-weight: 400; line-height: normal;
}
html[data-app="admin-os"] .m-sgroup-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-sgroup-count { font-family: var(--font-numeric); font-size: 10.5px; color: var(--ink-4); }
html[data-app="admin-os"] .m-card.m-srow { align-items: center; gap: 12px; min-height: 56px; }
html[data-app="admin-os"] .m-srow .m-rail { align-self: stretch; }
html[data-app="admin-os"] .m-srow .m-rail-dow,
html[data-app="admin-os"] .m-srow .m-rail-mon { color: var(--ink-4); }
html[data-app="admin-os"] .m-srow .m-rail-day { color: var(--ink-2); }
html[data-app="admin-os"] .m-srow-tile {
  width: 34px; height: 34px; flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm); background: var(--bg-3); color: var(--ink-3);
}
html[data-app="admin-os"] .m-srow-tile.m-srow-initials { color: var(--ink-2); font-family: var(--font-mono); font-size: 11px; font-weight: 600; }
html[data-app="admin-os"] .m-srow-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
html[data-app="admin-os"] .m-srow-title {
  min-width: 0; font-size: var(--fs-body); font-weight: 600; color: var(--ink-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
html[data-app="admin-os"] .m-srow .m-card-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-app="admin-os"] .m-srow .chip,
html[data-app="admin-os"] .m-srow .tag { flex: none; }
html[data-app="admin-os"] .m-card.m-srow-more { align-items: center; gap: 10px; padding: 12px 14px; min-height: 48px; }
html[data-app="admin-os"] .m-srow-more-icon { flex: none; display: flex; color: hsl(var(--accent-h) var(--accent-s) 62%); }
html[data-app="admin-os"] .m-srow-more-label { flex: 1; min-width: 0; font-size: var(--fs-meta); font-weight: 600; color: hsl(var(--accent-h) var(--accent-s) 62%); }
html[data-app="admin-os"] .m-srow-more-count { flex: none; font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-4); }
html[data-app="admin-os"] .m-empty.m-snote { padding-top: 58px; color: var(--ink-4); }
html[data-app="admin-os"] .m-snote .m-empty-body { max-width: 240px; }
html[data-app="admin-os"] .m-snote-micro { margin-top: 2px; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-4); }
html[data-app="admin-os"][data-skin="light"] .m-search-field { border-radius: 0; }
html[data-app="admin-os"][data-skin="light"] .m-srow-more-icon,
html[data-app="admin-os"][data-skin="light"] .m-srow-more-label { color: var(--accent); }
```

- [ ] **Step 5: The class contract**

In `client/src/utils/mobileClassContract.test.js`, add `'pages/mobile/SearchPhone.js',` to `SOURCES` right after `'pages/mobile/ProposalsListPhone.js',`, and append at the end of the file:

```js
// Spec section 3 (Global search): the field is type="search", so the build
// hides the browser's own clear button; the screen draws its own.
test('the search field hides the browser clear button', () => {
  expect(css).toMatch(/\.m-search-input::-webkit-search-cancel-button[^{]*\{[^}]*display:\s*none/);
});
```

- [ ] **Step 6: Run the tests and the build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/SearchPhone.test.js src/utils/searchView.test.js src/utils/mobileClassContract.test.js`
Expected: PASS, every test (25 in `SearchPhone.test.js`), no "not wrapped in act(...)" warnings in the output. Quote the counts.
Then lint the new page directly, because the build cannot reach it until Task 5 imports it: `cd client && npx eslint --max-warnings=0 src/pages/mobile/SearchPhone.js src/utils/searchView.js`. Expected: no output, exit 0. A warning here is fixed at its root, never with a disable comment; report what it was.
Then: `cd client && CI=true npx react-scripts build`. Expected: exit 0; the only warning in the banner is the known `html2pdf.js` source map (Global Constraints).

- [ ] **Step 7: Commit**

The commit hook's `check-docs-drift.sh` warns about a new file under `client/src/pages/`. That is expected: the README and ARCHITECTURE lines land in Task 7. Do not edit them here.

```bash
git add client/src/pages/mobile/SearchPhone.js client/src/pages/mobile/SearchPhone.test.js client/src/index.css client/src/utils/mobileClassContract.test.js && git commit -F - <<'MSG'
feat(mobile): the full-screen phone search screen, its states and its CSS

Live reads only (nothing stored on the phone), the term kept in history
state for Back, rows and More rows opening desktop pages for that visit
only, where the benchmark sends them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Wire it in: the route, the takeover, the magnifier, the restore

**Files:**
- Modify: `client/src/App.js:142` (one lazy import after `NotificationsPhone`), `:613` (one route after `/more/notifications`)
- Modify: `client/src/components/AdminLayout.js:253` (a branch before `if (mobileChrome) {`)
- Create: `client/src/components/AdminLayout.search.test.js`
- Modify: `client/src/components/mobile/MobileHeader.js:1-12` (imports and the header comment), `:54` (the palette hook), `:88-97` (the magnifier)
- Modify: `client/src/components/mobile/MobileHeader.test.js:6-7` (the palette mock) and one new test
- Modify: `client/src/utils/routeRestore.js:22-31`, `client/src/utils/routeRestore.test.js` (one test)
- Modify: `client/src/utils/screenKey.test.js:3-15` (one table row)

**Interfaces:**
- Consumes: Task 4's `SearchPhone` default export; `routeScreenKey('/search') === 'search'` (already true).
- Produces: `/search` is a live admin route; on the phone it renders inside `<div className="m-shell">` alone; the phone header's magnifier calls `navigate('/search')`; `recordRoute('/search', ...)` is a no-op.
- Decisions implemented here: 1 (the takeover: no phone header, no passkey nudge, no tab bar; the palette stays mounted) and 2 (the restore never records `/search`).

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/AdminLayout.search.test.js`:

```js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../utils/api';
import AdminLayout from './AdminLayout';

// The real AdminLayout at phone width with its side effects stubbed (the
// badges suite's harness), proving the search route is a takeover (lane
// ma-f3): the screen alone in the shell, no phone header, no tab bar.
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin', name: 'Dee Admin' }, logout: () => {} }),
}));
jest.mock('../context/UserPrefsContext', () => ({ useUserPrefs: () => ({ prefs: {}, setPref: () => {} }) }));
jest.mock('../utils/adminSw', () => ({ registerAdminSw: () => Promise.resolve(), announceAdminSwUser: () => {} }));
jest.mock('../utils/installAdminPwaMeta', () => ({ installAdminPwaMeta: () => {} }));
jest.mock('@sentry/react', () => ({ setTag: () => {} }));
jest.mock('./adminos/PresenceStrip', () => ({ __esModule: true, default: () => null }));
jest.mock('./adminos/Header', () => ({ __esModule: true, default: () => null }));
jest.mock('./adminos/CommandPalette', () => ({ __esModule: true, default: () => null }));
jest.mock('./mobile/MobileLockScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('./mobile/PasskeyEnrollNudge', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  // Phone width. The same stub answers the standalone query, which is
  // harmless: nothing is recorded, so nothing is restored.
  window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  window.localStorage.clear();
  window.sessionStorage.clear();
  api.get.mockResolvedValue({ data: {} });
});

function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/search" element={<div data-testid="screen">search screen</div>} />
          <Route path="/events" element={<div data-testid="screen">events screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test('the search route is a takeover: the screen alone in the shell', async () => {
  mount('/search');
  const s = await screen.findByTestId('screen');
  expect(s).toHaveTextContent('search screen');
  expect(document.querySelector('.m-shell')).toContainElement(s);
  expect(document.querySelector('.m-header')).toBeNull();
  expect(document.querySelector('.m-tabbar')).toBeNull();
});

test('every other phone route keeps the phone header and the tab bar', async () => {
  mount('/events');
  expect(await screen.findByTestId('screen')).toHaveTextContent('events screen');
  expect(document.querySelector('.m-header')).not.toBeNull();
  expect(document.querySelector('.m-tabbar')).not.toBeNull();
});
```

In `client/src/components/mobile/MobileHeader.test.js`, KEEP lines 6-7 (the `mockPalette` const and the `PaletteContext` mock) for now: the header still calls `usePalette()` until Step 3, and without the mock every test in the file would fail for that reason instead of the one this step is about. After line 7 add:

```js
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useNavigate: () => mockNavigate }));
```

and append:

```js
test('the magnifier opens the full-screen search, not the palette', () => {
  render(<MobileHeader title="Proposals" screenKey="proposals-list" />);
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(mockNavigate).toHaveBeenCalledWith('/search');
});
```

In `client/src/utils/routeRestore.test.js`, append:

```js
test('the search screen is never recorded: the screen before it stays the resume target', () => {
  recordRoute('/proposals/42', '');
  recordRoute('/search', '');
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42');
});
```

In `client/src/utils/screenKey.test.js`, add `['/search', 'search'],` to the `test.each` table after `['/inbox/t-neg_123', 'inbox-item'],`.

- [ ] **Step 2: Run them to see the right ones fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/AdminLayout.search.test.js src/components/mobile/MobileHeader.test.js src/utils/routeRestore.test.js src/utils/screenKey.test.js`
Expected: exactly three failures. The takeover test FAILS (a `.m-header` and a `.m-tabbar` are present on `/search`); the magnifier test FAILS (`mockNavigate` was not called: the button still opens the palette); the restore test FAILS (it restores `/search`). The `/search` screen-key row PASSES already (it is a pin, not new behaviour), and every other test passes, the ten existing MobileHeader tests included.

- [ ] **Step 3: Implement**

`client/src/utils/routeRestore.js`: above `export function recordRoute`, add

```js
// The search screen is never a resume target: its term lives in history
// state, which a cold launch does not have, and an empty field with the
// keyboard up is not "where I left off" (lane ma-f3). The screen before it
// stays recorded.
const NEVER_RECORDED = new Set(['/search']);
```

and make the first line of `recordRoute`'s body `if (NEVER_RECORDED.has(pathname)) return;`.

`client/src/components/mobile/MobileHeader.js`:
- Replace `import { usePalette } from '../../context/PaletteContext';` with `import { useNavigate } from 'react-router-dom';`.
- In the header comment, replace the words `global search (opens the existing command palette until the full-screen search screen lands),` with `global search (the full-screen search screen at /search, lane ma-f3),` and rewrap the comment.
- Replace `const { openPalette } = usePalette();` with `const navigate = useNavigate();`.
- In the magnifier button, replace `onClick={openPalette}` with `onClick={() => navigate('/search')}`.
- In `MobileHeader.test.js`, now delete lines 6-7 (the `mockPalette` const and the `PaletteContext` mock): the header no longer imports the context.

`client/src/components/AdminLayout.js`: immediately before `if (mobileChrome) {`, insert:

```js
  // Full-screen search (spec section 6, lane ma-f3): the screen draws its own
  // header (Back and the field) and its own <main id="main-content">, so the
  // shell holds it alone; no phone header, no passkey nudge, no tab bar, as
  // the benchmark draws the takeover. The palette stays mounted for a
  // hardware ⌘K.
  if (mobileChrome && screenKey === 'search') {
    return (
      <PaletteContext.Provider value={paletteCtx}>
        <a href="#main-content" className="skip-nav">Skip to main content</a>
        <div className="m-shell"><Outlet context={outletCtx} /></div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </PaletteContext.Provider>
    );
  }

```

`client/src/App.js`: after `const NotificationsPhone = lazy(() => import('./pages/mobile/NotificationsPhone'));` add `const SearchPhone = lazy(() => import('./pages/mobile/SearchPhone'));`, and after `<Route path="/more/notifications" element={<NotificationsPhone />} />` add `<Route path="/search" element={<SearchPhone />} />`.

- [ ] **Step 4: Run the suites and the build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/AdminLayout.search.test.js src/components/AdminLayout.badges.test.js src/components/mobile src/utils/routeRestore.test.js src/utils/screenKey.test.js src/utils/mobileClassContract.test.js src/pages/mobile`
Expected: PASS, every test, no `act()` warnings from the suites this task touched. Quote the counts.
Then: `cd client && CI=true npx react-scripts build` → `Compiled successfully`. The size hook warns on `App.js` (708 lines, over the 700 soft cap); that is expected and not a block.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.js client/src/components/AdminLayout.js client/src/components/AdminLayout.search.test.js client/src/components/mobile/MobileHeader.js client/src/components/mobile/MobileHeader.test.js client/src/utils/routeRestore.js client/src/utils/routeRestore.test.js client/src/utils/screenKey.test.js && git commit -F - <<'MSG'
feat(mobile): the magnifier opens the full-screen search; /search is a phone takeover and never a resume target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Phone-viewport gate and the benchmark comparison (controller-run)

Subagents cannot mint dev tokens (`reference-subagent-dev-token-refused`), so the controller runs this task and hands the ui-ux seat the shots plus the DOM and computed CSS. Harness traps: `reference-phone-browser-gate-traps` (dev-signin plants the token only on ports 3000 and 3001, so the lane's client runs on 3001 with its API on a scoped port; a fresh context's first loads are not controlled by the worker; a locator click on an off-screen element scrolls first).

**Files:**
- Modify: `scripts/mobile-capture.manifest.json` (one entry after the `admin-proposals-unviewed` entry, `:86-87`)

- [ ] **Step 1: The manifest**

After the `admin-proposals-unviewed` entry add:

```json
    { "name": "admin-search", "host": "localhost", "path": "/search", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-search-head" },
```

- [ ] **Step 2: Run the capture**

`mobile:check` hardcodes port 3000 (`scripts/mobile-capture.js:103`), so for this step the LANE's client runs on 3000 (stop main's dev client if one holds the port, and restore it after), with the lane's API up: `npm run mobile:check`. Expected: `admin-search` passes the overflow probe; report its `taps<36` and `tiny<12` counts beside the proposals pages' (the 10px labels are drawn, so tiny text is expected).

- [ ] **Step 3: Render the benchmark's Global search per state**

Copy `docs/design-artifacts/` (the snapshot, `support.js`, `_ds/`) into a folder in the session scratchpad (never inside `os` or the lane). For each variant, rewrite the HTML-escaped `data-props` defaults in the copy: `searchState` (`&quot;default&quot;: &quot;live typing&quot;` becomes the variant), `keyboard` (`&quot;default&quot;: true` in the `keyboard` entry becomes `false`, so the drawn keyboard does not cover the rows), `offline`, `skin`. Variants: `empty field`, `type more`, `in flight`, `results`, `nothing matched`, and `results` with `offline` true; each in `dark` and `light`. Serve with `python3 -m http.server` from the copy, load in headless Chromium (`~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, network on: the runtime loads React from unpkg) at 460x960, click `[aria-label="Search"]` in the header, wait 1.5 s, screenshot. Twelve shots beside the lane's ledger.

- [ ] **Step 4: Ad hoc browser checks (record S1 to S12 in this plan's "Browser checks" table, on main, before the merge)**

Chromium 390x844 (then 360 and 320 for S10), a dev admin session, the lane's client:
- S1: the magnifier on every tab (Inbox, Events, Proposals and More) opens `/search` full screen: no `.m-tabbar`, no `.m-brandmark`, `document.activeElement` is the field, `history.length` grew by one.
- S2: `page.goBack()` from `/search` lands on the tab it came from; the in-app Back arrow does the same; Escape with the field focused does the same.
- S3: typing one character makes no request (network log); typing a surname present in the dev DB quickly (five characters within 150 ms) makes ONE `GET /api/admin/search` request, and its request headers carry no `x-offline-ok`; the groups render in the order Clients, Proposals, Events, Staff with their counts.
- S4: a client row opens `/clients/<id>` in the desktop chrome with the Phone view pill; Back lands on `/search` with the term in the field, the rows back, and the field NOT focused; `localStorage.adminDesktopViewOverrides` is byte-identical to before the tap; Back again to the tab, then More > Clients (or `/clients` by URL) shows the phone chrome, not the desktop chrome.
- S5: an event row opens the phone event detail (`/events/<id>`); Back returns to the search with its term.
- S6: a term that fills a group (try two-letter terms until one gives `6+`, preferring an Events group): the More row opens that group's desktop list in the desktop chrome (Events `/events?tab=all`; Proposals `/proposals?q=<term>` with the filter applied); on that page switch its tab and open a shift drawer: it stays in the desktop chrome. Back to the search, Back to the Events tab: the PHONE Events list, and `localStorage.adminDesktopViewOverrides` byte-identical to before (Dallas, 2026-10-16: nothing sticks). Then on a second More row, the Phone view pill returns that same page to the phone chrome at once.
- S7: offline: `context.setOffline(true)` (this flips `navigator.onLine` and fires `offline`; the screen does not depend on the worker): the field keeps its text, disabled, at 0.55 opacity; the note reads "Search needs the server"; `setOffline(false)` runs the term again.
- S8: nothing stored: after S3 to S5, `caches.keys()` then each cache's `keys()` hold no URL containing `/api/admin/search`.
- S9: a failed search: stop the lane's API by its LISTENER pid (`ss -ltnp`, not `$!`), type a new term: "Search didn’t answer" with Retry; restart the API, Retry: the rows render.
- S10: both skins at 390, 360 and 320 beside the Step 3 renders: header (Back, field radius, icon, Clear), the in-flight line, group heads and counts, each row kind (icon tile, initials tile, quieter rail, the kind line in the UI face and the date line in the numeric face, chip, Desktop tag), the More row in the link colour, every note with its icon and micro line; no horizontal scroll at 320 with a long name and a chip on one row.
- S11: `getComputedStyle(field, '::-webkit-search-cancel-button').display` is `none`; the Clear button measures 44 by at least 42 and `document.elementFromPoint` at its centre is the button; every row measures at least 56 tall and the More row at least 48.
- S12: at desktop width `/search` lands on `/dashboard`, and ⌘K still opens the desktop palette with its groups; after visiting `/search` on the phone, `localStorage.adminLastRoute` names the screen before it, not `/search`.

Then dispatch the ui-ux-review seat against the benchmark's Global search (the twelve renders, plus the lane shots, DOM and computed CSS the controller captured); adherence to the artifact is its primary benchmark. Brief it with the sanctioned departures so it does not re-flag them: decision 1 (no tab bar, no toggle, the takeover), 5 (the kind on its own line; a proposal's date under it), 6 (the 44px rail with the quieter inks, the 12px row gap), 8 (More row destinations), 9 (the 44px field; the 44 by 42 Clear), 11 (Escape on the window), 12 (the accessibility additions), 13 (no mock keyboard), 14 (two-letter initials), and decision 4's three failed-search notes.

- [ ] **Step 5: Commit**

```bash
git add scripts/mobile-capture.manifest.json && git commit -F - <<'MSG'
test(mobile): phone-viewport capture page for the admin search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Docs and ledgers

**Files:**
- Modify: `README.md:610`, `:650`, `:707` and after `:820`, `ARCHITECTURE.md:225` and after `:2136`, `scripts/sensitive-paths.txt:475-481`, `docs/walkthroughs-owed.md` (the Tier 6 count sentence at `:2115`, and the end of Tier 6, before `## Tier 4`), `docs/fix-list-remaining-2026-07-02.md:3042-3044` and the Admin UI follow-ups

- [ ] **Step 1: README**

In the `MobileViewContext.js` tree line (`:610`), after `per-screen Desktop-view overrides` add ` (sticky, from the header's escape) and a one-visit override (setDesktopForVisit, held in memory, ending when the user leaves the screen; global search opens its desktop pages with it)`.

In Key Features, "Phone Admin PWA", after the `**Admin push per kind (lane ma-c-push).**` bullet (`:820`), add:

`- **Phone global search (lane ma-f3).** The magnifier on every phone tab opens a full-screen search over clients, proposals, events and staff (by name, email, or three or more phone digits), grouped with counts like the ⌘K palette. Events open the phone event detail, proposals the proposal page, clients and staff their desktop pages; a group of six ends in a row that opens the full desktop list. A desktop page opened from search is desktop for that visit only: leave it and the phone is as it was. It runs live only: nothing from search is stored on the phone, and offline the field waits for the connection. Back from a result returns to the search and its term.`

After the `proposalCards.js` line (`:650`) add, aligned like its neighbours:

```
│   │   │   ├── searchView.js        # The phone search's model (pure): term states, the groups with counts and More rows, each row's anatomy and where it leads, the notes
```

In the `pages/mobile/` line (`:707`), after the `ProposalsListPhone (...)` clause, add: `SearchPhone (the full-screen global search at /search, opened by the phone header's magnifier: GET /admin/search live and never stored, groups with counts and More on desktop rows, Desktop-tagged client and staff rows, and the empty, keep-typing, in-flight, no-match, too-long, failed and offline states), `.

- [ ] **Step 2: ARCHITECTURE**

In the admin `GET /search` row (`:225`), before the closing `|`, append: ` Proposal and event rows also carry \`status\`, \`event_date\` (YYYY-MM-DD or null) and \`kind\` (the event-type label) for the phone search (lane ma-f3); the palette reads only \`type, id, name, detail\`.`

After the "Phone Proposals list" bullet (`:2136`), add:

`- **Phone search**: \`client/src/pages/mobile/SearchPhone.js\` at \`/search\` (phone only; desktop width redirects to \`/dashboard\`), opened by the phone header's magnifier; \`AdminLayout\` renders it alone in the shell, with no phone header and no tab bar. Reads \`GET /admin/search\` through \`api.get\`, never \`offlineGet\`, so the worker stores no result (its allowlist entry for the path is inert under the opt-in rule); the palette's 200 ms debounce, a 10 s timeout, a superseded-answer guard. The model is the pure \`client/src/utils/searchView.js\`. The term rides in the \`/search\` history entry's state so Back from a result returns to it, and \`utils/routeRestore.js\` never records \`/search\`. Client and staff rows and every full group's More row open their desktop page for that visit only (`setDesktopForVisit` in `client/src/context/MobileViewContext.js`: held in memory, never stored, kept through the page's own tabs, filters and drawers, ended when the user leaves the screen or taps Phone view); the header's own escape stays sticky.`

- [ ] **Step 3: Sensitive paths, walkthroughs, fix list**

`scripts/sensitive-paths.txt`: in the `offlineGet` block (`:476-481`), extend the comment by one sentence, `SearchPhone.js is listed because it must never opt in: its rows carry client emails and phones, and the phone stores nothing from search.`, and add `client/src/pages/mobile/SearchPhone.js` on its own line after `client/src/pages/mobile/ProposalsListPhone.js`.

`docs/walkthroughs-owed.md`: in the Tier 6 count sentence (`:2115`), change "As of 2026-10-15 this tier holds ONE item, below: the consult call record." to "As of 2026-10-XX this tier holds TWO items, below: the consult call record and the phone global search (lane ma-f3-search)." Then append at the END of Tier 6, right before `## Tier 4`:

```markdown
### Global search on the phone (lane ma-f3-search, built 2026-10-XX; moves to Tier 3b when its squash is an ancestor of `origin/main`)

The walk, on the Pixel, in the installed app:
1. On Events, tap the magnifier (it is on every tab): the search fills the screen, the keyboard comes up, the tab bar is gone.
2. Type one letter: "Keep typing". Type a client's surname: the groups appear in the order Clients, Proposals, Events, Staff, each with its count; the keyboard's Search key puts the keyboard away.
3. Tap an event: its phone detail opens. Press Back: the search is there with the term and the rows, keyboard down.
4. Tap a client (it carries "Desktop"): the desktop client page opens with the Phone view pill. Back returns to the search.
5. Find a term that fills a group ("6+"): the "More ... on desktop · 6 shown" row opens that list on desktop. Back to the search, Back to the tab: the phone screen, as it was (nothing sticks).
6. Airplane mode: the field keeps its text, greyed; "Search needs the server". Airplane off: the search runs again.
7. Back from the search returns to the tab you opened it from.
```

`docs/fix-list-remaining-2026-07-02.md`: right after the sentence ending "Still declared and unbuilt: `ma-f2-proposal-detail`, `ma-f3-search`.**" (`:3044`), add: **AMENDED 2026-10-XX: full-screen SEARCH is built by lane `ma-f3-search` (`docs/superpowers/plans/2026-10-15-mobile-admin-search.md`); the phone header's magnifier opens `/search` instead of the palette. Still declared and unbuilt: `ma-f2-proposal-detail`.** And under Admin UI, beside the phone-list follow-ups, one new bullet: `- The admin worker still allowlists /api/admin/search, but nothing opts in: the phone search reads through api.get and stores nothing (lane ma-f3). Drop the entry at the next admin-sw change, with its allowlist test. Lane ma-f3, 2026-10-XX.`

- [ ] **Step 4: Check the docs took**

`node -e "console.log(require('./scripts/sensitive-match.js').matchSensitive(['client/src/pages/mobile/SearchPhone.js']))"` prints the path (the list matches it). `grep -n "holds TWO items" docs/walkthroughs-owed.md` finds the amended sentence. `grep -cP "\x{2014}" README.md ARCHITECTURE.md docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md` (the em dash by code point) shows no count higher than on main (`git show main:<file> | grep -cP "\x{2014}"` per file): this task adds no em dash.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md scripts/sensitive-paths.txt docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md && git commit -F - <<'MSG'
docs(mobile): the phone search in the README tree, the route table, the phone surfaces, the sensitive list, the walk and the fix list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 8: Lane close: suites reached, gate, review fleet, merge

- [ ] **Step 1: Server suite, from the lane root**

`node --test server/utils/globalSearch.test.js` (the only suite that imports the module; the route file has none). Quote the count. Confirm no `zz_searchtest_` client remains.

- [ ] **Step 2: Client suites and build**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/searchView.test.js src/context/MobileViewContext.test.js src/pages/mobile src/components/mobile src/components/AdminLayout.search.test.js src/components/AdminLayout.badges.test.js src/pages/admin/EventsDashboard.fork.test.js src/pages/admin/ProposalsDashboard.fork.test.js src/pages/admin/EventDetailPage.fork.test.js src/pages/admin/Inbox.test.js src/utils/routeRestore.test.js src/utils/screenKey.test.js src/utils/mobileClassContract.test.js src/components/adminos` then `CI=true npx react-scripts build`. Zero `act()` warnings in the suites this lane added. Quote the counts.

- [ ] **Step 3: Desktop regression by eye**

Desktop viewport: ⌘K opens the palette with the same four groups and rows as on main (the new fields change nothing it draws); the Toolbar's search launcher still opens the palette; `/search` redirects to `/dashboard`.

- [ ] **Step 4: Review fleet, per the lane map**

code-review, consistency-check, `/second-opinion` over the whole lane diff, and the ui-ux seat (it ran in Task 6 Step 4 against the benchmark; it runs again on any fix delta below). Reviewers run on Opus. Fix rounds as needed; record the as-built deltas in this plan's "Lane review round" section.

After the LAST fix round: re-run Steps 1 and 2 on the lane HEAD and quote the counts; if a fix touched a client UI file (`SearchPhone.js`, `index.css`, `AdminLayout.js`, `MobileHeader.js`), re-run the browser checks it can move (S10 and S11 at least for CSS, the S check that covers any behaviour changed) and send the ui-ux seat the fix delta; update the Browser checks table.

- [ ] **Step 5: Plan sections on main, then merge**

The "Browser checks" table and the "Lane review round" section are written into this plan on main; commit them there (explicit pathspec, this plan file only) BEFORE the merge, because `scripts/merge-lane.sh` refuses a dirty tree.

If main moved since the cut, rebase the lane onto `main`; then re-run Steps 1 and 2 on the rebased HEAD and have the code-review seat re-confirm any rebased hunk inside the footprint (the merge model's "re-confirmed against main's new HEAD"). Squash-merge through `os` on `main` via `scripts/merge-lane.sh ma-f3-search docs/superpowers/plans/2026-10-15-mobile-admin-search.md ma-f3-search`. On merged main: `node --test server/utils/globalSearch.test.js` and `cd client && CI=true npx react-scripts build`; quote both. Then `npm run worktree:rm -- ma-f3-search --force` after the three checks; the board line via `scripts/board-write.sh "Recently shipped" ...`; the close record in this plan; the `2026-10-XX` dates in Task 7's docs filled in. No push: that waits for Dallas's cue, and the push that carries this squash runs the sensitive-path re-review over `SearchPhone.js` (see "Review level").

## Self-Review (2026-10-15)

1. **Spec coverage.** Section 6: the magnifier on every tab (Task 5; the detail variant keeps dropping it, as drawn), the same `/admin/search` endpoint (Task 4), a full-screen takeover (Tasks 4, 5), grouped as the palette groups them (Task 2), large tap rows (Task 4 CSS, S11); grounding: max 6 per group with the More row (Task 2, Task 4), empty under 2 and over 100 (Task 2 `termState`, Task 4 no request), the 60/min limit surfaced as its own note (Task 2, Task 4), the palette's debounce (Task 4), "type more" distinct from "nothing matched" (Task 2, Task 4). Section 3's Global search line: back arrow, groups with counts, "More clients on desktop · 6 shown", the Desktop tag on client and staff rows, the empty, keep-typing, in-flight, no-match and offline states with their copy, the field disabled offline, `type="search"` with the browser clear button suppressed (Tasks 2, 4, 6). Section 7: nothing cached for search (Task 4, S8). Section 9: the restore never lands on the takeover (Task 5). Section 10: failed reads surface through the normalized `err.status` (Tasks 2, 4). Section 2: the field extension (Task 1; the spec names it since the plan fold, which amended sections 2, 3, 7 and 9 on main). Docs law (Task 7). Gaps: none found.
2. **Placeholder scan.** The `2026-10-XX` dates in Task 7 are filled at lane close (Task 8 Step 5). No TBDs.
3. **Type consistency.** Task 1's `status`, `event_date`, `kind` are what Task 2's `searchRow` reads. Task 2's export names (`GROUP_LIMIT, termState, searchGroups, searchNote, errorKind, flightLabel, liveSummary`) are Task 4's imports; the `Row`, `Group` and `Note` shapes match the page's reads (`row.lead.kind`, `row.kind`, `row.meta`, `row.target`, `g.more`, `note.retry`); the error kinds `network | rate | server` match between `errorKind`, `searchNote` and the tests. `setDesktopForVisit(screenKey)` is Task 3's export and Task 4's only call; the screen keys it receives are Task 2's `rowTarget` and `moreTarget` keys, pinned against `routeScreenKey` in Task 2. Every screen key a target arms matches `routeScreenKey` (pinned in Task 2). `/search` is the route in Task 5, the path the magnifier navigates to, the path `routeRestore` skips, and the manifest path in Task 6.
4. **Review Focus.** Each of the five lines names the task and test that pins it; the tests exist in the task bodies above.

## Plan fleet fold (2026-10-15)

Three seats on Opus over `d2b11c58`: fidelity PASS, decomposition PASS, feasibility FAIL on one blocker. Feasibility ran the plan's code in a scratch mirror: Task 1's server suite 10 pass / 3 fail red, then 13 / 0 green with the fixtures cleaned up (the proposals table's NOT NULL columns all default, its CHECKs pass, no insert trigger); the model 29 / 29; the class contract 24 / 24; the CI build clean of ESLint warnings; the CSS specificity and the palette-scope check clean. Folded:

- **Blocker (feasibility, fidelity):** 9 of the 25 screen tests failed with "Found multiple elements", because the polite status line repeats the note's title. Note queries now take `{ selector: '.m-empty-title' }` (25 / 25 in the mirror with that change); decision 12 now says the status line reads its state from mount.
- **The spec amendment had no owner (all three seats).** Done on main with this fold: section 2 names the search row fields, section 3 carries "Plan decisions of 2026-10-15 (lane ma-f3)", section 7's allowlist sentence says search stores nothing, section 9's "Never persisted" names `/search`.
- **The proposal row's kind was in the numeric face (fidelity).** A proposal row is now three lines, the family's: name, kind (`.m-card-kind`), date (`.m-card-meta`, formatted from `event_date`); `Row` carries `kind` and `meta` instead of `line2`. Decision 5 rewritten.
- **A server error read as a signal problem (fidelity, section 10).** `errorKind` maps status 0 to "Search didn’t answer", 429 to "Too many searches", anything else to "Search failed". Decision 4 rewritten.
- **Task 5's red run was mispredicted (feasibility).** The palette mock now stays until Step 3, so exactly three tests fail for the right reasons.
- **Lint could not reach the new modules before Task 5 (decomposition).** Tasks 2 and 4 lint them directly with `npx eslint --max-warnings=0`.
- **No re-verification after fix rounds or a rebase, plan sections not committed before the merge, the post-merge server suite missing (decomposition).** Task 8 Steps 4 and 5.
- **Decision context missing from per-task dispatches (decomposition).** The header's dispatch rule, and a "Decisions implemented here" line on Tasks 2, 4 and 5.
- **Stated now:** no Desktop-view toggle on the takeover (decision 1), the 12px row gap (decision 6), the Clear button's 42px height (decision 9), Escape on the window so it works offline (decision 11), two-letter initials (decision 14), the review level and the push-time sensitive re-review (lane map).
- **Smaller:** the Tier 6 count sentence, the README Key Features bullet and a docs check (Task 7), the Inbox tab in S1, the lane client on port 3000 for `mobile:check`, the scratchpad for the renders, `ma-f1-proposals-list` in `depends_on`, the "match the artifact" scope wording, the known build banner and test noise (Global Constraints), Node's `ℹ pass` reporter wording, anchor drift (`MobileViewContext.js`, the spec's `:25`, the sensitive block's `:475`), the back-arrow test's fallback-only coverage noted.
- Disclosed by feasibility: its mirror build wrote through the symlinked `node_modules` into `os/client/node_modules/.cache` (gitignored babel and ESLint caches; no tracked file). The next build there re-lints cold.

**Amended 2026-10-16 (Dallas, on the More rows' sticky override: "I'd rather it not stick").** A new Task 3 gives `MobileViewContext` a one-visit override (`setDesktopForVisit`: in memory, never stored, kept through the page's own tabs, filters and drawers, ended when the user leaves the screen or taps Phone view); the old Tasks 3 to 7 are now 4 to 8. Search's client and staff rows and every More row use it, never the sticky `setDesktopView`, so decision 8's "Known cost" is gone. Decisions 7 and 8, the Global Constraints, the footprint (the context and its test), S4 and S6, the README and ARCHITECTURE lines, the walk, the lane-close suite list and the spec's section 3 block follow.
