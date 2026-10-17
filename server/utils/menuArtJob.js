// The menu art job (spec 2026-10-01 sections 5.3, 5.4, 5.5 and 6, Writers;
// plan Task E4). Every provider call spends real money, so each goes through
// one gate (drawPiece here; the words step the same way):
//   1. claim the piece, pending -> working, conditional on its run (a piece
//      Update draft removed, or one re-run, claims nothing);
//   2. one UPDATE refreshing the active piece's heartbeat and every pending
//      piece of the run (the words step also content.words_heartbeat_at);
//   3. authorizeCall on that call's own reservation; the call only on true;
//   4. after the call, every write is conditional on the run again, and the
//      bytes go to R2 only while the run is still current.
// A lost RUN (the draft run_id moved: Start over superseded it) stops: no
// further call and no further write. A lost PIECE on a Generate run that is
// still current (Update draft deleted it mid-run) is skipped and the run goes
// on; its reservation, never authorized, is released by the settle below.
// Stored bytes reach a provider only after their key's prefix is re-checked.
// No pooled client is ever held. Siblings: menuArtJobSteps.js (the piece
// writes, stored-image reads), menuArtJobWords.js (both words calls) and
// menuArtJobErrors.js (descriptors, sentences, Sentry, the 429 wait).
//
// runGeneration({ draftId, runId, proposalId })
//   Generate's job: the words, then the background, then each has_art drink
//   in content order, one at a time. setImmediate it after COMMIT. Never throws.
//   has_art is set on exactly the drinks Generate reserved pieces for, never
//   by position on the plan re-read here (it may have changed since), and
//   before each drink the CURRENT content is read again: a drink a PATCH
//   turned off or hid is skipped, its reservation left for the settle below.
// runPieceReroll({ draftId, pieceKey, pieceRunId, proposalId })
//   One piece: a re-roll, or a drink Update draft added (queue several one
//   after another, not side by side). A drink sends the CURRENT background,
//   when done, as its style reference. Never throws.
// runWordsForDrinks({ normalizedDrinks, brief, eventTypeLabel, reservationId, draftId, runId, model })
//   Update draft's words; see menuArtJobWords.js for the reservation contract.
// textModelId(): the words model the routes stamp on reserveText.
// freshPlan(proposalId): the plan with fresh catalog maps (menuArtJobSteps).
// A background sent with a style reference says so in its prompt
// (hasReference), whichever provider draws it.
//
// The end of every run (finally): each pending or working piece of the run
// fails "not attempted: <cause>" (conditional on the run), the run's own
// reservations settle by their own status (reserved -> released, sent ->
// failed), and an unexpected error goes to Sentry as its descriptor only.

const geminiClient = require('./geminiClient');
const storage = require('./storage');
const { drawImage } = require('./menuImageProvider');
const { backgroundPrompt, drinkPrompt } = require('./menuArtImagePrompts');
const { readTone } = require('./menuBackgroundTone');
const { authorizeCall, markCall, settleRun } = require('./menuArtCap');
const { getEventTypeLabel } = require('./eventTypes');
const E = require('./menuArtJobErrors');
const S = require('./menuArtJobSteps');
const W = require('./menuArtJobWords');

const PROVIDERS = new Set(['openai', 'gemini']);

// backgroundPrompt has no slot for a re-roll note, so the note leads the art
// direction (it survives the 500-character cut; the direction's tail may not).
function withNote(direction, note) {
  const n = typeof note === 'string' ? note.trim() : '';
  if (!n) return direction;
  return `Change from the last version: ${n}. ${typeof direction === 'string' ? direction : ''}`.trim();
}

const drinkPromptFor = (drink, piece) => drinkPrompt({
  visualNote: drink.visual_note || drink.display_name, rerollNote: piece.reroll_note, provider: piece.provider,
});

// A reason to fail the piece before anything is authorized, or null.
function preflight(ctx, piece, resId) {
  if (!PROVIDERS.has(piece.provider) || typeof piece.model !== 'string' || !piece.model.trim()) return E.SENTENCES.noProvider;
  if (piece.provider === 'gemini' && !geminiClient.isConfigured()) return E.SENTENCES.geminiOff;
  if (ctx.refError) return ctx.refError;
  if (!resId) return E.SENTENCES.notReserved;
  return null;
}

// The provider call failed (or was lost during a 429 wait): the reservation
// was sent, so it is marked failed and keeps counting.
async function failCall(ctx, key, resId, err, provider, step) {
  const d = E.describe(err, provider);
  await markCall(resId, 'failed', E.failedCall(d));
  if (err instanceof E.RunLost) return { status: await S.lost(ctx) };
  await S.failPiece(ctx, key, E.pieceSentence(err, provider));
  if (!E.isRefusal(err)) E.report(step, d);
  return { status: 'failed' };
}

