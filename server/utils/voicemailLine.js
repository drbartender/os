// server/utils/voicemailLine.js
//
// Which LINE a call arrived on, and the routing policy that follows from it.
//
// Phase 1a (spec 2026-07-26) made the phone system two-line: +12242221922 is
// Dallas (the primary business number) and +12242220082 is Zul. One shared
// missed-call handler serves both, so `line` is the single input that decides
// which greeting plays, who a press-1 escalation rings, and (in voicemail.js)
// which channel the voicemail is delivered on.
//
// Pure except for env reads, so it is unit-testable with no DB and no network.

const LINES = Object.freeze(['primary', 'zul']);

// Strict E.164. Deliberately the same shape the rest of the voice code demands:
// escalation targets are interpolated into a TwiML ATTRIBUTE, and xmlEscape does
// not escape quotes, so anything that is not bare +digits is refused outright
// rather than escaped and hoped for.
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Default quiet-hour timezones. Zul is a PH VA; Dallas is Chicago.
const DEFAULT_TZ = Object.freeze({ zul: 'Asia/Manila', primary: 'America/Chicago' });

/**
 * Coerce an untrusted line value (it arrives in a webhook query string) to a
 * member of the enum. Anything unrecognized becomes 'zul', which is both the
 * safe default and the correct answer: the 0082 line is the one that predates
 * this column, and an un-stamped <Dial action> is a 0082 call.
 *
 * The caller-facing cost of the default: a primary call whose ?line=primary
 * stamp is lost (stripped by a proxy, duplicated into an array by Express)
 * hears Zul's greeting, its press-1 rings the primary target, and its
 * VOICEMAIL delivers to Zul's Telegram with the recording then deleted. Safe
 * for spend (never accidentally dials the PH cell), NOT consequence-free for
 * delivery; the stamp is HMAC-covered, so losing it also fails the signature
 * in practice.
 * @param {*} raw
 * @returns {'primary'|'zul'}
 */
function resolveLine(raw) {
  return raw === 'primary' ? 'primary' : 'zul';
}

/** The person a press-1 on `line` should ring: the OTHER one. */
function otherLine(line) {
  return resolveLine(line) === 'primary' ? 'zul' : 'primary';
}

/**
 * The strict-E.164 number a press-1 on `line` dials, or null when it is unset or
 * malformed (in which case the caller skips the dial and goes to voicemail).
 * Env only. A caller-supplied value must never reach a <Dial>.
 */
function escalationTargetFor(line) {
  const target = otherLine(line);
  const raw = String(
    (target === 'zul' ? process.env.VA_CELL : process.env.VM_PRIMARY_DIAL_TARGET) || ''
  ).trim();
  return E164_RE.test(raw) ? raw : null;
}

/** "HH:MM" to minutes past midnight, or null. */
function parseHhMm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The quiet window for the person `line` escalates TO, in that person's local
 * time. Format `HH:MM-HH:MM`; unset, empty, or unparseable means no window.
 * @returns {{start:number,end:number,tz:string}|null} minutes past midnight
 */
function quietWindowFor(line) {
  const target = otherLine(line);
  const raw = target === 'zul'
    ? process.env.VM_ESCALATION_QUIET_ZUL
    : process.env.VM_ESCALATION_QUIET_PRIMARY;
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split('-');
  const start = parts.length === 2 ? parseHhMm(parts[0]) : null;
  const end = parts.length === 2 ? parseHhMm(parts[1]) : null;
  if (start === null || end === null) {
    // Fail-open is deliberate (a config typo must not break a live call), but
    // never SILENT: an unparseable window is otherwise indistinguishable from
    // an unset one, and the difference is a 3am billed ring. Note '24:00' and
    // an en dash are both unparseable; the format is strict HH:MM-HH:MM.
    console.warn(`[voicemailLine] unparseable quiet window "${trimmed}" for ${target}; treating as no window`);
    return null;
  }
  const tzEnv = target === 'zul'
    ? process.env.VM_ESCALATION_TZ_ZUL
    : process.env.VM_ESCALATION_TZ_PRIMARY;
  return { start, end, tz: String(tzEnv || DEFAULT_TZ[target]) };
}

/** Minutes past midnight for `d` in IANA zone `tz`. */
function minutesInZone(d, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  // hour can format as 24 at midnight in some ICU versions; fold it to 0.
  return (get('hour') % 24) * 60 + get('minute');
}

/**
 * True when escalating on `line` right now would ring the other person during
 * their quiet hours. A window whose end is before its start wraps midnight
 * (22:00-08:00 is the normal case).
 */
function inQuietWindow(line, now = new Date()) {
  const w = quietWindowFor(line);
  if (!w) return false;
  let mins;
  try {
    mins = minutesInZone(now, w.tz);
  } catch (err) {
    // A bad IANA zone must not break a live call. Treat it as no quiet window.
    console.warn(`[voicemailLine] bad quiet-window timezone "${w.tz}": ${err.message}`);
    return false;
  }
  return w.start <= w.end
    ? (mins >= w.start && mins < w.end)
    : (mins >= w.start || mins < w.end);
}

/**
 * Ring seconds on the primary line before Twilio calls it a miss.
 *
 * Deliberately SHORTER than a typical carrier or Google Voice voicemail pickup
 * (around 25 seconds). If the target's own voicemail answers first, Twilio
 * reports DialCallStatus=completed, our missed handler correctly does nothing,
 * and the caller lands in a dumb voicemail we cannot transcribe or route. Ringing
 * out first is the primary mitigation for that; disabling voicemail on the target
 * is the other, and it is a manual console setting we cannot enforce from here.
 */
function primaryRingSec() {
  const n = parseInt(process.env.VM_PRIMARY_RING_SEC, 10);
  return Math.min(30, Math.max(5, Number.isFinite(n) ? n : 18));
}

// An answer this fast is not a person picking up a phone, it is an auto-attendant.
const PRIMARY_INSTANT_ANSWER_SEC = 3;

/**
 * Interception canary for the primary line (spec section 2 mitigation c).
 *
 * Honest about its limits: a machine and a human both answering at 25 seconds are
 * indistinguishable in this callback, so there is no reliable detector. What IS
 * detectable is an answer far too fast for a person to have reached the phone,
 * which is the signature of carrier or Google Voice voicemail re-enabling on the
 * dial target and quietly stealing every caller from our own voicemail. Nothing
 * branches on the result; it exists so the regression cannot be invisible.
 *
 * 2026-08-14: consumers treat `suspect` as LOG-ONLY (no Sentry page). The
 * signal is inverted in practice — DialCallDuration is connected time, so a
 * real interception (instant answer + greeting hold) is a LONG leg, and a
 * short leg is a fast human. See voice.js's canary block for the full note.
 *
 * Only meaningful on the primary line, which forwards through a third party. Zul's
 * line dials her cell directly and has always behaved this way.
 */
function interceptionSuspicion({ line, status, dialCallDuration } = {}) {
  const parsed = parseInt(dialCallDuration, 10);
  const dialSec = Number.isFinite(parsed) ? parsed : null;
  const suspect = resolveLine(line) === 'primary'
    && status === 'completed'
    && dialSec !== null && dialSec > 0 && dialSec <= PRIMARY_INSTANT_ANSWER_SEC;
  return { suspect, dialSec };
}

module.exports = {
  LINES, E164_RE, resolveLine, otherLine, escalationTargetFor, quietWindowFor,
  inQuietWindow, primaryRingSec, interceptionSuspicion, PRIMARY_INSTANT_ANSWER_SEC,
};
