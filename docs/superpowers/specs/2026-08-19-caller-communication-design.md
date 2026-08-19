# Caller Communication: narrate the call, and stop pretending at night (design)

Status: approved in brainstorm (section-by-section), 2026-08-19.
Scope: the inbound voice experience on BOTH lines, from the missed-call greeting
through press-1 escalation to the fallback into voicemail.
Builds on: `2026-07-26-phone-system-redesign-design.md` (the phase 1a call
experience) and `2026-08-10-voicemail-listen-link-design.md`.

## Driver

Escalation went live 2026-08-19. Measured against the shipped code, a caller on
the primary line who presses 1 and does not reach anyone spends roughly a minute
with us and hears two intelligible sentences and a tone:

| Time | What the caller hears |
|---|---|
| 0s | Ringback, `VM_PRIMARY_RING_SEC` (18s) |
| 18s | Greeting, about 9s |
| 27s | "Or, press 1 and I will try to get someone else on the line for you." |
| 32s | A 4 second `<Gather>` window |
| presses 1 | Silence, then ringback, up to 20s. Nothing confirms the press registered. |
| 52s | The other person accepts, or a bare beep |

Two concrete defects, both live in production right now:

1. **The press-1 acknowledgment does not exist.** `voiceEscalate.js` answers the
   `<Gather>` with `<Response><Dial ...>` and no `<Say>` in front of it. The
   caller presses a key and gets dead air. Many will press again, and the second
   press does nothing because the document has already left the `<Gather>`.
2. **The fallback into voicemail says nothing.** `recordTwiml()` is
   `<Response>${recordVerb()}<Hangup/></Response>`, a `<Record playBeep="true">`
   with no words anywhere. After 20 seconds of ringing, an unexplained tone reads
   as a dropped call, not an invitation. This is reached from **7 call sites** in
   `voiceEscalate.js`, so it is every non-bridge outcome: no answer, quiet
   window, daily cap, escalation disabled, no target configured, claim failed,
   and already-escalated.

This is the caller who pressed 1, which is the caller who told us their thing is
urgent. It is the worst place in the system to go quiet.

## Guiding principle

**Narrate state, not schedule.**

Everything worth telling a caller is something we know at that instant: your
phone is ringing, I am trying someone else, nobody picked up, you are being
recorded. None of it requires knowing whether we are "open."

