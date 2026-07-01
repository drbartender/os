# Payment Accounting Fixes: Financials Refund Netting + Drink-Plan Extras Collection

**Date:** 2026-07-01
**Status:** Design approved via brainstorm dialogue, pending lane plan

Two independent money-accounting defects were found while reconciling DRB OS against Stripe. They are unrelated in code and ship as separate lanes, but share one spec because they were diagnosed together and both are refund/extras accounting correctness.

- **Part A (read-side):** the Financials "Collected" total and "Payments in range" ledger overstate money because they never subtract refunds. Pure reporting bug. No money moved wrong, no data is corrupt.
- **Part B (write-side + admin UX):** a client who chooses "pay now" for drink-plan extras and then abandons the card leaves the extras committed to the event (syrup on the shopping list) with no record anywhere in the money system. Restores the "extras are always accounted for" guarantee, reusing existing invoice machinery.

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

Two visible symptoms, both in the Financials endpoint `GET /api/proposals/financials` (`server/routes/proposals/metadata.js:111-194`):

1. **"Collected" summary** (`metadata.js:174-176`, mapped at `:186`) sums gross succeeded payments. Overstated by the full refunded total.
2. **"Payments in range" ledger** (`metadata.js:160-173`) does `LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id` (`:168`) and projects `pp.amount` on every joined line. A refunded payment has two `invoice_payments` lines (the positive charge and the negative reversal, both on the same invoice), so it renders as two rows at full value. The ledger row list looks duplicated and, summed, double-counts.

The same blind spot exists in the dashboard metrics: `qMoney` paid basis (`server/utils/metricsQueries.js:184-206`) and `qRevenue` paid series (`metricsQueries.js:259-272`) both `SUM(pp.amount) WHERE status='succeeded'` with no refund netting. `qOutstanding` (`metricsQueries.js:220-230`) reads the refund-aware `proposals.amount_paid`, so the two halves of the dashboard currently disagree by exactly the refunded total.

### Verified reconciliation (production, all-time, matches Stripe `GET /v1/refunds` count=2)

| Figure | Value |
|---|---|
| `SUM(proposal_payments) WHERE succeeded` (34 rows) | $9,555.00 (gross, what "Collected" shows today) |
| succeeded `proposal_refunds` (2 rows: Ketan $200, Shruti $100) | $300.00 |
| **True net collected** | **$9,255.00** |
| Ledger fan-out row sum (gross + refunded-payment double-count) | $10,205.00 |

## Goals

1. "Collected" and the paid-basis dashboard money net refunds, so they read $9,255 all-time instead of $9,555.
2. The "Payments in range" ledger renders one row per payment (34, not 36); a refunded payment is not duplicated.
3. `outstanding`/collected computed on a consistent, refund-aware basis.

## Non-Goals

- No data migration or row repair (see Guard above).
- No redesign of the Financials page. Surfacing refunds as their own ledger line items is deferred (display polish, not correctness).

## Design

### A1: net refunds out of the paid-basis money aggregations

