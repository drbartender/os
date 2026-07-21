# Balance-invoice reconciler

**Date:** 2026-07-21
**Status:** design, revised after a second design-fleet review (rev 3)
**Base:** main @ 97cf952

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
   AND ROUND(COALESCE(p.total_price, 0) * 100)::int
     - ROUND(COALESCE(p.amount_paid, 0) * 100)::int > 0
   AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.proposal_id = p.id AND i.label = 'Balance'
       )
 ORDER BY p.id
```

`total_price` and `amount_paid` are both nullable (`NUMERIC(10,2)`, no NOT NULL), and every webhook branch already defends with `COALESCE(amount_paid, 0)`. Without the COALESCE a NULL makes the comparison NULL and the row becomes silently invisible to both the healer and the alarm, and hand-built or imported proposals are exactly where a NULL lives.

Each clause earns its place:

- **`status IN ('confirmed','deposit_paid')`** is the post-booking window. It excludes quote-stage proposals (`draft`, `sent`, `viewed`, `modified`, `accepted`), which pay through the sign-and-pay flow and must never receive an auto-invoice, and excludes `archived`, `balance_paid`, `completed`. The full set of legal statuses is the CHECK constraint in `server/db/schema.sql`; this is an inclusion list, so a future status defaults to "not touched".
- **`client_id IS NOT NULL`** excludes orphan proposal shells. Prod holds seven (ids 322, 329, 334, 400, 411, 412, 420: no client, package, venue, or payments, all `completed`, identical $2,000 balance, 2026-05-15 event date). An invoice for a clientless proposal can never be paid.
- **`payment_type <> 'full'`** puts full-payment proposals out of scope. They receive a `'Full Payment'` invoice from `createInvoiceOnSend` and never a `'Balance'`, so the idempotency guard below would treat them as a permanent candidate and then mint a mislabeled invoice. Their total-increase case is already handled by `createAdditionalInvoiceIfNeeded`.
- **`autopay_status <> 'in_progress'`** avoids minting a payable invoice for money already being charged off-session by `processAutopayCharges` (`server/utils/balanceScheduler.js`), whose webhook has not landed yet.
- **Cents arithmetic, not a dollar epsilon.** `createBalanceInvoice` computes `toCents(total_price) - toCents(amount_paid)` and returns null at zero. Selecting on the same integer comparison guarantees we never select a row the helper would no-op on, which would otherwise be a silent hourly retry loop.
- **`NOT EXISTS ... label = 'Balance'`** mirrors `createBalanceInvoice`'s own idempotency guard exactly, including its lack of a status filter. Matching the helper prevents the same select-then-no-op loop. The consequence (a voided Balance invoice permanently hides a proposal) is handled by a separate detector below.

### The three guards

A candidate is minted only if all three pass. Any failure means skip and escalate. Every check runs inside the candidate's transaction, after the row lock.

**Guard A: every existing invoice is settled.**

```sql
SELECT 1 FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.status <> 'paid'
```

Keyed on settled status, not on an outstanding remainder. An earlier draft used `amount_paid < amount_due`, which let through a non-void invoice with `amount_due = 0` in status `sent`. That invoice is older than the fresh mint, and `open_invoice_token` picks the **oldest** `sent`/`partially_paid` invoice, so the "Pay balance" button would point at a $0 invoice and the client still could not pay. Reachable because `refreshUnlockedInvoices` rewrites an unlocked Deposit's `amount_due` to `depositCents`, and `toCents(null) === 0`. Keying on `status <> 'paid'` also subsumes `draft`, `sent`, and `partially_paid` in one clause.

**Guard B: no non-contract invoice exists at all.**

```sql
SELECT 1 FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.label <> ALL ($2)     -- CONTRACT_LABELS
```

**Guard C: locked invoice totals exactly account for the money already paid.**

```sql
SELECT COALESCE(SUM(i.amount_due), 0) AS locked_total_cents
  FROM invoices i
 WHERE i.proposal_id = $1
   AND i.status <> 'void'
   AND i.locked = true
