# Notify-Client Confirmation

Date: 2026-07-21
Status: approved section-by-section, ready for plan

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

Every admin action that sends to a client as a side effect, as of this spec:

| # | Trigger | Sends | Code |
|---|---------|-------|------|
| 1 | Proposal PATCH changing `event_date`, `event_start_time`, or `event_location` on a booked proposal | Email **and** SMS | `rescheduleProposal.js:64` (field list), `:412` (status gate), `crud.js:710` (call) |
| 2 | Proposal PATCH where a staffing change raises the gratuity total | Email | `crud.js:498-501` (trigger), `crud.js:731` (send) |
| 3 | Recording an outside payment | Email receipt | `actions.js:319-322` |
| 4 | Approving a change request | Email | `crud.js:809` |

Item 4 is already explicit: it only fires when the caller passes `change_request_id`, so it
is a deliberate act and is out of scope. Items 1, 2, and 3 fire with no way to decline.

Everything else that reaches a client is either genuinely explicit (the SendModal comms
actions, proposal send, invoice send) or scheduled (reminders, nudges, drips). Those are not
in scope.

## Scope

In scope: put a confirmation in front of items 1, 2, and 3, and move the send decision from
the server to the caller.

Out of scope: any change to what the messages say (except as forced by composition timing,
see "Why not SendModal"), to the scheduled-message system, to item 4, to the SendModal comms
path, and to which fields count as reschedulable.

## Server

### Request contract

Both endpoints stop deciding on their own and require the caller to opt in.

A single save can trigger more than one notice: changing the venue and adding a bartender in
one edit fires both the reschedule notice and the gratuity notice. So the contract is a list,
not a boolean plus one message.

`PATCH /api/proposals/:id` gains `notify`:

```
notify: [
  { type: 'event_details_changed',
    channels: ['email', 'sms'],         // subset; omitted channels are not sent
    email: { subject, body_text },      // required when 'email' in channels
    sms:   { body } },                  // required when 'sms' in channels
  { type: 'gratuity_increase',
    channels: ['email'] }               // fixed template, no supplied text
]
```

An absent or empty `notify` array sends nothing. A notice type present in the array that the
save does not actually trigger is a `ValidationError`, so a stale form cannot send a
reschedule notice on a save that rescheduled nothing.

Validation happens in two places for a reason. **Structural** checks (known type, no duplicate
types, required text present, caps respected) run before `BEGIN`, so a malformed request never
opens a transaction. **Trigger** checks run where the notice set is computed, which for
`gratuity_increase` is necessarily mid-transaction, after the pricing engine produces the new
snapshot (`crud.js:490-501`). A trigger mismatch throws inside the transaction and rolls back.
Either way the outcome is the same and is the one that matters: nothing saved, nothing sent.

Two notice types exist, and they differ in whether the caller composes the text:

| Type | Template | Channels | Composable |
|---|---|---|---|
| `event_details_changed` | renders old vs new, so it must be composed at preflight | email, sms | yes, `email` and `sms` required |
| `gratuity_increase` | `emailTemplates.gratuityStaffingChange`, fixed | email | no, supplied text is rejected |

`POST /api/proposals/:id/record-payment` gains `notify_client: true | false` only. The receipt
body is fixed (`emailTemplates.paymentReceivedClient`), so there is nothing to compose and no
list is needed.

This follows the convention the route already uses for the staff side:
`notify_assigned_staff`, `notify_staff_sms`, `notify_staff_email` (`crud.js:308`).

**Absent, empty, or false means nothing is sent.** Fail-quiet is deliberate. Any caller that
does not know about this contract (a script, a test, a future integration, a hand-rolled curl)
is silent by default rather than accidentally messaging a real client. The cost of a missed
notification is a phone call; the cost of an unwanted one is a client asking why they got a
robotic message about a change they already discussed.

An `event_details_changed` notice with no `email`/`sms` text is a `ValidationError`, not a
fallback to the built-in template. There is exactly one composition path.

### Preflight

`POST /api/proposals/:id/notify-preflight`, admin/manager, takes the same pending-edit body
shape the PATCH takes and returns:

```
{
  notices: [
    { type: 'event_details_changed',
      reasons: ['event_location changed'],
      composable: true,
      recipient: { name, email, phone },
      channels: { email: {available, default, unavailable_reason}, sms: {...} },
      draft: { email: {subject, body_text}, sms: {body} } },
    { type: 'gratuity_increase',
      reasons: ['gratuity rose from $450.00 to $600.00'],
      composable: false,
      recipient: {...}, channels: {...}, draft: null }
  ]
}
```

An empty `notices` array means the save sends nothing and the form should not prompt.

