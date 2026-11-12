// The menu draft read model: the GET /api/proposals/:id/menu-draft payload
// (spec 2026-10-01 sections 7, 8 and 9; 5.5, Stuck rule). Admin and manager only.
//
// readDraftPayload(proposalId) -> {
//   draft: null | { id, proposal_id, drink_plan_id, version, art_version,
//     inputs (reference_key replaced by has_reference), content, read_only,
//     created_at, updated_at },
//   pieces: [{ piece_key, status, error, reroll_note, has_image, image_rev, tone,
//     ground_rgb, provider, model, drawn_count, started_at, finished_at }],
//   brief: null | { theme, naming, notes, has_planner_image, planner_image_rev },
//   diff: null | { added: [{ key, name }], dropped: [{ key, name }],
//     brief_edited: ['theme' | 'naming' | 'notes'], image_changed, bar_changed,
//     bar_changed_labels: [label], bar_unchecked, dismissed },
//   print: { state, not_required_by, approved_at, approved_by_name, print_key,
//     approved_file_in_use },
//   cap: { used, limit, remaining, resets_at }, configured: { openai, gemini },
//   plan: null | { id, menu_style, drink_count, drinks: [{ name, mock }],
//     bar_summary: { beer_wine, spirits, na } },
// }
// Throws NotFoundError when the proposal does not exist.
//
// - No R2 key leaves here. A piece says has_image (done and stored) and the client
//   reads the layer from GET .../pieces/:pieceKey/image; the planner image is
//   likewise only brief.planner_image_rev (plannerImageRev, null with no image),
//   which the client posts back as Approve's expected_planner_image_rev for a
//   logo draft. image_rev is an opaque
//   16-hex digest of the stored key, non-null exactly when has_image is true and
//   new with every drawing (each one is a new uuid key), so the client can cache
//   layers by it. has_reference: the source is upload and a key is stored (GET
//   .../reference). print_key is the proposal's menu_print_key, which the admin
//   event page already carries and Approve posts back as expected_print_key.
// - Stuck rule: a piece, or the words step, that is pending or working with a
//   heartbeat older than MENU_ART_STALE_MS (default 300000) reads as failed with
//   error / words_error "interrupted". Ages are measured against the database
//   clock, the one that wrote the heartbeats.
// - diff is null without a draft or without a plan (a draft with no plan is
//   read_only). dropped names come from the draft's own display names.
//   dismissed is true when the current plan hash equals dismissed_plan_hash.
//   bar_changed is true when an "Also at the bar" line the plan would print
//   differs from its baseline (bar_lines), or a line appears or goes (spec
//   2026-10-19 section 17); bar_changed_labels names those lines by builder
//   label, for Update draft, and a stored keyed line the picks no longer
//   build reads as one of them, as does, once no unkeyed line is left, a
//   built category no stored line stands for. bar_unchecked counts the stored lines no key
//   can be found for (keyBarLines), renamed before bar picks were tracked or
//   with no key since, which nothing can check against the picks (lane
//   menu-bar-renamed-lines), with or without a stored baseline: never a
//   change, so it neither raises Plan changed nor undoes a dismissal; the card
//   says Update draft rebuilds them, and Update draft rebuilds exactly those.
//   A fingerprint with no bar_lines is read against the baseline the boot
//   stamp would give it (legacyBarBaseline), until the server stamps it at
//   boot (menuBarBaselineStamp.js) or Update draft writes one, so the card
//   shows what Update draft does. The read model writes nothing.
// - menu_style is selections.menuStyle ('custom' | 'house' | 'none') or null.
//   bar_summary counts the plan's bar picks for the phone's "+ 5 beer and wine,
//   3 spirits, 2 NA" line ("None" and "Other" picks are not counted).
//
// Print state: derivePrintState and PRINT_STATES (menuPrintState.js, spec 8).
//
// Polling cost: the catalog maps (two queries) are cached per process for 60
// seconds, so a 2-second poll does not reload them. A catalog drink created
// in the last minute can read as client-typed here until the cache turns over.
// Writers (Generate, sync, dismiss) never use this cache: they load fresh maps
// through their own client. computeDiff, barBaseline and dismissalHash (the
// hash a dismissal of the draft as it stands stores) are exported for them.

