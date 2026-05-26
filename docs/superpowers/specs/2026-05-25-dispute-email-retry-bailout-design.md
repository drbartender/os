# Dispute-won email: retry bailout

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (three design-fleet review folds applied), ready for implementation plan
**Source finding:** L2 from the 2026-05-25 session-review pass (commit `49e8cfd` opened this when it gated `dispute_won_at` on email success). Spec folds in findings from three design-fleet review passes on 2026-05-25 (round 1: 2 blockers + 7 warnings + 5 suggestions; round 2: 2 blockers + 6 warnings + 10 suggestions; round 3: 3 blockers + 8 warnings + 9 suggestions).

## Problem

`server/utils/payrollDisputeNotify.js` sends an admin email when Stripe reinstates funds on a previously-paid-out card tip, then marks `tips.dispute_won_at = NOW()` so the webhook handler never re-processes the same dispute. After commit `49e8cfd`, the mark is gated on email success: a Resend failure or an unset `ADMIN_EMAIL` leaves `dispute_won_at` null.

Stripe redelivers `charge.dispute.funds_reinstated` for up to 3 days, roughly 60 attempts with exponential backoff. Each redelivery re-runs `notifyDisputeWon`, re-fetches the tip and shift rows, re-computes per-bartender shares, and re-captures the failure to Sentry. The result is a self-DoS: a stuck env burns Sentry quota for days and never recovers without manual intervention.

## Goal

Cap the retry storm at 3 attempts. After the third failure, stop processing, leave a durable record that the notification was abandoned, and surface the abandonment loudly so an admin can react. Make every state transition atomic so two concurrent webhook deliveries cannot duplicate emails or leave the row stuck. Bound the lock-during-HTTP window so a Resend slowdown cannot starve the Postgres connection pool. The DB record (not the Sentry alert) is the canonical durable artifact of abandonment so a missed alert cannot bury the state forever.

## Non-goals

* No SMS fallback. The `feedback_notification_cost` rule favors email over SMS; the admin reads Sentry instead.
* No admin-dashboard surface for stuck disputes. The DB column + admin sweep query is the channel.
* No auto-resend if `ADMIN_EMAIL` gets set later. Once the bailout fires, that specific dispute notification is permanently abandoned by design.

**Manual recovery runbook** (for the admin):
1. Either Sentry fires a `Dispute-won notification permanently abandoned` alert OR the weekly sweep query `SELECT id, dispute_email_failed_at FROM tips WHERE dispute_email_failed_at IS NOT NULL` surfaces a row.
2. The Sentry payload (when present) carries `tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, and the event date label. **`bartenderIds` is a point-in-time snapshot of the shift's approved bartenders at bailout time**; if `shift_requests` has since changed, reconcile from the Sentry payload as the authoritative set, not from a fresh roster query.
3. **Verify whether the email actually delivered** before adding adjustments. The 5-second send-timeout aborts the awaiter but does NOT cancel the in-flight Resend request, so the email may have delivered server-side after we treated it as a failure. Check the `ADMIN_EMAIL` inbox for a matching `Dispute Reinstated` email near the timestamp before paying out. If found, do not pay again.
4. Add positive adjustments on each bartender's next open payout via the existing admin payroll UI. **Verify the UI accepts adjustments for bartender IDs no longer on the current `shift_requests` roster** (status flipped to declined, request deleted, etc.); if it filters them out, the workaround is a direct DB edit or routing via a different surface.
5. No automated path exists.

## Schema

Add two columns to `tips`, anchored immediately after the existing `dispute_won_at` column at `server/db/schema.sql:2592`, keeping all dispute-related columns grouped inside the Phase 2 staff-payments block:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

**State machine** (documented in ARCHITECTURE.md alongside the columns):
* **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`.
* **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`.
* **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`.
* **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. The presence of `dispute_email_failed_at IS NOT NULL` is the canonical "needs manual reconciliation" marker; an admin can query that field directly in Postgres to enumerate stuck rows without going through Sentry. ARCHITECTURE.md will document a recommended weekly sweep cadence so abandonments cannot bury silently behind a missed alert.

**Migration timing.** Existing tip rows get `dispute_email_attempts = 0` by default. A tip already mid-storm starts a fresh counter and sees up to 3 more attempts post-deploy. A rolling restart with old-code and new-code instances coexisting is safe: the old code does not reference the new columns, and `DEFAULT 0` covers reads from the new code.

## Logic change

