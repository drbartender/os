process.env.NODE_ENV = 'test';
require('dotenv').config();
// Route tests for the held menu's admin release and Close request (spec
// 2026-10-19 sections 10.3, 10.5 and 20; lane menu-approve-send):
//   POST /api/proposals/:id/menu-draft/release      Release for printing, Put it back for staff
//   POST /api/proposals/:id/menu-draft/proof/close  Close request
// read back through the real GET /api/proposals/:id/menu-draft, beside the
// real menu-print remove. The sibling route suites' harness: a minimal express
// app, the real routers, real HTTP. The approval, its held file and the proof
// are fixture rows written directly (the Approve suite covers how they are
// made). reaccrueDuty is wrapped (require.cache on menuPrintFile, before the
// routes load) to record when it fires, over a fake payrollAccrual; the
// transaction client's statements, its release, the reaccrual and the Inbox
// cache are logged in one sequence. Nothing reaches R2, a provider or email.
//
// Run: node --test server/routes/proposals/menuDraftRelease.test.js
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const events = [];
const { AppError } = require('../../utils/errors');

const storagePath = require.resolve('../../utils/storage');
const realStorage = require('../../utils/storage');
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async () => { throw new Error('menuDraftRelease.test: nothing uploads'); },
  getSignedUrl: async () => { throw new Error('menuDraftRelease.test: nothing may presign'); },
};

const inboxCache = require('../../utils/inbox/cache');
const realInvalidate = inboxCache.invalidate;
inboxCache.invalidate = () => { events.push('invalidate'); realInvalidate(); };

const { pool } = require('../../db');
const accrualPath = require.resolve('../../utils/payrollAccrual');
const savedAccrual = require.cache[accrualPath];
const keyRow = (id) => pool.query('SELECT menu_print_key, menu_not_required FROM proposals WHERE id = $1', [id]).then((r) => r.rows[0]);
const accrualSeen = [];
// What the fake accrual answers (or throws), set by a test; reset before each
// to the real one's answer for an event not completed (every fixture here).
const SKIPPED = async () => ({ skipped: true, reason: 'not_recent_completed' });
let accrue = SKIPPED;
const fakeAccrual = new Module(accrualPath);
fakeAccrual.filename = accrualPath;
fakeAccrual.loaded = true;
fakeAccrual.exports = {
  maybeReaccrueForDuty: (pid) => {
    events.push(`accrue:${pid}`);
    const seen = keyRow(pid);
    accrualSeen.push({ pid, seen });
    return seen.then(() => accrue(pid));
  },
};
require.cache[accrualPath] = fakeAccrual;

// Sentry: recorded, never sent.
const sentryModule = require('@sentry/node');
const savedCapture = sentryModule.captureException;
const captured = [];
sentryModule.captureException = (err, ctx) => { captured.push({ message: err && err.message, ctx }); };

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

