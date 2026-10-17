process.env.NODE_ENV = 'test';
require('dotenv').config();
// menuArtCap.js (spec 2026-10-01 section 5.5, Daily cap, Superseded runs,
// End-of-run sweep). Live on the shared dev DB. The cap counts the ledger
// GLOBALLY, so no test assumes an empty table: each reads the current count and
// sets the cap env relative to it. Every row is cleaned up by the run ids and
// row ids this suite recorded, never by a pattern.
//
// Run: node --test server/utils/menuArtCap.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const cap = require('./menuArtCap');
const { AppError } = require('./errors');

const runs = new Set();
const rowIds = new Set();
let proposalId = null;
let draftId = null;
let draftRun = null;
const ENV_KEYS = ['MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const newRun = () => { const id = crypto.randomUUID(); runs.add(id); return id; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function openCount(kind) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM menu_art_calls
      WHERE kind = $1 AND status <> 'released' AND created_at > NOW() - interval '24 hours'`, [kind]);
  return rows[0].n;
}

async function rowsOf(runId) {
  const { rows } = await pool.query(
    'SELECT id, piece_key, kind, status, provider, model, error, provider_request_id, size FROM menu_art_calls WHERE run_id = $1 ORDER BY id',
    [runId]);
  for (const r of rows) rowIds.add(r.id);
  return rows;
}

// One reserving transaction, the way the routes run it: lockCalls first.
async function inTx(fn, { lock = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (lock) await cap.lockCalls(client);
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

const reserve = (runId, keys, extra = {}) => inTx((c) => cap.reserveImages(c, {
  proposalId, runId, pieceKeys: keys, provider: 'openai', model: 'test-image-model', ...extra,
}));

async function setImageCapHeadroom(n) {
  process.env.MENU_ART_DAILY_IMAGE_CAP = String((await openCount('image')) + n);
}

before(async () => {
  const p = await pool.query("INSERT INTO proposals (status) VALUES ('draft') RETURNING id");
  proposalId = p.rows[0].id;
  draftRun = newRun();
  const d = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, $2, '{}', '{}', '{}') RETURNING id`, [proposalId, draftRun]);
  draftId = d.rows[0].id;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

after(async () => {
  await pool.query('DELETE FROM menu_art_calls WHERE run_id = ANY($1::uuid[]) OR id = ANY($2::int[])',
    [[...runs], [...rowIds]]);
  if (draftId) await pool.query('DELETE FROM menu_drafts WHERE id = $1', [draftId]);
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.end();
});

test('a reservation counts: one reserved row per key, stamped with provider and model', async () => {
  await setImageCapHeadroom(5);
  const before0 = await cap.capUsage();
  const runId = newRun();
  const ids = await reserve(runId, ['background', 'cocktail:margarita', 'background'], { provider: 'gemini', model: 'g-model' });
  assert.deepEqual(Object.keys(ids).sort(), ['background', 'cocktail:margarita']);
  const rows = await rowsOf(runId);
  assert.equal(rows.length, 2, 'a repeated key reserves once');
  for (const r of rows) {
    assert.deepEqual([r.kind, r.status, r.provider, r.model], ['image', 'reserved', 'gemini', 'g-model']);
    assert.equal(ids[r.piece_key], r.id);
  }
  assert.equal((await cap.capUsage()).used, before0.used + 2);
});

test('a refusal at the cap is a 429 MENU_ART_CAP_REACHED and writes nothing', async () => {
  await setImageCapHeadroom(1);
  const runId = newRun();
  await assert.rejects(reserve(runId, ['background', 'custom:x']), (err) => {
    assert.ok(err instanceof AppError);
    assert.deepEqual([err.statusCode, err.code, err.message], [429, 'MENU_ART_CAP_REACHED', 'Daily menu art limit reached.']);
    return true;
  });
  assert.equal((await rowsOf(runId)).length, 0);
});

test('reserving without lockCalls first throws and inserts nothing', async () => {
  await setImageCapHeadroom(5);
  const runId = newRun();
  await assert.rejects(
    inTx((c) => cap.reserveImages(c, { proposalId, runId, pieceKeys: ['background'], provider: 'openai' }), { lock: false }),
    /lockCalls/);
  await assert.rejects(inTx((c) => cap.reserveText(c, { proposalId, runId }), { lock: false }), /lockCalls/);
  assert.equal((await rowsOf(runId)).length, 0);
});

test('requireImageHeadroom: a 429 when that many more images would pass the cap, reserving nothing; it needs the lock', async () => {
  await setImageCapHeadroom(2);
  const before = await openCount('image');
  await inTx((c) => cap.requireImageHeadroom(c, 2));
  await inTx((c) => cap.requireImageHeadroom(c, 0));
  await assert.rejects(inTx((c) => cap.requireImageHeadroom(c, 3)),
    (err) => err instanceof AppError && err.statusCode === 429 && err.code === 'MENU_ART_CAP_REACHED');
  await assert.rejects(inTx((c) => cap.requireImageHeadroom(c, 1), { lock: false }), /lockCalls/);
  assert.equal(await openCount('image'), before, 'nothing was reserved');
});

