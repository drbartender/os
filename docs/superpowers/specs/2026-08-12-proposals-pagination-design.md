# Proposals list pagination, design

**Date:** 2026-08-12
**Status:** approved in brainstorm (Dallas, 2026-08-12)
**Scope:** `client/src/pages/admin/ProposalsDashboard.js` only. No server change.

## Problem

The Proposals dashboard fetches one page of 50 rows and prints
`219 proposals · showing first 50` in the footer (`ProposalsDashboard.js:477`).
There is no control to reach rows 51 and beyond. Prod today holds 316 proposals,
219 of them in the Active tab, so roughly three quarters of the Active bucket is
unreachable from that screen.

The server side is already built for this. `server/routes/proposals/list.js`
accepts `?page` and `?limit` (clamped to [1, 200], default 50), sorts
server-side from a whitelist with a `p.id` tiebreaker so page boundaries are
deterministic, and returns the unpaginated total on the `X-Total-Count` header
with `Access-Control-Expose-Headers` set. The client reads that header
(`:139`) to render the "showing first" notice but never sends `page`. So this is
a client-only gap.

## Not in scope

**Events and shifts stay as they are** (Dallas, 2026-08-12: "I like it all on
one page"). For the record, since it came up and will matter later:
`GET /shifts` (`server/routes/shifts.js:138`) returns every row under a hard
`LIMIT 500` with no count and no truncation notice, and `EventsDashboard` filters
and sorts that full dump client-side. Prod has 76 shifts, 18 upcoming, so nothing
is hidden today. The latent hazard is that the cap is `ORDER BY s.event_date ASC
LIMIT 500`, which keeps the OLDEST 500. Once the table crosses 500 rows the
Upcoming tab silently starts emptying, because the surviving 500 will all be past
events. Deferred deliberately, not overlooked.

## Accepted tradeoff: option groups can straddle a page

The option-group rollup runs in the browser after the fetch (`:164`): siblings
sharing a non-null `group_id` collapse to one row carrying the `_optionCount`
badge. That is safe today only because all 50 rows arrive together.

Once pages exist, a group whose members span a page boundary renders on both
pages, with the badge splitting (for example "2 options" on page 1 and then
"1 option" on page 2). A 50-row fetch also renders slightly fewer than 50 rows
whenever a group collapses.

Prod has 13 groups over 36 proposals, largest group 3. Under the default
newest-first sort siblings were created together and sit adjacent, so a split is
uncommon; sorting by price or client is what scatters them.

**Decision: accept it.** Collapsing groups inside the SQL would mean rewriting
the list query whose WHERE clause is deliberately kept identical to
`metricsQueries` for funnel reconciliation (a mismatch there is silent and breaks
reconciliation), plus matching surgery on the COUNT. Not worth it for a cosmetic
duplicate. Accepting keeps this change entirely client-side with zero server risk.

The footer label is designed around this (see below).

## Design

### Page lives in the URL

Add `page: '1'` to `LIST_DEFAULTS`. `useUrlListState` omits default values from
the query string, so page 1 leaves the URL as `/proposals` and only page 2 and up
write `?page=2`. Refresh, Back, and the admin cross-nav drill-out links therefore
all restore the page you were on, the same way they already restore tab and
filters. The hook writes with `replace: true`, so paging creates no new Back
stops, consistent with how every other control on that screen behaves.

### Page joins the existing query builder

The `queryString` memo sets `page` when it is above 1, and takes `page` into its
dependency array. `fetchProposals` already re-runs whenever `queryString`
changes, so no new effect and no new fetch path.

### Every filter change resets to page 1

This is the defect that makes a pager feel broken: sitting on page 4, clicking
the Draft tab (12 rows), and landing on an empty table.

All existing filter writes go through one wrapper that merges `page: '1'` into
the patch. That covers every current filter-writing `setListState` call site
(fourteen today, at `:214`, `:219`, `:225`, `:234`, `:237`, `:261`, `:270`,
`:301`, `:310`, `:320`, `:328`, `:353`, `:366`, `:376`): tab, source, the date
preset chips and custom range inputs, axis, event type, balance, the status
chips, the cohort clear, and `clearFilters`. The pager buttons
themselves keep calling `setListState` directly, since they are the one control
that legitimately sets the page.

Sort is separate ephemeral state rather than URL state, so `onSort` resets page
to 1 as well.

### The control

Replaces the footer line at `:477`:

```
Page 2 of 5 · 219 proposals · Click a row to open        [Prev] [Next]
```

Prev is disabled on the first page, Next on the last. The whole control is hidden
when the total is at or under the page size, so every view that already fits on
one page looks exactly as it does now.

A page counter rather than a `51-100 of 219` row range, on purpose: given the
accepted option-group collapse above, a 50-row fetch can render 47 rows, and a
row range would contradict what is on screen. A page counter cannot be wrong that
way.

### Stale-page guard

Archive a proposal while sitting on the last page, then refresh, and the server
returns an empty page for a page number that no longer exists. After a fetch, if
the rows come back empty and page is above 1, snap to the last page that does
exist (`Math.ceil(total / 50)`). Prevents a dead-end blank table.

## Verification

No new test file. The page arithmetic is `Math.ceil(total / 50)`, there is no
existing ProposalsDashboard render test to extend, and a new one would mostly
exercise React Router rather than this change.

Instead:

1. `CI=true react-scripts build` (the Vercel lint gate, also enforced by
   `.husky/pre-push` for any push touching `client/`).
2. The `useUrlListState` suite, since this change leans on that hook harder than
   any current caller (a new key, and default-omission behavior now load-bearing
   for the URL staying clean on page 1).
3. Browser walk on the dev server: page through Active to the last page and back;
   jump to page 3 then flip to the Draft tab and confirm it lands on page 1 with
   rows visible; sort by price from page 2 and confirm the reset; confirm the
   control is absent on a tab with fewer than 50 rows.
