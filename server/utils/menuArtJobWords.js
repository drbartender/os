// The words calls of the menu art job (menuArtJob.js; spec 2026-10-01
// sections 5.3, 5.5 and 6, Writers; plan Task E4). Split from the job to keep
// each file short. Both run on the provider the stamped model id names
// (menuArtJobSteps.textProvider; spec 2026-10-19 section 16): a claude- model
// through anthropicClient.draftMenuCopy, any other through
// openaiClient.draftMenuCopy, the same request, retries and sentences either
// way, and the descriptor stored and sent to Sentry names that provider.
//
// wordsStep(ctx, { textId, model, normalized, eventTypeLabel })
//   Generate's words step. One heartbeat UPDATE (content.words_heartbeat_at
//   and the run's pending pieces), authorizeCall on the run's text
//   reservation, draftMenuCopy, parseWords, then ONE conditional UPDATE
//   (draft id and run_id, words still pending) writing the content fill,
//   words_status 'done' (words_heartbeat_at kept) and the bar baseline
//   (plan_fingerprint's bar_lines and bar_hash) from the same plan read the
//   "Also at the bar" lines were built from, so a bar pick changed between
//   Generate's read and this one is neither a false flag nor a lost one;
//   Generate's drinks, brief and image parts stay. has_art goes on exactly
//   the drinks the run holds image reservations for (Generate's pieces),
//   never on a drink by its position on a plan edited since. A failure writes
//   words_status 'failed' and a fixed words_error sentence; the descriptor
//   goes to the ledger row and Sentry. -> { content } | { failed } | { stopped }
//
// runWordsForDrinks({ normalizedDrinks, brief, eventTypeLabel, reservationId, draftId, runId, model })
//   Update draft's words for the client-typed drinks it adds, inside its
//   request and before its main transaction. The ROUTE reserves the text row
//   (lockCalls then reserveText with runId = the draft's current run_id,
//   committed) and passes its id with that runId. This function authorizes
//   it (false: 409 MENU_DRAFT_CHANGED, no call), calls, retries a 429 on the
//   same row while the draft run is still current (a Start over during the
//   wait is also a 409), marks it ok or failed, and releases it when it was
//   never sent.
//   -> the stored drink entries for just those drinks, in order (spec 6's
//   thirteen fields; has_art false for the route to set, added_by_sync true).
//   A failure throws AppError 502 MENU_WORDS_FAILED with a fixed sentence and
//   the sanitized .descriptor; the route then writes nothing.

const { pool } = require('../db');
const openaiClient = require('./openaiClient');
const anthropicClient = require('./anthropicClient');
const { wordsRequest, parseWords } = require('./menuArtPrompts');
const { authorizeCall, markCall } = require('./menuArtCap');
const { buildFingerprint } = require('./menuDrinkSource');
const { AppError, ConflictError } = require('./errors');
const E = require('./menuArtJobErrors');
const S = require('./menuArtJobSteps');

// The one words call, on the provider the model id names.
function draftWords(request, model) {
  const wrapper = S.textProvider(model) === 'anthropic' ? anthropicClient : openaiClient;
  return wrapper.draftMenuCopy({ ...request, model });
}

// The words step's heartbeat and the run's pending pieces, one statement.
async function beatWords(ctx) {
  const { rows } = await pool.query(
    `WITH d AS (
       UPDATE menu_drafts SET content = jsonb_set(content, '{words_heartbeat_at}', to_jsonb(NOW()))
        WHERE id = $1 AND run_id = $2::uuid AND content->>'words_status' = 'pending'
        RETURNING id
     ), p AS (
       UPDATE menu_draft_pieces SET heartbeat_at = NOW()
        WHERE draft_id IN (SELECT id FROM d) AND run_id = $2::uuid AND status = 'pending'
        RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM d)::int AS drafts, (SELECT COUNT(*) FROM p)::int AS pieces`,
    [ctx.draftId, ctx.draftRun]);
  return rows[0].drafts === 1;
}

// The one content fill (spec 6, Writers); words_heartbeat_at is kept. The bar
// baseline lands with it, from the plan read the lines were built from.
async function writeWords(ctx, fill, normalized) {
  const { bar_lines: barLines, bar_hash: barHash } = buildFingerprint(normalized);
  const result = await pool.query(
    `UPDATE menu_drafts SET content = content || $3::jsonb,
            plan_fingerprint = plan_fingerprint || jsonb_build_object('bar_lines', $4::jsonb, 'bar_hash', $5::text)
      WHERE id = $1 AND run_id = $2::uuid AND content->>'words_status' = 'pending'`,
    [ctx.draftId, ctx.draftRun, { ...fill, words_status: 'done', words_error: null }, barLines, barHash]);
  return result.rowCount === 1;
}

