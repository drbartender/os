# Voicemail on the 224 line, delivered to Telegram (design)

Date: 2026-07-22
Revision: 2 (folds in the `/review-spec` fleet: spec-grounding, spec-gaps, spec-risk)
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

**Carrier voicemail on `VA_CELL` is OFF** (confirmed by the owner, 2026-07-22).
This is load-bearing: if her PH carrier answered inside the 20 second ring,
Twilio would report `DialCallStatus=completed` and this entire feature would
never fire. `ARCHITECTURE.md:1555` currently says "unanswered → PH-carrier
voicemail (missed-inbound capture deferred to v2)". That line is stale and is
corrected as part of this change.

In the code:

- `voice.js:23-32` is a global inbound flood cap (`keyGenerator: () => 'global'`,
  default 30/min, `VA_INBOUND_PER_MIN_CAP`) that returns busy TwiML and never
  dials on trip. Note it is route-level middleware on `/inbound` only
  (`voice.js:88`), not router-level, and `server/index.js` mounts no global
  `/api` limiter. It does **not** automatically cover the new endpoints.
- `voice.js:53-68` `passesSignature` is prod-403 / dev-warn-and-allow.
  `server/routes/voiceLeadCall.js:62-71` `requireSignature` is the fail-closed
  variant with no dev skip, documented at `voiceLeadCall.js:9-12` as the policy
  for endpoints that "speak client PII and place billed calls". This spec uses
  the fail-closed one.
- `server/utils/twilioSignature.js:20` builds the signed URL from
  `req.originalUrl`, so query strings are covered by the HMAC.
- `voice.js:41-43` `__setVoiceDeps` is the DI seam every test uses.
- `server/utils/telegram.js:28-50` `sendTelegramMessage` is gated on
  `TELEGRAM_BOT_TOKEN` plus `notificationsEnabled()` (`telegram.js:30`) and
  **never throws**. It returns `{ok:false, skipped:true}` when gated or
  tokenless, `{ok:false, description}` on a Bot API error, and the raw Bot API
  JSON (with `ok:true`) on success. It also uses a bare `fetch` with no timeout.
- `server/utils/pendingCall.js:98` `claimDeadLegAudit` and `:116`
  `releaseDeadLegAudit` are the existing claim-before-send dedup pattern, backed
  by the partial unique index at `server/db/schema.sql:3584`.
- `server/utils/pendingCall.js:145` `pruneVaCallingRows` is the hourly sweep over
  `pending_call`, `call_audit`, and `telegram_update`, driven by
  `server/utils/vaCallingScheduler.js:95`.
- `server/utils/sms.js:1` loads the Twilio SDK and `sms.js:62` `placeBridgedCall`
  is the existing REST idiom, including the last-4 PII redaction convention.
- `server/utils/urls.js` exports `API_URL`. There is no shared `webhookBase()`;
  it is duplicated at `telegram.js:15` and `routes/telegram.js:53`. This spec
  uses `API_URL` from `urls.js`, the same source `voiceLeadCall.js` uses, and
  adds no third copy.
- Zul's callback loop: she sends a US number to the bot and replies `y`
  (`routes/telegram.js:41` `YES_RE`). Critically, `routes/telegram.js:205` runs
  `toUsE164` over the **entire message text**, and `normalizePhone` strips
  non-digits, so any other digits in the same message break the parse.
- `scripts/sensitive-paths.txt:48,49,52` lists `server/routes/voice.js`,
  `server/routes/telegram.js`, and `server/utils/sms.js`. It does **not** list
  `server/utils/telegram.js`, and `scripts/sensitive-match.js:17-20` anchors
  globs so they never cross `/`, meaning a new `server/utils/*.js` matches
  nothing. Both gaps are closed by this change.

## Design

### 1. The inbound dial gains an action URL

`POST /api/voice/inbound` keeps its limiter, its signature gate, its caller-ID
sanitizing, and its `timeLimit`. The only change is adding
`action="${API_URL}/api/voice/inbound/missed"` and `method="POST"` to the
`<Dial>`. When Zul answers, the caller experience is byte-for-byte what it is
today. The dialed number stays `VA_CELL` at `timeout="20"`; ring duration is
deliberately unchanged.

### 2. POST /api/voice/inbound/missed (new)

Fail-closed signature check first (`requireSignature`, no dev skip). Its own
rate limiter, since the `/inbound` limiter is route-level and does not cover it.

**Outcome branch on `DialCallStatus`:**

