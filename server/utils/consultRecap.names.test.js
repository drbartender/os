require('dotenv').config();

// loadConsultDrinkNames / buildConsultRecap against the dev DB (spec
// 2026-10-06, section 3.1). Every drink row here is seeded INACTIVE with a
// nonce id, so no public menu ever lists it, and removed in after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { loadConsultDrinkNames, buildConsultRecap } = require('./consultRecap');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const COCKTAIL_ID = `recap-test-cocktail-${NONCE}`;
const MOCKTAIL_ID = `recap-test-mocktail-${NONCE}`;
// One id in BOTH tables under different names: proves each list resolves
// against its own table (the generator once resolved mocktails as cocktails).
const SHARED_ID = `recap-test-shared-${NONCE}`;
const failingDb = { query: async () => { throw new Error('simulated lookup failure'); } };

before(async () => {
  await pool.query(
    "INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Recap Test Sour', false), ($2, 'Shared As Cocktail', false)",
    [COCKTAIL_ID, SHARED_ID]
  );
  await pool.query(
    "INSERT INTO mocktails (id, name, is_active) VALUES ($1, 'Recap Test Spritz', false), ($2, 'Shared As Mocktail', false)",
    [MOCKTAIL_ID, SHARED_ID]
  );
});

after(async () => {
  await pool.query('DELETE FROM cocktails WHERE id = ANY($1::text[])', [[COCKTAIL_ID, SHARED_ID]]);
  await pool.query('DELETE FROM mocktails WHERE id = ANY($1::text[])', [[MOCKTAIL_ID, SHARED_ID]]);
  await pool.end();
});

// The failure path reports to Sentry when a DSN is set; a test must not.
async function withoutSentry(fn) {
  const saved = process.env.SENTRY_DSN_SERVER;
  delete process.env.SENTRY_DSN_SERVER;
  try { return await fn(); } finally { if (saved !== undefined) process.env.SENTRY_DSN_SERVER = saved; }
}

test('loadConsultDrinkNames: each list resolves against its own table, inactive drinks included', async () => {
  const names = await loadConsultDrinkNames(
    { signatureDrinks: [COCKTAIL_ID, SHARED_ID], mocktails: [MOCKTAIL_ID, SHARED_ID] },
    pool
  );
  assert.equal(names.cocktails.get(COCKTAIL_ID), 'Recap Test Sour');
  assert.equal(names.cocktails.get(SHARED_ID), 'Shared As Cocktail');
  assert.equal(names.mocktails.get(MOCKTAIL_ID), 'Recap Test Spritz');
  assert.equal(names.mocktails.get(SHARED_ID), 'Shared As Mocktail');
});

test('loadConsultDrinkNames: a consult that names no drinks runs no query', async () => {
  let calls = 0;
  const db = { query: async () => { calls += 1; return { rows: [] }; } };
  const names = await loadConsultDrinkNames({ barType: 'beer_wine', beer: true }, db);
  assert.equal(calls, 0);
  assert.equal(names.cocktails.size, 0);
  assert.equal(names.mocktails.size, 0);
});

test('loadConsultDrinkNames: a failed lookup returns empty Maps instead of throwing', async () => {
  const names = await withoutSentry(() => loadConsultDrinkNames({ signatureDrinks: [COCKTAIL_ID] }, failingDb));
  assert.equal(names.cocktails.size, 0);
  assert.equal(names.mocktails.size, 0);
  assert.equal(names.failed, true, 'callers can tell a failed lookup from ids the catalog lacks');
});

test('buildConsultRecap: names, not ids; a retired id humanizes', async () => {
  const lines = await buildConsultRecap({
    barType: 'full_bar',
    signatureDrinks: [COCKTAIL_ID, 'long-gone-75'],
    mocktailsEnabled: true,
    mocktails: [MOCKTAIL_ID],
    mixers: 'matching',
  }, pool);
  assert.ok(lines.includes('Signature cocktails: Recap Test Sour, Long Gone 75'));
  assert.ok(lines.includes('Mocktails: Recap Test Spritz'));
  assert.ok(lines.includes('Mixers: Only those that match your spirits'));
  assert.ok(!lines.join(' ').includes(COCKTAIL_ID));
});

test('buildConsultRecap: a failed lookup degrades to humanized names, never a throw', async () => {
  const lines = await withoutSentry(() => buildConsultRecap({ signatureDrinks: ['french-75'] }, failingDb));
  assert.deepEqual(lines, ['Signature cocktails: French 75']);
});

test('buildConsultRecap: null for a missing, empty or nothing-to-say consult (never the placeholder)', async () => {
  assert.equal(await buildConsultRecap(null, pool), null);
  assert.equal(await buildConsultRecap({}, pool), null);
  assert.equal(await buildConsultRecap([], pool), null);
  assert.equal(await buildConsultRecap({ spirits: [], notes: '  ' }, pool), null);
});

test('buildConsultRecap: the staff card keeps the notes the client email leaves out', async () => {
  const lines = await buildConsultRecap({ beer: true, notes: ' Bring the copper mugs ' }, pool);
  assert.deepEqual(lines, ['Beer: yes', 'Notes: Bring the copper mugs']);
  // A notes-only consult still shows: the emptiness check counts the notes too.
  assert.deepEqual(await buildConsultRecap({ notes: 'Call the venue' }, pool), ['Notes: Call the venue']);
});

test('buildConsultRecap: a consult the formatter cannot read returns null, never a throw', async () => {
  // A row written before the sanitizer, or by hand: String() on this element throws.
  const hostile = { spirits: [{ toString() { throw new Error('unreadable'); } }] };
  const lines = await withoutSentry(() => buildConsultRecap(hostile, pool));
  assert.equal(lines, null);
});
