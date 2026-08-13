/**
 * The PUBLIC unsubscribe endpoint. No auth by design: the JWT in the
 * query string is the credential.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();
// ─── Public Unsubscribe ───────────────────────────────────────────

/** GET /unsubscribe — public unsubscribe endpoint */
router.get('/unsubscribe', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Invalid unsubscribe link.');

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }

  // DB errors propagate to asyncHandler → global error middleware (500 + Sentry).
  // The link carries one of two token shapes: a campaign-blast token ({leadId})
  // or a lifecycle marketing token ({clientId, marketing}) minted by
  // marketingHandlers.buildUnsubscribeUrl. Branch so both actually unsubscribe.
  if (decoded.clientId && decoded.marketing) {
    // Flip the client's marketing preference — the scheduled-message
    // dispatcher's marketing gate suppresses future marketing-class sends
    // when communication_preferences.marketing_enabled is false.
    await pool.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb),
             '{marketing_enabled}', 'false'::jsonb)
       WHERE id = $1`,
      [decoded.clientId]
    );
  } else if (decoded.leadId) {
    await pool.query(
      `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1`,
      [decoded.leadId]
    );
    await pool.query(
      `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
      [decoded.leadId]
    );
  } else {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }
  res.send(`
    <html><body style="font-family:Georgia,serif;text-align:center;padding:60px;">
      <h2>You've been unsubscribed</h2>
      <p>You will no longer receive marketing emails from Dr. Bartender.</p>
    </body></html>
  `);
}));

module.exports = router;
