# Payroll Screen Redesign: Design (2026-07-14, revision 2)

Redesign of the admin Payroll page around the weekly pay-run ritual (review lines,
correct, pay externally, mark paid). Born from the buried mark-paid flow: Dallas
gave up trying to close out backfill periods because the action was invisible.
Direction was set in a Dallas-directed claude.ai/design session plus a follow-up
brainstorm on 2026-07-14; every decision below was approved conversationally
(section-by-section approvals are the approval).

Revision 2 folds in the spec-review fleet's findings (4 blockers, 8 warnings,
7 suggestions): the reopen mechanism now uses a dedicated `reopened` period
status, zelle joins the mark-paid method allow-list, the periods rollup is
strictly additive, and the History deep-link producers are enumerated.

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
   plus copy-handle and copy-amount buttons, because Chase cannot be prefilled
   from outside. (Method vocabulary note: the stored bank-method value is
   `direct_deposit`; there is no `ach` value anywhere in the system.)
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
never back to `open`.** Rationale (fleet blocker B1): every payroll money
writer freezes on `status !== 'open'`, so an open period containing paid
payouts would let webhook-driven accrual, late-tip roll-forward, clawback, and
the re-process heal rewrite a PAID payout's lines and `total_cents`, silently
diverging the recorded payout from the money actually sent. The `reopened`
status gets refused by every writer for free. Verified consumer map:

- Refuse `reopened` with NO code change (they all test `!== 'open'` /
  `= 'open'`): `payrollAccrual.js:162`, `payrollLateTip.js:104`,
  `payrollClawback.js:138`, `payrollTips.js:99` (H2 webhook re-accrual), the
  tip-assign frozen check (`payroll.js:508`, treats reopened as frozen and
  rolls the tip forward), and `findOpenPeriodForDate`
  (`payrollProcessing.js:12`, the late-tip/clawback destination finder, which
  therefore routes money for a reopened current week into the existing
  deferral-marker path, the designed "today's period is itself frozen" branch
  in payrollLateTip.js:104-120 / payrollClawback.js:138+). Do NOT modify
  `findOpenPeriodForDate`: it is shared with the writers.
- PATCH line edits: the existing guard blocks `paid`/`processing` only, so
  `reopened` periods accept edits on PENDING payouts with NO change; paid
  payouts stay blocked by the payout-status check in the same guard.
- Process route: guard becomes `status IN ('open','reopened')` (both the
  pre-check and the guarded UPDATE). Healing note below.
- mark-paid: unchanged, still requires `processing`. While reopened you fix
  lines; you pay after re-processing.
- `GET /payroll/periods/current` (payroll.js:90-94): UNTOUCHED. A reopened
  current-week period drops off the dashboard current-period tile until
  re-processed. Accepted momentary edge; the pay-run queue still shows it.
- Schema: `pay_periods_status_check` gains `'reopened'` (rewrite the existing
  idempotent DO block).

Route mechanics: single guarded UPDATE
`SET status='reopened' WHERE id=$1 AND status='processing'`; zero rows means
re-read and 409 with the actual status. A `paid` (finalized) period can NEVER
be reopened; corrections there keep using the established next-period
adjustment pattern. Race-safety rationale, written down so nobody "improves"
this into check-then-act: mark-paid holds `FOR UPDATE OF po, pp` until COMMIT
(payroll.js:391), so a concurrent reopen serializes behind the final mark-paid
plus finalize and its guarded UPDATE re-evaluates to zero rows, 409. Audit:
log the reopen via the existing `logAdminAction` pattern (payroll.js:584) with
actor, period id, and paid/pending counts at reopen time.

Reopening with some payouts already paid is ALLOWED and safe under `reopened`:
paid payouts are untouchable by PATCH and mark-paid (their own status checks)
and by every money writer (period-status checks above).

**Re-process healing honesty** (fleet blocker B1b): on process-from-`reopened`,
the L5 recapture pass captures missing Stripe fees on the tip rows, but its
re-accrue step is refused by accrual (`pay_period_not_open`), so affected
LINES in this period stay gross and the existing
`fee_recapture_line_unhealed` Sentry warning fires. This is the same accepted
trade-off as a Stripe outage at first process, and it is exactly what protects
already-paid gross payouts from being silently shrunk. Requires a null-fee tip
overlapping a reopen: rare. The spec previously claimed the re-run was fully
"safe"; this paragraph replaces that claim.

