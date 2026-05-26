# Last-Minute Staffing Confirmation (Touch 2.2)

**Date:** 2026-05-25
**Spec owner:** Dr. Bartender
**Status:** Approved (brainstorm + fleet review v2), ready for implementation plan
**Source:** Comms spec `2026-05-20-automated-communication-design.md` § 2.2 (Stage 2 touch); Phase 5 in the spec's phasing, unblocked now that the last-minute booking policy has shipped.
**Risk:** Low. Touches one new helper, one renamed function, two new templates, one tiny `rescheduleProposal.js` hook. No money path, no auth path. Failure mode is a missed notification, not a wrong charge.

## Problem

Clients who book inside the 72-hour staffing-hold window currently learn who their bartender is at T-24h via the event-eve SMS (touch 3.7). For a booking made 36 hours out, that's only 12 hours of advance notice; for a 6-hour-out booking, none at all. Two real costs:

1. **Trust gap on the riskiest bookings.** The client just consented to "subject to staff availability, we may cancel" (the policy banner shipped with the booking gate). Silence until T-24h leaves them in limbo for as long as it takes us to staff it.
2. **No direct line.** The client has no bartender contact until day-of, so anything time-sensitive (parking, gate codes, setup access) routes through Dallas.

The comms spec § 2.2 already defines the touch and locks the copy. The work is wiring it into today's assignment paths.

## Goal

Fire one client email + one client SMS, both with bartender name(s) and phone(s), the moment a `last_minute_hold = true` proposal's shift becomes fully staffed. One-shot per proposal, regardless of which of the three assignment paths fills the last slot.

## Non-goals

* Not a notification for non-last-minute bookings. Normal-lead-time clients keep getting the event-eve SMS at T-24h; that path is untouched.
* No new client UI. The trigger is server-side, the surface is the inbox / SMS thread.
* No automated "we couldn't staff it" cancellation message. The booking-policy spec already accepts that admin handles failed staffing manually.
* No retry / dead-letter queue. If Resend or Twilio fails after the flag flip, the notification is lost. Logged + Sentry, but never re-fired. Reverting the flag would risk double-sends, and double-sends on a "your bartender is X" message are worse than a missed one.
* No new `scheduled_messages` row. This is an immediate event-driven send, same shape as the existing sign+pay orientation send.
* No refactor to relocate `formatPhoneDisplay` (currently in `server/utils/globalSearch.js`) to a shared `phone.js`. The notify module imports it from its current home; the move is a future cleanup.

## The trigger

The existing helper `server/routes/shifts.js:829` (`clearHoldIfFullyStaffed(shiftId)`) is the natural anchor. It already runs on the two manual assignment paths and checks the "fully staffed" condition. Four changes:

1. **Rename** `clearHoldIfFullyStaffed` to `confirmStaffingIfFullyStaffed`. New name reflects both roles (clear the hold AND notify the client). A grep across the repo confirms three code references today: the definition in `shifts.js`, the call at `shifts.js:669`, and the call at `shifts.js:786`. The rename also updates the literal string in the outer catch's `console.error('[shifts] clearHoldIfFullyStaffed failed (non-blocking):', e.message)` at `shifts.js:855` so debug logs stay congruent with the symbol name. No test file or other consumer holds a stale reference, so the rename is a closed change set.
2. **Atomic flip becomes the one-shot guard.** Replace today's unconditional `UPDATE proposals SET last_minute_hold = false WHERE id = $1 AND last_minute_hold = true` with the same query plus `RETURNING id`. If a row comes back, *this caller* is the unique owner of the flip and is responsible for firing the notification. If zero rows, the hold was already cleared (by an earlier concurrent fill, or the proposal was never held) and the notify path is skipped. No new column, no extra row, no race. `proposalId` is in hand from the existing `SELECT proposal_id, positions_needed FROM shifts WHERE id = $1` at `shifts.js:831-833` and passed straight into `notifyClientOfStaffingConfirmation(proposalId, shiftId)`; the `RETURNING id` is a guard, not a value source.
3. **Close the auto-assign gap.** `server/utils/autoAssign.js:307` approves shift_requests in batch but never calls `clearHoldIfFullyStaffed`. Today this means auto-assigned last-minute bookings never clear the hold (admin sees the badge until they manually re-touch the proposal). Add one `await confirmStaffingIfFullyStaffed(shiftId)` call after the approve loop, just before the `auto_assigned_at` UPDATE at line 346. This bug-fix and Touch 2.2 share the same fix.
4. **Reschedule re-evaluation.** The canonical reschedule path is the proposal `PATCH` handler at `server/routes/proposals/crud.js:551-583`, which `UPDATE`s `event_date`/`event_start_time` then calls `rescheduleProposalInTx(dbClient, { proposalId, old, updated })` at `crud.js:617-626` in the same transaction. The hook goes inside `rescheduleProposalInTx` (`server/utils/rescheduleProposal.js`) after the existing balance-due-date and scheduled_messages cascade work, using `updated` (the post-UPDATE row) as the source for the new `event_date`/`event_start_time`. Compute `getBookingWindow(...)` from `updated`, and if `updated.last_minute_hold !== lastMinuteHold` issue `UPDATE proposals SET last_minute_hold = $1 WHERE id = $2` via the same `dbClient`. Two scenarios:
   * Held proposal rescheduled past 72h → `last_minute_hold` becomes false. No notification fires (the next staffing-fill is no longer a "last-minute" confirmation; the standard T-24h event-eve SMS still informs the client).
   * Non-held proposal rescheduled into 72h → `last_minute_hold` becomes true. The next staffing-fill flips the flag back to false and fires the notification as normal.

   `rescheduleProposal()` (the non-`InTx` wrapper) is exercised only by tests; production traffic always lands via `rescheduleProposalInTx` from the PATCH handler. Placing the hook inside the `InTx` variant covers production and lets the test wrapper continue to work.

