# Phone System Redesign: real-feeling numbers, one smart voicemail, AI triage (design)

Date: 2026-07-26
Revision: 3 (rev 3 folds in the /review-spec fleet. Key hardening: R2 becomes the
retry SOURCE, not just the archive, so the existing Twilio-based redelivery sweep
keeps working after the Twilio copy is deleted; the whole flow becomes line-aware
and existing rows are backfilled to `zul`; the press-1 escalation is fully
specified with a claim-guard, a key-to-accept whisper, a dedicated daily cap, a
quiet window, and its own kill switch; the audio purge is ordered before the row
prune so R2 never orphans; the listen-link DELETE gets confirm + audit +
soft-delete; the internal transcript SMS uses `sendSMS` and bypasses client
consent suppression; AI is fail-soft with a clamped tag and its own kill switch;
docs + the `COMPANY_PHONE` cross-cutting are enumerated. Rev 2: the 224 numbers
have no SMS/A2P approval, so client SMS stays on the 888 (Phase 1 = voice; Phase 2
= SMS cutover, gated on 224 A2P).)
Status: approved in brainstorm (section-by-section); spec-review fleet folded (rev 3)

Driver: the phone footprint grew organically and now feels like a robot, not a
real local business. Four numbers wear the "Dr. Bartender" hat with unclear,
overlapping roles, and the client texting line is a toll-free 888 that reads as a
call center. The owner's north star: lean hard on AI and automation, but the
customer experience should FEEL real, like reaching an actual person you would
grab a drink with. AI belongs behind the curtain (routing, transcription,
triage), never as a phone tree the customer navigates.

## Current state (verified 2026-07-26, against the code)

- **312 (Google Voice, `+13125889401`)**: the public "company" number. It is what
  the marketing site shows (`client/src/utils/constants.js:5`,
  `COMPANY_PHONE_TEL`). Google Voice CANNOT run any of our automation: no TwiML,
  no programmable SMS webhooks. This is the load-bearing constraint on the 312.
- **224 `+12242220082` (Twilio)**: "Zul's" voice line. A client dialing it is
  bridged to Zul's PH cell (`VA_CELL`), and on a miss it now runs the smart
  voicemail-to-Telegram shipped 2026-07-24 (`server/routes/voice.js`
  `/inbound` + `/inbound/missed` + `/inbound/voicemail`, plus the recorded
  greeting at `GET /api/voice/greeting.mp3`). It is also `VOICE_CALLER_ID`, the
  caller ID on Zul's outbound calls, which is why returning clients call it.
- **224 `+12242221922` (Twilio)**: purchased recently, wired to NOTHING in the
  code. The owner bought it so both people (Zul, Dallas) have a Twilio number.
- **888 toll-free (Twilio)**: the client texting line (`TWILIO_PHONE_NUMBER`,
  used by `server/utils/sms.js:31` and `server/utils/smsInbound.js:215`). This is
  the "robot" the owner dislikes.
