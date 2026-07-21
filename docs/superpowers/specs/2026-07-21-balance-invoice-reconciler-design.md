# Balance-invoice reconciler

**Date:** 2026-07-21
**Status:** design, revised after design-fleet review (rev 2)
**Base:** main @ eeef066

## The invariant

> If a booked event has a balance due, a payable invoice for that balance exists.

Today that invariant holds only as a side effect of the native payment flow, and it broke for an entire cohort of real clients.

## Problem

A `confirmed` proposal's public page has no sign-and-pay affordance. The only pay control is a "Pay balance" button in the paid-state card, rendered only when `open_invoice_token` is non-null (`client/src/pages/proposal/proposalView/ProposalView.js`, gated on `!isFullyPaid && proposal.open_invoice_token`). That token is the oldest invoice in status `sent`/`partially_paid` (LATERAL subquery, `server/routes/proposals/publicToken.js`).

Balance reminders (email and SMS) link to `proposalUrl(token)`, never to an invoice (`server/utils/balanceReminderHandlers.js`, `server/utils/balanceSmsHandlers.js`). With no open invoice the reminder lands on a page with no way to pay, and the handler does not self-suppress because the balance is genuinely positive.

Native events never hit this: `createBalanceInvoice` fires from the Stripe deposit webhook (`stripeWebhookHandlers/paymentIntentSucceeded.js`, `checkoutSessionCompleted.js`), so the Balance invoice exists before the first reminder.

The gap is any post-booking proposal whose deposit never flowed through a Stripe `payment_type='deposit'` webhook: the 13 Check Cherry transfers (imported as `confirmed`, deposit folded into `external_paid`, no invoice row created by `scripts/cc-transfer-events.js`), and any hand-built proposal confirmed with an externally recorded deposit. Eight real clients owed a combined $6,448 with no way to pay, and were dunned up to five times each. They were remediated by hand on 2026-07-20 (INV-0204 through INV-0211). This spec prevents recurrence.

## Goal

A scheduled reconciler that enforces the invariant automatically for the provably-exact case, and escalates everything else to a human rather than guessing on the money path.

Non-goal: collecting money. The reconciler only makes an invoice exist. It sends nothing to clients.

## Why a sweep rather than an event hook

The alternative is minting inline wherever the gap can be created (admin confirm, external payment recording, transfer scripts). That is how we got here: `cc-transfer-events.js` simply never called the invoice path. A sweep enforces the invariant as a property of the data, independent of how a proposal reached that state, and heals retroactively. It follows an established pattern: `server/index.js` already wires 13 schedulers through `wrapScheduler`.

## Design

### Module

`server/utils/balanceInvoiceReconciler.js`, exporting `reconcileMissingBalanceInvoices()`. It reuses `createBalanceInvoice` (`server/utils/invoiceLifecycle.js`) unchanged. No new money math is introduced.

The function returns `{ candidates, minted, flagged }` so tests and the run summary can assert on counts.

### Candidate selection

```sql
SELECT p.id, p.status, p.total_price, p.amount_paid, p.external_paid
  FROM proposals p
 WHERE p.status IN ('confirmed', 'deposit_paid')
   AND p.client_id IS NOT NULL
   AND COALESCE(p.payment_type, '') <> 'full'
   AND COALESCE(p.autopay_status, '') <> 'in_progress'
   AND ROUND(p.total_price * 100)::int - ROUND(p.amount_paid * 100)::int > 0
   AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.proposal_id = p.id AND i.label = 'Balance'
       )
 ORDER BY p.id
```

Each clause earns its place:

