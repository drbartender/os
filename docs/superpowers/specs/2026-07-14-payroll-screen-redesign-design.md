# Payroll Screen Redesign: Design (2026-07-14)

Redesign of the admin Payroll page around the weekly pay-run ritual (review lines,
correct, pay externally, mark paid). Born from the buried mark-paid flow: Dallas
gave up trying to close out backfill periods because the action was invisible.
Direction was set in a Dallas-directed claude.ai/design session plus a follow-up
brainstorm on 2026-07-14; every decision below was approved conversationally in
that session (section-by-section approvals are the approval).

Design artifacts: `~/win-share/Payroll screen upgrade v2/Payroll Redesign.dc.html`,
Turn 3 (3a = merged pay-run queue, 3b = pay panel states). Turn 3 was authored
against the decisions below; Turns 1 and 2 are exploration history. The QR in 3b
is a real render from `qrcode.react` using the production `buildPayUrl` format.

## Decisions (Dallas, locked)

1. **Period-based, not person-first.** Payroll is rarely more than a day late, so
   cross-period batch machinery is dead weight. The 1a queue layout carries the
   page; 1c's pay panel card is the payout expansion. The person-first endpoints
   from design Turn 2 (`GET /payroll/payables?by=person`,
   `POST /payroll/payouts/mark-paid-batch`) are DROPPED, never build them.
2. **Per-person generate click.** Dallas wants to generate the payment artifact
   (QR or link) per staff member, one click each, after verifying that person's
   lines. Not auto-generated for the whole period at process time.
3. **Generated artifacts are ephemeral.** Client state only. Needed again means
   generate again. No server column tracks generation.
4. **A real "I fucked up" path.** Reopen a processing period to fix lines, see
   Lifecycle below. Quote: "We for sure need a solution for 'I fucked up'...
   cuz I do that. I am human."
5. **Method-aware pay panel.** Venmo/CashApp are phone-native (fingerprint and
   go): QR is the primary affordance. PayPal gets a prefilled paypal.me link
   (desktop-native, barely used). Zelle, ACH, and check happen through chase.com
   on the desktop: no QR, instead an "Open chase.com" link plus copy-handle and
   copy-amount buttons, because Chase cannot be prefilled from outside.
6. **Period-level "Pay from phone (QR)" button (design 1b) is dropped.** A
   period-level artifact cannot know its lines were verified.

## Lifecycle (mostly existing, one addition)

Existing, unchanged (verified against `server/routes/admin/payroll.js` at HEAD):

- `pay_periods.status`: `open → processing → paid` (CHECK constraint).
- Line edits (PATCH `/payroll/payout-events/:id`) allowed ONLY while the period
  is `open` AND the payout is `pending` (payroll.js:193-199, the L3 fix).
- `POST /payroll/periods/:id/process` requires `open`, runs the L5 fee-recapture
  healing pass (best-effort scan of `fee_cents IS NULL` tips, safe to re-run),
  then flips to `processing` via a guarded UPDATE.
- `POST /payroll/payouts/:id/mark-paid` requires payout `pending` AND period
  `processing` (payroll.js:402-404); stamps method/handle/paid_at/paid_by;
  `maybeFinalizePeriod` auto-flips the period to `paid` when the last payout is
  marked.

So the ritual the UI must teach is: **edit lines while open → Process period
(freezes lines, heals fees) → per person: generate → send → mark paid → period
auto-finalizes.** The design mock's "editable lines + live QR side by side"
state does not exist; while open, the pay panel shows a "Process period to
start paying" pointer instead of a generate button.

NEW: **`POST /payroll/periods/:id/reopen`** (adminOnly), the "I fucked up" path.

- Guard: guarded UPDATE `SET status='open' WHERE id=$1 AND status='processing'`.
  Zero rows: re-read and 409 with the actual status. A `paid` (finalized) period
  can NEVER be reopened; corrections to finalized periods keep using the existing
  next-period adjustment pattern (late-tip/clawback machinery).
- Reopening with some payouts already paid is ALLOWED. Paid payouts stay frozen
  by their own status checks (PATCH blocks `payout_status='paid'`, mark-paid
  requires `pending`), so a reopen only ever unfreezes pending people's lines.
- After fixing lines, the admin processes again. The healing pass re-runs;
  verified safe: it only scans tips still missing a fee.
- While reopened, accrual may write into the period again (it is genuinely open).
  That is correct, not a bug; the late-tip deferral logic keys off current status.
- No schema change: `open` is an existing status.

## The pay panel (per payout, inside the expansion)

One component replacing the `PayQRModal` + `MarkPaidAction` UI (the modal dies;
the API call survives). States:

1. **Period open**: no payment affordances. Lines editable. Panel shows the
   person, their preferred handle, and "Process period to start paying."
2. **Period processing, not yet generated**: method segment (preferred method
   active), lines total, one primary button: "Generate QR · $X" for venmo/
   cashapp, "Prepare payment · $X" for everything else.
3. **Generated (QR methods)**: QR on a white tile (scannable in both skins),
   locked amount + note text, reference input, "Mark paid · $X". Venmo caveat
   line stays (Venmo sometimes drops the amount; confirm on the phone).
4. **Generated (paypal)**: "Open PayPal" link (prefilled paypal.me), reference
   input, mark paid.
