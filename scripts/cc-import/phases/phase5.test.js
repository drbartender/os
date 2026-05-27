const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pool } = require('../lib/db');
const phase5 = require('./phase5');

// ── Fixture conventions ─────────────────────────────────────────────────
// Pinned negative ids keep us miles away from real production rows.
//   users   : -95500 .. -95520  (real bartenders for fuzzy-match tests)
// Raw-imports rows written by Phase 5 are tagged via source_file rewrite
// (mirrors phase4 pattern) so scrubFixtures can wipe them cleanly without
// touching production rows from real Phase 5 runs.
const FIXTURE_USER_IDS = Array.from({ length: 21 }, (_, i) => -95500 - i);
const FIXTURE_EMAIL_DOMAIN = '@phase5-fixture.local';

async function scrubFixtures() {
  // legacy_cc_payouts is keyed by raw_import_id (FK ON DELETE RESTRICT), so we
  // must delete payouts first, then raw_imports, then users.

  // 1. legacy_cc_payouts tied to fixture raw_imports.
  await pool.query(
    `DELETE FROM legacy_cc_payouts
      WHERE raw_import_id IN (
        SELECT id FROM legacy_cc_raw_imports
         WHERE source_file LIKE 'phase5-fixture/%'
           AND source_entity = 'payouts'
      )`
  );
  // 2. raw_imports with our fixture file prefix.
  await pool.query(
    `DELETE FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase5-fixture/%' AND source_entity = 'payouts'`
  );

  // 3. Pinned fixture users (CASCADE clears contractor_profiles via FK).
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [FIXTURE_USER_IDS]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [FIXTURE_USER_IDS]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${FIXTURE_EMAIL_DOMAIN}`]);
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// ── CSV-fixture helpers ─────────────────────────────────────────────────
const CSV_HEADER = ['Date', 'Amount', 'Payee', 'Reference', 'Category'];

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function makeCcDir(rows) {
  const lines = [CSV_HEADER.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((h) => escapeCsv(row[h] || '')).join(','));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-test-'));
  fs.writeFileSync(path.join(dir, 'report (5).csv'), lines.join('\n') + '\n', 'utf8');
  return dir;
}

/**
 * Phase 5 writes raw_imports under `source_file='report (5).csv'`. To
 * isolate fixture rows from any real Phase 5 production rows that may exist
 * in the test DB, we rewrite the source_file to a fixture-prefixed value
 * after each run. Mirrors phase4.test.js.
 */
async function tagFixtureRawImports() {
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'phase5-fixture/' || source_row_number
      WHERE source_file = 'report (5).csv'
        AND source_entity = 'payouts'`
  );
}

async function seedBartender({ id, email, preferredName }) {
  const passwordHash = '$2a$10$abcdefghijklmnopqrstuvWXYZ1234567890abcdefghijkl0123456';
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, onboarding_status, pre_hired)
     VALUES ($1, $2, $3, 'staff', 'hired', false)`,
    [id, email, passwordHash]
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET preferred_name = EXCLUDED.preferred_name`,
    [id, preferredName]
  );
  return id;
}

// ── Tests ───────────────────────────────────────────────────────────────

test('Phase 5: clean insert — new payee row written with right fields', async () => {
  const dir = makeCcDir([{
    'Date': '01-08-2026',
    'Amount': '$482.50',
    'Payee': 'Jamie Lyn Juarez',
    'Reference': 'Server',
    'Category': 'Staff Payments',
  }]);

  const res = await phase5.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.skipped, 0);

  // Inspect the legacy_cc_payouts row.
  const pr = await pool.query(
    `SELECT lp.payee_name, lp.payee_name_normalized, lp.payee_user_id,
            lp.paid_on, lp.amount_cents, lp.reference_role, lp.category
       FROM legacy_cc_payouts lp
       JOIN legacy_cc_raw_imports ri ON ri.id = lp.raw_import_id
      WHERE ri.source_file LIKE 'phase5-fixture/%'`,
  );
  assert.strictEqual(pr.rowCount, 1);
  const p = pr.rows[0];
  assert.strictEqual(p.payee_name, 'Jamie Lyn Juarez');
  assert.strictEqual(p.payee_name_normalized, 'jamie lyn juarez');
  // payee_user_id null — no seeded fuzzy match for this test.
  assert.strictEqual(p.payee_user_id, null);
  // paid_on returned as a Date by pg; compare its ISO date slice.
  assert.strictEqual(p.paid_on.toISOString().slice(0, 10), '2026-01-08');
  assert.strictEqual(p.amount_cents, 48250);
  assert.strictEqual(p.reference_role, 'Server');
  assert.strictEqual(p.category, 'Staff Payments');
});

test('Phase 5: fuzzy match — payee name matches existing user → payee_user_id set', async () => {
  const userId = -95500;
  await seedBartender({
    id: userId,
    email: `chip.weinke${FIXTURE_EMAIL_DOMAIN}`,
    preferredName: 'Chip Weinke',
  });

  const dir = makeCcDir([{
    'Date': '12-23-2025',
    'Amount': '$93',
    'Payee': 'Chip Weinke',
    'Reference': 'Bartender',
    'Category': 'Staff Payments',
  }]);

  const res = await phase5.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.resolved, 1);
  assert.strictEqual(res.unmatched, 0);

  const pr = await pool.query(
    `SELECT lp.payee_user_id, lp.amount_cents
       FROM legacy_cc_payouts lp
       JOIN legacy_cc_raw_imports ri ON ri.id = lp.raw_import_id
      WHERE ri.source_file LIKE 'phase5-fixture/%'`,
  );
  assert.strictEqual(pr.rowCount, 1);
  assert.strictEqual(pr.rows[0].payee_user_id, userId);
  assert.strictEqual(pr.rows[0].amount_cents, 9300);
});

