# Inbox: design

**Date:** 2026-10-06
**Status:** brainstormed and approved section by section with Dallas on 2026-10-06 (purpose and scope, item anatomy and build approach, the rules, the reply lines, day-to-day behavior). The spec fleet ran the same day on Opus, because Fable credits had run out:
- grounding: PASS with 5 warnings;
- risk: FAIL with 4 blockers and 9 warnings;
- gaps: FAIL with 3 blockers and 17 warnings.

Every finding was verified against code and folded in. The decisions they produced are 17 to 31 in section 3. Real client names and message text were removed because the repo is public; every example here and in the test fixtures is invented.
**Visual design:** COMPLETE 2026-10-06. Claude Design project "Dallas and Zul's inbox admin" (`37a08def-ebb3-4979-856c-e54d876bc04d`), built on the Dr. Bartender OS Design System project (`72035042-c993-47e2-9dc8-c452b7bf5fa4`), exported by Dallas and snapshotted at `docs/design-artifacts/2026-10-06-inbox/`. Section 11 is the visual contract.

## 1. Goal and scope

Dallas and Zul answer people across Thumbtack, three Twilio text lines, Google Voice, email and Zola. Today nothing tracks whether anyone was answered. The Cowork "morning inbox triage" job reads Gmail notification emails, cannot see replies made outside Gmail, and makes Dallas archive things by hand. Gmail is only a backup collector: most of this correspondence already flows through the OS.

**Goal:** never miss correspondence. Inbox is a live, shared list in the admin of every person waiting on a reply from Dallas or Zul, one item per person across every channel the OS can see, with the context needed to answer and a one-tap way to reply.

This spec is piece 2 of five:

| Piece | What | Where it is specified |
|---|---|---|
| 1 | Stop the Messages page hiding real texts that arrive from Thumbtack proxy numbers | Separate quick fix (section 2, relay rows) |
| **2** | **Inbox: the list, the rules, the AI read, replies, built from OS data** | **This spec** |
| 3 | Gmail feed: email and Zola messages flow into Inbox | Later spec |
| 4 | Google Voice reader on the box: 312 threads flow into Inbox | Later spec |
| 5 | Retire the Cowork morning task | After 2 to 4 have earned trust |

**In scope**
- The Inbox page (desktop and phone), its badge, and the phone tab.
- The rules engine over Thumbtack messages, texts on all three lines (clients, staff, unknown numbers), OS sends, proposal sends and connected bridge calls.
- The AI read (Anthropic) and its scheduler.
- Claim (On it), Done, Snooze, Wake, Reopen, Recently handled, feed health.
- Replying by text from Inbox, with an opt-out rule that covers every line.
- Line-aware inbound texts: record which line every text came in on and went out from; capture picture messages; run shift commands and the automated staff reply only where they belong (decision 17); point the 0082 at the OS.
- Delivery status for texts sent from Inbox and Messages, so a text that never arrived does not count as a reply.
- Opt-out keywords aligned with Twilio's, and a per-phone opt-out record.
- Truthful `sent_by` and distinct message types on every human-triggered client send.
- Removing the unread-texts rows from the Needs-attention card.
- One line on the public privacy page naming Anthropic.

**Out of scope**
- Pieces 1, 3, 4 and 5. The design shows Email, Zola and Google Voice items; those channels render once their pieces land. This spec defines the event shape they plug into (section 5.1).
- Notifications or pings of any kind (Dallas: "no pings. Maybe we'll want that later.").
- Shift requests, cover claims and change requests. They stay where they live (Dallas: "don't need the shift requests on the list, that is a separate thing").
- Replying to email, Zola or Thumbtack from inside Inbox. Those open the right app.
- Email-lead replies (`email_conversations`, marketing prospects, `server/routes/emailMarketing/conversations.js:49-72`). Piece 3 decides whether they join.
- AI-drafted replies.
- Voicemail and missed-call items on the Twilio lines (1 primary voicemail in 30 days).
- Moving automated client texting (reminders, drips) off the 888.
- Making automated sends consult the per-phone opt-out record, and flipping `phone_status` from delivery callbacks. Both go on the fix list.
- Closing an item because the person paid (decision 12).

## 2. Verified context

All facts were read from code on `main` and from the prod database on 2026-10-06. The spec fleet re-verified about 60 citations against code.

- **Thumbtack sends both sides.** `POST /api/thumbtack/messages` (`server/routes/thumbtack.js:526-568`) inserts into `thumbtack_messages` (`schema.sql:2155-2167`):
  - `message_id` UNIQUE, `negotiation_id` (`VARCHAR(100)`, no FK), `from_type` CHECK `('Customer','Business')`, `sender_name`, `text` (truncated to 5000), `sent_at` (nullable), `raw_payload`, `created_at`.
  - Prod holds 834 `Customer` and 827 `Business` rows. The lead's opening request arrives as a `Customer` row.
  - Messages link to a person only through `thumbtack_leads.negotiation_id` (UNIQUE) to `thumbtack_leads.client_id`.
  - Dallas's replies sent from Google Voice to a Thumbtack proxy number also land here as `Business`.
  - All 436 prod negotiation ids are numeric (at most 18 digits). Test fixtures use values like `'neg123'`.
- **The auto first reply is a holding reply.** The box agent sends a saved quick reply ("Hi there, I'm Dallas, resident alchemist at Dr. Bartender. We're reviewing...") and stamps `thumbtack_leads.first_reply_status='sent'` and `first_reply_sent_at` (`server/routes/thumbtackAgent.js:663-669`). The message itself arrives through the webhook as a `Business` row. Dallas also sends the same template by hand when the agent fails.
- **Proposals go out by hand.**
  - Thumbtack drafts are created as `draft` by `thumbtackProposalDraft.js` (actor `system`).
  - An admin sends them. That writes a `proposal_activity_log` row, `status_changed` (or `status_force_changed`, `lifecycle.js:109`), with `details.to='sent'` and the admin's `actor_id`. In prod, proposal 903 was sent by Zul and 904 by Dallas.
  - The status flips and commits before the email and SMS go out, and both are best effort (`lifecycle.js:157-183`).
  - Other send records: `resent` (deprecated route), `group_sent`, and comms `proposal_resend`, which writes only `message_log`.
  - `proposals.sent_at` is the first send only.
  - The website quote wizard (`server/routes/proposals/public.js`) creates proposals already `sent`, with no admin click and `sent_at` NULL.
  - All 14 Thumbtack leads in the preview below got a proposal the same day or the next.
- **`sms_messages`** (`schema.sql:1194-1212` plus later ALTERs) holds every text both ways. Columns: `direction` `inbound|outbound`, `client_id`, `sender_id`, `recipient_id`, `recipient_phone`, `body`, `message_type`, `shift_id`, `group_id`, `twilio_sid` (UNIQUE), `status` CHECK `('sent','failed','queued','received')`, `error_message`, `read_at`, `metadata` JSONB, `processed`, `created_at`.
  - **Inbound rows** come from `recordInboundMessage` (`server/utils/smsInbound.js:258-278`).
    - `recipient_phone` holds the SENDER's number.
    - `metadata.to` is hard-coded to `process.env.TWILIO_PHONE_NUMBER`, so a row cannot say which DRB number was texted. `processInboundSms({ from, body, twilioSid })` receives neither `To` nor media (`sms.js:81-85`), so a picture-only text is stored with an empty body.
    - The processing outcome is not stored on the row.
  - **Sender matching.** `client_id` is set only when the sender matches a client (`lookupSender`, `smsInbound.js:142-173`): clients first by last 10 digits, then any non-blocked `contractor_profiles` phone, applicants included. Staff and unknown senders are stored with `client_id` and `sender_id` both NULL. Staff free text reaches Dallas only as a "Staff texted Dr. Bartender" email.
  - **Keywords** (`smsInbound.js:17-20`), whole-body matches:
    - STOP: `stop, unsubscribe, end, cancel, quit`;
    - START: `start, unstop, yes`;
    - HELP: `help, info`.

    `smsOptKeywordCopy.js:5-18` records the prod incident behind the alert fix: a client texting "Cancel" about their event, and four "yes" replies to the drip's "Want to lock it in?". Twilio's own default opt-out list also includes STOPALL, OPTOUT and REVOKE, which the OS does not recognize. For an unknown sender, a STOP writes nothing except `metadata.opt_keyword` on the row (`smsInbound.js:357`). The relay branch returns before keyword detection.
  - **Shift commands run on every line.**
    - A whole-body CONFIRM or CANT from a staff phone (`detectResponseCode`, apostrophes stripped) runs `handleConfirm` or `handleCant` (`smsInbound.js:884-920`). CANT releases and reopens the staffer's nearest approved shift.
    - Any other staff text gets the TwiML reply `FREEFORM_STAFF_REPLY` ("this number is automated...", `smsInbound.js:28, 937-944`), sent from whichever line was texted. So do the no-shift CONFIRM and CANT replies.
    - Nothing checks the line, or whether a human is mid-conversation.
  - **Other inbound `metadata` flags:**
    - `thumbtack_relay: true`, when the sender matches a post-2026-06-08 Thumbtack proxy (`findThumbtackProxyLead`, exported, newest lead first);
    - `opt_keyword: 'stop'|'start'`;
    - `help_keyword: true`.
  - **Outbound:**
    - Human client replies carry `sender_id` (`POST /api/sms/conversations/:clientId/reply`, `server/routes/sms.js:171-205`, `requireAdminOrManager`, with no rate limiter and no opt-out check).
    - Automated sends (`sendAndLogSms`) leave `sender_id` NULL.
    - Staff texts come from `POST /api/messages/send` (`server/routes/messages.js:47-140`, `adminOnly`). Its send logic is inline in the handler. Rows carry `group_id`, `sender_id` and `recipient_id`. Eligibility is `role IN ('staff','manager')`, `onboarding_status IN ('submitted','reviewed','approved')`, and an inner join on `agreements` (one row per user, `agreements.user_id` UNIQUE, `schema.sql:133`) with `sms_consent`. It never checks `users.communication_preferences.sms_enabled`, and it returns 200 with `sent: 0` when nobody qualifies.
  - **Delivery failures:**
    - `sendSMS` registers no status callback (`server/utils/sms.js:31`), so a failure Twilio reports later (carrier filtering 30007, unreachable or landline numbers, most Messaging Service failures) never reaches the OS.
    - `smsDeliveryStatus.js` names a status-callback route as its caller, but none is mounted.
    - A Messaging Service send returns status `accepted`, which prod's status CHECK rejects. The dev DB lacks that CHECK.
  - **Prod, last 14 days:** 22 client inbound, 8 relay inbound, 5 inbound with no client, 138 automated client outbound, 10 human client outbound.