Introduce one shared refund-sum fragment (cash basis: a refund reduces collected in the window of the **refund's** `created_at`, matching how you reconcile against Stripe payout activity; identical to gross for all-time).

- `metadata.js` "Collected" (`collectedRow`): `net = SUM(succeeded proposal_payments.amount in window) - SUM(succeeded proposal_refunds.amount in window)`, then `toDollars(..., fromCents: true)`.
- `metricsQueries.qMoney` paid branch: same netting for both the `all` and cc-filtered paths.
- `metricsQueries.qRevenue` paid monthly series: subtract that month's succeeded refunds from each month's paid value.

Refund window uses `proposal_refunds.created_at` and the same `dateClause` helper already used for payments. The cc-filter (`include_cc`) applies to refunds via `proposal_refunds.proposal_id -> proposals.cc_id` on the non-`all` path, mirroring the payment path.

### A2: de-duplicate the ledger

The `recentPayments` query joins `invoice_payments` only to attach one invoice link (`ip.invoice_id`, `i.token`) per row. Change it to yield exactly one row per `proposal_payments.id`, choosing a single representative invoice via a `LEFT JOIN LATERAL (... ORDER BY ip.amount DESC, ip.id LIMIT 1)` (the positive linkage line wins; the negative reversal and any multi-invoice split collapse to one display row). Amount stays gross for now; an optional boolean `refunded`/`net_amount` field may be added for display but is not required for correctness.

## Data model

No schema changes.

## Testing

- Integration: seed one succeeded payment and one succeeded refund in a window; assert `collected` equals net and the ledger returns one row for that payment.
- Regression against production numbers (read-only query, dev branch): all-time `collected` reads $9,255.00; ledger returns 34 rows; Ketan and Shruti each appear once.
- Confirm `qOutstanding` and `collected` now move together when a refund is issued.

## Files

- `server/routes/proposals/metadata.js` (collectedRow + recentPayments)
- `server/utils/metricsQueries.js` (qMoney paid, qRevenue paid; possibly a shared `refundsInWindow` builder)

---

# Part B: Drink-plan extras collection gap

## Problem

The Potion Planning Lab lets a client pay for drink-plan extras (add-ons, optional bar rental, hand-crafted syrups) via `POST /api/stripe/create-drink-plan-intent/:token` (`server/routes/stripe.js:35`, amount at `:104`). Since commit `772c337` (2026-04-22, "voluntary pay-in-full"), submit has two payment paths distinguished by `paid_separately` (`server/routes/drinkPlans.js`):

- **Add to balance** (`paid_separately=false`): extras are folded into the Balance invoice via `refreshUnlockedInvoices`. Tracked and collected normally. Correct.
- **Pay now** (`paid_separately=true`): submit **skips** the balance refresh, and the "Drink Plan Extras" invoice is created **only** on `payment_intent.succeeded` (`server/routes/stripeWebhook.js:255-287`, call at `:282`).

A pay-now PaymentIntent that is abandoned (Stripe status `requires_payment_method`) fires no webhook at all, so the extras land nowhere: not on the balance, no extras invoice, no `proposal_payments` row. Meanwhile the selections (including syrups) persist to `drink_plans.selections` and the shopping list is generated straight from that jsonb (`server/utils/shoppingListGen.js:44-69`, `server/utils/shoppingList.js:414`) with no payment check. The fulfillment state machine (submit -> reviewed -> shopping-list approved -> finalized; finalize preflight `server/utils/beoFinalize.js:29-42`) has no extras-payment gate; the only money gate anywhere in the flow is the deposit gate that opens the planner. So the plan finalizes with unpaid goods and nothing surfaces it.

The original design (`docs/superpowers/specs/2026-04-22-potion-lab-pay-now-invoice-design.md`) created the extras invoice only on success too, so this is a blind spot from day one, not deleted code. The invoice machinery it built is intact and reusable: `createDrinkPlanExtrasInvoice`, `linkPaymentToInvoice`, `findOpenInvoiceForBalance` (`server/utils/invoiceHelpers.js`).

### Verified scope (production)

Drink-plan extras have collected once ever ($20). Three uncollected pay-now extras, plans advanced anyway:

| Client | Extra | Stripe status | Plan state | Event |
|---|---|---|---|---|
| Anna Simpson | $60 | requires_payment_method | finalized, list approved | 2026-07-03 (owner handling manually) |
| Julia Frye | $70 | requires_payment_method | list approved | 2026-06-27 (past) |
| Shiralee Mack Perkins | $20 (3 attempts) | requires_payment_method | submitted | 2026-07-11 |

An extras charge maps to real goods: syrups price at $30/bottle (`server/utils/pricingEngine.js:166-186`), so Anna's $60 is DRB-provided syrup.

## Goals

1. A pay-now extras selection always produces a "Drink Plan Extras" invoice at submit, whether or not the payment completes. Abandoned pay-now leaves a real unpaid invoice, so the money is visible and collectable through the normal invoice link and reminders.
2. Admin can see, before finalizing, that a plan has unpaid extras (soft warning, not a hard block).
3. Admin can waive/comp an extras charge cleanly.
4. Existing paths (add-to-balance, pay-extras-plus-balance, deposit, balance, invoice payments) are unchanged.

## Non-Goals

- No hard block on finalize. Soft-warn only (owner keeps the collect-or-comp call).
- No scheduled sweeper for stale `requires_payment_method` sessions (deferred; may cancel abandoned PIs as optional hygiene).
- No change to the client-facing pay-now UX or the extras pricing math.

## Design

### B1: create the extras invoice at submit (pay-now branch)

In the submit transaction (`server/routes/drinkPlans.js`, `PUT /t/:token`), when the plan is submitted with a pay-now extras choice and `extrasAmountCents > 0`, create (or refresh) the "Drink Plan Extras" invoice via `createDrinkPlanExtrasInvoice` as `status='sent'`, unpaid, `amount_due = extrasAmountCents`, with line items generated from selections (same helper the webhook uses today).

**Reuse one invoice across repeat attempts.** Before creating, look for an existing open "Drink Plan Extras" invoice for the proposal (`label='Drink Plan Extras' AND status IN ('sent','partially_paid') AND locked=false`). If found, update its `amount_due` and regenerate line items instead of creating a duplicate. This handles repeat submits/attempts (Shiralee tried three times) without stacking invoices.

The extras amount is computed the same way it is for the intent (`server/routes/stripe.js:62-104`); factor that computation into a shared helper so submit and create-intent cannot drift.

### B2: webhook links the existing invoice instead of creating one

On `payment_intent.succeeded` for `drink_plan_extras` / `drink_plan_with_balance` (`server/routes/stripeWebhook.js`), find the proposal's open "Drink Plan Extras" invoice and `linkPaymentToInvoice(extrasInvoice.id, paymentRow.id, extrasCents)`, which flips it to paid and locked. Keep create-if-missing as a fallback so any invoice created before this change (or a legacy path) still reconciles. The `with_balance` split (extras portion to the extras invoice, balance portion to `findOpenInvoiceForBalance`) is preserved.

Idempotency is unchanged: the `ON CONFLICT (stripe_payment_intent_id) DO NOTHING` guard on `proposal_payments` still prevents double-processing a redelivered success.

### B3: admin soft-warn

- **Badge** on the drink-plan admin surfaces (`DrinkPlanDetail`, `DrinkPlansDashboard`, plan card): "Extras unpaid: $X" whenever the proposal has an open (unpaid or partially_paid) "Drink Plan Extras" invoice. Signal comes straight from `invoices`, no new column.
- **Finalize warning:** the finalize action surfaces the unpaid-extras amount and requires an explicit confirm ("finalize anyway"). It does not block. The override is written to the proposal activity log (who finalized with unpaid extras, and the amount) for audit.

### B4: comp/waive

An admin action voids the open "Drink Plan Extras" invoice (reusing the invoice void/cancel mechanism; confirm what `invoices.status` supports and follow it). Voiding clears the badge and the finalize warning. This is the clean "drop the syrup" path.

### B5: reconcile the already-affected clients

The three existing abandoned extras predate this change, so no invoice exists for them yet. Options, to decide in the plan:

- Backfill: create the unpaid "Drink Plan Extras" invoice for the live/future ones so they surface (Shiralee, 2026-07-11). Leave the past event (Julia, 2026-06-27) and the owner-handled one (Anna) to manual judgment.
- Optionally cancel the stale `requires_payment_method` PIs in Stripe so they cannot surprise-charge later (low risk; tidy).

Recommendation: minimal backfill for Shiralee only; owner handles Anna; flag Julia as a past comp. Keep this out of the automated path.

## Data model

No new schema required. Reuses `invoices` (`label='Drink Plan Extras'`), `invoice_line_items`, `invoice_payments`. Confirm the invoice void status before B4; if none exists, that is the only candidate schema touch and will be called out in the plan.

## Edge cases

| Situation | Outcome |
|---|---|
| Pay-now, payment completes | One extras invoice (created at submit), linked and marked paid by the webhook. No second invoice. |
| Pay-now, payment abandoned (`requires_payment_method`) | Unpaid extras invoice remains. Badge shows; finalize warns. Collectable via invoice link. |
| Repeat submit / repeat pay attempt | Single open extras invoice, amount refreshed. No duplicates. |
| Client switches to add-to-balance after a pay-now attempt | Open extras invoice is voided/superseded; extras go onto the balance via `refreshUnlockedInvoices`. Define precedence in the plan (add-to-balance wins). |
| Admin comps the syrup | Extras invoice voided; badge/warning clear. |
| `with_balance` combined charge | Extras portion links to the extras invoice; balance portion to the open balance invoice, as today. |

## Testing

- Pay-now extras, complete payment: exactly one "Drink Plan Extras" invoice, paid; no duplicate.
- Pay-now extras, abandon payment: one unpaid extras invoice; badge renders; finalize warns and logs the override.
- Repeat submit: single extras invoice, amount updated.
- Comp/waive: invoice voided, signals clear.
- Add-to-balance path and deposit/balance/invoice payment paths verified unchanged.
- Verify the shopping list still generates from selections (unchanged) so fulfillment is not regressed.

## Files

- `server/routes/drinkPlans.js` (submit: create/refresh extras invoice for pay-now)
- `server/utils/invoiceHelpers.js` (find-or-refresh open extras invoice; extras-amount helper shared with stripe.js; void helper if needed)
- `server/routes/stripe.js` (share the extras-amount computation)
- `server/routes/stripeWebhook.js` (link existing extras invoice; keep create-if-missing fallback)
- `server/utils/beoFinalize.js` + finalize route (soft-warn + activity-log override)
- Admin client: `DrinkPlanDetail`, `DrinkPlansDashboard`, plan card (badge); finalize confirm dialog
- Optional one-time reconciliation script for B5

---

# Decomposition into lanes

- **Lane A (financials refund netting):** independent, read-side only, low risk. Files: `metadata.js`, `metricsQueries.js`.
- **Lane B (extras collection + soft-warn):** money-write and webhook, sensitive paths, full review fleet before merge. Files above. Larger; the plan may split into B-server (invoice-at-submit + webhook link) and B-admin (badge + finalize warn) since they meet only at the "open extras invoice" signal.

Both lanes touch sensitive paths (`stripe`, `invoices`, financials) and get the full per-lane review fleet. Neither ships without an explicit push cue.