**Call-site discipline (PIN).** All three call sites (`shifts.js:669`, `shifts.js:786`, the new autoAssign.js insertion) unconditionally `await confirmStaffingIfFullyStaffed(shiftId)`. The helper itself is the only gate. **Do not add an upstream `WHERE last_minute_hold = true` filter at any call site.** Doing so would silently regress the auto-assign clear-hold bugfix this spec bundles in.

The notify call lives inside `confirmStaffingIfFullyStaffed`, conditionally on the flip succeeding. The three call sites stay clean: each just awaits `confirmStaffingIfFullyStaffed(shiftId)` in a try/catch (existing pattern), and the helper handles the rest.

**Outer try/catch must surface failures.** Today's helper at `shifts.js:854` swallows errors with `console.error` only. Mirror the `lastMinuteAlert.js:67-71` pattern: `console.error` + `if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { feature: 'staffing-confirmation' }, extra: { shiftId } })`. Without this, a thrown notify error becomes an orphan flip (hold cleared, no client message, no observable signal).

## The notify function

New module `server/utils/lastMinuteStaffingConfirmation.js`, sibling to the shipped `lastMinuteAlert.js`. Exports `notifyClientOfStaffingConfirmation(proposalId, shiftId)`.

The signature takes both IDs because a proposal can carry multiple shifts; the notification reports bartenders on **the just-filled shift only** (not every shift). Including bartenders from other shifts would expose names the client never approved having and conflict with the spec template's singular "your bartender" framing for the just-confirmed slot.

Behavior, in order:

1. **Load proposal + client.** LEFT JOIN clients so an orphan proposal (null `client_id`, or `clients` row hard-deleted) is distinguishable from a hard-deleted proposal:
   ```sql
   SELECT p.id, p.event_date, p.event_start_time, p.event_timezone, p.status,
          c.id AS client_id, c.name AS client_name, c.email AS client_email,
          c.phone AS client_phone,
          c.communication_preferences, c.email_status, c.phone_status
     FROM proposals p
     LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
   ```
   Early returns (each with `Sentry.captureMessage` at `info` level + the relevant `extra` IDs):
   * `rows.length === 0` → proposal hard-deleted between flip and load. Sentry tag `reason: 'proposal_missing'`.
   * `client_id IS NULL` → orphan proposal (client deleted). Sentry tag `reason: 'orphan_proposal'`.
   * `status === 'archived'` → archived between flip and load. Sentry tag `reason: 'archived'`.
   * `event_date IS NULL` → unscheduled proposal (rare draft path). Sentry tag `reason: 'event_date_null'`.

   `event_type` / `event_type_custom` are intentionally omitted from the SELECT (templates do not reference them).

