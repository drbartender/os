process.env.NODE_ENV = 'test';
require('dotenv').config();
// Route tests for the menu art drafts (spec 2026-10-01 sections 5.5, 7, 7.1
// and 9; plan Task E6): menuDrafts.js with its mounted sibling
// menuDraftImages.js. Update draft (menuDraftSync.js) has its own suite,
// menuDraftSync.test.js, split out with this harness (lane
// menu-bar-renamed-lines) so each suite stays well under the runner's bound.
// The menuPrint.test.js harness: a minimal express app, the real router, the
// real express-fileupload, hand-built multipart, requests over real HTTP.
//
// Nothing paid and nothing remote is ever reached:
// - BOTH provider wrappers are stubbed at the SDK-client level
//   (__setTestStub), so the real job runs end to end against stubs;
// - R2 is an in-memory map installed through require.cache BEFORE anything
//   requires storage, and global fetch is a tripwire;
// - the job's two queued entry points are wrapped (require.cache, before the
//   router loads) so every queued run is tracked, and afterEach waits for all
//   of them before the next test and before pool.end().
// Live on the shared dev DB: the cap counts the ledger GLOBALLY over 24 hours,
// so the cap env is set relative to the current count and restored. Rows are
// removed by the ids recorded here (ledger and drafts before proposals, drafts
// before the temp users), never by a pattern.
//
// Run: node --test server/routes/proposals/menuDrafts.test.js
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

// ── Stub R2 before anything requires storage ────────────────────────────────
const storagePath = require.resolve('../../utils/storage');
const realStorage = require('../../utils/storage');
const { AppError, NotFoundError } = require('../../utils/errors');

const r2 = new Map();
const uploads = [];
const reads = [];
const mimeOf = (key) => (key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, key) => { uploads.push(key); r2.set(key, { buffer, contentType: mimeOf(key) }); },
  readFile: async (key) => {
    reads.push(key);
    const file = r2.get(key);
    if (!file) throw new NotFoundError('File not found.');
    return file;
  },
  getSignedUrl: async () => { throw new Error('menuDrafts.test: nothing may presign'); },
};

// ── Track every queued job run ──────────────────────────────────────────────
const jobPath = require.resolve('../../utils/menuArtJob');
const realJob = require('../../utils/menuArtJob');
const inflight = new Set();
const track = (fn) => (args) => {
  const p = Promise.resolve(fn(args));
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
};
require.cache[jobPath].exports = {
  ...realJob, runGeneration: track(realJob.runGeneration), runPieceReroll: track(realJob.runPieceReroll),
};

const { pool } = require('../../db');
const openaiClient = require('../../utils/openaiClient');
const geminiClient = require('../../utils/geminiClient');
const anthropicClient = require('../../utils/anthropicClient');
const { adminWriteLimiter, menuDraftReadLimiter, menuDraftEditLimiter } = require('../../middleware/rateLimiters');
const { buildFingerprint, normalizePlan, loadEventPlan, loadCatalogMaps, fingerprintHash } = require('../../utils/menuDrinkSource');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const menuDraftsRouter = require('./menuDrafts');
const { queue } = require('./menuDraftShared');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const NAMES = Array.from({ length: 10 }, (_, i) => `Zq Drink ${i + 1} ${NONCE}`);
const KEYS = NAMES.map((n) => `custom:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
const MODEL = { openai: 'route-test-gpt-image', gemini: 'route-test-gemini-image', text: 'route-test-text' };
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP',
  'MENU_ART_IMAGE_MODEL', 'MENU_ART_GEMINI_IMAGE_MODEL', 'MENU_ART_TEXT_MODEL', 'MENU_ART_STALE_MS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let server;
let baseUrl;
let realFetch;
let tripwire = 0;
const users = {};
const tokens = {};
const proposalIds = [];
const planIds = [];
let catalog = null;
const img = {};
const calls = { words: [], claude: [], openai: [], gemini: [] };
let wordsGate = null;
let geminiActive = 0;
let geminiMaxActive = 0;

// ── Images ──────────────────────────────────────────────────────────────────
const canvas = (w, h, background, channels = 3) => sharp({ create: { width: w, height: h, channels, background } });
async function drinkOn(background, format) {
  const block = await canvas(410, 512, { r: 20, g: 110, b: 120 }).png().toBuffer();
  const c = canvas(1024, 1024, background, background.alpha === undefined ? 3 : 4)
    .composite([{ input: block, left: 307, top: 256 }]);
  return (format === 'png' ? c.png() : c.jpeg({ quality: 90 })).toBuffer();
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function multipart(fields, file) {
  const boundary = `----menudraft${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'reference'}"; `
      + `filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

function request(method, urlPath, { token = tokens.admin, json, form } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    let payload = null;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (form) {
      const { body, boundary } = multipart(form.fields, form.file);
      payload = body;
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
    }
    if (payload) headers['Content-Length'] = payload.length;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body = null;
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* binary */ }
        resolve({ status: res.statusCode, body, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const base = (id) => `/api/proposals/${id}/menu-draft`;
const pieceUrl = (id, key, suffix) => `${base(id)}/pieces/${encodeURIComponent(key)}/${suffix}`;
const generate = (id, fields = {}, file = null) => request('POST', `${base(id)}/generate`, {
  form: { fields: { image_model: 'openai', planner_image_role: 'ignore', art_direction: 'Loose watercolor', ...fields }, file },
});

// Every queued job run (and any it queues in turn) has finished.
async function idle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => { setImmediate(resolve); });
    if (inflight.size) { quiet = 0; await Promise.allSettled([...inflight]); } else quiet += 1;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function selections(count, extra = {}) {
  return {
    menuStyle: 'custom', menuTheme: 'Garden party in sage and gold', drinkNaming: '', menuDesignNotes: 'Soft watercolor',
    customCocktails: NAMES.slice(0, count), ...extra,
  };
}

async function newEvent({ drinks = 2, extra = {}, plan = true } = {}) {
  const p = await pool.query("INSERT INTO proposals (status, event_type) VALUES ('draft', 'birthday-party') RETURNING id");
  const id = p.rows[0].id;
  proposalIds.push(id);
  let planId = null;
  if (plan) {
    const r = await pool.query("INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', $2) RETURNING id",
      [id, selections(drinks, extra)]);
    planId = r.rows[0].id;
    planIds.push(planId);
  }
  return { id, planId };
}
const setPlan = (planId, sel) => pool.query('UPDATE drink_plans SET selections = $2 WHERE id = $1', [planId, sel]);

const resetCalls = () => { for (const list of [calls.words, calls.claude, calls.openai, calls.gemini, uploads, reads]) list.length = 0; };
async function resetLimits() {
  for (const uid of Object.values(users)) {
    await adminWriteLimiter.resetKey(`admin-${uid}`);
    await menuDraftReadLimiter.resetKey(`menudraft-r-${uid}`);
    await menuDraftEditLimiter.resetKey(`menudraft-e-${uid}`);
  }
}

// An event whose first Generate has landed; the counters start clean after it.
async function ready(opts = {}, fields = {}) {
  const ev = await newEvent(opts);
  const res = await generate(ev.id, fields);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await idle();
  resetCalls();
  return { ...ev, draftId: res.body.draft_id };
}

const draftOf = async (id) => (await pool.query('SELECT * FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
async function piecesOf(id) {
  const { rows } = await pool.query(
    `SELECT p.* FROM menu_draft_pieces p JOIN menu_drafts d ON d.id = p.draft_id WHERE d.proposal_id = $1 ORDER BY p.id`, [id]);
  return Object.fromEntries(rows.map((r) => [r.piece_key, r]));
}
const ledgerOf = async (id) => (await pool.query('SELECT * FROM menu_art_calls WHERE proposal_id = $1 ORDER BY id', [id])).rows;
const setContent = (id, patch) => pool.query('UPDATE menu_drafts SET content = content || $2::jsonb WHERE proposal_id = $1', [id, patch]);
const setPiece = (id, key, sql, args = []) => pool.query(
  `UPDATE menu_draft_pieces p SET ${sql} FROM menu_drafts d WHERE d.id = p.draft_id AND d.proposal_id = $1 AND p.piece_key = $2`,
  [id, key, ...args]);
async function openCount(kind) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM menu_art_calls
      WHERE kind = $1 AND status <> 'released' AND created_at > NOW() - interval '24 hours'`, [kind]);
  return rows[0].n;
}
async function headroom() {
  process.env.MENU_ART_DAILY_IMAGE_CAP = String((await openCount('image')) + 1000);
  process.env.MENU_ART_DAILY_TEXT_CAP = String((await openCount('text')) + 1000);
}
const reservedRow = (id, key, runId = crypto.randomUUID()) => pool.query(
  `INSERT INTO menu_art_calls (proposal_id, piece_key, run_id, kind, status, provider, model)
   VALUES ($1, $2, $3, 'image', 'reserved', 'openai', 'stranded') RETURNING id`, [id, key, runId]).then((r) => r.rows[0].id);
