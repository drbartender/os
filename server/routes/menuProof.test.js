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
// Cloudflare and each read is recorded. Proof rows are inserted directly
// (nothing in the app creates one yet). The menu proofs block of schema.sql is
// applied first, additive and idempotent (the calcom suite's precedent).
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

const { __setLegalHoldIdsForTest } = require('../utils/legalHold');
const {
  publicLimiter, publicTokenIpLimiter, menuProofReadLimiter, menuProofAnswerLimiter,
} = require('../middleware/rateLimiters');
const menuProofRouter = require('./menuProof');

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
const proposalIds = [];

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
     VALUES ($1, $2, $3, $4, $5, 'sent', $6, $7, $8, $9, $10) RETURNING id, token, r2_key`,
    [ev.draftId, ev.proposalId, c.version, c.art_version, key, c.answer || null, c.answer_note || null,
      c.answered_at || null, c.superseded_at || null, c.withdrawn_at || null]);
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

function request(method, urlPath, json) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const headers = {};
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

  const app = express();
  app.use(express.json());
  app.use('/api/menu-proof', menuProofRouter);
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
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  require.cache[storagePath].exports = realStorage;
});

// ─── GET the state ─────────────────────────────────────────────────────────

const BODY_KEYS = ['answer', 'answer_note', 'answered_at', 'image', 'state'];

test('GET: an open proof answers its state and nothing else', async () => {
  const ev = await makeProposal();
  const p = await makeProof(ev);
  const res = await getState(p.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'open', answer: null, answer_note: null, answered_at: null, image: true });
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
  assert.deepEqual(res.body, { state: 'approved', answer: 'approved', answer_note: null, answered_at: at.toISOString(), image: true });

  const ch = await makeProof(ev, { answer: 'changes', answer_note: 'Can the title say Happy 40th?', answered_at: at });
  const res2 = await getState(ch.token);
  assert.deepEqual(res2.body, {
    state: 'changes', answer: 'changes', answer_note: 'Can the title say Happy 40th?', answered_at: at.toISOString(), image: true,
  });
});

test('GET: superseded, withdrawn and expired show no picture and no answer, even one given before', async () => {
  const ev = await makeProposal();
  const now = new Date();
  const sup = await makeProof(ev, { superseded_at: now, answer: 'changes', answer_note: 'old note', answered_at: now });
  const wd = await makeProof(ev, { withdrawn_at: now });
  const past = await makeProposal({ eventOffsetDays: -1 });
  const exp = await makeProof(past, { answer: 'approved', answered_at: now });
  for (const [p, state] of [[sup, 'superseded'], [wd, 'withdrawn'], [exp, 'expired']]) {
    const res = await getState(p.token);
    assert.equal(res.status, 200, state);
    assert.deepEqual(res.body, { state, answer: null, answer_note: null, answered_at: null, image: false });
    assert.deepEqual(Object.keys(res.body).sort(), BODY_KEYS);
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
  const archived = await makeProposal({ status: 'archived' });
  const arc = await makeProof(archived);
  readCalls.length = 0;
  for (const p of [sup, wd, exp, arc]) {
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

test('answer: Looks great records approved once, with the activity row and no release', async () => {
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
  // No release in this lane: the print key and the release columns stay as they were.
  const { rows: [d] } = await pool.query(
    `SELECT pr.menu_print_key, d.released_print_key, d.released_at, d.released_by, d.released_via
       FROM menu_drafts d JOIN proposals pr ON pr.id = d.proposal_id WHERE d.id = $1`, [ev.draftId]);
  assert.deepEqual(d, { menu_print_key: null, released_print_key: null, released_at: null, released_by: null, released_via: null });
  assert.equal((await getState(p.token)).body.state, 'approved');
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
