const express = require('express');
const Sentry = require('@sentry/node');
const { processInboundSms, findThumbtackProxyLead } = require('../utils/smsInbound');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { sendSMS, normalizePhone, smsStatusCallbackUrl, twilioErrorText } = require('../utils/sms');
const { xmlEscape } = require('../utils/xmlEscape');
const presenceStore = require('../utils/presenceStore');
// Auth: import `auth` and the admin/manager guard exactly as
// server/routes/emailMarketing.js does.
const { auth, requireAdminOrManager } = require('../middleware/auth');
// Twilio webhook signatures: the shared check (server/utils/twilioSignature.js,
// the same code this file used to carry). Each route keeps its own policy.
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const {
  recordOptOut, textability, isTwilioOptOutError, optedOutMessage, BAD_NUMBER_MESSAGE,
} = require('../utils/smsOptOut');
const { lineKeyForNumber, defaultLine, lastHumanLineFromRows } = require('../utils/smsLines');
const { FAILED_DELIVERY_STATES } = require('../utils/smsDeliveryStatus');

const router = express.Router();

const rateLimit = require('express-rate-limit');

// Rate-limit the public inbound webhook (mirrors the Thumbtack webhook
// limiter). Caps abuse / signature-computation CPU / DB-write amplification.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
});

// Rate-limit the status callback like the inbound webhook, keyed by IP. Sized
// above the inbound cap because one text produces several callbacks (queued,
// sent, then delivered or failed), and a failure callback dropped here is a
// delivery failure nobody sees.
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: 'Too many requests',
});

// Picture messages (spec 2026-10-06): Twilio posts NumMedia, then MediaUrlN and
// MediaContentTypeN for N below it, at most 10. Only Twilio-hosted URLs are
// kept, so a forged request in dev (where an unsigned post is allowed) cannot
// plant an arbitrary link in an admin thread.
const TWILIO_MEDIA_URL = /^https:\/\/api\.twilio\.com\/\S{1,500}$/;
const MEDIA_TYPE = /^[a-z0-9.+-]{1,50}\/[a-z0-9.+-]{1,50}$/;

/**
 * @param {Object} body - the parsed Twilio webhook body
 * @returns {Array<{url:string, content_type:string|null}>}
 */
function twilioMedia(body) {
  const count = Math.min(10, Math.max(0, parseInt(body && body.NumMedia, 10) || 0));
  if (!count) return [];
  const urls = new Map();
  const types = new Map();
  for (const [key, value] of Object.entries(body)) {
    const u = /^MediaUrl(\d)$/.exec(key);
    if (u) urls.set(Number(u[1]), value);
    const t = /^MediaContentType(\d)$/.exec(key);
    if (t) types.set(Number(t[1]), value);
  }
  const media = [];
  for (let i = 0; i < count; i += 1) {
    const url = urls.get(i);
    if (typeof url !== 'string' || !TWILIO_MEDIA_URL.test(url)) continue;
    const type = String(types.get(i) || '').toLowerCase();
    media.push({ url, content_type: MEDIA_TYPE.test(type) ? type : null });
  }
  return media;
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

  // Presence sign of life (spec 2026-07-02): an inbound text from a tracked
  // admin's nudge phone proves they are alive. Best-effort; never affects
  // message routing below (staff CONFIRM/CANT keys on contractor_profiles
  // .phone, a different column).
  try {
    await presenceStore.stampByNudgePhone(req.body.From);
  } catch (err) {
    console.warn('[sms/inbound] presence stamp failed:', err.message);
  }

  let reply = null;
  try {
    const result = await processInboundSms({
      from: req.body.From,
      to: req.body.To,
      body: req.body.Body,
      twilioSid: req.body.MessageSid,
      media: twilioMedia(req.body),
    });
    reply = result.reply;
    console.log(`[sms/inbound] processed: ${result.outcome}`);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      // Redact the sender to last-4 — the raw From is client PII (match the
      // slice(-4) idiom in utils/sms.js / smsInbound.js).
      Sentry.captureException(err, { tags: { webhook: 'twilio' }, extra: { from: `...${String((req.body && req.body.From) || '').slice(-4)}` } });
    }
    console.error('[sms/inbound] processing failed:', err.message);
    // Return 500 so Twilio retries with backoff. processInboundSms dedupes on
    // MessageSid, so a retry of an already-recorded message is a safe no-op.
    return res.status(500).send('Processing error');
  }

  // Render the optional reply into TwiML. `reply` is system-generated copy;
  // escape XML metacharacters defensively regardless.
  const twiml = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  res.set('Content-Type', 'text/xml').send(twiml);
});

