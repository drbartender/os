// POST /:id/menu-draft/sync, Update draft (spec 2026-10-01 sections 7 and 9;
// mounted by menuDrafts.js). Body { version, image_model, scope? }. scope is a
// closed value: absent, the full Update draft below; 'bar', the bar-only
// rebuild (after the full one); anything else 400. The full one brings the draft in
// line with the plan: adds the drinks the plan gained (catalog fields
// directly; a client-typed drink's name and description from one words call),
// removes the ones it lost with their pieces, refreshes only the "Also at the
// bar" lines whose picks moved and rebuilds and keys every line renamed before
// bar picks were tracked (spec 2026-10-19 section 17; every other line keeps
// its stored text, the owner's words included), clears dismissed_plan_hash,
// and reserves and queues the added drinks' art, drawn by image_model. 202
// with the new version. The plan_fingerprint it stores is what it applied: the
// plan's drink keys and bar baseline (bar_lines, bar_hash), with the stored
// brief and planner image parts kept (it applies neither, so a notes edit or a
// new client image still reads after it). The words call for the added
// client-typed drinks reads effectiveBrief(the plan's brief, the draft's
// inputs.admin_brief) (spec 2026-10-19 section 7.2), the brief the words step
// reads; the fingerprint never sees the admin brief.
//
// The keys are checked up front, before anything is reserved or spent,
// whenever the sync adds a drink: the words provider's key for a client-typed
// one (its words call, on the current words model's provider; spec 2026-10-19
// section 16), and the image model's own key (OpenAI's or Gemini's) for any
// added drink, since one the first read leaves without art can still draw it
// when a slot frees by the main transaction, which checks again. A bar-only or
// drop-only update calls nothing, so it works with no key at all (503
// MENU_ART_NOT_CONFIGURED or MENU_ART_GEMINI_NOT_CONFIGURED otherwise).
//
// Order, so nothing paid or written outlives a refusal:
//   0. the legal-hold proposal is refused first, 409 LEGAL_HOLD
//      (assertNotLegalHold, isLegalHold failing closed), before any read,
//      provider call, reservation or write (money law 15);
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
//      fewer than 8 visible drinks have it), the bar lines refreshed (the
//      changed ones, and every line with no key rebuilt and keyed),
//      their art reserved under one new piece run (the keys
//      checked again first, for art the first pass did not see), the applied
//      fingerprint, version + 1, COMMIT;
//   4. after the client is released: one queued task draws the added art one
//      piece at a time (runPieceReroll, awaited in turn, never side by side).
//
// The bar-only rebuild (scope bar; the unchecked notice's own Update draft,
// spec 2026-10-19 section 17, lane menu-bar-rebuild-only) rebuilds and keys
// only the lines no key can be found for and the keyed lines whose category
// the picks no longer build: each such keyed line goes, and with an unkeyed
// line held every category no kept keyed line covers is built from the picks
// and keyed, as the full one does. Every other keyed line keeps its stored
// text, a moved pick's line included, which keeps its old baseline so it still
// reads changed for the full Update draft. It applies no drink change, needs
// no AI key and no image_model, reserves nothing and calls no provider. It
// keeps the stored drink, brief and planner image parts of the fingerprint;
// the bar baseline takes today's picks for the lines it rebuilt, drops the
// unkeyed:<place> entries and the categories that print nothing, and keeps
// the rest. A dismissal that matched before it is re-stamped to the draft it
// leaves (dismissalHash), so neither a dismissed drink change nor a reviewed
// notes edit comes back; one that did not match is left as it was. Same
// refusals and order as the full one, after the legal hold: 404, the version
// (409), the words (409), the plan (422), all inside ONE transaction on one
// pooled client (inLockedTx: lockCalls, then the draft row FOR UPDATE, then
// the plan and catalog through the client), version + 1, COMMIT. With nothing
// to rebuild it writes nothing and answers 202 with the version it holds.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { ValidationError } = require('../../utils/errors');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { reserveImages, reserveText, releasePieceReserved, requireImageHeadroom } = require('../../utils/menuArtCap');
const job = require('../../utils/menuArtJob');
const { computeDiff, barBaseline, dismissalHash } = require('../../utils/menuDraftRead');
const { validateImageModel, LIMITS } = require('../../utils/menuDraftValidation');
const {
  loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, hashBarLines, effectiveBrief,
} = require('../../utils/menuDrinkSource');
const { keyedBarLines, keyBarLines, LINE_LABELS } = require('../../utils/menuAlsoAtBar');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { assertNotLegalHold } = require('./patchGuards');
const {
  isObject, capList, parseId, parseVersion, requireProposal, noDraft, draftChanged, noPlan, requireWords,
  upsertPendingPieces, requireWordsProvider, requireImageModel, imageModelId, inLockedTx, queue,
} = require('./menuDraftShared');

