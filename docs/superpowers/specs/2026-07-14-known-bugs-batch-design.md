# Known-Bugs Batch: Design (2026-07-14)

Fix batch covering the fix-list "Known bugs" section, the 2026-07-13 post-push P2
residuals, the notification-dup cluster, and two payroll residuals. Every bug was
re-verified against HEAD (f5335c9 era) by a 14-agent Phase-1 investigation before
this spec was written; the full evidence, per-bug fix designs, red-test specs, and
risk analyses live in `2026-07-14-known-bugs-batch-findings.md` (the findings doc).
Builders MUST read their bug's findings section before writing code: it carries
exact current file:line anchors and the constraints that must not be violated.

Verdict roll-up: 13 real (12 CONFIRMED + 1 stale-diagnosis-but-real), 1 ALREADY
FIXED (B12, the autopay-guard drink-plan blindness, closed by lane
p1-guard-coverage 2f6e0dc, live since the aa77b96 push; docs-only remainder).

## Non-negotiable constraints (apply to every lane)

- Honor recorded decisions: M-1 archive-does-the-reaping (migration-plan.yaml
  m1-refund-reap); partial refunds never auto-kill; refundHelpers stays
  essentially untouched; the H1 floorless-line contract (no per-line GREATEST
  floors, payout-level clamp only); under-refund beats double-refund.
- Never resurrect a tech-debt-register §5 REJECTED fix.
- One pooled connection per request; Stripe/external calls off held connections;
  notify tails post-commit.
- Money is integer cents. schema.sql changes idempotent. No em dashes in any
  client-facing copy.
- Server tests share the dev DB: run one suite at a time via
  `node -r dotenv/config --test <file>`. On a flake, re-run serially before
  diagnosing (another window is active on this box).

## The fixes (summary; details in the findings doc)

