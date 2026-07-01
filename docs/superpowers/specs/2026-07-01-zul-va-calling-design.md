# Zul VA Calling — Telegram-triggered Twilio callback bridge

Date: 2026-07-01
Status: Design approved (brainstorm complete), ready for implementation plan
Owner: Dallas

## Problem

Our Philippines-based VA (Zul) must place and receive US phone calls that work
**consistently**. Her home internet is bad *for voice* (VoIP drops, fuzzy audio).
The root cause is her connection, so any pure-VoIP app fails the same way. That is a
fixed constraint we design around, not something we can fix.

## Core insight / constraint

Real-time voice needs sustained low-latency bandwidth her link cannot hold. So the
voice path must **never ride her internet**. It rides her **cellular network** via a
Twilio callback bridge: Twilio calls her cell, she answers, Twilio bridges the second
leg to the other party. Her handset only ever makes/receives a normal cellular call.

The only thing that legitimately *can* use data is a tiny **trigger message** telling
our server "call this number." A few-KB chat message tolerates a weak connection far
better than a live audio stream and queues/retries until it lands.

## Goals

- Zul can **dial any US number someone hands her**, from her phone, without using the
  company web app, with the other party seeing a US caller ID.
- Zul can **receive** calls to a US number, forwarded to her cell.
- Reliable on a poor PH mobile connection; cheap for Zul per use; low setup.

## Non-goals (this version)

- Voicemail / call recording (deferred to v2, see below).
- Zul texting US clients from her own number (stays in the OS comms system; keeps us
  off 10DLC entirely).
- Cleaning up the 888 toll-free's stale voice webhook (separate task, see Appendix).

## Chosen architecture

### Numbers

- **+1 (224) 222-0082** = Zul's US voice line. Voice+SMS capable, currently
  unconfigured. It is the number clients call (inbound) AND the caller ID on her
  outbound calls. No SMS-to-clients from it, so no 10DLC needed.
- **+1 (888) 231-4320** = existing company front + OS SMS from-number. Untouched here.
- Zul's cell: **+63 905 365 2784** (the physical endpoint; we test with her current
  phone before considering a dedicated device).

### Inbound (clients call Zul)

Client calls the 224 → Twilio hits our voice webhook → we return TwiML
`<Dial><Number>+63…</Number></Dial>` to her cell over PSTN. Optional short whisper so
she knows it is a business call. Voice is 100% cellular on her end.

### Outbound (Zul dials any number) — Telegram trigger + callback bridge

1. One-time: Zul opens our Telegram bot and taps Start (bots cannot message a user who
   has not started them). We capture her numeric Telegram `user_id`.
2. Zul sends the target US number to the bot (any format; 10-digit or +1).
3. Our webhook authenticates the request, normalizes the number to E.164, and replies
   with a **confirm-before-dial** prompt echoing the parsed number.
4. On her confirmation, we call the Twilio REST API
   `client.calls.create({ from: 224, to: Zul's cell, url: <bridge TwiML> })`.
   **Note:** TwiML `<Dial>` cannot *originate* a call — the REST Calls API must. This
   is the load-bearing correction to the original "2 endpoints" framing.
5. When Zul answers, Twilio fetches the bridge URL, which returns
   `<Dial answerOnBridge="true" callerId="+12242220082"><Number>+1TARGET</Number></Dial>`.
   She is connected to the target, who sees the 224. `answerOnBridge` means the target
   hears real ringing, not dead air, and call status distinguishes answered vs voicemail.

### Why Telegram (over the alternatives we tested)

- **PH-cell SMS → US 224:** FAILED a live test (her texts never reached Twilio; verified
  in the message logs while other inbound landed fine) *and* costs her ~$0.26/international
  text. Disqualified on both reliability and cost.
