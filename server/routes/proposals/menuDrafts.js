// Menu art drafts, admin and manager (spec 2026-10-01 sections 5.5, 7, 7.1 and
// 9; decision 9). Every route: auth, requireAdminOrManager, asyncHandler, an
// integer :id (400 otherwise) and a 404 when the proposal does not exist.
//
//   GET    /:id/menu-draft                            the read model (menuDraftRead.js)
//   POST   /:id/menu-draft/generate                   Start over: a new run, 202
//   PATCH  /:id/menu-draft                            an edit under the version check
//   POST   /:id/menu-draft/pieces/:pieceKey/reroll    one piece, 202 (409 until the words land, 422 with no plan)
//   POST   /:id/menu-draft/dismiss-plan-change        hide the plan-changed banner
//   POST   /:id/menu-draft/sync                       Update draft (menuDraftSync.js)
//   GET    the piece, reference and planner image     (menuDraftImages.js)
// Approve is Lane 3's (menuDraftApprove.js).
//
// Money: Generate, re-roll and sync reserve paid image and words calls against
// the daily caps (menuArtCap.js). Each does it in ONE transaction opened by
// inLockedTx (menuDraftShared.js): lockCalls first, then the draft row, then
// piece rows, and a 40P01 anywhere answers 409 MENU_DRAFT_CHANGED. Any R2
// upload runs before that transaction opens; the job is queued only after it
// commits and its client is released. Those three answer 503
// MENU_ART_NOT_CONFIGURED without OPENAI_API_KEY before any work, and 503
// MENU_ART_GEMINI_NOT_CONFIGURED for image_model gemini without its key. The
// GET, PATCH, dismiss and the image GETs work with neither key.
//
// Generate releases every reserved row of the proposal (the old run's, and any
// re-roll or sync row stranded by a restart) BEFORE it reserves its own, and
// upserts the draft in place (version, art_version and the approved_* stamps
// survive; the bumped version reads as edited since approval). Its pieces are
// the background plus the first 8 drinks in plan order, each stamped with the
// posted image_model and that provider's model id from env.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter, menuDraftReadLimiter, menuDraftEditLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, ValidationError, NotFoundError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload, safeUploadExtension } = require('../../utils/fileValidation');
const {
  reserveImages, reserveText, releaseReserved, releaseProposalReserved, releasePieceReserved,
} = require('../../utils/menuArtCap');
const job = require('../../utils/menuArtJob');
const { readDraftPayload, stuck } = require('../../utils/menuDraftRead');
const {
  validateGenerateInputs, validatePatch, validateRerollNote, validateImageModel, LIMITS,
} = require('../../utils/menuDraftValidation');
const { loadEventPlan, buildFingerprint, fingerprintHash } = require('../../utils/menuDrinkSource');
const {
  LIST_CAP, isObject, capList, parseId, parseVersion, parsePieceKey, requireProposal, noDraft, draftChanged, noPlan,
  requireWords, upsertPendingPieces, requireOpenAI, requireImageModel, imageModelId, inLockedTx, queue,
} = require('./menuDraftShared');

const router = express.Router();

const REFERENCE_EXTS = new Set(['.jpg', '.png', '.webp']);
const OPEN = new Set(['pending', 'working']);
// Spec 6 has under twenty content keys and five inputs keys.
const PATCH_KEYS_MAX = 40;
const noDrinks = () => new AppError('The drink plan has no drinks to put on a menu.', 422, 'MENU_NO_DRINKS');

const UPSERT_DRAFT_SQL = `
  INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint)
  VALUES ($1, $2, $3::uuid, $4::jsonb,
          jsonb_build_object('words_status', 'pending', 'words_heartbeat_at', NOW()), $5::jsonb)
  ON CONFLICT (proposal_id) DO UPDATE
     SET drink_plan_id = EXCLUDED.drink_plan_id, run_id = EXCLUDED.run_id, inputs = EXCLUDED.inputs,
         content = EXCLUDED.content, plan_fingerprint = EXCLUDED.plan_fingerprint,
         dismissed_plan_hash = NULL, version = menu_drafts.version + 1
  RETURNING id, version`;

// The attached reference, checked by its bytes (spec 7, Upload checks), or null.
function referenceFile(files) {
  const file = files && files.reference;
  if (!file) return null;
  const ext = !Array.isArray(file) && isValidUpload(file) ? safeUploadExtension(file) : '';
  if (!REFERENCE_EXTS.has(ext)) throw new ValidationError({ reference: 'The reference must be one JPG, PNG or WebP image.' });
  return { data: file.data, ext };
}

