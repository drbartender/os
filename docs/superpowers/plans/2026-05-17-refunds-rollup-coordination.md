# Refunds + Invoice-Rollup — Combined Execution Plan (this session)

> **For agentic workers:** This is a COORDINATION plan over two existing task-by-task plans. Execute via superpowers:subagent-driven-development. This session is the coordinator: it enforces wave order, the `stripe.js` serialization rule, and the deploy gate. It does NOT replace the two underlying plans — each task is executed from its own plan file.

**Goal:** Land both money changes in this session, correctly ordered, without the two `server/routes/stripe.js` edit sets colliding and without refunds operating on financially-stale proposals.

**The two underlying plans (authoritative — execute their steps verbatim):**
- **Rollup:** `docs/superpowers/plans/2026-05-17-invoice-payment-proposal-rollup.md` (spec: `…/specs/2026-05-17-invoice-payment-proposal-rollup-design.md`) — adds the missing `payment_type='invoice'` branch to the `payment_intent.succeeded` webhook + two guarded one-off scripts to reconcile proposal 54 (Ketan Patel).
- **Refunds:** `docs/superpowers/plans/2026-05-17-partial-refunds.md` (spec: `…/specs/2026-05-17-partial-refunds-design.md`) — admin partial refunds: `proposal_refunds` ledger, pure `planRefund`, idempotent `applyRefundReconciliation`, `POST/GET /stripe/refund(s)/:id`, `charge.refunded` backstop, admin UI.

---

## Dependency & Conflict Analysis

### 1. Logical dependency — rollup FIRST (load-bearing)

Refund reconciliation (`applyRefundReconciliation`) does `proposals.amount_paid −= Y` and `total_price −= Y`, trusting `amount_paid` reflects money actually collected. The rollup bug means **every `payment_type='invoice'` payment marks the invoice paid but never rolls up to `proposals.amount_paid`** (proposal 54: `amount_paid` stuck at `100.00` though `$650` was paid). Issuing a refund against such a proposal computes off a stale base → wrong totals, wrong "balance due."

→ **Rollup code fix must be implemented before refunds is exercised.** Not a style preference — a money-correctness ordering constraint.

### 2. File-level — `server/routes/stripe.js`, disjoint regions, MUST serialize

| Plan | Regions edited in `stripe.js` |
|---|---|
| Rollup | `sendPaymentNotifications` payLabel (~653); new `else if (paymentType==='invoice')` before the final `else {//deposit}` (~763–772); `action` ternary (~816–820) — all inside `payment_intent.succeeded` |
| Refunds | import line (~6, add `adminOnly`); new `GET/POST /stripe/refund(s)/:id` after the `charge-balance/:id` handler (~538); new `if (event.type==='charge.refunded')` before the final `res.json({received:true})` (~1174) |

The regions do not overlap, so there is **no textual merge conflict** — but line numbers shift as edits land. Rules:

- **Serialize.** Apply and commit rollup's `stripe.js` edits, *then* refunds'. Never two subagents editing `stripe.js` at once.
- **Re-anchor by content, not line number.** Both plans already describe anchors by content ("the `else { // deposit` block", "after the `charge-balance/:id` route", "before the final `res.json({ received: true })`"). After rollup commits, those refunds anchors are still valid by content. The line numbers in either plan are hints, not addresses.

### 3. Shared assumptions — independently verified by both, consistent

- **`proposal_activity_log.action`/`actor_type` have no CHECK constraint.** Rollup relies on this for `'invoice_paid'`/`'balance_correction'`; refunds for `'refund_issued'`/`'admin'`. Both verified it separately; confirmed consistent. No new constraint is added by either — neither may add one.
- **Money boundary: `proposals.*` = NUMERIC dollars; everything else = integer cents.** Both plans encode the identical boundary (`intent.amount/100` in, `*100` out). No divergence.

### 4. Confirmed NON-conflicts

- Refunds auto-target excludes `payment_type IN ('invoice','drink_plan_*')` — a refund can never target the very payment type the rollup fix repairs; the two never act on the same `proposal_payments` row.
- Refunds' `charge.refunded` handler is an independent top-level `event.type` branch — it does not touch `payment_intent.succeeded` where the rollup `invoice` branch lives.
- Rollup's production data scripts (proposal 54) write only `invoices`/`invoice_payments`/`proposals`/`proposal_activity_log` for one proposal; refunds adds a new table and never runs a backfill. No shared mutation.

