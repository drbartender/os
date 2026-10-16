// Server-side validation for the menu draft routes (spec 7.1, 4.5); the client
// mirrors it. Failures are one ValidationError, fieldErrors keyed by field name.
// - A PATCH replaces only the top-level content and inputs keys it sends, and
//   server-written keys are refused, never silently ignored.
// - validatePatch returns only the sections the body sent, so the route writes
//   only those columns: an inputs-only PATCH never writes content back over the
//   job's words fill (the job writes content without bumping version). It says
//   changed: false when every sent value equals the stored one, so the route
//   skips the write and the version bump (an approved draft stays approved).
// - On a drink only the name, description, Hide, art and the AI flags may
//   change. Every other key is fixed, including any the drafter adds later: it
//   may be sent back only exactly as stored, and a key the stored drink lacks
//   may not be sent at all.
// - A value sent back unchanged is never refused for its length or count: the
//   server wrote it (catalog descriptions have no cap; Generate or Update draft
//   can leave more than 12 drinks visible), so the limits bind what Dallas
//   changes, and a count over its limit may only go down.

const { isDeepStrictEqual } = require('node:util');
const { ValidationError } = require('./errors');
const { isFontPairingId } = require('./menuFontPairings');

const IMAGE_MODELS = ['openai', 'gemini'];
const PLANNER_IMAGE_ROLES = ['logo', 'reference', 'ignore'];
const REFERENCE_SOURCES = ['none', 'planner', 'upload'];
const HEADING_KEYS = ['sig', 'mock', 'more', 'also'];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LIMITS = Object.freeze({
  art_direction: 500, reroll_note: 200, art_drinks: 8, visible_drinks: 12, visible_without_art: 4,
});