- `no-answer`, `busy`, `failed`, `canceled`: missed, continue below.
- Anything else, including `completed`, missing, empty, or unrecognized: return
  `<Response><Hangup/></Response>` and do nothing. The cheap branch is the
  default; only an explicitly-recognized miss can cost money.

**Caller identity.** The number comes from `req.body.From`. If it is absent,
empty, or Twilio's anonymous sentinel `+266696687`, the call is treated as a
blocked caller: `from_e164` is stored NULL and the ping says the number was
withheld. It must **never** fall back to `VOICE_CALLER_ID` the way
`voice.js:91` does for caller ID, since that would tell Zul to call the 224
back, which is the business's own line.

**Ledger claim (also the ping dedup).** `INSERT INTO voicemail_delivery
(call_sid, from_e164) ... ON CONFLICT (call_sid) DO NOTHING`. Only the request
that wins the insert pings and offers a recording. Twilio redelivers `<Dial
action>` requests, and without this a redelivery double-pings and issues a
second `<Record>`.

**Daily cap.** If `voicemail_delivery` already holds `VM_DAILY_CAP` rows in the
last 24h, return the bare `<Hangup/>` and log. The outbound side has
`VA_CALL_DAILY_CAP` for exactly this reason; the inbound side had no analog
because a missed call used to cost nothing after ring timeout. It now costs
ring plus greeting plus up to `VM_MAX_LENGTH_SEC` of billed recording and
storage, so the 30/min limiter alone leaves a storm ceiling around a thousand
dollars a day on a thin auto-refill balance. The cap gates the ping too: 30
misses a minute is 1800 Telegram messages an hour, which makes her phone
unusable exactly when she is under attack.

**Respond first, notify second.** The handler returns the TwiML and only then
fires the missed-call ping. `sendTelegramMessage` uses a bare `fetch` with no
timeout, so awaiting it inline would hold a live caller in dead air until
Twilio's webhook deadline, and they would then get no greeting at all. A
third-party notification outage must not become a caller-facing outage. The
send is additionally bounded with an `AbortSignal` timeout and its rejection is
caught and logged, never surfaced.

**Ping shape.** Two messages: one prose line naming the situation and the time
in `America/Chicago`, then the caller's number **alone in its own message**.
That second message is what makes "copy, paste, `y`" work, because
`routes/telegram.js:205` parses the whole message text and any stray digit in
the prose would break `toUsE164`. For a blocked caller, only the prose message
is sent.

**TwiML returned on a miss:**

```xml
<Response>
  <Say voice="Polly.Joanna-Neural">Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.</Say>
  <Record maxLength="{VM_MAX_LENGTH_SEC}" playBeep="true" trim="trim-silence" finishOnKey="#"
          recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"
          recordingStatusCallbackMethod="POST"
          recordingStatusCallbackEvent="completed"/>
  <Hangup/>
</Response>
```

`VM_MAX_LENGTH_SEC` is parsed and clamped to 30..300 (Twilio's own ceiling is
3600; nothing here wants a five minute voicemail). The exact neural voice name
is swappable in one line and gets a listen before the lane merges.

`<Record>` deliberately carries **no** `action` attribute. When a caller ends a
voicemail by hanging up, which is the normal case, Twilio does not request the
record verb's `action` URL. Delivery therefore hangs off
`recordingStatusCallback`, which does fire. Omitting `action` also means the
`<Hangup/>` runs normally when a caller ends with `#`.

No `transcribe` attribute. Transcription was considered and rejected in
brainstorm: English-only, mediocre quality, a per-minute charge on a thin
balance, and it arrives on a separate lagging callback. The one field that
matters, the caller's number, arrives free in the webhook body.

**Kill switch.** With `VOICEMAIL_ENABLED` off, this handler sends no ping and
returns a bare `<Hangup/>`. The switch suppresses the ping as well as the
recording, so flipping it off restores today's behavior completely rather than
leaving half the feature running.

### 3. Caller identity is carried in the ledger, not the URL

Revision 1 passed the caller's number in the recording callback's query string,
leaning on the fact that Twilio's HMAC covers `req.originalUrl`. That is sound
in production but was dropped, for two reasons the review surfaced. The
`beforeSend` scrubber in `server/index.js:9-35` filters `token=` and a fixed
list of path segments only, so `event.request.query_string` would have shipped
the full caller number to Sentry on any error in that handler, and the same
number would sit in Render and proxy access logs. And the recording handler
needs a durable row anyway (see below), so the query param bought nothing.