const realConnect = pool.connect;
pool.connect = function connect(...args) {
  if (args.length) return realConnect.apply(this, args);
  events.push('connect');
  return realConnect.call(this).then((client) => {
    const release = client.release;
    client.query = function query(text, ...rest) {
      events.push(`sql:${String(typeof text === 'string' ? text : (text && text.text) || '').replace(/\s+/g, ' ').trim()}`);
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

const { adminWriteLimiter, menuDraftReadLimiter, beoReadLimiter } = require('../../middleware/rateLimiters');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const releaseRouter = require('./menuDraftRelease');
const menuDraftsRouter = require('./menuDrafts');
const menuPrintRouter = require('./menuPrint');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const users = {};
const tokens = {};
const proposalIds = [];
let server;
let baseUrl;
let todayYmd;

function request(method, urlPath, { token = tokens.admin, json } = {}) {
  return (async () => {
    for (const uid of Object.values(users)) {
      await adminWriteLimiter.resetKey(`admin-${uid}`);
      await menuDraftReadLimiter.resetKey(`menudraft-r-${uid}`);
      await beoReadLimiter.resetKey(`beo-${uid}`);
    }
    return new Promise((resolve, reject) => {
      const u = new URL(baseUrl + urlPath);
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      let payload = null;
      if (json !== undefined) {
        payload = Buffer.from(JSON.stringify(json));
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
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
  })();
}

const base = (id) => `/api/proposals/${id}/menu-draft`;
// What a page loaded now shows of the draft's latest proof (seen_proof_id and
// seen_proof_answer, empty for none), which a release posts unless the body names its own.
async function seenNow(ev) {
  const { rows: [p] } = await pool.query(
    'SELECT id, answer FROM menu_proofs WHERE draft_id = $1 AND superseded_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1', [ev.draftId]);
  return { seen_proof_id: p ? p.id : '', seen_proof_answer: p && p.answer ? p.answer : '' };
}
const release = async (ev, body = { version: 4, art_version: 2 }, token) => {
  const json = body && typeof body === 'object' && !('seen_proof_id' in body) && !('seen_proof_answer' in body) ? { ...(await seenNow(ev)), ...body } : body;
  return request('POST', `${base(ev.id)}/release`, { json, token });
};
const close = (ev, body, token) => request('POST', `${base(ev.id)}/proof/close`, { json: body, token });
// Remove on the print file, naming the file a page loaded now shows (the live key).
const removeFile = async (ev) => request('DELETE', `/api/proposals/${ev.id}/menu-print`,
  { json: { expected_print_key: (await keyRow(ev.id)).menu_print_key || '' } });
const getDraft = async (id) => (await request('GET', base(id))).body;

async function idle() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
    await Promise.allSettled([...accrualSeen.map((a) => a.seen), ...reaccrued.map((r) => r.seen)]);
  }
}

// An event offset days out (or undated) whose draft (4/2) is approved at 4/2
// holding its own key, with a proof of that pair (answer as given), unless the
// options say otherwise.
async function newEvent({ offset = 10, noDate = false, approve = true, proof = true, answer = null, printKey = null, marked = false, released = null } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, event_type, event_date, menu_not_required)
     VALUES ('confirmed', 'corporate', CASE WHEN $1::boolean THEN NULL ELSE $2::date + $3::int END, $4) RETURNING id`,
    [noDate, todayYmd, offset, marked]);
  proposalIds.push(p.id);
  const held = `menu-print/${p.id}/held-${NONCE}.jpg`;
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, version, art_version,
                              approved_version, approved_art_version, approved_print_key, approved_at, approved_by,
                              released_print_key, released_at, released_via)
     VALUES ($1, gen_random_uuid(), '{}', '{"words_status":"done"}', '{}', 4, 2,
             CASE WHEN $2::boolean THEN 4 END, CASE WHEN $2::boolean THEN 2 END, CASE WHEN $2::boolean THEN $3 END,
             CASE WHEN $2::boolean THEN NOW() END, CASE WHEN $2::boolean THEN $4::int END,
             $5, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() - INTERVAL '1 day' END, CASE WHEN $5::text IS NULL THEN NULL ELSE 'admin' END)
     RETURNING id`, [p.id, approve, held, users.admin, released]);
  if (printKey) await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [p.id, printKey]);
  let proofId = null;
  if (proof) {
    proofId = (await pool.query(
      `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, answer, answer_note, answered_at)
       VALUES ($1, $2, 4, 2, $3, 'sent', $4, $5, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [d.id, p.id, `menu-proof/${p.id}/${crypto.randomUUID()}.jpg`, answer, answer === 'changes' ? 'Change the title, please' : null])).rows[0].id;
  }
  return { id: p.id, draftId: d.id, held, proofId };
}

const draftOf = async (id) => (await pool.query('SELECT * FROM menu_drafts WHERE proposal_id = $1', [id])).rows[0];
const activityOf = async (id) => (await pool.query(
  `SELECT action, actor_type, actor_id, details FROM proposal_activity_log
    WHERE proposal_id = $1 AND action IN ('menu_released', 'menu_proof_closed') ORDER BY id`, [id])).rows;

async function assertNothingMoved(ev, { printKey = null, marked = false } = {}) {
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: printKey, menu_not_required: marked });
  assert.deepEqual(await activityOf(ev.id), []);
  await idle();
  assert.deepEqual(reaccrued, [], 'no reaccrual');
}

// A live $5 menu_print duty line on the event, as an accrual leaves one: a
// shift, the staff user's payout in a long-past pay period (found, or made
// here and removed after; one that stood already is never altered), the line.
const duty = { periodId: null, madePeriod: false, payoutId: null, shiftIds: [] };
async function standDutyLine(ev) {
  if (!duty.periodId) {
    const found = await pool.query("SELECT id FROM pay_periods WHERE start_date = '2001-01-01'");
    if (found.rows[0]) duty.periodId = found.rows[0].id;
    else {
      duty.periodId = (await pool.query(
        "INSERT INTO pay_periods (start_date, end_date, payday) VALUES ('2001-01-01', '2001-01-14', '2001-01-19') RETURNING id")).rows[0].id;
      duty.madePeriod = true;
    }
    duty.payoutId = (await pool.query('INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2) RETURNING id',
      [duty.periodId, users.staff])).rows[0].id;
  }
  const shiftId = (await pool.query(
    "INSERT INTO shifts (event_date, start_time, status, proposal_id) VALUES ($1, '6:00 PM', 'open', $2) RETURNING id",
    [todayYmd, ev.id])).rows[0].id;
  duty.shiftIds.push(shiftId);
  await pool.query(
    "INSERT INTO payout_duty_lines (payout_id, contractor_id, shift_id, kind, amount_cents) VALUES ($1, $2, $3, 'menu_print', 500)",
    [duty.payoutId, users.staff, shiftId]);
}

async function dropDutyFixtures() {
  if (duty.payoutId) {
    await pool.query('DELETE FROM payout_duty_lines WHERE payout_id = $1', [duty.payoutId]);
    await pool.query('DELETE FROM payouts WHERE id = $1', [duty.payoutId]);
  }
  if (duty.shiftIds.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [duty.shiftIds]);
  if (duty.madePeriod) {
    await pool.query('DELETE FROM pay_periods WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)', [duty.periodId]);
  }
}

before(async () => {
  todayYmd = chicagoTodayYmd();
  const hash = await bcrypt.hash('x', 4);
  for (const role of ['admin', 'manager', 'staff']) {
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, $2, $3, 'approved', 0) RETURNING id`, [`menurelease-route-${role}-${NONCE}@example.com`, hash, role]);
    users[role] = r.rows[0].id;
    tokens[role] = jwt.sign({ userId: users[role], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', menuPrintRouter);
  app.use('/api/proposals', menuDraftsRouter);
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
  __setLegalHoldIdsForTest(null);
  sentryModule.captureException = savedCapture;
  await dropDutyFixtures();
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  const userIds = Object.values(users);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await new Promise((resolve) => { server.close(resolve); });
  pool.connect = realConnect;
  await pool.end();
  inboxCache.invalidate = realInvalidate;
  require.cache[storagePath].exports = realStorage;
  require.cache[printFilePath].exports = realPrintFile;
  if (savedAccrual) require.cache[accrualPath] = savedAccrual;
  else delete require.cache[accrualPath];
});

beforeEach(() => {
  accrue = SKIPPED;
  for (const list of [events, reaccrued, accrualSeen, captured]) list.length = 0;
});
afterEach(async () => { await idle(); });

// ── Release for printing ────────────────────────────────────────────────────

test('release: auth is required, staff is refused, and a manager releases', async () => {
  const ev = await newEvent();
  assert.equal((await release(ev, undefined, null)).status, 401);
  assert.equal((await release(ev, undefined, tokens.staff)).status, 403);
  await assertNothingMoved(ev);
  const res = await release(ev, undefined, tokens.manager);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await draftOf(ev.id)).released_by, users.manager);
});

test('release: posts the held key, stamps the release, fires reaccrueDuty once after COMMIT and release, clears the Inbox cache, answers the GET\'s blocks', async () => {
  const ev = await newEvent();
  const res = await release(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await keyRow(ev.id), { menu_print_key: ev.held, menu_not_required: false });
  const d = await draftOf(ev.id);
  assert.deepEqual([d.released_print_key, d.released_by, d.released_via], [ev.held, users.admin, 'admin']);
  assert.deepEqual(await activityOf(ev.id), [
    { action: 'menu_released', actor_type: 'admin', actor_id: users.admin, details: { draft_id: ev.draftId, version: 4, art_version: 2, via: 'admin' } },
  ]);
  const at = (pred) => events.findIndex(pred);
  const commit = at((e) => e === 'sql:COMMIT');
  const rel = at((e) => e === 'release');
  const reacc = at((e) => e === `reaccrue:${ev.id}`);
  const inv = at((e) => e === 'invalidate');
  assert.ok(commit >= 0 && commit < rel && rel < reacc && reacc < inv, JSON.stringify(events));
  assert.equal(events.filter((e) => e.startsWith('reaccrue:')).length, 1);
  await idle();
  assert.deepEqual(await reaccrued[0].seen, { menu_print_key: ev.held, menu_not_required: false }, 'the accrual reads the committed key');
  const get = await getDraft(ev.id);
  assert.deepEqual(res.body, { proof: get.proof, print: get.print });
  assert.deepEqual([res.body.print.state, res.body.print.released_via, res.body.print.held], ['approved', 'admin', false]);
});

test('release: a second release is 409 MENU_NOT_HELD, as is a draft never approved', async () => {
  const ev = await newEvent();
  assert.equal((await release(ev)).status, 200);
  events.length = 0;
  reaccrued.length = 0;
  const again = await release(ev);
  assert.deepEqual([again.status, again.body.code], [409, 'MENU_NOT_HELD']);
  assert.equal(reaccrued.length, 0);
  const never = await newEvent({ approve: false, proof: false });
  const res = await release(never);
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_NOT_HELD']);
  await assertNothingMoved(never);
});

test('release: the pair the page saw must be the approved one, else 409 MENU_DRAFT_CHANGED', async () => {
  const ev = await newEvent();
  for (const body of [{ version: 3, art_version: 2 }, { version: 4, art_version: 1 }]) {
    const res = await release(ev, body);
    assert.deepEqual([res.status, res.body.code], [409, 'MENU_DRAFT_CHANGED'], JSON.stringify(body));
  }
  await assertNothingMoved(ev);
});

test('release: the body rules, a 400 before anything is read', async () => {
  const ev = await newEvent();
  for (const body of [{}, { version: '4', art_version: 2 }, { version: 4 }, { version: 4, art_version: -1 }, { version: 4, art_version: 2, after_event: 'yes' }]) {
    const res = await release(ev, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  // What the page saw of the latest proof: an integer id or empty, an answer or empty, both required.
  const pair = { version: 4, art_version: 2 };
  for (const [seen, field] of [
    [{ seen_proof_answer: '' }, 'seen_proof_id'], [{ seen_proof_id: ev.proofId }, 'seen_proof_answer'],
    [{ seen_proof_id: String(ev.proofId), seen_proof_answer: '' }, 'seen_proof_id'], [{ seen_proof_id: 0, seen_proof_answer: '' }, 'seen_proof_id'],
    [{ seen_proof_id: ev.proofId, seen_proof_answer: 'maybe' }, 'seen_proof_answer'],
  ]) {
    const res = await release(ev, { ...pair, ...seen });
    assert.equal(res.status, 400, JSON.stringify(seen));
    assert.ok(res.body.fieldErrors[field], `${field} named for ${JSON.stringify(seen)}`);
  }
  await assertNothingMoved(ev);
});

// A page loaded before the client answered must not act over that answer (it does not poll).
test('release: 409 MENU_PROOF_CHANGED when the latest proof is not what the page saw; nothing moves', async () => {
  const changed = "The client's review changed. Refresh to see it.";
  const ev = await newEvent();
  const stale = { version: 4, art_version: 2, seen_proof_id: ev.proofId, seen_proof_answer: '' };
  await pool.query("UPDATE menu_proofs SET answer = 'changes', answer_note = 'More gin', answered_at = NOW() WHERE id = $1", [ev.proofId]);
  const res = await release(ev, stale);
  assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MENU_PROOF_CHANGED', changed]);
  for (const seen of [{ seen_proof_id: '', seen_proof_answer: '' }, { seen_proof_id: null, seen_proof_answer: null },
    { seen_proof_id: ev.proofId + 1000, seen_proof_answer: 'changes' }, { seen_proof_id: ev.proofId, seen_proof_answer: 'approved' }]) {
    const r = await release(ev, { version: 4, art_version: 2, ...seen });
    assert.deepEqual([r.status, r.body.code], [409, 'MENU_PROOF_CHANGED'], JSON.stringify(seen));
  }
  await assertNothingMoved(ev);
  const { rows: [p] } = await pool.query('SELECT withdrawn_at, answer FROM menu_proofs WHERE id = $1', [ev.proofId]);
  assert.deepEqual([p.withdrawn_at, p.answer], [null, 'changes'], 'the change request stands, its Inbox task open');
  // The page that saw the change request releases knowingly.
  const ok = await release(ev, { version: 4, art_version: 2, seen_proof_id: ev.proofId, seen_proof_answer: 'changes' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A page that showed no proof is refused once one exists; with none it may act (empty, or null).
  const none = await newEvent({ proof: false, released: `menu-print/0/r-${NONCE}.jpg` });
  const back = await release(none, { version: 4, art_version: 2, seen_proof_id: null, seen_proof_answer: '' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
});

test('put it back: refused over a proof answer the page never saw', async () => {
  const ev = await newEvent();
  assert.equal((await release(ev)).status, 200);
  assert.equal((await removeFile(ev)).status, 200);
  const res = await release(ev, { version: 4, art_version: 2, seen_proof_id: '', seen_proof_answer: '' });
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_PROOF_CHANGED']);
  assert.equal((await keyRow(ev.id)).menu_print_key, null, 'still removed');
});

test('release: the mark is 409 MENU_MARKED_NONE and stays; an admin upload is 409 MENU_PRINT_CHANGED and stays', async () => {
  const marked = await newEvent({ marked: true });
  const m = await release(marked);
  assert.deepEqual([m.status, m.body.code, m.body.error], [409, 'MENU_MARKED_NONE', 'This event is marked as needing no printed menu. Clear the mark first.']);
  await assertNothingMoved(marked, { marked: true });
  const upload = `menu-print/0/upload-${NONCE}.pdf`;
  const up = await newEvent({ printKey: upload });
  const u = await release(up);
  assert.deepEqual([u.status, u.body.code, u.body.error], [409, 'MENU_PRINT_CHANGED', 'A different print file is live now. Refresh to see it.']);
  await assertNothingMoved(up, { printKey: upload });
});

test('release after the event day: 409 MENU_EVENT_PASSED without after_event, released with it', async () => {
  const ev = await newEvent({ offset: -2 });
  const res = await release(ev);
  assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MENU_EVENT_PASSED',
    'This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.']);
  await assertNothingMoved(ev);
  events.length = 0;
  const ok = await release(ev, { version: 4, art_version: 2, after_event: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await keyRow(ev.id)).menu_print_key, ev.held);
  // The re-accrual is awaited, after COMMIT and the client's release, reading the committed key.
  assert.equal(accrualSeen.length, 1, 'the after-event release re-accrues the duty once');
  assert.deepEqual(await accrualSeen[0].seen, { menu_print_key: ev.held, menu_not_required: false });
  assert.deepEqual(reaccrued, [], 'not the fire-and-forget call');
  const at = (pred) => events.findIndex(pred);
  assert.ok(at((e) => e === 'sql:COMMIT') < at((e) => e === 'release') && at((e) => e === 'release') < at((e) => e === `accrue:${ev.id}`),
    JSON.stringify(events));
  assert.ok(events.includes('invalidate'));
  const get = await getDraft(ev.id);
  assert.deepEqual(ok.body, { proof: get.proof, print: get.print, duty: 'pending' }, 'a confirmed event: the completion job adds it');
});

// What the awaited re-accrual left (spec 2026-10-19 section 10.3, the after-event confirm), as the 200's duty.
test('after_event: duty says what happened to the $5 print duty', async () => {
  const outcome = async ({ answer, status = 'confirmed', line = false, offset = -2 }) => {
    const ev = await newEvent({ offset });
    if (status !== 'confirmed') await pool.query('UPDATE proposals SET status = $2 WHERE id = $1', [ev.id, status]);
    if (line) await standDutyLine(ev);
    accrue = answer;
    const res = await release(ev, { version: 4, art_version: 2, after_event: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.duty;
  };
  assert.equal(await outcome({ answer: async () => ({ skipped: false, accrued: 1 }), status: 'completed', line: true }), 'added');
  // A line that stood already (an earlier file's) is the duty the new key keeps.
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'pay_period_not_open' }), status: 'completed', line: true }), 'added');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'not_recent_completed' }) }), 'pending');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'not_recent_completed' }), offset: 30 }), 'pending',
    'after_event at any distance: a future event is not completed yet');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'not_recent_completed' }), status: 'completed', offset: -40 }), 'not_added',
    'more than 21 days back');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'pay_period_not_open' }), status: 'completed' }), 'not_added');
  // The accrual ran and wrote no menu_print line (no one attributed, not paid in full, no bartender), or will never run.
  assert.equal(await outcome({ answer: async () => ({ skipped: false, accrued: 1 }), status: 'completed' }), 'check_payroll');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'no_approved_workers' }), status: 'completed' }), 'check_payroll');
  assert.equal(await outcome({ answer: async () => ({ skipped: true, reason: 'not_recent_completed' }), status: 'archived' }), 'check_payroll');
  assert.deepEqual(captured, [], 'nothing went to Sentry');
});

