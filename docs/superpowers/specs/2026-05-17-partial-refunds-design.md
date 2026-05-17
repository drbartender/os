# Partial Refunds — Design

**Date:** 2026-05-17
**Status:** Approved (brainstorm), pending implementation plan
**Risk:** High — crosses schema → Stripe API → Stripe webhook → proposal financials → invoice reconciliation → admin UI. Real money moving *out*, against battle-tested working money paths.

## Problem

A bartender no-showed an event the client had already paid for. The client is owed back the cost of the second bartender. Today there is **no refund capability anywhere** — not in the API, not in the Stripe webhook. The only path is a hand-issued refund in the Stripe dashboard, which leaves the app's books (`total_price`, `amount_paid`, invoices) silently wrong and no in-app record of why.

We need admin-issued **partial refunds** that keep three audiences consistent:

- **Proposal-facing:** the corrected reality — a smaller total, still paid in full, no phantom balance.
- **Admin:** the history — what was refunded, how much, why, when, by whom, old total → new total.
- **Stripe / books:** the gross charge **and** the refund against it (unchanged — Stripe is already the system of record there).

## Core Decision: refund = total correction (Approach A)

A no-show means we **delivered less than contracted** (one bartender, not two). The refund is a correction to the agreed total, not a credit against an unchanged total. So a refund of `$Y`:

```
amount_paid  -= Y                     (always — every refunded dollar was paid)
total_price  -= contract_portion(Y)   (only the part that was contract money)
```

**`amount_paid` always drops by the full `Y`.** `total_price` drops only by the **contract portion** — the part of `Y` that was money *in* the contracted total. Contract vs. extra-scope is decided by the **linked invoice label** (the same markers `invoiceHelpers.js` already uses): a refund mapped to a `'Deposit'`/`'Balance'`/`'Full Payment'` invoice — or a direct deposit/balance/full charge with no invoice — is contract money → `total_price` drops too (Approach A proper, the no-show-bartender case). A refund mapped to any other invoice label ("Additional Services", etc.) is extra scope billed *on top* of `total_price` → `amount_paid` and that invoice drop, but `total_price` does **not** (lowering it would understate the base contract).

For the common/headline case (deposit + balance, no extras) every dollar is contract money, so both move together exactly as before: `balance_due = total_price − amount_paid` stays `$0` and the proposal correctly **still reads "paid in full"** at the corrected total. Nothing downstream that computes balance-due needs to learn about refunds — the whole point of choosing A. For an extra-scope refund, `amount_paid` falling to meet the unchanged `total_price` is *also* correct: it removes the add-on the client didn't keep without pretending the base contract shrank.

The original contracted figure is **not** preserved on the proposal. It is preserved in the audit table (below) and, permanently, in Stripe.

## Audit Trail: `proposal_refunds` table

A dedicated money ledger, sitting beside `proposal_payments` — **not** a notes field (rots, unqueryable, not tamper-evident).

```sql
CREATE TABLE IF NOT EXISTS proposal_refunds (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  payment_id INTEGER REFERENCES proposal_payments(id) ON DELETE RESTRICT,
  stripe_payment_intent_id VARCHAR(255),
  stripe_refund_id VARCHAR(255),
  amount INTEGER NOT NULL,                 -- CENTS (Stripe-native, like proposal_payments.amount)
  reason TEXT NOT NULL,
  total_price_before NUMERIC NOT NULL,     -- dollars, snapshot of proposals.total_price pre-refund
  total_price_after  NUMERIC NOT NULL,     -- dollars, post-refund
  issued_by INTEGER REFERENCES users(id),  -- the admin/manager who issued it
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_refunds_proposal_id ON proposal_refunds(proposal_id);
-- Idempotency anchor: one applied refund per Stripe refund id. The synchronous
-- route and the webhook backstop both key off this — second writer no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_refunds_stripe_refund_id
  ON proposal_refunds(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
```

`ON DELETE RESTRICT` (not CASCADE): a proposal with refund history cannot be hard-deleted out from under its money record — same protective posture as `invoices.proposal_id`.

## The Units Seam (the single most dangerous spot)

- `proposals.total_price`, `proposals.amount_paid` → **dollars** (NUMERIC).
- `proposal_payments.amount`, `proposal_refunds.amount`, `invoices.amount_*`, every Stripe amount → **integer cents**.

