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

const { xmlEscape } = require('./xmlEscape');
const { API_URL } = require('./urls');
const { resolveLine } = require('./voicemailLine');

// Zul's greeting copy, unchanged from what shipped 2026-07-24. Fixed text: it is
// what her recorded mp3 says, and the synthetic fallback must match the voice
// clients already hear.
const GREETING_TEXT_ZUL = "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";

// Dallas's line. Synthetic until he records his own (then set
// VM_GREETING_URL_PRIMARY, no code change). Deliberately NOT Zul's copy: the
// primary line falling back to "This is Zul" would be worse than a robot voice.
const GREETING_TEXT_PRIMARY = "Hey, it's Dallas at Dr. Bartender. I can't pick up right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";

// Spoken only when escalation is enabled. The greetings recorded so far do not
// mention press 1, so without this the option is invisible to callers. Once a
// greeting is re-recorded to include the line, set VM_ESCALATION_PROMPT=none.
const ESCALATION_PROMPT_TEXT = 'Or, press 1 and I will try to get someone else on the line for you.';

const SAY_OPEN = '<Say voice="Polly.Joanna-Neural">';

function vmMaxLengthSec() {
  const n = parseInt(process.env.VM_MAX_LENGTH_SEC, 10);
  return Math.min(300, Math.max(30, Number.isFinite(n) ? n : 120));
}

/** Press-1 escalation master switch. Default OFF (ships dark). */
function escalationEnabled() {
  return process.env.VM_ESCALATION_ENABLED === 'true';
}

/**
 * The greeting the caller hears, per line.
 *
 * zul:     VM_GREETING_URL         (unset -> the bundled recording; 'say' -> synthetic)
 * primary: VM_GREETING_URL_PRIMARY (unset -> synthetic; a url -> <Play> it)
 *
 * The zul branch is byte-identical to what production emits today.
 */
function greetingVerbForLine(rawLine) {
  const line = resolveLine(rawLine);
  if (line === 'primary') {
    const override = String(process.env.VM_GREETING_URL_PRIMARY || '').trim();
    if (!override || override.toLowerCase() === 'say') {
      return `${SAY_OPEN}${xmlEscape(GREETING_TEXT_PRIMARY)}</Say>`;
    }
    return `<Play>${xmlEscape(override)}</Play>`;
  }
  const override = String(process.env.VM_GREETING_URL || '').trim();
  if (override.toLowerCase() === 'say') {
    return `${SAY_OPEN}${xmlEscape(GREETING_TEXT_ZUL)}</Say>`;
  }
  const url = override || `${API_URL}/api/voice/greeting.mp3`;
  return `<Play>${xmlEscape(url)}</Play>`;
}

/** The spoken press-1 offer, or '' when the greeting already announces it. */
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
  GREETING_TEXT_ZUL, GREETING_TEXT_PRIMARY, ESCALATION_PROMPT_TEXT,
  vmMaxLengthSec, escalationEnabled, greetingVerbForLine, escalationPromptVerb, recordVerb,
};
