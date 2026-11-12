process.env.NODE_ENV = 'test';
// The client mirror of the menu art job's fixed sentences (spec 2026-10-19
// section 16, lane menu-error-display). The card and the editor show a stored
// words_error or a piece's error only when it is one of these sentences, so
// the mirror must hold exactly SENTENCES: a sentence the server adds and the
// mirror lacks would read as the generic line, and a sentence the mirror has
// and the server never writes is a door for text the server did not fix.
// Pure: no DB, no provider; the client file is loaded as the ES module it is.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SENTENCES, NOT_ATTEMPTED } = require('./menuArtJobErrors');

const MIRROR = path.join(__dirname, '../../client/src/pages/admin/menuDesigner/menuArtSentences.js');
const SERVER = path.join(__dirname, 'menuArtJobErrors.js');
const mirror = () => import(pathToFileURL(MIRROR).href);

test('the client mirror holds exactly SENTENCES: the same keys in the same order, the same text, frozen', async () => {
  const C = await mirror();
  assert.deepEqual({ ...C.SENTENCES }, { ...SENTENCES });
  assert.deepEqual(Object.keys(C.SENTENCES), Object.keys(SENTENCES));
  assert.ok(Object.isFrozen(C.SENTENCES));
});

test('isFixedSentence takes each sentence as written and nothing else', async () => {
  const C = await mirror();
  for (const s of Object.values(SENTENCES)) assert.equal(C.isFixedSentence(s), true, s);
  const others = [
    'interrupted', '', ' ', null, undefined, 42, {}, ['x'],
    ...Object.values(NOT_ATTEMPTED),
    `${SENTENCES.wordsBusy} `, SENTENCES.wordsBusy.toLowerCase(), SENTENCES.wordsOutOfCredit.slice(0, -1),
    'Error: 429 You exceeded your current quota, please check your plan and billing details.',
    'constructor', 'toString', 'wordsOutOfCredit',
  ];
  for (const x of others) assert.equal(C.isFixedSentence(x), false, String(x));
});

test('each twin names the other in its header', () => {
  // The leading comment block only, so a mention further down does not count.
  const head = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const end = lines.findIndex((l) => !l.startsWith('//'));
    return lines.slice(0, end === -1 ? lines.length : end).join('\n');
  };
  assert.match(head(MIRROR), /server\/utils\/menuArtJobErrors\.js/);
  assert.match(head(SERVER), /client\/src\/pages\/admin\/menuDesigner\/menuArtSentences\.js/);
});

// Fix round 1, item 1: the allowed set is every fixed text the server can store
// in words_error or a piece's error, not SENTENCES alone.
const E = require('./menuArtJobErrors');
const { OpenAIRefusal, WORDS_REFUSAL_REASON } = require('./openaiClient');
const { MenuArtRefusal, MenuArtRateLimited, MenuArtOutOfCredit, OPENAI_REFUSAL_REASON } = require('./menuImageProvider');
const { MenuWordsInvalid } = require('./menuArtPrompts');
const { MenuKeyOutFailed } = require('./menuKeyOut');
const { ExternalServiceError } = require('./errors');

const WORDS_CODES = ['shape', 'missing_drink', 'extra_drink', 'duplicate_drink', 'bad_title', 'bad_drink',
  'bad_font_pairing', 'bad_palette', 'bad_accent_color', 'bad_background_label'];
// Gemini's reasons come from the wrapper's own export (fix round 2).
const geminiClient = require('./geminiClient');
const GEMINI_REASONS = Array.isArray(geminiClient.REFUSAL_REASONS) ? geminiClient.REFUSAL_REASONS : [];
const { drawImage, GEMINI_REFUSAL_FALLBACK } = require('./menuImageProvider');

// Everything wordsSentence and pieceSentence can return, driven through them.
function everyStoredText() {
  const words = [
    ...WORDS_CODES.map((c) => new MenuWordsInvalid(c)), new OpenAIRefusal(WORDS_REFUSAL_REASON),
    new E.RunLost(null), new Error('x'), Object.assign(new Error('x'), { code: 'MENU_ART_NOT_CONFIGURED' }),
    new ExternalServiceError('openai', new Error('x'), 'y'),
  ].flatMap((err) => [E.wordsSentence(err), E.wordsSentence(err, { sync: true })]);
  const refusals = ['', OPENAI_REFUSAL_REASON, ...GEMINI_REASONS, new MenuKeyOutFailed(null).reason,
    new MenuKeyOutFailed(null, 'image_too_large').reason].map((r) => new MenuArtRefusal(r));
  const pieceErrors = [...refusals, new MenuArtRateLimited(20), new MenuArtOutOfCredit(null), new MenuArtOutOfCredit(null, 'limit'),
    new ExternalServiceError('openai', new Error('x'), 'y'), new Error('x'), { name: 'MenuArtImageUnprocessable' },
    { code: 'MENU_ART_GEMINI_NOT_CONFIGURED' }, { code: 'MENU_ART_REFERENCE_UNREADABLE' }];
  const pieces = ['openai', 'gemini', null].flatMap((p) => pieceErrors.map((err) => E.pieceSentence(err, p)));
  return [...words, ...pieces];
}

