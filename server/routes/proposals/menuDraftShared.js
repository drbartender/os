// Helpers shared by the menu art draft routes (menuDrafts.js, menuDraftSync.js,
// menuDraftImages.js; spec 2026-10-01 sections 5.5 and 7). Not a router.
//
// inLockedTx(fn) is the ONE way these routes open a reserving transaction:
// BEGIN, then lockCalls (LOCK TABLE menu_art_calls IN EXCLUSIVE MODE) as the
// first statement, then fn(client), then COMMIT. Inside fn the order is the
// draft row (SELECT ... FOR UPDATE) before any piece row, never the reverse, so
// Generate, re-roll, sync and the job's finishPiece (draft first, then piece)
// all take locks in one order. Any error rolls back and goes through
// mapDeadlock, so a 40P01 at any statement answers 409 MENU_DRAFT_CHANGED. The
// client is released before inLockedTx returns, so nothing the caller does
// after it (the response, setImmediate) holds a connection. Nothing inside fn
// may reach R2 or a provider: those run before it opens or after it returns.
//
// parseVersion bounds a posted draft version (a positive int4, else 400), and
// every writer compares it with the stored version in JS (409) before SQL sees
// it. requireWords and noPlan are the refusals re-roll and Update draft share.

const { pool } = require('../../db');
const { AppError, ConflictError, ValidationError, NotFoundError } = require('../../utils/errors');
const { lockCalls, mapDeadlock } = require('../../utils/menuArtCap');
const { report, describe } = require('../../utils/menuArtJobErrors');
const { stuck } = require('../../utils/menuDraftRead');
const openaiClient = require('../../utils/openaiClient');
const geminiClient = require('../../utils/geminiClient');

// Spec 7: ':pieceKey arrives URL-encoded'. Express has decoded it by the time
// the handler reads req.params, so this tests the decoded key.
const PIECE_KEY_RE = /^(background|(cocktail|mocktail|custom):[a-z0-9-]{1,100})$/;
const INT4_MAX = 2147483647;
// normalizePlan reads at most 50 entries from each of its four drink lists, so
// no real plan or stored draft holds more drinks than this. Every drink list
// these routes iterate (a stored content.drinks, a fingerprint's keys) is cut
// to it first, so a malformed blob can never stall the event loop.
const LIST_CAP = 200;
// The image model ids stamped on a piece when it is asked for (spec 13). The
// job draws with the stamped id, never these env values at run time.
const IMAGE_MODEL_DEFAULTS = Object.freeze({ openai: 'gpt-image-2.5-sunburst', gemini: 'gemini-3-pro-image' });
const IMAGE_MODEL_ENV = Object.freeze({ openai: 'MENU_ART_IMAGE_MODEL', gemini: 'MENU_ART_GEMINI_IMAGE_MODEL' });

const OPEN = new Set(['pending', 'working']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const capList = (v) => asArray(v).slice(0, LIST_CAP);

// ':id' must be digits (400 otherwise); an id no int4 can hold is a 404, so pg
// never raises 22003 on the compare.
function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ValidationError({ id: 'The event id must be a whole number.' });
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > INT4_MAX) throw new NotFoundError('Proposal not found.');
  return id;
}

// A body's draft version: a positive integer an int4 column can hold, or a
// 400, so a huge number never reaches Postgres as a 22003 (a 500).
function parseVersion(raw) {
  if (!Number.isInteger(raw) || raw < 1 || raw > INT4_MAX) {
    throw new ValidationError({ version: 'Send the draft version you saw.' });
  }
  return raw;
}

function parsePieceKey(raw) {
  if (typeof raw !== 'string' || !PIECE_KEY_RE.test(raw)) {
    throw new ValidationError({ pieceKey: 'That is not a menu piece.' });
  }
  return raw;
}

// -> { id, event_type, event_type_custom }, or 404.
async function requireProposal(id, db = pool) {
  const { rows } = await db.query('SELECT id, event_type, event_type_custom FROM proposals WHERE id = $1', [id]);
  if (!rows.length) throw new NotFoundError('Proposal not found.');
  return rows[0];
}

const noDraft = () => new NotFoundError('This event has no menu draft yet.');
const draftChanged = (message = 'The draft changed. Try again.') => new ConflictError(message, 'MENU_DRAFT_CHANGED');
const noPlan = () => new AppError('This event has no drink plan.', 422, 'MENU_NO_DRINKS');

// Re-roll and Update draft spend nothing until the words have landed. Still
// being written (and not stuck): 409 MENU_WORDS_PENDING. Failed, stuck (the
// read model's "interrupted") or never started: 409 MENU_WORDS_NOT_WRITTEN,
// whose remedy is Start over, not waiting. now is the database clock.
function requireWords(content, now) {
  const c = isObject(content) ? content : {};
  if (c.words_status === 'done') return;
  if (OPEN.has(c.words_status) && !stuck(c, now)) {
    throw new ConflictError('The menu words are still being written. Try again once they land.', 'MENU_WORDS_PENDING');
  }
  throw new ConflictError('The menu words were not written. Start over to write them.', 'MENU_WORDS_NOT_WRITTEN');
}

// Generate, re-roll and sync call this before any work. "Set up" means the
// OpenAI key, which the words step always needs, whatever draws the images.
function requireOpenAI() {
  if (!openaiClient.isConfigured()) throw new AppError('Menu art is not set up.', 503, 'MENU_ART_NOT_CONFIGURED');
}

function requireImageModel(imageModel) {
  if (imageModel === 'gemini' && !geminiClient.isConfigured()) {
    throw new AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED');
  }
}

function imageModelId(provider) {
  return String(process.env[IMAGE_MODEL_ENV[provider]] || '').trim() || IMAGE_MODEL_DEFAULTS[provider];
}

async function inLockedTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockCalls(client);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDeadlock(err);
  } finally {
    client.release();
  }
}

// Inside inLockedTx, after the draft row is locked: each piece key pending
// under runId, stamped with the provider and its model id, a fresh heartbeat
// and the note (null clears an old one). A piece that exists is reset in
// place (r2_key and drawn_count are kept until the new attempt lands).
async function upsertPendingPieces(client, { draftId, runId, pieceKeys, provider, model, note = null }) {
  if (!pieceKeys.length) return;
  await client.query(
    `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, provider, model, reroll_note, heartbeat_at)
     SELECT $1, k, $2::uuid, 'pending', $3, $4, $5, NOW() FROM unnest($6::text[]) AS k
     ON CONFLICT (draft_id, piece_key) DO UPDATE
        SET run_id = EXCLUDED.run_id, status = 'pending', provider = EXCLUDED.provider, model = EXCLUDED.model,
            reroll_note = EXCLUDED.reroll_note, heartbeat_at = NOW(), error = NULL, started_at = NULL, finished_at = NULL`,
    [draftId, runId, provider, model, note, pieceKeys]
  );
}

// Runs fn after the response, off the request. The job functions never
// throw; this catch is the backstop so a rejection can never go unhandled.
// Sentry gets the job's sanitized descriptor only, never the error itself
// (its message can quote a prompt or a client's brief).
function queue(step, fn) {
  setImmediate(() => {
    Promise.resolve().then(fn).catch((err) => report(step, describe(err)));
  });
}

module.exports = {
  PIECE_KEY_RE, LIST_CAP, IMAGE_MODEL_DEFAULTS,
  isObject, capList,
  parseId, parseVersion, parsePieceKey, requireProposal, noDraft, draftChanged, noPlan, requireWords,
  requireOpenAI, requireImageModel, imageModelId, inLockedTx, upsertPendingPieces, queue,
};
