# Notify-Client Confirmation

Date: 2026-07-21 (revised 2026-07-22 after the design fleet + Fable review; all four owner
decisions folded in)
Status: approved, ready for plan

## Problem

Several admin actions send a message to the client as a side effect of an edit. The intent
was to change a record; a message left the building as a consequence, with no prompt and no
visibility.

Observed live: correcting a CC-imported booking's venue from a bare venue name to a real
street address, and fixing a typo in that field, each emailed AND texted the client a
"your event has been rescheduled" notice. The dominant real-world flow is the opposite of
what the system assumes: a client writes in asking for a change, Dallas replies personally
("no problem, just did that"), then makes the edit. The automated message is redundant and
reads as robotic.

The same shape burned the CC import backfill, where recording historical payments would have
emailed every one of those clients a receipt for a payment they made months ago.

## Inventory

Every admin action that reaches a client as a side effect, from a full sweep of every
`sendEmail`/`sendSMS`/`sendAndLogSms` call site traced back to its trigger (2026-07-22):

**In scope, gets the confirmation:**

| # | Trigger | Sends | Code |
|---|---------|-------|------|
| 1 | Proposal PATCH changing `event_date`, `event_start_time`, or `event_location` on a booked proposal | Email **and** SMS | `rescheduleProposal.js:64` (field list), `:412` (status gate), `crud.js:710` (call) |
| 2 | Recording an outside payment | Email receipt | `actions.js:319-322` |
| 3 | In-app refund (`POST /api/stripe/refund/:id`) | Refund-notice email | `stripe.js:519-527` via `refundClientNotify.js` |
| 4 | Cancel-flow refund step (`POST /api/proposals/:id/cancel/refund`) | Refund-notice email | `cancel.js:641-644` |

Item 4 is doubly inconsistent today: the cancel dialog already asks about its cancellation
email (`suppress_client_email`, `cancel.js:237`, checkbox in `CancelEventDialog.js`) but not
about the refund email one step later. That existing checkbox is also the in-codebase
precedent for this whole pattern: a visible per-send decision at the moment of the action.

Suppressing the refund notices is safe against their backstops: the `charge.refunded`
webhook (`chargeRefunded.js:68`) and the stale-pending sweeper (`refundSweepScheduler.js:31`)
only notify when THEY apply the reconciliation, which they do not when the in-app route did.

**Reclassified, stays automatic (owner decision 2026-07-22):**

| Trigger | Why it stays automatic |
|---|---|
| Staffing-driven gratuity increase on a paid booking (`crud.js:499-502` trigger, `:731` send) | This is a billing disclosure, not a courtesy. The rise flows into `total_price` and the post-commit invoice cascade mints or grows a payable invoice that sends **no email of its own** (`invoiceLifecycle.js:337-346`), so this email is the only thing that tells the client they owe more, and on an autopay booking, the only warning their card will be charged more. With quiet-as-default plus the no-later-send rule, gating it would make "billed more, never told" the default outcome of a staffing edit. It also was never part of the owner's complaint. It gains the suppression gate (below) and nothing else changes. |

**Considered and excluded, documented so nobody rediscovers them as misses:**

- **Change-request approve AND decline** (`crud.js:809`, `changeRequests.js:83-87`): both fire
  only on a deliberate decision act on a request the client filed, where a reply is expected.
- **Last-minute staffing confirmation** (Touch 2.2, `lastMinuteStaffingConfirmation.js:159/:187`):
  one-shot by construction (atomic `last_minute_hold` true-to-false flip), a designed product
  touch of the last-minute flow, and co-triggered by the auto-assign scheduler, so a popup could
  gate only one of its triggers and the behavior would become incoherent.
- **Admin charge-balance** (`stripe.js:282`): the receipt arrives via the `payment_intent.succeeded`
  webhook, which also serves autopay and client checkout. Real money left the client's card; a
  receipt is the correct artifact.
- **Status flip to `sent`** (`lifecycle.js:139-158`, deliberately no dedupe): today reachable only
  through the explicit "Send to client" button, so it is fine, but the exposure is API-shaped: any
  future bookkeeping tool that flips status to `sent` re-emails the full proposal. Landmine noted
  for the next tool builder.

