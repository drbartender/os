# Post-Payment Settle State and the Deposit-to-Full Invoice Upgrade

**Date:** 2026-08-28
**Status:** Approved (conversational, section-by-section)
**Base:** main @ ac056a8e
**Prompted by:** Mike Boswell (proposal 774): paid $550 in full with a $200 gratuity, and the page that came back told him he had paid $100 and owed $250 by the next day.

## 1. Context and problem

Two defects, one client. Both put a wrong dollar figure in front of someone who had just paid correctly. Stripe, `proposals.amount_paid`, the admin panel and the confirmation email were all right the whole time.

### 1a. The post-payment page renders a row the webhook has not written yet

After `stripe.confirmPayment`, Stripe redirects the client to `/proposal/:token?paid=true`. That load consistently lands inside the `payment_intent.succeeded` webhook's transaction window. Measured on prod for proposal 774 from database clocks (every `created_at` and the `updated_at` trigger use `NOW()`, which is transaction start):

| clock | time |
|---|---|
| webhook transaction starts (`proposal_activity_log` row `paid_in_full`) | 17:04:10.179 |
| page GET arrives (view-bump statement start, stamped into `proposals.updated_at`) | 17:04:11.170 |
| view-bump completes and the `viewed` activity row lands | 17:04:11.648 |
| post-commit tail's first insert (`scheduled_messages` 3047) | 17:04:11.834 |
| shift 385 created (further down the tail) | 17:04:12.513 |

The webhook committed at roughly 17:04:11.6. The page's SELECT ran at 17:04:11.17 and read the pre-commit row: status `accepted`, `amount_paid` 0, `total_price` 350, snapshot without the gratuity. The same ordering holds on every full-payment conversion checked (770, 767, 713, 675): the client's first view after paying falls between the webhook transaction start and the shift creation. The webhook transaction is long (payment insert, proposal update, gratuity apply, invoice create, link and lock, group and archive checks) and the page is fast. This is the normal ordering, not a fluke.

`ProposalView.js` then combined that stale row with the URL flag. `isPaid` is `status in paid states OR paid`, so the paid card rendered; `isFullyPaid` read the stale row and said no; `balanceAmount` fell to the pre-payment formula `total - $100`. Mike saw:

> Booking confirmed. Your remaining balance of $250.00 is due by Aug 29. [Pay balance]

plus a Payment Terms box reading "Deposit Due at Signing $100 / Remaining Balance $250 / Balance Due By Aug 29," a price breakdown totalling $350 with no gratuity line, and a Pay balance button pointing at the $100 Deposit invoice. A reload shows "Fully paid." He loaded the page once.

Why it hid for months: for a deposit payment the stale render is coincidentally correct (remaining = total minus $100, due date from the row). It is only wrong for full payers, and worst for full payers with a gratuity. Mike is the first to write in. The client on proposal 770 almost certainly saw it on 8/25.

A second hole in the same code: Stripe appends `redirect_status` to the return URL. A failed 3DS redirect lands on `?paid=true` with `redirect_status=failed`, and today's page shows "Booking confirmed" on a payment that did not happen.

### 1b. A full payment on deposit-terms proposal strands the remainder off the invoice ledger

`createInvoiceOnSend` mints the first invoice at send time from `proposals.payment_type`, whose column default is `deposit`. So a normal send gets a `Deposit` invoice at `deposit_amount`. When the client picks pay-in-full at checkout, `stripeCreateIntent.js` flips `payment_type` to `full` but nothing reshapes the invoice. The webhook credits the proposal correctly, then its label-blind fallback links the whole capture onto the only open invoice, and `linkPaymentToInvoice` caps the credit at remaining due and drops the rest into a Sentry warning (`invoice_link_overflow_capped`, DRBARTENDER-SERVER-1E, five events in 28 days, none acted on). `createBalanceInvoice` never mints a row for the remainder because it is gated on `paymentType === 'deposit'`.

Result for Mike: one invoice, INV-0336 `Deposit`, $100 due, $100 paid, locked. `invoice_payments` row 87 records $100 of a $550 payment. The portal's Receipts tab shows "INV-0336 · Deposit · $100.00 · paid" and nothing else. Twenty of the twenty-two full-payment bookings since June look like this; the two that do not (728, 700) were sent as full-payment terms to begin with.