- **`status IN ('confirmed','deposit_paid')`** is the post-booking window. It excludes quote-stage proposals (`draft`, `sent`, `viewed`, `modified`, `accepted`), which pay through the sign-and-pay flow and must never receive an auto-invoice, and excludes `archived`, `balance_paid`, `completed`. The full set of legal statuses is the CHECK constraint in `server/db/schema.sql`; this is an inclusion list, so a future status defaults to "not touched".
- **`client_id IS NOT NULL`** excludes orphan proposal shells. Prod holds seven (ids 322, 329, 334, 400, 411, 412, 420: no client, package, venue, or payments, all `completed`, identical $2,000 balance, 2026-05-15 event date). An invoice for a clientless proposal can never be paid.
- **`payment_type <> 'full'`** puts full-payment proposals out of scope. They receive a `'Full Payment'` invoice from `createInvoiceOnSend` and never a `'Balance'`, so the idempotency guard below would treat them as a permanent candidate and then mint a mislabeled invoice. Their total-increase case is already handled by `createAdditionalInvoiceIfNeeded`.
- **`autopay_status <> 'in_progress'`** avoids minting a payable invoice for money already being charged off-session by `processAutopayCharges` (`server/utils/balanceScheduler.js`), whose webhook has not landed yet.
- **Cents arithmetic, not a dollar epsilon.** `createBalanceInvoice` computes `toCents(total_price) - toCents(amount_paid)` and returns null at zero. Selecting on the same integer comparison guarantees we never select a row the helper would no-op on, which would otherwise be a silent hourly retry loop.
- **`NOT EXISTS ... label = 'Balance'`** mirrors `createBalanceInvoice`'s own idempotency guard exactly, including its lack of a status filter. Matching the helper prevents the same select-then-no-op loop. The consequence (a voided Balance invoice permanently hides a proposal) is handled by a separate detector below.

### The three guards

A candidate is minted only if all three pass. Any failure means skip and escalate. Every check runs inside the candidate's transaction, after the row lock.

**Guard A: nothing else is currently payable.**

```sql
SELECT 1 FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.amount_paid < i.amount_due
```

Keyed on an outstanding remainder, not on a status allowlist or a label carve-out. A fully-paid invoice does not block (that is the normal native shape: Deposit paid, Balance needed). Anything with money still owed on it does.

**Guard B: no non-contract invoice exists at all.**

```sql
SELECT 1 FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.label <> ALL ($2)     -- CONTRACT_LABELS
```

**Guard C: `amount_paid` is entirely contract money.**

```sql
SELECT COALESCE(SUM(i.amount_paid), 0) AS contract_paid_cents
  FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.label = ANY ($2)      -- CONTRACT_LABELS
```
Pass only when `toCents(amount_paid) === toCents(external_paid) + contract_paid_cents`.

`CONTRACT_LABELS` is imported from `server/utils/proposalMoneyShared.js` (`['Deposit','Balance','Full Payment']`), never re-declared locally.

### Why three guards, and what each one is actually for

This is the load-bearing part. Getting it wrong bills a real client twice, or bills them too little.

Membership in `CONTRACT_LABELS` is **not** the same as "these dollars are inside `total_price`":

| Label | Dollars inside `total_price`? | In `CONTRACT_LABELS`? |
|---|---|---|
| Deposit / Balance / Full Payment | yes | yes |
| Additional Services | yes (it is a `total_price` increase) | no |
| Enhancement Lab | yes, since the 2026-07-20 fold | no |
| Drink Plan Extras | depends on line composition | no |
| bespoke manual labels (prod has `INV - Balance`, `Gratuity Balance`) | unknown | no |

`OFF_LEDGER_INVOICE_LABELS` is currently `[]`. It briefly held `'Enhancement Lab'` (fc3780f) before the balance fold superseded that model (f68f286, 6aa9a62), so lab money is now ordinary contract money living inside `total_price`.

**Guard A prevents double-billing and duplicate-minting.** If any invoice still has money owed on it, minting `Balance = total_price - amount_paid` bills that money a second time, because `Additional Services` and `Enhancement Lab` dollars are already inside `total_price`. It also covers two cases an earlier draft of this spec missed:
- An **open, unpaid Deposit** invoice. A `confirmed` proposal can sit at `amount_paid = 0` with its Deposit still `sent`. Minting `Balance = total_price` alongside a still-payable Deposit double-bills, and because `open_invoice_token` picks the **oldest** open invoice, the "Pay balance" button would point at the Deposit, the client would pay it, and dunning would continue. That is this spec's own failure mode, recreated.
- A **`draft`** invoice. `server/routes/invoices.js` hardcodes `status: 'draft'` for every admin hand-made invoice, and there is no draft-to-sent route. An admin hand-mints a balance invoice, and an hour later the reconciler mints a duplicate. Guard A keys on `status <> 'void'`, so drafts block.

