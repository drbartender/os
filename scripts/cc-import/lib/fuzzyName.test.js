const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db');
const { normalize, commaFlip, findByName, buildStubCcId } = require('./fuzzyName');

// Pinned negative ids so fixtures never collide with real data and are easy to
// scrub. contractor_profiles.user_id has UNIQUE + FK ON DELETE CASCADE, so
// deleting from users wipes the matching contractor_profiles row too.
const FIXTURE_USER_IDS = [-91101, -91102, -91103, -91104, -91105];

async function scrubFixtures() {
  await pool.query(
    `DELETE FROM users WHERE id = ANY($1::int[])`,
    [FIXTURE_USER_IDS]
  );
}

async function seedUser(id, email, preferredName) {
  const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, onboarding_status, pre_hired)
     VALUES ($1, $2, $3, 'staff', 'hired', false)`,
    [id, email, passwordHash]
  );
  if (preferredName !== undefined) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
      [id, preferredName]
    );
  }
}

before(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// ─── Pure-function tests ────────────────────────────────────────────────

test('normalize: lowercases, trims, collapses internal whitespace', () => {
  assert.strictEqual(normalize('  Mike  Smith  '), 'mike smith');
  assert.strictEqual(normalize('MIKE\tSMITH'), 'mike smith');
  assert.strictEqual(normalize('Mike\n\nSmith'), 'mike smith');
  assert.strictEqual(normalize(''), '');
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
});

test('commaFlip: "Last, First" → "First Last"; null on no comma', () => {
  assert.strictEqual(commaFlip('Smith, Mike'), 'Mike Smith');
  assert.strictEqual(commaFlip('Smith,   Mike'), 'Mike Smith');
  assert.strictEqual(commaFlip('Smith, Mike Q.'), 'Mike Q. Smith');
  assert.strictEqual(commaFlip('Mike Smith'), null);
  assert.strictEqual(commaFlip(''), null);
  assert.strictEqual(commaFlip(null), null);
});

test('buildStubCcId: deterministic for same inputs, differs by salt', () => {
  const a = buildStubCcId('Mike Smith', '2024-01-15');
  const b = buildStubCcId('Mike Smith', '2024-01-15');
  assert.strictEqual(a.ccId, b.ccId);
  assert.strictEqual(a.email, b.email);
  assert.strictEqual(a.slug, 'mikesmith');
  assert.strictEqual(a.hash6.length, 6);
  assert.match(a.ccId, /^legacy_cc:mikesmith:[0-9a-f]{6}$/);
  assert.match(a.email, /^legacy-cc-mikesmith-[0-9a-f]{6}@drbartender\.local$/);

  // Different date salt → different hash.
  const c = buildStubCcId('Mike Smith', '2024-02-15');
  assert.notStrictEqual(a.hash6, c.hash6);
  assert.notStrictEqual(a.ccId, c.ccId);

  // Different name → different slug AND different hash.
  const d = buildStubCcId('Jane Doe', '2024-01-15');
  assert.notStrictEqual(a.slug, d.slug);
  assert.notStrictEqual(a.hash6, d.hash6);

  // Slug strips punctuation, spaces, casing.
  const e = buildStubCcId("O'Brien, Patrick Jr.", '2024-01-15');
  assert.strictEqual(e.slug, 'obrienpatrickjr');
});

// ─── DB integration tests ───────────────────────────────────────────────

test('findByName Pass 1: exact normalized preferred_name match', async () => {
  await scrubFixtures();
  await seedUser(-91101, 'mike+pass1@fixture.local', 'Mike Smith');
  await seedUser(-91102, 'no-name@fixture.local', null);

  // Direct exact match.
  const r1 = await findByName(pool, 'Mike Smith');
  assert.deepStrictEqual(r1, [-91101]);

  // Whitespace and case variants normalize to the same key.
  const r2 = await findByName(pool, '  MIKE  Smith  ');
  assert.deepStrictEqual(r2, [-91101]);
});

test('findByName Pass 2: comma-flipped retry', async () => {
  await scrubFixtures();
  await seedUser(-91101, 'mike+pass2@fixture.local', 'Mike Smith');

  // 'Smith, Mike' has no exact match → Pass 1 misses → Pass 2 flips and matches.
  const r = await findByName(pool, 'Smith, Mike');
  assert.deepStrictEqual(r, [-91101]);
});

test('findByName Pass 3: first-initial + last-name LIKE', async () => {
  await scrubFixtures();
  // The stored profile has the short form; payee CSV has the long form.
  await seedUser(-91101, 'm-short@fixture.local', 'M Smith');
  await seedUser(-91102, 'mike-full@fixture.local', 'Michael Smithson');

  // 'Mike Smith' should match 'M Smith' via "M% Smith%".
  const r = await findByName(pool, 'Mike Smith');
  // Both 'M Smith' and 'Michael Smithson' satisfy "m% smith%", so result is multi.
  assert.ok(r.includes(-91101));
  assert.ok(r.includes(-91102));
  assert.strictEqual(r.length, 2);
});

test('findByName: returns empty array on full miss', async () => {
  await scrubFixtures();
  await seedUser(-91101, 'mike@fixture.local', 'Mike Smith');

  const r = await findByName(pool, 'Xavier Yolen-Zinc');
  assert.deepStrictEqual(r, []);
});

test('findByName: empty / null payee returns empty array (no DB call needed)', async () => {
  assert.deepStrictEqual(await findByName(pool, ''), []);
  assert.deepStrictEqual(await findByName(pool, '   '), []);
  assert.deepStrictEqual(await findByName(pool, null), []);
});

test('findByName Pass 1: multiple matches surface all candidates', async () => {
  await scrubFixtures();
  // Two real humans share a preferred_name → ambiguity surfaces to operator.
  await seedUser(-91101, 'mike-one@fixture.local', 'Mike Smith');
  await seedUser(-91102, 'mike-two@fixture.local', 'Mike Smith');

  const r = await findByName(pool, 'Mike Smith');
  assert.strictEqual(r.length, 2);
  assert.ok(r.includes(-91101));
  assert.ok(r.includes(-91102));
});