const statusOfRow = async (rowId) => (await pool.query('SELECT status FROM menu_art_calls WHERE id = $1', [rowId])).rows[0].status;

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

function stubOpenAI() {
  const reply = async (op, body) => {
    calls.openai.push({ op, body });
    const kind = body.size === '1024x1024' ? 'drink' : 'background';
    const buffer = kind === 'drink' ? img.openaiDrink : img.openaiBackground;
    return { data: [{ b64_json: buffer.toString('base64') }], _request_id: `req_${kind}_${calls.openai.length}` };
  };
  openaiClient.__setTestStub({
    responses: {
      create: async (body) => {
        calls.words.push(body);
        if (wordsGate) await wordsGate.promise;
        return wordsReply(body);
      },
    },
    images: { generate: (b) => reply('generate', b), edit: (b) => reply('edit', b) },
  });
}

function stubGemini() {
  geminiClient.__setTestStub({
    interactions: {
      create: async (params) => {
        calls.gemini.push(params);
        geminiActive += 1;
        geminiMaxActive = Math.max(geminiMaxActive, geminiActive);
        // Held long enough that two draws queued side by side would overlap
        // here, so the sync test's one-at-a-time check can fail.
        await new Promise((resolve) => { setTimeout(resolve, 600); });
        geminiActive -= 1;
        const kind = params.response_format.aspect_ratio === '1:1' ? 'drink' : 'background';
        const buffer = kind === 'drink' ? img.geminiDrink : img.geminiBackground;
        return {
          id: `int_${kind}_${calls.gemini.length}`, status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'image', data: buffer.toString('base64'), mime_type: 'image/jpeg' }] }],
        };
      },
    },
  });
}

// The words as Claude answers them (anthropicClient.draftMenuCopy, lane menu-words-claude).
function stubAnthropic() {
  anthropicClient.__setTestStub({
    messages: {
      create: async (body) => {
        calls.claude.push(body);
        const reply = wordsReply({ input: body.messages[0].content });
        return { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply.output[0].content[0].text }], _request_id: 'req_claude_words' };
      },
    },
  });
}
const CLAUDE = 'claude-haiku-5-5';

