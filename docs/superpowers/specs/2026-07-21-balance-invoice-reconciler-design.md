# Balance-invoice reconciler

**Date:** 2026-07-21
**Status:** design, approved by Dallas 2026-07-21
**Base:** main @ 26ddab3

## The invariant

> If a booked event has a balance due, a payable invoice for that balance exists.

Today that invariant holds by accident of the native payment flow, and it broke for an entire cohort of real clients.

## Problem

A `confirmed` proposal's public page has no sign-and-pay affordance. The only pay control is a "Pay balance" button in the paid-state card, and it renders only when `open_invoice_token` is non-null (`client/src/pages/proposal/proposalView/ProposalView.js`, gated on `!isFullyPaid && proposal.open_invoice_token`). That token comes from a LATERAL subquery selecting the oldest invoice in status `sent`/`partially_paid` (`server/routes/proposals/publicToken.js`).

Balance reminders (email and SMS) link to `proposalUrl(token)`, never to an invoice (`server/utils/balanceReminderHandlers.js`, `server/utils/balanceSmsHandlers.js`). So when no open invoice exists, the reminder lands on a page with no way to pay, and the reminder handler does not self-suppress because the balance is genuinely positive.

Native events never hit this: `createBalanceInvoice` fires from the Stripe deposit webhook (`stripeWebhookHandlers/paymentIntentSucceeded.js`, `checkoutSessionCompleted.js`), so the Balance invoice exists before the first reminder.

The gap is any post-booking proposal whose deposit never flowed through a Stripe `payment_type='deposit'` webhook. Concretely: the 13 Check Cherry transfers (imported directly as `confirmed`, deposit folded into `external_paid`, no invoice row created by `scripts/cc-transfer-events.js`), and any hand-built proposal set to `confirmed` with an externally recorded deposit. Eight real clients owed a combined $6,448 with no way to pay it, and were dunned up to five times each.

Those eight were remediated by hand on 2026-07-20 (INV-0204 through INV-0211). This spec prevents recurrence.

## Goal

A scheduled reconciler that enforces the invariant automatically for the ordinary case, and escalates anything ambiguous to a human rather than guessing on the money path.

Non-goal: collecting money. The reconciler only makes an invoice exist. It sends nothing.

## Why a sweep rather than an event hook

The alternative is minting the invoice inline wherever the gap can be created (admin confirm, external payment recording, transfer scripts). That is how we got here: `cc-transfer-events.js` simply did not call the invoice path. A sweep enforces the invariant as a property of the data, independent of how a proposal reached that state, and heals retroactively. It follows an established, proven pattern in this codebase (`processAutopayCharges`, `processEventCompletions`, and six other schedulers already wired through `wrapScheduler`).

## Design

### Module

`server/utils/balanceInvoiceReconciler.js`, exporting `reconcileMissingBalanceInvoices()`. One responsibility: find post-booking proposals that violate the invariant, and either heal the clean ones or flag the rest.

It reuses `createBalanceInvoice` (`server/utils/invoiceLifecycle.js`) unchanged. No new money math is introduced.

### Candidate selection

```sql
SELECT p.id, p.status, p.total_price, p.amount_paid
  FROM proposals p
 WHERE p.status IN ('confirmed', 'deposit_paid')
   AND p.client_id IS NOT NULL
   AND ROUND(p.total_price * 100)::int - ROUND(p.amount_paid * 100)::int > 0
   AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.proposal_id = p.id AND i.label = 'Balance'
       )
```

Each clause earns its place:

- **`status IN ('confirmed','deposit_paid')`** is the post-booking window. It excludes quote-stage proposals (`draft`/`sent`/`viewed`/`accepted`), which pay through the sign-and-pay flow and must never receive an auto-invoice. It excludes `archived`, `balance_paid`, and `completed`.
- **`client_id IS NOT NULL`** excludes orphan proposal shells. Prod currently holds seven such rows (ids 322, 329, 334, 400, 411, 412, 420: no client, no package, no venue, no payments, all `completed` with an identical $2,000 balance and a 2026-05-15 event date). An invoice for a clientless proposal can never be paid and would pollute the ledger.
- **Cents arithmetic, not a dollar epsilon.** `createBalanceInvoice` computes `toCents(total_price) - toCents(amount_paid)` and returns null at zero. Selecting on the same integer comparison guarantees we never select a row the helper would then no-op on, which would otherwise produce a silent every-hour retry loop.
- **`NOT EXISTS ... label = 'Balance'`** mirrors `createBalanceInvoice`'s own idempotency guard exactly, including its lack of a status filter (a void Balance invoice still blocks). Matching the helper prevents the same select-then-no-op loop.

