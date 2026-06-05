# Sent Messages Log — Design Spec

**Date:** 2026-06-05
**Status:** Approved for planning (v2 — design-review findings folded in 2026-06-05)
**Surface:** Admin event detail page (`/events/:id`, served by `EventDetailPage`)

## Problem

Admin has no way to confirm that client-facing messages actually went out. The
headline client emails (proposal sent, drink plan / potion planner ready,
shopping list ready, payment receipts) are sent as fire-and-forget calls:

```js
sendEmail({ to: plan.client_email, ...tpl }).catch(emailErr => console.error(...))
```

Nothing is written to the database. If one of these silently fails (a Resend
hiccup, a bad address, the Resend daily quota cap), nobody finds out, because the
failure is swallowed by `.catch(console.error)` and there is no record the send
was even attempted.

By contrast, automated dispatcher touches (balance reminders, event-week,
event-eve, drip) already leave a row in `scheduled_messages`, and every SMS sent
through `sendAndLogSms` lands in `sms_messages`. So part of the picture exists in
the DB already, but it is fragmented across two tables with two different keys
(`scheduled_messages` keyed by proposal, `sms_messages` keyed by client), and the
emails the admin most wants to verify are not logged anywhere.

## Goal

A newest-first **Messages** card on the event detail page that shows what the
client was sent, on both channels, and whether each send succeeded or failed.
The admin should be able to take an action (send a proposal, generate a drink
plan, approve a shopping list), glance at the card, and see the resulting message
at the top with a green check or a red failure.

This reframes the feature from "nice audit view" to **confirm the send, and
surface the silent failures**. To show a failure, we have to record the attempt,
which means logging at send time.

## Core invariant: completeness

> If we ping a client, it shows up in the log.

This cannot be guaranteed by a hand-maintained list of callsites switched to a
logging wrapper. Some would be missed, and any client email added later would not
log until someone remembered to tag it.

So logging happens at the **send choke point**, not at the callsites:

- Every email in the app goes through `sendEmail` (confirmed: the only Resend
  single-sender; `sendBatchEmails` has no callers). This includes lead-marketing
  campaigns, which are excluded explicitly (see below), not by accident.
- Every SMS goes through `sendSMS` (verified: `routes/sms.js:145` admin reply and
  `routes/messages.js:104` manual send both call it, and `sendAndLogSms` calls it
  via its `_deps.sendSMS` seam). No client-facing SMS path bypasses it.

We log there, once, for everyone. There is no list to maintain. A new client email
shipped next month logs itself the day it goes live. Completeness is structural.

**Who counts as a client ping.** The logger resolves the recipient against the
`clients` table (by email or normalized phone). A match means it is a client ping
and gets logged. No match (staff, admin, a cold lead with no `clients` row) means
it is skipped. The "client-facing" decision is made by *who received it*, not by
remembering to tag the callsite. This automatically excludes staff shift reminders
and admin notifications without any per-callsite logic.

**Marketing is excluded explicitly, not by luck.** Lead campaigns and drip
sequences go through `sendEmail` too, so the recipient gate alone is not enough: a
former client who is also a lead would match a `clients` row and get a marketing
drip attached to a stale proposal. The three lead-campaign callsites
(`emailMarketing.js:492`, `emailMarketing.js:785`, `emailSequenceScheduler.js:93`)
pass `meta: { skipLog: true }`, and the logger returns early on that flag before
any resolution. Dispatcher client touches that are *about the event* (review
request, retention nudge) are not marketing in this sense and still log.

## Scope

**Logged (Scope B, both channels, all client-facing touches):**

- Transactional emails: proposal sent, proposal signed confirmation, drink plan
  ready / balance update, shopping list ready, deposit and balance receipts,
  signed-and-paid.
- Automated dispatcher touches: balance reminders, balance due, event-week,
  event-eve, T-30 recap, drink-plan nudge, post-event wrap-up, reschedule notice,
  review request, retention nudge.
- Client SMS: the SMS halves of the above, and admin replies to a client's inbound
  SMS (`routes/sms.js`).

**Depth: send-confirmation only.** Each row records what we knew at send time:
`sent` (accepted by Resend/Twilio) or `failed` (threw on our end: quota, bad
config, malformed). We do not track delivery, open, or bounce in v1. We *do* store
the provider id (Resend id / Twilio SID) on every row so delivery tracking can be
lit up later with no migration (see Future work).

## Non-goals (v1)

- Delivery / open / bounce tracking (provider id is stored, the webhook wire-up is
  deferred).
- Backfill of historical sends. The log starts empty and fills forward. The use
  case is "I just did something, did it fire," which is forward-looking. Archived
  proposals keep whatever rows they already accrued (archive is a status change,
  not a delete, so nothing is lost).
