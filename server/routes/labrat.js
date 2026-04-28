const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError, NotFoundError } = require('../utils/errors');
const catalog = require('../data/missions');
const { buildShortlist } = require('../utils/shortlist');
const { getCompletionCounts, logCompletion } = require('../utils/missionStats');
const { openBugCountByMission } = require('../utils/bugLog');
const { runSeedRecipe } = require('../utils/qaSeed');

const router = express.Router();
const VALID_AREAS = ['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge'];
const VALID_COMFORT = ['yes', 'walk', 'skip'];

router.get('/missions', publicLimiter, asyncHandler(async (req, res) => {
  res.json({ missions: catalog.all });
}));

router.get('/missions/:id', publicLimiter, asyncHandler(async (req, res) => {
  const m = catalog.byId[req.params.id];
  if (!m) throw new NotFoundError('Mission not found');
  res.json({ mission: m });
}));

router.post('/shortlist', publicLimiter, asyncHandler(async (req, res) => {
  const { areas, timeBudget, adminComfort, device, completedIds } = req.body || {};
  const errs = {};
  if (!Array.isArray(areas) || !areas.length || !areas.every(a => VALID_AREAS.includes(a))) {
    errs.areas = 'areas must be non-empty subset of valid areas';
  }
  if (!Number.isFinite(timeBudget) || timeBudget < 1 || timeBudget > 240) {
    errs.timeBudget = 'timeBudget must be 1-240 minutes';
  }
  if (adminComfort && !VALID_COMFORT.includes(adminComfort)) {
    errs.adminComfort = `adminComfort must be one of ${VALID_COMFORT.join(',')}`;
  }
  if (!['desktop', 'mobile'].includes(device)) errs.device = 'device must be desktop or mobile';
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid shortlist input');

  const [counts, openBugCounts] = await Promise.all([
    getCompletionCounts(),
    openBugCountByMission(),
  ]);
  const result = buildShortlist({
    missions: catalog.all,
    areas, timeBudget,
    adminComfort: adminComfort || 'skip',
    device,
    completedIds: Array.isArray(completedIds) ? completedIds : [],
    counts, openBugCounts,
  });
  res.json(result);
}));

router.post('/seed', publicLimiter, asyncHandler(async (req, res) => {
  const { recipe } = req.body || {};
  if (!recipe || typeof recipe !== 'string') {
    throw new ValidationError({ recipe: 'required' }, 'recipe required');
  }
  const result = await runSeedRecipe(recipe);
  res.json({ ok: true, ...result });
}));

router.post('/complete', publicLimiter, asyncHandler(async (req, res) => {
  const { missionId, testerName } = req.body || {};
  if (!missionId || !catalog.byId[missionId]) {
    throw new ValidationError({ missionId: 'unknown' }, 'Unknown mission');
  }
  await logCompletion(missionId, testerName || null);
  res.json({ ok: true });
}));

module.exports = router;
