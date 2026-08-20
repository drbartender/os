// server/utils/voicemailTwiml.js
//
// The TwiML fragments the voicemail flow is built from, in one place because
// TWO route files emit them: server/routes/voice.js (the missed-call handler)
// and server/routes/voiceEscalate.js (the press-1 fallback back to voicemail).
// A <Record> that drifted between the two would change recording length or aim
// the delivery callback somewhere else on one path only, which is exactly the
// kind of bug that hides until a real client leaves a real voicemail.
//
// Moved here from server/routes/voice.js in Phase 1a (greetingVerb, GREETING_TEXT,
// vmMaxLengthSec), which also keeps that file under the 700-line soft cap.
//
// Since 2026-08-19 this file owns FOUR message slots per line, not one greeting:
// greeting_day, greeting_night, escalate_ack, escalate_failed. Each resolves
// through messageVerb() to a bundled recording, a synthetic <Say>, or an env
// override URL. The press-1 offer now lives INSIDE the day greeting, so
// needsAppendedOffer() decides whether the separate prompt is still owed.

const { xmlEscape } = require('./xmlEscape');
const { API_URL } = require('./urls');
const { resolveLine, LINES } = require('./voicemailLine');

// Zul's DAY copy, re-recorded 2026-08-19 to include the press-1 offer. Fixed
// text: it is what her mp3 says, and the synthetic fallback must match the voice
// clients already hear, because the fallback is what plays if that recording is
// ever killed. The 2026-07-24 script it replaced is still served at
// /api/voice/greeting.mp3 but is no longer any slot's default.
const GREETING_TEXT_ZUL = "Thanks for calling Dr. Bartender, this is Zul. Sorry I missed your call. Leave me a message and we'll get back to you as soon as we can. If you need to talk to somebody now, press one and I'll see if someone's available.";

// Dallas's line, DAY. Approved verbatim in brainstorm 2026-08-19. This text
// CONTAINS the press-1 offer, which is why needsAppendedOffer('primary') is
// false: appending the offer again would speak it twice, once in his voice and
// once in Polly's.
const GREETING_TEXT_PRIMARY = "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you as soon as I can. If you need to talk to somebody now, press one and I'll see if someone's available.";

// Dallas's line, NIGHT. Must NEVER mention press 1: at night nobody is awake to
// be escalated to, so the offer would ring a sleeping phone for a predictable
// failure. "In the morning" describes what actually happens to the message
// rather than claiming business hours, so it cannot contradict the published
// client-facing hours.
const GREETING_TEXT_PRIMARY_NIGHT = "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you in the morning.";

// Zul's line, NIGHT. Same standing rule as every other slot here: a line's
// synthetic text mirrors what that line's recording says, so this matches her
// 2026-08-19 night take.
const GREETING_TEXT_ZUL_NIGHT = "Thanks for calling Dr. Bartender, this is Zul. Sorry I missed your call. Leave me a message and we'll get back to you in the morning.";

// Played the instant a caller presses 1, BEFORE any ringing. Its absence was a
// live defect: the caller tapped a key and heard dead air for up to 20 seconds.
const ESCALATE_ACK_TEXT_PRIMARY = "Hold on, let me see who's available.";
const ESCALATE_ACK_TEXT_ZUL = "Hold on, let me see who's available.";

// Played on every return to voicemail. Its absence was the other live defect:
// after 20 seconds of ringing the caller got an unexplained tone, which reads as
// a dropped call rather than an invitation.
const ESCALATE_FAILED_TEXT_PRIMARY = "Sorry, nobody's available right now. Leave me a message and I'll get back to you as soon as I can.";
const ESCALATE_FAILED_TEXT_ZUL = "Sorry, nobody's available right now. Leave me a message and we'll get back to you as soon as we can.";

// APPENDED after a day greeting that does NOT itself mention press 1, which
// since 2026-08-19 is only Zul's pre-escalation recording. Whether to append is
// decided by needsAppendedOffer() from the SLOTS table, not by this constant and
// not by VM_ESCALATION_PROMPT (which survives as a manual override).
const ESCALATION_PROMPT_TEXT = 'Or, press 1 and I will try to get someone else on the line for you.';

// Said only when a slot lookup fails, which the boot check makes unreachable.
// Deliberately says almost nothing: see the fallback branch in messageVerb.
const FALLBACK_TEXT = 'Thanks for calling Dr. Bartender.';

/** What counts as a playable override. Shared so messageVerb and
 *  needsAppendedOffer cannot disagree about whether a value is a recording:
 *  when they did, `VM_GREETING_URL_PRIMARY=yes` fell back to the synthetic text
 *  (which SAYS the offer) while the append fired anyway, doubling it. */
const isPlayableUrl = (v) => /^https?:\/\//i.test(v);

const SAY_OPEN = '<Say voice="Polly.Joanna-Neural">';

function vmMaxLengthSec() {
  const n = parseInt(process.env.VM_MAX_LENGTH_SEC, 10);
  return Math.min(300, Math.max(30, Number.isFinite(n) ? n : 120));
}