- A resend-from-timeline button. View only.
- An "upcoming / scheduled" preview. Sent-history only; the queue lives in
  `scheduled_messages`.
- Lead-marketing campaigns and drip (see Core invariant). Excluded via `skipLog`.
- Surfacing the same card on the proposal detail page (pre-conversion). Trivial to
  add later because the log is keyed by proposal id; not in v1.

## Data model

One purpose-built, append-only ledger, keyed by `proposal_id` (that id rides
through the proposal -> event conversion, so a row logged at proposal stage shows
on the event page after conversion).

```sql
CREATE TABLE IF NOT EXISTS message_log (
  id            SERIAL PRIMARY KEY,
  proposal_id   INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  channel       TEXT NOT NULL CHECK (channel IN ('email','sms')),
  message_type  TEXT NOT NULL DEFAULT 'other',   -- machine label: 'proposal_sent', 'drink_plan_ready', ...
  recipient     TEXT NOT NULL,                    -- email address or E.164 phone
  subject       TEXT,                             -- email subject line / SMS body preview
  status        TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error_message TEXT,                             -- populated on failure (truncated)
  provider_id   TEXT,                             -- Resend id / Twilio SID, for future delivery tracking
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_log_proposal
  ON message_log (proposal_id, created_at DESC);
```

Notes:
- `proposal_id` and `client_id` are both `NOT NULL`: the logger resolves both
  before inserting and returns early if either is missing, so a written row always
  has both. The constraint encodes that invariant.
- `created_at` is the send time, so the read is just `ORDER BY created_at DESC`.
- Append-only. Resending a proposal writes a second row (correct history). A
  `failed` row followed by a later `sent` row on a dispatcher retry is also correct
  history, not a duplicate to dedupe.
- `ON DELETE CASCADE`: proposals are archived, not hard-deleted, in normal
  operation; cascade only matters if one is ever truly deleted, and then the log
  should go with it.
- v1 status is `sent` / `failed` only. Dev / gated sends are not logged (see Edge
  cases), so there is no `skipped` state to store.

## Write path

A single shared helper does resolution and the insert. The two senders invoke it
**fire-and-forget** (not awaited) so it adds zero latency to the send and cannot
contend for the pool on the send's critical path.

### `server/utils/messageLog.js` (new)

```
logClientMessage({ channel, recipient, subject, status, error, providerId,
                   proposalId, clientId, messageType, skipLog }):
  try:
    if skipLog: return                // explicit marketing opt-out
    if !clientId:
      if channel === 'email':
        clientId = SELECT id FROM clients WHERE LOWER(email) = LOWER($recipient) LIMIT 1
      else:
        clientId = SELECT id FROM clients WHERE <normalized phone = normalizePhone($recipient)> LIMIT 1
                   -- mirrors idx_clients_phone_normalized
    if !clientId: return              // not a client ping, do not log
    if !proposalId:
      proposalId = SELECT id FROM proposals WHERE client_id = $clientId
                   ORDER BY created_at DESC LIMIT 1
    if !proposalId: return            // client has no proposal to attach to (rare, pre-event)
    INSERT INTO message_log (...) VALUES (...)
  catch e:
    console.error('[messageLog] log failed (send unaffected):', e.message)
    Sentry.captureException(e, { tags: { area: 'message_log' } })   // silent-failure visibility
    // resolves, never rethrows — safe to call un-awaited
```

`logClientMessage` always resolves (never rejects), so the un-awaited call from the
senders cannot produce an unhandled rejection. Resolution is one indexed lookup,
skipped entirely when explicit `clientId` / `proposalId` are supplied.
`clients.email` is uniquely indexed (`schema.sql:1220`), so email -> client is
unambiguous; phone resolution mirrors `idx_clients_phone_normalized`
(`schema.sql:1628`).

### `sendEmail` integration (`server/utils/email.js`)

- Add an optional `meta` to the signature:
  `sendEmail({ to, subject, html, text, from, replyTo, attachments, meta })`
  where `meta = { proposalId?, clientId?, messageType?, skipLog? }`.
- The existing Resend send logic stays byte-for-byte the same. Logging is a
  fire-and-forget post-step:
  - On success: `logClientMessage({ channel:'email', recipient: <primary to>,
    subject, status:'sent', providerId: data.id, ...meta })` (not awaited).
  - On Resend error: fire `logClientMessage({ ..., status:'failed', error })` (not
    awaited), then `throw` exactly as today, so existing `.catch()` callers behave
    identically (including the `QuotaExceededError` path).
  - On the dev / gated short-circuit (`{ id: 'dev-skipped' }`): return without
    logging (see Edge cases).
