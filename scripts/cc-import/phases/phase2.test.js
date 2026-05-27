const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pool } = require('../lib/db');
const phase2 = require('./phase2');

// Pinned negative ids for fixture clients so we never collide with real data.
// Range: -92500 .. -92520.
const FIXTURE_CLIENT_IDS = Array.from({ length: 21 }, (_, i) => -92500 - i);

// Fixture cc_id prefix — every phase-2 fixture row uses 'fix2-XXXXXX'
// (matches the [0-9]+ shape real CC IDs use, but with a 'fix2-' tag so we
// can scrub safely without touching real imports).
const FIXTURE_CCID_PREFIX = 'fix2-';

// Fixture email domain on synthetic clients so we can scrub by domain.
const FIXTURE_EMAIL_DOMAIN = '@phase2-fixture.local';

async function scrubFixtures() {
  // Delete pinned-id fixture clients (proposals may have FK ON DELETE SET NULL).
  await pool.query(`DELETE FROM clients WHERE id = ANY($1::int[])`, [FIXTURE_CLIENT_IDS]);

  // Delete clients with our fixture cc_id prefix (Phase 2 INSERTs use auto-gen ids).
  await pool.query(`DELETE FROM clients WHERE cc_id LIKE $1`, [`${FIXTURE_CCID_PREFIX}%`]);

  // Delete clients with our fixture email domain (defense-in-depth for any
  // run that didn't tag cc_id).
  await pool.query(`DELETE FROM clients WHERE email LIKE $1`, [`%${FIXTURE_EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'cc-import-noemail-fix2-%@drbartender.local'`);

  // Scrub raw_imports rows whose cc_id starts with our fixture prefix.
  await pool.query(
    `DELETE FROM legacy_cc_raw_imports WHERE cc_id LIKE $1`,
    [`${FIXTURE_CCID_PREFIX}%`]
  );
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// Build a temp ccDir holding only `report (9).csv` with the supplied contents.
function makeCcDir(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-test-'));
  fs.writeFileSync(path.join(dir, 'report (9).csv'), contents, 'utf8');
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────

test('Phase 2: clean insert — new email creates clients row with cc_id + lowercased email + source=direct', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}100001`;
  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    `${ccId},Clean Insert,Clean,Insert,Clean.Insert${FIXTURE_EMAIL_DOMAIN},555-0100\n`
  );

  const res = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.updated, 0);
  assert.strictEqual(res.errored, 0);

  const cr = await pool.query(
    `SELECT name, email, phone, source, cc_id, email_status FROM clients WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(cr.rowCount, 1);
  assert.strictEqual(cr.rows[0].name, 'Clean Insert');
  // Email must be lowercased.
  assert.strictEqual(cr.rows[0].email, `clean.insert${FIXTURE_EMAIL_DOMAIN}`);
  assert.strictEqual(cr.rows[0].phone, '555-0100');
  assert.strictEqual(cr.rows[0].source, 'direct');
  assert.strictEqual(cr.rows[0].email_status, 'ok');

  // Raw row marked promoted.
  const rr = await pool.query(
    `SELECT import_status FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rowCount, 1);
  assert.strictEqual(rr.rows[0].import_status, 'promoted');
});

test('Phase 2: clean dedup — existing client matched by lowercased email gets cc_id and email canonicalized', async () => {
  // Pre-seed a client whose email has mixed case AND no cc_id.
  const ccId = `${FIXTURE_CCID_PREFIX}100002`;
  const mixedEmail = `Dedup.Hit${FIXTURE_EMAIL_DOMAIN}`;
  await pool.query(
    `INSERT INTO clients (id, name, email, phone, source)
     VALUES ($1, 'Dedup Hit', $2, '555-0200', 'direct')`,
    [-92501, mixedEmail]
  );

  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    // CC row's email matches the lowercased form of the seeded mixed-case row.
    `${ccId},Dedup Hit,Dedup,Hit,dedup.hit${FIXTURE_EMAIL_DOMAIN},555-0200\n`
  );

  const res = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 0);
  assert.strictEqual(res.updated, 1);
  assert.strictEqual(res.errored, 0);

  // Existing client now has cc_id set + email canonicalized to lowercase.
  const cr = await pool.query(
    `SELECT id, email, cc_id FROM clients WHERE id = $1`,
    [-92501]
  );
  assert.strictEqual(cr.rows[0].cc_id, ccId);
  assert.strictEqual(cr.rows[0].email, `dedup.hit${FIXTURE_EMAIL_DOMAIN}`);

  // No NEW client row was inserted with this cc_id (the dedup updated the existing one).
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM clients WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(countRes.rows[0].n, 1);
});

test('Phase 2: placeholder email — empty / n/a email inserts placeholder + email_status=bad', async () => {
  const ccIdEmpty = `${FIXTURE_CCID_PREFIX}100003`;
  const ccIdNa = `${FIXTURE_CCID_PREFIX}100004`;
  const ccIdNoemail = `${FIXTURE_CCID_PREFIX}100005`;
  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    `${ccIdEmpty},Empty Email,Empty,Email,,555-0301\n` +
    `${ccIdNa},Na Email,Na,Email,n/a,555-0302\n` +
    `${ccIdNoemail},Noemail Pattern,Noemail,Pattern,noemail@example.com,555-0303\n`
  );

  const res = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 3);
  assert.strictEqual(res.inserted, 3);
  assert.strictEqual(res.errored, 0);

  for (const ccId of [ccIdEmpty, ccIdNa, ccIdNoemail]) {
    const cr = await pool.query(
      `SELECT email, email_status FROM clients WHERE cc_id = $1`,
      [ccId]
    );
    assert.strictEqual(cr.rowCount, 1, `expected one client for ${ccId}`);
    assert.strictEqual(cr.rows[0].email, `cc-import-noemail-${ccId}@drbartender.local`);
    assert.strictEqual(cr.rows[0].email_status, 'bad');
  }
});

test('Phase 2: case-collision pre-check — pre-seed two clients with same LOWER(email) → raw row errored', async () => {
  // Pre-seed TWO clients sharing the same lowercased email but stored with
  // different cases. This is the operator-vs-importer race scenario the
  // pre-check exists to catch.
  const ccId = `${FIXTURE_CCID_PREFIX}100006`;
  await pool.query(
    `INSERT INTO clients (id, name, email, source)
     VALUES ($1, 'Collide A', $2, 'direct')`,
    [-92502, `Collision.User${FIXTURE_EMAIL_DOMAIN}`]
  );
  await pool.query(
    `INSERT INTO clients (id, name, email, source)
     VALUES ($1, 'Collide B', $2, 'direct')`,
    [-92503, `collision.user${FIXTURE_EMAIL_DOMAIN}`]
  );

  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    `${ccId},Collision Target,Collision,Target,collision.user${FIXTURE_EMAIL_DOMAIN},555-0400\n`
  );

  const res = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 0);
  assert.strictEqual(res.updated, 0);
  assert.strictEqual(res.errored, 1);

  // Neither pre-seeded client got the cc_id (the collision aborted promotion).
  const cidRes = await pool.query(
    `SELECT id, cc_id FROM clients WHERE id IN ($1, $2)`,
    [-92502, -92503]
  );
  for (const row of cidRes.rows) {
    assert.strictEqual(row.cc_id, null, `client ${row.id} should NOT have cc_id annotated`);
  }

  // Raw row marked errored with the right error code + both candidate ids.
  const rr = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rowCount, 1);
  assert.strictEqual(rr.rows[0].import_status, 'errored');
  assert.strictEqual(rr.rows[0].import_notes.error, 'client_email_case_collision');
  assert.ok(Array.isArray(rr.rows[0].import_notes.candidates));
  assert.strictEqual(rr.rows[0].import_notes.candidates.length, 2);
  assert.ok(rr.rows[0].import_notes.candidates.includes(-92502));
  assert.ok(rr.rows[0].import_notes.candidates.includes(-92503));
});

test('Phase 2: existing client with cc_id already set — dedup hit does NOT overwrite cc_id', async () => {
  // Pre-seed a client with a DIFFERENT cc_id already assigned.
  const existingCcId = `${FIXTURE_CCID_PREFIX}999999`;
  const newCcId = `${FIXTURE_CCID_PREFIX}100007`;
  await pool.query(
    `INSERT INTO clients (id, name, email, source, cc_id)
     VALUES ($1, 'Already Tagged', $2, 'direct', $3)`,
    [-92504, `already.tagged${FIXTURE_EMAIL_DOMAIN}`, existingCcId]
  );

  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    `${newCcId},Already Tagged,Already,Tagged,already.tagged${FIXTURE_EMAIL_DOMAIN},555-0500\n`
  );

  const res = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.updated, 1); // dedup hit counts as updated
  assert.strictEqual(res.errored, 0);

  // cc_id MUST NOT be overwritten.
  const cr = await pool.query(
    `SELECT cc_id FROM clients WHERE id = $1`,
    [-92504]
  );
  assert.strictEqual(cr.rows[0].cc_id, existingCcId);
});

test('Phase 2: re-runnable — running the same CSV twice is idempotent', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}100008`;
  const dir = makeCcDir(
    `ID,Name,First Name,Last Name,Email,Phone\n` +
    `${ccId},Idempotent Run,Idempotent,Run,idem.run${FIXTURE_EMAIL_DOMAIN},555-0600\n`
  );

  const r1 = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(r1.inserted, 1);
  assert.strictEqual(r1.errored, 0);

  const r2 = await phase2.run({ ccDir: dir, captureMessage: () => {} });
  // Second run: client already exists with cc_id set + canonical email → dedup
  // hit, no INSERT, no errors.
  assert.strictEqual(r2.processed, 1);
  assert.strictEqual(r2.inserted, 0);
  assert.strictEqual(r2.updated, 1);
  assert.strictEqual(r2.errored, 0);

  // Exactly one client with this cc_id.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM clients WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(countRes.rows[0].n, 1);

  // Raw row still promoted (re-import sets it back to pending, then promoted).
  const rr = await pool.query(
    `SELECT import_status, source_row_hash FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rowCount, 1);
  assert.strictEqual(rr.rows[0].import_status, 'promoted');
  // Hash MUST be stable across runs since the row content didn't change.
  assert.ok(rr.rows[0].source_row_hash && /^[0-9a-f]{64}$/.test(rr.rows[0].source_row_hash));
});

// ── unit-level tests for normalizeEmail ──────────────────────────────────

test('normalizeEmail: empty, whitespace, n/a, none, noemail@* → null (placeholder path)', () => {
  assert.strictEqual(phase2.normalizeEmail(null), null);
  assert.strictEqual(phase2.normalizeEmail(undefined), null);
  assert.strictEqual(phase2.normalizeEmail(''), null);
  assert.strictEqual(phase2.normalizeEmail('   '), null);
  assert.strictEqual(phase2.normalizeEmail('n/a'), null);
  assert.strictEqual(phase2.normalizeEmail('N/A'), null);
  assert.strictEqual(phase2.normalizeEmail('none'), null);
  assert.strictEqual(phase2.normalizeEmail('NONE'), null);
  assert.strictEqual(phase2.normalizeEmail('noemail@example.com'), null);
  assert.strictEqual(phase2.normalizeEmail('NoEmail@Whatever.test'), null);
});

test('normalizeEmail: real email → lowercased + trimmed', () => {
  assert.strictEqual(phase2.normalizeEmail('  USER@Example.COM  '), 'user@example.com');
  assert.strictEqual(phase2.normalizeEmail('mixed.Case@DOMAIN.io'), 'mixed.case@domain.io');
});

test('placeholderEmail: stable format per cc_id', () => {
  assert.strictEqual(phase2.placeholderEmail('123456'), 'cc-import-noemail-123456@drbartender.local');
});
