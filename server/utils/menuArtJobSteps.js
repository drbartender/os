// The menu art job's piece writes and stored-image reads (menuArtJob.js;
// spec 2026-10-01 sections 5.4, 5.5 and 6, Writers and R2 keys; plan Task
// E4). Split from the job to keep each file short; only the job and its
// siblings call these.
//
// A run context (ctx) is { draftId, proposalId, pieceRun, draftRun }:
// - pieceRun: the run_id the run's piece rows and image reservations carry
//   (Generate: the draft run_id; a re-roll or an Update draft drink: its own);
// - draftRun: Generate's run_id, which every write of that run is ALSO
//   conditional on (spec 5.5, "conditional on the draft's current run_id"),
//   or null for a piece run, whose writes are conditional on the piece only.
// Every statement is one standalone pool.query; nothing holds a client.
//
// Stored bytes bound for a provider are read only after their key passes
// assertKeyUnder for its prefix (spec 5.4): menu-art/<proposalId>/ for art,
// menu-art/<proposalId>/ref- for an uploaded reference, and
// drink-plan-logos/<planId>- for the planner image. A key outside is never read.

const crypto = require('crypto');
const sharp = require('sharp');
const { pool } = require('../db');
const storage = require('./storage');
const { assertKeyUnder } = require('./r2Proxy');
const { NotFoundError } = require('./errors');
const { prepareReferences } = require('./menuImageProvider');
const { loadEventPlan, loadCatalogMaps, normalizePlan } = require('./menuDrinkSource');
const { SENTENCES, describe, report } = require('./menuArtJobErrors');

const DRINK_REFERENCE_WIDTH = 1024;
const SHARP_INPUT = { limitInputPixels: 50_000_000 };
const TEXT_MODEL_DEFAULT = 'gpt-5.4-mini';

// The draft-run guard on a piece statement ($n is ctx.draftRun; null skips it).
const guard = (n) => `($${n}::uuid IS NULL OR EXISTS (
  SELECT 1 FROM menu_drafts d WHERE d.id = p.draft_id AND d.run_id = $${n}::uuid))`;
const pieceArgs = (ctx, key) => [ctx.draftId, key, ctx.pieceRun, ctx.draftRun || null];

// pending -> working, or null when the piece is not this run's to work.
async function claimPiece(ctx, key) {
  const { rows } = await pool.query(
    `UPDATE menu_draft_pieces p
        SET status = 'working', error = NULL, started_at = NOW(), finished_at = NULL, heartbeat_at = NOW()
      WHERE p.draft_id = $1 AND p.piece_key = $2 AND p.run_id = $3::uuid AND p.status = 'pending' AND ${guard(4)}
      RETURNING p.provider, p.model, p.reroll_note`, pieceArgs(ctx, key));
  return rows[0] || null;
}

// One UPDATE: the active piece and every pending piece of the run. True while
// the active piece is still this run's and working.
async function beat(ctx, key) {
  const { rows } = await pool.query(
    `UPDATE menu_draft_pieces p SET heartbeat_at = NOW()
      WHERE p.draft_id = $1 AND p.run_id = $3::uuid AND (p.piece_key = $2 OR p.status = 'pending') AND ${guard(4)}
      RETURNING p.piece_key, p.status`, pieceArgs(ctx, key));
  return rows.some((r) => r.piece_key === key && r.status === 'working');
}

// working -> done, and art_version + 1, in one statement. tone and ground_rgb
// are written on the background only. False when the piece is not ours now.
// The draft row is locked FIRST (the piece UPDATE reads d, so d runs before
// any piece row is locked): Generate and Update draft lock the draft and then
// its pieces, and the opposite order here could deadlock with them.
async function finishPiece(ctx, key, { r2Key, tone, groundRgb }) {
  const { rows } = await pool.query(
    `WITH d AS (
       SELECT id FROM menu_drafts WHERE id = $1 AND ($4::uuid IS NULL OR run_id = $4::uuid) FOR UPDATE
     ), done AS (
       UPDATE menu_draft_pieces p
          SET status = 'done', r2_key = $5, error = NULL, finished_at = NOW(), heartbeat_at = NOW(),
              drawn_count = p.drawn_count + 1,
              tone = CASE WHEN p.piece_key = 'background' THEN $6::text ELSE p.tone END,
              ground_rgb = CASE WHEN p.piece_key = 'background' THEN $7::text ELSE p.ground_rgb END
        WHERE p.draft_id IN (SELECT id FROM d) AND p.piece_key = $2 AND p.run_id = $3::uuid AND p.status = 'working'
        RETURNING p.draft_id
     )
     UPDATE menu_drafts SET art_version = art_version + 1
      WHERE id IN (SELECT draft_id FROM done)
      RETURNING art_version`,
    [...pieceArgs(ctx, key), r2Key, tone || null, groundRgb || null]);
  return rows.length === 1;
}

