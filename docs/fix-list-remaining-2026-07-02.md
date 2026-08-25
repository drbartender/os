# The Backlog — work still owed

**Restructured 2026-08-23.** This file is now a LEDGER, not an archive. It holds work that is
still owed and nothing else. Every entry that was already done, already decided, or already
shipped was deleted, along with the provenance of how it got that way.

**The full prior text (6,632 lines) is at `4d674da4`.** Nothing was lost; it was moved to where
finished things belong. `git show 4d674da4:docs/fix-list-remaining-2026-07-02.md` reads it back.

### The rule that decides where an entry lives

**Above the divider: it can bite.** A wrong number, a wrong charge, a broken client-facing
surface, or a message reaching the wrong person. Bartenders count as people who get bitten, so
payroll and gratuity sit up top with the client-facing defects.

**Below the divider: everything else.** Real work, still wanted, but it only costs us time or
tidiness. Things a review fleet raised and Dallas waved past at push time land here BY DEFAULT
and only cross above if they can bite. That is what keeps the top of this file short enough to
be worth reading.

Deletion is the normal end of an entry. When something ships, or gets decided against, take it
out — git holds it. Do not leave it struck through, and do not write the story of how it was
fixed. The one exception is a decision people keep re-raising: those live in **Settled** at the
bottom, in one line each, because their whole job is to stop a lane being opened.

### Standing guards, before anything else

- **Proposal 600 is a LEGAL HOLD (Dallas, 2026-08-11).** Its unpaid balance, `confirmed` status
  and still-`open` shift 348 stay EXACTLY as they are. Do not archive it, reap or close its
  shift, void or re-send its invoice, chase the balance, or include it in any sweep or
  reconciliation. Its current state may be evidence. It is named here only so nobody fixes it.
- **A dev refund is a REAL refund.** This box talks to live Stripe by design (see Settled). Never
  rehearse a charge, refund or payment link on dev as a stand-in for prod.
- **Re-grep before surgery.** Line numbers in this file rot. Cite by shape, verify before acting,
  and read the linked code rather than trusting a citation.
- Owed *walkthroughs* live in `docs/walkthroughs-owed.md`. Lane state lives in
  `docs/build-board.md`. Neither belongs here.

---
---

# ▲ OWED — these can bite

Ordered by how close each one is to actually costing money or a client.

### The whole ledger, one screen

