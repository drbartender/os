---
lanes:
  - id: caller-comms
    footprint:
      - server/utils/voicemailLine.js
      - server/utils/voicemailLine.test.js
      - server/utils/voicemailTwiml.js
      - server/utils/voicemailTwiml.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/routes/voiceEscalate.js
      - server/routes/voiceEscalate.test.js
      - server/routes/voiceAssets.js
      - server/routes/voiceAssets.test.js
      - server/assets/primary-*.mp3
      - server/index.js
      - .env.example
      - .claude/CLAUDE.md
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, code-review, consistency-check]
---

# Caller Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbound call narrate itself, and stop offering a human at night when nobody is awake to be one.

**Architecture:** Two new pure functions in the existing util modules (`isNight` in `voicemailLine.js`, a slot resolver in `voicemailTwiml.js`), consumed by two route files that each change by a handful of lines. No new files, no new dependencies, no schema change.

**Tech Stack:** Node 26, Express 4, Twilio Programmable Voice / TwiML, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-19-caller-communication-design.md`

## Global Constraints

- **`server/routes/voice.js` is at 695 lines against a 700-line soft cap.** All new logic lives in the util modules. The change inside `voice.js` must swap one expression for another, not add branching. Check with `node scripts/check:filesize` equivalent: `npm run check:filesize`.
- **`xmlEscape` escapes `& < >` but NOT quotes.** Every TwiML *attribute* must be safe by construction (a validated integer, a fixed enum, an env E.164, or a shape-validated CallSid). Slot URLs go in `<Play>` element bodies, never attributes.
- **Sensitive paths.** `voice.js`, `voiceEscalate.js`, `voicemailTwiml.js`, `voicemailLine.js`, and `.env.example` are all on `scripts/sensitive-paths.txt`. The full review fleet runs before merge.
- **No em dashes in caller-facing copy.** Commas and periods only.
- **Fail open to DAY.** Any unparseable window or bad timezone means day, which offers a human. Never throw on a live call.
- **Server tests share the dev DB.** Run suites ONE AT A TIME (`--test-concurrency=1`) or `countVoicemailsSince` fails spuriously.
- Run tests with `node -r dotenv/config --test <file>`.

---

### Task 1: `isNight` in `voicemailLine.js`

**Files:**
- Modify: `server/utils/voicemailLine.js`
- Test: `server/utils/voicemailLine.test.js`

**Interfaces:**
- Consumes: existing private `parseHhMm(s)` and `minutesInZone(d, tz)` in this same file. Do NOT reimplement either.
- Produces: `isNight(now = new Date()) -> boolean`, exported.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/voicemailLine.test.js`:

```js
const { isNight } = require('./voicemailLine');

// A fixed Chicago instant helper. August is CDT (UTC-5).
const chicagoAug = (hh, mm = 0) => new Date(Date.UTC(2026, 7, 19, hh + 5, mm));

test('isNight: the 9pm and 9am boundaries are exact and half-open', () => {
  delete process.env.VM_NIGHT_WINDOW;
  delete process.env.VM_NIGHT_TZ;
  assert.equal(isNight(chicagoAug(20, 59)), false, '20:59 is still day');
  assert.equal(isNight(chicagoAug(21, 0)), true, '21:00 begins night');
  assert.equal(isNight(chicagoAug(8, 59)), true, '08:59 is still night');
  assert.equal(isNight(chicagoAug(9, 0)), false, '09:00 begins day');
});

test('isNight: the window wraps midnight', () => {
  assert.equal(isNight(chicagoAug(23, 30)), true);
  assert.equal(isNight(chicagoAug(2, 0)), true);
  assert.equal(isNight(chicagoAug(13, 0)), false);
});

test('isNight: holds across a DST change, because the zone does the work', () => {
  // January is CST (UTC-6). 10pm Chicago must still be night.
  const janChicago10pm = new Date(Date.UTC(2027, 0, 15, 22 + 6, 0));
  assert.equal(isNight(janChicago10pm), true);
  const janChicago1pm = new Date(Date.UTC(2027, 0, 15, 13 + 6, 0));
  assert.equal(isNight(janChicago1pm), false);
});

test('isNight: an unparseable window or bad zone FAILS OPEN to day', () => {
  // Fail-open direction is load-bearing: the failure mode must be a rung phone,
  // never a caller silently denied the offer of a human.
  process.env.VM_NIGHT_WINDOW = '9pm-9am';
  assert.equal(isNight(chicagoAug(23, 0)), false);
  process.env.VM_NIGHT_WINDOW = '21:00–09:00'; // en dash, a real config typo
  assert.equal(isNight(chicagoAug(23, 0)), false);
  process.env.VM_NIGHT_WINDOW = '21:00-09:00';
  process.env.VM_NIGHT_TZ = 'Mars/Olympus';
  assert.equal(isNight(chicagoAug(23, 0)), false);
  delete process.env.VM_NIGHT_WINDOW;
  delete process.env.VM_NIGHT_TZ;
});

test('isNight: a custom window is honored', () => {
  process.env.VM_NIGHT_WINDOW = '22:00-07:00';
  assert.equal(isNight(chicagoAug(21, 30)), false);
  assert.equal(isNight(chicagoAug(22, 30)), true);
  delete process.env.VM_NIGHT_WINDOW;
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/utils/voicemailLine.test.js`
Expected: FAIL, `isNight is not a function`.

