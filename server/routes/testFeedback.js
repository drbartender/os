const express = require('express');
const { sendEmail } = require('../utils/email');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

const FEEDBACK_RECIPIENT = 'contact@drbartender.com';
const MAX_REPORT_CHARS = 200000;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post('/', publicLimiter, asyncHandler(async (req, res) => {
  const { testerName, testerEmail, progressSummary, bugCount, reportText } = req.body || {};

  const fieldErrors = {};
  if (!testerName || typeof testerName !== 'string' || !testerName.trim()) {
    fieldErrors.testerName = 'Please enter your name';
  }
  if (!reportText || typeof reportText !== 'string' || !reportText.trim()) {
    fieldErrors.reportText = 'Report is empty';
  } else if (reportText.length > MAX_REPORT_CHARS) {
    fieldErrors.reportText = 'Report is too large to send';
  }
  if (testerEmail && typeof testerEmail === 'string' && testerEmail.trim()) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testerEmail.trim())) {
      fieldErrors.testerEmail = 'Invalid email format';
    }
  }
  if (Object.keys(fieldErrors).length) {
    throw new ValidationError('Invalid feedback submission', fieldErrors);
  }

  const nameClean = testerName.trim().slice(0, 120);
  const emailClean = testerEmail && testerEmail.trim() ? testerEmail.trim().slice(0, 200) : '';
  const bugs = Number.isFinite(bugCount) ? bugCount : 0;
  const progress = typeof progressSummary === 'string' ? progressSummary.slice(0, 200) : '';

  const subject = `[Testing Feedback] ${nameClean} — ${bugs} bug${bugs === 1 ? '' : 's'}`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #222;">
      <h2 style="margin:0 0 12px;">Testing feedback submitted</h2>
      <p style="margin:0 0 4px;"><strong>Tester:</strong> ${escapeHtml(nameClean)}</p>
      ${emailClean ? `<p style="margin:0 0 4px;"><strong>Email:</strong> ${escapeHtml(emailClean)}</p>` : ''}
      ${progress ? `<p style="margin:0 0 4px;"><strong>Progress:</strong> ${escapeHtml(progress)}</p>` : ''}
      <p style="margin:0 0 16px;"><strong>Bugs reported:</strong> ${bugs}</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
      <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;background:#f7f7f7;padding:12px;border-radius:6px;">${escapeHtml(reportText)}</pre>
    </div>
  `;

  await sendEmail({
    to: FEEDBACK_RECIPIENT,
    subject,
    html,
    text: `Tester: ${nameClean}\n${emailClean ? `Email: ${emailClean}\n` : ''}${progress ? `Progress: ${progress}\n` : ''}Bugs: ${bugs}\n\n${reportText}`,
    replyTo: emailClean || undefined,
  });

  res.json({ ok: true });
}));

module.exports = router;
