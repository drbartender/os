// Presence tracker endpoints (spec: API section). Strip reads/mutations are
// admin+manager; the interval history is a timesheet, so it is admin-only.
// Mutations only ever write the caller's own row (IDOR-safe by construction).
const express = require('express');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');
const { PRESENCE_STATES } = require('../../utils/presence');
const store = require('../../utils/presenceStore');

const router = express.Router();

function requireTracked(req) {
  if (req.user.presence_lead_rank === null || req.user.presence_lead_rank === undefined) {
    throw new ValidationError(null, 'Not a presence-tracked user');
  }
}

router.get('/presence', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await store.getStripPayload());
}));

router.post('/presence/state', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { state } = req.body || {};
  if (!PRESENCE_STATES.includes(state)) {
    throw new ValidationError(null, 'state must be one of desk, available, away');
  }
  await store.transitionState(req.user.id, state);
  res.json(await store.getStripPayload());
}));

router.post('/presence/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { taking } = req.body || {};
  if (typeof taking !== 'boolean') throw new ValidationError(null, 'taking must be a boolean');
  await store.setTakingLeads(req.user.id, taking);
  res.json(await store.getStripPayload());
}));

router.get('/presence/log', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json(await store.getLogSummary());
}));

module.exports = router;
