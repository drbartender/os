const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// IMPORTANT: ENCRYPTION_KEY must be set BEFORE requiring the encryption module
// or phase1 (which transitively requires it). The env-file the harness uses
// does not currently carry ENCRYPTION_KEY (production sets it in Render);
// the tests must supply a 64-hex-char dev key so Phase 1's encryption
// preflight passes.
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

const { pool } = require('../lib/db');
const { decrypt } = require('../../../server/utils/encryption');
const phase1 = require('./phase1');

// Pinned negative ids for fixture users so we never collide with real data.
// Range: -92000 .. -92100. We scrub anything in this range, plus stub users
// whose cc_id starts with a known fixture-prefix slug.
const FIXTURE_USER_IDS = Array.from({ length: 101 }, (_, i) => -92000 - i);
const FIXTURE_EMAIL_DOMAIN = '@phase1-fixture.local';
const FIXTURE_PAYEE_SLUGS = ['nullstubuser', 'multimatchpayee', 'stubvictor', 'stubzoidberg', 'stubreimburseonly'];

async function scrubFixtures() {
  // Delete pinned-id fixture users (CASCADE clears contractor_profiles, agreements,
  // payment_profiles).
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [FIXTURE_USER_IDS]);

  // Delete any fixture-domain users (Wix UPSERT inserts using auto-generated ids).
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${FIXTURE_EMAIL_DOMAIN}`]);

  // Delete legacy_cc stub users for our fixture payees (created by Phase 1 stub creation).
  for (const slug of FIXTURE_PAYEE_SLUGS) {
    await pool.query(`DELETE FROM users WHERE cc_id LIKE $1`, [`legacy_cc:${slug}:%`]);
  }

  // Scrub raw_imports rows whose payload references either a fixture-domain
  // email OR a fixture payee. The test feeds these rows in via temp-dir CSVs
  // whose source_file names are the canonical Wix file names (not unique), so
  // we cannot scrub by file name alone — scrub by payload content instead.
  await pool.query(
    `DELETE FROM legacy_cc_raw_imports
      WHERE payload->>'Email' LIKE $1
         OR payload->>'Payee' = ANY($2::text[])`,
    [`%${FIXTURE_EMAIL_DOMAIN}`, ['NullStub User', 'Stub Victor', 'Stub ReimburseOnly']]
  );
  // We do NOT delete cc_import_runs rows; relying on the test not leaving the
  // DB with hundreds of run rows. Deleting by phase alone would clobber real
  // production runs (when this test happens to run against a non-empty DB).
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// Build a temp ccDir with the named CSVs. Returns the absolute dir path.
function makeCcDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-test-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, 'utf8');
  }
  return dir;
}

// loadCsv override that tags each loaded file's source name with a prefix so
// raw_imports scrubbing can find them.
function makeLoadCsv() {
  const { loadCsv } = require('../lib/csv');
  // Wrap loadCsv to return the original parsed rows; we use the FILE NAME (not
  // the path) for source_file, so we have no need to tag here. The runner uses
  // path.basename via path.join + the file name we control in the temp dir.
  return loadCsv;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('Phase 1 encryption preflight: sentinel detects unset key (returns raw, no enc: prefix)', () => {
  // Verify the dev-key-missing behavior. The encryption module reads the env
  // var lazily inside getKey() on every call, so toggling process.env at test
  // time works without re-requiring.
  const origKey = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    const { encrypt } = require('../../../server/utils/encryption');
    const probe = encrypt('cc-import-preflight');
    // In dev with no key, encrypt() returns the raw input. The preflight
    // check is `probe.startsWith('enc:')` — verify the sentinel doesn't
    // accidentally satisfy that prefix when the key is missing.
    assert.strictEqual(probe.startsWith('enc:'), false);
    assert.strictEqual(probe, 'cc-import-preflight');
    // And confirm the preflight itself throws.
    assert.throws(
      () => phase1.encryptionPreflight(),
      /ENCRYPTION_KEY missing/
    );
  } finally {
    process.env.ENCRYPTION_KEY = origKey;
  }
});

test('Phase 1 encryption preflight: passes when key is set (sentinel returns enc:)', () => {
  // The before() hook set ENCRYPTION_KEY at file load. Sentinel must come back
  // with the enc: prefix and the preflight call must not throw.
  const { encrypt } = require('../../../server/utils/encryption');
  const probe = encrypt('cc-import-preflight');
  assert.ok(probe.startsWith('enc:'), `expected enc: prefix, got ${probe.slice(0, 20)}`);
  assert.doesNotThrow(() => phase1.encryptionPreflight());
});

test('Phase 1 index preflight is idempotent', async () => {
  // Run twice; the second call must not throw on a pre-existing index.
  await phase1.indexPreflight();
  await phase1.indexPreflight();
  // Verify the index actually exists by name.
  const r = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_email_lower'`
  );
  assert.strictEqual(r.rowCount, 1);
});

