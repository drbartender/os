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

### Dallas's 2026-09-22 drop, where each of the twelve landed

Triaged against code and prod the same day (2026-09-22). Build order is the order below; the
first three sit above the divider.

1. BEO finalize clicks → SHIPPED 2026-09-22 (lane beo-approve-is-review, `3934cffc`, pushed 2026-09-24); residuals under Potions → Derived BEO finalize follow-ups.
2. "Copy compare link" bounces the client to the sign page → SHIPPED 2026-10-02 (`a43f864e`, quick fix on main).
3. Margarita salt lands at four or more containers → SHIPPED 2026-10-05 (`addd55ad`, lane recipe-qty); follow-ups under Potions.
4. Supplies chip is grey on the desktop events list → SHIPPED 2026-10-06 (`7a1aa28b`, lane admin-ui-batch; info blue, Bar stays grey, phone untouched).
5. Show when an event was booked → DROPPED by Dallas 2026-10-06 (the message history covers it). Shipped instead in `7a1aa28b`: the desktop Events list prints the balance due date under an owed Status chip, red once past due.
6. Admin cannot download the menu print file → SHIPPED 2026-10-06 (`7a1aa28b`).
7. "Package details" never shows what is in The Foundation → SHIPPED 2026-10-06 (`7a1aa28b`).
8. Planner answers beside the shopping list → Potions.
9. Fresh-squeezed juice add-on → Potions (needs a rate from Dallas).
10. Staff opt-in for "menu is ready to print" → Staff, shifts, and the roster.
11. Additional clients on a proposal → Unbuilt projects (design call first).
12. Review request research → Unbuilt projects (the funnel numbers are there).

---

# ▲ OWED — these can bite

Ordered by how close each one is to actually costing money or a client.

### The whole ledger, one screen

| # | what breaks | reachable today? |
|---|---|---|
| 1 | A bank refund that fails at the bank leaves a succeeded row (and a docked bartender) | no (no bank refund has failed yet) |
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
| 1 | The Enhancement Lab can delete an ADMIN-added shelf addon and shave the contract by its full price | not today (prop 607 becomes reachable the moment plan 102 is submitted) |
| 1 | A client re-quotes around an admin surcharge on the public wizard, and booking archives the surcharged one | **yes, it happened: prop 883 skipped $125 on 9/25** |
| 1 | An advance duration change bills nothing on a booking with an override | **yes: 606, 607 and 608 are confirmed and carry one** |
| 1 | An editor tab left open across an on-site settle writes the old hours back | rarely: a tab open across the settle; one extension ever (842) |
| 1 | The on-site extension quotes the v4 formula whatever the client signed | yes on a hosted package; on the Core Reaction the package rate matches |
| 1 | An extension invoice can be paid by bank debit, which cannot settle during the event | unknown, NOT TRACED |
| 1 | An on-site extension of a class bills nothing for the class | no (0 upcoming class bookings); PRICING.md documents it, so this is a choice to confirm |
| 1 | A paid extension the webhook failed to settle is recovered by the admin override, which mislabels it | no, until a settle fails (never has) |
| 1 | The added-time rate a client signs to is not locked: a catalog rate change moves it for signed clients | no, until an extra-hour rate is changed |
| 2 | The emailed compare link still lands on the old page | **yes — 9 of 13 groups never chose** |
| 2 | The sign 409 still says "already been accepted" for an archived proposal | yes, from a tab open before the sweep |
| 2 | The planner quotes pre-batched at a rate it does not bill | **yes** |
| 2 | The v1 planner under-quotes parking | **yes — v1 drafts still live** |
| 2 | A client's line item renames itself on a no-op fold | yes |
| 2 | The compare card jumps on the client's first tap | no (0 affected rows) |
| 2 | The shopping list says to buy a syrup DRB is supplying | yes — **PARKED by Dallas** |
| 2 | Signed documents do not say who is covered | yes — **blocked on the broker** |
| 2 | A Lab syrup strips unrelated items off the shopping list (ginger takes the ginger beer) | no (0 plans have picked a Lab syrup) |
| 3 | An unsubscribed lead can be resurrected by capitalisation | yes |
| 3 | A campaign keeps mailing someone who unsubscribed mid-send | yes, on a long send |
| 3 | CSV lead import loses rows and reports success | yes |
| 3 | A caller can hit silence, or "an application error has occurred" | yes |
| 3 | Nobody has listened to the nine voice mp3s | unknown — that is the point |
| 3 | A placed-but-carrier-failed lead call is a quiet miss | yes |
| 3 | Thumbtack's card-declined wall reads as `lead_not_found`, so a lead stop is quiet | **yes: leads 417, 431, 436 (9/24, 10/1, 10/4)** |
| 3 | A corrected email address stays marked bounced, so the client's emails keep vanishing | no (5 bounced clients on prod, none with an upcoming booking, 10/06) |
| 4 | The staff brief's consult card prints a custom drink as `[object Object]` | **yes: 2 upcoming bookings carry one (10/06)** |
| 4 | The next-shift card and the CANT/CONFIRM text can name different shifts | no (checked 10/06: no live shift runs past midnight) |
| 5 | `applyPackageLineup2026` cannot run — two gates open | blocks the run |
| 5 | Leads 322-327 still read `failed`; backfill to `sent` after an inbox check | no |

---

## 1. Money paths that produce a wrong number

**Read this first — it is the root cause of the two entries beneath it.** An invoice does not
record whether its money is inside `proposals.total_price`. Every classifier is therefore a
proxy, and three different implementations have each been wrong on a different real prod row.
The fix that closes both at once is a boolean set at mint time by each of the six `createInvoice`
callers, plus a hand backfill of the few ambiguous existing rows; `sumOffContractPaidCents`
then becomes a single column read, correct by construction. Same root cause as the pulled
invoice-derivation rewrite — **do them together, provenance first.**

### ~~Refunding a true overpayment shrinks the contract~~ — CLOSED 2026-09-15

Fixed in the refund-scope lane (spec `docs/superpowers/specs/2026-09-15-refund-scope-design.md`).
The admin now picks the money rule on the payment panel: `'overpayment'` returns money held beyond
the contract and leaves `total_price` alone, `'contract'` keeps the historical Approach-A
correction. The scope was already honored by `applyRefundReconciliation` and already carried on the
row for webhook and sweeper adoption; the panel path was the caller that never said which.

**Why the 2026-07-26 attempt failed and this one does not.** That one derived the excess inside
reconciliation as `amount_paid - total_price`, which counts a paid Drink Plan Extras or manual
invoice as overpayment and then subtracts it twice. Nothing is derived inside reconciliation now.
The cap and the checkbox default come from `overpaymentCents` (`refundHelpers.js`), which nets
`sumOffContractPaidCents` out, the same formula cancel-line has used since 2026-07-24.

**Two rules the design fleet added before any code was written** (both are money-path law now):
- Overpayment scope consumes the payment's UNCREDITED headroom before walking invoice links.
  `linkPaymentToInvoice` caps an invoice credit at that invoice's remaining due while the webhook
  rolls the whole intent into `amount_paid`, so an overpaying payment is part-credited. Reversing
  credited money for cents that were never on an invoice left a LOCKED invoice demanding money on
  an unchanged contract. The old rule was correct only for cancel-line, where `refreshUnlockedInvoices`
  had already corrected the demand in the same transaction.
- The cap is asserted under the proposals row lock in the transaction that writes the pending row,
  so two concurrent submits cannot both spend the same excess and drop `amount_paid` below
  `total_price` (which would demote the status and disarm autopay).

**Prod 784 was healed the same day** through the existing stale-pending sweeper (a pending
`overpayment` row for the dashboard refund, adopted by unique amount): `amount_paid` 900 to 500,
`total_price` still 500, both invoices untouched.

**The related cancel-line note is closed too.** After a FAILED cancel-line refund the dialog sends
the admin to the payment panel; that panel can now issue `'overpayment'` scope, so it no longer
lowers a total the fold already corrected. A manual Stripe-dashboard refund is still fine, and the
`refund.created` webhook now actually reconciles it (see below).

### A bank refund that fails at the bank leaves a succeeded row (and a docked bartender)

Opened 2026-09-15 by the refund-scope lane, deliberately not built there. `refund.created`
reconciles a refund at `pending` as well as `succeeded`, because a bank refund sits pending for
days and that is what the stale-pending sweeper already adopts. If the customer's bank returns it,
Stripe fires `refund.failed`, which nothing subscribes to and no handler reverses: the
`proposal_refunds` row stays `succeeded`, `amount_paid` stays lowered, and the client shows as owed
money that never left. For a TIP the same event docks a bartender permanently: `clawbackTip` only
moves `tips.refunded_amount_cents` FORWARD (the dispute-won rewind is the sole reversal path).

Same shape as the bank-debit-in-flight problem closed 2026-09-14: an event nobody subscribed to,
a state nobody could see. The fix is a `refund.failed` subscription plus a reverse reconciliation,
which does not exist in any form today. Exposure is low and bounded (bank refunds are rare here,
and a returned one is visible in the Stripe dashboard), but it is silent, which is what makes it
worth writing down.

### Smaller refund residuals, all opened 2026-09-15

- **The client refund notice ignores the admin's notify-client answer on any adopting path.** The
  panel asks "email a refund notice?" and passes the answer to the route, but the answer is not
  carried on the `proposal_refunds` row, so the stale-pending sweeper (which adopts rows whose
  in-app reconciliation failed) emails unconditionally. Pre-existing; the new `refund.created`
  handler sidesteps it by staying silent for any refund carrying a `proposal_refund_row_id`, so its
  failure mode is a MISSED notice rather than an unwanted one. A real fix needs the answer on the
  row, i.e. a schema change.
- **A dashboard refund on a partially-overpaid proposal lands `contract` and over-shrinks the
  total** by the excess portion. Scope is binary and the alternative (leaving the total too high)
  fires reminders at a client who owes nothing, so the handler picks contract and raises a Sentry
  warning naming both figures; the admin corrects the total in the editor.
- **`applyRefundReconciliation`'s (intent, amount) pending heuristic is now unreachable.** Every
  caller passes an explicit `pendingRowId` or `allowPendingHeuristic: false`. It was flagged in the
  2026-07-26 push review as able to rewrite a refund's money semantics in either direction.
  Removing it is a small, safe follow-up.
- **The overpayment cap nets only PENDING OVERPAYMENT refunds.** Two other writers move the same
  money and are invisible to it: a concurrent contract-scope refund whose charge is linked to a
  non-contract-labeled invoice (it drops `amount_paid` without dropping `total_price`, so it
  consumes excess), and a cancel-line fold (which computes its own figure and deliberately does not
  enforce the cap). Both need genuine concurrency on one proposal. The failure lands in the safe
  direction: `amount_paid` below `total_price` demotes the status and disarms autopay, recoverable
  in the editor, and the per-charge headroom plus Stripe's own cap still make it impossible to
  return more than the client paid. Closing it means netting the non-contract portion of pending
  contract rows, which needs the invoice labels behind each pending row.
- **Three files crossed the 700-line soft cap in the refund-scope lane:** `refundHelpers.js`,
  `ProposalDetailPaymentPanel.js` and `stripe.js` (run `npm run check:filesize` for current counts). None is near the 1000-line hard cap,
  but `refundHelpers.js` now carries the planner, the reconciler and four derivation helpers, which
  is the natural split line (a `refundDerivations.js` for the netting and headroom functions).
- **`proposal_refunds(payment_id)` has no index.** Three subqueries filter on it (the pre-existing
  `remainingCents`, plus the new `uncreditedCents` and headroom reads), and Postgres does not
  share the two identical subplans, so the lane doubles the per-row scan count. The table holds 8
  rows in prod and grows a handful per year, so this is textbook rather than real. Deliberately NOT
  added in the refund-scope lane because that spec decided no schema change. `CREATE INDEX IF NOT
  EXISTS idx_proposal_refunds_payment_id ON proposal_refunds(payment_id);` when it ever matters.

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

Blast radius: the 2026-08-25 snapshot counted 13 proposals since 2026-07-02 (~$4,605); the
backfill's shape query reaches back further and finds 26 by shape, 25 to apply (2026-08-28
dry run), and that query supersedes this list. The named 13: 770 Meg Henke $325 · 767 Karen Habenicht $200 · 713 Anthony Holter $250 · 675 Angelo
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

### Proposals sent without a `sent_at` are invisible to the Money Board

29 non-draft proposals have `sent_at IS NULL`, so `qSent` (`metricsQueries.js:210`) and
`qWinRate` (`:244`), both gated on `sent_at IS NOT NULL` (`:220`, `:257`), never count them.
They are not drafts: 20 have a nonzero `view_count` (the client opened the proposal) and 6
reached `completed`/`deposit_paid`/`balance_paid`/`confirmed`, so the event ran and the money
landed. Measured 2026-08-25 against prod.

Cause: the one-time backfill at `schema.sql:2624` sources the timestamp from
`proposal_activity_log` where `details->>'to' = 'sent'` (`:2629`), so the
`UPDATE ... WHERE sent_at IS NULL` at `:2631` skipped every row with no such transition logged.
The column is stamped going forward by `proposalSend.js:49`, `proposalSendGroup.js:148` and
`lifecycle.js:99`, all `COALESCE(sent_at, NOW())`, so the gap is NOT purely historical: 3 of the
29 were created in Aug 2026, meaning at least one live send path reaches `viewed` without
passing through those three writers.

Impact is reporting-only, no client is billed wrong. The 2026 quoted count reads 613 instead of
~642, and the win-rate denominator is short by these rows while the numerator
(`accepted_at IS NOT NULL`) is not, so the rate reads high.

Two halves, and the second is the real one: backfill the 29 from the best available proxy
(`MIN(proposal_activity_log.created_at)`, else `created_at`), but FIRST find the send path that
leaves the column null or the backfill just re-accrues. Start by diffing the three writers above
against whatever moved ids 628, 681 and 764 to `viewed`.

---

### The Enhancement Lab can delete an admin-added shelf addon and shave the contract