The number is written to `voicemail_delivery` at the missed step and looked up
by `CallSid` in the recording callback. Nothing caller-supplied travels in a
URL.

### 4. POST /api/voice/inbound/voicemail (new)

Fail-closed signature check, then, in order:

1. **Shape-validate before trusting anything.** `RecordingStatus` must be
   `completed`; a `failed` callback has no usable media. `RecordingSid` must
   match `^RE[0-9a-f]{32}$`. `RecordingUrl` from the body is **ignored
   entirely**: the media URL is constructed server-side from
   `TWILIO_ACCOUNT_SID` and the validated `RecordingSid`. Revision 1 fetched
   the body-supplied URL with the account's basic auth, which under the old
   dev-warn-and-allow policy let a forged callback point the server at any host
   and hand it `TWILIO_ACCOUNT_SID` plus `TWILIO_AUTH_TOKEN`. That token is the
   HMAC key for every Twilio webhook in the app, so the blast radius was the
   entire billed-voice surface. Constructing the URL ourselves removes the class
   of bug rather than allowlisting around it.
2. **Claim the delivery.** A conditional `UPDATE ... SET status='recorded',
   recording_sid=$1, duration_sec=$2 WHERE call_sid=$3 AND status IN
   ('missed','recorded') RETURNING from_e164`. Zero rows means another callback
   already owns this delivery, or the call was never registered as a miss;
   either way, no-op and return 204. This both dedups at-least-once callbacks
   and hands back the caller's number in the same round trip.
3. **Drop empties.** `RecordingDuration` arrives as a string; parse it, and
   treat absent or `NaN` as empty rather than falling through to an upload.
   Under 2 seconds is a robocall or a hangup on the beep: mark the row `empty`,
   delete the recording, done. She already has the ping with the number.
4. **Fetch.** `GET` the constructed `.mp3` URL via the existing Twilio SDK
   client rather than a hand-built request, with an explicit timeout. A 404
   immediately after the callback is a known race, so the fetch gets a small
   bounded retry with backoff. Permanent failures (401, 403, a persistent 404)
   and transient ones are distinguished in the log line.
5. **Upload.** Multipart `sendAudio` to the bot. Node 26 has `FormData` and
   `Blob` natively, so this is a plain `fetch` with no new dependency and no
   transcoding. Caption carries the caller's number, the time in
   `America/Chicago`, and the length.
6. **Define success explicitly.** `sendTelegramAudio` follows the house contract
   and never throws, so a try/catch is not a success test. There are three
   outcomes and they are not interchangeable:
   - `ok === true`: delivered. Set `status='delivered'`, `delivered_at=NOW()`,
     then `DELETE /Recordings/{RecordingSid}.json`. Telegram becomes the
     archive. A delete that itself fails is logged and ignored; the row already
     records delivery so nothing re-sends, and a stray recording costs cents.
   - `skipped === true` (gated off or no bot token): **not** a failure and
     **not** a success. Set `status='skipped'`, keep the recording, log, and do
     not page Sentry. `SEND_NOTIFICATIONS=false` is a documented production
     configuration (`CLAUDE.md:263`), and treating it as failure would mean a
     released claim, an undeleted recording, and Sentry noise on every call.
   - anything else: failure. Set `status='failed'`, keep the recording, send the
     text-only fallback naming the caller's number, and capture to Sentry.
     Losing the audio must not also lose the fact that someone called.

   The irreversible delete fires only on the affirmative `ok === true`. Revision
   1's "release the claim and let Twilio retry" was wrong twice over: the send
   primitive never throws so the path was dead code, and Twilio does not
   redeliver a recording callback it already answered with a 2xx, so nothing
   would have driven the retry anyway.

7. Always return 204. Every branch logs with the existing last-4 redaction
   idiom, matching `voice.js` and `voiceLeadCall.js`.

**Orphan sweep.** Rows left in `recorded` or `failed` past a short threshold are
picked up by the VA-calling scheduler, which retries delivery a bounded number
of times and then alerts once. This is what covers the crash-between-claim-and-
upload case: a process death after step 2 would otherwise strand the voicemail
forever with no retry and no trace, which matters more here than elsewhere
because step 6 is the only thing standing between the audio and deletion.

### 5. Schema

One idempotent table. It is a delivery ledger, not merely a dedup key, so the
business retains an internal record that a call happened, from whom, and whether
it was ever delivered, even though the audio itself is deleted after delivery.