test('Phase 1 Wix UPSERT: clean insert of a new staff user from all 3 CSVs', async () => {
  const email = `clean${FIXTURE_EMAIL_DOMAIN}`;
  const dir = makeCcDir({
    'Field Guide Acknowledgement.csv':
      `Email,Full Name,Phone,SMS Consent,Acknowledged Field Guide,Non-Solicitation,Signature,Date Submitted\n` +
      `${email},Clean Hire,555-0100,Yes,Yes,Yes,signed,2024-03-15\n`,
    'Contractor Profile.csv':
      `Email,Preferred Name,Phone,City,State\n` +
      `${email},Clean H,555-0100,Chicago,IL\n`,
    'Payment Info.csv':
      `Email,Preferred Payment Method,Payment Username,Routing Number,Account Number,Upload your signed W9 (Photo or PDF)\n` +
      `${email},Zelle,clean@example.com,123456789,987654321,https://example.com/w9.pdf\n`,
    'report (5).csv': `Date,Amount,Payee,Reference,Category\n`,
  });

  const res = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.errored, 0);

  // User exists with onboarding_status='hired'.
  const ur = await pool.query(
    `SELECT id, role, onboarding_status, cc_id FROM users WHERE email = $1`,
    [email]
  );
  assert.strictEqual(ur.rowCount, 1);
  assert.strictEqual(ur.rows[0].role, 'staff');
  assert.strictEqual(ur.rows[0].onboarding_status, 'hired');
  assert.strictEqual(ur.rows[0].cc_id, null);
  const userId = ur.rows[0].id;

  // contractor_profiles seeded with Preferred Name from CP and matches preferredName.
  const cpRow = await pool.query(
    `SELECT preferred_name, phone, city, state FROM contractor_profiles WHERE user_id = $1`,
    [userId]
  );
  assert.strictEqual(cpRow.rowCount, 1);
  assert.strictEqual(cpRow.rows[0].preferred_name, 'Clean H');
  assert.strictEqual(cpRow.rows[0].city, 'Chicago');
  assert.strictEqual(cpRow.rows[0].state, 'IL');

  // agreements row seeded from Field Guide Ack.
  const agRow = await pool.query(
    `SELECT acknowledged_field_guide, agreed_non_solicitation, sms_consent, signature_data
       FROM agreements WHERE user_id = $1`,
    [userId]
  );
  assert.strictEqual(agRow.rowCount, 1);
  assert.strictEqual(agRow.rows[0].acknowledged_field_guide, true);
  assert.strictEqual(agRow.rows[0].agreed_non_solicitation, true);
  assert.strictEqual(agRow.rows[0].sms_consent, true);
  assert.strictEqual(agRow.rows[0].signature_data, 'signed');

  // payment_profiles row seeded with encrypted bank PII.
  const ppRow = await pool.query(
    `SELECT preferred_payment_method, payment_username,
            routing_number, account_number, w9_file_url
       FROM payment_profiles WHERE user_id = $1`,
    [userId]
  );
  assert.strictEqual(ppRow.rowCount, 1);
  assert.strictEqual(ppRow.rows[0].preferred_payment_method, 'Zelle');
  assert.strictEqual(ppRow.rows[0].payment_username, 'clean@example.com');
  assert.strictEqual(ppRow.rows[0].w9_file_url, 'https://example.com/w9.pdf');
  // Bank PII MUST be encrypted (enc:...prefix), and decrypt() round-trips it.
  assert.ok(ppRow.rows[0].routing_number.startsWith('enc:'), `routing_number must be encrypted (got: ${ppRow.rows[0].routing_number.slice(0, 20)})`);
  assert.ok(ppRow.rows[0].account_number.startsWith('enc:'), `account_number must be encrypted (got: ${ppRow.rows[0].account_number.slice(0, 20)})`);
  assert.strictEqual(decrypt(ppRow.rows[0].routing_number), '123456789');
  assert.strictEqual(decrypt(ppRow.rows[0].account_number), '987654321');

  // raw_imports rows are marked promoted.
  const rawRows = await pool.query(
    `SELECT source_entity, import_status FROM legacy_cc_raw_imports
      WHERE payload->>'Email' = $1 ORDER BY source_entity`,
    [email]
  );
  assert.strictEqual(rawRows.rowCount, 3);
  for (const r of rawRows.rows) {
    assert.strictEqual(r.import_status, 'promoted', `${r.source_entity} should be promoted`);
  }
});

