process.env.NODE_ENV = 'test';
require('dotenv').config();
// menuArtJob.js (spec 2026-10-01 sections 5.3, 5.4, 5.5, 6 Writers; plan Task
// E4). Live on the shared dev DB: one temp proposal with its drink plan and its
// draft, rebuilt per test the way Generate, re-roll and Update draft build them
// (lockCalls first, the reservations through menuArtCap). Both provider
// wrappers are stubbed at the SDK-client level (__setTestStub), R2 through
// require.cache BEFORE the job loads, and global fetch is a tripwire, so no
// provider and no R2 is ever reached. The stub outputs are real sharp-made
// images, so the real key-out, tone read and downscales run. The cap counts the
// ledger GLOBALLY, so the cap env is set relative to the current count. Rows
// are removed by the ids and run ids recorded here, never by a pattern.
//
// Run: node --test server/utils/menuArtJob.test.js
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');

// ── Stub R2 before anything requires storage ────────────────────────────────
const storagePath = require.resolve('./storage');
const realStorage = require('./storage');
const { NotFoundError, ExternalServiceError } = require('./errors');

const r2 = new Map();
const uploads = [];
const reads = [];
let uploadFails = () => false;
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, key) => {
    if (uploadFails(key)) throw new ExternalServiceError('r2', new Error('stub outage'), 'File storage is temporarily unavailable.');
    uploads.push(key);
    r2.set(key, { buffer, contentType: key.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  },
  readFile: async (key) => {
    reads.push(key);
    const file = r2.get(key);
    if (!file) throw new NotFoundError('File not found.');
    return file;
  },
  getSignedUrl: async () => { throw new Error('menuArtJob.test: nothing may presign'); },
};

const { pool } = require('../db');
const openaiClient = require('./openaiClient');
const geminiClient = require('./geminiClient');
const cap = require('./menuArtCap');
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint } = require('./menuDrinkSource');
const { OPENAI_REFUSAL_REASON, prepareReferences } = require('./menuImageProvider');
const { DRINK_MAGENTA_KEY, DRINK_TRANSPARENT, BACKGROUND_STYLE_REF } = require('./menuArtImagePrompts');
const job = require('./menuArtJob');
const steps = require('./menuArtJobSteps');