// A throw says nothing of the pay period, so it never reads as a closed one.
test('after_event: an accrual that throws is check_payroll, with a fixed Sentry line carrying the proposal id only; the release stands', async () => {
  const ev = await newEvent({ offset: -2 });
  accrue = async () => { throw new Error('payroll exploded with internal details'); };
  const res = await release(ev, { version: 4, art_version: 2, after_event: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.duty, 'check_payroll');
  assert.equal((await keyRow(ev.id)).menu_print_key, ev.held, 'released');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message, 'menu release duty re-accrual failed');
  assert.deepEqual(captured[0].ctx.extra, { proposal_id: ev.id });
  assert.ok(!JSON.stringify(captured).includes('exploded'), 'the accrual error never reaches Sentry');
});

test('put it back after the event day carries duty too; a release without after_event fires the re-accrual and carries none', async () => {
  const ev = await newEvent({ offset: -2 });
  assert.equal((await release(ev, { version: 4, art_version: 2, after_event: true })).status, 200);
  assert.equal((await removeFile(ev)).status, 200);
  await idle();
  for (const list of [events, reaccrued, accrualSeen]) list.length = 0;
  accrue = async () => ({ skipped: true, reason: 'pay_period_not_open' });
  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [ev.id]);
  const back = await release(ev, { version: 4, art_version: 2, after_event: true });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.duty, 'not_added');
  assert.equal(back.body.print.state, 'approved');
  assert.deepEqual(reaccrued, []);
  const plain = await newEvent();
  const res = await release(plain);
  assert.equal(res.status, 200);
  assert.ok(!('duty' in res.body));
  await idle();
  assert.equal(reaccrued.length, 1, 'the fire-and-forget call, as before');
});