```sql
CREATE TABLE IF NOT EXISTS voicemail_delivery (
  call_sid      TEXT PRIMARY KEY,
  from_e164     TEXT,
  recording_sid TEXT,
  duration_sec  INTEGER,
  status        TEXT NOT NULL DEFAULT 'missed'
                  CHECK (status IN ('missed','recorded','delivered','skipped','failed','empty')),
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voicemail_delivery_created_at
  ON voicemail_delivery (created_at);
```

`created_at` is both the daily-cap window filter and the prune key, mirroring
`idx_call_audit_created_at` (`schema.sql:3571`).

Pruned as a fourth batched delete inside `pendingCall.js:145`
`pruneVaCallingRows`, under the same `RETENTION_DAYS` and `PRUNE_BATCH_SIZE`
constants. The prune only removes terminal rows (`delivered`, `skipped`,
`empty`); a `failed` or stuck `recorded` row stays visible rather than being
quietly swept away.

## Guardrails

- `VOICEMAIL_ENABLED` defaults **off**. The feature ships dark and is flipped on
  in Render after the live call test, following the `LEAD_CALL_ENABLED`
  precedent, because the `<Dial action>` caller-hangup behavior below is
  asserted from memory and not yet verified.
- `VM_DAILY_CAP` bounds recording spend per rolling 24h, counted from
  `voicemail_delivery`.
- `VM_MAX_LENGTH_SEC` bounds per-call recording length, parsed and clamped.
- Both new endpoints fail closed on signature in every environment, and each
  carries its own rate limiter.
- The audio upload honors the same `notificationsEnabled()` gate as every other
  outbound send, so a dev server never posts real client audio into her chat.
- No caller-supplied value reaches an outbound request or a URL. The media URL
  is constructed from `TWILIO_ACCOUNT_SID` plus a shape-validated
  `RecordingSid`.
- Chat ids stay last-4 redacted (`telegram.js:20`); caller numbers follow the
  existing `slice(-4)` idiom in logs.

## Environment variables

| Variable | Purpose |
|---|---|
| `VOICEMAIL_ENABLED` | Kill switch for 224 voicemail. **Default off.** Off means the missed-call handler sends no ping and returns a bare `<Hangup/>`, exactly the pre-feature behavior. |
| `VM_MAX_LENGTH_SEC` | Max recording length in seconds (default 120, clamped 30..300). |
| `VM_DAILY_CAP` | Max voicemail-path calls per rolling 24h (default 50), counted from `voicemail_delivery`. On trip the missed handler returns a bare `<Hangup/>` and sends no ping. |