`notifyDisputeWon` keeps its signature. The internals restructure to run the entire flow inside a single transaction with a row lock on the tip, so two concurrent webhook deliveries cannot race past the idempotency check, duplicate emails, or leave the row stuck between an increment and a bailout finalization.

Module-level constants make tunable knobs explicit one-liners:

```js
const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 5_000;
```

`SEND_TIMEOUT_MS = 5_000` (down from the round-2 round-trip of 15s) bounds the worst-case lock-during-HTTP window. With a 10-connection pool, 10 concurrent disputes during a Resend slowdown hold at most 50 connection-seconds (vs. 150 at 15s); a dispute-reinstatement webhook is low-urgency and 5s is plenty for a healthy Resend response.

**Test seam.** Add a `__setDeps` seam mirroring `server/utils/sendProposalSentEmail.js:17-24`:

```js
let _deps = { sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS };
function __setDeps(d) { _deps = { ..._deps, ...d }; }
module.exports = { notifyDisputeWon, __setDeps };
```

The function body uses `_deps.sendEmail(...)`, `_deps.Sentry.captureException(...)`, `_deps.Sentry.captureMessage(...)`, and `_deps.sendTimeoutMs`. Tests use `__setDeps` to substitute mocks (`mock.fn()` from `node:test`) for the email send, the Sentry channel, and an override for the timeout value (so the send-timeout test does not wait 5 real seconds in CI). Pool stays direct, the tests use the real DB and rely on row-level seed/cleanup.

Flow:

1. **Open a transaction.** `const client = await pool.connect(); await client.query('BEGIN');`. The function body uses the held `client` rather than `pool.query`.
2. **Lock + re-read the tip row.** `SELECT ... FROM tips t LEFT JOIN shifts s ... LEFT JOIN proposals p ... LEFT JOIN clients c ... WHERE t.id = $1 FOR UPDATE OF t`. The `FOR UPDATE OF t` alias is required for Postgres to accept `FOR UPDATE` on the nullable side of an outer join, and it scopes the lock to the `tips` row only. **Code-review note:** the `FOR UPDATE OF <alias>` + LEFT JOIN pattern has precedent at `server/routes/drinkPlanConsult.js:144` (the same shape with a LEFT JOIN to proposals). Do not drop the `OF t` clause when reformatting.
3. **Early return on already-done.** `if (!tip || tip.dispute_won_at) { ROLLBACK; return null; }`. Same semantics as today, inside the transaction.
4. **Compute bartender shares.** Same logic as today, with all queries routed through `client.query` so they participate in the same transaction. No mutating writes here. **A throw anywhere in steps 2 through 4 propagates to the outer try/catch which calls ROLLBACK and re-throws; the counter is NOT incremented in this case** because the increment lives only in the failure tail at step 6. The webhook handler at `server/routes/stripe.js:1652-1660` **catches and 200-OKs the throw** rather than 5xxing, so Stripe does NOT auto-retry. The tip stays in its current state until the next dispute event (if any), or until manually re-processed. Sentry receives the `captureException` from the webhook handler's catch. This is the accepted tradeoff: computation throws are rare, surface in Sentry, and require manual reconciliation if they recur for the same dispute.
5. **Try the email send, bounded by a `Promise.race` timeout.** Same pre-check as today (`if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL not set ...')`), then race the send against a `setTimeout` rejection:
   ```js
   try {
     if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL not set; cannot deliver dispute-won notification');
     await Promise.race([
       _deps.sendEmail({ to: process.env.ADMIN_EMAIL, subject: tpl.subject, html: tpl.html, text: tpl.text }),
       new Promise((_, reject) => {
         const t = setTimeout(() => reject(new Error('sendEmail timed out')), _deps.sendTimeoutMs);
         t.unref?.();
       }),
     ]);
     emailSent = true;
   } catch (err) {
     _deps.Sentry.captureException(err, { tags: { util: 'payrollDisputeNotify', step: 'send_email' } });
   }
   ```
   Why `Promise.race` instead of `AbortSignal.timeout`: `server/utils/email.js` does not accept a `signal` parameter and the Resend SDK's typed surface (`CreateEmailRequestOptions`) only exposes `query` and `headers`. Plumbing a `signal` through would require touching `sendEmail` and an undocumented Resend pass-through. `Promise.race` is a pure-userspace pattern that does not depend on any library accepting a signal.
   **Important caveat:** `Promise.race` aborts the awaiter, NOT the in-flight HTTP request. Resend may still deliver the email server-side after the timeout fires. The runbook (above) instructs the admin to verify the inbox before paying out. Acceptable tradeoff for a low-volume code path.