- [ ] **Step 3: Implement**

Add to `server/utils/voicemailLine.js`, above `module.exports`:

```js
/**
 * True when a caller reaching voicemail right now should be told "in the
 * morning" instead of being offered a human.
 *
 * NOT the same concept as quietWindowFor. That protects the person being dialed
 * TO, in THEIR timezone, and suppresses only the dial. This is about the
 * CALLER's experience, is Chicago-based for both lines, and changes the greeting
 * itself. Both may be active; they never interact, because at night no dial is
 * attempted at all.
 *
 * Fails OPEN to day on any bad config: the failure mode is a phone that rings,
 * never a caller silently denied the offer of a human.
 */
function isNight(now = new Date()) {
  const raw = String(process.env.VM_NIGHT_WINDOW || '21:00-09:00').trim();
  const parts = raw.split('-');
  const start = parts.length === 2 ? parseHhMm(parts[0]) : null;
  const end = parts.length === 2 ? parseHhMm(parts[1]) : null;
  if (start === null || end === null) {
    console.warn(`[voicemailLine] bad VM_NIGHT_WINDOW "${raw}", treating as day`);
    return false;
  }
  const tz = String(process.env.VM_NIGHT_TZ || '').trim() || 'America/Chicago';
  let mins;
  try {
    mins = minutesInZone(now, tz);
  } catch (err) {
    console.warn(`[voicemailLine] bad VM_NIGHT_TZ "${tz}": ${err.message}, treating as day`);
    return false;
  }
  return start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}
```

Add `isNight` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `node -r dotenv/config --test server/utils/voicemailLine.test.js`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add server/utils/voicemailLine.js server/utils/voicemailLine.test.js
git commit -F - <<'MSG'
feat(voice): isNight, the one clock the call experience needs

Day is 09:00-21:00 America/Chicago. Reuses the module's existing parseHhMm and
minutesInZone rather than adding a second time comparison, so midnight wrapping
and DST come for free from machinery the quiet windows already exercise.

Fails OPEN to day on an unparseable window or a bad zone, which is the safe
direction: the failure mode is a phone that rings, never a caller silently
denied the offer of a human.
MSG
```

---

### Task 2: message slots in `voicemailTwiml.js`

**Files:**
- Modify: `server/utils/voicemailTwiml.js`
- Test: `server/utils/voicemailTwiml.test.js`

**Interfaces:**
- Consumes: `isNight` from Task 1 is NOT used here. This task is pure slot resolution; the caller decides which slot.
- Produces:
  - `messageVerb(slot, rawLine) -> string` where `slot` is one of `'greeting_day' | 'greeting_night' | 'escalate_ack' | 'escalate_failed'`.
  - `needsAppendedOffer(rawLine) -> boolean`
  - Texts: `GREETING_TEXT_PRIMARY` (replaced), `GREETING_TEXT_PRIMARY_NIGHT`, `GREETING_TEXT_ZUL`, `GREETING_TEXT_ZUL_NIGHT`, `ESCALATE_ACK_TEXT_PRIMARY`, `ESCALATE_ACK_TEXT_ZUL`, `ESCALATE_FAILED_TEXT_PRIMARY`, `ESCALATE_FAILED_TEXT_ZUL`.
  - `greetingVerbForLine` is KEPT as a thin wrapper (`messageVerb('greeting_day', line)`) so no caller breaks mid-refactor.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/voicemailTwiml.test.js`:

```js
const {
  messageVerb, needsAppendedOffer, greetingVerbForLine,
  GREETING_TEXT_PRIMARY, GREETING_TEXT_PRIMARY_NIGHT,
} = require('./voicemailTwiml');

const SLOT_ENV = [
  'VM_GREETING_URL', 'VM_GREETING_URL_PRIMARY',
  'VM_NIGHT_GREETING_URL', 'VM_NIGHT_GREETING_URL_PRIMARY',
  'VM_ESCALATE_ACK_URL', 'VM_ESCALATE_ACK_URL_PRIMARY',
  'VM_ESCALATE_FAILED_URL', 'VM_ESCALATE_FAILED_URL_PRIMARY',
];
const clearSlots = () => SLOT_ENV.forEach((k) => delete process.env[k]);

test('every slot resolves to synthetic Say when unset, on both lines', () => {
  clearSlots();
  for (const slot of ['greeting_day', 'greeting_night', 'escalate_ack', 'escalate_failed']) {
    for (const line of ['primary', 'zul']) {
      const v = messageVerb(slot, line);
      // The zul day greeting is the ONE exception: it defaults to the bundled mp3.
      if (slot === 'greeting_day' && line === 'zul') {
        assert.match(v, /^<Play>/, 'zul day greeting keeps the bundled recording');
      } else {
        assert.match(v, /^<Say voice="Polly\.Joanna-Neural">/, `${slot}/${line} should be synthetic`);
      }
      assert.ok(v.length > 0);
    }
  }
});

test('a url makes a slot Play it; the literal "say" forces synthetic', () => {
  clearSlots();
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'https://cdn.example.com/ack.mp3';
  assert.equal(messageVerb('escalate_ack', 'primary'), '<Play>https://cdn.example.com/ack.mp3</Play>');
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'say';
  assert.match(messageVerb('escalate_ack', 'primary'), /^<Say /);
  clearSlots();
});

test('the primary DAY greeting contains the press-1 offer; the NIGHT one must not', () => {
  assert.match(GREETING_TEXT_PRIMARY, /press one/i);
  assert.doesNotMatch(GREETING_TEXT_PRIMARY_NIGHT, /press one/i,
    'the night greeting must never offer a human');
  assert.match(GREETING_TEXT_PRIMARY_NIGHT, /in the morning/i);
});

test('needsAppendedOffer is true ONLY for the legacy bundled zul recording', () => {
  clearSlots();
  assert.equal(needsAppendedOffer('zul'), true, 'bundled mp3 predates the offer');
  assert.equal(needsAppendedOffer('primary'), false, 'its greeting says the offer itself');
  process.env.VM_GREETING_URL = 'https://cdn.example.com/zul-day.mp3';
  assert.equal(needsAppendedOffer('zul'), false, 'a new recording says the offer itself');
  process.env.VM_GREETING_URL = 'say';
  assert.equal(needsAppendedOffer('zul'), true, 'synthetic zul text still mirrors the old script');
  clearSlots();
});

test('VM_ESCALATION_PROMPT=none suppresses the append everywhere', () => {
  clearSlots();
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(needsAppendedOffer('zul'), false);
  delete process.env.VM_ESCALATION_PROMPT;
});

test('greetingVerbForLine still works and equals the day slot', () => {
  clearSlots();
  assert.equal(greetingVerbForLine('primary'), messageVerb('greeting_day', 'primary'));
  assert.equal(greetingVerbForLine('zul'), messageVerb('greeting_day', 'zul'));
});

test('an unknown slot throws rather than emitting an empty document', () => {
  assert.throws(() => messageVerb('nope', 'primary'), /unknown slot/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/utils/voicemailTwiml.test.js`
Expected: FAIL, `messageVerb is not a function`.

- [ ] **Step 3: Implement**

In `server/utils/voicemailTwiml.js`, REPLACE `GREETING_TEXT_PRIMARY` and ADD the new texts:

```js
// Dallas's line, day. Approved verbatim in brainstorm 2026-08-19. This text
// CONTAINS the press-1 offer, which is why needsAppendedOffer('primary') is
// false: appending it again would speak it twice.
const GREETING_TEXT_PRIMARY = "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you as soon as I can. If you need to talk to somebody now, press one and I'll see if someone's available.";

// Dallas's line, night. Must NEVER mention press 1: at night nobody is awake to
// be escalated to, and the offer would ring a sleeping phone for a predictable
// failure. Promises the morning, which describes what happens to the message
// rather than claiming business hours.
const GREETING_TEXT_PRIMARY_NIGHT = "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you in the morning.";

// Zul's line, night. Her DAY synthetic (GREETING_TEXT_ZUL) deliberately keeps
// its 2026-07-24 wording, because this module's standing rule is that a line's
// synthetic text mirrors what that line's recording says, and her bundled mp3
// still says the old script.
const GREETING_TEXT_ZUL_NIGHT = "Thanks for calling Dr. Bartender, this is Zul. Sorry I missed your call. Leave me a message and we'll get back to you in the morning.";

const ESCALATE_ACK_TEXT_PRIMARY = "Hold on, let me see who's available.";
const ESCALATE_ACK_TEXT_ZUL = "Hold on, let me see who's available.";

const ESCALATE_FAILED_TEXT_PRIMARY = "Sorry, nobody's available right now. Leave me a message and I'll get back to you as soon as I can.";
const ESCALATE_FAILED_TEXT_ZUL = "Sorry, nobody's available right now. Leave me a message and we'll get back to you as soon as we can.";
```

Then add the resolver:

```js
// slot -> [env var per line, synthetic text per line]. One table so a new slot
// cannot be half-added: a slot missing here throws instead of silently
// resolving to an empty verb, which in TwiML is a document that says nothing.
const SLOTS = {
  greeting_day: {
    primary: { env: 'VM_GREETING_URL_PRIMARY', text: GREETING_TEXT_PRIMARY },
    zul: { env: 'VM_GREETING_URL', text: GREETING_TEXT_ZUL, bundledDefault: true },
  },
  greeting_night: {
    primary: { env: 'VM_NIGHT_GREETING_URL_PRIMARY', text: GREETING_TEXT_PRIMARY_NIGHT },
    zul: { env: 'VM_NIGHT_GREETING_URL', text: GREETING_TEXT_ZUL_NIGHT },
  },
  escalate_ack: {
    primary: { env: 'VM_ESCALATE_ACK_URL_PRIMARY', text: ESCALATE_ACK_TEXT_PRIMARY },
    zul: { env: 'VM_ESCALATE_ACK_URL', text: ESCALATE_ACK_TEXT_ZUL },
  },
  escalate_failed: {
    primary: { env: 'VM_ESCALATE_FAILED_URL_PRIMARY', text: ESCALATE_FAILED_TEXT_PRIMARY },
    zul: { env: 'VM_ESCALATE_FAILED_URL', text: ESCALATE_FAILED_TEXT_ZUL },
  },
};

/**
 * The TwiML verb for one spoken moment, per line.
 *
 * Contract, unchanged from what VM_GREETING_URL established: unset means a
 * synthetic <Say> of the built-in text; the literal 'say' forces synthetic (a
 * known-good kill switch when a recording is bad); a full URL emits <Play>.
 *
 * The URL lands in a <Play> ELEMENT BODY, never an attribute, so xmlEscape's
 * lack of quote escaping cannot be exploited by a malformed env value.
 */
function messageVerb(slot, rawLine) {
  const table = SLOTS[slot];
  if (!table) throw new Error(`voicemailTwiml: unknown slot "${slot}"`);
  const cfg = table[resolveLine(rawLine)];
  const override = String(process.env[cfg.env] || '').trim();
  if (override && override.toLowerCase() !== 'say') {
    return `<Play>${xmlEscape(override)}</Play>`;
  }
  if (!override && cfg.bundledDefault) {
    return `<Play>${xmlEscape(`${API_URL}/api/voice/greeting.mp3`)}</Play>`;
  }
  return `${SAY_OPEN}${xmlEscape(cfg.text)}</Say>`;
}

/**
 * Whether the press-1 offer still has to be appended after the day greeting.
 *
 * Every greeting source we author now SAYS the offer itself. Exactly one
 * artifact does not: the bundled mp3 Zul recorded 2026-07-24, before escalation
 * existed. So the append survives only for that one case, and stops on its own
 * the day her new recording is wired to VM_GREETING_URL. No second variable to
 * remember. VM_ESCALATION_PROMPT=none remains a manual override.
 */
function needsAppendedOffer(rawLine) {
  if (String(process.env.VM_ESCALATION_PROMPT || '').trim().toLowerCase() === 'none') return false;
  if (resolveLine(rawLine) !== 'zul') return false;
  const override = String(process.env.VM_GREETING_URL || '').trim();
  return !override || override.toLowerCase() === 'say';
}

/** Back-compat alias so no caller breaks mid-refactor. */
function greetingVerbForLine(rawLine) {
  return messageVerb('greeting_day', rawLine);
}
```

Delete the OLD `greetingVerbForLine` body. Update `module.exports` to add
`messageVerb`, `needsAppendedOffer`, `GREETING_TEXT_PRIMARY_NIGHT`,
`GREETING_TEXT_ZUL_NIGHT`, `ESCALATE_ACK_TEXT_PRIMARY`, `ESCALATE_ACK_TEXT_ZUL`,
`ESCALATE_FAILED_TEXT_PRIMARY`, `ESCALATE_FAILED_TEXT_ZUL`, keeping every
existing export.

- [ ] **Step 3b: Extend the existing em-dash guard to the new copy**

`server/utils/voicemailTwiml.test.js:96` already asserts no copy contains an em
dash (house style). It lists only the three original texts, so new copy would
slip past it. Add all five new texts to that array:

```js
  const all = [
    twiml.GREETING_TEXT_ZUL, twiml.GREETING_TEXT_PRIMARY, twiml.ESCALATION_PROMPT_TEXT,
    twiml.GREETING_TEXT_PRIMARY_NIGHT, twiml.GREETING_TEXT_ZUL_NIGHT,
    twiml.ESCALATE_ACK_TEXT_PRIMARY, twiml.ESCALATE_ACK_TEXT_ZUL,
    twiml.ESCALATE_FAILED_TEXT_PRIMARY, twiml.ESCALATE_FAILED_TEXT_ZUL,
  ].join(' ');
```