| # | what breaks | reachable today? |
|---|---|---|
| 1 | **The consult cap does not bound the rings to Dallas** | no — SHIPPED DARK; live the moment the switch flips |
| 1 | Refunding an overpayment shrinks the contract instead of clearing it | no (0 overpaid rows) |
| 1 | An additional invoice bills money DRB already holds | yes, on an overpaid proposal |
| 1 | Invoice line items do not add up to the invoice total | **yes, on any override'd proposal** |
| 1 | A tip refund has no gratuity scope, so cancel-line can offer it twice | no (0 proposals carry BOTH an override and gratuity) |
| 1 | A client drink-plan submit re-prices add-ons at TODAY's catalog rate | **yes** |
| 1 | A client drink-plan submit resets an admin-negotiated quantity | not via the planner UI |
| 1 | The client-portal change-request preview under-quotes counts > 1 | **yes** |
| 1 | Deselecting a contracted syrup shaves the negotiated contract | no (1 such row, prop 527, completed + past) |
| 1 | A forfeited retainer leaks into a second cancellation's refund cap | yes, on a re-cancel |
| 1 | Free-text invoice labels netted out → under-refund | no (547's invoice is VOID; 596 is completed) |
| 1 | A cancel-line destroys the marker two money readers depend on | no (both paid extras invoices are locked) |
| 1 | `additional-bartender` latches at 2x | no — trigger is a `minimum_hours` on that row |
| 1 | The webhook sets `amount_paid` without checking what Stripe captured | yes |
| 1 | A concurrent payment links the wrong row to the invoice | yes, under concurrency |
| 1 | Clearing a sub-$50 mandate orphans a bartender's gratuity | no (1 mandate, at exactly $50, archived) |
| 2 | The emailed compare link still lands on the old page | **yes — 9 of 13 groups never chose** |
| 2 | The sign 409 still says "already been accepted" for an archived proposal | yes, from a tab open before the sweep |
| 2 | The planner quotes pre-batched at a rate it does not bill | **yes** |
| 2 | The v1 planner under-quotes parking | **yes — v1 drafts still live** |
| 2 | A client's line item renames itself on a no-op fold | yes |
| 2 | The compare card jumps on the client's first tap | no (0 affected rows) |
| 2 | The shopping list says to buy a syrup DRB is supplying | yes — **PARKED by Dallas** |
| 2 | Signed documents do not say who is covered | yes — **blocked on the broker** |
| 3 | An unsubscribed lead can be resurrected by capitalisation | yes |
| 3 | A campaign keeps mailing someone who unsubscribed mid-send | yes, on a long send |
| 3 | CSV lead import loses rows and reports success | yes |
| 3 | A caller can hit silence, or "an application error has occurred" | yes |
| 3 | Nobody has listened to the nine voice mp3s | unknown — that is the point |
| 3 | A placed-but-carrier-failed lead call is a quiet miss | yes |
| 4 | The next-shift card and the CANT/CONFIRM text can name different shifts | **YES — shift 353, upcoming 10/16, 2 approved staff** |
| 5 | `applyPackageLineup2026` cannot run — two gates open | blocks the run |
| 5 | Thumbtack first reply owes its next-real-lead proof | blocks trusting the pipeline |

---

## 0. Before `CONSULT_CALL_ENABLED` is flipped on

The consult call bridge shipped to prod on 2026-08-25 (`650e5a66`) **dark**, with
`CONSULT_CALL_ENABLED=false` set in Render first. Everything here is unreachable while it stays
false, and all of it becomes live the moment it is flipped. The push fleet raised these; none
blocked the deploy, all of them gate the launch call. Delete this whole section once the switch
is on and these are closed.

### The daily cap does not bound the rings to Dallas, only the Manila legs

**Two independent reviewers found this separately** (the Claude toll-fraud lens and the gemini
cross-LLM pass), which is why it is stated first. `CONSULT_CALL_DAILY_CAP` counts
`status NOT LIKE 'skipped%'` (`consultCallChain.js:259-261`). A cancel or reschedule while a
chain is ringing lands it in `skipped_cancelled` (`:818-824`), which stops counting and frees the
slot. So book a public Cal.com slot, let it ring, cancel, rebook the same slot inside its open
window, repeat. Each cycle costs up to 3 billed US legs and the cap never advances.

The only code ceiling is the sweep's `FIRE_LIMIT = 20` per 60s tick (`consultCallSweep.js:52`),
i.e. 28,800 legs/24h in theory; a 15-minute-granularity 12-hour booking page yields roughly
**600 to 900 rings per day** on Dallas's Google Voice. The international legs and the texts ARE
genuinely bounded at 10, because every chain that reaches the VA leg terminates in a counted
status. Nothing in this repo asserts or verifies Cal.com's own booking limits, which are the only
real throttle today.

Note the free-the-slot behaviour is DELIBERATE (ruling R15: counting skipped rows would let junk
bookings hold the feature down for 24h). The defect is that nothing else bounds the dial count.
Suggested shape: a second rolling-24h counter over PLACED legs (rows with `admin_call_sid IS NOT
NULL`, or all rows regardless of prefix), checked inside `advanceChain` before the admin claim.
That keeps R15 and still caps the dialing.

**Also correct the comments.** `openChain`'s docstring (`:236-243`) calls the cap "a toll-fraud
BACKSTOP that bounds sustained spend", and the file header (`:29-30`) states the worst case as
"30 rings to Dallas, 10 international legs and 10 texts". Both describe the no-cancellation case.
CLAUDE.md's env table is accurate; the code comments are not, and they are what a maintainer
raising the cap will read.

### A real client's consult can be silently cancelled by someone else's booking

`consultCallChain.js:344-378` marks every OTHER upcoming `scheduled` consult sharing a
`booker_email` as `skipped_cancelled`, and only emails when more than one row was marked. The
single-row case is exactly "the victim had one real consult", and it is a log line only. Reachable
benignly (a reschedule payload with no resolvable old uid, which `calcom.js:464-472` exists
because it happens) and abusively (book on the public page using a known client's email, then
reschedule). The client waits for a call that never comes and nothing tells anyone. In a feature
whose declared failure mode is silence, the one-row case is the one that must email.

### `extractRescheduleOldUid` may be reading the wrong Cal.com field

`calcomWebhookHelpers.js:34-40` accepts `payload.rescheduleId`, which in Cal.com is a NUMERIC
booking id, not the uid string stored in `calcom_event_id`. If a real payload carries only that
key, every reschedule takes the unresolved-old-uid fallthrough and the entry above fires on every
one of them. Confirm against a real `BOOKING_RESCHEDULED` payload before the launch call: this
single question decides whether the previous entry is rare or routine.

### The strand-heal can duplicate a consult and silence the real one

`calcom.js:86-125` deletes the webhook dedupe row and fully reprocesses whenever a redelivered
event's `payload.uid` is absent from `consults`. But `handleRescheduled` RENAMES
`calcom_event_id` old to new, so after a reschedule the old uid is legitimately gone. A Cal.com
redelivery of an already-acked event (a manual resend, or at-least-once duplication) then creates
a DUPLICATE `consults` row at the abandoned slot, which the sweep will ring, while the tail marks
the client's genuine consult `skipped_cancelled`. Pre-existing mechanism, newly consequential
because it now opens call chains. Fix shape: gate the heal on no `consults` row sharing that
booker and slot, or record the resolved `consult_id` on the `webhook_events` row so "moved" is
distinguishable from "never written".

### Smaller, same gate

- The kill switch does not gate press-1 (`voiceConsultCall.js:237-306`): flipping it off mid-ring
  still permits one billed client leg.
- Neither dial target is format-validated (`consultCallChain.js:724-725`, `:833`) though
  `sendMissedText` validates its own destination and `index.js` format-checks the caller ID.
- `VA_CELL` can reach the database: `consultCallChain.js:590-595` writes `err.message` into
  `detail` when a throw carries no `.code`, and Twilio-adjacent messages embed the `To` number.
  CLAUDE.md says that number lives in env only, never on a DB record.
- `connected` is terminal and never reaped (`vaCallingScheduler.js:128`), so a `<Dial>` that fails
  at Twilio for want of a caller ID leaves the row settled-looking forever with no alert.
- The reaper rides `RUN_VA_CALLING_SCHEDULER` (hourly) while the sweep rides
  `RUN_CONSULT_CALL_SWEEP_SCHEDULER`. Sweep on with VA off strands `calling_*` rows that hold a
  cap slot for 24h with no email.

---

## 1. Money paths that produce a wrong number

**Read this first — it is the root cause of the two entries beneath it.** An invoice does not
record whether its money is inside `proposals.total_price`. Every classifier is therefore a
proxy, and three different implementations have each been wrong on a different real prod row.
The fix that closes both at once is a boolean set at mint time by each of the six `createInvoice`
callers, plus a hand backfill of the few ambiguous existing rows; `sumOffContractPaidCents`
then becomes a single column read, correct by construction. Same root cause as the pulled
invoice-derivation rewrite — **do them together, provenance first.**

### Refunding a true overpayment shrinks the contract instead of clearing it

REAL, unfixed, and **do not re-attempt naively.** Refunding an overpayment lowers `total_price`
AND `amount_paid` by the same amount, so the proposal stays overpaid by exactly the same figure
and the contract silently shrinks on every attempt. Measured: total 2300 / paid 2500, refund
$200 → total 2100 / paid 2300, still overpaid $200.

A fix was written and REVERTED before shipping. It derived the excess as
`amount_paid - total_price`, which is wrong in this schema: Drink Plan Extras (syrup-only
pay-now) and manual-label invoices roll into `amount_paid` and never into `total_price`, so the
difference counts them as overpayment and subtracts them twice. Two reviewers reproduced it — a
$150 goodwill refund on a 2000/2150 proposal left the total at 2000 instead of 1850, and a $1100
refund on a deposit-stage 1000/1300 proposal left a $100 phantom balance the autopay scheduler
would have charged. It also made the multi-split loops order-dependent.

**Half the fix is already on the shelf and wired to the wrong path.** The netting term EXISTS —
`sumOffContractPaidCents` (`invoiceExtras.js:340`) — and is verified wired ONLY into cancel-line's
`overpaymentCents` (`lineItemCancel.js:701`). The payment-panel refund path still issues
`'contract'` scope and still shrinks the total.

Candidate fix: net out still-outstanding non-contract invoice money before deriving the excess,
read BEFORE the invoice walk decrements it. Verify against the multi-split loops in
`proposals/cancel.js` and the cancel-line route for order-independence, and against the RC1
fixtures in `refundHelpers.scope.test.js`.

Prod exposure today is ZERO (the only proposal with `amount_paid > total_price` is a paid Drink
Plan Extras invoice, not an overpayment). **Related, same cause:** after a FAILED cancel-line
refund the dialog sends the admin to the payment panel, which can only issue `'contract'` scope
and would lower a total the fold already corrected. Until this is fixed, the safe recovery on
that path is a manual Stripe-dashboard refund; the `charge.refunded` webhook reconciles it.

### An additional invoice bills the client for money DRB is already holding

`invoiceLifecycle.js:339` computes `diffCents = newTotalCents - oldTotalCents` and passes it
straight to the invoice as `amountDueCents` (`:347`) with no read of `amount_paid`. On an
already-overpaid, fully-locked proposal that invoices the client for money we already have.
**Verified 2026-08-23**: the function is at `:339` and reads no `amount_paid`. (An earlier note
claimed this needed re-deriving because the citation was off; it was off by one line.)

### Invoice line items do not add up to the invoice total

`generateLineItemsFromProposal` is override-blind: it always itemizes from catalog, so any
proposal whose `total_price_override` differs from catalog gets an invoice with a correct total
sitting over line items that do not sum to it (Shiralee INV-0120: $450 of lines on a $270
invoice). Verified 2026-08-23: `invoiceLineItems.js` contains no `total_price_override` reference.

**Measured against prod 2026-08-25.** 38 proposals carry an override, 13 CC transfers and 25
native. Every affected invoice is NATIVE: 10 non-void invoices across 9 proposals. Nine of the
ten are Deposit invoices, where the $100 due is right and only the lines behind it show catalog
list; the tenth is Balance INV-0120. Widest spread is proposal 770, $1,100 of lines on a $425
contract.

**The CC tail is NOT part of this, and must not be "fixed".** All seven CC balance invoices sum
EXACTLY to their own `amount_due`, because `scripts/cc-balance-invoice.js` mints the shape by
hand. They sit $100 under `total_price` only because that is the CC deposit already sitting in
`external_paid`, carried on the invoice as a credit. Correct by construction.

Deliberately NOT fixed alongside the drink-plan money fix: every invoice flows through that
generator, so it is its own lane.

### A tip refund has no gratuity scope, so cancel-line can offer it a second time

Neither the payment panel (`stripe.js` refund route) nor cancel passes a gratuity scope into
`applyRefundReconciliation`; `gratuity_cents` on the refund row feeds only the payroll clawback.
A refund of the tip is therefore contract scope and lowers `total_price` and
`total_price_override` by the tip. Since client gratuity is re-derived from `gratuity_rate` at
every price, that is the only representation a later save leaves alone. The cost: a later
cancel-line "remove gratuity" on the same proposal (`lineItemCancel.js`, gratuity target)
re-prices to override + 0, reads the already-refunded tip as an overpayment, and offers it a
second time. The cancel-line preview shows the figure before anything moves, so it is loud, not
silent. Surfaced by the refund-override-sync review, 2026-08-25. Before that lane the same
two-step offered nothing and the next editor save minted the tip back as an invoice instead.

**NOT reachable today, measured 2026-08-25.** The bug needs one proposal carrying BOTH an
override and gratuity, and prod has zero: 15 proposals have gratuity, none of them override'd,
and none of the 7 refunds ever issued touched gratuity. It goes live the day a negotiated
override lands on a job that also carries a mandated tip.

Fix, and why it is NOT worth building yet (Dallas, 2026-08-25): a third `total_scope` value.
`proposal_refunds_total_scope_check` (`schema.sql:1179`) admits only 'contract' and
'overpayment', so this needs a CHECK change, which puts `schema.sql` in the diff and pulls the
full fleet plus the cross-LLM pass. Worse, gratuity is `round(rate * staffCount * hours, 2)`
(`pricingEngine.js:283`) with no stored dollar figure to lower, so the scope must either
back-solve `gratuity_rate` (lossy rounding, trips the `tip_jar OR gratuity_rate >= 50` CHECK,
and retroactively moves payroll, since that rate is what bartenders are paid from) or add a
stored gratuity-adjustment column that the pricing engine subtracts. Two of the highest-risk
surfaces in the codebase against zero current exposure.

### A client drink-plan submit re-prices add-ons at TODAY's catalog rate

Both the submit and lab upserts recompute `line_total` from `service_addons.rate` rather than the
rate frozen on the row, so a catalog price rise reaches proposals that were sold at the old price.
Pre-existing; the 2026-07-26 lane only stopped the row's `rate` column from disagreeing with its
own `line_total`.

### A client drink-plan submit can reset an admin-negotiated add-on quantity

The upsert loop in `submit.js` honors any active slug in the client payload
(`return true; // user-added addon`) and its `ON CONFLICT DO UPDATE` overwrites `quantity` with
the count it computed for one unit. A payload naming a slug an admin had set to 3 knocks it back
to 1. Not reachable through the planner UI today (it offers no staffing add-on).

### The client-portal change-request price preview under-quotes

`changeRequests.js:81` re-prices existing add-ons with `safeAddonQty(quantities[id])`, which
returns 1 for `undefined`, so a preview silently drops any count above 1. Verified still routed
through `safeAddonQty` rather than `addonQuantity.js` on 2026-08-23. The `buildDiff` half is
unreachable today (the v1 client form exposes no add-on editing) but the preview half is not.
Fix is the same one: route it through `addonQuantity.js`.

### Deselecting a contracted syrup shaves the negotiated contract

Drink-plan submit prices `catalogAfter` from the client's current selection while `catalogBefore`
carries the snapshot syrups, so a contracted syrup the client drops without marking it
self-provided yields a negative delta and reduces `total_price_override`. Same "client mutates
the negotiated contract" invariant the 2026-07-16 fix protects, opposite direction.

Unreachable on live data today (0 override'd proposals carry snapshot syrups) and
reduction-only. Ready fix: price `catalogAfter` syrups as `preSyrupsPriced ∪ net-new` so
contracted syrups are neutral to the delta. **Fold into the planner rework** rather than fixing
contract semantics in code that is about to change.

### A forfeited retainer can leak back into a second cancellation's refund cap

After cancel → refund → restore → re-book → re-pay → re-cancel, the second cancellation's
snapshot is computed from a gross SUM of all succeeded payments (refunds never demote payment
rows), so the forfeited cycle-1 retainer partially raises the cycle-2 cap. Visible in the preview
before money moves. Snapshot-per-cycle or a payment-row demotion closes it.

### Free-text invoice labels carrying contract money are netted out (under-refund)

`invoiceExtras.IN_TOTAL_PRICE_LABELS` is a closed list of the five labels code generates, but
`POST /api/invoices/proposal/:id` writes `label.trim()` with no constraint and
`PATCH /api/invoices/:id` can rename any unlocked invoice. Both free-text-labelled PAID invoices
in the entire prod ledger are contract money (`INV - Balance` $250 on prop 596; `Gratuity Balance`
$100 on prop 547), so the base rate of "bespoke label ⇒ off-contract" is 0 for 2.

**Becomes live the moment someone pays prop 547's $100.** 596 is `completed` so cancel is
blocked, and the netting only counts `amount_paid > 0`.

### A cancel-line destroys the marker two money readers depend on

`lineItemCancel.js` step 6 replaces an unlocked `sent`/`partially_paid` Drink Plan Extras
invoice's line items with one synthetic `source_type: 'manual'` line whenever its amount moves,
deleting the `source_type = 'addon'` / bar-rental rows. Those rows are the ONLY record of whether
that invoice folded into `total_price`, read by `extrasLinesAreFolded` for the netting AND by
`voidExtrasInvoiceWithReconcile`'s comp reconcile. The deletion is committed, so one cancel-line
misclassifies that invoice permanently in both consumers. Not reachable on any current prod row.

### `additional-bartender` latches at 2x the moment its catalog row gets a minimum

Latent, and the trigger is a single column. **The drift check, which is also how you re-verify
this:**

```sql
SELECT slug, billing_type, minimum_hours FROM service_addons WHERE minimum_hours > 0;
```

Today that returns exactly two rows, `banquet-server` and `barback`, both `per_hour` and both
`4.0`; `additional-bartender` carries none, which is the whole trigger condition. Those two are
NOT at risk — `effectiveHoursFor` (`addonQuantity.js:59`) applies `max(hours, minimum_hours)` to
every per_hour slug EXCEPT `additional-bartender` (`:58`), so reader and writer agree on them.
The same query is the drift check for `eventCreation.js:46`'s hardcoded
`STAFFING_ADDON_MIN_HOURS = 4`, which is correct only while those two rows read exactly 4.0.

If `additional-bartender` ever acquires a minimum: 2-hour event, one bartender, minimum 4 — the
pre-fold write stores 4, the fold recovers 4/2 = 2, the engine bills two bartenders, the post-fold
re-sync persists 2×2 = 4, and the row **latches at two permanently**. The dollar figure is the one
place it does not announce itself (four bartender-hours is what a 4-hour minimum was asking for),
so the damage lands in the staffing channels: gratuity staff count doubles,
`eventCreation.addonHeadcount` reports two bartenders, and `syncShiftsFromProposal` creates a
second shift for a one-bartender order. The trigger has precedent — `schema.sql:777` is literally
`UPDATE service_addons SET minimum_hours = 4 WHERE slug = 'banquet-server';`.

Fix, and the reason this is logged rather than patched: a shared `countToStored` inverse living
beside `storedToInputCount` in `addonQuantity.js`, called by the two pre-fold writers
(`drinkPlans/submit.js`, `drinkPlans/lab.js`) in place of `calculateAddonCost` for that slug. A
fourth local patch is how the definitions drifted apart in the first place. The cancel-line
write-back (`lineItemCancel.js:518`) is the same family and closes with the same inverse.

### Paying in full on a deposit-terms proposal strands the remainder off the invoice ledger

Found 2026-08-25 chasing Meg Henke (proposal 770). She is genuinely paid: Stripe captured
$425, `proposals.amount_paid` = 425, status `balance_paid`. But her only invoice is the
`Deposit` row at $100 due / $100 paid, so $325 of collected money has no invoice.

Mechanism. `createInvoiceOnSend` mints the label from `payment_type` AT SEND TIME, so a
deposit-terms send gets a `Deposit` invoice fixed at `deposit_amount`. When the client then
picks pay-in-full at checkout, `stripeCreateIntent.js:222` flips `proposals.payment_type` to
`'full'` but never re-shapes the already-minted invoice. The webhook credits the proposal
correctly, then the label-blind fallback (`paymentIntentSucceeded.js:~600`) links the whole
capture onto the only open invoice; `linkPaymentToInvoice` caps the credit at remaining due
and drops the rest. Nothing mints a row for the remainder either, because
`createBalanceInvoice` is gated on `paymentType === 'deposit'`.

The cap is CORRECT and must stay — it is the seam-sweep M1/M2/L2 guard (`a3e2236b`,
2026-07-02) that stops a stale intent overfilling an invoice. Before it, this same flow
overfilled the Deposit row ($100 due / $425 paid), which kept the ledger TOTAL right by
accident. The cap turned a cosmetic overfill into a real gap. Fix upstream, not at the cap:
on the deposit→full upgrade, either relabel/re-amount the open Deposit invoice to
`Full Payment` at `total_price − external_paid`, or drop the `paymentType === 'deposit'`
gate so a `Balance` invoice mints for the remainder.

Blast radius: 13 proposals since 2026-07-02, ~$4,605 of collected money missing from the
ledger. 770 Meg Henke $325 · 767 Karen Habenicht $200 · 713 Anthony Holter $250 · 675 Angelo
Corso $250 · 674 Raizl Lifshitz $300 · 666 Jelena Pesoli $600 · 660 Laura Millies $300 ·
659 Jason Fowler $350 · 635 Andrea Ashford $300 · 633 Dora Travaglio $380 · 625 Allyson
Gietl $350 · 623 William Buchar $750 · 573 Aaliyah Gaston $250. Needs a backfill alongside
the code fix. (The OTHER ~18 proposals with a proposal-vs-ledger gap are the
`external_paid` CC-transfer cohort — documented, different, leave alone.)

NOT affected, verified in code: payroll (the fee numerator's
`GREATEST(0, pp.amount - links.linked_cents)` term for `deposit/balance/full` explicitly
recovers the unlinked remainder, so gratuity fee-netting is right); client-portal outstanding
balance (`clientPortal.js:56,130` read only `sent`/`partially_paid`, and these Deposit rows
are `paid`, so clients correctly show $0 owed); proposal-level money, which stays
authoritative. What IS wrong: the invoice/receipt record documents a $425 payment as a $100
deposit, and a refund on any of the 13 walks only the linked $100 at the invoice level.

Sentry has been reporting this since July — `DRBARTENDER-SERVER-1E`
`invoice_link_overflow_capped`, 6 events in 90d, including 16:44:36 on 2026-08-25 which is
Meg's exact payment. Do not resolve that issue as noise; it is the tripwire for this bug.

### The webhook trusts its own math over what Stripe actually captured

The proposal settle branch sets `amount_paid` without asserting `session.amount_total` matches.
The TIP branch does guard (`checkoutSessionCompleted.js:80`); the proposal branch does not.

### A concurrent payment links the wrong row to the invoice

`actions.js:294` re-reads the just-inserted payment via
`SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1`
instead of `RETURNING id` on the INSERT. Verified still present 2026-08-23. Under concurrent
inserts that links the wrong payment row to the invoice. One-line fix; ride it along with the
payment-history surface below the line.

### Clearing a sub-$50 gratuity mandate orphans money the bartender never receives

In `paymentIntentSucceeded.js` the apply-time floor check reads the CURRENT row floor, not the
floor the PaymentIntent was created under. Sequence: admin sets a mandate BELOW $50/staff/hr, the
client elects "skip the tip jar" at exactly that mandate (legal — the amended CHECK's third
disjunct exists for this), the admin clears the mandate while the client holds a live intent, and
the client pays. `rowFloor` is now 0, the legacy `tip_jar OR rate >= 50` rule fails the sub-50
no-jar election, and the gratuity is skipped as `below_floor`. The client is charged the
gratuity-inclusive amount, `total_price` has already dropped, and payroll's `extractGratuityCents`
finds no Gratuity line: **DrB holds gratuity money the bartender never gets.**

Not silent (fires `warnGratuityApplySkipped('below_floor')` to Sentry) and not currently
reachable — prod has zero mandates, and a mandate at $50/staff/hr or above is immune. Only a
sub-$50 mandate is exposed. Candidate fix, deliberately not decided at push time: when no mandate
remains and the only failing rule is no-jar/sub-50, honor the dollars the client actually paid
and apply with `tip_jar` forced true. Needs a test and changes a pinned skip-reason, so it wants
its own small lane.

---

## 2. Wrong on a surface a client is looking at

### The emailed compare link still lands on the old page

`proposalSendGroup.js:108` emails `compareUrl = /compare/{group_token}`, which routes to
`ProposalCompare` → `PackageMatrix` (verified 2026-08-23: `ProposalCompare.js:105` still renders
it). `PackageMatrix.js:138` renders every cell as `items.join(', ')` and nothing marks
differences. The difference-marking panel that fixed "the list is run together and hard to
compare" shipped on the INDIVIDUAL proposal page only, so a client sent three alternatives lands
on the old surface.

Prod context: 13 option groups exist, none ever exceeded 3 options, 4 converted and **9 are still
sitting at sent/viewed with no choice ever made.** Causation unproven; the correlation is the
whole reason this was raised. Remaining work is one surface: bring the emailed group link to the
shipped panel, or port the panel's difference-marking into `PackageMatrix`. `?choose=1` and both
redirect effects are load-bearing and untouchable.

### The sign 409 still tells an archived client their proposal was "already accepted"

The render half of the archived door-close shipped 2026-08-25; this is the half that did not, and
it is recorded rather than quietly dropped because the original entry prescribed both.
`publicToken.js` still throws the generic `ConflictError('This proposal has already been accepted',
'ALREADY_ACCEPTED')` when the sign UPDATE returns no row, and the UPDATE's
`status NOT IN (…,'archived')` guard is one of the ways it returns no row.

Still reachable even though the page now 404s: a client with the tab already open when the hourly
sweep archives their proposal keeps a live Sign & Pay button, submits, and is told they already
accepted something they did not. Fix is reason-aware copy on that branch — distinguish
genuinely-already-accepted from archived, and for archived say the quote is no longer current.

### The planner quotes a pre-batched flavor at a rate it does not bill

`HostedDrinksV2.js:248` hardcodes "One flavor comes pre-batched at **$2.00 per guest**" while
billing uses the live `service_addons.rate`. Verified 2026-08-23. Carry pair rates in the
`hosted_coverage` payload and render from data.

### The v1 planner under-quotes parking

`LogisticsStep.js:41` computes `staffCount = (numBartenders || 1)` and previews
`rate × bartenders`, while the server bills `per_staff` over ALL staff (bartenders +
additional-bartender + barback + banquet-server). Verified 2026-08-23. Live-reachable — prod still
carries v1 draft/pending plans (plan 69 / proposal 472 showed $40, billed $60). One-line fix. This
was already ordered in the 2026-07-01 pay-now-extras spec and never shipped.

### A client's line item renames itself

`REPRICE_ADDON_SQL` (`proposalExtrasFold.js:59`) selects `sa.*, pa.quantity, pa.line_total,
pa.rate, p.event_duration_hours` and **not** `pa.variant` — verified 2026-08-23. So a no-op fold
drops the variant from `snapshot.addons[]` and a `champagne-toast` sold as
`non-alcoholic-bubbles` reverts to "Champagne Toast" on the client-facing snapshot; the next
writer then persists `variant = null` off that snapshot. No money moves. The fix is one column in
a SELECT.

### The compare card jumps on the client's first tap

The current option shows `total_price` verbatim on first load and an engine price after any
selection change, so when those disagree the "Yours" card moves and every "$X more than yours"
delta shifts with it. They disagree only when the stored total was not produced by today's engine
(a legacy null `pricing_snapshot`, or a catalog rate edited after the quote went out). **Prod has
ZERO affected rows today**; dev has two April rows.

Fix: anchor on the contract —
`total_price + (engine price of selection − engine price of stored selection)` — so the number
only moves by what the client changed. Related: the BYOB tier strip under the card is always
engine-priced, so on a BYOB current proposal the same drift shows as the card and its selected
tier disagreeing.

### The shopping list tells a client to buy a syrup DRB is supplying

**PARKED 2026-08-20 by Dallas: "gonna take a lot of brainstorming and rethinking from me... lets
keep putting that one off." Do not open a lane for this without him.** The diagnosis is verified
and is not what the original framing said.

The MONEY path already cross-checks in both places (`invoiceExtras.js:96-99` and
`drinkPlanExtras.js:81-84` each filter out syrups already on the proposal), so nobody is
double-charged. The SHOPPING LIST does not: `addSelfProvidedSyrups` (`shoppingList.js:344`)
pushes every self-provided syrup onto `everythingElse` unconditionally with no reference to
`proposalSyrups`. A client who marks a syrup self-provided that DRB is also comping is told to go
buy it. Procurement defect, client-facing, zero money exposure.

Second, narrower defect in the same function: it lacks the duplicate-name guard its immediate
sibling has at `:339`, so a syrup already on the list from another path is pushed twice. Note
`shoppingListGen.js:390-401` handles the same input separately — check both when fixing; they are
not copies of one function.

### Signed documents do not say who is covered

Three copy changes, each to a document a real person signs or receives. **Blocked on Dallas
confirming the coverage position with the broker in writing** — the exact wording should follow
that answer rather than lead it.

- **Event services agreement** (master contract at sign-and-pay): bar service runs to the
  contracted end time, additional service time is arranged through Dr. Bartender, and service
  arranged privately with a bartender is not covered by DRB's $2M liquor liability policy.
- **Pre-event client email**: one sentence of the same, arriving before the event rather than
  during it.
- **Contractor agreement**: the staff-side mirror — serving past the contracted end time without
  a system greenlight is not DRB work and is not covered, and bartenders may not accept payment
  directly from a client for service time.

The service-extension spec puts the insurance sentence on the client's extension terms screen and
in the staffer's decline text, but both only reach someone who already came to the system. The
client who was always going to hand a bartender $60 in cash never opens either one.

---

## 3. Messages that vanish, double, or reach the wrong person

### An unsubscribed lead can be resurrected by capitalisation

`idx_email_leads_email` is UNIQUE on raw `email`, not `LOWER(email)` (verified `schema.sql:1522`),
so case-variant rows for one address coexist and the "can't resurrect an unsubscribed lead" guard
is defeatable via any uppercase-stored row. Normalize the column and retarget the index and
`ON CONFLICT`s together. Also dead in the same upsert: `COALESCE(email_leads.name, EXCLUDED.name)`
never fires (`name` is NOT NULL), so an 'Unknown' from capture-lead is never upgraded to a real
name.

**Same family:** the sequence drip gates only on its own row's `status='active'` while campaigns
suppress by normalized address, so a case-variant twin keeps receiving drip after the webhook
flips one row. Gate the drip through the shared `leadUnsubscribedByEmail`.

### A campaign keeps mailing someone who unsubscribed mid-send

`marketingSend.js` resolves the mailable set once at run start (`resolveRecipients` at `:252`) and
the per-recipient loop does not re-check. At 600ms pacing a large send is a multi-minute window.
The per-recipient claim moment could re-check the two shared suppression helpers cheaply.

### CSV lead import loses rows and reports success

`emailMarketing/leads.js:130-166`: the per-row catch sits inside one transaction, so a genuine row
error aborts it, every later row fails 25P02, COMMIT silently rolls back, and the response still
reports `imported > 0`. The same block echoes raw Postgres error text (constraint and column
names) to the admin. Per-row savepoints, or batch-validate first.

### A caller can hit silence or "an application error has occurred"

- **A failed `<Play>` fetch is silence.** Twilio skips a `<Play>` whose fetch fails, and nothing
  validates an override URL at boot or at request time. A 404, a timeout, non-audio,
  `voiceAssets.js`'s own 500 path, or its 300/min limiter all produce a greeting-shaped hole.
  `voiceAssets.js` concedes this in its own comment.
- **A bare 403 on the caller-facing action URL.** `voiceEscalate.js:113` answers a signature
  failure with `res.status(403).send('Invalid signature')` (verified 2026-08-23). `voice.js`
  spells out three lines away why that is wrong on a caller path — Twilio plays "an application
  error has occurred" on a non-2xx from an action URL — and builds a TwiML-returning limiter
  handler for exactly that reason. Fix is the shape `voice.js` already uses. Changing what a
  signature gate returns is a security-gate change and belongs in its own deliberate lane.
- **Nobody has listened to the nine mp3s.** `defaultSaysOffer` is an assertion about AUDIO that no
  test can check; only the synthetic mirrors are pinned byte-for-byte. **If a NIGHT recording says
  "press one", the press-1 trap is live today with no env var involved.** That is a listen, not a
  grep, and it is the strongest argument for the press-1 walk.

### A lead that Twilio placed but the carrier failed is a quiet miss

A VA leg Twilio PLACED that reports terminal `CallStatus='failed'` (a known PH-route quirk)
classifies as a quiet 'missed' — no alert, not in the attention feed. So a lead goes uncalled and
nothing says so. Option: treat agent-leg 'failed' as fault-class, or include
`va/admin_call_status='failed'` in the feed WHERE.

---

## 4. Staff-facing

### The staffer's next-shift card and their CANT/CONFIRM text can name different shifts

**REACHABILITY FLIPPED 2026-08-25.** This was parked on "0 overnight rosters" and that count has
changed: prod now has two shifts whose `end_time` is before their `start_time`, and shift **353**
is UPCOMING (2026-10-16, 8:00 PM to 12:00 AM, status `open`, **2 approved staff**). It was shelved
on a number, and the number moved.

`staffPortal.js` orders the staffer's own next-shift card by the end instant alone;
`findNearestApprovedShift` now leads its ORDER BY with a "not dated before today" tiebreak. Between
00:00 and about 08:00 Chicago the card can show LAST NIGHT's still-unfinished shift while a CANT
or CONFIRM acts on TONIGHT's. **The CONFIRM case is the sharper one:** the staffer reads "your next
shift: A", texts CONFIRM, and `acknowledged_at` lands on B.

Reachability against prod: currently ZERO — no staffer holds a live approved shift whose end
instant crosses midnight. It becomes reachable the moment anyone is approved onto the one
overnight-wrap shift or a future NULL-end evening one.

**Dallas's call, and it is a product decision, not a mechanical fix.** Either make them match (two
lines, `chicagoTodayYmd` is already imported there), or keep the divergence and write down why —
the read path arguably SHOULD show the shift you are standing in. Recommendation: make them match.
The card is labelled "next shift", not "current shift", and stamping `acknowledged_at` on a shift
the staffer was not shown is wrong under either reading. `staffPortal.js` is sensitive-listed and
money-adjacent, so this gets the full fleet.

---

## 5. Gates blocking a prod run

### `applyPackageLineup2026` cannot run yet — two gates open

The recipe gate CLEARED 2026-08-19. Two remain, and both put wrong information in front of a
client if the script runs as-is:

1. **The `includes` prose is never written.** The script changes package contents but has no
   `includes` write, and four public surfaces serve `service_packages.includes` live (proposals
   publicToken/getOne/public + clientPortal) with no route able to write it. Running as-is leaves
   client-facing proposal and portal copy on the retired lineup (Dewar's / ginger-ale era) while
   the marketing site shows 2026. Also refresh the stale seed copy at `schema.sql` ~623-660.
2. **`C.red2` / `C.white2` point at inactive pars.** They name `pinot-noir` and `moscato`, both
   `is_active=false` in prod since 7/11 and both ABSENT from `BRANDED_PARS`, so the script neither
   creates nor reactivates them. They are used by The Grand Experiment and The Cultivated Complex
   on their Premium Red/White Wine categories. `buildCatalogSlices` drops inactive rows, so running
   as-is gives those packages `eligible_item_ids` pointing at nothing: **Cultivated Complex
   advertises two premium reds and two premium whites and would stock one of each, silently, with
   no error.**

   **Do NOT simply flip `is_active`** — both rows carry `in_full_bar=true`, so reactivating them
   as-is dumps 6 Pinot Noir and 6 Moscato onto EVERY BYOB shopping list (almost certainly why they
   were switched off). Correct fix is reactivate with `in_full_bar=false`, matching the convention
   the script already uses for its own 15 branded pars. **Owner call still open:** whether those
   two packages really pour a second red and white, and whether Pinot Noir / Moscato are the right
   varietals.

`migrateDrinkMeta.js` has no such gate. Both scripts are idempotent and snapshot/skip-guarded; dry
run first.

### The Thumbtack first reply owes its next-real-lead proof

The Clear-control dependency was fixed and is live on the box (`clearComposer()` falls through when
no labeled control exists; the read-twice empty proof and the strict `boxText === ''` send verify
are untouched). Agent tests 8/8, service restarted on the new code. **What it owes is the next real
lead.** Until that lands, do not trust the pipeline. `DRBARTENDER-SERVER-22` (AggregateError on
`pending-first-replies`) is on the same pipeline — check
`journalctl --user -u thumbtack-agent` on the box before trusting the next lead to it.

---
---
---

# ▼ SOMEDAY — everything below this line is not urgent

Real work, still wanted, none of it able to bite a client or a staffer. Push-review residuals land
here by default.

---

## Money and payroll (internal correctness)

- **A stranded PaymentIntent on a restored proposal has no automatic retry path.**
  `healStrandedIntents` (`staleProposalSweep.js`) joins `p.status = 'archived'`, so once a
  proposal is restored out of archived its `pi_cancel_incomplete` marker is never picked up
  again. A marker means a real `cancelOpenInvoiceIntents` FAILED, so there are open Stripe
  intents against an invoice the sweep already voided; calling this cosmetic (as an earlier note
  did) understates it. It only recovers if an admin re-archives by hand. NOT trivially fixed by
  dropping the status join: that would let the heal pass cancel intents on a proposal that is
  live again, which is a live-money change. Prod has zero heal markers today, so it is inert.
  Decide the rule before touching it.

- **A refund larger than the service contract leaves the override and total clamped apart.**
  `applyRefundReconciliation` clamps `total_price` and `total_price_override` at 0 independently,
  so gratuity dollars refunded beyond the override leave `total_price - override` below the
  derived gratuity and the next re-price bills the gap (override 100 + gratuity 50, refund 120:
  total 30, override 0, next save says 50). Pinned by name in `refundHelpers.override.test.js`.
  Before 2026-08-25 the gap was the whole refund. Closes with the gratuity-scope entry above the
  line.
- **The review-bounty catch-up never runs at period open.** `materializePendingReviewLines`
  (`dutyLines.js:549`) has two callers: the next review confirm (`staffReviews.js:489`) and the
  manual `scripts/backfill-duty-lines.js`. Nothing calls it when accrual opens a period, so a
  review confirmed into a gap parks until someone confirms another review or runs that script by
  hand. Fix: call it inside the accrual transaction once `ensurePayPeriod` returns a newly-open
  period. Money path, so its own lane. While in there, `staff_reviews` has no `confirmed_at`
  column, so the moment a bounty became owed is unreconstructable; add it on the same touch.
- **Payment history has no admin UI.** No way to see individual payments on a proposal; the panel
  shows totals only and `proposal_payments` rows are never listed. Shape: `GET /api/proposals/:id/payments`
  plus a compact table in `ProposalDetailPaymentPanel.js` (date, amount, type, method, status).
  Natural home for a per-payment Send receipt and for refund attribution, which is also invisible
  per-payment today. **Ride the `actions.js:294` fix along with it** (see above the line).
- **Two dispatch sites read `billing_type` off different tables.** `withRepriceQuantities`
  (`proposalExtrasFold.js:82-90`) dispatches on the CATALOG row; both cancel-line queries
  (`lineItemCancel.js:107`, `:458`) dispatch on the FROZEN `pa.billing_type`. A row whose catalog
  type was flipped after it was sold reads as two billing types at once. Catalog flips are not
  hypothetical (`schema.sql:785`, `:788` did exactly that). Deciding which source is authoritative
  IS the fix.
- **`lab.js`'s pre-fold upsert and post-fold re-sync are pinned only by prose.** Both
  (`lab.js:303-314`, `:379-386`) are hand-copied near-duplicates of their `submit.js` twins, so
  they can drift; the lab side's only cover is a comment. The scoping is a live path — an
  admin-seeded `mocktail-bar` at count 2 plus a client Lab save would be HALVED if lab's
  `if (!touchedAddonIds.has(entry.id)) continue;` were dropped. The submit twin's cover is partial
  too: deleting its re-sync loop leaves both tests green.
- **Cancel-line residuals.** `matchCancelTargets` (ambiguity refusal + amount corroboration) has no
  test, and a component test is now the natural home. `POST /:id/cancel-line/preview` runs the
  whole mutation then ROLLBACKs, so a nominally read-only endpoint holds exclusive row locks for
  the full core and burns SERIAL values. Lock-order inversion vs `drinkPlans/lab.js` (lab takes
  drink_plans then proposals; `applyLineItemCancel` the reverse) can deadlock — Postgres aborts
  one, no corruption, admin sees a 500. A gratuity-removal refund passes no `gratuityCents`, so
  `proposal_refunds.gratuity_cents` is NULL for the one cancel kind the column describes. The
  preview's `locked_invoices` line promises "a locked invoice for $X stands" but the fully-paid path
  deliberately drops that invoice's `amount_due`. RC4 (adopt the caller's own pending row by id) was
  applied to `refundExecute` and the sweeper but NOT to the `charge.refunded` webhook, which has the
  row id on `refundObj.metadata.proposal_refund_row_id`. The by-id adoption lookup checks only
  `id + status + stripe_refund_id IS NULL`, dropping the corroborating predicates — safe today,
  cheap to harden.
- **`computeCancelTargets` enumerates targets for a package-less proposal** but `applyLineItemCancel`
  throws `NO_PACKAGE`, so every button 409s.
- **`additional-bartender` cancel target can bind to the override row's amount**, but only against a
  STALE snapshot, and the precondition is not producible by the application — every writer of
  `num_bartenders` persists a fresh snapshot in the same statement or transaction. The remaining way
  in is MANUAL SQL, which is not hypothetical here. Prod: 0 instances. The signature query:

  ```sql
  WITH x AS (
    SELECT p.id,
           COALESCE((p.pricing_snapshot->'staffing'->>'extra')::numeric, 0) AS extra,
           (SELECT count(*) FROM jsonb_array_elements(
              COALESCE(p.pricing_snapshot->'breakdown','[]'::jsonb)) b
             WHERE b->>'label' LIKE 'Additional Bartender%') AS ab_rows
      FROM proposals p
     WHERE EXISTS (SELECT 1 FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
                    WHERE pa.proposal_id = p.id AND sa.slug = 'additional-bartender')
  )
  SELECT count(*) FROM x WHERE ab_rows = 1 AND extra > 0;   -- 0 = hazard absent
  ```

  Non-zero is the signal to build the guard (`skip the lone-match fallback when
  snap.staffing.extra > 0`); until then it defends a state nothing produces.
- **The $50 first-bar ghost resurrects on recompute.** CC-transferred proposals carry
  `num_bars >= 1` where the contract bundles the bar, so any snapshot recompute re-adds the
  package's `first_bar_fee`. Cosmetic since the override always pins the total, but it reappears as
  a breakdown line after each admin save.
- **A partial removal of a LAB-owned add-on** leaves the `labAdded` entry in
  `drink_plans.selections`, so the next Lab save re-upserts it and undoes the removal. Narrow — the
  lab creates add-ons at count 1, so a partial removal needs an admin to have raised the quantity.
- **Refunded or disputed tip after payout has no admin-facing alert.** The mechanism is fully built
  (`payrollClawback.js:295-323` even rewinds a dispute-WON ledger, and every degraded path
  Sentry-alerts). What is missing is only the human-facing alert: no email, SMS or UI.
- **`findOpenPeriodForDate` (`payrollProcessing.js:12`) is non-locking.** Low race window; every
  other lock in the mark-paid family landed.
- **Cancel-path frozen-period clawback deferral retry loses the pre-denial bartender list**
  (`payrollDeferredRetry.js:28` replays without opts). Defense-in-depth path, near-unreachable.
- **Boot re-asserts P4 floor values** (`schema.sql:2119` runs at every initDb), so hand-tuning
  `min_total` / `min_billed_guests` in SQL silently reverts on next deploy. By design for a
  seed-managed table — just know the only way to change floors is editing schema.sql.
- **Payment accounting: non-flat add-on comp residual** (brief owed).
- **Clients LTV understates by exactly extension money** (`clients.js:38` sums `p.amount_paid`).
  Left as-is deliberately; LTV is a ranking column, not accounting. If it ever matters, the fix is a
  per-client sum of succeeded `proposal_payments` minus refunds.
- **Stripe payout mirror:** acknowledged payout lines are permanently excluded from the re-match
  loop AND the unmatched count, and the backfill UPDATE replays on every boot, so hand-NULLing
  `acknowledged_at` is re-stamped at the next deploy. A future historical-payment import could make
  one matchable and it would never be re-matched or surfaced; the escape is a manual `matchLine(id)`
  that is not reachable from the admin UI. `StripePayoutsTab`'s In-transit table and "Unmatched
  only" empty state are not acknowledged-aware (inert today). The
  `proposal_refunds_total_scope_check` DO block matches `pg_constraint` on `conname` alone rather
  than `(conrelid, conname)`.
- **Service extension:** the whole settle tail runs synchronously inside the webhook handler before
  the 200 to Stripe (`paymentIntentSucceeded.js:649-765`), so a slow tail can push delivery past
  Stripe's timeout — retry is harmless but the dashboard shows failures. The heal re-runs accrual
  only when `applyExtensionHours` reports touched lines, so a crash after the hours apply but before
  `accruePayoutsForProposal` leaves the extension gratuity at $0 until something else recomputes;
  gate the heal on payroll-line existence, not this run's counters. The settle tail is the natural
  first extraction when `paymentIntentSucceeded.js` next grows.
- **Off-ledger lab deferrals:** the offer-side snapshot race (PUT builds `offeredSyrupByDrink` from
  `plan.pricing_snapshot` while the fold reads the freshly locked `proposal.pricing_snapshot`; 0 v2
  proposals carry contract syrups today). Lab GET serves the full shelf payload even in
  not_ready/locked states. Lab invoice find-or-create has no DB unique constraint. Pay-then-add
  delta invoice line items list the cumulative lab set with drift folded into the last line
  (amount_due exact, labels warp). A client removing additions AFTER paying the lab invoice leaves
  over-collection retained until an admin refunds manually. `refreshListAfterLabChange` fires per
  save with no coalescing. No in-flight guard on the debounced client save. The syrup shopping-list
  strip matches by normalized-name substring.

### Reference: where extension revenue shows up

Extension money lives in `proposal_payments` and `invoices` and NEVER in `proposals.amount_paid`
or `total_price` — 'Service Extension' is the sole member of `OFF_LEDGER_INVOICE_LABELS`. So every
payments-sum surface INCLUDES it (Money Board "Collected", dashboard-stats paid basis, the revenue
chart's paid series, the financials recent-payments table, the Stripe payout ledger) and every
`amount_paid`/`total_price` surface EXCLUDES it (booked/scheduled bases, Outstanding, the balance-due
filter, funnel metrics, `avgEvent`, metrics split). Neither is a bug; this is the record of which is
which.

**WARNING: do NOT "fix" any of those exclusions by rolling extension payments into `amount_paid`.**
It would falsely satisfy the funded-gratuity gate and the auto-complete gate, and it breaks the
`total_price`/`amount_paid` contract-ledger invariant every refund and cancel path depends on. Any
surface that needs extension revenue gets it from `proposal_payments`/`invoices` sums.

**Standing rule:** any genuinely-additive new invoice label MUST be added to
`OFF_LEDGER_INVOICE_LABELS`. The set is currently empty (lab money folds into `total_price`), but
the webhook/refund/lockedTotal machinery stays wired for the next one.

---

## Potions: catalog and planner

**THE LAW, learned the hard way.** The alias index in `buildCatalogSlices` is built ONLY from
`par_items.ingredient_aliases`, NEVER from the item's own name. An ingredient matching an item NAME
but no alias fails to resolve, `classify()` returns `unmakeable`, the drink is dropped from the
hosted picker entirely, and the ingredient is silently omitted from BYOB shopping lists.
**Exact-alias match runs BEFORE the substring fallback, and that ordering is load-bearing** — it is
the only thing keeping "Maraschino Cherries" off the Luxardo row. `normalizeName` strips non-ASCII,
so **NEVER put an accent in an item name or alias** (Tajin, not the accented spelling; Kahlua, not
the accented spelling) or the two spellings stop matching each other.

- **`cost` is null on 85 of 97 active par rows.** Biggest remaining gap; the package-editor margin
  rail is waiting on it.
- `paired_spirits` empty on 31 of 44 mixers + garnishes (feeds `SPIRIT_MIXER_PAIRINGS` /
  `addMatchingMixers`). `style_key` missing on 2 of 7 beers. Brands not yet named: Raspberry Vodka,
  Blue Curacao.
- **NOT a blank, leave alone:** `spirit_key` is null on 21 of 28 spirits. Those are modifiers, not
  base spirits, and filling them would change what `SPIRIT_PARS` hands the shopping-list generator.
- **Three recipe rows resolve to nothing, all on INACTIVE drinks** — each needs a `par_items` row or
  alias BEFORE its drink is ever reactivated: `Lavender Syrup` (Lavender Lemon Drop —
  `lavender-vanilla-syrup` exists but matches neither exactly nor by substring), `Limoncello`
  (Limoncello Lemon Drop), `Red Wine` (Red Sangria — only `cabernet-sauvignon` exists).
- **The substring-fallback hazard is dormant, not fixed.** `resolveRecipeRow({ingredient:'Smoked
  Salt'})` returns Smoked Chips: the exact-alias pass misses, then the substring fallback matches
  the alias `smoked`, and the head-noun preference cannot save it because `salt` appears in no
  alias. **Do NOT add a `smoked-salt` par row** (see Settled). What is still owed belongs to the
  recipe session, not to code: `smoky-pineapple-sour` still carries a `Smoked Salt` row in prod on
  an inactive draft. The next ingredient whose name contains a shorter alias hits this the same way.
- **The par baseline is not bar-type aware, so a mocktail bar stocks tonic and bitters.** `PARS_100`
  is built as "the `in_full_bar` rows" and `par_items` has no package or `bar_type` scoping, so
  `angostura-bitters` (~44% ABV) and Tonic Water land on the list for The Clear Reaction, whose
  whole premise is a zero-proof bar. Dallas also wants commercial ginger beer stocked for that bar;
  house-made stays a paid upgrade, so this is a par change ONLY and `covered_addon_slugs` must stay
  `{}` for `the-clear-reaction` or the $2.50/guest add-on stops being sellable. Fix is a bar-type
  exclusion on those par rows, or teaching `PARS_100` the package's `bar_type`. Internal prep-list
  correctness; no client-facing surface until someone reads a par sheet.
- **Custom-recipe flow residuals:** reuse-by-NAME rename gap (add-recipe reusing a drink matched by
  name loses the match if the admin renames it in the drawer; proper fix is a small alias-append on
  reuse). Reuse-before-create lookup downloads both full admin drink lists for a name match — fine
  at ~43 drinks, wants a lean lookup endpoint. `loadRecipeCandidates` awaits serially after the
  `resolveDrinkIds` Promise.all.
- **`drinkPlans/submit.js` has regrown to 717 lines** (soft cap 700); next touch carries a trim.
- **Narrow `coverageContext`'s `SELECT * FROM par_items`** (server-side; the two DrinksV2 perf items
  in this family are done).
- **Jack-rule corner:** on hosted non-mocktail packages, a client submit with zero resolved
  mocktails clears BOTH pair rows, so an admin-seeded Mocktail Bar addon would be removed by a
  client submit. Consistent with picks-are-authoritative design; revisit if admins start seeding
  mocktail addons.
- **pp2 residuals:** a v2 client who removes all mocktail picks after an admin reset-to-draft leaves
  the previously-flipped pair addon billed until an admin removes it (client submits never strip
  pair rows; the fast path never reconciles them). Admin proposal surface is the reconcile point.
- **QR lane residuals:** per-item `admin_set` flag rides the public payload (inert); no un-hold UI
  for admin-set quantities; buffer chips informational only.
- **Legacy planner drain:** delete `client/src/pages/plan/steps/`, `data/drinkUpgrades.js`, and the
  `DRINK_SYRUP_MAP`/pricing exports in `data/syrups.js` after the last `planner_version=1` draft
  submits. Query:
  `SELECT COUNT(*) FROM drink_plans WHERE planner_version=1 AND status IN ('pending','draft')`.
- **Drink-plan edit lock (Option A), specced and parked.** Decouple the lock from submit (currently
  `status IN ('submitted','reviewed')` at `drinkPlans/submit.js:58` and `:678`), tie it to
  `shopping_list_status`, add an admin "reopen for client" control. Option B (autosave tracking)
  already exists. Re-verified open 2026-08-19: `shopping_list_status` appears nowhere in that file.
- **Margin sketch** (decorative, admin-only): `||` fallbacks treat an explicit 0 labor-rate/supplies
  setting as unset (needs `??` plus query-param presence checks); flat-package revenue ignores extra
  hours while labor cost scales with them; PackagesTab fires one margin request per package on tab
  open, each re-reading all of `par_items`.

---

## Staff, shifts, and the roster

- **`shift_requests.position` is free text whose canonical casing is enforced only by convention,
  and three display rules disagree about it.** The CHECK is case-INSENSITIVE
  (`lower(position) = ANY(...)`), so `'bartender'` is a legal stored value. Two of the three
  readers already patch around it: `ShiftDrawer` renders `canonicalizeRole(req.position) ||
  req.position`, and the events-list hover card copied that on 2026-08-25 after shipping without
  it (one dev row rendered a lowercase "bartender" beside a drawer saying "Bartender"). The third
  does NOT: `parseApprovedByRole` (`client/src/components/adminos/shifts.js`) keys its per-role
  map on the RAW string while the roster it is subtracted from is canonicalized, so a
  non-canonical approved row counts toward `approved_count` but toward no role. The events list
  would read a green "1/1" while the drawer and EventDetailPage read "Bartender 0/1" with an open
  slot, for the same shift. **Currently latent**: prod holds 67 `Bartender`, 1 `Banquet Server`,
  27 NULL, zero non-canonical, and both live write paths canonicalize. The patch is one line in
  `parseApprovedByRole`; the fix that retires the whole class is tightening the CHECK to be
  case-sensitive and normalizing any stragglers, which is a money-seam schema change (position is
  the tip-split key) and wants its own lane. Do the root fix, not a third patch.
- **SETTLED 2026-08-25, do not re-raise: an applicant who ranked no role shows a BARE NAME on the
  events list, and that is deliberate.** An empty `requested_positions` means "any role" to
  `autoAssign.js`, to `classifyRequest`, and to `ShiftDrawer`, which prints the string literally,
  so the requests hover card (shipped `c792c321`) and the drawer describe the same person
  differently, one click apart, on 6 of 27 pending prod rows. The review surfaced it, Dallas
  declined the change: the card stays a bare name. Recorded because the divergence is real and
  someone will notice it again; the answer is that it was looked at and left. The one-word SQL
  change (`'Any role'` for the NULL) is here only so nobody has to re-derive it if the call is
  ever reversed.
- **The events-list waitlist gate is FLAT, not per-role, so it can hide a genuinely actionable
  applicant.** `deriveStaffing` computes `open = roster.length - approved_count`. On a mixed
  roster like `["Bartender","Banquet Server"]` with two Bartenders approved, `open === 0`, so the
  events list shows no requests chip at all, while `ShiftDrawer` (per-role `remainingByRole`) and
  EventDetailPage both correctly see an open Banquet Server slot and call that applicant
  actionable. **Unreachable today**: zero prod shifts have a mixed-role `positions_needed`. The
  stakes rose on 2026-08-25: the gate used to suppress a count, and now it suppresses a whole list
  of names behind the requests hover. `remainingByRole` is already exported from the module
  `StaffingCell` imports and the feed already carries `approved_by_role`, so closing it needs no
  server change.
- **`shiftEndInstant.js:190` reads `p.event_duration_hours` and ignores `shifts.event_duration_hours`.**
  The shift carries its own column (49 prod rows populated; 0 currently disagree). A
  `PUT /shifts/:id` that changes a shift's duration without touching the proposal silently drifts
  the assumed end. `COALESCE(s.event_duration_hours, p.event_duration_hours, 4)`.
- **The closure sweep is one UPDATE, so one poisoned row blocks ALL closures forever.** A bogus IANA
  name in `event_timezone` (a documented accepted exposure) aborts the whole statement, so zero
  shifts close on every tick thereafter rather than just the bad one. Sentry sees it, so it is loud
  — but all-or-nothing where a per-row loop would degrade gracefully.
- **`staffShiftActions.js:166` un-closes a swept shift.** Its unconditional
  `UPDATE shifts SET status = 'open'` on a drop/cover-request flips a shift the sweep already
  closed; the next tick re-closes it, and each flip restamps `updated_at`, which drives the iCal
  SEQUENCE. Past events only.
- **`alertStaffCant` is the one staff alert that does not name the staffer.** The successful drop
  still sends `A bartender texted CANT for the <event> on <date>` with no name and no user id
  (`smsInbound.js:635-636`), while the other four alert paths were fixed to read
  `Dallas (user 1) texted ...`. This is the instance where the name matters most — it fires when a
  shift has just been released and someone has to restaff it. It also sets a trap for the walk:
  anyone proving "alerts name the staffer" by dropping a real shift sees no name and concludes the
  fix never shipped. Pass the resolved staffer through and use the same `describeStaff` label, in
  the subject and in the under-7-days admin SMS.
- **`alertStaffCant`'s admin-SMS window narrowed by up to a day, silently.** The `daysOut < 7`
  comparison never changed, but the BASIS did: clock days floored → whole calendar days. An event
  ~6.2 clock-days away used to fire; on the 7th calendar day it now returns 7 and fires nothing.
  Not obviously a bug — calendar days are arguably more honest — but it is a live behaviour change
  nobody chose, on an alert whose whole purpose is urgency. Decide the unit, then make the comment
  say which one it means.
- **`GET /shifts/user/:userId/events` buckets by CALENDAR DAY, not the end instant**
  (`shifts.js:242`, documented in-code). A shift stays in Upcoming for the whole calendar day after
  it has ended. Erring toward "still upcoming" is the safe direction, but this route and the
  visibility family now disagree about the same shift.
- **Shift 31's `positions_needed` is `["Bartender","Bartender"]` but only one bartender worked it**,
  so it reads as permanently under-staffed on the staffing card.
- **Latent hazard if roster rows are ever backfilled for the two pre-payroll events** (shift 19 /
  proposal 21, shift 31 / proposal 54): should anyone later create a pay period covering April/May
  and re-run accrual, those rows would generate payouts for work already settled outside the system.
  Backfilling the record and backfilling a pay period are safe individually and dangerous together.
- **40 staff accounts are invisible in the admin UI, and this needs a product decision.** 29 `hired`
  (bulk-registered through the pre-hire flow on cutover day) plus 11 `in_progress` have no
  `applications` row. Hiring INNER JOINs `applications` so it cannot show them; the Roster selects
  only `approved`/`reviewed`/`submitted`/`deactivated` so it cannot either. They are reachable only
  through `GET /admin/hiring/search` or a direct `/staffing/users/:id` link, and nobody can clear or
  deactivate them from a list screen. **Open question for Dallas:** should Hiring grow a feed for
  users with no application row, should the Roster widen its status list, or is search plus the
  direct link the intended reach? All three are cheap; they are not the same decision. Pick one
  before anyone builds.
- **The hub summary and the roster feed hand-write the same status predicate twice.**
  `staffHub.js:39-48` and `admin/users.js:487-489`/`:506-507` express the same idea in different
  shapes, and the client re-filters `approved` a third time. They agree today and the summary's
  comment claims "one predicate family, shared with the roster feed" — true as prose, false as
  code. Change one and the tab count and the roster it labels disagree **on the same screen**, with
  no test failing. One exported predicate builder, or a test running both queries against one
  fixture set.
- **`splitOnboarding`'s stale-record fold cannot fire today** and receives an empty array. Keep it
  as the column's guard for the day a zero-progress account does carry an application row. Do NOT
  cite it as covering the 40 accounts above — it does not touch them.
- **Staff ops Project C: receipt reimbursements.** Staff submit a receipt image plus a chosen
  amount, itemized; admin approves or denies; approved amounts land in the payout. Fraud edges to
  design for: duplicate submissions, amount-vs-receipt mismatch.
- **Staff ops Project D: staff directory + comms shift.** Directory for covers and bonding,
  phone-visibility rule TBD. Context: many staff do not have or check WhatsApp and miss group
  messages; direction is DRB comms move mostly to SMS with WhatsApp as a relic. Not yet decided.

---

## Comms and marketing

- **Comms-action SMS never lands in `sms_messages`.** `proposalResend` and friends go out via bare
  `sendSMS` + `message_log` only, so the Messages/ClientDetail conversation view shows client
  replies without the outbound touch they answer. Dual-write an outbound row, or move comms SMS onto
  `sendAndLogSms`.
- **`messageLog` proposalId foot-gun:** any future admin-alert send that passes `meta.proposalId`
  lands on the client-facing Messages card.
- **Route-level tests for `POST /api/comms/send`** still missing subject caps, header hygiene, and
  the partial-failure shape (`comms.silent.test.js` now covers the empty-channel rule and a
  retry-guard interaction).
- **Post-flip total-failure dead-end:** if the confirm 500s wholesale AFTER the approve flip but
  BEFORE any send, Retry is unreachable and a re-click skips with a misleading "concurrent confirm"
  reason. Recoverable by editing the list (PUT reverts to pending_review). Rare, and strictly better
  than the double-email it replaced.
- **Deprecated resend-nudge delegation makes 3 DB round-trips vs legacy 1**, and the archived case is
  409 vs legacy 400. Compat-only route, low traffic.
- **Every comms action now requires the token its body links to — all three guards are DEAD.**
  Shipped 2026-08-25 for `paymentReminder`, `drinkPlanNudge` and `drinkPlanNudgeReenroll` (whose
  email half the first sweep missed). Recorded because the entry that prompted it read as a live
  bug and was not: `proposals.token` and `drink_plans.token` are both `UUID NOT NULL DEFAULT
  gen_random_uuid()` (verified against prod `information_schema`, not just `schema.sql`), and each
  `load()` drives `FROM` the token's own table, so no outer join can null it. Kept anyway for
  consistency with `proposalResend` / `proposalSendGroup` / `shoppingListApprove` / `invoiceSend`,
  which all already guard. Do not re-file this as a defect.
- **Sent-but-recorded-failed duplicate seam** (`marketingSend.js:336-359`): a successful Resend call
  followed by a transient failure of the `status='sent'` UPDATE marks the row `'failed'`; a later
  retry re-sends that one recipient. Needs a single-query DB blip. At-least-once is the deliberate
  lean; the targeted fix separates send-success bookkeeping failures from send failures.
- **Deploy-mid-send is recoverable but reads wrong.** SIGTERM's 15s hard-exit can kill an in-flight
  blast; claims protect everyone mailed and the campaign unlocks after the 15-min stale window, but
  the UI says "The send failed." for a half-completed run and retry 409s until the window lapses.
  **Operational rule meanwhile: don't push to prod while a campaign is sending.**
- **`DELETE /campaigns/:id` has no client caller at all** — the 409 guard is API-only and the
  marketing UI offers no archive control. A coverage gap on an endpoint nothing calls is not a
  defect; noted so nobody re-files it.
- **`schema.sql:1642-1647` re-creates the `email_sends` CHECK every boot** (DROP+ADD, ACCESS
  EXCLUSIVE plus validation scan). Fine at current table size; convert to a guarded DO block when
  `email_sends` grows.
- **The corporate audience's displayed rule is incomplete.** It renders
  `'Paid us · tagged Corporate'` while its `includes` array is
  `['Has paid us','Tagged Corporate','Event finished']` — and the third condition is the one that
  decides the count. Its sibling `past-all` gets this right. Fix:
  `rule: 'Paid us · tagged Corporate · event finished'`, and sweep the other five audiences for the
  same drift between `rule` and `includes`.
- **`PUT /contacts/:id/email-status` has no admin UI.** The route is real and tested
  (`marketingContacts.js:185`) but nothing in `client/src` calls it, so an admin who fixes a bounced
  address cannot un-mark it from a screen. One control on the contact row.
- **SMS cost line:** one non-GSM-7 letter in a bartender's preferred name (Zoë, Núñez, 李娜) flips the
  event-eve SMS from 2 to 4 segments. Cost, not correctness.
- **Paystub PDF renders CJK preferred names as mojibake on the fallback path only** (no crash;
  agreement/application `full_name` wins when present). Tip-sign display fonts lack Han and Cyrillic.
  Latin accents are fine in both.
- **Comms Phase 5/6 remainder.** Genuinely absent: the notification priority ladder with a
  1/channel/client/day cap, sentiment-routed post-event review, and stale-lead auto-archive. The
  reschedule flow, `event_timezone`, the drip sequence and STOP-keyword TCPA compliance all shipped.
- **Resend Pro upgrade** — free 100/day cap. **Decided 2026-08-14: not yet.** Revisit before the
  first real campaign blast; campaigns share the allowance with transactional sends, so raise
  `RESEND_DAILY_CAP` on Render when the plan changes or the Overview budget reads false.
- **The marketing compose canvas** (block palette / Look / Send test) is deferred pending Dallas's go.

---

## Voice

- **`GET /api/voice/vm/:token` has a per-IP limiter but no global or per-token ceiling, and buffers
  the whole recording per request.** `express-rate-limit` counts requests per window, not requests in
  flight, so all 30 of an IP's budget can simultaneously hold a full mp3 buffer for up to the 10s
  abort timeout — ~30MB of heap per attacking IP, so roughly 17 rotated IPs would OOM a 512MB Render
  instance that serves the whole API. The repo already built the pattern for this
  (`venueSearchGlobalLimiter`). Second half, same line: `Cache-Control: no-store` means the client
  can never produce the `If-None-Match`/`If-Range` the ETag code carefully reasons about, so that
  path is unreachable and iOS Safari's probe-then-body pattern costs TWO full authenticated Twilio
  downloads per playback. Requires a valid token, so hardening, not a live hole.
- **The 888's voiceUrl still points at the dead CheckCherry webhook.** Harmless in practice — nobody
  calls the 888, its job is SMS and that correctly points at `/api/sms/inbound` — but it is a live
  number pointing at a dead third party. Point it at a hangup or the primary handler.
- **`voicemailListen.js:78-79` overstates its 404 uniformity.** True among the `notFound()` cases,
  but a non-UUID path segment is rejected earlier by `requireUuidToken` and returns JSON. Nothing
  leaks either way; worth correcting because the next person will trust the comment over the code.
- **`server/routes/voice.js` is 705 lines**, over the soft cap the file was explicitly split to stay
  under. Owes a split.
- **Owed if Dallas ever wants the press-1 offer gone from the copy when the switch is off:** one
  no-press-1 day recording per line. Nothing needs it today. Note the recipe is a CODE change —
  swap the slot's BUNDLED file and flip `defaultSaysOffer`, env unset. Setting
  `VM_GREETING_URL_PRIMARY` DEFEATS the flag, because both `dayGreetingOffersPress1` and
  `needsAppendedOffer` short-circuit on a playable URL.
- **`dayGreetingOffersPress1` assumes an unknown override DOES offer press 1; night assumes it does
  NOT.** The reason is good (a night press-1 rings a sleeping phone) and is now written down. An
  operator pointing `VM_NIGHT_GREETING_URL*` at a recording that offers a human recreates the day
  trap at night with nothing to detect it.

---

## Admin UI and the two skins

- **Two client-side Chicago-day helpers now exist.** `utils/chicagoDay.js` (staff skin, added
  2026-08-25 with the paid_at fix) and `ctDay` in `components/adminos/format.js` (admin skin,
  added the same day) are the same function. They were kept separate because `pages/staff`
  imports nothing from `components/adminos` and one function did not justify opening that door.
  Collapse them into the shared `utils/` copy the next time either is touched, and have
  `format.js` import it.

- **267 AA contrast failures across 26 surface/skin combinations, collapsing to about 20 root colour
  pairs** — plus 80 nodes the harness cannot measure. Seven hit ALL THIRTEEN surfaces, so they are
  token-level. Run `npm run palette:contrast`; detail lands in the gitignored
  `palette-contrast-report.json`. Fix the top few and most of the 267 close:

  | skin | ratio | need | pair | where |
  |---|---|---|---|---|
  | light | **2.05** | 4.5 | `rgb(180,172,155)` on cream | `.sidebar-section`, disabled seg |
  | dark | **2.78** | 4.5 | `rgb(86,93,105)` on near-black | `.sidebar-section`, `.k`, disabled seg |
  | light | **2.11** | 4.5 | amber `rgb(214,161,81)` on cream | `td.num` — money figures, 4 surfaces |
  | light | **2.22** | 4.5 | same | `div.mtile-value`, 3 surfaces |
  | dark | **3.59** | 4.5 | white on teal | `a.skip-nav` |
  | light | **4.28** | 4.5 | near-black on teal | `a.skip-nav` |
  | dark | **3.65** | 4.5 | `rgb(11,13,16)` on blue | `span.nav-badge` |
  | dark | **4.19** | 4.5 | `rgb(124,133,147)` on `rgb(31,36,43)` | muted, 24 instances |
  | light | **4.22** | 4.5 | `rgb(122,116,104)` on cream | muted, **136 instances** |

  Money figures failing worst in House Lights is the sharp end — numbers are the whole point of
  those surfaces. The skip link failing in BOTH skins is the ironic one: it exists for keyboard and
  screen-reader users. **The 80 unmeasurable nodes are NOT passes**, they are places the tool cannot
  see, and only eyes can judge them. **The admin two-skin eyeball on House Lights is still owed by a
  human** — see `walkthroughs-owed.md`.
- **The dark `is-warn` accent bar renders CYAN.** `.ov-payroll-block.is-warn` uses
  `hsl(var(--warn-h) ...)` and `PALETTES.dark.warn` is `{h:192}`, which IS cyan at source. The
  Overdue chip beside it is fixed amber, so an overdue payroll card shows a cyan bar and an amber
  chip. Identity, not ratio.
- **The payroll total renders 42px in light and 22px in dark.**
  `html[data-app="admin-os"][data-skin="light"] .stat-value` (`index.css:11545`) out-specifies
  `.ov-payroll-total`. Nothing regressed; it deserves a deliberate call rather than being
  specificity fallout.
- **The rich text editor never got a skin pass, and it is on FIVE admin surfaces.**
  `RichTextEditor.js` (the `.rte-*` block, `index.css:7995+`) is styled entirely in the legacy
  marketing/apothecary vocabulary with **zero** `html[data-app="admin-os"]` or `[data-skin]` rules,
  and none of its five tokens are remapped for the dark skin. That last part is by DESIGN — the
  After Hours token-remap block says outright that surface tokens are deliberately NOT remapped and
  get per-island treatment. The editor is such an island and its treatment was never written. On
  After Hours it renders as a light parchment box on a near-black page; on House Lights it keeps
  old-skin chrome. Surfaces: `BlogDashboard.js`, `EmailCampaignCreate.js`, `SequenceStepEditor.js`,
  `emailBuilder/BlockSettings.js`, `emailBuilder/CampaignBlastEditor.js`. The marketing redesign
  window to fold this in has CLOSED — it shipped without touching the editor, so this is standalone
  work now.
- **Every admin-os card is inset twice.** The vendored design system defines the admin card as a
  FRAME with no padding of its own (inset lives on `.card-head` and `.card-body`), but the product's
  copy of that rule (`index.css:12795`) sets only the four frame properties, so the legacy
  Apothecary `.card` at `index.css:279` keeps supplying `padding: clamp(20px, 2vw, 28px)` and
  `margin-bottom: 1.5rem` to every admin card. Measured: the roster's NAME header sits 39px from its
  card edge where the artboard puts it at 18px. NOT fixed globally on purpose — every admin surface
  was built and eyed against the inherited inset, so removing it moves the layout of every card at
  once and needs its own regression pass across both skins. The scoped opt-out
  `.card.card-flush { padding: 0 }` exists. Fix shape when someone takes it: add `padding: 0` (and
  decide about `margin-bottom`) at `:12795`, walk every admin surface in both skins for cards whose
  only inset was the leaked one, and retire `.card-flush`, `.mkt-card-flush` and `.mkt-moment`'s
  padding reset in the same pass.
- **The revenue chart shows a WHOLE MONTH under any sub-month filter.** `qRevenue`
  (`metricsQueries.js:344`) has no granularity concept — month is hardcoded in the range bounds, the
  `generate_series`, all ~8 value subqueries, and the CC-era legs. A sub-month range collapses `lo`
  and `hi` to the same month start, so exactly ONE bucket comes back summing the entire month.
  Measured: the week 8/06-8/12 and the day 8/12 both returned one bucket labelled 2026-08-01 holding
  all of August ($4,230).

  **TRAP — do not fix the symptom.** It only escapes notice because a line chart cannot draw a
  single vertex, and `RevenueChartCard.js:256` only prints "No revenue in this range" at `n === 0`.
  **The blank plot is currently the only thing preventing a wrong money figure from being read off
  the dashboard.** Making it render at `n === 1` would EXPOSE a whole month of revenue labelled as
  one day. Either fix the granularity or leave it blank.

  Scope: `qRevenue` needs a real granularity parameter threading through all four hardcoded sites
  plus the CC-era legs; `RevenueChartCard.js` assumes months too (x-axis keys are month strings, the
  era test is the literal `ERA_MONTH = '2026-05'`); Compare shifts by a whole prior period and
  equal-length windows must stay equal-length; and `dashboard-stats`/`financials` response shapes are
  byte-frozen, so this wants a sibling endpoint or an additive opt-in param.

  **Dallas asked and skipped 2026-08-14 ("skip for now"), so the product question is undecided and
  the project stays unscoped.** Recommendation on the table: DERIVE granularity from the range
  (about a month or less draws daily, six months or less weekly, longer monthly) rather than shipping
  two controls that can build an invalid combination.
- **Eleven admin-only dead affordances**, batch material rather than individual tickets since only
  Dallas and Zul see them. Line numbers are from 2026-08-14 and several files have moved — re-locate
  by shape: `EmailConversations.js:106`, `userDetail/tabs/ShiftsTab.js:77`, `StripePayoutsTab.js:146`,
  `index.css:12851`, `payroll/TaxTotalsTab.js:172`, `index.css:12937`,
  `drawers/ShiftDrawer.js:667`, `proposalCreate/ClientSection.js:70`, `BlogDashboard.js:330`. (Two
  more closed by file deletion.)
- **The command palette hides the desktop `⌘K` hint under `@media (pointer: coarse)` but keeps its
  own `Esc` chip and ships no visible touch dismiss control.** A missing close affordance.
- **The option-group rollup splits across the 50-row page boundary.** Grouping happens client-side
  over one fetched page, so a group straddling the boundary renders on BOTH pages, each with its
  local option count. Rare and display-only. Fix needs a design call: group server-side, fetch group
  tails, or accept it and note it in the pager copy.
- **`CocktailMenuDashboard.js` redesign** — 931 lines, double-mounted, ~90% duplicate code between
  Cocktails and Mocktails. Pull it out of Settings entirely.
- **Needs-attention queue rows are `div role="button"` wrapping a `tabIndex={-1}` anchor** — a link
  inside a button role is technically invalid ARIA containment. Keyboard behaviour is correct in
  practice. `buildLeadCallItems` has zero unit tests while every other export in that file is
  covered. Sales-tab behaviour has never been observed live (no proposal currently qualifies as
  sent-unviewed past 72h).
- **`BundlePicker` hardcodes "popular" to `the-foundation`.** The literal is hoisted to
  `POPULAR_BUNDLE_SLUG` with a comment; data-driving it needs a schema column, a seed, and the server
  twin in `proposalRules.js` moved to the same source — a lane, not a ride-along.
- **The client-side gratuity floor still duplicates the literal 50**; the server has
  `GRATUITY_FLOOR_RATE` (`pricingEngine.js:236`). Lift the client to a shared constant.
- **Mobile remediation batches 5-8** (tablet band 768-1024, 4 standalone Highs, post-C1 residual,
  Med/Low cleanup) are genuinely unstarted. C1 is done.

---

## Platform, schema, and test gates

- **`balanceScheduler.chicagoDay.test.js` is not in `scripts/money-smoke-list.txt`**, so the push
  gate never runs the one suite pinning the autopay day rule. It was safer that way while the
  suite pinned 2099 (the gate runs against `ci-smoke`, which resets from the PROD parent, so an
  unscoped claim there would have matched prod-derived rows). Now that the fixtures are pinned to
  1999 it is safe to list, and until it is listed the regression it was written for is ungated.

- **`server/middleware/corsOptions.js` is missing from README's middleware folder tree.** Added
  2026-08-25 when CORS policy was extracted out of `server/index.js`; the README tree otherwise
  enumerates every non-test file in that directory. `scripts/check-docs-drift.sh` does not watch
  `server/middleware/`, which is the same blind spot the 2026-08-19 self-audit found for
  `client/src/utils/`. One line.
- **Two server suites cannot pass between roughly midnight and 05:00 Chicago, and one leaves FK
  debris.** Both reproduce identically on the deployed baseline, so neither is a regression; both
  were confirmed against `origin/main` on 2026-08-25 at 04:36 Chicago.
  - `shifts.visibility.endInstant.test.js` fails its `before()` premise, cascading all 6 tests.
    The `ended` fixture is built as `GREATEST(now - 30 min, midnight + 1 min)`, so in the small
    hours it becomes a shift dated today ending at e.g. 04:06 with no `start_time`; the overnight
    handling in `shiftEndInstant.js` then reads that as ending TOMORROW morning and the fixture is
    classified unfinished. The product rule is right, the fixture is unsound at night. Fix: seed
    the `ended` fixture on the PREVIOUS Chicago day when `now` is early enough that
    `now - 30 min` lands before the overnight cutoff, rather than clamping to today's midnight.
  - `shifts.withdraw.test.js` fails 1 of 11 on teardown ordering:
    `payouts_pay_period_id_fkey`, deleting a `pay_periods` row while a `payouts` row still
    references it. Delete the payout first, or cascade in the fixture cleanup.
- **`pricingSnapshot`'s legacy-shape breadcrumb accumulates on the ROOT isolation scope.** Shipped
  2026-08-25 in the Sentry-noise pass. In `@sentry/node` v8+, `addBreadcrumb` writes to the
  isolation scope; HTTP requests get a per-request fork, but scheduler code (the 60s message
  dispatcher, the hourly balance/duty/accrual runs) has no fork and writes to the root scope,
  which is never reset for the process lifetime. `maxBreadcrumbs` is unset, so the default 100
  fills with identical `legacy snapshot without _version` entries; worse, the OTEL request fork
  CLONES the isolation scope, so those 100 useless entries then ride along on unrelated request
  errors. That is precisely the outcome the change's own comment says it prevents. Not a
  correctness bug, nothing moves. Fix: skip the breadcrumb (or keep a cheap throttle) when there
  is no active request isolation scope. Removing the throttle was right for the request path.

- **20 bare `DROP CONSTRAINT` + `ADD CONSTRAINT` pairs run as two autocommit statements**, so a
  failed ADD commits an ABSENT constraint. `email_sends_recipient_check` and the three tip FKs rank
  highest. (The two that can drop real messages are above the line.)
- **37 `DO $$ ... EXCEPTION WHEN OTHERS THEN NULL` blocks swallow every failure.** The worse case
  nobody had identified: when a constraint has never successfully existed, atomic rollback protects
  nothing and you get a permanently absent constraint with zero output forever — which is exactly
  how `shifts_status_check` went missing from dev for months while initDb printed its success line.
  `RAISE WARNING` plus a notice listener fixes it at zero boot noise. Note the bare form is not
  uniformly worse: a failing bare ADD raises 23514, which DOES reach initDb's `unexpected` array and
  DOES page Sentry. The bare form trades safety for visibility; the DO form trades visibility for
  safety.
- **`CONSTRAINT_CONTRACT` has an open design question: does the manifest grow a presence-only kind?**
  `email_sends_recipient_check` (the lead_id/client_id XOR) has the same bare shape and its absence is
  a real hazard, but it enumerates no values so `mustContain` has nothing to hold. An entry with
  `mustContain: []` would assert nothing while reading exactly like one that does, so it was not
  bolted on.
- **A multi-arm CHECK whose arms are about different columns can false-PASS the contract.**
  `CHECK ((status = ANY (ARRAY['a','b'])) OR (kind = 'paid'))` satisfies `mustContain: ['paid']` for
  status. Every contracted constraint is single-column today, so it is latent. Closing it needs the
  column name and a scoped extractor.
- **`server/db/index.js` is not sensitive-listed while `server/db/schema.sql` is.** It re-executes
  schema.sql on every boot and decides which DDL failures are swallowed, so a change there can
  silently disarm every guard in this section. Not added on proportionality — these guards are
  alert-don't-wedge and decide nothing at request time. **Dallas's call.**
- **`staffPortal/paymentMethods.js` writes bank PII and is NOT sensitive-listed.** It owns
  `GET/PATCH /payment-methods` + `PUT /preferred-payment-method` and writes bank routing and account
  numbers through `encryption.js` — which IS listed. The route decides what gets encrypted, what
  gets projected back, and holds the field whitelist, so a change that accidentally projects a
  decrypted account number scales to a light look. **There is no deliberate-absence note** (every
  intentional absence on that list carries one), and it has never been covered at any point — it was
  split out of `staffPortal.js` before the parent was ever listed. Add it by name with a rationale
  comment. Adjacent and lower confidence: `staffPortal/accountReads.js` is also unlisted and its
  whole design is not projecting raw R2 storage keys for W9s and signed agreements.
- **Also unlisted:** `smsConsent.js` (writes `communication_preferences.sms_enabled` in the same
  `jsonb_set` shape as the listed `smsInbound.js` AND appends `sms_consent_log`), and
  `routes/proposals/public.js` (writes `sms_enabled` directly from an unauthenticated submit).
  Recommend listing both — Dallas's call, since adding paths expands every window's review load.
  Also absent: `paystubData.js`, `paystubPdf.js`, `businessTime.js` (a change to the money content of
  a tax document does not pull the fleet), `admin/payrollTax.js` (the 1099 surface), `shifts.js`,
  `shiftTime.js`, `staffCalendarFeedExt.js`, `orientationData.js`, `balanceInvoiceMonitor.js`,
  `calendar.js`.
- **Listed-but-ungated:** `smsInbound.nearestShift.endInstant.test.js` belongs on
  `money-smoke-list.txt` by the precedent already set twice, but the gate runs against the
  `ci-smoke` Neon branch and that suite asserts a DB-session premise and seeds
  `shifts`/`shift_requests`/`users` fixtures none of which has been exercised there. The gate
  HARD-FAILS on a listed file that misbehaves. **Run it against ci-smoke once, then add it.**
- **`scripts/testdb-smoke.js` cannot fail on a failed schema statement.** `initDb()` logs and
  Sentry's per-statement errors and RESOLVES, so the child exits 0 and the gate passes while a
  constraint silently did not build. The gate's strongest claim is currently unenforceable. Make the
  smoke child assert zero unexpected failures.
- **No gate runs non-money suites against a prod-shaped DB.** The local dev DB is the only thing most
  suites ever run against, so any drift between dev's schema and prod's turns into a suite that
  passes locally and is wrong about production — which happened silently for months. Two candidate
  fixes, neither taken: add the shift-lifecycle suites to `money-smoke-list.txt` (cheap, narrow), or
  add a periodic schema-diff between dev and prod (broader, and would have caught the missing
  constraint directly).
- **A cheap CI check that fails when a `*.test.js` reaching `../db` does not load dotenv.** It is a
  two-line grep and it would have caught all nine dead suites on the day each was written. NOT built
  — `scripts/push-gate.js` is sensitive-listed and a new hard-failing check belongs in a deliberate
  lane.
- **Push-gate cosmetics, both fail closed.** The run-mode summary can print "gate PASSED, skips the
  hook" right after "no receipt was written" when the tree moved mid-run (the summary re-reads the
  STALE receipt; the hook itself correctly refuses it, so this is message-only) — fix by comparing
  the banked receipt's fingerprint to `fpAfter`. And `flock -n` uses exit 1 for lock-held, so a gate
  that legitimately FAILS also prints "another push gate is already running" — fix with
  `flock -n -E 99`. Acknowledged non-coverage, deliberate: `npm run test:smoke` takes no lock; no
  file lock can cover a second clone or machine; gitignored files are outside the receipt
  fingerprint with the 12h expiry as the only backstop.