test('Phase 1 Wix UPSERT: blocked by protected state (rejected user) → errored', async () => {
  // Pre-seed a rejected user with the email we're about to UPSERT.
  const email = `rejected${FIXTURE_EMAIL_DOMAIN}`;
  const ph = await bcrypt.hash('seed-pw', 4);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, onboarding_status, pre_hired)
     VALUES ($1, $2, $3, 'staff', 'rejected', false)`,
    [-92010, email, ph]
  );

  const dir = makeCcDir({
    'Field Guide Acknowledgement.csv':
      `Email,Full Name,Phone,SMS Consent,Acknowledged Field Guide,Non-Solicitation,Signature,Date Submitted\n` +
      `${email},Should Not Insert,555-0200,Yes,Yes,Yes,signed,2024-03-15\n`,
    'Contractor Profile.csv':
      `Email,Preferred Name\n${email},Should Not Insert\n`,
    'Payment Info.csv':
      `Email,Preferred Payment Method,Routing Number,Account Number\n${email},Zelle,111111111,222222222\n`,
    'report (5).csv': `Date,Amount,Payee,Reference,Category\n`,
  });

  const res = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 0);
  assert.strictEqual(res.errored, 1);

  // User is STILL rejected — UPSERT WHERE filtered out the change.
  const ur = await pool.query(
    `SELECT onboarding_status FROM users WHERE id = -92010`
  );
  assert.strictEqual(ur.rows[0].onboarding_status, 'rejected');

  // No contractor_profiles / payment_profiles row was created (the per-user
  // transaction rolled back cleanly).
  const cpRow = await pool.query(`SELECT 1 FROM contractor_profiles WHERE user_id = -92010`);
  assert.strictEqual(cpRow.rowCount, 0);
  const ppRow = await pool.query(`SELECT 1 FROM payment_profiles WHERE user_id = -92010`);
  assert.strictEqual(ppRow.rowCount, 0);

  // raw_imports rows for this email marked errored with the right reason.
  const rawErrs = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports
      WHERE payload->>'Email' = $1`,
    [email]
  );
  assert.ok(rawErrs.rowCount >= 1, 'at least one raw row should be present');
  for (const r of rawErrs.rows) {
    assert.strictEqual(r.import_status, 'errored');
    assert.strictEqual(r.import_notes.error, 'user_email_conflict_with_protected_state');
  }
});

