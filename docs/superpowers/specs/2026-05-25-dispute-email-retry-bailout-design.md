# Dispute-won email: retry bailout

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (four design-fleet review folds applied), ready for implementation plan
**Source finding:** L2 from the 2026-05-25 session-review pass (commit `49e8cfd` opened this when it gated `dispute_won_at` on email success). Spec folds in findings from four design-fleet review passes on 2026-05-25 (round 1: 2 blockers + 7 warnings + 5 suggestions; round 2: 2 blockers + 6 warnings + 10 suggestions; round 3: 3 blockers + 8 warnings + 9 suggestions; round 4: 1 blocker + 6 warnings + 6 suggestions).

## Problem

`server/utils/payrollDisputeNotify.js` sends an admin email when Stripe reinstates funds on a previously-paid-out card tip, then marks `tips.dispute_won_at = NOW()` so the webhook handler never re-processes the same dispute. After commit `49e8cfd`, the mark is gated on email success: a Resend failure or an unset `ADMIN_EMAIL` leaves `dispute_won_at` null.

Stripe redelivers `charge.dispute.funds_reinstated` for up to 3 days, roughly 60 attempts with exponential backoff. Each redelivery re-runs `notifyDisputeWon`, re-fetches the tip and shift rows, re-computes per-bartender shares, and re-captures the failure to Sentry. The result is a self-DoS: a stuck env burns Sentry quota for days and never recovers without manual intervention.

## Goal

Cap the retry storm at 3 attempts. After the third failure, stop processing, leave a durable record that the notification was abandoned, and surface the abandonment loudly so an admin can react. Make every state transition atomic so two concurrent webhook deliveries cannot duplicate emails or leave the row stuck. Bound the lock-during-HTTP window so a Resend slowdown cannot starve the Postgres connection pool. The DB record (not the Sentry alert) is the canonical durable artifact of abandonment so a missed alert cannot bury the state forever.

## Non-goals

* No SMS fallback. The `feedback_notification_cost` rule favors email over SMS; the admin reads Sentry instead.
* No admin-dashboard surface for stuck disputes. The DB column + admin sweep query is the channel.
* No auto-resend if `ADMIN_EMAIL` gets set later. Once the bailout fires, that specific dispute notification is permanently abandoned by design.
* No admin-UI duplicate-payment guard. The combination of "email may deliver server-side after timeout abort" + "Sentry alert / sweep query" creates two paths to the manual adjustment form. We accept the residual risk: the runbook requires the admin to search `proposal_activity_log` by `tipId` before posting. A future enhancement could surface `dispute_email_failed_at IS NOT NULL` as a non-dismissible banner in the admin payroll UI; out of scope for this spec.
* The sweep query failsafe relies on admin discipline. Dispute reinstatement is a near-zero-frequency event in steady state; we accept that a stuck dispute can sit unreconciled until the next manual sweep rather than building a scheduled-digest emailer that depends on the same email infrastructure being broken in the failure path.

**Manual recovery runbook** (for the admin):
1. Either Sentry fires a `Dispute-won notification permanently abandoned` alert OR the weekly sweep query `SELECT id, dispute_email_failed_at FROM tips WHERE dispute_email_failed_at IS NOT NULL` surfaces a row.
2. The Sentry payload (when present) carries `tipId`, `attempts`, `reinstatedAmountCents`, `bartenderIds`, and the event date label. **`bartenderIds` is a point-in-time snapshot of the shift's approved bartenders at bailout time**; if `shift_requests` has since changed, reconcile from the Sentry payload as the authoritative set, not from a fresh roster query.
3. **Verify whether the email actually delivered** before adding adjustments. The send-timeout aborts the awaiter but does NOT cancel the in-flight Resend request, so the email may have delivered server-side after we treated it as a failure. Check the `ADMIN_EMAIL` inbox for a matching `Dispute Reinstated` email near the timestamp before paying out. If found, do not pay again.
4. **Search `proposal_activity_log` for prior adjustments referencing this tipId** before posting anything new: `SELECT id, action, details, created_at FROM proposal_activity_log WHERE details::text LIKE '%"tip_id":<tipId>%' OR details::text LIKE '%"tipId":<tipId>%' ORDER BY created_at DESC`. If a prior `payout_event` adjustment exists for the same dispute, do not duplicate.
5. Add positive adjustments on each bartender's next open payout via the existing admin payroll UI. **Verify the UI accepts adjustments for bartender IDs no longer on the current `shift_requests` roster** (status flipped to declined, request deleted, etc.); if it filters them out, the workaround is a direct DB edit or routing via a different surface.
6. No automated path exists.

## Schema

Add two columns to `tips`, anchored immediately after the existing `dispute_won_at` column at `server/db/schema.sql:2592`:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

