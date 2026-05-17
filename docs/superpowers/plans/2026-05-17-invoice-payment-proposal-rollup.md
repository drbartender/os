# Invoice-Payment → Proposal Roll-Up Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `payment_type='invoice'` Stripe payments roll up into the parent proposal (`amount_paid` + `status`), then reconcile proposal 54 (Ketan Patel) with a backfilled Deposit invoice and a balance correction.

**Architecture:** Add a dedicated `'invoice'` branch to the `payment_intent.succeeded` webhook handler in `server/routes/stripe.js`, mirroring the proven `drink_plan_extras` increment-and-promote pattern. The webhook money code is NOT refactored for unit-testability (explicitly out of scope); the code fix is verified by a reproduction on an isolated Neon test branch. Two guarded, idempotent one-off scripts in `server/scripts/` reconcile proposal 54 after the fix deploys.

**Tech Stack:** Node 18 / Express, Neon PostgreSQL (`pg`, raw SQL), Stripe webhooks, `server/utils/invoiceHelpers.js`. Spec: `docs/superpowers/specs/2026-05-17-invoice-payment-proposal-rollup-design.md`.

**Neon project id:** `round-tooth-34649976` (database `neondb`). Production data lives on the default branch; all pre-deploy verification uses a throwaway child branch.

---

## File Structure

- **Modify** `server/routes/stripe.js` — add `'invoice'` branch + activity-log action + email payLabel (Task 1). Single responsibility unchanged (Stripe surface); no split (file already carries a `claude-allow-large-file` marker).
- **Create** `server/scripts/backfillProposal54DepositInvoice.js` — one-off, idempotent; synthesizes the missing paid Deposit invoice for proposal 54 (Task 2).
- **Create** `server/scripts/repairProposal54Balance.sql` — one-off, guarded; corrects `proposals` row 54 + audit log (Task 3).
- Task 4 is an operational runbook (no files) for the post-deploy production run.

---

## Task 1: Code fix — add the `invoice` branch to the webhook

**Files:**
- Modify: `server/routes/stripe.js` (the `payment_intent.succeeded` handler, ~lines 727–772 for the branch; ~lines 816–820 for the activity-log action; ~lines 651–653 for the email payLabel)

- [ ] **Step 1: Reproduce the bug on an isolated Neon test branch (the failing test)**

Create the throwaway branch:

Call `mcp__Neon__create_branch` with `{ "projectId": "round-tooth-34649976" }`. Note the returned `branchId` — pass it to every `mcp__Neon__run_sql` call below via the `branchId` argument.

Confirm the buggy starting state is present on the branch (copy of prod):

```sql
SELECT id, total_price, deposit_amount, amount_paid, status
FROM proposals WHERE id = 54;
```
Expected: `total_price 650.00, deposit_amount 100.00, amount_paid 100.00, status deposit_paid`.

Now run the EXACT SQL the OLD code path runs for an `'invoice'` payment (it falls into the `else` deposit branch — stripe.js:765-771):

```sql
UPDATE proposals
   SET status = 'deposit_paid', amount_paid = deposit_amount, payment_type = 'deposit'
 WHERE id = 54 AND status NOT IN ('deposit_paid','balance_paid','confirmed');
SELECT amount_paid, status FROM proposals WHERE id = 54;
```
Expected: `UPDATE 0` (zero rows — `status` is already `deposit_paid`), then `amount_paid 100.00, status deposit_paid`. **This reproduces the bug:** under the current code an invoice payment leaves the proposal untouched. Leave the branch open for Step 4.

- [ ] **Step 2: Apply the three code edits to `server/routes/stripe.js`**

**Edit A — add the `invoice` branch.** Locate the `else { // deposit` block inside `if (isFirstDelivery) {` (currently stripe.js:763-772):

```js
          } else {
            // deposit
            await dbClient.query(`
              UPDATE proposals
              SET status = 'deposit_paid',
                  amount_paid = deposit_amount,
                  payment_type = 'deposit'
              WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')
            `, [proposalId]);
          }
```

Insert a new `else if` immediately BEFORE that `else {` so the result is:

```js
          } else if (paymentType === 'invoice') {
            // Invoice payment (Balance / Additional Services / manual invoice paid
            // via the public invoice page). Roll the captured amount up into the
            // proposal and promote to balance_paid once fully paid. Increment —
            // never "set to total" — so partial invoice payments and Additional
            // Services (which push amount_paid ABOVE total_price) are correct.
            // Mirrors the drink_plan_extras branch. Idempotent: this whole block
            // is inside isFirstDelivery (gated by the proposal_payments ON CONFLICT
            // insert), so a Stripe retry never re-increments.
            const paidDollars = intent.amount / 100;
            const upd = await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $1
              WHERE id = $2
              RETURNING amount_paid, total_price
            `, [paidDollars, proposalId]);
            if (upd.rows[0] && Number(upd.rows[0].amount_paid) >= Number(upd.rows[0].total_price)) {
              await dbClient.query(
                "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed')",
                [proposalId]
              );
            }
          } else {
            // deposit
            await dbClient.query(`
              UPDATE proposals
              SET status = 'deposit_paid',
                  amount_paid = deposit_amount,
                  payment_type = 'deposit'
              WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')
            `, [proposalId]);
          }
```

**Edit B — activity-log action.** Locate the `action` ternary (currently stripe.js:816-820):

```js
          const action = paymentType === 'balance' ? 'balance_paid'
            : paymentType === 'full' ? 'paid_in_full'
            : paymentType === 'drink_plan_extras' ? 'drink_plan_extras_paid'
            : paymentType === 'drink_plan_with_balance' ? 'drink_plan_balance_paid'
            : 'deposit_paid';
```

Replace with (adds the `invoice` case before the `deposit_paid` default):

```js
          const action = paymentType === 'balance' ? 'balance_paid'
            : paymentType === 'full' ? 'paid_in_full'
            : paymentType === 'drink_plan_extras' ? 'drink_plan_extras_paid'
            : paymentType === 'drink_plan_with_balance' ? 'drink_plan_balance_paid'
            : paymentType === 'invoice' ? 'invoice_paid'
            : 'deposit_paid';
```

**Edit C — email payLabel.** Locate the `payLabel` line in `sendPaymentNotifications` (currently stripe.js:653):

```js
      const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : 'deposit';
```

Replace with:

```js
      const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : paymentType === 'invoice' ? 'invoice payment' : 'deposit';
```

- [ ] **Step 3: Re-run the reproduction on the Neon branch with the NEW branch SQL (the passing test)**

On the SAME open branch from Step 1 (`amount_paid` still `100.00`, status `deposit_paid`), run the SQL the NEW `invoice` branch runs for the $550 payment (`intent.amount` 55000 → `paidDollars` 550):

```sql
UPDATE proposals SET amount_paid = COALESCE(amount_paid,0) + 550
 WHERE id = 54 RETURNING amount_paid, total_price;
UPDATE proposals SET status = 'balance_paid'
 WHERE id = 54 AND status NOT IN ('confirmed','completed');
