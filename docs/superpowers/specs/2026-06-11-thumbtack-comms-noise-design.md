# Thumbtack Comms: Noise Reduction + Real-Number Capture

**Date:** 2026-06-11
**Branch:** `thumbtack-comms`
**Status:** Draft v2, spec-fleet findings folded in, pending user review

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

- Extract a shared helper `findThumbtackProxyLead(phone)` in `smsInbound.js` (exported for reuse by Component 4): returns the matching lead's `{ client_id }` or `null`. Query (parameterized, same last-10 normalization as `lookupSender`):
  `SELECT client_id FROM thumbtack_leads WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\D', '', 'g'), 10) = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 1`.
  `thumbtack_leads` is a small table (hundreds of rows); no new index needed.
- Module constant `THUMBTACK_PROXY_ROLLOUT = '2026-06-08T00:00:00Z'` (explicit UTC; `created_at` is TIMESTAMPTZ). The date filter protects legacy leads (pre-rollout `customer_phone` values are real customer numbers; those clients must keep alerting normally).
- **Fail open:** wrap the detection query in try/catch. On error, log, capture to Sentry, and treat the message as NOT relay, so it flows through today's path and still alerts. A detection outage must never drop or silence a real client message, and must never 500 the webhook (Twilio retry semantics stay intact either way via the `twilio_sid` ON CONFLICT dedup).
- Placement in `processInboundSms`: after the `twilioSid` dedup check and the `lookupSender` call, before the STOP/START keyword handling and sender branching.
- Behavior on match:
  - Record via `recordInboundMessage` with `metadata: { thumbtack_relay: true }` and `clientId` resolved as: the `lookupSender` client match when present, else the lead's `client_id` from `findThumbtackProxyLead`. (The fallback matters after Component 4: once a real number replaces the proxy on the client row, `lookupSender` no longer matches the proxy, but the lead row still links the client, so the audit trail keeps its client link.)
  - If `recordInboundMessage` returns null (concurrent Twilio retry hit the ON CONFLICT path), return `{ outcome: 'duplicate', reply: null }`, mirroring the existing pattern.
  - Otherwise return `{ outcome: 'thumbtack_relay', reply: null }`. No `urgent_client_reply` alert, no `routine_admin` alert, no auto-reply.
  - **Observability:** every suppression emits a structured console log (`[smsInbound] thumbtack_relay suppressed`, sender last-4, client id) and a Sentry breadcrumb-level capture tagged `thumbtack_relay`, so a falsely-tagged real client (proxy recycling, a future Thumbtack policy change) is discoverable from logs rather than silently lost forever.
  - Skip STOP **and** START application. A relayed "stop" or "start" must not flip the client's `sms_enabled` (the text arrives from the proxy, not the client's device; opt semantics do not transfer in either direction). Twilio's own carrier-level STOP handling on the proxy-to-Twilio leg is outside our control, compliance-safe, and acceptable.
- Non-matching senders (including any Thumbtack system numbers not tied to a lead) keep today's behavior (unknown sender, `routine_admin` email). Rare and acceptable.

## Component 2: Thumbtack message webhook stops emailing (`server/routes/thumbtack.js`)

- In `POST /api/thumbtack/messages`: delete the customer-message notification block (the `newThumbtackMessageAdmin` + `notifyAdminCategory` call). Message persistence to `thumbtack_messages`, dedup, and error handling are unchanged.
- Remove the now-dead `newThumbtackMessageAdmin` template from `server/utils/emailTemplates.js` and its import, plus any tests covering it. Grep docs and code for remaining references to the template name before merge.
- `POST /leads` (email with auto-draft proposal link) and `POST /reviews` notifications are unchanged.

## Component 3: Admin Messages UI excludes relay rows (`server/routes/sms.js`)

