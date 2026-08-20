const express = require('express');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit } = require('../utils/pendingCall');
const { sendTelegramMessage } = require('../utils/telegram');
const { API_URL } = require('../utils/urls');
const { isUsE164 } = require('../utils/usPhone');
const voicemail = require('../utils/voicemail');
const { resolveLine, primaryRingSec, interceptionSuspicion, E164_RE, isNight } = require('../utils/voicemailLine');
const {
  recordVerb, escalationEnabled, escalationPromptVerb,
  messageVerb, needsAppendedOffer, dayGreetingOffersPress1,
} = require('../utils/voicemailTwiml');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const DEAD_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

// Same four values as DEAD_STATUSES above, kept as a separate constant on
// purpose: that one reads Twilio's CallStatus on an OUTBOUND leg, this one
// reads DialCallStatus on an INBOUND dial. Merging them would couple two
// unrelated webhooks to one list.
const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);
// Twilio's anonymous-caller sentinel, plus the string forms some carriers send.
const ANONYMOUS_FROM = new Set(['+266696687', 'anonymous', 'restricted', 'unavailable']);
const HANGUP_TWIML = '<Response><Hangup/></Response>';

const rateLimit = require('express-rate-limit');

// Inbound flood cap (spec §Inbound). Twilio spreads webhooks across many IPs,
// so per-IP is no spend cap: one constant-key GLOBAL bucket per line (separate
// so a storm on one number cannot silence the other; VA_INBOUND_PER_MIN_CAP,
// default 30/min each). Runs BEHIND the signature gate: junk POSTs must never
// consume the budget or an unsigned flood answers every real caller busy
// (security-review 2026-08-07 H1). A trip = a REAL signed storm, so it logs.
function forwardLimiter(key) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.VA_INBOUND_PER_MIN_CAP, 10) || 30,
    keyGenerator: () => key,
    handler: (req, res) => {
      console.warn(`[voice/${key}] VA_INBOUND_PER_MIN_CAP tripped; answering busy`);
      res.set('Content-Type', 'text/xml').send(
        `${XML_DECL}<Response><Say>All lines are busy. Please try again shortly.</Say><Hangup/></Response>`
      );
    },
  });
}
const inboundForwardLimiter = forwardLimiter('global');
const primaryForwardLimiter = forwardLimiter('primary');

// isValidTwilioRequest moved to server/utils/twilioSignature.js so the
// lead-call webhooks (voiceLeadCall.js) share the check without importing a
// router. Policy on failure stays here (passesSignature: prod 403, dev allow).

// Dependency-injection seam for tests (mirrors server/utils/sms.js:57-58
// __setSmsDeps). Lets unit tests stub the signature gate + DB/Telegram calls
// so no real webhook signature, Neon query, or Bot API request is made.
let _deps = {
  isValidTwilioRequest, lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit, sendTelegramMessage,
  // Voicemail (spec 2026-07-22). The audio upload lives behind deliverVoicemail
  // since per-line delivery; Sentry goes through the seam too, because the only
  // observable difference between the 'skipped' and 'failed' delivery outcomes
  // is whether Sentry is paged, so it has to be assertable.
  claimMissedCall: voicemail.claimMissedCall,
  countVoicemailsSince: voicemail.countVoicemailsSince,
  claimDelivery: voicemail.claimDelivery,
  markDelivery: voicemail.markDelivery,
  deliverVoicemail: (...a) => voicemail.deliverVoicemail(...a),
  alertOperator: (...a) => voicemail.alertOperator(...a),
  deleteRecording: voicemail.deleteRecording,
  isRecordingSid: voicemail.isRecordingSid,
  captureMessage: (...a) => Sentry.captureMessage(...a),
  captureException: (...a) => Sentry.captureException(...a),
  // Injectable so tests can pin day/night deterministically. No env value can:
  // a half-open window covers at most 1439 of 1440 minutes, so any 'force night'
  // string is day for one minute a day.
  isNight: (...a) => isNight(...a),
};
function __setVoiceDeps(d) { _deps = { ..._deps, ...d }; }
router.__setVoiceDeps = __setVoiceDeps;

