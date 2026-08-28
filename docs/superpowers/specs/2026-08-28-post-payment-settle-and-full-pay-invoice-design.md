# Post-Payment Settle State and the Deposit-to-Full Invoice Upgrade

**Date:** 2026-08-28
**Status:** Approved (conversational, section-by-section). Revised 2026-08-28 after the design-stage fleet (six Claude reviewers) and the code-stage fleet on the shipped fix; every confirmed finding is folded in below and marked "(rev)".
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

(rev) A third hazard on the same page: every call it makes (`GET /t/:token/resolve`, `GET /t/:token`, `POST /stripe/create-intent/:token`) draws on `publicLimiter`, 20 requests per 15 minutes keyed by IP (`server/middleware/rateLimiters.js`). A page load spends three; every payment-option, autopay or gratuity change spends one; a failed sign's recovery spends two. Mike's six attempts on the 28th spent roughly eighteen. The repo has already moved four other public surfaces off this bucket for the same reason and documents the rule at `optionsQuoteLimiter`: browsing must never be able to spend the budget that paying depends on.

### 1b. A full payment on a deposit-terms proposal strands the remainder off the invoice ledger

`createInvoiceOnSend` mints the first invoice at send time from `proposals.payment_type`, whose column default is `deposit`. So a normal send gets a `Deposit` invoice at `deposit_amount`. When the client picks pay-in-full at checkout, `stripeCreateIntent.js` flips `payment_type` to `full` but nothing reshapes the invoice. The webhook credits the proposal correctly, then its label-blind fallback links the whole capture onto the only open invoice, and `linkPaymentToInvoice` caps the credit at remaining due and drops the rest into a Sentry warning (`invoice_link_overflow_capped`, DRBARTENDER-SERVER-1E, five events in 28 days, none acted on). `createBalanceInvoice` never mints a row for the remainder because it is gated on `paymentType === 'deposit'`.

Result for Mike: one invoice, INV-0336 `Deposit`, $100 due, $100 paid, locked. `invoice_payments` row 87 records $100 of a $550 payment. The portal's Receipts tab shows "INV-0336 · Deposit · $100.00 · paid" and nothing else.

(rev) **Blast radius, by shape, verified read-only on prod 2026-08-28:** 25 proposals whose only contract invoice is a paid, locked Deposit linked to a succeeded payment larger than it: 442, 450, 451, 452, 472, 479, 484, 494, 502, 556, 573, 579, 623, 625, 633, 635, 659, 660, 666, 674, 675, 713, 767, 770, 774. One of them, 633 (Dora Travaglio), carries a refund and is held for a manual look. The other 24 total roughly $9,350 of collected money with no invoice behind it. The backlog entry's "13 since 2026-07-02, about $4,605" was date-floored; the shape is not. All 24 are `completed` except 767 and 774.

This is the backlog entry "Paying in full on a deposit-terms proposal strands the remainder off the invoice ledger" (found 2026-08-25 on Meg Henke, proposal 770). It names the fix direction this spec takes.

The cap is correct and stays. It is the seam-sweep M1/M2/L2 guard against a stale intent overfilling an invoice. The fix is upstream of it.

(rev) **Three entrances, not two.** The label-blind link runs in `paymentIntentSucceeded.js` (the proposal page), in `checkoutSessionCompleted.js` (admin-issued Stripe payment links, which carry `payment_type: 'full'` inside the 14-day window), and in `actions.js` record-payment (admin-recorded outside payments). All three must call the upgrade or the shape comes back through whichever door was left open.

### The rule both fixes apply

From the 2026-07-28 invoice-derivation post-mortem: **the proposal wins**. An invoice is a derived view of its proposal, and a client-facing surface renders the proposal's settled state or nothing. The same law was applied this morning on the signature side (`e8101a9d`, `acknowledged_total` carries row truth). This spec applies it at two more seams.

## 2. Decisions

