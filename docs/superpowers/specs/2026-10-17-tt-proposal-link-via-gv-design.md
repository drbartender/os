# Proposal link into the Thumbtack thread, sent through Google Voice

- **Date:** 2026-10-17
- **Status:** Design approved in conversation (Dallas, "looks good"). Spike first, then plan.
- **Surface:** server proposal sends + a new box-side Google Voice sender

## 1. Why

Thumbtack customers keep saying they never got the proposal, or didn't see it. Dallas: "Thumbtack erroneously tells its users that they don't share the email with pros." They aren't expecting email from us, and they're watching the Thumbtack app.

Measured on prod over the 60 days before 2026-10-16:

- 163 Thumbtack proposals sent. Email delivered 157 of 160 (3 bounced). The proposal text (`message_log` sms `initial_proposal`, 162 sends) was `delivered` per Twilio, 162 of 162.
- Since 2026-06-08 the phone we store for every Thumbtack lead is a per-lead Thumbtack relay number (`server/utils/smsInbound.js` `THUMBTACK_PROXY_ROLLOUT`, `findThumbtackProxyLead`; spec `2026-06-11-thumbtack-comms-noise-design.md`). Twilio "delivered" only means the relay accepted it.
- None of those 162 texts appear in the Thumbtack thread (`thumbtack_messages`). The only copy of our wording there arrived over an hour later and looks hand-pasted.
- A proposal link was pasted into a thread by hand 23 times. In 19 of those our email and text had already gone out, and 7 came within the first hour.
- Dallas's Google Voice replies DO land in the thread. Thumbtack routes pro texts through the primary business number, which is the GV line. The toll-free 888 is only a registered number. Our working theory is that this is why 888 texts never show in the app. It is not verified.

Mapping, verified on lead 475 / proposal 948. The GV notice "replied to you on Thumbtack ... use this number to communicate with them directly" links `/request/{request}/bids/{bid}/messages`. Here `bid` equals `thumbtack_leads.negotiation_id`, and `request` is in the lead's `raw_payload`. Our 888 got the identical notice from the number stored on that lead. So each customer is one GV conversation under the Thumbtack number we already store as `clients.phone`.

## 2. What it does

When a proposal link goes out to a client whose phone is a Thumbtack relay number, the box sends that link through Google Voice into that customer's conversation. It lands in the Thumbtack thread and on the customer's phone, the same way Dallas's own GV replies do. It also shows in Dallas's GV history.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every proposal link for a Thumbtack-relay client reaches the Thumbtack thread within about a minute of the send, with no human step.
- Proof of landing comes from Thumbtack's own message feed, not the box's word.

**Non-goals**
- Moving first replies off Thumbtack UI automation. The sender is built so they can move later. Not now.
- The other automated texts that also go 888 to relay: drips, sign+pay confirmation, nudges, event-eve, balance reminders. Same unknown delivery, known gap, out of scope.
- Reading GV for the Inbox. The session is shared later; this build only sends.

**Anti-goals (a failure even if it technically works)**
- Any new automation of Thumbtack's own site for this. Dallas: "I don't want to get busted for using automation on TT."
- A double post after a human already pasted the link. Dallas: "If the automation is slow or we see an error we just do it and then deal with the automation later." The automation must notice and stand down.
- A post landing in the wrong customer's conversation.
- A failure that blocks or delays the email, or breaks the proposal send.

## 4. Decisions

Dallas's:
- Post through a logged-in Google Voice session, not the Thumbtack API or UI. The Thumbtack partner API needs approval Thumbtack has not given, and webhooks are receive-only.
- No elaborate fallback. On failure the team pastes the link by hand.
- The playback below was approved as a whole ("looks good").

My calls, in the approved playback:
- **Wording:** same as today's proposal text (`smsTemplates.initialProposalSms`): "Hi, Dallas here. Just sent your proposal for the ... Review the details and check out here: (link) ..."
- **It replaces the 888 proposal text for relay clients.** Everyone else keeps the 888 text. Email is unchanged for everyone.
- **Triggers:** every path that sends a proposal link today: initial send, resend, and the options (group) send. The group send is email-only today; for relay clients it gains the GV post with the options link, in the same voice.
- **Freshness:** a post that hasn't gone out within a few minutes of the send is dropped as stale.
- **Failure visibility:** shown on the proposal's existing message history. No email or SMS alert per failure.
- **Accepted risk:** the GV line lives on Dallas's personal Google account (it must never move; memory `reference-gv-312-lives-on-personal`) and carries admin alerts and call forwarding. Google discourages automated use. One-to-one posts at our volume are low risk. Raised 2026-10-16; Dallas chose GV.