It **must** compute the triggered notices by calling the same `hasReschedulableChange` and the same
`BOOKED_SET` status gate the save path calls (`rescheduleProposal.js:64`, `:412`), plus the
same gratuity comparison as `crud.js:498-501`. No reimplementation, no parallel copy of the
field list. When someone adds a fourth reschedulable field, both paths change together or
neither does.

It is read-only. It writes nothing and commits nothing.

The save path recomputes its own notice set and validates the submitted `notify` list against
it. Preflight is a convenience for the UI, never the authority. A save whose conditions changed
between preflight and submit rejects rather than sending a message built from stale facts.

The `draft` is the reason this endpoint exists rather than a client-side rule check. See below.

### Why the draft is built at preflight, and why not SendModal

The reschedule email renders old-versus-new: `oldDateLocal`, `oldStartTimeLocal`,
`oldLocation` against `newDateLocal` and friends (`rescheduleProposal.js:305-315`). Those old
values exist only before the save commits.

`SendModal` composes by fetching an entity's current state after the fact
(`POST /api/comms/preview` with an `entity_id`). Routing this through it would silently drop
the "was Aug 3" half of every message. That is a worse email, so the composition happens at
preflight, where both the stored row and the pending edits are in hand, and the reviewed text
rides along on the save.

The accepted trade: this is a second piece of compose UI alongside SendModal rather than one
shared component. Forcing them together means either breaking SendModal's entity-driven
contract or degrading the message.

### What suppression must never touch

`rescheduleProposalInTx` (`crud.js:632`) does two separate jobs in one call. It re-anchors
every pending scheduled message and recomputes `balance_due_date` from the preserved offset,
and it returns `shouldSendEmail`. The re-anchoring is correctness, not communication: a moved
event with stale reminder anchors will fire its balance reminder against the old date.

The `notify` list gates **only** the send. The `rescheduleProposalInTx` call is unconditional
and stays exactly where it is. The two concerns stay on separate lines in the handler so a
future edit cannot conflate them.

Also unaffected by `notify`:

- `runRescheduleStaffHooks` (`crud.js:782`) and its own `notify_assigned_staff` flags. Staff
  notification is a separate decision from client notification.
- `notifyAdminCategory` on a recorded payment (`actions.js:323`). That is an internal
  routine_finance notice to Dallas, not a client touch.
- `recomputeNewYearHelloForProposal`, the invoice refresh, and every other post-commit
  cascade.

### Existing suppression still wins

`sendRescheduleEmail` gates each channel on `shouldSendImmediate`
(`rescheduleProposal.js:229-242`): communication preferences, `email_status`, `phone_status`.
Choosing Send does not override an unsubscribe or a hard bounce. When a channel is suppressed,
the response reports it as skipped with the reason rather than as sent.

### Supplied text validation

Supplied text on an `event_details_changed` notice goes through the same rules `comms.js`
enforces, reusing that code rather
than a second implementation:

- Subject: CR/LF stripped, trimmed, non-empty, 300 character cap (`comms.js:88-101`).
- SMS body: trimmed, non-empty, 640 character cap (`comms.js:17`, `:102-108`).
- Channels filtered to `['email', 'sms']` (`comms.js:63`).

A channel listed in a notice's `channels` whose recipient is unavailable is skipped with a
reason, never silently dropped.

### Response contract

Both endpoints return per-channel truth alongside the updated record, one entry per notice
attempted (record-payment returns at most one, keyed `payment_receipt`):

```
notifications: [
  { type: 'event_details_changed',
    email: 'sent' | 'failed' | 'skipped' | null,
    sms:   'sent' | 'failed' | 'skipped' | null,
    email_error, sms_error, skip_reasons }
]
```

An empty array means nothing was attempted, which is the normal Don't-send outcome.

The send stays best-effort and post-commit, exactly as today (`crud.js:710-725`): a Resend or
Twilio failure must never 500 a PATCH whose transaction already committed. But it stops being
invisible. Today a thrown provider error is logged to Sentry and swallowed, and the admin sees
a clean success. With this contract the form can say "saved, email failed" instead of showing a
green check over a message that never left.

## Client

Three call sites: `EventEditForm.js:83` and `ProposalDetailEditForm.js:246` (both PATCH), and
`ProposalDetailPaymentPanel.js:201` (record payment).

### Event edit

On Save, the form calls `notify-preflight` first. If `notices` is empty, the save proceeds with
no popup and nothing on screen changes. Fix a guest count or swap a package on an unsigned quote
and you never see this feature.

Otherwise a review popup opens, one block per notice. A composable notice shows the recipient,
what changed, the drafted subject and body (editable), and a checkbox per available channel
defaulted per `defaultChannels`. A non-composable notice shows the recipient and a one-line
description of what will be sent. In the common case there is exactly one block.

