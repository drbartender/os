'use strict';

// One-time migration for the staffing roster + waitlist feature.
//
//   node -r dotenv/config scripts/migrate-staffing-roles.js --dry-run
//   node -r dotenv/config scripts/migrate-staffing-roles.js
//
// Order matters (see the spec, Section 5):
//   1. Report DISTINCT position values on shift_requests + contractor_profiles.
//   2. Normalize BOTH position columns to canonical labels ('Server' ->
//      'Banquet Server'; lowercase -> title case). contractor_profiles.position
//      must be normalized too: the cover/drop marketplace matches it against
//      positions_needed.
//   3. Backfill shift_requests.requested_positions = [position] for old rows so
//      the waitlist classifier never sees an empty ranked list on a row that
//      already has a resolved role.
//   4. Add the case-insensitive CHECK on shift_requests.position, but ONLY after
//      verifying no row would violate it (else the ADD CONSTRAINT fails).
//
// Idempotent: re-running is a no-op once values are canonical and the CHECK
// exists. --dry-run does everything read-only and writes nothing.

const { pool } = require('../server/db');

const dryRun = process.argv.includes('--dry-run');
const CANON_LOWER = ['bartender', 'banquet server', 'barback'];

async function distinctPositions(client, table) {
  const { rows } = await client.query(
    `SELECT position, COUNT(*)::int AS n FROM ${table}
      WHERE position IS NOT NULL GROUP BY position ORDER BY position`,
  );
  return rows;
}

// Three canonicalizing UPDATEs per table. Returns total rows touched.
async function normalizeTable(client, table) {
  let touched = 0;
  const maps = [
    ["Banquet Server", "LOWER(TRIM(position)) IN ('server','banquet server')"],
    ["Bartender", "LOWER(TRIM(position)) = 'bartender'"],
    ["Barback", "LOWER(TRIM(position)) = 'barback'"],
  ];
  for (const [canonical, where] of maps) {
    const res = await client.query(
      `UPDATE ${table} SET position = $1 WHERE ${where} AND position <> $1`,
      [canonical],
    );
    touched += res.rowCount;
  }
  return touched;
}

async function countViolators(client) {
  const { rows } = await client.query(
    `SELECT position, COUNT(*)::int AS n FROM shift_requests
      WHERE position IS NOT NULL AND LOWER(TRIM(position)) <> ALL($1::text[])
      GROUP BY position`,
    [CANON_LOWER],
  );
  return rows;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log(`migrate-staffing-roles: ${dryRun ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    for (const table of ['shift_requests', 'contractor_profiles']) {
      const before = await distinctPositions(client, table);
      console.log(`\n${table}.position distinct values:`);
      for (const r of before) console.log(`  ${JSON.stringify(r.position)}: ${r.n}`);
    }

    if (dryRun) {
      // Show what normalization WOULD touch, without writing.
      for (const table of ['shift_requests', 'contractor_profiles']) {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${table}
            WHERE position IS NOT NULL
              AND LOWER(TRIM(position)) IN ('server','bartender','banquet server','barback')
              AND position NOT IN ('Bartender','Banquet Server','Barback')`,
        );
        console.log(`\nwould normalize ${rows[0].n} row(s) in ${table}`);
      }
      const { rows: bf } = await client.query(
        `SELECT COUNT(*)::int AS n FROM shift_requests
          WHERE position IS NOT NULL AND (requested_positions IS NULL OR requested_positions = '[]')`,
      );
      console.log(`would backfill requested_positions on ${bf[0].n} shift_requests row(s)`);
      const violators = await countViolators(client);
      if (violators.length) {
        console.log('\nWARNING: non-canonical positions that would BLOCK the CHECK:');
        for (const v of violators) console.log(`  ${JSON.stringify(v.position)}: ${v.n}`);
      } else {
        console.log('\nno CHECK-blocking positions; safe to apply.');
      }
      return;
    }

    await client.query('BEGIN');

    const srTouched = await normalizeTable(client, 'shift_requests');
    const cpTouched = await normalizeTable(client, 'contractor_profiles');
    console.log(`\nnormalized: shift_requests=${srTouched}, contractor_profiles=${cpTouched}`);

    const bf = await client.query(
      `UPDATE shift_requests
          SET requested_positions = to_jsonb(ARRAY[position])::text
        WHERE position IS NOT NULL AND (requested_positions IS NULL OR requested_positions = '[]')`,
    );
    console.log(`backfilled requested_positions on ${bf.rowCount} row(s)`);

    const violators = await countViolators(client);
    if (violators.length) {
      await client.query('ROLLBACK');
      console.error('\nABORTED: non-canonical shift_requests.position values remain:');
      for (const v of violators) console.error(`  ${JSON.stringify(v.position)}: ${v.n}`);
      console.error('Resolve these by hand, then re-run.');
      process.exitCode = 1;
      return;
    }

    await client.query(
      `ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_position_canonical`,
    );
    await client.query(
      `ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_position_canonical
         CHECK (position IS NULL OR LOWER(position) IN ('bartender','banquet server','barback'))`,
    );
    console.log('added CHECK shift_requests_position_canonical');

    await client.query('COMMIT');
    console.log('\nDONE.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('migrate-staffing-roles FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
