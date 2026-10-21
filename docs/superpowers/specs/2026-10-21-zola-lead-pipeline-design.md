# Zola lead pipeline: auto first reply, real client and draft, proposal link in the chat

Date: 2026-10-21. Brainstormed with Dallas in one session (2026-10-17 to 2026-10-21). Parent: the Inbox piece 3 spec (`2026-10-14-inbox-email-zola-design.md`, section 17 item 45: "the Zola lead pipeline is its OWN spec"). This spec replaces the parent plan's lanes zola-leads and zola-draft (section 12).

## 1. Why

Dallas, 2026-10-14: "I want something like the TT first responder and email scrape for zola... follow the same path as TT... automated the way thumbtack does."

Today, by hand (Dallas, 2026-10-17): "When a lead comes in we respond with the same message we send on thumbtack, but with no call (we should be calling, but we don't. yet.) Once we send that message we are 'connected' and have access to all of their contact and event details. the we create the propopsal and generally move chat off of zola unless the client continues to message us there."

So the first reply IS the connect, and the connect is what unlocks the couple's details. Every Zola inquiry costs a person a copy-paste, a client typed in by hand and a draft built by hand. Thumbtack has done all three automatically since 2026-07.

## 2. What it does

1. A new Zola inquiry is noticed: the inquiry email reaches the server through the Gmail feed, and the box agent finds the lead on Zola. A 30-minute sweep backs that up.
2. The box agent, logged in to Zola as the business, types the Zola first reply into the lead's reply box and clicks Send. That connects the lead. By day it sends right away. In the night window it waits the same random 2 to 14 minutes Thumbtack's night replies wait.
3. Once connected, the agent reads the couple's details from the JSON responses Zola's own page loads, and posts the allowed fields to the server.
4. The server creates the client (or reuses a matching one) with the real contacts, and a draft proposal from the real fields.
5. The Inbox item for the inquiry stays open as "follow-up promised" until the proposal goes out, the same holding rule as Thumbtack's auto first reply.
6. When an admin sends or resends that couple's proposal, the agent posts the proposal link into the Zola chat, in addition to the normal email and text.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every Zola inquiry that arrives after switch-on is answered with the Zola first reply within about a minute by day, with no human step.
- Every connected lead becomes a client with real contacts and a Core Reaction draft, ready for Dallas to check and send.
- Every admin proposal send or resend to a Zola couple also lands in their Zola chat.
- Any failure is visible where Dallas already looks (the Inbox item, the proposal page, one email per outage), and never stops a human from doing it by hand.

**Non-goals**
- The lead call. Dallas: "we should be calling, but we don't. yet." Built later; the design leaves room for respond-then-ring the way Thumbtack does it, nothing more.
- Reading Zola for the Inbox. Couple messages after the connect already reach the Inbox as Zola message notices (lane email-feed). A reply typed by hand on Zola's site still needs Done.
- The 49 leads already connected before switch-on, and any inquiry older than switch-on. They are never answered, read or turned into clients by the agent.
- Zola's own outreach features ("first moves", "find couples").
- The options (group) send, the website quote wizard, drips and every other automated text. They get no Zola post (the 2026-10-17 Thumbtack proposal-link spec draws the same line).