- **The CSS palette checker ships with KNOWN BLIND SPOTS — do not trust its green tick.** It is
  warn-only in pre-commit and catches the exact regression that bit twice (an unscoped bare-element
  rule painting `--cream-text`). It does NOT catch: `input[type="text"] { color: var(--cream-text) }`
  (check A treats ANY attribute selector as app-scoping); `p:not(.mkt-only) { ... }` (escapes check A
  via the dot, then check B's "every class must be admin-reachable" test is logically inverted for
  `:not()` classes); a parse desync (one stray apostrophe collapses the sheet to 10 rules and it
  still prints the tick, because the anti-vacuous guard only fires at EXACTLY zero tokens). Lesser: a
  rule locally redefining a skin-aware token to a legacy value, a hex reached through a `var()` alias
  chain, `VAR(` uppercase, and `background`/`border` are not checked at all. Fixing these is a
  bounded, well-specified job. **Treat a green tick as "the known re-arming shapes are absent", not
  "the leak is closed."**
- **The `toYmd` shape is repo-wide: 34 occurrences across 28 non-test files** plus 13 test files. The
  helper is hand-rolled SIXTEEN times, and the five `toCalendarYmd` copies are THREE different
  implementations with three different behaviors (`preEventScheduling.js:30` returns the literal
  string `"null"` on null input; `payrollAccrual.js:100` and `cancel.js:57` return `"NaN-NaN-NaN"` on
  an Invalid Date). **Direction matters and lumping the two hazards together hides them:** a pg
  `DATE` parsed at local midnight shifts back a day EAST of UTC, while a `TIMESTAMP WITHOUT TIME
  ZONE` with an evening time shifts FORWARD west of UTC.

  **DO NOT retarget `balanceScheduler.js:77` on its own.** It and `stripe.js:340` build the SAME
  Stripe idempotency key (`autopay-balance-<id>-<balanceDueIso>`) from this expression, deliberately
  mirrored so a manual click racing a scheduler tick returns the same PaymentIntent. Changing one and
  not the other makes the keys diverge and removes the only guard against a second real balance
  charge. One commit, its own lane, nothing else in it. Both are sensitive-listed.

  Note: **the 1099 tax-year worry is NOT real** and must not drive urgency. The 1099 comes from
  `GET /payroll/tax-totals`, which buckets entirely in SQL and never touches the JS helper.
  Also, no existing test can catch any of this — the one TZ-pinned suite pins UTC, the value at which
  several of these are silent. Any fix needs tests at two or more TZ values.
