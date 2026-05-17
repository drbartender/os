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
- **Re-anchor by content, not line number.** Both plans describe anchors by content. After rollup commits, those refunds anchors are still valid by content. Line numbers in either plan are hints, not addresses.
- **`charge.refunded` insertion anchor is ambiguous — pin it.** `res.json({ received: true })` occurs **5 times** in `stripe.js` (lines 1024/1034/1054/1082 are tip-session early-returns; only **1174** is the handler's final statement). The refunds `charge.refunded` block must be inserted **immediately after the closing brace of the `if (event.type === 'checkout.session.completed') { … }` block and immediately before the single final `res.json({ received: true });`** — never anchored on the bare `res.json` string. Refunds Task 5's secondary anchor ("after the `checkout.session.completed` block") is the correct one; enforce it.

### 3. Shared assumptions — independently verified by both, consistent

- **`proposal_activity_log.action`/`actor_type` have no CHECK constraint.** Rollup relies on this for `'invoice_paid'`/`'balance_correction'`; refunds for `'refund_issued'`/`'admin'`. Both verified it separately; confirmed consistent. No new constraint is added by either — neither may add one.
- **Money boundary: `proposals.*` = NUMERIC dollars; everything else = integer cents.** Both plans encode the identical boundary (`intent.amount/100` in, `*100` out). No divergence.

### 4. 🚫 BLOCKING — refunds excludes `invoice` × rollup makes `invoice` the standard balance path

The two plans are each correct in isolation but combine into a functional hole that **breaks the headline use case** (refund a no-show bartender on a normally-booked event):

- Refunds hardening restricted auto-target to `payment_type IN ('deposit','balance','full')` — `invoice` deliberately excluded (rationale: Approach A lowers `total_price`, only valid for money *in* `total_price`).
- The rollup fix makes `payment_type='invoice'` the **normal, primary** way a balance is paid post-cutover. Verified against the rollup spec's production evidence: Ketan (proposal 54) paid the $550 **Balance** as `proposal_payments #25 payment_type='invoice'`, linked to INV-0009 `label='Balance'`.
- **Net:** for any post-cutover booking whose balance was paid via the invoice link (the standard path now), refunds would reject *"largest refundable payment is $100.00"* — the $100 deposit is the only candidate; the contracted balance is invisible to the refund tool. The exact scenario the feature was built for (refund the second bartender, whose cost is in the balance) becomes impossible to service in-app.

This is safe (it rejects, never mis-refunds — the layered guards hold) but functionally defeats the feature for standard bookings.

**Resolution (clean, idiomatic — `invoiceHelpers.js` already centers on these labels):** refund candidates = succeeded, intent-bearing payments of type `deposit`/`balance`/`full`/**`invoice`**; exclude only `drink_plan_extras`/`drink_plan_with_balance`. Whether Approach A also lowers `total_price` is decided by the **linked invoice label**, not `payment_type`: contract money (`label IN ('Deposit','Balance','Full Payment')`, or a direct deposit/balance/full charge with no invoice) → lower `total_price` + `amount_paid` (Approach A, as designed). Extra-scope invoice (any other label — Additional Services, etc.) → lower `amount_paid` + that invoice only, **not** `total_price`. `applyRefundReconciliation` already walks `invoice_payments`; this is one conditional in the loop it already has, using the same `label` markers `invoiceHelpers.js` uses at lines 315/398/421/692.

**Status: Wave 2 is BLOCKED until the refunds spec + plan are amended for this. Owner decision required (it reverts a defensive default + adds the label conditional) — see report.** Until resolved, this coordination plan is not executable past Wave 1.

### 5. Confirmed NON-conflicts

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
- **Commits — HARD RULE (already bit us once this session):** every commit in both waves uses `git commit -m "…" -- <exact paths>` (paths *after* the message+`--`), never `git add .`/`-A`, and is immediately verified with `git show --stat --oneline HEAD` to confirm ONLY the intended files landed. The working tree has unrelated parallel-window edits (`ClientDetail.js`, `Dashboard.js`, …) staged/modified — a non-path-scoped commit will sweep them in (it did earlier: `fe9b701`). Non-negotiable.
- **Wave 1 precondition — Neon MCP connectivity.** Before starting Wave 1, confirm the Neon MCP is authed and project `round-tooth-34649976` is reachable (`mcp__Neon__describe_project`). Rollup's entire verification (Tasks 1–3) is throwaway-branch based; if Neon is unreachable, Wave 1 cannot be verified — stop and report, do not proceed blind.
- **Refunds Task 5 needs a fresh dev server.** Wave 2 modifies `server/routes/stripe.js`; the Claude-managed dev server does not auto-reload server code (per project norm). Before the Task 5 Stripe test-mode integration smoke, restart it (kill the `:5000` PID, relaunch) or the smoke tests stale pre-refund code and silently "passes" against the wrong build.
- **Push:** user-initiated only. This session produces commits across both waves; the user batches/pushes (coordinating across parallel windows) and confirms the Render deploy before Wave 3.
- **Verification methods are per-plan and not interchangeable:** rollup → Neon throwaway branches; refunds → `node:test` for `planRefund` + lint/read-through + Stripe test-mode smoke. Preserve each.
- **`stripe.js` is the single serialization point.** If executed subagent-driven, the Wave 1 `stripe.js` task and the Wave 2 `stripe.js` tasks must not be dispatched concurrently; the coordinator gates Wave 2 start on Wave 1's `stripe.js` commit existing.

## What completes in this session vs. not

- **In-session (autonomous):** Wave 1 Tasks 1–3, Wave 2 Tasks 1–7 — all code, all Neon-branch / test-mode verification, all commits. End state: rollup fix + scripts committed; refunds feature committed; nothing pushed.
- **Post-session (operator-gated):** the user pushes; Render deploys; **then** Wave 3 (rollup Task 4 production reconciliation of proposal 54) runs against production Neon under the user's confirmation. The session will explicitly stop and report at this boundary, not silently attempt prod writes.

### Proposal 54 caution (pre-Wave-3 window)

Until Wave 3 reconciles it, proposal 54 carries the buggy state (`amount_paid=100.00`, true paid `$650`). Issuing a refund against it in that window is **safe but wrong-feeling**: the layered guards (`amount_paid` cap, per-charge cap, `invoice` handling) make it reject rather than mis-pay, but the operator must not attempt a Ketan refund until Wave 3 is done. Documented operator caution; no code guard needed (the guards already fail safe).

### Operational decision — push cadence (raise with user)

Wave 1 fixes a **live production money-display bug on a real customer** (Ketan sees the wrong balance right now). Wave 2 is a net-new feature. These do not have to share a push:

- **Option A (recommended):** push Wave 1 alone, urgently → Render deploys → run Wave 3 to reconcile Ketan ASAP → ship Wave 2 (refunds) on its own later cadence. Decouples an urgent prod fix from a new feature's risk; Ketan is correct soonest.
- **Option B:** batch Wave 1 + Wave 2 in one push; Wave 3 after that single deploy.

Either is valid; the user owns push timing across parallel windows. Recommend A on protect-working-paths + customer-impact grounds.

## Execution Handoff

Subagent-driven (superpowers:subagent-driven-development), this session coordinating: dispatch one task at a time from the relevant underlying plan, two-stage review between tasks, Wave 2 gated on Wave 1's `stripe.js` commit, full stop at the Wave 3 deploy gate.
