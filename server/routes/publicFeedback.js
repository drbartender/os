const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { NotFoundError, ValidationError, ConflictError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const marketingTemplates = require('../utils/marketingEmailTemplates');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();

const { UUID_RE } = require('../utils/tokens');

// Per-token+IP submission limiter to deter trolling a single proposal.
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many feedback submissions, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helpers exported for unit tests ──

function isFeedbackTokenShape(token) {
  return typeof token === 'string' && UUID_RE.test(token);
}

/**
 * Validate the POST body. Returns `{rating, comment}` (comment normalized to null).
 * Throws a ValidationError when input is malformed.
 */
function validateFeedbackInput({ rating, comment } = {}) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ValidationError(
      { rating: 'Rating must be an integer 1-5' },
      'Rating must be an integer 1-5'
    );
  }
  let normalizedComment = null;
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') {
      throw new ValidationError(
        { comment: 'Comment must be a string' },
        'Comment must be a string'
      );
    }
    if (comment.length > 2000) {
      throw new ValidationError(
        { comment: 'Comment must be 2000 characters or fewer' },
        'Comment must be 2000 characters or fewer'
      );
    }
    normalizedComment = comment;
  }
  return { rating, comment: normalizedComment };
}

/**
 * Load the display payload for the feedback page given a token. Returns the
 * payload object, or `null` when the proposal is missing/archived so the GET
 * handler can render a NotFoundError.
 */
async function loadFeedbackContext(token) {
  if (!isFeedbackTokenShape(token)) return null;
  const { rows } = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.event_date,
           c.name AS client_name,
           EXISTS (SELECT 1 FROM post_event_feedback f WHERE f.proposal_id = p.id) AS already_submitted
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [token]);
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'archived') return null;
  const clientFirstName = (row.client_name || '').trim().split(/\s+/)[0] || 'there';
  return {
    client_first_name: clientFirstName,
    event_type_label: getEventTypeLabel({
      event_type: row.event_type,
      event_type_custom: row.event_type_custom,
    }),
    event_date: row.event_date,
    already_submitted: row.already_submitted,
  };
}

/**
 * Insert the feedback row + sentiment routing. Returns
 * `{routing: 'redirect'|'thanks', redirect_url?}`. Caller (route handler) is
 * responsible for posting any admin email; this helper stays free of email
 * I/O so unit tests don't have to mock it. Throws NotFoundError / ConflictError
 * on flow violations.
 */
async function recordFeedback({ token, rating, comment, ip, userAgent }) {
  if (!isFeedbackTokenShape(token)) throw new NotFoundError('Feedback page not found');
  const { rows } = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.event_date,
           c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [token]);
  const proposal = rows[0];
  if (!proposal) throw new NotFoundError('Feedback page not found');
  if (proposal.status === 'archived') throw new NotFoundError('Feedback page not found');

  try {
    await pool.query(
      `INSERT INTO post_event_feedback (proposal_id, rating, comment, submitter_ip, submitter_user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [proposal.id, rating, comment, ip || null, (userAgent || '').slice(0, 500)]
    );
  } catch (err) {
    if (err.code === '23505') {
      throw new ConflictError('Feedback already received for this event.', 'FEEDBACK_ALREADY_SUBMITTED');
    }
    throw err;
  }

  if (rating >= 4) {
    const redirectUrl = process.env.PUBLIC_GOOGLE_REVIEW_URL || 'https://google.com';
    return { routing: 'redirect', redirect_url: redirectUrl, proposal };
  }
  return { routing: 'thanks', proposal };
}

/**
 * POST handler logic factored out for direct unit testing (Gemini Finding 6).
 * Pure-ish: returns `{ status, body }` instead of mutating `res`. Email I/O is
 * injected via `ctx.sendEmail` so tests can count calls without hitting Resend.
 *
 * ctx = {
 *   token: string,
 *   body: { rating, comment },
 *   ip: string | null,
 *   userAgent: string | null,
 *   sendEmail: (msg) => Promise<unknown>,
 *   now: () => Date, // injectable clock — currently unused but kept for future TZ-sensitive logic
 * }
 *
 * Caller (Express route handler) is responsible for mapping `req`/`res`.
 */
async function handleFeedbackSubmission(ctx) {
  // 1. Validate
  let rating;
  let comment;
  try {
    ({ rating, comment } = validateFeedbackInput(ctx.body || {}));
  } catch (err) {
    if (err instanceof ValidationError) {
      return { status: 400, body: { error: err.message, code: err.code, fields: err.fieldErrors } };
    }
    throw err;
  }

  // 2. Record (insert + sentiment routing)
  let result;
  try {
    result = await recordFeedback({
      token: ctx.token,
      rating,
      comment,
      ip: ctx.ip,
      userAgent: ctx.userAgent || '',
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { status: 404, body: { error: err.message, code: err.code } };
    }
    if (err instanceof ConflictError) {
      return { status: 409, body: { error: err.message, code: 'FEEDBACK_ALREADY_SUBMITTED' } };
    }
    throw err;
  }

  // 3a. High rating: route to Google Review — no admin email.
  if (result.routing === 'redirect') {
    return { status: 200, body: { ok: true, redirect_url: result.redirect_url } };
  }

  // 3b. Low rating (1-3): best-effort admin notification, never fail the request.
  try {
    const tpl = marketingTemplates.lowRatingAdminNotification({
      clientName: result.proposal.client_name || 'A client',
      eventDateDisplay: result.proposal.event_date
        ? new Date(result.proposal.event_date).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          })
        : '',
      eventTypeLabel: getEventTypeLabel({
        event_type: result.proposal.event_type,
        event_type_custom: result.proposal.event_type_custom,
      }),
      rating,
      comment: comment || null,
      adminUrl: `${ADMIN_URL}/proposals/${result.proposal.id}`,
    });
    await ctx.sendEmail({
      to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
      subject: tpl.subject,
      html: tpl.html,
    });
  } catch (err) {
    console.error('[publicFeedback] admin email failed:', err.message);
    Sentry.captureException(err, {
      tags: { route: 'publicFeedback.POST', op: 'admin_email' },
      extra: { proposalId: result.proposal.id, rating },
    });
  }

  return { status: 200, body: { ok: true, thanks: true } };
}

// ── Routes ──

/** GET /api/public/feedback/:token — fetch display data for the feedback page */
router.get('/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  const ctx = await loadFeedbackContext(req.params.token);
  if (!ctx) throw new NotFoundError('Feedback page not found');
  res.json(ctx);
}));

/** POST /api/public/feedback/:token — submit a rating */
router.post('/:token', publicLimiter, submissionLimiter, asyncHandler(async (req, res) => {
  const result = await handleFeedbackSubmission({
    token: req.params.token,
    body: req.body || {},
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
    sendEmail,
    now: () => new Date(),
  });
  res.status(result.status).json(result.body);
}));

module.exports = router;
module.exports.isFeedbackTokenShape = isFeedbackTokenShape;
module.exports.validateFeedbackInput = validateFeedbackInput;
module.exports.loadFeedbackContext = loadFeedbackContext;
module.exports.recordFeedback = recordFeedback;
module.exports.handleFeedbackSubmission = handleFeedbackSubmission;
