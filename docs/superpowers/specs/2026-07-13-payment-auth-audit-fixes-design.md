# Payment + Auth Audit Fixes — Design

Date: 2026-07-13
Status: approved (brainstorm), pending implementation plan
Provenance: 2026-07-11 adversarial payment/auth audit (`project-payment-auth-audit-2026-07-11`)

## Context

The 2026-07-11 audit found the live payment/auth flow already hardened; classic bypass/double-charge/IDOR are closed. It surfaced seven residual items. One (F4, the missing `livemode` guard on Stripe settlement handlers) was **already fixed** on 2026-07-13 (commit `46e969b`, dispatch-level guard at `stripeWebhook.js:73`). This spec covers the **six remaining**, re-verified as still present against current `main` on 2026-07-13.

The guiding principle is the one from the audit: **protect the working money paths.** No rewrite. Each fix is surgical, mirrors an existing proven pattern where one exists, and stays out of the battle-tested webhook credit math.

## Goals

- Close the six remaining findings with minimal, well-bounded changes.
- Reuse existing proven patterns (e.g. the admin re-price reconcile path) rather than invent new ones.
- Keep every change idempotent under Stripe webhook redelivery and compliant with the one-connection-per-request rule.

## Non-goals

- No rewrite of the payment engine, webhook credit path, or clawback math.
- No full Lab Rat program removal (that is a separate cleanup Dallas drives; F3 only closes the prod exposure in the interim).
- No auto re-pay of bartenders on a won dispute (that remains the manual Phase-2 admin adjustment; F5 fixes only the ledger counter).

## Findings and fixes

### F1 — Autopay double-charge on a >24h webhook outage (money)

**Problem.** `balanceScheduler.js:46` re-opens a stuck `autopay_status='in_progress'` claim after 24h (`autopay_attempted_at < NOW() - INTERVAL '24 hours'`). Stripe idempotency keys also expire at 24h. If the `payment_intent.succeeded` webhook is undelivered for >24h (a webhook-handler outage while the claim UPDATE still works), the hour-25 re-claim re-fires with an expired key → Stripe creates a **second distinct** off-session charge → the card is charged twice, and both webhooks credit additively (the balance branch admits `status='balance_paid'` uncapped, `paymentIntentSucceeded.js:120`). The naive "check if already paid before re-charging" does not work: the webhook that records the payment is the thing that is down, so the DB shows the balance unpaid at re-claim time.

**Fix — durable charge record (approach: robust).**
- At off-session charge time, in **both** the scheduler (`balanceScheduler.js`) and the manual `charge-balance` endpoint (`routes/stripe.js`), immediately persist the created balance PaymentIntent into `stripe_sessions` (proposal_id, stripe_payment_intent_id, amount, status) — the same durable record `create-intent` already writes, independent of the webhook. Use `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`.
- On the **stale-TTL re-claim path only**, before creating a new intent, look up the most recent balance `stripe_sessions` row for this proposal + `balance_due_date` and retrieve that intent from Stripe. If its status is `succeeded` or `processing`, **skip the re-charge** (leave the claim for the webhook / a follow-up reconcile; the existing failure-alert path already notifies admin on a genuinely dead card). Only re-charge when the prior intent is `canceled`/`requires_payment_method`/absent.
- Secondary belt: bump the stale-claim TTL from 24h to **72h** so the key cannot expire before the webhook has every chance to land.

**Guardrails.** No change to the webhook credit math. The `stripe_sessions` write and the Stripe retrieve/skip are the only new logic. Keep the shared idempotency key `autopay-balance-<id>-<dueIso>` (it still helps within the 24h window). No `autopay_status` enum change (the durable record lives in `stripe_sessions`).

**Files.** `server/utils/balanceScheduler.js`, `server/routes/stripe.js`.

**Test.** Simulate: charge succeeds, webhook never lands, TTL elapses, re-claim finds the prior succeeded intent → asserts no second `paymentIntents.create` and no second credit.

### F2 — Drink-plan submit re-prices without reconciling (money)