### B1 refund-leaves-booking-live (prod-confirmed, M-1)
Full refund demotes to 'accepted' and nothing reaps: shift stays open on the
staff feed, invoice stays dunnable, scheduled_messages keep firing. The refund
demotion also locks the admin OUT of the P6 cancel flow (accepted is not a
BOOKED_STATUS), so the two kill switches are mutually unreachable in exactly the
prod ordering. Fix (three pieces): (1) extract cancel.js's shift-reap block
verbatim into new `server/utils/shiftReap.js` (name deliberately avoids the
sensitive *Handlers/*Scheduler globs); cancel.js calls the helper, behavior
pinned by cancel.test.js. (2) POST /:id/archive reaps inside its tx: shiftReap +
pending proposal-level scheduled_messages delete mirroring cancel.js exactly;
ARCHIVABLE_STATUSES unchanged (booked still goes through cancel; mutually
exclusive by status). Post-commit tail: email-only staff notification for reaped
shifts with approved staff (FLAG 1, see below). (3) Client prompt: on refund
response amount_paid <= 0, ProposalDetail routes demoted proposals to the
existing archive flow ("archive this booking?"), still-'confirmed' proposals to
the existing CancelEventDialog. Optional rider shipped with the lane: eventStatusChip
gains a 'Cancelled' branch. Includes B14's TRIM fix inside the extracted helper.

### B2 archive_reason picker
Endpoint reads archive_reason from the body, validated against the route-level
allowlist ['no_hire','client_cancelled','we_cancelled','other'] (semantic subset
of the DB CHECK; 'event_completed'/'option_not_chosen' deliberately excluded),
default 'no_hire', never NULL. scope 'set' carries the same admin reason.
Reason lands in the activity log. Client: reason select in the archive modal
(the no-sibling window.confirm branch also moves into the modal). Display gap
closed in the same lane: archived list SELECT gains archive_reason + label map.

### B3 post-cancel money doors
(1) create-intent-for-invoice/:token gains an archived-proposal guard: 409
ConflictError code EVENT_CANCELLED (not 410: archived→draft recovery exists);
InvoicePage already renders err.message. DESIGN-REVIEW ADDITION (gaps judge,
verified): create-drink-plan-intent/:token has the SAME hole (its SELECT never
reads p.status, and 'with_balance' folds the full post-refund balance back in);
apply the identical 409 EVENT_CANCELLED guard there, with its own red test.
stripe.js is already in kb-b's footprint. (2) Settle-on-archived alert in BOTH
paymentIntentSucceeded.js and checkoutSessionCompleted.js: in-tx activity-log row
action='payment_on_archived' + post-commit Sentry warning + notifyAdminCategory
email telling the admin to re-run Cancel → Refund. The credit itself stays
byte-identical (blocking it would strand money and break refund pickup). (3) At
cancel, run the existing cancelOpenInvoiceIntents over SURVIVING (sent /
partially_paid) invoices too, not just voided ones ('processing' intents remain
untouched by that util, by design). Piece 3 builds in the cancel-family lane A
to avoid cross-lane edits to cancel.js.

### B4 held_state-blind clawback/late-tip upserts
Both ON CONFLICT DO UPDATE line_total recomputes gain a CASE on
`payout_events.held_state = 'held'`. DESIGN-REVIEW AMENDMENT (all three judges,
blocker): B4 and B13 must share ONE system invariant for held rows or paystubs
un-foot and parked debt gets destroyed when an upsert lands on a held-negative
line. The invariant, binding on BOTH kb-c and kb-d:

    held row => line_total_cents = payable components + LEAST(net adjustment_cents, 0)

Concretely: clawback held branch = wage + gratuity + card_tip +
LEAST(payout_events.adjustment_cents + EXCLUDED.adjustment_cents, 0); late-tip
held branch = wage + gratuity + card_tip + EXCLUDED.card_tip_net_cents +
LEAST(payout_events.adjustment_cents, 0). For every held row that exists at
HEAD (both hold callers filter adjustment > 0) LEAST = 0, so this is
byte-equivalent to the components-only design for the positive case; it only
diverges once B13's held-negative rows exist, where the debt must stay inside
line_total so it keeps collecting through the payout-level clamp and the
sign-scoped readers keep footing. The over-claw sub-case test asserts
line_total = LEAST(netted adjustment, 0) (e.g. -3000), NOT 0. ELSE branches
stay byte-identical to today (H1 tests pin this). Sentry breadcrumb when a
claw lands on a held row. Cross-lane test (lives in kb-c's
payrollClawback.test.js, fixture-seeded so it needs no kb-d code): seed a held
row with adjustment_cents = -1500 and line_total = -1500, claw onto it, assert
line_total = LEAST(-1500 - claw, 0) and held_state unchanged. FLAG 2 (reworded):
only the POSITIVE (reimbursement) portion of a held adjustment parks pending
admin confirm; net-negative debt keeps collecting, consistent with FLAG 5.

### B5 cancel-refund retry over-refund
/cancel/refund caps money-out at a lifetime target: snapshot read-back from the
cancel-time activity log (`refund_owed_cents`, written atomically since a2cace5)
plus post-cancel succeeded payments (B3 headroom), `effectiveTarget =
min(liveMath, snapshot + postCancelCents)`. No snapshot row (legacy data): live
math + Sentry warn, exact status quo. All new queries through the held dbClient
inside the advisory-lock tx. Cap only, not target-replacement (FLAG 3).
DESIGN-REVIEW AMENDMENTS (blockers/warnings): (a) B5's mid-loop-failure test
rig MUST throw a DEFINITIVE Stripe error type (StripeInvalidRequestError),
because B6 reclassifies StripeAPIError/StripeConnectionError to leave the row
'pending', and pending rows net into alreadyRefunded; add an explicit green
guard pinning the post-B6 interaction (ambiguous failure leaves a pending row,
the retry computes remainingTarget 0 and refunds nothing until the sweeper
resolves it: conservative, correct). (b) The archived→draft restore transition
(lifecycle.js) now CLEARS cancelled_at, cancelled_by, cancellation_note, and
archive_reason, so a restored proposal is not refundable against a stale cancel
snapshot and a later re-cancel writes a fresh one; focused test in kb-a.

### B6 stranded pending refund + ambiguous-error misclassification
(1) refundExecute passes metadata {proposal_refund_row_id, proposal_id} to
stripe.refunds.create (sweeper anchor). (2) The catch splits: only
StripeInvalidRequestError/StripeCardError mark 'failed' (existing PaymentError
kept); connection/API/unknown errors LEAVE the row pending + Sentry + an
ExternalServiceError whose copy says the status is unconfirmed, do not re-issue.
(3) New `server/utils/refundSweepScheduler.js` (stripePayoutSync DI pattern):
rows pending >30 min with NULL stripe_refund_id, stripe.refunds.list BEFORE any
pooled connection, match by metadata row id first then unique-amount, adopt via
applyRefundReconciliation (the single authority), no candidate → guarded
mark-failed + Sentry. Registered in index.js under
RUN_REFUND_PENDING_SWEEP_SCHEDULER (15-min tick, ~180s stagger), env var added
to .env.example (repo doc tables update in the post-merge docs commit).
DESIGN-REVIEW AMENDMENTS (risk judge, blocker): (a) the sweep SELECT gains
`AND stripe_payment_intent_id IS NOT NULL`; NULL-intent rows are unadoptable,
and stripe-node drops an undefined list param so the query would go
ACCOUNT-WIDE and the unique-amount fallback could adopt a foreign proposal's
refund (ledger corruption); Sentry-warn and skip those rows instead. (b) A
THROWN refunds.list error (wrong mode under STRIPE_TEST_MODE_UNTIL, outage)
SKIPS the row: it stays pending, Sentry-tagged, and never reaches the
mark-failed branch; mark-failed fires only on a successful, intent-filtered,
candidate-less list. (c) Avoid per-tick repeat warnings for a permanently
ambiguous row: warn on first aged encounter, re-warn at most daily.

### B7 shortfall_cents surfaced in CancelEventDialog
Display-only: shortfall-aware toast (toast.info; ToastContext has no warning
method) + a persistent client-alert-warning telling the admin to refund the
remainder by hand in Stripe. New RTL test file (the dialog has none).

### B8 lastMinute test registerAll
Test-only: before() gains preEventHandlers.registerAll() +
registerDrinkPlanNudgeHandlers() mirroring boot, PLUS the new assertion that
event_week_reminder actually got scheduled (that assertion IS the red test).
Optional: assert the conflict-loser leg scheduled zero reminders.

### B9 eventEveSms processing-delete
Revert exactly the two 99fd240 predicate hunks to `status = 'pending'` and add a
comment recording the verified ON CONFLICT semantics: the widened partial unique
index (pending+processing) makes the re-insert a clean DO NOTHING when a mid-send
row survives, so the in-flight send is the single touch and its sent-marker
lands. Do NOT touch the index or the dispatcher. Accepted narrow loss: a
reschedule landing in the seconds-wide mid-send window does not get a fresh
T-24 SMS at the new time (consistent with insertIfMissing semantics).

### B10 thumbtack heal re-notify (calcom refuted at HEAD: no notifications exist there)
The heal marker (proposal_id) cannot distinguish crashed from still-in-flight.
Fix in thumbtack.js only: dedupe SELECT gains
`(created_at < NOW() - INTERVAL '10 minutes') AS heal_eligible`; the heal branch
returns 503 {status:'retry_later'} inside the window (keeps the provider retry
chain alive so a genuine strand still heals after the window). notifyAdminCategory
routed through the existing _deps seam for testability. Existing heal test gains
a created_at backdate (semantics-preserving, call out in review). FLAG 4.
Record: if calcom handlers ever gain notifications, the same age gate (non-2xx
variant) must be added to its strand-heal.

### B11 voice dead-leg dedup TOCTOU
Atomic claim: partial unique index `uq_call_audit_dead_leg ON call_audit
(call_sid, status) WHERE call_sid IS NOT NULL AND status IN
('no-answer','busy','failed','canceled')` (partial so spend-cap rows with NULL
call_sid and 'placed' rows are untouched); new claimDeadLegAudit /
releaseDeadLegAudit in pendingCall.js (INSERT ... ON CONFLICT DO NOTHING
RETURNING id; DELETE on send failure so Twilio redelivery re-claims, preserving
retry-on-failed-send). voice.js dead-leg branch: claim → if not claimed 204 →
send → on failure release. HARD GATE before merge: prod pre-check for existing
duplicate (call_sid, dead-status) pairs; dedupe offenders first or the boot-time
CREATE UNIQUE INDEX fails the deploy.

### B12 autopay guard (ALREADY FIXED; docs + meta only)
Stamp migration-plan.yaml m4 follow_up SHIPPED (lane p1-guard-coverage 2f6e0dc);
add `server/utils/autopayDurableCharge.js` to scripts/sensitive-paths.txt (it is
the sole double-charge protection and matches no existing glob). Distinct
residual recorded, not a bug: a mid-checkout (unconfirmed) drink-plan intent does
not block autopay by design.

### B13 orphan-sweep negative-adjustment (safe fix found)
Extend fixbatch P2's hold machinery. Structural discriminator hasPayable(r) =
wage>0 || gratuity>0 || card_tip_net!=0 || hours>0: pure clawback stubs (all
payables zero) stay excluded byte-identical; negative-adj lines WITH payables get
HELD. holdReimbursementLines line_total becomes LEAST(adjustment_cents, 0)
(provable no-op for all existing positive-adj callers; negative held lines keep
collecting the debt through the payout-level clamp). Same widening in the
empty-roster path. Paystub/staff-portal held-exclusions become sign-scoped
(exclude only held AND adjustment > 0) so breakdowns keep footing. Admin chip
copy for the held-negative case. Sentry warning closes the silent part. PATCH
confirm and roster-rejoin need zero changes (verified). FLAG 5.

### B14 un-TRIMmed position comparisons (3 sites, full inventory)
cancel.js:328 (money: cancel-time clawback capture; lands inside the B1-extracted
shiftReap helper), autoAssign.js:149 (seat counting), coverBroadcast.js:156-159
(cover-broadcast role bucketing). All become LOWER(TRIM(...)). Read-side only;
active write paths already canonicalize, so this only affects legacy/imported/
hand-edited rows. DB-level TRIM normalization logged as optional follow-up, not
shipped (FLAG 6).

## Flags for Dallas (shipped per recommendation; veto any and we re-cut)

1. B1 archive-reap sends an email-only staff notification for reaped shifts with
   approved staff. One step beyond the recorded M-1 letter, but it closes the
   prod-confirmed "bartender applied to a cancelled event and was never told"
   gap and matches the cancel flow's behavior.
2. B4 (reworded after design review): on a held row, only the POSITIVE
   reimbursement portion parks pending your confirm; a net-NEGATIVE adjustment
   (debt) stays inside line_total and keeps collecting through the payout-level
   clamp, consistent with flag 5. Confirm re-arms the netted number; zeroing is
   a conscious write-off. Visible via Sentry + the payroll held badge.
3. B5 ships the conservative CAP. The sibling retry-UNDER-refund residual (live
   gratuity-funded gate flipping false after partial reconciliation) is recorded
   in the fix-list doc; fixing it means replacing the target with the snapshot,
   which changes post-cancel-payment policy to 100 percent and needs your call.
4. B10 knobs: 10-minute in-flight window, 503 (not 200) on the gated fresh
   strand. 503 keeps Thumbtack retrying so heal coverage is not narrowed.
5. B13 behavior change: an off-roster worker's docked wage line now holds at the
   debt (collects) instead of paying wage-minus-dock. Errs toward the business;
   admin can zero to forgive via the existing PATCH.
6. B14 is read-side alignment only; a one-off prod TRIM normalization script is
   the durable end-of-class fix if you want it later.

## Accepted residuals (design review, recorded not fixed)
- B1: the shift-reap block inherits cancel.js's pre-existing lock order (shifts
  then shift_requests) while the staff drop/cover marketplace locks
  shift_requests first; a racing pair can 40P01 and roll back cleanly
  (retryable, no corruption). Pre-existing with cancel; extraction stays
  verbatim rather than silently reordering locks.
- B13: staff-facing line rows (Past tab, payout detail) show a held-negative
  line as a bare negative amount with no marker; the admin chip + Sentry carry
  the context. Staff-side presentation polish is a follow-on.
- B10: if Thumbtack counts repeated 503s toward webhook health/auto-disable,
  the 10-minute window plus the 30/min rate limiter bounds exposure; recorded
  next to the existing provider-never-retries residual.
- B6: an ambiguous-error pending row blocks that charge's refund headroom for
  up to ~45 minutes and is invisible in the history view until resolved; the
  ExternalServiceError copy carries the explanation.

## Explicitly out of scope
- Dispatcher multi-instance double-send (unreachable in prod's single-scheduler
  deploy, prior call). Boot floor re-assert (by design). Deferral-retry bartender
  list (near-unreachable, prior call). M8/L2 refund scope selector (design item,
  needs product decisions). calcom changes (no bug at HEAD).