// One image piece. -> { status: 'done' | 'failed' | 'skipped' | 'stopped', buffer? }
async function drawPiece(ctx, { key, kind, prompt, prepare }) {
  if (E.hooks.beforePiece) await E.hooks.beforePiece(key);
  const piece = await S.claimPiece(ctx, key);
  if (!piece) return { status: await S.lost(ctx) };
  const resId = ctx.reservations.get(key);
  const { refs = [], blocked = null } = prepare ? await prepare() : {};
  const refusal = blocked || preflight(ctx, piece, resId);
  if (refusal) {
    await S.failPiece(ctx, key, refusal);
    return { status: 'failed' };
  }
  if (!(await S.beat(ctx, key)) || !(await authorizeCall(resId, { draftId: ctx.draftId, pieceRunId: ctx.pieceRun }))) {
    return { status: await S.lost(ctx) };
  }
  const { provider, model } = piece;
  const text = prompt(piece);
  const step = kind === 'background' ? 'background' : 'drinks';
  let out;
  try {
    out = await E.withRetries(
      () => drawImage({ provider, model, kind, prompt: text, references: [...refs, ...ctx.refs] }),
      E.imageLimited, () => S.beat(ctx, key));
  } catch (err) {
    return failCall(ctx, key, resId, err, provider, step);
  }
  const call = { requestId: out.requestId, model: out.model, size: out.size };
  try {
    return await keepImage(ctx, { key, kind, resId, out, call });
  } catch (err) {
    // A database error after a billed call (a deadlock with Update draft, a
    // dropped connection): the row is settled as billed and only this piece
    // fails; the run goes on unless it was superseded.
    const d = { ...E.describe(err), requestId: out.requestId };
    await E.safely(step, () => markCall(resId, 'failed', E.failedCall(d, call)));
    await E.safely(step, () => S.failPiece(ctx, key, E.SENTENCES.drawFailed));
    E.report(step, d);
    return { status: (await S.lost(ctx)) === 'stopped' ? 'stopped' : 'failed' };
  }
}

// After a successful call: store the bytes and mark the piece done, all while
// the run is still current.
async function keepImage(ctx, { key, kind, resId, out, call }) {
  // Billed but superseded: nothing goes to R2 and nothing is written.
  if (!(await S.beat(ctx, key))) {
    await markCall(resId, 'failed', E.failedCall(E.SUPERSEDED, call));
    return { status: await S.lost(ctx) };
  }
  const r2Key = S.artKey(ctx, key, out.contentType);
  try {
    await storage.uploadFile(out.buffer, r2Key);
  } catch (err) {
    const d = { ...E.describe(err, 'r2'), requestId: out.requestId };
    await markCall(resId, 'failed', E.failedCall(d, call));
    await S.failPiece(ctx, key, E.SENTENCES.saveFailed);
    E.report('upload', d);
    return { status: 'failed' };
  }
  const tone = kind === 'background' ? await readTone(out.buffer) : { tone: null, ground_rgb: null };
  if (!(await S.finishPiece(ctx, key, { r2Key, tone: tone.tone, groundRgb: tone.ground_rgb }))) {
    await markCall(resId, 'failed', E.failedCall(E.SUPERSEDED, call));
    return { status: await S.lost(ctx) };
  }
  await markCall(resId, 'ok', call);
  return { status: 'done', buffer: out.buffer };
}

const newContext = (draftId, proposalId, pieceRun, draftRun) => ({
  draftId, proposalId, pieceRun, draftRun, reservations: new Map(), refs: [], refError: null,
});

// The Generate run's own reservations: one image row per piece key, and the
// text row Generate made (the run's first; a sync words row sharing the draft
// run_id comes later and is never this job's to settle). -> the text row.
function adopt(ctx, held) {
  for (const r of held) {
    if (r.kind === 'image' && r.piece_key && !ctx.reservations.has(r.piece_key)) ctx.reservations.set(r.piece_key, r.id);
  }
  return held.find((r) => r.kind === 'text' && r.piece_key === null) || null;
}

