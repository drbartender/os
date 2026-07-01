# Payment Accounting Fixes: Financials Refund Netting + Drink-Plan Extras Collection

**Date:** 2026-07-01
**Status:** Design approved via brainstorm dialogue; revised 2026-07-01 to fold in the spec-review fleet (grounding / gaps / risk): 2 blockers, 7 warnings, 4 suggestions. Pending lane plan.

Two independent money-accounting defects were found while reconciling DRB OS against Stripe. They are unrelated in code and ship as separate lanes, but share one spec because they were diagnosed together and are both refund/extras accounting correctness.

- **Part A (read-side):** the Financials "Collected" total and "Payments in range" ledger overstate money because they never subtract refunds. Pure reporting bug. No money moved wrong, no data is corrupt.
- **Part B (write-side + admin UX):** a client who chooses "pay now" for drink-plan extras and then abandons the card leaves the extras committed to the event (syrup on the shopping list) with no record anywhere in the money system. Restores the "extras are always accounted for" guarantee, reusing existing invoice machinery.

The review confirmed the spec is well grounded (every named file, function, route, column, helper, line anchor, the commit hash, and the Part A2 fan-out root cause verify against current code). The revisions below are about completeness in Part B's edge seams and a handful of Part A consumers, not mis-claims.

---

## Guard: do NOT "repair" any payment data

The external reconciliation report that surfaced Part A proposed collapsing "duplicate" payment rows and deleting a "failed" deposit for Ketan Patel and Shruti Parekh. **That remediation is wrong and must not be executed.** Verified against production and Stripe:

- `proposal_payments` holds exactly the right rows (Ketan: one `$100` deposit + one `$550` invoice; Shruti: one `$100` deposit). No duplicates, zero rows with `status='failed'` account-wide.
- Both refunds are correctly recorded in `proposal_refunds` (Ketan `$200`, Shruti `$100`) with correct `stripe_refund_id`, and applied via negative `invoice_payments` lines so each invoice's `amount_paid` is correct (Ketan INV-0009 nets `$350`, Shruti INV-0084 nets `$0`).

The write side is healthy. Deleting any of those rows would destroy correct financial records. Part A is a read-query fix only.

---

# Part A: Financials refund netting

## Problem

Refunds are stored in `proposal_refunds` plus a negative `invoice_payments` line plus a decremented `proposals.amount_paid`. They never reduce `proposal_payments.amount`. The Financials read queries sum `proposal_payments.amount WHERE status='succeeded'` and never look at `proposal_refunds`, so refunded money keeps counting at full value.

Two visible symptoms, both in `GET /api/proposals/financials` (`server/routes/proposals/metadata.js:111-194`):

1. **"Collected" summary** (`metadata.js:174-176`, mapped at `:186`) sums gross succeeded payments. Overstated by the full refunded total.
2. **"Payments in range" ledger** (`metadata.js:160-173`) does `LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id` (`:168`) and projects `pp.amount` on every joined line. A refunded payment has two `invoice_payments` lines (the positive charge and the negative reversal, both on the same invoice; the reversal is written by `refundHelpers.js:203-206` reusing the original `payment_id`), so it renders as two rows at full value. The ledger row list looks duplicated and, summed, double-counts.

The same blind spot exists in the dashboard metrics: `qMoney` paid basis (`server/utils/metricsQueries.js:184-206`) and `qRevenue` paid series (`metricsQueries.js:259-272`), both consumed by the dashboard-stats endpoint (`metadata.js:196-245`, including a prior-period `qMoney(priorF)` at `:238`). `qOutstanding` (`metricsQueries.js:220-230`) reads the refund-aware `proposals.amount_paid`, so the two halves of the dashboard currently disagree by exactly the refunded total.

### Verified reconciliation (production, all-time, matches Stripe `GET /v1/refunds` count=2)

| Figure | Value |
|---|---|
| `SUM(proposal_payments) WHERE succeeded` (34 rows) | $9,555.00 (gross, what "Collected" shows today) |
| succeeded `proposal_refunds` (2 rows: Ketan $200, Shruti $100) | $300.00 |
| **True net collected** | **$9,255.00** |
| Ledger fan-out row sum (gross + refunded-payment double-count) | $10,205.00 |

## Goals

