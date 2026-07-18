# SMS chat on the client page + inbox received-ordering

Date: 2026-07-18
Status: Approved (Dallas)

## Problem

Two-way client SMS is currently only reachable from the standalone inbox at `/messages`. When you are looking at a specific client (say Cathy Murphy) on her detail page, you cannot read or answer her texts without leaving for the inbox and re-finding her thread.

Separately, the inbox conversation list sorts by last activity (the max `created_at` across both directions). Sending a reply bumps a thread you just handled to the top, while a client who is actually waiting on you sits lower. The list should surface who is waiting, not what you last touched.

## Goals

1. Read and answer a client's SMS thread directly on that client's detail page.
2. Sort the inbox by the most recent received (inbound) message, newest first.

## Non-goals

- No change to the storage model. `sms_messages` stays a flat table; a "thread" stays a runtime `GROUP BY client_id`.
- No new SMS endpoints. The existing `clientId`-keyed endpoints already do everything both surfaces need.
- No unread-pinning. Plain newest-received sort is sufficient.
- Staff SMS blasts (`/api/messages/*`, the staff-detail MessagesTab) are a separate feature and are untouched.

## Change 1: inbox received-ordering (server only)

File: `server/routes/sms.js`, the `GET /conversations` handler (currently lines 112 to 131).

Add a per-client `last_inbound_at` and sort by it:

```sql
(SELECT MAX(m2.created_at) FROM sms_messages m2
   WHERE m2.client_id = c.id
     AND m2.direction = 'inbound'
     AND (m2.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_inbound_at
...
ORDER BY last_inbound_at DESC NULLS LAST, last_message_at DESC
```

Notes:

- `NULLS LAST` is required. On a Postgres `DESC` sort NULLs sort first by default, which would put outbound-only threads (a client who never replied) at the top. They belong at the bottom.
- The secondary `last_message_at DESC` orders the outbound-only tail by recency among themselves.
- Keep returning `last_message_at` in the SELECT unchanged. It still drives the timestamp shown in the list. Only the sort key changes.
- The existing thumbtack-relay exclusion, unread count, and `EXISTS (any non-relay message)` membership test are all preserved.

No client change is required for this piece.

## Change 2: SMS chat on the client page

The thread and reply UI is currently inline inside `client/src/pages/admin/Messages.js` (message list at roughly lines 160 to 172, reply box at 174 to 189, with `openThread`, `handleReply`, mark-read, and auto-scroll logic scattered in the same file). Every endpoint it uses is keyed on `clientId` only:

- `GET /sms/conversations/:clientId` (thread, oldest-first)
- `POST /sms/conversations/:clientId/reply` (send)
- `PUT /sms/conversations/:clientId/read` (mark inbound read)

So the pane is portable with zero backend work.

### New shared component

Extract the thread pane into `client/src/components/ClientConversation.js`:

```
<ClientConversation
  clientId={number}
  clientPhone={string | null}
  onChanged={() => void}   // optional; fired after a successful send or mark-read
/>
```

Responsibilities the component owns internally:

- Fetch the thread for `clientId` and render the bubble list (reuses the existing `sms-messages` / `sms-bubble-<direction>` CSS classes from `client/src/index.css`; no new styling system).
- Auto-scroll to the newest message.
- Reply box (textarea plus Send button) posting to the reply endpoint, then re-fetch and mark-read.
- Fire `onChanged` after send and after mark-read so a host can refresh anything it owns.

Edge cases:

- No messages yet and a phone on file: show a short empty state ("No texts yet.") with the reply box active, so this doubles as a way to start a conversation.
- No phone on file: render the thread (if any) and disable the reply box with an inline hint ("No phone number on file.").

### Client detail page

File: `client/src/pages/admin/ClientDetail.js`.

Add a "Messages" card in the left column (the wide `1fr` column, below the "Proposals and events" card at lines 220 to 267) that renders `<ClientConversation clientId={client.id} clientPhone={client.phone} />`. `client.id` and `client.phone` are already in scope. The card holds the thread in a fixed-height scroll region so a long history does not blow out the page.

### Inbox refactor

File: `client/src/pages/admin/Messages.js`.

Replace the inline right-pane thread + reply markup and its handlers with `<ClientConversation clientId={selectedClientId} clientPhone={selectedThread.phone} onChanged={reloadConversations} />`. The left conversation list, selection, auto-open-first-thread, and unread badges stay in `Messages.js`; the list refresh is driven by the `onChanged` callback. This keeps a single source of truth so the inbox and the client page can never drift.

## Testing

- Server: unit/route test that `GET /sms/conversations` returns conversations ordered by newest inbound, that a fresh outbound reply does not reorder a thread ahead of a more recently received one, and that an outbound-only thread sorts to the bottom (not the top).
- Client: manual walk in local review. On a client with an existing thread, confirm the client-page card reads and sends and marks read; confirm the same actions in the inbox still work and refresh the list; confirm the no-phone client disables the reply box.

## Files touched

- `server/routes/sms.js` (ordering query)
- `client/src/components/ClientConversation.js` (new)
- `client/src/pages/admin/ClientDetail.js` (embed card)
- `client/src/pages/admin/Messages.js` (refactor to reuse)