async function runGeneration({ draftId, runId, proposalId } = {}) {
  const ctx = newContext(draftId, proposalId, runId, runId);
  let cause = E.NOT_ATTEMPTED.ended;
  let step = 'start';
  let textId = null;
  let adopted = false;
  try {
    // Read first, so a draft deleted or superseded before the job started
    // still has its own unspent rows released below.
    const text = adopt(ctx, await S.findReservations(runId));
    adopted = true;
    textId = text ? text.id : null;
    const draft = await S.loadDraft(draftId, proposalId);
    if (!draft || draft.run_id !== runId) return;
    step = 'words';
    const { plan, normalized } = await S.freshPlan(proposalId);
    const words = await W.wordsStep(ctx, {
      textId, model: (text && text.model) || S.textModelId(), normalized, eventTypeLabel: getEventTypeLabel(draft),
    });
    if (words.stopped) return;
    if (!words.content) {
      cause = E.NOT_ATTEMPTED.words;
      return;
    }
    step = 'reference';
    const inputs = draft.inputs || {};
    Object.assign(ctx, await S.loadReference({ inputs, proposalId, plan, normalized }));
    step = 'background';
    const bg = await drawPiece(ctx, {
      key: 'background', kind: 'background',
      prompt: (p) => backgroundPrompt({
        brief: normalized.brief, artDirection: withNote(inputs.art_direction, p.reroll_note), palette: words.content.palette,
        hasReference: ctx.refs.length > 0,
      }),
    });
    if (bg.status === 'stopped') return;
    // Downscaled once per run; the drinks still draw without it if this fails.
    const bgRefs = bg.buffer ? await S.drinkReference(bg.buffer).then((r) => [r], () => []) : [];
    step = 'drinks';
    for (const planned of words.content.drinks) {
      if (!planned.has_art || planned.hidden) continue;
      const drink = await S.currentDrink(ctx, planned.key);
      if (!drink || drink.has_art !== true || drink.hidden === true) continue;
      const done = await drawPiece(ctx, {
        key: drink.key, kind: 'drink', prepare: () => ({ refs: bgRefs }), prompt: (p) => drinkPromptFor(drink, p),
      });
      if (done.status === 'stopped') return;
    }
  } catch (err) {
    cause = E.NOT_ATTEMPTED.error;
    E.report(step, E.describe(err));
  } finally {
    // The first read failed: nothing was authorized, so every row of the run
    // is still reserved; read them again so they are released, not stranded.
    if (!adopted) {
      await E.safely('settle', async () => {
        const text = adopt(ctx, await S.findReservations(runId));
        textId = text ? text.id : null;
      });
    }
    // A words step an unexpected error left pending reads failed now, not
    // "writing" until it goes stale (conditional on the run and on pending).
    await E.safely('words', () => W.failWords(ctx, E.SENTENCES.wordsFailed));
    await E.safely('sweep', () => S.sweep(ctx, cause));
    // The text row by its own status (the words step marks it; this is the backstop).
    await E.safely('settle', () => S.releaseCall(textId));
    await E.safely('settle', () => (textId ? markCall(textId, 'failed', E.failedCall({ ...E.SUPERSEDED, errorClass: 'NotSettled', code: 'not_settled' })) : null));
    await E.safely('settle', () => settleRun({ runId, pieceKeys: [...ctx.reservations.keys()] }));
  }
}

async function runPieceReroll({ draftId, pieceKey, pieceRunId, proposalId } = {}) {
  const ctx = newContext(draftId, proposalId, pieceRunId, null);
  let cause = E.NOT_ATTEMPTED.ended;
  const step = pieceKey === 'background' ? 'background' : 'drinks';
  try {
    const held = await S.findReservations(pieceRunId);
    const row = held.find((r) => r.kind === 'image' && r.piece_key === pieceKey);
    if (row) ctx.reservations.set(pieceKey, row.id);
    const draft = await S.loadDraft(draftId, proposalId);
    if (!draft || typeof pieceKey !== 'string') return;
    const inputs = draft.inputs || {};
    const content = draft.content || {};
    const { plan, normalized } = await S.freshPlan(proposalId);
    // After the claim: the reference, and a drink's current background.
    const prepare = async () => {
      Object.assign(ctx, await S.loadReference({ inputs, proposalId, plan, normalized }));
      return pieceKey === 'background' ? {} : S.currentBackground(ctx);
    };
    if (pieceKey === 'background') {
      await drawPiece(ctx, {
        key: pieceKey, kind: 'background', prepare,
        prompt: (p) => backgroundPrompt({
          brief: normalized ? normalized.brief : {}, artDirection: withNote(inputs.art_direction, p.reroll_note), palette: content.palette,
          hasReference: ctx.refs.length > 0,
        }),
      });
    } else {
      const drink = (Array.isArray(content.drinks) ? content.drinks : []).find((d) => d && d.key === pieceKey) || {};
      await drawPiece(ctx, { key: pieceKey, kind: 'drink', prepare, prompt: (p) => drinkPromptFor(drink, p) });
    }
  } catch (err) {
    cause = E.NOT_ATTEMPTED.error;
    E.report(step, E.describe(err));
  } finally {
    // Only this piece: siblings sharing an Update draft run sweep themselves.
    // A missing key sweeps nothing ('' matches no piece).
    await E.safely('sweep', () => S.sweep(ctx, cause, typeof pieceKey === 'string' ? pieceKey : ''));
    await E.safely('settle', () => settleRun({ runId: pieceRunId, pieceKeys: [pieceKey] }));
  }
}

module.exports = {
  runGeneration, runPieceReroll, runWordsForDrinks: W.runWordsForDrinks,
  textModelId: S.textModelId, freshPlan: S.freshPlan, SENTENCES: E.SENTENCES, NOT_ATTEMPTED: E.NOT_ATTEMPTED,
  __setTestHooks: E.__setTestHooks,
};