This is the backlog entry "Paying in full on a deposit-terms proposal strands the remainder off the invoice ledger" (found 2026-08-25 on Meg Henke, proposal 770). That entry already names the fix direction and the blast radius: thirteen proposals since 2026-07-02, about $4,605. Mike makes fourteen, about $5,055.

The cap is correct and stays. It is the seam-sweep M1/M2/L2 guard against a stale intent overfilling an invoice. The fix is upstream of it.

### The rule both fixes apply

From the 2026-07-28 invoice-derivation post-mortem: **the proposal wins**. An invoice is a derived view of its proposal, and a client-facing surface renders the proposal's settled state or nothing. The same law was applied this morning on the signature side (`e8101a9d`, `acknowledged_total` carries row truth). This spec applies it at two more seams.

## 2. Decisions

1. `?paid=true` means "a checkout redirect happened, go find out what the record says." It never by itself means paid. No dollar figure renders from a row the page has not confirmed is settled.
2. A client who arrives at full payment from deposit terms gets **one receipt**: the open Deposit invoice is re-derived into the Full Payment invoice before the payment is credited. Not a Deposit plus a Balance.
3. **All fourteen** existing bookings are backfilled into that shape, including the completed ones. What is frozen in those locked rows is a recording error, not a true receipt; `proposal_payments` holds the truth.
4. The overflow warning reaches Dallas by email, not only Sentry.
5. Two worktree lanes: `pay-settle-page` (client plus one small read endpoint) and `full-pay-invoice` (webhook, admin path, helper, backfill, alert). The page lane ships first and alone.

## 3. Lane 1: the page after payment

### 3a. Redirect handling (`client/src/pages/proposal/proposalView/ProposalView.js`)

Read three URL params on mount: `paid`, `redirect_status`, `payment_intent`. Define:

- `redirected` = `paid === 'true'`
- `redirectSucceeded` = `redirected && (redirect_status is absent || redirect_status === 'succeeded')`

Settling mode engages only when `redirectSucceeded`. A redirect with any other `redirect_status` renders the page exactly as a fresh visit would (the sign-and-pay form for an unpaid row), with the existing toast replaced by a neutral line: "That payment did not go through. Nothing was charged. You can try again below."

`isPaid` becomes `PAID_STATES.includes(proposal.status)` only. The `|| paid` half is removed. The paid card can render only from row state.

`isPayableStatus` keeps its existing `!paid` guard so no intent is minted during settling.

### 3b. Settling state

On the `redirectSucceeded` load the page fetches the proposal exactly as today (one full GET, one view bump, one `viewed` row). Then:

- If the row is in a paid state, render the paid card from the row. Done.
- Otherwise enter `settling`. Render, in the slot the paid card occupies: a check-less card titled "Confirming your payment" with a quiet spinner and the line "This usually takes a few seconds." The sign-and-pay form stays hidden. The Payment Terms box renders no deposit, balance or due-date rows while settling.

Poll `GET /api/proposals/t/:token/payment-state` every 1.5 seconds, up to 13 attempts (about 20 seconds). On the first response whose status is a paid state, stop polling, refetch the full proposal once, and render from it.

If all attempts pass without a paid state, render the fallback: "Your payment went through. We are finishing up on our side and your confirmation email is on its way." with a Refresh link that reloads without the redirect params. No dollar figures. No Pay balance button.

Polling stops on unmount and is not restarted by re-renders.

### 3c. The read endpoint (`server/routes/proposals/publicToken.js`)

`GET /t/:token/payment-state`, public, `requireUuidToken`, `publicLimiter`, non-mutating. Returns:

```json
{ "status": "balance_paid", "amount_paid": 550, "total_price": 550, "payment_type": "full" }
```

Dollars, as the proposal row holds them. 404 on an unknown or archived token, mirroring the resolve endpoint. It must not touch `view_count`, `last_viewed_at`, or `proposal_activity_log`. The existing full GET cannot be the poller because it does all three on every call, and thirteen polls would record thirteen views.

### 3d. Row-truth rendering once settled

The paid card and the Payment Terms box both derive from the row through one pure helper, `paidState(proposal)` in a new `client/src/pages/proposal/proposalView/paidState.js`, returning one of:

- `full`: `status === 'balance_paid'` or `amount_paid >= total_price - 0.01`. Card: "Fully paid." Terms box: "Paid in full" with the amount and the date of the payment when `accepted_at` is present.
- `deposit`: paid state and not full. Card: "Deposit received." with remaining balance and due date from the row. Terms box: "Deposit paid" amount, "Remaining balance" `total_price - amount_paid`, "Balance due by" date. Autopay line as today when `autopay_enrolled`.
- `none`: not a paid state. The existing pre-payment Terms box (Deposit due at signing / Remaining / Due by).

`balanceAmount` for the Terms box and the card comes from `paidState`, never from the pre-payment formula, once the row is paid. "Deposit Due at Signing" never renders on a paid booking.

### 3e. Out of scope for this lane

`InvoicePage.js` has the same `?paid=true` pattern but renders the invoice's own fixed amounts, so its post-redirect render is correct by construction. The drink-plan `ConfirmationStep.js` renders no money from the row after its redirect. Neither changes.

## 4. Lane 2: the deposit-to-full invoice upgrade

### 4a. The helper (`server/utils/invoiceLifecycle.js`)

```
upgradeDepositInvoiceToFull(proposalId, dbClient) -> invoice row | null
```

Finds the proposal's invoice with `label = 'Deposit'`, `status = 'sent'`, `locked = false`, `amount_paid = 0`, not void. If none, returns null and writes nothing. Otherwise, in the caller's transaction:

1. Reads `total_price` and `external_paid` from the proposal.
2. Updates the invoice: `label = 'Full Payment'`, `amount_due = toCents(total_price) - toCents(external_paid)` floored at 0, `due_date = NULL`. The invoice number is unchanged.
3. Regenerates line items via `generateLineItemsFromProposal` and `writeLineItems`, the same pair `createInvoiceOnSend` uses.
4. Inserts `proposal_activity_log` action `invoice_upgraded_to_full`, actor `system`, details `{ invoice_id, invoice_number, from_amount_due, to_amount_due }`.

Returns the updated invoice row. The guard means a Deposit invoice that has been partially paid, locked, or already relabelled is never touched.

### 4b. Webhook call site (`server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`)

In the label-blind fallback branch (the one that selects the oldest open non-off-ledger invoice), when `paymentType === 'full'`, call `upgradeDepositInvoiceToFull(proposalId, dbClient)` before the open-invoice lookup. The lookup then finds the re-derived Full Payment invoice, `linkPaymentToInvoice` credits the whole capture with no overflow, and the existing lock-on-paid fires.

The gratuity election is applied to `total_price` near the top of the same transaction, before this point, so the helper reads the final total.

The `createBalanceInvoice` gate (`paymentType === 'deposit'`) is unchanged. Nothing about `linkPaymentToInvoice`, its cap, or its status guard changes.

### 4c. Admin record-payment call site (`server/routes/proposals/actions.js`)

When `paid_in_full` is set on an admin-recorded payment, call the same helper inside that transaction, after the proposal's `amount_paid` update and before its invoice link. Same helper, so the two entrances cannot drift.

### 4d. The overflow alert (`server/utils/invoiceLinking.js`)

`warnLinkAnomaly('overflow_capped', ...)` keeps its Sentry breadcrumb and additionally calls `notifyAdminCategory` on category `payment_failure` with subject "Invoice link overflow on proposal #N" and a body naming the invoice, the payment, the credited and dropped cents. Email only. Fire-and-forget with its own catch, so a notification failure never affects the link. After 4b ships, an overflow on this path means something new.

## 5. Lane 2: the backfill

### 5a. Script

`scripts/backfill-full-payment-invoices.js`, run from the repo root. Dry run by default; `--apply` writes. There is no reliable way for a script to prove which database it is pointed at, so before doing anything it prints the database host it is about to touch and the mode, and it writes only when the literal `--apply` flag is present.

### 5b. Selection

Proposals where all of the following hold:

- `amount_paid >= total_price` and `total_price > 0`
- exactly one non-void invoice whose label is in `['Deposit', 'Balance', 'Full Payment']`, and that invoice is `label = 'Deposit'`, `status = 'paid'`, `locked = true`
- an `invoice_payments` row links that invoice to a `proposal_payments` row whose `amount` exceeds the invoice's `amount_due`