Everything else that reaches a client is verifiably explicit-send (SendModal comms actions),
client-initiated, scheduled, or webhook-triggered.

## Scope

In scope: put a confirmation in front of inventory items 1-4, move the send decision from the
server to the caller, and add the suppression gate to the three bare client sends (receipt,
gratuity, refund notice).

Out of scope: the scheduled-message system, the change-request decision emails, the SendModal
comms path, which fields count as reschedulable, and any change to message content beyond what
composition timing forces (see the draft-content section).

## Server

### Request contract

`PATCH /api/proposals/:id` gains `notify`, an array with today exactly one legal entry type.
The array wire shape survives (a future composable notice slots in without a contract break),
but the machinery behind multiple types was deliberately deleted with the gratuity
reclassification:

```
notify: [
  { type: 'event_details_changed',
    channels: ['email', 'sms'],         // subset; omitted channels are not sent
    email: { subject, body_text },      // required when 'email' in channels
    sms:   { body } }                   // required when 'sms' in channels
]
```

An absent or empty `notify` array sends nothing. A requested notice the save does not trigger
is a `ValidationError` and the transaction rolls back: the text was composed against a specific
set of changes and must never send against a different one. There is exactly one strictness
rule now; the two-class split died with the gratuity notice.

Structural validation (known type, no duplicate, required text, caps) runs before
`pool.connect()`, so a malformed request never checks out a connection. The trigger check runs
inside the transaction where `shouldSendEmail` is computed, and a mismatch throws and rolls
back. Nothing saved, nothing sent, in both cases.

`POST /api/proposals/:id/record-payment` gains `notify_client: true | false`. The receipt body
is fixed (`emailTemplates.paymentReceivedClient`), nothing to compose, no list needed.

`POST /api/stripe/refund/:id` gains `notify_client: true | false` the same way (fixed template,
`refundClientNotify.js`). `POST /api/proposals/:id/cancel/refund` reads the same
`suppress_client_email` flag its parent dialog already collects, so the one checkbox governs
both emails of the cancel flow. Polarity note: `suppress_client_email` is inverted relative to
the fail-quiet rule below (absent means the cancel-refund email SENDS); that inversion is
inherited from the existing cancel contract on purpose, one flag with one meaning across the
dialog, and the fail-quiet paragraph applies to the `notify`/`notify_client` family only.

This follows the convention the PATCH already uses for the staff side:
`notify_assigned_staff`, `notify_staff_sms`, `notify_staff_email` (`crud.js:308`).

**Absent, empty, or false means nothing is sent.** Fail-quiet is deliberate. Any caller that
does not know about this contract (a script, a test, a future integration, a hand-rolled curl)
is silent by default rather than accidentally messaging a real client. The cost of a missed
notification is a phone call; the cost of an unwanted one is a client asking why they got a
robotic message about a change they already discussed.

An `event_details_changed` notice with no supplied text is a `ValidationError`, never a
fallback to a built-in template. There is exactly one composition path.

**The change-request seam.** The shared proposal editor always sends `change_request_id` when one
is pending, and the save already suppresses the direct reschedule send on that path
(`crud.js:710`, `&& !change_request_id`) because the change-approved email (`crud.js:807-824`)
is that flow's one client touch. The contract keeps that rule coherent end to end: when
`change_request_id` is present, preflight returns zero notices (no popup) and the save treats
`event_details_changed` as untriggerable (a requested one is the same `ValidationError`). One
rule, both sides, and the popup can never appear on a path where Send would do nothing.

### Preflight

`POST /api/proposals/:id/notify-preflight`, `auth` + `requireAdminOrManager` +
`adminWriteLimiter` (the read-only `cancel/preview` sibling carries one), integer-guarded
`:id`. Takes the same pending-edit body shape the PATCH takes and returns:

```
{
  notices: [
    { type: 'event_details_changed',
      reasons: ['event_location changed'],
      composable: true,
      recipient: { name, email, phone },
      channels: { email: {available, default, unavailable_reason}, sms: {...} },
      autopay_notice: 'Their card auto-charges on August 3.' | null,
      draft: { email: {subject, body_text}, sms: {body} } }
  ]
}
```

