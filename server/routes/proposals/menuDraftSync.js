// POST /:id/menu-draft/sync, Update draft (spec 2026-10-01 sections 7 and 9;
// mounted by menuDrafts.js). Body { version, image_model }. Brings the draft in
// line with the plan: adds the drinks the plan gained (catalog fields
// directly; a client-typed drink's name and description from one words call),
// removes the ones it lost with their pieces, resets plan_fingerprint, clears
// dismissed_plan_hash, and reserves and queues the added drinks' art, drawn by
// image_model. 202 with the new version.
//
// Order, so nothing paid or written outlives a refusal:
//   1. checks with no transaction: the OpenAI key, the body, the draft and its
//      version, the words landed, the plan (fresh catalog maps, never the read
//      model's cache);
//   2. when client-typed drinks were added: a short transaction (lockCalls,
//      the draft row, the image-cap headroom for the added drinks that will
//      get art, reserveText under the draft's CURRENT run_id, COMMIT), then
//      runWordsForDrinks with no client held. A 429 at either cap, a 409 (the
//      draft changed) or a 502 (the words failed) ends the sync with nothing
//      written to the draft, and a sync at the image cap spends no words call;
//   3. ONE transaction (lockCalls, the draft row FOR UPDATE, then pieces): the
//      version and words checks again, the plan and catalog reloaded through
//      the client, each dropped drink's reserved ledger rows released and its
//      piece deleted, the added drinks appended (art while fewer than 8
//      visible drinks have it), their art reserved under one new piece run,
//      version + 1, COMMIT;
//   4. after the client is released: one queued task draws the added art one
//      piece at a time (runPieceReroll, awaited in turn, never side by side).

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { reserveImages, reserveText, releasePieceReserved, requireImageHeadroom } = require('../../utils/menuArtCap');
const job = require('../../utils/menuArtJob');
const { computeDiff } = require('../../utils/menuDraftRead');
const { validateImageModel, LIMITS } = require('../../utils/menuDraftValidation');
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint } = require('../../utils/menuDrinkSource');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const {
  isObject, capList, parseId, parseVersion, requireProposal, noDraft, draftChanged, noPlan, requireWords,
  upsertPendingPieces, requireOpenAI, requireImageModel, imageModelId, inLockedTx, queue,
} = require('./menuDraftShared');

const router = express.Router();

const NAME_MAX = 60;

// computeDiff over capped copies of the stored lists.
function diffOf(draft, normalized) {
  const fp = isObject(draft.plan_fingerprint) ? draft.plan_fingerprint : {};
  return computeDiff({
    ...draft,
    plan_fingerprint: { ...fp, drink_keys: capList(fp.drink_keys) },
    content: { drinks: capList(isObject(draft.content) ? draft.content.drinks : null) },
  }, normalized);
}

const addedDrinks = (diff, normalized) => {
  const keys = new Set(diff.added.map((d) => d.key));
  return normalized.drinks.filter((d) => keys.has(d.key));
};

// The drinks kept and the plan's added drinks in order, each added one with
// whether it gets art (while fewer than LIMITS.art_drinks visible drinks have
// it). The headroom check and the main transaction both read it.
function layout(content, diff, normalized) {
  const dropped = new Set(diff.dropped.map((d) => d.key));
  const kept = capList(isObject(content) ? content.drinks : null).filter((d) => isObject(d) && !dropped.has(d.key));
  const have = new Set(kept.map((d) => d.key));
  let art = kept.filter((d) => d.hidden !== true && d.has_art === true).length;
  const added = [];
  for (const drink of addedDrinks(diff, normalized)) {
    if (have.has(drink.key)) continue;
    const hasArt = art < LIMITS.art_drinks;
    if (hasArt) art += 1;
    added.push({ drink, hasArt });
    have.add(drink.key);
  }
  return { dropped, kept, added };
}

// Spec 6's thirteen fields for a catalog drink, straight from the catalog.
function catalogEntry(d) {
  const name = Array.from(String(d.name || '').trim()).slice(0, NAME_MAX).join('').trim();
  return {
    key: d.key, source: 'catalog', catalog_kind: d.catalog_kind || null, group: d.group === 'mock' ? 'mock' : 'sig',
    catalog_id: d.catalog_id === undefined ? null : d.catalog_id,
    display_name: name || d.key, description: d.description || null,
    name_ai_suggested: false, description_ai_written: false, visual_note: '',
    hidden: false, has_art: false, added_by_sync: true,
  };
}