SELECT amount_paid, status FROM proposals WHERE id = 54;
```
Expected: first `UPDATE` returns `amount_paid 650.00, total_price 650.00`; second `UPDATE 1`; final SELECT `amount_paid 650.00, status balance_paid`. **Bug fixed.**

- [ ] **Step 4: Verify edge cases + idempotency on the branch, then delete it**

Partial-payment case (must NOT promote). Reset and apply a $200 partial:

```sql
UPDATE proposals SET amount_paid = 100.00, status = 'deposit_paid' WHERE id = 54;
UPDATE proposals SET amount_paid = COALESCE(amount_paid,0) + 200 WHERE id = 54 RETURNING amount_paid, total_price;
UPDATE proposals SET status = 'balance_paid' WHERE id = 54 AND status NOT IN ('confirmed','completed');
SELECT amount_paid, status FROM proposals WHERE id = 54;
```
Expected: `amount_paid 300.00`; second UPDATE still runs but the promote condition is evaluated in JS (`300 >= 650` is false) so in real code the status UPDATE would be SKIPPED — to mirror that, do NOT run the status UPDATE for this case; assert `status` stays `deposit_paid`. (The SQL above runs it unconditionally only to show it would set balance_paid if invoked — the JS guard `Number(amount_paid) >= Number(total_price)` is what prevents the call. Confirm by reading Edit A: the second query is inside `if (... >= ...)`.)

`confirmed`-guard case (must NOT regress status):

```sql
UPDATE proposals SET amount_paid = 100.00, status = 'confirmed' WHERE id = 54;
UPDATE proposals SET amount_paid = COALESCE(amount_paid,0) + 550 WHERE id = 54 RETURNING amount_paid;
UPDATE proposals SET status = 'balance_paid' WHERE id = 54 AND status NOT IN ('confirmed','completed');
SELECT amount_paid, status FROM proposals WHERE id = 54;
```
Expected: `amount_paid 650.00`, status stays `confirmed` (`UPDATE 0` on the status query — guard works).

Idempotency (unchanged code, but confirm the guard the branch relies on): the existing `proposal_payments` insert uses `ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING`. Confirm a duplicate succeeded intent is rejected:

```sql
INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
VALUES (54, 'pi_3TXo3wAZrfv5tWfN34hdR4EK', 'invoice', 55000, 'succeeded')
ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING
RETURNING id;
```
Expected: zero rows returned (intent `pi_3TXo3w…` already exists as succeeded payment #25) → in real code `isFirstDelivery` is false → the whole branch is skipped on retry. Idempotency confirmed.

Delete the branch: call `mcp__Neon__delete_branch` with `{ "projectId": "round-tooth-34649976", "branchId": "<branchId from Step 1>" }`.

- [ ] **Step 5: Documentation consistency check**

Per CLAUDE.md mandatory-docs: this modifies an existing route file (no new route/util/component/page/context, no schema/env/npm-script change), so the ARCHITECTURE route table and README tree are unaffected. Confirm no drift:

Run: `grep -n "payment_type" ARCHITECTURE.md` and skim the Stripe/webhook section.
Expected: no enumeration of individual `payment_type` values that now needs `invoice` added. If such a list exists, add `invoice` to it; otherwise no doc change. (`scripts/check-docs-drift.sh` runs in the pre-commit hook as the backstop.)

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripe.js
git commit -m "fix(stripe): roll invoice-type payments up into the proposal (amount_paid + status)"
```
(If Step 5 required a doc edit, add that path to the same `git add` and commit together.)

---

## Task 2: Backfill the missing Deposit invoice for proposal 54

**Files:**
- Create: `server/scripts/backfillProposal54DepositInvoice.js`

- [ ] **Step 1: Write the script**

Create `server/scripts/backfillProposal54DepositInvoice.js` with exactly this content:

```js
'use strict';

/**
 * One-off, idempotent backfill — proposal 54 (Ketan Patel).
 *
 * No Deposit invoice was ever created for this proposal (createInvoiceOnSend
 * never ran — Check Cherry cutover artifact). The $100 deposit (proposal_payments
 * #24, succeeded) is correctly reflected in proposals.amount_paid but has no
 * invoice row, so the admin invoice list shows only the Balance invoice.
 *
 * This synthesizes the Deposit invoice exactly as createInvoiceOnSend +
 * linkPaymentToInvoice would have, then backdates created_at/locked_at so it
 * sorts before INV-0009 in the admin list (ordered by created_at ASC).
 *
 * Re-run-safe: aborts if a Deposit invoice already exists for proposal 54.
 *
 *   node server/scripts/backfillProposal54DepositInvoice.js
 */

require('dotenv').config();
const { pool } = require('../db');
const {
  createInvoice,
  writeLineItems,
  generateLineItemsFromProposal,
  linkPaymentToInvoice,
} = require('../utils/invoiceHelpers');

const PROPOSAL_ID = 54;
const DEPOSIT_PAYMENT_ID = 24;          // proposal_payments.id for the $100 deposit
const EXPECTED_DEPOSIT_CENTS = 10000;   // $100.00
// 1s before INV-0009.created_at (2026-05-15T22:54:24.634Z) so Deposit sorts first.
const BACKDATE_CREATED_AT = '2026-05-15T22:54:23.000Z';
const BACKDATE_LOCKED_AT = '2026-05-15T22:54:24.634Z'; // deposit payment #24 time

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guard 1 — idempotency: a Deposit invoice must not already exist.
    const existing = await client.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Deposit' LIMIT 1",
      [PROPOSAL_ID]
    );
    if (existing.rows[0]) {
      console.log(`Deposit invoice already exists (id ${existing.rows[0].id}) — nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }

    // Guard 2 — verify the deposit payment is the shape we expect.
    const pay = await client.query(
      "SELECT id, amount, payment_type, status FROM proposal_payments WHERE id = $1 AND proposal_id = $2",
      [DEPOSIT_PAYMENT_ID, PROPOSAL_ID]
    );
    const p = pay.rows[0];
    if (!p || p.payment_type !== 'deposit' || p.status !== 'succeeded' || Number(p.amount) !== EXPECTED_DEPOSIT_CENTS) {
      throw new Error(`Deposit payment #${DEPOSIT_PAYMENT_ID} not in expected state: ${JSON.stringify(p)}`);
    }

    // Create the Deposit invoice (status 'sent'; linkPaymentToInvoice flips it
    // to 'paid' and locks it once the $100 payment is applied).
    const invoice = await createInvoice(
      { proposalId: PROPOSAL_ID, label: 'Deposit', amountDueCents: EXPECTED_DEPOSIT_CENTS, status: 'sent', dueDate: null },
      client
    );

    const lineItems = await generateLineItemsFromProposal(PROPOSAL_ID, client);
    await writeLineItems(invoice.id, lineItems, client);

    // Link the already-succeeded deposit payment → amount_paid 10000,
    // status 'paid', invoice locked (10000 >= 10000).
    await linkPaymentToInvoice(invoice.id, DEPOSIT_PAYMENT_ID, EXPECTED_DEPOSIT_CENTS, client);

    // Backdate so it orders before INV-0009 in the admin list.
    await client.query(
      'UPDATE invoices SET created_at = $1, locked_at = $2 WHERE id = $3',
      [BACKDATE_CREATED_AT, BACKDATE_LOCKED_AT, invoice.id]
    );

    const check = await client.query(
      "SELECT id, invoice_number, label, amount_due, amount_paid, status, locked, created_at FROM invoices WHERE id = $1",
      [invoice.id]
    );
    await client.query('COMMIT');
    console.log('Deposit invoice backfilled:', check.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); }
    console.error('Backfill failed (no changes committed):', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
```

- [ ] **Step 2: Verify the script on an isolated Neon test branch**

Create a fresh branch: `mcp__Neon__create_branch` `{ "projectId": "round-tooth-34649976" }` → note `branchId`.

Get the branch connection string: `mcp__Neon__get_connection_string` `{ "projectId": "round-tooth-34649976", "branchId": "<branchId>" }`.

Run the script against the branch (PowerShell):

```powershell
$env:DATABASE_URL="<branch connection string>"; node server/scripts/backfillProposal54DepositInvoice.js
```
Expected stdout: `Deposit invoice backfilled: { ... label: 'Deposit', amount_due: 10000, amount_paid: 10000, status: 'paid', locked: true, ... }`.

Verify ordering + ledger on the branch via `mcp__Neon__run_sql` (`branchId` set):

```sql
SELECT invoice_number, label, amount_due, amount_paid, status, locked, created_at
FROM invoices WHERE proposal_id = 54 ORDER BY created_at ASC;
```
Expected: TWO rows, `Deposit` first (created `…22:54:23Z`, 10000/10000, paid, locked) then `Balance` INV-0009 (created `…22:54:24.634Z`, 55000/55000, paid, locked).

Run the script a SECOND time (same `DATABASE_URL`):
Expected stdout: `Deposit invoice already exists (id …) — nothing to do.` (idempotency confirmed).

Delete the branch: `mcp__Neon__delete_branch` `{ "projectId": "round-tooth-34649976", "branchId": "<branchId>" }`.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/backfillProposal54DepositInvoice.js
git commit -m "chore(scripts): one-off backfill of missing Deposit invoice for proposal 54"
```

---

## Task 3: Balance-correction script for proposal 54

**Files:**
- Create: `server/scripts/repairProposal54Balance.sql`

- [ ] **Step 1: Write the SQL script**

Create `server/scripts/repairProposal54Balance.sql` with exactly this content:

```sql
-- One-off, guarded balance correction — proposal 54 (Ketan Patel).
--
-- Root cause: payment_type='invoice' had no webhook branch, so the $550 invoice
-- payment (pi_3TXo3wAZrfv5tWfN34hdR4EK, succeeded) marked INV-0009 paid but
-- never rolled up to the proposal. Combined with the $100 deposit
-- (pi_3TXUZxAZrfv5tWfN3zAHPFoo, succeeded) the client has paid $650 = full total.
--
-- RUN ONLY AFTER the Task 1 code fix is deployed to production.
-- Guarded WHERE makes this a strict no-op unless the exact buggy state is present;
-- safe to re-run.

BEGIN;

UPDATE proposals
   SET amount_paid = 650.00,
       status = 'balance_paid',
       autopay_status = NULL
 WHERE id = 54
   AND amount_paid = 100.00
   AND status = 'deposit_paid';

INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
SELECT 54, 'balance_correction', 'system',
       '{"reason":"invoice-payment roll-up bug (no invoice branch in payment_intent.succeeded); pi_3TXUZxAZrfv5tWfN3zAHPFoo ($100 deposit) + pi_3TXo3wAZrfv5tWfN34hdR4EK ($550 invoice) both succeeded = $650 full total","amount_paid_before":100.00,"amount_paid_after":650.00,"status_after":"balance_paid"}'::jsonb
WHERE EXISTS (
  SELECT 1 FROM proposals WHERE id = 54 AND amount_paid = 650.00 AND status = 'balance_paid'
)
AND NOT EXISTS (
  SELECT 1 FROM proposal_activity_log WHERE proposal_id = 54 AND action = 'balance_correction'
);

SELECT id, total_price, amount_paid, status, autopay_status FROM proposals WHERE id = 54;

COMMIT;
```

- [ ] **Step 2: Verify the SQL on an isolated Neon test branch**

Create a fresh branch: `mcp__Neon__create_branch` `{ "projectId": "round-tooth-34649976" }` → note `branchId`.

Pre-check (branch still has the buggy state):
```sql
SELECT amount_paid, status FROM proposals WHERE id = 54;
```
Expected: `100.00, deposit_paid`.

Execute the script body via `mcp__Neon__run_sql_transaction` (load it with `ToolSearch` query `select:mcp__Neon__run_sql_transaction` if not already available), passing each statement between `BEGIN` and `COMMIT` as an array, with `branchId` set. Expected final SELECT: `total_price 650.00, amount_paid 650.00, status balance_paid, autopay_status NULL`.

Idempotency: run the same statements again on the same branch.
Expected: the `UPDATE` matches 0 rows (guard `amount_paid = 100.00 AND status = 'deposit_paid'` no longer true), the activity-log `INSERT` matches 0 rows (`NOT EXISTS` guard), final SELECT unchanged at `650.00 / balance_paid`. Confirm exactly ONE `balance_correction` row:
```sql
SELECT count(*) FROM proposal_activity_log WHERE proposal_id = 54 AND action = 'balance_correction';
```
Expected: `1`.

Delete the branch: `mcp__Neon__delete_branch` `{ "projectId": "round-tooth-34649976", "branchId": "<branchId>" }`.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/repairProposal54Balance.sql
git commit -m "chore(scripts): guarded one-off balance correction for proposal 54"
```

---

## Task 4: Production reconciliation runbook (post-deploy — operator-gated)

No files. This task is the ordered production execution. **It is gated on the user pushing the Task 1 fix and Render finishing the deploy** — per the trunk-only workflow, pushing is user-initiated; do not push or run any production mutation autonomously.

- [ ] **Step 1: HARD GATE — confirm the code fix is live in production**

Do not proceed until the user confirms the Task 1 commit has been pushed to `main` and the Render deploy is complete. If not yet pushed, stop here and report that Tasks 1–3 are committed and awaiting the user's push.

- [ ] **Step 2: Pre-state snapshot (production / default branch)**

`mcp__Neon__run_sql` (NO `branchId` → default/production branch), project `round-tooth-34649976`:
```sql
SELECT id, total_price, deposit_amount, amount_paid, status, autopay_status FROM proposals WHERE id = 54;
SELECT invoice_number, label, amount_due, amount_paid, status, locked FROM invoices WHERE proposal_id = 54 ORDER BY created_at ASC;
```
Record the output. Expected pre-state: proposal `amount_paid 100.00, status deposit_paid`; one invoice (INV-0009 Balance).

- [ ] **Step 3: Run the Deposit-invoice backfill against production**

Obtain the production connection string: `mcp__Neon__get_connection_string` `{ "projectId": "round-tooth-34649976" }` (no branchId).

```powershell
$env:DATABASE_URL="<production connection string>"; node server/scripts/backfillProposal54DepositInvoice.js
```
Expected: `Deposit invoice backfilled: { ... status: 'paid', locked: true ... }`. If it prints `already exists`, that is an acceptable no-op — continue.

- [ ] **Step 4: Run the balance correction against production**

Execute `server/scripts/repairProposal54Balance.sql` against the production branch via `mcp__Neon__run_sql_transaction` (statements between `BEGIN`/`COMMIT`, no `branchId`).
Expected final SELECT: `amount_paid 650.00, status balance_paid, autopay_status NULL`.

- [ ] **Step 5: Post-state verification**

```sql
SELECT id, total_price, amount_paid, status FROM proposals WHERE id = 54;
SELECT invoice_number, label, amount_due, amount_paid, status, locked, created_at
  FROM invoices WHERE proposal_id = 54 ORDER BY created_at ASC;
SELECT action, created_at FROM proposal_activity_log
  WHERE proposal_id = 54 AND action = 'balance_correction';
```
Expected: proposal `amount_paid 650.00, status balance_paid`; TWO invoices (Deposit first, then Balance INV-0009), both `paid`/locked; exactly one `balance_correction` log row.

- [ ] **Step 6: Confirm in the app UI**

Ask the user to open proposal 54 (Ketan Patel) in the admin dashboard and confirm: balance shows paid in full, and both the Deposit and Balance invoices are listed. Report completion.

---

## Self-Review

**Spec coverage:**
- Root-cause code fix (spec §Deliverables 1) → Task 1 (Edits A/B/C: branch, action, payLabel). ✓
- Increment-not-set semantics, promote at `>= total_price`, never regress/confirm (spec §Deliverables 1) → Task 1 Edit A + Step 4 edge cases. ✓
- Money-type boundary `intent.amount/100` (spec §Money-type boundary) → Task 1 Edit A `paidDollars = intent.amount / 100`. ✓
- Idempotency via `isFirstDelivery` (spec §Deliverables 1) → Task 1 Step 4 ON CONFLICT check. ✓
- Deposit-invoice backfill, helper-based, backdated ordering, re-run-safe (spec §Deliverables 2a) → Task 2. ✓
- Guarded balance repair + audit log + `autopay_status=NULL` (spec §Deliverables 2b) → Task 3. ✓
- Sequencing code→deploy→2a→2b (spec §Sequencing) → Tasks ordered 1→2→3 (commit) then Task 4 (prod run, hard-gated on deploy). ✓
- Verification via Neon test branch + pre-push agents; no webhook refactor (spec §Verification, §Out of scope) → Task 1 Steps 1/3/4, Task 2 Step 2, Task 3 Step 2; no refactor task present. ✓
- Doc consistency (CLAUDE.md mandatory-docs) → Task 1 Step 5. ✓

No spec requirement is left without a task.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". The only `<…>` tokens are runtime values an operator must paste (`<branchId>`, `<branch connection string>`, `<production connection string>`) — each has an explicit command that produces it. No undefined functions: `createInvoice`, `writeLineItems`, `generateLineItemsFromProposal`, `linkPaymentToInvoice` are all exports of `server/utils/invoiceHelpers.js` (verified during investigation).

**Type consistency:** Cents vs dollars boundary held consistently — `intent.amount`/`amount_due`/`proposal_payments.amount`/`EXPECTED_DEPOSIT_CENTS` are integer cents; `paidDollars` and the `proposals.amount_paid` literals (`650.00`, `100.00`) are NUMERIC dollars. `linkPaymentToInvoice(invoiceId, paymentId, amountCents, dbClient)` call in Task 2 matches its signature in `invoiceHelpers.js`. Activity-log action `'invoice_paid'` (Task 1, going-forward) and `'balance_correction'` (Task 3, one-time repair) are intentionally distinct events — not an inconsistency.
