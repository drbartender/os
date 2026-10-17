process.env.NODE_ENV = 'test';
require('dotenv').config();
// Route tests for menu art Approve (spec 2026-10-01 sections 8, 12 and 14,
// Approve bullets; plan Task A3): POST /api/proposals/:id/menu-draft/approve,
// read back through the real GET /api/proposals/:id/menu-draft, beside the
// real menu-print routes (manual upload, remove, no menu needed) and the real
// re-roll. The menuPrint.test.js harness: a minimal express app, the real
// routers, the real express-fileupload, hand-built multipart, real HTTP.
//
// Nothing paid and nothing remote is ever reached:
// - R2 is an in-memory map installed through require.cache BEFORE anything
//   requires storage, and global fetch is a tripwire;
// - BOTH provider wrappers are stubbed at the SDK-client level, since the
//   re-roll test runs the real job (only an OpenAI background is drawn);
// - the job's queued entry points are wrapped (require.cache) so afterEach
//   waits for every run before the next test and before pool.end();
// - reaccrueDuty is wrapped (require.cache on menuPrintFile, before the routes
//   load) to record WHEN it is called, then runs the real one, which reaches a
//   fake payrollAccrual (require.cache) that reads the proposal row it sees.
// The order proof: pool.connect is wrapped so the transaction's statements,
// its release and the upload are logged in one sequence with the reaccrueDuty
// call. Rows are removed by the ids recorded here, ledger and drafts before
// proposals, drafts before the temp users (approved_by has no ON DELETE).
//
// Run: node --test server/routes/proposals/menuDraftApprove.test.js
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const express = require('express');
const fileUpload = require('express-fileupload');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const events = [];

// ── R2 ──────────────────────────────────────────────────────────────────────
const storagePath = require.resolve('../../utils/storage');
const realStorage = require('../../utils/storage');
const { AppError, NotFoundError } = require('../../utils/errors');
const r2 = new Map();
const uploads = [];
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, key) => { events.push(`upload:${key}`); uploads.push(key); r2.set(key, { buffer, contentType: 'image/jpeg' }); },
  readFile: async (key) => { const f = r2.get(key); if (!f) throw new NotFoundError('File not found.'); return f; },
  getSignedUrl: async () => { throw new Error('menuDraftApprove.test: nothing may presign'); },
};

// ── The job's queued runs ───────────────────────────────────────────────────
const jobPath = require.resolve('../../utils/menuArtJob');
const realJob = require('../../utils/menuArtJob');
const inflight = new Set();
const track = (fn) => (args) => {
  const p = Promise.resolve(fn(args));
  inflight.add(p);
  p.then(() => inflight.delete(p), () => inflight.delete(p));
  return p;
};
require.cache[jobPath].exports = { ...realJob, runGeneration: track(realJob.runGeneration), runPieceReroll: track(realJob.runPieceReroll) };

// ── Duty reaccrual: the call, then the real hook, then a fake accrual ───────
const { pool } = require('../../db');
const accrualPath = require.resolve('../../utils/payrollAccrual');
const savedAccrual = require.cache[accrualPath];
const accrualSeen = [];
const keyRow = (id) => pool.query('SELECT menu_print_key, menu_not_required FROM proposals WHERE id = $1', [id]).then((r) => r.rows[0]);
const fakeAccrual = new Module(accrualPath);
fakeAccrual.filename = accrualPath;
fakeAccrual.loaded = true;
fakeAccrual.exports = {
  maybeReaccrueForDuty: (pid) => { const seen = keyRow(pid); accrualSeen.push({ pid, seen }); return seen.then(() => ({ skipped: true })); },
};
require.cache[accrualPath] = fakeAccrual;

const printFilePath = require.resolve('../../utils/menuPrintFile');
const realPrintFile = require('../../utils/menuPrintFile');
const reaccrued = [];
require.cache[printFilePath].exports = {
  ...realPrintFile,
  reaccrueDuty: (id) => {
    events.push(`reaccrue:${id}`);
    reaccrued.push({ id, seen: keyRow(id) });
    return realPrintFile.reaccrueDuty(id);
  },
};

// derivePrintState can be made to throw once, after COMMIT (the body is built
// from it), to prove a failure there neither rolls back nor skips reaccrual.
const printStatePath = require.resolve('../../utils/menuPrintState');
const realPrintState = require('../../utils/menuPrintState');
let throwPrintState = false;
require.cache[printStatePath].exports = {
  ...realPrintState,
  derivePrintState: (...args) => {
    if (throwPrintState) { throwPrintState = false; throw new Error('injected after COMMIT'); }
    return realPrintState.derivePrintState(...args);
  },
};