test('release and close: the legal-hold proposal is 409 LEGAL_HOLD before anything is read; nothing moves', async () => {
  const ev = await newEvent({ answer: 'changes' });
  __setLegalHoldIdsForTest([ev.id]);
  try {
    const r = await release(ev);
    assert.deepEqual([r.status, r.body.code], [409, 'LEGAL_HOLD']);
    const c = await close(ev, { proof_id: ev.proofId });
    assert.deepEqual([c.status, c.body.code], [409, 'LEGAL_HOLD']);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  assert.deepEqual(events.filter((e) => e === 'connect'), [], 'no transaction opened');
  await assertNothingMoved(ev);
  const { rows: [p] } = await pool.query('SELECT withdrawn_at FROM menu_proofs WHERE id = $1', [ev.proofId]);
  assert.equal(p.withdrawn_at, null);
});

// ── Put it back for staff ───────────────────────────────────────────────────

test('put it back: the menu\'s own released file, removed, goes back for staff through the same route', async () => {
  const ev = await newEvent();
  assert.equal((await release(ev)).status, 200);
  assert.equal((await removeFile(ev)).status, 200);
  const removed = await getDraft(ev.id);
  assert.deepEqual([removed.print.state, removed.print.restorable], ['removed', true]);
  reaccrued.length = 0;
  const res = await release(ev);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await keyRow(ev.id)).menu_print_key, ev.held);
  assert.equal(res.body.print.state, 'approved');
  assert.equal(reaccrued.length, 1);
  const log = await activityOf(ev.id);
  assert.deepEqual(log.map((l) => l.details.restored || false), [false, true]);
});

