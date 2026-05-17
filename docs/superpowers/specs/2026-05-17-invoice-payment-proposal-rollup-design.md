# Invoice-Payment → Proposal Roll-Up Fix — Design

**Date:** 2026-05-17
**Status:** Approved (design)
**Trigger:** Ketan Patel (proposal 54) — paid balance in full, UI shows balance unpaid; only one invoice visible.

## Problem

A client paid their balance through the public invoice payment page. The invoice was
correctly marked `paid`, but every proposal/client surface still shows the balance
owed. Separately, only one invoice (the Balance) is visible — no Deposit invoice exists.

### Root cause (confirmed by code trace + production data)

`server/routes/stripe.js`, the `payment_intent.succeeded` webhook handler, branches on
`paymentType`:

- `'full'` → `amount_paid = total_price`, status `balance_paid`
- `'balance'` → `amount_paid = total_price`, status `balance_paid`
- `'drink_plan_extras' | 'drink_plan_with_balance'` → increment `amount_paid`, promote if paid up
- `else` (deposit) → `amount_paid = deposit_amount`, status `deposit_paid`,
  gated `WHERE status NOT IN ('deposit_paid','balance_paid','confirmed')`

There is **no `'invoice'` branch.** The invoice-payment intent created by
`create-intent-for-invoice/:token` (stripe.js:585) sets `payment_type: 'invoice'`. That
value falls into the final `else` (deposit) branch, whose `WHERE` clause matches **zero
rows** for an already-`deposit_paid` proposal. The invoice row is updated correctly via
`linkPaymentToInvoice` (it is wired through separate `invoice_id` metadata), but
`proposals.amount_paid` and `proposals.status` are never rolled up.

Result: any UI computing `total_price − amount_paid` shows the full balance still owed.

### Production evidence — proposal 54 (Ketan Patel, client 102)

| Source | Record |
|---|---|
| `proposal_payments` #24 | $100 (10000¢) `deposit` **succeeded** 2026-05-15T22:54:24.634Z — `pi_3TXUZxAZrfv5tWfN3zAHPFoo` |
| `proposal_payments` #25 | $550 (55000¢) `invoice` **succeeded** 2026-05-16T19:40:59.655Z — `pi_3TXo3wAZrfv5tWfN34hdR4EK` |
| `invoices` INV-0009 | label `Balance`, amount_due 55000, amount_paid 55000, status `paid`, locked, created 2026-05-15T22:54:24.634Z |
| `invoice_payments` | #25 → invoice 9, 55000¢ |
| `proposals` (54) | total_price **650.00**, deposit_amount 100.00, amount_paid **100.00**, status **`deposit_paid`** ❌ |

Both Stripe charges succeeded ($100 + $550 = $650 = full total). The invoice ledger is
correct; the proposal was never updated. No Deposit invoice was ever created because
`createInvoiceOnSend` (fires on proposal→`sent`) never ran for this proposal — a
Check Cherry cutover artifact (Ketan is the first post-cutover booking). `createBalanceInvoice`
then produced INV-0009 directly after the deposit.

### Blast radius

Systemic, not Ketan-specific. **Every** payment with `payment_type='invoice'` (Balance,
Additional Services, manual invoices) marks the invoice paid but never rolls up to the
proposal. It surfaced now because Ketan is the first real booking where a direct invoice
payment link was used for the balance.

## Money-type boundary (load-bearing)

- `proposal_payments.amount`, `invoices.amount_due/amount_paid`, `intent.amount` → **integer cents**
- `proposals.amount_paid / total_price / deposit_amount` → **NUMERIC dollars**

The fix must add `intent.amount / 100` (dollars) to `proposals.amount_paid`, exactly as
the existing `drink_plan_extras` branch does.

## Deliverables

### 1. Code fix — `server/routes/stripe.js`

Add an `'invoice'` branch in `payment_intent.succeeded`, **before** the final `else`,
mirroring the proven `drink_plan_extras` branch:

```js
} else if (paymentType === 'invoice') {
  const paidDollars = intent.amount / 100;
  const upd = await dbClient.query(
    `UPDATE proposals SET amount_paid = COALESCE(amount_paid,0) + $1
       WHERE id = $2 RETURNING amount_paid, total_price`,
    [paidDollars, proposalId]
  );
  if (upd.rows[0] && Number(upd.rows[0].amount_paid) >= Number(upd.rows[0].total_price)) {
    await dbClient.query(
      "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed','completed')",
      [proposalId]
    );
  }
}
```

Plus two same-root-cause one-liners (the `invoice` type otherwise inherits "deposit"
defaults):