6. **Atomic finalization UPDATE.** Two cases:
   * **On success** (`emailSent === true`):
     ```sql
     UPDATE tips
        SET dispute_won_at = NOW(),
            dispute_email_attempts = 0
      WHERE id = $1
        AND dispute_won_at IS NULL
     ```
     Resets `dispute_email_attempts` to 0 in the same UPDATE so a future outage starts counting from zero, not a stale baseline. The defensive `AND dispute_won_at IS NULL` predicate is belt-and-suspenders against a future refactor that drops the row lock.
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
     Single atomic statement. Postgres evaluates all SET expressions and CASE conditions against the OLD row in a single statement, so `dispute_email_attempts + 1` in the CASE references the same pre-update value as the SET. The threshold uses `${MAX_DISPUTE_EMAIL_ATTEMPTS}` template interpolation at module load (a JS-side constant, not user input), making the JS constant the single source of truth in JS AND in SQL. The `AS bailed_out` alias must be preserved (pg returns the column under the aliased name; dropping `AS` returns a generated default name and breaks downstream destructure).
7. **Commit, then capture Sentry with a wrap.** `await client.query('COMMIT'); client.release();`. **After** commit, if the failure UPDATE returned `bailed_out === true`:
   ```js
   try {
     _deps.Sentry.captureMessage('Dispute-won notification permanently abandoned after retry threshold', {
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
   } catch (sentryErr) {
     console.error(
       `[payrollDisputeNotify] BAILOUT_ALERT_FAILED tipId=${tipId} attempts=${rows[0].dispute_email_attempts}`,
       sentryErr
     );
   }
   ```
   Capturing AFTER commit means a COMMIT failure rolls back the bailout and prevents the Sentry alert from firing on state that did not persist. The try/catch around `captureMessage` covers non-crash Sentry SDK failures (rate limit, transport blip) by logging a distinctive marker to stdout. **The canonical durable artifact of abandonment is `tips.dispute_email_failed_at`, NOT the Sentry alert.** A process crash between COMMIT and the captureMessage call loses the Sentry alert but the DB state persists, and the weekly admin sweep query (documented in ARCHITECTURE.md) is the failsafe channel that catches the missed-alert case. The Stripe webhook does NOT redeliver in this case because the caller catches throws and 200-OKs the response, so the next chance for an alert is the sweep.
8. **Return.** Always returns `{ bartenders, reinstatedAmountCents, netTotalCents, abandoned }` where `abandoned` is `true` only on bailout. Adding `abandoned` to the shape gives callers an explicit signal for the "we never told the admin" state. **Verified additive-safe:** the only caller is `server/routes/stripe.js:1654`, which `await`s and discards the return; no destructure of the shape exists in the codebase.

**Throw / rollback handling.** Any throw between BEGIN and COMMIT runs through a `try/catch` that calls `ROLLBACK` and re-throws to the caller. `client.release()` is in the `finally`. The email send is wrapped in its own inner `try` so a Resend failure (including the Promise.race timeout) does not bubble up; the outer try/catch is only reached on unexpected DB errors or computation throws.

## Race safety

The transaction + row lock close the two concrete races the design-stage review flagged:

* **Threshold-crossing race.** Two concurrent deliveries for the same tip with `attempts = 2`. A acquires the row lock, fails its send, runs the atomic failure UPDATE that crosses the threshold, commits. B's `SELECT ... FOR UPDATE` unblocks, reads the now-set `dispute_won_at`, short-circuits at step 3. No duplicate email, one bailout, one `captureMessage` (assuming the post-commit Sentry call completes).
* **Below-threshold race.** Two concurrent deliveries with `attempts = 0`. A increments to 1 and commits without setting `dispute_won_at`. B's SELECT unblocks, sees `dispute_won_at IS NULL`, does NOT short-circuit, attempts its own send, increments to 2. End state: counter = 2, two `captureException` calls, no `captureMessage`. Correct behavior.
* **Crash between increment and finalization.** Both happen inside one statement now. There is no window where `dispute_email_attempts` can be 3 while `dispute_email_failed_at` is null.
* **Post-commit Sentry capture failure or process crash.** Three sub-cases:
  - `captureMessage` throws synchronously: the try/catch around it catches and logs `BAILOUT_ALERT_FAILED` to stderr. DB state already committed. The next webhook redelivery does NOT happen because the webhook caller 200-OKs the original delivery.
  - `captureMessage` accepts the call but the SDK fails async transport: Sentry alert is silently lost. DB state persists. Same sweep-query failsafe applies.
  - Process crashes between COMMIT and `captureMessage`: same as the async transport failure. DB state persists, Sentry alert lost, sweep-query catches.

