# Dispute-won email: retry bailout

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (post review-fold), ready for implementation plan
**Source finding:** L2 from the 2026-05-25 session-review pass (commit `49e8cfd` opened this when it gated `dispute_won_at` on email success). Spec also folds in findings from the 2026-05-25 design-fleet review pass (2 blockers, 7 warnings, 5 suggestions).

## Problem

`server/utils/payrollDisputeNotify.js` sends an admin email when Stripe reinstates funds on a previously-paid-out card tip, then marks `tips.dispute_won_at = NOW()` so the webhook handler never re-processes the same dispute. After commit `49e8cfd`, the mark is gated on email success: a Resend failure or an unset `ADMIN_EMAIL` leaves `dispute_won_at` null.

Stripe redelivers `charge.dispute.funds_reinstated` for up to 3 days, roughly 60 attempts with exponential backoff. Each redelivery re-runs `notifyDisputeWon`, re-fetches the tip and shift rows, re-computes per-bartender shares, and re-captures the failure to Sentry. The result is a self-DoS: a stuck env burns Sentry quota for days and never recovers without manual intervention.

## Goal

Cap the retry storm at 3 attempts. After the third failure, stop processing, leave a durable record that the notification was abandoned, and surface the abandonment loudly so an admin can react. Make every state transition atomic so two concurrent webhook deliveries cannot duplicate emails or leave the row stuck.

## Non-goals

* No SMS fallback. The `feedback_notification_cost` rule favors email over SMS; the admin reads Sentry instead.
* No admin-dashboard surface for stuck disputes. Sentry's existing alerting is the channel.
* No auto-resend if `ADMIN_EMAIL` gets set later. Once the bailout fires, that specific dispute notification is permanently abandoned by design.

**Manual recovery runbook** (for the admin reading the Sentry alert): the bailout's `captureMessage` payload carries `tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, and the event date label. To reconcile manually, the admin computes per-bartender shares from those fields (or queries `tips` directly by `tipId`) and adds positive adjustments on each bartender's next open payout via the existing admin payroll UI. No automated path exists.

## Schema

Add two columns to `tips`:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

**State machine** (documented in ARCHITECTURE.md alongside the columns):
* **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`. Webhook has not delivered or the first attempt has not run.
* **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`. One or more send failures, still inside the retry window.
* **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`. Email was delivered, admin saw it.
* **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. Three attempts failed; admin must reconcile manually from the Sentry payload.

**Migration timing.** Existing tip rows get `dispute_email_attempts = 0` by default. A tip already mid-storm (Stripe attempt 30 of 60 at deploy time) starts a fresh 0 counter and will see up to 3 more attempts post-deploy before the bailout fires. Acceptable behavior; the storm bounds itself within hours of the deploy.

## Logic change

`notifyDisputeWon` keeps its signature. The internals restructure to run the entire flow inside a single transaction with a row lock on the tip, so two concurrent webhook deliveries cannot race past the idempotency check, duplicate emails, or leave the row stuck between an increment and a bailout finalization.

A new module-level constant `const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;` makes the threshold a one-line tuning point.

Flow:

1. **Open a transaction.** `const client = await pool.connect(); await client.query('BEGIN');`. The existing function uses `pool.query` directly; this switches to a held client through the function body.
2. **Lock + re-read the tip row.** `SELECT ... FROM tips t ... WHERE t.id = $1 FOR UPDATE OF t`. Holding the row lock through the email send is intentional: it mirrors the existing pattern in `payrollClawback.js` (also uses `SELECT ... FOR UPDATE` on `tips`). Tip rows are not contested (each dispute is independent), so the lock-during-HTTP cost is acceptable.
3. **Early return on already-done.** `if (!tip || tip.dispute_won_at) { ROLLBACK; return null; }`. Same semantics as today, just inside the transaction.
4. **Compute bartender shares.** Same logic as today (bartender lookup, fee split, share computation), but all queries use `client.query` so they participate in the same transaction. No mutating writes here.
5. **Try the email send.** Same as today: `if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL not set ...')` inside the try; `await sendEmail({ to: process.env.ADMIN_EMAIL, ... })`; set `emailSent = true` on success; catch and `Sentry.captureException` on failure.
6. **Atomic finalization UPDATE.** Two cases:
   * **On success** (`emailSent === true`):
     ```sql
     UPDATE tips
        SET dispute_won_at = NOW(),
            dispute_email_attempts = 0
      WHERE id = $1
     ```
     Resetting `dispute_email_attempts` to 0 on success protects against a long-tail flap scenario where a future outage starts counting from a stale non-zero baseline.
   * **On failure** (`emailSent === false`):
     ```sql
     UPDATE tips
        SET dispute_email_attempts = dispute_email_attempts + 1,
            dispute_won_at = CASE WHEN dispute_email_attempts + 1 >= 3 THEN NOW() ELSE dispute_won_at END,
            dispute_email_failed_at = CASE WHEN dispute_email_attempts + 1 >= 3 THEN NOW() ELSE dispute_email_failed_at END
      WHERE id = $1
     RETURNING dispute_email_attempts, dispute_email_failed_at IS NOT NULL AS bailed_out
     ```
     Single atomic statement; the `CASE WHEN dispute_email_attempts + 1 >= 3` references the OLD value plus 1 (equal to the post-increment value) since Postgres evaluates SET expressions against the pre-update row. The threshold constant is interpolated at module load (not a bind parameter, it is a JS-side constant, not user input).
