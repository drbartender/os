# Sortable columns on Proposals & Events lists

## Context

Dallas wants to sort the Proposals and Events admin list tables by column while
working in them ("just want to be able to sort when I'm working with it").
Sort is a **working convenience, not saved state**: clicking a column header
sorts the list; navigating away and back **reverts to the default order**. So
sort lives in ephemeral local `useState` — nothing in the URL, no persistence.

The two pages differ in one decisive way:

- **Events** (`EventsDashboard.js` → `GET /shifts`) loads every row into memory
  (server returns all, `LIMIT 500`, no pagination) and already filters/sorts
  client-side. Sorting is a pure client comparator swap.
- **Proposals** (`ProposalsDashboard.js` → `GET /proposals`) is **server-paginated
  at 50 rows/tab** (`X-Total-Count` holds the real total). Sorting must happen
  **server-side** or the money columns lie — sorting "Total" client-side would
  only reshuffle the visible 50, not surface the true top-N across the bucket.

`server/routes/proposals/list.js` is **not** on `scripts/sensitive-paths.txt`, so
this is a normal-review change, not full-fleet.

## Behavior (both pages)

- Orderable column headers become clickable (`SortableTh`): first click sorts
  **ascending**, second click flips to **descending**, clicking a different
  column starts fresh ascending on that one. Two-state toggle (no third "clear"
  state — you revert to default by navigating away/back, per Dallas's model).
- Active column shows an `up`/`down` arrow; inactive sortable columns show the
  faint dual-arrow `sort` glyph. `aria-sort` set on the active `<th>`.
- Non-orderable columns stay plain `<th>`: **Events** Staffing + action column;
  **Proposals** the trailing action column.
- Blanks/nulls always sort to the bottom regardless of direction; a stable
  `id` tiebreaker keeps ordering deterministic.

## Changes

### 1. New shared component — `client/src/components/adminos/SortableTh.js`

Presentational clickable header (~30 lines). Props: `label`, `sortKey`, `sort`
(`{key, dir}` or null), `onSort(key)`, `className` (passthrough for `num`).
Renders a focusable `<th className="sortable {className}">` with `aria-sort`,
`onClick`/`onKeyDown` (Enter/Space) → `onSort(sortKey)`, and an inner
`<span class="th-sort-inner">` holding the label + `<Icon>` (`up`/`down` when
active, else `sort`, `size={11}`). Reuses existing `Icon` from `./Icon`.

Update `README.md` folder tree (new component — docs discipline).

### 2. CSS — `client/src/index.css` (near the base `.tbl thead th` rule, ~12604)

One block using theme tokens (resolve per light/dark), **scoped under
`html[data-app="admin-os"]`** to match every existing `.tbl` rule (the base
`.tbl thead th` at ~12591 is scoped; keep convention):
```css
html[data-app="admin-os"] .tbl thead th.sortable { cursor: pointer; user-select: none; }
html[data-app="admin-os"] .tbl thead th.sortable:hover { color: var(--ink-1); }
html[data-app="admin-os"] .tbl thead th.sortable:focus-visible { outline: 2px solid var(--ink-1); outline-offset: -2px; }
html[data-app="admin-os"] .tbl thead th.sortable .th-sort-inner { display: inline-flex; align-items: center; gap: 4px; }
html[data-app="admin-os"] .tbl thead th.sortable .icon { opacity: 0.45; }
html[data-app="admin-os"] .tbl thead th.sortable[aria-sort]:not([aria-sort="none"]),
html[data-app="admin-os"] .tbl thead th.sortable[aria-sort]:not([aria-sort="none"]) .icon { color: var(--ink-1); opacity: 1; }
```
(`--ink-1` is defined in both skins. `.num` right-alignment already applies to
`th.num`; the inline-flex span right-aligns inside it. Verify visually and nudge
only if needed.)

### 3. Events — `client/src/pages/admin/EventsDashboard.js` (client-side sort)

- `const [sort, setSort] = useState({ key: 'event_date', dir: 'asc' })` (default
  = current behavior).
- `onSort(key)`: toggle helper (same key → flip dir; new key → `{key, dir:'asc'}`).
- Replace the fixed `.sort(event_date)` in the `filtered` useMemo with a
  comparator driven by `sort.key`/`sort.dir`, via an accessor map:
  - `event` → `client_name` (lowercased text)
  - `event_date` → `event_date.slice(0,10)`
  - `location` → trimmed lowercased `location`
  - `guests` → `Number(guest_count || proposal_guest_count || 0)`
  - `status` → `proposal_status` (manual rows sort last)
  - `total` → `Number(proposal_total || 0)`
  - `balance` → `Number(proposal_total||0) - Number(proposal_amount_paid||amount_paid||0)`
  Comparator ordering (blanks-last and the `id` tiebreaker must sit **outside**
  the direction flip, or a naive post-negation sends nulls to the top on desc):
  ```
  const cmp = (a, b) => {
    const va = acc(a), vb = acc(b);
    const aB = va === '' || va == null, bB = vb === '' || vb == null;
    if (aB && bB) return a.id - b.id;        // both blank: stable
    if (aB) return 1;                        // blank sorts last, ANY dir
    if (bB) return -1;
    let r = (typeof va === 'number' && typeof vb === 'number')
      ? va - vb : String(va).localeCompare(String(vb));
    if (r === 0) return a.id - b.id;         // stable tiebreak, unsigned
    return sort.dir === 'asc' ? r : -r;      // sign flip on the value compare only
  };
  ```
  Add `sort` to the memo deps.
- Swap the sortable `<th>`s for `<SortableTh ... sort={sort} onSort={onSort} />`
  (Event, Date, Location, Guests[num], Status, Total[num], Balance[num]); keep
  Staffing + action `<th>` plain.

### 4. Proposals — `client/src/pages/admin/ProposalsDashboard.js` (server-side sort)

- `const [sort, setSort] = useState(null)` (null = server default, created_at desc).
- `onSort(key)`: same toggle helper (from null → `{key, dir:'asc'}`).
- In the `queryString` useMemo, append `sort`/`dir` when `sort` is set; add
  `sort` to deps. Existing fetch re-runs on queryString change — no other wiring.
- Swap sortable `<th>`s for `SortableTh`, with these exact **label → sortKey**
  pairs (keys MUST match the §5 server whitelist verbatim; don't infer from labels):
  Client→`client`, Event→`event`, Event date→`event_date`, Package→`package`,
  Status→`status`, Sent→`sent`, Last viewed→`last_viewed`, Total[num]→`total`.
  Keep the trailing action `<th />` plain.

### 5. Server — `server/routes/proposals/list.js` (whitelisted ORDER BY)

- Add a fixed `SORT_COLUMNS` map (key → literal SQL expr):
  `client:'LOWER(c.name)'`, `event:"LOWER(COALESCE(NULLIF(TRIM(p.event_type_custom),''), p.event_type, ''))"`,
  `event_date:'p.event_date'`, `package:'LOWER(sp.name)'`, `status:'p.status'`,
  `sent:'p.sent_at'`, `last_viewed:'p.last_viewed_at'`, `total:'p.total_price'`.
- Read `sort`, `dir` from `req.query`. `sortExpr = SORT_COLUMNS[sort]` (undefined
  if not whitelisted → fall back). `sortDir = dir === 'asc' ? 'ASC' : 'DESC'`.
- Replace the hardcoded `ORDER BY p.created_at DESC` with:
  `sortExpr ? ORDER BY ${sortExpr} ${sortDir} NULLS LAST, p.id DESC`
  `: ORDER BY p.created_at DESC, p.id DESC`.
- **Safety**: sort key + dir select from fixed literal fragments only — no user
  string is interpolated into SQL. `NULLS LAST` forces blanks to the bottom in
  both directions; `p.id` tiebreaker makes the 50-row page deterministic.
- Note (no action): server sort can scatter option-group siblings, but the
  client rollup dedupes by `group_id` across the fetched page and the UI shows
  only one page, so no visible duplication.

## Method

Single cohesive lane off `main`, built in one pass (no subagent split needed).
Per-lane normal review before squash-merge. Push is Dallas's explicit call.

## Verification

- **Server test** — add `server/routes/proposals/list.sort.test.js`. It hits the
  route through `auth`, so reuse the in-file express+http harness pattern from
  `server/routes/proposals/crud.test.js` (a bare util test can't exercise the
  handler). **Seed its own fixtures + clean up** — do NOT assert against whatever
  the shared dev DB happens to hold, or the checks pass vacuously: insert a
  handful of proposals in one bucket with known distinct `total_price` values and
  at least one null `event_date`, tagged so teardown removes exactly them. Assert:
  `?sort=total&dir=asc` → ascending totals; `?sort=total` (no dir) → descending;
  `?sort=bogus` → created_at-desc fallback order; a date sort puts the null-date
  row last in both directions. Run one suite at a time:
  `node --test -r dotenv/config server/routes/proposals/list.sort.test.js`.
- **Client build** — `cd client && CI=true npx react-scripts build` (catches the
  CI-fatal ESLint warnings the pre-push hook gates on).
- **Manual e2e** (dev server, admin login):
  - Events: click Date/Total/Balance/Guests/Location/Client headers → rows
    reorder, arrow indicator flips asc/desc, Staffing/action headers inert.
  - Proposals: click Total → Network shows `GET /proposals?...&sort=total&dir=asc`,
    rows reorder; flip to desc; confirm it reorders across the bucket (not just
    the visible page) on a tab with >50 rows if available.
  - Navigate away and back on both → order reverts to default (ephemeral sort).
```
