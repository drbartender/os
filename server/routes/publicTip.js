const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();
router.use(publicLimiter);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/public/tip/:token — fetch tip-page display data (public, token-gated) */
router.get('/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  // Public-safe column allowlist — do NOT expose payment_username, routing_number,
  // account_number, preferred_payment_method, internal IDs, stripe_payment_link_id,
  // or tip_page_token. The response shape below is the complete allowed set.
  const { rows } = await pool.query(`
    SELECT
      cp.preferred_name AS display_name,
      cp.headshot_file_url AS headshot_url,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.stripe_payment_link_url,
      pp.tip_page_active
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1
  `, [token]);

  const row = rows[0];
  // 404 message is intentionally identical for both miss and deactivated cases
  // to prevent enumeration of valid-but-deactivated tokens.
  if (!row || !row.tip_page_active) throw new NotFoundError('Tip page not found');

  res.json({
    display_name: row.display_name || 'your bartender',
    headshot_url: row.headshot_url || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    stripe_payment_link_url: row.stripe_payment_link_url || null,
  });
}));

// Per-token+IP feedback limiter sits ON TOP of the router-wide publicLimiter.
// publicLimiter is the broad anti-abuse cap; this one prevents trolling a single
// bartender (max 3 negative-feedback submissions per hour from one IP+token).
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 3,
  keyGenerator: req => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many feedback submissions, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** POST /api/public/tip/:token/feedback — submit 1-3★ feedback (public, token-gated) */
router.post('/:token/feedback', feedbackLimiter, asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  const { rating, comment, email } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 3) {
    throw new ValidationError('rating must be an integer 1-3');
  }
  if (comment !== undefined && comment !== null && (typeof comment !== 'string' || comment.length > 2000)) {
    throw new ValidationError('comment must be a string of 2000 chars or fewer');
  }
  if (email !== undefined && email !== null && (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new ValidationError('invalid email');
  }

  const { rows } = await pool.query(`
    SELECT u.id AS user_id, cp.preferred_name AS display_name
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1 AND pp.tip_page_active = TRUE
  `, [token]);

  const row = rows[0];
  // Same enumeration-prevention behavior as GET — 404 for both miss and deactivated.
  if (!row) throw new NotFoundError('Tip page not found');

  await pool.query(`
    INSERT INTO tip_page_feedback (target_user_id, rating, comment, submitter_email)
    VALUES ($1, $2, $3, $4)
  `, [row.user_id, rating, comment || null, email || null]);

  // Best-effort admin notification — never fail the user-facing request on email failure.
  try {
    const tpl = emailTemplates.tipFeedbackAdminNotification({
      displayName: row.display_name || 'a bartender',
      rating,
      comment,
      submitterEmail: email,
      adminUrl: `${ADMIN_URL}/admin/tips#feedback`,
    });
    await sendEmail({
      to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
      subject: tpl.subject,
      html: tpl.html,
    });
  } catch (err) {
    console.error('[tip] feedback admin email failed', err.message);
  }

  res.json({ ok: true });
}));

module.exports = router;