This matters because Dr. Bartender has client-facing hours but no strict internal
working hours, so any sentence about being open or closed risks contradicting
either the published hours or reality. A promise about *behavior* ("I'll get back
to you as soon as I can") is true at 2pm and at 2am. A promise about a *time*
("we're closed, we'll call tomorrow") can be wrong in the expensive direction: if
the owner would have called back at 8:15pm, telling the caller "tomorrow morning"
made the business look slower than it is.

Hold music was considered and **rejected**. During the escalation dial the caller
hears ringback, and ringback is real information: a phone is ringing, a human may
answer. Music would replace true information with false information, because
music means "you are in a queue" and there is no queue. The 20 seconds were never
the problem. Not saying what the 20 seconds are FOR was the problem.

## The one place a clock earns its keep

Empirical availability beats a schedule during the day: we do not need a calendar
to know whether someone is free, because we ring their actual phone and find out.
A schedule could only make us refuse to try someone who would have answered.

That reasoning breaks at night, for a reason specific to this business. Zul keeps
Chicago-aligned hours so she can be available to US clients, so Chicago night is
her off time too. An 11pm caller who presses 1 rings a sleeping phone in the
Philippines, waits 20 seconds, gets nothing, and lands in voicemail anyway. We
spend her sleep, a billed international leg, and the caller's patience on an
outcome we could have predicted.

Owner-confirmed behavior (2026-08-19): a voicemail left late **waits until the
next morning**. That is not a claim about being open. It is a description of what
actually happens to the message, which is exactly the kind of thing we can say
honestly.

## Design

### 1. Two modes, one window

| | Day | Night |
|---|---|---|
| Window (America/Chicago) | 09:00 to 21:00 | 21:00 to 09:00 |
| Greeting | offers press 1 | does NOT mention press 1 |
| Closing promise | "as soon as I can" | "in the morning" |
| `<Gather>` emitted | yes (when escalation is on) | **no** |
| Escalation attempted | yes | never |

ONE window, Chicago time, applied to BOTH lines. Both people are Chicago-aligned
and the callers are local either way, so a per-line window would be two knobs
that must never disagree.

This is deliberately NOT the same concept as the existing
`VM_ESCALATION_QUIET_ZUL` / `VM_ESCALATION_QUIET_PRIMARY`. Those protect the
person being dialed TO, expressed in THAT person's timezone, and they suppress
only the dial. The night window is about the CALLER's experience, is Chicago-based
for both lines, and changes the greeting itself. Both may be active; they do not
interact, because at night no dial is attempted at all.

### 2. Reuse the window machinery that already exists

`voicemailLine.js` already has `minutesInZone` plus a comparison that handles a
window WRAPPING MIDNIGHT (`w.start <= w.end ? (mins >= start && mins < end) :
(mins >= start || mins < end)`) and fails OPEN on an unparseable IANA zone so a
config typo cannot break a live call. 21:00 to 09:00 wraps midnight, so this is
the same shape, already tested. Do not write a second time comparison.

New: `isNight(now = new Date())` in `voicemailLine.js`, reading `VM_NIGHT_WINDOW`
(default `21:00-09:00`) and `VM_NIGHT_TZ` (default `America/Chicago`), parsed by
the SAME strict `HH:MM-HH:MM` parser, with the same fail-open behavior and the
same one-time warning on an unparseable value.

**Fail-open direction is deliberate and is the safe one here:** an unparseable
window means "always day," which offers press 1 and tries a human. The failure
mode is a rung phone, not a silently swallowed lead.

### 3. Four message slots per line

Every spoken moment becomes a named slot resolved by ONE helper, replacing the
four near-identical `<Say>`/`<Play>` branches this would otherwise grow:

| Slot | When it plays |
|---|---|
| `greeting_day` | missed call, day |
| `greeting_night` | missed call, night |
| `escalate_ack` | the instant the caller presses 1, BEFORE any ringing |
| `escalate_failed` | every path that returns the caller to voicemail |

Each slot resolves per line, with the contract `VM_GREETING_URL` already
establishes and which is preserved exactly: **unset means a synthetic `<Say>` of
the built-in text; the literal `say` forces synthetic (a known-good kill switch);
a full https URL emits `<Play>`.**

`greeting_day` keeps the EXISTING variable names (`VM_GREETING_URL_PRIMARY`,
`VM_GREETING_URL`) so nothing in Render has to change and Zul's bundled recording
keeps serving. The other three slots get new variables on the same pattern.

### 4. Copy

Primary line (Dallas). Approved verbatim in brainstorm:

- **greeting_day:** "Thanks for calling Dr. Bartender, this is Dallas. Sorry I
  missed your call. Leave me a message and I'll get back to you as soon as I can.
  If you need to talk to somebody now, press one and I'll see if someone's
  available."
- **greeting_night:** "Thanks for calling Dr. Bartender, this is Dallas. Sorry I
  missed your call. Leave me a message and I'll get back to you in the morning."
- **escalate_ack:** "Hold on, let me see who's available."
- **escalate_failed:** "Sorry, nobody's available right now. Leave me a message
  and I'll get back to you as soon as I can."

Zul's line (0082), where press 1 reaches Dallas. She speaks as herself, but the
callback promise is the team's, which is both true and warmer than a solo "I":

- **greeting_day:** "Thanks for calling Dr. Bartender, this is Zul. Sorry I
  missed your call. Leave me a message and we'll get back to you as soon as we
  can. If you need to talk to somebody now, press one and I'll see if someone's
  available."
- **greeting_night:** "Thanks for calling Dr. Bartender, this is Zul. Sorry I
  missed your call. Leave me a message and we'll get back to you in the morning."
- **escalate_ack:** "Hold on, let me see who's available."
- **escalate_failed:** "Sorry, nobody's available right now. Leave me a message
  and we'll get back to you as soon as we can."

Zul's line already has a real recorded greeting (the bundled
`server/assets/voicemail-greeting.mp3`), and it predates escalation, so it does
not mention press 1. Until she re-records, her callers hear her real voice
followed by a synthetic press-1 offer. That mixed-voice seam is pre-existing, is
not made worse here, and closes when she records `greeting_day`.


Two copy decisions locked, both deliberate:

- The day greeting SAYS the press-1 offer itself, so `VM_ESCALATION_PROMPT=none`
  must be set at the same time as the primary recording lands, or the offer is
  spoken twice, once in Dallas's voice and once by Polly.