test('released rows do not count', async () => {
  await setImageCapHeadroom(1);
  const first = newRun();
  await reserve(first, ['background']);
  await assert.rejects(reserve(newRun(), ['background']), { code: 'MENU_ART_CAP_REACHED' });
  const released = await inTx((c) => cap.releaseReserved(c, { proposalId, runId: first }));
  assert.equal(released, 1);
  const second = newRun();
  await reserve(second, ['background']);
  assert.equal((await rowsOf(second))[0].status, 'reserved');
});

test('two concurrent reserving transactions at cap minus one: exactly one succeeds', async () => {
  await setImageCapHeadroom(1);
  const a = newRun();
  const b = newRun();
  // Each holds its transaction open a moment after reserving, so without the
  // table lock both counts would read the same number and both would insert.
  const attempt = (runId) => inTx(async (c) => {
    const ids = await cap.reserveImages(c, { proposalId, runId, pieceKeys: ['background'], provider: 'openai' });
    await sleep(200);
    return ids;
  });
  const results = await Promise.allSettled([attempt(a), attempt(b)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'MENU_ART_CAP_REACHED');
  assert.equal((await rowsOf(a)).length + (await rowsOf(b)).length, 1);
});

test('authorizeCall: true exactly once, false for an already-sent row and for a superseded run', async () => {
  await setImageCapHeadroom(5);
  const ids = await reserve(draftRun, ['background', 'cocktail:paloma']);
  const twice = await Promise.all([
    cap.authorizeCall(ids.background, { draftId, runId: draftRun }),
    cap.authorizeCall(ids.background, { draftId, runId: draftRun }),
  ]);
  assert.deepEqual(twice.sort(), [false, true], 'two racing authorizes: exactly one wins');
  assert.equal(await cap.authorizeCall(ids.background, { draftId, runId: draftRun }), false, 'already sent');
  // The caller claiming a different run than the row's never authorizes.
  assert.equal(await cap.authorizeCall(ids['cocktail:paloma'], { draftId, runId: newRun() }), false);
  // Generate moves the draft to a new run: the old run's reservation is dead.
  const next = newRun();
  await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, next]);
  try {
    assert.equal(await cap.authorizeCall(ids['cocktail:paloma'], { draftId, runId: draftRun }), false, 'superseded');
    const rows = await rowsOf(draftRun);
    assert.deepEqual(rows.map((r) => r.status), ['sent', 'reserved']);
  } finally {
    await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, draftRun]);
  }
});

test('authorizeCall for a piece run matches the piece row, and a NULL run never authorizes', async () => {
  await setImageCapHeadroom(5);
  const pieceRun = newRun();
  await pool.query(
    `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, provider, model)
     VALUES ($1, 'custom:test-fizz', $2, 'pending', 'openai', 'm')`, [draftId, pieceRun]);
  try {
    const ids = await reserve(pieceRun, ['custom:test-fizz', 'custom:other']);
    // The draft's run is not this run, so only the piece check can pass it.
    assert.equal(await cap.authorizeCall(ids['custom:test-fizz'], { draftId, runId: pieceRun }), false);
    assert.equal(await cap.authorizeCall(ids['custom:other'], { draftId, pieceRunId: pieceRun }), false, 'no such piece row');
    assert.equal(await cap.authorizeCall(ids['custom:test-fizz'], { draftId, pieceRunId: pieceRun }), true);
    const again = await reserve(pieceRun, ['custom:test-fizz']);
    await pool.query("UPDATE menu_draft_pieces SET run_id = $2 WHERE draft_id = $1 AND piece_key = 'custom:test-fizz'",
      [draftId, newRun()]);
    assert.equal(await cap.authorizeCall(again['custom:test-fizz'], { draftId, pieceRunId: pieceRun }), false, 're-rolled again');

    const { rows: [nullRow] } = await pool.query(
      `INSERT INTO menu_art_calls (proposal_id, piece_key, run_id, kind, status, provider)
       VALUES ($1, 'background', NULL, 'image', 'reserved', 'openai') RETURNING id`, [proposalId]);
    rowIds.add(nullRow.id);
    assert.equal(await cap.authorizeCall(nullRow.id, { draftId, runId: null }), false);
    assert.equal(await cap.authorizeCall(nullRow.id, { draftId, runId: draftRun }), false);
    assert.equal(await cap.authorizeCall(nullRow.id, { draftId, pieceRunId: pieceRun }), false);
  } finally {
    await pool.query("DELETE FROM menu_draft_pieces WHERE draft_id = $1 AND piece_key = 'custom:test-fizz'", [draftId]);
  }
});

