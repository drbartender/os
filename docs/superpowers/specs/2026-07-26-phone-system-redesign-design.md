# Phone System Redesign: real-feeling numbers, one smart voicemail, AI triage (design)

Date: 2026-07-26
Revision: 1
Status: approved in brainstorm (section-by-section)

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
| **`+12242221922` (Twilio)** | **PRIMARY, "Dallas."** The business number. Client texts come from here ("hey it's Dallas"). Inbound calls route to Dallas via the 312. Replaces the 888 for SMS. | Becomes `TWILIO_PHONE_NUMBER`. Website "call/text us" points here. |
| **`+12242220082` (Twilio)** | **"Zul."** The line clients who have been emailing Zul call. Bridge to Zul + smart voicemail. | Unchanged wiring plus the shared voicemail flow below. Stays `VOICE_CALLER_ID` for Zul's outbound. |
| **`+13125889401` (Google Voice)** | **Dallas's phone routing layer + his voicemail inbox.** The 1922's calls funnel through it to reach Dallas, keeping his 970 private. VM transcripts are texted here. | GV, so it stays "dumb" by nature. That is fine: its job is to ring Dallas and receive texts on his phone. |
| **970 (personal cell)** | Private. Never exposed to a client, never given out. | Reachable only internally (Twilio may dial it; callers only ever see 1922). |
| **888 toll-free** | **Retired.** | After client SMS moves to 1922 and A2P re-registers. |

Nobody memorizes the digits, per the owner, so no port of the 312 is needed. The
only aesthetic constraint honored: local, ours, and no toll-free anywhere.

### 2. Primary voice routing (1922 to Dallas)

Inbound to 1922 is a Twilio-controlled call, not a blind forward, so our smart
voicemail can own the miss:

`POST /api/voice/inbound` (or a primary-specific handler) responds with a
`<Dial>` to the 312 (which rings Dallas's phone) carrying a ring timeout, then on
a missed dial routes to the shared smart-voicemail handler (section 3).

RISK to verify with a live test before relying on it: Google Voice has its OWN
voicemail, which could answer the Twilio `<Dial>` to the 312 first, returning
`DialCallStatus=completed` and pre-empting our smart voicemail. Mitigation:
DISABLE Google Voice voicemail on the 312 so the call rings out and Twilio's
no-answer fires our handler. If GV interception proves unavoidable, the fallback
is to `<Dial>` Dallas's cell (970) directly (still never exposed to callers,
since they only ever see 1922) and treat the 312 purely as his personal GV line
plus the VM-text destination. This is a build-time decision gated on a live call.

### 3. Smart voicemail plus escalation (ONE reusable flow, both lines)

This is a single behavior applied to BOTH the primary (1922) and Zul's line
(0082). It generalizes the existing `/inbound/missed` handler. On any missed
call:

1. Play a warm greeting in a real voice (per-line recording, section 6), wrapped
   in a `<Gather numDigits="1">` so the caller can press a key while it plays.
2. The greeting offers exactly ONE option: "leave a message after the tone, or
   press 1 to try to reach someone else."
3. **Press 1 (escalation):** `<Dial>` the OTHER person, with a whisper so the
   person who picks up hears "Dr. Bartender client on the line," never a confused
   "hello?".
   - A caller on Dallas's line (1922) who presses 1 rings Zul.
   - A caller on Zul's line (0082) who presses 1 rings Dallas.
   - "Simple" on-call only (the fixed other person). Dynamic on-call by
     presence/shift is explicitly deferred (Out of scope).
   - No answer on the escalation leg drops the caller BACK to the voicemail
     `<Record>` so they are never stranded.
4. **No keypress (default):** fall through to `<Record>`, exactly like today.

Escalation is a billed outbound leg, so it carries the same toll-fraud discipline
as the existing bridges: a hard `timeLimit`, and it reuses the whisper + press
mechanics already built for the lead-call bridge (`server/routes/voiceLeadCall.js`,
`server/utils/leadCallTrigger.js`).