// ── pool.connect: log the transaction client's statements and its release ──
let failOn = null;
const realConnect = pool.connect;
pool.connect = function connect(...args) {
  if (args.length) return realConnect.apply(this, args); // pool.query's callback form
  events.push('connect');
  return realConnect.call(this).then((client) => {
    const release = client.release;
    client.query = function query(text, ...rest) {
      const sql = String(typeof text === 'string' ? text : (text && text.text) || '').replace(/\s+/g, ' ').trim();
      events.push(`sql:${sql}`);
      if (failOn && failOn.re.test(sql)) return Promise.reject(Object.assign(new Error('injected'), { code: failOn.code }));
      return Object.getPrototypeOf(client).query.call(client, text, ...rest);
    };
    client.release = function wrappedRelease(...r) {
      events.push('release');
      delete client.query;
      client.release = release;
      return release.apply(client, r);
    };
    return client;
  });
};

const openaiClient = require('../../utils/openaiClient');
const geminiClient = require('../../utils/geminiClient');
const { adminWriteLimiter, menuDraftReadLimiter, menuDraftEditLimiter, beoReadLimiter } = require('../../middleware/rateLimiters');
const approveRouter = require('./menuDraftApprove');
const menuDraftsRouter = require('./menuDrafts');
const menuPrintRouter = require('./menuPrint');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
// The planner image rev, by the scheme itself (16 hex of sha256 over planner:<key>).
const rev = (key) => crypto.createHash('sha256').update(`planner:${key}`, 'utf8').digest('hex').slice(0, 16);
const NAMES = ['A', 'B', 'C', 'D'].map((l) => `Zq Approve ${l} ${NONCE}`);
const KEYS = NAMES.map((n) => `custom:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP', 'MENU_ART_IMAGE_MODEL', 'MENU_ART_STALE_MS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const users = {};
const tokens = {};
const proposalIds = [];
const planIds = [];
const img = {};
const providerCalls = { openai: 0, gemini: 0, words: 0 };
let server;
let baseUrl;
let realFetch;
let tripwire = 0;

// ── HTTP ────────────────────────────────────────────────────────────────────
function multipart(fields, file) {
  const boundary = `----approve${crypto.randomBytes(8).toString('hex')}`;
  const parts = Object.entries(fields || {}).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n'), file.bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function request(method, urlPath, { token = tokens.admin, json, form } = {}) {
  for (const uid of Object.values(users)) {
    for (const [limiter, prefix] of [[adminWriteLimiter, 'admin-'], [menuDraftReadLimiter, 'menudraft-r-'], [menuDraftEditLimiter, 'menudraft-e-']]) {
      await limiter.resetKey(`${prefix}${uid}`);
    }
    await beoReadLimiter.resetKey(`beo-${uid}`);
  }
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
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const base = (id) => `/api/proposals/${id}/menu-draft`;
function approve(ev, { version = ev.version, artVersion = ev.artVersion, expected = '', expectedRev, file = img.menu, token, omit = [] } = {}) {
  const fields = { version: String(version), art_version: String(artVersion), expected_print_key: expected };
  if (expectedRev !== undefined) fields.expected_planner_image_rev = expectedRev;
  for (const k of omit) delete fields[k];
  return request('POST', `${base(ev.id)}/approve`, { token, form: { fields, file: file && { field: 'file', name: 'menu.jpg', bytes: file } } });
}
const printOf = async (id) => (await request('GET', base(id))).body.print;
const briefRev = async (id) => (await request('GET', base(id))).body.brief.planner_image_rev;

async function idle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => { setImmediate(resolve); });
    const pending = [...inflight, ...accrualSeen.map((a) => a.seen), ...reaccrued.map((r) => r.seen)];
    if (inflight.size) { quiet = 0; await Promise.allSettled(pending); } else { await Promise.allSettled(pending); quiet += 1; }
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function drink(i, { hidden = false, hasArt = true } = {}) {
  return {
    key: KEYS[i], source: 'custom', catalog_kind: null, group: 'sig', catalog_id: null, display_name: NAMES[i],
    description: `A bright pour ${i}`, name_ai_suggested: false, description_ai_written: true, visual_note: `a coupe ${i}`,
    hidden, has_art: hasArt, added_by_sync: false,
  };
}

// An event with a plan and a finished draft at version 3, art_version 5.
// pieces maps a piece key to its status ('none' leaves the row out, 'done-nokey'
// is done with no stored key); by default the background and every drink with
// art are done.
async function newEvent({
  drinks = [drink(0), drink(1)], role = 'ignore', logo = null, pieces = {}, words = 'done',
  wordsBeat = new Date().toISOString(), printKey = null, notRequired = false,
} = {}) {
  const p = await pool.query("INSERT INTO proposals (status, event_type) VALUES ('confirmed', 'birthday-party') RETURNING id");
  const id = p.rows[0].id;
  proposalIds.push(id);
  const selections = { menuStyle: 'custom', menuTheme: 'Garden party', customCocktails: NAMES.slice(0, 2), ...(logo ? { _logoFilename: logo } : {}) };
  const plan = await pool.query("INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', $2) RETURNING id", [id, selections]);
  planIds.push(plan.rows[0].id);
  const runId = crypto.randomUUID();
  const inputs = { planner_image_role: role, reference_source: 'none', art_direction: 'Loose watercolor', drb_mark: true, image_model: 'openai' };
  const content = { words_status: words, words_heartbeat_at: wordsBeat, title: 'Garden Bar', drinks, palette: [{ name: 'sage', hex: '#9caf88' }] };
  const d = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint, version, art_version)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 3, 5) RETURNING id`, [id, plan.rows[0].id, runId, inputs, content]);
  const draftId = d.rows[0].id;
  const statuses = { background: 'done' };
  for (const dr of drinks) if (dr.has_art) statuses[dr.key] = 'done';
  Object.assign(statuses, pieces);
  for (const [key, status] of Object.entries(statuses)) {
    if (status === 'none') continue;
    const r2Key = status === 'done' ? `menu-art/${id}/${runId}/${key.replace(':', '-')}-${crypto.randomUUID()}.png` : null;
    const stored = status === 'done-nokey' ? 'done' : status;
    await pool.query(
      `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, r2_key, provider, model, drawn_count)
       VALUES ($1, $2, $3, $4, $5, 'openai', 'approve-test-model', $6)`, [draftId, key, runId, stored, r2Key, stored === 'done' ? 1 : 0]);
  }
  await pool.query('UPDATE proposals SET menu_print_key = $2, menu_not_required = $3 WHERE id = $1', [id, printKey, notRequired]);
  return { id, planId: plan.rows[0].id, draftId, version: 3, artVersion: 5 };
}