7. **Bailout Sentry capture** (only when the failure UPDATE returns `bailed_out === true`):
   ```js
   Sentry.captureMessage('Dispute-won notification permanently abandoned after retry threshold', {
     level: 'error',
     tags: { util: 'payrollDisputeNotify', step: 'max_attempts_exceeded' },
     extra: {
       tipId,
       attempts: rows[0].dispute_email_attempts,
       reinstatedAmountCents: reinstated,
       bartenderIds: bartenders.map(b => b.id),
       eventDateLabel: fmtDate(tip.event_date),
     },
   });
   ```
   The Sentry capture fires inside the transaction. Because the `bailed_out` flag is only `true` on the row's first transition past the threshold (subsequent deliveries short-circuit at step 3 because `dispute_won_at` is now set), the message fires at most once per tip in the happy concurrency case. The pathological "two webhooks racing the same threshold transition" case is closed by step 2's row lock.
8. **Commit.** `await client.query('COMMIT'); client.release();`.
9. **Return.** Always returns `{ bartenders, reinstatedAmountCents, netTotalCents, abandoned }` where `abandoned` is `true` only on bailout. Adding `abandoned` to the shape gives callers an explicit signal for the "we never told the admin" state without requiring them to consult `dispute_email_failed_at` separately.

**Throw / rollback handling.** Any throw between BEGIN and COMMIT runs through a `try/catch` that calls `ROLLBACK` and re-throws. `client.release()` is in the `finally`. The email send itself is wrapped in its own inner `try` so a Resend failure does not bubble up and roll back the transaction; only an unexpected DB error rolls back.

## Race safety

The transaction + row lock close the two concrete races the design-stage review flagged:

* **Two concurrent webhook deliveries for the same tip.** Delivery A acquires the row lock at step 2. Delivery B's `SELECT ... FOR UPDATE` blocks until A commits. By the time B's query returns, A has already set `dispute_won_at`, so B short-circuits at step 3 with `ROLLBACK; return null`. No duplicate email, no double increment.
* **Crash between increment and finalization.** Both happen inside one statement now. There is no window where `dispute_email_attempts` can be 3 while `dispute_email_failed_at` is null. A process crash mid-transaction rolls back via Postgres's normal transaction semantics.

The Sentry `captureMessage` at step 7 fires inside the same transaction (after the conditional UPDATE returns `bailed_out === true`). It executes on the delivery that performs the actual threshold transition. Subsequent deliveries short-circuit before reaching step 7, so no duplicate Sentry messages for the same tip.

## Downstream consumers

