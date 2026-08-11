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
const { ADMIN_URL, PUBLIC_SITE_URL } = require('../utils/urls');
const { getSignedUrl } = require('../utils/storage');
const {
  computeOrderedMethods, readSideNormalize, deriveAvailableMethods,
} = require('../utils/tipMethods');

const router = express.Router();

const { UUID_RE } = require('../utils/tokens');

// Short-lived in-process cache for headshot signed URLs. The QR-scan path
// signs a fresh R2 URL on every GET (the JSON response is no-cache), so a
// busy venue re-signs the same staffer's headshot dozens of times a minute
// for no benefit. Cache the signed URL keyed on the R2 object basename; the
// TTL stays safely under the 15-min signed lifetime so a cached URL is never
// handed out already-expired. Bounded so it can't grow without limit.
const HEADSHOT_SIGN_TTL_MS = 12 * 60 * 1000;
const headshotUrlCache = new Map(); // basename -> { url, expiresAt }

async function getCachedHeadshotUrl(basename) {
  const now = Date.now();
  const hit = headshotUrlCache.get(basename);
  if (hit && hit.expiresAt > now) return hit.url;
  const url = await getSignedUrl(basename);
  if (headshotUrlCache.size > 1000) headshotUrlCache.clear();
  headshotUrlCache.set(basename, { url, expiresAt: now + HEADSHOT_SIGN_TTL_MS });
  return url;
}

// GET uses publicReadLimiter (100/15min). publicLimiter's 20/15min budget gets
// chewed through after ~7 customers at a venue NAT'd through one IP — and the
// QR is printed on a card so there's no recovery for the 21st scanner.
/** GET /api/public/tip/:token — fetch tip-page display data (public, token-gated) */
// Express hands `req.query.view` back as a string, an ARRAY (`?view=a&view=b`
// or `?view[]=a`), or an OBJECT (`?view[k]=a`), and it does not normalize case
// or trim. A bare `req.query.view === 'sign'` therefore falls through to the
// FULL handle-bearing payload for `?view=SIGN`, `?view=sign%20`, and every
// array/object form — failing OPEN on the projection whose entire job is to
// keep a bartender's Zelle phone off an unattended bar-top tablet. Normalize
// so anything that isn't unambiguously the string "sign" is simply not a
// projection request.
function requestedView(req) {
  const raw = Array.isArray(req.query.view) ? req.query.view[0] : req.query.view;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
}

router.get('/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) throw new NotFoundError('Tip page not found');

  // Public-safe column allowlist — do NOT expose payment_username, routing_number,
  // account_number, preferred_payment_method, internal IDs, or
  // stripe_payment_link_id. The response shape below is the complete allowed
  // set. `url` does embed tip_page_token, which is fine because the caller
  // supplied that token to reach this route; nothing else may.
  // ui_preferences->'tip_card_order' is projected as a single JSONB key (NOT
  // the whole ui_preferences blob — sibling keys like theme are not public).
  const { rows } = await pool.query(`
    SELECT
      COALESCE(cp.display_name, cp.preferred_name) AS display_name,
      cp.headshot_file_url AS headshot_url,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.zelle_handle,
      pp.stripe_payment_link_url,
      pp.tip_page_active,
      u.ui_preferences->'tip_card_order' AS tip_card_order
    FROM payment_profiles pp
    JOIN users u ON u.id = pp.user_id
    JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pp.tip_page_token = $1
  `, [token]);

  const row = rows[0];
  // 404 message is intentionally identical for both miss and deactivated cases
  // to prevent enumeration of valid-but-deactivated tokens.
  if (!row || !row.tip_page_active) throw new NotFoundError('Tip page not found');

  // Defense-in-depth read-side re-validation of paypal_url and zelle_handle,
  // plus availability and order, all in server/utils/tipMethods.js so that
  // /me/tip-page derives the identical method set (2026-08-11). Building
  // availability from the raw columns is the drift that util exists to remove.
  //
  // Computed BEFORE the headshot signing below so the sign projection can
  // return without paying for an R2 round trip it has no use for.
  const { paypalUrl, zelleHandle } = readSideNormalize(row, {
    route: 'publicTip.GET',
    tokenPrefix: token.slice(0, 8),
  });

  // Spec §6.8: server is the single source of truth for method order. The
  // staffer's saved tip_card_order controls display; methods present on the
  // profile but absent from the saved order fall to the natural-order end.
  // Inputs listed explicitly rather than spread from `row`: if a future edit
  // drops a column from the SELECT above, the util would silently read
  // undefined and quietly remove that method from the response. Naming them
  // here makes a missing column a visible hole at the call site, which is the
  // same drift class this whole extraction exists to prevent.
  const available = deriveAvailableMethods({
    stripe_payment_link_url: row.stripe_payment_link_url,
    venmo_handle: row.venmo_handle,
    cashapp_handle: row.cashapp_handle,
    paypalUrl,
    zelleHandle,
  });
  const methods = computeOrderedMethods(available, row.tip_card_order);

  // Display mode (spec 2026-08-10) renders a name, a QR, and payment marks,
  // and nothing else. Sending it the full chooser payload would put the
  // bartender's personal Zelle phone or email, and every other handle, on an
  // unattended bar-top tablet for the length of a shift. Deliberately BELOW
  // the tip_page_active guard: a deactivated page still 404s here.
  if (requestedView(req) === 'sign') {
    res.set('Cache-Control', 'private, no-cache');
    return res.json({
      display_name: row.display_name || 'your bartender',
      url: `${PUBLIC_SITE_URL}/tip/${encodeURIComponent(token)}`,
      methods,
    });
  }

  // Headshot is stored as `/files/<filename>` and the only file-serving route
  // (/api/files/:filename) is auth + admin/manager-only. Anonymous tip-page
  // visitors can't fetch that path, so generate a short-lived signed R2 URL
  // here. 15 min is plenty for a tip-page session; the page is normally a
  // tap-and-done flow within seconds of the QR scan.
  let headshotUrl = null;
  if (row.headshot_url) {
    if (row.headshot_url.startsWith('/files/')) {
      try {
        headshotUrl = await getCachedHeadshotUrl(path.basename(row.headshot_url));
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

  // The QR-scan path is the money flow. A CDN must NEVER serve a stale order
  // (e.g. after the staffer reorders or adds Zelle). private+no-cache forces
  // each scan to revalidate.
  res.set('Cache-Control', 'private, no-cache');
  res.json({
    display_name: row.display_name || 'your bartender',
    url: `${PUBLIC_SITE_URL}/tip/${token}`,
    headshot_url: headshotUrl,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: paypalUrl,
    stripe_payment_link_url: row.stripe_payment_link_url || null,
    zelle_handle: zelleHandle,
    methods,
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
    SELECT u.id AS user_id, COALESCE(cp.display_name, cp.preferred_name) AS display_name
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