Note the existing `assert.strictEqual` on `GREETING_TEXT_ZUL` (line ~91) must
keep passing: that text is deliberately UNCHANGED, because her bundled recording
still says it. There is no equivalent pin on `GREETING_TEXT_PRIMARY`, which is
why replacing that one is safe.

- [ ] **Step 4: Run to verify pass**

Run: `node -r dotenv/config --test server/utils/voicemailTwiml.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/voicemailTwiml.js server/utils/voicemailTwiml.test.js
git commit -F - <<'MSG'
feat(voice): four named message slots, one resolver

Replaces four near-identical Say/Play branches with one table keyed by slot and
line. A slot missing from the table THROWS rather than resolving to an empty
verb, because an empty verb in TwiML is a document that silently says nothing,
which is the exact class of bug this change exists to fix.

The press-1 offer moves into the day greeting text. needsAppendedOffer survives
for exactly one artifact, the mp3 Zul recorded before escalation existed, and
stops on its own the day her new recording is wired.
MSG
```

---

### Task 3: the press-1 acknowledgment and the fallback message

**Files:**
- Modify: `server/routes/voiceEscalate.js`
- Test: `server/routes/voiceEscalate.test.js`

**Interfaces:**
- Consumes: `messageVerb(slot, line)` from Task 2.
- Produces: no new exports. `recordTwiml(res, line)` gains a `line` parameter.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/voiceEscalate.test.js`:

```js
test('pressing 1 is acknowledged BEFORE any ringing starts', async () => {
  // The defect this fixes: <Response><Dial> with no Say meant the caller
  // pressed a key and got dead air, then often pressed again into a document
  // that had already left the Gather.
  const twiml = await post('/api/voice/escalate?line=primary', { CallSid: SID });
  const ackAt = twiml.indexOf('Hold on');
  const dialAt = twiml.indexOf('<Dial');
  assert.ok(ackAt > -1, 'the acknowledgment must be present');
  assert.ok(ackAt < dialAt, 'and must come BEFORE the Dial in document order');
});