test('put it back: never for a file that was not the menu\'s own (an upload removed) or with nothing released', async () => {
  const ev = await newEvent({ proof: false, approve: false, printKey: `menu-print/0/u-${NONCE}.pdf` });
  assert.equal((await removeFile(ev)).status, 200);
  reaccrued.length = 0;
  const res = await release(ev, { version: 4, art_version: 2 });
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_NOT_HELD']);
  await assertNothingMoved(ev);
});

// ── Close request ───────────────────────────────────────────────────────────

// A change request made after the file was released: nothing is held.
async function releasedThenChanges() {
  const ev = await newEvent({ answer: 'changes' });
  await pool.query('UPDATE menu_drafts SET released_print_key = approved_print_key, released_at = NOW() WHERE id = $1', [ev.draftId]);
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [ev.id, ev.held]);
  return ev;
}

test('close: withdraws the change request on a released menu, writes the activity row, clears the Inbox cache, leaves the file live', async () => {
  const ev = await releasedThenChanges();
  const res = await close(ev, { proof_id: ev.proofId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows: [p] } = await pool.query('SELECT withdrawn_at, answer, answer_note FROM menu_proofs WHERE id = $1', [ev.proofId]);
  assert.ok(p.withdrawn_at instanceof Date);
  assert.equal(p.answer, 'changes', 'the answer stands');
  assert.deepEqual(await activityOf(ev.id), [
    { action: 'menu_proof_closed', actor_type: 'admin', actor_id: users.admin, details: { proof_id: ev.proofId, draft_id: ev.draftId } },
  ]);
  assert.ok(!JSON.stringify(await activityOf(ev.id)).includes('title'), 'the note never enters the activity row');
  assert.equal((await keyRow(ev.id)).menu_print_key, ev.held, 'the released file stays live for staff');
  assert.ok(events.includes('invalidate'));
  await idle();
  assert.deepEqual(reaccrued, [], 'the key did not move, so no reaccrual');
  assert.deepEqual([res.body.proof.state, res.body.print.state], ['withdrawn', 'approved']);
  const get = await getDraft(ev.id);
  assert.deepEqual(res.body, { proof: get.proof, print: get.print });
});

test('close: 409 MENU_PROOF_CHANGED unless the posted proof is the latest, answered changes, not withdrawn, and nothing is held', async () => {
  const held = await newEvent({ answer: 'changes' });
  const h = await close(held, { proof_id: held.proofId });
  assert.deepEqual([h.status, h.body.code], [409, 'MENU_PROOF_CHANGED'], 'while the file is held, Release or approving again closes it');
  const open = await releasedThenChanges();
  await pool.query('UPDATE menu_proofs SET answer = NULL, answer_note = NULL, answered_at = NULL WHERE id = $1', [open.proofId]);
  assert.equal((await close(open, { proof_id: open.proofId })).body.code, 'MENU_PROOF_CHANGED', 'no change request');
  const twice = await releasedThenChanges();
  assert.equal((await close(twice, { proof_id: twice.proofId })).status, 200);
  assert.equal((await close(twice, { proof_id: twice.proofId })).body.code, 'MENU_PROOF_CHANGED', 'already closed');
  const older = await releasedThenChanges();
  await pool.query('UPDATE menu_proofs SET superseded_at = NOW() WHERE id = $1', [older.proofId]);
  const { rows: [n] } = await pool.query(
    `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, answer, answer_note, answered_at)
     VALUES ($1, $2, 4, 2, 'menu-proof/0/n.jpg', 'sent', 'changes', 'newer', NOW()) RETURNING id`, [older.draftId, older.id]);
  assert.equal((await close(older, { proof_id: older.proofId })).body.code, 'MENU_PROOF_CHANGED', 'not the latest');
  assert.equal((await close(older, { proof_id: n.id + 1000 })).body.code, 'MENU_PROOF_CHANGED', 'another proof');
  for (const ev of [held, open, older]) assert.deepEqual(await activityOf(ev.id), []);
  for (const body of [{}, { proof_id: '5' }, { proof_id: 0 }]) assert.equal((await close(older, body)).status, 400, JSON.stringify(body));
});
