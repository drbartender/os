// startGeneration, the one Generate: the menu draft run a manual Generate and the drink plan submit's
// auto-start both start (spec 2026-10-19 section 8.3). Not a router.
//
// startGeneration({ proposalId, inputs, file, firstDraft, onStarted }) -> {
// draftId, runId, version }, throwing the Generate route's AppErrors. inputs is the
// posted body (validateGenerateInputs reads it: the route's multipart fields,
// or the auto-start's { image_model }, every other field taking its default),
// file the raw reference upload or none. It does what the route did before it
// moved here (lane menu-auto-start), in the same order, so a refusal is the
// same refusal: the legal hold (assertNotLegalHold, before any read), the
// proposal (404), the stored inputs, the reference file's bytes (400), the
// plan read fresh, the inputs settled (inputs.look decided as spec 9.1 says),
// the event's touch set (event_date read as text), the key of every provider
// the run will call (503 MENU_ART_NOT_CONFIGURED or
// MENU_ART_GEMINI_NOT_CONFIGURED), the drinks (422 MENU_NO_DRINKS); then any R2
// upload with no transaction open; then ONE inLockedTx (the calls lock, the
// draft row FOR UPDATE, the releases of the old run's and any stranded
// reservations, the draft upserted in place, its pieces reset, the text and
// image reservations; the caps throw 429 MENU_ART_TEXT_CAP_REACHED or
// MENU_ART_CAP_REACHED inside it, so a capped Generate writes no draft).
//
// It never queues the job and never answers: the caller does both once it
// returns and its client is released (the route its 202 and queue, the
// auto-start its guard row and queue). Nothing here reads a request, so no
// user is ever read (menu_art_calls has no user column). firstDraft, the
// auto-start's own premise (spec 8.2: no menu_drafts row), refuses with 409
// MENU_DRAFT_CHANGED under the draft row lock when the event has a draft, so
// a manual Generate that landed between the auto-start's checks and here is
// never replaced; the route never sets it. onStarted, the auto-start's too
// (the route passes none), is an async (client, { draftId, runId, version })
// called inside the one locked transaction, on its own client, after the
// draft row, its pieces and the reservations are written and before COMMIT,
// so what it writes lands with the draft or not at all: when it throws, the
// transaction rolls back (no draft, no reservation) and startGeneration
// throws that error.
//
// Generate releases every reserved row of the proposal (the old run's, and any
// re-roll or sync row stranded by a restart) BEFORE it reserves its own, and
// upserts the draft in place (version, art_version and the approved_* stamps
// survive; the bumped version reads as edited since approval). A custom run's
// pieces are the background plus the first 8 drinks in plan order, each
// stamped with the image model and that provider's model id from env; a house
// run reserves only the background, and nothing on a plain card, and no text
// row (spec 9.2).

const crypto = require('crypto');
const { pool } = require('../../db');
const { AppError, ValidationError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload, safeUploadExtension } = require('../../utils/fileValidation');
const { reserveImages, reserveText, releaseReserved, releaseProposalReserved } = require('../../utils/menuArtCap');
const job = require('../../utils/menuArtJob');
const { validateGenerateInputs, LIMITS } = require('../../utils/menuDraftValidation');
const { touchSetFor } = require('../../utils/menuEventTouches');
const { draftFingerprint } = require('../../utils/menuHouseSections');
const { assertNotLegalHold } = require('./patchGuards');
const {
  isObject, requireProposal, draftChanged, upsertPendingPieces, requireWordsProvider, requireImageModel, imageModelId,
  inLockedTx, layoutPieceKeys,
} = require('./menuDraftShared');

const REFERENCE_EXTS = new Set(['.jpg', '.png', '.webp']);
const noDrinks = () => new AppError('The drink plan has no drinks to put on a menu.', 422, 'MENU_NO_DRINKS');

const STORED_INPUTS_SQL = 'SELECT inputs FROM menu_drafts WHERE proposal_id = $1';
// The event the touches follow; the date as text (spec 8.2).
const EVENT_SQL = 'SELECT event_type, event_type_custom, event_date::text AS event_date FROM proposals WHERE id = $1';
const LOCK_DRAFT_SQL = 'SELECT id, run_id, inputs FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE';
const DELETE_PIECES_SQL = 'DELETE FROM menu_draft_pieces WHERE draft_id = $1';

