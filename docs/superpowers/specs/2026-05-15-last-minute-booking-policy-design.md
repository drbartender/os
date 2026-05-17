# Last-Minute Booking Policy — Design

**Date:** 2026-05-15
**Status:** Approved (brainstorm), pending implementation plan
**Risk:** High — crosses schema → server money gate → Stripe webhook → client UI → notifications. Real money + staffing commitments at stake.

## Problem

Today a client can book any event with a **$100 deposit** (optionally autopay the balance), regardless of how close the event is. Two failures result:

1. **Deposit booking inside the balance window.** `balance_due_date` is already `event_date − 14 days`. A deposit-only booking made *inside* 14 days has a balance that is immediately past-due — the autopay scheduler either fires instantly or the balance silently sits unpaid. Nothing prevents this.
2. **No brake on last-minute bookings.** A client can book an event a day or two out and the system instantly promises a slot (spawns an `open` shift + "you're all set" email) with zero check that we can actually staff it. Real case: **Ketan Patel, proposal #54** — booked last-minute, painful to staff, nothing flagged it.

## The Tier Model

Three tiers, by lead time to the event start datetime. Tiers are nested: `last_minute_hold ⊂ full_payment_required`.

| Lead time to event | Payment | Booking outcome |
|---|---|---|
| **> 14 days** | Deposit **or** pay-in-full (+ optional autopay) — *unchanged* | Confirmed normally |
| **≤ 14 days, > 72h** | Pay-in-full **required** (deposit option removed) | Confirmed normally |
| **≤ 72h** | Pay-in-full **required** | **Hold**: charged immediately, booking provisional pending staff verification; client warned it may be cancelled; admin + staff SMS-blasted |

## Boundary Semantics

A single pure helper is the source of truth: **`server/utils/bookingWindow.js`** (no DB, unit-testable, same shape as `pricingEngine.js`):

```
getBookingWindow({ eventDate, eventStartTime, now = new Date() }) →
  { hoursUntilEvent, fullPaymentRequired, lastMinuteHold }
```

- **Anchor:** event start datetime = `event_date` + `event_start_time`. If `event_start_time` is null, treat as `00:00` of `event_date` — the conservative direction (earlier instant → classifies *more* urgent → safer for both money and staffing).
- `fullPaymentRequired = hoursUntilEvent ≤ 336` (14 days — the exact window already backing `balance_due_date`).
- `lastMinuteHold = hoursUntilEvent ≤ 72`.
- **UTC math**, consistent with existing date code (`setUTCDate`, `toLocaleDateString({ timeZone: 'UTC' })`). No per-venue timezone — near-midnight edges may be off by a few hours. Accepted: matches the rest of the system; introducing tz infra is out of scope (YAGNI).

**The server is the only thing that computes this. The client never re-derives date math** — this avoids the dual-maintenance trap that `eventTypes.js` (ESM/CJS hand-synced) demonstrates.

## Server Enforcement (the hard gate)

`POST /api/stripe/create-intent/:token` (`server/routes/stripe.js:~99`):

1. Add `event_start_time` to the proposal SELECT (it already selects `event_date`).
2. Compute `getBookingWindow(...)`.
3. If `fullPaymentRequired && payment_option !== 'full'` → **reject** with a client-visible `ConflictError` / code `FULL_PAYMENT_REQUIRED`, message: *"This event is within 2 weeks — full payment is required to book."*

**Reject, never silently coerce.** A client expecting a $100 charge must never be quietly charged the full total. The UI will already only offer "full" in these tiers; this is the backstop against a stale client or a direct API hit.

This gate covers the **client self-service** booking entry point (`create-intent`). Admin-generated Stripe payment links are admin-mediated and intentionally **not** gated (consistent with the admin-path non-goal below). Balance / drink-plan / invoice intents are post-conversion and can never be an initial ≤14-day booking.

**Why this is money-clean:** full payment → webhook sets `status='balance_paid'` directly. The autopay scheduler only ever claims `status='deposit_paid'` (`server/utils/balanceScheduler.js:37`), so forcing full *automatically* sidesteps the past-due-balance problem. The Stripe charge code, `balance_due_date` COALESCE, and the autopay scheduler are **untouched**.

## Schema

One idempotent column in the proposals block of `server/db/schema.sql` (near the existing `payment_type` / `deposit_amount` adds, ~line 884):

```sql
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS last_minute_hold BOOLEAN DEFAULT false;
```

**No new `status` enum value** — the working state machine stays exactly as-is. The flag is purely operational: drives the admin badge, the client warning, and serves as the idempotency anchor for the SMS blast.

## Conversion-Time Behavior (Stripe webhook)

