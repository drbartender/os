const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

// Split a SQL script into individual statements on `;`, while respecting
// PostgreSQL dollar-quoted bodies so DO blocks, function bodies, and seed
// rows with embedded HTML stay intact.
//
// Handles both bare (`$$...$$`) and named tags (`$body$...$body$`, `$txt$...$txt$`).
// A tag only closes when the exact same tag appears again — `$body$ ... $$`
// does NOT close. Statements are split on `;` only when outside any
// dollar-quoted region.
//
// Doesn't handle single-quoted strings or SQL comments containing `;` —
// schema.sql doesn't use those patterns today. If you add them, teach this
// splitter first.
function splitStatements(sql) {
  const TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  const statements = [];
  let buf = '';
  let openTag = null; // the exact string (e.g. '$$', '$body$') we're inside
  let i = 0;
  while (i < sql.length) {
    if (openTag === null) {
      if (sql[i] === '$') {
        const m = TAG_RE.exec(sql.slice(i));
        if (m) {
          openTag = m[0];
          buf += openTag;
          i += openTag.length;
          continue;
        }
      }
      if (sql[i] === ';') {
        const stmt = buf.trim();
        if (stmt.length > 0) statements.push(stmt);
        buf = '';
        i++;
        continue;
      }
    } else if (sql.startsWith(openTag, i)) {
      buf += openTag;
      i += openTag.length;
      openTag = null;
      continue;
    }
    buf += sql[i];
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

// Postgres error codes that are expected to fire when re-running schema.sql
// against an already-initialized DB. Anything outside this list signals a real
// problem (bad SQL, missing dependency, partial prior run) and should NOT be
// quietly swallowed.
//   42P07 duplicate_table
//   42P06 duplicate_schema
//   42710 duplicate_object         (constraints, types, triggers, etc.)
//   42701 duplicate_column
//   42P16 invalid_table_definition (e.g. constraint already exists, NOT NULL re-add)
//   23505 unique_violation         (seed inserts that ON CONFLICT didn't catch)
//   42704 undefined_object         (DROP IF NOT EXISTS quirks across versions)
const IDEMPOTENT_PG_CODES = new Set([
  '42P07', '42P06', '42710', '42701', '42P16', '23505', '42704',
]);

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = splitStatements(schema);
  const client = await pool.connect();
  const unexpected = [];
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        if (err.code && IDEMPOTENT_PG_CODES.has(err.code)) {
          // Expected on a re-run against a populated DB — quiet.
          continue;
        }
        // Unexpected error — capture for end-of-init reporting; don't abort
        // mid-loop so a single bad statement doesn't strand the rest of the
        // schema half-applied.
        unexpected.push({
          code: err.code || 'UNKNOWN',
          message: err.message.split('\n')[0],
          stmt: stmt.slice(0, 200),
        });
        console.error(`Schema statement FAILED [${err.code || 'UNKNOWN'}]:`, err.message.split('\n')[0]);
      }
    }
    if (unexpected.length > 0) {
      // Surface to Sentry so deploys with broken migrations are visible without
      // requiring someone to read server logs.
      try {
        const Sentry = require('@sentry/node');
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureMessage(
            `initDb: ${unexpected.length} unexpected schema statement(s) failed`,
            { level: 'error', extra: { unexpected } }
          );
        }
      } catch (_sentryErr) { /* best-effort */ }
      console.error(`✗ Database schema initialized with ${unexpected.length} UNEXPECTED failure(s) — review immediately`);
    } else {
      console.log('✓ Database schema initialized');
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, splitStatements };