- **970 (Dallas's personal cell)**: private, not part of the system today.

The fragmentation: the number that IS the brand (312) is the one that can never
be smart, the smart numbers (224s, 888) are not the brand, and the loudest
"not real" signal is the toll-free.

## Guiding principle

Real by BEING a person, not real by an AI so convincing it passes. The owner
chose the human-front model: a warm real voice, a personal texting tone, and a
fast human callback. AI does the invisible work (transcription, summary, triage,
routing) and is never the thing the caller talks to. A single "press 1 to reach
a person" option is allowed because it OFFERS a human; a multi-level phone tree
is the robot we are avoiding.

## Design

### 1. The number map

| Number | Role | Notes |
|---|---|---|
| **`+12242221922` (Twilio)** | **PRIMARY for VOICE now, "Dallas."** Inbound calls route to Dallas via the 312. Becomes the primary SMS line ("hey it's Dallas") only in Phase 2, once the 224s have A2P approval. | Voice-first. `TWILIO_PHONE_NUMBER` repoints here in Phase 2, NOT now. |
| **`+12242220082` (Twilio)** | **"Zul."** The line clients who have been emailing Zul call. Bridge to Zul + smart voicemail. | Unchanged wiring plus the shared voicemail flow below. Stays `VOICE_CALLER_ID` for Zul's outbound. |
| **`+13125889401` (Google Voice)** | **Dallas's phone routing layer + his voicemail inbox.** The 1922's calls funnel through it to reach Dallas, keeping his 970 private. VM transcripts are texted here (sent FROM the 888 for now, the only A2P-approved sender). | GV, so it stays "dumb" by nature. Its job is to ring Dallas and receive texts on his phone. |
| **970 (personal cell)** | Private. Never exposed to a client, never given out. | Reachable only internally (Twilio may dial it; callers only ever see 1922). |
| **888 toll-free** | **Stays the client SMS line for now.** The 224s have no SMS approval yet, so this is the sole approved sender. Retired only in Phase 2, after 224 A2P clears and client SMS cuts over to 1922. | Voice redesign (Phase 1) does not touch it. |

Nobody memorizes the digits, per the owner, so no port of the 312 is needed. The
only aesthetic constraint honored: local, ours, and no toll-free anywhere.

### 2. Primary voice routing (1922 to Dallas)

The 1922 gets its OWN inbound handler, DISTINCT from the existing `/inbound`
(which hardcodes the `VA_CELL`/Zul dial, so it cannot be reused literally). It is
a Twilio-controlled call, not a blind forward, so our smart voicemail owns the
miss. Like the voicemail webhooks, it fails CLOSED on signature
(`requireSignature`, NOT the dev-allow `passesSignature` the current `/inbound`
uses), because it places a billed `<Dial>`.

Each line's inbound handler stamps `line` on its `<Dial action>` URL
(`?line=primary` / `?line=zul`) so the shared missed handler (section 3) knows
which line the call arrived on. `line` is what routes greeting, delivery, and
redelivery downstream, so it is established here at the top.

The 1922 handler `<Dial>`s `VM_PRIMARY_DIAL_TARGET` (the 312, which rings Dallas's
phone) with a ring timeout, then routes a missed dial to the shared handler.

RISK, and it is the same class either target: Google Voice has its OWN voicemail
that can answer the Twilio `<Dial>` to the 312 first, returning
`DialCallStatus=completed` and pre-empting our smart voicemail. The 970-direct
fallback has the IDENTICAL defect (the cell's carrier voicemail can answer too).
Mitigations, in order: (a) DISABLE carrier/GV voicemail on whichever target we
dial, so the leg rings out and Twilio's no-answer fires our handler; (b) keep the
Twilio ring timeout short enough to fire before the target's voicemail picks up;
(c) because (a) is a manual, un-monitored console setting, add a lightweight
canary (a periodic check, or an alert when the primary line logs `completed` with
a near-zero dial duration) so a silently re-enabled carrier voicemail is caught,
not discovered weeks later. Settle the target choice (312 vs 970) with a live
test before relying on it.

### 3. Smart voicemail plus escalation (ONE reusable, line-aware flow, both lines)

A single behavior applied to BOTH lines, keyed on the `line` stamped in section 2.
It generalizes the existing `/inbound/missed` handler. The battle-tested 0082 path
must stay byte-identical when escalation is OFF (protect-working-paths): escalation
ships behind its own kill switch (`VM_ESCALATION_ENABLED`, default off, the
`VOICEMAIL_ENABLED` ship-dark precedent), so turning it off restores today's exact
greeting-then-Record flow. On a missed call:

1. Play the per-line greeting (section 6) inside a `<Gather numDigits="1"
   action="…/inbound/escalate?line=…">` so the caller can press 1 while it plays.
2. The greeting offers exactly ONE option: "leave a message after the tone, or
   press 1 to try to reach someone else."
3. **No keypress:** `<Gather>` falls through to `<Record>`, exactly like today.
4. **Press 1:** Twilio requests the `<Gather action>` route,
   `POST /api/voice/inbound/escalate` (new, fail-closed on signature). It:
   - **Claim-guards** the escalation with a guarded state transition (the
     lead-call bridge pattern, `voiceLeadCall.js:173-180`:
     `UPDATE … SET escalation_status='dialing' WHERE call_sid=$1 AND
     escalation_status IS NULL`), because Twilio delivers the action at-least-once
     and an un-guarded retry places a SECOND billed leg. A lost claim replays the
     current TwiML.
   - Checks a **dedicated daily cap** (`VM_ESCALATION_DAILY_CAP`, the
     `LEAD_CALL_DAILY_CAP` precedent) BEFORE dialing; over cap → straight to
     `<Record>`. `VM_DAILY_CAP` counts missed calls, not escalation legs, so this
     new billed leg needs its own bound, especially on the 1922 line where the
     target is Zul's PH cell (an international leg reachable from a public press-1).
   - Respects a **quiet window** per target (`VM_ESCALATION_QUIET_*`): outside the
     target's hours (Zul is a PH VA), skip the dial and go straight to `<Record>`
     rather than ringing a cell at 3am.
   - `<Dial>`s the OTHER person from a strict-E.164 ENV target, never a
     caller-supplied value (1922 press-1 → `VA_CELL`; 0082 press-1 →
     `VM_PRIMARY_DIAL_TARGET`), with a hard `timeLimit` and a
     `<Dial action="…/inbound/escalate-done?line=…">`.
   - The whisper on the ANSWERING leg uses a KEY-TO-ACCEPT gate (a `<Gather>` on
     the whispered leg: "press any key to take a Dr. Bartender client"), NOT a
     bare `<Say>`. A bare whisper lets the other party's carrier voicemail silently
     "answer" and return `completed`, pre-empting the fallback and stranding the
     caller. Key-to-accept means an unattended voicemail cannot accept.
5. **Escalate-done (no answer / not accepted):** the `<Dial action>` route returns
   the `<Record>` so the caller lands in voicemail, never stranded.

The `<Record>` keeps its current shape (no `action`; delivery hangs off
`recordingStatusCallback`). ALL voice webhooks (inbound, primary, missed,
escalate, escalate-done, voicemail) fail CLOSED on signature in every environment.
Dynamic on-call by presence/shift is deferred (Out of scope); v1 is the fixed
other person.

### 4. Voicemail handling (after a message is left)

The recording callback (`/inbound/voicemail`) is extended. Order matters:

1. **Fetch** the mp3 from Twilio (existing `fetchRecordingMp3`, URL built from the
   account SID + a shape-validated `RecordingSid`; the body's `RecordingUrl` is
   never read).
2. **Empty-drop FIRST:** if `RecordingDuration < 2s` (robocall / hangup on the
   beep), mark `empty`, delete the Twilio recording, done. This runs BEFORE any
   store/transcribe/LLM, so a robocall never costs an R2 put + a transcription + an
   LLM call.
3. **Store** the mp3 in R2 (private) via `storage.uploadFile`, recording
   `audio_key`. **R2 is now the RETRY SOURCE, not merely an archive** (see the
   sweep note below).
4. **Transcribe** (section 9), then **summarize + tag** with an LLM: a one-line
   summary + a tag CLAMPED to the fixed set (`likely_lead`, `existing_client`,
   `spam`, `other`); anything the LLM returns off-list is coerced to `other`
   BEFORE the write, so a stray tag can never violate the `tag` CHECK and fail the
   row. Both AI steps are FAIL-SOFT: on any error, transcript/summary/tag are left
   NULL and delivery still goes out with the caller number + audio/link. NO
   SUPPRESSION: every voicemail is delivered regardless of tag.
5. **Deliver per line (keyed on `line`):**
   - **Dallas's line (`primary`):** an SMS via `sendSMS` (NOT `sendAndLogSms`,
     which files into the client `sms_messages` thread) to `VM_TEXT_DESTINATION`
     (the 312) with the caller number, tag, summary, and listen-link (the full
     transcript lives on the page, section 5, since a 5-minute transcript is a
     multi-segment SMS GV may truncate). Sent from the 888 in Phase 1. This
     internal alert BYPASSES the client STOP/consent suppression path, so a stray
     STOP on the 312 can never silently drop Dallas's voicemails. If the SMS send
     fails, fall back to an alert (email to `ADMIN_EMAIL`, or the Telegram admin
     channel), so a silent GV/SMS drop never loses the lead.
   - **Zul's line (`zul`):** her Telegram (audio inline via `sendTelegramAudio`) +
     summary, tag, and listen-link, as today, plus its existing failure alerting.
6. **Success is per-channel and explicit.** Each channel defines "delivered"
   (Telegram `ok===true`; the SMS send accepted). Only on a confirmed delivery is
   the row marked `delivered`. The Twilio recording is deleted after the R2 copy
   exists (step 3), which is safe because redelivery re-fetches from R2, not Twilio
   (next paragraph).

**Redelivery sweep re-points to R2 (load-bearing).** `reapUndeliveredVoicemails`
and `deliverVoicemail` currently re-fetch from Twilio (`fetchRecordingMp3`); under
this design an undelivered row's Twilio copy is gone, so both MUST re-fetch from R2
via `audio_key` (else they 404 forever). The sweep's SELECT must also read `line`
and route redelivery to the correct channel: a stuck `primary` row must re-SMS
Dallas, never fall through to Zul's Telegram.

The `voicemail_delivery` ledger gains transcript, summary, tag, `audio_key`,
`listen_token`, `purge_at`, `audio_deleted_at`, and `line` (section 7).

### 5. The listen-link page

Each voicemail gets an unguessable token (`gen_random_uuid()`). The message carries
`{PUBLIC_SITE_URL}/vm/{token}`, a public client route added to `App.js` (the
existing unknown-path `*` redirect must not swallow it). The page:

- Plays the recording via a token-gated API endpoint that looks the token up →
  `audio_key` → streams the mp3 out of R2 (the private-R2 streaming-proxy pattern
  from `blog.js`, but keyed by TOKEN, never a caller-supplied filename, so it can
  never be turned into an open R2 proxy). Guard the `:token` param with
  `requireUuidToken` (a non-UUID otherwise hits Postgres `22P02` → 500, not 404).
- Shows summary, full transcript, tag, caller, time; has explicit loading, error,
  unknown-token (404), and expired states.
- **Delete:** a confirmation step, then a SOFT delete: `deleteFile` the R2 object
  and stamp `audio_deleted_at`, but RETAIN the transcript (the business record);
  the page then shows "recording deleted" with the transcript still visible. The
  action is idempotent (delete on an already-purged row, or `deleteFile` on a
  missing key, no-ops to success) and writes an audit-log line. Residual: the link
  travels by SMS/Telegram, so anyone it is forwarded to could trigger the delete;
  confirm + audit + soft-delete (audio only, transcript kept) bounds the blast
  radius. If stronger control is wanted later, gate DELETE behind admin auth.

Token-gated, not public: only someone the owner forwards the link to can open it.

Retention: audio auto-purges at `VM_AUDIO_RETENTION_DAYS` (default 14) unless
deleted sooner. See section 7 for the purge-before-prune ordering that keeps R2
from orphaning; after purge the transcript remains (text, low sensitivity) and the
page shows "recording expired."

### 6. Per-line greeting

The greeting is already per-line-swappable via `VM_GREETING_URL` and the bundled
`GET /api/voice/greeting.mp3` (shipped 2026-07-24). Extend that to two greetings:

- **Zul's line:** her existing recording, live.
- **Dallas's line:** Dallas records his own ("hey it's Dallas...") in his real
  voice. Bundled the same way (a second asset) or set per-line via env.

Mechanism mirrors the existing `greetingVerb()`: `<Play>` the line's recording;
an env override per line; a `say` kill-switch back to the synthetic voice.

### 7. Data model

Extend `voicemail_delivery` (idempotent `ADD COLUMN IF NOT EXISTS`):

- `line` TEXT: which number received the call (`primary` / `zul`). **Backfill:**
  every existing row predates this feature and was Zul's line, so a one-time
  `UPDATE voicemail_delivery SET line='zul' WHERE line IS NULL` runs with the
  migration; downstream code also treats NULL `line` as `zul` defensively.
- `transcript` TEXT, `summary` TEXT, `tag` TEXT with `CHECK (tag IN
  ('likely_lead','existing_client','spam','other') OR tag IS NULL)`; the writer
  clamps off-list LLM output before insert (section 4).
- `audio_key` TEXT (R2 object key), `listen_token` TEXT UNIQUE
  (`gen_random_uuid()`), `purge_at` TIMESTAMPTZ (created_at +
  `VM_AUDIO_RETENTION_DAYS`), `audio_deleted_at` TIMESTAMPTZ.

**Two clocks, correctly ordered.** The AUDIO purge (14 days) must run and succeed
BEFORE the ROW prune (`RETENTION_DAYS`, ~30 days) can remove the row, or the row
(the only pointer to the R2 object) disappears and the audio orphans in R2 past
retention. So: (a) the audio-purge sweep `deleteFile`s R2, THEN stamps
`audio_deleted_at`, and does NOT stamp it if `deleteFile` errors (stays
retryable); (b) the existing row-prune (`pruneVaCallingRows`) gains an
`AND (audio_key IS NULL OR audio_deleted_at IS NOT NULL)` guard so it never
deletes a row whose R2 audio still exists. The prior "recording still in the
Twilio console" retention rationale for `recorded`/`failed` rows no longer holds
under the R2-canonical model and is replaced by this audio-key guard.

### 8. Guardrails and security

- ALL voice webhooks (inbound, the new 1922 primary, missed, escalate,
  escalate-done, voicemail) fail CLOSED on signature in every environment
  (`requireSignature`, no dev skip).
- No caller-supplied value reaches an outbound request, a URL, or a `<Dial>`
  attribute: the media URL is built from the account SID + a validated
  `RecordingSid`; escalation targets are strict-E.164 env vars only; `line` is a
  fixed enum, not free text.
- The escalation is a NEW billed leg: claim-guarded against Twilio's at-least-once
  retry, bounded by `VM_ESCALATION_DAILY_CAP` + a hard `timeLimit`, quiet-windowed,
  and behind `VM_ESCALATION_ENABLED` (default off). The key-to-accept whisper stops
  a carrier voicemail from silently accepting the leg.
- The listen-link + audio endpoint are token-gated (unguessable UUID,
  `requireUuidToken`), keyed by token → `audio_key` (never a caller filename);
  audio auto-purges at 14 days; DELETE is confirmed, soft (audio only), and
  audited. Client-voice PII is not hoarded on OUR side.
- Client PII egress: audio + transcript go to a third-party transcription/LLM
  provider. Use a no-training / short-retention tier and note it in the PII record.
- Transcripts/summaries are PII: in our DB + the per-line delivery channel only,
  never in logs (last-4 redaction stays). `970` never appears on a client surface.
- Retention caveat: Zul's inline Telegram audio lives under Telegram's retention,
  which can outlast our 14-day purge. Our 14-day guarantee governs R2 (the
  authoritative store + the listen-link). A strict uniform purge would require
  switching Zul's line to link-only (no inline Telegram audio) — deferred decision,
  not built.

### 9. New dependencies

- **Transcription:** none exists today. A speech-to-text provider (candidate:
  OpenAI Whisper API or Deepgram) behind a named env key. Whisper can HALLUCINATE
  text on silent/non-English audio; guard with a duration/confidence floor so a
  fabricated summary is not presented as fact (still delivered, under no-suppress).
- **Summary + tag:** an LLM call (Anthropic Claude, the house model; the server
  has no Anthropic integration yet — see the `claude-api` reference). Named env key.
- Both AI calls run OFF the caller's critical path (the call is over when the
  recording callback fires) and are FAIL-SOFT (section 4) and behind
  `VM_AI_ENABLED` — a redeploy-free kill switch for a provider outage or cost
  spike, gated OFF in non-prod so dev never spends against the shared DB.