Lab ownership lives only in `drink_plans.selections.addOns[slug].labAdded`; the lab PUT's
collision guard (`lab.js`, "Planner already carries this slug") reads those selections and never
`proposal_addons`. So a shelf addon an admin priced on the editor (`champagne-toast`,
`champagne-coupe-upgrade`, `real-glassware`, or the hosted NA trio) with no selections entry is
OFFERED by the lab: ticking it marks the contract row `labAdded` (and the upsert rewrites it at
catalog rate, quantity 1); unticking it lands the slug in `removedSlugs` and the DELETE removes
the contract row, so the fold prices the after leg without it and `total_price` drops by the
addon's full price. A crafted submit can plant `labAdded` directly (`submitSanitize` copies addon
metadata raw). Once paid covers the shaved total the reconcile ladder now reads `balance_paid`,
so the under-billed row looks clean instead of odd. Found by the 2026-09-16 security review of
the ladder change; pre-existing.

**Exposure measured 2026-09-16:** two future booked proposals carry an admin-added shelf addon
with no lab entry, both `soft-drink-addon`: 606 (v1 plan, the lab is v2-only, unreachable) and
607 ($350 line, v2 plan 102 still `pending`, so the lab is not open yet). Reachable the moment
plan 102 is submitted.

**Fix (lab.js + submitSanitize.js):** load `addonsBefore` before the selections rebuild and treat
any slug present there without a `labAdded` flag as admin-owned (never accept it as lab-added,
never put it in `removedSlugs`); strip `labAdded` in `sanitizeSelections` (server-owned flag).
Test: "contract addon survives tick-then-untick" in `lab.test.js` (its :339 case covers
planner-owned entries only).

---

### A client can re-quote around an admin surcharge, and booking archives the surcharged proposal

Happened 2026-09-25 (client 1948, event 9/26). Thumbtack proposal 880 went out at $475: $350
Core Reaction plus two hand-added `adjustments`, Rush Booking Fee $75 and Travel Fee $50. The
client opened it twice, ran the public quote wizard twice (882, 883, both $350 at catalog with
no adjustments), opened 880 once more, then signed and paid 883 in full ($350 + $150 no-jar
gratuity = $500). Inside that settle, `sweepClientAlternatives` (`proposalGroupCommit.js`)
archived 880 and 882 as `option_not_chosen`. The $125 was never billed and nobody was told.

Two gaps. `POST /public/submit` (`public.js`) matches the client by email/phone and then mints a
`sent`, immediately bookable proposal at catalog price without looking at that client's open
admin-priced proposals. And the sweep archives a proposal carrying admin `adjustments` with no
admin alert. Nothing charges a rush fee automatically either, so the wizard books a next-day
event at list even though `last_minute_hold` already knows it is last-minute.

Fix shape needs Dallas's call. Candidate: when the matched client has an open
(`sent`/`viewed`/`modified`) proposal with non-empty `adjustments`, mint the wizard proposal as
`draft` and alert admin, or email the existing link to the on-file address (never hand its token
to the unauthenticated submitter). Separately, alert admin whenever the sweep archives a proposal
with non-empty `adjustments`.

### An advance duration change bills nothing on a booking with an override

The admin PATCH carries the stored `total_price_override` through a duration change and
`calculateProposal` substitutes the override for the calculated total, so lengthening a booking
that has one adds $0 for the added time at any hour. Package hours, over-included bartenders and
time-priced add-ons are all swallowed; only the client Gratuity line moves, because it sits on
top. A surcharge adjustment is swallowed too and still prints as a line. The editor gives no
sign of any of it. The on-site extension is not affected: it prices from the catalog.

Reachable on three confirmed bookings, all Check Cherry transfers whose override is the old
contract total: 606 (10/17), 607 (10/22), 608 (2027-08-21). 607 moved from 5h to 6h would add
$0 where the catalog adds $575. Not specific to the transfers: the Thumbtack auto-draft writes
overrides as well, and 756 (event 10/24, `viewed`, unpaid) carries one now.

The manual recipe is in `docs/ops-runbook.md` §8.1 (lane agreement-v4). Fix shape: when a save
changes duration and an override is set, show the catalog difference beside the override field
and move the override by it, the way `foldExtrasIntoProposal` already does for extras. Needs
Dallas's call on automatic versus one click.

### An editor tab left open across an on-site settle writes the old hours back

After a paid extension settles (the row moves 4h to 5h), a proposal editor loaded before it can
save any field and send back the 4h it loaded. The PATCH has no stale-write check
(`server/routes/proposals/crud.js`, `patchContractHours.js`), and the pending-request guard no
longer applies once the request is paid, so the row and the single shift go back to 4h with a
200. The contract price holds: `contractDuration.js` clamps to the first settled extension's
contracted hours and pages Sentry, so nothing is re-billed. What breaks: the worked hours, the
shift end and the curfew read 4h; payroll seeds wages from 4h only when no wage line existed at
settle; and a second extension the same night prices from 4h and bills the paid hour again.
Older than the ext-contract-hours lane, which made it safer. Fix: the editor sends the duration
it loaded and the PATCH answers 409 when the stored duration no longer matches (the cancel-line
fingerprint pattern), which still lets the runbook's deliberate hand revert through. Found by the
2026-09-30 push-time review (second opinion, database and code seats).

### The on-site extension quotes every client the v4 formula, whatever they signed

`computeExtensionDelta` reads no signature column. v3 Section 8.1 promised $100/hr for the lead
bartender plus $40/hr for each additional bartender, added to the final invoice. The extension
quotes the package's extra-hour rate (per guest on a hosted package), the sub-100-guest
surcharge, time-priced add-ons and gratuity, on a separate invoice paid before service
continues. The terms the client accepts on that invoice (`extensionTermsCopy.js`) read "under
your existing agreement" and "same terms".

All 17 upcoming bookings signed here are v3 on the Core Reaction, where the package rate is
$100/hr either way. The two upcoming hosted bookings (606, 607) have no signature recorded here.

Owner decision, two parts. Whether a v3 signer is held to the quote they accept on the spot or
billed the v3 rate; there is no verified way to bill the v3 rate by hand yet (see the entry
above on the editor save). And whether the extension terms should stop saying "same terms" once
v4 is what clients sign. Raised by the agreement-v4 consistency check, 2026-09-29.

### An extension invoice can be paid by bank debit, which cannot settle during the event

An extension invoice is paid through `create-intent-for-invoice`, which offers
`CHECKOUT_PAYMENT_METHOD_TYPES`, bank debit included. The extension settles, and the bartender
is cleared, on payment success. A bank debit takes business days to succeed, so a client who
picks it at the bar cannot be cleared that night; the expiry sweep then voids the invoice.

NOT TRACED, and that is the work: what the sweep's `cancelOpenInvoiceIntents` does to a debit
already `processing` (Stripe does not cancel those), and what the success webhook does days
later with a payment for an expired request. If the money lands against a voided invoice the
client paid for time they were refused. Likely fix: card and link only on an extension invoice,
the way the payment-link rail already drops bank debit.

### An on-site extension of a class bills nothing for the class

