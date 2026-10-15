# Mobile Admin Proposals List (lane ma-f1-proposals-list) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone Proposals tab stops showing the desktop table inside the phone chrome and renders the phone-first Proposals list from the 2026-10-14 benchmark: the desktop Active bucket as date-rail cards with the pipeline chip and the total, a Newest lead / Event date order switch, an Unviewed chip with its count, Show more paging, the staleness line, the skeleton, the empty states and the end divider.

**Architecture:** One opt-in mode on the existing `GET /api/proposals` (`envelope=1`, plus the `created_at` sort key and a server-side `unviewed=1` predicate; the bare array and its `X-Total-Count` header stay exactly as they are for every existing consumer). One pure card model (`client/src/utils/proposalCards.js`) turning a list row into what the card shows. One phone page (`client/src/pages/mobile/ProposalsListPhone.js`) built on the ma-e1 Events list's mechanics (URL state, skeleton, stale line, Show more with an inline append error, scroll restore) and the `.m-card` family already in `index.css`. One route-level fork in `ProposalsDashboard.js`, the same shape as `EventsDashboard.js`.

**Tech Stack:** Express + pg on the server; React 18, react-router v6, axios through `utils/api` and `utils/offlineRead`, React Testing Library; `node:test` against the shared dev DB for the route; the design-system mobile CSS already folded into `client/src/index.css`.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`, section 5 "List" (apparatus settled 2026-08-14; feed grounding), section 3 Visual contract (Proposals list line), section 7 Offline, section 9 (lists remember scroll), section 12 Decisions log ("Proposals apparatus"). Benchmark: `docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html`, the Proposals tab (its data prop `proposalsData` takes `typical`, `all viewed`, `empty active`, `cold load`). Declared as lane `ma-f1-proposals-list` in `docs/superpowers/plans/2026-09-15-mobile-admin-events-list.md` (lane map: depends on `ma-e1-events-list`, which is built; review fleet code-review, consistency-check, ui-ux-review).

## Proven context (read on main at `6e8f5c95`, 2026-10-14; anchors are line numbers that day)

- `server/routes/proposals/list.js` (197 lines): `SORT_COLUMNS` at `:32-41` (keys `client`, `event`, `event_date`, `package`, `status`, `sent`, `last_viewed`, `total`; the comment at `:27-31` says the keys mirror `ProposalsDashboard`'s `SortableTh` sortKeys exactly); the query destructure at `:47-48`; the `view` buckets at `:86-95` (default `active` = `status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived')`); `search` at `:97-100` (`c.name ILIKE` or `c.email ILIKE`); `ORDER BY` at `:156-161` (`NULLS LAST, p.id DESC`; fallback `p.created_at DESC, p.id DESC`); the projection at `:163-175` already ships `p.status, p.total_price, p.amount_paid, p.sent_at, p.accepted_at, p.last_viewed_at, p.view_count, p.created_at, p.updated_at, p.guest_count, p.event_date, p.event_type, p.event_type_custom, c.name AS client_name`; data + count at `:184-194`, the header `X-Total-Count` and the bare-array body. Pagination is `page` (floors at 1) and `limit` (clamped 1..200, default 50).
- `server/routes/proposals/list.sort.test.js` (170 lines) is the harness exemplar: `require('dotenv').config()` first; `node:test`; a random `TAG` in the seeded client names and `?search=<TAG>` scoping every request to the fixtures; `seed(label, totalPrice, eventDate)` inserts one client and one `sent` proposal with awaited inserts so `created_at` strictly increases; `before` signs a JWT for the first admin/manager user; `after` deletes the proposals, then the clients, then `pool.end()`. The existing tests pin the `total` and `event_date` keys, the bogus-key fallback, and the Object.prototype keys.
- `client/src/pages/mobile/EventsListPhone.js` (311 lines) is the template: `load(offset, append)` with `reqSeq` and `restoredRef` (`:68-96`), the scroll save and restore effects keyed by the response (`:100-135`), the apparatus (`:167-182`: `.m-listbar`, `.m-seg` radiogroup, `.m-chip-toggle` with `.m-chip-count` rendered only once an envelope has landed), the skeleton with the literal `first sync` note (`:184-198`), the page error (`:200-206`), the stale line (`:212-217`), Show more with `.m-showmore` / `.m-shownof`, the inline `.m-more-error`, the `.m-end` divider (`:226-240`), and `EventCard` (`:263-311`: `.m-card`, `.m-rail(-dow/-day/-mon)`, `.m-card-body`, `.m-card-head`, `.m-card-title`, `.m-card-guests`, `.m-card-kind` on its own line per Dallas 2026-09-24, `.m-card-meta`, `.m-card-foot`).
- `client/src/pages/mobile/EventsListPhone.test.js` (381 lines): mocks `../../utils/api` (`{ get: jest.fn() }`) and `ToastContext`; asserts `api.get` calls with `{ params, headers: { 'X-Offline-Ok': '1' } }`; mounts in a `MemoryRouter` with a `LocationProbe`; `beforeEach` clears mocks and `sessionStorage`.
- `client/src/pages/admin/EventsDashboard.js:56` `function EventsDashboardDesktop()`, `:398-402` the fork: `const { isPhone, desktopView } = useMobileView(); if (isPhone && !desktopView('events-list')) return <EventsListPhone />; return <EventsDashboardDesktop />;`. `client/src/pages/admin/EventsDashboard.fork.test.js` is the fork test exemplar (a `mock*`-prefixed MobileView object, the phone list stubbed, `api.get` resolving `{ data: [] }`, a stable toast object, `usePalette` stubbed).
- `client/src/pages/admin/ProposalsDashboard.js`: `export default function ProposalsDashboard()` at `:62`; `useUrlListState` keys `tab, q, source, from, to, axis, status, event_type, balance, cohort, page` (`:60`), so the phone's own keys must not collide; rows use `proposalStatusMeta(p.status)` (`:501`), `getEventTypeLabel({ event_type, event_type_custom })` (`:513`), `fmtDate(String(p.event_date).slice(0, 10))` (`:519`), `fmt$(p.total_price)`; it reads the `X-Total-Count` header (`:67, :82, :174`).
- `client/src/utils/proposalStatusMap.js`: `PROPOSAL_STATUS_META` (draft neutral "Draft", sent info "Sent", viewed accent "Viewed", modified violet "Modified", accepted ok "Accepted", ...) and `proposalStatusMeta(status)`. The benchmark's `propChip(s)` map is identical kind for kind, so the phone has one source.
- `client/src/utils/eventCards.js:17` `railParts(ymd)` returns `{ dow, day, mon }` noon-anchored. `client/src/utils/eventTypes.js:8` `getEventTypeLabel({ event_type, event_type_custom })`. `client/src/components/adminos/format.js:12` `fmt$(n)` renders `$4,270` (whole dollars; proposals money is dollars). `client/src/utils/staleTime.js:20` `formatStaleTime(iso)`. `client/src/utils/offlineRead.js` `offlineGet(url, config)` adds `X-Offline-Ok: 1`; `res.staleAt` is set when the worker served the copy.
- `client/src/context/MobileViewContext.js` exposes `{ isPhone, desktopView(screenKey), setDesktopView }` via `useMobileView()`. `client/src/utils/screenKey.js` already maps `/proposals` to `proposals-list` (title "Proposals") and `/proposals/:id` to `proposal-detail` (title "Proposal").
- `client/src/components/mobile/MobileTabBar.js:26`: the Proposals tab's badge key is `pending_proposals` (`server/routes/admin/settings.js:140`: `status IN ('sent', 'viewed', 'modified')`). Untouched.
- `client/public/admin-sw.js:186-189`: `/api/proposals` is in `API_EXACT`; the Cache API keys on the full URL, so each `order` / `page` / `unviewed` combination is its own entry; `stampAndPut` (`:87-99`) keeps the response headers and adds `x-sw-cached-at`. A cached envelope body therefore carries its own totals, which is why the phone reads totals from the body, never from `X-Total-Count`.
- `client/src/index.css` (22702 lines): the mobile block is scoped `html[data-app="admin-os"]`; the card family defined today: `.m-card .m-card-bal .m-card-body .m-card-cancelled .m-card-foot .m-card-guests .m-card-head .m-card-kind .m-card-meta .m-card-more .m-card-owes .m-card-skel .m-card-title .m-chip-toggle .m-empty .m-empty-body .m-empty-title .m-end .m-frac .m-listbar .m-more-error .m-rail .m-rail-day .m-rail-dow .m-rail-mon .m-retry-btn .m-seg .m-seg-btn .m-shiftnote .m-skel-bar .m-skel-note .m-skel-rail .m-stale .m-stale-dot .m-tag .m-tags`; `.m-rail` at `:21539` (44px, right rule), `.m-card-foot` at `:21561` (flex, wrap, `gap: 4px 6px`, `margin-top: 3px`), `.m-frac` at `:21566-21567`. The global `.chip` + `.chip-dot` carry `StatusChip`.
- `client/src/utils/mobileClassContract.test.js`: `SOURCES` is a hand-kept list of phone files whose `m-*` tokens must exist in `index.css`; a new phone page joins it.
- `scripts/mobile-capture.manifest.json:82`: `{ "name": "admin-proposals", "host": "localhost", "path": "/proposals", "auth": "admin", "settleMs": 2600, "authAssert": ".m-shell", "reportOnly": true }` (report-only because the tab had no phone screen).
- Docs anchors: `README.md:701` (the `pages/mobile/` tree line, listing MorePage, EventsListPhone, EventDetailPhone, InboxPhone, NotificationsPhone); `ARCHITECTURE.md:339` (the `GET /` proposals row, which already documents `X-Total-Count`); `ARCHITECTURE.md:2135` ("Phone Events list" bullet; the new bullet goes right after it); `scripts/sensitive-paths.txt:466-467` (the phone pages listed, `EventDetailPhone.js`, `EventsListPhone.js`); `docs/fix-list-remaining-2026-07-02.md` about `:2991-2992` (search "ORDINARY DESKTOP ADMIN PAGE": the "... until `ma-f1` lands" sentence); `docs/walkthroughs-owed.md` Tier 6.
- Benchmark Proposals tab (markup inside `data-screen-label="Proposals"`, the `proposals`/`pScoped`/`pList` script): rail 46px with a right rule (DOW 9px mono, day 20px numeric, month 8px mono); head `client` (600) with ` · kind` inline in ink-3, `guests GUESTS` at the right; `.m-card-meta`; a foot row with the total (numeric 12.5px, ink-2) and the chip at the right edge (`margin-left: auto`); the skeleton note `first sync · fetching proposals` with four pulsing cards; `.m-stale`; the empty block with a 28px icon; `Show more` + `N of M`; the end divider `End of active · N proposals`. Orders: `byLead` newest first (created), `byDate` soonest first; `unviewed` is `pstatus === 'sent'`; the Unviewed chip carries `unviewedCount` (the whole unviewed set) and the filtered list shows every unviewed row; empty copy: filtering with a non-empty bucket = check icon in the ok ink, "Everything opened" / "No sent proposal is waiting to be seen."; otherwise clipboard icon, "No active proposals" / "Drafts and sent quotes land here. Booked ones move to Events.". Meta fixtures: `viewed 5h ago · 3 views`, `modified by client 1d ago`, `sent 2d ago · not opened`, `accepted · awaiting deposit`, `draft · created 3d ago`, `sent 18h ago · not opened`.

## Plan decisions (stated here so the contract is whole)

