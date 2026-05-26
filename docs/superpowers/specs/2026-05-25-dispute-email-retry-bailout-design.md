# Dispute-won email: retry bailout

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (two design-fleet review folds applied), ready for implementation plan
**Source finding:** L2 from the 2026-05-25 session-review pass (commit `49e8cfd` opened this when it gated `dispute_won_at` on email success). Spec folds in findings from two design-fleet review passes on 2026-05-25 (round 1: 2 blockers + 7 warnings + 5 suggestions; round 2: 2 blockers + 6 warnings + 10 suggestions).

## Problem

`server/utils/payrollDisputeNotify.js` sends an admin email when Stripe reinstates funds on a previously-paid-out card tip, then marks `tips.dispute_won_at = NOW()` so the webhook handler never re-processes the same dispute. After commit `49e8cfd`, the mark is gated on email success: a Resend failure or an unset `ADMIN_EMAIL` leaves `dispute_won_at` null.

Stripe redelivers `charge.dispute.funds_reinstated` for up to 3 days, roughly 60 attempts with exponential backoff. Each redelivery re-runs `notifyDisputeWon`, re-fetches the tip and shift rows, re-computes per-bartender shares, and re-captures the failure to Sentry. The result is a self-DoS: a stuck env burns Sentry quota for days and never recovers without manual intervention.

## Goal

Cap the retry storm at 3 attempts. After the third failure, stop processing, leave a durable record that the notification was abandoned, and surface the abandonment loudly so an admin can react. Make every state transition atomic so two concurrent webhook deliveries cannot duplicate emails or leave the row stuck. Bound the lock-during-HTTP window so a Resend slowdown cannot starve the Postgres connection pool.

## Non-goals

* No SMS fallback. The `feedback_notification_cost` rule favors email over SMS; the admin reads Sentry instead.
* No admin-dashboard surface for stuck disputes. Sentry's existing alerting is the channel.
* No auto-resend if `ADMIN_EMAIL` gets set later. Once the bailout fires, that specific dispute notification is permanently abandoned by design.

**Manual recovery runbook** (for the admin reading the Sentry alert): the bailout's `captureMessage` payload carries `tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, and the event date label. The bartender IDs in the alert are a **point-in-time snapshot of the shift's approved bartenders at bailout time**. If `shift_requests` later changes (bartender swap, request status flip), the alert's IDs may not match the current shift roster. Reconcile from the Sentry payload as the authoritative set, not from a fresh `shift_requests` re-query, so the admin pays the people who actually worked the shift at the time the dispute was won.

To reconcile manually, the admin computes per-bartender shares from the alert fields (or queries `tips` directly by `tipId`) and adds positive adjustments on each bartender's next open payout via the existing admin payroll UI. No automated path exists.

## Schema

Add two columns to `tips`, anchored immediately after the existing `dispute_won_at` column at `server/db/schema.sql:2592` so all dispute-related columns stay grouped inside the Phase 2 staff-payments block:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