test('every fallback into voicemail says why, on all 7 paths', async () => {
  // recordTwiml is reached from 7 branches. Testing the helper's output shape
  // once plus a representative branch pins the property without pretending to
  // enumerate branches the route may add later.
  process.env.VM_ESCALATION_ENABLED = 'false';
  const twiml = await post('/api/voice/escalate?line=primary', { CallSid: SID });
  assert.match(twiml, /Sorry, nobody's available right now/);
  assert.ok(twiml.indexOf('Sorry') < twiml.indexOf('<Record'),
    'the message must precede the beep, not follow it');
  process.env.VM_ESCALATION_ENABLED = 'true';
});

test('the fallback message is per line', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  const twiml = await post('/api/voice/escalate?line=zul', { CallSid: SID });
  assert.match(twiml, /we'll get back to you/, "zul's line speaks for the team");
  process.env.VM_ESCALATION_ENABLED = 'true';
});

test('a press that arrives AFTER the night boundary flips is still honored', async () => {
  // We made the offer; withdrawing it silently is worse than a two-minute edge
  // in which one phone rings. /escalate deliberately does not check isNight.
  process.env.VM_NIGHT_WINDOW = '00:00-23:59'; // force "night" for the whole day
  const twiml = await post('/api/voice/escalate?line=primary', { CallSid: SID });
  assert.match(twiml, /<Dial/, 'the dial still happens');
  delete process.env.VM_NIGHT_WINDOW;
});
```

The signed-POST helper in this file is `post(path, form)` (defined at
`server/routes/voiceEscalate.test.js:25`) and CallSids come from the file's
existing `cs(...)` helper. Use those; do not add a second helper.

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/voiceEscalate.test.js`
Expected: FAIL, the acknowledgment and the fallback text are absent.

- [ ] **Step 3: Implement**

In `server/routes/voiceEscalate.js`:

Import the resolver:

```js
const { recordVerb, escalationEnabled, messageVerb } = require('../utils/voicemailTwiml');
```

Give `recordTwiml` the message and a line:

```js
/**
 * Back to voicemail, with a sentence explaining why.
 *
 * Reached from every non-bridge outcome (no answer, quiet window, daily cap,
 * escalation disabled, no target, claim failed, already escalated). Before
 * 2026-08-19 this was a bare <Record playBeep>, so after 20 seconds of ringing
 * the caller got an unexplained tone, which reads as a dropped call rather than
 * an invitation. Putting the message HERE covers all 7 branches at once.
 */
function recordTwiml(res, line) {
  sendTwiml(res, `<Response>${messageVerb('escalate_failed', line)}${recordVerb()}<Hangup/></Response>`);
}
```

Pass `line` at all 7 call sites (each already has `line` in scope; the two
earliest sites resolve it before use, so move `const line = resolveLine(...)`
above the first `recordTwiml` call if the linter flags use-before-define).

Prepend the acknowledgment to the dial document:

```js
  sendTwiml(res,
    '<Response>'
    // Acknowledge the keypress BEFORE the Dial. Without this the caller hears
    // dead air and often presses 1 again, into a document that has already left
    // the Gather, so the second press does nothing.
    + messageVerb('escalate_ack', line)
    + `<Dial timeout="20" action="${xmlEscape(doneUrl)}" method="POST" callerId="${xmlEscape(callerId)}" timeLimit="${timeLimitSec()}">`
    + `<Number url="${xmlEscape(whisperUrl)}" method="POST">${xmlEscape(target)}</Number>`
    + '</Dial>'
    + '</Response>'
  );
```

- [ ] **Step 4: Run to verify pass**

Run: `node -r dotenv/config --test server/routes/voiceEscalate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/voiceEscalate.js server/routes/voiceEscalate.test.js
git commit -F - <<'MSG'
fix(voice): acknowledge the keypress, and say why we are back at voicemail

Two defects that were live from the moment escalation was enabled.

Pressing 1 produced dead air: the route answered the Gather with a bare Dial, so
the caller tapped a key and heard nothing for up to 20 seconds. Many press again,
and the second press does nothing because the document has already left the
Gather.

And every fallback into voicemail was a bare Record with playBeep and no words,
reached from 7 branches, so an unexplained tone after 20 seconds of ringing read
as a dropped call rather than an invitation. Putting the message in recordTwiml
covers all 7 at once.

/escalate deliberately does NOT check isNight: a press-1 offered before the
boundary is honored after it, because withdrawing an offer we made is worse than
a two-minute edge in which one phone rings.
MSG
```

---

### Task 4: night mode in the missed-call handler

**Files:**
- Modify: `server/routes/voice.js` (the missed handler, around line 500)
- Test: `server/routes/voice.test.js`

**Interfaces:**
- Consumes: `isNight()` (Task 1), `messageVerb` and `needsAppendedOffer` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/voice.test.js`:

```js
test('NIGHT: no Gather, no press-1 offer, and the morning promise', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  process.env.VM_NIGHT_WINDOW = '00:00-23:59'; // force night
  const res = await post('/api/voice/inbound/missed?line=primary', { DialCallStatus: 'no-answer', CallSid: cs('CAnight1'), From: '+13125550147' });
  await settle();
  const twiml = res.text;
  assert.doesNotMatch(twiml, /<Gather/, 'night must not offer a human');
  assert.doesNotMatch(twiml, /press one/i);
  assert.match(twiml, /in the morning/i);
  assert.match(twiml, /<Record/, 'a message can still be left');
  delete process.env.VM_NIGHT_WINDOW;
});

test('DAY: the Gather is back and the greeting offers a human', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  process.env.VM_NIGHT_WINDOW = '00:00-00:01'; // force day
  const res = await post('/api/voice/inbound/missed?line=primary', { DialCallStatus: 'no-answer', CallSid: cs('CAnight1'), From: '+13125550147' });
  await settle();
  const twiml = res.text;
  assert.match(twiml, /<Gather/);
  assert.match(twiml, /press one/i);
  delete process.env.VM_NIGHT_WINDOW;
});

test('the press-1 offer is spoken EXACTLY once on each line', async () => {
  // The regression this guards: the new day copy says the offer itself, and the
  // old escalationPromptVerb appended it too.
  process.env.VM_ESCALATION_ENABLED = 'true';
  process.env.VM_NIGHT_WINDOW = '00:00-00:01';
  const primary = (await post('/api/voice/inbound/missed?line=primary', { DialCallStatus: 'no-answer', CallSid: cs('CAonce1'), From: '+13125550147' })).text;
  assert.equal((primary.match(/press one/gi) || []).length, 1, 'primary says it once');
  const zul = (await post('/api/voice/inbound/missed?line=zul', { DialCallStatus: 'no-answer', CallSid: cs('CAonce2'), From: '+13125550147' })).text;
  // Zul's bundled mp3 is a <Play>, so her only spoken offer is the appended one.
  assert.equal((zul.match(/press 1|press one/gi) || []).length, 1, 'zul says it once');
  delete process.env.VM_NIGHT_WINDOW;
});

