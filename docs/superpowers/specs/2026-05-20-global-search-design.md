# Global Search — Design

**Date:** 2026-05-20
**Status:** Approved (design)

## Problem

When a client or staff member calls or texts out of the blue, the admin has no fast
way to identify them or pull up their record. Today they must guess the right
dashboard (Clients / Proposals / Events / Staffing), open it, then use that page's
local search. A single search reachable from every admin page, matching any fragment
of a name, phone number, or email, removes that fumbling.

## Goal

One global search, reachable from every admin page, that finds a person and their
records by partial name, phone, or email, across clients, proposals, events, and staff.

## What already exists

- Every admin page renders `Header` (`client/src/components/adminos/Header.js`), which
  has a search button ("Search events, clients, proposals…") and a `Cmd/Ctrl+K`
  shortcut. Both open `CommandPalette`.
- `CommandPalette` (`client/src/components/adminos/CommandPalette.js`) is mounted in
  `AdminLayout`. Today it only does static page-jumps and create actions. It carries a
  TODO: `hook up /api/admin/search ... to populate a live Records group`.
- `useDebounce` hook exists (`client/src/hooks/useDebounce.js`).
- No `/api/admin/search` endpoint exists.

This feature finishes the half-wired palette. It does not add a new UI surface.

## Approach

Wire live record search into the existing command palette. No new visible surface, no
schema change.

## Backend

### New endpoint: `GET /api/admin/search?q=<term>`

- New file `server/routes/admin/search.js`, mounted in `server/routes/admin/index.js`
  via `router.use('/', require('./search'))`. The route path is `/search` (no `/:id`
  segment), so it does not collide with any existing admin sub-router.
- Guard: `auth, requireAdminOrManager` (matches the clients and proposals routes;
  managers already see those records).
- Input: `q` query string. Trim it. If under 2 characters or over 100, return empty
  groups without a DB hit (the upper bound caps the cost of the unindexed scans).
- LIKE hardening: escape `\`, `%`, `_` in the term before building the `%term%`
  pattern (same approach as `admin/hiring.js`). Match case-insensitively.
- Phone matching: derive `digits` = `q` stripped to `[0-9]`. When `digits.length >= 3`,
  additionally match phone columns by comparing
  `regexp_replace(<col>, '[^0-9]', '', 'g')` against `%digits%`. This makes `555-123`,
  `5551234`, and `(555) 123` all match a stored `5551234567` regardless of how the
  stored value is formatted.

### What it searches and returns

Four groups, each capped at 6 rows, ordered most-recent-first:

**clients** — `clients` table. Match `name`, `email`, `phone`. Nav target
`/clients/:id`.

**proposals** — `proposals p JOIN clients c`, status NOT IN the paid set and NOT
`archived`, matched on the client's name / email / phone. `detail` is the event-type
label plus event date. Nav target `/proposals/:id`.

**events** — same join, status IN
(`deposit_paid`, `balance_paid`, `confirmed`, `completed`). Nav target `/events/:id`.

**staff** — `users u LEFT JOIN contractor_profiles cp LEFT JOIN applications a`,
`u.role IN ('staff','manager')`. Match `u.email`, `cp.preferred_name`, `cp.phone`,
`cp.email`, `a.full_name`, `a.phone`. Display name is
`COALESCE(cp.preferred_name, a.full_name, u.email)`. `detail` is a humanized
`onboarding_status` (for example "Active bartender", "Applicant (interviewing)",
"Rejected applicant"). Nav target `/staffing/users/:id`.

Response shape:

```json
{
  "results": {
    "clients":   [{ "type": "client",   "id": 12, "name": "...", "detail": "..." }],
    "proposals": [{ "type": "proposal", "id": 44, "name": "...", "detail": "..." }],
    "events":    [{ "type": "event",    "id": 51, "name": "...", "detail": "..." }],
    "staff":     [{ "type": "staff",    "id": 9,  "name": "...", "detail": "..." }]
  }
}
```

The frontend derives the nav path from `type` + `id`, so the payload stays lean and
route strings stay with the routing code.

Event-type labels use `getEventTypeLabel` from `server/utils/eventTypes.js`. Phone and
date values are returned raw; the client formats them (`formatPhone.js` exists
client-side, none server-side).

No schema change. The dataset is small, so `ILIKE '%...%'` and `regexp_replace` scans
are instant and need no index.

## Frontend

### `CommandPalette` changes

- New state: `results`, `loading`.
- On the input value changing, debounce roughly 200ms via `useDebounce`; when the
  trimmed value is 2 or more characters, call
  `api.get('/admin/search', { params: { q } })`.
- Stale-response guard: hold the latest query in a ref (or an incrementing request id)
  and drop any response whose query no longer matches the current input.
- Render live result groups **Clients / Proposals / Events / Staff** above the existing
  static "Jump to" and "Create" groups. Each row shows an icon, the name, and the
  `detail` sub-label.
- Item click navigates to the derived path and closes the palette, reusing the `go()`
  pattern already in the file.
- States: while a request is in flight show a subtle "Searching…"; with a 2-plus
  character query and zero results across all four groups show "No matches for
  '<q>'."; under 2 characters show only the static groups (current behavior).
- Network error fails quietly: the static groups stay usable, with an optional muted
  "Search unavailable" line.
- The static page-jump groups keep their existing substring filter, so typing "events"
  still jumps to the Events page.

### Path derivation

`client` to `/clients/:id`, `proposal` to `/proposals/:id`, `event` to `/events/:id`,
`staff` to `/staffing/users/:id`.

## Out of scope

- Searching by proposal token or id, event notes, drink plans, invoices, cocktails.
- Archived proposals (the client record still surfaces the person).
- Fuzzy or typo-tolerant matching. Substring only.
- Search on the staff portal or public site. Admin shell only.
- Result pagination. Capped lists are enough.

## Testing

- Backend: unit-test the endpoint. Name / email / phone partial matches per group;
  phone match across formatted and unformatted stored values; the under-2-character
  short-circuit; LIKE-metacharacter escaping; the `requireAdminOrManager` guard.
- Frontend: manual. `Cmd/Ctrl+K`, type a partial name and confirm all four groups
  populate; type a phone fragment and confirm matches; click each result type and
  confirm it lands on the right detail page; fast typing exercises debounce and the
  stale-response guard; confirm the empty state.

## Docs to update

- `ARCHITECTURE.md`: add `GET /api/admin/search` to the Admin route table.
- `README.md`: add `server/routes/admin/search.js` to the folder tree; add a
  global-search note to Key Features.