**State machine** (documented in ARCHITECTURE.md alongside the columns):
* **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`. Webhook has not delivered, or the first attempt has not run.
* **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`. One or more send failures, still inside the retry window.
* **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`. Email was delivered, admin saw it.
* **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. Three attempts failed; admin must reconcile manually from the Sentry payload. **The presence of `dispute_email_failed_at IS NOT NULL` is the canonical "needs manual reconciliation" marker**, and an admin can query that field directly in Postgres to enumerate stuck rows without going through Sentry.

**Migration timing.** Existing tip rows get `dispute_email_attempts = 0` by default. A tip already mid-storm (Stripe attempt 30 of 60 at deploy time) starts a fresh 0 counter and will see up to 3 more attempts post-deploy before the bailout fires. A rolling restart that has an old-code instance still in service after the ALTERs land is also safe: the old code does not reference the new columns, and the `DEFAULT 0` covers reads from the new code.

## Logic change

`notifyDisputeWon` keeps its signature. The internals restructure to run the entire flow inside a single transaction with a row lock on the tip, so two concurrent webhook deliveries cannot race past the idempotency check, duplicate emails, or leave the row stuck between an increment and a bailout finalization.

Two new module-level constants make the threshold and the send timeout one-line tuning points:

```js
const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 15_000;
```

Flow:

1. **Open a transaction.** `const client = await pool.connect(); await client.query('BEGIN');`. The existing function uses `pool.query` directly; this switches to a held client through the function body.
2. **Lock + re-read the tip row.** `SELECT ... FROM tips t LEFT JOIN shifts s ... LEFT JOIN proposals p ... LEFT JOIN clients c ... WHERE t.id = $1 FOR UPDATE OF t`. The `FOR UPDATE OF t` alias is required for Postgres to accept `FOR UPDATE` on the nullable side of an outer join, and it scopes the lock to the `tips` row only. **Code-review note:** no other call site in the codebase combines `FOR UPDATE OF <alias>` with LEFT JOINs. Do not drop the `OF t` clause when reformatting; without it the query will error against the LEFT JOINs.
3. **Early return on already-done.** `if (!tip || tip.dispute_won_at) { ROLLBACK; return null; }`. Same semantics as today, just inside the transaction.
4. **Compute bartender shares.** Same logic as today (bartender lookup, fee split, share computation), with all queries routed through `client.query` so they participate in the same transaction. No mutating writes here. **A throw anywhere in steps 2 through 4 propagates to the outer try/catch which calls ROLLBACK and re-throws; the counter is NOT incremented in this case** because the increment lives only in the failure tail at step 6. Webhook handler 5xxs, Stripe retries on its own cadence with the row's counter unchanged.
5. **Try the email send, bounded by a timeout.** Same pre-check as today (`if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL not set ...')`), then `await sendEmail({ to: ..., signal: AbortSignal.timeout(SEND_TIMEOUT_MS), ... })`. On a Resend slowdown or hang, `AbortSignal.timeout` fires after 15 seconds and the catch path runs. Set `emailSent = true` only on a clean resolution; catch and `Sentry.captureException` on any failure (network error, timeout, ADMIN_EMAIL throw, template render throw). The bounded timeout is the mechanism that prevents holding the row lock and a pool slot indefinitely; the spec's rationale to mirror `payrollClawback.js`'s lock-during-DB-work pattern is extended here to lock-during-bounded-HTTP-call.
6. **Atomic finalization UPDATE.** Two cases:
   * **On success** (`emailSent === true`):
     ```sql
     UPDATE tips
        SET dispute_won_at = NOW(),
            dispute_email_attempts = 0
      WHERE id = $1
        AND dispute_won_at IS NULL
     ```
     Resetting `dispute_email_attempts` to 0 on success protects against a long-tail flap scenario where a future outage starts counting from a stale non-zero baseline. The defensive `AND dispute_won_at IS NULL` predicate is belt-and-suspenders against a future refactor that drops the row lock; the row lock alone is sufficient for the current design.
   * **On failure** (`emailSent === false`):
     ```sql
     UPDATE tips
        SET dispute_email_attempts = dispute_email_attempts + 1,
            dispute_won_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_won_at END,
            dispute_email_failed_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_email_failed_at END
      WHERE id = $1
        AND dispute_won_at IS NULL
     RETURNING dispute_email_attempts, dispute_email_failed_at IS NOT NULL AS bailed_out
     ```
     Single atomic statement. The threshold value uses `${MAX_DISPUTE_EMAIL_ATTEMPTS}` template interpolation at module load (a JS-side constant, not a bind parameter, not user input), so the constant is the single source of truth in JS AND in SQL. The `AS bailed_out` alias must be preserved in the implementation (pg returns the column under the aliased name; dropping `AS` would return a generated default name). The `AND dispute_won_at IS NULL` predicate is the same belt-and-suspenders idempotency guard as on the success branch.
7. **Commit, then capture Sentry.** `await client.query('COMMIT'); client.release();`. **After** commit, if the failure UPDATE returned `bailed_out === true`:
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
   Capturing AFTER commit means a COMMIT failure (deadlock, connection drop) rolls back the bailout and prevents the Sentry alert from firing on state that did not persist. The cost is that a process crash between COMMIT and `captureMessage` loses one Sentry alert; the DB state is consistent, and the next webhook redelivery short-circuits at step 3 (because `dispute_won_at` is set) without re-firing the alert. Acceptable tradeoff: lost alert about a real abandonment is better than spurious alert about a rolled-back state.
8. **Return.** Always returns `{ bartenders, reinstatedAmountCents, netTotalCents, abandoned }` where `abandoned` is `true` only on bailout. Adding `abandoned` to the shape gives callers an explicit signal for the "we never told the admin" state without requiring them to consult `dispute_email_failed_at` separately.