**Guard B prevents under-billing and fold ambiguity.** A paid syrup-only `Drink Plan Extras` invoice increments `amount_paid` without its dollars being inside `total_price`, so `total_price - amount_paid` understates the true contract balance. Emilene Mccoy is exactly this: total $300, deposit $100, plus a $60 syrup payment. Once it settles, `amount_paid` reads $160 and the naive formula mints a $140 invoice against a true $200 balance. Note that Guard C alone does **not** catch this, because a fully-paid extras invoice is locked and the arithmetic balances ($160 = $100 external + $60 invoice) while the answer is still wrong. Only excluding non-contract invoices outright makes the subtraction provably exact. `Drink Plan Extras` cannot be classified by label alone (its `total_price` membership depends on whether its lines include add-on or bar rows), which is precisely why it is excluded rather than interpreted.

**Guard C prevents offline desync and refund desync.** `POST /:id/record-payment` (`server/routes/proposals/actions.js`) inserts `payment_type` `'deposit'`/`'full'` and links to nothing when no open invoice exists, so `amount_paid` moves without any invoice reflecting it. Minting then produces a correct number that `refreshUnlockedInvoices` later rebuilds incorrectly (see below). A refund is the mirror: it drops `amount_paid` without dropping `total_price`, inflating the computed balance. Both fail the equality and escalate.

**Together they make mint and refresh agree exactly.** `refreshUnlockedInvoices` computes a Balance as `total_price - external_paid - lockedTotal` and never reads `amount_paid` (`server/utils/invoiceLifecycle.js`). Under Guards A, B, and C every invoice is a contract label, every one is fully paid, and `linkPaymentToInvoice` locks exactly on full payment (`server/utils/invoiceLinking.js`). So `lockedTotal` equals the contract invoices' paid total, which by Guard C equals `amount_paid - external_paid`, giving `total_price - external_paid - (amount_paid - external_paid) = total_price - amount_paid`. That is the mint amount. Without these guards, a later admin save, **client drink-plan submit**, or lab save would rebuild the unlocked invoice at a different number and re-bill the client.

### Concurrency

The earlier revision claimed overlapping runs were "safe by construction". That was wrong and is corrected here.

Verified: `invoices` has **no unique index on `(proposal_id, label)`** (only `invoices_pkey`, `invoices_token_key`, `idx_invoices_invoice_number` are unique), and `createBalanceInvoice`'s idempotency guard is a bare `SELECT ... LIMIT 1` with no `FOR UPDATE`. Under READ COMMITTED the reconciler and a concurrent Stripe deposit webhook (which calls the same helper) can both pass the check and both insert. In that race the reconciler reads pre-deposit `amount_paid` and bills the deposit a second time. Overlapping timer ticks and a rolling deploy running two instances are the other two paths.

Two mitigations, both required:

1. **Row lock per candidate.** Each candidate's transaction opens with `SELECT id, total_price, amount_paid, external_paid FROM proposals WHERE id = $1 FOR UPDATE`, and all three guards are evaluated from that locked read. The deposit webhook updates `proposals.amount_paid` in its own transaction, so the lock serializes them and whichever runs second sees committed state. This mirrors the existing precedent: `processAutopayCharges` claims rows atomically and the refund path takes `pg_advisory_xact_lock`.
2. **Partial unique index**, as defense in depth so the invariant is enforced by the database rather than by convention:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_live_balance_per_proposal
    ON invoices (proposal_id)
 WHERE label = 'Balance' AND status <> 'void';
