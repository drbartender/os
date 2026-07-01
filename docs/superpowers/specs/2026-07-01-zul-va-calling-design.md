# Zul VA Calling — Telegram-triggered Twilio callback bridge

Date: 2026-07-01
Status: Design approved + spec-fleet reviewed (5 blockers / 6 warnings / 5 suggestions folded in), ready for implementation plan
Owner: Dallas

## Problem

Our Philippines-based VA (Zul) must place and receive US phone calls that work
**consistently**. Her home internet is bad *for voice* (VoIP drops, fuzzy audio).
The root cause is her connection, so any pure-VoIP app fails the same way. That is a
fixed constraint we design around, not something we can fix.

## Core insight / constraint

Real-time voice needs sustained low-latency bandwidth her link cannot hold, so the
voice path must **never ride her internet**. It rides her **cellular network** via a
Twilio callback bridge: Twilio calls her cell, she answers, Twilio bridges the second
leg to the other party. Her handset only ever makes/receives a normal cellular call.

The only thing that legitimately uses data is a tiny **trigger message** telling our
server "call this number." A few-KB chat message tolerates a weak connection far better
than a live audio stream and queues/retries until it lands. Trigger channel = Telegram.

## Goals

- Zul can **dial any US number someone hands her**, from her phone, without the company
  web app, with the other party seeing a US caller ID.
- Zul can **receive** calls to a US number, forwarded to her cell.
- Reliable on a poor PH mobile connection; cheap for Zul per use; low setup.

## Non-goals (this version)

- Voicemail / call recording (deferred to v2, see below).
- Zul texting US clients from her own number (stays in the OS comms system; no 10DLC).
- Cleaning up the 888 toll-free's stale voice webhook (separate task, Appendix).
- **Zul being a full admin is a separate, owner-approved decision, decoupled from this
  feature.** Calling needs zero admin rights (the bridge target is an env var, below).
  Dallas wants her to be an admin regardless; that grant can happen independently, now
  or later, and is out of scope for the calling build.

## Chosen architecture

### Numbers / identities

- **+1 (224) 222-0082** = Zul's US voice line. Voice+SMS capable, currently
  unconfigured. Clients call it (inbound) AND it is the caller ID on her outbound calls.
  No SMS-to-clients from it, so no 10DLC.
- **+1 (888) 231-4320** = existing company front + OS SMS from-number. Untouched here.
- **`VA_CELL`** = Zul's cell in strict E.164 (`+63…`), the bridge target. Stored as an
  **env var**, not on any DB record (the `users` table has no phone column, and the
  feature must not require one). Validated as strict E.164 with a leading `+`; do NOT run
  it through `normalizePhone` (that helper is US-centric and would mangle a PH number).

### Inbound (clients call Zul)

Client calls the 224 → Twilio hits `POST /api/voice/inbound` → we return TwiML
`<Dial timeout="20" callerId="<caller>"><Number>VA_CELL</Number></Dial>`. Caller ID
passes the *client's* number through so Zul sees who is calling; a short whisper is
optional. If Zul does not answer within the timeout, the call falls to her PH carrier
voicemail (acceptable for v1 since voicemail is deferred; missed-inbound capture is a v2
item). Inbound is signature-verified and subject to the same per-window flood cap as
outbound so a robocall storm to the public 224 cannot rack up PH per-minute forwarding.

### Outbound (Zul dials any number) — Telegram trigger + callback bridge

1. **One-time bootstrap:** Zul opens the bot and taps Start; we capture her numeric
   Telegram `user_id` via a one-time capture mode (see Bootstrap below) and set it as
   `TELEGRAM_ALLOWED_USER_ID`.
2. Zul sends the target number to the bot (any format).
3. `POST /api/telegram/<secret-path>` authenticates (secret path + `secret_token` header
   + `user_id` allowlist), then validates the target: `normalizePhone` **then a hard
   `+1`/NANP-only check** (reject non-US, reject 900/976 premium). On reject, the bot
   replies with guidance; nothing is dialed.
4. We upsert a **pending-call record** for Zul (`status='awaiting_confirm'`, target,
   short TTL) and the bot replies "Reply YES to call +1 312…". A new target sent before
   confirming **replaces** the pending record.
5. On her "YES" within TTL: **claim-then-call.** A conditional
   `UPDATE pending_call SET status='dialing' WHERE user_id=$1 AND status='awaiting_confirm'
   AND expires_at > now() RETURNING …` atomically claims the row and returns the target
   (also stores the `CallSid` after). Only if the claim wins do we call
   `client.calls.create({ from: 224, to: VA_CELL, url: <bridge>, statusCallback: <status>,
   timeLimit: <cap> })`. An expired/absent row → the bot says the request expired.