// Own limiter for the two voicemail webhooks: inboundForwardLimiter above is
// route-level middleware on /inbound only, and server/index.js mounts no global
// /api limiter, so these would otherwise be unthrottled.
//
// Keyed by CallSid, NOT globally. These endpoints are only reachable as a
// consequence of an inbound call that already passed the global 30/min cap at
// /inbound, and the real spend controls are that cap plus VM_DAILY_CAP. A
// global key here would instead let one busy minute starve the delivery webhook
// of a DIFFERENT call, dropping a voicemail that was already paid for.
// Per-CallSid bounds webhook redelivery storms, which is the actual threat.
const CALL_SID_RE = /^CA[0-9a-f]{32}$/;

const voicemailWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  // The key is SHAPE-VALIDATED, and everything else collapses into one shared
  // bucket. This runs as middleware BEFORE the signature gate, so the key is
  // attacker-chosen on a public endpoint: keying on the raw body value let an
  // unauthenticated flood mint a fresh ~100kb key per request (the urlencoded
  // body limit), each retained for one to two windows by the in-process store,
  // and never trip `max` because every key was new. That turns the limiter into
  // a memory-exhaustion amplifier instead of a defense.
  keyGenerator: (req) => {
    const sid = (req.body && req.body.CallSid) || '';
    return CALL_SID_RE.test(sid) ? sid : 'unvalidated';
  },
  // /inbound/missed is a LIVE-CALLER path: Twilio answers a non-2xx on a <Dial>
  // action URL by playing "an application error has occurred" to the client.
  // Give that route valid hangup TwiML (matching inboundForwardLimiter's busy
  // TwiML) and reserve the bare 429 for the recording callback, where the call
  // is already over and nobody hears anything.
  handler: (req, res) => {
    if (req.path === '/inbound/missed') {
      res.set('Content-Type', 'text/xml').send(`${XML_DECL}${HANGUP_TWIML}`);
      return;
    }
    res.status(429).end();
  },
});

function voicemailEnabled() { return process.env.VOICEMAIL_ENABLED === 'true'; }

function vmDailyCap() {
  const n = parseInt(process.env.VM_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// Greeting, <Record>, and vmMaxLengthSec live in utils/voicemailTwiml.js: the
// escalation router (voiceEscalate.js) emits the same fragments; one owner.

// Per-window Sentry claims. The rate limiter cannot cap Sentry emission (a
// well-formed random CallSid mints a fresh bucket every request), and both a
// hostile unsigned flood and a PERSISTENT condition (a missing dial target)
// recur 1:1 with call volume, which is an
// amplifier straight into the org's Sentry quota. (The re-enabled-carrier-
// voicemail canary lost its claim 2026-08-14 when it was demoted to log-only.) Each claim allows a fixed
// number of events per window and carries the suppressed count.
function makeWindowClaim(windowMs, allowance) {
  let start = 0;
  let hits = 0;
  let prevOverflow = 0;
  return () => {
    const now = Date.now();
    if (now - start > windowMs) {
      // Overflow can only exist AFTER the emitted events of a window, so it
      // rides the next window's first event or it would never be reported.
      prevOverflow = Math.max(0, hits - allowance);
      start = now;
      hits = 0;
    }
    hits += 1;
    return { allowed: hits <= allowance, suppressedPreviousWindow: prevOverflow };
  };
}
const claimSigFailureReport = makeWindowClaim(60 * 1000, 5);
const claimNoTargetReport = makeWindowClaim(15 * 60 * 1000, 1);

/**
 * Fail-closed signature gate for the voicemail webhooks. Deliberately NOT
 * passesSignature above: these endpoints record client voice, incur per-minute
 * spend, and make a DESTRUCTIVE Twilio API call, so there is no dev
 * warn-and-allow path. Mirrors voiceLeadCall.js requireSignature.
 */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  const claim = process.env.SENTRY_DSN_SERVER ? claimSigFailureReport() : null;
  if (claim && claim.allowed) {
    _deps.captureMessage('Twilio voicemail webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'twilio-voice', route: tag, reason: 'invalid_signature' },
      extra: { suppressedPreviousWindow: claim.suppressedPreviousWindow },
    });
  }
  res.status(403).send('Invalid signature');
  return false;
}

/**
 * Strict E.164, minus the anonymous sentinels. NULL means caller ID withheld.
 * Never falls back to VOICE_CALLER_ID the way the caller-ID handling at the
 * /inbound handler does: that would tell Zul to call the 224 back, which is
 * this business's own line.
 */
