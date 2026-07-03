const express = require('express');
const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { xmlEscape } = require('../utils/xmlEscape');
const { lookupTargetByCallSid, recordAudit } = require('../utils/pendingCall');
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

/**
 * Verify an inbound request is genuinely from Twilio. Copied verbatim from
 * server/routes/sms.js (isValidTwilioRequest, lines 30-42): validateRequest
 * hashes the public URL + sorted POST params with the account auth token.
 * Any throw is treated as "invalid".
 */
function isValidTwilioRequest(req) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const signature = req.headers['x-twilio-signature'];
    if (!signature) return false;
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return twilio.validateRequest(authToken, signature, url, req.body || {});
  } catch (err) {
    console.warn('[voice] signature verification threw:', err.message);
    return false;
  }
}

// Existence probe for status-callback de-dupe: has this exact (CallSid, status)
// already been audited? Twilio retries status callbacks at-least-once, so a
// redelivered dead-leg would otherwise ping Zul + append a second audit row.
async function auditRowExists(callSid, status) {
  if (!callSid) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM call_audit WHERE call_sid = $1 AND status = $2 LIMIT 1',
    [callSid, status]
  );
  return rows.length > 0;
}

// Dependency-injection seam for tests (mirrors server/utils/sms.js:57-58
// __setSmsDeps). Lets unit tests stub the signature gate + DB/Telegram calls
// so no real webhook signature, Neon query, or Bot API request is made.
let _deps = { isValidTwilioRequest, lookupTargetByCallSid, recordAudit, sendTelegramMessage, auditRowExists };
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
    // De-dupe Twilio's at-least-once status retries: if we already audited this
    // exact (CallSid, status) we already messaged Zul, so skip the duplicate
    // Telegram + audit. Best-effort — if the probe itself fails, fall through and
    // notify (a rare double-ping beats a silently-swallowed dead-leg alert).
    let alreadyAudited = false;
    try {
      alreadyAudited = await _deps.auditRowExists(callSid, status);
    } catch (err) {
      console.error('[voice/status] audit dedup probe failed:', err.message);
    }
    if (alreadyAudited) {
      res.status(204).end();
      return;
    }
    const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
    let alertDelivered = !allowed; // nothing to deliver when no allowed user is configured
    if (allowed) {
      try {
        await _deps.sendTelegramMessage(allowed, "That call didn't connect, resend the number to retry.");
        alertDelivered = true;
      } catch (err) {
        console.error('[voice/status] telegram notify failed:', err.message);
      }
    }
    // The audit row doubles as the dedup marker above, so it must only be
    // written once the alert actually went out (or none was owed). Writing it
    // on a failed send would make Twilio's redelivery skip the alert forever.
    if (alertDelivered) {
      try {
        await _deps.recordAudit({
          triggeredBy: allowed ? Number(allowed) : null,
          targetE164: null,
          callSid,
          status,
        });
      } catch (err) {
        console.error('[voice/status] audit write failed:', err.message);
      }
    }
  }
  res.status(204).end();
});

module.exports = router;
