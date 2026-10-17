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
//   wrappers and menuImageProvider guarantee it).
// - withRetries retries a 429 at most twice on the same (still sent)
//   reservation, waiting Retry-After (at most 60 s, 20 s when none was sent)
//   in steps of 10 s with a heartbeat after each.
// - __setTestHooks swaps the wait, the Sentry call and a seam run before each
//   piece is claimed; it refuses under NODE_ENV=production.

const Sentry = require('@sentry/node');
const { ExternalServiceError } = require('./errors');
const { MenuArtRefusal, MenuArtRateLimited, retrySeconds } = require('./menuImageProvider');
const { OpenAIRefusal, OpenAIRateLimited } = require('./openaiClient');
const { MenuWordsInvalid } = require('./menuArtPrompts');

const MAX_RETRIES = 2;
const BEAT_EVERY_SEC = 10;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const LABEL = new Map([['openai', 'OpenAI'], ['gemini', 'Gemini']]);

const SENTENCES = Object.freeze({
  noDrinks: 'The drink plan has no drinks to put on the menu.',
  wordsBusy: 'OpenAI is busy right now. Try again in a minute.',
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

const isRefusal = (err) => err instanceof MenuArtRefusal || err instanceof OpenAIRefusal;

function pieceSentence(err, provider) {
  const who = LABEL.get(provider) || 'The image service';
  if (err instanceof MenuArtRefusal) {
    return typeof err.reason === 'string' && err.reason ? err.reason.slice(0, 300) : `${who} blocked this image.`;
  }
  if (err instanceof MenuArtRateLimited) return `${who} is busy right now. Re-roll in a minute.`;
  if (err && err.name === 'MenuArtImageUnprocessable') return SENTENCES.unprocessable;
  if (err && err.code === 'MENU_ART_GEMINI_NOT_CONFIGURED') return SENTENCES.geminiOff;
  if (err && err.code === 'MENU_ART_REFERENCE_UNREADABLE') return SENTENCES.referenceUnreadable;
  if (err instanceof ExternalServiceError) return `${who} could not draw this image. Re-roll it.`;
  return SENTENCES.drawFailed;
}

function wordsSentence(err) {
  if (err instanceof MenuWordsInvalid || err instanceof OpenAIRefusal) return err.reason;
  if (err instanceof OpenAIRateLimited) return SENTENCES.wordsBusy;
  if (err && err.code === 'MENU_ART_NOT_CONFIGURED') return SENTENCES.notSetUp;
  if (err instanceof ExternalServiceError) return SENTENCES.wordsProvider;
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

// Any other error, or a third 429, is thrown. RunLost: lost during a wait.
async function withRetries(call, isLimited, beat) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (!isLimited(err) || attempt >= MAX_RETRIES) throw err;
      if (!(await waitBeating(retrySeconds(err.retryAfterSec), beat))) throw new RunLost(err);
    }
  }
}

const imageLimited = (err) => err instanceof MenuArtRateLimited;
const wordsLimited = (err) => err instanceof OpenAIRateLimited;

module.exports = {
  SENTENCES, NOT_ATTEMPTED, SUPERSEDED, MAX_RETRIES, hooks, __setTestHooks,
  describe, failedCall, report, safely, isRefusal, pieceSentence, wordsSentence,
  RunLost, withRetries, imageLimited, wordsLimited,
};