The admin types a **dollar** amount. **All refund math runs in integer cents.** The only dollar conversion is at the two `proposals` columns, at the very end, mirroring the existing webhook patterns (`intent.amount / 100`, `Math.round(x * 100)`). This seam will be called out in code comments and is the first thing the implementation plan's tests target. Money never touches a float mid-computation.

## Auto-Targeting the Source Charge

Admin enters **amount + reason only**. The server picks the charge:

1. Candidate set = `proposal_payments` rows for the proposal where `status='succeeded'`, `stripe_payment_intent_id IS NOT NULL`, **and** `payment_type IN ('deposit','balance','full','invoice')`. `invoice` is included because — post the invoice-rollup fix — paying the balance via the public invoice page is the **standard** balance path (it lands as `payment_type='invoice'` linked to a `'Balance'` invoice); excluding it would make the headline use case (refund the no-show bartender, whose cost is in the balance) impossible. Only `drink_plan_extras`/`drink_plan_with_balance` (separate extra-scope rails) and outside/cash payments (no intent) are excluded — see Non-Goals. Stripe's own per-charge refund cap is the final over-refund backstop on top of the `remaining` math.
2. For each candidate, `remaining = amount − COALESCE(SUM(proposal_refunds.amount WHERE payment_id = candidate.id AND status='succeeded'), 0)`.
3. Target = the candidate with the **largest `remaining`**. In practice this is always the balance or full-pay charge, never the $100 deposit — that is where the bartender money sits.
4. **No spanning.** If `amount_cents > target.remaining`, reject:
   > *"Largest refundable payment is $X.XX. Issue this as separate refunds of $X.XX or less."*

   The admin does two refunds. Spanning multiple charges in one action is where over-refund bugs live and the volume never needs it.

### Validation order (all cents, server-side, fail closed)

1. `amount` parses to a positive number.
2. Proposal exists.
3. Candidate set non-empty → else `"No Stripe payment on this proposal is available to refund."`
4. `amount_cents ≤ target.remaining` → else the no-spanning rejection above.
5. `amount_cents ≤ round(amount_paid * 100)` → defense-in-depth (we never refund more than we currently hold as paid).

The pure planner does **not** pre-check `total_price`. It cannot see the linked invoice label, so it cannot know how much of the refund is contract money — flooring on `total_price` here would wrongly reject a valid **extra-scope** refund (e.g. refunding a paid "Additional Services" invoice whose amount exceeds the base `total_price`). The authoritative 0-floor + the contract-vs-extra split is enforced once, downstream, in `applyRefundReconciliation`: `UPDATE proposals SET total_price = GREATEST(total_price − contractCents/100, 0)`, where `contractCents` is `0` for an extra-scope refund (so `total_price` is untouched) and `= amount` for a contract refund (where it can never exceed `total_price` anyway). `EXCEEDS_SINGLE_CHARGE`, `EXCEEDS_AMOUNT_PAID`, the SQL `GREATEST`, and Stripe's own per-charge refund cap together bound every case.

Eligibility gates on **refundable money, not proposal status** — a refund is valid whenever a real Stripe charge has room left, regardless of `status` (`balance_paid` / `confirmed` / `completed` are the expected post-event states, but the gate is the ledger, not the enum).

## Idempotency

- Client generates a random `idempotency_key` (uuid) when the refund modal **opens**, sends it in the POST body. Server forwards it as the Stripe refund idempotency key. A double-click within the same modal session → same key → Stripe returns the **same** refund object, not a second one. Re-opening the modal for a deliberate second refund → new key. (Mirrors how seriously the rest of this codebase treats Stripe idempotency.)
- The button disables for the in-flight request (existing `chargingBalance`-style pattern).
- `idx_proposal_refunds_stripe_refund_id` guarantees the financial reconciliation applies **once** per Stripe refund id, whichever writer (synchronous route or webhook backstop) gets there first.

## Server: `POST /api/stripe/refund/:id`

Lives in `server/routes/stripe.js` (admin-initiated Stripe action, same home as `charge-balance/:id`). Guarded by `auth, adminOnly` — **admin role only**, deliberately stricter than the money-*in* `charge-balance` (`requireAdminOrManager`), because a refund moves money *out*. The read-only history endpoint stays `requireAdminOrManager`. Body: `{ amount, reason, idempotency_key }`. Reconciliation serializes on the proposals row (`SELECT … FOR UPDATE` before the idempotency check) so concurrent submits cannot double-decrement. All rejections throw `AppError` (not `ValidationError`) so the precise message reaches the admin.