const { pool } = require('../db');
const { NotFoundError } = require('./errors');
const { readEnvInt } = require('./envInt');
const {
  loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, fingerprintHash, plannerImageRev, legacyBarBaseline,
} = require('./menuDrinkSource');
const { keyBarLines } = require('./menuAlsoAtBar');
const { capUsage } = require('./menuArtCap');
const { derivePrintState, PRINT_STATES } = require('./menuPrintState');
const openaiClient = require('./openaiClient');
const geminiClient = require('./geminiClient');

const STALE_MS_DEFAULT = 300000;
const CATALOG_TTL_MS = 60000;
const INTERRUPTED = 'interrupted';
const OPEN_STATUSES = new Set(['pending', 'working']);
const BRIEF_FIELDS = ['theme', 'naming', 'notes'];
const MENU_STYLES = new Set(['custom', 'house', 'none']);
const NOT_COUNTED = new Set(['none', 'other']);
// A bar baseline entry for a line renamed before bar picks were tracked (legacyBarBaseline).
const UNKEYED = 'unkeyed:';
// The draft columns computeDiff and derivePrintState read (internal only).
const DRAFT_STATE = ['version', 'art_version', 'approved_version', 'approved_art_version', 'approved_print_key',
  'approved_planner_image_key', 'inputs', 'content', 'plan_fingerprint', 'dismissed_plan_hash'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const asArray = (v) => (Array.isArray(v) ? v : []);
const toMs = (v) => (v instanceof Date ? v.getTime() : (typeof v === 'string' || typeof v === 'number') ? new Date(v).getTime() : NaN);
const toIso = (v) => { const ms = toMs(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

function readStaleMs() {
  return readEnvInt('MENU_ART_STALE_MS', STALE_MS_DEFAULT);
}

// A piece row ({ status, heartbeat_at }) or the words step ({ words_status,
// words_heartbeat_at }, i.e. the draft content). An open row with no readable
// heartbeat is stuck: nothing will ever refresh it.
function stuck(row, now = Date.now(), staleMs = readStaleMs()) {
  if (!isObject(row)) return false;
  const status = row.status !== undefined ? row.status : row.words_status;
  if (!OPEN_STATUSES.has(status)) return false;
  const beat = toMs(row.heartbeat_at !== undefined ? row.heartbeat_at : row.words_heartbeat_at);
  if (!Number.isFinite(beat)) return true;
  return toMs(now) - beat > staleMs;
}

let catalogCache = null;
function cachedCatalogMaps(now = Date.now()) {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.promise;
  const entry = { at: now, promise: loadCatalogMaps(pool) };
  catalogCache = entry;
  entry.promise.catch(() => { if (catalogCache === entry) catalogCache = null; });
  return entry.promise;
}
function _resetCatalogCacheForTest() {
  catalogCache = null;
}

// The staleness diff (spec 9) of a stored draft ({ plan_fingerprint, content,
// dismissed_plan_hash }) against a normalized plan. Pure.
// The bar, line by line: each builder label's built hash against its baseline,
// plus a label that appears or goes. The baseline is the stored bar_lines, or
// for a fingerprint with none (every draft made before them, and a dev draft
// carrying only an earlier bar_hash) the one the boot stamp would give it,
// legacyBarBaseline over the stored lines (lane menu-bar-renamed-lines), so the
// GET and Update draft read one diff. A stored line keyed (keyBarLines, the
// rule Update draft keys by) to a category the picks no longer build reads
// gone too, whatever the baseline says, and once no unkeyed line is left a
// built category no stored line stands for reads new, whatever the baseline
// says (the mirror: lines are written only by the words step and Update
// draft, so such a category was never built). bar_unchecked counts the stored lines
// keyBarLines leaves unkeyed, whatever the baseline holds, so a line renamed
// with no key after the stamp is counted and one renamed back to its builder
// label is not; an unkeyed:<place> baseline entry is never a change.
// bar_changed and its labels name builder labels only. The GET itself writes
// nothing.
// Dismissed: the hash matches the dismissal hash of the draft as it stands
// (dismissalHash: the current fingerprint and the bar drift), or the current
// fingerprint with no bar (a dismissal stored before the deploy hashed none,
// and fingerprintHash keeps that hash), but that one only while the bar has
// not changed: a bar-less dismissal cannot have covered a bar change, while an
// unchecked line is no change, so it never undoes one. The drift is the keys
// where the stored lines and the baseline disagree, which no bar_hash shows: a
// stored keyed line the picks no longer build that the baseline does not name
// (one renamed back to its builder label after the stamp), and, once no
// unkeyed line is left, a built category no stored line stands for that the
// baseline reads unchanged (the stamp took today's picks for it beside a
// renamed line since renamed back; the chain verify pass's M1). Each reads
// changed and joins the dismissal hash, so a dismissal stored before it never
// covers it and one stored after it does (lane menu-bar-rebuild-only). A
// dismissal stored since the deploy hashes the bar, so a later bar move undoes
// it; either way the banner comes back with bar_changed saying why.
function barBaseline(stored, content, normalized) {
  if (isObject(stored) && isObject(stored.bar_lines)) return stored.bar_lines;
  return legacyBarBaseline(isObject(content) ? content.also_at_bar : undefined, normalized).bar_lines;
}

function barChangedLabels(before, now) {
  return [
    ...Object.keys(now).filter((label) => !hasOwn(before, label) || before[label] !== now[label]),
    ...Object.keys(before).filter((label) => !label.startsWith(UNKEYED) && !hasOwn(now, label)),
  ];
}

// The bar half of the diff, against `current` (buildFingerprint(normalized)):
// { changed: [builder label], drift: [builder label], unchecked }. drift is the
// part of changed only the stored lines show (above).
function barState(stored, content, normalized, current) {
  const listed = Array.isArray(content.also_at_bar);
  const lines = keyBarLines(listed ? content.also_at_bar : []);
  const changed = barChangedLabels(barBaseline(stored, content, normalized), current.bar_lines);
  const drift = [];
  const mark = (key) => { changed.push(key); drift.push(key); };
  const keyed = new Set();
  for (const line of lines.lines) {
    const key = isObject(line) && typeof line.key === 'string' ? line.key : '';
    if (!key) continue;
    keyed.add(key);
    if (!hasOwn(current.bar_lines, key) && !changed.includes(key)) mark(key);
  }
  if (listed && lines.unkeyed === 0) {
    for (const key of Object.keys(current.bar_lines)) if (!keyed.has(key) && !changed.includes(key)) mark(key);
  }
  return { changed, drift, unchecked: lines.unkeyed };
}

function computeDiff(draft, normalized) {
  if (!isObject(draft) || !normalized) return null;
  const stored = isObject(draft.plan_fingerprint) ? draft.plan_fingerprint : {};
  const current = buildFingerprint(normalized);
  const content = isObject(draft.content) ? draft.content : {};
  const bar = barState(stored, content, normalized, current);
  const barChanged = bar.changed.length > 0;
  const dismissedHash = typeof draft.dismissed_plan_hash === 'string' ? draft.dismissed_plan_hash : null;
  const storedKeys = asArray(stored.drink_keys).map(String);
  const storedSet = new Set(storedKeys);
  const currentSet = new Set(current.drink_keys);
  const names = new Map();
  for (const d of asArray(content.drinks)) {
    if (isObject(d) && typeof d.key === 'string' && typeof d.display_name === 'string' && d.display_name) {
      names.set(d.key, d.display_name);
    }
  }
  const storedFields = isObject(stored.brief_fields) ? stored.brief_fields : {};
  return {
    added: normalized.drinks.filter((d) => !storedSet.has(d.key)).map((d) => ({ key: d.key, name: d.name })),
    dropped: storedKeys.filter((k) => !currentSet.has(k)).map((key) => ({ key, name: names.get(key) || key })),
    brief_edited: BRIEF_FIELDS.filter((f) => storedFields[f] !== current.brief_fields[f]),
    image_changed: (stored.planner_image_key || null) !== (current.planner_image_key || null),
    bar_changed: barChanged,
    bar_changed_labels: bar.changed,
    bar_unchecked: bar.unchecked,
    dismissed: dismissedHash !== null && (dismissedHash === fingerprintHash({ ...current, bar_drift: bar.drift })
      || (!barChanged && dismissedHash === fingerprintHash({ ...current, bar_hash: null }))),
  };
}

// The hash a Dismiss or Mark reviewed of the stored draft ({ plan_fingerprint,
// content }) stores against a normalized plan: the current fingerprint and the
// bar drift, the one computeDiff's dismissed matches. Pure.
function dismissalHash(draft, normalized) {
  const d = isObject(draft) ? draft : {};
  const stored = isObject(d.plan_fingerprint) ? d.plan_fingerprint : {};
  const content = isObject(d.content) ? d.content : {};
  const current = buildFingerprint(normalized);
  return fingerprintHash({ ...current, bar_drift: barState(stored, content, normalized, current).drift });
}

function barSummary(bar) {
  const b = isObject(bar) ? bar : {};
  const count = (list) => asArray(list)
    .filter((v) => typeof v === 'string' && v.trim() && !NOT_COUNTED.has(v.trim().toLowerCase())).length;
  return { beer_wine: count(b.beer) + count(b.wine), spirits: count(b.spirits), na: count(b.na) };
}

function planPayload(planRow, normalized) {
  if (!planRow || !normalized) return null;
  const style = isObject(planRow.selections) ? planRow.selections.menuStyle : null;
  const drinks = normalized.drinks.map((d) => ({ name: d.name, mock: d.group === 'mock' }));
  return {
    id: planRow.id,
    menu_style: MENU_STYLES.has(style) ? style : null,
    drink_count: drinks.length,
    drinks,
    bar_summary: barSummary(normalized.bar),
  };
}

// A PATCH to reference_source none or planner keeps the stored key (only
// Generate writes it), so has_reference needs the source to be upload too.
function publicInputs(inputs) {
  const { reference_key: referenceKey, ...rest } = isObject(inputs) ? inputs : {};
  return { ...rest, has_reference: rest.reference_source === 'upload' && typeof referenceKey === 'string' && referenceKey !== '' };
}

function publicContent(content, now, staleMs) {
  const out = { ...(isObject(content) ? content : {}) };
  if (stuck(out, now, staleMs)) {
    out.words_status = 'failed';
    out.words_error = INTERRUPTED;
  }
  return out;
}

function publicPiece(piece, now, staleMs) {
  const isStuck = stuck(piece, now, staleMs);
  return {
    piece_key: piece.piece_key,
    status: isStuck ? 'failed' : piece.status,
    error: isStuck ? INTERRUPTED : piece.error,
    reroll_note: piece.reroll_note,
    has_image: piece.has_image === true,
    image_rev: piece.has_image === true && typeof piece.image_rev === 'string' ? piece.image_rev : null,
    tone: piece.tone,
    ground_rgb: piece.ground_rgb,
    provider: piece.provider,
    model: piece.model,
    drawn_count: piece.drawn_count,
    started_at: toIso(piece.started_at),
    finished_at: toIso(piece.finished_at),
  };
}

// One statement, so the draft and its pieces come from one snapshot (a
// Generate committing between two reads would pair a run with the wrong
// pieces). r2_key is reduced to has_image and image_rev inside the query: true
// (and a digest) only for a done piece with a key, the one the image route will
// send (a piece pending a re-roll keeps its old r2_key until the new art lands,
// and the route 404s it).
const DRAFT_SQL = `
  SELECT p.id AS proposal_id, p.menu_print_key, p.menu_not_required, p.menu_not_required_by, NOW() AS db_now,
         d.id AS draft_id, d.drink_plan_id, d.inputs, d.content, d.plan_fingerprint,
         d.dismissed_plan_hash, d.version, d.art_version, d.approved_version,
         d.approved_art_version, d.approved_print_key, d.approved_planner_image_key,
         d.approved_at, d.created_at, d.updated_at,
         COALESCE(cp.display_name, cp.preferred_name, u.email) AS approved_by_name,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'piece_key', mp.piece_key, 'status', mp.status, 'error', mp.error,
                    'reroll_note', mp.reroll_note, 'has_image', mp.status = 'done' AND mp.r2_key IS NOT NULL,
                    'image_rev', CASE WHEN mp.status = 'done' AND mp.r2_key IS NOT NULL
                      THEN left(encode(sha256(convert_to('rev:' || mp.r2_key, 'UTF8')), 'hex'), 16) END,
                    'heartbeat_at', mp.heartbeat_at, 'started_at', mp.started_at,
                    'finished_at', mp.finished_at, 'tone', mp.tone, 'ground_rgb', mp.ground_rgb,
                    'provider', mp.provider, 'model', mp.model, 'drawn_count', mp.drawn_count)
                  ORDER BY (mp.piece_key = 'background') DESC, mp.id)
             FROM menu_draft_pieces mp
            WHERE mp.draft_id = d.id), '[]'::json) AS pieces
    FROM proposals p
    LEFT JOIN menu_drafts d ON d.proposal_id = p.id
    LEFT JOIN users u ON u.id = d.approved_by
    LEFT JOIN contractor_profiles cp ON cp.user_id = d.approved_by
   WHERE p.id = $1`;

async function readDraftPayload(proposalId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new NotFoundError('Proposal not found.');
  const [result, planRow, cap, maps] = await Promise.all([
    pool.query(DRAFT_SQL, [id]),
    loadEventPlan(id, pool),
    capUsage(pool),
    cachedCatalogMaps(),
  ]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Proposal not found.');

  const now = row.db_now || new Date();
  const staleMs = readStaleMs();
  const normalized = planRow ? normalizePlan(planRow, maps) : null;
  const hasDraft = row.draft_id !== null && row.draft_id !== undefined;
  const draftRow = hasDraft ? Object.fromEntries(DRAFT_STATE.map((k) => [k, row[k]])) : null;
  const printKey = row.menu_print_key || null;

  return {
    draft: hasDraft ? {
      id: row.draft_id,
      proposal_id: row.proposal_id,
      drink_plan_id: row.drink_plan_id,
      version: row.version,
      art_version: row.art_version,
      inputs: publicInputs(row.inputs),
      content: publicContent(row.content, now, staleMs),
      read_only: !planRow,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } : null,
    pieces: asArray(row.pieces).filter(isObject).map((p) => publicPiece(p, now, staleMs)),
    brief: normalized ? {
      ...normalized.brief,
      has_planner_image: Boolean(normalized.plannerImageKey),
      planner_image_rev: plannerImageRev(normalized.plannerImageKey),
    } : null,
    diff: computeDiff(draftRow, normalized),
    print: {
      state: derivePrintState({
        menuPrintKey: printKey,
        menuNotRequired: row.menu_not_required === true,
        draft: draftRow,
        plannerImageKey: normalized ? normalized.plannerImageKey : null,
      }),
      // Who set the no-menu mark ('admin' | 'planner' | null; spec 2026-10-19
      // section 15): the card says so for a planner mark.
      not_required_by: row.menu_not_required === true ? row.menu_not_required_by || null : null,
      approved_at: hasDraft ? row.approved_at || null : null,
      approved_by_name: hasDraft ? row.approved_by_name || null : null,
      print_key: printKey,
      approved_file_in_use: Boolean(hasDraft && printKey && printKey === row.approved_print_key),
    },
    cap,
    configured: { openai: openaiClient.isConfigured(), gemini: geminiClient.isConfigured() },
    plan: planPayload(planRow, normalized),
  };
}

module.exports = {
  readDraftPayload,
  stuck,
  readStaleMs,
  computeDiff,
  barBaseline,
  dismissalHash,
  derivePrintState,
  cachedCatalogMaps,
  PRINT_STATES,
  INTERRUPTED,
  STALE_MS_DEFAULT,
  _resetCatalogCacheForTest,
};
