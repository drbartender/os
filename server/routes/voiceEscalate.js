// server/routes/voiceEscalate.js
//
// The press-1 escalation (spec 2026-07-26 section 3). A caller who reaches
// either line's voicemail may press 1 to try the OTHER person before leaving a
// message; if that person does not pick up, the caller lands back in voicemail.
//
// Its own router file, mounted at /api/voice/escalate ahead of /api/voice, the
// same shape voiceLeadCall.js already uses for the lead-call voice concern. That
// keeps server/routes/voice.js under the file-size cap and keeps this new billed
// path reviewable on its own.
//
// TOLL-FRAUD NOTE: every press-1 places a billed outbound leg, and on the
// primary line that leg is INTERNATIONAL (Zul's PH cell). It is reachable by
// anyone who can call a public number and press a key. So the dial is guarded
// four ways before it happens: a kill switch, a single-use claim, a rolling daily
// cap (serialized with the claim, so it is a hard bound), and a quiet window.
// Targets come only from env, never from the request.

const express = require('express');
const Sentry = require('@sentry/node');
const rateLimit = require('express-rate-limit');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { API_URL } = require('../utils/urls');
const { resolveLine, escalationTargetFor, inQuietWindow } = require('../utils/voicemailLine');
const { recordVerb, escalationEnabled } = require('../utils/voicemailTwiml');
const escalation = require('../utils/voicemailEscalation');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const WHISPER_TEXT = 'Dr. Bartender client on the line. Press any key to take the call.';

let _deps = {
  isValidTwilioRequest,
  claimEscalationUnderCap: (...a) => escalation.claimEscalationUnderCap(...a),
  markEscalationAccepted: (...a) => escalation.markEscalationAccepted(...a),
  wasEscalationAccepted: (...a) => escalation.wasEscalationAccepted(...a),
  recordEscalationOutcome: (...a) => escalation.recordEscalationOutcome(...a),
  captureMessage: (...a) => Sentry.captureMessage(...a),
};
function __setEscalateDeps(d) { _deps = { ..._deps, ...d }; }
router.__setEscalateDeps = __setEscalateDeps;

// Per-window Sentry claim, same mechanism as voice.js makeWindowClaim: the
// limiter cannot cap signature-failure emission (a well-formed random CallSid
// mints a fresh bucket every request), so an unsigned flood would amplify 1:1
// into the org's Sentry quota without this. Local copy rather than an import
// from a router file; the per-router duplication of the webhook plumbing is
// this codebase's existing pattern (voiceLeadCall.js).
const SIG_WINDOW_MS = 60 * 1000;
const SIG_ALLOWANCE = 5;
let sigStart = 0;
let sigHits = 0;
let sigPrevOverflow = 0;
function claimSigFailureReport() {
  const now = Date.now();
  if (now - sigStart > SIG_WINDOW_MS) {
    sigPrevOverflow = Math.max(0, sigHits - SIG_ALLOWANCE);
    sigStart = now;
    sigHits = 0;
  }
  sigHits += 1;
  return { allowed: sigHits <= SIG_ALLOWANCE, suppressedPreviousWindow: sigPrevOverflow };
}

// Same per-CallSid limiter shape as the voicemail webhooks in voice.js: the key
// is shape-validated so a flood of junk SIDs collapses into one bucket instead
// of minting unbounded keys, and these routes are only reachable as a
// consequence of a call that already passed the inbound cap. Limiter-first is
// safe HERE, unlike the forward routes' H1: an attacker cannot aim junk at a
// real call's bucket without knowing its unguessable CallSid, so a flood only
// exhausts the shared 'unvalidated' bucket.
const CALL_SID_RE = /^CA[0-9a-f]{32}$/;
const escalateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const sid = (req.body && req.body.CallSid) || '';
    return CALL_SID_RE.test(sid) ? sid : 'unvalidated';
  },
  // Every route here is on a LIVE caller's path, so a bare 429 would make Twilio
  // play "an application error has occurred" at a real client. Give the CALLER
  // routes the recording; /whisper and /accept run on the CHILD leg (the
  // answering party), who must never be offered a beep and recorded.
  handler: (req, res) => {
    if (req.path === '/whisper' || req.path === '/accept') {
      return sendTwiml(res, '<Response><Hangup/></Response>');
    }
    sendTwiml(res, `<Response>${recordVerb()}<Hangup/></Response>`);
  },
});

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

/** Fail-closed signature gate. No dev skip: these routes place billed legs. */
function requireSignature(req, res, tag) {
  if (!_deps.isValidTwilioRequest(req)) {
    const claim = process.env.SENTRY_DSN_SERVER ? claimSigFailureReport() : null;
    if (claim && claim.allowed) {
      _deps.captureMessage('Twilio escalation webhook signature failure', {
        level: 'warning',
        tags: { webhook: 'twilio-voice-escalate', route: tag, reason: 'invalid_signature' },
        extra: { suppressedPreviousWindow: claim.suppressedPreviousWindow },
      });
    }
    res.status(403).send('Invalid signature');
    return false;
  }
  return true;
}

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

