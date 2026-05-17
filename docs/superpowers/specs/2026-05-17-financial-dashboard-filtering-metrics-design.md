# Financial + Dashboard Filtering & Metrics — Design

**Date:** 2026-05-17
**Status:** Approved (design)
**Trigger:** Owner wants date-range filtering on the Dashboard and Financials pages, the ability to slice ~1.5 years of (eventually imported) history, and new sales-funnel metrics (proposals sent, accepted, conversion).

## Scope & decomposition

This work was split into two independent projects:

- **Project 1 (this spec):** Filtering + dashboard metrics. Self-contained. Builds the surface that historical data will eventually populate and be sliced by. No Check Cherry dependency.
- **Project 2 (separate spec, later):** Check Cherry data migration (~1.5 years of bookings/payments/clients). Its design is entirely gated on what Check Cherry can export and has its own thorny problems (not double-counting the live post-cutover bookings, suppressing emails/webhooks/autopay/SMS on imported rows). **Not designed or built here.** A forward-compat boundary it inherits is flagged in §5.

## Approach

**A — Shared filter component + extend the existing endpoints.** A reusable filter control on both pages; the existing `/proposals/dashboard-stats` and `/proposals/financials` endpoints grow `?from=&to=&basis=` params; SQL gains per-metric `WHERE` clauses. Server-side filtering (indexed `WHERE`, not a multi-year payload shipped to the browser) — chosen specifically because the Check Cherry backfill is coming. Rejected: a new unified Analytics page (new surface not asked for, leaves the two pages half-migrated) and client-side filtering (wrong bet with a 1.5-year backfill incoming).

## Money-type boundary (load-bearing)

- `proposal_payments.amount` → **integer cents**
- `proposals.total_price / amount_paid / deposit_amount` → **NUMERIC dollars**

The **Paid** lens sums `proposal_payments.amount` (cents); every other money figure reads `proposals.*` (dollars). Paid must divide by 100 (or the dollar figures ×100) to reconcile. Getting this wrong makes Paid off by 100×.

---

## Section 1 — The filter control

A shared `MetricsFilterBar` component (`client/src/components/`), rendered at the top of both Dashboard and Financials, one row:

- **Date range** — preset dropdown: *This month · Last month · This quarter · Year to date · Last 12 months · All time · Custom*. Custom reveals two date inputs (from / to). **Default = Last 12 months** (keeps the revenue chart looking like today; "All time" exists for when Check Cherry history lands).
- **Money lens** — 3-segment toggle: **Booked · Scheduled · Paid**. **Default = Booked.** Only money cards + revenue chart react; count metrics visibly do not. The money zone is labeled so it is unambiguous which cards the toggle drives.

**State lives in the URL** (`?from=&to=&basis=`) — refresh-safe, shareable, symmetric with the backend params. React Router 6 is already in place. Each page reads the params and passes them straight to its endpoint call. The preset is derived from / written to `from`+`to` (presets are a UI convenience; the wire format is always explicit dates, except All time = params omitted).

---

## Section 2 — Metric catalog + exact date math

**Mental model:** every proposal that has been sent sits in exactly one bucket — **lost** (`status = 'cancelled'`), **won** (`accepted_at` is set and status ≠ cancelled), or **pending** (sent, no `accepted_at` yet, not cancelled). Proposals have **no `'archived'` status** — `'cancelled'` is the only terminal/dead state (schema CHECK + comment). The three buckets partition the sent-cohort exactly: no double-counting, no gaps.

### Count / funnel metrics — always filter by their own timestamp, ignore the money lens

| Metric | Definition | Date column |
|---|---|---|
| **Sent** | count of proposals with `sent_at` in range | `sent_at` |
| **Accepted** | count with `accepted_at` in range | `accepted_at` |
| **Win rate** | **cohort**: of proposals *sent in range*, % won. won = `accepted_at IS NOT NULL AND status <> 'cancelled'`; pending = `accepted_at IS NULL AND status <> 'cancelled'`; lost = `status = 'cancelled'`. Displayed with the open count: "62% — 18 of 29 sent · 4 pending". | `sent_at` (cohort) |
| **Time-to-accept** | **median** days `accepted_at − sent_at`, over proposals accepted in range (`percentile_cont(0.5)` — median, not mean; one stale deal wrecks a mean) | `accepted_at` |
| **Pipeline outstanding** | count + Σ`total_price` of proposals currently `sent`/`viewed`/`modified`. A **live snapshot** — takes no date predicate, labeled "Current". | none |
| **Lost value** | Σ`total_price` of proposals with `sent_at` in range now `status = 'cancelled'` | `sent_at` |

Win rate is the **cohort** definition (chosen over the simpler period-ratio: accepted-in-range ÷ sent-in-range, which mixes cohorts — a deal sent in Feb, accepted in March would inflate March). Cohort is the honest answer to "is my pitch working"; the pending count is shown so the in-flight incompleteness is visible.

