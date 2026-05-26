# Dispute-won email: retry bailout

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved, ready for implementation plan
**Source finding:** L2 from the 2026-05-25 session-review pass (commit `49e8cfd` opened this when it gated `dispute_won_at` on email success)

## Problem

`server/utils/payrollDisputeNotify.js` sends an admin email when Stripe reinstates funds on a previously-paid-out card tip, then marks `tips.dispute_won_at = NOW()` so the webhook handler never re-processes the same dispute. After commit `49e8cfd`, the mark is gated on email success: a Resend failure or an unset `ADMIN_EMAIL` leaves `dispute_won_at` null.

Stripe redelivers `charge.dispute.funds_reinstated` for up to 3 days, roughly 60 attempts with exponential backoff. Each redelivery re-runs `notifyDisputeWon`, re-fetches the tip and shift rows, re-computes per-bartender shares, and re-captures the failure to Sentry. The result is a self-DoS: a stuck env burns Sentry quota for days and never recovers without manual intervention.

## Goal

Cap the retry storm at 3 attempts. After the third failure, stop processing, leave a durable record that the notification was abandoned, and surface the abandonment loudly so an admin can react.

## Non-goals

* No SMS fallback. The `feedback_notification_cost` rule favors email over SMS; the admin reads Sentry instead.
* No admin-dashboard surface for stuck disputes. Sentry's existing alerting is the channel.
* No auto-resend if `ADMIN_EMAIL` gets set later. Once the bailout fires, that specific dispute notification is permanently abandoned; the admin reconciles manually using the Sentry payload.

## Schema

Add two columns to `tips`:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

`dispute_email_attempts` is a monotonic counter. `dispute_email_failed_at` is set exactly when the bailout fires, distinguishing "completed normally" (`dispute_won_at` set, `dispute_email_failed_at` null) from "completed by bailout" (both set).

## Logic change

`notifyDisputeWon` keeps its existing shape. The success and failure tails change.

1. Existing early return on `tip.dispute_won_at` stays. Already-completed disputes (normal or abandoned) short-circuit.
2. Existing computation (bartender shares, fee split, etc.) stays.
3. Existing send block stays. The `if (!process.env.ADMIN_EMAIL) throw` guard from commit `49e8cfd` stays inside the try, Sentry captures every failure.
4. On `emailSent === true`: `UPDATE tips SET dispute_won_at = NOW() WHERE id = $1`. The attempts counter is left alone.
5. On `emailSent === false`: atomically `UPDATE tips SET dispute_email_attempts = dispute_email_attempts + 1 WHERE id = $1 RETURNING dispute_email_attempts`. The increment is in the same statement as the read to keep concurrent webhook deliveries from racing.
6. If the returned `dispute_email_attempts >= 3`: a follow-up `UPDATE tips SET dispute_won_at = NOW(), dispute_email_failed_at = NOW() WHERE id = $1`, then `Sentry.captureMessage('Dispute-won notification permanently abandoned after retry threshold', { level: 'error', tags: { util: 'payrollDisputeNotify', step: 'max_attempts_exceeded' }, extra: { tipId, attempts } })`.
7. Function returns the same `{ bartenders, reinstatedAmountCents, netTotalCents }` shape regardless of which branch ran. Callers do not gain a new null case.

The retry-threshold constant lives at the top of the file as `const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;` so a future tuning is a one-line change.

## Race safety

Two concurrent webhook deliveries for the same tip can both reach step 5. The `UPDATE ... SET col = col + 1 ... RETURNING col` pattern ensures each delivery reads a distinct post-increment value (Postgres's row-level lock during UPDATE serializes the two transactions). At most one delivery reads exactly `3`; that one fires step 6. If a later delivery reads `4` it also enters step 6, but step 6's UPDATE is idempotent: setting two timestamps to `NOW()` twice within the same second changes nothing observable, and the duplicate Sentry message is acceptable noise compared to the cost of an extra lock.

The existing early-return on `dispute_won_at` means subsequent deliveries (those that arrive after step 6 commits) short-circuit at step 1 and never enter the failure tail.

## Tests

New or extended tests in `server/utils/payrollDisputeNotify.test.js`:

* **Success path.** Email send resolves. Verify `dispute_won_at` is set, `dispute_email_attempts` is unchanged, `dispute_email_failed_at` is null, returned object has the expected shape.
* **Single failure, attempts < threshold.** Force a send error. Verify `dispute_email_attempts` is incremented by one, `dispute_won_at` and `dispute_email_failed_at` stay null, returned object still has the expected shape.
* **Bailout trigger.** Seed `dispute_email_attempts = 2` for the test tip. Force a send error. Verify post-call `dispute_email_attempts === 3`, both `dispute_won_at` and `dispute_email_failed_at` are set, Sentry `captureMessage` was invoked exactly once with the expected tags.
* **Already-completed short-circuit.** Seed `dispute_won_at` to a past timestamp. Verify the function returns null without touching any column or sending mail (this codifies existing behavior).
* **ADMIN_EMAIL unset path.** Temporarily delete `process.env.ADMIN_EMAIL` for the test. Verify the function still increments the counter (the missing env throws inside the try, the catch captures to Sentry, the failure-tail logic runs).

Tests use `node:test` style consistent with the converted util tests from earlier in this session. The DB interactions use the same `DELETE FROM tips WHERE id = ...` cleanup pattern as the existing payroll tests.

## Files touched

* `server/db/schema.sql`: append the two new ALTERs near the existing `tips` migrations (around the Phase 2 staff-payments block).
* `server/utils/payrollDisputeNotify.js`: introduce `MAX_DISPUTE_EMAIL_ATTEMPTS`, restructure the send tail per steps 4-6.
* `server/utils/payrollDisputeNotify.test.js`: add new tests, follow node:test pattern.
* `ARCHITECTURE.md`: schema section gets the two new `tips` columns documented.