- **Shared-dev-DB test hygiene:** `paystubData.paidDate.test.js:57` adopts a `pay_periods` row via
  `ON CONFLICT (start_date) DO UPDATE` and `after()` deletes that id, so an interrupted run can
  rewrite another lane's period boundary and then fail its own cleanup on the FK. A dev `pay_period`
  stuck in `processing` makes 5 payrollAccrual tests skip — refactor that test to manage its own
  period.
- **`repriceSummary`'s overpaid branches:** five suites now reference `repriceSummary`/`overpaid`, so
  coverage exists; whether it reaches the three specific overpaid-plus-increase shapes was never
  verified. Admin-facing money copy, so it should not stay on trust.
- **File-size ratchet.** RED 0. Closest to the 1000 hard cap: `PotionPlanningLab.js` **998** (and
  none of its extracted hooks exist), `crud.js` 976, `smsInbound.js` 877 (natural seam: keyword and
  opt-out handling vs the shift responder), `ProposalEditorForm.js` 867, `ProposalView.js` 864,
  `paymentIntentSucceeded.js` 869, `CocktailMenuDashboard.js` 931, `emailTemplates.js` 819,
  `ShiftDetail.js` 810, `thumbtackAgent.js` ~790 (split candidate: the first-reply queue into
  `thumbtackAgent.replies.js`), `staffPortal.js` 785, `QuoteWizard.js` 837, `drinkPlans/submit.js`
  717, `voice.js` 705, `admin/users.js` 713, `ProposalCreate.js` 750.