The reconciliation is non-trivial and is shared verbatim with the webhook backstop, so it is extracted into a new pure-ish helper **`server/utils/refundHelpers.js`** (mirrors `invoiceHelpers.js`): `applyRefundReconciliation({ proposalId, stripeRefundId, paymentIntentId, paymentId, amountCents, ... }, dbClient)` — idempotent on `stripe_refund_id`, runs inside a caller-supplied transaction.

Route flow:

1. Validate (order above). Resolve target charge.
2. Insert `proposal_refunds` row `status='pending'` (captures `total_price_before`, `issued_by`, reason, target ids) — **before** calling Stripe, so a Stripe success we then fail to record is still discoverable.
3. `stripe.refunds.create({ payment_intent, amount: amountCents }, { idempotencyKey })`. Stripe failure (e.g. charge already refunded in dashboard) → mark the row `failed`, surface Stripe's message via `PaymentError` / `ExternalServiceError`, **touch no proposal/invoice money**.
4. On Stripe success, in **one transaction**, call `applyRefundReconciliation(...)`:
   - Flip the `proposal_refunds` row → `succeeded`, set `stripe_refund_id`, `total_price_after`. (If `stripe_refund_id` already exists `succeeded` — webhook beat us — no-op and return.)
   - `UPDATE proposals SET total_price = total_price − $Y, amount_paid = amount_paid − $Y` (dollars; clamped ≥ 0).
   - **Linked invoice, if any:** for each `invoice_payments` row tied to `payment_id`, reduce that invoice's `amount_paid` **and** `amount_due` by the refunded cents (clamped ≥ 0), recompute `status` (`paid` → `partially_paid`, etc. — reuse the existing invoice-status recompute from `invoiceHelpers.js`, do not hand-roll). If the proposal was paid in full upfront with no invoice, nothing to do.
   - `INSERT proposal_activity_log (action='refund_issued', actor_type='admin', details={amount, reason, stripe_refund_id, total_price_before, total_price_after, issued_by})`.
5. `onUpdate` contract: respond with the new totals so the panel reloads.

## Stripe Webhook Backstop

New `charge.refunded` handler in the existing webhook (`server/routes/stripe.js`), same idempotency discipline as the payment handlers:

- Resolve `proposal_id` from the charge's payment intent metadata (already set on every intent we create).
- Open tx → call the **same** `applyRefundReconciliation(...)`. Correlation order, in-tx, by Stripe `refund.id`:
  1. A `succeeded` row already has this `stripe_refund_id` → **no-op** (synchronous route won the normal case).
  2. Else a `pending` row exists for this `stripe_payment_intent_id` with no `stripe_refund_id` and matching `amount` → **adopt it** (set `stripe_refund_id`, flip `succeeded`, reconcile). This is the self-heal: Stripe refunded but our synchronous post-Stripe DB write failed.
  3. Else **create** a fresh `succeeded` row and reconcile — an out-of-band dashboard refund (`issued_by` null, `reason` = `"Refunded via Stripe dashboard"`).
- Re-throw DB errors so Stripe retries (same posture as `payment_intent.succeeded`).
- Refunds issued **directly in the Stripe dashboard** (bypassing our API) also flow through here → books stay correct even for out-of-band refunds. `reason` defaults to `"Refunded via Stripe dashboard"`, `issued_by` null, when there's no pre-existing `pending` row.

## Client UI

`client/src/pages/admin/ProposalDetailPaymentPanel.js` — a new collapsible section, same pattern as "Record outside payment":

- Shows only when there is refundable money (`amountPaid > 0`; precise refundable comes from the server — the panel can gate on `amountPaid > 0` and let the server be the authority).
- Collapsed: `Issue refund` ghost button (`Icon name="dollar"` / `undo`).
- Expanded: amount input (`$`, `min 0.01`, `step 0.01`), reason textarea (**required**), Confirm / Cancel. Generates the `idempotency_key` on expand.
- On success: toast, collapse, `onUpdate?.()` (parent reloads → corrected Total/Paid/Balance render automatically).
- A **Refund history** read block in the panel: each `proposal_refunds` row — `−$Y · reason · date · "total $Z → $X"`. This is the admin-facing audit view.

