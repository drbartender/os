# Potion Lab Pay-Now Invoice Generation

**Date:** 2026-04-22
**Status:** Design approved, pending written-spec review

## Problem

The Potion Planning Lab ConfirmationStep lets a client pay for drink-plan extras via Stripe (`POST /api/stripe/create-drink-plan-intent/:token`). The charge succeeds and a `proposal_payments` row is written, but **no `invoices` row is ever created** for the payment. The money is recorded; the invoice artifact is not. Admin and client see no invoice corresponding to the charge, and the Balance invoice (if it exists) ends up with the extras payment silently applied to it via the webhook's "link to oldest open invoice" fallback — which mixes unrelated money and never accounts for the extras in line items.

A second, related gap: clients who are **not** past-due cannot currently choose to pay their remaining event balance from the Potion Lab. They can only pay extras or add everything to a future balance. We want to offer "pay balance in full now" as a voluntary option.

## Goals

1. Every pay-now action from the Potion Lab produces a correct invoice artifact with line items matching what was charged.
2. Clients with a non-past-due balance can choose to pay it now alongside their extras.
3. "Add to balance" continues to work without payment and correctly updates any open balance-style invoice so it includes the new extras.
4. Existing past-due forced-pay behavior is preserved.

## Non-Goals

- Does not touch the proposal view, invoice page, or client portal pay flows. Proposal view already has its own pay-in-full option.
- Does not add a pay-now option for drink plans with no linked proposal.
- Does not redesign how balance/deposit invoices are created on proposal send or deposit success.

## UX

The ConfirmationStep's existing Payment card shows four scenario variants, driven by `paymentScenario` returned from the intent endpoint. Only one is new; two are extended.

### Scenario `extras_required` (past-due, balance already paid)
*Unchanged.* Single pay button for extras. Forced.

### Scenario `extras_plus_balance` (past-due with outstanding balance)
*Unchanged.* Forced combined charge (extras + balance). Shows itemized breakdown.

### Scenario `extras_optional` (not past-due)
**Extended** from two options to three:

```
How would you like to handle payment for your extras?

○ Pay $45.00 Now
  Take care of it now and you're all set.

○ Pay Extras + Balance in Full — $565.00
  Settle your event balance too. Due May 15.

○ Add to My Balance
  $45.00 added to your balance (due May 15).
```