No new recipient variable. Delivery reuses `TELEGRAM_ALLOWED_USER_ID`. The new
util depends on `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, both already set.

Also register `VA_INBOUND_PER_MIN_CAP` in the env docs while there:
`voice.js:22` claims it is "registered in the env docs" and it is not, and this
spec promotes it to a primary spend guardrail.

## Files touched

- `server/routes/voice.js`: `action` on the existing `<Dial>`, plus the two new
  handlers. Currently 192 lines, so it stays inside the 700-line soft cap.
- `server/utils/telegram.js`: `sendTelegramAudio`, behind the same `_deps` seam
  and the same gating as `sendTelegramMessage`, plus an `AbortSignal` timeout.
- New `server/utils/voicemail.js`: media URL construction, fetch, delete, the
  ledger claim and status transitions, and the daily-cap count.
- `server/utils/pendingCall.js`: fourth batched delete in `pruneVaCallingRows`.
- `server/utils/vaCallingScheduler.js`: the orphan sweep.
- `server/db/schema.sql`: the `voicemail_delivery` table and index.
- `scripts/sensitive-paths.txt`: add `server/utils/telegram.js` and
  `server/utils/voicemail.js`. Neither matches an existing glob, so without this
  two of the files this change touches would be invisible to review-scaling,
  conflict-escalation, and auto-pull disqualification.

## Tests

Extend `server/routes/voice.test.js` through `__setVoiceDeps`. The existing
`/inbound` tests assert individual attributes by regex (`voice.test.js:71-90`),
so adding `action=` does not break them.

- Answered call (`DialCallStatus=completed`) sends no ping and returns no record
  verb.
- Missing or unrecognized `DialCallStatus` takes the `<Hangup/>` branch.
- Missed call pings Zul and returns greeting plus `<Record>` TwiML.
- The ping is two messages and the number one contains no other digits.
- Blocked caller (`From` empty and `From=+266696687`) records, stores NULL, and
  never emits `VOICE_CALLER_ID` as the callback number.
- Duplicate `<Dial action>` callback for one `CallSid` pings exactly once.
- Duplicate recording callback for one `CallSid` delivers exactly once.
- `RecordingStatus != 'completed'`, a malformed `RecordingSid`, and a
  body-supplied `RecordingUrl` pointing at a foreign host all fail to trigger
  any outbound fetch.
- Upload returning `{ok:false}` marks `failed`, skips the delete, and sends the
  text fallback. Upload returning `{skipped:true}` marks `skipped`, skips the
  delete, and does **not** page Sentry. Only `{ok:true}` deletes.
- Recording under 2 seconds, and a `RecordingDuration` that is absent or NaN,
  are dropped without upload.
- `VOICEMAIL_ENABLED=false` returns a bare `<Hangup/>` and sends nothing.
- `VM_DAILY_CAP` exceeded returns a bare `<Hangup/>` and sends nothing.
- Signature failure returns 403 with `NODE_ENV` unset (fail-closed, no dev skip).

## Documentation

- `CLAUDE.md`: env table gains the three new vars plus `VA_INBOUND_PER_MIN_CAP`;
  the `RUN_VA_CALLING_SCHEDULER` row at `CLAUDE.md:306` currently describes the
  prune as covering `pending_call`/`call_audit`/`telegram_update` and needs the
  fourth table plus the orphan sweep.
- `.env.example`: the three new vars, near the existing `TELEGRAM_*` (200-213),
  `VOICE_CALLER_ID` (217), and `VA_CELL` (222) block.
- `README.md`: env table (which already carries `VOICE_CALLER_ID:117` and
  `VA_CELL:118`), folder tree for the new util, and the `voice.js` tree entry at
  `README.md:252` that enumerates its routes.
- `ARCHITECTURE.md`: route table for the two new endpoints; Database Schema
  section for `voicemail_delivery`; the VA-calling block at 1107-1112; the
  Helper modules and Tables lines at 1558-1559; and the **stale inbound-flow
  line at 1555**, which claims missed inbound goes to PH-carrier voicemail and
  that capture is deferred to v2.

## Open item to verify during build

Whether Twilio requests a `<Dial action>` URL when the **caller** hangs up while
the dialed leg is still ringing. The "ping on every missed call" decision assumes
it does. This is asserted from memory, not verified, so the lane confirms it
against current Twilio docs and a live test call before the feature is
considered done. If there is a hole there, it comes back for a decision rather
than getting papered over. This is also why the feature ships dark.

## Rollout and live test

There is no local or staging path: dev fails closed on signature now, Twilio can
only reach `api.drbartender.com`, and `notificationsEnabled()` is false outside
production, so nothing would deliver. The first real exercise is therefore in
production, against Zul's real chat, with real deletion. Procedure:

1. Deploy with `VOICEMAIL_ENABLED=false`. Confirm the line behaves exactly as
   before.
2. Coordinate a window with Zul so she knows not to answer and expects test
   messages.
3. Flip `VOICEMAIL_ENABLED=true`. Owner calls the 224 from a cell, lets it ring
   out, leaves a short message.
4. Confirm: ping arrives with a copy-pasteable number, audio arrives and plays,
   the row reads `delivered`, and the recording is gone from the Twilio console.
5. Second call: ring out, hang up during the greeting without recording. Confirm
   the ping still arrives. This is the open item above.
6. Third call: answer it. Confirm no ping and no recording.
7. Listen to the synthetic greeting and decide whether to keep it or record one.

## Out of scope

- The 888's stale Check Cherry voice URL. Recorded above; the number may be
  dropped.
- The 312 Google Voice line (`client/src/utils/constants.js:4`), which has its
  own voicemail and cannot take TwiML without being forwarded into Twilio first.
- Transcription.
- Any second recipient. Zul only.
- Any change to `pending_call`, the toll-fraud caps on the outbound path, or the
  bridge dial path.

## Decisions locked in brainstorm

1. 224 only, not the 888.
2. Zul only, no second recipient, reusing `TELEGRAM_ALLOWED_USER_ID`.
3. Audio only, no transcription.
4. Synthetic voice now, a real recording is a one-line swap later.
5. Greeting copy as quoted above, including "This is Zul".
6. Ping on every missed call, not only when a message is left.
7. Delete the Twilio recording after confirmed delivery, where "confirmed" is
   now pinned to an affirmative `ok === true` and the ledger keeps an internal
   record of the call regardless.
