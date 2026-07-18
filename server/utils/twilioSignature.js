const twilio = require('twilio');

/**
 * Verify an inbound request is genuinely from Twilio. Extracted verbatim from
 * server/routes/voice.js (itself copied from server/routes/sms.js
 * isValidTwilioRequest): validateRequest hashes the public URL + sorted POST
 * params with the account auth token. Any throw is treated as "invalid".
 *
 * Shared by the voice webhooks (voice.js, dev warn-and-allow policy) and the
 * lead-call webhooks (voiceLeadCall.js, fail-closed in EVERY environment).
 * The POLICY on a failed check belongs to each router; this helper only
 * answers "is the signature valid".
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
    console.warn('[twilioSignature] verification threw:', err.message);
    return false;
  }
}

module.exports = { isValidTwilioRequest };