- **Relay rows hide real texts.** Of 34 relay-flagged inbound rows in 30 days, most are Thumbtack's own "X replied to you on Thumbtack." notices. Three, between 9/10 and 9/15, were real customer texts answering an OS text: one asking when their shopping list would come, one asking to talk the next day, one comparing quotes. None appear in `thumbtack_messages`. The Messages page and badge exclude every relay row (`sms.js:131-148`, `settings.js:169-171`). Piece 1 fixes the Messages page; Inbox includes them from day one.
- **`message_log`** (`schema.sql:4005-4017`; `sent_by` and `body_edited` at 4785-4786) logs client-facing email and SMS through `server/utils/messageLog.js:90-97`.
  - **Columns:**
    - `channel` `email|sms`;
    - `message_type` (`'other'` when the caller passes none, `messageLog.js:20`);
    - `recipient`, `subject` (for SMS, the first 140 chars of the body), `status`, `provider_id`, `sent_by`;
    - `client_id` (filled by email or phone match);
    - `proposal_id` NOT NULL. When it is missing, the client's newest proposal is used (`messageLog.js:81-87`), and with no proposal no row is written.

    There is no body column.
  - `sent_by` is set by `POST /api/comms/send` (the SendModal) and the deprecated routes that hand off to the same actions.
  - **`sent_by` is NULL on these human-click paths:**
    - ProposalDetail "Send to client" (`PATCH /api/proposals/:id/status` to `sendProposalSentEmail`, `lifecycle.js:165-183`) and `send_now` create (`crud.js:283-296`);
    - the event-details notice (`crud.js:810` to `rescheduleProposal.js:443-449, 476-482`);
    - the refund notice (`refundClientNotify.js:64-67`, a helper also called by `refundCreated.js:244`, `stripe.js:550` and the refund sweep);
    - line-item removal (`lineItemRemovedNotify.js:96-99`);
    - the record-payment receipt (`proposals/actions.js:376-379`);
    - the cancel confirmation (`proposals/cancel.js:470`);
    - the gratuity disclosure (`crud.js:867-873`);
    - the change-request decision (`changeRequestNotifications.js:43`);
    - the manual client SMS reply (`sms.js:187`).

    The cancel confirmation, gratuity disclosure and change-request decision pass no `meta` at all, so all three log as `'other'` against the newest proposal. `contactMessageHistory.js:30-33,108` mislabels every path in this list as automated today.
  - SMS sent through the SendModal never reach `sms_messages`. The same send can appear in both tables, matched by `message_log.provider_id = sms_messages.twilio_sid`.
  - Every Resend webhook event lands in `email_webhook_events (resend_id, event_type, payload)` (`emailMarketingWebhook.js:70-72`), keyed by the same id that `message_log.provider_id` stores. A bounce is therefore readable without changing any writer.
  - Prod, last 30 days: 35 human email rows and 27 human SMS rows (shopping lists, proposals, invoices, drink-plan recaps, planner nudges).
- **Calls.**
  - `lead_call_attempts` (`schema.sql:2183-2208`) has `status='connected'` and `bridge_duration_sec`. At 20 seconds or more the lead becomes `contacted` (`voiceLeadCall.js:229-238`). It links through `lead_id` to `thumbtack_leads.client_id`.
  - `answered_by` is `'admin'` or `'va'` (`voiceLeadCall.js:80`).
  - Prod: 32 connected at 20 s or more in 30 days.
  - `consult_call_attempts` (`schema.sql:3161-3185`) links through `consults.client_id`, with `bridge_duration_sec` and `client_no_answer_at`.
  - Neither bridge uses answering-machine detection.
  - Answered inbound calls are not stored. `call_audit` has no duration.
- **Opt-out storage.** STOP sets `communication_preferences.sms_enabled=false` on the client or the user (`applyOptOut`, `smsInbound.js:361`; `schema.sql:2934, 2985`). Staff consent is `agreements.sms_consent`. `messageSuppression.shouldSendImmediate` (`messageSuppression.js:21-40`, no I/O) gates immediate client sends and refuses both `sms_enabled=false` and `phone_status='bad'`.
- **Legal hold.** `LEGAL_HOLD_PROPOSAL_IDS = [600]` (`staleProposalSweep.js:47`). That client must never be chased.
- **Twilio lines** (Twilio API, 2026-10-06):
  - The numbers:
    - the 888: `TWILIO_PHONE_NUMBER`, `sms_url` `/api/sms/inbound`, toll-free verified;
    - the 1922: `sms_url` `/api/sms/inbound`;
    - the 0082: no `sms_url`.
  - A2P brand APPROVED and campaign VERIFIED (use case CUSTOMER_CARE) on Messaging Service `MG84c22d90d9c6a5427606da49bd2c6696`, with both 224 numbers attached.
  - Twilio keeps opt-outs per sender: the 888 and the 224 Messaging Service are separate opt-out domains.
  - Zero texts to or from either 224 in the last 30 days, so inbound delivery on them is unproven.
  - `sendSMS({ to, body, meta })` (`server/utils/sms.js:20-31`) always sends from `TWILIO_PHONE_NUMBER`.
  - `CONSULT_CALLER_ID` (the 1922) and `VOICE_CALLER_ID` (the 0082) hold the 224s in strict E.164 for voice. Each falls back to the other.
  - `VA_CELL` is Zul's +63 cell.
  - `server/utils/companyPhone.js` still tells clients to text the 888.
- **Admin surfaces.**
  - **Badge counts:** `GET /api/admin/badge-counts` (`server/routes/admin/settings.js:129-188`, `requireAdminOrManager`) is polled every 60 s and on `visibilitychange` by `AdminLayout.js:114-135`. A failed fetch is swallowed at line 121, and the old counts stay.
  - **Nav:** items live in `client/src/components/adminos/nav.js:8-31` (`badgeKey`). `navBadgeCount` (`nav.js:34-39`) turns a missing or null value into 0. `Sidebar.js:69,86` and `MobileTabBar.js:36-38,51` render a badge only when the count is above 0.
  - **Phone tabs** are hard-coded Events, Proposals, More (`MobileTabBar.js:18-24`). More sums the other nav badges. `MorePage.js:14` keeps its own `TAB_IDS` set.
  - **Phone screens** fork inside the page: `EventsDashboard.js:400` returns `<EventsListPhone />` when `isPhone && !desktopView('events-list')`. The phone detail header is wired only for event and proposal detail (`AdminLayout.js:249-252`, `client/src/utils/screenKey.js:7-13`, `usePhoneHeader`).
  - **Toasts:** `ToastContext.js` shows text only, with fixed 5 s and 8 s timeouts and no action button.
  - **Messages thread** times render browser-local (`ClientConversation.js:112`). `client/src/utils/chicagoDay.js` holds the Chicago date helpers.
  - **Limiter:** `adminWriteLimiter` (`server/middleware/rateLimiters.js`) already guards admin writes such as the resend route (`lifecycle.js:316`).
  - **Routing:** admin sub-routers compose in `server/routes/admin/index.js`.
- **Needs-attention Clients tab** (`client/src/pages/admin/overview/queueItems.js:145-162`) shows pending change requests, then one row per SMS thread with `unread_count > 0`, fetched in `OverviewPage.js:218-229`. Unread clears when a thread is opened, whether or not anyone replies.
- **Schedulers** use `wrapScheduler(name, expectedSec, fn)` (`server/utils/schedulerHealth.js:54-77`) behind `enabled('RUN_*_SCHEDULER')`. An in-flight boolean is hand-written where needed; the precedents are `service_extension_sweep` (`server/index.js:664-679`) and `consult_call_sweep` (`index.js:806-823`). Startup delays already taken: 15, 25, 30, 35, 45, 60, 75, 90, 120, 150, 180, 200, 210, 240, 270, 300 s.
- **Staff shift helpers.** `shiftNotFinishedSql` (`server/utils/shiftEndInstant.js`) and `openSlotsSql` are the canonical "upcoming" and "open seats" predicates. `settings.js:133-150` records the drift bugs that came from not using them.
- **No LLM in the server today.** Dallas added `ANTHROPIC_API_KEY` in Render on 2026-10-06. Root `package.json` has neither `@anthropic-ai/sdk` nor `zod`.
- **Privacy page** (`client/src/pages/website/legal/PrivacyPage.js`, `lastUpdated="July 22, 2026"` at line 16) lists providers at lines 114-124 (Stripe, Twilio, Resend, Google, hosting). Lines 75-78 say phone numbers go only to the providers that transmit messages, and that opt-in data is never shared.
- **The repo is public.** No real client name or message text may appear in specs, plans, code or fixtures.
- **Prod preview, 2026-10-06.** "Who spoke last" over Thumbtack and texts says 30 people are waiting. Three rules clear 28 of them:
  - a proposal sent after their message: 14, all Thumbtack leads;
  - no reply needed: 13, twelve thank-yous and one "we already hired someone";
  - one test client.

  Two are left. One client texted on Sunday saying they had been trying to reach Dallas; he emailed them back Monday, which Inbox sees only after piece 3. The other is borderline: a client's venue details, 13 days old.

## 3. Decisions