- **Local PH Twilio number (domestic SMS):** Twilio's PH numbers are geographic
  landline-type numbers that PH mobiles generally cannot SMS, and buying one needs a PH
  regulatory bundle (DTI/SEC + Mayor's-permit address) DRB cannot satisfy. Near-disqualified.
- **WhatsApp (Twilio):** technically equal to Telegram, but production requires Meta
  Business Verification (~1–2 weeks) — the onboarding the owner rejected. **Runner-up**
  if an "official" channel is ever wanted.
- **Facebook Messenger:** zero-rated on PH carriers (free even on tight data). Keep as a
  **pre-buildable fallback** only if Zul's data proves genuinely metered.
- **Telegram bot:** wins on all three priorities — reliable data trigger, ~$0 for Zul and
  $0 for DRB, and the lowest setup of any data channel (BotFather token + one `setWebhook`,
  no business verification).

## Security & correctness (this is a money-moving, call-initiating endpoint)

The webhook dials real calls on an auto-refill Twilio account, so it is a toll-fraud
target. The naive "allowlist the Telegram user_id" is a **security regression** by itself
(the webhook is a public URL; `message.from.id` is a spoofable plaintext field). Required
hardening:

1. **Webhook authenticity:** Telegram `secret_token` header
   (`X-Telegram-Bot-Api-Secret-Token`, set at `setWebhook` time) **and** a secret,
   unguessable URL path. Reject anything missing/mismatched. This replaces the
   `X-Twilio-Signature` check that guards the SMS webhook (different provider, same intent).
2. **Sender allowlist:** numeric `user_id` matched against an allowlisted value (Zul).
   Layered on top of #1, not instead of it.
3. **Confirm-before-dial:** an explicit confirmation reply is required before any call is
   placed, preventing both spoofed and wrong-number calls. The echoed number must be shown
   *before* dialing.
4. **Idempotency:** Telegram retries updates on a non-200 response. De-dupe on
   `update_id` and settle the trigger in the **same unit of work** that places the call, so
   a retry cannot double-dial. (Mirror the atomic-settle precedent in `smsInbound.js`'s
   CANT handler.)
5. **Input safety:** normalize/validate the target to clean E.164 (reuse `normalizePhone`);
   reject anything else; never interpolate raw user text into TwiML XML (reuse the
   `xmlEscape` pattern). Leave Twilio high-risk geo ranges OFF.
6. **Rate limiting + audit log:** a per-trigger audit record and a sane cap (per-minute and
   per-day) as a spend/abuse backstop, independent of Twilio's notify-only spend alerts.
7. **Dev safety:** a `SEND_NOTIFICATIONS`-style gate so a dev server never places real calls
   on the live account; and never honor a privileged trigger on any dev signature-skip path.
8. **Webhook heartbeat:** Telegram silently disables a webhook after repeated errors (or a
   stray `getUpdates`/second `setWebhook`/TLS lapse). Add a lightweight liveness check so
   silent deregistration is caught.

The Twilio **voice** endpoints (inbound + bridge) copy the `isValidTwilioRequest`
signature gate from `server/routes/sms.js` (prod 403 on bad/missing signature; dev warns),
set `Content-Type: text/xml`, and rely on the existing `trust proxy` for correct https URL
reconstruction behind the host.

## Components to build (integration points from code investigation)

1. **Voice router** — new `server/routes/voice.js`, mounted next to the SMS route in
   `server/index.js` (the `app.use('/api/sms', …)` mount).
   - `POST /api/voice/inbound` → TwiML `<Dial><Number>` to Zul's cell.
   - `POST /api/voice/bridge` → TwiML `<Dial answerOnBridge callerId=224><Number>target`.
   - Twilio signature validation + `text/xml`.
2. **Bridged-call helper** — `placeBridgedCall({ to, callerId, url })` in
   `server/utils/sms.js` (next to `sendSMS`), using the existing Twilio client's
   `calls.create` (net-new; only `messages.create` is used today). Reuse `normalizePhone`.
   Gate on the dev-safety flag.
3. **Telegram router** — new `server/routes/telegram.js`:
   `POST /api/telegram/<secret-path>` → verify `secret_token` header + user_id allowlist,
   parse the number, run the confirm-before-dial state machine, then call
   `placeBridgedCall`. JSON body (not Twilio form-encoded).
4. **Telegram send helper** — small helper to `sendMessage` back to Zul (confirm prompt,
   "connecting…", errors).
5. **Confirm-before-dial state** — short-lived per-user pending-call record (DB-backed so it
   survives restarts; single user, tiny). Holds "Zul proposed +1TARGET, awaiting confirm,"
   with a short TTL.
6. **Zul as a full admin user** — create her OS admin account (same rights as Dallas), with
   her cell +63 905 365 2784 stored on the record. Her cell is the bridge target and (if we
   ever add an SMS fallback) the sender identity.
7. **Env vars + docs** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_ALLOWED_USER_ID`, `VOICE_CALLER_ID` (the 224), `VA_CELL` (or read from her
   admin record), dev-safety gate. Update `.env.example`, `render.yaml` (and set the same in
   the Render dashboard), and the CLAUDE.md/README/ARCHITECTURE route table per repo convention.

## Account setup (prerequisites)

- **PH voice geo:** low-risk dialing ENABLED (done, verified via API). High-risk tiers OFF.
- **Balance / auto-refill:** balance is thin (~$16.72); confirm auto-refill is on with
  headroom (owner, Billing console). International voice draws it down and a dry balance would
  take SMS down with it.
- **Spend alert:** set a low-balance + monthly-spend email alert in the Billing console
  (the clean email alert is console-only; the API version needs a callback endpoint).

## Voicemail (deferred, v2)

If pursued later: `<Record>` TwiML + recording-status webhook; fetch the recording
server-side and re-upload to R2 (store only the R2 key, never Twilio's public URL); a
dedicated `call_events` table (the existing `message_log` requires a NOT NULL
`proposal_id`, which would drop cold callers); a PII retention/purge scheduler; email-only
"you missed a call from X" alert. Cheapest first when it happens.

## Validation plan (before declaring done)

1. **Core bet — audio:** now that PH geo is on, place a test call from Twilio to Zul's cell
   and confirm it rings reliably with clean audio over several tries. If this fails, the whole
   approach is wrong; everything else is plumbing.
2. **Telegram round-trip:** Zul messages the bot → confirm-before-dial → her cell rings →
   bridged to a test target showing the 224.
3. **Inbound forward:** call the 224 → forwards to her cell cleanly.
4. **Dev testing:** `setWebhook` needs a public HTTPS URL. Either add a tunnel
   (ngrok/cloudflared) for the dev `:5000` server or test against prod (api.drbartender.com)
   with care. This is a setup decision that gates local TwiML iteration.

## Open dependencies

- Zul installs Telegram (near-universal in PH) and taps Start once. Only hard dependency;
  confirmed acceptable.
- Owner confirms auto-refill + sets the Billing spend alert.
- A dev tunnel (or accept prod-only testing).

## Cost model

- To Zul: ~$0 per trigger (a few KB of data); no international-SMS charge.
- To DRB: $0 for the Telegram channel (no number, no per-message fee). Voice legs bill on
  the committed architecture regardless of trigger: PH mobile termination ~$0.29/min
  dominates (both legs bill, each rounds up per minute), US legs are rounding error. Fixed
  add is only the 224 rental (~$1.15/mo). Marginal cost = PH per-minute voice.

## Appendix: 888 stale voice (out of scope, flagged)

The 888 toll-free's voice webhook still points at
`drbartender.checkcherry.com/webhooks/twilio/message_received` — the system migrated off.
Calls to the main company line are handled by CheckCherry. Worth its own decision (repoint
to Zul? to an IVR? leave it?), tracked separately.
