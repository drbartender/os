# Voicemail on the 224 line, delivered to Telegram (design)

Date: 2026-07-22
Status: approved in brainstorm (section-by-section)
Driver: a client who calls the 224 while Zul is away is hung up on. There is no
voicemail, no record the call happened, and no way for her to learn she missed
it. The 224 is the caller ID on every call she places, so inbound calls are
usually clients returning her call, which makes these missed leads.

## Problem

`server/routes/voice.js:88-97` answers an inbound call on the 224 with a single
`<Dial>` to `VA_CELL` at `timeout="20"`. When Zul does not pick up, the `<Dial>`
ends, the TwiML document runs out, and Twilio hangs up on the caller. Nothing is
recorded, nothing is stored, and no notification fires. `POST /api/voice/status`
(`voice.js:135-190`) does alert her on a dead leg, but that callback is wired to
outbound `calls.create` only, so it never runs for an inbound call.

## Current behavior (verified 2026-07-22)

Verified against the live Twilio account via the REST API on 2026-07-22:

- `+12242220082` has `voice_url = https://api.drbartender.com/api/voice/inbound`,
  `voice_method = POST`, `status_callback = null`, no fallback URL, no TwiML app.
  The null number-level status callback is load-bearing here: it confirms
  `/api/voice/status` cannot fire for an inbound call, so this work cannot trip
  the existing "that call didn't connect" alert at `voice.js:173`.
- `+18882314320` ("Dr. Bartender", the OS SMS line) still has its **voice** URL
  pointed at `https://drbartender.checkcherry.com/webhooks/twilio/message_received`,
  a decommissioned vendor. Out of scope here by decision (the number may be
  dropped), recorded so it is not lost.

In the code:

- `voice.js:23-32` is a global inbound flood cap (`keyGenerator: () => 'global'`,
  default 30/min, `VA_INBOUND_PER_MIN_CAP`) that returns busy TwiML and never
  dials on trip. It already sits in front of everything this spec adds.
- `voice.js:53-68` `passesSignature` is the shared gate: prod 403 plus a Sentry
  warning, dev warn-and-allow. `server/utils/twilioSignature.js:20` builds the
  signed URL from `req.originalUrl`, so the query string is covered by the HMAC.
- `voice.js:41-43` `__setVoiceDeps` is the DI seam every test uses.
- `server/utils/telegram.js:28-50` `sendTelegramMessage` is gated on
  `TELEGRAM_BOT_TOKEN` plus `notificationsEnabled()` (`telegram.js:30`) and never
  throws.
- `server/utils/pendingCall.js:98` `claimDeadLegAudit` and `:116`
  `releaseDeadLegAudit` are the existing claim-before-send dedup pattern, backed
  by the partial unique index at `server/db/schema.sql:3584`. This spec copies
  that shape rather than inventing one.
- `server/utils/pendingCall.js:145` `pruneVaCallingRows` is the hourly sweep over
  `pending_call`, `call_audit`, and `telegram_update`, driven by
  `server/utils/vaCallingScheduler.js:95`.
- `server/utils/sms.js:1` loads the Twilio SDK; `sms.js:62` `placeBridgedCall` is
  the existing REST-call idiom including the last-4 PII redaction convention.
- Zul's callback loop already exists: she sends a US number to the bot, the bot
  asks her to confirm, she replies `y` (`server/routes/telegram.js:41` `YES_RE`),
  and the bridge dials her and connects with the 224 as caller ID.
- `scripts/sensitive-paths.txt:48,49,52` already list `server/routes/voice.js`,
  `server/routes/telegram.js`, and `server/utils/sms.js` as billed-voice
  surfaces, so everything here is sensitive by default.

## Design

### 1. The inbound dial gains an action URL

`POST /api/voice/inbound` keeps its limiter, its signature gate, its caller-ID
sanitizing, and its `timeLimit`. The only change is adding
`action="{base}/api/voice/inbound/missed"` and `method="POST"` to the `<Dial>`.
When Zul answers, the caller experience is byte-for-byte what it is today.

The dialed number stays `VA_CELL` at `timeout="20"`. Ring duration is
deliberately unchanged.

### 2. POST /api/voice/inbound/missed (new)