/** The fallback every declined or blocked escalation takes: leave a message. */
function recordTwiml(res) {
  sendTwiml(res, `<Response>${recordVerb()}<Hangup/></Response>`);
}

/**
 * POST /api/voice/escalate. the <Gather action> from the missed-call greeting.
 * Only reached when the caller actually pressed a key; a timeout with no input
 * falls through to the <Record> that follows </Gather> in that document.
 */
router.post('/', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate')) return;

  const line = resolveLine(req.query.line);
  const callSid = req.body.CallSid || null;
  const tail = `sid=...${String(callSid || '').slice(-4)}`;

  // Anything but 1 is "just let me leave a message". No claim, so no spend. The
  // sid shape is checked here because it is about to be echoed into two URLs.
  if (req.body.Digits !== '1' || !escalationEnabled() || !escalation.isCallSid(callSid)) {
    return recordTwiml(res);
  }

  // Outcome writes on the skip paths run AFTER the response is sent: they are
  // observability only, and a live caller is waiting on this TwiML (Twilio
  // gives up at ~15s, and a pool stall would eat that budget twice over).
  const recordOutcome = (outcome) => {
    _deps.recordEscalationOutcome({ callSid, outcome })
      .catch((err) => console.error(`[vm-escalate] outcome write failed ${tail}: ${err.message}`));
  };

  const target = escalationTargetFor(line);
  if (!target) {
    console.error(`[vm-escalate] no valid target for line=${line} ${tail}`);
    recordTwiml(res);
    return recordOutcome('skipped_no_target');
  }

  if (inQuietWindow(line)) {
    console.log(`[vm-escalate] quiet window, not dialing line=${line} ${tail}`);
    recordTwiml(res);
    return recordOutcome('skipped_quiet');
  }

  // Cap and claim as ONE serialized unit (voicemailEscalation.js): checking
  // then claiming in two statements admits cap + concurrency billed legs. A
  // capped refusal consumes no claim. Fails CLOSED: any DB failure means no
  // dial, and a redelivered <Gather action> loses the claim and takes the
  // recording path instead of dialing again.
  let result = null;
  try {
    result = await _deps.claimEscalationUnderCap(callSid);
  } catch (err) {
    console.error(`[vm-escalate] cap/claim failed ${tail}: ${err.message}`);
  }
  if (!result) return recordTwiml(res);
  if (result.capped) {
    console.warn(`[vm-escalate] VM_ESCALATION_DAILY_CAP tripped ${tail}`);
    recordTwiml(res);
    return recordOutcome('skipped_cap');
  }
  if (!result.claim) {
    console.log(`[vm-escalate] claim lost or unknown call ${tail}`);
    return recordTwiml(res);
  }
  if (result.claim.line !== line) {
    // The row's line is the trusted value; the query's is HMAC-covered but
    // request-derived. They should never disagree, so a divergence is a signal
    // worth seeing (target and quiet window were chosen off the query value).
    console.warn(`[vm-escalate] line mismatch query=${line} row=${result.claim.line} ${tail}`);
  }

  // Attribute-value invariant: xmlEscape covers & < > but NOT quotes, so every
  // attribute below is a validated integer, a fixed enum, an env E.164, or a
  // shape-validated CallSid. The parent sid rides along because the whisper and
  // accept callbacks run on the CHILD leg, where req.body.CallSid is the child's,
  // while the acceptance flag belongs to this parent's ledger row.
  const doneUrl = `${API_URL}/api/voice/escalate/done?line=${line}&sid=${callSid}`;
  const whisperUrl = `${API_URL}/api/voice/escalate/whisper?sid=${callSid}`;
  // callerId is OUR line, never the inbound From (Twilio's default): a spoofed
  // premium-rate From would otherwise land in the answerer's call log as a
  // one-tap wangiri callback, routing around pingMissed's isUsE164 guard, and
  // a carrier's non-E.164 From would error the whole <Dial>.
  const callerId = String(process.env.VOICE_CALLER_ID || '').trim();
  console.log(`[vm-escalate] dialing line=${line} target=...${target.slice(-4)} ${tail}`);
  sendTwiml(res,
    '<Response>'
    + `<Dial timeout="20" action="${xmlEscape(doneUrl)}" method="POST" callerId="${xmlEscape(callerId)}" timeLimit="${timeLimitSec()}">`
    + `<Number url="${xmlEscape(whisperUrl)}" method="POST">${xmlEscape(target)}</Number>`
    + '</Dial>'
    + '</Response>'
  );
});

/**
 * POST /api/voice/escalate/whisper. TwiML played to the ANSWERING party only,
 * before the two legs are bridged.
 *
 * The <Gather> plus trailing <Hangup/> is a screening gate, not decoration: a
 * bare <Say> whisper would let the target's carrier voicemail "answer", report
 * completed, and swallow the client. Requiring a keypress means only a human can
 * accept; an unattended voicemail falls through to the Hangup, the leg ends, and
 * the outer <Dial action> returns the caller to our voicemail.
 */
