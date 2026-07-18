const express = require('express');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit } = require('../utils/pendingCall');
const { sendTelegramMessage } = require('../utils/telegram');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const DEAD_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

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
let _deps = { isValidTwilioRequest, lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit, sendTelegramMessage };
function __setVoiceDeps(d) { _deps = { ..._deps, ...d }; }
router.__setVoiceDeps = __setVoiceDeps;

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
    `<Response><Dial timeout="20" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
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

module.exports = router;
