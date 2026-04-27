// server/routes/testFeedback.js
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');
const { appendBug } = require('../utils/bugLog');

const router = express.Router();
const ALLOWED_KINDS = ['bug', 'confusion', 'mission-stale'];

router.post('/', publicLimiter, asyncHandler(async (req, res) => {
  const { kind, missionId, stepIndex, testerName, testerEmail,
          where, didWhat, happened, expected, browser, screenshotUrl } = req.body || {};

  const errs = {};
  if (!ALLOWED_KINDS.includes(kind)) errs.kind = `must be one of ${ALLOWED_KINDS.join(', ')}`;
  if (kind === 'bug' && (!happened || !happened.trim())) errs.happened = 'Tell us what happened';
  if (testerEmail && typeof testerEmail === 'string' && testerEmail.trim()) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testerEmail.trim())) {
      errs.testerEmail = 'Invalid email format';
    }
  }
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid feedback');

  const { id } = await appendBug({
    kind, missionId: missionId || null, stepIndex,
    testerName, testerEmail, where, didWhat, happened, expected, browser, screenshotUrl,
  });
  res.json({ ok: true, id });
}));

module.exports = router;
