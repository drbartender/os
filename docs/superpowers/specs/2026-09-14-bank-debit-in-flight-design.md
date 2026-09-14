# Bank debit in flight: design

**Date:** 2026-09-14
**Status:** approved section by section in the brainstorm (Dallas, 2026-09-14)
**Incident:** proposal 784, Thekla Eftychiadou, paid the $400 Balance invoice INV-0363 twice by bank debit (9/5 and 9/7). Both settled 9/11. Refunded by hand 9/14.

## 1. Problem

A bank debit (Stripe `us_bank_account`, charge ids `py_`) confirms into the PaymentIntent status `processing` and settles four to six business days later. Between those two moments the system knows nothing:

- The Stripe webhook endpoint (`we_1TCm2cAZrfv5tWfNcqAOhf3x`) subscribes to exactly four events: `payment_intent.succeeded`, `checkout.session.completed`, `payout.paid`, `payout.failed`. No processing event, and no `payment_intent.payment_failed` either, so the handler built for failures has never run in production (zero rows, ever).
- `stripe_sessions.status` stays `pending`, the same value an abandoned intent carries forever (389 such rows).
- `invoices.amount_paid` and `proposals.amount_paid` are unchanged, so `POST /api/stripe/create-intent-for-invoice/:token` computes the full balance again and mints a second intent. The deposit rail (`stripeCreateIntent.js`) retrieves the newest pending intent from Stripe, sees it is `processing`, deliberately leaves it alone, and mints another.
- `InvoicePage.js` calls its success handler whenever `stripe.confirmPayment` returns no error, so a processing debit renders "Payment successful! Thank you." and a PAID stamp, then nothing arrives by email because receipts fire on settlement.
- The balance reminder ladder reads `total_price - amount_paid` and keeps sending "you owe $400" (due-today 9/5, late 9/7, late 9/9 on proposal 784, two of them after she had paid twice).
- The proposal page shows "remaining balance of $400 is due by Sep 5" with a Pay balance button.

Cards are unaffected. A card intent goes straight to `succeeded` during confirm and the webhook lands about a second later. Processing exists only for methods where money moves later.

Both of the 2026-08-28 fix-list entries under "An async payment method traps the settle page for days" and "create-intent mints a fresh intent beside a succeeded/processing one" are this defect. This design retires both.

## 2. Decisions

- **D1. Keep bank debits.** Stripe's bank debit fee is $3.20 on a $400 balance against about $11.90 on a card. Clients have been choosing it. The system learns to see it instead of removing it.
- **D2. Subscribe the live endpoint to `payment_intent.processing` and `payment_intent.payment_failed`.** The failed event is what releases an in-flight payment when a debit bounces days later. Subscribing also switches on the built-but-dormant card-decline notifications (admin email, and one client email plus text per proposal), which is the behavior that spec asked for.
- **D3. Any in-flight payment on a proposal blocks a new intent on that proposal**, not only one for the same invoice. A second payment on an event that already has money settling is far more likely a duplicate than a legitimate second bill. Refusing is the safe error; the message carries the contact address for the rare case where it is wrong.
- **D4. Reminders defer, never suppress**, while a payment is in flight. A bounced debit resumes the ladder.
- **D5. The client gets one email when the processing event lands.** Email only, no text. It answers "did it go through" before they come back to pay again.
- **D6. An in-flight payment expires after 14 days.** Backstop for a lost failed event: a processing row can never lock an invoice forever.
- **D8. The three checkout rails pin their payment methods to card, Link and bank debit** (review round 2026-09-14). Every processing statement the system makes says "bank payment"; pinning makes that true by construction. Cash App, Klarna, Affirm and Amazon Pay produced two successful charges between June and September against about a hundred by card and Link. One constant, `CHECKOUT_PAYMENT_METHOD_TYPES` in `stripeRouteHelpers.js`, reversible in one line; re-adding a method means teaching the processing copy to tell methods apart.
- **D9. A failed row is still a live intent.** A declined card leaves the intent alive at Stripe and the client can retry the same intent with a bank account. The processing handler moves `pending` and `failed` rows; the Stripe-side backstop and the autopay guard scan `failed` rows too. Found independently by the database review, the code review and the author on 2026-09-14.
- **D7. The Stripe read on the rails fails closed.** If Stripe cannot say whether a recent intent is settling, the rail returns the existing `ExternalServiceError` ("Payment temporarily unavailable", HTTP 502, the code that class has always carried) rather than mint. Same rule as the autopay guard and the option switch.