- Multi-recipient `to` (array): log against the first address only. Current client
  emails are single-recipient; the only multi-recipient caller is a staff/admin
  broadcast (`adminNotifications.js`), which resolves to no client and is skipped.
- The three lead-campaign callsites pass `meta: { skipLog: true }`.

### `sendSMS` / `sendAndLogSms` integration (`server/utils/sms.js`)

SMS logs at `sendSMS`, the verified choke point (every client SMS path reaches it),
so manual admin replies are captured, not just automated sends.

- Add optional `meta` to `sendSMS({ to, body, meta })`. On a real Twilio success,
  fire-and-forget `logClientMessage({ channel:'sms', recipient: to,
  subject: body.slice(0,140), status:'sent', providerId: message.sid, ...meta })`.
  On Twilio failure, fire the `failed` log then `throw`. On the dev / gated
  short-circuit, return without logging.
- `sendAndLogSms` keeps its `sms_messages` insert (the two-way SMS inbox, a
  separate concern) and threads context down:
  `_deps.sendSMS({ to, body, meta: { proposalId, clientId, messageType } })`. Add
  an optional `proposalId` param to `sendAndLogSms`. Because `sendSMS` is the only
  writer to `message_log`, there is no double-logging.
- The admin-reply path (`routes/sms.js`) passes `meta: { clientId }` (it already
  has the client) for exact client attribution.
- Staff sends (shift reminders, manual staff SMS) flow through `sendSMS`, resolve
  to no client, and are skipped. Correct.

### Attribution

- **Explicit context wins.** Headline transactional sends and the dispatcher pass
  `meta.proposalId` (and a clean `messageType`), so their rows attribute exactly
  and carry a friendly label.
- **Recipient resolution is the backstop.** Any client-addressed send that does not
  pass context still logs, attributed to that client's most recent proposal.

This is what delivers the completeness invariant: a forgotten or future send is
auto-captured rather than missing. The retrofit below is therefore optional
precision, not a completeness requirement.

### Optional precision retrofit (labels + exact attribution)

Pass `meta: { proposalId, messageType }` at the headline sends so rows read
"Proposal sent" instead of just the subject line, and attribute exactly even for
repeat clients: `sendProposalSentEmail.js`, `routes/drinkPlans.js` (drink-plan
ready / balance, shopping-list ready), `routes/drinkPlanConsult.js`,
`routes/stripe.js` (receipts), the signed-and-paid lifecycle send, and the
dispatcher email/SMS handlers (which already hold `entity_id` / `message_type`).
Untagged sends still show, labeled by their subject line (see UI).

## Read path

Fold a `messageLog` array into the existing `GET /proposals/:id` response. The
edit lands in `server/routes/proposals/crud.js` (the `router.get('/:id', auth,
requireAdminOrManager, ...)` handler): extend its existing `Promise.all` (which
already fetches `proposal_addons` and a `LIMIT 100` slice of `proposal_activity_log`)
with a `getMessageLogForProposal(id)` helper call (the helper returns the rows array
directly), and add `messageLog` to the `res.json`:

```sql
SELECT id, channel, message_type, recipient, subject, status, error_message, created_at
FROM message_log
WHERE proposal_id = $1
ORDER BY created_at DESC
LIMIT 100;
```

- The `LIMIT 100` mirrors the existing activity-log cap. A proposal exceeding 100
  messages (very unlikely; a proposal sees ~10-30 touches) would drop the oldest
  from the view. This is an accepted v1 cap, called out here rather than silent;
  pagination is future work.
- `provider_id` is internal and is not returned.
- The route is already guarded by `requireAdminOrManager`, so the array inherits
  admin-only access. The change is purely additive to the response shape; the other
  `/proposals/:id` consumers (payment panel, edit form) read named fields and ignore
  the new one.

### Refresh after action

The card reads `proposal.messageLog` and re-renders whenever the page refetches the
proposal. Coverage per client-message action on the event page:

- **Record payment (deposit/balance):** the payment panel already calls
  `refetchProposalOnly` on `onUpdate`, so the receipt row appears for free.
- **Drink-plan admin actions in `DrinkPlanCard`** (`generate`, `markReviewed`,
  `finalize`): the card today receives only `setDrinkPlan`, not a proposal reload.
  The plan passes the page's existing proposal-only refetch (`loadProposal`) down as
  a `reload` prop and calls it after those actions so any resulting row appears.