/** Press-1 escalation master switch. Default OFF (ships dark). */
function escalationEnabled() {
  return process.env.VM_ESCALATION_ENABLED === 'true';
}

// slot -> per-line { env var, synthetic text, bundled default, and whether that
// default already SAYS the press-1 offer }. One table so a new slot cannot
// be half-added: the boot check below rejects a slot whose lines are incomplete,
// so nothing here can resolve to an empty verb, and an empty verb in TwiML is a
// document that silently says nothing. Note the boot check can only validate
// slots that are PRESENT; an entirely missing slot NAME is caught at request
// time by messageVerb's fallback, which speaks rather than throwing, and
// needsAppendedOffer returns true on doubt rather than dereferencing null.
const SLOTS = {
  greeting_day: {
    primary: {
      env: 'VM_GREETING_URL_PRIMARY', text: GREETING_TEXT_PRIMARY,
      bundled: 'audio/primary-greeting-day.mp3', defaultSaysOffer: true,
    },
    zul: {
      // Re-recorded 2026-08-19 and it SAYS the press-1 offer, so the appended
      // synthetic prompt stops here with no env var to remember. The
      // 2026-07-24 mp3 is still served at /api/voice/greeting.mp3 for anything
      // that references that URL directly.
      env: 'VM_GREETING_URL', text: GREETING_TEXT_ZUL,
      bundled: 'audio/zul-greeting-day.mp3', defaultSaysOffer: true,
    },
  },
  greeting_night: {
    primary: { env: 'VM_NIGHT_GREETING_URL_PRIMARY', text: GREETING_TEXT_PRIMARY_NIGHT, bundled: 'audio/primary-greeting-night.mp3' },
    zul: { env: 'VM_NIGHT_GREETING_URL', text: GREETING_TEXT_ZUL_NIGHT, bundled: 'audio/zul-greeting-night.mp3' },
  },
  escalate_ack: {
    primary: { env: 'VM_ESCALATE_ACK_URL_PRIMARY', text: ESCALATE_ACK_TEXT_PRIMARY, bundled: 'audio/primary-escalate-ack.mp3' },
    zul: { env: 'VM_ESCALATE_ACK_URL', text: ESCALATE_ACK_TEXT_ZUL, bundled: 'audio/zul-escalate-ack.mp3' },
  },
  escalate_failed: {
    primary: { env: 'VM_ESCALATE_FAILED_URL_PRIMARY', text: ESCALATE_FAILED_TEXT_PRIMARY, bundled: 'audio/primary-escalate-failed.mp3' },
    zul: { env: 'VM_ESCALATE_FAILED_URL', text: ESCALATE_FAILED_TEXT_ZUL, bundled: 'audio/zul-escalate-failed.mp3' },
  },
};

// Fail at BOOT, not on a live call: a half-added slot must not first surface
// as a caller hearing an application error. messageVerb below is total at
// request time precisely because this check already ran.
// Every slot messageVerb is asked for by name, so a rename or deletion is
// caught here rather than at 3am on a live call.
for (const required of ['greeting_day', 'greeting_night', 'escalate_ack', 'escalate_failed']) {
  if (!SLOTS[required]) throw new Error(`voicemailTwiml: required slot "${required}" is missing`);
}
for (const [slot, byLine] of Object.entries(SLOTS)) {
  for (const ln of LINES) {
    const cfg = byLine[ln];
    if (!cfg || !cfg.env || !cfg.text) {
      throw new Error(`voicemailTwiml: slot "${slot}" is missing config for line "${ln}"`);
    }
    // greeting_day drives needsAppendedOffer, so an omitted flag there would
    // silently pick a side. Make it explicit rather than defaulted.
    if (slot === 'greeting_day' && typeof cfg.defaultSaysOffer !== 'boolean') {
      throw new Error(`voicemailTwiml: greeting_day/${ln} must declare defaultSaysOffer`);
    }
  }
}
// Shallow: it stops a slot being added or swapped at runtime, which is the
// realistic accident. Deep-freezing every leaf buys little here.
Object.freeze(SLOTS);

/**
 * The TwiML verb for one spoken moment, per line.
 *
 * Contract per slot: unset takes the slot's DEFAULT, which is a bundled
 * recording where one exists and the synthetic text otherwise; the literal
 * 'say' forces synthetic (the kill switch for a bad recording); a full http(s)
 * URL emits <Play>.
 *
 * TOTAL by design: it never throws on a live call. /inbound/missed is a bare
 * async handler with no asyncHandler wrapper, so a throw here would write NO
 * response at all, and the caller would wait ~15s for Twilio to give up and
 * play an application error, after the ledger row was already claimed. The
 * shape invariant is enforced at module load instead.
 *
 * The URL lands in a <Play> ELEMENT BODY, never an attribute, so xmlEscape not
 * covering quotes cannot be turned into an attribute break by a bad env value.
 */
