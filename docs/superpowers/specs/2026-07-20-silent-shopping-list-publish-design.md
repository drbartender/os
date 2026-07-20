# Silent Shopping List Publish

Date: 2026-07-20
Status: approved (revised after design-fleet review), ready for plan

## Problem

Editing an approved shopping list flips `shopping_list_status` back to `pending_review`
and nulls `shopping_list_approved_at` on every save
(`server/routes/drinkPlans/shoppingList.js:109-118`, the PUT). The public client view is
gated on `status === 'approved'` (`shoppingList.js:46`), so every edit hides the list from
the client until it is re-approved. The only re-approve path in the UI is "Re-approve &
Send", which always emails the client.

Seen live with Sid: editing the list while on the phone with him forced a re-approve after
each change so he could keep seeing it, and each re-approve emailed him. The workaround
(stop re-approving) leaves the list stuck in `pending_review`, hidden from the client and
sitting in the admin needs-review queue.

Editing does not notify. Re-approving does. The fix is a re-publish that skips the send.

## Scope

Add a silent publish to the shopping list approve flow: apply the approve side effects
(status flip, snapshot, Lab lock) and send nothing. Available on every shopping list.

Out of scope: any change to when edits reset status, to the public gating rule, or to the
existing "Approve & Send" flow.

## Server

### Request contract

`POST /api/comms/send` gains an optional `silent` boolean on the body.

**Parse strictly: `body.silent === true`, identity, not truthiness.** A loose check would
let `silent: 1` or `silent: "false"` slip through and skip the empty-channel guard this
feature relaxes.

**All `silent` validation runs BEFORE `action.ensureSideEffects`.** In the live route,
`ensureSideEffects` fires at `server/routes/comms.js:97`, after the channel block. The
`silent` block goes in the same top region as the channel parse (`comms.js:63-73`), which
is upstream of `ensureSideEffects`. This ordering is the entire guard: if a `silent`
rejection landed *after* `ensureSideEffects`, then `{action:'invoice_send', silent:true}`
would flip `invoices.status` draft→sent
(`server/utils/comms/actions/invoiceSend.js:138-146`) and *then* 400 — the exact
"flip money side effects without notifying anyone" outcome the opt-in exists to prevent.

When `silent === true`, reject (all before `ensureSideEffects`) if any of:

1. The action does not declare `allowSilent: true` →
   `ValidationError({ silent: 'This action cannot be published without sending.' })`.
2. `channels` is non-empty →
   `ValidationError({ channels: 'A silent publish cannot select channels.' })`.
3. `retry === true` →
   `ValidationError({ retry: 'A silent publish cannot be a retry.' })`.

Otherwise the request proceeds with an empty `channels` list, skipping the empty-channel
availability guard at `comms.js:64-73` (that guard rejects an empty selection when a channel
*is* available, to catch an accidental no-op; a silent publish is that shape on purpose).

When `silent` is absent or not strictly `true`, behavior is unchanged in every respect.

### Opt-in flag

`allowSilent: true` is declared on
`server/utils/comms/actions/shoppingListApprove.js` only. No other action declares it, so
every other action (invoice send, payment reminder, portal invite, proposal resend, nudges,
consult recap) rejects `silent` at rule 1 above.

This is deliberate. `POST /api/comms/send` is the shared endpoint for money-adjacent sends.
A generic silent switch on that endpoint would let a caller flip invoice side effects
without notifying anyone. Per-action opt-in keeps the blast radius to the shopping list.

`allowSilent` follows the existing optional-flag pattern documented in the action-contract
comment in `server/utils/comms/registry.js:1-21` (`minRole`, `dispatchWithoutSideEffects`).
Add `allowSilent` to that comment block. This is the one edit to `registry.js`; the
auto-discovery loop does not change.

### Downstream behavior

No change is needed in `dispatch()`. With an empty channel list, `shoppingListApprove.dispatch`
takes the "not selected" branch for both channels, writes no ledger row, and sends nothing
(`shoppingListApprove.js:174-188`).

`ensureSideEffects(planId)` runs exactly as for a normal approve: the guarded atomic UPDATE
flips `pending_review` → `approved`, sets `shopping_list_approved_at`, and writes
`shopping_list_approved_snapshot` (`shoppingListApprove.js:137-162`). `ensureNotFinalized()`
still blocks approve after BEO finalize, and a missing list still raises `ConflictError`.

Two consequences follow from reusing that path unchanged, both intended:

- The client's Enhancement Lab closes (`server/routes/drinkPlans/lab.js:58`).
- The needs-review badge and PrepQueue bucket clear, which is what gets the list out of the
  admin queue.

A silent publish on a list already `approved` and unedited applies nothing
(`applied: false`), sends nothing, returns ok — a harmless no-op.

### Audit trail

**Known limitation, accepted:** a silent publish records no actor. `ensureSideEffects`
takes only `planId` and stamps `shopping_list_approved_at` (the *when*); the *who* is
normally captured on the `message_log` row written by the email send, which a zero-channel
publish never writes. This matches the existing hosted no-channel approve, which has the
same gap. The action is already gated by `auth`, `requireAdminOrManager`, and
`adminWriteLimiter`, and this is an internal publish, not money movement. If attribution is
wanted later, the upgrade is a single skipped `message_log` row carrying `sent_by`; not in
v1. No new column, no schema migration.

## Client

`client/src/components/ShoppingList/ShoppingListModal.jsx` gains one footer button (the
footer already renders up to four: Share Client Link, Close, Download PDF, Approve — this
makes five), placed immediately before the existing approve button, styled `btn btn-secondary`.

### State model

The design reuses the existing `approveStatus` state machine rather than adding a parallel
one. A silent publish lands on `approveStatus = 'approved'` — the truthful server state —
because that is what unlocks the repeat-edit loop:

- The debounced auto-save re-arms the buttons only when `approveStatusRef.current ===
  'approved'` (`ShoppingListModal.jsx:129`). Landing a silent publish on `'approved'` means
  the *next* edit re-arms to `'idle'` and sets `wasApproved` via that existing branch, with
  no change to the auto-save effect. A distinct status (e.g. `'published_quiet'`) would
  never match this check and would deadlock both footer buttons after one use — the exact
  Sid loop this feature exists to enable.
- `ClientPreview` already receives `approved={approveStatus === 'approved'}`
  (`ShoppingListModal.jsx:584`); landing on `'approved'` keeps the admin's preview tab
  truthful.
- The unmount-flush toast keyed on `'approved'` (`ShoppingListModal.jsx:152,159`) then
  correctly warns if the modal closes inside the debounce window after a quiet publish.

Two additions:

- **New state `lastPublishSilent` (boolean).** Set `true` on a successful silent publish;
  set `false` whenever a normal send sets `lastSend` (in `handleSendComplete`, guarded by
  `results.ok`). It exists so the approve button never claims a silent publish was emailed.
- **New prop `initialEverApproved` (boolean).** See "Label and confirmation".

`lastPublishSilent` and `lastSend` are mutually exclusive: a silent publish sets
`lastPublishSilent = true` and `lastSend = null`; a normal send sets `lastSend` and
`lastPublishSilent = false`.

### Button label truth

`approvedLabel` (`ShoppingListModal.jsx:384-391`) gains a leading branch:
`lastPublishSilent ? '✓ Updated, not sent' : <existing chain>`. This is the only edit to
the approve button's label; a silent publish therefore can never make it read "& Sent".

The silent button's own label:

- `approveStatus === 'saving'` → "Publishing…"
- `approveStatus === 'approved' && lastPublishSilent` → "✓ Updated" (disabled)
- otherwise → the label from "Label and confirmation" below.

### Label and confirmation

Whether the client has *ever* seen this list drives the copy. The durable signal is
`shopping_list_approved_snapshot IS NOT NULL` — the PUT that reverts an edited list to
`pending_review` nulls `shopping_list_approved_at` but does **not** clear the snapshot, so
`approved_at` cannot answer "ever approved" and the snapshot can.

- `GET /api/drink-plans/:id/shopping-list` (`shoppingList.js:80-91`) adds
  `shopping_list_approved_snapshot IS NOT NULL AS ever_approved` to its SELECT and returns
  `ever_approved`. It does not return the snapshot blob itself. The only consumer of this
  admin GET is `ShoppingListButton.jsx:34-40`, which passes it down as `initialEverApproved`.
- Derived in the modal: `hasBeenPublished = initialEverApproved || wasApproved ||
  lastPublishSilent`. (`wasApproved` is session state, set only by the auto-save re-arm at
  `ShoppingListModal.jsx:131`, i.e. approved-then-edited *this session*; it is not a
  prior-approval signal on its own, which is why `initialEverApproved` is needed.)

Behavior when the silent button is enabled (`approveStatus === 'idle' && !sendOpen`):

