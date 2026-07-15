# Payroll Screen Redesign: Design (2026-07-14, revision 3)

Redesign of the admin Payroll page around the weekly pay-run ritual (review lines,
correct, pay externally, mark paid). Born from the buried mark-paid flow: Dallas
gave up trying to close out backfill periods because the action was invisible.
Direction was set in a Dallas-directed claude.ai/design session plus a follow-up
brainstorm on 2026-07-14; every decision below was approved conversationally
(section-by-section approvals are the approval).

Revision 2 folded the first spec-fleet round (reopen via a dedicated `reopened`
status; zelle in the mark-paid allow-list; additive rollups; deep-link remaps).
Revision 3 folds the second round: `zelle_handle` projection (the flow was dead
without it), the `staffShiftActions` guards, the overview due-tile predicate,
the process response finalize status, the PATCH lock set, and the early-process
date guard. All second-round blockers were independently re-verified against
HEAD before folding.

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
   (desktop-native, barely used). Zelle, direct deposit, and check happen
   through chase.com on the desktop: no QR, instead an "Open chase.com" link
   plus copy affordances. (Vocabulary note: within the `payouts.payment_method`
   domain the bank value is `direct_deposit`; `ach` exists only in the
   imported-ledger `staff_payment_history.platform` domain and never reaches
   the pay panel.)
6. **Period-level "Pay from phone (QR)" button (design 1b) is dropped.** A
   period-level artifact cannot know its lines were verified.

## Lifecycle

Existing, unchanged (verified against `server/routes/admin/payroll.js` at HEAD):

- Line edits (PATCH `/payroll/payout-events/:id`) blocked when the payout is
  `paid` or the period is `paid`/`processing` (payroll.js:193-199, the L3 fix).
- `POST /payroll/periods/:id/process` runs the L5 fee-recapture healing pass
  (best-effort scan of `fee_cents IS NULL` tips), then flips to `processing`
  via a guarded UPDATE.
- `POST /payroll/payouts/:id/mark-paid` requires payout `pending` AND period
  `processing` (payroll.js:402-404); stamps method/handle/paid_at/paid_by;
  `maybeFinalizePeriod` auto-flips the period to `paid` when the last payout
  is marked.

The ritual the UI must teach: **edit lines while open → Process period (freezes
lines, heals fees) → per person: generate → send → mark paid → period
auto-finalizes.** While a period is `open`, the pay panel shows a "Process
period to start paying" pointer instead of a generate button.

### NEW: `reopened` status + `POST /payroll/periods/:id/reopen` (adminOnly)

The "I fucked up" path. **Reopen flips `processing → reopened`, a NEW status,
never back to `open`.** Rationale (fleet round 1): every payroll money writer
freezes on `status !== 'open'`, so an open period containing paid payouts
would let webhook-driven accrual, late-tip roll-forward, clawback, and the
re-process heal rewrite a PAID payout's lines and `total_cents`. The
`reopened` status gets refused by every writer for free. Verified consumer
map (every `pay_periods.status` reader in the codebase):

- Refuse/defer `reopened` with NO code change (they test `!== 'open'` /
  `= 'open'`): `payrollAccrual.js:186`, `payrollLateTip.js:104`,
  `payrollClawback.js:138`, `payrollTips.js:99` (H2 webhook re-accrual), the
  tip-assign frozen check (`payroll.js:508`, treats reopened as frozen and
  rolls the tip forward), and `findOpenPeriodForDate`
  (`payrollProcessing.js:12`, the late-tip/clawback destination finder, which
  routes money for a reopened current week into the existing deferral-marker
  path, the designed "today's period is itself frozen" branch). Do NOT modify
  `findOpenPeriodForDate`: it is shared with the writers.
- PATCH line edits: the existing guard blocks `paid`/`processing` only, so
  `reopened` periods accept edits on PENDING payouts; paid payouts stay
  blocked by the payout-status check in the same guard. **Lock-set fix
  (fleet round 2):** the PATCH SELECT's `FOR UPDATE OF pe, po` becomes
  `FOR UPDATE OF pe, po, pp` so a line edit serializes against a concurrent
  process/reopen status flip; without it, an edit that read `open` can commit
  into a period another tab just froze. Deadlock exposure is a single-admin
  rarity and any 40P01 surfaces as a retryable error.