Exclusions applied after selection, each printed as a skip with its reason:

- `external_paid > 0` (the CC-transfer cohort, documented separately)
- proposal 600 (legal hold)
- any `proposal_refunds` row on the proposal (needs eyes, not a script)

The dry run prints one line per candidate: proposal id, client name, invoice number, current label and amounts, target amounts, and whether line items will regenerate. Fourteen lines are expected. A different count is a reason to stop and look, not a reason to apply.

### 5c. Per-proposal write (own transaction each)

1. `invoices`: `label = 'Full Payment'`, `amount_due = payment.amount`, `amount_paid = payment.amount`. `status` and `locked` untouched.
2. `invoice_payments`: `amount = payment.amount` on the linking row.
3. Line items regenerate only when `toCents(total_price) === payment.amount`. Otherwise left alone and reported.
4. `proposal_activity_log` action `invoice_backfilled_to_full`, actor `system`, details `{ invoice_id, invoice_number, from_amount_due, to_amount_due, lines_regenerated }`.

Idempotent: a re-run selects nothing, because the invoice is no longer labelled Deposit. A failure on one proposal rolls back only that proposal; the rest proceed and the breadcrumbs say which landed.

### 5d. Run order

Only after lane 2's code is live on main. Dry run, Dallas reads the fourteen lines, then `--apply`.

## 6. Tests

Written before the code they cover.

Lane 1:
- `paidState.test.js`: the exact pre-commit row Mike received (status `accepted`, `amount_paid` 0, `total_price` 350) returns `none`; a `balance_paid` row returns `full`; a `deposit_paid` row returns `deposit` with the right remaining amount; a `confirmed` row with `amount_paid >= total_price` returns `full`.
- A component test that the settling state renders no `$` anywhere in the paid-card slot or the Terms box, and that the fallback state renders no `$` and no Pay balance link.
- A component test that `redirect_status=failed` renders the sign-and-pay form, not the paid card.
- Server test for `payment-state`: returns the four fields, 404s on archived, and leaves `view_count` and `proposal_activity_log` untouched across five calls.

Lane 2:
- Helper guard cases: no invoice, locked, partially paid, label Balance, label Full Payment, void. Each returns null and writes no row and no breadcrumb.
- Helper happy path: label, amount, due_date, line items, breadcrumb.
- Webhook, in the `paymentIntentSucceeded.*.test.js` style: a deposit-terms proposal receives a `full` intent for `total_price`; afterwards exactly one contract invoice exists, labelled Full Payment, `amount_due = amount_paid = intent.amount`, paid, locked; `invoice_payments.amount = intent.amount`; no `overflow_capped` anomaly.
- The same through `POST record-payment` with `paid_in_full`.
- A deposit intent on the same fixture still yields Deposit paid plus a Balance invoice, unchanged.
- Backfill: dry run on a fixture returns the candidate and skips a CC-transfer row, proposal 600, and a refunded row; `--apply` produces the 5c shape; a second `--apply` writes nothing.

## 7. Review and rollout

- Lane 1: one reviewer plus the client suite. Client-only plus one read endpoint.
- Lane 2 and the backfill: full pre-prod fleet plus `/second-opinion`. Webhook and ledger.
- Order: lane 1 merges and ships first, alone. Lane 2 second. Backfill after lane 2 is live.
- `docs/walkthroughs-owed.md`: after both lanes are live, a real full payment with a gratuity, watching the post-checkout page settle to "Fully paid" and the portal Receipts tab show one Full Payment invoice. The existing Tier 1 entry from this morning is updated to require both lanes rather than replaced.
- Backlog: the "Paying in full on a deposit-terms proposal strands the remainder" entry is deleted when lane 2 plus the backfill land, per the ledger's rule.

## 8. Not in scope

- The provenance-first invoice-derivation redo. This spec fixes one seam under the existing derivation and does not add the in-total-price boolean.
- Line-item totals on override'd proposals (separate backlog entry).
- Proposal 770's abandoned $75 gratuity. Not ours to add back.
- Any change to `linkPaymentToInvoice`'s cap or status guard.
