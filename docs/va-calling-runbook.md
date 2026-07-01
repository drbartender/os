# Zul VA Calling — Operator Runbook

Source spec: `docs/superpowers/specs/2026-07-01-zul-va-calling-design.md`.
Feature: Zul (PH VA) places/receives US calls via a Telegram-triggered Twilio
callback bridge. This runbook is the manual bring-up + validation checklist.
Do it in order; the bootstrap and webhook steps have a required sequence.

## 0. Prerequisites (owner, one-time, Twilio console only)

- [ ] **PH voice geo**: confirm low-risk PH dialing is ENABLED and high-risk is
      OFF (Twilio → Voice → Geographic Permissions). Already verified via API.
- [ ] **Auto-refill + spend alert**: confirm auto-refill is ON with headroom
      (balance had been thin, ~$16.72 — a dry balance takes SMS down with it),
      and set a low-balance + monthly-spend email alert in the Billing console.
      This is the secondary backstop behind the in-code spend caps.

## 1. Create the Telegram bot

- [ ] In Telegram, message **@BotFather** → `/newbot` → give it a name + username.
- [ ] Copy the **HTTP API token** BotFather returns → this is `TELEGRAM_BOT_TOKEN`.
- [ ] Generate a webhook secret:
      `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
      → this is `TELEGRAM_WEBHOOK_SECRET` (it is BOTH the URL path segment and the
      X-Telegram-Bot-Api-Secret-Token header value).

## 2. First deploy — BOOTSTRAP mode (allowlist unset)

- [ ] In the Render dashboard set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
      `VOICE_CALLER_ID=+12242220082`, `VA_CELL=<Zul's +63… cell>`.
      **Leave `TELEGRAM_ALLOWED_USER_ID` UNSET.**
- [ ] Deploy. With the allowlist unset the webhook runs in bootstrap mode: it
      replies to any sender with their own numeric id and dials nothing.

## 3. Capture Zul's user id

- [ ] Have Zul open the bot and tap **Start**, then send any message.
- [ ] The bot replies "Your Telegram id is <NNN>". Read that number.
      (If the bot does not reply yet, the webhook may not be registered — do step 4
      first, then have her resend.)

## 4. Register the Telegram webhook (once)

- [ ] Run `setTelegramWebhook()` once against prod. It POSTs `setWebhook` with
      `url = <API_URL>/api/telegram/<TELEGRAM_WEBHOOK_SECRET>` and
      `secret_token = <TELEGRAM_WEBHOOK_SECRET>`. The VA-calling scheduler's daily
      heartbeat also self-heals this, but run it explicitly now.
- [ ] Confirm with `getTelegramWebhookInfo()`: `url` is set, `last_error_date` is
      empty/old, `pending_update_count` is small.

## 5. Lock the allowlist — second deploy

- [ ] In Render set `TELEGRAM_ALLOWED_USER_ID = <Zul's id from step 3>`. Redeploy.
- [ ] Now every sender except Zul is a silent no-op; Zul's messages trigger calls.

## 6. Point the 224 inbound voice webhook (Twilio console)

- [ ] Twilio → Phone Numbers → **+1 (224) 222-0082** → Voice → "A call comes in":
      Webhook, HTTP POST, URL = `<API_URL>/api/voice/inbound`.
- [ ] Leave the status-callback wiring to `calls.create` (the code sets
      `statusCallback` on the outbound leg); no console change needed for status.

## 7. Validation tests (from the spec — do all three before declaring done)

- [ ] **Test 1 — audio (the core bet):** place a test call from Twilio to Zul's
      cell and confirm it rings reliably with clean audio over several tries. If
      this fails the whole approach is wrong — stop and reassess.
- [ ] **Test 2 — Telegram round-trip:** Zul texts the bot a US number → bot replies
      "Reply YES to call …" → she sends YES → her cell rings → she answers → she is
      bridged to the target, which sees the 224. Then repeat to a deliberately
      unanswered number and confirm she gets the "didn't connect, resend" Telegram
      notice.
- [ ] **Test 3 — inbound forward:** call the 224 from another phone → it forwards to
      Zul's cell within the 20s timeout with the caller's number shown.

## 8. Optional (owner, decoupled from this feature)

- [ ] If desired, run `server/scripts/createAdmin.js` to give Zul an admin account.
      This is a separate, owner-approved decision — calling needs ZERO admin rights
      (the bridge target is `VA_CELL`, an env var), so do NOT block calling on it.

## Notes / guard rails

- `VA_CELL` is strict E.164 (`+63…`) and is NEVER run through `normalizePhone`.
- Never commit `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_ALLOWED_USER_ID`, or `VA_CELL` — all are `sync: false` in `render.yaml`.
- Dev testing needs a public HTTPS URL for `setWebhook` (ngrok/cloudflared to
  `:5000`) or test against prod with care. Privileged actions never run on a dev
  signature-skip path.
- Spend caps live in code (`VA_CALL_DAILY_CAP` / `VA_CALL_PER_MIN_CAP` /
  `VA_CALL_TIME_LIMIT_SEC`); the Twilio billing alert is the secondary backstop.