const MSG = {
  unknown: 'Unknown field.',
  serverWritten: 'This is written by the menu drafter and cannot be edited.',
  notEditable: "Only a drink's name, description, Hide and art can change here.",
  keySet: 'Drinks are added or removed only by Update draft.',
  addedBySync: 'New from plan is set by Update draft and cannot be edited.',
  boolean: 'Must be true or false.',
  imageModel: 'Pick GPT Image or Gemini.',
  role: 'Pick Logo, Style ref or Ignore.',
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNil = (v) => v === null || v === undefined;

// errors has a null prototype; the copy keeps a "__proto__" body key as a field.
function throwIfAny(errors) {
  if (Object.keys(errors).length) throw new ValidationError(Object.fromEntries(Object.entries(errors)));
}

// A text field, trimmed and sized in [min, max], unless it equals the stored value.
function checkText(value, stored, { min, max, nullable = false, message }) {
  const v = value === null && nullable ? '' : value;
  if (typeof v !== 'string') return { error: message };
  const t = v.trim();
  const same = typeof stored === 'string' ? t === stored.trim() : nullable && isNil(stored) && t === '';
  if (same) return { value: stored, changed: false };
  if (t.length < min || t.length > max) return { error: message };
  return { value: t, changed: true };
}

const enumCheck = (values, message) => (v) => (values.includes(v) ? { value: v } : { error: message });
const booleanCheck = (v) => (typeof v === 'boolean' ? { value: v } : { error: MSG.boolean });
const hexCheck = (v) => (v === null || (typeof v === 'string' && HEX_RE.test(v))
  ? { value: v } : { error: 'Pick a color as #rrggbb, or the pairing default.' });

function checkArtDirection(v) {
  if (typeof v !== 'string') return { error: 'Art direction must be text.' };
  const t = v.trim();
  return t.length > LIMITS.art_direction ? { error: 'Art direction must be 500 characters or fewer.' } : { value: t };
}

function validateImageModel(value) {
  if (!IMAGE_MODELS.includes(value)) throw new ValidationError({ image_model: MSG.imageModel });
  return value;
}

function validateRerollNote(note) {
  if (isNil(note)) return null;
  if (typeof note !== 'string') throw new ValidationError({ note: 'The note must be text.' });
  const t = note.trim();
  if (t.length > LIMITS.reroll_note) throw new ValidationError({ note: 'The note must be 200 characters or fewer.' });
  return t || null;
}

// The planner image is the style reference exactly when its role is Style ref.
function referencePairError(role, source) {
  if (source === 'planner' && role !== 'reference') return { reference_source: 'The client image is the reference only when its role is Style ref.' };
  if (role === 'reference' && source !== 'planner') return { planner_image_role: 'As Style ref, the client image must be the reference.' };
  return null;
}

// Generate is multipart, so fields arrive as strings. An absent field takes the
// editor's default. storedInputs lets Start over keep the stored upload when no
// new file is attached and the source stays upload (spec 5.5).
function validateGenerateInputs(body, { hasFile = false, storedInputs = null } = {}) {
  const src = isPlainObject(body) ? body : {};
  const errors = Object.create(null);
  const field = (k, fallback) => (src[k] === undefined || src[k] === '' ? fallback : src[k]);
  const imageModel = field('image_model');
  if (!IMAGE_MODELS.includes(imageModel)) errors.image_model = MSG.imageModel;
  const role = field('planner_image_role', 'logo');
  if (!PLANNER_IMAGE_ROLES.includes(role)) errors.planner_image_role = MSG.role;
  const source = field('reference_source', 'none');
  if (!REFERENCE_SOURCES.includes(source)) errors.reference_source = 'Pick no reference, the client image or an upload.';
  const art = checkArtDirection(field('art_direction', ''));
  if (art.error) errors.art_direction = art.error;
  const rawMark = field('drb_mark', true);
  const drbMark = rawMark === 'true' ? true : rawMark === 'false' ? false : rawMark;
  if (typeof drbMark !== 'boolean') errors.drb_mark = MSG.boolean;
  if (hasOwn(src, 'reference_key')) errors.reference_key = 'The reference file comes only from the upload.';
  if (!errors.reference_source && !errors.planner_image_role) {
    const keepsStored = !!(storedInputs && storedInputs.reference_source === 'upload'
      && typeof storedInputs.reference_key === 'string' && storedInputs.reference_key);
    if (hasFile && source !== 'upload') errors.reference_source = 'An uploaded file needs reference source upload.';
    else if (source === 'upload' && !hasFile && !keepsStored) errors.reference_source = 'Choose an image to upload as the reference.';
    else Object.assign(errors, referencePairError(role, source));
  }
  throwIfAny(errors);
  return { planner_image_role: role, reference_source: source, art_direction: art.value, drb_mark: drbMark, image_model: imageModel };
}

// ---- PATCH: drinks ----
// Each editable text field and the AI flag that editing it clears.
const DRINK_TEXT = [
  ['display_name', 'name_ai_suggested', { min: 1, max: 60, message: 'Drink names must be 1 to 60 characters.' }],
  ['description', 'description_ai_written', { min: 0, max: 200, nullable: true, message: 'Descriptions must be 200 characters or fewer.' }],
];
// The keys a PATCH may change on a drink. Every other key (key, source, group,
// added_by_sync, and whatever the drafter stores on a drink later) is fixed.
const DRINK_EDITABLE = new Set(['hidden', 'has_art', ...DRINK_TEXT.flatMap(([f, flag]) => [f, flag])]);

// A fixed key passes only when it deep-equals the stored value; a key the
// stored drink lacks must be absent (or undefined) in the sent one.
function fixedDrinkError(sent, prev) {
  for (const f of Object.keys(sent)) {
    if (DRINK_EDITABLE.has(f)) continue;
    const was = hasOwn(prev, f) ? prev[f] : undefined;
    if (!isDeepStrictEqual(sent[f], was)) return f === 'added_by_sync' ? MSG.addedBySync : MSG.notEditable;
  }
  return null;
}

function nextDrink(sent, prev) {
  const fixed = fixedDrinkError(sent, prev);
  if (fixed) return { error: fixed };
  // Fixed keys come from the stored drink, so an omitted one is kept as stored.
  const out = structuredClone(prev);
  for (const f of ['hidden', 'has_art']) {
    if (!hasOwn(sent, f)) continue;
    if (typeof sent[f] !== 'boolean') return { error: MSG.boolean };
    out[f] = sent[f];
  }
  // Editing the text clears its AI flag. A flag sent back may echo the stored
  // value or drop to false (the client clears it as Dallas types), never rise.
  for (const [f, flag, rule] of DRINK_TEXT) {
    let changed = false;
    if (hasOwn(sent, f)) {
      const r = checkText(sent[f], prev[f], rule);
      if (r.error) return r;
      out[f] = r.value;
      changed = r.changed;
    }
    if (hasOwn(sent, flag)) {
      if (typeof sent[flag] !== 'boolean') return { error: MSG.boolean };
      if (sent[flag] && prev[flag] !== true) return { error: MSG.notEditable };
      if (!sent[flag]) out[flag] = false;
    }
    if (changed) out[flag] = false;
  }
  return { value: out };
}

function drinkCounts(drinks) {
  const visible = drinks.filter((d) => d && d.hidden !== true);
  const art = visible.filter((d) => d.has_art === true).length;
  return { visible: visible.length, art, noArt: visible.length - art };
}

function checkDrinks(value, storedDrinks) {
  if (!Array.isArray(value)) return { error: 'Send the drinks as a list.' };
  const stored = Array.isArray(storedDrinks) ? storedDrinks : [];
  const byKey = new Map(stored.map((d) => [d.key, d]));
  const keys = value.map((d) => (isPlainObject(d) ? d.key : undefined));
  if (keys.some((k) => typeof k !== 'string')) return { error: 'Each drink needs its key.' };
  if (new Set(keys).size !== keys.length || keys.length !== byKey.size || !keys.every((k) => byKey.has(k))) {
    return { error: MSG.keySet };
  }
  const next = [];
  for (const d of value) {
    const r = nextDrink(d, byKey.get(d.key));
    if (r.error) return r;
    next.push(r.value);
  }
  // Each count must be within its limit, or no higher than it was.
  const now = drinkCounts(stored);
  const after = drinkCounts(next);
  const over = (k, limit) => after[k] > limit && after[k] > now[k];
  if (over('visible', LIMITS.visible_drinks)) return { error: 'At most 12 drinks can show on the menu. Hide the rest.' };
  if (over('art', LIMITS.art_drinks)) return { error: 'At most 8 visible drinks can have art.' };
  if (over('noArt', LIMITS.visible_without_art)) return { error: 'At most 4 visible drinks can go without art.' };
  return { value: next };
}

// ---- PATCH: the other content keys ----
function checkHeadings(value, stored) {
  const prev = isPlainObject(stored) ? stored : {};
  if (!isPlainObject(value) || Object.keys(value).length !== HEADING_KEYS.length
    || !HEADING_KEYS.every((k) => hasOwn(value, k))) return { error: 'Send all four headings.' };
  const out = {};
  for (const k of HEADING_KEYS) {
    const r = checkText(value[k], prev[k], { min: 1, max: 40, message: 'Each heading must be 1 to 40 characters.' });
    if (r.error) return r;
    out[k] = r.value;
  }
  return { value: out };
}

// The lines are fixed (none added or removed); each label and text is editable.
function checkAlsoAtBar(value, stored) {
  if (!Array.isArray(value)) return { error: 'Send the Also at the bar lines as a list.' };
  const prev = Array.isArray(stored) ? stored : [];
  if (value.length !== prev.length) return { error: 'The Also at the bar lines are fixed. Edit their words instead.' };
  const out = [];
  for (const [i, line] of value.entries()) {
    const was = isPlainObject(prev[i]) ? prev[i] : {};
    if (!isPlainObject(line) || Object.keys(line).some((k) => k !== 'label' && k !== 'text')) {
      return { error: 'Each line has only a label and its text.' };
    }
    const label = checkText(hasOwn(line, 'label') ? line.label : was.label, was.label, { min: 1, max: 30, message: 'Labels must be 1 to 30 characters.' });
    if (label.error) return label;
    const text = checkText(hasOwn(line, 'text') ? line.text : was.text, was.text, { min: 0, max: 120, nullable: true, message: 'Each line must be 120 characters or fewer.' });
    if (text.error) return text;
    out.push({ ...was, label: label.value, text: text.value });
  }
  return { value: out };
}

const CONTENT_CHECKS = new Map([
  ['title', (v, s) => checkText(v, s, { min: 1, max: 60, message: 'The title must be 1 to 60 characters.' })],
  ['headings', checkHeadings],
  ['drinks', checkDrinks],
  ['also_at_bar', checkAlsoAtBar],
  ['font_pairing', (v) => (isFontPairingId(v) ? { value: v } : { error: 'Pick one of the font pairings.' })],
  ['ink_color', hexCheck],
  ['accent_color', hexCheck],
  ['text_backing', enumCheck(['off', 'soft', 'panel'], 'Pick Off, Soft or Panel.')],
  ['logo_mode', enumCheck(['above_title', 'replaces_title'], 'Pick above the title or replacing it.')],
  ['logo_badge', booleanCheck],
  ['mark_color', enumCheck(['ink', 'accent', 'gold'], 'Pick Theme ink, Accent or Gold.')],
]);
const CONTENT_SERVER_ONLY = new Map(['palette', 'background_label', 'words_status', 'words_error', 'words_heartbeat_at']
  .map((k) => [k, MSG.serverWritten]));

const INPUT_CHECKS = new Map([
  ['planner_image_role', enumCheck(PLANNER_IMAGE_ROLES, MSG.role)],
  ['reference_source', (v) => (v === 'none' || v === 'planner' ? { value: v }
    : { error: v === 'upload' ? 'An uploaded reference comes only with Start over.' : 'Pick no reference or the client image.' })],
  ['art_direction', checkArtDirection],
  ['drb_mark', booleanCheck],
]);
const INPUT_SERVER_ONLY = new Map([
  ['reference_key', 'The reference file is set only by Generate.'],
  ['image_model', 'The image model is recorded only by Generate.'],
]);

// Check each sent key and write the passing ones over a copy of stored.
function applyKeys(sent, stored, checks, serverOnly, errors) {
  const out = structuredClone(stored);
  for (const [key, value] of Object.entries(sent)) {
    if (serverOnly.has(key)) { errors[key] = serverOnly.get(key); continue; }
    if (!checks.has(key)) { errors[key] = MSG.unknown; continue; }
    const r = checks.get(key)(value, stored[key]);
    if (r.error) errors[key] = r.error;
    else out[key] = r.value;
  }
  return out;
}

// Validates a PATCH body { version, content?, inputs? } against the stored row
// and returns { changed, content?, inputs? }:
// - content and inputs are each present only when the body sent that section,
//   as the full next object (a copy of the stored one with the sent top-level
//   keys replaced). An omitted section is absent from the result, never a copy
//   of the stored one, and the route writes only the columns present: the job
//   writes content (the words fill, words_heartbeat_at) without bumping version,
//   so writing back a stored copy could erase a fill that landed meanwhile.
// - changed is false when every sent value equals the stored one (text compared
//   trimmed, as the client may echo stray spaces). The route then skips the
//   write and returns the current version, so a draft never reads as edited
//   since approval for a save that changed nothing.
// Throws ValidationError for a refused field, and for a body that sends nothing.
function validatePatch({ stored, body } = {}) {
  if (!stored || !isPlainObject(stored.content) || !isPlainObject(stored.inputs)) throw new Error('validatePatch needs the stored draft');
  if (!isPlainObject(body)) throw new ValidationError({ content: 'Send the draft changes as an object.' });

  const errors = Object.create(null);
  for (const k of Object.keys(body)) if (!['version', 'content', 'inputs'].includes(k)) errors[k] = MSG.unknown;
  if (!Number.isInteger(body.version) || body.version < 1) errors.version = 'Send the draft version you edited.';
  // A body that sends nothing is refused outright (an all-unchanged one is not).
  const sent = [body.content, body.inputs].filter((o) => o !== undefined);
  if (sent.every((o) => isPlainObject(o) && Object.keys(o).length === 0)) errors.content = 'Nothing to save.';

  const result = {};
  if (body.content !== undefined) {
    if (!isPlainObject(body.content)) errors.content = 'Send content as an object.';
    // The words step fills content once; nothing may be edited before it lands.
    else if (stored.content.words_status !== 'done') errors.content = 'The words are still being written. Edit once they land.';
    else result.content = applyKeys(body.content, stored.content, CONTENT_CHECKS, CONTENT_SERVER_ONLY, errors);
  }

  if (body.inputs !== undefined) {
    if (!isPlainObject(body.inputs)) errors.inputs = 'Send inputs as an object.';
    else {
      const inputs = applyKeys(body.inputs, stored.inputs, INPUT_CHECKS, INPUT_SERVER_ONLY, errors);
      const touchesReference = hasOwn(body.inputs, 'planner_image_role') || hasOwn(body.inputs, 'reference_source');
      if (touchesReference && !errors.planner_image_role && !errors.reference_source) {
        Object.assign(errors, referencePairError(inputs.planner_image_role, inputs.reference_source));
      }
      result.inputs = inputs;
    }
  }

  throwIfAny(errors);
  const differs = (k) => hasOwn(result, k) && !isDeepStrictEqual(result[k], stored[k]);
  return { changed: differs('content') || differs('inputs'), ...result };
}

module.exports = { validateGenerateInputs, validatePatch, validateRerollNote, validateImageModel, IMAGE_MODELS, LIMITS };