All six class packages carry an extra-hour rate of $0 (prod, 2026-09-29) and `calculateStaffing`
zeroes class staffing, so an added hour prices at add-ons and gratuity only, and a $0 extension
settles on acceptance alone. The request route reports `isClass` and does not refuse it. The
instructor is paid for the hour. `PRICING.md` already states it ("a package whose extra-hour rate
is $0 (every class today) extends for free"), so this is documented behavior, not a defect. Filed
so the free hour is a choice: a rate from Dallas, a refusal on class shifts, or leave it and
delete this entry.

The v4 page adds two things to decide with it (push-time review 2026-09-30). `additionalTimeRate.js`
returns no line for a class before it looks at the rate, while the bill has no class exemption,
so the day a class gets a rate the extension bills it and the signing page prints nothing: delete
that early return and the page follows the bill. And v4 Section 8.1(b) applies to a class and
points at a rate "as stated in the Event-Specific Agreement" that a class page never states.

### The added-time rate a client signs to is not locked at signing

Agreement v4 Section 8.1(b) bills hosted on-site time at "the package's per-guest extra-hour
rate, as stated in the Event-Specific Agreement", and the proposal page now prints that rate
under the Total (lane agreement-v4, 2026-09-29). Both the line (`additionalTimeRate.js` through
the public payload) and the extension invoice (`computeExtensionDelta`) read the LIVE
`service_packages` row. Nothing freezes the rate on the proposal. Change a package's extra-hour
rate and every already-signed client of that package is shown, and billed, the new one. The
Core Reaction's $100 and the $40 extra-bartender rate are also written into the agreement text
itself, so those two need a new agreement version in the same change.

Not reachable until a rate changes; catalog pricing columns are SQL-only (`routes/packages.js`
does not write them) and the pending 2026 lineup script does not touch them. Decided 2026-09-29
to ship the line unlocked rather than widen the lane into two money paths.

Fix shape, its own lane: write the rate into `pricing_snapshot` at price time (the engine already
carries `billed_guests`), render the line from the snapshot, and have `computeExtensionDelta`
bill the snapshot's rate when present. A snapshot is regenerated on every admin re-price, so
"locked" would mean "as of the last re-price", the same as the base price today. Existing open
proposals would need a backfill or a live fallback. Do this BEFORE any extra-hour rate change.

### A paid extension the webhook failed to settle is recovered by the admin override, which mislabels it

Decided 2026-09-30 with the contract-hours lane (`0440c773`): recovery for a stranded paid
extension goes THROUGH the request, never through a duration edit, because a hand-moved hour is
contract time and bills the client again on the next save. The only through-the-request tool
today is `POST /service-extensions/:id/override`. On a paid invoice its void is a no-op and the
money is right, but the row reads `overridden` and the activity log records an amount waived on
an extension the client paid. The runbook ("Service Extension refunds > Stranded paid
extensions") and both alert strings point at it.

Not reachable until a settle fails, which has never happened (one extension has ever run).
Build when it does: an admin "settle as paid" action that runs what the webhook would have
(`settleExtension({ outcome: 'paid' })`, `applyExtensionHours`, the staff greenlight,
`finalizeExtension`), guarded on the invoice being `paid`. That means extracting the webhook's
post-settle tail (`paymentIntentSucceeded.js`, about lines 740 to 770) into a shared function,
which is why it was not done in the same lane. The expired-with-paid case additionally needs a
guarded re-open to `pending` (today: the SQL in the runbook).

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

Second, narrower defect in the same function: its duplicate guard is an exact name match, and
three `SYRUP_NAME_LOOKUP` labels do not match their catalog rows. A self-provided grenadine lands
as "Grenadine (Pomegranate) Syrup" beside a recipe's "Grenadine"; orgeat as "Orgeat (Almond)
Syrup" beside "Orgeat"; vanilla-bean as "Vanilla Bean Syrup" beside "Vanilla Syrup". Resolve the
self-provided syrup through the catalog alias index instead of building a label.

### A Lab syrup strips unrelated items off the shopping list

`refreshListAfterLabChange` (`server/routes/drinkPlans/labListRefresh.js`, the lab-syrup strip)
drops every line whose normalized name CONTAINS a picked Lab syrup's name. It is a substring test,
not an item match: a Lab ginger syrup strips Ginger Beer, the mule's mixer, along with any ginger
syrup line; pineapple strips Pineapple Juice; mint strips Fresh Mint; espresso strips Cold Brew
Espresso. The client is then never told to buy a mixer their menu needs. No prod plan has picked a
Lab syrup yet (0 rows with `labSyrupSelections`, checked 2026-09-30), so nothing is wrong today;
the first Lab ginger pick on a mule menu is.

Fix: strip only the syrup's own line. Compare against the exact `"<Name> Syrup"` label that
`addSelfProvidedSyrups` writes, plus the catalog syrup row a recipe resolved to (resolve through
the alias index, never `normalizeName(label).includes`). Found by the review of the shopping-list
duplicate-line fix, 2026-09-30.

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

### A signed-but-unpaid client keeps getting the unsigned-proposal drip, and Stop cannot reach it

Signing sets `status='accepted'` (`publicToken.js`, the sign UPDATE) and suppresses no drip rows;
only sign-plus-pay does (`onProposalSignedAndPaid`). At send time the drip handlers refuse only
`archived` (`marketingHandlers.js` loadHandlerContext, `dripSmsHandlers.js` loadDripSmsContext), so
a client who signs and abandons checkout keeps getting "Did you get the proposal?" through touch 5.
The new Stop follow-ups button (`630f1ed3`, live 2026-09-24) cannot reach it: its route header
claims a signature stops the drip, but `OPEN_STATUS_LIST` is sent/viewed/modified, so the button is
hidden on an accepted proposal, a direct POST answers 409 DRIP_NOT_ACTIVE, an accepted sibling is
left out of the whole-event stop, and `hasLiveSiblingDrip` ignores an accepted option's live touches
(a second option sent solo beside one enrolls a second drip, the shape `c07be1eb` was opened for).
Pre-existing send behaviour; the batch made it reachable from the button. Fix at the sign, where
the scheduler's own allowlist already excludes accepted: suppress `drip_touch_%` pending/deferred
rows in the sign transition (one call), and let the stop route and the sibling check treat
accepted as drip-live until then. Found by the 2026-09-24 push-time fleet (code-review and
consistency lenses), verified by hand.

**Same family, narrower, same lane:**
- **The stop stamp is never read at send time.** `drip_stopped_at` is checked only at enrollment
  (`scheduleDripForProposal`) and at hand-off. Stop suppresses `pending` and `deferred` rows; a row
  in `processing` when Stop commits is skipped and can come back (the cooldown defer parks it
  `deferred` for 24h, `releaseClaim` and the 10-minute stranded-claim reaper return it to `pending`),
  and an archive hand-off that read `sib.drip_stopped_at IS NULL` before the stop's commit inserts
  fresh pending touches on a proposal the admin just saw "Follow-ups stopped" on. Fix: in both drip
  handlers, throw `SuppressMessageError('drip_stopped')` when the proposal carries the stamp; the
  handler SELECT already carries the column. Three reviewers (codex, code-review, database).
- **The archive hand-off can resurrect a failed touch at a past time.** `handOffDripToSibling`
  treats only `sent` and `processing` as delivered, so a touch that ended `failed` (terminal) or
  `suppressed_by_sibling` on the archived option is re-created on the survivor at anchor plus offset.
  When that instant is already past, the dispatcher sends it on the next tick, out of order and
  after later touches. Fix: skip any touch type that has a row of any status on the archived option
  (the archive doors delete the pending ones first), or re-create only touches whose computed time
  is still ahead of NOW().

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

### Thumbtack's card-declined wall reads as `lead_not_found`, so a lead stop is a quiet miss

Happened three times: 2026-09-24 (lead 417), 2026-10-01 (lead 431), 2026-10-04 (lead 436). The
card worked again in between each time (leads 432-435 replied fine on 10/4 before 436 hit it), so
it keeps declining rather than being dead. When it declines, Thumbtack redirects pro pages to
`/fullscreen-takeover`: "You're not getting new leads. You've stopped showing up in customer
search results because your card isn't working." `charge_state = 'Pending'` is NOT a usable
signal: lead 433 was `Pending` and replied fine. The agent's reply step finds no CTA, sees a URL
without the negotiation id, and reports `lead_not_found` (`thumbtack-agent/src/index.js`, the
`urlCarriesId` branch). The server marks the reply `failed` and sends the same generic Sentry
warning a lead that genuinely failed to load gets. Nothing says "Thumbtack stopped sending
leads." The email harvest still works through it (the price-estimate page loads) and the day
call still fires.

Fix: read `/fullscreen-takeover` (or an "Update card" button) as its own reason, say
`billing_blocked`, add it to `FIRST_REPLY_FAIL_REASONS`, and send an admin email on it instead of
the warning stream. Captures: `~/.thumbtack-profile/diag/*-no-cta-no-composer.{png,json}`.

### A staffer taken off a shift can still be texted its reminder and its thank-you

Nothing at SEND time checks that the person is still on the shift: `handleShiftReminder` and
`handleStaffThankYou` (`server/utils/staffShiftHandlers.js`) load the shift and the phone and send.
Lane ma-e2 (`91dcfab8`) closed the one path it owned: Remove (`DELETE /shifts/requests/:id`)
now deletes that person's pending reminder and thank-you. Still open:

- every OTHER way off a shift (a drop, an emergency drop, a cover swap, a deny after an approve).
  None was audited;
- a reminder already being sent (`processing`) at the instant of a Remove, or one stranded by a
  dispatcher crash and reaped back to pending ten minutes later;
- a Remove racing a second operator's re-assign of the same person, which deletes the NEW
  assignment's reminder (the assign skips its insert because the old rows are still there).
- a reminder the email quota put off. Remove deletes `status = 'pending'` only, and a staff email
  deferred by the Resend quota sits in `deferred` until the dispatcher flips it back to pending
  (`emailQuotaDefer.js`, `scheduledMessageDispatcher.js`). Every other cancel path deletes
  `IN ('pending', 'deferred')`. Push-time sweep, 2026-09-29.

The reminder carries the proposal's public token in its shopping-list link, so a wrong send is a
small disclosure as well. Prod, read-only, 2026-09-29: 12 reminders and 12 thank-yous are `sent` to
staff who hold no approved request on that shift today (first 2026-05-14, last 2026-09-27). Not
every one is a wrong send: a no-show removed AFTER the event was on the shift when the text went
out, and a hard delete records no time. Zero are pending now. Fix shape: a roster check at send
time, in the two handlers. Found by the ma-e2 browser gate; the database and security reviews
named the remainders.

### Unassign suppresses a staffer's reminders, and assigning them again never brings them back

`POST /shifts/:id/cancel-or-unassign` marks the pending rows `suppressed`, and
`insertShiftMessageIfMissing` counts ANY row on the key as already there, so the re-assign inserts
nothing: the person is back on the shift with no reminder. Remove deletes the pending rows instead
(lane ma-e2, `91dcfab8`), so a re-assign after a Remove queues fresh ones. Fix shape: delete on unassign too, or
let the insert look past a suppressed row. Verified in code during the ma-e2 gate.

### The desktop ShiftDrawer can notify a staffer twice, and any Deny can land on someone just approved

The drawer's Retry after a lost answer re-posts the assign, so the staffer is texted and emailed
again. Its Deny and Remove are not re-read either. And the server's deny is an unconditional UPDATE
(`shifts.approval.js`, the denied branch): a request approved in between (another admin, the
auto-assign scheduler) is denied AFTER its approval text went out, and nobody is told. The phone
re-reads before every write, which narrows that window to one round trip and does not close it.
Fix shape: a deny that refuses unless the request is still pending, and a re-read in the drawer.
ma-e2 Task 6 review; second opinion (codex), verified against the code.

---

### A corrected email address stays marked bounced, so the client's emails keep vanishing

A permanent bounce sets `clients.email_status = 'bad'` (the Resend webhook,
`server/routes/emailMarketingWebhook.js`), and from then on every immediate email to that client is
dropped: `shouldSendImmediate` in `server/utils/messageSuppression.js` returns `bad_contact`, and the
scheduled dispatcher applies the same rule. Correcting the address does not clear it. The editor's
save sends the new address through `PUT /clients/:id` (`server/routes/clients.js`), which updates
name, email, phone, source and notes and never touches `email_status`; the one reset,
`PUT /marketing/contacts/:id/email-status`, has no caller in `client/src`. So after an admin fixes a
bounced address, the client still gets nothing: the automatic gratuity email after a crew change is
suppressed with only a server log line, while the editor's reprice confirm says the client is emailed
"unless their email address is missing or has bounced", which the admin knows is no longer true of
the new address. Fix: reset `email_status` when `PUT /clients/:id` changes the email (the sign route
already resets `phone_status` when a client re-confirms a phone, `publicToken.js`), and give the
marketing route its control on the contact row. Prod, read-only, 2026-10-06: 5 clients carry the
flag, none with an upcoming booking. Lane ma-e3a fold re-review.

## 4. Staff-facing

### The staff brief's consult card prints a custom drink as `[object Object]`

`ConsultCard` (`client/src/components/staff/BeoSections.js`) prints the raw `consult_selections`
JSON that `eventDetailsPayload.js` sends: camelCase keys as labels (`barType: full_bar`,
`mocktailsEnabled: false`), and every custom cocktail or mocktail, stored as `{ name, ingredients }`,
joined as `[object Object]`. The brief's signature-cocktail card reads the planner's `selections`,
not the consult (`ShiftDetail.js`), so on a consult-fed plan this card is where a bartender reads
the consult's drinks, and a custom one has no name. **Reachable: 2 upcoming bookings carry a consult
custom drink (prod, 2026-10-06); 14 of the 23 consults ever saved have one.** The server already
renders this JSON properly for the post-consult client email (`formatConsultRecap`,
`server/utils/consultRecap.js`); render the card by the same rules. Build it with the Potions entry
"Planner answers beside the shopping list", which needs the same consult recap in the admin modal.

### The staffer's next-shift card and their CANT/CONFIRM text can name different shifts

**Reachability, checked 2026-10-06: ZERO.** Shift 353 (2026-10-16, 8:00 PM to 12:00 AM), which
flipped this to "yes" on 2026-08-25, is now cancelled with no approved staff, and it could never have
triggered it: a shift that ends exactly at midnight is finished by the time the two readers start to
disagree. No live shift runs past midnight (end before start, parsed as clock times, not text).

`staffPortal.js` orders the staffer's own next-shift card by the end instant alone;
`findNearestApprovedShift` now leads its ORDER BY with a "not dated before today" tiebreak. Between
00:00 and about 08:00 Chicago the card can show LAST NIGHT's still-unfinished shift while a CANT
or CONFIRM acts on TONIGHT's. **The CONFIRM case is the sharper one:** the staffer reads "your next
shift: A", texts CONFIRM, and `acknowledged_at` lands on B.

It becomes reachable the moment someone is approved onto a shift that ends AFTER midnight, or onto
an evening shift with no end time (the assumed end then runs past midnight).

**Dallas's call, and it is a product decision, not a mechanical fix.** Either make them match (two
lines, `chicagoTodayYmd` is already imported there), or keep the divergence and write down why —
the read path arguably SHOULD show the shift you are standing in. Recommendation: make them match.
The card is labelled "next shift", not "current shift", and stamping `acknowledged_at` on a shift
the staffer was not shown is wrong under either reading. `staffPortal.js` is sensitive-listed and
money-adjacent, so this gets the full fleet.

### The staff shift page's shopping-list card never renders

`BeoSections.js:492` shows `ShoppingListCard` only when `status === 'ready'`, but
`eventDetailsPayload.js` sends `shopping_list_status` as `pending_review` / `approved` / null, so no
staffer on any package has ever seen the card. Either the card was meant to key on `approved` or the
payload was meant to map it; pick one. Surfaced by the hosted-no-shopping-list review, 2026-09-11.

### Cover swaps have no working admin path

Five findings, one cluster, all older than the lane that found them. (1) The swap email's "Approve
swap" button links to `/admin/shifts/cover-swaps/:token`, and the client has no such route
(`grep -rn cover-swaps client/src`: nothing). (2) The desktop `ShiftDrawer` approves a claim
through `POST /shifts/:id/assign`, which never runs `approveAndCascade`, so the original stays
approved with cover still requested. (3) So NO admin screen runs the cover cascade;
`PUT /shifts/requests/:id` with `approved` does, and nothing calls it. (4) The re-request upsert
(`shifts.approval.js`) does not clear `replaced_by_request_id`, so a former claimer's ordinary
re-request still reads as a cover claim. (5) `server/utils/autoAssign.js` lets a ranked list left
from an older request win on a cover claim: a Barback's claim could be auto-seated as Bartender,
with no cascade. Prod has had ONE cover claim ever (request 529, shift 386, 2026-09-19, still
pending). The phone reads a claim by the role written on it and labels it "Covering <name>"; a
swap there is two steps (Remove the original, Approve the claimer). ma-e2 Task 4 review.

### The server accepts an over-fill, and nothing locks the shift

`POST /shifts/:id/assign` seats a person in a role that is already full. The phone re-reads the
roster before it writes, which narrows the window to one round trip and does not close it: a
second admin, a `can_staff` manager or the auto-assign scheduler (`autoAssign.js`) can fill the
last slot in between. The server logs `staffing_overfill`, the roster reads 2/1, and the tip split
counts both. The desktop drawer has no re-read at all. Fix shape: a conditional assign on the
server (lock the shift row, re-check that the role has room), in `shifts.approval.js`, a sensitive
file. ma-e2 second opinion (codex), verified.

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

### Leads 322-327 still read `failed`; backfill them to `sent` after an inbox check

The first-reply verify fix (`ca19198d`, 2026-08-26) has its real-lead proof: 12 leads since 9/25
read `sent` in prod (418-420, 422-430, checked 2026-10-01). What is left is the old bug's residue.
Leads 322-327 delivered but read `failed`. Dallas confirmed 327 (Tanya Flowers) delivered; the
other five are inferred from an identical diag signature, not verified. Eyeball those five
threads in the TT inbox, then backfill to `sent` with a guarded DO block on prod.

---
---
---

# ▼ SOMEDAY — everything below this line is not urgent

Real work, still wanted, none of it able to bite a client or a staffer. Push-review residuals land
here by default.

---

## Money and payroll (internal correctness)

- **OWNER DECISION: a class supply pack pays the $50 hosted duty, not the $20 one.** Class packages
  are `per_guest`, so `isHostedPackage` puts them on the hosted branch of `dutyLines.js`, where any
  flagged add-on money pays `hosted_supplies` at $50. Since the supplies fix (`609158f1`) flagged
  the seven class supply packs, a class of 10 with its supply pack and one instructor accrues $50
  where it accrued nothing. That matches the written rules (the Field Guide's hosted $50, and the
  2026-06-30 staffing spec names the class supply rows), but the approval recorded on the commit
  names only the $20 equipment duty on a bundle event. Prod, read-only, 2026-09-29: no proposal
  carries a class add-on, so nothing is accruing on it. Confirm it before the first class books
  one. Push-time consistency review, 2026-09-29.
- **A reopened pay period can be blocked by a duty that will never pay.** Process runs
  `listUnattributedDuties` on a reopened period as on an open one (`routes/admin/payroll.js`), and
  accrual writes nothing into a period that is not `open` (`payrollAccrual.js`). A bundle event in
  a period processed before 2026-09-28 and reopened later now asks for an `equipment_supplies`
  attribution, Process answers 409 until it has one, and the attributed worker is then paid
  nothing. The design is older; the supplies fix made it reachable. Push-time consistency review,
  2026-09-29.
- **20 completed events hold money that is on neither an invoice nor `external_paid`** (event dates
  2026-04-25 to 2026-09-19). The phone event detail states the total on a "Paid to date" row, as
  the desktop panel's figures imply. The data itself is unreconciled. ma-e2 Task 7 re-review,
  read-only prod query.
- **Invoice line items carry a discount with the wrong sign.** `generateLineItemsFromProposal`
  (`invoiceLineItems.js`, adjustments loop) pushes `toCents(adj.amount)` for every adjustment,
  while `pricingEngine` negates `type === 'discount'`. A $50 goodwill discount renders as a +$50
  line on every invoice built from the snapshot, and the lines sum to total_price + 2x the
  discount, so the deposit-to-full upgrade and the backfill both refuse to regenerate lines on a
  discounted proposal (`generated_sum_mismatch`, old lines kept). Dev has 0 adjustments today.
  Fix in the generator (sign by type), then check the invoice page renders a negative line.
  Found by the 2026-08-28 lane 2 verifier.
- **A full or deposit capture on a `confirmed` row leaves a phantom outstanding balance.** Both
  webhook credit UPDATEs are `WHERE status NOT IN ('confirmed','completed','archived')`, so a
  proposal an admin advanced to `confirmed` (allowed from `accepted`, `lifecycle.js`) with its
  Deposit invoice still open records the payment row but never increments `amount_paid`. Same
  bug M3 fixed for the balance branch (`paymentIntentSucceeded.js` ~288-300); the full and
  deposit branches still have it. The deposit-to-full upgrade declines on `confirmed` for parity,
  so the $100 credit plus overflow email is what happens today. Found by the 2026-08-28 lane 2
  verifier.

- **A stranded PaymentIntent on a restored proposal has no automatic retry path.**
  `healStrandedIntents` (`staleProposalSweep.js`) joins `p.status = 'archived'`, so once a
  proposal is restored out of archived its `pi_cancel_incomplete` marker is never picked up
  again. A marker means a real `cancelOpenInvoiceIntents` FAILED, so there are open Stripe
  intents against an invoice the sweep already voided; calling this cosmetic (as an earlier note
  did) understates it. It only recovers if an admin re-archives by hand. NOT trivially fixed by
  dropping the status join: that would let the heal pass cancel intents on a proposal that is
  live again, which is a live-money change. Prod has zero heal markers today, so it is inert.
  Decide the rule before touching it.

- CLOSED 2026-09-14 (lanes ach-server + ach-client, spec 2026-09-14-bank-debit-in-flight): the settle-page trap on async methods and the create-intent double-mint beside a settling intent. Proposal 784 paid its Balance twice by bank debit before this landed.

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
  deliberately drops that invoice's `amount_due`. RC4 (adopt the caller's own pending row by id) is now applied on
  every path: `refundExecute`, the sweeper, and (2026-09-15) the `refund.created` webhook, which
  reads the row id off `refund.metadata.proposal_refund_row_id` and suppresses the (intent, amount)
  heuristic entirely when there is none. The by-id adoption lookup was hardened on 2026-09-15: the
  reconciler scopes it by `proposal_id`, and the `refund.created` handler validates the id Stripe
  echoed back against proposal, charge, amount and pending status before adopting anything.
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

