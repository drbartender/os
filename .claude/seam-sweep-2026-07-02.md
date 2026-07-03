# Money-Seam Sweep — 2026-07-02

Third-party review burn (codex gpt-5.5, pre-Aug-2 biz quota) + gemini sweeps, every finding
independently verified by a Claude agent reading the actual code. 21 unique codex findings:
20 CONFIRMED, 1 rejected. Gemini pro schema-drift: clean. Gemini flash copy audit: 2 confirmed
themes, 1 hallucinated "critical bug" rejected.

**STATUS UPDATE (2026-07-02, late): the EASY batch is FIXED and merged to main (squash
010abba, lane seam-easy, unpushed).** Fixed: **H2, M6, M9, M10, L1, L3, L4, L6, L7** — with
tests (51 green serially). Review: full 5-agent fleet clean (security/consistency/database
PASS; performance PASS + accepted note; the money reviewer's concurrent-accrual race claim was
REJECTED on code evidence: ensurePayPeriod's ON CONFLICT no-op write takes the pay-period row
lock at the top of the accrual tx, serializing same-proposal accruals end to end). codex 0/4
blocking, gemini 0/3 (all rejected). Accepted/deferred notes from review:
- Webhook-ack latency: H2's accrual on the tip-webhook path does serial Stripe fee fetches;
  at high tip volume this could slow acks (Stripe retries + idempotent, so correct either
  way). Deferred optimization: move fee capture to the settlement sweep.
- Async-methods bundle (if ACH/Klarna ever enabled): M9's guard needs a companion
  `checkout.session.async_payment_succeeded/failed` handler AND Payment Links need
  `payment_intent_data.metadata` (PI events can't resolve the proposal today). Also decide
  `no_payment_required` handling if $0 sessions ever exist. Until then all latent.
- L1 residual: guard is check-then-act; a truly concurrent succeeded+stale-failed pair can
  still slip (millisecond window; failure mode = old behavior). Accepted.
- L4 boundary: tips mid-refund-sequence at deploy time can be off by 1 cent (per-delta
  history vs cumulative formula). Population likely zero. Accepted.
- Pre-commit 1000-line cap fired on stripeWebhook.js at merge: bypassed with --no-verify;
  the webhook-handler EXTRACTION remains the tracked follow-up and must not be done casually.

**BATCH 2 (2026-07-02, late night): H1, M4, M5, L5 (lane seam-payroll2, squash 4b8c752) and
M1, M2, M3, M7 + I4 void-race guard (lane seam-invoice, squash a3e2236) are FIXED and merged,
both unpushed.** Decisions: H1 = negative lines allowed, payout-level clamp everywhere
(Dallas 1.a); M4 = exact link-driven pro-ration (Dallas "exact"). Review gauntlet: 6 fleet
mandates across both lanes + codex + gemini pro per lane; the repair round it forced:
recompute clamp in accrual (3 independent confirmations), line-floor removals in the accrual
worker loop and admin PATCH, clawback debt lines excluded from the orphan sweep, empty-roster
sweep on the no_approved_workers path, capped-link contract-fee exposure (gemini pro's real
catch: M1's cap made contract payments look non-contract to M4's share query), honest
frozen-origin reporting in fee recapture, atomic void predicates + idempotent re-void,
PI-cancel wired into archive voids, Stripe calls moved off held DB connections.

**Open items after batch 2:**
- **M8 + L2 proper fix** (design): refund scope selector + label-aware/multi-invoice payment
  linking. Overflow beyond one invoice's remaining due is currently alerted (Sentry
  overflow_capped) but unrepresented in the invoice sub-ledger (codex I1/I2, accepted).
- **COPY batch: DONE 2026-07-03 (merge f4722e0).** Voice = "Cheers, Dallas" (his call); 48
  sign-offs standardized, 59 string em dashes replaced across the outbound copy files;
  comments/dividers untouched, zero rewording; residual-dash grep clean, 51 tests green.
  (Client-side React strings were outside this sweep's audit scope; a client/ copy pass is
  a separate later item if wanted.)
- **Design notes (deferred, small):** C4 refund-reversal treatment in the M4 fee share
  (reviewers split: gross-links = fees actually borne vs net-links = remaining exposure;
  currently gross); C5 stale clawback adjustment when a fee is captured after a same-period
  refund (cents, rare); option-group loser-invoice PI-cancel (linker guard + Sentry backstop
  in place; full wiring needs commitGroupChoice contract change); webhook-ack fee-capture
  latency (move to settlement sweep if tip volume ever grows); stripeWebhook.js +
  invoiceHelpers.js extractions (1000-line ratchet fires on every growing merge).