**Throw / rollback handling.** Any throw between BEGIN and COMMIT runs through a `try/catch` that calls `ROLLBACK` and re-throws. `client.release()` is in the `finally`. The email send is wrapped in its own inner `try` so a Resend failure (including the AbortSignal timeout) does not bubble up; the outer try/catch is only reached on unexpected DB errors or computation throws.

## Race safety

The transaction + row lock close the two concrete races the design-stage review flagged:

* **Two concurrent webhook deliveries for the same tip, threshold-crossing case.** Delivery A acquires the row lock at step 2, fails its send, and runs the atomic failure UPDATE that crosses the threshold (e.g., the row was at `attempts = 2` when both arrived). The UPDATE sets `dispute_won_at` and `dispute_email_failed_at` atomically and commits. Delivery B's `SELECT ... FOR UPDATE` unblocks, reads the now-set `dispute_won_at`, short-circuits at step 3 with `ROLLBACK; return null`. No duplicate email, no double increment, one `captureMessage`.
* **Two concurrent webhook deliveries, below-threshold case.** Same shape, but the row was at `attempts = 0`. A fails, increments to 1, commits without setting `dispute_won_at` (still below threshold). B's SELECT unblocks, reads `dispute_won_at IS NULL`, does NOT short-circuit, attempts its own send, increments to 2. End state: counter = 2, two `captureException` calls, no `captureMessage`. This is correct behavior; the row lock serializes the increments to prevent lost updates without forcing one delivery to skip work it should do.
* **Crash between increment and finalization.** Both happen inside one statement now. There is no window where `dispute_email_attempts` can be 3 while `dispute_email_failed_at` is null. A process crash mid-transaction rolls back via Postgres's normal transaction semantics.
* **Sentry capture throws.** If `Sentry.captureMessage` itself throws (extremely unlikely; the SDK is documented as non-throwing), the throw propagates out of `notifyDisputeWon` AFTER the commit landed. The webhook handler 5xxs, Stripe redelivers, the next delivery's step 2 sees `dispute_won_at` set, short-circuits at step 3. Net result: one Sentry message lost, zero stuck rows, zero duplicate alerts.

The Sentry `captureMessage` at step 7 fires from the delivery that performed the atomic threshold transition. Subsequent deliveries short-circuit before reaching step 7. Sentry quota footprint: at most one `captureMessage` per tip, ever.

## Downstream consumers

The codebase has exactly one consumer of `dispute_won_at` outside `payrollDisputeNotify.js`: the function's own short-circuit at step 3. No other route, util, or test references `dispute_won_at` (verified by `grep -rn "dispute_won_at" server/`). Bailed-out and successfully-notified disputes are indistinguishable to all current callers, which is the correct semantics: in both cases, the dispute is fully processed and `notifyDisputeWon` should not re-fire.

If future code needs to surface "tips with abandoned notifications" (admin recovery dashboard, weekly digest, audit query), the filter is `WHERE dispute_email_failed_at IS NOT NULL`. That is a forward-looking note, not a change required by this spec.

## Tests

New or extended tests in `server/utils/payrollDisputeNotify.test.js` (node:test, mirroring the Jest-to-node-test conversion done earlier this session). **Add a suite-wide comment at the top of the file pinning serial execution** so future contributors do not enable `--test-concurrency` and break the env-mutation tests.

