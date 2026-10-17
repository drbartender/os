// The words calls of the menu art job (menuArtJob.js; spec 2026-10-01
// sections 5.3, 5.5 and 6, Writers; plan Task E4). Split from the job to keep
// each file short. Both always run on OpenAI.
//
// wordsStep(ctx, { textId, model, normalized, eventTypeLabel })
//   Generate's words step. One heartbeat UPDATE (content.words_heartbeat_at
//   and the run's pending pieces), authorizeCall on the run's text
//   reservation, draftMenuCopy, parseWords, then ONE conditional UPDATE
//   (draft id and run_id, words still pending) writing the content fill and
//   words_status 'done' (words_heartbeat_at kept). has_art goes on exactly
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
const { wordsRequest, parseWords } = require('./menuArtPrompts');
const { authorizeCall, markCall } = require('./menuArtCap');
const { AppError, ConflictError } = require('./errors');
const E = require('./menuArtJobErrors');
const S = require('./menuArtJobSteps');

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

// The one content fill (spec 6, Writers); words_heartbeat_at is kept.
async function writeWords(ctx, fill) {
  const result = await pool.query(
    `UPDATE menu_drafts SET content = content || $3::jsonb
      WHERE id = $1 AND run_id = $2::uuid AND content->>'words_status' = 'pending'`,
    [ctx.draftId, ctx.draftRun, { ...fill, words_status: 'done', words_error: null }]);
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
    const out = await E.withRetries(
      () => openaiClient.draftMenuCopy({ ...request, model }), E.wordsLimited, () => beatWords(ctx));
    requestId = out.requestId;
    const artKeys = [...ctx.reservations.keys()].filter((k) => k !== 'background');
    const content = parseWords(out.json, normalized, { artKeys });
    if (!(await writeWords(ctx, content))) {
      await markCall(textId, 'failed', E.failedCall({ ...E.SUPERSEDED, requestId }, { model }));
      return { stopped: true };
    }
    await markCall(textId, 'ok', { requestId, model });
    return { content };
  } catch (err) {
    const d = E.describe(err, 'openai');
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
      const out = await E.withRetries(
        () => openaiClient.draftMenuCopy({ ...request, model }), E.wordsLimited, current);
      requestId = out.requestId;
      const fill = parseWords(out.json, normalized, { artSlots: 0, addedBySync: true });
      await markCall(reservationId, 'ok', { requestId, model });
      return fill.drinks;
    } catch (err) {
      const d = E.describe(err, 'openai');
      if (!d.requestId) d.requestId = requestId;
      await E.safely('sync_words', () => markCall(reservationId, 'failed', E.failedCall(d, { model })));
      if (err instanceof E.RunLost) throw new ConflictError('The draft changed. Try again.', 'MENU_DRAFT_CHANGED');
      if (!E.isRefusal(err)) E.report('sync_words', d);
      throw Object.assign(new AppError(E.wordsSentence(err), 502, 'MENU_WORDS_FAILED'), { descriptor: d });
    }
  } finally {
    if (!sent) await E.safely('sync_words', () => S.releaseCall(reservationId));
  }
}

module.exports = { wordsStep, runWordsForDrinks, failWords };
