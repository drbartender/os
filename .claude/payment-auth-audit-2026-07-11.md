# Payment + Auth Audit — 2026-07-11 (reconstructed 2026-07-13)

> **Provenance note:** this audit ran on 2026-07-11 but its report was never persisted to the repo;
> this file is a RECONSTRUCTION written 2026-07-13 from the session-memory summary plus a
> code-verification pass (the 2026-07-13 whole-codebase audit's reconciler re-verified each finding
> against HEAD with file:line evidence). The audit's **three low/info findings are LOST** — they
> existed only in the original session and could not be recovered. Everything below is what survives.

## Headline conclusion

The payment flow is **HARDENED**. The audit explicitly recommended **AGAINST rewriting it**:
idempotency is designed-in at every money-in path (partial unique indexes, ON CONFLICT gates),
credits are additive with derived status (never `amount_paid = total_price`), the webhook dispatcher
gates live-mode on which secret verified the event, and refund reconciliation is row-locked and
keyed on `stripe_refund_id`. Refactors of these paths cost more risk than they remove. This
conclusion is load-bearing for later work: see `docs/audit-2026-07-13/tech-debt-register.md` §5
(rejected fixes) which cites it repeatedly.

## The three medium findings (verified evidence + disposition)

### 1. Autopay balance charge can double-charge after a >24h webhook outage — **FIXED 2026-07-13**

Evidence at time of re-verification: `server/utils/balanceScheduler.js:43-47` reclaimed a stuck
`in_progress` row after a TTL, while the ONLY charge dedup was the Stripe idempotency key
(`autopay-balance-<id>-<dueDate>`, :76) — and Stripe idempotency keys expire after 24h. A charge
that succeeded at Stripe with the webhook down for >24h would be re-charged on reclaim.

Fixed by lane `audit-a-autopay` (72h TTL + durable `stripe_sessions` charge record +
`priorBalanceChargeSettling` Stripe-truth pre-check) plus, same day, the guard-selection rework in
lane `autopay-guard-fix` after the push-time cross-LLM review found three holes in the guard's
prior-intent selection (amount-scoped / newest-only / status-blind). **Open residual** (tracked in
`migration-plan.yaml` → `m4-autopay-outage-guard.follow_up`, in flight as lane `p1-guard-coverage`):
`drink_plan_with_balance` intents settle the balance but were invisible to the guard's
`payment_type === 'balance'` check.

### 2. Drink-plan submit raises total_price but never reconciles payment status — **FIXED 2026-07-13**

Evidence: `server/routes/drinkPlans/submit.js:264` updated `proposals.total_price` +
`pricing_snapshot` with no status write anywhere in the file; a paid proposal gaining extras kept
its paid status (violates the CLAUDE.md price-change → re-evaluate rule). Reachability was low
(the submit-once gate at :89 rejects `submitted`/`reviewed`; re-entry required an admin reset).

Fixed by lane `audit-b-drinkplan`: `reconcileProposalPaymentStatus` on the same transaction client,
demote-only semantics preserving the confirmed-not-demoted-on-overpaid rule, plus the
`createAdditionalInvoiceIfNeeded` absorbing-invoice guard in `invoiceLifecycle.js`.

### 3. Unauthenticated `/api/qa/seed` mints staff accounts — **FIX IN FLIGHT 2026-07-13**

Evidence: `server/routes/labrat.js:55` — `POST /seed` has no auth middleware and no env gate,
mounted live in prod; `server/utils/qaSeed.js` `recipePreHireInvitation` INSERTs a `users` row with
`role='staff'` (`onboarding_status='applied'`, pre-claim) and returns the plaintext password. Only
defense: rate limits (2/IP/hr + 20/hr global). Bounded risk (pre-claim accounts, capped volume) but
genuinely open.

Fix (lane `p1-seed-gate`): prod-closed `LABRAT_SEED_ENABLED` gate returning 404, dev unchanged;
prod verified to have zero labrat usage ever, so the closed default breaks nobody.

## The lost tail

The audit also produced **three low/info findings**. No file, commit, or doc records them; they are
gone. If one resurfaces organically, add it to the rolling register rather than here.

## Pointers

- Living tracker: `docs/audit-2026-07-13/migration-plan.yaml` + `tech-debt-register.md`
- Implementation plan the fixes shipped under: `docs/superpowers/plans/2026-07-13-payment-auth-audit-fixes.md`
- Related standing doc: `.claude/seam-sweep-2026-07-02.md` (read before touching payroll/webhook/invoice)