The codebase has exactly one consumer of `dispute_won_at` outside `payrollDisputeNotify.js`: the function's own short-circuit at step 3. No other route, util, or test references `dispute_won_at` (verified by `grep -rn "dispute_won_at" server/`). Bailed-out and successfully-notified disputes are indistinguishable to all current callers, which is the correct semantics: in both cases, the dispute is fully processed and `notifyDisputeWon` should not re-fire.

If future code needs to surface "tips with abandoned notifications" (admin recovery dashboard, weekly digest, audit query), the filter is `WHERE dispute_email_failed_at IS NOT NULL`. That is a forward-looking note, not a change required by this spec.

## Tests

New or extended tests in `server/utils/payrollDisputeNotify.test.js` (node:test, mirroring the Jest-to-node-test conversion done earlier this session):

* **Success path.** Email send resolves. Verify `dispute_won_at IS NOT NULL`, `dispute_email_attempts = 0`, `dispute_email_failed_at IS NULL`, return value `abandoned === false`, full result object shape unchanged.
* **Counter reset on success after prior failure.** Seed `dispute_email_attempts = 2`. Force email success. Verify counter resets to 0 in the same UPDATE.
* **Single failure, attempts below threshold.** Seed `dispute_email_attempts = 0`. Force `sendEmail` to throw. Verify post-call `dispute_email_attempts = 1`, both timestamp columns stay null, `Sentry.captureException` invoked once with `step: 'send_email'`, no `Sentry.captureMessage` call, return value `abandoned === false`.
* **Bailout trigger.** Seed `dispute_email_attempts = 2`. Force `sendEmail` to throw. Verify post-call `dispute_email_attempts = 3`, both `dispute_won_at` and `dispute_email_failed_at` are set, `Sentry.captureMessage` invoked exactly once with the expected tags and the full payload (`tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, `eventDateLabel`), return value `abandoned === true`.
* **ADMIN_EMAIL unset path.** Use a try/finally pattern that saves the current `process.env.ADMIN_EMAIL`, `delete`s it for the test body, then restores in the finally block (and in a node:test `afterEach` hook covering the test). Verify the function still increments the counter and runs the catch path. Tests in this file run serially; do not enable test concurrency.
* **Already-completed short-circuit.** Seed `dispute_won_at` to a past timestamp. Verify the function returns null, no UPDATE runs, no Sentry capture, no email send.
* **Concurrency: two parallel calls with forced failure.** Seed `dispute_email_attempts = 0`. Launch two `notifyDisputeWon` calls in parallel, both with a forced send failure. Verify the post-state counter is exactly 1 (the second call short-circuits at step 3 once the first commits its increment OR completes the bailout) and at most one `Sentry.captureException` call landed (the other delivery short-circuited before reaching the send). This test codifies the row-lock serialization assumption.

The DB tests use the same `DELETE FROM tips WHERE id IN (test-ids)` cleanup pattern as the existing payroll tests, with `before`/`after` hooks at the suite level.

## Files touched

* `server/db/schema.sql`: append the two new ALTERs near the existing Phase 2 staff-payments `tips` block (around line 2592, where `dispute_won_at` already lives).
* `server/utils/payrollDisputeNotify.js`: introduce `MAX_DISPUTE_EMAIL_ATTEMPTS`, restructure to use `pool.connect()` + held transaction, atomic finalization UPDATE, bailout Sentry capture, `abandoned` field in the return shape.
* `server/utils/payrollDisputeNotify.test.js`: add new tests per the test plan above.
* `ARCHITECTURE.md`: document the two new `tips` columns AND bring the existing tips-table description current (the pre-existing drift inherited but not introduced by this spec: `fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, and the existing `dispute_won_at` are all missing from the current doc). Include the state-machine note describing the four combinations of (`dispute_won_at`, `dispute_email_failed_at`) values.

## Sentry quota footprint

Worst case for a stuck dispute (ADMIN_EMAIL unset, never fixed): 3 × `Sentry.captureException` (one per failed send attempt) + 1 × `Sentry.captureMessage` (the bailout). After that, the row lock + early-return short-circuits all future Stripe redeliveries. Bound on Sentry events per stuck dispute: 4 events total, all front-loaded over a few hours. Acceptable.
