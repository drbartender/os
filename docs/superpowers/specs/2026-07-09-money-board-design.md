# Money Board: Dashboard + Financials merged surface (design spec)

Date: 2026-07-09. Brainstormed live against the MoneyBoard design-session export
(`Dashboard + Financials.dc.html`, converged option 2a) and the original prompt
(`docs/dashboard-financials-design-prompt.md`). The prompt's §"Data contracts"
remains LAW: `GET /api/proposals/dashboard-stats` and `GET /api/proposals/financials`
keep their params and shapes exactly. Everything below is presentation, interaction,
and additive-only extensions to OTHER existing endpoints.

## 1. Decision summary

- **One merged surface.** Dashboard absorbs Financials (converged 2a). Nav loses
  the Financials item; the merged page (nav label "Overview") carries two tabs:
  Overview and Payouts (with the unmatched-count warn badge). Canonical route:
  the merged page KEEPS `/dashboard` (relabeled Overview), so bookmarked
  `useMetricsFilter` URL state survives. `/financials` redirects to `/dashboard`;
  `/financials?tab=payouts` redirects to `/dashboard?tab=payouts`;
  `/financials/payroll` keeps working unchanged. Straggler sweep: remove the
  CommandPalette Financials entry and relabel the PayrollPage "Financials"
  back-link to Overview.
- **Role gating (fleet blocker, resolved).** The merged page is reachable by
  admins AND managers. Any card whose backing endpoint is admin-only gates BOTH
  its fetch and its render on `isAdmin`, replicating the existing
  `Dashboard.js` applications-fetch pattern, so a manager never fires the call
  and never trips the Sentry `role_denial` audit. Concretely: the Payroll card
  and the payroll-overdue Needs-you item are admin-only and simply absent for
  managers. The payroll route guards are NEVER loosened to admit managers;
  payout dollar amounts must not widen beyond who can see them today.
- **Two bands, one rule.** Band 1 (top) is live and ignores the metrics filter:
  Needs-you strip, compact Upcoming-events card, Payroll card, Pipeline card.
  Band 2 obeys the filter bar entirely: date presets, basis lens, History control,
  stat tiles, revenue chart, Funnel and Lead-spend cards, Proposals and Payments
  lists. (One noted exception: the Outstanding tile's value follows the endpoint
  as today, but its meaning and its drill-out are point-in-time open balances,
  so the link carries no date params; see §5.) Every element is in exactly one band and its filter behavior follows from
  that placement. (This is option 1b's triage/analysis philosophy inside 2a's
  single surface.)
