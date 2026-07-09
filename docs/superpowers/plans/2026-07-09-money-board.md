---
spec: docs/superpowers/specs/2026-07-09-money-board-design.md
lanes:
  - id: mb-a-list-filters
    footprint:
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud.filters.test.js
      - server/utils/metricsQueries.js   # EXPORT-ONLY diff (task A1.2): export NOT_DEAD for predicate reuse; zero behavior change
      - client/src/hooks/useMetricsFilter.js
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/components/adminos/format.js
      - client/src/index.css
    blockedBy: []
    review: standard   # crud.js is not on the sensitive list and the lane is read-path only (WHERE building, no money math, no writes); escalate to full-fleet if it ends up touching pricing, payment status, or any write route
  - id: mb-b1-shell
    footprint:
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/pages/admin/overview/UpcomingEventsCard.js
      - client/src/pages/admin/overview/PipelineCard.js
      - client/src/App.js
      - client/src/components/adminos/nav.js
      - client/src/components/adminos/CommandPalette.js
      - client/src/pages/admin/payroll/PayrollPage.js   # back-link relabel only
      - client/src/index.css
    blockedBy: []
    review: standard   # client-only; include ui-ux-review per new-surface convention
  - id: mb-b2-analysis
    footprint:
      - client/src/pages/admin/overview/MoneyTiles.js
      - client/src/pages/admin/overview/FunnelCard.js
      - client/src/pages/admin/overview/LeadSpendCard.js
      - client/src/pages/admin/overview/RangeTables.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/pages/admin/Dashboard.js          # DELETE
      - client/src/pages/admin/FinancialsDashboard.js # DELETE
      - client/src/App.js                             # drop retired lazy imports
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
      - docs/fix-list-remaining-2026-07-02.md
    blockedBy: [mb-a-list-filters, mb-b1-shell]
    review: standard   # owns ALL docs edits for every lane (tree adds for b1/b2/b3/c/d/e, page deletions, route-param table) to avoid write-write conflicts on README/ARCHITECTURE
  - id: mb-b3-chart
    footprint:
      - client/src/pages/admin/overview/RevenueChartCard.js
      - client/src/components/adminos/rainbowDefs.js
      - client/src/components/adminos/AreaChart.js   # import shared defs only; rendering unchanged
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/index.css
    blockedBy: [mb-a-list-filters, mb-b1-shell]
    review: standard   # client-only; ui-ux-review on the chart in both skins INCLUDING data-palette="rainbow"
  - id: mb-c-payroll-card
    footprint:
      - client/src/pages/admin/overview/PayrollCard.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/index.css
    blockedBy: [mb-b1-shell]
    review: standard   # client-only read of admin payroll endpoints; the blocker-grade requirement is the isAdmin fetch gate (task C1); escalate if any server payroll file gets touched (it must not)
  - id: mb-d-payouts-focus
    footprint:
      - client/src/pages/admin/StripePayoutsTab.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
    blockedBy: [mb-b1-shell]
    review: standard   # client-only; the payouts list endpoint already returns per-row unmatched_count, no server diff
  - id: mb-e-prep-queue
    footprint:
      - client/src/pages/admin/overview/PrepQueue.js
      - client/src/pages/admin/overview/UpcomingEventsCard.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/index.css
    blockedBy: [mb-b1-shell]   # PLUS external gate: the Potions merge must be on main (enriched GET /drink-plans with shopping_list_status); verify before cutting this lane
    review: standard
---

# Money Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Lanes are built via the repo's think-on-main/build-in-lanes model (`npm run worktree:new`, squash-merge via `scripts/merge-lane.sh`).

**Goal:** Merge Dashboard + Financials into one Overview money board: live triage band on top, filtered analysis band below, every number either linking out with exact semantics or expanding in place, with the rainbow chart preserved.

**Architecture:** Client-side re-composition over unchanged data contracts. The two LAW endpoints (`/api/proposals/dashboard-stats`, `/api/proposals/financials`) are untouched; the only server diff in the whole plan is additive query params on the existing `GET /api/proposals` list route. New page lives at `client/src/pages/admin/overview/`, composed of focused cards; old `Dashboard.js` / `FinancialsDashboard.js` are deleted at the end of lane b2.

