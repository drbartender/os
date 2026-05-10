// server/routes/testFeedback.js
const express = require('express');
const Sentry = require('@sentry/node');
const asyncHandler = require('../middleware/asyncHandler');
const { labratFeedbackLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');
const { appendBug } = require('../utils/bugLog');
const { sendEmail } = require('../utils/email');
const { labratBugReportAdmin } = require('../utils/emailTemplates');

const router = express.Router();
const ALLOWED_KINDS = ['bug', 'confusion', 'mission-stale'];

// Reject SMTP-header-significant characters in addition to the standard regex.
// `\s` covers CR/LF/tab/space; explicit `<>"'\,;` blocks angle-bracket and
// multi-recipient injection vectors when forwarded into Resend's `reply_to`.
const EMAIL_RE = /^[^\s@<>"'\\,;]+@[^\s@<>"'\\,;]+\.[^\s@<>"'\\,;]+$/;

router.post('/', labratFeedbackLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { missionId, stepIndex, testerName, testerEmail, expected, browser, screenshotUrl } = body;
  let { kind, where, didWhat, happened } = body;

  // Back-compat shim for the legacy /testing-guide.html which posts the old
  // shape: { testerName, testerEmail, progressSummary, bugCount, reportText }.
  // Keep this until the legacy guide is removed.
  if (!kind && req.body && typeof req.body.reportText === 'string') {
    kind = 'bug';
    happened = req.body.reportText;
    didWhat = req.body.progressSummary || '';
    where = 'Legacy /testing-guide.html submission';
  }

  const errs = {};
  if (!ALLOWED_KINDS.includes(kind)) errs.kind = `must be one of ${ALLOWED_KINDS.join(', ')}`;
  if (kind === 'bug' && (!happened || !happened.trim())) errs.happened = 'Tell us what happened';
  let safeReplyTo;
  if (testerEmail && typeof testerEmail === 'string' && testerEmail.trim()) {
    const trimmed = testerEmail.trim();
    if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
      errs.testerEmail = 'Invalid email format';
    } else {
      safeReplyTo = trimmed;
    }
  }
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid feedback');

  const { id } = await appendBug({
    kind, missionId: missionId || null, stepIndex,
    testerName, testerEmail, where, didWhat, happened, expected, browser, screenshotUrl,
  });

  // Best-effort admin email — fire-and-forget so we don't block the tester's
  // "Sent ✓" toast on Resend's 200-1000ms round-trip. Bug is already in
  // bugLog; the email is the durable copy that survives Render deploys.
  const tpl = labratBugReportAdmin({
    bugId: id, kind, missionId: missionId || null, stepIndex,
    testerName, testerEmail, where, didWhat, happened, expected,
    browser, screenshotUrl, reportedAt: new Date().toISOString(),
  });
  sendEmail({
    to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    replyTo: safeReplyTo,
  }).catch((err) => {
    console.error('[labrat] bug-report admin email failed', err.message);
    Sentry.captureException(err, {
      tags: { route: 'testFeedback.post', op: 'admin_email' },
      extra: { bugId: id, kind, missionId: missionId || null },
    });
  });

  res.json({ ok: true, id });
}));

module.exports = router;