- **Interaction law (the operator's requirement, verbatim intent: no dead clicks).**
  Every number is classified by one test: does it count real rows?
  Row-backed numbers LINK OUT to the real list surface with filters pre-applied,
  carrying the exact semantics of the number clicked (axis, range, status, era).
  Aggregate-backed numbers (anything blending the frozen CC ledger, or pure math
  like avg event) EXPAND IN PLACE. Anything with no target must not look
  clickable: no hover affordance, default cursor. The click map in §5 is
  exhaustive and normative.
- **Rainbow chart survives.** The instrumented chart must honor
  `data-palette="rainbow"`: pride-gradient stroke and vertically masked gradient
  area on the hero series, heavier stroke width, secondary series dashed. The
  converged mock silently dropped this by hand-rolling its SVG; the build ports
  the treatment in. Hard requirement. Deliberate series swap: today the gradient
  rides `keys[0]`, which is the basis (Booked) series; on the new chart the
  gradient follows the new HERO series, Collected. What is preserved is the
  look (one rainbow line with faded rainbow area plus one thin companion line),
  not the literal series identity. This is intentional, not a porting error.
- **Era framing is conditional and self-retiring, never structural.** Every
  era-related element (chart cutover marker, quiet notes near lists, era-split
  lines inside expansions) renders only when the selected range overlaps the
  ledger era (Dec 2024 to May 2026), and always as a footnote, never a frame.
  A range that is entirely native shows zero era artifacts. The History tri-state
  stays (LAW) but remains the demoted ghost button from the mock, defaulting to All.

## 2. Layout (desktop)

Page header: title + subtitle, actions = New proposal (primary) only. The mock's
Payroll header button is dropped; the Payroll card replaces it (nav entry stays).

Band 1, live zone:
1. Needs-you strip (full width, the mock's 3-across grid, growing rows as needed).
   Item types: unstaffed event, proposal viewed/aging, unmatched payouts, payroll
   overdue, prep queue stages (§7). Priority coloring as today (danger/warn/info),
   ordered by urgency then event proximity.
2. Two-column row: Upcoming events card (wide, left) + right stack of Payroll
   card and Pipeline card. Upcoming events is the current dashboard table made
   compact: next 6, client + type, date + relative day, staffing pills, status
   chip, total, balance, plus a new per-row prep pill (§7). Rows are ClickableRow
   to the event; View all goes to `/events`.

Band 2, analysis zone:
3. Tab seg (Overview | Payouts). Payouts tab renders `StripePayoutsTab` as today
   plus the new `show=unmatched` focus param (§5).
4. Filter row: date preset chips (This month / Last month / Quarter / YTD /
   Last 12 / All time / Custom), basis seg (Booked / Scheduled / Paid), History
   ghost button (All / Since May '26 / Before May '26). All state lives in the
   URL via the existing `useMetricsFilter`.
5. Stat tiles: Close rate, Collected, Outstanding, Avg event, Lead spend.
6. Revenue chart card (instrumented, §4).
7. Grid: Funnel card + Thumbtack lead-spend card.
8. Proposals-in-range table, Payments-in-range table (era note conditional).

Money formatting: the VISUAL rule is aggregates round to whole dollars,
row-level money always shows cents. The implementation rule (fleet
cross-confirmed): unit-normalize at the call site, never inside a shared
divide. Proposals money is DOLLARS (`total_price`, `amount_paid`); payments
and invoices are CENTS; some aggregates arrive as `*Cents` fields
(`unlinkedRefundsCents`, `leadSpend.*Cents`) and need a cents-to-whole-dollar
helper that does not exist yet. A single shared helper that divides by 100
would render one of the two tables 100x off; each call site picks the helper
matching its unit.

**Fetch and failure isolation (fleet cross-confirmed):** no single page-level
loading gate. Band 1 cards fetch independently, each with its own catch,
degrading card-by-card to a quiet placeholder (the payroll endpoint failing or
403ing can never blank the page). Band 2's two LAW fetches fail into an
analytics-zone error state with retry, leaving Band 1 untouched. Loading
skeletons render per zone, not per page.

## 3. Component and file shape

`Dashboard.js` (347 lines) would blow past the soft cap absorbing all this.
Split into `client/src/pages/admin/overview/` with `OverviewPage.js` composing:
`NeedsYouStrip.js`, `UpcomingEventsCard.js`, `PayrollCard.js`, `PipelineCard.js`,
`MoneyTiles.js` (tiles + expansions), `RevenueChartCard.js` (instrumented chart),
`FunnelCard.js`, `LeadSpendCard.js`, `RangeTables.js` (proposals + payments).
The old `Dashboard.js` and `FinancialsDashboard.js` retire; routes point at
`OverviewPage`. `AreaChart.js` retires too, once the instrumented chart lands:
`Dashboard.js` was its only consumer (plan-fleet correction to this spec's
earlier "stays for other consumers" assumption). Its rainbow gradient defs are
extracted into a tiny shared module (`rainbowDefs.js`) that both it (interim)
and the new chart render, then the old component is deleted.

## 4. The instrumented revenue chart

Base behavior from the converged mock: date presets re-scope the series; Day /
Week / Month granularity seg (auto-picked from range length, overridable);
Compare toggle overlays the prior period as a neutral dashed line with a delta
readout in the chart footer (disabled for All time, partial-prior caption when
the prior window clips Dec 2024). Era cutover marker (thin vertical line +
"DRB OS LIVE" label) only when the range spans the cutover.

Additions from this session:
- **Hover readout.** Pointer over the plot shows a crosshair + tooltip with the
  point's period label and each visible series value.
- **Click to zoom.** On fine pointers (mouse), clicking a point sets the date
  filter to that point's period (month click = that month, week click = that
  week). The whole board re-scopes; this is the chart acting as the page's
  navigation instrument. Escape hatch is the ordinary preset chips (and browser
  Back, since filter state is URL state). **Touch disambiguation (fleet
  blocker, resolved):** on coarse pointers, tap shows the tooltip, and the
  tooltip carries a small "Zoom to <period>" button; direct tap never zooms.
  **Zoom floor:** at Day granularity, points are single days and zooming is
  disabled (tooltip only, default cursor on points, per the no-false-affordance
  rule).
- **Legend toggles.** Legend chips (Collected, Booked, Prior when active)
  toggle series visibility. Last visible series cannot be toggled off.
- **Transient state rules.** Only the date range/basis/era live in the URL
  (via `useMetricsFilter`, as today). Granularity override, Compare, and legend
  visibility are component state: a preset change or zoom click resets Compare
  to off and granularity back to auto; legend visibility resets on remount.
- **Timezone.** Preset chips, click-to-zoom ranges, and the era-overlap test
  all compute in America/Chicago (the business timezone payroll already uses),
  pinned in one shared range helper. Note: `useMetricsFilter.presetRange`
  computes UTC today; this change is shared with existing consumers of the
  filter bar and must be verified against how the server's `dateClause` reads
  `from`/`to` so month boundaries cannot drift a row across ranges.
- **Rainbow.** Under `data-palette="rainbow"`: hero series (Collected) takes the
  pride-gradient stroke + masked gradient area; Booked stays thin accent;
  Compare overlay stays neutral gray dashed regardless of palette so the
  comparison always reads.

## 5. Click map (normative)

Row-backed, LINK OUT (all links carry the current range/axis semantics of the
number, per the interaction law):

| Element | Target |
|---|---|
| Outstanding tile | `/proposals?balance=open` (live, point in time, no date params by design) |
| Funnel "Quoted" | proposals list, `cohort=quoted`, current range (predicate mirrors `qSent`: `sent_at IS NOT NULL`, `sent_at` in range, archived included) |
| Funnel "Won" | proposals list, `cohort=won`, current range (predicate mirrors `qAccepted`: `accepted_at IS NOT NULL`, `accepted_at` in range; NOT `tab=won`, whose `status=accepted` mapping excludes the paid statuses and cannot reconcile) |
| Funnel "Lost" | proposals list, `cohort=lost`, current range (predicate mirrors `qLostValue`: `sent_at IS NOT NULL AND status = 'archived'`, `sent_at` in range; native by definition) |

Each `cohort` value implies its own date column exactly as the mirrored metric
query does (quoted/lost date on `sent_at`, won on `accepted_at`); when `cohort`
is present it supersedes the `axis` param, which exists for the human-facing
filter bar.
| Funnel "Open now" | proposals list, `tab=active`, status sent+viewed+modified (live, no date) |
| Pipeline rows | proposals list, that exact status (`draft` row uses `tab=draft`) (live, no date) |
| Lead-spend "Attributed" | `/proposals?source=thumbtack&cohort=won` + current range |
| Payouts tab badge / unmatched Needs-you item | Payouts tab with `show=unmatched`: the param rides the page's `useUrlListState` and is passed to `StripePayoutsTab` as a prop; the tab filters its payout rows to those carrying unmatched lines and auto-expands their detail. If the current list response lacks a per-payout unmatched flag (unmatched lines load lazily per detail today), add the flag additively to the existing payouts list endpoint |
| Proposals/Payments table rows | proposal detail (ClickableRow + EntityLink, as elsewhere) |
| Table card View-alls | full proposals list with the same filters; payments has no standalone page, its card paginates in place |
| Upcoming-events rows | event detail; prep pill links straight to the event's drink-plan tab |
| Payroll card | `/financials/payroll` (with `?tab=history&period=<id>` when showing a closed period; the bare `?period=` form is ignored by `PayrollPage`, which only feeds `period` to the history tab) |
| Needs-you items | existing deep-link pattern (event / shift / proposal / hiring), plus new targets: payroll page, event drink-plan tab, payouts tab |
| Grouped prep item ("N waiting on shopping lists") | `/drink-plans?tab=submitted` |

Aggregate-backed, EXPAND IN PLACE (inline panel under the tile, one open at a
time, chevron affordance so expandability is visible):

- **Close rate** (flagship): sent cohort, accepted from cohort, pending, median
  days to accept. Era-split line (blended vs native vs CC percentages) only when
  the range overlaps the ledger; the native line inside it links out to the
  cohort rows; the CC line is inert and styled non-interactive.
- **Collected**: gross collected, refunds netted, unlinked-refunds footnote,
  conditional era-split line; jump link scrolls to Payments-in-range.
- **Avg event**: the division shown explicitly (booked dollars / won events),
  conditional era split; "N events" links to the won list in range.
- **Lead spend tile**: no expansion; the Lead-spend card below IS its detail
  (total, attributed, charged, attribution bar, unlinked-refunds note). Tile
  click scrolls to the card. No Thumbtack lead-row list page gets built.

Non-interactive by declaration (must not look clickable): funnel footer notes,
era notes, chart axis labels, the era marker (tooltip only), CC lines inside
expansions, tile sub-lines.

## 6. Proposals list: expanded filters (server + client)

`ProposalsDashboard` keeps tabs (`active/draft/won/paid/archive/all`), search,
source, and adds, all via `useUrlListState` so drill-outs are plain links and
state survives refresh/Back:

- **Date range**: same preset chips as the metrics bar plus custom, with a
  compact axis toggle: **Event date** (default, matches the financials-list
  precedent "a list is rows of events") or **Sent** (`sent_at`, the cohort axis
  funnel drill-outs use so list counts reconcile exactly with the metric
  clicked).
- **Status chips**: sent / viewed / modified, narrowing within the active tab.
- **Event type** select (the existing event-type vocabulary + custom).
- **Open balance** toggle (accepted-side rows with `total > amount_paid`).

Server: extend the existing `GET /api/proposals` list route with
`from`, `to`, `axis` (`event|sent`), `status` (CSV, whitelisted), `event_type`,
`balance=open`, and `cohort` (`quoted|won|lost`). Parameterized SQL only,
X-Total-Count preserved so the list header count stays truthful (that count is
what makes drill-outs verifiably reconcile). No changes to the two LAW metrics
endpoints. Rules folded in from the fleet:

- **`cohort` mirrors the metrics SQL exactly** (`qSent` / `qAccepted` /
  `qLostValue` predicates), because tab shorthand cannot reconcile: `tab=won`
  maps to `status=accepted` today, which excludes deposit_paid, balance_paid,
  confirmed, and completed rows that the funnel's Won number counts.
- **`axis` and `cohort` select columns/predicates, so they are server-side
  enums mapped to fixed SQL fragments, never interpolated.** `event_type` and
  `status` values are parameterized WHERE values; unrecognized `status` values
  are silently dropped (stale drill-out links degrade, never error). The
  existing single-value `status` form keeps working.
- **`from`/`to` are validated as `YYYY-MM-DD` server-side; a malformed value is
  ignored, not passed to Postgres** (a bad cast 500s, the same failure class as
  the UUID-token gotcha).
- **Param precedence:** status chips narrow within the active tab; a
  contradictory combination (`balance=open` on `tab=draft`, a status chip
  outside the tab's bucket, `axis=sent` where rows were never sent) is legal
  and yields the honest empty state: "No proposals match these filters" plus a
  one-click Clear filters affordance. `axis=sent` excludes NULL `sent_at` rows
  by definition.
- **Reconciliation is count-only past the first page:** the header count
  (X-Total-Count) is the number that must match the metric clicked; the list
  renders its existing first-50 page with the existing "showing first 50 of N"
  copy.

Payments-in-range card gains a small type filter (deposit / balance / refund)
client-side over the already-returned rows; no server change.

## 7. Prep queue: potion planner + shopping list

Predicate (pinned at build time against the landed Potions code, which is
merging ahead of this): a plan whose client work is finished but which is
waiting on Dallas. Two stages, both queued in Needs-you with distinct labels:

1. **"<Client> finished the potion planner · waiting on shopping list"**:
   plan `status = 'submitted'` (or consult-finalized equivalent) with no
   approved shopping list. Links to the event's drink plan (event side is
   canonical).
2. **"<Client> shopping list needs review"**: `shopping_list_status =
   'pending_review'` (the state the Potions regenerate flow introduces).

Priority scales with event proximity. The upcoming-events card's per-row prep
pill uses the Potions five-status chip vocabulary (do not invent a parallel
one): not started / with client / needs shopping list / list to review /
approved. Data comes from the Potions-enriched `GET /api/drink-plans` list
(shopping_list_status + guest_count land there in Potions Lane C); the
dashboard already fetches shifts and proposals, so the pill is a client-side
join on proposal id. Zero new server work expected; if Potions shifts under us,
this section re-pins, not the other way around.

**Lane dependency and partial-ship behavior: the prep pieces (Needs-you queue
items AND the upcoming-events prep pill) both live in the single Potions-gated
prep lane.** The upcoming-events card ships in its own lane WITHOUT the pill;
the prep lane adds the pill and the queue items after Potions merges. Null
handling: an upcoming event with no linked drink plan renders no pill at all
(not an empty chip); a plan missing the enrichment fields renders no pill
rather than a wrong state. Every other lane in this spec is independent of
Potions.

## 8. Payroll card

Payday rhythm: periods accrue Monday through Sunday, paid the following Tuesday.
The card is payday-aware; the headline is always "what is the next check":

- Monday through payday (closed period unpaid): **"Due Tuesday"** + the closed
  period's total + staff count. Past Tuesday and unpaid: card flips to warn AND
  a payroll-overdue item appears in Needs-you.
- Otherwise: **"Accruing this week"** + current period total so far + "pays Tue
  <date>".

Sub-lines: N staff, deferred-tips line only when nonzero. Data sources, pinned:
`/admin/payroll/periods/current` for the accruing state (it returns
`{period: null}` when nothing is open, which renders a quiet "No open period"
card state, not an error), and the periods LIST endpoint (`/admin/payroll/
periods`) for the most recent closed period's status and total (the
due/overdue decision). An endpoint error degrades the card to a link-only
"Payroll" card; it never blanks the page (§2 isolation rule). Whole card links
to `/financials/payroll` (`?tab=history&period=<id>` for the closed period).
Admin-only per §1 role gating: managers never render the card or fire the
fetches. Read-only surfacing; no process or mark-paid actions on the card; no
payroll logic changes; nothing touches accrual or payout code paths; route
guards stay exactly as they are.