async function failPiece(ctx, key, sentence) {
  await pool.query(
    `UPDATE menu_draft_pieces p SET status = 'failed', error = $5, finished_at = NOW()
      WHERE p.draft_id = $1 AND p.piece_key = $2 AND p.run_id = $3::uuid
        AND p.status IN ('pending', 'working') AND ${guard(4)}`,
    [...pieceArgs(ctx, key), sentence]);
}

// The end-of-run sweep: the run's open pieces (one piece when pieceKey is set).
async function sweep(ctx, cause, pieceKey = null) {
  await pool.query(
    `UPDATE menu_draft_pieces p SET status = 'failed', error = $4, finished_at = NOW()
      WHERE p.draft_id = $1 AND p.run_id = $2::uuid AND p.status IN ('pending', 'working')
        AND ($5::text IS NULL OR p.piece_key = $5) AND ${guard(3)}`,
    [ctx.draftId, ctx.pieceRun, ctx.draftRun || null, cause, pieceKey]);
}

async function draftRunIs(ctx) {
  const { rows } = await pool.query('SELECT 1 FROM menu_drafts WHERE id = $1 AND run_id = $2::uuid', [ctx.draftId, ctx.draftRun]);
  return rows.length === 1;
}

// A lost claim, heartbeat or authorization: on a Generate run whose draft
// run_id is still current only that piece is gone ('skipped'); otherwise the
// run is over ('stopped').
async function lost(ctx) {
  return ctx.draftRun && (await draftRunIs(ctx)) ? 'skipped' : 'stopped';
}

