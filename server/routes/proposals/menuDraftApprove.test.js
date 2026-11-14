process.env.NODE_ENV = 'test';
require('dotenv').config();
// Route tests for menu art Approve and send (spec 2026-10-01 sections 8, 12
// and 14; spec 2026-10-19 sections 10.2, 10.4 and 11, lane menu-approve-send):
// POST /api/proposals/:id/menu-draft/approve, read back through the real GET
// /api/proposals/:id/menu-draft, beside the real menu-print routes (manual
// upload, remove, no menu needed), the real Release route and the real
// re-roll. The menuPrint.test.js harness: a minimal express app, the real
// routers, the real express-fileupload, hand-built multipart, real HTTP.
//
// Nothing paid and nothing remote is ever reached:
// - R2 is an in-memory map installed through require.cache BEFORE anything
//   requires storage, and global fetch is a tripwire;
// - sendEmail is a stub (require.cache on utils/email, before the routes
//   load) whose outcome each test sets: sent, skipped (dev-skipped) or a
//   throw, and which records every call;
// - BOTH provider wrappers are stubbed at the SDK-client level, since the
//   re-roll test runs the real job (only an OpenAI background is drawn);
// - the job's queued entry points are wrapped (require.cache) so afterEach
//   waits for every run before the next test and before pool.end();
// - reaccrueDuty is wrapped (require.cache on menuPrintFile, before the routes
//   load) to record WHEN it is called, then runs the real one, which reaches a
//   fake payrollAccrual (require.cache) that reads the proposal row it sees.
// The order proof: pool.connect is wrapped so the transaction's statements,
// its release, the uploads, the email and the Inbox cache are logged in one
// sequence. Rows are removed by the ids recorded here, ledger and drafts
// (their proofs cascade) before proposals, then the clients and temp users.
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

// ── The email: a stub whose outcome each test sets ──────────────────────────
const emailPath = require.resolve('../../utils/email');
const realEmail = require('../../utils/email');
const sent = [];
let emailOutcome = 'sent';
require.cache[emailPath].exports = {
  ...realEmail,
  sendEmail: async (opts) => {
    events.push('email');
    sent.push(opts);
    if (emailOutcome === 'throw') throw new Error('Resend refused it for proof-route@example.com');
    return { id: emailOutcome === 'skipped' ? 'dev-skipped' : `re_test_${sent.length}` };
  },
};

// ── Sentry: recorded, never sent ────────────────────────────────────────────
const sentryModule = require('@sentry/node');
const savedCapture = sentryModule.captureException;
const captured = [];
sentryModule.captureException = (err, ctx) => { captured.push({ message: err && err.message, ctx }); };

// ── The Inbox cache: each clear is logged ───────────────────────────────────
const inboxCache = require('../../utils/inbox/cache');
const realInvalidate = inboxCache.invalidate;
inboxCache.invalidate = () => { events.push('invalidate'); realInvalidate(); };

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