1. `?paid=true` means "a checkout redirect happened, go find out what the record says." It never by itself means paid. No dollar figure renders from a row the page has not confirmed is settled, and no sentence asserts a fact about the payment that only the row can prove.
2. A client who arrives at full payment from deposit terms gets **one receipt**: the open Deposit invoice is re-derived into the Full Payment invoice before the payment is credited. Not a Deposit plus a Balance. All three entrances.
3. (rev) **All 24** bookings in the shape are backfilled, including the completed ones; 633 is skipped by the script's own refund rule and looked at by hand. What is frozen in those locked rows is a recording error, not a true receipt; `proposal_payments` holds the truth.
4. The overflow warning reaches Dallas by email, not only Sentry, from after the transaction commits.
5. Two worktree lanes: `pay-settle-page` (client plus the read endpoint, the limiter change and the sign-route telemetry) and `full-pay-invoice` (webhook, checkout-session, admin path, helper, backfill, alert). **Lane 1 ships first, and not only for review reasons:** lane 2 adds work to the webhook transaction that §1a names as the race, so the page must already be tolerant of a longer window before the window gets longer.
6. (rev) The proposal checkout leaves `publicLimiter`. Its three calls and the new poll target get token-keyed limiters.

## 3. Lane 1: the page after payment

### 3a. Redirect handling (`client/src/pages/proposal/proposalView/ProposalView.js`)

Read two URL params on mount: `paid` and `redirect_status`. Define, in one pure helper `readRedirect(search)`:

- `redirected` = `paid === 'true'`
- `failed` = `redirected && redirect_status === 'failed'`

(rev) Stripe's `redirect_status` can also be `pending` or `processing` (the create-intent pins no payment method types, so bank debits and wallets are live). Only `failed` is a failure. Anything else on a redirect is treated as a settle: poll, and if the row never settles, the fallback, which asserts nothing.

`paid` keeps its name inside `ProposalView` because `isPayableStatus` and the intent effect key on it, and now means `redirected && !failed`. On a failed redirect `paid` is false, so intents mint and Stripe.js loads, and the sign-and-pay form is usable; a plain note renders above it: "That payment did not go through. Nothing was charged. You can try again below." That sentence is only ever shown for `redirect_status=failed`, which is the one value Stripe uses to mean exactly that.

`isPaid` becomes `PAID_STATES.includes(proposal.status)` only. The `|| paid` half is removed. The paid card can render only from row state.