An empty `notices` array means the save sends nothing and the form must not prompt.

Determinism is the whole point, and with the gratuity notice gone it is total: preflight and
the save call the identical functions and must always agree.

- The field decision is `hasReschedulableChange` (`rescheduleProposal.js:64`, already exported)
  and the status gate is the same `archived`/`BOOKED_SET` predicate, extracted so a read-only
  endpoint can call it (the current copy sits inside the transactional
  `rescheduleProposalInTx`).
- The reschedulable field list is exported from `rescheduleProposal.js` and `reasons` derives
  from it; no second copy of the list exists anywhere.
- **The prospective row is built by the same code the save uses.** The live incident that
  started this project was a venue edit, and venue edits arrive as `venue_*` parts, not as
  `event_location`: the save merges body parts over the stored row and composes via
  `composeVenueLocation` (`crud.js:341-350`, helper already in `venueAddress.js:21`). That
  merge-and-compose block is extracted to a shared `resolvePendingLocation(old, body)` and
  called from both `crud.js` and preflight. Without this, preflight and the save disagree on
  the exact field the feature was built for.

It is read-only: no transaction, no writes. The save recomputes its own answer and is the
authority; preflight is a convenience for the UI.

### Draft content (owner decision 2026-07-22: no stale money lines)

The current template quotes package, guest count, total, and balance due date. Composed at
preflight, every one of those can be wrong by the time Send works: the save itself moves
`balance_due_date` whenever the date moves (`rescheduleProposal.js:432-461`), the same PATCH
can re-price, and it can even disarm autopay. Compose-at-save was rejected because it destroys
WYSIWYG; recompose-and-diff was rejected because a mismatch has no good resolution.

So the drafted email is: greeting; one old-to-new line per field that actually changed;
**the projected date consequence, which IS deterministic**; a link to the live proposal page
(`PUBLIC_SITE_URL` token URL) for everything else; sign-off. No total, no package line, no
guest count, and no blanket "everything else stays the same" (the body is editable; Dallas
adds that sentence himself when it is true).

The projected date consequence: the balance-due shift preserves the existing offset between
event date and due date, a pure function of the old row plus the pending edit. When the due
date will move, the draft quotes the projected new date, phrased "your card will auto-charge
on X" for autopay-enrolled bookings and "your balance due date moves to X" otherwise, and the
popup surfaces the same fact as `autopay_notice` so the admin sees the money consequence even
when sending quietly. When the projected date lands within 3 days or in the past, the notice
says that too; that is the case with effectively zero automatic warning (the T-3 reminder may
already have fired or may race the charge).

The SMS draft keeps `smsTemplates.rescheduleSms` content, except the notify draft always
omits its closing "Full updated confirmation in your email" clause: channel selection happens
after composition, so any email promise in the default text can become a lie the moment the
admin unchecks email. The body is editable; Dallas adds the pointer when it is true.

### Why the draft is built at preflight, and why not SendModal

The reschedule message renders old-versus-new, and the old values exist only before the save
commits. `SendModal` composes by fetching an entity's current state after the fact
(`POST /api/comms/preview`), which would silently drop the "was Aug 3" half of every message.
So composition happens at preflight, where the stored row and the pending edits are both in
hand, and the reviewed text rides the save.

The accepted trade: a second piece of compose UI alongside SendModal. Forcing them together
means either breaking SendModal's entity-driven contract or degrading the message.

### The event-details email becomes a parts email

`emailTemplates.rescheduleNotificationClient` returns pre-rendered `{ subject, html, text }`.
`renderPartsEmail` (`comms/render.js`, the editable-body renderer `shoppingListApprove.js:194`
uses) takes `{ subject, heading, bodyText, cta }`. They are incompatible: keeping the bespoke
template while calling the body editable would send the admin's text as plaintext while every
real mail client rendered the untouched HTML. The admin would review one message and the
client would receive another, the exact failure this feature exists to eliminate.

So the send renders the reviewed subject and body through `renderPartsEmail`. The old template
function stays in place (verify remaining callers before ever deleting it).

### Placeholder addresses are not addresses

CC-imported clients carry RFC-2606 `.invalid` placeholder emails. `sendEmail` drops them
silently, returns `{ id: 'skipped-invalid' }`, and writes no ledger row (`email.js:52-90`). A
design that reported those as "sent" would lie to the exact cohort that motivated the project.