- **`staffShiftActions.js` (fleet round 2 blocker): three exact-match
  `=== 'processing'` guards (lines 239, 375, 535: staff drop, request-cover,
  claim-cover) would let staff mutate the roster of a `reopened` period.
  All three become `['processing','reopened'].includes(...)` so staff roster
  actions stay blocked mid-pay-run.** This file is a route guard, not a money
  writer; the change is in scope.
- Process route: guard becomes `status IN ('open','reopened')` (both the
  pre-check and the guarded UPDATE). Healing note below.
- mark-paid: unchanged, still requires `processing`.
- `GET /payroll/periods/current` (payroll.js:90-98): UNTOUCHED (filters
  `open`; a reopened current week drops off that finder). The overview
  handles reopened via the due-tile fix in Client changes.
- Staff portal: `staffPortal.js` (current_period tile, ~:122-134) and
  `staffPortal/payouts.js` (:50, :76, :225) project `pp.status` verbatim to
  staff. Staff UIs branch only on payout status, so nothing lands in a wrong
  branch, but the raw string `reopened` must never render to staff: those
  projections alias it (`CASE WHEN status='reopened' THEN 'processing' ...`)
  and the staff-portal test asserts the raw value never appears.
- Schema: `pay_periods_status_check` gains `'reopened'` (rewrite the existing
  idempotent DO block, schema.sql:2776-2780; all prod rows are in the old
  3-value set so the rewrite cannot fail validation; note the block's
  `EXCEPTION WHEN OTHERS THEN NULL` means a failed rewrite fails CLOSED, every
  reopen 500s on CHECK violation, so the build's verify step confirms the
  constraint definition post-deploy).

Route mechanics: single guarded UPDATE
`SET status='reopened' WHERE id=$1 AND status='processing'`; zero rows means
re-read and 409 with the actual status. A `paid` (finalized) period can NEVER
be reopened. Race-safety rationale, written down so nobody "improves" this
into check-then-act: mark-paid holds `FOR UPDATE OF po, pp` until COMMIT
(payroll.js:391) with `maybeFinalizePeriod` inside that same transaction, so a
concurrent reopen serializes behind the final mark-paid plus finalize and its
guarded UPDATE re-evaluates to zero rows, 409. Audit: log the reopen via the
existing `logAdminAction` pattern (payroll.js:584) with actor, period id, and
paid/pending counts at reopen time.

Reopening with some payouts already paid is ALLOWED and safe under `reopened`:
paid payouts are untouchable by PATCH and mark-paid (their own status checks)
and by every money writer (period-status checks above).

**Re-process healing honesty**: on process-from-`reopened`, the L5 recapture
pass captures missing Stripe fees on the tip rows, but its re-accrue step is
refused by accrual (`pay_period_not_open`), so affected LINES in this period
stay gross and the existing `fee_recapture_line_unhealed` Sentry warning
fires. Same accepted trade-off as a Stripe outage at first process; it is
exactly what protects already-paid gross payouts from being silently shrunk.

**Early-process guard (fleet round 2):** processing the CURRENT week early
creates a silent wage blackhole: events completing later that week accrue
nothing (accrual's `pay_period_not_open` skip has no marker, no retry, and
callers treat it as success), and the wedge fix below would finalize a
zero-pending period irreversibly. Therefore process 409s when the period's
`end_date` >= Chicago-today unless the body carries `force: true`; the UI
maps that 409 to a hard confirm ("This period is still in progress. Events
finishing this week will not be added. Process anyway?") and retries with
force. Companion observability, the ONE deliberate exception to the
no-accrual-file-changes fence: a single `Sentry.captureMessage` in
`payrollAccrual.js`'s existing `pay_period_not_open` skip branch (observability
only, zero logic change) so silently skipped wage accruals become visible.

