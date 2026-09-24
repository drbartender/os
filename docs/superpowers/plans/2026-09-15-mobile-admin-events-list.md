# Mobile Admin Events List (lane ma-e1-events-list) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone Events tab stops showing the desktop table inside the phone chrome and renders the phone-first Events list from the 2026-09-15 benchmark: date-rail cards grouped one per event, the Upcoming / Past switch, the Needs staff chip, server paging with Show more, the staleness line on cache-served reads, skeleton, empty and end states, and taps that open the event detail (booked events) or the shift drawer (manual shifts).

**Architecture:** The admin branch of `GET /shifts` gains an opt-in scoped mode (`?scope=upcoming|past` plus `limit`, `offset`, `needs_staff`) that pages by EVENT, not by shift row, and answers an envelope with totals; the legacy call with no `scope` stays byte-identical so the desktop dashboard, the Overview page and the staff pages never notice. The big admin SELECT moves verbatim into `shifts.queries.js` so both modes share one projection. On the client a pure module groups the per-shift rows into cards, a new `EventsListPhone` page renders them with new `.m-card` family CSS folded from the design system's mobile CSS and the benchmark's inline treatment, and `EventsDashboard` forks at the top through `useMobileView()` so the URL, the route table and the desktop component are untouched.

**Tech Stack:** Express + pg (`pool.query`, one CTE chain), Node 26 `node --test` with the repo's hand-rolled `node:http` harness, React 18 + react-router (`useUrlListState`, `useDrawerParam`), jest + RTL 13 (jest-dom imported per file), `playwright-core` with the bundled Chromium for the phone-viewport gate, `scripts/mobile-capture.js` (`npm run mobile:check`).

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`: section 3 (fork, Visual contract, the 2026-09-15 design-session decisions), section 4 List (with the 2026-09-15 badge-predicate correction), section 7 Offline (staleness line, allowlist), section 9 (list scroll restore), section 10 (error handling), section 11 (per-screen gate).

**Benchmark (Visual contract):** `docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html`, Events tab, all states. It renders locally: `cd docs/design-artifacts && python3 -m http.server 8765` then a headless Chromium at 460x960 on `http://127.0.0.1:8765/2026-09-15-mobile-admin-shell.dc.html` (the runtime loads React from unpkg, so the box needs network). The states to compare against: Upcoming default, Past, Needs staff on, Needs staff on with nothing open ("Fully staffed"), empty Upcoming ("Nothing on the calendar"), empty Past ("No past events"), cold load skeleton ("first sync · fetching events"), Show more row ("Show more · 7 of 12"), end divider ("END OF UPCOMING · 12 EVENTS"), cancelled card on Past, manual card ("MANUAL · TAP TO STAFF"), two-shift card ("4/4 · 2 SHIFTS"), offline stale line with the amber dot. Both skins.

**Scope:** Lane ma-e1-events-list only. It refines the foundation plan's declared `ma-e-events` lane (`docs/superpowers/plans/2026-08-13-mobile-admin-foundation.md`, Lane map) into the list now and the detail, staffing sheet and edit sheet as their own lanes, declared below. Manual shifts on the phone list open the EXISTING desktop `ShiftDrawer` in this lane as the no-dead-end interim; lane ma-e2-event-detail replaces that with the phone assignment sheet. Nothing in this lane writes; every endpoint it touches is a read.