function messageVerb(slot, rawLine) {
  const table = SLOTS[slot];
  const cfg = table && table[resolveLine(rawLine)];
  if (!cfg) {
    // Unreachable given the boot check and literal call sites. If it ever
    // happens, say SOMETHING: silence is the failure this feature exists to fix.
    //
    // This string has to be honest in every position it can fire from, which
    // rules out most copy: no NAME (it may play on either line), no callback
    // promise (it may play day or night), and no "leave a message" (it may play
    // immediately before a <Dial>, not a <Record>). Anything richer is wrong
    // somewhere, and being wrong is what an unknown slot already is.
    console.error(`[voicemailTwiml] unknown slot "${slot}", speaking the neutral fallback`);
    return `${SAY_OPEN}${xmlEscape(FALLBACK_TEXT)}</Say>`;
  }
  const override = String(process.env[cfg.env] || '').trim();
  if (override && override.toLowerCase() !== 'say') {
    // A typo must degrade to the synthetic voice, not to silence. Twilio skips a
    // <Play> whose fetch fails, so "VM_ESCALATE_ACK_URL_PRIMARY=yes" would make
    // the caller hear nothing at all with no server-side trace.
    if (isPlayableUrl(override)) return `<Play>${xmlEscape(override)}</Play>`;
    console.warn(`[voicemailTwiml] ${cfg.env} is not an http(s) URL ("${override}"), speaking instead`);
  } else if (!override && cfg.bundled) {
    // A bundled recording beats the synthetic text, so the real voice is the
    // DEFAULT and needs no env var anyone could forget to set.
    return `<Play>${xmlEscape(`${API_URL}/api/voice/${cfg.bundled}`)}</Play>`;
  }
  return `${SAY_OPEN}${xmlEscape(cfg.text)}</Say>`;
}

/**
 * Whether the press-1 offer still has to be APPENDED after the day greeting.
 *
 * Reads the SLOTS table rather than hardcoding a line or an env name, so
 * renaming a variable cannot make this silently diverge from what actually
 * plays.
 *
 * When an override URL is set we do not know what it says, and the two failure
 * modes are NOT symmetric: appending a redundant offer is an ugly but obvious
 * stutter, while omitting it loses the feature invisibly (a 4-second silent
 * Gather before the beep, and callers who never learn the option exists). So an
 * unknown recording gets the offer appended. Only the KNOWN defaults are
 * trusted to say it themselves.
 */
function needsAppendedOffer(rawLine) {
  if (String(process.env.VM_ESCALATION_PROMPT || '').trim().toLowerCase() === 'none') return false;
  const cfg = SLOTS.greeting_day?.[resolveLine(rawLine)];
  // Total for the same reason messageVerb is: this runs inside /inbound/missed,
  // a bare async handler with no asyncHandler wrapper, so a TypeError here
  // writes NO response and the caller waits ~15s for a Twilio application
  // error, after the ledger row is already claimed. Append on doubt.
  if (!cfg) return true;
  const override = String(process.env[cfg.env] || '').trim();
  // Only a PLAYABLE url is an unknown recording. A malformed value falls back
  // to the synthetic text, whose offer content the table already knows.
  const usingDefault = !override || !isPlayableUrl(override);
  return usingDefault ? !cfg.defaultSaysOffer : true;
}

/** The appended press-1 offer verb. WHETHER to append is needsAppendedOffer's
 *  job; this only honors the VM_ESCALATION_PROMPT=none manual override. */
function escalationPromptVerb() {
  if (String(process.env.VM_ESCALATION_PROMPT || '').trim().toLowerCase() === 'none') return '';
  return `${SAY_OPEN}${xmlEscape(ESCALATION_PROMPT_TEXT)}</Say>`;
}

/**
 * The <Record> verb. Deliberately carries NO action attribute: when a caller
 * ends a voicemail by hanging up, which is the normal case, Twilio does not
 * request the record verb's action URL, so delivery hangs off
 * recordingStatusCallback instead.
 *
 * API_URL sits in an ATTRIBUTE despite xmlEscape not covering quotes because it
 * is ops-set env, not request data (the same trust voice.js has always placed
 * in it). Do not copy this shape for anything caller-influenced.
 */
function recordVerb() {
  return `<Record maxLength="${vmMaxLengthSec()}" playBeep="true" trim="trim-silence" finishOnKey="#"`
    + ` recordingStatusCallback="${xmlEscape(API_URL)}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>';
}

module.exports = {
  SLOTS, FALLBACK_TEXT, isPlayableUrl,
  GREETING_TEXT_ZUL, GREETING_TEXT_PRIMARY, ESCALATION_PROMPT_TEXT,
  GREETING_TEXT_PRIMARY_NIGHT, GREETING_TEXT_ZUL_NIGHT,
  ESCALATE_ACK_TEXT_PRIMARY, ESCALATE_ACK_TEXT_ZUL,
  ESCALATE_FAILED_TEXT_PRIMARY, ESCALATE_FAILED_TEXT_ZUL,
  vmMaxLengthSec, escalationEnabled, escalationPromptVerb, recordVerb,
  messageVerb, needsAppendedOffer,
};