- **R2:** add `deleteFile` to `server/utils/storage.js` (it exports only
  `uploadFile` / `getSignedUrl` today), and add `.mp3 → audio/mpeg` to its
  `MIME_TYPES` map (an unmapped `.mp3` stores as `application/octet-stream`, which
  the `<audio>` element will not play).

## Environment variables

| Variable | Change |
|---|---|
| `TWILIO_PHONE_NUMBER` | STAYS the 888 for now (the 224s lack SMS approval). Repoints to `+12242221922` in Phase 2, after 224 A2P clears. |
| `VOICE_CALLER_ID` | Stays `+12242220082` (Zul's line / her outbound caller ID). |
| `VM_TEXT_DESTINATION` (new) | The 312, where Dallas's line VM transcripts are texted. |
| `VM_PRIMARY_DIAL_TARGET` (new) | What 1922 inbound dials to reach Dallas (the 312, or his 970 if GV interception forces the fallback). |
| `VM_GREETING_URL` (existing) | Extended to per-line greeting selection. |
| `VM_ESCALATION_ENABLED` (new) | Kill switch for the press-1 escalation; default OFF (ship dark). Off = today's greeting-then-Record flow, byte-identical. |
| `VM_ESCALATION_DAILY_CAP` (new) | Max escalation legs per rolling 24h — toll-fraud bound on the new billed leg (incl. the international PH leg). |
| `VM_ESCALATION_QUIET_*` (new) | Per-target quiet window; outside it, skip the escalation dial and go straight to `<Record>` (e.g. don't ring Zul's PH cell at 3am). |
| `VM_AI_ENABLED` (new) | Kill switch for transcription + LLM tagging; gated OFF in non-prod. Off = deliver caller number + audio/link, no transcript/tag. |
| `VM_TRANSCRIBE_API_KEY` / `ANTHROPIC_API_KEY` (new) | Named keys for the transcription provider and the LLM summary/tag. Never hardcoded; in `.env.example` + CLAUDE.md. |
| `VM_AUDIO_RETENTION_DAYS` (new) | Default 14. |

## Reuses (build on what exists, do not reinvent)

- Missed-call handler, greeting `<Play>`, signature gate, ledger claims:
  `server/routes/voice.js`, `server/utils/voicemail.js`.
- Whisper + press-to-connect bridge: `server/routes/voiceLeadCall.js`,
  `server/utils/leadCallTrigger.js`.
- Telegram delivery: `server/utils/telegram.js` (`sendTelegramAudio`,
  `sendTelegramMessage`).
- SMS send: `server/utils/sms.js` — `sendAndLogSms` for client texts, but
  `sendSMS` DIRECTLY (no client-thread logging, no consent suppression) for the
  internal VM-transcript alert to the 312.
- Private-R2 streaming proxy pattern for the audio endpoint (keyed by TOKEN, not a
  filename): `server/routes/blog.js`.
- R2 storage: `server/utils/storage.js` (add `deleteFile`; add `.mp3` to
  `MIME_TYPES`).
- UUID token guard for `/vm/:token`: `server/utils/tokens.js` `requireUuidToken`.
- Retention sweep host: `server/utils/vaCallingScheduler.js` /
  `server/utils/pendingCall.js`.
- Public token-gated route convention (drink plans, proposals) for `/vm/:token`.

## Ops and rollout

**Phasing (rev 2):** the 224 numbers have no SMS/A2P approval yet, so this splits
in two. **Phase 1 (now):** the entire voice + smart-voicemail experience, which
has no dependency on SMS approval (1922 voice routing, the shared VM + escalation
flow, transcription + tag, storage + listen-link + purge, per-line greetings).
VM-transcript texts and client texts both keep sending from the 888 in Phase 1.
**Phase 2 (gated on 224 A2P approval, not started):** move client SMS off the 888
to 1922 and retire the 888.

This is part code, part Twilio/GV console configuration, part carrier paperwork.
Sequence, shipping dark and verifying with live calls at each gate (the
`VOICEMAIL_ENABLED` precedent):

1. **Twilio console:** point the 1922's voice webhook at the primary inbound
   handler and its SMS webhook at the existing inbound-SMS route; keep the 0082
   wiring.
2. **Google Voice:** disable voicemail on the 312 (section 2), confirm it
   forwards to Dallas's phone, and confirm it receives SMS.
3. **Code:** the shared smart-voicemail flow, transcription + tag, R2 store +
   listen page + purge, per-line delivery, `deleteFile`.
4. **[PHASE 2, gated on 224 A2P approval] Client SMS move:** once the 224
   SMS/A2P registration is filed AND approved, repoint `TWILIO_PHONE_NUMBER` to
   1922, cut client texts over, and retire the 888. Not started until that
   approval exists; the 224 numbers cannot send client SMS today, which is why
   Phase 1 keeps the 888.
5. **Website + phone constants (cross-cutting):** `COMPANY_PHONE_TEL` also backs
   client "Text us" links (`Completion.js`, `ApplicationStatus.js`) and the DISPLAY
   constant `COMPANY_PHONE` shows in several client surfaces (`ProposalView.js`,
   etc.). Point the VOICE "call us" to 1922 now, keep "text us" on the 888 until
   Phase 2, and update the displayed number to match wherever it changes (CLAUDE.md
   phone-change cross-cutting rule). Enumerate every consumer of both constants.
6. **Greetings:** record Dallas's greeting; keep Zul's.
7. **Docs (mandatory):** README folder tree + ARCHITECTURE route table for the new
   `/vm` route and the escalate routes and the transcription util; CLAUDE.md +
   README env tables for the new vars; CLAUDE.md Tech Stack + ARCHITECTURE
   Third-Party Integrations for the first-ever transcription + Anthropic
   integrations.
8. **Live tests:** primary inbound rings Dallas and misses to smart VM (proves the
   target's carrier/GV voicemail does NOT intercept); press-1 escalation
   claim-guards a double callback, respects the cap + quiet window, requires
   key-to-accept (an unanswered target's voicemail must NOT accept), and falls back
   to `<Record>` on no-answer; a voicemail empty-drops under 2s, otherwise
   transcribes/tags/clamps, SMSes the 312 with a working listen-link, and the
   soft-delete + 14-day purge (audio gone, transcript kept, no R2 orphan) behave;
   an undelivered row redelivers from R2 to the correct channel.

## Out of scope / deferred

- **Smart (dynamic) on-call:** ringing whoever is actually on shift/on-call,
  several cells at once or in sequence, from presence + shift data. v1 is the
  fixed "other person."
- **Hours-gating** the press-1 option (offer only during business hours). v1
  offers it always.
- **A conversational AI voice agent** that talks to callers. Explicitly rejected:
  the owner chose real-by-human, not real-by-convincing-AI.
- **Porting the 312 into Twilio.** Not needed (nobody memorizes the number).

## Decisions locked in brainstorm

1. Real by BEING human, not an AI voice agent. AI stays behind the curtain.
2. 1922 is the primary business number: VOICE now, SMS in Phase 2. Client SMS
   stays on the 888 until the 224 numbers get A2P approval (a hard external gate).
3. 0082 stays Zul's client line. 312 is Dallas's routing layer + VM-text inbox
   (texts sent from the 888 for now). 970 stays private. 888 is retired only in
   Phase 2.
4. One reusable smart-voicemail-plus-escalation flow on BOTH lines; press 1 rings
   the OTHER person with a whisper; no answer returns to voicemail.
5. Voicemails are transcribed and AI-tagged; NOTHING is suppressed (tag only).
6. Dallas's VMs are texted to the 312; Zul's stay in Telegram.
7. Every VM has a private listen-link with a Delete button; audio auto-purges at
   14 days.

## Open items to verify during build

- Does Google Voice voicemail intercept the Twilio `<Dial>` to the 312 (section
  2)? Settle with a live call; fallback is dialing the 970 directly.
- Does the 312 (Google Voice) reliably receive the transcript SMS on Dallas's
  phone? Confirm before cutting his delivery to it.
- Transcription provider choice (Whisper vs Deepgram vs other), finalized in the
  plan against cost and quality.
- **Phase 2 gate:** file the 224 SMS/A2P 10DLC registration. Phase 2 (moving
  client SMS to 1922 and retiring the 888) cannot start until it is APPROVED. Not
  yet filed as of 2026-07-26.
- **Zul retention decision (deferred):** accept that Zul's inline Telegram audio
  outlives the 14-day R2 purge (current plan), OR switch her line to link-only for
  a strict uniform purge. Decide before Phase 1 ships if the uniform guarantee is
  required.
- **Escalation target for the 0082 line:** press-1 on Zul's line rings
  `VM_PRIMARY_DIAL_TARGET` (Dallas). Confirm that is the desired "someone else" for
  a caller who reached Zul (vs a different on-call), since v1 is a fixed target.
