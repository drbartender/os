const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

/**
 * POST /api/email-marketing/webhook/resend
 * Receives Resend webhook events for email tracking.
 * Verifies signature via svix headers if RESEND_WEBHOOK_SECRET is set.
 */
router.post('/resend', asyncHandler(async (req, res) => {
  try {
    // Fail closed: in production, a missing secret means forged events would be accepted.
    if (!process.env.RESEND_WEBHOOK_SECRET && process.env.NODE_ENV === 'production') {
      Sentry.captureMessage('RESEND_WEBHOOK_SECRET not set in production', {
        level: 'error',
        tags: { webhook: 'resend', reason: 'missing_secret' },
      });
      return res.status(401).json({ error: 'Webhook signature verification unavailable' });
    }
    if (!process.env.RESEND_WEBHOOK_SECRET) {
      console.warn('RESEND_WEBHOOK_SECRET not set — skipping signature verification (non-production)');
    }

    // Body arrives as a raw Buffer because express.raw() is mounted on this route in index.js
    // (svix requires the exact bytes that were signed — JSON.stringify of a parsed object would
    // re-order keys / change spacing and fail verification).
    const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

    if (process.env.RESEND_WEBHOOK_SECRET) {
      const { Webhook } = require('svix');
      const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
      try {
        wh.verify(payload, {
          'svix-id': req.headers['svix-id'],
          'svix-timestamp': req.headers['svix-timestamp'],
          'svix-signature': req.headers['svix-signature'],
        });
      } catch (verifyErr) {
        Sentry.captureMessage('Resend webhook signature failure', {
          level: 'warning',
          tags: { webhook: 'resend', reason: 'invalid_signature' },
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Parse AFTER verification
    let event;
    try {
      event = JSON.parse(payload);
    } catch (parseErr) {
      console.error('Webhook payload parse error:', parseErr.message);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const { type, data } = event;
    const resendId = data?.email_id;

    if (!type || !resendId) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Log raw event. ON CONFLICT dedupes the row so a Resend redelivery never inserts twice.
    const logged = await pool.query(
      `INSERT INTO email_webhook_events (resend_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (resend_id, event_type) DO NOTHING
       RETURNING id`,
      [resendId, type, payload]
    );
    if (logged.rowCount === 0) {
      // Row already recorded. Skip the side-effects ONLY if it was fully processed — a true
      // replay. If processed is still false, a prior delivery 500'd after the INSERT but
      // before finishing, so the event is stranded; fall through and re-run the side-effects
      // (all the writes below are idempotent UPDATEs) instead of losing it (audit 3c follow-up).
      const existing = await pool.query(
        'SELECT processed FROM email_webhook_events WHERE resend_id = $1 AND event_type = $2',
        [resendId, type]
      );
      if (existing.rows[0] && existing.rows[0].processed) {
        return res.json({ received: true, duplicate: true });
      }
    }

    // Map Resend event types to our status
    const statusMap = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
    };

    const newStatus = statusMap[type];
    if (!newStatus) {
      // Unknown event type — log and ignore
      return res.json({ received: true });
    }

    // Update email_sends status
    const TIMESTAMP_QUERIES = {
      'opened': 'UPDATE email_sends SET status = $1, opened_at = NOW() WHERE resend_id = $2',
      'clicked': 'UPDATE email_sends SET status = $1, clicked_at = NOW() WHERE resend_id = $2',
      'bounced': 'UPDATE email_sends SET status = $1, bounced_at = NOW() WHERE resend_id = $2',
      'complained': 'UPDATE email_sends SET status = $1, complained_at = NOW() WHERE resend_id = $2',
    };

    if (TIMESTAMP_QUERIES[newStatus]) {
      await pool.query(TIMESTAMP_QUERIES[newStatus], [newStatus, resendId]);
    } else {
      await pool.query(
        `UPDATE email_sends SET status = $1 WHERE resend_id = $2`,
        [newStatus, resendId]
      );
    }

    // For bounces/complaints, suppress the lead
    if (newStatus === 'bounced' || newStatus === 'complained') {
      const sendResult = await pool.query(
        'SELECT lead_id FROM email_sends WHERE resend_id = $1',
        [resendId]
      );
      if (sendResult.rows[0]) {
        await pool.query(
          `UPDATE email_leads SET status = $1 WHERE id = $2`,
          [newStatus, sendResult.rows[0].lead_id]
        );
        // Pause active enrollments
        await pool.query(
          `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
          [sendResult.rows[0].lead_id]
        );
      }

      // Delivery-failure fallback (spec 7.5): a hard bounce on a client-facing
      // address flips clients.email_status to 'bad' so the dispatcher's channel
      // substitution falls future touches over to SMS. Client-facing emails are
      // not tracked in email_sends, so match the recipient address from the
      // Resend payload (data.to is an array) against clients.email.
      //
      // Only PERMANENT bounces mark an address bad. Resend's email.bounced is
      // permanent-only today; if a future payload carries an explicit transient
      // type, skip the flip. Complaints (spam reports) also flip email_status,
      // continuing to email someone who reported us as spam is harmful.
      const bounceTypeRaw = String(
        data?.bounce?.type || data?.bounce_type || data?.type || ''
      ).toLowerCase();
      const isTransient = bounceTypeRaw.includes('transient')
        || bounceTypeRaw.includes('temporary')
        || bounceTypeRaw.includes('soft');
      if (!isTransient) {
        const recipients = Array.isArray(data?.to)
          ? data.to
          : (data?.to ? [data.to] : []);
        for (const addr of recipients) {
          if (!addr || typeof addr !== 'string') continue;
          await pool.query(
            `UPDATE clients SET email_status = 'bad'
              WHERE LOWER(email) = LOWER($1) AND email_status <> 'bad'`,
            [addr.trim()]
          );
        }
      }
    }

    // Mark webhook as processed
    await pool.query(
      `UPDATE email_webhook_events SET processed = true WHERE resend_id = $1 AND event_type = $2`,
      [resendId, type]
    );

    res.json({ received: true });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'resend', route: '/resend' },
      });
    }
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}));

module.exports = router;