**Tech Stack:** React 18 (CRA), React Router 6, vanilla CSS tokens in `index.css`, existing `useMetricsFilter` / `useUrlListState` hooks, node:test route tests.

## Global Constraints

- The two LAW endpoints keep their params and shapes exactly; route tests assert existing fields unchanged.
- No em dashes in any surface copy.
- Both skins (apothecary + After Hours), both density modes, both breakpoints; wide tables scroll in their own wrapper; no page-level horizontal scroll at 390px.
- `data-palette="rainbow"` must render the pride treatment on the new chart (hero = Collected).
- Money display: unit-normalize at call site. Proposals rows are DOLLARS (`fmt$2dp`), payments/invoices are CENTS (`fmt$fromCents`), `*Cents` aggregates use the new `fmt$wholeFromCents`. Aggregates whole dollars, rows cents. Never a shared divide.
- All range computation (presets, zoom, era test) in America/Chicago. Era test: `range.from < '2026-05-15'`.
- Era artifacts render only when the range overlaps the ledger era, always as footnotes.
- Role gating: admin-only endpoints are fetched and rendered only when `user.role === 'admin'` (the existing `Dashboard.js` applications pattern). Payroll route guards are never loosened.
- Fetch isolation: no page-level loading gate; Band 1 per-card catch; Band 2 zone error + retry.
- Server tests share the dev DB: run suites one at a time with `node -r dotenv/config --test <file>`.
- Vercel gate before merge: `cd client && CI=true npx react-scripts build` (warnings fail it).
- File sizes: keep new files under 300 lines where possible; split before 700.

---

## Lane mb-a-list-filters

**Files:**
- Modify: `server/routes/proposals/crud.js` (list handler, lines ~52-127)
- Create: `server/routes/proposals/crud.filters.test.js`
- Modify: `server/utils/metricsQueries.js` (export `NOT_DEAD` only)
- Modify: `client/src/hooks/useMetricsFilter.js` (Chicago presetRange)
- Modify: `client/src/pages/admin/ProposalsDashboard.js` (filter bar)
- Modify: `client/src/components/adminos/format.js` (add `fmt$wholeFromCents`)

**Interfaces:**
- Consumes: existing list handler param pattern (`status` overrides `view`), `presetRange(preset, today)` from useMetricsFilter, `X-Total-Count` header.
- Produces (later lanes rely on these exact names): query params `from`, `to`, `axis=event|sent`, `status=<csv>`, `event_type=<value>`, `balance=open`, `cohort=quoted|won|lost`; `presetRange` computing in America/Chicago; `fmt$wholeFromCents(cents)` in format.js.

- [ ] **A1.1 Chicago presetRange.** In `useMetricsFilter.js`, seed the preset math from the Chicago calendar date instead of UTC. Replace the first three lines of `presetRange` with:

```js
const CHI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function chicagoYmdParts(now = new Date()) {
  const [y, m, d] = CHI_DATE.format(now).split('-').map(Number);
  return { y, mo: m - 1, d };
}

export function presetRange(preset, today = new Date()) {
  const { y, mo, d } = chicagoYmdParts(today);
  const d0 = (Y, M, D) => new Date(Date.UTC(Y, M, D));
  // switch body unchanged, but 'ytd' uses `d` instead of today.getUTCDate()
```

  `d0`/`iso` stay UTC-based; only the SEED (today's y/mo/d) comes from Chicago, so boundaries flip at Chicago midnight. Export `chicagoYmdParts` (lane b3's zoom uses it).
- [ ] **A1.2 Export NOT_DEAD.** In `metricsQueries.js`, add `NOT_DEAD` to the existing `module.exports`. Zero behavior change; `crud.js` imports it for the `balance=open` predicate so the two stay in lockstep.
- [ ] **A2.1 Failing route tests first.** Create `crud.filters.test.js` mirroring the harness pattern in `crud.test.js` (node:test, seeded rows, supertest-style through the router). Seed proposals covering: sent+archived, accepted+deposit_paid, accepted with open balance, never-sent draft, thumbtack source, custom event_type. Tests (each asserts row ids AND `X-Total-Count`):

