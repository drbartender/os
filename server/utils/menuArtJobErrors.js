// What the menu art job (menuArtJob.js) records and says when something goes
// wrong, and its 429 wait (spec 2026-10-01 sections 5.1, 5.5 Retries,
// Refusals and Errors; plan Task E4). Split from the job to keep each file
// short; only the job and its siblings call these.
//
// - describe(err) is the sanitized descriptor: provider, error class, status,
//   request id and code, each kept only when it looks like an identifier,
//   never a message. The ledger's error column and Sentry get only that.
// - Piece errors and words_error are the fixed sentences below, never
//   provider text. A refusal's reason is itself a fixed sentence (the
//   wrappers and menuImageProvider guarantee it). FIXED_TEXTS lists every
//   one of them; it and SENTENCES have a client mirror,
//   client/src/pages/admin/menuDesigner/menuArtSentences.js: the card and the
//   editor show a stored error only when it is in FIXED_TEXTS, so a text
//   added here goes there too (menuArtSentences.test.js pins them equal).
// - withRetries retries a 429 at most twice on the same (still sent)
//   reservation, waiting Retry-After (at most 60 s, 20 s when none was sent)
//   in steps of 10 s with a heartbeat after each. A spent balance or a spend
//   or usage limit (isOutOfCredit: OpenAIOutOfCredit, AnthropicOutOfCredit,
//   MenuArtOutOfCredit) is never retried; on the words step or on any piece
//   it ends the run at once, so the run reports it to Sentry once, and its
//   kind picks the sentence: add credit for a balance, raise the limit for a
//   limit (spec 2026-10-19 section 16).
// - The words run on the provider the stamped model id names (lane
//   menu-words-claude): Anthropic's spent balance and spend limit get their
//   own sentences, its 429 and 529 retry like OpenAI's 429 (wordsLimited),
//   a refusal (AnthropicRefusal) stores its own Brief-tab sentence and is
//   never reported, as OpenAI's is, and any other Anthropic failure stores the
//   plain wordsFailed sentence, never one that names OpenAI.
// - __setTestHooks swaps the wait, the Sentry call and a seam run before each
//   piece is claimed; it refuses under NODE_ENV=production.

const Sentry = require('@sentry/node');
const { ExternalServiceError } = require('./errors');
const { MenuArtRefusal, MenuArtRateLimited, MenuArtOutOfCredit, retrySeconds } = require('./menuImageProvider');
const { OpenAIRefusal, OpenAIRateLimited, OpenAIOutOfCredit, WORDS_REFUSAL_REASON } = require('./openaiClient');
const {
  AnthropicRateLimited, AnthropicOutOfCredit, AnthropicRefusal, WORDS_REFUSAL_REASON: CLAUDE_WORDS_REFUSAL_REASON,
} = require('./anthropicClient');
const { MenuWordsInvalid, REASONS: WORDS_INVALID_REASONS } = require('./menuArtPrompts');
const { OPENAI_REFUSAL_REASON, GEMINI_REFUSAL_FALLBACK } = require('./menuImageProvider');
const { REFUSAL_REASONS: GEMINI_REFUSAL_REASONS } = require('./geminiClient');
const { FAILURE_REASONS: KEY_OUT_REASONS } = require('./menuKeyOut');

const MAX_RETRIES = 2;
const BEAT_EVERY_SEC = 10;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const LABEL = new Map([['openai', 'OpenAI'], ['gemini', 'Gemini']]);

