# Netting re-plan: syrups join the booking total, hand-made invoices are contract money, a chargeback alert, no extras comp

Date: 2026-11-24. Status: design, approved approach, not yet planned.

Source: the payments lane of the 2026-11-05 audit (`docs/audit-2026-11-05/`), which failed review on 2026-11-13. Its smaller half shipped as `audit-payments-core` (563bc811, 2026-11-18). The rest (the off-contract netting, the chargeback ledger, the hand-recorded deposit's Balance invoice, the pay-now extras pricing) was set aside for this re-plan. The worktree `../worktrees/audit-payments` (9941a449) is the record of the failed lane. It is reference only and never merges; its commits 8cdb48f3 (balance netting), d0a904b8 (the stored fold fact), b681f2f9 (the dispute ledger) and 6d89ab3b (the recorded-payment Balance mint) show the earlier attempts.

Ids only in this file: no client or staff name, email or phone number.

## 1. Intent

The OS has a third kind of money that every money path has to remember. Some of what a client pays is outside the booking total (`proposals.total_price`) but inside `proposals.amount_paid`. Today that third kind has two members: a syrup-only Drink Plan Extras invoice and a free-text invoice an admin makes by hand. Every balance figure reads `total_price - amount_paid`, so a paid syrup pack quietly cuts the balance the OS charges, bills and quotes by the syrup money (audit PAY-01). Only the overpayment side subtracts the third kind back out (`sumOffContractPaidCents`). The audit's fix taught about 15 balance sites to subtract it, and that design is what failed review.

This re-plan removes the third kind instead of teaching everyone about it:

- Syrups bought from the drink plan join the booking total, the way add-ons already do.
- Hand-made invoices are contract money, which the Balance invoice already assumes.
- A chargeback raises an alert with a reminder before the evidence deadline, and changes no money.
- The extras invoice comp goes away; giving something away is a discount.
- A deposit recorded by hand mints the Balance invoice the way the Stripe rails do.

Why now: this is the last open piece of the 2026-11-05 audit, and every owner decision it needed was made on 2026-11-18. The chargeback piece has a real loss behind it. Booking 843 had two Klarna disputes. One ($387.50) was won. The other ($100 deposit) was lost because no evidence went in before the deadline. Dallas, 2026-11-24: "I just didn't send the info in time. spaced it."

## 2. Decisions

Dallas's, quoted:

- Hand-made invoices are contract money. 2026-11-18: "If we want to add 'extras' then we'll add a surcharge or add the extras to the actual balance."
- Chargebacks are alert-only. 2026-11-18: "yes" to the recommendation to subscribe to dispute events, alert in the Inbox with the booking, amount and evidence deadline, and change no money. The audit's full chargeback ledger (PAY-04, POUT-06) is not built.
- Comps go through a discount. 2026-11-18: "generally if we 'comp' something we'll do it via a discount. and leave the line item on the booking."
- Booking 843 stays untouched. 2026-11-18: "I need to fight the chargebacks. leave that alone for now."
- The alert exists because the deadline was missed, not because the evidence was hard to gather. 2026-11-24: "I just didn't send the info in time. spaced it."
- Syrups join the booking total. 2026-11-24: "Having syrups join the booking total makes the most sense to me as well." He also said "This looks good to me" to the approach message: the alert at open, the reminder three days before the deadline, the item clearing at close, and the scope of four lanes.

Mine (Claude's), each with its reason, in the sections below:

- the syrup purchase moves only the syrup line, never a full reprice (5.1);
- the syrup charge is pack-aware (5.2);
- the stored fold fact (5.4);
- the dispute item clears once evidence is sent (5.7);
- the reminder sends when Stripe cannot be read (5.7);
- tip disputes alert by email only (5.7);
- the `payment_failure` alert category (5.7);
- voiding an unpaid extras invoice moves its money onto the balance (5.8);
- what stays out of scope (section 8).

## 3. Goals, non-goals, anti-goals

Goals:

1. Every balance figure the OS charges, bills or quotes is right after a syrup purchase, with no special case at any balance site.
2. The overpayment reading and the overpayment refund treat a paid hand-made invoice as contract money.
3. A dispute on any Stripe charge reaches Dallas the day it opens, again three days before its evidence deadline if he has not answered, and shows in the Inbox until it no longer waits on him.
4. No admin action lowers the booking total to give extras away; a discount does that.
5. A hand-recorded partial payment leaves the client a Balance invoice they can pay online.

Non-goals:

- No dispute money ledger: a dispute moves no `amount_paid`, no status, no invoice and no autopay.
- The tip dispute clawback (`handleDisputeFundsWithdrawn` and `handleDisputeFundsReinstated` in `server/routes/stripeWebhookHandlers/disputes.js`) stays switched off. Its two events stay unsubscribed.
- Booking 843 is untouched, and so is booking 599 (the one legacy syrup payment).
- The add-on fold's full reprice at today's catalog (money law 4, the "broken today" paragraph) is not fixed here.
- The pay-now add-on pricing mismatch (audit PRC-03, add-on half) is not fixed here (section 8).

Anti-goals: these would make the work a failure even if it ran.

- A syrup purchase moves any other line on the booking.
- A booking that is paid today reads as owing, or as overpaid, after the change.
- A missed dispute deadline because the reminder decided not to send.
- Any balance site gains a subtraction it has to remember.

## 4. How it works today

### 4.1 Syrups

**The submit.** `server/routes/drinkPlans/submit.js` has two paths. A submit that adds add-ons, a bar or a parking fee (`hasFinancialSideEffects`) takes the transaction path. That path calls `foldExtrasIntoProposal` (`server/utils/proposalExtrasFold.js`), which reprices the booking with the new syrups and add-ons and writes `total_price` and `pricing_snapshot`. Syrups bought alongside an add-on are therefore already in the total.

A syrup-only submit takes the fast path instead:

- With pay now (`paid_separately`), it mints a Drink Plan Extras invoice (`findOrRefreshExtrasInvoice`) and never touches `total_price`.
- With add to balance, it bills nothing at all. `client/src/pages/plan/steps/ConfirmationStep.js` offers `add_to_balance`, and `PotionPlanningLab.js` `handleSubmit` sends no `paid_separately`. The fast path only mints an invoice when `paid_separately` is set, and nothing else reads plan syrups into the booking. The proposal's syrups live in `pricing_snapshot.syrups.selections`, written by the admin editor and the fold. So add-to-balance syrups have never been charged unless an admin added them by hand.

**After a pay-now syrup payment.** The webhook (`paymentIntentSucceeded.js`, the `drink_plan_extras` branch) adds the syrup money to `amount_paid` and links the invoice, which then locks. From then on:

- autopay (`balanceScheduler.js`) and charge-balance (`stripe.js`) take `total_price - amount_paid`, short by the syrups;
- the Balance refresh (`invoiceLifecycle.js:refreshUnlockedInvoices`) subtracts the locked extras invoice in `lockedTotal`, so the Balance invoice is short too;
- the public payload, the portal and the reminders all quote the short figure.

**Pricing.** The extras charge prices only the new syrups, standalone (`server/utils/drinkPlanExtras.js:computeExtrasBreakdown` calls `calculateSyrupCost(newSyrupIds)`; the client twin in `ConfirmationStep.js` does the same). The engine prices all of a booking's syrups together, and its 3-pack discount (`pricingEngine.js:calculateSyrupCost`, every 3 bottles at the pack price) spans every bottle. When a booking already has syrups, the two figures can differ. The transaction path already has this mismatch for a mixed submit: the invoice charges the standalone price while the fold moves the total by the pack-aware difference.

**Telling folded from unfolded.** `invoiceExtras.js:extrasLinesAreFolded` decides from the line shape: an add-on or bar line means folded, syrup lines alone mean not folded.

Its readers:

- `sumOffContractPaidCents`;
- `voidExtrasInvoiceWithReconcile` (the comp);
- `lineItemCancel.js`;
- `refundHelpers.js`, through `offContractPaidCents`.

### 4.2 Hand-made invoices

`POST /api/invoices/proposal/:id` (`server/routes/invoices.js`) mints a free-text invoice. The two sides treat its money differently:

- **Balance side:** the Balance refresh counts a locked one in `lockedTotal`, so it lowers the Balance. That is contract money, as Dallas decided.
- **Overpayment side:** `sumOffContractPaidCents` counts it as outside the contract. So after a price drop the panel shows no overpayment, and `refundExecute` refuses the overpayment refund. That is the known limitation the core lane shipped with.

The refund classification (`refundHelpers.js:applyRefundReconciliation`, non-contract when the label is not in `CONTRACT_LABELS`) treats a free-text invoice the same way it treats Additional Services, and this design leaves it there.

### 4.3 Disputes

The live Stripe webhook endpoint (`we_1TCm2cAZrfv5tWfNcqAOhf3x`, Stripe-side config; memory `reference-ach-processing-invisible`, re-verified with a GET at rollout) takes eight events. No `charge.dispute.*` event is among them.

The dispatcher (`server/routes/stripeWebhook.js`) routes only `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`, and both go to the tip clawback (`disputes.js`). Both handlers have never run in production, because the endpoint has never sent those events.

Stripe's own dispute email is the only notice today.

### 4.4 The extras comp

`PATCH /api/invoices/:id` with `status: 'void'` on an unpaid Drink Plan Extras invoice runs `voidExtrasInvoiceWithReconcile` with `reconcileTotalPrice: true`. That subtracts the folded portion from `total_price`. The next reprice then bills the waived add-on again (audit PRC-01). The admin panel copy (`client/src/pages/admin/ProposalDetailPaymentPanel.js`, near line 380) describes the void's money side effect.

### 4.5 A hand-recorded deposit

`POST /api/proposals/:id/record-payment` (`server/routes/proposals/actions.js`) links the payment to the oldest open invoice and never calls `createBalanceInvoice`. Both Stripe rails do call it (`paymentIntentSucceeded.js`, `checkoutSessionCompleted.js`). So after a Zelle deposit is recorded, the client has no payable invoice until the balance monitor flags it the next day (audit PAY-05).

### 4.6 Production counts (read-only, 2026-11-24)

**Invoices ever.**

| Kind | Paid | Open | Void |
|---|---|---|---|
| Drink Plan Extras, syrup-only | 1 ($60) | 0 | 0 |
| Drink Plan Extras, with an add-on or bar line | 1 ($20) | 0 | 2 |
| Free-text (hand-made) | 2 ($450) | 0 | 1 |

**Booking details.**

- The paid syrup-only invoice is on booking 599. The booking is completed, its total is $200 and it is paid $260; the $60 is the syrup money.
- The two paid free-text invoices are on bookings 596 and 789. Both were contract balance billed by hand (memory `project-netting-owner-calls-2026-11`).

**Disputes:** 2 ever, both on booking 843, both closed (Stripe read on 2026-11-18).

## 5. Design

### 5.1 Syrups join the booking total

**The rule.** A drink-plan submit that adds priced syrups the booking does not already have moves `total_price` by the syrup change, writes the new syrups into the booking's syrup selection, and re-runs the payment status. That holds for all three payment choices: pay now, pay everything, add to balance. Two definitions:

- **Priced syrups:** neither self-provided nor already in `pricing_snapshot.syrups.selections`. Absent `syrupSelections` stays neutral, as it is today.
- **The syrup change:** the pack-aware difference of 5.2.

The syrups then sit in the contract like any other line. A later reprice keeps them, the Balance bills them, and a refund or cancel treats them as contract money.

**The constraint (my call).** A syrup purchase moves the syrup line and nothing else. The transaction path's fold recomputes a booking with no override at today's catalog (`proposalExtrasFold.js`: "Native proposals (no override) keep the plain catalog recompute"). So if a package or add-on price changed since the booking was quoted, routing a syrup-only submit through that fold would move the total by the drift as well as the syrups. Today a syrup-only submit never runs the fold. Sending it there would widen a known money-law-4 defect to a new door.

The builder picks the mechanism. Whatever it is, a test must pin a booking whose catalog drifted and show that only the syrup line moved. Two shapes that satisfy this:

- (a) A narrow syrup step under the same `FOR UPDATE`. It recomputes the snapshot's syrup block and its breakdown line with the engine's own `calculateSyrupCost`, moves `total_price` (and `total_price_override` when one is set) by the syrup change, and calls `reconcileProposalPaymentStatus`.
- (b) A fold mode that moves the total by the extras delta for every booking, the way the override branch already does, with the snapshot kept consistent.

Shape (a) touches only syrups. Shape (b) is a law-4 fix for add-ons too, and so a larger change with its own review.

**Downstream of the syrup move, by payment choice.** Each mirrors the add-on path:

- **Pay now:** the Drink Plan Extras invoice is minted as today, and the Balance invoice is not refreshed at submit. After the payment locks the extras invoice, `refreshUnlockedInvoices` subtracts it.
- **Pay everything:** the intent charges the syrup change plus the balance after the move, never the syrups twice.
- **Add to balance:** the Balance refresh, or `createAdditionalInvoiceIfNeeded` when the booking's invoices are all locked, carries the syrups. This closes the never-billed hole in 4.1.

**Unchanged:** the legal-hold refusal (`isLegalHold`, fail closed), the submit-once gate, and the self-provided rules.

### 5.2 The syrup charge is pack-aware (my call)

The syrup money the client is quoted, charged and invoiced is `calculateSyrupCost(before plus new) - calculateSyrupCost(before)`, the change in the booking's syrup line. It is never `calculateSyrupCost(new)` alone. The same figure appears in:

- `computeExtrasBreakdown`;
- `POST /stripe/create-drink-plan-intent/:token` (`stripe.js`);
- the extras invoice lines;
- the client quote in `ConfirmationStep.js`, which is display only; the server stays the truth.

Reason: once syrups are in the total, the total prices all of a booking's syrups together, and so does any later admin save. A standalone charge would leave the collected money and the total apart by the pack difference, and the next save would turn that gap into a phantom overpayment.

Effect on clients: a client who adds syrups to a booking that already has some can pay less than today, when the new bottles complete a 3-pack. It never pays more. The mixed submit (add-ons plus syrups) gets the same syrup figure, which closes the syrup half of audit PRC-03.

### 5.3 What stays the same for a syrup purchase

- The webhook's `drink_plan_extras` and `drink_plan_with_balance` branches still add the captured amount to `amount_paid` and link the extras invoice. That is now simply contract money arriving.
- The status ladder, money law 8, autopay, charge-balance, the Balance refresh, the public payload, the portal and the reminders change no code. They become right because the total now holds the syrups.

### 5.4 The stored fold fact (my call)

Whether an extras invoice's money is inside `total_price` becomes a stored fact on the invoice, written when the invoice is minted. It is never inferred from its lines again. Money law 5 already requires stored provenance, and after 5.1 the line rule (`extrasLinesAreFolded`: syrup lines alone mean not folded) is wrong for every new syrup-only invoice.

- **New extras invoices:** the fact is "folded".
- **Existing ones:** backfilled once by today's line rule. That gives exactly one paid unfolded invoice, on booking 599, and none open.

The shape is the builder's. The earlier attempt's shape is reference: `invoices.folded_into_total`, which only ever moves from false to true (audit commit d0a904b8). `extrasLinesAreFolded`'s readers switch to the fact.

### 5.5 Hand-made invoices are contract money

`sumOffContractPaidCents` (`server/utils/invoiceExtras.js`) stops counting free-text invoices. It counts only extras invoices whose stored fact says "not folded", which means booking 599 alone today. Its readers then read hand-made money as contract money:

- `refundHelpers.offContractPaidCents`, which feeds `nettedOverpaymentCents`, the overpayment refund cap and `proposalDetail`'s `overpayment_cents`;
- `lineItemCancel.js`;
- `server/routes/proposals/crud.js`;
- the client `repriceSummary.js` and `editSheetView.js`, which read the payload and change no code.

A price drop after a hand-made payment now shows the overpayment, and the overpayment refund is offered.

Unchanged: the refund classification (4.2) and the Balance refresh, which already counts a locked free-text invoice.

### 5.6 Booking 599 and the other legacy rows

- **599** keeps its unfolded fact, so its $60 stays netted and it keeps reading as not overpaid. Its row is not touched.
- **596 and 789** must read the same overpayment before and after (expected $0). The lane checks both on production, read-only, after the ship.

### 5.7 The chargeback alert

**Events.** At rollout the live endpoint adds `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` to its eight events, read back after. `funds_withdrawn` and `funds_reinstated` stay off, so the tip clawback stays switched off. The dispatcher routes the three new events to a new handler. The existing two routes stay in the file and stay unsubscribed.

**The record.** A new table, one row per dispute, keyed on the Stripe dispute id, holds:

- the payment intent and charge;
- the matched booking or tip, or neither;
- amount in cents and currency;
- Stripe's reason and status;
- the evidence deadline (`evidence_details.due_by`);
- opened and closed times and the outcome;
- when the reminder went;
- the Stripe `created` time of the last event applied.

How the record is written:

- Each event upserts the row from the dispute object the event carries. An event older than the last one applied changes nothing, so a redelivery or out-of-order delivery is harmless.
- The booking is matched through `proposal_payments` by payment intent, and a tip through `tips`.
- The table is written only by this handler and the reminder; no business table is written.
- Schema goes in `schema.sql` as idempotent statements.

**Alert at open.** The first insert sends one email through `notifyAdminCategory` with push on. Category `payment_failure` is my call: it already exists and reaches the admins subscribed to money trouble, and the lane checks that Dallas's account receives it. No SMS, per the standing email-over-SMS preference. The email carries:

- the booking id, event type label (`getEventTypeLabel`) and event date;
- the amount and Stripe's reason in plain words;
- the deadline as a Chicago date and time;
- a link to the dispute in the Stripe dashboard and a link to the booking.

**Reminder.** A daily job (a new scheduler with its `RUN_*` switch, or a pass inside an existing daily one; the builder's choice) picks up each dispute that meets all of these:

- it is still waiting on evidence by its stored status;
- its deadline falls within the next three Chicago days;
- no reminder has gone yet.

The job reads the dispute live from Stripe through `stripeClient.js`:

- **Still waiting on evidence:** it sends a second email and stamps the reminder.
- **No longer waiting** (evidence sent): it updates the row and sends nothing.
- **The read fails: it sends anyway (my call).** A spurious reminder costs one email, and a missed one cost $100 on booking 843.

"Waiting on evidence" means `needs_response` or `warning_needs_response`.

**Inbox.** A dispute on a booking is an Inbox item under that booking's client. It follows the menu-task precedent: a task item from its own reader, as `server/utils/inbox/readMenuTasks.js` does for menu proofs (spec 2026-10-19 section 13).

- **Shows:** what the email shows.
- **Open while:** Stripe says it waits on evidence.
- **When evidence is sent** (status `under_review`, through `charge.dispute.updated`), the item leaves the waiting list. That is my call: the Inbox is "waiting on you", and a dispute under review waits on the bank for up to two months.
- **When the dispute closes**, the item sits in the closed list the Inbox already keeps, marked won or lost.
- **AI:** dispute items never go to the Inbox AI read.
- **Legal hold:** a dispute on the legal-hold booking follows the Inbox's existing hold handling, as menu tasks do. The record and the email are still written, since neither touches the booking (money law 15).
- **Design:** the Inbox is a designed surface (`docs/design-artifacts/2026-10-06-inbox/`). The item uses the menu-task item's existing vocabulary, no new visual element, and the client review judges it against that artifact.

**A dispute with no booking.** A dispute on a tip, or on a charge the OS cannot match, gets the email (naming the tip, or only the Stripe ids) and the reminder, and no Inbox item. That is my call: tips are paid by guests who are not clients, so there is no client to file the item under.

**What the alert never does:** change `amount_paid`, status, invoices, autopay, payroll or the tip.

**Switch-on.** After the subscription, list disputes from Stripe once. Record any that are not closed and send their alert. The expected count is zero. Closed disputes (booking 843's two) are not backfilled.

### 5.8 No extras comp; a void moves the money onto the balance

Voiding an unpaid Drink Plan Extras invoice no longer lowers `total_price`. The void keeps the extras in the total, and the money moves onto the Balance: the void path calls `voidExtrasInvoiceWithReconcile` with `reconcileTotalPrice: false`, then `refreshUnlockedInvoices` and `createAdditionalInvoiceIfNeeded`, which is the sequence the add-to-balance resubmit already runs. That is what is left once the comp goes; it applies to every extras invoice, syrup-only included, since syrups are contract money after 5.1. The two other admin intents each have a path already:

- **Giving extras away:** a discount through the existing price adjustment (Dallas, 2026-11-18).
- **Taking an item off the booking:** cancel-line (`server/utils/lineItemCancel.js`), which keeps the total, the snapshot and `proposal_addons` together.

The panel copy near `ProposalDetailPaymentPanel.js:380` says so in plain words: voiding moves the extras onto the balance, and to give them away, add a discount. The `reconcileTotalPrice: true` branch loses its last caller; the builder removes it or leaves it refusing.

### 5.9 A hand-recorded partial payment mints the Balance invoice

After its invoice link, record-payment calls `createBalanceInvoice` when the booking is not paid in full, in the same transaction and under the guards the Stripe rails use. Those guards are idempotent on an existing Balance, and the helper stands down while an open Full Payment invoice already demands the remainder; the lane verifies the second guard on main before relying on it. A full record mints nothing.

## 6. Money laws touched

- **Law 5:** the "third kind" sentence. After this change it covers only an extras invoice whose stored fact says not folded: the legacy syrup-only rows minted before the switch. New syrups fold into `total_price`. Free-text invoices are contract money [Dallas 2026-11-18]. The provenance read becomes the stored fold fact.
- **Law 7:** the Drink Plan Extras and free-text reasons are rewritten to match.
- **Law 8:** unchanged. The paid flag stays the raw comparison, because the total now holds the syrups.

Each rewritten law gets a "Checked against code" line only after a verify pass reads it against the code.

## 7. Consumers to grep in the same change

Every reader of the extras label, `extrasLinesAreFolded`, `sumOffContractPaidCents` and `offContractPaidCents`. On main today that is these files:

- `server/utils/invoiceExtras.js`;
- `server/utils/lineItemCancel.js`;
- `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`;
- `server/routes/invoices.js`;
- `server/utils/refundHelpers.js`;
- `server/routes/stripe.js`;
- `server/routes/drinkPlans/submit.js`;
- `server/routes/drinkPlans/lab.js`;
- `server/utils/autopayDurableCharge.js`;
- `server/scripts/backfillExtrasInvoices.js`;
- `server/utils/staleProposalSweep.js`;
- `server/utils/reads/proposalDetail.js`;
- `server/utils/proposalMoneyShared.js`;
- `server/utils/invoiceLifecycle.js`;
- `server/utils/drinkPlanExtras.js`;
- `server/utils/beoFinalize.js`;
- `server/utils/balanceInvoiceMonitor.js`;
- `server/routes/proposals/crud.js`;
- `server/routes/proposals/cancel.js`;
- `server/routes/drinkPlans.js`;
- `client/src/pages/admin/ProposalDetailPaymentPanel.js`;
- `client/src/pages/plan/steps/ConfirmationStep.js`;
- `client/src/pages/plan/PotionPlanningLab.js`;
- `client/src/pages/admin/proposalEditor/repriceSummary.js`;
- `client/src/utils/editSheetView.js`.

Known to change behavior:

- **The Enhancement Lab's uninvoiced remainder** (`lab.js`, near line 429) excludes every Drink Plan Extras invoice from its subtractions, on the premise that "pay-now extras are additive money that never enters total_price". That premise is already false for add-on extras and becomes false for all of them. The remainder must subtract folded extras invoices, locked and open, like any contract invoice, or a lab round on a paid booking bills the extras again.
- **The header notes** that state the old premise must be rewritten, so the next reader is not misled: `invoiceExtras.js`, `submit.js` (the fast-path comment), `refundHelpers.js` (near lines 556 and 691) and `balanceInvoiceMonitor.js` (near line 80).

## 8. Out of scope, with reasons

- **The add-on half of the pay-now pricing mismatch (audit PRC-03).** Making the add-on charge equal the fold's movement runs into the fold's full catalog recompute (law 4). It wants its own design with the law-4 fold fix (shape (b) of 5.1), not a rider here.
- **An open hand-made invoice beside an open Balance.** The Balance refresh does not subtract an open free-text invoice, so both can demand the same contract money until one is paid. This exists today independent of this change, needs one rule across autopay, the Balance refresh and the reminders, and production has no open free-text invoice. It is reported for the owner's list.
- **The dispute money ledger and the tip clawback switch-on:** non-goals by Dallas's call.
- **Bookings 599 and 843:** untouched.

## 9. Rollout

1. The lanes ship through `npm run ship`. The dispute handler is inert until Stripe sends the events.
2. With Dallas's yes at the time (a live Stripe config change), add the three dispute events to the live endpoint, keep the existing eight, and read the list back.
3. Switch-on read of open disputes (5.7).
4. After the syrup and hand-made lanes ship: a read-only production check that bookings 599, 596 and 789 read the same overpayment as before.

## 10. Lane sketch (the plan decides)

1. **Syrups join the total:** 5.1 to 5.4, the stored fact and its backfill, the lab remainder, laws 5 and 7 for extras. Money; full review.
2. **Hand-made invoices are contract money:** 5.5, 5.6 and laws 5 and 7 for free-text. It shares `sumOffContractPaidCents` and the law text with lane 1, so it comes after lane 1 or merges into it.
3. **The chargeback alert:** 5.7, the schema, the handler, the reminder, the Inbox reader and item, the email. Touches no money path; webhook and provider review.
4. **No extras comp, and the recorded deposit:** 5.8 and 5.9. After lane 1, since the void's meaning depends on syrups being folded. Money; full review.

## 11. Left to the builder

- the mechanism of 5.1 within its constraint;
- the stored fact's shape;
- the dispute table's name and columns beyond the list in 5.7;
- where the daily reminder runs;
- the email and Inbox copy (no em dashes);
- whether the dead comp branch is removed or refuses;
- the test plan per lane, which must include: the drift case of 5.1; the pack case of 5.2; add to balance billing syrups; pay everything not charging the syrups twice; the lab remainder on a paid booking with folded extras; an out-of-order dispute event; the reminder on a Stripe read failure.