/**
 * POST /api/sms/status: Twilio's message status callback (spec 2026-10-06,
 * Inbox, section 9), registered only by Messages-page replies and Inbox sends
 * (smsStatusCallbackUrl()). Signature-verified exactly like /inbound: 403 in
 * production, warn and allow in dev. It records exactly two things:
 *   - error 21610 writes sms_optouts for the recipient (decision 10), first,
 *     so a failure in the row bookkeeping never skips it;
 *   - failed or undelivered flips the matching OUTBOUND row (by twilio_sid) to
 *     status 'failed', with Twilio's numeric error code in error_message.
 * A failure whose sid matches no row yet (the callback beat the sender's
 * INSERT, which runs after Twilio answers) is kept in sms_status_orphans for
 * the Inbox reader, unless the sid belongs to an inbound row; once it is
 * stored, the flip runs once more, so a reply row inserted in between (before
 * its own fold could see the orphan) still ends up failed.
 * Every other status is ignored and never stored: prod's status CHECK rejects
 * 'accepted', and queued, sent or delivered change nothing a reply depends on.
 * It does not touch clients.phone_status (fix list). 204 when handled; 500 on
 * a DB error.
 */
router.post('/status', statusLimiter, async (req, res) => {
  const inProd = process.env.NODE_ENV === 'production';
  if (!isValidTwilioRequest(req)) {
    if (inProd) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('Twilio status callback signature failure', {
          level: 'warning', tags: { webhook: 'twilio_status', reason: 'invalid_signature' },
        });
      }
      return res.status(403).send('Invalid signature');
    }
    console.warn('[sms/status] signature not validated (dev mode, allowing)');
  }

  // Every field is read only when it is a string: production parses urlencoded
  // with extended: true, so a bracketed field arrives as an object, and nothing
  // here may throw before the try. ErrorCode is kept only when it is a number,
  // so a forged callback can never put free text on a row.
  const b = req.body || {};
  const sid = typeof b.MessageSid === 'string' ? b.MessageSid.slice(0, 100) : null;
  const status = typeof b.MessageStatus === 'string' ? b.MessageStatus.toLowerCase() : '';
  const rawCode = typeof b.ErrorCode === 'string' ? b.ErrorCode.trim() : '';
  const code = /^\d{1,10}$/.test(rawCode) ? rawCode : null;
  const to = typeof b.To === 'string' ? b.To : null;
  const from = typeof b.From === 'string' ? b.From : null;
  try {
    // The compliance write goes first, so a failure in the row bookkeeping
    // below can never skip it.
    if (code === '21610') {
      await recordOptOut({ phone: to, source: 'twilio_21610', line: lineKeyForNumber(from) });
    }
    if (sid && FAILED_DELIVERY_STATES.has(status)) {
      const errorText = `Twilio ${code || 'error'} (${status})`;
      const flip = () => pool.query(
        `UPDATE sms_messages SET status = 'failed', error_message = $2
          WHERE twilio_sid = $1 AND direction = 'outbound'`,
        [sid, errorText]
      );
      const flipped = await flip();
      if (flipped.rowCount === 0) {
        // No row yet: keep the failure rather than lose it. The first failure
        // per sid wins; $1 is cast once per use so its type is never ambiguous.
        const orphan = await pool.query(
          `INSERT INTO sms_status_orphans (twilio_sid, status, error_message)
           SELECT $1::text, 'failed', $2::text
            WHERE NOT EXISTS (
              SELECT 1 FROM sms_messages WHERE twilio_sid = $1::text AND direction = 'inbound'
            )
           ON CONFLICT (twilio_sid) DO NOTHING`,
          [sid, errorText]
        );
        // The reply inserts its row and then folds the orphan; this side flips
        // and then stores the orphan. Flipping once more after storing it means
        // whichever side writes second sees the other's write.
        if (orphan.rowCount > 0) await flip();
      }
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'twilio_status' } });
    }
    console.error('[sms/status] processing failed:', err.message);
    return res.status(500).send('Processing error');
  }
  res.status(204).end();
});

/**
 * GET /api/sms/conversations — one row per client that has any SMS. Threads with
 * an unread inbound come first; within each block, ordered by the client's most
 * recent inbound (received) message, newest first. Threads a client never replied
 * to (no inbound) sort last. Includes an unread inbound count.
 */
