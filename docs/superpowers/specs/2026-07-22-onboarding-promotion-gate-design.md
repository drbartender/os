# Onboarding promotion gate (close the self-service path to `approved`)

Date: 2026-07-22
Status: approved by Dallas ("your rec"), 2026-07-22
Trigger: found by the lane-1 review fleet on [staff event details](2026-07-22-staff-event-details-design.md). Live in production; not introduced by that lane, but that lane widens what it yields.

## Problem

`requireOnboarded` is the gate that means "this account is really one of our staff". It does not currently mean that.

1. `POST /api/auth/register` is public (`server/routes/auth.js:44`, `authLimiter` only) and inserts with the schema defaults `role='staff'`, `onboarding_status='in_progress'`, returning a live 7-day JWT.
2. `POST /api/payment` (`server/routes/payment.js:45`) is gated by `auth` ALONE, and ends in `UPDATE users SET onboarding_status='approved' WHERE id=$1 AND onboarding_status IN ('hired','in_progress','submitted','reviewed')` (`payment.js:153`).
3. Its preconditions are trivial: `preferred_payment_method` has no whitelist (pick one needing no handle), and the W-9 passes on four magic bytes (any PDF).

So: register, then one more call, and the account is `approved`. That clears `requireOnboarded` and every surface behind it.

Verified: nothing self-service writes `submitted` or `reviewed` (only the admin status-change route in `admin/users.js`), so this promotion is the ONLY self-service route into a `requireOnboarded`-passing status. Closing it closes the class.

## Root cause

`onboarding_status = 'in_progress'` carries two unrelated meanings:

- **(a) self-registered, has not applied yet** — the public default, and the required precondition for `POST /application` (`application.js:160`).
- **(b) admin moved them past the interview** — the `interviewing -> in_progress` transition on the admin-only move route (`admin/applications.js:390`), commented "== onboarding".

`payment.js` promotes from `in_progress` because of meaning (b). Meaning (a) rides along for free.

## Fix

Promote from `in_progress` only when the user has an `applications` row:

```sql
UPDATE users SET onboarding_status='approved'
 WHERE id=$1
   AND ( onboarding_status IN ('hired','submitted','reviewed')
      OR ( onboarding_status = 'in_progress'
           AND EXISTS (SELECT 1 FROM applications a WHERE a.user_id = $1) ) )
```

An applications row is **unforgeable proof of meaning (b)**, and this is the load-bearing argument: `POST /application` requires status `in_progress` and, in the SAME transaction (`BEGIN` + `SELECT … FOR UPDATE` at `application.js:132-168`, `COMMIT` at `:239`), writes the status to `applied` or `hired`. There is therefore no way to hold an applications row while still being `in_progress` except by having been moved back down, and the only route that does that is admin-only. Reaching `in_progress` WITH an application means an admin advanced you.

`hired`, `submitted`, `reviewed` are unchanged: all three are admin-conferred or import-set.

## Alternatives rejected

- **Split `in_progress` into two statuses** (the original recommendation). Equivalent security, materially more blast radius: the public default status is read by the client router (`Login.js:42`, `userRoutes.js:65`, `App.js:304/316`), the application-submit gate, the admin staff list, the applications list, and the global-search label map. It also needs an ambiguous backfill for existing rows, which the applications-row test would have to resolve anyway. Same answer, more surface.
- **Accept `pre_hired = true` as evidence.** Rejected: `POST /api/auth/register-pre-hired` is public by design (see Residual), so `pre_hired` is self-assertable and proves nothing.

## Production impact (verified read-only against the `production` branch)

- **Zero** `in_progress` users hold an applications row, so the new predicate changes the outcome for every current `in_progress` account.
- Those accounts are 8 total and none is a live onboarding: ids 20, 21, 204, 209, 210, 213, 214 have no payment profile, no contractor profile, no shift requests and no payout lines (abandoned registrations); id 237 is `import_source='payment_history_import'` (a CC import stub).
- 33 `hired` users hold no application — the payment-import staff. They promote from `hired`, which this change does not touch.
- Net: nobody mid-onboarding is stranded.

A genuine future pre-hire is unaffected: `PreHireOnboarding` routes any status outside `hired|submitted|reviewed|approved` to `/apply` (`PreHireOnboarding.js:37-40`), and submitting the application sets `hired` for a pre-hired user, so they reach payment already promotable.

## Residual, surfaced not fixed

`POST /api/auth/register-pre-hired` is public with no allowlist, by design: the schema comment (`schema.sql:27-33`) documents pre-hires registering through "the open /onboarding URL" to skip admin review. Consequence: anyone who has the URL can self-serve to `hired` by completing the full application form, and `hired` promotes to `approved`. That is Dallas's deliberate hiring tradeoff, not a defect, and it costs the attacker a complete application plus a visible application record and contractor profile in the admin. It is called out here so the tradeoff is a decision rather than a surprise. Options if it ever needs tightening: an invite token on the URL, an admin email allowlist checked at `register-pre-hired`, or holding pre-hires at `applied` for a one-click admin confirm.

## Testing

New cases in a `payment.js` route suite: an `in_progress` user with NO application is NOT promoted (status unchanged, no 500); an `in_progress` user WITH an application IS promoted; `hired` / `submitted` / `reviewed` still promote; `approved` stays idempotent. Existing payment suites stay green.

## Docs

ARCHITECTURE.md payment route row gains the promotion predicate; the `users.onboarding_status` schema note records that `in_progress` is ambiguous by construction and what disambiguates it.