function callerE164(raw) {
  const v = String(raw || '').trim();
  if (!v || ANONYMOUS_FROM.has(v)) return null;
  return /^\+[1-9]\d{6,14}$/.test(v) ? v : null;
}

/**
 * Caller ID on a forwarded leg. From lands in a TwiML ATTRIBUTE and xmlEscape
 * does not escape quotes, so it is constrained to bare +digits by construction
 * and otherwise replaced with our own line (looser than callerE164 on purpose:
 * safe-and-dialable-ish here; callerE164 decides what we store and ping).
 */
function callerIdFor(rawFrom) {
  return /^\+?[0-9]{7,15}$/.test(rawFrom) ? rawFrom : (process.env.VOICE_CALLER_ID || '');
}

function chicagoTime(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Signature gate for /bridge and /status (Phase 1a moved /inbound to the
 * fail-closed requireSignature above; those two do not place a new billed leg).
 * Mirrors the sms.js inbound handler (server/routes/sms.js:50-65): prod rejects
 * a bad/missing signature with 403 (privileged call-bridging behavior is NEVER
 * honored on a dev signature-skip in production); dev warns and allows so the
 * endpoints are testable without live Twilio creds. Returns true when the
 * request may proceed; when it returns false it has already sent the 403.
 */
function passesSignature(req, res, tag) {
  const inProd = process.env.NODE_ENV === 'production';
  if (!_deps.isValidTwilioRequest(req)) {
    if (inProd) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('Twilio voice webhook signature failure', {
          level: 'warning', tags: { webhook: 'twilio-voice', route: tag, reason: 'invalid_signature' },
        });
      }
      res.status(403).send('Invalid signature');
      return false;
    }
    console.warn(`[voice/${tag}] signature not validated (dev mode — allowing)`);
  }
  return true;
}

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

/**
 * POST /api/voice/inbound — a client calls the 224. Dial Zul's cell (VA_CELL),
 * passing the client's number through as caller ID so she sees who is calling.
 * VA_CELL is a strict-E.164 env var (never normalized). The client From is
 * external input interpolated into the callerId ATTRIBUTE; xmlEscape does not
 * escape double-quotes, so From is first constrained to a bare +digits E.164
 * shape (safe by construction) and otherwise falls back to VOICE_CALLER_ID. Both
 * interpolated values are still xmlEscape'd defensively. The <Dial> carries a
 * hard timeLimit so a forwarded inbound leg can never bill unbounded PH minutes.
 */