- **Vite migration.** Decision locked (Vite, not Next). Still on `react-scripts 5.0.1` with zero vite
  references. 15-16 CRA-tied HIGH advisories are accept-and-document until this happens.
- **Sentry, still open:** `DRBARTENDER-SERVER-1N` (legacy `pricing_snapshot` rows without `_version`,
  54 events) — finishing it means stamping or backfilling legacy snapshots, or demoting the log, not
  just writing the validator. `DRBARTENDER-SERVER-22` (see the TT gate above). The N+1 cluster
  (`SERVER-11`, `-1F`, `-1P`, `-1Q`, `-1C`) on dashboard-stats, financials and staff-home is
  perf-category with its indexes already itemized below. `WILDLIGHT-9`/`-F` are working fallbacks
  doing their job; `WILDLIGHT-2` is 7 login-failure events in 29 days and the lockout Map covers it.
  **Do NOT resolve `DRBARTENDER-SERVER-21` as noise** — see Settled.

### Tech debt (deliberate deferrals from the 2026-04-24 full audit)

Re-swept 2026-08-19: zero dead entries, every one still genuinely open. Line numbers are old —
re-grep before surgery.

- **`shifts.positions_needed` + `equipment_required`: TEXT → JSONB.** Both store JSON text and
  require `JSON.stringify`/`JSON.parse` at every callsite and `::json` casts at query time. Needs a
  production data migration plus a callsite sweep: `autoAssign.js:141`, `admin/settings.js:132-135`
  (badge-count `::jsonb` casts), `AdminDashboard.js:302`, `StaffShifts.js:97`, `ProposalDetail.js:156`.
  `shifts.js:198` has since added an `IS JSON ARRAY` guard on top of the still-TEXT column. Belongs
  in its own spec with a rollback plan.