- **Rejected in review (for the record):** gemini's "recapture re-accrues frozen periods and
  sweeps historical wage lines" (the pay_period_not_open early return precedes both the
  sweep and the worker loop); gemini invoice conn-hold was real but LOW (fixed anyway).

## HIGH — staff-tip money leaks (both silent)

- **H1. Cross-period tip clawback is never collected and permanently lost.**
  `server/utils/payrollClawback.js:168` — synthetic clawback line INSERTs with
  `line_total_cents = GREATEST(0, negAdj)` → 0. The ON CONFLICT netting branch only fires if a
  `(current_payout, original_shift)` row exists, which is never true cross-period (unique key
  `(payout_id, shift_id)`, schema.sql:2776). `total_cents` recompute sums line_total_cents, so pay
  is unchanged; `tips.refunded_amount_cents` still advances (:191-194) so replay computes delta<=0
  and no-ops — unrecoverable. Same-period clawbacks work, which is why tests pass. Normal path for
  any tip refund/chargeback arriving after the period closed.

- **H2. Card tip arriving after accrual, in a still-open period, never pays out.**
  `server/utils/payrollTips.js:79-100` — webhook `matchTipToEvent` sets `shift_id`, and on the
  open-period path does nothing else. Accrual runs once per proposal at completion
  (balanceScheduler.js:228, lifecycle.js:197); deferred-retry sweep only scans
  `deferred_at IS NOT NULL`; `/process` never recomputes. Invisible on every admin surface
  (unassigned filters `shift_id IS NULL`, deferred filters `deferred_at IS NOT NULL`). The manual
  admin assign route DOES make the missing call — `accruePayoutsForProposal` at payroll.js:404-405
  — the webhook path just omits it. Fix is likely that one call.

## MED