const imageCalls = () => calls.openai.length + calls.gemini.length;

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  img.openaiBackground = await canvas(320, 400, { r: 20, g: 30, b: 70 }).jpeg().toBuffer();
  img.openaiDrink = await drinkOn({ r: 0, g: 0, b: 0, alpha: 0 }, 'png');
  img.geminiBackground = await canvas(400, 500, { r: 240, g: 230, b: 210 }).jpeg().toBuffer();
  img.geminiDrink = await drinkOn({ r: 255, g: 0, b: 255 }, 'jpeg');
  img.reference = await canvas(600, 400, { r: 200, g: 170, b: 90 }).png().toBuffer();
  img.logo = await canvas(800, 600, { r: 10, g: 90, b: 40 }).png().toBuffer();

  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_IMAGE_MODEL = MODEL.openai;
  process.env.MENU_ART_GEMINI_IMAGE_MODEL = MODEL.gemini;
  process.env.MENU_ART_TEXT_MODEL = MODEL.text;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MENU_ART_STALE_MS;
  await headroom();

  const { rows } = await pool.query(
    `SELECT id, name, description FROM cocktails
      WHERE description IS NOT NULL AND description <> '' AND id ~ '^[a-z0-9-]{1,100}$' ORDER BY id LIMIT 1`);
  catalog = rows[0] || null;

  const hash = await bcrypt.hash('x', 4);
  for (const role of ['admin', 'manager', 'staff']) {
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, $2, $3, 'approved', 0) RETURNING id`, [`menudrafts-route-${role}-${NONCE}@example.com`, hash, role]);
    users[role] = r.rows[0].id;
    tokens[role] = jwt.sign({ userId: users[role], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }

  const app = express();
  app.use(express.json({ limit: '1mb' })); // server/index.js mounts it at 1mb
  app.use(fileUpload({ limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }));
  app.use('/api/proposals', menuDraftsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    console.error('menuDrafts.test unexpected error:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await idle();
  openaiClient._resetForTest();
  geminiClient._resetForTest();
  anthropicClient._resetClientForTest();
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (proposalIds.length) {
    await pool.query('DELETE FROM menu_art_calls WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM menu_drafts WHERE proposal_id = ANY($1::int[])', [proposalIds]);
  }
  if (planIds.length) await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [planIds]);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  const userIds = Object.values(users);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await new Promise((resolve) => { server.close(resolve); });
  await pool.end();
  require.cache[storagePath].exports = realStorage;
  require.cache[jobPath].exports = realJob;
});

beforeEach(async () => {
  resetCalls();
  wordsGate = null;
  geminiActive = 0;
  geminiMaxActive = 0;
  tripwire = 0;
  stubOpenAI();
  stubGemini();
  await resetLimits();
});

afterEach(async () => {
  await idle();
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_TEXT_MODEL = MODEL.text;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MENU_ART_STALE_MS;
  await headroom();
  assert.equal(tripwire, 0, 'a request reached global fetch');
});

// ── Auth and ids ────────────────────────────────────────────────────────────

test('auth: no token is 401, staff is 403, a manager reads the draft', async () => {
  const { id } = await newEvent();
  assert.equal((await request('GET', base(id), { token: null })).status, 401);
  assert.equal((await request('GET', base(id), { token: tokens.staff })).status, 403);
  assert.equal((await request('POST', `${base(id)}/generate`, { token: tokens.staff, json: { image_model: 'openai' } })).status, 403);
  assert.equal((await request('GET', pieceUrl(id, 'background', 'image'), { token: tokens.staff })).status, 403);
  const res = await request('GET', base(id), { token: tokens.manager });
  assert.equal(res.status, 200);
  assert.equal(res.body.draft, null);
  assert.equal(res.body.configured.openai, true);
  assert.equal(imageCalls() + calls.words.length, 0);
});

test('ids: not digits is 400, an unknown proposal or one past int4 is 404, on reads and writes', async () => {
  assert.equal((await request('GET', '/api/proposals/abc/menu-draft')).status, 400);
  assert.equal((await request('GET', '/api/proposals/2147483000/menu-draft')).status, 404);
  assert.equal((await request('GET', '/api/proposals/99999999999999999999/menu-draft')).status, 404);
  assert.equal((await request('PATCH', '/api/proposals/2147483000/menu-draft', { json: { version: 1, content: { title: 'x' } } })).status, 404);
  assert.equal((await generate('2147483000')).status, 404);
  assert.equal((await request('POST', '/api/proposals/1.5/menu-draft/sync', { json: { version: 1, image_model: 'openai' } })).status, 400);
  const { id } = await newEvent();
  const patch = await request('PATCH', base(id), { json: { version: 1, content: { title: 'x' } } });
  assert.equal(patch.status, 404, 'no draft yet');
});

// ── Generate ────────────────────────────────────────────────────────────────

test('generate and re-roll answer 503 MENU_ART_NOT_CONFIGURED without the OpenAI key, writing nothing', async () => {
  const { id } = await newEvent();
  delete process.env.OPENAI_API_KEY;
  const gen = await generate(id);
  assert.equal(gen.status, 503);
  assert.equal(gen.body.code, 'MENU_ART_NOT_CONFIGURED');
  const reroll = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(reroll.body.code, 'MENU_ART_NOT_CONFIGURED');
  // Update draft checks the key only where it will call a provider; with no draft there is nothing to update.
  const sync = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.equal(sync.status, 404);
  assert.equal(await draftOf(id), undefined);
  assert.deepEqual(await ledgerOf(id), []);
  const read = await request('GET', base(id));
  assert.equal(read.status, 200, 'the GET works without the key');
  assert.equal(read.body.configured.openai, false);
});

test('generate: gemini without its key is 503 MENU_ART_GEMINI_NOT_CONFIGURED while openai still works', async () => {
  const { id } = await newEvent();
  delete process.env.GEMINI_API_KEY;
  const gem = await generate(id, { image_model: 'gemini' });
  assert.equal(gem.status, 503);
  assert.equal(gem.body.code, 'MENU_ART_GEMINI_NOT_CONFIGURED');
  assert.equal(await draftOf(id), undefined);
  const oa = await generate(id, { image_model: 'openai' });
  assert.equal(oa.status, 202);
  await idle();
  assert.equal(calls.gemini.length, 0);
  assert.equal(calls.openai.length, 3);
});

// Spec 2026-10-19 section 16 (lane menu-words-claude): the designer runs with
// no OpenAI key. Each check asks for the key of the provider its call uses.
test('generate on Claude with no OpenAI key: the words key and Gemini pass, 202, the words on Anthropic and the art on Gemini', async () => {
  const { id } = await newEvent();
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.MENU_ART_TEXT_MODEL = CLAUDE;
  stubAnthropic();
  const read = await request('GET', base(id));
  assert.deepEqual(read.body.configured, { openai: false, gemini: true, words: true, default_image_model: 'gemini' });
  const gen = await generate(id, { image_model: 'gemini' });
  assert.equal(gen.status, 202, JSON.stringify(gen.body));
  await idle();
  assert.deepEqual([calls.claude.length, calls.words.length, calls.openai.length, calls.gemini.length], [1, 0, 0, 3]);
  assert.equal(calls.claude[0].model, CLAUDE);
  const draft = await draftOf(id);
  assert.equal(draft.content.words_status, 'done');
  const text = (await ledgerOf(id)).find((r) => r.kind === 'text');
  assert.deepEqual([text.status, text.provider, text.model], ['ok', 'anthropic', CLAUDE]);
  assert.ok(Object.values(await piecesOf(id)).every((p) => p.status === 'done' && p.provider === 'gemini'));
});

test('generate checks the words provider key: a claude- model without the Anthropic key is 503 even with the OpenAI key', async () => {
  const { id } = await newEvent();
  process.env.MENU_ART_TEXT_MODEL = CLAUDE;
  const gen = await generate(id, { image_model: 'openai' });
  assert.deepEqual([gen.status, gen.body.code], [503, 'MENU_ART_NOT_CONFIGURED']);
  assert.equal(await draftOf(id), undefined);
  assert.deepEqual(await ledgerOf(id), []);
  assert.equal(calls.words.length + calls.claude.length + imageCalls(), 0);
  const read = await request('GET', base(id));
  assert.deepEqual([read.body.configured.openai, read.body.configured.words], [true, false]);
  // The OpenAI image model without its key is refused too, whatever the words key.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  delete process.env.OPENAI_API_KEY;
  const oa = await generate(id, { image_model: 'openai' });
  assert.deepEqual([oa.status, oa.body.code], [503, 'MENU_ART_NOT_CONFIGURED']);
  assert.equal(await draftOf(id), undefined);
});

test('a re-roll checks only its image model key: Gemini with no OpenAI or words key is 202; OpenAI art without its key is 503', async () => {
  const { id } = await ready();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.MENU_ART_TEXT_MODEL = CLAUDE;
  const gem = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'gemini' } });
  assert.equal(gem.status, 202, JSON.stringify(gem.body));
  await idle();
  assert.deepEqual([calls.gemini.length, calls.openai.length, calls.words.length + calls.claude.length], [1, 0, 0]);
  assert.equal((await piecesOf(id)).background.status, 'done');
  const oa = await request('POST', pieceUrl(id, KEYS[0], 'reroll'), { json: { image_model: 'openai' } });
  assert.deepEqual([oa.status, oa.body.code], [503, 'MENU_ART_NOT_CONFIGURED']);
  assert.equal((await piecesOf(id))[KEYS[0]].status, 'done', 'nothing written');
});

test('Update draft by provider: typed drinks need the words key, added art its image model key, a bar-only update none', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'] } });
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.MENU_ART_TEXT_MODEL = CLAUDE;
  stubAnthropic();
  await setPlan(planId, selections(3, { wineFromFullBar: ['Red'] }));
  const sync = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'gemini' } });
  assert.deepEqual([sync.status, sync.body.version], [202, 2], JSON.stringify(sync.body));
  await idle();
  assert.deepEqual([calls.claude.length, calls.words.length, calls.gemini.length, calls.openai.length], [1, 0, 1, 0]);
  assert.ok((await draftOf(id)).content.drinks.some((d) => d.key === KEYS[2] && d.added_by_sync === true));
  const text = (await ledgerOf(id)).filter((r) => r.kind === 'text').pop();
  assert.deepEqual([text.status, text.provider], ['ok', 'anthropic']);

  // A typed drink with no words key is refused before anything is reserved.
  resetCalls();
  delete process.env.ANTHROPIC_API_KEY;
  await setPlan(planId, selections(4, { wineFromFullBar: ['Red'] }));
  const ledgerBefore = (await ledgerOf(id)).length;
  const refused = await request('POST', `${base(id)}/sync`, { json: { version: 2, image_model: 'gemini' } });
  assert.deepEqual([refused.status, refused.body.code], [503, 'MENU_ART_NOT_CONFIGURED']);
  assert.equal((await ledgerOf(id)).length, ledgerBefore, 'nothing reserved');

  // The bar alone: no key of any provider.
  delete process.env.GEMINI_API_KEY;
  await setPlan(planId, selections(3, { wineFromFullBar: ['White'] }));
  const bar = await request('POST', `${base(id)}/sync`, { json: { version: 2, image_model: 'gemini' } });
  assert.deepEqual([bar.status, bar.body.version], [202, 3], JSON.stringify(bar.body));
  assert.equal(calls.words.length + calls.claude.length + imageCalls(), 0);
});

test('generate: image_model is required (400) and nothing is written', async () => {
  const { id } = await newEvent();
  const res = await request('POST', `${base(id)}/generate`, { form: { fields: { planner_image_role: 'ignore' } } });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.image_model);
  const bad = await generate(id, { image_model: 'dalle' });
  assert.equal(bad.status, 400);
  assert.equal(await draftOf(id), undefined);
  assert.deepEqual(await ledgerOf(id), []);
});

test('generate: 422 MENU_NO_DRINKS with no plan and with a plan of no drinks', async () => {
  const none = await newEvent({ plan: false });
  const a = await generate(none.id);
  assert.equal(a.status, 422);
  assert.equal(a.body.code, 'MENU_NO_DRINKS');
  const empty = await newEvent({ drinks: 0 });
  const b = await generate(empty.id);
  assert.equal(b.status, 422);
  assert.equal(b.body.code, 'MENU_NO_DRINKS');
  assert.equal(await draftOf(empty.id), undefined);
  assert.equal(uploads.length + imageCalls() + calls.words.length, 0);
});

test('generate: the background and the first 8 drinks, stamped with the posted model, drawn once each', async () => {
  const { id, planId } = await newEvent({ drinks: 9 });
  const res = await generate(id);
  assert.equal(res.status, 202);
  assert.equal(res.body.version, 1);
  await idle();
  const draft = await draftOf(id);
  assert.equal(draft.id, res.body.draft_id);
  assert.equal(draft.drink_plan_id, planId);
  assert.equal(draft.inputs.image_model, 'openai');
  assert.equal(draft.inputs.reference_key, null);
  assert.equal(draft.content.words_status, 'done');
  assert.deepEqual(draft.content.drinks.map((d) => d.key), KEYS.slice(0, 9));
  assert.deepEqual(draft.content.drinks.map((d) => d.has_art), [...Array(8).fill(true), false]);
  assert.ok(draft.content.drinks.every((d) => d.added_by_sync === false));
  const pieces = await piecesOf(id);
  assert.deepEqual(Object.keys(pieces), ['background', ...KEYS.slice(0, 8)]);
  for (const p of Object.values(pieces)) {
    assert.equal(p.status, 'done', p.piece_key);
    assert.equal(p.provider, 'openai');
    assert.equal(p.model, MODEL.openai);
    assert.equal(p.run_id, draft.run_id);
  }
  const ledger = await ledgerOf(id);
  assert.equal(ledger[0].kind, 'text', 'the text row is the run first');
  assert.equal(ledger[0].model, MODEL.text);
  assert.deepEqual(ledger.filter((r) => r.kind === 'image').map((r) => [r.piece_key, r.status, r.provider, r.model]),
    Object.keys(pieces).map((k) => [k, 'ok', 'openai', MODEL.openai]));
  assert.equal(calls.words.length, 1);
  assert.equal(calls.openai.length, 9);
  assert.equal(draft.art_version, 9);
});

test('generate: a reference uploads under menu-art/<id>/ref-, a PDF is refused, and Start over keeps it', async () => {
  const { id } = await newEvent();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('body')]);
  const refused = await generate(id, { reference_source: 'upload' }, { name: 'ref.pdf', bytes: pdf });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.fieldErrors.reference);
  assert.equal(uploads.length, 0);
  assert.equal(await draftOf(id), undefined);

  const first = await generate(id, { reference_source: 'upload' }, { name: 'client photo.png', bytes: img.reference });
  assert.equal(first.status, 202);
  await idle();
  assert.equal(uploads.filter((k) => k.includes('/ref-')).length, 1);
  const key = uploads.find((k) => k.includes('/ref-'));
  assert.match(key, new RegExp(`^menu-art/${id}/ref-[0-9a-f-]{36}\\.png$`));
  assert.equal((await draftOf(id)).inputs.reference_key, key);
  assert.ok(reads.includes(key), 'the job read the reference by its key');
  const got = await request('GET', `${base(id)}/reference`);
  assert.equal(got.status, 200);
  assert.ok(got.raw.equals(img.reference));
  assert.equal((await request('GET', `${base(id)}/reference?w=240`)).status, 400, 'the reference has no downscale');

  const again = await generate(id, { reference_source: 'upload' });
  assert.equal(again.status, 202);
  await idle();
  const kept = await draftOf(id);
  assert.equal(kept.version, 2);
  assert.equal(kept.inputs.reference_key, key, 'no file and the source unchanged: the stored reference is kept');
  assert.equal(uploads.filter((k) => k.includes('/ref-')).length, 1);

  const dropped = await generate(id, { reference_source: 'none' });
  assert.equal(dropped.status, 202);
  await idle();
  assert.equal((await draftOf(id)).inputs.reference_key, null);
  assert.equal((await request('GET', `${base(id)}/reference`)).status, 404);
});

test('generate: Start over upserts in place, keeps the approved stamps, resets added_by_sync and frees stranded reservations', async () => {
  const { id, draftId } = await ready();
  await pool.query(
    `UPDATE menu_drafts SET approved_version = 1, approved_art_version = 3, approved_print_key = $2, approved_at = NOW()
      WHERE proposal_id = $1`, [id, `menu-print/${id}/approved.jpg`]);
  const drinks = (await draftOf(id)).content.drinks.map((d, i) => (i === 1 ? { ...d, added_by_sync: true } : d));
  await setContent(id, { drinks });
  const stranded = await reservedRow(id, KEYS[0]);

  const res = await generate(id);
  assert.equal(res.status, 202);
  assert.equal(res.body.draft_id, draftId, 'the same row, never deleted and recreated');
  assert.equal(res.body.version, 2);
  assert.equal(await statusOfRow(stranded), 'released');
  await idle();
  const draft = await draftOf(id);
  assert.equal(draft.approved_version, 1);
  assert.equal(draft.approved_print_key, `menu-print/${id}/approved.jpg`);
  assert.equal(draft.art_version, 6, 'art_version keeps counting');
  assert.ok(draft.content.drinks.every((d) => d.added_by_sync === false));
});

test('generate: 429 at the image cap and at the text cap, and nothing is written', async () => {
  const { id } = await ready();
  const before = await draftOf(id);
  const ledgerBefore = (await ledgerOf(id)).length;
  process.env.MENU_ART_DAILY_IMAGE_CAP = String((await openCount('image')) + 2);
  const img429 = await generate(id);
  assert.equal(img429.status, 429);
  assert.equal(img429.body.code, 'MENU_ART_CAP_REACHED');
  await headroom();
  process.env.MENU_ART_DAILY_TEXT_CAP = String(await openCount('text'));
  const text429 = await generate(id);
  assert.equal(text429.status, 429);
  assert.equal(text429.body.code, 'MENU_ART_TEXT_CAP_REACHED');
  const after = await draftOf(id);
  assert.equal(after.version, before.version);
  assert.equal(after.run_id, before.run_id);
  assert.equal((await ledgerOf(id)).length, ledgerBefore, 'the rollback took the reservations with it');
  assert.ok(Object.values(await piecesOf(id)).every((p) => p.status === 'done'));
});

test('generate: two concurrent Generates leave exactly one run, and the superseded job makes no further call', async () => {
  const { id } = await newEvent();
  let open;
  wordsGate = { promise: new Promise((resolve) => { open = resolve; }) };
  let a;
  let b;
  try {
    [a, b] = await Promise.all([generate(id), generate(id)]);
  } finally {
    open();
  }
  assert.deepEqual([a.status, b.status], [202, 202]);
  assert.deepEqual([a.body.version, b.body.version].sort(), [1, 2]);
  await idle();
  const draft = await draftOf(id);
  const pieces = Object.values(await piecesOf(id));
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((p) => p.run_id === draft.run_id && p.status === 'done'));
  const ledger = await ledgerOf(id);
  const runs = [...new Set(ledger.map((r) => r.run_id))];
  assert.equal(runs.length, 2);
  const loser = runs.find((r) => r !== draft.run_id);
  assert.ok(ledger.filter((r) => r.run_id === loser && r.kind === 'image').every((r) => r.status === 'released'),
    'the superseded run never sent an image');
  assert.notEqual(ledger.find((r) => r.run_id === loser && r.kind === 'text').status, 'ok');
  assert.ok(ledger.filter((r) => r.run_id === draft.run_id).every((r) => r.status === 'ok'));
  assert.equal(calls.openai.length, 3, 'images for the surviving run only');
  assert.ok(calls.words.length <= 2);
});

// Fix round 1 of lane menu-bar-chain: the words step builds the "Also at the
// bar" lines from its own plan read, so it stamps the bar baseline from that
// same read; Generate's earlier read keeps the drinks, brief and image parts.
test('generate: a bar pick changed between Generate\'s plan read and the words step\'s is no bar change, and removing it later is one', async () => {
  const ev = await newEvent({ extra: { spirits: ['Vodka'] } });
  const steps = require('../../utils/menuArtJobSteps');
  const realFresh = steps.freshPlan;
  let fired = false;
  // The client adds Gin and edits the notes after Generate read the plan, before the job reads it.
  steps.freshPlan = async (pid) => {
    if (pid === ev.id && !fired) {
      fired = true;
      await setPlan(ev.planId, selections(2, { spirits: ['Vodka', 'Gin'], menuDesignNotes: 'Now with gold foil' }));
    }
    return realFresh(pid);
  };
  try {
    const res = await generate(ev.id);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await idle();
  } finally {
    steps.freshPlan = realFresh;
  }
  assert.equal(fired, true);
  const draft = await draftOf(ev.id);
  assert.deepEqual(draft.content.also_at_bar.find((l) => l.key === 'Spirits'), { key: 'Spirits', label: 'Spirits', text: 'Vodka, Gin.' });
  let diff = (await request('GET', base(ev.id))).body.diff;
  assert.deepEqual([diff.bar_changed, diff.bar_changed_labels], [false, []], 'the lines print what the baseline holds');
  assert.deepEqual(diff.brief_edited, ['notes'], 'the brief part is the one Generate read');
  assert.deepEqual(draft.plan_fingerprint.drink_keys, buildFingerprint(normalizePlan(await loadEventPlan(ev.id), await loadCatalogMaps())).drink_keys);
  // The client removes Gin again: the menu prints it, so that is a change.
  await setPlan(ev.planId, selections(2, { spirits: ['Vodka'], menuDesignNotes: 'Now with gold foil' }));
  diff = (await request('GET', base(ev.id))).body.diff;
  assert.deepEqual([diff.bar_changed, diff.bar_changed_labels], [true, ['Spirits']]);
});

// ── PATCH ───────────────────────────────────────────────────────────────────

test('PATCH: a stale version is 409 MENU_DRAFT_CHANGED and writes nothing', async () => {
  const { id } = await ready();
  const res = await request('PATCH', base(id), { json: { version: 7, content: { title: 'New title' } } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'MENU_DRAFT_CHANGED');
  const draft = await draftOf(id);
  assert.equal(draft.version, 1);
  assert.equal(draft.content.title, 'Garden Bar');
});

test('PATCH: a content edit before the words land is refused (400); an inputs edit is allowed', async () => {
  const { id } = await ready();
  await setContent(id, { words_status: 'pending' });
  const content = await request('PATCH', base(id), { json: { version: 1, content: { title: 'Early' } } });
  assert.equal(content.status, 400, 'validatePatch refuses it as a field error');
  assert.ok(content.body.fieldErrors.content);
  const inputs = await request('PATCH', base(id), { json: { version: 1, inputs: { art_direction: 'Bolder ink lines' } } });
  assert.equal(inputs.status, 200);
  assert.equal(inputs.body.version, 2);
  const draft = await draftOf(id);
  assert.equal(draft.inputs.art_direction, 'Bolder ink lines');
  assert.equal(draft.content.words_status, 'pending', 'an inputs-only PATCH never writes content');
  assert.equal(draft.content.title, 'Garden Bar');
});

test('PATCH: refuses inputs.reference_key, inputs.image_model, added_by_sync and palette; allows reference_source none', async () => {
  const { id } = await ready();
  const refKey = `menu-art/${id}/ref-stored.png`;
  await pool.query(
    `UPDATE menu_drafts SET inputs = inputs || jsonb_build_object('reference_source', 'upload', 'reference_key', $2::text, 'planner_image_role', 'logo')
      WHERE proposal_id = $1`, [id, refKey]);
  const drinks = (await draftOf(id)).content.drinks;
  const refusals = [
    [{ inputs: { reference_key: `menu-art/${id}/ref-mine.png` } }, 'reference_key'],
    [{ inputs: { image_model: 'gemini' } }, 'image_model'],
    [{ content: { drinks: drinks.map((d, i) => (i === 0 ? { ...d, added_by_sync: true } : d)) } }, 'drinks'],
    [{ content: { palette: [{ name: 'red', hex: '#ff0000' }] } }, 'palette'],
  ];
  for (const [body, field] of refusals) {
    const res = await request('PATCH', base(id), { json: { version: 1, ...body } });
    assert.equal(res.status, 400, field);
    assert.ok(res.body.fieldErrors[field], field);
  }
  assert.equal((await draftOf(id)).version, 1);
  const ok = await request('PATCH', base(id), { json: { version: 1, inputs: { reference_source: 'none' } } });
  assert.equal(ok.status, 200);
  const draft = await draftOf(id);
  assert.equal(draft.inputs.reference_source, 'none');
  assert.equal(draft.inputs.reference_key, refKey, 'PATCH never writes reference_key');
  assert.equal(draft.inputs.image_model, 'openai');
  r2.set(refKey, { buffer: img.reference, contentType: 'image/png' });
  reads.length = 0;
  assert.equal((await request('GET', base(id))).body.draft.inputs.has_reference, false, 'no longer the reference');
  assert.equal((await request('GET', `${base(id)}/reference`)).status, 404, 'and the reference GET agrees');
  assert.deepEqual(reads, []);
});

test('versions: a number past int4 is a 400 on PATCH, dismiss and sync, never a 500, and nothing is written', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  for (const version of [1e20, 2147483648, 0, -1, 1.5, '1']) {
    const patch = await request('PATCH', base(id), { json: { version, content: { title: 'Huge' } } });
    const dismiss = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version } });
    const sync = await request('POST', `${base(id)}/sync`, { json: { version, image_model: 'openai' } });
    for (const [label, res] of [['PATCH', patch], ['dismiss', dismiss], ['sync', sync]]) {
      assert.equal(res.status, 400, `${label} ${version}`);
      assert.ok(res.body.fieldErrors.version, `${label} ${version}`);
    }
  }
  const draft = await draftOf(id);
  assert.deepEqual([draft.version, draft.content.title, draft.dismissed_plan_hash], [1, 'Garden Bar', null]);
  assert.equal(calls.words.length + imageCalls(), 0);
});

test('the queue backstop pages only the sanitized descriptor, never the raw error', async () => {
  const secret = `client brief ${NONCE}`;
  const captured = [];
  realJob.__setTestHooks({ capture: (err, context) => { captured.push({ err, context }); } });
  try {
    queue('generate', () => { throw Object.assign(new Error(`OpenAI said: ${secret}`), { code: 'SOME_CODE' }); });
    for (let i = 0; i < 20 && !captured.length; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    realJob.__setTestHooks({});
  }
  assert.equal(captured.length, 1, 'the rejection was reported');
  const [{ err, context }] = captured;
  assert.ok(!err.message.includes(secret) && !JSON.stringify(context).includes(secret), 'no raw message reaches Sentry');
  assert.deepEqual(context.tags, { area: 'menuArt', step: 'generate' });
  assert.deepEqual(Object.keys(context.extra.descriptor).sort(), ['code', 'errorClass', 'provider', 'requestId', 'status']);
  assert.equal(context.extra.descriptor.code, 'SOME_CODE');
});

test('PATCH: the drink key set and the 8 / 12 / 4 limits are 400s', async () => {
  const { id } = await ready();
  const make = (i, art, hidden = false) => ({
    key: `custom:limit-${i}`, source: 'custom', catalog_kind: null, group: 'sig', catalog_id: null,
    display_name: `Limit ${i}`, description: null, name_ai_suggested: false, description_ai_written: false,
    visual_note: '', hidden, has_art: art, added_by_sync: false,
  });
  // 8 visible with art, 4 visible without, 1 hidden: every count at its limit.
  const stored = [...Array.from({ length: 8 }, (_, i) => make(i, true)), ...Array.from({ length: 4 }, (_, i) => make(8 + i, false)), make(12, false, true)];
  await setContent(id, { drinks: stored });
  const send = (drinks) => request('PATCH', base(id), { json: { version: 1, content: { drinks } } });
  const cases = [
    ['a changed key set', stored.slice(1)],
    ['a 13th visible drink', stored.map((d, i) => (i === 12 ? { ...d, hidden: false } : d))],
    ['a 9th drink with art', stored.map((d, i) => (i === 8 ? { ...d, has_art: true } : d))],
    ['a 5th visible drink without art', stored.map((d, i) => (i === 0 ? { ...d, has_art: false } : d))],
  ];
  for (const [label, drinks] of cases) {
    const res = await send(drinks);
    assert.equal(res.status, 400, label);
    assert.ok(res.body.fieldErrors.drinks, label);
  }
  const flood = await send(Array.from({ length: 5000 }, (_, i) => ({ key: `custom:flood-${i}` })));
  assert.equal(flood.status, 400, 'a list past any stored draft is refused before it is walked');
  assert.ok(flood.body.fieldErrors.drinks);
  assert.equal((await draftOf(id)).version, 1);
  const hide = await send(stored.map((d, i) => (i === 0 ? { ...d, hidden: true } : d)));
  assert.equal(hide.status, 200, 'a count may always go down');
});

test('PATCH: an unchanged save keeps the version; an edit bumps it and never touches pieces, art_version or the words status', async () => {
  const { id } = await ready();
  const before = await draftOf(id);
  const piecesBefore = await piecesOf(id);
  const same = await request('PATCH', base(id), { json: { version: 1, content: { title: ' Garden Bar ' } } });
  assert.equal(same.status, 200);
  assert.equal(same.body.version, 1);
  const edit = await request('PATCH', base(id), { json: { version: 1, content: { title: 'Rooftop Bar', text_backing: 'panel' } } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.version, 2);
  const draft = await draftOf(id);
  assert.equal(draft.content.title, 'Rooftop Bar');
  assert.equal(draft.content.text_backing, 'panel');
  assert.equal(draft.content.words_status, 'done');
  assert.equal(draft.art_version, before.art_version);
  assert.deepEqual(await piecesOf(id), piecesBefore);
  assert.equal(imageCalls(), 0);
});

// ── Re-roll ─────────────────────────────────────────────────────────────────

test('re-roll: 409 MENU_ART_PIECE_BUSY while working and while pending in an active run; allowed once stuck', async () => {
  const { id } = await ready();
  await setPiece(id, 'background', "status = 'working', heartbeat_at = NOW()");
  const working = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(working.status, 409);
  assert.equal(working.body.code, 'MENU_ART_PIECE_BUSY');
  await setPiece(id, 'background', "status = 'pending', heartbeat_at = NOW()");
  const pending = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, 'MENU_ART_PIECE_BUSY');
  assert.equal(imageCalls(), 0);
  await setPiece(id, 'background', "heartbeat_at = NOW() - interval '1 hour'");
  const stuck = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai', note: 'more gold leaf' } });
  assert.equal(stuck.status, 202);
  await idle();
  const bg = (await piecesOf(id)).background;
  assert.equal(bg.status, 'done');
  assert.equal(bg.reroll_note, 'more gold leaf');
  assert.equal(bg.drawn_count, 2);
  assert.notEqual(bg.run_id, (await draftOf(id)).run_id, 'a re-roll runs under its own piece run');
  assert.equal(calls.openai.length, 1);
});

test('re-roll: the stuck attempt\'s reserved row is released before the new one is reserved', async () => {
  const { id } = await ready();
  const oldRun = crypto.randomUUID();
  await setPiece(id, KEYS[0], "status = 'pending', run_id = $3, heartbeat_at = NOW() - interval '1 hour'", [oldRun]);
  const stranded = await reservedRow(id, KEYS[0], oldRun);
  const res = await request('POST', pieceUrl(id, KEYS[0], 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(res.status, 202);
  assert.equal(await statusOfRow(stranded), 'released');
  await idle();
  const piece = (await piecesOf(id))[KEYS[0]];
  assert.equal(piece.status, 'done');
  const rows = (await ledgerOf(id)).filter((r) => r.piece_key === KEYS[0] && r.run_id === piece.run_id);
  assert.deepEqual(rows.map((r) => r.status), ['ok']);
});

test('re-roll: under the other model only that piece changes provider and model', async () => {
  const { id } = await ready();
  const before = await piecesOf(id);
  const res = await request('POST', pieceUrl(id, KEYS[1], 'reroll'), { json: { image_model: 'gemini' } });
  assert.equal(res.status, 202);
  await idle();
  const pieces = await piecesOf(id);
  assert.equal(pieces[KEYS[1]].provider, 'gemini');
  assert.equal(pieces[KEYS[1]].model, MODEL.gemini);
  assert.equal(pieces[KEYS[1]].status, 'done');
  for (const key of ['background', KEYS[0]]) {
    assert.deepEqual(pieces[key], before[key], `${key} untouched`);
  }
  assert.equal(calls.gemini.length, 1);
  assert.equal(calls.openai.length, 0);
  const row = (await ledgerOf(id)).find((r) => r.run_id === pieces[KEYS[1]].run_id);
  assert.deepEqual([row.provider, row.model, row.status], ['gemini', MODEL.gemini, 'ok']);
  const draft = await draftOf(id);
  assert.equal(draft.inputs.image_model, 'openai', 'inputs.image_model records the last Generate only');
});

test('re-roll: a drink with art and no piece row gets one; no art, not on the menu, a bad key, a long note are refused', async () => {
  const { id } = await ready();
  await pool.query(
    'DELETE FROM menu_draft_pieces p USING menu_drafts d WHERE d.id = p.draft_id AND d.proposal_id = $1 AND p.piece_key = $2', [id, KEYS[1]]);
  const created = await request('POST', pieceUrl(id, KEYS[1], 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(created.status, 202);
  await idle();
  assert.equal((await piecesOf(id))[KEYS[1]].status, 'done');

  const drinks = (await draftOf(id)).content.drinks.map((d, i) => (i === 0 ? { ...d, has_art: false } : d));
  await setContent(id, { drinks });
  const noArt = await request('POST', pieceUrl(id, KEYS[0], 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(noArt.status, 400);
  const absent = await request('POST', pieceUrl(id, 'custom:not-on-this-menu', 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(absent.status, 404);
  await resetLimits();
  for (const bad of ['Custom:Upper', 'custom:../x', 'cocktail:', 'garnish:lime', `custom:${'a'.repeat(101)}`]) {
    const res = await request('POST', pieceUrl(id, bad, 'reroll'), { json: { image_model: 'openai' } });
    assert.equal(res.status, 400, bad);
  }
  const long = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai', note: 'x'.repeat(201) } });
  assert.equal(long.status, 400);
  const noModel = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: {} });
  assert.equal(noModel.status, 400);
  assert.equal(calls.openai.length, 1);
});

test('re-roll: refused before anything is reserved while the words are pending, failed or stuck, and with no plan', async () => {
  const { id, planId } = await ready();
  const before = await ledgerOf(id);
  const reroll = () => request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } });
  await setContent(id, { words_status: 'pending', words_heartbeat_at: new Date().toISOString() });
  const pending = await reroll();
  assert.deepEqual([pending.status, pending.body.code], [409, 'MENU_WORDS_PENDING']);
  await setContent(id, { words_status: 'working', words_heartbeat_at: new Date(Date.now() - 3600000).toISOString() });
  const stuck = await reroll();
  assert.deepEqual([stuck.status, stuck.body.code], [409, 'MENU_WORDS_NOT_WRITTEN'], 'an interrupted words step is not done');
  await setContent(id, { words_status: 'failed', words_error: 'The menu words could not be written. Try again.' });
  const failed = await reroll();
  assert.deepEqual([failed.status, failed.body.code], [409, 'MENU_WORDS_NOT_WRITTEN']);
  assert.match(failed.body.error, /Start over/);
  await setContent(id, { words_status: 'done' });
  await pool.query('UPDATE drink_plans SET proposal_id = NULL WHERE id = $1', [planId]);
  try {
    assert.equal((await request('GET', base(id))).body.draft.read_only, true);
    const noPlan = await reroll();
    assert.deepEqual([noPlan.status, noPlan.body.code], [422, 'MENU_NO_DRINKS']);
  } finally {
    await pool.query('UPDATE drink_plans SET proposal_id = $2 WHERE id = $1', [planId, id]);
  }
  assert.deepEqual((await ledgerOf(id)).map((r) => [r.id, r.status]), before.map((r) => [r.id, r.status]), 'nothing reserved');
  assert.equal((await piecesOf(id)).background.status, 'done');
  assert.equal(calls.words.length + imageCalls(), 0);
});

test('re-roll: 429 at the cap leaves the piece as it was', async () => {
  const { id } = await ready();
  const before = (await piecesOf(id)).background;
  process.env.MENU_ART_DAILY_IMAGE_CAP = String(await openCount('image'));
  const res = await request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'MENU_ART_CAP_REACHED');
  assert.deepEqual((await piecesOf(id)).background, before);
});

// ── Images ──────────────────────────────────────────────────────────────────

test('piece image: a done piece streams; ?w=240 and ?w=480 downscale with alpha; any other w is 400; a pending piece is 404', async () => {
  const { id } = await ready();
  const full = await request('GET', pieceUrl(id, KEYS[0], 'image'));
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'image/png');
  for (const w of [240, 480]) {
    const res = await request('GET', `${pieceUrl(id, KEYS[0], 'image')}?w=${w}`);
    assert.equal(res.status, 200, String(w));
    const meta = await sharp(res.raw).metadata();
    assert.deepEqual([meta.format, meta.width, meta.hasAlpha], ['png', w, true]);
  }
  for (const w of ['100', 'abc', '240&w=480', '', '240.0']) {
    assert.equal((await request('GET', `${pieceUrl(id, KEYS[0], 'image')}?w=${w}`)).status, 400, `w=${w}`);
  }
  await setPiece(id, KEYS[1], "status = 'pending'");
  assert.equal((await request('GET', pieceUrl(id, KEYS[1], 'image'))).status, 404);
  assert.equal((await request('GET', pieceUrl(id, 'Background', 'image'))).status, 400);
});

test('key guards: a key outside its prefix is a 404 and is never read, for the piece, the reference and the planner image', async () => {
  const { id, planId } = await ready();
  const other = proposalIds.find((p) => p !== id) || id + 1;
  for (const bad of [`menu-art/${other}/x.png`, `menu-art/${id}0/x.png`, `menu-art/${id}/../x.png`, `menu-art/${id}//x.png`, `drink-plan-logos/${planId}-x.png`]) {
    r2.set(bad, { buffer: img.reference, contentType: 'image/png' });
    await setPiece(id, 'background', 'r2_key = $3', [bad]);
    reads.length = 0;
    assert.equal((await request('GET', pieceUrl(id, 'background', 'image'))).status, 404, bad);
    assert.deepEqual(reads, [], `${bad} never read`);
  }
  for (const bad of [`menu-art/${id}/bg.png`, `menu-art/${other}/ref-x.png`, `menu-art/${id}/ref-../x.png`]) {
    r2.set(bad, { buffer: img.reference, contentType: 'image/png' });
    await pool.query(
      "UPDATE menu_drafts SET inputs = inputs || jsonb_build_object('reference_source', 'upload', 'reference_key', $2::text) WHERE proposal_id = $1",
      [id, bad]);
    reads.length = 0;
    assert.equal((await request('GET', `${base(id)}/reference`)).status, 404, bad);
    assert.deepEqual(reads, [], `${bad} never read`);
  }
  for (const bad of [`drink-plan-logos/${planId}0-x.png`, `drink-plan-logos/${planId}-../x.png`, `menu-art/${id}/ref-x.png`]) {
    r2.set(bad, { buffer: img.logo, contentType: 'image/png' });
    await setPlan(planId, selections(2, { _logoFilename: bad }));
    reads.length = 0;
    assert.equal((await request('GET', `${base(id)}/planner-image`)).status, 404, bad);
    assert.deepEqual(reads, [], `${bad} never read`);
  }
});