- **Dead column drops**, all still present in prod: `users.calendar_token_created_at` (written never
  read), `applications.favorite_color` (humor field — confirm intent before dropping). Batchable
  into one guarded migration. `shifts.client_email` / `shifts.client_phone` were listed here and are
  NOT dead: `createEventShifts` INSERTs both on every proposal-backed shift (`eventCreation.js:316`)
  and both are read back through the `COALESCE(c.email, s.client_email)` fallback in `shifts.js:119`
  and `:414`. The old note blamed the manual-event path, which is gone as of 2026-08-25 and was never
  the only writer.
- **`pricing_snapshot` shape validator — HALF DONE.** `pricingSnapshot.js` exists
  (`PRICING_SNAPSHOT_VERSION = 1`, `readSnapshot` with legacy tolerance, the SERVER-1N warn, a
  future-version throw) and is routed through invoiceExtras, preEventHandlers, payrollAccrual,
  setupTime, eventCreation, lineItemCancel, dutyLines. **Still parsing raw:** `routes/stripe.js`,
  `serviceExtensionSettle.js`, `payrollMath.js`, `eventDetailsPayload.js`, `proposalExtrasFold.js`,
  `invoiceLineItems.js`, `proposalGroups.js`, `changeRequests.js`, `gratuityLabels.js`,
  `routes/shifts.js`. Legacy rows still unstamped.