`completed` is deliberately excluded. A past event with an outstanding balance is an accounts-receivable judgment call, not a mechanical one, and the only such rows in prod today are the seven orphans above. Post-event collection stays manual.

### Classification of candidates

For each candidate, two blocking checks. Either one means skip and escalate:

**Block 1: an open non-Deposit invoice exists.**

```sql
SELECT 1 FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status IN ('sent', 'partially_paid')
   AND COALESCE(i.label, '') <> 'Deposit'
```

**Block 2: a non-contract payment has landed.**

```sql
SELECT 1 FROM proposal_payments pp
 WHERE pp.proposal_id = $1
   AND pp.status = 'succeeded'
   AND pp.payment_type IN ('invoice', 'drink_plan_extras', 'drink_plan_with_balance')
```

Otherwise, call `createBalanceInvoice(proposalId, client)`.

### Why those two blocks exist

This is the part the recent Enhancement Lab "balance fold" change (2026-07-20) makes load-bearing, and getting it wrong bills clients twice.

Membership in `CONTRACT_LABELS` (`['Deposit','Balance','Full Payment']`) is **not** the same as "this money is inside `total_price`". Several labels sit outside `CONTRACT_LABELS` while their dollars are inside the contract total:

| Label | Dollars inside `total_price`? | In `CONTRACT_LABELS`? |
|---|---|---|
| Deposit / Balance / Full Payment | yes | yes |
| Additional Services | yes (it is a `total_price` increase) | no |
| Enhancement Lab | yes, since the 2026-07-20 fold | no |
| Drink Plan Extras | depends on line composition | no |
| manual/bespoke labels | unknown | no |

`OFF_LEDGER_INVOICE_LABELS` is currently `[]`. It briefly held `'Enhancement Lab'` (commit fc3780f) before the fold superseded that model (f68f286, 6aa9a62), so lab money is now ordinary contract money living in `total_price`.

**Block 1 prevents double-billing.** If an open `Enhancement Lab` or `Additional Services` invoice exists, its amount is already inside `total_price` while also being separately payable. Minting `Balance = total_price - amount_paid` would bill that amount a second time. Prod proves the shape is real: proposal 557 carries `Deposit:paid, Balance:paid, Additional Services:sent` and proposal 547 carries `Deposit:paid, Balance:paid, Gratuity Balance:sent`. In both, the outstanding balance is represented by a non-Balance invoice.

**Block 2 prevents under-billing.** A paid syrup-only `Drink Plan Extras` invoice increments `amount_paid` without its dollars being in `total_price` (`invoiceExtras.js` treats syrup-only extras as unfolded; the webhook rolls the payment up regardless now that the off-ledger list is empty). `total_price - amount_paid` then understates the true contract balance. Emilene Mccoy is exactly this case: total $300, deposit $100, plus a $60 syrup payment settling by ACH. Once it settles, `amount_paid` reads $160 and the naive formula would mint a $140 Balance invoice against a true $200 balance.

`Drink Plan Extras` cannot be classified by label alone (its `total_price` membership depends on whether its line items include add-on or bar rows). Rather than teach the reconciler to inspect line composition, both blocks treat it as disqualifying. The reconciler heals only cases where `total_price - amount_paid` is provably exact.

### Escalation

A blocked candidate is reported, never auto-billed:

```js
Sentry.captureMessage(
  `Balance invoice missing but proposal is not cleanly reconcilable (proposal ${id})`,
  { level: 'warning',
    tags: { scheduler: 'balance_invoice_reconciler', reason },
    fingerprint: ['balance-invoice-reconciler', String(id)] }
);
```

The per-proposal `fingerprint` makes Sentry group repeat sightings into one issue per proposal instead of a new event every hour.

### Wiring

Follows the existing scheduler contract in `server/index.js` verbatim:

```js
if (enabled('RUN_BALANCE_INVOICE_RECONCILER')) {
  const wrapped = wrapScheduler('balance_invoice_reconciler', 3600, reconcileMissingBalanceInvoices);
  setTimeout(wrapped, 30000);
  setInterval(wrapped, 60 * 60 * 1000);
} else if (!globalScheduleDisabled) {
  clearHealthRow('balance_invoice_reconciler');
}
```

Hourly. `enabled()` already respects the `RUN_SCHEDULERS` master switch (schedulers are production-only unless explicitly opted in), so a dev server will not touch the shared DB. `RUN_BALANCE_INVOICE_RECONCILER=false` is the per-scheduler kill switch, matching the runbook precedent of disabling the dispatcher during an apply window.

`wrapScheduler` already provides error capture (`Sentry.captureException` tagged with the scheduler name), heartbeat recording for the stale-scheduler monitor, and a guarantee that a throw never becomes an unhandled rejection.

### Transaction and failure model