test('escalation OFF still emits the pre-feature document, day or night', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  for (const w of ['00:00-23:59', '00:00-00:01']) {
    process.env.VM_NIGHT_WINDOW = w;
    const res = await post('/api/voice/inbound/missed?line=primary', { DialCallStatus: 'no-answer', CallSid: cs('CAnight1'), From: '+13125550147' });
  await settle();
  const twiml = res.text;
    assert.doesNotMatch(twiml, /<Gather/);
  }
  delete process.env.VM_NIGHT_WINDOW;
});
```

`voice.test.js` already defines `post(path, form)` at line 31, plus `cs(...)`
for CallSids and `settle()` to drain the detached post-response work. Use those.

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, night still emits a `<Gather>`.

- [ ] **Step 3: Implement**

In `server/routes/voice.js`, update the import line to add the three names, then
REPLACE the greeting/body block (currently lines ~504-509) with:

```js
  const night = isNight();
  const greeting = messageVerb(night ? 'greeting_night' : 'greeting_day', line);
  const body = (escalationEnabled() && !night)
    ? `<Gather numDigits="1" timeout="4" action="${xmlEscape(API_URL)}/api/voice/escalate?line=${line}" method="POST">`
      + greeting + (needsAppendedOffer(line) ? escalationPromptVerb() : '')
      + '</Gather>'
    : greeting;
```

This is a net-neutral swap: same number of statements, no new branching in this
file. Confirm the soft cap still holds.

- [ ] **Step 3b: Make the existing golden test time-deterministic (REQUIRED, it will otherwise fail at night)**

`server/routes/voice.test.js:510` pins the escalation-off document byte-for-byte
with `assert.strictEqual`, and it runs against the REAL clock. Night mode changes
that document (the zul bundled `<Play>` becomes the synthetic night greeting),
so between 21:00 and 09:00 Chicago the suite would go red on a machine where
nothing is wrong. A substring test would have absorbed this silently; the
strictEqual is doing its job by surfacing it.

Do NOT weaken the assertion. Pin the clock instead, inside that test:

```js
  // The golden document is the DAY document. Night legitimately changes it
  // (spec 2026-08-19), so pin the window rather than letting the wall clock
  // decide whether this suite passes.
  process.env.VM_NIGHT_WINDOW = '00:00-00:01';