## 3. Data model

### 3.1 `stripe_sessions`

- `status` CHECK widens to `('pending', 'succeeded', 'failed', 'canceled', 'processing')`. Edit the existing DO-block definition in `schema.sql` (the one after `shift_requests_status_check`); never add a second definition.
- `processing_at TIMESTAMPTZ NULL`: stamped by the processing webhook. This is "started" everywhere the client or admin sees a date. `created_at` is when the intent was minted, which can be earlier than the confirm.
- `invoice_id INTEGER NULL REFERENCES invoices(id) ON DELETE SET NULL`: set at insert by the invoice rail, and by the processing webhook from `intent.metadata.invoice_id` after the same ownership check the succeeded handler runs (the invoice must belong to the proposal, else NULL).
- `server/db/index.js` `CONSTRAINT_CONTRACT` gains `{ table: 'stripe_sessions', constraint: 'stripe_sessions_status_check', mustContain: ['processing', 'canceled'] }`. A narrowed constraint would make the processing webhook raise 23514 on every delivery.
- No new index. The table holds hundreds of rows and the partial pending index is unaffected.
- ARCHITECTURE.md schema section is updated in the same change.

### 3.2 One definition of in flight

New module `server/utils/paymentInFlight.js`:

- `IN_FLIGHT_MAX_AGE_DAYS = 14`.
- `findInFlightPayments(proposalId, db = pool)` returns, newest first: `[{ stripe_payment_intent_id, amount_cents, started_at, invoice_id, invoice_number }]` for rows where `status = 'processing' AND processing_at > NOW() - INTERVAL '14 days'`, joining `invoices` for the number. `amount_cents` is `stripe_sessions.amount` (cents, Stripe native). `started_at` is `processing_at`.
- `toPublicPending(rows)` returns the newest row as `{ amount_cents, started_at, invoice_id, invoice_number }` or `null`. The intent id never reaches a public payload.
- `assertNoIntentSettlingAtStripe({ proposalId, stripe, db = pool })`: the webhook-independent backstop for the two rails. Selects `stripe_sessions` rows for the proposal with `status = 'pending'`, an intent id, and `created_at > NOW() - INTERVAL '14 days'`, newest first, LIMIT 5. Retrieves them from Stripe in parallel with the same per-request timeout the option switch uses. If any retrieved intent is `processing` or `succeeded`, throws `ConflictError(PAYMENT_IN_FLIGHT)` with the message in 5.1 built from that intent's amount and, for a processing intent, its `created` time. A `resource_missing` retrieve is skipped. Any other retrieve failure throws `ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.')`, HTTP 502 (D7).

- `assertNoPaymentInFlight({ proposalId, stripe, timeZone })` (review round): what the three rails call. One DB read of the proposal's recent rows; a processing row refuses at once; otherwise the newest five pending or failed intents are read from Stripe (ten-second timeout, one network retry) and refused when `processing`, `succeeded` (its own copy: "We have already received this payment and are recording it now. Refresh the page in a moment."), or `requires_action` with `next_action.type = verify_with_microdeposits` (its own copy, "waiting on a verification step"). Returns the intents it fetched so the deposit rail's reuse branch does not retrieve the same one again.
- `IN_FLIGHT_LATERAL_SQL` and `pendingFromLateralRow`: the polled payment-state route joins the in-flight lookup in one round trip; the definition still lives in this module.
- `findStaleProcessingPayments()`: rows processing for more than 8 days, reported hourly by `balanceInvoiceMonitor.js` as a Sentry warning (a lost failed event is the usual cause).
- Indexed: `idx_stripe_sessions_proposal_processing`, partial on `status = 'processing'`.

Every consumer below calls this module. Nothing else reads `status = 'processing'` directly.

## 4. Webhook

### 4.1 New handler `server/routes/stripeWebhookHandlers/paymentIntentProcessing.js`

Dispatched from `stripeWebhook.js` on `event.type === 'payment_intent.processing'`, after the existing test-mode gate. Only acts when `intent.metadata.proposal_id` is present.

In one transaction:

1. Resolve `invoiceId`: `Number(intent.metadata.invoice_id)` if it names an invoice whose `proposal_id` is this proposal, else NULL.
2. `UPDATE stripe_sessions SET status = 'processing', processing_at = NOW(), invoice_id = COALESCE($invoice, invoice_id) WHERE stripe_payment_intent_id = $1 AND proposal_id = $proposal AND status IN ('pending', 'failed') RETURNING id` (scoped by proposal like every sibling writer; `failed` per D9).
3. If nothing matched and no row exists for the intent at all, `INSERT` one with `status = 'processing'`, `processing_at = NOW()`, the proposal id, `intent.amount`, and the invoice id, `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`. A missing row means an intent minted outside the app that still carries our metadata; the guard must see it.
4. Only when a row actually transitioned (UPDATE rowCount 1, or the INSERT landed): insert `proposal_activity_log (action = 'payment_processing', actor_type = 'system', details = { amount, payment_intent_id, payment_type, invoice_id })`.

The `status = 'pending'` guard makes a redelivery a no-op and means a processing event that arrives after the succeeded event can never downgrade a settled payment.

Post-commit, best effort, only when a row transitioned: the client email in section 9, and an admin email (review round): the signing route suppresses its own admin email when an intent is pending on the premise that a Signed and Paid email follows the succeeded webhook, which for a bank debit is days away. `urgent_booking` for a deposit or full payment, `routine_finance` otherwise.

### 4.2 Existing handlers

- `paymentIntentSucceeded.js` already sets the row to `succeeded`. Unchanged. This releases the in-flight state.
- `paymentIntentFailed.js` already sets the row to `failed`, records the failed payment, alerts admins and notifies the client once per proposal. Unchanged. Subscribing the endpoint (D2) makes it live. For a bounced debit this is exactly right: the lock releases, you are told, the client is told to pay again.

### 4.3 Endpoint subscription and rollout

1. Deploy the code. The schema widening applies on boot like every other column here.
2. From this box, update the live endpoint's `enabled_events` to the existing four plus `payment_intent.processing` and `payment_intent.payment_failed`, then read it back and confirm. Unknown events are acked today, so the order is safe either way.
3. No backfill. Nothing is in flight at the time of writing and the abandoned pending rows stay as they are.

## 5. Guards

### 5.1 Both checkout rails

Three rails mint intents on a proposal, and all three carry both guards. The third, `create-drink-plan-intent` (`server/routes/stripe.js`), can fold a past-due balance into its charge (`drink_plan_with_balance`), so a balance already settling by bank debit would be charged again there; found by the server lane's reader audit and the client review on 2026-09-14. Its guards sit after the `noPaymentNeeded` early return, so a plan that owes nothing still submits while a deposit is processing.

Order on `create-intent-for-invoice` (`server/routes/stripe.js`): invoice fetch (404), archived guard (409), extension gate, balance check (`ALREADY_PAID` keeps its own answer), **the combined guard** (`assertNoPaymentInFlight`), customer, create, insert. Order on the deposit rail (`stripeCreateIntent.js`): after the proposal is loaded and before the existing newest-pending-intent reuse logic: **the combined guard**, whose fetched intents the reuse branch reads instead of retrieving again; the stale-cancel logic is unchanged.

- **In-flight guard:** `findInFlightPayments(proposalId)` non-empty throws `ConflictError(message, 'PAYMENT_IN_FLIGHT')`.
- **Stripe backstop:** `assertNoIntentSettlingAtStripe`.
- **Message** (no em dashes): `A $400.00 payment for this event has been processing since September 5. Bank payments take four to six business days to clear, and you will get a receipt by email when it does. If you think this is a mistake, email contact@drbartender.com.` Amount from the in-flight row in dollars with two decimals; date from `started_at` in the event's timezone, long month and day, no year.
- The invoice rail's insert into `stripe_sessions` now carries `invoice_id`.
- The deposit rail's "ACCEPTED HOLE" (a second identical metadata-less intent minted beside a `requires_payment_method` one) is unchanged. Only settling intents refuse.

### 5.2 Readers of `stripe_sessions.status` that widen

- `server/utils/autopayDurableCharge.js` `priorBalanceChargeSettling`: reads `findInFlightPayments` first and skips on any processing row whatever the intent's metadata (a Balance invoice paid by bank debit carries `payment_type: invoice`, which the metadata classification alone would scan past; review H1). The Stripe-side scan becomes `status IN ('pending', 'processing', 'failed')` and an `invoice` intent counts as balance-covering. Stripe still decides; a processing row that Stripe now reports terminal does not block. Without this, a settling bank debit that the webhook flipped to `processing` would drop out of the scan and autopay could charge the saved card on top of it.
- `server/routes/proposals/publicSwitch.js`, both scans (near lines 229 and 520): `status IN ('pending', 'failed', 'processing')`. A processing intent is in flight by definition. Its 409 copy now says a bank payment clears in four to six business days and the proposal stays as it is until then.

### 5.3 Readers that stay as they are

- `stripeCreateIntent.js` newest-pending reuse lookup: a processing row is no longer `pending`, and the guard above runs first.
- `server/utils/invoiceVoid.js` `cancelOpenInvoiceIntents`: a processing intent cannot be cancelled at Stripe. Voiding an invoice with a processing payment leaves the money to land through the succeeded handler's existing refusal and overflow alert. Out of scope here.
- `server/routes/proposals/publicToken.js` sign-only email suppression (pending within 30 minutes): unchanged.
- `server/routes/stripe.js` payment-link lookups: they key on `stripe_payment_link_id`, not intents.

The lane greps every `stripe_sessions` reader (`grep -rn "stripe_sessions" server --include=*.js`) and records each one as widened or unchanged in its final report.

## 6. Reminders

- New `DeferMessageError(reason)` in `server/utils/errors.js`, a plain Error subclass next to `SuppressMessageError`, same shape.
- `scheduledMessageDispatcher.js`: a branch beside the `SuppressMessageError` branch. `DeferMessageError` writes `status = 'deferred', scheduled_for = NOW() + INTERVAL '24 hours', error_message = 'deferred: ' || reason`. It is `NOW()`, not `scheduled_for + 24h`: an overdue row deferred from its own past timestamp would come due again on the next tick and loop. The existing deferred-reactivation pass flips it back to `pending` when due. A 14-day in-flight payment (D6) means at most 14 deferrals.
- `balanceReminderHandlers.js` (`sendBalanceReminder`, `sendBalanceLate`) and `balanceSmsHandlers.js` (`loadBalanceSmsContext`): after the existing balance-positive check, `findInFlightPayments(proposalId)` non-empty throws `DeferMessageError('payment_in_flight')`. That covers `balance_reminder_autopay_t3`, `balance_reminder_non_autopay_t3`, `balance_due_today`, `balance_late_t1`, `balance_late_t3` and their SMS halves. No other message type changes.

## 7. Payload contracts

The public shape, identical on every public route:

```
pending_payment: null | {
  amount_cents: 40000,
  started_at: "2026-09-05T16:05:35.000Z",
  invoice_id: 363 | null,
  invoice_number: "INV-0363" | null
}
```

- `GET /api/invoices/t/:token`: adds `pending_payment` (newest in-flight payment on the invoice's proposal) and `pending_payment_for_this_invoice: boolean` (its `invoice_id` equals this invoice).
- `GET /api/proposals/t/:token`: adds `pending_payment`.
- `GET /api/proposals/t/:token/payment-state`: adds `pending_payment`. Still non-mutating.
- `GET /api/invoices/proposal/:id` (admin): adds `pending_payments`, the full array from the helper minus the intent id.

## 8. Client

### 8.1 Shared card `client/src/components/PendingPaymentCard.js`

Props `{ amountCents, startedAt }`. Renders:

- Title: `Your bank payment is processing.`
- Body: `We received your $400.00 bank payment on September 5. Bank payments take four to six business days to clear. You will get a receipt by email when it does, and nothing more is needed from you.`

Amount in dollars with two decimals, date via the instant formatter the invoice page already uses. `role="status"`. No em dashes.

### 8.2 `InvoicePage.js`

- `PaymentForm.handleSubmit` reads `const { error, paymentIntent } = await stripe.confirmPayment(...)`. If `paymentIntent && paymentIntent.status === 'processing'`, it calls `onPending({ amount_cents: paymentIntent.amount, started_at: new Date().toISOString() })`; otherwise the existing `onSuccess`.
- Page state `pendingPayment`, seeded from `invoice.pending_payment` on load and set by `onPending`. When set: render `PendingPaymentCard` in the actions rail, no PAID stamp, no "Payment successful", no success toast, no Pay button, no payment element. `isPaid` is unchanged. The refetch after `onPending` runs as it does after success; if the row does not carry `pending_payment` yet (webhook lag) the local value stays.
- A 409 from the rail already lands in `FormBanner` through `err.message`. On `PAYMENT_IN_FLIGHT` the page also refetches the invoice so the card appears.
- When `pending_payment` exists but `pending_payment_for_this_invoice` is false, the card renders the same and the Pay button is still hidden (D3).

### 8.3 Proposal page

- `PaidCard.js` gains a `pendingPayment` prop and a fourth `phase`, `'pending'`. Phase `'pending'` renders `PendingPaymentCard` alone (unpaid row, deposit or full payment settling). Phase `'paid'` with `pendingPayment` set renders the paid title as today, then `PendingPaymentCard` in place of the "remaining balance ... due by" line, and no Pay balance link.
- `settlePoll.js`: a state carrying `pending_payment` is terminal: `{ state, reason: 'pending' }`.
- `useSettle.js`: reason `'pending'` refetches the proposal and lands phase `'pending'` regardless of `isPaidState`. The refetch failing lands `'fallback'` as today.
- `ProposalView.js`: `const pendingPayment = proposal.pending_payment || settlePending || null` where `settlePending` is the poll's value when the refetch did not carry one. `isPayableStatus`, `showSignAndPay` and `showPayOnly` all require `!pendingPayment`. `PaidCard` renders when `settling || isPaid || pendingPayment`, with phase `'pending'` when `pendingPayment && !isPaid`. The file is 912 lines; this lane nets under +15 to it and puts everything it can in the modules above.
- `PaymentTermsBox` and the pricing breakdown treat a pending state like settling: no numeric claim. Decided in review 2026-09-14: settling was built for a twenty-second window and a bank debit holds it for days, so both surfaces also receive the pending flag and say so. The Total cell prints `Pending` (not a bare dash), the terms box prints "Your bank payment is processing. Your payment terms will update when it clears.", and on a deposit-paid row with a balance settling the due-by row becomes "Balance payment: Processing". The autopay branch of the paid card gives way to the processing copy too: autopay will not charge while money is in flight, so "will be automatically charged" would be false for the window.
- A fully paid row with a pending payment (only reachable from a duplicate minted before this design, or an intent minted outside the app) keeps its "Fully paid" card and shows no processing copy. Accepted corner, not built.
- `InvoicePage` treats only a `succeeded` confirm result as success. `processing` lands the pending card; `requires_action` (a bank account that needs microdeposit verification) or any other status shows "This bank payment still needs a verification step. Check your email from Stripe for what to do next, then come back to this page." and never claims payment. While a payment is pending the page fetches no publishable key and loads no Stripe.js. After a 409 `PAYMENT_IN_FLIGHT` the Pay button stays hidden until reload even when the row carries no processing payment yet.
- The shared card carries a closing line, "If anything looks wrong, email contact@drbartender.com.", and formats `started_at` in the viewer's local time like every other instant on the client.

### 8.4 Drink-plan celebration screens (added in review 2026-09-14)

The drink-plan checkout (`ConfirmationStep.js`) confirms in full-redirect mode and returns to the planner with `?paid=true`; both celebration screens (`CelebrationV2.js`, `PotionPlanningLab.js`) rendered "Payment Received, processed successfully" on that flag alone. A bank debit returns with `redirect_status=processing`, so they claimed success for money that had not moved. One shared `client/src/pages/plan/components/PaymentReturnNotice.js` reads `paid` and `redirect_status` (`readPaymentReturn`) and renders the processing copy (no amount is known on this rail) or the received box. The server side of this rail is covered by 5.1.

## 9. Client email on processing

- Template `bankPaymentProcessingClient({ clientName, amountCents, eventTypeLabel, eventDate, proposalUrl })` in `server/utils/lifecycleEmailTemplates.js` (not `emailTemplates.js`, which is at 904 lines). Subject `We received your bank payment`. Body: the amount, the event label and date, the four-to-six-business-day line, that a receipt follows when it clears, and that nothing more is needed. Link to the proposal. No em dashes.
- Sent from the processing handler's post-commit tail through `sendEmail`, gated the same way the payment receipt is in `stripePaymentNotifications.js` (`shouldSendImmediate` with the client's `email_status` and preferences). Best effort: it never throws into the handler. A client with a bad address gets nothing, as today.
- Deposit and balance payments alike. `payment_type` from metadata picks one word in one sentence: `deposit` reads "your $100.00 deposit", everything else ("full", "invoice", "balance", the drink-plan types, or absent) reads "your $400.00 payment".

## 10. Admin

- Activity timeline: the `payment_processing` entry from 4.1.
- `ProposalDetailPaymentPanel.js` reads `pending_payments` from the invoices-by-proposal response and renders one line per entry above the invoice list: `Processing: $400.00 bank payment, started Sep 5, INV-0363`. Omit the invoice number when null. Nothing else in the panel changes.

## 11. Tests

Server (node:test, one file at a time from the repo root, every file starts with `require('dotenv').config()`, read the pass count):

- `server/utils/paymentInFlight.test.js`: processing within 14 days returned; older not; pending not; newest first; `toPublicPending` strips the intent id; `assertNoIntentSettlingAtStripe` with a fake Stripe: processing throws 409, succeeded throws 409, `requires_payment_method` passes, `resource_missing` skipped, a 500 throws the 503, at most 5 retrieves.
- `server/routes/stripeWebhook.processing.test.js` (signed events, same harness as `stripeWebhook.guards.test.js`): pending to processing with `processing_at` and an owned `invoice_id`; a foreign `invoice_id` stores NULL; redelivery is a no-op with one activity row; an event after `succeeded` does not downgrade; a missing row is inserted; a `livemode: false` event outside a test window is dropped.
- `stripeCreateIntent.test.js` and `stripe.invoiceIntentArchived.test.js` (or a sibling): 409 `PAYMENT_IN_FLIGHT` on a processing row; 409 when Stripe reports the newest pending intent processing; 409 on succeeded; 503 on a retrieve 500; the invoice rail's insert carries `invoice_id`; a proposal with no in-flight payment still mints.
- `autopayDurableCharge` suite: a processing row is scanned and blocks when Stripe says processing.
- `publicSwitch` suite: a processing row blocks the switch.
- Reminder suites: each of the five email handlers and three SMS handlers throws `DeferMessageError` when a payment is in flight; the dispatcher writes `deferred` with `scheduled_for` about 24 hours from now.
- `invoices` public and admin suites: `pending_payment`, `pending_payment_for_this_invoice`, `pending_payments`.
- `publicToken` suites: proposal GET and payment-state carry `pending_payment`.
- The `CONSTRAINT_CONTRACT` suite, if present, sees the new entry.

Client (jest from `client/`, `CI=true npx react-scripts test --testPathPattern=<pattern> --watchAll=false`, assert on `textContent`):

- `PendingPaymentCard.test.js`: copy, amount and date.
- `InvoicePage.test.js`: a confirm resolving with `status: 'processing'` renders the card and no PAID stamp; a loaded invoice with `pending_payment` hides Pay; a 409 shows its message.
- `PaidCard.test.js`: phase `'pending'`; paid plus `pendingPayment` hides Pay balance.
- `settlePoll.test.js` and `useSettle.test.js`: the pending terminal and phase.
- `ProposalView` gating: `checkoutVisibility.test.js` pins the pure rules and is the accepted substitute for a rendered-page test (decided in review 2026-09-14; the page has no render harness and the wiring is three lines that a code reviewer verified by reading).
- `PaymentReturnNotice.test.js` and `CelebrationV2.test.js`: a processing return says processing, a card return says received.

Existing suites the change reaches are run: every `stripeWebhook.*.test.js`, `stripeCreateIntent.test.js`, `stripe.*.test.js`, `autopayDurableCharge*.test.js`, `publicSwitch*.test.js`, `balanceReminder*` and `balanceSms*` and `scheduledMessageDispatcher*` tests, `invoices*.test.js`, `publicToken*.test.js`, the client proposal-view and invoice-page suites.

## 12. Verification that cannot be a test

A real bank debit cannot be rehearsed: dev talks to live Stripe and a debit is real money. Before merge, the server lane proves the webhook path with locally signed synthetic events against the dev server, and the client lane proves the cards against a dev-DB row set to `processing` by hand. `docs/walkthroughs-owed.md` gets one entry: on the first real bank debit after deploy, confirm the processing row, the activity entry, the client card, and that the reminder row went `deferred`.

## 13. Lanes, review, rollout, docs

- **Lane `ach-server`:** sections 3, 4, 5, 6, 7, 9, 10 (server half), 11 server tests, docs. Footprint `server/**`, `docs/**`, `README.md`, `ARCHITECTURE.md`.
- **Lane `ach-client`:** sections 8 and 10 (panel), 11 client tests. Footprint `client/src/**`. Builds against the section 7 shape as a fixture. No dependency on the server lane; merge order does not matter, but both must be on main before the push.
- **Review:** full pre-prod fleet on each lane before merge (`server/routes/stripe.js`, `stripeWebhook.js`, `scheduledMessageDispatcher.js` and `publicToken.js` are sensitive paths), consistency-check on the seam, `/second-opinion` at push.
- **Rollout:** section 4.3, after the push cue.
- **Docs:** ARCHITECTURE.md schema section for `stripe_sessions`; README folder tree for the new util, handler, component and test files; `docs/fix-list-remaining-2026-07-02.md` closes the two 2026-08-28 entries named in section 1; `docs/walkthroughs-owed.md` per section 12.

## 14. Out of scope

- Subscribing `charge.refunded` and `charge.dispute.*`. Handlers exist and have never fired; that is a separate decision with its own blast radius (dashboard refunds would start reconciling).
- The refund-panel defect where refunding a true overpayment lowers `total_price`. Tracked on the fix list; it is why proposal 784 was refunded from the Stripe dashboard.
- Cleaning up the 389 abandoned `pending` rows.
- Voiding an invoice that has a processing payment (5.3).
- Restricting payment method types at intent creation.

## Visual contract

None. No surface here went through claude.ai/design; the cards use the existing paid-card and invoice-rail styles.