### Follow-ups from the 2026-09-11 review of 4ceb6204 (Remove re-accrues payroll on a completed event)

The commit itself is correct for its route and safe to push; these are what the review found
around it. All verified against code on 2026-09-11 unless marked PLAUSIBLE.

- **Nine lock-gated siblings still keep a no-show's line.** `reaccrueDutyForProposal` fires
  unconditionally only from DELETE /shifts/requests/:id (`shifts.js:692`). Deny of an approved
  staffer (`shifts.approval.js:535`), approve (`:506`), assign (`:306`), the cover cascade
  (`coverApprovalCascade.js:217`) and the bonus-release sites fire it only when an out-of-area
  lock moved, and the catch-all status UPDATE in the same handler (`shifts.approval.js:542`)
  has no hook at all. So the prod-652 shape (no-show off a completed no-bonus event, her wage
  and tip line survives, card tips stay split N ways) recurs through every roster exit except
  Remove. Same one-line change at each site; land them together, one test per path.
- **The hook can silently no-op while Remove answers 200.** Period not `open`: the accrual
  COMMITs empty with only a Sentry warning (`payrollAccrual.js:192-202`). Event older than 21
  days: returns `{skipped}` with no signal (`:715`). Admin sees Removed, the line stays payable.
  Surface "payroll not updated: period closed" on the response, or refuse. Related: the hook
  also fires on non-roster deletes (a pending self-withdraw on a processed period emits the
  warning); gate it on `ctx.status === 'approved'`.
- **The orphan sweep deletes `confirmed` lines.** The comment at `payrollAccrual.js:559` says
  confirmed lines are never re-held or deleted, but `toDelete` (`:577`) and the inline
  empty-roster DELETE (`:245-250`) filter only on `adjustment_cents = 0`, no `held_state`
  check. `admin/payroll.js:249` flips held to confirmed on any edit, and every Remove now
  reaches the sweep. Code CONFIRMED; the live scenario (a confirmed zero-adjustment line whose
  roster then changes) is PLAUSIBLE, not reproduced.
- **The push gate never runs `shifts.removeReaccrue.test.js`.** `scripts/money-smoke-list.txt`
  carries `shifts.bonus.test.js` (L84) and not its new sibling, and the gate runs only that
  list. One line. Also the test's one-worker fixture takes the empty-roster branch, so the
  N-to-N-1 tip re-split from the prod-652 incident is still unpinned; add a two-worker fixture.
- **Remove writes no audit record of the deleted money line.** DELETE /shifts/requests/:id has
  no `logAdminAction`; the out-of-area PUT beside it (`shifts.js:630`) does. Its three
  autocommit steps (`:675-692`) also mean a throw inside `releaseOutOfAreaLock` after the row
  DELETE leaves the hook unfired and a retry 404s (PLAUSIBLE, rare). One transaction plus the
  audit row.
- **Pre-existing, now reachable from Remove: the last bartender removed with a barback or
  server still on roster splits the card-tip pool over zero bartenders.** `splitEvenly(x, 0)`
  returns `[]` (`payrollMath.js:28`), so at `payrollAccrual.js:395-398` an already-matched tip
  pays nobody and nothing warns. Decide the rule first (tip follows the remaining non-bartender
  staff, or the line is held for the admin), then fix.

## Potions: catalog and planner

**THE LAW, learned the hard way.** The alias index in `buildCatalogSlices` is built ONLY from
`par_items.ingredient_aliases`, NEVER from the item's own name. An ingredient matching an item NAME
but no alias fails to resolve, `classify()` returns `unmakeable`, the drink is dropped from the
hosted picker entirely, and the ingredient is silently omitted from BYOB shopping lists.
**Exact-alias match runs BEFORE the substring fallback, and that ordering is load-bearing** — it is
the only thing keeping "Maraschino Cherries" off the Luxardo row. `normalizeName` strips non-ASCII,
so **NEVER put an accent in an item name or alias** (Tajin, not the accented spelling; Kahlua, not
the accented spelling) or the two spellings stop matching each other.

- **Recipe @ 100 candidates, Dallas's call (2026-10-05).** `par_items.recipe_qty_per_100` (Pantry &
  Pars, "Recipe @ 100") shipped preset only on Margarita Salt, Tajin and Sanding Sugar, the three the
  approved lists cut to one container every time (`admin_set` lines, 2026-08/09). The same lists show
  these also cut to about one per event by hand, on 1 to 3 lists each, so they were left blank rather
  than guessed: Campari, Lillet Blanc, Lucid Absinthe, Dolin Dry, Carpano Antica, Myers's Dark Rum,
  Olives, Grenadine. Setting one to 1 stops the hand edit; blank keeps 1 per 25 guests plus 1 per extra
  drink. Ginger Beer, Cold Brew, Fresh Mint and the signature spirits sit at the 1-per-25 rule
  untouched on every list, so leave those blank.
- **The Pantry tab's "@ N" projection is wrong for "Recipes only" rows.** That column scales
  `qty_per_100`, which no generator path reads for a row whose only call-on is a recipe (the recipe
  merge uses 1 per 25 guests, or Recipe @ 100 when set). So every recipe-only row shows a placeholder
  "1 per 100" that never reaches a list; it is what made salt look correct in the tab and seeded the
  original misdiagnosis of the salt entry. Fix: for a "Recipes only" row, project the recipe rule
  instead (Recipe @ 100 scaled, else ceil(guests / 25)), or show a dash.
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
  name loses the match if the admin renames it in the drawer). 2026-09-11 (`58b12b1a`, lane
  custom-request-match): the alias-append endpoint now EXISTS (`POST /api/{cocktails,mocktails}/:id/request-aliases`)
  but by design treats a text equal to the drink's own name as a no-op, so closing this gap still
  needs (a) the Add-recipe reuse path to call it and (b) the own-name no-op relaxed for that
  caller. Not built; the gap is a rename corner, not a matching failure. Reuse-before-create lookup
  downloads both full admin drink lists for a name match — fine at ~43 drinks, wants a lean lookup
  endpoint (the Match existing picker now shares that same fetch). `loadRecipeCandidates` awaits
  serially after the `resolveDrinkIds` Promise.all.
- **Match existing (custom request → existing drink) SHIPPED to main 2026-09-11 (`58b12b1a`).**
  Needs-recipe rows carry Match existing beside Add recipe; the pick appends the client's exact text
  to the drink's `request_aliases`, so the exact server matcher resolves it on every later plan.
  Collision set = the matcher's candidate pool (recipe-carrying rows only; an abandoned Add-recipe
  draft never blocks). Review nits carried, none owed: the 409 can only mis-name a drink when a
  name-holder AND an alias-holder both exist for one key (names are checked first now); a
  recipe-less draft that later gains a recipe via the Recipes tab retakes its text by name-beats-alias
  with no signal (accepted over the dead end); ranker containment is word-bounded so suffix
  fragments ("rita") no longer hit while prefixes ("marg") do. OWED: Dallas's first real use on a
  live needs-recipe row (built + browser-untested; component suite covers the flow).
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

- **Hosted shopping-list follow-ups (lane hosted-no-shopping-list, 2026-09-11).** The rule now
  lives in `shoppingListGen.isHostedPlan` (server) and `client/src/utils/shoppingListOwed.js`
  (client), both exempting cocktail classes (`bar_type='class'` may self-supply). Left open by the
  per-lane review; none reachable in prod today:
  - `preEventHandlers.barOptionFor` (T-30 recap) and `consultRecap.js:128` still map every
    category-'hosted' package, classes included, to hosted, so a class client would be staged a
    list but the T-30 email would omit the link. Zero class drink plans in prod. Switch both to the
    same category+bar_type rule.
  - The Enhancement Lab follow-up email (`lifecycleEmailTemplates.js:758`) tells hosted clients "the
    lab closes when we finalize your shopping list". A hosted plan has no list, so its lab now
    closes only on BEO finalize and the 36h nudge still sends. Pre-existing copy; decide whether the
    lab nudge should send on hosted at all.
  - Admin `PATCH /api/proposals/:id` can change `package_id` after a plan is submitted with no
    drink-plan side effect: BYOB to hosted leaves the staged list in the modal (hidden everywhere
    else); hosted to BYOB stages nothing until Generate is clicked, though the Events row and prep
    queue do say a list is owed. `PATCH /api/drink-plans/:id/status` likewise leaves `submitted_at`
    set, so `plan_input_landed` can disagree with a reset status (the UI only ever sends 'reviewed').
  - The two hosted-only planner steps (`HostedGuestPrefsStep.js`, `v2/steps/HostedDrinksV2.js`) say
    "No shopping on your end" unconditionally. A class plan reaches them through the hosted queue,
    and for a class that is true with the supplies add-on and false without. Product-copy call.
  - Tidiness: the four-column stage-list UPDATE is copied in four writers with four WHERE guards
    (`shoppingListGen.js`, `drinkPlanConsult.js` twice, `labListRefresh.js`); a `stageShoppingList()`
    in shoppingListGen would own the SET list and the guard. `menuOwedFor` (`nextStepsCopy.js`)
    duplicates the inline `menuStyle === 'custom' || 'house'` test at `MenuDesignStep.js` (logo
    gate) and `BeoSections.js` (staff CustomMenuCard).
