# Netting re-plan: syrups join the booking total, hand-made invoices are contract money, a chargeback alert, no extras comp

Date: 2026-11-24. Status: design, revision 3 (revision 2 after the design review, approved by the owner on 2026-11-24 with "write the plan"; revision 3 after the plan review: the no-package refusal in 5.1, the daily pass riding the payout sweep in 5.5, the Inbox item as its own lane in section 10). Planned in `docs/superpowers/plans/2026-11-24-netting-replan.md`.

Source: the payments lane of the 2026-11-05 audit (`docs/audit-2026-11-05/`), which failed review on 2026-11-13. Its smaller half shipped as `audit-payments-core` (563bc811, 2026-11-18); the rest (the off-contract netting, the chargeback ledger, the hand-recorded deposit's Balance invoice, the pay-now extras pricing) was set aside for this re-plan. The worktree `../worktrees/audit-payments` (9941a449) is the record of the failed lane, reference only, never merged; its commits b681f2f9 (the dispute ledger) and 6d89ab3b (the recorded-payment Balance mint) show the earlier attempts.

Ids only in this file: no client or staff name, email or phone number.

Revision 2 in short: the design review found that the only door that mints syrup money outside the booking total is the legacy v1 drink planner, which no upcoming booking can reach. Revision 1's narrow syrup step (with its pack-aware charge and stored fold fact) is replaced by closing that door through the path add-ons already use. The review's other findings (legal-hold guards, the record-payment Balance precondition, the void on a fully paid booking, alert delivery and event ordering) are folded in below.

## 1. Intent

The OS has a third kind of money that every money path has to remember: money inside `proposals.amount_paid` but outside the booking total (`proposals.total_price`). Its two members today are a syrup-only Drink Plan Extras invoice and a free-text invoice an admin makes by hand. Every balance figure reads `total_price - amount_paid`, so a paid syrup pack cuts the balance the OS charges, bills and quotes by the syrup money (audit PAY-01); only the overpayment side subtracts the third kind back out (`sumOffContractPaidCents`). The audit's fix taught about 15 balance sites to subtract it, and that design failed review.

This re-plan ends the third kind instead of teaching everyone about it: syrups join the booking total the way add-ons do, hand-made invoices are contract money (the Balance invoice already assumes so), a chargeback raises an alert with a reminder before the evidence deadline and changes no money, the extras invoice comp goes away (giving something away is a discount), and a deposit recorded by hand mints the Balance invoice the way the Stripe rails do.

Why now: it is the last open piece of the 2026-11-05 audit, and every owner decision it needed was made on 2026-11-18. The chargeback piece has a real loss behind it: booking 843's two Klarna disputes, one won ($387.50), one lost ($100 deposit) because no evidence went in before the deadline. Dallas, 2026-11-24: "I just didn't send the info in time. spaced it."

## 2. Decisions

Dallas's, quoted:

- Hand-made invoices are contract money. 2026-11-18: "If we want to add 'extras' then we'll add a surcharge or add the extras to the actual balance."
- Chargebacks are alert-only. 2026-11-18: "yes" to the recommendation to subscribe to dispute events, alert in the Inbox with the booking, amount and evidence deadline, and change no money. The audit's full chargeback ledger (PAY-04, POUT-06) is not built.
- Comps go through a discount. 2026-11-18: "generally if we 'comp' something we'll do it via a discount. and leave the line item on the booking."
- Booking 843 stays untouched. 2026-11-18: "I need to fight the chargebacks. leave that alone for now."
- The alert exists for the deadline, not the evidence. 2026-11-24: "I just didn't send the info in time. spaced it."
- Syrups join the booking total. 2026-11-24: "Having syrups join the booking total makes the most sense to me as well." And "This looks good to me" to the approach message (the alert at open, the reminder three days before the deadline, the item clearing at close, the scope).

Mine (Claude's), each with its reason in the section named: the v1 syrup door goes through the add-on path and loses pay-now for syrups alone (5.1); the admin create-invoice hint (5.3); the dispute item clears once evidence is sent, the reminder sends when Stripe cannot be read, tip disputes alert by email only, the `payment_failure` alert category, the alert retry, the event ordering rule (5.5); a void moves the money onto the balance (5.6); record-payment mints the Balance only in the at-deposit state (5.7); what stays out of scope (section 8).

## 3. Goals, non-goals, anti-goals

Goals:

1. No new money can be minted inside `amount_paid` and outside `total_price`; the third kind is frozen at what it holds today (one legacy invoice).
2. The overpayment reading and the overpayment refund treat a paid hand-made invoice as contract money.
3. A dispute on any Stripe charge reaches Dallas the day it opens, again three days before its evidence deadline if he has not answered, and shows in the Inbox until it no longer waits on him.
4. No admin action lowers the booking total to give extras away; a discount does that.
5. A hand-recorded deposit leaves the client a Balance invoice they can pay online.

Non-goals:

- No dispute money ledger: a dispute moves no `amount_paid`, status, invoice or autopay.
- The tip dispute clawback (`handleDisputeFundsWithdrawn`, `handleDisputeFundsReinstated` in `server/routes/stripeWebhookHandlers/disputes.js`) stays off; its two events stay unsubscribed.
- Booking 843 untouched; booking 599 (the one legacy syrup payment) untouched.
- The fold's full reprice at today's catalog (money law 4, "broken today") is not fixed here.
- The pay-now extras pricing mismatch (audit PRC-03) is not fixed here (section 8).

Anti-goals: a booking that is paid today reads as owing, or as overpaid, after the change; a missed dispute deadline because an alert failed silently; any balance site gains a subtraction it has to remember; any write to the legal-hold booking (money law 15).

## 4. How it works today

### 4.1 Syrups

There are two drink planners. `client/src/pages/plan/PlannerRouter.js` sends a plan with `planner_version >= 2` to PlannerV2 and anything else to the legacy v1 wizard (`PotionPlanningLab.js`). New plans are created at version 2; every row that existed when the column was added was set to 1 (`server/db/schema.sql`, the `planner_version` block). Production, 2026-11-24 (read-only): of the drink plans linked to a booking, exactly one v1 plan belongs to an upcoming event, and it is already reviewed; no v1 plan for an upcoming event is open (draft or pending).

- **v2** has no syrup checkout: it submits with no `paid_separately` and no `syrupSelections` and never calls `create-drink-plan-intent` (`client/src/pages/plan/v2/PlannerV2.js`; `submit.js` notes the v2 planner has no syrup UI). Syrups on v2 come through the Enhancement Lab (`server/routes/drinkPlans/lab.js`, `labSyrupSelections`), which folds them into `total_price` through `foldExtrasIntoProposal` and bills them on an Enhancement Lab invoice: contract money.
- **v1** submits through `server/routes/drinkPlans/submit.js`. A submit with add-ons, a bar, a parking fee or the hosted mocktail flip (`hasFinancialSideEffects`) takes the transaction path, which folds every new syrup into the total with the add-ons (`foldExtrasIntoProposal`, which also holds the legal-hold refusal). A syrup-only submit takes the fast path: with pay now (`paid_separately`) it mints a Drink Plan Extras invoice (`findOrRefreshExtrasInvoice`) and never touches the total; with add to balance (`ConfirmationStep.js` offers `add_to_balance`, `PotionPlanningLab.js` sends `paid_separately: false`) it bills nothing at all, since nothing else reads plan syrups into the booking.

So the third kind's only door is the v1 syrup-only pay-now, and v1 add-to-balance syrups have never been billed. Both are reachable today only if an admin resets a v1 plan to draft.

After a v1 syrup-only pay-now payment, the webhook (`paymentIntentSucceeded.js`, `drink_plan_extras` branch) adds the money to `amount_paid` and links and locks the extras invoice; from then on autopay, charge-balance, the Balance refresh (`refreshUnlockedInvoices`, whose `lockedTotal` subtracts the locked extras invoice), the public payload, the portal and the reminders are all short by the syrups.

`invoiceExtras.js:extrasLinesAreFolded` tells folded from unfolded by the line shape (an add-on or bar line means folded); its readers are `sumOffContractPaidCents`, `voidExtrasInvoiceWithReconcile`, `lineItemCancel.js` and, through `offContractPaidCents`, `refundHelpers.js`.

### 4.2 Hand-made invoices

`POST /api/invoices/proposal/:id` (`server/routes/invoices.js`) mints a free-text invoice. The Balance refresh counts a locked one in `lockedTotal`, so it lowers the Balance (contract money). `sumOffContractPaidCents` counts it as outside the contract, so after a price drop the panel shows no overpayment and `refundExecute` refuses the overpayment refund (the known limitation the core lane shipped with). The refund-scope classification (`refundHelpers.js:applyRefundReconciliation`: non-contract when the label is not in `CONTRACT_LABELS`) treats it as it treats Additional Services, which is also inside the total; law 5 already separates the refund-scope set (`CONTRACT_LABELS`) from the in-the-total set (`IN_TOTAL_PRICE_LABELS`).

### 4.3 Disputes

The live webhook endpoint (`we_1TCm2cAZrfv5tWfNcqAOhf3x`, Stripe-side config, re-verified with a GET at rollout) takes eight events, none `charge.dispute.*`. The dispatcher (`server/routes/stripeWebhook.js`) verifies the signature against the live and test secrets, drops a test-mode event outside an active test window (decided by which secret verified it), and routes only `charge.dispute.funds_withdrawn` and `funds_reinstated`, both to the tip clawback, which has never run in production. Event-level dedup is not general: dispute and refund idempotency lives in the helpers. Stripe's own dispute email is the only notice today.

### 4.4 The extras comp

`PATCH /api/invoices/:id` with `status: 'void'` on an unpaid Drink Plan Extras invoice runs `voidExtrasInvoiceWithReconcile`, which subtracts the folded portion from `total_price` unless the request sends `reconcile_total: false` (the route defaults to the comp: `reconcile_total !== false`). The next reprice bills the waived add-on again (audit PRC-01). The route has no legal-hold guard. The panel copy (`ProposalDetailPaymentPanel.js`, near line 380) describes the void's money side effect.

### 4.5 A hand-recorded deposit

`POST /api/proposals/:id/record-payment` (`server/routes/proposals/actions.js`) links the payment to the oldest open invoice and never calls `createBalanceInvoice`, which both Stripe rails call after a deposit. So after a Zelle deposit is recorded, the client has no payable invoice until the balance monitor flags it the next day (audit PAY-05). `createBalanceInvoice` (`invoiceLifecycle.js`) itself only checks for an existing Balance and a zero balance and mints at `total_price - amount_paid`; the rails stay safe through their call-site gate (a deposit payment or an invoice conversion). The admin Balance route (`invoices.js`, `isBalanceRequest`) holds the precondition that makes that figure right: the booking's one live invoice is its paid, locked Deposit and every paid dollar is inside it or external (`atDeposit`), and it refuses a legal-hold booking. Record-payment has no legal-hold guard of its own on this path.

### 4.6 Production counts (read-only, 2026-11-24)

| Kind | Paid | Open | Void |
|---|---|---|---|
| Drink Plan Extras, syrup-only | 1 ($60) | 0 | 0 |
| Drink Plan Extras, with an add-on or bar line | 1 ($20) | 0 | 2 |
| Free-text (hand-made) | 2 ($450) | 0 | 1 |

The paid syrup-only invoice is on booking 599 (completed, total $200, paid $260; the $60 is the syrups). The two paid free-text invoices are on bookings 596 and 789, both contract balance billed by hand (memory `project-netting-owner-calls-2026-11`). Disputes: 2 ever, both on booking 843, both closed (Stripe read, 2026-11-18).

## 5. Design

### 5.1 Syrups join the booking total: close the v1 door through the add-on path (my call)

v2 already puts syrups in the total (the Enhancement Lab), so the work is the v1 door:

- **Add to balance.** A v1 submit that adds priced syrups the booking lacks (not self-provided, not already in `pricing_snapshot.syrups.selections`) counts as a financial submit: `hasFinancialSideEffects` becomes true, so it takes the transaction path add-ons take. That path already holds what this needs: the row lock, the legal-hold refusal inside `foldExtrasIntoProposal` (409 `NOT_CHANGEABLE`, fail closed), the status reconcile, the pre-fold total baseline, and the add-to-balance branch's `refreshUnlockedInvoices` and `createAdditionalInvoiceIfNeeded`. The syrups then sit in the contract like any line: a later reprice keeps them, the Balance bills them, a refund or cancel treats them as contract money. This also closes the hole where v1 add-to-balance syrups were never billed. One edge the transaction path does not cover: where the booking has no package, guest count or duration, the path skips the fold (`submit.js`, near line 423) and an add-on submit there saves its lines with the total unmoved. A syrup-only submit in that state is refused before any write (409 `SYRUPS_NOT_PRICEABLE`, with a message asking the client to contact DRB), never saved unbilled (my call; the add-on case is pre-existing and goes to the owner's list, section 8).
- **Pay now and pay everything, syrups alone.** Refused. `POST /stripe/create-drink-plan-intent/:token` (`server/routes/stripe.js`) refuses when the extras it would charge are priced syrups and nothing else, and the submit refuses a `paid_separately` submit of syrups alone, each with a 409 whose message says to add them to the balance. The v1 `ConfirmationStep.js` offers only add to balance when the only extras are syrups. Reason: a syrup-only pay-now through the fold would leave an open extras invoice beside a total that already holds its money (a declined card then lets autopay and the invoice both collect it), and it would mint an invoice the line rule reads as unfolded. Refusing leaves add to balance as the one door. A mixed v1 submit (add-ons plus syrups) is unchanged.
- **The client quote.** The v1 add-to-balance quote for syrups shows the change the fold makes, the booking's syrup cost with the new bottles minus without (`calculateSyrupCost` over counts on the client), so the figure shown is the figure billed. Display only; the server stays the truth.
- **Accepted, stated:** the fold reprices a booking with no override at today's catalog (money law 4, "broken today"), so on a v1 booking whose package or add-on prices changed since its quote, a syrup submit moves the total by that drift too, exactly as every v1 add-on submit and every Enhancement Lab submit does today. The door is reachable only through a v1 plan an admin resets; fixing the fold is out of scope (section 8).
- **Consequence:** no new syrup-only Drink Plan Extras invoice can be minted (a mixed submit always carries an add-on or bar line, and the webhook's create-if-missing fallback only runs for a `drink_plan_extras` payment, which now always carries one). So `extrasLinesAreFolded`'s line rule stays right, the third kind is frozen at booking 599's invoice, and no stored fold fact or backfill is needed.
- Unchanged: the webhook's `drink_plan_extras` and `drink_plan_with_balance` branches, the status ladder (money law 8), autopay, charge-balance, the Balance refresh, the public payload, the portal and the reminders.

### 5.2 Hand-made invoices are contract money

`sumOffContractPaidCents` (`server/utils/invoiceExtras.js`) stops counting free-text invoices; it counts only Drink Plan Extras invoices the line rule reads as unfolded, which is booking 599's alone. Its readers then read hand-made money as contract money: `refundHelpers.offContractPaidCents` (feeding `nettedOverpaymentCents`, the overpayment refund cap and `proposalDetail`'s `overpayment_cents`), `lineItemCancel.js`, `server/routes/proposals/crud.js`, and the client `repriceSummary.js` and `editSheetView.js` (which read the payload and change no code). A price drop after a hand-made payment now shows the overpayment and offers the overpayment refund.

The refund-scope classification is unchanged: a hand-made invoice keeps the treatment Additional Services has (inside the total for netting, outside `CONTRACT_LABELS` for refund scope), which is the partition law 5 already draws between those two sets.

Before the ship, a read-only production query lists every booking that would newly read as overpaid (paid minus total exceeds the legacy unfolded extras, with paid free-text money that was netted before). Expected: none (596 and 789 are contract balance). If any appears, the lane stops and reports before shipping. The legal-hold booking is not read; nothing in this change writes it.

### 5.3 The admin create-invoice hint (my call)

The admin form that mints a free-text invoice says, in one line, that it bills part of the booking total, and that something new is added to the booking first (a surcharge or an add-on) so it is in the total. Reason: after 5.2 a hand-made invoice for money outside the contract would read as an overpayment, and Dallas's rule is that extras go into the balance.

### 5.4 Booking 599 and the legacy row

Booking 599 is untouched: its invoice still reads unfolded by the line rule, its $60 stays netted, and it keeps reading as not overpaid.

### 5.5 The chargeback alert

**Events.** At rollout the live endpoint adds `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` to its eight, by name (never a `charge.dispute.*` wildcard, which would switch on the tip clawback), and the list is read back. The dispatcher routes the three to a new handler; signature verification and the test-mode drop are the dispatcher's existing ones. The two `funds_*` routes stay in the file and stay unsubscribed.

**The record.** A new table, one row per dispute keyed on the Stripe dispute id: the payment intent and charge, the matched booking or tip (or neither), amount in cents and currency, Stripe's reason and status, the evidence deadline (`evidence_details.due_by`, nullable), opened and closed times and the outcome, when the open alert and the reminder were sent, and the Stripe `created` time and status of the last event applied. Schema in `schema.sql` as idempotent statements. The handler and the reminder write only this table, never a booking, invoice or tip table.

**Ordering (my call).** Each event upserts the row from the dispute object it carries. An event applies when its `created` is later than the last applied, or equal and its status ranks at least as far along (waiting on evidence, then under review, then closed); a closed status (won, lost, `warning_closed`) never goes back. A redelivery or out-of-order delivery is therefore harmless.

**Alert at open (my call on delivery).** When a dispute is first recorded in a status that waits on evidence (`needs_response` or `warning_needs_response`), one email goes through `notifyAdminCategory`, category `payment_failure` (it exists and reaches the admins subscribed to money trouble; the lane checks that Dallas's account receives it), with push on, no SMS. It is sent after the row commits, and the row's alert stamp is written only when the send reports success (a Resend send returns `.error` and never throws). A dispute first seen already under review or closed is recorded silently. The email carries the booking id, its event type label (`getEventTypeLabel`) and date, the amount, Stripe's reason in plain words, the deadline as a Chicago date and time (or "Stripe gave no deadline"), and links to the dispute in the Stripe dashboard and to the booking.

**Daily job.** A daily pass that rides the existing daily Stripe payout sweep (`RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER`, `server/index.js`), through a small module that runs the payout sweep and then the dispute pass, each in its own try and its own Sentry tag, so a failure in one never stops the other (my call: `server/index.js` is 989 lines, so a new scheduler block would cross the 1000-line limit; no new environment variable). It does three things:

1. Re-reads each dispute that is not closed from Stripe and applies its status by the ordering rule (my call: disputes are few, and a missed `updated` event would otherwise leave an item waiting that no longer waits).
2. Retries the open alert for any dispute still waiting on evidence whose alert stamp is empty.
3. For each dispute still waiting on evidence by its stored status, with a deadline within the next three Chicago days and no reminder sent: reads the dispute live from Stripe (`stripeClient.js`); if it still waits on evidence, sends a second email; if not, updates the row and sends nothing; if the read fails, sends anyway (my call: a spurious reminder costs one email, a missed one cost $100 on booking 843). Every branch that sends stamps the reminder, so it never repeats. A dispute with no deadline gets no reminder.

**Legal hold.** The handler and the job write only the dispute table and email only the admins; neither is a write to the booking, a chase of the client or an AI read, so neither skips the legal-hold booking (money law 15 holds: its database state is untouched). The Inbox item follows the Inbox's existing hold handling, as menu tasks do.

**Inbox.** A dispute on a booking is an Inbox item under that booking's client, a task item from its own reader on the menu-task precedent (`server/utils/inbox/readMenuTasks.js`, spec 2026-10-19 section 13). It shows what the email shows; it is open while Stripe says the dispute waits on evidence; once evidence is sent (status `under_review`, through `charge.dispute.updated`) it leaves the waiting list (my call: the Inbox is "waiting on you", and a dispute under review waits on the bank for up to two months); once the dispute closes it sits in the Inbox's closed list, marked won or lost. Dispute items never go to the Inbox AI read. The Inbox is a designed surface (`docs/design-artifacts/2026-10-06-inbox/`): the item uses the existing item vocabulary (the builder names which existing element carries the deadline and the won or lost mark), no new visual element, and the client review judges it against that artifact.

**No booking.** A dispute on a tip, or on a charge the OS cannot match, gets the email and the reminder (naming the tip, or only the Stripe ids) and no Inbox item (my call: tips are paid by guests who are not clients, so there is no client to file it under).

**Never:** a change to `amount_paid`, status, invoices, autopay, payroll or the tip.

**Observability.** Sentry captures, with a tag per case: an unmatched dispute (warning), a failed Stripe read in the job, a failed alert send, and the switch-on run with its count. No client name or contact goes to Sentry.

**Switch-on.** A one-time script under `server/scripts/`, sharing the handler's upsert and the alert stamp so it and a live event cannot both alert, lists disputes from Stripe (paginated) and records any not closed, sending their open alert. Expected: none. Closed disputes (booking 843's two) are not backfilled.

### 5.6 No extras comp; a void moves the money onto the balance (my call)

Voiding an unpaid Drink Plan Extras invoice whose lines the line rule reads as folded never lowers `total_price`: the route's comp default goes (no request can reach the subtracting branch; the builder removes it or makes it refuse), and the extras stay in the total. After the void, the booking's open invoices together demand what it still owes: an unlocked Balance or Full Payment absorbs it through `refreshUnlockedInvoices`; when none exists (the booking is otherwise paid and every invoice is locked), one Additional Services invoice carries the shortfall, the amount owed (`total_price - amount_paid`, floored at 0) minus what the open invoices already demand, and nothing is minted when that is 0. A plain `createAdditionalInvoiceIfNeeded(id, oldTotal)` call is not enough here, since the void does not move the total; the builder passes the baseline that yields the shortfall or computes it directly. An unfolded (legacy syrup-only) invoice stays a plain void; none is open today.

The route refuses the void on a legal-hold booking (`isLegalHold`, fail closed; money law 15 bars voiding its invoices). The activity row's reason stops saying comp. Giving extras away is a discount through the existing price adjustment (Dallas, 2026-11-18); taking an item off the booking is cancel-line (`server/utils/lineItemCancel.js`). The panel copy near `ProposalDetailPaymentPanel.js:380` says so in plain words: voiding moves these extras onto the balance; to give them away, add a discount. The stale comment at `paymentIntentSucceeded.js` (near line 192) that says the comp lowers `total_price` is corrected.

### 5.7 A hand-recorded deposit mints the Balance invoice (my call)

After its invoice link, record-payment calls `createBalanceInvoice` only when the booking is in the at-deposit state the admin Balance route already defines (its one live invoice is its paid, locked Deposit, and `amount_paid` equals the deposit plus external money), and the booking is not on legal hold. That precondition moves into one shared helper the admin Balance route and record-payment both call, so the two never drift. In any other state (a partial below the deposit, an open Full Payment on full terms, other open invoices, a payment no invoice holds) record-payment mints nothing and its response says the remainder has no payable invoice yet, so the admin bills it; the balance monitor stays the backstop. `createBalanceInvoice` and the Stripe rails are unchanged. A full record mints nothing.

## 6. Money laws touched

- Law 5, the "third kind" sentence: after this change it is only a legacy syrup-only Drink Plan Extras invoice (booking 599's); no new one can be minted, since syrups fold into `total_price` on every door; free-text invoices are contract money [Dallas 2026-11-18], inside the total for netting and outside `CONTRACT_LABELS` for refund scope, as Additional Services is.
- Law 7: the Drink Plan Extras and free-text reasons rewritten to match.
- Law 8: unchanged.

Each rewritten law gets a "Checked against code" line only after a verify pass reads it against the code.

## 7. Consumers to grep in the same change

Every reader of the extras label, `extrasLinesAreFolded`, `sumOffContractPaidCents` and `offContractPaidCents`; the design review confirmed these files exist and did not finish proving the list complete, so the plan re-greps: `server/utils/invoiceExtras.js`, `server/utils/lineItemCancel.js`, `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`, `server/routes/invoices.js`, `server/utils/refundHelpers.js`, `server/routes/stripe.js`, `server/routes/drinkPlans/submit.js`, `server/routes/drinkPlans/lab.js`, `server/utils/autopayDurableCharge.js`, `server/scripts/backfillExtrasInvoices.js`, `server/utils/staleProposalSweep.js`, `server/utils/reads/proposalDetail.js`, `server/utils/proposalMoneyShared.js`, `server/utils/invoiceLifecycle.js`, `server/utils/drinkPlanExtras.js`, `server/utils/beoFinalize.js`, `server/utils/balanceInvoiceMonitor.js`, `server/routes/proposals/crud.js`, `server/routes/proposals/cancel.js`, `server/routes/drinkPlans.js`, `client/src/pages/admin/ProposalDetailPaymentPanel.js`, `client/src/pages/plan/steps/ConfirmationStep.js`, `client/src/pages/plan/PotionPlanningLab.js`, `client/src/pages/admin/proposalEditor/repriceSummary.js`, `client/src/utils/editSheetView.js`.

Header notes that describe the old premise are rewritten so the next reader is not misled: `invoiceExtras.js` (the `sumOffContractPaidCents` header names "any free-text manual invoice (Damage Fee, Travel)"), `submit.js` (the fast-path comment), `refundHelpers.js` (near lines 556 and 691), `balanceInvoiceMonitor.js` (near line 80), `paymentIntentSucceeded.js` (near line 192).

Docs the hooks check: every new file under `server/` gets its header comment; no new environment variable is added (the daily pass rides an existing switch); ARCHITECTURE.md's hand-written prose changes where a concept does (the third kind of money; the webhook gaining a dispute record); `npm run docs` regenerates the rest.

## 8. Out of scope, with reasons

- **The pay-now extras pricing mismatch (audit PRC-03)** on v1 mixed submits and the Enhancement Lab's standalone syrup quote (the lab bills the folded remainder, so only its quote differs): v1 is reachable only after an admin reset, and making a charge equal the fold's movement runs into the fold's catalog recompute (law 4); it wants its own design with the law-4 fold fix.
- **The fold's catalog recompute (money law 4)** on v1 and lab submits: pre-existing, its own design.
- **An open folded extras invoice beside the total** (a v1 mixed pay-now whose card was declined, then autopay): pre-existing for add-ons, v1-only, and the balance monitor's over-billed check flags it; reported for the owner's list.
- **The Enhancement Lab's remainder** (`lab.js`, near line 429) excludes every Drink Plan Extras invoice from its subtractions, which is wrong for a folded v1 extras invoice on a paid booking that later runs a lab round (one paid folded extras invoice ever, May 2026); reported for the owner's list.
- **A v1 add-on submit on a booking with no package, guest count or duration** saves the add-on lines with the total unmoved, so they are never billed: pre-existing, v1-only; reported for the owner's list.
- **An open hand-made invoice beside an open Balance**, both able to demand the same contract money: pre-existing, needs one rule across autopay, the Balance refresh and the reminders, and production has no open free-text invoice; reported for the owner's list.
- **The dispute money ledger and the tip clawback switch-on:** non-goals by Dallas's call. **Bookings 599 and 843:** untouched.

## 9. Rollout

1. The lanes ship through `npm run ship`. The dispute handler is inert until Stripe sends the events.
2. Before the hand-made lane ships: the read-only overpayment query of 5.2.
3. With Dallas's yes at the time (a live Stripe config change): add the three dispute events to the live endpoint by name, keep the eight, read the list back.
4. The switch-on script of 5.5.

## 10. Lane sketch (the plan decides)

1. **Money cleanup:** 5.1 (the v1 syrup door, the intent refusal, the v1 confirmation choice and quote), 5.2 to 5.4 (hand-made invoices, the hint, 599), laws 5 and 7. Money; full review.
2. **The extras void and the recorded deposit:** 5.6 and 5.7. Money; full review. Independent of lane 1 in code (`invoices.js`, `actions.js`, the shared precondition helper), so it can run beside it; it may also fold into lane 1 if the plan finds the footprints overlap.
3. **The chargeback alert:** 5.5 without the Inbox (schema, handler, daily pass, emails, switch-on script). Touches no money path; webhook, provider and concurrency review.
4. **The dispute Inbox item:** 5.5's Inbox paragraph, after the alert lane, so the deadline emails never wait on the Inbox design review.

## 11. Left to the builder

The dispute table's name and exact columns; the email and Inbox copy (no em dashes); which existing Inbox element carries the deadline and the won or lost mark; whether the dead comp branch is removed or refuses; how 5.6 computes the shortfall; the test plan per lane, which must include: a v1 syrup-only add-to-balance submit billing the syrups through the Balance (and through Additional Services on a fully paid booking); the intent and submit refusing syrup-only pay-now; a v1 syrup submit on the legal-hold booking refused; the 5.2 overpayment reading with a paid hand-made invoice after a price drop; the 5.6 void on a fully paid booking minting exactly the shortfall, and on the legal-hold booking refused; record-payment minting in the at-deposit state and not in the others; dispute events out of order and tied; a first-seen closed dispute sending nothing; a failed alert send retried by the job; the reminder on a Stripe read failure sending once.