**Proven context (verified against the repo 2026-09-15, not from memory):**
- `server/routes/shifts.js` (786 lines, last changed 2026-08-29): the admin branch of `GET /` is `:103-221`. `isManager` at `:104`; `pool.query(` opens at `:107`; `SELECT s.*,` is `:108`; the projection body runs from `u.email AS created_by_email,` (`:109`) through `) abr ON true` (`:217`); `ORDER BY s.event_date ASC` `:218`; `LIMIT 500` `:219`; `return res.json(result.rows)` `:221` (anchors re-verified 2026-09-18 by the plan fleet; the 9/15 numbers were stale). The handler reads NO query params today. It projects `rc.pending_count` (`:122`, defined `:208`), `rc.approved_count` (approved AND `dropped_at IS NULL`), `bar_required` via `barRequiredSql('p','spk')`, `COALESCE(p.guest_count, s.guest_count) AS proposal_guest_count`, `COALESCE(c.name, s.client_name) AS client_name`, `p.status AS proposal_status`, `s.*` (so `event_date`, `start_time`, `end_time`, `location`, `positions_needed`, `status`, `event_type`, `event_type_custom`, `proposal_id`, `supply_run_required`). Imports already present: `shiftNotFinishedSql` (`:12`), `barRequiredSql`, `planQueueSql` from `./shifts.queries` (`:26`).
- `server/routes/shifts.queries.js` (200 lines) exports `{ STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL, barRequiredSql, planQueueSql }` (`:200`) and imports `shiftNotFinishedSql` only (`:10`). `planQueueSql` is `{ select, drinkPlanJoin, consultJoin }` (`:165`).
- `server/utils/shiftEndInstant.js` exports `shiftNotFinishedSql(s, p)` (`:206`, `<end instant> > NOW()`) and its exact complement `shiftFinishedSql(s, p)` (`:219`). The `unstaffed_events` badge SQL in `server/routes/admin/settings.js:143-157` is `shiftNotFinishedSql('s','p') AND s.status = 'open' AND s.positions_needed IS JSON ARRAY AND jsonb_array_length(s.positions_needed::jsonb) > 0 AND (approved-and-not-dropped count) < jsonb_array_length(...)`. `GET /shifts/unstaffed-upcoming` (`shifts.js:264-297`) uses the same fragment and its header (`:255-264`) forbids the two drifting.
- `shifts.supply_run_required` (`server/db/schema.sql:4069`) is the Supplies flag; there is no `supply_run` column.
- Server suites that already call the admin branch of `GET /shifts`: `server/routes/shifts.planQueue.test.js` (seven admin GETs at `:159-209`, reading seven admin-branch columns) and, through the same mount, the other `server/routes/shifts*.test.js` suites and `server/routes/eventDetails.test.js`; Task 1 and Task 8 run all of them. Client callers of the bare feed: `client/src/pages/AdminDashboard.js:62`, `client/src/pages/admin/EventsDashboard.js:76`, `client/src/pages/admin/overview/OverviewPage.js:205`, `client/src/pages/staff/ShiftsPage.js:127,175`. None passes a query string, so the legacy shape must not change.
- Test harness exemplar: `server/routes/shifts.visibility.endInstant.test.js` (`require('dotenv').config()` first; `node:test`; production refusal guard `:43`; nonce'd fixtures; `get(path, token)` helper `:61-79`; `makeUser` `:82-91`; `tokenFor` `:92`; `seedShift` `:94-105`; Chicago clock derivation in `before()` `:107-135`). Suites run ONE AT A TIME from the repo root against the shared dev DB.
- `client/src/pages/admin/EventsDashboard.js` (373 lines): `export default function EventsDashboard()` at `:54`; `api.get('/shifts')` at `:76`; row click `:93-95` (proposal rows navigate to `/events/:proposal_id`, manual rows `drawer.open('shift', e.id)`); `ShiftDrawer` mounted `:233-237`; `LIST_DEFAULTS` `:25`.
- `client/src/hooks/useUrlListState.js`: `[state, setState]` over declared keys, `replace: true` always, undeclared params (`drawer`, `drawerId`) pass through. `client/src/hooks/useDrawerParam.js`: `{ kind, id, open, close }`, replace semantics (fine for this lane: the interim drawer is the desktop one).
- `client/src/context/MobileViewContext.js` exposes `{ isPhone, desktopView(screenKey), setDesktopView }` via `useMobileView()`. `client/src/utils/screenKey.js` already maps `/events` to `events-list`. `client/src/components/AdminLayout.js:232-256` renders the phone chrome with `<main className="m-main" id="main-content"><Outlet context={{ badges, refreshBadges }} /></main>`: the page renders INSIDE the scrolling `.m-main`, so a sticky apparatus row must be sticky inside that container, and scroll restore reads `document.getElementById('main-content')`. `AdminLayout.js:228-229` sets `Sentry.setTag('surface', 'mobile-admin')` on the global scope while the phone chrome is mounted (cleared on unmount), so every phone component's errors already carry the spec section 10 tag; no per-component tagging is needed.
- `client/src/utils/api.js:16-28`: every response carries `res.staleAt` when the service worker served it (`x-sw-cached-at`). `client/src/utils/staleTime.js:8` `formatStaleAt(iso, now) -> "as of 2:14 PM" | null`, with its test at `client/src/utils/staleTime.test.js`. Nothing imports it today; the `.m-stale` CSS exists (`index.css:20993-20998`). The benchmark (`renderVals` `:1611-1613`) has TWO stale states: live = `as of <fetch time>` with no dot, cache-served = `offline copy · as of <cached time>` with the amber dot, and only the time sits inside `.m-stale-time` (numeric font), so Task 4 adds a time-only formatter beside `formatStaleAt`.
- `scripts/mobile-capture.js:107` builds `http://${entry.host}:3000`, so `"host": "localhost"` reaches the admin app (`App.js` `getSiteContext`), its 390x844 viewport sits under the 700px fork, and `authAssert` is enforced (`:128-132`).
- `client/public/admin-sw.js:182-197`: `/api/shifts` is allowlisted by exact pathname; the Cache API keys on the full URL, so each `scope`/`offset`/`needs_staff` combination is its own cached entry. Nothing in the SW needs to change; this lane does not touch it.
- `client/src/index.css` (21309 lines): the mobile block is `:20934-21235` (`.m-shell` .. `.m-enroll-yes`), scoped `html[data-app="admin-os"]`, no media queries by design. `.m-seg`, `.m-seg-btn`, `.m-seg-btn.active`, `.m-seg-note` exist (`:21133-21159`) with light-skin squaring (`:21164-21176`). `.chip` family exists (`:12995+`, kinds neutral/ok/warn/danger/info/violet/accent) and `.tag` exists. NO `.m-card`, `.m-rail`, `.m-listbar`, `.m-skel`, `.m-end`, `.m-empty` exist. The Staff hub block's comment opens at `:21237` (`/* ====`), its text `Staff hub chrome` is `:21238`, and `.m-enroll-yes` closes the mobile block at `:21235`. `--fs-body` and `--fs-meta` are NOT defined anywhere in `index.css` (the only use, `.m-stale` at `:20994`, carries a fallback); the design system defines them in `docs/design-artifacts/_ds/.../tokens/typography.css:19,21` as 13px and 11.5px, so Task 3 defines them on `html[data-app="admin-os"]`. No `@keyframes m-pulse` exists yet.
- Design-system mobile CSS to fold from: `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css` (`.m-card`, `.m-card-title`, `.m-card-meta`, `.m-card-chip` and the light-skin squaring).
- Client helpers: `client/src/components/adminos/shifts.js` exports `isCancelledEvent(e)` (`:66`), `parsePositionsCount(s)` (`:115`, empty roster counts as 1 by law), `approvedCount(s)` (`:121`). `client/src/components/adminos/format.js` exports `fmtTimeRange24(start, end, durationHours)` (`:96`, returns `"19:00–23:00 · 4h"` when both ends are known) and `dayDiff(iso, todayYmd)` (`:166`). `client/src/utils/eventTypes.js` exports `getEventTypeLabel(row)` (`:8`, reads `event_type` and `event_type_custom`). The table in `client/src/data/eventTypes.js` has no `wedding` id (ids are `wedding-reception`, `rehearsal-dinner`, ..., `other`), so `wedding` falls back to `event`; fixtures use `wedding-reception` (label `Wedding Reception`). `StatusChip` (`client/src/components/adminos/StatusChip.js`) takes `kind`. `Icon` (`client/src/components/adminos/Icon.js`) needs an explicit `size`; names used here exist: `calendar`, `check`, `right`.
- Client test patterns: `client/src/components/mobile/MobileTabBar.test.js` (real `MemoryRouter`, `import '@testing-library/jest-dom'` first line); `client/src/pages/admin/CancelEventDialog.test.js:7` mocks `utils/api` with `jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn() } }))`.
- `scripts/mobile-capture.manifest.json` has NO admin-host page; `accounts.admin = { id: 1, tokenVersion: 0 }`; page fields are `name, host, path, auth, settleMs, authAssert, scrollableAllow, tokenQuery`. `npm run mobile:check` runs it (dev-only by construction).
- Docs anchors: `README.md:622` is the `pages/mobile/` tree line; `ARCHITECTURE.md:440` is the `GET /` row of the Shifts route table; `docs/walkthroughs-owed.md` is the owed-walk ledger; `docs/fix-list-remaining-2026-07-02.md:1808` is the "Mobile admin: every phone-first DATA screen" entry (`:1725` is the JSON-column migration item).
- None of `server/routes/shifts.js`, `server/routes/shifts.queries.js`, `client/src/pages/admin/EventsDashboard.js`, `client/src/index.css` is in `scripts/sensitive-paths.txt`.

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. Commas, colons, parentheses, the middle dot.
- **One fork, one breakpoint:** the phone branch comes from `useMobileView()` only. No new media queries; every new rule lives in the mobile block of `index.css`, scoped `html[data-app="admin-os"]`, both skins.
- **Legacy feed shape is frozen:** `GET /shifts` with no `scope` returns the same bare array with the same columns and order it returns today. The scoped mode is opt-in.
- **Chip predicate = badge predicate, at the event level:** a shift's `needs_staff` flag is the `unstaffed_events` fragment (end-instant helper, JSON-array guards, approved-and-not-dropped versus `positions_needed`); the chip keeps every shift of any EVENT that has a flagged shift, so a mixed event (one shift open, one staffed) stays whole and its card still says "2 shifts". A test pins the flagged shift set to the badge rows and the chip's event set to the badge's event set. The chip runs inside the upcoming scope, which also drops cancelled and archived events; today archiving reaps shifts to `cancelled`, so the badge's `status = 'open'` excludes the same rows and the two agree exactly. If a writer ever archives without reaping, the badge counts a shift the chip hides, and this sentence is where to look. Never `event_date >= CURRENT_DATE`.
- **One bucket per shift:** Upcoming = not finished (the shift end instant, the same boundary as the badge) AND live (not cancelled, proposal not archived). Past = finished OR cancelled OR archived, whatever the date, so a cancelled event with a future date sits on Past where the benchmark's muted Cancelled card lives instead of vanishing from the phone. Spec section 4's feed-grounding sentence said calendar day for the scope boundary; this plan uses the end instant so scope and chip share one boundary and the UTC `CURRENT_DATE` trap cannot come back (a finished same-day event moves to Past at its end instant, not at midnight); the spec sentence is amended in the fold commit.
- **Paging is by event:** an event's shifts never split across pages.
- **Staleness line, two states:** every loaded list carries `.m-stale`: live = `as of <fetch time>` with no dot; cache-served (`res.staleAt` present) = `offline copy · as of <cached time>` with the amber dot. Only the time sits inside `.m-stale-time`. A test asserts both states at the call site.
- **Writes: none in this lane.** Reads degrade per spec section 7.
- **44px minimum tap targets;** the whole card is the target; the apparatus row is sticky inside `.m-main`.
- **Copy from the benchmark, verbatim:** "Upcoming", "Past", "Needs staff", "as of" (live), "offline copy · as of" (cache-served, amber dot), "first sync · fetching events", "Show more", "End of upcoming · N events", "End of history · N events", "Nothing on the calendar" / "Booked proposals land here on their event date.", "No past events" / "Finished events will land here.", "Fully staffed" / "Every upcoming shift is covered. New applications will show up here.", "N request(s)", "Cancelled", "Manual · tap to staff", "Bar", "Supplies", "N shifts".
- **Server tests:** `node --test <file>` one suite at a time from the repo root; `require('dotenv').config()` on the first line; `NODE_ENV !== 'production'` guard; nonce'd fixtures cleaned in `after`.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`.
- **File-size ratchet:** `shifts.js` is 786 lines (yellow); this lane makes it SHORTER by moving the projection out. New files aim under 300 lines.
- **Explicit staging only;** commit messages carry NO backticks; stage and commit in one command chain.
- **Docs law (CLAUDE.md):** README folder tree (new page, new util), ARCHITECTURE route table (the scoped params and envelope), walkthroughs-owed (the Pixel walk), the fix-list entry.

## Lane map

```yaml
lanes:
  - id: ma-e1-events-list
    phase: 3
    scope: >
      Phone Events list per spec section 4 List and the 2026-09-15 benchmark:
      scoped, event-paged admin feed (GET /shifts?scope=upcoming|past with
      limit, offset, needs_staff and an envelope with totals), the pure row-to-
      card grouping module, the .m-card family CSS, EventsListPhone (apparatus,
      cards, Show more, end divider, skeleton, empty states, staleness line,
      scroll restore, taps), the EventsDashboard fork, the phone-viewport gate
      entries, docs. Manual shifts open the existing desktop ShiftDrawer as the
      interim (replaced by ma-e2).
    footprint:
      - server/routes/shifts.js
      - server/routes/shifts.queries.js
      - server/routes/shifts.adminScoped.test.js
      - client/src/utils/eventCards.js
      - client/src/utils/eventCards.test.js
      - client/src/utils/staleTime.js
      - client/src/utils/staleTime.test.js
      - client/src/pages/mobile/EventsListPhone.js
      - client/src/pages/mobile/EventsListPhone.test.js
      - client/src/pages/admin/EventsDashboard.js
      - client/src/pages/admin/EventsDashboard.fork.test.js
      - client/src/index.css
      - scripts/mobile-capture.manifest.json
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
    depends_on: []  # ma-a-shell, ma-b-pwa, ma-d-auth are merged and pushed
    review_fleet: [code-review, consistency-check, ui-ux-review]  # designed surface: ui-ux-review judges against the 2026-09-15 benchmark, Events tab

  # Declared, not planned here. Each gets its own plan when its turn comes.
  # These refine the foundation plan's ma-e-events and ma-f-proposals-search.
  - id: ma-e2-event-detail
    phase: 3
    scope: >
      Phone event detail (header with venue link and setup line, Contacts with
      the drink-plan day-of contact, Staffing card grouped per shift, Financials
      with the pending bank debit, Edit details row) and the assignment sheet
      (the phone ShiftDrawer: roster with inline Approve / Deny / Remove and
      confirms, role rows, alphabetical picker with search, seniority and
      distance meta, failure and offline states). Replaces the ma-e1 interim
      drawer for manual shifts. Owns the push-history variant of
      useDrawerParam (spec section 3: Android Back closes the sheet, never
      leaves the page). Route-dead fallback dispatch on 404/403 reads.
    footprint: []  # declared in its own plan
    depends_on: [ma-e1-events-list]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]  # assign/approve carry position, the payroll seam
  - id: ma-e3-edit-sheet
    phase: 3
    scope: >
      The ONE edit sheet for both details (date, start plus hours, guests,
      bartenders, add-on quantities, New total confirm, balance consequence on
      a booked event, offline lock) over proposalEditor formState/patchBody/
      repriceSummary with the full-hydration law. Money: full fleet.
    footprint: []  # declared in its own plan
    depends_on: [ma-e2-event-detail]
    review_fleet: [code-review, consistency-check, security-review, second-opinion, ui-ux-review]
  - id: ma-f1-proposals-list
    phase: 3
    scope: >
      Phone proposals list (Active bucket, Newest lead / Event date switch with
      the created_at sort key added to the whitelist, server-side Unviewed
      predicate, cards, paging, states) reusing the ma-e1 card family.
    footprint: []  # declared in its own plan
    depends_on: [ma-e1-events-list]
    review_fleet: [code-review, consistency-check, ui-ux-review]
  - id: ma-f2-proposal-detail
    phase: 3
    scope: >
      Phone proposal detail (status line, Contacts, Package and extras, Edit
      details row, Client link via the share sheet, Resend / Send reminder /
      Archive with a reason step).
    footprint: []  # declared in its own plan
    depends_on: [ma-f1-proposals-list, ma-e2-event-detail]
    review_fleet: [code-review, consistency-check, ui-ux-review]
  - id: ma-f3-search
    phase: 3
    scope: >
      Full-screen global search over /admin/search (groups with counts, More on
      desktop rows, Desktop tag on client and staff rows, keep-typing, in
      flight, no match and offline states); MobileHeader's magnifier stops
      opening the palette.
    footprint: []  # declared in its own plan
    depends_on: [ma-e1-events-list]
    review_fleet: [code-review, consistency-check, ui-ux-review]
```

---

### Task 1: Scoped, event-paged admin feed on `GET /shifts` (two commits: 1a the move, 1b the scoped mode)

**Files:**
- Modify: `server/routes/shifts.queries.js` (append the moved projection and the scoped builder; extend the import and the export)
- Modify: `server/routes/shifts.js:103-221` (the admin branch)
- Test: `server/routes/shifts.adminScoped.test.js` (new)

**Interfaces:**
- Consumes: `shiftNotFinishedSql`, `shiftFinishedSql` from `server/utils/shiftEndInstant.js`; `barRequiredSql`, `planQueueSql` already in `shifts.queries.js`.
- Produces: `adminShiftsSelectSql(extraColumns = '')` (string: the SELECT through `) abr ON true`), `adminScopedShiftsSql(scope)` (string with `$1` offset in events, `$2` limit in events, `$3` needs_staff boolean), and the HTTP contract: `GET /api/shifts?scope=upcoming|past&limit=60&offset=0&needs_staff=1` answers `{ scope, offset, limit, total_events, scope_events, needs_staff_events, has_more, next_offset, rows }`. `total_events` counts the events in the current filter; `scope_events` counts the events in the scope regardless of the chip; `needs_staff_events` counts the events with at least one flagged shift (always 0 on `past`). `rows` are the legacy row shape plus `event_key` (text, `p<proposal_id>` or `s<shift_id>`) and `needs_staff` (boolean, per shift). Without `scope` the response is the legacy bare array, byte-identical.

**Bucket law (Global Constraints, restated in SQL terms):** upcoming = `shiftNotFinishedSql('s','p') AND s.status <> 'cancelled' AND COALESCE(p.status, '') <> 'archived'`; past = `(shiftFinishedSql('s','p') OR s.status = 'cancelled' OR COALESCE(p.status, '') = 'archived')`. Every shift is in exactly one. The chip keeps whole events: `event_key IN (SELECT event_key FROM base WHERE needs_staff)`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/shifts.adminScoped.test.js`. Copy the harness pieces verbatim from `server/routes/shifts.visibility.endInstant.test.js` (`:31-105`: dotenv, node:test imports, the production guard, `NONCE`, `get`, `makeUser`, `tokenFor`) and its Express app bootstrap from `before()` at `:204-216` (builds `app`, mounts `/api/shifts`, `/api/admin`, `/api/messages`, adds the `AppError` middleware, listens on an ephemeral port). Then:

```js
const EMAIL_PREFIX = `admin-scoped-${NONCE}-`;
const CLIENT_TAG = `AdminScoped ${NONCE}`;
// Filled in at Step 2 from the CURRENT code, before the move: the exact sorted
// column list the legacy admin array returns. Pinning it is what makes the
// "verbatim" projection move a verified claim instead of a trusted one.
const LEGACY_KEYS = [];
let adminToken, staffToken, staffId, clientId, propA, propB, propC;
const S = {}; // fixture key -> shift id

// proposals.token is UUID NOT NULL DEFAULT gen_random_uuid(): leave it to the default.
async function seedProposal(label, extra = {}) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, $2, $3::date, $4, 'wedding-reception', 1000, 100) RETURNING id`,
    [clientId, extra.status || 'deposit_paid', extra.date, extra.guests || 100]
  );
  return r.rows[0].id;
}
async function seedShift(key, { date, start = '18:00', end = '23:00', positions = '["Bartender"]', proposalId = null, status = 'open' }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id)
     VALUES ($1::date, $2, $3, $4, '1 Test St', $5, $6, $7) RETURNING id`,
    [date, start, end, status, `${CLIENT_TAG} ${key}`, positions, proposalId]
  );
  S[key] = r.rows[0].id;
  return S[key];
}
async function approve(shiftId, userId) {
  await pool.query(`INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`, [shiftId, userId]);
}
const ymdOffset = (days) => {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  // ... app bootstrap copied from the exemplar ...
  adminToken = tokenFor(await makeUser('admin', 'admin'));
  const staff = await makeUser('staff'); staffId = staff.id; staffToken = tokenFor(staff);
  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [CLIENT_TAG, `${EMAIL_PREFIX}client@example.com`]);
  clientId = c.rows[0].id;
  propA = await seedProposal('A', { date: ymdOffset(2) });   // two shifts, both unstaffed
  propB = await seedProposal('B', { date: ymdOffset(9) });   // one shift, fully staffed
  propC = await seedProposal('C', { date: ymdOffset(6) });   // MIXED: one staffed, one open
  await seedShift('a1', { date: ymdOffset(2), positions: '["Bartender","Bartender","Bartender"]', proposalId: propA });
  await seedShift('a2', { date: ymdOffset(2), start: '17:00', end: '22:00', positions: '["Banquet Server"]', proposalId: propA });
  await seedShift('manual', { date: ymdOffset(4) });         // proposal_id NULL
  await seedShift('b1', { date: ymdOffset(9), proposalId: propB });
  await approve(S.b1, staffId);
  await seedShift('c1', { date: ymdOffset(6), proposalId: propC });
  await approve(S.c1, staffId);
  await seedShift('c2', { date: ymdOffset(6), start: '17:00', end: '22:00', proposalId: propC });
  await seedShift('cancelled', { date: ymdOffset(3), status: 'cancelled' });   // future-dated, cancelled
  await seedShift('past', { date: ymdOffset(-3) });
});