```

Verified safe against current prod data: no proposal has more than one live `Balance` invoice. Added to `server/db/schema.sql`, which replays idempotently on boot.

### Escalation

A blocked candidate is a real client who cannot pay us, which is the exact failure this spec exists to prevent. A passive breadcrumb is the wrong signal, since passive failure is what caused the original incident.

Each blocked candidate gets both:

```js
Sentry.captureMessage(
  `Balance invoice missing and proposal is not cleanly reconcilable (proposal ${id})`,
  { level: 'warning',
    tags: { scheduler: 'balance_invoice_reconciler', reason },
    extra: { proposalId: id, balanceCents, reason, blockingInvoices },
    fingerprint: ['balance-invoice-reconciler', String(id)] }
);
```

and one `notifyAdminCategory({ category: 'payment_failure', subject, emailHtml, emailText })` per run, batched across all blocked candidates so a run reports once rather than per proposal. `notifyAdminCategory` is the same helper `balanceScheduler` uses for autopay failures (`server/utils/adminNotifications.js`). Sentry capture is gated on `process.env.SENTRY_DSN_SERVER`, matching every other `captureMessage` call in the codebase.

**Void-Balance detector.** Because selection matches the helper's status-blind `label='Balance'` guard, a proposal whose only Balance invoice was voided (`server/routes/proposals/cancel.js` voids zero-paid invoices on archive) is invisible to both the healer and the alarm. An archived, recovered, then rebooked proposal is exactly that shape. A separate query detects "post-booking, positive balance, every Balance invoice is void, no live payable invoice" and escalates it through the same path. It never auto-mints, because `createBalanceInvoice` would no-op.

### Per-run cap

`MAX_MINTS_PER_RUN = 5`. Expected steady-state volume is zero. If the candidate count exceeds the cap, the run mints **nothing**, escalates, and returns, on the reasoning that a large candidate set means a selection clause is wrong rather than that eight clients simultaneously lost their invoices. This converts the deployment gate from an observation into a mechanical brake.

### Observability

Every run emits one summary line regardless of outcome, so a reconciler silently matching nothing is distinguishable from a healthy one:

```
[balance_invoice_reconciler] candidates=N minted=M flagged=K capped=false
```

Each mint also writes a `proposal_activity_log` row (`action: 'balance_invoice_auto_created'`, `actor_type: 'system'`, details carrying the invoice id, number, and amount), matching every comparable money mutation (`actions.js`, `invoiceExtras.js`). Without it, an invoice appears in front of a client with no record of what created it.

### Wiring

```js
if (enabled('RUN_BALANCE_INVOICE_RECONCILER')) {
  const wrapped = wrapScheduler('balance_invoice_reconciler', 3600, reconcileMissingBalanceInvoices);
  setTimeout(wrapped, 300000);
  setInterval(wrapped, 60 * 60 * 1000);
} else if (!globalScheduleDisabled) {
  clearHealthRow('balance_invoice_reconciler');
}
```

Hourly. The 300000 boot delay staggers clear of `autopay` and `webhook_events_prune`, which both fire at 30000, and autopay is the money writer this reconciler is most likely to race. `enabled()` already respects the `RUN_SCHEDULERS` master switch (schedulers are production-only unless explicitly opted in), so a dev server will not touch the shared DB. `RUN_BALANCE_INVOICE_RECONCILER=false` is the per-scheduler kill switch.

### Transaction and failure model

Each candidate is processed in its own transaction (lock, evaluate guards, mint, activity log, commit). A failure on one candidate rolls back only that candidate, is captured to Sentry, and the loop continues.

The top-level catch logs, captures to Sentry, and then **rethrows**. This is required by the `wrapScheduler` contract, documented in `server/utils/schedulerHealth.js`: "To detect scheduler failures, the underlying scheduler function MUST rethrow from its top-level catch block." Without the rethrow, `scheduler_health.last_status` reads `ok` even when the candidate query itself is failing, and the stale-scheduler monitor never fires.

### What the minted invoice looks like

Entirely `createBalanceInvoice`'s existing behavior, unchanged: `label` `'Balance'`, `status` `'sent'` (a `draft` renders but fails at pay time), `amount_due = toCents(total_price) - toCents(amount_paid)`, `due_date` from `balance_due_date`, line items from `generateLineItemsFromProposal`, unlocked, and no email, SMS, or Stripe call.

Unlocked is correct here: under the three guards, `refreshUnlockedInvoices` recomputes the identical amount (proven above), so leaving it unlocked keeps it accurate if the proposal is later edited. Two notes for the implementer:

- `due_date` will be NULL for much of the target cohort, since hand-built and transferred proposals often lack a `balance_due_date`. Confirm the invoice page renders a null due date sanely; this is the cohort where it will actually happen.
- `generateLineItemsFromProposal` builds lines from `pricing_snapshot`, while a CC-transferred proposal's `total_price` comes from `total_price_override`. `amount_due` is set explicitly and stays correct, but the line items will not sum to it for override-priced proposals. Cosmetic, and identical to what the hand-minted CC invoices already do.

## Blast radius

Verified against the prod branch on 2026-07-21: **the first run mints zero and flags zero.** Every real proposal in `confirmed`/`deposit_paid` with a positive balance already has a `Balance` invoice (the eight CC clients were remediated by hand on 2026-07-20; native events get theirs from the deposit webhook). The only rows that would otherwise qualify are the seven clientless orphans, excluded by the `client_id` guard.

The reconciler is a forward-looking safety net, not a bulk backfill. "Zero minted on first prod run" is a deployment verification gate, now backed by the run-summary log line and the per-run cap.

### Guard validation against real data

The guards were replayed against prod with the `Balance` invoices simulated away, reproducing the pre-fix state, to confirm they classify real shapes correctly rather than only in theory:

| Proposal | Shape | Verdict | Amount |
|---|---|---|---|
| 601 Jayme, 602 James, 606 Madelyn, 607 Julia, 608 Cecilia | CC transfer, deposit in `external_paid`, no invoices | MINT | $450 / $350 / $1,393 / $2,325 / $970 |
| 436 Ariel, 535 Charley, 540 Minke, 542 Isabell | native, Deposit invoice paid and locked | MINT | $485 / $690 / $250 / $500 |
| 599 Emilene | open `Drink Plan Extras` invoice | BLOCK A | would have under-billed by $60 |
| 547 Iga | open `Gratuity Balance` invoice | BLOCK A | balance already covered |
| 557 Brandon | open `Additional Services` invoice | BLOCK A | balance already covered |
| 51 David | `amount_paid` $100 with zero invoices backing it | BLOCK C | genuinely anomalous, needs a human |

Every MINT amount matches, to the penny, both the invoices hand-minted for the CC cohort on 2026-07-20 and the amounts the deposit webhook produced for the native cohort. Every BLOCK is a case that would have been mis-billed.

## Documentation updates

Required by the Mandatory Documentation Updates table in `CLAUDE.md`, and omitted from the previous revision:

- `README.md`: add `balanceInvoiceReconciler.js` to the folder tree, and `RUN_BALANCE_INVOICE_RECONCILER` to the env var table.
- `ARCHITECTURE.md`: add the scheduler alongside the existing `balanceScheduler` / `refundSweepScheduler` entries.
- `.env.example`: add `RUN_BALANCE_INVOICE_RECONCILER`.
- `CLAUDE.md`: add `RUN_BALANCE_INVOICE_RECONCILER` to the Environment Variables table.

## Testing

Unit tests in `server/utils/balanceInvoiceReconciler.test.js`, following existing `invoiceLifecycle` test patterns. Server tests share the dev DB, so suites run one at a time via `node -r dotenv/config`.

Mints:
1. `deposit_paid` native proposal, Deposit invoice fully paid and locked, no Balance invoice: mints Balance for exactly `total - paid`.
2. `confirmed` proposal, deposit in `external_paid`, no invoices at all (the CC shape): mints.

Blocked by Guard A (and escalated):
3. Open **unpaid** `Deposit` invoice.
4. **Partially paid** `Deposit` invoice.
5. **`draft`** invoice present.
6. Open `Additional Services` invoice.

Blocked by Guard B:
7. Paid, locked, syrup-only `Drink Plan Extras` invoice (the Emilene under-bill case: asserts no mint, and specifically that the arithmetic would otherwise have balanced).
8. `Enhancement Lab` invoice present.
9. Bespoke label (`Gratuity Balance`) present.

Blocked by Guard C:
10. Admin `record-payment` moved `amount_paid` with no invoice to link.
11. A refund dropped `amount_paid` below `external_paid` plus contract-invoice paid total.

Not touched, silently:
12. Existing `Balance` invoice in any non-void status.
13. Quote-stage (`draft`, `sent`, `viewed`, `modified`, `accepted`).
14. `archived`, `balance_paid`, `completed`.
15. `client_id IS NULL`.
16. `payment_type = 'full'`.
17. `autopay_status = 'in_progress'`.
18. Balance exactly zero, and negative (overpaid).

Properties:
19. Second consecutive run is a no-op (idempotence).
20. Minted `amount_due` equals `ROUND(total*100) - ROUND(paid*100)` exactly.
21. **Mint-then-refresh invariance**: after minting, running `refreshUnlockedInvoices` leaves `amount_due` unchanged (guards the re-bill).
22. Concurrent double-mint is impossible: two overlapping transactions against one proposal yield exactly one Balance invoice (exercises both the row lock and the partial unique index).
23. Candidate count above `MAX_MINTS_PER_RUN` mints nothing and escalates.
24. A per-candidate failure rolls back that candidate, is Sentry-captured, and does not abort the batch.
25. The top-level catch rethrows, so `scheduler_health.last_status` records `failed`.
26. Void-Balance detector escalates and does not mint.
27. Run summary counts match the actual mint and flag totals.

## Rollout

Built in a lane off main per the worktree workflow, not on main. Sequence: implement with tests, run the lane review fleet, merge, run the push review fleet, push, then verify in prod that the first run logs `candidates=0 minted=0 flagged=0`.

## Out of scope

- Pointing balance reminders at `/invoice/:token` instead of the proposal page. The proposal-page button works once an invoice exists, so this is polish, and it is a client-facing copy change worth deciding separately.
- Healing the one `draft` invoice in prod, or adding a draft-to-sent transition. The born-draft trap is a known, separately parked issue.
- Auto-invoicing `completed` events, and post-event AR alerting generally.
- Full-payment proposals (`payment_type='full'`), per the selection rationale above.
- Reconciling the known inconsistency between `refreshUnlockedInvoices` (which subtracts a locked `Drink Plan Extras` from the Balance) and `lab.js` (which does not). Pre-existing and documented; Guard B keeps the reconciler clear of it.
- Adding `Enhancement Lab` to `CONTRACT_LABELS`. Its dollars are inside `total_price` since the fold but it is not a contract label, which means a refund against one inflates the computed balance. Guard C catches that case by escalating. The underlying classification question is a separate decision.
- Any change to `createBalanceInvoice` itself.

## Known residual risks

1. **Conservative by design.** A proposal with a genuinely missing Balance invoice *and* any extras or lab activity escalates rather than heals. The invariant is enforced automatically only for provably-exact cases. If those escalations become frequent, the answer is to classify `Drink Plan Extras` by line composition, not to loosen a guard.
2. **Label-string coupling.** The guards match on `CONTRACT_LABELS` plus the literal `'Balance'`. Introducing a new additive invoice label silently changes reconciler behavior. `proposalMoneyShared.js` already carries a "keep in sync" comment; this module joins that list.
3. **Payroll fee-netting moves.** `payrollAccrual` counts a payment's Stripe fee only for the share landing on `CONTRACT_LABELS` invoices. A client who would previously have paid a bespoke-labeled invoice (contributing no fee, so staff kept the whole gratuity) now pays a real `'Balance'`, so the pro-rata fee begins netting against the pool. This is the intended fee-netting behavior, but it is a real change worth naming.
