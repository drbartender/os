const express = require('express');
const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { processInboundSms } = require('../utils/smsInbound');

const router = express.Router();

const rateLimit = require('express-rate-limit');

// Rate-limit the public inbound webhook (mirrors the Thumbtack webhook
// limiter). Caps abuse / signature-computation CPU / DB-write amplification.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
});

/**
 * Verify an inbound request is genuinely from Twilio. validateRequest hashes
 * the public URL + the sorted POST params with the account auth token.
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
    console.warn('[sms/inbound] signature verification threw:', err.message);
    return false;
  }
}

/**
 * POST /api/sms/inbound — Twilio inbound-message webhook. No JWT (provider
 * webhook; authenticity comes from the Twilio signature). 403 on bad/missing
 * signature; 500 on unexpected error (Twilio retries — safe, processInboundSms
 * dedupes on MessageSid); 200 with TwiML on every handled outcome.
 */
router.post('/inbound', inboundLimiter, async (req, res) => {
  const inProd = process.env.NODE_ENV === 'production';

  // Signature gate. In production a bad/missing signature is rejected. In dev,
  // Twilio creds may be absent — allow through so the webhook is testable.
  if (!isValidTwilioRequest(req)) {
    if (inProd) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('Twilio inbound webhook signature failure', {
          level: 'warning', tags: { webhook: 'twilio', reason: 'invalid_signature' },
        });
      }
      return res.status(403).send('Invalid signature');
    }
    console.warn('[sms/inbound] signature not validated (dev mode — allowing)');
  }

  let reply = null;
  try {
    const result = await processInboundSms({
      from: req.body.From,
      body: req.body.Body,
      twilioSid: req.body.MessageSid,
    });
    reply = result.reply;
    console.log(`[sms/inbound] processed: ${result.outcome}`);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'twilio' }, extra: { from: req.body && req.body.From } });
    }
    console.error('[sms/inbound] processing failed:', err.message);
    // Return 500 so Twilio retries with backoff. processInboundSms dedupes on
    // MessageSid, so a retry of an already-recorded message is a safe no-op.
    return res.status(500).send('Processing error');
  }

  // Render the optional reply into TwiML. `reply` is system-generated copy;
  // escape XML metacharacters defensively regardless.
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const twiml = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  res.set('Content-Type', 'text/xml').send(twiml);
});

module.exports = router;