The middle option shows only when an outstanding balance exists (`currentBalance > 0`). Default selection: **Pay Now** (matches the current component's default for `extras_optional`).

### Scenario `no_extras_no_pay` (no extras, not past due)
*Unchanged.* No payment card shown.

### Copy rules
- No "past due" language in `extras_optional`.
- Amounts shown in dollars with `.00` precision.
- Balance due date formatted as `Month Day` (e.g. "May 15").

## Client-side changes — `ConfirmationStep.js`

- Pass a new `paymentChoice` ∈ `{ 'extras_only', 'with_balance', 'add_to_balance' }` to the intent endpoint when `extras_optional`. For `add_to_balance` the intent endpoint is not called at all (same as today's "Add to My Balance" flow).
- When the user switches between "Pay Now" and "Pay Extras + Balance in Full", re-fetch the intent so the PaymentElement reflects the new total. Debounce 300 ms.
- `payLabel` for the Stripe button reads `Pay $X.XX & Submit`, using the total the intent returned.
- Pre-existing state variables (`clientSecret`, `paymentScenario`, `paymentAmounts`) stay; `paymentChoice` adds a new third value `with_balance`.

## Server-side changes — `server/routes/stripe.js`

### `POST /api/stripe/create-drink-plan-intent/:token`

- Accept new optional body field `paymentChoice` ∈ `{ 'extras_only', 'with_balance' }`. Default `'extras_only'`.
- Compute `currentBalance` as today.
- Scenario resolution:
  - `isPastDue && currentBalance > 0` → `extras_plus_balance` (forced), `totalCharge = extras + currentBalance`.
  - `isPastDue && currentBalance === 0` → `extras_required` (forced), `totalCharge = extras`.
  - Not past due → `extras_optional`. `totalCharge = extras + (paymentChoice === 'with_balance' ? currentBalance : 0)`.
- `payment_type` metadata:
  - `totalCharge > extras` → `'drink_plan_with_balance'`.
  - Otherwise → `'drink_plan_extras'`.
- Intent metadata additionally stores `extras_amount_cents` and `balance_amount_cents` so the webhook can split the charge without re-deriving.
- Response adds `balanceOptionAvailable: true` whenever `!isPastDue && currentBalance > 0`, so the client knows whether to render the middle radio option.

### Webhook handler (`payment_intent.succeeded`)

Replace the current "link to oldest open invoice" fallback for drink-plan payment types with typed handling. Both branches run inside the existing transaction.

```
if (paymentType === 'drink_plan_extras') {
  await createDrinkPlanExtrasInvoice(...)
  // new invoice, linkPaymentToInvoice for full intent amount
}

else if (paymentType === 'drink_plan_with_balance') {
  const extrasCents = Number(intent.metadata.extras_amount_cents);
  const balanceCents = Number(intent.metadata.balance_amount_cents);

  // 1. Create new "Drink Plan Extras" invoice; link extrasCents of this payment.
  const extrasInvoice = await createDrinkPlanExtrasInvoice(...);
  await linkPaymentToInvoice(extrasInvoice.id, paymentRow.id, extrasCents, dbClient);

  // 2. Apply balanceCents to the open Balance (or Full Payment / Deposit fallback) invoice.
  //    Use same priority order as createBalanceInvoice.
  const openInv = await findOpenInvoiceForBalance(proposalId, dbClient);
  if (openInv) {
    await linkPaymentToInvoice(openInv.id, paymentRow.id, balanceCents, dbClient);
  }
  // If no open invoice exists, balanceCents stays unlinked — proposal_payments
  // row still records the receipt. Logged to Sentry as a soft warning.
}
```

The legacy `invoice_id` metadata branch (for `payment_type === 'invoice'`) is unchanged.

## New helper — `server/utils/invoiceHelpers.js`

```js
async function createDrinkPlanExtrasInvoice({ proposalId, selections, extrasAmountCents, pricingSnapshot }, dbClient)
```

Responsibilities:
1. Create a new invoice with `label = 'Drink Plan Extras'`, `status = 'sent'`, `amount_due = extrasAmountCents`, `due_date = null`.
2. Generate line items from `selections`:
   - **Add-ons**: one line per `selections.addOns[].slug` that has `enabled: true`. Description = addon name (with `(N guests)` suffix when `billing_type === 'per_guest'`). `source_type = 'addon'`, `source_id = service_addons.id`.
   - **Bar rental**: one line when `selections.logistics.addBarRental === true`. Description = "Additional Portable Bar" if `num_bars >= 1` else "Portable Bar Rental". `source_type = 'fee'`.
   - **Syrups**: one line when extras include syrups. Description = `Hand-Crafted Syrups (N bottles)`. `source_type = 'fee'`.
3. Return the invoice row.

The helper is exported and used by the webhook. It does **not** call `linkPaymentToInvoice` itself — the caller does, so both branches above can pass the correct `amountCents`.

### New helper — `findOpenInvoiceForBalance`

```js
async function findOpenInvoiceForBalance(proposalId, dbClient)
```

Returns the oldest invoice where `status IN ('sent', 'partially_paid')`, **label IN ('Balance', 'Full Payment', 'Deposit')**, ordered by label priority (`Balance` > `Full Payment` > `Deposit`) then `id ASC`. Returns `null` if none.

This replaces the anonymous "oldest open invoice" fallback in the current webhook with an intentional lookup that skips `Drink Plan Extras` and any other bespoke invoices.

## Server-side changes — `server/routes/drinkPlans.js`

One fix to the existing "Add to balance" path: when the drink plan is submitted without payment, the proposal's `total_price` and `pricing_snapshot` get recalculated, but `refreshUnlockedInvoices` is not called. Result: the Balance invoice's `amount_due` and line items stay out of sync with the new total.

Add a `refreshUnlockedInvoices(proposal_id, dbClient)` call inside the existing submit transaction, after the proposal update and before the commit.

## Data model

No schema changes. Existing columns and tables are sufficient:

- `invoices` — new rows with `label = 'Drink Plan Extras'`.
- `invoice_line_items` — line items per helper above.
- `invoice_payments` — supports splitting one `proposal_payments` row across two invoices (extras invoice + balance invoice) by inserting two rows with different `amount` values.
- `stripe.paymentIntent.metadata.extras_amount_cents` / `balance_amount_cents` — new metadata keys, no migration needed.

## Edge cases

| Situation | Outcome |
|---|---|
| Stripe charge succeeds, invoice creation throws | Transaction rolls back, payment stays in `proposal_payments` via ON CONFLICT guard on retry. Webhook retry recreates invoice. If the insert is deterministically broken, Sentry captures and admin can backfill. |
| Duplicate webhook delivery | Existing `ON CONFLICT DO NOTHING` on `proposal_payments.stripe_payment_intent_id` short-circuits. Invoice creation only runs on first delivery (`isFirstDelivery === true`). |
| `drink_plan_with_balance` fires but no open Balance/Full-Payment/Deposit invoice exists | Extras invoice is still created. Balance portion recorded only in `proposal_payments`. Sentry warning logged. Admin can manually reconcile. (This case is rare — it means the proposal was paid-in-full but client still had a `currentBalance` somehow.) |
| Client selects "with_balance" in UI, then past-due window kicks in between render and charge | Intent endpoint enforces server-side: re-computes `isPastDue` at intent creation, overrides to `extras_plus_balance` if so. UI copy might be slightly stale but amount matches. |
| Open invoice is `Deposit` (deposit not yet paid) and client picks "with_balance" | Payment is applied: `linkPaymentToInvoice(depositInvoice, balanceCents)`. This overpays the Deposit invoice (`amount_paid > amount_due`), triggering `status = 'paid'` and locking it. Any overpayment stays recorded as credit via `proposal_payments.amount`. `createBalanceInvoice` does NOT run on this payment type, so a lingering Balance invoice is never created. **Accept this as a rare edge — admin can manually create a zero-amount Balance invoice to close the loop, or we can add an explicit follow-up in v2.** |
| Client picks "with_balance" but `currentBalance === 0` (already paid in full somehow) | Intent endpoint collapses to `extras_only` regardless of client input. |
| Multiple submissions (client refreshes and re-pays) | Second intent gets a new PaymentIntent ID. Second webhook creates a second extras invoice if charged. Existing proposal_payments uniqueness on `stripe_payment_intent_id` prevents double-booking a single charge. |

## Testing

- Manual smoke:
  - Deposit-paid proposal, extras = $45, click "Pay Now" → new `INV-NNNN` with label "Drink Plan Extras", status paid, 1 line item (addon). Balance invoice untouched.
  - Deposit-paid proposal, extras = $45, balance = $400, click "Pay Extras + Balance in Full" → one charge of $445, new Drink Plan Extras invoice for $45 paid, Balance invoice's `amount_paid` incremented by $400, status paid, locked.
  - Deposit-paid proposal, extras = $45, click "Add to My Balance" → no Stripe charge. Balance invoice refreshed: `amount_due` increased by $45, line items now include the addon.
  - Past-due proposal, extras = $45, balance = $400 → forced combined charge of $445. Same invoice outcome as above.
  - Full-payment proposal (no deposit), extras = $45, pay extras only → new Drink Plan Extras invoice; Full Payment invoice unchanged.

- Data verification:
  - `SELECT invoice_number, label, amount_due, amount_paid, status, locked FROM invoices WHERE proposal_id = N ORDER BY id;` shows expected state after each scenario.
  - `SELECT * FROM invoice_payments WHERE payment_id IN (...);` shows the split for `drink_plan_with_balance`.
  - `SELECT amount_paid, total_price, status FROM proposals WHERE id = N;` reflects payment and proposal status transitions.

## Open questions

None.