after(async () => {
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])`, [Object.values(S)]);
  await pool.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [Object.values(S)]);
  await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [[propA, propB, propC]]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
  server.close();
});

const ALL = () => Object.values(S);
const mine = (rows) => rows.filter(r => ALL().includes(r.id));
const ids = (rows) => mine(rows).map(r => r.id).sort((a, b) => a - b);
const sorted = (xs) => [...xs].sort((a, b) => a - b);

// The badge predicate, restated over the fixtures only. This is the truth the
// chip must match (routes/admin/settings.js unstaffed_events).
async function badgeShiftIds() {
  const { shiftNotFinishedSql } = require('../utils/shiftEndInstant');
  const r = await pool.query(`
    SELECT s.id FROM shifts s LEFT JOIN proposals p ON p.id = s.proposal_id
     WHERE ${shiftNotFinishedSql('s', 'p')} AND s.status = 'open'
       AND s.positions_needed IS JSON ARRAY
       AND jsonb_array_length(s.positions_needed::jsonb) > 0
       AND (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL)
           < jsonb_array_length(s.positions_needed::jsonb)
       AND s.id = ANY($1::int[])`, [ALL()]);
  return sorted(r.rows.map(x => x.id));
}

test('legacy call: bare array, every fixture present, the column set unchanged, no scoped columns', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.deepEqual(ids(r.body), sorted(ALL()));
  const keys = Object.keys(r.body[0]).sort();
  console.log('LEGACY_KEYS', JSON.stringify(keys));   // Step 2 pastes this into LEGACY_KEYS, then this line goes
  if (LEGACY_KEYS.length) assert.deepEqual(keys, LEGACY_KEYS);
  assert.equal('event_key' in r.body[0], false);
});

test('scope=upcoming pages by EVENT: both shifts of proposal A arrive together on page one', async () => {
  const r = await get('/api/shifts?scope=upcoming&limit=1', adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows));
  // The dev DB holds other upcoming events; walk pages until our proposal A page appears.
  let page = r.body, found = null, guard = 0;
  while (page && guard++ < 400) {
    if (mine(page.rows).length) { found = page; break; }
    if (!page.has_more) break;
    page = (await get(`/api/shifts?scope=upcoming&limit=1&offset=${page.next_offset}`, adminToken)).body;
  }
  assert.ok(found, 'proposal A never paged in');
  assert.deepEqual(ids(found.rows), sorted([S.a1, S.a2]));
  assert.equal(found.rows.every(x => x.event_key === `p${propA}`), true);
  assert.equal(found.limit, 1);
});

test('one bucket per shift: upcoming = live and unfinished; past = finished OR cancelled OR archived, newest first', async () => {
  const up = (await get('/api/shifts?scope=upcoming&limit=200', adminToken)).body;
  assert.deepEqual(ids(up.rows), sorted([S.a1, S.a2, S.manual, S.b1, S.c1, S.c2]));
  const past = (await get('/api/shifts?scope=past&limit=200', adminToken)).body;
  assert.deepEqual(ids(past.rows), sorted([S.past, S.cancelled]), 'a future-dated cancelled shift lives on Past');
  assert.equal(past.needs_staff_events, 0);
  const dates = past.rows.map(r => String(r.event_date).slice(0, 10));
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i], 'past not descending');
});

test('needs_staff: the per-shift flag is the badge predicate; the chip keeps whole events', async () => {
  const badge = await badgeShiftIds();
  assert.deepEqual(badge, sorted([S.a1, S.a2, S.manual, S.c2]), 'fixture premise: c1 is staffed, c2 is open');
  const all = (await get('/api/shifts?scope=upcoming&limit=200', adminToken)).body;
  // Flag truth, row by row.
  assert.deepEqual(sorted(mine(all.rows).filter(x => x.needs_staff).map(x => x.id)), badge);
  // Chip rows: every shift of any event that has a flagged shift. Proposal C stays whole.
  const chip = (await get('/api/shifts?scope=upcoming&needs_staff=1&limit=200', adminToken)).body;
  assert.deepEqual(ids(chip.rows), sorted([S.a1, S.a2, S.manual, S.c1, S.c2]));
  assert.equal(mine(chip.rows).find(x => x.id === S.c1).needs_staff, false, 'the staffed shift rides along with its event, unflagged');
  // Event sets agree between chip and badge.
  const keyOf = (id) => all.rows.find(x => x.id === id).event_key;
  assert.deepEqual([...new Set(mine(chip.rows).map(x => x.event_key))].sort(), [...new Set(badge.map(keyOf))].sort());
  // Counts: needs_staff_events counts EVENTS over the whole scope; scope_events ignores the chip.
  const distinctNeedy = new Set(all.rows.filter(x => x.needs_staff).map(x => x.event_key)).size;
  assert.equal(all.needs_staff_events, distinctNeedy);
  assert.equal(chip.needs_staff_events, distinctNeedy);
  assert.equal(chip.scope_events, all.total_events);
  assert.ok(chip.total_events <= chip.scope_events);
});

test('limit and offset clamp; totals and has_more are consistent', async () => {
  const r = (await get('/api/shifts?scope=upcoming&limit=999&offset=-5', adminToken)).body;
  assert.equal(r.limit, 200);
  assert.equal(r.offset, 0);
  assert.equal(r.has_more, r.offset + r.limit < r.total_events);
  assert.equal(r.next_offset, r.offset + r.limit);
  assert.ok(new Set(r.rows.map(x => x.event_key)).size <= r.limit);
});

test('a staff token ignores scope and gets the staff array', async () => {
  const r = await get('/api/shifts?scope=upcoming', staffToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});
```

- [ ] **Step 2: Run the test against the unmodified code and pin the legacy column set**

Run: `node --test server/routes/shifts.adminScoped.test.js`
Expected: the legacy test passes and prints `LEGACY_KEYS [...]`; every scoped test FAILS (`r.body.rows` undefined). Paste the printed sorted list into `LEGACY_KEYS`, delete the `console.log` line, re-run: the legacy test still passes, now with the column pin live.

- [ ] **Step 3a: Move the projection into `shifts.queries.js` (behavior-inert)**

In `server/routes/shifts.queries.js`: change line 10 to `const { shiftNotFinishedSql, shiftFinishedSql } = require('../utils/shiftEndInstant');`. Append before `module.exports`:

```js
// ── Admin branch of GET /shifts ────────────────────────────────────────────
// One row per shift with the proposal, client, request counts and roster
// aggregates that the Events dashboard, the Overview page and the phone Events
// list read. Moved here from shifts.js (2026-09-18) so the scoped, event-paged
// variant below reuses the projection verbatim: two hand-maintained copies is
// how a column goes missing on one screen and not the other.
//
// `extraColumns` is spliced right after `SELECT s.*,` so the scoped builder
// can add its window keys without touching the legacy text.
function adminShiftsSelectSql(extraColumns = '') {
  return `
    SELECT s.*,${extraColumns}
      <PASTE shifts.js lines 109 through 217 here VERBATIM: from "u.email AS created_by_email," through ") abr ON true">
  `;
}
```

Extend the export: `module.exports = { STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL, barRequiredSql, planQueueSql, adminShiftsSelectSql };`

In `server/routes/shifts.js`: extend the `:26` import to include `adminShiftsSelectSql`, and replace `:107-221` (from `const result = await pool.query(\`` through `return res.json(result.rows);`) with:

```js
    // Legacy shape, frozen: the desktop dashboard, the Overview page and the
    // staff pages read this bare array with no params.
    const result = await pool.query(`${adminShiftsSelectSql()}
      ORDER BY s.event_date ASC
      LIMIT 500
    `);
    return res.json(result.rows);
```

`shifts.js` must end SHORTER than 786 lines (about 680 after this step).

- [ ] **Step 4a: Verify the move changed nothing, then commit it**

Run: `node --test server/routes/shifts.adminScoped.test.js` (legacy test green with the column pin; scoped tests still red), then `node --test server/routes/shifts.planQueue.test.js` (green, same pass count as on `main`).

```bash
git add server/routes/shifts.js server/routes/shifts.queries.js server/routes/shifts.adminScoped.test.js && git commit -F - -- server/routes/shifts.js server/routes/shifts.queries.js server/routes/shifts.adminScoped.test.js <<'MSG'
refactor(shifts): move the admin list projection into shifts.queries.js

Verbatim move so the phone Events feed can share one SELECT with the
desktop dump. The legacy response is pinned column for column by the
new suite; no behavior changes in this commit.
MSG
```

- [ ] **Step 3b: Add the scoped builder and the route branch**

Append to `shifts.queries.js` after `adminShiftsSelectSql`:

```js
// The phone Events list (spec 2026-08-13-mobile-admin section 4, amended
// 2026-09-15 and 2026-09-18). Pages by EVENT (proposal, or the shift itself
// when manual) so a two-shift wedding never splits across pages. $1 offset in
// events, $2 limit in events, $3 needs_staff boolean.
//
// `needs_staff` is the unstaffed_events badge predicate from
// routes/admin/settings.js, restated over this projection's rc.approved_count
// (the same approved-and-not-dropped count). Change one, change both, in the
// same commit; shifts.adminScoped.test.js pins the two to the same rows. The
// chip keeps whole events: a flagged shift pulls its siblings along.
//
// Bucket law: every shift is in exactly one scope. Upcoming = not finished
// (the end instant, never a calendar day) and live. Past = finished, or
// cancelled, or archived, whatever the date, which is where the muted
// Cancelled card lives.
const NEEDS_STAFF_SQL = `(s.status = 'open'
      AND s.positions_needed IS JSON ARRAY
      AND jsonb_array_length(s.positions_needed::jsonb) > 0
      AND rc.approved_count < jsonb_array_length(s.positions_needed::jsonb))`;

function adminScopedShiftsSql(scope) {
  const upcoming = scope === 'upcoming';
  const scopeWhere = upcoming
    ? `${shiftNotFinishedSql('s', 'p')} AND s.status <> 'cancelled' AND COALESCE(p.status, '') <> 'archived'`
    : `(${shiftFinishedSql('s', 'p')} OR s.status = 'cancelled' OR COALESCE(p.status, '') = 'archived')`;
  const rankOrder = upcoming ? 'event_date ASC, event_key ASC' : 'event_date DESC, event_key DESC';
  const extra = `
        COALESCE('p' || s.proposal_id::text, 's' || s.id::text) AS event_key,
        ${NEEDS_STAFF_SQL} AS needs_staff,`;
  return `
    WITH base AS (
      ${adminShiftsSelectSql(extra)}
      WHERE ${scopeWhere}
    ), scoped AS (
      SELECT * FROM base
       WHERE $3::boolean IS NOT TRUE
          OR event_key IN (SELECT event_key FROM base WHERE needs_staff)
    ), ranked AS (
      SELECT scoped.*, DENSE_RANK() OVER (ORDER BY ${rankOrder}) AS event_rank FROM scoped
    )
    SELECT ranked.*,
           (SELECT MAX(event_rank) FROM ranked) AS total_events,
           (SELECT COUNT(DISTINCT event_key) FROM base) AS scope_events,
           (SELECT COUNT(DISTINCT event_key) FROM base WHERE needs_staff) AS needs_staff_events
      FROM ranked
     WHERE event_rank > $1 AND event_rank <= $1 + $2
     ORDER BY event_rank ASC, start_time ASC NULLS LAST, id ASC
  `;
}
```

Add `adminScopedShiftsSql` to the export. Then in `server/routes/shifts.js`, extend the import again and replace the Step 3a block with:

```js
    const scope = req.query.scope;
    if (scope !== 'upcoming' && scope !== 'past') {
      // Legacy shape, frozen: the desktop dashboard, the Overview page and the
      // staff pages read this bare array with no params.
      const result = await pool.query(`${adminShiftsSelectSql()}
      ORDER BY s.event_date ASC
      LIMIT 500
    `);
      return res.json(result.rows);
    }
    // Phone Events list: scoped, paged by event, with totals. See
    // adminScopedShiftsSql for the predicate and bucket law.
    const limit = clampInt(req.query.limit, 1, 200, 60);
    const offset = clampInt(req.query.offset, 0, 1000000, 0);
    const needsStaff = scope === 'upcoming' && req.query.needs_staff === '1';
    const result = await pool.query(adminScopedShiftsSql(scope), [offset, limit, needsStaff]);
    const first = result.rows[0];
    const totalEvents = first ? Number(first.total_events) : 0;
    const scopeEvents = first ? Number(first.scope_events) : 0;
    const needsStaffEvents = first && scope === 'upcoming' ? Number(first.needs_staff_events) : 0;
    const rows = result.rows.map(({ event_rank, total_events, scope_events, needs_staff_events, ...row }) => row);
    return res.json({
      scope, offset, limit,
      total_events: totalEvents,
      scope_events: scopeEvents,
      needs_staff_events: needsStaffEvents,
      has_more: offset + limit < totalEvents,
      next_offset: offset + limit,
      rows,
    });
```