async function loadDraft(draftId, proposalId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.run_id, d.inputs, d.content, p.event_type, p.event_type_custom
       FROM menu_drafts d JOIN proposals p ON p.id = d.proposal_id
      WHERE d.id = $1 AND d.proposal_id = $2`, [draftId, proposalId]);
  return rows[0] || null;
}

// The plan as it is now, with fresh catalog maps (never the read model's
// cache). The job and the draft routes (Generate, dismiss) both read it here.
// -> { plan, normalized }, both null with no plan.
async function freshPlan(proposalId) {
  const plan = await loadEventPlan(proposalId);
  return { plan, normalized: plan ? normalizePlan(plan, await loadCatalogMaps()) : null };
}

// One drink entry of the draft as it is NOW (a PATCH may have turned its art
// off or hidden it since the words landed), or null when the run moved on or
// the drink is gone.
async function currentDrink(ctx, key) {
  const { rows } = await pool.query(
    `SELECT content->'drinks' AS drinks FROM menu_drafts WHERE id = $1 AND ($2::uuid IS NULL OR run_id = $2::uuid)`,
    [ctx.draftId, ctx.draftRun || null]);
  const drinks = rows[0] && Array.isArray(rows[0].drinks) ? rows[0].drinks : [];
  return drinks.find((d) => d && typeof d === 'object' && d.key === key) || null;
}

// The run's unspent reservations, oldest first. Matched on the run_id alone
// (a fresh uuid per run): menu_art_calls.proposal_id is ON DELETE SET NULL, so
// an event deleted before the job's first read would otherwise strand its
// rows as reserved, counting against the cap for 24 hours.
async function findReservations(runId) {
  const { rows } = await pool.query(
    `SELECT id, piece_key, kind, model FROM menu_art_calls
      WHERE run_id = $1::uuid AND status = 'reserved' ORDER BY id`, [runId]);
  return rows;
}

// One reservation that was never sent: reserved -> released (its own status).
async function releaseCall(id) {
  if (id === null || id === undefined || !Number.isInteger(Number(id))) return;
  await pool.query("UPDATE menu_art_calls SET status = 'released' WHERE id = $1 AND status = 'reserved'", [id]);
}

function keyUnder(key, prefix) {
  try { assertKeyUnder(key, prefix); return true; } catch { return false; }
}

// One stored image bound for a provider, or null. The prefix is checked
// before anything is read, so a key outside it is never fetched.
async function readStored(key, prefix, step) {
  if (!keyUnder(key, prefix)) {
    report(step, { provider: null, errorClass: 'KeyOutsidePrefix', status: null, requestId: null, code: 'key_outside_prefix' });
    return null;
  }
  try {
    const file = await storage.readFile(key);
    return { buffer: file.buffer, mimeType: file.contentType || 'application/octet-stream' };
  } catch (err) {
    if (!(err instanceof NotFoundError)) report(step, describe(err, 'r2'));
    return null;
  }
}

// The style reference the run sends with every image, read and prepared once
// per run: an uploaded one, or the planner image when its role is reference.
// Only the prepared copy is kept (re-encoded, metadata stripped, at most 1536
// px), so the stored original (up to 10 MB) is not held for the whole run.
// -> { refs, refError } (refError: every image piece fails with it, unsent).
async function loadReference({ inputs, proposalId, plan, normalized }) {
  const source = inputs && inputs.reference_source;
  if (source !== 'upload' && source !== 'planner') return { refs: [], refError: null };
  const key = source === 'upload' ? inputs.reference_key : normalized && normalized.plannerImageKey;
  let prefix = '';
  if (source === 'upload') prefix = `menu-art/${Number(proposalId)}/ref-`;
  else if (plan) prefix = `drink-plan-logos/${Number(plan.id)}-`;
  const ref = typeof key === 'string' && key && prefix ? await readStored(key, prefix, 'reference') : null;
  if (!ref) return { refs: [], refError: SENTENCES.referenceUnavailable };
  try {
    const [p] = await prepareReferences([ref]);
    return { refs: [p], refError: null };
  } catch {
    return { refs: [], refError: SENTENCES.referenceUnreadable };
  }
}

// The background as a drink's style reference: 1024 px wide, JPEG.
async function drinkReference(buffer) {
  const out = await sharp(buffer, SHARP_INPUT)
    .resize({ width: DRINK_REFERENCE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  return { buffer: out, mimeType: 'image/jpeg' };
}

// A drink re-roll's background: the CURRENT background piece when it is done.
// -> { refs, blocked } (blocked: the piece fails with that sentence, unsent).
async function currentBackground(ctx) {
  const { rows } = await pool.query(
    `SELECT r2_key FROM menu_draft_pieces
      WHERE draft_id = $1 AND piece_key = 'background' AND status = 'done' AND r2_key IS NOT NULL`, [ctx.draftId]);
  if (!rows.length) return { refs: [], blocked: null };
  const stored = await readStored(rows[0].r2_key, `menu-art/${Number(ctx.proposalId)}/`, 'background_read');
  if (!stored) return { refs: [], blocked: SENTENCES.backgroundUnavailable };
  try {
    return { refs: [await drinkReference(stored.buffer)], blocked: null };
  } catch {
    return { refs: [], blocked: SENTENCES.backgroundUnavailable };
  }
}

// menu-art/<proposalId>/<runId>/<pieceSlug>-<uuid>.<ext> (spec 6, R2 keys).
function artKey(ctx, key, contentType) {
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return `menu-art/${Number(ctx.proposalId)}/${ctx.pieceRun}/${key.replace(/:/g, '-')}-${crypto.randomUUID()}.${ext}`;
}

// The words model (MENU_ART_TEXT_MODEL, default gpt-5.4-mini); the routes
// stamp it on reserveText and the job prefers the reservation's own.
function textModelId() {
  return String(process.env.MENU_ART_TEXT_MODEL || '').trim() || TEXT_MODEL_DEFAULT;
}

module.exports = {
  claimPiece, beat, finishPiece, failPiece, sweep, draftRunIs, lost,
  loadDraft, freshPlan, currentDrink, findReservations, releaseCall,
  loadReference, drinkReference, currentBackground, artKey, textModelId,
};