**Problem.** `drinkPlans/submit.js:263-266` raises `proposals.total_price` (bar rental or chargeable add-on) but never calls `reconcileProposalPaymentStatus` or `createAdditionalInvoiceIfNeeded`. A fully-paid proposal stays `balance_paid` / "Paid in Full" while now owing, and in the add-to-balance branch `refreshUnlockedInvoices` no-ops on the paid+locked Balance invoice, so the delta is billed nowhere. Violates the CLAUDE.md "never marked paid when it isn't" invariant. Client-token-triggerable.

**Fix — mirror the admin re-price path (`crud.js:568` + `crud.js:704`).**
- Capture `oldTotalCents` before the `total_price` UPDATE.
- After the UPDATE, call `reconcileProposalPaymentStatus({ status, amountPaid, totalPrice: snapshot.total })`; if `rec.changed`, UPDATE `status` (and clear autopay per `rec`) inside the same transaction/connection.
- In the add-to-balance branch, call `createAdditionalInvoiceIfNeeded(proposal.id, oldTotalCents, client)` so a fully-paid proposal's extras delta lands on a real "Additional Services" invoice. (Pay-separately already mints an extras invoice; still reconcile status.)

**Guardrails.** Reuse the exact helpers `crud.js` uses. Everything runs on the existing transaction's `client` (one-connection rule) before COMMIT.

**Files.** `server/routes/drinkPlans/submit.js` (add imports from `proposalStatus` + `invoiceHelpers`).

**Test.** Paid-in-full proposal + drink-plan submit with a chargeable extra, add-to-balance → asserts status demoted off `balance_paid` and an Additional Services invoice created for the delta.

### F3 — Unauthenticated `/api/qa/seed` in production (auth)

**Problem.** `index.js:265` mounts `/api/qa` with no environment/secret gate; `labrat.js:55` seeds a real, loginable `role=staff` account that self-escalates to `approved` (login → claim-pre-hire → payment-profile submit). Bounded and no direct money path, but a genuine unauth→approved-staff foothold in prod.

**Fix.** Gate the `/api/qa` mount to `NODE_ENV !== 'production'`. The endpoint stops existing in prod immediately; dev keeps working until the full Lab Rat teardown (separate effort) deletes the code, which absorbs this gate with no conflict.

**Files.** `server/index.js`.

**Test.** Assert the route is unmounted (404) when `NODE_ENV='production'`.

### F5 — Dispute-won reinstatement doesn't rewind the tip clawback counter (money)

**Problem.** On `charge.dispute.funds_reinstated`, `handleDisputeFundsReinstated` (`disputes.js:14`) only sends the admin email via `notifyDisputeWon`; it never lowers `tips.refunded_amount_cents`, which was advanced to the disputed amount when funds were withdrawn. A *later* genuine refund on that same tip then computes `delta=0` in `clawbackTip` (`payrollClawback.js:37`) and silently under-claws. `clawbackTip` only moves the counter **forward**, so it cannot be reused for the rewind.

**Fix — targeted, idempotent rewind on reinstate.**
- Add an idempotency marker column `tips.dispute_reinstated_at` (`ADD COLUMN IF NOT EXISTS`).
- In `handleDisputeFundsReinstated` (or a new `payrollClawback` helper it calls), run one atomic UPDATE: `refunded_amount_cents = GREATEST(refunded_amount_cents - LEAST(<reinstatedCents>, refunded_amount_cents), 0)`, `dispute_reinstated_at = NOW()`, gated `WHERE stripe_payment_intent_id = $pi AND dispute_reinstated_at IS NULL`. Redelivery no-ops (marker already set).
- This is **decoupled from `notifyDisputeWon`**: the ledger correction must not depend on admin-email delivery/retry. Both run in the reinstate handler; the counter rewind is not gated on `dispute_won_at`.

**Scope note (known interaction).** The rewind only restores the counter so a *future* genuine refund re-claws correctly. It does NOT auto re-pay the bartender for the original withdrawal clawback — that stays the manual Phase-2 adjustment. Edge: if admin never manually re-pays AND a genuine refund later fires, the bartender is net clawed for both; that is the existing manual-process responsibility, not introduced by this fix. Documented, not auto-handled.