6. When Zul answers, Twilio fetches the bridge URL, which looks the target up **from the
   pending-call record by `CallSid`** (never from a request param) and returns
   `<Dial answerOnBridge="true" callerId="+12242220082" timeLimit="<cap>"><Number>+1TARGET`.
   She is connected; the target sees the 224; `answerOnBridge` gives real ringing.
7. **Status feedback:** `POST /api/voice/status` receives Twilio call-status callbacks; on
   a failed/unanswered leg (no-answer, busy, failed, canceled) the bot messages Zul
   "That call didn't connect, resend the number to retry." So she always learns the
   outcome rather than hearing silence.

## Security & correctness (money-moving, call-initiating endpoint)

This webhook dials billed international calls on an auto-refill account from external
input, so it is a toll-fraud target. Required, concrete guards:

1. **Webhook authenticity:** Telegram `secret_token` header
   (`X-Telegram-Bot-Api-Secret-Token`, set at `setWebhook`) **and** a secret,
   unguessable URL path. Reject on mismatch. The Twilio voice endpoints
   (`/inbound`, `/bridge`, `/status`) copy the `isValidTwilioRequest` gate from
   `server/routes/sms.js` (prod 403 on bad/missing signature). **Privileged actions are
   never honored on any dev signature-skip path.**
2. **Sender allowlist:** numeric `user_id` matched against `TELEGRAM_ALLOWED_USER_ID`,
   layered on top of #1, never instead of it.
3. **US-only target validation (in code):** after `normalizePhone`, require the result
   match `^\+1[2-9]\d{9}$` (NANP) and reject 900/976 premium. Twilio console geo is a
   backstop, not the guard. This is the primary toll-fraud control.
4. **Confirm-before-dial:** explicit "YES" within TTL required before any call. New
   target replaces the pending row; expired/absent → rejected with a message.
5. **Claim-then-call idempotency:** `calls.create` is an external HTTP call and cannot
   live in a DB transaction, so we do NOT "settle in the same transaction." Instead the
   conditional `UPDATE … WHERE status='awaiting_confirm' RETURNING` commits first; only
   the winning row dials; a Telegram retry (same or new `update_id`) or a crash-retry
   finds no claimable row and is a no-op. De-dupe Telegram `update_id` as a second layer.
6. **Spend caps (concrete):** per-call `timeLimit` = **1800s (30 min)** on both the
   `calls.create` and the bridge `<Dial>`. Rate: **max 5 triggers/minute and 40
   calls/day**, the daily cap **DB-backed** by counting `call_audit` rows in the last 24h
   (in-memory `express-rate-limit` is per-IP and every Telegram trigger shares one source
   IP, so it is useless as a daily cap). On cap trip, the bot tells Zul and no call is
   placed. Twilio account spend alerts remain a secondary backstop.
7. **Input safety:** never interpolate unescaped values into TwiML. **Extract the inline
   `xmlEscape` (currently local to the SMS `/inbound` handler, `& < >` only) into a
   shared `server/utils/xmlEscape.js`** and use it; the only interpolated value is the
   validated E.164 target in element text (never an attribute).
8. **Dev safety:** mirror the `SEND_NOTIFICATIONS` / `notificationsEnabled()` gate for
   `placeBridgedCall` so a dev server never dials the live account.
9. **Webhook heartbeat:** Telegram silently disables a webhook after repeated errors (or
   a stray `getUpdates` / second `setWebhook` / TLS lapse). A daily scheduler calls
   `getWebhookInfo`; if the URL is unset or `last_error_date` is recent, it re-runs
   `setWebhook` and emails the admin. Outbound-dead-until-noticed is thereby caught.
10. **PII:** redact dialed targets and `VA_CELL` to last-4 in all logs (match
    `smsInbound.js`'s `slice(-4)`). The `call_audit` table stores dialed-number PII;
    a purge scheduler prunes rows older than a retention window. Zul's real number lives
    only in `VA_CELL`, never committed to the repo.

## Components to build (integration points verified against current code)

1. **Voice router** — new `server/routes/voice.js`, mounted next to `/api/sms` in
   `server/index.js`.
   - `POST /api/voice/inbound` → TwiML `<Dial timeout callerId><Number>VA_CELL`.
   - `POST /api/voice/bridge` → looks up target by `CallSid` from `pending_call`, returns
     `<Dial answerOnBridge callerId=224 timeLimit><Number>+1TARGET`.
   - `POST /api/voice/status` → status-callback receiver; on failed/unanswered leg,
     messages Zul via the Telegram helper.
   - All three: `isValidTwilioRequest` gate + `text/xml`.
2. **Bridged-call helper** — `placeBridgedCall({ to, callerId, url, statusCallback, timeLimit })`
   in `server/utils/sms.js` (next to `sendSMS`), using the existing Twilio client's
   `calls.create` (net-new; only `messages.create` exists today). `to` is `VA_CELL`
   (strict E.164, not normalized). Gated on `notificationsEnabled()`.
3. **Telegram router** — new `server/routes/telegram.js`: `POST /api/telegram/<secret>`
   → verify `secret_token` header + `user_id` allowlist → validate/NANP-check the target
   → upsert/replace pending record → on "YES" claim-then-call → reply. JSON body.
4. **Telegram helper** — new `server/utils/telegram.js`: `sendTelegramMessage(text)` to
   Zul's chat, `setWebhook`/`getWebhookInfo` wrappers, `update_id` de-dupe helper. Uses
   `TELEGRAM_BOT_TOKEN`. No third-party lib required (raw HTTPS to the Bot API).
5. **Shared `xmlEscape`** — extract to `server/utils/xmlEscape.js`; update the SMS
   `/inbound` handler to import it (removes the duplicate).
6. **Schema** — in `server/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`):
   - `pending_call` (user_id, target_e164, status, call_sid, expires_at, created_at).
   - `call_audit` (id, triggered_by, target_e164, call_sid, status, created_at) for the
     daily cap count, spend/abuse audit, and status reconciliation.
   - `telegram_update` (update_id PRIMARY KEY, created_at) for retry de-dupe.