- `hasBeenPublished === true` → label "Update Client's Copy", fires immediately, no
  confirmation. Covers Sid's case and any previously-live list, including one stuck in
  `pending_review` from a prior edit session.
- `hasBeenPublished === false` → label "Publish Quietly", gated behind one
  `window.confirm`: "Publish this list to the client without notifying them? They will not
  get a link, and their Enhancement Lab will close." Publishing with no link and no ping is
  a real footgun exactly once per plan (first time the list goes live), so it gets one speed
  bump. Because the first successful quiet publish sets `lastPublishSilent` and, on the next
  fetch, `ever_approved`, the confirm never re-fires for that plan.

### Handler

A new `handleSilentPublish` mirrors `handleOpenSend` (`ShoppingListModal.jsx:321-354`) for
the pre-send save, with one correction: it holds `approveStatus = 'saving'` across *both*
requests (`handleOpenSend` returns to `'idle'` before opening the SendModal; mirroring that
literally would re-enable the button during the in-flight POST and allow a double-submit).

Steps:

1. Cancel the debounce timer, clear `pendingSaveRef` before the await (same guard as
   `handleOpenSend`), set `approveStatus = 'saving'`.
2. `api.put('/drink-plans/:id/shopping-list', ...)` with the on-screen state (via
   `api`, never raw fetch/axios).
3. `api.post('/comms/send', { action: 'shopping_list_approve', entity_id: planId,
   channels: [], silent: true })`. **Wire key is snake_case `entity_id`** — the route reads
   `body.entity_id` (`comms.js:30`) and 400s on anything else; `entityId` is the React prop
   name, not the wire key.
4. Success → `setLastSend(null); setLastPublishSilent(true); setApproveStatus('approved')`.
5. Failure → `setApproveStatus('idle')` and set `approveError` to copy that names the
   consequence: "Publish failed. The list is not live for the client right now. Click to
   retry." The step-2 PUT has already reverted the list to `pending_review` (as any edit
   does), so an honest error must say the client's page is showing the pending screen, and
   the re-enabled button is the retry.

The existing "Cancel there means nothing happened" property of `handleOpenSend` is
unaffected: this handler never opens the SendModal.

### Footer note

The footer note (`ShoppingListModal.jsx:601-604`) gains a silent-publish case (keyed on
`lastPublishSilent`): "Updated quietly. The client link is live with the new version and
their Enhancement Lab window is closed. They were not notified."

## Tests

`server/routes/comms.test.js` drives the action layer directly via `getAction()` and stands
up no router, so it cannot host route-level assertions. The four route tests below go in a
route-level HTTP harness following the existing pattern (hand-rolled `express()` + `node:http`
+ dev JWT, as in `server/routes/proposals/crud.test.js` / `server/routes/beo.test.js`):

1. Silent publish on a `pending_review` list flips status to `approved`, sets
   `shopping_list_approved_at`, and sends no email or SMS.
2. Silent publish is rejected for an action without `allowSilent` (400) **and**
   `invoices.status` for that invoice is still `'draft'` afterward — this pins the
   rejection-before-`ensureSideEffects` ordering, the load-bearing guard.
3. Silent plus a non-empty channel list is rejected (400).
4. Silent plus `retry: true` is rejected (400).

Plus, in `comms.test.js` (action-level, where it belongs): the existing non-silent
empty-channel guard still rejects when a channel is available (pins that the new branch did
not weaken it).

Suites run one at a time against the shared dev DB with `node -r dotenv/config`.

Client behavior is verified manually: edit an approved list, click "Update Client's Copy",
confirm the public link shows the new version and no email is sent.

## Documentation

- `ARCHITECTURE.md` `POST /send` contract section (~:237) and action-contract section
  (~:1113-1120): document `silent` and `allowSilent`.
- No `README.md`, `CLAUDE.md`, env-var, or new-integration changes (no new files, routes,
  env vars, or npm scripts).

## Cross-cutting

- `GET /:id/shopping-list` response gains `ever_approved`. Additive; its one consumer
  (`ShoppingListButton.jsx`) reads named keys, so existing behavior is unaffected. No other
  reader of that endpoint exists.
- No schema change: no new column, no migration.

## Non-goals

- No new DB column and no schema migration.
- No new comms action; this reuses `shopping_list_approve`.
- No "live session" auto-republish toggle. It is stateful, easy to leave on, and would let a
  later edit publish silently to a client who is not watching.
- No actor attribution in v1 (see Audit trail).
