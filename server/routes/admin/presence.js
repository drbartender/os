// Presence tracker endpoints (spec: API section). Strip reads/mutations are
// admin+manager; the interval history is a timesheet, so it is admin-only.
// Mutations only ever write the caller's own row (IDOR-safe by construction).
const express = require('express');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');
const { PRESENCE_STATES } = require('../../utils/presence');
const store = require('../../utils/presenceStore');
const { notifyDibsEdge } = require('../../utils/presenceNotify');

const router = express.Router();

function requireTracked(req) {
  if (req.user.presence_lead_rank === null || req.user.presence_lead_rank === undefined) {
    throw new ValidationError(null, 'Not a presence-tracked user');
  }
}

// Presence strip payload: tracked users' states + derived lead-responder pointer (also embedded in
// `/badge-counts` as `presence`, non-fatal).
router.get('/presence', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await store.getStripPayload());
}));

// Set own presence state (desk/available/away); applies the taking-leads transition rules (away
// wipes; re-entry resets on for chain users, OFF for the fallback owner).
router.post('/presence/state', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { state } = req.body || {};
  if (!PRESENCE_STATES.includes(state)) {
    throw new ValidationError(null, 'state must be one of desk, available, away');
  }
  // Failure-isolated pre-capture for the dibs-edge ping; never blocks the mutation.
  const before = await store.getStripPayload().catch(() => null);
  await store.transitionState(req.user.id, state);
  const payload = await store.getStripPayload();
  notifyDibsEdge({ actorId: req.user.id, before, after: payload }).catch(() => {});
  res.json(payload);
}));

// Set own taking-leads toggle; rejected while away. The fallback owner's toggle is dibs: it
// overrides the chain, and both edges fire the dibs ping (`presenceNotify.js`).
router.post('/presence/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { taking } = req.body || {};
  if (typeof taking !== 'boolean') throw new ValidationError(null, 'taking must be a boolean');
  const before = await store.getStripPayload().catch(() => null);
  await store.setTakingLeads(req.user.id, taking);
  const payload = await store.getStripPayload();
  notifyDibsEdge({ actorId: req.user.id, before, after: payload }).catch(() => {});
  res.json(payload);
}));

// Time-clock history: per-user this-week/this-month desk+available totals (Central time,
// boundary-split) + the 50 most recent intervals.
router.get('/presence/log', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json(await store.getLogSummary());
}));

module.exports = router;