```
Pass only when `locked_total_cents === toCents(amount_paid) - toCents(external_paid)`.

This is deliberately the same quantity `refreshUnlockedInvoices` uses, so the guard directly encodes mint/refresh agreement rather than arguing for it. An earlier draft summed `amount_paid` across contract invoices instead, which passed a reachable re-bill: `linkPaymentToInvoice` does not lock a partially-paid invoice, and a later `refreshUnlockedInvoices` can rewrite that unlocked invoice's `amount_due` down below its `amount_paid`. The invoice then looks settled, contributes nothing to `lockedTotal`, and the mint and the next refresh disagree by the entire paid deposit.

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
- A **`draft`** invoice. `server/routes/invoices.js` hardcodes `status: 'draft'` for every admin hand-made invoice, and there is no draft-to-sent route. An admin hand-mints a balance invoice, and an hour later the reconciler mints a duplicate. Guard A requires every non-void invoice to be `paid`, so drafts block.
- A **zero-due open** invoice, which would otherwise own `open_invoice_token` and point the Pay button at a $0 invoice.

**Guard B prevents under-billing and fold ambiguity.** A paid syrup-only `Drink Plan Extras` invoice increments `amount_paid` without its dollars being inside `total_price`, so `total_price - amount_paid` understates the true contract balance. Emilene Mccoy is exactly this: total $300, deposit $100, plus a $60 syrup payment. Once it settles, `amount_paid` reads $160 and the naive formula mints a $140 invoice against a true $200 balance. Note that Guard C alone does **not** catch this, because a fully-paid extras invoice is locked and the arithmetic balances ($160 = $100 external + $60 invoice) while the answer is still wrong. Only excluding non-contract invoices outright makes the subtraction provably exact. `Drink Plan Extras` cannot be classified by label alone (its `total_price` membership depends on whether its lines include add-on or bar rows), which is precisely why it is excluded rather than interpreted.

**Guard C prevents offline desync and makes mint and refresh agree by construction.** `refreshUnlockedInvoices` computes a Balance as `total_price - external_paid - lockedTotal` and never reads `amount_paid` (`server/utils/invoiceLifecycle.js`). The mint computes `total_price - amount_paid`. Substituting Guard C's equality (`lockedTotal = amount_paid - external_paid`) into the refresh formula gives `total_price - external_paid - (amount_paid - external_paid) = total_price - amount_paid`, which is the mint amount. So a later admin save, **client drink-plan submit**, or lab save rebuilds the unlocked invoice to the identical number rather than re-billing the client. The guard is the proof, not an argument about it.

It also catches offline desync: `POST /:id/record-payment` (`server/routes/proposals/actions.js`) inserts `payment_type` `'deposit'`/`'full'` and links to nothing when no open invoice exists, so `amount_paid` moves with no locked invoice behind it and the equality fails. Note that route rejects `confirmed` outright, so this shape is reachable only for `deposit_paid` candidates, not the CC cohort.

**A note on refunds, correcting an earlier draft.** A previous revision claimed a refund "drops `amount_paid` without dropping `total_price`" and would therefore escalate. That is wrong: `refundHelpers.js` drops the invoice's `amount_due` **and** `amount_paid` together, and drops `proposals.total_price` **and** `amount_paid` by the same contract cents. So a refund against a contract invoice leaves Guard C's equality balanced and the candidate mints rather than escalating. The mint amount stays arithmetically correct, but the resulting behavior (a partially-refunded booking auto-mints a Balance invoice for the reduced remainder) is a real consequence, and it is intended rather than incidental. Only a refund against an unlinked payment breaks the equality; a refund against a non-contract invoice is already blocked by Guard B.

### Concurrency

The earlier revision claimed overlapping runs were "safe by construction". That was wrong and is corrected here.

Verified: `invoices` has **no unique index on `(proposal_id, label)`** (only `invoices_pkey`, `invoices_token_key`, `idx_invoices_invoice_number` are unique), and `createBalanceInvoice`'s idempotency guard is a bare `SELECT ... LIMIT 1` with no `FOR UPDATE`. Under READ COMMITTED the reconciler and a concurrent Stripe deposit webhook (which calls the same helper) can both pass the check and both insert. In that race the reconciler reads pre-deposit `amount_paid` and bills the deposit a second time. Overlapping timer ticks and a rolling deploy running two instances are the other two paths.

**The row lock alone is not sufficient, and an earlier draft was wrong to claim it was.** The deposit branches update the proposal with `WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')` (`paymentIntentSucceeded.js`, `checkoutSessionCompleted.js`). For a **`confirmed`** proposal that predicate matches zero rows, so the webhook acquires **no lock on `proposals`** at all, yet still calls `createBalanceInvoice` unconditionally. Since `confirmed` is half the target cohort, a `FOR UPDATE` on `proposals` does not serialize the reconciler against the webhook for exactly the proposals this spec exists to serve. The only lock a deposit webhook takes is `FOR UPDATE OF c` on `clients`.