router.post('/inbound', (req, res, next) => {
  // Fails CLOSED in every env (spec section 8): this route places the billed
  // international <Dial>. passesSignature stays only on /bridge and /status.
  if (!requireSignature(req, res, 'inbound')) return;
  inboundForwardLimiter(req, res, next);
}, (req, res) => {
  const caller = callerIdFor(req.body.From || '');
  const vaCell = process.env.VA_CELL || '';
  sendTwiml(
    res,
    `<Response><Dial timeout="20" action="${xmlEscape(API_URL)}/api/voice/inbound/missed?line=zul" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/voice/inbound/primary. a client calls the 1922, the primary
 * business number. Dial Dallas (VM_PRIMARY_DIAL_TARGET, normally the 312 that
 * rings his phone and keeps his personal cell private), pass the client's
 * number through as caller ID, and hand a miss to the shared voicemail handler
 * with line=primary. Fail-closed on signature: billed legs downstream.
 */
router.post('/inbound/primary', (req, res, next) => {
  // Signature BEFORE the limiter: see forwardLimiter.
  if (!requireSignature(req, res, 'inbound/primary')) return;
  primaryForwardLimiter(req, res, next);
}, (req, res) => {
  // Env only, strict E.164: an unset/malformed target apologizes, never emits
  // an empty or unsafe <Number>. Every primary call dies here, so it pages.
  const target = String(process.env.VM_PRIMARY_DIAL_TARGET || '').trim();
  if (!E164_RE.test(target)) {
    console.error('[voice/primary] VM_PRIMARY_DIAL_TARGET unset or malformed; cannot dial');
    if (process.env.SENTRY_DSN_SERVER && claimNoTargetReport().allowed) {
      _deps.captureMessage('primary line has no dial target; calls are being apologized away', {
        level: 'error',
        tags: { webhook: 'twilio-voice', route: 'inbound/primary', reason: 'no_dial_target' },
      });
    }
    sendTwiml(res, '<Response><Say>Sorry, we cannot take your call right now. Please try again shortly.</Say><Hangup/></Response>');
    return;
  }

  const caller = callerIdFor(req.body.From || '');

  sendTwiml(
    res,
    `<Response><Dial timeout="${primaryRingSec()}" action="${xmlEscape(API_URL)}/api/voice/inbound/missed?line=primary" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(target)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/voice/bridge — fetched after Zul answers her outbound leg. The dial
 * target is looked up FROM pending_call BY CallSid (never a request param, so a
 * forged param cannot redirect the second leg). Unknown/expired CallSid → a
 * spoken apology + hangup rather than a silent dead call. Provider webhook:
 * any error returns a valid TwiML (never a stack trace) so the call terminates
 * cleanly.
 */
router.post('/bridge', async (req, res) => {
  if (!passesSignature(req, res, 'bridge')) return;
  let target = null;
  try {
    target = await _deps.lookupTargetByCallSid(req.body.CallSid);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { webhook: 'twilio-voice', route: 'bridge' } });
    console.error('[voice/bridge] target lookup failed:', err.message);
  }
  if (!target) {
    sendTwiml(res, '<Response><Say>Sorry, the call could not be completed.</Say><Hangup/></Response>');
    return;
  }
  const callerId = process.env.VOICE_CALLER_ID || '';
  sendTwiml(
    res,
    `<Response><Dial answerOnBridge="true" callerId="${callerId}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(target)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/voice/status — Twilio call-status callback. On a dead leg
 * (no-answer/busy/failed/canceled) message Zul so she learns the outcome
 * instead of hearing silence, and audit the status. Always returns an empty
 * 204 (Twilio needs a 2xx to stop retrying; side-effect failures are logged,
 * never surfaced). CallSid/status redaction: audit stores full CallSid but no
 * dialed number here.
 */
router.post('/status', async (req, res) => {
  if (!passesSignature(req, res, 'status')) return;
  const status = req.body.CallStatus;
  const callSid = req.body.CallSid || null;
  if (DEAD_STATUSES.has(status)) {
    const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
    const triggeredBy = allowed ? Number(allowed) : null;

    // Atomic claim closes the check-then-act (TOCTOU) window: write the dedup
    // row BEFORE the send with INSERT ... ON CONFLICT DO NOTHING (arbiter:
    // uq_call_audit_dead_leg), so two concurrent at-least-once redeliveries for
    // the same (CallSid, dead-status) can no longer both pass a SELECT probe and
    // both alert. The claim row doubles as the forensic audit row.
    //
    // NULL CallSid early-out: the partial unique index excludes call_sid=NULL, so
    // such a row can't be deduped, and a release DELETE on NULL matches nothing
    // (would strand an orphan). Mirror the old auditRowExists(null)=false guard —
    // skip the claim/release pair entirely and alert best-effort.
    let claimed = true;
    if (callSid) {
      try {
        claimed = await _deps.claimDeadLegAudit({ triggeredBy, callSid, status });
      } catch (err) {
        // Probe/claim DB error: fall through best-effort (a rare double-ping beats
        // a swallowed alert). No durable row exists in this path, so no release.
        console.error('[voice/status] audit claim failed:', err.message);
        claimed = true;
      }
    }
    if (!claimed) {
      // Another concurrent callback owns this exact (CallSid, status) — it already
      // alerted (or is about to). Skip the duplicate Telegram + audit.
      res.status(204).end();
      return;
    }
    // We own the claim (or NULL CallSid best-effort). Alert Zul if configured.
    if (allowed) {
      try {
        await _deps.sendTelegramMessage(allowed, "That call didn't connect, resend the number to retry.");
      } catch (err) {
        console.error('[voice/status] telegram notify failed:', err.message);
        // Release the claim so Twilio's next at-least-once redelivery can re-claim
        // and re-send (preserves the deliberate retry-on-failed-send property).
        // Skip on NULL CallSid: no durable row was written to release.
        if (callSid) {
          try {
            await _deps.releaseDeadLegAudit({ callSid, status });
          } catch (relErr) {
            console.error('[voice/status] audit release failed:', relErr.message);
          }
        }
      }
    }
  }
  res.status(204).end();
});

/**
 * POST /api/voice/inbound/missed — the <Dial> action callback. Twilio requests
 * this when the dialed leg ends, whatever the outcome.
 *
 * Ordering is load-bearing: the TwiML response is sent BEFORE the Telegram ping.
 * The ping is a network call to a third party, and awaiting it inline would hold
 * a live client in dead air until Twilio's webhook deadline, after which they
 * would get no greeting at all. A notification outage must never become a
 * caller-facing outage.
 */
router.post('/inbound/missed', voicemailWebhookLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'inbound/missed')) return;

  const status = req.body.DialCallStatus;
  const callSid = req.body.CallSid || null;
  const line = resolveLine(req.query.line);
  const tail = `sid=...${String(callSid || '').slice(-4)}`;

  // Interception canary (spec section 2 mitigation c). Runs BEFORE the cheap
  // branch because the case it watches for, DialCallStatus=completed, is exactly
  // what that branch returns on. Observation only: it never changes the outcome,
  // so its own failure is swallowed too; a live caller is waiting on this TwiML.
  // DEMOTED TO LOG-ONLY 2026-08-14 (Dallas): the detector is inverted in
  // practice. DialCallDuration is the leg's CONNECTED time, not time-to-answer,
  // so a real GV interception (answers ~1s, then HOLDS the caller through a
  // greeting) is a LONG leg the canary never flags, while a human answering
  // fast and hanging up is the short leg it fired on — proven by the first
  // real call (DRBARTENDER-SERVER-20, false positive on Dallas's own answer).
  // The per-call dialSec line stays as honest telemetry for Twilio-console
  // reconciliation; no Sentry page. The conclusive fix, if interception is
  // ever actually observed, is the press-1 screening whisper (voiceEscalate).
  try {
    const canary = interceptionSuspicion({
      line, status, dialCallDuration: req.body.DialCallDuration,
    });
    if (line === 'primary' && status === 'completed') {
      const say = `[voice/missed] primary answered ${tail} dialSec=${canary.dialSec === null ? 'unknown' : canary.dialSec}`;
      if (canary.suspect) console.warn(`${say} SUSPECT instant answer`); else console.log(say);
    }
  } catch (err) {
    console.error(`[voice/missed] canary failed ${tail}: ${err.message}`);
  }

  // Cheap branch is the default: only an explicitly recognized miss costs money.
  if (!voicemailEnabled() || !MISSED_STATUSES.has(status) || !callSid) {
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  const fromE164 = callerE164(req.body.From);

  // Daily spend cap runs BEFORE the ledger insert. Checking it after meant a
  // rejected call still wrote a row, and that row still counted toward the
  // window, so an attack kept voicemail dead for a rolling 24h that kept
  // extending past the end of the attack. Fails CLOSED: an unreadable count
  // means no recording.
  let recent = Infinity;
  try {
    recent = await _deps.countVoicemailsSince(24);
  } catch (err) {
    console.error(`[voice/missed] daily cap read failed: ${err.message}`);
  }
  if (recent >= vmDailyCap()) {
    console.warn(`[voice/missed] VM_DAILY_CAP tripped (${recent}) ${tail}`);
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  // The INSERT is the ping's dedup claim: Twilio delivers this callback at least
  // once, so only the winner may ping and offer a recording.
  let claimed = false;
  try {
    claimed = await _deps.claimMissedCall({ callSid, fromE164, line });
  } catch (err) {
    // Fails CLOSED on the ping too, matching the cap branch above. Without the
    // ledger there is no dedup, and a DB outage is exactly the correlated
    // condition that puts EVERY call down this path: pinging here would mean
    // ~30 calls/min x 2 messages with no ceiling, which is the flood the cap
    // exists to prevent. Twilio's redelivery would multiply it further.
    console.error(`[voice/missed] claim failed ${tail}: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/missed' } });
    }
    sendTwiml(res, HANGUP_TWIML);
    return;
  }
  if (!claimed) {
    console.log(`[voice/missed] duplicate callback ${tail}`);
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  // Listen whenever a digit could ARRIVE, which is not the same test as "is
  // escalation on": since 2026-08-19 the offer lives inside both lines'
  // recordings, and VM_ESCALATION_ENABLED cannot edit an mp3. Dropping the
  // <Gather> with the switch was the 2026-08-20 trap fix -- callers were invited
  // to press 1 into a document that was not listening. The switch keeps its real
  // job: voiceEscalate.js tests it itself, so off is still zero claims and zero
  // billed legs, and a pressed 1 lands on escalate_failed then records, exactly
  // as the quiet window and the daily cap already do. Never ADD an offer for a
  // feature that is off, hence the switch still gating the APPENDED prompt.
  // Night emits no <Gather> at all: those greetings never mention press 1
  // (spec 2026-08-19). A timeout falls through to the <Record> after </Gather>,
  // so "just leave a message" needs no extra route. `line` is a fixed enum.
  const night = _deps.isNight();
  const greeting = messageVerb(night ? 'greeting_night' : 'greeting_day', line);
  const escalating = escalationEnabled();
  const listening = !night && (escalating || dayGreetingOffersPress1(line));
  const body = listening
    ? `<Gather numDigits="1" timeout="4" action="${xmlEscape(API_URL)}/api/voice/escalate?line=${line}" method="POST">`
      + greeting + (escalating && needsAppendedOffer(line) ? escalationPromptVerb() : '')
      + '</Gather>'
    : greeting;

  sendTwiml(res, `<Response>${body}${recordVerb()}<Hangup/></Response>`);
  console.log(`[voice/missed] offering voicemail ${tail} line=${line} status=${status}`);

  // Zul-line only: her ping doubles as the callback trigger. A primary miss
  // shows natively on the GV dial target; pinging Zul invites a wrong callback.
  if (line !== 'primary') pingMissed(fromE164);
});

/**
 * Missed-call ping. Two messages when the caller is dialable, because
 * server/routes/telegram.js runs toUsE164 over the WHOLE message text and
 * normalizePhone strips non-digits, so any stray digit in the prose would break
 * Zul's copy-paste-then-y callback. The number therefore gets a message to
 * itself, and only for NANP numbers, which are the only ones the bridge can
 * dial. A non-NANP caller is still named in the prose: otherwise she would
 * never learn who called.
 *
 * Fire and forget by design, after the TwiML response. Never awaited on the
 * caller's critical path.
 */
function pingMissed(fromE164) {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed) return;
  const when = chicagoTime();
  // isUsE164, NOT a local shape regex. A bare /^\+1[2-9]\d{9}$/ accepts exactly
  // what usPhone.js exists to block: 900/976 premium rate and non-US NANP (809,
  // 876, 473...), the classic wangiri destinations. A spoofed caller ID that
  // rings once and hangs up would otherwise be handed to Zul as a one-tap
  // callback target, and the bridge refusing to dial it just moves the call to
  // her personal handset.
  const isNanp = Boolean(fromE164) && isUsE164(fromE164);

  let prose;
  if (isNanp) {
    prose = `Missed call on the business line, ${when}. Number follows, send it back to me to call them.`;
  } else if (fromE164) {
    prose = `Missed call on the business line, ${when}, from ${fromE164}. That is not a US number, so I cannot dial it for you.`;
  } else {
    prose = `Missed call on the business line, ${when}. Caller ID was withheld.`;
  }

  Promise.resolve()
    .then(async () => {
      await _deps.sendTelegramMessage(allowed, prose);
      if (isNanp) await _deps.sendTelegramMessage(allowed, fromE164);
    })
    .catch((err) => console.error(`[voice/missed] ping failed: ${err.message}`));
}