test('Phase 1 payouts cascade: unmatched payee creates a legacy stub with cc_id and contractor_profile', async () => {
  const payeeName = 'NullStub User';
  const dir = makeCcDir({
    'Field Guide Acknowledgement.csv': `Email,Full Name\n`,
    'Contractor Profile.csv': `Email,Preferred Name\n`,
    'Payment Info.csv': `Email,Preferred Payment Method\n`,
    'report (5).csv':
      `Date,Amount,Payee,Reference,Category\n` +
      `03-15-2024,200.00,${payeeName},Bartender,Event Pay\n` +
      `03-22-2024,150.00,${payeeName},Bartender,Event Pay\n`,
  });

  const res = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.processed, 0); // no Wix users
  assert.strictEqual(res.stubsCreated, 1);
  assert.strictEqual(res.errored, 0);

  // Stub user exists with legacy_cc: cc_id and onboarding_status='deactivated'.
  const ur = await pool.query(
    `SELECT id, email, cc_id, role, onboarding_status FROM users WHERE cc_id LIKE 'legacy_cc:nullstubuser:%'`
  );
  assert.strictEqual(ur.rowCount, 1);
  assert.strictEqual(ur.rows[0].role, 'staff');
  assert.strictEqual(ur.rows[0].onboarding_status, 'deactivated');
  assert.match(ur.rows[0].cc_id, /^legacy_cc:nullstubuser:[0-9a-f]{6}$/);
  assert.match(ur.rows[0].email, /^legacy-cc-nullstubuser-[0-9a-f]{6}@drbartender\.local$/);

  // contractor_profile row seeded with preferred_name = payee name.
  const cpRow = await pool.query(
    `SELECT preferred_name FROM contractor_profiles WHERE user_id = $1`,
    [ur.rows[0].id]
  );
  assert.strictEqual(cpRow.rowCount, 1);
  assert.strictEqual(cpRow.rows[0].preferred_name, payeeName);

  // can_staff auto-derived = true (Bartender reference + non-excluded category).
  const csRow = await pool.query(
    `SELECT can_staff FROM users WHERE id = $1`,
    [ur.rows[0].id]
  );
  assert.strictEqual(csRow.rows[0].can_staff, true);
});

test('Phase 1 payouts cascade: stub creation is idempotent on re-run (no duplicate)', async () => {
  const payeeName = 'Stub Victor';
  const dir = makeCcDir({
    'Field Guide Acknowledgement.csv': `Email,Full Name\n`,
    'Contractor Profile.csv': `Email,Preferred Name\n`,
    'Payment Info.csv': `Email,Preferred Payment Method\n`,
    'report (5).csv':
      `Date,Amount,Payee,Reference,Category\n` +
      `03-15-2024,200.00,${payeeName},Bartender,Event Pay\n`,
  });

  const r1 = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(r1.stubsCreated, 1);
  assert.strictEqual(r1.stubsSkipped, 0);

  const r2 = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  // Second run: the stub already exists, AND now matches the payee via Pass 1
  // (contractor_profiles.preferred_name was seeded with the payee name in run 1).
  // So r2 should produce 0 stubs created AND 0 stubs skipped (single-match path).
  assert.strictEqual(r2.stubsCreated, 0);
  assert.strictEqual(r2.stubsSkipped, 0);

  // Exactly one user with this cc_id slug.
  const ur = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE cc_id LIKE 'legacy_cc:stubvictor:%'`
  );
  assert.strictEqual(ur.rows[0].n, 1);
});

test('Phase 1 payouts cascade: reimbursement-only payee does NOT get can_staff', async () => {
  const payeeName = 'Stub ReimburseOnly';
  const dir = makeCcDir({
    'Field Guide Acknowledgement.csv': `Email,Full Name\n`,
    'Contractor Profile.csv': `Email,Preferred Name\n`,
    'Payment Info.csv': `Email,Preferred Payment Method\n`,
    'report (5).csv':
      `Date,Amount,Payee,Reference,Category\n` +
      `03-15-2024,50.00,${payeeName},Bartender,Reimbursement\n` +
      `03-22-2024,100.00,${payeeName},Bartender,Cash Advance\n`,
  });

  const res = await phase1.run({ ccDir: dir, captureMessage: () => {} });
  assert.strictEqual(res.stubsCreated, 1);
  assert.strictEqual(res.canStaffAutoSet, 0);

  const ur = await pool.query(
    `SELECT can_staff FROM users WHERE cc_id LIKE 'legacy_cc:stubreimburseonly:%'`
  );
  assert.strictEqual(ur.rowCount, 1);
  assert.strictEqual(ur.rows[0].can_staff, false);
});