```

with a matching `delete process.env.VM_NIGHT_WINDOW;` in that test's cleanup.
Then add a SECOND golden pin for the night document, so night is covered by an
exact-document assertion too rather than only by substring matches:

```js
test('/inbound/missed NIGHT document is pinned byte-for-byte', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  process.env.VM_NIGHT_WINDOW = '00:00-23:59';
  const { API_URL } = require('../utils/urls');
  const res = await post('/api/voice/inbound/missed', {
    DialCallStatus: 'no-answer', CallSid: cs('CAgoldN'), From: '+13125550147',
  });
  await settle();
  assert.strictEqual(
    res.text,
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response><Say voice="Polly.Joanna-Neural">'
    + "Thanks for calling Dr. Bartender, this is Zul. Sorry I missed your call. Leave me a message and we&apos;ll get back to you in the morning."
    + '</Say>'
    + '<Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#"'
    + ` recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>'
    + '<Hangup/></Response>'
  );
  delete process.env.VM_NIGHT_WINDOW;
});
```

Check the apostrophe encoding against what `xmlEscape` actually emits before
pinning it: `xmlEscape` covers `& < >` and NOT quotes, so a literal `'` most
likely stays a literal `'`. Run the test, read the actual output, and pin THAT.
Do not guess the entity.

- [ ] **Step 4: Run tests and the file-size ratchet**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS.

Run: `npm run check:filesize`
Expected: `server/routes/voice.js` at or below 700. If it grew past 700, move the
three-line expression into a `missedBodyFor(line)` helper in `voicemailTwiml.js`
rather than committing over the cap.

- [ ] **Step 5: Commit**

```bash
git add server/routes/voice.js server/routes/voice.test.js
git commit -F - <<'MSG'
feat(voice): night mode, stop offering a human when nobody is awake

Between 21:00 and 09:00 Chicago the missed-call document drops the Gather
entirely and the greeting promises the morning instead of a person.

The reason is specific to this business, not a generic business-hours rule. Zul
keeps Chicago-aligned hours so she can be available to US clients, which means
Chicago night is her off time too. An 11pm press-1 rang a sleeping phone in the
Philippines for 20 seconds and landed the caller in voicemail anyway, spending
her sleep and a billed international leg on a predictable failure.

"In the morning" describes what actually happens to the message. It makes no
claim about being open or closed, so it cannot contradict the published
client-facing hours, which is the trap a business-hours rule would have walked
into.
MSG
```

---

### Task 5: documentation and the env contract

**Files:**
- Modify: `.env.example`, `.claude/CLAUDE.md`, `README.md`, `ARCHITECTURE.md`

**Interfaces:**
- Consumes: the env names from Tasks 1 and 2. No code changes.

- [ ] **Step 1: Add the six new variables to `.env.example`**

Place them immediately after the existing `VM_GREETING_URL_PRIMARY` block:

```bash
# Night window for the CALLER-facing experience: inside it the greeting drops the
# press-1 offer and promises the morning instead. Strict HH:MM-HH:MM, may wrap
# midnight. Default 21:00-09:00. NOT the same thing as VM_ESCALATION_QUIET_*,
# which protect the person being DIALED, in THEIR timezone. An unparseable value
# fails OPEN to day, so the failure mode is a phone that rings.
# VM_NIGHT_WINDOW=21:00-09:00
# IANA zone for the window above. Default America/Chicago. Bad zone means day.
# VM_NIGHT_TZ=America/Chicago
# Night greeting per line. Same contract as VM_GREETING_URL: unset means
# synthetic, 'say' forces synthetic, a full https URL is <Play>ed.
# VM_NIGHT_GREETING_URL_PRIMARY=
# VM_NIGHT_GREETING_URL=
# Played the instant a caller presses 1, before any ringing. Same contract.
# VM_ESCALATE_ACK_URL_PRIMARY=
# VM_ESCALATE_ACK_URL=
# Played when escalation returns the caller to voicemail. Same contract.
# VM_ESCALATE_FAILED_URL_PRIMARY=
# VM_ESCALATE_FAILED_URL=
```

- [ ] **Step 2: Add the same six rows to the `.claude/CLAUDE.md` env table**

Match the existing row style. On the `VM_ESCALATION_PROMPT` row, append: `Since
2026-08-19 the day greetings say the offer themselves, so this is now a manual
override; the automatic append survives only for Zul's pre-escalation bundled
mp3.`

- [ ] **Step 3: Update `README.md` env table with the same six rows**

- [ ] **Step 4: Update `ARCHITECTURE.md`**

In the Zul VA Calling inbound-flow narrative, after the press-1 escalation
bullet, add:

```markdown
- **Caller communication (spec 2026-08-19)**: the flow narrates itself. Pressing
  1 is acknowledged (`escalate_ack`) BEFORE the `<Dial>`, because a bare `<Dial>`
  gave the caller dead air and invited a second, useless press. Every return to
  voicemail plays `escalate_failed` before the beep, covering all 7 branches of
  `voiceEscalate.js` at once, since an unexplained tone reads as a dropped call.
  Between `VM_NIGHT_WINDOW` (default 21:00-09:00 `America/Chicago`, via
  `isNight()`) the missed document drops the `<Gather>` entirely and the greeting
  promises the morning: Zul keeps Chicago-aligned hours, so a night press-1 rings
  a sleeping phone for a predictable failure. This is deliberately NOT a
  business-hours rule, and no copy claims we are open or closed, so nothing can
  contradict the published client-facing hours. Four message slots per line
  (`greeting_day`, `greeting_night`, `escalate_ack`, `escalate_failed`) each
  resolve through `messageVerb()` with the `VM_GREETING_URL` contract: unset is
  synthetic, `say` forces synthetic, a URL is `<Play>`ed. All ship with working
  synthetic defaults, so no recording is a prerequisite.
```

- [ ] **Step 5: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -F - <<'MSG'
docs(voice): the night window and the four message slots

Documents six new env vars and, on the VM_ESCALATION_PROMPT row, the fact that
it is now a manual override rather than the primary mechanism: the day greetings
say the press-1 offer themselves, and the automatic append survives only for
Zul's pre-escalation bundled recording.

Spells out in ARCHITECTURE that the night window is NOT a business-hours rule,
because that is the reading a future editor is most likely to arrive at and then
"fix" by wiring it to the published hours.
MSG
```

---

## Bundled recordings (fold in ONLY if the audio arrives during the build)

If Dallas's four clips land before merge, prefer bundling them over env URLs:
they get versioned with the code, need no public bucket, and leave no env var to
forget. Add them to `server/assets/` as `primary-greeting-day.mp3`,
`primary-greeting-night.mp3`, `primary-escalate-ack.mp3`,
`primary-escalate-failed.mp3`, add a route mirroring the existing
`GET /api/voice/greeting.mp3` (static `res.sendFile`, no DB, no caller input),
and set each slot's `bundledDefault` in the `SLOTS` table the way the zul day
greeting already does. If the audio has not arrived, do NOT add speculative
routes: the env-URL path already works.

## Verification before merge

- [ ] `node -r dotenv/config --test --test-concurrency=1 server/utils/voicemailLine.test.js server/utils/voicemailTwiml.test.js server/routes/voice.test.js server/routes/voiceEscalate.test.js` all green.
- [ ] `npm run check:filesize` shows `voice.js` at or under 700.
- [ ] `npx eslint` clean (0 errors) on all four changed source files.
- [ ] Full fleet (`security-review`, `code-review`, `consistency-check`) against main's HEAD.