test('settleRun releases a reserved row and fails (does not release) a sent row, which still counts', async () => {
  await setImageCapHeadroom(5);
  const runId = newRun();
  await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, runId]);
  try {
    const ids = await reserve(runId, ['background', 'cocktail:margarita']);
    const textId = await inTx((c) => cap.reserveText(c, { proposalId, runId }));
    assert.equal(await cap.authorizeCall(ids.background, { draftId, runId }), true);
    const usedBefore = (await cap.capUsage()).used;
    assert.deepEqual(await cap.settleRun({ runId }), { released: 2, failed: 1 });
    const byId = new Map((await rowsOf(runId)).map((r) => [r.id, r.status]));
    assert.equal(byId.get(ids.background), 'failed');
    assert.equal(byId.get(ids['cocktail:margarita']), 'released');
    assert.equal(byId.get(textId), 'released');
    assert.equal((await cap.capUsage()).used, usedBefore - 1, 'only the never-sent image stops counting');
    assert.deepEqual(await cap.settleRun({ runId }), { released: 0, failed: 0 }, 'settled rows stay settled');
  } finally {
    await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, draftRun]);
  }
});

test('settleRun with pieceKeys settles only those pieces, never the run text row', async () => {
  await setImageCapHeadroom(5);
  const runId = newRun();
  await reserve(runId, ['custom:a', 'custom:b']);
  const textId = await inTx((c) => cap.reserveText(c, { proposalId, runId }));
  assert.deepEqual(await cap.settleRun({ runId, pieceKeys: ['custom:a'] }), { released: 1, failed: 0 });
  const rows = await rowsOf(runId);
  assert.deepEqual(rows.map((r) => [r.piece_key, r.status]),
    [['custom:a', 'released'], ['custom:b', 'reserved'], [null, 'reserved']]);
  assert.equal(rows[2].id, textId);
});

test('releaseReserved releases only the old run reserved rows; releaseProposalReserved frees every stranded one', async () => {
  await setImageCapHeadroom(5);
  const oldRun = newRun();
  const otherRun = newRun();
  await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, oldRun]);
  try {
    const ids = await reserve(oldRun, ['background', 'custom:a']);
    await reserve(otherRun, ['custom:z']);
    assert.equal(await cap.authorizeCall(ids.background, { draftId, runId: oldRun }), true);
    const released = await inTx((c) => cap.releaseReserved(c, { proposalId, runId: oldRun }));
    assert.equal(released, 1);
    assert.deepEqual((await rowsOf(oldRun)).map((r) => r.status), ['sent', 'released']);
    assert.deepEqual((await rowsOf(otherRun)).map((r) => r.status), ['reserved'], 'another run is untouched');
    const stranded = await inTx((c) => cap.releaseProposalReserved(c, { proposalId }));
    assert.ok(stranded >= 1);
    assert.deepEqual((await rowsOf(otherRun)).map((r) => r.status), ['released']);
    assert.deepEqual((await rowsOf(oldRun)).map((r) => r.status), ['sent', 'released'], 'sent stays sent');
    await assert.rejects(inTx((c) => cap.releaseReserved(c, { proposalId, runId: oldRun }), { lock: false }), /lockCalls/);
  } finally {
    await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, draftRun]);
  }
});

test('releasePieceReserved frees the reserved image rows of those pieces only, whatever their run', async () => {
  await setImageCapHeadroom(5);
  const runA = newRun();
  const runB = newRun();
  await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, runA]);
  try {
    const a = await reserve(runA, ['background', 'custom:a', 'custom:b']);
    await reserve(runB, ['custom:a']);
    assert.equal(await cap.authorizeCall(a['custom:b'], { draftId, runId: runA }), true);
    const released = await inTx((c) => cap.releasePieceReserved(c, { proposalId, pieceKeys: ['custom:a', 'custom:b'] }));
    assert.equal(released, 2, 'custom:a on both runs; custom:b is sent and stays sent');
    const statusOf = async (runId) => Object.fromEntries((await rowsOf(runId)).map((r) => [r.piece_key, r.status]));
    assert.deepEqual(await statusOf(runA), { background: 'reserved', 'custom:a': 'released', 'custom:b': 'sent' });
    assert.deepEqual(await statusOf(runB), { 'custom:a': 'released' });
    assert.equal(await inTx((c) => cap.releasePieceReserved(c, { proposalId, pieceKeys: [] })), 0);
    await assert.rejects(inTx((c) => cap.releasePieceReserved(c, { proposalId, pieceKeys: ['background'] }), { lock: false }), /lockCalls/);
  } finally {
    await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, draftRun]);
  }
});