5. **Prepared (zelle / ach / check / other)**: for zelle an "Open chase.com"
   link; for all four, copy-handle (when a handle exists) and copy-amount
   buttons via `navigator.clipboard`, reference input ("Zelle conf. #" etc.),
   mark paid.
6. **Invalidated**: the generated artifact clears whenever the locked total no
   longer matches the payout total (reopen happened, a line changed, method
   switched, or data refetch disagrees). Panel returns to state 2 showing the
   new total on the button. Regenerating is one click.

Generation is pure client state (Decision 3). The deep-link builders in
`MarkPaidAction.js` (`buildPayUrl`) move to the new component and gain the
period range: the Venmo note becomes `DRB payroll <Mon D – D>` instead of the
static "Dr. Bartender payroll", making every Venmo transaction self-reconciling.
CashApp and PayPal URL formats are unchanged (no note support).

## Server changes (complete list)

1. **`GET /payroll/periods` rollup fields**: per period `accrued_cents`,
   `paid_cents`, `owed_cents`, `unpaid_count`, `payout_count` (SUM/COUNT over
   payouts, one query). The pay-run queue and History both read these.
2. **`POST /payroll/periods/:id/reopen`**: as specced above.
3. **`POST /payroll/payouts/:id/mark-paid` additions** (both optional, additive):
   - `payment_reference` (string, ≤200, trimmed, stored): NEW column
     `payouts.payment_reference TEXT` (idempotent ADD COLUMN IF NOT EXISTS).
     Surfaced in HistoryView and the payout detail.
   - `expected_total_cents` (integer): when present and ≠ the payout's current
     `total_cents` inside the existing locked transaction, 409 ConflictError
     ("payout total changed since the code was generated; regenerate"). The
     client always sends it from the generated snapshot. This is the server-side
     guard for the reopen era: a QR generated before a reopen+edit in another
     tab can never be recorded at the wrong amount.
4. Nothing else. No accrual, clawback, fee-netting, or healing changes. The
   payroll money seam (payrollAccrual, payrollClawback, payrollLateTip,
   gratuity fee-netting) is out of bounds for this project.

## Client changes (per file, `client/src/pages/admin/payroll/`)

- `PayrollPage.js`: tabs become `payrun` / `history` / `tips` / `tax`. URL
  compat: map legacy `current → payrun`, `unassigned → tips` when reading the
  param (useUrlListState). Landing tab = payrun.
- NEW `PayRunView.js`: the queue. Periods with status != 'paid', current first
  then oldest-debt-first, each a card: header (range, status chip, paid X of Y,
  Process period or Reopen button per status), payout queue rows, stat strip on
  top (still owed, unpaid payouts, oldest open, paid this month). Replaces the
  current-period view.
- `PayoutRow.js`: becomes the queue row (name, method+handle tag, events/hours
  sub, amount, status chip, Pay button that toggles the expansion).
- NEW `PayPanel.js`: the state machine above. Absorbs `buildPayUrl` from
  `MarkPaidAction.js` and the mark-paid POST. `PayQRModal.js` is deleted.
- `EventLineItem.js`: unchanged mechanics (serialized PATCH, edit affordances);
  lives in the expansion's left column with the "Payout total / matches the
  code" row underneath.
- `HistoryView.js`: paid periods only (status 'paid'), drill-in read-only,
  shows payment_reference. The "old open periods look like archives" trap dies
  because anything unpaid lives in the queue.
- `UnassignedTipsPanel.js` / `DeferredTipsPanel.js`: unchanged, both render
  under the single Tips repair tab (stacked, unassigned first).
- `TaxTotalsTab.js`: unchanged.
- `index.css`: pay-panel styles on existing tokens, both skins. The QR always
  sits on a white tile (scanners need light background, and it is the one
  deliberate skin-invariant element).

Desktop-first; tables scroll on mobile. File-size discipline: PayRunView and
PayPanel each target <300 lines; split rather than grow.

## Non-goals

- No in-app money movement, ever: mark-paid records reality (unchanged).
- No unpay/undo for a paid payout; no reopen of finalized periods.
- No batch mark-paid, no person-first views.
- No tips-repair or 1099 redesign (they move tabs, nothing more).
- No mark-paid while `open` (the fee-recapture pass must run before money goes
  out; this protects the healing guarantee).

## Testing (server, node:test conventions)

One suite, run serially against the shared dev DB (`node -r dotenv/config
--test`). Chicago-keyed track-and-restore pay-period fixtures (test-suite law
from the 2026-07-13 audit: UTC-keyed fixtures go red at night).

- reopen: processing→open flips; open and paid both 409; paid payouts inside a
  reopened period still refuse PATCH and mark-paid; pending lines accept PATCH
  after reopen; re-process succeeds and mark-paid works again.
- drift guard: mark-paid with stale `expected_total_cents` 409s and changes
  nothing; without the field behaves exactly as today (back-compat).
- reference: stored, trimmed, length-capped, returned by the payout read paths.
- rollups: period list totals match SUM of payouts under mixed statuses.

## Risks and review notes

- Sensitive paths: `server/routes/admin/payroll.js` and `schema.sql` are money
  seam, full fleet per lane regardless of size. Read
  `.claude/seam-sweep-2026-07-02.md` before building (H1 floorless contract,
  one-connection-per-request rule, post-COMMIT tail discipline).
- The reopen route must reuse the guarded-UPDATE race pattern process already
  uses, and must NOT add per-line floors or touch recompute logic.
- Client copy: no em dashes anywhere user-facing.