const { SENTENCES, NOT_ATTEMPTED } = job;
const NONCE = crypto.randomBytes(4).toString('hex');
const DRINKS = ['Alpha', 'Bravo', 'Charlie'].map((n) => `Zq ${n} ${NONCE}`);
const KEYS = DRINKS.map((n) => `custom:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
const MODEL = { openai: 'stamped-gpt-image', gemini: 'stamped-gemini-image' };
const TEXT_MODEL = 'stamped-text-model';
const KEYOUT_REASON = "Gemini didn't leave a clean background. Re-roll it.";
const SECRET = `SECRET-${NONCE}`;
const ENV_KEYS = ['GEMINI_API_KEY', 'MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const runIds = [];
const proposalIds = [];
const draftIds = [];
let proposalId = null;
let planId = null;
let draftId = null;
let realFetch = null;
let tripwire = 0;
const img = {};
const calls = { words: [], openai: [], gemini: [] };
const captured = [];
const sleeps = [];
let onSleep = null;

// ── Images ──────────────────────────────────────────────────────────────────
const canvas = (w, h, background, channels = 3) => sharp({ create: { width: w, height: h, channels, background } });
async function drinkOn(background, format) {
  const block = await canvas(410, 512, { r: 20, g: 110, b: 120 }).png().toBuffer();
  const c = canvas(1024, 1024, background, background.alpha === undefined ? 3 : 4)
    .composite([{ input: block, left: 307, top: 256 }]);
  return (format === 'png' ? c.png() : c.jpeg({ quality: 90 })).toBuffer();
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function selections(count, extra = {}) {
  return {
    menuStyle: 'custom', menuTheme: 'Garden party in sage and gold', drinkNaming: '', menuDesignNotes: 'Soft watercolor',
    customCocktails: DRINKS.slice(0, count), ...extra,
  };
}

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cap.lockCalls(client);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const newRun = () => { const id = crypto.randomUUID(); runIds.push(id); return id; };

// What Generate commits (plan E6): the draft upserted in place with a fresh
// run_id and the words reset to pending, the old pieces replaced by pending
// ones (the background plus the first 8 drinks) stamped with the provider and
// model, one text reservation and one image reservation per piece.
async function generate({ provider = 'openai', drinks = 2, inputs = {}, planExtra = {} } = {}) {
  await pool.query('UPDATE drink_plans SET selections = $2 WHERE id = $1', [planId, selections(drinks, planExtra)]);
  const normalized = normalizePlan(await loadEventPlan(proposalId), await loadCatalogMaps());
  const runId = newRun();
  const keys = ['background', ...normalized.drinks.slice(0, 8).map((d) => d.key)];
  const draftInputs = {
    planner_image_role: 'ignore', reference_source: 'none', art_direction: 'Loose watercolor', drb_mark: true,
    image_model: provider, ...inputs,
  };
  const content = { words_status: 'pending', words_heartbeat_at: new Date().toISOString() };
  const ids = await inTx(async (client) => {
    await cap.releaseProposalReserved(client, { proposalId });
    const { rows } = await client.query(
      `INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (proposal_id) DO UPDATE
         SET run_id = EXCLUDED.run_id, inputs = EXCLUDED.inputs, content = EXCLUDED.content,
             plan_fingerprint = EXCLUDED.plan_fingerprint, version = menu_drafts.version + 1
       RETURNING id`,
      [proposalId, planId, runId, draftInputs, content, buildFingerprint(normalized)]);
    draftId = rows[0].id;
    if (!draftIds.includes(draftId)) draftIds.push(draftId);
    await client.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1', [draftId]);
    await client.query(
      `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, provider, model)
       SELECT $1, k, $2, 'pending', $3, $4 FROM unnest($5::text[]) AS k`,
      [draftId, runId, provider, MODEL[provider], keys]);
    const textId = await cap.reserveText(client, { proposalId, runId, model: TEXT_MODEL });
    const imageIds = await cap.reserveImages(client, { proposalId, runId, pieceKeys: keys, provider, model: MODEL[provider] });
    return { textId, imageIds };
  });
  await pool.query('UPDATE menu_drafts SET art_version = 0 WHERE id = $1', [draftId]);
  return { runId, keys, ...ids };
}

// What re-roll commits: one reservation under a new piece run, the piece
// pending under that run with the posted provider, its model and the note.
// Update draft does the same for its added drinks, which may share one run.
async function stageReroll(pieceKeys, { provider, note = null, model = MODEL[provider] }) {
  const pieceRunId = newRun();
  await inTx(async (client) => {
    await cap.reserveImages(client, { proposalId, runId: pieceRunId, pieceKeys, provider, model: MODEL[provider] });
    await client.query(
      `UPDATE menu_draft_pieces SET run_id = $3, status = 'pending', provider = $4, model = $5, reroll_note = $6, heartbeat_at = NOW()
        WHERE draft_id = $1 AND piece_key = ANY($2::text[])`, [draftId, pieceKeys, pieceRunId, provider, model, note]);
  });
  return pieceRunId;
}
const runReroll = (pieceKey, pieceRunId) => job.runPieceReroll({ draftId, pieceKey, pieceRunId, proposalId });
async function reroll(pieceKey, opts) {
  const pieceRunId = await stageReroll([pieceKey], opts);
  await runReroll(pieceKey, pieceRunId);
  return pieceRunId;
}

const run = (g) => job.runGeneration({ draftId, runId: g.runId, proposalId });
async function pieceMap() {
  const { rows } = await pool.query(
    `SELECT piece_key, run_id, status, error, provider, model, r2_key, tone, ground_rgb, drawn_count, heartbeat_at
       FROM menu_draft_pieces WHERE draft_id = $1`, [draftId]);
  return Object.fromEntries(rows.map((r) => [r.piece_key, r]));
}
const draftRow = async () => (await pool.query('SELECT run_id, content, art_version FROM menu_drafts WHERE id = $1', [draftId])).rows[0];
const ledger = async (runId) => (await pool.query(
  `SELECT id, piece_key, kind, status, provider, model, size, error, provider_request_id
     FROM menu_art_calls WHERE run_id = $1 ORDER BY id`, [runId])).rows;
const byKey = (rows) => Object.fromEntries(rows.filter((r) => r.kind === 'image').map((r) => [r.piece_key, r]));
async function assertSettled(runId) {
  for (const row of await ledger(runId)) {
    assert.ok(['ok', 'failed', 'released'].includes(row.status), `ledger row ${row.piece_key || 'text'} ended ${row.status}`);
  }
}

// ── Provider stubs ──────────────────────────────────────────────────────────
function wordsReply(body) {
  const req = JSON.parse(body.input);
  const json = {
    title: 'Garden Bar',
    drinks: req.drinks.map((d) => ({
      key: d.key, display_name: d.name, name_ai_suggested: false,
      description: d.needs_description ? `A bright pour of ${d.name}` : null, visual_note: `a coupe of ${d.name}`,
    })),
    font_pairing: 'elegant-script', palette: [{ name: 'sage', hex: '#9caf88' }], accent_color: '#9caf88',
    background_label: 'Pastel garden',
  };
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], _request_id: 'req_words' };
}

function stubOpenAI({ words, image } = {}) {
  const reply = async (op, body) => {
    calls.openai.push({ op, body });
    const n = calls.openai.length;
    const kind = body.size === '1024x1024' ? 'drink' : 'background';
    const out = image ? await image({ op, body, kind, n }) : null;
    const buffer = out || (kind === 'drink' ? img.openaiDrink : img.openaiBackground);
    return { data: [{ b64_json: buffer.toString('base64') }], _request_id: `req_${kind}_${n}` };
  };
  openaiClient.__setTestStub({
    responses: {
      create: async (body) => {
        calls.words.push(body);
        return words ? words(body, calls.words.length) : wordsReply(body);
      },
    },
    images: { generate: (b) => reply('generate', b), edit: (b) => reply('edit', b) },
  });
}

function stubGemini(answer) {
  geminiClient.__setTestStub({
    interactions: {
      create: async (params) => {
        calls.gemini.push(params);
        const n = calls.gemini.length;
        const kind = params.response_format.aspect_ratio === '1:1' ? 'drink' : 'background';
        const out = answer ? await answer({ params, kind, n }) : null;
        const buffer = out || (kind === 'drink' ? img.geminiDrink : img.geminiBackground);
        return {
          id: `int_${kind}_${n}`, status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'image', data: buffer.toString('base64'), mime_type: 'image/jpeg' }] }],
        };
      },
    },
  });
}

const httpError = (status, extra = {}) => Object.assign(new Error(`provider said: ${SECRET}`), { status, ...extra });
const rateLimited = (retryAfter) => httpError(429, {
  headers: new globalThis.Headers(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
});
const imageCount = (body) => (Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0);
const openaiCallsFor = (kind) => calls.openai.filter((c) => (c.body.size === '1024x1024') === (kind === 'drink'));

function hooks(extra = {}) {
  job.__setTestHooks({
    sleep: async (ms) => { sleeps.push(ms); if (onSleep) await onSleep(ms); },
    capture: (err, context) => { captured.push({ err, context }); },
    ...extra,
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  img.openaiBackground = await canvas(2560, 3200, { r: 20, g: 30, b: 70 }).jpeg().toBuffer();
  img.openaiDrink = await drinkOn({ r: 0, g: 0, b: 0, alpha: 0 }, 'png');
  img.geminiBackground = await canvas(3712, 4608, { r: 240, g: 230, b: 210 }).jpeg().toBuffer();
  img.geminiDrink = await drinkOn({ r: 255, g: 0, b: 255 }, 'jpeg');
  img.geminiNoKey = await canvas(1024, 1024, { r: 20, g: 110, b: 120 }).jpeg().toBuffer();
  img.reference = await canvas(600, 400, { r: 200, g: 170, b: 90 }).png().toBuffer();

  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  const { rows } = await pool.query(
    `SELECT kind, COUNT(*)::int AS n FROM menu_art_calls
      WHERE status <> 'released' AND created_at > NOW() - interval '24 hours' GROUP BY kind`);
  const used = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  process.env.MENU_ART_DAILY_IMAGE_CAP = String((used.image || 0) + 1000);
  process.env.MENU_ART_DAILY_TEXT_CAP = String((used.text || 0) + 1000);

  const p = await pool.query("INSERT INTO proposals (status, event_type) VALUES ('draft', 'birthday-party') RETURNING id");
  proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const plan = await pool.query(
    "INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', $2) RETURNING id",
    [proposalId, selections(2)]);
  planId = plan.rows[0].id;
});

after(async () => {
  job.__setTestHooks({});
  openaiClient._resetForTest();
  geminiClient._resetForTest();
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (runIds.length) await pool.query('DELETE FROM menu_art_calls WHERE run_id = ANY($1::uuid[])', [runIds]);
  if (draftIds.length) await pool.query('DELETE FROM menu_drafts WHERE id = ANY($1::int[])', [draftIds]);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  await pool.end();
});

beforeEach(() => {
  for (const list of [calls.words, calls.openai, calls.gemini, captured, sleeps, uploads, reads]) list.length = 0;
  uploadFails = () => false;
  onSleep = null;
  tripwire = 0;
  hooks();
  stubOpenAI();
  stubGemini();
});

afterEach(() => {
  assert.equal(tripwire, 0, 'a request reached global fetch');
});

// ── Generate ────────────────────────────────────────────────────────────────

test('happy path: the words, the background and two drinks land, art_version 3, each drawn once', async () => {
  const g = await generate();
  await run(g);
  const draft = await draftRow();
  assert.equal(draft.content.words_status, 'done');
  assert.equal(draft.content.words_error, null);
  assert.ok(draft.content.words_heartbeat_at, 'the words heartbeat is kept');
  assert.equal(draft.content.title, 'Garden Bar');
  assert.deepEqual(draft.content.drinks.map((d) => [d.key, d.has_art, d.added_by_sync]), [[KEYS[0], true, false], [KEYS[1], true, false]]);
  assert.equal(draft.art_version, 3);

  const pieces = await pieceMap();
  for (const key of g.keys) {
    assert.equal(pieces[key].status, 'done', key);
    assert.equal(pieces[key].drawn_count, 1, key);
    assert.equal(pieces[key].error, null, key);
  }
  const prefix = `menu-art/${proposalId}/${g.runId}/`;
  assert.match(pieces.background.r2_key, new RegExp(`^${prefix}background-[0-9a-f-]{36}\\.jpg$`));
  assert.match(pieces[KEYS[0]].r2_key, new RegExp(`^${prefix}${KEYS[0].replace(':', '-')}-[0-9a-f-]{36}\\.png$`));
  assert.equal(pieces.background.tone, 'dark', 'the navy background reads dark');
  assert.match(pieces.background.ground_rgb, /^\d+,\d+,\d+$/);
  assert.equal(pieces[KEYS[0]].tone, null, 'tone is the background only');

  assert.equal(calls.words.length, 1);
  assert.equal(calls.words[0].model, TEXT_MODEL, 'the words model stamped on the text reservation');
  assert.equal(JSON.parse(calls.words[0].input).event_type, 'Birthday Party');
  const [bg, ...drinkCalls] = calls.openai;
  assert.equal(bg.op, 'generate', 'no reference: the background is a plain generate');
  assert.ok(!bg.body.prompt.includes(BACKGROUND_STYLE_REF), 'no reference, no style-reference clause');
  assert.equal(bg.body.model, MODEL.openai);
  assert.match(bg.body.prompt, /Loose watercolor/);
  assert.match(bg.body.prompt, /sage \(#9caf88\)/, 'the words step palette feeds the background');
  assert.equal(drinkCalls.length, 2);
  for (const c of drinkCalls) {
    assert.equal(c.op, 'edit');
    assert.equal(imageCount(c.body), 1, 'the background, downscaled, is the drink style reference');
    assert.ok(c.body.prompt.includes(DRINK_TRANSPARENT));
  }
  assert.match(drinkCalls[0].body.prompt, new RegExp(`a coupe of ${DRINKS[0]}`));
  assert.equal(reads.length, 0, 'the background is passed from memory, never re-read');

  const rows = await ledger(g.runId);
  assert.equal(rows.length, 4, 'one text row and one image row per piece');
  const text = rows.find((r) => r.kind === 'text');
  assert.deepEqual([text.status, text.provider_request_id, text.model], ['ok', 'req_words', TEXT_MODEL]);
  for (const r of rows.filter((x) => x.kind === 'image')) {
    assert.deepEqual([r.status, r.provider, r.model], ['ok', 'openai', MODEL.openai], r.piece_key);
    assert.match(r.provider_request_id, /^req_(background|drink)_\d$/);
  }
  assert.equal(byKey(rows).background.size, '2560x3200');
  assert.equal(captured.length, 0);
});

test('an uploaded reference inside its prefix is read once per run and sent with every image', async () => {
  const refKey = `menu-art/${proposalId}/ref-${NONCE}.png`;
  r2.set(refKey, { buffer: img.reference, contentType: 'image/png' });
  const g = await generate({ inputs: { reference_source: 'upload', reference_key: refKey } });
  await run(g);
  assert.deepEqual(reads, [refKey]);
  assert.equal(calls.openai[0].op, 'edit');
  assert.equal(imageCount(calls.openai[0].body), 1, 'the background gets the reference');
  assert.deepEqual(calls.openai.slice(1).map((c) => imageCount(c.body)), [2, 2], 'each drink gets the background and the reference');
  assert.ok(Object.values(await pieceMap()).every((p) => p.status === 'done'));
  await assertSettled(g.runId);
});

test('a reference rides re-encoded with no metadata, only the prepared copy is kept, and the background prompt says style only', async () => {
  const tagged = await canvas(600, 400, { r: 200, g: 170, b: 90 }).withExif({ IFD0: { Artist: `Owner ${SECRET}` } }).jpeg().toBuffer();
  assert.ok(tagged.includes(SECRET), 'the fixture carries an owner name');
  const refKey = `menu-art/${proposalId}/ref-${NONCE}-tagged.jpg`;
  r2.set(refKey, { buffer: tagged, contentType: 'image/jpeg' });
  const inputs = { reference_source: 'upload', reference_key: refKey };

  const { refs } = await steps.loadReference({ inputs, proposalId });
  assert.equal(refs.length, 1);
  assert.notEqual(refs[0].buffer, tagged, 'the stored original is not what the run holds');
  assert.equal((await sharp(refs[0].buffer).metadata()).exif, undefined);
  assert.equal((await prepareReferences(refs))[0], refs[0], 'the held copy is final: never re-encoded per call');

  const g = await generate({ provider: 'gemini', inputs });
  await run(g);
  assert.ok(calls.gemini[0].input[0].text.includes(BACKGROUND_STYLE_REF), 'Gemini: the background says style only');
  for (const c of calls.gemini) {
    for (const part of c.input.filter((b) => b.type === 'image')) {
      assert.ok(!Buffer.from(part.data, 'base64').includes(SECRET), 'no owner name reaches the provider');
    }
  }
  await reroll('background', { provider: 'openai' });
  assert.ok(calls.openai.at(-1).body.prompt.includes(BACKGROUND_STYLE_REF), 'OpenAI: a background re-roll with the reference says it too');
  await assertSettled(g.runId);
});

test('an event deleted before its job starts: the reservations are found by run alone and released, nothing is called', async () => {
  const saved = { proposalId, planId, draftId };
  const p = await pool.query("INSERT INTO proposals (status, event_type) VALUES ('draft', 'birthday-party') RETURNING id");
  proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  planId = (await pool.query("INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', $2) RETURNING id",
    [proposalId, selections(2)])).rows[0].id;
  let g;
  let doomed;
  try {
    g = await generate();
    doomed = { draftId, proposalId };
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  } finally {
    ({ proposalId, planId, draftId } = saved);
  }
  const held = (await pool.query('SELECT status, proposal_id FROM menu_art_calls WHERE run_id = $1', [g.runId])).rows;
  assert.equal(held.length, 4);
  assert.ok(held.every((r) => r.status === 'reserved' && r.proposal_id === null), 'ON DELETE SET NULL cleared the event');
  await job.runGeneration({ draftId: doomed.draftId, runId: g.runId, proposalId: doomed.proposalId });
  assert.deepEqual((await ledger(g.runId)).map((r) => r.status), ['released', 'released', 'released', 'released']);
  assert.equal(calls.words.length + calls.openai.length + calls.gemini.length, 0);
});

test('has_art follows the pieces Generate reserved, not the plan re-read after it committed', async () => {
  const g = await generate({ drinks: 2 });
  // The plan gains a drink at the front between Generate's COMMIT and the job.
  await pool.query('UPDATE drink_plans SET selections = $2 WHERE id = $1',
    [planId, selections(0, { customCocktails: [DRINKS[2], DRINKS[0], DRINKS[1]] })]);
  await run(g);
  const draft = await draftRow();
  assert.deepEqual(draft.content.drinks.map((d) => [d.key, d.has_art]), [[KEYS[2], false], [KEYS[0], true], [KEYS[1], true]]);
  const pieces = await pieceMap();
  assert.equal(pieces[KEYS[2]], undefined, 'no piece, so no art');
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[1]].status], ['done', 'done']);
  assert.equal(openaiCallsFor('drink').length, 2);
  await assertSettled(g.runId);
});

test('a drink a PATCH turned off or hid after the words landed is skipped; its reservation is released, unsent', async () => {
  const g = await generate({ drinks: 3 });
  hooks({
    beforePiece: async (key) => {
      if (key !== KEYS[0]) return;
      const { content } = await draftRow();
      const drinks = content.drinks.map((d) => {
        if (d.key === KEYS[1]) return { ...d, has_art: false };
        return d.key === KEYS[2] ? { ...d, hidden: true } : d;
      });
      await pool.query(
        `UPDATE menu_drafts SET content = content || jsonb_build_object('drinks', $2::jsonb), version = version + 1
          WHERE id = $1`, [draftId, JSON.stringify(drinks)]);
    },
  });
  await run(g);
  const pieces = await pieceMap();
  assert.equal(pieces[KEYS[0]].status, 'done');
  for (const key of [KEYS[1], KEYS[2]]) assert.deepEqual([pieces[key].status, pieces[key].error], ['failed', NOT_ATTEMPTED.ended], key);
  const rows = byKey(await ledger(g.runId));
  assert.deepEqual([rows[KEYS[0]].status, rows[KEYS[1]].status, rows[KEYS[2]].status], ['ok', 'released', 'released']);
  assert.equal(openaiCallsFor('drink').length, 1, 'only the drink still on the menu with art is drawn');
});

test('a reference key outside its prefix fails every image piece with no read and no image call', async () => {
  const other = proposalId + 100000;
  const variants = [
    { inputs: { reference_source: 'upload', reference_key: `menu-art/${other}/ref-${NONCE}.png` } },
    { inputs: { reference_source: 'upload', reference_key: `menu-art/${proposalId}/ref-../../w9/${NONCE}.pdf` } },
    { inputs: { reference_source: 'planner', planner_image_role: 'reference' }, planExtra: { _logoFilename: `drink-plan-logos/${planId + 1}-x.png` } },
  ];
  for (const v of variants) r2.set(v.inputs.reference_key || v.planExtra._logoFilename, { buffer: img.reference, contentType: 'image/png' });
  for (const v of variants) {
    calls.openai.length = 0;
    reads.length = 0;
    captured.length = 0;
    const g = await generate(v);
    await run(g);
    assert.equal(calls.openai.length, 0, 'no image call');
    assert.equal(reads.length, 0, 'the key is never read');
    const pieces = await pieceMap();
    for (const key of g.keys) assert.deepEqual([pieces[key].status, pieces[key].error], ['failed', SENTENCES.referenceUnavailable], key);
    const rows = await ledger(g.runId);
    assert.equal(rows.find((r) => r.kind === 'text').status, 'ok', 'the words still landed');
    assert.ok(rows.filter((r) => r.kind === 'image').every((r) => r.status === 'released'), 'never sent, so released');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].context.extra.descriptor.code, 'key_outside_prefix');
  }
});

test('the planner image under drink-plan-logos/<planId>- is the reference when its role is reference', async () => {
  const logo = `drink-plan-logos/${planId}-${NONCE}.png`;
  r2.set(logo, { buffer: img.reference, contentType: 'image/png' });
  const g = await generate({ inputs: { reference_source: 'planner', planner_image_role: 'reference' }, planExtra: { _logoFilename: logo } });
  await run(g);
  assert.deepEqual(reads, [logo]);
  assert.equal(imageCount(calls.openai[0].body), 1);
  assert.ok(Object.values(await pieceMap()).every((p) => p.status === 'done'));
});

test('a Gemini key-out failure fails only that drink, billed: its reservation ends failed and still counts', async () => {
  stubGemini(({ kind, n }) => (kind === 'drink' && n === 2 ? img.geminiNoKey : null));
  const g = await generate({ provider: 'gemini' });
  await run(g);
  const pieces = await pieceMap();
  assert.equal(pieces.background.status, 'done');
  assert.equal(pieces.background.tone, 'light', 'the cream background reads light');
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[0]].error], ['failed', KEYOUT_REASON]);
  assert.equal(pieces[KEYS[1]].status, 'done');
  const stored = await sharp(r2.get(pieces.background.r2_key).buffer).metadata();
  assert.deepEqual([stored.format, stored.width, stored.height], ['jpeg', 2560, 3200]);
  const drink = await sharp(r2.get(pieces[KEYS[1]].r2_key).buffer).metadata();
  assert.deepEqual([drink.format, drink.width, drink.height, drink.hasAlpha], ['png', 1024, 1024, true]);
  assert.match(calls.gemini[1].input[0].text, /#FF00FF/);
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows[KEYS[0]].status, 'failed');
  assert.equal(rows[KEYS[0]].provider, 'gemini');
  assert.equal(rows[KEYS[0]].provider_request_id, 'int_drink_2', 'the billed call keeps its request id');
  assert.match(rows[KEYS[0]].error, /MenuKeyOutFailed/);
  assert.equal(rows[KEYS[1]].status, 'ok');
  assert.equal(rows.background.size, '4:5 4K');
  assert.equal((await draftRow()).art_version, 2);
  assert.equal(captured.length, 0, 'a refusal is not paged');
});

test('a words failure fails every piece "not attempted" and releases every never-sent reservation', async () => {
  stubOpenAI({ words: () => { throw httpError(500); } });
  const g = await generate();
  await run(g);
  const draft = await draftRow();
  assert.deepEqual([draft.content.words_status, draft.content.words_error], ['failed', SENTENCES.wordsProvider]);
  assert.equal(draft.content.title, undefined, 'a words failure leaves no text');
  const pieces = await pieceMap();
  for (const key of g.keys) assert.deepEqual([pieces[key].status, pieces[key].error], ['failed', NOT_ATTEMPTED.words], key);
  assert.equal(calls.openai.length, 0);
  const rows = await ledger(g.runId);
  const text = rows.find((r) => r.kind === 'text');
  assert.equal(text.status, 'failed', 'the words call was sent');
  assert.ok(!text.error.includes(SECRET), 'never the provider text');
  assert.ok(rows.filter((r) => r.kind === 'image').every((r) => r.status === 'released'));
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].context.tags, { area: 'menuArt', step: 'words' });
  assert.ok(!captured[0].err.message.includes(SECRET), 'Sentry gets the descriptor only');
  assert.equal(captured[0].context.extra.descriptor.provider, 'openai');
});

test('words that fail validation store the fixed reason and the request id, and draw nothing', async () => {
  stubOpenAI({
    words: (body) => {
      const reply = wordsReply(body);
      const json = JSON.parse(reply.output[0].content[0].text);
      json.drinks.push({ ...json.drinks[0], key: 'custom:not-on-the-plan' });
      reply.output[0].content[0].text = JSON.stringify(json);
      return reply;
    },
  });
  const g = await generate();
  await run(g);
  const draft = await draftRow();
  assert.equal(draft.content.words_status, 'failed');
  assert.equal(draft.content.words_error, 'The menu words named a drink that is not on the plan. Try again.');
  const text = (await ledger(g.runId)).find((r) => r.kind === 'text');
  assert.equal(text.provider_request_id, 'req_words');
  assert.match(text.error, /words_extra_drink/);
  assert.equal(calls.openai.length, 0);
  await assertSettled(g.runId);
});

test('a 429 on the words step waits Retry-After, then succeeds on the same reservation', async () => {
  stubOpenAI({ words: (body, n) => { if (n === 1) throw rateLimited(3); return wordsReply(body); } });
  const g = await generate();
  await run(g);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(calls.words.length, 2);
  assert.equal((await draftRow()).content.words_status, 'done');
  const texts = (await ledger(g.runId)).filter((r) => r.kind === 'text');
  assert.deepEqual(texts.map((r) => r.status), ['ok'], 'one reservation, retried');
  assert.ok(Object.values(await pieceMap()).every((p) => p.status === 'done'));
});

test('an image 429 waits 20 s when none is sent, refreshing the heartbeats, then succeeds', async () => {
  const ages = [];
  let g = null;
  onSleep = () => pool.query("UPDATE menu_draft_pieces SET heartbeat_at = NOW() - interval '1 hour' WHERE draft_id = $1", [draftId]);
  stubOpenAI({
    image: async ({ kind, n }) => {
      if (kind === 'background' && n === 1) throw rateLimited();
      if (kind === 'background') {
        const { rows } = await pool.query(
          `SELECT piece_key, status, EXTRACT(EPOCH FROM NOW() - heartbeat_at)::float AS age
             FROM menu_draft_pieces WHERE draft_id = $1 AND run_id = $2`, [draftId, g.runId]);
        ages.push(...rows);
      }
      return null;
    },
  });
  g = await generate();
  await run(g);
  assert.deepEqual(sleeps, [10000, 10000], 'the wait is cut into 10 s heartbeat steps');
  assert.equal(ages.length, 3);
  for (const a of ages) assert.ok(a.age < 60, `${a.piece_key} (${a.status}) was refreshed during the wait`);
  assert.deepEqual(ages.map((a) => a.status).sort(), ['pending', 'pending', 'working']);
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows.background.status, 'ok');
  assert.equal(openaiCallsFor('background').length, 2);
  assert.equal((await pieceMap()).background.status, 'done');
});

test('a third 429 fails the piece after two retries; the reservation ends failed', async () => {
  stubOpenAI({ image: ({ kind, body }) => { if (kind === 'drink' && body.prompt.includes(DRINKS[0])) throw rateLimited(1); return null; } });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.filter((c) => c.body.prompt.includes(DRINKS[0])).length, 3);
  assert.deepEqual(sleeps, [1000, 1000]);
  const pieces = await pieceMap();
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[0]].error], ['failed', 'OpenAI is busy right now. Re-roll in a minute.']);
  assert.equal(pieces[KEYS[1]].status, 'done');
  assert.equal(byKey(await ledger(g.runId))[KEYS[0]].status, 'failed');
  await assertSettled(g.runId);
});

test('a 500 fails its drink without a retry, and a refusal stores its fixed reason, never provider text', async () => {
  stubOpenAI({
    image: ({ kind, body }) => {
      if (kind === 'drink' && body.prompt.includes(DRINKS[0])) throw httpError(500);
      if (kind === 'drink' && body.prompt.includes(DRINKS[1])) {
        throw httpError(400, { code: 'moderation_blocked', error: { message: `blocked: ${SECRET}` } });
      }
      return null;
    },
  });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.filter((c) => c.body.prompt.includes(DRINKS[0])).length, 1, 'no retry on a 500');
  assert.equal(sleeps.length, 0);
  const pieces = await pieceMap();
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[0]].error], ['failed', 'OpenAI could not draw this image. Re-roll it.']);
  assert.deepEqual([pieces[KEYS[1]].status, pieces[KEYS[1]].error], ['failed', OPENAI_REFUSAL_REASON]);
  assert.equal(pieces.background.status, 'done');
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows[KEYS[0]].status, 'failed');
  assert.equal(rows[KEYS[1]].status, 'failed');
  assert.match(rows[KEYS[1]].error, /moderation_blocked/);
  for (const r of Object.values(rows)) assert.ok(!String(r.error).includes(SECRET));
  assert.deepEqual(captured.map((c) => c.context.tags.step), ['drinks'], 'the 500 is paged, the refusal is not');
  assert.equal((await draftRow()).art_version, 1);
});

test('an R2 upload failure after a billed call fails the piece and keeps the reservation failed', async () => {
  uploadFails = (key) => key.includes(KEYS[1].replace(':', '-'));
  const g = await generate();
  await run(g);
  const pieces = await pieceMap();
  assert.deepEqual([pieces[KEYS[1]].status, pieces[KEYS[1]].error], ['failed', SENTENCES.saveFailed]);
  assert.equal(pieces[KEYS[0]].status, 'done');
  const row = byKey(await ledger(g.runId))[KEYS[1]];
  assert.equal(row.status, 'failed');
  assert.match(row.provider_request_id, /^req_drink_/);
  assert.deepEqual(captured.map((c) => c.context.tags.step), ['upload']);
});

test('superseded between pieces (run_id swapped after the background): no further call on either provider, no writes', async () => {
  let snapshot = null;
  hooks({
    beforePiece: async (key) => {
      if (key !== KEYS[0]) return;
      await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
      snapshot = { pieces: await pieceMap(), draft: await draftRow() };
    },
  });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.length, 1, 'the background only');
  assert.equal(calls.gemini.length, 0);
  assert.deepEqual(await pieceMap(), snapshot.pieces, 'no piece write after the swap');
  assert.deepEqual(await draftRow(), snapshot.draft, 'no draft write after the swap');
  assert.equal(snapshot.pieces[KEYS[0]].status, 'pending');
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows.background.status, 'ok');
  assert.equal(rows[KEYS[0]].status, 'released');
  assert.equal(rows[KEYS[1]].status, 'released');
  await assertSettled(g.runId);
});

test('superseded during a drink call: the billed call is marked failed, nothing goes to R2, the next drink is never called', async () => {
  let snapshot = null;
  stubOpenAI({
    image: async ({ kind, body }) => {
      if (kind === 'drink' && body.prompt.includes(DRINKS[0])) {
        await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
        snapshot = { pieces: await pieceMap(), draft: await draftRow() };
      }
      return null;
    },
  });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.length, 2);
  assert.equal(uploads.length, 1, 'the background only');
  assert.deepEqual(await pieceMap(), snapshot.pieces);
  assert.deepEqual(await draftRow(), snapshot.draft);
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows[KEYS[0]].status, 'failed', 'billed, never stored');
  assert.match(rows[KEYS[0]].error, /superseded/);
  assert.equal(rows[KEYS[1]].status, 'released');
});

// What a real Start over does to the old run, inside its locked transaction:
// a new run_id, every reserved row of the proposal released, the pieces
// replaced (here simply deleted).
async function supersede() {
  await inTx(async (client) => {
    await cap.releaseProposalReserved(client, { proposalId });
    await client.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
    await client.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1', [draftId]);
  });
}

test('a real Start over during an image 429 wait: no retried call, the sent row ends failed, the rest released', async () => {
  onSleep = () => supersede();
  stubOpenAI({ image: ({ kind }) => { if (kind === 'background') throw rateLimited(); return null; } });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.length, 1, 'the 429 only; the wait saw the run go and never retried');
  assert.deepEqual(sleeps, [10000], 'the first heartbeat after the first step found the run gone');
  const rows = byKey(await ledger(g.runId));
  assert.equal(rows.background.status, 'failed');
  assert.equal(rows[KEYS[0]].status, 'released');
  assert.equal(rows[KEYS[1]].status, 'released');
  assert.deepEqual(await pieceMap(), {}, 'nothing written back for the old run');
  assert.equal(captured.length, 0, 'a superseded run is not paged');
});

test('superseded during the words call: the text row ends failed, no content is written, no image is called', async () => {
  let snapshot = null;
  stubOpenAI({
    words: async (body) => {
      await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
      snapshot = { pieces: await pieceMap(), draft: await draftRow() };
      return wordsReply(body);
    },
  });
  const g = await generate();
  await run(g);
  assert.equal(calls.openai.length, 0);
  assert.deepEqual(await draftRow(), snapshot.draft, 'the words fill never lands on a superseded run');
  assert.equal(snapshot.draft.content.words_status, 'pending');
  assert.deepEqual(await pieceMap(), snapshot.pieces);
  const rows = await ledger(g.runId);
  assert.equal(rows.find((r) => r.kind === 'text').status, 'failed', 'billed, never kept');
  assert.ok(rows.filter((r) => r.kind === 'image').every((r) => r.status === 'released'));
});

test('superseded between the upload and the done write: the row ends failed and art_version does not move', async () => {
  // The run moves right after Alpha's bytes land in R2, before its done write.
  const r2Stub = require.cache[storagePath].exports;
  const realUpload = r2Stub.uploadFile;
  r2Stub.uploadFile = async (buffer, key) => {
    await realUpload(buffer, key);
    if (key.includes(KEYS[0].replace(':', '-'))) {
      await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
    }
  };
  try {
    const g = await generate();
    await run(g);
    assert.equal(uploads.length, 2, 'the background and Alpha were stored (the orphan is the known precedent)');
    assert.equal(calls.openai.length, 2, 'Bravo is never called');
    const pieces = await pieceMap();
    assert.equal(pieces[KEYS[0]].status, 'working', 'no done write on a superseded run');
    assert.equal(pieces[KEYS[0]].r2_key, null);
    assert.equal((await draftRow()).art_version, 1, 'the background only');
    const rows = byKey(await ledger(g.runId));
    assert.equal(rows[KEYS[0]].status, 'failed');
    assert.match(rows[KEYS[0]].error, /superseded/);
    assert.equal(rows[KEYS[1]].status, 'released');
  } finally {
    r2Stub.uploadFile = realUpload;
  }
});

test('an unexpected error mid-run fails the rest "not attempted", keeps the words, settles every row and pages only a descriptor', async () => {
  hooks({ beforePiece: (key) => { if (key === KEYS[1]) throw new Error(`database said: ${SECRET}`); } });
  const g = await generate();
  await run(g);
  const draft = await draftRow();
  assert.equal(draft.content.words_status, 'done', 'the end-of-run words check leaves done words alone');
  const pieces = await pieceMap();
  assert.equal(pieces.background.status, 'done');
  assert.equal(pieces[KEYS[0]].status, 'done');
  assert.deepEqual([pieces[KEYS[1]].status, pieces[KEYS[1]].error], ['failed', NOT_ATTEMPTED.error]);
  const rows = byKey(await ledger(g.runId));
  assert.deepEqual([rows.background.status, rows[KEYS[0]].status, rows[KEYS[1]].status], ['ok', 'ok', 'released']);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].context.tags.step, 'drinks');
  assert.ok(!captured[0].err.message.includes(SECRET));
  assert.ok(!JSON.stringify(captured[0].context.extra).includes(SECRET));
});

test('the call gate: a reservation no longer reserved is never sent, so nothing is called, on either provider', async () => {
  // The claim and the heartbeat both pass here; only authorizeCall stands
  // between the run and the provider.
  let released = null;
  hooks({
    beforePiece: async (key) => {
      if (key === KEYS[0]) await pool.query("UPDATE menu_art_calls SET status = 'released' WHERE id = $1", [released]);
    },
  });
  const g = await generate({ provider: 'gemini' });
  released = g.imageIds[KEYS[0]];
  await run(g);
  assert.equal(calls.gemini.length, 2, 'the background and Bravo, never Alpha');
  assert.ok(!calls.gemini.some((c) => c.input[0].text.includes(DRINKS[0])));
  const pieces = await pieceMap();
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[0]].error], ['failed', NOT_ATTEMPTED.ended]);
  assert.equal(pieces[KEYS[1]].status, 'done');
  const row = byKey(await ledger(g.runId))[KEYS[0]];
  assert.deepEqual([row.status, row.provider_request_id], ['released', null]);

  // The words call: its text row released before the job starts.
  hooks();
  calls.words.length = 0;
  calls.gemini.length = 0;
  const w = await generate();
  await pool.query("UPDATE menu_art_calls SET status = 'released' WHERE id = $1", [w.textId]);
  await run(w);
  assert.equal(calls.words.length, 0);
  assert.equal(calls.openai.length, 0);
  const draft = await draftRow();
  assert.deepEqual([draft.content.words_status, draft.content.words_error], ['failed', SENTENCES.wordsFailed]);
  assert.ok(Object.values(await pieceMap()).every((p) => p.error === NOT_ATTEMPTED.words));
  await assertSettled(w.runId);
});

test('a drink Update draft deleted mid-run is skipped, never authorized and released; the rest still draw', async () => {
  hooks({
    beforePiece: async (key) => {
      if (key === KEYS[1]) await pool.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1 AND piece_key = $2', [draftId, key]);
    },
  });
  const g = await generate({ drinks: 3 });
  await run(g);
  assert.equal(calls.openai.length, 3, 'the background, Alpha and Charlie');
  assert.ok(!calls.openai.some((c) => c.body.prompt.includes(DRINKS[1])));
  const pieces = await pieceMap();
  assert.equal(pieces[KEYS[1]], undefined);
  assert.equal(pieces[KEYS[0]].status, 'done');
  assert.equal(pieces[KEYS[2]].status, 'done');
  const row = byKey(await ledger(g.runId))[KEYS[1]];
  assert.deepEqual([row.status, row.provider_request_id], ['released', null], 'never sent');
  assert.equal((await draftRow()).art_version, 3);
  await assertSettled(g.runId);
});

// ── Re-roll ─────────────────────────────────────────────────────────────────

test('a mixed run: the background by OpenAI, a drink re-rolled by Gemini against the current background', async () => {
  const g = await generate();
  await run(g);
  const before = await pieceMap();
  calls.openai.length = 0;
  const pieceRun = await reroll(KEYS[0], { provider: 'gemini', note: 'add a lime wheel' });
  const pieces = await pieceMap();
  assert.deepEqual([pieces[KEYS[0]].status, pieces[KEYS[0]].provider, pieces[KEYS[0]].model, pieces[KEYS[0]].drawn_count],
    ['done', 'gemini', MODEL.gemini, 2]);
  assert.match(pieces[KEYS[0]].r2_key, new RegExp(`^menu-art/${proposalId}/${pieceRun}/`));
  assert.deepEqual([pieces.background.provider, pieces.background.drawn_count], ['openai', 1]);
  assert.deepEqual(pieces[KEYS[1]], before[KEYS[1]], 'the other drink is untouched');
  assert.deepEqual(reads, [before.background.r2_key], 'the current background, read by its key');
  assert.equal(calls.gemini.length, 1);
  assert.equal(calls.openai.length, 0);
  const sent = calls.gemini[0];
  assert.equal(sent.model, MODEL.gemini);
  assert.equal(sent.input.filter((i) => i.type === 'image').length, 1, 'the background as the style reference');
  assert.ok(sent.input[0].text.includes('add a lime wheel'));
  assert.ok(sent.input[0].text.includes(DRINK_MAGENTA_KEY));
  const drink = await sharp(r2.get(pieces[KEYS[0]].r2_key).buffer).metadata();
  assert.deepEqual([drink.format, drink.width, drink.hasAlpha], ['png', 1024, true]);
  const rerollRows = await ledger(pieceRun);
  assert.deepEqual(rerollRows.map((r) => [r.piece_key, r.status, r.provider, r.size]), [[KEYS[0], 'ok', 'gemini', '1:1 1K']]);
  assert.ok((await ledger(g.runId)).every((r) => r.provider === 'openai'));
  assert.equal((await draftRow()).art_version, 4);
});

test('a background re-roll carries its note, bumps drawn_count and art_version, and leaves the drinks alone', async () => {
  const g = await generate();
  await run(g);
  const before = await pieceMap();
  calls.openai.length = 0;
  const pieceRun = await reroll('background', { provider: 'openai', note: 'more gold leaf' });
  assert.equal(calls.openai.length, 1);
  assert.match(calls.openai[0].body.prompt, /Change from the last version: more gold leaf\./);
  const pieces = await pieceMap();
  assert.deepEqual([pieces.background.status, pieces.background.drawn_count, pieces.background.tone], ['done', 2, 'dark']);
  assert.notEqual(pieces.background.r2_key, before.background.r2_key);
  assert.deepEqual(pieces[KEYS[0]], before[KEYS[0]]);
  assert.equal((await draftRow()).art_version, 4);
  await assertSettled(pieceRun);
});

test('a re-roll whose piece was taken over before it started calls nothing and releases its reservation', async () => {
  const g = await generate();
  await run(g);
  calls.openai.length = 0;
  hooks({ beforePiece: () => pool.query('UPDATE menu_draft_pieces SET run_id = $2 WHERE draft_id = $1 AND piece_key = $3', [draftId, crypto.randomUUID(), KEYS[1]]) });
  const pieceRun = await reroll(KEYS[1], { provider: 'openai' });
  assert.equal(calls.openai.length, 0);
  assert.deepEqual((await ledger(pieceRun)).map((r) => r.status), ['released']);
});

test('a drink re-roll whose background key sits outside menu-art/<id>/ never reads it and calls nothing', async () => {
  const g = await generate();
  await run(g);
  const outside = `menu-art/${proposalId + 100000}/${NONCE}/background.jpg`;
  r2.set(outside, { buffer: img.openaiBackground, contentType: 'image/jpeg' });
  await pool.query("UPDATE menu_draft_pieces SET r2_key = $2 WHERE draft_id = $1 AND piece_key = 'background'", [draftId, outside]);
  calls.openai.length = 0;
  reads.length = 0;
  const pieceRun = await reroll(KEYS[0], { provider: 'openai' });
  assert.equal(calls.openai.length, 0);
  assert.deepEqual(reads, []);
  const piece = (await pieceMap())[KEYS[0]];
  assert.deepEqual([piece.status, piece.error], ['failed', SENTENCES.backgroundUnavailable]);
  assert.deepEqual((await ledger(pieceRun)).map((r) => r.status), ['released']);
  assert.equal(captured[0].context.extra.descriptor.code, 'key_outside_prefix');
});

test('preflight: Gemini without its key, a piece with no model, and a piece with no reservation fail unsent', async () => {
  const g = await generate();
  await run(g);
  calls.openai.length = 0;

  delete process.env.GEMINI_API_KEY;
  try {
    const geminiRun = await reroll(KEYS[0], { provider: 'gemini' });
    assert.deepEqual([(await pieceMap())[KEYS[0]].error], [SENTENCES.geminiOff]);
    assert.deepEqual((await ledger(geminiRun)).map((r) => r.status), ['released']);
  } finally {
    process.env.GEMINI_API_KEY = 'gem-test-not-real';
  }

  const blankModel = await stageReroll([KEYS[1]], { provider: 'openai', model: '   ' });
  await runReroll(KEYS[1], blankModel);
  assert.equal((await pieceMap())[KEYS[1]].error, SENTENCES.noProvider);
  assert.deepEqual((await ledger(blankModel)).map((r) => r.status), ['released']);

  const unreserved = await stageReroll(['background'], { provider: 'openai' });
  await pool.query("UPDATE menu_art_calls SET status = 'released' WHERE run_id = $1", [unreserved]);
  await runReroll('background', unreserved);
  assert.equal((await pieceMap()).background.error, SENTENCES.notReserved);
  assert.equal(calls.openai.length + calls.gemini.length, 0, 'nothing was ever called');
});

test('two Update draft drinks sharing one run: each job sweeps and settles only its own piece', async () => {
  const g = await generate();
  await run(g);
  calls.openai.length = 0;
  const shared = await stageReroll([KEYS[0], KEYS[1]], { provider: 'openai' });
  await pool.query("UPDATE menu_draft_pieces SET heartbeat_at = NOW() - interval '1 hour' WHERE draft_id = $1 AND piece_key = $2", [draftId, KEYS[1]]);
  await runReroll(KEYS[0], shared);
  let pieces = await pieceMap();
  assert.equal(pieces[KEYS[0]].status, 'done');
  assert.equal(pieces[KEYS[1]].status, 'pending', 'the sibling is not swept');
  const age = (Date.now() - new Date(pieces[KEYS[1]].heartbeat_at).getTime()) / 1000;
  assert.ok(age < 60, 'a queued sibling is kept alive by the heartbeat of its run');
  let rows = byKey(await ledger(shared));
  assert.deepEqual([rows[KEYS[0]].status, rows[KEYS[1]].status], ['ok', 'reserved'], 'nor settled');
  await runReroll(KEYS[1], shared);
  pieces = await pieceMap();
  assert.equal(pieces[KEYS[1]].status, 'done');
  rows = byKey(await ledger(shared));
  assert.equal(rows[KEYS[1]].status, 'ok');
  assert.equal(calls.openai.length, 2);
});

// ── Update draft's words ────────────────────────────────────────────────────

test('runWordsForDrinks: authorizes the route\'s reservation, returns the added drinks and marks the row ok', async () => {
  const g = await generate();
  await run(g);
  const normalized = normalizePlan(await loadEventPlan(proposalId), await loadCatalogMaps());
  calls.words.length = 0;
  const reservationId = await inTx((client) => cap.reserveText(client, { proposalId, runId: g.runId, model: TEXT_MODEL }));
  const drinks = await job.runWordsForDrinks({
    normalizedDrinks: normalized.drinks.slice(1), brief: normalized.brief, eventTypeLabel: 'Birthday Party',
    reservationId, draftId, runId: g.runId, model: TEXT_MODEL,
  });
  assert.equal(drinks.length, 1);
  assert.deepEqual([drinks[0].key, drinks[0].has_art, drinks[0].added_by_sync, drinks[0].description_ai_written], [KEYS[1], false, true, true]);
  assert.equal(drinks[0].description, `A bright pour of ${DRINKS[1]}`);
  assert.equal(Object.keys(drinks[0]).length, 13, "spec 6's thirteen stored fields");
  assert.equal(calls.words.length, 1);
  const row = (await ledger(g.runId)).find((r) => r.id === reservationId);
  assert.deepEqual([row.status, row.provider_request_id], ['ok', 'req_words']);
});

test('runWordsForDrinks: a superseded run is a 409 with no call and the row released; a provider failure throws the fixed sentence', async () => {
  const g = await generate();
  await run(g);
  const normalized = normalizePlan(await loadEventPlan(proposalId), await loadCatalogMaps());
  calls.words.length = 0;
  const staleRun = newRun();
  const stale = await inTx((client) => cap.reserveText(client, { proposalId, runId: staleRun, model: TEXT_MODEL }));
  const args = { normalizedDrinks: normalized.drinks.slice(0, 1), brief: normalized.brief, eventTypeLabel: 'Birthday Party', draftId };
  await assert.rejects(job.runWordsForDrinks({ ...args, reservationId: stale, runId: staleRun }),
    (err) => err.statusCode === 409 && err.code === 'MENU_DRAFT_CHANGED');
  assert.equal(calls.words.length, 0);
  assert.deepEqual((await ledger(staleRun)).map((r) => r.status), ['released']);

  stubOpenAI({ words: () => { throw httpError(500); } });
  const live = await inTx((client) => cap.reserveText(client, { proposalId, runId: g.runId, model: TEXT_MODEL }));
  await assert.rejects(job.runWordsForDrinks({ ...args, reservationId: live, runId: g.runId }), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, 'MENU_WORDS_FAILED');
    assert.equal(err.message, SENTENCES.wordsProvider);
    assert.ok(!JSON.stringify(err.descriptor).includes(SECRET));
    return true;
  });
  assert.equal((await ledger(g.runId)).find((r) => r.id === live).status, 'failed');
});

test('runWordsForDrinks: a 429 retries on the same row; a Start over during the wait is a 409 with no retried call', async () => {
  const g = await generate();
  await run(g);
  const normalized = normalizePlan(await loadEventPlan(proposalId), await loadCatalogMaps());
  const args = { normalizedDrinks: normalized.drinks.slice(0, 1), brief: normalized.brief, eventTypeLabel: 'Birthday Party', draftId, runId: g.runId };

  calls.words.length = 0;
  stubOpenAI({ words: (body, n) => { if (n === 1) throw rateLimited(2); return wordsReply(body); } });
  const first = await inTx((client) => cap.reserveText(client, { proposalId, runId: g.runId, model: TEXT_MODEL }));
  const drinks = await job.runWordsForDrinks({ ...args, reservationId: first });
  assert.equal(drinks.length, 1);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.words.length, 2);
  assert.equal((await ledger(g.runId)).find((r) => r.id === first).status, 'ok');

  calls.words.length = 0;
  sleeps.length = 0;
  onSleep = () => pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, crypto.randomUUID()]);
  stubOpenAI({ words: () => { throw rateLimited(2); } });
  const second = await inTx((client) => cap.reserveText(client, { proposalId, runId: g.runId, model: TEXT_MODEL }));
  await assert.rejects(job.runWordsForDrinks({ ...args, reservationId: second }),
    (err) => err.statusCode === 409 && err.code === 'MENU_DRAFT_CHANGED');
  assert.equal(calls.words.length, 1, 'never retried on the dead run');
  assert.equal((await ledger(g.runId)).find((r) => r.id === second).status, 'failed', 'it was sent');
});