- **`adjustments` + `class_options` shape validators.** `proposals.adjustments` has no server-side
  shape validation before INSERT; `class_options` has a whitelist in ONE insert path. Extract
  `normalizeAdjustments()` / `normalizeClassOptions()` and route every writer through them.
- **True schedulers-to-worker split.** A dedicated `server/worker.js` running only the schedulers,
  with Render on one web service (no schedulers) + one worker. Eliminates every "scheduler ran N
  times because N web instances" bug. Changes deployment topology and might affect pricing.
- **Drink-plan extras pricing service.** Add-on + bar-rental + syrup charges are recomputed inline in
  three places (`stripe.js:197-216`, `drinkPlans.js`, `invoiceHelpers.js`). One concept, three
  owners. Extract to `drinkPlanPricing.js` with golden tests.
- **Proposal-creation consolidation — PARTIAL.** `proposalInsert.js` (`insertProposalRecord`) exists
  and is consumed by `crud.js`, `proposalGroups.js`, `thumbtackProposalDraft.js`, but the PUBLIC path
  still hand-rolls its own INSERT at `public.js:458`. No `createProposal(ctx, input)` service yet.
- **`PotionPlanningLab.js` state-controller split.** Orchestrates API loading, migration, autosave,
  history interception, payment-redirect handling, queue derivation AND step rendering; steps are
  thin leaves over large prop bags. Extract `usePlanAutosave` / `usePlanHistory` / `usePlanQueue`.
- **`ClientAuthContext.js` via `utils/api.js` — PARTIAL.** `:2` now imports `API_BASE_URL` so
  base-URL resolution is shared, but `:15-25` still uses raw `fetch` with its own error path.
- **`App.js` route manifest dedup.** 193 `<Route>` elements, 56 distinct paths registered more than
  once. **This is deliberate host-gating, not accidental duplication** — four host-scoped trees with
  a resolver picking one by hostname, so each must register the shared public token routes. It is a
  dedup REFACTOR, not a defect, and a routing refactor on working code is poor value against a file
  one line over a warn-only cap.
- **QuoteWizard ↔ ProposalCreate policy dedup.** Both own package/add-on eligibility, draft
  persistence, pricing preview, event-type lookup and submission rules, and they have already drifted
  (`filteredAddons`, event-type search, preview payloads/endpoints).
- **Perf deferrals whose triggers are nowhere close** — recorded so nobody indexes a one-row table:
  `proposal_payments` holds 79 rows against a ~100k trigger; `email_sends` holds 1 row against a
  "100 campaigns × 10k sends" trigger; `applications` holds 14 rows against a 10k trigger. Includes
  the geocode backfill bulk UPDATE, blog-import parallel uploads, the campaign-list triple correlated
  COUNT, the `include_cc` composite index, and the applications `CASE` that blocks an index.
- **Pagination on tenure-dependent endpoints.** Five endpoints have `LIMIT 500` with no frontend
  paging, so once a user hits the cap the UI silently shows an incomplete list with no indicator:
  `shifts.queries.js:85` and `shifts.js:248` (a 2.5-year bartender at 4 events/week), and three
  `emailMarketing/campaigns.js` lists (a single 10k-lead campaign). Triggered event: the first
  support ticket mentioning "missing old events" or "campaign shows 500 sends but blast went to 10k."
- **Failed-login DB audit trail.** Console-only today with a short Render retention; the in-memory
  `loginAttempts` Map provides basic lockout. Optional `failed_logins` table if audit needs grow.
- **Dead-letter readers for forensic blobs.** `thumbtack_leads.raw_payload`,
  `thumbtack_messages.raw_payload`, `thumbtack_reviews.raw_payload` and `proposal_activity_log.details`
  are written and never read back in any admin UI. Intentional forensic storage.
- **DEFAULT vs always-supplied column duplication.** ~10 columns have schema DEFAULTs that never
  trigger. Harmless smell; sweep during routine DB maintenance.
- **`email_leads` / lead-import shape:** see above the line for the raw-email index.

### Accepted risks — document, don't fix

- **npm audit `react-scripts` transitive CVEs** (14 high / 6 moderate). CRA is abandoned upstream;
  none ship to the production browser bundle. Migration off CRA is its own project.
- **Helmet CSP `'unsafe-inline'` in `styleSrc`.** Required by Stripe Elements + inline React styles.
- **In-memory `loginAttempts` Map.** Acceptable for single-instance Render; multi-instance bypasses
  the lockout per-IP rotation.
- **Email `html_body` shipped to every campaign-step edit request.** No meaningful optimization short
  of a lazy body endpoint.
- **`uuid` GHSA-w5hq-g745-h8pq.** The advisory needs a `buf` argument on v3/v5/v6; every site uses v4
  with no `buf`, so the path is unreachable. The only fix npm offers is a semver-major.
- **`@opentelemetry/core` GHSA-8988-4f7v-96qf.** Pulled transitively by `@sentry/node`'s OTel
  instrumentation and tightly version-coupled, so forcing core alone risks breaking Sentry tracing.
  The Sentry bump did NOT clear it — `@sentry/node` is `^10.49.0` and the lockfile still resolves
  core at 2.6.1, below 2.8.0. Re-check whether a newer Sentry line clears it.
- **record-payment reads `currentPaid` pre-transaction.** The `currentPaid === 0` gate for the
  client-lock hoist and the same-client sweep uses a value read before `BEGIN`. Consequences are
  benign (an extra client lock is harmless, a re-sweep is idempotent, and the amount math uses
  guarded in-tx UPDATEs). If the handler is ever reworked, re-read `amount_paid` under the in-tx row
  lock.

---

## Unbuilt projects and design sessions

- **Mobile admin: every phone-first DATA screen.** The shell shipped and is live; the app did not.
  `client/src/pages/mobile/` holds exactly ONE file, `MorePage.js`. There is no phone Events list or
  detail, no phone Proposals list or detail, no assignment sheet, and no sheet component at all — so
  the decision-log line "mobile sheets push history so Android Back closes the sheet" has nothing
  implementing it. The Events and Proposals tabs route to the ORDINARY DESKTOP ADMIN PAGES, neither
  of which has a phone branch, which is precisely the "CSS retrofit" shape the spec's decision log
  rejects. **Whether to build them at all is Dallas's call.**

  **The offline staleness line belongs to whichever lane builds those screens** — do not open a lane
  for it alone. The chain is built and green at both ends and disconnected in the middle:
  `admin-sw.js:86` stamps `x-sw-cached-at`, `api.js` surfaces it as `response.staleAt`, and
  `staleTime.js` `formatStaleAt` renders "as of 1:47 PM" — and **nothing imports it.** The `.m-stale`
  element its own header comment says "screen lanes render" appears nowhere except that comment.
  Impact: offline the PWA renders cached events, proposals and money data styled identically to live
  data with nothing indicating age. The identity is honestly bounded; the data is not. Any test for
  this must assert the CALL SITE — two green unit suites on the two ends bought the appearance of
  coverage for a feature that does not exist on screen.
