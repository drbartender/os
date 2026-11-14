process.env.NODE_ENV = 'test';
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Route tests for the client menu proof's public routes (spec 2026-10-19
// sections 12, 18 and 20; lane menu-proof-page):
//   GET  /api/menu-proof/:token          the page state, no admin data
//   GET  /api/menu-proof/:token/image    the proof bytes, under menu-proof/<proposal_id>/
//   POST /api/menu-proof/:token/answer   Looks great or Request changes, once
//
// HARNESS NOTES
// -------------
// The sibling route suites' pattern (no supertest in this repo): a minimal
// express() app, the real router, the error handler shaped as server/index.js
// shapes it, and requests over real HTTP. R2 is stubbed at the module boundary
// (require.cache) before the router loads, so the image route never reaches
// Cloudflare and each read is recorded. Proof rows are inserted directly (the
// Approve suite covers how they are made). The menu proofs block of schema.sql
// is applied first, additive and idempotent (the calcom suite's precedent).
// Looks great can release the held print file (lane menu-approve-send):
// reaccrueDuty is wrapped (require.cache on menuPrintFile, before the router
// loads) over a fake payrollAccrual, and the admin's no-menu PATCH
// (menuPrint.js) is mounted beside the public router for the race test.
// publicLimiter allows 20 requests per IP per 15 minutes and every request here
// comes from 127.0.0.1, so its bucket (and publicTokenIpLimiter's) is reset
// before each test; the token-keyed limiters see a fresh token per test.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

if (process.env.NODE_ENV === 'production') throw new Error('menuProof.test.js refuses to run against production');

const { pool } = require('../db');
const { AppError, NotFoundError } = require('../utils/errors');
const { chicagoTodayYmd } = require('../utils/businessTime');

// ── Stub R2 before the router requires it ─────────────────────────────────
const storagePath = require.resolve('../utils/storage');
const realStorage = require('../utils/storage');
const readCalls = [];
const r2Objects = new Map();
require.cache[storagePath].exports = {
  ...realStorage,
  readFile: async (key) => {
    readCalls.push(key);
    if (!r2Objects.has(key)) throw new NotFoundError('File not found.');
    return { buffer: r2Objects.get(key), contentType: 'image/jpeg' };
  },
  getSignedUrl: async () => { throw new Error('this suite never signs a real R2 URL'); },
  uploadFile: async () => { throw new Error('this suite never uploads'); },
};

// ── Duty reaccrual: recorded, over a fake accrual that reads the row it sees ──
const Module = require('node:module');
const accrualPath = require.resolve('../utils/payrollAccrual');
const savedAccrual = require.cache[accrualPath];
const keyRow = (id) => pool.query('SELECT menu_print_key, menu_not_required FROM proposals WHERE id = $1', [id]).then((r) => r.rows[0]);
const fakeAccrual = new Module(accrualPath);
fakeAccrual.filename = accrualPath;
fakeAccrual.loaded = true;
fakeAccrual.exports = { maybeReaccrueForDuty: (pid) => keyRow(pid).then(() => ({ skipped: true })) };
require.cache[accrualPath] = fakeAccrual;
const printFilePath = require.resolve('../utils/menuPrintFile');
const realPrintFile = require('../utils/menuPrintFile');
const reaccrued = [];
require.cache[printFilePath].exports = {
  ...realPrintFile,
  reaccrueDuty: (id) => { reaccrued.push({ id, seen: keyRow(id) }); return realPrintFile.reaccrueDuty(id); },
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { __setLegalHoldIdsForTest } = require('../utils/legalHold');
const {
  publicLimiter, publicTokenIpLimiter, menuProofReadLimiter, menuProofAnswerLimiter, adminWriteLimiter,
} = require('../middleware/rateLimiters');
const menuProofRouter = require('./menuProof');
const menuPrintRouter = require('./proposals/menuPrint');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
const PROOF_DDL = SCHEMA_SQL.slice(
  SCHEMA_SQL.indexOf('-- ─── Menu proofs (spec 2026-10-19 sections 10.3 and 10.6) ───'),
  SCHEMA_SQL.indexOf('-- ─── end Menu proofs ───'));

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CLIENT_NAME = `MenuProof Route ${NONCE}`;
const CLIENT_EMAIL = `menuproof-route-${NONCE}@example.com`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`proof bytes ${NONCE}`)]);
const NOT_FOUND = { error: "We couldn't find that menu.", code: 'NOT_FOUND' };

let server;
let baseUrl;
let clientId;
let todayYmd;
let adminId;
let adminToken;
const proposalIds = [];
const HELD = (id) => `menu-print/${id}/held-${NONCE}.jpg`;