// The body's lists and key sets are bounded before validatePatch walks them.
// No stored draft holds more than LIST_CAP drinks or lines, and a PATCH can
// never add one, so a longer list is already a refusal.
function boundPatchBody(body) {
  for (const section of ['content', 'inputs']) {
    const part = isObject(body) ? body[section] : null;
    if (isObject(part) && Object.keys(part).length > PATCH_KEYS_MAX) throw new ValidationError({ [section]: 'Too many fields.' });
  }
  const content = isObject(body) && isObject(body.content) ? body.content : {};
  for (const list of ['drinks', 'also_at_bar']) {
    if (Array.isArray(content[list]) && content[list].length > LIST_CAP) {
      throw new ValidationError({ [list]: 'Drinks and bar lines are added or removed only by Update draft.' });
    }
  }
}

router.get('/:id/menu-draft', auth, requireAdminOrManager, menuDraftReadLimiter, asyncHandler(async (req, res) => {
  res.json(await readDraftPayload(parseId(req.params.id)));
}));

router.post('/:id/menu-draft/generate', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  requireOpenAI();
  const id = parseId(req.params.id);
  await requireProposal(id);
  const stored = (await pool.query('SELECT inputs FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
  const storedKey = stored && isObject(stored.inputs) ? stored.inputs.reference_key : null;
  const file = referenceFile(req.files);
  const inputs = validateGenerateInputs(req.body, { hasFile: Boolean(file), storedInputs: stored ? stored.inputs : null });
  requireImageModel(inputs.image_model);
  const { plan, normalized } = await job.freshPlan(id);
  if (!normalized || !normalized.drinks.length) throw noDrinks();
  if (inputs.reference_source === 'planner' && !normalized.plannerImageKey) {
    throw new ValidationError({ reference_source: 'The drink plan has no client image to use as the reference.' });
  }

  // R2 first, with no transaction open (spec 5.5). A rollback below orphans
  // the object, the menu-print precedent.
  let uploaded = null;
  if (file) {
    uploaded = `menu-art/${id}/ref-${crypto.randomUUID()}${file.ext}`;
    await uploadFile(file.data, uploaded);
  }

  const provider = inputs.image_model;
  const model = imageModelId(provider);
  const pieceKeys = ['background', ...normalized.drinks.slice(0, LIMITS.art_drinks).map((d) => d.key)];
  const runId = crypto.randomUUID();
  const draft = await inLockedTx(async (client) => {
    const cur = (await client.query('SELECT id, run_id, inputs FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE', [id])).rows[0];
    // Start over keeps the stored upload when no file came and the source is
    // still upload. The locked row must still hold the key validated above,
    // so a Generate that replaced or dropped it in between is a conflict, not
    // a silent swap.
    let referenceKey = uploaded;
    if (!referenceKey && inputs.reference_source === 'upload') {
      const was = cur && isObject(cur.inputs) ? cur.inputs : {};
      if (was.reference_source !== 'upload' || !was.reference_key || was.reference_key !== storedKey) throw draftChanged();
      referenceKey = was.reference_key;
    }
    // Both releases come BEFORE this run reserves (releasing after would free
    // the new run's rows too). Only reserved rows move; a sent row is billed
    // and its job settles it.
    if (cur) await releaseReserved(client, { proposalId: id, runId: cur.run_id });
    await releaseProposalReserved(client, { proposalId: id });
    const { rows } = await client.query(UPSERT_DRAFT_SQL,
      [id, plan.id, runId, { ...inputs, reference_key: referenceKey }, buildFingerprint(normalized)]);
    await client.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1', [rows[0].id]);
    await upsertPendingPieces(client, { draftId: rows[0].id, runId, pieceKeys, provider, model });
    // The text row first: the job adopts the run's first text reservation.
    await reserveText(client, { proposalId: id, runId, model: job.textModelId() });
    await reserveImages(client, { proposalId: id, runId, pieceKeys, provider, model });
    return rows[0];
  });
  res.status(202).json({ draft_id: draft.id, version: draft.version });
  queue('generate', () => job.runGeneration({ draftId: draft.id, runId, proposalId: id }));
}));