- **Derived BEO finalize follow-ups (lane beo-auto-finalize `2b414e64` 2026-09-11; lane
  beo-approve-is-review `3934cffc` 2026-09-22).** Since 9/22 approving the shopping list IS the
  review: the Mark reviewed click is gone, the list approve is the only derived trigger, the finalize
  UPDATE is the sole writer of `status='reviewed'` (a refused finalize changes nothing), Unfinalize
  returns a never-submitted plan to `draft`, and the Finalize BEO button shows on a submitted or
  reviewed plan, or a draft whose list is approved, never beside an unapproved list (it is the
  hosted click, the unpaid-extras override, and the way back after Unfinalize). Owed by Dallas:
  the walkthrough in `docs/walkthroughs-owed.md`. Residuals, none a defect in the new path:
  - **Client submit UPDATEs carry no `finalized_at` guard** (`drinkPlans/submit.js`: the three
    submit UPDATEs keyed `WHERE token = $6` and the draft branch). A client submit whose pre-check
    ran before an approve's commit and whose UPDATE lands after its finalize leaves a finalized row
    with `status='submitted'` and replaced selections; the extras branch also folds add-ons into
    the proposal post-finalize. Request-duration window, pre-existing via API, now reachable by
    approving a consult-built list while the client is mid-planner. Fix: `AND finalized_at IS NULL`
    on all four (the draft branch's status guard no longer covers the approve-to-finalize gap since
    the approve does not write status), with zero-row handling that ROLLBACKs and throws the
    finalized 409. submit.js is a money path over its line cap: its own lane, with the trim.
  - **Consult-only plans cannot finalize at all.** The consult save writes `consult_selections`,
    never `selections`, and finalize requires non-empty `selections` (`no_selections`). Prod shapes:
    57, 110, 65 (past), and 148 (prop 869, event 9/22). Decide whether finalize should accept
    `consult_selections` when `shopping_list_source = 'consult'`; the staff BEO payload already
    carries both. Today the button renders once such a plan's list is approved and the click 409s
    with the toast; the walkthrough names it so it is not read as a bug.
  - **A submitted BYOB plan with NO staged list finalizes in one click** (auto-gen skipped or threw;
    the gate passes on a null list status). Pre-existing at two clicks; the PrepQueue "needs list"
    row is the only signal.
  - `beo_finalized.details.nudge_count` over-reports: `scheduleBeoNudgesForProposal`
    (`beoHandlers.js`) counts approved staffers, not rows inserted, because `insertBeoNudgeIfMissing`
    returns nothing when a pending/sent row already exists. Same helper is a two-query loop per
    staffer inside the finalize transaction; one `INSERT ... SELECT ... ON CONFLICT DO NOTHING` would
    do. Pre-existing; matters more now that finalize fires without a click.
  - Staff on a shift whose `onboarding_status` is not yet `approved` at finalize time never get the
    T-3 nudge: the fan-out filters on approved, and the late-assignment hook keys on shift approval,
    which already happened. Rare; the window widens now that finalize lands weeks earlier.
  - `PUT /:id/consult` (`drinkPlanConsult.js`) checks the finalize lock outside its transaction and
    takes `FOR UPDATE OF dp` afterwards, so a consult save racing an approve can revert a
    now-finalized plan's list to `pending_review`. Move the check inside the transaction, the way
    the list PUT and the approve flip now carry `finalized_at IS NULL` in their UPDATEs.
  - `labListRefresh.js`'s stage UPDATE is the one `drink_plans` writer in the seam set with no
    finalize guard (only `shopping_list_status IS DISTINCT FROM 'approved'`). Two callers: the lab
    PUT's post-commit `setImmediate` (exposed only to a finalize landing between the lab COMMIT and
    the deferred refresh) and `proposals/cancelLineItem.js:252` (no finalize check at all, and
    cancels now routinely happen post-lock since finalize lands at approve). Uncovered set is a
    hosted plan still carrying a stale unapproved list, i.e. the five rows the hosted entry above
    already clears. Add `finalized_at IS NULL` to that UPDATE and skip the refresh on a finalized
    plan; folds into the `stageShoppingList()` helper the hosted entry proposes. Surfaced by the
    push-time seam sweep, 2026-09-11.
  - Two definitions of hosted in one flow: finalize and `shoppingListGen` use
    `category='hosted' AND bar_type<>'class'`; the approve action's recipient logic uses
    `pricing_type='per_guest'`. Nothing ties the two columns, so a hosted/flat row would finalize
    with no list yet still be offered the client list email. A comment or a CHECK.
  - The finalize and status responses still ship the `shopping_list` and `consult_selections`
    JSONB that no caller reads (both cards refetch the lean payload). Project explicit columns.
  - Unpaid extras stays a manual click for good: nothing re-fires when the extras invoice is paid
    later. Designed (the human checkpoint), noted so nobody reads it as a miss.
  - Behavior to know, not a bug: for an event inside three days, the list approve now arms
    the staff T-3 SMS about five to ten minutes later, where the old Finalize click did it
    deliberately. Unfinalize suppresses only rows still pending.

  - **The manual finalize enforces none of what the button encodes** (push-time review 2026-09-24).
    `beoFinalize.js` manual mode finalizes any linked, unarchived, unfinalized plan with selections:
    no status check, no `shopping_list_status <> 'pending_review'`. The "never beside an unapproved
    list, never mid-planner" rule lives only in the two React conditions (`DrinkPlanCard`,
    `DrinkPlanDetail`). A stale admin tab, or a direct call, can finalize a draft over a list that
    went back to `pending_review` and stamp `reviewed`, which is the planner-lockout state. Mirror
    the predicate in the manual UPDATE's WHERE with its own refusal reason.
  - `PATCH /drink-plans/:id/status` still accepts `'reviewed'` with no UI caller, the one API door
    left that can set `reviewed` without `finalized_at`. Drop it from the allow-list or retire the
    route.
  - The v1 planner (`PotionPlanningLab.js`) restores only `draft` and `submitted`, so a v1 draft
    auto-finalized by a list approve opens a blank welcome wizard whose final submit 409s. Only
    plans 101 and 103 are still v1; they go away with the legacy wizard (Potions, planner v2).
  - `DrinkPlanCard` Unfinalize has no in-flight flag (Finalize does); a double click sends a second
    POST that 409s with a spurious "Plan is not finalized" toast. `DrinkPlanDetail` already guards
    with `beoBusy`.

- **Potions badge counts pending lists on PAST events.** `pending_shopping_lists`
  (`server/routes/admin/settings.js`) has no date floor; on 2026-09-11 prod held 10 past-event
  `pending_review` rows (5 BYOB, 5 package-less) padding the badge with nothing to act on. Add the
  prep queue's upcoming-only rule to the count.

- **Planner answers beside the shopping list (Dallas, 2026-09-22: *"I want to see the answers from
  the potion planner on the shopping list. I often click back and forth."*).** The list is a portal
  modal (`ShoppingListModal.jsx`, opened from `ShoppingListButton.jsx` on `/drink-plans/:id`,
  `/events/:id` and `/proposals/:id`); the planner recap is `DrinkPlanSelections.js`, mounted in
  exactly one place, the Selections card on `/drink-plans/:id`, which the modal covers. On the event
  and proposal pages there is no recap at all. The answers are `drink_plans.selections` (already on
  `GET /drink-plans/:id` and `/by-proposal/:id`); the consult answers (`consult_selections`) have no
  admin read-only recap, only the `ConsultationForm.jsx` editor (the staff brief's `ConsultCard` is a
  raw JSON dump, filed under Staff-facing), and `shopping_list_source` says which of the two fed the
  list (all 23 saved consults on prod fed their list, 2026-10-06). `DerivationStrip.jsx` inside the modal already shows the derived
  numbers (drinkers × hours × pace), so the slot exists. Build: a collapsible side rail (desktop) or
  top section (narrow) inside the modal rendering `DrinkPlanSelections` for the source that fed the
  list, plus a compact read-only consult recap when the source is `consult`, rendered by the rules of
  the server's `formatConsultRecap` (`server/utils/consultRecap.js`, the post-consult email) rather
  than a third set, and shared with the staff `ConsultCard` fix. Modal-only; no new endpoint.
- **Fresh-squeezed juice add-on (Dallas, 2026-09-22).** No such add-on exists; juice is only ever
  bundled today (`full-mixers-only`, `the-full-compound` and `soft-drink-addon` all list bottled OJ,
  cranberry and pineapple) and every juice par row is shelf-stable bottled. **Needs from Dallas
  before it can land: the rate and billing type (per guest like `house-made-ginger-beer` at $2.50,
  or flat like a syrup bottle), whether it is `applies_to` all or BYOB-only, and whether it is a
  per-drink upgrade (like ginger beer) or a bar-wide swap.** The last add-on that shipped end to end
  (`8c1a0b0d`, NA beer) touched two files; the surfaces have accreted since and a two-file add now
  misbehaves quietly. Checklist, verified: `schema.sql` seed INSERT (`ON CONFLICT (slug) DO
  NOTHING`) with `category` from the six in `client/src/data/addonCategories.js` (the quote wizard
  filters by that map with no catch-all, so a null category is invisible) and the slug in the
  `requires_provisioning` allowlist (drives `supply_run_required` AND the supplies duty pay;
  `server/db/provisioningSeed.test.js` lists the two sides to pick from); `ADDON_ICONS`;
  `ADDON_TAGLINES` in `quoteWizard/helpers.js`; `DRINK_UPGRADES` in
  `client/src/pages/plan/data/drinkUpgrades.js` if it is per-drink (mirrors ginger beer); a `case`
  in `shoppingListAddonCoverage.js` `computeStripSet` so the BYOB list stops telling the client to
  buy bottled juice DRB is now squeezing (unmapped slugs are silently skipped); `BUNDLE_INCLUDED` /
  `BUNDLE_UNAVAILABLE` in `bundleConfig.js` AND its CJS twin `server/utils/proposalRules.js` if a
  bundle should cover it; `par_items` rows (lemon / lime / orange garnish rows exist) if the prep
  list should scale citrus. `OFF_LEDGER_INVOICE_LABELS` is not involved (add-on money folds through
  the normal `addon` line path).

- **A regenerate can re-append an admin-held line as a second copy.** `applyAdminSetHolds`
  (`server/utils/shoppingListGen.js`) matches a held line to the fresh list on item AND size. An
  admin who changed a row's quantity (which marks it `admin_set`) and then its size ("Soda Water,
  8 pack" to "12 pack") gets no match on the next regenerate, so the held line is appended beside
  the fresh one. Decide whether a size edit is part of the hold (match on item, carry the held
  size) before changing it; an admin can legitimately want two sizes of one item. Found 2026-09-30.
- **Escape in the recipe editor's ingredient suggestions closes the whole drawer.**
  `onIngredientKeyDown` (`client/src/components/potions/RecipeEditor.js`) dismisses the open
  suggestion list on Escape with `preventDefault` but no `stopPropagation`, and `Drawer` listens
  for Escape on `window`, so the same keypress also closes the shopping list's recipe drawer
  mid-recipe. The recipe is flushed on close, so nothing is lost; the admin is thrown out of the
  Next run. Fix: `e.stopPropagation()` in that branch. Found 2026-10-01.

- **The planner has no inspiration-image upload, so mood boards land in the logo slot (Dallas,
  2026-10-01).** The custom-menu step's only image field is `LogoUploadField` ("Add your logo
  (optional)", writing `selections.companyLogo` through `POST /drink-plans/t/:token/logo`).
  Clients use it for mood boards, so the stored image is sometimes a logo and sometimes a style
  reference, and a client with both can send only one. The menu art generator (spec
  `2026-10-01-menu-art-generator-design.md`) works around it with a per-draft role picker on that
  image. Build: a separate optional "inspiration image" upload on `MenuDesignV2` (custom style only;
  the legacy wizard is being deleted), same token-gated route shape and magic-byte check as the
  logo, its own selections key, read by the generator as the default reference image. Deferred out
  of the generator's v1 by Dallas to keep client-facing planner changes out of that lane.

---

## Staff, shifts, and the roster

- **No server route refuses a write on a shift that has finished.** Approve, Deny, Remove and
  Assign on a past shift are all accepted (`shifts.approval.js`, `shifts.js`), and an Assign texts
  and emails the person. The phone sheet blocks it from the `finished` key the shifts reads send
  since lane ma-e2 (`91dcfab8`); the desktop drawer does not, and a phone talking to an older server
  (a deploy window, a rollback) gets no key and blocks nothing. Refuse on the server. Push-time
  sweep, 2026-09-29.
- **No test covers the supply-run default, or an override surviving a sync.** The three
  `eventCreation` suites never mention supply, though the 2026-06-30 spec promised those tests.
  `syncShiftsFromProposal` keeps an overridden value by a `CASE` in its UPDATE, read and not run.
  Push-time consistency review, 2026-09-29.
- **`DELETE /shifts/requests/:id` (Remove) runs its steps with no transaction**: delete the request,
  write the audit entry, release the lock, re-accrue, delete the queued messages, suppress the BEO
  nudges. A database error half way leaves the rest undone, and a retried call answers 404, so the
  tail never re-runs. ma-e2 database review.
- **The same route accepts a path id that is not all digits.** `2432_0` deleted request 24320
  (Postgres 16 and later read an underscore in an integer). The two shifts reads answer 400
  (`requireId`). The audit entry records the real id. ma-e2 closing gate.
- **The owner's 409 `request_changed` says "Refresh and try again", and trying again cannot
  work.** The likeliest change is an approval, and the second try answers `already_approved`.
  Neither staff page re-reads on that code (`pages/staff/ShiftsPage.js`, `ShiftDetail.js`), so the
  row still says pending. Say "Refresh to see where it stands" and re-read. ma-e2 consistency
  review.
- **`server/utils/adminAuditLog.js` reads `err.message` in its own catch.** A rejection that
  carried no error object would throw there. Remove guards its call (lane ma-e2, `91dcfab8`); the other
  callers do not. Make it `err && err.message`. ma-e2 security review.
- **OWNER DECISION: any manager can read a staffer's street address.** `GET /api/admin/users/:id`
  returns the address and the home coordinates to any manager, with or without `can_staff`. Older
  than the lane that found it. ma-e2 Checkpoint A, security review.
- **The phone's staff picker asks for `limit=100` and ignores `total`**: active staffer 101 and
  later could never be assigned from the phone. Prod has 16. ma-e2 performance review.
- **Staff opt-in for "the menu is ready to print" (Dallas, 2026-09-22).** The per-topic opt-in
  machinery already ships: `users.staff_notification_preferences` (8 categories × push/sms/email),
  `notificationChannelResolver.js`, `PATCH /staff-notifications`, and the matrix at
  `client/src/pages/staff/account/NotificationsSection.js`. Two facts to know before building.
  (1) Only ONE of the eight categories has a producer (`cover_needed`, `coverBroadcast.js`); the
  other seven, `beo_finalized` included, are configurable and never fire through the resolver, so
  most of that matrix is a control that lies (separate cleanup, noted here so nobody assumes the
  plumbing is exercised). (2) "Menu ready" has no event: `POST /proposals/:id/menu-print`
  (`menuPrint.js`) uploads to R2 and its only side effect is `reaccrueDuty`; no activity-log row, no
  message. Build: a `menu_ready` category added in all FOUR mirrors (schema default JSONB, resolver
  `DEFAULT_CHANNELS`, route allow-list, `NotificationsSection` list + defaults), default OFF since
  opt-in is the ask, and an `enqueueCategorizedMessage` call beside `reaccrueDuty` fanning out to
  approved, non-dropped staff on the proposal's shifts the way `beoHandlers.js` selects them. Copy:
  one line with the event name and date; the download stays behind the existing assigned-staff
  route (`GET /shifts/:shiftId/menu-print`).
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

- **Answering a presence nudge with "yes" also fires the SMS opt-in machinery** (found 2026-10-02 by
  the purge-cell database review, pre-existing). `presenceScheduler.js:25` NUDGE_COPY says `Reply
  "yes"`, and `smsInbound.js:18` has `yes` in START_WORDS, so the reply hits `detectOptKeyword`
  before anything else: `applyOptIn` runs on admin user 1, `alertOptKeyword` fans an admin alert,
  and Twilio sends its own re-subscribe compliance text back. The presence stamp lands first
  (`routes/sms.js:74`), so the feature works; the cost is one admin alert plus one carrier
  auto-reply per answered nudge, all landing on the 312 since the nudge moved there. Fix: change
  the copy to a word that is no opt keyword (e.g. "here"), or short-circuit the keyword path when
  `stampByNudgePhone` matched.

- **Drip residuals from the 2026-09-24 push-time fleet, none reachable without a race or a DB
  blip** (the reachable ones sit in §3):
  - `cancelMarketingForProposal` runs `handOffDripToSibling` before its own suppress UPDATE with no
    guard, so a transient error in the hand-off skips the suppress, and in `cancel.js` and both
    `actions.js` loops the change-request reap in the same try. The dispatcher's archived gate still
    stops any send. Wrap the hand-off in its own try/catch (Sentry).
  - Stop follow-ups locks the target proposal then its siblings, never the `clients` row the
    documented order starts from (`proposalGroupCommit.js`), so a Stop overlapping a first payment
    on a sibling can deadlock; Postgres aborts one, Stripe retries the webhook. Take the client lock
    first.
  - On the stale-sweep door the hand-off can re-create touches on a past-dated sibling the same run
    is about to archive; clears itself when that sibling goes. Noted so nobody re-files it.
  - Doc drift: `proposals.drip_stopped_at` is missing from ARCHITECTURE.md's schema section (the
    route table has it); `ProposalDetailStopDrip.js` is missing from the README admin pages list.
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