Add near the top of `shifts.js` (after the requires):

```js
// Query-string integers for the scoped admin feed: NaN falls to the default,
// out-of-range clamps. Never trusts the raw string.
function clampInt(raw, min, max, dflt) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
```

Known limits, stated: an empty page (an offset past the end) carries no totals, so the route answers zeros with `has_more: false`; the client only requests offsets the previous envelope named. `total_events`, `scope_events` and `event_rank` arrive from pg as strings (bigint); the `Number()` calls above are load-bearing.

- [ ] **Step 4b: Run the test to verify it passes, in both timezones**

Run: `node --test server/routes/shifts.adminScoped.test.js` then `TZ=UTC node --test server/routes/shifts.adminScoped.test.js`
Expected: all 6 tests PASS in both runs (read the pass count; a missing dotenv line shows as ECONNREFUSED, not as a failure).

- [ ] **Step 5: Run the suites this change reaches, one at a time**

From the repo root, each `server/routes/shifts*.test.js` file in turn (`ls server/routes/shifts*.test.js` lists them; run `shifts.visibility.endInstant.test.js` in both TZs), then `server/routes/eventDetails.test.js` and `server/routes/admin/settings.badgeCounts.test.js`.
Expected: every suite green with the same pass counts as on `main` before this task. `shifts.js` ends at about 707 lines (shorter than 786; still over the 700 soft cap, which warns and does not block).

- [ ] **Step 6: Commit the scoped mode**

```bash
git add server/routes/shifts.js server/routes/shifts.queries.js server/routes/shifts.adminScoped.test.js && git commit -F - -- server/routes/shifts.js server/routes/shifts.queries.js server/routes/shifts.adminScoped.test.js <<'MSG'
feat(shifts): scoped, event-paged admin feed for the phone Events list

GET /shifts?scope=upcoming|past pages by event with limit and offset,
filters needs_staff on the unstaffed_events badge predicate at the event
level, and answers an envelope with totals. The legacy call with no
scope keeps its bare array.
MSG
```

- [ ] **Step 7: Checkpoint review before any client task builds on the envelope**