const draftOf = async (id) => (await pool.query('SELECT * FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
const activityOf = async (id) => (await pool.query(
  "SELECT actor_type, actor_id, details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'menu_approved' ORDER BY id", [id])).rows;
const setLogo = (planId, logo) => pool.query(
  `UPDATE drink_plans SET selections = CASE WHEN $2::text IS NULL THEN selections - '_logoFilename'
     ELSE selections || jsonb_build_object('_logoFilename', $2::text) END WHERE id = $1`, [planId, logo]);

// Nothing approved, nothing posted, nothing re-accrued.
async function assertUntouched(ev, { printKey = null, notRequired = false } = {}) {
  const draft = await draftOf(ev.id);
  for (const col of ['approved_version', 'approved_art_version', 'approved_print_key', 'approved_planner_image_key', 'approved_at', 'approved_by']) {
    assert.equal(draft[col], null, `${col} stays null`);
  }
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: printKey, menu_not_required: notRequired });
  assert.deepEqual(await activityOf(ev.id), []);
  await idle();
  assert.deepEqual(reaccrued, [], 'no reaccrual');
}

async function headroom() {
  const { rows } = await pool.query(
    `SELECT kind, COUNT(*)::int AS n FROM menu_art_calls
      WHERE status <> 'released' AND created_at > NOW() - interval '24 hours' GROUP BY kind`);
  const n = (kind) => (rows.find((r) => r.kind === kind) || { n: 0 }).n;
  process.env.MENU_ART_DAILY_IMAGE_CAP = String(n('image') + 1000);
  process.env.MENU_ART_DAILY_TEXT_CAP = String(n('text') + 1000);
}