// The draft approved at the proof's pair (4/2 by default), its file held.
async function holdFile(ev, { version = 4, artVersion = 2 } = {}) {
  await pool.query(
    `UPDATE menu_drafts SET approved_version = $2, approved_art_version = $3, approved_print_key = $4, approved_at = NOW()
      WHERE id = $1`, [ev.draftId, version, artVersion, HELD(ev.proposalId)]);
}

async function releaseCols(ev) {
  return (await pool.query(
    `SELECT pr.menu_print_key, pr.menu_not_required, d.released_print_key, d.released_by, d.released_via
       FROM menu_drafts d JOIN proposals pr ON pr.id = d.proposal_id WHERE d.id = $1`, [ev.draftId])).rows[0];
}

async function makeProposal({ eventOffsetDays = 10, status = 'confirmed' } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, $2::date + $3::int, '18:00', 4, 'America/Chicago', $4, 'corporate') RETURNING id`,
    [clientId, todayYmd, eventOffsetDays, status]);
  proposalIds.push(p.id);
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, $2, '{}', '{}', '{}') RETURNING id`, [p.id, crypto.randomUUID()]);
  return { proposalId: p.id, draftId: d.id };
}

async function makeProof(ev, cols = {}) {
  const c = { version: 4, art_version: 2, ...cols };
  const key = c.r2_key || `menu-proof/${ev.proposalId}/${crypto.randomUUID()}.jpg`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status,
                              answer, answer_note, answered_at, superseded_at, withdrawn_at)
     VALUES ($1, $2, $3, $4, $5, $11, $6, $7, $8, $9, $10) RETURNING id, token, r2_key`,
    [ev.draftId, ev.proposalId, c.version, c.art_version, key, c.answer || null, c.answer_note || null,
      c.answered_at || null, c.superseded_at || null, c.withdrawn_at || null, c.email_status || 'sent']);
  if (c.stored !== false) r2Objects.set(row.r2_key, JPEG);
  return row;
}

async function proofRow(id) {
  return (await pool.query(
    'SELECT answer, answer_note, answered_at, superseded_at, withdrawn_at FROM menu_proofs WHERE id = $1', [id])).rows[0];
}

async function activity(proposalId) {
  return (await pool.query(
    `SELECT action, actor_type, actor_id, details FROM proposal_activity_log
      WHERE proposal_id = $1 ORDER BY id`, [proposalId])).rows;
}

function request(method, urlPath, json, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body = null;
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* bytes */ }
        resolve({ status: res.statusCode, body, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const getState = (token) => request('GET', `/api/menu-proof/${token}`);
const answer = (token, body) => request('POST', `/api/menu-proof/${token}/answer`, body);

before(async () => {
  await pool.query(PROOF_DDL);
  todayYmd = chicagoTodayYmd();
  const { rows: [c] } = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555553355') RETURNING id", [CLIENT_NAME, CLIENT_EMAIL]);
  clientId = c.id;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`, [`menuproof-route-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]);
  adminId = u.id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/menu-proof', menuProofRouter);
  app.use('/api/proposals', menuPrintRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await publicLimiter.resetKey('127.0.0.1');
  await publicTokenIpLimiter.resetKey('127.0.0.1');
  if (adminId) await adminWriteLimiter.resetKey(`admin-${adminId}`);
  reaccrued.length = 0;
});

after(async () => {
  await Promise.allSettled(reaccrued.map((r) => r.seen));
  await new Promise((resolve) => { setImmediate(resolve); });
  __setLegalHoldIdsForTest(null);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  require.cache[storagePath].exports = realStorage;
  require.cache[printFilePath].exports = realPrintFile;
  if (savedAccrual) require.cache[accrualPath] = savedAccrual;
  else delete require.cache[accrualPath];
});

// ─── GET the state ─────────────────────────────────────────────────────────

const BODY_KEYS = ['answer', 'answer_note', 'answered_at', 'emailed', 'event_passed', 'image', 'state'];
// The two page booleans (lane menu-approve-send, carried items d and g), for an
// emailed proof whose event day is still ahead, the makeProof default.
const AHEAD = { emailed: true, event_passed: false };

test('GET: an open proof answers its state and nothing else', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const res = await getState(p.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'open', answer: null, answer_note: null, answered_at: null, image: true, ...AHEAD });
  assert.equal(res.headers['cache-control'], 'no-store', 'the state (and a note) is never cached');
  const text = res.raw.toString('utf8');
  for (const leak of [CLIENT_NAME, CLIENT_EMAIL, p.r2_key, 'menu-proof/', 'event_date', 'version']) {
    assert.ok(!text.includes(leak), `the body never carries ${leak}`);
  }
});

test('GET: approved and changes carry the answer, its note and when', async () => {
  const ev = await makeProposal();
  const at = new Date('2026-11-03T20:15:00Z');
  const ok = await makeProof(ev, { answer: 'approved', answered_at: at });
  const res = await getState(ok.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'approved', answer: 'approved', answer_note: null, answered_at: at.toISOString(), image: true, ...AHEAD });

  const ch = await makeProof(ev, { answer: 'changes', answer_note: 'Can the title say Happy 40th?', answered_at: at });
  const res2 = await getState(ch.token);
  assert.deepEqual(res2.body, {
    state: 'changes', answer: 'changes', answer_note: 'Can the title say Happy 40th?', answered_at: at.toISOString(), image: true, ...AHEAD,
  });
});

test('GET: superseded, withdrawn and expired show no picture and no answer, even one given before', async () => {
  const ev = await makeProposal();
  const now = new Date();
  const sup = await makeProof(ev, { superseded_at: now, answer: 'changes', answer_note: 'old note', answered_at: now });
  const wd = await makeProof(ev, { withdrawn_at: now });
  const closed = await makeProof(ev, { withdrawn_at: now, answer: 'changes', answer_note: 'closed note', answered_at: now });
  const past = await makeProposal({ eventOffsetDays: -1 });
  const exp = await makeProof(past);
  const expSup = await makeProof(past, { superseded_at: now });
  for (const [p, state, passed] of [[sup, 'superseded', false], [wd, 'withdrawn', false], [closed, 'withdrawn', false],
    [exp, 'expired', true], [expSup, 'superseded', true]]) {
    const res = await getState(p.token);
    assert.equal(res.status, 200, state);
    assert.deepEqual(res.body, { state, answer: null, answer_note: null, answered_at: null, image: false, emailed: true, event_passed: passed });
    assert.deepEqual(Object.keys(res.body).sort(), BODY_KEYS);
  }
});

// Carried item c (lane menu-approve-send): an answered proof past its life
// keeps its answer, so the page shows its thank-you lines with the picture off.
test('GET: an answered proof past its link\'s life keeps its answer and its note, with the picture off', async () => {
  const past = await makeProposal({ eventOffsetDays: -1 });
  const at = new Date('2026-11-03T20:15:00Z');
  const ok = await makeProof(past, { answer: 'approved', answered_at: at });
  const after = { emailed: true, event_passed: true };
  assert.deepEqual((await getState(ok.token)).body, { state: 'approved', answer: 'approved', answer_note: null, answered_at: at.toISOString(), image: false, ...after });
  const ch = await makeProof(past, { answer: 'changes', answer_note: 'A late note', answered_at: at });
  assert.deepEqual((await getState(ch.token)).body, { state: 'changes', answer: 'changes', answer_note: 'A late note', answered_at: at.toISOString(), image: false, ...after });
  readCalls.length = 0;
  for (const p of [ok, ch]) assert.equal((await request('GET', `/api/menu-proof/${p.token}/image`)).status, 404);
  assert.deepEqual(readCalls, [], 'the picture is never read once the link has expired');
  const again = await answer(ok.token, { answer: 'changes', note: 'too late' });
  assert.deepEqual([again.status, again.body.code], [409, 'MENU_PROOF_ANSWERED']);
});

// Carried item d (lane menu-approve-send): the expired screen stops promising a
// fresh link once the event day has passed (Approve refuses one then).
test('GET: event_passed is true only once the event day is before today in Chicago, and false with no date', async () => {
  for (const [offset, passed] of [[-1, true], [-30, true], [0, false], [1, false], [null, false]]) {
    const ev = await makeProposal({ eventOffsetDays: offset });
    const p = await makeProof(ev);
    const res = await getState(p.token);
    assert.equal(res.status, 200, String(offset));
    assert.equal(res.body.event_passed, passed, `event day ${offset === null ? 'none' : offset} days from today`);
  }
  // A link with no date expires 30 days after it went out, the event never passed.
  const undated = await makeProposal({ eventOffsetDays: null });
  const old = await makeProof(undated);
  await pool.query("UPDATE menu_proofs SET sent_at = NOW() - INTERVAL '31 days' WHERE id = $1", [old.id]);
  const body = (await getState(old.token)).body;
  assert.deepEqual([body.state, body.event_passed], ['expired', false]);
});

// Carried item g: a proof that was never emailed must not point the client at "our email".
test('GET: emailed is true only for a proof whose email went out, and the status itself never leaves', async () => {
  const ev = await makeProposal();
  for (const [status, emailed] of [['sent', true], ['pending', false], ['failed', false], ['no_address', false],
    ['skipped', false], ['suppressed', false]]) {
    const p = await makeProof(ev, { email_status: status });
    const res = await getState(p.token);
    assert.equal(res.status, 200, status);
    assert.equal(res.body.emailed, emailed, status);
    assert.deepEqual(Object.keys(res.body).sort(), BODY_KEYS, 'booleans only');
    const text = res.raw.toString('utf8');
    assert.ok(!text.includes(`"${status}"`) && !text.includes(CLIENT_EMAIL), `the body never carries ${status} or the address`);
  }
});

test('GET: 404 for an unknown token, a malformed one, an archived proposal and a cascaded draft', async () => {
  assert.deepEqual((await getState(crypto.randomUUID())).body, NOT_FOUND);
  const bad = await getState('not-a-uuid');
  assert.equal(bad.status, 404);
  assert.deepEqual(bad.body, NOT_FOUND);
  const archived = await makeProposal({ status: 'archived' });
  const a = await makeProof(archived);
  assert.equal((await getState(a.token)).status, 404);
  const gone = await makeProposal();
  const g = await makeProof(gone);
  await pool.query('DELETE FROM menu_drafts WHERE id = $1', [gone.draftId]);
  assert.equal((await getState(g.token)).status, 404);
});

// ─── GET the image ─────────────────────────────────────────────────────────

test('image: open, approved and changes stream the row\'s own key, private and no-cache', async () => {
  const ev = await makeProposal();
  const now = new Date();
  for (const cols of [{}, { answer: 'approved', answered_at: now }, { answer: 'changes', answer_note: 'x', answered_at: now }]) {
    const p = await makeProof(ev, cols);
    readCalls.length = 0;
    const res = await request('GET', `/api/menu-proof/${p.token}/image`);
    assert.equal(res.status, 200, JSON.stringify(cols));
    assert.equal(res.headers['cache-control'], 'private, no-cache');
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.ok(res.raw.equals(JPEG), 'the stored bytes');
    assert.deepEqual(readCalls, [p.r2_key]);
  }
});

test('image: 404 outside open, approved and changes, before R2 is read', async () => {
  const ev = await makeProposal();
  const now = new Date();
  const sup = await makeProof(ev, { superseded_at: now });
  const wd = await makeProof(ev, { withdrawn_at: now });
  const past = await makeProposal({ eventOffsetDays: -1 });
  const exp = await makeProof(past);
  const expOk = await makeProof(past, { answer: 'approved', answered_at: now });
  const archived = await makeProposal({ status: 'archived' });
  const arc = await makeProof(archived);
  readCalls.length = 0;
  for (const p of [sup, wd, exp, expOk, arc]) {
    const res = await request('GET', `/api/menu-proof/${p.token}/image`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
  }
  assert.equal((await request('GET', `/api/menu-proof/${crypto.randomUUID()}/image`)).status, 404);
  assert.equal((await request('GET', '/api/menu-proof/not-a-uuid/image')).status, 404);
  assert.deepEqual(readCalls, [], 'R2 was never read');
});

test('image: the prefix is the row\'s own proposal, so a key anywhere else is never read', async () => {
  const ev = await makeProposal();
  const other = await makeProposal();
  readCalls.length = 0;
  for (const key of [
    `menu-proof/${other.proposalId}/${crypto.randomUUID()}.jpg`,
    `menu-print/${ev.proposalId}/${crypto.randomUUID()}.jpg`,
    `menu-art/${ev.proposalId}/${crypto.randomUUID()}.jpg`,
    `menu-proof/${ev.proposalId}/../../menu-print/${ev.proposalId}/x.jpg`,
    `menu-proof/${ev.proposalId}1/${crypto.randomUUID()}.jpg`,
  ]) {
    const p = await makeProof(ev, { r2_key: key });
    const res = await request('GET', `/api/menu-proof/${p.token}/image`);
    assert.equal(res.status, 404, key);
  }
  assert.deepEqual(readCalls, [], 'no key outside menu-proof/<proposal_id>/ reached R2');
});

test('image: a proof missing in R2 is a 404, not a 500', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev, { stored: false });
  const res = await request('GET', `/api/menu-proof/${p.token}/image`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

// ─── POST the answer ───────────────────────────────────────────────────────

test('answer: Looks great records approved once, with the activity row; with no held file nothing is released', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev, { version: 7, art_version: 3 });
  const res = await answer(p.token, { answer: 'approved' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['answered_at', 'state']);
  assert.equal(res.body.state, 'approved');
  const row = await proofRow(p.id);
  assert.equal(row.answer, 'approved');
  assert.equal(row.answer_note, null);
  assert.equal(row.answered_at.toISOString(), res.body.answered_at);
  assert.deepEqual(await activity(ev.proposalId), [{
    action: 'menu_proof_approved', actor_type: 'client', actor_id: null,
    details: { proof_id: p.id, version: 7, art_version: 3 },
  }]);
  // Nothing was approved, so nothing is held: the key and the release columns stay as they were.
  const { rows: [d] } = await pool.query(
    `SELECT pr.menu_print_key, d.released_print_key, d.released_at, d.released_by, d.released_via
       FROM menu_drafts d JOIN proposals pr ON pr.id = d.proposal_id WHERE d.id = $1`, [ev.draftId]);
  assert.deepEqual(d, { menu_print_key: null, released_print_key: null, released_at: null, released_by: null, released_via: null });
  assert.equal((await getState(p.token)).body.state, 'approved');
  assert.deepEqual(reaccrued, [], 'no reaccrual');
});

test('answer: Request changes stores the trimmed note; the activity row has its length, never the note', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev, { version: 5, art_version: 1 });
  const note = 'Swap the Paloma for a margarita, <b>please</b>';
  const res = await answer(p.token, { answer: 'changes', note: `  ${note}\n ` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, 'changes');
  const row = await proofRow(p.id);
  assert.equal(row.answer, 'changes');
  assert.equal(row.answer_note, note, 'stored as plain text, trimmed, not escaped or stripped');
  const rows = await activity(ev.proposalId);
  assert.deepEqual(rows, [{
    action: 'menu_proof_changes', actor_type: 'client', actor_id: null,
    details: { proof_id: p.id, version: 5, art_version: 1, note_length: note.length },
  }]);
  assert.ok(!JSON.stringify(rows).includes('Paloma'), 'the note never lands in the activity log');
  const got = await getState(p.token);
  assert.equal(got.body.state, 'changes');
  assert.equal(got.body.answer_note, note);
});

test('answer: a second answer is refused with MENU_PROOF_ANSWERED and changes nothing', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  assert.equal((await answer(p.token, { answer: 'changes', note: 'first' })).status, 200);
  const first = await proofRow(p.id);
  for (const body of [{ answer: 'approved' }, { answer: 'changes', note: 'second' }]) {
    const res = await answer(p.token, body);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'MENU_PROOF_ANSWERED');
  }
  assert.deepEqual(await proofRow(p.id), first);
  assert.equal((await activity(ev.proposalId)).length, 1);
  assert.equal((await getState(p.token)).body.state, 'changes');
});

test('answer: an older link, a withdrawn proof and an expired one are refused with their codes and states', async () => {
  const ev = await makeProposal();
  const now = new Date();
  const sup = await makeProof(ev, { superseded_at: now });
  const wd = await makeProof(ev, { withdrawn_at: now });
  const past = await makeProposal({ eventOffsetDays: -1 });
  const exp = await makeProof(past);
  for (const [p, code, state] of [
    [sup, 'MENU_PROOF_SUPERSEDED', 'superseded'],
    [wd, 'MENU_PROOF_WITHDRAWN', 'withdrawn'],
    [exp, 'MENU_PROOF_EXPIRED', 'expired'],
  ]) {
    const before = await proofRow(p.id);
    const res = await answer(p.token, { answer: 'approved' });
    assert.equal(res.status, 409, state);
    assert.equal(res.body.code, code);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error'], 'the error body keeps its shape');
    assert.deepEqual(await proofRow(p.id), before, `${state}: nothing written`);
    assert.equal((await getState(p.token)).body.state, state);
  }
  assert.deepEqual(await activity(ev.proposalId), []);
  assert.deepEqual(await activity(past.proposalId), []);
});

test('answer: 404 for an unknown token, a malformed one and an archived proposal, writing nothing', async () => {
  assert.deepEqual((await answer(crypto.randomUUID(), { answer: 'approved' })).body, NOT_FOUND);
  const bad = await answer('not-a-uuid', { answer: 'approved' });
  assert.equal(bad.status, 404);
  const archived = await makeProposal({ status: 'archived' });
  const a = await makeProof(archived);
  assert.equal((await answer(a.token, { answer: 'approved' })).status, 404);
  assert.equal((await proofRow(a.id)).answer, null);
  assert.deepEqual(await activity(archived.proposalId), []);
});

test('answer: a proposal under legal hold is refused as not found, writing nothing (isLegalHold)', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  __setLegalHoldIdsForTest([ev.proposalId]);
  try {
    const res = await answer(p.token, { answer: 'approved' });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  assert.equal((await proofRow(p.id)).answer, null);
  assert.deepEqual(await activity(ev.proposalId), []);
});

test('answer: the body rules, checked on the server before anything is written', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  for (const body of [
    {}, { answer: 'maybe' }, { answer: 'APPROVED' }, { answer: ['approved'] }, { answer: 1 },
    { answer: 'changes' }, { answer: 'changes', note: '' }, { answer: 'changes', note: '   \n ' },
    { answer: 'changes', note: 'x'.repeat(1001) }, { answer: 'changes', note: 42 }, { answer: 'changes', note: { a: 1 } },
    { answer: 'approved', note: 'looks fine' }, { answer: 'approved', note: 7 },
  ]) {
    // The limiter runs before validation (5 posts per address and token), so each body gets a fresh bucket.
    await menuProofAnswerLimiter.resetKey(`127.0.0.1:${p.token}`);
    const res = await answer(p.token, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  await menuProofAnswerLimiter.resetKey(`127.0.0.1:${p.token}`);
  assert.equal((await answer(p.token, '[1,2]')).status, 400, 'a JSON array body');
  assert.equal((await proofRow(p.id)).answer, null, 'nothing written');
  assert.deepEqual(await activity(ev.proposalId), []);
});

test('answer: a note of exactly 1,000 characters after trimming is accepted', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const note = 'y'.repeat(1000);
  const res = await answer(p.token, { answer: 'changes', note: `   ${note}   ` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await proofRow(p.id)).answer_note, note);
});

test('answer: an empty, blank or null note is fine with Looks great and is stored as null', async () => {
  const ev = await makeProposal();
  for (const note of ['', '   ', null]) {
    const p = await makeProof(ev);
    const res = await answer(p.token, { answer: 'approved', note });
    assert.equal(res.status, 200, JSON.stringify(note));
    assert.equal((await proofRow(p.id)).answer_note, null);
  }
});

test('answer: two answers at once, exactly one lands', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const results = await Promise.all([
    answer(p.token, { answer: 'approved' }),
    answer(p.token, { answer: 'changes', note: 'racing' }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(results.find((r) => r.status === 409).body.code, 'MENU_PROOF_ANSWERED');
  assert.equal((await activity(ev.proposalId)).length, 1);
});

test('answer: one pooled connection for the whole request, no bare pool.query', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const realQuery = pool.query;
  const realConnect = pool.connect;
  let bare = 0;
  let connects = 0;
  pool.query = function countedQuery(...args) { bare += 1; return realQuery.apply(this, args); };
  pool.connect = function countedConnect(...args) { connects += 1; return realConnect.apply(this, args); };
  let res;
  try {
    res = await answer(p.token, { answer: 'changes', note: 'one connection' });
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
  }
  assert.equal(res.status, 200);
  assert.equal(bare, 0, 'every query went through the held client');
  assert.equal(connects, 1);
});

// ─── Looks great releases the held file (lane menu-approve-send) ──────────

// Waits for the reaccruals fired so far to read their rows.
const settled = () => Promise.allSettled(reaccrued.map((r) => r.seen));

test('release: Looks great on the proof of the approved pair releases the held file, stamps via client and re-accrues after the commit', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  await holdFile(ev);
  const res = await answer(p.token, { answer: 'approved' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await releaseCols(ev), {
    menu_print_key: HELD(ev.proposalId), menu_not_required: false,
    released_print_key: HELD(ev.proposalId), released_by: null, released_via: 'client',
  });
  const rows = await activity(ev.proposalId);
  assert.deepEqual(rows.map((r) => [r.action, r.actor_type, r.actor_id]), [['menu_proof_approved', 'client', null], ['menu_released', 'client', null]]);
  assert.deepEqual(rows[1].details, { draft_id: ev.draftId, version: 4, art_version: 2, via: 'client' });
  assert.equal(reaccrued.length, 1);
  assert.equal(reaccrued[0].id, ev.proposalId);
  await settled();
  assert.deepEqual(await reaccrued[0].seen, { menu_print_key: HELD(ev.proposalId), menu_not_required: false }, 'the accrual read the committed key');
});

test('release: only the matching held file; never over an upload, the mark, a file the admin released, or a proof of another pair; the answer always stands', async () => {
  const upload = await makeProposal();
  const up = await makeProof(upload);
  await holdFile(upload);
  await pool.query("UPDATE proposals SET menu_print_key = 'menu-print/0/admin-upload.pdf' WHERE id = $1", [upload.proposalId]);

  const marked = await makeProposal();
  const mk = await makeProof(marked);
  await holdFile(marked);
  await pool.query('UPDATE proposals SET menu_not_required = true WHERE id = $1', [marked.proposalId]);

  const done = await makeProposal();
  const dn = await makeProof(done);
  await holdFile(done);
  await pool.query("UPDATE menu_drafts SET released_print_key = approved_print_key, released_at = NOW(), released_via = 'admin' WHERE id = $1", [done.draftId]);
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [done.proposalId, HELD(done.proposalId)]);

  const otherPair = await makeProposal();
  const op = await makeProof(otherPair, { version: 4, art_version: 2 });
  await holdFile(otherPair, { version: 5, artVersion: 2 });

  for (const [ev, p, key, mark] of [
    [upload, up, 'menu-print/0/admin-upload.pdf', false],
    [marked, mk, null, true],
    [done, dn, HELD(done.proposalId), false],
    [otherPair, op, null, false],
  ]) {
    const res = await answer(p.token, { answer: 'approved' });
    assert.equal(res.status, 200, 'the answer is recorded');
    assert.equal((await proofRow(p.id)).answer, 'approved');
    const cols = await releaseCols(ev);
    assert.deepEqual([cols.menu_print_key, cols.menu_not_required], [key, mark], 'the key and the mark are as they were');
    assert.deepEqual((await activity(ev.proposalId)).map((r) => r.action), ['menu_proof_approved'], 'no menu_released row');
  }
  assert.deepEqual(reaccrued, [], 'nothing moved, nothing re-accrued');
});

test('release: Request changes never releases', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  await holdFile(ev);
  assert.equal((await answer(p.token, { answer: 'changes', note: 'Not yet' })).status, 200);
  assert.equal((await releaseCols(ev)).menu_print_key, null);
  assert.deepEqual(reaccrued, []);
});

test('lock order: the draft, then the proposal, FOR UPDATE, before the one-shot answer, all on the one connection', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  await holdFile(ev);
  const seen = [];
  const realConnect = pool.connect;
  pool.connect = function wrapped(...args) {
    if (args.length) return realConnect.apply(this, args);
    return realConnect.call(this).then((client) => {
      const q = client.query;
      const release = client.release;
      client.query = function logged(text, ...rest) { seen.push(String(text).replace(/\s+/g, ' ').trim()); return q.call(this, text, ...rest); };
      client.release = function rel(...r) { client.query = q; client.release = release; return release.apply(client, r); };
      return client;
    });
  };
  let res;
  try {
    res = await answer(p.token, { answer: 'approved' });
  } finally {
    pool.connect = realConnect;
  }
  assert.equal(res.status, 200);
  const at = (re) => seen.findIndex((s) => re.test(s));
  const draftLock = at(/^SELECT id FROM menu_drafts WHERE id = \$1 FOR UPDATE$/);
  const proposalLock = at(/^SELECT id, status FROM proposals WHERE id = \$1 FOR UPDATE$/);
  const answerUpd = at(/^UPDATE menu_proofs mp SET answer/);
  const setKey = at(/^UPDATE proposals SET menu_print_key/);
  assert.ok(draftLock >= 0 && draftLock < proposalLock && proposalLock < answerUpd && answerUpd < setKey, JSON.stringify(seen));
});

test('archived under the lock: a proposal archived before the answer takes its lock is not found, and nothing is written', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  await holdFile(ev);
  // Hold the proposal row, archive it, and let the answer queue behind the lock.
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [ev.proposalId]);
  const pending = answer(p.token, { answer: 'approved' });
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  await blocker.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [ev.proposalId]);
  await blocker.query('COMMIT');
  blocker.release();
  const res = await pending;
  assert.deepEqual([res.status, res.body], [404, NOT_FOUND]);
  assert.equal((await proofRow(p.id)).answer, null, 'no answer on a just-archived proposal');
  assert.equal((await releaseCols(ev)).menu_print_key, null);
  assert.deepEqual(await activity(ev.proposalId), []);
});

// Review Focus 1: the client's Looks great and the admin's no-menu mark at the
// same instant. The draft row is held here while the two requests queue on it,
// one after the other (each seen waiting in pg_stat_activity before the next is
// sent), then let go: the first in the queue commits first. Both orders run.
// The mark is never cleared, the event never holds a key and the mark
// together, and the duty line reads the final key.
async function waitersOn(draftId, n) {
  for (let i = 0; i < 100; i += 1) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%menu_drafts%FOR UPDATE%' AND datname = current_database()`);
    if (r.n >= n) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`fewer than ${n} requests ever waited on draft ${draftId}`);
}