- "In the morning" is used across the whole 21:00 to 09:00 window, accepting that
  it reads slightly oddly at 7am. The alternative is a third time band and more
  copy for a thin slice of callers. Owner accepted this explicitly.

### 4b. The press-1 offer moves INTO the greeting (found while planning)

The approved day copy says the press-1 offer itself. `escalationPromptVerb()`
also appends that offer today, so naively adopting the new copy would speak it
twice. The existing suppressor, `VM_ESCALATION_PROMPT=none`, is GLOBAL, and the
two lines have now diverged: Dallas's day greeting will contain the offer while
Zul's currently-bundled recording (`server/assets/voicemail-greeting.mp3`,
recorded 2026-07-24) predates escalation and does not.

Rule, replacing the global switch as the primary mechanism:

**A line's `greeting_day` content is expected to contain the offer.** The
appended prompt exists solely to patch a greeting recorded before the offer
existed, which is exactly one artifact: the legacy bundled mp3. So the prompt is
appended only when the zul line's day greeting resolves to that bundled asset
(`VM_GREETING_URL` unset). Every other source, the new synthetic text on either
line or any recording made from the scripts above, already contains it.

This is self-correcting: the day Zul's new recording is wired to
`VM_GREETING_URL`, the append stops on its own with no second variable to
remember. `VM_ESCALATION_PROMPT=none` survives as a manual override that
suppresses the append everywhere.

Night never appends it, because night makes no offer.

Consequence for the synthetic texts: `GREETING_TEXT_PRIMARY` is REPLACED by the
new day copy (which contains the offer) plus a new night text.
`GREETING_TEXT_ZUL` keeps its existing wording as the day synthetic, because the
module's standing rule is that a line's synthetic text mirrors what that line's
recording says, and hers still says the 2026-07-24 script.

### 5. Recordings are a gradient, never a prerequisite

Eight slots exist across two lines. **All eight ship with working synthetic
defaults**, so both production defects are fixed on deploy with nothing recorded.
Each recording swaps in later via an env var with NO redeploy.

Recording priority if only some get made: `greeting_day` (nearly every caller
hears it), then `escalate_failed`, then `escalate_ack`, then `greeting_night`.

Owner may record the four primary-line clips as one continuous take. There is no
audio tooling on the dev box (neither `ffmpeg` nor `sox` is installed), so a
one-take file must be exported as **WAV**, which Python's stdlib `wave` module can
split with no new dependency and which Twilio `<Play>` accepts. An mp3 one-take
would require installing ffmpeg first, which needs the owner's approval.

### 5b. AMENDED DURING IMPLEMENTATION (2026-08-19): recordings became the DEFAULT

Section 5 above says all eight slots ship with synthetic defaults and recordings
swap in later via env var, and section 3 says "unset means a synthetic `<Say>`".
Both are now FALSE of the shipped code, deliberately.

Dallas recorded his four clips the same day this was written, so rather than
wire them as env overrides they were bundled into the repo (`server/assets/`,
8kHz mono mp3) and made the DEFAULT for every primary-line slot. Zul's
`greeting_day` keeps its existing bundled mp3; her other three remain synthetic
until she records. The reasoning: an env override is a variable someone can
forget to set or lose during an environment migration, while a bundled default
is versioned, reviewed, and backed up with the code.

The contract per slot is therefore: **unset takes the slot's DEFAULT, which is a
bundled recording where one exists and the synthetic text otherwise; `say`
forces synthetic; an http(s) URL is `<Play>`ed.** The synthetic text is no
longer the normal path, it is the kill switch, which is why the four approved
primary strings are pinned byte-for-byte in a test: they must say the same words
as the mp3 or throwing the kill switch silently changes what callers hear.

A consequence worth stating, because it is not obvious: the offer-append rule
now trusts only the KNOWN defaults. An override URL has unknown content, so the
press-1 offer is appended after it. A doubled offer is an obvious stutter; a
missing one loses the feature invisibly behind a silent four-second `<Gather>`.

Static audio is served by `server/routes/voiceAssets.js`, split from `voice.js`
for the reason `voicemailListen.js` was (the 700-line soft cap), with
`GET /greeting.mp3` keeping its exact path because `VM_GREETING_URL` defaults to
that URL.

### 6. What changes at each call site

**`voice.js` missed handler.** Picks `greeting_day` or `greeting_night`, and
emits the `<Gather>` only when `escalationEnabled() && !isNight()`. At night the
document is greeting plus `<Record>`, with no `<Gather>` and no escalation
prompt.