---

## Wave Order

### Wave 1 — Rollup code fix + scripts (prerequisite; fixes a live prod bug)

Execute **Rollup plan Tasks 1, 2, 3** in order:
- Task 1 — `invoice` branch + `action` case + payLabel in `stripe.js`; verified on a throwaway Neon branch (project `round-tooth-34649976`), idempotency + edge cases asserted, branch deleted; commit.
- Task 2 — `backfillProposal54DepositInvoice.js`; verified on a fresh Neon branch; commit.
- Task 3 — `repairProposal54Balance.sql`; verified on a fresh Neon branch; commit.

Rollup **Task 4 is NOT in Wave 1** — it is Wave 3 (deploy-gated, see below).

Rationale: smallest, lowest-risk change (near-verbatim copy of a proven branch), fixes a real production money-display bug, and is the correctness precondition for Wave 2. Its `stripe.js` edits land and commit first so refunds re-anchors against a stable file.

### Wave 2 — Partial refunds (the new feature)

Execute **Refunds plan Tasks 1–7** in order (schema → pure `planRefund` TDD → `applyRefundReconciliation` → route → `charge.refunded` backstop → admin UI → docs). All of refunds' `stripe.js` edits are applied here, **after** Wave 1's `stripe.js` commit, anchored by content. Refunds Task 5's integration smoke uses Stripe **test mode** + the Claude-managed dev server (its own verification path — do not substitute Neon branches).

### Wave 3 — Production reconciliation of proposal 54 (operator/deploy-gated, NOT autonomous)

Execute **Rollup plan Task 4** — the production runbook (live Neon writes to Ketan's proposal 54).

**Hard gate (per CLAUDE.md trunk-only + Rollup Task 4 Step 1):** this runs only *after the user has pushed the Wave 1 fix to `main` and Render has finished deploying*. Pushing is user-initiated; production data mutation is never autonomous. This session **stops at the Wave 3 gate** and hands back. Wave 3 is included for completeness of "execute both," but it is explicitly out of this session's autonomous scope — it is a post-push operator step.

---

## Cross-Wave Guardrails

- **No pre-running review agents.** Per CLAUDE.md Rule 6 / Pre-Push 0.5, the mandatory 5-agent fleet runs exactly once, gated by the user's push confirmation — not per wave, not at feature completion. Both waves touch money + webhook, so that review WILL run at push time; this session does not trigger it early.
- **Commits:** use each underlying plan's own commit steps and messages, path-scoped (`git add <exact paths>`, `git commit -m "…" -- <paths>`). Never `git add .`/`-A`. Multiple unrelated staged files in the index earlier this session is exactly why path-scoping is mandatory here.
- **Push:** user-initiated only. This session produces commits across both waves; the user batches/pushes (coordinating across parallel windows) and confirms the Render deploy before Wave 3.
- **Verification methods are per-plan and not interchangeable:** rollup → Neon throwaway branches; refunds → `node:test` for `planRefund` + lint/read-through + Stripe test-mode smoke. Preserve each.
- **`stripe.js` is the single serialization point.** If executed subagent-driven, the Wave 1 `stripe.js` task and the Wave 2 `stripe.js` tasks must not be dispatched concurrently; the coordinator gates Wave 2 start on Wave 1's `stripe.js` commit existing.

## What completes in this session vs. not

- **In-session (autonomous):** Wave 1 Tasks 1–3, Wave 2 Tasks 1–7 — all code, all Neon-branch / test-mode verification, all commits. End state: rollup fix + scripts committed; refunds feature committed; nothing pushed.
- **Post-session (operator-gated):** the user pushes; Render deploys; **then** Wave 3 (rollup Task 4 production reconciliation of proposal 54) runs against production Neon under the user's confirmation. The session will explicitly stop and report at this boundary, not silently attempt prod writes.

## Execution Handoff

Subagent-driven (superpowers:subagent-driven-development), this session coordinating: dispatch one task at a time from the relevant underlying plan, two-stage review between tasks, Wave 2 gated on Wave 1's `stripe.js` commit, full stop at the Wave 3 deploy gate.