const SENTENCES = Object.freeze({
  noDrinks: 'The drink plan has no drinks to put on the menu.',
  wordsBusy: 'OpenAI is busy right now. Try again in a minute.',
  wordsOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then Generate again.",
  // A billing, spend or usage limit (OpenAIOutOfCredit kind 'limit') is raised
  // in OpenAI's limits settings, not cured by adding credit; each path has one.
  wordsLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then Generate again.",
  // Update draft's words call (runWordsForDrinks): Generate on a live draft
  // is Start over, so this one names Update draft.
  syncWordsOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then try Update draft again.",
  syncWordsLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then try Update draft again.",
  // The words on Claude (AnthropicOutOfCredit; spec 2026-10-19 section 28).
  anthropicWordsOutOfCredit: "Anthropic is out of credit. Add credit in Anthropic's billing settings, then Generate again.",
  anthropicSyncWordsOutOfCredit: "Anthropic is out of credit. Add credit in Anthropic's billing settings, then try Update draft again.",
  anthropicWordsLimit: "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then Generate again.",
  anthropicSyncWordsLimit: "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then try Update draft again.",
  openaiOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then re-roll.",
  openaiLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then re-roll.",
  // Gemini's spent balance reads as a rate limit (geminiClient.mapError), so
  // a piece still refused after both retries says to check billing.
  geminiStillRefusing: "Gemini is still refusing. If this keeps happening, check Gemini's billing.",
  wordsProvider: 'OpenAI could not write the menu words. Try again.',
  wordsFailed: 'The menu words could not be written. Try again.',
  notSetUp: 'Menu art is not set up.',
  referenceUnavailable: 'The reference image is unavailable. Start over without it or upload it again.',
  referenceUnreadable: 'The reference image could not be read. Start over with a different one.',
  backgroundUnavailable: 'The background image could not be read. Re-roll this drink in a moment.',
  noProvider: 'This piece has no image model. Re-roll it.',
  geminiOff: 'Gemini is not set up.',
  notReserved: 'This piece was not reserved. Re-roll it.',
  unprocessable: 'The drawn image could not be processed. Re-roll it.',
  saveFailed: 'The drawn image could not be saved. Re-roll it.',
  drawFailed: 'Something went wrong drawing this image. Re-roll it.',
});
// pieceSentence's per-provider sentences, one definition each, so FIXED_TEXTS
// can expand them for every name it may print.
const PIECE_TEMPLATES = Object.freeze({
  blocked: (who) => `${who} blocked this image.`,
  busy: (who) => `${who} is busy right now. Re-roll in a minute.`,
  couldNotDraw: (who) => `${who} could not draw this image. Re-roll it.`,
});
const DEFAULT_WHO = 'The image service';
// Every fixed text the job can store in words_error or a piece's error: the
// SENTENCES, the wrappers' refusal reasons, the invalid-words reasons, the
// key-out reasons and pieceSentence's templates for each provider name. The
// card and the editor show a stored error only when it is one of these
// (client mirror: client/src/pages/admin/menuDesigner/menuArtSentences.js).
const FIXED_TEXTS = Object.freeze([...new Set([
  ...Object.values(SENTENCES),
  WORDS_REFUSAL_REASON,
  CLAUDE_WORDS_REFUSAL_REASON,
  ...WORDS_INVALID_REASONS.values(),
  OPENAI_REFUSAL_REASON,
  ...GEMINI_REFUSAL_REASONS,
  GEMINI_REFUSAL_FALLBACK,
  ...Object.values(KEY_OUT_REASONS),
  ...[...LABEL.values(), DEFAULT_WHO].flatMap((who) => Object.values(PIECE_TEMPLATES).map((t) => t(who))),
])]);
// The words errors a new brief or art direction can cure (a refusal, an
// invalid reply), where the card also offers the editor's Brief tab.
const BRIEF_FIX_TEXTS = Object.freeze([WORDS_REFUSAL_REASON, CLAUDE_WORDS_REFUSAL_REASON, ...WORDS_INVALID_REASONS.values()]);
const NOT_ATTEMPTED = Object.freeze({
  words: 'not attempted: the words step failed',
  error: 'not attempted: the run stopped on an error',
  ended: 'not attempted: the run ended before this piece',
});
// A billed call whose run was superseded before its result could be kept.
const SUPERSEDED = Object.freeze({ provider: null, errorClass: 'RunSuperseded', status: null, requestId: null, code: 'superseded' });

const DEFAULT_HOOKS = Object.freeze({
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  capture: (err, context) => Sentry.captureException(err, context),
  beforePiece: null,
});
const hooks = { ...DEFAULT_HOOKS };

// Every call resets what it omits.
function __setTestHooks(next = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('menuArtJob: test hooks are test-only');
  hooks.sleep = next.sleep || DEFAULT_HOOKS.sleep;
  hooks.capture = next.capture || DEFAULT_HOOKS.capture;
  hooks.beforePiece = next.beforePiece || null;
}

const safe = (v) => (typeof v === 'string' && SAFE_ID.test(v) ? v : null);

function describe(err, provider = null) {
  const d = err && err.descriptor && typeof err.descriptor === 'object' ? err.descriptor : {};
  let status = Number.isInteger(d.status) ? d.status : null;
  if (status === null && err && Number.isInteger(err.statusCode)) status = err.statusCode;
  return {
    provider: safe(d.provider) || provider,
    errorClass: safe(d.errorClass) || safe(err && err.name) || 'Error',
    status,
    requestId: safe(d.requestId),
    code: safe(d.code) || safe(err && err.code),
  };
}

// Every descriptor is re-sanitized where it leaves (the ledger and Sentry),
// so a field filled in after describe() (a request id) passes the same filter.
const clean = (d) => ({
  provider: safe(d.provider), errorClass: safe(d.errorClass) || 'Error',
  status: Number.isInteger(d.status) ? d.status : null, requestId: safe(d.requestId), code: safe(d.code),
});

// markCall's options for a failed call: the descriptor as the error string.
function failedCall(d, extra = {}) {
  const c = clean(d);
  return { ...extra, error: JSON.stringify(c), requestId: c.requestId || extra.requestId || null };
}

// Sentry gets a fresh error built from the descriptor alone, never the
// original (whose message can quote a prompt or a client's brief).
function report(step, d) {
  const c = clean(d);
  const summary = [c.provider, c.errorClass, c.status, c.requestId, c.code]
    .filter((v) => v !== null && v !== undefined && v !== '').join(' ');
  const err = Object.assign(new Error(summary || 'menu art job failure'), { name: 'MenuArtJobError' });
  try {
    hooks.capture(err, { tags: { area: 'menuArt', step }, extra: { descriptor: c } });
  } catch { /* reporting never breaks the job */ }
}