**Files.** `server/routes/stripeWebhookHandlers/disputes.js`, `server/utils/payrollClawback.js` (new rewind helper), `server/db/schema.sql` (marker column).

**Test.** withdraw (counter→amount) → reinstate (counter→0, marker set) → redeliver reinstate (no-op) → genuine refund (re-claws correctly). One-at-a-time per shared-DB constraint.

### F6 — OTP verify enumeration oracle (auth, info)

**Problem.** `clientAuth.js:107` throws `409 ConflictError` code `RATE_LIMITED` on the attempt-ceiling branch, distinguishable from the `400 ValidationError` returned for unknown emails — a client-membership oracle.

**Fix.** On the attempt-ceiling branch, still invalidate the OTP server-side, but return the neutral `400 ValidationError({ otp: 'This code is invalid or has expired' })` used for the wrong/unknown/expired cases, so `/verify` responses are indistinguishable across existing vs non-existing emails.

**Files.** `server/routes/clientAuth.js`.

**Test.** Assert identical status/code for real-client-ceiling vs unknown-email probes.

### F7 — No `UNIQUE(invoice_id, payment_id)` on `invoice_payments` (data, latent)

**Problem.** Only single-column indexes exist; a bug could double-link one payment to one invoice. Not currently reachable (audit), so this is defense-in-depth.

**Fix.** Add `UNIQUE(invoice_id, payment_id)` to `invoice_payments`. **Prerequisite:** run a prod dedupe check first — a `UNIQUE` on existing data fails if any duplicate pair exists. If prod is clean it applies directly; if not, the plan includes a one-time cleanup (collapse duplicate links, preserving summed amounts) before adding the constraint.

**Note.** Negative refund-reversal rows share `(invoice_id, payment_id)` with their positive link by design (they carry a `refund_id`). Confirm during the dedupe check whether the constraint must be scoped (e.g. `WHERE refund_id IS NULL`) so it does not collide with reversal rows. **This is a gating question for the plan** — resolve before writing the migration.

**Files.** `server/db/schema.sql`, plus a dedupe/verification script if prod data is not clean.

## Lane map

Five focused lanes; A–D touch disjoint files and can build in parallel. Each money/auth lane runs the full review fleet + `/second-opinion` at push (sensitive paths).

| Lane | Findings | Primary files | Risk |
|---|---|---|---|
| A — autopay durability | F1 | `utils/balanceScheduler.js`, `routes/stripe.js` | money |
| B — drink-plan reconcile | F2 | `routes/drinkPlans/submit.js` | money |
| C — dispute ledger rewind | F5 | `stripeWebhookHandlers/disputes.js`, `utils/payrollClawback.js`, `db/schema.sql` | money |
| D — auth hardening | F3, F6 | `index.js`, `routes/clientAuth.js` | auth |
| E — schema constraint | F7 | `db/schema.sql`, dedupe script | data |

Sequencing note: C and E both touch `schema.sql`; serialize their merges (the merge lock handles this) or land E's column-add within C to avoid a textual conflict. The plan decides.

## Cross-cutting guardrails

- **One-connection-per-request** (2026-07-13 rule): F1, F2, and F5 add work near transaction boundaries — every query routes through the handler's single `client`; release before any post-COMMIT helper that takes its own pooled connection.
- **Idempotency**: F1's durable record (`ON CONFLICT`) and F5's rewind (marker-gated) must be no-ops on Stripe redelivery.
- **Do not touch the webhook credit path** for F1 — the fix lives entirely in the scheduler + manual charge.
- **F7 must not apply blind** — prod dedupe + reversal-row scoping resolved first.

## Testing and rollout

- Each fix gets a targeted `node:test`, run one-at-a-time (shared dev DB, `node -r dotenv/config`).
- Money/auth lanes: full review fleet + cross-LLM `/second-opinion` at push, per the workflow.
- Push is Dallas's explicit call; no auto-push.

## Open questions for the plan

1. F7: does the `UNIQUE` need `WHERE refund_id IS NULL` scoping to coexist with negative reversal rows? (Resolve before the migration.)
2. F1: confirm `stripe_sessions` is the right durable table for autopay intents (it already carries the shape and the webhook already flips its status to `succeeded`).