/**
 * POST /api/voice/inbound/voicemail — the <Record> recordingStatusCallback.
 *
 * This is the delivery hook, NOT <Record action>: when a caller ends a voicemail
 * by hanging up, which is the normal case, Twilio does not request the record
 * verb's action URL.
 *
 * Responds 204 immediately and processes detached. The call is already over, so
 * nobody is waiting on the line, and a fast 2xx keeps Twilio from retrying while
 * we are still uploading.
 */
/**
 * The claim is awaited BEFORE the 204, then the slow work runs detached.
 * Answering 204 first would leave a crash window (SIGTERM between the response
 * and the claim) where the row stays 'missed' with a NULL recording_sid, which
 * the sweep's `recording_sid IS NOT NULL` filter cannot reach and Twilio will
 * never retry. The claim is one indexed UPDATE, so it costs nothing against the
 * webhook deadline.
 */
router.post('/inbound/voicemail', voicemailWebhookLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'inbound/voicemail')) return;
  const body = req.body || {};

  let claimed;
  try {
    claimed = await claimVoicemail(body);
  } catch (err) {
    // Deliberately NOT 204. A 2xx tells Twilio the callback was accepted and it
    // never retries, so answering 204 on a transient DB error would strand the
    // row at 'missed' with live audio in the console and nothing able to reach
    // it (the sweep requires recording_sid IS NOT NULL). A 5xx buys a retry.
    console.error(`[voice/voicemail] claim failed: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' } });
    }
    res.status(503).end();
    return;
  }

  res.status(204).end();
  if (!claimed) return;

  deliverClaimedVoicemail(claimed).catch((err) => {
    console.error(`[voice/voicemail] unhandled: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' } });
    }
  });
});

