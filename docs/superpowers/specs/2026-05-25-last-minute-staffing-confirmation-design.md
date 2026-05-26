# Last-Minute Staffing Confirmation (Touch 2.2)

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (brainstorm), ready for implementation plan
**Source:** Comms spec `2026-05-20-automated-communication-design.md` § 2.2 (Stage 2 touch); Phase 5 in the spec's phasing, unblocked now that the last-minute booking policy has shipped.
**Risk:** Low. Touches one new helper, one renamed function, two new templates. No money path, no auth path. Failure mode is a missed notification, not a wrong charge.

## Problem

Clients who book inside the 72-hour staffing-hold window currently learn who their bartender is at T-24h via the event-eve SMS (touch 3.7). For a booking made 36 hours out, that's only 12 hours of advance notice (and for a 6-hour-out booking, none at all). Two real costs:

1. **Trust gap on the riskiest bookings.** The client just consented to "subject to staff availability, we may cancel" (the policy banner shipped with the booking gate). Silence until T-24h leaves them in limbo for as long as it takes us to staff it.
2. **No direct line.** The client has no bartender contact until the day-of, so anything time-sensitive (parking, gate codes, setup access) routes through Dallas.

The comms spec § 2.2 already defines the touch and locks the copy. The work is wiring it into today's assignment paths.

## Goal

Fire one client email + one client SMS, both with bartender name(s) and phone(s), the moment a `last_minute_hold = true` proposal's shift becomes fully staffed. One-shot per proposal, regardless of which of the three assignment paths fills the last slot.

## Non-goals

* Not a notification for non-last-minute bookings. Normal-lead-time clients keep getting the event-eve SMS at T-24h; that path is untouched.
* No new client UI. The trigger is server-side, the surface is the inbox / SMS thread.
* No automated "we couldn't staff it" cancellation message. The booking-policy spec already accepts that admin handles failed staffing manually.
* No retry / dead-letter queue. If Resend or Twilio fails after the flag flip, the notification is lost. Logged + Sentry, but never re-fired. Reverting the flag would risk double-sends, and double-sends on a "your bartender is X" message are worse than a missed one.
* No new `scheduled_messages` row. This is an immediate event-driven send, same shape as the existing sign+pay orientation send.

## The trigger

The existing helper `server/routes/shifts.js:829` (`clearHoldIfFullyStaffed(shiftId)`) is the natural anchor. It already runs on the two manual assignment paths and checks the "fully staffed" condition. Three changes:

1. **Rename** `clearHoldIfFullyStaffed` to `confirmStaffingIfFullyStaffed`. New name reflects both roles (clear the hold AND notify the client).
2. **Atomic flip becomes the one-shot guard.** Replace today's unconditional `UPDATE proposals SET last_minute_hold = false WHERE id = $1 AND last_minute_hold = true` with the same query plus `RETURNING id`. If a row comes back, *this caller* is the unique owner of the flip and is responsible for firing the notification. If zero rows, the hold was already cleared (by an earlier concurrent fill, or the proposal was never held) and the notify path is skipped. No new column, no extra row, no race.
3. **Close the auto-assign gap.** `server/utils/autoAssign.js:307` approves shift_requests in batch but never calls `clearHoldIfFullyStaffed`. Today this means auto-assigned last-minute bookings never clear the hold (admin sees the badge until they manually re-touch the proposal). Add one `await confirmStaffingIfFullyStaffed(shiftId)` call after the approve loop (just before the `auto_assigned_at` UPDATE at line 346). This bug-fix and Touch 2.2 share the same fix.

The notify call lives inside `confirmStaffingIfFullyStaffed`, conditionally on the flip succeeding. The three call sites stay clean: each just awaits `confirmStaffingIfFullyStaffed(shiftId)` in a try/catch (existing pattern), and the helper handles the rest.

## The notify function

New module `server/utils/lastMinuteStaffingConfirmation.js`, sibling to the shipped `lastMinuteAlert.js`. Exports `notifyClientOfStaffingConfirmation(proposalId)`.

Behavior, in order:

1. Load proposal + client + every approved bartender for the proposal's shift:
   ```sql
   SELECT p.id, p.event_date, p.event_start_time, p.event_type, p.event_type_custom, p.status,
          c.id AS client_id, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
          c.communication_preferences, c.email_status, c.phone_status
     FROM proposals p
     JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
   ```
   If `status = 'archived'`, return immediately. The archive case is the only post-flip suppression check.

2. Load bartenders:
   ```sql
   SELECT u.id, u.first_name, u.last_name, cp.preferred_name, cp.phone
     FROM shifts s
     JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved'
     JOIN users u ON u.id = sr.user_id
     LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE s.proposal_id = $1
    ORDER BY sr.id ASC
   ```
   Display name per bartender: `preferred_name || first_name`. Phone via `normalizePhone(cp.phone)`; null is acceptable (template renders the name without parens).

3. Render email + SMS bodies (see Templates below).

4. Email send, independently gated:
   ```js
   const emailOk = shouldSendImmediate({ proposal, client, channel: 'email' });
   if (emailOk.ok) await sendEmail({ to: client.email, subject, html, text, replyTo: ADMIN_EMAIL });
   ```
   On failure: log + `Sentry.captureException` with `{ tags: { feature: 'last-minute-staffing-confirmation', channel: 'email', proposalId } }`. Do not throw (best-effort).

5. SMS send, independently gated:
   ```js
   const smsOk = shouldSendImmediate({ proposal, client, channel: 'sms' });
   if (smsOk.ok) await sendAndLogSms({ to: client.phone, body, clientId, messageType: 'last_minute_staffing_confirmation', recipientName: client.name });
   ```
   Same failure handling. Email and SMS are independent: a STOP-keyword that disables SMS does not block the email.

The outer caller (`confirmStaffingIfFullyStaffed`) already wraps in try/catch, so `notifyClientOfStaffingConfirmation` is allowed to throw on a truly unexpected error (e.g., the proposal got hard-deleted between the flip and the load). That throws bubble to Sentry via the existing wrapper.

## Templates

Spec copy verbatim (§ 2.2). Em dashes excluded per the project copy rule. Pluralizer below covers 1/2/3+ bartenders and missing-phone cases.

### SMS: `lastMinuteStaffingConfirmationSms` in `server/utils/smsTemplates.js`

```js
function lastMinuteStaffingConfirmationSms({ eventDate, bartenders }) {
  const list = renderBartendersInline(bartenders); // see below
  const verb = bartenders.length === 1 ? 'is' : 'are';
  const noun = bartenders.length === 1 ? 'bartender' : 'bartenders';
  return `Hi, Dallas here. Your ${noun} for ${eventDate} ${verb} ${list}. They'll reach out the day of the event. Let me know if you have any questions.`;
}
```

`renderBartendersInline([{ name, phone }])`:
* 1: `"Alex (312-555-1234)"` (or `"Alex"` if phone missing)
* 2: `"Alex (312-555-1234) and Jordan (312-555-5678)"`
* 3+: `"Alex (...), Jordan (...), and Sam (...)"` (Oxford comma)

### Email: `lastMinuteStaffingConfirmation` in `server/utils/lifecycleEmailTemplates.js`

Subject: `Your bartender for [event_date]` (singular regardless of count, matches the spec).

Body, with the same pluralizer:

```
Your [noun] for [event_date] [verb] [list]. They'll be in touch the day of the event.

Let me know if you have any questions or need any changes.