The Sentry `captureMessage` at step 7 fires from the delivery that performed the atomic threshold transition. Subsequent deliveries (if Stripe ever redelivers despite the 200-OK, e.g., from a different webhook event) short-circuit at step 3 before reaching step 7. Sentry quota footprint: at most one `captureMessage` per tip per process lifetime. The DB record is the canonical record.

## Downstream consumers

The codebase has exactly one consumer of `dispute_won_at` outside `payrollDisputeNotify.js`: the function's own short-circuit at step 3. No other route, util, or test references `dispute_won_at` (verified by `grep -rn "dispute_won_at" server/`). Bailed-out and successfully-notified disputes are indistinguishable to all current callers, which is the correct semantics: in both cases, the dispute is fully processed and `notifyDisputeWon` should not re-fire.

The return-shape addition (`abandoned`) is additive-safe: `server/routes/stripe.js:1654` is the only caller and it `await`s the result without destructuring.

If future code needs to surface "tips with abandoned notifications" (admin dashboard, weekly digest, audit query), the filter is `WHERE dispute_email_failed_at IS NOT NULL`. The weekly admin sweep query documented in ARCHITECTURE.md uses this filter.

## Tests

New or extended tests in `server/utils/payrollDisputeNotify.test.js` (node:test, mirroring the Jest-to-node-test conversion done earlier this session). **Add a suite-wide comment at the top of the file pinning serial execution** so future contributors do not enable `--test-concurrency` and break the env-mutation tests.

All tests use the `__setDeps` seam from the spec's Logic section to substitute mocks. Pattern:

```js
const { notifyDisputeWon, __setDeps } = require('./payrollDisputeNotify');
const sendEmailMock = mock.fn(async () => ({ id: 'msg_test' }));
const captureExceptionMock = mock.fn();
const captureMessageMock = mock.fn();
__setDeps({
  sendEmail: sendEmailMock,
  Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
  sendTimeoutMs: 100, // override for fast tests
});
// after each test, reset:
__setDeps({ sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS });
```

Test cases:

* **Success path.** Email send resolves. Verify `dispute_won_at IS NOT NULL`, `dispute_email_attempts = 0`, `dispute_email_failed_at IS NULL`, return value `abandoned === false`, full result object shape unchanged, `captureMessageMock.mock.callCount() === 0`.
* **Counter reset on success after prior failure.** Seed `dispute_email_attempts = 2`. Force `sendEmail` to resolve. Verify counter resets to 0 in the same UPDATE.
* **Single failure, attempts below threshold.** Seed `dispute_email_attempts = 0`. Force `sendEmail` to reject. Verify post-call `dispute_email_attempts = 1`, both timestamp columns stay null, `captureExceptionMock.mock.callCount() === 1` with `step: 'send_email'` tag, `captureMessageMock.mock.callCount() === 0`, return value `abandoned === false`.
* **Bailout trigger.** Seed `dispute_email_attempts = 2`. Force `sendEmail` to reject. Verify post-call `dispute_email_attempts = 3`, both `dispute_won_at` and `dispute_email_failed_at` are set AND equal (both `NOW()` in the same UPDATE), `captureMessageMock.mock.callCount() === 1` with the expected tags and full payload, return value `abandoned === true`.
* **ADMIN_EMAIL unset path.** Save `process.env.ADMIN_EMAIL` to a local variable, check `typeof saved === 'string'`, `delete process.env.ADMIN_EMAIL`, run the test body, then in a try/finally restore (assigning only if the saved value was a string, otherwise leaving it deleted). Also wire an `afterEach` hook that does the same restore. Verify the function still increments the counter and runs the catch path.
* **Computation throw rolls back without incrementing.** Use `__setDeps` to inject a sentinel into a place where computation needs it, OR stub `pool.query` for the bartender lookup to reject. Verify the function re-throws, post-call `dispute_email_attempts` is unchanged, `dispute_won_at` is still null, `captureExceptionMock` and `captureMessageMock` both at zero calls from inside `notifyDisputeWon`. Locks in the explicit step-4 semantics.
* **Already-completed short-circuit.** Seed `dispute_won_at` to a past timestamp. Verify the function returns null, no UPDATE runs, no Sentry capture, no email send.
* **Concurrency: bailout-trigger race.** Seed `dispute_email_attempts = 2`. Launch two `notifyDisputeWon` calls in parallel, both with a forced send failure. Expected: one call wins the row lock and crosses the threshold (attempts 2 to 3 with both flags set), commits, fires `captureMessage`. The other call unblocks, reads `dispute_won_at` set, short-circuits and returns null. Verify post-state `dispute_email_attempts = 3`, both timestamps set and equal, `captureExceptionMock.mock.callCount() === 1`, `captureMessageMock.mock.callCount() === 1`.
* **Concurrency: below-threshold race.** Seed `dispute_email_attempts = 0`. Launch two `notifyDisputeWon` calls in parallel, both with a forced send failure. Expected: both calls increment serially via the row lock. Post-state: `dispute_email_attempts = 2`, both timestamps still null, `captureExceptionMock.mock.callCount() === 2`, `captureMessageMock.mock.callCount() === 0`.
* **Send-timeout case.** Use `__setDeps` to set `sendTimeoutMs = 50` and inject a `sendEmail` mock that resolves after 200ms. Verify: the Promise.race timeout fires within roughly 50-100ms, the catch path runs, `captureExceptionMock` fires with the timeout error, `dispute_email_attempts` increments, the row lock is released within the timeout plus a small margin (assert wall-clock < 200ms). Asserting the counter increment matters: a test that only checks duration could pass if the catch path were short-circuited.
* **Post-commit Sentry capture failure.** Use `__setDeps` to inject a `Sentry.captureMessage` mock that throws. Seed `dispute_email_attempts = 2`, force `sendEmail` to reject (triggering the bailout). Verify: post-call `dispute_won_at` and `dispute_email_failed_at` are still set (DB state committed before the Sentry throw), `console.error` was called with the `BAILOUT_ALERT_FAILED` marker (stub `console.error` with `mock.fn()` for the test), function still returns `abandoned: true`. Locks in the "DB record is canonical" semantics.