Rule, applied via one shared `isPlaceholderEmail(email)` helper (new, in `emailValidation.js`;
this is roughly the seventh copy of the predicate in the codebase, so new code uses the helper
and retrofitting old copies is optional):

- Preflight channel availability: a placeholder means email unavailable, with the CC-import
  reason string.
- The send paths (reschedule, receipt, refund): same predicate as defense in depth, reported
  `skipped` with the reason; additionally map a `skipped-invalid` return to `skipped`, never
  `sent`.
- The record-payment panel gate: a placeholder counts as no-email, so no popup, post with
  `notify_client: false`.

### What suppression must never touch

`rescheduleProposalInTx` (`crud.js:632`) does two separate jobs. It re-anchors every pending
scheduled message and recomputes `balance_due_date`, and it returns `shouldSendEmail`. The
re-anchoring is correctness, not communication. The `notify` list gates **only** the send; the
`rescheduleProposalInTx` call is unconditional and stays exactly where it is, on its own line.

Also never gated by `notify`: `runRescheduleStaffHooks` (`crud.js:782`) and its staff flags,
`notifyAdminCategory` on a recorded payment (`actions.js:324`), the gratuity disclosure email
(reclassified above), `recomputeNewYearHelloForProposal`, the invoice refresh, and every other
post-commit cascade.

### Suppression parity (owner decision 2026-07-22)

`shouldSendImmediate` (`messageSuppression.js`) is the one gate: archived proposal, per-channel
`communication_preferences`, `email_status`/`phone_status` bad-contact. Every scheduled send
and most immediate sends already consult it. Three client sends do not: the payment receipt,
the gratuity disclosure, and the refund notice are bare `sendEmail` calls today.

All three join the gate. An explicit Send never overrides it: a suppressed channel reports
`skipped` with the reason. This is what makes a do-not-contact client mechanically safe
instead of memory-safe.

**Ops step, owner-approved:** after deploy, set
`communication_preferences = {"email_enabled": false, "sms_enabled": false}` on Luva's client
row (prod, Neon). No admin UI exists for these fields (only the marketing unsubscribe writes
them); a "do not contact" toggle on the client page goes to the fix list.

### Supplied text validation

Same rules the comms route enforces: subject CR/LF-stripped, trimmed, non-empty, 300 cap; SMS
trimmed, non-empty, 640 cap; channels filtered to `['email','sms']`. Honesty note: those rules
live inline in the `/send` handler (`comms.js:88-108`) and are not exported, so this feature
carries its own copy of the two cap constants and the strip logic, with a comment binding them
to `comms.js`. Extracting a shared validator would widen a sensitive-path lane for two
constants; a divergence is a review finding either way.

A channel listed in a notice whose recipient is unavailable is skipped with a reason, never
silently dropped.

### Response contract

Every gated endpoint returns per-channel truth alongside its existing payload, one entry per
notice attempted (`event_details_changed`, `payment_receipt`, `refund_notice`):

```
notifications: [
  { type: 'event_details_changed',
    email: 'sent' | 'failed' | 'skipped' | null,
    sms:   'sent' | 'failed' | 'skipped' | null,
    email_error, sms_error, skip_reasons }
]
```

Empty array = nothing attempted, the normal quiet outcome. Existing top-level response keys
are preserved (the PATCH spreads `notifications` beside the proposal row; both current client
callers discard the response body and reload, verified).

Sends stay best-effort and post-commit: a provider failure must never 500 a request whose
transaction committed. But it stops being invisible; the form says "saved, email failed"
instead of showing a green check over a message that never left.

### No later-send path, and no Retry either

There is deliberately no way to send one of these messages after declining (owner rule). A
**failed** send is also not retryable from the popup, decided after review: a retry endpoint
that accepts composed text post-save is structurally the banned later-send path, and with no
idempotency keys at Resend or Twilio anywhere in this codebase, a retry on an ambiguous
timeout can double-send, which for this owner is worse than zero (zero has a recovery: Dallas
texts the client, which is his dominant flow anyway). The failure toast plus Sentry is the
recovery. If a real retry is ever wanted, the precondition is provider idempotency keys; fix
list.