7. **Purge scheduler** — a prune job (mirror `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER`) that
   deletes expired `pending_call` rows and `call_audit`/`telegram_update` rows past
   retention, plus the daily webhook-heartbeat check (#9 above). New
   `RUN_VA_CALL_*` scheduler flags honored under the global `RUN_SCHEDULERS`.
8. **One-time user_id bootstrap** — a short-lived capture mode: with
   `TELEGRAM_ALLOWED_USER_ID` unset, the webhook logs and replies with the sender's
   `user_id` (and does nothing else), so Dallas reads it once, sets the env var, and
   redeploys. Documented in the plan as a runbook step.
9. **Env vars + docs** — new: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_ALLOWED_USER_ID`, `VOICE_CALLER_ID` (the 224), `VA_CELL`, and the new
   scheduler flags. Update `.env.example`, `render.yaml` (and set them in the Render
   dashboard). Per the Mandatory Documentation Updates table: env vars → **CLAUDE.md +
   README Environment Variables tables**; Telegram is a **new integration** → CLAUDE.md
   Tech Stack + README Tech Stack + ARCHITECTURE Third-Party Integrations; the new
   `voice.js`/`telegram.js` route files → README folder tree + ARCHITECTURE route table.

## Account setup (prerequisites, owner)

- **PH voice geo:** low-risk dialing ENABLED (done, verified via API). High-risk OFF.
- **Auto-refill + spend alert:** confirm auto-refill is on with headroom, and set a
  low-balance + monthly-spend email alert in the Billing console (console-only). Balance
  was thin (~$16.72); a dry balance would take SMS down with it.

## Voicemail (deferred, v2)

If pursued: `<Record>` TwiML + recording-status webhook; fetch recording server-side and
re-upload to R2 (store only the R2 key, never Twilio's public URL); a dedicated
`call_events` table (`message_log` has NOT NULL on both `proposal_id` AND `client_id`, so
it cannot hold anonymous inbound); a PII retention/purge scheduler; email-only "missed
call from X" alert. Cheapest first when it happens.

## Validation plan (before declaring done)

1. **Core bet — audio:** now that PH geo is on, place a test call from Twilio to Zul's
   cell and confirm it rings reliably with clean audio over several tries. If this fails,
   the whole approach is wrong.
2. **Telegram round-trip:** Zul messages the bot → confirm → her cell rings → bridged to
   a test target showing the 224 → status feedback on a deliberately-unanswered call.
3. **Inbound forward:** call the 224 → forwards to her cell within the timeout.
4. **Dev testing:** `setWebhook` needs a public HTTPS URL. Add a tunnel
   (ngrok/cloudflared) for the dev `:5000` server or test against prod with care.

## Open dependencies

- Zul installs Telegram and taps Start once (only hard dependency; confirmed OK).
- Owner confirms auto-refill + sets the Billing spend alert.
- A dev tunnel (or accept prod-only testing).

## Cost model

- To Zul: ~$0 per trigger (a few KB); no international-SMS charge.
- To DRB: $0 for the Telegram channel. Voice legs bill regardless of trigger: PH mobile
  termination ~$0.29/min dominates (both legs bill, per-minute round-up), US legs are a
  rounding error; `timeLimit` caps a runaway call. Fixed add is only the 224 rental
  (~$1.15/mo). Marginal cost = PH per-minute voice.

## Appendix: 888 stale voice (out of scope, flagged)

The 888 toll-free's voice webhook still points at
`drbartender.checkcherry.com/webhooks/twilio/message_received` (the migrated-off system).
Calls to the main company line are handled by CheckCherry. Its own decision (repoint to
Zul? an IVR? leave it?), tracked separately.
