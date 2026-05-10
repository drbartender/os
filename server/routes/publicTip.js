const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { ADMIN_URL } = require('../utils/urls');
const { getSignedUrl } = require('../utils/storage');
const { normalizePaypalUrl } = require('../utils/tipHandleValidation');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET uses publicReadLimiter (100/15min). publicLimiter's 20/15min budget gets
// chewed through after ~7 customers at a venue NAT'd through one IP — and the
// QR is printed on a card so there's no recovery for the 21st scanner.
/** GET /api/public/tip/:token — fetch tip-page display data (public, token-gated) */
router.get('/:token', publicReadLimiter, asyncHandler(async (req, res) => {
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

  // Headshot is stored as `/files/<filename>` and the only file-serving route
  // (/api/files/:filename) is auth + admin/manager-only. Anonymous tip-page
  // visitors can't fetch that path, so generate a short-lived signed R2 URL
  // here. 15 min is plenty for a tip-page session; the page is normally a
  // tap-and-done flow within seconds of the QR scan.
  let headshotUrl = null;
  if (row.headshot_url) {
    if (row.headshot_url.startsWith('/files/')) {
      try {
        headshotUrl = await getSignedUrl(path.basename(row.headshot_url));
      } catch (err) {
        // Fall through with null — TipPage shows a placeholder circle if missing.
        Sentry.captureException(err, {
          tags: { route: 'publicTip.GET', op: 'sign_headshot' },
          extra: { tokenPrefix: token.slice(0, 8) },
        });
      }
    } else {
      // Already an absolute URL (e.g. a public R2 path or imported asset) —
      // pass through unchanged. Currently no upload site does this, but the
      // shape is permitted by the column.
      headshotUrl = row.headshot_url;
    }
  }

  // Defense-in-depth: re-validate paypal_url on read. The write-time validator
  // (server/utils/tipHandleValidation.js) was added after some rows already
  // existed; pre-existing rows could hold non-paypal.me URLs, raw usernames in
  // unexpected shapes, or whitespace-padded values. If a stored value can't be
  // normalized to the canonical paypal.me form, drop it from the response —
  // the public tip page will simply not render a PayPal button. Sentry-warns
  // so admin can clean up the stored data via /me/tip-page or the admin tab.
  let paypalUrl = null;
  if (row.paypal_url) {
    try {
      paypalUrl = normalizePaypalUrl(row.paypal_url);
    } catch (err) {
      Sentry.captureMessage('Stored paypal_url failed read-side validation', {
        level: 'warning',
        tags: { route: 'publicTip.GET', op: 'paypal_url_validate' },
        extra: {
          tokenPrefix: token.slice(0, 8),
          reason: err && err.fieldErrors && err.fieldErrors.paypal_url,
        },
      });
    }
  }

  res.json({
    display_name: row.display_name || 'your bartender',
    headshot_url: headshotUrl,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: paypalUrl,
    stripe_payment_link_url: row.stripe_payment_link_url || null,
  });
}));

// Per-token+IP feedback limiter — pairs with the publicLimiter mounted on the
// feedback POST below. publicLimiter is the broad anti-abuse cap; this one
// prevents trolling a single bartender (max 3 submissions per hour per IP+token).
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 3,
  keyGenerator: req => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many feedback submissions, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** POST /api/public/tip/:token/feedback — submit 1-3★ feedback (public, token-gated) */
router.post('/:token/feedback', publicLimiter, feedbackLimiter, asyncHandler(async (req, res) => {
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
      adminUrl: `${ADMIN_URL}/tips#feedback`,
    });
    await sendEmail({
      to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
      subject: tpl.subject,
      html: tpl.html,
    });
  } catch (err) {
    console.error('[tip] feedback admin email failed', err.message);
    Sentry.captureException(err, {
      tags: { route: 'publicTip.feedback', op: 'admin_email' },
      extra: { tokenPrefix: token.slice(0, 8) },
    });
  }

  res.json({ ok: true });
}));

module.exports = router;
