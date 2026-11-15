// The menu draft read model: the GET /api/proposals/:id/menu-draft payload
// (spec 2026-10-01 sections 7, 8 and 9; 5.5, Stuck rule). Admin and manager only.
//
// readDraftPayload(proposalId) -> {
//   draft: null | { id, proposal_id, drink_plan_id, version, art_version,
//     inputs (reference_key replaced by has_reference), content, read_only,
//     auto_started (the current run is the drink plan submit's auto-start,
//     menu_auto_starts.run_id; spec 2026-10-19 section 14), created_at, updated_at },
//   pieces: [{ piece_key, status, error, reroll_note, has_image, image_rev, tone,
//     ground_rgb, provider, model, drawn_count, started_at, finished_at }],
//   brief: null | { theme, naming, notes, has_planner_image, planner_image_rev },
//   diff: null | { added: [{ key, name }], dropped: [{ key, name }],
//     brief_edited: ['theme' | 'naming' | 'notes'], image_changed, bar_changed,
//     bar_changed_labels: [label], bar_unchecked, dismissed, plan_hash },
//   print: { state, held, live, restorable, not_required_by, approved_at,
//     approved_by_name, approved_version, approved_art_version, released_at,
//     released_via, released_by_name, print_key, approved_file_in_use },
//   proof: null | { id, state, version, art_version, url, sent_at, sent_to,
//     email_status, expires_at, expired, event_passed, answer, answer_note, answered_at,
//     withdrawn_at, stale, history: [{ id, version, art_version, sent_at,
//     state, answer, answer_note, answered_at, withdrawn_at, superseded_at }] },
//   cap: { used, limit, remaining, resets_at },
//   configured: { openai, gemini, words, default_image_model },
//   plan: null | { id, menu_style, drink_count, drinks: [{ name, mock }],
//     bar_summary: { beer_wine, spirits, na }, side: 'planner' | 'consult',
//     house_plain,
//     planner_reference: { drinks: [{ name, mock, typed }], bar: [line],
//       additional_notes, mocktail_notes } },
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
//   It is shownDiff: what is left after the recorded review (spec 2026-10-19
//   section 17, lane menu-plan-review-state). Dismiss and Mark reviewed fold
//   the plan's brief and image parts into plan_fingerprint, so brief_edited
//   and image_changed read against the last reviewed ones; Dismiss also stores
//   the review hash (dismissalHash), and while it holds, added, dropped and
//   bar_changed read empty and dismissed is true unless a notes or image flag
//   is left to show. A dismissal stored before the lane (the old whole-plan
//   hash) still reads as covering everything while the plan has not moved.
//   The routes read the plan itself (computeDiff, the raw lists), never this.
//   plan_hash is the draft's plan hash for the plan read here (draftPlanHash:
//   planHash on a custom draft), which Dismiss, Mark reviewed and Update
//   draft send back; the catalog maps behind it may be up to a
//   minute old (Polling cost below), so a refusal drops them (dropCatalogCache).
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
//   A house draft (content.look house; spec 2026-10-19 sections 9.2 and 17)
//   prints its bar sections, never the "Also at the bar" lines, so its bar
//   half reads the sections the card prints, through the one helper the fill
//   and Update draft stamp with (menuHouseSections.draftFingerprint, built
//   from the plan row): a spirit or any pick the card does not print never
//   raises bar_changed or undoes a dismissal, and nothing is ever unchecked.
//   Its plan_hash is over the same form (draftPlanHash), so a spirit moved
//   while the page is open never refuses a write as MENU_PLAN_MOVED.
// - menu_style is selections.menuStyle ('custom' | 'house' | 'none') or null.
//   house_plain (spec 2026-10-19 section 9.2; lane menu-house-card) is whether
//   the event's touch set is the plain house card (menuEventTouches
//   touchSetFor on the proposal's event_type, event_type_custom and
//   event_date read as text, never a JS Date), so the Generate gate asks only
//   for the keys the look will use: none for a plain house card, the image
//   model's for one with touches.
//   bar_summary counts the plan's bar picks for the phone's "+ 5 beer and wine,
//   3 spirits, 2 NA" line ("None" and "Other" picks are not counted).
// - side is the side the menu's drinks come from (normalizePlan's side: the
//   one the shopping list uses). planner_reference (spec 2026-10-19 section
//   7.1) is the planner's own picks whichever side that is, for the Brief
//   tab's From the planner box: the selections normalized as the planner side
//   (drinks with mock, and typed when the client typed the name), the bar as
//   the menu's labelled lines ("<LINE_LABELS label>: <text>", buildAlsoAtBar),
//   so the client needs no label table, and selections.additionalNotes and
//   mocktailNotes, trimmed, each cut to 2,000 characters, null when empty. It
//   is display only: it never joins the brief, and nothing in it reaches a
//   provider (the words request, the background prompt and a re-roll are
//   built from normalizePlan and inputs alone).
//
// - configured (spec 2026-10-19 section 16, lane menu-words-claude): openai
//   and gemini are each provider's key; words is the key of the provider the
//   words call will use (wordsConfigured: the current words model's,
//   menuArtJobSteps.textProvider), which Generate and Update draft's words
//   call check; default_image_model (defaultImageModel) is 'gemini' when its
//   key is set, else 'openai', computed here once for the editor's toggle and
//   the card's actions. The routes check through the same two functions.
//
// Print state: readPrintState, derivePrintState and PRINT_STATES
// (menuPrintState.js, spec 8 as amended by spec 2026-10-19 section 10.3). The
// print and proof blocks (spec 2026-10-19 sections 10.5 and 14; lane
// menu-approve-send) are built by printBlock and proofBlock, the one pair of
// builders the GET and the Approve, release and Close request responses share
// (readReviewBlocks re-reads them after those writes commit):
// - print.held is the held state (an approved file waiting on its release);
//   live says whether staff still have an older released file ('previous')
//   or nothing ('none'); restorable is the removed state, where Put it back
//   for staff applies; approved_version and approved_art_version are the pair
//   Release posts back. released_* name the recorded release, and for a menu
//   approved under v1 whose file is live (no release recorded) they read the
//   approval, released by the admin (spec 10.3).
// - proof is the draft's latest proof (superseded_at IS NULL), null with
//   none: its page state (menuProofs.proofState), url the client's link
//   (menuProofUrl, an admin-only payload), the email's outcome, with a proof
//   still pending PENDING_STALE_MS after sent_at read as failed (the process
//   died before the send), expires_at the link's end (computed live),
//   event_passed whether the event day is before today in Chicago (the public
//   page's own comparison, menuProofs; false with no date), stale
//   when the draft's pair moved since the proof, and history every earlier
//   proof of the draft, newest first, notes in full, for the Brief tab.
//
// Polling cost: the catalog maps (two queries) are cached per process for 60
// seconds, so a 2-second poll does not reload them. A catalog drink created
// in the last minute can read as client-typed here until the cache turns over.
// Writers (Generate, sync, dismiss) never use this cache: they load fresh maps
// through their own client, and a MENU_PLAN_MOVED refusal drops it
// (dropCatalogCache) so the page's refetch reads what the route read.
// computeDiff, reviewOf, barBaseline and dismissalHash (the review hash a
// Dismiss of the draft as it stands stores) are exported for them.