In `payment_intent.succeeded` (`server/routes/stripe.js:~668`), inside the **existing `isFirstDelivery` guard** (already idempotent against Stripe's webhook retries), for the initial-booking payment branch (`full`; the `deposit` branch is covered defensively for completeness, though the server gate makes a ≤14-day deposit impossible — `balance` / `drink_plan_*` / `invoice` are post-conversion and out of scope here):

- Compute the window from the proposal row. If `lastMinuteHold` → `UPDATE proposals SET last_minute_hold = true`.
- **Everything else runs unchanged** — `createEventShifts` still spawns the normal `open` shift + drink plan + drink-plan email exactly as today.
- **After commit**, alongside the existing post-commit side-effects, fire the SMS blast — non-blocking, try/catch + Sentry, same pattern as the existing payment-notification emails. `isFirstDelivery` guarantees once-per-payment (no double-blast on webhook retry).

### SMS blast

Uses the **correct** `sendSMS({ to, body })` signature (`server/utils/sms.js:16`).

- **Admin** → new `ADMIN_PHONE` env var: *"⚠️ Last-minute booking: {event} {date} {time} — {location}. Verify staffing now. {adminUrl}"*. If `ADMIN_PHONE` unset → skipped + logged; staff blast still fires.
- **Staff, broad net** → every user with `onboarding_status='approved'` and a non-null `contractor_profiles.phone`, normalized via `normalizePhone`, sent **sequentially** (Twilio throttle, same as `autoAssign`): *"Last-minute gig {date} {time}, {location} ({event}). Open the app to grab it ASAP — Dr. Bartender"*. Volume bounded — ≤72h bookings are exception-only.

> **Out of scope (pre-existing bug, do NOT fix here):** `server/utils/autoAssign.js:317` calls `sendSMS(phone, msg)` with a wrong *positional* signature against the object-arg `sendSMS({ to, body })`. New code uses the correct signature. Flag only.

> **Cost note:** SMS contradicts the standing email-over-SMS default, but a ≤72h booking is the urgent, rare, exception-only case where SMS is explicitly justified. Deliberate exception, not a contradiction.

## Client Warning — shown BEFORE payment

Because the card is charged immediately, the client must consent to the cancellation risk *before* the charge, not learn of it after.

On the proposal page, when `last_minute_hold`, a notice sits directly above the pay button:

> *"Heads up — because this event is less than 72 hours away, your booking is confirmed subject to staff availability. In the rare case we can't staff it in time, we'll cancel and fully refund you."*

It is also appended as a conditional block to the two first-payment client email templates — `signedAndPaidClient` and `paymentReceivedClient` (`server/utils/emailTemplates.js`). Additive, copy-only, no logic change.

## Client UI Changes

`client/src/pages/proposal/proposalView/ProposalView.js` reads the new `proposal.payment_policy` and passes `fullPaymentRequired` / `lastMinuteHold` props into `SignAndPaySection` (both `signAndPay` and `payOnly` modes render the tablets):

- `fullPaymentRequired` → default `paymentOption='full'`; do **not** render the Deposit `PaymentTablet` or the autopay checkbox. Notice: *"Because your event is within 2 weeks, full payment is required to confirm your booking."*
- `lastMinuteHold` → additionally render the cancellation-consent warning (copy above) directly above the pay button.

## Admin Resolution

The hold is informational. Admin works the shift with the existing staffing tools.

- A **"Last-minute — verify staffing"** badge appears on the proposal/event detail, driven by `last_minute_hold`.
- When the linked shift becomes **fully staffed** — approved `shift_requests` count ≥ `positions_needed` length, the same definition `autoAssign` uses for `slotsRemaining` — via the existing approve/assign handlers (`server/routes/shifts.js`), clear `last_minute_hold = false` (small hook in the approval path). **No extra client email on clear** — messaging stays the same; the client already received the normal confirmation + the caveat.

## Cancel / Refund — deliberately manual

If staffing genuinely fails, admin cancels via the **existing** proposal-cancel path and issues the refund **by hand in the Stripe dashboard**.

No automated refund money-code is built for this rare exception path — this is the protect-the-working-money-paths call. An automated refund action is an explicit **non-goal / future item**.

## Non-Goals & Assumptions

- No new proposal `status` enum value — boolean flag only.
- No per-venue timezone; UTC math consistent with existing system; near-midnight imprecision accepted.
- **Admin-created / admin-converted bookings** (the direct `createEventShifts` path in `server/routes/proposals/crud.js`) are **not** gated — admin knows the staffing situation. The rule applies to **client self-service checkout only**.
- No hard "too late to book online" floor — any lead time can book; ≤72h just adds the hold.
- Geo-filtered staff notification: rejected by decision (broad net).
- Autopay scheduler, `balance_due_date`, the Stripe charge path: untouched.
- Automated refund: out of scope.

## Files Touched

| File | Change |
|---|---|
| `server/utils/bookingWindow.js` | **New.** Pure helper — the source of truth. |
| `server/db/schema.sql` | `+ last_minute_hold BOOLEAN DEFAULT false` (idempotent). |
| `server/routes/stripe.js` | Gate in `create-intent`; set `last_minute_hold` + SMS blast in webhook. |
| `server/routes/proposals/publicToken.js` | Add `payment_policy` to `GET /t/:token` response. |
| `server/utils/emailTemplates.js` | Conditional warning block in `signedAndPaidClient` + `paymentReceivedClient`. |
| `server/routes/shifts.js` | Clear `last_minute_hold` when linked shift fully staffed. |
| `client/src/pages/proposal/proposalView/ProposalView.js` | Read `payment_policy`, pass props. |
| `client/src/pages/proposal/proposalView/SignAndPaySection.js` | Hide deposit/autopay when full required; render warning. |
| Admin proposal/event detail | "Last-minute — verify staffing" badge. |
| `CLAUDE.md`, `.env.example` | Document `ADMIN_PHONE`. |
| `ARCHITECTURE.md` | Mention `bookingWindow.js`; note booking-window policy. |

## Testing Strategy

- **Unit:** `bookingWindow.js` — boundary cases at exactly 72h, 14d, null `event_start_time`, past events, far-future events, near-midnight UTC edges.
- **Server gate:** deposit attempt inside 14 days → `FULL_PAYMENT_REQUIRED`; full payment inside 14 days → allowed; deposit > 14 days → still allowed.
- **Webhook:** ≤72h full payment → `last_minute_hold=true`, SMS blast fires once; webhook retry → no second blast (idempotency); >72h → no flag, no blast.
- **UI:** > 14d shows deposit+full; ≤14d hides deposit; ≤72h shows the cancellation warning above the pay button.
- **Resolution:** fully staffing the linked shift clears `last_minute_hold`.