// For the end-of-run statements: each runs even when another fails.
async function safely(step, fn) {
  try { await fn(); } catch (err) { report(step, describe(err)); }
}

const isRefusal = (err) => err instanceof MenuArtRefusal || err instanceof OpenAIRefusal || err instanceof AnthropicRefusal;

function pieceSentence(err, provider) {
  const who = LABEL.get(provider) || DEFAULT_WHO;
  if (err instanceof MenuArtRefusal) {
    return typeof err.reason === 'string' && err.reason ? err.reason.slice(0, 300) : PIECE_TEMPLATES.blocked(who);
  }
  // Only OpenAI's spent balance or limit is told apart (menuImageProvider).
  if (err instanceof MenuArtOutOfCredit) return err.kind === 'limit' ? SENTENCES.openaiLimit : SENTENCES.openaiOutOfCredit;
  if (err instanceof MenuArtRateLimited) {
    return provider === 'gemini' ? SENTENCES.geminiStillRefusing : PIECE_TEMPLATES.busy(who);
  }
  if (err && err.name === 'MenuArtImageUnprocessable') return SENTENCES.unprocessable;
  if (err && err.code === 'MENU_ART_GEMINI_NOT_CONFIGURED') return SENTENCES.geminiOff;
  if (err && err.code === 'MENU_ART_REFERENCE_UNREADABLE') return SENTENCES.referenceUnreadable;
  if (err instanceof ExternalServiceError) return PIECE_TEMPLATES.couldNotDraw(who);
  return SENTENCES.drawFailed;
}

// sync: the Update draft words call (runWordsForDrinks), not Generate's.
function wordsSentence(err, { sync = false } = {}) {
  if (err instanceof MenuWordsInvalid || err instanceof OpenAIRefusal || err instanceof AnthropicRefusal) return err.reason;
  if (err instanceof OpenAIOutOfCredit && err.kind === 'limit') return sync ? SENTENCES.syncWordsLimit : SENTENCES.wordsLimit;
  if (err instanceof OpenAIOutOfCredit) return sync ? SENTENCES.syncWordsOutOfCredit : SENTENCES.wordsOutOfCredit;
  if (err instanceof AnthropicOutOfCredit && err.kind === 'limit') {
    return sync ? SENTENCES.anthropicSyncWordsLimit : SENTENCES.anthropicWordsLimit;
  }
  if (err instanceof AnthropicOutOfCredit) return sync ? SENTENCES.anthropicSyncWordsOutOfCredit : SENTENCES.anthropicWordsOutOfCredit;
  if (err instanceof OpenAIRateLimited) return SENTENCES.wordsBusy;
  if (err && err.code === 'MENU_ART_NOT_CONFIGURED') return SENTENCES.notSetUp;
  // wordsProvider names OpenAI, so Anthropic's own failures (a third busy
  // answer included) read the plain sentence.
  if (err instanceof ExternalServiceError && err.service !== 'anthropic') return SENTENCES.wordsProvider;
  return SENTENCES.wordsFailed;
}

class RunLost extends Error {
  constructor(cause) {
    super('The run is no longer current.');
    this.name = 'RunLost';
    this.descriptor = cause && cause.descriptor ? cause.descriptor : null;
  }
}

// Sleeps in steps of at most 10 seconds, refreshing the heartbeats after each
// (the last refresh is the one before the retried call). False when beat()
// says the run or the piece was lost meanwhile.
async function waitBeating(seconds, beat) {
  let left = seconds;
  while (left > 0) {
    const step = Math.min(BEAT_EVERY_SEC, left);
    await hooks.sleep(step * 1000);
    left -= step;
    if (!(await beat())) return false;
  }
  return true;
}

const isOutOfCredit = (err) => err instanceof OpenAIOutOfCredit || err instanceof AnthropicOutOfCredit
  || err instanceof MenuArtOutOfCredit;

// Any other error, a spent balance whatever isLimited says, or a third 429,
// is thrown. RunLost: lost during a wait.
async function withRetries(call, isLimited, beat) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (isOutOfCredit(err) || !isLimited(err) || attempt >= MAX_RETRIES) throw err;
      if (!(await waitBeating(retrySeconds(err.retryAfterSec), beat))) throw new RunLost(err);
    }
  }
}

const imageLimited = (err) => err instanceof MenuArtRateLimited;
const wordsLimited = (err) => err instanceof OpenAIRateLimited || err instanceof AnthropicRateLimited;

module.exports = {
  SENTENCES, FIXED_TEXTS, BRIEF_FIX_TEXTS, NOT_ATTEMPTED, SUPERSEDED, MAX_RETRIES, hooks, __setTestHooks,
  describe, failedCall, report, safely, isRefusal, isOutOfCredit, pieceSentence, wordsSentence,
  RunLost, withRetries, imageLimited, wordsLimited,
};