async function failWords(ctx, sentence) {
  await pool.query(
    `UPDATE menu_drafts SET content = content || jsonb_build_object('words_status', 'failed', 'words_error', $3::text)
      WHERE id = $1 AND run_id = $2::uuid AND content->>'words_status' = 'pending'`,
    [ctx.draftId, ctx.draftRun, sentence]);
}

async function wordsStep(ctx, { textId, model, normalized, eventTypeLabel }) {
  if (!normalized || !normalized.drinks.length) {
    await failWords(ctx, E.SENTENCES.noDrinks);
    return { failed: true };
  }
  const request = wordsRequest({ normalized, eventTypeLabel });
  if (!(await beatWords(ctx)) || !(await authorizeCall(textId, { draftId: ctx.draftId, runId: ctx.draftRun }))) {
    if ((await S.lost(ctx)) === 'stopped') return { stopped: true };
    await failWords(ctx, E.SENTENCES.wordsFailed);
    E.report('words', { ...E.SUPERSEDED, errorClass: 'NotAuthorized', code: 'not_authorized' });
    return { failed: true };
  }
  let requestId = null;
  try {
    const out = await E.withRetries(() => draftWords(request, model), E.wordsLimited, () => beatWords(ctx));
    requestId = out.requestId;
    const artKeys = [...ctx.reservations.keys()].filter((k) => k !== 'background');
    const content = parseWords(out.json, normalized, { artKeys });
    if (!(await writeWords(ctx, content, normalized))) {
      await markCall(textId, 'failed', E.failedCall({ ...E.SUPERSEDED, requestId }, { model }));
      return { stopped: true };
    }
    await markCall(textId, 'ok', { requestId, model });
    return { content };
  } catch (err) {
    const d = E.describe(err, S.textProvider(model));
    if (!d.requestId) d.requestId = requestId;
    await markCall(textId, 'failed', E.failedCall(d, { model }));
    if (err instanceof E.RunLost) return { stopped: true };
    await failWords(ctx, E.wordsSentence(err));
    if (!E.isRefusal(err)) E.report('words', d);
    return { failed: true };
  }
}

async function runWordsForDrinks({
  normalizedDrinks, brief = {}, eventTypeLabel, reservationId, draftId, runId, model = S.textModelId(),
} = {}) {
  const normalized = { drinks: Array.isArray(normalizedDrinks) ? normalizedDrinks : [], brief, bar: null };
  let sent = false;
  try {
    const request = wordsRequest({ normalized, eventTypeLabel });
    if (!(await authorizeCall(reservationId, { draftId, runId }))) {
      throw new ConflictError('The draft changed. Try again.', 'MENU_DRAFT_CHANGED');
    }
    sent = true;
    let requestId = null;
    // A 429 wait re-checks the draft run, so Start over during it ends the
    // call (RunLost) instead of retrying on a run nobody will keep.
    const current = () => S.draftRunIs({ draftId, draftRun: runId });
    try {
      const out = await E.withRetries(() => draftWords(request, model), E.wordsLimited, current);
      requestId = out.requestId;
      const fill = parseWords(out.json, normalized, { artSlots: 0, addedBySync: true });
      await markCall(reservationId, 'ok', { requestId, model });
      return fill.drinks;
    } catch (err) {
      const d = E.describe(err, S.textProvider(model));
      if (!d.requestId) d.requestId = requestId;
      await E.safely('sync_words', () => markCall(reservationId, 'failed', E.failedCall(d, { model })));
      if (err instanceof E.RunLost) throw new ConflictError('The draft changed. Try again.', 'MENU_DRAFT_CHANGED');
      if (!E.isRefusal(err)) E.report('sync_words', d);
      throw Object.assign(new AppError(E.wordsSentence(err, { sync: true }), 502, 'MENU_WORDS_FAILED'), { descriptor: d });
    }
  } finally {
    if (!sent) await E.safely('sync_words', () => S.releaseCall(reservationId));
  }
}

module.exports = { wordsStep, runWordsForDrinks, failWords };