- **The lead call bridge still stores a Twilio error MESSAGE in `lead_call_attempts.detail`**
  (`server/utils/leadCallTrigger.js`, its leg-create failure write: `err.code || err.message`). A
  Twilio or network message can carry the dialed number, so a failed Zul leg can put `VA_CELL` on a
  DB record, which the rules forbid. The consult bridge closed the same leak on 2026-09-30 (store
  `err.code` or a fixed word, and hand the log and Sentry a copy with the number cut to its last
  four); copy that. Found by the consult-bridge-hardening database review.
- **Consult bridge and Cal.com webhook residuals, from the 2026-09-30 per-lane reviews.** None is
  reachable on today's traffic (prod has never processed a Cal.com reschedule); each is cheap.
  - An unresolved reschedule does not stop a sibling whose chain is ALREADY open at that slot
    (`consultCallChain.js`, the sibling INSERT's `ON CONFLICT DO NOTHING`): inside the 5-minute open
    window the stale chain still rings.
  - The in-place reschedule UPDATE (`calcom.js`) sets `status = 'scheduled'` with no
    `status <> 'completed'` guard, unlike cancel and no-show; resolving a root uid through the prior
    list makes it reachable from one more shape.
  - A BOOKING_CANCELLED and a BOOKING_RESCHEDULED for the same booking arriving concurrently can
    file a junk `cancelled` row at the old uid (the cancel guard is check-then-act). Close with
    `SELECT ... FOR UPDATE` in a transaction if it is ever seen.
  - `extractRescheduleOldUids` still accepts `payload.metadata.rescheduleUid`. If Cal.com forwards
    booking-URL metadata, a booker holding someone's (current or prior) uid could name it. Drop that
    candidate until a real payload shows Cal.com using it. Its helper comment also says other callers
    rely on `extractRescheduleOldUid`; only its own tests do now.
  - A same-uid reschedule with no old-uid key in the payload falls through to `Already filed` and
    the slot never moves; and a CREATE for the new uid arriving before its RESCHEDULED is absorbed
    as a replay with one log line. Both hinge on unobserved Cal.com behavior: add a Sentry warning
    when the same-slot replay branch fires while an old-uid candidate resolves to a different
    scheduled consult.
  - `/dialend` records nothing on a `completed` dial. Writing `DialCallDuration` there too would
    give the unconfirmed-bridge reaper a second source and turn a lost status callback from a false
    "bridge unconfirmed" email into nothing.
  - A malformed `ADMIN_PHONE` walks three undialed rings, then hops to Zul, whose briefing says
    Dallas missed a call his phone never rang; no per-chain email says why. The boot warning is the
    only signal.
  - `handleNoShow` labels a uid that exists only as a PRIOR uid `unknown_uid` in Sentry.
  - **Out-of-order reschedules can move a consult back to a stale slot, silently** (codex, push review
    2026-10-01; Dallas: push as-is). The reschedule UPDATE resolves its old uid through the prior lists
    too, so IF Cal.com names the ORIGINAL booking on a second reschedule AND delivers two reschedules
    out of order, the late older one ("A to B" after "A to C") matches A in the consult's prior list
    and moves it to B. Dropping the prior-list match would not fix it (wrong slot plus the real one
    stopped, with an email), and it would make the likelier in-order case noisy. Follow-up: a Sentry
    warning in `handleRescheduled` whenever the old uid resolves ONLY through `calcom_prior_event_ids`,
    so the first real reschedule shows which way Cal.com behaves; decide then.

- **`GET /api/voice/vm/:token` has a per-IP limiter but no global or per-token ceiling, and buffers
  the whole recording per request.** `express-rate-limit` counts requests per window, not requests in
  flight, so all 30 of an IP's budget can simultaneously hold a full mp3 buffer for up to the 10s
  abort timeout — ~30MB of heap per attacking IP, so roughly 17 rotated IPs would OOM a 512MB Render
  instance that serves the whole API. The repo already built the pattern for this
  (`venueSearchGlobalLimiter`). Second half, same line: `Cache-Control: no-store` means the client
  can never produce the `If-None-Match`/`If-Range` the ETag code carefully reasons about, so that
  path is unreachable and iOS Safari's probe-then-body pattern costs TWO full authenticated Twilio
  downloads per playback. Requires a valid token, so hardening, not a live hole.
- **The 888's voiceUrl still points at the dead CheckCherry webhook.** NOT harmless (corrected
  2026-10-02): the drink-plan nudge SMS, sent from the 888 to every booking seconds after the
  deposit, ends "Or just call us.", so a client who calls the number that texted them reaches a dead
  third party. SMS correctly points at `/api/sms/inbound`. The nudge SMS itself now names the 1922
  (lane purge-cell, bd5083d3, 2026-10-02), but EVERY client text still comes from the 888, so a
  client who taps call-back on any of them still reaches the dead webhook. Point the 888's voice at
  the primary handler (`/api/voice/inbound/primary`, rings the 312 GV). Twilio console change, no
  code; confirm in the console before flipping.
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

- **The lead-call family logs `err.message` unguarded, in four places.** `voiceLeadCall.js:126`,
  `:195`, `:263` and `leadCallTrigger.js:56` all read `err.message` straight off a caught value.
  A rejection is not guaranteed to be an Error: a `throw 'string'` or a rejected non-object makes
  the log line itself throw, out of the catch that was supposed to contain it. The consult side
  already does this correctly and says why in a comment (`voiceConsultCall.js:96-104`,
  `consultCallChain.js:110-112`, both `(err && err.message) || err`), so the fix is to copy the
  guard four times. A fifth, `leadCallTrigger.js:114`, reads `err.code || err.message` inside a
  detail write and has the same shape.
- **`fileDialCapTrip` at `consultCallChain.js:254` is dead.** No callers anywhere in `server/`,
  and it is not in that module's exports. The cap-trip path that shipped goes through
  `consultCallCaps.fileCapTrip` instead. Delete it, or the next person will read it as the live
  path and reason about the wrong code.

- **Staffing-rule comment and doc drift, from the 2026-10-01 push-time seam sweep.** None changes
  behavior. README.md's `shifts.js` folder-tree line omits `roleFill` / `rowRoleFill` (ARCHITECTURE.md
  already documents them); `client/src/components/adminos/shifts.test.js` still says
  `parsePositionsCount` drives the Events and Overview unstaffed counts and that the drawer computes
  `neededCount(parsePositionsNeeded(...))`, where `roleFill` / `rowRoleFill` now do; and in
  `client/src/pages/admin/overview/queueItems.js` the staffing lane inserted `neededNoun` between
  `buildStaffingItems` and its header comment, so that comment now reads as describing `neededNoun`.

## Admin UI and the two skins