So the database constraint is the load-bearing guard, not defense in depth. Three mitigations, all required:

1. **Row lock per candidate.** Each candidate's transaction opens with `SELECT id, total_price, amount_paid, external_paid FROM proposals WHERE id = $1 FOR UPDATE`, and all three guards plus the balance are re-derived from that locked read, never from the candidate query's snapshot. This does serialize against `deposit_paid` candidates and against admin writes that lock the proposal, and it is the cheaper guard. It is not relied upon for `confirmed`.
2. **Partial unique index**, which enforces the invariant in the database regardless of who is writing:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_live_balance_per_proposal
    ON invoices (proposal_id)
 WHERE label = 'Balance' AND status <> 'void';
```

Verified safe against current prod data: no proposal has more than one live `Balance` invoice, so the index will build.

3. **Register the index in `CRITICAL_INDEXES`** (`server/db/index.js`), and add it to `server/db/criticalIndexes.test.js`. This is mandatory, not optional. `initDb` treats `23505` as an idempotent replay code, and that file already documents the exact trap in a comment: "A partial UNIQUE index that fails to build on pre-existing duplicate data raises 23505, which the IDEMPOTENT_PG_CODES swallow above treats as 'already applied', so a silently-absent guard would boot clean with no alert (F7 review follow-up)." Without registration, a single pre-existing duplicate at deploy time leaves the only real concurrency guard silently absent forever.

**Loser semantics.** When the index rejects a duplicate, the loser is whichever transaction commits second. If that is the reconciler, it catches `23505`, treats it as "already healed", and moves on without escalating. If it is the webhook, the deposit transaction would roll back to a 5xx and rely on Stripe retry, which is why the reconciler must also catch `23505` rather than letting it surface.

**Lock ordering.** The reconciler deliberately takes no invoice row locks. `refundHelpers` locks invoices before proposals, so an implementer who adds `FOR UPDATE` to the Guard A/B/C selects would invert that order and create an AB-BA deadlock against the refund path. Do not add invoice locks.

**Overlapping ticks.** `wrapScheduler` has no in-flight guard, so two ticks can overlap. They cannot double-mint (the second blocks on `FOR UPDATE` for `deposit_paid`, and the unique index catches `confirmed`), but the second could emit a spurious escalation for a proposal the first just healed. The `23505`-as-already-healed rule above covers this.

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

and a `notifyAdminCategory({ category: 'payment_failure', subject, emailHtml, emailText })`, **throttled to once per 24 hours per proposal**.

The throttle is mandatory and copies `balanceScheduler`'s existing pattern exactly, including its rationale ("otherwise a permanently-dead card emails the admin every hour forever"). A blocked candidate is permanently blocked by construction: nothing in the reconciler changes its state, and no human action is required for it to stay blocked. `notifyAdminCategory` itself has no dedupe or cooldown and fans out to every subscribed admin and manager, so an unthrottled call would emit one email per recipient per hour forever, against a Resend account whose free-tier daily cap is shared with client balance reminders and receipts. Sentry's `fingerprint` dedupes Sentry only, not email.

Implementation, mirroring `balanceScheduler`: write a `proposal_activity_log` row for the escalation, then send only if no row for that proposal with `action = 'balance_invoice_unreconcilable'` and `details->>'admin_notified' = 'true'` exists within 24 hours; on send, stamp `admin_notified` onto the row just written. Sentry capture is gated on `process.env.SENTRY_DSN_SERVER`, which is the common (though not universal) convention in this codebase.

**Void-Balance detector.** Because selection matches the helper's status-blind `label='Balance'` guard, a proposal whose only Balance invoice was voided (`server/routes/proposals/cancel.js` voids zero-paid invoices on archive) is invisible to both the healer and the alarm. An archived, recovered, then rebooked proposal is exactly that shape. It runs as a second query in the same pass, with the same eligibility filters as candidate selection so it cannot re-flag the clientless orphans or out-of-scope statuses:

```sql
SELECT p.id
  FROM proposals p
 WHERE p.status IN ('confirmed', 'deposit_paid')
   AND p.client_id IS NOT NULL
   AND COALESCE(p.payment_type, '') <> 'full'
   AND COALESCE(p.autopay_status, '') <> 'in_progress'
   AND ROUND(COALESCE(p.total_price, 0) * 100)::int
     - ROUND(COALESCE(p.amount_paid, 0) * 100)::int > 0
   AND EXISTS (SELECT 1 FROM invoices i WHERE i.proposal_id = p.id AND i.label = 'Balance')
   AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.proposal_id = p.id AND i.label = 'Balance' AND i.status <> 'void'
       )
   AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.proposal_id = p.id AND i.status IN ('sent', 'partially_paid')
       )