const { pool } = require('../db');
const { NotFoundError } = require('./errors');
const { readEnvInt } = require('./envInt');
const {
  loadEventPlan, loadCatalogMaps, normalizePlan, fingerprintHash, reviewHash, plannerImageRev,
  plannerImageKeyOf, legacyBarBaseline,
} = require('./menuDrinkSource');
const { keyBarLines, buildAlsoAtBar } = require('./menuAlsoAtBar');
const { draftFingerprint, draftPlanHash } = require('./menuHouseSections');
const { capUsage } = require('./menuArtCap');
const { derivePrintState, readPrintState, PRINT_STATES } = require('./menuPrintState');
const { loadLatestProof, loadProofHistory } = require('./menuProofs');
const { menuProofUrl } = require('./urls');
const { textProvider } = require('./menuArtJobSteps');
const { touchSetFor } = require('./menuEventTouches');
const openaiClient = require('./openaiClient');
const geminiClient = require('./geminiClient');
const anthropicClient = require('./anthropicClient');

const STALE_MS_DEFAULT = 300000;
const CATALOG_TTL_MS = 60000;
const INTERRUPTED = 'interrupted';
const OPEN_STATUSES = new Set(['pending', 'working']);
const BRIEF_FIELDS = ['theme', 'naming', 'notes'];
const MENU_STYLES = new Set(['custom', 'house', 'none']);
const NOT_COUNTED = new Set(['none', 'other']);
// planner_reference's notes are cut to this for display.
const NOTES_MAX = 2000;
// A bar baseline entry for a line renamed before bar picks were tracked (legacyBarBaseline).
const UNKEYED = 'unkeyed:';
// The draft columns computeDiff and derivePrintState read (internal only).
const DRAFT_STATE = ['version', 'art_version', 'approved_version', 'approved_art_version', 'approved_print_key',
  'approved_planner_image_key', 'released_print_key', 'inputs', 'content', 'plan_fingerprint', 'dismissed_plan_hash'];