The `<Record>` keeps its current shape (no `action` attribute; delivery hangs off
`recordingStatusCallback`) and the two webhooks keep failing CLOSED on signature
in every environment (`requireSignature`, no dev skip).

### 4. Voicemail handling (after a message is left)

The recording callback (`/inbound/voicemail`) is extended. In order:

1. **Fetch** the mp3 from Twilio (existing `fetchRecordingMp3` in
   `server/utils/voicemail.js`, URL constructed from the account SID plus a
   shape-validated `RecordingSid`; the body's `RecordingUrl` is never read).
2. **Store** the mp3 in R2 (private) via `server/utils/storage.js` so it can back
   the listen-link for the retention window. R2 is the canonical audio archive
   now, replacing "Telegram is the archive."
3. **Transcribe** the audio (new transcription dependency, section 9).
4. **Summarize and tag** the transcript with an LLM (new dependency): a one-line
   summary plus a tag from a small fixed set (`likely_lead`, `existing_client`,
   `spam`, `other`). NO SUPPRESSION: every voicemail is delivered regardless of
   tag. The tag is advisory so a human can eyeball it; nothing weird-but-wanted
   is ever hidden.
5. **Deliver per line:**
   - **Dallas's line (1922):** an SMS to the 312 containing the caller number,
     the tag, the transcript, and a private listen-link (section 5). Google Voice
     receives SMS, so it lands on his phone; confirm in testing.
   - **Zul's line (0082):** her Telegram as today (audio inline via
     `sendTelegramAudio`) PLUS the transcript, summary, and tag added to the
     message. The listen-link may also be included.
6. **Define success** exactly as the current design does (delivery confirmed on
   an affirmative result, gated vs failed vs delivered are distinct outcomes),
   then **delete the Twilio recording** once our R2 copy exists. Our copy, not
   Twilio's, is what the retention window governs.

The `voicemail_delivery` ledger (already the dedup claim, the daily-cap window,
and the delivery record) gains the transcript, summary, tag, the R2 audio key,
the listen token, and the purge timestamp (section 7).

### 5. The listen-link page

Each voicemail gets an unguessable token (UUID). The SMS/Telegram message carries
`{PUBLIC_SITE_URL}/vm/{token}` (or an equivalent). The page:

- Plays the recording (an `<audio>` element sourced from a token-gated audio
  endpoint that streams the mp3 out of R2, reusing the private-R2 streaming-proxy
  pattern from `server/routes/blog.js` `GET /api/blog/images/:filename`, so no
  public R2 URL is required and the signed URL never leaves the server).
- Shows the full transcript, tag, caller, and time.
- Has a **Delete** button that purges the audio (R2 object plus the token) on
  demand.

Token-gated, not public: only someone the owner forwards the link to can open it.

Retention: audio auto-purges **14 days** after the voicemail, unless deleted
sooner via the button. The purge is a new sweep (folded into the existing
VA-calling maintenance, `server/utils/vaCallingScheduler.js` /
`server/utils/pendingCall.js` `pruneVaCallingRows`): delete the R2 object and
clear the token/audio fields for rows past `purge_at`. After purge, the transcript
may remain as the business record (text, low sensitivity) while the audio (higher
sensitivity) is gone; the listen-link then shows "recording expired."

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

- `line` TEXT: which number received the call (`primary` / `zul`), so delivery
  and greeting route correctly.
- `transcript` TEXT, `summary` TEXT, `tag` TEXT (CHECK in the fixed set).
- `audio_key` TEXT: the R2 object key for the stored mp3.
- `listen_token` TEXT UNIQUE: the unguessable listen-link token.
- `purge_at` TIMESTAMPTZ: when the audio auto-deletes (created_at + 14 days).
- `audio_deleted_at` TIMESTAMPTZ: set when the R2 object is purged (manually or by
  the sweep), so the listen page can say "expired."

The prune predicate from the current design still governs ROW lifetime; the new
purge governs the AUDIO OBJECT lifetime (a shorter, 14-day clock).

### 8. Guardrails and security

- Both voicemail webhooks fail CLOSED on signature in every environment.
- No caller-supplied value reaches an outbound request or a URL (media URL
  constructed from the account SID plus a validated `RecordingSid`).