- Exclusion predicate: `(metadata->>'thumbtack_relay') IS DISTINCT FROM 'true'` (legacy NULL-metadata rows still show).
- `GET /api/sms/conversations` applies the predicate in **all three** places: the `last_message_at` MAX subquery, the `unread_count` COUNT subquery, and the outer `WHERE EXISTS` that decides whether a client appears at all. Otherwise relay echoes inflate unread badges and a client with only relay rows shows as an empty-shell conversation.
- `GET /api/sms/conversations/:clientId` (thread view) applies the same predicate.
- Rows remain in `sms_messages` for audit; they are filtered at read time only. No index needed at current volume (a few hundred rows); if `sms_messages` ever grows large, a partial index on the predicate is the future fix, deliberately deferred.
- Pre-existing relay rows from before this change (the June 9-11 boilerplate) have no tag. They drop off the conversation LIST as real activity outpaces them, but remain visible inside those threads. Accepted; no backfill migration.

## Component 4: Optional real-number capture at sign-and-pay

**Server, `GET /api/proposals/t/:token`** (`server/routes/proposals/publicToken.js`):
- Add `client_phone_prefill` to the response: the client's current phone, or `''` when the phone is a Thumbtack proxy or absent. Proxy check: run `findThumbtackProxyLead(client.phone)` (Component 1 helper) **only when the client's `source` is `'thumbtack'`** (post-rollout proxy numbers are always fresh, so their clients are always thumbtack-sourced; the guard keeps the extra query off the common public-page path). The signing form never shows a proxy number to the client.

**Server, `POST /api/proposals/t/:token/sign`:**
- Accept optional `client_phone`. Validation runs with the other field validations (so errors surface together): when present and non-empty, normalize with the existing `normalizePhone` logic (strip non-digits, drop a leading 1 from an 11-digit NANP number) and require exactly 10 digits after normalization, else `ValidationError` keyed `fieldErrors.client_phone`. Storage format is the normalized 10-digit string, consistent with inbound last-10 matching and existing Twilio sends. Empty or missing input is valid and never overwrites.
- **The phone write is gated on the signature write succeeding.** Run it after the existing sign UPDATE returns a row (the `client_signed_at IS NULL` TOCTOU gate): a replayed or stale sign POST that hits `ALREADY_ACCEPTED` performs no phone write, so a leaked token cannot mutate the phone after acceptance. The write is `UPDATE clients SET phone = $1 WHERE id = $2 AND phone IS DISTINCT FROM $1`, scoped to the proposal's `client_id`.
- **The phone write is best-effort:** wrapped in its own try/catch (log + Sentry on failure) so a phone-write failure never aborts or 500s a successful signature. If two writes race (concurrent admin edit), the client's just-typed value wins; last write is the client's.
- Record the outcome in the existing `proposal_activity_log` 'signed' entry details: `phone_updated: true/false` (lets Dan reconstruct when a real number replaced a proxy).
- If the sign request fails validation elsewhere (venue, name, signature), nothing persists, including the phone; the client resubmits the whole form and the phone rides along. Acceptable for an optional field.
- The token already authenticates the bearer as this proposal's client, so self-updating the phone is within the existing trust model (`signLimiter` rate-limits the route).

**Client, signing form** (`client/src/pages/proposal/proposalView/SignAndPaySection.js`, with state lifted into `client/src/pages/proposal/proposalView/ProposalView.js` alongside the existing `sigName` / venue state):
- One optional tel input above the signature pad: label "Best phone number for event-day updates (optional)", `inputMode="tel"`, `autocomplete="tel"`, prefilled from `client_phone_prefill`, submitted as `client_phone` with the sign POST. No client-side requirement; format hint only. Server remains the validator of record; a server `fieldErrors.client_phone` renders under the input via the existing fieldErrors plumbing.

**Cross-cutting:** once a real number replaces the proxy, all existing automated SMS and inbound matching use it with zero further changes (everything reads `clients.phone`). Inbound texts from the real number alert normally. Future relay echoes from that lead's proxy still tag and link correctly via the lead-row fallback in Component 1.