- **The offline lock screen has no working exit.** Offline, BOTH buttons are dead: Unlock needs the
  network for `assert-options`, and "Use password instead" lands on "Something went wrong" because
  `Login` is a lazy chunk that is only in `SHELL_CACHE` if it was fetched online under the current
  SW_VERSION. **The finding that matters is the posture downgrade:** after that tap and a later
  password login the phone is silently UNARMED — `ENROLLED_KEY` was purged, so `phoneUnlockArmed()`
  is false, there is no 30-minute background lock at all, and `authFailureAction` drops from `keep`
  to `purge`. It stays that way until the user happens to notice the enrollment nudge.

  **The purge itself is correct and must not be "fixed"** — it is the same `logout()` every other
  logout calls, its job is keeping cached admin PII out of Cache Storage on a lost phone, it is spec
  law, and it is test-pinned. **The fix belongs at the destination:** offline-aware copy, or refuse
  to leave the lock while `navigator.onLine` is false. There is currently no `navigator.onLine` check
  anywhere on this path. The one genuinely unrecoverable loss is small:
  `adminDesktopViewOverrides` is localStorage-only with no server copy, so every screen pinned to
  Desktop view silently reverts. Severity LOW to MEDIUM.
- **Price guide lookup tool.** Dallas: *"this needs a proper brainstorm at some point."* **The
  information architecture is the hard part and it resists both obvious answers** — search alone
  fails because he often cannot NAME the thing (*"WTF did we decide to call the add-on bundles? Full
  compound?"*), and categories alone fail because when he DOES know it is the Full Compound he should
  not have to remember it lives under BYOB supplies and click twice. One page holding the whole
  catalog was rejected outright and correctly: *"one big giant scrolling hell. No."* **Start the next
  attempt from the IA, not from a surface.**

  Requirements established, reuse them: desktop first ("I hate using the phone"); **small numbers must
  be exact, the big number can be fuzzy** — *"If I say the full compound costs $7/guest and then send
  a proposal and its $9/guest, that is an error. If I say that brings the total to $555 and really its
  $600, but the line items were right, that is forgivable"* — so this is a rate card first and a
  calculator a distant second; the real cost is lost recall on a warm call, not missing data; scope is
  the WHOLE catalog; read-only by construction, no drafts, no saves, no proposal creatable from it.
  Today's three surfaces all fail because they are transactional. Any lookup must read live numbers
  (catalog copy has drifted from schema.sql before) and must read the shared bundle config rather than
  restate it — bundle CONTENTS live in code (`bundleConfig.js` mirrored by `proposalRules.js`), not
  the DB.
- **Wedding Pro / The Knot leads.** Dallas: *"we need to do it soonish, but its a whole project. We
  get leads, but don't really do anything with them."* Real leads arrive and go unworked — revenue on
  the floor. Whole-project treatment: brainstorm → spec → plan. Design should decide how much of the
  Thumbtack pipeline shape to reuse (harvest → auto first-reply → call bridge) vs start simpler
  (lead-email capture + notify), remembering that reuse inherits the whole scraper-fragility surface —
  a UI change silently broke the TT pipeline twice in one week.
- **1099 generation.** The queued successor to the retired staff-payment umbrella. The ledger keeps
  YTD totals exportable; the output itself has no plan and no code. Needs a spec first (form
  generation vs export-for-accountant is an open design call). **Clock: recipient copies due ~Jan 31.**
  Gates: Zul's real W-9, and the `users.exclude_from_1099` flag honored.
- **Client portal v2 remainder.** Still absent entirely: the Big Experiment and Account tabs, the
  day-of brief slot (decisions captured: preferred name + headshot + "subject to change", no
  phone/messaging, 30-90 min generic arrival), quote-resume, and in-portal sign/pay/lab. Overview,
  Potion, Receipts and Prescription tabs are real now, and a per-event route token + ArchiveList give
  a partial multi-event switcher.
- **Menu design page.** A real workflow over the planner-captured menu prefs
  (`menuStyle`/`menuTheme`/`drinkNaming`/`menuDesignNotes`), producing a real artifact and the
  done-state that then powers "menu to design" Prep queue items. Dallas has page ideas to brainstorm.
- **Staff-portal skin + menu.** Dallas: the staff portal menu *"works, but is icky. maybe a pass with
  the claude.ai/design."* Scopeable as a Dallas-driven design session over the staff-portal skin — the
  menu/nav plus `FieldGuide.js`, which is reachable from the staff portal but not wearing the staff
  skin. Subject to the design-artifacts-are-contracts custody rules in CLAUDE.md: a Visual contract in
  the spec body, a lane that owns match-the-artifact via DesignSync, and `ui-ux-review` pointed at the
  artifact.
- **Settings page.** **Deferred 2026-08-14 ("defer settings")** — not a decision against either shape.
  Context banked: the two-card layout was never a choice, it is the status quo, and it works. The only
  live question is whether anything gets added. Recommendation when it reopens: **NOT** an integrations
  health board, which goes stale and then lies and which Stripe/Twilio/Resend's own dashboards plus
  Sentry already beat on truthfulness. The narrow version that would pay is a config-PRESENCE board:
  which env vars are actually SET on Render and Vercel, presence only, no values, no health checks.
  That is the one fact neither Dallas nor Claude can see today, and it is a standing debug tax.
- **Ideas, unscoped.** Referral program. Admin permissions / manager-toggle framework. Contractor
  onboarding flow audit. AI responder for staff SMS. Google Reviews monitoring + staff review-forward.
  Newsletter and seasonal campaigns. Thumbtack auto-draft becoming auto-send. Auto-assign weights as
  one slider instead of two "should sum to 1.0" inputs. Editable env-shaped settings (deposit amount,
  admin SMS phone, notification email) behind a real settings table. A `/capture` command to distill a
  wrapped thread into this ledger in one keystroke.

---

- **Cal.com V2: self-host, brand, embed.** Cal.com V1 (hosted SaaS, webhook into `consults`) is live
  and working; the consult call bridge (spec `superpowers/specs/2026-08-25-consult-call-bridge-design.md`)
  builds on it unchanged. What Dallas and Claude talked through and have NOT designed: run Cal.com
  ourselves on the always-on office box (Docker + Postgres + public ingress + TLS, cut the webhook
  secret and `CAL_BOOKING_URL` over), brand the booking page (domain, logo, colors, no Cal.com
  chrome), and embed it somewhere ours (marketing site, client portal, or the drink-plan nudge
  flow). Ordering agreed 2026-08-25: after the call bridge ships. Before cutting a lane, weigh the
  hosted Teams plan (branding + custom domain for a monthly fee) against exposing a home box to the
  internet; that trade-off has not been decided. The 2026-05-26 Cal.com spec section 14 lists the
  rest of the deferred V2 items (calendar-entry enrichment, consult admin view).

## Operational tails (not builds)

- **Zul's W-9 on file is a screenshot** — `payment_profiles.w9_filename` for user 2 is
  `"Screenshot 2026-01-29 at 14.14.51.png"`, the identical filename as her headshot, so the slot
  almost certainly received a mis-upload. Dallas is chasing the real one offline. **Standing tripwire:
  no 1099 run while that value is a .png.** Worth sweeping `payment_profiles.w9_filename` for other
  non-PDF entries at the same time.
- **`API_URL` is unset in Render**, so `urls.js:13-15` falls back to `RENDER_EXTERNAL_URL` and
  operator links are built on the bare `*.onrender.com` host. Both work and this link only goes to the
  operator, but an unfamiliar hosting domain arriving by SMS is exactly what a phishing link looks
  like, and any future client-facing server-rendered link (unsubscribe already routes through the same
  helper) inherits it. Set `API_URL=https://api.drbartender.com`. No code change.
- **Stale Vercel preview branch `preview/claude/change-admin-password-IQlVD`** (archived) plus its
  matching git branch. **Deletion approved 2026-08-14; execution owed to Dallas** — a Claude push hit
  the pre-push-hook timeout and the permission classifier blocked the hook-skip form. One-liner:
  `! HUSKY=0 git push origin --delete claude/change-admin-password-IQlVD` (a deletion ships no code).
- **Local Postgres password from the pre-rebase leak** (commit `885b074`, scrubbed from history) was
  never confirmed rotated. Cheap insurance.
- **CC seniority mapping**: generation → hand review → `--apply`. Human-gated, Chicago box.
- **No admin UI exists to edit `service_addons` descriptions**; live client-facing copy is still
  changed only by ungated `schema.sql` UPDATEs.
- **Two unmerged branches that must NOT be scrapped.** `current-date-shift-visibility` holds 2
  unmerged commits (`18768c72`, `bd99638d`) touching 13 files, four of them new test files worth ~820
  lines; `shift-closure` holds 3 unmerged commits. Verify what is still live before merging — main has
  moved a long way since. Any salvage now touches `server/routes/staffPortal.js`, which is
  sensitive-listed, so the merge is a mandatory stop-and-ask rather than an ordinary textual
  resolution.
- **Owed walkthroughs** live in `docs/walkthroughs-owed.md`, not here. That includes Dallas's admin
  two-skin House Lights eyeball, the press-1 listen, the Pixel walk, and the staff-hub walk.

---
---

# Settled — do not re-raise

One line each. These exist to stop a lane being opened, not to record history.

- **There is no manual event creation, by design** (Dallas, 2026-08-25). *"Real bookings I don't
  want to build a proposal for."* An event now exists only via a proposal that gets paid. `POST
  /shifts`, the Events-dashboard create form, and the legacy staffing form were all removed
  because the route fabricated a `confirmed` proposal at `total_price 0` with an empty
  `pricing_snapshot`, which is what made manual events wrong on every downstream surface. Do not
  rebuild a create-event door, and do not read the missing button as a regression.
- **The dev box talks to LIVE Stripe on purpose** (Dallas, 2026-08-19). *"I need to be able to do
  stuff from this box."* A `NODE_ENV` gate was built and REMOVED, and a test pins the decision so
  re-adding it reads as a product change. **Do not propose test keys for this box either** — that was
  tried and produced a live-money foot-gun (a stale `STRIPE_TEST_MODE_UNTIL` reads as "configured for
  test" and silently means LIVE).
- **An empty staff pay card is fine.** When no `pay_periods` row covers today there genuinely is no
  payout for that week yet. Do not build the `admin/payroll.js`-style fallback.
- **An honored SMS opt-out is not an operational problem.** *"She shows up for her shifts. The whole
  point of being able to opt out is opting out."* Do NOT build a Needs-attention surface flagging
  staffed-but-`sms_enabled=false`; a dashboard that flags people for opting out is a worked-around
  opt-out.
- **Tip signs are per-bartender and settled.** Never raise shared-bar or pooled-QR sign designs.
- **The 312 stays in staff auto-replies** (Dallas: *"312 is still being used"*). The 312 GV is staffed
  and remains the human-contact line for STAFF; clients get the 1922. Revisit only if the 312 retires.
- **The gratuity double-intent edge stays documented-as-accepted.** Protect-working-paths: the
  machinery is freshly reworked and prod-verified, no double-charge has ever occurred, and the edge is
  self-announcing and cleanly refundable. Revisit only if it actually bites.
- **The Field Guide contest copy stays as it is** (Dallas: *"I missed it. No need to change copy."*).
  If the contest is still at zero payouts in a few months, that is when it becomes a live question.
- **Classes are ON HOLD** pending a full rework of structure and design — no restyle, no new pages, no
  class work until that project opens.
- **The staff payment system umbrella is RETIRED as superseded.** Only 1099 generation survives, in
  its own right.
- **`communication_preferences.email_enabled` was dropped, not wired** (Dallas: *"drop"*). Accepted
  cost: there is no system-wide email mute at all, and the marketing-scoped controls cannot reach an
  `operational` send. Do not re-propose either half.
- **`PATCH /api/proposals/:id` gets no rate limiter.** The threat needs valid admin credentials, the
  client-fan-out paths are already throttled, and a 10/min trip on the busiest editor endpoint costs
  more than it protects. Revisit only if manager accounts multiply or a portal writes through it.
- **No `min_locked_cents` floor** (Dallas, 2026-08-07). Remove-then-lower flexibility is deliberate and
  the audit trail suffices.
- **Specs are POINT-IN-TIME records and are not retro-edited** to track code that moved afterward
  (Dallas: *"not worried about the spec once the item has been built and off living its best life"*).
  Applies to every spec in the tree.
- **Never add `accepted` to `SWEEP_STATUSES`** — the refund demote ladder parks refunded-to-zero
  bookings there.
- **Do not advertise the absence of tonic and bitters on the NA package** (Dallas: *"nobody cares...
  its an NA package"*). Just stop stocking them.
- **NA beer is named at BRAND level only, never varieties** (Athletic, not "Upside Dawn / Free Wave").
  Athletic's lineup changes; variety names in catalog copy read as a menu we then fail to honor.
- **Do NOT roll extension payments into `amount_paid`** — see the extension revenue reference above.
- **Do NOT run a `planner_version` re-backfill.** The v2 wizard shipped in the same push as the
  column, so prod drafts are never mis-versioned; a re-backfill would flip genuine v2 drafts onto the
  legacy wizard and strand their crowd/day-of answers.
- **Do NOT add a `smoked-salt` par row** (Dallas: *"smoked salt can die. We don't have it and don't use
  it."*). The resolver defect is real but goes dormant once no recipe asks for the ingredient.
- **`parsePositionsCount`'s `|| 1` is load-bearing, not a bug.** It feeds four unstaffed filters and
  counters, so a literal `0` for an empty roster would read as FULLY STAFFED and silently hide every
  such shift from all four surfaces at once.
- **The blank revenue chart is PROTECTIVE.** Do not make it render at `n === 1` without fixing the
  query — see the entry above.
- **Do NOT resolve `DRBARTENDER-SERVER-21` as noise.** It correctly reports a real gap. Duty accrual
  in `open` periods only is final (Dallas: *"blessed"*): a skip is loud but still saves the attribution
  fact, which the sweep-before-payroll picks up. No 409, no `reopened` acceptance.
- **`WILDLIGHT-E` is not an outage.** Designed telemetry of a handled condition (Neon idle-kills
  pooled connections while Vercel has the lambda frozen; the listener logs and `logger.warn`
  unconditionally pipes to Sentry). 0 users impacted on all events. Archived-until-escalating, which
  keeps the tripwire. Do not re-flag it from a Sentry glance.
- **Lifecycle states (`confirmed`/`completed`) are never demoted** on a price increase. Pinned by
  `proposalStatus.test.js:33`.
- **The manager iCal in `calendar.js` is intended** — manager is treated as admin at `:348`, `:488`.
- **Empty v1 tables** (`legacy_cc_raw_imports`, `cc_import_runs`, `cc_import_phase0_failures`) stay as
  harmless scaffolding.
- **The `MAX_OPTIONS = 3` cap question was RETIRED by design, not answered.** Do not ask Dallas for a
  new cap number.