test('the text cap refuses at its limit and does not count image rows', async () => {
  process.env.MENU_ART_DAILY_TEXT_CAP = String((await openCount('text')) + 1);
  await setImageCapHeadroom(1);
  const runId = newRun();
  const textId = await inTx((c) => cap.reserveText(c, { proposalId, runId, model: 'text-model' }));
  await assert.rejects(inTx((c) => cap.reserveText(c, { proposalId, runId })), (err) => {
    assert.deepEqual([err.statusCode, err.code], [429, 'MENU_ART_TEXT_CAP_REACHED']);
    return true;
  });
  // The text cap being full leaves the image headroom of 1 intact.
  await reserve(runId, ['background']);
  const rows = await rowsOf(runId);
  assert.deepEqual(rows.map((r) => [r.kind, r.provider]), [['text', 'openai'], ['image', 'openai']]);
  assert.equal(rows[0].id, textId);
  assert.equal(rows[0].model, 'text-model');
});

test('a cap env set to abc falls back to its default', async () => {
  process.env.MENU_ART_DAILY_IMAGE_CAP = 'abc';
  process.env.MENU_ART_DAILY_TEXT_CAP = '0';
  assert.deepEqual(cap.capLimits(), { image: 60, text: 100 });
  assert.equal((await cap.capUsage()).limit, 60);
  process.env.MENU_ART_DAILY_IMAGE_CAP = '7';
  assert.equal((await cap.capUsage()).limit, 7, 'read at call time');
});

test('capUsage: remaining and resets_at (oldest counted image plus 24 hours)', async () => {
  await setImageCapHeadroom(3);
  const runId = newRun();
  await reserve(runId, ['background']);
  const usage = await cap.capUsage();
  assert.equal(usage.limit, Number(process.env.MENU_ART_DAILY_IMAGE_CAP));
  assert.equal(usage.remaining, usage.limit - usage.used);
  assert.equal(usage.remaining, 2);
  const { rows: [expected] } = await pool.query(
    `SELECT MIN(created_at) + interval '24 hours' AS at FROM menu_art_calls
      WHERE kind = 'image' AND status <> 'released' AND created_at > NOW() - interval '24 hours'`);
  assert.equal(usage.resets_at.getTime(), expected.at.getTime());
  process.env.MENU_ART_DAILY_IMAGE_CAP = String(Math.max(1, usage.used - 1));
  assert.equal((await cap.capUsage()).remaining, 0, 'never negative');
  // With nothing counted resets_at is null: checked through a stub db, since
  // the shared ledger may hold other rows.
  const empty = await cap.capUsage({ query: async () => ({ rows: [{ used: 0, resets_at: null }] }) });
  assert.equal(empty.resets_at, null);
  assert.equal(empty.used, 0);
});

test('markCall moves only a sent row and records the descriptor, request id, model and size', async () => {
  await setImageCapHeadroom(5);
  const runId = newRun();
  await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, runId]);
  try {
    const ids = await reserve(runId, ['background', 'custom:a']);
    assert.equal(await cap.markCall(ids.background, 'ok', { requestId: 'req_1' }), false, 'a reserved row is not marked');
    assert.equal(await cap.authorizeCall(ids.background, { draftId, runId }), true);
    assert.equal(await cap.markCall(ids.background, 'failed', {
      error: 'openai APIConnectionError', requestId: 'req_2', model: 'gpt-image-x', size: '1024x1024',
    }), true);
    const [row] = (await rowsOf(runId)).filter((r) => r.id === ids.background);
    assert.deepEqual([row.status, row.error, row.provider_request_id, row.model, row.size],
      ['failed', 'openai APIConnectionError', 'req_2', 'gpt-image-x', '1024x1024']);
    assert.equal(await cap.markCall(ids.background, 'ok', {}), false, 'a settled row stays settled');
    await assert.rejects(cap.markCall(ids['custom:a'], 'released', {}), TypeError);
    await assert.rejects(cap.markCall(ids['custom:a'], 'failed', { error: new Error('raw sdk text') }), TypeError);
  } finally {
    await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [draftId, draftRun]);
  }
});

test('a 40P01 deadlock maps to 409 MENU_DRAFT_CHANGED; anything else passes through', async () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  assert.equal(cap.isDeadlock(deadlock), true);
  assert.equal(cap.isDeadlock(new Error('x')), false);
  assert.equal(cap.isDeadlock(null), false);
  const mapped = cap.mapDeadlock(deadlock);
  assert.ok(mapped instanceof AppError);
  assert.deepEqual([mapped.statusCode, mapped.code], [409, 'MENU_DRAFT_CHANGED']);
  const other = Object.assign(new Error('other'), { code: '23505' });
  assert.equal(cap.mapDeadlock(other), other);
  const stub = { query: async () => { throw deadlock; } };
  await assert.rejects(cap.lockCalls(stub), { code: 'MENU_DRAFT_CHANGED', statusCode: 409 });
});