## 9. Era treatment rules (consolidated)

- Cutover marker, list era notes, and expansion era-split lines render ONLY
  when the active range overlaps the ledger era. Boundary pinned: the era test
  is `range.from < 2026-05-15` (the actual cutover date, not "May 2026"),
  evaluated in America/Chicago like every other range computation (§4).
- No CheckCherry naming on-surface (LAW); the era is named only inside the
  History control ("Before May '26" framing).
- CC-inclusive numbers never link out directly; their expansions expose the
  native portion as the link.
- History control: ghost button, default All, restyled per mock. The tri-state
  modes and semantics are unchanged (LAW).

## 10. Mobile and skins

- Mobile follows the 1c 390px pattern adapted to 2a: filter chips in a
  horizontally scrollable row (own container), tiles as a 2-up grid, chart
  scales inside its container with larger tick fonts, tables collapse to the
  queue-item row pattern, Needs-you stacks. No page-level horizontal scroll;
  wide tables scroll in their own wrapper (LAW).
- Both skins (apothecary + After Hours) and both density modes hold; tokens
  only, vanilla CSS in `index.css`, no new deps.
- Rainbow palette applies on both skins as today.

## 11. Out of scope now, committed next

**Immediate follow-up lane (committed, not wish-list): split-by metrics.**
Close rate and revenue split by event type and by lead source (Thumbtack vs
direct). Additive `group_by` capability on the metrics layer (new sibling
queries in `metricsQueries.js`, additive response fields or a sibling endpoint;
the two LAW contracts stay backward-compatible). Surface: a split control on
the Funnel card and chart. Queue this lane immediately after the money board
ships; it is the difference between a scoreboard and a tool that answers
"where is it coming from". Native-era only, honestly labeled (the frozen
ledger keeps no type/source detail).

Wish list (unchanged from the mock, future server lanes): close-rate trend by
cohort month, seasonality overlay, repeat-client rate, refund rate,
quote-to-first-view latency, trend minis inside tile expansions.

## 12. Definition of done

- All click-map entries implemented; a manual sweep confirms no element invites
  a click it cannot honor, and drill-out counts reconcile with the clicked
  number on native-only ranges (count-only reconciliation via X-Total-Count for
  cohorts past the first page).
- Manager account smoke: loading Overview as a manager fires zero admin-only
  requests (no payroll card, no 403s, no Sentry role_denial noise).
- `README.md` (folder tree) and `ARCHITECTURE.md` updated for the new
  `client/src/pages/admin/overview/` components, the retired
  `Dashboard.js`/`FinancialsDashboard.js` pages, and the proposals list route's
  new params, per the Mandatory Documentation Updates table.
- Rainbow palette verified on the new chart in both skins.
- Era artifacts verified absent on a fully native range and present on All time.
- `cd client && CI=true npx react-scripts build` passes (Vercel gate).
- Both skins, both breakpoints smoked; chart causes no page-level horizontal
  scroll at 390px.
- Server additions (proposals list params) covered by route tests; LAW endpoint
  shapes asserted unchanged.