const router = express.Router();

const NAME_MAX = 60;
// The builder's print order of the bar lines.
const BAR_ORDER = Object.values(LINE_LABELS);
// A bar baseline entry for a line renamed before bar picks were tracked (legacyBarBaseline).
const UNKEYED = 'unkeyed:';
const SCOPES = new Set(['bar']);

const hasKey = (line) => typeof line.key === 'string' && line.key !== '';
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The body's scope: absent is the full Update draft; 'bar' the bar-only rebuild.
function parseScope(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !SCOPES.has(raw)) throw new ValidationError({ scope: 'Update draft takes no scope, or scope bar.' });
  return raw;
}

// Lines in the builder's print order, a line no label ranks last, ties kept.
function inPrintOrder(lines) {
  const rank = (line) => { const i = BAR_ORDER.indexOf(line.key); return i === -1 ? BAR_ORDER.length : i; };
  return lines.map((line, i) => ({ line, i }))
    .sort((a, b) => rank(a.line) - rank(b.line) || a.i - b.i)
    .map(({ line }) => line);
}

// computeDiff over capped copies of the stored lists: the diff the GET shows,
// read against the legacy bar baseline when the draft has no bar_lines yet
// (no list stays no list, which reads as today's picks).
function diffOf(draft, normalized) {
  const fp = isObject(draft.plan_fingerprint) ? draft.plan_fingerprint : {};
  const content = isObject(draft.content) ? draft.content : {};
  return computeDiff({
    ...draft,
    plan_fingerprint: { ...fp, drink_keys: capList(fp.drink_keys) },
    content: {
      drinks: capList(content.drinks),
      also_at_bar: Array.isArray(content.also_at_bar) ? capList(content.also_at_bar) : undefined,
    },
  }, normalized);
}

// The "Also at the bar" lines after Update draft, in the builder's print order.
// A stored line is found by its server-written key (the builder's label), never
// by the label the owner can rename (lane menu-bar-baseline), so a renamed
// keyed line is refreshed in place. A keyed line keeps its stored text, the
// owner's words included, unless its own category changed (the diff's
// bar_changed_labels), when it is rebuilt from the current picks (a hand edit
// on it, its label included, is replaced, since the picks under it moved); a
// keyed line whose category the picks no longer build goes; a changed label no
// kept line covers is built. A line with no key, renamed before bar picks were
// tracked (keyBarLines), is never matched to a category (lane
// menu-bar-renamed-lines): every such line gives way, and every category no
// kept keyed line covers is built from the picks and keyed, so one Update
// draft rebuilds it and the result holds no unkeyed line.
function refreshBarLines(stored, built, changedLabels) {
  const changed = new Set(changedLabels);
  const lines = capList(stored).filter(isObject);
  const keyed = lines.filter(hasKey);
  const unkeyedHeld = keyed.length < lines.length;
  const builtKeys = new Set(built.map((line) => line.key));
  const kept = keyed.filter((line) => builtKeys.has(line.key) && !changed.has(line.key));
  const covered = new Set(kept.map((line) => line.key));
  const fresh = built.filter((line) => !covered.has(line.key) && (unkeyedHeld || changed.has(line.key)));
  return inPrintOrder([...kept, ...fresh]);
}