```js
test('cohort=quoted mirrors qSent: sent_at in range, archived included', ...);
test('cohort=won mirrors qAccepted: accepted_at in range, paid statuses included', ...);
test('cohort=lost mirrors qLostValue: sent_at in range AND status=archived', ...);
test('cohort supersedes status/view when both present', ...);
test('axis=sent filters sent_at and excludes NULL sent_at', ...);
test('axis=event filters event_date (default)', ...);
test('status CSV whitelists and drops unknown values silently', ...);
test('single-value status keeps working (backward compat)', ...);
test('balance=open mirrors qOutstanding predicate', ...);
test('malformed from/to ignored, no 500', ...);
test('event_type parameterized, custom value safe', ...);
test('existing responses unchanged when no new params sent', ...);
```

  Run: `node -r dotenv/config --test server/routes/proposals/crud.filters.test.js`. Expected: FAIL (params not implemented).
- [ ] **A2.2 Implement the params in the list handler.** All maps are fixed server-side objects; user input never reaches SQL as text:

```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AXIS_COL = { event: 'p.event_date', sent: 'p.sent_at' };
const VALID_STATUSES = ['draft','sent','viewed','modified','accepted',
  'deposit_paid','balance_paid','confirmed','completed','archived'];
// Predicates mirror metricsQueries EXACTLY (reconciliation contract, spec §5/§6).
const COHORTS = {
  quoted: { dateCol: 'p.sent_at',     where: 'p.sent_at IS NOT NULL' },
  won:    { dateCol: 'p.accepted_at', where: 'p.accepted_at IS NOT NULL' },
  lost:   { dateCol: 'p.sent_at',     where: "p.sent_at IS NOT NULL AND p.status = 'archived'" },
};
```

  Build order inside the handler: (1) if `COHORTS[cohort]` exists, use its `where` and date column and SKIP the status/view bucket entirely; (2) else apply the existing status/view logic, then AND a CSV `status` narrowing (`p.status = ANY($n)` with the whitelisted array param) when present; (3) date range: validated `from`/`to` on `AXIS_COL[axis] || 'p.event_date'` (or the cohort's dateCol) via `col >= $n AND col <= $n`; `axis=sent` adds `p.sent_at IS NOT NULL`; (4) `event_type` as a parameterized equality; (5) `balance=open` appends (import `NOT_DEAD`): `p.accepted_at IS NOT NULL AND ${NOT_DEAD} AND (p.total_price - COALESCE(p.amount_paid,0)) > 0`. Invalid `axis`/`cohort`/dates are ignored, never erroring. COUNT query reuses the identical WHERE (existing pattern).
- [ ] **A2.3 Run the tests to green**, then run the neighboring `crud.test.js` alone to confirm no regression.
- [ ] **A3.1 `fmt$wholeFromCents`.** Add to `format.js`: `export const fmt$wholeFromCents = (n) => fmt$(Math.round(Number(n || 0) / 100));` (aggregate display for `*Cents` fields).
- [ ] **A3.2 Proposals filter bar UI.** In `ProposalsDashboard.js`, extend `LIST_DEFAULTS` to `{ tab: 'active', q: '', source: '', from: '', to: '', axis: 'event', status: '', event_type: '', balance: '', cohort: '' }`. Render under the existing Toolbar: preset chips (reuse `presetRange` + a Custom pair of date inputs), the axis seg (Event date | Sent), status chips (sent/viewed/modified, multi-toggle building the CSV), event-type select (existing vocabulary from `utils/eventTypes.js` + Custom), balance toggle. Every control writes through `setListState` so state is URL-truth. Fetch: translate listState to the query string; when `cohort` is set, show a dismissible line naming the cohort ("Won cohort, Jun 1 to Jun 30") whose dismiss clears `cohort`. Empty result with any filter active renders "No proposals match these filters" + a Clear filters button resetting to `LIST_DEFAULTS`.
- [ ] **A3.3 Header count.** Keep rendering the `X-Total-Count` total in the list header (existing "showing first 50 of N" copy). This number is the reconciliation surface; do not replace it with `rows.length`.
- [ ] **A4 Gate + commit.** `cd client && CI=true npx react-scripts build`; smoke both skins on /proposals; commit.

## Lane mb-b1-shell

**Files:**
- Create: `client/src/pages/admin/overview/OverviewPage.js`, `NeedsYouStrip.js`, `UpcomingEventsCard.js`, `PipelineCard.js`
- Modify: `client/src/App.js`, `client/src/components/adminos/nav.js`, `client/src/components/adminos/CommandPalette.js`, `client/src/pages/admin/payroll/PayrollPage.js` (back-link label), `client/src/index.css`

**Interfaces:**
- Consumes: existing fetches from `Dashboard.js` (`/shifts`, `/proposals`, `/admin/applications` behind `isAdmin`, `/proposals/dashboard-stats`), `FinancialsDashboard.js` tab pattern (`useUrlListState({ tab: 'overview' })`), `StripePayoutsTab`.
- Produces: `OverviewPage` at route `/dashboard` with slots later lanes fill: `<MoneyTiles/>`, `<RevenueChartCard/>`, `<FunnelCard/>`, `<LeadSpendCard/>`, `<RangeTables/>` (b2/b3 replace ported placeholders), `<PayrollCard/>` slot (c), prep props on `UpcomingEventsCard` (e). `NeedsYouStrip` accepts `items` (the existing actionQueue item shape `{id,type,priority,title,sub,meta,target,ref}`) so c/d/e can append typed items. Also produces the era helper, exported from `OverviewPage.js`: `const ERA_END = '2026-05-15'; export const eraOverlaps = (from) => !from || from < ERA_END;` (string compare on YYYY-MM-DD; null `from` = All time = overlaps). b2 and b3 both import it from here.

- [ ] **B1.1 OverviewPage skeleton.** Two-tab seg (Overview | Payouts with the unmatched badge from the payouts list fetch), Band 1 + Band 2 containers. Port the operational zone from `Dashboard.js` (shifts/proposals/applications fetches, actionQueue build, upcoming/unstaffed memos) INTO `NeedsYouStrip` + `UpcomingEventsCard` + `PipelineCard` as focused components. Band 2 initially hosts the CURRENT analysis JSX ported as-is from `Dashboard.js` (tiles rows, AreaChart card) so the page is complete before b2/b3 land. Fetch isolation per Global Constraints: each Band 1 fetch has its own `.catch` degrading its card to a quiet placeholder ("Couldn't load payroll" etc.); Band 2's LAW fetches render a zone-level error card with a Retry button; no page-level `loading` gate (per-zone skeletons).
- [ ] **B1.2 Routing.** `/dashboard` renders `OverviewPage`. Add redirects: `/financials` → `/dashboard` and preserve `?tab=payouts` (small `FinancialsRedirect` component reading `useSearchParams` and rendering `<Navigate replace to={tab === 'payouts' ? '/dashboard?tab=payouts' : '/dashboard'}/>`). `/financials/payroll` route untouched.
- [ ] **B1.3 Nav + palette sweep.** `nav.js`: remove the `financials` item; relabel `dashboard` item to "Overview" (id/path unchanged so nothing else breaks). `CommandPalette.js`: remove the Financials entry, relabel the Dashboard entry "Overview", keep a "Payouts" entry pointing at `/dashboard?tab=payouts`. `PayrollPage.js`: relabel the "← Financials" back-link to "← Overview" targeting `/dashboard`.
- [ ] **B1.4 Compact upcoming events.** `UpcomingEventsCard` = current dashboard table, compact density: client + type, date + relative day, staffing pills, status chip, total, balance (dollars: `fmt$`); rows `ClickableRow` to the event; View all → `/events`. Reserve a narrow `prep` column rendering nothing (lane e fills it; no empty chip).
- [ ] **B1.5 Header.** Page actions: New proposal only (Payroll button dropped per spec §2). Subtitle: "N upcoming events · M need staff".
- [ ] **B1.5b Mobile (spec §10).** At 390px: Band 1 stacks (Needs-you items single column, upcoming-events table scrolls in its own `tbl-wrap`), the tab seg and any chip rows sit in a horizontally scrollable container (own overflow, never the page), cards full-width single column.
- [ ] **B1.6 Gate + commit.** CI build; smoke both skins + 390px; verify a manager login renders the page with zero admin-only requests fired (applications fetch stays behind `isAdmin`).

## Lane mb-b2-analysis

**Files:**
- Create: `overview/MoneyTiles.js`, `overview/FunnelCard.js`, `overview/LeadSpendCard.js`, `overview/RangeTables.js`
- Modify: `overview/OverviewPage.js` (swap ported JSX for the new components), `client/src/App.js` (drop retired lazy imports)
- Delete: `client/src/pages/admin/Dashboard.js`, `client/src/pages/admin/FinancialsDashboard.js`
- Modify: `README.md`, `ARCHITECTURE.md`, `docs/fix-list-remaining-2026-07-02.md`

**Interfaces:**
- Consumes: LAW endpoint responses (`dashboard-stats`: money/funnel/pipeline/revenue; `financials`: summary/proposals/recentPayments), lane a's list params for drill-out URLs, `fmt$` / `fmt$2dp` / `fmt$fromCents` / `fmt$wholeFromCents`.
- Consumes (cont.): `eraOverlaps(from)` from `overview/OverviewPage.js` (produced in lane b1).

- [ ] **B2.1 MoneyTiles.** Five tiles per spec §2 (Close rate, Collected, Outstanding, Avg event, Lead spend), whole-dollar aggregates, deltas where the contract provides them. Expansions per spec §5 exactly: one open at a time (`useState(null)` holding the open key), chevron affordance, `aria-expanded`; Close rate = cohort math + pending + median, era-split line only when `eraOverlaps(from)`, native line links `/proposals?cohort=quoted&from&to`, CC line inert (no hover, default cursor); Collected = gross/refunds/net + `fmt$wholeFromCents(unlinkedRefundsCents)` footnote + jump link scrolling to RangeTables; Avg event = division + era split + "N events" → `/proposals?cohort=won&from&to`; Outstanding tile itself links `/proposals?balance=open` (no date params); Lead spend tile scrolls to LeadSpendCard.
- [ ] **B2.2 FunnelCard.** Quoted / Won / Lost / Open now rows (count + value), each row a real link per the spec §5 click map (`cohort=` URLs carrying from/to; Open now → `/proposals?tab=active&status=sent,viewed,modified`, no dates). Footer: median-accept + live-pipeline line, plain text, non-interactive.
- [ ] **B2.3 LeadSpendCard.** Total (`fmt$wholeFromCents(leadSpend.totalCents)`), Attributed (link `/proposals?source=thumbtack&cohort=won&from&to`), Charged count, attribution bar, unlinked-refunds footnote. Total/Charged are non-links, styled non-interactive.
- [ ] **B2.4 RangeTables.** Proposals-in-range (dollars, `fmt$2dp`) and Payments-in-range (cents, `fmt$fromCents`) tables from the `financials` response, rows ClickableRow to proposal detail, card-head View-alls (proposals → `/proposals?from&to&axis=event`; payments card paginates in place with its type filter chips deposit/balance/refund filtering the returned rows client-side). Era note above each list ONLY when `eraOverlaps(from)`: "Rows are DRB records (May 2026 onward). Totals above also count the frozen ledger, which keeps no row-level records."
- [ ] **B2.5 Pipeline links.** In b1's `PipelineCard`, make each row a link per click map (`tab=draft` for draft; `status=<key>` otherwise; accepted row → `status=accepted`). (Done here, not b1, because the URLs depend on lane a being merged.)
- [ ] **B2.6 Delete the retired pages** (`Dashboard.js`, `FinancialsDashboard.js`), remove their lazy imports/routes from `App.js` (the `/financials` redirect from b1 stays). Grep for remaining imports of either file; must be zero.
- [ ] **B2.7 Docs (owns ALL lanes' doc edits).** README folder tree: add `overview/` components (all lanes' files, including PayrollCard/PrepQueue/RevenueChartCard), remove the two deleted pages. ARCHITECTURE: route table gains the `GET /api/proposals` new params; note the merged surface + redirects. Fix-list: mark the Money Board build lanes shipped as they land; keep the split-by follow-up line.
- [ ] **B2.7b Mobile (spec §10).** At 390px: tiles render as a 2-up grid, the filter preset chips live in a horizontally scrollable row (own container), the proposals/payments tables collapse to the queue-item row pattern (client + type stacked, amount right-aligned) matching the 1c mobile mock.
- [ ] **B2.8 Gate + commit.** CI build; both skins; drill-out reconciliation smoke on a native-only range (click Won, header count matches the funnel number); era artifacts absent on This month, present on All time.

## Lane mb-b3-chart

**Files:**
- Create: `overview/RevenueChartCard.js`, `client/src/components/adminos/rainbowDefs.js`
- Modify: `client/src/components/adminos/AreaChart.js` (import shared defs), `overview/OverviewPage.js` (swap ported AreaChart card)

**Interfaces:**
- Consumes: `revenue: [{key:'YYYY-MM', m, value, paid}]` from dashboard-stats, `useMetricsFilter` (`setPreset`, custom range write), `chicagoYmdParts` from lane a, `eraOverlaps` from b2.
- Produces: `<RevenueChartCard data={revenue} filter={filter}/>`; `rainbowDefs.js` exporting `<RainbowDefs/>` (the gPrideLine/gPrideArea/gPrideAreaFade/gPrideMask defs lifted verbatim from `AreaChart.js:30-52`) plus `useIsRainbow()` reading `document.documentElement.dataset.palette`.

- [ ] **B3.1 Extract rainbow defs.** Move the four pride defs + mask from `AreaChart.js` into `rainbowDefs.js`; `AreaChart` imports and renders `<RainbowDefs/>` inside its own `<defs>`; visual output byte-identical (verify against a screenshot diff on a page still using AreaChart).
- [ ] **B3.2 RevenueChartCard.** SVG chart over the monthly `revenue` series: granularity seg Day/Week/Month is honest to the data (the contract is monthly; Week/Day render only when a custom range under ~35 days is active and the series supports it; otherwise the seg shows Month active with Week/Day disabled and non-affording). Compare toggle: overlays the prior period of equal length as neutral dashed gray, delta readout in the footer, disabled for All time, "prior period partial" caption when the prior window clips Dec 2024. Era marker via `eraOverlaps` (import from `overview/OverviewPage.js`) + range spanning 2026-05-15. Hero = Collected (`paid`), companion = basis series (`value`); rainbow mode swaps hero stroke/area to the pride treatment per spec §4.
- [ ] **B3.3 Interactions.** Hover crosshair + tooltip (period label + visible series values). Fine-pointer click on a point: write the point's period as a custom range through the filter (`month` point → first/last day of that month via `chicagoYmdParts` math). Coarse pointer (`matchMedia('(pointer: coarse)')`): tap opens the tooltip containing a "Zoom to <period>" button; direct tap never zooms. Zoom disabled at Day granularity (default cursor, tooltip only). Legend chips toggle series visibility, last one un-toggleable. Component state (granularity override, Compare, legend) resets on preset/zoom change per spec §4.
- [ ] **B3.4 Gate + commit.** CI build; smoke both skins AND `data-palette="rainbow"` (hero rainbow line + faded rainbow area + thin companion, compare overlay stays gray); 390px: chart contained, no page scroll.

## Lane mb-c-payroll-card

**Files:**
- Create: `overview/PayrollCard.js`
- Modify: `overview/OverviewPage.js` (admin-only slot), `overview/NeedsYouStrip.js` (overdue item type)

**Interfaces:**
- Consumes: `GET /admin/payroll/periods/current` → `{ period: {id,start_date,end_date,payday,status} | null, payouts: [...] }`; `GET /admin/payroll/periods` → `{ periods: [...] }`. Sum card totals from the same payout fields `PayrollHeader.js` sums (read it first; mirror, do not re-derive).
- Produces: `<PayrollCard/>` (self-fetching) and a `payroll-overdue` NeedsYou item `{type:'payroll', priority:'danger', target:'payroll'}` navigating `/financials/payroll`.

- [ ] **C1 Admin gate first.** `OverviewPage` renders `<PayrollCard/>` and builds the overdue queue item ONLY when `user.role === 'admin'` (same test `Dashboard.js` used for applications). The fetches live inside `PayrollCard`, so a manager mounts nothing and fires nothing. This is the fleet blocker; it ships in the same commit as the first fetch.
- [ ] **C2 Card states.** Decision logic per spec §8: latest closed-but-unpaid period from `/periods` → headline "Due <payday weekday>" + closed total + N staff, link `/financials/payroll?tab=history&period=<id>`; past payday and unpaid → warn styling + emit the overdue NeedsYou item; else open period from `/periods/current` → "Accruing this week" + running total + "pays Tue <payday>", link `/financials/payroll`; `{period: null}` → quiet "No open period" card; fetch error → link-only "Payroll" card. Deferred-tips sub-line only when nonzero: read `client/src/pages/admin/payroll/DeferredTipsPanel.js` first and consume the same endpoint/field it renders (mirror, do not re-derive). Whole card one `<EntityLink>`; totals whole dollars.
- [ ] **C3 Gate + commit.** CI build; smoke as admin (all four states by stubbing, at minimum due + accruing live) and as manager (no card, no requests, no Sentry role_denial in the local server log).

## Lane mb-d-payouts-focus

**Files:**
- Modify: `client/src/pages/admin/StripePayoutsTab.js`, `overview/OverviewPage.js`, `overview/NeedsYouStrip.js`

**Interfaces:**
- Consumes: payouts list rows already carrying `unmatched_count` (stripePayouts.js:38); `OverviewPage`'s `useUrlListState` (`tab`, plus new passthrough `show`).
- Produces: `<StripePayoutsTab show={show}/>`; unmatched NeedsYou item linking `/dashboard?tab=payouts&show=unmatched`.

- [ ] **D1** `OverviewPage` reads `show` from `useUrlListState` and passes it to the tab. When `show === 'unmatched'`: the tab filters its payout rows to `unmatched_count > 0`, auto-expands their detail (existing lazy per-payout fetch), and shows a dismissible filter chip ("Unmatched only · clear") whose clear deletes the param. Zero unmatched rows → the honest empty state "No unmatched payouts right now" + clear affordance.
- [ ] **D2** Point the Payouts tab badge and the unmatched NeedsYou item at `?tab=payouts&show=unmatched`.
- [ ] **D3 Gate + commit.** CI build; smoke: badge click lands filtered + expanded; clear restores the full list.

## Lane mb-e-prep-queue (gated on the Potions merge)

**Files:**
- Create: `overview/PrepQueue.js` (predicate + item builders, no JSX beyond helpers)
- Modify: `overview/UpcomingEventsCard.js` (prep pill column), `overview/NeedsYouStrip.js`, `overview/OverviewPage.js` (drink-plans fetch)

**Interfaces:**
- Consumes: Potions-enriched `GET /api/drink-plans` list (`status`, `shopping_list_status`, `has_shopping_list`, `proposal_id`); the Potions five-status chip vocabulary (reuse its map/classes, do not invent one).
- Produces: `buildPrepItems(plans, shifts)` → NeedsYou items; `prepStateFor(proposalId, plans)` → pill state or `null`.

- [ ] **E0 Verify the gate.** Confirm on main: the drink-plans list response includes `shopping_list_status` and the Potions chip map exists. If not, STOP; this lane waits.
- [ ] **E1 Predicate (pin against landed code, spec §7).** Stage 1 "waiting on shopping list": `status === 'submitted'` (or the consult-finalized equivalent the landed code exposes) AND no approved list. Stage 2 "shopping list needs review": `shopping_list_status === 'pending_review'`. One NeedsYou item per event, distinct labels per spec §7, priority scaling with event proximity, deep link to the event's drink-plan tab (event side). Grouped fallback link `/drink-plans?tab=submitted`.
- [ ] **E2 Prep pill.** Fill b1's reserved column via `prepStateFor`: Potions vocabulary chips; event with no plan or plan missing enrichment fields → `null` → render nothing (spec §7 null rule).
- [ ] **E3 Gate + commit.** CI build; both skins; smoke an event in each stage plus a no-plan event.

---

## Execution notes

- Run order: `mb-a-list-filters` ∥ `mb-b1-shell` first; then `mb-b2-analysis` and `mb-b3-chart` (both need a + b1); `mb-c-payroll-card` and `mb-d-payouts-focus` after b1, anytime; `mb-e-prep-queue` after b1 AND the Potions merge lands on main.
- Every lane: Inline Self-Check before each change; in-lane checkpoint commits are free (squash on merge); the Vercel CI build is the mechanical gate before every merge.
- `index.css` is touched by several lanes. Each lane appends ONE clearly bounded comment block (`/* overview: <lane> */ ... /* end */`) at the end of the admin-os section rather than editing shared rules, so parallel-lane merges conflict trivially or not at all.
- Reviews per front-matter; escalate any lane that strays outside its footprint (footprint drift aborts per the workflow).
