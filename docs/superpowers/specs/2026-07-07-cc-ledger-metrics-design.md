# CC ledger + metrics blend (cc-import phase 2) — design, 2026-07-07

Brainstormed conversationally 2026-07-07 (section approvals ARE the approval).
Phase 1 (187 clients) is live in prod. This phase makes the CheckCherry era's
NUMBERS accessible: load the frozen ledger, delete v1's dead machinery, and
give the metrics layer honest CC-era legs. Explicitly OUT: any dashboard or
financials page redesign — Dallas doesn't use those pages today; they get
their own design-session prompt doc AFTER this data lands ("get the data in
an accessible state, then customize the pages in another session").

## Decisions (Dallas's calls)

1. **Load ALL CC history, not booked-only.** Dallas wants close rate and "all
   kinds of metrics available," so the quote denominator matters: all 1,244
   events (statuses preserved), all 353 payments/refunds, all 116
   expense/payout rows. Still zero operational footprint — the sidecar tables
   feed metrics only, never workflows.
2. **v1 is demolished.** "If it's dead it can go": the importer CLI + phases,
   the ccImport admin routes and review pages, LegacyCcPaymentsPanel, and
   CcImportBadge are deleted. URGENT UX note: since phase 1's prod apply, the
   badge renders "Imported from CC" on 187 clients in ClientsDashboard +
   ClientDetail — exactly the v1 banner noise Dallas rejected. Dies with this
   lane at next push. The `legacy_cc_*` TABLES stay (they are the new ledger
   home); the empty v1 bookkeeping tables (`cc_import_runs`,
   `cc_import_phase0_failures`, `legacy_cc_raw_imports`) stay for now as
   harmless housekeeping debt.
3. **Date filtering is the primary axis**; the existing dashboard `includeCc`
   chip (v1-era, currently inert) gets honest semantics: `all` = whole
   business including CC era, `exclude` = DRB-native only, `only` = CC era
   alone. No banners anywhere else; era is nameable only via that chip.
4. **Funnel metrics gain CC legs only where the data is honest**: close rate
   and quote volume come straight from the sidecar (booked_at IS NOT NULL /
   total). Time-to-accept, pipeline-outstanding, lost-value stay native-only
   (CC data can't support them comparably).
5. **Loader uses replace semantics** (`--replace` truncates the three ledger
   tables and reloads inside one transaction). The archived exports are the
   source of truth; recovery = reload from files. This also clears dev's v1
   test junk. Idempotent by construction.

## Data mapping (exports archived at ~/cc-archive/2026-07-06/)

- `legacy_cc_payments` <- `report (1).csv` (353 rows). Dollars -> integer
  CENTS via decimal-string parsing (no float drift). Type Payment/Refund ->
  `cc_type`. Multi-day `Event Date` -> first day. Verification: sum of
  payment_applied must equal $136,781.35 (all-time P&L) and per-year sums
  must match the 2024/2025 P&L exports to the penny.
- `legacy_cc_payouts` <- `report (4).csv` (116 rows incl. non-staff expense
  categories). `payee_user_id` best-effort matched on normalized name against
  users; unmatched stays NULL. Staff-payment sum must equal $17,575.09.
- `legacy_cc_proposals` <- `report.csv` (1,244 rows). CC statuses normalized:
  Confirmed -> `booked`, Canceled Booking -> `cancelled_booking`,
  Proposal (Date Open) -> `quote_open`, Canceled Proposal ->
  `quote_cancelled`, Expired Proposal -> `quote_expired`, Postponed Proposal
  -> `quote_postponed`. `client_id` linked via email to phase-1 clients
  (~187 match; dead quotes stay NULL, email kept in
  client_email_normalized). Schema delta (idempotent ADD COLUMN):
  `cc_created_at TIMESTAMPTZ` (funnel dates need quote creation, which the
  table lacked) and `total_cost_cents INTEGER` (event total for value
  metrics; `package_amount_cents` stays package-only).

## Metrics layer

`server/utils/metricsQueries.js` + `server/routes/proposals/metadata.js`:
money builders (qRevenue, qMoney/collected, refunds, qPaidCount) union a
CC-era leg from `legacy_cc_payments` (paid_on, cents, refunds negative);
funnel builders qSent/qAccepted/qWinRate union quote/booked counts from
`legacy_cc_proposals` (cc_created_at / booked_at). The old
`ccClause`/`INCLUDE_CC_VALUES` tri-state on `proposals.cc_id` (all-NULL in
prod, vestigial) is repurposed to gate the ledger legs. Dashboard.js changes
are label/semantics only. Gratuity/payroll/invoice math is UNTOUCHED — the
ledger never feeds money movement, per [[reference-gratuity-fee-netting]] and
protect-working-paths.

## Verification gates

- Loader unit tests (cents parsing, status normalization, date handling,
  matching) + full-run assertions (row counts, P&L ties) that FAIL the run
  loudly on mismatch.
- Metrics: node:test on the new legs (dev DB, one suite at a time); dashboard
  eyeball with the chip in all three states.
- Demolition: repo-wide grep proves zero remaining references; client CI
  build gate; admin smoke (clients pages render badge-free).