* **Success path.** Email send resolves. Verify `dispute_won_at IS NOT NULL`, `dispute_email_attempts = 0`, `dispute_email_failed_at IS NULL`, return value `abandoned === false`, full result object shape unchanged.
* **Counter reset on success after prior failure.** Seed `dispute_email_attempts = 2`. Force email success. Verify counter resets to 0 in the same UPDATE.
* **Single failure, attempts below threshold.** Seed `dispute_email_attempts = 0`. Force `sendEmail` to throw. Verify post-call `dispute_email_attempts = 1`, both timestamp columns stay null, `Sentry.captureException` invoked once with `step: 'send_email'`, no `Sentry.captureMessage` call, return value `abandoned === false`.
* **Bailout trigger.** Seed `dispute_email_attempts = 2`. Force `sendEmail` to throw. Verify post-call `dispute_email_attempts = 3`, both `dispute_won_at` and `dispute_email_failed_at` are set AND equal (both `NOW()` in the same UPDATE), `Sentry.captureMessage` invoked exactly once with the expected tags and full payload (`tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, `eventDateLabel`), return value `abandoned === true`.
* **ADMIN_EMAIL unset path.** Use a try/finally pattern that saves the current `process.env.ADMIN_EMAIL`, `delete`s it for the test body, then restores in the finally block (and in a node:test `afterEach` hook covering the test). Verify the function still increments the counter and runs the catch path.
* **Computation throw rolls back without incrementing.** Force the bartender-resolution query to throw (e.g., stub `pool.query` for the `shift_requests` SELECT to reject). Verify the function re-throws, post-call `dispute_email_attempts` is unchanged, `dispute_won_at` is still null, no Sentry events fired from inside `notifyDisputeWon`. Locks in the explicit step-4 semantics so a future implementer does not widen the catch.
* **Already-completed short-circuit.** Seed `dispute_won_at` to a past timestamp. Verify the function returns null, no UPDATE runs, no Sentry capture, no email send.
* **Concurrency: bailout-trigger race.** Seed `dispute_email_attempts = 2`. Launch two `notifyDisputeWon` calls in parallel, both with a forced send failure. Expected: one call wins the row lock, fails its send, crosses the threshold (attempts 2 to 3 with both flags set), commits, fires `captureMessage`. The other call unblocks on the lock, reads `dispute_won_at` set, short-circuits and returns null without sending. Verify post-state `dispute_email_attempts = 3`, both timestamps set and equal, exactly one `captureException`, exactly one `captureMessage`.
* **Concurrency: below-threshold race.** Seed `dispute_email_attempts = 0`. Launch two `notifyDisputeWon` calls in parallel, both with a forced send failure. Expected: both calls run, the row lock serializes them, both fail, both increment. Post-state: `dispute_email_attempts = 2`, both timestamp columns still null, exactly two `captureException` calls, zero `captureMessage` calls. This is the "row lock prevents lost updates without forcing skipped work" case.
* **Send-timeout case.** Stub `sendEmail` to await past `SEND_TIMEOUT_MS`. Verify the AbortSignal fires, the catch path runs, the row lock is released within the timeout plus a small margin (assert wall-clock duration), the counter increments.

The DB tests use the same `DELETE FROM tips WHERE id IN (test-ids)` cleanup pattern as the existing payroll tests, with `before`/`after` hooks at the suite level.

## Files touched

* `server/db/schema.sql`: append the two new ALTERs immediately after line 2592 (where existing `dispute_won_at` lives), keeping the dispute-related columns grouped inside the Phase 2 staff-payments block.
* `server/utils/payrollDisputeNotify.js`: introduce `MAX_DISPUTE_EMAIL_ATTEMPTS` and `SEND_TIMEOUT_MS`, restructure to use `pool.connect()` + held transaction, `AbortSignal.timeout`-bounded send, atomic finalization UPDATE with belt-and-suspenders `AND dispute_won_at IS NULL`, post-commit Sentry capture, `abandoned` field in the return shape.
* `server/utils/payrollDisputeNotify.test.js`: add the suite-wide serial-execution comment plus the new tests per the test plan above.
* `ARCHITECTURE.md`: document the two new `tips` columns AND bring the existing tips-table description current (the pre-existing drift inherited but not introduced by this spec: `fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, and the existing `dispute_won_at` are all missing from the current doc). Include the state-machine note describing the four combinations of (`dispute_won_at`, `dispute_email_failed_at`) values, and explicitly call out that `dispute_email_failed_at IS NOT NULL` is the canonical "abandoned, needs manual reconciliation" marker.

## Sentry quota footprint

Worst case for a single stuck dispute (ADMIN_EMAIL unset, never fixed): 3 × `Sentry.captureException` (one per failed send attempt) + 1 × `Sentry.captureMessage` (the bailout, fired post-commit). After that, the row lock + early-return short-circuits all future Stripe redeliveries. Bound on Sentry events **per stuck dispute**: 4 events, all front-loaded over a few hours.

If many disputes go stuck at once (eg. ADMIN_EMAIL globally unset for a day), the ceiling multiplies by the number of stuck disputes. Bounded but not constant; an alert tier change in Sentry is the right response to a global outage, not a code change here.