test('planner image: streams the lowest-id plan\'s image with ?w=; 404 when it has none; other w is 400', async () => {
  const { id, planId } = await newEvent();
  assert.equal((await request('GET', `${base(id)}/planner-image`)).status, 404);
  const key = `drink-plan-logos/${planId}-${Date.now()}.png`;
  r2.set(key, { buffer: img.logo, contentType: 'image/png' });
  await setPlan(planId, selections(2, { _logoFilename: key }));
  const full = await request('GET', `${base(id)}/planner-image`);
  assert.equal(full.status, 200);
  assert.ok(full.raw.equals(img.logo));
  const thumb = await request('GET', `${base(id)}/planner-image?w=240`);
  assert.equal(thumb.status, 200);
  assert.equal((await sharp(thumb.raw).metadata()).width, 240);
  assert.equal((await request('GET', `${base(id)}/planner-image?w=999`)).status, 400);
});

// ── Dismiss ─────────────────────────────────────────────────────────────────

test('dismiss: stores the plan hash under the version check, never bumps the version, and an approved draft stays approved', async () => {
  const { id, planId } = await ready();
  const key = `menu-print/${id}/approved-${NONCE}.jpg`;
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [id, key]);
  await pool.query(
    `UPDATE menu_drafts SET approved_version = version, approved_art_version = art_version, approved_print_key = $2,
            approved_at = NOW() WHERE proposal_id = $1`, [id, key]);
  assert.equal((await request('GET', base(id))).body.print.state, 'approved');
  await setPlan(planId, selections(2, { menuDesignNotes: 'Now with fireworks' }));
  const seen = await request('GET', base(id));
  assert.deepEqual(seen.body.diff.brief_edited, ['notes']);
  assert.equal(seen.body.diff.dismissed, false);
  const stale = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 9 } });
  assert.equal(stale.status, 409);
  const res = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 1, 'the version is unchanged');
  const draft = await draftOf(id);
  assert.equal(draft.version, 1);
  const current = normalizePlan(await loadEventPlan(id), await loadCatalogMaps());
  assert.equal(draft.dismissed_plan_hash, fingerprintHash(buildFingerprint(current)));
  const read = await request('GET', base(id));
  assert.equal(read.body.diff.dismissed, true);
  assert.equal(read.body.print.state, 'approved', 'dismissing the banner is not an edit since approval');
  const again = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 1 } });
  assert.deepEqual([again.status, again.body.version], [200, 1], 'dismissing the same plan again is fine');
  await setPlan(planId, selections(2, { menuDesignNotes: 'Fireworks and sparklers' }));
  assert.equal((await request('GET', base(id))).body.diff.dismissed, false);
  assert.equal(calls.words.length + imageCalls(), 0, 'dismiss works without calling anything');
});

