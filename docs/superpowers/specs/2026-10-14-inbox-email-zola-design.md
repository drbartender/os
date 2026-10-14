# Inbox piece 3: email and Zola flow into Inbox

**Date:** 2026-10-14
**Author:** Claude, from a brainstorm with Dallas
**Status:** approved in conversation (five questions settled 2026-10-14), spec written, design-stage fleet pending
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

Everything below was checked against the live mailbox through the Gmail connector, the prod database read-only, and the code on main at `40ff2864`.

**The mailbox.**
- The business runs on Google Workspace (the domain's MX records are Google's). contact@ is the business mailbox. The no-reply and dallas@ addresses deliver into the same mailbox: a client's reply to a Resend mail (sent from the no-reply address with the admin address as Reply-To) lands in contact@, and mail addressed only to dallas@ lands there too.
- Replies from Gmail go out from contact@ by both Dallas and Zul. Zul's sends carry no delegation header, so Gmail cannot say who typed a reply. Dallas, 2026-10-14: "we don't really care who replied".
- The OS's own Resend sends never appear in Gmail's Sent folder (Resend delivers them through its own pipeline), so an OS send and a Gmail reply can never describe the same event.
- The Cowork morning report is sent from contact@ to contact@ and shows in both Sent and Inbox.
- Two weeks of inbound mail: a handful of human client threads (change requests, a certificate of insurance, a refund complaint, a corporate inquiry Zul answered, a client's planner writing from her own address), one vendor pitch, and a steady flow of receipts, newsletters and service notices (Twilio, Cloudflare, OpenAI, U-Haul, Claude). Human client mail sat in Gmail's Primary category; Zola's notices sit in Updates.
- An older Gmail address of the business still receives Zola's "booked" notices, with contact@ in copy. It needs no feed of its own; it is one of our own addresses (section 5.2).

**Zola.** Zola sends email only, from one vendor address (`weddingvendors@zola.com`, a system sender, not a person), through Mandrill, in these templates:
1. **Inquiry** (subject "New Zola inquiry for <vendor>"): the couple's label (two first names with last initials, for example "Alex B & Sam C"), "Their note to you" with the note in quotes. Its Reply-To is Zola's vendor address, not a relay: a Gmail reply to the inquiry mail does not reach the couple. The plain-text part carries no lead id; every link is a tracked redirect.
2. **Message** (subject "New message from <couple label> for <vendor>"): the couple's label, "Getting married on <date>", sometimes a budget line, "<first name>'s message" and the message in quotes, then "Respond on Zola" linking `https://www.zola.com/inspire/vendors/leads/ready/<lead UUID>`, then "Or reply to this email directly". Its Reply-To is a per-message relay address at a Zola subdomain (`vmkt-message.zola.com`): a Gmail reply to this mail reaches the couple through Zola.
3. **Closed** (subject "<couple label> closed their inquiry"): the couple ended the inquiry, sometimes with a reason.
4. **Booked** (subject "Booked! ..."): the couple booked. Carries full names, no contact details, and no couple label, so nothing in it ties it to a lead row.
Plus marketing from the same address (featured spots, momentum, reviews). Zola never gives the couple's email or phone. Zola never emails about a reply we made inside Zola.
- Dallas, 2026-10-14: The Knot has announced acquiring Zola; Zola has said nothing. Dallas's call: build it and make a template change loud, not silent (section 12).

**Prod, read-only.** 707 clients, 614 with an email, no two clients share one (unique index `idx_clients_email_unique`, case-insensitive index `idx_clients_email_lower`). 14 clients carry source `zola`, all made by hand. 27 marketing leads, none linked to a client, and the lead-conversations table has never held an inbound row. Three admin users, all on the domain; one staffer on the domain. 583 email rows in the message log over 30 days.

**Code.**
- Readers return events in one shape (parent 5.1) and the engine runs them in two passes: light headers since the history floor, then full rows for the people the rules keep (`server/utils/inbox/engine.js:117-150`, `details.js`). Pieces 3 and 4 "add readers and nothing else" (parent 5.1); this spec adds readers, two tables, a sync job, and the small extensions each listed in section 9.
- `classify.countsAsReply` already has a default branch for a later source: an outbound row answers when a human sent it (`classify.js:54-57`). A Gmail reply has no known author, so it gets its own case (section 5.4).
- The people index resolves phones at read time (`people.js`); `personKey.js` accepts `c-`, `s-`, `p-`, `t-`; alias folding (`aliases.js`, parent amendment 22) moves taps when a key moves.
- The AI read's prompt already labels channels `email` and `Zola` (`aiRead.js:132-137`); the client already labels and icons them (`client/src/components/inbox/inboxFormat.js:43-49`); the reply bar already renders `mode: 'open'` with an app link (`client/src/components/inbox/ReplyBar.js:55-76`), composing the caption itself from the app name.
- The feed line lists Thumbtack and the three text lines (`feeds.js`); the design draws Gmail and Zola rows too (`docs/design-artifacts/2026-10-06-inbox/inbox-data.js:207-215`).
- The Thumbtack webhook creates the client through `findOrCreateClient` (`server/utils/clientDedup.js:43-130`) and the draft proposal through `createDraftProposalFromLead` (`server/utils/thumbtackProposalDraft.js:166-245`), which uses the shared `insertProposalRecord` (`server/utils/proposalInsert.js`). `proposals.source` is CHECK-constrained to `thumbtack` or null (`schema.sql:961-964`); `clients.source` already allows `zola`.
- Schedulers register through `wrapScheduler(name, seconds, tick)` behind `enabled('RUN_…')` (`server/index.js:498-512`, `838-846` for the AI read).
- `server/utils/anthropicClient.js` is the precedent for a credentialed client: hosts pinned, refuses to build under `NODE_ENV=test` without a stub, logs at warn, null when unconfigured.
- Nothing here sends, so Resend is not on this spec's path. The Gmail client follows the result-or-typed-error rule the Resend memory teaches: every call returns a result or a typed error, never a thrown string.
- `server/utils/inbox/**` and `schema.sql` are sensitive paths; this spec adds its credentialed client and its Zola writer to the list (section 13).

## 3. Decisions

Each one was settled with Dallas on 2026-10-14 unless marked as a design call.

1. **One mailbox, read by the prod server.** The server reads contact@ through the Gmail API on a 60-second tick. No push (a Pub/Sub topic, a public webhook and a weekly watch renewal buy nothing at this volume), no box agent (Gmail has an API; the box is for Google Voice), no IMAP.
2. **Service account with domain-wide delegation.** Dallas created the service account and its JSON key, lifted the org policy that blocked key creation on that one project, and granted the account's client id the single Gmail read-only scope in the Workspace admin console (all 2026-10-14). The key lives only in Render. The dev box has none; the suites stub the client.
3. **Read-only.** The one scope is `https://www.googleapis.com/auth/gmail.readonly`. Inbox never sends, labels or deletes mail.
4. **No Google SDK.** The client signs the service-account JWT with Node's own crypto, exchanges it at Google's token endpoint "as contact@", and calls the Gmail REST API with `fetch`, the Telegram precedent. Hosts are pinned; the key is never logged.
5. **Unknown senders count.** A human writing from an address nobody knows forms an item, behind the bulk filter of section 5.2. Known clients and staff are exempt from the filter. The alternative, a closed list, would hide a brand-new lead who emails directly.
6. **The dallas@ alias stays in.** Mail addressed only to dallas@ counts like mail to contact@. Dallas chose this knowing it includes personal correspondence, which is then stored and read by the AI like any other human mail.
7. **Notification mail is never an item.** Thumbtack's notices (the webhook already delivers those messages), the OS's own alerts, Cal.com, Stripe, Twilio and every other machine sender are dropped before storage, so no message ever shows twice.
8. **Email identity resolves at read time, like phones.** Clients first, then the send-eligible staff set, then our own addresses (never an item), else an unknown-address person keyed by a hash of the address.
9. **A Gmail reply carries no author.** It ends a claim and closes or holds the item; the handled line reads "Replied by email". No clock-offset or signature inference. "If we do [care] we can look at the signature."
10. **Zola closes only by email.** A Gmail reply to a Zola message notice reaches the couple through Zola's relay and counts as a reply. A reply typed inside Zola is invisible to the OS and needs Done. The caption says so.
11. **A Zola inquiry creates the client and a draft proposal,** the way the Thumbtack webhook does: the couple's label as the name, source `zola`, no email or phone; a draft at the default package with the wedding date set, the note in the admin notes and the proposal's source marked `zola`. Dallas: "lets just do it." The draft is the last lane.
12. **A pitch never closes on its own.** The inbound read gains a `solicitation` flag. When it is true the item stays waiting whatever else the model says, with a "Pitch" tag on the row and the AI's one line on what they are selling. Dallas: "I want to make that call."
13. **The AI reads email with email-sized lines.** An email line may run 4,000 characters after redaction (texts stay at 1,500), the subject rides ahead of the body, attachments appear as "[attachment]", and machine auto-replies never reach the model.
14. **Make a Zola template change loud.** A mail from Zola's vendor address that matches no template becomes a waiting item that reads "Zola sent something the OS couldn't read. Open Zola.", the feed line shows Zola going quiet, and Sentry gets one warning an hour. A lead is never lost to a template change; a week of convenience is.
15. **Backfill from the history floor.** The first sync reads mail since `INBOX_HISTORY_START` (parent decision 18), so the list is complete on day one. Backfilled Zola threads become items but create no client and no draft; client creation applies to inquiries that arrive after the feed is on (design call: a burst of auto-created duplicates of the 14 hand-made Zola clients is worse than a few unlinked items).
16. **Nothing is stored that Gmail keeps better.** The row holds the sender's address and display name, the recipients, the subject, the person's own words with quoted history and signature stripped, an attachment count and the Gmail ids. Never the raw mail, never an attachment, never the quoted history.
17. **Latest channel wins in the reply area,** as it does for Thumbtack today (parent 4.3): a person whose newest message is an email gets "Open in Gmail", a Zola couple gets "Open in Zola", and a person whose newest message is a text keeps the text composer.
18. **Ships dark.** With no key in Render the feed is off and the feed line says so. Before the key goes in, a tracked probe proves which address the key reads as.

## 4. What Dallas and Zul see and do

### 4.1 The list

An email or Zola item is a row like any other: the person's name, the need line, the wait, the channel icons (`mail` for email, `book` for Zola, from `inboxFormat.js`). The need line is the AI's summary once it lands, before that the first 200 characters of the person's own words (`classify.eventNeedText`), and for an attachment-only mail "Sent an attachment".

**The Pitch tag.** A waiting row whose newest inbound read says `solicitation` carries a small "Pitch" chip after the channel icons, in the muted chip style of the shipped `StatusChip`. The need line is then the AI's line on what they are selling ("Selling bar stools for events"). Done closes it like any item.

**Names.** A client's item shows the client's name. A staffer's shows theirs. A Zola couple's item shows the couple's label exactly as Zola wrote it. An unknown-address person shows the display name from their From header; with no display name, the address itself (the unknown-number precedent, which shows the number).

### 4.2 The thread

- An inbound email row shows the subject in the muted line above the bubble (the design's `subject` field on email rows), then the person's own words. Quoted history is not shown; "Open in Gmail" has the whole mail.
- A row with attachments adds a muted line "1 attachment" or "3 attachments". Never a filename, never a link.
- An outbound Gmail reply row shows our words with `author_name` null, as a Thumbtack Business row does today, never "Auto", and the caption "by email" where a text row says the line.
- A Zola inbound row shows only the couple's words. The inquiry row's subject line reads "Zola inquiry"; a later message's reads nothing.
- A machine auto-reply ("out of office") is a system line: "Auto-reply received".
- An unreadable Zola notice is an inbound row that reads "Zola sent something the OS couldn't read. Open Zola." (constant `ZOLA_UNREAD_TEXT`), the Thumbtack "never received" pattern.
- A Zola "closed" notice is an inbound row: "Closed their inquiry on Zola." followed by the couple's reason when the notice carries one.
- A Zola "booked" notice is never stored (section 5.6): nothing in it names the lead, and the couple's own thread carries the news.

### 4.3 The context card

- A client keeps the client card. A Zola couple whose inquiry created a client is a client.
- A backfilled Zola couple with no client gets a lead card: "Zola lead", the couple's label, the wedding date when known, and "No client record yet".
- An unknown-address person gets the unknown card with the address where the unknown-number card shows the number.

### 4.4 Replying

The reply block (`reply.js:buildReplyBlock`) gains the two app links beside Thumbtack's.

- **Email:** `mode: 'open'`, app `{ name: 'Gmail', url, caption }`. The URL opens the Gmail thread in the business account: `https://mail.google.com/mail/?authuser=<mailbox>#all/<gmail thread id>`. Caption: "Closes here on its own once you reply from Gmail."
- **Zola:** `mode: 'open'`, app `{ name: 'Zola', url, caption }`. The URL is the lead page (`https://www.zola.com/inspire/vendors/leads/ready/<lead UUID>`) when the UUID is known, else the vendor dashboard (`https://www.zola.com/inspire/vendors/dashboard`). Caption: "Reply to Zola's email from Gmail and it closes here on its own. A reply typed inside Zola needs Done."
- The caption now travels in the payload (`app.caption`) instead of being composed by the page, so Thumbtack's caption moves into the server too and reads as it does today.
- A person whose newest message is an email but who also has a phone gets the Open button, not the composer (decision 17). A person whose newest message is a text keeps the composer, and when they also have an email thread the Open button sits under the composer as a secondary link (the design's `alt`).
- Opted out or bad number keep today's notices, with the Gmail link kept beside them as the parent spec says (parent 4.3).

### 4.5 Recently handled

- A Gmail reply closes with "Replied by email", `reason_code: 'email'`, `by: null`.
- A Zola reply by email closes with "Replied to Zola by email", `reason_code: 'zola'`, `by: null`.
- A couple who closed their inquiry closes through the AI read ("AI: closed their inquiry on Zola"), section 6.
- Done, Snooze, Reopen and the AI's "no reply needed" read as today.

### 4.6 Feed health

Two rows join the line: "Gmail 1 min ago" and "Zola 3 days ago".
- **Gmail** is the time of the last successful sync, not the last human mail: a quiet mailbox is healthy, a stuck sync is not. It reads "Gmail off" when the key is unset and "Gmail failing" after 3 consecutive failed ticks, beside the AI status.
- **Zola** is the time of the last stored Zola notice of any template, quiet by nature like the 224 lines; the dot follows the 48-hour rule.

## 5. The rules

### 5.1 Events

Two readers are added. Both read the `gmail_messages` table (section 7); the sync job of section 5.5 is what fills it. Pass 1 reads headers (no subject, no text); pass 2 loads subject and text for the people the rules keep, through `details.js`.

**Email reader** (`readGmail.js`): every row with `kind` in `message`, `auto_reply`, and no `zola_lead_id`.
- `ref`: `gm:<gmail message id>`.
- `channel`: `email`.
- `direction`: `in` for a row without the SENT label, `out` for a Sent row.
- `at`: the message's internal date.
- `author`: `null` on every outbound row (decision 9).
- `kind`: `message`; `media` when the row has attachments and no words (section 6: never read, stays waiting); an `auto_reply` row keeps `kind: 'auto_reply'` with `direction: 'system'`, which the thread renders as its system line and the rules never count.
- `meta`: `source: 'gm'`, `id`, `threadId`, `address` (the other party's address, for the unknown card and the Gmail link), `attachments`, `textBearing: true` on outbound rows that have words, `empty` when inbound has no words and no attachment.

**Zola reader** (`readZola.js`): every row whose `kind` starts with `zola_`, plus every Sent row whose In-Reply-To names one of them. Every such row has a `zola_lead_id` (section 5.6 gives even an unparsed notice a lead row).
- `ref`: `gm:<gmail message id>` (the notice is a Gmail message).
- `channel`: `zola`.
- `direction`: `in` for the inquiry, message, closed and unparsed templates; `out` for a Sent row whose In-Reply-To names a stored message notice (the Gmail reply that went through Zola's relay).
- `kind`: `message` for inquiry, message and closed rows; `zola_unread` for an unparsed notice (counted inbound, never AI-closable, the `tt_missed` pattern); `message` with `textBearing` for the outbound reply.
- `author`: `null` on outbound.
- `meta`: `source: 'gm'`, `zolaLeadId`, `template` (`inquiry` | `message` | `closed` | `unparsed`), `leadUuid` when known, `textBearing`.

The parent's normalizer runs unchanged: no gm row ever pairs with an sms, ml or pal row (decision 7 and section 2: the OS's sends never reach Gmail's Sent folder), and ordering stays total by time, source row id, ref.

### 5.2 Who is who

**Email address resolution** (`people.js`, extended): addresses are compared trimmed and lowercased.
1. **Our own addresses never form an item:** every address on the business domain (so the admins, the managers, the no-reply and admin aliases, and the Cowork report), the addresses in `INBOX_OWN_EMAILS` (the older Gmail address of the business, set in Render, never in the repo), and Zola's vendor address.
2. **Clients** by `clients.email`, newest client first when the unique index ever allows two spellings to land on one lowercase form (it does not today; the rule exists so the order is pinned).
3. **Staff**: the same send-eligible set the text route reaches (role staff or manager, onboarding submitted, reviewed or approved, agreement on file), by `users.email`, newest profile first.
4. **Anyone else** is `e-<16 hex>`: the first 16 hex characters of the SHA-256 of the lowercased address. The key carries no address, so page URLs and Sentry events never do (the parent's amendment 42 needs no extension); the address lives in the event's `meta.address` and is shown only on the opened item's card.

**Zola couples** (`people.js`, extended with `zolaLeadsById`): a `zola_leads` row resolves to `c-<client_id>` when linked, else `z-<zola_leads.id>`. The key uses our own serial because the inquiry template carries no Zola id; the lead UUID, when learned, is a column, not the key.

**Person keys** (`personKey.js`): two patterns join the four: `e-[0-9a-f]{16}` and `z-<canonical int4>`, with the same no-leading-zeros and int4 limits as `c-` and `s-`.

**Alias folding** (`aliases.js`, parent amendment 22, two more rules after rule 5):
6. an `e-` key asks the live index at the tap's time and moves when the address now names a client or staffer (an unknown address became a client);
7. a `z-` key follows its lead to the client the lead now belongs to.

**Which mail counts, decided at sync time** (section 5.5) and recorded as the row's `kind` or as no row at all:
- A message with the DRAFT, SPAM or TRASH label is never stored.
- A message from one of our own addresses that is not a Sent message is dropped (the OS's alerts, Cowork's report arriving in Inbox).
- A Sent message whose every recipient is our own address is dropped (the report), and a Sent message to any address at a dropped domain is dropped (a Gmail reply to a Thumbtack notice is a Thumbtack Business message the webhook already records).
- A message from Zola's vendor address is parsed by template (section 5.6); marketing from that address matches no template's subject and is dropped, not stored as unparsed. Unparsed means a subject that matches a template and a body that does not.
- An inbound message from a dropped domain is dropped: `thumbtack.com`, and the code constant `DROPPED_SENDER_DOMAINS` the lane fills from the senders the OS already listens to (Thumbtack) or that only ever notify (Cal.com, Stripe, Twilio, Sentry, Render, Vercel, Google's own notices). The list is code, not env, so a change goes through review.
- An inbound message is a **machine auto-reply** when it carries `Auto-Submitted` other than `no`, `X-Autoreply`, `X-Auto-Response-Suppress`, or `Precedence: auto_reply`. It is stored as `kind: 'auto_reply'` and never counts.
- An inbound message from an address that resolves to a client or staffer counts, whatever Gmail's category.
- An inbound message from anyone else counts only when it passes the **bulk filter**: Gmail placed it in Primary (label `CATEGORY_PERSONAL`), it carries no `List-Unsubscribe` and no `Precedence: bulk | list | junk`, and the sender's local part does not match the no-reply pattern (`no-reply`, `noreply`, `do-not-reply`, `donotreply`, `notifications`, `notification`, `mailer-daemon`, `postmaster`, `alerts`, `newsletter`, case-insensitive, with or without dashes and dots). A message that fails the filter is not stored.
- Everything else inbound is stored as `kind: 'message'`.

The email-lead replies question (parent line 46) is answered by these rules: a marketing lead who replies is an unknown-address person, or a client when their address is on a client row. The marketing leads table is read for the name only (section 4.1 shows the lead's name instead of the bare address when the address is in `email_leads`), and `email_conversations` is neither read nor written.

### 5.3 What counts as them writing

- A stored inbound `message` row from a resolved person counts (parent 5.3's spirit: them writing on any channel).
- A Zola inquiry, message and closed row counts; an unparsed notice counts as `zola_unread`.
- An attachment-only inbound mail counts as `media` and stays waiting until a human acts (parent 5.5 step 3).
- `auto_reply` rows never count.
- Our own addresses never count.

### 5.4 What counts as a reply

- **A Sent mail to the person's address** is a reply, like a Thumbtack Business message: a human always sent it, because the OS never sends through Gmail and the one automated Sent mail (the report) is to ourselves and dropped. `classify.countsAsReply` gets `case 'gm': return true` next to `case 'tt'`, and `isTextBearingReply` returns true for a gm row with words, so the AI reads it for a promise (parent 6.1) and the thread shows it.
- **A Sent mail that answers a Zola message notice** (its In-Reply-To names a stored notice's Message-ID, or its To is an address at Zola's relay subdomain) is a Zola reply on that lead.
- **A Sent mail with several outside recipients** is a reply to each of them: one event per resolved recipient, same ref with a recipient suffix (`gm:<id>:<n>`), so a mail that answers a client and their planner closes both items.
- A reply inside Zola's site is invisible and closes nothing (decision 10).
- The OS's sends keep counting through the message log exactly as today; no gm row ever twins with one.
- A Gmail reply ends a claim, closes the item or holds it when the AI reads it as a holding reply, and sets the anchor like any reply (parent 5.5).

### 5.5 The sync

A scheduler, `gmail_sync`, runs every 60 seconds with a 20-second startup delay, behind `enabled('RUN_GMAIL_SYNC_SCHEDULER')` and an in-flight boolean (the AI read's pattern), on the production instance only (`RUN_SCHEDULERS` rules). With no key it does nothing and the status reads off.

Each tick:
1. Loads the single `gmail_sync_state` row.
2. **First sync** (no history id yet): lists message ids with `q=after:<INBOX_HISTORY_START as YYYY/MM/DD>` across every label (Sent included), pages through, and processes each id; then stores the mailbox's current history id from `users.getProfile`. The first sync may take several ticks; it processes at most `GMAIL_SYNC_MAX_PER_TICK` (constant, 50) messages a tick and keeps its page cursor in the state row.
3. **Steady state:** `history.list` from the stored history id with `historyTypes=messageAdded`, processes each added id, stores the newest history id.
4. **Lost history** (Google answers 404 because the id is older than it keeps, about a week): a resync like step 2 from `last_ok_at` minus one day; the unique Gmail id makes re-processing idempotent.
5. **Processing one message:** fetches it with `format=full`, reads the headers it needs (From, To, Cc, Subject, Date, Message-ID, In-Reply-To, References, Reply-To, List-Unsubscribe, Precedence, Auto-Submitted, X-Autoreply, X-Auto-Response-Suppress) and the label ids, applies section 5.2's rules, extracts the text (section 5.7), parses Zola templates (section 5.6), and inserts one row with `ON CONFLICT (gmail_id) DO NOTHING`.
6. Writes `last_ok_at`, clears `consecutive_errors`.

On any failure the tick stores the error class (never a body, never an address) in `last_error`, bumps `consecutive_errors`, and returns; the next tick retries from the stored id. Three consecutive failures turn the feed line to "Gmail failing" and send one Sentry warning an hour (counts and the error class only). A single message that cannot be parsed (malformed MIME) is skipped with a log line carrying its Gmail id only, and the tick continues.

Every write to `gmail_messages` clears the engine's snapshot cache (`cache.invalidate()`), as every Inbox write does.

### 5.6 Zola parsing and lead capture (`zolaMail.js`, pure; `zolaLeads.js`, writes)

A message from Zola's vendor address is matched on subject:
- `/^New Zola inquiry for /` is an inquiry;
- `/^New message from (.+) for /` is a message, the capture is the couple's label;
- `/^(.+) closed their inquiry$/` is a closed notice, the capture is the label;
- `/^Booked!/` is a booked notice: dropped. It carries no couple label and no lead id, so it cannot be tied to a lead, and the couple's own message thread already carries the booking;
- anything else is Zola marketing and is dropped.

The parser works on the plain-text part (every template carries one) and never on the HTML:
- **Inquiry:** the couple's label is the line before "sent you an inquiry!"; the note is the quoted text under "Their note to you". A wedding date, guest count, budget or location line, when the template carries one, is read by its label ("Getting married", "Guest count", "Wedding budget", "Location"); the lane checks the inquiry's HTML part for those fields once against a real notice and pins what it finds in the fixture builder, by shape.
- **Message:** the label after "Respond to"; the date after "Getting married on"; the message text between the first and last quote after "<name>'s message"; the lead UUID from the first `/inspire/vendors/leads/ready/<uuid>` link.
- **Closed:** the reason after "reason for closing", when present.
A template whose subject matched but whose body yields no words (the inquiry's note, the message's text) is `unparsed`: stored with `kind: 'zola_unparsed'` and `text` null, counted as `zola_unread` (decision 14). An unparsed notice always gets a lead row: by label when the subject carries one (message and closed), else a fresh row labeled "Zola notice" with the mail's Chicago date, so the item exists and "Open in Zola" opens the dashboard. Such a row never creates a client or a draft.

**The lead row.** For each parsed notice the writer finds the lead:
1. by lead UUID when the notice carries one and a row has it;
2. else by couple label, normalized (trimmed, inner whitespace collapsed, case-folded), among rows not closed;
3. else it creates one with the label, the wedding date when known, and the UUID when known.
A message notice that names a UUID fills it on a row found by label. A closed notice stamps `closed_at`. A label that later arrives with a different UUID (two couples with the same label) creates a second row rather than overwriting the UUID; the first row keeps its UUID.

**Client creation** (decision 11; skipped during the backfill, decision 15): a new lead row created from an inquiry that arrived after the feed's switch-on creates a client through `findOrCreateClient` with the couple's label as the name, no email, no phone, `source: 'zola'`, and a note "Zola inquiry, no contact details yet", in the same transaction as the lead row, and stores `client_id` on the lead. `findOrCreateClient` with no email and no phone matches nothing and always creates; the lead row is the idempotency guard (a second inquiry notice for the same label finds the row and creates nothing).

**The draft** (section 8 of this spec's lanes: last): when the lead has a client and a wedding date, and no `proposal_id`, `createDraftProposalFromZolaLead` creates a draft through `insertProposalRecord`: the default package (`the-core-reaction`, flat, service only), `numBars: 0` (the $400 trap, memory `project-thumbtack-autodraft`), guest count 50, duration 4 hours, event type `wedding`, the wedding date at 5:00 PM Central, a default this spec sets (the Thumbtack mapper has none: it reads the time off the lead's timestamp, and a Zola notice carries a date with no time), venue empty, `source: 'zola'`, admin notes carrying the couple's note and the Zola lead link, status `draft`, activity log `created` by `system` with `{ source: 'zola', zola_lead_id }`. It runs after the lead transaction commits, best effort, under `SELECT … FOR UPDATE` on the lead row, like the Thumbtack path. A lead whose date arrives only with a later message notice gets its draft then. The draft cannot be sent from the OS until the client has an email or a phone; the existing "No email on file" confirm on Send already guards that.

`proposals.source` widens to `('thumbtack','zola')` in both sites the schema file keeps (the inline CHECK and the DO block). The proposals list's source filter and badge, which today know `thumbtack`, learn `zola` with the same treatment.

### 5.7 Text extraction (`mailText.js`, pure)

- The text/plain part is preferred; with none, the text/html part is converted: block elements and `<br>` become line breaks, `<blockquote>` content is dropped, tags are stripped, entities decoded, whitespace collapsed to at most one blank line.
- **Quoted history** is cut: everything from the first line matching the reply header patterns (`On <date>, <someone> wrote:`, `From: … Sent: …` Outlook headers, `-----Original Message-----`, `> ` quoted lines at the tail), the parent spec's relay-notice precedent in spirit.
- **Signatures** are cut at `-- ` on its own line and at `Sent from my <device>`; a trailing block of up to 6 short lines that contains a phone number, an address at a domain, or a URL is treated as a signature and cut.
- The result is trimmed. When it comes out empty but the original had words, the untrimmed original (quoted history still cut, signature kept) is stored instead, so a one-line reply that lives inside a signature is not lost.
- Stored text is capped at 20,000 characters.
- Attachments: the count of MIME parts with a filename or `Content-Disposition: attachment`, inline images included.

## 6. The AI read

The parent's read (sections 6.1 to 6.6) runs on email with these differences.

- **Lines.** An email line (channel `email` or `zola`) is pre-clipped at 8,000 characters before redaction and 4,000 after; text lines keep 3,000 and 1,500 (parent amendment 26). The prompt cap stays at 12,000, oldest lines dropped first, so a long email thread shows its newest mails whole.
- **The subject** rides ahead of the body in the slice line, as `Subject: <subject>. <body>`, on inbound email rows and on outbound Gmail rows; Zola rows carry no subject.
- **Attachments** appear as `[attachment]` in the line, once per attachment, never a filename. An attachment-only mail is never read (`isReadableInbound` already refuses `media` rows without words).
- **Auto-replies** never reach the model (they are system rows). The prompt's "automated messages and auto-replies" rule stays for the ones the headers miss.
- **Channel labels** already read `email` and `Zola` (`aiRead.js:136-137`).
- **The solicitation flag** (decision 12). The inbound schema gains `solicitation: boolean`. The system prompt adds, before the "No reply is needed" list: "A solicitation is someone selling to us or asking us for something that is not a booking: a vendor pitch, a sponsorship or partnership ask, recruiting, a survey, a request to list or feature the business. For a solicitation set solicitation true and needs_reply true, and make what_they_need say what they are offering or asking for." The read job stores the flag in `inbox_reads.solicitation` and, when it is true, stores `needs_reply` as true whatever the model said, so the rules need no new branch: the item waits. The row carries `pitch: true` in the list payload when the newest counted inbound's read has the flag.
- **The Zola closed notice** is read like any inbound; the prompt's "declines" rule covers it ("closed their inquiry"), and the need line reads "AI: closed their inquiry on Zola" from the model's reason. No new closer type.
- **Redaction** is unchanged: addresses become `[email]`, digit runs `[number]`, links `[link]`, the surname rule applies to the display name. The redactor already handles every rule email needs; the lane adds fixtures for a signature block and a quoted-address line.
- **Legal hold** (parent amendment 43): the read job's key lookup gains the held client's `e-` key for their email address and the `z-` key of any Zola lead linked to them.
- **Cost.** The mailbox adds a few subjects a day. The daily cap and the pricing note stand.

## 7. Data model

New tables, idempotent in `schema.sql`, with the file's DO-block pattern for every enumerated CHECK:

```sql
CREATE TABLE IF NOT EXISTS gmail_messages (
  id SERIAL PRIMARY KEY,
  gmail_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL CHECK (kind IN ('message','auto_reply','zola_inquiry','zola_message','zola_closed','zola_unparsed')),
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  text TEXT,
  attachments INTEGER NOT NULL DEFAULT 0,
  message_id_header TEXT,
  in_reply_to TEXT,
  zola_lead_id INTEGER REFERENCES zola_leads(id) ON DELETE SET NULL,
  at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_at ON gmail_messages(at);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_thread ON gmail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_from ON gmail_messages(from_address);

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

CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  history_id TEXT,
  backfill_page TEXT,
  backfill_done BOOLEAN NOT NULL DEFAULT false,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inbox_reads ADD COLUMN IF NOT EXISTS solicitation BOOLEAN;
```

- `zola_leads` is created before `gmail_messages` in the file, for the reference.
- `couple_label_key` is the normalized label of section 5.6, kept as a column so the lookup is an index hit and the rule lives in one JS function with the SQL it feeds.
- `to_addresses` holds To and Cc, lowercased.
- `text` is null for an attachment-only mail and for an unparsed Zola notice.
- `proposals.source` CHECK: `(source IS NULL OR source IN ('thumbtack','zola'))`, in both sites.
- No change to `clients`, `email_leads`, `email_conversations`, `message_log` or `sms_messages`.
- The `gmail_sync_state` row is inserted by the first tick (`INSERT … ON CONFLICT DO NOTHING`), never by the schema file.

## 8. API

No new routes. The existing Inbox routes (`server/routes/admin/inbox.js`) carry the new data in their payloads:

- `GET /api/admin/inbox`: `waiting[]` rows gain `pitch` (boolean); `feeds[]` gains the `gmail` and `zola` sources, `gmail` with `status: 'ok' | 'off' | 'failing'` beside `last_at` and `quiet`.
- `GET /api/admin/inbox/:personKey`: accepts `e-` and `z-` keys; the thread rows gain `attachments` (integer) on email rows and keep `subject`; `reply.app` gains `caption`; the context card gains the Zola lead shape (`{ kind: 'zola_lead', couple_label, wedding_date, client_id }`) and the unknown card gains `address` beside `phone`.
- `POST /api/admin/inbox/:personKey/text`: unchanged. An `e-` or `z-` person has no number to text; `resolveTextTarget` answers "Inbox only texts a number that has texted us first." for them, as it does for a `t-` key today, which the page never offers because the reply block's mode is `open`.
- `POST …/seen` and `…/actions` accept the two new key types through `parsePersonKey`.

The badge count includes email and Zola items like any other.

## 9. Changes to existing code

Every file is in `server/utils/inbox/` unless given.

- `personKey.js`: the two patterns.
- `people.js`: own addresses, `clientsByEmail`, `staffByEmail`, `resolveEmail(address)`, `zolaLeadsById`, `zolaKey(lead)`; the loader reads `clients.email`, `users.email` for the staff and operator queries, `zola_leads`, and `email_leads` (id, name, email) for names.
- `aliases.js`: rules 6 and 7.
- `engine.js`: two more header queries in `computeSnapshot`, the two mappers, the warning count; `directoryFor` names `e-` and `z-` keys; `resolveKey` for the item route accepts them.
- `details.js`: the gm details loader (subject, text).
- `classify.js`: `case 'gm'` in `countsAsReply`; `isTextBearingReply` reads `meta.textBearing`; `isCountedInbound` and `aiCannotClose` learn `zola_unread`; `eventNeedText` learns the attachment-only and unread copy; `sliceText` learns the subject prefix and `[attachment]`.
- `reasons.js`: `case 'gm'` with the email and Zola wording.
- `thread.js`: subject and attachments on gm rows, the system line for auto-replies, "by email" captions.
- `reply.js`: `appLinkFor` returns Gmail or Zola links with captions; the Thumbtack caption moves here.
- `context.js` and `contextFormat.js`: the Zola lead card and the address on the unknown card.
- `feeds.js`: the two rows.
- `subjects.js`: nothing; the slice already carries refs and channels.
- `aiRead.js`: the schema field, the prompt paragraph, the per-channel line caps, the subject prefix.
- `readJob.js`: stores `solicitation`, forces `needs_reply` when it is true; the legal-hold key lookup.
- `rules.js`: `pitch` on the waiting row (read from the newest counted inbound's read); nothing else.
- `payload.js`: `pitch`, `attachments`, `app.caption`.
- `constants.js`: `ZOLA_UNREAD_TEXT`, `EMAIL_LINE_MAX`, `GMAIL_SYNC_MAX_PER_TICK`, the dropped-domain and no-reply constants, `zolaLeadUrl()`, `gmailThreadUrl()`.
- New: `readGmail.js`, `readZola.js`, `mailText.js`, `zolaMail.js`, `zolaLeads.js`, `gmailSync.js`, `server/utils/gmailClient.js` (the credentialed client, outside the inbox folder like `anthropicClient.js`), `server/utils/zolaProposalDraft.js`, `scripts/gmail-probe.js`.
- `server/index.js`: the `gmail_sync` scheduler.
- `server/db/schema.sql`: section 7.
- `server/routes/proposals/*` and the proposals list page: `zola` as a source value and badge.
- `client/src/components/inbox/ReplyBar.js`: reads `app.caption`; `inboxFormat.js`: nothing (labels exist); the list row: the Pitch chip; the thread: subject and attachment lines; the item card: the Zola lead and address shapes; the feed line: `off` and `failing` wording.
- `client/src/utils/clientSources.js` and `server/utils/clientSources.js`: nothing (`zola` exists for clients); the proposal source labels gain `zola`.
- `scripts/sensitive-paths.txt`: `server/utils/gmailClient.js`, `server/utils/zolaProposalDraft.js`, `scripts/gmail-probe.js`.

## 10. The Gmail client (`server/utils/gmailClient.js`)

- Reads `GMAIL_SERVICE_ACCOUNT_KEY` (the JSON key, base64-encoded so Render's single-line env holds it) and `GMAIL_MAILBOX` (the address to read as; default `contact@drbartender.com`, the business address, which is already in the repo's docs).
- `isConfigured()` is true when both parse. `createGmailClient()` returns null when not configured; under `NODE_ENV=test` it refuses to build a real client unless a test injects a stub (the Anthropic precedent).
- Token: a JWT with `iss` the service account's email, `sub` the mailbox, `scope` the read-only scope, `aud` Google's token endpoint, signed RS256 with Node's `crypto.sign`; exchanged at `https://oauth2.googleapis.com/token`; cached until 60 seconds before expiry. Hosts are pinned constants (`https://oauth2.googleapis.com`, `https://gmail.googleapis.com`); no env var can redirect them.
- Methods: `getProfile()`, `listMessages({ q, pageToken })`, `listHistory({ startHistoryId, pageToken })`, `getMessage(id)`, `listLabels()`. Each returns `{ data }` or `{ error: { status, class } }`; a 401 or 403 is `GmailAuthError`, a 404 on history is `GmailHistoryGoneError`, a 429 or 5xx is `GmailUnavailableError`. No message body ever appears in an error, a log line or a Sentry event.
- Timeout 20 seconds per call, no retries inside the client (the tick retries next minute).
- The private key never leaves the module and is never logged, not even its length.

**The probe** (`scripts/gmail-probe.js`, tracked, decision 18): run with the key in that command's environment only (`GMAIL_SERVICE_ACCOUNT_KEY=… node scripts/gmail-probe.js`), it calls `getProfile()` and `listLabels()` and prints the address it authenticated as and the label count, nothing else. It is the only Gmail call allowed from the dev box, and it runs once before the key goes into Render. Dallas does the Render step by hand (memory: Render env is his).

## 11. Visual contract

The surface is the shipped Inbox page; the design source is the parent's artifact (`docs/design-artifacts/2026-10-06-inbox/`, the vendored export), whose data file already draws email and Zola items, their thread rows with a subject line, the "Open in Gmail" and "Open in Zola" reply modes, the handled rows with "You emailed back" and "Zul replied in Zola" (both superseded by decision 9: the shipped copy is "Replied by email" and "Replied to Zola by email"), and the Gmail and Zola feed rows. The lane matches those drawings for layout, composition and component vocabulary, in the shipped House Lights rules, and adds two things the artifact does not draw, in the vocabulary it does: the Pitch chip (a muted `StatusChip` after the channel icons) and the attachment count line (the muted subject line's style, under the bubble). `ui-ux-review` on the page lane is pointed at the artifact and judges adherence; usability-clean but off-design is a finding.

## 12. Failure modes

- **Key unset:** the feed is off, the line says "Gmail off", nothing else changes.
- **Delegation revoked or key rotated:** every call is 401; after three ticks the line reads "Gmail failing", Sentry gets a warning an hour; mail that arrives meanwhile is picked up by the resync once the key works again (history, or the dated resync).
- **History too old:** the dated resync of 5.5 step 4.
- **Google unavailable:** the tick returns; the next one retries. No mail is lost; the history id is only advanced after the tick's messages are stored.
- **A Zola template changes:** an unparsed notice becomes a waiting item that says so (decision 14); a subject change drops Zola's mail as marketing, which the Zola feed row shows as going quiet, and a client who writes directly is unaffected.
- **A malformed message:** skipped with its id, the tick continues.
- **A huge mail:** text capped at 20,000 characters at storage; the AI line caps apply on top.
- **An HTML-only mail:** converted (5.7).
- **A Sent mail to nobody we can resolve** (a reply to a dropped domain, to ourselves): dropped by 5.2; a Sent mail to an unknown outside address is stored and forms an outbound-only event under an `e-` key, which the rules leave quiet (no inbound, nothing waits).
- **Two couples with one label:** two lead rows (5.6).
- **A hand-made Zola client already exists for a new inquiry:** a second client row is created with source `zola` and the lead link; the client page shows both, and Dallas merges by hand if he wants. The spec accepts this over a name-matching rule that would mislink.
- **The read job meets a pitch:** the item waits with the tag (decision 12); a wrong tag costs nothing.
- **A client's email changes on their row:** the old address's mail, stored under the old resolution, re-resolves at read time to whatever the index says now (read-time resolution, like phones).
- **The mailbox's own bounce notices** (mailer-daemon): dropped by the no-reply pattern and, for the OS's bounces, by the own-domain rule.

## 13. Configuration, docs and lists

| Variable | Purpose |
|---|---|
| `GMAIL_SERVICE_ACCOUNT_KEY` | Base64 of the service account's JSON key. Server-only, read only by `server/utils/gmailClient.js`. Unset means the Gmail feed is off. Smoke it with `scripts/gmail-probe.js` before Render. |
| `GMAIL_MAILBOX` | The mailbox the feed reads as. Default the business address. |
| `INBOX_OWN_EMAILS` | Optional comma list of extra addresses that are "us" and never form an item (the older Gmail address of the business). Addresses on the business domain are always ours without being listed. |
| `RUN_GMAIL_SYNC_SCHEDULER` | Optional. `false` disables the 60-second Gmail sync. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |

- `.claude/CLAUDE.md` env rows; `.env.example`; `README.md` (folder tree, env table, key features); `ARCHITECTURE.md` (the three tables, the scheduler, the Google integration row, the widened proposal source).
- `scripts/sensitive-paths.txt`: section 9's three files.
- `scripts/money-smoke-list.txt`: unchanged; no money path moves (the draft is status `draft` at the package's flat price, the Thumbtack precedent, already covered by `thumbtackProposalDraft` suites).
- The privacy page already names Google among providers and says messages go to Anthropic without phone numbers, email addresses, or card and account numbers. The lane reads the page's wording once and, if it speaks only of texts, amends it to say messages, and bumps its date. No new provider.
- Fix list: nothing owed from this spec at write time.

## 14. Testing

One suite at a time on the shared dev DB; no TEMP tables; read the pass count. The suites stub the Gmail client; no test ever reaches Google.

**Pure modules, unit tests with invented fixtures:**
- `mailText.test.js`: plain vs HTML, Gmail, Apple Mail and Outlook quote headers, `-- ` and device signatures, the signature-block heuristic, the empty-result fallback, the cap, attachment counting.
- `zolaMail.test.js`: each template built by the fixture builder from an invented couple, the message's UUID and date, the closed reason, marketing dropped, a subject match with an empty body as unparsed, a label with odd spacing normalizing to one key.
- `people.test.js`: own addresses (domain, `INBOX_OWN_EMAILS`, Zola's vendor address), client before staff, the `e-` hash is stable and carries no address, Zola lead to client resolution.
- `personKey.test.js`: the two new patterns, leading zeros and int4 limits on `z-`.
- `aliases.test.js`: rules 6 and 7.
- `readers.test.js`: the two mappers over header rows, the recipient suffix, Sent to a Zola relay resolving to the lead, auto-reply as system.
- `classify` and `rules` suites: a Gmail reply closes, holds when read as holding, ends a claim; `zola_unread` waits and the AI cannot close it; an attachment-only mail waits; a pitch read keeps the item waiting with `pitch: true`.
- `reasons.test.js`, `thread.test.js`, `payload.test.js`, `reply` tests: the wording, the subject and attachment lines, the captions, the Zola URL fallback.
- `aiRead.test.js`: the schema accepts `solicitation`, the line caps by channel, the subject prefix, `[attachment]`; `readJob.test.js`: `needs_reply` forced true on a solicitation, the legal-hold keys include `e-` and `z-`.
- `gmailSync.test.js`: first sync pages and stores the history id, steady state from a history id, 404 triggers the dated resync, the bulk filter and drop rules decide storage, idempotent re-processing, error class stored without content, consecutive error count.
- `gmailClient.test.js`: refuses to build under test without a stub, null when unconfigured, the token request's shape (sub, scope, aud) against a stubbed fetch, pinned hosts, error classes by status, no key material in any error.
- `zolaLeads.test.js`: find by UUID, by label, create; UUID filled on a label match; a second couple with the same label gets a second row; client created only for post-switch-on inquiries; closed stamps the row.
- `zolaProposalDraft.test.js`: the draft's shape (package, `numBars` 0, date and time, source, notes), idempotent under the lead's `proposal_id`, best effort after the lead commit; `proposals/crud.test.js` for the widened CHECK.

**Acceptance on prod, by the lane after the key is in Render (the parent's lane inbox-engine precedent):** the feed line turns on; the backfill completes; a known client's recent email thread shows on their item with the right subject and no quoted history; a Sent reply shows as "Replied by email" in Recently handled; a Zola thread shows as a lead item with "Open in Zola" opening the lead page; the Gmail link opens the thread on the phone (the Gmail app) and the desktop, with a fallback URL form if the `authuser` form does not (the parent's amendment 17 pattern); no admin alert, no Thumbtack notice and no newsletter formed an item.

Suites a change reaches (memory): the whole `server/utils/inbox/` set, `server/routes/admin/inbox.test.js` if present, `proposals/crud.test.js`, `clientDedup` tests, `thumbtackProposalDraft.test.js` (shared insert), and the client build (`CI=true react-scripts build`).

## 15. Review level

Full fleet on every lane: `server/utils/inbox/**` and `schema.sql` are sensitive; `gmailClient.js` holds a credential; `zolaLeads.js` and `zolaProposalDraft.js` create client and proposal records from parsed mail. Plus the second opinion at push, per the push model. The design-stage fleet (`/review-spec`) runs on this document before the plan is written, and `/review-plan` on the plan.

## 16. Rollout and lanes

Lanes, in dependency order; the plan writes footprints and the parallelism graph:
1. **gmail-client:** `gmailClient.js`, the probe, env rows, docs, sensitive list. Dark: nothing calls it yet.
2. **email-feed** (after 1): schema (all three tables, the reads column), `gmailSync.js`, `mailText.js`, the people index, keys, aliases, the two readers, details, classify, reasons, thread, reply, context, feeds, payload, the scheduler, the client's list chip, thread lines, captions, feed wording. Zola rows are stored by this lane (the parser is lane 3, so until lane 3 merges Zola mail is stored as `zola_unparsed` and shows as unread items, which is the decision 14 fallback, acceptable for the hours between merges, and the two lanes merge together before any push).
3. **zola-leads** (after 2): `zolaMail.js`, `zolaLeads.js`, the lead card, "Open in Zola", the backfill rule.
4. **email-ai** (after 2, parallel with 3): the schema field, the prompt, the caps, the subject, attachments, the solicitation store rule, legal-hold keys, the Pitch tag end to end.
5. **zola-draft** (after 3): `zolaProposalDraft.js`, the CHECK, the list badge and filter.

Switch-on, after the push that carries lanes 1 to 4 at least:
1. Dallas runs the probe once with the key in that command's environment; it prints the business address.
2. Dallas sets the key in Render, and the own-addresses list for the older Gmail address. The next deploy's first tick starts the backfill from the history floor.
3. The feed line turns on; the acceptance list of section 14 is walked.
4. The first real Zola inquiry after switch-on proves the parser, the client creation and, once lane 5 is in, the draft.
5. `walkthroughs-owed.md` gains the email and Zola walk: a client email, a reply from Gmail, a Zola thread, a pitch.

## 17. Amendments from planning

None yet. The plan adds them here, numbered, as the parent spec does.
