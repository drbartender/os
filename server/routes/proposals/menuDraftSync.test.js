process.env.NODE_ENV = 'test';
require('dotenv').config();
// Route tests for Update draft, POST /api/proposals/:id/menu-draft/sync (spec
// 2026-10-01 sections 7 and 9; spec 2026-10-19 section 17, the bar lines),
// read back through the real GET, beside the real Generate, PATCH and the boot
// stamp of the bar baseline (menuBarBaselineStamp.js). Split from
// menuDrafts.test.js (lane menu-bar-renamed-lines), whose harness this copies,
// so each suite stays well under the runner's bound: a minimal express app,
// the real menuDrafts.js router with menuDraftSync.js mounted, the real
// express-fileupload, hand-built multipart, requests over real HTTP.
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
// before the temp users), never by a pattern. The boot stamp runs on this
// suite's own drafts only (its onlyDraftIds seam).
//
// Run through the runner: node scripts/run-suites.js server/routes/proposals/menuDraftSync.test.js
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
  getSignedUrl: async () => { throw new Error('menuDraftSync.test: nothing may presign'); },
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
const { adminWriteLimiter, menuDraftReadLimiter, menuDraftEditLimiter } = require('../../middleware/rateLimiters');
const { buildFingerprint, normalizePlan, loadEventPlan, loadCatalogMaps } = require('../../utils/menuDrinkSource');
const { stampLegacyBarBaselines } = require('../../utils/menuBarBaselineStamp');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const menuDraftsRouter = require('./menuDrafts');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const NAMES = Array.from({ length: 10 }, (_, i) => `Zq Drink ${i + 1} ${NONCE}`);
const KEYS = NAMES.map((n) => `custom:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
const MODEL = { openai: 'route-test-gpt-image', gemini: 'route-test-gemini-image', text: 'route-test-text' };
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP',
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
const calls = { words: [], openai: [], gemini: [] };
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

const resetCalls = () => { for (const list of [calls.words, calls.openai, calls.gemini, uploads, reads]) list.length = 0; };
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

const imageCalls = () => calls.openai.length + calls.gemini.length;

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  img.openaiBackground = await canvas(320, 400, { r: 20, g: 30, b: 70 }).jpeg().toBuffer();
  img.openaiDrink = await drinkOn({ r: 0, g: 0, b: 0, alpha: 0 }, 'png');
  img.geminiBackground = await canvas(400, 500, { r: 240, g: 230, b: 210 }).jpeg().toBuffer();
  img.geminiDrink = await drinkOn({ r: 255, g: 0, b: 255 }, 'jpeg');

  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_IMAGE_MODEL = MODEL.openai;
  process.env.MENU_ART_GEMINI_IMAGE_MODEL = MODEL.gemini;
  process.env.MENU_ART_TEXT_MODEL = MODEL.text;
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
    console.error('menuDraftSync.test unexpected error:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await idle();
  openaiClient._resetForTest();
  geminiClient._resetForTest();
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
  delete process.env.MENU_ART_STALE_MS;
  await headroom();
  assert.equal(tripwire, 0, 'a request reached global fetch');
});
// ── Update draft (sync) ─────────────────────────────────────────────────────

test('sync: adds a typed and a catalog drink, removes a dropped one with its piece and reserved row, and draws the added art one at a time', async (t) => {
  if (!catalog) { t.skip('no catalog cocktail with a description on this database'); return; }
  const { id, planId } = await ready();
  await pool.query("UPDATE menu_drafts SET dismissed_plan_hash = 'dismissed-before' WHERE proposal_id = $1", [id]);
  const stranded = await reservedRow(id, KEYS[1]);
  await setPlan(planId, selections(0, { customCocktails: [NAMES[0], NAMES[2]], signatureDrinks: [catalog.id] }));
  const catalogKey = `cocktail:${catalog.id}`;

  const res = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'gemini' } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.version, 2);
  assert.equal(calls.words.length, 1, 'one words call, for the typed drink only');
  assert.deepEqual(JSON.parse(calls.words[0].input).drinks.map((d) => d.key), [KEYS[2]]);
  assert.equal(await statusOfRow(stranded), 'released', 'the dropped drink\'s unspent reservation stops counting');
  await idle();

  const draft = await draftOf(id);
  assert.deepEqual(draft.content.drinks.map((d) => [d.key, d.has_art, d.added_by_sync]),
    [[KEYS[0], true, false], [catalogKey, true, true], [KEYS[2], true, true]]);
  const cat = draft.content.drinks[1];
  assert.equal(cat.display_name, catalog.name.slice(0, 60).trim());
  assert.equal(cat.description, catalog.description);
  assert.equal(cat.source, 'catalog');
  assert.equal(Object.keys(cat).length, 13);
  assert.equal(Object.keys(draft.content.drinks[2]).length, 13);
  assert.equal(draft.dismissed_plan_hash, null);
  const current = normalizePlan(await loadEventPlan(id), await loadCatalogMaps());
  assert.deepEqual(draft.plan_fingerprint, buildFingerprint(current));

  const pieces = await piecesOf(id);
  assert.equal(pieces[KEYS[1]], undefined, 'the dropped drink\'s piece is gone');
  for (const key of [catalogKey, KEYS[2]]) {
    assert.deepEqual([pieces[key].status, pieces[key].provider, pieces[key].model], ['done', 'gemini', MODEL.gemini], key);
  }
  assert.equal(pieces[catalogKey].run_id, pieces[KEYS[2]].run_id, 'one piece run for the added art');
  assert.equal(calls.gemini.length, 2);
  assert.equal(geminiMaxActive, 1, 'the added drinks are drawn one after another');
  const read = await request('GET', base(id));
  assert.deepEqual([read.body.diff.added, read.body.diff.dropped], [[], []]);
});

test('sync: a stale version is 409, words still pending is 409, and neither writes or calls anything', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  const stale = await request('POST', `${base(id)}/sync`, { json: { version: 5, image_model: 'openai' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'MENU_DRAFT_CHANGED');
  await setContent(id, { words_status: 'pending' });
  const pending = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, 'MENU_WORDS_PENDING');
  const bad = await request('POST', `${base(id)}/sync`, { json: { version: 1 } });
  assert.equal(bad.status, 400);
  assert.equal((await draftOf(id)).version, 1);
  assert.equal(calls.words.length + imageCalls(), 0);
});

test('sync: failed or interrupted words answer MENU_WORDS_NOT_WRITTEN, never "still being written"', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  await setContent(id, { words_status: 'failed' });
  const failed = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.deepEqual([failed.status, failed.body.code], [409, 'MENU_WORDS_NOT_WRITTEN']);
  assert.ok(!/still being written/.test(failed.body.error));
  await setContent(id, { words_status: 'pending', words_heartbeat_at: new Date(Date.now() - 3600000).toISOString() });
  const stuck = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.deepEqual([stuck.status, stuck.body.code], [409, 'MENU_WORDS_NOT_WRITTEN']);
  assert.equal(calls.words.length + imageCalls(), 0);
});

test('sync: at the image cap a sync whose added drink gets art answers 429 before its words call is reserved or spent', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  const before = await draftOf(id);
  const textBefore = await openCount('text');
  process.env.MENU_ART_DAILY_IMAGE_CAP = String(await openCount('image'));
  const res = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.deepEqual([res.status, res.body.code], [429, 'MENU_ART_CAP_REACHED']);
  assert.equal(calls.words.length, 0, 'no words call was spent');
  assert.equal(await openCount('text'), textBefore, 'no words row was reserved');
  const after = await draftOf(id);
  assert.deepEqual([after.version, after.content], [before.version, before.content]);
  assert.equal(imageCalls(), 0);
});

test('sync: a 429 at the text cap refuses before anything is written', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  const before = await draftOf(id);
  process.env.MENU_ART_DAILY_TEXT_CAP = String(await openCount('text'));
  const res = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'MENU_ART_TEXT_CAP_REACHED');
  const after = await draftOf(id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.content, before.content);
  assert.equal(calls.words.length + imageCalls(), 0);
});

const planNow = async (id) => normalizePlan(await loadEventPlan(id), await loadCatalogMaps());
const syncAt = (id, version, imageModel = 'openai') => request('POST', `${base(id)}/sync`, { json: { version, image_model: imageModel } });

// Stored lines carry the builder's label as their key (lane menu-bar-baseline).
const BW = (text, label = 'Beer and Wine') => ({ key: 'Beer and Wine', label, text });
const SPIRITS = (text, label = 'Spirits') => ({ key: 'Spirits', label, text });
const NA = (text, label = 'Non-Alcoholic') => ({ key: 'Non-Alcoholic', label, text });
// A line stored before keys existed: no key, whatever its label.
const OLD = (label, text) => ({ label, text });
// A draft made before the per-line bar check: no bar baseline, the given lines unkeyed.
async function preDeploy(id, lines) {
  await pool.query("UPDATE menu_drafts SET plan_fingerprint = plan_fingerprint - 'bar_lines' - 'bar_hash' WHERE proposal_id = $1", [id]);
  await setContent(id, { also_at_bar: lines });
}
const diffOf = async (id) => (await request('GET', base(id))).body.diff;
const barOf = (d) => [d.bar_changed, d.bar_changed_labels, d.bar_unchecked];

test('sync: an edited Spirits line survives an Update draft that only changes the wine; the edited wine line is replaced', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Vodka.')]);
  const edited = [BW('Red, and a house pinot.'), SPIRITS('Vodka, from a local distillery.')];
  await setContent(id, { also_at_bar: edited });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], spirits: ['Vodka'] }));
  const seen = (await request('GET', base(id))).body.diff;
  assert.deepEqual([seen.bar_changed, seen.bar_changed_labels, seen.added, seen.dropped], [true, ['Beer and Wine'], [], []]);
  const res = await syncAt(id, 1);
  assert.deepEqual([res.status, res.body.version], [202, 2], JSON.stringify(res.body));
  const draft = await draftOf(id);
  assert.deepEqual(draft.content.also_at_bar, [BW('White.'), edited[1]], 'only the line whose picks moved is rebuilt');
  assert.deepEqual(draft.plan_fingerprint.bar_lines, buildFingerprint(await planNow(id)).bar_lines);
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
  assert.equal(calls.words.length + imageCalls(), 0, 'a bar-only update calls nothing');
});

test('sync: a category whose picks went loses its line and a new one gains its line in print order; an untouched edited line stays', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  const pinot = BW('Red, and a house pinot.');
  await setContent(id, { also_at_bar: [pinot, SPIRITS('Vodka.')] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] }));
  assert.deepEqual((await request('GET', base(id))).body.diff.bar_changed_labels, ['Non-Alcoholic', 'Spirits']);
  let res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [pinot, NA('Athletic Brewing NA.')]);
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'], spirits: ['Gin'] }));
  res = await syncAt(id, 2);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [pinot, SPIRITS('Gin.'), NA('Athletic Brewing NA.')],
    'a new line takes its place in the print order');
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('generate: each Also at the bar line is stored with the builder\'s label as its key', async () => {
  const { id } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] } });
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Vodka.'), NA('Athletic Brewing NA.')]);
});

test('sync: a renamed line is found by its key: rewritten in place when its picks moved, removed when they went, kept with its words and place when they held', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] } });
  // The owner renames every label on the canvas (the PATCH keeps each stored key).
  await setContent(id, { also_at_bar: [BW('Red, and a house pinot.', 'Beer & Wine'), SPIRITS('Vodka, Gin.', 'Liquor'),
    NA('Athletic Brewing NA.', 'Zero Proof')] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], beerFromFullBar: ['Non-Alcoholic'] }));
  assert.deepEqual((await request('GET', base(id))).body.diff.bar_changed_labels, ['Beer and Wine', 'Spirits']);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.'), NA('Athletic Brewing NA.', 'Zero Proof')],
    'the moved line is rebuilt in its place, the gone one removed, the held one keeps its words and place');
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('sync: a stored line with no key, from before keys, is keyed by its label and refreshed', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await setContent(id, { also_at_bar: [{ label: 'Beer and Wine', text: 'Red.' }, { label: 'Spirits', text: 'Vodka, local.' }] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], spirits: ['Vodka'] }));
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.'), SPIRITS('Vodka, local.')]);
});

test('sync: an unkeyed line under a stored baseline is rebuilt with the changed lines, as every unkeyed line is', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] } });
  // Two lines, the NA one renamed, neither keyed (stored before keys, or a PATCH that raced a key write).
  await setContent(id, { also_at_bar: [{ label: 'Beer and Wine', text: 'Red.' }, { label: 'Zero Proof', text: 'Athletic Brewing NA.' }] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'] }));
  assert.deepEqual((await request('GET', base(id))).body.diff.bar_changed_labels, ['Beer and Wine', 'Non-Alcoholic']);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.')],
    'the unkeyed Zero Proof line gave way to the built lines; its category is gone');
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('sync: a draft with no baseline yet: the GET and Update draft read the baseline the boot stamp would give it, so the card shows what Update draft does', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  // Before the per-line check: no bar baseline, lines unkeyed, Beer and Wine renamed.
  await preDeploy(id, [OLD('Beer & Wine', 'Red, house pinot.'), OLD('Spirits', 'Vodka.')]);
  // Since Generate the client swapped the wine and dropped every spirit, and the plan lost a drink.
  await setPlan(planId, selections(1, { wineFromFullBar: ['White'] }));
  const seen = await diffOf(id);
  assert.deepEqual([...barOf(seen), seen.dropped.length], [true, ['Spirits'], 1, 1],
    'the stored Spirits line proves its category went; the renamed line cannot be checked');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const draft = await draftOf(id);
  assert.deepEqual(draft.content.also_at_bar, [BW('White.')],
    'the gone Spirits line is removed and the renamed line rebuilt and keyed, in this one click');
  assert.deepEqual(draft.plan_fingerprint.bar_lines, buildFingerprint(await planNow(id)).bar_lines);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

test('sync: a line no key can be found for gives way to the built lines when the bar moves, so no stale pick prints', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  // A keyed, hand-edited Beer and Wine line and a renamed line whose words name no category.
  await setContent(id, { also_at_bar: [BW('Red, house pinot.'), { label: 'House pours', text: 'Our favorites.' }] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], spirits: ['Gin'] }));
  assert.deepEqual((await request('GET', base(id))).body.diff.bar_changed_labels, ['Spirits']);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red, house pinot.'), SPIRITS('Gin.')],
    'the keyed line keeps its words; the unkeyed one is replaced by the built Spirits line');
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('sync: an unkeyed renamed line is rebuilt and keyed even when every changed category has a keyed line', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  // The Spirits line renamed and filled with brand names before keys existed; only the wine moves.
  await setContent(id, { also_at_bar: [BW('Red, house pinot.'), OLD('Liquor', 'Tito\'s, Hendrick\'s.')] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], spirits: ['Vodka'] }));
  assert.deepEqual((await request('GET', base(id))).body.diff.bar_changed_labels, ['Beer and Wine']);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.'), SPIRITS('Vodka.')],
    'nothing matches the renamed line to Spirits by its place, so it is rebuilt from the picks');
});

test('sync: a pre-deploy renamed line whose category went is removed in one Update draft; the keyed line keeps its words', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red, house pinot.'), OLD('Liquor', 'Tito\'s.')]);
  // The client dropped every spirit: two stored lines for one built category.
  await setPlan(planId, selections(1, { wineFromFullBar: ['Red'] }));
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1]);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red, house pinot.')]);
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('sync: a line renamed through the PATCH after the deploy keeps its key, so a new category is added beside it and its words stay', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  // Lines stored before keys, the baseline already stamped.
  await setContent(id, { also_at_bar: [{ label: 'Beer and Wine', text: 'Red.' }, { label: 'Spirits', text: 'Vodka.' }] });
  const patch = await request('PATCH', base(id), { json: { version: 1, content: {
    also_at_bar: [{ label: 'Beer and Wine', text: 'Red.' }, { label: 'Liquor', text: 'Tito\'s.' }] } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [{ label: 'Beer and Wine', text: 'Red.' }, SPIRITS('Tito\'s.', 'Liquor')]);
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] }));
  const res = await syncAt(id, patch.body.version);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Tito\'s.', 'Liquor'), NA('Athletic Brewing NA.')]);
});

test('sync: an unkeyed line between keyed ones is rebuilt in its category\'s place when another line is refreshed', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] } });
  await setContent(id, { also_at_bar: [BW('Red.'), OLD('Liquor', 'Tito\'s.'), NA('Athletic Brewing NA.')] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] }));
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.'), SPIRITS('Vodka.'), NA('Athletic Brewing NA.')]);
});

test('sync: a pre-deploy swap behind a renamed line whose words name its old category is repaired in one Update draft', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Liquor', 'Vodka, local.')]);
  // Spirits dropped, NA added before the deploy.
  await setPlan(planId, selections(1, { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] }));
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1], 'the renamed line is unchecked; no category is guessed');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), NA('Athletic Brewing NA.')]);
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

test('sync: two renamed lines are both rebuilt and keyed when one category changes', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await setContent(id, { also_at_bar: [OLD('Beer & Wine', 'Red, house pinot.'), OLD('Liquor', 'Tito\'s.')] });
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], spirits: ['Vodka', 'Gin'] }));
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Vodka, Gin.')]);
});

test('sync: a keyed line whose category the picks no longer build is removed, though only its unkeyed entry was flagged', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] } });
  // Stamped with the renamed Spirits line flagged, then renamed back to its builder label.
  const fp = buildFingerprint(await planNow(id));
  const barLines = { ...fp.bar_lines, 'unkeyed:1': 'flagged' };
  await pool.query("UPDATE menu_drafts SET plan_fingerprint = plan_fingerprint || jsonb_build_object('bar_lines', $2::jsonb, 'bar_hash', 'x') WHERE proposal_id = $1",
    [id, barLines]);
  await setContent(id, { also_at_bar: [BW('Red.'), { label: 'Spirits', text: 'Tito\'s.' }, NA('Athletic Brewing NA.')] });
  assert.deepEqual(barOf(await diffOf(id)), [true, ['Spirits'], 0], 'the line prints a spirit the picks no longer carry');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), NA('Athletic Brewing NA.')]);
});

test('sync: a notes edit and a new client image saved with a bar change still read after Update draft', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'] } });
  await setPlan(planId, selections(2, {
    wineFromFullBar: ['White'], menuDesignNotes: 'Now with gold foil', _logoFilename: `drink-plan-logos/${planId}-new-${NONCE}.png`,
  }));
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const diff = (await request('GET', base(id))).body.diff;
  assert.deepEqual([diff.bar_changed, diff.brief_edited, diff.image_changed], [false, ['notes'], true],
    'Update draft applies the bar, never the notes or the image');
  const fp = (await draftOf(id)).plan_fingerprint;
  const current = buildFingerprint(await planNow(id));
  assert.deepEqual([fp.drink_keys, fp.bar_hash], [current.drink_keys, current.bar_hash]);
  assert.notEqual(fp.brief_hash, current.brief_hash);
  assert.equal(fp.planner_image_key, null);
});

test('sync: without the keys a bar-only or a drop-only Update draft still works; one that must write words or draw is 503 and writes nothing', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'] } });
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'] }));
  let res = await syncAt(id, 1);
  assert.deepEqual([res.status, res.body.version], [202, 2], JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.')]);
  await setPlan(planId, selections(1, { wineFromFullBar: ['White'] }));
  res = await syncAt(id, 2, 'gemini');
  assert.deepEqual([res.status, res.body.version], [202, 3], JSON.stringify(res.body));

  const ledgerBefore = (await ledgerOf(id)).length;
  await setPlan(planId, selections(3, { wineFromFullBar: ['White'] }));
  res = await syncAt(id, 3);
  assert.deepEqual([res.status, res.body.code], [503, 'MENU_ART_NOT_CONFIGURED'], 'a typed drink needs a words call');
  if (catalog) {
    await setPlan(planId, selections(1, { wineFromFullBar: ['White'], signatureDrinks: [catalog.id] }));
    res = await syncAt(id, 3);
    assert.deepEqual([res.status, res.body.code], [503, 'MENU_ART_NOT_CONFIGURED'], 'a catalog drink needs only its art');
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    res = await syncAt(id, 3, 'gemini');
    assert.deepEqual([res.status, res.body.code], [503, 'MENU_ART_GEMINI_NOT_CONFIGURED'], 'Gemini art needs its key');
  }
  assert.equal((await draftOf(id)).version, 3);
  assert.equal((await ledgerOf(id)).length, ledgerBefore, 'no call reserved');
  assert.equal(calls.words.length + imageCalls(), 0);
});

test('sync: a draft with no bar baseline keeps its lines (hand edits included) and gains bar_lines on Update draft', async () => {
  const { id, planId } = await ready({ extra: { wineFromFullBar: ['Red'] } });
  const edited = [BW('Red, and a house pinot.')];
  await setContent(id, { also_at_bar: edited });
  await pool.query("UPDATE menu_drafts SET plan_fingerprint = plan_fingerprint - 'bar_lines' - 'bar_hash' WHERE proposal_id = $1", [id]);
  await setPlan(planId, selections(2, { wineFromFullBar: ['Sparkling'] }));
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const draft = await draftOf(id);
  assert.deepEqual(draft.content.also_at_bar, edited, 'no baseline, so nothing reads changed and the owner\'s line stays');
  assert.deepEqual(draft.plan_fingerprint.bar_lines, buildFingerprint(await planNow(id)).bar_lines);
  assert.equal((await request('GET', base(id))).body.diff.bar_changed, false);
});

// ── Renamed pre-deploy lines (lane menu-bar-renamed-lines, spec 17) ─────────
// The shapes the match by place got wrong: a renamed pre-deploy line is never
// matched to a category, reads as bar_unchecked (never "The bar picks
// changed"), and one Update draft rebuilds and keys it from the client's picks.

test('sync: a sparkling NA line renamed before the deploy reads unchecked, never as a pick change, and one Update draft rebuilds and keys it', async () => {
  const { id, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Zero Proof', 'Sparkling cider, mocktails.')]);
  const stamp = await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual([stamp.stamped, stamp.flagged], [[draftId], [draftId]]);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1], 'no pick moved, so the bar picks did not change');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), NA('Athletic Brewing NA.')]);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

test('sync: a Spirits line naming a whisky called Red reads unchecked; Update draft rebuilds it and the keyed line keeps its words', async () => {
  const { id, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red, house pinot.'), OLD('Liquor', 'Tito\'s, Johnnie Walker Red.')]);
  await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1], 'a wine word in a whisky name is no pick change');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red, house pinot.'), SPIRITS('Vodka.')]);
});

test('sync: a brand-only line behind a swap made before the deploy is said on the GET and rebuilt, so the dropped category stops printing', async () => {
  const { id, planId, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Liquor', 'Tito\'s.')]);
  // Before the deploy the client dropped every spirit and added an NA beer.
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] }));
  await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1]);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), NA('Athletic Brewing NA.')],
    'no Liquor line is kept for a category the bar no longer carries');
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

test('sync: a beer line naming a bourbon stout behind a swap made before the deploy is rebuilt, never kept as the Spirits line', async () => {
  const { id, planId, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] } });
  await preDeploy(id, [OLD('Beer & Wine', 'Bourbon Barrel Stout, Stella.'), OLD('Non-Alcoholic', 'Athletic Brewing NA.')]);
  // Before the deploy the client dropped all beer and wine and added Vodka.
  await setPlan(planId, selections(2, { spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] }));
  await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1]);
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [SPIRITS('Vodka.'), NA('Athletic Brewing NA.')]);
});

test('sync: a renamed line edited after the stamp is rebuilt and keyed in its category\'s place, and stays in print order after', async () => {
  const { id, planId, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Zero Proof', 'Run Wild.')]);
  await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  // The owner edits the renamed line after the stamp; its new words name wine.
  const patch = await request('PATCH', base(id), { json: { version: 1, content: {
    also_at_bar: [OLD('Beer and Wine', 'Red.'), OLD('Zero Proof', 'Sparkling water, Red Bull.')] } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  await setPlan(planId, selections(2, { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'], spirits: ['Vodka'] }));
  assert.deepEqual(barOf(await diffOf(id)), [true, ['Spirits'], 1]);
  let res = await syncAt(id, patch.body.version);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Vodka.'), NA('Athletic Brewing NA.')]);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
  await setPlan(planId, selections(2, { wineFromFullBar: ['White'], beerFromFullBar: ['Non-Alcoholic'], spirits: ['Vodka'] }));
  res = await syncAt(id, res.body.version);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('White.'), SPIRITS('Vodka.'), NA('Athletic Brewing NA.')]);
});

test('sync: on a draft the stamp failed on, the GET says the renamed line cannot be checked before the Update draft that rebuilds it', async () => {
  const { id, planId, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Liquor', 'Tito\'s, and a White Russian.')]);
  // The stamp's plan read fails for this draft at boot, so it keeps no baseline.
  const db = { query: (sql, params) => (/FROM drink_plans/.test(sql) && params[0] === id
    ? Promise.reject(new Error('pooler reset')) : pool.query(sql, params)) };
  const stamp = await stampLegacyBarBaselines({ db, onlyDraftIds: [draftId] });
  assert.deepEqual([stamp.failed, stamp.stamped], [[draftId], []]);
  assert.equal(Object.prototype.hasOwnProperty.call((await draftOf(id)).plan_fingerprint, 'bar_lines'), false);
  // Days later the client adds a drink, which invites Update draft.
  await setPlan(planId, selections(3, { wineFromFullBar: ['Red'], spirits: ['Vodka'] }));
  const seen = await diffOf(id);
  assert.deepEqual([...barOf(seen), seen.added.length], [false, [], 1, 1], 'the card says the renamed line will be rebuilt');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const draft = await draftOf(id);
  assert.deepEqual(draft.content.also_at_bar, [BW('Red.'), SPIRITS('Vodka.')]);
  assert.deepEqual(draft.plan_fingerprint.bar_lines, buildFingerprint(await planNow(id)).bar_lines);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

// ── The count and the rebuild agree (fix round 1) ───────────────────────────
// bar_unchecked counts the stored lines no key can be found for, so the card
// says what Update draft will rebuild, whether or not a baseline is stored.

test('sync: a line renamed with no key after the stamp is counted on the GET and rebuilt by Update draft', async () => {
  const { id, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Spirits', 'Vodka.')]);
  const stamp = await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual([stamp.stamped, stamp.flagged], [[draftId], []], 'stamped while every line sat under its builder label');
  // The deploy's outgoing instance (or main's PATCH after a revert) renames a line and writes no key.
  await setContent(id, { also_at_bar: [OLD('Beer and Wine', 'Red.'), OLD('Liquor', 'Tito\'s.')] });
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1], 'the card names the line Update draft will rebuild');
  const res = await syncAt(id, 1);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Vodka.')]);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

test('sync: a renamed line renamed back to its builder label clears the notice, and Update draft keys it and keeps its words', async () => {
  const { id, draftId } = await ready({ extra: { wineFromFullBar: ['Red'], spirits: ['Vodka'] } });
  await preDeploy(id, [OLD('Beer and Wine', 'Red.'), OLD('Liquor', 'Tito\'s.')]);
  await stampLegacyBarBaselines({ onlyDraftIds: [draftId] });
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 1]);
  const patch = await request('PATCH', base(id), { json: { version: 1, content: {
    also_at_bar: [OLD('Beer and Wine', 'Red.'), OLD('Spirits', 'Tito\'s.')] } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0], 'no renamed line is left');
  const res = await syncAt(id, patch.body.version);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual((await draftOf(id)).content.also_at_bar, [BW('Red.'), SPIRITS('Tito\'s.')]);
  assert.deepEqual(barOf(await diffOf(id)), [false, [], 0]);
});

// ── The legal-hold proposal (money law 15) ──────────────────────────────────

test('sync: the legal-hold proposal is refused with 409 LEGAL_HOLD before any read, call, reservation or write; an unheld twin still syncs', async () => {
  const held = await ready({ extra: { wineFromFullBar: ['Red'] } });
  const twin = await ready({ extra: { wineFromFullBar: ['Red'] } });
  // Each plan gains a typed drink (a words call and art) and swaps its wine.
  for (const ev of [held, twin]) await setPlan(ev.planId, selections(3, { wineFromFullBar: ['White'] }));
  const before = await draftOf(held.id);
  const ledgerBefore = (await ledgerOf(held.id)).map((r) => [r.id, r.status]);
  __setLegalHoldIdsForTest([held.id]);
  const seen = [];
  const realQuery = pool.query;
  pool.query = function watched(...args) {
    seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || ''));
    return realQuery.apply(this, args);
  };
  let res;
  try {
    res = await syncAt(held.id, 1);
  } finally {
    pool.query = realQuery;
  }
  try {
    assert.deepEqual([res.status, res.body.code], [409, 'LEGAL_HOLD'], JSON.stringify(res.body));
    assert.deepEqual(seen.filter((q) => /menu_drafts|drink_plans|proposals|menu_art_calls|cocktails/.test(q)), [],
      'refused before the proposal, its draft or its plan is read');
    const after = await draftOf(held.id);
    assert.deepEqual([after.version, after.content, after.plan_fingerprint, after.dismissed_plan_hash, after.updated_at.toISOString()],
      [before.version, before.content, before.plan_fingerprint, before.dismissed_plan_hash, before.updated_at.toISOString()]);
    assert.deepEqual((await ledgerOf(held.id)).map((r) => [r.id, r.status]), ledgerBefore, 'nothing reserved');
    assert.equal(calls.words.length + imageCalls(), 0, 'no provider call');
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  const ok = await syncAt(twin.id, 1);
  assert.deepEqual([ok.status, ok.body.version], [202, 2], JSON.stringify(ok.body));
});

// ── The keys, before anything is spent ──────────────────────────────────────

test('sync: drawn by Gemini with no Gemini key, a sync that adds drinks is refused before its words call reserves or spends', async () => {
  // Generate fills the eight art slots, so the added drink gets none at the first read;
  // a slot freed during the words call would still hand it art.
  const { id, planId } = await ready({ drinks: 8 });
  await setPlan(planId, selections(9));
  delete process.env.GEMINI_API_KEY;
  const before = await draftOf(id);
  const textRows = async () => (await ledgerOf(id)).filter((r) => r.kind === 'text').map((r) => [r.id, r.status]);
  const textBefore = await textRows();
  const res = await syncAt(id, 1, 'gemini');
  assert.deepEqual([res.status, res.body.code], [503, 'MENU_ART_GEMINI_NOT_CONFIGURED'], JSON.stringify(res.body));
  assert.equal(calls.words.length, 0, 'no words call');
  assert.deepEqual(await textRows(), textBefore, 'no text reservation');
  assert.equal((await draftOf(id)).version, before.version);
});

// Every query sent on a client taken with pool.connect() while watching, and
// each one that started while another was still running on the same client
// (pg 8 queues it with a deprecation warning; pg 9 refuses it). pool.query's
// own callback-form connect passes through untouched.
function watchHeldClients() {
  const realConnect = pool.connect;
  const seen = { queries: [], overlaps: [] };
  pool.connect = function connect(...args) {
    if (args.length) return realConnect.apply(this, args);
    return realConnect.call(this).then((client) => {
      const { release, query } = client;
      const ownQuery = Object.prototype.hasOwnProperty.call(client, 'query');
      let active = 0;
      client.query = function watchedQuery(...q) {
        const text = String(typeof q[0] === 'string' ? q[0] : (q[0] && q[0].text) || '').replace(/\s+/g, ' ').trim();
        seen.queries.push(text);
        if (active > 0) seen.overlaps.push(text.slice(0, 80));
        active += 1;
        const done = () => { active -= 1; };
        const out = query.apply(client, q);
        if (out && typeof out.then === 'function') out.then(done, done); else done();
        return out;
      };
      client.release = function watchedRelease(...r) {
        if (ownQuery) client.query = query; else delete client.query;
        client.release = release;
        return release.apply(client, r);
      };
      return client;
    });
  };
  return { seen, restore: () => { pool.connect = realConnect; } };
}

test('sync: no held client ever runs two queries at once, and the catalog still loads through the transaction', async () => {
  const { id, planId } = await ready();
  await setPlan(planId, selections(3));
  const watch = watchHeldClients();
  let res;
  try {
    res = await request('POST', `${base(id)}/sync`, { json: { version: 1, image_model: 'openai' } });
  } finally {
    watch.restore();
  }
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const { queries, overlaps } = watch.seen;
  assert.ok(queries.some((q) => /FROM cocktails/.test(q) && /FROM mocktails/.test(q) && !/request_aliases/.test(q)),
    'the catalog query ran on the held client');
  assert.ok(queries.some((q) => /request_aliases/.test(q)), 'the matcher candidates too');
  assert.deepEqual(overlaps, []);
});