test('FIXED_TEXTS holds every text the job can store, provider names expanded, frozen and without repeats', () => {
  assert.ok(Array.isArray(E.FIXED_TEXTS) && Object.isFrozen(E.FIXED_TEXTS));
  assert.equal(new Set(E.FIXED_TEXTS).size, E.FIXED_TEXTS.length);
  for (const text of everyStoredText()) assert.ok(E.FIXED_TEXTS.includes(text), text);
  for (const s of Object.values(SENTENCES)) assert.ok(E.FIXED_TEXTS.includes(s), s);
  for (const t of E.FIXED_TEXTS) assert.doesNotMatch(t, /\$\{|undefined|null/, t);
});

test('the client mirror holds the same FIXED_TEXTS in the same order, and isFixedSentence takes each', async () => {
  const C = await mirror();
  assert.deepEqual([...C.FIXED_TEXTS], [...E.FIXED_TEXTS]);
  assert.ok(Object.isFrozen(C.FIXED_TEXTS));
  for (const t of E.FIXED_TEXTS) assert.equal(C.isFixedSentence(t), true, t);
  for (const t of everyStoredText()) assert.equal(C.isFixedSentence(t), true, t);
});

test('geminiClient exports every refusal reason it throws, readImage\'s own two among them', () => {
  assert.ok(Array.isArray(geminiClient.REFUSAL_REASONS) && Object.isFrozen(geminiClient.REFUSAL_REASONS));
  for (const r of ['Gemini could not finish this image.', 'Gemini answered without a single image.']) {
    assert.ok(GEMINI_REASONS.includes(r), r);
  }
  assert.equal(typeof GEMINI_REFUSAL_FALLBACK, 'string');
  assert.ok(E.FIXED_TEXTS.includes(GEMINI_REFUSAL_FALLBACK), 'the provider fold\'s fallback is a stored text');
});

test('readImage\'s unmatched-failure and no-image paths store a reason in FIXED_TEXTS', async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  const answers = [
    { id: 'int_1', status: 'failed', errors: [{ code: 'something_never_seen' }] },
    { id: 'int_2', status: 'incomplete', errors: [] },
    { id: 'int_3', status: 'completed', steps: [] },
    { id: 'int_4', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: 'AA==' }, { type: 'image', data: 'AA==' }] }] },
  ];
  try {
    for (const answer of answers) {
      geminiClient.__setTestStub({ interactions: { create: async () => answer } });
      await assert.rejects(drawImage({ provider: 'gemini', model: 'm', kind: 'drink', prompt: 'p' }), (err) => {
        assert.ok(err instanceof MenuArtRefusal, answer.id);
        const stored = E.pieceSentence(err, 'gemini');
        assert.ok(E.FIXED_TEXTS.includes(stored), `${answer.id}: ${stored}`);
        return true;
      });
    }
  } finally {
    geminiClient._resetForTest();
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

// Fix round 2, item 2: the words errors a new brief or art direction can cure.
test('BRIEF_FIX_TEXTS is the words refusal and every invalid-reply reason, mirrored on the client', async () => {
  const expected = [WORDS_REFUSAL_REASON, ...WORDS_CODES.map((c) => new MenuWordsInvalid(c).reason)];
  assert.ok(Array.isArray(E.BRIEF_FIX_TEXTS) && Object.isFrozen(E.BRIEF_FIX_TEXTS));
  assert.deepEqual([...E.BRIEF_FIX_TEXTS].sort(), [...new Set(expected)].sort());
  for (const t of E.BRIEF_FIX_TEXTS) assert.ok(E.FIXED_TEXTS.includes(t), t);
  const C = await mirror();
  assert.deepEqual([...C.BRIEF_FIX_TEXTS], [...E.BRIEF_FIX_TEXTS]);
  assert.ok(Object.isFrozen(C.BRIEF_FIX_TEXTS));
});