test('dismiss: the stored hash covers the bar picks, so a later bar change shows again', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'] }));
  const res = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 1 } });
  assert.deepEqual([res.status, res.body.version], [200, 1]);
  let diff = (await request('GET', base(id))).body.diff;
  assert.deepEqual([diff.bar_changed, diff.dismissed], [true, true]);
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red', 'White'] }));
  diff = (await request('GET', base(id))).body.diff;
  assert.deepEqual([diff.bar_changed, diff.dismissed], [true, false]);
});

test('dismiss: leaves the Saved time alone, while an edit moves it (lane menu-bar-baseline)', async () => {
  const { id, planId } = await ready();
  const savedAt = async () => (await pool.query('SELECT updated_at FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0].updated_at.toISOString();
  await pool.query("UPDATE menu_drafts SET updated_at = NOW() - interval '5 days' WHERE proposal_id = $1", [id]);
  const before = await savedAt();
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'] }));
  const res = await request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(await savedAt(), before, 'a dismissal is no save');
  await setContent(id, { title: `Edited ${NONCE}` });
  assert.notEqual(await savedAt(), before);
});

// ── The legal-hold proposal (money law 15; lane menu-legal-hold-guards) ─────

// Every query and connection a request makes, while it runs.
async function watchedPool(send) {
  const seen = [];
  const realQuery = pool.query;
  const realConnect = pool.connect;
  pool.query = function watched(...args) {
    seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || ''));
    return realQuery.apply(this, args);
  };
  pool.connect = function watchedConnect(...args) {
    // pool.query checks out its own client through the callback form; only a held client counts.
    if (!args.length) seen.push('pool.connect');
    return realConnect.apply(this, args);
  };
  try {
    return { out: await send(), seen };
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
  }
}