router.get('/conversations', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Thumbtack relay echoes (metadata.thumbtack_relay = 'true') are machine
  // traffic, not the client speaking: excluded from the list, the unread
  // count, AND the existence check, so a relay echo can never surface or
  // bump a thread. IS DISTINCT FROM keeps legacy NULL-metadata rows visible.
  //
  // Ordering runs in two blocks. Unread first (2026-08-25): a thread waiting on a
  // reply outranks every handled one no matter how old it is, so working the
  // inbox is always top-down and an unread thread can never be pushed past the
  // LIMIT by newer chatter. Inside each block the key is last_inbound_at (newest
  // received first) so clients waiting on a reply float up and an admin's own
  // outbound reply never bumps a handled thread. NULLS LAST keeps outbound-only
  // threads (no inbound) at the bottom rather than the top (a Postgres DESC sort
  // defaults NULLs first); the last_message_at tiebreak orders that outbound-only
  // tail by recency. The derived table exists so the sort can use unread_count in
  // an expression: Postgres allows a bare output alias in ORDER BY, not one
  // wrapped in `> 0`.
  const result = await pool.query(`
    SELECT * FROM (
      SELECT c.id AS client_id, c.name, c.phone,
        (SELECT COUNT(*) FROM sms_messages m
          WHERE m.client_id = c.id AND m.direction = 'inbound' AND m.read_at IS NULL
            AND (m.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')::int AS unread_count,
        (SELECT MAX(m2.created_at) FROM sms_messages m2 WHERE m2.client_id = c.id
            AND (m2.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_message_at,
        (SELECT MAX(m4.created_at) FROM sms_messages m4 WHERE m4.client_id = c.id
            AND m4.direction = 'inbound'
            AND (m4.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_inbound_at
      FROM clients c
      WHERE EXISTS (SELECT 1 FROM sms_messages m3 WHERE m3.client_id = c.id
            AND (m3.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')
    ) t
    ORDER BY (t.unread_count > 0) DESC, t.last_inbound_at DESC NULLS LAST, t.last_message_at DESC
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
     FROM sms_messages
     WHERE client_id = $1
       AND (metadata->>'thumbtack_relay') IS DISTINCT FROM 'true'
     ORDER BY created_at ASC LIMIT 500`,
    [clientId]
  );
  res.json(result.rows);
}));