// The bar-only rebuild (header) of stored lines already keyed by keyBarLines,
// against the picks' keyed lines, the baseline the diff reads and today's
// bar_lines. -> null when there is nothing to rebuild (no unkeyed line, no
// keyed line whose category went), else { lines, barLines }: the new lines in
// print order and the new baseline.
function rebuildBarOnly(stored, built, before, current) {
  const lines = capList(stored).filter(isObject);
  const keyed = lines.filter(hasKey);
  const builtKeys = new Set(built.map((line) => line.key));
  const kept = keyed.filter((line) => builtKeys.has(line.key));
  const unkeyedHeld = keyed.length < lines.length;
  if (!unkeyedHeld && kept.length === keyed.length) return null;
  const covered = new Set(kept.map((line) => line.key));
  const fresh = unkeyedHeld ? built.filter((line) => !covered.has(line.key)) : [];
  const rebuilt = new Set(fresh.map((line) => line.key));
  // A kept line's entry stays (a moved pick still reads changed); a category
  // with no line stays while the picks build it (it still reads new); the
  // rebuilt lines take today's.
  const held = Object.entries(isObject(before) ? before : {}).filter(([key]) => !key.startsWith(UNKEYED) && !rebuilt.has(key)
    && (covered.has(key) || hasOwn(current, key)));
  const today = Object.entries(current).filter(([key]) => rebuilt.has(key));
  return { lines: inPrintOrder([...kept, ...fresh]), barLines: Object.fromEntries([...held, ...today]) };
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

// Only a sync that will call a provider needs its key: the words provider's
// for a words call, the image model's own for art.
function requireProviders(provider, { words, art }) {
  if (words) requireWordsProvider();
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

// Scope bar (header): one transaction, on one pooled client, under the row lock.
function syncBarOnly(id, version) {
  return inLockedTx(async (client) => {
    await requireProposal(id, client);
    const locked = (await client.query(
      'SELECT id, version, content, plan_fingerprint, dismissed_plan_hash, NOW() AS db_now FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE',
      [id])).rows[0];
    if (!locked) throw noDraft();
    if (locked.version !== version) throw draftChanged();
    requireWords(locked.content, locked.db_now);
    const current = await loadEventPlan(id, client);
    if (!current) throw noPlan();
    const normalized = normalizePlan(current, await loadCatalogMaps(client));
    const diff = diffOf(locked, normalized);
    const stored = isObject(locked.plan_fingerprint) ? locked.plan_fingerprint : {};
    const rebuilt = rebuildBarOnly(keyBarLines(capList(locked.content.also_at_bar)).lines, keyedBarLines(normalized.bar),
      barBaseline(stored, locked.content, normalized), buildFingerprint(normalized).bar_lines);
    if (!rebuilt) return { version: locked.version };
    const content = { ...locked.content, also_at_bar: rebuilt.lines };
    const fingerprint = { ...stored, bar_lines: rebuilt.barLines, bar_hash: hashBarLines(rebuilt.barLines) };
    const dismissed = diff.dismissed ? dismissalHash({ plan_fingerprint: fingerprint, content }, normalized) : locked.dismissed_plan_hash;
    const { rows } = await client.query(
      `UPDATE menu_drafts SET content = $2::jsonb, plan_fingerprint = $3::jsonb, dismissed_plan_hash = $4, version = version + 1
        WHERE id = $1 RETURNING version`,
      [locked.id, content, fingerprint, dismissed]);
    return { version: rows[0].version };
  });
}

router.post('/:id/menu-draft/sync', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  assertNotLegalHold(id);
  const body = isObject(req.body) ? req.body : {};
  const scope = parseScope(body.scope);
  const version = parseVersion(body.version);
  if (scope === 'bar') {
    res.status(202).json(await syncBarOnly(id, version));
    return;
  }
  const provider = validateImageModel(body.image_model);
  const proposal = await requireProposal(id);
  const draft = (await pool.query(
    'SELECT id, run_id, version, content, inputs, plan_fingerprint, NOW() AS db_now FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
  if (!draft) throw noDraft();
  if (draft.version !== version) throw draftChanged();
  requireWords(draft.content, draft.db_now);
  const plan = await loadEventPlan(id);
  if (!plan) throw noPlan();
  const first = normalizePlan(plan, await loadCatalogMaps());
  const firstDiff = diffOf(draft, first);
  const typed = addedDrinks(firstDiff, first).filter((d) => d.source !== 'catalog');
  const artCount = layout(draft.content, firstDiff, first).added.filter((a) => a.hasArt).length;
  // Any added drink could draw art (a slot freed during the words call hands it
  // one), so its image model's key is needed before the words call spends.
  requireProviders(provider, { words: typed.length > 0, art: firstDiff.added.length > 0 });
  const adminBrief = isObject(draft.inputs) ? draft.inputs.admin_brief : null;
  const words = typed.length
    ? await typedWords({ id, draft, proposal, typed, brief: effectiveBrief(first.brief, adminBrief), artCount }) : new Map();

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
    // A line stored before keys existed that still carries a builder label is
    // keyed by it here, under the row lock (keyBarLines, lane
    // menu-bar-legacy-keys). The diff is the one the GET shows: for a draft
    // with no baseline yet it reads the one the boot stamp would give it
    // (menuBarBaselineStamp.js), so a category its stored lines prove came or
    // went since Generate is repaired in this same Update draft. Each line
    // left unkeyed (renamed before bar picks were tracked, or with no key
    // since) is the diff's bar_unchecked count, the card's notice, and is
    // rebuilt and keyed whatever else this applies.
    content.also_at_bar = keyBarLines(content.also_at_bar).lines;
    if (diff.bar_changed || diff.bar_unchecked > 0) {
      content.also_at_bar = refreshBarLines(content.also_at_bar, keyedBarLines(normalized.bar), diff.bar_changed_labels);
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