// A proof still pending this long after sent_at reads as failed (spec 10.2 step 5).
const PENDING_STALE_MS = 10 * 60 * 1000;
// The form of a dismissed_plan_hash that holds (reviewOf): the review hash a
// Dismiss stores since lane menu-plan-review-state, or the old whole-plan hash.
// Exported as DISMISSAL, so the bar-only rebuild compares the one constant.
const REVIEWED = 'review';
const WHOLE = 'whole';
const DISMISSAL = Object.freeze({ REVIEWED, WHOLE });

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
// A MENU_PLAN_MOVED refusal drops the cache (menuDraftShared.requireSamePlan),
// so the page's refetch reads the catalog the refusing route read.
function dropCatalogCache() {
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
// Dismissed: a dismissal holds over the drinks and the bar. Since lane
// menu-plan-review-state a Dismiss stores the review form (dismissalHash:
// reviewHash over the current drink keys, bar hash and bar drift), which a
// notes edit or a new client image never undoes. A dismissal stored before it
// is the old whole-plan form, which still holds exactly as it always did: the
// current fingerprint and the bar drift, or the current fingerprint with no
// bar (a dismissal stored before the bar deploy hashed none, and
// fingerprintHash keeps that hash), but that one only while the bar has not
// changed: a bar-less dismissal cannot have covered a bar change, while an
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

// The bar half of the diff, against `current` (draftFingerprint: on a custom
// draft buildFingerprint(normalized)): { changed: [builder label], drift:
// [builder label], unchecked }. drift is the part of changed only the stored
// lines show (above). A house draft prints its bar sections, never the "Also
// at the bar" lines, so its stored house baseline is read section by section
// against the current one ('house:<title>' keys), with no drift and nothing
// unchecked; one with no baseline stored reads as unchanged.
function barState(stored, content, normalized, current) {
  if (content.look === 'house') {
    const before = isObject(stored.bar_lines) ? stored.bar_lines : current.bar_lines;
    return { changed: barChangedLabels(before, current.bar_lines), drift: [], unchecked: 0 };
  }
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

// The form of the stored dismissal that holds over the drinks and the bar
// (header): REVIEWED, WHOLE (the old form) or null.
function dismissalForm(dismissedHash, current, bar) {
  if (dismissedHash === null) return null;
  if (dismissedHash === reviewHash({ ...current, bar_drift: bar.drift })) return REVIEWED;
  if (dismissedHash === fingerprintHash({ ...current, bar_drift: bar.drift })) return WHOLE;
  if (bar.changed.length === 0 && dismissedHash === fingerprintHash({ ...current, bar_hash: null })) return WHOLE;
  return null;
}

// The review state of a stored draft against a normalized plan. Pure. -> null
// without a draft or a plan, else { diff, dismissal }: diff is computeDiff's,
// dismissal the form of the stored dismissal that holds ('review', 'whole' for
// the old form, or null). The bar-only rebuild reads the form; the GET's
// shownDiff presents the diff after it. plan is the plan row normalized came
// from, which a house draft's bar sections are built from (draftFingerprint);
// every caller passes it, and a custom draft never reads it.
function reviewOf(draft, normalized, plan = null) {
  if (!isObject(draft) || !normalized) return null;
  const stored = isObject(draft.plan_fingerprint) ? draft.plan_fingerprint : {};
  const content = isObject(draft.content) ? draft.content : {};
  const current = draftFingerprint(content, plan, normalized);
  const bar = barState(stored, content, normalized, current);
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
  const dismissal = dismissalForm(dismissedHash, current, bar);
  return {
    diff: {
      added: normalized.drinks.filter((d) => !storedSet.has(d.key)).map((d) => ({ key: d.key, name: d.name })),
      dropped: storedKeys.filter((k) => !currentSet.has(k)).map((key) => ({ key, name: names.get(key) || key })),
      brief_edited: BRIEF_FIELDS.filter((f) => storedFields[f] !== current.brief_fields[f]),
      image_changed: (stored.planner_image_key || null) !== (current.planner_image_key || null),
      bar_changed: bar.changed.length > 0,
      bar_changed_labels: bar.changed,
      bar_unchecked: bar.unchecked,
      dismissed: dismissal !== null,
    },
    dismissal,
  };
}

// The raw diff (header): every drink and bar change since the stored
// fingerprint, and dismissed when a dismissal (either form) holds over them.
// Update draft and the boot stamp read it; the GET shows shownDiff.
function computeDiff(draft, normalized, plan = null) {
  const review = reviewOf(draft, normalized, plan);
  return review ? review.diff : null;
}

// The GET's diff: what is left after the recorded review (spec 2026-10-19
// section 17), plus plan_hash (draftPlanHash, the plan-hash echo). A review-form
// dismissal hides the drink and bar changes it covers; the notes and the image
// read against the stored parts, and dismissed is true only when neither is
// left to show, so the notes banner shows alone. An old-form dismissal reads,
// as it always did, as covering everything, the notes included. bar_unchecked
// passes through: no review covers it. Pure; null without a draft or a plan.
function shownDiff(draft, normalized, plan = null) {
  const review = reviewOf(draft, normalized, plan);
  if (!review) return null;
  const shown = { ...review.diff, plan_hash: draftPlanHash(draft.content, plan, normalized) };
  if (review.dismissal !== REVIEWED) return shown;
  const left = shown.brief_edited.length > 0 || shown.image_changed;
  return { ...shown, added: [], dropped: [], bar_changed: false, bar_changed_labels: [], dismissed: !left };
}

// The hash a Dismiss of the stored draft ({ plan_fingerprint, content })
// stores against a normalized plan: the review form, reviewHash over the
// current drink keys, the bar hash and the bar drift, the one reviewOf reads
// as 'review'. Pure. plan as for reviewOf: a house draft's bar hash is its
// printed sections', so a spirit never undoes its dismissal.
function dismissalHash(draft, normalized, plan = null) {
  const d = isObject(draft) ? draft : {};
  const stored = isObject(d.plan_fingerprint) ? d.plan_fingerprint : {};
  const content = isObject(d.content) ? d.content : {};
  const current = draftFingerprint(content, plan, normalized);
  return reviewHash({ ...current, bar_drift: barState(stored, content, normalized, current).drift });
}

function barSummary(bar) {
  const b = isObject(bar) ? bar : {};
  const count = (list) => asArray(list)
    .filter((v) => typeof v === 'string' && v.trim() && !NOT_COUNTED.has(v.trim().toLowerCase())).length;
  return { beer_wine: count(b.beer) + count(b.wine), spirits: count(b.spirits), na: count(b.na) };
}

// A planner note for display: trimmed, cut to NOTES_MAX without splitting an
// emoji, null when it is not text or is empty.
function displayNote(value) {
  if (typeof value !== 'string') return null;
  let t = value.trim();
  if (t.length > NOTES_MAX) {
    t = t.slice(0, NOTES_MAX);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t || null;
}

// The planner's own picks and notes (header). A planner-side plan is already
// normalized from them; a consult-side one is normalized again as the planner.
function plannerReference(planRow, normalized, maps) {
  const planner = normalized.side === 'planner' ? normalized
    : normalizePlan({ ...planRow, shopping_list_source: 'planner' }, maps);
  const sel = isObject(planRow.selections) ? planRow.selections : {};
  return {
    drinks: planner.drinks.map((d) => ({ name: d.name, mock: d.group === 'mock', typed: d.typed_name !== null })),
    bar: buildAlsoAtBar(planner.bar).map((line) => `${line.label}: ${line.text}`),
    additional_notes: displayNote(sel.additionalNotes),
    mocktail_notes: displayNote(sel.mocktailNotes),
  };
}

function planPayload(planRow, normalized, maps, event) {
  if (!planRow || !normalized) return null;
  const style = isObject(planRow.selections) ? planRow.selections.menuStyle : null;
  const drinks = normalized.drinks.map((d) => ({ name: d.name, mock: d.group === 'mock' }));
  return {
    id: planRow.id,
    menu_style: MENU_STYLES.has(style) ? style : null,
    drink_count: drinks.length,
    drinks,
    bar_summary: barSummary(normalized.bar),
    side: normalized.side,
    house_plain: touchSetFor(event).plain,
    planner_reference: plannerReference(planRow, normalized, maps),
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
         p.event_type, p.event_type_custom, p.event_date::text AS event_date,
         d.id AS draft_id, d.drink_plan_id, d.inputs, d.content, d.plan_fingerprint,
         d.dismissed_plan_hash, d.version, d.art_version, d.approved_version,
         d.approved_art_version, d.approved_print_key, d.approved_planner_image_key,
         d.approved_at, d.created_at, d.updated_at,
         d.released_print_key, d.released_at, d.released_via,
         EXISTS (SELECT 1 FROM menu_auto_starts a WHERE a.proposal_id = p.id AND a.run_id = d.run_id) AS auto_started,
         COALESCE(cp.display_name, cp.preferred_name, u.email) AS approved_by_name,
         COALESCE(rcp.display_name, rcp.preferred_name, ru.email) AS released_by_name,
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
    LEFT JOIN users ru ON ru.id = d.released_by
    LEFT JOIN contractor_profiles rcp ON rcp.user_id = d.released_by
   WHERE p.id = $1`;

// The print and proof blocks' own read (readReviewBlocks), for a write's
// response after its commit: the same columns as DRAFT_SQL, no pieces.
const REVIEW_SQL = `
  SELECT p.id AS proposal_id, p.menu_print_key, p.menu_not_required, p.menu_not_required_by,
         d.id AS draft_id, d.inputs, d.version, d.art_version, d.approved_version,
         d.approved_art_version, d.approved_print_key, d.approved_planner_image_key, d.approved_at,
         d.released_print_key, d.released_at, d.released_via,
         COALESCE(cp.display_name, cp.preferred_name, u.email) AS approved_by_name,
         COALESCE(rcp.display_name, rcp.preferred_name, ru.email) AS released_by_name
    FROM proposals p
    LEFT JOIN menu_drafts d ON d.proposal_id = p.id
    LEFT JOIN users u ON u.id = d.approved_by
    LEFT JOIN contractor_profiles cp ON cp.user_id = d.approved_by
    LEFT JOIN users ru ON ru.id = d.released_by
    LEFT JOIN contractor_profiles rcp ON rcp.user_id = d.released_by
   WHERE p.id = $1`;

const hasDraftRow = (row) => row.draft_id !== null && row.draft_id !== undefined;

// The print block (header) from a DRAFT_SQL or REVIEW_SQL row.
function printBlock(row, { latestProof = null, plannerImageKey = null } = {}) {
  const hasDraft = hasDraftRow(row);
  const printKey = row.menu_print_key || null;
  const { state, live } = readPrintState({
    menuPrintKey: printKey,
    menuNotRequired: row.menu_not_required === true,
    draft: hasDraft ? Object.fromEntries(DRAFT_STATE.map((k) => [k, row[k]])) : null,
    plannerImageKey,
    latestProof,
  });
  const releasedKey = hasDraft ? row.released_print_key || null : null;
  const v1Live = hasDraft && !releasedKey && Boolean(row.approved_print_key) && printKey === row.approved_print_key;
  const pick = (released, v1) => (releasedKey ? released || null : v1Live ? v1 || null : null);
  return {
    state,
    held: state === PRINT_STATES.HELD,
    live,
    restorable: state === PRINT_STATES.REMOVED,
    // Who set the no-menu mark ('admin' | 'planner' | null; spec 2026-10-19
    // section 15): the card says so for a planner mark.
    not_required_by: row.menu_not_required === true ? row.menu_not_required_by || null : null,
    approved_at: hasDraft ? row.approved_at || null : null,
    approved_by_name: hasDraft ? row.approved_by_name || null : null,
    approved_version: hasDraft && Number.isInteger(row.approved_version) ? row.approved_version : null,
    approved_art_version: hasDraft && Number.isInteger(row.approved_art_version) ? row.approved_art_version : null,
    released_at: pick(row.released_at, row.approved_at),
    released_via: pick(row.released_via, 'admin'),
    released_by_name: pick(row.released_by_name, row.approved_by_name),
    print_key: printKey,
    approved_file_in_use: Boolean(hasDraft && printKey && printKey === row.approved_print_key),
  };
}

// One proof row as the history lists it.
function historyEntry(p) {
  return {
    id: p.id, version: p.version, art_version: p.art_version, sent_at: p.sent_at, state: p.state,
    answer: p.answer || null, answer_note: p.answer_note || null, answered_at: p.answered_at || null,
    withdrawn_at: p.withdrawn_at || null, superseded_at: p.superseded_at || null,
  };
}

// The proof block (header) from loadLatestProof's row and loadProofHistory's
// rows, against the draft's current pair.
function proofBlock(latest, history, row) {
  if (!latest) return null;
  const sentMs = toMs(latest.sent_at);
  const pendingFailed = latest.email_status === 'pending' && Number.isFinite(sentMs)
    && toMs(latest.db_now || new Date()) - sentMs > PENDING_STALE_MS;
  return {
    ...historyEntry(latest),
    url: menuProofUrl(latest.token),
    sent_to: latest.sent_to || null,
    email_status: pendingFailed ? 'failed' : latest.email_status,
    expires_at: latest.link_end || null,
    expired: latest.expired === true,
    event_passed: latest.event_passed === true,
    stale: latest.version !== row.version || latest.art_version !== row.art_version,
    history: asArray(history).filter((p) => p.id !== latest.id).map(historyEntry),
  };
}

// The draft's latest proof and its history, or nulls with no draft.
async function loadProofs(row, db) {
  if (!hasDraftRow(row)) return { latest: null, history: [] };
  const [latest, history] = await Promise.all([loadLatestProof(db, row.draft_id), loadProofHistory(db, row.draft_id)]);
  return { latest, history };
}

/**
 * The GET's proof and print blocks for proposal `proposalId`, read fresh (a
 * write's response, after its commit and its client's release). Throws
 * NotFoundError when the proposal does not exist.
 */
async function readReviewBlocks(proposalId, db = pool) {
  const [result, planRow] = await Promise.all([db.query(REVIEW_SQL, [proposalId]), loadEventPlan(proposalId, db)]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Proposal not found.');
  const { latest, history } = await loadProofs(row, db);
  return {
    proof: proofBlock(latest, history, row),
    print: printBlock(row, { latestProof: latest, plannerImageKey: plannerImageKeyOf(planRow) }),
  };
}

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
  const hasDraft = hasDraftRow(row);
  const draftRow = hasDraft ? Object.fromEntries(DRAFT_STATE.map((k) => [k, row[k]])) : null;
  const { latest, history } = await loadProofs(row, pool);

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
      auto_started: row.auto_started === true,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } : null,
    pieces: asArray(row.pieces).filter(isObject).map((p) => publicPiece(p, now, staleMs)),
    brief: normalized ? {
      ...normalized.brief,
      has_planner_image: Boolean(normalized.plannerImageKey),
      planner_image_rev: plannerImageRev(normalized.plannerImageKey),
    } : null,
    diff: shownDiff(draftRow, normalized, planRow),
    print: printBlock(row, { latestProof: latest, plannerImageKey: normalized ? normalized.plannerImageKey : null }),
    proof: proofBlock(latest, history, row),
    cap,
    configured: {
      openai: openaiClient.isConfigured(),
      gemini: geminiClient.isConfigured(),
      words: wordsConfigured(),
      default_image_model: defaultImageModel(),
    },
    plan: planPayload(planRow, normalized, maps, row),
  };
}

// The words provider's key: the one the current words model names.
function wordsConfigured() {
  return textProvider() === 'anthropic' ? anthropicClient.isConfigured() : openaiClient.isConfigured();
}

// The image model the card and a new editor draw with: Gemini when its key is set.
function defaultImageModel() {
  return geminiClient.isConfigured() ? 'gemini' : 'openai';
}

module.exports = {
  readDraftPayload,
  readReviewBlocks,
  printBlock,
  proofBlock,
  PENDING_STALE_MS,
  wordsConfigured,
  defaultImageModel,
  stuck,
  readStaleMs,
  computeDiff,
  reviewOf,
  shownDiff,
  barBaseline,
  dismissalHash,
  derivePrintState,
  readPrintState,
  cachedCatalogMaps,
  dropCatalogCache,
  DISMISSAL,
  PRINT_STATES,
  INTERRUPTED,
  STALE_MS_DEFAULT,
  _resetCatalogCacheForTest: dropCatalogCache,
};
