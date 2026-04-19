const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { wrapMarketingEmail } = require('./emailTemplates');
const { PUBLIC_SITE_URL } = require('./urls');

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Process sequence steps for active enrollments that are due.
 * Runs every 15 minutes via setInterval in server/index.js.
 */
async function processSequenceSteps() {
  try {
    // Find enrollments where next step is due (LEFT JOIN quote_drafts for resume URL support)
    const dueEnrollments = await pool.query(`
      SELECT e.id, e.campaign_id, e.lead_id, e.current_step,
             l.email, l.name, l.status AS lead_status,
             c.status AS campaign_status, c.from_email, c.reply_to,
             qd.token AS quote_draft_token
      FROM email_sequence_enrollments e
      JOIN email_leads l ON l.id = e.lead_id
      JOIN email_campaigns c ON c.id = e.campaign_id
      LEFT JOIN quote_drafts qd ON qd.lead_id = l.id AND qd.status = 'draft'
      WHERE e.status = 'active'
        AND e.next_step_due_at <= NOW()
        AND l.status = 'active'
        AND c.status = 'active'
    `);

    if (dueEnrollments.rows.length === 0) return;

    console.log(`[SequenceScheduler] Processing ${dueEnrollments.rows.length} due enrollment(s)`);

    const unsubscribeBase = `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/email-marketing/unsubscribe`;

    for (const enrollment of dueEnrollments.rows) {
      try {
        const nextStepOrder = enrollment.current_step + 1;

        // Get the next step
        const stepResult = await pool.query(
          'SELECT * FROM email_sequence_steps WHERE campaign_id = $1 AND step_order = $2',
          [enrollment.campaign_id, nextStepOrder]
        );

        if (!stepResult.rows[0]) {
          // No more steps — mark as completed
          await pool.query(
            `UPDATE email_sequence_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [enrollment.id]
          );
          console.log(`[SequenceScheduler] Enrollment ${enrollment.id} completed (no more steps)`);
          continue;
        }

        const step = stepResult.rows[0];

        // Build unsubscribe URL
        const unsubscribeToken = jwt.sign({ leadId: enrollment.lead_id }, process.env.JWT_SECRET, { expiresIn: '365d' });
        const unsubscribeUrl = `${unsubscribeBase}?token=${unsubscribeToken}`;

        // Replace template variables ({{name}}, {{resume_url}}) in both HTML and plaintext
        const resumeUrl = enrollment.quote_draft_token
          ? `${PUBLIC_SITE_URL}/quote?resume=${enrollment.quote_draft_token}`
          : `${PUBLIC_SITE_URL}/quote`;
        let htmlBody = step.html_body;
        htmlBody = htmlBody.replace(/\{\{name\}\}/g, escapeHtml(enrollment.name) || 'there');
        htmlBody = htmlBody.replace(/\{\{resume_url\}\}/g, resumeUrl);

        let textBody = step.text_body || '';
        textBody = textBody.replace(/\{\{name\}\}/g, enrollment.name || 'there');
        textBody = textBody.replace(/\{\{resume_url\}\}/g, resumeUrl);

        const html = wrapMarketingEmail(htmlBody, unsubscribeUrl);

        // Send the email
        const emailResult = await sendEmail({
          to: enrollment.email,
          subject: step.subject,
          html,
          text: textBody || undefined,
          from: enrollment.from_email || undefined,
          replyTo: enrollment.reply_to || undefined,
        });

        // Record the send
        await pool.query(
          `INSERT INTO email_sends (campaign_id, sequence_step_id, lead_id, resend_id, subject, status, sent_at)
           VALUES ($1, $2, $3, $4, $5, 'sent', NOW())`,
          [enrollment.campaign_id, step.id, enrollment.lead_id, emailResult.id, step.subject]
        );

        // Calculate next step due time
        const nextNextStep = await pool.query(
          'SELECT delay_days, delay_hours FROM email_sequence_steps WHERE campaign_id = $1 AND step_order = $2',
          [enrollment.campaign_id, nextStepOrder + 1]
        );

        // Update enrollment progress
        if (nextNextStep.rows[0]) {
          const { delay_days, delay_hours } = nextNextStep.rows[0];
          await pool.query(
            `UPDATE email_sequence_enrollments SET
              current_step = $1, last_step_sent_at = NOW(),
              next_step_due_at = NOW() + MAKE_INTERVAL(days => $3, hours => $4)
            WHERE id = $2`,
            [nextStepOrder, enrollment.id, delay_days, delay_hours]
          );
        } else {
          await pool.query(
            `UPDATE email_sequence_enrollments SET
              current_step = $1, last_step_sent_at = NOW(), next_step_due_at = NULL
            WHERE id = $2`,
            [nextStepOrder, enrollment.id]
          );
        }

        console.log(`[SequenceScheduler] Sent step ${nextStepOrder} to ${enrollment.email}`);

        // Rate limiting: 600ms between sends
        await new Promise(resolve => setTimeout(resolve, 600));
      } catch (stepErr) {
        console.error(`[SequenceScheduler] Error processing enrollment ${enrollment.id}:`, stepErr);

        // Record failed send
        await pool.query(
          `INSERT INTO email_sends (campaign_id, lead_id, subject, status, error_message, sent_at)
           VALUES ($1, $2, 'Sequence step failed', 'failed', $3, NOW())`,
          [enrollment.campaign_id, enrollment.lead_id, stepErr.message]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SequenceScheduler] Fatal error:', err);
  }
}

/**
 * Expire stale quote wizard drafts older than 30 days.
 * Runs alongside processSequenceSteps.
 */
async function expireStaleQuoteDrafts() {
  try {
    const result = await pool.query(
      `UPDATE quote_drafts SET status = 'expired'
       WHERE status = 'draft' AND updated_at < NOW() - INTERVAL '30 days'`
    );
    if (result.rowCount > 0) {
      console.log(`[QuoteDrafts] Expired ${result.rowCount} stale draft(s)`);
    }
  } catch (err) {
    console.error('[QuoteDrafts] Cleanup error:', err.message);
  }
}

module.exports = { processSequenceSteps, expireStaleQuoteDrafts };