### Money metrics — driven by the lens toggle

| Lens | Definition | Date column |
|---|---|---|
| **Booked** | Σ`total_price`, proposals with `accepted_at` in range, **excluding** `status = 'cancelled'` (net of cancellation) | `accepted_at` |
| **Scheduled** | Σ`total_price`, proposals with `event_date` in range that reached accepted+ (`accepted_at IS NOT NULL`) and status ≠ cancelled | `event_date` |
| **Paid** | Σ succeeded `proposal_payments.amount` (cents → dollars), by payment date | `proposal_payments.created_at` |

Plus **Outstanding** as an always-on companion card: Σ`GREATEST(total_price − amount_paid, 0)` over non-cancelled accepted+ proposals with `event_date` in range — pairs with Scheduled.

**Bucket consistency:** a proposal accepted in-range then later cancelled leaves Won/Booked and enters Lost (it is `status='cancelled'`, so Won *and* Booked money exclude it and Lost includes it — win rate and Booked agree). A `completed`/`confirmed` proposal with `accepted_at` set counts as Won; one with `accepted_at` NULL and not cancelled counts as Pending (the residual bucket, so nothing falls through). This makes `Won + Pending + Lost = Sent` for any sent-cohort hold **by construction** (the reconciliation identity used for testing, §5).

---

## Section 3 — Backend

Endpoints: `GET /proposals/dashboard-stats` and `GET /proposals/financials` in `server/routes/proposals/metadata.js`. **Consumers of `/dashboard-stats`:** the redesigned Dashboard (money/funnel) **and** — pre-existing, easy to miss — `ProposalsDashboard.js` (Paid-tab count badge, reads `totals.events_count` + `pipeline[]`). The new response keeps `pipeline[]` and adds a **range-independent top-level `paidCount`** to replace the removed `totals.events_count`; that consumer must be updated in lockstep (cross-cutting consistency).

**Params (both):** `from`, `to` (ISO `YYYY-MM-DD`), `basis` (`booked|scheduled|paid`).

- Validation: date format checked, `from ≤ to`; bad input → `ValidationError` (AppError subclass, per CLAUDE.md). Omitted range = "All time" (no date predicate).
- `basis` is a **server-side whitelist → column map**: `booked`→`accepted_at`, `scheduled`→`event_date`, `paid`→`pp.created_at`. The client string only selects a key; it never reaches SQL. Unknown value → `ValidationError`.
- All predicates parameterized (`$1/$2`). No string concatenation of input.

**Per-metric WHERE, not one global filter.** Each metric carries its own date column per §2. Win rate is the cohort query over the `sent_at`-in-range set: `COUNT(*)` as sent_cohort, `COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND status <> 'cancelled')` as won, `COUNT(*) FILTER (WHERE accepted_at IS NULL AND status <> 'cancelled')` as pending; lost = sent_cohort − won − pending. Time-to-accept = `percentile_cont(0.5) WITHIN GROUP (ORDER BY accepted_at - sent_at)`.

**Revenue chart** generalizes from the hard-coded 12-month series to `generate_series(date_trunc('month',$from) … $to, '1 month')` left-joined to the chosen basis aggregate. Monthly buckets stay sane at "All time" even with the backfill (tens of bars).

**Period-over-period delta:** each headline card also computes itself over the immediately-prior equal-length window and returns `{ value, priorValue, deltaPct }`. "All time" → `deltaPct: null` (UI hides it). Prior window empty (`priorValue = 0`) → UI shows "new", not "▲∞%".

**Schema change — new indexes.** Idempotent `CREATE INDEX IF NOT EXISTS` in `schema.sql` on `proposals(sent_at)`, `proposals(accepted_at)`, `proposals(event_date)`, `proposal_payments(created_at)`. Necessary with 1.5 years of history incoming; low-risk.

**Shared metrics module — `server/utils/metricsQueries.js` (new).** Pure query builders (return `{ sql, params }` given `{ from, to, basis }`); no DB calls themselves — same pattern as `pricingEngine.js` (pure logic in `utils/`). The endpoints in `metadata.js` execute them. The bucketing/aggregation math is defined **once** here so Dashboard and Financials cannot drift (cross-cutting-consistency trap if duplicated). Keeps `metadata.js` under the file-size limit.

Both endpoints stay read-only — no transaction needed.

---

## Section 4 — Page-level changes

**Shared principle:** the filter bar governs an **analytics zone**. Operational widgets are explicitly exempt and labeled "Live" so the user is not startled when they do not react.

### Dashboard (`client/src/pages/admin/Dashboard.js`)

`MetricsFilterBar` pinned at top. Three labeled zones:

- **Money (lens-driven, labeled):** one headline card switching by lens — *Booked / Scheduled / Paid $X* — with the period-over-period delta badge. Always-on **Outstanding** companion card.
- **Funnel (range-driven, lens-independent):** new cards — **Sent** (count + $), **Accepted** (count + $), **Win rate** (cohort string), **Time-to-accept** (median days).
- **Revenue chart:** respects range + lens; title follows the lens. Lens Booked/Scheduled overlays a faint **Paid** line (cash-vs-contracted is the most useful read); Paid lens = single series.
- **Pipeline snapshot** (existing draft→accepted bar chart) stays, plus a **Lost value** stat beside it.
- **Exempt / "Live":** Upcoming events table and Needs-attention queue — inherently now/future, never date-filtered. Labeled.

### Financials (`client/src/pages/admin/FinancialsDashboard.js`)

Same `MetricsFilterBar`. Summary cards (Booked/Collected/Outstanding/Avg) become range + lens aware; **Avg = booked ÷ accepted-count in range**. Recent-payments table changes from "last 20" to "payments **in range**", wired through the existing server pagination (`?page=&limit=`).

**List tables filter by `event_date` in range, always — independent of the lens.** The lens drives only aggregate money figures. Rationale: a table is a list of events; `event_date` is the intuitive axis. Filtering the row list by accepted-date when the lens is Booked would make rows appear/vanish confusingly.

---

## Section 5 — Edge cases + testing

### Edge cases

- **Null timestamps.** A metric counts a row only if *its driving timestamp is non-null* — including "All time" (All-time Sent = `sent_at IS NOT NULL`, not "every proposal").
- **Timezone off-by-one.** `event_date` is `DATE`; `sent_at`/`accepted_at`/`proposal_payments.created_at` are `TIMESTAMPTZ`. Compare in the **business timezone** — `TIMESTAMPTZ` via `>= from AND < to + 1 day` in that TZ; `DATE` via plain `BETWEEN`. Reuse whatever timezone the app already applies to event dates elsewhere (do **not** introduce a new constant) and apply it everywhere here, or month-boundary events silently drop.
- **Empty / divide-by-zero.** Zero sent-cohort → win rate renders "—" (not `NaN`/`0%`). Money sums `COALESCE` to 0. Charts render an empty state.
- **Prior period = 0.** Delta shows "new", not "▲∞%". "All time" has no prior → no delta.
- **Cancelled-after-accepted.** Deliberate: leaves Booked, enters Lost (Booked net-of-cancellation, §2).
- **Re-sent proposals.** v1 counts by current `sent_at` — a re-send moves the proposal into the new period. Known, accepted simplification.
- **Check Cherry forward-compat (flag, do not solve).** Imported history will have `event_date` but likely no `proposal_payments` rows → the Paid lens would under-report pre-cutover. **Handed to Project 2's spec:** it must decide how historical paid money is represented (synthetic payment rows vs `amount_paid` only) so Paid stays truthful post-import. Inherited boundary, not built here.

### Testing

Correctness backbone — the **reconciliation identity**: for any sent-cohort, `Won + Pending + Lost = Sent` (won/pending/lost per §2). Exact equality, by construction. A built-in audit; baked into a verification step per lens × range.

- **Unit tests** on the pure date-bucketing/aggregation helper (real-money math warrants it): cohort win-rate, null-timestamp exclusion, period-over-period incl. prior=0 and All-time, cents↔dollars on Paid.
- **Manual matrix:** each lens × {This month, All time} — eyeball headline numbers + reconciliation identity holds.
- **Frontend:** loading / empty / error states; operational widgets unchanged when range changes; URL params round-trip on refresh.
- **Gate:** `CI=true react-scripts build` (local lint skips `client/`).

---

## Files touched

| File | Change |
|---|---|
| `client/src/components/MetricsFilterBar.*` | **New.** Shared date-range + lens control; reads/writes URL params. |
| `client/src/pages/admin/Dashboard.js` | Add filter bar; money/funnel zones; lens-aware revenue chart + deltas; label exempt "Live" widgets. |
| `client/src/pages/admin/FinancialsDashboard.js` | Add filter bar; range + lens-aware summary; payments table "in range"; tables filter by `event_date`. |
| `server/routes/proposals/metadata.js` | Add `from/to/basis` params + validation to `dashboard-stats` and `financials`; call shared metrics helper. |
| `server/utils/metricsQueries.js` | **New.** Pure shared metric query builders — single source of truth for the bucket math. |
| `server/db/schema.sql` | Idempotent indexes on `proposals(sent_at, accepted_at, event_date)` and `proposal_payments(created_at)`. |
| `README.md` / `ARCHITECTURE.md` | New component + (if added) new route module in folder tree / route table; schema index note. |

## Out of scope (not in Project 1)

- Check Cherry data migration (Project 2).
- View rate (viewed ÷ sent), deposit-vs-balance cash split, lead-source attribution — deferred; revisit only if one proves needed.
- Adaptive chart bucketing (daily/quarterly auto-switch) — monthly is sufficient for v1.
