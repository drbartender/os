// POST /:id/menu-draft/sync, Update draft (spec 2026-10-01 sections 7 and 9;
// mounted by menuDrafts.js). Body { version, image_model }. Brings the draft in
// line with the plan: adds the drinks the plan gained (catalog fields
// directly; a client-typed drink's name and description from one words call),
// removes the ones it lost with their pieces, refreshes only the "Also at the
// bar" lines whose picks moved (spec 2026-10-19 section 17; every other line
// keeps its stored text, the owner's words included), clears
// dismissed_plan_hash, and reserves and queues the added drinks' art, drawn by
// image_model. 202 with the new version. The plan_fingerprint it stores is
// what it applied: the plan's drink keys and bar baseline (bar_lines,
// bar_hash), with the stored brief and planner image parts kept (it applies
// neither, so a notes edit or a new client image still reads after it).
//
// The OpenAI key (and Gemini's, for Gemini art) is checked only where the
// sync will call a provider: a words call for added client-typed drinks, or
// art for added drinks. A bar-only or drop-only update calls nothing, so it
// works without the key (503 MENU_ART_NOT_CONFIGURED otherwise, as before).
//
// Order, so nothing paid or written outlives a refusal:
//   1. checks with no transaction: the body, the draft and its version, the
//      words landed, the plan (fresh catalog maps, never the read model's
//      cache), then the keys when a words call or art will follow;
//   2. when client-typed drinks were added: a short transaction (lockCalls,
//      the draft row, the image-cap headroom for the added drinks that will
//      get art, reserveText under the draft's CURRENT run_id, COMMIT), then
//      runWordsForDrinks with no client held. A 429 at either cap, a 409 (the
//      draft changed) or a 502 (the words failed) ends the sync with nothing
//      written to the draft, and a sync at the image cap spends no words call;
//   3. ONE transaction (lockCalls, the draft row FOR UPDATE, then pieces): the
//      version and words checks again, the plan and catalog reloaded through
//      the client (loadCatalogMaps sends one query at a time, never two on the
//      held client at once), each dropped drink's reserved ledger rows
//      released and its piece deleted, the added drinks appended (art while
//      fewer than 8 visible drinks have it), the changed bar lines refreshed,
//      their art reserved under one new piece run (the keys
//      checked again first, for art the first pass did not see), the applied
//      fingerprint, version + 1, COMMIT;
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
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, legacyBarBaseline } = require('../../utils/menuDrinkSource');
const { keyedBarLines, barLineKey, keyBarLines, LINE_LABELS } = require('../../utils/menuAlsoAtBar');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const {
  isObject, capList, parseId, parseVersion, requireProposal, noDraft, draftChanged, noPlan, requireWords,
  upsertPendingPieces, requireOpenAI, requireImageModel, imageModelId, inLockedTx, queue,
} = require('./menuDraftShared');

const router = express.Router();

const NAME_MAX = 60;
// The builder's print order of the bar lines.
const BAR_ORDER = Object.values(LINE_LABELS);

// computeDiff over capped copies of the stored lists.
function diffOf(draft, normalized) {
  const fp = isObject(draft.plan_fingerprint) ? draft.plan_fingerprint : {};
  return computeDiff({
    ...draft,
    plan_fingerprint: { ...fp, drink_keys: capList(fp.drink_keys) },
    content: { drinks: capList(isObject(draft.content) ? draft.content.drinks : null) },
  }, normalized);
}