Dispatch `consistency-check` on the Task 1 diff (the chip predicate versus `routes/admin/settings.js` and `/unstaffed-upcoming`; the envelope field names versus Task 4's reads) and a narrow `database-review` on the query shape only (the DENSE_RANK window plus the three scalar subqueries over `ranked` and `base` per page; no schema changes). Fold findings before Task 2.

---

### Task 2: Pure grouping: shift rows into event cards

**Files:**
- Create: `client/src/utils/eventCards.js`
- Test: `client/src/utils/eventCards.test.js`

**Interfaces:**
- Consumes: `parsePositionsCount`, `approvedCount`, `isCancelledEvent` from `components/adminos/shifts.js`; `fmtTimeRange24`, `dayDiff` from `components/adminos/format.js`; `getEventTypeLabel` from `utils/eventTypes.js`.
- Produces: `groupShiftRows(rows, { todayYmd })` returning `Card[]` in feed order, `railParts(ymd)` returning `{ dow, day, mon }`, and the `Card` shape below, which `EventsListPhone` renders and lane ma-e2 reuses for the detail header.

```js
// Card = {
//   key: 'p123' | 's45', manual: boolean, proposalId: number|null,
//   id: number,                  // proposal id, or the shift id when manual
//   shiftIds: number[], shiftCount: number,
//   clientName: string, kind: string,
//   ymd: 'YYYY-MM-DD'|null, isToday: boolean,
//   timeRange: string,           // "19:00–23:00 · 4h" or "" when no start
//   venue: string, place: string, guests: number|null,
//   slots: number, filled: number, open: number, pending: number, full: boolean,
//   cancelled: boolean, barRental: boolean, supplies: boolean,
//   tapTarget: { kind: 'event', id } | { kind: 'shift', id },
// }
```

- [ ] **Step 1: Write the failing tests**

```js
import { groupShiftRows, railParts } from './eventCards';

const row = (over = {}) => ({
  id: 1, proposal_id: 10, event_key: 'p10', client_name: 'Henderson', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-08-15', start_time: '18:00', end_time: '23:00', location: 'Grove on the River',
  proposal_guest_count: 140, positions_needed: '["Bartender","Bartender","Bartender"]',
  approved_count: 2, pending_count: 2, status: 'open', proposal_status: 'deposit_paid',
  bar_required: true, supply_run_required: true, ...over,
});

test('two rows with one proposal become one card with slots, filled and pending summed', () => {
  const cards = groupShiftRows([
    row(),
    row({ id: 2, positions_needed: '["Banquet Server"]', approved_count: 1, pending_count: 0, start_time: '17:00', end_time: '22:00', bar_required: false, supply_run_required: false }),
  ], { todayYmd: '2026-08-14' });
  expect(cards).toHaveLength(1);
  const c = cards[0];
  expect(c).toMatchObject({ key: 'p10', manual: false, id: 10, shiftCount: 2, slots: 4, filled: 3, open: 1, pending: 2, full: false, cancelled: false, barRental: true, supplies: true, isToday: false });
  expect(c.shiftIds).toEqual([1, 2]);
  expect(c.clientName).toBe('Henderson');
  expect(c.kind).toBe('Wedding Reception');
  expect(c.timeRange).toBe('18:00–23:00 · 5h');   // first shift's range
  expect(c.venue).toBe('Grove on the River');
  expect(c.guests).toBe(140);
  expect(c.tapTarget).toEqual({ kind: 'event', id: 10 });
});

test('a manual shift is its own card and taps into the shift', () => {
  const [c] = groupShiftRows([row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null, proposal_guest_count: null, proposal_status: null })]);
  expect(c).toMatchObject({ key: 's7', manual: true, id: 7, kind: 'Manual shift', guests: null, tapTarget: { kind: 'shift', id: 7 } });
});

test('rows without event_key still group by proposal_id, or by shift id when manual', () => {
  const cards = groupShiftRows([row({ event_key: undefined }), row({ id: 2, event_key: undefined }), row({ id: 3, event_key: undefined, proposal_id: null })]);
  expect(cards.map(c => c.key)).toEqual(['p10', 's3']);
});

test('cancelled: every shift cancelled or the proposal archived, and open/pending zero out', () => {
  const [c] = groupShiftRows([row({ status: 'cancelled', approved_count: 1 })]);
  expect(c).toMatchObject({ cancelled: true, open: 0, pending: 0, filled: 1 });
  const [d] = groupShiftRows([row({ proposal_status: 'archived' })]);
  expect(d.cancelled).toBe(true);
});

test('an empty roster counts as one slot (neededCount law) and full is filled >= slots', () => {
  const [c] = groupShiftRows([row({ positions_needed: '[]', approved_count: 1, pending_count: 0 })]);
  expect(c).toMatchObject({ slots: 1, filled: 1, open: 0, full: true });
});

test('isToday follows the caller clock and railParts formats the rail', () => {
  const [c] = groupShiftRows([row()], { todayYmd: '2026-08-15' });
  expect(c.isToday).toBe(true);
  expect(railParts('2026-08-14')).toEqual({ dow: 'FRI', day: '14', mon: 'AUG' });
  expect(railParts('2026-09-05')).toEqual({ dow: 'SAT', day: '05', mon: 'SEP' });
});

test('filled never exceeds slots and feed order is preserved', () => {
  const cards = groupShiftRows([row({ id: 9, proposal_id: 99, event_key: 'p99', approved_count: 5 }), row()]);
  expect(cards.map(c => c.key)).toEqual(['p99', 'p10']);
  expect(cards[0].filled).toBe(3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/eventCards.test.js`
Expected: FAIL, `Cannot find module './eventCards'`.

- [ ] **Step 3: Write the module**

```js
// Groups the admin GET /shifts rows (one per shift) into one card per event
// for the phone Events list (spec 2026-08-13-mobile-admin section 4, benchmark
// 2026-09-15). Pure: no React, no fetch, no clock unless the caller passes
// one. Lane ma-e2 reuses the Card shape for the detail header.
import { parsePositionsCount, approvedCount, isCancelledEvent } from '../components/adminos/shifts';
import { fmtTimeRange24, dayDiff } from '../components/adminos/format';
import { getEventTypeLabel } from './eventTypes';

export function eventKeyOf(row) {
  if (row.event_key) return row.event_key;
  return row.proposal_id == null ? `s${row.id}` : `p${row.proposal_id}`;
}

// Date rail parts from a YYYY-MM-DD, noon-anchored so no timezone can roll the
// day (same trick as format.js fmtDate).
export function railParts(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return { dow: '', day: '', mon: '' };
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day: String(d.getDate()).padStart(2, '0'),
    mon: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  };
}

function finishCard(card, todayYmd) {
  const first = card.shifts[0];
  const slots = card.shifts.reduce((a, s) => a + parsePositionsCount(s), 0);
  const filled = Math.min(slots, card.shifts.reduce((a, s) => a + approvedCount(s), 0));
  const pending = card.shifts.reduce((a, s) => a + Number(s.pending_count || 0), 0);
  const cancelled = card.shifts.every(isCancelledEvent);
  const ymd = first.event_date ? String(first.event_date).slice(0, 10) : null;
  const hasType = !!(first.event_type || first.event_type_custom);
  return {
    ...card,
    id: card.manual ? first.id : card.proposalId,
    shiftCount: card.shifts.length,
    clientName: first.client_name || (card.manual ? 'Manual shift' : 'Client'),
    kind: hasType ? getEventTypeLabel(first) : (card.manual ? 'Manual shift' : 'event'),
    ymd,
    isToday: !!ymd && dayDiff(ymd, todayYmd) === 0,
    timeRange: first.start_time ? fmtTimeRange24(first.start_time, first.end_time) : '',
    venue: first.location || '',
    guests: first.proposal_guest_count ?? first.guest_count ?? null,
    slots,
    filled,
    open: cancelled ? 0 : Math.max(0, slots - filled),
    pending: cancelled ? 0 : pending,
    full: filled >= slots,
    cancelled,
    barRental: card.shifts.some(s => !!s.bar_required),
    supplies: card.shifts.some(s => !!s.supply_run_required),
    tapTarget: card.manual ? { kind: 'shift', id: first.id } : { kind: 'event', id: card.proposalId },
  };
}

export function groupShiftRows(rows, { todayYmd } = {}) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = eventKeyOf(row);
    let card = byKey.get(key);
    if (!card) {
      card = { key, manual: row.proposal_id == null, proposalId: row.proposal_id ?? null, shiftIds: [], shifts: [] };
      byKey.set(key, card);
    }
    card.shiftIds.push(row.id);
    card.shifts.push(row);
  }
  return Array.from(byKey.values()).map(card => finishCard(card, todayYmd));
}
```

Note on `getEventTypeLabel`: it returns the type's label from `data/eventTypes.js`; `wedding-reception` renders "Wedding Reception" and an unknown id falls back to "event". Fix a TEST to the table's label, never the table.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/eventCards.test.js`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/eventCards.js client/src/utils/eventCards.test.js && git commit -F - -- client/src/utils/eventCards.js client/src/utils/eventCards.test.js <<'MSG'
feat(mobile): group shift rows into event cards for the phone list

Pure module: one card per event (manual shifts stand alone), slots and
fills summed across shifts, cancelled derived, date rail parts.
MSG
```

---

### Task 3: The `.m-card` family and list-state CSS

**Files:**
- Modify: `client/src/index.css` (insert into the mobile block, right before the `Staff hub chrome` comment at `:21237`)

**Interfaces:**
- Produces the class vocabulary `EventsListPhone` (and later the proposals list) renders, and nothing else: `.m-events`, `.m-listbar`, `.m-chip-toggle(.on)` with `.m-chip-count`, `.m-stale-dot` (the `.m-stale` and `.m-stale-time` rules already exist), `.m-card(.m-card-cancelled, .m-card-more, .m-card-skel)`, `.m-rail(.m-rail-dow, .m-rail-day, .m-rail-mon, .today)`, `.m-card-body`, `.m-card-head`, `.m-card-title`, `.m-card-kind`, `.m-card-guests`, `.m-card-meta`, `.m-card-foot`, `.m-frac(.full, .past)`, `.m-shiftnote`, `.m-tags`, `.m-tag(.bar, .supplies)` (the Manual tag is a plain `.m-tag`, as the benchmark renders it), `.m-showmore`, `.m-shownof`, `.m-end`, `.m-empty(.ok, .m-empty-title, .m-empty-body)`, `.m-skel-note`, `.m-skel-rail`, `.m-skel-bar(.thin)`, plus the two type tokens `--fs-body` and `--fs-meta`. Task 4 Step 4b greps the component's classNames against this block so the list above and the CSS cannot drift.

- [ ] **Step 1: Add the rules**

Insert this block before `/* ====...Staff hub chrome` (values come from `components-mobile.css` for the card and from the benchmark's inline styles for everything else; tokens only, no hex except the benchmark's `#fff` on the accent):

```css
/* ---- Mobile admin: Events list (spec 2026-08-13 section 4, benchmark
   docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Events tab).
   Card rules folded from the design system's components-mobile.css; the
   date rail, fraction, tags and list states promote the benchmark's inline
   treatment to classes. Lists are date-ordered cards, never tables. ---- */
/* Type tokens the design system defines (tokens/typography.css) and index.css
   never did; the mobile block is their first consumer. */
html[data-app="admin-os"] { --fs-body: 13px; --fs-meta: 11.5px; }
html[data-app="admin-os"] .m-listbar {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px;
  margin: -0.75rem -0.75rem 0.5rem; padding: 10px 12px 6px;
  background: var(--bg-0);
}
html[data-app="admin-os"] .m-listbar .m-seg { flex: none; }
html[data-app="admin-os"] .m-listbar .m-seg-btn { flex: none; padding: 0 14px; }
html[data-app="admin-os"] .m-chip-toggle {
  display: inline-flex; align-items: center; gap: 7px;
  min-height: 44px; padding: 0 16px; border-radius: 999px;
  border: 1px solid var(--line-2); background: var(--bg-2); color: var(--ink-2);
  font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer;
}
html[data-app="admin-os"] .m-chip-toggle .m-chip-count { font-family: var(--font-numeric); font-size: 11px; opacity: 0.9; }
html[data-app="admin-os"] .m-chip-toggle.on {
  background: var(--accent-soft); border-color: var(--accent);
  color: hsl(var(--accent-h) var(--accent-s) 62%);
}
html[data-app="admin-os"] .m-stale { display: flex; align-items: center; gap: 6px; }
html[data-app="admin-os"] .m-stale-dot {
  width: 6px; height: 6px; flex: none; border-radius: 50%;
  background: hsl(var(--warn-h) var(--warn-s) 52%);
}

/* Card: one large tap target. */
html[data-app="admin-os"] .m-card {
  display: flex; flex-direction: row; align-items: stretch; gap: 12px;
  width: 100%; padding: 10px 14px 10px 10px; margin: 0 0 0.5rem;
  background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card); color: var(--ink-1); font-family: var(--font-ui);
  text-align: left; cursor: pointer;
}
html[data-app="admin-os"] .m-card:active { background: var(--row-hover); }
html[data-app="admin-os"] .m-rail {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  width: 46px; flex: none; border-right: 1px solid var(--line-1); padding-right: 10px;
}
html[data-app="admin-os"] .m-rail-dow { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.12em; color: var(--ink-3); }
html[data-app="admin-os"] .m-rail-day { font-family: var(--font-numeric); font-size: 20px; font-weight: 600; line-height: 1.1; color: var(--ink-1); }
html[data-app="admin-os"] .m-rail-mon { font-family: var(--font-mono); font-size: 8px; letter-spacing: 0.14em; color: var(--ink-4); }
html[data-app="admin-os"] .m-rail.today .m-rail-day,
html[data-app="admin-os"] .m-rail.today .m-rail-mon { color: var(--accent); }
html[data-app="admin-os"] .m-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; justify-content: center; }
html[data-app="admin-os"] .m-card-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
html[data-app="admin-os"] .m-card-title {
  flex: 1; min-width: 0; font-size: var(--fs-body); font-weight: 600; color: var(--ink-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
html[data-app="admin-os"] .m-card-kind { color: var(--ink-3); font-weight: 400; }
html[data-app="admin-os"] .m-card-guests { flex: none; font-family: var(--font-numeric); font-size: 11.5px; color: var(--ink-3); }
html[data-app="admin-os"] .m-card-guests small { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.1em; color: var(--ink-4); }
html[data-app="admin-os"] .m-card-meta { font-size: var(--fs-meta); font-family: var(--font-numeric); color: var(--ink-3); }
html[data-app="admin-os"] .m-card-foot { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
html[data-app="admin-os"] .m-frac { font-family: var(--font-numeric); font-size: 12.5px; font-weight: 700; color: hsl(var(--danger-h) var(--danger-s) 70%); }
html[data-app="admin-os"] .m-frac.full { font-weight: 600; color: hsl(var(--ok-h) var(--ok-s) 52%); }
html[data-app="admin-os"] .m-frac.past { font-weight: 400; color: var(--ink-3); }
html[data-app="admin-os"] .m-shiftnote { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-tags { margin-left: auto; display: inline-flex; gap: 4px; }
html[data-app="admin-os"] .m-tag {
  display: inline-flex; align-items: center; padding: 2px 7px; border-radius: var(--radius-sm);
  border: 1px solid var(--line-2); background: var(--bg-3); color: var(--ink-2);
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap;
}
html[data-app="admin-os"] .m-tag.bar { background: hsl(var(--info-h) var(--info-s) 52% / 0.14); border-color: hsl(var(--info-h) var(--info-s) 52% / 0.35); color: hsl(var(--info-h) var(--info-s) 66%); }
html[data-app="admin-os"] .m-tag.supplies { background: hsl(var(--ok-h) var(--ok-s) 50% / 0.14); border-color: hsl(var(--ok-h) var(--ok-s) 50% / 0.35); color: hsl(var(--ok-h) var(--ok-s) 58%); }
html[data-app="admin-os"] .m-card-cancelled .m-rail-dow,
html[data-app="admin-os"] .m-card-cancelled .m-rail-day { color: var(--ink-4); }
html[data-app="admin-os"] .m-card-cancelled .m-card-title { color: var(--ink-3); }

/* Show more, end divider, empty and skeleton states. */
html[data-app="admin-os"] .m-card-more { align-items: center; justify-content: center; gap: 8px; min-height: 48px; background: var(--bg-1); }
html[data-app="admin-os"] .m-card-more .m-showmore { font-size: var(--fs-body); font-weight: 600; color: hsl(var(--accent-h) var(--accent-s) 62%); }
html[data-app="admin-os"] .m-card-more .m-shownof { font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); }
html[data-app="admin-os"] .m-end { display: flex; align-items: center; gap: 10px; padding: 12px 8px 6px; }
html[data-app="admin-os"] .m-end::before, html[data-app="admin-os"] .m-end::after { content: ""; flex: 1; height: 1px; background: var(--line-2); }
html[data-app="admin-os"] .m-end span { flex: none; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 70px 24px 40px; text-align: center; color: var(--ink-4); }
html[data-app="admin-os"] .m-empty.ok { color: hsl(var(--ok-h) var(--ok-s) 52%); }
html[data-app="admin-os"] .m-empty-title { font-size: var(--fs-body); font-weight: 600; color: var(--ink-2); }
html[data-app="admin-os"] .m-empty-body { font-size: var(--fs-meta); color: var(--ink-3); max-width: 230px; line-height: 1.55; }
html[data-app="admin-os"] .m-skel-note { text-align: center; padding: 4px 0 12px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-card-skel { pointer-events: none; padding: 12px 14px 12px 10px; }
html[data-app="admin-os"] .m-skel-rail { width: 46px; height: 42px; flex: none; border-radius: var(--radius-sm); background: var(--bg-3); animation: m-pulse 1.4s ease-in-out infinite; }
html[data-app="admin-os"] .m-skel-bar { height: 11px; border-radius: 3px; background: var(--bg-3); animation: m-pulse 1.4s ease-in-out infinite; }
html[data-app="admin-os"] .m-skel-bar.thin { height: 9px; }
@keyframes m-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

/* House Lights: squared, editorial, and the light-skin semantic hues. */
html[data-app="admin-os"][data-skin="light"] .m-card { border-radius: 0; box-shadow: none; border-color: var(--line-2); }
html[data-app="admin-os"][data-skin="light"] .m-chip-toggle { border-radius: 0; }
html[data-app="admin-os"][data-skin="light"] .m-chip-toggle.on { color: var(--accent-ink); }
html[data-app="admin-os"][data-skin="light"] .m-frac { color: var(--ms-bordeaux); }
html[data-app="admin-os"][data-skin="light"] .m-frac.full { color: var(--ms-emerald); }
html[data-app="admin-os"][data-skin="light"] .m-frac.past { color: var(--ink-3); }
html[data-app="admin-os"][data-skin="light"] .m-tag.bar { background: hsl(var(--info-h) var(--info-s) 36% / 0.08); border-color: hsl(var(--info-h) var(--info-s) 36% / 0.4); color: var(--ms-navy); }
html[data-app="admin-os"][data-skin="light"] .m-tag.supplies { background: hsl(var(--ok-h) var(--ok-s) 30% / 0.08); border-color: hsl(var(--ok-h) var(--ok-s) 30% / 0.4); color: var(--ms-emerald); }
html[data-app="admin-os"][data-skin="light"] .m-card-more .m-showmore { color: var(--accent); }
html[data-app="admin-os"][data-skin="light"] .m-empty.ok { color: var(--ms-emerald); }
```

Every custom property in the block was verified present in `index.css` on 2026-09-18 except `--fs-body` and `--fs-meta`, which the block now defines from the design system's typography tokens. If a later token rename lands before this lane merges, re-run the grep (`grep -c -- '--ms-navy' client/src/index.css` and so on) and take any missing value from `docs/design-artifacts/_ds/.../tokens/*.css`, never a bare hex.

- [ ] **Step 2: Build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds (CSS is not linted, but the build parses it).

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css && git commit -F - -- client/src/index.css <<'MSG'
style(mobile): card family and list states for the phone Events list

Folds the design system's .m-card rules into the mobile block and
promotes the 2026-09-15 benchmark's date rail, fraction, tags, sticky
apparatus row, Show more, end divider, empty and skeleton states to
classes. Both skins.
MSG
```

---

### Task 4: `EventsListPhone`

**Files:**
- Modify: `client/src/utils/staleTime.js` (add the time-only formatter)
- Test: `client/src/utils/staleTime.test.js` (extend)
- Create: `client/src/pages/mobile/EventsListPhone.js`
- Test: `client/src/pages/mobile/EventsListPhone.test.js`

**Interfaces:**
- Consumes: `groupShiftRows`, `railParts` (Task 2); `formatStaleTime` (this task); `useUrlListState`; `useDrawerParam`; `ShiftDrawer` (`components/adminos/drawers/ShiftDrawer`); `StatusChip`; `Icon`; the Task 1 envelope; the Task 3 classes.
- Produces: `formatStaleTime(iso, now) -> "2:14 PM" | "Aug 13, 2:14 PM" | null` beside `formatStaleAt`; default export `EventsListPhone()` rendering the whole list body (the chrome supplies header and tab bar). URL state: `?scope=past` (default upcoming, omitted from the URL), `?needs=1`. Persists scroll in `sessionStorage` under `m-events-scroll:<scope>:<needs>` for the life of one launch (a cold launch of the installed app lands at the top by design).

- [ ] **Step 1: Write the failing tests**

Append to `client/src/utils/staleTime.test.js`:

```js
import { formatStaleTime } from './staleTime';

test('formatStaleTime returns the time alone, with the day when it is not today', () => {
  const now = new Date('2026-08-13T20:00:00');
  expect(formatStaleTime('2026-08-13T14:14:00', now)).toBe('2:14 PM');
  expect(formatStaleTime('2026-08-12T14:14:00', now)).toBe('Aug 12, 2:14 PM');
  expect(formatStaleTime(null, now)).toBeNull();
  expect(formatStaleTime('garbage', now)).toBeNull();
});
```

Create `client/src/pages/mobile/EventsListPhone.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import EventsListPhone from './EventsListPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }) }));
// The interim drawer is the desktop one; stub it so this test stays about the list.
jest.mock('../../components/adminos/drawers/ShiftDrawer', () => ({ __esModule: true, default: ({ open, shiftId }) => (open ? <div data-testid="shift-drawer">drawer {shiftId}</div> : null) }));

const row = (over = {}) => ({
  id: 1, proposal_id: 10, event_key: 'p10', client_name: 'Henderson', event_type: 'wedding-reception',
  event_date: '2999-08-15', start_time: '18:00', end_time: '23:00', location: 'Grove on the River',
  proposal_guest_count: 140, positions_needed: '["Bartender","Bartender","Bartender"]',
  approved_count: 2, pending_count: 2, status: 'open', proposal_status: 'deposit_paid',
  bar_required: true, supply_run_required: true, ...over,
});
const env = (rows, over = {}) => ({
  data: { scope: 'upcoming', offset: 0, limit: 60, total_events: rows.length, scope_events: rows.length, needs_staff_events: 1, has_more: false, next_offset: 60, rows, ...over },
});

function LocationProbe() { const l = useLocation(); return <div data-testid="loc">{l.pathname + l.search}</div>; }
function mount(initial = '/events') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/events" element={<><EventsListPhone /><LocationProbe /></>} />
        <Route path="/events/:id" element={<div data-testid="detail">detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); window.sessionStorage.clear(); });

