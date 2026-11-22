// GET /api/proposals/:id (single-proposal read). Carved out of crud.js at the
// file-size ratchet: crud.js sat at the 1000-line hard cap when the stated-budget
// join landed, and this route is the read path that grows. Mounted LAST in the
// proposals composition router (see index.js): `/:id` is greedy, so every static
// GET path (`/financials`, `/dashboard-stats`, `/packages`, ...) must win first.
const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { getProposalDetail } = require('../../utils/reads/proposalDetail');
const { gvPostStatusForProposal } = require('../../utils/gvPost/status');

const router = express.Router();

// A proposal id as the gv_posts read takes it: a positive integer that fits
// the column, or null.
function readProposalId(raw) {
  const id = Number(raw);
  return /^\d+$/.test(String(raw)) && Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

/**
 * GET /api/proposals/:id/gv-post — the proposal's latest GV post status
 * (spec 2026-10-17-tt-proposal-link-via-gv; plan Task 10), polled by the
 * proposal page's Thumbtack message row while a post is on its way. Returns
 * { gv_post }, null when the proposal has none (or does not exist). Registered
 * before the greedy GET /:id.
 */
router.get('/:id/gv-post', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = readProposalId(req.params.id);
  if (id === null) throw new ValidationError({ id: 'Invalid proposal id.' }, 'Invalid proposal id.');
  res.json({ gv_post: await gvPostStatusForProposal(id) });
}));

/** GET /api/proposals/:id — get single proposal. The read is shared with the
 *  Claude connector (server/utils/reads/proposalDetail.js); the detail page
 *  and its phone twin pass no hold exclusion and get that body, a held
 *  proposal included and marked legal_hold, plus gv_post: the proposal's
 *  latest GV post status (null without one). gv_post is read here, beside the
 *  shared read and never inside it: it carries the client's phone_last4 and
 *  only this screen shows it, so the connector neither loads it nor can fail
 *  on it. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = readProposalId(req.params.id);
  const [detail, gvPost] = await Promise.all([
    getProposalDetail(req.params.id),
    id === null ? null : gvPostStatusForProposal(id),
  ]);
  if (!detail) throw new NotFoundError('Proposal not found');
  res.json({ ...detail, gv_post: gvPost });
}));

module.exports = router;
