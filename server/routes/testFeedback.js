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

router.post('/', labratFeedbackLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { missionId, stepIndex, testerName, expected, browser } = body;
  let { kind, where, didWhat, happened } = body;

  // Back-compat shim for the legacy /testing-guide.html which posts the old
  // shape: { testerName, progressSummary, bugCount, reportText }.
  if (!kind && req.body && typeof req.body.reportText === 'string') {
    kind = 'bug';
    happened = req.body.reportText;
    didWhat = req.body.progressSummary || '';
    where = 'Legacy /testing-guide.html submission';
  }

  const errs = {};
  if (!ALLOWED_KINDS.includes(kind)) errs.kind = `must be one of ${ALLOWED_KINDS.join(', ')}`;
  if (kind === 'bug' && (!happened || !happened.trim())) errs.happened = 'Tell us what happened';
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid feedback');

  const { id } = await appendBug({
    kind, missionId: missionId || null, stepIndex,
    testerName, where, didWhat, happened, expected, browser,
  });

  // Best-effort admin email — fire-and-forget so we don't block the tester's
  // "Sent ✓" toast on Resend's 200-1000ms round-trip. Bug is already in
  // tester_bugs; the email is a notification redundancy.
  const tpl = labratBugReportAdmin({
    bugId: id, kind, missionId: missionId || null, stepIndex,
    testerName, where, didWhat, happened, expected,
    browser, reportedAt: new Date().toISOString(),
  });
  sendEmail({
    to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
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
