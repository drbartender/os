# Proposal link into the Thumbtack thread, sent through Google Voice

- **Date:** 2026-10-17 (rev 3: the builder check, the three-agent spec fleet and the rev 2 re-verify are folded in)
- **Status:** Design approved in conversation (Dallas, "looks good"). Spike first, then plan.
- **Surface:** server proposal sends, the proposal page, and a new box-side Google Voice sender

## 1. Why

Thumbtack customers keep saying they never got the proposal, or didn't see it. Dallas: "Thumbtack erroneously tells its users that they don't share the email with pros." They aren't expecting email from us, and they're watching the Thumbtack app.

Measured on prod over the 60 days before 2026-10-16:

- 163 Thumbtack proposals sent. Email delivered 157 of 160 (3 bounced). The proposal text (`message_log` sms `initial_proposal`, 162 sends) was `delivered` per Twilio, 162 of 162.
- Since 2026-06-08 the phone we store for every Thumbtack lead is a per-lead Thumbtack relay number (`server/utils/smsInbound.js` `THUMBTACK_PROXY_ROLLOUT`, `findThumbtackProxyLead`; spec `2026-06-11-thumbtack-comms-noise-design.md`). Twilio "delivered" only means the relay accepted it.
- None of those 162 texts appear in the Thumbtack thread (`thumbtack_messages`). The only copy of our wording there arrived over an hour later and looks hand-pasted.
- A proposal link was pasted into a thread by hand 23 times. In 19 of those our email and text had already gone out, and 7 came within the first hour. The other 4 came before our send or with no automated text.
- Dallas's Google Voice replies DO land in the thread. Thumbtack routes pro texts through the primary business number, which is the GV line. The toll-free 888 is only a registered number. Our working theory is that this is why 888 texts never show in the app. It is not verified.

Mapping, verified on lead 475 / proposal 948. The GV notice "replied to you on Thumbtack ... use this number to communicate with them directly" links `/request/{request}/bids/{bid}/messages`. Here `bid` equals `thumbtack_leads.negotiation_id`, and `request` is in the lead's `raw_payload`. Our 888 got the identical notice from the number stored on that lead. So each customer is one GV conversation under the Thumbtack number we already store as `clients.phone`.

## 2. What it does

When an admin sends or resends a proposal to a client who passes the identity rule (law 1), the box sends the proposal text through Google Voice into that customer's conversation instead of the 888. It lands in the Thumbtack thread and on the customer's phone, the same way Dallas's own GV replies do. It also shows in Dallas's GV history. If the GV post definitely did not happen, today's 888 text goes out instead, so a dead sender is never worse than today.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every admin-sent proposal for a relay client reaches the Thumbtack thread within about a minute, with no human step.
- Proof of landing comes from Thumbtack's own message feed, not the box's word.
- When the sender is down, relay clients still get today's 888 text, and Dallas hears about the outage once.

**Non-goals**
- Moving first replies off Thumbtack UI automation. The sender is built so they can move later. Not now.
- The options (group) send. It has no text channel today, and it accounted for 1 of the 163 sends. Known gap.
- The website quote wizard (`routes/proposals/public.js` also calls `sendProposalSentEmail`, with the phone the client typed). It never queues a GV post and keeps today's behavior.
- The other automated texts that also go 888 to relay: drips (touches 3 and 5 carry the link too), sign+pay confirmation, nudges, event-eve, balance reminders, payment reminders, the payment-failure SMS. Same unknown delivery, known gap, out of scope.
- Reading GV for the Inbox. The session is shared later; this build only sends.

**Anti-goals (a failure even if it technically works)**
- Any new automation of Thumbtack's own site for this. Dallas: "I don't want to get busted for using automation on TT."
- A proposal link landing in another customer's thread. A token link is bearer access to the client's details and to sign-and-pay.
- A double post: after a human paste ("If the automation is slow or we see an error we just do it and then deal with the automation later"), on the box's own retry, or from stacked sends.
- Volume that puts Dallas's personal Google account at risk.
- A failure that blocks or delays the email, or breaks the proposal send.

## 4. Decisions

Dallas's:
- Post through a logged-in Google Voice session, not the Thumbtack API or UI. The Thumbtack partner API needs approval Thumbtack has not given, and webhooks are receive-only.
- No elaborate human fallback. When a post fails, the team pastes the link by hand.
- The playback was approved as a whole ("looks good").