router.post('/whisper', escalateLimiter, (req, res) => {
  if (!requireSignature(req, res, 'escalate/whisper')) return;
  // The parent sid round-trips so /accept can flag the right ledger row. Validated
  // on the way in as well as the way out: it is our own value, but it arrives over
  // the wire. Without a valid parent there is nothing an acceptance could attach
  // to, so playing the screen would be theatre: the target would press a key as
  // instructed and be cut off anyway. Hang up the leg instead; the outer <Dial
  // action> then offers the caller voicemail.
  const parentSid = escalation.isCallSid(req.query.sid) ? req.query.sid : '';
  if (!parentSid) {
    return sendTwiml(res, '<Response><Hangup/></Response>');
  }
  const acceptUrl = `${API_URL}/api/voice/escalate/accept?sid=${parentSid}`;
  // finishOnKey="" because the copy says "press ANY key": the default finish
  // key is #, which would end the Gather with zero digits and hang up on a
  // human who did exactly as told.
  sendTwiml(res,
    '<Response>'
    + `<Gather numDigits="1" timeout="8" finishOnKey="" action="${xmlEscape(acceptUrl)}" method="POST">`
    + `<Say voice="Polly.Joanna-Neural">${xmlEscape(WHISPER_TEXT)}</Say>`
    + '</Gather>'
    + '<Hangup/>'
    + '</Response>'
  );
});

/**
 * POST /api/voice/escalate/accept. The whisper's <Gather action>, so it fires ONLY
 * on a real keypress. Records acceptance against the PARENT call, then returns an
 * empty response, which ends the whisper document and bridges the two parties.
 *
 * This runs on the child leg, so req.body.CallSid here is the DIALED party's sid,
 * not the caller's. The acceptance flag belongs to the parent, hence ?sid=.
 */
router.post('/accept', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate/accept')) return;
  const parentSid = req.query.sid;
  if (!req.body.Digits || !escalation.isCallSid(parentSid)) {
    // Gather normally falls through to <Hangup/> on a timeout rather than calling
    // this URL with no digits, but never bridge without a keypress, and never
    // bridge a leg that cannot be attributed to a parent call.
    return sendTwiml(res, '<Response><Hangup/></Response>');
  }
  try {
    await _deps.markEscalationAccepted(parentSid);
  } catch (err) {
    // A human IS on the line expecting to be connected, so failing the bridge over
    // a bookkeeping error would be worse than a mis-recorded outcome. The cost is
    // that /done may offer voicemail after they hang up.
    console.error(`[vm-escalate] accept write failed sid=...${String(parentSid).slice(-4)}: ${err.message}`);
  }
  console.log(`[vm-escalate] accepted by keypress sid=...${String(parentSid).slice(-4)}`);
  sendTwiml(res, '<Response></Response>');
});

/**
 * POST /api/voice/escalate/done. The outer <Dial action>, requested when the
 * escalation leg ends for any reason.
 *
 * Branches on ACCEPTANCE, never on DialCallStatus. Hanging up the screened leg
 * still counts as an answered child leg, so Twilio reports 'completed' both when a
 * human talked to the client and when a carrier voicemail grabbed the call and the
 * whisper rejected it. Only an explicit keypress separates them, and getting this
 * wrong hangs up on a caller who never reached a person.
 */
router.post('/done', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate/done')) return;

  // This runs on the PARENT leg, so body.CallSid is a valid fallback for a lost
  // query sid; shape-gated like every other sid in this file.
  const querySid = escalation.isCallSid(req.query.sid) ? req.query.sid : null;
  const bodySid = escalation.isCallSid(req.body.CallSid) ? req.body.CallSid : null;
  const parentSid = querySid || bodySid;
  const status = req.body.DialCallStatus;
  const line = resolveLine(req.query.line);

  // The acceptance read is load-bearing (it decides the document); the outcome
  // write is not, so it runs AFTER the response. Fails CLOSED toward the
  // caller: on any doubt, offer voicemail. A wrong "voicemail" is recoverable;
  // a wrong "hang up" loses the lead in silence.
  let accepted = false;
  try {
    accepted = await _deps.wasEscalationAccepted(parentSid);
  } catch (err) {
    console.error(`[vm-escalate] acceptance read failed: ${err.message}`);
  }

  if (accepted) {
    // They talked. Nothing left to record.
    sendTwiml(res, '<Response><Hangup/></Response>');
  } else {
    console.log(`[vm-escalate] not accepted (status=${status}) line=${line}, back to voicemail sid=...${String(parentSid || '').slice(-4)}`);
    recordTwiml(res);
  }

  if (parentSid) {
    _deps.recordEscalationOutcome({
      callSid: parentSid, outcome: accepted ? 'answered' : 'no_answer',
    }).catch((err) => console.error(`[vm-escalate] outcome write failed: ${err.message}`));
  }
});

module.exports = router;