// The line of the most recent human-involved text with this client (spec 5.8,
// decision 9), by the one rule Inbox also uses: lastHumanLineFromRows in
// smsLines.js (their texts, a relay text as their 888 text, our human replies
// that did not fail). The WHERE clause mirrors that rule only so the newest
// candidate is the one row fetched; the function still decides.
async function lastHumanLineForClient(clientId) {
  const r = await pool.query(
    `SELECT id, direction, sender_id, status, metadata, created_at
       FROM sms_messages
      WHERE client_id = $1
        AND (direction = 'inbound' OR (sender_id IS NOT NULL AND status IS DISTINCT FROM 'failed'))
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [clientId]
  );
  return lastHumanLineFromRows(r.rows);
}

// The reply's length cap, in the group send's own words (POST /api/messages/send).
const REPLY_TOO_LONG = 'Message must be 1600 characters or fewer';

/**
 * A step after Twilio took the reply failed. One log line with the client id
 * and the SQLSTATE, never the number or the text, and a Sentry event that
 * carries neither the raw error (a pg error's detail can quote the failing
 * row) nor anything else that could.
 */
function reportReplyStepFailed(step, clientId, err, level) {
  const sqlState = (err && err.code) || 'none';
  console.error(`[sms/reply] ${step} (client ${clientId}, sqlstate ${sqlState})`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`SMS reply: ${step}`, {
      level,
      tags: { route: 'POST /api/sms/conversations/:clientId/reply' },
      extra: { client_id: clientId, sql_state: sqlState },
    });
  }
}

/**
 * POST /api/sms/conversations/:clientId/reply: send an outbound SMS to the
 * client and log it. Body: { body }.
 *
 * Since spec 2026-10-06 (Inbox, section 9) it follows the rules every human
 * reply follows: the shared adminWriteLimiter; textability() refuses an
 * opted-out person on every line (409 INBOX_OPTED_OUT, also when Twilio
 * answers 21610) and a number marked bad (400); the default line (decision 9),
 * limited to INBOX_TEXT_LINES and to the 888 for a Thumbtack proxy number; a
 * status callback so a later delivery failure flips the row; metadata.line
 * from the number Twilio reports; twilioErrorText as a failed row's text; and
 * sent_by on the message_log row.
 *
 * Every refusal carries its own sentence as the message (the Messages pane
 * toasts it), and a body over 1600 characters is refused before anything is
 * read or sent. Once Twilio has taken the text, nothing may answer "try
 * again", or the client gets it twice: a row that fails to save answers 500
 * SMS_REPLY_UNRECORDED with do-not-resend copy, and the orphan fold is best
 * effort (logged, and the inserted row is returned).
 */
router.post('/conversations/:clientId/reply', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' }, 'Invalid client id.');
  const body = (req.body.body || '').trim();
  if (!body) throw new ValidationError({ body: 'Message body is required.' }, 'Message body is required.');
  if (body.length > 1600) throw new ValidationError({ body: REPLY_TOO_LONG }, REPLY_TOO_LONG);

  const c = await pool.query(
    'SELECT id, name, phone, communication_preferences, phone_status FROM clients WHERE id = $1',
    [clientId]
  );
  const client = c.rows[0];
  if (!client) throw new NotFoundError('Client not found.');
  const to = normalizePhone(client.phone || '');
  if (!to) {
    throw new ValidationError({ phone: 'This client has no valid phone number on file.' },
      'This client has no valid phone number on file.');
  }

  const verdict = await textability({ kind: 'client', client, phone: to });
  if (!verdict.ok && verdict.reason === 'opted_out') {
    throw new ConflictError(optedOutMessage(verdict.since), 'INBOX_OPTED_OUT');
  }
  if (!verdict.ok) throw new ValidationError({ phone: BAD_NUMBER_MESSAGE }, BAD_NUMBER_MESSAGE);

  const line = defaultLine({
    lastHumanLine: await lastHumanLineForClient(clientId),
    senderUserId: req.user.id,
    isStaff: false,
    isProxy: Boolean(await findThumbtackProxyLead(to)),
  });

  let twilioSid = null;
  let status = 'sent';
  let errorMessage = null;
  let fromNumber = null;
  let optedOutAtSend = false;
  try {
    const sent = await sendSMS({
      to, body, from: line, statusCallback: smsStatusCallbackUrl(),
      meta: { clientId, sentBy: req.user.id },
    });
    twilioSid = sent && sent.sid ? sent.sid : null;
    fromNumber = sent && sent.from ? sent.from : null;
  } catch (err) {
    status = 'failed';
    // The one stored failure text, never Twilio's prose (it can quote the number).
    errorMessage = twilioErrorText(err);
    optedOutAtSend = isTwilioOptOutError(err);
  }

  // From here on a sent text has already gone out, so nothing may answer "try
  // again": the admin would re-send and the client would get it twice.
  let row;
  try {
    row = await pool.query(
      `INSERT INTO sms_messages
         (direction, client_id, recipient_phone, recipient_name, body, message_type, status, twilio_sid, error_message, sender_id, metadata)
       VALUES ('outbound', $1, $2, $3, $4, 'general', $5, $6, $7, $8, $9)
       RETURNING id, direction, body, status, twilio_sid, read_at, created_at`,
      [clientId, to, client.name || null, body, status, twilioSid, errorMessage, req.user.id,
        JSON.stringify({ line: lineKeyForNumber(fromNumber) || line })]
    );
  } catch (err) {
    // Nothing went out, so the plain 500 is honest.
    if (status !== 'sent') throw err;
    reportReplyStepFailed('the text went out but its row did not save', clientId, err, 'error');
    throw new AppError('The text went out, but it could not be saved to the thread. Do not send it again.',
      500, 'SMS_REPLY_UNRECORDED');
  }
  // A failure callback that beat this INSERT sits in sms_status_orphans (spec amendment 19, this
  // lane's review): fold it in so the Messages page and Inbox agree; the orphan stays for Inbox.
  // Best effort: on an error the row stands as inserted, and Inbox still reads the orphan.
  let saved = row.rows[0];
  if (twilioSid) {
    try {
      const folded = await pool.query(
        `UPDATE sms_messages m SET status = 'failed', error_message = o.error_message
           FROM sms_status_orphans o
          WHERE m.id = $1 AND o.twilio_sid = m.twilio_sid
          RETURNING m.id, m.direction, m.body, m.status, m.twilio_sid, m.read_at, m.created_at`,
        [saved.id]
      );
      if (folded.rows[0]) saved = folded.rows[0];
    } catch (err) {
      reportReplyStepFailed('could not fold an early failure callback into the row', clientId, err, 'warning');
    }
  }

  // Twilio refused with 21610: sendSMS has already written sms_optouts, and the
  // failed row above keeps the attempt in the thread.
  if (optedOutAtSend) throw new ConflictError(optedOutMessage(new Date()), 'INBOX_OPTED_OUT');
  if (status === 'failed') {
    throw new ValidationError({ body: 'The SMS could not be sent. It is saved in the thread as failed.' },
      'The SMS could not be sent. It is saved in the thread as failed.');
  }
  res.status(201).json(saved);
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