test('legal hold: Generate, the draft PATCH, re-roll and Dismiss answer 409 LEGAL_HOLD before any read, upload, call, reservation or write; an unheld twin still works', async () => {
  const held = await ready();
  const twin = await ready();
  for (const ev of [held, twin]) await setPlan(ev.planId, selections(2, { menuDesignNotes: `Changed ${NONCE}` }));
  const before = await draftOf(held.id);
  const piecesBefore = await piecesOf(held.id);
  const ledgerBefore = (await ledgerOf(held.id)).map((r) => [r.id, r.status]);
  const sends = (id) => ({
    generate: () => generate(id, { reference_source: 'upload' }, { name: 'ref.png', bytes: img.reference }),
    patch: () => request('PATCH', base(id), { json: { version: 1, content: { title: `Held ${NONCE}` } } }),
    reroll: () => request('POST', pieceUrl(id, 'background', 'reroll'), { json: { image_model: 'openai' } }),
    dismiss: () => request('POST', `${base(id)}/dismiss-plan-change`, { json: { version: 1 } }),
  });
  __setLegalHoldIdsForTest([held.id]);
  try {
    for (const [name, send] of Object.entries(sends(held.id))) {
      const { out, seen } = await watchedPool(send);
      await idle();
      assert.deepEqual([out.status, out.body && out.body.code], [409, 'LEGAL_HOLD'], `${name}: ${JSON.stringify(out.body)}`);
      assert.deepEqual(seen.filter((q) => q === 'pool.connect' || /menu_drafts|menu_draft_pieces|drink_plans|proposals|menu_art_calls|cocktails/.test(q)), [],
        `${name}: refused before the proposal, its draft or its plan is read and before any transaction opens`);
    }
    const after = await draftOf(held.id);
    for (const col of ['version', 'art_version', 'run_id', 'content', 'inputs', 'plan_fingerprint', 'dismissed_plan_hash']) {
      assert.deepEqual(after[col], before[col], `${col} unchanged`);
    }
    assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString());
    assert.deepEqual(await piecesOf(held.id), piecesBefore, 'no piece written');
    assert.deepEqual((await ledgerOf(held.id)).map((r) => [r.id, r.status]), ledgerBefore, 'nothing reserved or released');
    assert.deepEqual([calls.words.length, imageCalls(), uploads.length], [0, 0, 0], 'no provider call and no upload');
  } finally {
    __setLegalHoldIdsForTest(null);
  }

  const twinSends = sends(twin.id);
  const patch = await twinSends.patch();
  assert.deepEqual([patch.status, patch.body.version], [200, 2], JSON.stringify(patch.body));
  const dismiss = await request('POST', `${base(twin.id)}/dismiss-plan-change`, { json: { version: 2 } });
  assert.deepEqual([dismiss.status, dismiss.body.version], [200, 2], JSON.stringify(dismiss.body));
  const reroll = await twinSends.reroll();
  assert.equal(reroll.status, 202, JSON.stringify(reroll.body));
  await idle();
  const gen = await twinSends.generate();
  assert.equal(gen.status, 202, JSON.stringify(gen.body));
  await idle();
  assert.ok(calls.words.length && imageCalls(), 'the twin still calls its providers');
});