// Step 2: the words for the added client-typed drinks. -> Map key -> entry.
// artCount: the added drinks that will get art, checked against the image
// cap before the words call is reserved (and so before it is spent).
async function typedWords({ id, draft, proposal, typed, brief, artCount }) {
  const model = job.textModelId();
  const runId = draft.run_id;
  const reservationId = await inLockedTx(async (client) => {
    const cur = (await client.query('SELECT run_id, version FROM menu_drafts WHERE id = $1 FOR UPDATE', [draft.id])).rows[0];
    if (!cur || cur.version !== draft.version || cur.run_id !== runId) throw draftChanged();
    await requireImageHeadroom(client, artCount);
    return reserveText(client, { proposalId: id, runId, model });
  });
  const entries = await job.runWordsForDrinks({
    normalizedDrinks: typed, brief, eventTypeLabel: getEventTypeLabel(proposal), reservationId, draftId: draft.id, runId, model,
  });
  return new Map(capList(entries).filter(isObject).map((e) => [e.key, e]));
}

router.post('/:id/menu-draft/sync', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  requireOpenAI();
  const id = parseId(req.params.id);
  const body = isObject(req.body) ? req.body : {};
  const version = parseVersion(body.version);
  const provider = validateImageModel(body.image_model);
  requireImageModel(provider);
  const proposal = await requireProposal(id);
  const draft = (await pool.query(
    'SELECT id, run_id, version, content, plan_fingerprint, NOW() AS db_now FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
  if (!draft) throw noDraft();
  if (draft.version !== version) throw draftChanged();
  requireWords(draft.content, draft.db_now);
  const plan = await loadEventPlan(id);
  if (!plan) throw noPlan();
  const first = normalizePlan(plan, await loadCatalogMaps());
  const firstDiff = diffOf(draft, first);
  const typed = addedDrinks(firstDiff, first).filter((d) => d.source !== 'catalog');
  const artCount = layout(draft.content, firstDiff, first).added.filter((a) => a.hasArt).length;
  const words = typed.length ? await typedWords({ id, draft, proposal, typed, brief: first.brief, artCount }) : new Map();

  const model = imageModelId(provider);
  const pieceRunId = crypto.randomUUID();
  const result = await inLockedTx(async (client) => {
    const locked = (await client.query(
      'SELECT id, version, content, plan_fingerprint, dismissed_plan_hash, NOW() AS db_now FROM menu_drafts WHERE id = $1 FOR UPDATE',
      [draft.id])).rows[0];
    if (!locked || locked.version !== version) throw draftChanged();
    requireWords(locked.content, locked.db_now);
    const current = await loadEventPlan(id, client);
    if (!current) throw noPlan();
    const normalized = normalizePlan(current, await loadCatalogMaps(client));
    const { dropped, kept, added: plannedAdds } = layout(locked.content, diffOf(locked, normalized), normalized);
    const added = plannedAdds.map(({ drink, hasArt }) => {
      const entry = drink.source === 'catalog' ? catalogEntry(drink) : words.get(drink.key);
      // A typed drink the plan gained after the words call: nothing to write it with.
      if (!entry) throw draftChanged('The drink plan changed. Try Update draft again.');
      return { ...entry, has_art: hasArt, added_by_sync: true };
    });
    const artKeys = added.filter((d) => d.has_art).map((d) => d.key);

    // Dropped drinks: their unspent reservations stop counting, then their
    // pieces go (the draft row is already locked, so pieces lock after it).
    // Added drinks with art: any stale reservation of theirs is freed before
    // this run reserves.
    await releasePieceReserved(client, { proposalId: id, pieceKeys: [...dropped, ...artKeys] });
    if (dropped.size) {
      await client.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1 AND piece_key = ANY($2::text[])', [locked.id, [...dropped]]);
    }
    if (artKeys.length) {
      await reserveImages(client, { proposalId: id, runId: pieceRunId, pieceKeys: artKeys, provider, model });
      await upsertPendingPieces(client, { draftId: locked.id, runId: pieceRunId, pieceKeys: artKeys, provider, model });
    }
    const { rows } = await client.query(
      `UPDATE menu_drafts SET content = $2::jsonb, plan_fingerprint = $3::jsonb, dismissed_plan_hash = NULL,
              drink_plan_id = $4, version = version + 1
        WHERE id = $1 RETURNING version`,
      [locked.id, { ...locked.content, drinks: [...kept, ...added] }, buildFingerprint(normalized), current.id]);
    return { version: rows[0].version, artKeys };
  });

  res.status(202).json({ version: result.version });
  if (result.artKeys.length) {
    queue('sync', async () => {
      for (const pieceKey of result.artKeys) {
        await job.runPieceReroll({ draftId: draft.id, pieceKey, pieceRunId, proposalId: id });
      }
    });
  }
}));

module.exports = router;
