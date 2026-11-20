// GET /api/proposals/:id (single-proposal read). Carved out of crud.js at the
// file-size ratchet: crud.js sat at the 1000-line hard cap when the stated-budget
// join landed, and this route is the read path that grows. Mounted LAST in the
// proposals composition router (see index.js): `/:id` is greedy, so every static
// GET path (`/financials`, `/dashboard-stats`, `/packages`, ...) must win first.
const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError } = require('../../utils/errors');
const { getProposalDetail } = require('../../utils/reads/proposalDetail');

const router = express.Router();

/** GET /api/proposals/:id — get single proposal. The read is shared with the
 *  Claude connector (server/utils/reads/proposalDetail.js); the detail page
 *  and its phone twin pass no hold exclusion and get the body they always
 *  did, a held proposal included and marked legal_hold. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const detail = await getProposalDetail(req.params.id);
  if (!detail) throw new NotFoundError('Proposal not found');
  res.json(detail);
}));

module.exports = router;
