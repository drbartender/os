const express = require('express');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit } = require('../utils/pendingCall');
const { sendTelegramMessage, sendTelegramAudio } = require('../utils/telegram');
const { API_URL } = require('../utils/urls');
const { isUsE164 } = require('../utils/usPhone');
const voicemail = require('../utils/voicemail');

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

// Inbound flood cap (spec §Inbound). Every forwarded inbound call bills a PH
// per-minute leg to VA_CELL, so an unthrottled public 224 is a toll-fraud
// vector under a robocall storm. Mirrors the SMS inboundLimiter
// (server/routes/sms.js:19-23). Twilio spreads inbound webhooks across many
// source IPs, so a per-IP cap is NOT a real spend cap; keyGenerator collapses
// every inbound request into a single shared bucket, making this a true GLOBAL
// forward cap per window. On trip we return a busy TwiML and never dial. Override
// with VA_INBOUND_PER_MIN_CAP (registered in the env docs; default 30/min).
const inboundForwardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.VA_INBOUND_PER_MIN_CAP, 10) || 30,
  keyGenerator: () => 'global',
  handler: (req, res) => {
    res.set('Content-Type', 'text/xml').send(
      `${XML_DECL}<Response><Say>All lines are busy. Please try again shortly.</Say><Hangup/></Response>`
    );
  },
});

// isValidTwilioRequest moved to server/utils/twilioSignature.js so the
// lead-call webhooks (voiceLeadCall.js) share the check without importing a
// router. Policy on failure stays here (passesSignature: prod 403, dev allow).

