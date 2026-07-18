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

// POST /api/proposals/:id/send-group — DEPRECATED direct compare send, kept
// mounted for API compatibility. Delegates to the proposal_send_group comms
// action (plan P1): ensureSideEffects runs the exact groupSend transaction
// (FOR UPDATE lock, transition every draft option to 'sent', deferred invoicing,
// suppressed per-option comms) idempotently; dispatch then sends the single
// proposalOptionsSent compare email (email only), but only when something was
// newly sent — mirroring groupSend's dedupe. New UI goes through
// POST /api/comms/send.
router.post('/:id/send-group', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { getAction } = require('../../utils/comms/registry');
  const action = getAction('proposal_send_group');

  const sideEffects = await action.ensureSideEffects(id, { sentBy: req.user.id });
  if (!sideEffects.applied) {
    // Nothing newly sent (already sent / re-click): send no compare email, exactly
    // as groupSend only emailed when sentIds.length was non-zero.
    return res.json({ group_token: sideEffects.groupToken, sent_count: 0 });
  }
  const results = await action.dispatch(id, undefined, ['email'], { sentBy: req.user.id });
  res.json({
    group_token: sideEffects.groupToken,
    sent_count: sideEffects.sentCount,
    email: results.email,
    email_error: results.email_error || null,
    recipient_email: results.recipient_email || null,
  });
}));

module.exports = router;