My calls (the approved playback plus the review folds):
- **Wording:** the proposal text as it stands, so `smsTemplates.initialProposalSms` or the admin's edited SMS body from the SendModal.
- **It replaces the 888 proposal text for relay clients.** Everyone else keeps the 888 text, and email is unchanged for everyone. When the GV post definitely did not happen (law 5), the 888 text goes out instead.
- **Triggers:** admin initial send (`routes/proposals/lifecycle.js`, `crud.js`, both through `sendProposalSentEmail`) and send/resend from the SendModal (`comms/actions/proposalResend.js` dispatch, also used by `proposalSend.js`).
- **The SendModal's Text box controls it.** Unticked means no post, same as today's text.
- **No message_log rows for GV posts.** Their states don't fit its CHECKs. The queue row is the ledger, and the proposal page shows it (section 6).
- **Failure visibility:** a status row on the proposal page. No alert per failure. One email per sender outage.
- **If spike check 3 fails** (a new GV conversation to a relay number doesn't land), GV posts go only where a thread exists. The box reports `no_thread` and the 888 text goes out (law 5). There is no second round trip.
- **Accepted risk:** the GV line lives on Dallas's personal Google account, dallasraby@ (it must never move; memory `reference-gv-312-lives-on-personal`). Admin alerts and call forwarding run through it, and that account also holds the box's nightly restic backups (`gdrive:`). Google discourages automated use. One-to-one posts under hard caps (law 7) at our volume are low risk. Raised 2026-10-16; Dallas chose GV.

## 5. Laws

1. **Identity rule (no wrong customer).** A GV post is queued only when all of these hold:
   - It is an admin send at one of the triggers above.
   - The target number is the proposal client's stored `clients.phone`, never a request value.
   - That number matches (last 10 digits) at least one post-rollout `thumbtack_leads.customer_phone`, and EVERY such lead belongs to the proposal's client (`thumbtack_leads.client_id`).
   - The negotiation is the lead linked to the proposal (`thumbtack_leads.proposal_id`). Otherwise it is that client's newest lead on the number, and only when exactly one such lead exists. Either way the chosen lead must itself carry `clients.phone` and be under 180 days old, a backstop against a recycled relay number.

   Any mismatch or ambiguity means no GV post and today's 888 text. The lease re-checks the rule. Reuse the rollout constant: import `THUMBTACK_PROXY_ROLLOUT` from `server/utils/inbox/constants.js`, since `smsInbound.js` does not export it and `inbox/personKey.test.js` allows only one top-level declaration. Changing `findThumbtackProxyLead`'s return shape touches `routes/sms.js`, `routes/proposals/publicToken.js`, its internal caller in `smsInbound.js` and `smsInbound.test.js`, so use a sibling helper.
2. **Kill switch.** `GV_PROPOSAL_POST_ENABLED`, parsed as `=== 'true'` and dark by default. Off means no enqueue (today's 888 text) AND the lease endpoint returns `[]`, so the box idles on its next poll. The server sweep is NOT gated: rows already queued drain to the 888 fallback. Off restores exactly today's behavior.
3. **Notifications gate.** The enqueue honors `SEND_NOTIFICATIONS` like `sendSMS` (log and skip when off), so a lane, dev server or test suite on the shared dev DB never creates a real post.
4. **At most once.**
   - The box journals the row id before clicking Send and never sends a journaled id. This is the first-reply agent's never-send-twice guard (`thumbtack-agent/src/index.js` `loadSentJournal`/`journalSend`).
   - The server never re-offers a row once it has been leased. A lease that passes its window unreported becomes `unknown`.
   - One open row per proposal (a partial unique index over the open states). A second send while one is open merges into it. A resend after the row is terminal makes a new row, because a resend is intentional.
5. **Fallback only when it definitely didn't happen.** The 888 text goes out for:
   - `stale`: never leased in time.
   - `failed_preclick`, with a whitelisted reason: no_thread, wrong_thread, invalid_body, invalid_number, session_expired, challenge, cap, identity_mismatch (law 1 failed at lease), timeout (the box abandoned the job before Send inside the lease window), ui_error_before_send.
   - An enqueue or relay-detection error at send time, which fails open to today's text and goes to Sentry.

   It NEVER goes out for `sent`, `clicked_unverified`, `unknown` or `skipped_already_posted`, since any of those may mean the link is already in the thread. The fallback re-checks law 8 at the moment it sends, since it can fire minutes after the original send. A law 8 rejection at lease (archived proposal, opted-out client) ends the row as `cancelled`, with no fallback.
6. **No double post with a human.** The lease skips a row (`skipped_already_posted`) when `thumbtack_messages` on ANY negotiation whose lead carries that number holds the proposal token, from 30 minutes before the send onward, which covers a paste made just before the send. The box re-checks the open GV thread for the token before typing. Match on the token, not the full URL, to survive `www.`, slashes, the trailing period and other URL forms. Don't require `from_type='Business'`: the legacy parse branch stores NULL. A residual race of seconds is acceptable; minutes are not.
7. **Volume caps.** A server rolling-24h cap on posts (default 25, parsed through `envInt.js` so 0, blank or nonsense fall back), a box-side daily cap, and no two posts to the same number within 10 minutes. At the cap, the post fails as `cap` (the 888 text goes out) with one throttled Sentry warning.
8. **Suppression.** A GV post needs:
   - a proposal still in a sendable status (re-checked at lease: not archived, still in the send/RESENDABLE set);
   - `communication_preferences.sms_enabled !== false`;
   - no per-number `sms_optouts` record.

   The swap sits after the existing suppression (`shouldSendImmediate`, `smsAllowed`) and inside the `wantSms` branch. So the Text box, the opt-outs and today's `phone_status = 'bad'` block all carry over unchanged (0 of the 163 relay clients had a bad phone). The lease re-checks the same rules.
9. **Box validation before typing:**
   - the body holds exactly one `/proposal/<uuid>` link on the public host, is one line, and is at most 320 characters. The server collapses line breaks to spaces at enqueue, and the box inserts the text in one go, never key by key, because Enter sends in GV. The SendModal enforces the same 320 limit for relay clients;
   - the number is US E.164;
   - the thread is one-to-one with exactly that number (no group MMS, no contact autocomplete);
   - an existing thread whose Thumbtack notice names a different bid fails as `wrong_thread`.

   Any of these failing counts as `failed_preclick`.
10. **A failure never touches the email or the proposal's state.** The GV post is post-commit and best-effort.
11. **Privacy.**
    - No phone numbers in logs, UI or diag file names beyond last-4.
    - Queue rows store client, lead and negotiation ids; the number is never stored and is resolved at lease. Queue rows are kept: the proposal token in their body already lives in `thumbtack_messages`, and the Inbox needs the rows to read old sends (plan decision 6). Diag captures are pruned by age (30 days) and count (40).
    - The GV profile is a credential for Dallas's whole personal Google account: Playwright's defaults store cookies under a fixed key, not the keyring. Its directory is mode 700, the WHOLE profile stays out of restic (costing one re-login after a restore), and diag captures are excluded too.
    - A separate agent secret (`GV_AGENT_SECRET`), not `THUMBTACK_AGENT_SECRET`, with its own blast-radius and leak-response line. A leaked secret reads pending post bodies (proposal tokens) and can mark rows.
12. **No client PII in repo docs or commits.**

## 6. How it works

**Queue and states (server).**
- A queue table of GV posts.
- The states: `queued`, `leased`, `sent`, `clicked_unverified`, `failed_preclick` (plus reason), `skipped_already_posted`, `stale`, `unknown`, `cancelled`.
- Terminal states never change after they are set. A late or duplicate report for a row not in `leased` is ignored and logged. Report reasons are whitelisted, the same way `FIRST_REPLY_FAIL_REASONS` is.
- **Confirmation is derived at read time**, not written by the webhook. A row is "in the thread" when a `thumbtack_messages` row on its negotiation contains its token and matches the posted body (normalized). A link-only match without the body is a human paste. That reads as "already posted by hand", never as confirmation, so a hand paste can't hide a broken sender. Deriving at read time also avoids a confirm step inside the `/messages` webhook, where a throw would 500 a stored message and Thumbtack's retry would answer "duplicate".

**Sweep (server, 60 s).** `RUN_GV_POST_SWEEP_SCHEDULER`, honored only with `RUN_SCHEDULERS`, not gated by the kill switch.
- `queued` past the stale window (default 5 minutes) becomes `stale` and the 888 fallback sends.
- `leased` past the lease window (default 3 minutes) unreported becomes `unknown`.
- Liveness trips when rows go stale with no successful lease in the last 30 minutes, OR three jobs in a row end `failed_preclick` (other than `cap` or `no_thread`). Either way one admin email per outage episode says the GV sender is down and Thumbtack customers are getting the toll-free text. The status endpoint's session/challenge email shares the same episode key, so an outage sends one email, not two. The episode resets on the next successful send.
- Prunes no queue rows (law 11).

**Agent endpoints (server).** In a new route file with its own rate limiter, mounted under its own prefix. Not under `/api/admin/thumbtack`, where `thumbtackAgent.js`'s `router.use(agentLimiter)` would still apply. `thumbtackAgent.js` is 772 lines, and its per-IP limiter of 40 per minute is shared with the first-reply poll from the same box. Auth is `GV_AGENT_SECRET`, timing-safe and fail-closed.
- **lease**: returns `[]` when the flag is off. Re-validates law 1, law 6, law 7 and law 8, with outcomes identity_mismatch (fallback), skipped_already_posted, cap (fallback) and cancelled. Returns the row id, number, body, and the expected negotiation id for the `wrong_thread` check. The notice's bid id is the negotiation id, so the request id isn't needed (plan decision 1). The lease window must exceed the box's per-job budget. A job the box can't finish in time is abandoned before Send and reported as `timeout`.
- **report**: takes `sent`, `clicked_unverified`, `failed_preclick` (reason) or `skipped_already_posted`.
- **status**: takes `session_expired` or `challenge` and sends one admin email per episode under a single dedupe key, email only. "Like the harvester" does not hold: its dedupe is per negotiation and lasts 10 minutes.

**Proposal page.**
- A "Thumbtack message" status row on `ProposalDetail` (precedent: the `first_reply` row, `ProposalDetail.js:565`, built in `routes/proposals/getOne.js`), as its own component, since ProposalDetail is 971 lines against the 1000 cap. Copy for each state:
  - queued
  - sent
  - in the thread
  - sent but not in the thread yet
  - "clicked Send but couldn't confirm: check the thread before pasting"
  - skipped because the link was already in the thread
  - "didn't go out: the toll-free text went instead" (with the reason)
- Last-4 only. It polls while the row is not terminal.

**SendModal.** For a relay client the Text row reads "Text via Thumbtack (GV)" with last-4. If an edited body drops the proposal link, the modal blocks with "The text must include the proposal link." The result shows "queued for Thumbtack": `describeSendResult` (`client/src/components/SendModal/sendResult.js`) gains a queued branch, so a text-only send no longer toasts "Done. No message was sent." `renderChannelResult` in `SendModal.jsx` gets the same queued branch, since it shows anything that isn't sent or failed as "Text skipped". `resolveRecipient` carries a relay flag (`resolveFromRow` stays sync), the label follows the kill switch, and the modal caps a relay client's text at 320 characters to match law 9.

**Consumers (accepted or handled).**
- Inbox (`server/utils/inbox/**`, a sensitive path): the GV echo gets its own flag. Not `autoFirstReply`, which would make it a holding reply labeled "Auto first reply". A matched echo counts as delivery of its proposal send, so a text-only send or a client with no email still reads as sent, never "No email or text went out" (`thread.js`). The 888 fallback row and the GV post count toward their send by proposal id, whatever the 5-minute absorb window says (`PROPOSAL_ABSORB_MINUTES`). A matched echo is absorbed into its send when that send's record is within 2 minutes of the post; otherwise it stays a counted reply, as a Business message counts today (plan Task 12).
- No new writer of `initial_proposal` or `proposal_sent_sms`. The 888 fallback reuses the existing pinned send sites; `answeringMessageTypes.test.js` counts call sites, so even a second literal in the same file breaks it. The queue row stores `sent_by` and which send path made it.
- Accepted: the admin Messages thread (`sms_messages`, ClientConversation) won't show the GV post. Contact history and "last contacted" won't count it, though the email row still counts.
- The 888 fallback writes `message_log` and `sms_messages` exactly as today.

**Box.**
- A new systemd user service with its own persistent profile, separate from `thumbtack-agent`, so a GV hang never blocks first replies or the harvest. It runs headful under Xvfb (memory `reference-tt-agent-chrome-env`: the OZONE_PLATFORM=x11 trap).
- Per job:
  1. Validate (law 9).
  2. Open the one-to-one thread for the number, existing or new.
  3. Check it for the token (law 6).
  4. Journal the row id.
  5. Type the body and click Send.
  6. Verify the message shows as sent in that thread.
  7. Report, retrying the report as needed (the journal means it never re-sends).
- Clicked but not verified reports `clicked_unverified`, never a plain failure.
- Any Google interstitial idles the sender without attempting a login: sign-in, verify-it's-you, captcha, unusual activity, the account chooser. It reports `session_expired` or `challenge` once, then resumes when the next poll finds it logged in after Dallas signs in by hand.
- It saves a diag capture (screenshot plus control dump) on definitive failures, the same pattern that made each Thumbtack UI break a 10-minute diagnosis. Captures are pruned, use fs-safe names, and are excluded from restic.
- Human pacing, with a box daily cap.

**Observability.**
- Sentry: stale, clicked_unverified, unknown, failed_preclick, session/challenge, cap reached, and enqueue errors that fell open.
- Server log lines for enqueue, lease, report and sweep, with numbers at last-4.

## 7. Step 0: spike (go/no-go before the plan)

Throwaway. It needs Dallas twice: to sign GV into a fresh profile on the box, and to pick the lead who gets the first real message (an outward send to a real customer).

It proves:
1. The box can send from GV's web UI under Xvfb on a persisted session.
2. The message lands in the Thumbtack thread, both as a `thumbtack_messages` row via the webhook and on the customer side.
3. A new conversation to a relay number with no GV thread lands too.
4. Timing from enqueue to thread, including how fast the webhook delivers our message.
5. The body of about 250 characters arrives as one message with the link intact (it straddles a segment boundary).
6. A first GV text to a relay draws no access-code challenge.
7. Where possible, which negotiation a repeat customer's post lands in, and what texting a relay number that no longer maps to us does.

If (2) fails, stop and come back to Dallas; the design rests on it. If (3) fails, take section 4's no_thread path.

## 8. Left to the builder

- Table, column and env names. Default windows: stale 5 min, lease 3 min, cap 25/day, spacing 10 min, paste-before window 30 min.
- Exact status copy within the states above, and the report-reason list beyond the named ones.
- The new box directory's name and its systemd unit.

## 9. Docs and box-side changes the plan must carry

- CLAUDE.md: env table (`GV_PROPOSAL_POST_ENABLED`, `GV_AGENT_SECRET` with blast radius and leak response, the sweep flag, the caps and windows) and Tech Stack (Google Voice web automation).
- README: env table, tech stack, folder tree, key features. ARCHITECTURE: route table, schema, third-party integrations. `.env.example`.
- Box, outside the repo: the systemd unit, `~/.config/restic/excludes.txt` (the whole GV profile), the profile directory at mode 700.

## 10. Spike results (2026-10-17): GO

One approved post, to lead 471 / proposal 943. The customer had never opened the proposal and had no GV conversation, so it was the new-conversation case. Sent from the box's GV profile under Xvfb (the `thumbtack-agent` launch recipe: `channel: 'chrome'`, env scrub, `OZONE_PLATFORM=x11`).

| Check | Result |
|---|---|
| 1. GV web send on a persisted session, no window | Pass. Verified in the GV conversation 1 s after the click. |
| 2. Lands in the Thumbtack thread | Pass. A `thumbtack_messages` row, `from_type` Business, exact body. |
| 3. A new conversation to a relay number | Pass. There was no prior GV thread. |
| 4. Timing | Thumbtack `sent_at` was 3 s after the click; our webhook stored it at 13 s. |
| 5. Body intact (248 chars, link across a segment boundary) | Pass. One message, byte-exact. |
| 6. No access-code challenge | Pass. It went straight into the thread. |
| 7. Repeat customer / recycled relay | Not exercised; no case available. Law 1 covers it. |

What the build must carry (the GV web UI as of 2026-10-17):
- **Sign-in.** A manual stock-Chrome launch on the desktop, not Playwright: `google-chrome --user-data-dir=<profile> --password-store=basic --use-mock-keychain`. Sign into the GV site and decline Chrome sync. The cookies land as `v10`, readable by the automated launch.
- **The call-dialer trap.** `input` "Enter a name or number" lives in the **Call panel** region, the dialer. The first spike run typed the number there and pressed Enter. GV's call log showed no call placed, and the send stayed disabled, so it aborted. The sender must never touch the Call panel, and it asserts that the panel's input is empty before Send.
- **Recipient.** Click "Send new message". Then, in the region "Select recipients", use the `input` "Type a name or phone number". A one-go fill does NOT trigger suggestions; type key by key. GV then shows a `gv-contact-list` entry, "Send to (number)", plus a screen-reader-only twin, so filter by a rendered size above 4 px. Click exactly one such entry. Verify exactly one `button[aria-label^="Remove"]` chip carrying the number, with the input emptied. Enter in the recipient field does not add the number.
- **Body.** `textarea` "Type a message", filled in one go. Send is `button[aria-label="Send message"]`, which stays disabled until a recipient exists.
- **Verify.** The token visible in a message bubble and the textarea emptied.
- **Claude's own permission gate.** Claude Code's auto-mode safety check refused to let a Claude session send a real message. Dallas ran the send himself. Production is a standalone service and doesn't go through that gate, but any future live test from a Claude session needs Dallas to run it.