- Activity-log `action` ternary: add `: paymentType === 'invoice' ? 'invoice_paid'`.
  Safe — `proposal_activity_log.action` has no CHECK constraint (verified).
- `sendPaymentNotifications` `payLabel`: add an `invoice` → `'invoice payment'` case so
  the client/admin receipt email does not say "deposit".

Semantics: **increment, then promote to `balance_paid` only when
`amount_paid >= total_price`; never regress; never auto-`confirm`.** Handles partial
invoice payments and Additional Services (which push `amount_paid` above `total_price`)
correctly. Idempotency is already guaranteed — the entire block runs inside
`if (isFirstDelivery)` (gated by the `ON CONFLICT` insert into `proposal_payments`); a
Stripe retry does not re-increment. The existing `linkPaymentToInvoice(invoiceId,…)`
integration is unchanged and continues to mark the invoice itself paid.

### 2. Data scripts — `server/scripts/` (run after the code fix deploys)

**2a. `backfillProposal54DepositInvoice.js`** — synthesize the missing paid Deposit
invoice using the real helpers so the row is structurally identical to a
normally-created one:

- Guard: exit if a `Deposit` invoice already exists for proposal 54 (re-run-safe).
- `createInvoice({ proposalId: 54, label: 'Deposit', amountDueCents: 10000, status: 'sent' })`
  → `writeLineItems(generateLineItemsFromProposal(54))`
  → `linkPaymentToInvoice(newInvoiceId, 24, 10000)` — links the already-succeeded
  deposit payment #24, driving `amount_paid → 10000`, status `paid`, and locking it.
- Final `UPDATE invoices SET created_at = '2026-05-15T22:54:23Z',
  locked_at = '2026-05-15T22:54:24.634Z' WHERE id = <new>` so it sorts **before**
  INV-0009 (created `…:24.634Z`) in the admin list (ordered `created_at ASC`).
- Touches only invoice tables (`linkPaymentToInvoice` never writes `proposals`) →
  independent of 2b and the code fix.

**2b. `repairProposal54Balance.sql`** — proposal-level correction, guarded so it is a
strict no-op unless the exact known-buggy state is present:

```sql
UPDATE proposals
   SET amount_paid = 650.00, status = 'balance_paid', autopay_status = NULL
 WHERE id = 54 AND amount_paid = 100.00 AND status = 'deposit_paid';

INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
VALUES (54, 'balance_correction', 'system',
  '{"reason":"invoice-payment roll-up bug; payments pi_3TXUZxAZrfv5tWfN3zAHPFoo + pi_3TXo3wAZrfv5tWfN34hdR4EK both succeeded = $650 full total","amount_paid_before":100.00,"amount_paid_after":650.00}'::jsonb);
```

The guarded `WHERE` is the safety mechanism — it cannot double-apply or clobber a
different state. `autopay_status = NULL` mirrors the `balance` branch. Before running,
re-verify proposal 54's `autopay_status` and shift state (the deposit webhook already
ran `createEventShifts`, which is idempotent → expected no-op; confirm, do not assume).

### Sequencing

1. Implement + verify code fix (Deliverable 1).
2. User pushes / deploys.
3. Run 2a (deposit backfill).
4. Run 2b (balance repair).

All data mutation happens post-deploy (per "fix code first, repair after"). Each script
is independently re-runnable.

## Verification

- **Code fix:** no route/DB test harness exists (only pure-function `node:test`); the
  webhook money code will **not** be refactored for testability. Verify via a throwaway
  reproduction on a **Neon test branch**: seed a `deposit_paid` proposal, replay the new
  branch's SQL, assert `amount_paid` increments and status flips to `balance_paid`, then
  re-run to prove idempotency. Plus the mandatory pre-push review fleet (money + webhook
  → all 5 agents).
- **Data scripts:** dry-run the `SELECT` form first; confirm post-conditions
  (`proposals` row corrected, Deposit invoice present + `paid`/locked + ordered before
  INV-0009, both invoices visible in the admin list).

## Risk

Low. The code change is a near-verbatim copy of an existing proven branch in the same
file. `action='invoice_paid'` is safe (no CHECK constraint). Data scripts are guarded
and idempotent. The only care-point is the backfill's `created_at`/`locked_at`
backdating — cosmetic ordering only, no money math, isolated to a final `UPDATE`.

## Out of scope

- Refactoring `stripe.js` for unit-testability or building DB integration-test infra.
- Any other `payment_type` (all others are correctly handled).
- Backfilling missing Deposit invoices for proposals other than 54, or fixing the
  upstream `createInvoiceOnSend`-skipped-on-cutover gap (one-off; no other affected
  proposals identified — Ketan is the first post-cutover booking).
