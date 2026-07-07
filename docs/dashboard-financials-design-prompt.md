# Design prompt: Admin Dashboard + Financials become surfaces Dallas actually uses

> Per-surface prompt for a repo-linked design session. Read
> `DR_BARTENDER_REDESIGN_BRIEF.md` first and obey its §2 hard rules. Like the
> cocktail-menu prompt, this is partly a WHAT-SHOULD-THIS-SURFACE-BE
> exploration: the operator has said, verbatim, "I haven't really used the
> dashboard or the financial pages at all. They both need some work to be
> helpful to me." The data layer underneath was just rebuilt and is complete;
> the presentation is yours to rethink. The API contracts below are LAW; the
> layout, hierarchy, and what-gets-promoted are not.

## Who uses this and for what

One operator (owner-bartender) plus one assistant. Not a SaaS analytics
audience. The operator's stated interests: **close rate**, "all kinds of
metrics available," and **date filtering as the primary axis** ("I want to be
able to filter by those things, but filtering by date is more helpful").
He checks numbers occasionally and deeply, not glanceably and daily — design
for sit-down analysis sessions, not a wallboard.

## The data (complete as of 2026-07-07, this is the new part)

The business ran on CheckCherry from Dec 2024 to May 2026, then on DRB OS.
The CC era now lives in a frozen ledger (`legacy_cc_*` tables) and the
metrics layer blends it: the `include_cc` tri-state means **all** = the whole
business back to Dec 2024, **exclude** = DRB-native only, **only** = CC era
alone. Real numbers the data now supports, for grounding mock content:

- All-time collected: $136,781.35 CC era + native-era payments on top.
- CC-era close rate: 17.2% (214 booked of 1,244 quotes). Native close rate
  computes live from proposals.
- Monthly revenue series back to Dec 2024 (payments cash-basis, or booked /
  scheduled lenses).
- Funnel: sent/quoted counts + values, accepted counts + values, win rate,
  median time-to-accept (native only), lost value (native only), live
  pipeline (native only — the CC era is closed and contributes nothing to
  "pending" style numbers, by design).
- Financials: collected (refund-netted), outstanding, avg event value,
  Thumbtack lead spend (total/attributed), unlinked-refunds note, proposals
  + payments lists (native rows only — the CC era has no row-level list),
  Stripe payouts tab (settlement mirror with unmatched badge).

## The files

- `client/src/pages/admin/Dashboard.js` (347 lines) — stat row (money lens +
  outstanding + win rate + applications), funnel numbers, 24-month
  `AreaChart` revenue series, pipeline-by-status chips, needs-attention feed.
- `client/src/pages/admin/FinancialsDashboard.js` (207 lines) — overview tab
  (booked/collected/outstanding/avg-event stat row, lead-spend line,
  proposals table, recent payments table) + `StripePayoutsTab`.
- `client/src/components/adminos/MetricsFilterBar.js` — preset date ranges +
  custom range + basis lens (Booked/Scheduled/Paid) + the CC tri-state chip
  (All / Native only / CC only). `useMetricsFilter` holds state in the URL.
- Vanilla CSS in `client/src/index.css`, tokens only, both skins (apothecary
  + After Hours) must hold. No new deps.

## Data contracts (LAW — design against these, do not invent fields)

`GET /api/proposals/dashboard-stats?from&to&basis&include_cc` returns:
`{ filters, money: { basis, value, priorValue, deltaPct, outstanding,
outstandingPrior, outstandingDeltaPct }, funnel: { sent: {count,value},
accepted: {count,value}, winRate: {sentCohort, acceptedFromCohort, pending,
pct}, timeToAcceptMedianDays, lostValue, pipelineOutstanding: {count,value} },
revenue: [{key:'YYYY-MM', m:'Mon', value, paid}], pipeline:
[{key,label,count,value}], paidCount, archivedCount }`

`GET /api/proposals/financials?from&to&basis&include_cc&page&limit` returns:
`{ filters, summary: { booked, collected, outstanding, avgEvent,
unlinkedRefundsCents, leadSpend: {totalCents, attributedCents,
unattributedCents, chargedLeads, attributedLeads} }, proposals: [...],
recentPayments: [...], pagination }`

Both accept the same filter params; the filter bar component and URL-state
hook already work and can be restyled or repositioned freely.

## What must not change (hard)

1. The two endpoints and their params/shapes. New metrics = a future server
   lane, out of scope for the design session (but a "wish list" section in
   your output is welcome).
2. The tri-state semantics and date-first filtering. The chip may be
   restyled/renamed but the three modes stay.
3. No CheckCherry branding anywhere on-surface. The era is nameable only in
   the filter control (current label "CC only" is acceptable; "Before May
   2026" style era-framing is also fine). No badges, no banners on numbers.
4. Both skins, both breakpoints; wide tables scroll in their own container.
5. No em dashes in copy.

## Known content problems to solve (from the operator + reviews)

- Under "CC only" (and partially "All"), the summary numbers include ledger
  money but the proposals/payments LISTS are native-only, so the tables can
  read empty or not reconcile with the totals. The design should decide how
  the page communicates that (a quiet era note near the lists, a different
  list treatment, or something better). This is a real reviewer finding, not
  hypothetical.
- The dashboard mixes operational triage (needs-attention feed, pipeline
  chips, applications count) with analysis (funnel, revenue chart). The
  operator ignores it entirely today. Take a position: one surface that does
  both well, or a clean split (triage stays on Dashboard, analysis moves to
  Financials), or something else.
- Win rate is the metric he actually names. Give close rate a first-class
  treatment (trend over time would need the wish-list, but cohort numbers
  by date range work today).
- `avgEvent` rounds to whole dollars; money formatting is inconsistent
  across the two pages (`fmt$` vs `fmt$fromCents`). Unify visually.

## Design opportunities

- The 24-month revenue series with the full CC era loaded is the first time
  the whole business history is visible in one chart. Make that moment land.
- Prior-period deltas exist for the money stats (deltaPct); nothing else has
  comparison context. Consider what deserves it.
- The Stripe payouts tab carries an unmatched-count badge; it's the one
  genuinely operational item on Financials. Decide where it belongs.
- One restrained magical-realism moment maximum, per the brief.

## Open questions the design should take a position on

1. One combined analysis surface or Dashboard=triage / Financials=analysis?
2. Where does the era filter live: in the shared filter bar as today, or
   demoted to an "advanced" affordance since "All" is the honest default?
3. Does the proposals/payments list belong on Financials at all, or does the
   page become pure aggregates with drill-out links to the real list pages?

## Definition of done

- Mock-data preview matching the contract shapes above (use the real numbers
  given for CC-era grounding; invent plausible native-era numbers).
- Restyle/relayout of both pages + the filter bar; no new endpoints, no
  invented fields, no axios changes beyond what exists.
- The Vercel gate is `cd client && CI=true npx react-scripts build`
  (warnings fail it); the Claude Code session runs it before merge.
- Smoke both skins and both breakpoints; the revenue chart must not cause
  page-level horizontal scroll on mobile.
