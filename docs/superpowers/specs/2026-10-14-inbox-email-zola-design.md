# Inbox piece 3: email and Zola flow into Inbox

**Date:** 2026-10-14
**Author:** Claude, from a brainstorm with Dallas
**Status:** approved in conversation (five questions settled 2026-10-14); design-stage fleet run the same day and folded in (section 17); plan next
**Parent spec:** `docs/superpowers/specs/2026-10-06-inbox-design.md` (piece 2: the list, the rules, the AI read). This spec is piece 3 of that spec's table at line 24. Its channel values `email` and `zola` (parent 5.1), its "Open in Gmail" and "Open in Zola" actions (parent 4.3) and its open question about email-lead replies (parent, out of scope, line 46) are all answered here.
**Not this spec:** Google Voice and the 312 threads (piece 4, parent decision 16), the two 224 text lines (parent decision 19), sending email or Zola replies from Inbox (parent, out of scope), AI-drafted replies.

Privacy rule for this document, its fixtures and its tests: the repo is public. No real person's name, email address, phone number or message text appears anywhere. Fixtures use invented couples, addresses at example.com and 555-01xx numbers. Zola's templates are described by shape and rebuilt in test code from invented data, never quoted.

## 1. Goal and scope

Inbox is the one list of people waiting on Dallas or Zul. Today it reads Thumbtack and the 888 text line. This piece adds the business mailbox: a client, a lead, a staffer or a stranger who emails us, and a couple who writes through Zola. Each lands on the same person's item as their texts and Thumbtack messages, a reply from Gmail closes or holds the item the way a text does, and the AI read judges email the way it judges texts.

**In scope**
- A server-side feed of the contact@ mailbox through the Gmail API: inbound human mail, our Sent replies, and Zola's notices.
- Email identity: a sender address resolves to a client, a staffer, or an unknown-address person, with alias folding when they later become a client.
- Zola lead capture: a lead row per couple, a client record created from a new inquiry, a draft proposal from what the inquiry carries, and "Open in Zola".
- The AI read on email: longer lines, the subject, attachments, machine auto-replies, and a "solicitation" flag that keeps a pitch waiting with a visible tag.
- The feed line, the reply area, the thread rows and the Recently handled reasons for the two new channels.

**Out of scope**
- Sending anything. Inbox opens Gmail or Zola; it never sends mail or posts to Zola.
- Attachments: never downloaded, never stored, never shown; counted only.
- The marketing lead-conversation routes (`server/routes/emailMarketing/conversations.js`). They stay as they are. An email-lead reply reaches Inbox like any other mail (section 5.2), and the marketing leads table serves only as a name source.
- Labeling, archiving or marking mail read in Gmail. The scope is read-only.
- Google Voice, the 224 lines, piece 5.

## 2. Verified context (2026-10-14)

Everything below was checked against the live mailbox through the Gmail connector, the prod database read-only, and the code on main at `40ff2864`; the design-stage fleet re-verified every code citation the same day.