1. **A live list, not a morning email.** Dallas: "the morning email is not what I want. The live list is better."
2. **Correspondence only.** No shift requests, cover claims or change requests.
3. **Shared by Dallas and Zul, whoever sees it first.** No routing by type. "On it" shows the other person who has it and lapses after 4 hours with no reply. Staff items are included for both (Dallas approved the design with Zul claiming a staffer's cover request), so a staffer's free text, including pay or personal matters, becomes visible to Zul.
4. **No pings.** Inbox is pull-only. A nudge can be added later on the same data.
5. **One item per person across channels.** A reply from either of them on any channel the OS sees closes it.
6. **Holding replies do not close.** The Thumbtack auto first reply, and anything the AI reads as "let me check and get back to you", keep the item open as a promised follow-up.
7. **Derived live; nothing copied.** Inbox reads the source tables directly. The only new stored data is the AI read, the human taps, who opened what, and the per-phone opt-out record (decision 10).
8. **The AI read is Anthropic** (`ANTHROPIC_API_KEY`, set in Render 2026-10-06). The default model is `claude-opus-5-5` at low effort (section 6.3), the claude-api skill's default. Switching to the cheaper `claude-haiku-4-5` is Dallas's call, through one env var.
9. **Keep each person on one number.** The reply line defaults to the DRB line of the most recent human-involved text with that person: their texts, and our human replies. Automated sends do not move it. With no such text, it defaults to the sender's own line: the 1922 for Dallas, the 0082 for Zul, the 888 for anyone else. A switch overrides it. Dallas: "Yes, we want to keep them on one number." Two limits apply: staff are texted from the 888 only (decision 20), and only enabled lines are offered (decision 19).
10. **An opt-out covers every line.** The OS recognizes every word Twilio does. It keeps its own per-phone opt-out record, written on a STOP to any line and on Twilio's opted-out error (21610) from any line. Anyone opted out cannot be texted from Inbox or Messages, from any number.
11. **Truthful attribution.** Every human-triggered client send records who sent it, and the three notices that pass no type get distinct types. Which sends count as a reply is a separate allowlist (decision 26), never including `'other'`.
12. **A payment is not a reply.** The design's "Booked: deposit paid" close reason is not adopted. "Paid! Also, can we add mocktails?" must stay open.
13. **"Not read yet" means nobody opened it.** The chip shows when neither Dallas nor Zul has deliberately opened the item since the newest message. This is the design's meaning.
14. **Inbox is its own page,** first tab on the phone, with a badge in the sidebar. The Needs-attention card drops its unread-text rows.
15. **Zul can text a single active staffer from Inbox.** Group texting stays admin-only.
16. **Google Voice stays on dallasraby@gmail.com** and is read by a box reader in piece 4. It never moves to the business account.
17. **Shift commands only answer shift texts.** A staffer's CONFIRM or CANT is a shift command only on the 888, and only when the latest text DRB sent that staffer was automated. The same condition governs the automated staff replies. When a human texted them last, or on the 1922 or 0082, every staff text is conversation and lands in Inbox. Without this rule, a "Can't" answering Zul's "Can you cover Saturday?" would release the staffer's own shift.
18. **Nothing waiting ever ages out.** History starts at a fixed floor 30 days before launch. After that, a person waits until someone replies, taps Done, or the AI rules no reply is needed, however old the message is.
19. **The 224 lines are enabled only after they prove inbound.** `INBOX_TEXT_LINES` starts at `888`. Each 224 line is added after a round trip (a reply, a STOP and a START) shows up in `sms_messages` with the right `metadata.to`.
20. **Staff are texted from the 888 only.** The 224 campaign's registered use case is customer care, and the 888 is the line staff already know from shift texts. The staff composer has no FROM switch, as in the design.
21. **Calls count as a reply at 60 seconds or more.** Neither bridge detects answering machines, and a voicemail left is not an answer. A consult call where the client never answered never counts. Shorter calls show in the thread but do not close the item.
22. **"Event happened" applies only to booked events,** and only when the person's newest message came on an earlier day (Chicago) than the event.
23. **A promise holds until a real reply or Done,** whatever the person writes in between. "ok thanks" after "I'll check and get back to you Monday" leaves the promise open.
24. **Snoozed people stay visible** in a Snoozed group under Waiting, with Wake (the design).
25. **A send that never arrived is not a reply.**
    - A text counts until Twilio reports it failed or undelivered (a status callback); then the item reopens.
    - An email with a recorded bounce counts as failed.
    - A proposal send counts only if at least one of its deliveries went out.
26. **Only answering sends close an item.** These count: proposal send and resend, "Send to client", invoice, shopping list, consult recap, the change-request decision, and the event-details notice. Nudges never close: payment reminder, portal invite, drink-plan nudge and re-enroll. The trade is stated plainly: a deliverable sent from elsewhere closes the item even when the person also asked something it did not answer. Recently handled shows it with Reopen.
27. **A needs-reply ruling sticks.** Once any read in a waiting stretch says a reply is needed, the stretch stays waiting until a real reply, Done or Reopen. A later "Thanks!" cannot close it.
28. **All Inbox times are Chicago time.** Snooze presets use the Chicago helpers. Times in the feed line and the error card carry "CT".
29. **Replies go to the number the person last texted from.** That is the E.164 on their latest inbound text. A client with no inbound text gets `clients.phone`. A number is never rebuilt from a person key.
30. **Sending has no Undo.** A text cannot be recalled, so the send toast says "Sent from 1922" with no action. The design's send-undo is overridden.
31. **The legal-hold client is flagged and never read by the AI.** Their item shows "Legal hold: check with Dallas before contacting" on the context card, and no text from or about them goes to Anthropic.

## 4. What Dallas and Zul see and do

### 4.1 Waiting

**One row per waiting person** (section 5.5), longest wait first. Each row shows:
- **Wait rail:** a big number and unit (MIN, HRS, DAYS), red at 24 hours or more.
- **Name**, and one line of what they need: the AI read's summary, or the start of their latest message until the read lands. A picture-only text reads "Sent a photo".
- **One state chip, at most,** in this priority:
  - an active claim: "Zul's on it", "Dallas is on it" or "You're on it";
  - a promise: "You said you'd follow up" when the viewer wrote the holding reply, otherwise "Follow-up promised" (always the case for Thumbtack, whose author is unknown);
  - "Reopened";
  - "Not read yet".
- **Channel tags** for every channel they used in this waiting stretch: Thumbtack, Text 888, Text 1922, Text 0082, Staff text, and later Email, Zola and Google Voice.

**Snoozed group.** Below the waiting rows, snoozed people appear as "<name> snoozed until Wed 8:00 AM" with a Wake button, as in the design.

The tab label carries the count, and the same count is the sidebar and phone-tab badge. Snoozed people are not counted. The list closes with the feed-health line (section 4.6).

### 4.2 An opened item

Each item has its own route, `/inbox/:personKey`, so it can be linked and the phone header can show it (section 9).
- **Loading:** a skeleton.
- **Error:** the same card as the list.
- **Gone:** a key that no longer resolves gets "This conversation moved", and the server's redirect hint is followed. This happens when an unknown number became a client.

**Header:**
- back, the name, and the kind and event type: "Booked · Wedding", "Lead · Wedding", "Staff · Bartender", "Thumbtack lead", or "Not a client yet";
- guest count when known, and the existing switch-to-desktop control on the phone;
- under it, "Waiting N" plus the state chip. For a promise, a line says who promised and what they said ("You said Monday").

**Context card**, by kind:
- **Client or lead:**
  - a Lead or Booked chip (Booked means `deposit_paid`, `balance_paid`, `confirmed` or `completed`, per `proposalStatus.js`) and the event type via `getEventTypeLabel`;
  - When, Where, and Proposal (a status line plus an Unsigned, Signed or None chip);
  - Total, Paid, and Balance with the due date;
  - buttons for Client, Proposal and Event. Event shows only when the proposal has become one. "New proposal" shows when there is no proposal.

  The proposal shown is the one with the soonest upcoming event that is not archived, else the most recent. The legal-hold client gets the hold banner (decision 31).
- **Thumbtack lead without a client record:** the lead's name, event date and location from `thumbtack_leads`, and the Thumbtack link.
- **Staff:**
  - a Staff chip and role;
  - their next upcoming approved shift, found with `shiftNotFinishedSql`: date and time, event and venue, and roster fill such as "3 of 4" from `openSlotsSql`, with an open-seat chip;
  - buttons for Staff profile and Shift.
- **Unknown number** (applicants included): the number and "Not a client yet", with a New proposal button that opens the existing create page.

**Messages:**
- **Scope:** every message with this person in the last 30 days, plus any older message still unanswered, oldest first, across channels, with day separators. Times are Chicago time.
- **Bubbles:** each carries its channel tag, its time, and, on our side, the author: "You", "Zul", "Dallas", or "Auto" for automated sends.
  - A relay text names the lead behind the proxy number.
  - A picture message shows "Photo" with a link to the media.
  - A failed send shows "Not delivered", with Twilio's reason.
  - OS emails show their subject, because there is no body column.
- **System lines:** non-message events, such as "Proposal sent by Zul", "Call, 3 min, Dallas", "Opted out of texts", "You said you would follow up Monday", "Zul is on it, 11:02 AM", "Was closed: proposal sent", "Reopened by you".

**Opening:**
- Opening an item from the list marks it seen (decision 13). For a client, it also marks their Messages thread read, so the Messages badge does not grow for people handled in Inbox.
- The desktop's automatic selection does not mark anything seen. That covers both the first load and moving to the next item after Done, and matches `Messages.js:41-53`.

### 4.3 Replying

The footer sits in thumb reach: On it, Snooze and Done, then the reply area for the person's latest channel.

**Texts:**
- **The switch:** the FROM switch offers the enabled lines (decision 19), with "last texted <line>". Below it, a box ("Text Tomás from 1922") and Send.
- **The default line** follows decision 9.
  - Thumbtack proxy numbers get the 888 only, the line registered with Thumbtack.
  - Staff get no switch: the composer shows "Sends from the staff line, same as the shift texts" (the design), and the 888 is used.
- **Recipient:** the text goes to the number the person last texted from (decision 29).
- **First text from a 224 line:** the first text ever sent from a 224 line to a number starts with "Dr. Bartender: ". The server adds it, and the box shows it before sending, so the person knows who the new number is.
- **Late hours:** outside 8 AM to 9 PM Chicago time, the composer shows "It's 10:40 PM for them" (Central assumed). This is a warning, not a block.
- **Sending:**
  - Send is disabled while a send is in flight.
  - Every send carries an id, so a double tap or a retry never texts twice.
  - A failed send keeps the draft and shows the failure in the thread.
  - The 60-second refresh never clears a draft.
  - If the other person replies or closes the item while you are drafting, the draft stays, and the thread gains their reply or a "Zul texted back" line.
- **Closing:** a sent text that counts as a reply closes the item. The send toast reads "Sent from 1922", with no Undo (decision 30).

**Opted out** (section 5.8):
- The reply box is replaced by "Texts are off for this person since <date>. Texts from 888, 1922 or 0082 will not deliver." The date is omitted when it is unknown.
- When the person has another channel with an app link, its Open button stays.
- A phone marked bad shows "This number can't receive texts" instead.

**Thumbtack:** "Open in Thumbtack" goes to `https://www.thumbtack.com/pro-inbox/messages/<negotiation_id>` (the agent's pinned URL). Caption: "Closes here on its own once you reply in Thumbtack."

**Email, Zola, Google Voice (pieces 3 and 4):** "Open in Gmail", "Open in Zola" or "Open in Google Voice". Each piece's spec sets its caption from what the OS can actually see. Zola, for example, closes on its own only when the reply goes by email.

### 4.4 On it, Done, Snooze, Wake, Reopen

- **On it** claims the item for the viewer.
  - Tapping it on your own claim releases it.
  - On someone else's active claim, it reads "Take over from Zul" (the design), and the viewer's claim replaces theirs.
  - A claim ends when anyone replies, when it is Done, or 4 hours after it was made.
- **Done** closes the item, promise included, until the person writes again on any channel.
- **Snooze** offers:
  - 3 hours;
  - Tomorrow morning (8:00 AM Chicago);
  - Pick a date (the next 7 days, at 8:00 AM Chicago).

  The item moves to the Snoozed group until then, or until the person writes again, whichever comes first. It comes back with its full wait time.
- **Wake** ends a snooze immediately.
- **Reopen** puts a closed item back in Waiting, overriding whatever closed it, until the next real reply or Done.
- **Undo:** Done, Snooze, Wake and Reopen each show a toast with Undo for about 4 seconds. `ToastContext` gains an optional action and duration for this (section 9). Undo marks the action undone. It never deletes it.

### 4.5 Recently handled

The second tab shows everything closed in the last 7 days, grouped by day, newest first. Each row has the name, what they needed, the channel, the time, the reason and who:

| Closed by | Reason text | Who badge |
|---|---|---|
| A text from the Messages page or Inbox | "You texted back from 1922" / "Zul texted back from 888" | D or Z |
| An answering OS send (decision 26) | "Proposal sent by Zul", "You sent the shopping list" | D or Z |
| A Thumbtack message (author unknown) | "Replied in Thumbtack" | none |
| A connected bridge call of 60 s or more | "You called (3 min)" | D or Z |
| Done | "You marked it done" / "Zul marked it done" | D or Z |
| The AI read | "AI: " plus its reason ("AI: just a thank-you") | dashed AI mark |
| Event happened | "Event happened Oct 3" | dashed AI mark |

Each row has Reopen. "You" means the viewer. Later pieces add their own reasons ("You emailed back").

### 4.6 Feed health

A small line under the list shows when each source last delivered anything: "Thumbtack 12 min ago · 888 3 min ago · 1922 2 days ago · 0082 never". Times use `created_at` and Chicago time.
- **Quiet dot:** a dot marks a source that has been quiet for 48 hours or more. This is information, not an alarm; the 224 lines are quiet by nature.
- **AI read status:** the line also says when the AI read is off (no key), paused at its daily cap, or failing (3 or more error reads in the last hour).

A missed Thumbtack webhook shows up as an item rather than in this line (section 5.3).

### 4.7 States

- **Empty:** "Nobody's waiting. Everyone has a reply. New messages land here the moment a feed delivers them." plus the feed line.
- **Loading** (first load only): skeleton rows under "first sync · fetching the inbox".
- **Error:** a red-bordered card:
  - "Couldn't load the inbox. This is not an empty inbox. People may still be waiting; the list just didn't arrive."
  - "Last good load 2:12 PM CT · 8 were waiting", when the page has a last good load.
  - A live Retry.
  - "Check your connection or try again."

  An error never renders as an empty list.
- **Badge "!":** when the count cannot be computed, or the badge fetch itself fails, the sidebar and the phone tab show "!" instead of a number (section 9).

The page refreshes every 60 seconds and on focus, like the badge counts.

## 5. The rules

### 5.1 Events

Each source has a reader that returns events since the history floor, in one shape:

```
{ ref, personKey, channel, line, direction, at, text, author, kind, meta }
```

- **`ref`:** a stable, canonical source reference: `tt:<message_id>`, `sms:<id>`, `ml:<id>`, `pal:<id>`, `lc:<id>`, `cc:<id>`. When two sources describe one real-world event (5.4), the survivor's ref is fixed by rule (`sms:` over `ml:`; `pal:` over the `ml:` rows it absorbs), so the same event always has the same ref.
- **`channel`:** `thumbtack | text | staff_text | email | zola | voice`. The last three come from pieces 3 and 4.
- **`line`:** `888 | 1922 | 0082`, for texts.
- **`direction`:** `in | out | system`.
- **`at`:** the source time. Thumbtack uses `sent_at`, falling back to `created_at`.
- **`author`:** a user id, `'auto'`, or null when the source cannot tell (Thumbtack `Business`). For calls, `answered_by` `'admin'` maps to Dallas and `'va'` to Zul.
- **`kind`:** `message`, `media`, `proposal_sent`, `call`, `opt_out`, `opt_in`, `tt_missed`.
- **`meta`:** includes a `failed` flag for outbound (5.4).

Readers in piece 2: Thumbtack messages, `sms_messages`, `message_log` (with bounces from `email_webhook_events`), proposal sends from `proposal_activity_log`, and connected bridge calls. Pieces 3 and 4 add readers and nothing else.

### 5.2 Who is who

- **Person keys:**
  - `c-<clientId>` for a client;
  - `s-<userId>` for staff;
  - `p-<10 digits>` for an unknown number;
  - `t-<negotiationId>` for a Thumbtack thread whose lead has no client, kept as a string and never passed through `Number()`.

  A key is an identity, never an address: replies use decision 29.
- **Thumbtack** rows resolve through `thumbtack_leads.client_id`.
- **SMS** rows use `client_id` when it is set. Otherwise the reader resolves the phone at read time (`recipient_phone` on inbound), with the same last-10-digit matcher as `lookupSender`: clients first, then staff. A row recorded before its sender became a client therefore joins that client's item.
- **Staff** means the send-eligible set: `role IN ('staff','manager')` and `onboarding_status IN ('submitted','reviewed','approved')`, the same set the text route can reach. Applicants and any other phone match become `p-` items.
- **Relay texts** resolve through `findThumbtackProxyLead`, restricted to leads created before the text, newest first. The bubble names that lead, so a reused proxy number cannot silently land one customer's text on another's item.
- **`message_log`** rows use `client_id`. Rows with none are skipped.
- **Our own numbers are excluded:**
  - the three DRB lines;
  - `ADMIN_PHONE` and `VA_CELL`;
  - the `contractor_profiles.phone` and `users.presence_nudge_phone` of admin and manager users.

  Dallas's staff account shares the 312 with the admin account, so `ADMIN_PHONE` covers it.

### 5.3 What counts as them writing

Counted inbound events:
- **Thumbtack messages:** `Customer` messages, including the opening request.
- **Missed Thumbtack messages:** a relay notice ("X replied to you on Thumbtack.") with no `Customer` message from that lead within 15 minutes of it.
  - The event reads "Thumbtack message the OS never received. Open Thumbtack."
  - This way a dead webhook becomes a visible item instead of silence.
  - A notice that does match a message is dropped.
- **Inbound texts** on any line, from clients, staff or unknown numbers. This includes relay texts that are real messages and picture messages. These are skipped:
  - unambiguous opt words (`stop`, `stopall`, `unsubscribe`, `optout`, `revoke`, `start`, `unstop`). They still appear in the thread as system lines.
  - a staff text the system handled as a shift command (decision 17), read from the outcome now stored on the row (section 9);
  - our own numbers.
- **Ambiguous words count.** A whole-body `cancel`, `end`, `quit`, `yes`, `help` or `info` counts as inbound like any other text, even when the opt-out or help handling also acted on it. "Cancel" about an event and "yes" to "want to lock it in?" are exactly the messages Inbox must not lose. When the word also opted the person out, the item shows the opted-out notice.

### 5.4 What counts as a reply

A reply is an outbound human action toward the person that is not known to have failed:
- **A text with `sender_id` set** (Messages page, Inbox). For staff, it counts only when its `group_id` holds a single recipient, so a group announcement never answers one staffer's question.
- **A `message_log` row with `sent_by` set** whose `message_type` is on the answering allowlist (decision 26):
  - "Send to client", proposal send and resend;
  - invoice;
  - shopping list;
  - consult recap;
  - the change-request decision;
  - the event-details notice.

  Nudges (payment reminder, portal invite, drink-plan nudge and re-enroll), receipts, refund notices, cancel confirmations, gratuity disclosures and line-item removal notices are attributed but never close. `'other'` is never on the allowlist. Section 9 gives the three untyped notices their own types, and a test asserts that every allowlisted string has a real writer.
- **A proposal send by an admin or manager:** `proposal_activity_log` `status_changed` or `status_force_changed` to `sent`, `resent`, or `group_sent`. It counts only when at least one `message_log` row it absorbs is not failed.
- **A Thumbtack `Business` message.**
- **A connected bridge call of 60 seconds or more** (decision 21), lead or consult. A consult row with `client_no_answer_at` set never counts.

**Failed:**
- a text whose `status` is `failed`, including the async failures the status callback records (section 9);
- a `message_log` row with status `failed`;
- an email whose `provider_id` has an `email.bounced` event in `email_webhook_events`.

A failed send still shows in the thread as "Not delivered", but it never counts.

**One event per real-world send.** A text in both `sms_messages` and `message_log` (same Twilio SID) is one event, keyed `sms:`. A proposal send's activity row absorbs the `message_log` rows for that proposal's send types written within 5 minutes of it.

**Holding replies.** A reply is a holding reply when either:
- it is the Thumbtack auto first reply: the `Business` message on that lead whose time is within 2 minutes of `first_reply_sent_at`; or
- the AI read says so (section 6). Only text-bearing replies are read: texts and Thumbtack messages, not proposal sends, calls or subject-only logs.

Until its read lands, an outbound counts as a real reply, so the item closes, and the read may then reopen it as a promise. If the AI is off, replies close items, which is today's behavior. Automated sends never count: texts with `sender_id` NULL, logs with `sent_by` NULL, and website proposal sends.

### 5.5 Waiting, computed

For each person at time `now`, over events since the history floor (decision 18):

1. `R` is the latest real reply (5.4). `D` is the latest Done that has not been undone. `anchor = max(R, D)`.
2. `U` is the set of counted inbound events after `anchor`. `P` is the set of holding replies after `anchor` (outstanding promises).
3. **Waiting** when any of these holds:
   - `U` is non-empty, and either no read covers it yet, or any read on an event in `U` ruled "needs a reply" (decision 27), or the newest event in `U` is a picture or empty text, which the AI may never close;
   - `P` is non-empty (decision 23);
   - a Reopen is later than `anchor`.
4. **Not waiting**, even if step 3 holds:
   - **Snoozed:** a snooze whose `until` is in the future, made after the newest inbound, and not undone or ended by a later Wake. The person shows in the Snoozed group (4.1).
   - **Event happened** (decision 22). All three must hold:
     - the person has no proposal with an upcoming event (event date on or after today, Chicago, `chicagoTodayYmd()`, status not archived);
     - their most recent past event belongs to a booked proposal (`BOOKED_STATUSES`);
     - the Chicago date of their newest inbound is strictly before that event date.

     A Reopen later than that event date overrides this.
5. **Waiting since** is the earliest of `U` and `P`. For a Reopen with no new inbound, it is the Reopen time. A snooze never resets it.
6. **Claim** is the latest claim made after `anchor` and less than 4 hours old, with no later release or Done.
7. **Seen** means an Inbox open is later than the newest inbound.

The **AI subject** is the newest event in `U`. A newer inbound makes a new subject, and an earlier "needs a reply" ruling in the same stretch keeps standing (decision 27).

### 5.6 Recently handled

A person is in Recently handled when they are not waiting and the event that closed their latest waiting stretch happened in the last 7 days. The closing event is the earliest of:
- the real reply;
- the Done;
- the AI's no-reply read;
- the event date.

Reasons follow the table in 4.5.

### 5.7 Windows and limits

- **History floor:** a constant, `INBOX_HISTORY_START`, set to 30 days before launch. Nothing before it opens an item, and nothing after it ever ages out (decision 18).
- **Thread display:** the last 30 days, plus any older unanswered message.
- **Other windows:**
  - Recently handled: 7 days;
  - claim: 4 hours;
  - red wait: 24 hours;
  - feed-quiet dot: 48 hours;
  - missed-Thumbtack match: 15 minutes.

These are constants in the rules module, not env vars. The engine aggregates each person's latest inbound and latest reply in SQL, and loads full events only for people who are waiting, snoozed, or closed in the last 7 days. So cost grows with activity, not with history.

### 5.8 Opt-out and the reply line

**Opted out**, for every line, when any of these holds:
- the client's or user's `communication_preferences.sms_enabled` is false;
- for staff, their agreement's `sms_consent` is false;
- the phone has an active `sms_optouts` row (section 7).

A client with `phone_status='bad'` is not opted out, but cannot be texted ("This number can't receive texts"). One function serves the text route, the Messages reply and the reply box. It wraps `messageSuppression.shouldSendImmediate` for the client checks and adds the user checks and the `sms_optouts` lookup.

**Enabled lines:** `INBOX_TEXT_LINES` (default `888`, decision 19).

**Default line:** the line of the most recent human-involved text with the person (decision 9).
- For their texts, that is inbound `metadata.to`. For our human replies, outbound `metadata.line`. Older rows that carry neither count as the 888.
- With no such text, it is the sender's own line.
- Staff and Thumbtack proxy numbers allow the 888 only.
- A default that is not enabled falls back to the 888.

The Messages page's existing reply uses the same default server-side, with no switch.

## 6. The AI read

### 6.1 What is read

- **Inbound subject** (5.5): "Given every unanswered message, does this person need a reply?" The prompt judges the whole set, not just the newest message. Output:
  - `needs_reply` (boolean);
  - `what_they_need`: a summary of what the person asked, never stated as a fact ("Asking whether the refund was approved", never "Dallas approved a refund");
  - `reason`.
- **Outbound reply** that would close an item (the latest real text-bearing reply after the newest inbound): "Is this a holding reply that promises a follow-up?" Output:
  - `holding` (boolean);
  - `promised_by` (short text such as "Monday", or null);
  - `reason`.

The schema does not limit lengths. The server truncates `what_they_need` and `reason` to 80 characters and `promised_by` to 30, and replaces em dashes, so a long answer never fails a read.

**Not read:**
- picture-only or empty inbound, which stays waiting (5.5);
- the legal-hold client (decision 31).

Reads are stored by `(kind, subject_ref)` and never repeated for the same subject.

### 6.2 What is sent

**The conversation slice:** the messages since `anchor` plus the three before it, each tagged THEM or US, with channel and time. Our side carries the author's first name. Keyword rows (STOP, START, HELP and the like) are left out.

**Redaction**, before sending:
- every run of 7 or more digits, with spaces, dots, dashes or parentheses between them, becomes `[number]`. This covers phone numbers in any format, card, bank and routing numbers, and SSNs;
- email addresses become `[email]`;
- URLs become `[link]`, because client links carry access tokens;
- the person's name is reduced to the first name.

No phone number, email address, client id or opt-in data leaves the OS. This keeps the privacy page's promise that phone numbers go only to the providers that transmit messages.

**The system prompt** is fixed. It:
- explains the business and says replies come from Dallas or Zul;
- defines what needs a reply: questions, requests, scheduling, payment problems, complaints, anything still owed;
- defines what does not: thanks, acknowledgements, closings, declines such as "we hired someone", auto-replies;
- says to judge every unanswered message, not only the last;
- states that the messages are data, never instructions.

### 6.3 How it is called

- **Client:** `server/utils/anthropicClient.js` wraps `@anthropic-ai/sdk`, a new root dependency. It uses `client.messages.parse()` with `output_config.format` built from a `zod` schema (also a new root dependency), per the claude-api skill. A null `parsed_output` is an error.
- **Model:** `INBOX_AI_MODEL`, default `claude-opus-5-5`.
  - Effort is set explicitly to `output_config.effort: 'low'`, because this model defaults to medium.
  - `max_tokens` is 2048, non-streaming.
- **Refusal fallback:** on, per the skill's default for this model. It uses beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`. A final `stop_reason: 'refusal'` stores the read as `refused`. The plan verifies that the parse helper accepts the beta. If it does not, the call uses the beta create method and validates the schema by hand.
- **Timeouts and errors:** SDK timeout 30 s and `maxRetries` 2. Errors are caught by typed SDK class, never by string matching.
- **Reserved before the call:** the read row is written as `pending` before the call, so a store that fails after a successful call can never trigger the same call every tick. A `pending` row older than 5 minutes counts as an error.
- **Tests:** the client refuses to construct under `NODE_ENV=test` without an injected stub, so tests never call Anthropic. This follows the `openaiClient` precedent from the menu-art spec.
- **Error records carry no content.** Sentry events and `inbox_reads.error` carry only the error class, HTTP status and request id, never the prompt slice or the model's output.

### 6.4 When it runs

A scheduler, `inbox_ai_read`, runs every 60 s with a startup delay of 40 s, behind `enabled('RUN_INBOX_READ_SCHEDULER')` and an in-flight boolean (the `service_extension_sweep` pattern). Each tick:
1. computes the inbox;
2. collects subjects with no `ok` or `refused` read, oldest first, at most 20 per tick;
3. reads them;
4. retries an `error` read on a later tick, at most 3 attempts.

**Daily cap:** `INBOX_AI_DAILY_CAP`, default 300 reads per rolling 24 hours, counted from `inbox_reads`. When the cap is reached:
- reads pause;
- one Sentry warning goes out;
- the feed line says so.

Items stay fail-safe (6.5).

**No key:** with `ANTHROPIC_API_KEY` unset, the tick does nothing and the feed line says the AI read is off.

**Privacy first:** the scheduler must not run in prod before the privacy page names Anthropic (section 16).

### 6.5 Failure stance

The AI can only do two things:
- move a waiting item into Recently handled, visibly, with its reason and a Reopen; or
- keep a replied item open as a promise.

An unread, failed or refused inbound read leaves the item waiting. An unread, failed or refused outbound read leaves the reply counted as real. A message that tries to steer the classifier can at worst misfile one item, in plain view.

### 6.6 Cost

This is an estimate, to be checked against the Anthropic usage page after a week. A read is about 1,000 input and 400 output tokens, thinking included. At $4 per million input and $20 per million output for `claude-opus-5-5`, that comes to about 1.2 cents a read.
- **Volume:** today's traffic is roughly 600 to 1,000 reads a month, or about $7 to $12. Pieces 3 and 4 add their own traffic.
- **Worst day:** the daily cap bounds it at about $3.60.
- **Cheaper model:** `INBOX_AI_MODEL=claude-haiku-4-5` cuts the cost to roughly a quarter, at the cost of judgment.
- **Caching:** the system prompt is too short to benefit from prompt caching.

## 7. Data model

New tables, idempotent in `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS inbox_actions (
  id SERIAL PRIMARY KEY,
  person_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('claim','release','done','snooze','wake','reopen')),
  until_at TIMESTAMPTZ,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at TIMESTAMPTZ,
  CHECK ((action = 'snooze') = (until_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_inbox_actions_person ON inbox_actions(person_key, created_at DESC);

CREATE TABLE IF NOT EXISTS inbox_seen (
  person_key TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL,
  seen_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inbox_reads (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('inbound','outbound')),
  subject_ref TEXT NOT NULL,
  person_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','error','refused')),
  needs_reply BOOLEAN,
  holding BOOLEAN,
  summary TEXT,
  promised_by TEXT,
  reason TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, subject_ref)
);

CREATE TABLE IF NOT EXISTS sms_optouts (
  phone_last10 TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('keyword','twilio_21610','backfill')),
  line TEXT,
  cleared_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_send_id
  ON sms_messages ((metadata->>'send_id')) WHERE metadata ? 'send_id';
```

**`inbox_actions`** is append-only. Undo stamps `undone_at` on the viewer's own row made in the last 60 seconds, and the rules ignore undone rows.

**`inbox_seen`** is an upsert.

**`sms_optouts`** is keyed by the same last-10-digit form the matcher uses.
- It is written on a STOP-set word to any line, from any sender.
- It is also written on error 21610 from any line.
- A START-set word clears it, by setting `cleared_at`.
- A one-time idempotent backfill seeds it from every inbound row's `metadata.opt_keyword`, taking the latest keyword per phone across all time.

**Changes to existing data**, with no other schema change:
- **Inbound texts** record:
  - the real line, as `metadata.to`, from Twilio's `To`;
  - the processing outcome, as `metadata.outcome` (`confirm`, `cant`, `conversation`, `opt_out`, `opt_in`, `help`, `unknown_sender`, and the like);
  - picture messages, as `metadata.media`: a list of `{ url, content_type }` from `NumMedia`, `MediaUrlN` and `MediaContentTypeN`.
- **Outbound texts sent from Inbox or the Messages page** record `metadata.line`. Inbox sends also record `metadata.send_id`.
- **The status callback** writes `status='failed'` and the Twilio error code into `error_message` when Twilio reports `failed` or `undelivered`. It never stores any other Twilio status, because `accepted` violates prod's CHECK.

Older rows read as the 888, with no stored outcome. The reader derives the outcome for them (5.3).

## 8. API

All routes are in `server/routes/admin/inbox.js` and registered in `server/routes/admin/index.js`. Each is wrapped in `auth, requireAdminOrManager` and `asyncHandler`. `:personKey` must match `^(c|s|p)-\d{1,20}$` or `^t-[0-9A-Za-z_-]{1,100}$`.

| Route | Does |
|---|---|
| `GET /api/admin/inbox` | Waiting rows, Snoozed rows (name, until, who snoozed), Recently handled rows, feeds, AI-read status, `generated_at` |
| `GET /api/admin/inbox/:personKey` | Person, context card, thread, reply options (mode, enabled lines, default line, last line, recipient number, opted out, bad number, proxy, first-text prefix, app link), state. A key that no longer resolves returns 404 with a `moved_to` hint when one exists |
| `POST /api/admin/inbox/:personKey/seen` | Upserts `inbox_seen` (called on a deliberate open). For a client, it also marks their SMS thread read |
| `POST /api/admin/inbox/:personKey/actions` | `{ action, until? }`: `claim`, `release`, `done`, `snooze` (until 1 minute to 8 days ahead), `wake`, `reopen`. Returns the action id for Undo |
| `DELETE /api/admin/inbox/actions/:id` | Undo: stamps `undone_at` on the viewer's own action, under 60 seconds old |
| `POST /api/admin/inbox/:personKey/text` | `{ body, line, send_id }`: sends a text, details below |

**The text route** carries `adminWriteLimiter` plus a per-user cap of 20 sends a minute.
- **Who can be texted:**
  - `c-` people with a phone;
  - `s-` people in the send-eligible staff set (5.2);
  - `p-` and `t-` people only as a reply: their number must have sent at least one text to a DRB line.

  Anyone else gets 422 `INBOX_NOT_TEXTABLE`. Inbox never cold-texts a number.
- **Validation:**
  - `body` is trimmed, 1 to 1600 characters;
  - `line` must be enabled and allowed for the person: staff and proxies get the 888 only;
  - `send_id` is a client-generated UUID. A repeat returns the first result and sends nothing.
- **Opt-out:** an opted-out person (5.8) gets 409 `INBOX_OPTED_OUT`. A bad phone gets 422.
- **Sending:** through `sendSMS`, to the recipient number of decision 29, with an explicit `from`, a status callback, and the "Dr. Bartender: " prefix on a first text from a 224 line.
  - It writes `sms_messages`: outbound, `client_id` or `recipient_id`, `sender_id = req.user.id`, `group_id` for staff, `metadata.line` (taken from the `from` Twilio returns), and `metadata.send_id`.
  - For clients it also writes `message_log`, with `sentBy`.
  - Staff sends go through the single-recipient core extracted from `messages.js` (section 9). A core result of zero recipients is an error, never a silent success.
- **Errors:**
  - A Twilio failure is saved as a failed row and returned as a client-visible error.
  - Error 21610 also writes `sms_optouts` and returns 409 `INBOX_OPTED_OUT`.

**The cache:** the engine runs through a 30-second in-process cache, shared by `GET /api/admin/inbox`, the item GET and `badge-counts`. Every write (seen, actions, Undo, text, the status callback) clears it.

**The badge:** `badge-counts` gains `inbox_waiting`. A computation that fails or takes longer than 2 seconds returns `null`, and never stalls the other counts.

## 9. Changes to existing code

**SMS lines and sending**
- **Line registry.** A new `server/utils/smsLines.js` maps `888`, `1922` and `0082` to E.164.
  - The 888 comes from `TWILIO_PHONE_NUMBER`. The two 224s are hard-coded constants: they are public company numbers, and the voice env vars fall back to each other, so they are not reused for sending.
  - It also holds the own-line map: Dallas's users 1 and 12 to the 1922, Zul's user 2 to the 0082, anyone else the 888.
  - It parses `INBOX_TEXT_LINES` and implements the default-line rule (5.8).
- **`sendSMS`** gains an optional `from` and an optional `statusCallback`.
  - `from` must be a registry line, and a 224 send always passes it explicitly, never relying on the Messaging Service pool. Leaving `from` unset keeps today's behavior exactly.
  - A Twilio 21610 result from any line writes `sms_optouts`.
- **Status callback route.** `POST /api/sms/status` in `server/routes/sms.js` is Twilio-signature verified and rate limited. It does two things:
  - flips the matching `sms_messages` row (by `twilio_sid`) to `failed`, with the error code, on `failed` or `undelivered`;
  - writes `sms_optouts` on 21610.

  It never stores other statuses, and it does not touch `phone_status` (fix list). Inbox and Messages-page sends register it.
- **Staff send core.** `messages.js` gets its single-recipient send logic extracted into one function: eligibility, consent, and the insert with `group_id`, `sender_id` and `recipient_id`. Both `POST /api/messages/send` and the Inbox text route call it. The existing route's behavior does not change.

**Inbound** (`server/routes/sms.js`, `server/utils/smsInbound.js`)
- **What the route passes.** `To`, `NumMedia`, `MediaUrlN` and `MediaContentTypeN` go into `processInboundSms`. `recordInboundMessage` stores them, plus the outcome. A `To` that is not a registry line is stored as-is and treated as the 888.
- **Line-aware handling** (decision 17):
  - CONFIRM and CANT run as shift commands only on the 888, and only when the latest text DRB sent that staffer was automated (`sender_id` NULL).
  - The automated staff replies (`FREEFORM_STAFF_REPLY` and the no-shift CONFIRM and CANT replies) follow the same condition.
  - Otherwise the staff text is stored with outcome `conversation`, with no TwiML reply, and the existing admin email still goes out.
- **Keywords.** The STOP set adds `stopall`, `optout` and `revoke`. These are Twilio's defaults; the plan checks the Messaging Service's Advanced Opt-Out list for any others.
  - Opt handling runs on every line and for every sender, unknown numbers included.
  - STOP-set words write `sms_optouts`. START-set words clear it.
  - HELP replies stay on every line, because compliance requires them. The round trip (section 16) checks that no line answers twice.
- The existing client and unknown-sender alerts do not change.

**Messages page reply** (`sms.js:171-205`) gains:
- `adminWriteLimiter`;
- the default-line rule;
- `metadata.line` and the status callback;
- `sentBy`;
- the 5.8 opt-out refusal (409).

**Attribution and types**
- Every path in section 2's NULL list passes `sentBy` as a value from the route that an admin or manager triggered. Shared helpers take it as an optional parameter and never read `req.user`, because the refund helper also runs from the Stripe webhook and the refund sweep.
- The cancel confirmation, gratuity disclosure and change-request decision gain distinct `messageType`s and pass `proposalId` and `clientId`, so they stop logging as `'other'` against the newest proposal.
- `contactMessageHistory.js` then labels them correctly, with no change of its own.

**Matcher.** `smsInbound.js` exports the last-10-digit matcher that `lookupSender` uses, so the Inbox reader and `sms_optouts` match phones exactly the same way.

**Admin UI plumbing**
- **Needs-attention:** `buildClientItems` drops the SMS rows, and `OverviewPage.js` stops fetching `/sms/conversations` for that card. Change requests stay. The Messages nav badge does not change.
- **Nav and badge:**
  - `nav.js` gains Inbox under Overview, with `badgeKey: 'inbox_waiting'`.
  - `navBadgeCount` returns `null` when its key is present and null.
  - `Sidebar.js` and `MobileTabBar.js` render "!" for null.
  - When the badge fetch itself fails, `AdminLayout.js` sets `inbox_waiting` to null and keeps the other counts.
  - `MobileTabBar.js` gains Inbox as the first tab, with its own badge, and More stops counting it.
  - `MorePage.js` adds `'inbox'` to `TAB_IDS`.
- **Phone header:** `screenKey.js` maps `/inbox/:personKey` to `inbox-item`, and the item uses `usePhoneHeader` like event and proposal detail.
- **Toasts:** `ToastContext` gains an optional `action` (`{ label, onClick }`) and `duration`. Existing callers do not change.

**Privacy page and conventions**
- **Privacy page:** add "Anthropic, to sort and summarize messages you send us (without your phone number, email address or other numbers)" to the provider list, and bump `lastUpdated`.
- **CLAUDE.md convention "Design artifacts are contracts":** allow the vendored export as the working input when a design arrives as an export rather than through DesignSync. The menu-art spec already used an Artifact read the same way, and the `DesignSync` tool is now limited to `/design-sync` flows.

## 10. Client

**Files:**
- `client/src/pages/admin/Inbox.js`: the desktop page, with routes `/inbox` and `/inbox/:personKey` and the phone fork via `desktopView('inbox')`;
- `client/src/pages/mobile/InboxPhone.js`;
- shared pieces under `client/src/components/inbox/`: row, snoozed row, thread, context card, reply bar, snooze sheet, handled row, feeds line, states.

**Data:**
- Every call goes through `utils/api.js`.
- Polling runs every 60 s, plus on focus.
- Times render in Chicago time through `chicagoDay.js`.
- The last good load (time and waiting count) is kept in memory and in `localStorage` behind try/catch, for the error card.

**Behavior:**
- Undo calls the DELETE route.
- After any action or send, the page refetches the item and the list and calls `refreshBadges()`.
- Each send generates its `send_id` once, and a retry reuses it.
- Drafts live in component state keyed by person and survive refetches.
- The desktop shows the list, the thread and the context side by side. The phone shows the list, then a full-screen item at `/inbox/:personKey`.

**Routes:** `/inbox` and `/inbox/:personKey` in `App.js`, inside the admin shell. Managers are admitted, as on Messages.

## 11. Visual contract

**Benchmark.** Claude Design project `37a08def-ebb3-4979-856c-e54d876bc04d` ("Dallas and Zul's inbox admin"), built on the Dr. Bartender OS Design System (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). Dallas exported it on 2026-10-06 (sync stamp 2026-10-06T08:31:40Z). It is snapshotted byte for byte at `docs/design-artifacts/2026-10-06-inbox/`:
- `Inbox.dc.html`, the canvas;
- `InboxPhone.dc.html` and `InboxDesktop.dc.html`;
- `inbox-data.js`;
- `github.md`, its screen map;
- `support.js` and `_ds/`, so it renders on its own.

Open `Inbox.dc.html` through any static server. Every phone frame is live: tap a row, reply, claim, snooze, close, reopen.

**Gate: satisfied 2026-10-06.** The snapshot is the working input: it is the export's own bytes, delivered as a file rather than through DesignSync. Section 9 amends the convention to say so.

**What the snapshot is and is not.**
- Its people and messages are invented.
- Its JavaScript (`inbox-data.js`, the state machine, the toasts) is mockup scaffolding, not code to port.
- Where its sample data or behavior contradicts sections 3 to 5, those sections win. Examples:
  - a holding email treated as a real reply;
  - "Zul replied in Zola";
  - "Booked: deposit paid";
  - a 1922 reply box for a client the rules would default to the 888;
  - Undo after sending a text.
- Layout, composition, copy, component choices and the numbers below are the contract.

### 11.1 Canvas sections

The canvas has five sections, each in After Hours (dark) and House Lights (light):
1. Phone list.
2. One item opened, in four cases: a text with the From switch; Thumbtack with a promise; opted out; the snooze sheet.
3. Recently handled.
4. Desktop: dark with Tomás open, light with Priya open.
5. States: empty, loading, error.

### 11.2 Phone (393 x 852 frame)

- **Chrome:** the shipped phone admin chrome (`MobileHeader`, `MobileTabBar`).
  - Inbox is the first tab and carries the count badge.
  - Header: brandmark, "Inbox", Search, switch-to-desktop.
- **List:**
  - a Waiting / Handled segmented control with counts;
  - cards with a left wait rail (big number over a unit; ink color, red at 24 hours), the name, the need line (one line, ellipsized), a state chip, and mono channel chips bottom right;
  - the Snoozed group, with "snoozed until" rows and Wake;
  - the feeds line, which closes the list.
- **Item:**
  - a sticky header: back, name, "Booked · Wedding" sub, guest count, switch-to-desktop;
  - the "Waiting 46 hrs" line, with its chip and the promise line;
  - the context card: chip and type; label/value rows WHEN, WHERE, PROPOSAL (with chip); a three-column TOTAL, PAID, BALANCE grid with the due date under the balance; then the link buttons;
  - the "MESSAGES · N CHANNELS" header, day separators, and bubbles. Inbound bubbles sit left and outbound ones right, tinted, each with a mono channel tag, time and author. System lines are centered.
- **Footer:**
  - three equal buttons: On it (or "Take over"), Snooze, Done;
  - for texts, a FROM segmented control (the enabled lines) with "last texted 1922" at right, then the input and an icon send button. Staff get no FROM control, just the staff-line caption;
  - for app channels, a full-width primary "Open in <App>" button with the caption under it;
  - when opted out, the notice card shows above the alternative button.
- **Snooze sheet:** a bottom sheet titled "Snooze <name>", with the subcopy "Hidden until then. It comes back to Waiting with its full wait time." It has three rows with icons and right-aligned times, then Cancel:
  - 3 hours / "5:41 PM";
  - Tomorrow morning / "Wed 8:00 AM";
  - Pick a date / "next 7 days".
- **Handled:**
  - the intro line "Closed in the last 7 days, and why. Reopen puts it back in Waiting.";
  - day headers;
  - rows with name, time, a who badge (D, Z, or a dashed AI mark), the reason, a channel chip, and a Reopen button.
- **Toast:** at the bottom, with an edge color. It carries Undo except after a send.

### 11.3 Desktop (1440 x 900 frame)

- **Shell:** the admin shell (`Sidebar`, `PresenceStrip`, `Header`). Inbox sits under Overview in Workspace, with its badge.
- **Page header:** "Inbox", with the subcopy "Everyone waiting on a reply from Dallas or Zul. Longest wait first, one row per person."
- **Three panes:**
  1. **People waiting:**
     - the "LIVE" label and count;
     - Waiting and "Handled, last 7 days" tabs;
     - rows with icon, name, need, chip, the wait at right (red past 24 hours) and channel chips;
     - the Snoozed group;
     - the feeds footer.
  2. **Thread:**
     - a header with the name, "Waiting 46 hrs · Text 1922 + Email", and On it (or "Take over from Zul"), Snooze (a menu) and Done;
     - the thread;
     - the composer, with the FROM control, a textarea, "Sends as SMS from 1922 to (312) 555-0148." and "Send from 1922".
  3. **Context:** status chip, event and guests, WHEN, WHERE, PROPOSAL, then Total, Paid and Balance with the due date, and the Client, Proposal and Event links.
- **Matching neighbors:** the rows follow the Needs-attention queue's look. The thread and composer follow Messages and `ClientConversation`.

### 11.4 Token rule and components

- **Tokens:** the design system's tokens are lifted verbatim from `client/src/index.css` (its README says so), so the build uses the `index.css` tokens directly, `--ms-*` included. The design's per-skin values map one to one:
  - light: square corners, `--ms-bordeaux` for hot, `--ms-emerald` and `--ms-navy` edges;
  - dark: `--radius` and `--radius-lg`, and the `#ff4d4d` hot red.

  A value with no token gets one under the `ib-` prefix in `index.css`.
- **Phone components:** reuse the shipped `m-*` rules (card, chips, acts, sheet, header). The design lifted them from `index.css`.
- **Desktop components:** reuse `StatusChip`, the adminos `Icon`, the `btn` variants, and the Messages thread styles. New Inbox CSS goes in `index.css` under `ib-`.

### 11.5 Ownership

The client lane owns visual fidelity and works from the snapshot. `ui-ux-review` judges against the artifact in both skins, at 390 px and at desktop width. Usability-clean but off-design is a finding.

## 12. Failure modes

| Failure | Behavior |
|---|---|
| `ANTHROPIC_API_KEY` unset | No reads. Inbound items stay waiting with their latest message as the need line; replies close items; the feed line says "AI read off" |
| Anthropic error or timeout | The read stores `error` (class, status and request id only) and retries on a later tick, up to 3 attempts. Fail-safe per 6.5. A Sentry warning, throttled to once an hour |
| A read left `pending` (crash after reserving) | After 5 minutes it counts as an error and is retried |
| Refusal after fallback | The read stores `refused`. Fail-safe per 6.5 |
| Bad or partial JSON | Same as an error |
| Daily AI cap reached | Reads pause until the rolling window frees; one Sentry warning; the feed line says so; fail-safe per 6.5 |
| A source query fails | The whole GET fails (500) and the page shows the error card. Never a partial list that looks complete |
| Inbox computation fails or exceeds 2 s in `badge-counts`, or the badge fetch fails | `inbox_waiting: null`; the badge shows "!"; the other counts still return or stay |
| Twilio send fails at once | A failed row is saved; the route returns the error; the draft stays; the item stays waiting |
| Twilio reports `failed` or `undelivered` later | The status callback flips the row to failed; the item reopens and the thread shows "Not delivered" |
| An answering email bounces | The bounce event marks it failed; the item reopens |
| A proposal send with no delivery that went out | It does not count; the item stays waiting |
| Twilio 21610 on any line | An `sms_optouts` row is written; 409 `INBOX_OPTED_OUT`; every line now refuses that number |
| Opted out, discovered at send | 409 `INBOX_OPTED_OUT`; nothing is sent |
| Person not textable (cold `p-` or `t-`, ineligible staff, no phone) | 422 `INBOX_NOT_TEXTABLE` |
| Staff send core finds no recipient | An error, never a silent success |
| Line not enabled, or not allowed for the person | 422 |
| Duplicate `send_id` | The first result is returned; nothing is sent |
| Undo after 60 seconds, or on another user's action | 409 |
| A key that no longer resolves | 404 with a `moved_to` hint; the page follows it or says the conversation moved |
| A 224 line's inbound not delivered | The line stays out of `INBOX_TEXT_LINES` until its round trip passes (decision 19) |
| The webhook misses a Thumbtack message | The relay notice without a matching message becomes a "never received" item (5.3) |
| A picture-only text | Shown as a photo; never closed by the AI |
| The legal-hold client writes | The item and the hold banner show; no AI read |
| Two clients share a phone | Resolved like `lookupSender` (first match), the same as today |
| Clients merged | Their old actions keyed to the merged-away client stop applying. Rare and accepted |

## 13. Configuration, docs and lists

New env vars, in the CLAUDE.md and README env tables and in `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables the AI read; unset means off. Set in Render 2026-10-06 |
| `INBOX_AI_MODEL` | `claude-opus-5-5` | Model for the AI read |
| `INBOX_AI_DAILY_CAP` | `300` | Max AI reads per rolling 24 hours |
| `INBOX_TEXT_LINES` | `888` | Lines Inbox and Messages may text from; add `1922` and `0082` after each passes its round trip |
| `RUN_INBOX_READ_SCHEDULER` | on | `false` disables the 60-second AI read. Honored only when `RUN_SCHEDULERS` is not `false` |

Same-change docs:
- **README:** folder tree, Key Features, env table, tech stack.
- **ARCHITECTURE:**
  - the route table, including `POST /api/sms/status`;
  - the four tables;
  - third-party integrations (Anthropic);
  - the `metadata.to`, `metadata.outcome`, `metadata.media`, `metadata.line` and `metadata.send_id` conventions;
  - line-aware inbound handling.
- **CLAUDE.md:** env table, Tech Stack (Anthropic), and the design-artifact convention amendment (section 9).
- **Privacy page:** one provider line, and `lastUpdated`.
- **Root `package.json`:** gains `@anthropic-ai/sdk` and `zod`.
- **Fix list:**
  - automated sends consulting `sms_optouts`;
  - `phone_status` from delivery callbacks.

`scripts/sensitive-paths.txt` gains:
- `server/routes/admin/inbox.js`
- `server/utils/inbox/**`
- `server/utils/smsLines.js`
- `server/utils/anthropicClient.js`
- `server/routes/messages.js`

These text people from three numbers, enforce opt-out, touch shift release, or call a paid external API. `server/routes/sms.js` and `server/utils/smsInbound.js` are already on the list.

## 14. Testing

**Anthropic is never called from tests.** `anthropicClient.js` refuses under `NODE_ENV=test` without an injected stub.

**Every fixture is invented.** The repo is public, so no real client name or message text appears in a test.

**Rules** (pure, `server/utils/inbox/rules.test.js`). Each case mirrors a real case from 2026-10-06 with invented names:
- **Cross-channel:**
  - A client texts, then an email reply arrives through a stubbed piece-3 reader, and the item closes.
  - Twelve thank-yous: an inbound read of `needs_reply: false` closes each, with its reason.
  - "Can you do Oct 20?" then "Thanks!" stays waiting: the ruling sticks.
- **Thumbtack leads:**
  - The auto first reply (within 2 minutes of `first_reply_sent_at`) is holding.
  - A manual reply sent before the agent's is not holding.
  - A proposal sent after it, with a delivery that went out, closes the lead. A forced status change to `sent` counts too.
  - A proposal sent with every delivery failed or suppressed does not close.
- **Promises:**
  - A question and a holding reply stay waiting with the promise chip.
  - "ok thanks" after it still waits.
  - Done closes it.
  - A later real reply closes it.
  - A promise with no open question waits from the promise time.
- **Keywords:** "Cancel", "yes", "help" and "info" count; plain STOP and START do not. An opted-out "Cancel" shows the notice.
- **Pictures and empty texts:** a picture-only text waits and is never closed by a no-reply read.
- **Missed Thumbtack:** a relay notice with no matching `Customer` row becomes an item; a matched notice does not.
- **Staff:** a group text to staff does not close a staffer's question; a single-recipient text does.
- **What does not close:**
  - receipts, refund notices, cancel confirmations, payment reminders, portal invites and drink-plan nudges;
  - `'other'`;
  - a failed text, and an async-failed text, which reopens;
  - a bounced email.
- **Calls:** 59 seconds does not close; 60 does; a consult with `client_no_answer_at` never closes.
- **Claims:** they lapse at 4 hours and release on a reply. "Take over" replaces the other person's claim.
- **Done and Snooze:**
  - Done, then a new message, reopens with a fresh wait.
  - Snooze, then a new message, returns early with the full wait.
  - Wake ends a snooze.
  - An undone action is ignored.
- **Event happened:**
  - It closes a booked event only.
  - A same-day message does not close.
  - An unbooked past quote, or a cancelled booking, stays waiting.
  - An upcoming second event blocks it.
  - Reopen overrides it.
- **History floor:** a 45-day-old unanswered message after the floor still waits; one before the floor never opens.
- **Who is who:**
  - our own numbers, `VA_CELL` included, and relay notices are skipped;
  - a relay text that is real is counted and names its lead;
  - the reply recipient is the number they last texted from;
  - a non-US sender is never rebuilt from the key.
- **Dedupe:** an SMS present in both tables is one event, keyed `sms:`. A proposal send absorbs its `message_log` rows. Refs are identical across two runs.
- **Default line,** every branch: human-involved texts only, the enabled-lines filter, staff and proxy 888-only, and the sender's own line.
- **Opt-out,** every signal, including an `sms_optouts` row from an unknown number and a cleared one.
- **Legal hold:** the client is flagged and never sent to the AI.
- **Boundaries:** claim at 4 hours, red at 24 hours, Recently handled at 7 days, missed-Thumbtack at 15 minutes.

**Readers** (dev DB, one suite at a time from the repo root):
- each reader against seeded rows;
- the read-time phone resolution of a pre-client inbound text;
- the bounce join;
- the aggregate-first loading (5.7).

**Inbound** (`smsInbound.test.js` and the `sms` route suites):
- `To`, the outcome and the media are stored.
- CONFIRM and CANT act on the 888 after an automated text. They become conversation after a human text, or on a 224 line, with no TwiML reply, and the staffer's shift is untouched.
- STOPALL, OPTOUT and REVOKE opt out. Every STOP-set word writes `sms_optouts`, for known and unknown senders, and START clears it.
- The `sms_optouts` backfill is idempotent.
- The status callback is signature-verified. It flips `failed` and `undelivered` with the code, ignores every other status (`accepted` included), and writes `sms_optouts` on 21610.

**Routes** (`server/routes/admin/inbox.test.js`):
- **Auth:** unauthenticated and staff requests are refused; a manager is allowed.
- **Keys:** personKey validation, both patterns, and the `moved_to` hint.
- **Actions:** each action, Wake, and Undo (`undone_at`, the 60-second limit, another user's action).
- **Seen:** it marks a client's SMS thread read.
- **Cache:** every write clears it.
- **The text route:**
  - who can be texted: a cold `p-` is refused, ineligible staff are refused, and zero recipients is an error;
  - line validation and the enabled-lines filter;
  - the 888-only rules;
  - opted out (409);
  - 21610 writing `sms_optouts`;
  - a duplicate `send_id` sending once;
  - the first-text prefix;
  - the limiter;
  - writes with `sender_id`, `group_id` and `metadata.line` from the returned `from`.

**Messages reply:** the line default, the limiter, the status callback registration, and the opt-out refusal, including `sms_optouts`.

**Staff send core:** `POST /api/messages/send` behaves exactly as before after the extraction.

**Attribution:**
- Each path in section 2's list writes `sent_by` when an admin triggered it, and NULL when automated.
- The refund helper still works from the webhook and sweep paths, with no user.
- The three notices write their new types and the right proposal.
- Every allowlisted type has a writer.

**AI read:**
- redaction: every digit run of 7 or more in several formats, emails, URLs, surnames, and keyword rows left out;
- server-side truncation and em-dash replacement;
- schema-violating output stored as an error, and refusal stored as refused;
- the `pending` reservation;
- error rows hold no message text;
- the tick cap and the daily cap;
- retries stop at 3;
- no calls when the key is unset.

**Badge:** null renders "!" on the sidebar and the phone tab, a failed fetch sets null, and a slow engine returns null within 2 seconds.

**Existing suites the change reaches stay green:**
- **Server:**
  - `smsInbound.test.js`, the `server/routes/sms` suites, `settings.badgeCounts.test.js`, and the comms action suites;
  - the proposals suites: `archive.test.js`, `crud*.test.js`, `cancel.test.js`, `notifyClient.test.js` and `recordPayment.*.test.js`;
  - the `messages` route suite.
- **Client:** `nav.test.js`, `MobileTabBar.test.js`, the `MorePage` suite, the `queueItems` suite, and the `ToastContext` callers.

**Visual:** `ui-ux-review` against the snapshot, in both skins, phone and desktop, for every canvas case.

**Acceptance on prod data.** The box has no prod `DATABASE_URL`, so the readers' SQL runs read-only through the Neon MCP against prod, and its output goes through the rules module locally. The result is compared with the 2026-10-06 preview (section 2). Expected: only the texted-then-emailed client (until piece 3) and the borderline item waiting, plus whatever arrived since. The first prod page view is the second check.

**Live smoke.** The AI reads run only where the key lives, in Render.
- Watch the first prod reads.
- Dallas and Zul each claim, reply to, and close one real item.
- Run the 224 round trips before enabling those lines (section 16).

## 15. Review level

**Server lanes: full review fleet,** plus `/second-opinion` at push. They change:
- the inbound SMS webhook and shift release;
- the SMS send path, the status callback, and the opt-out rule;
- attribution inside the refund, cancel and payment-receipt paths.

**Client lane:** one reviewer, the client suites, and `ui-ux-review` against the artifact.

## 16. Rollout

1. **Privacy first.** The privacy-page line merges in the same lane as `anthropicClient.js` or earlier, so no push can ship AI reads before the page names Anthropic.
2. **Server lanes merge first.** Nothing visible changes until the page lane lands, except four things, each safer than today:
   - attribution;
   - the line-aware inbound handling;
   - the opt-out keywords and record;
   - the status callback.
3. **Point the 0082 at the OS.** Set its Twilio `sms_url` to `https://api.drbartender.com/api/sms/inbound`, and confirm that the Messaging Service defers inbound to each number's webhook. This is a Twilio config change that Dallas approves (or makes) at the time.
4. **Page lane, then the push.** The push waits for Dallas's cue. `INBOX_TEXT_LINES` stays `888`.
5. **Watch the first hour of AI reads in prod.** Sanity-check Recently handled against the real threads.
6. **Round trips on the 224s.** For each 224 line:
   1. Dallas texts it from his own phone.
   2. He replies from Inbox on that line.
   3. He texts STOP, then START.

   Each step must appear in `sms_messages` with the right `metadata.to` and outcome. STOP must block every line, and HELP must be answered once. Only then is the line added to `INBOX_TEXT_LINES` in Render.
7. **Run alongside Cowork.** Dallas and Zul use Inbox for a week alongside the Cowork job, and pieces 3 and 4 follow. The Cowork job is retired (piece 5) once Inbox has earned trust.

## 17. Amendments from planning (2026-10-06)

The plan (`docs/superpowers/plans/2026-10-06-inbox.md`) was written lane by lane against this spec and verified against main. Planning surfaced the points below. Each one amends the section named, and the plan implements the amended reading.

1. **Lane order (sections 15, 16).** `send-attribution` runs after `sms-lines`, because both edit `server/utils/sms.js`, a sensitive path. `inbox-engine` follows both. `inbox-ai` and `inbox-page` follow `inbox-engine` and run in parallel.
2. **Send idempotency (sections 7, 8).** A unique index on `sms_messages` cannot stop two concurrent requests from both texting, because the staff send core writes its row after the Twilio call. So the index is replaced by a reservation table, `inbox_sends`:
   ```sql
   inbox_sends (
     send_id UUID PRIMARY KEY,
     person_key TEXT NOT NULL,
     user_id INTEGER REFERENCES users(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     result JSONB
   )
   ```
   - The text route inserts the reservation before any Twilio call.
   - A repeat of a `send_id` that has a stored result gets that result back.
   - A repeat while the first send is still running gets 409.
   - `metadata.send_id` is still recorded on the `sms_messages` row, for tracing.
3. **`send_id` reuse (sections 4.3, 10).**
   - **Kept:** the client keeps a `send_id` when the server never answered (a network error); on 409 `INBOX_SEND_IN_PROGRESS`, which means the first send is still running; and on any answer with no error code, such as a rate-limiter 429, which arrives before any reservation.
   - **Spent:** any other answer spends the id, including a Twilio failure that stored a failed row and 409 `INBOX_SEND_UNRECORDED`. The next tap then gets a new id. Otherwise a failed text could never be re-sent.
   - **Stuck reservations:** a reservation older than 2 minutes with no stored result answers `INBOX_SEND_UNRECORDED`, so a crashed request can never block a draft for good.
4. **Which staff texts are skipped (section 5.3).** Lane `sms-lines` stores a `metadata.outcome` on every inbound text. The staff values are:
   - `staff_confirm` and `staff_cant`: a shift actually changed. These two, and only these, are skipped as inbound.
   - `staff_confirm_no_shift`, `staff_cant_no_shift`, `staff_confirm_ambiguous`, `staff_cant_ambiguous`, `staff_cant_race`, `staff_freeform` and `conversation`: each still needs a human answer, so each counts.
5. **Keyword rows in the AI slice (section 6.2).** Only the seven unambiguous opt words (`stop`, `stopall`, `unsubscribe`, `optout`, `revoke`, `start`, `unstop`) are left out of the slice. `help`, `info`, `cancel`, `yes`, `end` and `quit` stay, because section 5.3 counts them as real messages.
6. **The AI call (section 6.3).**
   - It uses `client.beta.messages.parse()`, which carries the fallback beta in a header. The hand-validated fallback path is not needed.
   - When the model is a Haiku, the call omits `effort` and the fallback.
   - Every call has a 2-minute deadline, because the SDK otherwise waits out any `retry-after` with no ceiling. The deadline is tied by a test to the 5-minute stale-`pending` window.
   - Messages are capped at 1,500 characters each and prompts at 12,000, dropping the oldest lines first.
   - The AI-read status reads "off" when the key is unset or the scheduler is disabled.
   - The daily cap counts attempts, not rows.
7. **The first-text prefix (sections 8, 9).** The "Dr. Bartender: " prefix on a first text from a 224 line applies to the Messages-page reply as well as to Inbox. The item payload carries it as a map by line, for example `{ "1922": "Dr. Bartender: " }`.
8. **422 responses (section 8).** `server/utils/errors.js` has no 422 class. `inbox-engine` builds them from `AppError` directly.
9. **Refund-notice callers (section 2).** `cancel.js:683` and `cancelLineItem.js:225` are two more human callers. Both pass `sentBy`.
10. **Allowlist strings (sections 5.4, 26).**
    - `ANSWERING_MESSAGE_TYPES` = `proposal_sent`, `initial_proposal`, `proposal_sent_sms`, `proposal_options_sent`, `invoice_sent`, `shopping_list_ready`, `shopping_list_ready_sms`, `consult_recap`, `change_request_decision`, `reschedule`.
    - `PROPOSAL_SEND_MESSAGE_TYPES` is the first four.
    - A `send_now` create writes no `status_changed` row. Inbox therefore sees that send through its `message_log` rows alone.
    - When an `sms:` row and an `ml:` row are merged into one event, the author and the type come from the `ml:` row. The "Send to client" and event-details texts leave `sender_id` NULL on purpose.
11. **Messages route suite (section 14).** None existed. `sms-lines` creates `server/routes/messages.send.test.js` and runs it green against the old route before the extraction.
12. **Item payload (section 8).** The item gains:
    - `status` (`waiting`, `snoozed`, `handled` or `quiet`);
    - `snooze` (`{ until, by_name, mine }` or null);
    - `closed` (`{ reason_text, closed_at, by }` or null);
    - `state.since`, when the claim was made.
13. **Client routes and display (sections 4, 10, 11).**
    - **Route:** one route, `/inbox/:personKey?`, so drafts survive moving between the list and an item.
    - **Toast:** it sits under the header, as the design draws it.
    - **Snooze dates:** Pick a date offers tomorrow through 7 days out.
    - **Closed items:** a closed item hides On it, Snooze and Done but keeps the reply box.
    - **Handled rows:** they carry a muted "what they needed" line (section 4.5 wins over the mock).
    - **Feed times:** feed times are relative, and the Chicago clock time with "CT" sits in their hover text.
    - **House Lights:** the shipped light-skin rules apply to Inbox as to every admin page.
14. **The CLAUDE.md design-convention amendment (section 9)** is committed on main with the plan, before any lane, so `inbox-page` builds from the vendored export with the convention already allowing it.
15. **Fix-list additions:**
    - Shift approval and auto-assign texts (`shifts.approval.js:370`, `:590`; `autoAssign.js:402`) write no `sms_messages` row, so decision 17 cannot see them. This errs safe: no shift is released, but a CONFIRM may land in Inbox.
    - Admin links styled as `.btn` render in IM Fell (`ClientDetail.js`, `PayPanel.js`, `PlansDrawer.js`).
    - The client's signed-confirmation email (`publicToken.js:598`) logs as `'other'`.
16. **Rules details pinned by `inbox-engine` (sections 5.5, 8):**
    - A claim also ends when any reply follows it, holding or real.
    - A Reopen ends an active snooze.
    - A Reopen on or after the event's Chicago date overrides "event happened".
    - The AI slice is capped at 20 lines after the anchor, plus up to 3 lines of context.
    - Thumbtack's own system texts on relay numbers (for example "undeliverable") count as inbound.
    - `parsePersonKey` is stricter than the section 8 pattern for `c-` and `s-`: no leading zeros, and at most int4.
    - The effective text-route limit is 10 sends a minute per user, because the shared `adminWriteLimiter` sits in front of the Inbox limiter.
    - `INBOX_HISTORY_START` is set to midnight Chicago, 30 days before the day `inbox-engine` is cut, and a test checks that.
17. **Photos (section 4.2):** Twilio media URLs may need account credentials to load. The first prod picture message confirms whether the link opens directly. If it does not, a follow-up proxies it, and nothing else changes.
18. **Loading (section 5.7).** `inbox-engine` reads light event headers (no message text) since the history floor in pass 1, rather than SQL aggregates, and loads full rows only for the people who matter. Today that is a few thousand rows. The engine logs a warning when pass 1 passes 50,000 headers, which is the signal to add aggregates. The AI tick reads the same 30-second cached snapshot as the page, and only an explicit `fresh` read bypasses it.
19. **Delivery callbacks that arrive before their row (sections 7, 9).** Twilio can report `failed` or `undelivered` before the sending request has inserted its `sms_messages` row. `POST /api/sms/status` then records the failure in `sms_status_orphans`:
    ```sql
    sms_status_orphans (
      twilio_sid TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    ```
    The SMS reader treats any row whose SID appears there as failed, so a fast failure is never lost.
20. **One failure text and one line rule (sections 8, 9).**
    - `twilioErrorText(err)` in `server/utils/sms.js` formats every stored send failure as `Twilio <code> (failed)`. The status callback already uses this form.
    - `lastHumanLineFromRows(rows)` in `server/utils/smsLines.js` is the single "last human-involved line" rule. It counts Thumbtack relay rows as the person's 888 texts. The Messages reply and Inbox both use it.
21. **The "they texted" hint (sections 4.3, 8).** The item's `reply` gains `their_line`, the line of the person's latest inbound text, which feeds the hint. `last_line` keeps its meaning for the FROM default.
22. **Moved person keys (sections 5.2, 7).** An unknown number can become a client, and a Thumbtack lead can gain one. The engine therefore folds every action, seen mark and read stored under a person's alias keys into their current key:
    - an alias key is the `p-` key of any phone they own, or the `t-` key of any lead they own;
    - reads match by `subject_ref` alone;
    - a key with taps but no events never creates a person, so there are no phantom waiting rows.
23. **One event per failed send (section 5.4).** A send that throws leaves an SMS row with no SID and, when the client has a proposal, a `message_log` row with no provider id. The two are paired as one event when they fall within 10 seconds for the same person.
24. **Copy and display:**
    - **No-proposal label:** a lead with no proposal shows "Not sent yet", the design's copy.
    - **Opt-keyword alert:** the unknown-sender opt-keyword alert copy changes, because decision 10 made the old copy false.
    - **Validation messages:** they carry their real copy, never "Please fix the errors below".
    - **Toasts:** the Inbox toast styling (its placement under the header, and the square House Lights edges) applies only while Inbox is open. Every other admin page keeps today's toast.
25. **Privacy line (section 9).** It reads "without your phone number, email address, or card and account numbers". Short numbers, such as guest counts, are kept in what the AI reads, because they are what the person is asking about.
26. **The AI call, refined (sections 6.3, 6.6).**
    - **Tokens:** `max_tokens` is 4096, because thinking is always on.
    - **Model:** `INBOX_AI_MODEL` accepts only `claude-opus-5-5` or `claude-haiku-4-5`; any other value falls back to the default, with one boot warning.
    - **Pre-clip:** each line is cut to 3,000 characters before redaction, then to 1,500 after.
    - **Cap warning:** it is throttled to once an hour.
    - **Cost:** a maximal read costs about 2 to 2.5 cents, so the cap's worst day is about $7 to $8.
27. **Unsettled inbound rows (section 5.3).** A row whose processing has not finished, and so has no outcome yet, counts as inbound. The old whole-body CONFIRM and CANT rule applies only to processed rows from before `sms-lines`.
28. **For piece 4.** Bridge calls already use the event channel `voice`, so the Google Voice reader needs its own token, such as `gvoice`.
29. **Group staff sends (lane `sms-lines`, decision 7).** A group staff send never stops partway.
    - Each staffer's record is saved right after their text.
    - A record that fails to save is logged, without any message text or phone number, and the group carries on, so every staffer still gets the text.
    - Dallas, 2026-10-06, did not want either trade-off: losing every record, or stopping the send.
    - A single-recipient Inbox send still reports a failed save, as 500 `INBOX_SEND_UNRECORDED`.
30. **Merge and push pairing (sections 15, 16).** `inbox-ai` merges before `inbox-page`. `inbox-page` then re-verifies against the new HEAD. No push carries `inbox-ai` without `inbox-page`, because the key is already in Render and AI reads would start with no page to show them.
31. **Unknown-number keys (section 8).** The page accepts `p-` keys of exactly 10 digits. The server accepts 1 to 20, but only ever builds 10-digit keys, so the two never disagree in practice. A 400 on an item read shows the "gone" state.
32. **Opting back in (sections 5.8, 7).** Only START or UNSTOP clears an `sms_optouts` row, as on Twilio's toll-free 888, where YES does not undo an opt-out. A "yes" still counts as a message and still runs the existing client-preference opt-in. The OS opt-out record stays in force until an explicit START or UNSTOP.
33. **Twilio, confirmed 2026-10-06:**
    - **Advanced Opt-Out** is off on the 224 Messaging Service, and stays off, because enabling it is one-way. Twilio applies its standard keywords on every number, so no extra words join the STOP set.
    - **Inbound webhooks:** the service hands inbound texts to each number's own webhook (`use_inbound_webhook_on_number` is true). Rollout step 3 therefore needs only the 0082's `sms_url`.
