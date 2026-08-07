# Owner no-draw payouts

**Date:** 2026-08-07
**Status:** Approved (brainstorm section approvals, 2026-08-07)
**Problem:** Dallas (user 12, `dallas@drbartender.com`) works events but does not take a payout. His payout rows accrue as `pending` forever: they hold periods open (period 72 is stuck on him alone), inflate "Still owed", and can never honestly be marked `paid` because `status = 'paid'` also drives the 1099 totals (`payrollTax.js` sums paid payouts by `paid_at` year) and the staff paystub list. Marking them paid would push owner draw into 1099 figures; leaving them pending grows the pay-run queue without bound.

**Decision:** a third payout status, `no_draw`: explicitly not owed, explicitly not paid, fully tracked.

## 1. Status model and flag

- `payouts.status` gains `'no_draw'` alongside `'pending'` and `'paid'`.
  - The status CHECK constraint must admit the new value. Dev and prod constraints are known to diverge (dev DB lacks some prod CHECKs); verify the live prod constraint by name before shipping and update `schema.sql` idempotently (drop-and-re-add guarded, or `IF NOT EXISTS` shape as appropriate).
- `contractor_profiles.takes_draw BOOLEAN NOT NULL DEFAULT true`. Set false for user 12 only. No UI to edit the flag in this pass: it changes by SQL, and nobody else is expected to use it.
- Accrual: wherever a payout row is created (`payrollAccrual.js` and any other insert path found at plan time), a contractor with `takes_draw = false` gets `status = 'no_draw'` at birth instead of `'pending'`.
- Toggle: an admin action on a payout flips `no_draw` -> `pending` (to actually draw one) and `pending` -> `no_draw` (to park one). Allowed while the payout is unpaid and its period is `open`, `reopened`, or `processing`. Flipping to `pending` in a `processing` period makes the normal pay panel appear; flipping the last `pending` row of a `processing` period to `no_draw` must run the same finalize check as mark-paid so the period closes.

## 2. What falls out free (verify, do not rebuild)

These already filter on `status = 'pending'` or `status = 'paid'` and therefore exclude `no_draw` with no change; the plan verifies each rather than re-implementing:

- `maybeFinalizePeriod` (`payrollProcessing.js:74`): counts `pending` only, so `no_draw` rows stop blocking period close.
- `GET /admin/payroll/periods` rollups: `owed_cents`, `pending_count`, `paid_cents`, `paid_count`. "Still owed", "Unpaid payouts", "Paid this month" stats and the per-card owed figure all derive from these.
- 1099 / tax (`payrollTax.js`): `status = 'paid'` only. No leak.
- Overview `PayrollStatus` and any other consumer of the periods rollup (sweep for `owed_cents` / `pending_count` consumers at plan time).

Explicitly NOT free:

- `total_cents` sums without a status filter: History (both the list row's dollar figure and the drill-in "Total paid") shows genuinely-paid only, i.e. reads `paid_cents` / sums `status='paid'`, with the `no_draw` row greyed beneath the drill-in. The rollup's raw `total_cents` keeps including `no_draw` (it feeds the owed-delta bookkeeping), but no surface presents it as "paid".
- Client owed-delta lift (`PayRunView.js` `patchPeriodOwed` via `handleLineSaved` / `handleDutyChanged`): applies deltas blindly per payout. It must skip payouts with `status = 'no_draw'`, or a line edit on an owner row would move the owed rollup.

## 3. Pay run UI

- A `no_draw` payout row renders greyed with a "no draw" chip, no pay panel, still expandable to its event and duty lines.
- Line edits behave exactly like a `pending` row while the period is `open` or `reopened`: server-side PATCH guards that currently require `status = 'pending'` extend to `'no_draw'`; `recomputePayoutTotal` keeps the tracked amount true.
- The toggle action (section 1) lives on the row.

## 4. Staff Pay page (dallas@ account)

- `GET /api/me/payouts` (staffPortal) includes `no_draw` rows.
- History list: `no_draw` entries render greyed, "Not drawn" where paid rows say "Paid Aug 5". Same drill-in (`/me/payouts/:periodId`) to the line breakdown. No paystub PDF (paystubs are minted at mark-paid; a `no_draw` row has none).
- YTD stat includes `no_draw` totals: as-if-paid, per the owner's request. Tax surfaces are untouched and stay strictly `paid`.
- Guard rails: the staff portal is shared code; non-owner accounts have no `no_draw` rows, so no special-casing by user, only by status.

## 5. Backfill (one-time, prod)

1. Flip payouts 80, 83, 92, 98 (contractor 12: periods 72, 76, 80, 89) to `no_draw`.
2. Run the finalize check for period 72: Dallas is its only pending payout, so it closes to `paid`. Periods 76 and 80 stay `processing` (Debbie L., Kevin D. genuinely pending). Period 89 stays `open`.
3. Set `takes_draw = false` on contractor_profiles for user 12.

Order matters: constraint change ships before the backfill runs.

## 6. Testing and review

- Unit: accrual births `no_draw` for a flagged contractor; finalize ignores `no_draw`; toggle endpoint guards (status, period status, finalize-on-last-pending); tax totals unchanged by `no_draw` rows.
- Suites a change reaches: payroll accrual, processing, route tests, staffPortal tests.
- Money seam: full review fleet before merge; second-opinion at push per sensitive-path rule.

## Out of scope

- Any UI for editing `takes_draw`.
- Retroactive job-costing / event P&L reporting of owner labor.
- The pay-run sort fix (newest payday first) already made in `PayRunView.js`: separate quick fix, committed independently.
