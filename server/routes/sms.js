const express = require('express');
const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { processInboundSms } = require('../utils/smsInbound');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { sendSMS, normalizePhone } = require('../utils/sms');
// Auth: import `auth` and the admin/manager guard exactly as
// server/routes/emailMarketing.js does.
const { auth, requireAdminOrManager } = require('../middleware/auth');

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

/**
 * GET /api/sms/conversations — one row per client that has any SMS, newest
 * activity first, with an unread inbound count.
 */
router.get('/conversations', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT c.id AS client_id, c.name, c.phone,
      (SELECT COUNT(*) FROM sms_messages m
        WHERE m.client_id = c.id AND m.direction = 'inbound' AND m.read_at IS NULL)::int AS unread_count,
      (SELECT MAX(m2.created_at) FROM sms_messages m2 WHERE m2.client_id = c.id) AS last_message_at
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM sms_messages m3 WHERE m3.client_id = c.id)
    ORDER BY last_message_at DESC
    LIMIT 200
  `);
  res.json(result.rows);
}));

/** GET /api/sms/conversations/:clientId — full message thread, oldest first. */
router.get('/conversations/:clientId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const result = await pool.query(
    `SELECT id, direction, body, status, twilio_sid, read_at, created_at
     FROM sms_messages WHERE client_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [clientId]
  );
  res.json(result.rows);
}));

/**
 * POST /api/sms/conversations/:clientId/reply — send an outbound SMS to the
 * client and log it. Body: { body }.
 */
router.post('/conversations/:clientId/reply', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const body = (req.body.body || '').trim();
  if (!body) throw new ValidationError({ body: 'Message body is required.' });

  const c = await pool.query('SELECT id, name, phone FROM clients WHERE id = $1', [clientId]);
  const client = c.rows[0];
  if (!client) throw new NotFoundError('Client not found.');
  const to = normalizePhone(client.phone || '');
  if (!to) throw new ValidationError({ phone: 'This client has no valid phone number on file.' });

  let twilioSid = null;
  let status = 'sent';
  let errorMessage = null;
  try {
    const sent = await sendSMS({ to, body });
    twilioSid = sent && sent.sid ? sent.sid : null;
  } catch (err) {
    status = 'failed';
    errorMessage = String(err.message || err).slice(0, 500);
  }

  const row = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, recipient_name, body, message_type, status, twilio_sid, error_message, sender_id)
     VALUES ('outbound', $1, $2, $3, $4, 'general', $5, $6, $7, $8)
     RETURNING id, direction, body, status, twilio_sid, read_at, created_at`,
    [clientId, to, client.name || null, body, status, twilioSid, errorMessage, req.user.id]
  );

  if (status === 'failed') {
    throw new ValidationError({ body: 'The SMS could not be sent. It is saved in the thread as failed.' });
  }
  res.status(201).json(row.rows[0]);
}));

/**
 * PUT /api/sms/conversations/:clientId/read — mark every unread inbound
 * message for this client as read.
 */
router.put('/conversations/:clientId/read', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const result = await pool.query(
    `UPDATE sms_messages SET read_at = NOW()
     WHERE client_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
    [clientId]
  );
  res.json({ marked_read: result.rowCount });
}));

module.exports = router;
