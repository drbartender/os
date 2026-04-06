const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/**
 * POST /api/email-marketing/webhook/resend
 * Receives Resend webhook events for email tracking.
 * Verifies signature via svix headers if RESEND_WEBHOOK_SECRET is set.
 */
router.post('/resend', async (req, res) => {
  try {
    // Verify webhook signature if secret is configured
    if (process.env.RESEND_WEBHOOK_SECRET) {
      const { Webhook } = require('svix');
      const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
      try {
        wh.verify(JSON.stringify(req.body), {
          'svix-id': req.headers['svix-id'],
          'svix-timestamp': req.headers['svix-timestamp'],
          'svix-signature': req.headers['svix-signature'],
        });
      } catch (verifyErr) {
        console.error('Webhook signature verification failed:', verifyErr.message);
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { type, data } = req.body;
    const resendId = data?.email_id;

    if (!type || !resendId) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Log raw event
    await pool.query(
      `INSERT INTO email_webhook_events (resend_id, event_type, payload) VALUES ($1, $2, $3)`,
      [resendId, type, JSON.stringify(req.body)]
    );

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
    const timestampCol = {
      'opened': 'opened_at',
      'clicked': 'clicked_at',
      'bounced': 'bounced_at',
      'complained': 'complained_at',
    }[newStatus];

    if (timestampCol) {
      await pool.query(
        `UPDATE email_sends SET status = $1, ${timestampCol} = NOW() WHERE resend_id = $2`,
        [newStatus, resendId]
      );
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
    }

    // Mark webhook as processed
    await pool.query(
      `UPDATE email_webhook_events SET processed = true WHERE resend_id = $1 AND event_type = $2`,
      [resendId, type]
    );

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