1. **The kind gets its own line**, not the artifact's inline `client · kind`. Dallas ruled that on the identical card family on 2026-09-24 ("beside the name it was ellipsised on nearly every card"), after the Proposals screen was drawn; the 10/14 refresh did not redraw it. The same ruling set the family's rail at 44px with a 7px right inset and an 8px card gap (the artifact draws 46/10/12), so those metrics are inherited, not new. Cost if wrong: one line more per card.
2. **`envelope=1` is opt-in.** Without it the route answers the bare array and `X-Total-Count` exactly as today. With it: `{ rows, total, bucket_total, unviewed_total, page, limit, has_more }`.
3. **The chip count is the bucket's count**, whether or not the chip is on: `unviewed_total` is computed over the bucket without the Unviewed predicate. `bucket_total` is the bucket's size without the predicate too, so the "Everything opened" state can tell an empty filter from an empty bucket.
4. **Orders:** Newest lead = `sort=created_at&dir=desc` (the route's own fallback, made addressable). Event date = `sort=event_date&dir=asc`, soonest first, blank dates last (the route's `NULLS LAST`).
5. **Paging is uniform:** 50 per page in both orders and under the chip. The artifact's mock shows all unviewed rows at once because its set is five long; a 51st unviewed proposal still needs Show more.
6. **A card opens `/proposals/:id`**, which today renders the desktop proposal page inside the phone chrome under the header title "Proposal". That is the same interim ma-e1 shipped for events before ma-e2; lane ma-f2 replaces it. Cost if wrong: none the phone did not already have.
7. **Accepted meta:** `accepted · awaiting deposit` when nothing is paid; `accepted · $X paid` when `amount_paid` is positive (the bucket excludes `deposit_paid`, so this is the rare accepted-with-a-partial-payment row). The list card carries no accepted time, as the artifact draws it (`accepted · awaiting deposit`); the detail's status line reads `accepted_at` and belongs to ma-f2.
8. **No event date:** the rail shows an en dash in the day slot, with a visually hidden "no date"; under Event date the row sorts last.
9. **The end divider hides under the chip** (as Events hides it under Needs staff): "End of active" would misdescribe a filtered list.
10. **Relative times are hours-grained** (`5h ago`, `2d ago`) as the artifact writes them, from a pure `agoLabel(ts, now)`; the desktop's day-grained `relDayTs` is not reused because the artifact's copy is finer.
11. **A live list shows no staleness line.** The artifact always draws `.m-stale`; Dallas ruled on 2026-09-30 (Events list) that only an offline copy says how old it is. Cost if wrong: one line of chrome.
12. **The end divider is singular at one:** `End of active · 1 proposal`. The artifact's mock is always plural because its set is six long. Cost if wrong: one letter.
13. **Desktop query keys are ignored at phone width.** A `/proposals?cohort=won` or `?tab=draft` link opened on the phone renders the phone list (the Active bucket, the phone's own `order` and `unviewed` keys); the desktop keys pass through the URL untouched (`useUrlListState` only reads declared keys), so Desktop view still honors them. Same as the Events fork. Cost if wrong: a drill-out from the Overview lands on the bucket, not the cohort, until the user escapes to Desktop view.

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. Commas, colons, parentheses, the middle dot. (An en dash in the empty rail slot is a glyph, not prose.)
- **One fork, one breakpoint:** the phone branch comes from `useMobileView()` only. No new media queries; every new rule lives in the mobile block of `index.css`, scoped `html[data-app="admin-os"]`.
- **Legacy list shape is frozen:** `GET /api/proposals` without `envelope=1` returns the same bare array, the same columns, the same order and the same `X-Total-Count` header it returns today. A test pins it.
- **The Unviewed predicate is server-side and exactly** `p.last_viewed_at IS NULL AND p.status = 'sent'` (spec section 5; `modified` implies viewed). It adds no SQL parameters.
- **The bucket is the route's default `view=active`.** The phone sends no `view`.
- **Chips come from one source:** `proposalStatusMeta` in `utils/proposalStatusMap.js`. No hand-copied status map on the phone.
- **Copy from the benchmark, verbatim:** "Newest lead", "Event date", "Unviewed", "first sync · fetching proposals", "Show more", "N of M", "End of active · N proposals" (singular "proposal" at one), "Everything opened" / "No sent proposal is waiting to be seen.", "No active proposals" / "Drafts and sent quotes land here. Booked ones move to Events.", "GUESTS", "offline copy · as of". The page error reads "Couldn't load proposals"; the append error "Couldn't load more."
- **Staleness line, one state shown:** only a cache-served list (`res.staleAt` present) shows `offline copy · as of <time>` with the amber dot; a live list shows nothing (Dallas, 2026-09-30, as the Events list does).
- **Writes: none in this lane.** Reads degrade per spec section 7.
- **44px minimum tap targets;** the whole card is the target; the apparatus row is the sticky `.m-listbar`.
- **Server tests:** `node --test <file>` one suite at a time from the repo root; `require('dotenv').config()` on the first line; a `NODE_ENV !== 'production'` guard; nonce-tagged fixtures; every fixture row deleted in `after`; read the pass count.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`; no `act()` warnings in the suites this lane adds or touches.
- **File sizes:** `list.js` stays under 260 lines; `ProposalsListPhone.js` under 320; `proposalCards.js` under 120.
- **Explicit staging only;** commit messages carry NO backticks (bash runs them); `git commit -F - <<'MSG'` heredocs with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Docs law (CLAUDE.md):** README folder tree, ARCHITECTURE route table and the phone surfaces list, walkthroughs-owed (the Pixel walk), `scripts/sensitive-paths.txt` (the new page), the capture manifest, the fix list's amendment, all in the lane; the board line at lane close through `scripts/board-write.sh`.
- **Never `npm install` in the lane** (the symlinked `node_modules` would be clobbered); nothing in this plan needs a package.

## Review Focus

1. **A proposal with no event date** under the Event date order: it sorts last, its card renders with the dash rail and no crash. Pinned in Task 1 (fixture D), Task 2 (`proposalCard` with `event_date: null`) and Task 4 (a null-date row renders).
2. **A superseded response:** switching the order while page 1 is still in flight must never paint the old order's rows under the new toggle. Pinned in Task 4 (the first promise resolves after the second; the screen shows the second's rows).
3. **Show more under the chip:** with `has_more` true and the chip on, Show more is offered and appends. Pinned in Task 4.
4. **Legacy consumers keep the array:** no `envelope`, no `unviewed`, no new sort key = byte-identical behavior, and the desktop keeps paging. Pinned in Task 1 (test 1), Task 6 (P4) and Task 8 Step 3 (desktop regression by eye).
5. **The chip count does not move when the chip turns on:** `unviewed_total` is independent of the predicate; the chip shows no number until the first envelope lands. Pinned in Task 1 (test 3) and Task 4 (the chip reads the same count before and after the tap).

---

## Lane map

```yaml
lanes:
  - id: ma-f1-proposals-list
    plan: docs/superpowers/plans/2026-10-14-mobile-admin-proposals-list.md
    scope: >
      Phone Proposals list (Active bucket, Newest lead / Event date order with
      the created_at sort key added to the whitelist, server-side Unviewed
      predicate, the envelope mode, cards, paging, states) reusing the ma-e1
      card family and the fork pattern.
    footprint:
      - server/routes/proposals/list.js
      - server/routes/proposals/list.sort.test.js
      - server/routes/proposals/list.phone.test.js
      - client/src/utils/proposalCards.js
      - client/src/utils/proposalCards.test.js
      - client/src/pages/mobile/ProposalsListPhone.js
      - client/src/pages/mobile/ProposalsListPhone.test.js
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/ProposalsDashboard.fork.test.js
      - client/src/index.css
      - client/src/utils/mobileClassContract.test.js
      - scripts/mobile-capture.manifest.json
      - scripts/sensitive-paths.txt
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
    depends_on: [ma-e1-events-list]
    review_fleet: [code-review, consistency-check, ui-ux-review]
```

Cut: from `os` on `main`, `npm run worktree:new -- ma-f1-proposals-list`, then work only in `../worktrees/ma-f1-proposals-list`. The ledger lives at `.superpowers/sdd/2026-10-14-mobile-admin-proposals-list/progress.md` in the lane (git-ignored).

## File structure

- `server/routes/proposals/list.js` (modify): the `created_at` sort key, the `unviewed=1` predicate, the `envelope=1` body. Nothing else moves.
- `server/routes/proposals/list.sort.test.js` (modify): one test for the new key, the comment.
- `server/routes/proposals/list.phone.test.js` (create): the phone contract, legacy shape pinned.
- `client/src/utils/proposalCards.js` (create): `ymdOf`, `agoLabel`, `proposalMeta`, `proposalCard`. Pure.
- `client/src/pages/mobile/ProposalsListPhone.js` (create): the page and its `ProposalCard`.
- `client/src/pages/admin/ProposalsDashboard.js` (modify): rename the component to `ProposalsDashboardDesktop`, add the forking default export.
- `client/src/index.css` (modify): `.m-card-total`, `.m-chip-end`.
- Tests, manifest, docs as in the footprint.

---

### Task 1: `GET /api/proposals` phone mode: the `created_at` key, `unviewed=1`, `envelope=1`

**Files:**
- Modify: `server/routes/proposals/list.js:27-41` (the sort map and its comment), `:47-48` (the destructure), `:146-161` (the predicate, before the ORDER BY), `:182-194` (the response)
- Modify: `server/routes/proposals/list.sort.test.js` (one new test)
- Create: `server/routes/proposals/list.phone.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/proposals?envelope=1&sort=created_at|event_date&dir=desc|asc&limit=50&page=N[&unviewed=1]` answering `{ rows: Row[], total: number, bucket_total: number, unviewed_total: number, page: number, limit: number, has_more: boolean }` where `Row` is the route's existing projection (`id, status, total_price, amount_paid, sent_at, accepted_at, last_viewed_at, view_count, created_at, updated_at, event_date, event_type, event_type_custom, guest_count, client_name, ...`). `total` is the count of the request's own set (the predicate applied when `unviewed=1`); `bucket_total` and `unviewed_total` describe the bucket without the predicate. Task 4 reads exactly these names.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/proposals/list.phone.test.js`:

```js
// Route-level tests for the phone mode of GET /api/proposals (lane ma-f1,
// spec 2026-08-13-mobile-admin section 5): the created_at sort key, the
// server-side ?unviewed=1 predicate and the ?envelope=1 body. The first test
// pins the LEGACY shape (bare array + X-Total-Count) so the desktop keeps
// working untouched.
//
// Harness mirrors list.sort.test.js: a minimal express() app mounting the real
// list router, driven over node http against the dev DB, fixtures tagged by a
// random TAG and scoped with ?search=<TAG>, every row purged in after().
//
// Fixtures (insert order A..F, so created_at ascends A -> F):
//   A draft,        event 2026-06-01, never sent
//   B sent,         event 2026-03-01, last_viewed_at NULL   (unviewed)
//   C viewed,       event 2026-01-01, last_viewed_at set, 3 views
//   D sent,         event NULL,       last_viewed_at NULL   (unviewed, no date)
//   E deposit_paid  (NOT in the active bucket)
//   F archived      (NOT in the active bucket)

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run route tests against production');

const { pool } = require('../../db');
const listRouter = require('./list');

let server;
let baseUrl;
let token;
const TAG = `PHONELIST-${crypto.randomBytes(5).toString('hex')}`;
const ids = {};
const createdProposalIds = [];
const createdClientIds = [];

function request(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seed(label, { status, eventDate, lastViewedAt = null, viewCount = 0, sentAt = null }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`${TAG} Client ${label}`, `${TAG.toLowerCase()}+${label}@example.test`]
  );
  createdClientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, event_date, event_type, last_viewed_at, view_count, sent_at)
     VALUES ($1, $2, 1000, $3, 'phone-list-test', $4, $5, $6) RETURNING id`,
    [c.rows[0].id, status, eventDate, lastViewedAt, viewCount, sentAt]
  );
  createdProposalIds.push(p.rows[0].id);
  ids[label] = p.rows[0].id;
  return p.rows[0].id;
}