Runs `passesSignature` first, same policy as the other three webhooks.

Reads `DialCallStatus`:

- `completed`: Zul took the call. Return `<Response><Hangup/></Response>` and do
  nothing else.
- `no-answer`, `busy`, `failed`, `canceled`: the call was missed.

On a miss, and with `VOICEMAIL_ENABLED` on, the handler does two things.

First it sends Zul the missed-call ping immediately, carrying the caller's number
in the format the bot's own trigger accepts, so her callback is copy, paste, `y`.
This fires whether or not a message is ever left. A caller who hangs up during
the greeting is still a lead.

Second it returns the greeting and the record verb:

```xml
<Response>
  <Say voice="Polly.Joanna-Neural">Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.</Say>
  <Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#"
          recordingStatusCallback="{base}/api/voice/inbound/voicemail?from=%2B1XXXXXXXXXX"
          recordingStatusCallbackMethod="POST"
          recordingStatusCallbackEvent="completed"/>
  <Hangup/>
</Response>
```

The exact neural voice name is swappable in one line and gets a listen before
the lane merges.

`<Record>` deliberately carries **no** `action` attribute. When a caller ends a
voicemail by hanging up, which is the normal case, Twilio does not request the
record verb's `action` URL. Delivery therefore hangs off
`recordingStatusCallback`, which does fire. Omitting `action` also means the
`<Hangup/>` runs normally when a caller ends with `#`.

No `transcribe` attribute. Transcription was considered and rejected in
brainstorm: English-only, mediocre quality, a per-minute charge on a thin
balance, and it arrives on a separate lagging callback. The one field that
matters, the caller's number, arrives free in the webhook body.

With `VOICEMAIL_ENABLED` off, this handler sends no ping and returns a bare
`<Hangup/>`. The kill switch suppresses the missed-call ping as well as the
recording, so flipping it off restores today's behavior completely rather than
leaving half the feature running.

### 3. Passing the caller number to the recording callback

A Twilio recording status callback carries `RecordingSid`, `RecordingUrl`,
`RecordingStatus`, `RecordingDuration`, and `CallSid`, but **not** `From`. Rather
than persist state between the two requests, the number rides in the callback
URL's query string.

That is safe because `twilioSignature.js:20` signs `req.originalUrl`, so a forged
`from` fails the signature check in production. Because dev warn-and-allows, the
handler still validates the value against a strict `+1` E.164 shape before using
it, and falls back to "unknown number" rather than trusting it, mirroring the
existing caller-ID handling at `voice.js:91`.

### 4. POST /api/voice/inbound/voicemail (new)

Runs `passesSignature`, then, in order:

1. **Claim before send.** `INSERT ... ON CONFLICT DO NOTHING` on `RecordingSid`.
   Only the request that wins the insert proceeds. Twilio callbacks are
   at-least-once, and without the claim a redelivery posts the same voicemail
   twice. Same pattern and reasoning as `pendingCall.js:98`.
2. **Drop empties.** `RecordingDuration` under 2 seconds is a robocall or a
   hangup on the beep. Skip the upload, delete the recording, done. She already
   has the ping with the number.
3. **Fetch.** `GET ${RecordingUrl}.mp3` with the account's basic auth.
4. **Upload.** Multipart `sendAudio` to the bot. Node 26 has `FormData` and
   `Blob` natively, so this is a plain `fetch` with no new dependency and no
   transcoding. Caption carries the caller's number, the time rendered in
   `America/Chicago`, and the length.
5. **Delete on success.** `DELETE /Recordings/{RecordingSid}.json`. Telegram
   becomes the archive. This keeps client voice off Twilio's storage bill and out
   of a third party permanently. A delete that itself fails is logged and
   ignored: the claim row still prevents a double send, and a stray recording
   costs cents.
6. **On failure.** Release the claim so a retry can re-deliver, do **not** delete
   the recording, send Zul a text-only Telegram message naming the caller's
   number and saying the audio did not come through, and report to Sentry.
   Losing the audio must not also lose the fact that someone called.

Always returns 204. Never a stack trace, never a non-2xx on a handled outcome.

### 5. Schema

One idempotent table, following the `telegram_update` shape at
`schema.sql:3592`:

```sql
CREATE TABLE IF NOT EXISTS voicemail_delivery (
  recording_sid TEXT PRIMARY KEY,
  call_sid      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Pruned by the existing hourly sweep, added as a fourth batched delete inside
`pendingCall.js:145` `pruneVaCallingRows` under the same `RETENTION_DAYS` and
`PRUNE_BATCH_SIZE` constants.

## Guardrails

- `VOICEMAIL_ENABLED` is the redeploy-free kill switch, default on, following the
  `HARVESTER_ENABLED` precedent.
- The existing global 30/min inbound limiter (`voice.js:23-32`) already caps how
  many calls can reach the voicemail path at all during a robocall storm.
- `maxLength="120"` caps per-call recording spend (`VM_MAX_LENGTH_SEC`).
- Both new webhooks go through `passesSignature`: prod 403, dev warn-and-allow.
- The audio upload honors the same `notificationsEnabled()` gate as every other
  outbound send, so a dev server never posts real client audio into her chat.
- Chat-id logging stays last-4 redacted (`telegram.js:20`); caller numbers follow
  the existing `slice(-4)` idiom in logs.

## Environment variables

| Variable | Purpose |
|---|---|
| `VOICEMAIL_ENABLED` | Kill switch for 224 voicemail. Default on. Off means the missed-call handler returns a bare `<Hangup/>` and the line behaves as it did before this feature. |
| `VM_MAX_LENGTH_SEC` | Max recording length in seconds (default 120). Per-call recording spend cap. |

No new recipient variable. Delivery reuses `TELEGRAM_ALLOWED_USER_ID`.

## Files touched

- `server/routes/voice.js`: `action` on the existing `<Dial>`, plus the two new
  handlers. Currently 192 lines, so it stays well inside the 700-line soft cap.
- `server/utils/telegram.js`: `sendTelegramAudio`, behind the same `_deps` seam
  and the same gating as `sendTelegramMessage`.
- New small util: Twilio recording fetch and delete, plus the claim and release
  pair, so neither `voice.js` nor `sms.js` bloats.
- `server/utils/pendingCall.js`: fourth batched delete in `pruneVaCallingRows`.
- `server/db/schema.sql`: the `voicemail_delivery` table.

## Tests

Extend `server/routes/voice.test.js` through `__setVoiceDeps`:

- Answered call (`DialCallStatus=completed`) sends no ping and returns no record
  verb.
- Missed call pings Zul and returns greeting plus `<Record>` TwiML.
- Duplicate recording callback for the same `RecordingSid` delivers exactly once.
- Failed upload releases the claim, skips the delete, and sends the text-only
  fallback.
- Recording under 2 seconds is dropped and never uploaded.
- `VOICEMAIL_ENABLED=false` returns a bare `<Hangup/>`.
- A `from` query param that fails the E.164 shape check does not reach the
  caption verbatim.

## Documentation

Env table in `CLAUDE.md`, route table in `ARCHITECTURE.md`, folder tree in
`README.md` for the new util.

## Open item to verify during build

Whether Twilio requests a `<Dial action>` URL when the **caller** hangs up while
the dialed leg is still ringing. The "ping on every missed call" decision assumes
it does. This is asserted from memory, not verified, so the lane confirms it
against current Twilio docs and a live test call before the feature is
considered done. If there is a hole there, it comes back for a decision rather
than getting papered over.

## Out of scope

- The 888's stale Check Cherry voice URL. Recorded above; the number may be
  dropped.
- The 312 Google Voice line (`client/src/utils/constants.js:5`), which has its
  own voicemail and cannot take TwiML without being forwarded into Twilio first.
- Transcription.
- Any second recipient. Zul only.
- Any change to `pending_call`, the toll-fraud caps, or the bridge dial path.

## Decisions locked in brainstorm

1. 224 only, not the 888.
2. Zul only, no second recipient, reusing `TELEGRAM_ALLOWED_USER_ID`.
3. Audio only, no transcription.
4. Synthetic voice now, a real recording is a one-line swap later.
5. Greeting copy as quoted above, including "This is Zul".
6. Ping on every missed call, not only when a message is left.
7. Delete the Twilio recording after confirmed delivery.
