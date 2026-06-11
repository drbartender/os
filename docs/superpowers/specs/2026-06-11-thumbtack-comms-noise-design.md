# Thumbtack Comms: Noise Reduction + Real-Number Capture

**Date:** 2026-06-11
**Branch:** `thumbtack-comms`
**Status:** Draft, pending user review

## Background

Thumbtack rolled out "Thumbtack numbers" (completed June 8, 2026): every lead now carries a permanent per-lead proxy phone number instead of the customer's real number. Calls and texts route through the proxy, are recorded by Thumbtack, and relay to the pro's registered numbers. Registration authorizes a number to contact customers through proxies; texting a proxy from an unregistered number triggers a 7-digit access-code challenge and the message is not delivered until the code is entered.

Dr. Bartender has two numbers registered: the company Google Voice line (312, rings Dan's cell) and the Twilio number OS sends from. Verified against production data and Thumbtack's docs:

- Since June 8, every `thumbtack_leads.customer_phone` is a proxy (observed prefix 839-275-xxxx). The lead webhook stores it as the client's phone via `findOrCreateClient`, so OS automated SMS (initial proposal, drips, confirmations, nudges) go to the proxy from Twilio. This works: messages relay to the customer (since the Twilio number was registered; before that, access-code challenges silently ate them, visible in `sms_messages` June 9).
- Client replies relay natively to the GV number (confirmed by Dan), where he answers inline. The conversation channel is fine.
- Thumbtack ALSO pings the Twilio number for those replies ("Patricia Johnson replied to you on Thumbtack...", access-code challenges, and raw conversation echoes). Those hit `POST /api/sms/inbound`, match the client record (the proxy IS the client's stored phone), and fire the full `urgent_client_reply` alert: email plus SMS to admins. The SMS lands on Dan's GV looking like a message he should answer, but it is OS's own alert sent from Twilio, so replying to it goes nowhere.
- The Thumbtack `/messages` webhook separately emails every customer message (`routine_thumbtack`).

Net effect per customer message: Thumbtack app push + Thumbtack email + native GV relay (wanted) + OS urgent email + OS urgent SMS + OS routine email (all noise). Relay boilerplate is also recorded in `sms_messages` attributed to the client, polluting the admin Messages threads.

## Decisions (from brainstorm)

1. Stay on webhooks. No Pro API (not approved yet; revisit if approved).
2. Keep proxy numbers and Thumbtack refund protection. Keep both numbers registered. Keep all automated lifecycle SMS flowing from Twilio to proxies.
3. Dan's conversation surface is GV (native Thumbtack relay, already working). OS should stop re-alerting him about messages Thumbtack already delivers.
4. Collect the client's real phone number at sign-and-pay, optional, never required. If skipped, the proxy keeps working.
5. No per-message forwarding to GV, no new alert texts (avoids Twilio per-message cost and duplication).

## Component 1: Inbound relay detection (`server/utils/smsInbound.js`)

**Rule:** an inbound SMS is Thumbtack relay traffic when the sender's last-10 digits match a `thumbtack_leads.customer_phone` for a lead created on or after the proxy rollout date.

- Add a module constant `THUMBTACK_PROXY_ROLLOUT = '2026-06-08'`. The date filter protects legacy leads (pre-rollout `customer_phone` values are real customer numbers; those clients must keep alerting normally).
- Detection query (parameterized, same last-10 normalization as `lookupSender`):
  `SELECT 1 FROM thumbtack_leads WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\D', '', 'g'), 10) = $1 AND created_at >= $2 LIMIT 1`.
  `thumbtack_leads` is a small table (hundreds of rows); no new index needed.
- Placement in `processInboundSms`: after the `twilioSid` dedup check and the `lookupSender` call (so the matched `clientId` is available for the record), before the STOP/START keyword handling and sender branching.
- Behavior on match:
  - Record via `recordInboundMessage` with `clientId` still resolved (thread audit trail keeps its client link) and `metadata: { thumbtack_relay: true }`.
  - Return `{ outcome: 'thumbtack_relay', reply: null }`. No `urgent_client_reply` alert, no `routine_admin` alert, no auto-reply.
  - Skip STOP/START application. A relayed "stop" must not flip the client's `sms_enabled` (the text arrives from the proxy, not the client's device; opt-out semantics do not transfer). Twilio's own carrier-level STOP handling on the proxy-to-Twilio leg is outside our control and acceptable.
- Non-matching senders (including any Thumbtack system numbers not tied to a lead) keep today's behavior (unknown sender, `routine_admin` email). Rare and acceptable.

## Component 2: Thumbtack message webhook stops emailing (`server/routes/thumbtack.js`)

- In `POST /api/thumbtack/messages`: delete the customer-message notification block (the `newThumbtackMessageAdmin` + `notifyAdminCategory` call). Message persistence to `thumbtack_messages`, dedup, and error handling are unchanged.
- Remove the now-dead `newThumbtackMessageAdmin` template from `server/utils/emailTemplates.js` and its import, plus any tests covering it.
- `POST /leads` (email with auto-draft proposal link) and `POST /reviews` notifications are unchanged.

## Component 3: Admin Messages UI excludes relay rows (`server/routes/sms.js`)

- `GET /api/sms/conversations` and `GET /api/sms/conversations/:clientId`: exclude rows where `metadata->>'thumbtack_relay' = 'true'` (use `IS DISTINCT FROM` semantics so legacy NULL metadata rows still show). The exclusion applies to both the thread view and the conversation-list aggregation (latest-message preview and ordering), so a relay echo never bumps a thread.
- Rows remain in `sms_messages` for audit; they are filtered at read time only.
- Pre-existing relay rows from before this change (the June 9-11 boilerplate) have no tag and will still display. Acceptable; they age out. No backfill migration.

## Component 4: Optional real-number capture at sign-and-pay

**Server, `GET /api/proposals/t/:token`** (`server/routes/proposals/publicToken.js`):
- Add `client_phone_prefill` to the response: the client's current phone, or `''` when the phone is a Thumbtack proxy (same detection helper as Component 1) or absent. The signing form never shows a proxy number to the client.

**Server, `POST /api/proposals/t/:token/sign`:**
- Accept optional `client_phone`. When present and non-empty: strip non-digits, require 10 to 15 digits, else `ValidationError`. On valid input, `UPDATE clients SET phone = $1 WHERE id = (proposal's client_id)` only when it differs from the stored value. Empty or missing input never overwrites. `communication_preferences` and `phone_status` untouched.
- The token already authenticates the bearer as this proposal's client, so self-updating the phone is within the existing trust model.

**Client, signing form** (`client/src/pages/proposal/proposalView/ProposalView.js`, sign section):
- One optional tel input above the signature pad: label "Best phone number for event-day updates (optional)", prefilled from `client_phone_prefill`, submitted as `client_phone` with the sign POST. No client-side requirement; format hint only. Server remains the validator of record.

**Cross-cutting:** once a real number replaces the proxy, all existing automated SMS and inbound matching use it with zero further changes (everything reads `clients.phone`). Inbound texts from the real number alert normally (Component 1 matches the proxy, not the client).

## Component 5: Outbound copy/date bugs (separate commits)

Two production-observed bugs in automated SMS to Thumbtack clients, root causes in date handling:

1. **"You're booked for Invalid Date!"** (`sign_pay_confirmation`, sent from `server/utils/stripePaymentNotifications.js` line ~163). The `eventDateSms` value formats an invalid/missing date into the literal string `Invalid Date`. Fix at the source: validate the date before formatting; when invalid or absent, pass `null` so the template's fallback applies ("You're booked for your event!").
2. **"for the Birthday Party on your event"** (and the latent "your your event event" in `dripTouch5Sms`). The `dt()` fallback `'your event'` reads correctly only in "for ___" positions. Restructure the affected templates (`initialProposalSms`, `dripTouch1Sms`, `dripTouch3Sms`, `dripTouch5Sms` in `server/utils/smsTemplates.js`) to drop the date clause entirely when no date is provided ("Just sent your proposal for the Birthday Party. Review the details..."). Keep `dt()` for the "for ___" templates where it reads naturally.
3. Update `server/utils/smsTemplates.test.js` for the new no-date branches, and audit the callers (`sendProposalSentEmail.js`, `dripSmsHandlers.js`) to confirm they pass `null` rather than preformatted invalid strings.

## Out of Scope

- Thumbtack Pro API / CRM integration (blocked on approval).
- Changing which lifecycle SMS are sent, or their sender (Twilio stays).
- Forwarding client messages to GV (native Thumbtack relay covers it).
- Thumbtack-side notification settings (Dan manages in their app).
- Backfilling tags onto pre-existing relay rows.

## Testing

- Unit (`node:test`, run per-suite per the shared-dev-DB constraint): relay detection (match, legacy-lead non-match, unknown sender), `processInboundSms` relay outcome (no alerts dispatched, STOP from proxy does not opt out), sign endpoint phone validation (valid update, invalid rejected, empty no-op), template no-date branches.
- Manual: proxy traffic cannot be reproduced locally (only Thumbtack can text from a proxy number), so verify in prod after deploy by watching the next Thumbtack reply: expect a `sms_messages` row tagged `thumbtack_relay`, no alert email or SMS, and a clean thread view.
- Existing thumbtack webhook tests (`server/routes/thumbtack.test.js`) updated for the removed message email.

## Docs

- README/ARCHITECTURE: no new files or routes expected; update ARCHITECTURE notification-flow notes for the removed message email and the relay tagging. No new env vars.