**State machine** (documented in ARCHITECTURE.md):
* **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`.
* **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`.
* **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`.
* **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. The presence of `dispute_email_failed_at IS NOT NULL` is the canonical "needs manual reconciliation" marker.

**Migration timing.** Existing rows get `dispute_email_attempts = 0` by default. Mid-storm tips start a fresh counter and see up to 3 more attempts post-deploy. Rolling-restart is safe: old code does not reference the new columns, `DEFAULT 0` covers new-code reads.

## Logic change

`notifyDisputeWon` keeps its signature. Module-level constants:

```js
const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 10_000;
```

`SEND_TIMEOUT_MS = 10_000` (a compromise between the round-2 15s and the round-3 5s) bounds the worst-case lock-during-HTTP at 100 connection-seconds for a 10-deep pool while cushioning Resend's typical cold-handshake and regional-incident tail latencies so a slow-but-recoverable send is not bailed out as a hard failure.

**Test seam.** Add a `__setDeps` seam mirroring `server/utils/sendProposalSentEmail.js:17-24` (verified precedent uses an injectable `Sentry`):

```js
let _deps = { sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS };
function __setDeps(d) { _deps = { ..._deps, ...d }; }
module.exports = { notifyDisputeWon, __setDeps };
```

The function body uses `_deps.sendEmail(...)`, `_deps.Sentry.captureException(...)`, `_deps.Sentry.captureMessage(...)`, and `_deps.sendTimeoutMs`. Pool stays direct.

**Flow:**

1. **Open a transaction.** `const client = await pool.connect(); await client.query('BEGIN');`.
2. **Lock + re-read the tip row.** `SELECT ... FROM tips t LEFT JOIN shifts s ... LEFT JOIN proposals p ... LEFT JOIN clients c ... WHERE t.id = $1 FOR UPDATE OF t`. The `FOR UPDATE OF t` alias is required for Postgres to accept `FOR UPDATE` on the nullable side of an outer join. **Precedent:** `server/routes/drinkPlanConsult.js:144` already uses the same `FOR UPDATE OF <alias>` + LEFT JOIN pattern. Do not drop the `OF t` clause when reformatting.
3. **Early return on already-done.** `if (!tip || tip.dispute_won_at) { ROLLBACK; return null; }`.
4. **Compute bartender shares.** All queries via `client.query`. No mutating writes here. **A throw in steps 2 through 4 propagates to the outer try/catch which ROLLBACKs and re-throws.** The webhook handler at `server/routes/stripe.js:1652-1660` catches and 200-OKs the throw, so Stripe does NOT auto-retry. The tip stays in its current state until the next dispute event or manual reconciliation; Sentry sees a `captureException` from the webhook handler.
5. **Try the email send, bounded by a `Promise.race` timeout.** Pre-check `ADMIN_EMAIL`, then:
   ```js
   const sendPromise = _deps.sendEmail({
     to: process.env.ADMIN_EMAIL,
     subject: tpl.subject,
     html: tpl.html,
     text: tpl.text,
   });
   sendPromise.catch(() => {}); // suppress late unhandled rejection when the awaiter loses the race
   try {
     if (!process.env.ADMIN_EMAIL) throw new Error('ADMIN_EMAIL not set; cannot deliver dispute-won notification');
     await Promise.race([
       sendPromise,
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
   **Why `Promise.race` instead of `AbortSignal.timeout`:** `server/utils/email.js` does not accept a `signal` parameter (verified) and the Resend SDK's typed surface does not document one. `Promise.race` is a pure-userspace pattern that does not depend on a library accepting a signal.
   **Verified signature:** `_deps.sendEmail({ to, subject, html, text })` matches `server/utils/email.js:27`'s destructure exactly; `replyTo` and `attachments` are optional and unused here.
   **Important caveat:** `Promise.race` aborts the awaiter, NOT the in-flight HTTP request. Resend may deliver the email server-side after the timeout fires. The runbook addresses this (step 3). **Reassurance:** the orphaned send cannot mutate `tips` state via any back channel. The Resend webhook handler at `server/routes/emailMarketingWebhook.js` operates only on `email_sends` rows (which this notification does not insert into) and `clients.email_status`, neither of which feeds into the dispute or payout pipelines.
6. **Atomic finalization UPDATE.** Two cases:
   * **On success** (`emailSent === true`):
     ```sql
     UPDATE tips
        SET dispute_won_at = NOW(),
            dispute_email_attempts = 0
      WHERE id = $1
        AND dispute_won_at IS NULL
     ```
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
     The threshold uses `${MAX_DISPUTE_EMAIL_ATTEMPTS}` template interpolation at module load (JS-side constant, not user input). `AS bailed_out` alias must be preserved. **Future tunability**: the threshold is frozen for the process lifetime. If a future test needs a smaller threshold, plumb `maxAttempts` through `_deps`, switch the SQL to a `$N` bind parameter, and re-resolve at call time.
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
   Capturing AFTER commit means a COMMIT failure rolls back the bailout and prevents the alert from firing on state that did not persist. The try/catch around `captureMessage` handles non-crash Sentry failures by logging a distinctive stderr marker. **The canonical durable artifact of abandonment is `tips.dispute_email_failed_at`, NOT the Sentry alert.** A crash between COMMIT and `captureMessage` loses the alert but the DB state persists; the weekly sweep query catches it.
8. **Return.** `{ bartenders, reinstatedAmountCents, netTotalCents, abandoned }` where `abandoned` is `true` only on bailout. **Verified additive-safe:** the only caller is `server/routes/stripe.js:1654`, which `await`s and discards.

**Throw / rollback handling.** Any throw between BEGIN and COMMIT runs through an outer `try/catch` that calls `ROLLBACK` and re-throws to the caller. `client.release()` is in the `finally`. The email send is wrapped in its own inner `try` so a Resend failure (including the Promise.race timeout) does not bubble; the outer try/catch is only reached on unexpected DB errors or computation throws.

## Race safety

* **Threshold-crossing race.** Two concurrent deliveries at `attempts = 2`. A acquires the lock, fails its send, runs the atomic UPDATE crossing the threshold, commits. B's SELECT unblocks, sees the now-set `dispute_won_at`, short-circuits at step 3.
* **Below-threshold race.** Two concurrent deliveries at `attempts = 0`. A increments to 1 and commits. B unblocks, sees `dispute_won_at IS NULL`, runs its own send, increments to 2. End state: counter = 2, two captureException, no captureMessage.
* **Crash between increment and finalization.** Same statement now, impossible.
* **Post-commit Sentry failures.** Sync throw: try/catch logs stderr marker. Async transport failure or process crash: alert lost, DB persists, sweep catches.

## Downstream consumers

The codebase has exactly one consumer of `dispute_won_at` outside `payrollDisputeNotify.js`: the function's own short-circuit at step 3. No other route, util, or test in production code references `dispute_won_at`. Bailed-out and successfully-notified disputes are indistinguishable to current callers, which is correct semantics. Forward-looking filter `WHERE dispute_email_failed_at IS NOT NULL` covers any future surface (admin dashboard, weekly digest).

The return-shape addition (`abandoned`) is additive-safe: `server/routes/stripe.js:1654` awaits without destructuring.

## Tests

New or extended tests in `server/utils/payrollDisputeNotify.test.js` (node:test, mirroring the Jest-to-node-test conversion done earlier this session). **Add a suite-wide comment at the top of the file pinning serial execution.** This matters for both env-mutation tests AND `console.error` reassignment.

Test file imports (named explicitly so the `afterEach` reset compiles):
```js
const { test, describe, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const Sentry = require('@sentry/node');
const { notifyDisputeWon, __setDeps } = require('./payrollDisputeNotify');
```

`beforeEach` installs mocks; `afterEach` resets. Reset hardcodes the original `sendEmail`, `Sentry`, and the production `SEND_TIMEOUT_MS = 10_000`:

```js
let sendEmailMock, captureExceptionMock, captureMessageMock, consoleErrorOriginal;

beforeEach(() => {
  sendEmailMock = mock.fn(async () => ({ id: 'msg_test' }));
  captureExceptionMock = mock.fn();
  captureMessageMock = mock.fn();
  __setDeps({
    sendEmail: sendEmailMock,
    Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
    sendTimeoutMs: 100, // override for fast tests
  });
});

afterEach(() => {
  __setDeps({ sendEmail, Sentry, sendTimeoutMs: 10_000 });
  if (consoleErrorOriginal) {
    console.error = consoleErrorOriginal;
    consoleErrorOriginal = null;
  }
});
```

`console.error` stubbing uses direct reassignment (no `mock.method` precedent in the codebase): `consoleErrorOriginal = console.error; console.error = mock.fn();` in the test body, restored in `afterEach`.

Test cases:

* **Success path.** Email send resolves. Verify `dispute_won_at IS NOT NULL`, `dispute_email_attempts = 0`, `dispute_email_failed_at IS NULL`, return value `abandoned === false`, `captureMessageMock.mock.callCount() === 0`.
* **Counter reset on success after prior failure.** Seed `dispute_email_attempts = 2`, force send success, verify counter resets to 0.
* **Single failure, attempts below threshold.** Seed `dispute_email_attempts = 0`, force send reject. Verify post-call `dispute_email_attempts = 1`, both timestamps null, `captureExceptionMock.mock.callCount() === 1`, no `captureMessage`.
* **Bailout trigger.** Seed `dispute_email_attempts = 2`, force send reject. Verify `dispute_email_attempts = 3`, both timestamps set AND equal, `captureMessageMock.mock.callCount() === 1` with full payload, return `abandoned === true`.
* **ADMIN_EMAIL unset path.** Save `process.env.ADMIN_EMAIL` to a local var (check `typeof saved === 'string'` before relying on restore), `delete process.env.ADMIN_EMAIL`, run test body, restore in try/finally + afterEach hook. Verify counter increments, catch path runs.
* **Computation throw rolls back without incrementing.** Stub `pool.query` for the bartender-resolution call to reject (or inject via `__setDeps` if seam grows to expose `pool`). Verify re-throw, counter unchanged, `dispute_won_at` null, no Sentry events from inside `notifyDisputeWon`.
* **Already-completed short-circuit.** Seed `dispute_won_at` to a past timestamp. Verify return null, no UPDATE, no Sentry, no send.
* **Concurrency: bailout-trigger race.** Seed `dispute_email_attempts = 2`, two parallel calls with forced failure. Verify `dispute_email_attempts = 3`, both timestamps set and equal, `captureExceptionMock` called once, `captureMessageMock` called once.
* **Concurrency: below-threshold race.** Seed `dispute_email_attempts = 0`, two parallel calls with forced failure. Verify `dispute_email_attempts = 2`, both timestamps null, `captureExceptionMock` called twice, no `captureMessage`.
* **Send-timeout case.** Set `sendTimeoutMs = 50` via `__setDeps`, inject `sendEmail` mock that resolves after 200ms. Verify Promise.race rejects within ~50-100ms, catch path runs, `captureExceptionMock` fires with the timeout error, `dispute_email_attempts` increments by 1, wall-clock < 200ms.
* **Post-commit Sentry capture failure.** Inject `Sentry.captureMessage` mock that throws. Seed `dispute_email_attempts = 2`, force send reject (bailout). Stub `console.error` via direct reassignment (saving original first, restoring in finally + afterEach). Verify DB state committed (`dispute_won_at` and `dispute_email_failed_at` set), `console.error` called with the `BAILOUT_ALERT_FAILED` marker substring, function still returns `abandoned: true`.

DB cleanup via `DELETE FROM tips WHERE id IN (test-ids)` in `before`/`after`.

## Files touched

* `server/db/schema.sql`: append the two new ALTERs immediately after line 2592.
* `server/utils/payrollDisputeNotify.js`: introduce `MAX_DISPUTE_EMAIL_ATTEMPTS = 3` and `SEND_TIMEOUT_MS = 10_000`, introduce `__setDeps` seam, restructure to `pool.connect()` + held transaction, `Promise.race`-bounded send with orphan suppression via `.catch(() => {})`, atomic finalization UPDATE with belt-and-suspenders `AND dispute_won_at IS NULL`, post-commit Sentry capture wrapped in try/catch with `console.error` fallback, `abandoned` in return shape.
* `server/utils/payrollDisputeNotify.test.js`: add suite-wide serial-execution comment, the new tests per the test plan, the `__setDeps` reset in `afterEach`, the `console.error` reassignment pattern.
* `ARCHITECTURE.md`: under the existing `tips` table description (around lines 790-800), add the two new columns AND the five pre-existing-drift columns (`fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, `dispute_won_at`). Add a `## Operational Practices` parent section at the end of the file (or fit under the tips-table description if a flatter structure is preferred), documenting the weekly sweep query `SELECT id, dispute_email_failed_at FROM tips WHERE dispute_email_failed_at IS NOT NULL` as the canonical failsafe for missed Sentry alerts. Include the state-machine note describing the four combinations of `(dispute_won_at, dispute_email_failed_at)`.
* `README.md`: add a brief subsection under an existing Operations or Maintenance area (or create `## Operational Runbook` if none) noting the weekly sweep practice and pointing readers at ARCHITECTURE.md for the exact query. This is the durable reminder hook so the failsafe is not buried only in architecture docs.

## Sentry quota footprint

Worst case per stuck dispute (ADMIN_EMAIL unset, never fixed): 3 × `Sentry.captureException` (per failed send) + 1 × `Sentry.captureMessage` (the bailout, post-commit, try/caught). After that, the row lock + early-return short-circuits all future Stripe redeliveries. **Bound per stuck dispute: 4 events**, front-loaded over a few hours.

If many disputes go stuck at once (e.g., global `ADMIN_EMAIL` outage), the ceiling multiplies per stuck dispute. An alert tier change in Sentry is the right response to a global outage; no code change here.

**On Sentry SDK failure** (when the try/catch around `captureMessage` fires), the `BAILOUT_ALERT_FAILED` stderr marker is searchable only within Render's log retention window (7-day default, no built-in substring alerting). `server/index.js` initializes Sentry WITHOUT the `captureConsole` integration, so stderr is not auto-forwarded to Sentry. **The DB sweep query is the canonical recovery channel** for this case; the stderr marker is supplemental log archaeology, not a primary alert.