test('fetches scope=upcoming by default and renders one card per event with the benchmark facts', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 2, positions_needed: '["Banquet Server"]', approved_count: 1, pending_count: 0 })]));
  mount();
  expect(await screen.findByText('Henderson')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 } });
  const card = screen.getByRole('button', { name: /Henderson/ });
  expect(within(card).getByText('3/4')).toHaveClass('m-frac');
  expect(within(card).getByText('2 requests')).toBeInTheDocument();
  expect(within(card).getByText('2 shifts')).toBeInTheDocument();
  expect(within(card).getByText('Bar')).toHaveClass('m-tag', 'bar');
  expect(within(card).getByText('Supplies')).toHaveClass('m-tag', 'supplies');
  expect(screen.getByText(/End of upcoming/)).toBeInTheDocument();
});

test('the Needs staff chip writes ?needs=1, refetches with needs_staff=1, hides the end divider; Past hides the chip and drops needs', async () => {
  api.get.mockResolvedValue(env([row()], { needs_staff_events: 1 }));
  mount();
  await screen.findByText('Henderson');
  expect(screen.getByRole('button', { name: /Needs staff/ })).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0, needs_staff: 1 } }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?needs=1');
  await screen.findByText('Henderson');
  expect(screen.queryByText(/End of upcoming/)).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Past' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'past', limit: 60, offset: 0 } }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?scope=past');
  expect(screen.queryByRole('button', { name: /Needs staff/ })).toBeNull();
});

test('Show more appends the next page and the end divider counts events', async () => {
  api.get
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 0, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: true, next_offset: 1, rows: [row()] } })
    .mockResolvedValueOnce({ data: { scope: 'upcoming', offset: 1, limit: 1, total_events: 2, scope_events: 2, needs_staff_events: 0, has_more: false, next_offset: 2, rows: [row({ id: 3, proposal_id: 11, event_key: 'p11', client_name: 'Okafor' })] } });
  mount();
  await screen.findByText('Henderson');
  const more = screen.getByRole('button', { name: /Show more/ });
  expect(more).toHaveTextContent('1 of 2');
  fireEvent.click(more);
  expect(await screen.findByText('Okafor')).toBeInTheDocument();
  expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 1 } });
  expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  expect(screen.getByText('End of upcoming · 2 events')).toBeInTheDocument();
});

test('a live response renders "as of <fetch time>" with no dot', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  await screen.findByText('Henderson');
  const stale = screen.getByText(/^as of/).closest('.m-stale');
  expect(stale.querySelector('.m-stale-dot')).toBeNull();
  expect(stale.querySelector('.m-stale-time').textContent).toMatch(/\d{1,2}:\d{2} (AM|PM)$/);
  expect(screen.queryByText(/offline copy/)).toBeNull();
});

test('a cache-served response renders "offline copy · as of <cached time>" with the dot (the call site)', async () => {
  api.get.mockResolvedValue({ ...env([row()]), staleAt: '2026-08-13T14:14:00' });
  mount();
  await screen.findByText('Henderson');
  const stale = screen.getByText(/offline copy · as of/).closest('.m-stale');
  expect(stale.querySelector('.m-stale-dot')).not.toBeNull();
  expect(stale.querySelector('.m-stale-time')).toHaveTextContent('2:14 PM');
});

test('empty states: Upcoming, Past, Needs staff with nothing open, Needs staff on an empty calendar', async () => {
  api.get.mockResolvedValue(env([]));
  mount();
  expect(await screen.findByText('Nothing on the calendar')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'past', offset: 0, limit: 60, total_events: 0, scope_events: 0, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('radio', { name: 'Past' }));
  expect(await screen.findByText('No past events')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'upcoming', offset: 0, limit: 60, total_events: 0, scope_events: 3, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('radio', { name: 'Upcoming' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 } }));
  fireEvent.click(await screen.findByRole('button', { name: /Needs staff/ }));
  expect(await screen.findByText('Fully staffed')).toBeInTheDocument();
  api.get.mockResolvedValue({ data: { scope: 'upcoming', offset: 0, limit: 60, total_events: 0, scope_events: 0, needs_staff_events: 0, has_more: false, next_offset: 60, rows: [] } });
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));   // off
  fireEvent.click(screen.getByRole('button', { name: /Needs staff/ }));   // on again, empty calendar
  expect(await screen.findByText('Nothing on the calendar')).toBeInTheDocument();
});

test('a booked card navigates to the event detail; a manual card opens the shift drawer', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null, proposal_guest_count: null })]));
  mount();
  await screen.findByText('Henderson');
  fireEvent.click(screen.getByRole('button', { name: /Night Market/ }));
  expect(await screen.findByTestId('shift-drawer')).toHaveTextContent('drawer 7');
  fireEvent.click(screen.getByRole('button', { name: /Henderson/ }));
  expect(await screen.findByTestId('detail')).toBeInTheDocument();
});

