const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { readAllBugs, setBugStatus, openBugCountByMission } = require('../../utils/bugLog');

const router = express.Router();
const VALID_STATUSES = ['open', 'fixed', 'wontfix'];

// List Lab Rat tester bugs, optionally filtered by status / mission.
router.get('/tester-bugs', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const status = req.query.status || 'open';
  const missionId = req.query.missionId || undefined;
  if (status !== 'all' && !VALID_STATUSES.includes(status)) {
    throw new ValidationError({ status: `must be one of all, ${VALID_STATUSES.join(', ')}` }, 'Invalid status filter');
  }
  const [bugs, openCounts] = await Promise.all([
    readAllBugs({ status, missionId }),
    openBugCountByMission(),
  ]);
  res.json({ bugs, openCountByMission: openCounts });
}));

// Update a single bug's triage state.
router.patch('/tester-bugs/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const patch = {};
  const errs = {};
  if (req.body.status !== undefined) {
    if (!VALID_STATUSES.includes(req.body.status)) {
      errs.status = `must be one of ${VALID_STATUSES.join(', ')}`;
    } else {
      patch.status = req.body.status;
    }
  }
  if (req.body.fixCommitSha !== undefined) {
    if (req.body.fixCommitSha !== null && typeof req.body.fixCommitSha !== 'string') {
      errs.fixCommitSha = 'must be a string';
    } else {
      patch.fixCommitSha = req.body.fixCommitSha;
    }
  }
  if (req.body.notes !== undefined) {
    if (req.body.notes !== null && typeof req.body.notes !== 'string') {
      errs.notes = 'must be a string';
    } else {
      patch.notes = req.body.notes;
    }
  }
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid bug update');
  const updated = await setBugStatus(id, patch);
  if (!updated) throw new NotFoundError('Bug not found');
  res.json({ bug: updated });
}));

module.exports = router;