**Stuck-processing wedge fix**: `maybeFinalizePeriod` only runs inside
mark-paid, so a period whose last PENDING payout disappears while reopened
(roster-correction sweep) would re-process into `processing` forever. The
process route therefore calls `maybeFinalizePeriod` after its flip. **The
response must reflect the outcome** (fleet round 2 blocker): process returns
`period_status: finalized ? 'paid' : 'processing'` exactly like mark-paid
(payroll.js:427) instead of echoing the pre-finalize row, and the client drops
a period from the queue when the response says `paid`. Deploy note: a period
already wedged in `processing` with zero pending payouts before this ships
heals manually via reopen then re-process.

## The pay panel (per payout, inside the expansion)

One component replacing the `PayQRModal` + `MarkPaidAction` UI (both files
DELETED; the mark-paid API call moves into the new component). States:

1. **Period open or reopened**: no payment affordances. Lines editable. Panel
   shows the person, their preferred handle, and "Process period to start
   paying."
2. **Period processing, not yet generated**: method segment (preferred method
   active), lines total, one primary button: "Generate QR · $X" for venmo/
   cashapp, "Prepare payment · $X" for everything else.
3. **Generated (QR methods)**: QR on a white tile (scannable in both skins),
   locked amount + note text, reference input, "Mark paid · $X". Venmo caveat
   line stays (Venmo sometimes drops the amount; confirm on the phone).
4. **Generated (paypal)**: "Open PayPal" link (prefilled paypal.me), reference
   input, mark paid.
5. **Prepared (zelle / direct_deposit / check / other)**: for zelle an "Open
   chase.com" link, copy-handle (zelle_handle), and copy-amount; for
   direct_deposit/check/other, copy-amount only. **There is NO copyable handle
   for direct_deposit or check: the only stored identifiers are AES-encrypted
   bank fields (CLAUDE.md Bank PII invariant) and they are NEVER projected
   into any payroll payload.** Reference input ("Zelle conf. #" etc.), mark
   paid.
6. **Invalidated**: the generated artifact clears whenever the locked total no
   longer matches the payout total (reopen happened, method switched, or a
   refetch disagrees). Panel returns to state 2 showing the new total.

