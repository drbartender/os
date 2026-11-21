// Admin routes for proposal option groups ("compare your options").
// Per-action sub-paths under /:id; mounted before crud.js (which owns the bare
// /:id verbs). Every route requires an authenticated admin/manager (explicit
// guard, not route-mount-implicit). The heavy lifting is in utils/proposalGroups.
const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError } = require('../../utils/errors');
const {
  addAlternative, removeAlternative, getGroupForProposal,
} = require('../../utils/proposalGroups');

const router = express.Router();

// Proposal ids are SERIAL integers; reject junk before it reaches SQL (a
// non-numeric :id would otherwise 22P02 -> 500 instead of a clean 404).
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('Proposal not found');
  return id;
}

// POST /api/proposals/:id/alternative — clone :id into a sibling option (creating
// the group if :id is not grouped yet). Returns the new option id + compare token.
router.post('/:id/alternative', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { groupToken, newProposalId } = await addAlternative(id, req.user.id);
  res.status(201).json({ group_token: groupToken, new_proposal_id: newProposalId });
}));

// DELETE /api/proposals/:id/group-membership — detach :id from its group;
// dissolves the group if a single option remains. Refuses on a decided group.
router.delete('/:id/group-membership', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { dissolved } = await removeAlternative(id, req.user.id);
  res.json({ dissolved });
}));

// GET /api/proposals/:id/group — group summary for the admin Alternatives panel.
// { grouped:false } when the proposal is solo.
router.get('/:id/group', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const summary = await getGroupForProposal(id);
  if (!summary) return res.json({ grouped: false });
  return res.json({ grouped: true, ...summary });
}));

module.exports = router;