- **Shopping-list-ready email** fires from `PATCH /drink-plans/:id/shopping-list/approve`,
  whose UI is the admin `DrinkPlanDetail` page / public `ClientShoppingList`, NOT the
  event page's `DrinkPlanCard`. That row therefore surfaces on the next event-page
  load, not instantly. Acceptable (this is the "worst case page reload" path); we do
  not wire a reload into a surface that is not on this page.
- **Any other event-page send** calls the same `loadProposal` on success.

Worst case the card refreshes on a page reload. The plan must wire the
`DrinkPlanCard` reload prop explicitly; it is the one handler that does not already
refetch the proposal.

## UI

A **Messages** card on `EventDetailPage`, in the event-detail grid, rendering
`proposal.messageLog` newest-first.

```
┌─ Messages ──────────────────────────────────────────┐
│ ✉  Proposal sent          jane@email.com   2:14p  ✓ │
│ ✉  Drink plan sent        jane@email.com   2:15p  ✓ │
│ 💬 Drink-plan reminder     (555) 201-7788  Jun 3  ✓ │
│ ✉  Shopping list sent      jane@email.com  Jun 4  ✗ │  ← Failed: quota exceeded
│ ✉  Balance reminder        jane@email.com  Jun 4  ✓ │
└──────────────────────────────────────────────────────┘
```

The mockup shows the **retrofitted** state (clean labels). A row whose
`message_type` is `'other'` (an auto-captured send that did not pass an explicit
`messageType`) renders its stored `subject` line instead of a friendly label, for
example `✉ "Your Dr. Bartender shopping list" · jane@email.com · ✓`. Still
readable, just less tidy. Retrofitting the headline sends upgrades those rows to
labels.

- **Row:** channel icon, friendly label (or subject fallback), recipient, time,
  status chip.
- **Label:** `messageTypeLabel(message_type)` from a new client util
  `client/src/utils/messageTypes.js` (display-only, so no server twin to keep in
  sync, unlike `eventTypes`). Unknown / `'other'` types fall back to the stored
  `subject`, then to a humanized type string.
- **Failed rows:** red chip plus the `error_message` (tooltip or inline).
- **Empty state:** "No messages sent yet." (No separate loading or error state: the
  array arrives with the proposal payload, so there is no independent fetch to
  spin or fail.)
- New component file `client/src/pages/admin/eventDetail/MessageLogCard.js` (a new
  `eventDetail/` subdirectory, mirroring the route-split pattern) so
  `EventDetailPage` stays within file-size discipline.

Initial label map: `proposal_sent` -> "Proposal sent", `proposal_signed` ->
"Signed confirmation", `drink_plan_ready` -> "Drink plan sent", `drink_plan_nudge`
-> "Drink plan reminder", `shopping_list_ready` -> "Shopping list sent",
`payment_received` -> "Payment receipt", `balance_*` -> "Balance reminder",
`event_week_reminder` -> "Event week reminder", `event_eve` -> "Event eve
reminder", `reschedule` -> "Reschedule notice", `review_request` -> "Review
request".

## Security and privacy

- Read is admin-only, inherited from the `requireAdminOrManager` guard on
  `GET /proposals/:id`.
- Rows hold recipient PII (email / phone). The array is never exposed to the client
  portal (`EventCommandCenter`) or any public token route; those are separate
  endpoints (verified), not `/proposals/:id`.
- All queries parameterized. No secrets stored or logged.

## Edge cases

- **Logging never blocks or breaks a send.** The whole resolve-and-insert is inside
  one try/catch, the call is fire-and-forget, and `logClientMessage` always
  resolves. The send path returns and throws exactly as it does today.
- **Failed sends still log** (`status='failed'`, truncated `error_message`). This is
  the core value: a silent failure becomes a visible red row.
- **Resend quota** (`QuotaExceededError`) logs as `failed` with the quota message,
  then re-throws as before. If the dispatcher retries and the retry succeeds, a
  later `sent` row joins the `failed` one (correct history).
- **Swallowed log failure** goes to both `console.error` and Sentry, so a silently
  failing ledger is observable rather than invisible.
- **Lead who is also a client.** A marketing drip to a former client is excluded by
  the `skipLog` flag on the campaign callsites, so it never logs against their old
  proposal.
- **Dev / gated sends are not logged.** When notifications are gated off (the dev
  default) or creds are missing, `sendEmail` / `sendSMS` short-circuit and return
  without logging. Dev and prod share the Neon DB, so logging dev no-ops would
  pollute real events' logs. To exercise the feature locally, set
  `SEND_NOTIFICATIONS=true` against a scratch row (existing pattern).
