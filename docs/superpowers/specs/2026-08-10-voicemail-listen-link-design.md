# Voicemail listen link (Phase 1a.5), design

**Date:** 2026-08-10
**Status:** approved in brainstorm (Dallas, 2026-08-10)
**Relates to:** `2026-07-26-phone-system-redesign-design.md` (rev 3) — this is a
deliberate thin slice of that spec's Phase 1b, not a replacement for it.

## Problem

Phase 1a shipped and works: a missed call on the 1922 records a voicemail and
texts Dallas at the 312 with the caller's number, duration, and a timestamp. The
alert proves a message EXISTS but carries none of its content. Today the only
way to hear it is to open the Twilio console, find the call, and play it — which
is tedious enough that it will not happen.

Transcription was considered and REJECTED (Dallas, 2026-08-10): the spec's plan
needs a speech-to-text vendor plus an LLM call for summary and tag, i.e. two new
vendors, two keys, a cost line, and a kill switch. Twilio's own transcription
was raised as the no-new-vendor alternative and also declined. Hearing the
message is the requirement; reading it is not.

## What makes this cheap

Phase 1b's listen link assumed the Twilio recording is deleted as soon as an R2
copy exists, so a link REQUIRED R2 first. Phase 1a deliberately went the other
way: on the primary line the recording is RETAINED in Twilio (the alert text
carries only a number, so deleting the audio would destroy the only copy of the
content). The audio is therefore already sitting there. This design adds a way
to reach it and nothing else.

## Scope

**In:** a token on the ledger row, a public token-gated route that streams the
mp3, one extra line in the alert SMS.

**Out, and still Phase 1b's job:** R2 storage, transcription, AI summary and
tag, the rich listen PAGE (transcript, delete, soft-delete), the 14-day audio
purge, and re-pointing the redelivery sweep at R2. Nothing here blocks or
complicates any of it — the token column and the route guard are the same shapes
1b already specifies, so 1b changes where the bytes come from, not the contract.

## Design

### Schema

`voicemail_delivery` gains:

```sql
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS listen_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_voicemail_delivery_listen_token
  ON voicemail_delivery (listen_token);
```

Every row is born with a token, so nothing generates one in application code and
a backfill is unnecessary (existing rows get one from the DEFAULT). The column
name matches Phase 1b's declared ledger addition. `gen_random_uuid()` is
built into Postgres 13+; prod is 17.

### Route

A NEW router file, `server/routes/voicemailListen.js`, mounted at
`/api/voice/vm` BEFORE `/api/voice` (the `voiceLeadCall` / `voiceEscalate`
precedent). It does not live in `server/routes/voice.js`: that file sits at
exactly 700 lines, its soft cap, and this concern is independently reviewable.

`GET /api/voice/vm/:token`

1. `requireUuidToken('token')` (`server/utils/tokens.js`) so a non-UUID param
   404s before the DB rather than throwing 22P02 into a 500.
2. Look the row up BY TOKEN. Gate to `line = 'primary'` and
   `recording_sid IS NOT NULL`. Zul's rows carry a `recording_sid` whose audio
   was deleted after the Telegram upload, so they are excluded explicitly rather
   than left to fail at Twilio.
3. **The recording SID comes from the ROW, never from the request.** This is the
   line between a listen link and an open proxy into our Twilio account, and it
   is the single most important property of this route.
4. Fetch the mp3 server-side with the account credentials and return the bytes
   as `audio/mpeg`. The Twilio media URL and the credentials never reach the
   client. Reuse `voicemail.js`'s constructed-URL + basic-auth fetch, but with
   NO retry/backoff on 404 — a human is waiting on this response, and a missing
   recording is an answer, not a transient.

Tapping the link on a phone plays it in the browser. There is no HTML page;
that is 1b's.

### SMS

The alert body gains a final line carrying the URL. Everything else is unchanged.

Known cost: the extra line will usually push the alert from one SMS segment to
two. Fractions of a cent per voicemail, accepted deliberately.

### Kill switch

`VM_LISTEN_LINK_ENABLED`, default ON. With it off the route 404s and the SMS
omits the line. This is a public route serving a client's recorded voice; the
house pattern is that anything with that blast radius can be turned off without
a redeploy (`HARVESTER_ENABLED` precedent).

### Security model

