const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pool } = require('../lib/db');
const phase6 = require('./phase6');

// ── Fixture conventions ─────────────────────────────────────────────────
// Phase 6 only writes legacy_cc_raw_imports rows. We tag the source_file
// after each run (mirrors phase4/phase5) so our scrub doesn't touch real
// Phase 6 production rows.

async function scrubFixtures() {
  await pool.query(
    `DELETE FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/%'
        AND source_entity IN ('leads', 'invoices')`
  );
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// ── CSV-fixture helpers ─────────────────────────────────────────────────
// Header order is load-bearing for csv-parse (we use `columns: true` so the
// header row defines the keys). We include just the columns the tests
// actually assert on — extras would still round-trip via JSON.

const LEADS_HEADER = ['Created At', 'Lead Type', 'Full Name', 'Email', 'Phone', 'Event Date', 'Notes'];
const INVOICES_HEADER = [
  'Due Date', 'Event Date', 'Name', 'Invoice Number', 'Status',
  'Venue Full Address', 'User Email', 'Gallery URL', 'Video URL',
  'Total Cost', 'Balance Due',
];

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function makeCcDir({ leads = [], invoices = [], omitLeads = false, omitInvoices = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-test-'));

  if (!omitLeads) {
    const leadsLines = [LEADS_HEADER.map(escapeCsv).join(',')];
    for (const row of leads) {
      leadsLines.push(LEADS_HEADER.map((h) => escapeCsv(row[h] || '')).join(','));
    }
    fs.writeFileSync(path.join(dir, 'report (12).csv'), leadsLines.join('\n') + '\n', 'utf8');
  }

  if (!omitInvoices) {
    const invLines = [INVOICES_HEADER.map(escapeCsv).join(',')];
    for (const row of invoices) {
      invLines.push(INVOICES_HEADER.map((h) => escapeCsv(row[h] || '')).join(','));
    }
    fs.writeFileSync(path.join(dir, 'report (14).csv'), invLines.join('\n') + '\n', 'utf8');
  }

  return dir;
}

/**
 * After phase6.run(), the legacy_cc_raw_imports rows were written with
 * source_file = 'report (12).csv' OR 'report (14).csv'. Rewrite the
 * source_file to a fixture-prefixed value so scrubFixtures cleans up only
 * fixture rows. Mirrors phase4/phase5 test pattern.
 */
async function tagFixtureRawImports() {
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'phase6-fixture/leads-' || source_row_number
      WHERE source_file = 'report (12).csv' AND source_entity = 'leads'`
  );
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'phase6-fixture/invoices-' || source_row_number
      WHERE source_file = 'report (14).csv' AND source_entity = 'invoices'`
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

test('Phase 6: leads CSV ingestion — all rows land with source_entity=leads, import_status=archived', async () => {
  const dir = makeCcDir({
    leads: [
      {
        'Created At': '03-16-2026  7:49 PM',
        'Lead Type': 'New',
        'Full Name': 'Shalom Lau',
        'Email': 'operationfinallyjs@gmail.com',
        'Phone': '3124519010',
        'Event Date': '06-18-2027',
        'Notes': 'Interested in core reaction.',
      },
      {
        'Created At': '03-02-2026  8:14 PM',
        'Lead Type': 'New',
        'Full Name': 'Trevor Schutz',
        'Email': 'gennatrevorschutz@gmail.com',
        'Phone': '2245870137',
        'Event Date': '09-05-2026',
        'Notes': '',
      },
    ],
    invoices: [], // empty invoices CSV is fine
  });

  const res = await phase6.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.processed, 2);
  assert.strictEqual(res.inserted, 2);
  assert.strictEqual(res.byEntity.leads, 2);
  assert.strictEqual(res.byEntity.invoices, 0);

  const rows = await pool.query(
    `SELECT source_entity, source_row_number, payload, import_status
       FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/leads-%'
      ORDER BY source_row_number`
  );
  assert.strictEqual(rows.rowCount, 2);
  assert.strictEqual(rows.rows[0].source_entity, 'leads');
  assert.strictEqual(rows.rows[0].import_status, 'archived');
  assert.strictEqual(rows.rows[0].payload['Full Name'], 'Shalom Lau');
  assert.strictEqual(rows.rows[0].payload['Email'], 'operationfinallyjs@gmail.com');
  assert.strictEqual(rows.rows[1].payload['Full Name'], 'Trevor Schutz');
});

test('Phase 6: invoices CSV ingestion — all rows land with source_entity=invoices, import_status=archived', async () => {
  const dir = makeCcDir({
    leads: [],
    invoices: [
      {
        'Due Date': '05-24-2025',
        'Event Date': '06-07-2025',
        'Name': "Leigh Gratz - Husband's 40th Birthday",
        'Invoice Number': '20250316-05',
        'Status': 'Confirmed',
        'Venue Full Address': '21927 45th Street, Bristol, WI, 53104',
        'User Email': 'leigh.gratz@gmail.com',
        'Gallery URL': 'https://r2.example.com/gallery/leigh.jpg',
        'Video URL': '',
        'Total Cost': '$450',
        'Balance Due': '$225',
      },
    ],
  });

  const res = await phase6.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.inserted, 1);
  assert.strictEqual(res.byEntity.invoices, 1);
  assert.strictEqual(res.byEntity.leads, 0);

  const rows = await pool.query(
    `SELECT source_entity, payload, import_status
       FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/invoices-%'`,
  );
  assert.strictEqual(rows.rowCount, 1);
  assert.strictEqual(rows.rows[0].source_entity, 'invoices');
  assert.strictEqual(rows.rows[0].import_status, 'archived');
  assert.strictEqual(rows.rows[0].payload['Invoice Number'], '20250316-05');
  // The R2-rewritten Gallery URL from Phase 0 is what Phase 6 sees + stores.
  assert.strictEqual(rows.rows[0].payload['Gallery URL'], 'https://r2.example.com/gallery/leigh.jpg');
});

test('Phase 6: re-run is idempotent — second run with same CSVs does not double-insert', async () => {
  const leadRow = {
    'Created At': '03-02-2026 8:14 PM',
    'Lead Type': 'New',
    'Full Name': 'Idempotent Lead',
    'Email': 'idem.lead@example.com',
    'Phone': '5550000000',
    'Event Date': '',
    'Notes': 'first pass',
  };
  const invoiceRow = {
    'Due Date': '08-01-2025',
    'Event Date': '07-31-2025',
    'Name': 'Idempotent Invoice',
    'Invoice Number': 'INV-IDEM-001',
    'Status': 'Confirmed',
    'Venue Full Address': '',
    'User Email': 'idem.inv@example.com',
    'Gallery URL': '',
    'Video URL': '',
    'Total Cost': '$0',
    'Balance Due': '$0',
  };

  const dir = makeCcDir({ leads: [leadRow], invoices: [invoiceRow] });

  // First run.
  const r1 = await phase6.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(r1.errored, 0);
  assert.strictEqual(r1.inserted, 2);

  // Modify the lead row in memory; rewrite the CSV; re-run. The ON CONFLICT
  // path should UPDATE in place — total raw_imports rows for this fixture
  // stay at 2, but the payload reflects the updated value.
  const updatedLead = { ...leadRow, 'Notes': 'second pass — updated' };
  const dir2 = makeCcDir({ leads: [updatedLead], invoices: [invoiceRow] });

  const r2 = await phase6.run({
    ccDir: dir2, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(r2.errored, 0);
  assert.strictEqual(r2.inserted, 2); // archiveRow always UPSERTs

  await tagFixtureRawImports();

  // Exactly 2 fixture rows total — no doubling.
  const total = await pool.query(
    `SELECT COUNT(*)::int AS n FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/%'`,
  );
  assert.strictEqual(total.rows[0].n, 2);

  // The updated lead payload reflects the second run.
  const lead = await pool.query(
    `SELECT payload FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/leads-%'`,
  );
  assert.strictEqual(lead.rowCount, 1);
  assert.strictEqual(lead.rows[0].payload['Notes'], 'second pass — updated');

  // Status remains 'archived' across re-runs.
  const status = await pool.query(
    `SELECT import_status FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase6-fixture/invoices-%'`,
  );
  assert.strictEqual(status.rows[0].import_status, 'archived');
});