API call through `client/src/utils/api.js` (`api.post('/stripe/refund/:id', { amount, reason, idempotency_key })`).

## Non-Goals & Assumptions

- **Stripe charges only.** Outside/cash/Venmo payments (`record-payment`, no `stripe_payment_intent_id`) are refunded outside the system, the mirror of how they were recorded. A "record outside refund" form is a future item, explicitly not built now (YAGNI; protect working money paths).
- **Drink-plan rails excluded.** `drink_plan_extras`/`drink_plan_with_balance` payments are not refundable through this tool (separate extra-scope rails with their own invoices/flow). `invoice`-type **is** refundable (it's the standard balance path post-rollup); extra-scope is handled correctly by the linked-invoice-label rule (above), not by excluding the payment type. Dashboard refunds of drink-plan charges are still recorded by the `charge.refunded` backstop (`issued_by` null); a dashboard refund of an unlinked charge defaults to contract treatment (rare; operator bypassed the app — documented caveat).
- **Purely financial. No staffing coupling.** Refund does not touch the no-show bartender's shift, `shift_requests`, or contractor pay. Admin works the bartender side with existing staffing tools. Decoupling money from scheduling matches the rest of the system and is the fragility-avoidance call.
- **No multi-charge spanning** in a single refund action (admin splits into separate refunds).
- **No new proposal `status` enum value** — A keeps the state machine untouched; a fully-refunded-down proposal is still `balance_paid`/`confirmed` at its corrected total.
- **No client-facing refund email** in v1. The admin communicates the refund to the client directly; Stripe already emails the cardholder a refund receipt. (Templated client email = future item if wanted.)
- Autopay scheduler, `balance_due_date`, the charge path, `pricingEngine.js`: untouched.

## Files Touched

| File | Change |
|---|---|
| `server/db/schema.sql` | **New** `proposal_refunds` table + indexes (idempotent). |
| `server/utils/refundHelpers.js` | **New.** `applyRefundReconciliation(...)` — idempotent shared reconciliation (proposal totals, invoice, activity log). |
| `server/routes/stripe.js` | **New** `POST /refund/:id` (admin); **new** `charge.refunded` webhook backstop. |
| `client/src/pages/admin/ProposalDetailPaymentPanel.js` | Issue-refund collapsible + refund-history block. |
| `ARCHITECTURE.md` | `proposal_refunds` in Database Schema; `/api/stripe/refund/:id` in route table; refund flow in Stripe integration section. |
| `README.md` | `refundHelpers.js` in folder tree; refunds in Key Features. |

## Testing Strategy

- **Units seam:** admin enters `$300.00` against a `$1,340.00` full charge → Stripe gets `30000` cents; `proposals.total_price`/`amount_paid` each drop by exactly `300` dollars; no float artifacts (e.g. `$300.00`, not `299.99999`).
- **Auto-target:** deposit `$100` + balance `$1,240` → refund targets the balance charge, never the deposit. Full-pay single charge → targets that. Two partial refunds against one charge → second sees reduced `remaining`.
- **No-spanning reject:** refund `> largest single remaining` → rejected with the exact max-amount message; no Stripe call made.
- **Approach A invariant:** after refund, `total_price − amount_paid == 0` and the panel still shows "Paid in full" at the corrected total; no phantom balance-due anywhere it's computed.
- **Invoice reconciliation:** balance charge linked to a `paid` invoice → after refund, invoice `amount_due` and `amount_paid` both drop by the refunded cents, status recomputed correctly; no linked invoice → clean no-op.
- **Idempotency:** double-click (same `idempotency_key`) → exactly one Stripe refund, one `proposal_refunds` row, totals dropped once. Webhook arrives after synchronous apply → no-op (unique `stripe_refund_id`). Synchronous DB write fails after Stripe success → webhook backstop reconciles (self-heal).
- **Out-of-band:** refund issued in Stripe dashboard → `charge.refunded` backstop creates the row + reconciles books with `issued_by` null.
- **Stripe failure:** charge already fully refunded → row `failed`, Stripe message surfaced, proposal/invoice money untouched.
- **Authz:** non-admin/manager → rejected by `requireAdminOrManager`.