test('a failed load shows an inline retry, never a silent empty list', async () => {
  api.get.mockRejectedValueOnce({ status: 0, message: 'Network error. Check your connection.' }).mockResolvedValueOnce(env([row()]));
  mount();
  expect(await screen.findByText(/Couldn't load events/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Henderson')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/staleTime.test.js src/pages/mobile/EventsListPhone.test.js`
Expected: FAIL, `formatStaleTime is not a function` and `Cannot find module './EventsListPhone'`.

- [ ] **Step 3: Add the formatter, then write the component**

Append to `client/src/utils/staleTime.js` (keep `formatStaleAt` as is):

```js
// The time alone, for the benchmark's two-state line where the label
// ("as of" live, "offline copy · as of" cache-served) is rendered by the screen
// and only the time sits in .m-stale-time. Same day rule as formatStaleAt.
export function formatStaleTime(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', TIME);
  return sameDay ? time : `${d.toLocaleDateString('en-US', DAY)}, ${time}`;
}
```

Create `client/src/pages/mobile/EventsListPhone.js`:

```js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import useUrlListState from '../../hooks/useUrlListState';
import useDrawerParam from '../../hooks/useDrawerParam';
import { groupShiftRows, railParts } from '../../utils/eventCards';
import { formatStaleTime } from '../../utils/staleTime';
import StatusChip from '../../components/adminos/StatusChip';
import Icon from '../../components/adminos/Icon';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';

// Phone Events list (spec 2026-08-13-mobile-admin section 4 List; benchmark
// docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Events tab).
// Renders INSIDE AdminLayout's scrolling .m-main; the header and tab bar are
// the chrome's. Reads the scoped, event-paged admin feed (GET /shifts?scope=)
// and groups the per-shift rows into one card per event.
//
// Manual shifts (no proposal, so no detail page) open the desktop ShiftDrawer
// here as the no-dead-end interim; lane ma-e2 swaps in the phone sheet and
// owns the push-history Back behavior. This drawer keeps replace semantics.
const PAGE = 60;
const LIST_DEFAULTS = { scope: 'upcoming', needs: '' };
const SCROLL_KEY = (scope, needs) => `m-events-scroll:${scope}:${needs ? 1 : 0}`;
const SKELETONS = [['62%', '44%'], ['70%', '38%'], ['55%', '46%'], ['66%', '40%']];

function scrollHost() { return document.getElementById('main-content'); }

export default function EventsListPhone() {
  const navigate = useNavigate();
  const drawer = useDrawerParam();
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const scope = listState.scope === 'past' ? 'past' : 'upcoming';
  const needs = scope === 'upcoming' && listState.needs === '1';

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);      // last envelope minus rows
  const [staleAt, setStaleAt] = useState(null); // x-sw-cached-at when the SW served it
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const reqSeq = useRef(0);

  const params = useCallback((offset) => {
    const p = { scope, limit: PAGE, offset };
    if (needs) p.needs_staff = 1;
    return p;
  }, [scope, needs]);

  const load = useCallback(async (offset, append) => {
    const seq = ++reqSeq.current;
    if (append) setLoadingMore(true); else { setLoading(true); setError(null); }
    try {
      const res = await api.get('/shifts', { params: params(offset) });
      if (seq !== reqSeq.current) return;                 // a newer request superseded this one
      const { rows: page = [], ...rest } = res.data || {};
      setRows(prev => (append ? prev.concat(page) : page));
      setMeta(rest);
      setStaleAt(res.staleAt || null);
      setFetchedAt(new Date().toISOString());
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err && err.message ? err.message : 'Network error. Check your connection.');
      if (!append) setRows([]);
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [params]);

  useEffect(() => { load(0, false); }, [load]);

  // List scroll restore (spec section 9): the scroll container is the chrome's
  // .m-main, keyed per scope + chip so Past does not inherit Upcoming's offset.
  // sessionStorage lives for one launch: Back from a detail restores, a cold
  // launch of the installed app lands at the top on purpose.
  useEffect(() => {
    const host = scrollHost();
    if (!host) return undefined;
    const key = SCROLL_KEY(scope, needs);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => { raf = 0; try { window.sessionStorage.setItem(key, String(host.scrollTop)); } catch { /* storage may be unavailable */ } });
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => { host.removeEventListener('scroll', onScroll); if (raf) window.cancelAnimationFrame(raf); };
  }, [scope, needs]);
  useEffect(() => {
    if (loading || !rows.length) return;
    const host = scrollHost();
    if (!host) return;
    let saved = 0;
    try { saved = Number(window.sessionStorage.getItem(SCROLL_KEY(scope, needs)) || 0); } catch { saved = 0; }
    if (saved > 0 && host.scrollHeight - host.clientHeight >= saved) host.scrollTop = saved;
    // Only on the first render of a loaded list for this scope; appends must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, scope, needs]);

  const cards = useMemo(() => groupShiftRows(rows), [rows]);
  const cachedTime = formatStaleTime(staleAt);
  const liveTime = formatStaleTime(fetchedAt);
  const totalEvents = meta ? Number(meta.total_events || 0) : 0;
  const scopeEvents = meta ? Number(meta.scope_events || 0) : 0;
  const hasMore = !!(meta && meta.has_more);
  const needsCount = meta ? Number(meta.needs_staff_events || 0) : 0;

  const onTap = (card) => {
    if (card.tapTarget.kind === 'shift') drawer.open('shift', card.tapTarget.id);
    else navigate(`/events/${card.tapTarget.id}`);
  };

  // Benchmark renderVals: the chip's empty state is "Fully staffed" only when
  // the scope has events at all; an empty calendar says so even with the chip on.
  let empty = null;
  if (!loading && !error && cards.length === 0) {
    if (needs && scopeEvents > 0) empty = { ok: true, icon: 'check', title: 'Fully staffed', body: 'Every upcoming shift is covered. New applications will show up here.' };
    else if (scope === 'past') empty = { icon: 'calendar', title: 'No past events', body: 'Finished events will land here.' };
    else empty = { icon: 'calendar', title: 'Nothing on the calendar', body: 'Booked proposals land here on their event date.' };
  }

  return (
    <div className="m-events">
      <div className="m-listbar">
        <div className="m-seg" role="radiogroup" aria-label="Scope">
          <button type="button" role="radio" aria-checked={scope === 'upcoming'} className={`m-seg-btn${scope === 'upcoming' ? ' active' : ''}`}
            onClick={() => scope !== 'upcoming' && setListState({ scope: '' })}>Upcoming</button>
          <button type="button" role="radio" aria-checked={scope === 'past'} className={`m-seg-btn${scope === 'past' ? ' active' : ''}`}
            onClick={() => scope !== 'past' && setListState({ scope: 'past', needs: '' })}>Past</button>
        </div>
        {scope === 'upcoming' && (
          <button type="button" className={`m-chip-toggle${needs ? ' on' : ''}`} aria-pressed={needs}
            onClick={() => setListState({ needs: needs ? '' : '1' })}>
            Needs staff<span className="m-chip-count">{needsCount}</span>
          </button>
        )}
      </div>

      {loading && cards.length === 0 && !error && (
        <>
          <div className="m-skel-note">first sync · fetching events</div>
          {SKELETONS.map(([w1, w2], i) => (
            <div key={i} className="m-card m-card-skel" aria-hidden="true">
              <span className="m-skel-rail" />
              <span className="m-card-body" style={{ gap: 9 }}>
                <span className="m-skel-bar" style={{ width: w1 }} />
                <span className="m-skel-bar thin" style={{ width: w2 }} />
              </span>
            </div>
          ))}
        </>
      )}

      {error && (
        <div className="m-empty" role="alert">
          <div className="m-empty-title">Couldn't load events</div>
          <div className="m-empty-body">{error}</div>
          <button type="button" className="m-seg-btn active" onClick={() => load(0, false)}>Retry</button>
        </div>
      )}

      {!loading && !error && (
        <>
          {(cachedTime || liveTime) && (
            <div className="m-stale">
              {cachedTime && <span className="m-stale-dot" aria-hidden="true" />}
              <span>{cachedTime ? 'offline copy · as of' : 'as of'} <span className="m-stale-time">{cachedTime || liveTime}</span></span>
            </div>
          )}
          {cards.map(card => <EventCard key={card.key} card={card} past={scope === 'past'} onTap={onTap} />)}
          {empty && (
            <div className={`m-empty${empty.ok ? ' ok' : ''}`}>
              <Icon name={empty.icon} size={28} />
              <div className="m-empty-title">{empty.title}</div>
              <div className="m-empty-body">{empty.body}</div>
            </div>
          )}
          {hasMore && (
            <button type="button" className="m-card m-card-more" onClick={() => load(meta.next_offset, true)} disabled={loadingMore}>
              <span className="m-showmore">{loadingMore ? 'Loading' : 'Show more'}</span>
              <span className="m-shownof">{cards.length} of {totalEvents}</span>
            </button>
          )}
          {!hasMore && !needs && cards.length > 0 && (
            <div className="m-end"><span>{scope === 'past' ? 'End of history' : 'End of upcoming'} · {totalEvents} {totalEvents === 1 ? 'event' : 'events'}</span></div>
          )}
        </>
      )}

      <ShiftDrawer
        open={drawer.kind === 'shift' && !!drawer.id}
        shiftId={drawer.kind === 'shift' && drawer.id ? Number(drawer.id) : null}
        onClose={drawer.close}
        onUpdate={() => load(0, false)}
      />
    </div>
  );
}

function EventCard({ card, past, onTap }) {
  const rail = card.ymd ? railParts(card.ymd) : { dow: '', day: '', mon: '' };
  const fracClass = past ? 'm-frac past' : card.full ? 'm-frac full' : 'm-frac';
  const title = `${card.clientName} · ${card.kind}`;
  return (
    <button type="button" className={`m-card${card.cancelled ? ' m-card-cancelled' : ''}`} onClick={() => onTap(card)} aria-label={title}>
      <span className={`m-rail${card.isToday && !past ? ' today' : ''}`}>
        <span className="m-rail-dow">{rail.dow}</span>
        <span className="m-rail-day">{rail.day}</span>
        <span className="m-rail-mon">{card.isToday && !past ? 'TODAY' : rail.mon}</span>
      </span>
      <span className="m-card-body">
        <span className="m-card-head">
          <span className="m-card-title">{card.clientName} <span className="m-card-kind">· {card.kind}</span></span>
          {card.guests != null && <span className="m-card-guests">{card.guests} <small>GUESTS</small></span>}
        </span>
        <span className="m-card-meta">{[card.timeRange, card.venue].filter(Boolean).join(' · ')}</span>
        <span className="m-card-foot">
          {card.cancelled ? (
            <StatusChip kind="neutral">Cancelled</StatusChip>
          ) : (
            <>
              <span className={fracClass}>{card.filled}/{card.slots}</span>
              {card.shiftCount > 1 && <span className="m-shiftnote">{card.shiftCount} shifts</span>}
              {card.pending > 0 && !past && <StatusChip kind="warn">{card.pending} {card.pending === 1 ? 'request' : 'requests'}</StatusChip>}
            </>
          )}
          <span className="m-tags">
            {card.manual && <span className="m-tag">Manual · tap to staff</span>}
            {card.barRental && <span className="m-tag bar">Bar</span>}
            {card.supplies && <span className="m-tag supplies">Supplies</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
```

Notes for the implementer: `setListState({ scope: '' })` clears the param because `''` equals the default; `aria-label` on the card is the benchmark's title text so the tests and screen readers name the target; with the chip on, Show more still renders when the server says `has_more` (honest paging) but the end divider does not (the benchmark hides it while filtering, and its count would be the filtered count).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/staleTime.test.js src/pages/mobile/EventsListPhone.test.js`
Expected: staleTime suite green including the new case; EventsListPhone 9 PASS.

- [ ] **Step 4b: The CSS/markup seam receipt**

Run from `client/`:

```bash
grep -oE 'className=\{?[`"'"'"'][^`"'"'"']+' src/pages/mobile/EventsListPhone.js | grep -oE 'm-[a-z0-9-]+' | sort -u > /tmp/m-used.txt
grep -oE '\.m-[a-z0-9-]+' src/index.css | tr -d . | sort -u > /tmp/m-defined.txt
comm -23 /tmp/m-used.txt /tmp/m-defined.txt
```

Expected: empty output (every `m-*` class the component emits has a rule). A non-empty line is either a typo in the component or a missing rule in Task 3; fix whichever it is before committing.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/staleTime.js client/src/utils/staleTime.test.js client/src/pages/mobile/EventsListPhone.js client/src/pages/mobile/EventsListPhone.test.js && git commit -F - -- client/src/utils/staleTime.js client/src/utils/staleTime.test.js client/src/pages/mobile/EventsListPhone.js client/src/pages/mobile/EventsListPhone.test.js <<'MSG'
feat(mobile): the phone Events list

Upcoming / Past switch, Needs staff chip, one card per event, Show more,
end divider, skeleton, empty states, the two-state staleness line (live
"as of", cache-served "offline copy · as of" with the dot), scroll
restore within a launch, and taps into the detail or the shift drawer.
MSG
```

---

### Task 5: Fork `EventsDashboard` at phone width

**Files:**
- Modify: `client/src/pages/admin/EventsDashboard.js` (`:54` and the end of file)
- Test: `client/src/pages/admin/EventsDashboard.fork.test.js` (new)

**Interfaces:**
- Consumes: `useMobileView()`; `EventsListPhone` (Task 4); screen key `events-list` (exists).
- Produces: the same default export name, now forking; the desktop component is renamed `EventsDashboardDesktop` inside the file and is otherwise untouched.

- [ ] **Step 1: Write the failing test**

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close over
// variables named mock*, and this one calls jest.fn() so the pure-const exemption
// does not apply.
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/EventsListPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-list" /> }));
// The desktop body pulls in the toolbar, drawers and api; stub what it needs to mount.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(() => Promise.resolve({ data: [] })) } }));
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }) }));
import { MemoryRouter } from 'react-router-dom';
import EventsDashboard from './EventsDashboard';

const mount = () => render(<MemoryRouter initialEntries={['/events']}><EventsDashboard /></MemoryRouter>);

test('phone width without a Desktop-view override renders the phone list', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-list')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('events-list');
});

test('phone width with the Desktop-view override renders the desktop dashboard', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  expect(screen.getByText('Events')).toBeInTheDocument();   // the desktop page title
});

test('desktop width renders the desktop dashboard', () => {
  mockMobileView.isPhone = false;
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
});
```

If mounting the desktop body needs more stubs than these (the `Toolbar`, `KebabMenu`, `ShiftDrawer`, `InvoicesDrawer` imports), stub them with `jest.mock` one-liners in the same file rather than weakening the assertions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/EventsDashboard.fork.test.js`
Expected: the first test FAILS (the phone list never renders).

- [ ] **Step 3: Add the fork**

In `EventsDashboard.js`: add `import { useMobileView } from '../../context/MobileViewContext';` and `import EventsListPhone from '../mobile/EventsListPhone';`. Change `:54` from `export default function EventsDashboard() {` to `function EventsDashboardDesktop() {`. Append at the end of the file:

```js
// Route-level fork (spec 2026-08-13-mobile-admin section 3): the URL and the
// route table stay the same; at phone width the phone list renders unless
// this screen is pinned to Desktop view. The fork lives here, above the
// desktop body's hooks, so hook order never changes between branches.
export default function EventsDashboard() {
  const { isPhone, desktopView } = useMobileView();
  if (isPhone && !desktopView('events-list')) return <EventsListPhone />;
  return <EventsDashboardDesktop />;
}
```

- [ ] **Step 4: Run the tests and the build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/EventsDashboard.fork.test.js src/pages/mobile src/utils/eventCards.test.js src/components/mobile` then `CI=true npx react-scripts build`
Expected: all PASS; build 0 errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/EventsDashboard.js client/src/pages/admin/EventsDashboard.fork.test.js && git commit -F - -- client/src/pages/admin/EventsDashboard.js client/src/pages/admin/EventsDashboard.fork.test.js <<'MSG'
feat(mobile): fork the Events route to the phone list at phone width

Same URL, same route table; the desktop dashboard is untouched and still
renders under the per-screen Desktop-view override.
MSG
```

---

### Task 6: Phone-viewport gate and the benchmark comparison

**Files:**
- Modify: `scripts/mobile-capture.manifest.json` (add three admin pages)
- No committed Playwright script; the checks below run ad hoc from the lane with `playwright-core` per `.claude/agent-memory/ui-ux-reviewer/local-ui-review-recipe.md`.

- [ ] **Step 1: Add the admin pages to the manifest**

Append to `pages`:

```json
    { "name": "admin-events", "host": "localhost", "path": "/events", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" },
    { "name": "admin-events-past", "host": "localhost", "path": "/events?scope=past", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" },
    { "name": "admin-events-needs", "host": "localhost", "path": "/events?needs=1", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" }
```

`"host": "localhost"` is right: the script builds `http://${entry.host}:3000` (`scripts/mobile-capture.js:107`) and the admin app answers on plain localhost.

- [ ] **Step 2: Run the capture**

With the dev server up (`npm run dev` per the recipe): `npm run mobile:check`
Expected: the three admin pages pass the overflow, tap-target and tiny-text probes (no horizontal overflow, no target under 44px, no text under the probe's floor). Fix any finding in CSS before moving on.

- [ ] **Step 3: Ad hoc browser checks (record results in the lane notes, C1 to C8)**

Using `playwright-core` with the bundled Chromium at 390x844, a dev admin JWT, and `http://localhost:3000/events`:
- C1: `.m-listbar` is sticky: scroll 800px, `document.elementFromPoint` at the chip's center is the chip.
- C2: tapping "Past" changes the URL to `/events?scope=past` without a new history entry (`history.length` unchanged).
- C3: the Needs staff chip count equals the count of distinct `event_key` values with `needs_staff` true in a direct `GET /api/shifts?scope=upcoming&limit=200` response for the same JWT.
- C4: the chip agrees with the badge at the SHIFT level: in `GET /api/shifts?scope=upcoming&needs_staff=1&limit=200` count the rows whose `needs_staff` is true; that count must equal `GET /api/admin/badge-counts` `unstaffed_events`. Unflagged sibling shifts ride along in the chip rows by design (the chip keeps whole events), so the raw row count may be larger; the chip's own number (`needs_staff_events`) counts EVENTS and may be smaller than the badge, which counts shifts.
- C5: `elementFromPoint` on the center of the first card and on the Show more row returns the button itself (nothing overlays them).
- C6: a manual-shift card opens the desktop drawer; its Approve and Deny rows pass an `elementFromPoint` probe at their centers at 390px width (the interim is a primary action reachable from this screen). Closing it through its own close control returns to the list. Android Back from the open drawer LEAVES the list (the interim drawer keeps `useDrawerParam`'s replace semantics); the phone sheet in lane ma-e2 owns the push variant and the Back-closes-the-sheet law.
- C7: offline: set the context offline after a live load, reload; the list renders from cache with the `as of` line and the amber dot (the SW serves `/api/shifts?scope=upcoming&limit=60&offset=0` on transport failure). Assert the `.m-stale-time` text starts with "as of".
- C8: both skins: switch Lighting to House Lights on More, return to Events, screenshot; compare against the benchmark's light Events screen (cards squared, fraction bordeaux/emerald, tags navy/emerald).
- C9: open a card's detail, go Back: the list restores its scroll offset (within one launch). Then kill and cold-launch the installed app on the same route: the list lands at the top (sessionStorage does not survive a cold launch; route restore does, and a stale offset over a re-fetched list is not worth restoring). Record both as the intended reading of spec section 9.

Record C1 to C9 results in the "Browser checks" section at the end of this plan, on main, before the merge.

Then run the ui-ux-review lane agent against the benchmark's Events tab (dark and light, Upcoming, Past, Needs staff, empty, Show more, end divider) with the dev server running; adherence to the artifact is its primary benchmark.

- [ ] **Step 4: Commit**

```bash
git add scripts/mobile-capture.manifest.json && git commit -F - -- scripts/mobile-capture.manifest.json <<'MSG'
test(mobile): phone-viewport capture pages for the admin Events list
MSG
```

---

### Task 7: Docs and ledgers

**Files:**
- Modify: `README.md` (`:622` tree line for `pages/mobile/`; the `client/src/utils/` tree)
- Modify: `ARCHITECTURE.md` (`:440`, the `GET /` row of the Shifts table)
- Modify: `docs/walkthroughs-owed.md` (new entry)
- Modify: `docs/fix-list-remaining-2026-07-02.md` (`:1725` entry)

- [ ] **Step 1: README**

Change the `pages/mobile/` tree line to name both pages: `mobile/  # Phone-first admin pages: MorePage (the More tab) and EventsListPhone (the phone Events list: scoped feed, one card per event, Needs staff chip, Show more, staleness line)`. In the `client/src/utils/` tree add `eventCards.js  # Groups GET /shifts rows into one card per event for the phone list (pure)`.

- [ ] **Step 2: ARCHITECTURE**

Also qualify `ARCHITECTURE.md:461` (the sentence saying the admin branch deliberately does not filter and every admin surface filters client-side) to the BARE branch only, since the scoped mode filters server-side, and add the scoped feed to the `shiftNotFinishedSql` family list near `:470`. Mention `client/src/utils/eventCards.js` in the mobile-admin section as the grouping module. Replace the `GET /` row with: `| GET | \`/\` | Yes | List shifts (staff see open upcoming; admin see **all**, cancelled included, as a bare array). Admin only: \`?scope=upcoming\|past&limit=60&offset=0&needs_staff=1\` switches to the phone Events feed: paged by EVENT, envelope \`{ scope, offset, limit, total_events, scope_events, needs_staff_events, has_more, next_offset, rows }\` (total_events = events in the current filter, scope_events = events in the scope regardless of the chip, needs_staff_events = events with a flagged shift, 0 on past), rows carry \`event_key\` and \`needs_staff\` (the unstaffed_events badge predicate, pinned by shifts.adminScoped.test.js). |`

- [ ] **Step 3: walkthroughs-owed**

Add under the open items: `- [ ] **Phone Events list (lane ma-e1, merged <date>).** Pixel, installed PWA, prod data: Upcoming opens on today, Past shows history newest first with cancelled cards muted, the Needs staff chip matches the tab badge's meaning (chip counts events, badge counts shifts), Show more pages without splitting a two-shift event, airplane mode shows the "offline copy · as of" line with the dot while a live load shows "as of" alone, a manual shift opens the drawer (Back leaves the list until the ma-e2 sheet lands). Both skins.`

- [ ] **Step 4: fix list**

Amend the `:1808` entry's first sentence to record that the Events list is built by lane ma-e1 (this plan) and that the detail, staffing sheet, edit sheet, proposals list and detail, and search are declared lanes in this plan's lane map, keeping the staleness-line paragraph's history but marking it CLOSED for the list (the call site now exists and is tested).

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md && git commit -F - -- README.md ARCHITECTURE.md docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md <<'MSG'
docs(mobile): Events list page, eventCards util, scoped shifts feed, owed walk
MSG
```

---

### Task 8: Lane close: suites reached, gate, review fleet

- [ ] **Step 1: Server suites, one at a time from the repo root**

`node --test server/routes/shifts.adminScoped.test.js` (and with `TZ=UTC`), then every `server/routes/shifts*.test.js` file one at a time (`ls server/routes/shifts*.test.js` lists them; `shifts.visibility.endInstant.test.js` in both TZs), `server/routes/eventDetails.test.js`, `server/routes/admin/settings.badgeCounts.test.js`. Read every pass count and compare each with the same suite on `main` before the lane.

- [ ] **Step 2: Client suites and build**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/eventCards.test.js src/pages/mobile src/pages/admin/EventsDashboard.fork.test.js src/components/mobile src/context` then `CI=true npx react-scripts build`.

- [ ] **Step 3: Desktop regression by eye**

Dev server, desktop viewport: `/events` renders the table exactly as before (same rows, tabs, kebab, drawer). The Overview page's upcoming count unchanged. The staff `/shifts` page unchanged (staff path untouched).

- [ ] **Step 4: Review fleet, per the lane map**

code-review, consistency-check, ui-ux-review (against the 2026-09-15 benchmark, Events tab). Fix rounds as needed; record as-built deltas in this plan's "Lane review round" section before the merge.

- [ ] **Step 5: Merge**

Squash-merge through `os` on `main` via `scripts/merge-lane.sh`; then `npm install` in `os` only if the lane installed anything (it should not); clear the lane's `node_modules` dirs; `npm run worktree:rm`. Board line via `scripts/board-write.sh`.

## Self-Review (2026-09-15)

1. **Spec coverage.** Section 3 fork and Visual contract: Tasks 3, 4, 5, 6. Section 4 List: card layout, date order, Upcoming / Past, Needs staff = badge predicate, feed extension with scope and paging, pending chip from `rc.pending_count`, one card per event, manual shifts open the sheet (interim drawer here, sheet in ma-e2): Tasks 1, 2, 4. Section 7 offline staleness line: Task 4 with the call-site test; allowlist untouched (query strings cache separately, documented in Proven context). Section 9 list scroll restore: Task 4. Section 10 inline errors with retry: Task 4. Section 11 per-screen gate: Task 6. Docs law: Task 7. Not in this lane, declared: detail, sheet, edit sheet, proposals, search.
2. **Placeholder scan.** One deliberate paste instruction in Task 1 Step 3 (the projection moves verbatim; retyping 105 lines of SQL into a plan is how a column goes missing); the line anchors are in Proven context. No TBDs.
3. **Type consistency.** `groupShiftRows(rows, { todayYmd })` and `railParts(ymd)` (Task 2) match their uses in Task 4; the envelope fields (`total_events`, `needs_staff_events`, `has_more`, `next_offset`, `rows`) match between Task 1's route, its test, and Task 4's reads; `tapTarget.kind` is `'event' | 'shift'` in both; the screen key `events-list` matches `screenKey.js`.
5. **Plan fleet 2026-09-18 (fidelity, decomposition, feasibility; 3 blockers, 9 warnings, 8 suggestions, all folded):** needs_staff filtered per shift row and split mixed events (fixed: event-level membership plus a mixed fixture); the proposals fixture cast `gen_random_uuid()::text` into a uuid column (fixed: the default supplies the token); the Task 5 mock closed over a non-`mock`-prefixed variable (fixed); the scope boundary and the future-dated-cancelled bucket were re-decisions the spec never recorded (decided, stated above, spec amended); the Sentry surface tag finding was false (AdminLayout sets it globally); stale line now has the benchmark's two states with a time-only span; filtering suppresses the end divider and the envelope carries `scope_events` so the empty-state split is decidable; legacy column set pinned; the plan-queue suite and every shifts suite run; line anchors, `wedding` label, the two type tokens and the fix-list anchor corrected; Task 1 split into a move commit and a feature commit with a consistency-check plus a query-shape database-review at that checkpoint.
4. **Known judgment calls, stated:** paging by DENSE_RANK over a CTE re-runs the full admin projection per page (the projection is the same query the desktop runs once for all rows; with LIMIT applied after ranking, Postgres still materializes the scope, so a page costs about what the desktop dump costs today; acceptable at this table size, and the desktop already does it). The Needs staff chip count comes from the server per response so the chip is right even before the first page is scrolled. `supply_run_required` is the Supplies flag (the design prompt said `supply_run`; the column is `supply_run_required`).

## Browser checks (lane ma-e1, run 2026-09-18 against the lane's dev server, Chromium 390x844, dev admin JWT; full evidence in the lane's Task 6 report)

| check | result | evidence |
|---|---|---|
| C1 sticky bar | pass | Past scrolled 800px of 5244: `.m-listbar` stays at the top of the scroll area and `elementFromPoint` at its centre returns the bar; the fix wave moved it from `top: 0` to `top: -0.75rem` after ui-ux-review measured a 10px band of scrolling cards above it |
| C2 Past tap, no history entry | pass | `history.length` 2 before and after; URL `/events` to `/events?scope=past` |
| C3 chip count vs the feed | pass | chip "Needs staff 5"; `GET /shifts?scope=upcoming&limit=200` has 5 distinct flagged event keys and `needs_staff_events: 5` (every dev event is single-shift, so the distinct-key collapse is exercised only degenerately) |
| C4 chip vs badge at the shift level | pass | 5 flagged chip rows = `unstaffed_events` 5; no multi-shift upcoming event in dev, so the ride-along branch is unexercised (the server suite's proposal C fixture covers it) |
| C5 nothing overlays the targets | pass | `elementFromPoint` at the first card's centre and at Show more's centre lands inside the respective button |
| C6 manual card opens the drawer | pass, with a finding | opens `?drawer=shift&drawerId=17`; the desktop drawer's Approve and Deny rows are 22px tall and its close control 28x26 at phone width (interim; ma-e2 replaces it); Android Back leaves the list (replace semantics, ma-e2 owns the push variant) |
| C7 offline | not testable against the dev server | the SW is live in dev and caches the feed, but the unhashed CRA dev bundle cannot boot offline; in-document proof: live load, offline, Past (uncached) shows the error state with Retry, Upcoming (cached) renders 5 cards with "offline copy · as of 6:02 PM" and the dot; the prod-build offline boot is ma-b's harness; the Pixel walk covers airplane mode |
| C8 both skins | pass | House Lights: squared cards, fraction bordeaux, tags navy/emerald; switched back to After Hours and confirmed |
| C9 scroll restore | pass within a launch; cold launch = Pixel walk | Past scrolled to 1200, tap into `/events/13`, Back returns to `/events?scope=past` at 1200 |

`npm run mobile:check`: the three admin Events pages pass the overflow, tap-target and tiny-text probes once the interim drawer mounts only when open; the run still exits 1 on a pre-existing `portal-home` auth-hydration race on `public.localhost/my-proposals`, unrelated to this lane (backlog item).

## Lane review round, as-built deltas (ma-e1, 2026-09-18)

- Method: one Opus implementer per task, task reviewers on Tasks 1 and 4, a consistency plus query-shape checkpoint after Task 1, controller diff checks on 2, 3, 5, 7, the browser gate as Task 6, then the lane fleet (code-review, consistency-check, ui-ux-review) over the whole branch.
- Task 1 took two fix rounds before its review passed: the needs_staff flag gained its own end-instant term (past rows had read true); events rank by MIN/MAX(event_date) per event key so a two-date event cannot split pages; the totals moved to a one-row CTE LEFT JOINed to the page so an empty page (chip on, nothing needs staff) still reports `scope_events` and the "Fully staffed" state is reachable; `event_date` precedes `start_time` inside an event; `COALESCE(s.status, '')` on both bucket predicates; the flag is `COALESCE(..., false)` so a NULL roster never ships a NULL flag. The legacy column set is pinned by a 52-key capture made before the move.
- Task 4 took two fix rounds plus a browser-gate round: a fresh load clears the list and shows the skeleton (the plan's guard left a blank body on scope switches); scroll offsets save only after the loaded list for the current key has been restored (`loadedKey` plus a latch), because the skeleton's clamp scroll was overwriting the saved offset; the stale-time tests pin the same-day branch; the `bar` modifier was renamed `m-tag-bar` (it collided with the design system's `.bar` progress rule and rendered a sliver); the interim drawer mounts only when open (its closed off-canvas position failed the overflow probe); the `.m-events` wrapper class was dropped (no rule).
- Task 5's test needed a PaletteContext stub and a stable toast object (an inline toast recreates the desktop dashboard's fetch callback every render and loops).
- Lane fleet: consistency-check PASS; ui-ux-review PASS (adherence class for class; a11y clean on the list; desktop `/events` and Overview unchanged); code-review FAIL on one Critical, fixed in the final wave: a failed Show more set the page-level error and unmounted the loaded list.
- Final fix wave (after the fleet): append errors render inline under Show more with their own Retry and never remove loaded rows; appends no longer rewrite the staleness label; the fork test awaits the desktop fetch (act warnings gone); `formatStaleAt` is a thin wrapper over `formatStaleTime`; the card's duration rides into `fmtTimeRange24` like the desktop; the card's accessible name is its content; the sticky bar seals the top of the scroll area (`top: -0.75rem`); the error Retry has its own 44x88 class; nameless manual shifts no longer read "Manual shift · Manual shift"; the chip count renders only once the envelope lands; ARCHITECTURE describes the fork's mount path and the badge-versus-chip counting units.
- Deferred to ma-g design fit or the fix list: the global `.chip.warn` hard-codes amber where the design system's warn token is teal; the rail shows no year, so a next-year event reads out of order; full-address venues wrap the meta (drop the duration on the card, ellipsize the venue); the 8px rail month and GUESTS label are ink-4 at 2.6:1 (the artifact's own tokens); the TODAY rail uses the device day like the desktop list; `NEEDS_STAFF_SQL` and the badge count the legacy object roster shape as one slot where `parsePositionsCount` expands it; `ORDER BY start_time` sorts a VARCHAR as a same-date tiebreak inside one event; `base` is O(scope) per page (1.5 to 5.1 ms on dev; the O(page) rewrite is named); the interim drawer's 22px rows until ma-e2.