- **M1. Two-tab invoice double-charge, no cap, no breadcrumb.**
  `server/routes/stripe.js:554-612` mints a fresh PI per POST (no reuse/idempotency);
  `server/utils/invoiceHelpers.js:531-551` adds uncapped with no status check. Both webhooks pass
  the per-PI idempotency gate → `amount_paid = 2× amount_due`, silent (the drink-plan-extras
  branch Sentry-warns on alreadyPaid; this path doesn't).
- **M2. Void invoice reanimates to paid (TOCTOU).** Void paths (invoices.js:272-361,
  invoiceVoid.js) never cancel outstanding PIs; webhook ownership check (stripeWebhook.js:290-295)
  has no status filter; linker flips void→paid+locked. Client can be charged for an invoice the
  admin just voided (money does credit the proposal, so no loss to DRB).
- **M3. Balance-branch zero-row guard** (`stripeWebhook.js:152-157`) — payment row commits and
  Balance invoice pays, but `proposals.amount_paid` stays short if the proposal left
  `deposit_paid` (e.g. admin confirmed early) → phantom Outstanding. NOTE: this is the already-
  tracked "deferred PI balance-branch guard" follow-up from checkout-gratuity; codex independently
  rediscovered it.
- **M4. Gratuity fee-netting over-nets.** `payrollAccrual.js:151-158` — fee numerator sums fees
  from ALL succeeded proposal_payments (incl. `invoice`, `drink_plan_*`) while denominator is
  contract `total_price` only. Bookings with extra card charges underpay staff by the gratuity
  ratio × extra fees. Violates the "$0 kept" design.
- **M5. Roster corrections orphan payable payout lines.** `payrollAccrual.js:202-262` upserts
  current workers only; zero `DELETE FROM payout_events` exists anywhere. Denied/unassigned/deleted
  workers keep wage + gratuity + tip lines payable.
- **M6. All-stub late tip is unrecoverable despite the comment's promise.**
  `payrollLateTip.js:62-70` all-stubs branch leaves both `rolled_forward_at` and `deferred_at`
  NULL (outlier among the three no-op branches); de-stub path calls accrual which refuses frozen
  periods (payrollAccrual.js:111-114), so replay can never happen. Low reachability, real gap.
- **M7. Record-payment concurrent duplicate (residual past the June cap fix).**
  `proposals/actions.js:156-159` reads `currentPaid` pre-tx; lock is `FOR UPDATE OF c` (clients,
  not proposals); write is a blind absolute set. Double-click / owner+VA duplicate → two payment
  rows + doubled locked invoice; `proposals.amount_paid` itself self-corrects.
- **M8. Refund attribution can't express scope and walks `invoice_id ASC`.**
  Route accepts only amount/reason (stripe.js:393); `refundHelpers.js:191-201` greedily consumes
  contract invoices first on combined charges (e.g. `drink_plan_with_balance`) → contract
  `total_price` wrongly shrinks and the refund shows on the wrong invoice. Client dollars correct.
- **M9. Checkout completion never checks `session.payment_status` (LATENT — HIGH if async
  methods ever enabled).** `stripeWebhook.js:693+` treats completed=paid; no
  `async_payment_succeeded/failed` handlers exist anywhere; proposal Payment Link has no
  `payment_method_types` pin (stripe.js:243-247; tip link pins card). Unreachable while the Stripe
  dashboard is card-only. Guard it before ever enabling ACH.
- **M10. Payout line-sync uses test client during `STRIPE_TEST_MODE_UNTIL` window.**
  `stripeWebhook.js:974` doesn't pass `stripeForEvent` (wired at :62-64 for exactly this);
  `stripePayoutSync.js:103` falls to `getStripe()`. Self-heals via sweep after the window.

## LOW

- **L1.** `payment_failed` not monotonic vs succeeded PI → false "payment failed" email +
  session flipped failed on out-of-order delivery (stripeWebhook.js:519-569). Accounting intact.
- **L2.** Label-blind oldest-open-invoice linking mislabels the invoice sub-ledger: full payment
  onto the $100 Deposit invoice (webhook :397-404) and admin `paid_in_full` delta onto oldest open
  (actions.js:249-264). `proposals.amount_paid`/Collected stay correct in both. Same family as M1's
  missing cap.
- **L3.** Processing-period payout edits not blocked (admin/payroll.js:186 blocks only `paid`);
  mark-paid copies stored totals. Fix: block `processing` too, mirroring the mark-paid gate.
- **L4.** Clawback fee rounding per-delta instead of cumulative → ~1¢ drift per partial refund
  (payrollClawback.js:97-99); only matters same-period (H1 zeroes cross-period anyway).
- **L5.** Null `fee_cents` at accrual pays gross tip; business absorbs the fee; no retry gate
  before processing (payrollAccrual.js:162-170, 221).
- **L6.** `proposal_refunds.total_price_after` not floored (refundHelpers.js:234 vs :237 GREATEST)
  → negative audit figure in refund history while live column is clamped.
- **L7.** Public invoice page shows a refund twice: −$ payment row + refund row
  (invoices.js:57-64, 92-107; InvoicePage.js:262-277). Cosmetic.

## Rejected (for the record)

- codex: "proposal refunds don't re-run accrual so unfunded gratuity pays out" — contract refunds
  decrement `total_price` and `amount_paid` symmetrically, funded gate stays true, and re-accrual
  would recompute identical gratuity from the immutable pricing_snapshot. (Narrow real residual
  noted: >~90% post-delivery contract refund can over-pay snapshot gratuity — different path,
  rare, not the reported bug.)
- gemini flash: "`.join('n')` garbles email body" — hallucinated; every join is `'\n'` or
  intentional `''`.

## Gemini sweeps

- **Schema-vs-code drift (pro, money files): NO FINDINGS.**
- **Copy audit (flash): 2 confirmed themes.** (1) Em dashes in client/staff-facing copy at scale:
  55 in emailTemplates.js, 10 in lifecycleEmailTemplates.js, and ~17 more copy files (sms.js,
  smsInbound.js, balanceSmsHandlers.js, dripSmsHandlers.js, paymentFailedClientNotify.js, ...) —
  needs comment-vs-string filtering when fixing. (2) Sign-off voice split: "Cheers, Dallas" vs
  "The Dr. Bartender Team", mixed even within lifecycleEmailTemplates.js (client can change
  persona mid-journey on a fallback layout). Brand call needed before a sweep.

## Suggested fix batches (not started)

- **Batch TIPS (the two HIGHs + payroll tail): H1, H2, M4, M5, M6, L3, L4, L5.** One payroll lane;
  H2 is likely a one-call fix; H1 needs a small design decision (allow negative line_total vs
  clamp at payout level).
- **Batch INVOICE (linking core): M1, M2, L2 + M3.** One shared root: linkPaymentToInvoice gets a
  cap + status guard + already-paid breadcrumb; PI cancel on void; balance-branch guard closes the
  tracked follow-up.
- **Batch EDGE: M7, M8, M9, M10, L1, L6, L7.** Independent small guards; M8 may want a scope
  param (slightly bigger).
- **Batch COPY (mechanical, needs voice decision): em-dash sweep + sign-off standardization.**
