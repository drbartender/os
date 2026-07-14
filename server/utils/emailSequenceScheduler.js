const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { wrapMarketingEmail } = require('./emailTemplates');
const { PUBLIC_SITE_URL, API_URL } = require('./urls');

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Optimistic per-step claim: advance an enrollment's current_step from `fromStep`
 * to `toStep`, but ONLY if current_step is still `fromStep`. Returns the affected
 * row count (1 = this worker claimed the step, 0 = a concurrent scheduler tick /
 * instance already advanced it, so the caller must skip to avoid a duplicate send).
 *
 * The advance is the claim: a scheduler tick reads current_step, then races this
 * predicate before it sends, so exactly one worker ever sends a given step. When
 * `nextDelay` is provided the same write sets next_step_due_at for the following
 * step; when it is null (no further step) next_step_due_at is cleared.
 *
 * Exported as a test seam so the concurrency test can race the real claim.
 */
async function claimSequenceStep(enrollmentId, fromStep, toStep, nextDelay) {
  if (nextDelay) {
    const r = await pool.query(
      `UPDATE email_sequence_enrollments SET
         current_step = $1, last_step_sent_at = NOW(),
         next_step_due_at = NOW() + MAKE_INTERVAL(days => $4, hours => $5)
       WHERE id = $2 AND current_step = $3
       RETURNING id`,
      [toStep, enrollmentId, fromStep, nextDelay.days, nextDelay.hours]
    );
    return r.rowCount;
  }
  const r = await pool.query(
    `UPDATE email_sequence_enrollments SET
       current_step = $1, last_step_sent_at = NOW(), next_step_due_at = NULL
     WHERE id = $2 AND current_step = $3
     RETURNING id`,
    [toStep, enrollmentId, fromStep]
  );
  return r.rowCount;
}

/**
 * Process sequence steps for active enrollments that are due.
 * Runs every 15 minutes via setInterval in server/index.js.
 */
async function processSequenceSteps() {
  try {
    // Find enrollments where next step is due (LEFT JOIN quote_drafts for resume URL support)
    //
    // NOTE: no archive guard on this scheduler because email_leads has no proposal_id
    // linkage. Drip stops on sign+pay via enrollment lifecycle (e.status flips when the
    // proposal is signed). Don't add an email-address fallback join — it over-suppresses
    // by matching unrelated archived proposals that happen to share the lead's email.
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

    // Unsubscribe is server-rendered by the Express backend — must hit API_URL,
    // not the Vercel SPA (which catches /api/* via rewrite and serves index.html).
    const unsubscribeBase = `${API_URL}/api/email-marketing/unsubscribe`;

    // Preload every step for the campaigns in this batch — one query per campaign
    // into a Map keyed by step_order — so the per-row loop resolves both the step
    // to send and the following step's delay from memory instead of issuing 2
    // sequential queries per enrollment.
    const campaignIds = [...new Set(dueEnrollments.rows.map((e) => e.campaign_id))];
    const stepsByCampaign = new Map();
    for (const campaignId of campaignIds) {
      const { rows: stepRows } = await pool.query(
        'SELECT * FROM email_sequence_steps WHERE campaign_id = $1',
        [campaignId]
      );
      const byOrder = new Map();
      for (const s of stepRows) byOrder.set(s.step_order, s);
      stepsByCampaign.set(campaignId, byOrder);
    }

    for (const enrollment of dueEnrollments.rows) {
      try {
        const nextStepOrder = enrollment.current_step + 1;
        const campaignSteps = stepsByCampaign.get(enrollment.campaign_id);

        // Get the step we are about to send (from the preloaded Map)
        const step = campaignSteps && campaignSteps.get(nextStepOrder);

        if (!step) {
          // No more steps — mark as completed. Guard on current_step so a
          // concurrent tick that already advanced this enrollment cannot
          // re-complete a row that has since moved on.
          await pool.query(
            `UPDATE email_sequence_enrollments SET status = 'completed', completed_at = NOW()
              WHERE id = $1 AND current_step = $2`,
            [enrollment.id, enrollment.current_step]
          );
          console.log(`[SequenceScheduler] Enrollment ${enrollment.id} completed (no more steps)`);
          continue;
        }

        // Look up the FOLLOWING step's delay (from the preloaded Map) so the claim
        // can set next_step_due_at in the same write it uses to advance current_step.
        const nextNextStep = campaignSteps.get(nextStepOrder + 1);
        const nextDelay = nextNextStep
          ? { days: nextNextStep.delay_days, hours: nextNextStep.delay_hours }
          : null;

        // ── Optimistic claim BEFORE the send (exactly-once under concurrent ticks) ──
        // Advance current_step from the value we read to nextStepOrder, conditional
        // on it being unchanged. A second scheduler tick / instance that read the
        // same current_step loses the predicate (rowCount 0) and skips, so the step
        // email is sent exactly once. The advance IS the claim. Trade-off: a send
        // that fails after the claim consumes the step (the catch records a 'failed'
        // email_sends row) — at-most-once, which we accept over the duplicate-send
        // risk the old advance-after-send ordering carried; the email_sends unique
        // index on (lead_id, sequence_step_id) backstops any duplicate row.
        const claimed = await claimSequenceStep(enrollment.id, enrollment.current_step, nextStepOrder, nextDelay);
        if (claimed === 0) {
          console.log(`[SequenceScheduler] Enrollment ${enrollment.id} step ${nextStepOrder} already claimed by a concurrent tick — skipping`);
          continue;
        }

        // Build unsubscribe URL — use UNSUBSCRIBE_SECRET if set, else JWT_SECRET fallback
        const unsubscribeToken = jwt.sign(
          { leadId: enrollment.lead_id },
          process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET,
          { expiresIn: '365d' }
        );
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
          meta: { skipLog: true }, // drip sequence step — never enters the client message log
        });

        // Record the send. The enrollment was already advanced by the claim above,
        // so the loop moves to the next due step on the following tick.
        await pool.query(
          `INSERT INTO email_sends (campaign_id, sequence_step_id, lead_id, resend_id, subject, status, sent_at)
           VALUES ($1, $2, $3, $4, $5, 'sent', NOW())`,
          [enrollment.campaign_id, step.id, enrollment.lead_id, emailResult.id, step.subject]
        );

        console.log(`[SequenceScheduler] Sent step ${nextStepOrder} to ${enrollment.email}`);

        // Rate limiting: 600ms between sends
        await new Promise(resolve => setTimeout(resolve, 600));
      } catch (stepErr) {
        console.error(`[SequenceScheduler] Error processing enrollment ${enrollment.id}:`, stepErr);

        // Record failed send — don't swallow the DB error silently.
        await pool.query(
          `INSERT INTO email_sends (campaign_id, lead_id, subject, status, error_message, sent_at)
           VALUES ($1, $2, 'Sequence step failed', 'failed', $3, NOW())`,
          [enrollment.campaign_id, enrollment.lead_id, stepErr.message]
        ).catch(logErr => Sentry.captureException(logErr, {
          tags: { scheduler: 'emailSequence', op: 'record-failed-send' },
          extra: { enrollmentId: enrollment.id, originalError: stepErr.message },
        }));
      }
    }
  } catch (err) {
    console.error('[SequenceScheduler] Fatal error:', err);
    throw err;  // surface to wrapScheduler so heartbeat records 'failed'
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
    throw err;  // surface to wrapScheduler so heartbeat records 'failed'
  }
}

module.exports = { processSequenceSteps, expireStaleQuoteDrafts, claimSequenceStep };