Client data flow (fleet round 2): the locked amount comes from the payout's
`total_cents` in the `loadPeriodWithPayouts` payload; line PATCHes keep it
current through the existing `onLineSaved` lift (PayrollPage.js:100-116
pattern). On a drift 409 from mark-paid, the client refetches the period,
invalidates to state 2 with the new total, and toasts ("Total changed to $Y.
Regenerate before paying."). Cross-tab drift is caught by the server guard;
same-tab drift by the invalidation triggers.

Fallbacks and guardrails:

- **No handle on file** for the selected method: states 3-5 degrade to the
  desktop shape minus copy-handle (copy-amount + reference + mark paid) with a
  "No handle on file" note linking to the person's profile. State 1 shows the
  same note instead of a handle.
- **Clipboard failure**: `navigator.clipboard.writeText` rejection shows a
  toast and reveals the value in a selectable field.
- **Never log generated pay URLs or clipboard payloads** (they embed handle +
  amount): no console.log, no Sentry breadcrumbs carrying them. `buildPayUrl`
  output stays render-only, as today.
- **In-flight states**: every mutating button (Process, Reopen, Mark paid)
  disables while its request is in flight, mirroring the existing `confirming`
  pattern in MarkPaidAction.
- **Reference input**: `maxLength=200` and client-side trim, matching the
  server rule (validation parity).

Generation is pure client state (Decision 3). The deep-link builders in
`MarkPaidAction.js` (`buildPayUrl`) move to the new component and gain the
period range: the Venmo note becomes `DRB payroll <Mon D – D>` instead of the
static "Dr. Bartender payroll". CashApp and PayPal URL formats are unchanged
(no note support).

## Server changes (complete list)

1. **`GET /payroll/periods` rollups, strictly ADDITIVE**: keep `total_cents`,
   `paid_count`, `pending_count` byte-identical (consumer:
   `client/src/pages/admin/overview/PayrollStatus.js`). ADD `paid_cents` and
   `owed_cents` (SUMs of paid/pending payouts' total_cents). No renames.
   Note: the rollup LEFT JOINs payouts while `loadPeriodWithPayouts` INNER
   JOINs users; unreachable drift because `payouts.contractor_id` FKs users
   without CASCADE. Accepted.
2. **`loadPeriodWithPayouts` projection gains `pp.zelle_handle`** (fleet
   round 2 blocker: `payment_profiles.zelle_handle` exists and staff can set
   it, but no admin payroll projection selects it, so the panel's zelle flow
   was dead as previously specced and mark-paid's `payment_handle` snapshot
   for zelle would store null). No bank fields; nothing else joins the
   payload.
3. **`POST /payroll/periods/:id/reopen`**: as specced in Lifecycle (guarded
   UPDATE, 409 semantics, `logAdminAction`).
4. **Process route**: accepts `open` and `reopened`; refuses in-progress
   periods without `force: true` (early-process guard); finalizes when no
   pending payouts remain and returns `period_status` reflecting it; the
   client surfaces the `fee_recapture` summary (see Client changes).
5. **`POST /payroll/payouts/:id/mark-paid` additions** (all additive):
   - `zelle` joins `ALLOWED_PAY_METHODS` (payroll.js:115). Mirrors: the admin
     client `PAYMENT_METHODS` (`client/src/pages/admin/userDetail/helpers.js`,
     whose stale "Zelle was retired" comment gets corrected) and the admin
     tip-page enum (`server/routes/admin/contractorTipPage.js:23`
     `ALLOWED_PAYMENT_METHODS`), so the admin- and staff-side preferred-method
     vocabularies agree again (staffPortal/paymentMethods.js already allows
     zelle).
   - `payment_reference` (string, ≤200, trimmed, stored): NEW column
     `payouts.payment_reference TEXT` (idempotent ADD COLUMN IF NOT EXISTS).
     Read paths that ADD it: `loadPeriodWithPayouts` (payroll.js:30-34), the
     mark-paid response SELECT (payroll.js:419-424), and the contractor
     payouts endpoint, in BOTH its SELECT (payroll.js:593-594) AND its
     explicit response map (payroll.js:609-617, which does not spread rows).
     It stays OUT of every staff-facing projection: staffPortal/payouts.js
     and paystub assembly (paystubData.js) keep their explicit column lists,
     and the existing staff-portal PII exclusion test extends to assert
     `payment_reference` never leaks.
   - `expected_total_cents`: presence check is strict `!== undefined` (a $0
     payout total is a designed state under the H1 debt clamp; no truthiness
     checks). Must be a non-negative integer (`Number.isInteger`), else 400
     ValidationError. `total_cents` is ADDED to the existing locked
     `FOR UPDATE` SELECT (payroll.js:385-392) and compared inside that
     transaction; mismatch is a 409 ConflictError with a Sentry breadcrumb
     (the "racing myself across tabs" signal). Omitted field = today's
     behavior (back-compat for scripts), also breadcrumbed so unguarded
     mark-paids stay visible.
6. **PATCH `/payroll/payout-events/:id`**: lock set widened to
   `FOR UPDATE OF pe, po, pp` (see Lifecycle). No other PATCH changes.
7. **`staffShiftActions.js`**: the three `=== 'processing'` guards become
   `['processing','reopened'].includes(...)` (lines 239, 375, 535).
8. **Staff-portal status aliasing**: `staffPortal.js` and
   `staffPortal/payouts.js` period-status projections alias `reopened` to
   `processing` (display only).
9. **`payrollAccrual.js`**: ONE `Sentry.captureMessage` in the existing
   `pay_period_not_open` skip branch. Observability only, zero logic change,
   the single deliberate exception to the accrual fence.
10. Nothing else. No accrual/clawback/late-tip/fee-netting LOGIC changes; the
    `reopened` status was chosen specifically so the money writers need zero
    edits.

## Client changes (per file, `client/src/pages/admin/payroll/` unless noted)

- `PayrollPage.js`: tabs become `payrun` / `history` / `tips` / `tax`. URL
  compat: map legacy `current → payrun`, `unassigned → tips` when reading the
  param (useUrlListState). Landing tab = payrun.
- NEW `PayRunView.js`: the queue. Periods with status != 'paid' (open,
  processing, reopened). Sort: the "current" period first, defined as the
  period whose date range covers Chicago-today (any non-paid status, so a
  reopened current week keeps its slot), then the rest oldest-payday-first.
  Each period card: header (range, status chip, paid X of Y, action button
  per status), payout queue rows, stat strip on top (still owed, unpaid
  payouts, oldest open, paid this month). Card actions by status: `open` and
  `reopened` show **Process** (labeled "Re-process" on reopened); `processing`
  shows **Reopen** behind a confirmation dialog (it flips a money state). A
  process/reopen 409 (raced by another tab) refetches the queue and re-renders
  the true state, never just a toast over a stale button. UI states: loading
  skeleton, error state with retry, and the happy empty state ("Nothing owed.
  Every period is paid.") when zero unpaid periods exist. When a process
  response returns `period_status: 'paid'` the card leaves the queue. The
  `fee_recapture` summary surfaces as a warning toast when `tips_null_after`
  or `tips_line_unhealed` is nonzero, exact copy: "Some card tips are missing
  their Stripe fee and will pay gross this period. Details are in Sentry."
  (expected on first-process of old backfill periods; no ids in the toast).
  The reopened chip uses the violet/accent variant for distinctness.
- `PayoutRow.js`: becomes the queue row (name, method+handle tag, events/hours
  sub, amount, status chip, Pay button that toggles the expansion).
- NEW `PayPanel.js`: the state machine above. Absorbs `buildPayUrl`.
- DELETED: `PayQRModal.js`, `MarkPaidAction.js` (absorbed into PayPanel),
  `PayrollHeader.js` (dead once PayRunView carries its own strip and
  HistoryView is rewritten; its only importers are PayrollPage and
  HistoryView).
- `EventLineItem.js`: unchanged mechanics (serialized PATCH, edit affordances);
  lives in the expansion's left column with the "Payout total / matches the
  code" row underneath.
- `HistoryView.js`: keeps fetching the full periods list (as today,
  HistoryView.js:35-42) but DISPLAYS paid periods only; drill-in read-only;
  shows `payment_reference` (renders NULL as blank, every pre-migration paid
  row is NULL). Deep-link handling: a `period` param resolving to a non-paid
  period redirects to the payrun tab with that period focused; a missing or
  unknown param shows the plain list.
- **Deep-link producers**: `overview/PayrollStatus.js` "Due" tile links change
  to `?tab=payrun&period=<id>`, AND its due-detector widens from
  `status === 'processing'` to `['processing','reopened'].includes(status)`
  (fleet round 2 blocker: otherwise a reopened past-payday period vanishes
  from the Money tab and the overdue dot goes dark, re-burying exactly the
  flow this redesign exists to surface). Rollup fields it reads are untouched.
  `userDetail/tabs/PayoutsTab.js` payout links route on the PERIOD's status
  (payrun for non-paid periods, history for paid), never on the payout's own
  status: a paid payout can sit inside a reopened period.
- `UnassignedTipsPanel.js` / `DeferredTipsPanel.js`: unchanged, both render
  under the single Tips repair tab (stacked, unassigned first).
- `TaxTotalsTab.js`: unchanged.
- `index.css`: pay-panel styles on existing tokens, both skins. The QR always
  sits on a white tile (scanners need light background, the one deliberate
  skin-invariant element).

Desktop-first; tables scroll on mobile. File-size discipline: PayRunView and
PayPanel each target <300 lines; split rather than grow.

## Recovery paths (documentation, not features)

- Wrong EXISTING lines discovered before paying anyone, or mid-run: Reopen,
  fix, re-process. Reopen cannot re-admit a missing person or event (accrual
  refuses `reopened` by design); missing lines are next-period adjustments
  even when nobody has been paid yet.
- Wrong lines discovered after the period finalized: next-period adjustment
  with a note (the established late-tip/clawback-era pattern). No reopen of
  `paid` periods.
- Wrong PERSON marked paid (mark-paid in error): there is deliberately no
  unpay. Recovery is a next-period adjustment pair (negative on the wrongly
  paid person, positive where it belongs) with notes, or a direct DB
  correction by Dallas. `payment_reference` exists partly to make this
  traceable.

## Non-goals

- No in-app money movement, ever: mark-paid records reality (unchanged).
- No unpay/undo for a paid payout; no reopen of finalized periods.
- No batch mark-paid, no person-first views.
- No tips-repair or 1099 redesign (they move tabs, nothing more).
- No mark-paid while `open` or `reopened` (the fee-recapture pass must run
  before money goes out).
- No accrual/clawback/late-tip/fee-netting logic changes (sole exception: the
  one observability line in Server changes item 9).

## Documentation updates (same change, per the mandatory table)

- `README.md`: folder tree (PayRunView.js, PayPanel.js added; PayQRModal.js,
  MarkPaidAction.js, PayrollHeader.js removed), key features note.
- `ARCHITECTURE.md`: route table (`POST /payroll/periods/:id/reopen`,
  mark-paid and process body additions), Database Schema section
  (`pay_periods` status set gains `reopened`; `payouts.payment_reference`).

## Testing (server, node:test conventions)

One suite, run serially against the shared dev DB (`node -r dotenv/config
--test`). Chicago-keyed track-and-restore pay-period fixtures (test-suite law
from the 2026-07-13 audit: UTC-keyed fixtures go red at night).

- reopen lifecycle: processing→reopened flips; open and paid both 409; PATCH
  works on pending payouts in a reopened period and still 409s on paid
  payouts; mark-paid 409s while reopened; re-process (reopened→processing)
  succeeds and mark-paid works again.
- **writers vs reopened** (the round-1 regression fence): with a reopened
  period containing one paid and one pending payout, fire
  `accruePayoutsForProposal`, the late-tip roll-forward, and the clawback
  path at it; assert every paid payout's lines and `total_cents` are
  byte-identical afterward and the late-tip/clawback paths persisted deferral
  markers instead of writing in.
- staff shift actions: drop / request-cover / claim-cover all blocked for a
  shift in a `reopened` period (same message as processing).
- drift guard: mark-paid with stale `expected_total_cents` 409s and changes
  nothing; `expected_total_cents: 0` against a $0 payout passes; non-integer
  and negative values 400; omitted field behaves exactly as today.
- zelle: mark-paid accepts `payment_method='zelle'`; the payrun payload
  carries `zelle_handle`; contractorTipPage enum accepts zelle.
- process: 409s on `end_date` >= Chicago-today without `force: true`, passes
  with it; zero-pending period finalizes immediately AND the response says
  `period_status: 'paid'`.
- reference: stored, trimmed, length-capped, returned by the three admin read
  paths (including the contractor endpoint's explicit map); staff-portal
  payout projection test extended to assert `payment_reference` absent and
  the raw string `reopened` never rendered to staff.
- rollups: `paid_cents`/`owed_cents` match SUMs under mixed statuses;
  `total_cents`/`paid_count`/`pending_count` unchanged for existing consumers.
- schema: post-deploy verify confirms `pay_periods_status_check` includes
  `reopened` (the DO block's EXCEPTION clause fails closed if the rewrite
  breaks).

## Risks and review notes

- Sensitive paths: `server/routes/admin/payroll.js`, `server/db/schema.sql`,
  `server/utils/payrollAccrual.js` (one line), and `staffShiftActions.js` are
  money seam or adjacent: full fleet per lane regardless of size. Read
  `.claude/seam-sweep-2026-07-02.md` before building (H1 floorless contract,
  one-connection-per-request rule, post-COMMIT tail discipline).
- The reopen route must reuse the guarded-UPDATE race pattern process already
  uses, and must NOT add per-line floors or touch recompute logic.
- Client copy: no em dashes anywhere user-facing.