/**
 * Shape-gate and claim. Returns the claimed job, or null when there is nothing
 * to do. body.RecordingUrl is deliberately never read: see the SECURITY NOTE in
 * utils/voicemail.js.
 */
async function claimVoicemail(body) {
  const recordingSid = body.RecordingSid;
  const callSid = body.CallSid;
  const tail = `sid=...${String(callSid || '').slice(-4)}`;

  if (body.RecordingStatus !== 'completed') {
    console.log(`[voice/voicemail] ignoring RecordingStatus=${body.RecordingStatus} ${tail}`);
    return null;
  }
  if (!callSid || !_deps.isRecordingSid(recordingSid)) {
    console.warn(`[voice/voicemail] rejected malformed callback ${tail}`);
    return null;
  }

  const parsed = parseInt(body.RecordingDuration, 10);
  const durationSec = Number.isFinite(parsed) ? parsed : null;

  const claim = await _deps.claimDelivery({ callSid, recordingSid, durationSec });
  if (!claim) {
    console.log(`[voice/voicemail] delivery already claimed or unknown call ${tail}`);
    return null;
  }
  return { callSid, recordingSid, durationSec, fromE164: claim.fromE164, line: claim.line, listenToken: claim.listenToken, tail };
}

async function deliverClaimedVoicemail({ callSid, recordingSid, durationSec, fromE164, line, listenToken, tail }) {
  // A recording Twilio reported as 0 or 1 seconds is a robocall or a hangup on
  // the beep, and is safe to drop: she already has the ping with the number.
  // An ABSENT or unparseable duration is NOT that. It means "unknown", and
  // treating it as empty would irreversibly delete a real voicemail on missing
  // data, so it goes down the normal delivery path instead.
  if (durationSec !== null && durationSec < 2) {
    await _deps.markDelivery({ callSid, status: 'empty' });
    await _deps.deleteRecording(recordingSid);
    console.log(`[voice/voicemail] empty recording dropped ${tail}`);
    return;
  }

  // Zul's line delivers over Telegram, so her chat id is a hard precondition
  // there; the row then deliberately keeps NO status ('recorded' keeps it in
  // the sweep's retry window; 'skipped' once parked audio in the Twilio console
  // forever). The primary line delivers by SMS and does not need it, so gating
  // it on her id would make Dallas's voicemails silently undeliverable.
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (line !== 'primary' && !allowed) {
    console.warn(`[voice/voicemail] TELEGRAM_ALLOWED_USER_ID unset, recording retained and still retryable ${tail}`);
    return;
  }

  // The fetch/upload/three-outcome/delete decision lives in ONE place shared
  // with the scheduler's redelivery sweep (utils/voicemail.js deliverVoicemail).
  // Duplicating it here is what let the sweep collapse a gated send into a
  // permanent failure.
  const outcome = await _deps.deliverVoicemail({
    callSid, recordingSid, durationSec, fromE164, line, listenToken, chatId: allowed,
  });

  // Failure alerts go to the LINE'S OWNER (utils/voicemail.js alertOperator).
  const who = fromE164 || 'a withheld number';
  if (outcome === 'unfetchable') {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureMessage('Voicemail media could not be retrieved', {
        level: 'warning', tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' },
      });
    }
    await _deps.alertOperator({ line, chatId: allowed, tail, text: `Voicemail from ${who} could not be retrieved. It is still in the Twilio console.` });
    return;
  }
  if (outcome === 'failed') {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureMessage('Voicemail delivery failed', {
        level: 'warning', tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' },
      });
    }
    await _deps.alertOperator({ line, chatId: allowed, tail, text: `Voicemail from ${who} did not come through. It is still in the Twilio console.` });
  }
  // 'delivered' and 'skipped' need no operator action. 'skipped' deliberately
  // stays retryable for the sweep rather than being parked in a status.
}

module.exports = router;