router.patch('/:id/menu-draft', auth, requireAdminOrManager, menuDraftEditLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await requireProposal(id);
  const body = req.body;
  const version = parseVersion(isObject(body) ? body.version : undefined);
  const stored = (await pool.query('SELECT version, content, inputs FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
  if (!stored) throw noDraft();
  if (version !== stored.version) throw draftChanged();
  boundPatchBody(body);
  // A content edit before the words land is validatePatch's 400 field error.
  const patch = validatePatch({ stored, body });
  if (!patch.changed) return res.json({ version: stored.version });
  // Only the sections sent are written (spec 7.1, as built). The column names
  // are these two literals, never input.
  const params = [id, version];
  const sets = [];
  for (const column of ['content', 'inputs']) {
    if (patch[column] === undefined) continue;
    params.push(patch[column]);
    sets.push(`${column} = $${params.length}::jsonb`);
  }
  const { rows } = await pool.query(
    `UPDATE menu_drafts SET ${sets.join(', ')}, version = version + 1
      WHERE proposal_id = $1 AND version = $2 RETURNING version`, params);
  if (!rows.length) throw draftChanged();
  return res.json({ version: rows[0].version });
}));

router.post('/:id/menu-draft/pieces/:pieceKey/reroll', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  requireOpenAI();
  const id = parseId(req.params.id);
  const pieceKey = parsePieceKey(req.params.pieceKey);
  const body = isObject(req.body) ? req.body : {};
  const note = validateRerollNote(body.note);
  const provider = validateImageModel(body.image_model);
  requireImageModel(provider);
  await requireProposal(id);
  const model = imageModelId(provider);
  const pieceRunId = crypto.randomUUID();
  const draftId = await inLockedTx(async (client) => {
    const draft = (await client.query(
      'SELECT id, content, NOW() AS db_now FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE', [id])).rows[0];
    if (!draft) throw noDraft();
    // Nothing is reserved for a draft whose words never landed, or for one
    // with no plan (the GET reads it read_only); Start over is the way on.
    requireWords(draft.content, draft.db_now);
    if (!(await loadEventPlan(id, client))) throw noPlan();
    if (pieceKey !== 'background') {
      const drink = capList(isObject(draft.content) ? draft.content.drinks : null).find((d) => isObject(d) && d.key === pieceKey);
      if (!drink) throw new NotFoundError('That drink is not on this menu.');
      if (drink.has_art !== true) throw new ValidationError({ pieceKey: 'Turn art on for this drink first.' });
    }
    const piece = (await client.query(
      'SELECT status, heartbeat_at FROM menu_draft_pieces WHERE draft_id = $1 AND piece_key = $2 FOR UPDATE',
      [draft.id, pieceKey])).rows[0];
    // Busy: working, or pending, and not stuck. A pending piece's run is still
    // active by construction (every run's end fails its open pieces, and Start
    // over deletes a superseded run's), so only a stale heartbeat (a restart)
    // frees it, and the database clock that wrote the heartbeat judges it.
    if (piece && OPEN.has(piece.status) && !stuck(piece, draft.db_now)) {
      throw new AppError('This piece is still being drawn.', 409, 'MENU_ART_PIECE_BUSY');
    }
    // The last attempt's unspent reservation, whatever its run, then this one.
    await releasePieceReserved(client, { proposalId: id, pieceKeys: [pieceKey] });
    await reserveImages(client, { proposalId: id, runId: pieceRunId, pieceKeys: [pieceKey], provider, model });
    await upsertPendingPieces(client, { draftId: draft.id, runId: pieceRunId, pieceKeys: [pieceKey], provider, model, note });
    return draft.id;
  });
  res.status(202).json({ piece_key: pieceKey, status: 'pending' });
  queue('reroll', () => job.runPieceReroll({ draftId, pieceKey, pieceRunId, proposalId: id }));
}));

router.post('/:id/menu-draft/dismiss-plan-change', auth, requireAdminOrManager, menuDraftEditLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await requireProposal(id);
  const version = parseVersion(isObject(req.body) ? req.body.version : undefined);
  const cur = (await pool.query('SELECT version FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
  if (!cur) throw noDraft();
  if (version !== cur.version) throw draftChanged();
  const { normalized } = await job.freshPlan(id);
  if (!normalized) throw noPlan();
  const hash = fingerprintHash(buildFingerprint(normalized));
  // Checked against version but never bumps it: the hash is not menu content,
  // so dismissing the banner on an approved draft leaves it approved (a bump
  // would read as edited since approval). Only dismissed_plan_hash is written,
  // and only while the version still matches (an edit in between is a 409).
  const { rows } = await pool.query(
    `UPDATE menu_drafts SET dismissed_plan_hash = $3
      WHERE proposal_id = $1 AND version = $2 RETURNING version`, [id, version, hash]);
  if (!rows.length) throw draftChanged();
  return res.json({ version: rows[0].version });
}));

router.use('/', require('./menuDraftSync'));
router.use('/', require('./menuDraftImages'));

module.exports = router;