**Stuck-processing wedge fix** (fleet warning): `maybeFinalizePeriod` only
runs inside mark-paid, so a period whose last PENDING payout disappears while
reopened (roster-correction sweep) would re-process into `processing` forever.
The process route therefore calls `maybeFinalizePeriod` after its flip,
finalizing immediately when no pending payouts remain (also covers processing
a zero-payout period).

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
   chase.com" link; for all four, copy-handle (when a handle exists) and
   copy-amount buttons via `navigator.clipboard`, reference input ("Zelle
   conf. #" etc.), mark paid.
6. **Invalidated**: the generated artifact clears whenever the locked total no
   longer matches the payout total (reopen happened, method switched, or a
   data refetch disagrees). Panel returns to state 2 showing the new total.

Fallbacks and guardrails (fleet findings folded):

- **No handle on file** for the selected method: states 3-5 degrade to the
  desktop shape minus copy-handle (copy-amount + reference + mark paid) with a
  "No handle on file" note linking to the person's profile. State 1 shows the
  same note instead of a handle.
- **Clipboard failure**: `navigator.clipboard.writeText` rejection shows a
  toast and reveals the value in a selectable field. A copy failure must not
  strand a Zelle payment mid-flow.
- **Never log generated pay URLs or clipboard payloads** (they embed handle +
  amount): no console.log, no Sentry breadcrumbs carrying them. `buildPayUrl`
  output stays render-only, as today.
- **In-flight states**: every mutating button (Process, Reopen, Mark paid)
  disables while its request is in flight, mirroring the existing `confirming`
  pattern in MarkPaidAction.

Generation is pure client state (Decision 3). The deep-link builders in
`MarkPaidAction.js` (`buildPayUrl`) move to the new component and gain the
period range: the Venmo note becomes `DRB payroll <Mon D – D>` instead of the
static "Dr. Bartender payroll", making every Venmo transaction self-reconciling.
CashApp and PayPal URL formats are unchanged (no note support).

## Server changes (complete list)

1. **`GET /payroll/periods` rollups, strictly ADDITIVE** (fleet blocker B3):
   the existing `total_cents`, `paid_count`, `pending_count` fields are kept
   byte-identical (consumer: `client/src/pages/admin/overview/PayrollStatus.js`
   reads all three by name). ADD `paid_cents` (SUM of paid payouts'
   total_cents) and `owed_cents` (SUM of pending payouts' total_cents). No
   renames. Note: the rollup LEFT JOINs payouts while `loadPeriodWithPayouts`
   INNER JOINs users; the drift is unreachable because `payouts.contractor_id`
   FKs users without CASCADE (a contractor with payouts cannot be hard
   deleted). Accepted.
2. **`POST /payroll/periods/:id/reopen`**: as specced in Lifecycle.
3. **Process route**: accepts `open` and `reopened`; finalizes when no pending
   payouts remain (wedge fix); response's `fee_recapture` summary is surfaced
   by the client (see Client changes).
4. **`POST /payroll/payouts/:id/mark-paid` additions** (all additive):
   - `zelle` joins `ALLOWED_PAY_METHODS` (payroll.js:115) (fleet blocker B2:
     staff can already set `preferred_payment_method='zelle'` via
     staffPortal/paymentMethods.js, but mark-paid rejects it today, a latent
     prod bug this spec fixes). Mirror in the admin client `PAYMENT_METHODS`
     list (`client/src/pages/admin/userDetail/helpers.js`).
   - `payment_reference` (string, ≤200, trimmed, stored): NEW column
     `payouts.payment_reference TEXT` (idempotent ADD COLUMN IF NOT EXISTS).
     Read projections that ADD it: `loadPeriodWithPayouts` (payroll.js:30-34),
     the mark-paid response SELECT (payroll.js:419-424), and the contractor
     payouts endpoint (payroll.js:593-594). It stays OUT of every staff-facing
     projection: staffPortal/payouts.js reads and paystub assembly
     (paystubData.js) keep their explicit column lists, and the existing
     staff-portal PII exclusion test extends to assert `payment_reference`
     never leaks.
   - `expected_total_cents`: presence check is strict `!== undefined` (a $0
     payout total is a designed state under the H1 debt clamp; no truthiness
     checks). Must be a non-negative integer (`Number.isInteger`), else 400
     ValidationError. `total_cents` is ADDED to the existing locked
     `FOR UPDATE` SELECT (payroll.js:385-392) and compared inside that
     transaction; mismatch is a 409 ConflictError ("payout total changed since
     the code was generated; regenerate"). Omitted field = today's behavior
     (back-compat).
5. Nothing else. No accrual, clawback, fee-netting, or healing changes. The
   payroll money seam (payrollAccrual, payrollClawback, payrollLateTip,
   payrollTips, gratuity fee-netting) is out of bounds for this project; the
   `reopened` status was chosen specifically so those files need zero edits.

## Client changes (per file, `client/src/pages/admin/payroll/` unless noted)

- `PayrollPage.js`: tabs become `payrun` / `history` / `tips` / `tax`. URL
  compat: map legacy `current → payrun`, `unassigned → tips` when reading the
  param (useUrlListState). Landing tab = payrun.
- NEW `PayRunView.js`: the queue. Periods with status != 'paid' (open,
  processing, reopened), current first then oldest-debt-first, each a card:
  header (range, status chip incl. a distinct `reopened` chip, paid X of Y,
  Process / Reopen button per status), payout queue rows, stat strip on top
  (still owed, unpaid payouts, oldest open, paid this month). UI states
  specified: loading skeleton, error state with retry, and the happy empty
  state ("Nothing owed. Every period is paid.") when zero unpaid periods
  exist. Surfaces the process response's `fee_recapture` summary as a warning
  toast when `tips_null_after` or `tips_line_unhealed` is nonzero.
- `PayoutRow.js`: becomes the queue row (name, method+handle tag, events/hours
  sub, amount, status chip, Pay button that toggles the expansion).
- NEW `PayPanel.js`: the state machine above. Absorbs `buildPayUrl`.
- DELETED: `PayQRModal.js`, `MarkPaidAction.js` (absorbed into PayPanel),
  `PayrollHeader.js` (dead once PayRunView carries its own strip and
  HistoryView is rewritten; it has no other importers).
- `EventLineItem.js`: unchanged mechanics (serialized PATCH, edit affordances);
  lives in the expansion's left column with the "Payout total / matches the
  code" row underneath.
- `HistoryView.js`: paid periods only (status 'paid'), drill-in read-only,
  shows `payment_reference` (renders NULL as blank, every pre-migration paid
  row is NULL). If deep-linked with a period that is NOT paid, redirects to
  the payrun tab with that period focused (bookmark fallback).
- **Deep-link producers** (fleet blocker B4): `overview/PayrollStatus.js`
  "Due" tile links change from `?tab=history&period=<id>` to
  `?tab=payrun&period=<id>`; `userDetail/PayoutsTab.js` payout links point to
  payrun for unpaid periods and history for paid ones. PayrollStatus is
  otherwise untouched (rollups are additive).
- `UnassignedTipsPanel.js` / `DeferredTipsPanel.js`: unchanged, both render
  under the single Tips repair tab (stacked, unassigned first).
- `TaxTotalsTab.js`: unchanged.
- `index.css`: pay-panel styles on existing tokens, both skins. The QR always
  sits on a white tile (scanners need light background, the one deliberate
  skin-invariant element).

Desktop-first; tables scroll on mobile. File-size discipline: PayRunView and
PayPanel each target <300 lines; split rather than grow.

## Recovery paths (documentation, not features)

- Wrong LINES discovered before paying anyone, or mid-run: Reopen, fix, re-process.
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
- No changes to accrual/clawback/late-tip/fee-netting files.

## Documentation updates (same change, per the mandatory table)

- `README.md`: folder tree (PayRunView.js, PayPanel.js added; PayQRModal.js,
  MarkPaidAction.js, PayrollHeader.js removed), key features note.
- `ARCHITECTURE.md`: route table (`POST /payroll/periods/:id/reopen`,
  mark-paid body additions), Database Schema section (`pay_periods` status
  set gains `reopened`; `payouts.payment_reference`).

## Testing (server, node:test conventions)

One suite, run serially against the shared dev DB (`node -r dotenv/config
--test`). Chicago-keyed track-and-restore pay-period fixtures (test-suite law
from the 2026-07-13 audit: UTC-keyed fixtures go red at night).

- reopen lifecycle: processing→reopened flips; open and paid both 409; PATCH
  works on pending payouts in a reopened period and still 409s on paid
  payouts; mark-paid 409s while reopened; re-process (reopened→processing)
  succeeds and mark-paid works again.
- **writers vs reopened** (the B1 regression fence): with a reopened period
  containing one paid and one pending payout, fire `accruePayoutsForProposal`,
  the late-tip roll-forward, and the clawback path at it; assert every paid
  payout's lines and `total_cents` are byte-identical afterward and the
  late-tip/clawback paths persisted deferral markers instead of writing in.
- drift guard: mark-paid with stale `expected_total_cents` 409s and changes
  nothing; `expected_total_cents: 0` against a $0 payout passes; non-integer
  and negative values 400; omitted field behaves exactly as today.
- zelle: mark-paid accepts `payment_method='zelle'`.
- wedge: process on a period with zero pending payouts finalizes immediately.
- reference: stored, trimmed, length-capped, returned by the three admin read
  paths; staff-portal payout projection test extended to assert it is absent.
- rollups: `paid_cents`/`owed_cents` match SUMs under mixed statuses;
  `total_cents`/`paid_count`/`pending_count` unchanged for existing consumers.

## Risks and review notes

- Sensitive paths: `server/routes/admin/payroll.js` and `server/db/schema.sql`
  are money seam, full fleet per lane regardless of size. Read
  `.claude/seam-sweep-2026-07-02.md` before building (H1 floorless contract,
  one-connection-per-request rule, post-COMMIT tail discipline).
- The reopen route must reuse the guarded-UPDATE race pattern process already
  uses, and must NOT add per-line floors or touch recompute logic.
- Client copy: no em dashes anywhere user-facing.