before(async () => {
  const users = await pool.query(
    `SELECT id, COALESCE(token_version, 0) AS token_version FROM users WHERE role IN ('admin', 'manager') ORDER BY id LIMIT 1`
  );
  assert.ok(users.rows[0], 'test harness needs an admin/manager user in the dev DB');
  token = jwt.sign({ userId: users.rows[0].id, tokenVersion: users.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const now = new Date().toISOString();
  await seed('A', { status: 'draft', eventDate: '2026-06-01' });
  await seed('B', { status: 'sent', eventDate: '2026-03-01', sentAt: now });
  await seed('C', { status: 'viewed', eventDate: '2026-01-01', lastViewedAt: now, viewCount: 3, sentAt: now });
  await seed('D', { status: 'sent', eventDate: null, sentAt: now });
  await seed('E', { status: 'deposit_paid', eventDate: '2026-02-01', sentAt: now });
  await seed('F', { status: 'archived', eventDate: '2026-02-02', sentAt: now });

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', listRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (createdProposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [createdProposalIds]);
  if (createdClientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const idsOf = (rows) => rows.map((r) => r.id);

test('legacy shape is untouched: no envelope = bare array, X-Total-Count, created_at DESC, active bucket', async () => {
  const res = await request(`/api/proposals?search=${TAG}`);
  assert.equal(res.status, 200, res.raw);
  assert.ok(Array.isArray(res.body), 'body must stay a bare array');
  assert.equal(res.headers['x-total-count'], '4');
  assert.deepEqual(idsOf(res.body), [ids.D, ids.C, ids.B, ids.A], 'active bucket, newest insert first; E and F excluded');
  assert.equal(res.headers['access-control-expose-headers'], 'X-Total-Count');
});

test('?envelope=1 answers the phone body with the bucket totals', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1`);
  assert.equal(res.status, 200, res.raw);
  assert.ok(!Array.isArray(res.body), 'envelope is an object');
  assert.deepEqual(idsOf(res.body.rows), [ids.D, ids.C, ids.B, ids.A]);
  assert.deepEqual(
    { total: res.body.total, bucket_total: res.body.bucket_total, unviewed_total: res.body.unviewed_total, page: res.body.page, limit: res.body.limit, has_more: res.body.has_more },
    { total: 4, bucket_total: 4, unviewed_total: 2, page: 1, limit: 50, has_more: false }
  );
  assert.equal(res.headers['x-total-count'], '4', 'the header still rides the envelope');
});

test('?unviewed=1 keeps only sent-and-never-opened rows; the bucket totals do not move', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1&unviewed=1`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(idsOf(res.body.rows), [ids.D, ids.B], 'C is viewed, A is a draft');
  assert.equal(res.body.total, 2);
  assert.equal(res.body.bucket_total, 4, 'bucket_total ignores the predicate');
  assert.equal(res.body.unviewed_total, 2);
  const bare = await request(`/api/proposals?search=${TAG}&unviewed=1`);
  assert.ok(Array.isArray(bare.body), 'the predicate works on the bare shape too');
  assert.deepEqual(idsOf(bare.body), [ids.D, ids.B]);
  assert.equal(bare.headers['x-total-count'], '2');
});

test('?sort=created_at is the fallback order made addressable, in both directions', async () => {
  const desc = await request(`/api/proposals?search=${TAG}&sort=created_at&dir=desc`);
  assert.deepEqual(idsOf(desc.body), [ids.D, ids.C, ids.B, ids.A]);
  const asc = await request(`/api/proposals?search=${TAG}&sort=created_at&dir=asc`);
  assert.deepEqual(idsOf(asc.body), [ids.A, ids.B, ids.C, ids.D]);
});

test('Event date order: soonest first, a blank date last', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1&sort=event_date&dir=asc`);
  assert.deepEqual(idsOf(res.body.rows), [ids.C, ids.B, ids.A, ids.D], 'D has no event_date and sorts last');
});

test('paging: has_more follows page * limit against total', async () => {
  const p1 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=1`);
  assert.deepEqual(idsOf(p1.body.rows), [ids.D, ids.C]);
  assert.deepEqual({ has_more: p1.body.has_more, page: p1.body.page, limit: p1.body.limit, total: p1.body.total }, { has_more: true, page: 1, limit: 2, total: 4 });
  const p2 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=2`);
  assert.deepEqual(idsOf(p2.body.rows), [ids.B, ids.A]);
  assert.equal(p2.body.has_more, false);
  const p3 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=3`);
  assert.deepEqual(p3.body.rows, []);
  assert.equal(p3.body.has_more, false);
});

test('an envelope with an empty bucket reports zeros, not nulls', async () => {
  const res = await request(`/api/proposals?search=${TAG}-nothing-matches&envelope=1`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body, { rows: [], total: 0, bucket_total: 0, unviewed_total: 0, page: 1, limit: 50, has_more: false });
});
```

In `server/routes/proposals/list.sort.test.js`, add the production guard the Global Constraints require, right after the `jwt` require: `if (process.env.NODE_ENV === 'production') throw new Error('refusing to run route tests against production');`. Then append after the last test:

```js
test('?sort=created_at (phone "Newest lead") is in the whitelist and behaves like the fallback', async () => {
  const desc = await request(`/api/proposals?search=${TAG}&sort=created_at`);
  assert.equal(desc.status, 200, `expected 200, got ${desc.status}: ${desc.raw}`);
  assert.deepEqual(desc.body.map((r) => r.id), [D, C, B, A], 'created_at defaults to DESC like every key');
  const asc = await request(`/api/proposals?search=${TAG}&sort=created_at&dir=asc`);
  assert.deepEqual(asc.body.map((r) => r.id), [A, B, C, D]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/routes/proposals/list.phone.test.js`
Expected: 1 pass, 6 fail. Only the legacy test passes. The envelope test fails on 'envelope is an object'; the unviewed, Event date and paging tests fail with `TypeError: Cannot read properties of undefined (reading 'map')` at `idsOf(res.body.rows)` (the body is still an array); the empty-bucket test fails its deepEqual (array versus object); `sort=created_at` fails on the asc assertion (the unknown key falls back to DESC, so asc sees D,C,B,A). The plan fleet proved this count against the unmodified route on 2026-10-14.

Run: `node --test server/routes/proposals/list.sort.test.js`
Expected: the new test fails on the asc assertion; the five existing tests pass.

- [ ] **Step 3: Implement**

In `server/routes/proposals/list.js`, replace the comment and map at `:27-41` with:

```js
// Whitelisted sort columns for the admin list. A client's ?sort= value is a KEY
// here and nothing else: each maps to a fixed SQL expression, so no user text
// reaches SQL (same contract as axis/cohort above). ?dir is asc|desc (default
// desc). An unknown/absent ?sort falls back to created_at DESC. The keys mirror
// ProposalsDashboard's SortableTh sortKeys exactly, plus `created_at`: the phone
// list's "Newest lead" order (lane ma-f1) names the fallback explicitly so it
// can sit beside event_date in one apparatus. Desktop columns are unchanged.
const SORT_COLUMNS = {
  client: 'LOWER(c.name)',
  event: "LOWER(COALESCE(NULLIF(TRIM(p.event_type_custom), ''), p.event_type, ''))",
  event_date: 'p.event_date',
  package: 'LOWER(sp.name)',
  status: 'p.status',
  sent: 'p.sent_at',
  last_viewed: 'p.last_viewed_at',
  total: 'p.total_price',
  created_at: 'p.created_at',
};
```

(The comment's own em dash becomes a colon while it is being rewritten; the plan's law applies to the whole comment.)

Change the destructure at `:47-48` to:

```js
  const { status, view = 'active', search, source, page = 1, limit = 50,
    axis, event_type: eventType, balance, cohort, from, to, sort, dir,
    unviewed, envelope } = req.query;
```

Insert, right before the `// Whitelisted ORDER BY.` comment block (after the `balance === 'open'` branch):

```js
  // (6) Phone apparatus (spec 2026-08-13-mobile-admin section 5, lane ma-f1).
  // ?unviewed=1 keeps the sent proposals the client has never opened. It is a
  // server-side predicate on purpose: a client-side filter over one 50-row page
  // would return a wrong subset. `modified` implies viewed, so status = 'sent'
  // is the whole test, and it adds no parameters. `bucketWhere` is the same set
  // WITHOUT the predicate, so the envelope's bucket_total and unviewed_total
  // describe the bucket whether or not the chip is on.
  const UNVIEWED_SQL = " AND p.last_viewed_at IS NULL AND p.status = 'sent'";
  const bucketWhere = whereClause;
  if (unviewed === '1') whereClause += UNVIEWED_SQL;
```

Replace the block from `// Data + total run in parallel` through `res.json(result.rows);` with:

```js
  // Data + total run in parallel; COUNT(*) reuses the identical FROM/WHERE and
  // whereParams (no LIMIT/OFFSET) so the count matches the full filtered set.
  // The envelope's two bucket counts reuse bucketWhere with the same params.
  const wantEnvelope = envelope === '1';
  const [result, countResult, bucketResult, unviewedResult] = await Promise.all([
    pool.query(query, params),
    pool.query(`SELECT COUNT(*) ${fromWhere}${whereClause}`, whereParams),
    wantEnvelope ? pool.query(`SELECT COUNT(*) ${fromWhere}${bucketWhere}`, whereParams) : null,
    wantEnvelope ? pool.query(`SELECT COUNT(*) ${fromWhere}${bucketWhere}${UNVIEWED_SQL}`, whereParams) : null,
  ]);
  const total = Number(countResult.rows[0]?.count) || 0;
  // Non-breaking pagination signal: total in a header, body stays a bare array
  // so existing consumers are unaffected. CORS sets no global
  // Access-Control-Expose-Headers, so expose this header per-route.
  res.set('X-Total-Count', String(total));
  res.set('Access-Control-Expose-Headers', 'X-Total-Count');
  if (!wantEnvelope) return res.json(result.rows);
  // ?envelope=1 (the phone list, lane ma-f1) answers an object: the service
  // worker's stored copy is read by body, so the phone's totals travel in the
  // body, never in the header. Nothing that does not send it sees a change.
  res.json({
    rows: result.rows,
    total,
    bucket_total: Number(bucketResult.rows[0]?.count) || 0,
    unviewed_total: Number(unviewedResult.rows[0]?.count) || 0,
    page: pg,
    limit: lim,
    has_more: pg * lim < total,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/routes/proposals/list.phone.test.js`
Expected: 7 pass, 0 fail.
Run: `node --test server/routes/proposals/list.sort.test.js`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Run the suites this change reaches, one at a time**

`node --test server/routes/proposals/crud.filters.test.js` (the one other suite that imports `./list`; `crud.test.js` only POSTs, and the eight suites mounting `./index` never GET the list). Expected: its count unchanged from main (quote it). Then confirm no fixture rows remain: `SELECT count(*) FROM proposals WHERE event_type = 'phone-list-test'` is 0 and `SELECT count(*) FROM clients WHERE name LIKE 'PHONELIST-%'` is 0 (a `node -e` with the pool, or the Neon MCP against the dev branch).

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/list.js server/routes/proposals/list.sort.test.js server/routes/proposals/list.phone.test.js && git commit -F - <<'MSG'
feat(proposals): the list's phone mode: created_at sort key, server-side unviewed predicate, envelope body

The bare array and X-Total-Count stay exactly as they were for every
existing consumer. envelope=1 answers rows plus the bucket totals the
phone's Unviewed chip and empty states read; unviewed=1 is the spec's
predicate, last_viewed_at IS NULL AND status = 'sent', applied in SQL.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 7: Checkpoint review before any client task builds on the envelope**

Task review of this diff (spec compliance against section 5's feed grounding; the legacy shape pinned; parameters never interpolated). The envelope field names are the contract Task 4 consumes; a rename after this point is a plan amendment.

---

### Task 2: Pure card model: a list row into what the card shows

**Files:**
- Create: `client/src/utils/proposalCards.js`
- Test: `client/src/utils/proposalCards.test.js`

**Interfaces:**
- Consumes: `railParts(ymd)` from `./eventCards`; `getEventTypeLabel` from `./eventTypes`; `fmt$` from `../components/adminos/format`; `proposalStatusMeta` from `./proposalStatusMap`.
- Produces: `ymdOf(value) -> 'YYYY-MM-DD' | null`; `agoLabel(ts, now = new Date()) -> string` (`'just now'`, `'12m ago'`, `'5h ago'`, `'2d ago'`, `''` for no input); `proposalMeta(row, now) -> string`; `proposalCard(row, now) -> { key, id, ymd, rail: { dow, day, mon }, noDate: boolean, clientName, kind, guests: number | null, meta, total: string, chipLabel, chipKind }`. Task 4 renders exactly this shape.

- [ ] **Step 1: Write the failing tests**

Create `client/src/utils/proposalCards.test.js`:

```js
import { ymdOf, agoLabel, proposalMeta, proposalCard } from './proposalCards';

const NOW = new Date('2026-10-14T18:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

const row = (over = {}) => ({
  id: 7, status: 'sent', client_name: 'Ferreira', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-10-03T05:00:00.000Z', guest_count: 150, total_price: '5240.00', amount_paid: '0',
  sent_at: hoursAgo(48), last_viewed_at: null, view_count: 0, accepted_at: null,
  created_at: hoursAgo(50), updated_at: hoursAgo(48), ...over,
});

describe('ymdOf', () => {
  test('takes the date part of a timestamp or a plain date, null otherwise', () => {
    expect(ymdOf('2026-10-03T05:00:00.000Z')).toBe('2026-10-03');
    expect(ymdOf('2026-10-03')).toBe('2026-10-03');
    expect(ymdOf(null)).toBeNull();
    expect(ymdOf('')).toBeNull();
    expect(ymdOf('nonsense')).toBeNull();
  });
});

describe('agoLabel', () => {
  test('hours-grained as the benchmark writes it', () => {
    expect(agoLabel(hoursAgo(0.005), NOW)).toBe('just now');
    expect(agoLabel(hoursAgo(0.2), NOW)).toBe('12m ago');
    expect(agoLabel(hoursAgo(5), NOW)).toBe('5h ago');
    expect(agoLabel(hoursAgo(18), NOW)).toBe('18h ago');
    expect(agoLabel(hoursAgo(36), NOW)).toBe('1d ago');
    expect(agoLabel(hoursAgo(72), NOW)).toBe('3d ago');
  });
  test('empty for nothing and for garbage; a future stamp reads just now', () => {
    expect(agoLabel(null, NOW)).toBe('');
    expect(agoLabel('not a date', NOW)).toBe('');
    expect(agoLabel(new Date(NOW.getTime() + 60000).toISOString(), NOW)).toBe('just now');
  });
});

describe('proposalMeta', () => {
  test('draft: created ago', () => {
    expect(proposalMeta(row({ status: 'draft', created_at: hoursAgo(72), sent_at: null }), NOW)).toBe('draft · created 3d ago');
  });
  test('sent and never opened', () => {
    expect(proposalMeta(row(), NOW)).toBe('sent 2d ago · not opened');
    expect(proposalMeta(row({ sent_at: null }), NOW)).toBe('sent · not opened');
  });
  test('viewed: last view and the count, singular at one', () => {
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: hoursAgo(5), view_count: 3 }), NOW)).toBe('viewed 5h ago · 3 views');
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: hoursAgo(1), view_count: 1 }), NOW)).toBe('viewed 1h ago · 1 view');
    expect(proposalMeta(row({ status: 'viewed', last_viewed_at: null, view_count: 0 }), NOW)).toBe('viewed');
  });
  test('modified by the client', () => {
    expect(proposalMeta(row({ status: 'modified', updated_at: hoursAgo(24) }), NOW)).toBe('modified by client 1d ago');
  });
  test('accepted: awaiting deposit, or the amount paid', () => {
    expect(proposalMeta(row({ status: 'accepted', amount_paid: '0' }), NOW)).toBe('accepted · awaiting deposit');
    expect(proposalMeta(row({ status: 'accepted', amount_paid: '500' }), NOW)).toBe('accepted · $500 paid');
  });
  test('any other status reads its label and the last change', () => {
    expect(proposalMeta(row({ status: 'declined', updated_at: hoursAgo(6) }), NOW)).toBe('declined · 6h ago');
  });
});

describe('proposalCard', () => {
  test('the benchmark facts', () => {
    const card = proposalCard(row(), NOW);
    expect(card).toEqual(expect.objectContaining({
      key: 'p7', id: 7, ymd: '2026-10-03', noDate: false,
      rail: { dow: 'SAT', day: '03', mon: 'OCT' },
      clientName: 'Ferreira', kind: 'Wedding Reception', guests: 150,
      meta: 'sent 2d ago · not opened', total: '$5,240',
      chipLabel: 'Sent', chipKind: 'info',
    }));
  });
  test('chips come from the shared status map', () => {
    expect(proposalCard(row({ status: 'draft' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Draft', chipKind: 'neutral' }));
    expect(proposalCard(row({ status: 'viewed' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Viewed', chipKind: 'accent' }));
    expect(proposalCard(row({ status: 'modified' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Modified', chipKind: 'violet' }));
    expect(proposalCard(row({ status: 'accepted' }), NOW)).toEqual(expect.objectContaining({ chipLabel: 'Accepted', chipKind: 'ok' }));
  });
  test('no event date: a dash rail and the flag; a custom type wins; blanks hide', () => {
    const card = proposalCard(row({ event_date: null, event_type_custom: 'Retirement roast', guest_count: null, total_price: null, client_name: null }), NOW);
    expect(card.rail).toEqual({ dow: '', day: '–', mon: '' });
    expect(card.noDate).toBe(true);
    expect(card.kind).toBe('Retirement roast');
    expect(card.guests).toBeNull();
    expect(card.total).toBe('');
    expect(card.clientName).toBe('Unnamed client');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/proposalCards.test.js`
Expected: FAIL, "Cannot find module './proposalCards'".

- [ ] **Step 3: Write the module**

Create `client/src/utils/proposalCards.js`:

```js
// Turns one GET /proposals row into what the phone Proposals card shows
// (spec 2026-08-13-mobile-admin section 5; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Proposals tab).
// Pure: no React, no fetch, no clock unless the caller passes one. Lane ma-f1.
import { railParts } from './eventCards';
import { getEventTypeLabel } from './eventTypes';
import { fmt$ } from '../components/adminos/format';
import { proposalStatusMeta } from './proposalStatusMap';

// event_date is a DATE column; pg hands it over as a timestamp at the server's
// midnight, so the calendar day is the first ten characters (the desktop list
// slices the same way at ProposalsDashboard.js:519).
export function ymdOf(value) {
  const s = value == null ? '' : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// Hours-grained relative time, the way the benchmark writes its meta lines
// ("viewed 5h ago", "sent 2d ago"). Days are whole 24-hour spans, not calendar
// days: the line answers "how long has this sat", not "which day".
export function agoLabel(ts, now = new Date()) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const dot = (parts) => parts.filter(Boolean).join(' · ');

// One line per pipeline stage, from the real timestamps (sent_at, last_viewed_at
// plus view_count, updated_at, created_at). The list card carries no accepted
// time, as the benchmark draws it; the detail's status line (lane ma-f2) reads
// accepted_at. No expiry exists on a proposal, so nothing "expiring" is shown.
export function proposalMeta(row, now = new Date()) {
  const ago = (ts) => agoLabel(ts, now);
  const views = Number(row.view_count || 0);
  switch (row.status) {
    case 'draft':
      return dot(['draft', row.created_at ? `created ${ago(row.created_at)}` : '']);
    case 'sent':
      return dot([row.sent_at ? `sent ${ago(row.sent_at)}` : 'sent', 'not opened']);
    case 'viewed':
      return dot([
        row.last_viewed_at ? `viewed ${ago(row.last_viewed_at)}` : 'viewed',
        views > 0 ? `${views} ${views === 1 ? 'view' : 'views'}` : '',
      ]);
    case 'modified':
      return row.updated_at ? `modified by client ${ago(row.updated_at)}` : 'modified by client';
    case 'accepted': {
      const paid = Number(row.amount_paid || 0);
      return paid > 0 ? `accepted · ${fmt$(paid)} paid` : 'accepted · awaiting deposit';
    }
    default: {
      const { label } = proposalStatusMeta(row.status);
      return dot([String(label).toLowerCase(), row.updated_at ? ago(row.updated_at) : '']);
    }
  }
}

export function proposalCard(row, now = new Date()) {
  const ymd = ymdOf(row.event_date);
  const { label: chipLabel, kind: chipKind } = proposalStatusMeta(row.status);
  return {
    key: `p${row.id}`,
    id: row.id,
    ymd,
    noDate: !ymd,
    rail: ymd ? railParts(ymd) : { dow: '', day: '–', mon: '' },
    // The name comes from the client row the proposal points at, never derived.
    clientName: row.client_name || 'Unnamed client',
    kind: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
    guests: row.guest_count == null ? null : Number(row.guest_count),
    meta: proposalMeta(row, now),
    total: row.total_price == null ? '' : fmt$(row.total_price),
    chipLabel,
    chipKind,
  };
}
```

(The `modified` line carries no middle dot: the benchmark writes `modified by client 1d ago`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/proposalCards.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/proposalCards.js client/src/utils/proposalCards.test.js && git commit -F - <<'MSG'
feat(mobile): the proposals card model: rail, kind, meta line per stage, total, chip from the shared map

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Two card rules in the mobile CSS, and the class contract (no commit of its own: verified and committed inside Task 4)

**Files:**
- Modify: `client/src/index.css` (the mobile block, right after the `.m-frac.past` rule at `:21568`)
- Modify: `client/src/utils/mobileClassContract.test.js` (`SOURCES`)

- [ ] **Step 1: Add the page to the class contract (the failing test)**

In `client/src/utils/mobileClassContract.test.js`, add `'pages/mobile/ProposalsListPhone.js',` to `SOURCES` after the `'pages/mobile/NotificationsPhone.js',` line. (The test reads the file; until Task 4 creates it the suite fails with ENOENT, which is the failing state. Task 4's commit is where this test goes green; run it there.) Do NOT add `EventsListPhone.js`: its `m-events-scroll` storage key would read as a missing class; that is a contract change for another day.

- [ ] **Step 2: Add the rules**

After `html[data-app="admin-os"] .m-frac.past { ... }` (`:21568`) insert:

```css
/* Proposals list card (lane ma-f1, benchmark Proposals tab): the total sits at
   the foot's left in the numeric face, the pipeline chip at the right edge. */
html[data-app="admin-os"] .m-card-total { font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-2); }
html[data-app="admin-os"] .m-chip-end { margin-left: auto; display: inline-flex; }
```

- [ ] **Step 3: Commit (with Task 4)**

These two files are staged and committed with Task 4's page, so the class contract is green in the same commit.

---

### Task 4: `ProposalsListPhone`

**Files:**
- Create: `client/src/pages/mobile/ProposalsListPhone.js`
- Test: `client/src/pages/mobile/ProposalsListPhone.test.js`
- Commit with: the Task 3 files

**Interfaces:**
- Consumes: `offlineGet` (`../../utils/offlineRead`), `useUrlListState` (`../../hooks/useUrlListState`), `proposalCard` (`../../utils/proposalCards`), `formatStaleTime` (`../../utils/staleTime`), `StatusChip` and `Icon` (`../../components/adminos/`), the Task 1 envelope.
- Produces: `export default function ProposalsListPhone()`; URL keys `order` (`lead` default, `date`) and `unviewed` (`'1'` or absent); sessionStorage keys `proposals-scroll:<order>:<0|1>` (no `m-` prefix: the class contract treats every `m-*` token in a phone source as a CSS class, which is also why `EventsListPhone.js` with its `m-events-scroll` key is absent from that contract's `SOURCES`).

- [ ] **Step 1: Write the failing tests**

Create `client/src/pages/mobile/ProposalsListPhone.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProposalsListPhone from './ProposalsListPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const H = { headers: { 'X-Offline-Ok': '1' } };
const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (over = {}) => ({
  id: 7, status: 'sent', client_name: 'Ferreira', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-10-03T05:00:00.000Z', guest_count: 150, total_price: '5240.00', amount_paid: '0',
  sent_at: hoursAgo(48), last_viewed_at: null, view_count: 0, created_at: hoursAgo(50), updated_at: hoursAgo(48), ...over,
});
const env = (rows, over = {}) => ({
  data: { rows, total: rows.length, bucket_total: rows.length, unviewed_total: rows.filter((r) => r.status === 'sent' && !r.last_viewed_at).length, page: 1, limit: 50, has_more: false, ...over },
});
const base = { envelope: 1, limit: 50, page: 1, sort: 'created_at', dir: 'desc' };

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
function mount(initial = '/proposals') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <div id="main-content">
        <Routes>
          <Route path="/proposals" element={<><ProposalsListPhone /><LocationProbe /></>} />
          <Route path="/proposals/:id" element={<div data-testid="detail">detail</div>} />
        </Routes>
      </div>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); window.sessionStorage.clear(); });

test('fetches the envelope newest-lead first and renders the benchmark card', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 8, status: 'viewed', client_name: 'Whitfield', event_type: 'corporate-event', last_viewed_at: hoursAgo(5), view_count: 3, guest_count: 120, total_price: '4270' })]));
  mount();
  expect(await screen.findByText('Ferreira')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/proposals', { params: base, ...H });
  const card = screen.getByRole('button', { name: /Ferreira/ });
  expect(within(card).getByText('Wedding Reception')).toHaveClass('m-card-kind');
  expect(within(card).getByText(/150/)).toHaveClass('m-card-guests');
  expect(within(card).getByText('sent 2d ago · not opened')).toHaveClass('m-card-meta');
  expect(within(card).getByText('$5,240')).toHaveClass('m-card-total');
  expect(within(card).getByText('Sent').closest('.chip')).toHaveClass('info');
  expect(within(card).getByText('03')).toHaveClass('m-rail-day');
  const second = screen.getByRole('button', { name: /Whitfield/ });
  expect(within(second).getByText('viewed 5h ago · 3 views')).toBeInTheDocument();
  expect(within(second).getByText('Viewed').closest('.chip')).toHaveClass('accent');
  expect(screen.getByText('End of active · 2 proposals')).toBeInTheDocument();
  expect(screen.queryByText(/offline copy/)).toBeNull();
});

test('Event date writes ?order=date and refetches soonest first; the URL replaces, never pushes', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  await screen.findByText('Ferreira');
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, sort: 'event_date', dir: 'asc' }, ...H }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/proposals?order=date');
  await screen.findByText('Ferreira');
  expect(screen.getByRole('radio', { name: 'Event date' })).toHaveAttribute('aria-checked', 'true');
});

test('the Unviewed chip shows the bucket count only once the envelope lands, filters server-side, keeps its count, hides the end divider', async () => {
  let resolve;
  api.get.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  mount();
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent(/^Unviewed$/);
  api.get.mockResolvedValue(env([row()], { total: 1, bucket_total: 3, unviewed_total: 1 }));
  await act(async () => { resolve(env([row(), row({ id: 9, status: 'draft' }), row({ id: 10, status: 'viewed', last_viewed_at: hoursAgo(1), view_count: 1 })], { unviewed_total: 1 })); });
  await screen.findByText('Ferreira');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('button', { name: /Unviewed/ }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, unviewed: 1 }, ...H }));
  expect(screen.getByTestId('loc')).toHaveTextContent('/proposals?unviewed=1');
  await screen.findByText('Ferreira');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: /Unviewed/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText(/End of active/)).toBeNull();
});

test('empty states: Everything opened under the chip with a non-empty bucket; No active proposals otherwise', async () => {
  api.get.mockResolvedValue(env([], { total: 0, bucket_total: 4, unviewed_total: 0 }));
  mount('/proposals?unviewed=1');
  expect(await screen.findByText('Everything opened')).toBeInTheDocument();
  expect(screen.getByText('No sent proposal is waiting to be seen.')).toBeInTheDocument();
  expect(screen.getByText('Everything opened').closest('.m-empty')).toHaveClass('ok');
});

test('an empty bucket', async () => {
  api.get.mockResolvedValue(env([]));
  mount();
  expect(await screen.findByText('No active proposals')).toBeInTheDocument();
  expect(screen.getByText('Drafts and sent quotes land here. Booked ones move to Events.')).toBeInTheDocument();
  expect(screen.queryByText(/End of active/)).toBeNull();
});

test('a failed load shows the page error and Retry refetches', async () => {
  api.get.mockRejectedValueOnce(new Error('Network error. Check your connection.'));
  mount();
  expect(await screen.findByText("Couldn't load proposals")).toBeInTheDocument();
  api.get.mockResolvedValue(env([row()]));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Ferreira')).toBeInTheDocument();
});

test('Show more appends page 2 and offers itself under the chip too; an append error stays inline', async () => {
  const first = Array.from({ length: 50 }, (_, i) => row({ id: 100 + i, client_name: `Client ${i}` }));
  api.get.mockResolvedValueOnce(env(first, { total: 51, bucket_total: 51, unviewed_total: 51, has_more: true }));
  mount('/proposals?unviewed=1');
  await screen.findByText('Client 0');
  const more = screen.getByRole('button', { name: /Show more/ });
  expect(more).toHaveTextContent('50 of 51');
  api.get.mockRejectedValueOnce(new Error('boom'));
  fireEvent.click(more);
  expect(await screen.findByText(/Couldn't load more\. boom/)).toBeInTheDocument();
  expect(screen.getByText('Client 49')).toBeInTheDocument();
  api.get.mockResolvedValueOnce(env([row({ id: 999, client_name: 'Last one' })], { total: 51, bucket_total: 51, unviewed_total: 51, page: 2, has_more: false }));
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/proposals', { params: { ...base, page: 2, unviewed: 1 }, ...H }));
  expect(await screen.findByText('Last one')).toBeInTheDocument();
  expect(screen.getByText('Client 0')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
});

test('a cache-served list shows the offline copy line; an append never clears it', async () => {
  api.get.mockResolvedValueOnce({ ...env([row()], { total: 2, bucket_total: 2, has_more: true }), staleAt: '2026-10-14T14:14:00.000Z' });
  mount();
  await screen.findByText('Ferreira');
  expect(screen.getByText(/offline copy · as of/)).toBeInTheDocument();
  api.get.mockResolvedValueOnce(env([row({ id: 2, client_name: 'Tran' })], { total: 2, bucket_total: 2, page: 2, has_more: false }));
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await screen.findByText('Tran');
  expect(screen.getByText(/offline copy · as of/)).toBeInTheDocument();
});

test('a superseded response never paints: the first order resolves after the second', async () => {
  let resolveFirst;
  api.get.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
  mount();
  api.get.mockResolvedValueOnce(env([row({ id: 2, client_name: 'By date' })]));
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await screen.findByText('By date');
  await act(async () => { resolveFirst(env([row({ id: 1, client_name: 'By lead' })])); });
  expect(screen.queryByText('By lead')).toBeNull();
  expect(screen.getByText('By date')).toBeInTheDocument();
});

test('a row with no event date renders a dash rail and says so to a screen reader', async () => {
  api.get.mockResolvedValue(env([row({ event_date: null, status: 'draft', client_name: 'Okonkwo' })]));
  mount();
  const card = await screen.findByRole('button', { name: /Okonkwo/ });
  expect(within(card).getByText('–')).toHaveClass('m-rail-day');
  expect(within(card).getByText('no date')).toHaveClass('sr-only');
});

test('tapping a card opens /proposals/:id', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Ferreira/ }));
  expect(await screen.findByTestId('detail')).toBeInTheDocument();
});

test('the first load shows the skeleton with the first-sync note', async () => {
  api.get.mockReturnValueOnce(new Promise(() => {}));
  mount();
  expect(screen.getByText('first sync · fetching proposals')).toBeInTheDocument();
  expect(document.querySelectorAll('.m-card-skel').length).toBe(4);
});

test('an order switch shows the skeleton again, without the first-sync note', async () => {
  api.get.mockResolvedValueOnce(env([row()]));
  mount();
  await screen.findByText('Ferreira');
  api.get.mockReturnValue(new Promise(() => {}));   // the next page never lands
  fireEvent.click(screen.getByRole('radio', { name: 'Event date' }));
  await waitFor(() => expect(document.querySelectorAll('.m-card-skel').length).toBe(4));
  expect(screen.queryByText('Ferreira')).toBeNull();
  expect(screen.queryByText('first sync · fetching proposals')).toBeNull();
});

test('scroll offsets are saved only after the loaded list has been restored', async () => {
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cb(); return 1; };   // run the throttle inline
  window.sessionStorage.setItem('proposals-scroll:lead:0', '120');
  let resolve;
  api.get.mockReturnValue(new Promise(r => { resolve = r; }));
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <main id="main-content" style={{ overflow: 'auto', height: 300 }}>
        <Routes><Route path="/proposals" element={<ProposalsListPhone />} /></Routes>
      </main>
    </MemoryRouter>
  );
  const host = document.getElementById('main-content');
  Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true });
  // The list is still the skeleton. A scroll here is the browser clamping, not
  // the user, and it must not bury the offset we are about to restore.
  host.scrollTop = 0;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('proposals-scroll:lead:0')).toBe('120');
  resolve(env([row()]));
  await screen.findByText('Ferreira');
  // The restore runs in an effect, which can land a tick after the card paints.
  await waitFor(() => expect(host.scrollTop).toBe(120));
  // Restored, so the user's own scrolling is saved again.
  host.scrollTop = 40;
  fireEvent.scroll(host);
  expect(window.sessionStorage.getItem('proposals-scroll:lead:0')).toBe('40');
  window.requestAnimationFrame = realRaf;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/ProposalsListPhone.test.js`
Expected: FAIL, "Cannot find module './ProposalsListPhone'".

- [ ] **Step 3: Write the page**

Create `client/src/pages/mobile/ProposalsListPhone.js`:

```js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { offlineGet } from '../../utils/offlineRead';
import useUrlListState from '../../hooks/useUrlListState';
import { proposalCard } from '../../utils/proposalCards';
import { formatStaleTime } from '../../utils/staleTime';
import StatusChip from '../../components/adminos/StatusChip';
import Icon from '../../components/adminos/Icon';

// Phone Proposals list (spec 2026-08-13-mobile-admin section 5 List; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Proposals tab).
// Renders INSIDE AdminLayout's scrolling .m-main; the header and tab bar are
// the chrome's. Reads the desktop Active bucket through GET /proposals with
// envelope=1 (lane ma-f1): newest lead or event date, the server-side Unviewed
// predicate, 50 a page. A card opens /proposals/:id (the desktop proposal page
// inside the phone chrome until lane ma-f2 draws the phone detail).
const PAGE = 50;
const LIST_DEFAULTS = { order: 'lead', unviewed: '' };
// No m- prefix on purpose: utils/mobileClassContract.test.js reads every m-*
// token in this file as a CSS class.
const SCROLL_KEY = (order, unviewed) => `proposals-scroll:${order}:${unviewed ? 1 : 0}`;
const SKELETONS = [['62%', '44%'], ['70%', '38%'], ['55%', '46%'], ['66%', '40%']];

function scrollHost() { return document.getElementById('main-content'); }

// Never scroll past what the freshly rendered list can actually show.
function canRestore(host, saved) {
  return saved > 0 && host.scrollHeight - host.clientHeight >= saved;
}

export default function ProposalsListPhone() {
  const navigate = useNavigate();
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const order = listState.order === 'date' ? 'date' : 'lead';
  const unviewed = listState.unviewed === '1';

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);      // the last envelope minus rows
  const [staleAt, setStaleAt] = useState(null); // x-sw-cached-at when the SW served it
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  // An append that fails must never take the loaded list down with it: the
  // page-level error owns the empty screen, moreError owns the line under
  // Show more, so the rendered cards and the scroll offset survive a flaky tap.
  const [moreError, setMoreError] = useState(null);
  // Which list the rows on screen belong to, stamped by the response. The scroll
  // effects key off this rather than off order/unviewed, which change on the
  // tap, one whole round trip before the matching rows arrive.
  const [loadedKey, setLoadedKey] = useState(null);
  const reqSeq = useRef(0);
  const restoredRef = useRef(null);

  const params = useCallback((page) => {
    const p = { envelope: 1, limit: PAGE, page, sort: order === 'date' ? 'event_date' : 'created_at', dir: order === 'date' ? 'asc' : 'desc' };
    if (unviewed) p.unviewed = 1;
    return p;
  }, [order, unviewed]);

  const load = useCallback(async (page, append) => {
    const seq = ++reqSeq.current;
    // A fresh load clears the page first, so the skeleton is what an order
    // switch, a chip toggle and Retry all show, and the previous order's cards
    // never sit under the new toggle. Appends keep the list in place and move
    // the Show more button to its Loading label instead.
    setMoreError(null);
    if (append) setLoadingMore(true); else { setLoading(true); setError(null); setRows([]); restoredRef.current = null; }
    try {
      const res = await offlineGet('/proposals', { params: params(page) });
      if (seq !== reqSeq.current) return;                 // a newer request superseded this one
      const { rows: pageRows = [], ...rest } = res.data || {};
      setRows(prev => (append ? prev.concat(pageRows) : pageRows));
      setMeta(rest);
      // An append must never rewrite the staleness label: page 1 from the
      // worker's cache plus page 2 off the network is still a mostly-cached list.
      if (append) { if (res.staleAt) setStaleAt(res.staleAt); } else setStaleAt(res.staleAt || null);
      setFetchedAt(new Date().toISOString());
      if (!append) setLoadedKey(SCROLL_KEY(order, unviewed));
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const msg = err && err.message ? err.message : 'Network error. Check your connection.';
      if (append) setMoreError(msg); else setError(msg);
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [params, order, unviewed]);

  useEffect(() => { load(1, false); }, [load]);

  // List scroll restore (spec section 9): the scroll container is the chrome's
  // .m-main, keyed per order + chip. sessionStorage lives for one launch: Back
  // from a detail restores, a cold launch of the installed app lands at the top.
  useEffect(() => {
    const host = scrollHost();
    if (!host) return undefined;
    const key = SCROLL_KEY(order, unviewed);
    let raf = 0;
    const onScroll = () => {
      // Never write before this list has been restored: on a fresh load the page
      // collapses to the skeleton, the browser clamps scrollTop and fires a
      // scroll, and that clamped value would bury the offset about to be restored.
      if (restoredRef.current !== key || raf) return;
      raf = window.requestAnimationFrame(() => { raf = 0; try { window.sessionStorage.setItem(key, String(host.scrollTop)); } catch { /* storage may be unavailable */ } });
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => { host.removeEventListener('scroll', onScroll); if (raf) window.cancelAnimationFrame(raf); };
  }, [order, unviewed]);
  useEffect(() => {
    const key = SCROLL_KEY(order, unviewed);
    if (loading || !rows.length || loadedKey !== key || restoredRef.current === key) return;
    const host = scrollHost();
    if (!host) return;
    let saved = 0;
    try { saved = Number(window.sessionStorage.getItem(key) || 0); } catch { saved = 0; }
    if (canRestore(host, saved)) host.scrollTop = saved;
    restoredRef.current = key;
    // rows is deliberately absent: an append must not re-scroll, and loadedKey
    // already identifies the fresh load this restore belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadedKey, order, unviewed]);

  const cards = useMemo(() => rows.map((r) => proposalCard(r)), [rows]);
  const cachedTime = formatStaleTime(staleAt);
  const total = meta ? Number(meta.total || 0) : 0;
  const bucketTotal = meta ? Number(meta.bucket_total || 0) : 0;
  const unviewedTotal = meta ? Number(meta.unviewed_total || 0) : 0;
  const hasMore = !!(meta && meta.has_more);
  const nextPage = meta ? Number(meta.page || 1) + 1 : 2;

  // Benchmark: the chip's empty state is "Everything opened" only when the
  // bucket has proposals at all; an empty bucket says so even with the chip on.
  let empty = null;
  if (!loading && !error && cards.length === 0) {
    if (unviewed && bucketTotal > 0) empty = { ok: true, icon: 'check', title: 'Everything opened', body: 'No sent proposal is waiting to be seen.' };
    else empty = { icon: 'clipboard', title: 'No active proposals', body: 'Drafts and sent quotes land here. Booked ones move to Events.' };
  }

  return (
    <div>
      <div className="m-listbar">
        <div className="m-seg" role="radiogroup" aria-label="Order">
          <button type="button" role="radio" aria-checked={order === 'lead'} className={`m-seg-btn${order === 'lead' ? ' active' : ''}`}
            onClick={() => order !== 'lead' && setListState({ order: '' })}>Newest lead</button>
          <button type="button" role="radio" aria-checked={order === 'date'} className={`m-seg-btn${order === 'date' ? ' active' : ''}`}
            onClick={() => order !== 'date' && setListState({ order: 'date' })}>Event date</button>
        </div>
        <button type="button" className={`m-chip-toggle${unviewed ? ' on' : ''}`} aria-pressed={unviewed}
          onClick={() => setListState({ unviewed: unviewed ? '' : '1' })}>
          {/* The count waits for the envelope: rendering 0 during the first
              load makes the chip read "Unviewed 0" and then jump. */}
          Unviewed{meta && <span className="m-chip-count">{unviewedTotal}</span>}
        </button>
      </div>

      {loading && cards.length === 0 && !error && (
        <>
          {/* "first sync" is literal: the note retires once any response has landed. */}
          {!fetchedAt && <div className="m-skel-note">first sync · fetching proposals</div>}
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

      {error && rows.length === 0 && (
        <div className="m-empty" role="alert">
          <div className="m-empty-title">Couldn't load proposals</div>
          <div className="m-empty-body">{error}</div>
          <button type="button" className="m-retry-btn" onClick={() => load(1, false)}>Retry</button>
        </div>
      )}

      {!loading && (!error || rows.length > 0) && (
        <>
          {/* Only an offline copy says how old it is (Dallas, 2026-09-30). */}
          {cachedTime && (
            <div className="m-stale">
              <span className="m-stale-dot" aria-hidden="true" />
              <span>offline copy · as of <span className="m-stale-time">{cachedTime}</span></span>
            </div>
          )}
          {cards.map(card => <ProposalCard key={card.key} card={card} onTap={() => navigate(`/proposals/${card.id}`)} />)}
          {empty && (
            <div className={`m-empty${empty.ok ? ' ok' : ''}`}>
              <Icon name={empty.icon} size={28} />
              <div className="m-empty-title">{empty.title}</div>
              <div className="m-empty-body">{empty.body}</div>
            </div>
          )}
          {hasMore && (
            <button type="button" className="m-card m-card-more" onClick={() => load(nextPage, true)} disabled={loadingMore}>
              <span className="m-showmore">{loadingMore ? 'Loading' : 'Show more'}</span>
              <span className="m-shownof">{cards.length} of {total}</span>
            </button>
          )}
          {moreError && (
            <div className="m-more-error" role="alert">
              <span>Couldn't load more. {moreError}</span>
              <button type="button" className="m-retry-btn" onClick={() => load(nextPage, true)}>Retry</button>
            </div>
          )}
          {!hasMore && !unviewed && cards.length > 0 && (
            <div className="m-end"><span>End of active · {total} {total === 1 ? 'proposal' : 'proposals'}</span></div>
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ card, onTap }) {
  // No aria-label: the accessible name is the card's own content (rail, name,
  // kind, meta, total, chip), which is most of what the card says.
  return (
    <button type="button" className="m-card" onClick={onTap}>
      <span className="m-rail">
        <span className="m-rail-dow">{card.rail.dow}</span>
        <span className="m-rail-day">{card.rail.day}</span>
        <span className="m-rail-mon">{card.rail.mon}</span>
        {card.noDate && <span className="sr-only">no date</span>}
      </span>
      <span className="m-card-body">
        <span className="m-card-head">
          <span className="m-card-title">{card.clientName}</span>
          {card.guests != null && <span className="m-card-guests">{card.guests} <small>GUESTS</small></span>}
        </span>
        {/* The kind gets its own line (Dallas, 2026-09-24, on the Events card;
            the same ellipsis bit here). */}
        {card.kind ? <span className="m-card-kind">{card.kind}</span> : null}
        <span className="m-card-meta">{card.meta}</span>
        <span className="m-card-foot">
          {card.total && <span className="m-card-total">{card.total}</span>}
          <span className="m-chip-end"><StatusChip kind={card.chipKind}>{card.chipLabel}</StatusChip></span>
        </span>
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/ProposalsListPhone.test.js src/utils/mobileClassContract.test.js`
Expected: PASS, 14 tests in the page suite, the class contract green (every `m-*` token the page uses is defined, including the two from Task 3). Zero "not wrapped in act" warnings in the output. If `sr-only` is not a class the stylesheet defines, it is a global utility (it is used by `EventsListPhone.js:290`); it is not an `m-*` token so the contract ignores it.

- [ ] **Step 5: Build**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0.

- [ ] **Step 6: Commit (Tasks 3 and 4 together)**

```bash
git add client/src/pages/mobile/ProposalsListPhone.js client/src/pages/mobile/ProposalsListPhone.test.js client/src/index.css client/src/utils/mobileClassContract.test.js && git commit -F - <<'MSG'
feat(mobile): the phone Proposals list: newest lead or event date, the Unviewed chip, cards with the pipeline chip and total, Show more, states

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 5: Fork `ProposalsDashboard` at phone width

**Files:**
- Modify: `client/src/pages/admin/ProposalsDashboard.js:62` (the export) and the end of the file
- Create: `client/src/pages/admin/ProposalsDashboard.fork.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/admin/ProposalsDashboard.fork.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close over
// variables named mock*, and this one calls jest.fn().
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/ProposalsListPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-list" /> }));
// The desktop body reads the list (an array plus the X-Total-Count header) and
// the counts; one stub answers both shapes it can meet (re-armed in beforeEach).
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
// Stable identity on purpose: a fresh toast object per render re-runs the
// desktop body's fetch effect forever.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ ...jest.requireActual('../../context/PaletteContext'), usePalette: () => mockPalette }));
import { MemoryRouter } from 'react-router-dom';
import api from '../../utils/api';
import ProposalsDashboard from './ProposalsDashboard';

const mount = () => render(<MemoryRouter initialEntries={['/proposals']}><ProposalsDashboard /></MemoryRouter>);

// CRA's jest runs with resetMocks: true, which wipes the implementation given
// in the jest.mock factory before each test; the desktop body calls
// api.get(...).then(...) synchronously inside an effect, so an undefined
// return crashes the render. Re-arm the stub here, every test.
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation(() => Promise.resolve({ data: [], headers: { 'x-total-count': '0' } }));
});

test('phone width without a Desktop-view override renders the phone list', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-list')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('proposals-list');
  expect(api.get).not.toHaveBeenCalled();
});

test('phone width with the Desktop-view override renders the desktop dashboard', async () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  expect(await screen.findByText('Proposals')).toBeInTheDocument();   // the desktop page title
  await waitFor(() => expect(api.get).toHaveBeenCalled());
});

test('desktop width renders the desktop dashboard', async () => {
  mockMobileView.isPhone = false;
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
});
```

The plan fleet ran this file against the real desktop body: with the `beforeEach` above, the two desktop tests pass with zero act() warnings and no further provider is needed (`usePalette` stubbed; `ClickableRow` and `EntityLink` under the MemoryRouter). Never change the desktop body to satisfy the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/ProposalsDashboard.fork.test.js`
Expected: the first test fails (no phone list; `desktopView` never called).

- [ ] **Step 3: Fork**

In `client/src/pages/admin/ProposalsDashboard.js`: add the two imports next to the other context/page imports:

```js
import { useMobileView } from '../../context/MobileViewContext';
import ProposalsListPhone from '../mobile/ProposalsListPhone';
```

Change `:62` from `export default function ProposalsDashboard() {` to `function ProposalsDashboardDesktop() {`, and append at the end of the file:

```js
// Route-level fork (spec 2026-08-13-mobile-admin section 3): same URL, same
// route table; the phone list renders at phone width unless this screen's
// Desktop-view override is on. Decided when the page opens (MobileViewContext
// latches isPhone per pathname), so a rotation mid-page does not swap screens.
export default function ProposalsDashboard() {
  const { isPhone, desktopView } = useMobileView();
  if (isPhone && !desktopView('proposals-list')) return <ProposalsListPhone />;
  return <ProposalsDashboardDesktop />;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/ProposalsDashboard.fork.test.js src/pages/admin`
Expected: the fork suite 3/3; every other `src/pages/admin` suite unchanged; no act() warnings from the fork suite.

- [ ] **Step 5: Build, then commit**

Run: `cd client && CI=true npx react-scripts build` (exit 0).

```bash
git add client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ProposalsDashboard.fork.test.js && git commit -F - <<'MSG'
feat(mobile): the Proposals tab forks to the phone list at phone width

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 6: Phone-viewport gate and the benchmark comparison

**Files:**
- Modify: `scripts/mobile-capture.manifest.json:82` (the existing `admin-proposals` entry) plus two new entries
- No committed Playwright script; the checks run ad hoc from the lane with `playwright-core` per `.claude/agent-memory/ui-ux-reviewer/local-ui-review-recipe.md` and the dev sign-in recipe (`reference-mobile-local-review`: `dev-signin.js`, the admin init script at `~/.cache/drb-dev-signin/admin-1.js`).

- [ ] **Step 1: The manifest**

Replace the `admin-proposals` line with these three (the tab now has a phone screen, so it is no longer report-only and asserts the apparatus):

```json
    { "name": "admin-proposals", "host": "localhost", "path": "/proposals", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" },
    { "name": "admin-proposals-date", "host": "localhost", "path": "/proposals?order=date", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" },
    { "name": "admin-proposals-unviewed", "host": "localhost", "path": "/proposals?unviewed=1", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-listbar" },
```

- [ ] **Step 2: Run the capture**

With the lane's API and client dev servers up (scoped ports, per `reference-subagent-dev-token-refused`): `npm run mobile:check`.
Expected: the three proposals pages pass the overflow, tap-target and tiny-text probes. (The run may still exit 1 on the pre-existing `portal-home` auth-hydration race; read the per-page lines, not the exit code.)

- [ ] **Step 3: Render the benchmark's Proposals tab per state**

Reuse the scratchpad render recipe from the push lane (`render/shoot.js`: Playwright over a python http.server on the artifact, clicking a tab; Chromium at `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`). Variants of the artifact's data props: `proposalsData` in `typical`, `all viewed`, `empty active`, `cold load`; `skin` dark and light; `offline` true for the stale line. Click the Proposals tab instead of More. Save the eight shots beside the lane's ledger for the ui-ux seat.

- [ ] **Step 4: Ad hoc browser checks (record P1 to P9 in this plan's "Browser checks" table, on main, before the merge)**

Chromium 390x844 (then 360 and 320 for P8), a dev admin session, `http://localhost:<lane client port>/proposals`:
- P1: `.m-listbar` is sticky: scroll 800px, `document.elementFromPoint` at the Unviewed chip's center is the chip.
- P2: tapping "Event date" changes the URL to `/proposals?order=date` without a new history entry (`history.length` unchanged); tapping a card and pressing Back returns to `/proposals?order=date`.
- P3: the chip count equals `unviewed_total` in a direct `GET /api/proposals?envelope=1&limit=1` for the same session, and equals the number of rows with `status === 'sent'` and `last_viewed_at === null` across `GET /api/proposals?envelope=1&limit=200&page=N` paged until `has_more` is false (200 is the route's clamp); turning the chip on does not change the number on the chip.
- P4: legacy shape: `GET /api/proposals` (no envelope) answers a JSON array and carries `X-Total-Count`; at desktop width `/proposals` renders the table, tabs, filters and pager exactly as on main (same first page of rows).
- P5: `elementFromPoint` at the center of the first card and of Show more (seed enough rows, or set `limit` lower in the console only to force the button) returns the button itself.
- P6: tapping a card lands on `/proposals/<id>`: the desktop proposal page renders inside the phone chrome under the header title "Proposal" (the interim until ma-f2); the chrome's back control returns to the list with the order and the chip intact.
- P7: offline, in-document proof as ma-e1's C7: live load, go offline, toggle to an uncached order (error state with Retry), toggle back (the cached order renders with "offline copy · as of" and the amber dot).
- P8: both skins at 390, 360 and 320 beside the benchmark renders from Step 3: card anatomy (rail, name, kind line, guests, meta, total left, chip right), the chip and segmented styles, the skeleton, both empty states, Show more, the end divider; House Lights squared cards and the ok ink on the check icon.
- P9: scroll restore within a launch: scroll to 1200, open a card, Back: the list restores at 1200 under the same order and chip; switch the order: lands at the top.

Then dispatch the ui-ux-review seat against the benchmark's Proposals tab (the eight renders) with the lane servers up; adherence to the artifact is its primary benchmark. Brief it with the sanctioned departures so it does not re-flag them: decision 1 (the kind on its own line, and the family's 44/7/8 rail metrics), decision 5 (Show more can appear under the chip), decision 6 (a card opens the desktop page for now), decision 11 (no staleness line on a live list), decision 12 (singular at one), and the chip count that waits for the first envelope.

- [ ] **Step 5: Commit**

```bash
git add scripts/mobile-capture.manifest.json && git commit -F - <<'MSG'
test(mobile): phone-viewport capture pages for the admin Proposals list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 7: Docs and ledgers

**Files:**
- Modify: `README.md:701`, `ARCHITECTURE.md:339` and after `:2135`, `scripts/sensitive-paths.txt` (after `:467`), `docs/walkthroughs-owed.md` (end of Tier 6), `docs/fix-list-remaining-2026-07-02.md` (the ma-f1 sentence, search "ORDINARY DESKTOP ADMIN PAGE")

- [ ] **Step 1: README**

In the `pages/mobile/` tree line (`:701`), after the EventsListPhone clause, add: `ProposalsListPhone (the phone Proposals list: the desktop Active bucket through GET /proposals?envelope=1, Newest lead or Event date, the Unviewed chip with the bucket's count, Show more paging, the staleness line; a card opens /proposals/:id, the desktop proposal page inside the phone chrome until lane ma-f2), `.

- [ ] **Step 2: ARCHITECTURE**

In the `GET /` proposals row (`:339`), before the closing `|`, append: ` Phone mode (lane ma-f1): \`sort=created_at\` joins the whitelist (the fallback order, addressable); \`unviewed=1\` is a server-side predicate, \`last_viewed_at IS NULL AND status = 'sent'\`; \`envelope=1\` answers \`{ rows, total, bucket_total, unviewed_total, page, limit, has_more }\` instead of the bare array (the array and the header are unchanged for every caller that does not send it).`

After the "Phone Events list" bullet (`:2135`), add a bullet: `- **Phone Proposals list**: \`client/src/pages/mobile/ProposalsListPhone.js\`, mounted by the same route-level fork inside \`client/src/pages/admin/ProposalsDashboard.js\` (\`desktopView('proposals-list')\`). Reads \`GET /proposals?envelope=1\` (50 a page; \`sort=created_at&dir=desc\` for Newest lead, \`sort=event_date&dir=asc\` for Event date; \`unviewed=1\` for the chip), renders the ma-e1 card family with the pipeline chip from \`utils/proposalStatusMap.js\` and the meta line per stage from the pure \`utils/proposalCards.js\`, remembers scroll per order and chip in sessionStorage, and degrades per the offline law (the worker already allowlists \`/api/proposals\` by exact path; each query variant is its own cache entry).`

- [ ] **Step 3: Sensitive paths, walkthroughs, fix list**

`scripts/sensitive-paths.txt`: add `client/src/pages/mobile/ProposalsListPhone.js` on its own line after `client/src/pages/mobile/EventsListPhone.js`.

`docs/walkthroughs-owed.md`: the Admin push entry moved to Tier 3b on 2026-10-14, so Tier 6 (`## Tier 6`, about `:2080`) holds only the consult-call record. Append this entry at the END of Tier 6, right before `## Tier 4`, and amend the tier's "holds ONE item" sentence to two:

```markdown
### Proposals list on the phone (lane ma-f1-proposals-list, built 2026-10-XX; moves to Tier 3b when its squash is an ancestor of `origin/main`)

The walk, on the Pixel, in the installed app:
1. Proposals tab: cards newest lead first, each with the date rail, the client, the kind on its own line, guests, the stage line, the total and the stage chip.
2. Tap Event date: the soonest event first; a draft with no date sits at the end with a dash in its rail.
3. Tap Unviewed: only sent-and-never-opened proposals; the number on the chip matches before and after the tap; "Everything opened" when there are none but the bucket is not empty.
4. Scroll to the end: "End of active · N proposals" with the chip off; Show more when there are more than fifty.
5. Tap a card: the desktop proposal page opens inside the phone chrome (until the phone detail lane lands); Back returns to the list where you left it.
6. Airplane mode, reopen the tab: the stored copy with "offline copy · as of".
```

`docs/fix-list-remaining-2026-07-02.md`: at the sentence "the Proposals tab still routes to the ORDINARY DESKTOP ADMIN PAGE with no phone branch ... until `ma-f1` lands", append: **AMENDED 2026-10-XX: the Proposals LIST is built by lane `ma-f1-proposals-list` (`docs/superpowers/plans/2026-10-14-mobile-admin-proposals-list.md`); `/proposals` forks to the phone list at phone width. Still declared and unbuilt: `ma-f2-proposal-detail`, `ma-f3-search`.** And one new bullet under Admin UI: `- Phone lists share their load and scroll mechanics by hand: EventsListPhone and ProposalsListPhone carry the same superseded-response guard, append-keeps-staleness rule and restore clamp. Extract a shared hook when a third paged phone list arrives (ma-f3 search is grouped, not paged, so not that one). Lane ma-f1, 2026-10-14.`

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md scripts/sensitive-paths.txt docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md && git commit -F - <<'MSG'
docs(mobile): the phone Proposals list in the README tree, the route table, the phone surfaces, the sensitive list, the walk and the fix list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 8: Lane close: suites reached, gate, review fleet, merge

- [ ] **Step 1: Server suites, one at a time from the lane root**

`node --test server/routes/proposals/list.phone.test.js`, `node --test server/routes/proposals/list.sort.test.js`, `node --test server/routes/proposals/crud.filters.test.js` (the three suites that import `./list`). Quote every count. Confirm no fixture rows remain.

- [ ] **Step 2: Client suites and build**

`cd client && CI=true npx react-scripts test --watchAll=false src/utils/proposalCards.test.js src/pages/mobile src/pages/admin/ProposalsDashboard.fork.test.js src/pages/admin/EventsDashboard.fork.test.js src/utils/mobileClassContract.test.js src/components/mobile` then `CI=true npx react-scripts build`. Zero act() warnings in the suites this lane added.

- [ ] **Step 3: Desktop regression by eye**

Desktop viewport: `/proposals` renders the table exactly as before (tabs, filters, pager, the X-Total-Count paging). The Overview drill-outs into `/proposals?cohort=...` unchanged.

- [ ] **Step 4: Review fleet, per the lane map**

code-review, consistency-check, ui-ux-review (Task 6 Step 4 covers the seat's benchmark), plus `/second-opinion` over the server diff (cheap, and the predicate is SQL). Fix rounds as needed; record as-built deltas in this plan's "Lane review round" section before the merge.

- [ ] **Step 5: Merge**

Rebase the lane onto `main` first if main moved. Squash-merge through `os` on `main` via `scripts/merge-lane.sh ma-f1-proposals-list docs/superpowers/plans/2026-10-14-mobile-admin-proposals-list.md ma-f1-proposals-list`; client build on merged main; `npm run worktree:rm -- ma-f1-proposals-list --force` after the three checks; the board line via `scripts/board-write.sh "Recently shipped" ...`; the close record in this plan; the 2026-10-XX dates in Task 7's docs filled in.

## Self-Review (2026-10-14)

1. **Spec coverage.** Section 5 List: the card list per the Visual contract (Task 4), the pipeline chip (Tasks 2, 4), the sort toggle Event date / Newest lead (Tasks 1, 4), the one Unviewed tap-chip (Tasks 1, 4), no Modified chip (none built), the feed grounding (`created_at` in the whitelist with the comment and `list.sort.test.js` updated, the server-side `unviewed=1` predicate: Task 1). Section 3 Visual contract, Proposals list line: the desktop Active bucket (the route default), the apparatus, chips from the real statuses, meta from the five timestamps and the view count, nothing "expiring", the same paging, end divider, skeleton and empty states as Events (Tasks 2, 4). Section 7 Offline: `offlineGet` and the staleness line (Task 4); the worker already allowlists the path. Section 9: list scroll restore (Task 4). Section 3 fork law (Task 5). Docs law (Task 7). Gaps: none found.
2. **Placeholder scan.** The `2026-10-XX` dates in Task 7 are filled at lane close (Task 8 Step 5 names it). No TBDs.
3. **Type consistency.** The envelope names `rows, total, bucket_total, unviewed_total, page, limit, has_more` match between Task 1's route, its tests, Task 4's page and its tests. `proposalCard`'s shape (`key, id, ymd, noDate, rail, clientName, kind, guests, meta, total, chipLabel, chipKind`) matches Task 2's tests and Task 4's `ProposalCard`. URL keys `order` and `unviewed` match the manifest paths in Task 6 and the walk in Task 7. The screen key `proposals-list` matches `screenKey.js`.
4. **Review Focus.** Each of the five lines names the task and test that pins it; all five tests exist in the task bodies above.
5. **Known judgment calls, stated:** the thirteen Plan decisions above. Every departure from the artifact is numbered there and briefed to the ui-ux seat in Task 6.

## Plan fleet fold (2026-10-14)

Three seats (fidelity, decomposition, feasibility), all read against main `7d1eaf35`: fidelity PASS, decomposition PASS, feasibility FAIL on two proven breaks, all folded above. The breaks: the page's sessionStorage key carried an `m-` prefix, which the class contract reads as a CSS class (renamed `proposals-scroll:`; `EventsListPhone.js` stays out of the contract for the same reason); the fork test's `api.get` stub was wiped by CRA's `resetMocks` before the desktop body's synchronous `.then`, so the stub is re-armed in `beforeEach` (proven green with zero act() warnings). Also folded: the reached-suite list (the suites that import `./list`), the predicted red for Task 1 (1 pass, 6 fail, proven against the unmodified route), counts (12 and 14), the walkthrough entry's placement (end of Tier 6), the fix-list anchor, the production guard in `list.sort.test.js`, the `modified` line written directly, the module comment on `accepted_at`, the CSS insertion point, the P3 check under the route's 200 clamp, the template's scroll-restore harness, the order-switch skeleton test, and decisions 11 to 13 with the fuller brief for the design seat. Decomposition's recommendation kept: the page duplicates the Events list's mechanics rather than extracting a hook (the shipped, sensitive-listed Events page stays untouched; search is a different feed shape); the extraction is on the fix list for a third paged list.

## Browser checks (lane ma-f1, run 2026-10-14 against the lane's dev servers, Chrome 390x844 unless stated, dev admin session; five runs, the last one green on every check; scratchpad gate-f1/gate.js, shots in ~/.playwright-mcp/ma-f1-gate/)

| check | result | evidence |
|---|---|---|
| P1 sticky bar | pass | 50 cards; scrolled 800: `elementFromPoint` at the Unviewed chip's centre is the chip; no horizontal overflow; no target under 44px |
| P2 Event date, no history entry; Back keeps it | pass | `history.length` 2 before and after; URL `/proposals?order=date`; a card then Back lands on `/proposals?order=date` |
| P3 chip count | pass | chip 30 = `unviewed_total` 30 = 30 sent-and-never-opened rows counted over the 64-row bucket paged at 200; the number does not move when the chip turns on; 30 filtered cards on screen |
| P4 legacy shape + desktop | pass | `GET /api/proposals` answers an array with `X-Total-Count: 64`; at 1280 the desktop table renders under the "Proposals" title with no list bar |
| P5 nothing overlays the targets | pass | `elementFromPoint` at the first card's centre and at Show more's centre lands inside the respective button (run 1 probed the card after scrolling it away: a harness bug) |
| P6 card opens the interim detail | pass | `/proposals/<id>` renders under the chrome's "Proposal" title; Back lands on `/proposals?order=date&unviewed=1` |
| P7 offline, in-document | pass (run 5) | with the API stopped, the never-loaded Unviewed variant shows "Couldn't load proposals" with Retry; the stored Newest lead order renders with `offline copy · as of 10:11 PM` and the amber dot. Runs 1 to 4 were harness: SIGTERM against a wrapper pid left the listener up; a fresh context's first loads run before the worker controls the page; the worker names its API cache per user from a message the chrome posts on mount, which the first stored load can race, so the gate re-stores the order online once before stopping the API |
| P8 both skins, 390 / 360 / 320 | pass (run 2 onward) | run 1 FAILED at 320 in both skins: the Unviewed chip's right edge at 331px inside a 320px main (`.m-listbar` did not fit). Fixed in `9e20dad2`: the shared bar wraps (`flex-wrap: wrap`, its existing 8px gap is the row gap), no media query; at 320 the chip drops under the order switch (about 52px taller bar for the whole list), at 360 and 390 nothing changes |
| P9 scroll restore | pass (run 3 onward) | run 1 FAILED: the saved 1200 became 0 when a card was tapped. The desktop proposal page is shorter than 1200, so the browser clamps `#main-content` to 0 as the Outlet swaps, and the list's scroll listener, whose passive cleanup has not run yet, saved the clamp. Fixed in `9e20dad2`: the page root carries a ref and the save (handler and its rAF callback) returns when the root is detached (`isConnected`), with a jsdom test that clears `#main-content` without unmounting. After the fix: saved 1200 survives the tap, Back restores to 1200, an order switch lands at 0. Runs 2 and 3 also had a harness defect (a locator click scrolled the off-screen first card into view, a legitimate save): the gate now taps the card under the viewport centre by coordinates |

`npm run mobile:check` (Task 6 Step 2, by the Tasks 6+7 implementer, lane client on 3000): 48 pass, 5 skipped; `admin-proposals`, `admin-proposals-date`, `admin-proposals-unviewed` all pass (no overflow, no tap under 36px; the `tiny<12` counts are the 11.5px kind and meta lines, as on the Events pages).

The Events list carries both latent twins (the unmount clamp race, hidden by its tall phone detail; the page-boundary duplicate under Show more); they are on the fix list under Admin UI.

## Lane ma-f1-proposals-list close record (2026-10-14)

- **Built** subagent-driven in eleven lane commits off `fe5dced2`: Task 1 `c48a6b9d`; Task 2 `3fff8990` + fix `d203c69d`; Tasks 3+4 `b1b5a2d6` + fix `9e20dad2`; Task 5 `41aba98f`; Tasks 6+7 `cca1b42c`, `427b58a3`; final wave `2beae3e9`, `0f33cb9f`, `3a21a296`. Every task review clean, two with one fix round each.
- **As built, beyond the plan text:** the `sent` meta line reads `not opened` only while `last_viewed_at` is null (a re-send after the client opened it keeps the view count; the card and the Unviewed chip agree); the shared `.m-listbar` wraps at 320 (`flex-wrap: wrap`, the bar's own 8px gap as the row gap); the page's scroll save returns when its root is detached (`rootRef.current.isConnected`), with a jsdom test that clears the container without unmounting; appended pages drop rows already on screen; the chip's accessible name reads "Unviewed 30"; the rail glyphs are hidden from readers on a no-date card; the root carries `aria-busy` while loading; `.m-seg-btn:focus-visible` sits inside the control (and in the label colour on the active segment); the sent-and-viewed fixture G pins the never-opened half of the predicate; a committed CSS test pins the 320 wrap.
- **Final fleet:** code-review PASS (0 Critical, 0 Important, 6 Minor, all in the wave or the fix list), consistency-check PASS (12/12 code pairs, 0 false docs sentences added, 13/13 decisions, 17/17 verbatim literals), ui-ux PASS (class for class; the sanctioned departures as decided). Second opinion: gemini NO FINDINGS; codex one MED CONFIRMED (deep-page restore), ruled to the fix list for both lists. Browser checks P1 to P9 green on the fifth run (table above); `mobile:check` 48 pass.
- **Merge:** squash `9f2c1f1c` (17 files, +1098/-14) onto main `c21eb862`; merge-tree clean; client build on merged main exit 0; `list.phone` 7/7 and `list.sort` 6/6 on merged main; worktree and branch removed; board `a5b03355`. PUSHED 2026-10-15 16:53 UTC in `6e8f5c95..dfa1a64d` (gate on `dfa1a64d`: 56 money suites and the client build; push-time sweep SHIP, two notes: the envelope's stored token and contact fields, filed on the fix list; the deploy-order empty list, written into the walk).
- **Fix list (Admin UI):** deep-page restore on both lists; the Events twins (unmount clamp race, page-boundary doubled staffing count, chip name, fork test); House Lights hairline status chip (skin-level, owner decision); list-bar versus card left edge (12 vs 10.5px, shared chrome); radiogroup arrow keys; `prefers-reduced-motion` on the skeleton pulse; House Lights `ink-3` contrast (token). Noted for ma-f2: `agoLabel`'s header comment still says "Hours-grained".
- **Owed:** the Pixel walk (walkthroughs-owed Tier 6 "Proposals list on the phone", six steps).