- The escalation `<Dial>` carries a hard `timeLimit` and reuses the toll-fraud
  discipline of the existing bridges; per-CallSid rate limiting on the webhooks
  stays.
- The listen-link is token-gated (unguessable UUID), audio streams through a
  server proxy (no public R2 URL), and audio auto-purges at 14 days with a manual
  delete. Client-voice PII is not hoarded.
- Transcripts and summaries contain client PII; they live in our DB and in the
  per-line delivery channel only, never in logs (last-4 redaction stays).
- `970` is never placed in any client-facing surface.

### 9. New dependencies

- **Transcription:** none exists today. A speech-to-text provider is required
  (candidate: OpenAI Whisper API, or Deepgram; low cost per minute). New API key.
- **Summary and tag:** an LLM call (Anthropic Claude, the house model). New API
  key and client (the server has no Anthropic integration yet; see the
  `claude-api` reference for model IDs and usage).
- **R2 delete:** `server/utils/storage.js` currently exports only `uploadFile`
  and `getSignedUrl`; add a `deleteFile` for the purge.

Both AI calls happen off the caller's critical path (the call is already over when
the recording callback fires), so latency is not caller-facing. Both must fail
soft: a transcription or summary failure still delivers the audio plus caller
number (the message is never lost because the AI hiccuped).

## Environment variables

| Variable | Change |
|---|---|
| `TWILIO_PHONE_NUMBER` | Repoint from the 888 to `+12242221922`. |
| `VOICE_CALLER_ID` | Stays `+12242220082` (Zul's line / her outbound caller ID). |
| `VM_TEXT_DESTINATION` (new) | The 312, where Dallas's line VM transcripts are texted. |
| `VM_PRIMARY_DIAL_TARGET` (new) | What 1922 inbound dials to reach Dallas (the 312, or his 970 if GV interception forces the fallback). |
| `VM_GREETING_URL` (existing) | Extended to per-line greeting selection. |
| Transcription + LLM API keys (new) | For section 9. |
| `VM_AUDIO_RETENTION_DAYS` (new) | Default 14. |

## Reuses (build on what exists, do not reinvent)

- Missed-call handler, greeting `<Play>`, signature gate, ledger claims:
  `server/routes/voice.js`, `server/utils/voicemail.js`.
- Whisper + press-to-connect bridge: `server/routes/voiceLeadCall.js`,
  `server/utils/leadCallTrigger.js`.
- Telegram delivery: `server/utils/telegram.js` (`sendTelegramAudio`,
  `sendTelegramMessage`).
- SMS send: `server/utils/sms.js` (`sendAndLogSms`).
- Private-R2 streaming proxy pattern for the audio endpoint:
  `server/routes/blog.js`.
- R2 storage: `server/utils/storage.js` (add `deleteFile`).
- Retention sweep host: `server/utils/vaCallingScheduler.js` /
  `server/utils/pendingCall.js`.
- Public token-gated route convention (drink plans, proposals) for `/vm/:token`.

## Ops and rollout

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
4. **Client SMS move:** repoint `TWILIO_PHONE_NUMBER` to 1922 and
   **re-register A2P 10DLC** for it. The 888 campaign is mid-review right now, so
   this is a fast-follow, not a blocker; keep sending on the 888 until the 1922
   campaign clears, then cut over and retire the 888.
5. **Website:** `COMPANY_PHONE_TEL` and any public "call/text us" to the 1922.
6. **Greetings:** record Dallas's greeting; keep Zul's.
7. **Live tests:** primary inbound rings Dallas and misses to smart VM (proves GV
   does not intercept); press-1 escalation reaches the other person with a
   whisper and falls back to VM on no-answer; a real voicemail transcribes, tags,
   texts the 312 with a working listen-link, and the delete button + 14-day purge
   behave.

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
2. 1922 is the primary business number (voice + text), replacing the 888.
3. 0082 stays Zul's client line. 312 is Dallas's routing layer + VM-text inbox.
   970 stays private. 888 is retired.
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