// readReviewBlocks can be made to throw once, after COMMIT (the body is built
// from it), to prove a failure there never rolls back the approval.
const readPath = require.resolve('../../utils/menuDraftRead');
const realRead = require('../../utils/menuDraftRead');
let throwBlocks = false;
require.cache[readPath].exports = {
  ...realRead,
  readReviewBlocks: (...args) => {
    if (throwBlocks) { throwBlocks = false; return Promise.reject(new Error('injected after COMMIT')); }
    return realRead.readReviewBlocks(...args);
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
// pool.query: the email status write can be made to fail once.
let failPoolOn = null;
const realPoolQuery = pool.query;
pool.query = function query(text, ...rest) {
  const sql = String(typeof text === 'string' ? text : (text && text.text) || '').replace(/\s+/g, ' ').trim();
  if (failPoolOn && failPoolOn.test(sql)) { failPoolOn = null; return Promise.reject(new Error('injected pool failure')); }
  return realPoolQuery.call(this, text, ...rest);
};

const openaiClient = require('../../utils/openaiClient');
const geminiClient = require('../../utils/geminiClient');
const { adminWriteLimiter, menuDraftReadLimiter, menuDraftEditLimiter, beoReadLimiter } = require('../../middleware/rateLimiters');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { menuProofUrl } = require('../../utils/urls');
const { buildEmailLogEntry, logClientMessage } = require('../../utils/messageLog');
const approveRouter = require('./menuDraftApprove');
const releaseRouter = require('./menuDraftRelease');
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
const clientIds = [];
const img = {};
const providerCalls = { openai: 0, gemini: 0, words: 0 };
let server;
let baseUrl;
let realFetch;
let tripwire = 0;
let clientSeq = 0;
let todayYmd;

// ── HTTP ────────────────────────────────────────────────────────────────────
function multipart(fields, files) {
  const boundary = `----approve${crypto.randomBytes(8).toString('hex')}`;
  const parts = Object.entries(fields || {}).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const file of files || []) {
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
      const { body, boundary } = multipart(form.fields, form.files);
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
// What a page loaded now shows of the draft's latest proof: { id, answer }, '' each for none.
async function seenNow(ev) {
  if (!ev.draftId) return { id: '', answer: '' };
  const { rows: [p] } = await pool.query(
    'SELECT id, answer FROM menu_proofs WHERE draft_id = $1 AND superseded_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1', [ev.draftId]);
  return { id: p ? p.id : '', answer: p && p.answer ? p.answer : '' };
}
// seen: what the page showed of the latest proof (default: what a page loaded now shows).
async function approve(ev, {
  version = ev.version, artVersion = ev.artVersion, expected = '', expectedRev, file = img.menu, proof = img.proof, token, omit = [], seen,
} = {}) {
  const shown = seen || await seenNow(ev);
  const fields = {
    version: String(version), art_version: String(artVersion), expected_print_key: expected,
    seen_proof_id: String(shown.id), seen_proof_answer: shown.answer,
  };
  if (expectedRev !== undefined) fields.expected_planner_image_rev = expectedRev;
  for (const k of omit) delete fields[k];
  const files = [];
  if (file) files.push({ field: 'file', name: 'menu.jpg', bytes: file });
  if (proof) files.push({ field: 'proof', name: 'proof.jpg', bytes: proof });
  return request('POST', `${base(ev.id)}/approve`, { token, form: { fields, files } });
}
const release = async (ev, body = { version: ev.version, art_version: ev.artVersion }) => {
  const shown = await seenNow(ev);
  return request('POST', `${base(ev.id)}/release`, { json: { seen_proof_id: shown.id, seen_proof_answer: shown.answer, ...body } });
};
const getDraft = async (id) => (await request('GET', base(id))).body;
const printOf = async (id) => (await getDraft(id)).print;
const briefRev = async (id) => (await getDraft(id)).brief.planner_image_rev;

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

// A client on a reserved domain unless email is null or a placeholder.
async function newClient({ email = 'auto', emailStatus = null } = {}) {
  clientSeq += 1;
  const address = email === 'auto' ? `menuapprove-client-${NONCE}-${clientSeq}@example.com` : email;
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Robin Zqapprove${clientSeq}`, address]);
  clientIds.push(c.rows[0].id);
  if (emailStatus) await pool.query('UPDATE clients SET email_status = $2 WHERE id = $1', [c.rows[0].id, emailStatus]);
  return { id: c.rows[0].id, email: address };
}

// An event with a client, a plan and a finished draft at version 3,
// art_version 5, twenty days out. pieces maps a piece key to its status
// ('none' leaves the row out, 'done-nokey' is done with no stored key); by
// default the background and every drink with art are done.
async function newEvent({
  drinks = [drink(0), drink(1)], role = 'ignore', logo = null, pieces = {}, words = 'done',
  wordsBeat = new Date().toISOString(), printKey = null, notRequired = false,
  email = 'auto', emailStatus = null, noClient = false, offset = 20, noDate = false, status = 'confirmed',
} = {}) {
  const client = noClient ? null : await newClient({ email, emailStatus });
  const p = await pool.query(
    `INSERT INTO proposals (status, event_type, client_id, event_date)
     VALUES ($1, 'birthday-party', $2, CASE WHEN $3::boolean THEN NULL ELSE $4::date + $5::int END) RETURNING id`,
    [status, client && client.id, noDate, todayYmd, offset]);
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
  for (const [key, st] of Object.entries(statuses)) {
    if (st === 'none') continue;
    const r2Key = st === 'done' ? `menu-art/${id}/${runId}/${key.replace(':', '-')}-${crypto.randomUUID()}.png` : null;
    const stored = st === 'done-nokey' ? 'done' : st;
    await pool.query(
      `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, r2_key, provider, model, drawn_count)
       VALUES ($1, $2, $3, $4, $5, 'openai', 'approve-test-model', $6)`, [draftId, key, runId, stored, r2Key, stored === 'done' ? 1 : 0]);
  }
  await pool.query('UPDATE proposals SET menu_print_key = $2, menu_not_required = $3 WHERE id = $1', [id, printKey, notRequired]);
  return { id, planId: plan.rows[0].id, draftId, version: 3, artVersion: 5, client };
}

const draftOf = async (id) => (await pool.query('SELECT * FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
const proofsOf = async (id) => (await pool.query('SELECT * FROM menu_proofs WHERE proposal_id = $1 ORDER BY id', [id])).rows;
const activityOf = async (id, actions = ['menu_approved', 'menu_proof_sent']) => (await pool.query(
  'SELECT action, actor_type, actor_id, details FROM proposal_activity_log WHERE proposal_id = $1 AND action = ANY($2::text[]) ORDER BY id',
  [id, actions])).rows;
const setLogo = (planId, logo) => pool.query(
  `UPDATE drink_plans SET selections = CASE WHEN $2::text IS NULL THEN selections - '_logoFilename'
     ELSE selections || jsonb_build_object('_logoFilename', $2::text) END WHERE id = $1`, [planId, logo]);

// Nothing approved, nothing posted, no proof, no email, nothing re-accrued.
async function assertUntouched(ev, { printKey = null, notRequired = false } = {}) {
  const draft = await draftOf(ev.id);
  for (const col of ['approved_version', 'approved_art_version', 'approved_print_key', 'approved_planner_image_key', 'approved_at', 'approved_by']) {
    assert.equal(draft[col], null, `${col} stays null`);
  }
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: printKey, menu_not_required: notRequired });
  assert.deepEqual(await activityOf(ev.id), []);
  assert.deepEqual(await proofsOf(ev.id), [], 'no proof');
  assert.deepEqual(sent, [], 'no email');
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
  todayYmd = chicagoTodayYmd();
  const jpeg = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 60, b: 50 } } }).jpeg({ quality: 80 }).toBuffer();
  img.menu = await jpeg(2400, 3000);
  img.proof = await jpeg(1200, 1556);
  img.short = await jpeg(2400, 2999);
  img.landscape = await jpeg(3000, 2400);
  img.small = await jpeg(800, 1000);
  img.proofShort = await jpeg(1200, 1500);
  img.png = await sharp({ create: { width: 2400, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  img.proofPng = await sharp({ create: { width: 1200, height: 1556, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
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
  // The production mount order (routes/proposals/index.js): menuPrint, menuDrafts, approve, release.
  app.use('/api/proposals', menuPrintRouter);
  app.use('/api/proposals', menuDraftsRouter);
  app.use('/api/proposals', approveRouter);
  app.use('/api/proposals', releaseRouter);
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
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  const userIds = Object.values(users);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await new Promise((resolve) => { server.close(resolve); });
  pool.connect = realConnect;
  pool.query = realPoolQuery;
  await pool.end();
  sentryModule.captureException = savedCapture;
  inboxCache.invalidate = realInvalidate;
  require.cache[storagePath].exports = realStorage;
  require.cache[emailPath].exports = realEmail;
  require.cache[jobPath].exports = realJob;
  require.cache[printFilePath].exports = realPrintFile;
  require.cache[readPath].exports = realRead;
  if (savedAccrual) require.cache[accrualPath] = savedAccrual;
  else delete require.cache[accrualPath];
});

beforeEach(() => {
  stubProviders();
  failOn = null;
  failPoolOn = null;
  throwBlocks = false;
  emailOutcome = 'sent';
  tripwire = 0;
  for (const list of [events, uploads, reaccrued, accrualSeen, sent, captured]) list.length = 0;
  for (const k of Object.keys(providerCalls)) providerCalls[k] = 0;
});

afterEach(async () => {
  await idle();
  failOn = null;
  failPoolOn = null;
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
  assert.equal((await proofsOf(ev.id))[0].sent_by, users.manager);
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

// ── The two files and the fields ────────────────────────────────────────────

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
  for (const bytes of [img.short, img.landscape, img.small, img.proof]) {
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

test('proof: missing, not a JPEG, the wrong size, over 3 MB, or unreadable is a 400 on proof, and nothing is uploaded or written', async () => {
  const ev = await newEvent();
  const sos = img.proof.indexOf(Buffer.from([0xff, 0xda]));
  const cut = Buffer.concat([img.proof.subarray(0, sos + 14), Buffer.from([0xff, 0xd9])]);
  const big = Buffer.concat([img.proof, Buffer.alloc(3 * 1024 * 1024, 0x11)]);
  const cases = [
    [null, /Attach the proof/], [img.proofPng, /JPEG/], [Buffer.from('not a proof'), /JPEG/],
    [img.proofShort, /1200 x 1556/], [img.menu, /1200 x 1556/], [big, /3 MB/], [cut, /could not be read/],
  ];
  for (const [proof, re] of cases) {
    const res = await approve(ev, { proof });
    assert.equal(res.status, 400, String(re));
    assert.match(res.body.fieldErrors.proof, re);
  }
  assert.deepEqual(uploads, [], 'neither file reached R2');
  await assertUntouched(ev);
});

test('fields: version, art_version and expected_print_key are required and bounded', async () => {
  const ev = await newEvent();
  const cases = [
    [{ omit: ['version'] }, 'version'], [{ version: '0' }, 'version'], [{ version: '1.5' }, 'version'],
    [{ version: '99999999999' }, 'version'], [{ omit: ['art_version'] }, 'art_version'], [{ artVersion: '-1' }, 'art_version'],
    [{ omit: ['expected_print_key'] }, 'expected_print_key'], [{ expected: 'x'.repeat(513) }, 'expected_print_key'],
    // What the page saw of the latest proof: digits or empty, an answer or empty, both required.
    [{ omit: ['seen_proof_id'] }, 'seen_proof_id'], [{ omit: ['seen_proof_answer'] }, 'seen_proof_answer'],
    [{ seen: { id: '12x', answer: '' } }, 'seen_proof_id'], [{ seen: { id: '0', answer: '' } }, 'seen_proof_id'],
    [{ seen: { id: '-3', answer: '' } }, 'seen_proof_id'], [{ seen: { id: '', answer: 'maybe' } }, 'seen_proof_answer'],
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
  assert.equal(res.body.print.state, 'held');
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

// ── The hold, the proof and the email ───────────────────────────────────────

// The hold test (acceptance): on main Approve set menu_print_key; now it holds the file.
test('the hold: Approve stamps the held file and never touches menu_print_key or the duty line', async () => {
  const ev = await newEvent();
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(uploads.length, 2);
  const [key, proofKey] = uploads;
  assert.match(key, new RegExp(`^menu-print/${ev.id}/[0-9a-f-]{36}\\.jpg$`));
  assert.match(proofKey, new RegExp(`^menu-proof/${ev.id}/[0-9a-f-]{36}\\.jpg$`));
  assert.ok(r2.get(key).buffer.equals(img.menu), 'the print bytes were uploaded as is');
  assert.ok(r2.get(proofKey).buffer.equals(img.proof), 'the proof bytes were uploaded as is');
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: null, menu_not_required: false }, 'staff see no file');
  assert.ok(!events.some((e) => /^sql:UPDATE proposals SET menu_print_key/.test(e)), 'setMenuPrintKey never ran');
  await idle();
  assert.deepEqual(reaccrued, [], 'no duty re-accrual');
  assert.deepEqual(accrualSeen, []);

  const draft = await draftOf(ev.id);
  assert.deepEqual([draft.approved_version, draft.approved_art_version, draft.approved_print_key], [3, 5, key]);
  assert.equal(draft.approved_planner_image_key, null, 'role ignore stamps no planner image key');
  assert.equal(draft.approved_by, users.admin);
  assert.ok(draft.approved_at instanceof Date);
  assert.deepEqual([draft.released_print_key, draft.released_at, draft.released_by, draft.released_via], [null, null, null, null]);
  assert.equal(draft.version, 3, 'approving is not an edit');

  const print = await printOf(ev.id);
  assert.deepEqual([print.state, print.held, print.live, print.print_key], ['held', true, 'none', null]);
  assert.deepEqual([print.approved_version, print.approved_art_version], [3, 5]);
});

test('success: one proof, pending then sent, the two activity rows, and the response carries the GET\'s proof and print blocks', async () => {
  const ev = await newEvent();
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [proof] = await proofsOf(ev.id);
  assert.deepEqual([proof.draft_id, proof.version, proof.art_version, proof.r2_key, proof.sent_by], [ev.draftId, 3, 5, uploads[1], users.admin]);
  assert.deepEqual([proof.email_status, proof.sent_to, proof.answer, proof.superseded_at, proof.withdrawn_at], ['sent', ev.client.email, null, null, null]);
  const log = await activityOf(ev.id);
  assert.deepEqual(log, [
    { action: 'menu_approved', actor_type: 'admin', actor_id: users.admin, details: { draft_id: ev.draftId, version: 3, art_version: 5, print_key: uploads[0] } },
    { action: 'menu_proof_sent', actor_type: 'admin', actor_id: users.admin, details: { proof_id: proof.id, draft_id: ev.draftId, version: 3, art_version: 5 } },
  ]);
  assert.ok(!JSON.stringify(log).includes('email'), 'the email outcome lives on the proof row only');

  assert.deepEqual([res.body.version, res.body.art_version], [3, 5]);
  const get = await getDraft(ev.id);
  assert.deepEqual(res.body.proof, get.proof);
  assert.deepEqual(res.body.print, get.print);
  assert.equal(res.body.proof.url, menuProofUrl(proof.token));
  assert.deepEqual([res.body.proof.state, res.body.proof.email_status, res.body.proof.stale], ['open', 'sent', false]);
  assert.equal(res.body.print.state, 'held');
});

test('the email: one send to the live address after the release, first name only, the link, messageType menu_proof and no sentBy', async () => {
  const ev = await newEvent();
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(sent.length, 1);
  const [mail] = sent;
  const [proof] = await proofsOf(ev.id);
  assert.equal(mail.to, ev.client.email);
  assert.equal(mail.subject, 'Your bar menu is ready for a look');
  assert.deepEqual(mail.meta, { messageType: 'menu_proof', clientId: ev.client.id, proposalId: ev.id },
    'no sentBy, so the Inbox never reads it as a reply');
  assert.ok(!('sentBy' in mail.meta));
  for (const body of [mail.html, mail.text]) {
    assert.match(body, /Hi Robin,/);
    assert.ok(!/Zqapprove/.test(body), 'no surname');
    assert.ok(body.includes(menuProofUrl(proof.token)));
    assert.match(body, /bar menu for your Birthday Party\./);
    assert.match(body, /The link works until your event\./);
    assert.ok(!/\d{4}-\d{2}-\d{2}|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(body), 'no event date');
  }
  const at = (pred) => events.findIndex(pred);
  assert.ok(at((e) => e === 'release') < at((e) => e === 'email'), 'the email runs after the transaction client is released');
  assert.ok(at((e) => e === 'email') < at((e) => e === 'invalidate'), 'then the Inbox cache is cleared');
  assert.ok(at((e) => e === 'sql:COMMIT') < at((e) => e === 'email'));
});

// The message log files a send with no proposalId under the client's newest proposal.
test("the email's log entry is filed under the proof's own event when the client has a newer one", async () => {
  const ev = await newEvent();
  const { rows: [newer] } = await pool.query(
    `INSERT INTO proposals (status, event_type, client_id, created_at)
     VALUES ('confirmed', 'birthday-party', $1, NOW() + INTERVAL '1 minute') RETURNING id`, [ev.client.id]);
  proposalIds.push(newer.id);
  assert.equal((await approve(ev)).status, 200);
  const [mail] = sent;
  // The ledger write the real sendEmail makes once a send lands (messageLog.js), from the meta the route passed.
  await logClientMessage(buildEmailLogEntry({ to: mail.to, subject: mail.subject, meta: mail.meta, result: { id: 're_test_log' } }));
  const { rows } = await pool.query('SELECT proposal_id, message_type, sent_by FROM message_log WHERE client_id = $1', [ev.client.id]);
  assert.deepEqual(rows, [{ proposal_id: ev.id, message_type: 'menu_proof', sent_by: null }], 'never the newer proposal');
});

test('the email outcomes: skipped for a send the gate turned off, failed on a throw (a fixed Sentry line), sent_to only when sent', async () => {
  emailOutcome = 'skipped';
  const skip = await newEvent();
  assert.equal((await approve(skip)).status, 200);
  assert.deepEqual((await proofsOf(skip.id)).map((p) => [p.email_status, p.sent_to]), [['skipped', null]]);

  emailOutcome = 'throw';
  const fail = await newEvent();
  const res = await approve(fail);
  assert.equal(res.status, 200, 'a failed send never fails the request');
  assert.deepEqual((await proofsOf(fail.id)).map((p) => [p.email_status, p.sent_to]), [['failed', null]]);
  assert.equal(res.body.proof.email_status, 'failed');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message, 'menu proof email failed');
  assert.ok(!JSON.stringify(captured).includes('@example.com'), 'no address or provider text reaches Sentry');
});

test('no address: no email on file, an .invalid placeholder, or no client at all writes no_address and sends nothing', async () => {
  for (const opts of [{ email: null }, { email: `someone-${NONCE}@placeholder.invalid` }, { noClient: true }]) {
    sent.length = 0;
    const ev = await newEvent(opts);
    const res = await approve(ev);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [proof] = await proofsOf(ev.id);
    assert.deepEqual([proof.email_status, proof.sent_to], ['no_address', null], JSON.stringify(opts));
    assert.deepEqual(sent, [], 'nothing sent');
    assert.equal(res.body.proof.email_status, 'no_address');
    assert.equal(res.body.proof.url, menuProofUrl(proof.token), 'the link still exists to copy');
  }
});

test('the immediate-send gate: an address marked bad writes suppressed and sends nothing', async () => {
  const ev = await newEvent({ emailStatus: 'bad' });
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((await proofsOf(ev.id)).map((p) => p.email_status), ['suppressed']);
  assert.deepEqual(sent, []);
});

test('a proof whose status write failed stays pending, and reads as failed in the GET once 10 minutes have passed', async () => {
  const ev = await newEvent();
  failPoolOn = /^UPDATE menu_proofs SET email_status/;
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(sent.length, 1, 'the email went out');
  assert.equal((await proofsOf(ev.id))[0].email_status, 'pending');
  assert.equal((await getDraft(ev.id)).proof.email_status, 'pending');
  assert.ok(captured.some((c) => c.message === 'menu proof email status not written'));
  await pool.query("UPDATE menu_proofs SET sent_at = NOW() - INTERVAL '11 minutes' WHERE proposal_id = $1", [ev.id]);
  assert.equal((await getDraft(ev.id)).proof.email_status, 'failed');
});

test('approving again supersedes the previous proof; the same pair within 10 minutes is MENU_PROOF_ALREADY_SENT and sends nothing; after 10 minutes it sends', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev)).status, 200);
  sent.length = 0;
  const again = await approve(ev);
  assert.deepEqual([again.status, again.body.code], [409, 'MENU_PROOF_ALREADY_SENT'], JSON.stringify(again.body));
  assert.deepEqual(sent, [], 'one email');
  assert.equal((await proofsOf(ev.id)).length, 1, 'one proof');
  assert.equal((await activityOf(ev.id)).length, 2, 'no second pair of activity rows');

  await pool.query("UPDATE menu_proofs SET sent_at = NOW() - INTERVAL '11 minutes' WHERE proposal_id = $1", [ev.id]);
  const later = await approve(ev);
  assert.equal(later.status, 200, JSON.stringify(later.body));
  const proofs = await proofsOf(ev.id);
  assert.equal(proofs.length, 2);
  assert.ok(proofs[0].superseded_at instanceof Date, 'the old link is superseded');
  assert.equal(proofs[1].superseded_at, null);
  assert.equal(sent.length, 1, 'a fresh link went out');
  assert.equal(later.body.proof.id, proofs[1].id);
  assert.deepEqual(later.body.proof.history.map((h) => [h.id, h.state]), [[proofs[0].id, 'superseded']]);

  // A new pair is never a repeat, and supersedes the open one at once.
  await pool.query('UPDATE menu_drafts SET version = 4 WHERE id = $1', [ev.draftId]);
  const fresh = await approve({ ...ev, version: 4 });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal((await proofsOf(ev.id)).filter((p) => p.superseded_at === null).length, 1, 'one live proof');
});

// The page does not poll: one loaded before the client answered must not supersede that answer unseen.
test('409 MENU_PROOF_CHANGED when the latest proof is not what the page saw, superseding nothing; a retried post is still MENU_PROOF_ALREADY_SENT', async () => {
  const ev = await newEvent();
  // A post retried by a page that never refetched (it still saw no proof) reads as the first one landing.
  assert.equal((await approve(ev, { seen: { id: '', answer: '' } })).status, 200);
  const retried = await approve(ev, { seen: { id: '', answer: '' } });
  assert.deepEqual([retried.status, retried.body.code], [409, 'MENU_PROOF_ALREADY_SENT']);
  const [first] = await proofsOf(ev.id);
  await pool.query("UPDATE menu_proofs SET sent_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [first.id]);
  await pool.query("UPDATE menu_proofs SET answer = 'changes', answer_note = 'More gin', answered_at = NOW() WHERE id = $1", [first.id]);
  sent.length = 0;
  for (const seen of [{ id: String(first.id), answer: '' }, { id: '', answer: '' }, { id: String(first.id + 1000), answer: 'changes' }]) {
    const res = await approve(ev, { seen });
    assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
      JSON.stringify(seen));
  }
  const proofs = await proofsOf(ev.id);
  assert.equal(proofs.length, 1, 'no new proof');
  assert.deepEqual([proofs[0].superseded_at, proofs[0].answer], [null, 'changes'], 'the change request is not superseded');
  assert.deepEqual(sent, [], 'no email');
  // The page that saw the change request sends knowingly.
  const ok = await approve(ev, { seen: { id: String(first.id), answer: 'changes' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok((await proofsOf(ev.id))[0].superseded_at instanceof Date);
});

test('a withdrawn proof of the same pair is no repeat: approving again sends', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev)).status, 200);
  await pool.query('UPDATE menu_proofs SET withdrawn_at = NOW() WHERE proposal_id = $1', [ev.id]);
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await proofsOf(ev.id)).length, 2);
});

test('the send cap: a sixth approval in 24 hours is 429 MENU_PROOF_SEND_CAP and writes nothing', async () => {
  const ev = await newEvent();
  for (let i = 0; i < 5; i += 1) {
    await pool.query(
      `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, sent_at, superseded_at)
       VALUES ($1, $2, 1, $3, $4, 'sent', NOW() - INTERVAL '20 hours', NOW())`, [ev.draftId, ev.id, i, `menu-proof/${ev.id}/cap-${i}.jpg`]);
  }
  const res = await approve(ev);
  assert.deepEqual([res.status, res.body.code, res.body.error], [429, 'MENU_PROOF_SEND_CAP', "You've sent this menu 5 times today. Try again tomorrow."]);
  assert.equal((await proofsOf(ev.id)).length, 5);
  assert.deepEqual(sent, []);
  assert.equal((await draftOf(ev.id)).approved_print_key, null);
  // Older than 24 hours no longer counts.
  await pool.query("UPDATE menu_proofs SET sent_at = NOW() - INTERVAL '25 hours' WHERE proposal_id = $1 AND version = 1 AND art_version = 0", [ev.id]);
  assert.equal((await approve(ev)).status, 200);
});

test('a past event is 409 MENU_EVENT_PASSED before any upload; the event day itself and no date approve', async () => {
  const past = await newEvent({ offset: -1 });
  const res = await approve(past);
  assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MENU_EVENT_PASSED', "This event has passed, so there's nothing to send."]);
  assert.deepEqual(uploads, []);
  await assertUntouched(past);
  for (const opts of [{ offset: 0 }, { noDate: true }]) {
    const ev = await newEvent(opts);
    assert.equal((await approve(ev)).status, 200, JSON.stringify(opts));
  }
  const undated = (await proofsOf(proposalIds[proposalIds.length - 1]))[0];
  assert.equal(undated.email_status, 'sent');
  assert.match(sent[sent.length - 1].text, /The link works for 30 days\./, 'no event date: the 30-day line');
});

test('an archived proposal is 409 MENU_PROOF_ARCHIVED and writes nothing', async () => {
  const ev = await newEvent({ status: 'archived' });
  const res = await approve(ev);
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_PROOF_ARCHIVED']);
  await assertUntouched(ev);
});

test('the no-menu mark: Approve is 409 MENU_MARKED_NONE and the mark stays (Claude\'s call)', async () => {
  const ev = await newEvent({ notRequired: true });
  const res = await approve(ev);
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_MARKED_NONE']);
  await assertUntouched(ev, { notRequired: true });
});

test('the v1 stamp: a menu approved under v1 (its file live, no release recorded) is stamped released first, then the new file is held beside it', async () => {
  const v1Key = `menu-print/0/v1-${NONCE}.jpg`;
  const ev = await newEvent({ printKey: v1Key });
  await pool.query(
    `UPDATE menu_drafts SET approved_version = 2, approved_art_version = 4, approved_print_key = $2,
            approved_at = NOW() - INTERVAL '3 days', approved_by = $3 WHERE id = $1`, [ev.draftId, v1Key, users.manager]);
  const before = await draftOf(ev.id);
  const res = await approve(ev, { expected: v1Key });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = await draftOf(ev.id);
  assert.equal(d.released_print_key, v1Key, 'the v1 file is the menu\'s own release');
  assert.equal(d.released_at.toISOString(), before.approved_at.toISOString(), 'released at its approval');
  assert.deepEqual([d.released_by, d.released_via], [users.manager, 'admin']);
  assert.equal(d.approved_print_key, uploads[0], 'the new approval holds its own file');
  assert.equal((await keyRow(ev.id)).menu_print_key, v1Key, 'staff keep the v1 file');
  const stampAt = events.findIndex((e) => e.startsWith('sql:UPDATE menu_drafts d SET released_print_key = d.approved_print_key'));
  const approveAt = events.findIndex((e) => e.startsWith('sql:UPDATE menu_drafts SET approved_version'));
  assert.ok(stampAt >= 0 && stampAt < approveAt, 'the v1 stamp runs before the new approval');
  assert.deepEqual([res.body.print.state, res.body.print.live], ['held', 'previous']);
});

test('order: both uploads before any client, the transaction, COMMIT, release, then the email and the Inbox cache; no key write and no reaccrual', async () => {
  const ev = await newEvent();
  const res = await approve(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [key, proofKey] = uploads;
  const at = (pred) => events.findIndex(pred);
  const idx = {
    upload: at((e) => e === `upload:${key}`),
    uploadProof: at((e) => e === `upload:${proofKey}`),
    connect: at((e) => e === 'connect'),
    begin: at((e) => e === 'sql:BEGIN'),
    lockDraft: at((e) => /^sql:SELECT .* FROM menu_drafts .*FOR UPDATE$/.test(e)),
    lockProposal: at((e) => /^sql:SELECT .* FROM proposals .*FOR UPDATE$/.test(e)),
    stamp: at((e) => e.startsWith('sql:UPDATE menu_drafts SET approved_version')),
    supersede: at((e) => e.startsWith('sql:UPDATE menu_proofs SET superseded_at')),
    insert: at((e) => e.startsWith('sql:INSERT INTO menu_proofs')),
    activity: at((e) => e.startsWith('sql:INSERT INTO proposal_activity_log')),
    commit: at((e) => e === 'sql:COMMIT'),
    release: at((e) => e === 'release'),
    email: at((e) => e === 'email'),
    invalidate: at((e) => e === 'invalidate'),
  };
  for (const [name, i] of Object.entries(idx)) assert.ok(i >= 0, `${name} happened (${JSON.stringify(events)})`);
  const order = ['upload', 'uploadProof', 'connect', 'begin', 'lockDraft', 'lockProposal', 'stamp', 'supersede', 'insert', 'activity', 'commit', 'release', 'email', 'invalidate'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(idx[order[i - 1]] < idx[order[i]], `${order[i - 1]} before ${order[i]}: ${JSON.stringify(events)}`);
  }
  assert.equal(events.filter((e) => e === 'connect').length, 1, 'one client for the whole transaction');
  assert.ok(!events.some((e) => e.startsWith('reaccrue:')), 'no reaccrual');
});

test('a failure inside the transaction rolls everything back; a 40P01 answers 409 MENU_DRAFT_CHANGED', async () => {
  const ev = await newEvent();
  failOn = { re: /^INSERT INTO proposal_activity_log/, code: 'XX000' };
  const res = await approve(ev);
  assert.equal(res.status, 500);
  assert.ok(events.indexOf('sql:ROLLBACK') > events.findIndex((e) => e.startsWith('sql:INSERT INTO menu_proofs')), 'the proof was written, then rolled back');
  assert.ok(!events.includes('sql:COMMIT'));
  await assertUntouched(ev);

  failOn = { re: /^UPDATE menu_drafts SET approved_version/, code: '40P01' };
  const deadlock = await approve(ev);
  assert.equal(deadlock.status, 409);
  assert.equal(deadlock.body.code, 'MENU_DRAFT_CHANGED');
  await assertUntouched(ev);
});

test('a failure after COMMIT never rolls back the approval or its proof', async () => {
  const ev = await newEvent();
  throwBlocks = true;
  const res = await approve(ev);
  assert.equal(res.status, 500);
  const commit = events.indexOf('sql:COMMIT');
  assert.ok(commit >= 0, 'committed');
  assert.ok(!events.slice(commit).includes('sql:ROLLBACK'), `no ROLLBACK after COMMIT: ${JSON.stringify(events)}`);
  assert.equal((await proofsOf(ev.id)).length, 1);
  assert.equal((await printOf(ev.id)).state, 'held');
});

// ── The derived print state after an approve and a release ──────────────────

test('logo role: stamps the plan\'s planner image key; once released, a replaced or removed logo reads edited since approval', async () => {
  const logo = `drink-plan-logos/0-${NONCE}-a.png`;
  const ev = await newEvent({ role: 'logo', logo });
  assert.equal((await approve(ev, { expectedRev: rev(logo) })).status, 200);
  assert.equal((await draftOf(ev.id)).approved_planner_image_key, logo);
  assert.equal((await printOf(ev.id)).state, 'held');
  assert.equal((await release(ev)).status, 200);
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
  assert.equal((await release(other)).status, 200);
  await setLogo(other.planId, `drink-plan-logos/0-${NONCE}-c.png`);
  assert.equal((await printOf(other.id)).state, 'approved');
});

test('a re-roll after a release reads edited since approval once the new art lands', async () => {
  const ev = await newEvent();
  assert.equal((await approve(ev)).status, 200);
  assert.equal((await release(ev)).status, 200);
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

test('beside an admin upload: Approve is 409 MENU_UPLOAD_LIVE before anything is superseded or inserted; once the upload goes it approves and holds', async () => {
  const ev = await newEvent();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('manual\n')]);
  // The card saw no file and no proof (the upload posts what it saw).
  const manual = await request('POST', `/api/proposals/${ev.id}/menu-print`, { form: {
    fields: { expected_print_key: '', seen_proof_id: '', seen_proof_answer: '' }, files: [{ field: 'file', name: 'm.pdf', bytes: pdf }] } });
  assert.equal(manual.status, 200);
  const manualKey = (await keyRow(ev.id)).menu_print_key;
  assert.match(manualKey, new RegExp(`^menu-print/${ev.id}/.+\\.pdf$`));
  assert.equal((await approve(ev)).status, 409, 'the page that saw no file is refused');
  await idle();
  for (const list of [events, reaccrued, accrualSeen]) list.length = 0;
  // A Looks great beside the upload could never release (guard 4), so no proof goes out.
  const refused = await approve(ev, { expected: manualKey });
  assert.deepEqual([refused.status, refused.body.code, refused.body.error],
    [409, 'MENU_UPLOAD_LIVE', 'Your uploaded file is what staff print. Remove it first to send this menu.']);
  for (const write of ['sql:UPDATE menu_drafts SET approved_version', 'sql:UPDATE menu_proofs SET superseded_at', 'sql:INSERT INTO menu_proofs']) {
    assert.ok(!events.some((e) => e.startsWith(write)), `${write} never ran`);
  }
  await assertUntouched(ev, { printKey: manualKey });
  // Removing the upload lets the menu go out, its file held for the client's answer.
  assert.equal((await request('DELETE', `/api/proposals/${ev.id}/menu-print`, { json: { expected_print_key: manualKey } })).status, 200);
  const ok = await approve(ev);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.print.state, ok.body.print.live], ['held', 'none']);
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
  assert.equal(ok.body.print.state, 'held');
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

test('logo role with no planner image: an empty rev approves and stamps null; a logo added after the release reads edited since approval', async () => {
  const ev = await newEvent({ role: 'logo' });
  assert.equal(await briefRev(ev.id), null);
  const res = await approve(ev, { expectedRev: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await draftOf(ev.id)).approved_planner_image_key, null);
  assert.equal((await release(ev)).status, 200);
  assert.equal((await printOf(ev.id)).state, 'approved');
  await setLogo(ev.planId, `drink-plan-logos/0-${NONCE}-late.png`);
  assert.equal((await printOf(ev.id)).state, 'edited_since_approval');
});

test('the transaction reads the drink plan only for the logo role', async () => {
  const logo = `drink-plan-logos/0-${NONCE}-plan.png`;
  const plain = await newEvent({ role: 'ignore', logo });
  assert.equal((await approve(plain)).status, 200);
  assert.deepEqual(events.filter((e) => /^sql:.*FROM drink_plans/.test(e)), [], 'no plan read for role ignore');
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

// ── The legal-hold proposal (money law 15; lane menu-legal-hold-guards) ─────

test('legal hold: Approve answers 409 LEGAL_HOLD before any read, upload or transaction, storing no file or proof; an unheld twin approves', async () => {
  const held = await newEvent();
  const twin = await newEvent();
  const before = await draftOf(held.id);
  __setLegalHoldIdsForTest([held.id]);
  const seen = [];
  const watchedQuery = pool.query;
  pool.query = function watched(...args) {
    seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || ''));
    return watchedQuery.apply(this, args);
  };
  let res;
  try {
    // The page's view is given, so the watched queries are the route's alone.
    res = await approve(held, { seen: { id: '', answer: '' } });
  } finally {
    pool.query = watchedQuery;
    __setLegalHoldIdsForTest(null);
  }
  assert.deepEqual([res.status, res.body && res.body.code], [409, 'LEGAL_HOLD'], JSON.stringify(res.body));
  assert.deepEqual(seen.filter((q) => /menu_drafts|menu_draft_pieces|menu_proofs|drink_plans|proposals/.test(q)), [],
    'refused before the proposal, its draft or its plan is read');
  assert.deepEqual(events, [], 'no upload, no transaction, no email, no reaccrual');
  assert.deepEqual(uploads, []);
  await assertUntouched(held);
  const after = await draftOf(held.id);
  for (const col of ['version', 'art_version', 'content', 'inputs', 'updated_at']) {
    assert.deepEqual(after[col], before[col], `${col} unchanged`);
  }

  const ok = await approve(twin);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await draftOf(twin.id)).approved_print_key, uploads[0]);
});