// Only the bar lines whose picks moved (the diff's bar_changed_labels, the
// builder's labels): a changed line is rebuilt from the current picks (a hand
// edit on it, its label included, is replaced, since the picks under it
// moved), a new line is added and a gone line removed, in the builder's print
// order. A stored line is matched by its server-written key, never by the
// label the owner can rename (lane menu-bar-baseline), so a renamed line is
// refreshed in place and keeps its position. Every other stored line is kept
// as it is, the owner's words included.
function refreshBarLines(stored, built, changedLabels) {
  const changed = new Set(changedLabels);
  const lines = capList(stored).filter(isObject);
  const keyed = lines.filter((line) => typeof line.key === 'string' && line.key !== '');
  let kept = [...keyed.filter((line) => !changed.has(line.key)), ...lines.filter((line) => !keyed.includes(line))];
  let fresh = built.filter((line) => changed.has(line.key));
  // A line no key could be found for (keyBarLines) cannot be matched, so a
  // moved pick under it would print stale: when the bar moved, every unkeyed
  // line gives way to the built lines no kept keyed line stands for.
  if (changed.size && keyed.length < lines.length) {
    kept = keyed.filter((line) => !changed.has(line.key));
    const covered = new Set(kept.map((line) => line.key));
    fresh = built.filter((line) => !covered.has(line.key));
  }
  const rank = (line) => { const i = BAR_ORDER.indexOf(barLineKey(line)); return i === -1 ? BAR_ORDER.length : i; };
  return [...kept, ...fresh].map((line, i) => ({ line, i }))
    .sort((a, b) => rank(a.line) - rank(b.line) || a.i - b.i)
    .map(({ line }) => line);
}

// The fingerprint of what Update draft applied: the plan's drink keys and bar
// baseline. The brief and the planner image it does not apply, so their stored
// parts stay and their flags (Notes edited, the client image changed) survive.
function appliedFingerprint(stored, normalized) {
  const fp = isObject(stored) ? stored : {};
  const current = buildFingerprint(normalized);
  return {
    drink_keys: current.drink_keys,
    brief_hash: fp.brief_hash,
    brief_fields: fp.brief_fields,
    planner_image_key: fp.planner_image_key,
    bar_lines: current.bar_lines,
    bar_hash: current.bar_hash,
  };
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

// Only a sync that will call a provider needs one set up ("set up" means the
// OpenAI key, which the words step always needs); art needs its model's too.
function requireProviders(provider, { words, art }) {
  if (!words && !art) return;
  requireOpenAI();
  if (art) requireImageModel(provider);
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
  const id = parseId(req.params.id);
  const body = isObject(req.body) ? req.body : {};
  const version = parseVersion(body.version);
  const provider = validateImageModel(body.image_model);
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
  requireProviders(provider, { words: typed.length > 0, art: artCount > 0 });
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
    const diff = diffOf(locked, normalized);
    const { dropped, kept, added: plannedAdds } = layout(locked.content, diff, normalized);
    const added = plannedAdds.map(({ drink, hasArt }) => {
      const entry = drink.source === 'catalog' ? catalogEntry(drink) : words.get(drink.key);
      // A typed drink the plan gained after the words call: nothing to write it with.
      if (!entry) throw draftChanged('The drink plan changed. Try Update draft again.');
      return { ...entry, has_art: hasArt, added_by_sync: true };
    });
    const artKeys = added.filter((d) => d.has_art).map((d) => d.key);
    requireProviders(provider, { words: false, art: artKeys.length > 0 });

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
    const content = { ...locked.content, drinks: [...kept, ...added] };
    // A line stored before keys existed is keyed here, under the row lock, by
    // its label, its place and its words (keyBarLines), so a renamed line is
    // matched by what it stands for (lane menu-bar-baseline).
    const storedFp = isObject(locked.plan_fingerprint) ? locked.plan_fingerprint : {};
    content.also_at_bar = keyBarLines(content.also_at_bar).lines;
    // A draft with no baseline yet is diffed against the one the boot stamp
    // would give it (menuBarBaselineStamp.js), so a category its stored lines
    // prove came or went since Generate is repaired in this same Update draft.
    const barDiff = isObject(storedFp.bar_lines) ? diff
      : diffOf({ ...locked, plan_fingerprint: { ...storedFp, ...legacyBarBaseline(content.also_at_bar, normalized) } }, normalized);
    if (barDiff.bar_changed) {
      content.also_at_bar = refreshBarLines(content.also_at_bar, keyedBarLines(normalized.bar), barDiff.bar_changed_labels);
    }
    const applied = appliedFingerprint(locked.plan_fingerprint, normalized);
    const { rows } = await client.query(
      `UPDATE menu_drafts SET content = $2::jsonb, plan_fingerprint = $3::jsonb, dismissed_plan_hash = NULL,
              drink_plan_id = $4, version = version + 1
        WHERE id = $1 RETURNING version`,
      [locked.id, content, applied, current.id]);
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