**Anti-goals (a failure even if it technically works)**
- A message or a proposal link in the wrong couple's chat. A proposal link is bearer access to the couple's details and to sign-and-pay.
- A second first reply to a couple, or a double proposal post (after a hand reply or paste, on a retry, or from stacked sends).
- A first reply that promises a call.
- A client name the OS made up or combined, or a start time it invented (memory `reference-client-names-come-from-the-source`).
- A Zola failure that blocks or delays the proposal email, the text, or the proposal send itself.
- Anything automatic for the legal-hold client (proposal 600's client, memory `reference-proposal-600-legal-hold`).

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
- The client is the person who sent the request, first and last name exactly as Zola gives them (the name under that person's chat bubbles). The partner's name goes in the client notes ("that is perfect").
- The draft starts from The Core Reaction, the same as Thumbtack ("Core Reaction is fine, same as Thumbtack").
- The proposal link also goes into the Zola chat ("It should go into the chat as well").
- The flow playback was approved as a whole ("otherwise this all looks good"): the holding Inbox item, the email trigger plus the 30-minute sweep, never twice, only new inquiries, ships off, the login-lapse email.
- 2026-10-14, carried: build it although The Knot announced acquiring Zola, and make a Zola template change LOUD.
- Accepted risk: automating Zola's vendor site is outside any partner program. Dallas asked for exactly this ("automated the way thumbtack does"), the Thumbtack precedent.

My calls (Claude, in the approved playback or settled for the builder):
- **Draft fields:** 4 hours; start time left blank; guest count is Zola's own figure, else the top of its range, else 50; `num_bars` 0 (Core Reaction is service only and Zola asks no bring-the-bar question); event type `wedding-reception`; event date the wedding date when Zola gives a full date (a month-only or missing date leaves it blank and goes in the notes); venue name plus city and state when Zola has them, else city and state, the state allowlisted the way `thumbtackProposalDraft.normalizeVenueState` does it. Admin notes carry the Zola link, the budget range, the guest range, the flexibility flags and the couple's notes (bounded).
- **The text's home:** an `app_settings` row (`zola_first_reply_text`), seeded with the text above and editable on the admin Settings page. The server hands the body to the agent; the body stored on the lead row is the record of what was sent, never what the agent reads back off the page (the Thumbtack law: the DB template is the source of truth).
- **Night window:** the Thumbtack definition itself (`FIRST_REPLY_NIGHT_JITTER_START_HOUR` / `_END_HOUR`, defaults 2 and 8, Chicago), with the same 2 to 14 minute jitter, so the two pipelines can never disagree about what night is.
- **Trigger:** a Zola inquiry notice in the Gmail feed asks the agent to scan; the agent also scans every 30 minutes from 7:00 to 23:00 Chicago. A scan loads Zola's leads list and reports every inquiry the server does not know yet.
- **Proposal post wording and triggers:** the Thumbtack proposal-link spec's, so the proposal SMS text (`smsTemplates.initialProposalSms`, or the admin's edited text body from the SendModal), on the admin initial send and on a SendModal send or resend.
- **SendModal:** a "Zola chat" line for a Zola-linked client, ticked by default, independent of the Text line.
- **First moves:** an inquiry Zola marks as a first move (`firstMoveInquiry`, our own outreach) is never auto-answered.
- **A failed first reply** shows on the Inbox item ("The auto-reply didn't go out: answer on Zola") and the lead is never lost: the notice item stays unread, exactly what Dallas sees today.
- **One draft per Zola lead.** A couple who inquires twice reuses their client and gets a second draft only from a second lead.
- **Two kill switches,** like Thumbtack's first reply and the GV post: `ZOLA_LEADS_ENABLED` (scan, reply, details) and `ZOLA_PROPOSAL_POST_ENABLED` (the chat post). Both `=== 'true'`, both dark by default.

## 5. Verified context (spike, 2026-10-17)

One real lead, read through the dedicated profile (`~/.zola-profile`, launched with `--password-store=basic --use-mock-keychain`; headless capture under `xvfb-run` with `OZONE_PLATFORM=x11`). The script clicked nothing. The capture was deleted after the field names were taken.
- URL shape: `/inspire/vendors/leads/ready/<uuid>` redirects to `/inspire/vendors/leads/connected/<uuid>` once connected.
- The lead: `GET /web-marketplace-api/v1/vendor-inquiry/inquiry/<uuid>` returns `primaryFirstName`, `primaryLastName`, `partnerFirstName`, `partnerLastName`, `emailAddress` (the couple's real address, not a relay), `phone`, `guestCount`, `guestCountMin`, `guestCountMax`, `weddingDate`, `weddingYearMonthDate`, `weddingDates`, `flexibleOnDate` (and the other flexibility flags), `notes`, `weddingBudgetEstimate.min/max`, service and wedding price cents, `weddingPartyCount`, `venueNotListed`, `stillLookingForVenue`, `weddingLocationUpdated`, `status` (that lead: `CONNECTED`), `flowType` (`MASS_INQUIRY`), `tier`, `firstMoveInquiry`, `createdAt`, `expiresAt`, and the credit fields `creditPrice`, `paidAt`, `paymentRequired`.
- The market: `GET .../vendor-inquiry/<uuid>/match` carries `weddingLocation.weddingMarket` (a city-level market label). No venue field was seen; that lead had `venueNotListed` set.
- The conversation: `GET .../manage/conversation/inquiry/<uuid>` returns `participants[]` (`key`, `type`, `name`, `firstName`, `lastName`) and `messages[]` (`uuid`, `type`, `body`, `sentByParticipantKey`, `sentAt`). Message types seen: `COUPLE_OUTREACH`, `VENDOR_CONNECT`, `VENDOR_RESPONSE`, `COUPLE_RESPONSE`.
- The lists: `POST .../vendor-inquiry/list` and `GET .../vendor-inquiry/storefront/<storefront uuid>/list-connected` (49 connected leads that day).
- The reply box: a `newMessage` textarea, a Send submit button, an Upload files button.
- **Loading a lead page is not read-only.** The page itself sent `PUT .../manage/conversation/inquiry/<uuid>/read` and `POST .../vendor-inquiry/<uuid>/activity`. Accepted: the agent only opens leads it is about to answer or has answered.
- **Not answered by the spike:** what a not-yet-connected lead shows before the connect, whether Enter sends in the textarea, where a chosen venue lives, and what the inquiry notice email carries for matching (section 10, step 0).
- From lane email-feed (on main): `zola_leads` (`lead_uuid` UNIQUE, `couple_label`, `wedding_date`, `client_id`, `proposal_id`, `closed_at`); an inquiry notice carries no lead UUID and no couple label, so it gets a fresh "Zola notice" row (`zolaLeads.createLead`); message notices carry the UUID and match by it (`findOrCreateLead`).

## 6. Laws

1. **Only new inquiries.** The server records the moment `ZOLA_LEADS_ENABLED` first reads true (a stored floor, never moved back). An inquiry whose Zola `createdAt` is before the floor is never answered, read for details or turned into a client. A first move is never answered.
2. **Never twice (first reply).**
   - The box journals the reply job before clicking Send and never sends a journaled job (the Thumbtack agent's `loadSentJournal`/`journalSend` guard).
   - Before typing, the agent reads the lead's conversation from the page's own response. Any vendor message (`VENDOR_CONNECT`, `VENDOR_RESPONSE` or any message sent by the vendor participant) means someone already answered: the job ends `skipped_already_answered`, nothing is typed, and the details step still runs.
   - The server never re-offers a leased job. A lease that passes its window unreported becomes `unknown`, and `unknown` is never retried (a human checks).
3. **The right couple.** The agent types only into the lead whose UUID the job names: it verifies the opened page's lead UUID (the URL and the inquiry response) before typing, for the first reply and for every proposal post. A proposal post's lead is the `zola_leads` row linked to that proposal; failing that, the client's single connected Zola lead (exactly one, else no post).
4. **Kill switches.** `ZOLA_LEADS_ENABLED` off: no new reply jobs, the lease answers `[]`, no scans are requested. `ZOLA_PROPOSAL_POST_ENABLED` off: no post rows are queued, the lease answers `[]`. The server sweep is never gated, so queued rows drain to a visible end state.
5. **Notifications gate.** Reply jobs and post rows are created only when `SEND_NOTIFICATIONS` allows real sends, so a dev server, lane or test suite on the shared dev DB never makes real Zola work.
6. **Caps and pacing.** A server rolling-24-hour cap on first replies and one on posts (each default 25, parsed through `envInt.js` so 0, blank or nonsense fall back), a box daily cap, and at least 30 seconds between two box sends. At a cap the job fails as `cap` with one throttled Sentry warning; the Inbox item still shows the inquiry.
7. **A failure never touches the email, the text or the proposal.** The post is post-commit and best-effort. The details step never blocks the reply, and a failed details step leaves the reply's record intact.
8. **No double post with a human.** Before typing a proposal post, the agent checks the open conversation for the proposal token (match on the token, not the full URL). Found means `skipped_already_posted`.
9. **The legal-hold client.** When the captured contacts resolve to the legal-hold client, the server creates no draft and queues no post, and the Inbox item carries the hold as it does today. The first reply cannot be stopped (the contacts are hidden until the connect) and is accepted.
10. **Privacy.**
    - The server stores only the fields this spec names, never Zola's raw JSON; the couple's notes are bounded.
    - No phone numbers in logs, UI or file names beyond last-4; no couple names or addresses in logs.
    - The Zola profile is a credential: its directory stays mode 700 and out of restic (it is not in `~/bin/restic-backup.sh`'s list today; keep it that way). Diag captures are pruned by age and count.
    - A separate agent secret, `ZOLA_AGENT_SECRET`, timing-safe and fail-closed, with its own blast-radius and leak-response line in the env tables. A leaked secret can read pending reply and post bodies (proposal tokens) and submit lead details for leads the server already scheduled. Leak response: rotate the secret and flip both switches off.
    - No client PII in repo docs, fixtures or commits.
11. **The record is the server's.** What the Inbox and the proposal page say was sent is the server's stored body and the box's report, never text scraped back off the page.

## 7. How it works

**Server.**
- **Lead state** lives on `zola_leads`, the Thumbtack shape (first-reply state sits on `thumbtack_leads`): Zola's `createdAt`, the reply status (`scheduled`, `leased`, `sent`, `clicked_unverified`, `skipped_already_answered`, `failed_preclick` with a whitelisted reason, `stale`, `unknown`, `cancelled`), the due time, the body sent, the sent time, attempts, and the details-captured time.
- **Merging the inquiry notice row.** When the agent reports an inquiry the server does not know, the server looks for an open `zola_leads` row with no UUID that an inquiry notice created within 15 minutes of the inquiry's `createdAt`. Exactly one such row and exactly one unknown inquiry in that window: the row takes the UUID, so the unread notice item becomes this lead's item. Anything else: a new row with the UUID, and the notice item stays for a human (never a guessed merge).
- **Scheduling.** Due now by day; due now plus 2 to 14 random minutes in the night window.
- **Details.** The agent's details report (an allowlisted field set, bounded) creates or reuses the client inside one transaction, the `thumbtackProposalDraft` transaction shape (`FOR UPDATE` on the lead row, idempotent on `zola_leads.proposal_id`):
  - client reuse: an existing client whose email (lowercased, trimmed) or phone (last 10 digits) matches; a reused client's name and contacts are never overwritten, only blank fields are filled;
  - a new client: name from the requester's conversation participant (`firstName` + `lastName`), cross-checked with `primaryFirstName`/`primaryLastName`; email; phone through the shared phone validation (invalid means blank plus a note); `source` recorded the way Thumbtack clients record theirs; the partner's name in the client notes;
  - the draft per section 4, `status` `draft`, `source` `zola`, an activity row by `system`.
  - `proposals_source_check` widens through a NEW drop-and-re-add DO block after the add-if-missing one, with its `CONSTRAINT_CONTRACT` entry (parent spec 17 item 32), since a widened value in the old block never reaches dev or prod.
- **Post queue.** A `zola_posts` table shaped like `gv_posts` (the GV lane, `docs/superpowers/plans/2026-10-17-tt-proposal-link-via-gv.md`): one open row per proposal (partial unique index), terminal states never change, a resend after a terminal row makes a new row. States: `queued`, `leased`, `sent`, `clicked_unverified`, `failed_preclick` (reason), `skipped_already_posted`, `stale`, `unknown`, `cancelled`.
- **Enqueue.** At the same post-commit choke points the GV lane routes the proposal text through (`routeProposalText`: the admin initial send in `routes/proposals/lifecycle.js` and `crud.js`, the SendModal dispatch in `comms/actions/proposalResend.js`), a Zola-linked client gets a `zola_posts` row in addition to the normal email and text. The Zola lanes are planned after the GV lanes that build that router merge, and extend it rather than adding a second hook.
- **Sweep (60 s),** `RUN_ZOLA_SWEEP_SCHEDULER`, honored only with `RUN_SCHEDULERS`: due-but-unleased jobs past a stale window become `stale`; leased rows past the lease window become `unknown`. Liveness trips (no successful lease while work is due for 30 minutes, three `failed_preclick` in a row other than `cap`, three `unknown` or three `clicked_unverified` in a row) send one admin email per outage episode, shared with the agent's session/challenge email.
- **Agent endpoints** in their own route file and rate limiter, under their own prefix (not `/api/admin/thumbtack`, whose limiter the Thumbtack agent already spends): scan requests, report discovered inquiries, lease and report first replies, report details, lease, pre-check and report posts, and report status (`session_expired`, `challenge`). Reports take whitelisted states and reasons only; a late or duplicate report for a row not leased is ignored and logged.

**Box.**
- A new systemd user service with its own persistent profile (`~/.zola-profile`), separate from `thumbtack-agent` and `gv-agent`, so a Zola hang never blocks Thumbtack replies, the harvest or GV posts. Headful under Xvfb with `OZONE_PLATFORM=x11` (memory `reference-tt-agent-chrome-env`).
- It reads Zola data only from the responses Zola's own pages load (the spike's method), never by calling Zola's API on its own.
- Per first reply: open the lead, verify the UUID (law 3), read the conversation (law 2), journal, insert the body in one go (never key by key, in case Enter sends), click Send, verify a vendor message with the body now shows in the conversation response, report. Then read the inquiry, conversation and match responses and report the details.
- Per post: the same with the token check (law 8) and the server pre-check right before the click.
- Any Zola sign-in page or interstitial idles the agent without attempting a login; it reports `session_expired` or `challenge` once and resumes when a later poll finds it signed in. Re-login: Dallas opens the profile on the desktop (the 2026-10-17 command, written into `README.md`), signs in and closes it.
- A diag capture (screenshot plus a dump of the page's controls and response shapes, never values) on every definitive failure, the pattern that made each Thumbtack UI break a ten-minute diagnosis.

**Inbox** (`server/utils/inbox/**`, sensitive).
- The first reply becomes an outbound Zola event read from `zola_leads` (Zola never echoes our replies anywhere we can read), flagged as an auto first reply, so `classify.isHolding` treats it as a holding reply and the thread line reads "Auto first reply: follow-up promised" (Thumbtack's wording).
- A sent proposal post is part of its proposal send: absorbed by proposal id, so one send never reads as two replies.
- A failed or stale reply shows on the item as "The auto-reply didn't go out: answer on Zola."
- The feeds line gains the Zola agent: on, catching up, or signed out (the Gmail and Zola columns' rules).
- When the details step links the lead to a client, the person moves to the client's key at read time (lane email-feed's `zola_leads.client_id` resolution).

**Proposal page.** A "Zola chat" status row on `ProposalDetail` as its own component (ProposalDetail is near its line cap): queued, posted, skipped because the link was already there, "clicked Send but couldn't confirm: check the chat before pasting", and "didn't post: paste the link by hand" with the reason.

**Settings page.** The Zola first reply text, editable, with a note that it must never promise a call.

## 8. Failure modes

- Signed out or challenged: replies and posts wait; one email per episode; the feeds line says signed out; inquiries still show as unread Inbox items from their notices.
- Zola changed its page or JSON (a control or field missing): `failed_preclick` with a reason, a diag capture, Sentry, one email per episode. The item shows the auto-reply didn't go. LOUD, per Dallas.
- The Gmail feed is down or off: the 30-minute sweep still finds inquiries by day.
- The agent is down: due jobs go `stale` and show on their items; liveness emails once.
- A lead Zola has expired: `failed_preclick` (`expired`), shown on the item.
- The details step fails after a good reply: the reply stands, the item stays holding, and the lead shows "details not captured" for a human; a retry runs on the agent's next pass (idempotent on the lead row).

## 9. Left to the builder

- The exact column names and states on `zola_leads`, the endpoint paths, the lease and stale windows.
- How the scan reads the leads list (which list response marks an inquiry as not yet connected), confirmed in step 0.
- Whether the first-reply body needs its line breaks kept or flattened for Zola's textarea (step 0 says whether Enter sends).
- The diag capture format and pruning numbers (Thumbtack's 30 days and 40 captures are the precedent).
- Splitting `thumbtackAgent.js`-style code into shared helpers is welcome; changing the Thumbtack agent's behavior is not.

## 10. Rollout

- **Step 0, before the plan is final: a capture-only spike on the next real new inquiry.** Dallas holds off answering one new inquiry for a few minutes and says so. Claude runs a read-only capture: the leads list, then that lead's ready page, clicking and typing nothing, and reports field names only. It answers: what the ready page shows before the connect, whether the reply box and Send are there, whether Enter sends, where a chosen venue lives, which list field marks an unconnected inquiry, and what the inquiry notice email carries for the 15-minute match. Then Dallas answers the lead by hand as usual. The capture is deleted after.
- Lanes (the plan decides the cut): server (schema, endpoints, scheduling, details, the source CHECK, the sweep), box agent, Inbox, proposal post (after the GV router lanes merge), and the proposal source consumers (list filter, counts, badge, funnel: the parent plan's Task 20).
- Ships dark: both switches unset. The Gmail key goes into Render once the server and Inbox lanes are in prod (this replaces the parent plan's "until lane zola-leads is in prod"), then the probe and the switch-on check the parent plan already lists.
- Switch-on: `ZOLA_LEADS_ENABLED=true` at a quiet moment; the first real inquiry is the live test (reply on Zola within about a minute by day, client and draft appear, the item holds). Then `ZOLA_PROPOSAL_POST_ENABLED=true`; the next proposal send to a Zola couple is its test.
- `docs/walkthroughs-owed.md` gains the Zola walk: a day inquiry, a night inquiry, a hand-answered inquiry (skipped, details still captured), a proposal send and resend, a signed-out profile.

## 11. Docs and lists

- `.claude/CLAUDE.md`, `README.md`, `.env.example`: `ZOLA_LEADS_ENABLED`, `ZOLA_PROPOSAL_POST_ENABLED`, `ZOLA_AGENT_SECRET` (with blast radius and leak response), `RUN_ZOLA_SWEEP_SCHEDULER`, the two caps; the box service and its re-login steps.
- `ARCHITECTURE.md`: the new tables and columns, the route file, the box service, the Inbox's Zola outbound events.
- `scripts/sensitive-paths.txt`: the new route file, the draft and details writer, the box agent's send code.
- Privacy page: the builder checks whether receiving a couple's contacts from Zola needs a line (the page already names Zola mail through the Google mailbox line).

## 12. Relationship to the parent plan (`2026-10-14-inbox-email-zola.md`)

- Lanes gmail-client, email-feed and email-ai are in prod dark (pushed 2026-10-17). Nothing here changes them except the Inbox additions in section 7.
- Lane zola-leads (Tasks 14 to 16) and lane zola-draft (Tasks 19 and 20) are replaced by this spec's lanes. What survives: the source CHECK block and the source consumers (Tasks 19 step 1 and 20), and the no-contact Send guard (Task 16), now for a lead whose details step failed. The notice body parser (Task 14) shrinks to what the trigger and the merge need, since the agent reads the real fields from Zola.
- The parent plan's push gate line is amended to point here.