## Component 5: Outbound copy/date bugs (separate commits)

Production-observed bugs in automated SMS, root causes in date handling. The contract decision: **callers pass a formatted date string or `null`, never a sentinel**; templates own all fallback copy.

1. **"You're booked for Invalid Date!"**: the inline date ternary in `server/utils/stripePaymentNotifications.js` (~line 157-163) formats without an invalid-date guard. `server/utils/paymentFailedClientNotify.js` (~line 92-98) has the identical pattern and the identical bug. Fix both: guard with `Number.isNaN(parsed.getTime())` and pass `null` when invalid or absent.
2. **Sentinel cleanup:** the `eventDateSms()` helpers in `dripSmsHandlers.js`, `balanceSmsHandlers.js`, and `drinkPlanNudge.js` already guard invalid dates but return the sentinel string `'your event'`. Change them to return `null` (lockstep with the contract). Templates using `dt()` in "for ___" positions keep rendering "for your event" via the existing fallback, so behavior there is unchanged.
3. **"for the Birthday Party on your event"** (and the latent "your your event event" in `dripTouch5Sms`): the `dt()` fallback reads correctly only in "for ___" positions. Restructure `initialProposalSms`, `dripTouch1Sms`, `dripTouch3Sms`, `dripTouch5Sms` in `server/utils/smsTemplates.js` to drop the date clause entirely when `eventDate` is null ("Just sent your proposal for the Birthday Party. Review the details..."). Keep `dt()` for the "for ___" templates (`signPayConfirmationSms`, `balanceDueTodaySms`, `balanceLateSms`, `paymentFailureSms`, `drinkPlanNudgeSms`) where it reads naturally.
4. Update `server/utils/smsTemplates.test.js` with the full no-date matrix: `initialProposalSms`, `dripTouch1Sms`, `dripTouch3Sms`, `dripTouch5Sms` (date clause dropped, no double "your event"), plus `signPayConfirmationSms` and `paymentFailureSms` (fallback wording locked). Audit `sendProposalSentEmail.js` (~line 90) to confirm it passes null on missing dates.

## Out of Scope

- Thumbtack Pro API / CRM integration (blocked on approval).
- Changing which lifecycle SMS are sent, or their sender (Twilio stays).
- Forwarding client messages to GV (native Thumbtack relay covers it).
- Thumbtack-side notification settings (Dan manages in their app).
- Backfilling tags onto pre-existing relay rows.
- Partial index on the relay-filter predicate (deferred until `sms_messages` volume warrants it).

## Testing

- Unit (`node:test`, run per-suite per the shared-dev-DB constraint):
  - Relay detection: proxy match, legacy-lead non-match (pre-rollout lead with real number still alerts), unknown sender unchanged, detection-query failure fails open (message alerts as today).
  - `processInboundSms` relay outcome: no alerts dispatched, relayed STOP/START does not flip `sms_enabled`, duplicate retry returns `duplicate`, client link falls back to the lead's `client_id` when `clients.phone` no longer matches the proxy.
  - Sign endpoint: valid phone updates, invalid rejected with `fieldErrors.client_phone`, empty no-op, replayed sign (`ALREADY_ACCEPTED`) performs no phone write, phone-write failure does not fail the signature.
  - Template no-date matrix per Component 5.
- Manual: proxy traffic cannot be reproduced locally (only Thumbtack can text from a proxy number), so verify in prod after deploy by watching the next Thumbtack reply: expect a `sms_messages` row tagged `thumbtack_relay`, no alert email or SMS, a clean thread view, and the suppression log line.
- Existing thumbtack webhook tests (`server/routes/thumbtack.test.js`) updated for the removed message email.

## Docs

- README/ARCHITECTURE: no new files or routes expected; update ARCHITECTURE notification-flow notes for the removed message email and the relay tagging. No new env vars. Grep for `newThumbtackMessageAdmin` references in docs before merge.