// $6 is the content seed: look, touch_key and house_bottom_corners (spec 9.1).
const UPSERT_DRAFT_SQL = `
  INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint)
  VALUES ($1, $2, $3::uuid, $4::jsonb,
          jsonb_build_object('words_status', 'pending', 'words_heartbeat_at', NOW()) || $6::jsonb, $5::jsonb)
  ON CONFLICT (proposal_id) DO UPDATE
     SET drink_plan_id = EXCLUDED.drink_plan_id, run_id = EXCLUDED.run_id, inputs = EXCLUDED.inputs,
         content = EXCLUDED.content, plan_fingerprint = EXCLUDED.plan_fingerprint,
         dismissed_plan_hash = NULL, version = menu_drafts.version + 1
  RETURNING id, version`;

// The attached reference, checked by its bytes (spec 7, Upload checks), or null.
function referenceFile(raw) {
  if (!raw) return null;
  const ext = !Array.isArray(raw) && isValidUpload(raw) ? safeUploadExtension(raw) : '';
  if (!REFERENCE_EXTS.has(ext)) throw new ValidationError({ reference: 'The reference must be one JPG, PNG or WebP image.' });
  return { data: raw.data, ext };
}

// What the look decision reads from the plan (validateGenerateInputs).
const planFacts = (plan, normalized) => ({
  menuStyle: plan && isObject(plan.selections) ? plan.selections.menuStyle : null,
  brief: normalized ? normalized.brief : null,
});

/** The one Generate (header). */
async function startGeneration({ proposalId, inputs: body, file: rawFile = null, firstDraft = false, onStarted = null } = {}) {
  const id = proposalId;
  assertNotLegalHold(id);
  await requireProposal(id);
  const stored = (await pool.query(STORED_INPUTS_SQL, [id])).rows[0];
  const storedKey = stored && isObject(stored.inputs) ? stored.inputs.reference_key : null;
  const file = referenceFile(rawFile);
  const { plan, normalized } = await job.freshPlan(id);
  const inputs = validateGenerateInputs(body, {
    hasFile: Boolean(file), storedInputs: stored ? stored.inputs : null, plan: planFacts(plan, normalized),
  });
  const touches = touchSetFor((await pool.query(EVENT_SQL, [id])).rows[0]);
  const house = inputs.look === 'house';
  // The keys of the providers this run calls, before any work (header).
  if (!house) requireWordsProvider();
  if (!house || !touches.plain) requireImageModel(inputs.image_model);
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
  const seed = { look: inputs.look, touch_key: touches.key, house_bottom_corners: touches.bottomCorners };
  // A house card's background alone (none when plain); a custom one's background and first 8 drinks.
  const pieceKeys = house ? layoutPieceKeys(seed) : ['background', ...normalized.drinks.slice(0, LIMITS.art_drinks).map((d) => d.key)];
  const runId = crypto.randomUUID();
  const draft = await inLockedTx(async (client) => {
    const cur = (await client.query(LOCK_DRAFT_SQL, [id])).rows[0];
    // The auto-start's premise, under the lock: a draft made meanwhile stands.
    if (firstDraft && cur) throw draftChanged('This event has a menu draft already.');
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
      [id, plan.id, runId, { ...inputs, reference_key: referenceKey }, draftFingerprint(seed, plan, normalized), seed]);
    await client.query(DELETE_PIECES_SQL, [rows[0].id]);
    await upsertPendingPieces(client, { draftId: rows[0].id, runId, pieceKeys, provider, model });
    // The text row first: the job adopts the run's first text reservation. A
    // house run writes no words, so it reserves none.
    if (!house) await reserveText(client, { proposalId: id, runId, model: job.textModelId() });
    await reserveImages(client, { proposalId: id, runId, pieceKeys, provider, model });
    // The caller's own write, atomic with the draft (header).
    if (onStarted) await onStarted(client, { draftId: rows[0].id, runId, version: rows[0].version });
    return rows[0];
  });
  return { draftId: draft.id, runId, version: draft.version };
}

module.exports = { startGeneration };
