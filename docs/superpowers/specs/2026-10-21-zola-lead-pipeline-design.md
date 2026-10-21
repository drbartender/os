# Zola lead pipeline: auto first reply, real client and draft, proposal link in the chat

Date: 2026-10-21. Brainstormed with Dallas in one session (2026-10-17 to 2026-10-21). Revised the same day after the spec fleet (grounding, gaps, risk) and a builder check; section 13 is the record. Parent: the Inbox piece 3 spec (`2026-10-14-inbox-email-zola-design.md`, section 17 item 45: "the Zola lead pipeline is its OWN spec"). This spec replaces the parent plan's lanes zola-leads and zola-draft (section 12).

## 1. Why

Dallas, 2026-10-14: "I want something like the TT first responder and email scrape for zola... follow the same path as TT... automated the way thumbtack does."

Today, by hand (Dallas, 2026-10-17): "When a lead comes in we respond with the same message we send on thumbtack, but with no call (we should be calling, but we don't. yet.) Once we send that message we are 'connected' and have access to all of their contact and event details. the we create the propopsal and generally move chat off of zola unless the client continues to message us there."

So the first reply IS the connect, and the connect is what unlocks the couple's details. Every Zola inquiry costs a person a copy-paste, a client typed in by hand and a draft built by hand. Thumbtack has done all three automatically since 2026-07.

## 2. What it does

1. A new Zola inquiry is noticed: the inquiry email reaches the server through the Gmail feed and asks the box agent to scan Zola's leads list; a jittered 30-minute sweep backs that up.
2. The box agent, logged in to Zola as the business, types the Zola first reply into the lead's reply box and clicks Send. That connects the lead. By day it goes right away; an inquiry that arrives in the night window waits the Thumbtack night delay.
3. Once connected, the agent reads the couple's details from the JSON responses Zola's own page loads and posts the allowed fields to the server.
4. The server finds or creates the client through the shared dedup helper and builds a Core Reaction draft from the real fields.
5. The Inbox item stays open as "follow-up promised" until the proposal goes out, Thumbtack's holding rule.
6. When an admin sends or resends that couple's proposal, the link also goes into their Zola chat, as its own channel next to email and text.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every Zola inquiry that arrives after switch-on gets the Zola first reply within about a minute by day, with no human step.
- Every connected lead from after switch-on, connected by the agent or by hand, becomes a client with real contacts and a Core Reaction draft.
- Every admin proposal send or resend to a Zola couple also lands in their Zola chat.
- Every failure shows where Dallas already looks (the Inbox item, the proposal page, one email per outage) and never stops a human from doing it by hand.

**Non-goals**
- The lead call. Dallas: "we should be calling, but we don't. yet." The design leaves room for respond-then-ring the way Thumbtack does it, nothing more.
- Reading Zola for the Inbox beyond what the agent sees while it works. Couple messages after the connect reach the Inbox as Zola message notices; a reply typed by hand on Zola's site after the first reply still needs Done.
- Leads from before switch-on (49 connected leads on 2026-10-17). The agent never answers, reads or turns them into clients.
- Zola's own outreach features ("first moves", "find couples").
- The options (group) send, the website quote wizard, drips and every other automated message. They get no Zola post (the 2026-10-17 Thumbtack proposal-link spec draws the same line).