```

It never mints, because `createBalanceInvoice` would no-op on the voided row. Its hits count toward `flagged`, use the same 24h-throttled notification, and do **not** consume the mint cap.

### Per-run cap

`MAX_MINTS_PER_RUN = 5`, counted against **mints actually attempted**, never against the candidate count.

An earlier draft gated on candidate count, which wedges permanently. A blocked candidate never leaves the candidate set: it still has no Balance invoice, a positive balance, and a post-booking status, and nothing in the reconciler changes that. Known Residual Risk 1 explicitly anticipates blocked candidates as a normal outcome, so six of them would have stopped the reconciler from healing any legitimate seventh case, forever and silently.

Counting mints instead means blocked candidates are escalated but do not consume the cap. If a run reaches the cap it mints its five, logs `capped=true`, escalates once, and leaves the remainder for the next hourly run, which drains rather than stalls. Expected steady-state volume is zero, so reaching the cap at all is a signal that a selection clause is wrong.

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

Each candidate is processed in its own transaction: lock the proposal row, re-derive the balance and all three guards from the locked read, call `createBalanceInvoice`, and only if it returns a row, write the activity log and count the mint, then commit.

**`createBalanceInvoice` returning null is an expected branch, not an error.** It returns null in two states reachable after the lock: a racing deposit webhook already committed a `Balance`, or the locked re-read makes `toCents(total_price) - toCents(amount_paid)` zero. The implementation must not write a `proposal_activity_log` row for a mint that did not happen, must not count it toward `minted`, and must not treat it as a failure. A `23505` from the partial unique index is handled the same way (see Loser semantics above).

A failure on one candidate rolls back only that candidate, is captured to Sentry, and the loop continues.

The top-level catch logs, captures to Sentry, and then **rethrows**. This is required by the `wrapScheduler` contract, documented in `server/utils/schedulerHealth.js`: "To detect scheduler failures, the underlying scheduler function MUST rethrow from its top-level catch block." Without the rethrow, `scheduler_health.last_status` reads `ok` even when the candidate query itself is failing, and the stale-scheduler monitor never fires.

### What the minted invoice looks like

Entirely `createBalanceInvoice`'s existing behavior, unchanged: `label` `'Balance'`, `status` `'sent'` (a `draft` renders but fails at pay time), `amount_due = toCents(total_price) - toCents(amount_paid)`, `due_date` from `balance_due_date`, line items from `generateLineItemsFromProposal`, unlocked, and no email, SMS, or Stripe call.

Unlocked is correct here: under the three guards, `refreshUnlockedInvoices` recomputes the identical amount (proven above), so leaving it unlocked keeps it accurate if the proposal is later edited. Two notes for the implementer:

- `due_date` will be NULL for much of the target cohort, since hand-built and transferred proposals often lack a `balance_due_date`. Confirm the invoice page renders a null due date sanely; this is the cohort where it will actually happen.
- **Line items need a fallback.** `generateLineItemsFromProposal` builds solely from `pricing_snapshot`, while an override-priced proposal's `total_price` comes from `total_price_override` and its snapshot may be thin or empty. `amount_due` is set explicitly and stays correct, but the client-facing invoice could show items that do not sum to the ask, or no items at all, against a four-figure amount. That is the normal case for this cohort, not an edge case, and `lab.js` already treats "lines sum to amount_due" as a ledger invariant. So: after generating, if the items are empty or do not sum to `amount_due`, replace them with a single line reading `Event balance` for the full amount. This mirrors the fallback `invoiceExtras.js` already applies, and matches the shape of the hand-minted CC invoices.

## Blast radius

Verified against the prod branch on 2026-07-21: **the first run mints zero and flags zero.** Every real proposal in `confirmed`/`deposit_paid` with a positive balance already has a `Balance` invoice (the eight CC clients were remediated by hand on 2026-07-20; native events get theirs from the deposit webhook).

To be precise about the `client_id` guard: the seven clientless orphans are all `completed`, so the status filter already excludes them and the `client_id` clause currently defends against nothing measurable. It is kept deliberately, because "never invoice a proposal with no client" is a property worth asserting independently of which status those rows happen to carry today.

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

## Adjacent code this change obligates

The partial unique index constrains two existing admin write paths that can produce a second live `Balance` invoice today, and neither translates a raw Postgres error:

- `POST /api/invoices/proposal/:proposalId` (`server/routes/invoices.js`) accepts a free-text `label`, including literally `'Balance'`. This is the same path used to hand-mint INV-0204 through INV-0211 on 2026-07-20.
- `PATCH /api/invoices/:id` relabels any unlocked invoice.

Both must catch `23505` on the new index and throw `ConflictError`, per the CLAUDE.md rule that client-visible errors are `AppError` subclasses. Without this they surface as a raw 500.

`scripts/cc-balance-invoice.js` also raw-inserts a `'Balance'` invoice, guarded only by `NOT EXISTS (... status <> 'void')`. It is a one-time operator script slated for deletion after the Check Cherry cutover, so it needs no change, but it must not be re-run after the index lands without that guard being reconciled.

## Documentation updates

Required by the Mandatory Documentation Updates table in `CLAUDE.md`, and omitted from earlier revisions:

- `README.md`: add `balanceInvoiceReconciler.js` to the folder tree, `RUN_BALANCE_INVOICE_RECONCILER` to the env var table, and an entry to Key Features.
- `ARCHITECTURE.md`: add a prose mention of the scheduler in the payments area, alongside the existing `balanceScheduler` and `refundSweepScheduler` mentions, and document the new index in the Database Schema section under Invoices, where constraints such as `invoices_amounts_nonneg` are already listed.
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
6a. Non-void invoice with `amount_due = 0` in status `sent` (the zero-due token-stealing case).

Blocked by Guard B:
7. Paid, locked, syrup-only `Drink Plan Extras` invoice (the Emilene under-bill case: asserts no mint, and specifically that the arithmetic would otherwise have balanced).
8. `Enhancement Lab` invoice present.
9. Bespoke label (`Gratuity Balance`) present.

Blocked by Guard C:
10. Admin `record-payment` moved `amount_paid` with no invoice to link (a `deposit_paid` proposal, since the route rejects `confirmed`).
11. A **partially paid, unlocked** invoice whose `amount_due` was later refreshed down below its `amount_paid`: asserts the block, since Guard A alone would pass it once it looks settled and the mint would otherwise diverge from the next refresh by the whole deposit.

Not touched, silently:
12. Existing `Balance` invoice in any non-void status.
13. Quote-stage (`draft`, `sent`, `viewed`, `modified`, `accepted`).
14. `archived`, `balance_paid`, `completed`.
15. `client_id IS NULL`.
16. `payment_type = 'full'`.
17. `autopay_status = 'in_progress'`.
18. Balance exactly zero, and negative (overpaid).

Not touched, silently (continued):
18a. NULL `total_price` or NULL `amount_paid` rows are handled by the COALESCE and do not throw or vanish unnoticed.

Properties:
19. Second consecutive run is a no-op (idempotence).
20. Minted `amount_due` equals `ROUND(total*100) - ROUND(paid*100)` exactly.
21. **Mint-then-refresh invariance**: after minting, running `refreshUnlockedInvoices` leaves `amount_due` unchanged (guards the re-bill).
22. Concurrent double-mint is impossible: two overlapping reconciler transactions against one proposal yield exactly one Balance invoice.
22a. **Reconciler versus deposit webhook**, which is the race the concurrency section is actually written for, run against a `confirmed` proposal where the webhook takes no proposal lock: exactly one Balance invoice results, and the reconciler treats its `23505` as already-healed rather than escalating.
23. Reaching `MAX_MINTS_PER_RUN` mints exactly the cap, logs `capped=true`, and leaves the remainder for the next run.
23a. Six permanently **blocked** candidates do not consume the cap and do not prevent a legitimate seventh candidate from being minted (guards the wedge).
24. A per-candidate failure rolls back that candidate, is Sentry-captured, and does not abort the batch.
24a. `createBalanceInvoice` returning null writes no activity-log row and does not increment `minted`.
25. The top-level catch rethrows, so `scheduler_health.last_status` records `failed`.
26. Void-Balance detector escalates, does not mint, and does not consume the mint cap.
27. Run summary counts match the actual mint and flag totals.
28. **Escalation throttle**: a blocked candidate notifies once, and a second run within 24 hours does not send another email.
29. Line-item fallback: an override-priced proposal with an empty or non-summing snapshot yields a single `Event balance` line equal to `amount_due`.
30. `findMissingCriticalIndexes` includes `idx_invoices_one_live_balance_per_proposal` (extend `server/db/criticalIndexes.test.js`).
31. The admin invoice-create route returns a `ConflictError`, not a 500, when it would create a second live `Balance` invoice.

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

   A known, accepted false block: a **fully paid, locked** `Additional Services` or `Enhancement Lab` invoice would satisfy Guards A and C, and both labels' dollars are inside `total_price`, so the mint would in fact be exact. Guard B blocks it anyway, because the justification for excluding non-contract labels (line-composition ambiguity) applies only to `Drink Plan Extras`. This is accepted rather than special-cased, to keep Guard B a single label-set test with no per-label reasoning. The accumulation risk is low: a proposal only becomes a candidate if it has no `Balance` invoice at all, and native proposals receive one at deposit time.

2. **A narrow cross-transaction race with admin proposal edits.** `crud.js` commits a proposal edit and then runs `refreshUnlockedInvoices` and `createAdditionalInvoiceIfNeeded` in a **separate** transaction that does not lock the proposal. In that window `total_price` is already raised while the `Additional Services` invoice does not yet exist, so the reconciler could take the lock, pass all three guards, and mint a Balance covering the increase that `createAdditionalInvoiceIfNeeded` then bills again. Both `submit.js` and `lab.js` refresh inside the transaction that holds the proposal lock, so this tail is the only exposure. It requires the proposal to have no Balance invoice at all and an edit landing inside a sub-second window against an hourly job. Documented rather than fixed; the durable fix is to move that tail inside the transaction, which is out of scope here.
3. **Label-string coupling.** The guards match on `CONTRACT_LABELS` plus the literal `'Balance'`. Introducing a new additive invoice label silently changes reconciler behavior. `proposalMoneyShared.js` already carries a "keep in sync" comment; this module joins that list.

4. **The void-Balance shape can only be alarmed on, never healed.** An archived, recovered, then rebooked proposal whose `Balance` was voided is detected and escalated, but `createBalanceInvoice` will not mint over it. So "prevents recurrence" holds fully for the never-had-a-Balance cohort and only partially for that one.

5. **Payroll fee-netting moves.** `payrollAccrual` counts a payment's Stripe fee only for the share landing on `CONTRACT_LABELS` invoices. A client who would previously have paid a bespoke-labeled invoice (contributing no fee, so staff kept the whole gratuity) now pays a real `'Balance'`, so the pro-rata fee begins netting against the pool. This is the intended fee-netting behavior, but it is a real change worth naming.