**The mailbox.**
- The business runs on Google Workspace (the domain's MX records are Google's). contact@ is the business mailbox. The no-reply and dallas@ addresses deliver into the same mailbox: a client's reply to a Resend mail (sent from the no-reply address with the admin address as Reply-To) lands in contact@, and mail addressed only to dallas@ lands there too.
- Replies from Gmail go out from contact@ by both Dallas and Zul. Zul's sends carry no delegation header, so Gmail cannot say who typed a reply. Dallas, 2026-10-14: "we don't really care who replied".
- The OS's own Resend sends never appear in Gmail's Sent folder (Resend delivers them through its own pipeline), so an OS send and a Gmail reply can never describe the same event.
- The Cowork morning report is sent from contact@ to contact@ and shows in both Sent and Inbox.
- Two weeks of inbound mail: a handful of human client threads (change requests, a certificate of insurance, a refund complaint, a corporate inquiry Zul answered, a client's planner writing from her own address), one vendor pitch, and a steady flow of receipts, newsletters and service notices (Twilio, Cloudflare, OpenAI, U-Haul, Claude). Human client mail sat in Gmail's Primary category; Zola's notices sit in Updates.
- An older Gmail address of the business still receives Zola's "booked" notices, with contact@ in copy. It needs no feed of its own; it is one of our own addresses (section 5.2).
- A Zola notice carries Google's `Authentication-Results` header with a DKIM pass for Zola's domain and a DMARC pass under Zola's reject policy; the Zola parser gates on it (section 5.6).

**Zola.** Zola sends email only, from one vendor address (`weddingvendors@zola.com`, a system sender, not a person), through Mandrill, in these templates:
1. **Inquiry** (subject "New Zola inquiry for <vendor>"): the couple's label (two first names with last initials, for example "Alex B & Sam C"), "Their note to you" with the note in quotes. Its Reply-To is Zola's vendor address, not a relay: a Gmail reply to the inquiry mail does not reach the couple. The plain-text part carries no lead id; every link is a tracked redirect.
2. **Message** (subject "New message from <couple label> for <vendor>"): the couple's label, "Getting married on <date>", sometimes a budget line, "<first name>'s message" and the message in quotes, then "Respond on Zola" linking `https://www.zola.com/inspire/vendors/leads/ready/<lead UUID>`, then "Or reply to this email directly". In the plain-text part that link is direct (checked on one notice, 2026-10-14); the HTML part wraps it in a Mandrill redirect. Its Reply-To is a per-message relay address at a Zola subdomain (`vmkt-message.zola.com`): a Gmail reply to this mail reaches the couple through Zola.
3. **Closed** (subject "<couple label> closed their inquiry"): the couple ended the inquiry, sometimes with a reason.
4. **Booked** (subject "Booked! ..."): the couple booked. Carries full names, no contact details, and no couple label, so nothing in it ties it to a lead row.
Plus marketing from the same address (featured spots, momentum, reviews). Zola never gives the couple's email or phone. Zola never emails about a reply we made inside Zola.
- Dallas, 2026-10-14: The Knot has announced acquiring Zola; Zola has said nothing. Dallas's call: build it and make a template change loud, not silent (section 12).

**Prod, read-only.** 707 clients, 614 with an email, none sharing one (`idx_clients_email_unique` is a plain case-sensitive unique index at `schema.sql:1493`; `idx_clients_email_lower` serves the lowercase lookup). 14 clients carry source `zola`, all made by hand. 27 marketing leads, none linked to a client, and the lead-conversations table has never held an inbound row. Three admin users, all on the domain; one staffer on the domain. 583 email rows in the message log over 30 days.

**Code.**
- Readers return events in one shape (parent 5.1) and the engine runs them in two passes: light headers since the history floor, then full rows for the people the rules keep (`server/utils/inbox/engine.js:109-150`, `details.js`). Pieces 3 and 4 "add readers and nothing else" (parent 5.1); this spec adds readers, tables, a sync job, and the small extensions each listed in section 9.
- `classify.countsAsReply` has a default branch for a later source: an outbound row answers when a human sent it (`classify.js:62-65`). A Gmail reply has no known author, so it gets its own case (section 5.4). `isTextBearingReply` already reads `meta.textBearing` for an unlisted source (`classify.js:71-76`).
- The people index resolves phones at read time (`people.js`); `personKey.js` accepts `c-`, `s-`, `p-`, `t-`; the page has its own copy of that check (`client/src/components/inbox/inboxFormat.js:28`, used by `Inbox.js:73` and `useInboxItem.js:27`, which render "gone" for any other key); alias folding (`aliases.js`, parent amendment 22) moves taps when a key moves.
- The reply mode comes from `latestConversationChannel` (`replyRules.js:65-69`), which knows `thumbtack`, `text` and `staff_text`.
- The AI read's prompt already labels channels `email` and `Zola` (`aiRead.js:132-137`); its slice list is fixed (`subjects.js:36`); the client already labels and icons them (`inboxFormat.js:43-49`); the reply bar already renders `mode: 'open'` with an app link (`ReplyBar.js:55-76`), composing the caption itself from the app name, and shows the app link beside the opt-out and bad-number notices (`ReplyBar.js:120-122`). The AI status vocabulary is `on | off | paused | failing` (`aiStatus.js:42-50`). The unknown card's number field is `phone_display` (`contextFormat.js:121-122`).
- The feed line lists Thumbtack and the three text lines (`feeds.js`); the design draws Gmail and Zola rows too (`docs/design-artifacts/2026-10-06-inbox/inbox-data.js:207-215`). The only `alt` in the design data sits on an opted-out reply (`inbox-data.js:114`); no text-mode reply carries a secondary link.
- The Thumbtack webhook creates the client through `findOrCreateClient` (`server/utils/clientDedup.js:43-130`) and the draft proposal through `createDraftProposalFromLead` (`server/utils/thumbtackProposalDraft.js:166-245`): `calculateProposal` first (`:192-195`), then the shared `insertProposalRecord` (`server/utils/proposalInsert.js`, which stores `pricingSnapshot`, `totalPrice` and `numBartenders` verbatim at `:34-36`), under `FOR UPDATE` on the lead row, with a Sentry capture on failure in the caller (`server/routes/thumbtack.js:313-315`). The webhook verifies a shared secret before any of it.
- `proposals.source` is added by `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and its CHECK by an add-if-missing DO block (`schema.sql:958-966`); the file's precedent for widening a live CHECK is drop-and-re-add (`inbox_reads_kind_check` at `:5376-5377`, `email_leads_lead_source_check` at `:2720-2722`). `clients.source` already allows `zola`. The source's consumers: `server/routes/proposals/list.js:103-106` (filter), `server/routes/proposals/metadata.js:313-316` (dashboard-stats tab counts), `client/src/pages/admin/ProposalsDashboard.js:20` and `:348-350` (ids and options), `client/src/components/admin/SourceBadge.js:7` (renders only `thumbtack`), `client/src/pages/admin/overview/FunnelCard.js:39-56` (segment label and drill link).
- The proposal Send path has no server-side check that the client can be reached: `ProposalDetail.js:281-284` is a `window.confirm` that proceeds on OK, and the `sent` branch of `server/routes/proposals/lifecycle.js` (about 165-185) flips the status whether or not an email or phone exists.
- Schedulers register through `wrapScheduler(name, seconds, tick)` behind `enabled('RUN_…')` (`server/index.js:498-512`, `841-847` for the AI read).
- `server/utils/anthropicClient.js` is the precedent for a credentialed client: hosts pinned, refuses to build under `NODE_ENV=test` without a stub, logs at warn, null when unconfigured. `server/utils/telegram.js` is the precedent for a raw `fetch` client with a pinned host.
- Nothing here sends, so Resend is not on this spec's path. The Gmail client follows the result-or-typed-error rule the Resend memory teaches: every call returns a result or a typed error, never a thrown string.
- `server/utils/inbox/**` and `schema.sql` are sensitive paths; this spec adds its credentialed client, its Zola writer and its draft writer to the list (section 13).
- The privacy page names Google "for venue address lookup" (`client/src/pages/website/legal/PrivacyPage.js:122`) and already says messages go to Anthropic without phone numbers, email addresses, or card and account numbers.

## 3. Decisions

Each one was settled with Dallas on 2026-10-14 unless marked as a design call.

1. **One mailbox, read by the prod server.** The server reads contact@ through the Gmail API on a 60-second tick. No push (a Pub/Sub topic, a public webhook and a weekly watch renewal buy nothing at this volume), no box agent (Gmail has an API; the box is for Google Voice), no IMAP.
2. **Service account with domain-wide delegation.** Dallas created the service account and its JSON key, lifted the org policy that blocked key creation on that one project, and granted the account's client id the single Gmail read-only scope in the Workspace admin console (all 2026-10-14). The key lives only in Render. The dev box has none; the suites stub the client. **Blast radius:** a key under domain-wide delegation can read every mailbox in the Workspace, not only the business one; the mailbox it reads is therefore a code constant, never an env var, and the leak response is to delete the key in Google Cloud and remove the delegation row in the admin console.
3. **Read-only.** The one scope is `https://www.googleapis.com/auth/gmail.readonly`. Inbox never sends, labels or deletes mail.
4. **No Google SDK.** The client signs the service-account JWT with Node's own crypto, exchanges it at Google's token endpoint "as contact@", and calls the Gmail REST API with `fetch`, the Telegram precedent. Hosts are pinned; the key is never logged.
5. **Unknown senders count.** A human writing from an address nobody knows forms an item, behind the bulk filter of section 5.2. Known clients and staff are exempt from the filter. The alternative, a closed list, would hide a brand-new lead who emails directly.
6. **The dallas@ alias stays in, with a personal check.** Mail addressed only to dallas@ counts like mail to contact@. After the fleet named that such mail would be readable by every admin and manager, Dallas asked for "a flag or check" (2026-10-14). A mail is **personal** when it was addressed only to dallas@ (contact@ and the other aliases absent from To and Cc) and its sender resolves to nobody we know (not a client, not staff, not a marketing lead). Personal mail is stored like any other, but it carries a "dallas@" tag on the row, the AI never reads it (its text never leaves the OS), and it is shown only to Dallas's own account in the list, the badge and the opened item; every other admin or manager never sees it. The check is a read-time predicate over the stored sender and recipients, so a sender who later becomes a client stops being personal and their earlier mail joins the client's item like any alias move. Mail to dallas@ from a known client, staffer or lead is business and shows to everyone.
7. **Notification mail is never an item.** Thumbtack's notices (the webhook already delivers those messages), the OS's own alerts, Cal.com, Stripe, Twilio and every other machine sender are dropped before storage, so no message ever shows twice.
8. **Email identity resolves at read time, like phones.** Zola's vendor address is parsed by template before anything else; then our own addresses (never an item); then clients; then the send-eligible staff set; else an unknown-address person keyed by a hash of the address.
9. **A Gmail reply carries no author.** It ends a claim and closes or holds the item; the handled line reads "Replied by email". No clock-offset or signature inference. "If we do [care] we can look at the signature."
10. **Zola closes only by email.** A Gmail reply to a Zola message notice reaches the couple through Zola's relay and counts as a reply. A reply typed inside Zola is invisible to the OS and needs Done. The caption says so.
11. **A Zola inquiry creates the client and a draft proposal,** the way the Thumbtack webhook does: the couple's label as the name, source `zola`, no email or phone; a draft at the default package with the wedding date set, the note in the admin notes and the proposal's source marked `zola`. Dallas: "lets just do it." The draft is the last lane. The path is gated on Gmail's authentication header for Zola's domain (fleet, section 5.6) and capped per day.
12. **A pitch never closes on its own.** The inbound read gains a `solicitation` flag. When it is true the item stays waiting whatever else the model says, with a "Pitch" tag on the row and the AI's one line on what they are selling. Dallas: "I want to make that call."
13. **The AI reads email with email-sized lines.** An email line may run 4,000 characters after redaction (texts stay at 1,500), the subject rides ahead of the body, attachments appear as "[attachment]", and machine auto-replies never reach the model.
14. **Make a Zola template change loud.** A mail from Zola's vendor address that matches no template becomes a waiting item that reads "Zola sent something the OS couldn't read. Open Zola.", the feed line shows Zola going quiet, and Sentry gets one warning an hour. A lead is never lost to a template change; a week of convenience is.
15. **Backfill from the history floor.** The first sync reads mail since `INBOX_HISTORY_START` (parent decision 18), so the list is complete on day one. Backfilled Zola threads become items but create no client and no draft; client creation applies to inquiries that arrive after the feed is on (design call: a burst of auto-created duplicates of the 14 hand-made Zola clients is worse than a few unlinked items).
16. **Nothing is stored that Gmail keeps better.** The row holds the sender's address and display name, the recipients, the subject, the person's own words with quoted history and signature stripped, an attachment count and the Gmail ids. Never the raw mail, never an attachment, never the quoted history.
17. **Latest channel wins in the reply area,** as it does for Thumbtack today (parent 4.3): a person whose newest message is an email gets "Open in Gmail", a Zola couple gets "Open in Zola", and a person whose newest message is a text keeps the text composer. No secondary link under the composer: the design does not draw one (fleet).
18. **Ships dark.** With no key in Render the feed is off and the feed line says so. Before the key goes in, a tracked probe proves which address the key reads as.
19. **A Zola "closed" notice is a close by rule** (fleet, design call): the OS knows what it is, so it anchors the stretch like a Done by the couple and needs no model.
20. **One poison message never stops the feed** (fleet): each message is processed in its own transaction, a message that fails three times is skipped for good with a Sentry warning, and the history id advances past it.

## 4. What Dallas and Zul see and do

### 4.1 The list

An email or Zola item is a row like any other: the person's name, the need line, the wait, the channel icons (`mail` for email, `book` for Zola, from `inboxFormat.js`). The need line is the AI's summary once it lands, before that the first 200 characters of the person's own words (`classify.eventNeedText`), and for an attachment-only mail "Sent an attachment".

**The Pitch tag.** A waiting row whose newest inbound read says `solicitation` carries a small "Pitch" chip after the channel icons, in the muted chip style of the shipped `StatusChip` (`client/src/components/adminos/StatusChip.js`). The need line is then the AI's line on what they are selling ("Selling bar stools for events"). Done closes it like any item.

**The dallas@ tag.** A waiting row whose person is personal (decision 6) carries a small "dallas@" chip after the channel icons, in the Pitch chip's style, and appears only when the viewer is Dallas's admin account (`PERSONAL_MAILBOX_OWNER_USER_ID`, user 1, the id `CALL_ANSWERED_BY_USER.admin` already names). The need line is the first 200 characters of their words, since the AI never reads them.

**Names.** A client's item shows the client's name. A staffer's shows theirs. A Zola couple's item shows the couple's label exactly as Zola wrote it. An unknown-address person shows the display name from their From header, else the marketing lead's name when the address is in `email_leads`, else the address itself (the unknown-number precedent, which shows the number).

### 4.2 The thread

- An inbound email row shows the subject in the muted line above the bubble (the design's `subject` field on email rows), then the person's own words. Quoted history is not shown; "Open in Gmail" has the whole mail.
- A row with attachments adds a muted line "1 attachment" or "3 attachments". Never a filename, never a link.
- An outbound Gmail reply row shows our words with `author_name` null, as a Thumbtack Business row does today, never "Auto", and the caption "by email" where a text row says the line. A reply Gmail could not deliver (section 5.4) shows "Not delivered" with the reason "Email bounced", the ledger-row precedent.
- A Zola inbound row shows only the couple's words. The inquiry row's subject line reads "Zola inquiry"; a later message's reads nothing.
- A machine auto-reply ("out of office") is a system line: "Auto-reply received". A bounce notice is a system line: "Email bounced".
- An unreadable Zola notice is an inbound row that reads "Zola sent something the OS couldn't read. Open Zola." (constant `ZOLA_UNREAD_TEXT`), the Thumbtack "never received" pattern.
- A Zola "closed" notice is a system line: "Closed their inquiry on Zola." followed by the couple's reason when the notice carries one.
- A Zola "booked" notice is never stored (section 5.6): nothing in it names the lead, and the couple's own thread carries the news.

### 4.3 The context card

- A client keeps the client card. A Zola couple whose inquiry created a client is a client.
- A backfilled Zola couple with no client gets a lead card: "Zola lead", the couple's label, the wedding date when known, and "No client record yet".
- An unknown-address person gets the unknown card with `address` where the unknown-number card shows `phone_display`.

### 4.4 Replying

The reply block (`reply.js:buildReplyBlock`) gains the two app links beside Thumbtack's, and `latestConversationChannel` (`replyRules.js`) learns `email` and `zola`.

- **Email:** `mode: 'open'`, app `{ name: 'Gmail', url, caption }`. The URL opens the Gmail thread in the business account: `https://mail.google.com/mail/?authuser=<mailbox>#all/<gmail thread id>`. Caption: "Closes here on its own once you reply from Gmail."
- **Zola:** `mode: 'open'`, app `{ name: 'Zola', url, caption }`. The URL is the lead page (`https://www.zola.com/inspire/vendors/leads/ready/<lead UUID>`) when the UUID is known, else the vendor dashboard (`https://www.zola.com/inspire/vendors/dashboard`). Caption: "Reply to Zola's email from Gmail and it closes here on its own. A reply typed inside Zola needs Done."
- The caption travels in the payload (`app.caption`) instead of being composed by the page, so Thumbtack's caption moves into the server too and reads as it does today.
- **One app slot.** `app` is the app of the person's latest conversation channel: Thumbtack, Gmail or Zola. A person whose newest message is a text keeps the composer and gets no app link under it (decision 17); the opt-out and bad-number notices keep showing the app link beside them as they do today, now for all three apps.
- A person whose newest message is an email but who also has a phone gets the Open button, not the composer (decision 17).

### 4.5 Recently handled

- A Gmail reply closes with "Replied by email", `reason_code: 'email'`, `by: null`.
- A Zola reply by email closes with "Replied to Zola by email", `reason_code: 'zola'`, `by: null`.
- A couple who closed their inquiry closes with "Closed their inquiry on Zola", `reason_code: 'zola_closed'`, `by: null` (decision 19).
- Done, Snooze, Reopen and the AI's "no reply needed" read as today.

### 4.6 Feed health

Two rows join the line: "Gmail 1 min ago" and "Zola 3 days ago".
- **Gmail** is the time of the last successful sync, not the last human mail: a quiet mailbox is healthy, a stuck sync is not. Its status is `on | off | failing | catching_up`, the AI status vocabulary plus one: `off` when the key is unset, `failing` after 3 consecutive failed ticks, `catching_up` while the backfill is still paging ("Gmail catching up").
- **Zola** is the time of the last stored Zola notice of any template, quiet by nature like the 224 lines; the dot follows the 48-hour rule.

## 5. The rules

### 5.1 Events

Two readers are added. Both read the `gmail_messages` table (section 7); the sync job of section 5.5 is what fills it. Pass 1 reads headers (no subject, no text); pass 2 loads subject and text for the people the rules keep, through `details.js`, keyed by `meta.id` (a suffixed ref, below, is not a row id).

**Email reader** (`readGmail.js`): every row with `kind` in `message`, `auto_reply`, `bounce` and no `zola_lead_id`.
- `ref`: `gm:<gmail message id>`; a Sent mail that answers several people gets one event per answered person, `gm:<id>:<n>`, all sharing `meta.readRef = 'gm:<id>'` so the AI reads the mail once (section 6).
- `channel`: `email`.
- `direction`: `in` for a row without the SENT label, `out` for a Sent row, `system` for `auto_reply` and `bounce`.
- `at`: the message's internal date.
- `author`: `null` on every outbound row (decision 9).
- `kind`: `message`; `media` when the row has attachments and no words (section 6: never read, stays waiting); `auto_reply` and `bounce` keep their kind, which the thread renders as system lines and the rules never count.
- `personKey`: inbound rows resolve the From address (5.2). Outbound rows resolve, in order: the person of the stored inbound the mail answers (its `in_reply_to` names a stored inbound's `message_id_header`, or its `thread_id` holds a stored inbound), then each recipient address in To, Cc and Bcc that resolves to a key that is not ours. A reply sent to a Reply-To address that differs from the person's From address therefore still answers them (fleet).
- `meta`: `source: 'gm'`, `id`, `threadId`, `address` and `fromName` (the other party's address and display name, read in pass 1 so the list can name an `e-` person without loading text), `attachments`, `textBearing: true` on outbound rows that have words, `empty` when inbound has no words and no attachment, `failed: true` on a Sent row a bounce named (5.4), `legalHold: true` on every sibling of a Sent mail that reached a held key (section 6).

**Zola reader** (`readZola.js`): every row whose `kind` starts with `zola_`, plus every Sent row the join below ties to one. Every `zola_` row has a `zola_lead_id` (section 5.6 gives even an unparsed notice a lead row).
- `ref`: `gm:<gmail message id>` (the notice is a Gmail message).
- `channel`: `zola`.
- `direction`: `in` for the inquiry, message and unparsed templates; `system` for a closed notice; `out` for a Sent row that answers a stored message notice.
- **The Sent-to-Zola join resolves at read time, never at sync time** (fleet): a Sent row answers a Zola lead when its `in_reply_to` equals a stored `zola_message` row's `message_id_header`, or when any of its `to_addresses` is at Zola's relay subdomain and its `thread_id` holds a stored `zola_message` row. The backfill lists newest first, so the reply is often stored before the notice it answers; a join at read time does not care.
- `kind`: `message` for inquiry and message rows; `zola_closed` for a closed notice (a close by rule, decision 19); `zola_unread` for an unparsed notice (counted inbound, never AI-closable, the `tt_missed` pattern); `message` with `textBearing` for the outbound reply.
- `author`: `null` on outbound.
- `meta`: `source: 'gm'`, `zolaLeadId`, `template` (`inquiry` | `message` | `closed` | `unparsed`), `leadUuid` when known, `textBearing`.
- A `zola_` row whose lead was deleted cannot exist: the foreign key is `ON DELETE RESTRICT` (section 7).

The parent's normalizer runs unchanged: no gm row ever pairs with an sms, ml or pal row (decision 7 and section 2: the OS's sends never reach Gmail's Sent folder), and ordering stays total by time, source row id, ref.

### 5.2 Who is who

**Email address resolution** (`people.js`, extended): addresses are compared trimmed and lowercased.
1. **Our own addresses never form an item:** the mailbox and its aliases (contact@, dallas@, the no-reply address `FROM_EMAIL` uses, the admin address `ADMIN_EMAIL` names, and the comma list in `INBOX_OWN_EMAILS`, which carries the older Gmail address of the business and lives in Render, never in the repo), every admin's and manager's `users.email`, and Zola's vendor address. Not the whole domain: a staffer with a mailbox on the business domain is staff (rule 3), so their mail forms an item (fleet).
2. **Clients** by `clients.email`, newest client first. The unique index is case-sensitive, so two case spellings of one address can coexist; the newest-first rule decides.
3. **Staff**: the same send-eligible set the text route reaches (role staff or manager, onboarding submitted, reviewed or approved, agreement on file), by `users.email`, newest profile first.
4. **Anyone else** is `e-<16 hex>`: the first 16 hex characters of the SHA-256 of the lowercased address. The key carries no address, so page URLs and Sentry events never do (the parent's amendment 42 needs no extension); the address lives in the event's `meta.address` and is shown only on the opened item's card. The hash is unsalted: with a candidate address in hand, anyone holding a Sentry event can confirm the match, the same exposure the row ids already in URLs carry, accepted.

**Personal mail** (decision 6): an inbound gm row is personal when its `to_addresses` hold the owner alias (code constant `PERSONAL_ALIAS`, the dallas@ address) and no other own address, and its From resolves to an `e-` key whose address is not in `email_leads`. A person is personal when every counted inbound of theirs is personal. The predicate is pure (`classify.isPersonal`), decided at read time, and never stored.

The index also keeps `keyByEmailHash`, the `e-` hash of every client and staff address mapped to that person's key, so alias folding and `resolveKey` can move an `e-` key that only ever knew its hash (fleet).

**Zola couples** (`people.js`, extended with `zolaLeadsById`): a `zola_leads` row resolves to `c-<client_id>` when linked, else `z-<zola_leads.id>`. The key uses our own serial because the inquiry template carries no Zola id; the lead UUID, when learned, is a column, not the key.

**Person keys** (`personKey.js` and its copy in `client/src/components/inbox/inboxFormat.js:isPersonKey`, which must accept the same keys or every email item opens as "gone"): two patterns join the four: `e-[0-9a-f]{16}` and `z-<canonical int4>`, with the same no-leading-zeros and int4 limits as `c-` and `s-`.

**Alias folding** (`aliases.js`, parent amendment 22, two more rules after rule 5):
6. an `e-` key asks `keyByEmailHash` at the tap's time and moves when the address now names a client or staffer (an unknown address became a client);
7. a `z-` key follows its lead to the client the lead now belongs to.

**Which mail counts, decided at sync time** (section 5.5) and recorded as the row's `kind` or as no row at all, in this order:
1. A message with the DRAFT, SPAM or TRASH label is never stored.
2. **Zola first:** a message from Zola's vendor address goes to the Zola branch (section 5.6) before any own-address rule, and only the Zola branch decides whether it is stored.
3. A Sent message whose every recipient is our own address is dropped (the report), and a Sent message to any address at a dropped domain is dropped (a Gmail reply to a Thumbtack notice is a Thumbtack Business message the webhook already records).
4. An inbound message from one of our own addresses is dropped (the OS's alerts, Cowork's report arriving in Inbox).
5. An inbound message from a dropped domain is dropped: `thumbtack.com`, and the code constant `DROPPED_SENDER_DOMAINS` the lane fills from the senders the OS already listens to (Thumbtack) or that only ever notify (Cal.com, Stripe, Twilio, Sentry, Render, Vercel, Google's own notices). The list is code, not env, so a change goes through review.
6. A **bounce** (sender local part `mailer-daemon` or `postmaster`, or `Auto-Submitted: auto-replied` with a `Content-Type: multipart/report`) whose In-Reply-To or References names a stored Sent row's `message_id_header` is stored as `kind: 'bounce'` and marks that Sent row `failed` (5.4). A bounce naming nothing we stored is dropped.
7. A message is a **machine auto-reply** when it carries `Auto-Submitted` other than `no`, `X-Autoreply`, `X-Auto-Response-Suppress`, or `Precedence: auto_reply`, or when its subject matches the auto-reply pattern (`automatic reply`, `auto-reply`, `autoreply`, `auto response`, `out of office`, `out of the office`, case-insensitive, at the start of the subject or after "Re:"). It is stored as `kind: 'auto_reply'` and never counts. The rule applies to Sent rows too (a vacation responder writes to Sent), and a Sent row whose only body part is `text/calendar` is an `auto_reply` as well (fleet: Gmail's own automation can write Sent rows, and none of them is a human reply).
8. An inbound message from an address that resolves to a client or staffer counts, whatever Gmail's category.
9. An inbound message that answers a stored Sent row (its In-Reply-To names one, or its `thread_id` holds one) counts, whatever Gmail's category (fleet: a lead on a business domain whose reply Gmail files under Updates).
10. An inbound message from anyone else counts only when it passes the **bulk filter**: Gmail placed it in Primary (label `CATEGORY_PERSONAL`), it carries no `List-Unsubscribe` and no `Precedence: bulk | list | junk`, and the sender's local part does not match the no-reply pattern (`no-reply`, `noreply`, `do-not-reply`, `donotreply`, `notifications`, `notification`, `mailer-daemon`, `postmaster`, `alerts`, `newsletter`, case-insensitive, with or without dashes and dots). A message that fails the filter is not stored, and the tick counts it (5.5).
11. Everything else inbound is stored as `kind: 'message'`.

A message dropped by rule 10 is re-evaluated when Gmail later adds the Primary label to it (the sync consumes `labelAdded` history for `CATEGORY_PERSONAL`, 5.5), so a human Gmail first filed elsewhere and Dallas dragged to Primary becomes an item.

The email-lead replies question (parent line 46) is answered by these rules: a marketing lead who replies is an unknown-address person, or a client when their address is on a client row. The marketing leads table is read for the name only, and `email_conversations` is neither read nor written.

### 5.3 What counts as them writing

- A stored inbound `message` row from a resolved person counts (parent 5.3's spirit: them writing on any channel).
- A Zola inquiry and message row counts; an unparsed notice counts as `zola_unread`; a closed notice counts as nothing and closes (decision 19).
- An attachment-only inbound mail counts as `media` and stays waiting until a human acts (parent 5.5 step 3).
- `auto_reply` and `bounce` rows never count.
- Our own addresses never count.

### 5.4 What counts as a reply

- **A Sent mail that answers the person** (5.1's outbound resolution) is a reply, like a Thumbtack Business message: a human sent it, because the OS never sends through Gmail, the report is dropped, and Gmail's own automated sends are filtered out as auto-replies (5.2 rule 7). `classify.countsAsReply` gets `case 'gm': return !e.meta.failed` next to `case 'tt'`; `isTextBearingReply` needs no change. The AI reads it for a promise (parent 6.1) and the thread shows it.
- **A bounced reply is not a reply** (parent decision 25): a Sent row a bounce named carries `failed: true`, `countsAsReply` refuses it, and the thread shows "Not delivered".
- **A Sent mail that answers a Zola message notice** (the read-time join of 5.1) is a Zola reply on that lead.
- **Several recipients:** a Sent mail answers each outside person it resolves to, one event per person (5.1), so a mail that answers a client and their planner closes both items. The parent's staff rule carries over (parent 5.4): when the mail resolves to two or more staffers it answers none of them, so a shift announcement never answers one staffer's question; outside recipients on the same mail are still answered.
- **A Zola closed notice** is a close by rule (decision 19): the rules treat a `zola_closed` row as a Done made by the couple at the notice's time (it joins the anchor set in `rules.js` step 1), and `describeCloser` names it "Closed their inquiry on Zola".
- A reply inside Zola's site is invisible and closes nothing (decision 10).
- The OS's sends keep counting through the message log exactly as today; no gm row ever twins with one.
- A Gmail reply ends a claim, closes the item or holds it when the AI reads it as a holding reply, and sets the anchor like any reply (parent 5.5).

### 5.5 The sync

A scheduler, `gmail_sync`, runs every 60 seconds with a 20-second startup delay, behind `enabled('RUN_GMAIL_SYNC_SCHEDULER')` and an in-flight boolean (the AI read's pattern), on the production instance only (`RUN_SCHEDULERS` rules). With no key it does nothing and the status reads off.

**The lease** (fleet: a Render deploy runs the old and the new process side by side): a tick first claims the single `gmail_sync_state` row with one statement, `UPDATE gmail_sync_state SET lease_owner = $1, lease_until = NOW() + INTERVAL '120 seconds' WHERE id = 1 AND (lease_until IS NULL OR lease_until < NOW()) RETURNING history_id, backfill_page, backfill_done`; no row back means another instance holds it and the tick ends. Advisory locks are a no-op on the Neon pooler (memory). The tick releases the lease when it ends; a crashed tick's lease expires on its own.

Each tick, inside the lease and bounded to 40 seconds of wall time and `GMAIL_SYNC_MAX_PER_TICK` (constant, 50) messages:
1. **First sync** (no history id yet): reads the mailbox's current history id from `users.getProfile` **before the first page** and stores it (fleet: mail arriving between pages is then inside the later history window), then lists message ids with `q=after:<INBOX_HISTORY_START as YYYY/MM/DD>` across every label (Sent included), pages through, and processes each page's ids oldest first; the page cursor lives in the state row and the status reads `catching_up` until `backfill_done`.
2. **Steady state:** `history.list` from the stored history id with `historyTypes=messageAdded,labelAdded`, processes each added id and each id that gained `CATEGORY_PERSONAL`, and stores the newest history id once every id in the window is stored, dropped or skipped (below).
3. **Lost history** (Google answers 404 because the id is older than it keeps, about a week): a resync like step 1 from `last_ok_at` minus one day; the unique Gmail id makes re-processing idempotent.
4. **Processing one message, in its own transaction:** fetches it with `format=full`, reads the headers it needs (From, To, Cc, Bcc, Subject, Date, Message-ID, In-Reply-To, References, Reply-To, List-Unsubscribe, Precedence, Auto-Submitted, X-Autoreply, X-Auto-Response-Suppress, Authentication-Results, Content-Type) and the label ids, applies section 5.2's rules, extracts the text (section 5.7), and inserts one row with `ON CONFLICT (gmail_id) DO NOTHING RETURNING id`. **Every side effect is gated on that insert returning a row** and runs in the same transaction: the bounce mark (5.2 rule 6), the Zola lead row and client (5.6). A re-processed id whose insert is a no-op does nothing else. The draft (5.6) runs after the commit, best effort.
5. **A message that fails** (any error after the fetch, including a deterministic one such as an overlong value or a constraint) is recorded in `gmail_sync_skips` (gmail id, attempts, error class) and the tick continues with the next id. On its third failure the id is skipped for good and Sentry gets one warning (the id and the error class, never content). The history id advances when every id in the window is stored, dropped, or skipped with its attempts recorded; a message with one or two failures holds the window for at most two more ticks.
6. Writes `last_ok_at`, clears `consecutive_errors`, logs one summary line per tick (stored, dropped, unparsed, skipped counts, the `[inbox_ai_read]` pattern), and clears the engine's snapshot cache once (`cache.invalidate()`), not per message.

On a tick-level failure (the token exchange, `history.list` itself) the tick stores the error class in `last_error`, bumps `consecutive_errors`, and returns; the next tick retries from the stored id. Three consecutive failures turn the feed line to "Gmail failing" and send one Sentry warning an hour (counts and the error class only).

### 5.6 Zola parsing and lead capture (`zolaMail.js`, pure; `zolaLeads.js`, writes)

**The gate.** A message from Zola's vendor address is parsed only when Google's `Authentication-Results` header (the one `mx.google.com` wrote) carries `dkim=pass` with `header.i=@zola.com` and `dmarc=pass`. A message from that address that fails the gate is dropped and counted; three in a day send one Sentry warning. Everything the parser yields is bounded before it is stored: the couple's label is cut to 120 characters (and `clients.name` takes it as is, under its 255), the lead UUID must match the strict lowercase UUID pattern or is ignored, the note and message text are cut at 20,000 characters, and the wedding date must parse as a calendar date or is null.

A gated message is matched on subject:
- `/^New Zola inquiry for /` is an inquiry;
- `/^New message from (.+) for /` is a message, the capture is the couple's label;
- `/^(.+) closed their inquiry$/` is a closed notice, the capture is the label;
- `/^Booked!/` is a booked notice: dropped. It carries no couple label and no lead id, so it cannot be tied to a lead, and the couple's own message thread already carries the booking;
- anything else is Zola marketing and is dropped.

The parser works on the plain-text part (every template carries one) and never on the HTML:
- **Inquiry:** the couple's label is the line before "sent you an inquiry!"; the note is the quoted text under "Their note to you". A wedding date, guest count, budget or location line, when the template carries one, is read by its label ("Getting married", "Guest count", "Wedding budget", "Location"); the lane checks the inquiry's HTML part for those fields once against a real notice and pins what it finds in the fixture builder, by shape.
- **Message:** the label after "Respond to"; the date after "Getting married on"; the message text between the first and last quote after "<name>'s message"; the lead UUID from the first `/inspire/vendors/leads/ready/<uuid>` link, read directly, or from the `url` field of the base64 JSON in a Mandrill redirect's `p` parameter if the plain part is ever wrapped the way the HTML part is. The fixture builder carries both forms.
- **Closed:** the reason after "reason for closing", when present.
A template whose subject matched but whose body yields no words (the inquiry's note, the message's text) is `unparsed`: stored with `kind: 'zola_unparsed'` and `text` null, counted as `zola_unread` (decision 14). An unparsed notice always gets a lead row: by label when the subject carries one (message and closed), else a fresh row labeled "Zola notice" with the mail's Chicago date, so the item exists and "Open in Zola" opens the dashboard. Such a row never creates a client or a draft.

**The lead row,** in the message's transaction (5.5 step 4). The writer finds the lead:
1. by lead UUID when the notice carries one and a row has it;
2. else by couple label, normalized (trimmed, inner whitespace collapsed, case-folded) into `couple_label_key`, among rows not closed;
3. else it creates one with the label, the wedding date when known, and the UUID when known.
A message notice that names a UUID fills it on a row found by label. A closed notice stamps `closed_at`. A label that later arrives with a different UUID (two couples with the same label) creates a second row rather than overwriting the UUID; the first row keeps its UUID. Two instances cannot both create a row for one inquiry: the lease serializes ticks and the insert gate serializes the message (5.5).

**Client creation** (decision 11; skipped during the backfill, decision 15): a new lead row created from an inquiry that arrived after the feed's switch-on creates a client through `findOrCreateClient` with the couple's label as the name, no email, no phone, `source: 'zola'`, and a note "Zola inquiry, no contact details yet", in the same transaction as the lead row, and stores `client_id` on the lead. `findOrCreateClient` with no email and no phone matches nothing and always creates; the lead row is the idempotency guard (a second inquiry notice for the same label finds the row and creates nothing). **Cap:** at most `ZOLA_CLIENT_DAILY_CAP` (constant, 20) lead-driven clients per rolling 24 hours, counted from `zola_leads.client_id` rows created in that window; past it the notice and the lead row are stored, the client and the draft are skipped, and Sentry gets one warning an hour (fleet: every scheduled writer with external input here carries a cap).

**The draft** (lane 5): when the lead has a client and a wedding date, and no `proposal_id`, `createDraftProposalFromZolaLead` runs `calculateProposal` for the default package (`the-core-reaction`, flat, seeded `service_only` at `schema.sql:634`, which is why `numBars: 0` is right: `decideNumBars` yields 0 for a service-only package and 1 would add the first-bar fee, memory `project-thumbtack-autodraft`), guest count 50, duration 4 hours, no add-ons, then `insertProposalRecord` with the snapshot, its total and its staffing count, event type `wedding-reception` (`server/utils/eventTypes.js:5`, category `wedding_related`), the wedding date at 5:00 PM Central, a default this spec sets (the Thumbtack mapper has none: it reads the time off the lead's timestamp, and a Zola notice carries a date with no time), venue empty, `source: 'zola'`, admin notes carrying the couple's note and the Zola lead link, status `draft`, activity log `created` by `system` with `{ source: 'zola', zola_lead_id }`. It runs after the lead transaction commits, best effort, under `SELECT … FOR UPDATE` on the lead row, with a Sentry capture on failure tagged `{ feed: 'zola', step: 'draft' }`, the Thumbtack caller's pattern. A lead whose date arrives only with a later message notice gets its draft then.

**Sending the draft.** A Zola-created client has neither email nor phone, and the Send path has no guard for that today (section 2: the confirm proceeds on OK and the `sent` branch flips the status with nothing delivered). Lane 5 adds the guard: the `sent` branch of `lifecycle.js` refuses with a `ValidationError` ("Add an email or phone for this client before sending.") when the client has neither, and the proposal page disables Send with the same copy. This closes a hole the Thumbtack path never had, because its leads carry a phone.

`proposals.source` widens to `('thumbtack','zola')` by a **new drop-and-re-add DO block** after the existing add-if-missing one (`schema.sql:958-966`), the `inbox_reads_kind_check` pattern: `DROP CONSTRAINT IF EXISTS proposals_source_check; ADD CONSTRAINT … CHECK (source IS NULL OR source IN ('thumbtack','zola'))`, atomic in one DO block. There is one site, not two; editing the add-if-missing block alone never changes prod. Every consumer of the source learns `zola`: `list.js` (filter), `metadata.js` (dashboard-stats tab counts), `ProposalsDashboard.js` (`SOURCE_IDS` and the options), `SourceBadge.js` (a Zola badge), `FunnelCard.js` (segment label and drill link).

### 5.7 Text extraction (`mailText.js`, pure)

- The text/plain part is preferred; with none, the text/html part is converted: block elements and `<br>` become line breaks, `<blockquote>` content is dropped, tags are stripped, entities decoded, whitespace collapsed to at most one blank line.
- **Quoted history** is cut: everything from the first line matching the reply header patterns (`On <date>, <someone> wrote:`, `From: … Sent: …` Outlook headers, `-----Original Message-----`, `> ` quoted lines at the tail), the parent spec's relay-notice precedent in spirit.
- **Signatures** are cut at `-- ` on its own line and at `Sent from my <device>`; a trailing block of up to 6 short lines that contains a phone number, an address at a domain, or a URL is treated as a signature and cut.
- The result is trimmed. When it comes out empty but the original had words, the untrimmed original (quoted history still cut, signature kept) is stored instead, so a one-line reply that lives inside a signature is not lost.
- Stored text is capped at 20,000 characters.
- Attachments: the count of MIME parts with a filename or `Content-Disposition: attachment`, inline images included; a `text/calendar` part is an attachment for the count and an auto-reply signal for a Sent row (5.2 rule 7).

## 6. The AI read

The parent's read (sections 6.1 to 6.6) runs on email with these differences.

- **Lines.** An email line (channel `email` or `zola`) is pre-clipped at 8,000 characters before redaction and 4,000 after; text lines keep 3,000 and 1,500 (parent amendment 26). The prompt cap stays at 12,000, oldest lines dropped first, so a long email thread shows its newest mails whole.
- **The subject** rides ahead of the body in the slice line, as `Subject: <subject>. <body>`, on inbound email rows and on outbound Gmail rows; Zola rows carry no subject.
- **Attachments** appear as `[attachment]` in the line, once per attachment, never a filename. An attachment-only mail is never read (`isReadableInbound` already refuses `media` rows without words).
- **The slice list** (`subjects.js:36`) gains `zola_unread` (the `tt_missed` analog, so the model sees that the OS could not read a notice); `auto_reply` and `bounce` rows stay out of every slice.
- **One read per mail.** A Sent mail that answers several people is one outbound subject, keyed by `meta.readRef` (`gm:<id>`), so the words go to Anthropic once and `inbox_reads` holds one row; every suffixed sibling reads that row (`readOf` uses `meta.readRef` when present).
- **Legal hold** (parent amendment 43): the read job's key lookup gains the held client's `e-` key for their email address and the `z-` key of any Zola lead linked to them; and a Sent mail that reached a held key marks every sibling event `legalHold`, so the words written to the held client are never read under a third party's key (fleet).
- **Auto-replies** never reach the model (they are system rows). The prompt's "automated messages and auto-replies" rule stays for the ones the headers and the subject pattern miss.
- **Channel labels** already read `email` and `Zola` (`aiRead.js:136-137`).
- **The solicitation flag** (decision 12). The inbound schema gains `solicitation: boolean`. The system prompt adds, before the "No reply is needed" list: "A solicitation is someone selling to us or asking us for something that is not a booking: a vendor pitch, a sponsorship or partnership ask, recruiting, a survey, a request to list or feature the business. For a solicitation set solicitation true and needs_reply true, and make what_they_need say what they are offering or asking for." The read job stores the flag in `inbox_reads.solicitation` and, when it is true, stores `needs_reply` as true whatever the model said, so the rules need no new branch: the item waits. The row carries `pitch: true` in the list payload when the newest counted inbound's read has the flag.
- **The Zola closed notice** is a close by rule (decision 19) and is never read.
- **Personal mail is never read** (decision 6): `buildSubjects` skips a personal person entirely, inbound and outbound, the legal-hold precedent; their text never leaves the OS.
- **Redaction** is unchanged: addresses become `[email]`, digit runs `[number]`, links `[link]`, the surname rule applies to the display name. The redactor already handles every rule email needs; the lane adds fixtures for a signature block and a quoted-address line.
- **Cost.** The mailbox adds a few subjects a day. The daily cap and the pricing note stand.

## 7. Data model

New tables, idempotent in `schema.sql`, with the file's DO-block pattern for every enumerated CHECK (the inline CHECK for a fresh database and a drop-and-re-add DO block for dev and prod, the `inbox_reads` precedent at `:5366-5384`):

```sql
CREATE TABLE IF NOT EXISTS zola_leads (
  id SERIAL PRIMARY KEY,
  lead_uuid TEXT UNIQUE,
  couple_label TEXT NOT NULL,
  couple_label_key TEXT NOT NULL,
  wedding_date DATE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zola_leads_label ON zola_leads(couple_label_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_zola_leads_client ON zola_leads(client_id);

CREATE TABLE IF NOT EXISTS gmail_messages (
  id SERIAL PRIMARY KEY,
  gmail_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL CHECK (kind IN ('message','auto_reply','bounce','zola_inquiry','zola_message','zola_closed','zola_unparsed')),
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  text TEXT,
  attachments INTEGER NOT NULL DEFAULT 0,
  message_id_header TEXT,
  in_reply_to TEXT,
  failed BOOLEAN NOT NULL DEFAULT false,
  zola_lead_id INTEGER REFERENCES zola_leads(id) ON DELETE RESTRICT,
  at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_at ON gmail_messages(at);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_thread ON gmail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_from ON gmail_messages(from_address);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_message_id ON gmail_messages(message_id_header);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_in_reply_to ON gmail_messages(in_reply_to);

CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  history_id TEXT,
  backfill_page TEXT,
  backfill_done BOOLEAN NOT NULL DEFAULT false,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gmail_sync_skips (
  gmail_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inbox_reads ADD COLUMN IF NOT EXISTS solicitation BOOLEAN;
```

- `couple_label_key` is the normalized label of section 5.6, kept as a column so the lookup is an index hit and the rule lives in one JS function with the SQL it feeds.
- `to_addresses` holds To, Cc and Bcc, lowercased (Gmail's Sent copy keeps the Bcc header; a reply Bcc'd to the client must still answer them).
- `text` is null for an attachment-only mail and for an unparsed Zola notice.
- `failed` is set by a bounce (5.2 rule 6); `zola_lead_id` is `ON DELETE RESTRICT` because the Zola reader assumes every `zola_` row has its lead, and leads are never deleted.
- `proposals.source` CHECK: `(source IS NULL OR source IN ('thumbtack','zola'))`, by the new drop-and-re-add DO block of section 5.6.
- No change to `clients`, `email_leads`, `email_conversations`, `message_log` or `sms_messages`.
- The `gmail_sync_state` row is inserted by the first tick (`INSERT … ON CONFLICT DO NOTHING`), never by the schema file.

## 8. API

No new routes. The existing Inbox routes (`server/routes/admin/inbox.js`) carry the new data in their payloads:

- `GET /api/admin/inbox`: `waiting[]` rows gain `pitch` (boolean); `feeds[]` gains the `gmail` and `zola` sources, `gmail` with `status: 'on' | 'off' | 'failing' | 'catching_up'` beside `last_at` and `quiet`.
- `GET /api/admin/inbox/:personKey`: accepts `e-` and `z-` keys; the thread rows gain `attachments` (integer) on email rows and keep `subject`; `reply.app` gains `caption`; the context card gains the Zola lead shape (`{ kind: 'zola_lead', couple_label, wedding_date, client_id }`) and the unknown card gains `address` beside `phone_display`.
- `POST /api/admin/inbox/:personKey/text`: unchanged. An `e-` or `z-` person has no number to text; `resolveTextTarget` answers "Inbox only texts a number that has texted us first." for them, as it does for a `t-` key today, which the page never offers because the reply block's mode is `open`.
- `POST …/seen` and `…/actions` accept the two new key types through `parsePersonKey`.

The badge count includes email and Zola items like any other, except personal ones (decision 6), which count only for the owner's account.

**Viewer filtering** (decision 6): `GET /api/admin/inbox` leaves a personal person out of `waiting`, `snoozed` and `handled` for every viewer but the owner; `GET /api/admin/inbox/:personKey` answers 404 for a personal person to any other viewer (the page shows its "gone" state); the seen, actions and text routes refuse the same way. The owner's account is `PERSONAL_MAILBOX_OWNER_USER_ID`, user 1.

## 9. Changes to existing code

Every file is in `server/utils/inbox/` unless given.

- `personKey.js`: the two patterns. `client/src/components/inbox/inboxFormat.js`: `isPersonKey` accepts the same two, with its test extended (`inboxFormat.test.js:14-19`).
- `people.js`: own addresses, `clientsByEmail`, `staffByEmail`, `keyByEmailHash`, `resolveEmail(address)`, `zolaLeadsById`, `zolaKey(lead)`; the loader reads `clients.email`, `users.email` for the staff and operator queries, `zola_leads`, and `email_leads` (id, name, email) for names.
- `aliases.js`: rules 6 and 7.
- `engine.js`: two more header queries in `computeSnapshot`, the two mappers, the warning count; `directoryFor` names `e-` and `z-` keys (from `meta.fromName`, the marketing lead's name, or the address); `resolveKey` for the item route accepts them and moves an `e-` key through `keyByEmailHash`.
- `details.js`: the gm details loader (subject, text), keyed by `meta.id`.
- `classify.js`: `case 'gm'` in `countsAsReply`; `readOf` honors `meta.readRef`; `isCountedInbound` and `aiCannotClose` learn `zola_unread`; `eventNeedText` learns the attachment-only and unread copy; `sliceText` learns the subject prefix and `[attachment]`.
- `rules.js`: a `zola_closed` row joins the anchor set (step 1) as a close by the person; `pitch` on the waiting row (read from the newest counted inbound's read); `personal` on every person state (decision 6); nothing else.
- `engine.js` (list, badge and item paths) and `server/routes/admin/inbox.js`: the viewer filter for personal persons (section 8).
- `reasons.js`: `case 'gm'` with the email and Zola wording; the `zola_closed` closer.
- `thread.js`: subject and attachments on gm rows, the system lines for auto-replies, bounces and closed notices, "by email" captions, "Not delivered" with "Email bounced".
- `replyRules.js`: `latestConversationChannel` learns `email` and `zola`.
- `reply.js`: `appLinkFor` returns Thumbtack, Gmail or Zola links with captions for the latest channel; the Thumbtack caption moves here.
- `context.js` and `contextFormat.js`: the Zola lead card and `address` on the unknown card.
- `feeds.js`: the two rows and the Gmail status.
- `subjects.js`: `zola_unread` in the slice list; one outbound subject per `meta.readRef`.
- `aiRead.js`: the schema field, the prompt paragraph, the per-channel line caps, the subject prefix.
- `readJob.js`: stores `solicitation`, forces `needs_reply` when it is true; the legal-hold key lookup with `e-` and `z-` keys; the sibling hold flag.
- `payload.js`: `pitch`, `personal`, `attachments`, `app.caption`.
- `constants.js`: `PERSONAL_ALIAS`, `PERSONAL_MAILBOX_OWNER_USER_ID`, `ZOLA_UNREAD_TEXT`, `EMAIL_LINE_MAX`, `GMAIL_SYNC_MAX_PER_TICK`, `GMAIL_SYNC_TICK_MS`, `ZOLA_CLIENT_DAILY_CAP`, the dropped-domain, no-reply and auto-reply-subject constants, `zolaLeadUrl()`, `gmailThreadUrl()`.
- New: `readGmail.js`, `readZola.js`, `mailText.js`, `zolaMail.js`, `zolaLeads.js`, `gmailSync.js`, `server/utils/gmailClient.js` (the credentialed client, outside the inbox folder like `anthropicClient.js`), `server/utils/zolaProposalDraft.js`, `scripts/gmail-probe.js`.
- `server/index.js`: the `gmail_sync` scheduler.
- `server/db/schema.sql`: section 7 and the proposal source block.
- `server/routes/proposals/lifecycle.js` and `client/src/pages/admin/ProposalDetail.js`: the no-contact Send guard (lane 5). `server/routes/proposals/list.js`, `metadata.js`, `client/src/pages/admin/ProposalsDashboard.js`, `client/src/components/admin/SourceBadge.js`, `client/src/pages/admin/overview/FunnelCard.js`: `zola` as a source value, badge, count and segment.
- `client/src/components/inbox/ReplyBar.js`: reads `app.caption`; `inboxFormat.js`: `isPersonKey` only (labels exist); the list row: the Pitch chip; the thread: subject, attachment and the new system lines; the item card: the Zola lead and address shapes; the feed line: the four Gmail statuses.
- `client/src/pages/website/legal/PrivacyPage.js`: the Google line says the business mailbox is read as well as venue lookup; the date bumps.
- `scripts/sensitive-paths.txt`: `server/utils/gmailClient.js`, `server/utils/inbox/zolaLeads.js` (already under the folder glob; listed for the reason comment), `server/utils/zolaProposalDraft.js`, `scripts/gmail-probe.js`.

## 10. The Gmail client (`server/utils/gmailClient.js`)

- Reads `GMAIL_SERVICE_ACCOUNT_KEY` (the JSON key, base64-encoded so Render's single-line env holds it). The mailbox it reads as is the code constant `GMAIL_MAILBOX` (the business address, already in the repo's docs), never an env var (decision 2).
- `isConfigured()` is true when the key decodes and parses. The parse runs inside a try; a failure yields a fixed message ("GMAIL_SERVICE_ACCOUNT_KEY does not parse") and never the parser's own message, which on current Node quotes a fragment of the input (fleet).
- `createGmailClient()` returns null when not configured; under `NODE_ENV=test` it refuses to build a real client unless a test injects a stub (the Anthropic precedent).
- Token: a JWT with `iss` the service account's email, `sub` the mailbox, `scope` the read-only scope, `aud` Google's token endpoint, signed RS256 with Node's `crypto.sign`; exchanged at `https://oauth2.googleapis.com/token`; cached until 60 seconds before expiry. Hosts are pinned constants (`https://oauth2.googleapis.com`, `https://gmail.googleapis.com`); no env var can redirect them.
- Methods: `getProfile()`, `listMessages({ q, pageToken })`, `listHistory({ startHistoryId, historyTypes, pageToken })`, `getMessage(id)`, `listLabels()`. Each returns `{ data }` or `{ error: { status, class } }`; a 401 or 403 is `GmailAuthError`, a 404 on history is `GmailHistoryGoneError`, a 429 or 5xx is `GmailUnavailableError`. No message body ever appears in an error, a log line or a Sentry event.
- Timeout 20 seconds per call, no retries inside the client (the tick retries next minute).
- The private key never leaves the module and is never logged, not even its length.

**The probe** (`scripts/gmail-probe.js`, tracked, decision 18): run with the key in that command's environment only (`GMAIL_SERVICE_ACCOUNT_KEY=… node scripts/gmail-probe.js`), it calls `getProfile()` and `listLabels()` and prints the address it authenticated as, the label count, and whether `CATEGORY_PERSONAL` is among the labels (the one label the unknown-sender rule hangs on), nothing else. It is the only Gmail call allowed from the dev box, and it runs once before the key goes into Render. Dallas does the Render step by hand (memory: Render env is his).

## 11. Visual contract

The surface is the shipped Inbox page; the design source is the parent's artifact (`docs/design-artifacts/2026-10-06-inbox/`, the vendored export), whose data file already draws email and Zola items, their thread rows with a subject line, the "Open in Gmail" and "Open in Zola" reply modes, the handled rows with "You emailed back" and "Zul replied in Zola" (both superseded by decision 9: the shipped copy is "Replied by email" and "Replied to Zola by email"), and the Gmail and Zola feed rows. The lane matches those drawings for layout, composition and component vocabulary, in the shipped House Lights rules, and adds three things the artifact does not draw, in the vocabulary it does: the Pitch chip (a muted `StatusChip` after the channel icons), the attachment count line (the muted subject line's style, under the bubble), and the "Gmail catching up" and "Gmail failing" feed wordings (the AI status line's style). Nothing is drawn under the composer (decision 17). `ui-ux-review` on the page lane is pointed at the artifact and judges adherence; usability-clean but off-design is a finding.

## 12. Failure modes

- **Key unset:** the feed is off, the line says "Gmail off", nothing else changes.
- **Delegation revoked or key rotated:** every call is 401; after three ticks the line reads "Gmail failing", Sentry gets a warning an hour; mail that arrives meanwhile is picked up by the resync once the key works again (history, or the dated resync).
- **Key leaked:** delete the key in Google Cloud and remove the delegation row in the Workspace admin console (decision 2). The key can read every Workspace mailbox, not only the business one.
- **History too old:** the dated resync of 5.5 step 3.
- **Google unavailable:** the tick returns; the next one retries. No mail is lost; the history id is only advanced after the window's messages are stored, dropped or skipped.
- **Two instances at a deploy:** the lease (5.5) lets one tick run; the other ends.
- **One message that always fails:** three attempts, then skipped with a Sentry warning; the feed moves on (decision 20).
- **A Zola template changes:** an unparsed notice becomes a waiting item that says so (decision 14); a subject change drops Zola's mail as marketing, which the Zola feed row shows as going quiet, and a client who writes directly is unaffected.
- **A spoofed Zola notice:** fails the authentication gate (5.6), is dropped and counted; it never creates a client, a lead or a link.
- **A runaway of Zola inquiries:** the daily cap stops client and draft creation; notices and lead rows still land (5.6).
- **A malformed message:** skipped with its id, the tick continues.
- **A huge mail:** text capped at 20,000 characters at storage; the AI line caps apply on top.
- **An HTML-only mail:** converted (5.7).
- **A Sent mail to nobody we can resolve** (a reply to a dropped domain, to ourselves): dropped by 5.2; a Sent mail to an unknown outside address is stored and forms an outbound-only event under an `e-` key, which the rules leave quiet (no inbound, nothing waits).
- **A Gmail reply that bounces:** the bounce marks the Sent row failed; the item stays waiting (5.4).
- **A human Gmail filed outside Primary:** dropped at first, re-evaluated when Dallas drags it to Primary (5.2); the per-tick drop count is in the log.
- **Two couples with one label:** two lead rows (5.6).
- **A hand-made Zola client already exists for a new inquiry:** a second client row is created with source `zola` and the lead link; the client page shows both, and Dallas merges by hand if he wants. The spec accepts this over a name-matching rule that would mislink.
- **The read job meets a pitch:** the item waits with the tag (decision 12); a wrong tag costs nothing.
- **A client's email changes on their row:** the old address's mail, stored under the old resolution, re-resolves at read time to whatever the index says now (read-time resolution, like phones).
- **The AI read is off or capped:** a Zola closed notice still closes (decision 19); everything else waits as the parent says.

## 13. Configuration, docs and lists

| Variable | Purpose |
|---|---|
| `GMAIL_SERVICE_ACCOUNT_KEY` | Base64 of the service account's JSON key. Server-only, read only by `server/utils/gmailClient.js`. Unset means the Gmail feed is off. Smoke it with `scripts/gmail-probe.js` before Render. BLAST RADIUS: under domain-wide delegation the key can read every mailbox in the Workspace, not only the business one. Leak response: delete the key in Google Cloud and remove the delegation row in the Workspace admin console. |
| `INBOX_OWN_EMAILS` | Optional comma list of extra addresses that are "us" and never form an item (the older Gmail address of the business). The mailbox, its aliases and every admin's and manager's address are ours without being listed. |
| `RUN_GMAIL_SYNC_SCHEDULER` | Optional. `false` disables the 60-second Gmail sync. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |

- `.claude/CLAUDE.md` env rows (with the blast-radius sentence, the `THUMBTACK_AGENT_SECRET` precedent) and the Tech Stack integration line; `.env.example`; `README.md` (folder tree, env table, key features); `ARCHITECTURE.md` (the four tables, the scheduler, the Google integration row, the widened proposal source).
- `scripts/sensitive-paths.txt`: section 9's files.
- `scripts/money-smoke-list.txt`: unchanged; no money path moves (the draft is status `draft` at the package's flat price, the Thumbtack precedent, already covered by `thumbtackProposalDraft` suites; the Send guard refuses, it never charges).
- The privacy page: section 9's one-line change to the Google provider line; the Anthropic line already says "messages".
- Fix list: nothing owed from this spec at write time.

## 14. Testing

One suite at a time on the shared dev DB; no TEMP tables; read the pass count. The suites stub the Gmail client; no test ever reaches Google.

**Pure modules, unit tests with invented fixtures:**
- `mailText.test.js`: plain vs HTML, Gmail, Apple Mail and Outlook quote headers, `-- ` and device signatures, the signature-block heuristic, the empty-result fallback, the cap, attachment counting, a calendar part.
- `zolaMail.test.js`: each template built by the fixture builder from an invented couple, the gate (pass, DKIM fail, DMARC fail), the message's UUID read direct and from a wrapped link, a bad UUID ignored, the label cut, the date, the closed reason, marketing dropped, booked dropped, a subject match with an empty body as unparsed, a label with odd spacing normalizing to one key.
- `people.test.js`: own addresses (the aliases, `INBOX_OWN_EMAILS`, admins and managers, Zola's vendor address, a domain staffer who is staff), client before staff, the `e-` hash is stable and carries no address, `keyByEmailHash`, Zola lead to client resolution.
- `personKey.test.js` and `inboxFormat.test.js`: the two new patterns, leading zeros and int4 limits on `z-`.
- `aliases.test.js`: rules 6 and 7.
- `readers.test.js`: the two mappers over header rows, the recipient suffix with a shared `readRef`, outbound resolution by the answered inbound before recipients, Bcc, the read-time Zola join in both storage orders, auto-reply and bounce as system, `failed` from a bounce, the sibling hold flag.
- `classify` and `rules` suites: `isPersonal` (dallas@ only and unknown sender is personal; contact@ in copy, a client sender, a staff sender or a marketing-lead sender is not; a person with one business mail is not); the viewer filter in the engine and route tests (owner sees the row and the item, another admin gets neither, the badge differs by viewer); a Gmail reply closes, holds when read as holding, ends a claim; a bounced reply does not close; two staff recipients answer no staffer; `zola_unread` waits and the AI cannot close it; a `zola_closed` row anchors and closes with its reason; an attachment-only mail waits; a pitch read keeps the item waiting with `pitch: true`.
- `reasons.test.js`, `thread.test.js`, `payload.test.js`, `reply` and `replyRules` tests: the wording, the subject and attachment lines, the captions for all three apps, latest-channel mode for email and Zola, the Zola URL fallback.
- `subjects.test.js`: a personal person yields no subject. `aiRead.test.js`: the schema accepts `solicitation`, the line caps by channel, the subject prefix, `[attachment]`; `readJob.test.js`: `needs_reply` forced true on a solicitation, one read per `readRef`, the legal-hold keys include `e-` and `z-` and the sibling flag; `subjects.test.js`: `zola_unread` in the slice, `auto_reply` and `bounce` out.
- `gmailSync.test.js`: the lease (claimed, held by another, expired), the history id read before the first page, first sync pages oldest-first and stores the id, steady state with `messageAdded` and `labelAdded`, 404 triggers the dated resync, the counting rules in order (Zola before own), the bulk filter, idempotent re-processing, side effects gated on the insert, a failing message recorded and skipped on the third attempt while the window advances, the wall-time and count bounds, one cache invalidation per tick, the summary line and the error class stored without content.
- `gmailClient.test.js`: refuses to build under test without a stub, null when unconfigured, the fixed parse-failure message, the token request's shape (sub, scope, aud) against a stubbed fetch, pinned hosts, error classes by status, no key material in any error.
- `zolaLeads.test.js`: find by UUID, by label, create; UUID filled on a label match; a second couple with the same label gets a second row; client created only for post-switch-on inquiries and under the daily cap; closed stamps the row; an unparsed notice with no label gets its own row.
- `zolaProposalDraft.test.js`: the draft's shape (`calculateProposal` first, package, `numBars` 0, date and time, event type id, source, notes), idempotent under the lead's `proposal_id`, best effort after the lead commit with the Sentry tag; `proposals/crud.test.js` for the widened CHECK; a `lifecycle` test for the no-contact Send refusal.

**Acceptance on prod, by the lane after the key is in Render (the parent's lane inbox-engine precedent):** the feed line reads catching up, then on; the backfill completes; a known client's recent email thread shows on their item with the right subject and no quoted history; an unknown human sender in Primary forms an item (the positive case for the category gate); a Sent reply shows as "Replied by email" in Recently handled; thirty days of Sent hold no row the reader counts as a human reply that was not one (vacation responders, calendar invitations); a Zola thread shows as a lead item with "Open in Zola" opening the lead page; a day-one Done pass clears the backfilled Zola threads that were answered inside Zola; the Gmail link opens the thread on the phone (the Gmail app) and the desktop, with a fallback URL form if the `authuser` form does not (the parent's amendment 17 pattern); no admin alert, no Thumbtack notice and no newsletter formed an item.

Suites a change reaches (memory): the whole `server/utils/inbox/` set, `server/routes/admin/inbox.test.js` if present, `proposals/crud.test.js`, the `lifecycle` suites, `clientDedup` tests, `thumbtackProposalDraft.test.js` (shared insert), and the client build (`CI=true react-scripts build`).

## 15. Review level

Full fleet on every lane: `server/utils/inbox/**` and `schema.sql` are sensitive; `gmailClient.js` holds a credential; `zolaLeads.js` and `zolaProposalDraft.js` create client and proposal records from parsed mail; lane 5 touches the proposal Send path. Plus the second opinion at push, per the push model. The design-stage fleet (`/review-spec`) ran on this document on 2026-10-14 (section 17), and `/review-plan` runs on the plan.

## 16. Rollout and lanes

Lanes, in dependency order; the plan writes footprints and the parallelism graph:
1. **gmail-client:** `gmailClient.js`, the probe, env rows, docs, sensitive list. Dark: nothing calls it yet.
2. **email-feed** (after 1): schema (all four tables, the reads column), `gmailSync.js`, `mailText.js`, the people index, keys (server and page), aliases, the two readers, details, classify, rules (the `zola_closed` anchor, `pitch`), reasons, thread, replyRules, reply, context, feeds, payload, the scheduler, the client's list chip, thread lines, captions, feed wording, the privacy line. Zola rows are stored by this lane with the authentication gate and the subject match, but the body parser is lane 3, so until lane 3 merges every gated Zola notice is stored as `zola_unparsed` and shows as an unread item, the decision 14 fallback, acceptable for the hours between merges; the two lanes merge together before any push.
3. **zola-leads** (after 2): `zolaMail.js` (the body parser), `zolaLeads.js`, the lead card, "Open in Zola", the backfill rule, the daily cap.
4. **email-ai** (after 2, parallel with 3): the schema field, the prompt, the caps, the subject, attachments, the solicitation store rule, one read per `readRef`, legal-hold keys and the sibling flag, the Pitch tag end to end.
5. **zola-draft** (after 3): `zolaProposalDraft.js`, the CHECK block, the source consumers, the no-contact Send guard.

Switch-on, after the push that carries lanes 1 to 4 at least:
1. Dallas runs the probe once with the key in that command's environment; it prints the business address and confirms the Primary category label exists.
2. Dallas sets the key in Render, and the own-addresses list for the older Gmail address. The next deploy's first tick starts the backfill from the history floor.
3. The feed line reads catching up, then on; the acceptance list of section 14 is walked, the day-one Done pass included.
4. The first real Zola inquiry after switch-on proves the gate, the parser, the client creation and, once lane 5 is in, the draft.
5. `walkthroughs-owed.md` gains the email and Zola walk: a client email, a reply from Gmail, a Zola thread, a pitch.

## 17. Amendments from review and planning

**Design-stage fleet, 2026-10-14** (spec-grounding, spec-gaps, spec-risk, run as generic agents with the three standing instructions inlined because the session started outside the repo). Every finding was verified against the code before it was folded; the changes are in the body above and listed here so the trail exists.
1. The proposal source CHECK is an add-if-missing block, so the widening is a new drop-and-re-add block, one site (all three reviewers).
2. The page's own key check must accept `e-` and `z-` or every email item opens as "gone" (gaps).
3. The Sent-to-Zola link resolves at read time by a join, never at sync time, because the backfill lists newest first (gaps).
4. The Zola parser is gated on Gmail's authentication header for Zola's domain; the lead UUID is pattern-checked and the label capped before either reaches a row (risk).
5. Own addresses are the mailbox, its aliases, the admins and managers, the env list and Zola's vendor address, not the whole domain; Zola's branch runs before the own-address drop; the resolution order is pinned once (gaps, grounding).
6. `replyRules.latestConversationChannel` owns the reply mode for the two channels; there is one app slot and nothing under the composer, since the design draws no secondary link (gaps, grounding).
7. The draft's event type is `wedding-reception`; it runs `calculateProposal` first; `numBars` 0 depends on the package being service only (gaps, grounding).
8. The history id is read before the first backfill page (gaps).
9. The tick leases the state row with one claiming statement; every side effect is gated on the message insert returning a row, in that message's transaction; a failing message is skipped on its third attempt and the window advances (gaps, risk).
10. `labelAdded` for Primary re-evaluates a dropped message; a reply to our own Sent mail counts whatever its category; the tick logs its counts (gaps, risk).
11. A Sent mail to two or more staffers answers no staffer, the parent's rule (gaps).
12. The message notice's plain-text lead link is direct; the parser also decodes a Mandrill-wrapped one (gaps).
13. A subject-pattern auto-reply fallback; the auto-reply rule applies to Sent rows; a calendar-only Sent row is an auto-reply (gaps, risk).
14. The people index keeps a hash-to-key map so `e-` keys can fold and move; pass 1 carries the From display name (gaps).
15. Bcc is folded into the recipients (gaps).
16. A bounce marks the Sent row it names as failed, so it is not a reply (risk).
17. A Sent row answers the person of the inbound it replies to before it answers its recipients (risk).
18. A Sent mail that reached a held key flags every sibling event `legalHold` (risk).
19. The mailbox is a code constant; the env row carries the blast radius and the leak response (risk).
20. Decision 6 now names manager visibility of personal mail as part of what was accepted, pending Dallas's word (risk).
21. A daily cap on lead-driven client creation (risk).
22. The Send path gets a real no-contact guard; the old claim that the confirm guarded it was false (grounding).
23. Every consumer of `proposals.source` is enumerated (grounding).
24. The unknown card's field is `address` beside `phone_display`; the Gmail feed status uses the AI status vocabulary plus `catching_up` (grounding).
25. `zola_unread` joins the AI slice list; `auto_reply` and `bounce` stay out; details load by `meta.id`; one read per mail across recipient suffixes (grounding, gaps, risk).
26. The unique email index is case-sensitive; the wording says so (grounding).
27. The privacy page's Google line is amended (grounding).
28. One cache invalidation per tick, a wall-time bound, a Sentry capture on draft failure, the parse-failure message fixed, the unsalted hash named as accepted, a positive acceptance case, a day-one Done pass, a thirty-day Sent check, the probe checks the Primary label, the Zola lead foreign key is `RESTRICT` (gaps, risk).
29. A Zola closed notice closes by rule, not through the AI (gaps).

**From Dallas after the fleet, 2026-10-14:**
30. Personal mail at dallas@ (unknown sender, no other alias in copy) is tagged, never AI-read, and visible only to his own account (decision 6, sections 4.1, 5.2, 6, 8, 9, 14).

**From planning (`docs/superpowers/plans/2026-10-14-inbox-email-zola.md`, 2026-10-14):**
31. **Lane 2 stores gated Zola notices as `zola_unparsed`** with a minimal `zolaLeads.findOrCreateLead` (by uuid, open label, or a "Zola notice <date>" row), so the Zola reader always has a lead; lane 3 adds the body parser, the client creation and the cap (sections 5.6, 16).
32. **Constants named by the plan** beyond section 9: `EMAIL_PRECLIP_MAX` (8,000), `GMAIL_LEASE_SECONDS` (120), `GMAIL_SKIP_ATTEMPTS` (3), `ZOLA_VENDOR_ADDRESS`, `ZOLA_RELAY_DOMAIN`, `ZOLA_DASHBOARD_URL`, `NO_REPLY_LOCAL_RE`, `AUTO_REPLY_SUBJECT_RE`.
33. **The Gmail client** exports `configurationError()` (the fixed parse message) and `GMAIL_MAILBOX`; `listHistory` sends `historyTypes` as a repeated query parameter, one per type (section 10).
34. **Readers resolve a multi-recipient Sent row as a set:** `mapGmailHeaders(rows, index)` takes every header row, because resolving "the inbound this answers" needs the stored inbound rows beside the Sent row (section 5.1).
35. **The page's file names:** the list row is `WaitingRows.js`, the thread `Thread.js` and `inboxThread.js`, the card `ContextViews.js`, the feed line `FeedsLine.js` (section 9).
36. **The Send guard's suite** is a new `server/routes/proposals/lifecycle.sendGuard.test.js`; there is no `lifecycle.test.js` today (section 14).