- **Repeat-client fuzziness.** A send with no explicit context to a client who has
  two live events at once attributes to the most recent proposal, which may be the
  wrong one of the two. Headline and dispatcher sends pass explicit context and stay
  exact; only stray ad-hoc sends are fuzzy. Accepted for v1.
- **Client with no proposal yet.** Resolution finds no proposal, so the send is not
  logged (nowhere to attach). Rare and pre-event. Accepted.
- **Multi-recipient email.** Logged against the first recipient only.
- **Performance.** One indexed lookup per send when context is absent (skipped when
  present), run off the critical path; one indexed query per event-page load.
  Negligible at this app's volume.

## Future work (no migration required)

- **Delivery / open / bounce.** `provider_id` is already stored. Wire the Resend
  webhook (`emailMarketingWebhook.js`) to find the `message_log` row by
  `provider_id` and upgrade its status. Note the Resend payload field is
  `data.email_id`, not `data.id`. Add `delivered_at` / `opened_at` / `bounced_at`
  columns when needed. Same shape for a Twilio status callback.
- Backfill, resend-from-timeline, scheduled/upcoming preview, and the proposal-page
  card are all additive later.

## Files touched

- `server/db/schema.sql` — add `message_log` table + index (idempotent).
- `server/utils/messageLog.js` — new: `logClientMessage()` + resolution + Sentry.
- `server/utils/email.js` — add `meta` to `sendEmail`; fire-and-forget log on
  success/failure; no log on dev-skip.
- `server/utils/sms.js` — add `meta` to `sendSMS`; fire-and-forget log; add
  `proposalId` to `sendAndLogSms` and thread `meta` into `sendSMS`.
- `server/routes/emailMarketing.js`, `server/utils/emailSequenceScheduler.js` —
  pass `meta: { skipLog: true }` at the lead-campaign sends.
- `server/routes/sms.js` — pass `meta: { clientId }` on the admin reply.
- `server/routes/proposals/crud.js` — add the `message_log` query to the
  `GET /:id` `Promise.all` and `messageLog` to the response.
- `client/src/utils/messageTypes.js` — new: `messageTypeLabel()`.
- `client/src/pages/admin/eventDetail/MessageLogCard.js` — new: the card (new dir).
- `client/src/pages/admin/EventDetailPage.js` — render the card; pass a `reload`
  prop to `DrinkPlanCard`.
- Optional precision retrofit callsites (see above).
- `README.md` (folder tree incl. the new `eventDetail/` dir, key features) and
  `ARCHITECTURE.md` (schema: `message_log`) per the mandatory doc-update rules.

## Testing

- `logClientMessage` (the core, tested directly with a real/mock pool): resolves
  client by email and by normalized phone, picks the most recent proposal, inserts
  the row; returns silently (no row) when `skipLog` is set, when the recipient
  matches no client, or when the client has no proposal; never throws when the DB
  query fails (and reports to Sentry).
- `sendEmail`: fires the log with the provider id on success; fires a `failed` log
  and re-throws on Resend error; does not log on the dev-skip path. (Mock Resend +
  the messageLog module; assert the call, since the write is fire-and-forget.)
- `sendSMS`: same, asserting the log call on success/failure. Note the existing 12
  suites that stub `_deps.sendSMS` deliberately bypass `sendSMS`'s logging and are
  unaffected; they are not the coverage for this path. `sendAndLogSms` still writes
  its `sms_messages` row and threads `meta`.
- Run node:test suites in isolation against a scratch row per the project's
  shared-DB test discipline.

## Design-review notes (folded in 2026-06-05)

`/review-spec` fleet (grounding complete; gaps + risk coordinator-completed after
truncated runs). Changes made: corrected the false "`sendBatchEmails` is marketing"
claim and added the explicit `skipLog` exclusion for lead campaigns (Blocker 1);
settled SMS logging at the verified `sendSMS` choke point and fixed the testing
claim (Blocker 2); made the log write fire-and-forget off the send's critical path
(Warning 3); enumerated refresh-after-action coverage incl. the `DrinkPlanCard`
reload prop (Warning 4); clarified that un-retrofitted rows render the subject line
(Warning 5); pinned the read edit to `crud.js` and noted additive consumers
(Warning 6); made `client_id` / `proposal_id` `NOT NULL` to encode the resolution
invariant (Warning 7); routed swallowed log failures to Sentry (Suggestion 8);
noted `data.email_id` for future delivery tracking (Suggestion 9); flagged the
`LIMIT 100` cap explicitly (Suggestion 10); noted the new `eventDetail/` dir
(Suggestion 11); confirmed PII read-path is admin-only and portal/public routes are
separate (verified, Suggestion 12); documented the intended `failed`-then-`sent`
retry rows (Suggestion 13).