## Client

Call sites (post event-editor merge `ca231dd`, 2026-07-21: the two legacy edit forms no
longer exist): the shared `proposalEditor/ProposalEditorForm.js` (one save flow, mounted by
BOTH Proposal Detail and Event Detail; PATCH via the single `patchBody.js` builder),
`ProposalDetailPaymentPanel.js` (record payment at `:201`, in-app refund at `:121`),
`CancelEventDialog.js` (cancel-refund at `:94`).

The editor already runs one pre-save confirm, the reprice modal (booked + total moved). The
notify decision chains AFTER it: reprice confirm (when applicable), then preflight, then the
notify popup, then one save. Worst case two modals in sequence on a booked, re-priced,
rescheduled save; each is answering a different question (money, then communication).

### Event edit

On Save, the form calls preflight with the same body it will PATCH (including
`change_request_id` when present, so the server can suppress correctly). Empty `notices`:
save proceeds, no popup, nothing changes on screen. Fix a guest count or edit an unsigned
quote and you never see this feature.

Otherwise the popup shows the recipient (labeled "current contact on file", since preflight
reads the stored row while the same form may be editing the contact), what changed, the
`autopay_notice` line when present, the drafted subject and body (editable, with the 300/640
caps mirrored live client-side), and a checkbox per available channel.

- **Don't send** (primary): saves with an empty `notify` list.
- **Send the update**: saves with the reviewed text.
- **Cancel**: nothing happens at all.

For Cancel to be true, the client-contact `PUT /clients/:id` that both forms fire today
**before** the PATCH moves inside the confirmed-save path, after the popup decision. Escape
and backdrop click are Cancel, never quiet-save, and are inert while a save is in flight.
Buttons carry an in-flight lockout (double-click = double-message otherwise; neither endpoint
has a rate limiter today).

Toast rules: `failed` toasts an error with the provider message; `skipped` toasts only when
the channel was actually requested (a client with no email must not produce "Email not sent"
noise on every save); a rejected save surfaces `fieldErrors`, not a generic "Save failed."

### Record payment, in-app refund, cancel-refund

Record payment: popup after the amount is entered, before the POST. States recipient and
amount, with the caveat that the receipt shows the server-applied amount (the server caps
against the locked ledger, so an over-entry is applied capped).

- **Send receipt** (primary): posts `notify_client: true`.
- **Don't send**: posts `notify_client: false`.
- **Cancel**: no post.

Send is primary here, opposite of the edit popup, because the receipt is usually wanted;
declining should be the deliberate act. Because the two popups invert the primary action, the
payment mode is visually distinct (its own title, "Email a receipt?", amount and recipient
prominent) so muscle memory from the edit popup cannot land on Send by reflex.

No email on file, or a `.invalid` placeholder: no popup, post with `notify_client: false`.

In-app refund: same shape as record payment (fixed template, Send primary). Cancel-refund:
no new popup; the existing `suppress_client_email` checkbox in `CancelEventDialog` governs the
refund email too, so one visible decision covers the whole cancel flow.

## Testing

Server, `node:test`, one suite at a time against the dev DB (`node -r dotenv/config`).
Environment law: dev gates real sends (`SEND_NOTIFICATIONS`), `sendEmail` returns
`dev-skipped` before any ledger write, so **send assertions run at the dependency seam**
(extend `crud.js`'s existing `__setDeps` pattern to stub `sendRescheduleEmail`; stub
`sendEmail` where a route calls it directly), never against `message_log`. `ValidationError`
carries its text in `.fieldErrors`, never `.message`; assertions match on `fieldErrors`.
`scheduled_messages` is polymorphic: query by `entity_type = 'proposal' AND entity_id`.
`clients.email_status` is `NOT NULL DEFAULT 'ok'`; fixtures restore `'ok'`, never NULL.

1. A PATCH that moves `event_date` with no `notify` list sends nothing AND still re-anchors
   every pending scheduled message and recomputes `balance_due_date`. Load-bearing.
2. A PATCH with a notice and reviewed text passes exactly that text to the send seam, not the
   template default.