2. **Load bartenders for the just-filled shift only.** Filter by `sr.shift_id = $shiftId`, not by `proposal_id`:
   ```sql
   SELECT u.id, u.first_name, u.last_name, cp.preferred_name, cp.phone
     FROM shift_requests sr
     JOIN users u ON u.id = sr.user_id
     LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE sr.shift_id = $1 AND sr.status = 'approved'
    ORDER BY sr.id ASC
   ```
   Display name per bartender: `preferred_name || first_name || last_name || 'Your bartender'`. The trailing fallback guards against a deleted `contractor_profiles` row paired with null `first_name` and `last_name` (rare, but the empty-string template `"Your bartender for Sat is ."` would be worse than a generic label).

   Bartender phone display: `formatPhoneDisplay(cp.phone)` imported from `server/utils/globalSearch.js` (returns `(XXX) XXX-XXXX` for clean 10-digit storage, passes through anything else). `cp.phone` is stored as a 10-digit US number per `validatePhone` in `server/utils/phone.js`. If `cp.phone` is null or unparseable, `formatPhoneDisplay` returns the empty string; the renderer treats that as "no phone, render name only."

   Bartender phone for SMS sending (separate from display): `normalizePhone(cp.phone)` returns E.164 for Twilio. That value is never rendered into client-facing copy; only the display format is.

   If `rows.length === 0` (somehow the shift's approved bartenders were all unassigned between the flip and the load), `Sentry.captureMessage` at `info` level (`reason: 'no_bartenders'`) and return. The hold is already cleared, but with no bartender there's nothing meaningful to send.

3. **Render eventDate string** via `formatEventDateLong(proposal)` imported from `server/utils/preEventHandlers.js` (signature: takes the whole proposal row, resolves event timezone, returns e.g. `"Saturday, May 30, 2026"`). The proposal SELECT in step 1 selects `event_date` + `event_timezone` for this purpose. Resilient to a null `event_timezone` (helper falls back to America/Chicago via the existing `resolveEventTimezone`).

   **PIN:** there is a same-name `formatEventDateLong(ctx)` in `server/utils/staffShiftHandlers.js:349` with a different return shape (no year, `"Saturday, August 15"`). An autocomplete-driven import from the wrong module silently degrades the format. Import explicitly from `./preEventHandlers`.

4. **Render email + SMS bodies** (see Templates below). Build the bartender-list string + pluralization context **once** in the notify fn; pass primitives to templates so templates stay pure (no array logic).

5. **Email send (independent try/catch).** `shouldSendImmediate` is **async** (`server/utils/messageSuppression.js:22`); the `await` is load-bearing because the returned Promise's `.ok` is undefined, which would silently disable the send.
   ```js
   try {
     const emailOk = await shouldSendImmediate({ proposal, client, channel: 'email' });
     if (emailOk.ok) {
       await sendEmail({ to: client.email, subject, html, text });
     }
   } catch (e) {
     console.error('[lastMinuteStaffingConfirmation] email send failed:', e.message);
     if (process.env.SENTRY_DSN_SERVER) {
       Sentry.captureException(e, { tags: { feature: 'staffing-confirmation', channel: 'email' }, extra: { proposalId, shiftId } });
     }
   }
   ```
   Notes:
   * Do **not** pass an explicit `replyTo`. `sendEmail` (`server/utils/email.js:33`) already defaults `replyTo` to `process.env.ADMIN_EMAIL`. The spec's earlier draft referenced a non-existent `ADMIN_EMAIL` named export.
   * `proposalId` and `shiftId` go in `extra`, not `tags` (low-cardinality discipline; Sentry's tag index is finite).
   * `shouldSendImmediate` also checks `proposal.status === 'archived'` internally (`messageSuppression.js:26-28`); the spec's explicit archived early return in step 1 is a defense-in-depth duplicate, not a bug. The step-1 check fires before the bartender query, avoiding wasted DB work on archived rows; `shouldSendImmediate`'s check fires per channel just before the send.

6. **SMS send (independent try/catch).** Same shape; SMS failure cannot prevent or mask an email failure's Sentry capture, and vice versa. Same `await` requirement on `shouldSendImmediate`.
   ```js
   try {
     const smsOk = await shouldSendImmediate({ proposal, client, channel: 'sms' });
     if (smsOk.ok) {
       await sendAndLogSms({
         to: client.phone,
         body,
         clientId: client.client_id,            // note: SELECT aliased as client_id; pass that
         messageType: 'last_minute_staffing_confirmation',
         recipientName: client.client_name,
       });
     }
   } catch (e) {
     console.error('[lastMinuteStaffingConfirmation] sms send failed:', e.message);
     if (process.env.SENTRY_DSN_SERVER) {
       Sentry.captureException(e, { tags: { feature: 'staffing-confirmation', channel: 'sms' }, extra: { proposalId, shiftId } });
     }
   }
   ```
   The `'last_minute_staffing_confirmation'` literal is safe: `sms_messages.message_type` was widened to `TEXT` with no CHECK by the Comms Phase 3 migration (`schema.sql:2260-2270`).

## Templates

Spec copy verbatim (§ 2.2). Em dashes excluded per the project copy rule. Pluralization is computed in the notify fn and passed in as primitives; templates do no array work.

Template signatures (both):
```js
({ eventDate, bartenderList, isPlural }) => { ... }
```
* `eventDate`: string like `"Saturday, May 30, 2026"` (from `formatEventDateLong`).
* `bartenderList`: pre-rendered string per the rules below.
* `isPlural`: boolean; `bartenders.length > 1`.

`bartenderList` rendering (in the notify fn):
* 1 bartender, with phone: `"Alex ((312) 555-1234)"`
* 1 bartender, no phone: `"Alex"`
* 2 bartenders: `"Alex ((312) 555-1234) and Jordan ((312) 555-5678)"` (`and`, no comma)
* 3+ bartenders: `"Alex ((312) 555-1234), Jordan ((312) 555-5678), and Sam ((312) 555-9012)"` (Oxford comma)
* Any bartender with no phone renders as name only inside the list; the comma/and structure is unchanged.

### SMS: `lastMinuteStaffingConfirmationSms` in `server/utils/smsTemplates.js`

```js
function lastMinuteStaffingConfirmationSms({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  return `Hi, Dallas here. Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll reach out the day of the event. Let me know if you have any questions.`;
}
```

**Length note:** the 1- and 2-bartender variants fit a single 160-char SMS segment on US long-codes. The 3+-bartender variant runs ~190 chars and will multi-segment (one or two extra segments). Acceptable: last-minute multi-bartender events are exceptional, and Twilio's per-segment pricing is per-recipient cents.

### Email: `lastMinuteStaffingConfirmation` in `server/utils/lifecycleEmailTemplates.js`

Subject (pluralization-aware): `Your bartender for [event_date]` (singular) or `Your bartenders for [event_date]` (plural).

```js
function lastMinuteStaffingConfirmation({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  const subject = `Your ${noun} for ${eventDate}`;
  const body = [
    `Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll be in touch the day of the event.`,
    '',
    'Let me know if you have any questions or need any changes.',
    '',
    'Cheers, Dallas',
  ].join('\n');
  // wrap via the standard wrapEmail chrome used by sibling lifecycle templates
  return { subject, html: wrapEmail(...), text: body };
}
```

**Re-export bridge.** Sibling lifecycle templates (`signedAndPaidClient`, `drinkPlanLink`, `drinkPlanBalanceUpdate`, `shoppingListReady`, `postConsultClient`) are all exposed both from `lifecycleEmailTemplates.js` and re-exported from the `module.exports` block at `server/utils/emailTemplates.js:964-969`. Mirror the pattern: add `lastMinuteStaffingConfirmation: lifecycle.lastMinuteStaffingConfirmation` to that exports block even though `notifyClientOfStaffingConfirmation` is the only known consumer today (cross-cutting consistency rule).

## Suppression and edge handling

* **Proposal hard-deleted between flip and load.** Notify fn returns early with Sentry `info` (`reason: 'proposal_missing'`). Hold is already cleared (correct system state).
* **Orphan proposal (`client_id IS NULL`).** Notify fn returns early with Sentry `info` (`reason: 'orphan_proposal'`). The flag flip stays.
* **Proposal archived between flip and load.** Notify fn returns early with Sentry `info` (`reason: 'archived'`).
* **`event_date IS NULL`.** Notify fn returns early with Sentry `info` (`reason: 'event_date_null'`). Sending `"Your bartender for [blank]"` is worse than silence.
* **Bartenders all unassigned between flip and load.** Notify fn returns early with Sentry `info` (`reason: 'no_bartenders'`).
* **Bartender missing `contractor_profiles` AND null `first_name`/`last_name`.** Renders as `'Your bartender'` per the fallback chain. Still useful (and rare enough that a generic label is acceptable).
* **Bartender phone missing or unparseable.** That bartender renders as the name only (no parens). The list `and` / Oxford-comma structure is unchanged.
* **Client SMS disabled (STOP, opt-out, `phone_status = 'bad'`).** `shouldSendImmediate({ channel: 'sms' })` returns `{ ok: false }`. Email still fires.
* **Client email disabled (`email_status = 'bad'`).** Email skipped, SMS still fires.
* **Both channels suppressed.** Nothing sends. The flip already cleared the hold; admin uses existing manual channels to communicate.
* **Multi-shift proposal.** Notify fn takes `shiftId` and reports only bartenders on the just-filled shift. The other shift's bartenders still appear in the standard T-24h event-eve SMS (touch 3.7).
* **Send failure after flip.** Logged + Sentry. Not re-fired. Reverting the flag would risk double-sends, and a duplicate "your bartender is X" on retry is worse than a single miss.
* **Pre-existing held proposals at deploy.** Volume is exception-only (last-minute bookings are rare). On the next manual assignment touch post-deploy, the notify will fire for any still-held proposal. **Accepted as a double-touch risk.** Admin may have already verbally informed the client, but a second "your bartender is X" is benign (repeats useful info). No pre-deploy SQL backfill needed.
* **Dev / local without Twilio.** `sendSMS` returns `{ sid: 'dev-skipped-...' }` (`sms.js:20-21`); `sendAndLogSms` writes the `sms_messages` row with `status='sent'`. The notify path can be exercised against the email side end-to-end locally, but the SMS side cannot be observed in Twilio's console. Document in the test plan.

## Files touched

| File | Change |
|---|---|
| `server/routes/shifts.js` | Rename `clearHoldIfFullyStaffed` → `confirmStaffingIfFullyStaffed`. Add `RETURNING id` to the UPDATE. If a row returns, await `notifyClientOfStaffingConfirmation(proposalId, shiftId)` inside an inner try/catch with Sentry capture. Outer catch upgraded to also Sentry-capture (today it only `console.error`s). Two existing call sites stay (just renamed). |
| `server/utils/autoAssign.js` | Add `await confirmStaffingIfFullyStaffed(shiftId)` between the per-candidate SMS for-loop (ends ~line 342) and the `auto_assigned_at` UPDATE at line 346. The approval itself is the batched `UPDATE shift_requests` at lines 305-310; the for-loop is per-candidate Twilio SMS, not part of approval. Wrap the new call in try/catch + Sentry (matches the sibling `scheduleStaffShiftMessages` pattern at line 353: `Sentry.captureException(err, { tags: { component: 'autoAssign', issue: 'staffing-confirmation' }, extra: { shiftId } })`). |
| `server/utils/rescheduleProposal.js` | Inside `rescheduleProposalInTx(client, { proposalId, old, updated })`, after the existing balance-due / cascade work, compute `getBookingWindow(updated)` and `UPDATE proposals SET last_minute_hold = $1 WHERE id = $2` via the same `client` if the computed value differs from `updated.last_minute_hold`. The PATCH handler at `crud.js:617-626` is the only production caller; the test-only `rescheduleProposal(...)` wrapper inherits the behavior for free. |
| `server/utils/lastMinuteStaffingConfirmation.js` | **New.** `notifyClientOfStaffingConfirmation(proposalId, shiftId)` plus its bartender-list renderer. ~150 lines. |
| `server/utils/lastMinuteStaffingConfirmation.test.js` | **New.** Unit tests covering all early-return reasons, pluralization (1/2/3+, missing phones, missing names), per-channel suppression independence, and `messageType` literal acceptance. |
| `server/utils/lifecycleEmailTemplates.js` | Add `lastMinuteStaffingConfirmation` template. |
| `server/utils/lifecycleEmailTemplates.test.js` | Render-shape tests for the new template, plural and singular subject. |
| `server/utils/emailTemplates.js` | Re-export `lastMinuteStaffingConfirmation` in the lifecycle re-export block (~lines 811-919) to mirror sibling pattern. |
| `server/utils/smsTemplates.js` | Add `lastMinuteStaffingConfirmationSms`. |
| `server/utils/smsTemplates.test.js` | Render-shape tests + the existing no-em-dash assertion used by sibling SMS tests. |
| `README.md` | Folder-structure-tree update for the new `server/utils/lastMinuteStaffingConfirmation.js`. |
| `ARCHITECTURE.md` | One-line entry under the comms / scheduled-messages section: "Touch 2.2 last-minute staffing confirmation: immediate send on the atomic flip of `last_minute_hold` true→false." |

No schema change. No env-var change. No new route. No `CLAUDE.md` update (no new env var or integration).

## Testing strategy

* **Bartender-list renderer unit tests.** 1 / 2 / 3 / 4 bartenders; all-phones, no-phones, mixed; deleted `contractor_profiles` + null first/last name → renders `'Your bartender'` fallback.
* **Notify-fn unit tests, early-return matrix.**
  * Proposal not found → `proposal_missing` (no sends).
  * Orphan proposal (`client_id` null) → `orphan_proposal` (no sends).
  * Status archived → `archived` (no sends).
  * Event date null → `event_date_null` (no sends).
  * No approved bartenders → `no_bartenders` (no sends).
* **Notify-fn unit tests, per-channel suppression independence.**
  * Email-disabled client gets SMS only.
  * SMS-disabled client gets email only.
  * Both-disabled sends nothing.
  * Email send throws → Sentry capture fires, SMS still attempts and succeeds.
  * SMS send throws → Sentry capture fires, email already sent.
* **Atomic-flip race test.** Two concurrent `confirmStaffingIfFullyStaffed(shiftId)` calls against the same shift → notify fn invoked exactly once. The DB-level `WHERE last_minute_hold = true` clause is the guarantee.
* **Non-held proposal becomes fully staffed → no notify.** Pin the regression: the rename's most common code path (normal-lead-time fully-staffed shift) must not invoke the notify fn.
* **Auto-assign integration.** Set up a held proposal with a shift, run the auto-assign path, assert `last_minute_hold = false` and that the notify fn was called with the right `(proposalId, shiftId)`.
* **Reschedule integration.** Held proposal rescheduled past 72h → `last_minute_hold` becomes false (no notify on next staffing-fill). Non-held proposal rescheduled into 72h → `last_minute_hold` becomes true (notify fires on next staffing-fill).
* **Schema/column sanity.** Test that `sendAndLogSms` accepts `messageType: 'last_minute_staffing_confirmation'` against the actual `sms_messages` schema (post-Phase-3 widening). A simple insert that round-trips the value.
* **Dev / local note (not a test).** In local without Twilio creds, the SMS side returns `dev-skipped-...` and writes an `sms_messages` row with `status='sent'`. End-to-end observability requires staging.

## Out of scope (explicit deferrals)

* Touch 2.2's spec note "Proposal archived" as a suppression condition is honored via the post-flip status check. Other suppression categories (e.g., a per-proposal "do not contact" override) are not introduced.
* The event-eve SMS (touch 3.7) is untouched. Last-minute bookings receive both messages (Touch 2.2 immediately, plus the standard T-24h SMS) by design. Different timing, different framing.
* Relocating `formatPhoneDisplay` from `server/utils/globalSearch.js` to a shared `phone.js`. The notify module imports from the current home; cleanup is left for a future pass.
* No backfill SQL for in-flight held proposals at deploy. Accepted as a double-touch risk per Suppression section.
* **Direct shift-date edits via `PUT /shifts/:id` (`server/routes/shifts.js:419`) do not re-evaluate `last_minute_hold`.** The shift table mirrors the proposal's event_date (kept in sync via `syncShiftsFromProposal`); the canonical date lives on the proposal, and admin direct-editing a shift's date in isolation is rare and already a data-integrity gray area (the shift can drift from the proposal). The booking-window source of truth stays the proposal's event_date, and the reschedule re-evaluation hook is on the proposal-PATCH path only. If admin needs a "moved into 72h" alert after a direct shift edit, they manually toggle `last_minute_hold` via the existing admin UI (today's tool, unchanged).
* No re-arming of `last_minute_hold` if a bartender is unassigned post-flip. Once a hold is cleared, it stays cleared; the booking has passed the verification step and admin manages any subsequent staffing rework via existing tools.