Each candidate is processed in its own transaction. One proposal failing logs, captures to Sentry, and the loop continues to the next. A partial run is safe: the next hourly pass re-evaluates from current state.

Concurrency and overlapping runs are safe by construction. Selection requires no `Balance` invoice, and `createBalanceInvoice` re-checks the same condition inside the transaction, so a duplicate run no-ops.

### What the minted invoice looks like

Entirely `createBalanceInvoice`'s existing behavior, unchanged:

- `label` `'Balance'`, `status` `'sent'` (born payable; a `draft` invoice renders but fails at pay time with "This invoice is no longer available")
- `amount_due` = `toCents(total_price) - toCents(amount_paid)`
- `due_date` = the proposal's `balance_due_date`
- line items from `generateLineItemsFromProposal`
- **unlocked**, so `refreshUnlockedInvoices` keeps it accurate if the proposal is later edited (this matches native events; the hand-minted CC invoices were locked only because their retired override pricing cannot be regenerated from catalog)
- no email, no SMS, no Stripe call

## Blast radius

Verified against the prod branch on 2026-07-21: **the first run mints zero invoices and flags zero proposals.** Every real proposal in `confirmed`/`deposit_paid` with a positive balance already has a `Balance` invoice (the eight CC clients were remediated by hand on 2026-07-20; native events get theirs from the deposit webhook). The only rows that would otherwise have qualified are the seven clientless orphans, excluded by the `client_id` guard.

This is the desired property: the reconciler is a forward-looking safety net, not a bulk backfill. "Zero minted on first prod run" is a deployment verification gate, and a non-zero count on day one means a selection clause is wrong.

## Testing

Unit tests in `server/utils/balanceInvoiceReconciler.test.js`, following the existing `invoiceLifecycle` test patterns. Server tests share the dev DB, so suites run one at a time via `node -r dotenv/config`.

Mints:
1. `deposit_paid` native proposal, Deposit invoice paid, no Balance invoice: mints Balance for exactly `total - paid`.
2. `confirmed` proposal, deposit in `external_paid`, no invoices at all (the CC shape): mints.

Does not mint, and warns:
3. open `Additional Services` invoice present.
4. open `Drink Plan Extras` invoice present.
5. open `Enhancement Lab` invoice present.
6. succeeded `drink_plan_extras` payment present.
7. succeeded `invoice` payment present.

Does not mint, silently:
8. existing `Balance` invoice in any status, including `void`.
9. quote-stage (`draft`/`sent`/`viewed`/`accepted`).
10. `archived`, `balance_paid`, `completed`.
11. `client_id IS NULL`.
12. balance of exactly zero, and negative (overpaid) balance.

Properties:
13. Second consecutive run is a no-op (idempotence).
14. Minted `amount_due` equals `ROUND(total*100) - ROUND(paid*100)` exactly.
15. A failure on one candidate does not abort the batch.

## Rollout

Built in a lane off main per the worktree workflow, not on main. Sequence: implement with tests, run the lane review fleet, merge, run the push review fleet, push, then verify in prod that the first run logs zero mints and zero flags.

## Out of scope

- Pointing balance reminders at `/invoice/:token` instead of the proposal page. The proposal-page button works once an invoice exists, so this is polish, and it is a client-facing copy change worth deciding separately.
- Healing the one `draft` invoice in prod, or adding a draft-to-sent transition. The born-draft trap is a known, separately parked issue.
- Auto-invoicing `completed` events, and post-event AR alerting generally.
- Reconciling the known inconsistency between `refreshUnlockedInvoices` (which subtracts a locked `Drink Plan Extras` from the Balance) and `lab.js` (which does not). Pre-existing, documented, and not touched here.
- Locking minted invoices.
- Any change to `createBalanceInvoice` itself.

## Known residual risks

1. **The reconciler is conservative by design and will not heal tangled proposals.** A proposal with a genuine missing Balance invoice *and* an open extras invoice gets a Sentry warning, not an invoice. That is deliberate, but it means the invariant is enforced automatically only for clean cases. If those warnings become frequent, the answer is to classify `Drink Plan Extras` by line composition, not to loosen the guard.
2. **Label-string coupling.** Both blocking checks and the idempotency guard match on literal label strings. Renaming an invoice label, or introducing a new additive label, silently changes reconciler behavior. `CONTRACT_LABELS` in `proposalMoneyShared.js` already carries a "keep in sync" comment for the same reason; this module must be added to that mental list.
3. **`total_price` moving after mint.** If a proposal's total changes later, the minted Balance invoice is unlocked and `refreshUnlockedInvoices` rebuilds it, which is correct. But that rebuild subtracts `external_paid` and `lockedTotal`, a slightly different formula than the one used at mint. For a clean proposal (the only kind we mint for) the two agree.