- **Don't send** (primary): saves with an empty `notify` list.
- **Send the update**: saves with a `notify` entry per notice, carrying the reviewed text.
- **Cancel**: no save.

Send is all-or-nothing across the blocks. Per-notice opt-in is not worth the interface weight
for a case that will be rare.

Don't send is primary because the usual case is that Dallas has already replied to the client
personally.

The popup is dismissible by Escape and by backdrop click, both equivalent to Cancel, not to
Don't send. Dismissing must never silently save.

### Record payment

The popup opens after the amount is entered, before the POST. There is nothing to compose, so
it states the recipient and the amount and offers:

- **Send receipt** (primary): posts with `notify_client: true`.
- **Don't send**: posts with `notify_client: false`.
- **Cancel**: no post.

Send receipt is primary here, the opposite of the edit popup, because Dallas will usually want
the receipt to go. Declining should be the deliberate act, not the easy one.

When the client has no email on file, no popup appears and the payment posts with
`notify_client: false`.

### No later-send path

There is deliberately no way to send one of these messages after declining. The rule is that if
it is not sent at the moment of the change, it is not sent. This is why no pending-notification
record, marker badge, or old-value snapshot exists anywhere in this design.

## Testing

Server, `node:test`, one suite at a time against the dev DB (`node -r dotenv/config`):

1. A PATCH that moves `event_date` with no `notify` list sends nothing AND still re-anchors
   every pending scheduled message and recomputes `balance_due_date`. This is the load-bearing
   test of the whole spec.
2. A PATCH with an `event_details_changed` notice and reviewed text sends exactly that text,
   not the template default.
3. An `event_details_changed` notice with no supplied text is a 400 **and the proposal is not
   saved**.
4. A `notify` entry whose type the save does not trigger (for example
   `event_details_changed` on a save that changed only the guest count) is a 400, and the
   transaction rolls back, so nothing is saved and nothing is sent.
5. `notify-preflight` and the save agree: a table-driven case per reschedulable field plus a
   non-booked status, asserting both paths compute the same notice set.
6. A supplied SMS body over 640 characters is rejected the same way `comms.js` rejects it.
7. A suppressed recipient (unsubscribed, `email_status = 'bad'`) reports skipped with a reason
   even when the notice was requested.
8. Record payment with `notify_client: false` sends no client receipt but still fires
   `notifyAdminCategory`.
9. A save that triggers both notices at once sends both, and the response reports per-channel
   truth for each.

Existing tests that assert the reschedule email fires on a bare PATCH must be updated to pass
the flag. No assertion gets weakened to make a test pass; if a test breaks in a way that is not
explained by the new contract, that is a finding, not a fixture problem.

Client: `CI=true react-scripts build` is the lint gate (`.husky/pre-push` runs it since
`client/` changes).

## Review posture

`proposals/crud.js`, `proposals/actions.js`, and the comms validators are on
`scripts/sensitive-paths.txt`. Full review fleet per lane before merge, plus the push-time
sensitive-path re-review and `/second-opinion` cross-LLM pass. Money-path smoke gate fires
(`server/` changed).

## Decisions and rejected alternatives

**Rejected: a "notify client" checkbox on each edit form.** Puts the decision in front of you
on every save including the hundreds that would never have sent anything, and each form grows
its own copy of the rule.

**Rejected: mirroring the reschedulable-field rule in React.** Guarantees eventual drift
between what the form thinks will send and what the server sends. The preflight round trip on a
form submit is cheap; a phantom popup or a silent send is not.

**Rejected: routing the notify path through SendModal.** Would drop the old-versus-new content
from the message. See "Why the draft is built at preflight".

**Rejected: a pending-notification marker.** An earlier draft had declining record what the
client had not been told, shown as a badge on the proposal page with a Notify button. Cut
because the dominant case is that Dallas already told them personally, so the badge would be
wrong most of the time and would train him to ignore it. Also cut the underlying old-value
snapshot table.

**Rejected: a Send receipt button on the payment row.** There is no payment history in the
admin UI. `proposal_payments` rows are never listed and no endpoint returns them, so this
button would drag a payment-history feature into a project about notification control. Logged
to the fix list as its own item. Mitigated by making Send receipt the primary button.

**Deferred, noted not fixed:** `actions.js:286` re-reads the just-inserted payment via
`SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1`
instead of `RETURNING id` on the INSERT. Under concurrent inserts that can link the wrong
payment to the invoice. It is adjacent to this work but not caused by it and not needed by it,
so it goes to the fix list rather than riding along.