// Dependency-injection seam for tests (mirrors server/utils/sms.js:57-58
// __setSmsDeps). Lets unit tests stub the signature gate + DB/Telegram calls
// so no real webhook signature, Neon query, or Bot API request is made.
let _deps = {
  isValidTwilioRequest, lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit, sendTelegramMessage,
  // Voicemail (spec 2026-07-22). Sentry goes through the seam too: the only
  // observable difference between the 'skipped' and 'failed' delivery outcomes
  // is whether Sentry is paged, so it has to be assertable.
  sendTelegramAudio,
  claimMissedCall: voicemail.claimMissedCall,
  countVoicemailsSince: voicemail.countVoicemailsSince,
  claimDelivery: voicemail.claimDelivery,
  markDelivery: voicemail.markDelivery,
  deliverVoicemail: (...a) => voicemail.deliverVoicemail(...a),
  deleteRecording: voicemail.deleteRecording,
  isRecordingSid: voicemail.isRecordingSid,
  captureMessage: (...a) => Sentry.captureMessage(...a),
  captureException: (...a) => Sentry.captureException(...a),
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

function vmMaxLengthSec() {
  const n = parseInt(process.env.VM_MAX_LENGTH_SEC, 10);
  return Math.min(300, Math.max(30, Number.isFinite(n) ? n : 120));
}

function vmDailyCap() {
  const n = parseInt(process.env.VM_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// Sentry emission on signature failure is throttled INDEPENDENTLY of the rate
// limiter. The limiter cannot cap it: its key is the caller-supplied CallSid,
// and while a malformed one collapses into a shared bucket, a well-formed
// random one (2^128 of them) gets a fresh budget every time, so an
// unauthenticated flood is never limited and every request would emit an event.
// That is a 1:1 amplifier against the org's Sentry quota, reachable with no
// credentials and NOT gated by VOICEMAIL_ENABLED (the switch is checked inside
// the handler, after this). A plain per-window counter caps it; the first few
// events carry the suppressed count so the signal is not lost.
const SIG_FAILURE_WINDOW_MS = 60 * 1000;
const SIG_FAILURE_REPORTS_PER_WINDOW = 5;
let sigWindowStart = 0;
let sigFailures = 0;

function claimSigFailureReport() {
  const now = Date.now();
  if (now - sigWindowStart > SIG_FAILURE_WINDOW_MS) {
    sigWindowStart = now;
    sigFailures = 0;
  }
  sigFailures += 1;
  return sigFailures <= SIG_FAILURE_REPORTS_PER_WINDOW;
}

/**
 * Fail-closed signature gate for the voicemail webhooks. Deliberately NOT
 * passesSignature above: these endpoints record client voice, incur per-minute
 * spend, and make a DESTRUCTIVE Twilio API call, so there is no dev
 * warn-and-allow path. Mirrors voiceLeadCall.js requireSignature.
 */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  if (process.env.SENTRY_DSN_SERVER && claimSigFailureReport()) {
    _deps.captureMessage('Twilio voicemail webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'twilio-voice', route: tag, reason: 'invalid_signature' },
      extra: { suppressedSinceWindowStart: sigFailures - SIG_FAILURE_REPORTS_PER_WINDOW },
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

function chicagoTime(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Signature gate shared by all three voice webhooks. Mirrors the sms.js
 * inbound handler (server/routes/sms.js:50-65): prod rejects a bad/missing
 * signature with 403 (privileged call-bridging behavior is NEVER honored on a
 * dev signature-skip in production); dev warns and allows so the endpoints are
 * testable without live Twilio creds. Returns true when the request may proceed;
 * when it returns false it has already sent the 403 response.
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
router.post('/inbound', inboundForwardLimiter, (req, res) => {
  if (!passesSignature(req, res, 'inbound')) return;
  const rawFrom = req.body.From || '';
  const caller = /^\+?[0-9]{7,15}$/.test(rawFrom) ? rawFrom : (process.env.VOICE_CALLER_ID || '');
  const vaCell = process.env.VA_CELL || '';
  sendTwiml(
    res,
    `<Response><Dial timeout="20" action="${xmlEscape(API_URL)}/api/voice/inbound/missed" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
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

  // Cheap branch is the default: only an explicitly recognized miss costs money.
  if (!voicemailEnabled() || !MISSED_STATUSES.has(status) || !callSid) {
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  const fromE164 = callerE164(req.body.From);
  const tail = `sid=...${String(callSid).slice(-4)}`;

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
    claimed = await _deps.claimMissedCall({ callSid, fromE164 });
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

  const greeting = "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";
  sendTwiml(
    res,
    '<Response>'
    + `<Say voice="Polly.Joanna-Neural">${xmlEscape(greeting)}</Say>`
    + `<Record maxLength="${vmMaxLengthSec()}" playBeep="true" trim="trim-silence" finishOnKey="#"`
    + ` recordingStatusCallback="${xmlEscape(API_URL)}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>'
    + '<Hangup/>'
    + '</Response>'
  );
  console.log(`[voice/missed] offering voicemail ${tail} status=${status}`);

  pingMissed(fromE164);
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
  return { callSid, recordingSid, durationSec, fromE164: claim.fromE164, tail };
}

async function deliverClaimedVoicemail({ callSid, recordingSid, durationSec, fromE164, tail }) {
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

  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed) {
    // Documented bootstrap mode. Deliberately writes NO status: the row stays
    // 'recorded', which is what keeps it inside the sweep's retry window, so the
    // voicemail is delivered once the id is set and the app redeploys. Writing
    // 'skipped' here parked it outside BOTH the sweep filter and the prune,
    // stranding real client audio in the Twilio console forever. That is
    // precisely the parking deliverVoicemail refuses to do, and the rollout
    // procedure walks through this exact state.
    console.warn(`[voice/voicemail] TELEGRAM_ALLOWED_USER_ID unset, recording retained and still retryable ${tail}`);
    return;
  }

  // The fetch/upload/three-outcome/delete decision lives in ONE place shared
  // with the scheduler's redelivery sweep (utils/voicemail.js deliverVoicemail).
  // Duplicating it here is what let the sweep collapse a gated send into a
  // permanent failure.
  const outcome = await _deps.deliverVoicemail({
    callSid, recordingSid, durationSec, fromE164, chatId: allowed,
  });

  const who = fromE164 || 'a withheld number';
  if (outcome === 'unfetchable') {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureMessage('Voicemail media could not be retrieved', {
        level: 'warning', tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' },
      });
    }
    await _deps.sendTelegramMessage(allowed, `Voicemail from ${who} could not be retrieved. It is still in the Twilio console.`);
    return;
  }
  if (outcome === 'failed') {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.captureMessage('Voicemail Telegram upload failed', {
        level: 'warning', tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' },
      });
    }
    await _deps.sendTelegramMessage(allowed, `Voicemail from ${who} did not come through. It is still in the Twilio console.`);
  }
  // 'delivered' and 'skipped' need no operator action. 'skipped' deliberately
  // stays retryable for the sweep rather than being parked in a status.
}

module.exports = router;