Cheers, Dallas
```

`eventDate` is rendered via the existing `eventDateLong` helper (matches sibling templates). Wrapped in the standard `wrapEmail` chrome.

## Suppression and edge handling

* **Proposal archived between flip and send.** The notify fn checks `status = 'archived'` after loading the proposal row and returns without sending. The flag flip stays (correct, the hold no longer matters).
* **Client SMS disabled (STOP keyword, opt-out, `phone_status = 'bad'`).** `shouldSendImmediate({ channel: 'sms' })` returns `{ ok: false }`. Email still fires.
* **Client email disabled (`email_status = 'bad'`).** Email skipped, SMS still fires.
* **Both channels suppressed.** Nothing sends. The flip already cleared the hold, which is the correct system state regardless of whether the client was notifiable. Admin can communicate via the existing manual channels.
* **Bartender phone missing (null `contractor_profiles.phone` or unparseable).** That bartender renders as the name only (`"Alex"`). If every bartender lacks a phone, the message still goes out with just names (strictly better than today's nothing).
* **Multi-shift proposal.** Today's `clearHoldIfFullyStaffed` operates per-shift (the helper takes a `shiftId`). If a proposal has multiple shifts and the first one to be filled triggers the flip, the notification fires with whatever bartenders are approved on *that* shift. This matches the booking-policy spec's "the linked shift" framing and is the conservative direction (client gets the info as early as possible; the other shift's bartender(s) still appear in the event-eve SMS at T-24h).
* **Send failure after flip.** Logged + Sentry. Not re-fired. Reverting the flag would risk double-sends, and a duplicate "your bartender is X" message on retry is worse than a single miss.

## Files touched

| File | Change |
|---|---|
| `server/routes/shifts.js` | Rename `clearHoldIfFullyStaffed` → `confirmStaffingIfFullyStaffed`. Add `RETURNING id` to the UPDATE. If a row returns, await `notifyClientOfStaffingConfirmation(proposalId)` inside an inner try/catch. Two existing call sites stay (just renamed). |
| `server/utils/autoAssign.js` | Add `await confirmStaffingIfFullyStaffed(shiftId)` after the approve loop (after line 309, before the `auto_assigned_at` UPDATE at line 346). Wrap in try/catch + Sentry (matches the sibling `scheduleStaffShiftMessages` pattern at line 353). |
| `server/utils/lastMinuteStaffingConfirmation.js` | **New.** `notifyClientOfStaffingConfirmation(proposalId)` plus its pluralizer helpers. ~120 lines. |
| `server/utils/lastMinuteStaffingConfirmation.test.js` | **New.** Unit tests for pluralization (1/2/3+, missing phones), archived-proposal short-circuit, suppression-gated channels. |
| `server/utils/lifecycleEmailTemplates.js` | Add `lastMinuteStaffingConfirmation` template. |
| `server/utils/lifecycleEmailTemplates.test.js` | Render-shape tests for the new template. |
| `server/utils/smsTemplates.js` | Add `lastMinuteStaffingConfirmationSms`. |
| `server/utils/smsTemplates.test.js` | Render-shape tests, plus the no-em-dash assertion already used by sibling SMS tests. |
| `ARCHITECTURE.md` | One-line entry under the comms / scheduled-messages section: "Touch 2.2 last-minute staffing confirmation: immediate send on the atomic flip of `last_minute_hold` true→false." |

No schema change. No env-var change. No new route.

## Testing strategy

* **Pluralizer unit tests.** 1 bartender / 2 / 3 / 4 (Oxford comma); each variant with all-phones, no-phones, mixed.
* **Notify-fn unit tests.** Archived proposal short-circuits before any send. Email-disabled client gets SMS only. SMS-disabled client gets email only. Both-disabled sends nothing. Bartender query returns zero rows (somehow flip raced past a manual removal) skips the send.
* **Atomic-flip race test.** Run two concurrent `confirmStaffingIfFullyStaffed(shiftId)` calls against the same shift. Assert: the bartender notify ran exactly once. (The DB-level `WHERE last_minute_hold = true` clause is the guarantee; the test pins the contract.)
* **Auto-assign integration.** Set up a held proposal with a shift, run the auto-assign path, assert `last_minute_hold = false` and that the notify fn was called with the right `proposalId`.
* **Non-held proposals see no behavior change.** Existing two-call-site behavior for normal-lead-time bookings is unchanged (the flip returns zero rows, the notify skips).

## Out of scope (explicit deferrals)

* Touch 2.2's spec note "Proposal archived" as a suppression condition is honored via the post-flip status check. Other suppression categories (e.g., a per-proposal "do not contact" override) are not introduced.
* The event-eve SMS (touch 3.7) is untouched. Last-minute bookings receive both messages (Touch 2.2 immediately, plus the standard T-24h SMS) by design. The T-24h message is short and useful even on top of Touch 2.2 (different timing, different framing).
* No backfill for in-flight proposals stuck with `last_minute_hold = true` that pre-date this change. Volume is low enough (last-minute bookings are exception-only) that admin can manually clear via the existing badge / staffing tools if any are observed.