**HARD CONSTRAINT: `server/routes/voice.js` is at 695 lines against a 700-line
soft cap.** All new logic lives in `voicemailTwiml.js` (94 lines) and
`voicemailLine.js` (176 lines). The change inside `voice.js` must be a net-neutral
swap of one expression for another, not new branching.

**`voiceEscalate.js` `/`.** Prepends the `escalate_ack` verb to the `<Dial>`
document, so acknowledgment precedes ringing.

**`voiceEscalate.js` `recordTwiml()`.** Prepends the `escalate_failed` verb. This
single change covers all 7 call sites at once, which is why the fix belongs in
that helper and not at the branches.

### 7. A boundary case, decided

A call that starts at 8:59pm is offered press 1, and the caller may press it at
9:01pm, after the window has flipped. **We honor it.** `/escalate` does NOT
re-check `isNight()`. Having made the offer, withdrawing it silently is worse
than a two-minute edge in which one phone rings. This also keeps the night check
in exactly one place.

## Error handling

- Unparseable `VM_NIGHT_WINDOW` or bad `VM_NIGHT_TZ`: warn once, treat as day.
  Never throw on a live call.
- A slot whose env URL is set but unreachable: this is Twilio's fetch, not ours.
  `<Play>` failing mid-document is an existing risk on the greeting today and is
  not made worse. Not addressed here.
- Everything else on these paths keeps its current fail-closed signature checks
  and rate limiters, untouched.

## Testing

- Golden TwiML for both lines in BOTH modes: night emits no `<Gather>` and no
  escalation prompt; day is byte-identical to today except for the added slots.
- `isNight` at the boundaries (20:59, 21:00, 08:59, 09:00), across midnight, and
  across a DST transition, with time injected rather than mocked globally.
- Unparseable window and bad zone both resolve to day.
- Each of the 7 `recordTwiml` call sites carries `escalate_failed`.
- `/escalate` emits `escalate_ack` BEFORE `<Dial>` in document order.
- `/escalate` honors a press that arrives after the boundary flips.
- Slot resolution: unset gives `<Say>`, `say` gives `<Say>`, an https URL gives
  `<Play>`, per line and per slot.
- `VM_ESCALATION_ENABLED=false` still produces the pre-feature document.

## Environment variables

| Variable | Purpose |
|---|---|
| `VM_NIGHT_WINDOW` | Night window, strict `HH:MM-HH:MM`, default `21:00-09:00`. May wrap midnight. Unparseable means always day. |
| `VM_NIGHT_TZ` | IANA zone for the window, default `America/Chicago`. Bad zone means always day. |
| `VM_NIGHT_GREETING_URL_PRIMARY` / `VM_NIGHT_GREETING_URL` | Night greeting per line. Same contract as `VM_GREETING_URL`. |
| `VM_ESCALATE_ACK_URL_PRIMARY` / `VM_ESCALATE_ACK_URL` | Press-1 acknowledgment per line. |
| `VM_ESCALATE_FAILED_URL_PRIMARY` / `VM_ESCALATE_FAILED_URL` | Escalation-failed message per line. |

`VM_GREETING_URL_PRIMARY` and `VM_GREETING_URL` are unchanged in name and
contract, and now formally mean the DAY greeting.

## Out of scope / deferred

- **Hold music.** Rejected above, on the merits, not deferred.
- **Dynamic on-call:** ringing whoever is actually on shift from presence and
  staffing data, rather than a fixed "other person." Still the phase 1a design's
  deferral.
- **Transcription, AI triage, R2 copy, the listen PAGE with delete.** Designed in
  the 2026-07-26 spec, still unbuilt, untouched here.
- **A third time band** for early morning. Explicitly declined in copy above.
- **Phase 2** (A2P, reuniting SMS and voice on the 1922). Externally gated.

## Decisions locked in brainstorm

1. Narrate state, never schedule. No sentence claims we are open or closed.
2. No hold music. Ringback is true information; music is not.
3. One night window, 21:00 to 09:00 America/Chicago, both lines.
4. Night suppresses the press-1 offer entirely, and promises "in the morning."
5. Four message slots per line, every one with a synthetic default, so no
   recording blocks the fix.
6. A press-1 offered before the boundary is honored after it.
7. `greeting_day` reuses the existing env var names, so Render needs no change to
   keep working.