test('race: Looks great and the no-menu PATCH at once, whichever commits first wins and the mark is never cleared', async (t) => {
  const outcomes = [];
  for (const first of ['answer', 'mark', 'answer', 'mark']) {
    const ev = await makeProposal();
    const p = await makeProof(ev);
    await holdFile(ev);
    reaccrued.length = 0;
    await menuProofAnswerLimiter.resetKey(`127.0.0.1:${p.token}`);
    await publicLimiter.resetKey('127.0.0.1');
    await adminWriteLimiter.resetKey(`admin-${adminId}`);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM menu_drafts WHERE id = $1 FOR UPDATE', [ev.draftId]);
    const sendAnswer = () => answer(p.token, { answer: 'approved' });
    const sendMark = () => request('PATCH', `/api/proposals/${ev.proposalId}/menu-print`, { not_required: true }, adminToken);
    let ans;
    let patch;
    try {
      if (first === 'answer') {
        ans = sendAnswer();
        await waitersOn(ev.draftId, 1);
        patch = sendMark();
      } else {
        patch = sendMark();
        await waitersOn(ev.draftId, 1);
        ans = sendAnswer();
      }
      await waitersOn(ev.draftId, 2);
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    [ans, patch] = await Promise.all([ans, patch]);
    const cols = await releaseCols(ev);
    const proof = await proofRow(p.id);
    assert.ok(!(cols.menu_print_key && cols.menu_not_required), 'never a key and the mark together');
    if (cols.menu_not_required) {
      // The mark won: the proof was withdrawn first, so Looks great was refused and nothing was released.
      outcomes.push('mark');
      assert.deepEqual([patch.status, ans.status, ans.body.code], [200, 409, 'MENU_PROOF_WITHDRAWN']);
      assert.ok(proof.withdrawn_at instanceof Date);
      assert.equal(proof.answer, null);
      assert.equal(cols.menu_print_key, null);
      assert.deepEqual(reaccrued, []);
    } else {
      // Looks great won: the file was released, and the mark was refused (a file is posted).
      outcomes.push('answer');
      assert.deepEqual([ans.status, patch.status], [200, 409]);
      assert.equal(cols.menu_print_key, HELD(ev.proposalId));
      assert.equal(proof.answer, 'approved');
      assert.equal(proof.withdrawn_at, null);
      assert.equal(reaccrued.length, 1);
      await settled();
      assert.deepEqual(await reaccrued[0].seen, { menu_print_key: HELD(ev.proposalId), menu_not_required: false });
    }
  }
  t.diagnostic(`winners in order: ${outcomes.join(', ')}`);
  assert.deepEqual(outcomes, ['answer', 'mark', 'answer', 'mark'], 'the first in the queue commits first');
});

// ─── The limiters ──────────────────────────────────────────────────────────

function routeChain(method, routePath) {
  const layer = menuProofRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is registered`);
  return layer.route.stack.map((l) => l.handle);
}

// The first handle must be the UUID guard: it 404s a bad token with the page's copy.
function assertUuidGuard(handle) {
  let passed = null;
  handle({ params: { token: 'not-a-uuid' } }, {}, (err) => { passed = err; });
  assert.ok(passed instanceof NotFoundError, 'the chain opens with requireUuidToken');
  assert.equal(passed.message, "We couldn't find that menu.");
  let ok = 'unset';
  handle({ params: { token: crypto.randomUUID() } }, {}, (err) => { ok = err; });
  assert.equal(ok, undefined, 'a UUID passes the guard');
}

test('limiters: each route carries its chain in order (spec 18)', () => {
  for (const routePath of ['/:token', '/:token/image']) {
    const chain = routeChain('get', routePath);
    assert.equal(chain.length, 4, routePath);
    assertUuidGuard(chain[0]);
    assert.equal(chain[1], publicTokenIpLimiter, `${routePath}: publicTokenIpLimiter second`);
    assert.equal(chain[2], menuProofReadLimiter, `${routePath}: menuProofReadLimiter third`);
  }
  const post = routeChain('post', '/:token/answer');
  assert.equal(post.length, 4);
  assertUuidGuard(post[0]);
  assert.equal(post[1], publicLimiter, 'publicLimiter second');
  assert.equal(post[2], menuProofAnswerLimiter, 'menuProofAnswerLimiter third');
});

test('limiters: the answer limiter stops a sixth post on one token from one address, not another token', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await answer(p.token, { answer: 'approved' })).status);
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 429]);
  const q = await makeProof(ev);
  assert.equal((await answer(q.token, { answer: 'approved' })).status, 200, 'another token has its own bucket');
});

test('limiters: the read limiter allows 60 reads per token in 15 minutes, shared by the page and the image', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await getState(p.token)).status, 200, `read ${i + 1}`);
    assert.equal((await request('GET', `/api/menu-proof/${p.token}/image`)).status, 200, `image ${i + 1}`);
  }
  const over = await getState(p.token);
  assert.equal(over.status, 429, 'the 61st read on the token');
  const q = await makeProof(ev);
  assert.equal((await getState(q.token)).status, 200, 'another token has its own bucket');
});

// The UUID guard and Postgres both read a token in either letter case, so the
// buckets must too: one link is one bucket, however its token is spelled.
test('limiters: every case spelling of one token shares its buckets', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const upper = p.token.toUpperCase();
  assert.notEqual(upper, p.token, 'the fixture token has a hex letter to re-case');
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await getState(p.token)).status, 200, `read ${i + 1}`);
    assert.equal((await request('GET', `/api/menu-proof/${upper}/image`)).status, 200, `image ${i + 1}, upper case`);
  }
  assert.equal((await getState(upper)).status, 429, 'the 61st read, under the other spelling');
  assert.equal((await getState(p.token)).status, 429, 'and under the first');

  const q = await makeProof(ev);
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await answer(i % 2 ? q.token.toUpperCase() : q.token, { answer: 'approved' })).status);
  }
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 429], 'six posts across two spellings spend one answer bucket');
});