(rev) Three flags read the old URL half and all three are named here: `showSignAndPay` and `showPayOnly` both gain `&& !settling`, and the mobile "Complete Your Payment" CTA in the breakdown (which keys on those two) therefore hides too. Without this, a signed-but-unsettled row (`accepted`, which is exactly Mike's) would render the pay-only section beside the settling card, with no client secret, showing "Unable to load payment form."

`PAID_STATES` is `['deposit_paid', 'balance_paid', 'confirmed', 'completed']`, the same set the existing `inPaidState` uses for `balanceAmount`. A `completed` booking is paid; its card says "Fully paid." with a past-tense line and no "closer to the date."

### 3b. Settling state

On a `redirected && !failed` load the page fetches the proposal exactly as today (one full GET, one view bump, one `viewed` row). Then:

- If the row is in a paid state, render the paid card from the row. Done.
- Otherwise enter `settling`. Render, in the slot the paid card occupies: a card titled "Confirming your payment" with a quiet spinner and the line "This usually takes a few seconds." The sign-and-pay and pay-only sections stay hidden. The Payment Terms box renders no deposit, balance or due-date rows while settling.

Poll `GET /api/proposals/t/:token/payment-state` every 1.5 seconds, up to 13 attempts (about 20 seconds). On the first response whose status is a paid state, stop polling, refetch the full proposal once (this is a second view bump; accepted), and render from it.

(rev) Poll error handling: a 5xx or a network error is a transient miss and counts against the 13; any 4xx (404 for a swept proposal, 429, 410) stops the poll immediately and goes to the fallback. No backoff; the interval is fixed.

(rev) The settling logic lives in one hook, `useSettle`, latched by a ref so it runs once per proposal load and its cancellation fires only on unmount. The first draft of this design put the phase in the effect's own dependency list, which cancels the poll it just started and pins the page on the spinner forever; three reviewers found it, and the hook exists so a test can pin it.

(rev) Fallback, after all attempts or on a 4xx: "We are still confirming your payment. You will get a confirmation email as soon as it clears. If nothing arrives within the hour, reply to any of our emails and we will sort it out." A Refresh button reloads the page without the redirect params. No dollar figures. No Pay balance button. The old draft said "your payment went through" and "your email is on its way"; both are claims the page cannot make from the URL, and the second is false in the one case that produces the fallback (a webhook that rolled back).

(rev) Observability: reaching the fallback calls `Sentry.captureMessage('proposal_settle_fallback', { level: 'warning', tags: { proposal_id, reason } })` from the client (`@sentry/react` is already wired on the public pages). A client who sat through twenty seconds of nothing is the single event Dallas most needs to hear about.

### 3c. The read endpoint and the limiters (`server/routes/proposals/publicToken.js`, `server/middleware/rateLimiters.js`)

`GET /t/:token/payment-state`, public, `requireUuidToken`, non-mutating. Returns:

```json
{ "status": "balance_paid", "amount_paid": 550, "total_price": 550, "payment_type": "full" }
```

Dollars, as the proposal row holds them. 404 on an unknown token and on an archived one (rev: the archived 404 is stated here on its own; `/t/:token/resolve` is deliberately status-blind and is not the precedent). It must not touch `view_count`, `last_viewed_at`, `status`, or `proposal_activity_log`. The existing full GET cannot be the poller because it does all four on every call.

(rev) Two new token-keyed limiters, the `drinkPlanWriteLimiter` pattern (`keyGenerator: req.params.token || req.ip`, 15-minute window):

- `proposalPollLimiter`, max 40, on `payment-state` only. A settle spends 13.
- `proposalCheckoutLimiter`, max 60, replacing `publicLimiter` on `GET /t/:token`, `GET /t/:token/resolve`, and `POST /api/stripe/create-intent/:token`. A real checkout with a few toggles and one failed sign spends under 20; sixty leaves room for a reload and a shared IP.

`publicLimiter` itself is unchanged for everything else it guards.

### 3d. Row-truth rendering once settled

The paid card and the Payment Terms box both derive from the row through one pure helper, `paidState(proposal, renderedTotal)` in a new `client/src/pages/proposal/proposalView/paidState.js`, returning one of:

- `full`: `status === 'balance_paid'`, or `amount_paid >= total_price - 0.01`, or `status === 'completed'`. Card: "Fully paid." Terms box: "Paid in full" with the amount paid.
- `deposit`: paid state and not full. Card: "Deposit received." with remaining balance and due date. Terms box: "Deposit paid" amount, "Remaining balance", "Balance due by" date. Autopay line as today when `autopay_enrolled`.
- `none`: not a paid state. The existing pre-payment Terms box.

(rev) Two sources, deliberately: the paid/full test reads the row's `total_price` (what `isFullyPaid` reads today); the remaining figure reads `renderedTotal`, the snapshot total the page already renders (what `balanceAmount` reads today). Mirroring the current split keeps the card and the breakdown above it printing the same remainder on an override'd proposal. There is no "Paid on" line: `accepted_at` is not in the public payload and is the acceptance stamp, not the payment date.

(rev) When the row is `full`, that branch wins over the `fullPaymentRequired` pre-payment branch of the Terms box. "Deposit Due at Signing" never renders on a paid booking.

### 3e. The shipped fix's own follow-ups (rev, from the code-stage fleet on `e8101a9d`)

Same file, same lane:

- `adoptSwitch` and `handleUndo` clear `formError`. The clear used to live in the intent effect; the split moved it to `intentError`, so a stale sign error now survives a landed switch.
- The comment above `acknowledged_total` in `handleSign` says the field carries "the total we actually rendered." It carries the ROW total; the rendered total may exceed it by the in-memory gratuity election. The comment is rewritten.
- `setIntentError('')` moves above the `gratuityBelowFloor` early return in the intent effect, so a stale "Unable to load payment form" does not survive into the below-floor state.
- The banner shows both messages when both exist (`[formError, intentError].filter(Boolean).join(' ')`), and the "Unable to load payment form" fallback paragraph gates on `!intentError` alone, so a failed sign followed by a failed load is not a dead end.
- `applyIntentQuote` keeps the prior gratuity block when the quote's `gratuity` is null (the block carries `staff_count`, `hours`, `floor_rate`, which drive the sign-blocking floor gate). Unreachable today; pinned anyway.
- The sign route (`publicToken.js`): on a `TOTAL_CHANGED` or `ALREADY_ACCEPTED` 409 it writes a `sign_failed` activity row `{ code, acknowledged_total }` and, when `SENTRY_DSN_SERVER` is set, `Sentry.captureMessage('proposal_sign_failed', { level: 'warning', tags: { route, code, proposal_id } })`. Today a total payment block produces zero telemetry and each retry is logged as a *view*. On success the `signed` row's details gain `acknowledged_total`, so the audit trail ties the signature to a dollar figure.

### 3f. Out of scope for this lane

(rev) `InvoicePage.js` renders its post-payment state from in-page React state (`paymentSuccess`), not the URL, and shows the invoice's own fixed amounts, so it is correct by construction. The drink-plan `ConfirmationStep.js` uses `?paid=true` but renders no money from the row after its redirect. Neither changes.

## 4. Lane 2: the deposit-to-full invoice upgrade

### 4a. The helper (`server/utils/invoiceLifecycle.js`)

```
upgradeDepositInvoiceToFull(proposalId, dbClient) -> invoice row | null
```

Finds the proposal's invoice with `label = 'Deposit'`, `status = 'sent'`, `locked = false`, `amount_paid = 0`, not void, `ORDER BY id ASC LIMIT 1 FOR UPDATE` (rev: the row lock, because two concurrent full-pay intents or an admin record landing beside a webhook reach it with no proposal-row lock held). If none, returns null and writes nothing. Otherwise, in the caller's transaction:

1. Reads `total_price`, `external_paid` and `balance_due_date` from the proposal.
2. Updates the invoice: `label = 'Full Payment'`, `amount_due = toCents(total_price) - toCents(external_paid)` floored at 0, `due_date = balance_due_date` (rev: the same shape `createInvoiceOnSend` gives a natively minted Full Payment invoice, so upgraded and native rows are identical). The invoice number is unchanged.
3. Regenerates line items via `generateLineItemsFromProposal` and `writeLineItems`.
4. Inserts `proposal_activity_log` action `invoice_upgraded_to_full`, actor `system`, details `{ invoice_id, invoice_number, from_amount_due, to_amount_due }`.

Returns the updated invoice row. A Deposit invoice that has been partially paid, locked, or already relabelled is never touched.

(rev) Consequence, by design: a `Full Payment` label is in `TOTAL_TRACKING_INVOICE_LABELS`, so if the credit underfills (the total moved between intent and webhook), the row is left unlocked, partially paid and refresh-managed, exactly as a natively minted Full Payment invoice would be. That is consistency, not a defect.

### 4b. Webhook call site (`server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`)

In the label-blind fallback branch, when `paymentType === 'full' && !groupChoice.conflict && !archivedSettle` (rev: the same guard its sibling `createBalanceInvoice` carries, so a stale full intent settling on a cancelled proposal or a non-chosen option never relabels and reprices its invoice), call `upgradeDepositInvoiceToFull(proposalId, dbClient)` before the open-invoice lookup. The lookup then finds the re-derived Full Payment invoice, `linkPaymentToInvoice` credits the whole capture with no overflow, and the existing lock-on-paid fires.

The gratuity election is applied to `total_price` near the top of the same transaction, before this point, so the helper reads the final total. The `createBalanceInvoice` gate is unchanged. Nothing about `linkPaymentToInvoice`'s cap or status guard changes.

(rev) The link's return value (`overflowCents`) is captured into a variable inside the transaction and read in the post-commit tail (§4e).

### 4c. (rev) Payment-link call site (`server/routes/stripeWebhookHandlers/checkoutSessionCompleted.js`)

Same call, same guard, in the same position: when `linkPaymentType === 'full' && !groupChoice.conflict && !archivedSettle`, before its invoice lookup. Same post-commit overflow capture.

### 4d. Admin record-payment call site (`server/routes/proposals/actions.js`)

(rev) Gated on the route's own derived `isFullyPaid` (computed from the locked row), not on the request's `paid_in_full` flag, so an admin who types the full remaining amount without ticking the box takes the same path. Inside that transaction, after the proposal's `amount_paid` update and before its invoice link:

- `UPDATE proposals SET payment_type = 'full'` when `isFullyPaid` (rev: today only the grouped-winner branch stamps it, so the row would say `deposit` beside a `Full Payment` invoice and an archived-to-draft-to-sent recovery would mint a fresh Deposit).
- `upgradeDepositInvoiceToFull(proposal.id, dbClient)`.
- (rev) The admin path's open-invoice lookup gains the webhook's `AND NOT (label = ANY(OFF_LEDGER_INVOICE_LABELS))` exclusion, so an open Service Extension invoice can never absorb a contract credit on this path either. Parity, one line.

Same helper, so the three entrances cannot drift.

### 4e. The overflow alert (`server/utils/invoiceLinking.js` and the three callers)

(rev) `warnLinkAnomaly` keeps its console and Sentry behaviour and gains nothing. A new `notifyLinkOverflow({ proposalId, invoiceId, paymentId, amountCents, creditCents, overflowCents })` in `invoiceLinking.js` (lazy-requiring `adminNotifications`) sends one email via `notifyAdminCategory` on category `payment_failure`, subject "Invoice link overflow on proposal #N", body naming the invoice, the payment, the credited and dropped dollars. Email only, own catch.

It is called **after commit** by each of the three callers, from the same post-commit tail where `sendPaymentNotifications` and `notifyPaymentOnArchived` already run, using the `overflowCents` the link returned in the transaction. `notifyAdminCategory` runs `pool.query`; calling it inside the open transaction would take a second pooled connection while holding the first, which is the one-pooled-connection deadlock this codebase has hit twice (SERVER-17; 2026-07-13). `linkPaymentToInvoice`'s return value gains `proposalId` and `invoiceId` so callers need no extra query.

After §4b through §4d ship, an overflow on the contract path should be impossible, so this email means something new.

## 5. Lane 2: the backfill

### 5a. Script

(rev) `server/scripts/backfillFullPaymentInvoices.js`, the location of every prior invoice backfill (`backfillExtrasInvoices.js`, `backfillProposal54DepositInvoice.js`). Dry run by default; `--apply` writes.

(rev) Mechanical gate: `--expect <comma-separated proposal ids>` is required with `--apply`; the script refuses to write unless the set it selected (after exclusions) equals the expected set exactly. The expected set for this run is the 24 in §1b. A different selection is a stop, enforced by the script rather than by a human reading a count off a screen.

Before doing anything it prints the database host it is about to touch and the mode. (rev) The run instructions in the plan point `DATABASE_URL` at prod explicitly; the box's `.env` is the dev database, which is shared with the test suites and proves nothing about prod.

### 5b. Selection

Proposals where all of the following hold:

- `amount_paid >= total_price` and `total_price > 0` (dollars, the proposal side)
- exactly one non-void invoice whose label is in `['Deposit', 'Balance', 'Full Payment']`, and that invoice is `label = 'Deposit'`, `status = 'paid'`, `locked = true`
- (rev) exactly one `invoice_payments` row with `refund_id IS NULL` links that invoice to a `proposal_payments` row with `status = 'succeeded'` whose `amount` (cents) exceeds the invoice's `amount_due` (cents)

Exclusions applied after selection, each printed as a skip with its reason:

- `external_paid > 0` (the CC-transfer cohort, documented separately)
- proposal 600 (legal hold)
- any `proposal_refunds` row on the proposal (633 today; needs eyes, not a script)

### 5c. Per-proposal write (own transaction each)

1. `invoices`: `label = 'Full Payment'`, `amount_due = payment.amount`, `amount_paid = payment.amount`. `status` and `locked` untouched.
2. `invoice_payments`: `amount = payment.amount` on the linking row. This preserves the invariant `Σ invoice_payments.amount = invoices.amount_paid` that `invoiceLinking.js` is built around.
3. Line items regenerate only when `toCents(total_price) === payment.amount`. Otherwise left alone and reported.
4. (rev) `proposal_activity_log` action `invoice_backfilled_to_full`, actor `system`, details carrying the FULL before-state so the write can be reversed by hand: `{ invoice_id, invoice_number, from_label, from_amount_due, from_amount_paid, from_link_amount, from_line_items: [...rows], to_amount_due, lines_regenerated }`.

Idempotent: a re-run selects nothing, because the invoice is no longer labelled Deposit. A failure on one proposal rolls back only that proposal.

(rev) Verified neutral for the consumers that read these columns: payroll fee-netting (`payrollAccrual.js` credits `pp.amount - linked_cents` on the unlinked rail, so the two terms swap one for one), the balance-invoice monitor (`amount_due = amount_paid` before and after), and refund reconciliation (the clamp at `net_applied` today can only reverse $100 onto these invoices; afterwards the whole payment is reachable).

### 5d. Run order

(rev) Its own runbook task, after lane 2 is live on main, not a step inside the lane's docs task. Point at prod, dry run with `--expect`, Dallas reads the 24 lines, `--apply`, verify 774 reads Full Payment 55000/55000, THEN delete the backlog entry and resolve the Sentry issue. The backlog entry stays until the rows are actually corrected.

## 6. Tests

Written before the code they cover.

Lane 1:
- `paidState.test.js`: Mike's pre-commit row returns `none`; `balance_paid` and `completed` return `full`; `deposit_paid` returns `deposit` with the remainder from `renderedTotal`; `readRedirect` on `paid=true`, `redirect_status=succeeded`, `=failed`, `=pending`, and no params.
- `settlePoll.test.js`: settles on the first paid response; exhausts after 13 with 12 sleeps; a 5xx is a miss; a 4xx stops immediately with reason `blocked`; cancellation stops early.
- (rev) `useSettle.test.js` via `renderHook`: a row already paid goes straight to `paid`; a row that settles on the third poll reaches `paid` and refetches once; an exhausted poll reaches `fallback`; and the hook survives its own state changes (the cancel-on-first-render defect, pinned).
- `PaidCard.test.js`: settling and fallback render no `$` and no Pay balance; `completed` renders the past-tense line.
- `PaymentTermsBox.test.js`: settling renders no money rows; a `full` row never renders "Deposit Due at Signing", including when `fullPaymentRequired` is true.
- `intentQuote.test.js` gains the null-gratuity basis case.
- Server: `payment-state` returns the four fields, 404s on archived and unknown, and leaves `view_count`, `status` and `proposal_activity_log` untouched across five calls; 21 calls on one token from one IP all return 200 (the token-keyed limiter); the sign route writes `sign_failed` on a 409 and `acknowledged_total` into the `signed` row.

Lane 2:
- Helper guard cases (no invoice, locked, partially paid, Balance, Full Payment, void) each return null and write no row and no breadcrumb; happy path pins label, amount, due_date, lines, breadcrumb.
- Webhook: a deposit-terms proposal receives a `full` intent; afterwards exactly one contract invoice, Full Payment, `amount_due = amount_paid = intent.amount`, paid, locked; `invoice_payments.amount = intent.amount`; no overflow; the notify stub is not called. A `deposit` intent on the same fixture still yields Deposit paid plus Balance. A `full` intent on an archived proposal does not upgrade.
- (rev) Checkout session: a full payment-link event on the same shape, through the signed webhook route, ends in the same one-invoice shape.
- Admin record-payment with `paid_in_full`, and with a typed amount that clears the balance, both end in the one-invoice shape with `payment_type = 'full'` stamped.
- `notifyLinkOverflow` sends one `payment_failure` email with the dollar figures and is never called from inside a transaction; a partial admin record that overfills its open invoice (the one shape that can still overflow after the upgrade) asserts it is called once, after the response. The existing record-payment cap test is left alone: its fixture caps the applied amount at exactly the invoice's remaining due, so it cannot overflow.
- The payment-link handler's open-invoice lookup gains the same off-ledger exclusion the other two have (rev), so all three lookups match, not only the three upgrade calls.
- Backfill: dry run on a fixture returns the candidate, skips a CC-transfer row, and `excludeReason` skips 600 and a refunded row; `--apply` refuses without a matching `--expect`; the write produces the 5c shape with the full before-state; a second run writes nothing.

## 7. Review and rollout

- (rev) Lane 1 touches `server/routes/proposals/publicToken.js`, a listed sensitive path: full pre-prod fleet plus `/second-opinion`. The gate line will read `money + client`.
- Lane 2 and the backfill: full pre-prod fleet plus `/second-opinion`.
- Order: lane 1 merges and ships first (decision 5). Lane 2 second. Backfill runbook after lane 2 is live.
- (rev) Documentation, in the same change per CLAUDE.md's mandatory table: `README.md` folder tree gains `paidState.js`, `settlePoll.js`, `useSettle.js`, `PaidCard.js`, `PaymentTermsBox.js` (lane 1, plus the already-drifted `intentQuote.js` and `gratuityFloor.js`) and `server/scripts/backfillFullPaymentInvoices.js` (lane 2); `ARCHITECTURE.md`'s proposal public-route table gains `GET /t/:token/payment-state` and its limiter (lane 1) and notes the three-entrance upgrade (lane 2).
- `docs/walkthroughs-owed.md`: after both lanes are live, a real full payment with a gratuity, watching the redirect settle to "Fully paid" and the portal Receipts tab show one Full Payment invoice.
- Backlog: the "Paying in full on a deposit-terms proposal strands the remainder" entry is deleted in the runbook task, after `--apply` succeeds.

## 8. Not in scope

- The provenance-first invoice-derivation redo. This spec fixes one seam under the existing derivation and does not add the in-total-price boolean.
- Line-item totals on override'd proposals (separate backlog entry).
- Proposal 770's abandoned $75 gratuity. Not ours to add back.
- Any change to `linkPaymentToInvoice`'s cap or status guard.
- (rev) `proposals.total_price` being nullable (a NULL row would 409 every signature forever). Zero such rows in prod; a backlog note, not this lane.
- (rev) Requiring `acknowledged_total` on the sign route (the legacy-client escape hatch is a bypass for anyone hitting the endpoint directly). Backlog note with a date.
- (rev) The `create-intent` response carrying the row total so an admin price change mid-session does not cost one spurious 409 and one Stripe intent. Self-healing today; backlog note.