The DB tests use the same `DELETE FROM tips WHERE id IN (test-ids)` cleanup pattern as the existing payroll tests, with `before`/`after` hooks at the suite level. The `__setDeps` reset happens in `afterEach`.

## Files touched

* `server/db/schema.sql`: append the two new ALTERs immediately after line 2592 (where existing `dispute_won_at` lives), keeping dispute-related columns grouped inside the Phase 2 staff-payments block.
* `server/utils/payrollDisputeNotify.js`: introduce `MAX_DISPUTE_EMAIL_ATTEMPTS = 3` and `SEND_TIMEOUT_MS = 5_000`, introduce `__setDeps` seam mirroring `sendProposalSentEmail.js:17-24`, restructure body to use `pool.connect()` + held transaction, `Promise.race`-bounded send, atomic finalization UPDATE with belt-and-suspenders `AND dispute_won_at IS NULL`, post-commit Sentry capture wrapped in try/catch with `console.error` fallback, `abandoned` field in the return shape.
* `server/utils/payrollDisputeNotify.test.js`: add the suite-wide serial-execution comment plus the new tests per the test plan above, using the `__setDeps` seam for all mocking.
* `ARCHITECTURE.md`: document the two new `tips` columns AND bring the existing tips-table description current (the pre-existing drift inherited but not introduced by this spec: `fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, and the existing `dispute_won_at` are all missing from the current doc). Include the state-machine note describing the four combinations of (`dispute_won_at`, `dispute_email_failed_at`) values. Explicitly document the **weekly admin sweep query** `SELECT id, dispute_email_failed_at FROM tips WHERE dispute_email_failed_at IS NOT NULL` as the failsafe operational practice that catches any missed Sentry alert.

## Sentry quota footprint

Worst case for a single stuck dispute (ADMIN_EMAIL unset, never fixed): 3 × `Sentry.captureException` (one per failed send attempt) + 1 × `Sentry.captureMessage` (the bailout, fired post-commit, fire-and-forget try/caught). After that, the row lock + early-return short-circuits all future Stripe redeliveries. Bound on Sentry events **per stuck dispute**: 4 events, all front-loaded over a few hours.

If many disputes go stuck at once (e.g., `ADMIN_EMAIL` globally unset for a day), the ceiling multiplies by the number of stuck disputes. Bounded but not constant; an alert tier change in Sentry is the right response to a global outage, not a code change here.

If a `captureMessage` itself fails (try/catch fires, `console.error` writes the `BAILOUT_ALERT_FAILED` marker to stderr), the Sentry count drops by 1 for that tip and the failsafe is the weekly sweep + stderr search. The DB record (`dispute_email_failed_at`) is unaffected.