- **The notify popup's main choice has no weight in the admin skin.** `NotifyConfirmModal.jsx` gives
  its main choice `btn btn-success` (the quiet button by default, so "Don't send" in the editor and
  the quiet choice in the payment, refund and cancel-line popups), but the admin reset
  `html[data-app="admin-os"] button { background: none }` in `client/src/index.css` outranks
  `.btn-success`, and the admin skin restyles only `.btn-primary` and `.btn-secondary`. The main
  choice renders as a plain label beside the others. Every `btn-success` under the admin skin is flat
  the same way (the cocktail menu's active toggles, the shopping list modal on the drink plan page).
  Give `.btn-success` an admin-skin rule, or move the popup to `.btn-primary`. Seen in lane ma-e3a's
  desktop walk, 2026-10-06.
- **A gratuity rise that the same edit cancels out opens no confirm, and the client is still
  emailed.** `buildRepriceSummary` (`client/src/pages/admin/proposalEditor/repriceSummary.js`) returns
  nothing when the total holds, before it looks at the gratuity, while the server's automatic gratuity
  email keys on the gratuity total alone (`staffingGratuityOrigin`, `server/utils/gratuityMandate.js`).
  Add the additional-bartender add-on to a paid booking and comp it with a matching discount: the
  total holds, the editor saves with no confirm, and the client is emailed that their gratuity rose
  with no warning to the admin. The phone edit sheet edits no add-ons or discounts, so the desktop
  editor is where this happens. Fix direction: let a gratuity rise open the confirm on its own. That
  changes desktop behaviour, so it waits for an owner call. Lane ma-e3a consistency review, 2026-10-06.

- **The phone header can drop a real venue name.** `envelopeOf` in
  `client/src/utils/eventDetailView.js` treats a name as the street typed again when the house
  number and the first letter of the next word match, so "123 Sunset Grill" at "123 Spring St"
  shows only the address. Compare the whole next word, allowing the usual abbreviations (S and
  South, St and Street). Push-time consistency review, 2026-09-30.
- **What the red DUE on both Events lists does not account for.** The phone card, built in
  `a3b0b98f`, and the desktop Status cell print one figure, `total_price - amount_paid` via
  `eventPaymentState` (`client/src/components/adminos/eventPlan.js`), so they agree, and in these
  cases both are wrong. A bank debit in flight reads DUE for the days it takes to settle, since
  `amount_paid` moves only on success; project the in-flight state from `paymentInFlight.js` onto
  the feed and give the helper its own kind. An unpaid on-site extension invoice never shows,
  since extension money stays off both columns. A paid invoice whose label is off the ledger
  (a syrup-only Drink Plan Extras) folds into `amount_paid` but not `total_price`, so a deposit-
  paid client who pays one first reads short by that amount. A balance under 50 cents would
  print "$0". Prod, read-only, 2026-09-30: none of these holds on a live booking today.
  Proposal 600 is the LEGAL HOLD and reads "$3,273 DUE" on the phone's Past tab and the desktop
  alike: do not chase it. Found by the reviewer of `a3b0b98f`.
- **ON HOLD (Dallas, 2026-09-30): the phone's Text button change waits for the phone Messages
  screen.** From the Pixel walk: *"I don't want to text from my personal
  number."* Today `contactsOf` in `client/src/utils/eventDetailView.js` builds a plain `sms:` link,
  which Android hands to the personal texting app. The likely shape once that screen exists: Text
  opens the client's OS thread, which sends from the business number their automated texts
  already come from and lands replies in the inbox. The other option, a link into the Google Voice
  app, is held with it; a Voice text never reaches the client's record. Phone
  Messages is Phase 3 of the mobile admin spec (`2026-08-13-mobile-admin-design.md`), so that
  spec's Messages lane owns this change. Until then, text from the desktop Messages page. Still
  open, and not solved by the thread: the Call link's `tel:` rings from the personal line unless
  the Voice app is set to place calls.
- **Phone Events list polish (`a84555c3`, `9a73d5ba`), reviewed 2026-09-29, verdict PASS.** The two
  commits had no reviewer when they landed. What the review left, all Minor and display only:
  - `eventCards.js` maps a state name to its code by exact match on a plain object: "illinois" and
    "Il" render as stored, and a state of "constructor" renders the function's source. Every
    writer normalises the state on the server, so reach is low. Look up case-folded through a Map.
  - The state table is a fourth hand-kept copy of the service-area states and only Illinois is
    pinned by a test; dev has 7 Wisconsin proposals. One table test over `VENUE_STATES`.
  - Two pins are weaker than the code: the list's fall-back to the free-text location
    (`card.place || card.venue`) can be deleted with both suites green, because the manual
    fixtures carry a city the server never sends for a manual shift; and
    `shifts.adminScoped.test.js` asserts the two venue keys are present, not what they hold.
  - The After Hours Supplies tag takes its violet from the DANGER token. If that skin's danger hue
    is ever corrected to red, Supplies turns red beside the red fraction. Use the violet token.
  - The skeleton rail is 46px and the real rail 44px: a 2px sideways jump when the first page
    lands. A nameless manual shift says its venue twice, as title and in the meta line.
  - A screen reader now hears the guest count between the name and the kind ("Henderson 140
    GUESTS Wedding Reception").
  - At 320px wide the card's foot row exceeds its box when it holds a fraction, a requests chip
    and both tags. Nothing leaves the card. Not traced.
- **At 320px the phone Financials row's dollar icon collapses to 0px.** The row holds the icon, the
  amount, the status chip and the caret; at 320 wide the amount plus a "Balance due" or "Overpaid"
  chip outgrow it and the SVG is the only shrinkable item (widths 0/61/54/102/16 at 320, 20/96/54/102/16
  at 390; fine at 360). `flex: none` on the row icon, and let the label ellipsize. Pre-existing; found
  by the ui-ux review of lane phone-owner-decisions, 2026-09-30.
- **The phone Payments list counts on-site extension money as contract money.**
  `eventDetailView.js` lists every non-void invoice that took money and compares their sum with
  `amount_paid`, which extension money never enters. On an event that also holds money on no
  invoice row, a paid Service Extension invoice hides the "Paid to date" line and the unlisted
  money with it. The balance and the overpaid figure are not affected: both were run. Prod has one
  settled extension (842, completed). Leave the off-ledger labels out of the sum, by a client
  mirror of `OFF_LEDGER_INVOICE_LABELS`. Push-time sweep, 2026-09-29.
- Two comments in `client/src/utils/eventCards.js` say the event detail header reuses the list
  card and its `venue`; as built the header is `headerOf(proposal)` in `eventDetailView.js`.
  `ARCHITECTURE.md` names that module's exports without `placeOf`. Push-time sweep, 2026-09-29.
- **Phone event detail and assignment sheet, what the review left (lane ma-e2, `91dcfab8`).** None of these
  can send a wrong write: every write re-reads the shift first.
  - A save can land with the roster left from before it and NO "Saved" note: Approve one person,
    and while its re-read is out the SERVER refuses a second write; that refusal's read supersedes
    the first and then fails. A person assigned here and removed by another operator is in
    neither list until the sheet is reopened. Between a write settling and its re-read landing,
    nothing on the row says the save landed. All three want ONE design (a "saved, not yet re-read"
    state that names who was saved), not three patches (code review 2, gate).
  - A failed save is never reconciled against a later roster read: a box can read "didn't save"
    under a row that shows the person on the roster. Its label says what it was, its Retry then
    sends nothing, and Dismiss clears it (code review 2).
  - Refresh on the detail blanks the screen while it re-reads, throwing away a labelled copy
    before a replacement exists, and unmounts an open sheet with it. Re-read in place, and keep
    the sheet mounted across a fresh roster read (performance; code review 2).
  - On the Events list, a sheet write or a refusal reloads page 1 from the top (code review 2).
  - The sheet grows from 321px to 675px when the staff list lands, moving the search field 355px
    under a finger: a minimum height while it loads. Six labels and the sheet head still inherit
    line-height 1.45 (section label 29.5px for 28, sheet section label 32.5 for 31, sheet head 69.4
    for 66, when line 18.1 for 17, setup line 14.5 for 13) (design review).
  - The sheet's head says "Cancelled · roster is read-only" for EVERY archived proposal, where the
    detail says "Archived" for one that was never cancelled; the sheet's read carries no
    `archive_reason`. No prod row can reach it: of 268 archived proposals only the
    `client_cancelled` ones have shifts (consistency, code review 1).
  - A pending row that carries a role AND a ranked list that resolves elsewhere shows one of its
    two statements, not the role Approve will offer (code review 1).
  - Retry and Dismiss have no accessible name beyond the word, so two boxes read Retry, Dismiss,
    Retry, Dismiss; an `aria-label` from the box's label fixes it. A candidate's failed save keeps
    a live Retry while the staff list is a stored copy, which is harmless (code review 2).
  - No email link for an internationalised address, a quoted local part or a trailing dot: shown
    as text (code review 2).
  - The list and the detail compute the sheet's `assignable` hint by two rules: a manual shift
    with no declared roles, opened from the list, reads and stores the staff list and then draws
    no Assign section. None upcoming in prod (consistency).
  - The phone chrome's tab badges and the command palette search are never stored by the service
    worker now that storing is opt-in, so on a cold offline launch the badges are empty.
  - `client/src/components/mobile/MobileHeader.js` holds a plain-venue branch nothing reaches.
- **Service-extension alert links land on the phone detail, which has no panel.** Two of the alerts
  are urgent and come by SMS ("A PAID extension was never applied: settle or refund it",
  `server/utils/serviceExtensionNotify.js`); they link to `/events/:id`. Service extension has
  never been used in prod. Related: `server/routes/calendar.js` links `/events/shift/:id`, which
  for a manual shift forwards to bare `/events`, though the list can now open that shift's sheet.
  ma-e2 consistency review.
- **`PUT /shifts/:id` stores `positions_needed` verbatim, with no validation.**
  `server/routes/shifts.handlers.js:99`. A legacy object-shape entry with an absurd `count`
  (`[{"position":"bartender","count":1e30}]`) sends both `parsePositionsNeeded` twins (server and
  client) into a loop that many iterations long on any read, freezing the server request or the
  admin tab. `openSlotsSql` caps each element at 1000 so the badge can never 500 on it, but the
  write path is the real fix: validate the roster as a JSON array of canonical role strings (the
  shape every creator writes, `eventCreation.js`), or cap counts. No row has ever held one; found by
  the database review of lane staffing-rule-by-role, 2026-09-30. Related, pre-existing: a numeric
  literal like `[1e999999]` passes `IS JSON ARRAY` and then raises on `::jsonb`.
- **At scale, fence the unstaffed candidates before `openSlotsSql` runs.** In the badge's
  `unstaffed_events` and `GET /shifts/unstaffed-upcoming` the planner runs the fragment on every
  `status = 'open'` shift before the not-finished filter (it needs the proposals join). Manual and
  never-completed shifts stay `open` forever, so that set only grows. Measured on dev: badge 1.6 ms
  today, about 11 ms at 10x. Recipe when it matters: select the not-finished open rows in a
  subquery with `OFFSET 0`, then apply `openSlotsSql` (1.53 to 0.72 ms at 1x, 57.8 to 17.6 at 50x,
  identical results). Performance review of lane staffing-rule-by-role, 2026-09-30.
- ~~**QUEUED LANE (Dallas, 2026-09-30): one staffing rule everywhere, by ROLE.**~~ SHIPPED in `36a67b4f` (lane staffing-rule-by-role, merged 2026-09-30, not pushed; plan `docs/superpowers/plans/2026-09-30-staffing-rule-by-role.md` carries the as-built record). Beyond the list below it also moved the last-minute staffed confirmation (it emails and texts the client), the desktop ShiftDrawer, the event page and the Assign-to-event modal onto the rule. Original entry: Lane
  `phone-owner-decisions` put the phone Events LIST on the detail's rule (`roleFill` /
  `rowRoleFill`, `client/src/components/adminos/shifts.js`), but these still count HEADS
  (`approved_count` against the roster length), so a mixed-role over-fill (roster Bartender x2 +
  Barback, three Bartenders approved) reads 2/3 short on the phone card while: the phone list's
  Needs staff filter, its count and its "Fully staffed" empty state drop the event
  (`NEEDS_STAFF_SQL`, `server/routes/shifts.queries.js`); the tab badge misses it
  (`unstaffed_events`, `server/routes/admin/settings.js`, also `/unstaffed-upcoming`); and the
  desktop Events list says 3/3 (`EventsDashboard.js` Unstaffed tab and count, `StaffingCell.js`,
  `OverviewPage.js`, `queueItems.js`). The desktop EventDetailPage and ShiftDrawer already count by
  role. Build: a role-aware SQL predicate (both roster shapes, roleless approvals take a slot with
  room, open = max(0, sum of positive per-role remaining minus roleless)) shared by the feed and the
  badge and pinned together by `shifts.adminScoped.test.js`, plus the desktop list on `rowRoleFill`.
  Database review seat. Reach today: none (0 mixed-role rosters in prod on 2026-09-29, and the phone
  refuses to over-fill). Found by the consistency and code reviews of that lane.
- **OWNER DECISIONS on the phone event detail (lane ma-e2, `91dcfab8`), each one Dallas's to make.**
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): the "No tip jar (client paid to skip it)" warning
    goes on the phone detail as an amber chip on the date line, on any event not cancelled
    (`tip_jar === false`, already in the `/proposals/:id` read). The "Last-minute: verify
    staffing" badge (`last_minute_hold`) stays desktop only: skip it on the phone.
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): the phone LIST counts by ROLE, the detail's rule
    (`staffingSheet.js`), so an extra bartender never reads full while a barback slot is open.
    The list feed already carries `approved_by_role`; client only (`eventCards.js` `finishCard`,
    which today sums heads via `approvedCount` capped at slots).
  - DECIDED 2026-09-30 (Dallas): leave it. "Edit details" stays a STICKY switch (every event opens
    in Desktop view until "Phone view" is tapped); the ma-e3 phone edit sheet replaces it soon.
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): phone vs desktop is decided when a page OPENS, not on
    every resize. Wider than first filed: `AdminLayout.js` renders the Outlet at two different tree
    positions (phone chrome line ~269, desktop ~288), so crossing 700px remounts WHATEVER admin
    page is open (any unsaved form, a message draft, an open dialog), live since the shell shipped
    2026-08-14. Latch `isPhone` in `MobileViewContext.js` and re-read it on a route change; the
    lock model (`mobileLock.js`) keeps its own raw query. Unreachable on the installed app
    (portrait-locked); reachable on a desktop window under 700px and a phone browser tab rotated.
    As built, a tap to the SAME path does not re-latch (a phone browser tab opened landscape on
    /events, rotated, then Events tapped again stays desktop until another route). Accepted.
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): the phone Back button's name becomes plain "Back".
    It returns wherever you came from; the name is `aria-label` only (`AdminLayout.js` passes
    "Back to Events" / "Back to Proposals" to `MobileHeader.js`), so this is screen-reader text.
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): a CANCELLED event holding an overpayment shows
    Overpaid on the phone Financials chip, as the desktop Payment card does
    (`ProposalDetailPaymentPanel.js`); the header's date line keeps its own "Cancelled" chip. On a
    live event a bank debit in flight (Processing) still outranks Overpaid, the ma-e2 law.
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed): a staffer under half a mile from the venue reads
    "<1 mi", not "0 mi" (`staffMeta` in `staffingSheet.js`). Display only; the whole-mile rule
    stays (a stolen phone's cache cannot place a home to the block).
  - ~~A tap on the lower part of the client's name in the header opens Maps.~~ CLOSED 2026-09-30 by
    `aa03a2e6`: the type line now always sits between the name and the venue (`getEventTypeLabel`
    falls back to "event"), and the link's 17px upward reach (`.m-dhead-venue` padding) ends at
    the 16px type line plus its 2px gap, 1px short of the name. What remains: a tap on the event
    type opens Maps. Harmless; leave it.
  - ~~The event type is cut off in the detail header.~~ CLOSED 2026-09-30: the type has its own
    line under the client (`aa03a2e6`, pushed 2026-09-30, `MobileHeader.js` `m-dhead-kind`).
  - DECIDED 2026-09-30 (Dallas), SHIPPED in `016477d9` (lane phone-owner-decisions, merged 2026-09-30, not pushed), contrast (measured on `--bg-2`): the House Lights
    balance-due label and amount on the detail (`.m-money-bal`, `--ms-camel`, 2.77:1) darken to
    about 5:1, same hue (`hsl(38 63% 30%)`, 5.3:1); After Hours (warn at 58%, 6.6:1) stays. The phone's small `--ink-4` labels
    (rail month, "GUESTS", section summaries and labels; 1.9:1 House Lights, 2.6:1 After Hours)
    move up to `--ink-3` (3.9:1 and 4.6:1). Applicant initials (2.8:1 After Hours) stay: the
    name sits beside them.
  - After Hours draws the warn signal amber on chips and cyan on the balance, pills and dots; the
    leading section icons are bright where the benchmark's are grey.
  - Words: "No connection, didn't save."; the button that writes reads "Approve" and not
    "Approve as Bartender" (a failed save now names the role).
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

- **The admin PATCH takes `event_duration_hours` with no type or range check.** A crafted -3 from an
  admin or manager reaches the engine and the NUMERIC(4,1) column; the editor's stepper clamps
  1 to 12, so only a hand-made request can. Validate above 0 with an upper bound in
  `resolvePatchHours` (`server/routes/proposals/patchContractHours.js`). Older than the batch.
  Push-time security review, 2026-09-30.
- **A clamped or corrupt contract-hours proposal pages Sentry on every re-price**, including from
  the public drink-plan routes (`contractDuration.js` report, called by `lab.js` and `submit.js`).
  Admin-made state, so a token holder cannot cause it, but a hand-reverted booking pages once per
  save for its life. Fingerprint by proposal id. Push-time security and database reviews.
- **The settled-extension rows are read two or three times in one transaction** (a drink-plan
  submit, a lab save, a cancel-line: the site reads them, then the fold reads them again), and the
  `/calculate` preview reads them before, not beside, the package read. About 1 to 2 ms each. Pass
  the contract hours into `foldExtrasIntoProposal`; `Promise.all` the two reads in `metadata.js`.
  Push-time performance review, 2026-09-30.
- **A proposal signed under v2 renders the CURRENT agreement text**, v4 from 2026-09-30 (it was v3
  before), because the abridged v2 text lives only in git history (`agreementForVersion`). The
  recorded version stays v2. Prod: 6 such proposals, none live. Push-time security review.
- **The admin service worker stores whatever a 200 carries.** For an opted-in URL it checks the URL
  and the `X-Offline-Ok` header, never the body (`client/public/admin-sw.js`). While a new client
  talks to an OLDER server (each deploy window, or any server rollback, which has no time bound),
  `GET /drink-plans/by-proposal/:id?fields=day_of_contact` answers the FULL plan, and the phone
  stores it: the plan's token, the client's email, the selections, the admin notes. It is never
  rendered. It goes on a live re-read of that same event, a 401 or 403 on that URL, logout, another
  user on the device, or the next `SW_VERSION` bump; not with time. Proven in a harness around the
  real worker file. Fix: store that URL only when the body's keys are exactly `day_of_contact`,
  else delete the entry, and bump `SW_VERSION`. Sensitive path, so its own reviewed change.
  Push-time sweep, 2026-09-29.
- **`server/db/provisioningSeed.test.js` is on no gate, and its parser has holes.** It is absent
  from `scripts/money-smoke-list.txt` and nothing else runs it, so an unclassified add-on ships
  with the gate green. Run on scratch copies, it also stays green when a new add-on is seeded on
  the `VALUES` line, with an underscore in its slug, in lower-case SQL, or with `ON CONFLICT (slug)
  DO UPDATE`; it counts a slug inside a SQL comment as flagged; and it cannot see a second statement
  that writes the flag, one writing FALSE included, nor the seed moved above its column. Fix:
  split with `splitStatements` from `server/db/index.js`, strip comments, assert every add-on
  INSERT yields a slug, assert the flag is named by the ADD COLUMN and one seed only, in that
  order; then add the suite to the smoke list (gate machinery, so a reviewed change). Push-time
  database, code and consistency reviews, 2026-09-29.
- **The provisioning seed converges one way, and sees only what `schema.sql` seeds.** Every boot
  sets the 37 listed slugs true (and rewrites all 37 rows, bumping `updated_at`), so turning one
  off takes its removal from the list PLUS a hand UPDATE in each database. An add-on that exists
  only in a database is invisible to the test: dev holds `class-bar-rental` (gear, active,
  unflagged, in no INSERT). Prod does not: read-only, 2026-09-29, 41 add-ons, 37 flagged, and the
  four unflagged are the staffing and fee rows. Push-time database review.
- **Two files that decide money or stored data are not sensitive-listed:**
  `server/utils/serviceExtensionPricing.js` (what an extension bills) and
  `server/routes/drinkPlans.js` (its projection bounds what the phone stores).
  `scripts/sensitive-match.js` matches neither. Push-time sweep, 2026-09-29.
- **`shifts.visibility.endInstant.test.js` cannot pass between 00:30 and 06:30 Chicago.** Its
  "ended half an hour ago" fixture has no start time, and `shiftEndInstant.js` reads an end before
  06:00 with no start as an overnight end (`WRAP_CUTOFF_HOUR = 6`), so the fixture is unfinished
  and the suite fails its own premise, 6 of 6, on main as in any lane. Seen 2026-09-29 at 06:18
  (fail) and 06:38 (pass). Give the fixture a start time.
- **Six server suites set `NODE_ENV = 'test'` BEFORE their production guard tests it, so the guard
  can never fire:** `shifts.removeReaccrue`, `shifts.bonus`, `shifts.approval`, `shiftReap`,
  `autoAssign.bartenderScope`, `proposals/remoteStaffing`. Read the value first, as
  `shifts.removeReminders.test.js` does. ma-e2 security review.
- **The phone stores more than it shows.** The stored `GET /proposals/:id` carries the client's
  signature image, the signer's IP and user agent, the Stripe customer and payment-method ids, the
  cancellation note, `token` and `admin_notes`; every staff picker entry carries the whole active
  staff directory with emails and phones, once per shift opened; both shifts reads carry requester
  distances to a tenth of a mile beside the venue's coordinates. Nothing in the cache ages out. A
  phone projection of each read (as the drink plan has) is the first at-rest item; it also trims
  the 70 to 80 percent of `GET /proposals/:id` the phone never reads. ma-e2 security and
  performance reviews.
- **The API sends no `Access-Control-Max-Age`.** The admin origin calls the API cross-origin with an
  Authorization header, so EVERY call pays a preflight round trip, again every 5 seconds per URL.
  On an 800 ms link that doubles every wait in the phone app. `maxAge: 7200` in
  `server/middleware/corsOptions.js`: one line that changes every API call, so its own change.
  ma-e2 performance review.
- **`client/src/utils/api.js` sets no request timeout.** A write on a stalled socket holds the
  phone sheet (the scrim and Escape wait for a write in flight). Android Back closes it; on an iOS
  standalone install nothing can. ma-e2 performance review.
- **Client TEST files are linted by nothing** (the CRA build excludes them; lint-staged covers
  `server/**`). ma-e2 left its own test files clean; `EventsListPhone.test.js` still carries
  eighteen `testing-library/no-node-access` errors from ma-e1. A lint reading taken through a pipe
  reports the pipe's exit code: capture it directly.
- Path ids are validated by an inline check that exists three more times since ma-e2 (`shifts.js`,
  `drinkPlans.js`, `admin/users.js`) beside eight older copies. `GET /proposals/:id` and the full
  drink-plan read still answer 500 for an id above int4. Extract one helper.
- `server/routes/shifts.js` is 817 lines and `server/routes/admin/users.js` 752, both inside the
  soft cap's warn band.
- `POST /drink-plans/for-proposal` takes `LIMIT 1` of an unordered read; the two GETs by proposal
  were ordered in ma-e2. Prod has no proposal with two plans.
- Prefetch the event detail route from the phone list (`webpackPrefetch`): the first tap after a
  deploy downloads about 54 KB gz, most of it desktop code the phone never runs.
- `client/src/hooks/useFormDraft.test.js` logs one act warning ("Gated").
- Stored pricing breakdown labels carry em dashes written by `pricingEngine.js`. The phone and the
  desktop both render them as stored.
- **`idx_invoices_invoice_number` is NON-unique on dev.** `schema.sql` declares it `CREATE UNIQUE
  INDEX IF NOT EXISTS`, but dev carries a plain index of that name, and `IF NOT EXISTS` matches on
  the name alone, so the uniqueness never applied and boot stays green. Not in `CRITICAL_INDEXES`,
  so nothing alerts. Dev cannot reproduce an invoice-number collision; prod's state is unverified.
  Found by the 2026-08-28 lane 2 database review; not that lane's. Check prod, then drop and
  recreate on dev.

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

- **`.node-version` says 26.5.0, this box runs v24.16.0.** Verified 2026-08-26. Whichever is
  intended, the two should agree: the file is what Render and Vercel build against, so a real
  divergence means local passes and CI builds are not running the same runtime. One line either
  way, but decide which way rather than leaving it drifted.
- **`drinkPlanConsult.test.js` still deletes by pattern, so it can reach another suite's rows.**
  It and `calcom.test.js` both seed `@calcom-test.example` fixtures, and `npm test` glob-runs
  files in parallel with no concurrency flag anywhere in the repo, so each one's pattern-scoped
  DELETE can take out the other's live rows mid-run. `calcom.test.js` was converted to delete by
  recorded id on 2026-08-25; this is the unconverted mirror. An id list cannot reach a row the
  suite did not create.
- **Dev carries accumulated fixture debris: 48 test-pattern clients and 66 proposals hanging off
  them.** Counted 2026-08-26. None of it is FK-orphaned, so nothing is broken; it is just noise
  that makes dev counts untrustworthy for eyeballing. Worth knowing before anyone reads a dev
  total as real. (Checked at the same time and clean: `consults` and `consult_call_attempts` are
  both at 0 on dev, so the consult suites do tear down fully.)
- **ARCHITECTURE's Auth column says bare `Admin` on four rows whose code is
  `requireAdminOrManager`.** Lines 245 (drink plans), 310 (packages), 345 (proposals getOne) and
  425 (clients getOne). All four verified against the code on 2026-08-26: `drinkPlans.js:409`,
  `proposals/getOne.js:17` and `clients.js:94` each take `auth, requireAdminOrManager`, and
  `packages.js:18` applies the same pair router-wide. The same file already writes
  `Admin/Manager` for that middleware elsewhere, so this is drift, not a convention. **No auth
  hole: the code is correct and the doc is wrong.** Four rows want one sweep, which is why a lane
  that touched only two of them correctly left all four alone.
- **`thumbtack.js:509` can ROLLBACK on an already-released client.** The catch runs
  `dbClient.query('ROLLBACK')`, but `released` is set true at `:439` and `:501`, both before the
  post-commit tail finishes, so a throw after either point hits a released client and pg rejects
  it. It is wrapped in its own try/catch, so nothing crashes: the cost is a misleading
  `ROLLBACK failed` line in the logs during exactly the incident someone would be reading them
  for. Guard the rollback on `!released`.

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
  **AMENDED 2026-09-18: the Events LIST is built, by lane `ma-e1-events-list` of
  `docs/superpowers/plans/2026-09-15-mobile-admin-events-list.md`, and the screens after it are no
  longer undeclared work.** That plan's lane map declares the event detail plus the assignment
  (staffing) sheet as `ma-e2-event-detail`, the ONE edit sheet both details share as
  `ma-e3-edit-sheet`, the proposals list as `ma-f1-proposals-list`, the proposal detail as
  `ma-f2-proposal-detail`, and full-screen search as `ma-f3-search`, each with its own plan, its own
  dependencies and its own review fleet. **Declared is not built: only `ma-e1` has code**, so the
  original finding below still stands for every other screen.
  `client/src/pages/mobile/` held exactly ONE file, `MorePage.js`, until that lane added
  `EventsListPhone.js`. There is no phone Events
  detail, no phone Proposals list or detail, no assignment sheet, and no sheet component at all — so
  the decision-log line "mobile sheets push history so Android Back closes the sheet" has nothing
  implementing it. The Events tab now forks to the phone list at phone width (lane `ma-e1`,
  `EventsDashboard` reads `useMobileView()` and renders `EventsListPhone`); the Proposals tab still
  routes to the ORDINARY DESKTOP ADMIN PAGE with no phone branch, the "CSS retrofit" shape the
  spec's decision log rejects, until `ma-f1` lands.
  **AMENDED 2026-09-29: the event DETAIL and the ASSIGNMENT SHEET are built, by lane
  `ma-e2-event-detail` (`91dcfab8`) of
  `docs/superpowers/plans/2026-09-29-mobile-admin-event-detail.md`.** `/events/:id` forks to the
  phone detail at phone width, the sheet component exists (`AssignmentSheet.js`, its writes in
  `useSheetWrites.js`), and phone sheets push history so Android Back closes them
  (`useDrawerParam({ push: true })`). Still declared and unbuilt: `ma-e3-edit-sheet`,
  `ma-f1-proposals-list`, `ma-f2-proposal-detail`, `ma-f3-search`. What the lane's review left is
  filed where it belongs: section 3 and section 4 above the divider, and below it under Staff,
  Admin UI (with the decisions waiting on Dallas) and Platform.
  **Before planning ma-e3:** the edit sheet itself is drawn in the benchmark (New total, "Confirm
  new total", "balance due becomes"), but the event note (spec section 4, "a plain textarea that
  behaves with Android dictation") is drawn nowhere and sits in no lane. It has its own endpoint
  (`PATCH /proposals/:id/notes`, no money), so decide at the ma-e3 design pass whether it rides
  the edit sheet or gets its own row. Recorded in the ma-e2 plan's Self-Review; it never reached
  this list until 2026-09-30.
  **Whether to build the rest at all is Dallas's call.**

  **The offline staleness line belongs to whichever lane builds those screens** — do not open a lane
  for it alone. **CLOSED FOR THE LIST 2026-09-18 (lane `ma-e1-events-list`): the call site now
  exists and is tested.** `client/src/pages/mobile/EventsListPhone.js` imports `formatStaleTime`
  from `utils/staleTime.js` and renders the `.m-stale` element under the list: "as of <time>" on a
  live load, and "offline copy · as of <cached time>" with the dot when the service worker answered
  from cache. Both are asserted at the CALL SITE, in `EventsListPhone.test.js`, which is what this
  entry demanded. **CLOSED FOR THE EVENT DETAIL AND THE SHEET 2026-09-29 (lane ma-e2): both render
  the line or the banner from `res.staleAt`, asserted at the call site, and caching is now opt-in
  per request (`offlineGet`).** **Still OPEN for every other phone screen**, and the original finding follows
  verbatim because it still describes them.
  The chain is built and green at both ends and disconnected in the middle:
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
- **Additional clients on a proposal (Dallas, 2026-09-22: *"ability to add additional clients to a
  proposal."*).** Today a proposal has exactly one person: `proposals.client_id` → a flat `clients`
  row (name, email, phone); every comms action resolves ONE address off that join; portal login
  resolves an email to ONE `clients` row (`clientAuth.js`); the contract says "designate a single
  point of contact". The only second person anywhere is the drink plan's day-of contact
  (`selections.logistics.dayOfContact`, name + phone, no email, no portal). Nothing in the schema
  blocks it, and `sendEmail` already takes an array for `to` (`email.js`). Shape that fits: a
  `proposal_contacts` join table (`proposal_id`, `client_id`, role label, `is_primary`), keep
  `proposals.client_id` as the primary so nothing downstream moves, a second picker slot in
  `proposalCreate/ClientSection.js`, and the contact block on `ProposalDetail` / `EventDetailPage`.
  **The design call that decides the size:** does the second client only get CC'd (proposal sends,
  shopping list, portal invite: each comms action's recipient resolution gains the extra
  addresses), or do they get their own portal login and the ability to sign (then `clientAuth.js`
  must resolve an email to a SET of proposals and the sign path needs a rule for whose signature
  counts)? CC-only is a lane; portal identity is a project. Brainstorm first.
- **Review request research (Dallas, 2026-09-22).** The pipeline already exists and runs; the
  research question is why it produces almost no Google reviews. Facts, prod 2026-09-22: the
  `review_request` email fires at event_date + 2 days, 10am local (`marketingHandlers.js`,
  scheduled by the hourly auto-complete and by a manual status → completed): 56 sent, 3 suppressed.
  It links to `/feedback/:token`; 13 clients answered (23%), ratings 5,5,5,2,5,5,5,5,5,5,3,5,5, and
  every rating lands in `post_event_feedback` (the schema comment saying 4-5★ never hit the table is
  wrong; `recordFeedback` inserts first, then routes). A rating of 4+ is redirected to
  `PUBLIC_GOOGLE_REVIEW_URL`, which silently falls back to plain `https://google.com` when unset, so
  11 people were sent toward Google and `staff_reviews` holds ONE Google review, entered by hand.
  There is no SMS ask, no second nudge, no admin "send review request now", no link from a redirect
  to the bartender's $10 bounty (`staff_reviews.proposal_id` exists, nothing on the feedback path
  writes it), and the review URL is env-only. The tip thank-you page and the CheckCherry wrap-up
  email carry their own Google CTAs. **First thing to check: that `PUBLIC_GOOGLE_REVIEW_URL` is
  actually set on Render.** Then the research is about the funnel after the redirect; the August
  research covered the at-event ask and its FTC lines, this is the post-event one.
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

- **Clear five stale hosted shopping lists once lane hosted-no-shopping-list is live**: `drink_plans`
  124, 37, 95, 93, 71 (all past events, all `pending_review`, never sent to anyone). Same guarded
  UPDATE as row 136 (cleared 2026-09-11): null `shopping_list`, `shopping_list_status`,
  `shopping_list_source` where the status is still `pending_review` and nothing was ever approved.
  Row 130 (approved 8/25, past) stays as history. Cosmetic once live (hosted rows no longer badge or
  queue), so tidiness, not a blocker.

---
---

# Settled — do not re-raise

One line each. These exist to stop a lane being opened, not to record history.

- **The consult sibling stop keeps `skipped_cancelled` / `rescheduled_unresolved` (2026-09-30).** A
  status of its own was decided against: the one-row email closed the silence, and a rename changes
  no behavior.
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