3. A notice with no supplied text is a 400 and the proposal is not saved.
4. A notice on a save that changed nothing reschedulable is a 400, transaction rolled back.
5. A save carrying `change_request_id`: preflight returns zero notices, and a requested
   `event_details_changed` on that save is a 400.
6. Preflight and save agree: table-driven, one case per reschedulable field (including a
   venue-parts-only edit, exercising `resolvePendingLocation`) plus a non-booked status.
7. A 641-character SMS body is rejected; a 301-character subject is rejected.
8. A suppressed recipient (prefs disabled, or `email_status = 'bad'`) reports `skipped` with
   the reason even when requested, on the reschedule, receipt, AND refund paths.
9. A `.invalid` recipient reports `skipped`, never `sent`, on receipt and reschedule paths.
10. Record payment with `notify_client: false` sends no receipt and still calls
    `notifyAdminCategory`; with `true` it sends. Both asserted at the seam.
11. The gratuity disclosure still fires automatically on a staffing-driven rise with no
    `notify` list present (regression pin for the reclassification), and is blocked by
    suppression prefs.
12. In-app refund with `notify_client: false` refunds without the client email; cancel-refund
    honors `suppress_client_email`.

Existing suites: tests asserting the reschedule email on a bare PATCH update to the new
contract; `rescheduleProposal.test.js`'s wrapper-email cases are ported when the wrapper's
email tail is deleted (below). No assertion is weakened; an unexplained failure is a finding.

Client: `CI=true react-scripts build` is the lint gate. Note the modal-only commit is not
actually exercised by the build until a form imports it, so the modal and its first consumer
are verified together.

## Cleanups forced by the review

- The exported `rescheduleProposal()` wrapper (`rescheduleProposal.js:549`) is test-only
  (verified: no webhook, scheduler, or route calls it; Cal.com has no send path). Under the
  new send signature its email tail would silently no-op, so the tail is deleted and the
  wrapper kept as the tx-plus-reanchor convenience, tests updated.
- `utils/groupSend.js` has zero requires anywhere (superseded by the `proposalSendGroup`
  comms action): fix-list candidate for deletion, not touched here.

## Review posture

Correction from the first draft, verified: `proposals/crud.js` and `proposals/actions.js` are
**not** on `scripts/sensitive-paths.txt` (`sensitive-match.js` returns only `comms.js` and
`emailTemplates.js` for this footprint). They carry money math and now carry client-send
contracts, so this project **adds** `server/routes/proposals/crud.js`,
`server/routes/proposals/actions.js`, and `server/utils/rescheduleProposal.js` to the list,
making the intended posture real: full fleet per lane, push-time sensitive re-review,
`/second-opinion`, and the money smoke gate (`server/` changed). Until that lands, the lane
map's declared fleet is the trigger, not the path matcher.

## Decisions and rejected alternatives

**Reversed after review: the gratuity notice was in the popup.** The first approved draft had
it as a second, non-composable notice type with its own strictness class and a conservative
preflight predictor. Review killed it twice over: the predictor keyed on fields both forms
send on every save, so the popup would have appeared on essentially every save of every paid
booking (fatigue that un-solves the original problem), and quiet-as-default plus no-later-send
made silent billing the default outcome. Owner reversed it 2026-07-22; the email stays
automatic and the strictness machinery is deleted.

**Rejected: a "notify client" checkbox on each edit form.** The decision would appear on every
save, and each form grows its own copy of the rule.

**Rejected: mirroring the reschedulable-field rule in React.** Guarantees drift. The preflight
round trip on a form submit is cheap; a phantom popup or a silent send is not.

**Rejected: routing the notify path through SendModal.** Drops the old-versus-new content.

**Rejected: a pending-notification marker.** The dominant case is that Dallas already told the
client personally, so the badge would cry wolf and train him to ignore it.

**Rejected: a Send receipt button on the payment row.** No payment history exists in the admin
UI; logged to the fix list as its own project, with the `actions.js:286` `RETURNING id` race
as a ride-along there.

**Rejected: Retry on a failed send.** Structurally the banned later-send path, and without
provider idempotency keys a timeout-ambiguous retry can double-send. Visibility (failure toast
plus per-channel truth) is the fix; personal follow-up is the recovery.