- **The UUID is the auth.** Unguessable, but not secret: anyone holding the URL
  can hear the message. That is the accepted trade, and it is why the token is a
  v4 UUID and never a sequential id.
- **AMENDED DURING IMPLEMENTATION (2026-08-11):** this was originally justified
  as "identical to proposals, invoices, drink plans, and shopping lists."
  Security review rejected that comparison and it should not be reused. Those
  documents belong to their recipient, so a recipient-side leak exposes only
  their own data. Here the audio belongs to a THIRD PARTY who never asked for a
  link to exist. What actually makes a bare token acceptable is narrower: the
  link is only ever sent to `VM_TEXT_DESTINATION`, a single pinned operator who
  can already hear every voicemail in the Twilio console, so the link grants
  access nobody gained. If that recipient ever stops being the operator, this
  model must be revisited. The shipped code, `CLAUDE.md`, and `ARCHITECTURE.md`
  all state it this way.
- The link is delivered by SMS to `VM_TEXT_DESTINATION` (the 312, a Google Voice
  number), so it comes to rest in Google's message store alongside the caller's
  number, which that channel already carries.
- `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` so it is
  neither cached by intermediaries nor crawled.
- Rate limited per IP, with the trip returning 429 (no live caller is on this
  path, unlike the voice webhooks, so a bare status is correct here).
- No enumeration: an unknown token, a non-primary row, and a row whose recording
  is gone all return the SAME 404 with no body detail.

### Failure behavior

| Condition | Response |
|---|---|
| Non-UUID token | 404 (before any DB work) |
| Unknown token | 404 |
| `line = 'zul'` or `recording_sid IS NULL` | 404 |
| Recording deleted at Twilio / pruned row | 404, never a 500 |
| Kill switch off | 404 |
| Twilio credentials missing or 5xx | 502, logged, last-4 redacted |

### Lifetime

The link works as long as the row and the Twilio recording both exist. The row
is pruned at `RETENTION_DAYS` (30), so roughly a month.

**AMENDED DURING IMPLEMENTATION (2026-08-11).** The original decision was to
state this bound in the docs rather than enforce it, on the reasoning that a
second expiry mechanism is a second thing to get wrong. Security review
overturned it, and the reasoning was simply wrong on the facts: the prune
deliberately RETAINS rows in `recorded` / `failed` / `skipped` because their
audio is still undelivered at Twilio, so a token on any one of those rows would
never have expired at all. "The prune already bounds it" was false for exactly
the rows most likely to carry a live link. The route now enforces its own
30-day bound in its own SQL (`created_at > NOW() - '30 days'::interval`),
deliberately NOT borrowed from the prune's status allowlist, which is tuned to
a different question and would silently extend every link if edited.

Note the KNOWN 1a GAP this interacts with: the prune deletes the row while the
Twilio audio remains, orphaning that audio until 1b's purge lands. This design
does not make that worse (it neither creates nor deletes audio), and 1b closes
it.

## Testing

- `requireUuidToken` rejects a non-UUID before the DB (no 22P02).
- A valid token on a primary row streams `audio/mpeg` with the no-store and
  noindex headers.
- A zul-line row 404s.
- A row with a NULL `recording_sid` 404s.
- An unknown-but-valid UUID 404s, byte-identical to the zul-row 404 (no
  enumeration signal).
- The recording SID used for the fetch comes from the row: a request whose token
  belongs to row A can never retrieve row B's audio.
- Kill switch off: 404, and the SMS body omits the line.
- The SMS body contains the token exactly once and is otherwise unchanged.
- Schema: the column is NOT NULL with a UUID default, the unique index exists,
  and the DDL is re-runnable.

## Deferred

Everything in Phase 1b, unchanged.

**AMENDED DURING IMPLEMENTATION (2026-08-11).** Two items listed here as
deferred were BUILT, both on security review's finding:

- **HTTP Range support.** Deferred on the belief that its cost was only "cannot
  seek." That was wrong for the one client that matters: iOS Safari's media
  stack probes an `audio/mpeg` URL with `Range: bytes=0-1` and wants a `206`
  before it will play, so the real cost was likely "does not play on the
  operator's phone." The route implements `206`/`416` with a single ETag over
  the full representation.
- **An expiry shorter than the row prune.** See Lifetime above.