**Anti-goals (a failure even if it technically works)**
- A message or a proposal link in the wrong couple's chat. A proposal link is bearer access to the couple's details and to sign-and-pay.
- A second first reply, or a double proposal post (after a hand reply or paste, on a retry, or from stacked sends).
- A first reply that promises a call.
- A client name the OS made up or combined, or a start time it invented (memory `reference-client-names-come-from-the-source`).
- A Zola contact written onto someone else's client row.
- A Zola failure that blocks or delays the proposal email, the text, or the proposal send itself.
- Anything automatic for the legal-hold client (proposal 600's client, memory `reference-proposal-600-legal-hold`).
- A dev server, lane, test or fixture causing real Zola work. There is one Zola account and it is the live one.

## 4. Decisions

Dallas's (2026-10-17 to 2026-10-21):
- Answer every inquiry ("no, we answer every one"). Connecting costs nothing ("we have unlimited zola credits").
- The first reply text is the Thumbtack message he pastes today, with no call promise. Zola has no saved replies ("we copy the one from thumbtack and paste it into zola"), so the text lives in the OS, editable from settings. Seed text, verbatim:

  > Hi there, I'm Dallas, Dr. Bartender's resident alchemist. We're reviewing your details now and your custom proposal is already brewing, headed your way ASAP.
  >
  > Reply here anytime with a question or note and we'll handle everything right in this thread.
  >
  > Serving IL, IN & MI with 20+ years' experience, vetted pros, and $2 million liquor liability insurance included, so you can relax while we handle the science.

- Night delay: the same as Thumbtack ("zola should follow the same night delay").
- The client is the person who sent the request, first and last name exactly as Zola gives them (the name under that person's chat bubbles); the partner's name goes in the client notes ("that is perfect").
- The draft starts from The Core Reaction ("Core Reaction is fine, same as Thumbtack").
- The proposal link also goes into the Zola chat ("It should go into the chat as well").
- The flow playback was approved as a whole ("otherwise this all looks good"): the holding Inbox item, the email trigger plus the 30-minute sweep, never twice, only new inquiries, ships off, the login-lapse email.
- 2026-10-14, carried: build it although The Knot announced acquiring Zola, and make a Zola template change LOUD.
- Accepted risk: automating Zola's vendor site is outside any partner program. Dallas asked for exactly this ("automated the way thumbtack does"), the Thumbtack precedent.
- Not to be built until Dallas says go (2026-10-21: "we are waiting for another project to finish").

My calls (Claude; the first group was in the approved playback, the rest settled from the review):
- **Draft fields.** The Core Reaction; `num_bars` 0 (it is service only and Zola asks no bring-the-bar question); 4 hours; start time blank; event type `wedding-reception`; event date `weddingDate` when it is a full date, else the earliest full date in `weddingDates` that is today or later, else blank with the month (if any) in the notes; guest count `guestCount`, else `guestCountMax`, else `guestCountMin`, else 50, and a value outside 1 to 2,000 counts as missing; venue name plus city and state when Zola has them, else city and state, the state through `venueAddress.normalizeVenueState` and the `VENUE_STATES` allowlist (out-of-area stays blank, as on Thumbtack). Admin notes: the Zola link, budget range, guest range, flexibility flags, and the couple's notes cut at 2,000 characters.
- **The text's home** is `app_settings` key `zola_first_reply_text`, seeded with the text above and edited on the Settings page. The server validates it on save (trimmed, not empty, at most 1,500 characters, the same rule on the page) and again at every lease; a body that fails at lease fails the job (`invalid_body`), so nothing blank or oversized ever reaches a couple. The body stored on the lead row is the record of what was sent.
- **Night delay** is Thumbtack's formula itself, extracted from `routes/thumbtackAgent.js` into a shared helper both pipelines call: an inquiry created inside the night window (`FIRST_REPLY_NIGHT_JITTER_START_HOUR` / `_END_HOUR`, defaults 2 and 8, Chicago, wrap-aware) is due at its creation time plus (2 + lead id mod 13) minutes, so 2 to 14; every other inquiry is due at once.
- **Trigger.** A stored Zola inquiry notice records a scan request; the agent also scans every 30 minutes from 7:00 to 23:00 Chicago, jittered, and scan requests coalesce (one scan at a time; a request during a scan queues exactly one more).
- **Client reuse goes through `clientDedup.findOrCreateClientDetailed`,** the helper every intake uses, with `trustedPhoneMatch` false: an email match resolves the row as is and writes nothing onto it, and a phone match needs the same name on a row with no email. A repeat couple with a new email can become a second client row, accepted as on every other intake.
- **The chat post is its own channel** ("Zola chat" in the SendModal, ticked by default for a Zola-linked client), independent of Text: it goes even when Text is unticked, the phone is blank or bad, or the couple texted STOP (an SMS opt-out covers texts, not the chat they opened with us). It stops only when its line is unticked or a law 9 re-check fails.
- **The post body** is the proposal text: `smsTemplates.initialProposalSms` for this proposal, or the admin's edited text body when Text was ticked and edited, carrying exactly one `/proposal/<token>` link whose token is this proposal's.
- **First moves** (`firstMoveInquiry`, our own outreach) are never auto-answered.
- **One first reply and one draft per Zola lead.** A couple who inquires twice gets a second first reply (their contacts are hidden until the connect) and a second draft, accepted.
- **Signed out:** jobs wait instead of going stale, up to the max age; then they end `cancelled` (`too_old`) and the item says so.
- **Max age:** 24 hours from the inquiry's creation for an auto first reply (`ZOLA_FIRST_REPLY_MAX_AGE_HOURS`). A details pass has no age limit.
- **Re-enable:** the floor (law 1) moves forward to the moment `ZOLA_LEADS_ENABLED` last turned on, so an off period is never replayed.
- **Two kill switches,** like Thumbtack's first reply and the GV post: `ZOLA_LEADS_ENABLED` (scan, discovery, reply, details) and `ZOLA_PROPOSAL_POST_ENABLED` (the chat post). Both `=== 'true'`, both dark by default.

## 5. Verified context

**Spike, 2026-10-17.** One real lead, read through the dedicated profile (`~/.zola-profile`, launched with `--password-store=basic --use-mock-keychain`; headful under `xvfb-run` with `OZONE_PLATFORM=x11`). The script clicked nothing; the capture was deleted after the field names were taken.
- URL shape: `/inspire/vendors/leads/ready/<uuid>` redirects to `/inspire/vendors/leads/connected/<uuid>` once connected.
- The lead: `GET /web-marketplace-api/v1/vendor-inquiry/inquiry/<uuid>` returns `primaryFirstName`, `primaryLastName`, `partnerFirstName`, `partnerLastName`, `emailAddress` (the couple's real address, not a relay), `phone`, `guestCount`, `guestCountMin`, `guestCountMax`, `weddingDate`, `weddingYearMonthDate`, `weddingDates`, `flexibleOnDate` and the other flexibility flags, `notes`, `weddingBudgetEstimate.min/max`, service and wedding price cents, `weddingPartyCount`, `venueNotListed`, `stillLookingForVenue`, `weddingLocationUpdated`, `status` (that lead: `CONNECTED`), `flowType` (`MASS_INQUIRY`), `tier`, `firstMoveInquiry`, `createdAt`, `expiresAt`, and credit fields `creditPrice`, `paidAt`, `paymentRequired`.
- The market: `GET .../vendor-inquiry/<uuid>/match` carries `weddingLocation.weddingMarket` (a city-level label). No venue field was seen; that lead had `venueNotListed`.
- The conversation: `GET .../manage/conversation/inquiry/<uuid>` returns `participants[]` (`key`, `type`, `name`, `firstName`, `lastName`) and `messages[]` (`uuid`, `type`, `body`, `sentByParticipantKey`, `sentAt`); types seen `COUPLE_OUTREACH`, `VENDOR_CONNECT`, `VENDOR_RESPONSE`, `COUPLE_RESPONSE`.
- The lists: `POST .../vendor-inquiry/list` and `GET .../vendor-inquiry/storefront/<storefront uuid>/list-connected` (49 connected that day).
- The reply box: a `newMessage` textarea, a Send submit button, Upload files.
- **Opening a lead page is not read-only:** the page sent `PUT .../manage/conversation/inquiry/<uuid>/read` and `POST .../vendor-inquiry/<uuid>/activity`.
- **Not answered by the spike:** everything about a not-yet-connected lead (section 10, step 0).

**Session, 2026-10-21.** The profile signed in on 2026-10-17 still loaded the leads list signed in four days later (list page only, no lead opened), through Dallas's and Zul's normal use of the same login elsewhere.

**Code on main, 2026-10-21.**
- Every gated Zola notice is stored as `zola_unparsed`, joined to a lead only by the label its subject carries, with no UUID and no template stored (`gmailRules.classifyZola`, `gmailSync.js` near line 426); an inquiry notice names no couple and gets a fresh `Zola notice <date>` row (`zolaLeads.createLead`, `zolaMail.fallbackLabel`); `zolaLeads.markClosed` is never called. `zola_leads.couple_label` and `couple_label_key` are NOT NULL.
- `clientDedup.findOrCreateClientDetailed` (lines 44 to 96) is the shared intake matcher and its anti-takeover rules are as stated in section 4.
- The proposal text half of a send stops at `shouldSendImmediate` for the SMS channel (`sendProposalSentEmail.js` near line 71) and, in the SendModal dispatch, under `wantSms && sms.available` (`utils/comms/actions/proposalResend.js` near line 210). Channels are email and SMS end to end (the comms allowlist, the empty-selection check, `SendModal.jsx`, `sendResult.js`).
- The GV pieces this spec builds beside (`gv_posts`, `routeProposalText`, `routes/gvAgent.js`, `gv-agent/`) exist only in the unmerged lane gv-post-server (a WIP checkpoint) and the plan `2026-10-17-tt-proposal-link-via-gv.md`; that build is paused.
- `PUT /api/admin/settings` upserts any key unvalidated (`routes/admin/settings.js` near line 55).
- `clients_source_check` already allows 'zola'; `proposals_source_check` is add-if-missing (`schema.sql` near line 959), so widening it needs a new drop-and-re-add block (parent spec 5.6 and section 17 items 1 and 42).
- `ProposalDetail.js` is 968 lines against the 1000 cap. The privacy page does not name Zola.
- The Inbox: an outbound event is a holding reply only through `meta.autoFirstReply` (`classify.isHolding`), which only Thumbtack sets today (`normalize.markAutoFirstReplies`); `countsAsReply` counts a system send only by explicit case.

## 6. Laws

1. **Only new, young inquiries.** The floor is the moment `ZOLA_LEADS_ENABLED` last turned on, kept in a Zola agent state row outside `app_settings` (the generic settings route must not be able to move it). `createdAt` and `firstMoveInquiry` come from the inquiry response itself and are re-read at the reply and details steps; a missing or unparsable `createdAt` refuses. An inquiry before the floor, a first move, or (for the first reply) one older than the max age is never answered. A scan records such inquiries as known (`not_needed`) so they are never re-reported or reopened.
2. **Never twice (first reply).**
   - The box journals the job before clicking Send and never sends a journaled job (the Thumbtack agent's `loadSentJournal`/`journalSend`).
   - Before typing, the agent reads the lead's conversation from the page's own response. Any vendor message means someone already answered: `skipped_already_answered`, nothing typed, and the details step still runs. A missing or unparsable conversation response is `failed_preclick`, never "no vendor message".
   - The server never re-offers a leased job; a lease past its window becomes `unknown`, never retried. A late `sent` report upgrades `unknown`, and a pre-click report is accepted after `unknown` (the GV rule: the box is authoritative about "no click happened").
   - A race of seconds between the read and the click is accepted.
3. **The right couple.**
   - Every job runs on a fresh page. The agent types only after the page's lead UUID (its URL and the inquiry response) equals the job's.
   - Every captured response is bound to the job's UUID by its request URL; a response for another lead is never used.
   - A post goes only to the lead linked to that proposal (`zola_leads.proposal_id`), or to the lead whose details step created the proposal's client when exactly one did. Anything else: no post (`no_lead`).
   - A details report is accepted only for a lead holding a live reply or details lease.
4. **Kill switches.** `ZOLA_LEADS_ENABLED` off: no scans, discovery and details reports are refused, no new reply jobs, the reply lease answers `[]`. `ZOLA_PROPOSAL_POST_ENABLED` off: no post rows, the post lease answers `[]`. The server sweep is never gated, so open rows drain to a visible end state.
5. **Production only.** Every lease answers `[]` unless `NODE_ENV` is production. Reply jobs and posts are created only when `SEND_NOTIFICATIONS` allows real sends. The agent points at the production API only, and no agent ever polls a dev or lane server. The agent has a no-click dry-run mode (it opens, reads and reports what it would type) for testing. Tests that insert leasable rows on the shared dev DB delete them (the GV plan's fixture rule).
6. **Caps and pacing.** Rolling 24-hour server caps on first replies, posts, discoveries and details reports (each default 25, through `envInt.js`, so 0, blank or nonsense fall back); a box daily cap; at least 30 seconds between two box sends. A capped job fails as `cap` with one throttled Sentry warning.
7. **A failure never touches the email, the text or the proposal.** The post is post-commit and best-effort; the details step never blocks the reply and never undoes it.
8. **No double post with a human.** Before typing a post, the agent checks the open conversation for the proposal token (the token, not the full URL); found means `skipped_already_posted`, and a missing conversation response is `failed_preclick`. A server pre-check right before the click re-runs law 9.
9. **Re-check at lease and before the click.** A reply job needs: the switch on, the inquiry inside the floor and the max age, not a first move, not expired, a valid body. A post needs: the switch on, the proposal still sendable (not archived, still in the send or resend set), its lead not closed, the client not on legal hold, a valid body (law 10). A failed re-check ends the row `cancelled` with its reason.
10. **Valid bodies.** The reply body passes the settings rule; the post body carries exactly one `/proposal/<token>` link with this proposal's token. The server checks at enqueue and lease; the box checks again before typing.
11. **The legal-hold client.** Before any write, the captured email and phone are tested against the Inbox's held set (`engine.loadLegalHold`, canonical address and phone forms). A match links the lead to the held client, so the Inbox hold covers it, and writes nothing else: no client field, partner note, activity row, draft or post. The details pass is then done (terminal), so it never reopens that couple's page. The first reply cannot be stopped (contacts are hidden until the connect) and is accepted.
12. **Privacy.**
    - The server stores only the fields this spec names, never Zola's raw JSON.
    - Logs and Sentry carry ids only: no couple names, emails or addresses, phones at most last-4, and sanitized causes (the `gvPost` precedent).
    - Diag captures (a screenshot shows the couple's details) live under `~/.zola-profile/diag`, mode 700, out of restic, never in the repo tree (restic backs up untracked and ignored files under `~/projects/os`); pruned at 30 days and 40 captures (GV's rule).
    - `ZOLA_AGENT_SECRET`, timing-safe and fail-closed. Blast radius: it can read pending reply and post bodies (proposal tokens) and, while the switch is on and inside the caps, report discoveries and details for leased leads, which can create clients and drafts. Leak response: rotate the secret, flip both switches off, and review clients and drafts with source zola created since the leak.
    - No client PII in repo docs, fixtures or commits.
13. **The record is the server's.** What the Inbox and the proposal page say was sent is the server's stored body and the box's report, never text read back off the page.

## 7. How it works

**Server.**
- **Lead state on `zola_leads`** (the Thumbtack shape): Zola's `createdAt`, the reply state (`not_needed` by default for every existing and pre-floor row, `scheduled`, `leased`, `sent`, `clicked_unverified`, `skipped_already_answered`, `failed_preclick` with a whitelisted reason, `stale`, `unknown`, `cancelled` with a reason), due time, the body sent, sent time, attempts; and the details state (`none`, `leased`, `captured`, `failed` after 3 attempts with backoff), keyed on its own captured time, never on `proposal_id` (a deleted draft or a held lead leaves that blank).
- **Notices (the parent's Task 14, kept whole).** The notice parser reads the lead UUID from a message notice's "Respond on Zola" link, the message words, and stores the kind by template (`zola_inquiry`, `zola_message`, `zola_closed`, already in the `gmail_messages.kind` CHECK). Message and closed notices join their lead by UUID first, then by label; a closed notice calls `markClosed`. A stored inquiry notice records a scan request. These are changes to lane email-feed code (`gmailRules.js`, `gmailSync.js`).
- **One lead row per inquiry, merged both ways, by mail time.** When the agent reports an inquiry the server does not know, the server looks for an inquiry-notice lead row with no UUID whose notice's mail time is within 15 minutes of the inquiry's `createdAt`; when a notice arrives after the report, it looks for an agent-found lead with no notice inside the same window. Exactly one candidate each way: they join. Anything else stays separate (never a guessed merge).
- **The label.** An agent-found lead starts as `Zola inquiry <date>`; the details step sets `couple_label` to the client's name (the format Zola's message-notice subjects use is checked in step 0, and the UUID join makes the label a fallback only).
- **Scheduling.** Section 4's night formula; due at once otherwise.
- **Details.** One transaction, `FOR UPDATE` on the lead row: law 11 first; then `findOrCreateClientDetailed` with the requester's name, email, phone (through the shared phone validation; invalid means blank plus a note) and source 'zola'; for a new client, the partner's name in the client notes; the draft per section 4, `status` `draft`, `source` `zola`, an activity row by `system`; then `zola_leads.client_id`, `proposal_id` and whether this lead created the client.
  - **The requester** is the couple participant who sent the inquiry's first message. Their `firstName` and `lastName` are the client's name, as Zola gives them (first name only when Zola has no last name). The partner is whichever of the primary or partner names is not the requester. No requester in the response: details `failed` ("couldn't tell who sent it").
  - `proposals_source_check` widens through a new drop-and-re-add block after the add-if-missing one, with its `CONSTRAINT_CONTRACT` entry.
- **Details jobs.** Any known lead from after the floor that is connected (by the agent, or seen connected by hand on a scan) and has no captured details gets a details job.
- **Post queue.** `zola_posts`, shaped like the GV plan's `gv_posts`: one open row per proposal (partial unique index); a second send while a row is `queued` merges into it, the newer body winning; while `leased`, the second send is reported merged and changes nothing; the unique conflict is caught and is never an error to the send (law 7). Terminal states never change; a resend after a terminal row makes a new row. States: `queued`, `leased`, `sent`, `clicked_unverified`, `failed_preclick` (reason), `skipped_already_posted`, `stale`, `unknown`, `cancelled` (reason).
- **Enqueue.** Its own post-commit call at the send sites (the admin initial send in `routes/proposals/lifecycle.js` and `crud.js`, and the SendModal dispatch), beside the email and text halves and never inside the text half or `routeProposalText`. The comms layer gains the `zola` channel end to end (the allowlist, the empty-selection check, the result copy). The parent's no-contact Send guard (Task 16) counts the Zola chat as a channel.
- **Sweep (60 s),** `RUN_ZOLA_SWEEP_SCHEDULER`, honored only with `RUN_SCHEDULERS`. Due-but-unleased jobs and posts past their stale window become `stale`, except while the agent reports signed out (jobs wait, up to the max age). Leased rows past the lease window become `unknown`. Liveness trips on a scan request 15 minutes old with no completed scan, no lease while work is due for 30 minutes, three `failed_preclick` in a row other than `cap`, or three `unknown` or `clicked_unverified` in a row. One admin email per outage episode, shared with the agent's session and challenge reports.
- **Agent endpoints** in their own route file, rate limiter and prefix (not `/api/admin/thumbtack`): scan work, discovered inquiries, reply lease and report, details lease and report, post lease, pre-check and report, and status (`session_expired`, `challenge`, the poll heartbeat). Whitelisted states and reasons only.

**Box.**
- A new systemd user service with its own profile (`~/.zola-profile`), separate from `thumbtack-agent` and the planned `gv-agent`. Headful under Xvfb with `OZONE_PLATFORM=x11` (memory `reference-tt-agent-chrome-env`).
- It reads Zola data only from the responses Zola's own pages load, never by calling Zola's API itself.
- **Scan:** load the leads list, report inquiries the server does not know (UUID, `createdAt`, `firstMoveInquiry`, `expiresAt` when the list carries them).
- **First reply:** fresh page, open the lead, verify the UUID, read the conversation, journal, insert the body in one go (never key by key), click Send, confirm a vendor message carrying the body now shows in the conversation response, report.
- **Details:** fresh page, read the inquiry, conversation and match responses bound to the UUID, report the allowlisted fields.
- **Post:** fresh page, verify the UUID, token check, server pre-check, journal, insert, click, confirm, report.
- A Zola sign-in page or interstitial idles the agent without attempting a login: it reports `session_expired` or `challenge` once and resumes when a later poll finds it signed in. Re-login: Dallas opens the profile on the desktop (the 2026-10-17 command, in `README.md`), signs in and closes it.
- A diag capture on every definitive failure (law 12), the pattern that made each Thumbtack UI break a ten-minute diagnosis.

**Inbox** (`server/utils/inbox/**`, sensitive). Read from `zola_leads` and `zola_posts` by `readZola.js`, since Zola never echoes our sends anywhere we can read:
- An agent-found lead with no joined inquiry notice gets an inbound "New Zola inquiry" event at its `createdAt` (no words, never AI-read), so it is an item like any other. A joined notice suppresses it.
- A `sent` first reply is an outbound event flagged `autoFirstReply`; `countsAsReply` gains its explicit case and `isHolding` treats it as holding, thread line "Auto first reply: follow-up promised" (Thumbtack's).
- `skipped_already_answered` is an outbound "Answered on Zola" event that counts as a reply.
- Item copy by state: scheduled or leased "Auto-reply going out"; `clicked_unverified` or `unknown` "The auto-reply may have gone out: check the Zola chat before answering"; `failed_preclick`, `stale`, `cap` or `cancelled` "The auto-reply didn't go out: answer on Zola" (with "too old" when that is the reason); details `failed` "The couple's details weren't captured: add the client by hand".
- A sent post is part of its proposal send (absorbed by proposal id) and counts as delivery when it is the send's only channel, so it never reads "No email or text went out".
- The feeds line gains the Zola agent: off, on, signed out, down (no poll for 15 minutes while on), failing.
- When the details step links the lead to a client, the person moves to the client's key at read time.

**Proposal page.** A "Zola chat" status row, its own component: posting, posted, skipped (the link was already there), "clicked Send but couldn't confirm: check the chat before pasting", "didn't post: paste the link by hand" (with the reason), and not posted (cancelled, with the reason). It shows the newest row, polls while that row is open, and has loading and error states. ProposalDetail's line budget is shared with GV's row and the Send guard, so the plan extracts from it first.

**SendModal.** The "Zola chat" line for a Zola-linked client; a chat-only send reports "Posting to the Zola chat", never "Done. No message was sent."

**Settings page.** The Zola first reply text with the section 4 rule shown, and a note that it must never promise a call.

## 8. Failure modes

- Signed out or challenged: jobs and posts wait (up to the max age for first replies); one email per episode; the feeds line says signed out; inquiry items still show.
- Zola changed its page or JSON: `failed_preclick` with a reason, a diag capture, Sentry, one email per episode, the item copy. LOUD, per Dallas.
- The Gmail feed is down or off: the sweep still finds inquiries by day, and agent-found leads still get their own item.
- The agent is down: scan requests age and liveness emails once; jobs go `stale` (or `cancelled`, too old) and show on their items.
- A lead Zola has expired: `cancelled` (`expired`).
- The details step fails after a good reply: the reply stands, the item holds, retries back off, then the item says to add the client by hand.

## 9. Left to the builder

- Column names, endpoint paths, lease and stale windows, the backoff numbers.
- The whitelisted reasons (at least `no_reply_box`, `wrong_lead`, `no_conversation`, `invalid_body`, `expired`, `too_old`, `cap`, `timeout`, `session_expired`, `challenge`, `ui_error_before_send`, `no_lead`).
- How the scan reads the list (which list fields mark an unconnected inquiry), from step 0.
- Whether the reply body keeps its line breaks in Zola's textarea (step 0 says whether Enter sends).
- Shared helpers extracted from the Thumbtack code are welcome; changing the Thumbtack pipeline's behavior is not.

## 10. Rollout

- **Step 0, before the plan is final: a read-only capture of the next real new inquiry.** Dallas holds off answering one new inquiry for a few minutes and says so; Claude captures the leads list and that lead's ready page, clicking and typing nothing, and reports field names only. It answers: what a not-yet-connected lead shows; whether the ready page loads the conversation; whether the reply box and Send are there; whether Enter sends; the textarea's length limit; where a chosen venue lives; whether the list carries `createdAt`, `firstMoveInquiry` and `expiresAt`; what the inquiry notice email carries for the 15-minute join; the label format of a message notice's subject; which ids a closed notice carries; and, over the following days, whether opening a lead (the read call) stops Zola from emailing that couple's later message notices. Then Dallas answers the lead by hand as usual. The capture is deleted after.
- **Lanes** (the plan decides the cut): server (schema, notices, endpoints, scheduling, details, the source CHECK, the sweep), box agent, Inbox, proposal post (with the SendModal channel and the proposal page row), and the proposal source consumers (list filter, counts, badge, funnel: the parent plan's Task 20). The proposal post lane is blocked on every GV lane that touches the same files (`SendModal.jsx`, `sendResult.js`, `inbox/thread.js`, `ProposalDetail.js`, the send sites), not only the router lane.
- Ships dark: both switches unset. The Gmail key goes into Render once the server and Inbox lanes are in prod (this replaces the parent plan's "until lane zola-leads is in prod"), then the probe and the switch-on check the parent plan lists.
- Switch-on: `ZOLA_LEADS_ENABLED=true` at a quiet moment; the first real inquiry is the live test (reply on Zola within about a minute by day, client and draft appear, the item holds). Then `ZOLA_PROPOSAL_POST_ENABLED=true`; the next proposal send to a Zola couple is its test.
- `docs/walkthroughs-owed.md` gains the Zola walk: a day inquiry, a night inquiry, a hand-answered inquiry (skipped, details still captured), a proposal send and resend, a chat-only send, a signed-out profile.

## 11. Docs and lists

- `.claude/CLAUDE.md`, `README.md`, `.env.example`: `ZOLA_LEADS_ENABLED`, `ZOLA_PROPOSAL_POST_ENABLED`, `ZOLA_AGENT_SECRET` (blast radius and leak response), `RUN_ZOLA_SWEEP_SCHEDULER`, `ZOLA_FIRST_REPLY_MAX_AGE_HOURS`, the caps; the box service and its re-login steps.
- `ARCHITECTURE.md`: the tables and columns, the route file, the box service, the Inbox's Zola events, the `zola` channel.
- `scripts/sensitive-paths.txt`: the route file, the details and draft writer, the post enqueue, the box agent's send code.
- Privacy page: it names neither Zola nor how a couple's contacts reach us; the builder adds a line if receiving them from Zola needs one.

## 12. Relationship to the parent plan (`2026-10-14-inbox-email-zola.md`)

- Lanes gmail-client, email-feed and email-ai are in prod dark (pushed 2026-10-17).
- Lanes zola-leads (Tasks 14 to 16) and zola-draft (Tasks 19, 20) are replaced by this spec's lanes. They survive inside them: Task 14's notice parser whole (UUID, words, kind by template), Task 15's backfill rule (backfilled threads are items only), Task 16's no-contact Send guard (now counting the Zola chat), the source CHECK block (Task 19 step 1) and the source consumers (Task 20).
- This spec changes email-feed code in `gmailRules.js` and `gmailSync.js` (the parser, the scan request, the closed notice) and Inbox code in `readZola.js`, `classify.js` and the feeds line.
- The parent plan's push gate line points here.

## 13. Review record (2026-10-21)

Spec fleet (grounding, gaps, risk) and a builder check ran on the first draft (`6feff030`). Everything they raised is folded; the main changes:
- Client reuse now goes through `findOrCreateClientDetailed` (all four reviewers): the draft's email-or-phone match with blank-field fill would have let a couple's typed contacts, or a leaked secret, take over another client.
- The chat post has its own hook and channel. The first draft hung it on GV's `routeProposalText`, which runs only inside the text half and would have tied the post to Text and to GV's own switch.
- Notices: on main nothing parses a UUID or stores the template, so the parent's Task 14 is kept whole, the join runs both ways by mail time, and an agent-found lead with no notice gets its own inbound event.
- The night delay is Thumbtack's deterministic formula, not a random wait.
- Added: the max age and the forward-moving floor, production-only leases and the dry-run mode, the details job for hand-answered leads, the per-response UUID binding, lease-time re-checks for posts, body validation, the legal-hold test against the Inbox's held set, per-state Inbox and proposal-page copy, the feeds-line states, and diag captures kept out of the repo tree and restic.
- The builder's question about shared logins was answered by the 2026-10-21 session check (section 5).