1. "Collected" and the paid-basis dashboard money net refunds (read $9,255 all-time, not $9,555), and the shift propagates to the dashboard-stats KPI cards, the revenue chart paid series, and the prior-period delta.
2. The "Payments in range" ledger renders one row per payment (34, not 36), and the visible rows foot to the net "Collected" total on the same page.
3. `outstanding` and collected are computed on a consistent, refund-aware basis.

## Non-Goals

- No data migration or row repair (see Guard above).
- No redesign of the Financials page beyond what is needed for the ledger to reconcile with the netted total.

## Design

### A1: net refunds out of the paid-basis money aggregations

A refund reduces collected in the window of the **refund's** `created_at` (cash basis; matches reconciliation against Stripe payout activity; identical to gross for all-time). Apply to:

- `metadata.js` "Collected" (`collectedRow`).
- `metricsQueries.qMoney` paid branch (both the `all` and cc-filtered paths).
- `metricsQueries.qRevenue` paid monthly series (subtract each month's succeeded refunds from that month's paid value).

**Implementation constraint (grounding):** on the default `include_cc='all'` path, net refunds via a **scalar subquery on `proposal_refunds`**, not a JOIN, to preserve the existing join-less form that `metricsQueries.test.js` asserts as a perf protection (`test:191-192`, `:217-218`). The cc-filtered path joins `proposal_refunds -> proposals` for the `cc_id` filter, mirroring the payment path. Factor a single `refundsInWindow(dateCol, params, ccMode)` builder so payments and refunds cannot drift.

**Negative windows are allowed and must not be floored (risk + gaps).** A bounded window (or a `qRevenue` month) that contains a refund but not its original payment can legitimately render a negative Collected/paid value. Do NOT clamp to 0 (that re-breaks Stripe reconciliation). `FinancialsDashboard.js:76` and the revenue chart must tolerate a negative value (format it as negative; the `collected/booked` percent must not divide-by-zero or render nonsense on a negative numerator). All-time is always non-negative.

### A2: de-duplicate the ledger AND make it foot to the netted total

Two changes to the `recentPayments` query/render:

1. **One row per payment.** The `invoice_payments` join exists only to attach an invoice link (`ip.invoice_id`, `i.token`). Change it to a `LEFT JOIN LATERAL (... WHERE ip.payment_id = pp.id ORDER BY ip.amount DESC, ip.id LIMIT 1)` so the positive linkage line wins and the negative reversal (and any multi-invoice split) collapses to one display row.
2. **Reconcile with net Collected.** For a payment that has a succeeded refund, render the row at its **net** amount (gross minus that payment's refunds) with a small "refunded $X" annotation, so summing the visible rows equals the netted "Collected" on the same page. This is the minimal display change that makes the page internally consistent; a full separate-refund-line ledger remains out of scope.

## Data model

No schema changes.

## Testing

- Update `server/utils/metricsQueries.test.js`: the paid-branch assertions change (add refund netting); keep the `all`-path "NO JOIN to proposals" assertion satisfied by using a scalar subquery. Add refund-netting assertions for `qMoney` and `qRevenue`.
- Integration: seed one succeeded payment and one succeeded refund; assert `collected` equals net, the ledger returns one row for that payment at net with the refunded annotation, and the visible rows foot to `collected`.
- Enumerate both consumers: assert `/financials` reads $9,255.00 all-time with 34 ledger rows, AND that dashboard-stats KPI cards + the prior-period delta reflect the net figure.
- Negative-window case: a range containing only the refund renders a negative Collected without error and without flooring.

## Files

- `server/routes/proposals/metadata.js` (collectedRow + recentPayments)
- `server/utils/metricsQueries.js` (qMoney paid, qRevenue paid, shared `refundsInWindow` builder)
- `server/utils/metricsQueries.test.js` (updated assertions)
- `client/src/pages/admin/FinancialsDashboard.js` (negative-tolerant Collected + refunded ledger annotation)

---

# Part B: Drink-plan extras collection gap

## Problem

The Potion Planning Lab lets a client pay for drink-plan extras via `POST /api/stripe/create-drink-plan-intent/:token` (`server/routes/stripe.js:35`, amount at `:104`). Since commit `772c337` (2026-04-22), submit has two payment paths distinguished by `paid_separately`:

- **Add to balance** (`paid_separately=false`): extras are folded into the Balance invoice via `refreshUnlockedInvoices`. Tracked and collected normally.
- **Pay now** (`paid_separately=true`): submit **skips** the balance refresh, and the "Drink Plan Extras" invoice is created **only** on `payment_intent.succeeded` (`server/routes/stripeWebhook.js:255-287`, call at `:282`).

A pay-now PaymentIntent abandoned at Stripe status `requires_payment_method` fires no webhook, so the extras land nowhere: no invoice, no `proposal_payments` row, yet the selections (including syrups) persist to `drink_plans.selections` and the shopping list is generated straight from that jsonb (`server/utils/shoppingListGen.js:44-69`, `server/utils/shoppingList.js:414`) with no payment check. Fulfillment (submit -> reviewed -> approved -> finalized, preflight `server/utils/beoFinalize.js:29-42`) has no extras-payment gate. The plan finalizes with unpaid goods and nothing surfaces it.

The original design (`docs/superpowers/specs/2026-04-22-potion-lab-pay-now-invoice-design.md`) also created the extras invoice only on success, so this is a blind spot from day one, not deleted code. The invoice machinery it built is intact and reusable: `createDrinkPlanExtrasInvoice`, `linkPaymentToInvoice`, `findOpenInvoiceForBalance` (`server/utils/invoiceHelpers.js`).

### The two submit paths (this is the crux the review surfaced)

The submit handler (`PUT /t/:token`, `server/routes/drinkPlans.js:141`) treats "extras" as two different things, and a correct fix must too:

- **Add-on / bar-rental extras** go through the financial-side-effects transaction (`hasFinancialSideEffects`, `drinkPlans.js:188-191`) and are **folded into `proposals.total_price`** (`:336-339`, run regardless of `paid_separately`). So for these, `total_price` already includes the extras; the "Drink Plan Extras" invoice is the *artifact* for that portion (it replaces the Balance-invoice line that the pay-now path skips). Sum of a proposal's non-void invoices for this portion equals its slice of `total_price`.
- **Syrup extras** (priced via `pricingEngine.js:166-186`, $30/bottle) take the **non-transactional fast path** (`:483-505`) and are **NOT** added to `total_price`. They are additive money that lives only on the "Drink Plan Extras" invoice. `outstanding` (= `total_price - amount_paid`) does not reflect them, so the admin badge (B3) is their only surface.

A single pay-now charge can contain both components (`extrasAmount = addonTotal + barRentalCost + syrupCost`, `stripe.js:104`). The design below handles both.

### Verified scope (production)

Drink-plan extras have collected once ever ($20). Three uncollected pay-now extras, plans advanced anyway:

| Client | Extra | Stripe status | Plan state | Event |
|---|---|---|---|---|
| Anna Simpson | $60 (syrup-only) | requires_payment_method | finalized, list approved | 2026-07-03 (owner handling manually) |
| Julia Frye | $70 | requires_payment_method | list approved | 2026-06-27 (past) |
| Shiralee Mack Perkins | $20 (3 abandoned PIs, one submit) | requires_payment_method | submitted | 2026-07-11 |

## Goals

1. A pay-now extras selection always produces a "Drink Plan Extras" invoice at submit, whether or not the payment completes and **including syrup-only extras**. Abandoned pay-now leaves a real unpaid invoice: visible and collectable via the normal invoice link and reminders.
2. Admin sees, before finalizing, that a plan has unpaid extras (soft warning, not a hard block), enforced and logged server-side.
3. Admin can comp an extras charge cleanly for the abandoned (fully unpaid) case, keeping `total_price`/`outstanding` consistent.
4. Existing paths (add-to-balance, pay-extras-plus-balance, deposit, balance, invoice payments) are unchanged.

## Non-Goals

- No hard block on finalize. Soft-warn only.
- Comp handles the fully-unpaid extras invoice only (the abandoned case is `amount_paid=0`). A refund-first path for a partially-paid extras invoice is deferred.
- No scheduled sweeper for stale `requires_payment_method` sessions (deferred; the backfill step may cancel specific stale PIs by hand).
- No change to the client-facing pay-now UX or the extras pricing math, and no change to whether syrups fold into `total_price` (they stay additive).

## Design

### B0: extract the submit handler (prerequisite, grounding)

`server/routes/drinkPlans.js` is 1179 lines, over the 1000-line hard-cap ratchet; any inline addition to the submit handler would grow the file and the pre-commit hook blocks it (this is exactly why `beoFinalize.js` was extracted). Before B1, extract the `PUT /t/:token` submit handler and its new extras-invoice logic into a sibling module (e.g. `server/routes/drinkPlans/submit.js` or `server/utils/drinkPlanSubmit.js`), so the file stays flat or shrinks. The plan finalizes the exact split.

### B1: create the extras invoice at submit, for ALL pay-now extras

In the submit handler, when the plan is submitted with a pay-now extras choice and `extrasCents > 0` (add-on, bar-rental, **or syrup-only**), create or refresh one "Drink Plan Extras" invoice via `createDrinkPlanExtrasInvoice` as `status='sent'`, unpaid, `amount_due = extrasCents`, with line items from selections.

- **The syrup-only fast path (`:483-505`) must be given a transaction + proposal `FOR UPDATE` lock** for this write, matching the add-on/bar-rental path; otherwise B1 runs outside any transaction for the canonical case.
- **Find-or-refresh:** before creating, look for an existing extras invoice for the proposal with a single canonical predicate (`label='Drink Plan Extras' AND status <> 'void'`). If a non-void one exists, update its `amount_due` and regenerate line items instead of creating a duplicate. Matching **any non-void** invoice (not just `sent`/`partially_paid`) is required so an out-of-order webhook that already created/paid one is not duplicated (see B2).
- **Shared amount helper:** factor the extras-amount computation (`stripe.js:62-104`) into one helper used by both `create-drink-plan-intent` and submit, so a selection edit between them cannot leave a residual `partially_paid` invoice.

### B2: webhook links the existing invoice instead of creating one

On `payment_intent.succeeded` for `drink_plan_extras` / `drink_plan_with_balance`, find the proposal's extras invoice using **B1's exact predicate** and `linkPaymentToInvoice(extrasInvoice.id, paymentRow.id, extrasCents)` (flips it to paid/locked). Keep create-if-missing as a fallback, but it must stay **inside the existing `isFirstDelivery` guard** (`stripeWebhook.js:81-87`) so a redelivered success cannot create a second invoice. The `with_balance` split (extras portion to the extras invoice, balance portion to `findOpenInvoiceForBalance`) is preserved.

### B3: admin soft-warn (badge + server-enforced finalize warning)

- **Badge:** surface "Extras unpaid: $X" on the drink-plan admin surfaces when the proposal has a non-void, unpaid-or-partially-paid "Drink Plan Extras" invoice. To avoid an N+1 on the dashboard, add a **list-level aggregate**: `GET /api/drink-plans` (`:708-741`) joins/subqueries the open extras-invoice amount per plan.
- **Finalize warning, enforced server-side:** the finalize route (`beoFinalize.js`, admin/manager gated, logs `actor_id`) must itself re-detect the open extras invoice, and when present, require an explicit override flag and write a `proposal_activity_log` entry recording who finalized with unpaid extras and the amount. The client "finalize anyway" confirm is UX only; the server is the gate, so a non-UI/direct finalize cannot skip the warning or the audit entry.

### B4: comp / waive (fully-unpaid case)

Reuse `PATCH /api/invoices/:id {status:'void'}` (admin/manager gated; `'void'` is already a valid `invoices.status`, `schema.sql:1791`; no schema change). It refuses when `amount_paid > 0` (`invoices.js:287`), which is fine for the abandoned case. Additions:

- Write a `proposal_activity_log` entry on void of a "Drink Plan Extras" invoice (the refund path logs `refund_issued`; a comp is an admin money action and must be audited). `PATCH /api/invoices/:id` currently logs nothing.
- **Keep `total_price` consistent.** For the add-on/bar-rental portion (which was folded into `total_price` at submit), comp must also reduce `total_price` by that portion and re-run the existing proposal payment-status re-evaluation (CLAUDE.md cross-cutting rule: a proposal price change re-evaluates `amount_paid` vs total and the paid-in-full flag). The syrup portion was never in `total_price`, so voiding the invoice is sufficient for it. In the common case (syrup-only, Anna) comp is a pure void.
- **Void-before-refresh on path switch.** If a plan with a standing extras invoice is reset-to-draft and re-submitted as add-to-balance, the submit must void the standing extras invoice **before** `refreshUnlockedInvoices` rebuilds the Balance invoice from the extras-inclusive `total_price`, or the add-on portion is invoiced twice.

### B5: reconcile the already-affected clients

The three abandoned extras predate this change, so no invoice exists for them. Derive `amount_due` from the **abandoned PaymentIntent's amount** (authoritative for what the client attempted to pay), not the persisted selections (which may have drifted since). Scope:

- Backfill the live/future one (Shiralee, 2026-07-11): create the unpaid "Drink Plan Extras" invoice from her PI amount so it surfaces, and cancel her stale `requires_payment_method` PIs so they cannot surprise-charge later.
- Leave the past event (Julia, 2026-06-27) and the owner-handled one (Anna) to manual judgment.

Keep this as a one-time script, out of the automated path.

## Data model

No schema changes. Reuses `invoices` (`label='Drink Plan Extras'`, `status='void'` already supported), `invoice_line_items`, `invoice_payments`.

## Edge cases

| Situation | Outcome |
|---|---|
| Pay-now, payment completes (happy path: client awaits submit before `confirmPayment`, `ConfirmationStep.js:49-63`) | One extras invoice (created at submit), linked and marked paid by the webhook. No second invoice. |
| Pay-now, payment abandoned (`requires_payment_method`) | Unpaid extras invoice remains. Badge shows; finalize warns. Collectable via invoice link. |
| Success webhook lands before the submit commit (out-of-order) | Webhook create-if-missing (inside `isFirstDelivery`) makes the invoice; B1's find (match any non-void) reuses it, no duplicate. |
| Repeat pay attempts (Shiralee: 3 PIs, one submit) | One invoice; the submit-once gate (`:166-168`) blocks re-submit, so find-or-refresh is only exercised on the admin reset-to-draft path. |
| Comp, syrup-only | Void the extras invoice; no `total_price` change. |
| Comp, add-on/bar-rental portion present | Void + reduce `total_price` by that portion + re-eval payment status. |
| Reset-to-draft then re-submit as add-to-balance | Standing extras invoice voided before `refreshUnlockedInvoices`; extras invoiced once (on the balance). |
| `with_balance` combined charge | Extras portion links to the extras invoice; balance portion to the open balance invoice, as today. |

## Testing

- Syrup-only pay-now, abandon: one unpaid extras invoice created inside a transaction; badge renders via the list aggregate; finalize route requires the override flag and writes the activity-log entry.
- Add-on pay-now, complete: one extras invoice, paid; `total_price` includes the add-on; no duplicate.
- Out-of-order webhook: only one extras invoice exists after both submit and webhook.
- Comp syrup-only: invoice voided, `total_price` unchanged, activity-log written.
- Comp add-on: invoice voided, `total_price` reduced, paid-in-full re-evaluated.
- Path switch to add-to-balance: extras counted once; standing invoice voided.
- Regression: deposit / balance / `with_balance` / add-to-balance paths and shopping-list generation unchanged.

## Files

- `server/routes/drinkPlans.js` + new submit module (B0 extraction; B1 create/refresh at submit)
- `server/utils/invoiceHelpers.js` (find-or-refresh open extras invoice by canonical predicate; shared extras-amount helper; void-with-audit helper)
- `server/routes/stripe.js` (share the extras-amount helper)
- `server/routes/stripeWebhook.js` (link existing extras invoice; create-if-missing fallback inside `isFirstDelivery`)
- `server/utils/beoFinalize.js` + finalize route (server-side unpaid-extras detection, override flag, activity-log)
- `server/routes/invoices.js` (activity-log on `Drink Plan Extras` void)
- Admin client: `DrinkPlansDashboard`, `DrinkPlanDetail`, plan card (badge from the list aggregate); finalize confirm dialog
- One-time B5 reconciliation script

---

# Decomposition into lanes

- **Lane A (financials refund netting):** read-side only, low risk. Files: `metadata.js`, `metricsQueries.js`, `metricsQueries.test.js`, `FinancialsDashboard.js`.
- **Lane B (extras collection + soft-warn):** money-write and webhook, sensitive paths, full review fleet before merge. Larger; likely split into **B0/B1/B2 server** (submit-handler extraction, invoice-at-submit, webhook link) and **B3 admin** (badge list-aggregate, server-enforced finalize warning), which meet only at the "open extras invoice" predicate. B4 (comp + total_price reconcile) and B5 (backfill script) are follow-on within Lane B.

Both lanes touch sensitive paths (`stripe`, `invoices`, financials) and get the full per-lane review fleet. Neither ships without an explicit push cue. The B0 extraction is a prerequisite so B1 does not blow the file-size cap.