## 5. Laws (constraints)

1. **"Relay client" means the phone is a Thumbtack relay number** (`findThumbtackProxyLead` matches), not `source = 'thumbtack'`. Pre-2026-06-08 leads hold real numbers and keep the 888 text. So does a client who later gave a real number.
2. **Flag off means exactly today's behavior.** A dark kill switch (default OFF). With it off, relay clients get the 888 text as now. Rollback is flipping it off.
3. **Fail closed, never guess.** When the box can't positively identify the conversation for the number, or can't verify the send, it reports failure. Same law as the first-reply agent (memory `project-tt-auto-first-reply`).
4. **Never double-post.** Before sending, check `thumbtack_messages` for a Business message on that lead's `negotiation_id` that contains the proposal link, posted after the send. If one exists, skip. A residual race of seconds is acceptable; minutes are not.
5. **A failure never touches the email or the proposal's state.** The GV post is post-commit and best-effort.
6. **No phone numbers in logs, UI, or diag file names** beyond last-4. Diag screenshots stay out of the restic backup, like `~/.thumbtack-profile/diag`.
7. **Ledger every attempt** in `message_log` (sent, failed, skipped-as-already-posted, stale), so it shows on the proposal's message history.
8. **No client PII in repo docs or commits.**

## 6. How it works

**Server**
- At each proposal-text choke point, a relay client with the flag on gets a queued GV post instead of the Twilio send. The choke points are the SMS leg of `server/utils/sendProposalSentEmail.js` (called from `routes/proposals/lifecycle.js` and `routes/proposals/crud.js`; this path wrote all 162 `initial_proposal` texts), the SMS leg of `server/utils/comms/actions/proposalResend.js` dispatch (also used by `proposalSend.js`), and `proposalSendGroup.js`.
- A queue of pending GV posts: proposal, lead/negotiation, number, body, status, attempts, timestamps. Agent endpoints lease and report, authenticated like the existing box agent (`server/routes/thumbtackAgent.js`: lease with `FOR UPDATE SKIP LOCKED`, fail-closed agent secret). The lease refuses stale or already-posted rows (law 4).
- Confirmation: the Thumbtack messages webhook (`server/routes/thumbtack.js`) already stores thread messages. When a Business message on the lead's `negotiation_id` contains the posted link, mark the post confirmed. Sent but never echoed within a window means unconfirmed, shown as such.

**Box**
- A Google Voice sender with its own persistent browser profile, logged in once by Dallas. It runs headful under Xvfb like `thumbtack-agent` (memory `reference-tt-agent-chrome-env`: the OZONE_PLATFORM=x11 trap applies). It polls the lease endpoint, opens the conversation for the number, types the body, sends, verifies the message shows as sent in that GV conversation, and reports. On a definitive failure it saves a diag capture (screenshot plus control dump), the same pattern that made each Thumbtack UI break a 10-minute diagnosis.
- **A conversation may not exist yet.** GV only has a thread with the relay number once Thumbtack has relayed something to GV. The proposal often goes out before the customer has replied, so the sender must start a new conversation to the number when none exists.
- An expired session reports `session_expired` once and stops (one email to admin, like the harvester). It never attempts an automated login.

## 7. Step 0: spike (go/no-go before the plan)

Throwaway. It needs Dallas twice: to sign GV into a fresh profile on the box, and to pick the lead who gets the first real message (an outward send to a real customer).

It proves:
1. The box can send from GV's web UI under Xvfb on a persisted session.
2. The message lands in the Thumbtack thread, both as a `thumbtack_messages` Business row via the webhook and on the customer side.
3. Starting a new conversation to a relay number with no GV thread works and lands too.
4. Timing from enqueue to thread.

If (2) fails, stop and come back to Dallas. The design rests on it.

## 8. Left to the builder

- Whether the sender is an arm of `thumbtack-agent` or its own service. Recommendation: its own systemd service and profile, so a GV hang never blocks first replies or the harvest.
- The queue's shape: a new table vs columns, the env names, and the stale/confirm windows (defaults around 10 minutes).
- Agent auth: reuse `THUMBTACK_AGENT_SECRET` or a new secret.
- How the GV post shows in the SendModal result: "queued" is enough, with the real status on the message history.
- How the ledger rows map onto `message_log` channel and status values within the existing CHECK constraints.
- Wording for the options (group) post.
