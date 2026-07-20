# Silent Shopping List Publish

Date: 2026-07-20
Status: approved, ready for plan

## Problem

Editing an approved shopping list flips `shopping_list_status` back to `pending_review`
(`server/routes/drinkPlans/shoppingList.js:109`). The public client view is gated on
`status === 'approved'` (`shoppingList.js:37`), so every edit hides the list from the client
until it is re-approved. The only re-approve path in the UI is "Re-approve & Send", which
always emails the client.

The result, seen live with Sid: editing the list while on the phone with him forced a
re-approve after each change so he could keep seeing it, and each re-approve emailed him.
The workaround (stop re-approving) leaves the list stuck in `pending_review`, hidden from
the client and sitting in the admin needs-review queue.

Editing does not notify. Re-approving does. The fix is a re-publish that skips the send.

## Scope

Add a silent publish to the shopping list approve flow: apply the approve side effects
(status flip, snapshot, Lab lock) and send nothing.

Available on every shopping list, whether or not it has been approved before.

Out of scope: any change to when edits reset status, to the public gating rule, or to the
existing "Approve & Send" flow.

## Server

### Request contract

`POST /api/comms/send` gains an optional `silent` boolean on the body.

When `silent === true`:

1. The action must declare `allowSilent: true`. Otherwise reject with
   `ValidationError({ silent: 'This action cannot be published without sending.' })`.
2. `channels` must be empty. A non-empty channel list alongside `silent` is rejected with
   `ValidationError({ channels: 'A silent publish cannot select channels.' })`, so there is
   no ambiguous half-silent state.
3. `retry` must not be true. Retry means resending a channel that failed, which has no
   meaning with nothing to send. Reject with
   `ValidationError({ retry: 'A silent publish cannot be a retry.' })`.
4. The empty-channel availability guard at `server/routes/comms.js:64-73` is skipped. That
   guard exists to catch an accidental no-op selection when a channel *is* available; a
   silent publish is that same shape on purpose.

When `silent` is absent or false, behavior is unchanged in every respect.

### Opt-in flag

`allowSilent: true` is declared on
`server/utils/comms/actions/shoppingListApprove.js` only. Every other action
(invoice send, portal invite, payment reminder, proposal resend, nudges, consult recap)
omits it and therefore rejects `silent`.

This is deliberate. `POST /api/comms/send` is the shared endpoint for money-adjacent sends.
A generic silent switch on that endpoint would let a caller flip invoice side effects
without notifying anyone. Per-action opt-in keeps the blast radius to the shopping list.

The flag follows the existing optional-flag pattern documented in the action contract
comment in `server/utils/comms/registry.js:1-21` (`minRole`,
`dispatchWithoutSideEffects`). Add `allowSilent` to that comment block. This is the one
edit to `registry.js`; the auto-discovery loop itself does not change.

### Downstream behavior

No change is needed in `dispatch()`. With an empty channel list,
`shoppingListApprove.dispatch` already sends nothing and populates `skip_reasons`
(`shoppingListApprove.js:174-188`).

`ensureSideEffects(entityId, { sentBy })` runs exactly as it does for a normal approve:
the guarded atomic UPDATE flips `pending_review` to `approved`, sets
`shopping_list_approved_at`, and writes `shopping_list_approved_snapshot`
(`shoppingListApprove.js:139-150`). `ensureNotFinalized()` still blocks approve after BEO
finalize, and a missing list still raises `ConflictError`.

Two consequences follow from reusing that path unchanged, both intended:

- The client's Enhancement Lab closes (`server/routes/drinkPlans/lab.js:58`).
- The needs-review badge and PrepQueue bucket clear, which is what gets the list out of the
  admin queue.

A silent publish on a list that is already `approved` and unedited applies nothing
(`applied: false`), sends nothing, and returns ok. It is a harmless no-op.

### Audit trail

No new message-log row and no new column. A silent publish writes nothing to
`message_log` because nothing was sent, and `shopping_list_approved_at` already records
when the list went live.

## Client

`client/src/components/ShoppingList/ShoppingListModal.jsx` gains a fourth footer button,
placed immediately before the existing approve button, styled `btn btn-secondary`.

### Behavior

A new `handleSilentPublish` mirrors `handleOpenSend` (`ShoppingListModal.jsx:321-354`) for
the pre-send save: cancel the debounce timer, clear `pendingSaveRef` before the await,
`PUT /drink-plans/:id/shopping-list` with the on-screen state, and restore the flush
safety net on failure. It then posts directly to `/comms/send` with
`{ action: 'shopping_list_approve', entityId: planId, channels: [], silent: true }`.

It does not open the SendModal.

### Label and confirmation

Driven by `wasApproved`:

- Already approved before this session: label "Update Client's Copy", fires immediately with
  no confirmation. This is the phone-call case and has to stay one click.
- Never approved: label "Publish Quietly", gated behind a single `window.confirm` reading:
  "Publish this list to the client without notifying them? They will not get a link, and
  their Enhancement Lab will close." One speed bump, once per plan, because publishing with
  no link and no ping is a real footgun the first time.

### State

Reuse `approveStatus`. The button is disabled unless `approveStatus === 'idle' && !sendOpen`,
matching the approve button. On success set `approveStatus` to `'published_quiet'`, which
renders "✓ Published quietly" on the silent button and leaves the approve button reading
"Re-approve & Send". Errors surface through the existing `approveError` span.

The `approvedLabel` chain (`ShoppingListModal.jsx:384-391`) is untouched; a silent publish
never sets `lastSend`, so it cannot make the approve button claim an email went out.

### Footer note

The footer note (`ShoppingListModal.jsx:601-604`) gains a `'published_quiet'` case:
"Published quietly. The client link is live and their Enhancement Lab window is closed.
They were not notified."

## Tests

Server, added to `server/routes/comms.test.js`:

1. Silent publish on a `pending_review` list flips status to `approved`, sets
   `shopping_list_approved_at`, and sends no email or SMS.
2. Silent publish is rejected for an action without `allowSilent` (400).
3. Silent plus a non-empty channel list is rejected (400).
4. Silent plus `retry: true` is rejected (400).
5. A normal (non-silent) send with an empty channel list on an action with an available
   channel is still rejected. This pins the existing guard so the new branch cannot
   weaken it.

Test suites run one at a time against the shared dev DB with `node -r dotenv/config`.

Client behavior is verified manually: edit an approved list, click "Update Client's Copy",
confirm the public link shows the new version and no email is sent.

## Non-goals

- No new DB column and no schema migration.
- No new comms action; this reuses `shopping_list_approve`.
- No "live session" auto-republish toggle. It is stateful, easy to leave on, and would let a
  later edit publish silently to a client who is not watching.