function stubProviders() {
  openaiClient.__setTestStub({
    responses: { create: async () => { providerCalls.words += 1; throw new Error('no words call in the approve suite'); } },
    images: {
      generate: async () => { providerCalls.openai += 1; return { data: [{ b64_json: img.background.toString('base64') }], _request_id: 'req_bg' }; },
      edit: async () => { providerCalls.openai += 1; return { data: [{ b64_json: img.background.toString('base64') }], _request_id: 'req_bg' }; },
    },
  });
  geminiClient.__setTestStub({ interactions: { create: async () => { providerCalls.gemini += 1; throw new Error('no Gemini call in the approve suite'); } } });
}

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  const jpeg = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 60, b: 50 } } }).jpeg({ quality: 80 }).toBuffer();
  img.menu = await jpeg(2400, 3000);
  img.short = await jpeg(2400, 2999);
  img.landscape = await jpeg(3000, 2400);
  img.small = await jpeg(800, 1000);
  img.png = await sharp({ create: { width: 2400, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  img.background = await jpeg(320, 400);
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_IMAGE_MODEL = 'approve-test-gpt-image';
  delete process.env.MENU_ART_STALE_MS;
  await headroom();

  const hash = await bcrypt.hash('x', 4);
  for (const role of ['admin', 'manager', 'staff']) {
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, $2, $3, 'approved', 0) RETURNING id`, [`menuapprove-route-${role}-${NONCE}@example.com`, hash, role]);
    users[role] = r.rows[0].id;
    tokens[role] = jwt.sign({ userId: users[role], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fileUpload({ limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }));
  // The production mount order (routes/proposals/index.js): menuPrint, menuDrafts, then approve.
  app.use('/api/proposals', menuPrintRouter);
  app.use('/api/proposals', menuDraftsRouter);
  app.use('/api/proposals', approveRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
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
  pool.connect = realConnect;
  await pool.end();
  require.cache[storagePath].exports = realStorage;
  require.cache[jobPath].exports = realJob;
  require.cache[printFilePath].exports = realPrintFile;
  require.cache[printStatePath].exports = realPrintState;
  if (savedAccrual) require.cache[accrualPath] = savedAccrual;
  else delete require.cache[accrualPath];
});

beforeEach(() => {
  stubProviders();
  failOn = null;
  throwPrintState = false;
  tripwire = 0;
  for (const list of [events, uploads, reaccrued, accrualSeen]) list.length = 0;
  for (const k of Object.keys(providerCalls)) providerCalls[k] = 0;
});

afterEach(async () => {
  await idle();
  failOn = null;
  assert.equal(tripwire, 0, 'a request reached global fetch');
  assert.equal(providerCalls.gemini + providerCalls.words, 0, 'no words or Gemini call');
});

// ── Auth and ids ────────────────────────────────────────────────────────────

test('auth: no token is 401 and staff is 403, uploading nothing; a manager approves', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev, { token: null })).status, 401);
  assert.equal((await approve(ev, { token: tokens.staff })).status, 403);
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
  const res = await approve(ev, { token: tokens.manager });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await draftOf(ev.id)).approved_by, users.manager);
});

test('ids: not digits is 400; an unknown proposal, one past int4, or one with no draft is 404, before any upload', async () => {
  const fake = { id: 'abc', version: 1, artVersion: 0 };
  assert.equal((await approve(fake)).status, 400);
  assert.equal((await approve({ ...fake, id: '2147483000' })).status, 404);
  assert.equal((await approve({ ...fake, id: '99999999999999999999' })).status, 404);
  const p = await pool.query("INSERT INTO proposals (status, event_type) VALUES ('confirmed', 'birthday-party') RETURNING id");
  proposalIds.push(p.rows[0].id);
  const noDraft = await approve({ ...fake, id: p.rows[0].id });
  assert.equal(noDraft.status, 404);
  assert.match(noDraft.body.error, /no menu draft/);
  assert.deepEqual(uploads, []);
});

// ── The file and the fields ─────────────────────────────────────────────────

test('file: only a JPEG by its magic bytes; PNG, PDF, text and no file are 400s and nothing is uploaded', async () => {
  const ev = await newEvent();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x41)]);
  for (const bytes of [img.png, pdf, Buffer.from('not a menu at all')]) {
    const res = await approve(ev, { file: bytes });
    assert.equal(res.status, 400);
    assert.match(res.body.fieldErrors.file, /JPEG/);
  }
  const none = await approve(ev, { file: null });
  assert.equal(none.status, 400);
  assert.ok(none.body.fieldErrors.file);
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
});

test('file: sharp must read exactly 2400 x 3000; other sizes and an unreadable JPEG are 400s', async () => {
  const ev = await newEvent();
  for (const bytes of [img.short, img.landscape, img.small]) {
    const res = await approve(ev, { file: bytes });
    assert.equal(res.status, 400);
    assert.match(res.body.fieldErrors.file, /2400 x 3000/);
  }
  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x11)]);
  const bad = await approve(ev, { file: garbage });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fieldErrors.file);
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
});

test('fields: version, art_version and expected_print_key are required and bounded', async () => {
  const ev = await newEvent();
  const cases = [
    [{ omit: ['version'] }, 'version'], [{ version: '0' }, 'version'], [{ version: '1.5' }, 'version'],
    [{ version: '99999999999' }, 'version'], [{ omit: ['art_version'] }, 'art_version'], [{ artVersion: '-1' }, 'art_version'],
    [{ omit: ['expected_print_key'] }, 'expected_print_key'], [{ expected: 'x'.repeat(513) }, 'expected_print_key'],
  ];
  for (const [opts, field] of cases) {
    const res = await approve(ev, opts);
    assert.equal(res.status, 400, JSON.stringify(opts));
    assert.ok(res.body.fieldErrors[field], `${field} named for ${JSON.stringify(opts)}`);
  }
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
});

// ── 409s inside the transaction ─────────────────────────────────────────────

test('a stale version and a stale art_version are each 409 MENU_DRAFT_CHANGED, stamping and posting nothing', async () => {
  const ev = await newEvent();
  for (const opts of [{ version: 2 }, { version: 4 }, { artVersion: 4 }, { artVersion: 6 }]) {
    const res = await approve(ev, opts);
    assert.equal(res.status, 409, JSON.stringify(opts));
    assert.equal(res.body.code, 'MENU_DRAFT_CHANGED');
    assert.equal(res.body.error, 'The draft changed. Approve again.');
  }
  assert.ok(events.includes('sql:ROLLBACK'));
  await assertUntouched(ev);
});

test('a piece the layout uses that is not done is 409 MENU_DRAFT_CHANGED', async () => {
  const variants = [
    { pieces: { background: 'pending' } },
    { pieces: { background: 'failed' } },
    { pieces: { background: 'none' } },
    { pieces: { [KEYS[1]]: 'working' } },
    { pieces: { [KEYS[1]]: 'none' } },
    { pieces: { background: 'done-nokey' } },
    { pieces: { [KEYS[0]]: 'done-nokey' } },
  ];
  for (const opts of variants) {
    const ev = await newEvent(opts);
    const res = await approve(ev);
    assert.equal(res.status, 409, JSON.stringify(opts));
    assert.equal(res.body.code, 'MENU_DRAFT_CHANGED');
    await assertUntouched(ev);
  }
});

test('pieces the layout does not use never block: a hidden drink with art, a drink without art, zero illustrated drinks', async () => {
  const mixed = await newEvent({
    drinks: [drink(0), drink(1, { hidden: true }), drink(2, { hasArt: false })],
    pieces: { [KEYS[1]]: 'failed', [KEYS[2]]: 'failed' },
  });
  assert.equal((await approve(mixed)).status, 200);
  // Review Focus 3: a beer-and-wine menu (every drink hidden, or none with art).
  const none = await newEvent({ drinks: [drink(0, { hasArt: false }), drink(1, { hidden: true, hasArt: false })] });
  const res = await approve(none);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.print.state, 'approved');
  const empty = await newEvent({ drinks: [] });
  assert.equal((await approve(empty)).status, 200);
});

test('expected_print_key that no longer matches is 409 MENU_PRINT_CHANGED, stamping nothing', async () => {
  const manual = `menu-print/0/manual-${NONCE}.pdf`;
  const posted = await newEvent({ printKey: manual });
  for (const expected of ['', `${manual}x`]) {
    const res = await approve(posted, { expected });
    assert.equal(res.status, 409, expected);
    assert.equal(res.body.code, 'MENU_PRINT_CHANGED');
    assert.equal(res.body.error, 'The print file changed since you confirmed. Check it and approve again.');
  }
  await assertUntouched(posted, { printKey: manual });
  const empty = await newEvent();
  const res = await approve(empty, { expected: manual });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'MENU_PRINT_CHANGED');
  await assertUntouched(empty);
});

// ── Success, and its order ──────────────────────────────────────────────────

test('success: posts the key inside the transaction, clears menu_not_required, stamps the posted versions, logs the activity, reads approved', async () => {
  const ev = await newEvent({ notRequired: true });
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(uploads.length, 1);
  const key = uploads[0];
  assert.match(key, new RegExp(`^menu-print/${ev.id}/[0-9a-f-]{36}\\.jpg$`));
  assert.ok(r2.get(key).buffer.equals(img.menu), 'the posted bytes were uploaded as is');
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: key, menu_not_required: false });

  const draft = await draftOf(ev.id);
  assert.equal(draft.approved_version, 3);
  assert.equal(draft.approved_art_version, 5);
  assert.equal(draft.approved_print_key, key);
  assert.equal(draft.approved_planner_image_key, null, 'role ignore stamps no planner image key');
  assert.equal(draft.approved_by, users.admin);
  assert.ok(draft.approved_at instanceof Date);
  assert.equal(draft.version, 3, 'approving is not an edit');

  const log = await activityOf(ev.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_type, 'admin');
  assert.equal(log[0].actor_id, users.admin);
  assert.deepEqual(log[0].details, { draft_id: ev.draftId, version: 3, art_version: 5, print_key: key });

  assert.equal(res.body.version, 3);
  assert.equal(res.body.art_version, 5);
  assert.equal(res.body.print.state, 'approved');
  assert.equal(res.body.print.print_key, key);
  assert.equal(res.body.print.approved_file_in_use, true);
  assert.equal(res.body.print.approved_by_name, `menuapprove-route-admin-${NONCE}@example.com`);

  const print = await printOf(ev.id);
  assert.equal(print.state, 'approved');
  assert.equal(print.print_key, key, 'the GET hands back the key a later Approve posts as expected_print_key');
  assert.equal(print.approved_by_name, `menuapprove-route-admin-${NONCE}@example.com`);
  assert.equal(print.approved_file_in_use, true);
});

test('order: upload before any client, the key set inside the transaction, reaccrueDuty once and only after COMMIT and release', async () => {
  const ev = await newEvent();
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const key = uploads[0];
  const at = (pred) => events.findIndex(pred);
  const idx = {
    upload: at((e) => e === `upload:${key}`),
    connect: at((e) => e === 'connect'),
    begin: at((e) => e === 'sql:BEGIN'),
    lockDraft: at((e) => /^sql:SELECT .* FROM menu_drafts .*FOR UPDATE$/.test(e)),
    setKey: at((e) => e.startsWith('sql:UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2')),
    stamp: at((e) => e.startsWith('sql:UPDATE menu_drafts SET approved_version')),
    activity: at((e) => e.startsWith('sql:INSERT INTO proposal_activity_log')),
    commit: at((e) => e === 'sql:COMMIT'),
    release: at((e) => e === 'release'),
    reaccrue: at((e) => e === `reaccrue:${ev.id}`),
  };
  for (const [name, i] of Object.entries(idx)) assert.ok(i >= 0, `${name} happened (${JSON.stringify(events)})`);
  const order = ['upload', 'connect', 'begin', 'lockDraft', 'setKey', 'stamp', 'activity', 'commit', 'release', 'reaccrue'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(idx[order[i - 1]] < idx[order[i]], `${order[i - 1]} before ${order[i]}: ${JSON.stringify(events)}`);
  }
  assert.equal(events.filter((e) => e.startsWith('reaccrue:')).length, 1, 'reaccrueDuty called exactly once');
  assert.equal(events.filter((e) => e === 'connect').length, 1, 'one client for the whole transaction');

  // At the moment reaccrueDuty was called, and when the accrual ran, the
  // committed key was already visible to a second connection.
  await idle();
  assert.equal(reaccrued.length, 1);
  assert.deepEqual(await reaccrued[0].seen, { menu_print_key: key, menu_not_required: false });
  assert.equal(accrualSeen.length, 1, 'the real hook reached maybeReaccrueForDuty once');
  assert.equal(accrualSeen[0].pid, ev.id);
  assert.deepEqual(await accrualSeen[0].seen, { menu_print_key: key, menu_not_required: false });
});

test('a failure after the key is set rolls the key back with everything else; a 40P01 answers 409 MENU_DRAFT_CHANGED', async () => {
  const ev = await newEvent();
  failOn = { re: /^INSERT INTO proposal_activity_log/, code: 'XX000' };
  const res = await approve(ev);
  assert.equal(res.status, 500);
  const setKey = events.findIndex((e) => e.startsWith('sql:UPDATE proposals SET menu_print_key'));
  assert.ok(setKey >= 0 && setKey < events.indexOf('sql:ROLLBACK'), 'the key was written, then rolled back');
  assert.ok(!events.includes('sql:COMMIT'));
  await assertUntouched(ev);

  failOn = { re: /^UPDATE menu_drafts SET approved_version/, code: '40P01' };
  const deadlock = await approve(ev);
  assert.equal(deadlock.status, 409);
  assert.equal(deadlock.body.code, 'MENU_DRAFT_CHANGED');
  await assertUntouched(ev);
});

// ── The derived print state after an approve ────────────────────────────────

test('logo role: stamps the plan\'s planner image key; a replaced or removed logo then reads edited since approval', async () => {
  const logo = `drink-plan-logos/0-${NONCE}-a.png`;
  const ev = await newEvent({ role: 'logo', logo });
  assert.equal((await approve(ev, { expectedRev: rev(logo) })).status, 200);
  assert.equal((await draftOf(ev.id)).approved_planner_image_key, logo);
  assert.equal((await printOf(ev.id)).state, 'approved');
  await setLogo(ev.planId, `drink-plan-logos/0-${NONCE}-b.png`);
  assert.equal((await printOf(ev.id)).state, 'edited_since_approval');
  await setLogo(ev.planId, null);
  assert.equal((await printOf(ev.id)).state, 'edited_since_approval');
  await setLogo(ev.planId, logo);
  assert.equal((await printOf(ev.id)).state, 'approved', 'the approved logo back in place reads approved');

  // Any other role stamps null, and a logo change does not move the state.
  const other = await newEvent({ role: 'reference', logo });
  assert.equal((await approve(other)).status, 200);
  assert.equal((await draftOf(other.id)).approved_planner_image_key, null);
  await setLogo(other.planId, `drink-plan-logos/0-${NONCE}-c.png`);
  assert.equal((await printOf(other.id)).state, 'approved');
});

test('a re-roll after approval reads edited since approval once the new art lands', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev)).status, 200);
  assert.equal((await printOf(ev.id)).state, 'approved');
  const reroll = await request('POST', `${base(ev.id)}/pieces/background/reroll`, { json: { image_model: 'openai' } });
  assert.equal(reroll.status, 202, JSON.stringify(reroll.body));
  await idle();
  assert.equal(providerCalls.openai, 1, 'the stubbed background was drawn');
  const draft = await draftOf(ev.id);
  assert.equal(draft.art_version, 6, 'the landed piece bumped art_version');
  assert.equal(draft.approved_art_version, 5);
  assert.equal((await printOf(ev.id)).state, 'edited_since_approval');
});

test('removal, no menu needed and a manual upload read correctly, and approving over the manual file needs its key', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev)).status, 200);
  const approvedKey = uploads[0];

  reaccrued.length = 0;
  assert.equal((await request('DELETE', `/api/proposals/${ev.id}/menu-print`)).status, 200);
  assert.equal((await printOf(ev.id)).state, 'removed');
  assert.equal(reaccrued.length, 1, 'the manual remove still re-accrues');

  assert.equal((await request('PATCH', `/api/proposals/${ev.id}/menu-print`, { json: { not_required: true } })).status, 200);
  assert.equal((await printOf(ev.id)).state, 'not_required');
  assert.equal((await request('PATCH', `/api/proposals/${ev.id}/menu-print`, { json: { not_required: false } })).status, 200);
  assert.equal((await printOf(ev.id)).state, 'removed');

  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('manual\n')]);
  const manual = await request('POST', `/api/proposals/${ev.id}/menu-print`, { form: { file: { field: 'file', name: 'm.pdf', bytes: pdf } } });
  assert.equal(manual.status, 200);
  const manualKey = (await keyRow(ev.id)).menu_print_key;
  assert.match(manualKey, new RegExp(`^menu-print/${ev.id}/.+\\.pdf$`));
  assert.equal((await printOf(ev.id)).state, 'replaced');

  const stale = await approve(ev, { expected: approvedKey });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'MENU_PRINT_CHANGED');
  const again = await approve(ev, { expected: manualKey });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await printOf(ev.id)).state, 'approved');
  assert.equal((await activityOf(ev.id)).length, 2);
});

// ── The fleet batch (2026-10-16) ────────────────────────────────────────────

test('file: a JPEG whose header claims 2400 x 3000 but whose data is truncated or corrupt is a 400 on file, uploading nothing', async () => {
  const ev = await newEvent();
  const sos = img.menu.indexOf(Buffer.from([0xff, 0xda]));
  const fake = img.menu.subarray(0, Math.min(267, sos + 20));
  const corrupt = Buffer.concat([img.menu.subarray(0, sos + 14), Buffer.alloc(4000, 0x5a), Buffer.from([0xff, 0xd9])]);
  // An end marker appended to a cut file (failOn 'truncated' accepts both).
  const EOI = Buffer.from([0xff, 0xd9]);
  const headerEoi = Buffer.concat([img.menu.subarray(0, sos + 14), EOI]);
  const halfEoi = Buffer.concat([img.menu.subarray(0, Math.floor(img.menu.length / 2)), EOI]);
  for (const bytes of [fake, corrupt, headerEoi, halfEoi]) {
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 2400, 3000], 'the header alone would pass');
    const res = await approve(ev, { file: bytes });
    assert.equal(res.status, 400, `${bytes.length} bytes`);
    assert.match(res.body.fieldErrors.file, /could not be read/);
  }
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
});

test('words not in: 409 MENU_WORDS_PENDING while being written, MENU_WORDS_NOT_WRITTEN when failed or interrupted', async () => {
  const cases = [
    [{ words: 'pending' }, 'MENU_WORDS_PENDING'],
    [{ words: 'failed' }, 'MENU_WORDS_NOT_WRITTEN'],
    [{ words: 'pending', wordsBeat: new Date(Date.now() - 3600 * 1000).toISOString() }, 'MENU_WORDS_NOT_WRITTEN'],
  ];
  for (const [opts, code] of cases) {
    const ev = await newEvent(opts);
    const res = await approve(ev);
    assert.equal(res.status, 409, JSON.stringify(opts));
    assert.equal(res.body.code, code, JSON.stringify(opts));
    await assertUntouched(ev);
  }
});

test('logo race: rendered with L1, a replaced, removed or newly added logo is 409 MENU_DRAFT_CHANGED writing nothing; the current rev approves', async () => {
  const l1 = `drink-plan-logos/0-${NONCE}-l1.png`;
  const l2 = `drink-plan-logos/0-${NONCE}-l2.png`;
  const ev = await newEvent({ role: 'logo', logo: l1 });
  const rendered = await briefRev(ev.id);
  assert.equal(rendered, rev(l1), 'the GET hands out the rev the client renders against');
  await setLogo(ev.planId, l2);
  for (const [label, expectedRev] of [['replaced', rendered], ['removed', rendered], ['added', '']]) {
    if (label === 'removed') await setLogo(ev.planId, null);
    if (label === 'added') await setLogo(ev.planId, l2);
    const res = await approve(ev, { expectedRev });
    assert.equal(res.status, 409, label);
    assert.equal(res.body.code, 'MENU_DRAFT_CHANGED', label);
    await assertUntouched(ev);
  }
  const fresh = await briefRev(ev.id);
  assert.equal(fresh, rev(l2));
  const ok = await approve(ev, { expectedRev: fresh });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await draftOf(ev.id)).approved_planner_image_key, l2);
  assert.equal(ok.body.print.state, 'approved');
  assert.equal((await printOf(ev.id)).state, 'approved');
});

test('expected_planner_image_rev: required for the logo role (a 400 before any upload), 16 hex or empty; ignored for any other role', async () => {
  const logo = `drink-plan-logos/0-${NONCE}-req.png`;
  const ev = await newEvent({ role: 'logo', logo });
  for (const expectedRev of [undefined, 'zz', rev(logo).toUpperCase(), `${rev(logo)}0`]) {
    const res = await approve(ev, { expectedRev });
    assert.equal(res.status, 400, String(expectedRev));
    assert.ok(res.body.fieldErrors.expected_planner_image_rev, String(expectedRev));
  }
  assert.deepEqual(uploads, []);
  await assertUntouched(ev);
  for (const role of ['ignore', 'reference']) {
    const other = await newEvent({ role, logo });
    assert.equal((await approve(other, { expectedRev: 'not-a-rev' })).status, 200, `${role} with a junk rev`);
    const bare = await newEvent({ role, logo });
    assert.equal((await approve(bare)).status, 200, `${role} without the field`);
    assert.equal((await draftOf(bare.id)).approved_planner_image_key, null);
  }
});

test('logo role with no planner image: an empty rev approves and stamps null; a logo added later reads edited since approval', async () => {
  const ev = await newEvent({ role: 'logo' });
  assert.equal(await briefRev(ev.id), null);
  const res = await approve(ev, { expectedRev: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await draftOf(ev.id)).approved_planner_image_key, null);
  assert.equal((await printOf(ev.id)).state, 'approved');
  await setLogo(ev.planId, `drink-plan-logos/0-${NONCE}-late.png`);
  assert.equal((await printOf(ev.id)).state, 'edited_since_approval');
});

test('a failure after COMMIT never rolls back and still fires reaccrual exactly once', async () => {
  const ev = await newEvent();
  throwPrintState = true;
  const res = await approve(ev);
  assert.equal(res.status, 500);
  const commit = events.indexOf('sql:COMMIT');
  assert.ok(commit >= 0, 'committed');
  assert.ok(!events.slice(commit).includes('sql:ROLLBACK'), `no ROLLBACK after COMMIT: ${JSON.stringify(events)}`);
  await idle();
  assert.equal(reaccrued.length, 1, 'the committed approval still re-accrues');
  assert.equal((await keyRow(ev.id)).menu_print_key, uploads[0]);
  assert.equal((await printOf(ev.id)).state, 'approved');
});

test('the transaction reads the drink plan only for the logo role', async () => {
  const logo = `drink-plan-logos/0-${NONCE}-plan.png`;
  const plain = await newEvent({ role: 'ignore', logo });
  assert.equal((await approve(plain)).status, 200);
  assert.deepEqual(events.filter((e) => /FROM drink_plans/.test(e)), [], 'no plan read for role ignore');
  events.length = 0;
  const withLogo = await newEvent({ role: 'logo', logo });
  assert.equal((await approve(withLogo, { expectedRev: rev(logo) })).status, 200);
  const read = events.findIndex((e) => /^sql:SELECT .*FROM drink_plans/.test(e));
  assert.ok(read > events.indexOf('sql:BEGIN') && read < events.indexOf('sql:COMMIT'), 'the logo role reads the plan inside the transaction');
});

test('file: complete canvas-style JPEGs pass the full decode, baseline and progressive at quality 92', async () => {
  const make = (opts) => sharp({ create: { width: 2400, height: 3000, channels: 3, background: { r: 200, g: 180, b: 120 } } })
    .composite([{ input: Buffer.from('<svg width="2400" height="3000"><circle cx="1200" cy="1100" r="700" fill="#1a3a2a"/>'
      + '<text x="300" y="2600" font-size="180" fill="#402010">Garden Bar</text></svg>') }])
    .jpeg(opts).toBuffer();
  for (const opts of [{ quality: 92 }, { quality: 92, progressive: true }]) {
    const ev = await newEvent();
    const res = await approve(ev, { file: await make(opts) });
    assert.equal(res.status, 200, `${JSON.stringify(opts)}: ${JSON.stringify(res.body)}`);
  }
});
