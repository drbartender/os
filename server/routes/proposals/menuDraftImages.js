// The menu art image GETs (spec 2026-10-01 section 7; mounted by menuDrafts.js).
// Each sends one stored R2 object through sendR2Object (utils/r2Proxy.js),
// which runs assertKeyUnder on the prefix named here before anything is read:
//   GET /:id/menu-draft/pieces/:pieceKey/image   a done piece, under menu-art/<id>/
//   GET /:id/menu-draft/reference                the uploaded reference, under menu-art/<id>/ref-,
//                                                only while reference_source is upload (has_reference)
//   GET /:id/menu-draft/planner-image            the plan's client image, under drink-plan-logos/<planId>-
// The piece and planner routes take ?w=240 or ?w=480 (a sharp downscale, PNG
// keeping alpha); any other w is a 400, never ignored. The reference has no
// downscale, so any w there is a 400 too. No key leaves the server.

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { menuDraftReadLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { sendR2Object } = require('../../utils/r2Proxy');
const { loadEventPlan, plannerImageKeyOf } = require('../../utils/menuDrinkSource');
const { parseId, parsePieceKey, requireProposal } = require('./menuDraftShared');

const router = express.Router();
const guard = [auth, requireAdminOrManager, menuDraftReadLimiter];

// undefined means full size; the two strings mean a downscale; anything else
// (another number, a repeated w, a nested object) is refused.
function parseWidth(w) {
  if (w === undefined) return undefined;
  if (w === '240' || w === '480') return Number(w);
  throw new ValidationError({ w: 'Width must be 240 or 480.' });
}

router.get('/:id/menu-draft/pieces/:pieceKey/image', ...guard, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const pieceKey = parsePieceKey(req.params.pieceKey);
  const width = parseWidth(req.query.w);
  await requireProposal(id);
  const { rows } = await pool.query(
    `SELECT p.r2_key FROM menu_draft_pieces p JOIN menu_drafts d ON d.id = p.draft_id
      WHERE d.proposal_id = $1 AND p.piece_key = $2 AND p.status = 'done' AND p.r2_key IS NOT NULL`,
    [id, pieceKey]);
  if (!rows.length) throw new NotFoundError('That image is not ready.');
  await sendR2Object(res, rows[0].r2_key, { prefix: `menu-art/${id}/`, width });
}));

router.get('/:id/menu-draft/reference', ...guard, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (req.query.w !== undefined) throw new ValidationError({ w: 'The reference is sent at full size only.' });
  await requireProposal(id);
  const { rows } = await pool.query(
    `SELECT inputs->>'reference_key' AS key FROM menu_drafts
      WHERE proposal_id = $1 AND inputs->>'reference_source' = 'upload'`, [id]);
  const key = rows[0] ? rows[0].key : null;
  if (!key) throw new NotFoundError('This draft has no reference image.');
  await sendR2Object(res, key, { prefix: `menu-art/${id}/ref-` });
}));

// The event's plan is the lowest-id plan (loadEventPlan), and its key comes
// from plannerImageKeyOf, the rule Approve and the brief's rev read too.
router.get('/:id/menu-draft/planner-image', ...guard, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const width = parseWidth(req.query.w);
  await requireProposal(id);
  const plan = await loadEventPlan(id, pool);
  const key = plannerImageKeyOf(plan);
  if (!key) throw new NotFoundError('The drink plan has no client image.');
  await sendR2Object(res, key, { prefix: `drink-plan-logos/${plan.id}-`, width });
}));

module.exports = router;