test('Phase 5: no match — payee with no candidate → payee_user_id NULL, counted in unmatched', async () => {
  const dir = makeCcDir([{
    'Date': '11-15-2025',
    'Amount': '$200',
    'Payee': 'Nonexistent Person Phase5Test',
    'Reference': 'Bartender',
    'Category': 'Staff Payments',
  }]);

  const res = await phase5.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.resolved, 0);
  assert.strictEqual(res.unmatched, 1);

  const pr = await pool.query(
    `SELECT lp.payee_user_id
       FROM legacy_cc_payouts lp
       JOIN legacy_cc_raw_imports ri ON ri.id = lp.raw_import_id
      WHERE ri.source_file LIKE 'phase5-fixture/%'`,
  );
  assert.strictEqual(pr.rowCount, 1);
  assert.strictEqual(pr.rows[0].payee_user_id, null);
});

test('Phase 5: re-run guard preserves operator-set payee_user_id (does NOT re-derive)', async () => {
  // Spec §8.5 step 2: when an existing legacy_cc_payouts row already has
  // payee_user_id set (by a prior run OR by operator via
  // /unmatched-payee/.../link), Phase 5 re-runs must KEEP that link.
  //
  // We simulate the operator-link flow by:
  //   1. Running Phase 5 once with NO matching user (unmatched).
  //   2. Manually UPDATE-ing payee_user_id to a fixture user (mimics the
  //      operator picker selecting a user for the unmatched payee).
  //   3. Re-running Phase 5 against the same CSV.
  //   4. Asserting payee_user_id still points at the operator-chosen user.
  //
  // The realistic threat the guard defends against: between the operator's
  // link and the re-run, a name-matching user was created. Without the guard,
  // the re-run would fuzzy-match that new user and overwrite the operator's
  // pick. Our test injects that new user explicitly to make the guard fire.

  const operatorChosenUserId = -95501;
  const wouldBeMatchedUserId = -95502;
  await seedBartender({
    id: operatorChosenUserId,
    email: `operator.chose${FIXTURE_EMAIL_DOMAIN}`,
    preferredName: 'Operator Chose This One',
  });

  const dir = makeCcDir([{
    'Date': '10-01-2025',
    'Amount': '$150',
    'Payee': 'Reseen Phase5 Person',
    'Reference': 'Bartender',
    'Category': 'Staff Payments',
  }]);

  // Run 1: no fuzzy match — row lands with payee_user_id = NULL.
  const r1 = await phase5.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(r1.errored, 0);
  assert.strictEqual(r1.inserted, 1);
  assert.strictEqual(r1.unmatched, 1);
  await tagFixtureRawImports();

  // Confirm the row is unmatched.
  const before = await pool.query(
    `SELECT lp.id, lp.payee_user_id
       FROM legacy_cc_payouts lp
       JOIN legacy_cc_raw_imports ri ON ri.id = lp.raw_import_id
      WHERE ri.source_file LIKE 'phase5-fixture/%'`,
  );
  assert.strictEqual(before.rowCount, 1);
  assert.strictEqual(before.rows[0].payee_user_id, null);
  const payoutId = before.rows[0].id;

  // Simulate operator link: set payee_user_id manually.
  await pool.query(
    `UPDATE legacy_cc_payouts SET payee_user_id = $1 WHERE id = $2`,
    [operatorChosenUserId, payoutId]
  );

  // Now seed a user whose preferred_name exactly matches the payee. Without
  // the re-run guard, Phase 5 would fuzzy-match this user and overwrite the
  // operator's selection.
  await seedBartender({
    id: wouldBeMatchedUserId,
    email: `wouldmatch${FIXTURE_EMAIL_DOMAIN}`,
    preferredName: 'Reseen Phase5 Person',
  });

  // CRITICAL: we re-run on the SAME source_file ('report (5).csv'). Our
  // first tagFixtureRawImports() renamed those raw rows to
  // 'phase5-fixture/N', so the second Phase 5 pass writes BRAND-NEW raw rows
  // under 'report (5).csv'. That would defeat the guard test — the new raw
  // rows have new ids and the SELECT in the guard finds no prior payouts row.
  //
  // So before re-running, rename the fixture raw rows BACK to
  // 'report (5).csv' so the ON CONFLICT (source_file, source_row_number)
  // path hits and the raw_import_id stays stable. Re-tag after the run.
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'report (5).csv'
      WHERE source_file LIKE 'phase5-fixture/%' AND source_entity = 'payouts'`
  );

  // Run 2: re-run guard must preserve the operator's pick.
  const r2 = await phase5.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(r2.errored, 0);
  assert.strictEqual(r2.preservedExistingLink, 1);
  // r2.inserted is 0 because the legacy_cc_payouts row already exists (ON
  // CONFLICT (raw_import_id) DO NOTHING fires).
  assert.strictEqual(r2.skipped, 1);
  await tagFixtureRawImports();

  // Assert the link was NOT re-derived to wouldBeMatchedUserId.
  const after = await pool.query(
    `SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`,
    [payoutId]
  );
  assert.strictEqual(after.rowCount, 1);
  assert.strictEqual(after.rows[0].payee_user_id, operatorChosenUserId,
    'guard must preserve operator-chosen payee_user_id and not re-derive');
});
